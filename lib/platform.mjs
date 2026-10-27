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
export function localFilePath(value) {
  const p = String(value ?? '');
  if (/^file:\/\//i.test(p)) {
    const decoded = fileURLToPath(p);
    return IS_WIN ? normPath(decoded) : decoded;
  }
  if (!IS_WIN) return p;
  const normalized = normPath(p);
  return /^\/[a-zA-Z]:\//.test(normalized) ? normalized.slice(1) : normalized;
}
// A comparison key for paths: forward slashes, and case-insensitive on Windows
// local drives (remote paths keep the remote machine's case rules).
export const pathKey = (p, local = true) => { const n = normPath(p); return local && IS_WIN ? n.toLowerCase() : n; };
export const samePath = (a, b, local = true) => pathKey(a, local) === pathKey(b, local);

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
// existsSync stalls for seconds, so ask wmic (or fsutil) for the list instead.
let fixedDrives = null;
function localDrives() {
  if (fixedDrives) return fixedDrives;
  try {
    const out = execFileSync('wmic', ['logicaldisk', 'get', 'drivetype,name'], { timeout: 5000, encoding: 'utf8' });
    fixedDrives = [...out.matchAll(/^\s*3\s+([A-Z]):/gim)].map(m => m[1]);
  } catch {}
  if (!fixedDrives?.length) {
    try {
      const out = execFileSync('fsutil', ['fsinfo', 'drives'], { timeout: 5000, encoding: 'utf8' });
      fixedDrives = [...out.matchAll(/([A-Z]):\\/g)].map(m => m[1]);
    } catch {}
  }
  if (!fixedDrives?.length) fixedDrives = ['C'];
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
  if (spawnSync('gh', ['--version'], { stdio: 'ignore' }).error && IS_WIN) {
    const dirs = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
    const hit = dirs.map(d => path.join(d, 'GitHub CLI', 'gh.exe')).find(p => fs.existsSync(p));
    if (hit) ghPathCache = hit;
  }
  return ghPathCache;
}

function cloudflaredBin() {
  if (IS_WIN) {
    const candidates = [path.join(os.homedir(), '.local', 'bin', 'cloudflared.exe'), fileURLToPath(new URL('../.runtime/cloudflared.exe', import.meta.url))];
    return candidates.find(p => fs.existsSync(p)) || 'cloudflared';
  }
  const local = path.join(os.homedir(), '.local', 'bin', 'cloudflared');
  if (fs.existsSync(local)) return local;
  return 'cloudflared';
}

function gitBin() {
  return IS_WIN && fs.existsSync('C:\\Program Files\\Git\\cmd\\git.exe')
    ? 'C:\\Program Files\\Git\\cmd\\git.exe' : 'git';
}

// The binary that launches an app window on its CDP port (Windows), or the CLI
// on PATH / a known install location (elsewhere). port is required on Windows.
export function findBin(app, port) {
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

function windowsAppBin(app, port) {
  const script = `$owner = (Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen | Select-Object -First 1).OwningProcess; (Get-CimInstance Win32_Process -Filter "ProcessId = $owner").ExecutablePath`;
  const bin = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
  if (!bin) throw new Error('找不到当前应用的启动路径，请先打开它的调试端口');
  return bin;
}

// Pid of the local process listening on a TCP port (win32 via Get-NetTCPConnection;
// unix via ss + /proc). Best effort: 0 when not found.
export function pidByPort(port) {
  try {
    if (IS_WIN) {
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -Expand OwningProcess)`],
        { timeout: 8000, encoding: 'utf8' }).trim();
      return Number(out) || 0;
    }
    const out = execFileSync('sh', ['-c', `ss -ltnp 2>/dev/null | grep ':${port} ' | grep -oP 'pid=\\K[0-9]+' | head -1`], { timeout: 5000, encoding: 'utf8' }).trim();
    return Number(out.split('\n')[0]) || 0;
  } catch {}
  return 0;
}
