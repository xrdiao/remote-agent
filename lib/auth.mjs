// Device pairing, device tokens and optional TOTP (authenticator app); shared by the relay and the CLI scripts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = path.join(os.homedir(), '.agent-remote');
const PAIR_TTL = 3 * 60 * 1000;

const file = name => path.join(DATA_DIR, name);
const readJson = (name, fallback) => {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
};
const writeJson = (name, value) => {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file(name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
};
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const sameHash = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/* ---------- url.json encryption ---------- */

// A random key rather than a password: the public url.json then gives nothing to brute-force offline.
export function urlKey() {
  try {
    const k = Buffer.from(fs.readFileSync(file('url-key'), 'utf8').trim(), 'base64url');
    if (k.length === 32) return k;
  } catch {}
  const k = crypto.randomBytes(32);
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file('url-key'), k.toString('base64url'), { mode: 0o600 });
  return k;
}

export function computerId() {
  return crypto.createHash('sha256').update(urlKey()).digest().subarray(0, 8).toString('hex');
}

export function computerName() {
  return os.hostname().replace(/\.local$/, '').slice(0, 40) || '电脑';
}

export function encryptUrl(url) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', urlKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify({ url }), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { v: 2, iv: iv.toString('base64'), data: data.toString('base64'), updated: new Date().toISOString() };
}

export function opensEntry(entry) {
  try {
    const iv = Buffer.from(entry.iv, 'base64');
    const raw = Buffer.from(entry.data, 'base64');
    if (raw.length < 17) return false;
    const decipher = crypto.createDecipheriv('aes-256-gcm', urlKey(), iv);
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    decipher.update(raw.subarray(0, raw.length - 16));
    decipher.final();
    return true;
  } catch { return false; }
}

// One public url.json holds every computer. Each entry is encrypted with that computer's own key.
export function publishRecord(url) {
  const slot = encryptUrl(url);
  const pairing = readJson('pairing.json', null);
  return { id: computerId(), name: computerName(), iv: slot.iv, data: slot.data, updated: slot.updated,
    ...(pairing?.expires > Date.now() ? { pairing: pairing.bootstrap } : {}) };
}

/* ---------- pairing ---------- */

// The link carries the url key and an expiring request code in the #fragment, which browsers never send to any server.
export function createPairing(appBase) {
  const existing = readJson('pairing.json', null);
  const replacing = Boolean(existing && existing.expires > Date.now());
  const code = crypto.randomBytes(16).toString('base64url');
  const approval = crypto.randomBytes(32).toString('base64url');
  const expires = Date.now() + PAIR_TTL;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(code).digest(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify({ key: urlKey().toString('base64url'), id: computerId() })), cipher.final(), cipher.getAuthTag()]);
  const link = `${appBase}#pair=${urlKey().toString('base64url')}.${code}`, pairingCode = `${computerId()}.${code}`;
  writeJson('pairing.json', { hash: sha256(code), approvalHash: sha256(approval), expires, link, pairingCode,
    groupId: crypto.randomBytes(8).toString('hex'), groupNumber: 1, groupName: '设备 1',
    bootstrap: { iv: iv.toString('base64'), data: data.toString('base64'), expires } });
  return { link, pairingCode, approval, expires, minutes: PAIR_TTL / 60000, replacing };
}

export function consumePairing(approval) {
  const p = readJson('pairing.json', null);
  if (!p || !approval || !sameHash(p.approvalHash, sha256(approval))) return false;
  fs.rmSync(file('pairing.json'), { force: true });
  return true;
}

export function pairingSession(code, approval = false) {
  const p = readJson('pairing.json', null);
  const hash = approval ? p?.approvalHash : p?.hash;
  return p?.expires > Date.now() && hash && typeof code === 'string' && sameHash(hash, sha256(code))
    ? { id: p.hash, expires: p.expires, groupId: p.groupId, groupName: p.groupName } : null;
}
export function pairingDetails(approval, nextDevice = false) {
  if (!pairingSession(approval, true)) throw new Error('电脑授权窗口已失效，请重新运行 npm run pair');
  const p = readJson('pairing.json', null);
  if (nextDevice) {
    p.groupId = crypto.randomBytes(8).toString('hex');
    p.groupName = '设备 ' + ++p.groupNumber;
    writeJson('pairing.json', p);
  }
  const { link, pairingCode, expires, groupName } = p;
  return { link, pairingCode, expires, groupName };
}
export function pairingSessionActive(id) {
  const p = readJson('pairing.json', null);
  return p?.hash === id && p.expires > Date.now();
}

