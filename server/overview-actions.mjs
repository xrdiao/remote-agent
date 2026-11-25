import crypto from 'node:crypto';
import { computerId } from '../lib/auth.mjs';
import { favoriteSession } from '../lib/session-library.mjs';
import { withTemporarySession } from './session.mjs';
import { overviewSession } from './overview.mjs';
import { NativeCdp, nativeWindowAt } from './native-windows.mjs';
import { helpersCall } from './page/build.mjs';
import { samePath } from '../lib/platform.mjs';
import { catalogSessions, storedProjectSession } from './project-windows.mjs';
import { manageFusionWorkbench } from './fusion/owner.mjs';
import { manageOpenCodeSession } from './apps/opencode.mjs';
import { codexBackend, CODEX_BACKEND } from './codex/state.mjs';
import { adapter as codexAdapter } from './apps/codex.mjs';
import { publishSessionChange } from '../lib/session-library.mjs';

export async function inspectCodexOverviewSession(deviceId, request) {
  if (request.computer !== computerId() || request.win !== 'codex') throw new Error('Codex 会话核对目标不一致');
  const { session, target } = overviewSession(deviceId, request);
  const { threadId, host, workspace } = session;
  if (session.workspaceMissing) return { status: 'workspace-missing', threadId };
  let state;
  if (host) {
    const source = target && nativeWindowAt(target.ws);
    if (!source) throw new Error('Codex 原生会话目录尚未就绪');
    state = await source.cdp.evaluate(helpersCall(`nativeSessionInfo('codex', ${JSON.stringify(threadId)}, 'cleanup')`,
      { app: 'codex', threadId, host }));
  } else {
    await codexBackend.client.connect();
    let thread;
    try {
      ({ thread } = await codexBackend.client.request('thread/read', { threadId, includeTurns: false }, { timeout: 8000 }));
    } catch (error) {
      if (/thread.*not found|no rollout found|thread.*does not exist/i.test(error.message)) return { status: 'missing', threadId };
      throw error;
    }
    if (thread?.id !== threadId) throw new Error('Codex 原生目录返回了不同的会话');
    state = { exists: true, archived: /[\\/]archived_sessions[\\/]/.test(thread.path || ''), context: { cwd: thread.cwd } };
  }
  if (!state.exists) return { status: 'missing', threadId };
  if (state.archived) return { status: 'archived', threadId };
  if (workspace && !samePath(state.context?.cwd || '', workspace, !host)) throw new Error('Codex 原生会话项目已变化');
  return { status: 'available', threadId };
}

export async function manageOverviewSession(deviceId, body) {
  if (body.computer !== computerId()) throw new Error('所选电脑已变化，请刷新概览后重试');
  if (body.win === 'fusion') return manageFusionWorkbench(body);
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
  if (app === 'codex' && (windowId === CODEX_BACKEND || action === 'rename' && !session.host && !session.dormant)) {
    if (action === 'actions') return { actions: ['rename', 'archive'] };
    const title = await codexAdapter.manageBackendThread(threadId, action, body.name, windowId);
    publishSessionChange('codex', threadId, { action, ...(action === 'rename' ? { title } : {}) });
    return { ok: true };
  }
  if (session.dormant) {
    if (action === 'actions') return { actions: [] };
    throw new Error('项目窗口已关闭，请先打开对话');
  }
  if (action === 'actions' && app === 'codex') return { actions: ['rename', 'archive'] };
  if (app === 'opencode') return manageOpenCodeSession(threadId, action, body.name);
  if (!['actions', 'rename', 'archive', 'delete', 'remove'].includes(action)) throw new Error('不支持的会话操作');
  const messages = [];
  return withTemporarySession({ readyState: 1, send: raw => messages.push(JSON.parse(raw)) }, deviceId, async s => {
    s.visible = s.notifyVisible = false;
    s.app = app;
    s.targetId = target.id;
    s.windowId = s.codexPageId = windowId;
    s.threadId = nativeWindowAt(target.ws).snapshot.chat?.thread || '';
    s.cdp = s.editorCdp = new NativeCdp(target.ws);
    // Management uses the native menu and library; it does not load a conversation screen.
    s.pollChat = s.listAgents = async () => {};
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
  });
}

