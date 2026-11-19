import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

export function windowsFilePath(value) {
  let p = String(value ?? '');
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
const localFilePath = windowsFilePath;
export function localFileUri(value) {
  const root = localFilePath(value);
  const unc = /^\/\/([^/]+)(\/.*)$/.exec(root);
  return { scheme: 'file', authority: unc ? unc[1] : '', path: unc ? unc[2] : /^[A-Z]:\//.test(root) ? '/' + root : root };
}

export function uriFilePath(uri) {
  const authority = uri.authority && uri.authority.toLowerCase() !== 'localhost' ? '//' + uri.authority : '';
  return localFilePath(uri.fsPath || authority + uri.path);
}

export function validLocalName(name) {
  return !!name && name !== '.' && name !== '..' && !/[/\0]/.test(name)
    && (!/[\\<>:"|?*\x00-\x1f]|[. ]$/.test(name)
      && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name));
}

export const copyAfterReservedRename = code => ['EXDEV', 'EEXIST', 'EPERM'].includes(code);
export const projectPathAllowed = () => true;
export const projectDrives = () => localDrives().map(drive => drive + ':/');
export const nativeLauncher = bin => /\.exe$/i.test(bin);
export const projectParent = directory => {
  const root = windowsFilePath(directory), parent = windowsFilePath(path.win32.dirname(root));
  return root.toLowerCase() === parent.toLowerCase() ? null : parent;
};

const APP_EXE = { devin: 'Devin', cursor: 'Cursor', codex: 'Code' };
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

let ghPathCache = null;
function ghBin() {
  if (ghPathCache) return ghPathCache;
  ghPathCache = 'gh';
  if (spawnSync('gh', ['--version'], { stdio: 'ignore', windowsHide: true }).error) {
    const dirs = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
    const hit = dirs.map(d => path.join(d, 'GitHub CLI', 'gh.exe')).find(p => fs.existsSync(p));
    if (hit) ghPathCache = hit;
  }
  return ghPathCache;
}

function cloudflaredBin() {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
    const candidates = [path.join(os.homedir(), '.local', 'bin', 'cloudflared.exe'), fileURLToPath(new URL('../../.runtime/cloudflared.exe', import.meta.url)),
      ...roots.map(root => path.join(root, 'cloudflared', 'cloudflared.exe')),
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe')];
    return executableOnPath('cloudflared') || candidates.find(isExecutable) || 'cloudflared';
}

function gitBin() {
  return fs.existsSync('C:\\Program Files\\Git\\cmd\\git.exe')
    ? 'C:\\Program Files\\Git\\cmd\\git.exe' : 'git';
}

let pythonPathCache;
function pythonBin() {
  if (pythonPathCache) return pythonPathCache;
  const options = { encoding: 'utf8', windowsHide: true, timeout: 5000 };
  const launcher = spawnSync('py.exe', ['-3', '-c', 'import sys; print(sys.executable)'],
    { ...options, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  const candidates = [launcher.status === 0 ? launcher.stdout.trim() : '', ...executablesOnPath('python'), ...executablesOnPath('python3')].filter(Boolean);
  const installed = candidates.find(bin => spawnSync(bin, ['-c', 'import sys; assert sys.version_info[0] == 3'], { ...options, stdio: 'ignore' }).status === 0);
  if (!installed) throw new Error('Windows 解压 ZIP 需要可用的 Python 3：请安装 Python，并启用 py -3 或将 python.exe 加入 PATH');
  return pythonPathCache = localFilePath(installed);
}

export function findBin(app, port, installDirs) {
  if (app === 'python') return pythonBin();
  if (app === 'ffmpeg') {
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
  if (['opencode', 'libreoffice', 'chrome', 'edge', 'bash'].includes(app)) {
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
  return windowsAppBin(app, port, installDirs);
}

function isExecutable(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function executableOnPath(name) {
  return executablesOnPath(name)[0];
}

function executablesOnPath(name) {
  const extensions = ['.exe', '.com', '.cmd', '.bat'];
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean)
    .flatMap(dir => extensions.map(ext => path.join(dir.replace(/^"|"$/g, ''), name + ext))).filter(isExecutable);
}

// Batch shims need a command interpreter; native executables keep their argv.
export function launchCommand(command, args = []) {
  if (!/\.(?:cmd|bat)$/i.test(command)) return { command, args };
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

function windowsAppBin(app, port, installDirs) {
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

export function pidByPort(port) {
  try {
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -Expand OwningProcess)`],
        { timeout: 8000, encoding: 'utf8', windowsHide: true }).trim();
      return Number(out) || 0;
  } catch {}
  return 0;
}

const run = promisify(execFile);
const psText = value => "'" + value.replaceAll("'", "''") + "'";
const encodedScript = script => Buffer.from(script, 'utf16le').toString('base64');
const relayTask = String.raw`
$ErrorActionPreference = 'Stop'
$options = ConvertFrom-Json -InputObject $env:RA_AUTOSTART_OPTIONS
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$name = 'Remote Agent (' + $identity.User.Value + ')'
$taskPath = '\'
function Read-RelayTask {
  try { Get-ScheduledTask -TaskPath $taskPath -TaskName $name }
  catch {
    if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { throw }
  }
}

$task = Read-RelayTask
if ($options.enabled -eq $true -and !$task) {
  $action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument $options.arguments -WorkingDirectory $options.cwd
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
  $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskPath $taskPath -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
  $task = Read-RelayTask
} elseif ($options.enabled -eq $true -and !$task.Settings.Enabled) {
  Enable-ScheduledTask -InputObject $task | Out-Null
  $task = Read-RelayTask
} elseif ($options.enabled -eq $false -and $task.Settings.Enabled) {
  Disable-ScheduledTask -InputObject $task | Out-Null
  $task = Read-RelayTask
}

ConvertTo-Json -Compress -InputObject @{ enabled = [bool]($task -and $task.Settings.Enabled); trigger = 'login' }
`;

export async function relayAutostart(enabled, launch) {
  const options = { enabled: enabled ?? null };
  if (enabled) {
    const { cwd, node, args, env } = launch();
    const command = ['$ErrorActionPreference = "Stop"',
      ...Object.entries(env).map(([key, value]) => '$env:' + key + ' = ' + psText(value)),
      '& ' + [node, ...args].map(psText).join(' '), 'exit $LASTEXITCODE'].join('\n');
    Object.assign(options, { cwd, arguments: '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + encodedScript(command) });
  }
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript(relayTask)],
      { env: { ...process.env, RA_AUTOSTART_OPTIONS: JSON.stringify(options) }, timeout: 12000, windowsHide: true });
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error('无法读取或更新 Windows 自启动任务', { cause: error });
  }
}
