import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IS_WIN, IS_MAC } from '../lib/platform.mjs';
import { listWindows } from './windows.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS = ['cursor', 'devin', 'codex'];
// An app already being launched never spawns a second process, across sessions too.
// Later callers join the in-flight launch and get its result instead of silence.
const inFlight = new Map();

// Apps whose process this relay just started: the next attach within 3 minutes
// should load the app's most recent session instead of the remembered thread.
const launched = new Map();
export function hasLaunched(app) {
  const at = launched.get(app);
  return !!at && Date.now() - at < 180000;
}
export function takeLaunched(app) {
  const at = launched.get(app);
  launched.delete(app);
  return !!at && Date.now() - at < 180000;
}

// Starts the platform launcher for the requested agents, emits launchResult,
// then re-probes so the connection overlay updates. Never awaits the caller's
// command queue — callers run this detached.
export function launchAgents(s, apps, probe) {
  const requested = (Array.isArray(apps) ? apps : []).map(a => String(a).toLowerCase()).filter(a => AGENTS.includes(a));
  const targets = requested.length ? [...new Set(requested)] : AGENTS;
  const fresh = targets.filter(a => !inFlight.has(a));
  if (fresh.length) {
    const p = runLaunchers(fresh).catch(() => fresh.map(app => ({ app, status: 'failed' })));
    for (const a of fresh) inFlight.set(a, p);
    p.finally(() => { for (const a of fresh) inFlight.delete(a); });
  }
  Promise.all(targets.map(a => inFlight.get(a) || Promise.resolve([])))
    .then(batches => targets.map(a => batches.flat().find(r => r.app === a) || { app: a, status: 'failed' }))
    .then(async results => {
      s.emit({ t: 'launchResult', results });
      probe?.();
      // The debug port answers before the app registers its window targets; keep probing
      // for a while so the overlay flips to connected instead of staying "未连接".
      const starting = results.filter(r => r.status === 'started').map(r => r.app);
      for (const a of starting) launched.set(a, Date.now());
      for (let i = 0; starting.length && i < 10; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const found = new Set((await listWindows().catch(() => [])).map(w => w.app));
        probe?.();
        if (starting.every(a => found.has(a))) break;
      }
    })
    .catch(() => {});
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
