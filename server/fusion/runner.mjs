import { FusionAgent, fusionWorkspaceSnapshot } from './agent.mjs';
import { FusionController } from './controller.mjs';
import { fusionScheduler } from './scheduler.mjs';
import { nativeAgentProvider } from './providers.mjs';
import { applyFusionControl, fusionEventView } from './control.mjs';
import { fusionRuns, fusionWorkers, fusionEvent, publishFusion,
  commitFusion, fusionAttemptWorkIds, NATIVE_UNSETTLED } from './state.mjs';

export class FusionRunner {
  constructor(run, { scheduler = fusionScheduler, agent, controller } = {}) {
    this.run = run; this.scheduler = scheduler;
    this.agent = agent || new FusionAgent({ scheduler, onEvent: () => this.wake() });
    this.controller = controller || new FusionController(this);
    this.jobs = new Map(); this.effects = new Set(); this.waiters = new Map();
  }
  publish() { publishFusion(this.run); }
  blockMain(error) {
    this.run.status = this.run.stopRequested ? 'stopping' : 'blocked';
    this.run.blockedReason = error.message; this.publish();
  }
  async start() {
    if (!this.run.main.bindingId) return;
    await this.controller.start();
    this.wake();
  }
  async control(action, native) {
    const run = this.run;
    if (action?.action === 'list_models') {
      const snapshot = await this.agent.capabilities(run, action.app);
      commitFusion(run, next => { next.capabilities.unshift(snapshot); });
    }
    const previous = run.commands.find(row => row.key === `${run.main.bindingId}:${native.turnId}:${String(native.requestId)}`);
    let result = applyFusionControl(run, action, native);
    const attempt = run.attempts.find(row => row.kind === 'main' && row.native?.turnId === native.turnId);
    if (attempt && !previous) {
      const workIds = new Set([action.workId, result.workId, run.tasks.find(row => row.id === action.taskId)?.workId,
        ...(action.action === 'read_workspace' ? result.events.map(row => row.data.workId) : []),
      ].filter(Boolean));
      for (const workId of workIds) await this.recordMainWork(attempt, workId);
    }
    if (action.action === 'read_workspace') {
      result = { ...result, ...(result.view === 'overview' ? { apps: await this.agent.softwareCapabilities() } : {}), management: { threadId: native.threadId, turnId: native.turnId,
        evidenceReference: `main-turn:${native.turnId}` } };
    }
    if (action.action === 'set_priority') for (const job of this.scheduler.queue.filter(row => row.runId === run.id)) {
      const attempt = run.attempts.find(row => row.id === job.attemptId);
      if (attempt?.taskId === action.taskId) job.priority = action.priority;
    }
    this.wake();
    if (action.action === 'wait' && run.stopRequested) return { cancelled: true };
    if (action.action === 'wait' && !this.pendingEvents().length && this.hasPendingWork() && !run.stopRequested) {
      const delivered = await new Promise(resolve => this.waiters.set(this.waitKey(native), { native, resolve }));
      if (!delivered) return { cancelled: true };
    }
    return { ...result, events: this.pendingEvents() };
  }
  async recordMainWork(attempt, workId) {
    const work = this.run.works.find(row => row.id === workId);
    if (!work) return;
    const plan = work.plans.find(row => row.id === work.planId);
    attempt.workExecutions ||= [];
    if (attempt.workExecutions.some(row => row.workId === workId && row.planId === work.planId && row.confirmed === !!plan?.confirmed)) return;
    const entry = { workId, planId: work.planId, confirmed: !!plan?.confirmed, at: Date.now() };
    this.run.attempts.find(row => row.id === attempt.id).workExecutions.push(entry); this.publish();
  }
  pendingEvents() { return this.run.events.filter(row => !row.deliveredTo).map(row => fusionEventView(this.run, row)); }
  hasPendingWork() {
    return this.run.tasks.some(task => ['queued', 'preparing', 'submitting', 'running', 'stopping', 'awaiting_user'].includes(task.status))
      || this.run.questions.some(question => !question.answeredAt)
      || this.run.works.some(work => work.plans.some(plan => plan.id === work.planId && plan.requiresConfirmation && !plan.confirmed && !plan.decision));
  }
  waitKey(native) { return `${native.turnId}:${String(native.requestId)}`; }
  acceptedInput(turnId) {
    for (const [key, waiter] of this.waiters) if (waiter.native.turnId === turnId) {
      this.waiters.delete(key); waiter.resolve(true);
    }
  }
  cancelWait(native) {
    const key = this.waitKey(native), waiter = this.waiters.get(key);
    if (waiter) { this.waiters.delete(key); waiter.resolve(false); }
  }
  acknowledge(native, eventIds) {
    if (!eventIds?.length) return;
    for (const id of eventIds) {
      const event = this.run.events.find(row => row.id === id);
      if (event && !event.deliveredTo) event.deliveredTo = native.turnId;
    }
    this.publish();
  }
  wake() {
    if (this.waking) { this.wakeAgain = true; return; }
    this.waking = true;
    Promise.resolve().then(async () => {
      for (const attempt of this.run.attempts.filter(row => row.status === 'cancelled')) this.scheduler.cancelAttempt(attempt.id);
      for (const effect of this.run.effects.filter(row => row.status === 'pending' && !this.effects.has(row.id))) {
        if (effect.kind === 'execute') { this.schedule(effect.data.attemptId); continue; }
        this.effects.add(effect.id);
        Promise.resolve().then(() => effect.kind === 'stop' ? this.stopAttempt(effect.data.attemptId) : null)
          .then(() => { effect.status = 'done'; effect.endedAt = Date.now(); }, error => { effect.status = 'failed'; effect.error = error.message; })
          .finally(() => { this.effects.delete(effect.id); this.publish(); });
      }
      this.scheduler.drain();
      if (this.run.stopRequested) { this.finishStop(); return; }
      if (this.pendingEvents().length || !this.hasPendingWork()) for (const [key, waiter] of this.waiters) {
        this.waiters.delete(key); waiter.resolve(true);
      }
    }).catch(error => this.blockMain(error)).finally(() => {
      this.waking = false;
      if (this.wakeAgain) { this.wakeAgain = false; this.wake(); }
    });
  }
  schedule(attemptId, recovering = false) {
    if (this.jobs.has(attemptId)) return this.jobs.get(attemptId);
    const attempt = () => this.run.attempts.find(row => row.id === attemptId);
    if (!attempt() || ['cancelled', 'stopped'].includes(attempt().status)) return;
    const task = () => this.run.tasks.find(row => row.id === attempt().taskId);
    if (!task() || task().executor === 'main') return;
    const work = () => this.run.works.find(row => row.id === task().workId);
    const job = this.scheduler.submit({ runId: this.run.id, app: attempt().app, attemptId,
      workerKey: JSON.stringify([this.run.id, task().workerId]),
      priority: task().priority,
      ready: () => recovering || !this.run.stopRequested && !['stopping', 'stopped'].includes(work().status)
        && !['cancelled', 'stopping'].includes(task().status)
        && !this.run.attempts.some(row => row.id !== attemptId && NATIVE_UNSETTLED.includes(row.status)
          && this.run.tasks.find(value => value.id === row.taskId)?.workerId === task().workerId)
        && task().dependsOn.every(id => this.run.tasks.find(row => row.id === id)?.status === 'accepted'),
      execute: async () => {
        const effect = this.run.effects.find(row => row.id === attemptId);
        if (effect) { effect.status = 'executing'; effect.startedAt ||= Date.now(); }
        if (!recovering) {
          attempt().status = 'preparing';
          attempt().inputIds = task().inputs.filter(input => !input.deliveredAt).map(input => input.id);
        }
        this.publish();
        return this.agent.execute(this.run, attemptId, recovering ? attempt().prompt : null, recovering);
      } }).then(result => this.completed(attemptId, result)).catch(error => this.attemptFailed(attemptId, error))
      .finally(() => {
        this.jobs.delete(attemptId);
        const effect = this.run.effects.find(row => row.id === attemptId);
        if (effect) { if (effect.status !== 'cancelled') effect.status = 'done'; effect.endedAt = Date.now(); }
        this.publish(); this.scheduler.drain(); this.wake();
      });
    this.jobs.set(attemptId, job);
    return job;
  }
  completed(attemptId, result) {
    const attempt = this.run.attempts.find(row => row.id === attemptId);
    if (attempt.endedAt) return;
    Object.assign(attempt, { status: result.stopped ? 'stopped' : result.completed && !result.error ? 'awaiting_review' : 'failed',
      endedAt: result.endedAt || Date.now(), result: { text: result.text, completed: result.completed, error: result.error || '' },
      usage: result.usage || null, changes: result.changes || null, durationMs: Date.now() - (attempt.acceptedAt || attempt.created) });
    const task = this.run.tasks.find(row => row.id === attempt.taskId);
    if (task) task.status = attempt.status;
    const agent = task && this.run.agents.find(row => row.id === task.workerId);
    if (agent) agent.status = 'idle';
    fusionEvent(this.run, result.error ? 'native_error' : 'task_result', { workId: attempt.workId, taskId: attempt.taskId, attemptId }, `result:${attemptId}`);
    this.publish();
  }
  attemptFailed(attemptId, error, main = false) {
    const attempt = this.run.attempts.find(row => row.id === attemptId);
    if (!attempt || attempt.endedAt) return;
    const unknown = !error.cancelled && !error.nativeRejected && attempt.submission !== 'not_submitted' && !attempt.nativeGenerationEndedAt;
    Object.assign(attempt, { status: error.cancelled ? 'cancelled' : unknown ? 'unknown' : 'failed', error: error.message,
      endedAt: unknown ? null : Date.now() });
    const task = this.run.tasks.find(row => row.id === attempt.taskId);
    if (task) task.status = attempt.status;
    const agent = task && this.run.agents.find(row => row.id === task.workerId);
    if (agent) agent.status = unknown ? 'unknown' : error.creationUnknown ? 'blocked' : 'idle';
    if (!error.cancelled) fusionEvent(this.run, 'native_error', { workId: attempt.workId, taskId: attempt.taskId, attemptId,
      reason: error.message, submission: attempt.submission }, `error:${attemptId}`);
    if (main) this.blockMain(error); else this.publish();
  }
  async mainEnded(attemptId, turn) {
    const run = this.run, attempt = run.attempts.find(row => row.id === attemptId);
    if (!attempt || attempt.endedAt && !NATIVE_UNSETTLED.includes(attempt.status)) return;
    Object.assign(attempt, { status: run.stopRequested ? 'stopped' : turn.error || !turn.completed ? 'failed' : 'ended', endedAt: attempt.endedAt || Date.now(),
      usage: turn.usage || attempt.usage,
      result: { text: turn.text || '', completed: !!turn.completed, error: turn.error || '' }, durationMs: Date.now() - attempt.acceptedAt });
    for (const waiter of this.waiters.values()) if (waiter.native.turnId === attempt.native?.turnId) this.cancelWait(waiter.native);
    for (const entry of attempt.workExecutions || []) if (entry.baseline) {
      const work = run.works.find(row => row.id === entry.workId);
      const changes = await fusionWorkspaceSnapshot(work.project, entry.scope);
      run.attempts.find(row => row.id === attempt.id).workExecutions.find(row => row.workId === entry.workId
        && row.planId === entry.planId && row.confirmed === entry.confirmed).changes = changes;
    }
    for (const self of run.attempts.filter(row => row.kind === 'task' && row.native?.turnId === attempt.native?.turnId && !row.endedAt)) {
      const task = run.tasks.find(row => row.id === self.taskId), work = run.works.find(row => row.id === self.workId);
      this.completed(self.id, { text: turn.text, completed: turn.completed, error: turn.error, stopped: run.stopRequested,
        changes: await fusionWorkspaceSnapshot(work.project, task.scope) });
    }
    for (const work of run.works.filter(row => row.candidate?.nativeTurnId === attempt.native?.turnId)) {
      const candidate = work.candidate;
      const arrived = run.events.some(event => !candidate.eventIds.includes(event.id) && (!event.data.workId || event.data.workId === work.id));
      const unresolved = run.tasks.some(task => task.workId === work.id && task.executor !== 'main' && task.required && task.status !== 'accepted')
        || run.attempts.some(row => row.workId === work.id && NATIVE_UNSETTLED.includes(row.status));
      if (!turn.completed || turn.error || arrived || unresolved || candidate.planId !== work.planId) {
        work.status = 'running'; work.candidate = null;
        fusionEvent(run, 'delivery_pending', { workId: work.id, reason: '交付候选后有新事实或本轮没有成功完成，需要重新核对' });
      } else { work.deliveries.push({ ...candidate, endedAt: attempt.endedAt, mainAttemptId: attempt.id }); work.status = 'completed'; work.candidate = null; }
    }
    if (!run.stopRequested && (turn.error || !turn.completed)) this.blockMain(new Error(turn.error
      || '主控原生轮次被中断或未完成，等待用户继续'));
    else if (!run.stopRequested) { run.status = 'waiting'; run.blockedReason = ''; }
    this.publish(); this.wake();
  }
  confirm(planId, decision = 'confirm', feedback = '') {
    if (!['confirm', 'revise', 'reject'].includes(decision)) throw new Error('请选择确认、要求修改或拒绝方案');
    if (decision === 'revise' && !feedback.trim()) throw new Error('请输入希望修改的内容');
    commitFusion(this.run, next => {
      const work = next.works.find(row => row.planId === planId), plan = work?.plans.find(row => row.id === planId);
      if (!plan || plan.confirmed || plan.decision) throw new Error('待确认方案已改变，请重新读取');
      Object.assign(plan, { decision, feedback, decidedAt: Date.now(), confirmed: decision === 'confirm' });
      if (plan.confirmed) plan.confirmedAt = plan.decidedAt;
      work.status = plan.confirmed ? 'running' : 'awaiting_user';
      fusionEvent(next, decision === 'confirm' ? 'plan_confirmed' : 'plan_feedback', { workId: work.id, planId, decision, text: feedback });
    });
    this.wake();
  }
  input({ workId, taskId, questionId, text, requestId }) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('请输入补充内容');
    commitFusion(this.run, next => {
      if (next.events.some(row => row.id === requestId)) return;
      const question = questionId && next.questions.find(row => row.id === questionId);
      const task = taskId && next.tasks.find(row => row.id === taskId);
      const work = next.works.find(row => row.id === (question?.workId || task?.workId || workId));
      if ((workId || taskId || questionId) && !work) throw new Error('请选择补充所属工作项');
      if (!next.main.bindingId) throw new Error('请先启用主 Agent');
      if (questionId && !question) throw new Error('这个问题已不存在');
      if (question) Object.assign(question, { answer: text, answeredAt: Date.now(), inputId: requestId });
      const target = task || next.tasks.find(row => row.id === question?.taskId);
      if (target) target.inputs.push({ id: requestId, text, created: Date.now(), deliveredAt: null });
      fusionEvent(next, 'user_input', { workId: work?.id || '', taskId: task?.id || question?.taskId || '', questionId, text }, requestId);
    });
    this.wake();
  }
  async stopAttempt(attemptId) {
    const attempt = this.run.attempts.find(row => row.id === attemptId);
    if (!attempt || attempt.endedAt) return;
    if (attempt.status === 'queued') {
      attempt.status = 'cancelled'; attempt.endedAt = Date.now(); this.scheduler.cancelAttempt(attemptId);
      const effect = this.run.effects.find(row => row.id === attemptId);
      if (effect) effect.status = 'cancelled';
      const task = this.run.tasks.find(row => row.id === attempt.taskId);
      if (task) task.status = 'cancelled';
      const agent = task && this.run.agents.find(row => row.id === task.workerId);
      if (agent) agent.status = 'idle';
      return;
    }
    attempt.status = 'stopping'; this.publish();
    if (attempt.kind === 'main') await this.controller.stop(attempt);
    else if (this.run.tasks.find(row => row.id === attempt.taskId)?.executor === 'main') {
      const main = this.run.attempts.find(row => row.kind === 'main' && row.native?.turnId === attempt.native?.turnId);
      if (!main) throw new Error('主控实际轮次待核对');
      await this.controller.stop(main);
    } else await this.agent.stop(attemptId);
  }
  async stop({ workId = '', taskId = '' } = {}) {
    const run = this.run;
    if (!workId && !taskId) {
      run.stopRequested = true; run.status = 'stopping';
      for (const waiter of this.waiters.values()) this.cancelWait(waiter.native);
    }
    const work = workId && run.works.find(row => row.id === workId);
    if (workId && !work) throw new Error('没有这个工作项');
    if (taskId && !run.tasks.some(row => row.id === taskId)) throw new Error('没有这个任务');
    if (work) work.status = 'stopping';
    const targets = run.attempts.filter(row => (!workId || fusionAttemptWorkIds(run, row).includes(workId)) && (!taskId || row.taskId === taskId)
      && (row.status === 'queued' || NATIVE_UNSETTLED.includes(row.status)));
    for (const task of run.tasks.filter(row => (!workId || row.workId === workId) && (!taskId || row.id === taskId))) task.stopRequested = true;
    this.publish();
    await Promise.allSettled(targets.map(async attempt => {
      try { await this.stopAttempt(attempt.id); }
      catch (error) { attempt.stopError = error.message; this.publish(); }
    }));
    this.finishStop();
  }
  finishStop() {
    const previous = JSON.stringify([this.run.status, this.run.works.map(work => work.status)]);
    const unsettled = attempt => NATIVE_UNSETTLED.includes(attempt.status) || attempt.status === 'queued';
    for (const work of this.run.works.filter(row => row.status === 'stopping'))
      if (!this.run.attempts.some(row => fusionAttemptWorkIds(this.run, row).includes(work.id) && unsettled(row))) work.status = 'stopped';
    if (this.run.stopRequested) this.run.status = this.run.attempts.some(unsettled) ? 'stopping' : 'stopped';
    if (previous !== JSON.stringify([this.run.status, this.run.works.map(work => work.status)])) this.publish();
  }
  async resume() {
    this.run.stopRequested = false; this.run.blockedReason = ''; this.run.status = 'recovering';
    for (const task of this.run.tasks) delete task.stopRequested;
    this.publish();
    await this.recover();
  }
  async recover() {
    this.finishStop();
    if (this.run.stopRequested && this.run.status === 'stopped') return;
    await this.controller.start();
    for (const attempt of this.run.attempts.filter(row => NATIVE_UNSETTLED.includes(row.status) || row.status === 'queued')) {
      if (this.jobs.has(attempt.id)) continue;
      if (attempt.kind === 'main') {
        if (attempt.origin === 'events') {
          if (attempt.submission === 'not_submitted') {
            attempt.status = 'cancelled'; attempt.endedAt = Date.now(); // inbox remains pending; no native submission occurred
          } else {
            try { const result = await this.agent.execute(this.run, attempt.id, attempt.prompt, true); await this.mainEnded(attempt.id, result); }
            catch (error) { this.attemptFailed(attempt.id, error, true); }
          }
        } else if (attempt.native?.messageId && !attempt.endedAt) {
          const turn = await nativeAgentProvider(this.run.main.app).readTurn(this.agent, this.controller.context,
            { id: attempt.native.messageId, generationId: attempt.native.generationId || '' });
          if (turn.ended) await this.mainEnded(attempt.id, turn);
          else if (!turn.id) this.attemptFailed(attempt.id, new Error('无法确认主会话原生轮次，不能自动重发'), true);
          else if (this.run.stopRequested) await this.controller.stop(attempt);
        }
      } else if (this.run.tasks.find(row => row.id === attempt.taskId)?.executor !== 'main') {
        this.schedule(attempt.id, attempt.submission !== 'not_submitted');
      }
    }
    if (this.run.status === 'recovering') { this.run.status = 'waiting'; this.run.blockedReason = ''; }
    this.publish(); this.wake();
  }
}

export function fusionRunner(run) {
  const key = JSON.stringify([run.computer, run.deviceId, run.id]);
  if (!fusionWorkers.has(key)) fusionWorkers.set(key, new FusionRunner(run));
  return fusionWorkers.get(key);
}
export function recoverFusionRuns() {
  for (const owner of Object.values(fusionRuns)) for (const run of owner.runs) if (run.main.bindingId) {
    run.status = run.stopRequested ? 'stopping' : 'recovering'; publishFusion(run);
    fusionRunner(run).recover().catch(error => fusionRunner(run).blockMain(error));
  }
}
