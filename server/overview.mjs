import { nativeTargets, nativeWindowAt, nativeSessionCatalog } from './native-windows.mjs';
import { windowName } from '../lib/notify.mjs';
import { allFusionRuns, fusionSummary, FUSION_ACTIVE } from './fusion/state.mjs';
import { readLibrary, sessionId, rememberSessionStatuses, storedSessionStatus } from '../lib/session-library.mjs';
import { IS_WIN, samePath, localFilePath, pathKey } from '../lib/platform.mjs';
import { workspaceLabel } from '../lib/files.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { storedProjectSession, fusionTargets } from './project-windows.mjs';
import { openCode } from './opencode/state.mjs';
import { codexBackend, CODEX_BACKEND } from './codex/state.mjs';
import { adapter as codexAdapter } from './apps/codex.mjs';
import { Cdp } from './cdp.mjs';
import { helpersCall } from './page/build.mjs';

const APP = { cursor: 'Cursor', codex: 'Codex', devin: 'Devin' };
const FUSION_RECENT_MS = 24 * 3600 * 1000;
const projectId = (app, root, host, windowId) => JSON.stringify([app, host || '', root ? pathKey(root, !host) : windowId]);

function codexCardState(native, backend, hasWriter) {
  if (!native || native.statusKnown === false) return backend || native;
  if (!backend || backend.statusKnown === false) return native;
  if (hasWriter) return backend;
  if (native.nativeOwner) return native;
  const a = native.run, b = backend.run;
  if (a?.startedAt && b?.startedAt && a.startedAt !== b.startedAt) return a.startedAt > b.startedAt ? native : backend;
  if (a?.id && a.id === b?.id && a.status !== b.status) {
    if (a.completedAt && !b.completedAt) return native;
    if (b.completedAt && !a.completedAt) return backend;
  }
  if (native.busy || native.waiting) return native;
  if (!!a !== !!b) return a ? native : backend;
  return (native.observedAt || 0) >= (backend.observedAt || 0) ? native : backend;
}

