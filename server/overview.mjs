import { nativeTargets, nativeWindowAt, nativeSessionCatalog } from './native-windows.mjs';
import { windowName } from '../lib/notify.mjs';
import { allFusionRuns, fusionSummary, FUSION_ACTIVE } from './fusion/state.mjs';
import { readLibrary, sessionId } from '../lib/session-library.mjs';
import { samePath, normPath, pathKey } from '../lib/platform.mjs';
import { workspaceLabel } from '../lib/files.mjs';
import path from 'node:path';
import { storedProjectSession, fusionTargets } from './project-windows.mjs';
import { openCode } from './opencode/state.mjs';
import { codexBackend, CODEX_BACKEND } from './codex/state.mjs';
import { adapter as codexAdapter } from './apps/codex.mjs';

const APP = { cursor: 'Cursor', codex: 'Codex', devin: 'Devin' };
const FUSION_RECENT_MS = 24 * 3600 * 1000;
const projectId = (app, root, host, windowId) => JSON.stringify([app, host || '', root ? pathKey(root, !host) : windowId]);

export function overviewSnapshot(deviceId) {
  const now = Date.now(), projects = new Map(), collected = new Map(), excluded = fusionTargets(), errors = [];
  let pendingWindows = 0;
  for (const win of nativeTargets()) {
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
      const workspace = normPath(root.root), host = root.host || '', key = projectId(win.app, workspace, host, windowId);
      if (!projects.has(key)) projects.set(key, { projectId: key, win: id, windowId, app: win.app, workspace, host,
        project: workspace ? path.posix.basename(workspace) || workspace : windowName(win.title, APP[win.app]), loading: !catalog });
    }
    const rows = new Map((catalog?.rows || []).map(row => [sessionId(win.app, row.id), row]));
    const local = new Map((source.catalog || []).map(row => [sessionId(win.app, row.id), row]));
    const workspaceIds = new Set([...local.keys()].map(id => rows.get(id)?.workspaceId).filter(Boolean));
    const belongs = row => row.workspace
      ? roots.some(root => (root.host || '') === (row.host || '') && samePath(root.root, row.workspace, !row.host))
      : !!row.workspaceId && workspaceIds.has(row.workspaceId);
    const projectRows = new Map([...rows].filter(([, row]) => belongs(row) || win.app === 'devin' && row.workspace && !row.host));
    for (const [key, row] of local) if (belongs(row) || !row.workspace && win.app === 'cursor')
      projectRows.set(key, { ...rows.get(key), ...row, lastUsed: row.lastUsed || rows.get(key)?.lastUsed || 0 });
    for (const state of source.overviewStates()) {
      const key = sessionId(win.app, state.thread), row = projectRows.get(key), known = rows.get(key) || local.get(key);
      if (row || key === sessionId(win.app, snap?.chat?.thread) && (!known?.workspace || belongs(known)))
        projectRows.set(key, { ...row, ...state, id: key, title: state.title || row?.title || '', lastUsed: state.lastUsed || row?.lastUsed || 0 });
    }
    for (const [key, row] of projectRows) {
      if (win.app === 'codex' && codexBackend.owns(key)) continue;
      const record = readLibrary()[win.app]?.[key];
      if (!key || row.archived || record?.archived || record?.deleted || excluded.sessions.has(win.app + ':' + key)) continue;
      const s = { ...row, busy: row.busy ?? row.running };
      const workspace = normPath(row.workspace || (roots.length === 1 ? roots[0].root : '')), host = row.host || '';
      const project = projectId(win.app, workspace, host, windowId);
      if (!projects.has(project)) projects.set(project, { projectId: project, win: id, windowId, app: win.app,
        workspace, host, project: path.posix.basename(workspace) || workspace, loading: false });
      const cachedPreview = source.previews.get(key);
      const preview = key !== sessionId(win.app, snap?.chat?.thread) || cachedPreview?.at >= source.updatedAt ? cachedPreview?.value : null;
      const value = {
        win: id, windowId, threadId: key, app: win.app, projectId: project, title: record?.title || s.title || '未命名会话',
        busy: !!s.busy, waiting: s.waiting || '', waitingText: s.waitingText || '', last: preview?.available ? preview.last : s.last || '',
        run: s.run || null, statusKnown: s.statusKnown ?? (typeof s.busy === 'boolean' || !!s.run),
        startedAt: s.busy ? (s.run?.startedAt || (Number.isFinite(s.runAt) ? s.runAt : Number.isFinite(s.generation?.start) ? s.generation.start : 0)) : 0,
        tasks: s.tasks?.total > 0 ? { done: s.tasks.done, total: s.tasks.total, current: s.tasks.current || '' } : null,
        actions: s.actions || [], devin: !!s.devin, changed: s.changed || 0, acceptAll: !!s.acceptAll, changes: s.changes || null, lastUsed: Number.isFinite(s.lastUsed) ? s.lastUsed : 0,
        favorite: record?.favorite === true, lastMessageAt: Number(record?.lastMessageAt) || 0,
        workspace, host,
      };
      const identity = JSON.stringify([project, key]), previous = collected.get(identity);
      const quality = Number(!!s.run && s.run.status !== 'unknown') * 4 + Number(!!s.run) * 2
        + Number(key === sessionId(win.app, snap?.chat?.thread));
      if (!previous || (s.run?.startedAt || 0) > (previous.value.run?.startedAt || 0)
        || (s.run?.startedAt || 0) === (previous.value.run?.startedAt || 0)
          && (quality > previous.quality || quality === previous.quality && source.updatedAt > previous.updatedAt))
        collected.set(identity, { value, quality, updatedAt: source.updatedAt });
    }
  }
  const api = openCode.overview();
  const backendStates = new Map(codexBackend.states().map(row => [row.thread, row]));
  for (const row of codexBackend.records.values()) {
    const state = backendStates.get(row.id), workspace = normPath(row.cwd), key = projectId('codex', workspace, '', CODEX_BACKEND);
    const win = { projectId: key, win: 'codex', windowId: CODEX_BACKEND, app: 'codex', workspace, host: '', project: path.basename(workspace) };
    api.windows.push(win);
    api.sessions.push({ ...win, threadId: row.id, title: row.title, busy: !!state?.busy, waiting: state?.waiting || '', waitingText: state?.waitingText || '',
      last: state?.last || '', run: state?.run || null, statusKnown: !!state, startedAt: state?.generation?.start || 0,
      tasks: null, actions: [], changed: 0, lastUsed: row.updatedAt * 1000 });
  }
  for (const row of api.windows) projects.set(row.projectId, row);
  const windows = [...projects.values()], locations = [...new Map(windows.filter(row => row.workspace)
    .map(row => [JSON.stringify([row.host, pathKey(row.workspace, !row.host)]), { root: row.workspace, host: row.host }])).values()];
  for (const row of windows.filter(row => row.workspace)) {
    const location = locations.find(value => value.root === row.workspace && value.host === row.host);
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
    const rows = new Map((nativeSessionCatalog(app)?.rows || []).map(row => [sessionId(app, row.id), row]));
    for (const [id, record] of Object.entries(readLibrary()[app] || {})) {
      if (!record.favorite || record.archived || record.deleted || present.has(app + ':' + id) || rows.get(id)?.archived || excluded.sessions.has(app + ':' + id)) continue;
      const saved = storedProjectSession(app, id);
      const row = { ...saved, ...rows.get(id) };
      sessions.push({ win: app, windowId: saved?.ownerWindow || app, threadId: id, app,
        projectId: projectId(app, normPath(row.workspace), row.host || '', saved?.ownerWindow || app),
        project: row.workspace ? path.posix.basename(normPath(row.workspace)) : '项目', title: record.title || row.title || '未命名会话',
        workspace: row.workspace || '', host: row.host || '', dormant: true, busy: false, waiting: '', waitingText: '', last: row.last || '',
        run: null, statusKnown: false, startedAt: 0, tasks: null, actions: [], devin: app === 'devin', changed: 0, acceptAll: false, changes: null,
        lastUsed: Number(row.lastUsed) || 0, favorite: true, lastMessageAt: Number(record.lastMessageAt) || 0 });
    }
  }
  const fusion = allFusionRuns()
    .filter(run => FUSION_ACTIVE.includes(run.status) || ['awaiting_user', 'blocked'].includes(run.status) || now - run.updated < FUSION_RECENT_MS)
    .sort((a, b) => b.updated - a.updated).slice(0, 8).map(fusionSummary);
  return { os: process.platform, now, ready: pendingWindows === 0 && errors.length === 0,
    partial: (pendingWindows > 0 || errors.length > 0) && windows.length > 0,
    pendingWindows, errors, windows, sessions, fusion };
}

