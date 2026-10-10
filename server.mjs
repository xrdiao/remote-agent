import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { WebSocketServer } from 'ws';
import qrcode from 'qrcode-terminal';
import { workspaces, workspaceForTitle, fileSize, readFile, parseRef, listProject, locateWritable, writeTextFile, resolveLocal } from './files.mjs';
import { findTheme } from './theme.mjs';
import { highlightText } from './highlight.mjs';
import { gitMarks, agentMarks } from './marks.mjs';
import {
  DATA_DIR, publishRecord, opensEntry, computerId, computerName, createPairing, pairingValid, consumePairing, listDevices, addDevice, findDevice, updateDevice,
  removeDevice, totpConfig, verifyTotp, needsTotp, saveState, readState, appBase, normalizeAppUrl,
} from './auth.mjs';
import { pushPublicKey, openEventStream, closeEventStreams, addViewer, removeViewer, deliver, startWatcher } from './notify.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3939);
const HOST = process.env.HOST || '0.0.0.0';
const CDP_URL = (process.env.CDP_URL || 'http://127.0.0.1:9222').replace(/\/$/, '');
const DEVIN_CDP_URL = (process.env.DEVIN_CDP_URL || 'http://127.0.0.1:9223').replace(/\/$/, '');
const EDITORS = [
  { app: 'cursor', url: CDP_URL },
  { app: 'devin', url: DEVIN_CDP_URL },
];
const TUNNEL = process.argv.includes('--tunnel');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const APP_DIR = path.join(__dirname, 'app');

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const CONFIG = loadConfig();
const PUBLISH_REPO = process.argv.find(a => a.startsWith('--publish='))?.slice('--publish='.length) || process.env.CR_PUBLISH_REPO || CONFIG.publishRepo || '';
const PAGES_BRANCH = process.env.CR_PAGES_BRANCH || CONFIG.pagesBranch || '';
// The Pages app may sit on a custom domain; config.appUrl records its real address when one is known.
const APP_ORIGIN = (() => {
  const fixed = normalizeAppUrl(CONFIG.appUrl);
  if (fixed) return new URL(fixed).origin;
  return PUBLISH_REPO ? `https://${PUBLISH_REPO.split('/')[0].toLowerCase()}.github.io` : '';
})();
const ALLOWED_ORIGINS = new Set([APP_ORIGIN, ...(process.env.CR_ALLOWED_ORIGINS || '').split(',')].filter(Boolean));

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

// A device is usable once paired and, when 2FA asks for it, re-verified.
function deviceFor(req) {
  return findDevice(bearer(req));
}

function bearer(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return m ? m[1] : '';
}

// Behind cloudflared every request arrives from loopback; only then trust its client-IP header.
function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  return (loopback && req.headers['cf-connecting-ip']) || remote;
}

const failures = new Map();
let globalFailures = [];
const PER_IP_LIMIT = 5, GLOBAL_LIMIT = 20, LOCK_MS = 15 * 60 * 1000;

function lockedOut(ip) {
  const now = Date.now();
  globalFailures = globalFailures.filter(t => now - t < LOCK_MS);
  const mine = (failures.get(ip) || []).filter(t => now - t < LOCK_MS);
  failures.set(ip, mine);
  return mine.length >= PER_IP_LIMIT || globalFailures.length >= GLOBAL_LIMIT;
}

function recordFailure(ip) {
  const now = Date.now();
  failures.set(ip, [...(failures.get(ip) || []), now]);
  globalFailures.push(now);
  console.log(`!! 验证失败 ip=${ip}（15 分钟内：本 IP ${failures.get(ip).length} 次，总计 ${globalFailures.length} 次）`);
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > limit) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// Same-origin (app served by this relay) or the user's own GitHub Pages app.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

async function listWindows() {
  const lists = await Promise.all(EDITORS.map(async ed => {
    try {
      const targets = await (await fetch(`${ed.url}/json/list`, { signal: AbortSignal.timeout(1500) })).json();
      return targets
        .filter(t => t.type === 'page' && /workbench/.test(t.url))
        .map(t => ({
          id: `${ed.app}:${t.id}`,
          title: t.title,
          ws: t.webSocketDebuggerUrl,
          app: ed.app,
          kind: t.title === 'Cursor Agents' ? 'agents' : /\[SSH: /.test(t.title) ? 'ssh' : 'local',
        }))
        // Devin names a real window after its folder. A bare "Devin" title is an empty New Space.
        .filter(t => !(ed.app === 'devin' && t.title === 'Devin'));
    } catch {
      return [];
    }
  }));
  const wins = lists.flat();
  if (!wins.length) throw new Error('连不上 Cursor 或 Devin。Cursor 用调试端口 9222，Devin 用 ./start-devin.sh（端口 9223）');
  return wins;
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.onclose = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`CDP connect failed: ${this.wsUrl}`));
      ws.onclose = () => {
        for (const { reject } of this.pending.values()) reject(new Error('CDP closed'));
        this.pending.clear();
        this.onclose?.();
      };
      ws.onmessage = ev => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        } else if (msg.method) {
          this.handlers.get(msg.method)?.(msg.params);
        }
      };
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    this.handlers.set(method, fn);
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate failed');
    return r.result.value;
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

const MOD = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 };
const NAMED_KEYS = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  Tab: { code: 'Tab', vk: 9 },
  Delete: { code: 'Delete', vk: 46 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
};

// Cursor's chat composer is a ProseMirror contenteditable; selectors ordered from most to least specific.
const FOCUS_COMPOSER = `(() => {
  // Same reveal as pageHelpers.revealDevinComposer: a new Devin session's prompt
  // stays in a hidden welcome layer while a file tab is open.
  for (const group of document.querySelectorAll('.editor-group-container')) {
    if (group.classList.contains('has-pending-new-session-welcome')) continue;
    for (const el of group.querySelectorAll('[data-crl-devin-reveal]')) {
      el.style.removeProperty('display');
      el.removeAttribute('data-crl-devin-reveal');
    }
  }
  for (const group of document.querySelectorAll('.editor-group-container.has-pending-new-session-welcome')) {
    const welcome = group.querySelector(':scope > .windsurf-welcome-container');
    const editor = group.querySelector(':scope > .editor-container');
    if (welcome && getComputedStyle(welcome).display === 'none') {
      welcome.style.setProperty('display', 'flex', 'important');
      welcome.setAttribute('data-crl-devin-reveal', '1');
    }
    if (editor && getComputedStyle(editor).display !== 'none') {
      editor.style.setProperty('display', 'none', 'important');
      editor.setAttribute('data-crl-devin-reveal', '1');
    }
  }
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const selectors = ['.aislash-editor-input[contenteditable="true"]', '.ui-prompt-input-editor__input[contenteditable="true"]', '.composer-bar [contenteditable="true"]', '.auxiliarybar [contenteditable="true"]'];
  let eds = [];
  for (const s of selectors) { eds = [...document.querySelectorAll(s)].filter(visible); if (eds.length) break; }
  if (!eds.length) eds = [...document.querySelectorAll('[contenteditable="true"]')].filter(e => visible(e) && !e.closest('.monaco-editor, [aria-label="User message"], [aria-label="Devin message"]'));
  if (!eds.length) return null;
  const el = eds.find(e => e.contains(document.activeElement)) || eds[eds.length - 1];
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
})()`;

// Cursor accepts images pasted into the composer; a synthetic paste event carrying a File works the same way.
const pasteImage = (b64, name, type) => `(async () => {
  if (!${FOCUS_COMPOSER}) return null;
  const ed = document.activeElement.closest('[contenteditable="true"]') || document.activeElement;
  let box = ed;
  for (let i = 0; i < 8 && box.parentElement; i++) box = box.parentElement;
  const nodes = () => [...document.querySelectorAll('.context-pill-image, .image-pill-img, img[alt="Attached image"], .agent-panel-composer-pill')];
  const before = new Set(nodes());
  const html = ed.innerHTML;
  const bin = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(new File([bin], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
  ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  for (let i = 0; i < 30; i++) {
    if (nodes().some(el => !before.has(el))) return true;
    if (ed.innerHTML !== html && /<img|blob:|Attached image/i.test(ed.innerHTML)) return true;
    if (box.querySelectorAll('img').length > [...before].filter(el => box.contains(el) && el.tagName === 'IMG').length) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return nodes().some(el => !before.has(el));
})()`;

