// Finds the desktop app's VS Code colour theme (colors + tokenColors) so the phone
// viewer can syntax-highlight with the same palette the desktop uses.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { IS_WIN, plat, appUserDir, installDirs, winInstallDirs, pidByPort } from './platform.mjs';

const USER_EXT_DIRS = {
  codex: ['~/.vscode/extensions'],
  devin: ['~/.devin/extensions', '~/.windsurf/extensions'],
  cursor: ['~/.cursor/extensions'],
};

const home = p => String(p).replace(/^~/, os.homedir());

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
  const dir = appUserDir(app);
  if (!dir) return null;
  const cfg = readJsonc(path.join(dir, 'settings.json'));
  return cfg?.['workbench.colorTheme'] || null;
}

// Executable path of a local process listening on the CDP port (win32 via
// Get-NetTCPConnection; unix via /proc or lsof). Best effort, never throws.
function installFromPort(port) {
  try {
    const pid = pidByPort(port);
    if (!pid) return null;
    if (IS_WIN) {
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        `(Get-Process -Id ${pid}).Path`],
        { timeout: 8000, encoding: 'utf8' }).trim();
      if (out && fs.existsSync(out)) return path.dirname(out);
    } else {
      const exe = fs.readlinkSync(`/proc/${pid}/exe`);
      // .../resources/app/... or the app binary itself — walk up to the install root.
      let d = path.dirname(exe);
      for (let i = 0; i < 6 && d && !fs.existsSync(path.join(d, 'resources/app')); i++) d = path.dirname(d);
      if (d && fs.existsSync(path.join(d, 'resources/app'))) return d;
    }
  } catch {}
  return null;
}

// Candidate install roots, most reliable first. Cheap sources only when the
// previous ones came up empty: a port→exe lookup spawns PowerShell (~4 s) and
// the drive scan is a last resort.
function installRoots(app, port) {
  const known = installDirs(app);
  const roots = known.filter(d => fs.existsSync(d));
  if (roots.length) return roots;
  const fromProc = port && installFromPort(port);
  if (fromProc) roots.push(fromProc);
  if (roots.length || plat() !== 'win32') return roots;
  for (const d of winInstallDirs(app)) if (fs.existsSync(d)) roots.push(d);
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

// Process-wide per-app cache. Settings.json mtime is the invalidation key so a
// theme switch on the desktop is picked up on the next file open.
const themeCache = new Map();
function settingsMtime(app) {
  const dir = appUserDir(app);
  if (!dir) return 0;
  try { return fs.statSync(path.join(dir, 'settings.json')).mtimeMs; } catch { return 0; }
}
export function themeFor(app, { port } = {}) {
  const mtime = settingsMtime(app);
  const hit = themeCache.get(app);
  if (hit && hit.mtime === mtime) return hit.promise;
  const promise = Promise.resolve().then(() => findTheme(app, { port })).catch(() => null);
  themeCache.set(app, { mtime, promise });
  return promise;
}
