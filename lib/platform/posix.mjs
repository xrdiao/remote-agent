import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

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

const run = promisify(execFile);
const relayUnit = 'remote-agent.service';
const systemctl = (...args) => run('systemctl', ['--user', ...args], { timeout: 5000 });
const systemdSpecifiers = value => value.replaceAll('%', '%%');
const systemdWord = value => JSON.stringify(systemdSpecifiers(value));

async function relayUnitState() {
  const { stdout } = await systemctl('show', '--property=LoadState,UnitFileState', '--', relayUnit);
  const fields = stdout.trim().split('\n');
  return { exists: !fields.includes('LoadState=not-found'), enabled: fields.includes('UnitFileState=enabled') };
}

async function writeRelayUnit({ cwd, node, args, env }) {
  if (/[\r\n]/.test(cwd)) throw new Error('中继目录含有换行，无法注册自启动');
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');
  const lines = [
    '[Unit]', 'Description=Remote Agent relay', '', '[Service]', 'Type=simple',
    'WorkingDirectory=' + systemdSpecifiers(cwd),
    'ExecStart=:' + [node, ...args].map(systemdWord).join(' '),
    ...Object.entries(env).map(([key, value]) => 'Environment=' + systemdWord(key + '=' + value)),
    'Restart=on-failure', 'RestartSec=10s', '', '[Install]', 'WantedBy=default.target', '',
  ];
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, relayUnit), lines.join('\n'), { flag: 'wx', mode: 0o600 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  await systemctl('daemon-reload');
}

export async function relayAutostart(enabled, launch) {
  if (process.platform === 'darwin') {
    const mode = enabled === undefined ? 'autostart-status' : enabled ? 'autostart-enable' : 'autostart-disable';
    const args = [fileURLToPath(new URL('../../scripts/service.sh', import.meta.url)), mode];
    if (enabled) {
      const { node, args: relayArgs, env } = launch();
      args.push(...Object.entries(env).map(([key, value]) => key + '=' + value), '--', node, ...relayArgs);
    }
    const { stdout } = await run('bash', args, { timeout: 8000 });
    return { enabled: stdout.trim() === 'true', trigger: 'login' };
  }
  if (process.platform !== 'linux') throw new Error('这台电脑不支持中继自启动设置');
  let state = await relayUnitState();
  if (enabled !== undefined && enabled !== state.enabled) {
    if (enabled && !state.exists) await writeRelayUnit(launch());
    await systemctl(enabled ? 'enable' : 'disable', '--', relayUnit);
    state = await relayUnitState();
  }
  const { stdout } = await run('loginctl', ['show-user', String(process.getuid()), '--property=Linger', '--value'], { timeout: 3000 });
  return { enabled: state.enabled, trigger: stdout.trim() === 'yes' ? 'boot' : 'login' };
}
