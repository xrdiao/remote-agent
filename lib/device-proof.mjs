import crypto from 'node:crypto';
import { computerId, findDevice } from './auth.mjs';

const used = new Map();
const bodyDigests = new WeakMap();
const WINDOW = 60000;
const emptyDigest = crypto.createHash('sha256').digest('base64url');
const signaturePattern = /^[A-Za-z0-9_-]{86}$/;
const publicKey = device => crypto.createPublicKey({ key: Buffer.from(device.publicKey, 'base64url'), format: 'der', type: 'spki' });
const verify = (key, payload, signature) => crypto.verify('sha256', Buffer.from(payload),
  { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));

export function authenticateDevice(token, proof, scope) {
  try {
    const device = findDevice(token), now = Date.now();
    if (!device || !Number.isSafeInteger(proof?.ts) || Math.abs(now - proof.ts) > WINDOW
        || !/^[A-Za-z0-9_-]{22}$/.test(proof.nonce || '') || !signaturePattern.test(proof.signature || '')) return null;
    for (const [key, expires] of used) if (expires <= now) used.delete(key);
    const replay = device.id + ':' + proof.nonce;
    if (used.has(replay)) return null;
    const payload = [proof.body ? 'ra-entry-v2' : 'ra-entry-v1', computerId(), token, scope, proof.ts, proof.nonce];
    if (proof.body) payload.push(proof.body);
    if (!verify(publicKey(device), payload.join('\n'), proof.signature)) return null;
    used.set(replay, proof.ts + WINDOW + 1);
    return device;
  } catch { return null; }
}
export function authenticateRequest(req) {
  try {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    const raw = req.headers['x-ra-proof'];
    if (typeof raw !== 'string' || raw.length > 512) return null;
    const proof = JSON.parse(Buffer.from(raw, 'base64url'));
    const writes = req.method !== 'GET' && req.method !== 'HEAD';
    // Older Android listeners use an empty POST to read the event stream.
    const legacyEvents = req.method === 'POST' && req.url === '/api/events' && proof?.body === undefined;
    if (writes && !legacyEvents && (typeof proof?.body !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(proof.body))) return null;
    const device = authenticateDevice(token, proof, req.method + ' ' + req.url);
    if (device && writes) bodyDigests.set(req, legacyEvents ? emptyDigest : proof.body);
    return device;
  } catch { return null; }
}

export function verifyBodyDigest(req, digest) {
  if (bodyDigests.get(req) !== digest) throw new Error('请求内容签名不匹配，请重试');
}

export function commandVerifier(device, scope) {
  const key = publicKey(device);
  const connection = crypto.randomBytes(16).toString('base64url');
  const prefix = ['ra-command-v1', scope, connection].join('\n') + '\n';
  let sequence = 0;
  return { connection, read(raw) {
    const frame = raw.toString('utf8');
    const separator = frame.indexOf('\n');
    if (separator < 88 || separator > 103) return null;
    const [number, signature] = frame.slice(0, separator).split('.');
    const next = sequence + 1;
    if (number !== String(next) || separator !== number.length + 87 || !signaturePattern.test(signature || '')) return null;
    const payload = frame.slice(separator + 1);
    if (!verify(key, prefix + number + '\n' + payload, signature)) return null;
    sequence = next;
    return JSON.parse(payload);
  } };
}
