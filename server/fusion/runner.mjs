import { FusionAgent } from './agent.mjs';
import { remotePeerProject, remotePeerCatalog } from './remote-peer.mjs';
import { FusionController } from './controller.mjs';
import { FusionScheduler } from './scheduler.mjs';
import { nativeCostSnapshot } from './cost.mjs';
import { FUSION_READ_ACTIONS, validateFusionAction } from './contract.mjs';
import { applyFusionControl, fusionActor, fusionEventView, fusionPendingReviews, fusionReviewQueue, authorizeFusionTask, fusionDeliveryReady } from './control.mjs';
import { fusionState, stateOfFusionRun, fusionEvent, commitFusion, fusionAttemptWorkIds, newFusionAttempt,
  fusionReviewBatch, fusionReviewKey, recordFusionReceipt, NATIVE_UNSETTLED } from './state.mjs';

function recordAttemptResult(attempt, result, fields, startedAt) {
  Object.assign(attempt, fields, { result: { text: result.text, completed: result.completed, error: result.error || '' },
    durationMs: (fields.endedAt || Date.now()) - (startedAt || attempt.created) });
  if (attempt.nativeTerminal) delete attempt.nativeTerminal.text;
}

export class FusionRunner {
  constructor(run, { scheduler = new FusionScheduler(), adapterRegistry, agent, controller, onDispose = () => {} } = {}) {
    this.run = run;
    this.scheduler = scheduler;
    this.onDispose = onDispose;
    this.agent = agent || new FusionAgent({ adapterRegistry, onEvent: () => this.wake() });
    this.controller = controller || new FusionController(this);
    this.jobs = new Map();
    this.stops = new Map();
    this.waiters = new Map();
  }
  commit(edit) { return commitFusion(this.run, edit); }
  report(stage, error) {
    const state = stateOfFusionRun(this.run);
    if (error.fusionStoreError) {
      if (!this.writeBlocked) {
        this.writeBlocked = true;
        state.notify(this.run);
      }
    } else state.report(stage, error, this.run);
  }
  blockMain(error) {
    this.report('controller', error);
    if (this.writeBlocked || this.closed) return;
    try {
      this.commit(next => {
        delete next.reviewBlock;
        next.status = next.stopRequested ? 'stopping' : 'blocked';
        next.blockedReason = error.message;
      });
    } catch (failure) { this.report('controller', failure); }
  }
  setup(action) {
    if (this.settingUp) throw new Error('主 Agent 正在准备，请等待当前操作结果');
    this.settingUp = Promise.resolve().then(action).finally(() => {
      this.settingUp = null; stateOfFusionRun(this.run).notify(this.run);
    });
    stateOfFusionRun(this.run).notify(this.run);
    return this.settingUp;
  }
  async start() {
    if (!this.run.main.bindingId) return;
    await this.controller.start();
    this.wake();
  }
  async ensureMain() {
    if (!this.run.main.bindingId || this.run.stopRequested) return;
    if (!this.controller.context || this.recovering) {
      try { await this.recover(); }
      catch (error) { this.blockMain(error); throw error; }
    }
    if (this.controller.profileReady === false) await this.controller.check();
    if (!this.controller.context || this.controller.profileReady === false)
      throw new Error('Fusion 主会话的原生工具尚未就绪，请在当前轮次结束后重试');
  }
  async control(action, native) {
    const run = this.run, key = fusionActor(run, native);
    const previous = run.commands.find(row => row.key === key);
    const query = previous ? null : validateFusionAction(action);
    if (action?.action === 'list_models' && !previous) {
      if (!query.snapshotIds) {
        const apps = action.app === 'all' ? (await this.agent.softwareCapabilities())
          .filter(row => row.worker && (row.connected || row.app === 'codex' && !run.project.host)).map(row => row.app) : [action.app];
        const snapshots = await Promise.all(apps.map(async app => {
          try { return await this.agent.capabilities(run, app, { worker: true }); }
          catch (error) { return { ...nativeCostSnapshot(app, [], null, { read: 'native-model-catalog' }), error: error.message }; }
        }));
        commitFusion(run, next => { next.capabilities.unshift(...snapshots); });
        query.snapshotIds = snapshots.map(snapshot => snapshot.id);
        action = { ...action, input: JSON.stringify(query) };
      }
      if (query.view === 'source' || query.view === 'profile')
        await this.agent.catalog.refresh(query.model ? [{ app: action.app, model: query.model }] : []);
    }
    // A remote work uses the target's native catalog, never the controller machine's model list.
    if (!previous && ['dispatch', 'continue_task'].includes(action.action)) {
      const workId = action.workId || run.tasks.find(row => row.id === action.taskId)?.workId;
      const work = run.works.find(row => row.id === workId);
      if (work && remotePeerProject(work.project)) {
        const target = await remotePeerCatalog(work.project);
        const executions = action.action === 'dispatch' ? (Array.isArray(action.tasks) ? action.tasks.map(row => row.execution) : []) : [action.execution];
        if (executions.some(row => row?.app !== target.app || row?.model !== target.model || row?.effort !== ''))
          throw new Error(`远端模型须使用目标原生已确认的 ${target.app}/${target.model}，effort 填空字符串；先读取 workId=${work.id} 的 remoteExecution，再派工。`);
      }
    }
    let result = applyFusionControl(run, action, native, { catalog: this.agent.catalog });
    const remoteWork = ['create_work', 'read_workspace'].includes(action.action)
      ? run.works.find(row => row.id === (action.workId || result.workId)) : null;
    if (remoteWork && remotePeerProject(remoteWork.project)) {
      let remoteExecution;
      try { remoteExecution = await remotePeerCatalog(remoteWork.project); }
      catch (error) { remoteExecution = { ready: false, error: error.message }; }
      result = { ...result, remoteExecution: { ...remoteExecution, read: { action: 'read_workspace', workId: remoteWork.id }, basis: '远端仅使用目标原生已确认的默认模型；本机 list_models 不适用于远端。成本未知。' } };
    }
    const attempt = run.attempts.find(row => row.kind === 'main' && row.native?.threadId === native.threadId && row.native.turnId === native.turnId);
    if (attempt && !previous) {
      const workIds = new Set([action.workId, result.workId, run.tasks.find(row => row.id === action.taskId)?.workId,
        ...(action.action === 'read_workspace' ? (result.events || []).map(row => row.data.workId) : []),
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
    const deliveryAction = ['wait', 'review'].includes(action.action);
    let deliveryReady = deliveryAction ? fusionDeliveryReady(run, native.turnId) : [];
    if (action.action === 'wait' && !deliveryReady.length && !this.pendingEvents().length && this.hasPendingWork() && !run.stopRequested) {
      const delivered = await new Promise(resolve => this.waiters.set(this.waitKey(native), { native, resolve }));
      if (!delivered) return { cancelled: true };
      deliveryReady = fusionDeliveryReady(run, native.turnId);
    }
    return { ...result, events: this.pendingEvents(), pendingReviews: fusionReviewQueue(run),
      ...(deliveryReady.length ? { deliveryReady, next: '读取对应工作详情和证据，满足方案标准后调用 finish。' } : {}) };
  }
  async recordMainWork(attempt, workId) {
    const work = this.run.works.find(row => row.id === workId);
    if (!work) return;
    const plan = work.plans.find(row => row.id === work.planId);
    if (attempt.workExecutions?.some(row => row.workId === workId && row.planId === work.planId && row.confirmed === !!plan?.confirmed)) return;
    const entry = { workId, planId: work.planId, confirmed: !!plan?.confirmed, at: Date.now() };
    this.commit(next => {
      (next.attempts.find(row => row.id === attempt.id).workExecutions ||= []).push(entry);
    });
  }
  pendingEvents() { return this.run.events.filter(row => !row.deliveredTo).map(row => fusionEventView(this.run, row)); }
  pendingPlanDecisions() {
    const run = this.run;
    const notified = new Set(run.attempts
      .filter(row => row.kind === 'main' && row.planDecisionIds && (!row.endedAt || row.submission !== 'not_submitted'))
      .flatMap(row => row.planDecisionIds));
    return run.events.filter(event => {
      if (event.deliveredTo || notified.has(event.id) || !['plan_confirmed', 'plan_feedback'].includes(event.type)) return false;
      const work = run.works.find(row => row.id === event.data.workId);
      return work?.planId === event.data.planId && !['completed', 'stopping', 'stopped'].includes(work.status);
    });
  }
  hasPendingWork() {
    return fusionPendingReviews(this.run).length > 0
      || this.run.tasks.some(task => ['queued', 'preparing', 'submitting', 'running', 'stopping', 'awaiting_user'].includes(task.status))
      || this.run.questions.some(question => !question.answeredAt)
      || this.run.works.some(work => work.plans.some(plan => plan.id === work.planId && plan.requiresConfirmation && !plan.confirmed && !plan.decision));
  }
  waitKey(native) { return JSON.stringify([native.threadId, native.turnId, String(native.requestId)]); }
  acceptedInput(turnId) {
    for (const [key, waiter] of this.waiters) if (waiter.native.turnId === turnId) {
      this.waiters.delete(key); waiter.resolve(true);
    }
    const queued = this.run.attempts.filter(row => row.kind === 'main' && row.origin === 'events'
      && row.submission === 'not_submitted' && !row.endedAt);
    if (queued.length || this.run.reviewBlock) this.commit(next => {
      delete next.reviewBlock;
      for (const attempt of next.attempts.filter(row => queued.some(old => old.id === row.id)))
        Object.assign(attempt, { status: 'cancelled', endedAt: Date.now() });
    });
    for (const attempt of queued) this.scheduler.cancelAttempt(this.run.id, attempt.id);
  }
  cancelWait(native) {
    const key = this.waitKey(native), waiter = this.waiters.get(key);
    if (waiter) { this.waiters.delete(key); waiter.resolve(false); }
  }
  recordDelivery(next, native, eventIds, value) {
    for (const id of eventIds) {
      const event = next.events.find(row => row.id === id);
      if (event && !event.deliveredTo) event.deliveredTo = native.turnId;
    }
    if (value) recordFusionReceipt(next, native, value);
  }
  wake() {
    if (this.closed || this.writeBlocked) return;
    if (this.waking) { this.wakeAgain = true; return this.waking; }
    this.waking = Promise.resolve().then(async () => {
      for (const attempt of this.run.attempts.filter(row => row.status === 'cancelled')) this.scheduler.cancelAttempt(this.run.id, attempt.id);
      for (const effect of this.run.effects.filter(row => row.status === 'pending')) {
        if (effect.kind === 'execute') this.schedule(effect.data.attemptId);
        if (effect.kind === 'stop') this.stopAttempt(effect.data.attemptId).catch(error => this.report('stop', error));
      }
      this.scheduler.drain();
      if (this.run.stopRequested) { this.finishStop(); return; }
      if (this.pendingEvents().length || !this.hasPendingWork()) for (const [key, waiter] of this.waiters) {
        this.waiters.delete(key); waiter.resolve(true);
      }
      await this.reviewResults();
    }).catch(error => this.blockMain(error)).finally(() => {
      this.waking = null;
      if (this.wakeAgain) { this.wakeAgain = false; this.wake(); }
    });
    return this.waking;
  }
  async reviewResults() {
    const run = this.run;
    if (this.waiters.size || run.stopRequested
      || run.attempts.some(row => row.status === 'unknown' || row.kind === 'main' && (NATIVE_UNSETTLED.includes(row.status) || row.status === 'queued'))) return;
    let pending = fusionPendingReviews(run);
    if (run.reviewBlock) {
      if (run.reviewBlock.key === fusionReviewKey(run, pending)) {
        if (run.status !== 'blocked') this.commit(next => {
          next.status = 'blocked'; next.blockedReason = next.reviewBlock.reason;
        });
        return;
      }
      this.commit(next => {
        delete next.reviewBlock;
        if (next.status === 'blocked') { next.status = 'waiting'; next.blockedReason = ''; }
      });
    }
    if (!['waiting', 'running'].includes(run.status)) return;
    pending = pending.filter(row => !row.waitingFor);
    const previousMain = run.attempts.findLast(row => row.kind === 'main');
    if (pending.length && previousMain?.status === 'failed') {
      this.blockMain(new Error(previousMain.error || previousMain.result?.error || '主控原生执行失败，待核对后继续'));
      return;
    }
    const deliveryReady = () => run.attempts.findLast(row => row.kind === 'main')?.status === 'ended'
      && fusionDeliveryReady(run).filter(work => !run.attempts.some(attempt => attempt.delivery?.some(row =>
        row.workId === work.workId && row.planId === work.planId)));
    if ((!pending.length && !deliveryReady()?.length && !this.pendingPlanDecisions().length) || !await this.controller.idle()) return;
    if (this.closed || run.stopRequested || run.attempts.some(row => row.status === 'unknown'
      || row.kind === 'main' && (row.status === 'queued' || NATIVE_UNSETTLED.includes(row.status)))) return;
    pending = fusionPendingReviews(run).filter(row => !row.waitingFor);
    const delivery = pending.length ? [] : deliveryReady() || [];
    const decisions = pending.length || delivery.length ? [] : this.pendingPlanDecisions();
    if (!pending.length && !delivery.length && !decisions.length) return;
    const id = this.commit(next => {
      const attempt = newFusionAttempt(next, null, null, 'main');
      if (delivery.length) {
        Object.assign(attempt, { origin: 'events', bindingId: next.main.bindingId, eventIds: [], delivery,
          prompt: `Fusion 有 ${delivery.length} 项工作已完成验收，等待正式交付。按下列 workId 读取工作详情、事件与证据，满足当前方案的标准后调用 finish，再给用户总结。不要重新派工。
${JSON.stringify(delivery.map(work => work.read))}
本次输入：${attempt.id}` });
        return attempt.id;
      }
      if (decisions.length) {
        const eventIds = decisions.map(event => event.id);
        Object.assign(attempt, { origin: 'events', bindingId: next.main.bindingId, eventIds, planDecisionIds: eventIds,
          prompt: `Fusion 有尚未处理的用户方案决定。按下列工作 ID 调用 read_workspace 读取当前方案和事件，只处理仍属于当前方案的决定。confirm 按已授权范围继续；revise 依据修改意见为同一工作登记仍需确认的新方案；reject 确认收到并停止该方案，不派工。
${JSON.stringify(decisions.map(({ id, data }) => ({ eventId: id, workId: data.workId, planId: data.planId })))}
本次输入：${attempt.id}` });
        return attempt.id;
      }
      const ids = new Set(pending.map(row => row.attemptId));
      const batch = fusionReviewBatch(attempt, [...ids]);
      batch.key = fusionReviewKey(next, fusionPendingReviews(next));
      Object.assign(attempt, { origin: 'events', bindingId: next.main.bindingId,
        eventIds: next.events.filter(row => ids.has(row.data.attemptId) && ['task_result', 'native_error'].includes(row.type)).map(row => row.id),
        prompt: `Fusion 有 ${pending.length} 项子结果待处置。read_workspace读取pendingReviews，逐项read_task；成功结果review，失败明确补做、取消或提问。已读不等于验收；处理全部可处理项，满足工作标准再finish。保留用户暂停与未知执行，不重发。
本次输入：${attempt.id}` });
      return attempt.id;
    });
    this.schedule(id);
  }
  workIsBlocked(work, task) {
    const plan = work.plans.find(row => row.id === work.planId);
    return !plan?.confirmed || this.run.questions.some(question => !question.answeredAt && question.workId === work.id
      && (!question.taskId || question.taskId === task.id));
  }
  schedule(attemptId, recovering) {
    if (this.jobs.has(attemptId)) return this.jobs.get(attemptId);
    if (this.closed || this.writeBlocked) return;
    const run = this.run;
    const attempt = () => run.attempts.find(row => row.id === attemptId);
    const row = attempt();
    if (!row || row.endedAt || !['queued', ...NATIVE_UNSETTLED].includes(row.status)) return;
    recovering ??= row.submission !== 'not_submitted';
    const main = row.kind === 'main';
    const task = () => run.tasks.find(value => value.id === row.taskId);
    if (!main && (!task() || task().executor === 'main')) return;
    const work = () => run.works.find(value => value.id === task().workId);
    const ready = () => {
      if (this.writeBlocked || this.closed) return false;
      if (recovering) return true;
      if (run.stopRequested || attempt().endedAt || attempt().submission !== 'not_submitted') return false;
      if (main) return !run.attempts.some(value => value.id !== attemptId && value.kind === 'main' && NATIVE_UNSETTLED.includes(value.status));
      return !this.workIsBlocked(work(), task()) && !['stopping', 'stopped'].includes(work().status)
        && !task().stopRequested && !['cancelled', 'stopping'].includes(task().status)
        && !run.attempts.some(value => value.id !== attemptId && NATIVE_UNSETTLED.includes(value.status)
          && run.tasks.find(item => item.id === value.taskId)?.workerId === task().workerId)
        && task().dependsOn.every(id => run.tasks.find(value => value.id === id)?.status === 'accepted');
    };
    const job = this.scheduler.submit({
      runId: run.id, lane: main ? 'main' : 'worker', app: row.app, attemptId,
      workerKey: main ? '' : JSON.stringify([run.id, task().workerId]), priority: main ? 0 : task().priority,
      ready, execute: async () => {
        if (!ready()) {
          if (!main && this.workIsBlocked(work(), task()))
            throw Object.assign(new Error('工作项等待用户确认'), { awaitingUser: true });
          throw Object.assign(new Error('未提交的 Fusion 任务已取消'), { cancelled: true });
        }
        if (!recovering) this.commit(next => {
          const attempt = next.attempts.find(value => value.id === attemptId);
          attempt.status = 'preparing';
          if (!main) {
            const task = next.tasks.find(value => value.id === row.taskId);
            task.status = 'preparing';
            attempt.inputIds = task.inputs.filter(input => !input.deliveredAt).map(input => input.id);
          }
          const effect = next.effects.find(value => value.kind === 'execute' && value.data.attemptId === attemptId);
          if (effect) { effect.status = 'executing'; effect.startedAt ||= Date.now(); }
        });
        return this.agent.execute(run, attemptId, attempt().prompt, recovering, () => {
          if (this.writeBlocked || this.closed) throw new Error('Fusion 执行已暂停');
          if (main) return;
          if (this.workIsBlocked(work(), task())) throw Object.assign(new Error('工作项等待用户确认'), { awaitingUser: true });
          authorizeFusionTask(work(), task());
        });
      },
    }).then(result => main ? this.mainEnded(attemptId, result) : this.completed(attemptId, result))
      .catch(error => this.attemptFailed(attemptId, error, main))
      .catch(error => this.report('attempt', error))
      .finally(() => {
        this.jobs.delete(attemptId);
        this.wake();
      });
    this.jobs.set(attemptId, job);
    return job;
  }
  completeAttempt(run, attempt, result) {
    if (attempt.endedAt) return;
    recordAttemptResult(attempt, result, { status: result.stopped ? 'stopped' : result.completed && !result.error ? 'awaiting_review' : 'failed',
      endedAt: result.endedAt || Date.now(), usage: result.usage || null, changes: result.changes || null }, attempt.acceptedAt);
    const task = run.tasks.find(row => row.id === attempt.taskId);
    if (task?.attemptIds.at(-1) === attempt.id) task.status = attempt.status;
    const agent = task && run.agents.find(row => row.id === task.workerId);
    if (agent) agent.status = 'idle';
    fusionEvent(run, result.error ? 'native_error' : 'task_result', { workId: attempt.workId, taskId: attempt.taskId, attemptId: attempt.id }, `result:${attempt.id}`);
    this.settleExecution(run, attempt, 'done');
  }
  completed(attemptId, result) {
    if (!this.closed && !this.run.attempts.find(row => row.id === attemptId)?.endedAt)
      this.commit(next => this.completeAttempt(next, next.attempts.find(row => row.id === attemptId), result));
    this.wake();
  }
  settleExecution(run, attempt, status) {
    const effect = run.effects.find(row => row.kind === 'execute' && row.data.attemptId === attempt.id);
    if (effect && effect.status !== 'cancelled') Object.assign(effect, { status, endedAt: Date.now() });
  }
  attemptFailed(attemptId, error, main = false) {
    if (this.closed) return;
    if (!error.awaitingUser && !error.cancelled) this.report('attempt', error);
    if (this.writeBlocked) return;
    const attempt = this.run.attempts.find(row => row.id === attemptId);
    if (!attempt || attempt.endedAt || attempt.nativeTerminal) return;
    if (error.awaitingUser && attempt.submission === 'not_submitted') {
      this.commit(next => {
        const row = next.attempts.find(value => value.id === attemptId);
        row.status = next.tasks.find(value => value.id === row.taskId).status = 'queued';
        const effect = next.effects.find(value => value.kind === 'execute' && value.data.attemptId === attemptId);
        if (effect) effect.status = 'pending';
      });
      return;
    }
    const unknown = !error.cancelled && !error.nativeRejected && attempt.submission !== 'not_submitted';
    this.commit(next => {
      const row = next.attempts.find(value => value.id === attemptId);
      Object.assign(row, { status: error.cancelled ? 'cancelled' : unknown ? 'unknown' : 'failed', error: error.message,
        outcomeUnknown: unknown, endedAt: unknown ? null : Date.now() });
      const task = next.tasks.find(value => value.id === row.taskId);
      if (task?.attemptIds.at(-1) === row.id) task.status = row.status;
      const agent = task && next.agents.find(value => value.id === task.workerId);
      if (agent) agent.status = unknown ? 'unknown' : error.creationUnknown ? 'blocked' : 'idle';
      if (!error.cancelled) fusionEvent(next, 'native_error', { workId: row.workId, taskId: row.taskId, attemptId,
        reason: error.message, submission: row.submission }, `error:${attemptId}`);
      this.settleExecution(next, row, error.cancelled ? 'cancelled' : unknown ? 'outcomeUnknown' : 'failed');
      if (main && !error.cancelled) {
        delete next.reviewBlock;
        next.status = next.stopRequested ? 'stopping' : 'blocked';
        next.blockedReason = error.message;
      }
    });
    this.wake();
  }
  async mainEnded(attemptId, turn) {
    const run = this.run, attempt = run.attempts.find(row => row.id === attemptId);
    if (!attempt || attempt.endedAt) return;
    for (const waiter of this.waiters.values()) if (waiter.native.threadId === attempt.native?.threadId
        && waiter.native.turnId === attempt.native?.turnId) this.cancelWait(waiter.native);
    const entries = await Promise.all((attempt.workExecutions || []).filter(row => row.baseline).map(async entry => {
      const work = run.works.find(row => row.id === entry.workId);
      return { ...entry, changes: await this.agent.workspaceEvidence(run, work.project, entry.scope) };
    }));
    const belongs = row => row.kind === 'task' && attempt.native?.threadId && row.native?.threadId === attempt.native.threadId
      && row.native?.turnId === attempt.native.turnId && !row.endedAt;
    const selfChanges = new Map(await Promise.all(run.attempts.filter(belongs).map(async self => {
      const task = run.tasks.find(row => row.id === self.taskId), work = run.works.find(row => row.id === self.workId);
      return [self.id, await this.agent.workspaceEvidence(run, work.project, task.scope)];
    })));
    if (this.closed || run.attempts.find(row => row.id === attemptId).endedAt) return;
    this.commit(next => {
      const main = next.attempts.find(row => row.id === attemptId);
      const stopped = turn.stopped || main.stopRequested || (main.app !== 'cursor' || main.origin === 'events') && next.stopRequested;
      recordAttemptResult(main, { ...turn, text: turn.text || '', completed: !!turn.completed }, {
        status: stopped ? 'stopped' : turn.error || !turn.completed ? 'failed' : 'ended',
        endedAt: turn.endedAt || Date.now(), usage: turn.usage || main.usage }, main.acceptedAt);
      for (const entry of entries) Object.assign(main.workExecutions.find(row => row.workId === entry.workId
        && row.planId === entry.planId && row.confirmed === entry.confirmed), { changes: entry.changes });
      for (const self of next.attempts.filter(belongs))
        this.completeAttempt(next, self, { text: turn.text, completed: turn.completed, error: turn.error, stopped, changes: selfChanges.get(self.id) });
      for (const work of next.works.filter(row => main.native?.turnId && row.candidate?.nativeTurnId === main.native.turnId)) {
        const candidate = work.candidate;
        const arrived = next.events.some(event => {
          const receivedReadError = event.type === 'control_error' && FUSION_READ_ACTIONS.includes(event.data.action) && event.data.details
            && main.native?.threadId && event.data.native?.threadId === main.native.threadId
            && event.data.native?.turnId === candidate.nativeTurnId && event.deliveredTo === candidate.nativeTurnId;
          return !candidate.eventIds.includes(event.id) && (!event.data.workId || event.data.workId === work.id) && !receivedReadError;
        });
        const unresolved = next.tasks.some(task => task.workId === work.id && task.executor !== 'main' && task.required && task.status !== 'accepted')
          || fusionPendingReviews(next).some(row => row.workId === work.id)
          || next.attempts.some(row => row.id !== main.id && row.workId === work.id && NATIVE_UNSETTLED.includes(row.status));
        const stopping = stopped || ['stopping', 'stopped'].includes(work.status);
        if (!turn.completed || turn.error || arrived || unresolved || stopping || candidate.planId !== work.planId) {
          if (!turn.supersededBy) work.status = stopping ? work.status === 'stopped' ? 'stopped' : 'stopping' : 'running';
          fusionEvent(next, 'delivery_pending', { workId: work.id, reason: '交付候选后有新事实或本轮没有成功完成，需要重新核对' });
        } else {
          work.deliveries.push({ ...candidate, endedAt: main.endedAt, mainAttemptId: main.id });
          work.status = 'completed';
        }
        work.candidate = null;
      }
      const batch = main.reviewBatch;
      if (batch) {
        const pending = fusionPendingReviews(next), ids = new Set(batch.attemptIds);
        const remaining = pending.filter(row => ids.has(row.attemptId));
        batch.remaining = remaining.map(row => row.attemptId); batch.endedAt = main.endedAt;
        batch.outcome = stopped ? 'stopped' : !remaining.length ? 'done' : remaining.every(row => row.waitingFor) ? 'waiting'
          : remaining.length < ids.size || batch.key !== fusionReviewKey(next, pending) ? 'progress' : 'incomplete';
      }
      if (turn.supersededBy) return;
      if (!next.stopRequested && !stopped && (turn.error || !turn.completed)) {
        delete next.reviewBlock;
        next.status = 'blocked'; next.blockedReason = turn.error || '主控原生轮次被中断或未完成，等待用户继续';
      } else if (!next.stopRequested && main.origin === 'events' && batch?.outcome === 'incomplete') {
        const tasks = [...new Set(batch.remaining.map(id => next.attempts.find(row => row.id === id).taskId))];
        const reason = `主控本轮有 ${batch.remaining.length} 项结果未处置：${tasks.slice(0, 3).join('、')}${tasks.length > 3 ? '…' : ''}。需继续审核。`;
        next.reviewBlock = { attemptId: main.id, key: fusionReviewKey(next, fusionPendingReviews(next)), reason };
        next.status = 'blocked'; next.blockedReason = reason;
      } else if (!next.stopRequested) { next.status = 'waiting'; next.blockedReason = ''; }
    });
    this.finishStop();
    this.wake();
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
      if (question?.answeredAt) throw new Error('这个问题已回答，请重新读取');
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
  markStopped(next, attempt) {
    const task = next.tasks.find(row => row.id === attempt.taskId);
    attempt.stopRequested = true;
    if (attempt.submission === 'not_submitted') {
      Object.assign(attempt, { status: 'cancelled', endedAt: Date.now() });
      this.settleExecution(next, attempt, 'cancelled');
      if (task?.attemptIds.at(-1) === attempt.id) task.status = 'cancelled';
      const worker = task && next.agents.find(row => row.id === task.workerId);
      if (worker) worker.status = 'idle';
    } else {
      attempt.status = 'stopping';
      if (task?.attemptIds.at(-1) === attempt.id) task.status = 'stopping';
    }
    for (const effect of next.effects.filter(row => row.kind === 'stop' && row.data.attemptId === attempt.id && row.status === 'pending'))
      Object.assign(effect, { status: 'done', endedAt: Date.now() });
  }
  stopAttempt(attemptId, { marked = false } = {}) {
    if (this.stops.has(attemptId)) return this.stops.get(attemptId);
    const job = Promise.resolve().then(async () => {
      let attempt = this.run.attempts.find(row => row.id === attemptId);
      if (!attempt) return;
      if (!marked) this.commit(next => {
        const row = next.attempts.find(value => value.id === attemptId);
        if (!row.endedAt) this.markStopped(next, row);
        else for (const effect of next.effects.filter(value => value.kind === 'stop' && value.data.attemptId === attemptId && value.status === 'pending'))
          Object.assign(effect, { status: 'done', endedAt: Date.now() });
      });
      attempt = this.run.attempts.find(row => row.id === attemptId);
      if (attempt.submission === 'not_submitted') { this.scheduler.cancelAttempt(this.run.id, attemptId); return; }
      if (attempt.endedAt) return;
      if (attempt.kind === 'main' && attempt.origin !== 'events') return this.controller.stop(attempt);
      if (attempt.nativeTerminal) return;
      if (this.run.tasks.find(row => row.id === attempt.taskId)?.executor === 'main') {
        const main = this.run.attempts.find(row => row.kind === 'main' && row.native?.threadId === attempt.native?.threadId
          && row.native?.turnId === attempt.native?.turnId);
        if (!main) throw new Error('主控实际轮次待核对');
        return this.stopAttempt(main.id);
      }
      if (!this.jobs.has(attemptId)) this.schedule(attemptId, true);
      return this.agent.stop(attemptId);
    }).catch(error => {
      this.report('stop', error);
      if (!this.writeBlocked) this.commit(next => {
        const row = next.attempts.find(row => row.id === attemptId);
        if (!row.endedAt && !row.nativeTerminal) row.stopError = error.message;
      });
    }).finally(() => { this.stops.delete(attemptId); this.wake(); });
    this.stops.set(attemptId, job);
    return job;
  }
  async stop({ workId = '', taskId = '' } = {}) {
    const run = this.run;
    if (workId && !run.works.some(row => row.id === workId)) throw new Error('没有这个工作项');
    if (taskId && !run.tasks.some(row => row.id === taskId && (!workId || row.workId === workId))) throw new Error('没有这个任务');
    const all = !workId && !taskId;
    const targets = this.commit(next => {
      if (all) { next.stopRequested = true; next.status = 'stopping'; }
      if (workId) next.works.find(row => row.id === workId).status = 'stopping';
      for (const task of next.tasks.filter(row => (!workId || row.workId === workId) && (!taskId || row.id === taskId))) task.stopRequested = true;
      const targets = next.attempts.filter(row => !row.endedAt && (!workId || fusionAttemptWorkIds(next, row).includes(workId))
        && (!taskId || row.taskId === taskId) && (row.status === 'queued' || NATIVE_UNSETTLED.includes(row.status)));
      for (const row of targets) this.markStopped(next, row);
      return targets.map(row => row.id);
    });
    if (all) for (const waiter of this.waiters.values()) this.cancelWait(waiter.native);
    await Promise.all(targets.map(id => this.stopAttempt(id, { marked: true })));
    this.finishStop();
  }
  finishStop() {
    const run = this.run;
    const unsettled = attempt => !attempt.endedAt && (NATIVE_UNSETTLED.includes(attempt.status) || attempt.status === 'queued');
    const works = run.works.filter(work => work.status === 'stopping'
      && !run.attempts.some(row => fusionAttemptWorkIds(run, row).includes(work.id) && unsettled(row))).map(row => row.id);
    const status = run.stopRequested ? run.attempts.some(unsettled) ? 'stopping' : 'stopped' : run.status;
    if (works.length || status !== run.status) this.commit(next => {
      next.status = status;
      for (const work of next.works.filter(row => works.includes(row.id))) work.status = 'stopped';
    });
  }
  async resume() {
    this.commit(next => {
      delete next.reviewBlock;
      next.stopRequested = false; next.blockedReason = ''; next.status = 'recovering';
      for (const task of next.tasks) delete task.stopRequested;
    });
    this.writeBlocked = false;
    await this.recover();
  }
  remove() { return this.setup(() => this.removeBindings()); }
  async removeBindings() {
    const run = this.run;
    if ([run.main, ...run.agents].some(owner => owner.creations?.some(row => ['creating', 'unknown'].includes(row.status)))
      || run.attempts.some(row => row.status === 'queued' || NATIVE_UNSETTLED.includes(row.status)))
      throw new Error('工作台仍有未结束或结果待核对的执行，请先停止并核对');
    this.commit(next => { next.stopRequested = true; });
    await this.controller.close();
    this.agent.releaseMainProject(run);
    const targets = new Map();
    for (const binding of run.bindings.filter(row => row.threadId)) {
      const key = JSON.stringify([binding.app, binding.project.id, binding.threadId]);
      if (!targets.has(key) || binding.role === 'main') targets.set(key, binding);
    }
    const bindings = [...targets.values()].sort((a, b) => Number(a.role === 'main') - Number(b.role === 'main'));
    this.commit(next => {
      next.removal = { total: bindings.length, done: bindings.filter(binding => binding.cleanup?.confirmed).length, error: '' };
    });
    for (const binding of bindings.filter(row => row.cleanup?.confirmed !== true)) {
      if (binding.role === 'main' && run.removal.error) break;
      try {
        const receipt = await this.agent.cleanupBinding(run, binding);
        this.commit(next => {
          next.removal.done++;
          for (const row of next.bindings.filter(row => row.app === binding.app && row.project.id === binding.project.id && row.threadId === binding.threadId))
            row.cleanup = receipt;
        });
      } catch (error) {
        if (error.fusionStoreError) throw error;
        this.commit(next => {
          next.bindings.find(row => row.id === binding.id).cleanup = { confirmed: false, error: error.message, at: Date.now() };
          if (!next.removal.error) {
            const label = next.agents.find(row => row.bindingId === binding.id)?.label || binding.threadId;
            next.removal.error = `${binding.app} · ${label} · ${error.message}`;
            next.removal.target = { app: binding.app, label };
          }
        });
      }
    }
    if (run.removal.error) throw new Error(run.removal.error);
    this.commit(next => { next.removedAt = Date.now(); next.favorite = false; });
    await this.dispose();
  }
  recover() {
    if (this.closed) return;
    this.recovering ||= this.restore().finally(() => { this.recovering = null; });
    return this.recovering;
  }
  async restore() {
    const run = this.run;
    const interrupted = run.effects.filter(row => row.status === 'executing'
      && (row.kind === 'stop' || row.kind !== 'execute' && this.recoveringFromDisk));
    if (interrupted.length) this.commit(next => {
      for (const effect of next.effects.filter(row => interrupted.some(old => old.id === row.id)))
        effect.status = 'outcomeUnknown';
    });
    this.recoveringFromDisk = false;
    const unfinished = run.attempts.filter(row => !row.endedAt && (NATIVE_UNSETTLED.includes(row.status) || row.status === 'queued'));
    const legacyStops = unfinished.filter(row => row.status === 'stopping' && row.stopRequested === undefined);
    if (legacyStops.length) this.commit(next => {
      for (const row of next.attempts.filter(row => legacyStops.some(old => old.id === row.id))) {
        row.stopRequested = true;
        row.stopOutcomeUnknown = true;
      }
    });
    const unsent = unfinished.filter(row => row.submission === 'not_submitted' && (run.stopRequested
      || row.kind === 'main' && row.origin === 'events' && !this.jobs.has(row.id)));
    if (unsent.length) this.commit(next => {
      for (const attempt of next.attempts.filter(row => unsent.some(old => old.id === row.id))) this.markStopped(next, attempt);
    });
    this.finishStop();
    if (run.stopRequested && run.status === 'stopped') return;
    // Worker recovery proceeds even if the main native window cannot connect.
    for (const attempt of unfinished) {
      if (attempt.kind !== 'main' || attempt.origin === 'events')
        this.schedule(attempt.id, attempt.submission !== 'not_submitted');
    }
    try { await this.controller.start(); }
    catch (error) { this.blockMain(error); this.wake(); return; }
    if (this.closed) return;
    for (const attempt of run.attempts.filter(row => row.kind === 'main' && row.origin !== 'events' && !row.endedAt
      && NATIVE_UNSETTLED.includes(row.status))) {
      try { await this.controller.reconcile(attempt); }
      catch (error) { this.attemptFailed(attempt.id, error, true); }
    }
    if (run.status === 'recovering' && !run.attempts.some(row => row.kind === 'main' && row.status === 'unknown') && !run.reviewBlock)
      this.commit(next => {
        next.status = next.attempts.some(row => row.kind === 'main' && row.status === 'running') ? 'running' : 'waiting';
        next.blockedReason = '';
      });
    this.wake();
  }
  async dispose() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.values()) this.cancelWait(waiter.native);
    this.scheduler.cancel(this.run.id);
    this.agent.dispose();
    try { await this.controller.close(); }
    finally { this.onDispose(); }
  }
}

export class FusionRuntime {
  constructor({ state = fusionState, scheduler = new FusionScheduler(), createRunner = (run, options) => new FusionRunner(run, options) } = {}) {
    this.state = state;
    this.scheduler = scheduler;
    this.createRunner = createRunner;
    this.runners = new Map();
  }
  runner(run) {
    if (!run || run.removedAt || stateOfFusionRun(run) !== this.state) throw new Error('Fusion 工作台不属于此运行时或已移除');
    if (!this.runners.has(run)) this.runners.set(run, this.createRunner(run, {
      scheduler: this.scheduler, adapterRegistry: this.adapterRegistry, onDispose: () => this.runners.delete(run),
    }));
    return this.runners.get(run);
  }
  initialize({ adapterRegistry } = {}) {
    if (this.initialized) return [];
    this.initialized = true;
    this.adapterRegistry = adapterRegistry;
    this.state.initialize();
    return this.state.all().filter(run => run.main.bindingId).map(run => Promise.resolve().then(async () => {
      const runner = this.runner(run);
      if (run.stopRequested && run.status === 'stopped') return;
      runner.recoveringFromDisk = true;
      runner.commit(next => { next.status = next.stopRequested ? 'stopping' : 'recovering'; });
      await runner.recover();
    }).catch(error => {
      const runner = this.runners.get(run);
      if (runner) runner.blockMain(error);
      else this.state.report('recovery', error, run);
    }));
  }
}

export const fusionRuntime = new FusionRuntime();
export function fusionRunner(run) { return fusionRuntime.runner(run); }
