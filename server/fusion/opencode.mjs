import { openCode } from '../opencode/state.mjs';
import { createMessageID } from '../opencode/client.mjs';
import { createSession, manageOpenCodeSession } from '../apps/opencode.mjs';
import { localFilePath, samePath } from '../../lib/platform.mjs';

const windowId = 'opencode';
const identity = session => ({ app: windowId, threadId: session.id, host: '', cwd: localFilePath(session.directory),
  roots: [{ root: localFilePath(session.directory), host: '' }] });
const nativeRequest = (context, suffix = '', options) => openCode.client.request(
  `/session/${context.native.threadId}${suffix}`, { directory: context.native.cwd, ...options });

export const fusionOpenCode = {
  app: windowId, name: 'OpenCode', controller: false, worker: true, windowId,
  async connected() {
    return (await openCode.client.request('/global/health', { signal: AbortSignal.timeout(2500) })).healthy === true;
  },
  async models(directory) {
    const { providers } = await openCode.client.request('/config/providers', { directory, signal: AbortSignal.timeout(8000) });
    return providers.flatMap(provider => Object.values(provider.models).filter(model => model.status !== 'deprecated')
      .map(model => {
        const variants = Object.keys(model.variants || {});
        return { id: `${provider.id}/${model.id}`, label: `${provider.name} / ${model.name}`,
          efforts: variants.length ? [...new Set(['default', ...variants])] : [] };
      }));
  },
  async open(binding, { archived = false } = {}) {
    await openCode.connect();
    const session = await openCode.client.request(`/session/${binding.threadId}`, { directory: binding.project.root });
    if (session.id !== binding.threadId || !samePath(session.directory, binding.project.root))
      throw new Error('OpenCode 原生子会话身份或项目不一致');
    const native = identity(session);
    if (session.time.archived && !archived) throw new Error('OpenCode 原生子会话已归档');
    const context = { app: windowId, backend: windowId, page: { id: windowId }, native, archived: !!session.time.archived };
    if (!context.archived) {
      openCode.sessions.set(session.id, { ...session, directory: native.cwd });
      await openCode.loadMessages(session.id);
    }
    return context;
  },
  async create(_agent, _context, spec) {
    await openCode.connect();
    return identity(await createSession(spec.root, { title: spec.title }));
  },
  async prepareTask(context, attempt, task) {
    const denied = ['task', 'worktree_create', 'worktree_delete', ...(task.access === 'read' ? ['edit', 'bash'] : [])];
    await nativeRequest(context, '', { method: 'PATCH', body: {
      permission: denied.map(permission => ({ permission, pattern: '*', action: 'deny' })),
    } });
    context.model = attempt.model;
    context.effort = attempt.effort;
    return createMessageID();
  },
  info(_agent, context, catalog) {
    if (catalog === 'sendError') return null;
    const id = context.native.threadId, selected = openCode.selection(id);
    return { model: context.model || selected.key, effort: context.effort ?? selected.variant,
      usage: openCode.context(id), usageBasis: 'OpenCode 原生会话用量' };
  },
  async readTurn(_agent, context, { id = '' } = {}) {
    const threadId = context.native.threadId;
    const rows = openCode.messageRows(threadId);
    const users = rows.filter(row => row.info.role === 'user');
    const latest = users.at(-1), user = id ? users.find(row => row.info.id === id) : latest;
    const ids = users.map(row => row.info.id);
    if (!user) return { threadId, ids };
    const answer = rows.findLast(row => row.info.role === 'assistant' && row.info.parentID === user.info.id);
    const current = user === latest;
    const status = current ? openCode.statuses.get(threadId) : null;
    const error = answer?.info.error?.data?.message || answer?.info.error?.name || status?.error;
    const text = [...answer?.parts.values() || []].filter(part => part.type === 'text' && !part.synthetic).map(part => part.text).join('\n');
    const idle = !status || status.type === 'idle';
    const ended = idle && (!!error || !!answer?.info.time?.completed && answer.info.finish !== 'tool-calls');
    return { threadId, ids, id: user.info.id, turnId: user.info.id, current, accepted: true, ended,
      completed: ended && !error && !!text.trim(), text, error };
  },
  action(_agent, context, action, value) {
    if (action === 'stop') return nativeRequest(context, '/abort', { method: 'POST' });
    if (action !== 'send') throw new Error('OpenCode 不支持该子任务操作');
    const separator = context.model.indexOf('/');
    const model = { providerID: context.model.slice(0, separator), modelID: context.model.slice(separator + 1) };
    return nativeRequest(context, '/prompt_async', { method: 'POST', body: {
      messageID: value.messageId, model, ...(context.effort && context.effort !== 'default' ? { variant: context.effort } : {}),
      parts: [{ type: 'text', text: value.text }],
    } });
  },
  subscribe(context, changed) {
    return openCode.subscribe(id => {
      if (!openCode.connected) changed(new Error(openCode.error || 'OpenCode 事件连接已关闭'));
      else if (!id || id === context.native.threadId) changed();
    });
  },
  async content(_agent, context, history, before) {
    const id = context.native.threadId;
    let all = openCode.messageRows(id);
    let end = before == null ? all.length : all.findIndex(row => row.info.id === before);
    if (end < 0) throw new Error('没有找到所选 OpenCode 历史位置');
    const cursor = openCode.historyPages.get(id)?.before;
    if (history && before != null && end < 80 && cursor) {
      await openCode.loadMessages(id, cursor);
      all = openCode.messageRows(id);
      end = all.findIndex(row => row.info.id === before);
    }
    const start = Math.max(0, end - 80);
    const chat = openCode.chat(id, { rows: all.slice(start, end), children: false });
    Object.assign(chat, { earlier: start > 0 || !!openCode.historyPages.get(id)?.before, before: all[start]?.info.id });
    return chat;
  },
  async snapshot(context) {
    const chat = await this.content(null, context);
    const question = chat.items.find(row => row.k === 'opencodeQuestion');
    const permission = chat.items.find(row => row.i.startsWith('permission:'));
    return { chat, state: { waiting: question?.requestID || (permission && `${permission.i}:${permission.b.join('/')}`) || '',
      waitingText: chat.waitingText } };
  },
  async interaction(context, action, expectedTurn) {
    const { threadId, cwd: directory } = context.native;
    const question = action.kind === 'opencodeQuestion';
    const id = question ? action.id : String(action.item).slice('permission:'.length);
    const pending = (question ? openCode.questions : openCode.permissions).get(id);
    if (pending?.sessionID !== threadId || (await this.readTurn(null, context)).turnId !== expectedTurn)
      throw new Error('OpenCode 原生交互已处理或不属于此子任务');
    if (question) return openCode.client.request(`/question/${id}/${action.reject ? 'reject' : 'reply'}`, {
      directory, method: 'POST', ...(action.reject ? {} : { body: { answers: action.answers } }),
    });
    if (action.kind !== 'button' || !['once', 'reject'].includes(action.actionId)) throw new Error('未知的 OpenCode 审批操作');
    return openCode.client.request(`/permission/${id}/reply`, { directory, method: 'POST', body: { reply: action.actionId } });
  },
  cleanupState(_agent, context) {
    return { exists: true, context: context.native, running: !context.archived
      && ['busy', 'retry'].includes(openCode.statuses.get(context.native.threadId)?.type) };
  },
  async cleanup(_agent, context) {
    if (!context.archived) await manageOpenCodeSession(context.native.threadId, 'archive');
    return { confirmed: true, action: 'archive' };
  },
};
