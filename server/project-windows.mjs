import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../lib/auth.mjs';
import { normPath } from '../lib/platform.mjs';
import { readLibrary, sessionId, syncLibrarySessions } from '../lib/session-library.mjs';
import { EDITORS, CODEX_CDP_URL } from './config.mjs';
import { Cdp } from './cdp.mjs';
import { codexWindows } from './windows.mjs';
import { editorRoots } from '../lib/files.mjs';
import { helpersCall } from './page/build.mjs';
import { fusionViewers, fusionWorkers, FUSION_ACTIVE } from './fusion/state.mjs';
import { windowLeased, leaseWindow } from './window-use.mjs';

const file = path.join(DATA_DIR, 'project-windows.json');
const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { idleMinutes: 30, enabled: true, windows: {}, sessions: {} };
const key = (app, id) => app + ':' + String(id).replace(/^(cursor|devin|codex):/, '');
let scanning = false;
let activityWriteTimer;
const persist = () => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(saved), { mode: 0o600 }); };

export function trackProjectWindow(app, page, root, created = false) {
  const k = key(app, page.id), old = saved.windows[k];
  saved.windows[k] = { ...old, app, id: page.id, root, title: page.title, owned: created || !!old?.owned, lastUsed: Date.now(), closed: false };
  persist();
}
export function touchProjectWindow(app, id) {
  const row = saved.windows[key(app, id)];
  if (row) {
    row.lastUsed = Date.now();
    if (!activityWriteTimer) activityWriteTimer = setTimeout(() => { activityWriteTimer = null; persist(); }, 1000).unref();
  }
}
export function storedProjectSession(app, value) {
  const id = sessionId(app, value), state = readLibrary()[app]?.[id];
  if (state?.archived || state?.deleted) return null;
  const row = saved.sessions[app + ':' + id];
  return row && { ...row, dormant: !!saved.windows[key(app, row.ownerWindow)]?.closed };
}
export function projectSessionIds(app) {
  return Object.entries(saved.sessions).filter(([k, row]) => k.startsWith(app + ':') && !row.host).map(([k]) => k.slice(app.length + 1));
}
export function updateProjectWindowTargets(targets) {
  const present = new Set(targets.map(window => key(window.app, window.pageId || window.id)));
  let changed = false;
  for (const [id, window] of Object.entries(saved.windows)) {
    if (!['cursor', 'devin', 'codex'].includes(window.app)) continue;
    const closed = !present.has(id);
    if (!!window.closed === closed) continue;
    window.closed = closed;
    changed = true;
  }
  if (changed) persist();
}
export function reconcileSessionCatalog(app, catalog) {
  const states = new Map(catalog.rows.map(row => [sessionId(app, row.id), row.archived ? 'archived' : 'active']));
  const times = new Map(catalog.rows.filter(row => row.at != null).map(row => [sessionId(app, row.id), row.at]));
  for (const value of catalog.removed || []) {
    const id = sessionId(app, value), at = catalog.removedAt?.[value];
    if (at != null && at < (times.get(id) || 0)) continue;
    states.set(id, 'deleted');
    if (at != null) times.set(id, at);
  }
  if (catalog.complete) for (const id of projectSessionIds(app)) if (!states.has(id)) states.set(id, 'deleted');
  const synchronized = syncLibrarySessions(app, states, times);
  let changed = false;
  for (const [id, state] of states) if (state === 'deleted' && readLibrary()[app]?.[id]?.deleted && saved.sessions[app + ':' + id]) {
    delete saved.sessions[app + ':' + id];
    changed = true;
  }
  if (changed) persist();
  return synchronized || changed;
}
export function catalogSessions(app, rows, currentWindow) {
  rows = rows.filter(row => {
    const state = readLibrary()[app]?.[sessionId(app, row.id)];
    return row.ui || !state?.archived && !state?.deleted;
  });
  let changed = false;
  for (const row of rows) {
    if (row.ui || row.dormant) continue;
    const id = sessionId(app, row.id);
    const win = row.id.startsWith('project:') ? decodeURIComponent(row.id.split(':')[1]) : row.id.startsWith('thread:') ? row.id.split(':')[1] : currentWindow;
    const root = row.workspace || saved.windows[key(app, win)]?.root;
    if (!id || !root || row.host) continue;
    const value = { ...row, workspace: root, ownerWindow: win, id: row.id };
    if (JSON.stringify(saved.sessions[app + ':' + id]) !== JSON.stringify(value)) { saved.sessions[app + ':' + id] = value; changed = true; }
  }
  if (changed) persist();
  const ids = new Set(rows.map(row => sessionId(app, row.id)));
  const dormant = Object.entries(saved.sessions).filter(([k, row]) => k.startsWith(app + ':') && !ids.has(sessionId(app, row.id)) && saved.windows[key(app, row.ownerWindow)]?.closed)
    .map(([, row]) => row).filter(row => !readLibrary()[app]?.[sessionId(app, row.id)]?.deleted && !readLibrary()[app]?.[sessionId(app, row.id)]?.archived)
    .map(row => ({ ...row, current: false, running: false, dormant: true, window: path.basename(row.workspace) }));
  return [...rows, ...dormant];
}