// Runs inside Cursor's renderer (injected via toString). Emits only whitelisted tags with escaped text, never raw DOM HTML.
function pageHelpers() {
  const vis = e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const SKIP = /ui-collapsible-header|md-clickable-code|output-preview|codicon-find|widget-close|model-picker/;
  const ACTION = /^(run|skip|allow|accept|reject|deny|approve|keep|undo|continue|stop|cancel|build|retry|yes|no\b|运行|跳过|允许|接受|拒绝|继续|停止|取消)/i;
  const BLOCK = new Set(['P', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'DIV']);
  const INLINE = new Set(['STRONG', 'B', 'EM', 'I', 'CODE', 'DEL']);
  const CODE_BLOCK = '.composer-code-block-container, .composer-message-codeblock, .ui-code-block, pre';
  const FILE_REF = 'code.md-inline-path-filename-like';

  // Edit/read tool cards keep the absolute path in the header's title; fall back to the shown file name.
  const toolFile = el => {
    const titled = [...el.querySelectorAll('[title]')].map(e => e.getAttribute('title')).find(t => /^(\/|~\/|[A-Za-z]:\\)\S+$/.test(t));
    return titled || el.querySelector('.ui-edit-tool-call__filename')?.innerText.trim() || null;
  };

  // Older Cursor builds mark each transcript row with data-flat-index. The Agents window in
  // current builds uses data-message-kind instead, and past bubbles contain their own editors.
  const ITEM_SEL = '[data-flat-index], [data-message-kind], [role=group][aria-label="User message"], [role=group][aria-label="Devin message"]';
  const COMPOSER = '.aislash-editor-input, .ui-prompt-input-editor__input';
  const inItem = el => !!el.closest(ITEM_SEL);
  const itemKey = el => {
    const existing = el.dataset.flatIndex || el.dataset.messageId || el.querySelector('[data-message-id]')?.dataset.messageId;
    if (existing) return existing;
    const acp = el.closest?.('[role="log"][aria-label="Session transcript"]')
      ? el.closest('[data-acp-msg-index]')?.getAttribute('data-acp-msg-index') : null;
    if (acp != null) return `acp${acp}`;
    if (el.getAttribute('data-side')) {
      const i = [...document.querySelectorAll('[role=group][data-side]')].indexOf(el);
      return i >= 0 ? `d${i}` : '';
    }
    return '';
  };
  const itemByKey = (panel, key) => panel.querySelector(`[data-flat-index="${CSS.escape(key)}"], [data-message-id="${CSS.escape(key)}"]`);

  const findPanel = () => {
    const real = [...document.querySelectorAll(COMPOSER)].filter(e => vis(e) && !e.closest(ITEM_SEL));
    const eds = real.length ? real : [...document.querySelectorAll(COMPOSER)].filter(vis);
    for (const ed of eds) {
      let p = ed;
      while (p && !p.querySelector(ITEM_SEL)) p = p.parentElement;
      if (p) return p;
    }
    // Devin's prompt is not a Cursor composer. The first message's parent is only that
    // bubble, so climb until every visible message sits in one transcript.
    const items = [...document.querySelectorAll(ITEM_SEL)].filter(vis);
    if (!items.length) return null;
    let p = items[0].parentElement;
    for (let i = 0; i < 14 && p?.parentElement && !items.every(it => p.contains(it)); i++) p = p.parentElement;
    return p;
  };

  const buttonsIn = (root, strict) => [...root.querySelectorAll('button, [role=button], .anysphere-button, .anysphere-secondary-button, .composer-run-button, .composer-skip-button')]
    .filter(b => vis(b) && !b.closest('.human-message-action-slot') && !SKIP.test(b.className) && !b.parentElement.closest('button, [role=button]'))
    .map(b => ({ el: b, label: ((b.innerText || '').trim() || b.getAttribute('aria-label') || b.title || '').split('\n')[0].slice(0, 30) }))
    .filter(x => x.label && x.label !== 'Shell command options' && (!strict || ACTION.test(x.label)));

  const codeText = n => {
    const lines = n.querySelectorAll('.view-line');
    return lines.length ? [...lines].map(l => l.innerText).join('\n') : n.innerText;
  };

  // Cursor paints syntax colors as oklch(). Keep only a #hex that differs from the parent.
  const hex = (r, g, b) => '#' + [r, g, b].map(n => Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, '0')).join('');
  const gamma = x => x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  const cssColor = c => {
    const rgb = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(c || '');
    if (rgb) return hex(rgb[1] / 255, rgb[2] / 255, rgb[3] / 255);
    const ok = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(c || '');
    if (!ok) return '';
    const L = +ok[1], C = +ok[2], H = +ok[3] * Math.PI / 180;
    const a = C * Math.cos(H), b = C * Math.sin(H);
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
    return hex(
      gamma(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      gamma(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
    );
  };
  const colorAttr = el => {
    const col = cssColor(getComputedStyle(el).color);
    const parent = cssColor(getComputedStyle(el.parentElement || el).color);
    return col && parent && col !== parent ? ` style="color:${col}"` : '';
  };

  // devin: also keep links (http/https only) and h6 for Devin's markdown renderer; Cursor never sets it.
  const clean = (node, devin = false) => {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { out += esc(n.textContent); continue; }
      if (n.nodeType !== 1) continue;
      if (n.matches('.katex-display, .katex-block')) {
        const tex = (n.querySelector('annotation')?.textContent || '').trim();
        if (tex) { out += `<div class="math" data-tex="${esc(tex)}">${esc(tex)}</div>`; continue; }
      }
      if (n.matches('.katex')) {
        const tex = (n.querySelector('annotation')?.textContent || '').trim();
        if (tex) { out += `<span class="math" data-tex="${esc(tex)}">${esc(tex)}</span>`; continue; }
      }
      if (n.matches(CODE_BLOCK)) {
        const content = n.querySelector('.ui-code-block-content') || n;
        const lines = [...content.querySelectorAll('.view-line')];
        const plainLine = el => (el.innerText || '').replace(/\u00a0/g, ' ').replace(/\n/g, '');
        const plain = (lines.length ? lines.map(plainLine).join('\n') : (content.innerText || '').replace(/\u00a0/g, ' ')).replace(/\n$/, '');
        const body = (lines.length ? lines.map(l => clean(l, devin)).join('\n') : clean(content, devin)).replace(/\n$/, '');
        out += `<div class="codebox"><textarea class="src" hidden readonly>${esc(plain)}</textarea><pre>${body}</pre></div>`;
        continue;
      }
      const tag = n.tagName;
      if (['STYLE', 'SCRIPT', 'BUTTON', 'svg', 'SVG', 'IMG'].includes(tag)) continue;
      if (tag === 'BR') { out += '<br>'; continue; }
      if (tag === 'HR') { out += '<hr>'; continue; }
      if (n.matches(FILE_REF)) { out += `<code data-file="${esc(n.innerText.trim())}"${colorAttr(n)}>${esc(n.innerText.trim())}</code>`; continue; }
      if (devin && tag === 'A' && /^https?:\/\//i.test(n.getAttribute('href') || '')) {
        out += `<a href="${esc(n.getAttribute('href'))}" target="_blank" rel="noopener noreferrer">${clean(n, devin)}</a>`;
        continue;
      }
      const inner = clean(n, devin);
      const t = tag.toLowerCase();
      const paint = colorAttr(n);
      const block = BLOCK.has(tag) || (devin && tag === 'H6');
      out += block || INLINE.has(tag) ? `<${t}${paint}>${inner}</${t}>` : (paint && inner ? `<span${paint}>${inner}</span>` : inner);
    }
    return out;
  };

  // Devin's code blocks are line divs (no .view-line); keep line breaks and drop the copy chrome.
  const blockText = node => {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return '';
    if (/^(BUTTON|SVG|STYLE|SCRIPT)$/.test(node.tagName) || node.getAttribute('role') === 'button') return '';
    if (node.tagName === 'BR') return '\n';
    const inner = [...node.childNodes].map(blockText).join('');
    return /^(DIV|P|LI|TR|PRE)$/.test(node.tagName) ? inner + '\n' : inner;
  };
  const devinRich = root => {
    const c = root.cloneNode(true);
    c.querySelectorAll('[data-md-code-block]').forEach(b => {
      const pre = document.createElement('pre');
      pre.textContent = blockText(b).replace(/\u00a0/g, ' ').replace(/\n+$/, '');
      b.replaceWith(pre);
    });
    return clean(c, true);
  };

  const summary = el => {
    const head = el.querySelector('.ui-tool-call-card__header, .ui-collapsible-header, [class*="header"]') || el;
    return head.innerText.trim().replace(/\s*\n\s*/g, ' · ').slice(0, 240);
  };

  // Cursor keeps thinking text mounted inside the collapsible. Devin's "Thought for …"
  // block and the older chat thinking box drop the body until the header is opened.
  const THINKING_ROOT = '.ui-thinking-collapsible, .chat-thinking-box, .highlight-wrapper';
  const ROW_SEL = `${ITEM_SEL}, ${THINKING_ROOT}`;
  const topItems = panel => [...panel.querySelectorAll(ROW_SEL)].filter(e => !e.parentElement?.closest(ROW_SEL));
  const thinkingHeaderEl = el => el.matches('.ui-thinking-collapsible')
    ? el.querySelector('.ui-collapsible-header')
    : el.matches('.chat-thinking-box')
      ? (el.querySelector('.chat-used-context-label .monaco-button, .chat-used-context-label button') || el.querySelector('.chat-used-context-label'))
      : el.querySelector('[class*="event-header"]');
  // Devin's expanded header is not the toggle; the chevron button is.
  const thinkingToggleEl = el => el.querySelector('button[aria-expanded]') || thinkingHeaderEl(el);
  const thinkingBodyEl = el => el.matches('.ui-thinking-collapsible')
    ? el.querySelector('.ui-collapsible-content')
    : el.matches('.chat-thinking-box')
      ? el.querySelector('.chat-thinking-item')
      : el.querySelector('.ui-collapsible-content, .self-start');
  const thinkingPlain = el => (thinkingBodyEl(el)?.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+$/, '');
  const thinkingTitleOf = el => (thinkingHeaderEl(el)?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const thinkingLive = el => el.classList.contains('chat-thinking-active')
    || !!el.querySelector('[data-loading]')
    || /^thinking\b/i.test(thinkingTitleOf(el));
  const thinkingNodes = () => {
    const rooted = [...document.querySelectorAll(THINKING_ROOT)].filter(el => el.matches('.ui-thinking-collapsible, .chat-thinking-box') || /^(thinking|thoughts|thought(?: for)? )\b/i.test(thinkingTitleOf(el)));
    const rows = [...document.querySelectorAll('[data-message-kind="thinking"]')].filter(el => !rooted.some(r => r === el || r.contains(el) || el.contains(r)));
    return [...rooted, ...rows];
  };
  // 'live' is still generating; 'done' has finished and folded its body away.
  const closedThinkingIndexes = (which = 'live') => {
    const idxs = thinkingNodes().flatMap((el, i) => {
      const live = thinkingLive(el);
      if (which === 'live' ? !live : live) return [];
      if (thinkingPlain(el).trim()) return [];
      const header = thinkingToggleEl(el);
      if (!header || header.getAttribute('aria-expanded') === 'true') return [];
      return [i];
    });
    // Finished blocks: read the newest ones. Older traces are optional.
    return (which === 'done' ? idxs.slice(-2) : idxs.slice(0, 4));
  };
  const clickThinking = indexes => {
    const nodes = thinkingNodes();
    for (const i of indexes || []) nodes[i] && thinkingToggleEl(nodes[i])?.click();
    return true;
  };
  // Devin's two surfaces are titlebar segments (Agent: sidebar sessions; Editor: chat in the right panel).
  const devinSurface = () => {
    const seg = [...document.querySelectorAll('button.switch-segment')].find(e => vis(e) && e.classList.contains('active'));
    return seg ? (seg.classList.contains('agent-segment') ? 'agent' : 'editor') : null;
  };
  const surfaceTarget = to => {
    const seg = [...document.querySelectorAll(`button.switch-segment.${to}-segment`)].find(vis);
    return seg ? center(seg) : null;
  };
  const transcriptVisible = () => { const l = devinLog(); return (!!l && vis(l)) || [...document.querySelectorAll('[role="textbox"][aria-label="Prompt"]')].some(vis); };
  // Editor surface: the titlebar "Search agents" button opens a quick pick listing every session by name.
  const sessionSearchTarget = () => {
    const b = [...document.querySelectorAll('button[aria-label]')].find(e => vis(e) && /^Search agents\b/.test(e.getAttribute('aria-label')));
    return b ? center(b) : null;
  };
  const sessionPickerRows = () => {
    const w = [...document.querySelectorAll('.quick-input-widget')].find(vis);
    if (!w) return null;
    return [...w.querySelectorAll('.monaco-list-row')].filter(vis).map(row => {
      const title = ((row.querySelector('.label-name') || row).innerText || '').trim().split('\n')[0].slice(0, 80);
      return { id: title, title, running: /\bworking\b/i.test(row.innerText || '') };
    }).filter(r => r.title);
  };
  // Devin sessions are identified by their title. The Editor surface keeps the open sessions as tabs above
  // the transcript (the active one has the active-tab background); the Agent surface uses the sidebar.
  const sessNorm = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  // The tabs live in the chat panel (#chat) even when the open session is empty and has no transcript.
  const devinTabEls = () => [...document.querySelectorAll('#chat [draggable="true"]')].filter(e => vis(e) && /h-\[34px\]/.test(String(e.className)));
  const devinTabs = () => devinTabEls().map(t => ({
    title: sessNorm((t.querySelector('span') || t).innerText),
    active: /bg-ide-tab-active-background-color/.test(String(t.className)),
  })).filter(t => t.title);
  const devinSession = () => {
    if (!devinLog() && !devinSurface()) return null;
    const tabs = devinTabs(), surface = devinSurface();
    let title = tabs.find(t => t.active)?.title || '';
    if (!title && surface === 'agent') title = sessNorm(agentList().find(a => a.current)?.title);
    return { key: title, title, surface, tabs };
  };
  const devinTabTarget = title => {
    const want = sessNorm(title);
    const el = devinTabEls().find(t => sessNorm((t.querySelector('span') || t).innerText) === want);
    if (!el) return null;
    const r = (el.querySelector('span') || el).getBoundingClientRect();
    return { x: r.x + Math.min(r.width / 2, 40), y: r.y + r.height / 2 };
  };
  // The tab's own close button (an icon at its right edge, hover-revealed); null while it has no size.
  const devinTabCloseTarget = title => {
    const want = sessNorm(title);
    const el = devinTabEls().find(t => sessNorm((t.querySelector('span') || t).innerText) === want);
    const b = el?.querySelector('button');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return r.width > 2 && r.height > 2 ? { x: r.x + r.width * 0.78, y: r.y + r.height / 2 } : null;
  };
  const sessionPickerTarget = id => {
    const row = [...document.querySelectorAll('.quick-input-widget .monaco-list-row')].filter(vis)
      .find(r => (((r.querySelector('.label-name') || r).innerText || '').trim().split('\n')[0].slice(0, 80)) === id);
    if (!row) return null;
    row.scrollIntoView({ block: 'nearest' });
    return center(row);
  };

  // Devin "Revert to this point": a hover-only button at the left edge of a user message row.
  // Unverified on the live window (never clicked while developing); the dialog is read generically.
  const revertTarget = (i, part) => {
    const row = [...(devinLog()?.children || [])].find(r => itemKey(r) === i);
    if (!row || !row.querySelector('[role=group][aria-label="User message"]')) return null;
    if (part === 'row') { row.scrollIntoView({ block: 'center' }); return center(row); }
    const b = [...row.querySelectorAll('button')].find(x => /absolute/.test(x.className) && /left-full/.test(x.className));
    return b && vis(b) ? center(b) : null;
  };
  // Revert opens a preview that either confirms by itself (no file changes to undo: the transcript just
  // rewinds, no dialog) or, after ~0.5 s, a dialog listing the file changes with an "Apply these reverts"
  // checkbox and a Confirm (or Force revert) button.
  const revertConfirmBtn = () => [...document.querySelectorAll('button')].find(b => vis(b) && /^(Confirm|Force revert)$/.test((b.innerText || '').trim()) && !b.closest('[data-band-item]'));
  const revertDialogEl = () => {
    const b = revertConfirmBtn();
    if (!b) return null;
    const d = b.closest('[role="dialog"], [role="alertdialog"]');
    if (d) return d;
    let p = b;
    for (let i = 0; i < 8 && p.parentElement; i++) {
      p = p.parentElement;
      if (/^(fixed|absolute)$/.test(getComputedStyle(p).position) && p.getBoundingClientRect().width > 200) return p;
    }
    return b.parentElement?.parentElement || null;
  };
  const revertDialog = () => {
    const d = revertDialogEl();
    if (!d) return null;
    const box = d.querySelector('input[type="checkbox"]');
    return {
      title: ((d.querySelector('h1, h2, h3') || {}).innerText || '').trim().slice(0, 120),
      body: (d.innerText || '').trim().slice(0, 1200),
      apply: box ? box.checked : null,
      force: /force/i.test(revertConfirmBtn()?.innerText || ''),
    };
  };
  const revertDialogButton = which => {
    const d = revertDialogEl();
    if (!d) return null;
    if (which === 'toggle') { const t = d.querySelector('label') || d.querySelector('input[type="checkbox"]'); return t ? center(t) : null; }
    const cancel = b => /cancel|close|取消|关闭/i.test((b.innerText || b.getAttribute('aria-label') || '').trim());
    const btns = [...d.querySelectorAll('button')].filter(vis);
    const b = which === 'cancel' ? btns.find(cancel) : revertConfirmBtn();
    return b ? center(b) : null;
  };
  // Is the user message still in the transcript, and what is the highest index mounted?
  const revertState = i => {
    const rows = [...(devinLog()?.children || [])];
    const nums = rows.map(r => Number(/^acp(\d+)/.exec(itemKey(r) || '')?.[1])).filter(n => Number.isFinite(n));
    const row = rows.find(r => itemKey(r) === i);
    return { rowHas: !!row && !!row.querySelector('[role=group][aria-label="User message"]'), max: nums.length ? Math.max(...nums) : -1 };
  };

  // Devin thoughts by item id (acpN:think): the row's chevron, its open state, and its body text
  // (same lines devinItems reads: the event group minus its title). Collapsed rows carry no body.
  const thoughtRow = id => [...(devinLog()?.children || [])].find(r => itemKey(r) === String(id).replace(/:think$/, ''));
  const thoughtState = id => {
    const b = thoughtRow(id)?.querySelector('button[aria-expanded]');
    return b ? { expanded: b.getAttribute('aria-expanded') === 'true' } : null;
  };
  const setThoughtOpen = (id, open) => {
    const b = thoughtRow(id)?.querySelector('button[aria-expanded]');
    if (!b) return false;
    if ((b.getAttribute('aria-expanded') === 'true') !== open) b.click();
    return true;
  };
  const thoughtBodyText = id => {
    const row = thoughtRow(id);
    const eg = row && (row.classList.contains('event-group') ? row : row.querySelector('.event-group'));
    if (!eg) return '';
    return (eg.innerText || '').split('\n').map(s => s.trim()).filter(Boolean).slice(1).join('\n');
  };

  // Devin: transcript index (for clickThinking) of the thought with item id `acpN:think`.
  const thoughtIndexFor = id => thinkingNodes().findIndex(el => {
    const row = el.closest('[data-acp-msg-index]');
    return !!row && `${itemKey(row)}:think` === id;
  });
  const closeThinkingIfOpen = indexes => {
    const nodes = thinkingNodes();
    for (const i of indexes || []) {
      const el = nodes[i];
      if (el && thinkingPlain(el)) thinkingToggleEl(el)?.click();
    }
    return true;
  };

  // Messages sent while the Agent is running wait in Cursor's queue tray until the current turn ends.
  const QUEUE_ROW = '[data-queue-row], .composer-toolbar-queue-item[data-queue-item-id]';
  const queueRows = () => [...document.querySelectorAll(QUEUE_ROW)].filter(vis);
  const queued = () => queueRows().map(e => ({
    id: e.dataset.queueItemId,
    t: (e.dataset.queueItemQuery || e.innerText || '').trim().slice(0, 4000),
  }));
  // The submit button becomes "Stop generation" while a turn is running.
  // The stop icon on a human bubble (Ctrl+Shift+Backspace) reverts that message instead.
  const stopGenerationButton = () => [...document.querySelectorAll('button, [role=button]')].find(e => {
    if (!vis(e) || e.closest('.composer-human-message, .human-message-action-slot')) return false;
    return /^stop generation\b/i.test((e.getAttribute('aria-label') || '').trim());
  });
  const legacyStopIcon = () => [...document.querySelectorAll('.composer-button-area .codicon-debug-stop, .send-with-mode .codicon-debug-stop')].find(e => vis(e) && !e.closest('.composer-human-message, .human-message-action-slot'));
  // Devin: while a turn runs the submit button reads "Cancel" (empty input) or "Queue" (typed text).
  const devinSubmitBusy = () => !!devinLog() && [...document.querySelectorAll('button[aria-label]')].some(e => vis(e) && /^(Cancel|Queue)$/.test(e.getAttribute('aria-label')) && !!e.querySelector('svg'));
  const isBusy = () => !!stopGenerationButton() || !!legacyStopIcon() || devinSubmitBusy();
  // Devin's queue (verified live): a bar "N message(s) queued" with a "Clear all" button, then an <ol>
  // of li[role=button] rows holding the message text. Hovering a row reveals "Edit message",
  // "Remove from queue" and "Send now" (hidden until hover). Rows are read from textContent.
  const devinQueueBar = () => [...document.querySelectorAll('span.text-12')].find(s => /\d+ messages? queued/.test(s.innerText || ''));
  const devinQueueCount = () => Number(/(\d+) messages? queued/.exec(devinQueueBar()?.innerText || '')?.[1]) || 0;
  const devinQueueRows = () => devinQueueBar() ? [...document.querySelectorAll('ol li[role="button"]')].filter(e => /cursor-grab/.test(e.className)) : [];
  const devinQueued = () => devinQueueRows().map((row, n) => ({
    id: `dq${n}`,
    t: (row.innerText || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000),
    src: 'devin',
  }));
  const devinQueueTarget = (n, action) => {
    const row = devinQueueRows()[Number(n)];
    if (!row || !vis(row)) return null;
    if (!action) return center(row);
    const label = { send: 'Send now', remove: 'Remove from queue' }[action];
    const b = label && [...row.querySelectorAll('button[aria-label]')].find(e => vis(e) && e.getAttribute('aria-label') === label);
    return b ? center(b) : null;
  };
  const devinQueueClearTarget = () => {
    const b = [...document.querySelectorAll('button[aria-label="Clear all"]')].find(vis);
    return b && devinQueueBar() ? center(b) : null;
  };

  // First call (no action) returns the row center to hover over; hover-only buttons appear after that.
  const queueTarget = (id, action) => {
    const row = queueRows().find(e => e.dataset.queueItemId === id);
    if (!row) return null;
    row.scrollIntoView({ block: 'nearest' });
    if (!action) return center(row);
    const b = row.querySelector(`[data-queue-action="${CSS.escape(action)}"]`)
      || [...row.querySelectorAll('[aria-label]')].find(e => e.getAttribute('aria-label') === { send: 'Send now', remove: 'Remove', edit: 'Edit' }[action]);
    return b && vis(b) ? center(b) : null;
  };

  // Running subagents: task cards in the transcript plus the "N subagents running" tray above the composer.
  // Clicking a tray row opens that subagent's own transcript as a chat-editor tab (no composer there).
  const SUB_ROW = '.composer-toolbar-background-job-item';
  const subRowName = e => e.querySelector('.composer-toolbar-background-job-item-text')?.innerText.trim() || '';
  const subagents = () => {
    const names = new Set();
    for (const h of document.querySelectorAll('.task-tool-call-header')) {
      if (!vis(h) || !h.closest(ITEM_SEL)?.querySelector('.ui-subagent-status-indicator--running-loader, .task-subagent-header-pill-button--stop')) continue;
      const n = h.querySelector('span.truncate')?.childNodes[0]?.textContent.trim();
      if (n) names.add(n);
    }
    for (const r of document.querySelectorAll(SUB_ROW)) if (subRowName(r)) names.add(subRowName(r));
    return [...names];
  };
  const subTrayHeader = () => [...document.querySelectorAll('div')].find(e => vis(e) && [...e.childNodes].some(n => n.nodeType === 3 && /^\d+ subagents? running$/.test(n.textContent.trim())));
  const subTarget = (name, part) => {
    const row = [...document.querySelectorAll(SUB_ROW)].find(r => vis(r) && subRowName(r) === name);
    if (!row) { const h = subTrayHeader(); return h ? { expand: true, ...center(h) } : null; }
    if (part === 'stop') {
      const s = [...row.querySelectorAll('span.truncate')].find(e => e.innerText.trim() === 'Stop');
      return s ? center(s) : null;
    }
    return center(row.querySelector('.composer-toolbar-background-job-item-text') || row);
  };
  const activeChatTab = () => [...document.querySelectorAll('.tab.active')].map(e => e.getAttribute('aria-label') || '').find(l => /Chat Editors/.test(l)) || null;
  const tabTarget = label => {
    const t = [...document.querySelectorAll('.tab')].find(e => vis(e) && e.getAttribute('aria-label') === label);
    return t ? center(t) : null;
  };
  // A new Devin session draws its composer inside the welcome layer. Devin hides that
  // layer while any file tab is open, so the model chip and prompt have a 0-size box.
  // Show the welcome until the new session is no longer pending. The file tab stays open.
  const revealDevinComposer = () => {
    const groups = [...document.querySelectorAll('.editor-group-container')];
    for (const group of groups) {
      if (group.classList.contains('has-pending-new-session-welcome')) continue;
      for (const el of group.querySelectorAll('[data-crl-devin-reveal]')) {
        el.style.removeProperty('display');
        el.removeAttribute('data-crl-devin-reveal');
      }
    }
    let shown = false;
    for (const group of groups) {
      if (!group.classList.contains('has-pending-new-session-welcome')) continue;
      const welcome = group.querySelector(':scope > .windsurf-welcome-container');
      const editor = group.querySelector(':scope > .editor-container');
      if (welcome && getComputedStyle(welcome).display === 'none') {
        welcome.style.setProperty('display', 'flex', 'important');
        welcome.setAttribute('data-crl-devin-reveal', '1');
      }
      if (editor && getComputedStyle(editor).display !== 'none') {
        editor.style.setProperty('display', 'none', 'important');
        editor.setAttribute('data-crl-devin-reveal', '1');
      }
      shown = true;
    }
    return shown;
  };
  const hasComposer = () => {
    revealDevinComposer();
    if ([...document.querySelectorAll('.aislash-editor-input[contenteditable="true"], .ui-prompt-input-editor__input[contenteditable="true"]')].some(vis)) return true;
    // Devin's prompt is a plain contenteditable. Its message bubbles are role=group too, so only those are excluded.
    return [...document.querySelectorAll('[contenteditable="true"]')].some(e => vis(e) && !e.closest('.monaco-editor, [aria-label="User message"], [aria-label="Devin message"]'));
  };

  // The Agent's ask-question tool renders as a toolbar above the composer, outside the message list.
  const QN = '.composer-questionnaire-toolbar';
  const qnBox = () => [...document.querySelectorAll(QN)].find(vis);
  const inQn = el => !!el.closest(QN);
  const qnOptions = q => [...q.querySelectorAll('.composer-questionnaire-toolbar-option')];
  const qnAction = (box, re) => [...box.querySelectorAll('.composer-questionnaire-toolbar-actions > *')].find(e => vis(e) && re.test(e.innerText));
  const questions = () => {
    const box = qnBox();
    if (!box) return null;
    const list = [...box.querySelectorAll('.composer-questionnaire-toolbar-question')].map(q => ({
      text: (q.querySelector('.composer-questionnaire-toolbar-question-label .markdown-root') || q.querySelector('.composer-questionnaire-toolbar-question-label'))?.innerText.trim() || '',
      options: qnOptions(q).map(o => {
        const ta = o.querySelector('textarea');
        return {
          label: ta ? '' : o.querySelector('.composer-questionnaire-toolbar-option-label')?.innerText.trim() || '',
          free: !!ta, value: ta?.value || '',
          sel: !!o.querySelector('.composer-questionnaire-toolbar-option-letter-selected'),
        };
      }),
    }));
    const submit = qnAction(box, /continue|submit|继续|提交/i);
    return { list, canSubmit: !!submit && submit.dataset.disabled !== 'true' };
  };
  // Devin: the question card sits in a `[data-band-item]` above the composer, one question at a time
  // ("1 of 2" pager, Skip, option rows `div[role=button]`; multi-select rows carry a role=checkbox and the
  // card has a Submit button). A single choice answers as soon as its row is clicked. Free text goes
  // through the normal composer ("Other answer" placeholder).
  const devinQnBand = () => !devinLog() ? null : [...document.querySelectorAll('[data-band-item]')]
    .find(e => vis(e) && /\b\d+ of \d+\b/.test(e.innerText || '') && e.querySelector('button[aria-label="Skip"]'));
  const devinQnRows = band => [...band.querySelectorAll('[data-slot="scroll-area-viewport"] > [role="button"]')];
  const devinQnButton = (band, name) => [...band.querySelectorAll('button')].find(b => vis(b) && (b.getAttribute('aria-label') === name || (b.innerText || '').trim() === name));
  const devinQuestions = () => {
    const band = devinQnBand();
    if (!band) return null;
    const pg = /\b(\d+) of (\d+)\b/.exec(band.innerText || '');
    const rows = devinQnRows(band);
    const options = rows.map(r => {
      const cb = r.querySelector('[role="checkbox"]');
      const ps = [...r.querySelectorAll('p')].map(p => (p.innerText || '').trim());
      return { label: ps[0] || (r.innerText || '').trim(), desc: ps[1] || '', sel: cb ? cb.getAttribute('aria-checked') === 'true' : false };
    });
    const multi = rows.some(r => r.querySelector('[role="checkbox"]'));
    const text = [...band.querySelectorAll('p')].find(p => !p.closest('[data-slot="scroll-area"]'))?.innerText.trim() || '';
    const submit = devinQnButton(band, 'Submit') || devinQnButton(band, 'Continue');
    const prev = devinQnButton(band, 'Previous question'), next = devinQnButton(band, 'Next question');
    return {
      devin: true, src: 'devin', list: [{ text, options, multi }],
      pager: pg ? { cur: Number(pg[1]), total: Number(pg[2]) } : null,
      canPrev: !!prev && !prev.disabled, canNext: !!next && !next.disabled,
      hasSubmit: !!submit, canSubmit: !!submit && !submit.disabled,
    };
  };
  const devinQuestionTarget = (oi, part) => {
    const band = devinQnBand();
    if (!band) return null;
    if (part === 'option') {
      const row = devinQnRows(band)[oi];
      if (!row) return null;
      row.scrollIntoView({ block: 'nearest' });
      return center(row);
    }
    const name = { skip: 'Skip', prev: 'Previous question', next: 'Next question' }[part];
    const b = part === 'submit' ? (devinQnButton(band, 'Submit') || devinQnButton(band, 'Continue')) : devinQnButton(band, name);
    return b && !b.disabled ? center(b) : null;
  };
  const questionTarget = (qi, oi, part) => {
    if (devinQnBand()) return devinQuestionTarget(oi, part);
    const box = qnBox();
    if (!box) return null;
    if (part === 'submit' || part === 'skip') {
      const b = qnAction(box, part === 'skip' ? /skip|跳过/i : /continue|submit|继续|提交/i);
      return b ? center(b) : null;
    }
    const q = box.querySelectorAll('.composer-questionnaire-toolbar-question')[qi];
    const o = q && qnOptions(q)[oi];
    if (!o) return null;
    o.scrollIntoView({ block: 'nearest' });
    return center(o.querySelector('textarea') || o);
  };

  // Files changed by the Agent: the "N Files" toggle above the composer expands a list with per-file undo / keep.
  const filesToggle = () => [...document.querySelectorAll('span.cursor-pointer')].find(e => vis(e) && /^\d+ Files?$/.test(e.innerText.trim().replace(/\s+/g, ' ')));
  // Devin's review bar: a "N files with changes" header above the composer, per-row
  // Accept file (check icon) / Reject file (x icon) buttons and Reject all / Accept all spans.
  const stripBidi = s => (s || '').replace(/[⁦-⁩]/g, '');
  // The bar is "N files | +a -d | Quick review | Reject all | Accept all" when collapsed; the
  // expanded list box sits above it. Collapsed, the list keeps its text but is display:none.
  const devinChangesHdr = () => [...document.querySelectorAll('div.group.cursor-pointer')]
    .find(e => /files? with changes/.test(stripBidi(e.innerText)));
  const devinChangesBox = () => {
    const h = devinChangesHdr();
    if (h) return h.closest('div.flex.min-w-0.flex-col.gap-1') || h.parentElement;
    return [...document.querySelectorAll('div.flex.min-w-0.flex-col.gap-1')].find(e => vis(e) && /\bReject all\b/.test(e.innerText || '')) || null;
  };
  const devinChangedRows = () => [...(devinChangesBox()?.querySelectorAll('div.group.cursor-pointer.hover\\:bg-tint-secondary') || [])];
  const devinBarLeft = () => [...(devinChangesBox()?.querySelectorAll('div.select-none') || [])]
    .find(e => vis(e) && /^\d+ files?\b/.test(e.innerText.trim()) && !/with changes/.test(e.innerText));
  const devinOpen = () => devinChangedRows().some(vis);
  // Devin's editor surface can drop the chat bar while its "Review N files" button (editor pane) still counts.
  const devinCascadeCount = () => devinLog() ? Number(/Review\s+(\d+)\s+files?/.exec(stripBidi([...document.querySelectorAll('.cascade-bar')].map(b => b.innerText || '').join(' ')))?.[1]) || 0 : 0;
  const changedCount = () => parseInt(filesToggle()?.innerText || '0', 10) || 0
    || Number(/(\d+)\s+files?\b/.exec(stripBidi(devinChangesBox()?.innerText))?.[1]) || devinCascadeCount();
  const changedRows = () => [...document.querySelectorAll('.composer-file-list-item')].filter(vis);
  const changedFiles = () => {
    const rows = changedRows();
    if (rows.length) return rows.map(r => {
      const stat = [...r.querySelectorAll('.tabular-nums span')].map(s => s.innerText.trim());
      return {
        name: r.querySelector('span[style*="nowrap"]')?.innerText.trim() || r.innerText.trim().split('\n')[0],
        add: stat.find(s => s.startsWith('+')) || '',
        del: stat.find(s => /^[-−]/.test(s)) || '',
      };
    });
    return devinChangedRows().map(r => {
      const texts = [...r.querySelectorAll('span')].map(s => stripBidi(s.innerText).trim()).filter(Boolean);
      // Directory-prefixed rows render as two leaves ("app/" + "index.html"); join them.
      const name = texts.filter(t => !/^[+−-]\s?\d+$/.test(t)).join('') || stripBidi(r.innerText).split('\n').filter(Boolean)[0] || '';
      return {
        name,
        add: (texts.find(t => /^\+\s?\d+$/.test(t)) || '').replace(/\s+/g, ''),
        del: (texts.find(t => /^[−-]\s?\d+$/.test(t)) || '').replace(/\s+/g, ''),
      };
    });
  };
  const filesBar = () => {
    let t = filesToggle();
    while (t && !t.querySelector('[data-click-ready]')) t = t.parentElement;
    return t;
  };
  // Bar-level actions besides Stop (handled elsewhere) and Review (desktop-only diff view), e.g. Keep All / Undo All.
  const fileBarButtons = () => {
    const cur = [...(filesBar()?.querySelectorAll('[data-click-ready]') || [])].filter(vis)
      .map(e => ({ el: e, label: (e.querySelector('.truncate') || e).innerText.trim() }))
      .filter(x => x.label && !/^(stop|review)$/i.test(x.label));
    if (cur.length) return cur;
    const box = devinChangesBox();
    if (!box) return [];
    return [...box.querySelectorAll('span')].filter(e => vis(e) && /^(Reject all|Accept all)$/.test((e.innerText || '').trim()))
      .map(e => ({ el: e, label: e.innerText.trim() }));
  };
  const filesState = () => ({
    files: changedFiles(),
    actions: fileBarButtons().map(x => x.label),
    open: changedRows().length > 0 || (!!devinChangesBox() && devinOpen()),
    count: changedCount(),
  });
  // Devin: hovering a file row reveals two 18px icon buttons — first the check
  // ("Accept file", act 'keep'), then the x ("Reject file", act 'undo'). The
  // 'toggle' is the collapsed "N files" bar item, which expands/collapses the list.
  const devinFileTarget = (i, name, act) => {
    if (act === 'toggle') {
      // Folded: the "N files" group opens the list. Expanded: its header "N files with changes" folds it.
      const l = devinBarLeft() || (devinChangesHdr() && vis(devinChangesHdr()) ? devinChangesHdr() : null);
      return l ? center(l) : null;
    }
    if (act === 'bar') { const b = fileBarButtons().find(x => x.label === name); return b ? center(b.el) : null; }
    const row = devinChangedRows()[i];
    if (!row || !vis(row) || changedFiles()[i]?.name !== name) return null;
    row.scrollIntoView({ block: 'nearest' });
    if (act === 'row') return center(row);
    const pick = row.querySelectorAll('button')[act === 'undo' ? 1 : 0];
    return pick && vis(pick) ? center(pick) : null;
  };
  const fileTarget = (i, name, act) => {
    if (devinChangesBox()) return devinFileTarget(i, name, act);
    if (act === 'toggle') { const t = filesToggle(); return t ? center(t) : null; }
    if (act === 'bar') return (b => b ? center(b.el) : null)(fileBarButtons().find(x => x.label === name));
    const row = changedRows()[i];
    if (!row || changedFiles()[i].name !== name) return null;
    row.scrollIntoView({ block: 'nearest' });
    if (act === 'row') return center(row);
    const icon = row.querySelector(act === 'undo' ? '.codicon-x-two' : '.codicon-check-two');
    return icon ? center(icon.closest('.anysphere-icon-button') || icon) : null;
  };

  // Editing a queued message loads it into the main composer, which is tagged with the item id until saved.
  const focusQueueEdit = id => {
    const bar = [...document.querySelectorAll('[data-editing-queue-item-id]')].find(e => vis(e) && e.dataset.editingQueueItemId === id);
    const ed = bar && [...bar.querySelectorAll('[contenteditable="true"]')].find(vis);
    if (!ed) return false;
    ed.focus();
    return true;
  };

  const stopTarget = () => {
    const btn = stopGenerationButton();
    if (btn) return center(btn);
    const icon = legacyStopIcon();
    return icon ? center(icon.closest('button, [role=button], .anysphere-icon-button') || icon) : null;
  };

  const modelButton = () => {
    const known = [...document.querySelectorAll('.ui-model-picker__trigger, .composer-unified-dropdown-model')].find(vis);
    if (known) return known;
    // Model sits in the prompt toolbar, on the opposite side from voice / send.
    // Status chips such as "commit" live outside that toolbar and must not match.
    const bar = document.querySelector('.ui-prompt-input-toolbar');
    if (!bar) return devinModelButton();
    const right = bar.querySelector('.ui-prompt-input-toolbar__right');
    const STATUS = /^(commit|committing|generating|applying|reading|searching|running|planning|thinking|working|editing|indexing)\b/i;
    return [...bar.querySelectorAll('button, [role=button]')].find(e => {
      if (!vis(e) || (right && right.contains(e))) return false;
      const text = (e.innerText || '').replace(/\s+/g, ' ').trim();
      return text && !STATUS.test(text);
    }) || devinModelButton();
  };
  const DEVIN_MODEL = /^(SWE|GPT|Claude|Gemini|GLM|Kimi|Fusion)\b/;
  const devinModelButton = () => {
    revealDevinComposer();
    return [...document.querySelectorAll('button')].find(e => {
      if (!vis(e) || e.closest('.space-y-2')) return false;
      const text = (e.innerText || '').replace(/\s+/g, ' ').trim();
      return DEVIN_MODEL.test(text) && text.length < 50;
    });
  };
  const devinModelMenu = () => [...document.querySelectorAll('div')].find(e => vis(e) && (e.innerText || '').includes('Recently Used') && (e.innerText || '').includes('See more') && (e.innerText || '').length < 2500);
  const normLabel = s => (s || '').replace(/[\u200b\u200c\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  // Fusion is a lead + sidekick pairing. The detail panel only exists while that model menu is open.
  const fusionPanel = () => [...document.querySelectorAll('div')].find(e => {
    if (!vis(e)) return false;
    const t = e.innerText || '';
    const b = e.getBoundingClientRect();
    return b.width > 200 && b.width < 520 && t.includes('Lead') && t.includes('Sidekick') && t.includes('Fast Mode') && t.length < 900;
  });
  const fusionLine = el => normLabel((el?.innerText || '').split('\n')[0]).slice(0, 60);
  const fusionConfig = () => {
    const panel = fusionPanel();
    if (!panel) return null;
    const boxes = [...panel.querySelectorAll('[role=combobox]')].filter(vis);
    if (boxes.length < 3) return null;
    const sw = panel.querySelector('[role=switch]');
    return { lead: fusionLine(boxes[0]), effort: fusionLine(boxes[1]), sidekick: fusionLine(boxes[2]), fast: sw?.getAttribute('aria-checked') === 'true' };
  };
  const clickFusionCombo = part => {
    const panel = fusionPanel();
    const boxes = panel ? [...panel.querySelectorAll('[role=combobox]')].filter(vis) : [];
    const i = part === 'lead' ? 0 : part === 'effort' ? 1 : part === 'sidekick' ? 2 : -1;
    const el = boxes[i];
    if (!el) return false;
    el.click();
    return true;
  };
  const clickFusionFast = () => {
    const sw = fusionPanel()?.querySelector('[role=switch]');
    if (!sw) return false;
    sw.click();
    return true;
  };
  const fusionOptionItems = () => {
    const seen = new Set();
    const items = [];
    for (const el of document.querySelectorAll('[role=option]')) {
      if (!vis(el)) continue;
      const label = fusionLine(el);
      if (!label || label.length > 60 || seen.has(label)) continue;
      seen.add(label);
      items.push({ label, checked: el.getAttribute('aria-selected') === 'true' });
    }
    return items;
  };
  const fusionOptionTarget = label => {
    const want = normLabel(label);
    const el = [...document.querySelectorAll('[role=option]')].find(e => vis(e) && fusionLine(e) === want);
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest' });
    return center(el);
  };

  const thinkingItem = (el, host, n) => {
    const title = thinkingTitleOf(el) || '思考';
    const body = thinkingPlain(el).trim();
    const base = itemKey(host && host !== el ? host : el) || 'row';
    const item = { i: `${base}:think:${n}`, k: 'thinking', t: body ? `${title}\n${body}` : title };
    if (thinkingLive(el)) item.live = true;
    return item;
  };
  const isThinking = el => el.matches('.ui-thinking-collapsible, .chat-thinking-box')
    || (el.matches('.highlight-wrapper') && /^(thinking|thoughts|thought(?: for)? )\b/i.test(thinkingTitleOf(el)));
  const thinkingInside = root => [...root.querySelectorAll(THINKING_ROOT)].filter(th => th.closest(THINKING_ROOT) === th && isThinking(th));
  const withoutThinking = el => {
    const clone = el.cloneNode(true);
    clone.querySelectorAll(THINKING_ROOT).forEach(n => n.remove());
    return clone;
  };
  // Devin user messages: rendered KaTeX would read twice through innerText (MathML + glyphs), so rebuild the
  // text with the math as $tex$ / $$tex$$ from the KaTeX annotation. Without math the plain text is unchanged.
  const devinUserText = root => {
    if (!root.querySelector('.katex')) return root.innerText.trim();
    const tex = n => (n.querySelector('annotation')?.textContent || '').trim();
    const walk = n => {
      if (n.nodeType === 3) return n.textContent;
      if (n.nodeType !== 1 || n.matches('button, style, script, svg')) return '';
      if (n.matches('.katex-display, .katex-block') && tex(n)) return `\n$$${tex(n)}$$\n`;
      if (n.matches('.katex') && tex(n)) return `$${tex(n)}$`;
      if (n.tagName === 'BR') return '\n';
      const inner = [...n.childNodes].map(walk).join('');
      return /^(P|DIV|LI|UL|OL|PRE|BLOCKQUOTE|H[1-6]|TABLE|TR)$/.test(n.tagName) ? `\n${inner}\n` : inner;
    };
    return walk(root).replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  };
  const messageItem = el => {
    const kindEl = el.matches('[data-message-kind]') ? el : el.querySelector('[data-message-kind]');
    const aria = el.getAttribute('aria-label');
    const k = aria === 'User message' ? 'human'
      : aria === 'Devin message' ? 'assistant'
      : kindEl?.dataset.messageKind || (el.querySelector('.composer-human-message, .aislash-editor-input-readonly') ? 'human' : 'other');
    const item = { i: itemKey(el), k };
    if (k === 'thinking') {
      const action = (el.querySelector('.ui-collapsible-action')?.innerText || '').replace(/\s+/g, ' ').trim();
      let details = (el.querySelector('.ui-collapsible-details')?.innerText || '').replace(/\s+/g, ' ').trim();
      details = details.replace(/\b(\w+)(?:\s+\1)+\b/gi, '$1');
      const title = [action || 'Thought', details].filter(Boolean).join(' ').slice(0, 80);
      const content = el.querySelector('.ui-collapsible-content');
      const plain = (content?.textContent || '').replace(/\u00a0/g, ' ').trim();
      item.t = plain ? `${title}\n${plain}` : title;
      if (/^thinking\b/i.test(action) || el.querySelector('[data-loading]')) item.live = true;
      return item;
    }
    const readable = el.querySelector('.aislash-editor-input-readonly, .composer-human-message') || withoutThinking(el);
    if (k === 'human') item.t = aria === 'User message' ? devinUserText(readable) : readable.innerText.trim();
    else if (k === 'assistant') {
      const devinRoot = aria === 'Devin message' ? el.querySelector('.prose-main') : null;
      const md = [...el.querySelectorAll('.markdown-root, .ui-markdown, .rendered-markdown')].find(n => !n.closest(THINKING_ROOT));
      item.h = devinRoot ? devinRich(devinRoot) : md ? clean(md) : esc((withoutThinking(el).innerText || '').trim()).replace(/\n/g, '<br>');
    }
    else item.t = summary(withoutThinking(el));
    if (k === 'tool') { const f = toolFile(el); if (f) item.f = f; }
    const b = buttonsIn(el, false).filter(x => !x.el.closest(THINKING_ROOT));
    if (b.length) item.b = b.map(x => x.label);
    return item;
  };

  /* ---------- Devin transcript rows ---------- */

  const devinLog = () => document.querySelector('[role="log"][aria-label="Session transcript"]');

  // Event-group tool rows: "Searched<query>", "Explored<file> and searched <q>", "Read<file> #L…".
  const devinEventTool = (eg, i, lines) => {
    const title = lines[0] || '';
    const m = /^([A-Z][a-z]+)/.exec(title);
    const label = m ? m[1] : '';
    const kind = /^searched/i.test(label) ? 'search' : /^explored/i.test(label) ? 'explore' : /^read/i.test(label) ? 'read' : 'other';
    const rest = title.slice(label.length);
    const t = `${label} ${[rest, ...lines.slice(1)].join(' · ')}`.replace(/\s+/g, ' ').trim();
    const codes = [...eg.querySelectorAll('code')].map(c => (c.innerText || '').trim()).filter(Boolean).slice(0, 6);
    const item = { i, k: 'tool', kind, t, chips: codes.map(c => c.replace(/\n/g, ' ').slice(0, 120)) };
    const fileish = codes.map(c => c.split('\n')[0].trim())
      .filter(c => /^[\w.\-~/\\:]+$/.test(c) && (/\.[A-Za-z0-9]{1,10}$/.test(c) || /^[A-Za-z]:\\|^\//.test(c)));
    if (fileish.length === 1) {
      item.f = fileish[0];
      const code = codes.find(c => c.startsWith(fileish[0]));
      const r = /(#L[\d,\-]+)/.exec(code || '');
      if (r) item.r = r[1];
    }
    return item;
  };

  // "Command <what> in <dir>" rows: medium title, optional "30s" duration, then the command text.
  const devinCommand = (row, i) => {
    const med = row.querySelector('span.codeium-text-medium');
    const t = (med?.innerText || '').trim();
    if (!t || !/^command\b/i.test(t)) return null;
    const rest = (row.innerText || '').split('\n').slice(1);
    let d = '';
    if (rest.length && /^\d+\s*[smh]\b/i.test(rest[0].trim())) d = rest.shift().trim();
    return { i, k: 'tool', kind: 'command', t, d, cmd: rest.join('\n').trim().slice(0, 4000) };
  };

  // "N / M tasks done" rows (Devin's todo list). The counts are always there; the checklist
  // items only exist while the row is expanded (see setTasksOpen).
  const devinTasks = (row, i) => {
    const sp = [...row.querySelectorAll('span')].find(s => /^\d+\s*\/\s*\d+\s+tasks?\s+done$/.test((s.innerText || '').trim()));
    if (!sp) return null;
    const m = /^(\d+)\s*\/\s*(\d+)/.exec(sp.innerText.trim());
    const rowsEl = [...row.querySelectorAll('div.flex.items-start')].filter(r => r.querySelector('span.block'));
    const items = rowsEl.map(r => ({
      t: (r.querySelector('span.block')?.innerText || '').trim().slice(0, 300),
      status: r.querySelector('.animate-spin') ? 'in_progress' : r.querySelector('svg.text-text-green') ? 'done' : 'pending',
    })).filter(x => x.t);
    return { i, k: 'tasks', done: Number(m[1]), total: Number(m[2]), ...(rowsEl.length ? { items } : {}) };
  };
  // Expands or folds a tasks row by its acp id (the chevron button only; caller restores).
  const setTasksOpen = (id, open) => {
    const row = [...(devinLog()?.children || [])].find(r => itemKey(r) === id);
    const btn = row?.querySelector('button[aria-expanded]');
    if (!btn) return false;
    if (btn.getAttribute('aria-expanded') !== String(open)) btn.click();
    return true;
  };

  // File-edit rows: medium file name, +N/-N counters, then a .diff-code-block of line divs.
  const devinEdit = (row, i) => {
    const block = row.querySelector('.diff-code-block');
    const med = row.querySelector('span.codeium-text-medium');
    if (!block || !med) return null;
    const diff = [...block.children].map(d => {
      const c = String(d.className || '');
      const type = /insert/.test(c) ? '+' : /delete/.test(c) ? '-' : ' ';
      return [type, (d.innerText || '').replace(/\n+$/, '')];
    }).filter(l => l[1] !== '');
    const over = diff.length > 200;
    const nums = [...row.querySelectorAll('span')].map(s => (s.textContent || '').trim());
    const num = re => Number((nums.find(t => re.test(t)) || '').slice(1)) || 0;
    const item = { i, k: 'tool', kind: 'edit', f: med.innerText.trim(), add: num(/^\+\d+$/), del: num(/^-\d+$/), diff: over ? diff.slice(0, 200) : diff };
    if (over) item.diff.push(['…', `… 省略 ${diff.length - 200} 行`]);
    return item;
  };

  // Iterate the Devin transcript's direct children in order: messages, thought groups,
  // tool event rows, commands and file edits all become items. Unknown rows are skipped.
  const devinItems = log => {
    const rows = [...log.children].filter(vis);
    const last = [...rows].reverse().find(r => (r.innerText || '').trim());
    const items = [];
    rows.forEach((row, n) => {
      const i = itemKey(row) || `acpx${n}`;
      const msg = row.querySelector('[role=group][aria-label="User message"], [role=group][aria-label="Devin message"]');
      if (msg) {
        const it = messageItem(msg);
        if (!it.i) it.i = i;
        items.push(it);
        return;
      }
      const tasks = devinTasks(row, i);
      if (tasks) { items.push(tasks); return; }
      const eg = row.classList.contains('event-group') ? row : row.querySelector('.event-group');
      if (eg) {
        const lines = (eg.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
        const title = lines[0] || '';
        if (/^(thoughts?|thinking)\b/i.test(title)) {
          const body = lines.slice(1).join('\n');
          const it = { i: `${i}:think`, k: 'thinking', t: body ? `${title}\n${body}` : title };
          if (row === last && !/\d/.test(title)) it.live = true;
          items.push(it);
          return;
        }
        items.push(devinEventTool(eg, i, lines));
        return;
      }
      const edit = devinEdit(row, i);
      if (edit) { items.push(edit); return; }
      const cmd = devinCommand(row, i);
      if (cmd) { items.push(cmd); return; }
    });
    return items.filter(Boolean).map(it => ({ ...it, src: 'devin' }));
  };

  const extract = () => {
    const panel = findPanel();
    const log = devinLog();
    // A brand-new Devin session has a composer and model chip, but no message list yet.
    if (!panel && !log) {
      const modelEl = modelButton();
      if (!modelEl && !hasComposer()) return null;
      return {
        rect: [0, 0, 0, 0],
        items: [],
        global: [],
        busy: isBusy(),
        queued: queued(),
        subagents: subagents(),
        changed: changedCount(),
        questions: null,
        ...(devinSurface() ? { session: devinSession() } : {}),
        readonly: !hasComposer(),
        mode: null,
        model: modelEl ? normLabel(modelEl.innerText).split('\n')[0].slice(0, 60) : null,
        context: contextPct(),
      };
    }
    const r = panel ? panel.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
    const items = log ? devinItems(log) : topItems(panel).flatMap(el => {
      const thoughts = thinkingInside(el).map((th, n) => thinkingItem(th, el, n));
      if (isThinking(el)) return thoughts.length ? thoughts : [thinkingItem(el, el, 0)];
      const main = messageItem(el);
      if (main.k === 'assistant' && !main.h && !main.b) return thoughts;
      return [...thoughts, main];
    });
    const global = buttonsIn(panel || document, true).filter(x => !inItem(x.el) && !inQn(x.el) && !/^stop generation\b/i.test(x.label)).map(x => x.label);
    const modeEl = [...document.querySelectorAll('.composer-unified-dropdown[data-mode]')].find(vis);
    const modelEl = modelButton();
    return {
      rect: [r.x, r.y, r.width, r.height].map(Math.round),
      items,
      global,
      busy: isBusy(),
      queued: devinLog() ? devinQueued() : queued(),
      ...(devinLog() ? { queuedCount: devinQueueCount() } : {}),
      subagents: subagents(),
      changed: changedCount(),
      questions: devinLog() ? devinQuestions() : questions(),
      ...(devinLog() ? { session: devinSession() } : {}),
      readonly: !hasComposer(),
      mode: modeEl ? modeEl.innerText.trim() || modeEl.dataset.mode : null,
      model: modelEl ? normLabel(modelEl.innerText).split('\n')[0].slice(0, 60) : null,
      context: contextPct(),
      ...(devinSurface() ? { surface: devinSurface() } : {}),
    };
  };
  const contextPct = () => {
    const el = [...document.querySelectorAll('button, [role=button]')].find(e => vis(e) && /^Context(?:\s+usage)?:?\s*\d+%/i.test(((e.getAttribute('aria-label') || e.innerText || '').replace(/\s+/g, ' ').trim())));
    const m = el && /(\d+)%/.exec((el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' '));
    return m ? Number(m[1]) : null;
  };

  // Named controls in Cursor's UI; each entry lists fallbacks from newest to oldest Cursor layouts.
  const CONTROLS = {
    mode: () => [...document.querySelectorAll('.composer-unified-dropdown[data-mode]')].find(vis),
    model: () => modelButton(),
    history: () => [...document.querySelectorAll('[aria-label^="Show Chat History"], [aria-label^="Show Agent History"]')].find(vis),
    newChat: () => [...document.querySelectorAll('[aria-label="New Agent"], [aria-label^="New Chat"], [aria-label="New session"], [data-action-id="new-agent"]')].find(vis),
  };

  const center = el => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };

  const control = name => {
    const el = CONTROLS[name]?.();
    return el ? center(el) : null;
  };
  const clickControl = name => {
    const el = CONTROLS[name]?.();
    if (!el) return false;
    el.click();
    return true;
  };

  const MENU_ITEMS = {
    mode: () => [...document.querySelectorAll('.composer-unified-context-menu-item')].map(e => ({ el: e, label: e.innerText.trim().split('\n')[0], checked: !!e.querySelector('.codicon-check') })),
    model: () => {
      const currentModel = normLabel(modelButton()?.innerText || '').split('\n')[0];
      // Auto is its own row and has no .ui-model-picker__item-content-name, so the list below would skip it.
      const autoRows = [...document.querySelectorAll('[data-testid="auto-mode-select"]')].filter(vis).map(e => {
        const label = normLabel(e.innerText).split('\n')[0].slice(0, 60) || 'Auto';
        return {
          el: e,
          id: e.getAttribute('data-testid'),
          params: false,
          label,
          checked: label === currentModel || !!e.querySelector('[class*=check]') || e.getAttribute('aria-checked') === 'true',
        };
      });
      const classic = [...document.querySelectorAll('.ui-menu__row')].filter(e => e.getAttribute('data-testid') !== 'auto-mode-select' && e.querySelector('.ui-model-picker__item-content-name'));
      if (classic.length) return [...autoRows, ...classic.map(e => ({ el: e, id: e.dataset.testid, params: !!e.querySelector('[data-testid=parameter-edit-btn]'), label: normLabel(e.querySelector('.ui-model-picker__item-content-name').innerText), checked: !!e.querySelector('.codicon-check, .ui-model-picker__item-right-section [class*=check]') }))];
      const cursorItems = [...document.querySelectorAll('[data-testid^="model-item-"], [data-testid="auto-mode-select"]')].filter(vis).map(e => {
        const label = normLabel(e.innerText).split('\n')[0].slice(0, 60);
        return {
          el: e,
          id: e.getAttribute('data-testid'),
          params: false,
          label,
          checked: label === currentModel || !!e.querySelector('[class*=check]') || e.getAttribute('aria-checked') === 'true',
        };
      });
      if (cursorItems.length) return cursorItems;
      const pop = devinModelMenu();
      if (!pop) return [];
      const current = normLabel(devinModelButton()?.innerText || '');
      const pairing = fusionPanel();
      return [...pop.querySelectorAll('button')].filter(e => vis(e) && !pairing?.contains(e)).map(e => {
        const label = normLabel(e.innerText).split('\n')[0].slice(0, 60);
        return { el: e, id: label, params: false, label, checked: label === current };
      }).filter(x => DEVIN_MODEL.test(x.label));
    },
    history: () => {
      const rows = [...document.querySelectorAll('.composer-history-hover-menu .ui-menu__row')];
      if (rows.length) return rows.map(e => ({ el: e, label: (e.querySelector('.compact-agent-history-react-menu-label, .ui-menu__item-content') || e).innerText.trim().split('\n')[0].slice(0, 80), checked: e.getAttribute('aria-checked') === 'true' || /\b(selected|active|current)\b/.test(e.className) }));
      return [...document.querySelectorAll('.quick-input-widget .monaco-list-row')].map(e => ({ el: e, label: (e.getAttribute('aria-label') || e.innerText).trim().split('\n')[0].slice(0, 80), checked: e.classList.contains('focused') }));
    },
  };

  const menuItems = kind => (MENU_ITEMS[kind]?.() || []).filter(x => {
    if (!x.label) return false;
    if (vis(x.el)) return true;
    const menu = x.el.closest('.ui-menu, [role=menu]');
    return !!(menu && vis(menu) && (x.el.innerText || '').trim());
  }).map(({ el, ...rest }) => rest);

  const menuOpen = () => [...document.querySelectorAll('.ui-menu, .composer-unified-context-menu-item, .composer-history-hover-menu')].some(vis) || !!devinModelMenu() || !!fusionPanel();
  const modelListRow = () => [...document.querySelectorAll('[role=menuitem]')].find(el => vis(el) && /^Model\b/.test(normLabel(el.innerText)));
  const modelListTrigger = () => {
    const e = modelListRow();
    return e ? center(e) : null;
  };
  const clickModelListTrigger = () => {
    const e = modelListRow();
    if (!e) return false;
    e.click();
    return true;
  };

  // Model parameters (context size, effort, fast…) live in a per-model submenu behind its "Edit" button.
  const maxToggle = () => {
    const t = [...document.querySelectorAll('[data-testid=max-mode-toggle]')].find(vis);
    return t ? { ...center(t), on: t.getAttribute('aria-checked') === 'true' } : null;
  };
  const modelTarget = (id, part) => {
    const row = [...document.querySelectorAll('[data-testid=model-picker-menu] .ui-menu__row')].find(e => e.dataset.testid === id);
    if (!row) return null;
    row.scrollIntoView({ block: 'nearest' });
    if (part !== 'edit') return center(row);
    const b = row.querySelector('[data-testid=parameter-edit-btn]');
    return b && vis(b) ? center(b) : null;
  };
  const paramRows = () => {
    const menu = [...document.querySelectorAll('[data-testid=parameter-submenu]')].find(vis);
    if (!menu) return null;
    return [...menu.querySelectorAll('.ui-menu__section')].map(s => ({
      title: s.querySelector('.ui-menu__section-title')?.innerText.trim() || '',
      rows: [...s.querySelectorAll('.ui-menu__row, .ui-menu__toggle-row')].filter(vis).map(r => {
        const toggle = r.matches('.ui-menu__toggle-row');
        return { el: r, label: (r.querySelector('.ui-menu__item-content') || r).innerText.trim(), toggle, checked: toggle ? r.getAttribute('aria-checked') === 'true' : !!r.querySelector('.ui-model-picker__param-check') };
      }),
    }));
  };
  const modelParams = () => paramRows()?.map(s => ({ title: s.title, items: s.rows.map(({ el, ...rest }) => rest) })) || null;
  const paramTarget = (title, label) => {
    const row = paramRows()?.find(s => s.title === title)?.rows.find(r => r.label === label);
    return row ? center(row.el) : null;
  };

  const menuItem = (kind, label) => {
    const hit = (MENU_ITEMS[kind]?.() || []).find(x => vis(x.el) && normLabel(x.label) === normLabel(label));
    if (!hit) return null;
    hit.el.scrollIntoView({ block: 'nearest' });
    return center(hit.el);
  };

  // Returns the button's on-screen center so the click goes through real mouse events.
  const locate = (item, n) => {
    const panel = findPanel();
    if (!panel) return null;
    const root = item === 'g' ? panel : itemByKey(panel, item);
    if (!root) return null;
    const list = item === 'g' ? buttonsIn(panel, true).filter(x => !inItem(x.el) && !inQn(x.el)) : buttonsIn(root, false);
    const b = list[n]?.el;
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };

  // Devin scrolls a `.cascade-scrollbar` ancestor of the transcript log, not the log itself.
  const devinScroller = () => {
    const log = devinLog();
    if (!log) return null;
    let p = log;
    while (p && p !== document.body) {
      const st = getComputedStyle(p);
      if ((st.overflowY === 'auto' || st.overflowY === 'scroll') && p.scrollHeight > p.clientHeight) return p;
      p = p.parentElement;
    }
    return log;
  };
  const panelRect = () => {
    // findPanel's fallback can climb to Devin's whole virtualized log (taller than
    // the screen); the wheel must land inside the visible scroll container instead.
    const p = devinLog() ? devinScroller() : findPanel();
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height].map(Math.round);
  };

  // Cheap per-window check for notifications: is the Agent running, and is it waiting on a button?
  // "Run in background" shows up on any command running longer than ~5 s; it is not a request for approval.
  const WAIT = /^(?!.*(background|后台))(run|allow|accept|approve|continue|yes\b|运行|允许|接受|批准|继续)/i;
  const agentState = () => {
    const panel = findPanel();
    if (!panel) return null;
    const busy = isBusy();
    const items = topItems(panel);
    let waiting = null, waitingText = '';
    for (const el of items.slice(-3)) {
      const labels = buttonsIn(el, false).map(x => x.label).filter(l => WAIT.test(l));
      if (labels.length) { waiting = `${itemKey(el)}:${labels.join('/')}`; waitingText = summary(el); }
    }
    const global = buttonsIn(panel, true).filter(x => !inItem(x.el) && !inQn(x.el) && WAIT.test(x.label)).map(x => x.label);
    if (!waiting && global.length) { waiting = `g:${global.join('/')}`; waitingText = global.join(' / '); }
    const qs = questions();
    if (qs?.list.length) {
      const text = qs.list.map(q => q.text).join(' / ');
      waiting = `q:${text.slice(0, 120)}`;
      waitingText = text;
    }
    const lastReply = [...items].reverse().find(el => el.matches('[data-message-kind="assistant"]') || el.querySelector('[data-message-kind="assistant"]'));
    const last = lastReply ? lastReply.innerText.trim().replace(/\s+/g, ' ').slice(0, 160) : '';
    return { busy, waiting, waitingText, last };
  };

  // Cursor Agents window: the left sidebar lists conversations as row:<agent id>.
  const DEVIN_NAV = new Set(['New session', 'Sessions', 'Review', 'Automations', 'Security', 'Wiki', 'Cloud settings']);
  const agentList = () => {
    const active = document.querySelector('[data-glass-agent-id]')?.getAttribute('data-glass-agent-id') || '';
    const cursor = [...document.querySelectorAll('[data-sidebar-item-key^="row:"]')].filter(vis).map(row => {
      const id = row.getAttribute('data-sidebar-item-key').slice(4);
      const title = (row.querySelector('.ui-sidebar-menu-button-content .ui-text') || row).innerText.trim().split('\n')[0];
      const group = row.closest('[data-sidebar-group]')?.querySelector('[data-sidebar-group-label]')?.innerText.trim() || '';
      return {
        id,
        title: title.slice(0, 80),
        group,
        current: id === active || !!row.querySelector('[data-active="true"]'),
        running: !!row.querySelector('.ui-dot-grid-loader'),
      };
    }).filter(a => a.id && a.title);
    if (cursor.length) return cursor;
    // Devin sessions live in the same sidebar as New session / Sessions. The label is the id.
    return [...document.querySelectorAll('li[data-slot="sidebar-menu-item"]')].filter(vis).map(li => {
      const btn = [...li.querySelectorAll('button[aria-label]')].find(vis);
      const title = (btn?.getAttribute('aria-label') || '').trim();
      if (!title || DEVIN_NAV.has(title)) return null;
      const slot = li.querySelector('[data-slot="sidebar-menu-button"]');
      return {
        id: title.slice(0, 180),
        title: title.slice(0, 80),
        group: '',
        current: slot?.getAttribute('data-active') === 'true',
        running: false,
      };
    }).filter(Boolean);
  };
  const agentTarget = id => {
    const row = [...document.querySelectorAll('[data-sidebar-item-key]')].find(e => e.getAttribute('data-sidebar-item-key') === `row:${id}`);
    if (row && vis(row)) {
      row.scrollIntoView({ block: 'nearest' });
      const hit = row.querySelector('.ui-sidebar-menu-button-content') || row.querySelector('[data-sidebar-menu-button]') || row;
      return center(hit);
    }
    const btn = [...document.querySelectorAll('li[data-slot="sidebar-menu-item"] button[aria-label]')].find(e => vis(e) && e.getAttribute('aria-label') === id);
    if (!btn) return null;
    btn.scrollIntoView({ block: 'nearest' });
    return center(btn);
  };

  // Integrated terminals: the Agents window puts them in editor tabs (aria-controls contains terminal-).
  // Older editor layouts use .terminal-tab. The xterm canvas itself is only used for the crop rectangle.
  const terminalEntries = () => {
    const glass = [...document.querySelectorAll('.ui-tab-system-tab')].filter(t => vis(t) && /terminal-/i.test(t.getAttribute('aria-controls') || ''));
    if (glass.length) {
      return glass.map(tab => {
        const id = (/terminal-([0-9a-f-]{8,})/i.exec(tab.getAttribute('aria-controls') || '') || [])[1] || '';
        const title = (tab.innerText || '').trim().split('\n')[0].replace(/\s+/g, ' ').slice(0, 80);
        return {
          id,
          title: title || '终端',
          current: tab.getAttribute('aria-selected') === 'true' || tab.getAttribute('data-active') === 'true',
          tab,
          close: [...tab.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '').startsWith('Close')),
        };
      }).filter(t => t.id);
    }
    const classic = [...document.querySelectorAll('.terminal-tabs-list .terminal-tab')].filter(vis);
    if (classic.length) return classic.map((tab, i) => ({
      id: tab.id || `classic-${i}`,
      title: (tab.querySelector('.label-name, a') || tab).innerText.trim().split('\n')[0].slice(0, 80) || `终端 ${i + 1}`,
      current: tab.classList.contains('active') || tab.getAttribute('aria-selected') === 'true',
      tab,
      close: tab.querySelector('[aria-label="Kill Terminal"], [aria-label^="Kill"]'),
    }));
    // Devin / VS Code monaco list: rows labelled "Terminal 1 cloudflared".
    // Kill/Split action anchors exist in the row but get a size only on hover.
    const vt = [...document.querySelectorAll('[aria-label="Terminal tabs"] .monaco-list-row')].filter(vis);
    if (vt.length) return vt.map(tab => {
      const m = /^Terminal (\d+)\s*(.*)$/.exec((tab.getAttribute('aria-label') || '').trim());
      return {
        id: `term-vt${m?.[1] || vt.indexOf(tab)}`,
        title: ((m?.[2] || '').trim() || `终端 ${m?.[1] || ''}`.trim()).slice(0, 80),
        current: tab.getAttribute('aria-selected') === 'true',
        tab,
        close: tab.querySelector('a.action-label[aria-label^="Kill"], [aria-label^="Kill"]'),
      };
    });
    const solo = [...document.querySelectorAll('.terminal-wrapper.active .xterm')].filter(vis);
    if (solo.length === 1) return [{ id: 'term-solo', title: '终端', current: true, tab: solo[0], close: null }];
    return [];
  };
  const terminalList = () => terminalEntries().map(({ id, title, current }) => ({ id, title, current }));
  const terminalById = id => terminalEntries().find(t => t.id === id);
  const terminalPoint = el => {
    const r = el.getBoundingClientRect();
    return { x: r.x + Math.min(28, r.width / 3), y: r.y + r.height / 2 };
  };
  const terminalTarget = id => {
    const t = terminalById(id);
    if (!t) return null;
    t.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return terminalPoint(t.tab);
  };
  const terminalCloseTarget = id => {
    const b = terminalById(id)?.close;
    return b && vis(b) ? center(b) : null;
  };
  // The xterm canvas to show: when several .terminal-wrapper are visible (Devin keeps a
  // shared session terminal next to the panel one), pick the one inside the same pane as
  // the "Terminal tabs" list.
  const terminalEl = () => {
    const sel = '.terminal-wrapper.active .xterm, .terminal.xterm';
    const tabs = document.querySelector('[aria-label="Terminal tabs"]');
    if (tabs) {
      const pane = tabs.closest('.pane') || tabs.parentElement;
      const inPane = [...(pane?.querySelectorAll(sel) || [])].find(vis);
      if (inPane) return inPane;
    }
    return [...document.querySelectorAll(sel)].find(vis) || null;
  };
  const terminalRect = () => {
    const el = terminalEl();
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height].map(Math.round);
  };
  const terminalFocus = () => {
    const el = terminalEl();
    return el ? center(el) : null;
  };
  const newTerminalDirect = () => {
    const b = [...document.querySelectorAll('[aria-label="New Terminal"], [aria-label^="New Terminal"]')].find(vis);
    return b ? center(b) : null;
  };
  const newTerminalMenu = () => {
    const buttons = [...document.querySelectorAll('button')].filter(e => vis(e) && e.getAttribute('aria-label') === 'Open new tab menu');
    if (!buttons.length) return null;
    const active = terminalEntries().find(t => t.current)?.tab;
    if (active) {
      const x = active.getBoundingClientRect().x;
      buttons.sort((a, b) => Math.abs(a.getBoundingClientRect().x - x) - Math.abs(b.getBoundingClientRect().x - x));
    }
    return center(buttons[0]);
  };
  const labeled = name => [...document.querySelectorAll('button, [role=button]')].find(e => vis(e) && (e.getAttribute('aria-label') || '') === name);
  const onScreen = e => {
    const b = e.getBoundingClientRect();
    return b.width > 2 && b.height > 2 && b.bottom > 0 && b.right > 0 && b.top < innerHeight && b.left < innerWidth;
  };
  // The gear's label flips to "Close Settings". Devin opens a settings editor tab instead.
  const settingsOpen = () => {
    if ([...document.querySelectorAll('button, [role=button]')].some(e => onScreen(e) && e.getAttribute('aria-label') === 'Close Settings')) return true;
    if ([...document.querySelectorAll('input')].some(e => onScreen(e) && /search settings/i.test(e.getAttribute('aria-label') || ''))) return true;
    const tab = [...document.querySelectorAll('.tab.active')].find(onScreen);
    return /settings/i.test(tab?.getAttribute('aria-label') || tab?.innerText || '');
  };
  const clickSettingsButton = () => {
    const b = [...document.querySelectorAll('button, [role=button]')].find(e => onScreen(e) && e.getAttribute('aria-label') === 'Settings');
    if (!b) return false;
    b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    b.click();
    return true;
  };
  const clickCloseSettings = () => {
    const b = [...document.querySelectorAll('button, [role=button]')].find(e => onScreen(e) && e.getAttribute('aria-label') === 'Close Settings');
    if (b) { b.click(); return 'button'; }
    const tab = [...document.querySelectorAll('.tab.active')].find(onScreen);
    if (/settings/i.test(tab?.getAttribute('aria-label') || '')) return 'tab';
    return '';
  };
  const openSettingsTarget = () => { const b = labeled('Settings'); return b ? center(b) : null; };
  const closeSettingsTarget = () => { const b = labeled('Close Settings'); return b ? center(b) : null; };
  const settingsPanel = () => {
    const close = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Close Settings');
    if (!close || !vis(close)) return null;
    let p = close;
    for (let i = 0; i < 16 && p; i++) {
      const box = p.getBoundingClientRect();
      if ((p.innerText || '').includes('Plan & Usage') && box.width > 300 && box.height > 200) return p;
      p = p.parentElement;
    }
    return null;
  };
  const readSettings = () => {
    const root = settingsPanel();
    if (!root) return null;
    const sections = [];
    for (const sec of root.querySelectorAll('.ui-section')) {
      const title = (sec.querySelector('h1, h2, h3')?.innerText || '').trim();
      const items = [];
      for (const entry of sec.querySelectorAll('.ui-field-group__entry')) {
        const sw = entry.querySelector('[role=switch]');
        if (!sw) continue;
        const lines = (entry.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
        if (!lines[0]) continue;
        items.push({ label: lines[0].slice(0, 80), detail: (lines[1] || '').slice(0, 140), on: sw.getAttribute('aria-checked') === 'true' });
      }
      if (title && items.length) sections.push({ title, items });
    }
    return sections;
  };
  const settingTarget = label => {
    const root = settingsPanel();
    if (!root) return null;
    for (const entry of root.querySelectorAll('.ui-field-group__entry')) {
      const first = (entry.innerText || '').split('\n').map(s => s.trim()).filter(Boolean)[0];
      if (first !== label) continue;
      const sw = entry.querySelector('[role=switch]');
      return sw && vis(sw) ? center(sw) : null;
    }
    return null;
  };
  const DEVIN_SETTINGS_NAV = /^(General|Plan information|Extensions|Agents|Configuration|Customizations|User interface|Devin Tab|Shortcuts|Advanced)$/;
  const devinSettingsNav = () => [...document.querySelectorAll('button')].filter(e => onScreen(e) && DEVIN_SETTINGS_NAV.test((e.innerText || '').trim())).map(e => (e.innerText || '').trim());
  const devinSettingsClick = name => {
    const b = [...document.querySelectorAll('button')].find(e => onScreen(e) && (e.innerText || '').trim() === name);
    if (!b) return false;
    b.click();
    return true;
  };
  const devinSettingsCards = () => {
    const root = [...document.querySelectorAll('.editor-instance')].find(onScreen);
    if (!root) return [];
    const seen = new Set();
    const items = [];
    for (const e of root.querySelectorAll('div')) {
      const cls = (e.className || '').toString();
      if (!cls.includes('rounded-[10px]') || !onScreen(e)) continue;
      if ([...e.querySelectorAll('div')].some(c => (c.className || '').toString().includes('rounded-[10px]') && onScreen(c))) continue;
      const lines = (e.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
      const label = (lines[0] || '').slice(0, 80);
      if (label.length < 3 || seen.has(label)) continue;
      seen.add(label);
      items.push({ label, detail: lines.slice(1, 3).join(' · ').slice(0, 140), toggle: false });
    }
    return items;
  };
  const usageNavTarget = () => {
    const root = settingsPanel();
    if (!root) return null;
    const e = [...root.querySelectorAll('button, [role=button]')].find(el => vis(el) && (el.innerText || '').trim() === 'Plan & Usage');
    return e ? center(e) : null;
  };
  const readUsage = () => {
    const root = settingsPanel();
    if (!root) return null;
    const nav = new Set(['Back', 'General', 'Profile', 'Appearance', 'Plan & Usage', 'Agents', 'Cloud Agents', 'Models', 'Git & PRs', 'Worktrees', 'Browser & Network', 'Tab', 'Code Intelligence', 'Beta', 'Docs', 'Getting Started']);
    const candidates = [...root.querySelectorAll('div, section')].filter(e => (e.innerText || '').includes('CURRENT PLAN'));
    candidates.sort((a, b) => a.innerText.length - b.innerText.length);
    const best = candidates.find(e => /Included in|On-Demand|Cursor Models/.test(e.innerText) && !(e.innerText || '').split('\n').some(l => l.trim() === 'Agents'))
      || candidates[0];
    if (!best) return { lines: [] };
    const bars = [...root.querySelectorAll('[role=progressbar]')].filter(vis).map(e => {
      const now = Number(e.getAttribute('aria-valuenow'));
      const max = Number(e.getAttribute('aria-valuemax')) || 100;
      const label = (e.getAttribute('aria-label') || '').trim();
      if (!label || /^loading\b/i.test(label) || !Number.isFinite(now) || !max) return null;
      return { label: label.slice(0, 40), pct: Math.max(0, Math.min(100, Math.round(now / max * 100))) };
    }).filter(Boolean);
    if (!best) return { lines: [], bars };
    const lines = (best.innerText || '').split('\n').map(s => s.trim()).filter(s => s && !nav.has(s)).slice(0, 32);
    return { lines: lines.map(l => l.slice(0, 180)), bars };
  };

  const newTerminalItem = () => {
    const rows = [...document.querySelectorAll('[role=listbox] [role=option], [role=listbox] button, [role=menu] [role=menuitem]')];
    const hit = rows.find(e => vis(e) && /^Terminal\b/.test((e.innerText || e.getAttribute('aria-label') || '').trim()));
    return hit ? center(hit) : null;
  };

  // Full xterm buffer, including scrollback still held by the terminal (not the canvas pixels).
  // Colors are packed as 0 = default, 1–256 = palette index + 1, negative = -(rgb + 1).
  const packColor = (cell, fg) => {
    if (fg ? cell.isFgDefault() : cell.isBgDefault()) return 0;
    if (fg ? cell.isFgRGB() : cell.isBgRGB()) return -((((fg ? cell.getFgColor() : cell.getBgColor()) >>> 0) & 0xffffff) + 1);
    let n = fg ? cell.getFgColor() : cell.getBgColor();
    if (n < 0) return 0;
    if (fg && cell.isBold() && n < 8) n += 8;
    return (n & 255) + 1;
  };
  const cellFlags = cell => (cell.isBold() ? 1 : 0) | (cell.isItalic() ? 2 : 0) | (cell.isUnderline() ? 4 : 0) | (cell.isDim() ? 8 : 0) | (cell.isInverse() ? 16 : 0);
  // The shell prompt stays on the cursor line; history recall only replaces the command after it.
  const commandFromPrompt = line => {
    const m = /^(?:.*?(?:[$%#]|[❯➜]))\s(.*)$/.exec(line);
    if (m) return m[1].replace(/\s+$/, '');
    const fish = /^>\s(.*)$/.exec(line);
    if (fish) return fish[1].replace(/\s+$/, '');
    return null;
  };
  const terminalCommand = () => {
    const host = document.querySelector('.terminal-wrapper.active .xterm-wrapper') || document.querySelector('.xterm-wrapper');
    const term = host?.xterm;
    const buf = term?.buffer?.active;
    if (!buf) return null;
    const logical = start => {
      let text = '';
      for (let i = start; i < buf.length; i++) {
        const row = buf.getLine(i);
        if (!row) break;
        if (i > start && !row.isWrapped) break;
        text += row.translateToString(true);
        if (!buf.getLine(i + 1)?.isWrapped) break;
      }
      return text.replace(/\s+$/, '');
    };
    let y = buf.baseY + buf.cursorY;
    while (y > 0 && buf.getLine(y)?.isWrapped) y--;
    const here = commandFromPrompt(logical(y));
    if (here != null) return here;
    if (y > 0) {
      let py = y - 1;
      while (py > 0 && buf.getLine(py)?.isWrapped) py--;
      if (commandFromPrompt(logical(py)) === '') return logical(y);
    }
    return null;
  };
  const terminalDump = prev => {
    const host = document.querySelector('.terminal-wrapper.active .xterm-wrapper') || document.querySelector('.xterm-wrapper');
    let term = host?.xterm;
    // Devin: each .terminal-wrapper carries the xterm.js instance as its own `xterm` property.
    if (!term && document.querySelector('[aria-label="Terminal tabs"]')) term = terminalEl()?.closest('.terminal-wrapper')?.xterm;
    const buf = term?.buffer?.active;
    if (!buf) return null;
    const cursorY = buf.baseY + buf.cursorY;
    const lines = [];
    let cursorX = buf.cursorX;
    for (let y = 0; y < buf.length; y++) {
      const row = buf.getLine(y);
      if (!row) { lines.push(''); continue; }
      let text = '';
      const spans = [];
      let run = null;
      let col = 0;
      for (let x = 0; x < term.cols; x++) {
        const cell = row.getCell(x);
        if (!cell || cell.getWidth() === 0) continue;
        const ch = cell.getChars() || ' ';
        const f = packColor(cell, true);
        const b = packColor(cell, false);
        const fl = cellFlags(cell);
        if (!run || run.f !== f || run.b !== b || run.fl !== fl) {
          run = { i: text.length, f, b, fl };
          spans.push([run.i, f, b, fl]);
        }
        if (y === cursorY && col === buf.cursorX) cursorX = text.length;
        text += ch;
        col += cell.getWidth();
      }
      text = text.replace(/\s+$/, '');
      if (y === cursorY && cursorX > text.length) cursorX = text.length;
      const styled = spans.some(([, f, b, fl]) => f || b || fl);
      lines.push(styled ? { t: text, s: spans.filter(s => s[0] <= text.length) } : text);
    }
    let end = lines.length;
    while (end > cursorY + 1 && end > 0 && lines[end - 1] === '') end--;
    const body = { lines: lines.slice(0, end), cursor: [cursorY, cursorX] };
    const raw = JSON.stringify(body);
    let h = 2166136261;
    for (let i = 0; i < raw.length; i++) h = Math.imul(h ^ raw.charCodeAt(i), 16777619);
    const hash = (h >>> 0).toString(36);
    return prev === hash ? { hash } : { hash, ...body };
  };

  const quickOpenRows = () => {
    const w = document.querySelector('.quick-input-widget');
    if (!w || !vis(w)) return null;
    return [...w.querySelectorAll('.monaco-list-row')].filter(vis).map(e => ({
      name: e.querySelector('.label-name')?.innerText.trim() || '',
      dir: e.querySelector('.label-description')?.innerText.trim() || '',
    }));
  };

  return { extract, locate, panelRect, control, menuItems, menuItem, quickOpenRows, agentList, agentTarget, agentState, queueTarget, stopTarget, focusQueueEdit,
    terminalList, terminalTarget, terminalCloseTarget, terminalRect, terminalFocus, newTerminalDirect, newTerminalMenu, newTerminalItem, terminalDump, terminalCommand, modelListTrigger,
    settingsOpen, clickSettingsButton, clickCloseSettings, openSettingsTarget, closeSettingsTarget, readSettings, settingTarget, usageNavTarget, readUsage,
    clickControl, clickModelListTrigger, devinSettingsNav, devinSettingsClick, devinSettingsCards,
    fusionConfig, clickFusionCombo, clickFusionFast, fusionOptionItems, fusionOptionTarget,
    menuOpen, maxToggle, modelTarget, modelParams, paramTarget, subTarget, activeChatTab, tabTarget, hasComposer, filesState, fileTarget, questionTarget,
    closedThinkingIndexes, clickThinking, closeThinkingIfOpen, thoughtIndexFor, setTasksOpen, devinQueueTarget,
    devinSession, devinTabTarget, devinTabCloseTarget, devinQuestions, thoughtState, setThoughtOpen, thoughtBodyText, devinQueued, devinQueueClearTarget, devinQueueCount, revertTarget, revertDialog, revertDialogButton, revertState, devinSurface, surfaceTarget, transcriptVisible, sessionSearchTarget, sessionPickerRows, sessionPickerTarget };
}

const helpersCall = call => `(${pageHelpers.toString()})().${call}`;

const CURSOR_BIN = fs.existsSync('/usr/share/cursor/bin/cursor') ? '/usr/share/cursor/bin/cursor' : 'cursor';

function safeHomePath(input) {
  const home = fs.realpathSync(os.homedir());
  const target = input ? path.resolve(String(input)) : home;
  let real;
  try { real = fs.realpathSync(target); }
  catch { throw new Error('找不到这个文件夹'); }
  if (real !== home && !real.startsWith(home + path.sep)) throw new Error('只能打开家目录里的文件夹');
  return { home, real };
}

function projectList(dir) {
  const { home, real } = safeHomePath(dir);
  const recent = [];
  const seen = new Set();
  if (!dir) {
    for (const w of workspaces()) {
      if (w.host) continue;
      let root;
      try { root = fs.realpathSync(w.root); } catch { continue; }
      if (seen.has(root)) continue;
      seen.add(root);
      recent.push({ name: path.basename(root) || root, path: root });
      if (recent.length >= 12) break;
    }
  }
  let names = [];
  try {
    names = fs.readdirSync(real, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name)
      .sort((a, b) => a.localeCompare(b, 'zh'))
      .slice(0, 200);
  } catch { throw new Error('读不了这个文件夹'); }
  return {
    recent,
    browsing: Boolean(dir),
    path: real,
    parent: real === home ? null : path.dirname(real),
    dirs: names.map(name => ({ name, path: path.join(real, name) })),
  };
}

const DEVIN_BIN = fs.existsSync('/usr/share/devin-desktop/devin-desktop') ? '/usr/share/devin-desktop/devin-desktop' : 'devin-desktop';

function openFolder(folder, app) {
  const { real } = safeHomePath(folder);
  const bin = app === 'devin' ? DEVIN_BIN : CURSOR_BIN;
  const child = spawn(bin, ['-r', real], { detached: true, stdio: 'ignore' });
  child.unref();
  return real;
}

class Session {
  constructor(client, deviceId) {
    this.client = client;
    this.deviceId = deviceId;
    // The phone reports when the app goes to the background; notifications skip the window it is looking at.
    this.visible = true;
    this.cdp = null;
    this.viewport = { w: 1000, h: 800 };
    this.screencast = { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 2400 };
    this.awaitingAck = null;
    this.lastFrameAt = 0;
    this.lastHash = '';
    this.mode = 'chat';
    this.lastChat = '';
    this.thinking = new Map();
    this.thinkingTried = new Map();
    this.tasksTried = new Map();
    this.keptThink = new Map();
    this.devinHist = new Map();
    this.app = 'cursor';
    this.lastPanel = '';
    this.lastBusy = null;
    this.lastTermHash = undefined;
    this.idleTimer = setInterval(() => this.pollIfIdle(), 2000);
  }

  async setMode(mode) {
    this.mode = mode === 'screen' || mode === 'terminal' ? mode : 'chat';
    clearInterval(this.chatTimer);
    clearInterval(this.termTimer);
    if (!this.cdp) return;
    if (this.mode === 'chat') {
      await this.stopScreencast();
      this.lastChat = '';
      this.chatTimer = setInterval(() => this.pollChat().catch(() => {}), 700);
      await this.pollChat();
    } else if (this.mode === 'terminal') {
      await this.stopScreencast();
      this.termImg = '';
      this.lastTermHash = undefined;
      await this.pollTerminal();
      this.termTimer = setInterval(() => this.pollTerminal().catch(() => {}), 700);
    } else {
      this.lastPanel = '';
      await this.sendPanelRect();
      await this.snapshot(true);
      await this.startScreencast();
    }
  }

  thinkingBody(it) {
    return (it?.t || '').split('\n').slice(1).join('\n');
  }

  thinkingTitle(it) {
    return (it?.t || '').split('\n')[0] || '思考';
  }

  // The live block's id often changes when the turn finishes. Keep that text on the newest block.
  noteLiveThinking(it) {
    const body = this.thinkingBody(it);
    if (!it?.live || !body) return;
    const prev = this.latestThink?.id === it.i ? (this.latestThink.body || '') : '';
    this.latestThink = { id: it.i, body: body.length >= prev.length ? body : prev, at: Date.now() };
  }

  rememberThinking(chat) {
    for (const it of chat?.items || []) {
      if (it.k !== 'thinking') continue;
      const body = this.thinkingBody(it);
      const prev = this.thinking.get(it.i)?.body || '';
      const next = body.length >= prev.length ? body : prev;
      if (next) this.thinking.set(it.i, { body: next });
      this.noteLiveThinking(it);
    }
    const keep = this.latestThink?.id;
    while (this.thinking.size > 12) {
      const oldest = this.thinking.keys().next().value;
      if (oldest === keep) {
        const saved = this.thinking.get(oldest);
        this.thinking.delete(oldest);
        this.thinking.set(oldest, saved);
        if (this.thinking.size === 1) break;
        continue;
      }
      this.thinking.delete(oldest);
    }
  }

  fillThinking(chat) {
    const thoughts = (chat?.items || []).filter(it => it.k === 'thinking');
    for (const it of thoughts) {
      const saved = this.thinking.get(it.i)?.body || '';
      const body = this.thinkingBody(it);
      if (saved.length > body.length) it.t = `${this.thinkingTitle(it)}\n${saved}`;
      this.noteLiveThinking(it);
    }
    const last = thoughts[thoughts.length - 1];
    const carried = this.latestThink;
    if (last && carried?.body && !last.live && this.thinkingBody(last).length < carried.body.length) {
      const fresh = !this.thinkingBody(last) && Date.now() - carried.at < 20000;
      if (last.i === carried.id || fresh) {
        itAssign(last, carried.body);
        this.thinking.set(last.i, { body: carried.body });
      }
    }
    // Always send the newest trace. Drop older bodies once the payload gets large.
    let used = 0;
    const budget = 80000;
    for (let i = thoughts.length - 1; i >= 0; i--) {
      const it = thoughts[i];
      const title = this.thinkingTitle(it);
      const body = this.thinkingBody(it);
      const newest = i === thoughts.length - 1;
      if (!newest && body && used + body.length > budget) {
        it.t = title;
        continue;
      }
      used += body.length;
      delete it.h;
    }
    function itAssign(it, body) {
      it.t = `${(it.t || '').split('\n')[0] || '思考'}\n${body}`;
    }
  }

  // Cursor removes a finished thinking row from the transcript. Put the text we already
  // streamed back in front of that reply. Older traces are omitted once the payload is large.
  retainThinking(chat) {
    if (!chat?.items) return;
    if (!this.keptThink) this.keptThink = new Map();
    const items = chat.items;
    let prev = null;
    for (const it of items) {
      if (it.k !== 'thinking') { prev = it.i; continue; }
      const body = this.thinkingBody(it);
      const old = this.keptThink.get(it.i);
      const best = body.length >= (old?.body || '').length ? body : (old?.body || '');
      let title = this.thinkingTitle(it);
      if (/^thinking$/i.test(title) && old?.title && !/^thinking$/i.test(old.title)) title = old.title;
      this.keptThink.set(it.i, { i: it.i, title, body: best, after: prev, at: Date.now() });
    }
    const present = new Set(items.map(it => it.i));
    let missing = [...this.keptThink.values()].filter(k => k.body && !present.has(k.i) && k.after && items.some(it => it.i === k.after));
    missing.sort((a, b) => b.at - a.at);
    let used = items.filter(it => it.k === 'thinking').reduce((n, it) => n + this.thinkingBody(it).length, 0);
    const allow = new Set();
    for (const k of missing) {
      if (!allow.size || used + k.body.length <= 80000) {
        allow.add(k.i);
        used += k.body.length;
      }
    }
    missing = missing.filter(k => allow.has(k.i)).sort((a, b) => a.at - b.at);
    const placed = new Map();
    for (const k of missing) {
      const at = items.findIndex(it => it.i === k.after);
      if (at < 0) continue;
      const n = placed.get(k.after) || 0;
      const title = /^thinking$/i.test(k.title) ? 'Thought' : k.title;
      items.splice(at + 1 + n, 0, { i: k.i, k: 'thinking', t: `${title}\n${k.body}` });
      placed.set(k.after, n + 1);
    }
    if (this.keptThink.size > 24) {
      const ranked = [...this.keptThink.entries()].sort((a, b) => a[1].at - b[1].at);
      for (const [id] of ranked) {
        if (this.keptThink.size <= 16) break;
        if (id === this.latestThink?.id) continue;
        this.keptThink.delete(id);
      }
    }
  }

  // Devin sessions: everything remembered from a transcript (rows, thought bodies, task lists) belongs to ONE
  // session. When the desktop shows another session (a tab was clicked there, the phone switched, a new
  // session started) park this session's state under its title and load the other's, never merge them.
  // A rename (the title changed while the set of tabs stayed the same) keeps the state.
  syncSession(chat) {
    const sess = chat?.session;
    if (this.app !== 'devin' || !sess) return;
    const titles = (sess.tabs || []).map(t => t.title);
    const prevTitles = this.sessTitles || [];
    this.sessTitles = titles;
    if (this.curSession === undefined || this.curSession === sess.key) { this.curSession = sess.key; return; }
    const renamed = titles.length > 0 && titles.length === prevTitles.length
      && !titles.includes(this.curSession) && !prevTitles.includes(sess.key);
    if (renamed) { this.curSession = sess.key; return; }
    if (!this.sessStore) this.sessStore = new Map();
    const FIELDS = ['devinHist', 'thinking', 'thinkingTried', 'keptThink', 'tasksTried', 'thoughtFails', 'latestThink'];
    const fresh = () => ({ devinHist: new Map(), thinking: new Map(), thinkingTried: new Map(), keptThink: new Map(), tasksTried: new Map(), thoughtFails: new Map(), latestThink: null });
    const saved = {};
    for (const f of FIELDS) saved[f] = this[f];
    this.sessStore.set(this.curSession, saved);
    const next = this.sessStore.get(sess.key) || fresh();
    for (const f of FIELDS) this[f] = next[f];
    while (this.sessStore.size > 24) this.sessStore.delete(this.sessStore.keys().next().value);
    this.curSession = sess.key;
    this.lastChat = '';
    this.thoughtPoll = 0;
  }

  // Devin virtualizes its transcript: only rows near the viewport stay mounted, so a poll
  // sees a sliding window of acp-indexed rows. Merge each window into per-session history
  // keyed by the stable acp ids; remembered rows keep their last seen content. Sorted by
  // acp index (a thinking item `acpN:think` travels with row N) and capped at ~1500 items.
  mergeDevinHistory(chat) {
    if (!chat?.items) return;
    if (!chat.items.some(it => it.src === 'devin') && !(this.devinHist?.size && !chat.items.length)) return;
    if (!this.devinHist) this.devinHist = new Map();
    const hist = this.devinHist;
    const num = id => {
      const m = /^acp(\d+)/.exec(id || '');
      return m ? Number(m[1]) : -1;
    };
    const mounted = chat.items.map(it => num(it.i)).filter(n => n >= 0);
    const minM = mounted.length ? Math.min(...mounted) : Infinity;
    const maxM = mounted.length ? Math.max(...mounted) : -1;
    if (hist.size && mounted.length) {
      const known = [...hist.keys()].map(num).filter(n => n >= 0);
      if (known.length) {
        const minR = Math.min(...known), maxR = Math.max(...known);
        const overlap = mounted.some(n => n >= minR && n <= maxR);
        // A new session restarts indexes at 0; sliding to a range entirely below what we
        // remember means the window was switched without an attach reset.
        if (maxM < minR || (!overlap && minM === 0)) hist.clear();
      }
    }
    // Sticky thoughts: a remounted collapsed thought has no body; keep the body we already have.
    for (const it of chat.items) {
      const next = it.src === 'devin' ? it : { ...it, src: 'devin' };
      const prev = hist.get(it.i);
      const pb = prev?.k === 'thinking' ? this.thinkingBody(prev) : '';
      if (next.k === 'tasks' && !next.items && prev?.items && prev.total === next.total) hist.set(it.i, { ...next, items: prev.items });
      else hist.set(it.i, next.k === 'thinking' && pb.length > this.thinkingBody(next).length
        ? { ...next, t: `${this.thinkingTitle(next)}\n${pb}` }
        : next);
    }
    const merged = [...hist.values()].sort((a, b) => num(a.i) - num(b.i));
    while (merged.length > 1500) hist.delete(merged.shift().i);
    // Thought bodies are kept up to ~2 MB in total; the oldest drop to title-only first.
    let kept = 0;
    for (const it of merged.slice().reverse()) {
      if (it.k !== 'thinking') continue;
      const n = this.thinkingBody(it).length;
      if (!n) continue;
      if (kept + n > 2000000) hist.set(it.i, { ...it, t: this.thinkingTitle(it) });
      else kept += n;
    }
    // Payload: newest thoughts (12 or 80 KB) carry their body; older ones are title-only with more:true
    // and their body is requested on demand with {t:'thought', i}.
    let used = 0, count = 0;
    const full = [...hist.values()].sort((a, b) => num(a.i) - num(b.i));
    const sent = new Set();
    for (const it of full.slice().reverse()) {
      if (it.k !== 'thinking') continue;
      const n = this.thinkingBody(it).length;
      if (!n) continue;
      if (count < 12 && used + n <= 80000) { used += n; count++; sent.add(it.i); }
    }
    chat.items = full.map(it => it.k === 'thinking' && this.thinkingBody(it) && !sent.has(it.i)
      ? { ...it, t: this.thinkingTitle(it), more: true }
      : it);
    const known = [...hist.keys()].map(num).filter(n => n >= 0);
    const floor = known.length ? Math.min(...known) : minM;
    chat.earlier = floor > 0;
  }

  async pollChat() {
    if (!this.cdp || this.polling) return;
    this.polling = true;
    try {
      let chat = await this.cdp.evaluate(helpersCall('extract()'));
      this.syncSession(chat);
      const liveClosed = (chat?.items || []).some(it => it.k === 'thinking' && it.live && !(it.t || '').includes('\n'));
      if (liveClosed) {
        const idxs = await this.cdp.evaluate(helpersCall(`closedThinkingIndexes('live')`));
        if (idxs?.length) {
          await this.cdp.evaluate(helpersCall(`clickThinking(${JSON.stringify(idxs)})`));
          await new Promise(r => setTimeout(r, 250));
          chat = await this.cdp.evaluate(helpersCall('extract()'));
        }
      }
      const needFinal = this.app !== 'devin' && (chat?.items || []).some(it => it.k === 'thinking' && !it.live && !(it.t || '').includes('\n') && !this.thinkingTried.has(it.i));
      if (needFinal) {
        const idxs = await this.cdp.evaluate(helpersCall(`closedThinkingIndexes('done')`));
        if (idxs?.length) {
          await this.cdp.evaluate(helpersCall(`clickThinking(${JSON.stringify(idxs)})`));
          await new Promise(r => setTimeout(r, 250));
          chat = await this.cdp.evaluate(helpersCall('extract()'));
          await this.cdp.evaluate(helpersCall(`closeThinkingIfOpen(${JSON.stringify(idxs)})`));
        }
      }
      // Devin task lists: expand a row whose checklist we have not read for its current count, read it, fold it back.
      const taskRow = (chat?.items || []).find(it => it.k === 'tasks' && !it.items && this.tasksTried.get(it.i) !== it.total);
      if (taskRow) {
        this.tasksTried.set(taskRow.i, taskRow.total);
        if (await this.cdp.evaluate(helpersCall(`setTasksOpen(${JSON.stringify(taskRow.i)}, true)`))) {
          await new Promise(r => setTimeout(r, 250));
          const opened = await this.cdp.evaluate(helpersCall('extract()'));
          await this.cdp.evaluate(helpersCall(`setTasksOpen(${JSON.stringify(taskRow.i)}, false)`));
          if (opened?.items?.some(it => it.k === 'tasks' && it.i === taskRow.i && it.items)) chat = opened;
        }
      }
      await this.captureThoughts(chat);
      this.fillThinking(chat);
      this.rememberThinking(chat);
      this.retainThinking(chat);
      this.mergeDevinHistory(chat);
      const finished = this.app === 'devin' ? [] : (chat?.items || []).filter(it => it.k === 'thinking' && !it.live);
      finished.forEach((it, i) => {
        const has = this.thinkingBody(it).length > 0;
        const newest = i === finished.length - 1;
        if (has || !newest) this.thinkingTried.set(it.i, 1);
        else {
          const n = (this.thinkTries?.get(it.i) || 0) + 1;
          if (!this.thinkTries) this.thinkTries = new Map();
          this.thinkTries.set(it.i, n);
          if (n >= 3) this.thinkingTried.set(it.i, 1);
        }
      });
      if (chat?.model === 'Fusion') {
        if (this.fusion) chat.fusion = this.fusion;
        else this.queueFusionRead();
      } else this.fusion = null;
      const json = JSON.stringify(chat);
      if (json !== this.lastChat) {
        this.lastChat = json;
        this.emit({ t: 'chat', chat });
      }
    } finally {
      this.polling = false;
    }
  }

  async pollTerminal() {
    if (!this.cdp || this.mode !== 'terminal') return;
    const dump = await this.cdp.evaluate(helpersCall(`terminalDump(${JSON.stringify(this.lastTermHash || '')})`));
    if (!dump) {
      // No readable xterm buffer (Devin uses canvas terminals): show a cropped
      // photo of the terminal rectangle instead of the "no terminal" overlay.
      const rect = await this.cdp.evaluate(helpersCall('terminalRect()'));
      const tag = rect ? 'img' : '';
      if (this.lastTermHash !== null || this.termImg !== tag) {
        this.lastTermHash = null;
        this.termImg = tag;
        this.emit({ t: 'termText', lines: null, img: !!rect });
      }
      if (rect) {
        const json = JSON.stringify(rect);
        if (json !== this.lastPanel) {
          this.lastPanel = json;
          this.emit({ t: 'panel', rect });
        }
        if (!this.casting) await this.startScreencast();
      } else if (this.casting) await this.stopScreencast();
    } else {
      this.termImg = '';
      if (this.casting) await this.stopScreencast();
      if (dump.hash !== this.lastTermHash) {
        this.lastTermHash = dump.hash;
        if (dump.lines) this.emit({ t: 'termText', lines: dump.lines, cursor: dump.cursor });
      }
    }
    const state = await this.cdp.evaluate(helpersCall('agentState()'));
    const busy = !!state?.busy;
    if (busy !== this.lastBusy) {
      this.lastBusy = busy;
      this.emit({ t: 'agentBusy', busy });
    }
  }

  async listTerminals() {
    const list = await this.cdp.evaluate(helpersCall('terminalList()'));
    this.emit({ t: 'terminals', list: list || [] });
  }

  async openTerminal(id) {
    if (!/^[\w-]{8,}$/.test(id)) throw new Error('这个终端已经不在了');
    const pos = await this.cdp.evaluate(helpersCall(`terminalTarget(${JSON.stringify(id)})`));
    if (!pos) throw new Error('这个终端已经不在了');
    await this.tapCss(pos.x, pos.y);
    this.emit({ t: 'status', ok: true, msg: '已切换终端' });
    setTimeout(() => this.pollTerminal().catch(() => {}), 300);
  }

  async closeTerminal(id) {
    if (!/^[\w-]{8,}$/.test(id)) throw new Error('这个终端已经不在了');
    if (this.app === 'devin') {
      // The kill anchor in a monaco tab row only gets a size while the row is hovered.
      const row = await this.cdp.evaluate(helpersCall(`terminalTarget(${JSON.stringify(id)})`));
      if (!row) throw new Error('这个终端已经不在了');
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y });
      await new Promise(r => setTimeout(r, 150));
    }
    const pos = await this.cdp.evaluate(helpersCall(`terminalCloseTarget(${JSON.stringify(id)})`));
    if (!pos) throw new Error('这个终端已经不在了');
    await this.tapCss(pos.x, pos.y);
    this.emit({ t: 'status', ok: true, msg: '已关闭终端' });
    setTimeout(() => this.pollTerminal().catch(() => {}), 300);
  }

  async newTerminal() {
    const direct = await this.cdp.evaluate(helpersCall('newTerminalDirect()'));
    if (direct) {
      await this.tapCss(direct.x, direct.y);
    } else {
      const menu = await this.cdp.evaluate(helpersCall('newTerminalMenu()'));
      if (!menu) throw new Error('当前窗口里找不到新建终端的按钮');
      await this.tapCss(menu.x, menu.y);
      let item = null;
      for (let i = 0; i < 10 && !item; i++) {
        await new Promise(r => setTimeout(r, 120));
        item = await this.cdp.evaluate(helpersCall('newTerminalItem()'));
      }
      if (!item) {
        await this.key('Escape');
        throw new Error('菜单里没有终端这一项');
      }
      await this.tapCss(item.x, item.y);
    }
    this.emit({ t: 'status', ok: true, msg: '已新建终端' });
    setTimeout(() => this.pollTerminal().catch(() => {}), 500);
  }

  async focusTerminal() {
    const pos = await this.cdp.evaluate(helpersCall('terminalFocus()'));
    if (!pos) throw new Error('没有打开的终端。先新建一个。');
    await this.tapCss(pos.x, pos.y);
    await new Promise(r => setTimeout(r, 80));
  }

  async sendTerminal(text) {
    await this.focusTerminal();
    // History recall already put a command on the prompt. Replace that line so an edit is not appended.
    if (typeof await this.cdp.evaluate(helpersCall('terminalCommand()')) === 'string') {
      await this.key('Ctrl+a');
      await this.key('Ctrl+k');
    }
    const lines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await this.cdp.send('Input.insertText', { text: lines[i] });
      if (i < lines.length - 1 || lines[i]) await this.key('Enter');
    }
  }

  async ensureSettings() {
    const waitOpen = async () => {
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 120));
        if (await this.cdp.evaluate(helpersCall('settingsOpen()'))) return true;
      }
      return false;
    };
    if (await this.cdp.evaluate(helpersCall('settingsOpen()'))) return;
    // Click the gear directly. A coordinate click on the 24px footer button often misses.
    await this.cdp.evaluate(helpersCall('clickSettingsButton()'));
    if (await waitOpen()) return;
    // Cursor and Devin both bind Settings to Ctrl+Comma.
    const comma = { key: ',', code: 'Comma', windowsVirtualKeyCode: 188, modifiers: 2 };
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...comma });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...comma });
    if (await waitOpen()) return;
    throw new Error('设置没有打开');
  }

  async closeSettings() {
    const how = await this.cdp.evaluate(helpersCall('clickCloseSettings()'));
    if (how === 'tab') await this.key('Ctrl+w');
  }

  async showSettings() {
    await this.ensureSettings();
    let sections = [];
    try {
      sections = await this.cdp.evaluate(helpersCall('readSettings()')) || [];
      if (!sections.length) {
        const nav = await this.cdp.evaluate(helpersCall('devinSettingsNav()')) || [];
        for (const name of nav) {
          await this.cdp.evaluate(helpersCall(`devinSettingsClick(${JSON.stringify(name)})`));
          await new Promise(r => setTimeout(r, 180));
          const items = await this.cdp.evaluate(helpersCall('devinSettingsCards()')) || [];
          if (items.length) sections.push({ title: name, items });
        }
      }
    } finally { await this.closeSettings(); }
    this.emit({ t: 'settings', sections });
  }

  async toggleSetting(label) {
    await this.ensureSettings();
    try {
      const pos = await this.cdp.evaluate(helpersCall(`settingTarget(${JSON.stringify(String(label))})`));
      if (!pos) throw new Error('找不到这项设置');
      await this.tapCss(pos.x, pos.y);
      await new Promise(r => setTimeout(r, 250));
      const sections = await this.cdp.evaluate(helpersCall('readSettings()')) || [];
      this.emit({ t: 'settings', sections });
      this.emit({ t: 'status', ok: true, msg: '已更新设置' });
    } finally { await this.closeSettings(); }
  }

  async showUsage() {
    if (this.app === 'devin') {
      this.emit({ t: 'usage', lines: [], bars: [] });
      return;
    }
    await this.ensureSettings();
    try {
      const nav = await this.cdp.evaluate(helpersCall('usageNavTarget()'));
      if (!nav) {
        this.emit({ t: 'usage', lines: [] });
        return;
      }
      await this.tapCss(nav.x, nav.y);
      await new Promise(r => setTimeout(r, 500));
      const usage = await this.cdp.evaluate(helpersCall('readUsage()'));
      this.emit({ t: 'usage', lines: usage?.lines || [], bars: usage?.bars || [] });
    } finally { await this.closeSettings(); }
  }

  showProjects(dir) {
    this.emit({ t: 'projects', ...projectList(dir || '') });
  }

  workspaceByRoot(root) {
    for (const w of workspaces()) {
      if (w.host) {
        if (w.root === root) return w;
        continue;
      }
      try {
        if (fs.realpathSync(w.root) === fs.realpathSync(root)) return { ...w, root: fs.realpathSync(w.root) };
      } catch {}
    }
    return null;
  }

  async showDocs(root, dir) {
    try {
      if (!root) {
        const ws = workspaceForTitle(this.winTitle || '');
        if (ws) {
          this.emit({ t: 'docs', ...(await listProject(ws.host, ws.root, ws.root)) });
          return;
        }
        const seen = new Set();
        const projects = [];
        for (const w of workspaces()) {
          const key = `${w.host || ''}\0${w.root}`;
          if (seen.has(key)) continue;
          seen.add(key);
          projects.push({ name: path.basename(w.root) || w.root, path: w.root, host: w.host || '' });
          if (projects.length >= 12) break;
        }
        this.emit({ t: 'docs', projects });
        return;
      }
      const ws = this.workspaceByRoot(root);
      if (!ws) throw new Error('只能查看 Cursor 打开过的项目');
      this.emit({ t: 'docs', ...(await listProject(ws.host, ws.root, dir || ws.root)) });
    } catch (e) {
      this.emit({ t: 'docs', error: e.message });
    }
  }

  async useProject(folder) {
    const real = openFolder(folder, this.app);
    this.emit({ t: 'status', ok: true, msg: `已打开 ${path.basename(real)}` });
  }

  async sendPanelRect() {
    const rect = await this.cdp.evaluate(helpersCall('panelRect()')).catch(() => null);
    const json = JSON.stringify(rect);
    if (json !== this.lastPanel) {
      this.lastPanel = json;
      this.emit({ t: 'panel', rect });
    }
  }

  async clickButton(item, n) {
    const pos = await this.cdp.evaluate(helpersCall(`locate(${JSON.stringify(String(item))}, ${Number(n) || 0})`));
    if (!pos) throw new Error('按钮已经不在了，可能状态已变化');
    await this.tapCss(pos.x, pos.y);
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  }

  async editQueued(id, text) {
    if (!text.trim()) throw new Error('内容不能为空；不想要这条就点「删除」');
    await this.queueAction(id, 'edit');
    const focus = () => this.cdp.evaluate(helpersCall(`focusQueueEdit(${JSON.stringify(String(id))})`));
    let ok = false;
    for (let i = 0; i < 10 && !ok; i++) {
      await new Promise(r => setTimeout(r, 100));
      ok = await focus();
    }
    if (!ok) throw new Error('Cursor 没有进入编辑状态，没改动');
    await this.key(process.platform === 'darwin' ? 'Meta+A' : 'Ctrl+A');
    await this.typeText(text);
    await this.key('Enter');
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  }

  async queueAction(id, action) {
    if (!['send', 'remove', 'edit'].includes(action)) throw new Error('不支持的排队操作');
    if (this.app === 'devin') return this.devinQueueAction(id, action);
    const call = a => this.cdp.evaluate(helpersCall(`queueTarget(${JSON.stringify(String(id))}${a ? `, ${JSON.stringify(a)}` : ''})`));
    const row = await call();
    if (!row) throw new Error('这条排队消息已经不在了（可能刚被发出）');
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y });
    let pos = null;
    for (let i = 0; i < 6 && !pos; i++) {
      await new Promise(r => setTimeout(r, 80));
      pos = await call(action);
    }
    if (!pos) throw new Error('没找到排队消息的操作按钮（可能 Cursor 版本不同）');
    await this.tapCss(pos.x, pos.y);
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  }

  // Devin queue rows: hover the row (buttons appear on hover), then tap Send now / Remove from queue.
  // Edit and reorder are not offered. "Clear all" is a bar-level button.
  async devinQueueAction(id, action) {
    if (!['send', 'remove'].includes(action)) throw new Error('不支持的排队操作');
    const n = /^dq(\d+)$/.exec(String(id))?.[1];
    const row = n == null ? null : await this.cdp.evaluate(helpersCall(`devinQueueTarget(${n})`));
    if (!row) throw new Error('这条排队消息已经不在了（可能刚被发出）');
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y });
    let pos = null;
    for (let i = 0; i < 6 && !pos; i++) {
      await new Promise(r => setTimeout(r, 80));
      pos = await this.cdp.evaluate(helpersCall(`devinQueueTarget(${n}, ${JSON.stringify(action)})`));
    }
    if (!pos) throw new Error('没找到排队消息的操作按钮（可能 Devin 版本不同）');
    await this.tapCss(pos.x, pos.y);
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  }

  // Devin "edit": take the queued message out of the queue and hand its text to the phone's input box.
  async devinTakeOut(id) {
    const q = (await this.cdp.evaluate(helpersCall('devinQueued()')) || []).find(x => x.id === id);
    if (!q || !q.t) throw new Error('这条排队消息已经不在了（可能刚被发出）');
    await this.devinQueueAction(id, 'remove');
    this.emit({ t: 'unqueued', id, text: q.t });
  }

  async devinClearQueue() {
    const pos = await this.cdp.evaluate(helpersCall('devinQueueClearTarget()'));
    if (!pos) throw new Error('没找到清空排队消息的按钮（可能 Devin 版本不同）');
    await this.tapCss(pos.x, pos.y);
    this.emit({ t: 'status', ok: true, msg: '已清空排队消息' });
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  }

  async subagentAction(name, part) {
    const call = `subTarget(${JSON.stringify(String(name))}, ${JSON.stringify(part)})`;
    let pos = await this.cdp.evaluate(helpersCall(call));
    if (pos?.expand) {
      await this.tapCss(pos.x, pos.y);
      for (let i = 0; i < 8 && (!pos || pos.expand); i++) {
        await new Promise(r => setTimeout(r, 120));
        pos = await this.cdp.evaluate(helpersCall(call));
      }
    }
    if (!pos || pos.expand) throw new Error('这个子 Agent 已经结束了，或者 Cursor 里找不到它');
    if (part === 'open') {
      const tab = await this.cdp.evaluate(helpersCall('activeChatTab()'));
      if (tab && await this.cdp.evaluate(helpersCall('hasComposer()'))) this.mainTab = tab;
    }
    await this.tapCss(pos.x, pos.y);
    setTimeout(() => this.pollChat().catch(() => {}), 500);
  }

  // Opens Cursor's changed-files list if needed, runs fn, then puts the list back the way it was.
  // Devin: the rows are readable while the list is folded (display:none), so reading does not toggle it.
  // Rows can mount late, so wait for as many as the bar counts. Actions open the list, then fold it again.
  async withFiles(fn, { act = false } = {}) {
    if (this.app !== 'devin') return this.withCursorFiles(fn);
    const state = () => this.cdp.evaluate(helpersCall('filesState()'));
    const settle = async (s, ok) => { for (let i = 0; i < 15 && !ok(s); i++) { await new Promise(r => setTimeout(r, 100)); s = await state(); } return s; };
    let s = await settle(await state(), x => x.files.length >= x.count);
    if (!act) return fn(s);
    let toggled = false;
    if (!s.open) {
      const t = await this.cdp.evaluate(helpersCall('fileTarget(0, "", "toggle")'));
      if (t) {
        await this.tapCss(t.x, t.y);
        toggled = true;
        s = await settle(s, x => x.open);
      }
    }
    try {
      return await fn(s);
    } finally {
      if (toggled && (await state()).open) {
        const t = await this.cdp.evaluate(helpersCall('fileTarget(0, "", "toggle")'));
        if (t) await this.tapCss(t.x, t.y);
      }
    }
  }

  async withCursorFiles(fn) {
    const state = () => this.cdp.evaluate(helpersCall('filesState()'));
    let s = await state();
    const opened = !s.open;
    if (opened) {
      const t = await this.cdp.evaluate(helpersCall('fileTarget(0, "", "toggle")'));
      if (!t) return fn(s);
      await this.tapCss(t.x, t.y);
      for (let i = 0; i < 8 && !s.open; i++) {
        await new Promise(r => setTimeout(r, 120));
        s = await state();
      }
    }
    try {
      return await fn(s);
    } finally {
      const t = opened && await this.cdp.evaluate(helpersCall('fileTarget(0, "", "toggle")'));
      if (t && (await state()).open) await this.tapCss(t.x, t.y);
    }
  }

  // Devin thoughts beyond the payload budget are title-only; the body is read from the history,
  // or expanded in the transcript once (and folded back) when it was never captured.
  async thought(id) {
    if (!/^acp\d+:think$/.test(id)) return this.emit({ t: 'thought', i: id, text: null });
    const it = this.devinHist.get(id);
    let body = it ? this.thinkingBody(it) : '';
    if (!body && this.cdp) {
      body = await this.readThought(id);
      if (body && it) this.devinHist.set(id, { ...it, t: `${this.thinkingTitle(it)}\n${body}` });
    }
    this.emit({ t: 'thought', i: id, text: body || null });
  }

  // Devin: a collapsed thought has no body in the DOM. Expand it (only if the user has not), wait up to
  // ~1.5 s for the body to render, read it, and fold it back to the state it was in. Returns '' if not read.
  async readThought(id) {
    const st = await this.cdp.evaluate(helpersCall(`thoughtState(${JSON.stringify(id)})`));
    if (!st) return '';
    if (st.expanded) return this.cdp.evaluate(helpersCall(`thoughtBodyText(${JSON.stringify(id)})`)).then(t => t || '');
    await this.cdp.evaluate(helpersCall(`setThoughtOpen(${JSON.stringify(id)}, true)`));
    let body = '';
    for (let k = 0; k < 15 && !body; k++) {
      await new Promise(r => setTimeout(r, 100));
      body = (await this.cdp.evaluate(helpersCall(`thoughtBodyText(${JSON.stringify(id)})`))) || '';
    }
    await this.cdp.evaluate(helpersCall(`setThoughtOpen(${JSON.stringify(id)}, false)`));
    return body;
  }

  // Devin: finished thoughts in the mounted transcript that have no body yet. Up to 2 per poll; a
  // thought is only marked tried once its body was read, or after 3 failed reads on different polls.
  async captureThoughts(chat) {
    if (this.app !== 'devin') return;
    this.thoughtPoll = (this.thoughtPoll || 0) + 1;
    this.thoughtFails = this.thoughtFails || new Map();
    const todo = (chat?.items || []).filter(it => it.k === 'thinking' && !it.live && it.src === 'devin'
      && !this.thinkingBody(it) && !this.thinkingTried.has(it.i) && !(this.devinHist.get(it.i) && this.thinkingBody(this.devinHist.get(it.i))))
      .reverse().slice(0, 2);
    for (const it of todo) {
      const body = await this.readThought(it.i);
      if (body) {
        it.t = `${this.thinkingTitle(it)}\n${body}`;
        this.thinkingTried.set(it.i, 1);
        continue;
      }
      const f = this.thoughtFails.get(it.i) || { n: 0, poll: 0 };
      if (f.poll !== this.thoughtPoll) f.n++;
      f.poll = this.thoughtPoll;
      this.thoughtFails.set(it.i, f);
      if (f.n >= 3) this.thinkingTried.set(it.i, 1);
    }
  }

  // Devin revert: hover + click the row's revert button. Devin then either rewinds the transcript at once
  // (nothing on disk to undo: no dialog) or shows a confirmation with the file changes. Nothing is
  // confirmed here; the phone answers with revertOk (confirm) or revertCancel.
  async revert(i) {
    if (this.app !== 'devin' || !/^acp\d+$/.test(String(i))) throw new Error('不支持的操作');
    this.pendingRevert = null;
    const num = Number(/\d+/.exec(i)[0]);
    const row = await this.cdp.evaluate(helpersCall(`revertTarget(${JSON.stringify(i)}, 'row')`));
    if (!row) throw new Error('这条消息已经不在了');
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y });
    await new Promise(r => setTimeout(r, 150));
    let btn = null;
    for (let k = 0; k < 6 && !btn; k++) {
      btn = await this.cdp.evaluate(helpersCall(`revertTarget(${JSON.stringify(i)}, 'btn')`));
      if (!btn) await new Promise(r => setTimeout(r, 100));
    }
    if (!btn) throw new Error('没找到回退按钮（可能 Devin 版本不同）');
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y });
    await this.tapCss(btn.x, btn.y);
    const gone = async () => { const s = await this.cdp.evaluate(helpersCall(`revertState(${JSON.stringify(i)})`)); return !s.rowHas || s.max < num; };
    let dlg = null, done = false;
    for (let k = 0; k < 40 && !dlg && !done; k++) {
      await new Promise(r => setTimeout(r, 200));
      dlg = await this.cdp.evaluate(helpersCall('revertDialog()'));
      if (!dlg) done = await gone();
    }
    if (done) return this.afterRevert(num);
    if (!dlg) throw new Error('没有出现回退确认框，也没看到对话被回退，请到电脑上看一下');
    this.pendingRevert = { i, num };
    this.emit({ t: 'revertConfirm', i, title: dlg.title || '回退到这条消息？', body: dlg.body || '', apply: dlg.apply, force: !!dlg.force });
  }

  async revertAnswer(ok, apply) {
    const pr = this.pendingRevert;
    if (!pr) return;
    this.pendingRevert = null;
    if (ok && typeof apply === 'boolean') {
      const d = await this.cdp.evaluate(helpersCall('revertDialog()'));
      if (d && d.apply !== null && d.apply !== apply) {
        const t = await this.cdp.evaluate(helpersCall('revertDialogButton("toggle")'));
        if (t) await this.tapCss(t.x, t.y);
      }
    }
    const pos = await this.cdp.evaluate(helpersCall(`revertDialogButton(${ok ? '"confirm"' : '"cancel"'})`));
    if (pos) await this.tapCss(pos.x, pos.y);
    else if (!ok) await this.key('Escape');
    else throw new Error('没找到回退确认按钮（可能 Devin 版本不同）');
    if (!ok) return void setTimeout(() => this.pollChat().catch(() => {}), 500);
    for (let k = 0; k < 40; k++) {
      await new Promise(r => setTimeout(r, 250));
      const s = await this.cdp.evaluate(helpersCall(`revertState(${JSON.stringify(pr.i)})`));
      if (!s.rowHas || s.max < pr.num) return this.afterRevert(pr.num);
    }
    this.emit({ t: 'status', ok: false, msg: '已点了确认，但还没看到对话被回退，请到电脑上看一下' });
  }

  // The transcript was rewound: rows from the reverted message on no longer exist. Forget them here and tell
  // the phone to drop them from its local copy too.
  afterRevert(num) {
    const n = id => Number(/^acp(\d+)/.exec(id || '')?.[1] ?? -1);
    for (const m of [this.devinHist, this.thinking, this.keptThink, this.thinkingTried, this.tasksTried, this.thoughtFails]) {
      for (const k of [...(m?.keys() || [])]) if (n(k) >= num) m.delete(k);
    }
    this.lastChat = '';
    this.emit({ t: 'trunc', from: num });
    this.emit({ t: 'status', ok: true, msg: '已回退到这条消息之前' });
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  }

  async listChanges() {
    const s = await this.withFiles(async s => s);
    this.emit({ t: 'changes', ...s, ...(this.app === 'devin' ? { devin: true } : {}) });
  }

  async changeAction(i, name, act) {
    if (!['keep', 'undo', 'bar'].includes(act)) throw new Error('不支持的操作');
    await this.withFiles(async s => {
      if (this.app === 'devin' && s.count && !s.files.length) throw new Error('这个界面看不到逐个文件的改动，请先切到 Agent 界面');
      const call = a => helpersCall(`fileTarget(${Number(i) || 0}, ${JSON.stringify(String(name))}, ${JSON.stringify(a)})`);
      if (act !== 'bar') {
        const row = await this.cdp.evaluate(call('row'));
        if (!row) throw new Error('文件列表已经变了，请重新打开');
        await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y });
        await new Promise(r => setTimeout(r, 120));
      }
      const pos = await this.cdp.evaluate(call(act));
      if (!pos) throw new Error('没找到这个按钮（可能 Cursor 版本不同）');
      await this.tapCss(pos.x, pos.y);
      await new Promise(r => setTimeout(r, 400));
    }, { act: act !== 'bar' });
    await this.listChanges();
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  }

  async backToMain() {
    const pos = this.mainTab && await this.cdp.evaluate(helpersCall(`tabTarget(${JSON.stringify(this.mainTab)})`));
    if (!pos) throw new Error('找不到原来的主对话标签页，请在「画面」里手动切回');
    await this.tapCss(pos.x, pos.y);
    setTimeout(() => this.pollChat().catch(() => {}), 400);
  }

  async stopAgent() {
    const pos = await this.cdp.evaluate(helpersCall('stopTarget()'));
    if (!pos) throw new Error('Agent 当前没有在运行');
    await this.tapCss(pos.x, pos.y);
    let busy = true;
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 250));
      busy = !!(await this.cdp.evaluate(helpersCall('agentState()')))?.busy;
      if (!busy) break;
    }
    await this.pollChat().catch(() => {});
    if (busy) throw new Error('没有停下来，Agent 仍在运行');
    this.emit({ t: 'status', ok: true, msg: '已停止 Agent' });
  }

  async listAgents() {
    if (this.app === 'devin') {
      const surface = await this.cdp.evaluate(helpersCall('devinSurface()'));
      if (surface === 'editor') return this.emit({ t: 'agents', list: await this.editorSessions(), surface });
      const list = await this.cdp.evaluate(helpersCall('agentList()'));
      return this.emit({ t: 'agents', list: list || [], ...(surface ? { surface } : {}) });
    }
    const list = await this.cdp.evaluate(helpersCall('agentList()'));
    this.emit({ t: 'agents', list: list || [] });
  }

  // Devin's Editor surface has no session list in the panel; the titlebar "Search agents" quick pick
  // lists every session by name. It is opened, read, and closed again with Escape.
  async openSessionPicker() {
    const pos = await this.cdp.evaluate(helpersCall('sessionSearchTarget()'));
    if (!pos) throw new Error('没找到会话搜索按钮（可能 Devin 版本不同）');
    await this.tapCss(pos.x, pos.y);
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (await this.cdp.evaluate(helpersCall('sessionPickerRows()'))) return true;
    }
    return false;
  }

  async editorSessions() {
    const sess = await this.cdp.evaluate(helpersCall('devinSession()'));
    const tabs = sess?.tabs || [];
    let rows = null, opened = false;
    try {
      opened = await this.openSessionPicker();
      rows = opened ? await this.cdp.evaluate(helpersCall('sessionPickerRows()')) : null;
    } catch (e) {
      if (!tabs.length) throw e;
    }
    if (opened) await this.key('Escape');
    if (!opened && !tabs.length) throw new Error('没有读到会话列表，请先切到 Agent 界面再试');
    const norm = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const open = tabs.map(t => ({ id: `tab:${t.title}`, title: t.title, group: '已打开的会话', current: t.active, running: !!(rows || []).find(r => norm(r.title) === t.title)?.running }));
    const rest = (rows || []).filter(r => !tabs.some(t => t.title === norm(r.title))).map(r => ({ id: r.id, title: r.title, group: tabs.length ? '全部会话' : '', current: false, running: !!r.running }));
    return [...open, ...rest];
  }

  // Close a session tab (Editor surface). The session itself stays in Devin's session list.
  async closeTab(title) {
    if (this.app !== 'devin') throw new Error('不支持的操作');
    const before = await this.cdp.evaluate(helpersCall('devinSession()'));
    const tabs = before?.tabs || [];
    if (!tabs.some(t => t.title === title)) throw new Error('这个会话标签已经关闭了');
    if (tabs.length <= 1) throw new Error('这是唯一打开的会话标签，不能关闭');
    const pos = await this.cdp.evaluate(helpersCall(`devinTabTarget(${JSON.stringify(title)})`));
    if (!pos) throw new Error('这个会话标签已经关闭了');
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
    let x = null;
    for (let i = 0; i < 8 && !x; i++) {
      await new Promise(r => setTimeout(r, 80));
      x = await this.cdp.evaluate(helpersCall(`devinTabCloseTarget(${JSON.stringify(title)})`));
    }
    if (!x) throw new Error('没找到这个标签的关闭按钮（可能 Devin 版本不同）');
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x.x, y: x.y });
    await this.tapCss(x.x, x.y);
    let gone = false;
    for (let i = 0; i < 20 && !gone; i++) {
      await new Promise(r => setTimeout(r, 100));
      gone = !((await this.cdp.evaluate(helpersCall('devinSession()')))?.tabs || []).some(t => t.title === title);
    }
    this.resetDevinView();
    this.emit({ t: 'status', ok: gone, msg: gone ? '已关闭会话标签' : '没有关掉，Devin 可能在等你确认，请到电脑上看一下' });
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  }

  // Editor surface: the open sessions are tabs above the transcript; clicking one switches the transcript.
  async switchTab(title) {
    const pos = await this.cdp.evaluate(helpersCall(`devinTabTarget(${JSON.stringify(String(title))})`));
    if (!pos) throw new Error('这个会话标签已经关闭了');
    await this.tapCss(pos.x, pos.y);
    let on = false;
    for (let i = 0; i < 15 && !on; i++) {
      await new Promise(r => setTimeout(r, 100));
      on = (await this.cdp.evaluate(helpersCall('devinSession()')))?.title === title;
    }
    this.resetDevinView();
    this.emit({ t: 'status', ok: on, msg: on ? '已切换会话' : '这个会话还没有切过去，请稍后再试' });
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  }

  // Switching surface resets what was read from the old transcript, like opening another agent.
  resetDevinView() {
    this.lastChat = '';
  }

  async setSurface(to) {
    if (this.app !== 'devin') throw new Error('不支持的操作');
    const want = to === 'editor' ? 'editor' : 'agent';
    const cur = await this.cdp.evaluate(helpersCall('devinSurface()'));
    if (cur === want) return this.emit({ t: 'status', ok: true, msg: want === 'editor' ? '已在 Editor 界面' : '已在 Agent 界面' });
    const pos = await this.cdp.evaluate(helpersCall(`surfaceTarget(${JSON.stringify(want)})`));
    if (!pos) throw new Error('找不到 Agent / Editor 切换按钮');
    await this.tapCss(pos.x, pos.y);
    let ready = false;
    for (let i = 0; i < 20 && !ready; i++) {
      await new Promise(r => setTimeout(r, 100));
      ready = (await this.cdp.evaluate(helpersCall('devinSurface()'))) === want && await this.cdp.evaluate(helpersCall('transcriptVisible()'));
    }
    this.resetDevinView();
    if (!ready) this.emit({ t: 'status', ok: false, msg: '这个界面还没有加载完，请稍后再试' });
    else this.emit({ t: 'status', ok: true, msg: want === 'editor' ? '已切到 Editor 界面' : '已切到 Agent 界面' });
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  }

  // Devin "New": the Agent surface has the New session control. The Editor surface has none
  // visible, so it switches to Agent first and stays there (the new session lives in Agent).
  async devinNewChat() {
    const surface = await this.cdp.evaluate(helpersCall('devinSurface()'));
    const switched = surface === 'editor';
    if (switched) await this.setSurface('agent');
    await this.pressControl('newChat');
    this.resetDevinView();
    this.emit({ t: 'status', ok: true, msg: switched ? '已切到 Agent 界面并新建对话' : '已新建对话' });
  }

  async openAgent(id) {
    if (!id || id.length > 200) throw new Error('这条 Agent 已经不在列表里');
    if (this.app === 'devin' && id.startsWith('tab:')) return this.switchTab(id.slice(4));
    if (this.app === 'devin' && await this.cdp.evaluate(helpersCall('devinSurface()')) === 'editor') {
      const opened = await this.openSessionPicker();
      const pos = opened && await this.cdp.evaluate(helpersCall(`sessionPickerTarget(${JSON.stringify(id)})`));
      if (!pos) {
        if (opened) await this.key('Escape');
        throw new Error('这条 Agent 已经不在列表里');
      }
      await this.tapCss(pos.x, pos.y);
      this.resetDevinView();
      this.emit({ t: 'status', ok: true, msg: '已切换 Agent' });
      setTimeout(() => this.pollChat().catch(() => {}), 500);
      return;
    }
    const pos = await this.cdp.evaluate(helpersCall(`agentTarget(${JSON.stringify(id)})`));
    if (!pos) throw new Error('这条 Agent 已经不在列表里');
    await this.tapCss(pos.x, pos.y);
    if (this.app !== 'devin') {
      this.thinking?.clear();
      this.thinkingTried?.clear();
      this.keptThink?.clear();
      this.devinHist?.clear();
      this.latestThink = null;
    }
    this.lastChat = '';
    this.emit({ t: 'status', ok: true, msg: '已切换 Agent' });
    setTimeout(() => this.pollChat().catch(() => {}), 500);
  }

  async pressControl(name) {
    const clicked = await this.cdp.evaluate(helpersCall(`clickControl(${JSON.stringify(name)})`));
    if (clicked) return;
    const pos = await this.cdp.evaluate(helpersCall(`control(${JSON.stringify(name)})`));
    if (!pos) throw new Error('当前窗口里没有这个按钮（可能是 Cursor 版本或布局不同）');
    await this.tapCss(pos.x, pos.y);
  }

  // Menus are read by opening them in Cursor, then closed again so the desktop UI is left as it was.
  async openMenu(kind) {
    await this.pressControl(kind);
    let items = [];
    for (let i = 0; i < 12 && !items.length; i++) {
      await new Promise(r => setTimeout(r, 150));
      items = await this.cdp.evaluate(helpersCall(`menuItems(${JSON.stringify(kind)})`));
      if (kind === 'model' && !items.length) {
        const opened = await this.cdp.evaluate(helpersCall('clickModelListTrigger()'));
        if (!opened) {
          const sub = await this.cdp.evaluate(helpersCall('modelListTrigger()'));
          if (sub) await this.tapCss(sub.x, sub.y);
        }
      }
    }
    const max = kind === 'model' ? await this.cdp.evaluate(helpersCall('maxToggle()?.on ?? null')) : null;
    let fusion = null;
    if (kind === 'model') {
      fusion = await this.cdp.evaluate(helpersCall('fusionConfig()'));
      if (fusion) this.fusion = fusion;
    }
    await this.closeMenus();
    this.emit({ t: 'menu', kind, items, max, fusion });
  }

  async closeMenus() {
    for (let i = 0; i < 3 && await this.cdp.evaluate(helpersCall('menuOpen()')); i++) {
      await this.key('Escape');
      await new Promise(r => setTimeout(r, 120));
    }
  }

  async waitFor(call, tries = 10) {
    for (let i = 0; i < tries; i++) {
      await new Promise(r => setTimeout(r, 120));
      const v = await this.cdp.evaluate(helpersCall(call));
      if (v) return v;
    }
    return null;
  }

  async toggleMax() {
    await this.pressControl('model');
    const t = await this.waitFor('maxToggle()');
    if (!t) { await this.closeMenus(); throw new Error('这个 Cursor 版本没有 MAX Mode 开关'); }
    await this.tapCss(t.x, t.y);
    await new Promise(r => setTimeout(r, 250));
    await this.closeMenus();
    await this.openMenu('model');
  }

  // Leaves the parameter submenu open; callers must closeMenus().
  async openParamMenu(model) {
    const id = JSON.stringify(String(model));
    await this.pressControl('model');
    const row = await this.waitFor(`modelTarget(${id})`);
    if (!row) { await this.closeMenus(); throw new Error('模型列表里找不到这个模型'); }
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y });
    const edit = await this.waitFor(`modelTarget(${id}, 'edit')`, 6);
    if (!edit) { await this.closeMenus(); throw new Error('这个模型没有可调的参数'); }
    await this.tapCss(edit.x, edit.y);
    const params = await this.waitFor('modelParams()');
    if (!params) { await this.closeMenus(); throw new Error('参数菜单没有打开（可能 Cursor 版本不同）'); }
    return params;
  }

  async showParams(model, label) {
    try {
      this.emit({ t: 'params', model, label, sections: await this.openParamMenu(model) });
    } finally {
      await this.closeMenus();
    }
  }

  async pickParam(model, label, section, value) {
    try {
      await this.openParamMenu(model);
      const pos = await this.cdp.evaluate(helpersCall(`paramTarget(${JSON.stringify(String(section))}, ${JSON.stringify(String(value))})`));
      if (!pos) throw new Error(`没找到参数：${section} / ${value}`);
      await this.tapCss(pos.x, pos.y);
      await new Promise(r => setTimeout(r, 250));
    } finally {
      await this.closeMenus();
    }
    await this.showParams(model, label);
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  }

  async pickMenu(kind, label) {
    await this.pressControl(kind);
    if (kind === 'model') {
      for (let i = 0; i < 8; i++) {
        const opened = await this.cdp.evaluate(helpersCall('clickModelListTrigger()'));
        if (opened) break;
        const sub = await this.cdp.evaluate(helpersCall('modelListTrigger()'));
        if (sub) { await this.tapCss(sub.x, sub.y); break; }
        await new Promise(r => setTimeout(r, 120));
      }
    }
    let pos = null;
    for (let i = 0; i < 10 && !pos; i++) {
      await new Promise(r => setTimeout(r, 150));
      pos = await this.cdp.evaluate(helpersCall(`menuItem(${JSON.stringify(kind)}, ${JSON.stringify(String(label))})`));
    }
    if (!pos) {
      await this.key('Escape');
      throw new Error(`没找到选项：${label}`);
    }
    await this.tapCss(pos.x, pos.y);
    this.emit({ t: 'status', ok: true, msg: `已切换到 ${label}` });
    if (kind === 'model' && label === 'Fusion') {
      this.fusion = null;
      this.fusionMiss = false;
      await new Promise(r => setTimeout(r, 300));
      await this.closeMenus();
      await this.openMenu('model');
      return;
    }
    setTimeout(() => this.pollChat().catch(() => {}), 500);
  }

  queueFusionRead() {
    if (this.fusionLoading || this.fusionMiss) return;
    this.fusionLoading = true;
    this.readFusion(true).then(cfg => {
      if (cfg) { this.fusion = cfg; this.fusionMiss = false; this.lastChat = ''; }
      else this.fusionMiss = true;
    }).catch(() => { this.fusionMiss = true; }).finally(() => { this.fusionLoading = false; });
  }

  // Reuses the panel if the model menu is already open (pressing the button again would close it),
  // and expands the model list like openMenu does when the panel does not show up on its own.
  async openFusionPanel() {
    let fusion = await this.cdp.evaluate(helpersCall('fusionConfig()'));
    if (fusion) return fusion;
    await this.pressControl('model');
    for (let i = 0; i < 14 && !fusion; i++) {
      await new Promise(r => setTimeout(r, 150));
      fusion = await this.cdp.evaluate(helpersCall('fusionConfig()'));
      if (fusion) break;
      // The panel opens while the mouse hovers the Fusion row. Clicking that row would pick it and close the menu.
      const row = await this.cdp.evaluate(helpersCall(`menuItem('model', 'Fusion')`));
      if (row) { await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y }); continue; }
      if (i < 4) continue;
      const opened = await this.cdp.evaluate(helpersCall('clickModelListTrigger()'));
      if (opened) continue;
      const sub = await this.cdp.evaluate(helpersCall('modelListTrigger()'));
      if (sub) await this.tapCss(sub.x, sub.y);
    }
    return fusion;
  }

  async idleFusionRead() {
    for (let i = 0; i < 40 && this.fusionLoading; i++) await new Promise(r => setTimeout(r, 100));
  }

  async readFusion(open) {
    let cfg = await this.cdp.evaluate(helpersCall('fusionConfig()'));
    if (cfg || !open) return cfg;
    cfg = await this.openFusionPanel();
    await this.closeMenus();
    return cfg;
  }

  async fusionOptions(part) {
    if (!['lead', 'effort', 'sidekick'].includes(part)) throw new Error('没有这个 Fusion 选项');
    await this.idleFusionRead();
    const fusion = await this.openFusionPanel();
    if (!fusion) { await this.closeMenus(); throw new Error('先把模型切换到 Fusion'); }
    const opened = await this.cdp.evaluate(helpersCall(`clickFusionCombo(${JSON.stringify(part)})`));
    if (!opened) { await this.closeMenus(); throw new Error('Fusion 的这项没有打开'); }
    let items = [];
    for (let i = 0; i < 8 && !items.length; i++) {
      await new Promise(r => setTimeout(r, 120));
      items = await this.cdp.evaluate(helpersCall('fusionOptionItems()')) || [];
    }
    const current = fusion[part];
    items = items.map(it => ({ ...it, checked: it.label === current }));
    await this.closeMenus();
    if (!items.length) throw new Error('没有读到可切换的模型');
    this.emit({ t: 'menu', kind: `fusion-${part}`, items, fusion });
  }

  async fusionPick(part, value) {
    await this.idleFusionRead();
    const ready = await this.openFusionPanel();
    if (!ready) { await this.closeMenus(); throw new Error('先把模型切换到 Fusion'); }
    if (part === 'fast') {
      const ok = await this.cdp.evaluate(helpersCall('clickFusionFast()'));
      if (!ok) throw new Error('没有找到 Fast Mode');
    } else {
      if (!['lead', 'effort', 'sidekick'].includes(part)) throw new Error('没有这个 Fusion 选项');
      const opened = await this.cdp.evaluate(helpersCall(`clickFusionCombo(${JSON.stringify(part)})`));
      if (!opened) throw new Error('Fusion 的这项没有打开');
      const pos = await this.waitFor(`fusionOptionTarget(${JSON.stringify(String(value))})`);
      if (!pos) { await this.closeMenus(); throw new Error(`没找到选项：${value}`); }
      await this.tapCss(pos.x, pos.y);
    }
    await new Promise(r => setTimeout(r, 250));
    const fusion = await this.waitFor('fusionConfig()') || ready;
    this.fusion = fusion;
    this.fusionMiss = false;
    this.lastChat = '';
    await this.closeMenus();
    this.emit({ t: 'status', ok: true, msg: part === 'fast' ? `Fast Mode 已${fusion.fast ? '打开' : '关闭'}` : `已切换到 ${value}` });
    await this.openMenu('model');
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  }

  async scrollChat(dy) {
    const rect = await this.cdp.evaluate(helpersCall('panelRect()'));
    if (!rect) return;
    const [x, y, w, h] = rect;
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: x + w / 2, y: y + h / 2, deltaX: 0, deltaY: dy });
    setTimeout(() => this.pollChat().catch(() => {}), 400);
  }

  emit(obj) {
    if (this.client.readyState === 1) this.client.send(JSON.stringify(obj));
  }

  // Asks Cursor's own Cmd+P index where a bare file name lives, then closes the picker again.
  async quickOpen(name) {
    await this.key(process.platform === 'darwin' ? 'Meta+p' : 'Ctrl+p');
    try {
      let rows = null;
      for (let i = 0; i < 6 && !rows; i++) {
        await new Promise(r => setTimeout(r, 150));
        rows = await this.cdp.evaluate(helpersCall('quickOpenRows()'));
      }
      if (!rows) return [];
      await this.cdp.send('Input.insertText', { text: name });
      let hits = [];
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 250));
        hits = (await this.cdp.evaluate(helpersCall('quickOpenRows()')) || []).filter(r => r.name === name);
        if (hits.length) break;
      }
      return hits;
    } finally {
      await this.key('Escape');
    }
  }

  async resolveFile(text) {
    const { p, line } = parseRef(text);
    if (!p) throw new Error('不是文件路径');
    const ws = workspaceForTitle(this.winTitle || '');
    const host = ws ? ws.host : /\[SSH: ([^\]]+)\]/.exec(this.winTitle || '')?.[1] || null;
    // Devin has no quick-open; resolve purely on disk (absolute, root-relative, basename search).
    if (this.app === 'devin') return resolveLocal(ws, text);
    const isAbs = /^(\/|~\/|[a-zA-Z]:[\\/])/.test(p);
    const tried = [];
    const tryPath = async (h, abs) => {
      if (tried.some(t => t.h === h && t.abs === abs)) return null;
      tried.push({ h, abs });
      const size = await fileSize(h, abs);
      return size == null ? null : { host: h, path: abs, size, line };
    };
    if (isAbs) {
      const hit = await tryPath(host, p);
      if (hit) return hit;
    } else if (ws) {
      const hit = await tryPath(ws.host, path.posix.join(ws.root, p));
      if (hit) return hit;
    }
    if (this.winTitle === 'Cursor Agents') {
      // The Agents window mixes projects, so try recently opened folders.
      for (const w of workspaces().slice(0, 8)) {
        const hit = await tryPath(w.host, isAbs ? p : path.posix.join(w.root, p));
        if (hit) return hit;
      }
      throw new Error(`找不到文件（可能已被删除或移动）：${p}`);
    }
    const name = path.posix.basename(p);
    const dir = path.posix.dirname(p);
    const hits = await this.quickOpen(name);
    // Prefer matches inside this workspace (relative dir) whose folder ends with the path the chat showed.
    const ranked = hits
      .map(h => ({ ...h, abs: h.dir.startsWith('/') ? path.posix.join(h.dir, name) : ws ? path.posix.join(ws.root, h.dir, name) : null }))
      .filter(h => h.abs)
      .sort((a, b) => (dir !== '.' && b.abs.endsWith('/' + p)) - (dir !== '.' && a.abs.endsWith('/' + p)) || a.dir.startsWith('/') - b.dir.startsWith('/'));
    for (const h of ranked) {
      const hit = await tryPath(host, h.abs);
      if (hit) return hit;
    }
    throw new Error(`找不到文件（可能已被删除或移动）：${p}`);
  }

  // The desktop app's own colour theme, once per attached app; falls back to a
  // shiki builtin matching the phone's light/dark choice (sent via {t:'appTheme'}).
  async fileTheme() {
    if (this._theme?.app === this.app) return this._theme.theme;
    let theme = null;
    try { theme = findTheme(this.app, { port: this.app === 'devin' ? 9223 : 9222 }); } catch {}
    this._theme = { app: this.app, theme: theme || (this.dark === false ? 'light-plus' : 'dark-plus') };
    return this._theme.theme;
  }

  async fileMarks(f, text) {
    if (f.host) return null;
    const git = await gitMarks(f.path).catch(() => null);
    if (git) {
      if (git.newFile) return { marks: { add: [], mod: [], del: [] }, markSource: 'git', newFile: true };
      if (git.add.length || git.mod.length || git.del.length) {
        return { marks: { add: git.add, mod: git.mod, del: git.del }, markSource: 'git' };
      }
    }
    if (this.app === 'devin') {
      const m = agentMarks(this.devinHist, f.path, text);
      if (m && (m.add.length || m.del.length)) return { marks: m, markSource: 'agent' };
    }
    return git && !git.newFile ? null : (git?.newFile ? { marks: { add: [], mod: [], del: [] }, markSource: 'git', newFile: true } : null);
  }

  async openFile(text) {
    this.emit({ t: 'file', loading: true, name: path.posix.basename(parseRef(text).p) });
    try {
      const f = await this.resolveFile(text);
      const body = await readFile(f.host, f.path, f.size);
      let hl = null, marked = null;
      if (body.text) {
        const theme = await this.fileTheme();
        hl = await highlightText(body.text, f.path, theme).catch(() => null);
        marked = await this.fileMarks(f, body.text).catch(() => null);
      }
      this.emit({ t: 'file', name: path.posix.basename(f.path), path: f.path, host: f.host, size: f.size, line: f.line, editable: Boolean(body.text) && !body.truncated, ...body, ...(hl ? { hl } : {}), ...(marked?.marks ? { marks: marked.marks, markSource: marked.markSource } : {}), ...(marked?.newFile ? { newFile: true } : {}) });
    } catch (e) {
      this.emit({ t: 'file', error: e.message, name: path.posix.basename(parseRef(text).p) });
    }
  }

  async saveFile(filePath, text) {
    try {
      const loc = locateWritable(filePath);
      if (!loc) throw new Error('只能修改 Cursor 打开过的项目里的文件');
      const size = await writeTextFile(loc.host, loc.path, text);
      this.emit({ t: 'saved', ok: true, path: filePath, host: loc.host || '', size });
      this.emit({ t: 'status', ok: true, msg: '已保存' });
    } catch (e) {
      this.emit({ t: 'saved', ok: false, error: e.message, path: filePath });
      this.emit({ t: 'status', ok: false, msg: e.message });
    }
  }

  async attach(targetId) {
    this.detach();
    const wins = await listWindows();
    const win = wins.find(w => w.id === targetId) || wins.find(w => w.id.endsWith(':' + targetId)) || wins[0];
    if (!win) throw new Error('没有找到 Cursor 或 Devin 窗口。Cursor 用调试端口 9222，Devin 用 ./start-devin.sh');
    const cdp = new Cdp(win.ws);
    await cdp.connect();
    this.cdp = cdp;
    this.targetId = win.id;
    this.winTitle = win.title;
    this.app = win.app || 'cursor';
    this.lastChat = '';
    this.thinking = new Map();
    this.thinkingTried = new Map();
    this.tasksTried = new Map();
    this.keptThink = new Map();
    this.devinHist = new Map();
    this.thoughtFails = new Map();
    this.latestThink = null;
    this.sessStore = new Map();
    this.curSession = undefined;
    this.sessTitles = [];
    cdp.onclose = () => {
      if (this.cdp === cdp) {
        this.cdp = null;
        this.emit({ t: 'status', ok: false, msg: 'Cursor 窗口连接已断开' });
      }
    };
    cdp.on('Page.screencastFrame', p => this.onFrame(p));
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await this.refreshViewport();
    this.emit({ t: 'attached', id: win.id, title: win.title, app: win.app });
    await this.setMode(this.mode);
  }

  detach() {
    clearInterval(this.chatTimer);
    clearInterval(this.termTimer);
    if (this.cdp) {
      const cdp = this.cdp;
      this.cdp = null;
      this.casting = false;
      cdp.send('Page.stopScreencast').catch(() => {}).finally(() => cdp.close());
    }
  }

  async refreshViewport() {
    const v = await this.cdp.evaluate('({ w: innerWidth, h: innerHeight })');
    if (v) this.viewport = v;
  }

  async startScreencast() {
    this.casting = true;
    await this.cdp.send('Page.startScreencast', { ...this.screencast, everyNthFrame: 1 });
  }

  async stopScreencast() {
    this.casting = false;
    await this.cdp.send('Page.stopScreencast').catch(() => {});
  }

  onFrame({ data, metadata, sessionId }) {
    this.lastFrameAt = Date.now();
    if (metadata?.deviceWidth) this.viewport = { w: metadata.deviceWidth, h: metadata.deviceHeight };
    this.sendFrame(data);
    this.awaitingAck = sessionId;
    // Don't let a slow phone stall the stream forever.
    clearTimeout(this.ackTimer);
    this.ackTimer = setTimeout(() => this.ack(), 1500);
  }

  ack() {
    clearTimeout(this.ackTimer);
    if (this.awaitingAck == null || !this.cdp) return;
    const sessionId = this.awaitingAck;
    this.awaitingAck = null;
    this.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  }

  sendFrame(data, force = false) {
    const hash = crypto.createHash('md5').update(data).digest('hex');
    if (!force && hash === this.lastHash) return;
    this.lastHash = hash;
    this.emit({ t: 'frame', data, w: this.viewport.w, h: this.viewport.h });
  }

  // Electron stops painting occluded/minimized windows, so screencast goes quiet; fall back to screenshots.
  async pollIfIdle() {
    if (!this.cdp || (this.mode !== 'screen' && this.mode !== 'terminal')) return;
    if (this.mode === 'terminal') { await this.pollTerminal(); return; }
    await this.sendPanelRect();
    if (Date.now() - this.lastFrameAt < 2000) return;
    await this.snapshot(false).catch(() => {});
  }

  async snapshot(force) {
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: this.screencast.quality });
    this.sendFrame(data, force);
  }

  toCss(nx, ny) {
    return { x: Math.round(nx * this.viewport.w), y: Math.round(ny * this.viewport.h) };
  }

  async tap(nx, ny, button = 'left') {
    const { x, y } = this.toCss(nx, ny);
    await this.tapCss(x, y, button);
  }

  async tapCss(x, y, button = 'left') {
    const base = { x, y, button, clickCount: 1 };
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  }

  async wheel(nx, ny, dx, dy) {
    const { x, y } = this.toCss(nx, ny);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy });
  }

  async key(combo, opts = {}) {
    if (opts.focusTerminal) await this.focusTerminal();
    const recall = opts.focusTerminal && (combo === 'ArrowUp' || combo === 'ArrowDown');
    const before = recall ? await this.cdp.evaluate(helpersCall('terminalCommand()')) : undefined;
    const parts = combo.split('+');
    const name = parts.pop();
    const modifiers = parts.reduce((m, p) => m | (MOD[p] || 0), 0);
    let spec = NAMED_KEYS[name];
    if (!spec && name.length === 1) {
      const up = name.toUpperCase();
      spec = { code: /[A-Z]/.test(up) ? `Key${up}` : /\d/.test(up) ? `Digit${up}` : '', vk: up.charCodeAt(0), text: name };
    }
    if (!spec) throw new Error(`未知按键: ${combo}`);
    const withText = spec.text && !(modifiers & (MOD.Ctrl | MOD.Meta));
    const ev = { key: name, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, modifiers };
    await this.cdp.send('Input.dispatchKeyEvent', { type: withText ? 'keyDown' : 'rawKeyDown', ...ev, ...(withText ? { text: spec.text } : {}) });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
    if (!recall) return;
    let cmd = before;
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 40));
      const next = await this.cdp.evaluate(helpersCall('terminalCommand()'));
      if (typeof next === 'string' && next !== before) { cmd = next; break; }
      if (i === 7 && typeof next === 'string') cmd = next;
    }
    if (typeof cmd === 'string') this.emit({ t: 'termInput', text: cmd });
  }

  async typeText(text) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await this.key('Shift+Enter');
      if (lines[i]) await this.cdp.send('Input.insertText', { text: lines[i] });
    }
  }

  // Devin while busy: Enter queues (the default), Ctrl/⌘+Enter interrupts the turn and sends now.
  async sendMessage(text, submit, when) {
    const found = await this.cdp.evaluate(FOCUS_COMPOSER);
    if (!found) throw new Error('没找到可见的聊天输入框：先在画面里打开 Agent 面板（或点「打开聊天」）');
    const busy = submit && await this.cdp.evaluate(helpersCall('agentState()?.busy'));
    await this.typeText(text);
    const now = this.app === 'devin' && when === 'now' && !!busy;
    if (submit) await this.key(now ? (process.platform === 'darwin' ? 'Meta+Enter' : 'Ctrl+Enter') : 'Enter');
    if (now) this.emit({ t: 'status', ok: true, msg: '已打断当前任务并发送' });
    if (this.mode === 'chat') setTimeout(() => this.pollChat().catch(() => {}), 300);
    return Boolean(busy) && !now;
  }

  async answerQuestion(qi, oi, part, text) {
    const call = p => helpersCall(`questionTarget(${Number(qi) || 0}, ${Number(oi) || 0}, ${JSON.stringify(p)})`);
    const pos = await this.cdp.evaluate(call(part));
    if (!pos) throw new Error('这个问题已经不在了（可能已在电脑上回答）');
    await this.tapCss(pos.x, pos.y);
    if (part === 'option' && typeof text === 'string') {
      await new Promise(r => setTimeout(r, 150));
      await this.cdp.evaluate(`document.activeElement?.select?.()`);
      if (text) await this.typeText(text);
      else await this.key('Backspace');
    }
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  }

  async attachImage(data, name, type) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(type) || typeof data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(data)) throw new Error('只支持 PNG / JPEG / GIF / WebP 图片');
    const ok = await this.cdp.evaluate(pasteImage(data, String(name || 'image').replace(/[^\w.\-]/g, '_').slice(0, 60), type));
    if (ok === null) throw new Error('没找到可见的聊天输入框：先在画面里打开 Agent 面板（或点「打开聊天」）');
    if (!ok) throw new Error('Cursor 没有接收这张图片（当前模型可能不支持图片）');
    this.emit({ t: 'status', ok: true, msg: '图片已附加到 Cursor 输入框，写好文字后点发送' });
  }

  async handle(msg) {
    if (msg.t === 'windows') return this.emit({ t: 'windows', list: (await listWindows()).map(({ id, title, kind, app }) => ({ id, title, kind, app })), current: this.targetId });
    if (msg.t === 'attach') return this.attach(msg.id);
    if (msg.t === 'mode') return this.setMode(msg.mode);
    if (msg.t === 'visible') { this.visible = Boolean(msg.v); return; }
    if (msg.t === 'lang') { updateDevice(this.deviceId, { lang: msg.v === 'en' ? 'en' : 'zh' }); return; }
    if (!this.cdp) throw new Error('尚未连接到 Cursor 窗口');
    switch (msg.t) {
      case 'openMenu': return this.openMenu(msg.kind);
      case 'pickMenu': return this.pickMenu(msg.kind, msg.label);
      case 'fusionOptions': return this.fusionOptions(String(msg.part ?? ''));
      case 'fusionPick': return this.fusionPick(String(msg.part ?? ''), msg.value);
      case 'toggleMax': return this.toggleMax();
      case 'params': return this.showParams(String(msg.model ?? ''), String(msg.label ?? ''));
      case 'pickParam': return this.pickParam(String(msg.model ?? ''), String(msg.label ?? ''), msg.section, msg.value);
      case 'agents': return this.listAgents();
      case 'openAgent': return this.openAgent(String(msg.id ?? ''));
      case 'terminals': return this.listTerminals();
      case 'openTerminal': return this.openTerminal(String(msg.id ?? ''));
      case 'closeTerminal': return this.closeTerminal(String(msg.id ?? ''));
      case 'newTerminal': return this.newTerminal();
      case 'termSend': return this.sendTerminal(String(msg.text ?? ''));
      case 'projects': return this.showProjects(String(msg.path ?? ''));
      case 'docs': return this.showDocs(String(msg.root ?? ''), String(msg.path ?? ''));
      case 'openProject': return this.useProject(String(msg.path ?? ''));
      case 'settings': return this.showSettings();
      case 'toggleSetting': return this.toggleSetting(String(msg.label ?? ''));
      case 'usage': return this.showUsage();
      case 'newChat': if (this.app === 'devin') return this.devinNewChat(); this.devinHist?.clear(); return this.pressControl('newChat');
      case 'surface': return this.setSurface(String(msg.to ?? ''));
      case 'closeTab': return this.closeTab(String(msg.title ?? ''));
      case 'file': return this.openFile(String(msg.path ?? ''));
      case 'saveFile': return this.saveFile(String(msg.path ?? ''), String(msg.text ?? ''));
      case 'click': return this.clickButton(msg.item, msg.n);
      case 'queue':
        if (msg.action === 'clear' && this.app === 'devin') return this.devinClearQueue();
        if (msg.action === 'edit' && this.app === 'devin') return this.devinTakeOut(msg.id);
        return msg.action === 'edit' ? this.editQueued(msg.id, String(msg.text ?? '')) : this.queueAction(msg.id, msg.action);
      case 'stop': return this.stopAgent();
      case 'subagent': return this.subagentAction(msg.name, msg.part === 'stop' ? 'stop' : 'open');
      case 'mainChat': return this.backToMain();
      case 'image': return this.attachImage(msg.data, msg.name, msg.type);
      case 'question': return this.answerQuestion(msg.qi, msg.oi, ['option', 'submit', 'skip', 'prev', 'next'].includes(msg.part) ? msg.part : 'option', msg.text);
      case 'changes': return this.listChanges();
      case 'thought': return this.thought(String(msg.i ?? ''));
      case 'revert': return this.revert(String(msg.i ?? ''));
      case 'revertOk': return this.revertAnswer(true, typeof msg.apply === 'boolean' ? msg.apply : undefined);
      case 'revertCancel': return this.revertAnswer(false);
      case 'change': return this.changeAction(msg.i, msg.name, msg.act);
      case 'scrollChat': return this.scrollChat(Number(msg.dy) || 0);
      case 'appTheme': this.dark = msg.dark !== false; return;
      case 'tap': return this.tap(msg.x, msg.y, msg.button);
      case 'wheel': return this.wheel(msg.x, msg.y, msg.dx || 0, msg.dy || 0);
      case 'key': return this.key(String(msg.key || ''), { focusTerminal: msg.focus === 'terminal' });
      case 'type': return this.typeText(String(msg.text ?? ''));
      case 'send': return this.sendMessage(String(msg.text ?? ''), msg.submit !== false, msg.when);
      case 'refresh': return this.snapshot(true);
      case 'quality':
        this.screencast.quality = Math.min(this.mode === 'terminal' ? 95 : 90, Math.max(20, Number(msg.quality) || 60));
        this.screencast.maxWidth = Math.min(this.mode === 'terminal' ? 4096 : 2560, Math.max(480, Number(msg.maxWidth) || 1280));
        if (this.mode !== 'screen' && this.mode !== 'terminal') return;
        await this.cdp.send('Page.stopScreencast');
        return this.startScreencast();
      default: throw new Error(`未知指令: ${msg.t}`);
    }
  }

  dispose() {
    clearInterval(this.idleTimer);
    clearTimeout(this.ackTimer);
    this.detach();
  }
}

