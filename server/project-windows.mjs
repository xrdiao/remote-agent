import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../lib/auth.mjs';
import { IS_WIN, localFilePath, samePath, pathKey } from '../lib/platform.mjs';
import { parseAgentRef } from '../lib/shared-rules.mjs';
import { x11ActiveWindow } from '../lib/x11.mjs';
import { readLibrary, sessionId, syncLibrarySessions } from '../lib/session-library.mjs';
import { EDITORS, CODEX_CDP_URL } from './config.mjs';
import { Cdp } from './cdp.mjs';
import { codexWindows } from './windows.mjs';
import { editorRoots } from '../lib/files.mjs';
import { helpersCall } from './page/build.mjs';
import { fusionWindowInUse, allFusionRuns } from './fusion/state.mjs';
import { fusionViewers } from './fusion/presenter.mjs';
import { windowLeased, leaseWindow } from './window-use.mjs';
import { nativeTargets, nativeWindowAt, withNativeWindowRead } from './native-windows.mjs';

const file = path.join(DATA_DIR, 'project-windows.json');
const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { idleMinutes: 30, enabled: true, windows: {}, sessions: {} };
for (const row of Object.values(saved.windows)) if (!row.host) row.root = localFilePath(row.root);
for (const row of Object.values(saved.sessions)) if (!row.host) row.workspace = localFilePath(row.workspace);
const unsupportedReason = 'Windows 暂不支持自动回收项目窗口';
const key = (app, id) => app + ':' + String(id).replace(/^(cursor|devin|codex):/, '');
let scanning = false;
let activityWriteTimer;
const persist = () => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(saved), { mode: 0o600 }); };

export function bindProjectWindow(app, id) {
  const value = key(app, id);
  if (saved.bindings?.[app] === value) return;
  (saved.bindings ||= {})[app] = value;
  persist();
}

export function orderedProjectWindows(app, pages) {
  return [...pages].sort((a, b) => {
    const rank = page => key(app, page.pageId || page.id) === saved.bindings?.[app] ? 0
      : saved.windows[key(app, page.pageId || page.id)]?.owned ? 1 : 2;
    return rank(a) - rank(b) || String(a.pageId || a.id).localeCompare(String(b.pageId || b.id));
  });
}

export function ownedProjectWindow(app, id) {
  const row = saved.windows[key(app, id)];
  return row?.owned === true && !row.keep;
}

