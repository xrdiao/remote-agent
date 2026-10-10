// Device pairing, device tokens and optional TOTP (authenticator app); shared by the relay and the CLI scripts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const NEW_DIR = path.join(os.homedir(), '.agent-remote');
const OLD_DIR = path.join(os.homedir(), '.cursor-remote-lite');
function rankDir(dir) {
  if (!fs.existsSync(dir)) return -1;
  let n = 0;
  if (fs.existsSync(path.join(dir, 'devices.json'))) n += 100;
  if (fs.existsSync(path.join(dir, 'config.json'))) n += 10;
  if (fs.existsSync(path.join(dir, 'url-key'))) n += 1;
  return n;
}
function dataDir() {
  const nr = rankDir(NEW_DIR);
  const or = rankDir(OLD_DIR);
  if (nr > or) return NEW_DIR;
  if (or < 0) return NEW_DIR;
  if (nr < 0) {
    try { fs.renameSync(OLD_DIR, NEW_DIR); return NEW_DIR; } catch { return OLD_DIR; }
  }
  return OLD_DIR;
}
export const DATA_DIR = dataDir();
const PAIR_TTL = 10 * 60 * 1000;

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
  return { id: computerId(), name: computerName(), iv: slot.iv, data: slot.data, updated: slot.updated };
}

/* ---------- pairing ---------- */

// The link carries the url key and a one-time code in the #fragment, which browsers never send to any server.
export function createPairing(appBase) {
  const existing = readJson('pairing.json', null);
  const replacing = Boolean(existing && existing.expires > Date.now());
  const code = crypto.randomBytes(16).toString('base64url');
  writeJson('pairing.json', { hash: sha256(code), expires: Date.now() + PAIR_TTL });
  return { link: `${appBase}#pair=${urlKey().toString('base64url')}.${code}`, minutes: PAIR_TTL / 60000, replacing };
}

export function pairingValid(code) {
  const p = readJson('pairing.json', null);
  return Boolean(p && code && p.expires > Date.now() && sameHash(p.hash, sha256(code)));
}

export function consumePairing() {
  fs.rmSync(file('pairing.json'), { force: true });
}

/* ---------- devices ---------- */

export const listDevices = () => readJson('devices.json', []);
const saveDevices = list => writeJson('devices.json', list);

export function addDevice(name) {
  const token = crypto.randomBytes(32).toString('base64url');
  const device = {
    id: crypto.randomBytes(4).toString('hex'),
    name: String(name || '未命名设备').slice(0, 60),
    tokenHash: sha256(token),
    created: Date.now(),
    lastSeen: Date.now(),
    verifiedAt: Date.now(),
  };
  saveDevices([...listDevices(), device]);
  return { device, token };
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
  return list.some(d => d.id === id);
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
