import { nativeTargets, nativeWindowAt } from './native-windows.mjs';
import { windowName } from '../lib/notify.mjs';
import { fusionHistory, FUSION_ACTIVE } from './fusion/state.mjs';

const APP = { cursor: 'Cursor', codex: 'Codex', devin: 'Devin' };
const FUSION_WAIT = ['plan', 'disagree', 'check'];
const FUSION_RECENT_MS = 24 * 3600 * 1000;

export function overviewSnapshot(deviceId) {
  const now = Date.now(), windows = [], sessions = [];
  let ready = true;
  for (const win of nativeTargets()) {
    const snap = nativeWindowAt(win.ws)?.snapshot;
    if (!snap) { ready = false; continue; }
    const id = win.app === 'codex' ? 'codex' : win.id, windowId = win.pageId || win.id, project = windowName(win.title, APP[win.app] || '');
    windows.push({ win: id, windowId, app: win.app, project });
    for (const s of snap.states || []) sessions.push({
      win: id, windowId, threadId: s.thread || '', app: win.app, project, title: s.title || '',
      busy: !!s.busy, waiting: s.waiting || '', waitingText: s.waitingText || '', last: s.last || '',
      startedAt: s.busy ? (Number.isFinite(s.runAt) ? s.runAt : Number.isFinite(s.generation?.start) ? s.generation.start : 0) : 0,
      tasks: s.tasks?.total > 0 ? { done: s.tasks.done, total: s.tasks.total, current: s.tasks.current || '' } : null,
      actions: s.actions || [], devin: !!s.devin, changed: s.changed || 0, acceptAll: !!s.acceptAll, changes: s.changes || null, lastUsed: Number.isFinite(s.lastUsed) ? s.lastUsed : 0,
    });
  }
  const fusion = (fusionHistory[deviceId]?.runs || [])
    .filter(f => FUSION_ACTIVE.includes(f.phase) || FUSION_WAIT.includes(f.phase) || now - (f.updated || f.created || 0) < FUSION_RECENT_MS)
    .sort((a, b) => (b.updated || b.created || 0) - (a.updated || a.created || 0)).slice(0, 8)
    .map(f => ({ id: f.id, phase: f.phase || 'idle', round: f.round || 0, project: f.project?.name || '', a: f.a?.app || '', b: f.b?.app || '', updated: f.updated || f.created || 0,
      title: (f.history?.find(i => i.k === 'human')?.t || f.task || '新 Fusion 会话').split('\n')[0].slice(0, 60) }));
  return { os: process.platform, now, ready, windows, sessions, fusion };
}
