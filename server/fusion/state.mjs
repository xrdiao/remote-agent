import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { workspaces } from '../../lib/files.mjs';
import { readState, saveState, computerId, forgetSelection } from '../../lib/auth.mjs';
import { normPath, pathKey, findBin, localFilePath } from '../../lib/platform.mjs';
import { fusionStore } from './store.mjs';

export const fusionRuns = fusionStore.data.owners;
export const conversationProjects = readState().conversationProjects || {};
export const fusionWorkers = new Map();
export const fusionViewers = new Set();
export const fusionLive = new Map();
export const FUSION_ACTIVE = ['running', 'waiting', 'recovering', 'stopping'];
export const NATIVE_UNSETTLED = ['preparing', 'submitting', 'running', 'unknown', 'stopping'];
const subscribers = new Set();

export function saveFusionRuns() { fusionStore.write(); }

export function initializeFusionState() {
  const state = readState();
  const legacy = state.fusionRuns;
  if (!legacy && state.fusionHistory === undefined) return;
  const unsettled = Object.values(legacy || {}).flatMap(owner => owner.runs || [])
    .flatMap(run => run.attempts || []).filter(attempt => NATIVE_UNSETTLED.includes(attempt.status));
  if (unsettled.length) throw new Error(`旧 Fusion 仍有 ${unsettled.length} 个原生执行待核对，切换前不能清理或重发`);
  const directory = fileURLToPath(new URL('../../_shots/fusion-superagent-cutover/', import.meta.url));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, `legacy-${Date.now()}.json`), JSON.stringify({ fusionRuns: legacy, fusionHistory: state.fusionHistory }), { mode: 0o600 });
  saveState({ fusionRuns: undefined, fusionHistory: undefined });
  for (const [deviceId, saved] of Object.entries(state.entrySelections?.[computerId()] || {}))
    if (saved.last?.app === 'fusion' || saved.apps?.fusion) forgetSelection(deviceId, 'fusion');
}