export function overviewSnapshot(deviceId, selection) {
  const now = Date.now(), projects = new Map(), collected = new Map(), excluded = fusionTargets(), errors = [];
  const selectedApp = String(selection?.win || '').split(':')[0], selectedThread = selection?.threadId;
  let pendingWindows = 0;
  for (const win of nativeTargets()) {
    if (selection && win.app !== selectedApp) continue;
    const windowId = win.pageId || win.id;
    if (excluded.windows.has(win.app + ':' + windowId.replace(/^(cursor|devin|codex):/, ''))) continue;
    const source = nativeWindowAt(win.ws), snap = source?.snapshot, roots = source?.roots;
    const catalog = nativeSessionCatalog(win.app);
    if (!roots) {
      if (source?.rootsError) errors.push({ app: win.app, windowId, error: source.rootsError });
      else pendingWindows++;
      continue;
    }
    if (!catalog) pendingWindows++;
    const id = win.app === 'codex' ? 'codex' : win.id;
    for (const root of roots.length ? roots : [{ root: '', host: '' }]) {
      const workspace = localFilePath(root.root, !root.host && IS_WIN), host = root.host || '', key = projectId(win.app, workspace, host, windowId);
      if (!projects.has(key)) projects.set(key, { projectId: key, win: id, windowId, app: win.app, workspace, host,
        project: workspace ? path.posix.basename(workspace) || workspace : windowName(win.title, APP[win.app]), loading: !catalog });
    }
    const rows = new Map((catalog?.rows || []).map(row => [sessionId(win.app, row.id), row]));
    const local = new Map((source.catalog || []).map(row => [sessionId(win.app, row.id), row]));
    const workspaceIds = new Set([...local.keys()].map(id => rows.get(id)?.workspaceId).filter(Boolean));
    const belongs = row => row.workspace
      ? roots.some(root => (root.host || '') === (row.host || '') && samePath(root.root, row.workspace, !row.host))
      : !!row.workspaceId && workspaceIds.has(row.workspaceId);
    const projectRows = new Map([...rows].filter(([key, row]) => (!selection || key === selectedThread)
      && (belongs(row) || win.app === 'devin' && row.workspace && !row.host || win.app === 'cursor' && row.workspace)));
    for (const [key, row] of local) if ((!selection || key === selectedThread) && (belongs(row) || !row.workspace && win.app === 'cursor'))
      projectRows.set(key, { ...rows.get(key), ...row, lastUsed: row.lastUsed || rows.get(key)?.lastUsed || 0 });
    for (const state of source.overviewStates(selectedThread)) {
      const key = sessionId(win.app, state.thread), row = projectRows.get(key), known = rows.get(key) || local.get(key);
      // A Codex window can run a session that belongs to a different open project.
      const backend = win.app === 'codex' && !state.host && codexBackend.records.get(key);
      const matchesBackend = backend && state.workspace && samePath(backend.cwd, state.workspace);
      if (row || matchesBackend || key === sessionId(win.app, snap?.chat?.thread) && (!known?.workspace || belongs(known))) {
        const previous = row || (matchesBackend ? known : null);
        const value = { ...previous, ...state, id: key, title: state.title || previous?.title || '',
          lastUsed: state.lastUsed || previous?.lastUsed || 0 };
        if (win.app === 'codex' && state.run && state.run.status !== 'unknown') value.statusKnown = true;
        if (win.app === 'cursor' && known?.workspaceConfirmed) value.workspace = known.workspace;
        projectRows.set(key, value);
      }
    }
    for (const [key, row] of projectRows) {
      if (win.app === 'devin' && !rows.has(key) && catalog?.removed?.includes(key)) continue;
      const record = readLibrary()[win.app]?.[key];
      if (!key || row.archived || record?.archived || record?.deleted || excluded.sessions.has(win.app + ':' + key)
          || win.app === 'codex' && codexBackend.phoneControl(key)) continue;
      const s = { ...row, busy: row.busy ?? row.running };
      const saved = win.app === 'cursor' && !row.workspace && !row.projectless && storedProjectSession('cursor', key);
      const fallback = win.app === 'cursor' ? (saved?.workspaceConfirmed ? saved.workspace : '') : (roots.length === 1 ? roots[0].root : '');
      const workspace = localFilePath(row.workspace || fallback, !row.host && IS_WIN), host = row.host || '';
      const project = projectId(win.app, workspace, host, windowId);
      if (!projects.has(project)) projects.set(project, { projectId: project, win: id, windowId, app: win.app,
        workspace, host, project: path.posix.basename(workspace) || workspace || windowName(win.title, APP[win.app]), loading: false });
      const cachedPreview = source.previews.get(key);
      const preview = key !== sessionId(win.app, snap?.chat?.thread) || cachedPreview?.at >= source.updatedAt ? cachedPreview?.value : null;
      const value = {
        win: id, windowId, threadId: key, app: win.app, projectId: project, title: record?.title || s.title || '未命名会话',
        busy: !!s.busy, waiting: s.waiting || '', waitingText: s.waitingText || '', last: preview?.available ? preview.last : s.last || '',
        run: s.run || null, statusKnown: s.statusKnown ?? (!!s.busy || !!s.waiting || !!s.run),
        ...(win.app === 'codex' ? { nativeOwner: !!s.nativeOwner, observedAt: s.observedAt || source.updatedAt || 0 } : {}),
        startedAt: s.busy ? (s.run?.startedAt || (Number.isFinite(s.runAt) ? s.runAt : Number.isFinite(s.generation?.start) ? s.generation.start : 0)) : 0,
        tasks: s.tasks?.total > 0 ? { done: s.tasks.done, total: s.tasks.total, current: s.tasks.current || '' } : null,
        actions: s.actions || [], devin: !!s.devin, changed: s.changed || 0, acceptAll: !!s.acceptAll, changes: s.changes || null, lastUsed: Number.isFinite(s.lastUsed) ? s.lastUsed : 0,
        favorite: record?.favorite === true, lastMessageAt: Number(record?.lastMessageAt) || 0,
        workspace, host,
      };
      if (win.app === 'devin' && value.statusKnown && s.busy === false && value.run?.status === 'unknown') value.run = null;
      const identity = JSON.stringify([project, key]), previous = collected.get(identity);
      const quality = Number(!!s.run && s.run.status !== 'unknown') * 4 + Number(!!s.run) * 2
        + Number(key === sessionId(win.app, snap?.chat?.thread));
      const owner = win.app === 'codex' ? Number(!!s.nativeOwner) : win.app === 'devin'
        ? Number(key.startsWith('acp/devin-cli/') ? !!source.devinCatalog?.get(key)?.workspace : local.has(key) || source.devinCatalog?.has(key))
        : Number(belongs({ ...row, workspace }));
      if (!previous || owner > previous.owner || owner === previous.owner && ((s.run?.startedAt || 0) > (previous.value.run?.startedAt || 0)
        || (s.run?.startedAt || 0) === (previous.value.run?.startedAt || 0)
          && (quality > previous.quality || quality === previous.quality && source.updatedAt > previous.updatedAt)))
        collected.set(identity, { value, quality, owner, updatedAt: source.updatedAt });
    }
  }
  const api = !selection || selectedApp === 'opencode' ? openCode.overview(selectedThread) : { windows: [], sessions: [] };
  const records = !selection ? codexBackend.records.values() : selectedApp === 'codex' ? [codexBackend.records.get(selectedThread)].filter(Boolean) : [];
  const backendStates = new Map(codexBackend.states(selectedThread).map(row => [row.thread, row]));
  for (const row of records) {
    const record = readLibrary().codex?.[row.id];
    if (record?.archived || record?.deleted || excluded.sessions.has('codex:' + row.id) || !codexBackend.canAccess(row.id, deviceId)) continue;
    const workspace = localFilePath(row.cwd), key = projectId('codex', workspace, '', CODEX_BACKEND);
    const desktop = collected.get(JSON.stringify([key, row.id]))?.value;
    collected.delete(JSON.stringify([key, row.id]));
    const state = codexCardState(desktop, backendStates.get(row.id), codexBackend.hasWriter(row.id));
    const question = codexAdapter.backendQuestionState(row.id);
    const win = { projectId: key, win: 'codex', windowId: CODEX_BACKEND, app: 'codex', workspace, host: '', project: path.basename(workspace) };
    api.windows.push(win);
    api.sessions.push({ ...win, threadId: row.id, title: row.title, busy: !!state?.busy, waiting: state?.waiting || question.waiting, waitingText: state?.waitingText || question.waitingText,
      last: state?.last || '', run: state?.run || null, statusKnown: !!state?.statusKnown || !!question.waiting,
      startedAt: state?.busy ? state.run?.startedAt || state.startedAt || state.generation?.start || 0 : 0,
      tasks: state?.tasks || null, actions: [], changed: 0, lastUsed: row.updatedAt * 1000 });
  }
  for (const row of api.windows) projects.set(row.projectId, row);
  const windows = [...projects.values()];
  const locationKey = row => JSON.stringify([row.host || '', pathKey(row.workspace, !row.host)]);
  const byLocation = new Map(windows.filter(row => row.workspace)
    .map(row => [locationKey(row), { root: row.workspace, host: row.host || '' }]));
  const locations = [...byLocation.values()];
  for (const row of windows.filter(row => row.workspace)) {
    const location = byLocation.get(locationKey(row));
    const label = workspaceLabel(location, locations);
    row.project = [label.name, label.detail].filter(Boolean).join(' · ');
  }
  const sessions = [...collected.values()].map(({ value }) => ({ ...value, project: projects.get(value.projectId)?.project
    || path.posix.basename(value.workspace) || '项目' }));
  for (const row of api.sessions) {
    const record = readLibrary()[row.app]?.[row.threadId];
    sessions.push({ ...row, project: projects.get(row.projectId)?.project || row.project,
      title: record?.title || row.title, favorite: record?.favorite === true, dormant: row.app === 'opencode' && !openCode.connected });
  }
  const present = new Set(sessions.map(s => s.app + ':' + s.threadId));
  for (const app of Object.keys(APP)) {
    if (selection && app !== selectedApp) continue;
    const rows = new Map((nativeSessionCatalog(app)?.rows || []).map(row => [sessionId(app, row.id), row]));
    const library = readLibrary()[app] || {};
    for (const [id, record] of selection ? [[selectedThread, library[selectedThread]]] : Object.entries(library)) {
      if (!record?.favorite || record.archived || record.deleted || present.has(app + ':' + id) || rows.get(id)?.archived || excluded.sessions.has(app + ':' + id)) continue;
      const saved = storedProjectSession(app, id);
      const native = rows.get(id), row = { ...saved, ...native };
      const dormant = app !== 'codex' || !row.workspace || !codexAdapter.backendThread(id, row.host || '');
      const statusKnown = !dormant && typeof native?.running === 'boolean';
      sessions.push({ win: app, windowId: saved?.ownerWindow || app, threadId: id, app,
        projectId: projectId(app, localFilePath(row.workspace, !row.host && IS_WIN), row.host || '', saved?.ownerWindow || app),
        project: row.workspace ? path.posix.basename(localFilePath(row.workspace, !row.host && IS_WIN)) : '项目', title: record.title || row.title || '未命名会话',
        workspace: row.workspace || '', host: row.host || '', dormant, busy: statusKnown && native.running, waiting: '', waitingText: '', last: row.last || '',
        run: null, statusKnown, startedAt: 0, tasks: null, actions: [], devin: app === 'devin', changed: 0, acceptAll: false, changes: null,
        lastUsed: Number(row.lastUsed) || 0, favorite: true, lastMessageAt: Number(record.lastMessageAt) || 0 });
    }
  }
  const localPaths = new Map();
  for (const row of sessions) {
    if (row.host || !path.isAbsolute(row.workspace)) continue;
    const key = pathKey(row.workspace);
    if (!localPaths.has(key)) {
      try { localPaths.set(key, !fs.statSync(row.workspace).isDirectory()); }
      catch (error) { localPaths.set(key, ['ENOENT', 'ENOTDIR'].includes(error.code)); }
    }
    if (localPaths.get(key)) row.workspaceMissing = true;
  }
  rememberSessionStatuses(sessions);
  for (const row of sessions) if (row.dormant || row.statusKnown === false || row.run?.status === 'unknown') {
    const status = storedSessionStatus(row.app, row.threadId, row.host || '');
    if (row.app === 'codex' && (status?.busy || status?.waiting || status?.run?.status === 'running')) continue;
    if (status) Object.assign(row, { busy: status.busy, waiting: status.waiting, run: status.run,
      statusKnown: true, cachedStatusAt: status.at, startedAt: status.run?.startedAt || 0 });
  }
  const fusion = selection ? [] : allFusionRuns()
    .filter(run => FUSION_ACTIVE.includes(run.status) || ['awaiting_user', 'blocked'].includes(run.status) || now - run.updated < FUSION_RECENT_MS)
    .sort((a, b) => b.updated - a.updated).slice(0, 8).map(fusionSummary);
  return { os: process.platform, now, ready: pendingWindows === 0 && errors.length === 0,
    partial: (pendingWindows > 0 || errors.length > 0) && windows.length > 0,
    pendingWindows, errors, windows, sessions, fusion };
}

