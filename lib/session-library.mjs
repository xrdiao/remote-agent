import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, computerId } from './auth.mjs';

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
  let id = String(value || '');
  if (id.startsWith('project:')) id = decodeURIComponent(id.split(':').slice(2).join(':'));
  if (app === 'codex' && id.startsWith('thread:')) id = id.split(':').slice(2).join(':');
  if (app === 'devin') id = id.replace(/^tab:/, '');
  return ['cursor', 'devin', 'codex'].includes(app) && id && !/^(?:pick|new|win|window|project-new):/.test(id) ? id : '';
}

function publish() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(records) + '\n', { mode: 0o600 });
  const message = JSON.stringify({ t: 'sessionLibrary', computer: computerId(), records });
  for (const client of clients) if (client.readyState === 1) client.send(message);
}

export function subscribeLibrary(client) {
  clients.add(client);
  client.once('close', () => clients.delete(client));
}

export function readLibrary() { return records; }

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

export function publishSessionChange(app, value, change) {
  const id = sessionId(app, value);
  if (change.action === 'archive') {
    const group = records[app] ||= {};
    group[id] = { ...group[id], archived: true };
    publish();
  }
  if (change.action === 'rename') {
    const group = records[app] ||= {};
    group[id] = { ...group[id], title: change.title, titleRevision: ++titleRevision, titleAt: Date.now() };
    publish();
    change = { ...change, titleRevision };
  }
  const message = JSON.stringify({ t: 'sessionChanged', computer: computerId(), app, id, ...change });
  for (const client of clients) if (client.readyState === 1) client.send(message);
}
