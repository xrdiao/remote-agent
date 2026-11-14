// Platform differences in one place: OS tests, path normalization, app install
// locations, binary resolution, and process lookup by CDP port.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';
export const plat = () => IS_MAC ? 'darwin' : IS_WIN ? 'win32' : 'linux';

// The chat's main modifier: Cmd on macOS, Ctrl elsewhere.
export const mod = key => `${IS_MAC ? 'Meta' : 'Ctrl'}+${key}`;

export const normPath = p => String(p ?? '').replace(/\\/g, '/');
// Decode file URIs on the computer that owns the filesystem, not on the phone.
export function localFilePath(value, windows = IS_WIN) {
  let p = String(value ?? '');
  if (!windows) return /^file:\/\//i.test(p) ? fileURLToPath(p, { windows: false }) : p;
  if (/^file:\/\//i.test(p)) {
    const uri = new URL(p);
    p = decodeURIComponent(uri.pathname);
    if (uri.hostname && uri.hostname !== 'localhost') p = '//' + uri.hostname + p;
  }
  if (!p) return p;
  p = p.replace(/\\/g, '/').replace(/^\/(?=[a-z]:($|\/))/i, '').replace(/^[a-z]:/i, drive => drive.toUpperCase());
  const root = /^(?:[A-Z]:\/|\/\/[^/]+\/[^/]+\/?|\/)/.exec(p)?.[0] || '';
  const parts = [];
  for (const part of p.slice(root.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else if (part !== '..' || !root) parts.push(part);
  }
  return root.replace(/\/?$/, root ? '/' : '') + parts.join('/') || '.';
}
// A comparison key for paths: forward slashes, and case-insensitive on Windows
// local drives (remote paths keep the remote machine's case rules).
export const pathKey = (p, local = true) => { const n = local ? localFilePath(p) : normPath(p); return local && IS_WIN ? n.toLowerCase() : n; };
export const samePath = (a, b, local = true) => pathKey(a, local) === pathKey(b, local);

export function localFileUri(value) {
  const root = localFilePath(value);
  const unc = IS_WIN && /^\/\/([^/]+)(\/.*)$/.exec(root);
  return { scheme: 'file', authority: unc ? unc[1] : '', path: unc ? unc[2] : IS_WIN && /^[A-Z]:\//.test(root) ? '/' + root : root };
}

export function uriFilePath(uri) {
  const authority = IS_WIN && uri.authority && uri.authority.toLowerCase() !== 'localhost' ? '//' + uri.authority : '';
  return localFilePath(uri.fsPath || authority + uri.path);
}

export function validLocalName(name) {
  return !!name && name !== '.' && name !== '..' && !/[/\0]/.test(name)
    && (!IS_WIN || !/[\\<>:"|?*\x00-\x1f]|[. ]$/.test(name)
      && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name));
}

const USER_DIRS = {
  cursor: { win32: `${process.env.APPDATA}/Cursor/User`, linux: '~/.config/Cursor/User', darwin: '~/Library/Application Support/Cursor/User' },
  devin: { win32: `${process.env.APPDATA}/Devin/User`, linux: '~/.config/Devin/User', darwin: '~/Library/Application Support/Devin/User' },
  code: { win32: `${process.env.APPDATA}/Code/User`, linux: '~/.config/Code/User', darwin: '~/Library/Application Support/Code/User' },
};

// The app's VS Code "User" data dir. 'codex' and 'code' both mean VS Code.
export function appUserDir(app) {
  return String(USER_DIRS[app === 'codex' ? 'code' : app]?.[plat()] || '').replace(/^~/, os.homedir());
}

const APP_EXE = { devin: 'Devin', cursor: 'Cursor', codex: 'Code' };
const INSTALL_DIRS = {
  codex: { linux: ['/usr/share/code', '/usr/lib/code', '/opt/VSCode'], win32: [`${process.env.LOCALAPPDATA}/Programs/Microsoft VS Code`, 'C:\\Program Files\\Microsoft VS Code'], darwin: ['/Applications/Visual Studio Code.app/Contents/Resources/app'] },
  devin: {
    win32: [`${process.env.LOCALAPPDATA}/Programs/Devin`, 'C:\\Program Files\\Devin', 'C:\\Program Files (x86)\\Devin'],
    linux: ['/usr/share/devin-desktop', '/usr/lib/devin', '/opt/Devin'],
    darwin: ['/Applications/Devin.app/Contents/Resources/app'],
  },
  cursor: {
    win32: [`${process.env.LOCALAPPDATA}/Programs/cursor`, 'C:\\Program Files\\Cursor'],
    linux: ['/usr/share/cursor', '/opt/Cursor', '/usr/lib/cursor'],
    darwin: ['/Applications/Cursor.app/Contents/Resources/app'],
  },
};

// Fixed local drive letters, resolved once — probing unmapped letters with
// existsSync stalls for seconds, so read fixed-drive metadata instead.
let fixedDrives = null;
export function localDrives() {
  if (fixedDrives?.length) return fixedDrives;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_LogicalDisk -Filter "DriveType = 3" | Select-Object -ExpandProperty DeviceID'],
      { timeout: 5000, encoding: 'utf8', windowsHide: true });
    fixedDrives = [...out.matchAll(/^\s*([A-Z]):/gim)].map(m => m[1]);
  } catch {}
  if (!fixedDrives?.length) {
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '[System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq [System.IO.DriveType]::Fixed } | ForEach-Object { $_.Name }'],
        { timeout: 5000, encoding: 'utf8', windowsHide: true });
      fixedDrives = [...out.matchAll(/^\s*([A-Z]):/gim)].map(m => m[1]);
    } catch {}
  }
  if (!fixedDrives?.length) throw new Error('无法读取 Windows 本地固定磁盘列表');
  return fixedDrives;
}

