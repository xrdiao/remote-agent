import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { workspaces, windowRoots, workspaceLabel, fileSize, readFile, parseRef, listProject, locateWritable, writeTextFile, resolveLocal } from '../../lib/files.mjs';
import { videoUrl } from '../http/video.mjs';
import { themeFor } from '../../lib/theme.mjs';
import { highlightText } from '../../lib/highlight.mjs';
import { gitMarks, agentMarks, parseGitDiff, lastCommitMarks } from '../../lib/marks.mjs';
import { saveState, computerId } from '../../lib/auth.mjs';
import { IS_WIN, IS_MAC, mod, normPath, pathKey, findBin } from '../../lib/platform.mjs';
import { Cdp, MOD, NAMED_KEYS } from '../cdp.mjs';
import { listWindows, codexWindows, codexContext, codexFolder } from '../windows.mjs';
import { CDP_URL, DEVIN_CDP_URL, CODEX_CDP_URL, EDITORS } from '../config.mjs';
import { PAGE_SRC, helpersCall } from '../page/build.mjs';
import { conversationProjects, fusionCursorProjects, fusionModelSpec, fusionProject } from '../fusion/state.mjs';

// Cursor's chat composer is a ProseMirror contenteditable; selectors ordered from most to least specific.
export const FOCUS_COMPOSER = `(() => {
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
export const cursorUsage = { data: null, initial: null };
export const appPlans = {};


const tapPoint = async (cdp, x, y) => {
  const base = { x, y, button: 'left', clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
};

export function safeHomePath(input) {
  const home = fs.realpathSync(os.homedir());
  const target = input ? path.resolve(String(input)) : home;
  let real;
  try { real = fs.realpathSync(target); }
  catch { throw new Error('找不到这个文件夹'); }
  // Windows intentionally allows any drive — projects are not limited to the home dir.
  if (!IS_WIN && real !== home && !real.startsWith(home + path.sep)) throw new Error('只能打开家目录里的文件夹');
  return { home, real };
}

export function projectList(dir) {
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

export async function openFolder(folder, app, newWindow = false) {
  const { real } = safeHomePath(folder);
  const port = new URL(app === 'devin' ? DEVIN_CDP_URL : app === 'codex' ? CODEX_CDP_URL : CDP_URL).port;
  const bin = findBin(app, port);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VSCODE_IPC_HOOK_CLI;
  const launcher = path.join(path.dirname(bin), ...(app === 'cursor' ? ['resources', 'app', 'bin', 'cursor.cmd'] : ['bin', app === 'devin' ? 'devin-desktop.cmd' : 'code.cmd']));
  const command = IS_WIN ? 'powershell.exe' : bin;
  const mode = newWindow ? '-n' : '-r';
  const args = IS_WIN
    ? ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; & '${launcher.replace(/'/g, "''")}' ${mode} '${real.replace(/'/g, "''")}'; exit $LASTEXITCODE`]
    : [mode, real];
  const child = spawn(command, args, { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    let error = '';
    child.stderr.on('data', chunk => { error += chunk; });
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(error.trim() || `打开项目失败（退出码 ${code}）`)));
  });
  child.unref();
  return real;
}


export class AgentContext {
  constructor({ deviceId = '', emit } = {}) {
    this.deviceId = deviceId;
    if (emit) this.emit = emit;
    this.cdp = null;
    this.editorCdp = null;
    this.lastChat = '';
    this.lastExtractedChat = '';
    this.pollAgain = null;
    this.resetCaches();
    this.curSession = undefined;
    this.app = null;
    this.sel = 0;
    this.windowId = '';
    this.threadId = '';
    this.pendingThread = '';
    this.codexPageId = '';
    this.lastPanel = '';
    this.lastBusy = null;
    this.lastTermHash = undefined;
    this.focusCount = 0;
    this.focusTimer = null;
  }

  emit() {}

  resetCaches() {
    this.thinking = new Map();
    this.thinkingTried = new Map();
    this.tasksTried = new Map();
    this.devinHist = new Map();
    this.thoughtFails = new Map();
    this.keptThink = new Map();
    this.itemCache = new Map();
    this.thinkLiveSeen = new Set();
    this.thinkFinal = new Set();
  }


