// A dedicated browser process owns only this short-lived pairing window.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { consumePairing, pairingSession } from './auth.mjs';

function pairingBrowser() {
  const names = process.platform === 'win32' ? ['msedge.exe', 'chrome.exe'] : ['google-chrome', 'microsoft-edge', 'chromium', 'chromium-browser'];
  const candidates = (process.env.PATH || '').split(path.delimiter).flatMap(dir => names.map(name => path.join(dir, name)));
  if (process.platform === 'win32') {
    for (const root of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(path.join(root, 'Microsoft/Edge/Application/msedge.exe'), path.join(root, 'Google/Chrome/Application/chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    for (const root of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      candidates.push(path.join(root, 'Google Chrome.app/Contents/MacOS/Google Chrome'), path.join(root, 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'));
    }
  }
  const executable = candidates.find(file => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } });
  if (!executable) throw new Error('独立配对窗口需要电脑安装 Chrome、Edge 或 Chromium。');
  return executable;
}

export async function runPairingWindow(pairing, port, { handleSignals = true } = {}) {
  let child, profile, timer, stopped = false, finish;
  const stoppedWindow = new Promise(resolve => { finish = resolve; });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    consumePairing(pairing.approval);
    finish();
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else child.kill('SIGTERM');
      child.unref();
    }
  };
  try {
    const browser = pairingBrowser();
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-agent-pair-'));
    child = spawn(browser, [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-mode', '--window-size=620,850',
      `--app=http://127.0.0.1:${port}/approve.html#${pairing.approval}`], { stdio: 'ignore', detached: true });
    process.once('exit', stop);
    if (handleSignals) { process.once('SIGINT', stop); process.once('SIGTERM', stop); }
    timer = setInterval(() => { if (!pairingSession(pairing.approval, true)) stop(); }, 500);
    await Promise.race([stoppedWindow, new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => code && !signal && !stopped ? reject(new Error('独立配对窗口启动失败，请确认当前电脑有可用的图形桌面。')) : resolve());
    })]);
  } finally {
    stop();
    process.removeListener('exit', stop);
    if (handleSignals) { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    if (profile) {
      const removeProfile = () => fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      if (child?.exitCode === null && child.signalCode === null) child.once('exit', () => removeProfile().catch(() => {}));
      else await removeProfile();
    }
  }
}
