import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { read, fragment } from './page-fixture.mjs';

const net = read('app/js/net.js');
const relay = 'https://relay-a.invalid';
const otherRelay = 'https://relay-b.invalid';
const code = 'n'.repeat(22);
const computer = { id: 'a'.repeat(16), key: 'k'.repeat(43), token: 'old-token', device: 'old-device', relay };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let n = 0; n < 30; n++) { if (predicate()) return; await tick(); }
  assert.fail('expected pairing state was not reached');
}

function backend({ twoFactor = false } = {}) {
  const devices = [{ id: computer.device }], batch = { id: 'batch', expires: Date.now() + 180000, groupId: 'group', groupName: 'phone' };
  const context = vm.createContext({ crypto, Date, Buffer,
    entryPublicKey: value => value, pairingSessionActive: id => id === batch.id,
    pairingSession: value => value === code ? batch : null,
    listDevices: () => devices, needsTotp: () => false, totpConfig: () => twoFactor,
    verifyTotp: value => value === '123456', updateDevice() {}, removeDevice() {},
    addDevice: () => { const device = { id: 'new-device' }; devices.push(device); return { token: 'new-token', device }; },
    clientIp: () => 'fixture', originAllowed: () => true, lockedOut: () => false, recordFailure() {},
    authenticateRequest: req => req.headers.authorization === 'Bearer old-token' ? devices[0] : null,
    readJson: async req => req.body,
    computerId: () => computer.id, computerName: () => 'Test computer', urlKey: () => Buffer.from(computer.key, 'base64url'),
    json: (_req, _res, status, body) => ({ status, ok: status < 400, json: async () => body }),
  });
  vm.runInContext(read('server/http/entries.mjs').replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), context);
  vm.runInContext(read('server/http/api.mjs').replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), context);
  return { context, batch, devices,
    request: (path, body, authenticated = true) => context.handleApi({ method: 'POST',
      headers: { origin: 'https://phone.invalid', ...(authenticated ? { authorization: 'Bearer old-token' } : {}) }, body }, {}, path),
    approve() { const rows = context.entryRequests(batch.id); context.decideEntries(batch.id, rows, true); },
  };
}

function frontend(server = backend()) {
  const trace = [], calls = [], timers = new Map(), storage = new Map();
  let timerId = 0, computers = [{ ...computer }], gateOpen = true;
  const context = vm.createContext({ URL, AbortController, AbortSignal, Date, JSON,
    pending: { key: computer.key, code, relay }, base: relay, info: { self: true }, connGen: 0,
    ws: null, authed: false, inApp: false, entryComputer: '',
    navigator: { userAgent: 'test', onLine: true }, location: { href: relay + '/', origin: relay },
    sessionStorage: { setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    store: { get: key => key === 'token' ? computer.token : null, set() {} },
    entryKey: async () => ({ publicKey: 'entry-public-key' }), entryName: () => 'Test phone',
    entryHeaders: async owner => owner?.token ? { authorization: 'Bearer ' + owner.token } : {},
    loadComputers: () => computers, currentComputer: () => computers[0], discoveryUrl: () => relay + '/url.json',
    saveComputers: list => { computers = list; }, computerIdFromKey: async () => computer.id,
    gate: state => { gateOpen = true; trace.push(state); },
    ungate: () => { gateOpen = false; }, showUnpaired: message => { gateOpen = true; trace.push({ error: message }); },
    showTotp: () => trace.push({ totp: true }),
    connect: async () => { gateOpen = false; trace.push({ connected: true }); },
    clearComputerRetry() {}, parkComputerSocket() {}, cancelConnectionWork() {},
    computerSockets: new Map(), computerBackgroundAt: null,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, opts = {}) => {
      const target = new URL(url), body = JSON.parse(opts.body || '{}');
      calls.push({ origin: target.origin, path: target.pathname, body, headers: opts.headers });
      if (target.pathname === '/url.json') return { ok: true, json: async () => ({ self: true }) };
      if (target.pathname === '/api/me') return { ok: true, json: async () => ({ id: computer.id }) };
      assert.equal(target.origin, relay, 'approval must stay on the creating relay');
      return server.request(target.pathname, body, opts.headers?.authorization === 'Bearer old-token');
    },
  });
  vm.runInContext(fragment(net, 'async function api(', '// Pairing links look like')
    + fragment(net, 'async function pastePair(', 'function showTotp(')
    + fragment(net, 'async function pair(', 'async function verifyTotp(')
    + fragment(net, 'let bootGeneration =', 'const computerSockets ='), context);
  context.warmComputerSockets = async () => {};
  return { context, server, trace, calls, storage, timers, get computers() { return computers; }, get gateOpen() { return gateOpen; },
    async waiting() { await until(() => trace.some(state => state.pairStatus?.state === 'waiting')); },
    poll() { for (const [id, timer] of timers) if (timer.ms === 2000) { timers.delete(id); timer.fn(); } },
    installConnectionGuards() {
      vm.runInContext(fragment(net, 'function reconnectComputer(', 'async function pair(')
        + fragment(net, 'function computerRetryAllowed(', 'function autoRetry(')
        + fragment(net, 'async function warmComputerSocket(', 'function rejectComputerConnection(')
        + fragment(net, 'let computerWarmup =', 'function resumeComputerConnections(')
        + net.slice(net.indexOf('async function connect(')), context);
    },
  };
}

