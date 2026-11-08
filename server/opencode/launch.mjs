import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR } from '../../lib/auth.mjs';
import { OpenCodeClient } from './client.mjs';

const client = new OpenCodeClient();
const run = promisify(execFile);
const log = path.join(DATA_DIR, 'start-opencode.log');

async function ready() {
  try { return (await client.request('/global/health', { signal: AbortSignal.timeout(1000) })).healthy === true; }
  catch { return false; }
}

export async function detectOpenCode() {
  if (await ready()) return { app: 'opencode', name: 'OpenCode', status: 'reused' };
  try {
    await run('opencode', ['--version'], { timeout: 5000, windowsHide: true });
    return { app: 'opencode', name: 'OpenCode', status: 'installed' };
  } catch (error) {
    return { app: 'opencode', name: 'OpenCode', status: error.code === 'ENOENT' ? 'missing' : 'failed', reason: error.message };
  }
}

export async function launchOpenCode() {
  if (await ready()) return { app: 'opencode', status: 'reused' };
  const url = new URL(client.url);
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const output = fs.openSync(log, 'a', 0o600);
  let child;
  try {
    child = spawn('opencode', ['serve', '--hostname', url.hostname, '--port', url.port || '80'], {
      cwd: os.homedir(), detached: true, windowsHide: true, stdio: ['ignore', output, output],
    });
  } finally { fs.closeSync(output); }
  try {
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
  } catch (error) {
    return { app: 'opencode', status: error.code === 'ENOENT' ? 'missing' : 'failed', reason: error.message, log };
  }
  child.unref();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await ready()) return { app: 'opencode', status: 'started', pid: child.pid, log };
    if (child.exitCode !== null || child.signalCode) return { app: 'opencode', status: 'failed', log };
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return { app: 'opencode', status: 'timeout', log };
}

if (process.argv[2] === '--start-opencode') {
  const result = await launchOpenCode();
  console.log(JSON.stringify(result));
  if (!['started', 'reused'].includes(result.status)) process.exitCode = 1;
}
