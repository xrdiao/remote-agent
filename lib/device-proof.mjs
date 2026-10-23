// Entry-key possession. TLS still protects request bodies and response content.
import crypto from 'node:crypto';
import { computerId, findDevice } from './auth.mjs';

const used = new Map();
const WINDOW = 60000;
export function authenticateDevice(token, proof, scope) {
  try {
    const device = findDevice(token), now = Date.now();
    if (!device || !Number.isSafeInteger(proof?.ts) || Math.abs(now - proof.ts) > WINDOW
        || !/^[A-Za-z0-9_-]{22}$/.test(proof.nonce || '') || !/^[A-Za-z0-9_-]{86}$/.test(proof.signature || '')) return null;
    for (const [key, expires] of used) if (expires <= now) used.delete(key);
    const replay = device.id + ':' + proof.nonce;
    if (used.has(replay)) return null;
    const payload = ['ra-entry-v1', computerId(), token, scope, proof.ts, proof.nonce].join('\n');
    const key = crypto.createPublicKey({ key: Buffer.from(device.publicKey, 'base64url'), format: 'der', type: 'spki' });
    if (!crypto.verify('sha256', Buffer.from(payload), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(proof.signature, 'base64url'))) return null;
    used.set(replay, proof.ts + WINDOW);
    return device;
  } catch { return null; }
}
export function authenticateRequest(req) {
  try {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    const raw = req.headers['x-ra-proof'];
    if (typeof raw !== 'string' || raw.length > 512) return null;
    return authenticateDevice(token, JSON.parse(Buffer.from(raw, 'base64url')), req.method + ' ' + req.url);
  } catch { return null; }
}