const SECURITY_HEADERS = {
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
};

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !originAllowed(req)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

function json(req, res, status, obj) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...corsHeaders(req), 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function serveApp(res, name) {
  const rel = decodeURIComponent(String(name)).replace(/^\/+/, '');
  if (!/^(?:katex\/fonts\/[A-Za-z0-9._-]+|katex\/[A-Za-z0-9._-]+|[A-Za-z0-9._-]+)$/.test(rel)) return false;
  const file = path.join(APP_DIR, rel);
  const type = MIME[path.extname(file)];
  if (!type || !file.startsWith(APP_DIR + path.sep) || !fs.existsSync(file)) return false;
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': type });
  fs.createReadStream(file).pipe(res);
  return true;
}

async function readJson(req) {
  try { return JSON.parse(await readBody(req)); } catch { return {}; }
}

function deviceView(d, current) {
  return { id: d.id, name: d.name, created: d.created, lastSeen: d.lastSeen, current: d.id === current?.id };
}

async function handleApi(req, res, route) {
  const ip = clientIp(req);
  if (req.method === 'POST' && !originAllowed(req)) return json(req, res, 403, { error: 'bad origin' });
  const device = deviceFor(req);

  if (route === '/api/me') {
    return json(req, res, 200, { paired: Boolean(device), needTotp: needsTotp(device), totp: Boolean(totpConfig()), id: computerId(), name: computerName(), device: device?.id || '' });
  }

  if (route === '/api/pair' && req.method === 'POST') {
    if (lockedOut(ip)) return json(req, res, 429, { error: '尝试次数过多，请 15 分钟后再试' });
    const { code, name, totp } = await readJson(req);
    if (!pairingValid(code)) {
      recordFailure(ip);
      return json(req, res, 401, { error: '配对链接无效或已过期（10 分钟内有效，只能用一次）。请在电脑上重新运行 npm run pair' });
    }
    if (totpConfig() && !verifyTotp(totp)) {
      if (totp) recordFailure(ip);
      return json(req, res, 401, { needTotp: true, error: totp ? '验证码不对' : '' });
    }
    consumePairing();
    const { device: added, token } = addDevice(name);
    console.log(`[pair] 新设备「${added.name}」 ip=${ip}`);
    return json(req, res, 200, { token, id: computerId(), name: computerName() });
  }

  if (!device) return json(req, res, 401, { error: '设备未配对' });

  if (route === '/api/totp' && req.method === 'POST') {
    if (lockedOut(ip)) return json(req, res, 429, { error: '尝试次数过多，请 15 分钟后再试' });
    const { code } = await readJson(req);
    if (!verifyTotp(code)) {
      recordFailure(ip);
      return json(req, res, 401, { error: '验证码不对' });
    }
    updateDevice(device.id, { verifiedAt: Date.now() });
    return json(req, res, 200, { ok: true });
  }
  if (needsTotp(device)) return json(req, res, 401, { needTotp: true, error: '需要二次验证' });

  if (route === '/api/devices') return json(req, res, 200, { devices: listDevices().map(d => deviceView(d, device)) });
  if (route === '/api/devices/remove' && req.method === 'POST') {
    const { id } = await readJson(req);
    removeDevice(String(id));
    closeEventStreams(String(id));
    console.log(`[unpair] 移除设备 ${id}（操作来自「${device.name}」）`);
    return json(req, res, 200, { ok: true });
  }
  if (route === '/api/logout' && req.method === 'POST') {
    removeDevice(device.id);
    closeEventStreams(device.id);
    console.log(`[unpair] 设备「${device.name}」自己退出`);
    return json(req, res, 200, { ok: true });
  }

  if (route === '/api/events') return openEventStream(req, res, device.id);
  if (route === '/api/push/key') return json(req, res, 200, { key: pushPublicKey() });
  if (route === '/api/push/subscribe' && req.method === 'POST') {
    const { sub } = await readJson(req);
    if (!/^https:\/\//.test(sub?.endpoint || '') || !sub.keys?.p256dh || !sub.keys?.auth) return json(req, res, 400, { error: '订阅信息无效' });
    updateDevice(device.id, { push: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } } });
    return json(req, res, 200, { ok: true });
  }
  if (route === '/api/push/unsubscribe' && req.method === 'POST') {
    updateDevice(device.id, { push: null });
    return json(req, res, 200, { ok: true });
  }
  if (route === '/api/push/test' && req.method === 'POST') {
    await deliver({ kind: 'test', win: '', title: 'Remote Agent', body: '测试通知：能看到这条，说明通知已经通了 ✅',
      en: { body: 'Test notification: if you can see this, notifications work ✅' } }, device.id);
    return json(req, res, 200, { ok: true });
  }
  return json(req, res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') {
    res.writeHead(originAllowed(req) ? 204 : 403, corsHeaders(req));
    return res.end();
  }
  // The same app also runs from GitHub Pages; there url.json holds the encrypted relay address instead.
  if (url.pathname === '/url.json') return json(req, res, 200, { self: true });
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url.pathname);
  if (req.method === 'GET' && serveApp(res, url.pathname === '/' ? 'index.html' : url.pathname)) return;
  res.writeHead(404, SECURITY_HEADERS).end('not found');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 4 << 20 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws' || !originAllowed(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

