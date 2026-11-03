import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = fs.readFileSync(new URL('../server/http/ratelimit.mjs', import.meta.url), 'utf8').replace(/export /g, '');
const windowMs = 15 * 60 * 1000;
function limiter() {
  let now = 1_000_000;
  const logs = [];
  const api = vm.runInNewContext(source + '\n({lockedOut,recordFailure,clientIp,failures})', {
    Date: { now: () => now }, console: { log: message => logs.push(message) },
  });
  return { ...api, logs, advance(ms) { now += ms; } };
}

test('normal IP lookups do not retain empty failure records', () => {
  const h = limiter();
  for (let i = 0; i < 1000; i++) assert.equal(h.lockedOut('ip-' + i), false);
  assert.equal(h.failures.size, 0);
});

test('the fifth failure locks one IP without locking another below the global limit', () => {
  const h = limiter();
  for (let i = 0; i < 5; i++) { assert.equal(h.lockedOut('one'), false); h.recordFailure('one'); }
  assert.equal(h.lockedOut('one'), true);
  assert.equal(h.lockedOut('two'), false);
});

test('twenty failures across IPs retain the global limit', () => {
  const h = limiter();
  for (let i = 0; i < 20; i++) { assert.equal(h.lockedOut('ip-' + i), false); h.recordFailure('ip-' + i); }
  assert.equal(h.lockedOut('new-ip'), true);
  assert.equal(h.failures.has('new-ip'), false);
});

test('failures remain active until the exact fifteen minute boundary', () => {
  const h = limiter();
  for (let i = 0; i < 5; i++) h.recordFailure('one');
  h.advance(windowMs - 1);
  assert.equal(h.lockedOut('one'), true);
  h.advance(1);
  assert.equal(h.lockedOut('one'), false);
  assert.equal(h.failures.has('one'), false);
});

test('lazy cleanup removes expired IPs while retaining later failures and their limit', () => {
  const h = limiter();
  h.recordFailure('old');
  h.advance(windowMs / 2);
  for (let i = 0; i < 5; i++) h.recordFailure('active');
  h.advance(windowMs / 2);
  assert.equal(h.lockedOut('unused'), false);
  assert.equal(h.failures.has('old'), false);
  assert.equal(h.failures.size, 1);
  assert.equal(h.lockedOut('active'), true);
});

test('recording after expiry starts a fresh IP and global failure window', () => {
  const h = limiter();
  for (let i = 0; i < 5; i++) h.recordFailure('one');
  h.advance(windowMs);
  h.recordFailure('one');
  assert.equal(h.failures.get('one').length, 1);
  assert.equal(h.lockedOut('one'), false);
  assert(h.logs.at(-1).includes('本 IP 1 次，总计 1 次'));
});

test('repeated traffic windows release expired IP metadata without a background timer', () => {
  const h = limiter();
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 1000; i++) h.recordFailure(round + ':' + i);
    assert.equal(h.failures.size, 1000);
    h.advance(windowMs);
    assert.equal(h.lockedOut('probe'), false);
    assert.equal(h.failures.size, 0);
  }
});

test('client IP headers remain trusted only behind loopback', () => {
  const h = limiter();
  for (const remote of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(h.clientIp({ socket: { remoteAddress: remote }, headers: { 'cf-connecting-ip': 'fixture-client' } }), 'fixture-client');
  }
  assert.equal(h.clientIp({ socket: { remoteAddress: '192.0.2.1' }, headers: { 'cf-connecting-ip': 'untrusted' } }), '192.0.2.1');
});
