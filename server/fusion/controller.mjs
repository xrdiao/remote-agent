import crypto from 'node:crypto';
import { FUSION_TOOLS, fusionAutonomyContext, fusionControllerPrompt } from './control.mjs';
import { fusionEvent, newFusionAttempt, publishFusion } from './state.mjs';
import { nativeAgentProvider } from './providers.mjs';

// The native conversation owns chat, input, models and permissions. This observer
// handles only this conversation's registered management tools and event inbox.
export class FusionController {
  constructor(runner) { this.runner = runner; this.controller = runner.run; this.pending = new Set(); this.waiting = new Map(); this.delivering = new Set(); }
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
    context.native = { ...context.native, fusionController: true };
    try {
      context.fusionChanged = () => this.check();
      await this.bind(context);
      this.context = context;
      context.cdp.onclose = error => this.failed(error);
      this.unsubscribe = context.source.subscribe(error => error ? this.failed(error) : this.check(), context.native, 'fusion-control');
      await this.check();
    } catch (error) { this.context = context; await this.close(); throw error; }
  }
  async bind(context) {
    const result = await nativeAgentProvider(this.controller.main.app).bindController(this.runner.agent, context, this.controller, {
      names: FUSION_TOOLS.map(row => row.name), tools: FUSION_TOOLS,
      authorization: fusionAutonomyContext(this.controller), instructions: fusionControllerPrompt(this.controller),
    });
    this.profileReady = result.profileReady;
  }
  async close() {
    const context = this.context;
    this.context = null;
    for (const native of this.waiting.values()) this.runner.cancelWait(native);
    this.unsubscribe?.(); this.unsubscribe = null;
    if (!context) return;
    try { await nativeAgentProvider(this.controller.main.app).unbindController(this.runner.agent, context); }
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
      nativeAgentProvider(controller.main.app).readTurn(this.runner.agent, context),
      nativeAgentProvider(controller.main.app).toolRequests(this.runner.agent, context),
    ]);
    if (this.context !== context) return;
    this.latest = { turn, requests };
    if (this.profileReady === false && (turn.ended || !turn.turnId)) await this.bind(context);
    let acceptedInput = false;
    if (turn.id && turn.accepted) {
      let attempt = controller.attempts.find(row => row.bindingId === controller.main.bindingId && row.kind === 'main' && row.native?.turnId === turn.turnId);
      attempt ||= controller.attempts.find(row => row.kind === 'main' && row.origin === 'events'
        && !row.endedAt && turn.user?.includes(row.id));
      if (!attempt && !controller.observedMainTurns.includes(turn.turnId)) {
        attempt = newFusionAttempt(controller, null, null, 'main');
        attempt.origin = 'user'; attempt.bindingId = controller.main.bindingId;
      }
      if (attempt && !attempt.acceptedAt) {
        const settings = await nativeAgentProvider(controller.main.app).info(this.runner.agent, context, 'settings');
        controller.main.model = settings.model; controller.main.effort = settings.effort || '';
        attempt.model = settings.model; attempt.effort = settings.effort || '';
        Object.assign(attempt, { status: 'running', submission: 'accepted', acceptedAt: Date.now(),
          native: { threadId: turn.threadId, turnId: turn.turnId, messageId: turn.id,
            ...(turn.generationId ? { generationId: turn.generationId } : {}) } });
        controller.observedMainTurns.push(turn.turnId);
        publishFusion(controller);
      }
      if (attempt && !controller.observedMainMessages.includes(turn.id)) {
        controller.observedMainMessages.push(turn.id);
        if (attempt.origin === 'user' || turn.id !== attempt.native.messageId) {
          const native = { ...attempt.native, messageId: turn.id };
          const event = fusionEvent(controller, 'user_input', { text: turn.user, native }, `user:${turn.threadId}:${turn.id}`);
          event.deliveredTo = turn.turnId;
          acceptedInput = true;
          if (controller.status === 'blocked') { controller.status = 'running'; controller.blockedReason = ''; }
        }
        publishFusion(controller);
      }
      this.acknowledgeUserAnswers();
      if (attempt && attempt.origin !== 'events' && turn.ended && !attempt.endedAt)
        await this.runner.mainEnded(attempt.id, turn);
    }
    for (const attempt of controller.attempts.filter(row => row.kind === 'main' && row.bindingId === controller.main.bindingId
      && row.status === 'stopping' && !row.endedAt && row.native?.messageId)) {
      const execution = await nativeAgentProvider(controller.main.app).readTurn(this.runner.agent, context,
        { id: attempt.native.messageId, generationId: attempt.native.generationId || '' });
      if (execution.ended) await this.runner.mainEnded(attempt.id, execution);
    }
    const live = new Set(requests.map(request => `${request.params.turnId}:${String(request.id)}`));
    for (const [key, native] of this.waiting) if (!live.has(key)) this.runner.cancelWait(native);
    if (acceptedInput) this.runner.acceptedInput(turn.turnId);
    for (const request of requests) {
      const key = `${request.params.turnId}:${String(request.id)}`;
      if (this.pending.has(key)) continue;
      this.pending.add(key);
      const native = { threadId: request.params.threadId, turnId: request.params.turnId,
          requestId: request.id, callId: request.params.callId, decisionId: crypto.randomUUID(),
          ...(request.params.generationId ? { generationId: request.params.generationId } : {}) };
      if (request.params.arguments?.action === 'wait') {
        this.waiting.set(key, native);
        this.reply(context, request, native).catch(error => { if (this.context === context) this.failed(error); });
      } else await this.reply(context, request, native);
    }
  }
  async reply(context, request, native) {
      const key = `${native.turnId}:${String(native.requestId)}`;
      const delivery = [];
      try {
        let result, value;
        let errorEvent;
        try {
          if (request.params.tool !== 'ra_fusion') throw new Error('未注册这个主控工具');
          value = await this.runner.control(request.params.arguments, native);
          if (value.cancelled || this.context !== context) return;
          const unread = new Set(this.controller.events.filter(event => !event.deliveredTo).map(event => event.id));
          value.events = value.events.filter(event => unread.has(event.id) && !this.delivering.has(event.id));
          delivery.push(...value.events.map(event => event.id));
          for (const id of delivery) this.delivering.add(id);
          result = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] };
        } catch (error) {
          result = { success: false, contentItems: [{ type: 'inputText', text: error.message }] };
          errorEvent = fusionEvent(this.controller, 'control_error', { native, reason: error.message }, `control-error:${key}`);
          delivery.push(errorEvent.id); this.delivering.add(errorEvent.id);
          publishFusion(this.controller);
        }
        if (this.context !== context) return;
        await nativeAgentProvider(this.controller.main.app).replyTool(this.runner.agent, context, request, result);
        this.runner.acknowledge(native, errorEvent ? [errorEvent.id] : value.events.map(event => event.id));
      } finally {
        for (const id of delivery) this.delivering.delete(id);
        this.pending.delete(key); this.waiting.delete(key);
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
    const provider = nativeAgentProvider(this.controller.main.app);
    const turn = await provider.readTurn(this.runner.agent, this.context, { id: attempt.native?.messageId || '', generationId: attempt.native?.generationId || '' });
    if (turn.ended) { await this.check(); return; }
    if (!turn.current || turn.turnId !== attempt.native?.turnId) throw new Error('主会话已不在本次轮次，未停止其他执行');
    await provider.action(this.runner.agent, this.context, 'stop');
    await this.check();
  }
}
