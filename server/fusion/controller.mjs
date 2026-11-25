import crypto from 'node:crypto';
import { FUSION_TOOLS, fusionControllerPrompt } from './control.mjs';
import { fusionEvent, newFusionAttempt } from './state.mjs';
import { FusionControlError } from './contract.mjs';
import { runNativeEffect, recordNativeTerminal } from './effects.mjs';

const requestKey = (turnId, requestId) => JSON.stringify([turnId, String(requestId)]);
const toolFingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item) ?? 'undefined').digest('hex');


// The bound conversation owns chat and native requests. This observer delivers the management inbox.
export class FusionController {
  constructor(runner) {
    this.runner = runner;
    this.run = runner.run;
    this.pending = new Map();
    this.waiting = new Map();
    this.delivering = new Set();
    this.generation = 0;
  }
  async start() {
    if (this.disconnecting) await this.disconnecting;
    if (this.runner.closed || this.context) return;
    this.starting ||= this.connect(this.generation).finally(() => { this.starting = null; });
    return this.starting;
  }
  async connect(generation) {
    const run = this.run, binding = run.bindings.find(row => row.id === run.main.bindingId);
    if (!binding) return;
    const context = await this.runner.agent.openBinding(run, binding);
    if (generation !== this.generation || this.runner.closed) { await this.runner.agent.close(context); return; }
    context.native = { ...context.native, fusionController: true };
    try {
      context.fusionChanged = () => { if (this.context === context) this.check(); };
      await this.bind(context);
      if (generation !== this.generation || this.runner.closed) { await this.closeContext(context); return; }
      this.context = context;
      if (binding.windowId !== context.page.id || run.main.windowId !== context.page.id) this.runner.commit(next => {
        next.bindings.find(row => row.id === binding.id).windowId = next.main.windowId = context.page.id;
      });
      context.cdp.onclose = error => this.failed(context, error);
      this.unsubscribe = this.provider(context).subscribe(context, error => {
        if (error) this.failed(context, error);
        else if (this.context === context) this.check();
      });
      await this.check();
    } catch (error) {
      if (this.context === context) await this.close();
      else await this.closeContext(context);
      throw error;
    }
  }
  provider(context) { return this.runner.agent.providerFor(context); }
  async bind(context) {
    const result = await this.provider(context).bindController(this.runner.agent, context, this.run, {
      names: FUSION_TOOLS.map(row => row.name), tools: FUSION_TOOLS, instructions: fusionControllerPrompt(this.run),
    });
    this.profileReady = result.profileReady;
  }
  async closeContext(context) {
    try { await this.provider(context).unbindController(this.runner.agent, context); }
    finally { await this.runner.agent.close(context); }
  }
  close() {
    this.generation++;
    clearTimeout(this.replyRecheck); this.replyRecheck = null;
    if (this.disconnecting) return this.disconnecting;
    const context = this.context;
    this.context = null;
    this.latest = null;
    for (const native of this.waiting.values()) this.runner.cancelWait(native);
    this.unsubscribe?.(); this.unsubscribe = null;
    if (!context) return;
    this.disconnecting = this.closeContext(context).catch(error => this.runner.report('disconnect', error))
      .finally(() => { this.disconnecting = null; });
    return this.disconnecting;
  }
  failed(context, error = new Error('Fusion 主会话连接已关闭')) {
    if (this.context !== context) return;
    this.close();
    try {
      const turns = new Set(this.run.attempts.filter(row => row.kind === 'main' && row.origin !== 'events'
        && !row.endedAt && !row.nativeTerminal && row.native?.threadId === context.native.threadId).map(row => row.native.turnId));
      if (turns.size && !error.fusionStoreError) this.runner.commit(next => {
        for (const row of next.attempts.filter(row => !row.endedAt && !row.nativeTerminal && row.native?.threadId === context.native.threadId
          && turns.has(row.native.turnId))) Object.assign(row, { status: 'unknown', error: error.message, outcomeUnknown: true });
      });
    } catch (failure) { this.runner.report('controller', failure); }
    this.runner.blockMain(error);
  }
  acknowledgeUserAnswers(run, threadId) {
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
    }
  }
  check() {
    const context = this.context;
    if (!context) return;
    if (this.reading) { this.again = true; return this.reading; }
    this.reading = this.read(context).catch(error => this.failed(context, error)).finally(() => {
      this.reading = null;
      if (this.again) { this.again = false; this.check(); }
    });
    return this.reading;
  }
  async read(context) {
    const run = this.run, agent = this.runner.agent, provider = this.provider(context);
    const turn = await provider.readTurn(agent, context);
    if (this.context !== context) return;
    if (turn.threadId !== context.native.threadId) throw new Error('主控原生结果身份与 Binding 不一致');
    await this.reconcileToolReplies(context);
    if (this.context !== context) return;
    if (turn.id && turn.turnId && turn.accepted && (context.app !== 'cursor' || turn.current)) {
      let attempt = run.attempts.find(row => row.kind === 'main' && row.bindingId === run.main.bindingId && row.native?.threadId === turn.threadId
        && row.native.turnId === turn.turnId);
      attempt ||= run.attempts.find(row => row.kind === 'main' && row.origin === 'events' && !row.endedAt
        && row.submission !== 'not_submitted' && turn.user?.includes(row.id));
      const newAttempt = !attempt && !run.observedMainTurns.includes(turn.turnId);
      const unseen = !run.observedMainMessages.includes(turn.id);
      const userInput = unseen && (newAttempt || attempt && (attempt.origin === 'user'
        || attempt.native?.messageId && turn.id !== attempt.native.messageId));
      if (newAttempt || attempt && (!attempt.acceptedAt || attempt.status === 'unknown' || unseen)) {
        const id = this.runner.commit(next => {
          const row = newAttempt ? newFusionAttempt(next, null, null, 'main') : next.attempts.find(row => row.id === attempt.id);
          if (newAttempt) Object.assign(row, { origin: 'user', bindingId: next.main.bindingId });
          if (!row.acceptedAt || row.status === 'unknown') {
            Object.assign(row, { status: row.stopRequested || context.app !== 'cursor' && next.stopRequested ? 'stopping' : 'running',
              submission: 'accepted', acceptedAt: row.acceptedAt || Date.now(), native: { threadId: turn.threadId,
                turnId: turn.turnId, messageId: turn.id, ...(turn.generationId ? { generationId: turn.generationId } : {}) } });
            if (turn.settings) {
              const { model, effort, nativeModel } = turn.settings;
              Object.assign(row, { model, effort, nativeModel });
              if (model) Object.assign(next.main, { model, effort });
            }
            delete row.error; delete row.outcomeUnknown;
          }
          if (!next.observedMainTurns.includes(turn.turnId)) next.observedMainTurns.push(turn.turnId);
          if (unseen) next.observedMainMessages.push(turn.id);
          if (userInput) {
            const event = fusionEvent(next, 'user_input', { text: turn.user, native: { ...row.native, messageId: turn.id } },
              `user:${turn.threadId}:${turn.id}`);
            event.deliveredTo = turn.turnId;
            if (next.status === 'blocked') { next.status = 'running'; next.blockedReason = ''; }
            this.acknowledgeUserAnswers(next, turn.threadId);
          }
          return row.id;
        });
        attempt = run.attempts.find(row => row.id === id);
        if (newAttempt && context.app !== 'cursor') this.readSettings(context, id).catch(error => this.runner.report('settings', error));
      }
      if (userInput) this.runner.acceptedInput(turn.turnId);
      if (attempt?.origin === 'user' && turn.ended && !attempt.endedAt
          && (context.app !== 'cursor' || this.matchesAttempt(context, attempt, turn))) await this.terminal(attempt, turn);
    }
    for (const attempt of run.attempts.filter(row => row.kind === 'main' && row.origin !== 'events'
      && row.bindingId === run.main.bindingId && !row.endedAt && row.native?.messageId
      && (row.status === 'stopping' || (context.app === 'cursor' && turn.current && turn.accepted && row.native.turnId !== turn.turnId)))) {
      const execution = await this.readAttempt(context, attempt);
      if (this.context !== context) return;
      if (execution.ended && this.matchesAttempt(context, attempt, execution)) await this.terminal(attempt, execution);
    }
    if (this.context !== context) return;
    if (this.profileReady === false && (turn.ended || !turn.turnId)) await this.bind(context);
    const requests = await provider.toolRequests(agent, context);
    if (this.context !== context) return;
    this.latest = { turn, requests };
    const live = new Set(requests.map(request => requestKey(request.params.turnId, request.id)));
    for (const [key, native] of this.waiting) if (!live.has(key)) this.runner.cancelWait(native);
    for (const request of requests) {
      const key = requestKey(request.params.turnId, request.id);
      if (this.pending.has(key)) continue;
      const native = { threadId: request.params.threadId, turnId: request.params.turnId,
        requestId: request.id, callId: request.params.callId, decisionId: crypto.randomUUID(),
        ...(request.params.generationId ? { generationId: request.params.generationId } : {}) };
      if (native.threadId !== context.native.threadId || !run.attempts.some(row => row.kind === 'main'
          && !row.endedAt && !row.nativeTerminal && row.native?.threadId === native.threadId && row.native.turnId === native.turnId)) continue;
      this.pending.set(key, context);
      if (request.params.arguments?.action === 'wait') {
        this.waiting.set(key, native);
        this.reply(context, request, native).catch(error => this.failed(context, error));
      } else await this.reply(context, request, native);
    }
    this.runner.wake();
  }
  async readSettings(context, id) {
    const settings = await this.provider(context).info(this.runner.agent, context, 'settings');
    if (this.context !== context) return;
    this.runner.commit(next => {
      const attempt = next.attempts.find(row => row.id === id);
      attempt.model = settings.model; attempt.effort = settings.effort || '';
      if (next.attempts.findLast(row => row.kind === 'main' && row.acceptedAt)?.id === id) {
        next.main.model = attempt.model; next.main.effort = attempt.effort;
      }
    });
  }
  async toolReplyReceipt(context, data) {
    const expected = data.codexReceipt, native = data.native;
    if (!expected || context.app !== 'codex' || expected.bindingId !== this.run.main.bindingId
        || expected.host !== (context.native.host || '') || native.threadId !== context.native.threadId) return null;
    let receipt;
    try { receipt = await this.provider(context).toolReplyReceipt(this.runner.agent, context, data); }
    catch { return null; }
    if (this.context !== context || receipt?.status !== 'consumed' || receipt.source !== 'thread/read'
        || receipt.host !== expected.host || receipt.threadId !== native.threadId
        || receipt.turnId !== native.turnId || receipt.callId !== native.callId || receipt.tool !== expected.tool
        || toolFingerprint(receipt.arguments) !== expected.argumentsHash
        || toolFingerprint(receipt.result) !== expected.resultHash) return null;
    return { source: receipt.source, host: receipt.host, threadId: receipt.threadId,
      turnId: receipt.turnId, callId: receipt.callId, confirmedAt: Date.now() };
  }
  async reconcileToolReplies(context) {
    if (context.app !== 'codex') return;
    const pending = this.run.effects.filter(row => row.kind === 'tool-reply' && row.status === 'outcomeUnknown'
      && row.data.codexReceipt?.bindingId === this.run.main.bindingId
      && row.data.native.threadId === context.native.threadId);
    const receipts = await Promise.all(pending.map(async effect => [effect.id, await this.toolReplyReceipt(context, effect.data)]));
    if (this.context !== context) return;
    for (const [id, receipt] of receipts) if (receipt) this.runner.commit(next => {
      const effect = next.effects.find(row => row.id === id);
      if (effect?.status !== 'outcomeUnknown') return;
      this.runner.recordDelivery(next, effect.data.native, effect.data.eventIds, effect.data.codexReceipt.value);
      Object.assign(effect, { status: 'done', endedAt: Date.now(), receipt });
      delete effect.error;
    });
  }
  async reply(context, request, native) {
    const key = requestKey(native.turnId, native.requestId);
    const delivery = [];
    const id = 'tool-reply:' + JSON.stringify([this.run.main.bindingId, native.turnId, String(native.requestId)]);
    try {
      if (this.run.effects.some(row => row.id === id)) return;
      const cursor = context.app === 'cursor';
      const tool = request.params.tool, action = request.params.arguments?.action;
      if (cursor) console.info('[Fusion] Cursor MCP request', this.run.id, native.threadId, native.turnId, native.generationId, native.requestId);
      let result, value, errorEvent;
      try {
        if (request.params.tool !== 'ra_fusion') throw new Error('未注册这个主控工具');
        value = await this.runner.control(request.params.arguments, native);
        if (value.cancelled || this.context !== context) return;
        const unread = new Set(this.run.events.filter(event => !event.deliveredTo).map(event => event.id));
        const unconfirmed = new Set(this.run.effects.filter(row => row.kind === 'tool-reply' && row.data.codexReceipt
          && ['executing', 'outcomeUnknown'].includes(row.status)).flatMap(row => row.data.eventIds));
        value.events = value.events.filter(event => unread.has(event.id) && !this.delivering.has(event.id) && !unconfirmed.has(event.id));
        delivery.push(...value.events.map(event => event.id));
        result = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] };
      } catch (error) {
        if (error.fusionStoreError) throw error;
        const details = error instanceof FusionControlError ? error.feedback : null;
        result = { success: false, contentItems: [{ type: 'inputText', text: details ? JSON.stringify(details) : error.message }] };
        errorEvent = this.runner.commit(next => fusionEvent(next, 'control_error', { native, action: request.params.arguments?.action,
          reason: error.message, ...(details ? { details } : {}) }, `control-error:${key}`));
        delivery.push(errorEvent.id);
      }
      for (const eventId of delivery) this.delivering.add(eventId);
      if (this.context !== context) return;
      const data = { native, eventIds: delivery, ...(cursor ? { tool, action, success: result.success } : {}),
        ...(context.app === 'codex' ? { codexReceipt: { bindingId: this.run.main.bindingId, host: context.native.host || '',
          tool, transport: context.fusionMcp ? 'mcp' : 'dynamic', argumentsHash: toolFingerprint(request.params.arguments), resultHash: toolFingerprint(result),
          value: errorEvent ? null : { agents: value.agents, pendingReviews: value.pendingReviews } } } : {}) };
      let confirmed;
      await runNativeEffect(this.run, { id, kind: 'tool-reply', data, canSettle: () => !this.runner.closed },
        async () => {
          let receipt, sendError;
          try { receipt = await this.provider(context).replyTool(this.runner.agent, context, request, result); }
          catch (error) {
            if (context.app !== 'codex' || error.fusionStoreError) throw error;
            sendError = error;
          }
          if (cursor && receipt !== true) throw new Error('Cursor MCP 回复未收到原生工具桥回执');
          if (context.app === 'codex') {
            confirmed = await this.toolReplyReceipt(context, data);
            if (!confirmed) throw Object.assign(new Error('Codex 管理工具回复结果待原生记录核对，不会自动重发',
              sendError ? { cause: sendError } : undefined), { fusionReplyUnconfirmed: true });
          }
        },
        next => {
          this.runner.recordDelivery(next, native, delivery, errorEvent ? undefined : value);
          if (confirmed) next.effects.find(row => row.id === id).receipt = confirmed;
        });
    } catch (error) {
      if (!error.fusionReplyUnconfirmed || error.fusionStoreError) throw error;
      // Keep the native observer alive. The durable effect prevents retransmission;
      // later native updates reconcile only the exact call's recorded result.
      if (this.context === context && !this.replyRecheck) this.replyRecheck = setTimeout(() => {
        this.replyRecheck = null;
        if (this.context === context) this.check();
      }, 250);
    } finally {
      for (const eventId of delivery) this.delivering.delete(eventId);
      if (this.pending.get(key) === context) { this.pending.delete(key); this.waiting.delete(key); }
    }
  }
  async idle() {
    await this.start();
    if (!this.context) return false;
    await this.check();
    return !!this.latest?.turn.ended || this.latest?.turn.turnId === '' && !this.latest.requests.length;
  }
  readAttempt(context, attempt) {
    return this.provider(context).readTurn(this.runner.agent, context,
      { id: attempt.native?.messageId || '', generationId: attempt.native?.generationId || '' });
  }
  matchesAttempt(context, attempt, turn) {
    const native = attempt.native;
    return attempt.bindingId === this.run.main.bindingId && !!native?.messageId
      && turn.threadId === context.native.threadId && turn.threadId === native.threadId
      && turn.turnId === native.turnId && turn.id === native.messageId
      && (context.app !== 'cursor' || !native.generationId || !turn.generationId || turn.generationId === native.generationId);
  }
  terminal(attempt, turn) {
    const current = this.run.attempts.find(row => row.id === attempt.id);
    if (!current || current.endedAt) return;
    const terminal = current.nativeTerminal || this.runner.commit(next => {
      const row = next.attempts.find(row => row.id === attempt.id);
      const terminal = { text: turn.text || '', completed: !turn.supersededBy && !!turn.completed, error: turn.error || '',
        endedAt: Date.now(), stopped: !!turn.supersededBy || row.stopRequested === true || row.app !== 'cursor' && next.stopRequested,
        ...(turn.supersededBy ? { supersededBy: turn.supersededBy } : {}) };
      recordNativeTerminal(next, row, terminal);
      return terminal;
    });
    return this.runner.mainEnded(attempt.id, terminal);
  }
  // Cursor can compact away an earlier user's bubble after a later generation
  // has been accepted. An absent old bubble alone is never completion evidence.
  // A persisted, terminal successor in the *same single-generation composer*,
  // corroborated by a fresh native read of that exact successor, proves the
  // earlier generation is no longer executing. Its result remains unknown.
  async supersededFromJournal(context, attempt) {
    const old = attempt.native;
    if (context.app !== 'cursor' || !attempt.stopRequested || !attempt.acceptedAt
        || !attempt.bindingId || !old?.generationId || !old.messageId || !old.turnId) return null;
    const successors = this.run.attempts.filter(row => row.id !== attempt.id && row.kind === 'main'
      && row.bindingId === attempt.bindingId && row.native?.threadId === old.threadId
      && row.acceptedAt > attempt.acceptedAt && row.endedAt && row.nativeTerminal?.endedAt
      && row.native?.turnId && row.native?.messageId && row.native?.generationId
      && row.native.generationId !== old.generationId
      && row.native.messageId !== old.messageId).sort((a, b) => a.acceptedAt - b.acceptedAt);
    const successor = successors[0];
    if (!successor) return null;
    const observed = await this.readAttempt(context, successor);
    if (this.context !== context || !this.matchesAttempt(context, successor, observed) || !observed.ended)
      return null;
    return { id: old.messageId, turnId: old.turnId, threadId: old.threadId,
      ended: true, completed: false,
      supersededBy: { messageId: successor.native.messageId, generationId: successor.native.generationId },
      error: '已确认后续原生轮次，旧轮次不再执行；旧轮次的完成结果未知' };
  }

  async reconcile(attempt) {
    if (attempt.nativeTerminal) return this.terminal(attempt, attempt.nativeTerminal);
    const context = this.context;
    if (!context || !attempt.native?.messageId) throw new Error('无法确认主会话原生轮次，不能自动重发');
    const turn = await this.readAttempt(context, attempt);
    if (this.context !== context) return;
    if (!this.matchesAttempt(context, attempt, turn)) {
      const superseded = await this.supersededFromJournal(context, attempt);
      if (superseded) return this.terminal(attempt, superseded);
      throw new Error('无法确认主会话原生轮次，不能自动重发');
    }
    if (turn.ended) return this.terminal(attempt, turn);
    if (attempt.stopRequested || context.app !== 'cursor' && this.run.stopRequested) return this.stop(attempt);
    if (turn.current && attempt.status === 'unknown') this.runner.commit(next => {
      const row = next.attempts.find(row => row.id === attempt.id);
      row.status = 'running'; delete row.error; delete row.outcomeUnknown;
    });
  }
  async stop(attempt) {
    await this.start();
    const context = this.context;
    if (!context) throw new Error('主会话已断开，停止待核对');
    attempt = this.run.attempts.find(row => row.id === attempt.id);
    if (attempt.endedAt) return;
    if (attempt.nativeTerminal) return this.terminal(attempt, attempt.nativeTerminal);
    const turn = await this.readAttempt(context, attempt), native = attempt.native;
    if (this.context !== context) return;
    if (!this.matchesAttempt(context, attempt, turn)) {
      const superseded = await this.supersededFromJournal(context, attempt);
      if (superseded) return this.terminal(attempt, superseded);
      throw new Error('主会话已不在本次轮次，未停止其他执行');
    }
    if (turn.ended) {
      // Account for the current turn before settling a stop for an older one.
      if (turn.supersededBy) await this.check();
      return this.terminal(attempt, turn);
    }
    if (!turn.current) throw new Error('主会话已不在本次轮次，未停止其他执行');
    const id = `native-stop:${attempt.id}:${native.turnId}`;
    if (attempt.stopOutcomeUnknown || this.run.effects.some(row => row.id === id)) return;
    await runNativeEffect(this.run, { id, kind: 'native-stop', data: { attemptId: attempt.id, native }, canSettle: () => !this.runner.closed },
      () => this.provider(context).stop(this.runner.agent, context, native));
    await this.check();
  }
}
