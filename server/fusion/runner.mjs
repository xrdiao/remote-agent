import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { EDITORS } from '../config.mjs';
import { FusionAgent } from './agent.mjs';
import { fusionScheduler } from './scheduler.mjs';
import { fusionRuns, fusionWorkers, newFusionAttempt, publishFusion, fusionEvent, fusionMessage, NATIVE_UNSETTLED } from './state.mjs';
import { applyFusionDecision, fusionDecisionPrompt, fusionTaskPrompt } from './control.mjs';
import { validateExecution } from './cost.mjs';

export class FusionRunner {
  constructor(run, { agent = new FusionAgent(), scheduler = fusionScheduler, publish = publishFusion } = {}) {
    this.run = run;
    this.agent = agent;
    this.scheduler = scheduler;
    this.publish = publish;
    this.jobs = new Map();
    this.archiving = new Set();
    this.recovering = new Set();
    this.pumping = null;
    this.decisionPending = false;
  }
  message(text, id) {
    const run = this.run;
    if (run.events.some(event => event.id === id)) return;
    if (!text.trim()) throw new Error('消息不能为空');
    fusionMessage(run, 'human', text, { id });
    fusionEvent(run, 'user', { text }, id);
    if (run.title === '新 Fusion run') run.title = text.split('\n')[0].slice(0, 80);
    if (!run.stopRequested) { run.status = 'running'; run.blockedReason = ''; }
    this.publish(run);
    this.wake();
  }
  confirm(planId) {
    const authorization = this.run.authorization;
    if (!authorization || authorization.planId !== planId || authorization.confirmed) throw new Error('方案已变化或已经确认，请读取当前方案');
    authorization.confirmed = true;
    authorization.confirmedAt = Date.now();
    fusionEvent(this.run, 'authorization', { planId, scope: authorization.scope });
    this.run.status = 'running';
    this.publish(this.run);
    this.wake();
  }
  wake() {
    if (this.pumping) { this.again = true; return this.pumping; }
    this.pumping = this.pump().catch(error => this.block(error)).finally(() => {
      this.pumping = null;
      if (this.again) { this.again = false; this.wake(); }
    });
    return this.pumping;
  }
  block(error) {
    this.run.status = this.run.stopRequested ? 'stopping' : 'blocked';
    this.run.blockedReason = error.message;
    this.publish(this.run);
  }
  async pump() {
    const run = this.run;
    if (run.stopRequested) return this.finishStop();
    if (['blocked', 'completed', 'stopped'].includes(run.status)) return;
    for (const attempt of run.attempts.filter(value => value.kind === 'task' && value.status === 'queued')) this.schedule(attempt.id);
    const events = run.events.filter(event => !event.consumedBy);
    if (!events.length || this.decisionPending) return;
    // Plan confirmation is a distinct event; an unrelated message never silently grants it.
    if (run.authorization?.required && !run.authorization.confirmed && !events.some(event => event.type === 'user')) return;
    this.decisionPending = true;
    try {
      await this.prepareCapabilities();
      if (run.stopRequested) return;
      validateExecution(run, run.main);
      const attempt = newFusionAttempt(run, null, { app: run.main.app, model: run.main.model, effort: run.main.effort || '' }, null, 'decision');
      const request = { id: crypto.randomUUID(), attemptId: attempt.id, eventIds: run.events.filter(event => !event.consumedBy).map(event => event.id),
        status: 'queued', created: Date.now(), native: null };
      run.decisions.push(request);
      this.publish(run);
      await this.schedule(attempt.id, request.id);
    } finally {
      this.decisionPending = false;
      for (const { app } of EDITORS) this.cleanup(app);
    }
  }
  async prepareCapabilities() {
    const run = this.run;
    for (const editor of EDITORS) {
      if (run.stopRequested) return;
      if (this.scheduler.slots.has(editor.app) && run.capabilities.some(value => value.app === editor.app)) continue;
      try {
        const targets = await (await fetch(editor.url + '/json/list', { signal: AbortSignal.timeout(1500) })).json();
        if (!targets.some(value => value.type === 'page' && /workbench/.test(value.url))) throw new Error('当前没有可用的原生窗口');
        const snapshot = await this.scheduler.submit({ runId: run.id, app: editor.app, projectKey: run.project.id, access: 'read',
          ready: () => !run.stopRequested, execute: () => this.agent.capabilities(run, editor.app) });
        run.capabilities = [...run.capabilities.filter(value => value.app !== editor.app), snapshot];
      } catch (error) {
        if (error.cancelled) return;
        run.capabilities = [...run.capabilities.filter(value => value.app !== editor.app), { app: editor.app, available: false,
          at: Date.now(), source: '本次原生能力读取', error: error.message, models: [] }];
      }
    }
    this.publish(run);
  }
  schedule(attemptId, decisionId = '') {
    if (this.jobs.has(attemptId)) return this.jobs.get(attemptId);
    const run = this.run;
    const current = () => run.attempts.find(value => value.id === attemptId);
    const task = () => run.tasks.find(value => value.id === current().taskId);
    const isDecision = current().kind === 'decision';
    const job = this.scheduler.submit({ runId: run.id, attemptId, app: current().app, projectKey: run.project.id,
      access: isDecision ? 'read' : task().access,
      ready: () => (this.recovering.has(attemptId) || !run.stopRequested) && (isDecision || current().status === 'queued' && task().dependsOn.every(id => run.tasks.find(value => value.id === id)?.status === 'accepted')),
      execute: async () => {
        const recovering = this.recovering.has(attemptId);
        if (!recovering) current().status = 'preparing';
        if (task()) task().status = recovering ? 'recovering' : 'running';
        this.publish(run);
        const request = isDecision && run.decisions.find(value => value.id === decisionId || value.attemptId === attemptId);
        if (isDecision && !recovering) {
          request.eventIds = run.events.filter(event => !event.consumedBy).map(event => event.id);
          request.startedAt = Date.now();
          this.publish(run);
        }
        const prompt = recovering ? current().prompt : isDecision
          ? fusionDecisionPrompt(run, request, await this.projectInstructions()) : fusionTaskPrompt(run, task(), current());
        return { result: await this.agent.execute(run, attemptId, prompt, recovering), decisionId: request?.id || '' };
      },
    }).then(({ result, decisionId: completedDecision }) => {
      const attempt = current();
      Object.assign(attempt, { status: result.stopped ? 'stopped' : isDecision ? 'completed' : 'awaiting_review',
        native: result.native, endedAt: result.endedAt || Date.now(), result: { text: result.text, completed: result.completed },
        changes: result.changes, usage: result.usage, durationMs: Date.now() - (attempt.acceptedAt || attempt.created) });
      delete attempt.live;
      if (task()) task().status = result.stopped ? 'stopped' : 'awaiting_review';
      if (result.stopped) return;
      if (isDecision) {
        const request = run.decisions.find(value => value.id === completedDecision);
        request.native = result.native;
        try {
          const applied = applyFusionDecision(run, request, { ...result, role: 'main' });
          for (const command of applied.commands || []) {
            if (command.type === 'cancel') this.scheduler.cancelAttempt(command.attemptId);
            if (command.type === 'stop') this.agent.stop(command.attemptId).catch(error => this.block(error));
            if (command.type === 'archive') this.archive(command.bindingId);
          }
        } catch (error) {
          request.status = 'invalid'; request.error = error.message;
          fusionMessage(run, 'assistant', result.text, { decisionId: request.id, invalidControl: error.message });
          fusionEvent(run, 'control_error', { decisionId: request.id, reason: error.message });
          this.block(error);
        }
      } else fusionEvent(run, 'task_result', { taskId: attempt.taskId, attemptId, result: attempt.result, changes: attempt.changes, usage: attempt.usage });
    }).catch(error => {
      const attempt = current();
      if (error.cancelled) attempt.status = 'cancelled';
      else {
        if (attempt.submission !== 'not_submitted' && !attempt.nativeGenerationEndedAt && !error.nativeEnded) {
          attempt.status = 'unknown';
          this.scheduler.uncertain.set(attempt.app, attempt.id);
          if (task()?.access === 'write') this.scheduler.uncertainWriters.set(run.project.id, attempt.id);
        }
        if (attempt.status !== 'unknown') { attempt.status = 'failed'; attempt.endedAt = attempt.nativeGenerationEndedAt || (error.nativeEnded ? Date.now() : null); }
        attempt.error = error.message;
        if (task()) task().status = attempt.status;
        fusionEvent(run, 'native_error', { taskId: attempt.taskId, attemptId, reason: error.message, submission: attempt.submission });
        if (isDecision || attempt.status === 'unknown') this.block(error);
        else { run.status = run.stopRequested ? 'stopping' : 'running'; run.blockedReason = ''; }
      }
    }).finally(() => {
      this.jobs.delete(attemptId);
      this.recovering.delete(attemptId);
      this.publish(run);
      this.scheduler.drain();
      if (run.stopRequested) this.finishStop(); else this.wake();
      this.cleanup(current().app);
    });
    this.jobs.set(attemptId, job);
    return job;
  }
  archive(bindingId) {
    const binding = this.run.bindings.find(value => value.id === bindingId);
    if (!binding) return;
    this.archiving.add(bindingId);
    this.scheduler.submit({ runId: this.run.id, app: binding.app, projectKey: this.run.project.id, access: 'read',
      ready: () => !this.run.stopRequested, execute: () => this.agent.archive(this.run, bindingId) })
      .catch(error => { binding.archive = { supported: true, error: error.message }; this.publish(this.run); })
      .finally(() => { this.archiving.delete(bindingId); this.cleanup(binding.app); });
  }
  cleanup(app) {
    this.scheduler.submit({ runId: this.run.id, app, projectKey: this.run.project.id, access: 'read', ready: () => true,
      execute: () => this.agent.recycle(this.run, app) })
      .catch(error => { if (!error.cancelled) console.log('[Fusion window cleanup]', error.message); });
  }
  async projectInstructions() {
    if (this.run.project.host) return '远程项目：请使用当前原生会话只读核对实际项目及祖先目录的 AGENTS.md。';
    const documents = [];
    let directory = this.run.project.root;
    for (;;) {
      try { documents.unshift(`${path.join(directory, 'AGENTS.md')}\n${await fs.readFile(path.join(directory, 'AGENTS.md'), 'utf8')}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return documents.join('\n\n') || '祖先目录未找到 AGENTS.md；请核对本次范围内其他项目指令。';
  }
  async stop() {
    const run = this.run;
    run.stopRequested = true;
    run.status = 'stopping';
    for (const attempt of run.attempts) if (attempt.status === 'queued') {
      attempt.status = 'cancelled';
      const task = run.tasks.find(value => value.id === attempt.taskId);
      if (task) task.status = 'cancelled';
    }
    this.scheduler.cancel(run.id);
    this.publish(run);
    const results = await Promise.allSettled(run.attempts.filter(attempt => NATIVE_UNSETTLED.includes(attempt.status)).map(async attempt => {
      attempt.status = 'stopping';
      await this.agent.stop(attempt.id);
    }));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) run.blockedReason = failed.reason.message;
    this.finishStop();
  }
  finishStop() {
    if (!this.run.stopRequested) return;
    const unsettled = this.run.attempts.some(attempt => NATIVE_UNSETTLED.includes(attempt.status));
    this.run.status = unsettled || this.jobs.size ? 'stopping' : 'stopped';
    this.publish(this.run);
    if (this.run.status === 'stopped') for (const { app } of EDITORS) this.cleanup(app);
  }
  resume() {
    this.agent.reclaimRequests.set(this.run.id, new Set([this.run.main.app, ...this.run.bindings.map(binding => binding.app)]));
    this.run.stopRequested = false;
    this.run.blockedReason = '';
    this.run.status = 'recovering';
    for (const attempt of this.run.attempts.filter(value => NATIVE_UNSETTLED.includes(value.status))) {
      this.recovering.add(attempt.id);
      attempt.status = 'queued';
      this.schedule(attempt.id);
    }
    if (!this.jobs.size) {
      this.run.status = 'running';
      fusionEvent(this.run, 'resume', { reason: '用户明确继续，先核对所有未知原生执行' });
      this.wake();
    }
    this.publish(this.run);
  }
}

export function fusionRunner(run) {
  const key = JSON.stringify([run.computer, run.deviceId, run.id]);
  let runner = fusionWorkers.get(key);
  if (!runner) { runner = new FusionRunner(run); fusionWorkers.set(key, runner); }
  return runner;
}

export function recoverFusionRuns() {
  for (const saved of Object.values(fusionRuns)) for (const run of saved.runs) {
    const unsettled = run.attempts.filter(attempt => NATIVE_UNSETTLED.includes(attempt.status));
    const queued = run.attempts.some(attempt => attempt.status === 'queued');
    if (!unsettled.length && !queued && !run.events.some(event => !event.consumedBy)) continue;
    if (['awaiting_user', 'completed', 'stopped', 'blocked'].includes(run.status) && !unsettled.length && !queued) continue;
    const runner = fusionRunner(run);
    run.status = 'recovering';
    for (const attempt of unsettled) {
      if (attempt.submission === 'not_submitted') attempt.status = 'queued';
      else {
        runner.recovering.add(attempt.id);
        fusionScheduler.uncertain.set(attempt.app, attempt.id);
        if (run.tasks.find(task => task.id === attempt.taskId)?.access === 'write') fusionScheduler.uncertainWriters.set(run.project.id, attempt.id);
        attempt.status = 'queued';
      }
    }
    if (run.stopRequested) {
      for (const attempt of unsettled.filter(value => runner.recovering.has(value.id))) {
        const stopRequested = run.stopRequested;
        run.stopRequested = false;
        runner.schedule(attempt.id);
        run.stopRequested = stopRequested;
      }
    } else {
      for (const attempt of run.attempts.filter(value => value.kind === 'decision' && value.status === 'queued')) {
        runner.decisionPending = true;
        runner.schedule(attempt.id).finally(() => { runner.decisionPending = false; runner.wake(); });
      }
      runner.wake();
    }
    runner.publish(run);
  }
}