  appMessage(template) {
    if (this.app === 'fusion') return template.replaceAll('{app}', 'Fusion');
    const name = EDITORS.find(ed => ed.app === this.app)?.name || '当前应用';
    return template.replaceAll('{app}', name);
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
    this.lastExtractedChat = '';
    this.pollAgain = null;
    this.lastAttachments = null;
    this.latestThink = null;
    this.thinkTries = new Map();
    this.thinking = new Map();
    this.thinkingTried = new Map();
    this.keptThink = new Map();
    this.itemCache = new Map();
    this.thinkLiveSeen = new Set();
    this.thinkFinal = new Set();
    this.pendingThread = '';
    this.polling = null;
    this.lastDraft = undefined;
  }

  liveRead(cdp, sel) {
    return cdp && cdp === this.cdp && sel === this.sel && !this.switchingThread;
  }

  async pollChat(immediate = false) {
    const cdp = this.cdp;
    const sel = this.sel;
    const sendGen = this.sendGen || 0;
    if (!cdp || !this.visible || this.switchingThread || this.historyLoading || (this.fusionHold?.app === this.app && this.fusionHold?.windowId === this.windowId) || (!immediate && Date.now() - (this.lastChatAt || 0) < (this.lastBusy ? 650 : 1800))) return;
    if (this.polling === sel) { if (immediate) this.pollAgain = sel; return; }
    this.lastChatAt = Date.now();
    this.polling = sel;
    const freshView = this.codexFreshView === true;
    this.codexFreshView = false;
    try {
      let chat = await cdp.evaluate(helpersCall('extract()'));
      const before = this.app === 'codex' && !freshView && !chat?.busy ? await cdp.evaluate(helpersCall("scrollCodexHistory('latest')")) : null;
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
      const extracted = chat && JSON.stringify({ ...chat, draft: undefined });
      if (chat && chat.thread === (this.threadId || '') && (this.app !== 'codex' || chat.thread) && (!this.lastChat || extracted !== this.lastExtractedChat)) {
        this.lastExtractedChat = extracted;
        const initial = { ...chat, items: chat.items.map(it => ({ ...it })) };
        delete initial.draft;
        if (this.app === 'codex') for (const it of initial.items.filter(it => it.images?.length)) {
          const old = this.itemCache?.get(chat.thread)?.find(x => x.i === it.i);
          it.images = it.images.map((src, n) => old?.imageSources?.[n] === src ? old.images[n] : src);
        }
        if (this.app === 'codex') initial.context = codexContext(chat.thread);
        this.fillThinking(initial);
        this.retainThinking(initial);
        this.mergeDevinHistory(initial);
        this.lastChat = JSON.stringify(initial);
        this.emit({ t: 'chat', sel: this.selectionKey(), chat: initial });
      }
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
        if (this.app === 'devin') this.devinGeneration(chat);
        const json = JSON.stringify(chat);
        if (json !== this.lastChat && this.liveRead(cdp, sel)) {
          this.lastChat = json;
          this.emit({ t: 'chat', sel: this.selectionKey(), chat });
        }
      }
      // A draft read before or during a send is the text being sent; pushing it would refill the phone's box.
      if (draft !== undefined && draft !== this.lastDraft && !this.sending && (this.sendGen || 0) === sendGen && this.liveRead(cdp, sel)) {
        this.lastDraft = draft;
        this.emit({ t: 'draft', sel: this.selectionKey(), text: draft, draftEpoch: this.draftEpoch || '' });
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
      if (this.app === 'devin') this.devinGeneration(chat);
      const json = JSON.stringify(chat);
      if (!this.liveRead(cdp, sel) || this.historyLoading) return;
      if (json !== this.lastChat) {
        this.lastChat = json;
        this.emit({ t: 'chat', sel: this.selectionKey(), chat });
      }
      this.syncAttachments().catch(() => {});
    } finally {
      if (this.polling === sel) {
        this.polling = null;
        if (this.pollAgain === sel) {
          this.pollAgain = null;
          this.pollChat(true).catch(() => {});
        }
      }
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
    } else {
      await this.adapter.newTerminal.call(this);
    }
    this.emit({ t: 'status', ok: true, msg: '已新建终端' });
    setTimeout(() => this.pollTerminal().catch(() => {}), 500);
  }

  async focusTerminal() {
    if (!await this.editorCdp.evaluate(helpersCall('focusTerminalInput()'))) throw new Error('没有可输入的终端，请先打开终端');
  }