export function overviewSession(deviceId, { win, windowId, threadId }) {
  const session = overviewSnapshot(deviceId).sessions.find(row => row.win === win && row.windowId === windowId && row.threadId === threadId);
  if (!session) throw new Error('会话已从目录移除，请刷新概览');
  const target = nativeTargets().find(row => row.app === session.app && (row.pageId || row.id) === windowId);
  return { session, target };
}

export async function overviewPreview(deviceId, { win, windowId, threadId }) {
  const { session, target } = overviewSession(deviceId, { win, windowId, threadId });
  if (session.app === 'codex' && (windowId === CODEX_BACKEND || codexAdapter.backendThread(threadId, session.host))) {
    await codexBackend.load(threadId);
    const chat = codexBackend.chat(threadId), start = chat.items.findLastIndex(row => row.k === 'human');
    const turn = chat.items.slice(Math.max(0, start));
    const text = turn.filter(row => ['human', 'assistant'].includes(row.k)).map(row => row.t).join('\n\n').slice(-600);
    return { win, windowId, threadId, available: true, last: (chat.items.findLast(row => row.k === 'assistant')?.t || '').slice(-600), text,
      model: chat.model, effort: chat.effort, tasks: null,
      tools: turn.filter(row => row.k === 'tool').slice(-3).map(row => ({ id: row.i, label: row.t.slice(0, 240), state: row.status === 'completed' ? 'done' : row.status === 'failed' ? 'error' : 'run' })) };
  }
  if (session.app === 'opencode') {
    await openCode.connect();
    await openCode.loadMessages(threadId);
    const rows = openCode.messageRows(threadId);
    const turn = rows.findLastIndex(row => row.info.role === 'user' && [...row.parts.values()].some(part => part.type === 'text' && !part.synthetic && part.text?.trim()));
    const chat = openCode.chat(threadId, { rows: rows.slice(Math.max(0, turn)), tools: new Set() });
    const text = chat.items.filter(row => ['human', 'assistant'].includes(row.k)).map(row => row.t).join('\n\n').slice(-600);
    return { win, windowId, threadId, available: true,
      last: (chat.items.findLast(row => row.k === 'assistant')?.t || '').slice(-600), text,
      model: chat.model, effort: chat.effort, tasks: null,
      tools: chat.items.filter(row => row.k === 'tool').slice(-3).map(row => ({ id: row.i, label: row.t.slice(0, 240),
        state: row.status === 'error' ? 'error' : row.status === 'completed' ? 'done' : 'run' })) };
  }
  if (session.dormant) return { win, windowId, threadId, available: false, last: '', text: '' };
  const value = await nativeWindowAt(target.ws).preview(threadId, session);
  return { win, windowId, threadId, available: value.available, last: value.last || '', text: value.text || '',
    model: value.model || '', effort: value.effort || '', tasks: value.tasks || null, tools: value.tools || [] };
}
