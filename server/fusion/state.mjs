import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { workspaces } from '../../lib/files.mjs';
import { readState, saveState, computerId, forgetSelection } from '../../lib/auth.mjs';
import { normPath, pathKey, findBin } from '../../lib/platform.mjs';

export const fusionRuns = readState().fusionRuns || {};
export const conversationProjects = readState().conversationProjects || {};
export const fusionWorkers = new Map();
export const fusionViewers = new Set();
export const FUSION_ACTIVE = ['running', 'waiting', 'recovering', 'stopping'];
export const NATIVE_UNSETTLED = ['preparing', 'submitting', 'running', 'unknown', 'stopping'];
const subscribers = new Set();

export function saveFusionRuns() {
  const facts = Object.fromEntries(Object.entries(fusionRuns).map(([deviceId, saved]) => [deviceId, { ...saved,
    runs: saved.runs.map(run => ({ ...run, attempts: run.attempts.map(({ live, ...attempt }) => attempt) })) }]));
  saveState({ fusionRuns: facts });
}

// Startup owns the one-time cutover. Importing routes or running checks never cleans data.
export function initializeFusionState() {
  const old = readState().fusionHistory;
  if (old !== undefined) {
    const entries = readState().entrySelections?.[computerId()] || {};
    const selections = Object.fromEntries(Object.entries(entries).filter(([, entry]) => entry.last?.app === 'fusion' || entry.apps?.fusion)
      .map(([device, entry]) => [device, { last: entry.last?.app === 'fusion' ? entry.last : null, fusion: entry.apps?.fusion }]));
    const dir = fileURLToPath(new URL('../../_shots/fusion-rewrite-20261101/', import.meta.url));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `legacy-fusion-${Date.now()}.json`), JSON.stringify({ fusionHistory: old, selections }, null, 2), { mode: 0o600 });
    saveState({ fusionHistory: undefined, fusionRuns });
    for (const device of Object.keys(selections)) forgetSelection(device, 'fusion');
  }
}

export function savedFusion(deviceId) { return fusionRuns[deviceId] ||= { current: '', runs: [] }; }
export function findFusionRun(deviceId, id) {
  const run = fusionRuns[deviceId]?.runs.find(value => value.id === id);
  if (!run) throw new Error('没有这个 Fusion run，请从 Fusion 工作区重新选择');
  return run;
}
export function newFusionRun(deviceId, project, main, tier = 'balanced') {
  const now = Date.now();
  return { id: crypto.randomUUID(), computer: computerId(), deviceId, created: now, updated: now, revision: 0,
    title: '新 Fusion run', project, main: { ...main, bindingId: '' }, tier, budget: null,
    status: 'ready', blockedReason: '', stopRequested: false,
    authorization: null, criteria: [], messages: [], events: [], decisions: [],
    tasks: [], attempts: [], bindings: [], capabilities: [] };
}
export function publishFusion(run, persist = true) {
  run.updated = Date.now();
  run.revision++;
  if (persist) saveFusionRuns();
  for (const changed of subscribers) changed(run);
}
export function subscribeFusion(changed) { subscribers.add(changed); return () => subscribers.delete(changed); }
export function fusionEvent(run, type, data, id = crypto.randomUUID()) {
  const previous = run.events.find(event => event.id === id);
  if (previous) return previous;
  const event = { id, type, data, at: Date.now(), consumedBy: '' };
  run.events.push(event);
  return event;
}
export function fusionMessage(run, role, text, extra = {}) {
  const message = { id: crypto.randomUUID(), role, text, at: Date.now(), ...extra };
  run.messages.push(message);
  return message;
}
export function newFusionAttempt(run, task, execution, cost, kind = 'task') {
  const attempt = { id: crypto.randomUUID(), taskId: task?.id || '', kind, ...execution, cost,
    created: Date.now(), status: 'queued', submission: 'not_submitted', bindingId: '',
    native: null, acceptedAt: null, endedAt: null, result: null, usage: null, baseline: null, changes: null };
  run.attempts.push(attempt);
  if (task) { task.attemptIds.push(attempt.id); task.status = 'queued'; }
  return attempt;
}
export function fusionSummary(run) {
  return { id: run.id, computer: run.computer, title: run.title, status: run.status,
    project: run.project, main: run.main, tier: run.tier, updated: run.updated,
    blockedReason: run.blockedReason, tasks: { done: run.tasks.filter(task => task.status === 'accepted').length,
      total: run.tasks.length, running: run.tasks.filter(task => task.status === 'running').length } };
}
export function fusionBindingInUse(app, thread) {
  return [...fusionWorkers.values()].some(worker => worker.run.bindings.some(binding => binding.app === app && binding.threadId === thread
    && worker.run.attempts.some(attempt => attempt.bindingId === binding.id && NATIVE_UNSETTLED.includes(attempt.status))));
}
export function fusionWindowInUse(window) {
  const runs = new Map(Object.values(fusionRuns).flatMap(saved => saved.runs).map(run => [run.id, run]));
  for (const worker of fusionWorkers.values()) runs.set(worker.run.id, worker.run);
  for (const run of runs.values()) {
    if (run.computer !== window.computer || run.project.id !== window.projectId) continue;
    if (run.main.app === window.app && run.messages.length && !['ready', 'completed', 'stopped'].includes(run.status)) return true;
    if (run.attempts.some(attempt => attempt.app === window.app && (attempt.status === 'queued' || NATIVE_UNSETTLED.includes(attempt.status)))) return true;
    if (!run.stopRequested && !['completed', 'stopped'].includes(run.status) && run.tasks.some(task => ['awaiting_review', 'needs_work'].includes(task.status)
      && run.attempts.findLast(attempt => attempt.taskId === task.id)?.app === window.app)) return true;
    const worker = [...fusionWorkers.values()].find(value => value.run === run);
    if (run.bindings.some(binding => binding.app === window.app && worker?.archiving.has(binding.id))) return true;
  }
  return false;
}

// Shared native project identity, also used by ordinary sessions.
export function fusionProject(root, host = '') {
  if (!root || !path.isAbsolute(root)) return null;
  root = host ? path.posix.normalize(root) : fs.existsSync(root) ? fs.realpathSync(root) : path.normalize(root);
  root = normPath(root);
  return { id: JSON.stringify([host, pathKey(root, !host)]), root, host, name: path.posix.basename(root) || root };
}
export function fusionCursorProjects() {
  const projects = new Map();
  for (const workspace of workspaces().filter(value => !value.host && (value.sources || [value.source]).includes('cursor'))) {
    try {
      const remote = execFileSync(findBin('git'), ['-C', workspace.root, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const repository = remote.replace(/^\w+:\/\//, '').replace(/^.*@/, '').replace(':', '/').replace(/\.git$/, '').replace(/\/$/, '');
      const project = fusionProject(workspace.root);
      if (!projects.has(repository)) projects.set(repository, project);
      else if (projects.get(repository)?.id !== project.id) projects.set(repository, null);
    } catch { continue; }
  }
  return projects;
}
export function fusionModelSpec(model) {
  const [label, effort = ''] = String(model || '').split(' · ');
  return { model: String(model || ''), modelLabel: label, modelEffort: effort };
}
export function fusionHtml(text) {
  return String(text || '').replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char])).replace(/\n/g, '<br>');
}
