import fs from 'node:fs';
import { computerId } from '../../lib/auth.mjs';
import { workspaces } from '../../lib/files.mjs';
import { safeHomePath, projectList, createProjectFolder } from '../agent/projects.mjs';
import { fusionState, savedFusion, findFusionRun, allFusionRuns, newFusionRun, fusionProject,
  commitFusion, fusionEvent, assertFusionReady } from './state.mjs';
import { fusionBindingView, fusionControllerView, fusionRunView, safeFusionControllerView } from './presenter.mjs';
import { fusionRunner, fusionRuntime } from './runner.mjs';
import { FUSION_TIERS, validateExecution } from './cost.mjs';
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
  const runner = fusionRunner(run);
  await runner.setup(async () => {
    try {
      if (project || !run.main.windowId) {
        const result = await runner.agent.prepareProject(run, message);
        if (result.trust || result.declined) {
          runner.commit(next => {
            next.main.projectTrust = result.trust || null;
            next.main.error = result.declined ? '项目保持限制模式，尚未启用主 Agent' : '';
          });
          return;
        }
      }
      const snapshot = await runner.agent.capabilities(run, run.main.app);
      runner.commit(next => {
        delete next.main.projectTrust;
        next.capabilities.unshift(snapshot);
        next.main.error = '';
      });
    } catch (error) {
      if (error.fusionStoreError) throw error;
      runner.commit(next => { next.main.error = error.message; });
    }
  });
  emitFusionView(session, run, message);
}
export async function manageFusionWorkbench(body) {
  const run = requestedRun({}, { computer: body.computer, runId: body.threadId });
  if (body.action === 'rename') {
    const title = String(body.name || '').trim().slice(0, 80);
    if (!title) throw new Error('工作台名称不能为空');
    const runner = fusionRunner(run);
    await runner.setup(async () => {
      const renamed = await runner.agent.renameMain(run, title);
      runner.commit(next => { next.title = renamed.title; });
    });
  } else if (body.action === 'favorite') {
    commitFusion(run, next => { next.favorite = body.favorite === true; });
  } else if (body.action === 'stop') await fusionRunner(run).stop();
  else if (body.action === 'remove') await fusionRunner(run).remove();
  else throw new Error('不支持的工作台操作');
  return { ok: true, run: fusionControllerView(run) };
}
export const FUSION_OWNER = {
  async fusionWorkspace(message = {}) {
    assertFusionReady();
    this.fusionDetail = null;
    const projects = [...new Map(workspaces().map(workspace => {
      const project = fusionProject(workspace.root, workspace.host || '');
      return project && [project.id, project];
    }).filter(Boolean)).values()];
    this.emit({ t: 'fusionWorkspace', computer: computerId(), requestId: message.requestId,
      current: savedFusion(this.deviceId).current || '',
      runs: allFusionRuns().map(run => safeFusionControllerView(run)).filter(Boolean).sort((a, b) => b.updated - a.updated),
      projects, apps: await new FusionAgent({ adapterRegistry: fusionRuntime.adapterRegistry }).softwareCapabilities(),
      ...(message.path !== undefined ? { browse: projectList(message.path) } : {}) });
  },
  fusionCreate(message, emit = true) {
    assertFusionReady();
    if (message.computer !== computerId()) throw new Error('新建主工作台前必须明确执行电脑');
    if (!message.requestId) throw new Error('新建主工作台缺少请求身份');
    const previous = savedFusion(this.deviceId).runs.find(run => run.createRequestId === message.requestId);
    if (previous) return previous;
    const tier = message.tier || 'balanced';
    if (!FUSION_TIERS[tier]) throw new Error('请选择省钱、均衡或性能档位');
    const run = fusionState.create({ ...newFusionRun(this.deviceId, projectOf(message.project), mainOf(message.main), tier),
      createRequestId: message.requestId });
    if (emit) emitFusionView(this, run, message, 'fusionCreated');
    return run;
  },
  async fusionProject(message) {
    assertFusionReady();
    if (message.computer !== computerId()) throw new Error('打开主项目之前必须明确执行电脑');
    let run;
    if (message.runId) {
      run = requestedRun(this, message);
      if (run.main.bindingId) throw new Error('主会话保留实际项目；其他项目可在主对话建立工作项');
    } else {
      const previous = savedFusion(this.deviceId).runs.find(value => value.createRequestId === message.requestId);
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
    await runner.setup(async () => {
      const previous = JSON.stringify({ tier: run.tier, budget: run.budget });
      const main = message.main && mainOf(message.main);
      if (main) {
        validateExecution(run, main);
        if (run.main.bindingId && main.app !== run.main.app) throw new Error('更换主软件请新建工作台，已有主会话保留');
        if (run.main.bindingId && (main.model !== run.main.model || main.effort !== run.main.effort))
          throw new Error('已启用主 Agent 的模型与强度请使用普通原生模型菜单修改');
      }
      const switching = main && main.app !== run.main.app;
      if (switching && run.main.creations?.some(row => ['creating', 'unknown'].includes(row.status)))
        throw new Error('原生创建结果待核对，暂时无法更换主软件');
      runner.commit(next => {
        if (switching) Object.assign(next.main, { windowId: '', error: '', projectTrust: null });
        if (main) Object.assign(next.main, main);
        if (message.tier) {
          if (!FUSION_TIERS[message.tier]) throw new Error('未知成本档位');
          next.tier = message.tier;
        }
        if (message.budget !== undefined) {
          if (message.budget !== null && (!(message.budget.limit > 0) || !message.budget.unit)) throw new Error('显式预算需要正数限额和原生单位');
          next.budget = message.budget;
        }
        if (!message.enable && next.main.bindingId && previous !== JSON.stringify({ tier: next.tier, budget: next.budget }))
          fusionEvent(next, 'configuration', { tier: next.tier, budget: next.budget });
      });
      if (switching) runner.agent.releaseMainProject(run);
      if (message.enable) {
        if (!run.main.model) throw new Error('请先选择主模型与思考强度');
        await runner.agent.prepareMain(run);
        const renamed = await runner.agent.renameMain(run, run.title);
        if (renamed.title !== run.title) runner.commit(next => { next.title = renamed.title; });
        await runner.start();
      } else runner.wake();
    });
    emitFusionView(this, run, message);
  },
  fusionPrepare(message) {
    const run = requestedRun(this, message), runner = fusionRunner(run);
    if (runner.settingUp) throw new Error('主 Agent 正在准备，请等待当前操作结果');
    if (message.main) {
      if (run.main.bindingId) throw new Error('已有主会话保留，请使用普通原生模型菜单');
      const main = mainOf(message.main);
      if (main.app !== run.main.app) {
        if (run.main.creations?.some(row => ['creating', 'unknown'].includes(row.status)))
          throw new Error('原生创建结果待核对，暂时无法更换主软件');
        runner.commit(next => Object.assign(next.main, main, { windowId: '', error: '', projectTrust: null }));
        runner.agent.releaseMainProject(run);
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
    await fusionRunner(run).agent.nativeAction(run, message.attemptId, message.action, message.requestId);
  },
  async fusionContent(message) {
    const run = requestedRun(this, message);
    const { binding, chat } = await fusionRunner(run).agent.readBinding(run, message.bindingId, message.history, message.before);
    this.emit({ t: 'fusionContent', computer: run.computer, runId: run.id, requestId: message.requestId, binding: fusionBindingView(binding), chat });
  },
  fusionEmit() {
    if (this.app !== 'fusion') return;
    const run = this.fusionRun;
    this.emit({ t: 'chat', sel: this.selectionKey(), chat: { items: [], earlier: false, global: [], queued: [], questions: null,
      busy: false, changed: 0, readonly: true, title: 'Fusion', thread: run?.id || '', model: '', fusionRun: run ? fusionControllerView(run) : null } });
  },
  fusionUsage() { if (this.fusionRun) this.emit({ t: 'fusionUpdate', computer: this.fusionRun.computer, run: fusionControllerView(this.fusionRun) }); },
};