// Detached commands retain a project cwd even after their terminal is idle.
export async function projectProcesses(root) {
  if (process.platform !== 'linux') return null;
  const under = cwd => cwd === root || cwd.startsWith(root + path.sep);
  const busy = [];
  let unknown = false;
  for (const id of await fs.promises.readdir('/proc')) {
    if (!/^\d+$/.test(id)) continue;
    try {
      const cwd = await fs.promises.readlink('/proc/' + id + '/cwd');
      if (!under(cwd)) continue;
      const command = (await fs.promises.readFile('/proc/' + id + '/cmdline', 'utf8')).replaceAll('\0', ' ');
      // Editor processes themselves are the windows being assessed; their child commands are kept.
      if (/--type=(?:renderer|zygote|gpu-process|utility)|--remote-debugging-port=/.test(command)) continue;
      busy.push(Number(id));
    } catch (error) {
      if (['EACCES', 'EPERM'].includes(error.code)) {
        const status = await fs.promises.readFile('/proc/' + id + '/status', 'utf8').catch(() => '');
        if (!status) unknown = true;
        if (Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]) === process.getuid()) {
          const name = /^Name:\s+(.+)/m.exec(status)?.[1];
          if (!['(sd-pam)', 'fusermount3'].includes(name)) unknown = true;
        }
      } else if (!['ENOENT', 'ESRCH'].includes(error.code)) unknown = true;
    }
  }
  return busy.length || !unknown ? busy : null;
}
function held(row) {
  if (row.keep || windowLeased(row.app, row.id) || windowLeased(row.app, row.app + ':' + row.id)) return true;
  const same = id => key(row.app, id) === key(row.app, row.id);
  if ([...fusionViewers].some(s => s.app === row.app && same(s.windowId) && (s.visible && Date.now() - s.notifyPresenceAt < 45000 || s.sending || s.imageTransfers?.size || s.focusCount || s.historyLoading))) return true;
  return [...fusionWorkers.values()].some(w => FUSION_ACTIVE.includes(w.fusionRun?.phase) && ['a', 'b'].some(side => w.fusionRun[side]?.app === row.app && same(w.fusionRun[side].windowId)));
}
export async function probeProjectWindow(row, page, scan = null) {
  if (held(row)) return { reason: '正在查看、执行操作或被保留' };
  const editor = new Cdp(page.webSocketDebuggerUrl);
  let chat;
  try {
    await editor.connect();
    const state = await editor.evaluate(helpersCall('projectWindowProbe()'));
    if (!state?.ready) return { reason: '窗口尚未就绪或状态无法确认' };
    if (state.focused || state.dirty || state.dialog || state.terminalBusy) return { reason: '窗口活动、未保存内容或终端任务' };
    let agent = state;
    if (row.app === 'codex') {
      const native = (await (scan ? scan.codex ||= codexWindows(CODEX_CDP_URL) : codexWindows(CODEX_CDP_URL))).find(p => p.pageId === page.id);
      if (!native?.chatWs) return { reason: 'Agent 尚未就绪' };
      chat = new Cdp(native.chatWs); await chat.connect();
      agent = await chat.evaluate(helpersCall('projectWindowProbe()'));
    }
    if (!agent?.agentKnown || agent.agentBusy) return { reason: 'Agent 正在运行或状态无法确认' };
    if (scan && !scan.processes.has(row.root)) scan.processes.set(row.root, projectProcesses(row.root));
    const processes = await (scan ? scan.processes.get(row.root) : projectProcesses(row.root));
    if (!processes || processes.length) return { reason: processes ? '项目进程或后台命令仍在运行' : '无法确认后台进程状态' };
    return { idle: true, activity: Math.max(state.lastInput || 0, agent.lastInput || 0) };
  } catch { return { reason: '状态读取失败，保留窗口' }; }
  finally { chat?.close(); editor.close(); }
}
export async function nativeCloseProjectWindow(page) {
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  try {
    await cdp.connect();
    if (process.platform === 'linux' && process.env.DISPLAY) {
      const { x11CloseWindow } = await import('../lib/x11.mjs');
      const info = await cdp.evaluate(`({ pid: window.vscode?.context?.configuration?.()?.mainPid, title: document.title })`);
      if (!info.pid || !await x11CloseWindow(info.pid, info.title)) throw new Error('无法确认原生窗口，已保留');
      return;
    }
    throw new Error('无法确认系统关闭窗口入口，已保留');
  } finally { cdp.close(); }
}
export async function scanProjectWindows(closeIdle = true) {
  if (scanning) return;
  scanning = true;
  const scan = { processes: new Map(), codex: null };
  try {
    for (const ed of EDITORS) {
      let pages;
      try { pages = (await (await fetch(ed.url + '/json/list', { signal: AbortSignal.timeout(2000) })).json()).filter(p => p.type === 'page' && /workbench/.test(p.url)); }
      catch { continue; }
      const ids = new Set(pages.map(p => key(ed.app, p.id)));
      for (const [k, row] of Object.entries(saved.windows)) if (row.app === ed.app && !ids.has(k)) row.closed = true;
      for (const page of pages) {
        const k = key(ed.app, page.id);
        if (!saved.windows[k]) {
          const cdp = new Cdp(page.webSocketDebuggerUrl);
          try {
            await cdp.connect();
            const roots = await editorRoots(cdp, ed.app);
            if (roots.length !== 1 || roots[0].host) continue;
            saved.windows[k] = { app: ed.app, id: page.id, root: roots[0].root, title: page.title, lastUsed: Date.now(), owned: false };
          } catch { continue; } finally { cdp.close(); }
        }
        const row = saved.windows[k];
        row.closed = false;
        if (!row.owned || !saved.enabled || !closeIdle) continue;
        const editor = new Cdp(page.webSocketDebuggerUrl);
        try {
          await editor.connect();
          const roots = await editorRoots(editor, row.app);
          if (roots.length !== 1 || roots[0].host || normPath(roots[0].root) !== normPath(row.root)) {
            row.owned = false; row.reason = '项目已在电脑端变化，请重新纳入管理'; continue;
          }
        } finally { editor.close(); }
        const state = await probeProjectWindow(row, page, scan);
        row.reason = state.reason || '空闲';
        if (!state.idle) { row.lastUsed = Date.now(); continue; }
        row.lastUsed = Math.max(row.lastUsed, state.activity);
        if (Date.now() - row.lastUsed < saved.idleMinutes * 60000) continue;
        // Count usable survivors and inspect this window again immediately before closing it.
        let survivors = 0;
        const codex = ed.app === 'codex' ? await codexWindows(CODEX_CDP_URL) : null;
        for (const other of pages.filter(p => p.id !== page.id && !saved.windows[key(ed.app, p.id)]?.closed)) {
          const chatWs = codex?.find(p => p.pageId === other.id)?.chatWs;
          if (codex && !chatWs) continue;
          const cdp = new Cdp(chatWs || other.webSocketDebuggerUrl);
          try { await cdp.connect(); const state = await cdp.evaluate(helpersCall('projectWindowProbe()')); if (state?.ready && state.agentKnown) survivors++; }
          finally { cdp.close(); }
        }
        if (!survivors) { row.reason = '保留最后一个可用窗口'; continue; }
        const check = await probeProjectWindow(row, page);
        if (!check.idle || held(row) || check.activity > row.lastUsed) continue;
        const release = leaseWindow(row.app, row.id, row, true);
        try { await nativeCloseProjectWindow(page); }
        catch (error) { row.keep = true; row.reason = error.message; continue; }
        finally { release(); }
        await new Promise(resolve => setTimeout(resolve, 200));
        const current = await (await fetch(ed.url + '/json/list')).json();
        row.closed = !current.some(p => p.id === page.id);
        if (!row.closed) { row.keep = true; row.reason = '原生关闭未完成，已保留'; }
      }
    }
    persist();
  } finally { scanning = false; }
}
export function projectWindowSettings(change) {
  if (change) {
    if (typeof change.enabled === 'boolean') saved.enabled = change.enabled;
    if (Number.isFinite(change.idleMinutes) && change.idleMinutes >= 1) saved.idleMinutes = change.idleMinutes;
    if (change.window) {
      const row = saved.windows[change.window];
      if (row && !row.closed) {
        if (typeof change.owned === 'boolean') row.owned = change.owned;
        if (typeof change.keep === 'boolean') row.keep = change.keep;
        row.lastUsed = Date.now();
      }
    }
    persist();
  }
  return { enabled: saved.enabled, idleMinutes: saved.idleMinutes, windows: Object.entries(saved.windows).filter(([, row]) => !row.closed).map(([id, row]) => ({ ...row, key: id })) };
}
export function startProjectWindowCleanup() {
  const timer = setInterval(() => scanProjectWindows().catch(error => console.log('[window cleanup]', error.message)), 60000);
  timer.unref();
  scanProjectWindows(false).catch(() => {});
}
