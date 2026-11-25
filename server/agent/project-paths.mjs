import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { workspaces } from '../../lib/files.mjs';
import { IS_WIN, findBin, localFilePath, pathKey, validLocalName, projectPathAllowed, projectDrives, projectParent, nativeLauncher, launchCommand } from '../../lib/platform.mjs';
import { CDP_URL, DEVIN_CDP_URL, CODEX_CDP_URL } from '../config.mjs';

export function safeHomePath(input) {
  const home = localFilePath(fs.realpathSync(os.homedir()));
  const target = input ? path.resolve(localFilePath(input)) : home;
  let real;
  try { real = localFilePath(fs.realpathSync(target)); }
  catch { throw new Error('找不到这个文件夹'); }
  // Windows intentionally allows any drive — projects are not limited to the home dir.
  if (!projectPathAllowed(real, home)) throw new Error('只能打开家目录里的文件夹');
  return { home, real };
}


export function projectList(dir) {
  const { home, real } = safeHomePath(dir);
  const recent = [];
  const seen = new Set();
  if (!dir) {
    for (const w of workspaces()) {
      if (w.host) continue;
      let root;
      try { root = localFilePath(fs.realpathSync(localFilePath(w.root))); } catch { continue; }
      if (seen.has(pathKey(root))) continue;
      seen.add(pathKey(root));
      recent.push({ name: path.basename(root) || root, path: root });
      if (recent.length >= 12) break;
    }
  }
  let names = [];
  try {
    names = fs.readdirSync(real, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name)
      .sort((a, b) => a.localeCompare(b, 'zh'))
      .slice(0, 200);
  } catch { throw new Error('读不了这个文件夹'); }
  return {
    recent,
    browsing: Boolean(dir),
    path: real,
    parent: projectParent(real, home),
    drives: projectDrives(),
    dirs: names.map(name => ({ name, path: localFilePath(path.join(real, name)) })),
  };
}


export function createProjectFolder(parent, name) {
  const { real } = safeHomePath(parent);
  if (!validLocalName(name)) throw new Error('请输入有效的文件夹名称');
  const folder = path.join(real, name);
  fs.mkdirSync(folder);
  return folder;

}


export async function openFolder(folder, app, newWindow = false, withDebugPort = false) {
  const { real } = safeHomePath(folder);
  const port = new URL(app === 'devin' ? DEVIN_CDP_URL : app === 'codex' ? CODEX_CDP_URL : CDP_URL).port;
  const bin = findBin(app, port);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VSCODE_IPC_HOOK_CLI;
  const mode = newWindow ? '-n' : '-r';
  const flags = withDebugPort ? ['--remote-debugging-port=' + port] : [];
  if (app === 'devin') {
    for (const key of Object.keys(env)) {
      if (/^(?:(?:https?|all|socks|ftp|no)_proxy|NODE_USE_ENV_PROXY|GLOBAL_AGENT_HTTP_PROXY)$/i.test(key)) delete env[key];
    }
    env.NO_PROXY = '*';
    if (!IS_WIN) env.no_proxy = '*';
    flags.push('--no-proxy-server');
  }
  const { command, args } = launchCommand(bin, [mode, ...flags, real]);
  const native = nativeLauncher(bin);
  const child = spawn(command, args, { env, detached: true, stdio: native ? 'ignore' : ['ignore', 'ignore', 'pipe'], windowsHide: true });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    if (native) { child.once('spawn', resolve); return; }
    let error = '';
    child.stderr.on('data', chunk => { error += chunk; });
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(error.trim() || `打开项目失败（退出码 ${code}）`)));
  });
  child.unref();
  return real;
}
