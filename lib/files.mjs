// Resolves file references from Cursor chats and reads them from the local disk.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IS_WIN, normPath, pathKey, samePath, appUserDir, localFilePath } from './platform.mjs';

const TEXT_LIMIT = 512 * 1024;
const IMAGE_LIMIT = 8 * 1024 * 1024;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp' };

// vscode-remote://ssh-remote+<host or hex-encoded {"hostName":...}>/path
function parseFolderUri(uri) {
  const u = new URL(uri);
  if (u.protocol === 'file:') {
    if (IS_WIN) {
      const root = localFilePath(uri);
      return { host: null, root: root.length > path.parse(root).root.length ? root.replace(/\/+$/, '') : root };
    }
    let root = decodeURIComponent(u.pathname);
    return { host: null, root: root.replace(/\/+$/, '') || '/' };
  }
  if (u.protocol !== 'vscode-remote:') return null;
  const authority = decodeURIComponent(u.host);
  const ssh = /^ssh-remote\+(.+)$/.exec(authority);
  let host = authority;
  if (ssh) {
    host = ssh[1];
    if (/^[0-9a-f]+$/i.test(host) && host.length % 2 === 0) {
      try { host = JSON.parse(Buffer.from(host, 'hex').toString('utf8')).hostName || host; } catch {}
    }
  }
  return { host, root: decodeURIComponent(u.pathname).replace(/\/+$/, '') || '/' };
}

function workspaceIdentity(w) {
  const root = normPath(w.root || '');
  return `${w.host || ''}\0${pathKey(root, !w.host)}`;
}

// A .code-workspace file lists every root. Relative paths are resolved from the file's folder.
function readCodeWorkspace(file, mtime, source) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  const folders = Array.isArray(data.folders) ? data.folders : [];
  const base = path.dirname(file);
  const out = [];
  for (const folder of folders) {
    if (typeof folder?.uri === 'string') {
      const ws = parseFolderUri(folder.uri);
      if (ws) out.push({ ...ws, mtime, source, workspaceFile: file });
    } else if (typeof folder?.path === 'string') {
      const root = path.isAbsolute(folder.path) ? folder.path : path.resolve(base, folder.path);
      out.push({ host: null, root: normPath(root), mtime, source, workspaceFile: file });
    }
  }
  return out;
}

function rootsFromWorkspaceJson(file, source) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const mtime = fs.statSync(file).mtimeMs;
  if (typeof data.folder === 'string') {
    const ws = parseFolderUri(data.folder);
    return ws ? [{ ...ws, mtime, source, workspaceFile: '' }] : [];
  }
  if (typeof data.workspace !== 'string') return [];
  const pointed = parseFolderUri(data.workspace);
  if (!pointed || pointed.host) return pointed ? [{ ...pointed, mtime, source, workspaceFile: data.workspace }] : [];
  if (/\.code-workspace$/i.test(pointed.root) || /workspace\.json$/i.test(pointed.root)) {
    const roots = readCodeWorkspace(pointed.root, mtime, source);
    if (roots.length) return roots;
  }
  return [{ ...pointed, mtime, source, workspaceFile: '' }];
}

