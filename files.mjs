// Resolves file references from Cursor chats and reads them from the local disk or, for SSH windows, over ssh.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR } from './auth.mjs';

const TEXT_LIMIT = 512 * 1024;
const IMAGE_LIMIT = 8 * 1024 * 1024;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp' };

const APP_DIRS = {
  darwin: {
    code: '~/Library/Application Support/Code/User',
    cursor: '~/Library/Application Support/Cursor/User',
    devin: '~/Library/Application Support/Devin/User',
  },
  linux: {
    code: '~/.config/Code/User',
    cursor: '~/.config/Cursor/User',
    devin: '~/.config/Devin/User',
  },
  win32: {
    code: `${process.env.APPDATA}/Code/User`,
    cursor: `${process.env.APPDATA}/Cursor/User`,
    devin: `${process.env.APPDATA}/Devin/User`,
  },
};

const WIN32 = process.platform === 'win32';

function appUserDir(app) {
  const dirs = APP_DIRS[process.platform] || APP_DIRS.linux;
  return String(dirs[app] || '').replace(/^~/, os.homedir());
}

// vscode-remote://ssh-remote+<host or hex-encoded {"hostName":...}>/path
function parseFolderUri(uri) {
  const u = new URL(uri);
  if (u.protocol === 'file:') {
    let root = decodeURIComponent(u.pathname);
    if (WIN32 && /^\/[a-zA-Z]:/.test(root)) root = root.slice(1);
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
  return `${w.host || ''}\0${String(w.root || '').replace(/\\/g, '/')}`;
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
      out.push({ host: null, root: root.replace(/\\/g, '/'), mtime, source, workspaceFile: file });
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
  const name = String(title || '').replace(/\s*\[SSH: [^\]]+\]\s*$/, '').split(' — ').pop().replace(/^●\s*/, '').trim();
  return { name, host };
}

// Folders belonging to the window that is open now. Same folder names stay separate by full path and host.
export function windowRoots(title, app, preferRoot = '') {
  const storageApp = app === 'codex' ? 'code' : app === 'devin' ? 'devin' : app === 'code' ? 'code' : 'cursor';
  const { name, host } = titleFolder(title, storageApp === 'code' && app !== 'cursor' ? 'code' : app);
  const samePlace = (w, root, itemHost = host) => String(w.root || '').replace(/\\/g, '/') === String(root || '').replace(/\\/g, '/') && (w.host || null) === (itemHost || null);
  const sameName = (a, b) => WIN32 ? a.toLowerCase() === b.toLowerCase() : a === b;
  const open = openedFolders(storageApp).filter(w => sameName(w.windowName, name) && (w.host || null) === host);
  let matched = open.length ? open : workspaces().filter(w => sameName(path.posix.basename(w.root.replace(/\\/g, '/')), name) && (w.host || null) === host && (w.sources || [w.source]).includes(storageApp));
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

const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
// Remote paths starting with ~/ must leave the tilde unquoted so the remote shell expands it.
const remotePath = p => p.startsWith('~/') ? `"$HOME"/${shq(p.slice(2))}` : shq(p);

// One shared master connection per host: faster, and avoids sshd's MaxStartups dropping bursts of new connections.
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ControlMaster=auto',
  '-o', `ControlPath=${path.join(DATA_DIR, 'ssh-%C')}`, '-o', 'ControlPersist=120'];

async function ssh(host, command, limit) {
  try {
    return await sshOnce(host, command, limit);
  } catch {
    await new Promise(r => setTimeout(r, 500));
    return sshOnce(host, command, limit).catch(e => { throw new Error(`SSH 连接 ${host} 失败：${e.message}`); });
  }
}

function sshOnce(host, command, limit) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...SSH_OPTS, host, command], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0, err = '';
    child.stdout.on('data', c => { if (size < limit) { chunks.push(c); size += c.length; } });
    child.stderr.on('data', c => { err += c; });
    const timer = setTimeout(() => child.kill(), 20000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks).subarray(0, limit));
      else reject(new Error(err.trim().split('\n').pop() || `ssh exited with ${code}`));
    });
  });
}

// Returns the size of a regular file, or null if it doesn't exist.
export async function fileSize(host, p) {
  if (!host) {
    try {
      const st = fs.statSync(p.replace(/^~(?=\/)/, os.homedir()));
      return st.isFile() ? st.size : null;
    } catch { return null; }
  }
  // Exits 0 whether or not the file exists, so a rejection here always means the connection failed.
  const out = await ssh(host, `test -f ${remotePath(p)} && stat -c %s -- ${remotePath(p)} || true`, 64);
  const n = parseInt(out.toString(), 10);
  return Number.isFinite(n) ? n : null;
}