export function savedFusion(deviceId) { return fusionRuns[deviceId] ||= { current: '', runs: [] }; }
export function findFusionRun(id) {
  const controller = allFusionRuns().find(row => row.id === id);
  if (!controller) throw new Error('没有这个 Fusion 工作台，请重新选择');
  return controller;
}
export function newFusionRun(deviceId, project, main, tier = 'balanced') {
  const now = Date.now();
  return { id: crypto.randomUUID(), computer: computerId(), deviceId, created: now, updated: now, revision: 0,
    title: 'Fusion 主工作台', favorite: false, removedAt: 0, project, main: { ...main, bindingId: '' }, tier, budget: null,
    status: 'ready', blockedReason: '', stopRequested: false, works: [], tasks: [], agents: [], assignments: [],
    attempts: [], bindings: [], events: [], commands: [], effects: [], questions: [], capabilities: [],
    observedMainMessages: [], observedMainTurns: [] };
}
export function publishFusion(controller, persist = true) {
  controller.updated = Date.now();
  controller.revision++;
  if (persist) saveFusionRuns();
  for (const changed of subscribers) changed(controller);
}
export function rememberFusionMainWindow(controller, selection, roots) {
  const binding = controller.bindings.find(row => row.id === controller.main.bindingId);
  if (!binding || binding.app !== selection.app || binding.threadId !== selection.threadId
      || !roots.some(root => fusionProject(root.root, root.host || '')?.id === binding.project.id)) return;
  if (binding.windowId === selection.windowId && controller.main.windowId === selection.windowId) return;
  binding.windowId = controller.main.windowId = selection.windowId;
  publishFusion(controller);
}
export function commitFusion(controller, edit) {
  const next = structuredClone(controller);
  const result = edit(next);
  next.updated = Date.now(); next.revision++;
  fusionStore.replace(controller, next);
  for (const changed of subscribers) changed(controller);
  return result;
}
export function subscribeFusion(changed) { subscribers.add(changed); return () => subscribers.delete(changed); }
export function fusionEvent(controller, type, data, id = crypto.randomUUID()) {
  const existing = controller.events.find(event => event.id === id);
  if (existing) return existing;
  const event = { id, type, data, at: Date.now(), deliveredTo: '' };
  controller.events.push(event);
  return event;
}
export function fusionEffect(controller, kind, data, id = crypto.randomUUID()) {
  const existing = controller.effects.find(effect => effect.id === id);
  if (existing) return existing;
  const effect = { id, kind, data, status: 'pending', created: Date.now() };
  controller.effects.push(effect);
  return effect;
}
export function newFusionAttempt(controller, task, assignment, kind = 'task') {
  const attempt = { id: crypto.randomUUID(), taskId: task?.id || '', workId: task?.workId || '', assignmentId: assignment?.id || '',
    kind, app: assignment?.app || controller.main.app, model: assignment?.model || controller.main.model,
    effort: assignment?.effort ?? controller.main.effort, created: Date.now(), status: 'queued', submission: 'not_submitted', bindingId: '',
    native: null, acceptedAt: null, endedAt: null, result: null, usage: null, baseline: null, changes: null };
  if (kind === 'main') attempt.workExecutions = [];
  controller.attempts.push(attempt);
  if (task) { task.attemptIds.push(attempt.id); task.status = 'queued'; }
  return attempt;
}
export function fusionReviewBatch(attempt, attemptIds) {
  const batch = attempt.reviewBatch ||= { attemptIds: [], delivered: [] };
  for (const id of attemptIds) if (!batch.attemptIds.includes(id)) batch.attemptIds.push(id);
  return batch;
}
export function recordFusionReceipt(controller, native, value) {
  const binding = controller.bindings.find(row => row.id === controller.main.bindingId && row.threadId === native.threadId);
  if (!binding) return;
  const now = Date.now();
  if (value.agents?.length) {
    binding.workerReads ||= [];
    for (const row of value.agents) {
      const receipt = { id: row.id, label: row.label, app: row.app, projectId: row.project?.id,
        fingerprint: crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex'),
        threadId: native.threadId, turnId: native.turnId, requestId: native.requestId, at: now };
      const index = binding.workerReads.findIndex(read => read.id === row.id);
      if (index < 0) binding.workerReads.push(receipt); else binding.workerReads[index] = receipt;
    }
  }
  const main = controller.attempts.find(row => row.kind === 'main' && row.native?.threadId === native.threadId && row.native.turnId === native.turnId);
  const ids = value.pendingReviews?.items.map(row => row.attemptId) || [];
  if (main && ids.length) {
    const batch = fusionReviewBatch(main, ids);
    for (const attemptId of ids) if (!batch.delivered.some(row => row.attemptId === attemptId))
      batch.delivered.push({ attemptId, requestId: native.requestId, at: now });
  }
}
export function fusionReviewKey(controller, items) {
  return crypto.createHash('sha256').update(JSON.stringify([items.map(row => [row.attemptId, row.waitingFor]),
    controller.events.findLast(row => row.type === 'user_input')?.id])).digest('hex');
}
export function fusionAttemptWorkIds(controller, attempt) {
  if (attempt.kind !== 'main') return attempt.workId ? [attempt.workId] : [];
  return [...new Set([attempt.workId, ...(attempt.workExecutions || []).map(row => row.workId),
    ...controller.commands.filter(row => row.native.turnId === attempt.native?.turnId)
      .map(row => row.result.workId || controller.tasks.find(task => task.id === row.result.taskId)?.workId),
    ...controller.events.filter(row => attempt.eventIds?.includes(row.id)).map(row => row.data.workId),
  ].filter(Boolean))];
}
export function fusionSummary(controller) {
  return { id: controller.id, computer: controller.computer, title: controller.title, favorite: controller.favorite === true,
    removedAt: controller.removedAt || 0, status: controller.status,
    ...(controller.removal ? { removal: controller.removal } : {}),
    project: controller.project, main: controller.main, tier: controller.tier, updated: controller.updated,
    blockedReason: controller.blockedReason,
    works: { done: controller.works.filter(work => work.status === 'completed').length, total: controller.works.length },
    tasks: { done: controller.tasks.filter(task => task.status === 'accepted').length,
      total: controller.tasks.length, running: controller.tasks.filter(task => task.status === 'running').length } };
}
export function allFusionRuns() { return Object.values(fusionRuns).flatMap(owner => owner.runs).filter(run => !run.removedAt); }
export function fusionBindingInUse(app, thread) {
  return allFusionRuns().some(controller => controller.bindings.some(binding => binding.role !== 'main' && binding.app === app && binding.threadId === thread
    && controller.attempts.some(attempt => attempt.bindingId === binding.id && NATIVE_UNSETTLED.includes(attempt.status))));
}
export function fusionWindowInUse(window) {
  const target = String(window.id).replace(/^(cursor|devin|codex):/, '');
  return allFusionRuns().some(controller => [...controller.agents, controller.main].some(owner => owner.creations?.some(creation =>
    ['creating', 'unknown'].includes(creation.status) && creation.app === window.app && creation.windowId === target))
    || controller.attempts.some(attempt => NATIVE_UNSETTLED.includes(attempt.status)
    && controller.bindings.some(binding => binding.id === attempt.bindingId && binding.app === window.app
      && binding.windowId.replace(/^(cursor|devin|codex):/, '') === target)));
}

// Shared native project identity, also used by ordinary sessions.
export function fusionProject(root, host = '') {
  root = host ? root : localFilePath(root);
  if (!root || !(host ? path.posix : path).isAbsolute(root)) return null;
  root = host ? path.posix.normalize(root) : fs.existsSync(root) ? fs.realpathSync(root) : path.normalize(root);
  root = host ? normPath(root) : localFilePath(root);
  return { id: JSON.stringify([host, pathKey(root, !host)]), root, host, name: path.posix.basename(root) || root };
}
export function fusionCursorProjects() {
  const projects = new Map();
  for (const workspace of workspaces().filter(value => !value.host && (value.sources || [value.source]).includes('cursor'))) {
    try {
      const remote = execFileSync(findBin('git'), ['-C', workspace.root, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', timeout: 1000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const repository = remote.replace(/^\w+:\/\//, '').replace(/^.*@/, '').replace(':', '/').replace(/\.git$/, '').replace(/\/$/, '');
      const project = fusionProject(workspace.root);
      if (!projects.has(repository)) projects.set(repository, project);
      else if (projects.get(repository)?.id !== project.id) projects.set(repository, null);
    } catch { continue; }
  }
  return projects;
}