test('a valid new code creates an approval even with valid old device credentials', async () => {
  const server = backend(), reply = await server.request('/api/pair', { code, publicKey: 'entry-public-key' });
  assert.equal(reply.status, 202);
  const body = await reply.json(); assert.equal(body.pending, true); assert.equal(body.token, undefined);
  assert.equal((await (await server.request('/api/entries/status', { id: body.id, secret: body.secret })).json()).state, 'pending');
  server.approve();
  assert.equal((await (await server.request('/api/entries/status', { id: body.id, secret: body.secret })).json()).token, 'new-token');
});

test('existing login without a new code remains available and an invalid supplied code is rejected', async () => {
  const server = backend();
  assert.equal((await (await server.request('/api/pair', {})).json()).token, 'old-token');
  assert.equal((await server.request('/api/pair', { code: 'invalid', publicKey: 'entry-public-key' })).status, 401);
  assert.equal(server.context.entryRequests(server.batch.id).length, 0);
});

test('new approval keeps the existing two-factor verification requirement', async () => {
  const server = backend({ twoFactor: true });
  const reply = await server.request('/api/pair', { code, publicKey: 'entry-public-key' }, false);
  assert.equal(reply.status, 401); assert.equal((await reply.json()).needTotp, true);
  assert.equal(server.context.entryRequests(server.batch.id).length, 0);
  assert.equal((await server.request('/api/pair', { code, publicKey: 'entry-public-key', totp: '123456' }, false)).status, 202);
});

test('approval polls use the returned request identity and original relay through approval', async () => {
  const h = frontend(), work = h.context.pair(); await h.waiting();
  const request = JSON.parse(h.storage.get('entry-request'));
  assert.equal(request.relay, relay); assert.notEqual(request.requestId, computer.id);
  assert.equal(h.gateOpen, true); assert.equal(h.trace.some(state => state.connected), false);
  h.context.base = otherRelay; h.server.approve(); h.poll(); await work;
  const polls = h.calls.filter(call => call.path === '/api/entries/status'); assert(polls.length >= 2);
  for (const call of polls) {
    assert.equal(call.origin, relay); assert.equal(call.body.id, request.requestId); assert.equal(call.body.secret, request.secret);
  }
  assert.equal(h.computers[0].token, 'new-token'); assert.equal(h.computers[0].relay, relay);
  assert.equal(h.context.base, relay); assert.equal(h.gateOpen, false);
  assert.equal(h.trace.filter(state => state.connected).length, 1);
});

