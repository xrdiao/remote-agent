// Windows entry point: keep services independent of this short-lived pairing console.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { readState, DATA_DIR } from '../lib/auth.mjs';
import { PORT, PUBLISH_REPO } from '../server/config.mjs';
import { findTunnelPid, rememberTunnel } from '../server/publish/tunnel.mjs';
import { findBin } from '../lib/platform.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const local = `http://127.0.0.1:${PORT}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const relayLog = path.join(DATA_DIR, 'windows-relay.log');
const tunnelLog = path.join(DATA_DIR, 'windows-tunnel.log');

async function reachable(base) {
  if (process.platform === 'win32' && base.startsWith('https://')) {
    const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'try { $r = Invoke-RestMethod -Uri ([Console]::In.ReadToEnd()) -TimeoutSec 5; if ($r.self -eq $true) { exit 0 } } catch {}; exit 1'],
    { input: `${base.replace(/\/$/, '')}/url.json`, encoding: 'utf8', windowsHide: true, timeout: 8000 });
    return probe.status === 0;
  }
  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/url.json`, { signal: AbortSignal.timeout(2000) });
    return response.ok && (await response.json()).self === true;
  } catch { return false; }
}

async function startDetached(bin, args, logFile) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const fd = fs.openSync(logFile, 'a');
  let child;
  try {
    const env = { ...process.env, HOST: '127.0.0.1' };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(bin, args, { cwd: repo, env, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
    await once(child, 'spawn');
    child.unref();
    return child;
  } finally { fs.closeSync(fd); }
}

async function waitFor(check, logFile, child, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`启动进程已退出，请查看 ${logFile}`);
    await delay(250);
  }
  throw new Error(`启动超时，请查看 ${logFile}`);
}

function loggedTunnelUrl() {
  const files = [tunnelLog, path.join(DATA_DIR, 'tunnel.log')].filter(file => fs.existsSync(file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const file of files) {
    const matches = [...fs.readFileSync(file, 'utf8').matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g)];
    if (matches.length) return matches.at(-1)[0];
  }
  return '';
}

export async function ensureServices() {
  const savedUrl = String(readState().relayUrl || '').replace(/\/$/, '');
  if (!await reachable(local)) {
    console.log('正在后台启动中继…');
    const stateFile = path.join(DATA_DIR, 'state.json');
    const before = fs.existsSync(stateFile) ? fs.statSync(stateFile).mtimeMs : 0;
    const ip = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address;
    const child = await startDetached(process.execPath, [path.join(repo, 'server', 'index.mjs')], relayLog);
    // The LAN entry writes state at the end of startup. Wait before storing the public URL.
    await waitFor(async () => await reachable(local) && (PUBLISH_REPO || !ip || (
      fs.existsSync(stateFile) && fs.statSync(stateFile).mtimeMs !== before && readState().localUrl === `http://${ip}:${PORT}/`
    )), relayLog, child);
  } else console.log('沿用正在运行的中继。');

  let url, tunnelChild;
  if (findTunnelPid()) {
    const current = String(readState().relayUrl || '').replace(/\/$/, '');
    url = [current, savedUrl].find(value => /^https:\/\//.test(value)) || loggedTunnelUrl();
    if (!url) throw new Error('已有隧道正在运行，但找不到公网地址；未重启隧道。');
    console.log('沿用正在运行的隧道。');
  } else {
    console.log('正在后台创建 Cloudflare 隧道…');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(tunnelLog, '');
    const bin = findBin('cloudflared');
    tunnelChild = await startDetached(bin, ['tunnel', '--no-autoupdate', '--url', local], tunnelLog);
    await waitFor(() => {
      const matches = [...fs.readFileSync(tunnelLog, 'utf8').matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g)];
      url = matches.at(-1)?.[0];
      return !!url;
    }, tunnelLog, tunnelChild);
  }
  rememberTunnel(url);
  await waitFor(() => reachable(url), tunnelLog, tunnelChild);
  return `${url}/`;
}

export async function main() {
  const result = spawnSync(process.execPath, [path.join(repo, 'cli', 'desktop-pair.mjs')], { cwd: repo, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

async function waitForKey() {
  console.log('按任意键退出...');
  if (process.platform === 'win32') {
    spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'pause >nul'], { stdio: 'inherit', windowsHide: false });
    return;
  }
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    await once(process.stdin, 'data');
    process.stdin.setRawMode(false);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main()
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => waitForKey());
}
