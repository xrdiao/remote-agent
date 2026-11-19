import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export function posixFilePath(value) {
  const p = String(value ?? '');
  return /^file:\/\//i.test(p) ? fileURLToPath(p, { windows: false }) : p;
}
export function localFileUri(value) {
  return { scheme: 'file', authority: '', path: posixFilePath(value) };
}
export function uriFilePath(uri) { return posixFilePath(uri.fsPath || uri.path); }
export function validLocalName(name) {
  return !!name && name !== '.' && name !== '..' && !/[/\0]/.test(name);
}
export const copyAfterReservedRename = code => code === 'EXDEV';
export function localDrives() { return ['/']; }
export const projectPathAllowed = (directory, home) => directory === home || directory.startsWith(home + '/');
export const projectDrives = () => [];
export const nativeLauncher = () => false;
export const projectParent = (directory, home) => directory === home ? null : path.posix.dirname(directory);
export function findBin(app) {
  if (app === 'python') return 'python3';
  if (['ffmpeg', 'opencode', 'libreoffice', 'bash', 'git', 'gh'].includes(app)) return app;
  if (app === 'chrome') return 'google-chrome';
  if (app === 'edge') return 'microsoft-edge';
  if (app === 'cloudflared') {
    const local = path.join(os.homedir(), '.local', 'bin', 'cloudflared');
    return fs.existsSync(local) ? local : 'cloudflared';
  }
  if (app === 'devin') {
    for (const bin of ['/usr/share/devin-desktop/bin/devin-desktop', '/usr/share/devin-desktop/devin-desktop'])
      if (fs.existsSync(bin)) return bin;
    return 'devin-desktop';
  }
  if (app === 'codex' || app === 'code') return process.env.CODE_BIN || 'code';
  return fs.existsSync('/usr/share/cursor/bin/cursor') ? '/usr/share/cursor/bin/cursor' : 'cursor';
}
export function launchCommand(command, args = []) { return { command, args }; }
export function pidByPort(port) {
  try {
    const out = execFileSync('sh', ['-c', `ss -ltnp 2>/dev/null | grep ':${port} ' | grep -oP 'pid=\\K[0-9]+' | head -1`], { timeout: 5000, encoding: 'utf8' }).trim();
    return Number(out.split('\n')[0]) || 0;
  } catch {}
  return 0;
}
