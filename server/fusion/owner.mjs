import fs from 'node:fs';
import crypto from 'node:crypto';
import { computerId } from '../../lib/auth.mjs';
import { workspaces } from '../../lib/files.mjs';
import { safeHomePath, projectList, createProjectFolder } from '../agent/projects.mjs';
import { fusionRuns, fusionViewers, fusionLive, savedFusion, findFusionRun, allFusionRuns, newFusionRun, fusionProject,
  publishFusion, subscribeFusion, fusionSummary, fusionEvent, NATIVE_UNSETTLED } from './state.mjs';
import { fusionRunner } from './runner.mjs';
import { FUSION_TIERS, validateExecution } from './cost.mjs';
import { fusionPendingReviews } from './control.mjs';
import { nativeAgentProvider } from './providers.mjs';
import { FusionAgent } from './agent.mjs';

function requestedRun(session, message) {
  if (message.computer && message.computer !== computerId()) throw new Error('Fusion 请求不属于这台电脑');
  return findFusionRun(message.runId || session.fusionRun?.id || '');
}
function projectOf(value) {
  if (value?.host) {
    const project = workspaces().map(workspace => fusionProject(workspace.root, workspace.host || '')).find(project => project?.id === fusionProject(value.root, value.host)?.id);
    if (!project) throw new Error('没有核实这个远程项目');
    return project;
  }
  const { real } = safeHomePath(value?.root || '');
  if (!value?.root || !fs.statSync(real).isDirectory()) throw new Error('请选择实际项目目录');
  return fusionProject(real);
}
function mainOf(value) {
  if (!value?.app || !nativeAgentProvider(value.app).controller) throw new Error('请选择提供原生主控工具的软件');
  return { app: value.app, model: String(value.model || ''), effort: String(value.effort || '') };
}
function nativeInteractions(run) {
  return run.tasks.flatMap(task => {
    const attempt = run.attempts.findLast(row => row.taskId === task.id);
    const live = attempt && !attempt.endedAt && fusionLive.get(attempt.bindingId);
    if (!live) return [];
    const requests = live.chat?.questions?.codex ? live.chat.questions.requests || [] : [];
    const questions = live.chat?.questions?.codex ? null : live.chat?.questions;
    const items = (live.chat?.items || []).flatMap(item => {
      const key = item.btnItem || item.i, waiting = live.state?.waiting;
      if (typeof waiting !== 'string' || !waiting.startsWith(key + ':')) return [];
      const labels = waiting.slice(key.length + 1).split('/');
      const buttons = (item.b || []).flatMap((label, n) => labels.includes(label) ? [{ label, n, actionId: item.actions?.[n] || '' }] : []);
      return buttons.length ? [{ i: item.i, btnItem: key, buttons }] : [];
    });
    if (!requests.length && !questions?.list?.length && !items.length) return [];
    return [{ id: attempt.id, taskId: task.id, workId: task.workId, goal: task.goal, app: attempt.app,
      attemptId: attempt.id, bindingId: attempt.bindingId, native: attempt.native, items, requests, questions }];
  });
}
function taskSummaries(run, taskId) {
  const assignments = new Map(run.assignments.map(row => [row.taskId, row]));
  const attempts = new Map(run.attempts.filter(row => row.taskId).map(row => [row.taskId, row]));
  const works = new Map(run.works.map(row => [row.id, row]));
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
function taskBoard(run, tasks) {
  return { tasks, nativeInteractions: nativeInteractions(run),
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
function controllerView(run, tasks) {
  const { app, model, effort, bindingId, windowId, preparing, error, projectTrust } = run.main;
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
  const tasksById = new Map(tasks.map(task => [task.id, task])), worksById = new Map(run.works.map(work => [work.id, work]));
  const attemptsById = new Map(run.attempts.map(attempt => [attempt.id, attempt]));
  const executing = run.attempts.filter(row => !row.endedAt && (row.status === 'queued' || NATIVE_UNSETTLED.includes(row.status)));
  const unknown = executing.find(row => row.status === 'unknown');
  const pending = tasks.length ? fusionPendingReviews(run).filter(row => !['stopped', 'cancelled'].includes(tasksById.get(row.taskId)?.status)) : [];
  const failure = pending.find(row => row.outcome === 'failed');
  const currentAttempt = unknown || executing.findLast(row => row.kind === 'main') || executing.at(-1)
    || attemptsById.get((failure || pending[0])?.attemptId);
  const currentTask = tasks.find(row => row.needsUser) || tasksById.get(currentAttempt?.taskId);
  const currentWork = worksById.get(currentAttempt?.workExecutions?.at(-1)?.workId || currentAttempt?.workId);
  const currentInput = currentAttempt?.kind === 'main' ? run.events.findLast(event => event.type === 'user_input'
    && (currentAttempt.native?.turnId && event.data.native?.turnId === currentAttempt.native.turnId || currentAttempt.eventIds?.includes(event.id))) : null;
  const current = currentTask ? { text: currentTask.goal,
    status: currentAttempt?.taskId === currentTask.id ? currentAttempt.status : currentTask.status, needsUser: currentTask.needsUser }
    : currentAttempt ? { text: currentWork?.title || currentInput?.data.text?.slice(0, 200) || run.title,
      status: currentAttempt.status, needsUser: false } : null;
  const state = attention.length || run.status === 'awaiting_user' ? 'wait'
    : ['blocked', 'stopped'].includes(run.status) ? 'err' : ['recovering', 'stopping'].includes(run.status) ? 'run'
      : unknown ? 'err' : executing.length || preparing ? 'run' : failure ? 'err'
        : run.works.length && run.works.every(row => row.status === 'completed') ? 'done' : pending.length ? 'run' : 'idle';
  const settled = !run.main.preparing && !['running', 'recovering', 'stopping', 'awaiting_user'].includes(run.status)
    && !run.attempts.some(row => row.status === 'queued' || NATIVE_UNSETTLED.includes(row.status));
  const resultKey = settled && ['done', 'err'].includes(state) ? crypto.createHash('sha256').update(JSON.stringify([
    state, run.status, run.blockedReason, run.attempts.map(row => [row.id, row.status, row.endedAt]),
    run.works.map(work => [work.id, work.status, work.deliveries.map(row => [row.mainAttemptId, row.nativeTurnId, row.endedAt])]),
  ])).digest('hex') : '';
  return { ...fusionSummary(run), main: { app, model, effort, bindingId, windowId, preparing, error, projectTrust },
    internalInputs: run.attempts.filter(row => row.kind === 'main' && row.origin === 'events' && row.native?.messageId)
      .map(row => ({ threadId: row.native.threadId, messageId: row.native.messageId })),
    overview: { state, resultKey, counts, apps: [...new Set([app, ...tasks.map(row => row.app)].filter(Boolean))], attention,
      current } };
}
export function fusionControllerView(run) { return controllerView(run, taskSummaries(run)); }
export function fusionRunView(run, view) {
  const tasks = taskSummaries(run, view.kind === 'task' ? view.taskId : undefined);
  const base = { ...controllerView(run, tasks), revision: run.revision };
  if (view.kind === 'config') return { ...base, budget: run.budget,
    capabilities: [...new Set(run.capabilities.map(row => row.app))].map(app => {
      const row = run.capabilities.find(row => row.app === app);
      return { app, models: row.models };
    }) };
  if (view.kind === 'input') return { ...base, questions: run.questions.filter(row => row.id === view.questionId) };
  if (view.kind === 'tasks') return { ...base, ...taskBoard(run, tasks) };
  const task = run.tasks.find(row => row.id === view.taskId);
  if (view.kind === 'inputs') return { inputs: task.inputs,
    assignments: run.assignments.filter(row => row.taskId === task.id).map(({ id, input, created }) => ({ id, input, created })) };
  if (view.kind === 'reviews') return { reviews: task.reviews };
  if (view.kind === 'attempt') {
    const { prompt, beforeIds, ...attempt } = run.attempts.find(row => row.id === view.attemptId);
    return { ...attempt, cost: run.assignments.find(row => row.id === attempt.assignmentId)?.cost,
      events: run.events.filter(row => row.data?.attemptId === attempt.id) };
  }
  if (view.kind === 'delivery') return run.works.find(row => row.id === view.workId).deliveries[view.index];
  if (view.kind !== 'task') throw new Error('未知 Fusion 视图');
  const agent = run.agents.find(row => row.id === task.workerId);
  const attempts = run.attempts.filter(row => row.taskId === task.id), latest = attempts.at(-1);
  const bindingId = latest?.bindingId || agent?.bindingId;
  return { ...base, board: taskBoard(run, tasks), tasks: [tasks.find(row => row.id === task.id)],
    agents: agent ? [{ id: agent.id, bindingId: agent.bindingId }] : [],
    bindings: run.bindings.filter(row => row.id === bindingId),
    attempts: attempts.map(attempt => ({ id: attempt.id, taskId: attempt.taskId, bindingId: attempt.bindingId,
      app: attempt.app, model: attempt.model, effort: attempt.effort, status: attempt.status })) };

}
function fusionView(message, kind = 'config') {
  return { kind: message.view || kind, subscriptionId: message.subscriptionId || message.requestId,
    taskId: message.taskId, workId: message.workId, questionId: message.questionId,
    attemptId: message.attemptId, index: message.index };
}
function emitFusionView(session, run, message, type = 'fusionState') {
  const view = fusionView(message);
  session.emit({ t: type, computer: run.computer, runId: run.id, requestId: message.requestId,
    view, run: fusionRunView(run, view), ...(run.main.projectTrust ? { projectTrust: run.main.projectTrust } : {}) });
}
async function prepare(session, run, message, project = false) {
  if (run.main.preparing) throw new Error('主 Agent 正在准备，请等待当前操作结果');
  const runner = fusionRunner(run);
  run.main.preparing = true; publishFusion(run);
  try {
    if (project || !run.main.windowId) {
      const result = await runner.agent.prepareProject(run, message);
      if (result.trust || result.declined) {
        run.main.projectTrust = result.trust || null;
        run.main.error = result.declined ? '项目保持限制模式，尚未启用主 Agent' : '';
        return;
      }
    }
    delete run.main.projectTrust;
    const snapshot = await runner.agent.capabilities(run, run.main.app);
    run.capabilities.unshift(snapshot);
    run.main.error = '';
  } catch (error) { run.main.error = error.message; }
  finally {
    run.main.preparing = false; publishFusion(run);
    emitFusionView(session, run, message);
  }
}
subscribeFusion(run => {
  for (const viewer of fusionViewers) {
    viewer.emit({ t: 'fusionUpdate', computer: run.computer, run: fusionControllerView(run) });
    if (run.removedAt) {
      if (viewer.fusionDetail?.runId === run.id) viewer.fusionDetail = null;
      if (viewer.fusionRun?.id === run.id) viewer.fusionRun = null;
      continue;
    }
    if (viewer.fusionDetail?.runId === run.id) {
      const view = viewer.fusionDetail.view;
      viewer.emit({ t: 'fusionState', computer: run.computer, runId: run.id, view, run: fusionRunView(run, view) });
    }
  }
});
export async function manageFusionWorkbench(body) {
  const run = requestedRun({}, { computer: body.computer, runId: body.threadId });
  if (body.action === 'rename') {
    const title = String(body.name || '').trim().slice(0, 80);
    if (!title) throw new Error('工作台名称不能为空');
    const renamed = await fusionRunner(run).agent.renameMain(run, title);
    run.title = renamed.title; publishFusion(run);
  } else if (body.action === 'favorite') {
    run.favorite = body.favorite === true; publishFusion(run);
  } else if (body.action === 'stop') await fusionRunner(run).stop();
  else if (body.action === 'remove') await fusionRunner(run).remove();
  else throw new Error('不支持的工作台操作');
  return { ok: true, run: fusionControllerView(run) };
}
export const FUSION_OWNER = {
  async fusionWorkspace(message = {}) {
    this.fusionDetail = null;
    const projects = [...new Map(workspaces().map(workspace => {
      const project = fusionProject(workspace.root, workspace.host || '');
      return project && [project.id, project];
    }).filter(Boolean)).values()];
    this.emit({ t: 'fusionWorkspace', computer: computerId(), requestId: message.requestId,
      current: fusionRuns[this.deviceId]?.current || '',
      runs: allFusionRuns().map(fusionControllerView).sort((a, b) => b.updated - a.updated),
      projects, apps: await new FusionAgent().softwareCapabilities(),
      ...(message.path !== undefined ? { browse: projectList(message.path) } : {}) });
  },
  fusionCreate(message, emit = true) {
    if (message.computer !== computerId()) throw new Error('新建主工作台前必须明确执行电脑');
    if (!message.requestId) throw new Error('新建主工作台缺少请求身份');
    const previous = fusionRuns[this.deviceId]?.runs.find(run => run.createRequestId === message.requestId);
    if (previous) return previous;
    const tier = message.tier || 'balanced';
    if (!FUSION_TIERS[tier]) throw new Error('请选择省钱、均衡或性能档位');
    const run = newFusionRun(this.deviceId, projectOf(message.project), mainOf(message.main), tier);
    run.createRequestId = message.requestId;
    const saved = savedFusion(this.deviceId); saved.runs.push(run); saved.current = run.id;
    publishFusion(run);
    if (emit) emitFusionView(this, run, message, 'fusionCreated');
    return run;
  },
  async fusionProject(message) {
    if (message.computer !== computerId()) throw new Error('打开主项目之前必须明确执行电脑');
    let run;
    if (message.runId) {
      run = requestedRun(this, message);
      if (run.main.bindingId) throw new Error('主会话保留实际项目；其他项目可在主对话建立工作项');
    } else {
      const previous = fusionRuns[this.deviceId]?.runs.find(value => value.createRequestId === message.requestId);
      if (previous) return emitFusionView(this, previous, message, 'fusionCreated');
      const root = message.action === 'newProject' ? createProjectFolder(message.parent, String(message.name || '').trim()) : message.path;
      run = this.fusionCreate({ ...message, project: { root, host: '' } }, false);
      emitFusionView(this, run, message, 'fusionCreated');
    }
    await prepare(this, run, message, true);
  },
  fusionRead(message) {
    const run = requestedRun(this, message);
    const view = fusionView(message);
    if (view.kind === 'close') {
      if (this.fusionDetail?.view.subscriptionId === message.subscriptionId) this.fusionDetail = null;
      this.emit({ t: 'fusionState', computer: run.computer, runId: run.id, requestId: message.requestId, view });
      return;
    }
    if (['config', 'tasks', 'task', 'input'].includes(view.kind)) this.fusionDetail = { runId: run.id, view };
    emitFusionView(this, run, message);
  },
  async fusionConfigure(message) {
    const run = requestedRun(this, message), runner = fusionRunner(run);
    const previous = JSON.stringify({ tier: run.tier, budget: run.budget });
    if (message.main) {
      const main = mainOf(message.main);
      validateExecution(run, main);
      if (run.main.bindingId && main.app !== run.main.app) throw new Error('更换主软件请新建工作台，已有主会话保留');
      if (run.main.bindingId && (main.model !== run.main.model || main.effort !== run.main.effort))
        throw new Error('已启用主 Agent 的模型与强度请使用普通原生模型菜单修改');
      if (main.app !== run.main.app) {
        runner.agent.releaseMainProject(run); run.main.windowId = ''; run.main.error = ''; run.main.projectTrust = null;
      }
      Object.assign(run.main, main);
    }
    if (message.tier) {
      if (!FUSION_TIERS[message.tier]) throw new Error('未知成本档位');
      run.tier = message.tier;
    }
    if (message.budget !== undefined) {
      if (message.budget !== null && (!(message.budget.limit > 0) || !message.budget.unit)) throw new Error('显式预算需要正数限额和原生单位');
      run.budget = message.budget;
    }
    publishFusion(run);
    if (message.enable) {
      if (!run.main.model) throw new Error('请先选择主模型与思考强度');
      await runner.agent.prepareMain(run);
      const renamed = await runner.agent.renameMain(run, run.title);
      run.title = renamed.title; publishFusion(run);
      await runner.start();
    } else if (run.main.bindingId && previous !== JSON.stringify({ tier: run.tier, budget: run.budget })) {
      fusionEvent(run, 'configuration', { tier: run.tier, budget: run.budget });
      publishFusion(run); runner.wake();
    }
    emitFusionView(this, run, message);
  },
  fusionPrepare(message) {
    const run = requestedRun(this, message);
    if (message.main) {
      if (run.main.bindingId) throw new Error('已有主会话保留，请使用普通原生模型菜单');
      const main = mainOf(message.main);
      if (main.app !== run.main.app) {
        fusionRunner(run).agent.releaseMainProject(run);
        Object.assign(run.main, main, { windowId: '', error: '', projectTrust: null });
      }
    }
    return prepare(this, run, message);
  },
  fusionConfirm(message) {
    const run = requestedRun(this, message);
    fusionRunner(run).confirm(String(message.planId || ''), message.decision, message.text || '');
    this.emit({ t: 'fusionInputDone', computer: computerId(), requestId: message.requestId });
  },
  fusionInput(message) {
    if (!message.requestId) throw new Error('补充内容缺少请求身份');
    fusionRunner(requestedRun(this, message)).input(message);
    this.emit({ t: 'fusionInputDone', computer: computerId(), requestId: message.requestId });
  },
  fusionStop(message = {}) { return fusionRunner(requestedRun(this, message)).stop(message); },
  fusionResume(message) { return fusionRunner(requestedRun(this, message)).resume(); },
  async fusionNative(message) {
    const run = requestedRun(this, message);
    await fusionRunner(run).agent.nativeAction(run, message.attemptId, message.action);
  },
  async fusionContent(message) {
    const run = requestedRun(this, message);
    const result = await fusionRunner(run).agent.readBinding(run, message.bindingId, message.history, message.before);
    this.emit({ t: 'fusionContent', computer: run.computer, runId: run.id, requestId: message.requestId, ...result });
  },
  fusionEmit() {
    if (this.app !== 'fusion') return;
    const run = this.fusionRun;
    this.emit({ t: 'chat', sel: this.selectionKey(), chat: { items: [], earlier: false, global: [], queued: [], questions: null,
      busy: false, changed: 0, readonly: true, title: 'Fusion', thread: run?.id || '', model: '', fusionRun: run ? fusionControllerView(run) : null } });
  },
  fusionUsage() { if (this.fusionRun) this.emit({ t: 'fusionUpdate', computer: this.fusionRun.computer, run: fusionControllerView(this.fusionRun) }); },
};
