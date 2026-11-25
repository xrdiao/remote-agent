import { EDITORS } from '../config.mjs';
import { fusionMcp } from './mcp.mjs';
import { CODEX_BACKEND, codexBackend } from '../codex/state.mjs';
import { fusionOpenCode } from './opencode.mjs';

const providers = new Map();

// One adapter per native application. Models and reasoning settings are data.
export class NativeAgentProvider {
  constructor({ app, name, transport = 'native', controller = true, worker = true }) {
    Object.assign(this, { app, name, transport, controller, worker });
  }
  info(agent, context, catalog, value = null) {
    return agent.call(context, `nativeSessionInfo(${JSON.stringify(this.app)}, ${JSON.stringify(context.native.threadId)}, ${JSON.stringify(catalog)}, ${JSON.stringify(value)})`);
  }
  action(agent, context, action, value) {
    return agent.call(context, `nativeSessionAction(${JSON.stringify(this.app)}, ${JSON.stringify(context.native.threadId)}, ${JSON.stringify(action)}, ${JSON.stringify(value)})`);
  }
  async create(agent, context, spec, controller, creation) {
    if ((this.transport !== 'mcp' && this.app !== 'codex') || spec.role !== 'main') return this.action(agent, context, 'create', spec);
    const channel = await this.mcpChannel(agent, context, creation, spec, mcp => agent.commit(controller, next => {
      next.main.creations.find(row => row.id === creation.id).mcp = mcp;
    }));
    try { return await this.action(agent, context, 'create', { ...spec, mcp: channel.config }); }
    finally { await channel.close(); }
  }
  submit(agent, context, value, beforeSubmit) {
    beforeSubmit();
    return this.action(agent, context, 'send', value);
  }
  stop(agent, context, native) { return this.action(agent, context, 'stop', native); }
  async status(agent, context) {
    const { state, questions, items } = await this.info(agent, context, 'fusionState');
    return { state, chat: { questions, items } };
  }
  subscribe(context, changed) { return context.source.subscribe(changed, context.native, 'fusion-control'); }
  interaction(agent, context, action) {
    if (this.app === 'codex' && action.kind === 'codexRequest')
      return agent.call(context, `codexRequestAction(${JSON.stringify(String(action.id))}, ${Number(action.n)}, ${JSON.stringify(action.fields || [])})`);
    if (this.app === 'devin' && action.kind === 'codexRequest' || ['cursor', 'devin'].includes(this.app) && action.kind === 'question')
      return this.action(agent, context, 'question', action);
    if (this.app === 'cursor' && action.kind === 'button') return this.action(agent, context, 'permission', action.actionId);
    throw new Error('该原生交互尚无不切换普通会话的后台接口');
  }
  models(agent, context) { return agent.call(context, 'modelItemsFast(true)', context.native.threadId || this.app === 'devin' ? context.native : null); }
  readTurn(agent, context, { id = '', attemptId = '', previous = [], generationId = '' } = {}) {
    return agent.call(context, `codexFusionTurn(${JSON.stringify(id)}, ${JSON.stringify(attemptId)}, ${JSON.stringify(previous)}, ${JSON.stringify(generationId)})`);
  }
  content(agent, context, history, before) {
    return agent.call(context, `extract(${history === true}, [], 80)`, { ...context.native, ...(before != null ? { before } : {}) });
  }
  mcpChannel(agent, context, binding, spec, recordConfig) {
    return fusionMcp.bind(binding, {
      tools: spec.tools, instructions: spec.instructions,
      identify: args => this.info(agent, { ...context, native: { ...context.native,
        threadId: binding.threadId || binding.nativeThreadId } }, 'fusionCall', { ...args, ...(this.app === 'codex' ? { server: 'ra-fusion' } : {}) }),
      changed: () => context.fusionChanged?.(), recordConfig,
    });
  }
  async bindController(agent, context, controller, spec) {
    const binding = controller.bindings.find(row => row.id === controller.main.bindingId);
    if (this.transport === 'mcp' || this.app === 'codex' && binding.mcp) {
      context.fusionMcp ||= await this.mcpChannel(agent, context, binding, spec, mcp => agent.commit(controller, next => {
        next.bindings.find(row => row.id === binding.id).mcp = mcp;
      }));
      spec = { ...spec, mcp: context.fusionMcp.config };
    }
    return this.action(agent, context, 'bindTools', spec);
  }
  async unbindController(agent, context) {
    try { return this.app === 'codex' && context.fusionMcp ? true : await this.action(agent, context, 'unbindTools'); }
    finally { await context.fusionMcp?.close(); context.fusionMcp = null; }
  }
  cleanupState(agent, context) { return this.info(agent, context, 'cleanup'); }
  cleanup(agent, context) { return this.action(agent, context, 'cleanup'); }
  toolRequests(agent, context) {
    return context.fusionMcp ? context.fusionMcp.requests() : this.info(agent, context, 'tools');
  }
  replyTool(agent, context, request, result) {
    return context.fusionMcp ? context.fusionMcp.reply(request.id, result)
      : this.action(agent, context, 'toolReply', { requestId: request.id, result });
  }
  toolReplyReceipt(agent, context, data) {
    return this.info(agent, context, 'toolReceipt', { host: data.codexReceipt.host, transport: data.codexReceipt.transport, native: data.native });
  }
}

