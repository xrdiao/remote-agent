// Shared platform facade; OS rules live in their own implementations.
import os from 'node:os';
import * as windowsPlatform from './platform/windows.mjs';
import * as posixPlatform from './platform/posix.mjs';

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';
export const plat = () => IS_MAC ? 'darwin' : IS_WIN ? 'win32' : 'linux';

// The chat's main modifier: Cmd on macOS, Ctrl elsewhere.
export const mod = key => `${IS_MAC ? 'Meta' : 'Ctrl'}+${key}`;

export const normPath = p => String(p ?? '').replace(/\\/g, '/');
const platform = IS_WIN ? windowsPlatform : posixPlatform;
export const windowsFilePath = windowsPlatform.windowsFilePath;
export const posixFilePath = posixPlatform.posixFilePath;
export function localFilePath(value, windows = IS_WIN) {
  return windows ? windowsFilePath(value) : posixFilePath(value);
}
export const pathKey = (p, local = true) => { const n = local ? localFilePath(p) : posixFilePath(p); return local && IS_WIN ? n.toLowerCase() : n; };
export const samePath = (a, b, local = true) => pathKey(a, local) === pathKey(b, local);
export const localFileUri = platform.localFileUri;
export const uriFilePath = platform.uriFilePath;
export const validLocalName = platform.validLocalName;
export const localDrives = platform.localDrives;
export const winInstallDirs = windowsPlatform.winInstallDirs;
export const launchCommand = platform.launchCommand;
export const pidByPort = platform.pidByPort;
export const projectPathAllowed = platform.projectPathAllowed;
export const projectDrives = platform.projectDrives;
export const projectParent = platform.projectParent;
export const nativeLauncher = platform.nativeLauncher;

const USER_DIRS = {
  cursor: { win32: `${process.env.APPDATA}/Cursor/User`, linux: '~/.config/Cursor/User', darwin: '~/Library/Application Support/Cursor/User' },
  devin: { win32: `${process.env.APPDATA}/Devin/User`, linux: '~/.config/Devin/User', darwin: '~/Library/Application Support/Devin/User' },
  code: { win32: `${process.env.APPDATA}/Code/User`, linux: '~/.config/Code/User', darwin: '~/Library/Application Support/Code/User' },
};

// The app's VS Code "User" data dir. 'codex' and 'code' both mean VS Code.
export function appUserDir(app) {
  return String(USER_DIRS[app === 'codex' ? 'code' : app]?.[plat()] || '').replace(/^~/, os.homedir());
}

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

export function installDirs(app) {
  return INSTALL_DIRS[app]?.[plat()] || [];
}

export function findBin(app, port) { return platform.findBin(app, port, installDirs); }
