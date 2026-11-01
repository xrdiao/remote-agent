import fs from 'node:fs';
import crypto from 'node:crypto';
import { computerId } from '../../lib/auth.mjs';
import { workspaces } from '../../lib/files.mjs';
import { EDITORS } from '../config.mjs';
import { safeHomePath, projectList } from '../agent/projects.mjs';
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
  return { ...run, attempts: run.attempts.map(({ prompt, beforeIds, baseline, changes, ...attempt }) => ({ ...attempt,
    baseline: baseline && { available: baseline.available, at: baseline.at, status: baseline.status, reason: baseline.reason, untracked: baseline.untracked, files: baseline.files },
    changes: changes && { available: changes.available, at: changes.at, status: changes.status, diff: changes.diff, reason: changes.reason, untracked: changes.untracked },
  })) };
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
  fusionCreate(message) {
    if (message.computer !== computerId()) throw new Error('新建 Fusion 前必须明确执行电脑');
    const previous = fusionRuns[this.deviceId]?.runs.find(run => run.createRequestId === message.requestId);
    if (previous) return this.emit({ t: 'fusionCreated', computer: previous.computer, run: runView(previous), requestId: message.requestId });
    const tier = message.tier || 'balanced';
    if (!FUSION_TIERS[tier]) throw new Error('请选择省钱、均衡或性能档位');
    const run = newFusionRun(this.deviceId, projectOf(message.project), mainOf(message.main), tier);
    run.createRequestId = message.requestId;
    const saved = savedFusion(this.deviceId);
    saved.runs.push(run); saved.current = run.id;
    publishFusion(run);
    this.emit({ t: 'fusionCreated', computer: run.computer, run: runView(run), requestId: message.requestId });
    this.fusionWorkspace();
  },
  fusionRead(message) {
    const run = requestedRun(this, message);
    this.emit({ t: 'fusionState', computer: run.computer, requestId: message.requestId, run: runView(run) });
  },
  fusionConfigure(message) {
    const run = requestedRun(this, message);
    const previous = { main: { ...run.main }, tier: run.tier, budget: run.budget };
    if (message.project) {
      if (run.messages.length || run.bindings.length) throw new Error('已有执行事实的 run 保留原项目，请为其他项目新建 run');
      run.project = projectOf(message.project);
      run.capabilities = [];
    }
    if (message.main) {
      const main = mainOf(message.main);
      if (main.app === run.main.app) main.bindingId = run.main.bindingId;
      if (main.model) validateExecution(run, main);
      run.main = main;
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
    const run = requestedRun(this, message), runner = fusionRunner(run);
    const snapshot = await runner.scheduler.submit({ runId: run.id, app: run.main.app, projectKey: run.project.id, access: 'read',
      ready: () => !run.stopRequested, execute: () => runner.agent.capabilities(run, run.main.app) });
    run.capabilities = [...run.capabilities.filter(value => value.app !== snapshot.app), snapshot];
    publishFusion(run);
    this.fusionRead({ runId: run.id, requestId: message.requestId });
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