test('new pairing blocks old foreground, background, manual and automatic reconnections', async () => {
  const h = frontend(); h.installConnectionGuards();
  assert.equal(h.context.computerRetryAllowed(computer), false);
  await h.context.connect(); await h.context.reconnectComputer(computer.id, 'manual');
  await h.context.reconnectComputer(computer.id, 'auto');
  await h.context.warmComputerSocket(computer); await h.context.warmComputerSockets();
  assert.equal(h.calls.length, 0); assert.equal(h.gateOpen, true);
  h.context.pending = null; assert.equal(h.context.computerRetryAllowed(computer), true);
});

test('a late response from an older pairing cannot replace the current request or gate', async () => {
  const h = frontend(); let resolve;
  h.context.fetch = () => new Promise(done => { resolve = done; });
  const work = h.context.pair(); await until(() => resolve);
  const current = h.context.pending = { key: 'different-key', code: 'next-code', relay: otherRelay };
  resolve({ ok: true, json: async () => ({ pending: true, id: 'old-request', secret: 'old-secret' }) });
  await work;
  assert.equal(h.context.pending, current); assert.equal(current.requestId, undefined);
  assert.equal(h.storage.has('entry-request'), false); assert.equal(h.trace.length, 1); assert.equal(h.gateOpen, true);
});

test('cancellation stays on the creating relay and prevents the old poll completing login', async () => {
  const h = frontend(), work = h.context.pair(); await h.waiting();
  const request = { ...h.context.pending }; h.context.base = otherRelay;
  h.trace.find(state => state.onRetry).onRetry(); await tick(); h.poll(); await work;
  const cancel = h.calls.find(call => call.path === '/api/entries/cancel');
  assert.equal(cancel.origin, relay); assert.equal(cancel.body.id, request.requestId); assert.equal(cancel.body.secret, request.secret);
  assert.equal(h.context.pending, null); assert.equal(h.computers[0].token, 'old-token');
  assert.equal(h.trace.some(state => state.connected), false);
});

test('retrying a waiting approval keeps its persisted relay and does not rediscover another one', async () => {
  const h = frontend(), original = h.context.pair(); await h.waiting();
  const request = { ...h.context.pending }; h.context.base = otherRelay;
  const resumed = h.context.boot(); await tick();
  assert.equal(h.calls.some(call => call.path === '/url.json'), false);
  h.server.approve(); h.poll(); await Promise.all([original, resumed]);
  for (const call of h.calls.filter(call => call.path === '/api/entries/status')) {
    assert.equal(call.origin, relay); assert.equal(call.body.id, request.requestId); assert.equal(call.body.secret, request.secret);
  }
  assert.equal(h.trace.filter(state => state.connected).length, 1);
});

test('manual code submission suspends the old connection before discovery completes', async () => {
  const h = frontend(), connect = h.context.connect; h.installConnectionGuards(); let resolveDiscovery;
  h.storage.set('entry-request', JSON.stringify({ requestId: 'previous', secret: 'previous-secret' }));
  const fetch = h.context.fetch; let discoveryCalls = 0, closes = 0;
  h.context.fetch = (...args) => String(args[0]).includes('/url.json') && discoveryCalls++ === 0
    ? new Promise(resolve => { resolveDiscovery = resolve; }) : fetch(...args);
  h.context.ws = { close() { closes++; h.context.reconnectComputer(computer.id, 'auto'); } };
  h.context.authed = true;
  const work = h.context.pastePair(computer.id + '.' + code);
  assert.equal(closes, 1); assert.equal(h.context.authed, false); assert.equal(h.context.ws, null);
  assert.equal(h.gateOpen, true); assert.equal(h.context.computerRetryAllowed(computer), false);
  assert.equal(h.storage.has('entry-request'), false);
  resolveDiscovery({ ok: true, json: async () => ({ self: true }) });
  await h.waiting(); h.context.connect = connect; h.server.approve(); h.poll(); await work;
  assert.equal(h.computers[0].token, 'new-token');
});