// The token arrives as the first message rather than in the URL, so it never shows up in proxy logs.
wss.on('connection', (ws, req) => {
  let session = null;
  const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), 5000);
  let queue = Promise.resolve();
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!session) {
      clearTimeout(authTimer);
      const device = msg.t === 'auth' ? findDevice(msg.token) : null;
      if (!device || needsTotp(device)) {
        ws.send(JSON.stringify({ t: 'auth', ok: false, needTotp: Boolean(device) }));
        return ws.close(4001, 'unauthorized');
      }
      updateDevice(device.id, { lastSeen: Date.now() });
      session = new Session(ws, device.id);
      addViewer(session);
      ws.send(JSON.stringify({ t: 'auth', ok: true }));
      console.log(`[+] client ${clientIp(req)}`);
      return;
    }
    // Frame acks bypass the queue so a slow command never stalls the stream.
    if (msg.t === 'ack') return session.ack();
    queue = queue.then(async () => {
      try {
        const queued = await session.handle(msg);
        if (msg.t === 'type') session.emit({ t: 'status', ok: true, msg: '已发送' });
        if (msg.t === 'queue' && msg.action === 'edit') session.emit({ t: 'status', ok: true, msg: '已修改，仍在排队' });
        if (msg.t === 'send') session.emit({ t: 'status', ok: true, msg: queued ? 'Agent 正在运行，已加入排队，这一轮结束后自动发送' : '已发送' });
      } catch (e) {
        session.emit({ t: 'status', ok: false, msg: e.message });
      }
    });
  });
  ws.on('close', () => {
    clearTimeout(authTimer);
    if (!session) return;
    removeViewer(session);
    session.dispose();
    console.log(`[-] client ${clientIp(req)}`);
  });
});