  async sendTerminal(text) {
    await this.focusTerminal();
    const before = await this.editorCdp.evaluate(helpersCall('terminalHistory()'));
    const input = before.input ?? await this.editorCdp.evaluate(helpersCall('terminalCommand()'));
    if (input) {
      await this.editorCdp.evaluate(helpersCall('clearTerminalInput()'));
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 20));
        const remaining = before.input === null
          ? await this.editorCdp.evaluate(helpersCall('terminalCommand()'))
          : (await this.editorCdp.evaluate(helpersCall('terminalHistory()'))).input;
        if (remaining === '') break;
        if (i === 9) throw new Error('终端原有输入未清空，尚未发送');
      }
    }
    const lines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await this.editorCdp.send('Input.insertText', { text: lines[i] });
      if (i < lines.length - 1 || lines[i]) await this.key('Enter', { cdp: this.editorCdp });
    }
  }

  async ensureSettings(editorCdp = this.editorCdp) {
    const waitOpen = () => editorCdp.evaluate(helpersCall("waitSettings('open')"));
    if (await editorCdp.evaluate(helpersCall('settingsOpen()'))) return;
    // Click the gear directly. A coordinate click on the 24px footer button often misses.
    if (await editorCdp.evaluate(helpersCall('clickSettingsButton()')) && await waitOpen()) return;
    // Cursor and Devin both bind Settings to Ctrl+Comma.
    const comma = { key: ',', code: 'Comma', windowsVirtualKeyCode: 188, modifiers: 2 };
    await editorCdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...comma });
    await editorCdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...comma });
    if (await waitOpen()) return;
    throw new Error('设置没有打开');
  }

  async closeSettings(editorCdp = this.editorCdp) {
    const how = await editorCdp.evaluate(helpersCall('clickCloseSettings()'));
    if (how === 'tab') await this.key('Ctrl+w', { cdp: editorCdp });
  }

  async showSettings(requestId = 0, section = '') {
    return this.adapter.showSettings.call(this, requestId, section);
  }

  async closeDesktopSettings() {
    const owned = this.desktopSettingsOwned;
    this.desktopSettingsOwned = undefined;
    this.desktopSettingsSection = '';
    if (owned && this.editorCdp) await this.closeSettings();
  }

  async toggleSetting(label, value) {
    await this.ensureSettings();
    const args = `${JSON.stringify(this.desktopSettingsSection || '')}, ${JSON.stringify(this.app)}`;
    const before = JSON.stringify(await this.editorCdp.evaluate(helpersCall(`desktopSettingsData(${args})`)));
    if (typeof value === 'string') await this.editorCdp.evaluate(helpersCall(`desktopSettingValue(${JSON.stringify(label)}, ${JSON.stringify(value)})`));
    else {
      const pos = await this.editorCdp.evaluate(helpersCall(`settingTarget(${JSON.stringify(label)})`));
      if (!pos) throw new Error('找不到这项设置');
      await this.tapCss(pos.x, pos.y, 'left', this.editorCdp);
    }
    const data = await this.editorCdp.evaluate(`(async()=>{const read=()=>${helpersCall(`desktopSettingsData(${args})`)};const start=Date.now();let data;do{data=read();if(JSON.stringify(data)!==${JSON.stringify(before)})return data;await new Promise(r=>setTimeout(r,30))}while(Date.now()-start<1200);return data})()`);
    this.emit({ t:'settings', ...data });
    this.emit({ t:'status', ok:true, msg:'已更新设置' });
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
    try { context = await this.adapter.usageContext.call(this); }
    catch { context = undefined; }
    if (context !== undefined && cdp === this.cdp && this.liveRead(cdp, sel)) this.emit({ t: 'usage', sel: this.selectionKey(), context });
    if (!this.liveRead(cdp, sel)) return;
    try {
      const account = await this.adapter.accountUsage.call(this, request, automatic);
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
    return this.adapter.currentRoots.call(this);
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

  async useProject(folder, newSession = false, threadId = '') {
    const { real } = safeHomePath(folder);
    const app = this.app;
    const editor = EDITORS.find(e => e.app === app);
    let projectPages = [];
    const findTarget = async () => {
      const pages = await (await fetch(`${editor.url}/json/list`)).json();
      projectPages = pages.filter(p => p.type === 'page' && /workbench/.test(p.url));
      return projectPages.find(p =>
        windowRoots(p.title, app).some(w => !w.host && fusionProject(w.root)?.id === fusionProject(real)?.id));
    };
    let target = await findTarget();
    if (!target) {
      let busy = this.cdp ? !!(await this.cdp.evaluate(helpersCall('extract()')))?.busy : false;
      // Cursor's CLI can reuse a different window or encounter a background Agent.
      if (app === 'cursor' && !busy) {
        for (const page of projectPages) {
          const cdp = new Cdp(page.webSocketDebuggerUrl);
          await cdp.connect();
          try { busy = !!await cdp.evaluate(helpersCall('agentState().busy || agentList().some(a => a.running)')); }
          finally { cdp.close(); }
          if (busy) break;
        }
      }
      if (!busy && this.editorCdp) await this.editorCdp.send('Page.bringToFront');
      await openFolder(real, app, busy || ((app === 'codex' || app === 'devin') && !!threadId));
      for (let i = 0; i < 40 && !target; i++) {
        target = await findTarget();
        if (!target) await new Promise(r => setTimeout(r, 250));
      }
    }
    if (!target) throw new Error('应用尚未打开所选项目，请检查电脑上的窗口');
    if (app === 'codex') {
      let pages = await codexWindows(CODEX_CDP_URL);
      if (!pages.find(p => p.pageId === target.id)?.chatWs) {
        const editorCdp = new Cdp(target.webSocketDebuggerUrl);
        await editorCdp.connect();
        try {
          await this.key(mod('Shift+p'), { cdp: editorCdp });
          await editorCdp.send('Input.insertText', { text: 'Codex: Open Codex Sidebar' });
          await this.key('Enter', { cdp: editorCdp });
        } finally { editorCdp.close(); }
        for (let i = 0; i < 40 && !pages.find(p => p.pageId === target.id)?.chatWs; i++) {
          await new Promise(r => setTimeout(r, 150));
          pages = await codexWindows(CODEX_CDP_URL);
        }
        if (!pages.find(p => p.pageId === target.id)?.chatWs) throw new Error('项目已打开，但 Codex 侧边栏尚未就绪');
      }
    }
    await this.attach({ id: `${app}:${target.id}` });
    if (app === 'codex' && (newSession || threadId)) {
      let ready = false;
      for (let i = 0; i < 120 && !ready; i++) {
        ready = !!await this.cdp.evaluate(helpersCall('codexNewPoint()'));
        if (!ready) await new Promise(r => setTimeout(r, 250));
      }
      if (!ready) throw new Error('项目已打开，但 Codex 会话入口尚未就绪');
    }
    this.pendingProject = { root: real, app, windowId: this.windowId, newSession, threadId };
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
    if (this.app === 'codex' && this.cdp === this.editorCdp) return this.useProject(root.root, true);
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
    if (this.app === 'codex' && pending.threadId) {
      if (!await this.selectCodexThread(pending.threadId)) throw new Error('项目已打开，但没有找到所选会话');
      await this.adoptCodexThread(pending.threadId, '已切换项目与会话');
    }
    if (this.app === 'devin' && pending.threadId) await this.adapter.openAgent.call(this, pending.threadId);
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
    return this.adapter.editQueued.call(this, id, text);
  }

  async queueAction(id, action) {
    if (!['send', 'remove', 'edit'].includes(action)) throw new Error('不支持的排队操作');
    return this.adapter.queueAction.call(this, id, action);
  }


  // Opens Cursor's changed-files list if needed, runs fn, then puts the list back the way it was.
  // Devin: the rows are readable while the list is folded (display:none), so reading does not toggle it.
  // Rows can mount late, so wait for as many as the bar counts. Actions open the list, then fold it again.
  async withFiles(fn, opts) {
    return this.adapter.withFiles.call(this, fn, opts);
  }

  async listChanges() {
    return this.adapter.listChanges.call(this);
  }

  async changeAction(i, name, act) {
    return this.adapter.changeAction.call(this, i, name, act);
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

  projectName() {
    if (this.app === 'codex') return codexFolder(this.winTitle);
    if (this.app === 'devin') return path.posix.basename(normPath(windowRoots(this.winTitle, 'devin')[0]?.root || ''));
    return '';
  }

  publishThread(statusMsg) {
    const msg = {
      t: 'attached', id: this.targetId, title: this.app === 'codex' ? 'Codex' : this.winTitle, app: this.app, appName: this.appMessage('{app}'),
      project: this.projectName(), windowId: this.windowId || '', threadId: this.threadId || '', sel: this.selectionKey(), keepQuota: true,
    };
    this.emit(msg);
    this.emit({ t: 'thread', windowId: msg.windowId, threadId: msg.threadId, sel: msg.sel });
    if (statusMsg) this.emit({ t: 'status', ok: true, msg: statusMsg });
  }

  async listAgents(silent = false, readOnly = false, projectWindow = '') {
    const cdp = this.cdp, sel = this.sel, app = this.app;
    const grouped = app === 'cursor' || app === 'devin';
    if (grouped) {
      this.projectAgentWindows ||= new Map();
      this.projectAgentCache ||= new Map();
      if (!readOnly || !this.projectAgentWindows.has(app)) {
        const windows = (await listWindows(null, app)).filter(w => w.app === app);
        for (const w of windows) w.project = windowRoots(w.title, app)[0];
        if (!this.liveRead(cdp, sel)) return;
        this.projectAgentWindows.set(app, windows);
        if (!readOnly) for (const w of windows) if (w.id !== this.targetId) this.projectAgentCache.delete(w.id);
      }
      if (projectWindow) {
        const w = this.projectAgentWindows.get(app).find(w => w.id === projectWindow);
        if (!w || w.id === this.targetId) return;
        const probe = new Cdp(w.ws);
        try {
          await probe.connect();
          const data = await probe.evaluate(`(() => {
            const h = ${PAGE_SRC};
            const surface = h.devinSurface();
            const state = surface === 'editor' ? h.agentState() : null;
            const list = surface === 'editor' ? (h.devinSession()?.tabs || []).map(t => ({ id: 'tab:' + t.id, title: t.title, current: t.active, running: t.active && !!state?.busy })) : h.agentList();
            return { list, surface };
          })()`);
          if (!this.liveRead(cdp, sel)) return;
          this.projectAgentCache.set(w.id, data);
        } finally { probe.close(); }
        return this.emit({ t: 'agents', app, silent: true, list: this.projectAgentRows() });
      }
    }
    const emit = data => {
      if (!this.liveRead(cdp, sel)) return;
      if (grouped) {
        if (data.partial) {
          const remaining = (this.projectAgentCache.get(this.targetId)?.list || []).filter(a => a.id.startsWith('pick:'));
          data = { ...data, list: [...data.list, ...remaining.filter(a => !data.list.some(b => b.title === a.title))] };
        }
        this.projectAgentCache.set(this.targetId, data);
      }
      this.emit({ t: 'agents', app, silent, ...data, list: grouped ? this.projectAgentRows() : data.list || [] });
    };
    return this.adapter.listAgents.call(this, silent, readOnly, emit);
  }

  projectAgentRows() {
    const list = [], seen = new Set();
    const windows = this.projectAgentWindows.get(this.app) || [];
    const addNew = (w, label, key, root = '') => {
      if (seen.has('new:' + key)) return;
      seen.add('new:' + key);
      list.push({ id: `project-new:${encodeURIComponent(w.id)}${root ? ':' + encodeURIComponent(root) : ''}`, title: '＋ 新建会话', window: label, group: '', ui: true });
    };
    // Prefer the attached window when several windows show the same project/session.
    for (const w of [...windows].sort((a, b) => Number(b.id === this.targetId) - Number(a.id === this.targetId))) {
      const current = w.id === this.targetId;
      const data = this.projectAgentCache.get(w.id);
      const project = w.project;
      const label = project ? path.posix.basename(normPath(project.root)) : w.title;
      const projectKey = project ? `${project.host || ''}|${normPath(project.root)}` : w.id;
      if (project || !data?.list?.length || data.list.some(row => !row.workspace)) addNew(w, label, projectKey);
      for (const row of data?.list || []) {
        const rowProject = `${row.host || project?.host || ''}|${normPath(row.workspace || project?.root || w.id)}`;
        const rowLabel = row.workspace ? path.posix.basename(normPath(row.workspace)) : label;
        if (row.workspace && (row.workspace === project?.root || (!row.host && !project?.host))) addNew(w, rowLabel, rowProject, row.workspace !== project?.root && !row.host && !project?.host ? row.workspace : '');
        const key = `${rowProject}|${this.app === 'devin' ? row.id.replace(/^tab:/, '') : row.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push({ ...row, id: current ? row.id : `project:${encodeURIComponent(w.id)}:${encodeURIComponent(row.id)}`,
          window: rowLabel, group: '', current: current && !!row.current });
      }
      if (!data) list.push({ id: `window:${w.id}`, title: '加载会话', window: label, group: '', ui: true, loadWindow: w.id });
      else if (!data.list?.length || (!current && data.surface === 'editor')) list.push({ id: `window:${w.id}`, title: data.surface === 'editor' ? '进入项目查看全部会话' : '进入项目', window: label, group: '', ui: true });
    }
    return list;
  }

  async openAgent(id, title = '') {
    if ((this.app === 'cursor' || this.app === 'devin') && (id.startsWith('project:') || id.startsWith('project-new:'))) {
      const [kind, encodedWindow, encodedThread] = id.split(':');
      const window = decodeURIComponent(encodedWindow);
      if (!window.startsWith(this.app + ':')) throw new Error('项目不属于当前 Agent');
      if (kind === 'project-new' && encodedThread) await this.useProject(decodeURIComponent(encodedThread), true);
      else {
        if (window !== this.targetId) await this.attach(window);
        if (kind === 'project-new') await this.newChat();
        else await this.adapter.openAgent.call(this, decodeURIComponent(encodedThread), title);
      }
      await this.listAgents(true);
      return;
    }
    if (id.startsWith(`window:${this.app}:`)) {
      await this.attach(id.slice('window:'.length));
      await this.listAgents(true);
      return;
    }
    return this.adapter.openAgent.call(this, id, title);
  }

  async newChat() {
    return this.adapter.newChat.call(this);
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
      let items = await this.cdp.evaluate(helpersCall('effortItems(true)'));
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
      const pricing = this.app === 'devin' ? await this.cdp.evaluate(helpersCall('devinPricing()')) : null;
      if (this.sel === sel) this.emit({ t: 'menu', kind, items, fast, pricing, model: chat?.model, requestId, sel: this.selectionKey() });
      return;
    }
    if (kind === 'model') {
      // Prop-driven lists (Codex options, Devin visibleModelConfigs) need no visible menu.
      const [items, fast, fusion] = await Promise.all([
        this.cdp.evaluate(helpersCall('modelItemsFast()')),
        this.cdp.evaluate(helpersCall('fastInfo()')),
        this.cdp.evaluate(helpersCall('fusionConfig(true)')),
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
      fusion = await this.cdp.evaluate(helpersCall('fusionConfig(true)'));
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

  async syncFast(on) {
    const result = await this.cdp.evaluate(`(async () => {
      const h = ${PAGE_SRC};
      const deadline = performance.now() + 1200;
      do {
        const fast = h.fastInfo();
        if (fast?.on === ${on}) {
          const fusion = h.fusionConfig(true);
          return { fast, fusion, ...(${this.app === 'devin'} && !fusion ? { effort: { items: h.effortItems(true), pricing: h.devinPricing() } } : {}) };
        }
        await new Promise(resolve => setTimeout(resolve, 30));
      } while (performance.now() < deadline);
      return null;
    })()`);
    if (!result) throw new Error('Fast 模式未同步到电脑，请重试');
    const { effort, ...state } = result;
    if (state.fusion) this.fusion = state.fusion;
    this.emit({ t: 'fastState', sel: this.selectionKey(), ...state });
    if (effort) this.emit({ t: 'menu', kind: 'effort', ...effort, sel: this.selectionKey() });
  }

  async pickMenu(kind, label, name) {
    if (kind === 'fast') {
      const on = label === 'on';
      if (!await this.cdp.evaluate(helpersCall(`pickFast(${on})`))) {
        let pos = await this.cdp.evaluate(helpersCall('fastTarget()'));
        if (!pos) {
          await this.pressControl('model');
          pos = await this.cdp.evaluate(helpersCall('fastTarget()')) || await this.waitFor('fastTarget()');
        }
        if (!pos) { await this.closeMenus(); throw new Error('当前模型不支持 Fast'); }
        const current = await this.cdp.evaluate(helpersCall('fastInfo()'));
        if (current.on !== on) await this.cdp.evaluate(helpersCall('clickCursorFast()'));
      }
      try { await this.syncFast(on); }
      finally { await this.closeMenus(); }
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
    if (kind === 'model' && await this.adapter.pickModelMenu.call(this, label)) return;
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
          const rows = await cdp.evaluate(helpersCall('historyRows()'));
          await cdp.evaluate(helpersCall(`scrollCodexHistory(${top})`));
          await cdp.evaluate(helpersCall(`waitHistoryRows(${JSON.stringify(rows)}, 150)`));
        }
        if (!this.liveRead(cdp, sel)) return;
        const point = before && await cdp.evaluate(helpersCall('scrollCodexHistory()'));
        if (point) {
          const rows = await cdp.evaluate(helpersCall('historyRows()'));
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: dy });
          await cdp.evaluate(helpersCall(`waitHistoryRows(${JSON.stringify(rows)})`));
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
    const rows = history ? await this.cdp.evaluate(helpersCall('historyRows()')) : null;
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: x + w / 2, y: y + h / 2, deltaX: 0, deltaY: dy });
    if (history) {
      await this.cdp.evaluate(helpersCall(`waitHistoryRows(${JSON.stringify(rows)})`));
      this.lastChatAt = 0;
      await this.pollChat(true);
      const earlier = this.lastChat ? JSON.parse(this.lastChat).earlier : undefined;
      return { earlier: earlier === undefined ? !(await this.cdp.evaluate(helpersCall('historyAtStart()'))) : earlier };
    }
    setTimeout(() => this.pollChat().catch(() => {}), 400);
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
    // Image references can be bare filenames; reuse the workspace lookup before editor search.
    if (this.app === 'devin' || /\.(?:png|jpe?g|gif|webp|svg|bmp)$/i.test(p)) {
      for (const root of roots.length ? roots : [null]) {
        try { return await resolveLocal(root, text); } catch (e) { if (this.app === 'devin' && (root === roots.at(-1) || !root)) throw e; }
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

  async fileMarks(f, text, reviewDiff = '', fromChanges = false) {
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
    const agent = await this.adapter.fileAgentMarks.call(this, f, text, changes, diff);
    if (agent) return agent;
    if (git?.newFile) return { marks: { add: [], mod: [], del: [] }, markSource: 'git', newFile: true };
    // Devin's review panel still lists files whose changes were already committed; fall back
    // to the last commit touching the file (only for opens from the changes sheet).
    if (fromChanges) {
      const last = await lastCommitMarks(f.path).catch(() => null);
      if (last?.newFile) return { marks: { add: [], mod: [], del: [] }, markSource: 'commit', newFile: true, commit: last.commit, subject: last.subject };
      if (last) return { marks: { add: last.add, mod: last.mod, del: last.del }, markSource: 'commit', commit: last.commit, subject: last.subject };
    }
    return null;
  }

  async openFile(text, reviewDiff = '', fromChanges = false) {
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
      if (/\.mp4$/i.test(f.path) && !f.host) {
        this.emit({ t: 'file', name: path.basename(f.path), path: f.path, size: f.size, video: videoUrl(f.path, this.deviceId) });
        return;
      }
      const body = await readFile(f.path, f.size);
      let hl = null;
      if (body.text) {
        const theme = await this.fileTheme();
        hl = await highlightText(body.text, f.path, theme).catch(() => null);
      }
      this.emit({ t: 'file', name: path.posix.basename(f.path), path: f.path, host: f.host, size: f.size, line: f.line, editable: body.text != null && !body.truncated, ...body, ...(hl ? { hl } : {}) });
      // Gutter marks come afterwards — the git calls shouldn't hold the first paint.
      if (body.text) {
        this.fileMarks(f, body.text, reviewDiff, fromChanges).then(marked => {
          if (marked?.marks || marked?.newFile || marked?.diff) this.emit({ t: 'fileMarks', path: f.path, host: f.host, ...(marked?.marks ? { marks: marked.marks, markSource: marked.markSource } : {}), ...(marked?.newFile ? { newFile: true } : {}), ...(marked?.diff ? { diff: marked.diff } : {}), ...(marked?.commit ? { commit: marked.commit, subject: marked.subject } : {}) });
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
          for (const c of connections) c.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
        }, 1500);
      }
    }
  }

  async tapCss(x, y, button = 'left', cdp = this.cdp) {
    const base = { x, y, button, clickCount: 1 };
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
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


  // Phone typed "@q" (or tapped a category): list what Devin offers, then put the prompt back.
  async mentionQuery(q, cat, seq, trigger) {
    return this.adapter.mentionQuery.call(this, q, cat, seq, trigger);
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

  async fusionDraft() {
    return await this.cdp.evaluate(`(() => {
      const doc = document.getElementById('active-frame')?.contentDocument || document;
      const ed = [...doc.querySelectorAll('.ProseMirror[contenteditable="true"], .aislash-editor-input[contenteditable="true"], .ui-prompt-input-editor__input[contenteditable="true"], [role="textbox"][aria-label="Prompt"]')].find(e => e.getBoundingClientRect().height > 0);
      return (ed?.innerText || '').replace(/[\\u200b\\ufeff]/g, '').trim();
    })()`);
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

  async sendMessage(text, submit, when, mentions, receipt) {
    if (submit && receipt) this.draftEpoch = receipt.draftEpoch || '';
    if (this.app === 'fusion') {
      const queued = await this.fusionUserSend(text);
      if (receipt) this.emit({ t: 'sent', ...receipt, queued, sentAt: Date.now(), sel: this.selectionKey() });
      return queued;
    }
    const files = [...uploads.values()].filter(f => f.pending && f.sel === this.selectionKey());
    if (files.length) text += '\n\n附加文件（请读取这些电脑端文件）：\n' + files.map(f => f.path).join('\n');
    this.sendGen = (this.sendGen || 0) + 1;
    this.sending = true;
    let busy, now, queued;
    try {
      const found = await this.cdp.evaluate(FOCUS_COMPOSER);
      if (!found) throw new Error(this.appMessage('没找到 {app} 的聊天输入框：先在画面里打开 Agent 面板（或点「打开聊天」）'));
      // Read busy before typing: once the composer has text, apps replace the stop button with a send button and isBusy() reads false.
      busy = submit && await this.cdp.evaluate(helpersCall('agentState()?.busy'));
      const sameDraft = !mentions?.length && await this.cdp.evaluate(helpersCall('composerDraft()')) === text;
      if (!sameDraft) {
        const draftCleared = await this.cdp.evaluate(helpersCall(`setComposerDraft('')`));
        for (let i = 0; !draftCleared && i < 2 && await this.cdp.evaluate(helpersCall('composerFocused()')) && await this.cdp.evaluate(helpersCall('composerDraft()')); i++) {
          await this.key(mod('A'));
          await this.key('Backspace');
        }
        await this.adapter.typeDraft.call(this, text, mentions);
      }
      now = this.app === 'devin' && when === 'now' && !!busy;
      queued = Boolean(busy) && !now;
      if (submit) queued = await this.adapter.submitPrompt.call(this, now, busy, when, queued);
    } finally {
      this.sending = false;
      this.sendGen++;
    }
    if (submit) {
      files.forEach(f => { f.pending = false; });
      this.lastDraft = text;
    }
    if (submit && receipt) this.emit({ t: 'sent', ...receipt, queued, sentAt: Date.now(), sel: this.selectionKey() });
    if (this.mode === 'chat') {
      this.lastChatAt = 0;
      this.pollChat(true).catch(() => {});
    }
    this.syncAttachments().catch(() => {});
    if (now) this.emit({ t: 'status', ok: true, msg: '已打断当前任务并发送' });
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


  // Take a picture / file off the prompt again (the little x on its thumbnail on the desktop).
  async attachImage(data, name, type, replace = '', sel, transfer) {
    if (transfer?.cancelled) return;
    if (sel && sel !== this.selectionKey()) throw new Error('会话已切换，请回到原会话编辑图片');
    const before = await this.cdp.evaluate(helpersCall('attachmentRows()'));
    if (replace && !before.some(f => f.id === replace)) throw new Error('原图片已不在输入框中');
    if (!/^image\/(png|jpeg|gif|webp)$/.test(type) || typeof data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(data)) throw new Error('只支持 PNG / JPEG / GIF / WebP 图片');
    if (transfer?.cancelled) return;
    const ok = await this.cdp.evaluate(pasteImage(data, String(name || 'image').replace(/[^\w.\-]/g, '_').slice(0, 60), type));
    if (transfer?.cancelled && !ok) return;
    if (ok === null) throw new Error(this.appMessage('没找到 {app} 的聊天输入框：先在画面里打开 Agent 面板（或点「打开聊天」）'));
    if (!ok) throw new Error(this.appMessage('{app} 没有接收这张图片（当前模型可能不支持图片）'));
    const attached = await this.cdp.evaluate(helpersCall('attachmentRows(true)'));
    const added = attached.find(f => !before.some(old => old.id === f.id));
    if (transfer?.cancelled) {
      if (added) await this.removeAttachment(added.id);
      return;
    }
    if (replace) await this.removeAttachment(replace);
    await this.syncAttachments();
    if (transfer?.cancelled) {
      if (added) await this.removeAttachment(added.id);
      return;
    }
    this.emit({ t: 'status', ok: true, msg: this.appMessage('图片已附加到 {app} 输入框，写好文字后点发送') });
    const matches = JSON.parse(this.lastAttachments).filter(f => f.preview && f.preview === added?.preview);
    return matches.length === 1 ? matches[0].id : undefined;
  }

  async editAttachmentImage(id, scope) {
    if (scope !== this.selectionKey()) throw new Error('会话已切换，请重新选择图片');
    const cdp = this.cdp, sel = this.sel;
    const image = await cdp.evaluate(helpersCall(`attachmentImage(${JSON.stringify(id)})`));
    if (this.liveRead(cdp, sel)) this.emit({ t: 'imageEdit', id, sel: scope, ...image });
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
}
