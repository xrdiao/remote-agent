import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { workspaces, windowRoots, workspaceLabel, fileSize, readFile, parseRef, listProject, locateWritable, writeTextFile, resolveLocal } from '../lib/files.mjs';
import { themeFor } from '../lib/theme.mjs';
import { highlightText } from '../lib/highlight.mjs';
import { gitMarks, agentMarks, parseGitDiff } from '../lib/marks.mjs';
import { saveState, readState, computerId, updateDevice } from '../lib/auth.mjs';
import { IS_WIN, IS_MAC, mod, normPath, pathKey, findBin } from '../lib/platform.mjs';
import { Cdp, MOD, NAMED_KEYS } from './cdp.mjs';
import { listWindows, phoneWindows, codexWindows, codexContext, codexFolder } from './windows.mjs';
import { CDP_URL, DEVIN_CDP_URL, CODEX_CDP_URL, EDITORS } from './config.mjs';
import { PAGE_SRC, helpersCall } from './page/build.mjs';

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
  root = normPath(root);
  const key = pathKey(root, !host);
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

export const uploads = new Map();
export const codexUsage = { data: null, refresh: null, retryAt: 0, failures: 0 };
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

function safeHomePath(input) {
  const home = fs.realpathSync(os.homedir());
  const target = input ? path.resolve(String(input)) : home;
  let real;
  try { real = fs.realpathSync(target); }
  catch { throw new Error('找不到这个文件夹'); }
  // Windows intentionally allows any drive — projects are not limited to the home dir.
  if (!IS_WIN && real !== home && !real.startsWith(home + path.sep)) throw new Error('只能打开家目录里的文件夹');
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
    parent: (IS_WIN ? real === path.dirname(real) : real === home) ? null : path.dirname(real),
    drives: IS_WIN ? [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(letter => `${letter}:\\`).filter(root => fs.existsSync(root)) : [],
    dirs: names.map(name => ({ name, path: path.join(real, name) })),
  };
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
  const port = new URL(app === 'devin' ? DEVIN_CDP_URL : app === 'codex' ? CODEX_CDP_URL : CDP_URL).port;
  const bin = findBin(app, port);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VSCODE_IPC_HOOK_CLI;
  const launcher = path.join(path.dirname(bin), ...(app === 'cursor' ? ['resources', 'app', 'bin', 'cursor.cmd'] : ['bin', app === 'devin' ? 'devin-desktop.cmd' : 'code.cmd']));
  const command = IS_WIN ? 'powershell.exe' : bin;
  const args = IS_WIN
    ? ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; & '${launcher.replace(/'/g, "''")}' -r '${real.replace(/'/g, "''")}'; exit $LASTEXITCODE`]
    : ['-r', real];
  const child = spawn(command, args, { env, detached: true, stdio: IS_WIN ? ['ignore', 'ignore', 'pipe'] : 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    if (IS_WIN) {
      let error = '';
      child.stderr.on('data', chunk => { error += chunk; });
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(error.trim() || `打开项目失败（退出码 ${code}）`)));
    } else child.once('spawn', resolve);
  });
  child.unref();
  return real;
}

export class Session {
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
      if (this.app === 'codex') chat.context = codexContext(chat.thread);
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
    try { context = this.app === 'codex'
      ? codexContext(await this.cdp.evaluate(helpersCall('codexThread()')))
      : await this.cdp.evaluate(helpersCall('contextPct()')); }
    catch { context = undefined; }
    if (context !== undefined && cdp === this.cdp && this.liveRead(cdp, sel)) this.emit({ t: 'usage', sel: this.selectionKey(), context });
    if (!this.liveRead(cdp, sel)) return;
    try {
      const account = this.app === 'codex' ? await this.readCodexAccount(request)
        : this.app === 'devin' ? await this.cdp.evaluate(helpersCall('readDevinUsage(true)'))
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
      if (!cursorUsage.initial) cursorUsage.initial = this.withFocus(() => this.readCursorUsage(false))
        .finally(() => { cursorUsage.initial = null; });
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
    const title = IS_WIN ? await this.editorCdp.evaluate('document.title') : this.winTitle || '';
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
          emit({ ...(await listProject(ws.root, ws.root, editor)), host: '' });
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
      emit({ ...(await listProject(ws.root, dir || ws.root, editor)), host: '' });
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
      await this.key(mod('Shift+p'), { cdp: this.editorCdp });
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
    await this.key(mod('A'));
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
      await this.key(IS_MAC ? 'Ctrl+c' : 'Ctrl+Alt+c');
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
      const windows = IS_WIN ? (await listWindows()).filter(w => w.app === 'devin') : [];
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
    await this.key(mod('l'), { cdp: this.editorCdp });
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
    if (IS_WIN && this.app === 'devin' && id.startsWith('window:devin:')) {
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
        const model = this.app === 'devin' && fusion ? 'Fusion' : (await this.cdp.evaluate(helpersCall('extract()')))?.model;
        if (this.sel === sel) this.emit({ t: 'menu', kind, items, fast, fusion, model, requestId, sel: this.selectionKey() });
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
    const native = await this.cdp.evaluate(`(() => { const h = ${PAGE_SRC}; if (!h.fusionConfig()?.lead) return null; return h.devinVariants(${JSON.stringify(part)}).map(({ label, checked }) => ({ label, checked })); })()`);
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
    const picked = await this.cdp.evaluate(`(() => { const h = ${PAGE_SRC}; if (!h.fusionConfig()) return false; const rows = h.devinVariants(${JSON.stringify(part)}); const row = rows.find(x => ${part === 'fast' ? '!x.checked' : `x.label === ${JSON.stringify(String(value))}`}); if (!row) return false; h.devinPickerProps().onModelSelect(row.config); return true; })()`);
    if (picked) {
      const role = part === 'lead' || part === 'sidekick';
      if (role) await this.waitFor(`fusionConfig()?.[${JSON.stringify(part)}] === ${JSON.stringify(String(value))}`);
      else await this.pollChat();
      await this.openMenu('model');
      if (role) {
        this.lastChatAt = 0;
        this.pollChat().catch(() => {});
      }
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
    await this.key(mod('p'), { cdp: this.editorCdp });
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
    // Devin has no quick-open; resolve purely on disk (absolute, root-relative, basename search).
    if (this.app === 'devin') {
      for (const root of roots.length ? roots : [null]) {
        try { return await resolveLocal(root, text); } catch (e) { if (root === roots.at(-1) || !root) throw e; }
      }
    }
    const isAbs = /^(\/|~\/|[a-zA-Z]:[\\/])/.test(p);
    const tried = [];
    const tryPath = async abs => {
      if (tried.includes(abs)) return null;
      tried.push(abs);
      const size = await fileSize(abs);
      return size == null ? null : { host: null, path: abs, size, line };
    };
    if (isAbs) {
      const hit = await tryPath(p);
      if (hit) return hit;
    } else if (roots.length) {
      for (const root of roots) {
        const hit = await tryPath(path.posix.join(root.root, p));
        if (hit) return hit;
      }
    }
    if (this.winTitle === 'Cursor Agents') {
      // The Agents window mixes projects, so try recently opened folders.
      for (const w of workspaces().filter(w => !w.host).slice(0, 8)) {
        const hit = await tryPath(isAbs ? p : path.posix.join(w.root, p));
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
      const hit = await tryPath(h.abs);
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
    const normalized = p => path.posix.normalize(pathKey(p));
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
      const body = await readFile(f.path, f.size);
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
      const loc = locateWritable(filePath);
      if (!loc) throw new Error('只能修改已打开过的项目里的文件');
      const size = await writeTextFile(loc.path, text);
      this.emit({ t: 'saved', ok: true, path: filePath, host: '', size });
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
      if (!picked) throw new Error('没有找到 Codex 窗口。请用 ./scripts/start-codex.sh 启动，并打开 Codex 侧边栏');
      const entry = wins.find(w => w.id === 'codex');
      if (!entry) throw new Error('没有找到 Codex 窗口。请用 ./scripts/start-codex.sh 启动，并打开 Codex 侧边栏');
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
    if (!chosen) throw new Error('没有找到 Cursor、Devin 或 Codex 窗口。Cursor 用调试端口 9222，Devin 用 ./scripts/start-devin.sh，Codex 用 ./scripts/start-codex.sh');
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
      await this.key(mod('A'));
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
          ? spec.app === 'codex' ? codexContext(active) : await this.cdp.evaluate(helpersCall('contextPct()'))
          : spec.usage?.context;
        try {
          const account = spec.app === 'codex' ? await this.readCodexAccount({ manual: !automatic, fusion: true })
            : spec.app === 'devin' ? await this.cdp.evaluate(helpersCall('readDevinUsage(true)')) : await this.withFocus(() => this.readCursorUsage(automatic));
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
                await this.key(mod('Shift+p'), { cdp: this.editorCdp });
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
        spec.usage = { ...spec.usage, context: this.app === 'codex'
          ? codexContext(chat.thread) : chat?.context ?? await this.cdp.evaluate(helpersCall('contextPct()')) };
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
              const closed = ids.length ? await this.cdp.evaluate(`(() => { const h = ${PAGE_SRC}; const wanted = ${JSON.stringify(ids)}.map(id => h.thoughtIndexFor(id)); return [...h.closedThinkingIndexes('live'), ...h.closedThinkingIndexes('done')].filter(i => wanted.includes(i)); })()` ) : [];
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
      const git = findBin('git');
      let out = execFileSync(git, ['diff', 'HEAD', '--', '.'], { cwd: root, encoding: 'utf8', timeout: 8000 });
      const untracked = execFileSync(git, ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', timeout: 8000 }).split('\0').filter(Boolean);
      for (const name of untracked) {
        if (out.length >= 10000) break;
        out += spawnSync(git, ['diff', '--no-index', '--', '/dev/null', name], { cwd: root, encoding: 'utf8', timeout: 8000 }).stdout || '';
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
      await this.key(mod('A'));
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
          await this.key(mod((view?.enter === 'enter' ? '' : 'Shift+') + 'Enter'));
        }
        else if (!await this.cdp.evaluate(helpersCall('submitCodexMessage()'))) throw new Error('Codex 发送按钮当前不可用');
        for (let i = 0; i < 12 && await this.cdp.evaluate(helpersCall('codexPromptText()')); i++) await new Promise(r => setTimeout(r, 100));
        if (await this.cdp.evaluate(helpersCall('codexPromptText()'))) throw new Error('Codex 未接受发送，草稿已保留');
        if (busy && !queued) this.emit({ t: 'status', ok: true, msg: '已追加到当前任务' });
      } else await this.key(now ? mod('Enter') : 'Enter');
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

// Mention tokens from the phone: short strings only, at most a dozen.
const cleanMentions = list => (Array.isArray(list) ? list : []).slice(0, 12)
  .map(m => ({
    token: String(m?.token ?? '').slice(0, 200), q: String(m?.q ?? '').slice(0, 200),
    label: String(m?.label ?? '').slice(0, 200), sub: String(m?.sub ?? '').slice(0, 200),
    key: String(m?.key ?? '').slice(0, 240), section: String(m?.section ?? '').slice(0, 40),
    trigger: m?.trigger === '/' ? '/' : '@',
  }))
  .filter(m => m.token && m.label);
