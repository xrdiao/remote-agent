import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { IS_WIN, findBin } from '../../lib/platform.mjs';
import { DATA_DIR, readState, saveState } from '../../lib/auth.mjs';
import { PORT, PUBLISH_REPO } from '../config.mjs';
import { publishUrl } from './pages.mjs';
import { offerFirstPairing } from '../util.mjs';

export function findTunnelPid() {
  try {
    const pids = [];
    if (IS_WIN) {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process -Filter \"Name = 'cloudflared.exe'\" | Select-Object ProcessId, CommandLine) -Compress"], { encoding: 'utf8', windowsHide: true });
      for (const item of JSON.parse(out)) {
        if (new RegExp(`127\\.0\\.0\\.1:${PORT}\\b`).test(item.CommandLine)) pids.push(item.ProcessId);
      }
    } else {
      const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
      for (const line of out.split('\n')) {
        if (!/^\s*\d+\s+\S*cloudflared(?:\s|$)/.test(line) || !new RegExp(`127\\.0\\.0\\.1:${PORT}\\b`).test(line)) continue;
        const pid = Number(line.trim().split(/\s+/)[0]);
        if (pid && pid !== process.pid) pids.push(pid);
      }
    }
    const owned = savedPid();
    return pids.includes(owned) ? owned : pids[0] || 0;
  } catch {}
  return 0;
}

const logPath = path.join(DATA_DIR, 'tunnel.log');
const pidPath = path.join(DATA_DIR, 'tunnel.pid');
const quickUrl = url => /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(url);
const savedUrl = () => String(readState().relayUrl || '').replace(/\/$/, '');
const savedPid = () => { try { return Number(fs.readFileSync(pidPath, 'utf8').trim()); } catch { return 0; } };
const logText = () => { try { return fs.readFileSync(logPath, 'utf8'); } catch { return ''; } };
const loggedUrl = () => logText().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] || '';
const metricsUrl = () => {
  const match = logText().match(/Starting metrics server on (127\.0\.0\.1:\d+)\/metrics/);
  return match ? `http://${match[1]}/ready` : '';
};
async function tunnelReady(url, metrics = '') {
  if (metrics) {
    try {
      const r = await fetch(metrics, { signal: AbortSignal.timeout(1500) });
      if (r.ok && (await r.json())?.readyConnections > 0) return true;
    } catch {}
    return false;
  }
  if (!url) return false;
  try {
    const r = await fetch(`${url}/url.json`, { signal: AbortSignal.timeout(4000) });
    return r.ok && (await r.json())?.self === true;
  } catch { return false; }
}

// Restarting the relay keeps the existing origin while cloudflared reconnects.
export async function publishedTunnel() {
  const pid = findTunnelPid(), owned = pid === savedPid();
  const url = owned ? loggedUrl() : savedUrl();
  if (!quickUrl(url) || !pid) return '';
  return await tunnelReady(url, owned ? metricsUrl() : '') ? url : '';
}

export function rememberTunnel(url, pid = findTunnelPid()) {
  saveState({ relayUrl: url });
  if (pid) fs.writeFileSync(pidPath, `${pid}\n`, { mode: 0o600 });
  return pid;
}

let tunnelMonitor = null, tunnel = null, checking = false, publishing = Promise.resolve();
function publishTunnel(state) {
  publishing = publishing.then(async () => {
    if (tunnel !== state) return;
    let ok = false;
    try { ok = await publishUrl(state.url); }
    catch (error) { console.log('!! 隧道地址发布失败：', error.message); }
    if (!ok && tunnel === state) {
      state.publishTimer = setTimeout(() => publishTunnel(state), 30000);
      state.publishTimer.unref();
    }
  }).catch(error => console.log('!! 隧道地址发布失败：', error.message));
}
function announceTunnel(state) {
  if (state.announced) return;
  state.announced = true;
  rememberTunnel(state.url, state.pid);
  console.log(`\n公网地址：${state.url}`);
  if (PUBLISH_REPO) publishTunnel(state);
  else {
    console.log('隧道在后台运行，重启中继会沿用当前地址。');
    console.log(`要彻底关掉公网：kill ${state.pid}`);
    offerFirstPairing();
  }
}
function launchTunnel() {
  clearTimeout(tunnel?.publishTimer);
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(logPath, '');
  const fd = fs.openSync(logPath, 'a');
  const missing = () => {
    clearInterval(tunnelMonitor);
    tunnelMonitor = null;
    console.log('!! 找不到或无法启动 cloudflared，请安装后重新运行 npm run public。');
  };
  let child;
  try {
    child = spawn(findBin('cloudflared'), ['tunnel', '--no-autoupdate', '--edge-ip-version', '4', '--protocol', 'http2', '--url', `http://127.0.0.1:${PORT}`], {
      detached: true, stdio: ['ignore', fd, fd],
    });
  } catch { fs.closeSync(fd); missing(); return; }
  fs.closeSync(fd);
  const state = tunnel = { pid: child.pid, owned: true, url: '', metrics: '', unhealthyAt: Date.now() };
  if (child.pid) fs.writeFileSync(pidPath, `${child.pid}\n`, { mode: 0o600 });
  child.unref();
  child.on('error', missing);
  child.on('exit', () => { if (tunnel === state) { state.exited = true; checkTunnel().catch(console.error); } });
}
async function checkTunnel() {
  if (checking || !tunnel) return;
  checking = true;
  try {
    const state = tunnel;
    let alive = !state.exited && !!state.pid;
    if (alive) { try { process.kill(state.pid, 0); } catch { alive = false; } }
    if (!alive) { launchTunnel(); return; }
    if (state.restarting) return;
    if (!state.url && state.owned) state.url = loggedUrl();
    if (state.owned) state.metrics = metricsUrl();
    const ready = await tunnelReady(state.url, state.metrics);
    if (tunnel !== state) return;
    if (ready && state.url) { state.unhealthyAt = 0; announceTunnel(state); return; }
    state.unhealthyAt ||= Date.now();
    // Let cloudflared recover brief network interruptions before replacing its origin.
    if (state.owned && Date.now() - state.unhealthyAt >= 60000) {
      console.log('!! 隧道持续未就绪，正在重新建立连接。');
      state.restarting = true;
      clearTimeout(state.publishTimer);
      try { process.kill(state.pid, 'SIGTERM'); } catch { state.exited = true; }
    }
  } finally { checking = false; }
}
export async function startTunnel() {
  if (tunnelMonitor) return;
  const pid = findTunnelPid(), url = savedUrl();
  tunnelMonitor = setInterval(() => checkTunnel().catch(console.error), 5000);
  tunnelMonitor.unref();
  const owned = pid === savedPid();
  if (pid && (owned || quickUrl(url))) {
    tunnel = { pid, owned, url: owned ? loggedUrl() : url, metrics: '', unhealthyAt: Date.now() };
    await checkTunnel();
  } else launchTunnel();
}