export function trackProjectWindow(app, page, root, created = false) {
  const k = key(app, page.id), old = saved.windows[k];
  saved.windows[k] = { ...old, app, id: page.id, root: localFilePath(root), title: page.title, owned: created || !!old?.owned, lastUsed: Date.now(), closed: false };
  persist();
}
export function fusionTargets() {
  return { windows: new Set(), sessions: new Set(allFusionRuns({ removed: true }).flatMap(run => run.bindings)
    .filter(binding => binding.role !== 'main' && binding.threadId).map(binding => binding.app + ':' + sessionId(binding.app, binding.threadId))) };
}
export function rememberFusionSession(app, id, project, windowId) {
  saved.sessions[app + ':' + sessionId(app, id)] = { id, workspace: project.host ? project.root : localFilePath(project.root), host: project.host || '', ownerWindow: windowId };
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
export function rememberCursorSessionProject(id, root, windowId) {
  const k = 'cursor:' + sessionId('cursor', id), previous = saved.sessions[k];
  if (previous?.workspaceConfirmed && samePath(previous.workspace, root)) return;
  saved.sessions[k] = { ...previous, id, workspace: localFilePath(root), host: '', ownerWindow: windowId, workspaceConfirmed: true };
  persist();
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
  for (const row of catalog.rows) {
    const id = sessionId(app, row.id), k = app + ':' + id;
    const previous = saved.sessions[k];
    if (!row.workspace || row.host || app === 'cursor' && !row.workspaceConfirmed) continue;
    if (!readLibrary()[app]?.[id]?.favorite && !(app === 'cursor' && previous?.workspaceConfirmed)) continue;
    if (previous && samePath(previous.workspace, row.workspace) && !previous.host && (app !== 'cursor' || previous.workspaceConfirmed)) continue;
    saved.sessions[k] = { ...previous, id: previous?.id || row.id, workspace: localFilePath(row.workspace), host: '',
      ...(app === 'cursor' ? { workspaceConfirmed: true } : {}) };
    changed = true;
  }
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
    const win = /^(?:project|thread):/.test(row.id) ? parseAgentRef(row.id).windowId : currentWindow;
    const previous = saved.sessions[app + ':' + id];
    const root = app === 'cursor'
      ? (row.workspaceConfirmed ? row.workspace : (row.projectless ? '' : previous?.workspaceConfirmed && previous.workspace))
      : row.workspace || saved.windows[key(app, win)]?.root;
    if (!id || !root || row.host) continue;
    const value = { ...row, workspace: localFilePath(root), ownerWindow: win, id: row.id,
      ...(app === 'cursor' ? { workspaceConfirmed: true } : {}) };
    if (JSON.stringify(saved.sessions[app + ':' + id]) !== JSON.stringify(value)) { saved.sessions[app + ':' + id] = value; changed = true; }
  }
  if (changed) persist();
  const ids = new Set(rows.map(row => sessionId(app, row.id)));
  const dormant = Object.entries(saved.sessions).filter(([k, row]) => k.startsWith(app + ':') && !ids.has(sessionId(app, row.id)) && saved.windows[key(app, row.ownerWindow)]?.closed)
    .map(([, row]) => row).filter(row => !readLibrary()[app]?.[sessionId(app, row.id)]?.deleted && !readLibrary()[app]?.[sessionId(app, row.id)]?.archived)
    .map(row => ({ ...row, current: false, running: false, dormant: true, window: path.basename(row.workspace) }));
  const workers = fusionTargets().sessions;
  return [...rows, ...dormant].filter(row => !workers.has(app + ':' + sessionId(app, row.id)));
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
      const args = (await fs.promises.readFile('/proc/' + id + '/cmdline', 'utf8')).split('\0').filter(Boolean);
      // Protocol servers stay alive while idle. Only the server itself is excluded;
      // commands it starts are still inspected separately, including detached jobs.
      if (args[0] === '/usr/bin/ssh-agent'
          || args.some(arg => /^--type=(?:renderer|zygote|gpu-process|utility)$|^--remote-debugging-port=/.test(arg))
          || args.includes('--node-ipc') && args.some(arg => arg.includes('/resources/app/extensions/'))
          || args[1] === 'acp' && args[0].includes('/resources/app/extensions/')
          || args.includes('--mcp') && args.includes('serve')) continue;
      const cwd = await fs.promises.readlink('/proc/' + id + '/cwd');
      if (!under(cwd)) continue;
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
  if (row.keep) return '已设置保留';
  if (Object.entries(readLibrary()[row.app] || {}).some(([id, state]) => {
    const session = saved.sessions[row.app + ':' + id];
    return state.favorite && !state.deleted && session && !session.host && samePath(session.workspace, row.root);
  })) return '项目包含收藏会话';
  if (windowLeased(row.app, row.id) || windowLeased(row.app, row.app + ':' + row.id)) return '正在执行窗口操作';
  const same = id => key(row.app, id) === key(row.app, row.id);
  if ([...fusionViewers].some(s => s.app === row.app && same(s.windowId) && (s.visible && Date.now() - s.notifyPresenceAt < 45000 || s.sending || s.imageTransfers?.size || s.focusCount || s.historyLoading))) return '正在查看或执行会话操作';
  return fusionWindowInUse(row) ? 'Fusion 正在使用窗口' : '';
}
export async function probeProjectWindow(row, page, scan = null) {
  const reason = held(row);
  if (reason) return { reason };
  try {
    const probe = helpersCall('projectWindowProbe()');
    const state = await withNativeWindowRead(page.webSocketDebuggerUrl, row.app, page.id, cdp => cdp.evaluate(probe));
    if (!state?.ready) return { reason: '窗口尚未就绪或状态无法确认' };
    let focused = state.focused;
    if (process.platform === 'linux' && process.env.DISPLAY) {
      focused = await x11ActiveWindow() === Buffer.from(state.windowHandle).readUInt32LE(0);
    }
    if (focused || state.dirty || state.dialog || state.terminalBusy) return { reason: '窗口活动、未保存内容或终端任务' };
    let agent = state;
    if (row.app === 'codex') {
      const native = (await (scan ? scan.codex ||= codexWindows(CODEX_CDP_URL) : codexWindows(CODEX_CDP_URL))).find(p => p.pageId === page.id);
      if (!native?.chatWs) return { reason: 'Agent 尚未就绪' };
      agent = await withNativeWindowRead(native.chatWs, row.app, page.id, cdp => cdp.evaluate(probe));
    }
    if (!agent?.agentKnown || agent.agentBusy) return { reason: 'Agent 正在运行或状态无法确认' };
    const processKey = pathKey(row.root);
    if (scan && !scan.processes.has(processKey)) scan.processes.set(processKey, projectProcesses(row.root));
    const processes = await (scan ? scan.processes.get(processKey) : projectProcesses(row.root));
    if (!processes || processes.length) return { reason: processes ? '项目进程或后台命令仍在运行' : '无法确认后台进程状态' };
    return { idle: true, activity: Math.max(state.lastInput || 0, agent.lastInput || 0) };
  } catch { return { reason: '状态读取失败，保留窗口' }; }
}
export async function nativeCloseProjectWindow(page) {
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  try {
    await cdp.connect();
    if (process.platform === 'linux' && process.env.DISPLAY) {
      await cdp.send('Page.close');
      return;
    }
    throw new Error('无法确认系统关闭窗口入口，已保留');
  } finally { cdp.close(); }
}
function readProjectWindowList(ed) {
  return fetch(ed.url + '/json/list', { signal: AbortSignal.timeout(2000) })
    .then(res => res.json()).then(pages => pages.filter(page => page.type === 'page' && /workbench/.test(page.url)));
}