// Until a first device exists, print a pairing QR so a fresh install works without extra commands.
function offerFirstPairing() {
  if (listDevices().length) return;
  const base = appBase();
  if (!base) return;
  const { link, minutes } = createPairing(base);
  printQr(`还没有配对的设备。用手机扫码完成配对（${minutes} 分钟内有效；过期后运行 npm run pair）`, link);
}

function printQr(label, url) {
  console.log(`\n${label}：${url}`);
  qrcode.generate(url, { small: true });
}

function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `${cmd} exited ${code}`)));
    p.stdin.end(input ?? '');
  });
}

async function waitReachable(url) {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${url}/url.json`)).ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

function appUrl() {
  const fixed = normalizeAppUrl(loadConfig().appUrl);
  if (fixed) return fixed;
  const [owner, repo] = PUBLISH_REPO.split('/');
  return `https://${owner.toLowerCase()}.github.io/${repo}/`;
}

// Pages on a user site with a custom domain serves project sites from that domain too.
// Ask gh for the real address once, persist it, and allow its origin. Best effort only.
async function detectAppUrl() {
  if (!PUBLISH_REPO || normalizeAppUrl(loadConfig().appUrl)) return;
  try {
    const u = normalizeAppUrl(await run('gh', ['api', `repos/${PUBLISH_REPO}/pages`, '--jq', '.html_url']));
    if (!u || new URL(u).origin === `https://${PUBLISH_REPO.split('/')[0].toLowerCase()}.github.io`) return;
    const cfg = loadConfig();
    cfg.appUrl = u;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    ALLOWED_ORIGINS.add(new URL(u).origin);
    console.log(`检测到自定义域名，手机 App 固定地址：${u}`);
  } catch {}
}

