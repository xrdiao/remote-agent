import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { workspaces } from '../../lib/files.mjs';
import { computerId } from '../../lib/auth.mjs';
import { normPath, pathKey, findBin, localFilePath } from '../../lib/platform.mjs';
import { FusionStore } from './store.mjs';

export const FUSION_ACTIVE = ['running', 'waiting', 'recovering', 'stopping'];
export const NATIVE_UNSETTLED = ['preparing', 'submitting', 'running', 'unknown', 'stopping'];
const records = new WeakMap();
const emptyOwner = Object.freeze({ current: '', runs: Object.freeze([]) });

function freeze(value) {
  const pending = [value];
  while (pending.length) {
    const object = pending.pop();
    if (!object || typeof object !== 'object' || Object.isFrozen(object)) continue;
    for (const child of Object.values(object)) if (child && typeof child === 'object') pending.push(child);
    Object.freeze(object);
  }
  return value;
}

export class FusionState {
  #owners = Object.create(null);
  #listeners = new Set();
  constructor({ store = new FusionStore(), logger = console.error } = {}) {
    this.store = store;
    this.logger = logger;
    this.failures = new Map();
  }
  initialize() {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const owners = this.store.load((file, error, identity) => this.report('load', error, identity, file));
      const seen = new Map(), conflicts = new Set();
      const claim = (key, run) => {
        const previous = seen.get(key);
        if (previous && previous !== run) { conflicts.add(previous); conflicts.add(run); }
        seen.set(key, run);
      };
      for (const run of Object.values(owners).flatMap(owner => owner.runs)) {
        claim(JSON.stringify(['run', run.id]), run);
        if (!run.removedAt) for (const binding of run.bindings.filter(row => row.threadId))
          claim(JSON.stringify([binding.app, binding.host || '', binding.threadId]), run);
      }
      for (const run of conflicts) this.report('load', new Error('Fusion 工作台或原生会话的归属冲突'), run);
      for (const [deviceId, owner] of Object.entries(owners)) this.#owners[deviceId] = { current: owner.current,
        runs: owner.runs.filter(run => !conflicts.has(run)).map(run => this.#track(run)) };
    } catch (error) {
      this.startupError = error;
      this.report('load', error, {}, this.store.directory);
    }
  }
  #track(value) {
    const record = { state: this, value: freeze(value) };
    const run = new Proxy({}, {
      get: (_target, key) => record.value[key],
      ownKeys: () => Reflect.ownKeys(record.value),
      getOwnPropertyDescriptor: (_target, key) => Object.hasOwn(record.value, key)
        ? { enumerable: true, configurable: true, writable: false, value: record.value[key] } : undefined,
      set: () => false,
      deleteProperty: () => false,
    });
    records.set(run, record);
    return run;
  }
  report(stage, error, { deviceId, runId, id } = {}, file = '') {
    const identifier = value => typeof value === 'string' ? value.slice(0, 240) : '';
    deviceId = identifier(deviceId); runId = identifier(runId || id);
    // JSON parsing errors can quote raw file contents. Diagnostics only identify the record.
    const message = (error instanceof SyntaxError ? 'JSON 无法解析' : String(error?.message || error)).slice(0, 400);
    const key = JSON.stringify([stage, deviceId, runId, file]);
    const previous = this.failures.get(key);
    this.failures.set(key, { stage, deviceId, runId, file, message, at: Date.now() });
    if (previous?.message !== message) this.logger(`[Fusion] ${stage} ${[deviceId, runId, file].filter(Boolean).join(' ')} ${message}`);
  }
  assertReady() {
    if (!this.initialized) throw new Error('Fusion 尚未初始化');
    if (this.startupError) throw new Error('Fusion 状态目录无法读取，请检查 Relay 日志');
  }
  owner(deviceId) {
    const owner = this.#owners[deviceId];
    return owner ? { current: owner.current, runs: [...owner.runs] } : emptyOwner;
  }
  all({ removed = false } = {}) {
    return Object.values(this.#owners).flatMap(owner => owner.runs).filter(run => removed || !run.removedAt);
  }
  find(id) {
    this.assertReady();
    const run = this.all().find(row => row.id === id);
    if (run) return run;
    if ([...this.failures.values()].some(failure => failure.runId === id && failure.stage === 'load'))
      throw new Error('该 Fusion 工作台记录无法读取，原始文件已保留，请检查 Relay 日志');
    throw new Error('没有这个 Fusion 工作台，请重新选择');
  }
  #write(value, current) {
    try { this.store.write(value, current); }
    catch (error) {
      this.report('write', error, value);
      throw Object.assign(new Error('Fusion 状态写入失败，请检查 Relay 日志', { cause: error }), { fusionStoreError: true });
    }
    this.failures.delete(JSON.stringify(['write', value.deviceId, value.id, '']));
  }
  create(value) {
    this.assertReady();
    if (this.all({ removed: true }).some(run => run.id === value.id)
      || [...this.failures.values()].some(row => row.stage === 'load' && row.runId === value.id))
      throw new Error('这个 Fusion 工作台已存在或待恢复');
    const next = structuredClone(value);
    next.updated = Date.now(); next.revision++;
    this.#write(next, next.id);
    const run = this.#track(next);
    const owner = this.#owners[run.deviceId] ||= { current: '', runs: [] };
    owner.runs.push(run); owner.current = run.id;
    this.notify(run);
    return run;
  }
  select(deviceId, run) {
    this.assertReady();
    const record = records.get(run);
    if (record?.state !== this || run.removedAt) throw new Error('这个 Fusion 工作台已不可用');
    const owner = this.#owners[deviceId];
    if (owner?.current === run.id) return;
    if (deviceId === run.deviceId) this.#write(record.value, run.id);
    (this.#owners[deviceId] ||= { current: '', runs: [] }).current = run.id;
  }
  commit(run, edit) {
    const record = records.get(run);
    if (record?.state !== this) throw new Error('Fusion 工作台不属于此状态存储');
    const next = structuredClone(record.value);
    const result = edit(next);
    if (next.id !== run.id || next.deviceId !== run.deviceId || next.computer !== run.computer)
      throw new Error('不能改变 Fusion 工作台的原始身份');
    next.updated = Date.now(); next.revision++;
    const owner = this.#owners[run.deviceId], current = next.removedAt && owner.current === run.id ? '' : owner.current;
    const value = structuredClone(next);
    this.#write(value, current);
    record.value = freeze(value);
    owner.current = current;
    if (next.removedAt) for (const selection of Object.values(this.#owners))
      if (selection.current === run.id) selection.current = '';
    this.notify(run);
    return result;
  }
  notify(run) {
    for (const listener of this.#listeners) {
      try { listener(run); } catch (error) { this.report('view', error, run); }
    }
  }
  subscribe(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
}

export const fusionState = new FusionState();
export const stateOfFusionRun = run => records.get(run)?.state || fusionState;
export const savedFusion = deviceId => fusionState.owner(deviceId);
export const findFusionRun = id => fusionState.find(id);
export const assertFusionReady = () => fusionState.assertReady();
export const allFusionRuns = options => fusionState.all(options);
export const commitFusion = (run, edit) => stateOfFusionRun(run).commit(run, edit);

export function newFusionRun(deviceId, project, main, tier = 'balanced') {
  const now = Date.now();
  return { id: crypto.randomUUID(), computer: computerId(), deviceId, created: now, updated: now, revision: 0,
    title: 'Fusion 主工作台', favorite: false, removedAt: 0, project, main: { ...main, bindingId: '' }, tier, budget: null,
    status: 'ready', blockedReason: '', stopRequested: false, works: [], tasks: [], agents: [], assignments: [],
    attempts: [], bindings: [], events: [], commands: [], effects: [], questions: [], capabilities: [],
    observedMainMessages: [], observedMainTurns: [] };
}
export function rememberFusionMainWindow(controller, selection, roots) {
  const binding = controller.bindings.find(row => row.id === controller.main.bindingId);
  if (!binding || binding.app !== selection.app || binding.threadId !== selection.threadId
      || !roots.some(root => fusionProject(root.root, root.host || '')?.id === binding.project.id)) return;
  if (binding.windowId === selection.windowId && controller.main.windowId === selection.windowId) return;
  commitFusion(controller, next => {
    next.bindings.find(row => row.id === binding.id).windowId = next.main.windowId = selection.windowId;
  });
}
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
  // The overview response is available to paired clients. Never publish the
  // internal main owner (it contains native creations and MCP bearer grants).
  const { app, model, effort, bindingId, windowId, preparing, error, projectTrust, target } = controller.main;
  const main = { app, model, effort, bindingId, windowId, preparing, error, projectTrust, target };
  return { id: controller.id, computer: controller.computer, title: controller.title, favorite: controller.favorite === true,
    removedAt: controller.removedAt || 0, status: controller.status,
    ...(controller.removal ? { removal: controller.removal } : {}),
    project: controller.project, main, tier: controller.tier, updated: controller.updated,
    blockedReason: controller.blockedReason,
    works: { done: controller.works.filter(work => work.status === 'completed').length, total: controller.works.length },
    tasks: { done: controller.tasks.filter(task => task.status === 'accepted').length,
      total: controller.tasks.length, running: controller.tasks.filter(task => task.status === 'running').length } };
}
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