// Every folder Cursor, Devin, or VS Code has opened, newest first. Same host and path stay one entry.
export function workspaces() {
  const apps = ['code', 'cursor', 'devin'];
  const byId = new Map();
  for (const app of apps) {
    const dir = path.join(appUserDir(app), 'workspaceStorage');
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const file = path.join(dir, name, 'workspace.json');
      let rows = [];
      try { rows = rootsFromWorkspaceJson(file, app); } catch { continue; }
      for (const row of rows) {
        const id = workspaceIdentity(row);
        const prev = byId.get(id);
        if (!prev || row.mtime > prev.mtime) byId.set(id, { ...row, id, sources: [...new Set([...(prev?.sources || []), app])] });
        else if (!prev.sources.includes(app)) prev.sources.push(app);
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.mtime - a.mtime);
}

function openedFolders(app) {
  const file = path.join(appUserDir(app), 'globalStorage', 'storage.json');
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  const wins = data?.windowsState?.openedWindows;
  if (!Array.isArray(wins)) return [];
  const out = [];
  for (const win of wins) {
    const uri = typeof win?.workspace === 'string' ? win.workspace : typeof win?.folder === 'string' ? win.folder : '';
    if (!uri) continue;
    const pointed = parseFolderUri(uri);
    if (!pointed) continue;
    const windowName = path.posix.basename(pointed.root).replace(/\.code-workspace$/i, '');
    if (!pointed.host && (/\.code-workspace$/i.test(pointed.root) || /workspace\.json$/i.test(pointed.root))) {
      for (const folder of readCodeWorkspace(pointed.root, 0, app)) out.push({ ...folder, windowName });
      continue;
    }
    out.push({ ...pointed, source: app, workspaceFile: '', windowName: path.posix.basename(pointed.root) });
  }
  return out;
}

export function titleFolder(title, app) {
  if (IS_WIN) title = String(title || '').replace(/\s+\[(?:Administrator|Administer)\]$/i, '');
  if (app === 'cursor') title = String(title || '').replace(/\s+-\s+Cursor$/, '');
  if (app === 'devin') {
    const match = /^(.*) - Devin(?: - .*)?$/.exec(String(title || ''));
    if (match) return { name: match[1].trim(), host: /\[SSH: ([^\]]+)\]/.exec(String(title || ''))?.[1] || null };
  }
  if (app === 'code' || app === 'codex') {
    const parts = String(title || '').replace(/\s+-\s+Visual Studio Code$/, '').split(' - ').map(s => s.trim()).filter(Boolean);
    if (parts[0] === 'Welcome' && parts.length > 1) return { name: parts[parts.length - 1], host: null };
    return { name: (parts.length > 1 ? parts[parts.length - 1] : parts[0]) || '', host: null };
  }
  const host = /\[SSH: ([^\]]+)\]/.exec(String(title || ''))?.[1] || null;
  const name = String(title || '').replace(/\s*\[SSH: [^\]]+\]\s*$/, '').split(app === 'cursor' ? / — | - / : ' — ').pop().replace(/^●\s*/, '').trim();
  return { name, host };
}

// Read the editor's own workspace, independently of its title and recent-folder storage.
export async function editorRoots(cdp, app) {
  const workspace = await cdp.evaluate('window.vscode?.context?.configuration?.()?.workspace || null');
  const uri = workspace?.uri || workspace?.configPath;
  if (!uri) return [];
  const folder = parseFolderUri(`${uri.scheme}://${uri.authority || ''}${encodeURIComponent(uri.path).replace(/%2F/g, '/')}`);
  if (!folder) return [];
  const source = app === 'codex' ? 'code' : app;
  if (workspace.configPath && !folder.host) return readCodeWorkspace(folder.root, 0, source);
  return [{ ...folder, source, workspaceFile: '' }];
}

// Folders belonging to the window that is open now. Same folder names stay separate by full path and host.
export function windowRoots(title, app, preferRoot = '') {
  const storageApp = app === 'codex' ? 'code' : app === 'devin' ? 'devin' : app === 'code' ? 'code' : 'cursor';
  const { name, host } = titleFolder(title, storageApp === 'code' && app !== 'cursor' ? 'code' : app);
  const samePlace = (w, root, itemHost = host) => samePath(w.root || '', root || '', false) && (w.host || null) === (itemHost || null);
  const sameName = (a, b) => IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b;
  const open = openedFolders(storageApp).filter(w => sameName(w.windowName, name) && (w.host || null) === host);
  let matched = open.length ? open : workspaces().filter(w => sameName(path.posix.basename(normPath(w.root)), name) && (w.host || null) === host && (w.sources || [w.source]).includes(storageApp));
  if (matched.length > 1 && !open.length) matched = [];
  if (preferRoot) {
    const known = workspaces().find(w => samePlace(w, preferRoot, host));
    const local = !known && !host && fs.existsSync(preferRoot);
    if (known || local) {
      const pref = known || { host: null, root: preferRoot, source: storageApp, sources: [storageApp], workspaceFile: '', windowName: path.posix.basename(preferRoot), id: `\0${preferRoot}` };
      return [pref, ...matched.filter(w => !samePlace(w, pref.root, pref.host))];
    }
  }
  return matched;
}

// Window titles look like "file.py — Folder [SSH: host]" or "Folder".
export function workspaceForTitle(title, app = 'cursor') {
  return windowRoots(title, app)[0] || null;
}

// Two folders can share a name. The label keeps a parent path, and a host, until it is unique.
export function workspaceLabel(w, all = workspaces()) {
  const name = path.posix.basename(w.root) || w.root;
  const same = all.filter(x => path.posix.basename(x.root) === name);
  const parts = String(w.root || '').split(/[/\\]/).filter(Boolean);
  let detail = w.host || '';
  if (same.length > 1) {
    for (let n = 2; n <= parts.length; n++) {
      const tail = parts.slice(-n).join('/');
      const clash = same.some(x => x !== w && (x.host || '') === (w.host || '') && String(x.root || '').split(/[/\\]/).filter(Boolean).slice(-n).join('/') === tail);
      if (!clash) {
        detail = [w.host, parts.slice(0, -1).slice(-(n - 1)).join('/')].filter(Boolean).join(':');
        break;
      }
    }
    if (!detail) detail = [w.host, w.root].filter(Boolean).join(':');
  }
  return { name, detail };
}

