import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const fail = (code, status = 400) => Object.assign(new Error(code), { status });
const own = st => typeof process.getuid === 'function' && st.uid === process.getuid();
export function privateDirectory(dir) {
  const st = fs.lstatSync(dir);
  if (!path.isAbsolute(dir) || fs.realpathSync(dir) !== dir || !st.isDirectory() || !own(st) || (st.mode & 0o077))
    throw fail('private_directory_required', 403);
  return dir;
}
export function readPrivateJson(file) {
  if (!path.isAbsolute(file)) throw fail('absolute_config_path_required');
  privateDirectory(path.dirname(file));
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || !own(st) || (st.mode & 0o077) || st.size > 128 * 1024 || st.nlink !== 1)
      throw fail('private_owner_only_config_required', 403);
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}
export function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}
const alias = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v);
const permissions = (value, allowed) => Array.isArray(value) && value.length > 0
  && new Set(value).size === value.length && value.every(v => allowed.includes(v));
const label = v => typeof v === 'string' && v.length > 0 && v.length <= 120 && !/[\x00-\x1f]/.test(v);
export function loadPolicy(configPath) {
  if (process.platform !== 'linux') throw fail('linux_bridge_only', 501);
  const p = readPrivateJson(configPath);
  if (p.version !== 1 || p.enabled !== true || !alias(p.clientId) || !Number.isFinite(Date.parse(p.expiresAt))
      || Date.parse(p.expiresAt) <= Date.now()) throw fail('integration_disabled_or_expired', 403);
  if (typeof p.socketPath !== 'string' || !path.isAbsolute(p.socketPath) || Buffer.byteLength(p.socketPath) >= 104
      || path.basename(p.socketPath) !== 'bridge.sock') throw fail('invalid_socket_path');
  privateDirectory(path.dirname(p.socketPath));
  if (!Array.isArray(p.workspaces) || p.workspaces.length > 32 || !Array.isArray(p.sessions) || p.sessions.length > 64)
    throw fail('invalid_policy');
  const ids = new Set(), workspaces = [];
  for (const w of p.workspaces) {
    if (!w || !alias(w.id) || ids.has(w.id) || !label(w.label) || !permissions(w.permissions, ['read','write'])
        || !w.permissions.includes('read')) throw fail('invalid_workspace_policy');
    ids.add(w.id);
    if (w.kind === 'local') {
      if (typeof w.root !== 'string' || !path.isAbsolute(w.root) || w.root === path.parse(w.root).root
          || w.root === os.homedir() || fs.realpathSync(w.root) !== w.root || !fs.statSync(w.root).isDirectory()
          || inside(w.root, configPath) || inside(w.root, p.socketPath)
          || inside(path.dirname(configPath),w.root) || inside(path.dirname(p.socketPath),w.root)) throw fail('invalid_or_changed_workspace_root', 403);
      workspaces.push({ id:w.id, label:w.label, kind:w.kind, root:w.root, permissions:[...w.permissions] });
    } else if (w.kind === 'peer') {
      if (!/^[a-f0-9]{16}$/.test(w.nodeId) || !/^[a-f0-9-]{36}$/.test(w.peerWorkspaceId)
          || !/^[a-f0-9]{64}$/.test(w.bindingKey) || w.permissions.includes('write')) throw fail('invalid_peer_read_policy');
      workspaces.push({id:w.id,label:w.label,kind:w.kind,nodeId:w.nodeId,peerWorkspaceId:w.peerWorkspaceId,bindingKey:w.bindingKey,permissions:['read']});
    } else throw fail('unknown_workspace_kind');
  }
  const sessionIds = new Set(), sessions = [];
  for (const s of p.sessions) {
    if (!s || typeof s !== 'object') throw fail('invalid_session_policy');
    const w = workspaces.find(w => w.id === s.workspaceId && w.kind === 'local');
    if (!s || !alias(s.id) || sessionIds.has(s.id) || !label(s.label) || !w
        || !['opencode','codex','cursor','devin'].includes(s.app) || !permissions(s.permissions,['read','send'])
        || !s.permissions.includes('read') || (s.permissions.includes('send') && s.app !== 'opencode')
        || typeof s.threadId !== 'string' || !s.threadId || s.threadId.length > 256 || /[\x00-\x1f]/.test(s.threadId)
        || typeof s.windowId !== 'string' || !s.windowId || s.windowId.length > 2048
        || (s.app !== 'opencode' && (typeof s.win !== 'string' || !s.win))) throw fail('invalid_session_policy');
    sessionIds.add(s.id);
    sessions.push({id:s.id,label:s.label,workspaceId:s.workspaceId,app:s.app,threadId:s.threadId,windowId:s.windowId,win:s.win||s.app,permissions:[...s.permissions]});
  }
  return {clientId:p.clientId,socketPath:p.socketPath,expiresAt:p.expiresAt,workspaces,sessions};
}
export function workspaceFor(p, id, permission) {
  const w = p.workspaces.find(w => w.id === id);
  if (!w?.permissions.includes(permission)) throw fail('workspace_not_authorized', 403);
  return w;
}
export function sessionFor(p, id, permission) {
  const s = p.sessions.find(s => s.id === id);
  if (!s?.permissions.includes(permission)) throw fail('session_not_authorized',403);
  return {session:s, workspace:workspaceFor(p,s.workspaceId,'read')};
}