/* ---------- devices ---------- */

// Legacy bearer-only records are no longer authorized. Re-pairing registers an entry key.
export const listDevices = () => readJson('devices.json', []).filter(d => d.publicKey);
const saveDevices = list => writeJson('devices.json', list);

// Group presentation only: credentials and revocation remain per entry.
export function deviceGrouping(list = listDevices()) {
  const parents = list.map((_, i) => i), identities = new Map();
  const root = i => parents[i] === i ? i : (parents[i] = root(parents[i]));
  for (const [i, d] of list.entries()) {
    const keys = ['group:' + (d.groupId || d.id)];
    if (d.apns?.url && d.apns.pushId && d.apns.secret) keys.push('apns:' + sha256(JSON.stringify([d.apns.url, d.apns.pushId, d.apns.secret])));
    if (d.push?.endpoint && d.push.keys?.p256dh && d.push.keys.auth) keys.push('push:' + sha256(JSON.stringify([d.push.endpoint, d.push.keys.p256dh, d.push.keys.auth])));
    for (const key of keys) {
      if (identities.has(key)) {
        const a = root(i), b = root(identities.get(key));
        parents[Math.max(a, b)] = Math.min(a, b);
      } else identities.set(key, i);
    }
  }
  return new Map(list.map((d, i) => {
    const owner = list[root(i)];
    return [d.id, { groupId: owner.groupId || owner.id, groupName: owner.groupName || owner.name }];
  }));
}

export function addDevice(name, group = {}) {
  const publicKey = entryPublicKey(group.publicKey);
  const token = crypto.randomBytes(32).toString('base64url');
  const device = {
    id: crypto.randomBytes(4).toString('hex'),
    name: String(name || '未命名设备').slice(0, 60),
    tokenHash: sha256(token),
    publicKey,
    origin: String(group.origin || '').slice(0, 300),
    created: Date.now(),
    lastSeen: Date.now(),
    verifiedAt: Date.now(),
  };
  device.groupId = group.groupId || device.id;
  device.groupName = String(group.groupName || device.name).slice(0, 60);
  device.entryName = String(group.entryName || device.name).slice(0, 60);
  saveDevices([...listDevices(), device]);
  return { device, token };
}

