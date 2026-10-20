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
    if (IS_WIN) {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process -Filter \"Name = 'cloudflared.exe'\" | Select-Object ProcessId, CommandLine) -Compress"], { encoding: 'utf8', windowsHide: true });
      for (const item of JSON.parse(out)) {
        if (new RegExp(`127\\.0\\.0\\.1:${PORT}\\b`).test(item.CommandLine)) return item.ProcessId;
      }
      return 0;
    }
    const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      if (!/cloudflared/.test(line) || !new RegExp(`127\\.0\\.0\\.1:${PORT}\\b`).test(line)) continue;
      const pid = Number(line.trim().split(/\s+/)[0]);
      if (pid && pid !== process.pid) return pid;
    }
  } catch {}
  return 0;
}

// A quick tunnel URL changes only when its cloudflared process exits. Reuse a live one
// so restarting the relay keeps the same origin, and phones keep their saved device token.
export async function publishedTunnel() {
  const url = String(readState().relayUrl || '').replace(/\/$/, '');
  if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(url) || !findTunnelPid()) return '';
  for (let i = 0; i < 8; i++) {
    try {
      const r = await fetch(`${url}/url.json`, { signal: AbortSignal.timeout(4000) });
      if (r.ok && (await r.json())?.self) return url;
    } catch {}
    await new Promise(r => setTimeout(r, 400));
  }
  // The public check can fail on a brief network hiccup; cloudflared's local /ready still knows if the tunnel is up.
  for (let port = 20241; port <= 20245; port++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(1000) });
      if (r.ok && (await r.json())?.readyConnections > 0) return url;
    } catch {}
  }
  return '';
}

export function rememberTunnel(url) {
  saveState({ relayUrl: url });
  const pid = findTunnelPid();
  if (pid) fs.writeFileSync(path.join(DATA_DIR, 'tunnel.pid'), `${pid}\n`, { mode: 0o600 });
  return pid;
}

export async function startTunnel() {
  const kept = await publishedTunnel();
  if (kept) {
    const pid = rememberTunnel(kept);
    console.log(`\n公网地址：${kept}`);
    if (PUBLISH_REPO) {
      console.log('沿用已有隧道，正在把地址发布到 GitHub Pages。');
      publishUrl(kept);
    } else {
      console.log('沿用已有隧道，已配对的手机不用重新配对。');
      if (pid) console.log(`隧道在后台运行（pid ${pid}）。要彻底关掉公网：kill ${pid}`);
      offerFirstPairing();
    }
    return;
  }
  const stale = findTunnelPid();
  if (stale) { try { process.kill(stale, 'SIGTERM'); } catch {} }
  const logPath = path.join(DATA_DIR, 'tunnel.log');
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(logPath, '');
  const fd = fs.openSync(logPath, 'a');
  const bin = findBin('cloudflared');
  let child;
  let timer;
  const missing = () => console.log('!! 找不到 cloudflared。在这台电脑上执行：\nmkdir -p ~/.local/bin\ncurl -L --fail -o ~/.local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64\nchmod +x ~/.local/bin/cloudflared\n然后重新运行 npm run public');
  try {
    // Cloudflare names resolve to IPv6 first; machines without IPv6 routing then never reach the edge.
    child = spawn(bin, ['tunnel', '--no-autoupdate', '--edge-ip-version', '4', '--protocol', 'http2', '--url', `http://127.0.0.1:${PORT}`], {
      detached: true,
      stdio: ['ignore', fd, fd],
    });
  } catch (e) {
    fs.closeSync(fd);
    missing();
    return;
  }
  child.unref();
  fs.closeSync(fd);
  child.on('error', () => { if (timer) clearInterval(timer); missing(); });
  const started = Date.now();
  timer = setInterval(() => {
    let text = '';
    try { text = fs.readFileSync(logPath, 'utf8'); } catch { return; }
    const m = text.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/);
    if (!m) {
      if (Date.now() - started > 40000) {
        clearInterval(timer);
        console.log('!! 隧道超时没有拿到地址，查看 ~/.agent-remote/tunnel.log');
      }
      return;
    }
    clearInterval(timer);
    const url = m[0];
    const pid = rememberTunnel(url);
    console.log(`\n公网地址：${url}`);
    if (PUBLISH_REPO) publishUrl(url);
    else {
      console.log('这条地址会保留到隧道进程退出。之后重启服务会沿用它，已配对的手机不用重新配对。');
      if (pid) console.log(`要彻底关掉公网：kill ${pid}`);
      offerFirstPairing();
    }
  }, 400);
}