async function readHead(host, p, limit) {
  if (!host) {
    const fd = fs.openSync(p.replace(/^~(?=\/)/, os.homedir()), 'r');
    try {
      const buf = Buffer.alloc(limit);
      const n = fs.readSync(fd, buf, 0, limit, 0);
      return buf.subarray(0, n);
    } finally { fs.closeSync(fd); }
  }
  return ssh(host, `head -c ${limit} -- ${remotePath(p)}`, limit);
}

export async function readFile(host, p, size) {
  const name = path.posix.basename(p);
  const image = IMAGE_TYPES[path.extname(name).toLowerCase()];
  if (image) {
    if (size > IMAGE_LIMIT) throw new Error(`图片太大（${(size / 1048576).toFixed(1)} MB），请在电脑上看`);
    const buf = await readHead(host, p, size);
    return { image: `data:${image};base64,${buf.toString('base64')}` };
  }
  const buf = await readHead(host, p, Math.min(size, TEXT_LIMIT));
  if (buf.subarray(0, 8192).includes(0)) throw new Error('二进制文件，不能预览');
  return { text: buf.toString('utf8'), truncated: size > TEXT_LIMIT };
}

// Longest workspace that contains this file. host '' is this computer; a named host is that SSH machine.
// Same path on two machines is not one file, so a save has to name the machine.
export function locateWritable(filePath, host) {
  const raw = String(filePath || '');
  const want = host == null ? undefined : (host || null);
  const found = [];
  for (const w of workspaces()) {
    if (want !== undefined && (w.host || null) !== want) continue;
    if (w.host) {
      const root = path.posix.normalize(w.root.replace(/\\/g, '/'));
      const target = path.posix.normalize(raw.replace(/\\/g, '/'));
      const inside = target === root || target.startsWith(root.endsWith('/') ? root : root + '/');
      if (inside) found.push({ host: w.host, path: target, root });
      continue;
    }
    try {
      const root = fs.realpathSync(w.root.replace(/^~(?=\/)/, os.homedir()));
      const target = fs.realpathSync(raw.replace(/^~(?=\/)/, os.homedir()));
      if (target === root || target.startsWith(root + path.sep)) found.push({ host: null, path: target, root });
    } catch {}
  }
  if (!found.length) return null;
  const hosts = new Set(found.map(w => w.host || ''));
  if (hosts.size > 1) {
    const err = new Error('有多个同名工作区，不能确定保存到哪一个');
    err.code = 'ambiguous-workspace';
    throw err;
  }
  return found.sort((a, b) => b.root.length - a.root.length)[0];
}

function sshStdin(host, command, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...SSH_OPTS, host, command], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', c => { err += c; });
    const timer = setTimeout(() => child.kill(), 20000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(err.trim().split('\n').pop() || `ssh exited with ${code}`));
    });
    child.stdin.end(input);
  });
}

