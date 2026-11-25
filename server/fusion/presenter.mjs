import crypto from 'node:crypto';
import { fusionSummary, NATIVE_UNSETTLED, stateOfFusionRun } from './state.mjs';
import { fusionPendingReviews } from './control.mjs';
import { indexFusionRun } from './run-index.mjs';
import { fusionRuntime } from './runner.mjs';

export const fusionViewers = new Set();

export function fusionBindingView({ id, role, app, windowId, threadId, host, project, created }) {
  return { id, role, app, windowId, threadId, host, project: { id: project.id, root: project.root, host: project.host, name: project.name }, created };
}

function fusionAuditEvent({ id, type, at, deliveredTo, data }) {
  const { workId, taskId, attemptId, bindingId, text, nativeRequest, action, reason, submission, details, planId, decision, questionId, native } = data;
  const origin = native && { app: native.app, threadId: native.threadId, turnId: native.turnId, requestId: native.requestId,
    messageId: native.messageId, callId: native.callId, decisionId: native.decisionId, generationId: native.generationId };
  return { id, type, at, deliveredTo, data: { workId, taskId, attemptId, bindingId, text, nativeRequest,
    action, reason, submission, details, planId, decision, questionId, native: origin } };
}

function nativeInteractions(run, runner) {
  return run.tasks.flatMap(task => {
    const attempt = run.attempts.findLast(row => row.taskId === task.id);
    const live = attempt && !attempt.endedAt && runner?.agent.live.get(attempt.id);
    if (!live) return [];
    const requests = live.chat?.questions?.codex ? live.chat.questions.requests || [] : [];
    const questions = live.chat?.questions?.codex ? null : live.chat?.questions;
    const openCodeQuestions = attempt.app === 'opencode' ? (live.chat?.items || []).filter(row => row.k === 'opencodeQuestion') : [];
    const items = (live.chat?.items || []).flatMap(item => {
      const key = item.btnItem || item.i, waiting = live.state?.waiting;
      if (attempt.app === 'cursor') {
        if (!item.approvalId || !live.state?.waitingToolIds?.includes(item.approvalId)) return [];
        const buttons = (item.b || []).flatMap((label, n) => {
          const actionId = item.actions?.[n];
          return [item.approvalId + ':accept', item.approvalId + ':reject'].includes(actionId) ? [{ label, n, actionId }] : [];
        });
        return buttons.length ? [{ i: item.i, btnItem: key, buttons }] : [];
      }
      if (typeof waiting !== 'string' || !waiting.startsWith(key + ':')) return [];
      const labels = waiting.slice(key.length + 1).split('/');
      const buttons = (item.b || []).flatMap((label, n) => labels.includes(label) ? [{ label, n, actionId: item.actions?.[n] || '' }] : []);
      return buttons.length ? [{ i: item.i, btnItem: key, buttons }] : [];
    });
    if (!requests.length && !questions?.list?.length && !items.length && !openCodeQuestions.length && !live.remoteWaiting) return [];
    return [{ id: attempt.id, taskId: task.id, workId: task.workId, goal: task.goal, app: attempt.app,
      attemptId: attempt.id, bindingId: attempt.bindingId, native: attempt.native, items, requests, questions,
      ...(openCodeQuestions.length ? { openCodeQuestions } : {}), ...(live.remoteWaiting ? { remoteWaiting: live.remoteWaiting } : {}) }];
  });
}
function taskSummaries(run, taskId, index) {
  const assignments = index('assignments', 'taskId');
  const attempts = index('attempts', 'taskId');
  const works = index('works');
  return run.tasks.map(task => {
    const assignment = assignments.get(task.id), attempt = attempts.get(task.id), work = works.get(task.workId);
    const needsUser = task.status === 'awaiting_user' && !attempt?.endedAt
      || run.questions.some(row => row.taskId === task.id && !row.answeredAt);
    const state = needsUser ? 'wait' : ['failed', 'unknown', 'stopped'].includes(task.status) ? 'err'
      : task.status === 'accepted' ? 'done' : ['running', 'preparing', 'submitting', 'stopping'].includes(task.status) ? 'run' : 'idle';
    return { id: task.id, workId: task.workId, goal: task.goal, status: task.status, access: task.access,
      dependsOn: task.dependsOn, workerId: task.workerId, executor: task.executor,
      app: assignment?.app, model: assignment?.model, effort: assignment?.effort, state, needsUser,
      attemptCount: task.attemptIds.length, attemptId: attempt?.id, bindingId: attempt?.bindingId,
      updated: Math.max(task.updated || 0, attempt?.endedAt || attempt?.acceptedAt || attempt?.created || 0, task.reviews.at(-1)?.at || 0,
        ...task.inputs.map(row => row.deliveredAt || row.created || 0),
        ...run.events.filter(row => row.taskId === task.id || row.data?.taskId === task.id).map(row => row.at)),
      ...(task.id === taskId ? { summary: taskProgress(attempt, work, task) } : {}) };
  });
}
function taskProgress(attempt, work, task) {
  const before = attempt?.baseline, after = attempt?.changes;
  // A directory snapshot has no per-file hashes for tracked descendants. Do not present a guessed count.
  const files = before?.available && after?.available && ![...before.files, ...after.files].some(row => row.directory)
    ? after.files.filter(row => {
      const old = before.files.find(value => value.path === row.path);
      return old && (row.exists !== old.exists || row.sha256 !== old.sha256);
    }).length : null;
  return { text: (attempt?.result?.error || attempt?.result?.text || '').slice(0, 400), files,
    durationMs: attempt?.durationMs ?? null, submission: attempt?.submission || 'not_submitted',
    acceptedAt: attempt?.acceptedAt, endedAt: attempt?.endedAt, completed: attempt?.result?.completed ?? null,
    reviewedAt: attempt?.reviewedAt, delivered: work?.status === 'completed' && task.status === 'accepted' };
}
function mainCommandOrigin(run, action, field, id) {
  const command = run.commands.find(row => row.action === action && row.result[field] === id);
  if (!command) return;
  return { ...command.native,
    messageId: run.attempts.find(row => row.kind === 'main' && row.native?.turnId === command.native.turnId)?.native.messageId };
}
function taskBoard(run, tasks, runner) {
  return { tasks, nativeInteractions: nativeInteractions(run, runner),
    agents: run.agents.map(({ id, label, bindingId }) => ({ id, label, bindingId })),
    assignments: run.tasks.map(task => run.assignments.findLast(row => row.taskId === task.id)).filter(Boolean)
      .map(({ taskId, app, model, effort }) => ({ taskId, app, model, effort })),
    dispatches: run.commands.filter(row => row.action === 'dispatch' || row.action === 'continue_task' && run.tasks.find(task => task.id === row.result.taskId)?.executor !== 'main').map(row => ({
      id: row.id, action: row.action, native: { ...row.native,
        messageId: run.attempts.find(attempt => attempt.kind === 'main' && attempt.native?.turnId === row.native.turnId)?.native.messageId }, at: row.appliedAt,
      tasks: (row.result.tasks || [row.result]).map(({ taskId, attemptId }) => ({ taskId, attemptId })) })),
    questions: run.questions.map(row => ({ ...row, native: mainCommandOrigin(run, 'ask_user', 'questionId', row.id),
      answerNative: run.events.find(event => event.id === row.inputId)?.data.native })),
    works: run.works.map(work => ({ id: work.id, title: work.title, goal: work.goal, status: work.status, project: work.project,
      planId: work.planId, plans: work.plans.filter(row => row.id === work.planId).map(row => ({ ...row,
        native: mainCommandOrigin(run, 'plan', 'planId', row.id) })),
      deliveries: work.deliveries.map((row, index) => ({ index, summary: row.summary })) })) };
}
function controllerView(run, tasks, index, runner) {
  const { app, model, effort, bindingId, windowId, error, projectTrust } = run.main;
  const preparing = !!runner?.settingUp;
  const failure = stateOfFusionRun(run).failures.get(JSON.stringify(['write', run.deviceId, run.id, '']));
  const counts = { run: 0, wait: 0, done: 0, err: 0, idle: 0 };
  for (const task of tasks) counts[task.state]++;
  const attention = run.questions.filter(row => !row.answeredAt).map(row => ({ kind: 'question', workId: row.workId,
    taskId: row.taskId, questionId: row.id, text: row.text.slice(0, 200) }));
  for (const work of run.works) {
    const plan = work.plans.find(row => row.id === work.planId);
    if (plan && !plan.confirmed && !plan.decision) attention.push({ kind: 'plan', workId: work.id, planId: plan.id, text: work.title });
  }
  for (const task of tasks.filter(row => row.needsUser)) if (!attention.some(row => row.taskId === task.id))
    attention.push({ kind: 'native', workId: task.workId, taskId: task.id, text: task.goal });
  const tasksById = new Map(tasks.map(task => [task.id, task])), worksById = index('works');
  const attemptsById = index('attempts');
  const executing = run.attempts.filter(row => !row.endedAt && (row.status === 'queued' || NATIVE_UNSETTLED.includes(row.status)));
  const unknown = executing.find(row => row.status === 'unknown');
  const pending = tasks.length ? fusionPendingReviews(run, index).filter(row => !['stopped', 'cancelled'].includes(tasksById.get(row.taskId)?.status)) : [];
  const failedReview = pending.find(row => row.outcome === 'failed');
  const currentAttempt = unknown || executing.findLast(row => row.kind === 'main') || executing.at(-1)
    || attemptsById.get((failedReview || pending[0])?.attemptId);
  const currentTask = tasks.find(row => row.needsUser) || tasksById.get(currentAttempt?.taskId);
  const currentWork = worksById.get(currentAttempt?.workExecutions?.at(-1)?.workId || currentAttempt?.workId);
  const currentInput = currentAttempt?.kind === 'main' ? run.events.findLast(event => event.type === 'user_input'
    && (currentAttempt.native?.turnId && event.data.native?.turnId === currentAttempt.native.turnId || currentAttempt.eventIds?.includes(event.id))) : null;
  const current = currentTask ? { text: currentTask.goal,
    status: currentAttempt?.taskId === currentTask.id ? currentAttempt.status : currentTask.status, needsUser: currentTask.needsUser }
    : currentAttempt ? { text: currentWork?.title || currentInput?.data.text?.slice(0, 200) || run.title,
      status: currentAttempt.status, needsUser: false } : null;
  const state = failure || runner?.writeBlocked ? 'err' : attention.length || run.status === 'awaiting_user' ? 'wait'
    : ['blocked', 'stopped'].includes(run.status) ? 'err' : ['recovering', 'stopping'].includes(run.status) ? 'run'
      : unknown ? 'err' : executing.length || preparing ? 'run' : failedReview ? 'err'
        : run.works.length && run.works.every(row => row.status === 'completed') ? 'done' : pending.length ? 'run' : 'idle';
  const settled = !preparing && !['running', 'recovering', 'stopping', 'awaiting_user'].includes(run.status)
    && !run.attempts.some(row => row.status === 'queued' || NATIVE_UNSETTLED.includes(row.status));
  const resultKey = settled && ['done', 'err'].includes(state) ? crypto.createHash('sha256').update(JSON.stringify([
    state, run.status, run.blockedReason, failure?.message, run.attempts.map(row => [row.id, row.status, row.endedAt]),
    run.works.map(work => [work.id, work.status, work.deliveries.map(row => [row.mainAttemptId, row.nativeTurnId, row.endedAt])]),
  ])).digest('hex') : '';
  const binding = run.bindings.find(row => row.id === bindingId);
  const nativeWindowId = binding && (binding.app === 'codex' || binding.windowId.startsWith(binding.app + ':')
    ? binding.windowId : `${binding.app}:${binding.windowId}`);
  const target = binding ? { computer: run.computer, win: binding.app === 'codex' ? 'codex' : nativeWindowId,
    windowId: nativeWindowId, threadId: binding.threadId, project: { root: binding.project.root, host: binding.host || '' } } : null;
  return { ...fusionSummary(run), ...(failure || runner?.writeBlocked ? { blockedReason: 'Fusion 状态写入失败，请检查 Relay 日志并继续核对' } : {}), main: { app, model, effort, bindingId, windowId, preparing, error, projectTrust, target },
    internalInputs: run.attempts.filter(row => row.kind === 'main' && row.origin === 'events' && row.native?.messageId)
      .map(row => ({ threadId: row.native.threadId, messageId: row.native.messageId })),
    overview: { state, resultKey, counts, apps: [...new Set([app, ...tasks.map(row => row.app)].filter(Boolean))], attention,
      current } };
}
export function fusionControllerView(run, runner = fusionRuntime.runners.get(run)) {
  const index = indexFusionRun(run);
  return controllerView(run, taskSummaries(run, undefined, index), index, runner);
}
export function fusionRunView(run, view, runner = fusionRuntime.runners.get(run)) {
  const index = indexFusionRun(run);
  const tasks = taskSummaries(run, view.kind === 'task' ? view.taskId : undefined, index);
  const base = { ...controllerView(run, tasks, index, runner), revision: run.revision };
  if (view.kind === 'config') return { ...base, budget: run.budget,
    capabilities: [...new Set(run.capabilities.map(row => row.app))].map(app => {
      const row = run.capabilities.find(row => row.app === app);
      return { app, models: row.models };
    }) };
  if (view.kind === 'input') return { ...base, questions: run.questions.filter(row => row.id === view.questionId) };
  if (view.kind === 'tasks') return { ...base, ...taskBoard(run, tasks, runner) };
  const task = run.tasks.find(row => row.id === view.taskId);
  if (view.kind === 'inputs') return { inputs: task.inputs,
    assignments: run.assignments.filter(row => row.taskId === task.id).map(({ id, input, created }) => ({ id, input, created })) };
  if (view.kind === 'reviews') return { reviews: task.reviews };
  if (view.kind === 'attempt') {
    const { prompt, promptContext, beforeIds, ...attempt } = run.attempts.find(row => row.id === view.attemptId);
    return { ...attempt, cost: run.assignments.find(row => row.id === attempt.assignmentId)?.cost,
      events: run.events.filter(row => row.data?.attemptId === attempt.id).map(fusionAuditEvent) };
  }
  if (view.kind === 'delivery') return run.works.find(row => row.id === view.workId).deliveries[view.index];
  if (view.kind !== 'task') throw new Error('未知 Fusion 视图');
  const agent = run.agents.find(row => row.id === task.workerId);
  const attempts = run.attempts.filter(row => row.taskId === task.id), latest = attempts.at(-1);
  const bindingId = latest?.bindingId || agent?.bindingId;
  return { ...base, board: taskBoard(run, tasks, runner), tasks: [tasks.find(row => row.id === task.id)],
    agents: agent ? [{ id: agent.id, bindingId: agent.bindingId }] : [],
    bindings: run.bindings.filter(row => row.id === bindingId).map(fusionBindingView),
    attempts: attempts.map(attempt => ({ id: attempt.id, taskId: attempt.taskId, bindingId: attempt.bindingId,
      app: attempt.app, model: attempt.model, effort: attempt.effort, status: attempt.status })) };

}
export function attachFusionPresenter(runtime = fusionRuntime, viewers = fusionViewers) {
  return runtime.state.subscribe(run => {
    const runner = runtime.runners.get(run);
    const summary = safeFusionControllerView(run, runner);
    if (!summary) return;
    for (const viewer of viewers) {
      try {
        viewer.emit({ t: 'fusionUpdate', computer: run.computer, run: summary });
        if (run.removedAt) {
          if (viewer.fusionDetail?.runId === run.id) viewer.fusionDetail = null;
          if (viewer.fusionRun?.id === run.id) viewer.fusionRun = null;
          continue;
        }
        if (viewer.fusionDetail?.runId === run.id) {
          const view = viewer.fusionDetail.view;
          viewer.emit({ t: 'fusionState', computer: run.computer, runId: run.id, view, run: fusionRunView(run, view, runner) });
        }
      } catch (error) { runtime.state.report('view', error, run); }
    }
  });
}

export function safeFusionControllerView(run, runner) {
  try { return fusionControllerView(run, runner); }
  catch (error) { stateOfFusionRun(run).report('view', error, run); return null; }
}
