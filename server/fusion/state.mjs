import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { workspaces } from '../../lib/files.mjs';
import { readState } from '../../lib/auth.mjs';
import { normPath, pathKey } from '../../lib/platform.mjs';

export const FUSION_ACTIVE = ['planning', 'echo', 'echo-check', 'execute', 'review', 'fix'];
export const fusionHistory = readState().fusionHistory || {};
export const conversationProjects = readState().conversationProjects || {};
export const fusionWorkers = new Map();
export const fusionViewers = new Set();
for (const saved of Object.values(fusionHistory)) {
  for (const run of saved.runs || []) if (FUSION_ACTIVE.includes(run.phase)) run.phase = 'idle';
}
export function newFusionRun() {
  return { id: crypto.randomUUID(), created: Date.now(), updated: Date.now(), history: [], turn: 0,
    project: null, a: null, b: null, phase: 'idle', round: 0, miss: 0, task: '', plan: '', brief: '', echo: '', result: '', diff: '', review: '' };
}

export function fusionCursorProjects() {
  const projects = new Map();
  for (const w of workspaces().filter(w => !w.host && (w.sources || [w.source]).includes('cursor'))) {
    try {
      const remote = execFileSync('git', ['-C', w.root, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const repository = remote.replace(/^\w+:\/\//, '').replace(/^.*@/, '').replace(':', '/').replace(/\.git$/, '').replace(/\/$/, '');
      const project = fusionProject(w.root);
      if (!projects.has(repository)) projects.set(repository, project);
      else if (projects.get(repository)?.id !== project.id) projects.set(repository, null);
    } catch { continue; }
  }
  return projects;
}

export function fusionProject(root, host = '') {
  if (!root || !path.isAbsolute(root)) return null;
  root = host ? path.posix.normalize(root) : fs.existsSync(root) ? fs.realpathSync(root) : path.normalize(root);
  root = normPath(root);
  const key = pathKey(root, !host);
  return { id: JSON.stringify([host, key]), root, host, name: path.posix.basename(root) || root };
}
export function fusionModelSpec(model) {
  const [label, effort = ''] = String(model || '').split(' · ');
  return { model: String(model || ''), modelLabel: label, modelEffort: effort };
}

export function fusionHtml(text) {
  return String(text || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/\n/g, '<br>');
}

export function fusionMark(text) {
  const raw = String(text || '');
  const m = /(?:^|\n)[ \t]*FUSION:[ \t]*(done|fix-brief|fix|return|go)[ \t]*\s*$/i.exec(raw);
  if (!m) return { kind: '', body: raw.trim() };
  return { kind: m[1].toLowerCase(), body: (raw.slice(0, m.index) + raw.slice(m.index + m[0].length)).trim() };
}

export function fusionLastAssistant(chat, after = '') {
  const items = chat?.items || [];
  const start = after ? items.findIndex(x => x.i === after) + 1 : 0;
  if (after && !start) return { i: '', text: '' };
  const it = items.slice(start).reverse().find(x => x.k === 'assistant' && (x.t || x.h));
  if (!it) return { i: '', text: '' };
  const text = it.t || String(it.h || '').replace(/<br\s*\/?>|<\/(?:p|div)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').trim();
  return { i: it.i || '', text, completed: it.completed };
}
