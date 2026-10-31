import { nativeTargets, nativeWindowAt, nativeSessionCatalog } from './native-windows.mjs';
import { windowName } from '../lib/notify.mjs';
import { fusionHistory, FUSION_ACTIVE } from './fusion/state.mjs';
import { readLibrary, sessionId } from '../lib/session-library.mjs';
import { samePath } from '../lib/platform.mjs';
import path from 'node:path';
import { storedProjectSession } from './project-windows.mjs';

const APP = { cursor: 'Cursor', codex: 'Codex', devin: 'Devin' };
const FUSION_WAIT = ['plan', 'disagree', 'check'];
const FUSION_RECENT_MS = 24 * 3600 * 1000;

export function overviewSnapshot(deviceId) {
  const now = Date.now(), windows = [], sessions = [];
  let ready = true;
  for (const win of nativeTargets()) {
    const source = nativeWindowAt(win.ws), snap = source?.snapshot;
    if (!snap) { ready = false; continue; }
    const id = win.app === 'codex' ? 'codex' : win.id, windowId = win.pageId || win.id, project = windowName(win.title, APP[win.app] || '');
    windows.push({ win: id, windowId, app: win.app, project });
    const catalog = nativeSessionCatalog(win.app);
    if (!catalog) ready = false;
    const rows = new Map((catalog?.rows || []).map(row => [sessionId(win.app, row.id), row]));
    const local = new Map((source.catalog || []).map(row => [sessionId(win.app, row.id), row]));
    const workspaceIds = new Set([...local.keys()].map(id => rows.get(id)?.workspaceId).filter(Boolean));
    const belongs = row => row.workspace
      ? (source.roots || []).some(root => (root.host || '') === (row.host || '') && samePath(root.root, row.workspace, !row.host))
      : !!row.workspaceId && workspaceIds.has(row.workspaceId);
    const projectRows = new Map([...rows].filter(([, row]) => belongs(row)));
    for (const [key, row] of local) if (belongs(row) || !row.workspace && win.app === 'cursor')
      projectRows.set(key, { ...rows.get(key), ...row, lastUsed: row.lastUsed || rows.get(key)?.lastUsed || 0 });
    for (const state of snap.states || []) {
      const key = sessionId(win.app, state.thread), row = projectRows.get(key), known = rows.get(key) || local.get(key);
      if (row || key === sessionId(win.app, snap.chat?.thread) && (!known?.workspace || belongs(known)))
        projectRows.set(key, { ...row, ...state, id: key, title: state.title || row?.title || '', lastUsed: state.lastUsed || row?.lastUsed || 0 });
    }
    for (const [key, row] of projectRows) {
      const record = readLibrary()[win.app]?.[key];
      if (!key || row.archived || record?.archived || record?.deleted) continue;
      const s = { ...row, busy: row.busy ?? row.running ?? false };
      const cachedPreview = source.previews.get(key);
      const preview = key !== sessionId(win.app, snap.chat?.thread) || cachedPreview?.at >= source.updatedAt ? cachedPreview?.value : null;
      sessions.push({
        win: id, windowId, threadId: key, app: win.app, project, title: record?.title || s.title || '未命名会话',
        busy: !!s.busy, waiting: s.waiting || '', waitingText: s.waitingText || '', last: preview?.available ? preview.last : s.last || '',
        startedAt: s.busy ? (Number.isFinite(s.runAt) ? s.runAt : Number.isFinite(s.generation?.start) ? s.generation.start : 0) : 0,
        tasks: s.tasks?.total > 0 ? { done: s.tasks.done, total: s.tasks.total, current: s.tasks.current || '' } : null,
        actions: s.actions || [], devin: !!s.devin, changed: s.changed || 0, acceptAll: !!s.acceptAll, changes: s.changes || null, lastUsed: Number.isFinite(s.lastUsed) ? s.lastUsed : 0,
        favorite: record?.favorite === true, lastMessageAt: Number(record?.lastMessageAt) || 0,
        workspace: row.workspace || '', host: row.host || '',
      });
    }
  }
  const present = new Set(sessions.map(s => s.app + ':' + s.threadId));
  for (const app of Object.keys(APP)) {
    const rows = new Map((nativeSessionCatalog(app)?.rows || []).map(row => [sessionId(app, row.id), row]));
    for (const [id, record] of Object.entries(readLibrary()[app] || {})) {
      if (!record.favorite || record.archived || record.deleted || present.has(app + ':' + id) || rows.get(id)?.archived) continue;
      const saved = storedProjectSession(app, id);
      const row = { ...saved, ...rows.get(id) };
      sessions.push({ win: app, windowId: saved?.ownerWindow || app, threadId: id, app,
        project: row.workspace ? path.basename(row.workspace) : '项目', title: record.title || row.title || '未命名会话',
        workspace: row.workspace || '', host: row.host || '', dormant: true, busy: false, waiting: '', waitingText: '', last: row.last || '',
        startedAt: 0, tasks: null, actions: [], devin: app === 'devin', changed: 0, acceptAll: false, changes: null,
        lastUsed: Number(row.lastUsed) || 0, favorite: true, lastMessageAt: Number(record.lastMessageAt) || 0 });
    }
  }
  const fusion = (fusionHistory[deviceId]?.runs || [])
    .filter(f => FUSION_ACTIVE.includes(f.phase) || FUSION_WAIT.includes(f.phase) || now - (f.updated || f.created || 0) < FUSION_RECENT_MS)
    .sort((a, b) => (b.updated || b.created || 0) - (a.updated || a.created || 0)).slice(0, 8)
    .map(f => ({ id: f.id, phase: f.phase || 'idle', round: f.round || 0, project: f.project?.name || '', a: f.a?.app || '', b: f.b?.app || '', updated: f.updated || f.created || 0,
      title: (f.history?.find(i => i.k === 'human')?.t || f.task || '新 Fusion 会话').split('\n')[0].slice(0, 60) }));
  return { os: process.platform, now, ready, windows, sessions, fusion };
}

export function overviewSession(deviceId, { win, windowId, threadId }) {
  const session = overviewSnapshot(deviceId).sessions.find(row => row.win === win && row.windowId === windowId && row.threadId === threadId);
  if (!session) throw new Error('会话已从目录移除，请刷新概览');
  const target = nativeTargets().find(row => row.app === session.app && (row.pageId || row.id) === windowId);
  return { session, target };
}

export async function overviewPreview(deviceId, { win, windowId, threadId }) {
  const { session, target } = overviewSession(deviceId, { win, windowId, threadId });
  if (session.dormant) return { win, windowId, threadId, available: false, last: '', text: '' };
  const value = await nativeWindowAt(target.ws).preview(threadId, session);
  return { win, windowId, threadId, available: value.available, last: value.last || '', text: value.text || '',
    model: value.model || '', effort: value.effort || '', tasks: value.tasks || null, tools: value.tools || [] };
}