export function entryPublicKey(value) {
  if (typeof value !== 'string' || value.length > 200) throw new Error('入口公钥无效，请刷新后重新申请');
  const key = crypto.createPublicKey({ key: Buffer.from(value, 'base64url'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('入口密钥必须使用 P-256');
  return key.export({ format: 'der', type: 'spki' }).toString('base64url');
}

export function findDevice(token) {
  if (!token) return null;
  const h = sha256(token);
  return listDevices().find(d => sameHash(d.tokenHash, h)) || null;
}

export function updateDevice(id, fields) {
  saveDevices(listDevices().map(d => d.id === id ? { ...d, ...fields } : d));
}

export function removeDevice(id) {
  const list = listDevices();
  saveDevices(list.filter(d => d.id !== id));
  revalidateConnections();
  return list.some(d => d.id === id);
}

// Entry credentials stay independent even when the user groups them as one device.
export function groupDevices(ids, groupId, name) {
  const list = listDevices();
  const target = list.find(d => (d.groupId || d.id) === groupId);
  if (groupId && !target) return false;
  const nextId = target ? groupId : crypto.randomBytes(8).toString('hex');
  const groupName = String(name || (target ? target.groupName || target.name : '')).trim().slice(0, 60);
  if (!groupName || !ids.length || ids.some(id => !list.some(d => d.id === id))) return false;
  saveDevices(list.map(d => ids.includes(d.id) ? { ...d, groupId: nextId, groupName } : d));
  return true;
}

const connections = new Set();
let authorizationTimer;
function revalidateConnections() {
  const devices = listDevices();
  for (const connection of connections) {
    const device = devices.find(d => d.id === connection.deviceId);
    if (device && !needsTotp(device)) continue;
    connection.valid = false;
    connection.release();
    connection.close();
  }
}
export function bindDeviceConnection(deviceId, close) {
  const connection = { deviceId, valid: true, close, release() {
    connections.delete(connection);
    if (!connections.size) {
      clearInterval(authorizationTimer); authorizationTimer = null;
      fs.unwatchFile(file('devices.json'), revalidateConnections);
    }
  } };
  connections.add(connection);
  if (!authorizationTimer) {
    // Observe CLI removals too; periodic checks also enforce an elapsed 2FA interval.
    fs.watchFile(file('devices.json'), { interval: 1000, persistent: false }, revalidateConnections);
    authorizationTimer = setInterval(revalidateConnections, 20000);
    authorizationTimer.unref();
  }
  revalidateConnections();
  return connection;
}

/* ---------- TOTP (RFC 6238) ---------- */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(buf) {
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

function unbase32(s) {
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function hotp(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
  const off = h[h.length - 1] & 15;
  return String((h.readUInt32BE(off) & 0x7fffffff) % 1e6).padStart(6, '0');
}

export const totpConfig = () => readJson('totp.json', null);
export const newTotpSecret = () => base32(crypto.randomBytes(20));
export const totpUri = (secret, label) =>
  `otpauth://totp/${encodeURIComponent('Remote Agent:' + label)}?secret=${secret}&issuer=${encodeURIComponent('Remote Agent')}`;

// Accepts the previous/current/next 30 s step; with `persist`, a step can't be used twice.
export function checkTotp(secret, code, persist = false) {
  code = String(code || '').replace(/\D/g, '');
  if (code.length !== 6) return false;
  const now = Math.floor(Date.now() / 30000);
  const cfg = persist ? totpConfig() : null;
  for (const step of [now - 1, now, now + 1]) {
    if (cfg && step <= (cfg.lastStep || 0)) continue;
    if (sameHash(hotp(secret, step), code)) {
      if (cfg) writeJson('totp.json', { ...cfg, lastStep: step });
      return true;
    }
  }
  return false;
}

export function verifyTotp(code) {
  const cfg = totpConfig();
  return Boolean(cfg && checkTotp(cfg.secret, code, true));
}

export function enableTotp(secret, everyDays) {
  writeJson('totp.json', { secret, everyDays, lastStep: 0, enabled: Date.now() });
  // Devices paired before 2FA was switched on count as verified now, rather than all being challenged at once.
  saveDevices(listDevices().map(d => ({ ...d, verifiedAt: Date.now() })));
}

export const disableTotp = () => fs.rmSync(file('totp.json'), { force: true });

export function needsTotp(device) {
  const cfg = totpConfig();
  if (!cfg || !device) return false;
  if (!cfg.everyDays) return false;
  return Date.now() - (device.verifiedAt || 0) > cfg.everyDays * 86400000;
}

/* ---------- relay state, for the CLI ---------- */

export const saveState = state => writeJson('state.json', { ...readJson('state.json', {}), ...state });
export const readState = () => readJson('state.json', {});
export const readConfig = () => readJson('config.json', {});

const lastSelections = readState().lastSelections || {};
export const lastSelection = () => lastSelections[computerId()] || null;
export function rememberSelection(selection) {
  const id = computerId();
  if (JSON.stringify(lastSelections[id]) === JSON.stringify(selection)) return;
  lastSelections[id] = selection;
  saveState({ lastSelections });
}

// Normalizes a configured app address: https only, forced trailing slash, or null.
export function normalizeAppUrl(u) {
  try {
    const url = new URL(String(u || '').trim());
    if (url.protocol !== 'https:') return null;
    url.hash = '';
    return url.href.replace(/\/?$/, '/');
  } catch { return null; }
}

// Where the phone app lives: a configured fixed address, the GitHub Pages copy if configured, else the relay itself.
export function appBase() {
  const cfg = readConfig();
  const fixed = normalizeAppUrl(cfg.appUrl);
  if (fixed) return fixed;
  const repo = cfg.publishRepo;
  if (repo) {
    const [owner, name] = repo.split('/');
    return `https://${owner.toLowerCase()}.github.io/${name}/`;
  }
  const s = readState();
  return s.relayUrl ? s.relayUrl.replace(/\/?$/, '/') : null;
}