const gitBlobSha = buf => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

async function putFile(name, buf, sha) {
  const body = { message: `update ${name}`, content: buf.toString('base64'), ...(PAGES_BRANCH ? { branch: PAGES_BRANCH } : {}), ...(sha ? { sha } : {}) };
  await run('gh', ['api', '-X', 'PUT', `repos/${PUBLISH_REPO}/contents/${name}`, '--input', '-'], JSON.stringify(body));
}

async function remoteShas() {
  const spec = [`repos/${PUBLISH_REPO}/git/trees/${PAGES_BRANCH || 'HEAD'}?recursive=1`, '--jq', '.tree[] | select(.type=="blob") | [.path, .sha] | @tsv'];
  const out = await run('gh', ['api', ...spec]).catch(() => '');
  return new Map(out.split('\n').filter(Boolean).map(l => l.split('\t')));
}

function appFiles(dir = APP_DIR, prefix = '') {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (fs.statSync(abs).isDirectory()) out.push(...appFiles(abs, rel));
    else if (MIME[path.extname(name)] && rel !== 'url.json') out.push(rel);
  }
  return out;
}

// Keeps the GitHub Pages copy of the app identical to app/, uploading only files that changed.
async function syncApp() {
  const remote = await remoteShas();
  let changed = 0;
  for (const name of appFiles()) {
    const buf = fs.readFileSync(path.join(APP_DIR, name));
    if (remote.get(name) === gitBlobSha(buf)) continue;
    await putFile(name, buf, remote.get(name));
    changed++;
  }
  if (changed) console.log(`已同步 ${changed} 个 App 文件到 GitHub Pages`);
}

