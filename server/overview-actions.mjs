import crypto from 'node:crypto';
import { computerId } from '../lib/auth.mjs';
import { favoriteSession } from '../lib/session-library.mjs';
import { Session } from './session.mjs';
import { overviewSession } from './overview.mjs';
import { NativeCdp, nativeWindowAt } from './native-windows.mjs';
import { catalogSessions, storedProjectSession } from './project-windows.mjs';

export async function manageOverviewSession(deviceId, body) {
  if (body.computer !== computerId()) throw new Error('所选电脑已变化，请刷新概览后重试');
  const { session, target } = overviewSession(deviceId, body);
  const { app, threadId, windowId } = session, action = body.action;
  const id = app === 'codex' ? `thread:${windowId}:${threadId}` : threadId;
  if (action === 'favorite') {
    if (body.favorite === true && !session.dormant) {
      const row = { ...storedProjectSession(app, threadId), id, title: session.title,
        ...(session.workspace ? { workspace: session.workspace, host: session.host } : {}) };
      delete row.dormant;
      catalogSessions(app, [row], windowId);
    }
    favoriteSession(app, threadId, body.favorite === true);
    return { ok: true };
  }
  if (action === 'copyLink') {
    if (app !== 'codex' || session.host) throw new Error('此会话没有本地 deeplink');
    return { text: `codex://threads/${threadId}` };
  }
  if (session.dormant) {
    if (action === 'actions') return { actions: [] };
    throw new Error('项目窗口已关闭，请先打开对话');
  }
  if (action === 'actions' && app === 'codex') return { actions: ['rename', 'archive'] };
  if (!['actions', 'rename', 'archive', 'delete', 'remove'].includes(action)) throw new Error('不支持的会话操作');
  const messages = [];
  const s = new Session({ readyState: 1, send: raw => messages.push(JSON.parse(raw)) }, deviceId);
  s.visible = s.notifyVisible = false;
  s.app = app;
  s.targetId = target.id;
  s.windowId = s.codexPageId = windowId;
  s.threadId = nativeWindowAt(target.ws).snapshot.chat?.thread || '';
  s.cdp = s.editorCdp = new NativeCdp(target.ws);
  // Management uses the native menu and library; it does not load a conversation screen.
  s.pollChat = s.listAgents = async () => {};
  try {
    await s.cdp.connect();
    if (action === 'actions') {
      await s.handle({ t: 'sessionActions', id });
      return { actions: messages.find(m => m.t === 'sessionActions').actions };
    }
    if (action === 'remove') {
      s.sessionEntries = new Map([[id, { id, app, running: session.busy }]]);
      await s.handle({ t: 'sessionBatch', ids: [id], requestId: crypto.randomUUID() });
      const result = messages.findLast(m => m.t === 'sessionBatchProgress').results[0];
      if (!result.ok) throw new Error(result.error);
    } else {
      await s.handle(app === 'codex'
        ? { t: action === 'rename' ? 'codexRename' : 'codexArchive', id, name: body.name }
        : { t: 'sessionManage', id, action, name: body.name });
    }
    return { ok: true };
  } finally {
    s.dispose();
  }
}

