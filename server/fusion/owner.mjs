import fs from 'node:fs';
import crypto from 'node:crypto';
import { computerId } from '../../lib/auth.mjs';
import { workspaces } from '../../lib/files.mjs';
import { EDITORS } from '../config.mjs';
import { safeHomePath, projectList, createProjectFolder } from '../agent/projects.mjs';
import { nativeSessionCatalog } from '../native-windows.mjs';
import { sessionId } from '../../lib/session-library.mjs';
import { fusionTargets } from '../project-windows.mjs';
import { fusionRuns, fusionViewers, savedFusion, findFusionRun, newFusionRun, fusionProject,
  publishFusion, subscribeFusion, fusionSummary, fusionHtml, fusionEvent } from './state.mjs';
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
  if (!EDITORS.some(editor => editor.app === value?.app)) throw new Error('请选择主 Agent 所属软件');
  return { app: value.app, model: String(value.model || ''), effort: String(value.effort || ''), bindingId: '' };
}
function runView(run) {
  const excluded = fusionTargets().sessions;
  const mainSessions = (nativeSessionCatalog(run.main.app)?.rows || []).filter(row => !row.archived && !row.deleted
    && !excluded.has(run.main.app + ':' + sessionId(run.main.app, row.id))
    && fusionProject(row.workspace, row.host || '')?.id === run.project.id)
    .map(row => ({ id: sessionId(run.main.app, row.id), title: row.title }));
  return { ...run, mainSessions, attempts: run.attempts.map(({ prompt, beforeIds, baseline, changes, ...attempt }) => ({ ...attempt,
    baseline: baseline && { available: baseline.available, at: baseline.at, status: baseline.status, reason: baseline.reason, untracked: baseline.untracked, files: baseline.files },
    changes: changes && { available: changes.available, at: changes.at, status: changes.status, diff: changes.diff, reason: changes.reason, untracked: changes.untracked },
  })) };
}
async function prepareMain(session, run, message, select) {
  const runner = fusionRunner(run), main = run.main;
  let project;
  main.preparing = true;
  publishFusion(run);
  try {
    const snapshot = await runner.scheduler.submit({ runId: run.id, app: main.app, projectKey: run.project.id, access: 'read',
      ready: () => true, execute: async () => {
        if (main !== run.main) throw new Error('主 Agent 配置已改变，请重新打开项目');
        if (select || !main.bindingId) {
          project = await runner.agent.prepareMain(run, message, main);
          if (project.trust || project.declined) return null;
        }
        if (main !== run.main) return null;
        return runner.agent.capabilities(run, main.app, 'main');
      } });
    if (snapshot) {
      run.capabilities = [...run.capabilities.filter(value => value.app !== snapshot.app), snapshot];
      main.error = '';
    }
    if (project?.trust) main.projectTrust = project.trust;
    else delete main.projectTrust;
    if (project?.declined) main.error = '项目保持限制模式，尚未选择主 Agent 会话';
  } catch (error) {
    main.error = error.message;
    run.capabilities = [...run.capabilities.filter(value => value.app !== main.app), { app: main.app, available: false,
      at: Date.now(), source: '主 Agent 原生能力读取', error: error.message, models: [] }];
  }
  main.preparing = false;
  publishFusion(run);
  session.emit({ t: 'fusionState', computer: run.computer, requestId: message.requestId, run: runView(run),
    ...(project?.trust && main === run.main ? { projectTrust: project.trust } : {}) });
}

subscribeFusion(run => {
  for (const viewer of fusionViewers) if (viewer.deviceId === run.deviceId) {
    viewer.emit({ t: 'fusionUpdate', computer: run.computer, run: fusionSummary(run) });
    if (viewer.app === 'fusion' && viewer.fusionRun?.id === run.id) viewer.fusionEmit();
  }
});