function foregroundProjectWindow(ed, page) {
  const editor = nativeWindowAt(page.webSocketDebuggerUrl);
  if (editor?.foregroundReads) return editor;
  const ws = nativeTargets().find(target => target.app === ed.app && target.pageId === page.id
    && target.editorWs === page.webSocketDebuggerUrl)?.ws;
  const chat = ws && nativeWindowAt(ws);
  if (chat?.foregroundReads) return chat;
}

const scanningWindows = new Set();
// A delayed automatic scan can run concurrently with another window scan.
// Serialize the actual close decision per app, including a fresh survivor
// check, so two delayed scans cannot both close each other's last survivor.
const appCloseScans = new Map();
const unconfirmedCloses = new Map();
async function serializeProjectWindowClose(app, action) {
  const previous = appCloseScans.get(app) || Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  appCloseScans.set(app, current);
  try { return await current; }
  finally { if (appCloseScans.get(app) === current) appCloseScans.delete(app); }
}
async function scanProjectWindow(ed, page, pages, closeIdle, scan, background) {
  const defer = () => {
    const source = background && foregroundProjectWindow(ed, page);
    if (!source) return false;
    source.deferBackgroundRead('project-window-scan', async () => {
      const current = await readProjectWindowList(ed);
      const exact = current.find(item => item.id === page.id && item.webSocketDebuggerUrl === page.webSocketDebuggerUrl);
      if (exact) {
        await scanProjectWindow(ed, exact, current, closeIdle, { processes: new Map(), codex: null }, true);
        persist();
      }
    }, null).catch(error => console.log('[window cleanup]', error.message));
    return true;
  };
  if (defer()) return;
  const k = key(ed.app, page.id);
  if (scanningWindows.has(k)) return;
  scanningWindows.add(k);
  try {
    const readRoots = () => withNativeWindowRead(page.webSocketDebuggerUrl, ed.app, page.id, cdp => editorRoots(cdp, ed.app));
    if (!saved.windows[k]) {
      try {
        const roots = await readRoots();
        if (roots.length !== 1 || roots[0].host) return;
        saved.windows[k] = { app: ed.app, id: page.id, root: roots[0].root, title: page.title, lastUsed: Date.now(), owned: false };
      } catch { return; }
    }
    const row = saved.windows[k];
    row.closed = false;
    if (IS_WIN) { row.reason = unsupportedReason; return; }
    if (!row.owned || !closeIdle || !saved.enabled) return;
    const matchesRoot = roots => roots.length === 1 && !roots[0].host && samePath(roots[0].root, row.root);
    if (!matchesRoot(await readRoots())) {
      row.owned = false; row.reason = '项目已在电脑端变化，请重新纳入管理'; return;
    }
    const state = await probeProjectWindow(row, page, scan);
    row.reason = state.reason || '空闲';
    if (!state.idle) { row.lastUsed = Date.now(); return; }
    row.lastUsed = Math.max(row.lastUsed, state.activity);
    if (Date.now() - row.lastUsed < saved.idleMinutes * 60000) return;
    return await serializeProjectWindowClose(ed.app, async () => {
      if (defer() || !saved.enabled || !row.owned || held(row)
          || Date.now() - row.lastUsed < saved.idleMinutes * 60000) return;
      // The previous scan may already have removed another window. Do not
      // count any survivor from the earlier scan's page list.
      const livePages = await readProjectWindowList(ed);
      if (!livePages.some(p => p.id === page.id && p.webSocketDebuggerUrl === page.webSocketDebuggerUrl)) return;
      let pending = unconfirmedCloses.get(ed.app);
      if (!pending) unconfirmedCloses.set(ed.app, pending = new Map());
      for (const [id, url] of pending)
        if (!livePages.some(p => p.id === id && p.webSocketDebuggerUrl === url)) pending.delete(id);
      if (pending.has(page.id)) return;
      let survivors = 0;
      const codex = ed.app === 'codex' ? await codexWindows(CODEX_CDP_URL) : null;
      for (const other of livePages.filter(p => p.id !== page.id && !pending.has(p.id) && !saved.windows[key(ed.app, p.id)]?.closed)) {
        const chatWs = codex?.find(p => p.pageId === other.id)?.chatWs;
        if (codex && !chatWs || background && foregroundProjectWindow(ed, other)) continue;
        const state = await withNativeWindowRead(chatWs || other.webSocketDebuggerUrl, ed.app, other.id,
          cdp => cdp.evaluate(helpersCall('projectWindowProbe()')));
        if (state?.ready && state.agentKnown) survivors++;
      }
      if (!survivors) { row.reason = '保留最后一个可用窗口'; return; }
      if (defer() || !matchesRoot(await readRoots())) return;
      const check = await probeProjectWindow(row, page);
      if (!check.idle || held(row) || check.activity > row.lastUsed || defer()
          || !saved.enabled || !row.owned || Date.now() - row.lastUsed < saved.idleMinutes * 60000) return;
      const release = leaseWindow(row.app, row.id, row, true);
      // If closure is unconfirmed, don't count this target as a survivor of
      // the next close, and don't submit another close to the same target.
      pending.set(page.id, page.webSocketDebuggerUrl);
      try { await nativeCloseProjectWindow(page); }
      catch (error) { row.reason = error.message; return; }
      finally { release(); }
      await new Promise(resolve => setTimeout(resolve, 200));
      const current = await readProjectWindowList(ed);
      row.closed = !current.some(p => p.id === page.id && p.webSocketDebuggerUrl === page.webSocketDebuggerUrl);
      if (row.closed) pending.delete(page.id);
      else row.reason = '原生关闭未完成';
    });
  } finally { scanningWindows.delete(k); }
}