// Windows installs can live on any drive (this machine has Devin under E:\Program Files).
export function winInstallDirs(app) {
  const out = [];
  const exe = APP_EXE[app];
  for (const d of localDrives()) {
    for (const pf of ['Program Files', 'Program Files (x86)']) {
      const p = `${d}:\\${pf}\\${exe}`;
      if (fs.existsSync(p)) out.push(p);
    }
  }
  return out;
}

// Candidate install roots from the known per-platform locations.
export function installDirs(app) {
  return INSTALL_DIRS[app]?.[plat()] || [];
}

// A terminal opened before GitHub CLI was installed does not have it on PATH; on Windows look in its usual folders.
let ghPathCache = null;
function ghBin() {
  if (ghPathCache) return ghPathCache;
  ghPathCache = 'gh';
  if (spawnSync('gh', ['--version'], { stdio: 'ignore', windowsHide: true }).error && IS_WIN) {
    const dirs = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
    const hit = dirs.map(d => path.join(d, 'GitHub CLI', 'gh.exe')).find(p => fs.existsSync(p));
    if (hit) ghPathCache = hit;
  }
  return ghPathCache;
}

function cloudflaredBin() {
  if (IS_WIN) {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
    const candidates = [path.join(os.homedir(), '.local', 'bin', 'cloudflared.exe'), fileURLToPath(new URL('../.runtime/cloudflared.exe', import.meta.url)),
      ...roots.map(root => path.join(root, 'cloudflared', 'cloudflared.exe')),
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe')];
    return executableOnPath('cloudflared') || candidates.find(isExecutable) || 'cloudflared';
  }
  const local = path.join(os.homedir(), '.local', 'bin', 'cloudflared');
  if (fs.existsSync(local)) return local;
  return 'cloudflared';
}

function gitBin() {
  return IS_WIN && fs.existsSync('C:\\Program Files\\Git\\cmd\\git.exe')
    ? 'C:\\Program Files\\Git\\cmd\\git.exe' : 'git';
}

let pythonPathCache;
function pythonBin() {
  if (!IS_WIN) return 'python3';
  if (pythonPathCache) return pythonPathCache;
  const options = { encoding: 'utf8', windowsHide: true, timeout: 5000 };
  const launcher = spawnSync('py.exe', ['-3', '-c', 'import sys; print(sys.executable)'],
    { ...options, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  const candidates = [launcher.status === 0 ? launcher.stdout.trim() : '', ...executablesOnPath('python'), ...executablesOnPath('python3')].filter(Boolean);
  const installed = candidates.find(bin => spawnSync(bin, ['-c', 'import sys; assert sys.version_info[0] == 3'], { ...options, stdio: 'ignore' }).status === 0);
  if (!installed) throw new Error('Windows 解压 ZIP 需要可用的 Python 3：请安装 Python，并启用 py -3 或将 python.exe 加入 PATH');
  return pythonPathCache = localFilePath(installed);
}

// The binary that launches an app window on its CDP port (Windows), or the CLI
// on PATH / a known install location (elsewhere). port is required on Windows.
export function findBin(app, port) {
  if (app === 'python') return pythonBin();
  if (app === 'ffmpeg') {
    if (!IS_WIN) return 'ffmpeg';
    const candidates = [
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
      path.join(process.env.ProgramFiles || '', 'ffmpeg', 'bin', 'ffmpeg.exe'),
      path.join(process.env.ProgramData || '', 'chocolatey', 'bin', 'ffmpeg.exe'),
      path.join(os.homedir(), 'scoop', 'shims', 'ffmpeg.exe'),
    ];
    const binary = executableOnPath('ffmpeg') || candidates.find(isExecutable);
    if (!binary) throw new Error('Windows 窗口捕获需要 FFmpeg：请安装 FFmpeg，将 ffmpeg.exe 所在目录加入 PATH，然后重启 relay');
    return localFilePath(binary);
  }
  if (!IS_WIN && ['opencode', 'libreoffice', 'chrome', 'edge', 'bash'].includes(app))
    return { chrome: 'google-chrome', edge: 'microsoft-edge' }[app] || app;
  if (IS_WIN && ['opencode', 'libreoffice', 'chrome', 'edge', 'bash'].includes(app)) {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA,
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
    const locations = {
      opencode: [path.join(os.homedir(), '.opencode', 'bin', 'opencode.exe'), path.join(process.env.APPDATA || '', 'npm', 'opencode.cmd')],
      libreoffice: roots.map(root => path.join(root, 'LibreOffice', 'program', 'soffice.com')),
      chrome: roots.map(root => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')),
      edge: roots.map(root => path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
      bash: [...roots.map(root => path.join(root, 'Git', 'bin', 'bash.exe')),
        path.resolve(path.dirname(executableOnPath('git') || gitBin()), '..', 'bin', 'bash.exe')],
    };
    const names = { libreoffice: 'soffice', chrome: 'chrome', edge: 'msedge' };
    if (app === 'bash') return locations.bash.find(isExecutable) || 'bash';
    return executableOnPath(names[app] || app) || locations[app].find(isExecutable) || names[app] || app;
  }
  if (app === 'gh') return ghBin();
  if (app === 'cloudflared') return cloudflaredBin();
  if (app === 'git') return gitBin();
  if (IS_WIN) return windowsAppBin(app, port);
  if (app === 'devin') {
    for (const bin of ['/usr/share/devin-desktop/bin/devin-desktop', '/usr/share/devin-desktop/devin-desktop']) {
      if (fs.existsSync(bin)) return bin;
    }
    return 'devin-desktop';
  }
  if (app === 'codex' || app === 'code') return process.env.CODE_BIN || 'code';
  return fs.existsSync('/usr/share/cursor/bin/cursor') ? '/usr/share/cursor/bin/cursor' : 'cursor';
}

function isExecutable(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function executableOnPath(name) {
  return executablesOnPath(name)[0];
}

function executablesOnPath(name) {
  const extensions = IS_WIN ? ['.exe', '.com', '.cmd', '.bat'] : [''];
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean)
    .flatMap(dir => extensions.map(ext => path.join(dir.replace(/^"|"$/g, ''), name + ext))).filter(isExecutable);
}

// Batch shims need a command interpreter; native executables keep their argv.
export function launchCommand(command, args = []) {
  if (!IS_WIN || !/\.(?:cmd|bat)$/i.test(command)) return { command, args };
  const quote = value => "'" + String(value).replace(/'/g, "''") + "'";
  const values = [command, ...args];
  const names = values.map((_, index) => `RA_SHIM_ARG_${index}`);
  // Expand environment references once in cmd, so literal % and ! in paths survive.
  const script = [
    '$start = New-Object System.Diagnostics.ProcessStartInfo',
    '$start.FileName = $env:ComSpec', '$start.UseShellExecute = $false', '$start.CreateNoWindow = $true',
    ...values.map((value, index) => `$start.EnvironmentVariables[${quote(names[index])}] = ${quote(value)}`),
    `$start.Arguments = ${quote('/d /v:off /s /c "' + names.map(name => `"%${name}%"`).join(' ') + '"')}`,
    '$child = [System.Diagnostics.Process]::Start($start)', '$child.WaitForExit()', 'exit $child.ExitCode',
  ].join('; ');
  return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command',
    script] };
}

function windowsAppBin(app, port) {
  if (app === 'code') app = 'codex';
  const configured = process.env[app === 'codex' ? 'CODE_BIN' : app.toUpperCase() + '_BIN'];
  if (configured) return localFilePath(configured);
  if (Number(port) > 0) {
    const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $owner = (Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen | Select-Object -First 1).OwningProcess; (Get-CimInstance Win32_Process -Filter "ProcessId = $owner").ExecutablePath`;
    let owner;
    try { owner = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim(); }
    catch {}
    if (owner && isExecutable(owner)) return localFilePath(owner);
  }
  const installed = installDirs(app).map(dir => path.join(dir, APP_EXE[app] + '.exe')).find(isExecutable)
    || winInstallDirs(app).map(dir => path.join(dir, APP_EXE[app] + '.exe')).find(isExecutable);
  if (installed) return installed;
  const onPath = executableOnPath(app === 'codex' ? 'code' : app === 'devin' ? 'devin-desktop' : app);
  if (onPath) return onPath;
  throw new Error(`找不到 ${app} 的 Windows 启动路径，请检查安装、PATH 或调试端口`);
}

// Pid of the local process listening on a TCP port (win32 via Get-NetTCPConnection;
// unix via ss + /proc). Best effort: 0 when not found.
export function pidByPort(port) {
  try {
    if (IS_WIN) {
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -Expand OwningProcess)`],
        { timeout: 8000, encoding: 'utf8', windowsHide: true }).trim();
      return Number(out) || 0;
    }
    const out = execFileSync('sh', ['-c', `ss -ltnp 2>/dev/null | grep ':${port} ' | grep -oP 'pid=\\K[0-9]+' | head -1`], { timeout: 5000, encoding: 'utf8' }).trim();
    return Number(out.split('\n')[0]) || 0;
  } catch {}
  return 0;
}
