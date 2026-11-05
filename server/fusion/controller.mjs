import crypto from 'node:crypto';
import { FUSION_TOOLS } from './control.mjs';
import { fusionLive, fusionEvent, newFusionAttempt, publishFusion } from './state.mjs';

// The native conversation owns chat, input, models and permissions. This observer
// handles only this conversation's registered management tools and event inbox.
export class FusionController {
  constructor(runner) { this.runner = runner; this.controller = runner.run; this.pending = new Set(); }
  async start() {
    if (this.context) return;
    if (this.starting) return this.starting;
    this.starting = this.connect().finally(() => { this.starting = null; });
    return this.starting;
  }
  async connect() {
    const controller = this.controller, binding = controller.bindings.find(row => row.id === controller.main.bindingId);
    if (!binding) return;
    const context = await this.runner.agent.openBinding(controller, binding);
    try {
      await this.runner.agent.call(context, `nativeSessionAction('codex', ${JSON.stringify(binding.threadId)}, 'bindTools', ${JSON.stringify(FUSION_TOOLS.map(row => row.name))})`);
      this.context = context;
      context.cdp.onclose = error => this.failed(error);
      this.unsubscribe = context.source.subscribe(error => error ? this.failed(error) : this.check(), context.native);
      await this.check();
    } catch (error) { await this.close(); if (this.context !== context) await this.runner.agent.close(context); throw error; }
  }
  async close() {
    const context = this.context;
    this.context = null;
    this.unsubscribe?.(); this.unsubscribe = null;
    if (!context) return;
    try { await this.runner.agent.call(context, `nativeSessionAction('codex', ${JSON.stringify(context.native.threadId)}, 'unbindTools')`); }
    finally { await this.runner.agent.close(context); }
  }
  failed(error) {
    if (!this.context) return;
    const turns = new Set();
    for (const attempt of this.controller.attempts.filter(row => row.kind === 'main' && !row.endedAt && row.native)) {
      attempt.status = 'unknown'; attempt.error = error.message; turns.add(attempt.native.turnId);
    }
    for (const attempt of this.controller.attempts.filter(row => row.kind === 'task' && !row.endedAt && turns.has(row.native?.turnId))) {
      attempt.status = 'unknown'; attempt.error = error.message;
    }
    this.runner.blockMain(error);
    this.close().catch(() => {});
  }
  async check() {
    if (!this.context) return;
    if (this.reading) { this.again = true; return this.reading; }
    this.reading = this.read().catch(error => this.failed(error)).finally(() => {
      this.reading = null;
      if (this.again) { this.again = false; this.check(); }
    });
    return this.reading;
  }
  async read() {
    const context = this.context, controller = this.controller;
    const snapshot = await context.source.readConversation(context.native, true);
    if (this.context !== context) return;
    fusionLive.set(controller.main.bindingId, { ...snapshot, at: Date.now() });
    const turn = await this.runner.agent.call(context, 'codexFusionTurn()');
    this.latest = { snapshot, turn };
    if (turn.id && turn.accepted) {
      let attempt = controller.attempts.find(row => row.bindingId === controller.main.bindingId && row.kind === 'main' && row.native?.turnId === turn.turnId);
      attempt ||= controller.attempts.find(row => row.kind === 'main' && row.origin === 'events'
        && !row.endedAt && turn.user?.includes(row.id));
      if (!attempt && !controller.observedMainTurns.includes(turn.turnId)) {
        attempt = newFusionAttempt(controller, null, null, 'main');
        attempt.origin = 'user'; attempt.bindingId = controller.main.bindingId;
      }
      if (attempt && attempt.origin !== 'events' && !attempt.acceptedAt) {
        const settings = await this.runner.agent.call(context,
          `nativeSessionInfo('codex', ${JSON.stringify(context.native.threadId)}, 'settings')`);
        controller.main.model = settings.model; controller.main.effort = settings.effort || '';
        attempt.model = settings.model; attempt.effort = settings.effort || '';
        Object.assign(attempt, { status: 'running', submission: 'accepted', acceptedAt: Date.now(),
          native: { threadId: turn.threadId, turnId: turn.turnId, messageId: turn.id } });
        controller.observedMainMessages.push(turn.id); controller.observedMainTurns.push(turn.turnId);
        if (attempt.origin === 'user') {
          const event = fusionEvent(controller, 'user_input', { text: turn.user, native: attempt.native }, `user:${turn.threadId}:${turn.id}`);
          event.deliveredTo = turn.turnId;
          if (controller.status === 'blocked') { controller.status = 'running'; controller.blockedReason = ''; }
        } else for (const id of attempt.eventIds || []) {
          const event = controller.events.find(row => row.id === id);
          if (event) event.deliveredTo = turn.turnId;
        }
        publishFusion(controller);
      }
      if (attempt && attempt.origin !== 'events' && turn.ended && !attempt.endedAt)
        await this.runner.mainEnded(attempt.id, turn);
    }
    const requests = await this.runner.agent.call(context,
      `nativeSessionInfo('codex', ${JSON.stringify(context.native.threadId)}, 'tools')`);
    for (const request of requests) {
      const key = `${request.params.turnId}:${String(request.id)}`;
      if (this.pending.has(key)) continue;
      this.pending.add(key);
      try {
        const native = { threadId: request.params.threadId, turnId: request.params.turnId,
          requestId: request.id, decisionId: crypto.randomUUID() };
        let result, value;
        try {
          if (request.params.tool !== 'ra_fusion') throw new Error('未注册这个主控工具');
          value = await this.runner.control(request.params.arguments, native);
          result = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] };
        } catch (error) {
          result = { success: false, contentItems: [{ type: 'inputText', text: error.message }] };
          fusionEvent(controller, 'control_error', { native, reason: error.message }, `control-error:${key}`);
          // The model receives this error in the current native turn.
          controller.events.at(-1).deliveredTo = native.turnId;
          publishFusion(controller);
        }
        await this.runner.agent.call(context,
          `nativeSessionAction('codex', ${JSON.stringify(context.native.threadId)}, 'toolReply', ${JSON.stringify({ requestId: request.id, result })})`);
        this.runner.acknowledge(native, value?.events?.map(event => event.id));
      } finally { this.pending.delete(key); }
    }
  }
  async idle() {
    await this.start();
    if (!this.context) return false;
    await this.check();
    return !this.latest?.snapshot.state?.run || this.latest.snapshot.state.run.status === 'idle'
      || !!this.latest?.turn.ended;
  }
  async stop(attempt) {
    await this.start();
    if (!this.context) throw new Error('主会话已断开，停止待核对');
    const turn = await this.runner.agent.call(this.context, `codexFusionTurn(${JSON.stringify(attempt.native?.messageId || '')})`);
    if (turn.ended) { await this.check(); return; }
    if (!turn.current || turn.turnId !== attempt.native?.turnId) throw new Error('主会话已不在本次轮次，未停止其他执行');
    await this.runner.agent.call(this.context, `nativeSessionAction('codex', ${JSON.stringify(this.context.native.threadId)}, 'stop')`);
    await this.check();
  }
}
