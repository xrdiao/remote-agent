import fs from 'node:fs';
import { computerId } from '../../lib/auth.mjs';
import { workspaces } from '../../lib/files.mjs';
import { EDITORS } from '../config.mjs';
import { safeHomePath, projectList, createProjectFolder } from '../agent/projects.mjs';
import { fusionRuns, fusionViewers, fusionLive, savedFusion, findFusionRun, newFusionRun, fusionProject,
  publishFusion, subscribeFusion, fusionSummary, fusionEvent } from './state.mjs';
import { fusionRunner } from './runner.mjs';
import { FUSION_TIERS, validateExecution } from './cost.mjs';

function requestedRun(session, message) {
  if (message.computer && message.computer !== computerId()) throw new Error('Fusion 请求不属于这台电脑');
  return findFusionRun(session.deviceId, message.runId || session.fusionRun?.id || '');
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
  if (value?.app !== 'codex') throw new Error('当前已验证的主控软件为 Codex；Cursor 和 Devin 可作为子 Agent');
  return { app: value.app, model: String(value.model || ''), effort: String(value.effort || '') };
}
export function fusionControllerView(run) {
  const { app, model, effort, bindingId, windowId, preparing, error, projectTrust } = run.main;
  return { ...fusionSummary(run), main: { app, model, effort, bindingId, windowId, preparing, error, projectTrust } };
}
export function fusionRunView(run, view) {
  const base = { ...fusionControllerView(run), revision: run.revision };
  if (view.kind === 'config') return { ...base, budget: run.budget,
    capabilities: [...new Set(run.capabilities.map(row => row.app))].map(app => {
      const row = run.capabilities.find(row => row.app === app);
      return { app, models: row.models };
    }) };
  if (view.kind === 'input') return { ...base, questions: run.questions.filter(row => row.id === view.questionId) };
  if (view.kind === 'tasks') return { ...base,
    agents: run.agents.map(({ id }) => ({ id })),
    assignments: run.tasks.map(task => run.assignments.findLast(row => row.taskId === task.id)).filter(Boolean)
      .map(({ taskId, app }) => ({ taskId, app })),
    tasks: run.tasks.map(({ id, workId, goal, status, executor, dependsOn }) => ({ id, workId, goal, status, executor, dependsOn })),
    questions: run.questions.filter(row => !row.answeredAt),
    works: run.works.map(work => ({ id: work.id, title: work.title, goal: work.goal, status: work.status, project: work.project,
      planId: work.planId, plans: work.plans.filter(row => row.id === work.planId),
      deliveries: work.deliveries.map((row, index) => ({ index, summary: row.summary })) })) };
  const task = run.tasks.find(row => row.id === view.taskId);
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
  return { ...base, tasks: [{ id: task.id, workId: task.workId, goal: task.goal, status: task.status, access: task.access,
    dependsOn: task.dependsOn, workerId: task.workerId, inputs: task.inputs }],
    agents: agent ? [{ id: agent.id, bindingId: agent.bindingId }] : [],
    bindings: run.bindings.filter(row => row.id === bindingId),
    attempts: attempts.map(attempt => {
      const live = attempt === latest && fusionLive.get(attempt.bindingId);
      return { id: attempt.id, taskId: attempt.taskId, bindingId: attempt.bindingId, app: attempt.app, model: attempt.model,
        effort: attempt.effort, status: attempt.status, live: live ? {
          items: (live.chat?.items || []).filter(item => item.b?.length).map(({ i, b, btnItem, actions }) => ({ i, b, btnItem, actions })),
          requests: live.chat?.questions?.codex ? live.chat.questions.requests : [],
          questions: live.chat?.questions?.codex ? null : live.chat?.questions, state: live.state } : null };
    }) };
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
  for (const viewer of fusionViewers) if (viewer.deviceId === run.deviceId) {
    viewer.emit({ t: 'fusionUpdate', computer: run.computer, run: fusionControllerView(run) });
    if (viewer.fusionDetail?.runId === run.id) {
      const view = viewer.fusionDetail.view;
      viewer.emit({ t: 'fusionState', computer: run.computer, runId: run.id, view, run: fusionRunView(run, view) });
    }
  }
});
export const FUSION_OWNER = {
  fusionWorkspace(message = {}) {
    this.fusionDetail = null;
    const projects = [...new Map(workspaces().map(workspace => {
      const project = fusionProject(workspace.root, workspace.host || '');
      return project && [project.id, project];
    }).filter(Boolean)).values()];
    this.emit({ t: 'fusionWorkspace', computer: computerId(), requestId: message.requestId,
      current: fusionRuns[this.deviceId]?.current || '',
      runs: (fusionRuns[this.deviceId]?.runs || []).map(fusionControllerView).sort((a, b) => b.updated - a.updated),
      projects, apps: EDITORS.map(({ app, name }) => ({ app, name, controller: app === 'codex' })),
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
      if (run.main.bindingId && (main.model !== run.main.model || main.effort !== run.main.effort))
        throw new Error('已启用主 Agent 的模型与强度请使用普通原生模型菜单修改');
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
      await runner.start();
    } else if (run.main.bindingId && previous !== JSON.stringify({ tier: run.tier, budget: run.budget })) {
      fusionEvent(run, 'configuration', { tier: run.tier, budget: run.budget });
      publishFusion(run); runner.wake();
    }
    emitFusionView(this, run, message);
  },
  fusionPrepare(message) { return prepare(this, requestedRun(this, message), message); },
  fusionConfirm(message) { fusionRunner(requestedRun(this, message)).confirm(String(message.planId || '')); },
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
