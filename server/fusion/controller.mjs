import crypto from 'node:crypto';
import { FUSION_TOOLS, fusionAutonomyContext } from './control.mjs';
import { fusionEvent, newFusionAttempt, publishFusion } from './state.mjs';

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
      await this.runner.agent.call(context, `nativeSessionAction('codex', ${JSON.stringify(binding.threadId)}, 'bindTools', ${JSON.stringify({
        names: FUSION_TOOLS.map(row => row.name), authorization: fusionAutonomyContext(controller),
      })})`);
      this.context = context;
      context.cdp.onclose = error => this.failed(error);
      this.unsubscribe = context.source.subscribe(error => error ? this.failed(error) : this.check(), context.native, 'fusion-control');
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
  acknowledgeUserAnswers() {
    const run = this.controller, threadId = run.bindings.find(row => row.id === run.main.bindingId)?.threadId;
    const origins = new Map(run.commands.filter(row => row.action === 'ask_user').map(row => [row.result.questionId, row.native]));
    const pending = run.questions.filter(row => !row.answeredAt), counts = new Map();
    for (const question of pending) {
      const origin = origins.get(question.id);
      if (origin?.threadId === threadId) counts.set(origin.turnId, (counts.get(origin.turnId) || 0) + 1);
    }
    const history = run.attempts.filter(row => row.kind === 'main' && row.acceptedAt && row.native?.threadId === threadId)
      .sort((a, b) => a.acceptedAt - b.acceptedAt);
    const turns = new Map(history.map((attempt, index) => [attempt.native.turnId, index]));
    const events = new Map(run.events.filter(row => row.type === 'user_input' && row.data.native?.threadId === threadId)
      .map(row => [row.data.native.turnId, row]));
    let changed = false;
    for (const question of pending) {
      const origin = origins.get(question.id), index = turns.get(origin?.turnId);
      if (origin?.threadId !== threadId || counts.get(origin.turnId) !== 1 || index === undefined) continue;
      const attempt = history[index + 1], event = events.get(attempt?.native.turnId);
      if (attempt?.origin !== 'user' || attempt.native?.threadId !== threadId || !attempt.acceptedAt || !event
          || event.data.native.messageId !== attempt.native.messageId) continue;
      Object.assign(question, { answer: event.data.text, answeredAt: event.at, inputId: event.id });
      Object.assign(event.data, { workId: question.workId, taskId: question.taskId, questionId: question.id });
      const task = run.tasks.find(row => row.id === question.taskId);
      if (task) task.inputs.push({ id: event.id, text: event.data.text, created: event.at, deliveredAt: null });
      changed = true;
    }
    if (changed) publishFusion(run);
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
    const [turn, requests] = await Promise.all([
      this.runner.agent.call(context, 'codexFusionTurn()'),
      this.runner.agent.call(context, `nativeSessionInfo('codex', ${JSON.stringify(context.native.threadId)}, 'tools')`),
    ]);
    if (this.context !== context) return;
    this.latest = { turn, requests };
    if (turn.id && turn.accepted) {
      let attempt = controller.attempts.find(row => row.bindingId === controller.main.bindingId && row.kind === 'main' && row.native?.turnId === turn.turnId);
      attempt ||= controller.attempts.find(row => row.kind === 'main' && row.origin === 'events'
        && !row.endedAt && turn.user?.includes(row.id));
      if (!attempt && !controller.observedMainTurns.includes(turn.turnId)) {
        attempt = newFusionAttempt(controller, null, null, 'main');
        attempt.origin = 'user'; attempt.bindingId = controller.main.bindingId;
      }
      if (attempt && !attempt.acceptedAt) {
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
        }
        publishFusion(controller);
      }
      this.acknowledgeUserAnswers();
      if (attempt && attempt.origin !== 'events' && turn.ended && !attempt.endedAt)
        await this.runner.mainEnded(attempt.id, turn);
    }
    for (const request of requests) {
      const key = `${request.params.turnId}:${String(request.id)}`;
      if (this.pending.has(key)) continue;
      this.pending.add(key);
      try {
        const native = { threadId: request.params.threadId, turnId: request.params.turnId,
          requestId: request.id, callId: request.params.callId, decisionId: crypto.randomUUID() };
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
    return !!this.latest?.turn.ended || this.latest?.turn.turnId === '' && !this.latest.requests.length;
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
