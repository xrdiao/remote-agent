import { EDITORS } from '../config.mjs';
import { fusionMcp } from './mcp.mjs';

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
    if (this.transport === 'mcp' && spec.role === 'main') {
      const channel = await this.mcpChannel(agent, context, creation, spec);
      agent.publish(controller);
      spec = { ...spec, mcp: channel.config };
    }
    return this.action(agent, context, 'create', spec);
  }
  models(agent, context) { return agent.call(context, 'modelItemsFast(true)', context.native.threadId ? context.native : null); }
  readTurn(agent, context, { id = '', attemptId = '', previous = [], generationId = '' } = {}) {
    return agent.call(context, `codexFusionTurn(${JSON.stringify(id)}, ${JSON.stringify(attemptId)}, ${JSON.stringify(previous)}, ${JSON.stringify(generationId)})`);
  }
  content(agent, context, history, before) {
    return agent.call(context, `extract(${history === true}, [], 80)`, { ...context.native, ...(before != null ? { before } : {}) });
  }
  mcpChannel(agent, context, binding, spec) {
    return fusionMcp.bind(binding, {
      tools: spec.tools, instructions: spec.instructions,
      identify: args => this.info(agent, { ...context, native: { ...context.native,
        threadId: binding.threadId || binding.nativeThreadId } }, 'fusionCall', args),
      changed: () => context.fusionChanged?.(),
    });
  }
  async bindController(agent, context, controller, spec) {
    if (this.transport === 'mcp') {
      const binding = controller.bindings.find(row => row.id === controller.main.bindingId);
      context.fusionMcp = await this.mcpChannel(agent, context, binding, spec);
      agent.publish(controller);
      spec = { ...spec, mcp: context.fusionMcp.config };
    }
    return this.action(agent, context, 'bindTools', spec);
  }
  async unbindController(agent, context) {
    try { return await this.action(agent, context, 'unbindTools'); }
    finally { await context.fusionMcp?.close(); context.fusionMcp = null; }
  }
  toolRequests(agent, context) {
    return context.fusionMcp ? context.fusionMcp.requests() : this.info(agent, context, 'tools');
  }
  replyTool(agent, context, request, result) {
    return context.fusionMcp ? context.fusionMcp.reply(request.id, result)
      : this.action(agent, context, 'toolReply', { requestId: request.id, result });
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

for (const { app, name } of EDITORS)
  registerNativeAgentProvider(new NativeAgentProvider({ app, name, transport: app === 'devin' ? 'mcp' : 'native' }));