async function readUrlDoc() {
  const q = PAGES_BRANCH ? `?ref=${encodeURIComponent(PAGES_BRANCH)}` : '';
  try {
    const meta = JSON.parse(await run('gh', ['api', `repos/${PUBLISH_REPO}/contents/url.json${q}`]));
    const text = Buffer.from(String(meta.content || '').replace(/\n/g, ''), 'base64').toString('utf8');
    return { sha: meta.sha, json: JSON.parse(text) };
  } catch (e) {
    if (/404|Not Found/i.test(String(e.message || e))) return { sha: null, json: null };
    throw e;
  }
}

function registryWith(existing, mine) {
  let others = [];
  if (existing?.v === 3 && Array.isArray(existing.computers)) {
    others = existing.computers.filter(c => c && c.id && c.id !== mine.id && c.iv && c.data);
  } else if (existing?.v === 2 && existing.iv && existing.data && !opensEntry(existing)) {
    const id = crypto.createHash('sha256').update(String(existing.data)).digest().subarray(0, 8).toString('hex');
    others = [{ id, name: existing.name || '另一台电脑', iv: existing.iv, data: existing.data, updated: existing.updated }];
  }
  const computers = [...others, mine].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { v: 3, computers };
}

// Writes this computer's tunnel address into the shared url.json without removing the others.
async function publishUrl(url) {
  try {
    await syncApp();
  } catch (e) {
    console.log(`!! 同步 App 文件失败：${e.message}`);
  }
  if (!await waitReachable(url)) console.log('!! 新地址暂时无法从外网访问，仍然尝试发布');
  try {
    const mine = publishRecord(url);
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const cur = await readUrlDoc();
      try {
        await putFile('url.json', Buffer.from(JSON.stringify(registryWith(cur.json, mine)) + '\n'), cur.sha);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (!/409|does not match|sha/i.test(String(e.message))) break;
      }
    }
    if (lastErr) throw lastErr;
    console.log(`已发布最新地址（GitHub Pages 约 1 分钟后生效）。手机 App 固定地址：${appUrl()}`);
    offerFirstPairing();
  } catch (e) {
    console.log(`!! 发布地址失败：${e.message}`);
  }
}