export const FUSION_OWNER = {
  fusionWorkspace(message = {}) {
    const projects = [...new Map(workspaces().map(workspace => {
      const project = fusionProject(workspace.root, workspace.host || '');
      return project && [project.id, project];
    }).filter(Boolean)).values()];
    this.emit({ t: 'fusionWorkspace', computer: computerId(), requestId: message.requestId,
      current: fusionRuns[this.deviceId]?.current || '',
      runs: (fusionRuns[this.deviceId]?.runs || []).map(fusionSummary).sort((a, b) => b.updated - a.updated),
      projects, apps: EDITORS.map(({ app, name }) => ({ app, name })),
      ...(message.path !== undefined ? { browse: projectList(message.path) } : {}) });
  },
  fusionCreate(message, emit = true) {
    if (message.computer !== computerId()) throw new Error('新建 Fusion 前必须明确执行电脑');
    const previous = fusionRuns[this.deviceId]?.runs.find(run => run.createRequestId === message.requestId);
    if (previous) {
      if (emit) this.emit({ t: 'fusionCreated', computer: previous.computer, run: runView(previous), requestId: message.requestId });
      return previous;
    }
    const tier = message.tier || 'balanced';
    if (!FUSION_TIERS[tier]) throw new Error('请选择省钱、均衡或性能档位');
    const run = newFusionRun(this.deviceId, projectOf(message.project), mainOf(message.main), tier);
    run.createRequestId = message.requestId;
    const saved = savedFusion(this.deviceId);
    saved.runs.push(run); saved.current = run.id;
    publishFusion(run);
    if (emit) {
      this.emit({ t: 'fusionCreated', computer: run.computer, run: runView(run), requestId: message.requestId });
      this.fusionWorkspace();
    }
    return run;
  },
  async fusionProject(message) {
    if (message.computer !== computerId()) throw new Error('打开 Fusion 项目前必须明确执行电脑');
    let run;
    if (message.runId) {
      run = requestedRun(this, message);
      if (message.action !== 'projectTrust' && projectOf({ root: message.path, host: run.project.host })?.id !== run.project.id)
        throw new Error('这个 run 保留原项目，请为其他项目新建 run');
    } else {
      const previous = fusionRuns[this.deviceId]?.runs.find(value => value.createRequestId === message.requestId);
      if (previous) return this.emit({ t: 'fusionCreated', computer: previous.computer, requestId: message.requestId, run: runView(previous) });
      const root = message.action === 'newProject' ? createProjectFolder(message.parent, String(message.name || '').trim()) : message.path;
      run = this.fusionCreate({ ...message, project: { root, host: '' } }, false);
      run.main.preparing = true;
      publishFusion(run);
      this.emit({ t: 'fusionCreated', computer: run.computer, requestId: message.requestId, run: runView(run) });
    }
    return prepareMain(this, run, message, true);
  },
  fusionRead(message) {
    const run = requestedRun(this, message);
    this.emit({ t: 'fusionState', computer: run.computer, requestId: message.requestId, run: runView(run) });
  },
  fusionConfigure(message) {
    const run = requestedRun(this, message);
    const previous = { main: { ...run.main }, tier: run.tier, budget: run.budget };
    if (message.project) {
      if (run.messages.length || run.bindings.length || run.main.preparing) throw new Error('主会话正在打开或已有执行事实，请为其他项目新建 run');
      run.project = projectOf(message.project);
      run.capabilities = [];
    }
    if (message.main) {
      const main = mainOf(message.main);
      if (main.app === run.main.app) main.bindingId = run.main.bindingId;
      if (main.model) validateExecution(run, main);
      if (main.app === run.main.app) Object.assign(run.main, main);
      else run.main = main;
    }
    if (message.tier) {
      if (!FUSION_TIERS[message.tier]) throw new Error('未知成本档位');
      run.tier = message.tier;
    }
    if (message.budget !== undefined) {
      if (message.budget !== null && (!(message.budget.limit > 0) || !message.budget.unit)) throw new Error('显式预算需要正数限额和原生单位');
      run.budget = message.budget;
    }
    const current = { main: { ...run.main }, tier: run.tier, budget: run.budget };
    if (run.messages.length && JSON.stringify(previous) !== JSON.stringify(current)) fusionEvent(run, 'configuration', { previous, current });
    publishFusion(run);
    this.fusionRead({ runId: run.id, requestId: message.requestId });
  },
  async fusionPrepare(message) {
    return prepareMain(this, requestedRun(this, message), message, false);
  },
  fusionUserSend(text, id = crypto.randomUUID(), runId = this.fusionRun?.id) {
    const run = findFusionRun(this.deviceId, runId);
    if (!run.main.model) throw new Error('请先选择主模型和思考强度');
    fusionRunner(run).message(String(text), id);
    return false;
  },
  fusionSend(message) {
    const run = requestedRun(this, message);
    if (!message.requestId) throw new Error('Fusion 消息缺少请求身份');
    this.fusionUserSend(String(message.text || ''), message.requestId, run.id);
    this.emit({ t: 'sent', requestId: message.requestId, draft: message.draft, text: message.text,
      sel: `fusion|fusion|${run.id}`, queued: false, sentAt: Date.now() });
  },
  fusionConfirm(message) { fusionRunner(requestedRun(this, message)).confirm(String(message.planId || '')); },
  fusionStop(message = {}) { return fusionRunner(requestedRun(this, message)).stop(); },
  fusionResume(message) { return fusionRunner(requestedRun(this, message)).resume(); },
  async fusionNative(message) {
    const run = requestedRun(this, message);
    await fusionRunner(run).agent.nativeAction(message.attemptId, message.action);
    fusionEvent(run, 'native_action', { attemptId: message.attemptId, bindingId: message.action.bindingId });
    publishFusion(run);
  },
  fusionEmit() {
    if (this.app !== 'fusion') return;
    const run = this.fusionRun;
    const items = (run?.messages || []).map(message => ({ i: message.id, k: message.role === 'human' ? 'human' : 'assistant',
      t: message.text, ...(message.role !== 'human' ? { bodyFormat: 'markdown' } : {}) }));
    for (const attempt of run?.attempts || []) if (attempt.kind === 'decision' && attempt.live) {
      for (const item of attempt.live.items) items.push({ ...item, i: `${attempt.id}:${item.i}`,
        b: undefined, actions: undefined, btnItem: undefined, agents: undefined });
    }
    this.emit({ t: 'chat', sel: this.selectionKey(), chat: { items, earlier: false, global: [], queued: [], questions: null,
      busy: !!run && ['running', 'recovering', 'stopping'].includes(run.status), changed: 0, readonly: false,
      title: run?.title || 'Fusion', thread: run?.id || '', model: '', fusionRun: run ? runView(run) : null } });
  },
  fusionUsage() {
    if (this.fusionRun) this.fusionRead({ runId: this.fusionRun.id });
  },
};
