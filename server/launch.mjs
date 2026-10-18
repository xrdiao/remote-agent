import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IS_WIN, IS_MAC } from '../lib/platform.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS = ['cursor', 'devin', 'codex'];
// An app already being launched never spawns a second process, across sessions too.
const inFlight = new Set();

// Starts the platform launcher for the requested agents, emits launchResult,
// then re-probes so the connection overlay updates. Never awaits the caller's
// command queue — callers run this detached.
export function launchAgents(s, apps, probe) {
  const requested = (Array.isArray(apps) ? apps : []).map(a => String(a).toLowerCase()).filter(a => AGENTS.includes(a));
  const targets = requested.length ? [...new Set(requested)] : AGENTS;
  const todo = targets.filter(a => !inFlight.has(a));
  if (!todo.length) return;
  for (const a of todo) inFlight.add(a);
  runLaunchers(todo)
    .then(results => s.emit({ t: 'launchResult', results }))
    .catch(() => s.emit({ t: 'launchResult', results: todo.map(app => ({ app, status: 'failed' })) }))
    .finally(() => {
      for (const a of todo) inFlight.delete(a);
      probe?.();
    });
}

async function runLaunchers(apps) {
  if (IS_MAC) return apps.map(app => ({ app, status: 'unsupported' }));
  const cmd = IS_WIN ? 'powershell' : 'bash';
  const args = IS_WIN
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'window_start', 'start-agents.ps1'), '-Apps', apps.join(',')]
    : [path.join(ROOT, 'ubuntu_start', 'start-agents.sh'), ...apps];
  const out = await new Promise(resolve => {
    let buf = '';
    const done = () => { clearTimeout(timer); resolve(buf); };
    const timer = setTimeout(() => { try { child.kill(); } catch {} done(); }, 45000);
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    child.stdout.on('data', d => { buf += d; });
    child.on('close', done);
    child.on('error', done);
  });
  const seen = new Map();
  for (const m of out.matchAll(/^RESULT (\S+) (\S+)\s*$/gm)) seen.set(m[1], m[2]);
  return apps.map(app => ({ app, status: seen.get(app) || 'failed' }));
}