function cloudflaredBin() {
  const local = path.join(os.homedir(), '.local', 'bin', 'cloudflared');
  if (fs.existsSync(local)) return local;
  return 'cloudflared';
}

function findTunnelPid() {
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      if (!/cloudflared/.test(line) || !new RegExp(`127\\.0\\.0\\.1:${PORT}\\b`).test(line)) continue;
      const pid = Number(line.trim().split(/\s+/)[0]);
      if (pid && pid !== process.pid) return pid;
    }
  } catch {}
  return 0;
}

// A quick tunnel URL changes only when its cloudflared process exits. Reuse a live one
// so restarting the relay keeps the same origin, and phones keep their saved device token.
async function publishedTunnel() {
  const url = String(readState().relayUrl || '').replace(/\/$/, '');
  if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(url) || !findTunnelPid()) return '';
  for (let i = 0; i < 8; i++) {
    try {
      const r = await fetch(`${url}/url.json`, { signal: AbortSignal.timeout(4000) });
      if (r.ok && (await r.json())?.self) return url;
    } catch {}
    await new Promise(r => setTimeout(r, 400));
  }
  return '';
}

function rememberTunnel(url) {
  saveState({ relayUrl: url });
  const pid = findTunnelPid();
  if (pid) fs.writeFileSync(path.join(DATA_DIR, 'tunnel.pid'), `${pid}\n`, { mode: 0o600 });
  return pid;
}

async function startTunnel() {
  const kept = await publishedTunnel();
  if (kept) {
    const pid = rememberTunnel(kept);
    console.log(`\n公网地址：${kept}`);
    if (PUBLISH_REPO) {
      console.log('沿用已有隧道，正在把地址发布到 GitHub Pages。');
      publishUrl(kept);
    } else {
      console.log('沿用已有隧道，已配对的手机不用重新配对。');
      if (pid) console.log(`隧道在后台运行（pid ${pid}）。要彻底关掉公网：kill ${pid}`);
      offerFirstPairing();
    }
    return;
  }
  const stale = findTunnelPid();
  if (stale) { try { process.kill(stale, 'SIGTERM'); } catch {} }
  const logPath = path.join(DATA_DIR, 'tunnel.log');
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(logPath, '');
  const fd = fs.openSync(logPath, 'a');
  const bin = cloudflaredBin();
  let child;
  let timer;
  const missing = () => console.log('!! 找不到 cloudflared。在这台电脑上执行：\nmkdir -p ~/.local/bin\ncurl -L --fail -o ~/.local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64\nchmod +x ~/.local/bin/cloudflared\n然后重新运行 npm run public');
  try {
    child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], {
      detached: true,
      stdio: ['ignore', fd, fd],
    });
  } catch (e) {
    fs.closeSync(fd);
    missing();
    return;
  }
  child.unref();
  fs.closeSync(fd);
  child.on('error', () => { if (timer) clearInterval(timer); missing(); });
  const started = Date.now();
  timer = setInterval(() => {
    let text = '';
    try { text = fs.readFileSync(logPath, 'utf8'); } catch { return; }
    const m = text.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/);
    if (!m) {
      if (Date.now() - started > 40000) {
        clearInterval(timer);
        console.log('!! 隧道超时没有拿到地址，查看 ~/.agent-remote/tunnel.log');
      }
      return;
    }
    clearInterval(timer);
    const url = m[0];
    const pid = rememberTunnel(url);
    console.log(`\n公网地址：${url}`);
    if (PUBLISH_REPO) publishUrl(url);
    else {
      console.log('这条地址会保留到隧道进程退出。之后重启服务会沿用它，已配对的手机不用重新配对。');
      if (pid) console.log(`要彻底关掉公网：kill ${pid}`);
      offerFirstPairing();
    }
  }, 400);
}

server.listen(PORT, TUNNEL ? '127.0.0.1' : HOST, async () => {
  console.log(`Remote Agent 已启动，端口 ${PORT}`);
  console.log(`数据目录：${DATA_DIR}`);
  console.log(`已配对 ${listDevices().length} 台设备。添加新设备：npm run pair`);
  detectAppUrl();
  startWatcher({
    listWindows,
    openCdp: async ws => { const c = new Cdp(ws); await c.connect(); return c; },
    probe: helpersCall('agentState()'),
  });
  try {
    const wins = await listWindows();
    console.log(`已连上 ${wins.length} 个窗口：${wins.map(w => `${w.app}:${w.title}`).join(' | ')}`);
  } catch (e) {
    console.log(`!! ${e.message}`);
  }
  if (TUNNEL) {
    console.log('正在建立 Cloudflare 公网隧道…');
    startTunnel();
  } else {
    const ips = Object.values(os.networkInterfaces()).flat()
      .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
    for (const ip of ips) console.log(`  局域网地址：http://${ip}:${PORT}/`);
    if (ips[0]) {
      saveState({ relayUrl: `http://${ips[0]}:${PORT}/` });
      offerFirstPairing();
    }
  }
});
