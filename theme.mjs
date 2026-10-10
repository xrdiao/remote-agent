// Finds the desktop app's VS Code colour theme (colors + tokenColors) so the phone
// viewer can syntax-highlight with the same palette the desktop uses.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const APP_DIRS = {
  devin: { win32: `${process.env.APPDATA}/Devin/User`, linux: '~/.config/Devin/User', darwin: '~/Library/Application Support/Devin/User' },
  cursor: { win32: `${process.env.APPDATA}/Cursor/User`, linux: '~/.config/Cursor/User', darwin: '~/Library/Application Support/Cursor/User' },
};
const APP_EXE = { devin: 'Devin', cursor: 'Cursor' };
const USER_EXT_DIRS = {
  devin: ['~/.devin/extensions', '~/.windsurf/extensions'],
  cursor: ['~/.cursor/extensions'],
};
const INSTALL_DIRS = {
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

// Windows installs can live on any drive (this machine has Devin under E:\Program Files).
function winInstallDirs(app) {
  const out = [];
  const exe = APP_EXE[app];
  for (let c = 67; c <= 90 && out.length < 4; c++) { // C..Z
    const d = String.fromCharCode(c);
    for (const pf of ['Program Files', 'Program Files (x86)']) {
      const p = `${d}:\\${pf}\\${exe}`;
      if (fs.existsSync(p)) out.push(p);
    }
  }
  return out;
}

const home = p => String(p).replace(/^~/, os.homedir());
const plat = () => process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';

// settings.json may contain comments and trailing commas (JSONC).
function readJsonc(file) {
  try {
    const s = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1')
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(s);
  } catch { return null; }
}

export function themeName(app) {
  const dir = APP_DIRS[app]?.[plat()];
  if (!dir) return null;
  const cfg = readJsonc(path.join(home(dir), 'settings.json'));
  return cfg?.['workbench.colorTheme'] || null;
}

// Executable path of a local process listening on the CDP port (win32 via
// Get-NetTCPConnection; unix via /proc or lsof). Best effort, never throws.
function installFromPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -Expand OwningProcess | ForEach-Object { (Get-Process -Id $_).Path })`],
        { timeout: 8000, encoding: 'utf8' }).trim();
      if (out && fs.existsSync(out)) return path.dirname(out);
    } else {
      const out = execFileSync('sh', ['-c', `ss -ltnp 2>/dev/null | grep ':${port} ' | grep -oP 'pid=\\K[0-9]+' | head -1`], { timeout: 5000, encoding: 'utf8' }).trim();
      const pid = out.split('\n')[0];
      if (pid) {
        const exe = fs.readlinkSync(`/proc/${pid}/exe`);
        // .../resources/app/... or the app binary itself — walk up to the install root.
        let d = path.dirname(exe);
        for (let i = 0; i < 6 && d && !fs.existsSync(path.join(d, 'resources/app')); i++) d = path.dirname(d);
        if (d && fs.existsSync(path.join(d, 'resources/app'))) return d;
      }
    }
  } catch {}
  return null;
}

// Candidate install roots, most reliable first.
function installRoots(app, port) {
  const roots = [];
  const fromProc = port && installFromPort(port);
  if (fromProc) roots.push(fromProc);
  const known = INSTALL_DIRS[app]?.[plat()] || [];
  const extra = plat() === 'win32' ? winInstallDirs(app) : [];
  for (const d of [...known, ...extra]) if (fs.existsSync(d)) roots.push(d);
  return roots;
}

// Extension dirs that may contribute themes: built-ins under resources/app/extensions,
// user-installed under ~/.<app>/extensions.
function extensionRoots(app, port) {
  const roots = [];
  for (const r of installRoots(app, port)) {
    const ext = path.join(r, 'resources', 'app', 'extensions');
    if (fs.existsSync(ext)) roots.push(ext);
    if (fs.existsSync(path.join(r, 'extensions'))) roots.push(path.join(r, 'extensions'));
  }
  for (const d of USER_EXT_DIRS[app] || []) {
    const ext = home(d);
    if (fs.existsSync(ext)) roots.push(ext);
  }
  return roots;
}

// Every theme a package.json contributes: {id, label, file, dir}.
export function contributedThemes(app, port) {
  const seen = new Set();
  const out = [];
  for (const root of extensionRoots(app, port)) {
    let dirs;
    try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (!d.isDirectory() || seen.has(d.name)) continue;
      seen.add(d.name);
      const pkg = readJsonc(path.join(root, d.name, 'package.json'));
      for (const t of pkg?.contributes?.themes || []) {
        if (t.path) out.push({ id: t.id || t.label, label: t.label || t.id, uiTheme: t.uiTheme, file: path.join(root, d.name, t.path) });
      }
    }
  }
  return out;
}

// A theme file may "include" another (e.g. dark_modern ← dark_plus); the child wins.
export function loadThemeFile(file, depth = 0) {
  const t = readJsonc(file);
  if (!t || depth > 4) return t;
  if (t.include) {
    const parent = loadThemeFile(path.resolve(path.dirname(file), t.include), depth + 1);
    if (parent) return {
      ...parent, ...t,
      colors: { ...(parent.colors || {}), ...(t.colors || {}) },
      tokenColors: [...(parent.tokenColors || []), ...(t.tokenColors || [])],
    };
  }
  return t;
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Finds the theme named in the app's settings.json. Returns a shiki-compatible
// theme registration {name,type,colors,tokenColors} or null.
export function findTheme(app, { port } = {}) {
  const want = themeName(app);
  const themes = contributedThemes(app, port);
  const pick = want
    ? themes.find(t => norm(t.id) === norm(want) || norm(t.label) === norm(want))
      || themes.find(t => norm(t.id).includes(norm(want)) || norm(t.label).includes(norm(want)))
    : null;
  const t = pick && loadThemeFile(pick.file);
  if (!t) return null;
  const colors = t.colors || {};
  const type = t.type === 'light' || t.type === 'hcLight' ? 'light' : t.type === 'dark' || t.type === 'hc' ? 'dark' : (pick.uiTheme === 'vs' || pick.uiTheme === 'hc-light' ? 'light' : 'dark');
  return {
    name: t.name || pick.label || pick.id || 'app-theme',
    type,
    uiTheme: pick.uiTheme,
    colors,
    fg: t.fg || colors['editor.foreground'],
    bg: t.bg || colors['editor.background'],
    tokenColors: (t.tokenColors || []).map(r => r.settings ? r : { scope: r.scope, settings: { foreground: r.foreground, fontStyle: r.fontStyle } }),
    settings: t.settings,
    file: pick.file,
  };
}