export async function scanProjectWindows(closeIdle = true, background = false) {
  if (scanning) return;
  scanning = true;
  const scan = { processes: new Map(), codex: null };
  try {
    for (const ed of EDITORS) {
      let pages;
      try { pages = await readProjectWindowList(ed); }
      catch { continue; }
      const ids = new Set(pages.map(p => key(ed.app, p.id)));
      for (const [k, row] of Object.entries(saved.windows)) if (row.app === ed.app && !ids.has(k)) row.closed = true;
      for (const page of pages) await scanProjectWindow(ed, page, pages, closeIdle, scan, background);
    }
    persist();
  } finally { scanning = false; }
}
export function projectWindowSettings(change) {
  if (IS_WIN && change) throw new Error(unsupportedReason);
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
  return { supported: !IS_WIN, reason: IS_WIN ? unsupportedReason : '', enabled: !IS_WIN && saved.enabled, idleMinutes: saved.idleMinutes, windows: Object.entries(saved.windows).filter(([, row]) => !row.closed).map(([id, row]) => ({ ...row, key: id })) };
}
export function startProjectWindowCleanup() {
  const timer = setInterval(() => scanProjectWindows(true, true).catch(error => console.log('[window cleanup]', error.message)), 60000);
  timer.unref();
  scanProjectWindows(false, true).catch(() => {});
}