// Returns the size of a regular file, or null if it doesn't exist.
export async function fileSize(p) {
  try {
    const st = fs.statSync(p.replace(/^~(?=\/)/, os.homedir()));
    return st.isFile() ? st.size : null;
  } catch { return null; }
}

async function readHead(p, limit) {
  const fd = fs.openSync(p.replace(/^~(?=\/)/, os.homedir()), 'r');
  try {
    const buf = Buffer.alloc(limit);
    const n = fs.readSync(fd, buf, 0, limit, 0);
    return buf.subarray(0, n);
  } finally { fs.closeSync(fd); }
}

export async function readFile(p, size) {
  const name = path.posix.basename(p);
  const image = IMAGE_TYPES[path.extname(name).toLowerCase()];
  if (image) {
    if (size > IMAGE_LIMIT) throw new Error(`图片太大（${(size / 1048576).toFixed(1)} MB），请在电脑上看`);
    const buf = await readHead(p, size);
    return { image: `data:${image};base64,${buf.toString('base64')}` };
  }
  const buf = await readHead(p, Math.min(size, TEXT_LIMIT));
  if (buf.subarray(0, 8192).includes(0)) throw new Error('二进制文件，不能预览');
  return { text: buf.toString('utf8'), truncated: size > TEXT_LIMIT };
}

// Longest local workspace that contains this file.
export function locateWritable(filePath) {
  const raw = String(filePath || '');
  const found = [];
  for (const w of workspaces()) {
    if (w.host) continue;
    try {
      const root = fs.realpathSync(w.root.replace(/^~(?=\/)/, os.homedir()));
      const target = fs.realpathSync(raw.replace(/^~(?=\/)/, os.homedir()));
      const comparedRoot = IS_WIN ? root.toLowerCase() : root;
      const comparedTarget = IS_WIN ? target.toLowerCase() : target;
      if (comparedTarget === comparedRoot || comparedTarget.startsWith(IS_WIN && comparedRoot.endsWith(path.sep) ? comparedRoot : comparedRoot + path.sep)) found.push({ host: null, path: target, root });
    } catch {}
  }
  if (!found.length) return null;
  return found.sort((a, b) => b.root.length - a.root.length)[0];
}

