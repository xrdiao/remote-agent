import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, computerId } from './auth.mjs';
import { parseSessionRef } from './shared-rules.mjs';

const file = path.join(DATA_DIR, 'session-library.json');
let records = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const clients = new Set();
let titleRevision = Math.max(0, ...Object.values(records).flatMap(group => Object.values(group).map(row => row.titleRevision || 0)));

export function sessionRows(app, rows) {
  return rows.map(row => {
    const saved = records[app]?.[sessionId(app, row.id)];
    return saved?.title && !row.ui ? { ...row, title: saved.title, titleRevision: saved.titleRevision } : row;
  });
}

export function observeSessionTitle(app, id, title) {
  const saved = records[app]?.[sessionId(app, id)];
  if (typeof title === 'object' && title) {
    if (title.at <= (saved?.titleAt || 0)) return;
    title = title.title;
  }
  if (saved?.title && title && title !== saved.title) publishSessionChange(app, id, { action: 'rename', title });
}

export function sessionId(app, value) {
  const id = parseSessionRef(app, value);
  return ['cursor', 'devin', 'codex', 'opencode'].includes(app) && id && !/^(?:pick|new|win|window|project-new):/.test(id) ? id : '';
}

function publish() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(records) + '\n', { mode: 0o600 });
  publishRecords();
}

function publishRecords() {
  const message = JSON.stringify({ t: 'sessionLibrary', computer: computerId(), records });
  for (const client of clients) if (client.readyState === 1) client.send(message);
}

export function subscribeLibrary(client) {
  clients.add(client);
  const unsubscribe = () => clients.delete(client);
  client.once('close', unsubscribe);
  return unsubscribe;
}

export function readLibrary() { return records; }

export function storedSessionStatus(app, id, host = '') {
  return records[app]?.[sessionId(app, id)]?.statuses?.[host] || null;
}

export function rememberSessionStatuses(rows, at = Date.now()) {
  let changed = false;
  for (const row of rows) {
    const id = sessionId(row.app, row.threadId);
    if (!id || row.dormant || !row.waiting && (row.statusKnown === false || row.run?.status === 'unknown')) continue;
    const group = records[row.app] ||= {}, entry = group[id] ||= {};
    if (entry.deleted || entry.archived) continue;
    const host = row.host || '', previous = entry.statuses?.[host];
    if (previous?.at > at) continue;
    const run = row.run && row.run.status !== 'unknown' ? { id: row.run.id, status: row.run.status,
      startedAt: row.run.startedAt || 0, completedAt: row.run.completedAt || 0 } : null;
    if (run?.startedAt && previous?.run?.startedAt > run.startedAt) continue;
    const status = { busy: !!row.busy, waiting: row.waiting ? row.waiting.startsWith('q:') ? 'q:' : 'approval' : '', run };
    if (previous && JSON.stringify({ ...previous, at: undefined }) === JSON.stringify(status)) continue;
    (entry.statuses ||= {})[host] = { ...status, at };
    changed = true;
  }
  if (changed) publish();
  return changed;
}

export function syncLibrarySessions(app, states, timestamps = new Map()) {
  let changed = false;
  const group = records[app] ||= {};
  for (const [id, state] of states) {
    const previous = group[id] || {};
    const at = timestamps.get(id);
    if (at != null && at < (previous.nativeStateAt || 0)) continue;
    if (state === 'active' && !previous.archived && !previous.deleted) continue;
    const next = { ...previous, archived: state === 'archived', deleted: state === 'deleted',
      ...(state !== 'active' ? { statuses: undefined } : {}),
      ...(at == null ? {} : { nativeStateAt: at }),
      ...(state === 'deleted' ? { favorite: false } : {}) };
    if (JSON.stringify(next) === JSON.stringify(previous)) continue;
    group[id] = next;
    changed = true;
  }
  if (changed) publish();
  return changed;
}

export function importLibrary(entries = []) {
  let changed = false;
  for (const entry of entries) {
    const id = sessionId(entry.app, entry.id);
    if (!id) continue;
    const group = records[entry.app] ||= {};
    const previous = group[id] || {};
    if (previous.deleted) continue;
    const next = { ...previous };
    if (next.favorite === undefined && entry.favorite === true) next.favorite = true;
    const at = Number(entry.lastMessageAt);
    if (Number.isFinite(at) && at > 0 && at <= Date.now() && at > (next.lastMessageAt || 0)) next.lastMessageAt = at;
    if (JSON.stringify(next) === JSON.stringify(previous)) continue;
    group[id] = next;
    changed = true;
  }
  if (changed) publish();
}

export function favoriteSession(app, value, favorite) {
  const id = sessionId(app, value);
  if (!id) throw new Error('没有读取到会话标识，请刷新会话列表');
  const group = records[app] ||= {};
  group[id] = { ...group[id], favorite, deleted: false };
  publish();
}

export function rememberSessionMessage(app, value, at) {
  const id = sessionId(app, value);
  if (!id || !Number.isFinite(at) || at <= 0 || at > Date.now()) return;
  const group = records[app] ||= {}, previous = group[id] || {};
  if (previous.deleted || previous.lastMessageAt <= Date.now() && at <= previous.lastMessageAt) return;
  group[id] = { ...previous, lastMessageAt: at };
  publish();
}

export function removeLibrarySession(app, value) {
  const id = sessionId(app, value);
  if (!id) return;
  (records[app] ||= {})[id] = { favorite: false, deleted: true };
  publish();
}

export function publishSessionCleanup(app, value, action) {
  const id = sessionId(app, value);
  if (!id) throw new Error('没有读取到会话标识，请刷新会话列表');
  const row = action === 'archive'
    ? { ...records[app]?.[id], archived: true, deleted: false, favorite: false, statuses: undefined }
    : { favorite: false, deleted: true };
  const next = { ...records, [app]: { ...records[app], [id]: row } };
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.pending';
  try {
    fs.writeFileSync(temporary, JSON.stringify(next) + '\n', { mode: 0o600, flag: 'wx', flush: true });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* preserve the write error */ }
    throw error;
  }
  records = next;
  publishRecords();
  emitSessionChange(app, id, { action });
}

export function publishSessionChange(app, value, change) {
  const id = sessionId(app, value);
  if (change.action === 'archive') {
    const group = records[app] ||= {};
    group[id] = { ...group[id], archived: true, statuses: undefined };
    publish();
  }
  if (change.action === 'rename') {
    const group = records[app] ||= {};
    group[id] = { ...group[id], title: change.title, titleRevision: ++titleRevision, titleAt: Date.now() };
    publish();
    change = { ...change, titleRevision };
  }
  emitSessionChange(app, id, change);
}

function emitSessionChange(app, id, change) {
  const message = JSON.stringify({ t: 'sessionChanged', computer: computerId(), app, id, ...change });
  for (const client of clients) if (client.readyState === 1) client.send(message);
}
