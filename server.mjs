import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { WebSocketServer } from 'ws';
import qrcode from 'qrcode-terminal';
import { workspaces, workspaceForTitle, fileSize, readFile, parseRef, listProject, locateWritable, writeTextFile } from './files.mjs';
import {
  DATA_DIR, encryptUrl, createPairing, pairingValid, consumePairing, listDevices, addDevice, findDevice, updateDevice,
  removeDevice, totpConfig, verifyTotp, needsTotp, saveState, readState, appBase,
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
const APP_ORIGIN = PUBLISH_REPO ? `https://${PUBLISH_REPO.split('/')[0].toLowerCase()}.github.io` : '';
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

  const clean = node => {
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
        const body = (lines.length ? lines.map(l => clean(l)).join('\n') : clean(content)).replace(/\n$/, '');
        out += `<div class="codebox"><textarea class="src" hidden readonly>${esc(plain)}</textarea><pre>${body}</pre></div>`;
        continue;
      }
      const tag = n.tagName;
      if (['STYLE', 'SCRIPT', 'BUTTON', 'svg', 'SVG', 'IMG'].includes(tag)) continue;
      if (tag === 'BR') { out += '<br>'; continue; }
      if (tag === 'HR') { out += '<hr>'; continue; }
      if (n.matches(FILE_REF)) { out += `<code data-file="${esc(n.innerText.trim())}"${colorAttr(n)}>${esc(n.innerText.trim())}</code>`; continue; }
      const inner = clean(n);
      const t = tag.toLowerCase();
      const paint = colorAttr(n);
      out += BLOCK.has(tag) || INLINE.has(tag) ? `<${t}${paint}>${inner}</${t}>` : (paint && inner ? `<span${paint}>${inner}</span>` : inner);
    }
    return out;
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
      : el.querySelector('.self-start');
  const thinkingPlain = el => (thinkingBodyEl(el)?.textContent || '').replace(/\u00a0/g, ' ').trim();
  const thinkingTitleOf = el => (thinkingHeaderEl(el)?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const thinkingLive = el => el.classList.contains('chat-thinking-active')
    || !!el.querySelector('[data-loading]')
    || /^thinking\b/i.test(thinkingTitleOf(el));
  // Phone shows the moving tail, not the whole trace in one shot when thinking ends.
  const thinkingTail = plain => {
    const lines = String(plain || '').split('\n').map(s => s.trimEnd()).filter(s => s.trim());
    const tail = (lines.length ? lines.slice(-6) : []).join('\n');
    return tail.slice(-500);
  };
  const thinkingNodes = () => [...document.querySelectorAll(THINKING_ROOT)].filter(el => el.matches('.ui-thinking-collapsible, .chat-thinking-box') || /^(thinking|thoughts|thought(?: for)? )\b/i.test(thinkingTitleOf(el)));
  const closedThinkingIndexes = () => thinkingNodes().flatMap((el, i) => {
    if (!thinkingLive(el) || thinkingPlain(el)) return [];
    const header = thinkingToggleEl(el);
    if (!header || header.getAttribute('aria-expanded') === 'true') return [];
    return [i];
  }).slice(0, 4);
  const clickThinking = indexes => {
    const nodes = thinkingNodes();
    for (const i of indexes || []) nodes[i] && thinkingToggleEl(nodes[i])?.click();
    return true;
  };
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
  const isBusy = () => !!stopGenerationButton() || !!legacyStopIcon();

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
  const questionTarget = (qi, oi, part) => {
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
  const changedCount = () => parseInt(filesToggle()?.innerText || '0', 10) || 0;
  const changedRows = () => [...document.querySelectorAll('.composer-file-list-item')].filter(vis);
  const changedFiles = () => changedRows().map(r => {
    const stat = [...r.querySelectorAll('.tabular-nums span')].map(s => s.innerText.trim());
    return {
      name: r.querySelector('span[style*="nowrap"]')?.innerText.trim() || r.innerText.trim().split('\n')[0],
      add: stat.find(s => s.startsWith('+')) || '',
      del: stat.find(s => /^[-−]/.test(s)) || '',
    };
  });
  const filesBar = () => {
    let t = filesToggle();
    while (t && !t.querySelector('[data-click-ready]')) t = t.parentElement;
    return t;
  };
  // Bar-level actions besides Stop (handled elsewhere) and Review (desktop-only diff view), e.g. Keep All / Undo All.
  const fileBarButtons = () => [...(filesBar()?.querySelectorAll('[data-click-ready]') || [])].filter(vis)
    .map(e => ({ el: e, label: (e.querySelector('.truncate') || e).innerText.trim() }))
    .filter(x => x.label && !/^(stop|review)$/i.test(x.label));
  const filesState = () => ({ files: changedFiles(), actions: fileBarButtons().map(x => x.label) });
  const fileTarget = (i, name, act) => {
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
  const DEVIN_MODEL = /^(SWE|GPT|Claude|Gemini|GLM|Kimi)\b/;
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

  const thinkingItem = (el, host, n) => {
    const title = thinkingTitleOf(el) || '思考';
    const tail = thinkingTail(thinkingPlain(el));
    const base = itemKey(host && host !== el ? host : el) || 'row';
    const item = { i: `${base}:think:${n}`, k: 'thinking', t: tail ? `${title}\n${tail}` : title };
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
      const tail = thinkingTail(plain);
      item.t = tail ? `${title}\n${tail}` : title;
      if (/^thinking\b/i.test(action) || el.querySelector('[data-loading]')) item.live = true;
      return item;
    }
    const readable = el.querySelector('.aislash-editor-input-readonly, .composer-human-message') || withoutThinking(el);
    if (k === 'human') item.t = readable.innerText.trim();
    else if (k === 'assistant') {
      const md = [...el.querySelectorAll('.markdown-root, .ui-markdown, .rendered-markdown')].find(n => !n.closest(THINKING_ROOT));
      item.h = md ? clean(md) : esc((withoutThinking(el).innerText || '').trim()).replace(/\n/g, '<br>');
    }
    else item.t = summary(withoutThinking(el));
    if (k === 'tool') { const f = toolFile(el); if (f) item.f = f; }
    const b = buttonsIn(el, false).filter(x => !x.el.closest(THINKING_ROOT));
    if (b.length) item.b = b.map(x => x.label);
    return item;
  };

  const extract = () => {
    const panel = findPanel();
    // A brand-new Devin session has a composer and model chip, but no message list yet.
    if (!panel) {
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
        readonly: !hasComposer(),
        mode: null,
        model: modelEl ? normLabel(modelEl.innerText).split('\n')[0].slice(0, 60) : null,
        context: contextPct(),
      };
    }
    const r = panel.getBoundingClientRect();
    const items = topItems(panel).flatMap(el => {
      const thoughts = thinkingInside(el).map((th, n) => thinkingItem(th, el, n));
      if (isThinking(el)) return thoughts.length ? thoughts : [thinkingItem(el, el, 0)];
      const main = messageItem(el);
      if (main.k === 'assistant' && !main.h && !main.b) return thoughts;
      return [...thoughts, main];
    });
    const global = buttonsIn(panel, true).filter(x => !inItem(x.el) && !inQn(x.el) && !/^stop generation\b/i.test(x.label)).map(x => x.label);
    const modeEl = [...document.querySelectorAll('.composer-unified-dropdown[data-mode]')].find(vis);
    const modelEl = modelButton();
    return {
      rect: [r.x, r.y, r.width, r.height].map(Math.round),
      items,
      global,
      busy: isBusy(),
      queued: queued(),
      subagents: subagents(),
      changed: changedCount(),
      questions: questions(),
      readonly: !hasComposer(),
      mode: modeEl ? modeEl.innerText.trim() || modeEl.dataset.mode : null,
      model: modelEl ? normLabel(modelEl.innerText).split('\n')[0].slice(0, 60) : null,
      context: contextPct(),
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

  const MENU_ITEMS = {
    mode: () => [...document.querySelectorAll('.composer-unified-context-menu-item')].map(e => ({ el: e, label: e.innerText.trim().split('\n')[0], checked: !!e.querySelector('.codicon-check') })),
    model: () => {
      const classic = [...document.querySelectorAll('.ui-menu__row')].filter(e => e.querySelector('.ui-model-picker__item-content-name'));
      if (classic.length) return classic.map(e => ({ el: e, id: e.dataset.testid, params: !!e.querySelector('[data-testid=parameter-edit-btn]'), label: normLabel(e.querySelector('.ui-model-picker__item-content-name').innerText), checked: !!e.querySelector('.codicon-check, .ui-model-picker__item-right-section [class*=check]') }));
      const cursorItems = [...document.querySelectorAll('[data-testid^="model-item-"], [data-testid="auto-mode-select"]')].filter(vis).map(e => ({
        el: e,
        id: e.getAttribute('data-testid'),
        params: false,
        label: normLabel(e.innerText).split('\n')[0].slice(0, 60),
        checked: !!e.querySelector('[class*=check]') || e.getAttribute('aria-checked') === 'true',
      }));
      if (cursorItems.length) return cursorItems;
      const pop = devinModelMenu();
      if (!pop) return [];
      const current = normLabel(devinModelButton()?.innerText || '');
      return [...pop.querySelectorAll('button')].filter(vis).map(e => {
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

  const menuItems = kind => (MENU_ITEMS[kind]?.() || []).filter(x => vis(x.el) && x.label).map(({ el, ...rest }) => rest);

  const menuOpen = () => [...document.querySelectorAll('.ui-menu, .composer-unified-context-menu-item, .composer-history-hover-menu')].some(vis) || !!devinModelMenu();
  const modelListTrigger = () => {
    const e = [...document.querySelectorAll('[role=menuitem]')].find(el => vis(el) && /^Model\b/.test(normLabel(el.innerText)));
    return e ? center(e) : null;
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

  const panelRect = () => {
    const p = findPanel();
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
    return [...document.querySelectorAll('.terminal-tabs-list .terminal-tab')].filter(vis).map((tab, i) => ({
      id: tab.id || `classic-${i}`,
      title: (tab.querySelector('.label-name, a') || tab).innerText.trim().split('\n')[0].slice(0, 80) || `终端 ${i + 1}`,
      current: tab.classList.contains('active') || tab.getAttribute('aria-selected') === 'true',
      tab,
      close: tab.querySelector('[aria-label="Kill Terminal"], [aria-label^="Kill"]'),
    }));
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
  const terminalRect = () => {
    const el = [...document.querySelectorAll('.terminal-wrapper.active .xterm, .terminal.xterm')].find(vis);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height].map(Math.round);
  };
  const terminalFocus = () => {
    const el = [...document.querySelectorAll('.terminal-wrapper.active .xterm, .terminal.xterm')].find(vis);
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
  const settingsOpen = () => !!labeled('Close Settings');
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
  const terminalDump = prev => {
    const host = document.querySelector('.terminal-wrapper.active .xterm-wrapper') || document.querySelector('.xterm-wrapper');
    const term = host?.xterm;
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
    terminalList, terminalTarget, terminalCloseTarget, terminalRect, terminalFocus, newTerminalDirect, newTerminalMenu, newTerminalItem, terminalDump, modelListTrigger,
    settingsOpen, openSettingsTarget, closeSettingsTarget, readSettings, settingTarget, usageNavTarget, readUsage,
    menuOpen, maxToggle, modelTarget, modelParams, paramTarget, subTarget, activeChatTab, tabTarget, hasComposer, filesState, fileTarget, questionTarget,
    closedThinkingIndexes, clickThinking, closeThinkingIfOpen };
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
      await this.cdp.send('Page.stopScreencast').catch(() => {});
      this.lastChat = '';
      this.chatTimer = setInterval(() => this.pollChat().catch(() => {}), 700);
      await this.pollChat();
    } else if (this.mode === 'terminal') {
      await this.cdp.send('Page.stopScreencast').catch(() => {});
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

  rememberThinking(chat) {
    for (const it of chat?.items || []) {
      if (it.k !== 'thinking') continue;
      const tail = (it.t || '').split('\n').slice(1).join('\n');
      if (tail) this.thinking.set(it.i, { tail });
    }
    while (this.thinking.size > 40) this.thinking.delete(this.thinking.keys().next().value);
  }

  fillThinking(chat) {
    for (const it of chat?.items || []) {
      if (it.k !== 'thinking') continue;
      const title = (it.t || '').split('\n')[0];
      const tail = (it.t || '').split('\n').slice(1).join('\n');
      const hit = this.thinking.get(it.i);
      // A finished block unmounts its body. Keep the tail already streamed, don't load the full trace.
      if (!tail && hit?.tail) it.t = `${title}\n${hit.tail}`;
      delete it.closed;
      delete it.h;
    }
  }

  async pollChat() {
    if (!this.cdp || this.polling) return;
    this.polling = true;
    try {
      let chat = await this.cdp.evaluate(helpersCall('extract()'));
      this.fillThinking(chat);
      const live = (chat?.items || []).some(it => it.live && !(it.t || '').includes('\n'));
      if (live) {
        const idxs = await this.cdp.evaluate(helpersCall('closedThinkingIndexes()'));
        if (idxs?.length) {
          await this.cdp.evaluate(helpersCall(`clickThinking(${JSON.stringify(idxs)})`));
          await new Promise(r => setTimeout(r, 250));
          chat = await this.cdp.evaluate(helpersCall('extract()'));
          this.fillThinking(chat);
        }
      }
      this.rememberThinking(chat);
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
      if (this.lastTermHash !== null) {
        this.lastTermHash = null;
        this.emit({ t: 'termText', lines: null });
      }
    } else if (dump.hash !== this.lastTermHash) {
      this.lastTermHash = dump.hash;
      if (dump.lines) this.emit({ t: 'termText', lines: dump.lines, cursor: dump.cursor });
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
    const lines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await this.cdp.send('Input.insertText', { text: lines[i] });
      if (i < lines.length - 1 || lines[i]) await this.key('Enter');
    }
  }

  async ensureSettings() {
    if (await this.cdp.evaluate(helpersCall('settingsOpen()'))) return;
    const pos = await this.cdp.evaluate(helpersCall('openSettingsTarget()'));
    if (!pos) throw new Error('找不到设置按钮');
    await this.tapCss(pos.x, pos.y);
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 150));
      if (await this.cdp.evaluate(helpersCall('settingsOpen()'))) return;
    }
    throw new Error('设置没有打开');
  }

  async closeSettings() {
    const pos = await this.cdp.evaluate(helpersCall('closeSettingsTarget()'));
    if (pos) await this.tapCss(pos.x, pos.y);
  }

  async showSettings() {
    await this.ensureSettings();
    let sections = [];
    try { sections = await this.cdp.evaluate(helpersCall('readSettings()')) || []; }
    finally { await this.closeSettings(); }
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
  async withFiles(fn) {
    const state = () => this.cdp.evaluate(helpersCall('filesState()'));
    let s = await state();
    const opened = !s.files.length;
    if (opened) {
      const t = await this.cdp.evaluate(helpersCall('fileTarget(0, "", "toggle")'));
      if (!t) return fn(s);
      await this.tapCss(t.x, t.y);
      for (let i = 0; i < 8 && !s.files.length; i++) {
        await new Promise(r => setTimeout(r, 120));
        s = await state();
      }
    }
    try {
      return await fn(s);
    } finally {
      const t = opened && await this.cdp.evaluate(helpersCall('fileTarget(0, "", "toggle")'));
      if (t && (await state()).files.length) await this.tapCss(t.x, t.y);
    }
  }

  async listChanges() {
    const s = await this.withFiles(async s => s);
    this.emit({ t: 'changes', ...s });
  }

  async changeAction(i, name, act) {
    if (!['keep', 'undo', 'bar'].includes(act)) throw new Error('不支持的操作');
    await this.withFiles(async () => {
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
    });
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
    const list = await this.cdp.evaluate(helpersCall('agentList()'));
    this.emit({ t: 'agents', list: list || [] });
  }

  async openAgent(id) {
    if (!id || id.length > 200) throw new Error('这条 Agent 已经不在列表里');
    const pos = await this.cdp.evaluate(helpersCall(`agentTarget(${JSON.stringify(id)})`));
    if (!pos) throw new Error('这条 Agent 已经不在列表里');
    await this.tapCss(pos.x, pos.y);
    this.thinking?.clear();
    this.thinkingTried?.clear();
    this.lastChat = '';
    this.emit({ t: 'status', ok: true, msg: '已切换 Agent' });
    setTimeout(() => this.pollChat().catch(() => {}), 500);
  }

  async pressControl(name) {
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
        const sub = await this.cdp.evaluate(helpersCall('modelListTrigger()'));
        if (sub) await this.tapCss(sub.x, sub.y);
      }
    }
    const max = kind === 'model' ? await this.cdp.evaluate(helpersCall('maxToggle()?.on ?? null')) : null;
    await this.closeMenus();
    this.emit({ t: 'menu', kind, items, max });
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
    setTimeout(() => this.pollChat().catch(() => {}), 500);
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
    const isAbs = /^(\/|~\/)/.test(p);
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

  async openFile(text) {
    this.emit({ t: 'file', loading: true, name: path.posix.basename(parseRef(text).p) });
    try {
      const f = await this.resolveFile(text);
      const body = await readFile(f.host, f.path, f.size);
      this.emit({ t: 'file', name: path.posix.basename(f.path), path: f.path, host: f.host, size: f.size, line: f.line, editable: Boolean(body.text) && !body.truncated, ...body });
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
      cdp.send('Page.stopScreencast').catch(() => {}).finally(() => cdp.close());
    }
  }

  async refreshViewport() {
    const v = await this.cdp.evaluate('({ w: innerWidth, h: innerHeight })');
    if (v) this.viewport = v;
  }

  async startScreencast() {
    await this.cdp.send('Page.startScreencast', { ...this.screencast, everyNthFrame: 1 });
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
  }

  async typeText(text) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await this.key('Shift+Enter');
      if (lines[i]) await this.cdp.send('Input.insertText', { text: lines[i] });
    }
  }

  async sendMessage(text, submit) {
    const found = await this.cdp.evaluate(FOCUS_COMPOSER);
    if (!found) throw new Error('没找到可见的聊天输入框：先在画面里打开 Agent 面板（或点「打开聊天」）');
    const busy = submit && await this.cdp.evaluate(helpersCall('agentState()?.busy'));
    await this.typeText(text);
    if (submit) await this.key('Enter');
    if (this.mode === 'chat') setTimeout(() => this.pollChat().catch(() => {}), 300);
    return Boolean(busy);
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
      case 'newChat': return this.pressControl('newChat');
      case 'file': return this.openFile(String(msg.path ?? ''));
      case 'saveFile': return this.saveFile(String(msg.path ?? ''), String(msg.text ?? ''));
      case 'click': return this.clickButton(msg.item, msg.n);
      case 'queue': return msg.action === 'edit' ? this.editQueued(msg.id, String(msg.text ?? '')) : this.queueAction(msg.id, msg.action);
      case 'stop': return this.stopAgent();
      case 'subagent': return this.subagentAction(msg.name, msg.part === 'stop' ? 'stop' : 'open');
      case 'mainChat': return this.backToMain();
      case 'image': return this.attachImage(msg.data, msg.name, msg.type);
      case 'question': return this.answerQuestion(msg.qi, msg.oi, ['option', 'submit', 'skip'].includes(msg.part) ? msg.part : 'option', msg.text);
      case 'changes': return this.listChanges();
      case 'change': return this.changeAction(msg.i, msg.name, msg.act);
      case 'scrollChat': return this.scrollChat(Number(msg.dy) || 0);
      case 'tap': return this.tap(msg.x, msg.y, msg.button);
      case 'wheel': return this.wheel(msg.x, msg.y, msg.dx || 0, msg.dy || 0);
      case 'key': return this.key(String(msg.key || ''), { focusTerminal: msg.focus === 'terminal' });
      case 'type': return this.typeText(String(msg.text ?? ''));
      case 'send': return this.sendMessage(String(msg.text ?? ''), msg.submit !== false);
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
    return json(req, res, 200, { paired: Boolean(device), needTotp: needsTotp(device), totp: Boolean(totpConfig()) });
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
    return json(req, res, 200, { token });
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
  const [owner, repo] = PUBLISH_REPO.split('/');
  return `https://${owner.toLowerCase()}.github.io/${repo}/`;
}

const gitBlobSha = buf => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

async function putFile(name, buf, sha) {
  const body = { message: `update ${name}`, content: buf.toString('base64'), ...(sha ? { sha } : {}) };
  await run('gh', ['api', '-X', 'PUT', `repos/${PUBLISH_REPO}/contents/${name}`, '--input', '-'], JSON.stringify(body));
}

async function remoteShas() {
  const out = await run('gh', ['api', `repos/${PUBLISH_REPO}/contents`, '--jq', '.[] | [.name, .sha] | @tsv']).catch(() => '');
  return new Map(out.split('\n').filter(Boolean).map(l => l.split('\t')));
}

// Keeps the GitHub Pages copy of the app identical to app/, uploading only files that changed.
async function syncApp() {
  const remote = await remoteShas();
  let changed = 0;
  for (const name of fs.readdirSync(APP_DIR)) {
    if (!MIME[path.extname(name)] || name === 'url.json') continue;
    const buf = fs.readFileSync(path.join(APP_DIR, name));
    if (remote.get(name) === gitBlobSha(buf)) continue;
    await putFile(name, buf, remote.get(name));
    changed++;
  }
  if (changed) console.log(`已同步 ${changed} 个 App 文件到 GitHub Pages`);
}

// Writes the current tunnel address (encrypted) to url.json, so the app on GitHub Pages can find this relay.
async function publishUrl(url) {
  try {
    await syncApp();
  } catch (e) {
    console.log(`!! 同步 App 文件失败：${e.message}`);
  }
  if (!await waitReachable(url)) console.log('!! 新地址暂时无法从外网访问，仍然尝试发布');
  try {
    const remote = await remoteShas();
    await putFile('url.json', Buffer.from(JSON.stringify(encryptUrl(url)) + '\n'), remote.get('url.json'));
    console.log(`已发布最新地址（GitHub Pages 约 1 分钟后生效）。手机 App 固定地址：${appUrl()}`);
    offerFirstPairing();
  } catch (e) {
    console.log(`!! 发布地址失败：${e.message}`);
  }
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
  let child;
  try {
    child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], {
      detached: true,
      stdio: ['ignore', fd, fd],
    });
  } catch (e) {
    fs.closeSync(fd);
    console.log(`!! 找不到 cloudflared：${e.message}`);
    return;
  }
  child.unref();
  fs.closeSync(fd);
  child.on('error', () => console.log('!! 找不到 cloudflared，请先安装到 ~/.local/bin 或 PATH 里'));
  const started = Date.now();
  const timer = setInterval(() => {
    let text = '';
    try { text = fs.readFileSync(logPath, 'utf8'); } catch { return; }
    const m = text.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/);
    if (!m) {
      if (Date.now() - started > 40000) {
        clearInterval(timer);
        console.log('!! 隧道超时没有拿到地址，查看 ~/.cursor-remote-lite/tunnel.log');
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
  console.log(`已配对 ${listDevices().length} 台设备。添加新设备：npm run pair`);
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