// Replaces an existing text file. Refuses missing files and files larger than the preview limit.
export async function writeTextFile(p, text) {
  const size = await fileSize(p);
  if (size == null) throw new Error('找不到文件（可能已被删除或移动）');
  if (size > TEXT_LIMIT) throw new Error('文件太长，只能查看不能保存');
  const buf = Buffer.from(String(text), 'utf8');
  if (buf.length > TEXT_LIMIT) throw new Error('内容太长，不能保存');
  const local = p.replace(/^~(?=\/)/, os.homedir());
  const tmp = `${local}.${process.pid}.cr-tmp`;
  const mode = fs.statSync(local).mode & 0o7777;
  fs.writeFileSync(tmp, buf, { mode });
  try { fs.chmodSync(tmp, mode); fs.renameSync(tmp, local); }
  catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  return fs.statSync(local).size;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', 'vendor', '__pycache__', '.venv', 'venv', 'target']);
const DOC_EXT = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc']);
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.h', '.cc', '.cpp', '.hpp', '.css', '.scss', '.html', '.vue', '.json', '.yml', '.yaml', '.sh', '.bash', '.toml', '.xml', '.rb', '.php', '.sql', '.kt', '.swift', '.gradle', '.lua', '.zig', '.cs']);

function fileKind(name) {
  if (/^readme($|\.)/i.test(name) || DOC_EXT.has(path.extname(name).toLowerCase())) return 'doc';
  if (CODE_EXT.has(path.extname(name).toLowerCase()) && !/\.min\./i.test(name)) return 'code';
  return '';
}

async function listDir(dir) {
  const local = dir.replace(/^~(?=\/)/, os.homedir());
  return fs.readdirSync(local, { withFileTypes: true }).map(d => ({ name: d.name, dir: d.isDirectory(), file: d.isFile() }));
}

// README and source files inside one project. dir must stay inside root.
export async function listProject(root, dir, allFiles = false) {
  const home = dir => dir.replace(/^~(?=\/)/, os.homedir());
  const base = fs.realpathSync(home(root));
  const here = fs.realpathSync(home(dir || root));
  const baseKey = IS_WIN ? base.toLowerCase() : base;
  const hereKey = IS_WIN ? here.toLowerCase() : here;
  if (hereKey !== baseKey && !hereKey.startsWith(IS_WIN && baseKey.endsWith(path.sep) ? baseKey : baseKey + path.sep)) throw new Error('只能查看这个项目里的文件');
  let items = [];
  try { items = await listDir(here); }
  catch { throw new Error('读不了这个文件夹'); }
  const byName = (a, b) => a.name.localeCompare(b.name, 'zh');
  const childPath = name => IS_WIN ? normPath(path.join(here, name)) : path.posix.join(normPath(here), name);
  const folders = items.filter(i => i.dir && (allFiles || !i.name.startsWith('.')) && !SKIP_DIRS.has(i.name))
    .map(i => ({ name: i.name, path: childPath(i.name) }))
    .sort(byName).slice(0, 80);
  const docs = [];
  const code = [];
  const files = [];
  for (const item of items.filter(i => i.file && (allFiles || !i.name.startsWith('.')))) {
    const kind = fileKind(item.name);
    const row = { name: item.name, path: childPath(item.name) };
    if (kind === 'doc') docs.push(row);
    else if (kind === 'code') code.push(row);
    else if (allFiles) files.push(row);
  }
  docs.sort((a, b) => (/^readme/i.test(b.name) - /^readme/i.test(a.name)) || byName(a, b));
  code.sort(byName);
  files.sort(byName);
  const parent = hereKey === baseKey ? null : IS_WIN ? normPath(path.dirname(here)) : path.posix.dirname(normPath(here));
  return { root: base, path: normPath(here), parent, name: path.basename(base), host: '', folders, docs: docs.slice(0, 40), code: code.slice(0, 200), ...(allFiles ? { files: files.slice(0, 200) } : {}) };
}

// "src/a.py:12", "a.py#L12-20", "a.py (lines 3-9)" → path + first line.
export function parseRef(text) {
  let s = String(text).trim().replace(/^[`'"]+|[`'",;:.)]+$/g, '');
  let line = null;
  const m = /(?::(\d+)(?::\d+)?(?:-\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(s);
  if (m) { line = Number(m[1] || m[2]); s = s.slice(0, m.index); }
  return { p: /^file:\/\//i.test(s) ? localFilePath(s) : s, line };
}

const SEARCH_SKIP = new Set([...SKIP_DIRS, '.gradle']);
// Bare file name → full path under root. Bounded recursive search (depth ≤ 6,
// ~20000 entries); a bare name must have a single match in the search scope.
function findByBasename(root, ref) {
  const want = pathKey(path.posix.basename(normPath(ref)));
  if (!want) return null;
  let found = null, ambiguous = false;
  let visited = 0;
  const walk = (dir, depth) => {
    if (depth > 6 || visited > 20000 || ambiguous) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++visited > 20000) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SEARCH_SKIP.has(e.name) && !e.name.startsWith('.')) walk(full, depth + 1);
      } else if (e.isFile() && pathKey(e.name) === want) {
        if (found) { ambiguous = true; return; }
        found = full;
      }
    }
  };
  walk(root, 0);
  return ambiguous || visited > 20000 ? null : found;
}

// Resolves a chat file reference against a workspace purely on disk — for apps like
// Devin that have no quick-open to search by name: absolute path → root-relative →
// bounded basename search inside the workspace.
export async function resolveLocal(ws, refText) {
  let { p, line } = parseRef(refText);
  if (IS_WIN && !ws?.host) p = localFilePath(p);
  if (!p) throw new Error('不是文件路径');
  const hit = async q => {
    const size = await fileSize(q);
    return size == null ? null : { host: ws?.host || null, path: q, size, line };
  };
  const abs = /^(\/|~\/)/.test(p) || /^[a-zA-Z]:[\\/]/.test(p);
  if (abs) {
    const found = await hit(p);
    if (found) return found;
  } else if (ws) {
    const found = await hit(IS_WIN && !ws.host ? normPath(path.join(ws.root, p)) : path.posix.join(normPath(ws.root), p));
    if (found) return found;
    if (!ws.host && !normPath(p).includes('/')) {
      let local = null;
      try { local = findByBasename(fs.realpathSync(ws.root.replace(/^~(?=\/)/, os.homedir())), p); } catch {}
      if (local) {
        const found = await hit(local);
        if (found) return found;
      }
    }
  }
  throw new Error(`找不到文件（可能已被删除或移动）：${p}`);
}