export function overviewSession(deviceId, { win, windowId, threadId }) {
  const sessions = overviewSnapshot(deviceId, { win, threadId }).sessions;
  let session = sessions.find(row => row.win === win && row.windowId === windowId && row.threadId === threadId);
  if (!session && String(win).split(':')[0] === 'cursor') {
    const matches = sessions.filter(row => row.app === 'cursor' && row.threadId === threadId && !row.dormant);
    if (matches.length === 1) [session] = matches;
  }
  if (!session) throw new Error('会话已从目录移除，请刷新概览');
  const target = nativeTargets().find(row => row.app === session.app && (row.pageId || row.id) === session.windowId);
  return { session, target };
}

export async function overviewPreview(deviceId, { win, windowId, threadId }) {
  const { session, target } = overviewSession(deviceId, { win, windowId, threadId });
  if (session.app === 'codex' && (windowId === CODEX_BACKEND || codexAdapter.backendThread(threadId, session.host))) {
    const owner = await codexAdapter.backendOwner(threadId);
    if (owner) {
      const cdp = new Cdp(owner.chatWs);
      try {
        await cdp.connect();
        const value = await cdp.evaluate(helpersCall(`nativeSessionInfo('codex', ${JSON.stringify(threadId)}, 'preview')`));
        if (value.status) rememberSessionStatuses([{ ...value.status, app: 'codex', threadId }]);
        return { ...value, win, windowId, threadId };
      } finally { cdp.close(); }
    }
    const chat = await codexBackend.readChat(threadId), start = chat.items.findLastIndex(row => row.k === 'human');
    const question = codexAdapter.backendQuestionState(threadId);
    rememberSessionStatuses([{ app: 'codex', threadId, busy: chat.busy, waiting: chat.waiting || question.waiting, run: chat.run }]);
    const turn = chat.items.slice(Math.max(0, start));
    const text = turn.filter(row => ['human', 'assistant'].includes(row.k)).map(row => row.t).join('\n\n').slice(-600);
    return { win, windowId, threadId, available: true, last: (chat.items.findLast(row => row.k === 'assistant')?.t || '').slice(-600), text,
      model: chat.model, effort: chat.effort, tasks: chat.tasks,
      tools: turn.filter(row => row.k === 'tool').slice(-3).map(row => ({ id: row.i, label: row.t.slice(0, 240), state: row.status === 'completed' ? 'done' : row.status === 'failed' ? 'error' : 'run' })) };
  }
  if (session.app === 'opencode') {
    await openCode.connect();
    await Promise.all([openCode.loadMessages(threadId), openCode.loadTasks(threadId)]);
    const rows = openCode.messageRows(threadId);
    const turn = rows.findLastIndex(row => row.info.role === 'user' && [...row.parts.values()].some(part => part.type === 'text' && !part.synthetic && part.text?.trim()));
    const chat = openCode.chat(threadId, { rows: rows.slice(Math.max(0, turn)), tools: new Set() });
    rememberSessionStatuses([{ app: 'opencode', threadId, busy: chat.busy, waiting: chat.waiting, run: null, statusKnown: openCode.connected }]);
    const text = chat.items.filter(row => ['human', 'assistant'].includes(row.k)).map(row => row.t).join('\n\n').slice(-600);
    return { win, windowId, threadId, available: true,
      last: (chat.items.findLast(row => row.k === 'assistant')?.t || '').slice(-600), text,
      model: chat.model, effort: chat.effort, tasks: chat.tasks,
      tools: chat.items.filter(row => row.k === 'tool').slice(-3).map(row => ({ id: row.i, label: row.t.slice(0, 240),
        state: row.status === 'error' ? 'error' : row.status === 'completed' ? 'done' : 'run' })) };
  }
  if (session.dormant) return { win, windowId, threadId, available: false, last: '', text: '' };
  const value = await nativeWindowAt(target.ws).preview(threadId, session);
  return { win, windowId, threadId, available: value.available, last: value.last || '', text: value.text || '',
    model: value.model || '', effort: value.effort || '', tasks: value.tasks || null, tools: value.tools || [] };
}