// Replaces an existing text file. Refuses missing files and files larger than the preview limit.
export async function writeTextFile(host, p, text) {
  const size = await fileSize(host, p);
  if (size == null) throw new Error('找不到文件（可能已被删除或移动）');
  if (size > TEXT_LIMIT) throw new Error('文件太长，只能查看不能保存');
  const buf = Buffer.from(String(text), 'utf8');
  if (buf.length > TEXT_LIMIT) throw new Error('内容太长，不能保存');
  if (!host) {
    const local = p.replace(/^~(?=\/)/, os.homedir());
    const tmp = `${local}.${process.pid}.cr-tmp`;
    fs.writeFileSync(tmp, buf);
    try { fs.renameSync(tmp, local); }
    catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
    return fs.statSync(local).size;
  }
  await sshStdin(host, `cat > ${remotePath(p)}`, buf);
  return buf.length;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', 'vendor', '__pycache__', '.venv', 'venv', 'target']);
const DOC_EXT = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc']);
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.h', '.cc', '.cpp', '.hpp', '.css', '.scss', '.html', '.vue', '.json', '.yml', '.yaml', '.sh', '.bash', '.toml', '.xml', '.rb', '.php', '.sql', '.kt', '.swift', '.gradle', '.lua', '.zig', '.cs']);

function fileKind(name) {
  if (/^readme($|\.)/i.test(name) || DOC_EXT.has(path.extname(name).toLowerCase())) return 'doc';
  if (CODE_EXT.has(path.extname(name).toLowerCase()) && !/\.min\./i.test(name)) return 'code';
  return '';
}

async function listDir(host, dir) {
  if (!host) {
    const local = dir.replace(/^~(?=\/)/, os.homedir());
    return fs.readdirSync(local, { withFileTypes: true }).map(d => ({ name: d.name, dir: d.isDirectory(), file: d.isFile() }));
  }
  const out = await ssh(host, `find ${remotePath(dir)} -mindepth 1 -maxdepth 1 -printf '%y\\t%f\\n'`, 256 * 1024);
  return out.toString('utf8').split('\n').filter(Boolean).map(line => {
    const tab = line.indexOf('\t');
    const kind = line.slice(0, tab);
    const name = line.slice(tab + 1);
    return { name, dir: kind === 'd', file: kind === 'f' };
  });
}

// README and source files inside one project. dir must stay inside root.
export async function listProject(host, root, dir) {
  let base, here;
  if (!host) {
    const home = dir => dir.replace(/^~(?=\/)/, os.homedir());
    base = fs.realpathSync(home(root));
    here = fs.realpathSync(home(dir || root));
    if (here !== base && !here.startsWith(base + path.sep)) throw new Error('只能查看这个项目里的文件');
  } else {
    base = path.posix.normalize(String(root).replace(/\\/g, '/'));
    here = path.posix.normalize(String(dir || root).replace(/\\/g, '/'));
    if (here !== base && !here.startsWith(base.endsWith('/') ? base : base + '/')) throw new Error('只能查看这个项目里的文件');
  }
  let items = [];
  try { items = await listDir(host, here); }
  catch (e) { throw new Error(host ? e.message : '读不了这个文件夹'); }
  const byName = (a, b) => a.name.localeCompare(b.name, 'zh');
  const folders = items.filter(i => i.dir && !i.name.startsWith('.') && !SKIP_DIRS.has(i.name))
    .map(i => ({ name: i.name, path: path.posix.join(here.replace(/\\/g, '/'), i.name) }))
    .sort(byName).slice(0, 80);
  const docs = [];
  const code = [];
  for (const item of items.filter(i => i.file && !i.name.startsWith('.'))) {
    const kind = fileKind(item.name);
    const row = { name: item.name, path: path.posix.join(here.replace(/\\/g, '/'), item.name) };
    if (kind === 'doc') docs.push(row);
    else if (kind === 'code') code.push(row);
  }
  docs.sort((a, b) => (/^readme/i.test(b.name) - /^readme/i.test(a.name)) || byName(a, b));
  code.sort(byName);
  const parent = here === base ? null : path.posix.dirname(here.replace(/\\/g, '/'));
  return { root: base, path: here.replace(/\\/g, '/'), parent, name: path.basename(base), host: host || '', folders, docs: docs.slice(0, 40), code: code.slice(0, 200) };
}

// "src/a.py:12", "a.py#L12-20", "a.py (lines 3-9)" → path + first line.
export function parseRef(text) {
  let s = String(text).trim().replace(/^[`'"]+|[`'",;:.)]+$/g, '');
  let line = null;
  const m = /(?::(\d+)(?::\d+)?(?:-\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(s);
  if (m) { line = Number(m[1] || m[2]); s = s.slice(0, m.index); }
  return { p: s, line };
}

const SEARCH_SKIP = new Set([...SKIP_DIRS, '.gradle']);
// Bare file name → full path under root. Bounded recursive search (depth ≤ 6,
// ~20000 entries); prefers paths ending with the ref's directory suffix, then the shortest.
function findByBasename(root, ref) {
  const want = path.posix.basename(ref.replace(/\\/g, '/')).toLowerCase();
  if (!want) return null;
  const suffix = '/' + ref.replace(/\\/g, '/');
  let best = null;
  let visited = 0;
  const walk = (dir, depth) => {
    if (depth > 6 || visited > 20000 || best?.score === 0) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++visited > 20000) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SEARCH_SKIP.has(e.name) && !e.name.startsWith('.')) walk(full, depth + 1);
      } else if (e.isFile() && e.name.toLowerCase() === want) {
        const norm = full.replace(/\\/g, '/');
        const score = norm.endsWith(suffix) ? 0 : 1;
        if (!best || score < best.score || (score === best.score && norm.length < best.path.length)) best = { path: full, score };
      }
    }
  };
  walk(root, 0);
  return best?.path || null;
}

// Resolves a chat file reference against a workspace purely on disk — for apps like
// Devin that have no quick-open to search by name: absolute path → root-relative →
// bounded basename search inside the workspace.
export async function resolveLocal(ws, refText) {
  let { p, line } = parseRef(refText);
  if (WIN32 && !ws?.host) p = p.replace(/\\/g, '/');
  if (WIN32 && /^\/[a-zA-Z]:[\\/]/.test(p)) p = p.slice(1);
  if (!p) throw new Error('不是文件路径');
  const hit = async q => {
    const size = await fileSize(ws?.host || null, q);
    return size == null ? null : { host: ws?.host || null, path: q, size, line };
  };
  const abs = /^(\/|~\/)/.test(p) || /^[a-zA-Z]:[\\/]/.test(p);
  if (abs) {
    const found = await hit(p);
    if (found) return found;
  } else if (ws) {
    const found = await hit(path.posix.join(String(ws.root).replace(/\\/g, '/'), p));
    if (found) return found;
    if (!ws.host) {
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
