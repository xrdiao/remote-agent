import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { WebSocketServer } from 'ws';
import qrcode from 'qrcode-terminal';
import { workspaces, windowRoots, workspaceLabel, fileSize, readFile, parseRef, listProject, locateWritable, writeTextFile, resolveLocal } from './files.mjs';
import { themeFor } from './theme.mjs';
import { highlightText, warmHighlighter } from './highlight.mjs';
import { gitMarks, agentMarks, parseGitDiff } from './marks.mjs';
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
const CODEX_CDP_URL = (process.env.CODEX_CDP_URL || 'http://127.0.0.1:9224').replace(/\/$/, '');
const EDITORS = [
  { app: 'cursor', name: 'Cursor', url: CDP_URL },
  { app: 'devin', name: 'Devin', url: DEVIN_CDP_URL },
  { app: 'codex', name: 'Codex', url: CODEX_CDP_URL },
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

async function listWindows(report = null) {
  const lists = await Promise.all(EDITORS.map(async ed => {
    try {
      if (ed.app === 'codex') {
        const pages = await codexWindows(ed.url, !!report);
        report?.push({ app: ed.app, windows: pages.length, address: ed.url });
        if (!pages.length) return [];
        // Several VS Code windows are agents inside one Codex entry, not separate phone windows.
        return [{ id: 'codex', title: 'Codex', ws: pages[0].ws, port: ed.url, app: 'codex', kind: 'local' }];
      }
      const targets = await (await fetch(`${ed.url}/json/list`, { signal: AbortSignal.timeout(1500) })).json();
      const found = targets
        .filter(t => t.type === 'page' && /workbench/.test(t.url))
        .map(t => ({
          id: `${ed.app}:${t.id}`,
          title: t.title,
          ws: t.webSocketDebuggerUrl,
          port: ed.url,
          app: ed.app,
          kind: t.title === 'Cursor Agents' ? 'agents' : /\[SSH: /.test(t.title) ? 'ssh' : 'local',
        }))
        // Devin names a real window after its folder. A bare "Devin" title is an empty New Space.
        .filter(t => !(ed.app === 'devin' && process.platform !== 'win32' && t.title === 'Devin'));
      report?.push({ app: ed.app, windows: found.length, address: ed.url });
      return found;
    } catch (error) {
      report?.push({ app: ed.app, windows: 0, address: ed.url, error: String(error), timeout: error.name === 'TimeoutError' });
      return [];
    }
  }));
  const wins = lists.flat();
  if (!wins.length) throw new Error('连不上 Cursor、Devin 或 Codex。Cursor 用调试端口 9222，Devin 用 ./start-devin.sh（端口 9223），Codex 用 ./start-codex.sh（端口 9224）');
  wins.push({ id: 'fusion', title: 'Fusion', ws: '', port: '', app: 'fusion', kind: 'local' });
  return wins;
}

function phoneWindows(wins, current) {
  const devin = wins.find(w => w.app === 'devin' && w.id === current) || wins.find(w => w.app === 'devin');
  return wins.filter(w => process.platform !== 'win32' || w.app !== 'devin' || w === devin)
    .map(({ id, title, kind, app }) => ({ id, title: process.platform === 'win32' && app === 'devin' ? 'Devin' : title, kind, app }));
}

const FUSION_ACTIVE = ['planning', 'echo', 'echo-check', 'execute', 'review', 'fix'];
const fusionHistory = readState().fusionHistory || {};
const conversationProjects = readState().conversationProjects || {};
const fusionWorkers = new Map();
const fusionViewers = new Set();
for (const saved of Object.values(fusionHistory)) {
  for (const run of saved.runs || []) if (FUSION_ACTIVE.includes(run.phase)) run.phase = 'idle';
}
function newFusionRun() {
  return { id: crypto.randomUUID(), created: Date.now(), updated: Date.now(), history: [], turn: 0,
    project: null, a: null, b: null, phase: 'idle', round: 0, miss: 0, task: '', plan: '', brief: '', echo: '', result: '', diff: '', review: '' };
}

function fusionCursorProjects() {
  const projects = new Map();
  for (const w of workspaces().filter(w => !w.host && (w.sources || [w.source]).includes('cursor'))) {
    try {
      const remote = execFileSync('git', ['-C', w.root, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const repository = remote.replace(/^\w+:\/\//, '').replace(/^.*@/, '').replace(':', '/').replace(/\.git$/, '').replace(/\/$/, '');
      const project = fusionProject(w.root);
      if (!projects.has(repository)) projects.set(repository, project);
      else if (projects.get(repository)?.id !== project.id) projects.set(repository, null);
    } catch { continue; }
  }
  return projects;
}

function fusionProject(root, host = '') {
  if (!root || !path.isAbsolute(root)) return null;
  root = host ? path.posix.normalize(root) : fs.existsSync(root) ? fs.realpathSync(root) : path.normalize(root);
  root = root.replace(/\\/g, '/');
  const key = !host && process.platform === 'win32' ? root.toLowerCase() : root;
  return { id: JSON.stringify([host, key]), root, host, name: path.posix.basename(root) || root };
}
function fusionModelSpec(model) {
  const [label, effort = ''] = String(model || '').split(' · ');
  return { model: String(model || ''), modelLabel: label, modelEffort: effort };
}

function fusionHtml(text) {
  return String(text || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/\n/g, '<br>');
}

function fusionMark(text) {
  const raw = String(text || '');
  const m = /(?:^|\n)[ \t]*FUSION:[ \t]*(done|fix-brief|fix|return|go)[ \t]*\s*$/i.exec(raw);
  if (!m) return { kind: '', body: raw.trim() };
  return { kind: m[1].toLowerCase(), body: (raw.slice(0, m.index) + raw.slice(m.index + m[0].length)).trim() };
}

function fusionLastAssistant(chat, after = '') {
  const items = chat?.items || [];
  const start = after ? items.findIndex(x => x.i === after) + 1 : 0;
  if (after && !start) return { i: '', text: '' };
  const it = items.slice(start).reverse().find(x => x.k === 'assistant' && (x.t || x.h));
  if (!it) return { i: '', text: '' };
  const text = it.t || String(it.h || '').replace(/<br\s*\/?>|<\/(?:p|div)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').trim();
  return { i: it.i || '', text, completed: it.completed };
}

// Each VS Code window has its own Codex sidebar. The phone shows one Codex window and lists these as agents.
const codexViewIds = new Map();
const codexContextFiles = new Map();

function windowsCodexContext(thread) {
  if (!thread) return null;
  const sessions = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  let file = codexContextFiles.get(thread);
  if (!file) {
    const relative = fs.readdirSync(sessions, { recursive: true }).find(name => name.endsWith(`-${thread}.jsonl`));
    if (!relative) return null;
    file = path.join(sessions, relative);
    codexContextFiles.set(thread, file);
  }
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const row = JSON.parse(lines[i]);
    if (row.type !== 'event_msg' || row.payload.type !== 'token_count' || !row.payload.info) continue;
    const info = row.payload.info;
    if (!info.model_context_window) return null;
    return { pct: Math.round(Math.min(100, info.last_token_usage.total_tokens / info.model_context_window * 100)), basis: 'used' };
  }
  return null;
}

function codexFolder(title) {
  if (process.platform === 'win32') title = String(title || '').replace(/\s+\[(?:Administrator|Administer)\]$/i, '');
  const parts = String(title || '').replace(/\s+-\s+Visual Studio Code$/, '').split(' - ').map(s => s.trim()).filter(Boolean);
  if (parts[0] === 'Welcome' && parts.length > 1) return parts[parts.length - 1];
  return (parts.length > 1 ? parts[parts.length - 1] : parts[0]) || 'Codex';
}

async function webviewKey(wsUrl) {
  const cdp = new Cdp(wsUrl);
  try {
    await cdp.connect();
    const src = await cdp.evaluate(`document.querySelector('iframe[src*="extensionId=openai.chatgpt"][src*="purpose=webviewView"]')?.src || ''`);
    return /[?&]id=([^&]+)/.exec(String(src))?.[1] || '';
  } catch {
    return '';
  } finally {
    try { cdp.close(); } catch {}
  }
}

async function codexWindows(base, reportErrors = false) {
  let targets = [];
  try {
    targets = await (await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(1500) })).json();
  } catch (error) {
    if (reportErrors) throw error;
    return [];
  }
  const pages = targets.filter(t => t.type === 'page' && /workbench/.test(t.url || ''));
  const viewByKey = new Map();
  for (const v of targets) {
    if (!v.webSocketDebuggerUrl || !/extensionId=openai\.chatgpt/.test(v.url || '') || !/purpose=webviewView/.test(v.url || '')) continue;
    const key = /[?&]id=([^&]+)/.exec(v.url || '')?.[1];
    if (key) viewByKey.set(key, v.webSocketDebuggerUrl);
  }
  const out = [];
  for (const p of pages) {
    let key = codexViewIds.get(p.id);
    if (!key || !viewByKey.has(key)) {
      key = await webviewKey(p.webSocketDebuggerUrl);
      if (key) codexViewIds.set(p.id, key);
    }
    out.push({
      pageId: p.id,
      title: codexFolder(p.title),
      rawTitle: p.title || '',
      ws: p.webSocketDebuggerUrl,
      chatWs: viewByKey.get(key) || null,
    });
  }
  return out;
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

  send(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('CDP 调用超时: ' + method));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    this.handlers.set(method, fn);
  }

  async evaluate(expression, opts = {}) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, opts.timeout ?? 30000);
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
  '`': { code: 'Backquote', vk: 192, text: '`' },
};

// Cursor's chat composer is a ProseMirror contenteditable; selectors ordered from most to least specific.
const FOCUS_COMPOSER = `(() => {
  // Codex draws its prompt inside a same-origin iframe. Cursor and Devin use this page.
  const doc = document.getElementById('active-frame')?.contentDocument || document;
  // Same reveal as pageHelpers.revealDevinComposer: a new Devin session's prompt
  // stays in a hidden welcome layer while a file tab is open.
  for (const group of doc.querySelectorAll('.editor-group-container')) {
    if (group.classList.contains('has-pending-new-session-welcome')) continue;
    for (const el of group.querySelectorAll('[data-crl-devin-reveal]')) {
      el.style.removeProperty('display');
      el.removeAttribute('data-crl-devin-reveal');
    }
  }
  for (const group of doc.querySelectorAll('.editor-group-container.has-pending-new-session-welcome')) {
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
  const selectors = ['.aislash-editor-input[contenteditable="true"]', '.ui-prompt-input-editor__input[contenteditable="true"]', '.ProseMirror[contenteditable="true"]', '.composer-bar [contenteditable="true"]', '.auxiliarybar [contenteditable="true"]'];
  let eds = [];
  for (const s of selectors) { eds = [...doc.querySelectorAll(s)].filter(visible); if (eds.length) break; }
  if (!eds.length) eds = [...doc.querySelectorAll('[contenteditable="true"]')].filter(e => visible(e) && !e.closest('.monaco-editor, [aria-label="User message"], [aria-label="Devin message"]'));
  if (!eds.length) return null;
  const selId = doc.querySelector('[data-sidebar-item-key] [data-active="true"]')?.closest('[data-sidebar-item-key]')?.getAttribute('data-sidebar-item-key')?.slice(4);
  const el = eds.find(e => e.contains(doc.activeElement)) || (selId && eds.find(e => e.closest('[data-glass-agent-id]')?.getAttribute('data-glass-agent-id') === selId)) || eds[eds.length - 1];
  el.focus();
  const range = doc.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = doc.defaultView.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
})()`;

// Cursor accepts images pasted into the composer; a synthetic paste event carrying a File works the same way.
const pasteImage = (b64, name, type) => `(async () => {
  if (!${FOCUS_COMPOSER}) return null;
  const doc = document.getElementById('active-frame')?.contentDocument || document;
  const ed = doc.activeElement.closest('[contenteditable="true"]') || doc.activeElement;
  let box = ed;
  for (let i = 0; i < 8 && box.parentElement; i++) box = box.parentElement;
  const nodes = () => [...doc.querySelectorAll('.context-pill-image, .image-pill-img, img[alt="Attached image"], .agent-panel-composer-pill')];
  const before = new Set(nodes());
  const beforeImages = box.querySelectorAll('img').length;
  const html = ed.innerHTML;
  const bin = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0));
  const dt = new doc.defaultView.DataTransfer();
  dt.items.add(new doc.defaultView.File([bin], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
  ed.dispatchEvent(new doc.defaultView.ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  for (let i = 0; i < 30; i++) {
    if (nodes().some(el => !before.has(el))) return true;
    if (ed.innerHTML !== html && /<img|blob:|Attached image/i.test(ed.innerHTML)) return true;
    if (box.querySelectorAll('img').length > beforeImages) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return nodes().some(el => !before.has(el));
})()`;

// Runs inside Cursor's renderer (injected via toString). Emits only whitelisted tags with escaped text, never raw DOM HTML.
function pageHelpers() {
  const workspaceTrustState = () => {
    const dialogs = [...document.querySelectorAll('.monaco-dialog-box, [role="dialog"]')].filter(vis);
    const dialog = dialogs.find(e => /trust the authors|信任.*作者/i.test(e.innerText || ''));
    const editor = [...document.querySelectorAll('.workspace-trust-editor')].find(vis);
    const area = dialog || editor;
    const buttons = area ? [...area.querySelectorAll('button, .monaco-button, [role="button"]')].filter(vis) : [];
    const point = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
    const trust = buttons.find(b => /^(Yes, I trust the authors|Trust(?: Folder| Workspace)?|是，我信任|信任(?:此)?(?:文件夹|工作区|作者)?)/i.test((b.innerText || b.getAttribute('aria-label') || '').trim()));
    const decline = buttons.find(b => /^(No, I don.t trust|Don.t Trust|不.*信任|否)/i.test((b.innerText || b.getAttribute('aria-label') || '').trim()));
    const restricted = [...document.querySelectorAll('.statusbar-item, .monaco-workbench .banner')].find(e => vis(e) && /Restricted Mode|限制模式|受限模式/i.test(e.innerText || e.getAttribute('aria-label') || ''));
    return { required: !!dialog || !!restricted || !!trust, trust: point(trust), decline: point(decline), manage: point(restricted) };
  };
  // Codex draws inside a same-origin iframe. Cursor and Devin use this page.
  const doc = document.getElementById('active-frame')?.contentDocument || document;
  const vis = e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const SKIP = /ui-collapsible-header|md-clickable-code|output-preview|codicon-find|widget-close|model-picker/;
  const ACTION = /^(run|skip|allow|accept|reject|deny|approve|keep|undo|continue|stop|cancel|build|retry|yes|no\b|运行|跳过|允许|接受|拒绝|继续|停止|取消)/i;
  const BLOCK = new Set(['P', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'DIV']);
  const INLINE = new Set(['STRONG', 'B', 'EM', 'I', 'CODE', 'DEL']);
  const CODE_BLOCK = '.composer-code-block-container, .composer-message-codeblock, .ui-code-block, pre, [data-markdown-copy="code-block"]';
  const FILE_REF = 'code.md-inline-path-filename-like';

  // Edit/read tool cards keep the absolute path in the header's title; fall back to the shown file name.
  const toolFile = el => {
    const titled = [...el.querySelectorAll('[title]')].map(e => e.getAttribute('title')).find(t => /^(\/|~\/|[A-Za-z]:\\)\S+$/.test(t));
    return titled || el.querySelector('.ui-edit-tool-call__filename')?.innerText.trim() || null;
  };

  // Older Cursor builds mark each transcript row with data-flat-index. The Agents window in
  // current builds uses data-message-kind instead, and past bubbles contain their own editors.
  const ITEM_SEL = '[data-flat-index], [data-message-kind], [data-turn-key], [role=group][aria-label="User message"], [role=group][aria-label="Devin message"]';
  const COMPOSER = '.aislash-editor-input, .ui-prompt-input-editor__input, .ProseMirror';
  const inItem = el => !!el.closest(ITEM_SEL);
  const itemKey = el => {
    const existing = el.dataset.flatIndex || el.dataset.turnKey || el.dataset.messageId || el.querySelector('[data-message-id]')?.dataset.messageId;
    if (existing) return existing;
    const acp = el.closest?.('[role="log"][aria-label="Session transcript"]')
      ? el.closest('[data-acp-msg-index]')?.getAttribute('data-acp-msg-index') : null;
    if (acp != null) return `acp${acp}`;
    if (el.getAttribute('data-side')) {
      const i = [...doc.querySelectorAll('[role=group][data-side]')].indexOf(el);
      return i >= 0 ? `d${i}` : '';
    }
    if (!el.dataset.remoteItem) el.dataset.remoteItem = crypto.randomUUID();
    return `remote:${el.dataset.remoteItem}`;
  };
  const itemByKey = (panel, key) => [...panel.querySelectorAll(`${ITEM_SEL}, [data-remote-item]`)].find(el => itemKey(el) === key) || panel.querySelector(`[data-flat-index="${CSS.escape(key)}"], [data-message-id="${CSS.escape(key)}"], [data-turn-key="${CSS.escape(key)}"]`);

  const findPanel = () => {
    const real = [...doc.querySelectorAll(COMPOSER)].filter(e => vis(e) && !e.closest(ITEM_SEL));
    const base = real.length ? real : [...doc.querySelectorAll(COMPOSER)].filter(vis);
    // Cursor's Agents window can show several cards at once; read the card the sidebar marks selected.
    const selId = doc.querySelector('[data-sidebar-item-key] [data-active="true"]')?.closest('[data-sidebar-item-key]')?.getAttribute('data-sidebar-item-key')?.slice(4);
    const eds = selId ? [...base].sort((a, b) => (a.closest('[data-glass-agent-id]')?.getAttribute('data-glass-agent-id') === selId ? 0 : 1) - (b.closest('[data-glass-agent-id]')?.getAttribute('data-glass-agent-id') === selId ? 0 : 1)) : base;
    for (const ed of eds) {
      let p = ed;
      while (p && !p.querySelector(ITEM_SEL)) p = p.parentElement;
      if (p) return p;
    }
    // Devin's prompt is not a Cursor composer. The first message's parent is only that
    // bubble, so climb until every visible message sits in one transcript.
    const items = [...doc.querySelectorAll(ITEM_SEL)].filter(vis);
    if (!items.length) return null;
    let p = items[0].parentElement;
    for (let i = 0; i < 14 && p?.parentElement && !items.every(it => p.contains(it)); i++) p = p.parentElement;
    return p;
  };

  const isPermissionButton = b => b.getAttribute('data-composer-navigation-target') === 'permissions' || b.getAttribute('aria-label') === 'Change permissions';
  const buttonsIn = (root, strict) => [...root.querySelectorAll('button, [role=button], .anysphere-button, .anysphere-secondary-button, .composer-run-button, .composer-skip-button')]
    .filter(b => vis(b) && !isPermissionButton(b) && !b.closest('.human-message-action-slot') && !SKIP.test(b.className) && !b.parentElement.closest('button, [role=button]'))
    .map(b => ({ el: b, label: ((b.innerText || '').trim() || b.getAttribute('aria-label') || b.title || '').split('\n')[0].slice(0, 30) }))
    .filter(x => x.label && x.label !== 'Shell command options' && (!strict || ACTION.test(x.label)))
    .filter((x, i, rows) => !root.hasAttribute('data-turn-key') || x.label !== 'Copy message' || !rows.slice(0, i).some(b => b.label === x.label));

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
      if (n.matches(CODE_BLOCK) || n.getAttribute('data-markdown-copy') === 'code-block') {
        const content = n.querySelector('code') || n.querySelector('.ui-code-block-content') || n;
        const lines = [...content.querySelectorAll('.view-line')];
        const plainLine = el => (el.innerText || '').replace(/\u00a0/g, ' ').replace(/\n/g, '');
        const plain = (lines.length ? lines.map(plainLine).join('\n') : (content.innerText || '').replace(/\u00a0/g, ' ')).replace(/\n$/, '');
        const body = (lines.length ? lines.map(l => clean(l)).join('\n') : esc(plain));
        out += `<div class="codebox"><textarea class="src" hidden readonly>${esc(plain)}</textarea><pre>${body}</pre></div>`;
        continue;
      }
      if (n.getAttribute('data-markdown-copy') === 'inline-code') {
        out += `<code>${esc((n.innerText || '').trim())}</code>`;
        continue;
      }
      const tag = n.tagName;
      if (['STYLE', 'SCRIPT', 'BUTTON', 'svg', 'SVG', 'IMG'].includes(tag)) continue;
      if (tag === 'BR') { out += '<br>'; continue; }
      if (tag === 'HR') { out += '<hr>'; continue; }
      if (tag === 'A' && /^https?:\/\//i.test(n.getAttribute('href') || '')) {
        out += `<a href="${esc(n.getAttribute('href'))}">${clean(n)}</a>`;
        continue;
      }
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
    const head = (el.querySelector('.ui-tool-call-card__header, .ui-collapsible-header, [class*="header"]') || el).cloneNode(true);
    head.querySelectorAll('button, [role=button], .anysphere-button, .anysphere-secondary-button, .composer-run-button, .composer-skip-button, kbd').forEach(b => b.remove());
    return (head.textContent || '').trim().replace(/\s*\n\s*/g, ' · ').slice(0, 240);
  };

  // Cursor keeps thinking text mounted inside the collapsible. Devin's "Thought for …"
  // block and the older chat thinking box drop the body until the header is opened.
  const THINKING_ROOT = '.ui-thinking-collapsible, .chat-thinking-box, .highlight-wrapper';
  const ROW_SEL = `${ITEM_SEL}, ${THINKING_ROOT}`;
  const topItems = panel => [...panel.querySelectorAll(ROW_SEL)].filter(e => vis(e) && !e.parentElement?.closest(ROW_SEL));
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
    const rooted = [...doc.querySelectorAll(THINKING_ROOT)].filter(el => el.matches('.ui-thinking-collapsible, .chat-thinking-box') || /^(thinking|thoughts|thought(?: for)? )\b/i.test(thinkingTitleOf(el)));
    const rows = [...doc.querySelectorAll('[data-message-kind="thinking"]')].filter(el => !rooted.some(r => r === el || r.contains(el) || el.contains(r)));
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
      return { id: `pick:${row.getAttribute('data-index')}`, title, running: /\bworking\b/i.test(row.innerText || '') };
    }).filter(r => r.title);
  };
  // Devin sessions are identified by their title. The Editor surface keeps the open sessions as tabs above
  // the transcript (the active one has the active-tab background); the Agent surface uses the sidebar.
  const sessNorm = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  // The tabs live in the chat panel (#chat) even when the open session is empty and has no transcript.
  const devinTabEls = () => [...document.querySelectorAll('#chat [draggable="true"]')].filter(e => vis(e) && /h-\[34px\]/.test(String(e.className)));
  const devinTabs = () => devinTabEls().map(t => ({
    id: codexFiberProps(t, 24).find(p => p.sessionId)?.sessionId || '',
    title: sessNorm((t.querySelector('span') || t).innerText),
    active: /bg-ide-tab-active-background-color/.test(String(t.className)),
  })).filter(t => t.title);
  const devinSession = () => {
    if (!devinLog() && !devinSurface()) return null;
    const tabs = devinTabs(), surface = devinSurface();
    const active = agentList().find(a => a.current);
    const tab = surface === 'editor' ? devinTabEls()[tabs.findIndex(t => t.active)] : null;
    const node = devinLog() || tab || [...doc.querySelectorAll('[role="textbox"][aria-label="Prompt"]')].find(vis)
      || (surface === 'editor' ? doc.querySelector('.editor-group-container.has-pending-new-session-welcome [role="textbox"][aria-label="Prompt"]') : null);
    let props = [];
    for (let el = node; el; el = el.parentElement) {
      props = codexFiberProps(el, 32);
      if (props.some(p => p.session?.sessionId || p.sessionId)) break;
    }
    const session = props.find(p => p.session?.sessionId)?.session;
    const key = session?.sessionId || props.find(p => p.sessionId)?.sessionId || (surface === 'agent' ? active?.id : '') || '';
    const title = (surface === 'editor' ? tabs.find(t => t.active)?.title : active?.title) || '';
    return { key, title, surface, tabs };
  };
  const devinTabTarget = id => {
    const el = devinTabEls().find(t => codexFiberProps(t, 24).some(p => p.sessionId === id));
    if (!el) return null;
    const r = (el.querySelector('span') || el).getBoundingClientRect();
    return { x: r.x + Math.min(r.width / 2, 40), y: r.y + r.height / 2 };
  };
  const clickDevinTab = id => {
    const el = devinTabEls().find(t => codexFiberProps(t, 24).some(p => p.sessionId === id));
    if (!el) return false;
    el.click();
    return true;
  };
  // The tab's own close button (an icon at its right edge, hover-revealed); null while it has no size.
  const devinTabCloseTarget = id => {
    const el = devinTabEls().find(t => codexFiberProps(t, 24).some(p => p.sessionId === id));
    const b = el?.querySelector('button');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return r.width > 2 && r.height > 2 ? { x: r.x + r.width * 0.78, y: r.y + r.height / 2 } : null;
  };
  const clickDevinTabClose = id => {
    const el = devinTabEls().find(t => codexFiberProps(t, 24).some(p => p.sessionId === id));
    el.querySelector('button').click();
  };
  const sessionPickerTarget = (id, title = '') => {
    const row = [...document.querySelectorAll('.quick-input-widget .monaco-list-row')].filter(vis)
      .find(r => title ? ((r.querySelector('.label-name') || r).innerText || '').trim().split('\n')[0].slice(0, 80) === title : `pick:${r.getAttribute('data-index')}` === id);
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
  const queueRows = () => [...doc.querySelectorAll(QUEUE_ROW)].filter(vis);
  const queued = () => queueRows().map(e => ({
    id: e.dataset.queueItemId,
    t: (e.dataset.queueItemQuery || e.innerText || '').trim().slice(0, 4000),
  }));
  // The submit button becomes "Stop generation" while a turn is running.
  // The stop icon on a human bubble (Ctrl+Shift+Backspace) reverts that message instead.
  const stopGenerationButton = () => [...doc.querySelectorAll('button, [role=button]')].find(e => {
    if (!vis(e) || e.closest('.composer-human-message, .human-message-action-slot')) return false;
    const label = (e.getAttribute('aria-label') || '').trim();
    return /^stop generation\b/i.test(label) || (doc.querySelector('[data-turn-key]') && /^(Stop|Stop generating)$/i.test(label));
  });
  const legacyStopIcon = () => [...document.querySelectorAll('.composer-button-area .codicon-debug-stop, .send-with-mode .codicon-debug-stop')].find(e => vis(e) && !e.closest('.composer-human-message, .human-message-action-slot'));
  // Devin: while a turn runs the submit button reads "Cancel" (empty input) or "Queue" (typed text).
  const devinSubmitBusy = () => !!devinLog() && [...document.querySelectorAll('button[aria-label]')].some(e => vis(e) && /^(Cancel|Queue)$/.test(e.getAttribute('aria-label')) && !!e.querySelector('svg'));
  const isBusy = () => !!stopGenerationButton() || !!legacyStopIcon() || devinSubmitBusy() || [...doc.querySelectorAll('button')].some(e => vis(e) && /^(Stop|Stop generating)$/i.test((e.getAttribute('aria-label') || '').trim()));
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
    for (const h of doc.querySelectorAll('.task-tool-call-header')) {
      if (!vis(h) || !h.closest(ITEM_SEL)?.querySelector('.ui-subagent-status-indicator--running-loader, .task-subagent-header-pill-button--stop')) continue;
      const n = h.querySelector('span.truncate')?.childNodes[0]?.textContent.trim();
      if (n) names.add(n);
    }
    for (const r of doc.querySelectorAll(SUB_ROW)) if (subRowName(r)) names.add(subRowName(r));
    return [...names];
  };
  const subTrayHeader = () => [...doc.querySelectorAll('div')].find(e => vis(e) && [...e.childNodes].some(n => n.nodeType === 3 && /^\d+ subagents? running$/.test(n.textContent.trim())));
  const subTarget = (name, part) => {
    const row = [...doc.querySelectorAll(SUB_ROW)].find(r => vis(r) && subRowName(r) === name);
    if (!row) { const h = subTrayHeader(); return h ? { expand: true, ...center(h) } : null; }
    if (part === 'stop') {
      const s = [...row.querySelectorAll('span.truncate')].find(e => e.innerText.trim() === 'Stop');
      return s ? center(s) : null;
    }
    return center(row.querySelector('.composer-toolbar-background-job-item-text') || row);
  };
  const activeChatTab = () => [...doc.querySelectorAll('.tab.active')].map(e => e.getAttribute('aria-label') || '').find(l => /Chat Editors/.test(l)) || null;
  const tabTarget = label => {
    const t = [...doc.querySelectorAll('.tab')].find(e => vis(e) && e.getAttribute('aria-label') === label);
    return t ? center(t) : null;
  };
  // A new Devin session draws its composer inside the welcome layer. Devin hides that
  // layer while any file tab is open, so the model chip and prompt have a 0-size box.
  // Show the welcome until the new session is no longer pending. The file tab stays open.
  const revealDevinComposer = () => {
    const groups = [...doc.querySelectorAll('.editor-group-container')];
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
    if ([...doc.querySelectorAll('.aislash-editor-input[contenteditable="true"], .ui-prompt-input-editor__input[contenteditable="true"]')].some(vis)) return true;
    // Devin's prompt is a plain contenteditable. Its message bubbles are role=group too, so only those are excluded.
    return [...doc.querySelectorAll('[contenteditable="true"]')].some(e => vis(e) && !e.closest('.monaco-editor, [aria-label="User message"], [aria-label="Devin message"]'));
  };

  // The Agent's ask-question tool renders as a toolbar above the composer, outside the message list.
  const QN = '.composer-questionnaire-toolbar';
  const qnBox = () => [...doc.querySelectorAll(QN)].find(vis);
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
  // Agent surface, new-session screen: "Local ▾" (where the agent runs: Local / Worktree / Cloud) and the folder
  // chip next to it. Both are only enabled before the first message; in a running session Local is disabled.
  // The folder chip opens a quick pick (role=listbox aria-label="Select a directory"; rows "name, path" and Browse...).
  const workdirChips = () => {
    if (!devinSurface()) return null;
    const btns = [...document.querySelectorAll('button')].filter(b => vis(b) && b.getBoundingClientRect().y > 120);
    const env = btns.find(b => /^(Local|Worktree|Cloud)$/.test((b.innerText || '').trim()) && b.getAttribute('aria-haspopup') === 'menu');
    if (!env) return null;
    const folder = env.nextElementSibling;
    return folder ? { env, folder } : null;
  };
  const workdirInfo = () => {
    const c = workdirChips();
    if (!c) return null;
    const lines = (c.folder.innerText || '').split('\n').map(x => x.trim()).filter(Boolean);
    return { name: lines[0] || '', extra: lines[1] || '', env: (c.env.innerText || '').trim(), editable: !c.env.disabled && !c.folder.disabled };
  };
  const workdirTarget = which => {
    const c = workdirChips();
    return c ? center(which === 'env' ? c.env : c.folder) : null;
  };
  const workdirRows = () => {
    const lb = [...document.querySelectorAll('[role="listbox"][aria-label="Select a directory"]')].find(vis);
    if (!lb) return null;
    return [...lb.querySelectorAll('[role="option"]')].filter(vis).map(o => {
      const label = o.getAttribute('aria-label') || (o.innerText || '').trim();
      const at = label.indexOf(', ');
      const r = o.getBoundingClientRect();
      return { name: at < 0 ? label : label.slice(0, at), path: at < 0 ? '' : label.slice(at + 2), browse: /Browse\.\.\./i.test(label), x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
  };
  const envRows = () => [...document.querySelectorAll('[role="menuitem"]')].filter(e => vis(e) && /^(Local|Worktree|Cloud)$/.test((e.innerText || '').trim()))
    .map(e => { const r = e.getBoundingClientRect(); return { label: (e.innerText || '').trim(), x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  // Devin "@" mentions: typing "@" in the prompt opens a listbox (root: Files, Directories, Git, Rules, Skills,
  // Conversations, Terminal, Codemaps; "@file:ser" lists files, "@terminal:" lists terminals). Clicking an option
  // swaps the typed text for a chip. composerState() is the prompt's text without placeholder / zero-width marks.
  const composerState = () => {
    const ed = [...document.querySelectorAll('[role="textbox"][aria-label="Prompt"]')].find(vis);
    if (!ed) return null;
    const ph = ed.querySelector('[data-slate-placeholder]')?.innerText || '';
    let t = ed.innerText || '';
    if (ph) t = t.split(ph).join('');
    return t.replace(/[\u200b\ufeff]/g, '').trim();
  };
  const mentionRows = () => {
    const lb = [...document.querySelectorAll('[role="listbox"]')].find(e => vis(e) && e.getBoundingClientRect().height > 20 && e.querySelector('[role="option"]'));
    if (!lb) return null;
    return [...lb.querySelectorAll('[role="option"]')].filter(vis).map(o => {
      const r = o.getBoundingClientRect();
      const lines = (o.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
      return { label: lines[0] || '', sub: lines.slice(1).join(' · ').slice(0, 120), sel: o.getAttribute('aria-selected') === 'true', x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }).filter(r => r.label && r.label !== 'Loading…');
  };
  // Devin: the question card sits in a `[data-band-item]` above the composer, one question at a time
  // (Skip, a "1 of 2" pager only when there are several, option rows `div[role=button]`; multi-select rows carry a role=checkbox and the
  // card has a Submit button). A single choice answers as soon as its row is clicked. Free text goes
  // through the normal composer ("Other answer" placeholder).
  const devinQnBand = () => !devinLog() ? null : [...document.querySelectorAll('[data-band-item]')]
    .find(e => vis(e) && e.querySelector('button[aria-label="Skip"]'));
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
  const changedCount = () => codexThread() ? codexChanges().count : parseInt(filesToggle()?.innerText || '0', 10) || 0
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
    const bar = [...doc.querySelectorAll('[data-editing-queue-item-id]')].find(e => vis(e) && e.dataset.editingQueueItemId === id);
    const ed = bar && [...bar.querySelectorAll('[contenteditable="true"]')].find(vis);
    if (!ed) return false;
    ed.focus();
    return true;
  };

  const stopTarget = () => {
    const btn = stopGenerationButton();
    if (btn) return center(btn);
    const icon = legacyStopIcon();
    if (icon) return center(icon.closest('button, [role=button], .anysphere-icon-button') || icon);
    const cancel = devinLog() && [...document.querySelectorAll('button[aria-label="Cancel"]')].find(e => vis(e) && !e.disabled && e.querySelector('svg'));
    return cancel ? center(cancel) : null;
  };

  const permissionLabel = () => {
    const b = doc.querySelector('[data-composer-navigation-target="permissions"], button[aria-label="Change permissions"]');
    if (!b || !vis(b)) return null;
    return (b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40) || null;
  };
  const codexModelName = () => {
    const cp = codexPickerProps();
    if (cp) {
      const sel = (cp.modelOptions || []).find(o => o.model?.id === cp.model)?.model;
      const eff = cp.powerSelections?.find(x => x.id === cp.selectedPowerSelection?.id)?.reasoningEffort;
      const pretty = eff ? eff[0].toUpperCase() + eff.slice(1) : '';
      if (sel) {
        const base = String(sel.displayName || sel.id).replace(/-/g, ' ');
        return pretty ? `${base} · ${pretty}` : base;
      }
    }
    const name = [...doc.querySelectorAll('[class*="ModelPickerTriggerModelText"]')].find(vis)?.textContent?.trim();
    if (!name) return null;
    const effort = [...doc.querySelectorAll('[data-selected-reasoning-effort]')].find(vis)?.getAttribute('data-selected-reasoning-effort') || '';
    const pretty = effort.split(/[\s-]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    return pretty ? `${name} · ${pretty}` : name;
  };
  const modelButton = () => {
    const codex = [...doc.querySelectorAll('[data-codex-intelligence-trigger]')].find(vis);
    if (codex && vis(codex)) return codex;
    const composer = pickComposer([...doc.querySelectorAll(COMPOSER)].filter(e => vis(e) && !e.closest(ITEM_SEL)));
    const toolbar = composer?.closest('.ai-input-full-input-box') || composer?.parentElement?.closest('.ui-prompt-input');
    const known = [...(toolbar || doc).querySelectorAll('.ui-model-picker__trigger, .vscode-model-picker__trigger, .composer-unified-dropdown-model')].filter(vis).at(-1);
    if (known) return known;
    // Model sits in the prompt toolbar, on the opposite side from voice / send.
    // Status chips such as "commit" live outside that toolbar and must not match.
    const bar = toolbar?.querySelector('.ui-prompt-input-toolbar') || doc.querySelector('.ui-prompt-input-toolbar');
    if (!bar) return devinModelButton();
    const right = bar.querySelector('.ui-prompt-input-toolbar__right');
    const STATUS = /^(commit|committing|generating|applying|reading|searching|running|planning|thinking|working|editing|indexing)\b/i;
    const cand = [...bar.querySelectorAll('button, [role=button]')].filter(e => {
      if (!vis(e) || (right && right.contains(e))) return false;
      const text = (e.innerText || '').replace(/\s+/g, ' ').trim();
      return text && !STATUS.test(text);
    });
    return cand.find(e => e.getAttribute('aria-haspopup') === 'menu') || cand[0] || devinModelButton();
  };
  const DEVIN_MODEL = /^(SWE|GPT|Claude|Gemini|GLM|Kimi|Fusion)\b/;
  const devinModelButton = () => {
    revealDevinComposer();
    return [...doc.querySelectorAll('button')].find(e => {
      // textContent first: innerText forces layout for every button on the page.
      const text = (e.textContent || '').replace(/\s+/g, ' ').trim();
      if (!DEVIN_MODEL.test(text) || text.length >= 50) return false;
      return vis(e) && !e.closest('.space-y-2');
    });
  };
  const devinModelMenu = () => [...doc.querySelectorAll('div')].find(e => vis(e) && /Recently Used|Recommended/.test(e.innerText || '') && (e.innerText || '').includes('See more') && (e.innerText || '').length < 2500);
  const powerProps = () => doc.querySelector('[data-codex-intelligence-trigger]') ? codexFiberProps(modelButton(), 40).find(p => p.powerSelections && p.onCommitPower) : null;
  const codexPickerProps = () => {
    const trg = [...doc.querySelectorAll('[data-codex-intelligence-trigger]')].find(vis);
    return trg ? codexFiberProps(trg, 70).find(p => p.modelOptions && p.onSelectModelOption) : null;
  };
  const cursorPickerProps = () => {
    const btn = modelButton();
    if (!btn) return null;
    return codexFiberProps(btn, 90).find(p => Array.isArray(p.models) && p.models.length > 5 && (p.selections || p.initialSelections) && typeof p.onSelectionChange === 'function') || null;
  };
  const normKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  // Prop-based model list: no visible menu is opened. Returns null when only the DOM path can answer.
  const modelItemsFast = () => {
    if (doc.querySelector('[data-codex-intelligence-trigger]')) {
      const items = MENU_ITEMS.model();
      return items.length ? items : null;
    }
    if (devinSurface()) {
      const p = devinPickerProps();
      if (!p) return null;
      const fusion = !!fusionConfig();
      const seen = new Set(['Fusion']);
      const rows = [{ label: 'Fusion', checked: fusion }];
      // The native picker lists one default variant per family (plus the Adaptive router);
      // other effort variants are reachable through the effort list.
      for (const c of devinConfigs(p, true)) {
        if (c.disabled || !c.label || seen.has(c.label) || !DEVIN_MODEL.test(c.label) || /^Fusion \(/.test(c.label)) continue;
        if (!c.isDefaultModelInFamily && c.displayOption !== 'model-router') continue;
        seen.add(c.label);
        rows.push({ label: c.label, checked: !fusion && (p.selectedModels || []).includes(c.modelUid) });
      }
      return rows.length > 1 ? rows : null;
    }
    return null;
  };
  const pickDevinModel = label => {
    const p = devinPickerProps();
    if (!p || normKey(label) === 'fusion') return false;
    const want = normKey(label);
    const c = devinConfigs(p).find(c => !c.disabled && normKey(c.label) === want);
    if (!c) return false;
    p.onModelSelect(c);
    return true;
  };
  const pickCodexModel = label => {
    const p = codexPickerProps();
    if (!p) return false;
    const want = normKey(label);
    const opt = (p.modelOptions || []).find(o => !o.disabled && normKey(o.model?.displayName || o.model?.id) === want);
    if (!opt) {
      if (/^default/.test(want)) {
        if (p.onSelectDefault) { p.onSelectDefault(); p.onSelectComplete?.(); return true; }
        try { p.onSelectModel?.('default'); return true; } catch { return false; }
      }
      return false;
    }
    p.onSelectModel(opt.model?.id || opt.model?.model || opt.model?.displayName);
    p.onSelectComplete?.();
    return true;
  };
  const devinPickerProps = () => {
    const button = devinSurface() && devinModelButton();
    return button ? codexFiberProps(button, 40).find(p => p.visibleModelConfigs && p.onModelSelect) : null;
  };
  const devinConfigs = (p, visibleOnly) => visibleOnly
    ? [...new Map((p?.visibleModelConfigs || []).map(c => [c.modelUid, c])).values()]
    : [...new Map([...(p?.visibleModelConfigs || []), ...(p?.modelSorts || []).flatMap(s => (s.groups || []).flatMap(g => g.options || []))].map(c => [c.modelUid, c])).values()];
  const devinSelectedModel = p => devinConfigs(p).find(c => p.selectedModels?.includes(c.modelUid));
  const devinVariants = part => {
    const p = devinPickerProps(), current = devinSelectedModel(p);
    if (!current) return [];
    const key = part === 'lead' ? 'Lead' : part === 'sidekick' ? 'Sidekick' : part === 'fast' ? 'Fast Mode' : current.familyMetadata?.['Reasoning Effort'] ? 'Reasoning Effort' : 'Effort';
    return devinConfigs(p).filter(c => !c.disabled && c.familyUid === current.familyUid && c.familyMetadata?.[key] && Object.entries(current.familyMetadata || {}).every(([k, v]) => k === key || (c.familyMetadata?.[k]?.name === v.name && c.familyMetadata?.[k]?.order === v.order))).map(c => ({ config: c, label: c.familyMetadata[key].name, checked: c.modelUid === current.modelUid, order: c.familyMetadata[key].order }));
  };
  const effortItems = () => {
    const p = powerProps();
    if (p) return p.powerSelections.filter(x => !x.isLocked).map(x => ({ label: x.reasoningEffort, checked: x.id === p.selectedPowerSelection?.id }));
    const cp = devinSurface() ? null : cursorPickerProps();
    if (cp) {
      const sel = (cp.selections || cp.initialSelections || [])[0];
      const model = cp.models.find(m => m.name === sel?.modelId || m.id === sel?.modelId);
      const def = model?.parameterDefinitions?.find(d => d.id === 'reasoning_effort');
      const cur = sel?.parameters?.find(x => x.id === 'reasoning_effort')?.value;
      const vals = def?.parameterType?.enumParameter?.values;
      if (vals?.length) return vals.filter(v => v.displayName).map(v => ({ label: v.displayName, checked: v.value === cur }));
    }
    return devinVariants('effort').sort((a, b) => a.order - b.order).map(({ label, checked }) => ({ label, checked }));
  };
  const effortName = () => effortItems().find(x => x.checked)?.label || (doc.querySelector('.vscode-model-picker__trigger') ? /\b(Low|Medium|High|Max|Extra High|Ultra)(?: Fast)?$/i.exec(normLabel(modelButton()?.innerText))?.[1] || 'Effort' : null);
  const pickEffort = label => {
    const p = powerProps();
    if (p) {
      const item = p.powerSelections.find(x => !x.isLocked && x.reasoningEffort === label);
      if (!item) return false;
      const previous = p.selectedPowerSelection;
      p.onSelectPower(item);
      p.onCommitPower(item, previous);
      p.onSelectComplete?.();
      return true;
    }
    const row = devinVariants('effort').find(x => x.label === label);
    if (!row) return false;
    devinPickerProps().onModelSelect(row.config);
    return true;
  };
  const effortTrigger = () => {
    const el = [...doc.querySelectorAll('[role=menuitem], .ui-menu__row')].find(e => vis(e) && /^Effort\b/.test(normLabel(e.innerText)));
    return el ? center(el) : null;
  };
  const closeCodexMenu = () => {
    const el = [...doc.querySelectorAll('button[aria-expanded=true][aria-haspopup=menu]')].find(vis);
    if (el) {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse', ctrlKey: false }));
      if (el.getAttribute('aria-expanded') === 'true') el.click();
    }
    return !!el;
  };
  const closeModelMenu = () => {
    const el = modelButton();
    if (el?.getAttribute('aria-expanded') !== 'true') return false;
    el.click();
    return true;
  };
  const fastProps = () => doc.querySelector('[data-codex-intelligence-trigger]') ? codexFiberProps(modelButton(), 40).find(p => p.serviceTierOptions && p.onSelectServiceTier) : null;
  const cursorFastRow = () => [...doc.querySelectorAll('[role=menuitemcheckbox], [role=switch]')].find(e => vis(e) && /^Fast(?: Mode)?$/i.test(normLabel(e.innerText)));
  const fastInfo = () => {
    const p = fastProps();
    if (p) {
      const fast = p.serviceTierOptions.find(x => x.iconKind === 'fast');
      return fast ? { on: p.selectedServiceTier === fast.value, description: fast.description?.defaultMessage || '' } : null;
    }
    const rows = devinVariants('fast');
    if (rows.length > 1) return { on: rows.find(x => x.checked)?.order === 1 };
    const el = cursorFastRow();
    return el ? { on: el.getAttribute('aria-checked') === 'true' } : null;
  };
  const pickFast = on => {
    const p = fastProps();
    if (p) {
      const option = p.serviceTierOptions.find(x => on ? x.iconKind === 'fast' : x.value == null);
      if (!option) return false;
      p.onSelectServiceTier(option.value);
      return true;
    }
    const row = devinVariants('fast').find(x => (x.order === 1) === on);
    if (!row) return false;
    devinPickerProps().onModelSelect(row.config);
    return true;
  };
  const fastTarget = () => { const el = cursorFastRow(); return el ? center(el) : null; };
  const clickCursorFast = () => cursorFastRow().click();
  const normLabel = s => (s || '').replace(/[\u200b\u200c\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  // Fusion is a lead + sidekick pairing. The detail panel only exists while that model menu is open.
  const fusionPanel = () => [...doc.querySelectorAll('div')].find(e => {
    if (!vis(e)) return false;
    const t = e.innerText || '';
    const b = e.getBoundingClientRect();
    return b.width > 200 && b.width < 520 && t.includes('Lead') && t.includes('Sidekick') && t.includes('Fast Mode') && t.length < 900;
  });
  const fusionLine = el => normLabel((el?.innerText || '').split('\n')[0]).slice(0, 60);
  const fusionConfig = () => {
    const current = devinSelectedModel(devinPickerProps());
    if (current?.familyUid === 'fusion') {
      const m = current.familyMetadata;
      return { lead: m.Lead.name, effort: m.Effort.name, sidekick: m.Sidekick.name, fast: m['Fast Mode']?.order === 1, fastSupported: devinVariants('fast').some(x => x.order === 1) };
    }
    const panel = fusionPanel();
    if (!panel) return null;
    const boxes = [...panel.querySelectorAll('[role=combobox]')].filter(vis);
    if (boxes.length < 3) return null;
    const sw = panel.querySelector('[role=switch]');
    return { lead: fusionLine(boxes[0]), effort: fusionLine(boxes[1]), sidekick: fusionLine(boxes[2]), fast: sw?.getAttribute('aria-checked') === 'true', fastSupported: !!sw && sw.getAttribute('aria-disabled') !== 'true' && !sw.disabled };
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
    for (const el of doc.querySelectorAll('[role=option]')) {
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
    const el = [...doc.querySelectorAll('[role=option]')].find(e => vis(e) && fusionLine(e) === want);
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest' });
    return center(el);
  };

  const thinkingItem = (el, host, n) => {
    const title = thinkingTitleOf(el) || '思考';
    const body = thinkingPlain(el).trim();
    const base = itemKey(host && host !== el ? host : el) || `${activeThread()}:thinking:${thinkingNodes().indexOf(el)}`;
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
    if (k === 'human') item.t = aria === 'User message' ? devinUserText(readable) : (readable.innerText || readable.textContent || '').trim();
    else if (k === 'assistant') {
      const devinRoot = aria === 'Devin message' ? el.querySelector('.prose-main') : null;
      const md = [...el.querySelectorAll('.markdown-root, .ui-markdown, .rendered-markdown')].find(n => !n.closest(THINKING_ROOT));
      const body = devinRoot || md || withoutThinking(el);
      item.t = (body.innerText || body.textContent || '').trim();
      item.h = devinRoot ? devinRich(devinRoot) : md ? clean(md) : esc((withoutThinking(el).innerText || '').trim()).replace(/\n/g, '<br>');
    }
    else item.t = summary(withoutThinking(el));
    if (k === 'tool') { const f = toolFile(el); if (f) item.f = f; }
    const b = buttonsIn(el, false).filter(x => !x.el.closest(THINKING_ROOT));
    if (b.length) {
      item.b = b.map(x => x.label);
      item.actions = b.map(x => {
        if (!x.el.dataset.remoteAction) x.el.dataset.remoteAction = crypto.randomUUID();
        return x.el.dataset.remoteAction;
      });
    }
    return item;
  };

  const cursorToolItems = el => {
    const runs = buttonsIn(el, false).filter(b => /^(Run|运行)$/.test(b.label));
    if (runs.length < 2) return [messageItem(el)];
    return runs.map(({ el: button }) => {
      let card = button.parentElement;
      while (card.parentElement && card.parentElement !== el && el.contains(card.parentElement)
        && runs.filter(b => card.parentElement.contains(b.el)).length === 1) card = card.parentElement;
      const item = messageItem(card);
      item.k = 'tool';
      item.t = summary(card);
      return item;
    });
  };

  const codexThread = () => {
    let el = [...doc.querySelectorAll('.ProseMirror')].find(vis);
    while (el && !Object.keys(el).some(k => k.startsWith('__reactFiber'))) el = el.parentElement;
    const active = el && codexFiberProps(el, 40).find(p => typeof p.conversationId === 'string');
    return active?.conversationId || [...doc.querySelectorAll('[data-response-annotation-conversation]')].filter(vis).at(-1)?.getAttribute('data-response-annotation-conversation') || '';
  };
  const attachmentRows = () => {
    const ed = [...doc.querySelectorAll(`${COMPOSER}, [data-slate-editor="true"][contenteditable="true"]`)].filter(vis).at(-1);
    if (!ed) return [];
    let box = ed;
    for (let i = 0; i < 8 && box.parentElement; i++) box = box.parentElement;
    const cursor = ed.closest('.ai-input-full-input-box');
    if (cursor) box = cursor;
    const buttons = [...box.querySelectorAll('button[aria-label^="Remove "]')].filter(button => button.parentElement.querySelector('img'));
    return [...buttons, ...box.querySelectorAll('.context-pill-image')].filter(vis).map(button => {
      if (!button.dataset.remoteAttachment) button.dataset.remoteAttachment = crypto.randomUUID();
      const pill = button.matches('.context-pill-image');
      const img = pill ? button.querySelector('img') : button.parentElement.querySelector('img');
      let preview = '';
      if (img?.complete && img.naturalWidth) {
        const canvas = doc.createElement('canvas');
        canvas.width = 96; canvas.height = Math.max(1, Math.round(96 * img.naturalHeight / img.naturalWidth));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        preview = canvas.toDataURL('image/jpeg', 0.6);
      }
      const label = pill ? '图片' : button.getAttribute('aria-label').slice(7);
      const name = img?.alt && img.alt !== 'User attachment' ? img.alt.replace(/^User uploaded image (\d+)$/, '图片 $1') : label;
      return { id: button.dataset.remoteAttachment, name, preview };
    });
  };
  const removeAttachment = id => {
    if (!attachmentRows().some(f => f.id === id)) return false;
    const el = [...doc.querySelectorAll('[data-remote-attachment]')].find(b => b.dataset.remoteAttachment === id);
    const button = el?.matches('.context-pill-image') ? el.querySelector('.image-pill-close-button') : el;
    if (!button) return false;
    button.click();
    return true;
  };
  const attachmentPoint = id => {
    const el = [...doc.querySelectorAll('[data-remote-attachment]')].find(e => e.dataset.remoteAttachment === id);
    return el ? center(el) : null;
  };
  const submitCodexMessage = () => {
    const button = [...doc.querySelectorAll('button[aria-label="Send"],button[aria-label="Queue"],button[aria-label="Steer"]')].filter(vis).at(-1);
    if (!button || button.disabled) return false;
    button.click();
    return true;
  };
  const activeThread = () => {
    const glass = [...doc.querySelectorAll('[data-glass-agent-id]')].filter(vis);
    // Cursor's composer provider keeps a stale 'focused' composer; the sidebar's data-active row is the selected one.
    const cursorSel = [...doc.querySelectorAll('[data-sidebar-item-key^="row:"]')].find(r => r.querySelector('[data-active="true"]'))?.getAttribute('data-sidebar-item-key').slice(4);
    return codexThread() || (devinSurface() ? devinSession()?.key : '') || (glass.length === 1 ? glass[0].getAttribute('data-glass-agent-id') : '') || cursorSel || window.__SSG_COMPOSER_PROVIDER__?.getStates?.().find(c => c.state === 'focused')?.id || agentList().find(a => a.current)?.id || '';
  };
  const codexTurnData = el => codexFiberProps(el.querySelector('[class*="agent-activity"]') || el.querySelector('button[aria-expanded]') || el, 40).find(p => p.turn)?.turn;
  const codexFusionTurn = (id = '', message = '', previous = []) => {
    const rows = [...doc.querySelectorAll('[data-turn-key]')];
    const el = id ? rows.find(e => e.getAttribute('data-turn-key') === id)
      : message ? [...rows].reverse().find(e => !previous.includes(e.getAttribute('data-turn-key')) && codexTurnData(e)?.items?.some(it => it.type === 'user-message' && String(it.message || '').trim() === message.trim()))
      : rows.filter(vis).at(-1);
    const turn = el && codexTurnData(el);
    const user = turn?.items?.find(it => it.type === 'user-message');
    const reply = turn?.items?.filter(it => it.type === 'assistant-message' && it.phase !== 'commentary').at(-1);
    return { id: el?.getAttribute('data-turn-key') || '', ids: rows.map(e => e.getAttribute('data-turn-key')), user: user?.message || '', text: reply?.content || '', completed: turn?.status === 'complete' && !!reply?.completed, items: el ? codexTurnItems(el) : [] };
  };
  // One Codex turn can contain several markdown blocks. Keep them in order instead of keeping only the first reply.
  const codexTurnItems = el => {
    const thread = codexThread();
    const blocks = [...el.querySelectorAll('[class*="MarkdownRoot"]')];
    const out = [];
    const turn = codexTurnData(el);
    const markdown = new Map(blocks.map(block => [codexFiberProps(block).find(p => p.item?.type === 'assistant-message')?.item?.responseAnnotationTargetId, block]));
    const textOf = v => typeof v === 'string' ? v.replace(/\u00a0/g, ' ').trim() : '';
    const finished = turn?.status === 'complete';
    for (const item of turn?.items || []) {
      const id = `${thread}:${item.type}:${item.sourceItemId || item.callId || item.responseAnnotationTargetId || item.clientUserMessageId || item.id || ''}`;
      if (item.type === 'context-compaction') {
        const automatic = item.source !== 'manual';
        const live = item.status === 'inProgress';
        const state = live ? '正在' : item.status === 'completed' ? '已完成' : '已中断';
        out.push({ i: id, k: 'notice', kind: 'compaction', t: `${state}${automatic ? '自动' : ''}压缩上下文`, live });
      } else if (item.type === 'reasoning') {
        const body = textOf(item.content);
        if (body) out.push({ i: id, k: 'thinking', t: `${item.completed ? 'Thoughts' : 'Thinking'}\n${body}`, live: !item.completed });
      } else if (item.type === 'user-message') {
        const imgs = Array.isArray(item.images) ? item.images.length : 0;
        const atts = Array.isArray(item.uploadedFileAttachments) ? item.uploadedFileAttachments.length : (Array.isArray(item.attachments) ? item.attachments.length : 0);
        let t = item.message || '';
        if (imgs) t += `${t ? '\n' : ''}[图片 ${imgs}]`;
        if (atts) t += `${t ? '\n' : ''}[附件 ${atts}]`;
        out.push({ i: id, k: 'human', t });
      } else if (item.type === 'assistant-message' && item.content) {
        const block = markdown.get(item.responseAnnotationTargetId);
        if (item.phase === 'commentary') out.push({ i: id, k: 'thinking', t: `工作过程\n${item.content}`, live: !item.completed });
        else out.push({ i: id, k: 'assistant', t: item.content, completed: item.completed, h: block ? clean(block) : esc(item.content).replace(/\n/g, '<br>') });
      } else if (item.type === 'exec') {
        out.push({ i: id, k: 'tool', t: (item.cmd || []).join('\n').slice(0, 240), done: finished });
      } else if (item.type === 'patch') {
        const files = Object.keys(item.changes || {});
        out.push({ i: id, k: 'tool', t: `修改 ${files.join(', ')}`.slice(0, 240), f: files[0], done: finished });
      } else if (item.type === 'todo-list') {
        const steps = Array.isArray(item.plan) ? item.plan : (Array.isArray(item.items) ? item.items : []);
        const tasks = steps.map(step => ({
          t: textOf(step.step || step.text || step.title).slice(0, 300),
          status: step.status === 'completed' || step.completed ? 'done' : step.status === 'in_progress' ? 'in_progress' : 'pending',
        })).filter(step => step.t);
        out.push({ i: id, k: 'tasks', done: tasks.filter(step => step.status === 'done').length, total: tasks.length, items: tasks });
      } else if (item.type === 'web-search') {
        out.push({ i: id, k: 'tool', kind: 'search', src: 'codex', t: `搜索 ${textOf(item.query)}`.trim().slice(0, 240) });
      } else if (item.type === 'mcp-tool-call' || item.type === 'dynamic-tool-call') {
        const name = textOf(item.toolName || item.name || item.server) || item.type;
        const status = textOf(item.status || item.executionStatus);
        const raw = item.result ?? item.output ?? item.content;
        const result = (typeof raw === 'string' ? raw : raw == null ? '' : JSON.stringify(raw)).slice(0, 4000);
        out.push({ i: id, k: 'tool', kind: 'other', src: 'codex', t: `${item.type === 'mcp-tool-call' ? 'MCP' : '工具'} ${name}${status ? ' · ' + status : ''}${result ? ' · ' + result : ''}`.slice(0, 4400), keep: true });
      } else if (item.type === 'generated-image' || item.type === 'chatgpt-delayed-image-gen' || item.type === 'chatgpt-delayed-image-gen-received') {
        const images = [...el.querySelectorAll('img')].filter(vis).map(img => img.currentSrc || img.src).filter(src => /^(https?:|data:image\/|blob:)/.test(src));
        out.push({ i: id, k: 'tool', kind: 'other', src: 'codex', t: item.type === 'chatgpt-delayed-image-gen' ? '正在生成图片' : '生成的图片', images, keep: true });
      } else if (item.type === 'chatgpt-tool-approval') {
        out.push({ i: id, k: 'tool', kind: 'other', src: 'codex', t: `等待批准 ${textOf(item.title)}`.trim().slice(0, 240) });
      } else if (item.type === 'collabAgentToolCall' || item.type === 'chatgpt-subagent-activity') {
        out.push({ i: id, k: 'tool', src: 'codex', kind: 'other', t: `${item.tool || '子 Agent'} · ${item.status || ''}\n${JSON.stringify(item.agentsStates || item.agents || item.receiverThreadIds || [])}`, agents: (item.receiverThreadIds || []).map(id => ({ id, title: item.agentsStates?.[id]?.nickname || id })), keep: true });
      } else if (item.type === 'stream-error') {
        if (!finished) out.push({ i: id, k: 'thinking', t: `连接\n${textOf(item.content)}`.slice(0, 400), live: true });
      } else if (item.type === 'turn-diff') {
        out.push({ i: id, k: 'tool', kind: 'other', src: 'codex', t: '文件改动' });
      } else if (item.type !== 'automatic-approval-review' && item.type !== 'worked-for') {
        const body = textOf(item.content || item.message || item.query || item.title);
        if (body) out.push({ i: id, k: 'tool', kind: 'other', src: 'codex', t: body.slice(0, 400), done: finished && /exec|patch|command/.test(item.type) });
      }
    }
    const turnButtons = buttonsIn(el, false).map(x => x.label).filter(l => /^(Copy message|Fork chat from here|View changed files|View changes|Undo|Open agent|View agent|View subagent|Stop agent|Apply|Revert)$/.test(l));
    if (turnButtons.length) {
      const host = [...out].reverse().find(it => it.k === 'assistant') || out.at(-1);
      if (host) { host.b = turnButtons; host.btnItem = el.getAttribute('data-turn-key') || host.i; }
    }
    const number = codexFiberProps(el, 24).find(p => p.entry?.turnNumber)?.entry.turnNumber;
    return out.map((item, index) => ({ ...item, ...(number ? { order: number * 10000 + index } : {}) }));
  };
  /* ---------- Devin transcript rows ---------- */

  const devinLog = () => {
    const selected = devinSurface() === 'agent' ? agentList().find(a => a.current)?.id : devinTabs().find(t => t.active)?.id;
    return [...doc.querySelectorAll('[role="log"][aria-label="Session transcript"]')].find(e => vis(e) && (!selected || codexFiberProps(e, 24).some(p => p.sessionId === selected || p.session?.sessionId === selected)));
  };

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
      .filter(c => /\.[A-Za-z0-9]{1,10}$/.test(c) || /^[A-Za-z]:[\\/]|^\//.test(c));
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
    const props = codexFiberProps(med, 16);
    const command = props.find(p => typeof p.commandLine === 'string');
    const output = props.find(p => Array.isArray(p.outputs));
    return { i, k: 'tool', kind: 'command', t, d,
      cmd: (command?.commandLine || row.querySelector('.terminal-text .monaco-tokenized-source')?.textContent || '').trim(),
      output: (output?.outputs.map(o => o.full || '').join('\n') || row.querySelector('pre')?.innerText || rest.join('\n')).trim().slice(0, 4000) };
  };

  const setCommandOpen = (id, open) => {
    const row = [...(devinLog()?.children || [])].find(r => itemKey(r) === id);
    const btn = row?.querySelector('button[aria-expanded], .command-card .group\\/header');
    if (!btn) return null;
    const previous = btn.getAttribute('aria-expanded') === 'true' || !!btn.querySelector('.lucide-chevron-down');
    if (previous !== open) btn.click();
    return previous;
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
    if (!btn) return null;
    const previous = btn.getAttribute('aria-expanded') === 'true';
    if (previous !== open) btn.click();
    return previous;
  };

  // Latest todo list of the Devin session (the phone's task notification); current = the item being worked on.
  const devinTaskState = () => {
    for (const row of [...(devinLog()?.children || [])].slice(-40).reverse()) {
      if (!/tasks? done/.test(row.textContent)) continue;
      const t = devinTasks(row, '');
      if (t) return { done: t.done, total: t.total, current: t.items?.find(x => x.status === 'in_progress')?.t || '' };
    }
    return null;
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
    const props = codexFiberProps(med, 16);
    const file = props.find(p => typeof p.fileUri === 'string');
    const tool = props.find(p => p.toolCall?.rawInput?.file_path)?.toolCall;
    const item = { i, k: 'tool', kind: 'edit', f: file?.fileUri || tool?.rawInput.file_path || med.innerText.trim(), add: num(/^\+\d+$/), del: num(/^[-−]\d+$/), diff: over ? diff.slice(0, 200) : diff };
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
      const cmd = devinCommand(row, i);
      if (cmd) { items.push(cmd); return; }
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
    });
    return items.filter(Boolean).map(it => ({ ...it, src: 'devin' }));
  };

  const extract = () => {
    const log = devinLog();
    const panel = log || (devinSurface() ? null : findPanel());
    // A brand-new Devin session has a composer and model chip, but no message list yet.
    if (!panel && !log) {
      const modelEl = modelButton();
      if (!modelEl && !hasComposer() && !devinSurface() && !doc.querySelector('[data-request-input-dismiss]')) return null;
      return {
        rect: [0, 0, 0, 0],
        items: [],
        ...(devinSurface() ? { empty: true } : {}),
        global: [],
        busy: isBusy(),
        queued: queued(),
        subagents: subagents(),
        changed: changedCount(),
        questions: codexThread() ? { codex: true, requests: codexRequestData() } : null,
        ...(devinSurface() ? { session: devinSession(), workdir: workdirInfo() } : {}),
        readonly: !hasComposer(),
        mode: devinModeChip()?.innerText.trim() || CONTROLS.mode()?.innerText.trim() || null,
        ...(devinSurface() ? { surface: devinSurface() } : {}),
        model: codexModelName() || (modelEl ? normLabel(modelEl.innerText).split('\n')[0].slice(0, 60) : null),
        permission: permissionLabel(), effort: effortName(),
        thread: activeThread(),
        title: agentState()?.title || '',
        context: contextPct(),
        draft: composerDraft(),
        ...(codexFacts()?.view ? { codex: codexFacts().view } : {}),
      };
    }
    const r = (log || panel).getBoundingClientRect();
    const items = log ? devinItems(log) : topItems(panel).flatMap(el => {
      if (el.hasAttribute?.('data-turn-key')) return codexTurnItems(el);
      const thoughts = thinkingInside(el).map((th, n) => thinkingItem(th, el, n));
      if (isThinking(el)) return thoughts.length ? thoughts : [thinkingItem(el, el, 0)];
      const main = messageItem(el);
      if (main.k === 'assistant' && !main.h && !main.b) return thoughts;
      return [...thoughts, ...(main.k === 'tool' ? cursorToolItems(el) : [main])];
    });
    const global = buttonsIn(panel, true).filter(x => !inItem(x.el) && !inQn(x.el) && !/^stop generation\b/i.test(x.label)
      && !(panel.querySelector('[data-turn-key]') && /^(stop|stop generating|停止)$/i.test(x.label))).map(x => x.label);
    const modeEl = [...doc.querySelectorAll('.composer-unified-dropdown[data-mode]')].find(vis);
    const modelEl = modelButton();
    return {
      rect: [r.x, r.y, r.width, r.height].map(Math.round),
      items,
      global,
      busy: isBusy(),
      queued: devinLog() ? devinQueued() : (codexFacts()?.queued || queued()),
      ...(devinLog() ? { queuedCount: devinQueueCount() } : {}),
      subagents: subagents(),
      changed: changedCount(),
      questions: devinLog() ? devinQuestions() : codexThread() ? { codex: true, requests: codexRequestData() } : questions(),
      ...(devinLog() ? { session: devinSession() } : {}),
      ...(devinSurface() ? { workdir: workdirInfo() } : {}),
      readonly: !hasComposer(),
      mode: devinModeChip()?.innerText.trim() || (modeEl ? modeEl.innerText.trim() || modeEl.dataset.mode : null),
      permission: permissionLabel(), effort: effortName(),
      thread: activeThread(),
      title: agentState()?.title || '',
      model: codexModelName() || (modelEl ? normLabel(modelEl.innerText).split('\n')[0].slice(0, 60) : null),
      context: contextPct(),
      draft: composerDraft(),
      ...(devinSurface() ? { surface: devinSurface() } : {}),
      ...(codexFacts()?.view ? { codex: codexFacts().view } : {}),
    };
  };
  const contextPct = () => {
    const el = [...doc.querySelectorAll('button, [role=button], [role=img]')].find(e => vis(e) && /^Context(?:\s+usage)?:?\s*\d+%/i.test(((e.getAttribute('aria-label') || e.innerText || '').replace(/\s+/g, ' ').trim())));
    if (!el) return null;
    const text = ((el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' ').trim());
    const m = /(\d+)%/.exec(text);
    if (!m) return null;
    return { pct: Number(m[1]), basis: /left|remaining|剩余/i.test(text) ? 'remaining' : 'used' };
  };
  // Cursor's Agents window shows several agent cards, each with its own composer; the selected one is the
  // sidebar row with data-active.
  const selCardId = () => doc.querySelector('[data-sidebar-item-key] [data-active="true"]')?.closest('[data-sidebar-item-key]')?.getAttribute('data-sidebar-item-key')?.slice(4) || '';
  const pickComposer = eds => {
    const sel = selCardId();
    return eds.find(e => e.contains(doc.activeElement))
      || (sel && eds.find(e => e.closest('[data-glass-agent-id]')?.getAttribute('data-glass-agent-id') === sel))
      || eds.at(-1);
  };
  const composerDraft = () => {
    if (doc.querySelector('#active-frame')) return codexPromptText() || '';
    const eds = [...doc.querySelectorAll(`${COMPOSER}, [data-slate-editor="true"][contenteditable="true"]`)].filter(e => vis(e) && !inItem(e));
    const ed = pickComposer(eds);
    if (!ed || ed.querySelector('[data-slate-placeholder]')) return '';
    return (ed.innerText || '').replace(/\n+$/g, '');
  };
  const composerFocused = () => {
    const a = doc.activeElement;
    return !!a?.closest?.(`${COMPOSER}, [data-slate-editor="true"]`) && !inItem(a);
  };
  // Write the composer via the editor's own API (no keyboard, no focus). Returns true only when it worked.
  const setComposerDraft = text => {
    text = String(text ?? '');
    if (doc.querySelector('#active-frame')) {
      // Codex ProseMirror has no editor ref on the DOM node; find the EditorView in React props/state.
      const ed = [...doc.querySelectorAll('.ProseMirror[contenteditable="true"]')].find(e => vis(e));
      if (!ed) return false;
      let view = codexFiberProps(ed, Infinity).flatMap(p => Object.values(p || {}))
        .find(v => v && typeof v === 'object' && typeof v.dispatch === 'function' && v.state?.doc && v.state?.tr);
      if (!view) view = codexFiberProps(ed, Infinity).flatMap(p => Object.values(p || {}))
        .map(v => v?.current).find(v => v && typeof v === 'object' && typeof v.dispatch === 'function' && v.state?.doc && v.state?.tr);
      if (!view) return false;
      const schema = view.state.schema;
      const Frag = view.state.doc.content.constructor;
      const children = text.split('\n').map(line => (schema.nodes.paragraph || Object.values(schema.nodes).find(n => n.isBlock && n.name !== 'doc')).create(null, line ? schema.text(line) : null));
      view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, Frag.from(children)));
      return composerDraft() === text.replace(/\n+$/g, '');
    }
    const eds = [...doc.querySelectorAll(`${COMPOSER}, [data-slate-editor="true"][contenteditable="true"]`)].filter(e => vis(e) && !inItem(e));
    const sel = selCardId();
    const selEds = sel ? eds.filter(e => e.closest('[data-glass-agent-id]')?.getAttribute('data-glass-agent-id') === sel) : [];
    const ed = (selEds.length ? selEds : eds).filter(e => e.editor?.commands?.setContent).at(-1)
      || (selEds.length ? selEds : eds).find(e => e.contains(doc.activeElement))
      || (selEds.length ? selEds.at(-1) : eds.at(-1));
    if (!ed) return false;
    // Cursor tiptap keeps the Editor on the DOM node.
    const cmd = ed.editor?.commands;
    if (cmd?.setContent) {
      const content = [{ type: 'paragraph', content: String(text).split('\n').flatMap((line, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : [])]) }];
      cmd.setContent({ type: 'doc', content });
      return composerDraft() === text.replace(/\n+$/g, '');
    }
    // Devin Slate: find the editor object on the fiber.
    const slate = codexFiberProps(ed, Infinity).flatMap(p => Object.values(p || {}))
      .find(v => v && typeof v === 'object' && typeof v.apply === 'function' && Array.isArray(v.children));
    if (slate) {
      let path = [], node = { children: slate.children }, last = { text: '' };
      while (node?.children?.length) { path.push(node.children.length - 1); node = node.children[node.children.length - 1]; }
      if (node && typeof node.text === 'string') last = node;
      const range = { anchor: { path: [0, 0], offset: 0 }, focus: { path, offset: last.text.length } };
      if (typeof slate.select === 'function') slate.select(range);
      else slate.apply({ type: 'set_selection', properties: null, newProperties: range });
      if (typeof slate.deleteFragment === 'function') slate.deleteFragment();
      else slate.delete({ at: range });
      text.split('\n').forEach((line, i) => {
        if (i) slate.insertBreak();
        if (line) slate.insertText(line);
      });
      return composerDraft() === text.replace(/\n+$/g, '');
    }
    return false;
  };
  const readDevinUsage = () => {
    const input = [...doc.querySelectorAll(`${COMPOSER}, [data-slate-editor="true"]`)].filter(e => vis(e) && e.isContentEditable && !inItem(e)).at(-1);
    const api = input && codexFiberProps(input, Infinity).find(p => p.value?.api?.windsurfSettingsPage?.planInfo)?.value.api;
    // The extension refreshes planInfo on window focus; nudge it so quota reads aren't stale.
    try { api?.onWindowFocusChange?.(true); } catch {}
    const info = api?.windsurfSettingsPage?.planInfo?.getPlanInfo();
    if (info) return {
      missing: false, quota: [], plan: info.planName, updated: Date.now(),
      limits: [['每日额度', info.dailyRemainingPercent, info.dailyResetAtUnix, info.hideDailyQuota], ['每周额度', info.weeklyRemainingPercent, info.weeklyResetAtUnix, info.hideWeeklyQuota]]
        .filter(([, , , hidden]) => !hidden)
        .map(([label, pct, reset]) => ({
          label, kind: 'limit', basis: 'remaining', pct: Number.isFinite(pct) ? pct : null,
          reset: Number(reset) ? new Date(Number(reset) * 1000).toLocaleString('zh-CN') : '',
        })),
    };
    const status = document.getElementById('codeium.windsurf.settings.planInfo') || [...doc.querySelectorAll('[aria-label*="quota used"]')].find(a => a.getBoundingClientRect().width > 0);
    const summary = status?.getAttribute('aria-label') || '';
    const sections = [...doc.querySelectorAll('.breakdown-details .quota-section')];
    const section = word => sections.find(s => (s.querySelector('.quota-label')?.textContent || '').trim().startsWith(word));
    const nativeLimits = [...summary.matchAll(/\b(Daily|Weekly):\s*(\d+(?:\.\d+)?)%\s+(?:quota\s+)?(used|left|remaining)/gi)].map(m => ({
      label: /^daily$/i.test(m[1]) ? '每日额度' : '每周额度', kind: 'limit',
      basis: /^used$/i.test(m[3]) ? 'used' : 'remaining', pct: Number(m[2]),
      reset: section(m[1])?.querySelector('.quota-reset-label')?.textContent.trim() || '',
    }));
    if (nativeLimits.length) return { missing: false, quota: [], limits: nativeLimits, updated: Date.now(), plan: summary.split(',')[0], extra: section('Extra')?.querySelector('.quota-value')?.textContent.trim() || '' };
    const text = [...doc.querySelectorAll('p')].map(e => (e.innerText || '').replace(/\s+/g, ' ').trim()).find(t => /usage quota/i.test(t));
    if (!text) return { missing: true, quota: [], limits: [] };
    const reset = (/resets\s+(.+?)\.?$/i.exec(text) || [])[1] || '';
    const limits = [];
    const used = /(\d+)%\s+used/i.exec(text);
    const left = /(\d+)%\s+(?:left|remaining)/i.exec(text);
    if (used) limits.push({ label: '每周额度', kind: 'limit', basis: 'used', pct: Number(used[1]), reset });
    else if (left) limits.push({ label: '每周额度', kind: 'limit', basis: 'remaining', pct: Number(left[1]), reset });
    else if (/exhausted/i.test(text)) limits.push({ label: '每周额度', kind: 'limit', basis: 'used', pct: 100, reset, detail: '包含额度已用完' });
    else limits.push({ label: '每周额度', kind: 'limit', basis: 'used', pct: null, reset, detail: text.slice(0, 160) });
    return { missing: false, quota: [], limits };
  };
  const codexRootProps = () => {
    const el = doc.querySelector('button[aria-label^="Recent chats"]');
    return el ? codexFiberProps(el, Infinity) : [];
  };
  const codexQueryClient = () => codexRootProps().find(p => typeof p.value?.getQueryData === 'function')?.value || null;
  const openCodexThread = async id => {
    if (!codexChatRows(true).some(row => row.id === id)) return false;
    const router = codexRootProps().find(p => typeof p.value?.router?.navigate === 'function')?.value.router;
    if (!router) return false;
    await router.navigate(`/local/${id}`);
    return true;
  };
  const codexWorkspaceRoots = () => codexQueryClient()?.getQueryData(['vscode', 'workspace-root-options', '{"hostId":"local"}'])?.roots || [];
  const codexCurrentProject = () => {
    const meta = codexQueryClient()?.getQueryData(['recent-conversations-meta', 'updated_at', '[]', 'live'])?.find(t => t.conversationId === codexThread());
    return { root: meta?.cwd || codexWorkspaceRoots()[0] || '', host: meta?.hostId && meta.hostId !== 'local' ? meta.hostId : '' };
  };
  const refreshCodexUsage = async (refresh = true) => {
    const client = codexQueryClient();
    if (!client) throw new Error('没找到 Codex 的额度查询');
    if (refresh) await client.refetchQueries({ queryKey: ['rate-limit-status'], exact: true, type: 'all' }, { throwOnError: true, cancelRefetch: false });
    const data = client.getQueryData(['rate-limit-status']);
    if (!data?.rate_limit && !refresh) return null;
    if (!data?.rate_limit) throw new Error('没有读到额度');
    const limits = [data.rate_limit.primary_window, data.rate_limit.secondary_window].filter(Boolean).map(window => ({
      label: window.limit_window_seconds === 604800 ? '每周限制' : window.limit_window_seconds === 18000 ? '5 小时限制' : '额度限制',
      kind: 'limit', basis: 'remaining', pct: 100 - window.used_percent,
      reset: new Date(window.reset_at * 1000).toLocaleString('zh-CN'),
    }));
    const plan = data.plan_type ? data.plan_type[0].toUpperCase() + data.plan_type.slice(1) : '';
    return { cached: !refresh, updated: client.getQueryState(['rate-limit-status']).dataUpdatedAt, missing: !limits.length, quota: [], limits, ...(plan ? { plan } : {}) };
  };

  // Named controls in Cursor's UI; each entry lists fallbacks from newest to oldest Cursor layouts.
  // Devin's permission mode: a chip in the prompt toolbar (Code / Smart / Ask / Plan / Bypass Permissions). Its menu
  // only opens for real mouse events (a JS click does nothing), rows are role=menuitem with a description and a
  // second trailing svg on the current one.
  const DEVIN_MODES = /^(Code|Smart|Ask|Plan|Bypass Permissions)$/;
  const devinModeChip = () => !devinSurface() ? null : [...document.querySelectorAll('button[aria-haspopup="menu"]')]
    .find(b => vis(b) && b.getBoundingClientRect().y > 120 && DEVIN_MODES.test((b.innerText || '').trim()));
  const devinModeRows = () => [...document.querySelectorAll('[role="menuitem"]')].filter(e => vis(e) && /^(Code|Smart|Ask|Plan|Bypass Permissions)\b/.test((e.innerText || '').trim()))
    .map(e => {
      const lines = (e.innerText || '').split('\n').map(x => x.trim()).filter(Boolean);
      return { el: e, label: lines[0], desc: lines[1] || '', checked: e.querySelectorAll(':scope > svg').length > 1 };
    });
  const CONTROLS = {
    mode: () => [...document.querySelectorAll('.composer-unified-dropdown[data-mode]')].find(vis) || devinModeChip(),
    model: () => modelButton(),
    history: () => [...doc.querySelectorAll('[aria-label^="Show Chat History"], [aria-label^="Show Agent History"]')].find(vis),
    newChat: () => [...doc.querySelectorAll('[aria-label="New Agent"], [aria-label^="New Agent ("], [aria-label="New chat"], [aria-label^="New Chat"], [aria-label="New session"], [data-action-id="new-agent"]')].find(vis),
    permission: () => doc.querySelector('[data-composer-navigation-target="permissions"], button[aria-label="Change permissions"]'),
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
    // Radix / Base UI menus ignore element.click(); a real mouse event is required.
    if (name === 'permission' || (name === 'mode' && devinModeChip()) || (name === 'model' && [...el.attributes].some(a => a.name.startsWith('data-base-ui')))) return false;
    el.click();
    return true;
  };

  const MENU_ITEMS = {
    effort: () => [...doc.querySelectorAll('[role=menuitem], .ui-menu__row')].filter(e => vis(e) && /^(Low|Medium|High|Max|Extra High|Ultra)$/i.test(normLabel(e.innerText))).map(el => ({ el, label: normLabel(el.innerText), checked: !!el.querySelector('[class*=check]') || el.getAttribute('aria-checked') === 'true' })),
    mode: () => {
      const cursor = [...document.querySelectorAll('.composer-unified-context-menu-item')].map(e => ({ el: e, label: e.innerText.trim().split('\n')[0], checked: !!e.querySelector('.codicon-check') }));
      return cursor.length ? cursor : devinModeRows();
    },
    model: () => {
      const cp = codexPickerProps();
      if (cp) {
        const rows = (cp.modelOptions || []).filter(o => !o.disabled && !o.model?.hidden).map(o => ({
          el: null, id: o.model.id, params: false,
          label: (o.model.displayName || o.model.id).replace(/-/g, ' '),
          checked: o.model.id === cp.model,
        }));
        if (cp.onSelectDefault) rows.unshift({ el: null, id: 'default', params: false, label: 'Default Recommended set of models', checked: cp.selectionMode === 'default' });
        if (rows.length) return rows;
      }
      const codexRows = [...doc.querySelectorAll('[role=menuitemradio]')].filter(e => {
        if (!vis(e)) return false;
        return true;
      });
      if (codexRows.length) return codexRows.map(e => {
        const label = normLabel(e.innerText).split('\n')[0].slice(0, 60);
        return { el: e, id: label, params: false, label, checked: e.getAttribute('aria-checked') === 'true' };
      });
      const currentModel = normLabel(modelButton()?.innerText || '').split('\n')[0];
      // Auto is its own row and has no .ui-model-picker__item-content-name, so the list below would skip it.
      const autoRows = [...doc.querySelectorAll('[data-testid="auto-mode-select"]')].filter(vis).map(e => {
        const label = normLabel(e.innerText).split('\n')[0].slice(0, 60) || 'Auto';
        return {
          el: e,
          id: e.getAttribute('data-testid'),
          params: false,
          label,
          checked: label === currentModel || !!e.querySelector('[class*=check]') || e.getAttribute('aria-checked') === 'true',
        };
      });
      const classic = [...doc.querySelectorAll('.ui-menu__row')].filter(e => e.getAttribute('data-testid') !== 'auto-mode-select' && e.querySelector('.ui-model-picker__item-content-name'));
      if (classic.length) return [...autoRows, ...classic.map(e => ({ el: e, id: e.dataset.testid, params: !!e.querySelector('[data-testid=parameter-edit-btn]'), label: normLabel(e.querySelector('.ui-model-picker__item-content-name').innerText), checked: !!e.querySelector('.codicon-check, .ui-model-picker__item-right-section [class*=check]') }))];
      const cursorItems = [...doc.querySelectorAll('[data-testid^="model-item-"], [data-testid="auto-mode-select"]')].filter(vis).map(e => {
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
    permission: () => {
      const btn = doc.querySelector('[data-composer-navigation-target="permissions"], button[aria-label="Change permissions"]');
      if (!btn) return [];
      const current = (btn.innerText || '').replace(/\s+/g, ' ').trim();
      return [...doc.querySelectorAll('[role=menuitem]')].filter(vis).map(e => {
        const label = (e.innerText || '').trim().split('\n')[0].trim().slice(0, 40);
        return { el: e, label, checked: label === current };
      }).filter(x => /^(Ask for approval|Approve for me|Full access)$/.test(x.label));
    },
    history: () => {
      const rows = [...doc.querySelectorAll('.composer-history-hover-menu .ui-menu__row')];
      if (rows.length) return rows.map(e => ({ el: e, label: (e.querySelector('.compact-agent-history-react-menu-label, .ui-menu__item-content') || e).innerText.trim().split('\n')[0].slice(0, 80), checked: e.getAttribute('aria-checked') === 'true' || /\b(selected|active|current)\b/.test(e.className) }));
      return [...doc.querySelectorAll('.quick-input-widget .monaco-list-row')].map(e => ({ el: e, label: (e.getAttribute('aria-label') || e.innerText).trim().split('\n')[0].slice(0, 80), checked: e.classList.contains('focused') }));
    },
  };

  const menuItems = kind => (MENU_ITEMS[kind]?.() || []).filter((x, i, rows) => {
    if (!x.label) return false;
    if (rows.findIndex(row => row.label === x.label) !== i) return false;
    if (!x.el) return true;
    if (vis(x.el)) return true;
    const menu = x.el.closest('.ui-menu, [role=menu]');
    return !!(menu && vis(menu) && (x.el.innerText || '').trim());
  }).map(({ el, ...rest }) => rest);

  const menuOpen = () => [...doc.querySelectorAll('.ui-menu, .composer-unified-context-menu-item, .composer-history-hover-menu, [role=menu]')].some(vis) || !!devinModelMenu() || !!fusionPanel();
  const modelListRow = () => [...doc.querySelectorAll('[role=menuitem]')].find(el => vis(el) && (el.getAttribute('aria-label') === 'Select model' || /^Model\b/.test(normLabel(el.innerText))));
  const modelListTrigger = () => {
    const e = modelListRow();
    return e ? center(e) : null;
  };
  const clickModelListTrigger = () => {
    const e = modelListRow();
    if (!e || e.getAttribute('aria-haspopup') === 'menu') return false;
    e.click();
    return true;
  };

  // Model parameters (context size, effort, fast…) live in a per-model submenu behind its "Edit" button.
  const maxToggle = () => {
    const t = [...doc.querySelectorAll('[data-testid=max-mode-toggle]')].find(vis);
    return t ? { ...center(t), on: t.getAttribute('aria-checked') === 'true' } : null;
  };
  const modelTarget = (id, part) => {
    const row = [...doc.querySelectorAll('[data-testid=model-picker-menu] .ui-menu__row')].find(e => e.dataset.testid === id);
    if (!row) return null;
    row.scrollIntoView({ block: 'nearest' });
    if (part !== 'edit') return center(row);
    const b = row.querySelector('[data-testid=parameter-edit-btn]');
    return b && vis(b) ? center(b) : null;
  };
  const paramRows = () => {
    const menu = [...doc.querySelectorAll('[data-testid=parameter-submenu]')].find(vis);
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
    if (!codexThread()) hit.el.scrollIntoView({ block: 'nearest' });
    return codexThread() ? codexPoint(hit.el) : center(hit.el);
  };

  // Returns the button's on-screen center so the click goes through real mouse events.
  const locate = (item, n, actionId, label) => {
    const panel = findPanel();
    if (!panel) return null;
    const root = item === 'g' ? panel : itemByKey(panel, item);
    if (!root) return null;
    let list = item === 'g' ? buttonsIn(panel, true).filter(x => !inItem(x.el) && !inQn(x.el)) : buttonsIn(root, false);
    if (root.hasAttribute?.('data-turn-key')) list = list.filter(x => /^(Copy message|Fork chat from here|View changed files|View changes|Undo|Open agent|View agent|View subagent|Stop agent|Apply|Revert)$/.test(x.label));
    const match = actionId ? list.find(b => b.el.dataset.remoteAction === actionId && b.label === label) : list[n];
    const b = match?.el;
    if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return null;
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
  const historyAtStart = () => {
    let el = devinLog() ? devinScroller() : findPanel();
    while (el && el !== doc.body) {
      const style = getComputedStyle(el);
      if (/auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight) {
        return style.flexDirection === 'column-reverse' ? el.scrollTop <= el.clientHeight - el.scrollHeight + 1 : el.scrollTop <= 1;
      }
      el = el.parentElement;
    }
    return true;
  };

  // Cheap per-window check for notifications: is the Agent running, and is it waiting on a button?
  // "Run in background" shows up on any command running longer than ~5 s; it is not a request for approval.
  const WAIT = /^(?!.*(background|后台))(run|allow|accept|approve|continue|yes\b|运行|允许|接受|批准|继续)/i;
  const agentState = () => {
    const buttons = [...doc.querySelectorAll('button')].filter(vis);
    const back = buttons.findIndex(b => (b.getAttribute('aria-label') || '') === 'Back');
    const active = agentList().find(a => a.current);
    const title = active?.title || (back >= 0 ? ((buttons[back + 1]?.innerText || '').split('\n')[0] || '').trim().slice(0, 80) : '');
    const recent = buttons.find(b => (b.getAttribute('aria-label') || '').startsWith('Recent chats'));
    const progress = Number((/(\d+) in progress/.exec(recent?.getAttribute('aria-label') || '') || [])[1] || 0);
    const thread = activeThread();
    const roots = codexWorkspaceRoots();
    const panel = findPanel();
    if (!panel) {
      if (!thread && !hasComposer()) return null;
      return { busy: isBusy(), waiting: null, waitingText: '', last: '', thread, agentId: active?.id || '', title, progress, roots };
    }
    const busy = isBusy();
    const items = topItems(panel);
    let waiting = null, waitingText = '';
    for (const el of items.slice(-3)) {
      const labels = buttonsIn(el, false).map(x => x.label).filter(l => WAIT.test(l));
      if (labels.length) { waiting = `${itemKey(el)}:${labels.join('/')}`; waitingText = summary(el); }
    }
    const global = buttonsIn(panel, true).filter(x => !inItem(x.el) && !inQn(x.el) && WAIT.test(x.label)).map(x => x.label);
    if (!waiting && global.length) { waiting = `g:${global.join('/')}`; waitingText = global.join(' / '); }
    const devin = !!devinLog();
    const qs = devin ? devinQuestions() : questions();
    let actions;
    if (qs?.list.length) {
      const text = qs.list.map(q => q.text).join(' / ');
      waiting = `q:${text.slice(0, 120)}${qs.pager ? `:${qs.pager.cur}` : ''}`;
      waitingText = text;
      // Devin: single-choice options can be answered from the notification (Android shows three buttons).
      if (devin && !qs.list[0].multi) actions = qs.list[0].options.slice(0, 3).map((o, i) => ({ id: `opt:${i}`, label: o.label.slice(0, 40) }));
    }
    const recentItems = items.slice(items.findLastIndex(el => el.matches('[data-message-kind="human"], [role=group][aria-label="User message"]') || el.querySelector('.composer-human-message, [data-message-kind="human"]')) + 1);
    const lastReply = [...recentItems].reverse().find(el => el.matches('[data-message-kind="assistant"], [role=group][aria-label="Devin message"]') || el.querySelector('[data-message-kind="assistant"]'));
    let last = lastReply ? lastReply.innerText.trim().replace(/\s+/g, ' ').slice(0, 160) : '';
    if (!last) {
      const tail = recentItems.flatMap(el => [...el.querySelectorAll('[class*="MarkdownRoot"]')]).filter(e => vis(e) && !e.closest('[class*="group/user-message"]')).at(-1);
      if (tail) last = tail.innerText.trim().replace(/\s+/g, ' ').slice(0, 160);
    }
    if (codexThread()) {
      const latest = items.filter(el => el.hasAttribute('data-turn-key')).at(-1);
      const reply = latest && codexTurnData(latest)?.items?.filter(it => it.type === 'assistant-message' && it.phase !== 'commentary' && it.completed).at(-1);
      last = (reply?.content || '').trim().replace(/\s+/g, ' ').slice(0, 160);
    }
    return { busy, waiting, waitingText, last, thread, agentId: active?.id || '', title, progress, roots, ...(actions ? { actions } : {}), ...(devin ? { devin: true, changed: changedCount(), tasks: devinTaskState() } : {}) };
  };

  // Cursor Agents window: the left sidebar lists conversations as row:<agent id>.
  const DEVIN_NAV = new Set(['New session', 'Sessions', 'Review', 'Automations', 'Security', 'Wiki', 'Cloud settings']);
  const cursorProjectPicker = () => {
    let el = [...doc.querySelectorAll('.aislash-editor-input[contenteditable="true"], .ui-prompt-input-editor__input[contenteditable="true"]')].find(vis);
    while (el && !Object.keys(el).some(k => k.startsWith('__reactFiber'))) el = el.parentElement;
    return el ? codexFiberProps(el, 40).find(p => p.projectSelectorProps)?.projectSelectorProps : null;
  };
  const cursorSelectProject = (root, host = '') => {
    const picker = cursorProjectPicker();
    const row = picker?.recentProjects?.find(p => {
      const uri = p.workspaceIdentifier?.uri;
      return (uri?.fsPath || uri?.path) === root && (uri.scheme === 'file' ? '' : uri.authority.replace(/^ssh-remote\+/, '')) === host;
    });
    if (!row) return false;
    picker.onSelectTarget({ type: 'workspace', id: row.workspaceIdentifier, displayName: row.name, repoUrls: row.repoUrls });
    return true;
  };
  const cursorWorkspace = id => {
    const el = [...doc.querySelectorAll('[data-glass-agent-id]')].find(e => !id || e.getAttribute('data-glass-agent-id') === id);
    const props = el && codexFiberProps(el, 24).find(p => p.agentWorkspace);
    const uri = props?.agentWorkspace.workspaceIdentifier?.uri || (!id && cursorProjectPicker()?.selectedTarget?.id?.uri);
    return uri ? { root: uri.fsPath || uri.path, host: uri.scheme === 'file' ? '' : uri.authority.replace(/^ssh-remote\+/, '') } : null;
  };
  const agentList = () => {
    const active = [...doc.querySelectorAll('[data-glass-agent-id]')].find(vis)?.getAttribute('data-glass-agent-id') || '';
    const recentProjects = cursorProjectPicker()?.recentProjects || [];
    const cursor = [...doc.querySelectorAll('[data-sidebar-item-key^="row:"]')].map(row => {
      const id = row.getAttribute('data-sidebar-item-key').slice(4);
      const title = (row.querySelector('.ui-sidebar-menu-button-label') || row).textContent.trim().split('\n')[0];
      const repository = codexFiberProps(row).find(p => p.data?.kind === 'sidebar-agent')?.data?.dropSectionId?.replace(/^repo:/, '') || '';
      const projects = recentProjects.filter(p => p.repoUrls?.includes(repository));
      const uri = projects.length === 1 ? projects[0].workspaceIdentifier?.uri : null;
      const workspace = cursorWorkspace(id) || (uri && { root: uri.fsPath || uri.path, host: uri.scheme === 'file' ? '' : uri.authority.replace(/^ssh-remote\+/, '') });
      const group = row.closest('[data-sidebar-group]')?.querySelector('[data-sidebar-group-label]')?.textContent.trim() || '';
      return {
        id,
        title: title.slice(0, 80),
        group,
        repository,
        workspace: workspace?.root || '',
        host: workspace?.host || '',
        current: id === active || !!row.querySelector('[data-active="true"]'),
        running: !!row.querySelector('.ui-dot-grid-loader'),
      };
    }).filter(a => a.id && a.title);
    if (cursor.length) return cursor;
    const tabs = [...doc.querySelectorAll('.tab[data-resource-name]')].filter(t => t.querySelector('.composer-tab-label'));
    const loaded = window.__SSG_COMPOSER_PROVIDER__?.getStates?.() || [];
    const focused = loaded.find(c => c.state === 'focused')?.id;
    if (tabs.length || loaded.length) return [...new Map([
      ...loaded.map(c => [c.id, { id: c.id, title: c.title || '新会话', current: c.state === 'focused', running: c.state === 'generating', workspace: '', host: '', group: '' }]),
      ...tabs.map(t => [t.dataset.resourceName, { id: t.dataset.resourceName, title: t.querySelector('.label-name')?.textContent || '新会话', current: focused ? t.dataset.resourceName === focused : t.classList.contains('active'), workspace: '', host: '', group: '' }]),
    ]).values()];
    // Read the native session id; titles can repeat or change.
    return [...doc.querySelectorAll('li[data-slot="sidebar-menu-item"]')].map(li => {
      const btn = li.querySelector('button[aria-label]');
      const title = (btn?.getAttribute('aria-label') || '').trim();
      if (!title || DEVIN_NAV.has(title)) return null;
      const session = codexFiberProps(li).find(p => p.session)?.session;
      if (!session) return null;
      const slot = li.querySelector('[data-slot="sidebar-menu-button"]');
      return {
        id: session.sessionId,
        workspace: session.cwd || '',
        title: title.slice(0, 80),
        group: '',
        current: slot?.getAttribute('data-active') === 'true',
        running: ['active', 'pending', 'canceling'].includes(session.status),
        lastUsed: Date.parse(session.updatedAt) || 0,
        last: session.agentStopMessage || '',
      };
    }).filter(Boolean);
  };
  const agentTarget = (id, click = false) => {
    if (id && activeThread() === id) return true;
    const tab = [...doc.querySelectorAll('.tab[data-resource-name]')].find(t => t.dataset.resourceName === id && t.querySelector('.composer-tab-label'));
    if (tab) { const r = tab.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
    const row = [...doc.querySelectorAll('[data-sidebar-item-key]')].find(e => e.getAttribute('data-sidebar-item-key') === `row:${id}`);
    if (row && (click || vis(row))) {
      row.scrollIntoView({ block: 'nearest' });
      const hit = row.querySelector('.ui-sidebar-menu-button-content') || row.querySelector('[data-sidebar-menu-button]') || row;
      if (click) { hit.click(); return true; }
      return center(hit);
    }
    if (click && window.__SSG_COMPOSER_PROVIDER__?.getStates?.().some(c => c.id === id)) {
      const services = [...doc.querySelectorAll('[data-message-id]')].flatMap(el => codexFiberProps(el, 40)).find(p => p.uiContextMenuServices)?.uiContextMenuServices;
      if (services) return services.commandService.executeCommand('composer.openComposer', id).then(() => true);
    }
    const li = [...doc.querySelectorAll('li[data-slot="sidebar-menu-item"]')].find(e => codexFiberProps(e).some(p => p.session?.sessionId === id));
    const btn = li && [...li.querySelectorAll('button[aria-label]')].find(vis);
    if (!btn) return null;
    btn.scrollIntoView({ block: 'nearest' });
    if (click) { btn.click(); return true; }
    return center(btn);
  };
  const agentStates = () => {
    const current = agentState();
    if (codexThread()) return current ? [current] : [];
    const agents = agentList();
    return agents.length ? agents.map(a => a.current && current ? current : {
      thread: a.id, agentId: a.id, title: a.title, busy: a.running, waiting: null, last: a.last || '',
    }) : current ? [current] : [];
  };

  // Integrated terminals: the Agents window puts them in editor tabs (aria-controls contains terminal-).
  // Older editor layouts use .terminal-tab. The xterm canvas itself is only used for the crop rectangle.
  const terminalEntries = () => {
    const glass = [...doc.querySelectorAll('.ui-tab-system-tab')].filter(t => vis(t) && /terminal-/i.test(t.getAttribute('aria-controls') || ''));
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
    const single = doc.querySelector('.part.panel .single-terminal-tab');
    if (single && vis(single)) return [{
      id: 'classic-0', title: single.innerText.trim() || '终端', current: true, tab: single,
      close: doc.querySelector('.part.panel .title-actions [aria-label="Kill Terminal"]'),
    }];
    return [...doc.querySelectorAll('.terminal-tabs-list .terminal-tab, .monaco-list-row:has(.terminal-tabs-entry)')].filter(vis).map((tab, i) => ({
      id: tab.id || `classic-${i}`,
      title: (tab.querySelector('.label-name, a') || tab).innerText.trim().split('\n')[0].slice(0, 80) || `终端 ${i + 1}`,
      current: tab.classList.contains('active') || !!tab.querySelector('.terminal-tabs-entry.is-active') || tab.getAttribute('aria-selected') === 'true',
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
    const el = [...doc.querySelectorAll('.terminal-wrapper.active .xterm, .terminal.xterm')].find(vis);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height].map(Math.round);
  };
  const terminalFocus = () => {
    const el = [...doc.querySelectorAll('.terminal-wrapper.active .xterm, .terminal.xterm')].find(vis);
    return el ? center(el) : null;
  };
  const newTerminalDirect = () => {
    const b = [...doc.querySelectorAll('[aria-label="New Terminal"], [aria-label^="New Terminal"]')].find(vis);
    return b ? center(b) : null;
  };
  const newTerminalMenu = () => {
    const buttons = [...doc.querySelectorAll('button')].filter(e => vis(e) && e.getAttribute('aria-label') === 'Open new tab menu');
    if (!buttons.length) return null;
    const active = terminalEntries().find(t => t.current)?.tab;
    if (active) {
      const x = active.getBoundingClientRect().x;
      buttons.sort((a, b) => Math.abs(a.getBoundingClientRect().x - x) - Math.abs(b.getBoundingClientRect().x - x));
    }
    return center(buttons[0]);
  };
  const labeled = name => [...doc.querySelectorAll('button, [role=button]')].find(e => vis(e) && (e.getAttribute('aria-label') || '') === name);
  const onScreen = e => {
    const b = e.getBoundingClientRect();
    return b.width > 2 && b.height > 2 && b.bottom > 0 && b.right > 0 && b.top < innerHeight && b.left < innerWidth;
  };
  // The gear's label flips to "Close Settings". Devin opens a settings editor tab instead.
  const settingsOpen = () => {
    if ([...doc.querySelectorAll('button, [role=button]')].some(e => onScreen(e) && e.getAttribute('aria-label') === 'Close Settings')) return true;
    if ([...doc.querySelectorAll('input')].some(e => onScreen(e) && /search settings/i.test(e.getAttribute('aria-label') || ''))) return true;
    const tab = [...doc.querySelectorAll('.tab.active')].find(onScreen);
    return /settings/i.test(tab?.getAttribute('aria-label') || tab?.innerText || '');
  };
  const clickSettingsButton = () => {
    const b = [...doc.querySelectorAll('button, [role=button]')].find(e => onScreen(e) && /^(Settings|Open Cursor Settings)$/.test(e.getAttribute('aria-label') || ''));
    if (!b) return false;
    b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    b.click();
    return true;
  };
  const clickCloseSettings = () => {
    const b = [...doc.querySelectorAll('button, [role=button]')].find(e => onScreen(e) && e.getAttribute('aria-label') === 'Close Settings');
    if (b) { b.click(); return 'button'; }
    const tab = [...doc.querySelectorAll('.tab.active')].find(onScreen);
    if (/settings/i.test(tab?.getAttribute('aria-label') || '')) return 'tab';
    return '';
  };
  const openSettingsTarget = () => { const b = labeled('Settings'); return b ? center(b) : null; };
  const closeSettingsTarget = () => { const b = labeled('Close Settings'); return b ? center(b) : null; };
  const settingsPanel = () => {
    const close = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Close Settings');
    if (close && vis(close)) {
      let p = close;
      for (let i = 0; i < 16 && p; i++) {
        const box = p.getBoundingClientRect();
        if ((p.innerText || '').includes('Plan & Usage') && box.width > 300 && box.height > 200) return p;
        p = p.parentElement;
      }
    }
    const nav = [...doc.querySelectorAll('button, [role=button], .cursor-settings-sidebar-nav-cell')].find(e => vis(e) && (e.innerText || '').trim() === 'Plan & Usage');
    let p = nav;
    for (let i = 0; i < 16 && p; i++) {
      const box = p.getBoundingClientRect();
      if (p.querySelector('h1, h2, .ui-section') && box.width > 300 && box.height > 200) return p;
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
  const codexSettingsData = () => {
    const mark = el => { el.dataset.remoteSetting ||= crypto.randomUUID(); return el.dataset.remoteSetting; };
    const nav = [...doc.querySelectorAll('[data-appearance] button.sidebar-item')].filter(vis).map(el => ({ id: mark(el), label: el.getAttribute('aria-label') || el.textContent.trim(), current: el.getAttribute('aria-current') === 'page' }));
    const control = el => ({ id: mark(el), label: el.getAttribute('aria-label') || (el.innerText || el.textContent).trim(), role: el.getAttribute('role') || '', on: el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true', disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' });
    const rows = [...doc.querySelectorAll('[class*="/settings-row"]')].filter(vis).map(row => ({
      label: row.querySelector('[class*="font-medium"]')?.textContent.trim() || row.innerText.split('\n')[0],
      detail: (row.firstElementChild?.innerText || '').split('\n').slice(1).join('\n').trim(),
      controls: [...row.querySelectorAll('button')].filter(vis).map(control),
    }));
    const choices = [...doc.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"]')].filter(vis).map(control);
    return { nav, rows, choices };
  };
  const codexSettingPoint = id => {
    const el = [...doc.querySelectorAll('[data-remote-setting]')].find(e => e.dataset.remoteSetting === id);
    if (!el || !vis(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') return null;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return codexPoint(el);
  };

  const DEVIN_SETTINGS_NAV = /^(General|Plan information|Extensions|Agents|Configuration|Customizations|User interface|Devin Tab|Shortcuts|Advanced)$/;
  const devinSettingsNav = () => [...doc.querySelectorAll('button')].filter(e => onScreen(e) && DEVIN_SETTINGS_NAV.test((e.innerText || '').trim())).map(e => (e.innerText || '').trim());
  const devinSettingsClick = name => {
    const b = [...doc.querySelectorAll('button')].find(e => onScreen(e) && (e.innerText || '').trim() === name);
    if (!b) return false;
    b.click();
    return true;
  };
  const devinSettingsCards = () => {
    const root = [...doc.querySelectorAll('.editor-instance')].find(onScreen);
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
    const e = [...root.querySelectorAll('button, [role=button], .cursor-settings-sidebar-nav-cell')].find(el => vis(el) && (el.innerText || '').trim() === 'Plan & Usage');
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
    const rawBars = [...root.querySelectorAll('[role=progressbar]')].filter(vis);
    const loading = rawBars.some(e => /^loading\b/i.test((e.getAttribute('aria-label') || '').trim()));
    const limits = rawBars.map(e => {
      if (!e.hasAttribute('aria-valuenow')) return null;
      const now = Number(e.getAttribute('aria-valuenow'));
      const max = Number(e.getAttribute('aria-valuemax')) || 100;
      const label = (e.getAttribute('aria-label') || '').trim();
      if (!label || /^loading\b/i.test(label) || !Number.isFinite(now) || !max) return null;
      const pct = Math.max(0, Math.min(100, Math.round(now / max * 100)));
      let node = e;
      let basis = 'used';
      for (let i = 0; i < 8 && node; i++) {
        const around = (node.innerText || '').replace(/\s+/g, ' ');
        if (around.length < 500) {
          if (new RegExp(pct + '%\\s+(?:left|remaining)', 'i').test(around)) { basis = 'remaining'; break; }
          if (new RegExp(pct + '%\\s+used', 'i').test(around)) { basis = 'used'; break; }
        }
        node = node.parentElement;
      }
      return { label: label.slice(0, 40), kind: 'limit', basis, pct };
    }).filter(Boolean);
    const lines = ((best || root).innerText || '').split('\n').map(s => s.trim()).filter(s => s && !nav.has(s)).slice(0, 32);
    const reset = lines.find(l => /reset/i.test(l)) || '';
    const planIdx = lines.findIndex(l => l === 'CURRENT PLAN');
    const plan = planIdx >= 0 && lines[planIdx + 1] ? lines[planIdx + 1] : '';
    return { lines: lines.map(l => l.slice(0, 180)), quota: [], plan, limits: limits.map(b => ({ ...b, reset })), loading, missing: !limits.length && !loading };
  };

  const newTerminalItem = () => {
    const rows = [...doc.querySelectorAll('[role=listbox] [role=option], [role=listbox] button, [role=menu] [role=menuitem]')];
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
  const activeTerminal = () => doc.querySelector('.terminal-wrapper.active .xterm-wrapper')?.xterm || doc.querySelector('.terminal-wrapper.active')?.xterm || doc.querySelector('.xterm-wrapper')?.xterm;
  const terminalCommand = () => {
    const term = activeTerminal();
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
    const term = activeTerminal();
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
    const body = { lines: lines.slice(0, end), cursor: [cursorY, cursorX], name: terminalList().find(t => t.current)?.title || '' };
    const raw = JSON.stringify(body);
    let h = 2166136261;
    for (let i = 0; i < raw.length; i++) h = Math.imul(h ^ raw.charCodeAt(i), 16777619);
    const hash = (h >>> 0).toString(36);
    return prev === hash ? { hash } : { hash, ...body };
  };

  const quickOpenRows = () => {
    const w = doc.querySelector('.quick-input-widget');
    if (!w || !vis(w)) return null;
    return [...w.querySelectorAll('.monaco-list-row')].filter(vis).map(e => ({
      name: e.querySelector('.label-name')?.innerText.trim() || '',
      dir: e.querySelector('.label-description')?.innerText.trim() || '',
    }));
  };

  const codexButton = label => [...doc.querySelectorAll('button')].find(e => vis(e) && (e.getAttribute('aria-label') || '') === label)
    || [...doc.querySelectorAll('button')].find(e => vis(e) && (e.getAttribute('aria-label') || '').startsWith(label));
  const codexPoint = el => {
    const c = center(el);
    const frame = document.getElementById('active-frame');
    if (!frame || el.ownerDocument === document) return c;
    const o = frame.getBoundingClientRect();
    return { x: c.x + o.x, y: c.y + o.y };
  };
  const codexRecentPoint = () => { const b = codexButton('Recent chats'); return b ? codexPoint(b) : null; };
  const codexNewPoint = () => { const b = codexButton('New chat'); return b ? codexPoint(b) : null; };
  const codexAccountPoint = () => {
    const buttons = [...doc.querySelectorAll('button')].filter(e => {
      const r = e.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.y < 0 || r.y > 70) return false;
      if ((e.getAttribute('aria-label') || '') || (e.innerText || '').trim()) return false;
      return (e.getAttribute('aria-haspopup') || e.parentElement?.getAttribute('aria-haspopup')) === 'menu';
    });
    return buttons[0] ? codexPoint(buttons[0]) : null;
  };
  const codexMenuPoint = label => {
    const el = [...doc.querySelectorAll('button, [role=menuitem], a')].find(e => {
      const r = e.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.bottom < 0) return false;
      const text = ((e.getAttribute('aria-label') || e.innerText || '').replace(/\s+/g, ' ').trim());
      return text === label || text.startsWith(label);
    });
    return el ? codexPoint(el) : null;
  };
  const clickLabeled = label => {
    const el = [...doc.querySelectorAll('button, [role=menuitem], a')].find(e => {
      const r = e.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const text = ((e.getAttribute('aria-label') || e.innerText || '').replace(/\s+/g, ' ').trim());
      return text === label || text.startsWith(label);
    });
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    el.click();
    return true;
  };
  const scrollCodexHistory = restore => {
    const first = [...doc.querySelectorAll('[data-turn-key]')].find(vis);
    let el = first;
    while (el && el !== doc.body) {
      if (/auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight) {
        if (typeof restore === 'number') { el.scrollTop = restore; return null; }
        const scrollTop = el.scrollTop;
        if (restore === false) return { ...codexPoint(el), scrollTop };
        if (restore === 'latest') {
          const rows = [...doc.querySelectorAll('[data-turn-key]')];
          if (rows.some(row => codexFiberProps(row, 16).some(p => p.entry?.isLatestTurn))) return null;
          el.scrollTop = getComputedStyle(el).flexDirection === 'column-reverse' ? 0 : el.scrollHeight;
          return { scrollTop, thread: codexThread() };
        }
        first.scrollIntoView({ block: 'start' });
        return { ...codexPoint(el), scrollTop };
      }
      el = el.parentElement;
    }
    return null;
  };
  const codexViewState = () => ({ thread: codexThread(), turns: [...doc.querySelectorAll('[data-turn-key]')].filter(vis).length });
  const codexFiberProps = (el, depth = 16) => {
    while (el && !Object.keys(el).some(k => k.startsWith('__reactFiber'))) el = el.parentElement;
    const key = el && Object.keys(el).find(k => k.startsWith('__reactFiber'));
    let fiber = key ? el[key] : null;
    const props = [];
    for (let i = 0; i < depth && fiber; i++) {
      if (fiber.memoizedProps && typeof fiber.memoizedProps === 'object') props.push(fiber.memoizedProps);
      fiber = fiber.return;
    }
    return props;
  };
  // Recent-chat rows carry the conversation id on the React node, not on a stable attribute.
  const codexChatRows = (readOnly = false) => {
    const menu = [...doc.querySelectorAll('[role=menu]')].find(e => vis(e) && /Search recent chats/.test(e.innerText || ''));
    const seen = new Set();
    const rows = [];
    const recent = codexQueryClient()?.getQueryData(['recent-conversations-meta', 'updated_at', '[]', 'live']) || [];
    if (readOnly) return recent.map(thread => ({ id: thread.conversationId, title: thread.title || '', workspace: thread.cwd || '', host: thread.hostId === 'local' ? '' : thread.hostId || '', lastUsed: thread.updatedAt || 0 }));
    if (!menu) return [];
    const usedAt = new Map(recent.map(thread => [thread.conversationId, thread.updatedAt]));
    const metadata = new Map(recent.map(thread => [thread.conversationId, thread]));
    for (const el of menu.querySelectorAll('[role=button]')) {
      let id = '', title = '', current = false, workspace = '', running = false;
      for (const p of codexFiberProps(el)) {
        if (p.conversationId) id = String(p.conversationId);
        else if (typeof p.href === 'string' && p.href.startsWith('/local/')) id = p.href.split('/').pop();
        if (typeof p.title === 'string' && p.title) title = p.title;
        if (p.isActive === true) current = true;
        if (typeof p.envTooltip === 'string') workspace = p.envTooltip;
        if (p.isRunning === true || p.running === true) running = true;
      }
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (/in progress/i.test(text)) running = true;
      const meta = metadata.get(id);
      rows.push({ id, title: (title || text).split('\n')[0].slice(0, 80), current, workspace: meta?.cwd || workspace, host: meta?.hostId && meta.hostId !== 'local' ? meta.hostId : '', running, lastUsed: usedAt.get(id) || 0 });
    }
    return rows;
  };
  const codexChatPoint = id => {
    const menu = [...doc.querySelectorAll('[role=menu]')].find(e => vis(e) && /Search recent chats/.test(e.innerText || ''));
    if (!menu) return null;
    for (const el of menu.querySelectorAll('[role=button]')) {
      const hit = codexFiberProps(el).some(p => p.conversationId === id || (typeof p.href === 'string' && p.href.endsWith('/' + id)));
      if (hit) { el.scrollIntoView({ block: 'nearest' }); return codexPoint(el); }
    }
    return null;
  };
  // Each recent-chat row has its own Archive chat button. Delete chat is used only when that row actually shows it.
  const codexArchiveTarget = id => {
    const menu = [...doc.querySelectorAll('[role=menu]')].find(e => vis(e) && /Search recent chats/.test(e.innerText || ''));
    if (!menu) return null;
    for (const el of menu.querySelectorAll('[role=button]')) {
      const hit = codexFiberProps(el).some(p => p.conversationId === id || (typeof p.href === 'string' && p.href.endsWith('/' + id)));
      if (!hit) continue;
      const buttons = [...el.querySelectorAll('button')].filter(b => b.getBoundingClientRect().width > 0);
      const labels = buttons.map(b => b.getAttribute('aria-label') || '');
      const action = labels.includes('Delete chat') ? 'Delete chat' : labels.includes('Archive chat') ? 'Archive chat' : '';
      const btn = buttons.find(b => (b.getAttribute('aria-label') || '') === action);
      if (!btn) return { action: '' };
      el.scrollIntoView({ block: 'nearest' });
      return { action, ...codexPoint(btn) };
    }
    return null;
  };
  const codexArchiveConfirm = () => {
    const dialog = [...doc.querySelectorAll('[role=dialog]')].find(e => vis(e) && e.getBoundingClientRect().height > 20);
    if (!dialog) return null;
    const buttons = [...dialog.querySelectorAll('button')].filter(vis);
    const btn = buttons.find(b => /^(Archive chat|Delete chat|Archive|Delete)$/i.test(((b.innerText || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())));
    if (!btn) return { label: '' };
    return { label: (btn.innerText || btn.getAttribute('aria-label') || '').trim(), ...codexPoint(btn) };
  };

  const codexPromptEl = () => doc.querySelector('.ProseMirror[contenteditable="true"]');
  const codexPromptText = () => {
    const ed = codexPromptEl();
    if (!ed) return null;
    return (ed.innerText || '').replace(/[\u200b\ufeff]/g, '').replace(/^\n/, '').replace(/\n+$/g, '');
  };
  const codexSelectPrompt = () => {
    const ed = codexPromptEl();
    if (!ed) return false;
    ed.focus();
    const sel = ed.ownerDocument.getSelection();
    const range = ed.ownerDocument.createRange();
    range.selectNodeContents(ed);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  };
  const codexPromptPoint = () => {
    const ed = codexPromptEl();
    if (!ed || !vis(ed)) return null;
    const r = ed.getBoundingClientRect();
    return codexPoint(ed);
  };
  const codexButtonPoint = which => {
    const buttons = [...doc.querySelectorAll('button')].filter(vis);
    const el = which === 'ide' ? buttons.find(b => /IDE context/i.test(b.getAttribute('aria-label') || ''))
      : which === 'run' ? buttons.find(b => (b.getAttribute('aria-label') || '') === 'Select where to run the chat')
      : which === 'actions' ? buttons.find(b => (b.getAttribute('aria-label') || '') === 'Chat actions')
      : null;
    return el ? codexPoint(el) : null;
  };
  const codexMentionRows = () => {
    const root = doc.querySelector('[data-mention-list-scroll-area]');
    if (!root || root.getBoundingClientRect().height < 8) return [];
    const rows = [];
    for (const sec of doc.querySelectorAll('[data-mention-section-id]')) {
      const section = sec.getAttribute('data-mention-section-id') || '';
      for (const item of sec.querySelectorAll('[data-list-navigation-item]')) {
        const r = item.getBoundingClientRect();
        if (r.height < 8 || r.width < 8) continue;
        const lines = (item.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
        let key = '';
        for (const p of codexFiberProps(item, 8)) {
          if (typeof p.key === 'string' && p.key) { key = p.key; break; }
        }
        const label = (lines[0] || '').slice(0, 80);
        if (!label) continue;
        rows.push({
          section, key: key || `${section}:${label}:${lines.slice(1).join(' ')}`, label,
          sub: lines.slice(1).join(' ').slice(0, 160),
          ...codexPoint(item),
        });
      }
    }
    return rows;
  };
  const codexRunItems = () => [...doc.querySelectorAll('[role=menuitem]')].filter(vis).map(e => {
    const label = (e.innerText || '').replace(/\s+/g, ' ').trim();
    const r = e.getBoundingClientRect();
    return { label, ...codexPoint(e) };
  }).filter(x => x.label);
  const codexQueued = () => {
    const thread = codexThread();
    const value = codexQueryClient()?.getQueryData(['vscode', 'get-global-state', '{"key":"queued-follow-ups"}'])?.value;
    const raw = value && typeof value === 'object' ? value[thread] : null;
    if (!Array.isArray(raw)) return [];
    return raw.map((m, n) => ({
      id: String(m?.id || `cq${n}`),
      t: String(m?.text || m?.message || m?.content || '').slice(0, 4000),
      src: 'codex',
    })).filter(m => m.t);
  };
  const codexQueueAction = async (id, action) => {
    if (!codexQueued().some(m => m.id === id)) return false;
    const name = { send: 'onSendNowMessage', remove: 'onDeleteMessage', edit: 'onEditMessage' }[action];
    for (const el of doc.querySelectorAll('button')) {
      for (const p of codexFiberProps(el, 32)) {
        const actions = p.messageListActions || p;
        if (typeof actions[name] === 'function') { await actions[name](id); return true; }
      }
    }
    return false;
  };
  // Read pending native cards, keeping their real controls rather than reproducing approval semantics.
  const codexRequests = () => {
    if (!codexThread()) return [];
    const rows = new Map();
    const query = selector => [...new Set([doc, document])].flatMap(d => [...d.querySelectorAll(selector)]);
    for (const skip of query('[data-request-input-dismiss]').filter(vis)) {
      const props = codexFiberProps(skip, 48).find(p => Array.isArray(p.questions) && typeof p.onDraftChange === 'function' && typeof p.onSubmit === 'function');
      if (!props) continue;
      const index = props.questionIndex;
      const question = props.questions[index];
      if (!question) continue;
      const id = 'async:' + question.id;
      const buttons = question.options.map(option => ({ label: option, selected: question.draft === option, disabled: !!props.isSubmitting, action: () => props.onDraftChange(option) }));
      buttons.push({ el: skip, label: skip.innerText || 'Skip', disabled: !!props.isSubmitting });
      buttons.push({ label: index < props.questions.length - 1 ? 'Next' : props.hasSubmitted ? 'Send update' : 'Send', disabled: !!props.isSubmitting || !question.draft.trim(), action: () => index < props.questions.length - 1 ? props.onQuestionChange(index + 1) : props.onSubmit() });
      rows.set(id, { id, text: question.question, buttons, fields: [{ label: '回答', value: question.draft, type: 'text', onChange: props.onDraftChange }] });
    }
    for (const el of query('button, input, textarea, select, [role=radio], [role=checkbox]')) {
      if (!vis(el) || el.closest('[contenteditable=true]')) continue;
      const props = codexFiberProps(el, 32).find(p => p.request?.item?.requestId || (p.item?.requestId && (p.onReply || p.onApprove || p.onSubmit)));
      const request = props?.request || (props?.item ? props : null);
      const item = request?.item;
      if (!item) continue;
      const id = String(item.requestId);
      if (!rows.has(id)) rows.set(id, { id, text: item.title || item.reason || item.command || (item.questions || []).map(q => q.question || q.title || q.header).join('\n') || request.kind || 'Codex 请求', buttons: [], fields: [] });
      const row = rows.get(id);
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !/^(checkbox|radio|hidden)$/.test(el.type)) {
        row.fields.push({ el, label: el.getAttribute('aria-label') || el.placeholder || el.name || '回答', value: el.value || '', type: el.type, options: el.tagName === 'SELECT' ? [...el.options].map(o => ({ value: o.value, label: o.text })) : null });
      } else {
        const label = (el.getAttribute('aria-label') || el.innerText || '').trim();
        if (label && !row.buttons.some(b => b.el === el)) row.buttons.push({ el, label, selected: el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true' || el.getAttribute('data-state') === 'checked', disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', ...codexPoint(el) });
      }
    }
    const questionCards = new Set(query('[role=dialog]').filter(vis));
    for (const field of query('textarea,input,[contenteditable=true]').filter(vis)) {
      for (let card = field.parentElement, depth = 0; card && depth < 7; card = card.parentElement, depth++) {
        const heading = [...card.querySelectorAll('h1,h2,h3,[role=heading],span,p,div')].find(e => e.children.length === 0 && /^(Question|提问|问题)$/.test(e.textContent.trim()));
        if (heading) { questionCards.add(card); break; }
      }
    }
    for (const dialog of questionCards) {
      if ([...rows.values()].some(r => [...r.buttons, ...r.fields].some(b => b.el && dialog.contains(b.el)))) continue;
      const title = dialog.getAttribute('aria-label') || dialog.querySelector('h1,h2,h3')?.innerText || 'Codex';
      const content = dialog.cloneNode(true);
      content.querySelectorAll('button,input,textarea,select,[contenteditable=true],[role=radio],[role=checkbox]').forEach(el => el.remove());
      const text = (content.textContent || title).trim();
      const id = 'dialog:' + title + ':' + text.slice(0, 160);
      rows.set(id, {
        id, text: text.slice(0, 6000),
        buttons: [...dialog.querySelectorAll('button, [role=radio], [role=checkbox]')].filter(vis).map(el => ({ el, label: el.getAttribute('aria-label') || el.innerText || el.title || '确认', selected: el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true' || el.getAttribute('data-state') === 'checked', disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', ...codexPoint(el) })),
        fields: [...dialog.querySelectorAll('input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable=true]')].filter(vis).map(el => ({ el, label: el.getAttribute('aria-label') || el.placeholder || el.name || '输入', value: el.value ?? el.innerText ?? '', type: el.type, options: el.tagName === 'SELECT' ? [...el.options].map(o => ({ value: o.value, label: o.text })) : null })),
      });
    }
    return [...rows.values()];
  };
  const codexRequestData = () => codexRequests().map(r => ({ id: r.id, text: String(r.text).slice(0, 6000), buttons: r.buttons.map(({ label, disabled, selected }) => ({ label, disabled, selected })), fields: r.fields.map(({ label, value, type, options }) => ({ label, value, type, options })) }));
  const codexRequestTarget = (id, n) => { const b = codexRequests().find(r => r.id === id)?.buttons[n]; return b?.el ? codexPoint(b.el) : null; };
  const codexRequestAction = async (id, n) => {
    const button = codexRequests().find(r => r.id === id)?.buttons[n];
    if (!button?.action || button.disabled) return false;
    await button.action();
    return true;
  };
  const codexRequestField = (id, n, value) => {
    const field = codexRequests().find(r => r.id === id)?.fields[n];
    if (field?.onChange) { field.onChange(value); return true; }
    const el = field?.el;
    if (!el) return false;
    const w = el.ownerDocument.defaultView;
    if (el.isContentEditable) {
      el.focus();
      el.ownerDocument.execCommand('selectAll', false);
      el.ownerDocument.execCommand('insertText', false, value);
      return true;
    }
    const proto = el.tagName === 'TEXTAREA' ? w.HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? w.HTMLSelectElement.prototype : w.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new w.Event('input', { bubbles: true }));
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
    return true;
  };
  const codexImage = async src => {
    const r = await fetch(src);
    if (!r.ok) throw new Error('图片读取失败');
    const blob = await r.blob();
    if (!blob.type.startsWith('image/') || blob.size > 8 * 1024 * 1024) throw new Error('图片超过预览限制');
    return await new Promise((resolve, reject) => { const f = new FileReader(); f.onload = () => resolve(f.result); f.onerror = reject; f.readAsDataURL(blob); });
  };
  const codexSkills = () => {
    const queries = codexQueryClient()?.getQueryCache().getAll().filter(q => q.queryKey[0] === 'skills') || [];
    const skills = queries.flatMap(q => q.state.data?.data || []).flatMap(d => d.skills || []).filter(s => s.enabled);
    return [...new Map(skills.map(s => [s.path, { label: s.interface?.displayName || s.name, q: s.interface?.displayName || s.name, sub: `${s.name} · ${s.interface?.shortDescription || s.description || ''}`, section: 'skills', trigger: '/' }])).values()];
  };
  const codexChanges = () => {
    const files = new Map();
    const turns = [...doc.querySelectorAll('[data-turn-key]')];
    const changedTurn = [...turns].reverse().find(el => codexTurnData(el)?.items?.some(item => item.type === 'patch'));
    for (const item of codexTurnData(changedTurn || doc.body)?.items || []) {
      if (item.type !== 'patch') continue;
      for (const [name, change] of Object.entries(item.changes || {})) {
        const diff = typeof change === 'string' ? change : change.unified_diff || change.diff || change.unifiedDiff || (change.type === 'add' ? String(change.content || '').replace(/\n$/, '').split('\n').map(l => '+' + l).join('\n') : '');
        const lines = diff.split('\n');
        const previous = files.get(name);
        const add = lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
        const del = lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length;
        files.set(name, { name, add: diff ? '+' + (add + Number(previous?.add || 0)) : '未获取', del: diff ? '-' + (del + Math.abs(Number(previous?.del || 0))) : '', diff: [previous?.diff, diff].filter(Boolean).join('\n') });
      }
    }
    const last = [...turns].reverse().find(el => buttonsIn(el, false).some(b => /^(Undo|Apply|Revert|View changes|View changed files)$/.test(b.label)));
    const actions = last ? buttonsIn(last, false).filter(b => /^(Undo|Apply|Revert|View changes|View changed files)$/.test(b.label)).map(b => b.label) : [];
    return { files: [...files.values()], actions, count: files.size, turn: last?.getAttribute('data-turn-key') || '' };
  };
  const codexChangeTarget = label => {
    const turn = codexChanges().turn;
    const el = [...doc.querySelectorAll('[data-turn-key]')].find(el => el.getAttribute('data-turn-key') === turn);
    const b = el && buttonsIn(el, false).find(b => b.label === label);
    return b ? codexPoint(b.el) : null;
  };
  const codexFacts = () => {
    if (!doc.querySelector('button[aria-label="Add files and more"]')) return null;
    let plan = false, ideStatus = '', autoContext;
    const add = doc.querySelector('button[aria-label="Add files and more"]');
    let fiber = add?.[Object.keys(add).find(k => k.startsWith('__reactFiber'))];
    for (let i = 0; i < 40 && fiber; i++) {
      const props = fiber.memoizedProps || {};
      if (!plan && props.activeCollaborationMode?.mode) plan = props.activeCollaborationMode.mode === 'plan';
      if (!ideStatus && typeof props.ideContextStatus === 'string') ideStatus = props.ideContextStatus;
      if (typeof props.isAutoContextOn === 'boolean') autoContext = props.isAutoContextOn;
      fiber = fiber.return;
    }
    const ideBtn = [...doc.querySelectorAll('button')].find(e => vis(e) && /IDE context/i.test(e.getAttribute('aria-label') || ''));
    const runBtn = [...doc.querySelectorAll('button')].find(e => vis(e) && (e.getAttribute('aria-label') || '') === 'Select where to run the chat');
    const ideOn = autoContext ?? (ideBtn ? /^turn off/i.test(ideBtn.getAttribute('aria-label') || '') : false);
    let file = null;
    if (ideOn) {
      const active = codexQueryClient()?.getQueryData(['ide-context', null])?.activeFile;
      const sel = active?.selection;
      const start = sel?.start?.line;
      const end = sel?.end?.line;
      const range = Number.isInteger(start) && (start !== end || sel.start.character !== sel.end.character) ? `${start + 1}-${(end ?? start) + 1}` : '';
      if (active?.label) file = { label: active.label, path: active.path || '', range };
    }
    const follow = codexQueryClient()?.getQueryData(['vscode', 'get-settings'])?.values?.followUpQueueMode || '';
    const run = runBtn ? (runBtn.innerText || '').replace(/\s+/g, ' ').trim() : '';
    return {
      queued: codexQueued(),
      view: {
        plan, follow, run, enter: codexQueryClient()?.getQueryData(['vscode', 'get-settings'])?.values?.composerEnterBehavior || 'enter',
        actions: !!codexButtonPoint('actions'),
        ide: ideBtn || ideStatus ? { on: ideOn, file: ideOn ? file : null } : null,
      },
    };
  };

  return { historyAtStart, cursorSelectProject, cursorWorkspace, scrollCodexHistory, setCommandOpen, attachmentRows, removeAttachment, submitCodexMessage, extract, activeThread, codexThread, openCodexThread, codexViewState, codexRecentPoint, codexNewPoint, codexAccountPoint, codexMenuPoint, clickLabeled, codexChatRows, codexChatPoint, codexArchiveTarget, codexArchiveConfirm, codexPromptText, codexSelectPrompt, codexPromptPoint, codexButtonPoint, composerDraft, composerFocused, setComposerDraft, codexMentionRows, codexRunItems, codexFacts, codexQueueAction, codexSkills, codexChanges, codexChangeTarget, codexRequestData, codexRequestTarget, codexRequestAction, codexRequestField, codexImage, locate, panelRect, control, menuItems, menuItem, quickOpenRows, agentList, agentTarget, agentState, agentStates, queueTarget, stopTarget, focusQueueEdit,
    terminalList, terminalTarget, terminalCloseTarget, terminalRect, terminalFocus, newTerminalDirect, newTerminalMenu, newTerminalItem, terminalDump, terminalCommand, modelListTrigger,
    codexSettingsData, codexSettingPoint, settingsOpen, clickSettingsButton, clickCloseSettings, openSettingsTarget, closeSettingsTarget, readSettings, settingTarget, usageNavTarget, readUsage, readDevinUsage, refreshCodexUsage, codexWorkspaceRoots, contextPct,
    clickControl, clickModelListTrigger, effortItems, pickEffort, effortTrigger, closeCodexMenu, closeModelMenu, fastInfo, pickFast, fastTarget, clickCursorFast, devinVariants, devinPickerProps, codexPickerProps, pickCodexModel, modelItemsFast, pickDevinModel, attachmentPoint, devinSettingsNav, devinSettingsClick, devinSettingsCards,
    codexFusionTurn, codexCurrentProject, fusionConfig, clickFusionCombo, clickFusionFast, fusionOptionItems, fusionOptionTarget,
    menuOpen, maxToggle, modelTarget, modelParams, paramTarget, subTarget, activeChatTab, tabTarget, hasComposer, filesState, fileTarget, questionTarget,
    closedThinkingIndexes, clickThinking, closeThinkingIfOpen, thoughtIndexFor, setTasksOpen, devinQueueTarget, workspaceTrustState,
    workdirInfo, workdirTarget, workdirRows, envRows, composerState, mentionRows, devinSession, devinTabTarget, clickDevinTab, devinTabCloseTarget, clickDevinTabClose, devinQuestions, thoughtState, setThoughtOpen, thoughtBodyText, devinQueued, devinQueueClearTarget, devinQueueCount, revertTarget, revertDialog, revertDialogButton, revertState, devinSurface, surfaceTarget, transcriptVisible, sessionSearchTarget, sessionPickerRows, sessionPickerTarget };
}

const helpersCall = call => `(${pageHelpers.toString()})().${call}`;
const uploads = new Map();
const codexUsage = { data: null, refresh: null, retryAt: 0, failures: 0 };
const cursorUsage = { data: null, initial: null };
const appPlans = {};

// Fills appPlans right after the phone's connAgents probe so plan badges don't wait for a usage read.
let plansRead = null;
const tapPoint = async (cdp, x, y) => {
  const base = { x, y, button: 'left', clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
};
async function cursorPlanFor(cdp) {
  return (await cdp.evaluate(helpersCall('readUsage()')))?.plan || '';
}

function readAllPlans(session) {
  if (plansRead) return plansRead;
  plansRead = (async () => {
    try {
      const wins = await listWindows();
      const codex = wins.find(w => w.app === 'codex');
      if (codex && !appPlans.codex) {
        const page = (await codexWindows(CODEX_CDP_URL)).find(p => p.chatWs);
        if (page) {
          const cdp = new Cdp(page.chatWs);
          try {
            await cdp.connect();
            const u = await cdp.evaluate(helpersCall('refreshCodexUsage(false)'), { timeout: 30000 }).catch(() => null);
            if (u?.plan) appPlans.codex = u.plan;
          } finally { cdp.close(); }
        }
      }
      for (const w of wins) {
        if (appPlans[w.app] || (w.app !== 'devin' && w.app !== 'cursor')) continue;
        const cdp = new Cdp(w.ws);
        try {
          await cdp.connect();
          if (w.app === 'devin') {
            const u = await cdp.evaluate(helpersCall('readDevinUsage()'), { timeout: 30000 }).catch(() => null);
            if (u?.plan) appPlans.devin = u.plan;
          } else {
            const plan = await cursorPlanFor(cdp).catch(() => '');
            if (plan) appPlans.cursor = plan;
          }
        } finally { cdp.close(); }
      }
      session.emit({ t: 'plans', plans: appPlans });
    } catch {}
  })().finally(() => { plansRead = null; });
  return plansRead;
}

const CURSOR_BIN = fs.existsSync('/usr/share/cursor/bin/cursor') ? '/usr/share/cursor/bin/cursor' : 'cursor';

function safeHomePath(input) {
  const home = fs.realpathSync(os.homedir());
  const target = input ? path.resolve(String(input)) : home;
  let real;
  try { real = fs.realpathSync(target); }
  catch { throw new Error('找不到这个文件夹'); }
  if (process.platform !== 'win32' && real !== home && !real.startsWith(home + path.sep)) throw new Error('只能打开家目录里的文件夹');
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
    parent: (process.platform === 'win32' ? real === path.dirname(real) : real === home) ? null : path.dirname(real),
    drives: process.platform === 'win32' ? [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(letter => `${letter}:\\`).filter(root => fs.existsSync(root)) : [],
    dirs: names.map(name => ({ name, path: path.join(real, name) })),
  };
}

const DEVIN_BIN = fs.existsSync('/usr/share/devin-desktop/bin/devin-desktop') ? '/usr/share/devin-desktop/bin/devin-desktop' : 'devin-desktop';
const CODE_BIN = process.env.CODE_BIN || 'code';

function windowsAppBin(app) {
  const port = new URL(app === 'devin' ? DEVIN_CDP_URL : app === 'codex' ? CODEX_CDP_URL : CDP_URL).port;
  const script = `$owner = (Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen | Select-Object -First 1).OwningProcess; (Get-CimInstance Win32_Process -Filter "ProcessId = $owner").ExecutablePath`;
  const bin = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
  if (!bin) throw new Error('找不到当前应用的启动路径，请先打开它的调试端口');
  return bin;
}

function createProjectFolder(parent, name) {
  const { real } = safeHomePath(parent);
  if (!name || name === '.' || name === '..' || path.basename(name) !== name) throw new Error('请输入一个文件夹名称，不要包含路径');
  const folder = path.join(real, name);
  fs.mkdirSync(folder);
  return folder;
}

async function openFolder(folder, app) {
  const { real } = safeHomePath(folder);
  const bin = process.platform === 'win32' ? windowsAppBin(app) : app === 'devin' ? DEVIN_BIN : app === 'codex' ? CODE_BIN : CURSOR_BIN;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VSCODE_IPC_HOOK_CLI;
  const launcher = path.join(path.dirname(bin), ...(app === 'cursor' ? ['resources', 'app', 'bin', 'cursor.cmd'] : ['bin', app === 'devin' ? 'devin-desktop.cmd' : 'code.cmd']));
  const command = process.platform === 'win32' ? 'powershell.exe' : bin;
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; & '${launcher.replace(/'/g, "''")}' -r '${real.replace(/'/g, "''")}'; exit $LASTEXITCODE`]
    : ['-r', real];
  const child = spawn(command, args, { env, detached: true, stdio: process.platform === 'win32' ? ['ignore', 'ignore', 'pipe'] : 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    if (process.platform === 'win32') {
      let error = '';
      child.stderr.on('data', chunk => { error += chunk; });
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(error.trim() || `打开项目失败（退出码 ${code}）`)));
    } else child.once('spawn', resolve);
  });
  child.unref();
  return real;
}

class Session {
  constructor(client, deviceId) {
    this.client = client;
    this.deviceId = deviceId;
    fusionViewers.add(this);
    this.fusionSaved = fusionHistory[deviceId] ||= { current: '', runs: [] };
    this.fusionRun = this.fusionSaved.runs.find(f => f.id === this.fusionSaved.current);
    // The phone reports when the app goes to the background; notifications skip the window it is looking at.
    this.visible = true;
    this.cdp = null;
    this.editorCdp = null;
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
    this.devinHist = new Map();
    this.thoughtFails = new Map();
    this.curSession = undefined;
    this.keptThink = new Map();
    this.app = null;
    this.sel = 0;
    this.windowId = '';
    this.threadId = '';
    this.pendingThread = '';
    this.codexPageId = '';
    this.itemCache = new Map();
    this.lastPanel = '';
    this.lastBusy = null;
    this.lastTermHash = undefined;
    this.idleTimer = setInterval(() => this.pollIfIdle(), 2000);
    this.focusCount = 0;
    this.focusTimer = null;
  }

  appMessage(template) {
    if (this.app === 'fusion') return template.replaceAll('{app}', 'Fusion');
    const name = EDITORS.find(ed => ed.app === this.app)?.name || '当前应用';
    return template.replaceAll('{app}', name);
  }

  async setMode(mode) {
    this.mode = mode === 'screen' || mode === 'terminal' ? mode : 'chat';
    this.lastChatAt = this.lastTermAt = 0;
    clearInterval(this.chatTimer);
    clearInterval(this.termTimer);
    if (!this.editorCdp) return;
    if (this.mode === 'chat') {
      await this.editorCdp.send('Page.stopScreencast').catch(() => {});
      this.lastChat = '';
      this.chatTimer = setInterval(() => this.pollChat().catch(() => {}), 700);
      await this.pollChat();
    } else if (this.mode === 'terminal') {
      await this.editorCdp.send('Page.stopScreencast').catch(() => {});
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
    if (last && carried?.body && last.i === carried.id && this.thinkingBody(last).length < carried.body.length) {
      itAssign(last, carried.body);
      this.thinking.set(last.i, { body: carried.body });
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

  selectionKey() {
    return [this.app || '', this.windowId || '', this.threadId || ''].join('|');
  }

  clearViewState() {
    this.sel = (this.sel || 0) + 1;
    this.lastChat = '';
    this.lastAttachments = null;
    this.latestThink = null;
    this.thinkTries = new Map();
    this.thinking = new Map();
    this.thinkingTried = new Map();
    this.keptThink = new Map();
    this.itemCache = new Map();
    this.pendingThread = '';
    this.polling = null;
    this.lastDraft = undefined;
  }

  liveRead(cdp, sel) {
    return cdp && cdp === this.cdp && sel === this.sel && !this.switchingThread;
  }

  // A virtualized Codex list unmounts older turns. Keep text we already read for this thread.
  mergeCodexItems(chat) {
    if (this.app !== 'codex' || !chat?.items) return;
    const thread = chat.thread || '';
    if (thread && this.threadId && thread !== this.threadId) {
      this.latestThink = null;
      this.thinkTries = new Map();
      this.thinking = new Map();
      this.thinkingTried = new Map();
      this.keptThink = new Map();
    }
    if (thread) this.threadId = thread;
    if (!this.itemCache) this.itemCache = new Map();
    const prev = this.itemCache.get(thread) || [];
    chat.items = [...new Map([...prev, ...chat.items].map(it => [it.i, it])).values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).slice(-400);
    chat.earlier = Math.min(...chat.items.map(it => Math.floor((it.order ?? Infinity) / 10000))) > 1;
    if (!chat.busy) chat.items.filter(it => it.k === 'thinking').forEach(it => { it.live = false; });
    if (!chat.busy) chat.items.filter(it => it.k === 'tool' && !it.keep).forEach(it => { it.done = true; });
    this.itemCache.set(thread, chat.items);
  }

  // Devin sessions: everything remembered from a transcript (rows, thought bodies, task lists) belongs to ONE
  // session. When the desktop shows another session (a tab was clicked there, the phone switched, a new
  // session started) park this session's state under its title and load the other's, never merge them.
  // A rename (the title changed while the set of tabs stayed the same) keeps the state.
  syncSession(chat) {
    const sess = chat?.session;
    if (this.app !== 'devin' || !sess) return;
    const key = chat.thread || sess.key;
    if (this.curSession === undefined || this.curSession === key) { this.curSession = key; return; }
    if (!this.sessStore) this.sessStore = new Map();
    const FIELDS = ['devinHist', 'thinking', 'thinkingTried', 'keptThink', 'tasksTried', 'thoughtFails', 'latestThink'];
    const fresh = () => ({ devinHist: new Map(), thinking: new Map(), thinkingTried: new Map(), keptThink: new Map(), tasksTried: new Map(), thoughtFails: new Map(), latestThink: null });
    const saved = {};
    for (const f of FIELDS) saved[f] = this[f];
    this.sessStore.set(this.curSession, saved);
    const next = this.sessStore.get(key) || fresh();
    for (const f of FIELDS) this[f] = next[f];
    while (this.sessStore.size > 24) this.sessStore.delete(this.sessStore.keys().next().value);
    this.curSession = key;
    this.lastChat = '';
    this.thoughtPoll = 0;
  }

  // Devin virtualizes its transcript: only rows near the viewport stay mounted, so a poll
  // sees a sliding window of acp-indexed rows. Merge each window into per-session history
  // keyed by the stable acp ids; remembered rows keep their last seen content. Sorted by
  // acp index (a thinking item `acpN:think` travels with row N) and capped at ~1500 items.
  mergeDevinHistory(chat) {
    if (!chat?.items) return;
    this.syncSession(chat);
    if (chat.empty) { this.devinHist.clear(); chat.earlier = false; return; }
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
      if (next.k === 'tasks' && !next.items && prev?.items && prev.done === next.done && prev.total === next.total) hist.set(it.i, { ...next, items: prev.items });
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

  async pollChat(immediate = false) {
    const cdp = this.cdp;
    const sel = this.sel;
    if (!cdp || !this.visible || this.switchingThread || this.historyLoading || (this.fusionHold?.app === this.app && this.fusionHold?.windowId === this.windowId) || this.polling === sel || (!immediate && Date.now() - (this.lastChatAt || 0) < (this.lastBusy ? 650 : 1800))) return;
    this.lastChatAt = Date.now();
    this.polling = sel;
    try {
      let chat = await cdp.evaluate(helpersCall('extract()'));
      const before = this.app === 'codex' && !chat?.busy ? await cdp.evaluate(helpersCall("scrollCodexHistory('latest')")) : null;
      try {
        if (before) await new Promise(r => setTimeout(r, 150));
        if (before) chat = await cdp.evaluate(helpersCall('extract()'));
      } finally {
        if (before && this.liveRead(cdp, sel) && await cdp.evaluate(helpersCall('codexThread()')) === before.thread) {
          await cdp.evaluate(helpersCall(`scrollCodexHistory(${before.scrollTop})`));
        }
      }
      if (!this.liveRead(cdp, sel) || this.historyLoading) return;
      this.syncSession(chat);
      const liveClosed = this.app !== 'devin' && !(this.app === 'codex' && chat?.busy) && (chat?.items || []).some(it => it.k === 'thinking' && it.live && !(it.t || '').includes('\n'));
      if (liveClosed) {
        const idxs = await cdp.evaluate(helpersCall(`closedThinkingIndexes('live')`));
        if (!this.liveRead(cdp, sel)) return;
        if (idxs?.length) {
          await cdp.evaluate(helpersCall(`clickThinking(${JSON.stringify(idxs)})`));
          await new Promise(r => setTimeout(r, 250));
          if (!this.liveRead(cdp, sel)) return;
          chat = await cdp.evaluate(helpersCall('extract()'));
        }
      }
      if (!this.liveRead(cdp, sel)) return;
      const needFinal = this.app !== 'devin' && !(this.app === 'codex' && chat?.busy) && (chat?.items || []).some(it => it.k === 'thinking' && !it.live && !(it.t || '').includes('\n') && !this.thinkingTried.has(it.i));
      if (needFinal) {
        const idxs = await cdp.evaluate(helpersCall(`closedThinkingIndexes('done')`));
        if (!this.liveRead(cdp, sel)) return;
        if (idxs?.length) {
          await cdp.evaluate(helpersCall(`clickThinking(${JSON.stringify(idxs)})`));
          await new Promise(r => setTimeout(r, 250));
          if (!this.liveRead(cdp, sel)) return;
          chat = await cdp.evaluate(helpersCall('extract()'));
          if (!this.liveRead(cdp, sel)) return;
          await cdp.evaluate(helpersCall(`closeThinkingIfOpen(${JSON.stringify(idxs)})`));
        }
      }
      if (!this.liveRead(cdp, sel) || this.historyLoading || !chat) return;
      const prevThread = this.threadId || '';
      if (this.app === 'codex' && !chat.thread) { this.pendingThread = ''; return; }
      if (chat.thread !== prevThread) {
        if (this.app === 'codex' && this.pendingThread !== chat.thread) {
          this.pendingThread = chat.thread;
          this.lastChatAt = 0;
          return;
        }
        if (this.app === 'devin') { this.sel++; this.lastChat = ''; this.lastAttachments = null; }
        else this.clearViewState();
        this.threadId = chat.thread || '';
        this.publishThread('桌面上的会话已切换');
        this.lastChatAt = 0;
        return;
      }
      this.pendingThread = '';
      this.lastBusy = !!chat.busy;
      if (process.platform === 'win32' && this.app === 'codex') chat.context = windowsCodexContext(chat.thread);
      if (this.app === 'codex') {
        for (const it of chat.items.filter(it => it.images?.length)) {
          const old = this.itemCache?.get(chat.thread)?.find(x => x.i === it.i);
          const sources = [...it.images];
          it.images = await Promise.all(it.images.map(async (src, n) => {
            if (old?.imageSources?.[n] === src && old.images?.[n]) return old.images[n];
            try { return await cdp.evaluate(helpersCall(`codexImage(${JSON.stringify(src)})`), { timeout: 60000 }); } catch { return src; }
          }));
          it.imageSources = sources;
        }
        if (!this.liveRead(cdp, sel)) return;
      }
      this.mergeCodexItems(chat);
      const draft = chat.draft;
      delete chat.draft;
      if (immediate) {
        this.fillThinking(chat);
        this.retainThinking(chat);
        this.mergeDevinHistory(chat);
        const json = JSON.stringify(chat);
        if (json !== this.lastChat && this.liveRead(cdp, sel)) {
          this.lastChat = json;
          this.emit({ t: 'chat', sel: this.selectionKey(), chat });
        }
      }
      if (draft !== undefined && draft !== this.lastDraft && this.liveRead(cdp, sel)) {
        this.lastDraft = draft;
        this.emit({ t: 'draft', sel: this.selectionKey(), text: draft });
      }
      // Devin task lists: read details for the current count and restore the original expansion state.
      const taskRow = (chat?.items || []).find(it => it.k === 'tasks' && !it.items && this.tasksTried.get(it.i) !== `${it.done}/${it.total}`);
      if (taskRow) {
        const wasOpen = await cdp.evaluate(helpersCall(`setTasksOpen(${JSON.stringify(taskRow.i)}, true)`));
        if (wasOpen != null) {
          try {
            await new Promise(r => setTimeout(r, 250));
            const opened = await cdp.evaluate(helpersCall('extract()'));
            const tasks = opened?.items?.find(it => it.k === 'tasks' && it.i === taskRow.i && it.items);
            if (tasks) {
              this.tasksTried.set(taskRow.i, `${tasks.done}/${tasks.total}`);
              chat = opened;
            }
          } finally {
            if (!wasOpen) await cdp.evaluate(helpersCall(`setTasksOpen(${JSON.stringify(taskRow.i)}, false)`));
          }
        }
      }
      for (const item of (chat?.items || []).filter(it => it.src === 'devin' && it.kind === 'command' && !it.cmd)) {
        const cached = this.devinHist.get(item.i)?.cmd;
        if (cached) { item.cmd = cached; continue; }
        const wasOpen = await cdp.evaluate(helpersCall(`setCommandOpen(${JSON.stringify(item.i)}, true)`));
        if (wasOpen == null) continue;
        try {
          await new Promise(r => setTimeout(r, 150));
          const full = await cdp.evaluate(helpersCall('extract()'));
          const command = full?.items?.find(it => it.i === item.i && it.cmd);
          if (command) Object.assign(item, command);
        } finally {
          if (!wasOpen) await cdp.evaluate(helpersCall(`setCommandOpen(${JSON.stringify(item.i)}, false)`));
        }
      }
      await this.captureThoughts(chat);
      this.fillThinking(chat);
      this.rememberThinking(chat);
      this.retainThinking(chat);
      this.mergeDevinHistory(chat);
      const finished = this.app === 'devin' || (this.app === 'codex' && chat.busy) ? [] : (chat?.items || []).filter(it => it.k === 'thinking' && !it.live);
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
      await this.syncAttachments();
      const json = JSON.stringify(chat);
      if (!this.liveRead(cdp, sel) || this.historyLoading) return;
      if (json !== this.lastChat) {
        this.lastChat = json;
        this.emit({ t: 'chat', sel: this.selectionKey(), chat });
      }
    } finally {
      if (this.polling === sel) this.polling = null;
    }
  }

  async pollTerminal() {
    const cdp = this.cdp, editorCdp = this.editorCdp, sel = this.sel;
    if (!editorCdp || !this.visible || this.mode !== 'terminal' || this.termPolling === sel || Date.now() - (this.lastTermAt || 0) < (this.lastBusy ? 650 : 1800)) return;
    this.lastTermAt = Date.now();
    this.termPolling = sel;
    try {
      const dump = await editorCdp.evaluate(helpersCall(`terminalDump(${JSON.stringify(this.lastTermHash || '')})`));
      if (!this.liveRead(cdp, sel) || editorCdp !== this.editorCdp || this.mode !== 'terminal') return;
      if (!dump) {
        if (this.lastTermHash !== null) {
          this.lastTermHash = null;
          this.emit({ t: 'termText', sel: this.selectionKey(), lines: null });
        }
      } else if (dump.hash !== this.lastTermHash) {
        this.lastTermHash = dump.hash;
        if (dump.lines) this.emit({ t: 'termText', sel: this.selectionKey(), lines: dump.lines, cursor: dump.cursor, name: dump.name });
      }
      const state = await cdp.evaluate(helpersCall('agentState()'));
      if (!this.liveRead(cdp, sel) || editorCdp !== this.editorCdp || this.mode !== 'terminal') return;
      const busy = !!state?.busy;
      if (busy !== this.lastBusy) {
        this.lastBusy = busy;
        this.emit({ t: 'agentBusy', busy });
      }
    } finally {
      if (this.termPolling === sel) this.termPolling = null;
    }
  }

  async listTerminals() {
    const list = await this.editorCdp.evaluate(helpersCall('terminalList()'));
    this.emit({ t: 'terminals', list: list || [] });
  }

  async openTerminal(id) {
    if (!/^[\w-]{8,}$/.test(id)) throw new Error('这个终端已经不在了');
    const pos = await this.editorCdp.evaluate(helpersCall(`terminalTarget(${JSON.stringify(id)})`));
    if (!pos) throw new Error('这个终端已经不在了');
    await this.tapCss(pos.x, pos.y, 'left', this.editorCdp);
    this.emit({ t: 'status', ok: true, msg: '已切换终端' });
    setTimeout(() => this.pollTerminal().catch(() => {}), 300);
  }

  async closeTerminal(id) {
    if (!/^[\w-]{8,}$/.test(id)) throw new Error('这个终端已经不在了');
    const pos = await this.editorCdp.evaluate(helpersCall(`terminalCloseTarget(${JSON.stringify(id)})`));
    if (!pos) throw new Error('这个终端已经不在了');
    await this.tapCss(pos.x, pos.y, 'left', this.editorCdp);
    this.emit({ t: 'status', ok: true, msg: '已关闭终端' });
    setTimeout(() => this.pollTerminal().catch(() => {}), 300);
  }

  async newTerminal() {
    const direct = await this.editorCdp.evaluate(helpersCall('newTerminalDirect()'));
    if (direct) {
      await this.tapCss(direct.x, direct.y, 'left', this.editorCdp);
    } else if (this.app === 'codex' || this.app === 'cursor') {
      await this.key('Ctrl+Shift+`', { cdp: this.editorCdp });
    } else {
      const menu = await this.editorCdp.evaluate(helpersCall('newTerminalMenu()'));
      if (!menu) throw new Error('当前窗口里找不到新建终端的按钮');
      await this.tapCss(menu.x, menu.y, 'left', this.editorCdp);
      let item = null;
      for (let i = 0; i < 10 && !item; i++) {
        await new Promise(r => setTimeout(r, 120));
        item = await this.editorCdp.evaluate(helpersCall('newTerminalItem()'));
      }
      if (!item) {
        await this.key('Escape', { cdp: this.editorCdp });
        throw new Error('菜单里没有终端这一项');
      }
      await this.tapCss(item.x, item.y, 'left', this.editorCdp);
    }
    this.emit({ t: 'status', ok: true, msg: '已新建终端' });
    setTimeout(() => this.pollTerminal().catch(() => {}), 500);
  }

  async focusTerminal() {
    const pos = await this.editorCdp.evaluate(helpersCall('terminalFocus()'));
    if (!pos) throw new Error('没有打开的终端。先新建一个。');
    await this.tapCss(pos.x, pos.y, 'left', this.editorCdp);
    await new Promise(r => setTimeout(r, 80));
  }

  async sendTerminal(text) {
    await this.focusTerminal();
    // History recall already put a command on the prompt. Replace that line so an edit is not appended.
    if (typeof await this.editorCdp.evaluate(helpersCall('terminalCommand()')) === 'string') {
      await this.key('Ctrl+a', { cdp: this.editorCdp });
      await this.key('Ctrl+k', { cdp: this.editorCdp });
    }
    const lines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await this.editorCdp.send('Input.insertText', { text: lines[i] });
      if (i < lines.length - 1 || lines[i]) await this.key('Enter', { cdp: this.editorCdp });
    }
  }

  async ensureSettings() {
    const waitOpen = async () => {
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 120));
        if (await this.editorCdp.evaluate(helpersCall('settingsOpen()'))) return true;
      }
      return false;
    };
    if (await this.editorCdp.evaluate(helpersCall('settingsOpen()'))) return;
    // Click the gear directly. A coordinate click on the 24px footer button often misses.
    await this.editorCdp.evaluate(helpersCall('clickSettingsButton()'));
    if (await waitOpen()) return;
    // Cursor and Devin both bind Settings to Ctrl+Comma.
    const comma = { key: ',', code: 'Comma', windowsVirtualKeyCode: 188, modifiers: 2 };
    await this.editorCdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...comma });
    await this.editorCdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...comma });
    if (await waitOpen()) return;
    throw new Error('设置没有打开');
  }

  async closeSettings() {
    const how = await this.editorCdp.evaluate(helpersCall('clickCloseSettings()'));
    if (how === 'tab') await this.key('Ctrl+w', { cdp: this.editorCdp });
  }

  async withCodexSettings(fn) {
    const editor = this.editorCdp, sidebar = this.cdp;
    const before = await editor.evaluate(`(() => { const t = [...document.querySelectorAll('.tab')].find(e => /^Codex Settings(?:,|$)/.test(e.getAttribute('aria-label') || '')); return !!t; })()`);
    let key = '';
    const settingsKey = () => editor.evaluate(`(() => { if (![...document.querySelectorAll('.tab.active')].some(e => /^Codex Settings(?:,|$)/.test(e.getAttribute('aria-label') || ''))) return ''; const el = [...document.querySelectorAll('iframe[src*="extensionId=openai.chatgpt"]')].find(e => !e.src.includes('purpose=webviewView') && e.getBoundingClientRect().height > 0); return el ? new URL(el.src).searchParams.get('id') : ''; })()`);
    key = await settingsKey();
    if (!key) {
      const account = await sidebar.evaluate(helpersCall('codexAccountPoint()'));
      if (!account) throw new Error('没有找到 Codex 设置菜单');
      await this.tapCss(account.x, account.y, 'left', sidebar);
      let pos;
      for (let i = 0; i < 10 && !pos; i++) {
        await new Promise(r => setTimeout(r, 100));
        pos = await sidebar.evaluate(helpersCall("codexMenuPoint('Codex settings')"));
      }
      if (!pos) throw new Error('Codex 菜单没有设置入口');
      await this.tapCss(pos.x, pos.y, 'left', sidebar);
      for (let i = 0; i < 30 && !key; i++) { await new Promise(r => setTimeout(r, 100)); key = await settingsKey(); }
      if (!key) throw new Error('Codex 设置页面尚未打开');
    }
    const targets = await (await fetch(`${CODEX_CDP_URL}/json/list`)).json();
    const target = targets.find(t => /extensionId=openai.chatgpt/.test(t.url || '') && new URL(t.url).searchParams.get('id') === key);
    if (!target) throw new Error('Codex 设置页面尚未连接');
    if (!before) this.codexSettingsOwned = { editorWs: editor.wsUrl, key };
    this.codexSettingsViewWs = target.webSocketDebuggerUrl;
    const cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.connect();
    try { return await fn(cdp); } finally { cdp.close(); }
  }

  async showCodexSettings(id = '', requestId = 0) {
    const sel = this.sel;
    const data = await this.withCodexSettings(async cdp => {
      if (id) {
        const pos = await cdp.evaluate(helpersCall(`codexSettingPoint(${JSON.stringify(id)})`));
        if (!pos) throw new Error('设置选项已改变，请重新打开设置');
        await this.tapCss(pos.x, pos.y, 'left', cdp);
        await new Promise(r => setTimeout(r, 200));
      }
      let data;
      for (let i = 0; i < 20; i++) {
        data = await cdp.evaluate(helpersCall('codexSettingsData()'));
        if (data.nav.length) break;
        await new Promise(r => setTimeout(r, 100));
      }
      if (!data.nav.length) throw new Error('Codex 设置内容尚未加载');
      return data;
    });
    if (this.sel === sel && this.app === 'codex') this.emit({ t: 'settings', codex: true, requestId, ...data });
  }

  async closeCodexSettings() {
    const view = this.codexSettingsViewWs;
    this.codexSettingsViewWs = '';
    if (view) {
      const menu = new Cdp(view);
      await menu.connect();
      try { await this.key('Escape', { cdp: menu }); } finally { menu.close(); }
    }
    const owned = this.codexSettingsOwned;
    this.codexSettingsOwned = null;
    if (!owned) return;
    const cdp = new Cdp(owned.editorWs);
    await cdp.connect();
    try {
      const pos = await cdp.evaluate(`(() => { const el = [...document.querySelectorAll('iframe[src*="extensionId=openai.chatgpt"]')].find(e => new URL(e.src).searchParams.get('id') === ${JSON.stringify(owned.key)}); if (!el) return null; const tab = [...document.querySelectorAll('.tab')].find(e => /^Codex Settings(?:,|$)/.test(e.getAttribute('aria-label') || '')); const b = tab?.querySelector('.codicon-close'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (pos) await this.tapCss(pos.x, pos.y, 'left', cdp);
    } finally { cdp.close(); }
  }

  async showSettings(requestId = 0) {
    if (this.app === 'codex') return this.showCodexSettings('', requestId);
    await this.ensureSettings();
    let sections = [];
    try {
      sections = await this.editorCdp.evaluate(helpersCall('readSettings()')) || [];
      if (!sections.length) {
        const nav = await this.editorCdp.evaluate(helpersCall('devinSettingsNav()')) || [];
        for (const name of nav) {
          await this.editorCdp.evaluate(helpersCall(`devinSettingsClick(${JSON.stringify(name)})`));
          await new Promise(r => setTimeout(r, 180));
          const items = await this.editorCdp.evaluate(helpersCall('devinSettingsCards()')) || [];
          if (items.length) sections.push({ title: name, items });
        }
      }
    } finally { await this.closeSettings(); }
    this.emit({ t: 'settings', sections });
  }

  async toggleSetting(label) {
    await this.ensureSettings();
    try {
      const pos = await this.editorCdp.evaluate(helpersCall(`settingTarget(${JSON.stringify(String(label))})`));
      if (!pos) throw new Error('找不到这项设置');
      await this.tapCss(pos.x, pos.y, 'left', this.editorCdp);
      await new Promise(r => setTimeout(r, 250));
      const sections = await this.editorCdp.evaluate(helpersCall('readSettings()')) || [];
      this.emit({ t: 'settings', sections });
      this.emit({ t: 'status', ok: true, msg: '已更新设置' });
    } finally { await this.closeSettings(); }
  }

  showUsage(automatic = false) {
    if (this.app === 'fusion') return this.fusionUsage(automatic);
    if (this.usageRead?.sel === this.sel) {
      if (!automatic) this.usageRead.manual = true;
      return this.usageRead.promise;
    }
    const request = { sel: this.sel, manual: !automatic };
    this.usageRead = request;
    request.promise = this.fetchUsage(request).finally(() => {
      if (this.usageRead === request) this.usageRead = null;
    });
    return request.promise;
  }

  async fetchUsage(request) {
    const automatic = !request.manual;
    const cdp = this.cdp, sel = this.sel;
    let context;
    try { context = process.platform === 'win32' && this.app === 'codex'
      ? windowsCodexContext(await this.cdp.evaluate(helpersCall('codexThread()')))
      : await this.cdp.evaluate(helpersCall('contextPct()')); }
    catch { context = undefined; }
    if (context !== undefined && cdp === this.cdp && this.liveRead(cdp, sel)) this.emit({ t: 'usage', sel: this.selectionKey(), context });
    if (!this.liveRead(cdp, sel)) return;
    try {
      const account = this.app === 'codex' ? await this.readCodexAccount(request)
        : this.app === 'devin' ? await this.cdp.evaluate(helpersCall('readDevinUsage()'))
        : await this.readCursorUsage(automatic);
      if (!this.liveRead(cdp, sel)) return;
      if (typeof account?.plan === 'string' && account.plan) appPlans[this.app] = account.plan;
      if (!account && !request.manual) { this.emit({ t: 'usage', sel: this.selectionKey(), ...(context === undefined ? {} : { context }) }); return; }
      if (!account) throw new Error('没有读到额度');
      this.emit({ t: 'usage', sel: this.selectionKey(), updated: Date.now(), ...(context === undefined ? {} : { context }), ...account });
    } catch (e) {
      if (!this.liveRead(cdp, sel)) return;
      const error = /timeout|timed out|超时/i.test(e.message) ? '额度查询超时' : !this.cdp ? '电脑连接已断开' : '额度接口请求失败';
      this.emit({ t: 'usage', sel: this.selectionKey(), error, detail: e.message, automatic: !request.manual, ...(context === undefined ? {} : { context }) });
    }
  }

  async readCursorUsage(automatic = false) {
    if (automatic) {
      const usage = await this.cdp.evaluate(helpersCall('readUsage()'));
      if (usage?.limits?.length && !usage.loading && !usage.missing) {
        cursorUsage.data = { ...usage, updated: Date.now() };
        return cursorUsage.data;
      }
      if (cursorUsage.data) return { ...cursorUsage.data, cached: true };
      if (!cursorUsage.initial) cursorUsage.initial = this.withFocus(() => this.readCursorUsage(false));
      return cursorUsage.initial;
    }
    const wasOpen = await this.cdp.evaluate(helpersCall('settingsOpen()'));
    await this.ensureSettings();
    try {
      const nav = await this.cdp.evaluate(helpersCall('usageNavTarget()'));
      if (!nav) return { missing: true, quota: [], limits: [] };
      await this.tapCss(nav.x, nav.y);
      let usage = null;
      for (let i = 0; i < 32; i++) {
        await new Promise(r => setTimeout(r, 250));
        usage = await this.cdp.evaluate(helpersCall('readUsage()'));
        if (usage?.limits?.length && !usage.loading && !usage.missing) break;
      }
      if (usage?.loading) throw new Error('额度还在加载');
      if (usage?.limits?.length && !usage.missing) {
        cursorUsage.data = { ...usage, updated: Date.now() };
        return cursorUsage.data;
      }
      return usage || { missing: true, quota: [], limits: [] };
    } finally { if (!wasOpen) await this.closeSettings(); }
  }

  async readCodexAccount(request) {
    const cdp = this.cdp, sel = this.sel;
    const native = await cdp.evaluate(helpersCall('refreshCodexUsage(false)'));
    if (native && (!codexUsage.data || native.updated > codexUsage.data.updated)) {
      codexUsage.data = native;
      codexUsage.retryAt = 0;
      codexUsage.failures = 0;
    }
    if (!request.fusion && codexUsage.data && this.liveRead(cdp, sel)) this.emit({ t: 'usage', sel: this.selectionKey(), ...codexUsage.data, cached: true });
    if (!request.manual && Date.now() < codexUsage.retryAt) throw codexUsage.error;
    if (!request.manual && codexUsage.data && Date.now() - codexUsage.data.updated < 60000) return { ...codexUsage.data, cached: true };
    if (!codexUsage.refresh) {
      codexUsage.refresh = cdp.evaluate(helpersCall('refreshCodexUsage()'), { timeout: 120000 }).then(data => {
        codexUsage.data = data;
        codexUsage.failures = 0;
        codexUsage.retryAt = 0;
        return data;
      }).catch(error => {
        codexUsage.error = error;
        codexUsage.retryAt = Date.now() + Math.min(60000 * 2 ** ++codexUsage.failures, 300000);
        throw error;
      }).finally(() => { codexUsage.refresh = null; });
    }
    return codexUsage.refresh;
  }

  showProjects(dir) {
    this.emit({ t: 'projects', ...projectList(dir || '') });
  }

  workspaceByRoot(root, host) {
    const want = host || null;
    for (const w of workspaces()) {
      if ((w.host || null) !== want) continue;
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

  // Only local workspaces: remote (SSH / Cursor cloud agent) files are not read from the phone.
  async currentRoots() {
    if (this.app === 'cursor' && this.winTitle === 'Cursor Agents') {
      const workspace = await this.cdp.evaluate(helpersCall('cursorWorkspace()'));
      return workspace && !workspace.host ? [workspace] : [];
    }
    const prefer = this.app === 'codex' ? (this.codexRoots?.get(this.threadId) || '') : '';
    if (this.app === 'codex') {
      const pages = await codexWindows(CODEX_CDP_URL);
      const page = pages.find(p => p.pageId === this.codexPageId);
      return windowRoots(page?.rawTitle || page?.title || '', 'code', prefer).filter(w => !w.host);
    }
    const title = process.platform === 'win32' ? await this.editorCdp.evaluate('document.title') : this.winTitle || '';
    return windowRoots(title, this.app === 'devin' ? 'devin' : 'cursor', prefer).filter(w => !w.host);
  }

  projectRows(list) {
    const all = workspaces();
    return list.map(w => {
      const label = workspaceLabel(w, all);
      return { name: label.name, path: w.root, host: w.host || '', detail: label.detail || '' };
    });
  }

  async showDocs(root, dir, host, editor = false) {
    const emit = data => this.emit({ t: 'docs', editor, ...data });
    try {
      if (!root) {
        const roots = await this.currentRoots();
        if (roots.length === 1) {
          const ws = roots[0];
          emit({ ...(await listProject(ws.host, ws.root, ws.root, editor)), host: ws.host || '' });
          return;
        }
        if (roots.length > 1) {
          emit({ projects: this.projectRows(roots) });
          return;
        }
        const app = this.app === 'codex' ? 'code' : this.app === 'devin' ? 'devin' : 'cursor';
        const mine = workspaces().filter(w => !w.host && (w.sources || [w.source]).includes(app));
        emit({ projects: this.projectRows(mine).slice(0, 20) });
        return;
      }
      if (host) throw new Error('只支持查看本地文件');
      const ws = this.workspaceByRoot(root, '');
      if (!ws) throw new Error('只能查看已打开过的项目');
      emit({ ...(await listProject(ws.host, ws.root, dir || ws.root, editor)), host: ws.host || '' });
    } catch (e) {
      emit({ error: e.message });
    }
  }

  async useProject(folder, newSession = false) {
    const real = await openFolder(folder, this.app);
    const app = this.app;
    const editor = EDITORS.find(e => e.app === app);
    let target;
    for (let i = 0; i < 40 && !target; i++) {
      const pages = await (await fetch(`${editor.url}/json/list`)).json();
      target = pages.filter(p => p.type === 'page' && /workbench/.test(p.url)).find(p =>
        windowRoots(p.title, app).some(w => !w.host && fusionProject(w.root)?.id === fusionProject(real)?.id));
      if (!target) await new Promise(r => setTimeout(r, 250));
    }
    if (!target) throw new Error('应用尚未打开所选项目，请检查电脑上的窗口');
    await this.attach({ id: `${app}:${target.id}` });
    this.pendingProject = { root: real, app, windowId: this.windowId, newSession };
    const trust = await this.editorCdp.evaluate(helpersCall('workspaceTrustState()'));
    if (trust.required) return this.emit({ t: 'projectTrust', path: real });
    await this.finishProject();
  }

  async newProject(parent, name, newSession = false) {
    const folder = createProjectFolder(parent, name);
    await this.useProject(folder, newSession);
  }

  async newProjectChat() {
    const roots = await this.currentRoots();
    if (!roots.length) return this.showProjects('');
    const root = roots[0];
    if (root.host) return this.newChat();
    this.pendingProject = { root: root.root, app: this.app, windowId: this.windowId, newSession: true };
    if ((await this.editorCdp.evaluate(helpersCall('workspaceTrustState()'))).required) return this.emit({ t: 'projectTrust', path: root.root });
    await this.finishProject();
  }

  async confirmProjectTrust(approve) {
    const pending = this.pendingProject;
    if (!pending || this.app !== pending.app || this.windowId !== pending.windowId) throw new Error('项目窗口已改变，请重新选择项目');
    const roots = await this.currentRoots();
    if (!roots.some(w => !w.host && fusionProject(w.root)?.id === fusionProject(pending.root)?.id)) throw new Error('当前窗口不是待确认的项目');
    let state = await this.editorCdp.evaluate(helpersCall('workspaceTrustState()'));
    if (!approve) {
      if (state.decline) await this.tapCss(state.decline.x, state.decline.y, 'left', this.editorCdp);
      this.pendingProject = null;
      this.emit({ t: 'status', ok: true, msg: '已保持限制模式，未创建 Agent 会话' });
      return;
    }
    if (state.required && !state.trust) {
      await this.key(process.platform === 'darwin' ? 'Meta+Shift+p' : 'Ctrl+Shift+p', { cdp: this.editorCdp });
      await this.editorCdp.send('Input.insertText', { text: 'Workspaces: Manage Workspace Trust' });
      await new Promise(r => setTimeout(r, 200));
      await this.key('Enter', { cdp: this.editorCdp });
      for (let i = 0; i < 20 && !state.trust; i++) {
        await new Promise(r => setTimeout(r, 150));
        state = await this.editorCdp.evaluate(helpersCall('workspaceTrustState()'));
      }
    }
    if (state.required) {
      if (!state.trust) throw new Error('未找到原生信任按钮，请在电脑上检查工作区信任页面');
      await this.tapCss(state.trust.x, state.trust.y, 'left', this.editorCdp);
    }
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 150));
      state = await this.editorCdp.evaluate(helpersCall('workspaceTrustState()'));
      if (!state.required) return this.finishProject();
    }
    throw new Error('项目仍处于限制模式，尚未创建 Agent 会话');
  }

  async finishProject() {
    const pending = this.pendingProject;
    if (!pending) return;
    if ((await this.editorCdp.evaluate(helpersCall('workspaceTrustState()'))).required) throw new Error('请先确认项目是否可信');
    let chat;
    if (pending.newSession) {
      await this.newChat();
      if (this.app === 'cursor' && this.winTitle === 'Cursor Agents')
        await this.cdp.evaluate(helpersCall(`cursorSelectProject(${JSON.stringify(pending.root)})`));
      for (let i = 0; i < 20; i++) {
        chat = await this.cdp.evaluate(helpersCall('extract()'));
        if (chat && !chat.items?.length && await this.cdp.evaluate(helpersCall('hasComposer()'))) break;
        chat = null;
        await new Promise(r => setTimeout(r, 150));
      }
      if (!chat) throw new Error('新会话输入区尚未就绪，请检查电脑上的会话');
      chat.empty = true;
      this.syncSession(chat);
      this.threadId = chat.thread || chat.session?.key || '';
      this.publishThread();
    }
    const roots = await this.currentRoots();
    if (!roots.some(w => !w.host && fusionProject(w.root)?.id === fusionProject(pending.root)?.id)) throw new Error('会话工作目录与所选项目不一致');
    this.pendingProject = null;
    this.emit({ t: 'projectReady', path: pending.root, name: path.basename(pending.root), newSession: pending.newSession, sel: this.selectionKey(), chat });
    this.emit({ t: 'status', ok: true, msg: pending.newSession ? '已在所选项目新建会话' : `已打开 ${path.basename(pending.root)}` });
    if (pending.newSession) await this.listAgents(true);
  }

  async sendPanelRect() {
    const rect = await this.editorCdp.evaluate(helpersCall('panelRect()')).catch(() => null);
    const json = JSON.stringify(rect);
    if (json !== this.lastPanel) {
      this.lastPanel = json;
      this.emit({ t: 'panel', rect });
    }
  }

  async clickButton(item, n, actionId, label, sel) {
    try {
    if (sel != null && sel !== this.selectionKey()) throw new Error('会话已切换，请使用当前会话的按钮');
    const pos = await this.cdp.evaluate(helpersCall(`locate(${JSON.stringify(String(item))}, ${Number(n) || 0}, ${JSON.stringify(actionId || '')}, ${JSON.stringify(label || '')})`));
    if (!pos) { await this.pollChat(true); throw new Error('请求已更新，请查看最新选项'); }
    await this.tapCss(pos.x, pos.y);
    await new Promise(r => setTimeout(r, 200));
    await this.pollChat(true);
    } finally { this.emit({ t: 'clickDone', item, actionId, sel }); }
  }

  async editQueued(id, text) {
    if (!text.trim()) throw new Error('内容不能为空；不想要这条就点「删除」');
    await this.queueAction(id, 'edit');
    if (this.app === 'codex') {
      await this.codexFocusPrompt();
      await this.cdp.evaluate(helpersCall('codexSelectPrompt()'));
      await this.cdp.send('Input.insertText', { text });
      if (!await this.cdp.evaluate(helpersCall('submitCodexMessage()'))) throw new Error('Codex 保存排队消息的按钮不可用');
      setTimeout(() => this.pollChat().catch(() => {}), 300);
      return;
    }
    const focus = () => this.cdp.evaluate(helpersCall(`focusQueueEdit(${JSON.stringify(String(id))})`));
    let ok = false;
    for (let i = 0; i < 10 && !ok; i++) {
      await new Promise(r => setTimeout(r, 100));
      ok = await focus();
    }
    if (!ok) throw new Error(this.appMessage('{app} 没有进入编辑状态，没改动'));
    await this.key(process.platform === 'darwin' ? 'Meta+A' : 'Ctrl+A');
    await this.typeText(text);
    await this.key('Enter');
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  }

  async queueAction(id, action) {
    if (!['send', 'remove', 'edit'].includes(action)) throw new Error('不支持的排队操作');
    if (this.app === 'devin') return this.devinQueueAction(id, action);
    if (this.app === 'codex') {
      if (!await this.cdp.evaluate(helpersCall(`codexQueueAction(${JSON.stringify(String(id))}, ${JSON.stringify(action)})`))) throw new Error('Codex 排队消息或操作入口已不存在');
      setTimeout(() => this.pollChat().catch(() => {}), 300);
      return;
    }
    const call = a => this.cdp.evaluate(helpersCall(`queueTarget(${JSON.stringify(String(id))}${a ? `, ${JSON.stringify(a)}` : ''})`));
    const row = await call();
    if (!row) throw new Error('这条排队消息已经不在了（可能刚被发出）');
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y });
    let pos = null;
    for (let i = 0; i < 6 && !pos; i++) {
      await new Promise(r => setTimeout(r, 80));
      pos = await call(action);
    }
    if (!pos) throw new Error(this.appMessage('没找到排队消息的操作按钮（可能 {app} 版本不同）'));
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
    if (!pos || pos.expand) throw new Error(this.appMessage('这个子 Agent 已经结束了，或者 {app} 里找不到它'));
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
    if (this.app === 'codex') return this.emit({ t: 'changes', codex: true, ...await this.cdp.evaluate(helpersCall('codexChanges()')) });
    const s = await this.withFiles(async s => s);
    if (this.app === 'devin' && !s.count) {
      const chat = await this.cdp.evaluate(helpersCall('extract()'));
      this.syncSession(chat);
      this.mergeDevinHistory(chat);
      const files = new Map();
      for (const it of chat?.items || []) if (it.kind === 'edit' && it.f) {
        const prev = files.get(it.f);
        const add = (prev?.add || 0) + (it.add || 0), del = (prev?.del || 0) + (it.del || 0);
        files.set(it.f, { name: it.f, add, del });
      }
      return this.emit({ t: 'changes', devin: true, historical: true, files: [...files.values()].map(f => ({ ...f, add: `+${f.add}`, del: `-${f.del}` })), actions: [], count: files.size });
    }
    this.emit({ t: 'changes', ...s, ...(this.app === 'devin' ? { devin: true } : {}) });
  }

  async changeAction(i, name, act) {
    if (this.app === 'codex') {
      if (act !== 'bar') throw new Error('Codex 当前没有逐个文件的接受或撤销入口');
      const pos = await this.cdp.evaluate(helpersCall(`codexChangeTarget(${JSON.stringify(String(name))})`));
      if (!pos) throw new Error('文件操作入口已不存在');
      await this.tapCss(pos.x, pos.y);
      await this.listChanges();
      return;
    }
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
      if (!pos) throw new Error(this.appMessage('没找到这个按钮（可能 {app} 版本不同）'));
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
    const running = !!(await this.cdp.evaluate(helpersCall('agentState()')))?.busy;
    if (!pos && !(this.app === 'devin' && running)) throw new Error('Agent 当前没有在运行');
    if (pos) await this.tapCss(pos.x, pos.y);
    else {
      // Devin shows "Queue" instead of "Cancel" while the desktop prompt holds a draft, so there is no stop
      // button; its own cancel shortcut (shown in the button tooltip: Ctrl+Alt+C, Ctrl+C on a Mac) still works.
      if (!await this.cdp.evaluate(FOCUS_COMPOSER)) throw new Error('没找到可见的聊天输入框');
      await this.key(process.platform === 'darwin' ? 'Ctrl+c' : 'Ctrl+Alt+c');
    }
    this.emit({ t: 'status', ok: true, msg: '正在停止…' });
    // A running command has to be killed first, so Devin can take several seconds to finish cancelling.
    let busy = true;
    for (let i = 0; i < 48; i++) {
      await new Promise(r => setTimeout(r, 250));
      busy = !!(await this.cdp.evaluate(helpersCall('agentState()')))?.busy;
      if (!busy) break;
    }
    await this.pollChat().catch(() => {});
    if (busy) throw new Error(pos ? '没有停下来，Agent 仍在运行，请到电脑上看一下' : '没有停下来：电脑上的输入框里还有没发出的文字，Devin 没有停止按钮。清空输入框，或在电脑上按 Ctrl+Alt+C');
    this.emit({ t: 'status', ok: true, msg: '已停止 Agent' });
  }

  publishThread(statusMsg) {
    const msg = {
      t: 'attached', id: this.targetId, title: this.app === 'codex' ? 'Codex' : this.winTitle, app: this.app, appName: this.appMessage('{app}'),
      project: this.app === 'codex' ? codexFolder(this.winTitle) : '', windowId: this.windowId || '', threadId: this.threadId || '', sel: this.selectionKey(), keepQuota: true,
    };
    this.emit(msg);
    this.emit({ t: 'thread', windowId: msg.windowId, threadId: msg.threadId, sel: msg.sel });
    if (statusMsg) this.emit({ t: 'status', ok: true, msg: statusMsg });
  }

  async selectCodexThread(convId, cdp = this.cdp) {
    const waitActive = async () => {
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 150));
        const actual = await cdp.evaluate(helpersCall('codexThread()')) || '';
        if (actual === convId) return true;
      }
      return false;
    };
    if (await cdp.evaluate(helpersCall(`openCodexThread(${JSON.stringify(convId)})`)) && await waitActive()) return true;
    const pos = await cdp.evaluate(helpersCall('codexRecentPoint()'));
    if (!pos) return false;
    await this.tapCss(pos.x, pos.y, 'left', cdp);
    let point = null;
    for (let i = 0; i < 8 && !point; i++) {
      await new Promise(r => setTimeout(r, 120));
      point = await cdp.evaluate(helpersCall(`codexChatPoint(${JSON.stringify(convId)})`));
    }
    if (!point) {
      await cdp.evaluate(helpersCall('closeCodexMenu()'));
      return false;
    }
    await this.tapCss(point.x, point.y, 'left', cdp);
    if (await waitActive()) return true;
    await cdp.evaluate(helpersCall('closeCodexMenu()'));
    return false;
  }

  async adoptCodexThread(thread, statusMsg) {
    this.clearViewState();
    this.threadId = thread || '';
    this.publishThread(statusMsg);
    await this.pollChat();
  }

  async newCodexChat() {
    if (!this.cdp) throw new Error('还没有连上 Codex');
    const before = await this.cdp.evaluate(helpersCall('codexThread()')) || '';
    const pos = await this.cdp.evaluate(helpersCall('codexNewPoint()'));
    if (!pos) throw new Error('这个窗口里没有新建对话');
    await this.tapCss(pos.x, pos.y);
    let thread = before;
    let turns = 1;
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 150));
      const view = await this.cdp.evaluate(helpersCall('codexViewState()'));
      thread = view?.thread || '';
      turns = view?.turns ?? 1;
      if ((thread && thread !== before) || (!thread && turns === 0)) break;
    }
    if (thread === before && turns > 0) throw new Error('新建会话没有生效');
    await this.adoptCodexThread(thread === before ? '' : thread, '已新建会话');
  }

  async openCodexAgent(id) {
    if (id.startsWith('win:')) {
      await this.attach({ id: 'codex', windowId: id.slice(4), threadId: '' });
      this.emit({ t: 'status', ok: true, msg: '已切换窗口' });
      return;
    }
    if (id.startsWith('new:')) {
      const pageId = id.slice(4);
      if (pageId && pageId !== this.codexPageId) await this.attach({ id: 'codex', windowId: pageId, threadId: '' });
      await this.newCodexChat();
      return;
    }
    const match = /^thread:([^:]+):(.+)$/.exec(id || '');
    if (!match) throw new Error('这条会话已经不在列表里');
    const pageId = match[1], convId = match[2];
    this.clearViewState();
    this.switchingThread = true;
    const switchedWindow = pageId !== this.codexPageId;
    try {
      if (switchedWindow) await this.attach({ id: 'codex', windowId: pageId, threadId: convId });
      if (!this.cdp) throw new Error('还没有连上 Codex');
      const current = await this.cdp.evaluate(helpersCall('codexThread()')) || '';
      if (current !== convId && (switchedWindow || !await this.selectCodexThread(convId))) throw new Error('没有找到这个会话');
      this.emit({ t: 'status', ok: true, msg: !switchedWindow && current === convId ? '已是当前会话' : '已切换会话' });
    } finally {
      this.switchingThread = false;
      if (this.cdp) {
        this.threadId = await this.cdp.evaluate(helpersCall('codexThread()')) || '';
        this.publishThread();
        this.lastChatAt = 0;
        await this.pollChat();
      }
    }
  }

  async codexPageForThread(pages, threadId) {
    const settled = await Promise.allSettled(pages.filter(p => p.chatWs).map(async page => {
      const cdp = new Cdp(page.chatWs);
      try {
        await cdp.connect();
        const state = await cdp.evaluate(helpersCall('agentState()'));
        const rows = await cdp.evaluate(helpersCall('codexChatRows(true)'));
        const row = rows.find(r => r.id === threadId);
        return { page, active: state?.thread === threadId, inWorkspace: !!row && (!row.workspace || state?.roots?.includes(row.workspace)) };
      } finally { cdp.close(); }
    }));
    const matches = settled.filter(s => s.status === 'fulfilled').map(s => s.value);
    return matches.find(m => m.active)?.page || matches.find(m => m.inWorkspace)?.page || null;
  }

  async probeCodex(page) {
    if (!page?.chatWs && page?.pageId !== this.codexPageId) return null;
    if (page.pageId === this.codexPageId && this.cdp) {
      try { return await this.cdp.evaluate(helpersCall('agentState()')); } catch { return null; }
    }
    if (!page.chatWs) return null;
    const cdp = new Cdp(page.chatWs);
    try {
      await cdp.connect();
      return await cdp.evaluate(helpersCall('agentState()'));
    } catch {
      return null;
    } finally {
      try { cdp.close(); } catch {}
    }
  }

  rememberCodexRoots(rows) {
    if (!this.codexRoots) this.codexRoots = new Map();
    for (const row of rows || []) {
      if (row?.id && row.workspace) {
        this.codexRoots.set(row.id, row.workspace);
        const id = JSON.stringify([computerId(), 'codex', row.host || '', row.id]);
        const project = fusionProject(row.workspace, row.host || '');
        if (project) conversationProjects[id] = { project, originProject: conversationProjects[id]?.originProject || project };
      }
    }
    saveState({ conversationProjects });
  }

  async codexThreadRows(cdp = this.cdp) {
    const pos = await cdp.evaluate(helpersCall('codexRecentPoint()'));
    if (!pos) return [];
    await this.tapCss(pos.x, pos.y, 'left', cdp);
    let rows = [];
    for (let i = 0; i < 8 && !rows.length; i++) {
      await new Promise(r => setTimeout(r, 120));
      rows = await cdp.evaluate(helpersCall('codexChatRows()')) || [];
    }
    const recent = await cdp.evaluate(helpersCall('codexChatRows(true)')) || [];
    await cdp.evaluate(helpersCall('closeCodexMenu()'));
    return [...new Map([...rows, ...recent].map(row => [row.id, row])).values()];
  }

  async listAgents(silent = false, readOnly = false) {
    const emit = data => this.emit({ t: 'agents', app: this.app, silent, ...data });
    if (this.app === 'codex') {
      const pages = await codexWindows(CODEX_CDP_URL);
      const list = [];
      const seen = new Set();
      const states = await Promise.all(pages.map(p => this.probeCodex(p)));
      for (const p of pages) {
        const group = p.title;
        if (p.chatWs) {
          list.push({ id: `new:${p.pageId}`, title: '＋ 新建会话', window: group, group: '', current: false, running: false, ui: true });
          const cdp = p.pageId === this.codexPageId ? this.cdp : new Cdp(p.chatWs);
          let rows = [];
          try {
            if (cdp !== this.cdp) await cdp.connect();
            rows = readOnly ? await cdp.evaluate(helpersCall('codexChatRows(true)')) : await this.codexThreadRows(cdp);
          } finally { if (cdp !== this.cdp) cdp.close(); }
          this.rememberCodexRoots(rows);
          const folderOf = ws => {
            const parts = String(ws || '').split(/[/\\]/).filter(Boolean);
            return parts.at(-1) || '';
          };
          for (const row of rows) {
            if (seen.has(row.id)) continue;
            seen.add(row.id);
            const owner = pages.find((page, i) => states[i]?.roots?.includes(row.workspace)) || p;
            const state = states[pages.indexOf(owner)];
            const folder = folderOf(row.workspace);
            list.push({
              id: `thread:${owner.pageId}:${row.id}`,
              title: row.title,
              lastUsed: row.lastUsed,
              window: folder || owner.title,
              group: '',
              current: owner.pageId === this.codexPageId && row.id === this.threadId,
              running: row.id === state?.thread ? !!state?.busy || !!row.running : !!row.running,
            });
          }
        } else {
          const state = states[pages.indexOf(p)];
          list.push({ id: `win:${p.pageId}`, title: '打开这个窗口', window: group, group: '', current: false, running: !!state?.busy || (state?.progress > 0), ui: true });
        }
      }
      emit({ list });
      return;
    }
    if (this.app === 'devin') {
      const surface = await this.cdp.evaluate(helpersCall('devinSurface()'));
      const windows = process.platform === 'win32' ? (await listWindows()).filter(w => w.app === 'devin') : [];
      const windowRows = windows.length > 1 ? windows.map((w, i) => ({
        id: `window:${w.id}`, title: `${w.title.replace(/\s+\[(?:Administrator|Administer)\]$/i, '')} · 窗口 ${i + 1}`,
        group: 'Devin 窗口', current: w.id === this.targetId, running: false, ui: true,
      })) : [];
      if (surface === 'editor') {
        if (readOnly) {
          const session = await this.cdp.evaluate(helpersCall('devinSession()'));
          return emit({ list: [...windowRows, ...(session?.tabs || []).map(tab => ({ id: `tab:${tab.id}`, title: tab.title, group: '已打开的会话', current: tab.active, running: false }))], surface, partial: true });
        }
        return emit({ list: [...windowRows, ...await this.editorSessions()], surface });
      }
      const list = await this.cdp.evaluate(helpersCall('agentList()'));
      return emit({ list: [...windowRows, ...(list || [])], ...(surface ? { surface } : {}) });
    }
    const list = await this.cdp.evaluate(helpersCall('agentList()'));
    emit({ list: list || [] });
  }

  // Devin's Editor surface has no session list in the panel; the titlebar "Search agents" quick pick
  // lists every session by name. It is opened, read, and closed again with Escape.
  async openSessionPicker() {
    const pos = await this.cdp.evaluate(helpersCall('sessionSearchTarget()'));
    if (!pos) throw new Error('没找到会话搜索按钮（可能 Devin 版本不同）');
    await this.tapCss(pos.x, pos.y);
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (await this.cdp.evaluate(helpersCall('sessionPickerRows()?.length'))) return true;
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
    const open = tabs.map(t => ({ id: `tab:${t.id}`, title: t.title, group: '已打开的会话', current: t.active, running: !!(rows || []).find(r => norm(r.title) === t.title)?.running }));
    const rest = (rows || []).filter(r => !tabs.some(t => t.title === norm(r.title))).map(r => ({ id: r.id, title: r.title, group: tabs.length ? '全部会话' : '', current: false, running: !!r.running }));
    return [...open, ...rest];
  }

  // Close a session tab (Editor surface). The session itself stays in Devin's session list.
  async closeTab(title) {
    if (this.app !== 'devin') throw new Error('不支持的操作');
    const before = await this.cdp.evaluate(helpersCall('devinSession()'));
    const tabs = before?.tabs || [];
    if (!tabs.some(t => t.id === title)) throw new Error('这个会话标签已经关闭了');
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
    await this.cdp.evaluate(helpersCall(`clickDevinTabClose(${JSON.stringify(title)})`));
    let gone = false;
    for (let i = 0; i < 20 && !gone; i++) {
      await new Promise(r => setTimeout(r, 100));
      gone = !((await this.cdp.evaluate(helpersCall('devinSession()')))?.tabs || []).some(t => t.id === title);
    }
    this.resetDevinView();
    this.emit({ t: 'status', ok: gone, msg: gone ? '已关闭会话标签' : '没有关掉，Devin 可能在等你确认，请到电脑上看一下' });
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  }

  // Editor surface: the open sessions are tabs above the transcript; clicking one switches the transcript.
  async switchTab(title) {
    const clicked = await this.cdp.evaluate(helpersCall(`clickDevinTab(${JSON.stringify(String(title))})`));
    if (!clicked) throw new Error('这个会话标签已经关闭了');
    let on = false;
    for (let i = 0; i < 15 && !on; i++) {
      await new Promise(r => setTimeout(r, 100));
      on = (await this.cdp.evaluate(helpersCall('devinSession()')))?.key === title;
    }
    this.resetDevinView();
    this.emit({ t: 'status', ok: on, msg: on ? '已切换会话' : '这个会话还没有切过去，请稍后再试' });
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  }

  // Switching surface resets what was read from the old transcript, like opening another agent.
  resetDevinView() {
    this.lastChat = '';
    this.lastChatAt = 0;
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
      ready = (await this.cdp.evaluate(helpersCall('devinSurface()'))) === want;
    }
    this.resetDevinView();
    if (!ready) this.emit({ t: 'status', ok: false, msg: '这个界面还没有加载完，请稍后再试' });
    else this.emit({ t: 'status', ok: true, msg: want === 'editor' ? '已切到 Editor 界面' : '已切到 Agent 界面' });
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  }

  async openEditorChat() {
    if (this.app !== 'devin' || await this.cdp.evaluate(helpersCall('devinSurface()')) !== 'editor') throw new Error('请先切换到 Devin Editor');
    await this.key(process.platform === 'darwin' ? 'Meta+l' : 'Ctrl+l', { cdp: this.editorCdp });
    if (!await this.waitFor('transcriptVisible()')) throw new Error('聊天面板没有打开');
    this.resetDevinView();
    await this.pollChat();
    this.emit({ t: 'status', ok: true, msg: '聊天面板已打开' });
  }

  // Devin "New": the Agent surface has the New session control. The Editor surface has none
  // visible, so it switches to Agent first and stays there (the new session lives in Agent).
  async devinNewChat() {
    const surface = await this.cdp.evaluate(helpersCall('devinSurface()'));
    const switched = surface === 'editor';
    if (switched) await this.setSurface('agent');
    await this.pressControl('newChat');
    this.resetDevinView();
    this.lastChatAt = 0;
    await this.pollChat();
    this.emit({ t: 'status', ok: true, msg: switched ? '已切到 Agent 界面并新建对话' : '已新建对话' });
  }

  async openAgent(id, title = '') {
    if (process.platform === 'win32' && this.app === 'devin' && id.startsWith('window:devin:')) {
      await this.attach(id.slice('window:'.length));
      await this.listAgents();
      return;
    }
    if (this.app === 'codex') {
      await this.openCodexAgent(id);
      return;
    }
    if (this.app === 'devin' && id.startsWith('tab:')) return this.switchTab(id.slice(4));
    if (this.app === 'devin' && await this.cdp.evaluate(helpersCall('devinSurface()')) === 'editor') {
      const opened = await this.openSessionPicker();
      const pos = opened && await this.cdp.evaluate(helpersCall(`sessionPickerTarget(${JSON.stringify(id)}, ${JSON.stringify(title)})`));
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
    if (!id || id.length > 200) throw new Error('这条 Agent 已经不在列表里');
    if (this.app === 'devin') { this.sel++; this.lastChat = ''; this.lastAttachments = null; }
    else this.clearViewState();
    this.switchingThread = true;
    try {
      const pos = await this.cdp.evaluate(helpersCall(`agentTarget(${JSON.stringify(id)}, true)`));
      if (!pos) throw new Error('这条 Agent 已经不在列表里');
      if (pos !== true) await this.tapCss(pos.x, pos.y);
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 150));
        const thread = await this.cdp.evaluate(helpersCall('activeThread()'));
        if (thread !== id) continue;
        this.threadId = thread;
        this.publishThread('已切换 Agent');
        return;
      }
      throw new Error('会话切换没有生效');
    } finally {
      this.switchingThread = false;
      this.lastChatAt = 0;
      await this.pollChat();
    }
  }

  async newChat() {
    if (this.app === 'codex') return this.newCodexChat();
    if (this.app === 'devin') return this.devinNewChat();
    const before = await this.cdp.evaluate(helpersCall('activeThread()'));
    await this.pressControl('newChat');
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 150));
      const chat = await this.cdp.evaluate(helpersCall('extract()'));
      if (!chat || (chat.thread === before && chat.items.length)) continue;
      this.clearViewState();
      this.threadId = chat.thread || '';
      this.publishThread('已新建对话');
      this.lastChatAt = 0;
      await this.pollChat();
      return;
    }
    throw new Error('新建对话没有生效');
  }

  async pressControl(name) {
    const clicked = await this.cdp.evaluate(helpersCall(`clickControl(${JSON.stringify(name)})`));
    if (clicked) return;
    const pos = await this.cdp.evaluate(helpersCall(`control(${JSON.stringify(name)})`));
    if (!pos) throw new Error(this.appMessage('当前窗口里没有这个按钮（可能是 {app} 版本或布局不同）'));
    await this.tapCss(pos.x, pos.y);
  }

  // Menus are read by opening them in Cursor, then closed again so the desktop UI is left as it was.
  async openEffortMenu() {
    await this.pressControl('model');
    const pos = await this.waitFor('effortTrigger()');
    if (!pos) { await this.closeMenus(); throw new Error('当前模型没有可选的思考强度'); }
    await this.tapCss(pos.x, pos.y);
    await this.waitFor('menuItems("effort").length');
  }

  async openMenu(kind, requestId) {
    const sel = this.sel;
    if (kind === 'effort') {
      let items = await this.cdp.evaluate(helpersCall('effortItems()'));
      let fast = await this.cdp.evaluate(helpersCall('fastInfo()'));
      if (!items.length) {
        await this.pressControl('model');
        await this.waitFor('menuOpen()');
        fast = await this.cdp.evaluate(helpersCall('fastInfo()'));
        const pos = await this.cdp.evaluate(helpersCall('effortTrigger()'));
        if (pos) {
          await this.tapCss(pos.x, pos.y);
          await this.waitFor('menuItems("effort").length');
          items = await this.cdp.evaluate(helpersCall('menuItems("effort")'));
        }
        await this.closeMenus();
      }
      const chat = await this.cdp.evaluate(helpersCall('extract()'));
      if (this.sel === sel) this.emit({ t: 'menu', kind, items, fast, model: chat?.model, requestId, sel: this.selectionKey() });
      return;
    }
    if (kind === 'model') {
      // Prop-driven lists (Codex options, Devin visibleModelConfigs) need no visible menu.
      const [items, fast, fusion] = await Promise.all([
        this.cdp.evaluate(helpersCall('modelItemsFast()')),
        this.cdp.evaluate(helpersCall('fastInfo()')),
        this.cdp.evaluate(helpersCall('fusionConfig()')),
      ]);
      if (items?.length) {
        if (fusion) this.fusion = fusion;
        const chat = await this.cdp.evaluate(helpersCall('extract()'));
        if (this.sel === sel) this.emit({ t: 'menu', kind, items, fast, fusion, model: chat?.model, requestId, sel: this.selectionKey() });
        return;
      }
    }
    await this.pressControl(kind);
    let items = [];
    let fast = null;
    for (let i = 0; i < 12 && !items.length; i++) {
      await new Promise(r => setTimeout(r, 150));
      if (kind === 'model') fast ||= await this.cdp.evaluate(helpersCall('fastInfo()'));
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
    if (kind === 'model' && !items.length) throw new Error('模型列表未加载，请确认电脑端模型菜单可以打开');
    if (this.sel === sel) this.emit({ t: 'menu', kind, items, max, fusion, fast, requestId, sel: this.selectionKey() });
  }

  async closeMenus() {
    if (await this.cdp.evaluate(helpersCall('closeModelMenu()'))) await new Promise(r => setTimeout(r, 150));
    if (this.app === 'codex') {
      await this.cdp.evaluate(helpersCall('closeCodexMenu()'));
      return;
    }
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
    await this.pollChat(true);
    this.emit({ t: 'status', ok: true, msg: '设置已更新' });
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
    if (!params) { await this.closeMenus(); throw new Error(this.appMessage('参数菜单没有打开（可能 {app} 版本不同）')); }
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

  async pickMenu(kind, label, name) {
    if (kind === 'fast') {
      const on = label === 'on';
      if (!await this.cdp.evaluate(helpersCall(`pickFast(${on})`))) {
        await this.pressControl('model');
        const pos = await this.waitFor('fastTarget()');
        if (!pos) { await this.closeMenus(); throw new Error('当前模型不支持 Fast'); }
        const current = await this.cdp.evaluate(helpersCall('fastInfo()'));
        if (current.on !== on) await this.cdp.evaluate(helpersCall('clickCursorFast()'));
        await new Promise(r => setTimeout(r, 150));
        await this.closeMenus();
      }
      await new Promise(r => setTimeout(r, 200));
      await this.pollChat();
      this.emit({ t: 'status', ok: true, msg: '设置已更新' });
      return;
    }
    if (kind === 'effort') {
      const picked = await this.cdp.evaluate(helpersCall(`pickEffort(${JSON.stringify(label)})`));
      if (!picked) {
        await this.openEffortMenu();
        const pos = await this.waitFor(`menuItem("effort", ${JSON.stringify(label)})`);
        if (!pos) { await this.closeMenus(); throw new Error('没有找到这个思考强度'); }
        await this.tapCss(pos.x, pos.y);
        await this.closeMenus();
      }
      this.pollChat().catch(() => {});
      this.emit({ t: 'status', ok: true, msg: `已切换到 ${label}` });
      return;
    }
    if (String(kind || '').startsWith('fusion-effort-')) return this.fusionModelPick(kind.slice('fusion-effort-'.length), label, true);
    if (String(kind || '').startsWith('fusion-model-')) return this.fusionModelPick(kind.slice('fusion-model-'.length), label);
    if (kind === 'codex-run') return this.codexRunPick(String(label || ''));
    if (kind === 'codex-chat') return this.codexChatPick(String(label || ''), name ? String(name).slice(0, 80) : '');
    if (kind === 'model' && this.app === 'devin' && await this.cdp.evaluate(helpersCall(`pickDevinModel(${JSON.stringify(String(label))})`))) {
      this.emit({ t: 'status', ok: true, msg: `已切换到 ${label}` });
      this.pollChat().catch(() => {});
      await this.openMenu('effort').catch(() => {});
      return;
    }
    if (kind === 'model' && this.app === 'codex' && await this.cdp.evaluate(helpersCall(`pickCodexModel(${JSON.stringify(String(label))})`))) {
      await new Promise(r => setTimeout(r, 150));
      await this.closeMenus();
      this.emit({ t: 'status', ok: true, msg: `已切换到 ${label}` });
      this.pollChat().catch(() => {});
      await this.openMenu('effort').catch(() => {});
      return;
    }
    await this.pressControl(kind);
    if (kind === 'model' && this.app !== 'codex') {
      for (let i = 0; i < 8; i++) {
        if (await this.cdp.evaluate(helpersCall('menuItems("model").length'))) break;
        const opened = await this.cdp.evaluate(helpersCall('clickModelListTrigger()'));
        if (opened) break;
        const sub = await this.cdp.evaluate(helpersCall('modelListTrigger()'));
        if (sub) { await this.tapCss(sub.x, sub.y); break; }
        await new Promise(r => setTimeout(r, 120));
      }
    }
    let pos = await this.cdp.evaluate(helpersCall(`menuItem(${JSON.stringify(kind)}, ${JSON.stringify(String(label))})`));
    for (let i = 0; i < 10 && !pos; i++) {
      await new Promise(r => setTimeout(r, 100));
      pos = await this.cdp.evaluate(helpersCall(`menuItem(${JSON.stringify(kind)}, ${JSON.stringify(String(label))})`));
    }
    if (!pos) {
      await this.closeMenus();
      throw new Error(`没找到选项：${label}`);
    }
    await this.tapCss(pos.x, pos.y);
    if (kind === 'model' && label !== 'Fusion') {
      await new Promise(r => setTimeout(r, 150));
      await this.closeMenus();
      this.emit({ t: 'status', ok: true, msg: `已切换到 ${label}` });
      this.pollChat().catch(() => {});
      await this.openMenu('effort').catch(() => {});
      return;
    }
    let pending = false;
    if (this.app === 'codex' && kind === 'permission') {
      await new Promise(r => setTimeout(r, 150));
      pending = (await this.cdp.evaluate(helpersCall('codexRequestData()'))).length > 0;
    }
    this.emit({ t: 'status', ok: true, msg: pending ? '请在下方确认权限变更' : `已切换到 ${label}` });
    if (kind === 'model' && label === 'Fusion') {
      this.fusion = null;
      this.fusionMiss = false;
      await new Promise(r => setTimeout(r, 300));
      await this.closeMenus();
      await this.pollChat(true);
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
    const native = await this.cdp.evaluate(`(() => { const h = (${pageHelpers.toString()})(); if (!h.fusionConfig()?.lead) return null; return h.devinVariants(${JSON.stringify(part)}).map(({ label, checked }) => ({ label, checked })); })()`);
    if (native?.length) {
      this.emit({ t: 'menu', kind: `fusion-${part}`, items: native, fusion: await this.cdp.evaluate(helpersCall('fusionConfig()')) });
      return;
    }
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
    const picked = await this.cdp.evaluate(`(() => { const h = (${pageHelpers.toString()})(); if (!h.fusionConfig()) return false; const rows = h.devinVariants(${JSON.stringify(part)}); const row = rows.find(x => ${part === 'fast' ? '!x.checked' : `x.label === ${JSON.stringify(String(value))}`}); if (!row) return false; h.devinPickerProps().onModelSelect(row.config); return true; })()`);
    if (picked) {
      await this.pollChat();
      await this.openMenu('model');
      return;
    }
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

  async scrollChat(dy, automatic = false, history = false) {
    if (this.app === 'codex') {
      if (automatic && (await this.cdp.evaluate(helpersCall('agentState()')))?.busy) return { blocked: true };
      if (this.historyLoading) return { blocked: true };
      const cdp = this.cdp, sel = this.sel, thread = this.threadId;
      this.historyLoading = true;
      let before;
      try {
        before = await cdp.evaluate(helpersCall('scrollCodexHistory(false)'));
        if (!this.codexHistoryTop) this.codexHistoryTop = new Map();
        const top = this.codexHistoryTop.get(thread);
        if (before && top != null) {
          await cdp.evaluate(helpersCall(`scrollCodexHistory(${top})`));
          await new Promise(r => setTimeout(r, 150));
        }
        if (!this.liveRead(cdp, sel)) return;
        const point = before && await cdp.evaluate(helpersCall('scrollCodexHistory()'));
        if (point) {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: dy });
          await new Promise(r => setTimeout(r, 400));
          const chat = await cdp.evaluate(helpersCall('extract()'));
          if (!this.liveRead(cdp, sel) || chat?.thread !== thread) return;
          const pageItems = chat.items;
          this.mergeCodexItems(chat);
          if (history) {
            chat.items = [...new Map([...pageItems, ...chat.items].map(it => [it.i, it])).values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
            chat.earlier = Math.min(...chat.items.map(it => Math.floor((it.order ?? Infinity) / 10000))) > 1;
          }
          const after = await cdp.evaluate(helpersCall('scrollCodexHistory(false)'));
          if (after) this.codexHistoryTop.set(thread, after.scrollTop);
          await cdp.evaluate(helpersCall(`scrollCodexHistory(${before.scrollTop})`));
          before = null;
          if (!this.liveRead(cdp, sel)) return;
          this.lastChat = JSON.stringify(chat);
          this.emit({ t: 'chat', sel: this.selectionKey(), chat });
          return { earlier: chat.earlier };
        }
      } finally {
        if (before && this.liveRead(cdp, sel) && await cdp.evaluate(helpersCall('codexThread()')) === thread) await cdp.evaluate(helpersCall(`scrollCodexHistory(${before.scrollTop})`));
        this.historyLoading = false;
        this.lastChatAt = 0;
      }
    }
    const rect = await this.cdp.evaluate(helpersCall('panelRect()'));
    if (!rect) return;
    const [x, y, w, h] = rect;
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: x + w / 2, y: y + h / 2, deltaX: 0, deltaY: dy });
    if (history) {
      await new Promise(r => setTimeout(r, 400));
      this.lastChatAt = 0;
      await this.pollChat(true);
      const earlier = this.lastChat ? JSON.parse(this.lastChat).earlier : undefined;
      return { earlier: earlier === undefined ? !(await this.cdp.evaluate(helpersCall('historyAtStart()'))) : earlier };
    }
    setTimeout(() => this.pollChat().catch(() => {}), 400);
  }

  emit(obj) {
    if (obj?.t === 'chat' && obj.sel && obj.chat) {
      (this.chatBySel ||= new Map()).delete(obj.sel);
      this.chatBySel.set(obj.sel, obj.chat);
      if (this.chatBySel.size > 12) this.chatBySel.delete(this.chatBySel.keys().next().value);
    }
    if (this.client.readyState === 1) this.client.send(JSON.stringify(obj), obj?.t === 'frame' ? { compress: false } : undefined);
  }

  // Asks Cursor's own Cmd+P index where a bare file name lives, then closes the picker again.
  async quickOpen(name) {
    await this.key(process.platform === 'darwin' ? 'Meta+p' : 'Ctrl+p', { cdp: this.editorCdp });
    try {
      let rows = null;
      for (let i = 0; i < 6 && !rows; i++) {
        await new Promise(r => setTimeout(r, 150));
        rows = await this.editorCdp.evaluate(helpersCall('quickOpenRows()'));
      }
      if (!rows) return [];
      await this.editorCdp.send('Input.insertText', { text: name });
      let hits = [];
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 250));
        hits = (await this.editorCdp.evaluate(helpersCall('quickOpenRows()')) || []).filter(r => r.name === name);
        if (hits.length) break;
      }
      return hits;
    } finally {
      await this.key('Escape', { cdp: this.editorCdp });
    }
  }

  async resolveFile(text) {
    const { p, line } = parseRef(text);
    if (!p) throw new Error('不是文件路径');
    const roots = await this.currentRoots();
    const ws = roots[0] || null;
    const host = null;
    // Devin has no quick-open; resolve purely on disk (absolute, root-relative, basename search).
    if (this.app === 'devin') {
      for (const root of roots.length ? roots : [null]) {
        try { return await resolveLocal(root, text); } catch (e) { if (root === roots.at(-1) || !root) throw e; }
      }
    }
    const isAbs = /^(\/|~\/|[a-zA-Z]:[\\/])/.test(p);
    const tried = [];
    const tryPath = async (h, abs) => {
      if (tried.some(t => t.h === h && t.abs === abs)) return null;
      tried.push({ h, abs });
      const size = await fileSize(h, abs);
      return size == null ? null : { host: h, path: abs, size, line };
    };
    if (isAbs) {
      const hosts = [];
      const addHost = h => { const key = h || null; if (!hosts.some(x => (x || null) === key)) hosts.push(key); };
      addHost(host);
      for (const root of roots) addHost(root.host);
      addHost(null);
      for (const h of hosts) {
        const hit = await tryPath(h, p);
        if (hit) return hit;
      }
    } else if (roots.length) {
      for (const root of roots) {
        const hit = await tryPath(root.host, path.posix.join(root.root, p));
        if (hit) return hit;
      }
    }
    if (this.winTitle === 'Cursor Agents') {
      // The Agents window mixes projects, so try recently opened folders.
      for (const w of workspaces().filter(w => !w.host).slice(0, 8)) {
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

  // The desktop app's own colour theme, cached process-wide per app (theme.mjs
  // themeFor); falls back to a shiki builtin matching the phone's light/dark
  // choice (sent via {t:'appTheme'}).
  async fileTheme() {
    const port = Number(new URL(EDITORS.find(e => e.app === this.app)?.url || CDP_URL).port);
    const theme = await themeFor(this.app, { port });
    return theme || (this.dark === false ? 'light-plus' : 'dark-plus');
  }

  async fileMarks(f, text, reviewDiff = '') {
    if (reviewDiff) {
      const marks = /^@@ /m.test(reviewDiff) ? parseGitDiff(reviewDiff) : agentMarks(new Map([[0, {
        kind: 'edit', f: f.path,
        diff: reviewDiff.split('\n').filter(l => /^[ +\-]/.test(l) && !/^---|^\+\+\+/.test(l)).map(l => [l[0], l.slice(1)]),
      }]]), f.path, text);
      return { marks, markSource: 'agent', diff: reviewDiff };
    }
    if (f.host) return null;
    const changes = this.app === 'codex' ? await this.cdp.evaluate(helpersCall('codexChanges()')) : null;
    const normalized = p => process.platform === 'win32' ? path.posix.normalize(p.replace(/\\/g, '/')).toLowerCase() : path.posix.normalize(p.replace(/\\/g, '/'));
    const diff = changes?.files.find(file => normalized(file.name) === normalized(f.path) || normalized(f.path).endsWith('/' + normalized(file.name)))?.diff;
    const git = await gitMarks(f.path).catch(() => null);
    if (git) {
      if (git.newFile) return { marks: { add: [], mod: [], del: [] }, markSource: 'git', newFile: true, diff };
      if (git.add.length || git.mod.length || git.del.length) {
        return { marks: { add: git.add, mod: git.mod, del: git.del }, markSource: 'git', diff };
      }
    }
    if (this.app === 'codex') {
      const edits = new Map();
      for (const file of changes.files) for (const hunk of (file.diff || '').split(/^@@[^\n]*\n/m)) {
        const diff = hunk.split('\n').filter(l => /^[ +\-]/.test(l) && !/^---|^\+\+\+/.test(l)).map(l => [l[0], l.slice(1)]);
        if (diff.length) edits.set(edits.size, { kind: 'edit', f: file.name, diff });
      }
      const marks = agentMarks(edits, f.path, text);
      if (marks) return { marks, markSource: 'agent', diff };
    }
    if (this.app === 'devin') {
      const m = agentMarks(this.devinHist, f.path, text);
      if (m && (m.add.length || m.del.length)) return { marks: m, markSource: 'agent' };
    }
    return git && !git.newFile ? null : (git?.newFile ? { marks: { add: [], mod: [], del: [] }, markSource: 'git', newFile: true } : null);
  }

  async openFile(text, reviewDiff = '') {
    if (this.app === 'codex') {
      const run = (await this.cdp.evaluate(helpersCall('codexFacts()')))?.view?.run || '';
      if (run && !/local|本地/i.test(run)) {
        this.emit({ t: 'file', error: '当前执行位置不是本机，不能把远程路径当成电脑上的文件打开', name: path.posix.basename(parseRef(text).p) });
        return;
      }
    }
    this.emit({ t: 'file', loading: true, name: path.posix.basename(parseRef(text).p) });
    try {
      const f = await this.resolveFile(text);
      const body = await readFile(f.host, f.path, f.size);
      let hl = null;
      if (body.text) {
        const theme = await this.fileTheme();
        hl = await highlightText(body.text, f.path, theme).catch(() => null);
      }
      this.emit({ t: 'file', name: path.posix.basename(f.path), path: f.path, host: f.host, size: f.size, line: f.line, editable: body.text != null && !body.truncated, ...body, ...(hl ? { hl } : {}) });
      // Gutter marks come afterwards — the git calls shouldn't hold the first paint.
      if (body.text) {
        this.fileMarks(f, body.text, reviewDiff).then(marked => {
          if (marked?.marks || marked?.newFile || marked?.diff) this.emit({ t: 'fileMarks', path: f.path, host: f.host, ...(marked?.marks ? { marks: marked.marks, markSource: marked.markSource } : {}), ...(marked?.newFile ? { newFile: true } : {}), ...(marked?.diff ? { diff: marked.diff } : {}) });
        }).catch(() => {});
      }
    } catch (e) {
      this.emit({ t: 'file', error: e.message, name: path.posix.basename(parseRef(text).p) });
    }
  }

  async saveFile(filePath, text, host) {
    try {
      if (host) throw new Error('只支持修改本地文件');
      const loc = locateWritable(filePath, '');
      if (!loc) throw new Error('只能修改已打开过的项目里的文件');
      const size = await writeTextFile(loc.host, loc.path, text);
      this.emit({ t: 'saved', ok: true, path: filePath, host: loc.host || '', size });
      this.emit({ t: 'status', ok: true, msg: '已保存' });
    } catch (e) {
      this.emit({ t: 'saved', ok: false, error: e.message, path: filePath, host: host || '' });
      this.emit({ t: 'status', ok: false, msg: e.message });
    }
  }

  async attach(target) {
    const req = target && typeof target === 'object' ? target : { id: target || '' };
    let appId = String(req.id || '');
    let windowId = String(req.windowId || '');
    const threadId = String(req.threadId || '');
    if (appId.startsWith('codex:')) {
      windowId = windowId || appId.slice('codex:'.length);
      appId = 'codex';
    }
    let codexPages;
    if (appId === 'codex') {
      try {
        codexPages = await codexWindows(CODEX_CDP_URL, true);
        if (windowId && !codexPages.some(p => p.pageId === windowId) && threadId) {
          const recovered = await this.codexPageForThread(codexPages, threadId);
          if (recovered) windowId = recovered.pageId;
        }
      } catch (error) {
        this.emit({ t: 'attachFailed', ready: this.app === 'fusion' || !!this.cdp });
        throw new Error(`读取 Codex 调试接口失败，请重试：${error.message}`);
      }
    }
    if (appId === 'fusion') {
      this.detach();
      this.clearViewState();
      this.app = 'fusion';
      this.targetId = 'fusion';
      this.windowId = 'fusion';
      this.threadId = '';
      this.winTitle = 'Fusion';
      if (!this.fusionRun) this.fusionRun = newFusionRun();
      this.threadId = this.fusionRun.id;
      this.emit({ t: 'attached', id: 'fusion', title: 'Fusion', app: 'fusion', appName: 'Fusion', project: '', windowId: 'fusion', threadId: this.threadId, sel: this.selectionKey() });
      this.fusionEmit();
      if (this.fusionRun.a || this.fusionRun.b) { await this.fusionCatalog(); this.fusionEmit(); }
      return;
    }
    const wins = await listWindows();
    if (appId === 'codex') {
      const pages = codexPages;
      if (!pages.length) {
        this.emit({ t: 'attached', id: 'codex', title: 'Codex', app: 'codex', windowId, threadId, closed: true, ready: this.app === 'fusion' || !!this.cdp });
        this.emit({ t: 'status', ok: false, msg: '这个 Codex 窗口已经关闭，请重新选择' });
        return;
      }
      const picked = windowId && pages.some(p => p.pageId === windowId)
        ? pages.find(p => p.pageId === windowId)
        : (pages.find(p => !/^Welcome\b/.test(p.rawTitle || '') && p.chatWs) || pages.find(p => p.chatWs) || pages[0]);
      if (!picked) throw new Error('没有找到 Codex 窗口。请用 ./start-codex.sh 启动，并打开 Codex 侧边栏');
      const entry = wins.find(w => w.id === 'codex');
      if (!entry) throw new Error('没有找到 Codex 窗口。请用 ./start-codex.sh 启动，并打开 Codex 侧边栏');
      await this.openBound({ ...entry, title: picked.rawTitle }, picked.ws, picked.chatWs, { windowId: picked.pageId, threadId });
      if (!picked.chatWs) this.emit({ t: 'status', ok: false, msg: 'Codex 侧边栏还没打开' });
      return;
    }
    const win = wins.find(w => w.id === appId) || wins.find(w => appId && w.id.endsWith(':' + appId))
      || (appId ? wins.find(w => w.app === appId.split(':')[0]) : null);
    if (appId && !win) {
      this.emit({ t: 'attached', id: appId, closed: true, ready: this.app === 'fusion' || !!this.cdp });
      this.emit({ t: 'status', ok: false, msg: '这个窗口已经关闭，请重新选择' });
      return;
    }
    const chosen = win || wins[0];
    if (!chosen) throw new Error('没有找到 Cursor、Devin 或 Codex 窗口。Cursor 用调试端口 9222，Devin 用 ./start-devin.sh，Codex 用 ./start-codex.sh');
    await this.openBound(chosen, chosen.ws, null, { windowId: chosen.id });
    if (threadId && threadId !== this.threadId) {
      try { await this.openAgent(threadId); }
      catch { this.emit({ t: 'status', ok: false, msg: '没有找到上次的会话，已留在当前会话' }); }
    }
  }

  async openBound(win, editorWs, chatWs, selection) {
    const editorCdp = new Cdp(editorWs);
    const cdp = chatWs ? new Cdp(chatWs) : editorCdp;
    let thread = '';
    let staleSelect = '';
    try {
      await editorCdp.connect();
      if (cdp !== editorCdp) await cdp.connect();
      if (win.app === 'codex') {
        thread = await cdp.evaluate(helpersCall('codexThread()')) || '';
        if (selection.threadId && selection.threadId !== thread) {
          if (await this.selectCodexThread(selection.threadId, cdp)) thread = selection.threadId;
          else staleSelect = selection.threadId;
        }
      }
    } catch (error) {
      for (const connection of new Set([cdp, editorCdp])) connection.close();
      this.emit({ t: 'attachFailed', ready: this.app === 'fusion' || !!this.cdp });
      throw error;
    }
    this.detach();
    this.clearViewState();
    this.editorCdp = editorCdp;
    this.cdp = cdp;
    this.windowId = selection.windowId;
    if (win.app === 'codex') this.codexPageId = selection.windowId;
    this.threadId = thread;
    this.targetId = win.id;
    this.winTitle = win.title;
    this.app = win.app || 'cursor';
    this.lastChat = '';
    this.thinking = new Map();
    this.thinkingTried = new Map();
    this.tasksTried = new Map();
    this.devinHist = new Map();
    this.thoughtFails = new Map();
    this.curSession = undefined;
    this.keptThink = new Map();
    const onclose = () => {
      if (this.cdp !== cdp && this.editorCdp !== editorCdp) return;
      this.detach();
      this.emit({ t: 'status', ok: false, msg: this.appMessage('{app} 窗口连接已断开') });
    };
    for (const connection of new Set([cdp, editorCdp])) {
      connection.onclose = onclose;
      await connection.send('Page.enable');
    }
    editorCdp.on('Page.screencastFrame', p => this.onFrame(p));
    await this.refreshViewport();
    if (this.app !== 'codex') this.threadId = await this.cdp.evaluate(helpersCall('activeThread()')) || '';
    this.emit({
      t: 'attached', id: win.id, title: this.app === 'codex' ? 'Codex' : win.title, app: win.app,
      appName: this.appMessage('{app}'), project: this.app === 'codex' ? codexFolder(this.winTitle) : '', windowId: this.windowId || '', threadId: this.threadId || '', sel: this.selectionKey(), plans: appPlans,
    });
    if (staleSelect) this.emit({ t: 'status', ok: false, msg: '没有找到上次的会话，已留在当前会话' });
    const cachedChat = this.chatBySel?.get(this.selectionKey());
    if (cachedChat) this.emit({ t: 'chat', sel: this.selectionKey(), chat: cachedChat, cached: true });
    await this.setMode(this.mode);
    setTimeout(() => this.prefetchMenus().catch(() => {}), 800);
  }

  // Warms the phone's sheet caches with whatever can be read without opening visible UI.
  async prefetchMenus() {
    const cdp = this.cdp;
    if (!cdp || this.app === 'fusion' || !this.visible) return;
    const sel = this.selectionKey();
    const [items, fast, models] = await Promise.all([
      cdp.evaluate(helpersCall('effortItems()')).catch(() => null),
      cdp.evaluate(helpersCall('fastInfo()')).catch(() => null),
      cdp.evaluate(helpersCall('modelItemsFast()')).catch(() => null),
    ]);
    if (!this.liveRead(cdp, this.sel)) return;
    if (items?.length) this.emit({ t: 'menu', kind: 'effort', items, fast, cached: true, sel });
    if (models?.length) this.emit({ t: 'menu', kind: 'model', items: models, fast, cached: true, sel });
    this.listAgents(true, true).catch(() => {});
  }

  // Focus emulation breaks real typing while it is on, so it only wraps phone-driven
  // actions that type/tap, and is switched off again shortly after they finish.
  async withFocus(fn) {
    this.focusCount++;
    const connections = [...new Set([this.cdp, this.editorCdp].filter(Boolean))];
    if (this.focusCount === 1) {
      clearTimeout(this.focusTimer);
      this.focusTimer = null;
      for (const c of connections) await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    }
    try { return await fn(); }
    finally {
      this.focusCount = Math.max(0, this.focusCount - 1);
      if (!this.focusCount && !this.focusTimer) {
        this.focusTimer = setTimeout(() => {
          this.focusTimer = null;
          for (const c of connections) if (c === this.cdp || c === this.editorCdp) c.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
        }, 1500);
      }
    }
  }

  detach() {
    clearTimeout(this.focusTimer);
    this.focusTimer = null;
    this.focusCount = 0;
    clearInterval(this.chatTimer);
    clearInterval(this.termTimer);
    clearTimeout(this.ackTimer);
    this.awaitingAck = null;
    const connections = new Set([this.cdp, this.editorCdp]);
    this.cdp = this.editorCdp = null;
    for (const cdp of connections) {
      if (cdp) cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {})
        .then(() => cdp.send('Page.stopScreencast').catch(() => {}))
        .finally(() => cdp.close());
    }
  }

  async refreshViewport() {
    const v = await this.editorCdp.evaluate('({ w: innerWidth, h: innerHeight })');
    if (v) this.viewport = v;
  }

  async startScreencast() {
    await this.editorCdp.send('Page.startScreencast', { ...this.screencast, everyNthFrame: 1 });
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
    if (this.awaitingAck == null || !this.editorCdp) return;
    const sessionId = this.awaitingAck;
    this.awaitingAck = null;
    this.editorCdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  }

  sendFrame(data, force = false) {
    const hash = crypto.createHash('md5').update(data).digest('hex');
    if (!force && hash === this.lastHash) return;
    this.lastHash = hash;
    this.emit({ t: 'frame', data, w: this.viewport.w, h: this.viewport.h });
  }

  // Electron stops painting occluded/minimized windows, so screencast goes quiet; fall back to screenshots.
  async pollIfIdle() {
    if (!this.editorCdp || !this.visible || this.mode !== 'screen') return;
    await this.sendPanelRect();
    if (Date.now() - this.lastFrameAt < 2000) return;
    await this.snapshot(false).catch(() => {});
  }

  async snapshot(force) {
    const { data } = await this.editorCdp.send('Page.captureScreenshot', { format: 'jpeg', quality: this.screencast.quality });
    this.sendFrame(data, force);
  }

  toCss(nx, ny) {
    return { x: Math.round(nx * this.viewport.w), y: Math.round(ny * this.viewport.h) };
  }

  async tap(nx, ny, button = 'left') {
    const { x, y } = this.toCss(nx, ny);
    await this.tapCss(x, y, button, this.editorCdp);
  }

  async tapCss(x, y, button = 'left', cdp = this.cdp) {
    const base = { x, y, button, clickCount: 1 };
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  }

  async wheel(nx, ny, dx, dy) {
    const { x, y } = this.toCss(nx, ny);
    await this.editorCdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy });
  }

  async key(combo, opts = {}) {
    const cdp = opts.focusTerminal ? this.editorCdp : (opts.cdp || this.cdp);
    if (opts.focusTerminal) await this.focusTerminal();
    const recall = opts.focusTerminal && (combo === 'ArrowUp' || combo === 'ArrowDown');
    const before = recall ? await cdp.evaluate(helpersCall('terminalCommand()')) : undefined;
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
    await cdp.send('Input.dispatchKeyEvent', { type: withText ? 'keyDown' : 'rawKeyDown', ...ev, ...(withText ? { text: spec.text } : {}) });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
    if (!recall) return;
    let cmd = before;
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 40));
      const next = await cdp.evaluate(helpersCall('terminalCommand()'));
      if (typeof next === 'string' && next !== before) { cmd = next; break; }
      if (i === 7 && typeof next === 'string') cmd = next;
    }
    if (typeof cmd === 'string') this.emit({ t: 'termInput', text: cmd });
  }

  async typeText(text, cdp = this.cdp) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await this.key('Shift+Enter', { cdp });
      if (lines[i]) await cdp.send('Input.insertText', { text: lines[i] });
    }
  }

  // ---- Devin "@" mentions: drive Devin's own typeahead so the result is a real chip ----
  // Waits until the listbox stops changing (it loads asynchronously) and returns its rows.
  async mentionSettle() {
    let last = '', same = 0, rows = null;
    for (let i = 0; i < 18; i++) {
      await new Promise(r => setTimeout(r, 150));
      rows = await this.cdp.evaluate(helpersCall('mentionRows()'));
      const sig = JSON.stringify((rows || []).map(r => [r.label, r.sub]));
      same = sig === last ? same + 1 : 0;
      last = sig;
      if (rows?.length && same >= 1 && i >= 2) break;
    }
    return rows || [];
  }

  // Remove what was typed for a query (Escape closes the menu, Backspace removes the text) and check that the
  // prompt looks like it did before; if it does not and it was empty, clear it.
  async mentionUndo(typed, before) {
    await this.key('Escape');
    await new Promise(r => setTimeout(r, 150));
    for (let i = 0; i < typed; i++) await this.key('Backspace');
    await new Promise(r => setTimeout(r, 250));
    const now = await this.cdp.evaluate(helpersCall('composerState()'));
    if (now !== before && !before) {
      await this.key(process.platform === 'darwin' ? 'Meta+A' : 'Ctrl+A');
      await this.key('Backspace');
    }
  }

  async withMentionLock(seq, fn) {
    const deadline = Date.now() + 20000;
    while (this.mentionBusy) {
      if (Date.now() > deadline) return null;
      await new Promise(r => setTimeout(r, 80));
      if (seq != null && this.mentionSeq !== seq) return null;
    }
    this.mentionBusy = true;
    try { return await fn(); } finally { this.mentionBusy = false; }
  }

  // Phone typed "@q" (or tapped a category): list what Devin offers, then put the prompt back.
  async mentionQuery(q, cat, seq, trigger) {
    if (this.app === 'codex') return this.codexMentionQuery(q, trigger === '/' ? '/' : '@', seq);
    if (this.app !== 'devin') return;
    this.mentionSeq = seq;
    const out = await this.withMentionLock(seq, async () => {
      if (this.mentionSeq !== seq) return null;
      if (!await this.cdp.evaluate(FOCUS_COMPOSER)) throw new Error('没找到可见的聊天输入框');
      const before = await this.cdp.evaluate(helpersCall('composerState()'));
      let typed = 1, prefix = '';
      await this.cdp.send('Input.insertText', { text: '@' });
      await new Promise(r => setTimeout(r, 450));
      if (cat) {
        const root = await this.mentionSettle();
        const idx = root.findIndex(r => r.label.toLowerCase() === cat.toLowerCase());
        if (idx >= 0) {
          for (let i = 0; i < idx; i++) await this.key('ArrowDown');
          await this.key('Enter');
          await new Promise(r => setTimeout(r, 350));
          const now = await this.cdp.evaluate(helpersCall('composerState()'));
          prefix = (now || '').slice((before || '').length).trim();
          typed = prefix.length || typed;
        }
      } else if (q) {
        await this.cdp.send('Input.insertText', { text: q });
        typed += q.length;
      }
      const rows = await this.mentionSettle();
      await this.mentionUndo(typed, before);
      return { rows, prefix };
    }).catch(e => { this.emit({ t: 'status', ok: false, msg: e.message }); return null; });
    if (out && this.mentionSeq === seq) {
      this.emit({ t: 'mentions', seq, q, cat, prefix: out.prefix, root: !q && !cat, rows: out.rows.slice(0, 40).map(r => ({ label: r.label, sub: r.sub })) });
    }
  }

  // Type "@q" and click the option with this label (and folder) so Devin turns it into a chip. False = not found.
  async insertMention(m) {
    return this.withMentionLock(null, async () => {
      const before = await this.cdp.evaluate(helpersCall('composerState()'));
      await this.cdp.send('Input.insertText', { text: '@' });
      await new Promise(r => setTimeout(r, 450));
      if (m.q) await this.cdp.send('Input.insertText', { text: m.q });
      const rows = await this.mentionSettle();
      const hit = rows.find(r => r.label === m.label && r.sub === (m.sub || '')) || rows.find(r => r.label === m.label);
      if (!hit) { await this.mentionUndo(1 + (m.q || '').length, before); return false; }
      await this.tapCss(hit.x, hit.y);
      await new Promise(r => setTimeout(r, 400));
      return true;
    });
  }

  async codexPrompt() {
    const text = await this.cdp.evaluate(helpersCall('codexPromptText()'));
    return typeof text === 'string' ? text : '';
  }

  async codexFocusPrompt() {
    if (!await this.cdp.evaluate(FOCUS_COMPOSER)) throw new Error('没找到 Codex 的输入框');
    const pos = await this.cdp.evaluate(helpersCall('codexPromptPoint()'));
    if (pos) await this.tapCss(pos.x, pos.y);
  }

  async codexRestorePrompt(before) {
    let now = await this.codexPrompt();
    if (now === before) return;
    await this.closeMenus();
    await new Promise(r => setTimeout(r, 120));
    now = await this.codexPrompt();
    if (now === before) return;
    if (before && now.startsWith(before)) {
      const extra = now.slice(before.length);
      for (let i = 0; i < extra.length; i++) await this.key('Backspace');
      if (await this.codexPrompt() === before) return;
    }
    if (!before) {
      await this.cdp.evaluate(helpersCall('codexSelectPrompt()'));
      await this.key('Backspace');
      await new Promise(r => setTimeout(r, 80));
    }
  }

  async codexMentionSettle() {
    let last = '', rows = [];
    for (let i = 0; i < 16; i++) {
      await new Promise(r => setTimeout(r, 140));
      rows = await this.cdp.evaluate(helpersCall('codexMentionRows()')) || [];
      const sig = JSON.stringify(rows.map(r => [r.section, r.key, r.label]));
      if (rows.length && sig === last && i >= 2) break;
      last = sig;
    }
    return rows;
  }

  mentionPayload(rows) {
    return rows.slice(0, 40).map(r => ({ label: r.label, sub: r.sub || '', key: r.key || '', section: r.section || '' }));
  }

  async codexMentionQuery(q, trigger, seq) {
    this.mentionSeq = seq;
    const out = await this.withMentionLock(seq, async () => {
      if (this.mentionSeq !== seq) return null;
      await this.codexFocusPrompt();
      const before = await this.codexPrompt();
      const typed = trigger + String(q || '');
      await this.cdp.send('Input.insertText', { text: typed });
      const rows = await this.codexMentionSettle();
      await this.codexRestorePrompt(before);
      let after = await this.codexPrompt();
      if (after !== before && !before) {
        await this.cdp.evaluate(helpersCall('codexSelectPrompt()'));
        await this.key('Backspace');
        after = await this.codexPrompt();
      }
      if (after !== before) throw new Error('查询菜单后没能恢复原来的输入');
      return rows;
    }).catch(e => { this.emit({ t: 'status', ok: false, msg: e.message }); return null; });
    if (out && this.mentionSeq === seq) this.emit({ t: 'mentions', seq, q, trigger, rows: this.mentionPayload(out) });
  }

  async codexOpenMention(trigger, q) {
    await this.codexFocusPrompt();
    await this.cdp.send('Input.insertText', { text: trigger + String(q || '') });
    return this.codexMentionSettle();
  }

  async codexPick(msg) {
    if (this.app !== 'codex') return;
    const before = await this.withMentionLock(null, async () => {
      await this.codexFocusPrompt();
      return this.codexPrompt();
    });
    const trigger = msg.section === 'commands' || msg.section === 'Skills' ? '/' : '@';
    const parentQ = String(msg.parentQ || msg.q || '').slice(0, 60);
    try {
      let rows = await this.codexOpenMention(trigger, parentQ);
      if (msg.parentKey) {
        const parent = rows.find(r => r.key === msg.parentKey) || rows.find(r => r.label === msg.parentLabel) || rows.find(r => msg.parentLabel && r.label.startsWith(msg.parentLabel));
        if (!parent) throw new Error('电脑上的菜单里没有上一级');
        await this.tapCss(parent.x, parent.y);
        await new Promise(r => setTimeout(r, 350));
        rows = await this.codexMentionSettle();
      }
      const hit = rows.find(r => msg.key && r.key === msg.key) || rows.find(r => r.label === msg.label) || rows.find(r => msg.label && (r.label === msg.label || r.label.startsWith(msg.label)));
      if (!hit) throw new Error('电脑上的菜单里没有这一项');
      await this.tapCss(hit.x, hit.y);
      await new Promise(r => setTimeout(r, 400));
      const dialog = await this.cdp.evaluate(`(() => { const doc = document.getElementById('active-frame')?.contentDocument || document; return [...doc.querySelectorAll('[role=dialog]')].some(e => e.getBoundingClientRect().height > 40); })()`);
      if (dialog) {
        this.emit({ t: 'status', ok: true, msg: '请在请求卡片中确认' });
        setTimeout(() => this.pollChat().catch(() => {}), 300);
        return;
      }
      const next = await this.cdp.evaluate(helpersCall('codexMentionRows()')) || [];
      const branched = next.length && !next.some(r => r.key === hit.key && r.label === hit.label);
      if (branched) {
        await this.codexRestorePrompt(before);
        this.emit({
          t: 'mentions', seq: Number(msg.seq) || 0, submenu: true, q: '',
          parent: { key: hit.key, label: hit.label, q: parentQ, section: hit.section || msg.section || '' },
          rows: this.mentionPayload(next),
        });
        return;
      }
      await this.codexRestorePrompt(before);
      const after = await this.codexPrompt();
      if (after !== before && !before) await this.codexRestorePrompt('');
      this.emit({ t: 'status', ok: true, msg: `已执行 ${hit.label.split('\n')[0]}` });
      setTimeout(() => this.pollChat().catch(() => {}), 300);
    } catch (e) {
      await this.codexRestorePrompt(before).catch(() => {});
      throw e;
    }
  }

  async codexSkillList() {
    const rows = await this.withMentionLock(null, async () => {
      await this.codexFocusPrompt();
      const before = await this.codexPrompt();
      try {
        // Opening the native menu loads skills even after its query cache has expired.
        await this.codexOpenMention('/', '');
        return await this.cdp.evaluate(helpersCall('codexSkills()'));
      } finally { await this.codexRestorePrompt(before); }
    });
    this.emit({ t: 'codexSkills', rows });
  }

  async codexTogglePlan() {
    const before = (await this.cdp.evaluate(helpersCall('codexFacts()')))?.view?.plan;
    await this.codexPick({ section: 'commands', key: 'plan-mode', label: 'Plan mode', q: '' });
    const after = (await this.cdp.evaluate(helpersCall('codexFacts()')))?.view?.plan;
    if (after === before) throw new Error('Plan 模式没有跟着电脑变化');
    this.emit({ t: 'status', ok: true, msg: after ? '已打开 Plan' : '已关闭 Plan' });
  }

  async codexToggleIde() {
    const before = (await this.cdp.evaluate(helpersCall('codexFacts()')))?.view?.ide?.on;
    await this.codexPick({ section: 'commands', label: 'IDE context', q: 'ide' });
    let after = before;
    for (let i = 0; i < 12 && after === before; i++) {
      await new Promise(r => setTimeout(r, 150));
      after = (await this.cdp.evaluate(helpersCall('codexFacts()')))?.view?.ide?.on;
    }
    if (after === before) throw new Error('IDE 上下文没有切换成功');
    this.emit({ t: 'status', ok: true, msg: after ? 'IDE 上下文已打开' : 'IDE 上下文已关闭' });
  }

  async codexRunMenu() {
    const pos = await this.cdp.evaluate(helpersCall(`codexButtonPoint('run')`));
    if (!pos) throw new Error('当前没有执行位置菜单');
    await this.tapCss(pos.x, pos.y);
    let items = [];
    for (let i = 0; i < 10 && !items.length; i++) {
      await new Promise(r => setTimeout(r, 120));
      items = await this.cdp.evaluate(helpersCall('codexRunItems()')) || [];
    }
    await this.closeMenus();
    this.emit({ t: 'menu', kind: 'codex-run', items: items.filter(it => /^(Local|Cloud|Worktree|Connect Codex web)\b/.test(it.label)).map(it => ({ label: it.label, checked: false })) });
  }

  async codexRunPick(label) {
    const pos = await this.cdp.evaluate(helpersCall(`codexButtonPoint('run')`));
    if (!pos) throw new Error('当前没有执行位置菜单');
    await this.tapCss(pos.x, pos.y);
    let hit = null;
    for (let i = 0; i < 10 && !hit; i++) {
      await new Promise(r => setTimeout(r, 120));
      const items = await this.cdp.evaluate(helpersCall('codexRunItems()')) || [];
      hit = items.find(it => it.label === label);
    }
    if (!hit) { await this.closeMenus(); throw new Error(`没找到执行位置：${label}`); }
    await this.tapCss(hit.x, hit.y);
    await new Promise(r => setTimeout(r, 300));
    const run = (await this.cdp.evaluate(helpersCall('codexFacts()')))?.view?.run || '';
    this.emit({ t: 'status', ok: true, msg: run ? `执行位置：${run}` : `已选择 ${label}` });
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  }

  async codexChatMenu() {
    const pos = await this.cdp.evaluate(helpersCall(`codexButtonPoint('actions')`));
    if (!pos) throw new Error('当前会话没有 Chat actions');
    await this.tapCss(pos.x, pos.y);
    let items = [];
    for (let i = 0; i < 10 && !items.length; i++) {
      await new Promise(r => setTimeout(r, 120));
      items = await this.cdp.evaluate(helpersCall('codexRunItems()')) || [];
    }
    await this.closeMenus();
    this.emit({ t: 'menu', kind: 'codex-chat', items: items.map(it => ({ label: it.label, checked: false })) });
  }

  async codexChatPick(label, name) {
    const pos = await this.cdp.evaluate(helpersCall(`codexButtonPoint('actions')`));
    if (!pos) throw new Error('当前会话没有 Chat actions');
    await this.tapCss(pos.x, pos.y);
    let hit = null;
    for (let i = 0; i < 10 && !hit; i++) {
      await new Promise(r => setTimeout(r, 120));
      const items = await this.cdp.evaluate(helpersCall('codexRunItems()')) || [];
      hit = items.find(it => it.label === label);
    }
    if (!hit) { await this.key('Escape'); throw new Error(`没找到会话操作：${label}`); }
    const thread = await this.cdp.evaluate(helpersCall('codexThread()'));
    await this.tapCss(hit.x, hit.y);
    await new Promise(r => setTimeout(r, 300));
    if (label === 'Rename' && name) {
      const opened = await this.cdp.evaluate(`(() => {
        const doc = document.getElementById('active-frame')?.contentDocument || document;
        const input = [...doc.querySelectorAll('input, textarea')].find(e => e.getBoundingClientRect().height > 8);
        if (!input) return false;
        input.focus();
        input.select?.();
        return true;
      })()`);
      if (!opened) throw new Error('重命名输入框没有出现');
      await this.typeText(String(name).slice(0, 80));
      await this.key('Enter');
    }
    this.emit({ t: 'status', ok: true, msg: `已执行 ${label}` });
    const now = await this.cdp.evaluate(helpersCall('codexThread()'));
    if (now && now !== thread) this.emit({ t: 'thread', threadId: now, windowId: this.windowId });
    setTimeout(() => this.pollChat().catch(() => {}), 300);
    setTimeout(() => this.listAgents().catch(() => {}), 400);
  }

  noteFusionRemoved(convId) {
    if (!this.fusionRun) return false;
    let hit = false;
    for (const which of ['a', 'b']) {
      const side = this.fusionRun[which];
      if (side && (side.agentId === convId || String(side.id || '').endsWith(':' + convId))) {
        this.fusionRun[which] = null;
        hit = true;
      }
    }
    if (hit) this.fusionEmit();
    return hit;
  }

  async codexArchiveThread(agentId) {
    if (this.app !== 'codex') throw new Error('只有 Codex 会话可以这样移除');
    const match = /^thread:([^:]+):(.+)$/.exec(String(agentId || ''));
    if (!match) throw new Error('这条会话不能移除');
    const pageId = match[1], convId = match[2];
    const pages = await codexWindows(CODEX_CDP_URL);
    const page = pages.find(p => p.pageId === pageId);
    if (!page?.chatWs) throw new Error('这个窗口已经关闭');
    const own = pageId === this.codexPageId && this.cdp;
    const cdp = own ? this.cdp : new Cdp(page.chatWs);
    const wasCurrent = !!own && this.threadId === convId;
    try {
      if (!own) await cdp.connect();
      const beforeThread = await cdp.evaluate(helpersCall('codexThread()')) || '';
      const pos = await cdp.evaluate(helpersCall('codexRecentPoint()'));
      if (!pos) throw new Error('没有找到会话列表');
      await this.tapCss(pos.x, pos.y, 'left', cdp);
      let target = null;
      for (let i = 0; i < 8 && !target; i++) {
        await new Promise(r => setTimeout(r, 120));
        target = await cdp.evaluate(helpersCall(`codexArchiveTarget(${JSON.stringify(convId)})`));
      }
      if (!target?.action) {
        await cdp.evaluate(helpersCall('closeCodexMenu()'));
        throw new Error(target ? '这个会话没有归档或删除入口' : '没有找到这个会话');
      }
      await this.tapCss(target.x, target.y, 'left', cdp);
      await new Promise(r => setTimeout(r, 400));
      const confirm = await cdp.evaluate(helpersCall('codexArchiveConfirm()'));
      if (confirm?.x) await this.tapCss(confirm.x, confirm.y, 'left', cdp);
      await new Promise(r => setTimeout(r, 400));
      await cdp.evaluate(helpersCall('closeCodexMenu()'));
      const rows = await this.codexThreadRows(cdp);
      if (rows.some(row => row.id === convId)) throw new Error('操作没有成功，会话还在列表里');
      const afterThread = await cdp.evaluate(helpersCall('codexThread()')) || '';
      if (!wasCurrent && afterThread && beforeThread && afterThread !== beforeThread) {
        const phoneThread = this.threadId;
        const saved = this.cdp;
        this.cdp = cdp;
        try { if (!await this.selectCodexThread(beforeThread) && own) this.threadId = afterThread; }
        finally { this.cdp = saved; if (!own) this.threadId = phoneThread; }
      } else if (wasCurrent) {
        this.threadId = afterThread;
        this.publishThread();
        this.lastChatAt = 0;
        await this.pollChat();
      }
      const fusion = this.noteFusionRemoved(convId);
      await this.listAgents();
      this.emit({ t: 'codexArchived', id: agentId, action: target.action });
      this.emit({ t: 'status', ok: true, msg: fusion ? '会话已移除，请重新选择' : (target.action === 'Delete chat' ? '已删除' : '已归档') });
    } catch (e) {
      await this.listAgents().catch(() => {});
      throw e;
    } finally {
      if (!own) { try { cdp.close(); } catch {} }
    }
  }

  async insertCodexMention(m, before) {
    const trigger = m.trigger === '/' ? '/' : '@';
    const typed = trigger + (m.q || m.label);
    await this.cdp.send('Input.insertText', { text: typed });
    const rows = await this.codexMentionSettle();
    const hit = rows.find(r => m.key && r.key === m.key) || rows.find(r => r.label === m.label) || rows.find(r => m.label && r.label.startsWith(m.label));
    if (!hit) { await this.codexRestorePrompt(before); return false; }
    await this.tapCss(hit.x, hit.y);
    await new Promise(r => setTimeout(r, 250));
    return true;
  }

  async typeWithCodexMentions(text, mentions) {
    let rest = text;
    for (const m of mentions) {
      const at = rest.indexOf(m.token);
      if (at < 0) continue;
      if (at > 0) await this.typeText(rest.slice(0, at));
      rest = rest.slice(at + m.token.length);
      const before = await this.codexPrompt();
      if (await this.insertCodexMention(m, before)) rest = rest.replace(/^ /, '');
      else await this.typeText(m.token);
    }
    if (rest) await this.typeText(rest);
  }

  // Text with @tokens: type the text, and at every token let Devin's typeahead insert the real chip.
  async typeWithMentions(text, mentions) {
    let rest = text;
    for (const m of mentions) {
      const at = rest.indexOf(m.token);
      if (at < 0) continue;
      if (at > 0) await this.typeText(rest.slice(0, at));
      rest = rest.slice(at + m.token.length);
      if (await this.insertMention(m)) rest = rest.replace(/^ /, '');
      else await this.typeText(m.token);
    }
    if (rest) await this.typeText(rest);
  }

  fusionWorker() {
    const key = JSON.stringify([this.deviceId, this.fusionRun.id]);
    let worker = fusionWorkers.get(key);
    if (!worker) {
      worker = new Session({ readyState: 3, send() {} }, this.deviceId);
      clearInterval(worker.idleTimer);
      fusionViewers.delete(worker);
      worker.app = worker.windowId = worker.targetId = 'fusion';
      worker.threadId = this.fusionRun.id;
      worker.fusionRun = this.fusionRun;
      worker.fusionWorkerKey = key;
      worker.emit = obj => {
        for (const viewer of fusionViewers) {
          if (viewer.deviceId === worker.deviceId && viewer.app === 'fusion' && viewer.fusionRun?.id === worker.fusionRun.id) viewer.emit(obj);
        }
      };
      fusionWorkers.set(key, worker);
    }
    return worker;
  }

  fusionFinishJob() {
    this.fusionJob = null;
    this.fusionFlushUsage();
    if (fusionWorkers.get(this.fusionWorkerKey) === this) fusionWorkers.delete(this.fusionWorkerKey);
  }

  fusionProgress(side, items, complete = false) {
    const f = this.fusionRun;
    const prefix = `${f.id}:${f.turn}:${f.round}:${f.phase}:${side}:`;
    const known = new Map((f.progress || []).map(it => [it.i, it]));
    for (const it of items) {
      if (it.k === 'human' || (it.k === 'thinking' && !it.t?.includes('\n'))) continue;
      const i = prefix + it.i;
      const entry = { ...it, i, fusionPhase: f.phase, b: undefined, agents: undefined, btnItem: undefined, f: undefined };
      if (it.k === 'assistant') entry.h = `<div class="hint">${side.toUpperCase()}</div>` + (it.h || fusionHtml(it.t));
      if (it.k === 'thinking') entry.t = `${side.toUpperCase()} · ${it.t}`;
      known.set(i, entry);
    }
    if (complete) for (const [id, it] of known) {
      if (id.startsWith(prefix) && it.k === 'assistant') known.delete(id);
      else if (id.startsWith(prefix)) it.live = false;
    }
    const next = [...known.values()];
    if (JSON.stringify(next) !== JSON.stringify(f.progress || [])) {
      f.progress = next;
      this.fusionEmit();
    }
  }

  fusionItems(f = this.fusionRun) {
    if (!f) return [];
    const prefix = `${f.id}:${f.turn || 0}`;
    const push = (i, k, t) => t ? (k === 'human' ? { i: `${prefix}:${i}`, k, t } : { i: `${prefix}:${i}`, k: 'assistant', h: fusionHtml(t) }) : null;
    const progress = phase => (f.progress || []).filter(it => it.fusionPhase === phase);
    return [
      push('task', 'human', f.task), ...progress('planning'), push('plan', 'assistant', f.plan ? `方案\n${f.plan}` : ''),
      push('echo', 'assistant', f.echo ? `B 的复述\n${f.echo}` : ''),
      ...progress('execute'), push('result', 'assistant', f.result ? `B 的结果\n${f.result}` : ''),
      push('diff', 'assistant', f.diff ? `文件变更\n${f.diff}` : ''),
      ...progress('review'), ...progress('fix'), push('review', 'assistant', f.review ? `A 的检查\n${f.review}` : ''),
    ].filter(Boolean);
  }

  fusionEmit() {
    const f = this.fusionRun;
    if (!f) return;
    f.updated = Date.now();
    if (!this.fusionWorkerKey) this.fusionSaved.current = f.id;
    const index = this.fusionSaved.runs.findIndex(r => r.id === f.id);
    if (index < 0) this.fusionSaved.runs.push(f);
    else this.fusionSaved.runs[index] = f;
    saveState({ fusionHistory });
    if (this.windowId !== 'fusion') return;
    const side = spec => spec ? { id: spec.id, app: spec.app, title: spec.title, conversationTitle: spec.conversationTitle, model: spec.model || '', usage: spec.usage || {} } : null;
    this.emit({ t: 'chat', sel: `fusion|fusion|${f.id}`, chat: {
      items: [...(f.history || []), ...this.fusionItems(f)], earlier: false,
      global: [], busy: FUSION_ACTIVE.includes(f.phase), queued: [], changed: 0, questions: null, readonly: false,
      model: '', title: (f.history?.find(i => i.k === 'human')?.t || f.task || '新 Fusion 会话').split('\n')[0].slice(0, 60), thread: f.id,
      fusion: { project: f.project || null, phase: f.phase || 'idle', round: f.round || 0, a: side(f.a), b: side(f.b), busy: FUSION_ACTIVE.includes(f.phase) },
    } });
  }

  fusionListHistory() {
    this.emit({ t: 'fusionHistory', current: this.fusionRun?.id, list: [...this.fusionSaved.runs].sort((a, b) => b.updated - a.updated).map(f => ({
      id: f.id, title: (f.history?.find(i => i.k === 'human')?.t || f.task || '新 Fusion 会话').split('\n')[0].slice(0, 60), updated: f.updated,
    })) });
  }

  async fusionOpenHistory(id) {
    if (this.fusionCreating) throw new Error('正在创建会话，请稍后再切换');
    if (this.fusionJob) throw new Error('Fusion 正在进行，先停止再切换历史');
    const f = id ? this.fusionSaved.runs.find(f => f.id === id) : newFusionRun();
    if (!f) throw new Error('没有这个 Fusion 会话');
    this.fusionRun = f;
    this.clearViewState();
    this.threadId = f.id;
    this.emit({ t: 'thread', windowId: 'fusion', threadId: f.id, sel: this.selectionKey() });
    this.fusionEmit();
    if (f.a || f.b) { await this.fusionCatalog(); this.fusionEmit(); }
  }

  fusionUsageEmit() {
    if (this.windowId !== 'fusion') return;
    const f = this.fusionRun;
    if (f.a && f.b && f.a.id === f.b.id && this.fusionSideLive) {
      const active = f[this.fusionSideLive];
      const other = f[this.fusionSideLive === 'a' ? 'b' : 'a'];
      other.usage = { ...other.usage, context: active.usage?.context };
    }
    this.emit({ t: 'fusionUsage', sel: `fusion|fusion|${this.fusionRun.id}`, a: this.fusionRun.a?.usage || {}, b: this.fusionRun.b?.usage || {} });
  }

  async fusionUsage(automatic = false, only = '') {
    if (!this.fusionWorkerKey && this.fusionRun) {
      const worker = fusionWorkers.get(JSON.stringify([this.deviceId, this.fusionRun.id]));
      if (worker) return worker.fusionUsage(automatic, only);
    }
    if (this.fusionHold || this.fusionJob) {
      this.fusionUsagePending = { automatic, only };
      return this.fusionUsageEmit();
    }
    this.fusionUsagePending = null;
    const f = this.fusionRun;
    const sides = only ? [only] : f?.a && f?.b && f.a.id === f.b.id ? ['a'] : ['a', 'b'];
    for (const side of sides) {
      const spec = f?.[side];
      if (!spec) continue;
      const usage = await this.withFusionSideSpec(spec, async function () {
        const active = await this.cdp.evaluate(helpersCall('activeThread()'));
        const context = active === spec.agentId
          ? process.platform === 'win32' && spec.app === 'codex' ? windowsCodexContext(active) : await this.cdp.evaluate(helpersCall('contextPct()'))
          : spec.usage?.context;
        try {
          const account = spec.app === 'codex' ? await this.readCodexAccount({ manual: !automatic, fusion: true })
            : spec.app === 'devin' ? await this.cdp.evaluate(helpersCall('readDevinUsage()')) : await this.withFocus(() => this.readCursorUsage(automatic));
          return { context, updated: Date.now(), ...(account || { missing: true }) };
        } catch (e) { return { ...spec.usage, context, error: e.message, cached: true }; }
      }, false).catch(e => ({ ...spec.usage, error: e.message, cached: true }));
      if (this.fusionRun === f && f[side] === spec) {
        spec.usage = usage;
        const other = f[side === 'a' ? 'b' : 'a'];
        if (other?.id === spec.id) other.usage = { ...usage };
      }
      this.fusionUsageEmit();
    }
    this.fusionEmit();
  }

  fusionFlushUsage() {
    const pending = this.fusionUsagePending;
    this.fusionUsagePending = null;
    if (pending && this.windowId === 'fusion') this.fusionUsage(pending.automatic, pending.only).catch(e => this.emit({ t: 'status', ok: false, msg: e.message }));
  }

  async fusionListProjects(dir) {
    if (dir !== undefined) return this.emit({ t: 'fusionProjects', browse: projectList(dir) });
    const projects = [...new Map(workspaces().map(w => {
      const project = fusionProject(w.root, w.host || '');
      return project && (project.host || fs.existsSync(project.root) && fs.statSync(project.root).isDirectory()) && [project.id, project];
    }).filter(Boolean)).values()];
    this.emit({ t: 'fusionProjects', list: projects, unknown: 0 });
  }

  fusionSetProject(id, folder = '') {
    if (this.fusionCreating) throw new Error('正在创建会话，请稍后再切换项目');
    if (this.fusionJob || FUSION_ACTIVE.includes(this.fusionRun.phase)) throw new Error('这一轮还在进行，先停止再更换项目');
    const workspace = workspaces().find(w => fusionProject(w.root, w.host || '')?.id === id);
    const project = folder ? fusionProject(safeHomePath(folder).real) : workspace && fusionProject(workspace.root, workspace.host || '');
    if (!project) throw new Error('项目未确认，请重新选择');
    if (this.fusionRun.project?.id !== id) {
      this.fusionRun.project = project;
      this.fusionRun.a = this.fusionRun.b = null;
    }
    this.fusionEmit();
  }

  async fusionCheckProject(project) {
    if (this.app === 'cursor') {
      const current = await this.cdp.evaluate(helpersCall('cursorWorkspace()'));
      if (fusionProject(current?.root, current?.host || '')?.id === project?.id) return;
      if (current?.root) throw new Error('当前会话不属于所选项目，请重新选择');
      const row = (await this.cdp.evaluate(helpersCall('agentList()'))).find(a => a.current);
      if (fusionCursorProjects().get(row?.repository)?.id === project?.id) return;
    }
    const current = this.app === 'codex' ? await this.cdp.evaluate(helpersCall('codexCurrentProject()'))
      : windowRoots(await this.editorCdp.evaluate('document.title'), this.app)[0];
    if (!project || fusionProject(current?.root, current?.host || '')?.id !== project.id) throw new Error('当前会话不属于所选项目，请重新选择');
  }

  async fusionCatalog() {
    const sides = [];
    const cursorProjects = fusionCursorProjects();
    const errors = new Map();
    for (const w of await listWindows()) {
      if (w.app === 'fusion') continue;
      const windows = w.app === 'codex' ? await codexWindows(CODEX_CDP_URL) : [w];
      for (const p of windows) {
        if (w.app === 'codex' && !p.chatWs) continue;
        const spec = { id: w.app === 'codex' ? `codex:${p.pageId}` : w.id, app: w.app,
          title: p.title, windowTitle: p.rawTitle || p.title, windowId: p.pageId || w.id,
          ws: p.ws, chatWs: p.chatWs || null };
        let rows;
        try { rows = await this.withFusionSideSpec(spec, async function () {
          if (this.app === 'codex') return this.codexThreadRows();
          if (this.app === 'devin' && await this.cdp.evaluate(helpersCall('devinSurface()')) === 'editor') {
            const rows = await this.cdp.evaluate(helpersCall('agentList()'));
            if (rows?.length) return rows;
            await this.setSurface('agent');
            try { return await this.cdp.evaluate(helpersCall('agentList()')) || []; }
            finally { await this.setSurface('editor'); }
          }
          if (this.app === 'cursor' && await this.cdp.evaluate(helpersCall('clickCloseSettings()'))) await new Promise(r => setTimeout(r, 100));
          return await this.cdp.evaluate(helpersCall('agentList()')) || [];
        }, false); } catch (e) { errors.set(w.app, e.message); continue; }
        for (const row of rows) {
          const roots = windowRoots(spec.windowTitle, spec.app);
          const cursorProject = w.app === 'cursor' ? cursorProjects.get(row.repository) : null;
          const root = row.workspace || cursorProject?.root || (roots.length === 1 ? roots[0].root : '');
          const host = row.workspace ? row.host || '' : cursorProject?.host || roots[0]?.host || '';
          const project = fusionProject(root, host);
          const id = JSON.stringify([computerId(), w.app, host, row.id]);
          const known = conversationProjects[id];
          if (project) conversationProjects[id] = { project, originProject: known?.originProject || known?.project || project };
          sides.push({ ...spec, id, agentId: row.id, available: true, originProject: conversationProjects[id]?.originProject || null,
            conversationTitle: row.title, project: project || known?.project || null,
            title: `${w.app === 'codex' ? 'Codex' : w.app === 'devin' ? 'Devin' : 'Cursor'} · ${p.title} · ${row.title}`,
            workspace: row.workspace || cursorProject?.root || '' });
        }
      }
    }
    for (const side of ['a', 'b']) {
      const spec = this.fusionRun?.[side];
      if (!spec) continue;
      const live = sides.find(s => s.app === spec.app && spec.agentId && s.agentId === spec.agentId && (s.project?.host || '') === (spec.project?.host || ''));
      if (live) Object.assign(spec, live);
      else if (!sides.some(s => s.id === spec.id)) sides.push({ ...spec, available: !!spec.draft });
    }
    this.fusionCatalogErrors = errors;
    this.fusionSides = sides;
    saveState({ conversationProjects });
    return sides;
  }

  async fusionListSides(side) {
    if (!this.fusionRun.project) throw new Error('先选择项目');
    const catalog = await this.fusionCatalog();
    const selected = [this.fusionRun.a, this.fusionRun.b].filter(Boolean);
    const list = catalog.filter(s => s.project?.id === this.fusionRun.project.id || selected.some(p => p.id === s.id));
    this.emit({ t: 'fusionSides', side: side === 'b' ? 'b' : 'a', apps: EDITORS.map(({ app, name }) => ({ app, name,
      unavailable: this.fusionCatalogErrors?.get(app) ? '读取失败：' + this.fusionCatalogErrors.get(app) : catalog.some(s => s.app === app && s.project && s.project.id !== this.fusionRun.project.id) ? '已打开的会话属于其他项目，请先在电脑上打开所选项目' : catalog.some(s => s.app === app && !s.project) ? '无法确认会话所属项目，请先在电脑上打开所选项目' : '当前项目没有已打开的会话',
    })), list: list.map(s => ({ ...s, ws: undefined, chatWs: undefined, unavailable: !s.available ? '暂不可连接，原选择已保留' : s.project?.id !== this.fusionRun.project.id ? '执行目录与所选项目不同' : '' })),
      other: catalog.filter(s => s.project?.id !== this.fusionRun.project.id && !list.includes(s)).map(({ id, app, conversationTitle, project }) => ({ id, app, conversationTitle, project })) });
  }

  async fusionSetSide(side, id) {
    if (this.fusionCreating) throw new Error('正在创建会话，请稍后再更换');
    const which = side === 'b' ? 'b' : 'a';
    if (!this.fusionRun) this.fusionRun = newFusionRun();
    if (['planning', 'echo', 'echo-check', 'execute', 'review', 'fix'].includes(this.fusionRun.phase)) throw new Error('这一轮还在进行，先停止再更换');
    const spec = this.fusionSides?.find(s => s.id === id);
    if (!spec?.available) throw new Error('会话暂不可连接，原选择已保留，请重新读取列表');
    if (!this.fusionRun.project || spec.project?.id !== this.fusionRun.project.id) throw new Error('会话不属于所选项目');
    const model = await this.withFusionSideSpec(spec, async function () {
      await this.fusionCheckProject(spec.project);
      const chat = await this.cdp.evaluate(helpersCall('extract()'));
      return chat?.model || '';
    });
    this.fusionRun[which] = { ...spec, ...fusionModelSpec(model) };
    this.fusionEmit();
    await this.fusionUsage(true, which);
    this.emit({ t: 'status', ok: true, msg: which === 'a' ? `A：${spec.title}` : `B：${spec.title}` });
    await this.fusionModelMenu(which);
  }

  async fusionConfirmTrust(approve) {
    const pending = this.fusionPendingTrust;
    if (!pending || pending.runId !== this.fusionRun?.id || pending.project.id !== this.fusionRun?.project?.id) throw new Error('项目已改变，请重新创建会话');
    this.fusionPendingTrust = null;
    if (!approve) return this.emit({ t: 'status', ok: true, msg: '已取消创建，原会话保留' });
    await this.withFusionSideSpec(pending.spec, async function () {
      this.pendingProject = { root: pending.project.root, app: this.app, windowId: this.windowId };
      this.finishProject = async () => { this.pendingProject = null; };
      await this.confirmProjectTrust(true);
    }, false);
    return this.fusionNewSide(pending.side, pending.app, pending.resumeContext);
  }

  async fusionContinue(side, id) {
    if (FUSION_ACTIVE.includes(this.fusionRun?.phase) || this.fusionCreating) throw new Error('这一轮还在进行');
    const source = this.fusionSides?.find(s => s.id === id && s.available);
    if (!source) throw new Error('原会话暂不可连接');
    const context = await this.withFusionSideSpec(source, async function () {
      const chat = await this.cdp.evaluate(helpersCall('extract()'));
      if (chat?.busy) throw new Error('原会话正在运行，请完成后再续接');
      return (chat?.items || []).filter(i => ['human', 'assistant'].includes(i.k)).slice(-8).map(i => `${i.k}: ${String(i.t || i.h || '').replace(/<[^>]*>/g, ' ').slice(0, 1500)}`).join('\n').slice(-6000);
    });
    await this.fusionNewSide(side, source.app, context);
  }

  async fusionNewSide(side, app, resumeContext = '') {
    if (this.fusionCreating) return;
    if (!['cursor', 'devin', 'codex'].includes(app)) throw new Error('请选择 Cursor、Devin 或 Codex');
    const f = this.fusionRun, project = f?.project, which = side === 'a' ? 'a' : 'b';
    if (!project) throw new Error('先选择项目');
    if (FUSION_ACTIVE.includes(f.phase)) throw new Error('这一轮还在进行，先停止再新建');
    this.fusionCreating = true;
    try {
      let target;
      const openingCodex = new Set();
      for (let i = 0; i < 40 && !target; i++) {
        const windows = app === 'codex' ? (await codexWindows(CODEX_CDP_URL)).map(p => ({ ...p, id: `codex:${p.pageId}`, app, title: p.rawTitle, windowId: p.pageId, windowTitle: p.rawTitle })) : (await listWindows()).filter(w => w.app === app);
        for (const w of windows) {
          const matches = await this.withFusionSideSpec({ ...w, windowId: w.windowId || w.id, windowTitle: w.title }, async function () {
            if (app === 'cursor') await this.cdp.evaluate(helpersCall('clickCloseSettings()'));
            const current = app === 'cursor' ? await this.cdp.evaluate(helpersCall('cursorWorkspace()')) || windowRoots(await this.editorCdp.evaluate('document.title'), app)[0] : app === 'codex' ? windowRoots(await this.editorCdp.evaluate('document.title'), app)[0] : windowRoots(await this.editorCdp.evaluate('document.title'), app)[0];
            return fusionProject(current?.root, current?.host || '')?.id === project.id;
          }, false);
          if (matches && app === 'codex' && !w.chatWs) {
            if (!openingCodex.has(w.id)) {
              openingCodex.add(w.id);
              await this.withFusionSideSpec({ ...w, windowId: w.windowId, windowTitle: w.title }, async function () {
                await this.key(process.platform === 'darwin' ? 'Meta+Shift+p' : 'Ctrl+Shift+p', { cdp: this.editorCdp });
                await this.editorCdp.send('Input.insertText', { text: 'Codex: Open Codex Sidebar' });
                await new Promise(r => setTimeout(r, 200));
                await this.key('Enter', { cdp: this.editorCdp });
              }, false);
            }
            continue;
          }
          if (matches || (app === 'devin' && !project.host)) { target = w; break; }
        }
        if (!target) {
          if (!i) {
            if (project.host) throw new Error('远程项目尚未打开，请先在电脑上打开所选项目');
            this.emit({ t: 'status', ok: true, msg: '正在打开项目…' }); await openFolder(project.root, app);
          }
          await new Promise(r => setTimeout(r, 250));
        }
      }
      if (!target) throw new Error('项目没有打开成功，请检查电脑上的软件窗口');
      this.emit({ t: 'status', ok: true, msg: '正在创建会话…' });
      const spec = { ...target, windowId: target.windowId || target.id, windowTitle: target.title, project, workspace: project.root };
      const created = await this.withFusionSideSpec(spec, async function () {
        if (app === 'devin' && await this.cdp.evaluate(helpersCall('devinSurface()')) === 'editor') await this.setSurface('agent');
        const trust = await this.editorCdp.evaluate(helpersCall('workspaceTrustState()'));
        if (trust.required) {
          this.fusionOwner.fusionPendingTrust = { side: which, app, project, spec, resumeContext, runId: f.id };
          this.emit({ t: 'fusionTrust', path: project.root });
          return null;
        }
        const before = await this.cdp.evaluate(helpersCall('activeThread()'));
        if (app === 'codex') {
          this.emit = () => {};
          try { await this.newCodexChat(); } finally { delete this.emit; }
        } else await this.pressControl('newChat');
        if (app === 'cursor') {
          await new Promise(r => setTimeout(r, 200));
          const current = await this.cdp.evaluate(helpersCall('cursorWorkspace()')) || windowRoots(await this.editorCdp.evaluate('document.title'), app)[0];
          if (fusionProject(current?.root, current?.host || '')?.id !== project.id && !await this.cdp.evaluate(helpersCall(`cursorSelectProject(${JSON.stringify(project.root)}, ${JSON.stringify(project.host || '')})`))) throw new Error('新会话的项目选项尚未加载');
        }
        if (app === 'devin') {
          for (let i = 0; i < 20 && !await this.cdp.evaluate(helpersCall('workdirInfo()')); i++) await new Promise(r => setTimeout(r, 150));
          const current = windowRoots(await this.editorCdp.evaluate('document.title'), app)[0];
          if (fusionProject(current?.root, current?.host || '')?.id !== project.id) await this.workdirPick(project.name, project.root, 60000);
        }
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 150));
          const chat = await this.cdp.evaluate(helpersCall('extract()'));
          if (chat && (!chat.thread || chat.thread !== before) && !chat.items?.length && await this.cdp.evaluate(helpersCall('hasComposer()'))) {
            await this.fusionCheckProject(project);
            return chat;
          }
        }
        throw new Error('没有读到新会话，请检查电脑上的新建界面');
      }, false);
      if (!created) return;
      const id = JSON.stringify([computerId(), app, project.host || '', created.thread || crypto.randomUUID()]);
      const other = f[which === 'a' ? 'b' : 'a'];
      if (created.thread && other?.agentId === created.thread) throw new Error('新建未产生独立会话，原选择已保留');
      f[which] = { ...spec, id, agentId: created.thread || '', draft: !created.thread, resumeContext, available: true,
        conversationTitle: created.title || '新会话', title: `${app === 'codex' ? 'Codex' : app === 'cursor' ? 'Cursor' : 'Devin'} · 新会话`, ...fusionModelSpec(created.model) };
      this.fusionEmit();
      await this.fusionListSides(which);
      this.emit({ t: 'status', ok: true, msg: '已创建并选择新会话' });
      await this.fusionModelMenu(which);
    } finally { this.fusionCreating = false; }
  }

  async withFusionSideSpec(spec, fn, select = true) {
    const previous = this.fusionAccess || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      this.fusionHold = { app: spec.app, windowId: spec.windowId };
      const session = Object.create(this);
      session.fusionOwner = this;
      session.thinking = new Map();
      session.thinkingTried = new Map();
      session.keptThink = new Map();
      session.devinHist = new Map();
      session.thoughtFails = new Map();
      let editor, chat;
      try {
        editor = new Cdp(spec.ws);
        await editor.connect();
        chat = editor;
        if (spec.chatWs) {
          chat = new Cdp(spec.chatWs);
          await chat.connect();
        }
        session.cdp = chat;
        session.editorCdp = editor;
        session.app = spec.app;
        session.winTitle = spec.windowTitle;
        session.windowId = spec.windowId;
        session.codexPageId = spec.app === 'codex' ? spec.windowId : '';
        if (select && spec.app === 'cursor' && await session.cdp.evaluate(helpersCall('clickCloseSettings()'))) await new Promise(r => setTimeout(r, 100));
        if (select && spec.draft && await session.cdp.evaluate(helpersCall('activeThread()'))) {
          if (spec.app === 'codex') {
            session.emit = () => {};
            try { await session.newCodexChat(); } finally { delete session.emit; }
          } else await session.pressControl('newChat');
          await new Promise(r => setTimeout(r, 200));
          if (spec.app === 'cursor') await session.cdp.evaluate(helpersCall(`cursorSelectProject(${JSON.stringify(spec.project.root)}, ${JSON.stringify(spec.project.host || '')})`));
        }
        if (select && spec.agentId) {
          if (spec.app === 'codex') {
            if (await session.cdp.evaluate(helpersCall('codexThread()')) !== spec.agentId && !await session.selectCodexThread(spec.agentId)) throw new Error('没有找到选中的会话');
          } else if (spec.agentId.startsWith('tab:')) {
            const pos = await session.cdp.evaluate(helpersCall(`devinTabTarget(${JSON.stringify(spec.agentId.slice(4))})`));
            if (!pos) throw new Error('没有找到选中的会话');
            await session.tapCss(pos.x, pos.y);
          } else if (await session.cdp.evaluate(helpersCall('activeThread()')) !== spec.agentId) {
            const editorSurface = spec.app === 'devin' && await session.cdp.evaluate(helpersCall('devinSurface()')) === 'editor';
            if (editorSurface) await session.openSessionPicker();
            const pos = await session.cdp.evaluate(helpersCall(editorSurface ? `sessionPickerTarget(${JSON.stringify(spec.agentId)})` : `agentTarget(${JSON.stringify(spec.agentId)}, ${spec.app === 'cursor'})`));
            if (!pos) throw new Error('没有找到选中的会话');
            if (pos !== true) await session.tapCss(pos.x, pos.y);
          }
          let active = false;
          for (let i = 0; i < 12 && !active; i++) {
            await new Promise(r => setTimeout(r, 150));
            active = await session.cdp.evaluate(helpersCall(spec.agentId.startsWith('tab:') ? `devinSession()?.tabs?.some(t => t.active && t.id === ${JSON.stringify(spec.agentId.slice(4))})` : `activeThread() === ${JSON.stringify(spec.agentId)}`));
          }
          if (!active) throw new Error('会话切换没有生效');
          session.threadId = await session.cdp.evaluate(helpersCall('activeThread()'));
        }
        this.fusionHold = false;
        this.fusionConnection = session;
        return await fn.call(session);
      } finally {
        this.fusionConnection = null;
        this.fusionHold = false;
        for (const c of new Set([chat, editor])) c?.close();
      }
    });
    this.fusionAccess = operation;
    return operation;
  }

  async withFusionSide(side, fn) {
    const spec = side === 'b' ? this.fusionRun?.b : this.fusionRun?.a;
    if (!spec?.ws) throw new Error(side === 'b' ? '先选择 B' : '先选择 A');
    this.fusionSideLive = side === 'b' ? 'b' : 'a';
    try { return await this.withFusionSideSpec(spec, fn); }
    finally { this.fusionSideLive = ''; }
  }

  async fusionDraft() {
    return await this.cdp.evaluate(`(() => {
      const doc = document.getElementById('active-frame')?.contentDocument || document;
      const ed = [...doc.querySelectorAll('.ProseMirror[contenteditable="true"], .aislash-editor-input[contenteditable="true"], .ui-prompt-input-editor__input[contenteditable="true"], [role="textbox"][aria-label="Prompt"]')].find(e => e.getBoundingClientRect().height > 0);
      return (ed?.innerText || '').replace(/[\\u200b\\ufeff]/g, '').trim();
    })()`);
  }

  async fusionAsk(side, prompt) {
    return this.withFusionSide(side, async function () {
      const spec = this.fusionRun[side];
      await this.fusionCheckProject(this.fusionRun.project);
      await this.fusionEnsureModel(spec);
      const draft = await this.fusionDraft();
      if (draft) throw new Error('这一边的输入框里还有内容，Fusion 不会覆盖它');
      const before = await this.cdp.evaluate(helpersCall('extract()'));
      const beforeTurn = this.app === 'codex' ? await this.cdp.evaluate(helpersCall('codexFusionTurn()')) : null;
      const humanIds = new Set((before?.items || []).filter(it => it.k === 'human').map(it => it.i));
      const message = spec.resumeContext ? `以下为旧会话的历史摘录，仅作背景；执行目录为 ${this.fusionRun.project.root}，请以本次要求为准。\n${spec.resumeContext}\n\n${prompt}` : String(prompt);
      const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();
      await this.withFocus(async () => {
        const found = await this.cdp.evaluate(FOCUS_COMPOSER);
        if (!found) throw new Error('没找到这一边的输入框');
        await this.typeText(message);
        if (this.app === 'codex') {
          if (!await this.cdp.evaluate(helpersCall('submitCodexMessage()'))) throw new Error('这一边的发送按钮当前不可用');
        } else await this.key('Enter');
      });
      const deadline = Date.now() + 8 * 60 * 1000;
      let settled = '';
      let requestId = '';
      while (Date.now() < deadline) {
        if (this.fusionCancel) throw new Error('已停止');
        await new Promise(r => setTimeout(r, 1200));
        if (this.fusionCancel) throw new Error('已停止');
        const chat = await this.cdp.evaluate(helpersCall('extract()'));
        if (this.app !== 'codex' && before?.thread && chat?.thread !== before.thread) throw new Error('等待回复时会话发生变化');
        const spec = this.fusionRun[side];
        if (spec.draft && chat?.thread && chat.items?.some(it => it.k === 'human' && !humanIds.has(it.i) && normalize(it.t) === normalize(message))) {
          spec.agentId = chat.thread;
          spec.id = JSON.stringify([computerId(), this.app, spec.project?.host || '', chat.thread]);
          spec.draft = false;
          this.fusionOwner.fusionEmit();
        }
        spec.usage = { ...spec.usage, context: process.platform === 'win32' && this.app === 'codex'
          ? windowsCodexContext(chat.thread) : chat?.context ?? await this.cdp.evaluate(helpersCall('contextPct()')) };
        this.fusionOwner.fusionUsageEmit();
        let last;
        if (this.app === 'codex') {
          const turn = await this.cdp.evaluate(helpersCall(`codexFusionTurn(${JSON.stringify(requestId)}, ${JSON.stringify(message)}, ${JSON.stringify(beforeTurn?.ids || [])})`));
          if (!requestId && turn?.id) requestId = turn.id;
          last = requestId && turn?.id === requestId ? turn : { text: '' };
        } else {
          const human = [...(chat?.items || [])].reverse().find(it => it.k === 'human' && !humanIds.has(it.i) && normalize(it.t) === normalize(message));
          if (human) requestId = human.i;
          last = requestId ? fusionLastAssistant(chat, requestId) : { text: '' };
        }
        if (requestId) delete spec.resumeContext;
        let items = [];
        if (this.app === 'codex') items = last.items || [];
        else if (requestId) {
          const start = chat.items.findIndex(it => it.i === requestId) + 1;
          if (start) {
            items = chat.items.slice(start);
            const end = items.findIndex(it => it.k === 'human');
            if (end >= 0) items = items.slice(0, end);
            const current = { ...chat, items };
            this.fusionOwner.fusionProgress(side, items);
            if (this.app === 'devin') {
              const live = items.find(it => it.k === 'thinking' && it.live && !this.thinkingBody(it));
              if (live) {
                const body = await this.readThought(live.i);
                if (body) live.t = `${this.thinkingTitle(live)}\n${body}`;
              }
            } else {
              const ids = items.filter(it => it.k === 'thinking' && !this.thinkingBody(it)).map(it => it.i);
              const closed = ids.length ? await this.cdp.evaluate(`(() => { const h = (${pageHelpers.toString()})(); const wanted = ${JSON.stringify(ids)}.map(id => h.thoughtIndexFor(id)); return [...h.closedThinkingIndexes('live'), ...h.closedThinkingIndexes('done')].filter(i => wanted.includes(i)); })()` ) : [];
              if (closed.length) {
                await this.cdp.evaluate(helpersCall(`clickThinking(${JSON.stringify(closed)})`));
                await new Promise(r => setTimeout(r, 250));
                const expanded = await this.cdp.evaluate(helpersCall('extract()'));
                if (expanded?.thread === chat.thread) {
                  for (const it of items) {
                    const full = expanded.items?.find(x => x.i === it.i);
                    if (full) Object.assign(it, full);
                  }
                }
                await this.cdp.evaluate(helpersCall(`closeThinkingIfOpen(${JSON.stringify(closed)})`));
              }
            }
            await this.captureThoughts(current);
            this.fillThinking(current);
            this.rememberThinking(current);
            this.retainThinking(current);
            items = current.items;
          }
        }
        this.fusionOwner.fusionProgress(side, items);
        const ready = last.text && (this.app === 'codex' ? last.completed : !chat?.busy && last.completed !== false);
        if (ready && settled === last.text) {
          this.fusionOwner.fusionProgress(side, items, true);
          return last.text;
        }
        settled = ready ? last.text : '';
      }
      throw new Error(`等待 ${side.toUpperCase()} 本轮回复超时（阶段：${this.fusionRun.phase}）`);
    });
  }

  async fusionDiff(side) {
    const spec = side === 'b' ? this.fusionRun?.b : this.fusionRun?.a;
    const roots = windowRoots(spec?.windowTitle || '', spec?.app || 'cursor', spec?.workspace || '');
    const root = roots.find(r => !r.host)?.root || roots[0]?.root;
    if (!root) return '没有定位到工作区';
    try {
      let out = execFileSync('git', ['diff', 'HEAD', '--', '.'], { cwd: root, encoding: 'utf8', timeout: 8000 });
      const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', timeout: 8000 }).split('\0').filter(Boolean);
      for (const name of untracked) {
        if (out.length >= 10000) break;
        out += spawnSync('git', ['diff', '--no-index', '--', '/dev/null', name], { cwd: root, encoding: 'utf8', timeout: 8000 }).stdout || '';
      }
      return out.length > 10000 ? `${out.slice(0, 10000)}\n[差异未完整展示，请按方案检查实际文件]` : out.trim() || '没有未提交的差异';
    } catch {
      return '没有读到 git 差异';
    }
  }

  async fusionModelMenu(side) {
    const which = side === 'b' ? 'b' : 'a';
    await this.withFusionSide(which, async function () {
      await this.pressControl('model');
      let items = [];
      for (let i = 0; i < 12 && !items.length; i++) {
        await new Promise(r => setTimeout(r, 150));
        items = await this.cdp.evaluate(helpersCall(`menuItems('model')`)) || [];
        if (!items.length) await this.cdp.evaluate(helpersCall('clickModelListTrigger()'));
      }
      await this.closeMenus();
      this.emit({ t: 'menu', kind: `fusion-model-${which}`, items: items.map(it => ({ ...it, params: false })) });
    });
  }

  async fusionPickNativeModel(label, effort = false, targetEffort = '') {
    if (!effort) {
      await this.pressControl('model');
    }
    let pos = null;
    for (let i = 0; i < 10 && !pos; i++) {
      await new Promise(r => setTimeout(r, 150));
      pos = await this.cdp.evaluate(helpersCall(`menuItem('model', ${JSON.stringify(String(label))})`));
      if (!pos && !effort) await this.cdp.evaluate(helpersCall('clickModelListTrigger()'));
    }
    if (!pos) { await this.key('Escape'); throw new Error(`没找到模型：${label}`); }
    await this.tapCss(pos.x, pos.y);
    await new Promise(r => setTimeout(r, 400));
    const options = await this.cdp.evaluate(helpersCall("menuItems('model')"));
    if (!effort && this.app === 'codex' && options.some(it => /^(None|Minimal|Low|Light|Medium|High|Extra High|Max|Ultra|Persistent)$/.test(it.label))) {
      if (targetEffort) return this.fusionPickNativeModel(targetEffort, true);
      return options;
    }
    await this.closeMenus();
    return null;
  }

  async fusionEnsureModel(spec) {
    const wanted = spec.modelLabel ? spec : { ...spec, ...fusionModelSpec(spec.model) };
    const matches = model => {
      const actual = fusionModelSpec(model);
      return actual.modelLabel === wanted.modelLabel && (!wanted.modelEffort || actual.modelEffort === wanted.modelEffort);
    };
    let chat = await this.cdp.evaluate(helpersCall('extract()'));
    if (matches(chat?.model)) return;
    const options = await this.fusionPickNativeModel(wanted.modelLabel, false, wanted.modelEffort);
    if (options) { await this.closeMenus(); throw new Error('先选择该角色的推理强度'); }
    chat = await this.cdp.evaluate(helpersCall('extract()'));
    if (!matches(chat?.model)) throw new Error('模型切换没有生效');
  }

  async fusionModelPick(side, label, effort = false) {
    const which = side === 'b' ? 'b' : 'a';
    if (FUSION_ACTIVE.includes(this.fusionRun?.phase)) throw new Error('这一轮还在进行，先停止再换模型');
    let options;
    const spec = this.fusionRun[which];
    await this.withFusionSide(which, async function () {
      options = await this.fusionPickNativeModel(label, effort);
      const chat = await this.cdp.evaluate(helpersCall('extract()'));
      Object.assign(spec, fusionModelSpec(chat?.model || label));
      if (options) { spec.modelLabel = label; spec.modelEffort = ''; spec.model = ''; }
    });
    this.fusionEmit();
    if (options) this.emit({ t: 'menu', kind: `fusion-effort-${which}`, items: options });
    this.emit({ t: 'status', ok: true, msg: options ? '请选择推理强度' : `已切换到 ${label}` });
  }

  fusionStop() {
    if (!this.fusionWorkerKey) return this.fusionWorker().fusionStop();
    this.fusionCancel = true;
    if (this.fusionRun) this.fusionRun.phase = 'idle';
    const live = this.fusionSideLive;
    if (live && this.fusionConnection) this.fusionConnection.stopAgent().catch(() => {});
    this.fusionEmit();
    this.emit({ t: 'status', ok: true, msg: 'Fusion 已停止' });
  }

  fusionUserSend(text) {
    if (!this.fusionWorkerKey) return this.fusionWorker().fusionUserSend(text);
    const f = this.fusionRun;
    if (!f?.a || !f?.b) throw new Error('先选择 A 和 B');
    if (!f.project || f.a.project?.id !== f.project.id || f.b.project?.id !== f.project.id) throw new Error('先为同一项目选择 A 和 B');
    if (!f.a.model || !f.b.model) throw new Error('先选择 A 和 B 的模型');
    if (this.fusionJob) throw new Error('Fusion 正在进行');
    if (!['idle', 'done', 'stopped'].includes(f.phase)) throw new Error('这一轮还在进行。方案写好后点「执行方案」，或先停止');
    f.history = [...(f.history || []), ...this.fusionItems(f)];
    f.turn = (f.turn || 0) + 1;
    f.task = text;
    f.progress = [];
    f.plan = f.brief = f.echo = f.result = f.diff = f.review = '';
    f.round = 1;
    f.miss = 0;
    f.phase = 'planning';
    this.fusionCancel = false;
    this.fusionEmit();
    this.fusionJob = this.fusionPlan(text).catch(e => {
      if (this.fusionRun) this.fusionRun.phase = 'idle';
      this.fusionEmit();
      this.emit({ t: 'status', ok: false, msg: e.message });
    }).finally(() => { this.fusionFinishJob(); });
  }

  async fusionPlan(text) {
    const plan = await this.fusionAsk('a', `根据以下用户要求生成详细修改方案，暂不修改文件。\n方案包含：目标、允许修改的文件、不要动的范围、步骤、约束、可核对的完成标准（测试命令、函数行为或文件中必须出现的内容）。\n\n用户要求：\n${text}`);
    if (this.fusionCancel) return;
    this.fusionRun.plan = plan;
    this.fusionRun.brief = plan;
    this.fusionRun.phase = 'plan';
    this.fusionEmit();
    this.emit({ t: 'status', ok: true, msg: '方案已写好。确认后点「执行方案」' });
  }

  fusionGo() {
    if (!this.fusionWorkerKey) return this.fusionWorker().fusionGo();
    const f = this.fusionRun;
    if (!f || this.fusionJob) throw new Error('Fusion 正在进行');
    if (f.phase !== 'plan' && f.phase !== 'disagree') throw new Error('现在还不能交给 B');
    this.fusionCancel = false;
    this.fusionJob = this.fusionExecute().catch(e => {
      if (this.fusionRun) this.fusionRun.phase = 'idle';
      this.fusionEmit();
      this.emit({ t: 'status', ok: false, msg: e.message });
    }).finally(() => { this.fusionFinishJob(); });
  }

  async fusionExecute() {
    const f = this.fusionRun;
    if ((f.round || 1) > 4) {
      f.phase = 'stopped';
      this.fusionEmit();
      this.emit({ t: 'status', ok: false, msg: '已到 4 轮，Fusion 停止' });
      return;
    }
    f.phase = 'execute';
    this.fusionEmit();
    const baseline = await this.fusionDiff('b');
    f.result = await this.fusionAsk('b', `执行以下方案，先完成实际修改和验证，再返回结果；不要只复述准备做什么。遇到阻塞则明确说明。\n结果分三段：改了哪些文件、实际验证结果、哪里没完成或没把握。\n\n方案：\n${f.brief}`);
    if (this.fusionCancel) return;
    f.diff = await this.fusionDiff('b');
    f.phase = 'review';
    this.fusionEmit();
    f.review = await this.fusionAsk('a', `根据方案、实际执行结果和文件差异检查是否完成。执行前已有的改动不算本轮成果；不涉及文件修改的任务按实际验证结果判断。\n完成则最后一行写 FUSION: done\n只需你自己小改则最后一行写 FUSION: fix\n仍需修改则最后一行写 FUSION: return，前面给出后续执行说明，保留原方案范围和完成标准，已经做对的不要重做。\n\n方案：\n${f.brief}\n\n执行结果：\n${f.result}\n\n执行前差异：\n${baseline}\n\n执行后差异：\n${f.diff}`);
    if (this.fusionCancel) return;
    await this.fusionApply(fusionMark(f.review));
  }

  async fusionApply(mark) {
    const f = this.fusionRun;
    if (mark.kind === 'done') {
      f.phase = 'done';
      this.fusionEmit();
      this.emit({ t: 'status', ok: true, msg: 'Fusion 完成' });
      return;
    }
    if (mark.kind === 'fix') {
      f.phase = 'fix';
      this.fusionEmit();
      f.review = await this.fusionAsk('a', `按你刚决定的小修直接改文件，然后用完成标准复查。最后一行写 FUSION: done 或 FUSION: return。\n\n${mark.body || f.review}`);
      if (this.fusionCancel) return;
      const again = fusionMark(f.review);
      return this.fusionApply(again.kind === 'fix' ? { kind: '', body: again.body } : again);
    }
    if (mark.kind === 'return') {
      f.brief = mark.body || f.brief;
      f.round = (f.round || 1) + 1;
      return this.fusionExecute();
    }
    f.phase = 'check';
    this.fusionEmit();
    this.emit({ t: 'status', ok: false, msg: 'A 没有给出完成、小修或退回。请点下面的按钮' });
  }

  fusionDecide(kind) {
    if (!this.fusionWorkerKey) return this.fusionWorker().fusionDecide(kind);
    const f = this.fusionRun;
    if (!f || f.phase !== 'check') throw new Error('现在不需要选择');
    if (!['done', 'fix', 'return'].includes(kind)) throw new Error('没有这个决定');
    if (this.fusionJob) throw new Error('Fusion 正在进行');
    this.fusionCancel = false;
    this.fusionJob = this.fusionApply({ kind, body: f.review || f.brief }).catch(e => {
      this.emit({ t: 'status', ok: false, msg: e.message });
    }).finally(() => { this.fusionFinishJob(); });
  }

  async sendMessage(text, submit, when, mentions, receipt) {
    if (this.app === 'fusion') {
      const queued = await this.fusionUserSend(text);
      if (receipt) this.emit({ t: 'sent', ...receipt, sel: this.selectionKey() });
      return queued;
    }
    const files = [...uploads.values()].filter(f => f.pending && f.sel === this.selectionKey());
    if (files.length) text += '\n\n附加文件（请读取这些电脑端文件）：\n' + files.map(f => f.path).join('\n');
    const found = await this.cdp.evaluate(FOCUS_COMPOSER);
    if (!found) throw new Error(this.appMessage('没找到 {app} 的聊天输入框：先在画面里打开 Agent 面板（或点「打开聊天」）'));
    const draftCleared = await this.cdp.evaluate(helpersCall(`setComposerDraft('')`));
    for (let i = 0; !draftCleared && i < 2 && await this.cdp.evaluate(helpersCall('composerFocused()')) && await this.cdp.evaluate(helpersCall('composerDraft()')); i++) {
      await this.key(process.platform === 'darwin' ? 'Meta+A' : 'Ctrl+A');
      await this.key('Backspace');
    }
    const busy = submit && await this.cdp.evaluate(helpersCall('agentState()?.busy'));
    if (this.app === 'devin' && mentions?.length) await this.typeWithMentions(text, mentions);
    else if (this.app === 'codex' && mentions?.length) await this.typeWithCodexMentions(text, mentions);
    else await this.typeText(text);
    const now = this.app === 'devin' && when === 'now' && !!busy;
    let queued = Boolean(busy) && !now;
    if (submit) {
      if (this.app === 'codex') {
        const view = (await this.cdp.evaluate(helpersCall('codexFacts()')))?.view;
        const follow = view?.follow || 'queue';
        queued = !!busy && (when === 'queue' || (!when && follow === 'queue'));
        const opposite = !!busy && ((when === 'now' && follow !== 'steer') || (when === 'queue' && follow === 'steer'));
        if (opposite) {
          await this.cdp.evaluate(FOCUS_COMPOSER);
          await this.key((process.platform === 'darwin' ? 'Meta+' : 'Ctrl+') + (view?.enter === 'enter' ? '' : 'Shift+') + 'Enter');
        }
        else if (!await this.cdp.evaluate(helpersCall('submitCodexMessage()'))) throw new Error('Codex 发送按钮当前不可用');
        for (let i = 0; i < 12 && await this.cdp.evaluate(helpersCall('codexPromptText()')); i++) await new Promise(r => setTimeout(r, 100));
        if (await this.cdp.evaluate(helpersCall('codexPromptText()'))) throw new Error('Codex 未接受发送，草稿已保留');
        if (busy && !queued) this.emit({ t: 'status', ok: true, msg: '已追加到当前任务' });
      } else await this.key(now ? (process.platform === 'darwin' ? 'Meta+Enter' : 'Ctrl+Enter') : 'Enter');
    }
    if (submit) files.forEach(f => { f.pending = false; });
    if (submit && receipt) this.emit({ t: 'sent', ...receipt, sel: this.selectionKey() });
    await this.syncAttachments();
    if (now) this.emit({ t: 'status', ok: true, msg: '已打断当前任务并发送' });
    if (this.mode === 'chat') {
      this.lastChatAt = 0;
      setTimeout(() => this.pollChat(true).catch(() => {}), 300);
    }
    return queued;
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

  // ---- Devin working directory (Agent surface, before the first message) ----
  async openWorkdirChip(which) {
    const pos = await this.cdp.evaluate(helpersCall(`workdirTarget(${JSON.stringify(which)})`));
    if (!pos) throw new Error('现在没有可以更换的工作目录');
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
    await this.tapCss(pos.x, pos.y);
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 120));
      const rows = await this.cdp.evaluate(helpersCall(which === 'env' ? 'envRows()' : 'workdirRows()'));
      if (rows?.length) return rows;
    }
    return [];
  }

  async workdirInfoChecked() {
    const info = await this.cdp.evaluate(helpersCall('workdirInfo()'));
    if (!info) throw new Error('这里没有工作目录选项（要在 Agent 界面、新会话里）');
    if (!info.editable) throw new Error('这个会话已经开始了，工作目录只能在新会话发出第一条消息之前更换');
    return info;
  }

  async workdirList() {
    const info = await this.workdirInfoChecked();
    const rows = await this.openWorkdirChip('folder');
    await this.key('Escape');
    this.emit({ t: 'workdirs', info, rows: rows.filter(r => !r.browse).map(({ name, path }) => ({ name, path })) });
  }

  async workdirPick(name, dirPath, waitMs = 20000) {
    await this.workdirInfoChecked();
    const rows = await this.openWorkdirChip('folder');
    const hit = rows.find(r => r.name === name && r.path === dirPath) || rows.find(r => r.name === name);
    if (!hit) { await this.key('Escape'); throw new Error('这个文件夹已经不在列表里'); }
    await this.tapCss(hit.x, hit.y);
    // Devin switches the whole workspace: the chip reads "Switching workspace..." and the window reloads the
    // folder, which takes a few seconds (the page is gone for a moment, so evaluations may fail meanwhile).
    this.emit({ t: 'status', ok: true, msg: '正在切换工作区，Devin 会重新载入文件夹…' });
    let info = null;
    for (let i = 0; i < Math.ceil(waitMs / 250); i++) {
      await new Promise(r => setTimeout(r, 250));
      info = await this.cdp.evaluate(helpersCall('workdirInfo()')).catch(() => null);
      if (info?.name === name) break;
    }
    this.lastChat = '';
    this.emit({ t: 'status', ok: info?.name === name, msg: info?.name === name ? `工作目录：${name}` : '没有切换成功，请到电脑上看一下' });
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  }

  async envPick(label) {
    if (!['Local', 'Worktree', 'Cloud'].includes(label)) throw new Error('不支持的运行位置');
    await this.workdirInfoChecked();
    const rows = await this.openWorkdirChip('env');
    const hit = rows.find(r => r.label === label);
    if (!hit) { await this.key('Escape'); throw new Error('没找到这个选项'); }
    await this.tapCss(hit.x, hit.y);
    await new Promise(r => setTimeout(r, 500));
    this.emit({ t: 'status', ok: true, msg: `运行位置：${label}` });
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  }

  // Take a picture / file off the prompt again (the little x on its thumbnail on the desktop).
  async attachImage(data, name, type) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(type) || typeof data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(data)) throw new Error('只支持 PNG / JPEG / GIF / WebP 图片');
    const ok = await this.cdp.evaluate(pasteImage(data, String(name || 'image').replace(/[^\w.\-]/g, '_').slice(0, 60), type));
    if (ok === null) throw new Error(this.appMessage('没找到 {app} 的聊天输入框：先在画面里打开 Agent 面板（或点「打开聊天」）'));
    if (!ok) throw new Error(this.appMessage('{app} 没有接收这张图片（当前模型可能不支持图片）'));
    await this.syncAttachments();
    this.emit({ t: 'status', ok: true, msg: this.appMessage('图片已附加到 {app} 输入框，写好文字后点发送') });
  }

  async setDraft(text) {
    if (this.app === 'fusion' || text.length > 20000) return false;
    if (text === this.lastDraft) return true;
    if (this.cdp && await this.cdp.evaluate(helpersCall(`setComposerDraft(${JSON.stringify(text)})`))) { this.lastDraft = text; return true; }
    return false;
  }

  async syncAttachments() {
    const cdp = this.cdp, sel = this.sel;
    if (!cdp) return;
    const list = await cdp.evaluate(helpersCall('attachmentRows()'));
    if (!this.liveRead(cdp, sel)) return;
    list.push(...[...uploads.entries()].filter(([, f]) => f.pending && f.sel === this.selectionKey()).map(([id, f]) => ({ id, name: f.name, size: f.size })));
    const json = JSON.stringify(list);
    if (json === this.lastAttachments) return;
    this.lastAttachments = json;
    this.emit({ t: 'attachments', sel: this.selectionKey(), list });
  }

  async removeAttachment(id) {
    const file = uploads.get(id);
    if (file?.pending && file.sel === this.selectionKey()) {
      fs.rmSync(path.dirname(file.path), { recursive: true });
      uploads.delete(id);
    } else {
      const point = await this.cdp.evaluate(helpersCall(`attachmentPoint(${JSON.stringify(id)})`));
      if (point) {
        await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
        await new Promise(r => setTimeout(r, 120));
      }
      const removed = await this.cdp.evaluate(helpersCall(`removeAttachment(${JSON.stringify(id)})`));
      if (!removed) throw new Error('附件已不在当前输入框中');
      for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 100));
        const list = await this.cdp.evaluate(helpersCall('attachmentRows()'));
        if (!list.some(f => f.id === id)) break;
        if (i === 7) throw new Error('附件没有删除成功');
      }
    }
    await this.syncAttachments();
  }

  async handle(msg) {
    if (msg.t === 'saveFile') return this.saveFile(String(msg.path ?? ''), String(msg.text ?? ''), msg.host == null ? undefined : String(msg.host));
    if (msg.t === 'connAgents') {
      const agents = [];
      try { await listWindows(agents); } catch {}
      readAllPlans(this).catch(() => {});
      return this.emit({ t: 'connAgents', agents });
    }
    if (msg.t === 'windows') return this.emit({ t: 'windows', list: phoneWindows(await listWindows(), this.targetId), current: this.targetId, plans: appPlans });
    if (msg.t === 'attach') return this.attach(msg);
    if (msg.t === 'agents' && this.app === 'codex') return this.listAgents(msg.silent === true, msg.automatic === true);
    if (msg.t === 'mode') return this.setMode(msg.mode);
    if (msg.t === 'visible') {
      this.visible = Boolean(msg.v);
      if (!this.editorCdp) return;
      if (!this.visible && this.mode === 'screen') return this.editorCdp.send('Page.stopScreencast');
      if (this.visible) return this.setMode(this.mode);
      return;
    }
    if (msg.t === 'lang') { updateDevice(this.deviceId, { lang: msg.v === 'en' ? 'en' : 'zh' }); return; }
    if (msg.t === 'draft') {
      const text = String(msg.text ?? '');
      let ok = false;
      try { ok = await this.setDraft(text); } catch {}
      return this.emit({ t: 'draftAck', sel: this.selectionKey(), ok, text });
    }
    const readOnly = ['refresh', 'attachments', 'thought'].includes(msg.t)
      || (msg.t === 'agents' && msg.silent === true) || (msg.t === 'usage' && msg.automatic === true);
    return readOnly ? this.dispatch(msg) : this.withFocus(() => this.dispatch(msg));
  }

  async dispatch(msg) {
    const fusionFree = this.app === 'fusion' && (['fusionTrust', 'fusionContinue', 'fusionProjects', 'fusionProject', 'fusionSides', 'fusionSide', 'fusionNewSide', 'fusionHistory', 'fusionOpen', 'fusionNew', 'fusionUsage', 'fusionModel', 'fusionGo', 'fusionDecide', 'send', 'usage', 'refresh', 'attachments', 'quality', 'appTheme'].includes(msg.t) || (msg.t === 'pickMenu' && /^fusion-(model|effort)-/.test(String(msg.kind || ''))));
    if (fusionFree) {
      if (msg.t === 'refresh') return this.fusionEmit();
    } else if (!this.cdp) throw new Error(this.appMessage('尚未连接到 {app} 窗口'));
    switch (msg.t) {
      case 'openMenu': return this.openMenu(msg.kind, msg.requestId);
      case 'pickMenu': return this.pickMenu(msg.kind, msg.label, msg.name);
      case 'fusionOptions': return this.fusionOptions(String(msg.part ?? ''));
      case 'fusionPick': return this.fusionPick(String(msg.part ?? ''), msg.value);
      case 'toggleMax': return this.toggleMax();
      case 'params': return this.showParams(String(msg.model ?? ''), String(msg.label ?? ''));
      case 'pickParam': return this.pickParam(String(msg.model ?? ''), String(msg.label ?? ''), msg.section, msg.value);
      case 'agents': return this.listAgents(msg.silent === true, msg.automatic === true);
      case 'openAgent': return this.openAgent(String(msg.id ?? ''), String(msg.title ?? ''));
      case 'terminals': return this.listTerminals();
      case 'openTerminal': return this.openTerminal(String(msg.id ?? ''));
      case 'closeTerminal': return this.closeTerminal(String(msg.id ?? ''));
      case 'newTerminal': return this.newTerminal();
      case 'termSend': return this.sendTerminal(String(msg.text ?? ''));
      case 'projects': return this.showProjects(String(msg.path ?? ''));
      case 'docs': return this.showDocs(String(msg.root ?? ''), String(msg.path ?? ''), String(msg.host ?? ''), msg.editor === true);
      case 'openProject': return this.useProject(String(msg.path ?? ''), msg.newSession === true);
      case 'newProject': return this.newProject(String(msg.parent ?? ''), String(msg.name ?? '').trim(), msg.newSession === true);
      case 'projectTrust': return this.confirmProjectTrust(msg.approve === true);
      case 'codexSetting':
        if (this.app !== 'codex') return;
        return this.showCodexSettings(String(msg.id || ''), msg.requestId);
      case 'closeCodexSettings': return this.closeCodexSettings();
      case 'settings': return this.showSettings(msg.requestId);
      case 'toggleSetting': return this.toggleSetting(String(msg.label ?? ''));
      case 'usage': return this.showUsage(msg.automatic === true);
      case 'fusionProjects': return this.fusionListProjects(msg.path);
      case 'fusionProject': return this.fusionSetProject(String(msg.id || ''), String(msg.path || ''));
      case 'fusionHistory': return this.fusionListHistory();
      case 'fusionOpen': return this.fusionOpenHistory(String(msg.id || ''));
      case 'fusionNew': return this.fusionOpenHistory('');
      case 'fusionUsage': return this.fusionUsage(msg.automatic === true, msg.side === 'b' ? 'b' : 'a');
      case 'fusionSides': return this.fusionListSides(msg.side);
      case 'fusionSide': return this.fusionSetSide(msg.side, String(msg.id || ''));
      case 'fusionTrust': return this.fusionConfirmTrust(msg.approve === true);
      case 'fusionContinue': return this.fusionContinue(msg.side, String(msg.id || ''));
      case 'fusionNewSide': return this.fusionNewSide(msg.side, String(msg.app || ''));
      case 'fusionModel': return this.fusionModelMenu(msg.side);
      case 'fusionGo': return this.fusionGo();
      case 'fusionDecide': return this.fusionDecide(msg.kind);
      case 'newChat': return this.newProjectChat();
      case 'newProjectChat': return this.newProjectChat();
      case 'surface': return this.setSurface(String(msg.to ?? ''));
      case 'openEditorChat': return this.openEditorChat();
      case 'closeTab': return this.closeTab(String(msg.id ?? ''));
      case 'file': return this.openFile(String(msg.path ?? ''), String(msg.diff ?? ''));
      case 'click': return this.clickButton(msg.item, msg.n, msg.actionId, msg.label, msg.sel);
      case 'queue':
        if (msg.action === 'clear' && this.app === 'devin') return this.devinClearQueue();
        if (msg.action === 'edit' && this.app === 'devin') return this.devinTakeOut(msg.id);
        return msg.action === 'edit' ? this.editQueued(msg.id, String(msg.text ?? '')) : this.queueAction(msg.id, msg.action);
      case 'stop': return this.stopAgent();
      case 'subagent': return this.subagentAction(msg.name, msg.part === 'stop' ? 'stop' : 'open');
      case 'mainChat': return this.backToMain();
      case 'image': return this.attachImage(msg.data, msg.name, msg.type);
      case 'attachments': return this.syncAttachments();
      case 'removeAttachment': return this.removeAttachment(String(msg.id));
      case 'question': return this.answerQuestion(msg.qi, msg.oi, ['option', 'submit', 'skip', 'prev', 'next'].includes(msg.part) ? msg.part : 'option', msg.text);
      case 'workdir': return this.workdirList();
      case 'workdirPick': return this.workdirPick(String(msg.name ?? '').slice(0, 200), String(msg.path ?? '').slice(0, 400));
      case 'envPick': return this.envPick(String(msg.label ?? ''));
      case 'changes': return this.listChanges();
      case 'thought': return this.thought(String(msg.i ?? ''));
      case 'revert': return this.revert(String(msg.i ?? ''));
      case 'revertOk': return this.revertAnswer(true, typeof msg.apply === 'boolean' ? msg.apply : undefined);
      case 'revertCancel': return this.revertAnswer(false);
      case 'change': return this.changeAction(msg.i, msg.name, msg.act);
      case 'scrollChat': {
        if (!msg.history) return this.scrollChat(Number(msg.dy) || 0, msg.automatic === true);
        const sel = this.selectionKey();
        try {
          const result = await this.scrollChat(Number(msg.dy) || 0, msg.automatic === true, true);
          this.emit({ t: 'historyDone', sel, requestId: msg.requestId, ...result });
        } catch (e) {
          this.emit({ t: 'historyDone', sel, requestId: msg.requestId, error: e.message });
        }
        return;
      }
      case 'appTheme': this.dark = msg.dark !== false; this._theme = null; return;
      case 'tap': return this.tap(msg.x, msg.y, msg.button);
      case 'wheel': return this.wheel(msg.x, msg.y, msg.dx || 0, msg.dy || 0);
      case 'key': return this.key(String(msg.key || ''), { focusTerminal: msg.focus === 'terminal', cdp: this.mode === 'chat' ? this.cdp : this.editorCdp });
      case 'type': return this.typeText(String(msg.text ?? ''), this.mode === 'chat' ? this.cdp : this.editorCdp);
      case 'send': return this.sendMessage(String(msg.text ?? ''), msg.submit !== false, msg.when, cleanMentions(msg.mentions), { requestId: msg.requestId, draft: msg.draft, text: msg.text });
      case 'mentionQuery': return this.mentionQuery(String(msg.q ?? '').slice(0, 80), msg.cat ? String(msg.cat).slice(0, 40) : '', Number(msg.seq) || 0, msg.trigger === '/' ? '/' : '@');
      case 'codexRequest': {
        if (this.app !== 'codex') return;
        if (msg.field != null) {
          if (!await this.cdp.evaluate(helpersCall(`codexRequestField(${JSON.stringify(String(msg.id))}, ${Number(msg.field)}, ${JSON.stringify(String(msg.value || ''))})`))) throw new Error('请求输入框已不存在');
        } else {
          const acted = await this.cdp.evaluate(helpersCall(`codexRequestAction(${JSON.stringify(String(msg.id))}, ${Number(msg.n)})`));
          if (!acted) {
            const pos = await this.cdp.evaluate(helpersCall(`codexRequestTarget(${JSON.stringify(String(msg.id))}, ${Number(msg.n)})`));
            if (!pos) throw new Error('请求已经处理或不存在');
            await this.tapCss(pos.x, pos.y);
          }
        }
        setTimeout(() => this.pollChat().catch(() => {}), 300);
        return;
      }
      case 'codexPick': return this.codexPick(msg);
      case 'codexSkills': return this.codexSkillList();
      case 'codexPlan': return this.codexTogglePlan();
      case 'codexIde': return this.codexToggleIde();
      case 'codexRun': return this.codexRunMenu();
      case 'codexChat': return this.codexChatMenu();
      case 'codexArchive': return this.codexArchiveThread(String(msg.id || ''));
      case 'refresh': return this.snapshot(true);
      case 'quality':
        if (!this.editorCdp) return;
        this.screencast.quality = Math.min(this.mode === 'terminal' ? 95 : 90, Math.max(20, Number(msg.quality) || 60));
        this.screencast.maxWidth = Math.min(this.mode === 'terminal' ? 4096 : 2560, Math.max(480, Number(msg.maxWidth) || 1280));
        if (this.mode !== 'screen') return;
        await this.editorCdp.send('Page.stopScreencast');
        return this.startScreencast();
      default: throw new Error(`未知指令: ${msg.t}`);
    }
  }

  dispose() {
    fusionViewers.delete(this);
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

// Mention tokens from the phone: short strings only, at most a dozen.
const cleanMentions = list => (Array.isArray(list) ? list : []).slice(0, 12)
  .map(m => ({
    token: String(m?.token ?? '').slice(0, 200), q: String(m?.q ?? '').slice(0, 200),
    label: String(m?.label ?? '').slice(0, 200), sub: String(m?.sub ?? '').slice(0, 200),
    key: String(m?.key ?? '').slice(0, 240), section: String(m?.section ?? '').slice(0, 40),
    trigger: m?.trigger === '/' ? '/' : '@',
  }))
  .filter(m => m.token && m.label);

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

async function actOnWindow(deviceId, { win, threadId, act, index, text, question }) {
  const wins = await listWindows();
  const w = wins.find(x => x.id === String(win));
  if (!w || w.app !== 'devin') throw new Error('找不到这个窗口，或它不支持通知里的操作');
  const s = new Session({ readyState: 3, send() {} }, deviceId);
  clearInterval(s.idleTimer);
  try {
    s.cdp = new Cdp(w.ws);
    await s.cdp.connect();
    s.app = w.app;
    s.targetId = w.id;
    s.windowId = w.id;
    s.editorCdp = s.cdp;
    s.threadId = await s.cdp.evaluate(helpersCall('activeThread()'));
    if (!threadId || s.threadId !== threadId) throw new Error('通知对应的会话已切换，请打开该会话后操作');
    if (question && question !== (await s.cdp.evaluate(helpersCall('agentState()')))?.waiting) throw new Error('通知中的问题已变更，请查看最新问题');
    const reply = String(text ?? '').trim().slice(0, 3000);
    if (act === 'opt') await s.answerQuestion(0, Math.max(0, Number(index) || 0), 'option');
    else if (act === 'reply') {
      if (!reply) throw new Error('回复内容为空');
      await s.sendMessage(reply, true);
    } else if (act === 'acceptAll') await s.changeAction(0, 'Accept all', 'bar');
    else throw new Error('不支持的操作');
  } finally {
    s.dispose();
  }
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

  if (route === '/api/upload' && req.method === 'POST') {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const name = path.basename(query.get('name') || '');
    if (!/\.(pdf|doc|docx|xlsx|pptx|txt|md|csv|json|py|js|ts|tsx|jsx|sh|yaml|yml|toml|ini|log|xml|html|css|c|cpp|h|rs|go)$/i.test(name)) return json(req, res, 400, { error: '目前支持文档、表格、文本和代码文件' });
    const id = crypto.randomUUID();
    const dir = path.join(DATA_DIR, 'uploads', id);
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 20 * 1024 * 1024) throw new Error('文件不能超过 20 MB');
        chunks.push(chunk);
      }
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, name);
      fs.writeFileSync(filePath, Buffer.concat(chunks));
      uploads.set(id, { name, size, path: filePath, sel: query.get('sel') || '', deviceId: device.id, pending: true });
      return json(req, res, 200, { id, name, size });
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      return json(req, res, 400, { error: error.message });
    }
  }

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

  // The Android app holds this open with POST: quick tunnels buffer GET event streams.
  if (route === '/api/events') return openEventStream(req, res, device.id);
  // Actions from an Android notification (reply / pick an option / accept the changes), run on that window.
  if (route === '/api/act' && req.method === 'POST') {
    const body = await readJson(req);
    try {
      await actOnWindow(device.id, body);
      return json(req, res, 200, { ok: true });
    } catch (e) {
      return json(req, res, 409, { error: e.message });
    }
  }
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

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 4 << 20,
  perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 6 } },
});

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
    if (msg.t === 'stop' && session.app === 'fusion') { session.fusionStop(); return; }
    if (msg.t === 'usage' && session.app === 'codex') return session.showUsage(msg.automatic === true);
    queue = queue.then(async () => {
      const q0 = Date.now();
      try {
        const queued = await session.handle(msg);
        const ms = Date.now() - q0;
        if (ms > 3000) console.log(`[slow] ${msg.t} ${ms}ms ${session.app || ''}`);
        if (msg.t === 'termSend') session.emit({ t: 'sent', requestId: msg.requestId, draft: msg.draft, text: msg.text, sel: session.selectionKey() });
        if (msg.t === 'termSend') session.emit({ t: 'status', ok: true, msg: '已发送' });
        if (msg.t === 'type') session.emit({ t: 'status', ok: true, msg: '已发送' });
        if (msg.t === 'queue' && msg.action === 'edit') session.emit({ t: 'status', ok: true, msg: '已修改，仍在排队' });
        if (msg.t === 'send') session.emit({ t: 'status', ok: true, msg: queued ? 'Agent 正在运行，已加入排队，这一轮结束后自动发送' : '已发送' });
      } catch (e) {
        console.log(`[err] ${msg.t}: ${e.message}`);
        if (msg.t === 'send' || msg.t === 'termSend') session.emit({ t: 'sendFailed', requestId: msg.requestId });
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

// A terminal opened before GitHub CLI was installed does not have it on PATH; on Windows look in its usual folders.
let ghPathCache = null;
function ghCmd() {
  if (ghPathCache) return ghPathCache;
  ghPathCache = 'gh';
  if (spawnSync('gh', ['--version'], { stdio: 'ignore' }).error && process.platform === 'win32') {
    const dirs = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
    const hit = dirs.map(d => path.join(d, 'GitHub CLI', 'gh.exe')).find(p => fs.existsSync(p));
    if (hit) ghPathCache = hit;
  }
  return ghPathCache;
}

function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd === 'gh' ? ghCmd() : cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
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
    if (process.platform === 'win32') {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process -Filter \"Name = 'cloudflared.exe'\" | Select-Object ProcessId, CommandLine) -Compress"], { encoding: 'utf8', windowsHide: true });
      for (const item of JSON.parse(out)) {
        if (new RegExp(`127\\.0\\.0\\.1:${PORT}\\b`).test(item.CommandLine)) return item.ProcessId;
      }
      return 0;
    }
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

// Notifications follow each real Codex chat, not the single merged Codex entry.
async function watchTargets() {
  const wins = await listWindows();
  const out = wins.filter(w => w.app !== 'codex');
  for (const p of await codexWindows(CODEX_CDP_URL)) {
    if (!p.chatWs) continue;
    out.push({ id: `codex:${p.pageId}`, title: p.title, ws: p.chatWs, app: 'codex', pageId: p.pageId, kind: 'local' });
  }
  return out;
}

server.listen(PORT, TUNNEL ? '127.0.0.1' : HOST, async () => {
  console.log(`Remote Agent 已启动，端口 ${PORT}`);
  console.log(`数据目录：${DATA_DIR}`);
  console.log(`已配对 ${listDevices().length} 台设备。添加新设备：npm run pair`);
  detectAppUrl();
  startWatcher({
    listWindows: watchTargets,
    openCdp: async ws => { const c = new Cdp(ws); await c.connect(); return c; },
    probe: helpersCall('agentStates()'),
  });
  try {
    const wins = await listWindows();
    console.log(`已连上 ${wins.length} 个窗口：${wins.map(w => `${w.app}:${w.title}`).join(' | ')}`);
  } catch (e) {
    console.log(`!! ${e.message}`);
  }
  // Warm the file-viewer caches (theme discovery + shiki) after startup so the
  // phone's first file open doesn't pay the one-time scan/init cost.
  setTimeout(() => {
    warmHighlighter();
    for (const e of EDITORS) {
      const port = Number(new URL(e.url || CDP_URL).port);
      themeFor(e.app, { port }).catch(() => {});
    }
  }, 2000);
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