export function registerNativeAgentProvider(provider) {
  providers.set(provider.app, provider);
  return () => providers.delete(provider.app);
}
export function nativeAgentProvider(app) {
  const provider = providers.get(app);
  if (!provider) throw new Error(`没有登记 ${app} 的原生软件接口`);
  return provider;
}
export function nativeAgentProviders() { return [...providers.values()]; }

export function fusionProviderFor(context, adapterRegistry) {
  const transport = context.backend === CODEX_BACKEND ? 'backend' : context.app === 'opencode' ? 'api' : 'window';
  if (adapterRegistry && !adapterRegistry[context.app]?.native[transport])
    throw new Error('未登记 Fusion 原生传输');
  if (transport === 'backend' && context.app === 'codex') return backgroundCodex;
  return nativeAgentProvider(context.app);
}

for (const { app, name } of EDITORS)
  registerNativeAgentProvider(new NativeAgentProvider({ app, name, transport: app === 'devin' ? 'mcp' : 'native' }));
registerNativeAgentProvider(fusionOpenCode);

const codexThread = id => codexBackend.threads.get(id) || codexBackend.read(id);
const codexIdentity = thread => ({ app: 'codex', threadId: thread.id, host: '', cwd: thread.cwd, roots: [{ root: thread.cwd, host: '' }] });
export const backgroundCodex = {
  async open(threadId) {
    const thread = await codexBackend.readModelState(threadId);
    return { app: 'codex', backend: CODEX_BACKEND, page: { id: CODEX_BACKEND }, native: codexIdentity(thread) };
  },
  async create(_agent, _context, spec) {
    return codexIdentity(await codexBackend.create(spec.root, spec));
  },
  async models() {
    await codexBackend.client.connect();
    const models = [];
    let cursor = null;
    do {
      const page = await codexBackend.client.request('model/list', { cursor, limit: 100, includeHidden: false });
      models.push(...page.data.map(row => ({ id: row.model || row.id, label: row.displayName || row.id,
        efforts: (row.supportedReasoningEfforts || []).map(item => item.reasoningEffort), source: 'Codex 后台模型目录' })));
      cursor = page.nextCursor;
    } while (cursor);
    return models;
  },
  async info(_agent, { native: { threadId } }, catalog) {
    if (catalog === 'sendError') return null;
    const thread = await codexBackend.readModelState(threadId);
    const { model = thread.model, effort = thread.reasoningEffort } = thread.settings || {};
    const usage = Object.values(codexBackend.statistics.get(threadId) || {}).findLast(row => row.usage)?.usage;
    return { model, effort, family: model, usage: usage || null, usageBasis: 'Codex 后台原生会话用量' };
  },
  async readTurn(_agent, { native: { threadId } }, { id = '', attemptId = '', generationId = '' } = {}) {
    const { turns } = await codexThread(threadId);
    const message = item => item.type === 'userMessage' && (item.clientId ? `${threadId}:user-message:${item.clientId}` : item.id);
    const receipt = attemptId ? `${threadId}:user-message:${attemptId}` : id;
    const turn = generationId ? turns.find(row => row.id === generationId)
      : receipt ? turns.find(row => row.items.some(item => message(item) === receipt)) : turns.at(-1);
    const user = turn?.items.find(item => message(item) && (!receipt || message(item) === receipt || message(item) === id));
    const ended = ['completed', 'failed', 'interrupted'].includes(turn?.status);
    const text = turn?.items.findLast(item => item.type === 'agentMessage' && item.text?.trim())?.text || '';
    return { threadId, id: user && message(user), ids: turns.flatMap(row => row.items.map(message).filter(Boolean)),
      turnId: turn?.id, generationId: turn?.id, accepted: !!user, current: turn === turns.at(-1),
      ended, completed: turn?.status === 'completed', text, error: turn?.error?.message };
  },
  action(_agent, { native: { threadId } }, action, value) {
    if (action === 'send') return codexBackend.runCommand(threadId, () => codexBackend.send(threadId,
      [{ type: 'text', text: value.text, text_elements: [] }], 'idle', value.requestId));
    if (action === 'stop') return codexBackend.stop(threadId, value);
    if (!['model', 'effort'].includes(action)) throw new Error('不支持的 Codex 后台会话操作');
    const field = action === 'effort' ? 'effort' : 'model';
    return codexBackend.withWriter(threadId, async thread => {
      await codexBackend.client.request('thread/settings/update', { threadId, [field]: value });
      thread.settings[field] = value;
      codexBackend.remember(thread);
    });
  },
  submit(_agent, { native: { threadId } }, value, beforeSubmit, changed) {
    return codexBackend.runCommand(threadId, () => codexBackend.send(threadId,
      [{ type: 'text', text: value.text, text_elements: [] }], 'idle', value.requestId, {
        beforeSubmit, unknown(_error, awaitingReceipt) { if (!awaitingReceipt) changed(_error); },
        acceptLate: () => changed(), rejectLate: changed,
      }));
  },
  observe(context, action) { return codexBackend.withWriter(context.native.threadId, action); },
  stop(agent, context, native) { return this.action(agent, context, 'stop', native.turnId); },
  interaction(_agent, context, action, native) {
    if (action.kind !== 'codexRequest') throw new Error('未知的 Codex 原生交互');
    return this.answer(context.native.threadId, native.turnId, action);
  },
  async content(_agent, { native: { threadId } }, history, before) {
    const thread = await codexThread(threadId);
    const chat = codexBackend.chat(threadId, history ? Infinity : 80, thread);
    if (history && before != null) {
      const index = chat.items.findIndex(item => item.i === before);
      if (index < 0) throw new Error('没有找到所选历史位置');
      chat.items = chat.items.slice(Math.max(0, index - 80), index);
      chat.earlier = index > 80;
    }
    if (chat.earlier) chat.before = chat.items[0]?.i;
    return chat;
  },
  subscribe(context, changed) { return codexBackend.subscribe(context.native.threadId, changed); },
  async status(_agent, context) {
    const threadId = context.native.threadId;
    const chat = await this.content(null, context, false);
    return { chat, state: { run: chat.run, waiting: chat.questions.requests[0]?.id || '', waitingText: chat.waitingText,
      thread: threadId, busy: chat.busy } };
  },
  answer(threadId, expectedTurn, action) {
    if (!expectedTurn) throw new Error('尚未核对该任务的原生轮次');
    return codexBackend.answer(threadId, String(action.id), Number(action.n), action.fields || [], expectedTurn);
  },
  async cleanupState(_agent, { native: { threadId } }) {
    const thread = await codexThread(threadId);
    const archived = /[\\/]archived_sessions[\\/]/.test(thread.path || '');
    return { exists: true, archived, running: thread.turns.some(turn => turn.status === 'inProgress'), context: codexIdentity(thread) };
  },
  async cleanup(_agent, { native: { threadId } }) {
    await codexBackend.manage(threadId, 'archive');
    return { confirmed: true, action: 'archive' };
  },
};
