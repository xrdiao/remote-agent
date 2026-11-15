import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { notificationTarget, notificationKey } from '../lib/shared-rules.mjs';
import { uploads, removeUpload, registerUpload, updateUpload, initializeUploads, removeDeviceUploads } from '../lib/uploads.mjs';
import { read, fragment, createPageContext } from './page-fixture.mjs';
import { gitBlobSha } from '../server/publish/pages.mjs';

test('import scanner recognizes browser methods and still reports missing bare calls', () => {
  const scanner = fragment(read('scripts/check.mjs'), 'function stripCode(', '/* 5. app-shell');
  const modules = ['client', 'composer', 'connection', 'conversation', 'models', 'overview', 'questions', 'sessions']
    .map(name => `scripts/browser-tests/blocks/${name}.mjs`);
  modules.push('scripts/browser-tests/browser.mjs', 'server/publish/pages.mjs', 'scripts/page-fixture.mjs');
  const failures = [];
  const run = (modFiles, fileSystem) => vm.runInNewContext(scanner, {
    fs: fileSystem, modFiles, fail: message => failures.push(message), rel: file => file, console: { log() {} },
  });
  run(modules, fs);
  assert.deepEqual(failures, []);
  const files = {
    'exports.mjs': 'export function run() {} export function read() {} export function x11ActiveWindow() {}',
    'bound.mjs': 'import { x11ActiveWindow } from "./exports.mjs"; x11ActiveWindow(); const pattern = /^file:\\/\\//; function read() {} read(); const ratio = 4 / 2;',
    'missing.mjs': 'run(); read();',
  };
  run(Object.keys(files), { readFileSync: file => files[file] });
  assert.deepEqual(failures, ['missing imports: missing.mjs: read, run']);
});

test('Live Activity forwarding retains every required Swift attribute, including the computer identity', () => {
  const source = read('push-service/index.mjs');
  const fields = fragment(source, 'const cut =', 'async function register(')
    + fragment(source, 'function liveFields(', '\nasync function live(');
  const context = vm.createContext();
  vm.runInContext(fields + ';this.convert=liveFields;', context);
  const attributes = { computer: 'computer-A', win: 'codex', windowId: 'window-A', threadId: 'thread-A', app: 'Codex', project: '/project', thread: 'Thread', pc: 'Computer' };
  const result = context.convert({ attributes, state: {} }, 100);
  assert.deepEqual(JSON.parse(JSON.stringify(result.attributes)), attributes);
  const swift = read('ios/Shared/AgentActivityAttributes.swift').split('var computer:')[1].split('var key:')[0];
  const required = ['computer', ...[...swift.matchAll(/(\w+): String/g)].map(match => match[1])];
  assert.deepEqual(required.sort(), Object.keys(result.attributes).sort());
  assert.equal(notificationKey(result.attributes), 'computer-A|codex|window-A|thread-A');
  assert.deepEqual(notificationTarget(result.attributes), notificationTarget(attributes));
  assert.notEqual(notificationKey({ ...attributes, computer: 'computer-B' }), notificationKey(attributes));
});

test('removing a staged upload deletes its UUID directory and preserves adjacent uploads', () => {
  fs.mkdirSync('_shots', { recursive: true });
  const root = fs.mkdtempSync('_shots/upload-lifecycle-');
  const own = path.join(root, 'own'), other = path.join(root, 'other');
  fs.mkdirSync(own); fs.mkdirSync(other);
  fs.writeFileSync(path.join(own, 'image.png'), 'sample');
  fs.writeFileSync(path.join(other, 'keep.txt'), 'keep');
  uploads.set('contract-own', { path: path.join(own, 'image.png') });
  try {
    removeUpload('contract-own');
    assert.equal(fs.existsSync(own), false);
    assert.equal(uploads.has('contract-own'), false);
    assert.equal(fs.readFileSync(path.join(other, 'keep.txt'), 'utf8'), 'keep');
  } finally { uploads.delete('contract-own'); fs.rmSync(root, { recursive: true, force: true }); }
});

test('upload restart restores committed resources and reclaims only registered incomplete or revoked uploads', () => {
  const root = fs.mkdtempSync('_shots/upload-restart-');
  const add = (id, deviceId, complete) => {
    const file = { name: 'sample.txt', path: path.join(root, id, 'sample.txt'), deviceId, sel: 'scope', pending: true, complete: false };
    registerUpload(root, id, file); fs.writeFileSync(file.path, id);
    if (complete) updateUpload(file, { complete: true, size: id.length });
    return file;
  };
  try {
    const kept = add('committed', 'paired', true); updateUpload(kept, { pending: false });
    add('incomplete', 'paired', false); add('revoked', 'removed', true);
    const legacy = path.join(root, 'legacy'); fs.mkdirSync(legacy); fs.writeFileSync(path.join(legacy, 'keep.txt'), 'legacy');
    uploads.clear();
    assert.deepEqual(initializeUploads(root, ['paired']), [legacy]);
    assert.equal(uploads.get('committed').pending, false); assert.equal(fs.readFileSync(kept.path, 'utf8'), 'committed');
    assert.equal(fs.existsSync(path.join(root, 'incomplete')), false); assert.equal(fs.existsSync(path.join(root, 'revoked.json')), false);
    assert.equal(fs.existsSync(path.join(legacy, 'keep.txt')), true);
  } finally { uploads.clear(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('device upload removal cancels in-flight requests and also reads ownership in a fresh process map', () => {
  const root = fs.mkdtempSync('_shots/upload-device-'); let cancelled = 0;
  const add = (id, deviceId) => { const file = { name: 'file.txt', path: path.join(root, id, 'file.txt'), deviceId, pending: true, complete: false };
    registerUpload(root, id, file); return file; };
  try {
    add('own', 'A').request = { destroy() { cancelled++; } }; add('other', 'B');
    removeDeviceUploads(root, 'A'); assert.equal(cancelled, 1); assert.equal(fs.existsSync(path.join(root, 'own')), false);
    uploads.clear(); removeDeviceUploads(root, 'B');
    assert.equal(fs.existsSync(path.join(root, 'other')), false); assert.equal(fs.existsSync(path.join(root, 'other.json')), false);
  } finally { uploads.clear(); fs.rmSync(root, { recursive: true, force: true }); }
});

for (const revoked of [false, true]) test(`HTTP upload persists completion and cannot finish after device removal: revoked=${revoked}`, async () => {
  const root = fs.mkdtempSync('_shots/http-upload-'), id = 'http-document', req = new PassThrough();
  req.url = '/api/upload?name=sample.txt&sel=scope'; req.method = 'POST';
  const context = createPageContext({ fs, path, URL, Buffer, DATA_DIR: root, crypto: { randomUUID: () => id },
    registerUpload, updateUpload, removeUpload, uploads, uploadDocument: () => true,
    json: (_req, _res, status, body) => ({ status, body }), imageTypes: {} });
  const source = fragment(read('server/http/api.mjs'), "  if (route === '/api/upload' &&", "  if (route === '/api/devices')");
  vm.runInContext(`this.upload=async (req) => { const route='/api/upload',res={},device={id:'paired'};${source}};`, context);
  try {
    const pending = context.upload(req); req.write('document');
    assert.equal(uploads.get(id).request, req); assert.equal(uploads.get(id).complete, false);
    if (revoked) removeDeviceUploads(path.join(root, 'uploads'), 'paired'); else req.end();
    const result = await pending;
    assert.equal(result.status, revoked ? 400 : 200);
    const directory = path.join(root, 'uploads', id), metadata = directory + '.json';
    if (revoked) {
      assert.equal(uploads.has(id), false); assert.equal(fs.existsSync(directory), false); assert.equal(fs.existsSync(metadata), false);
    } else {
      assert.equal(fs.readFileSync(path.join(directory, 'sample.txt'), 'utf8'), 'document');
      assert.equal(JSON.parse(fs.readFileSync(metadata)).complete, true); assert.equal(uploads.get(id).request, undefined);
    }
  } finally { req.destroy(); uploads.clear(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('Pages migration uses the real local identity and never invents another computer identity from ciphertext', () => {
  const context = vm.createContext({ opensEntry: entry => entry.data === 'own' });
  vm.runInContext(fragment(read('server/publish/pages.mjs'), 'function registryWith(', '// Writes this computer') + ';this.merge=registryWith;', context);
  const mine = { id: 'real-id', iv: 'iv', data: 'own' };
  assert.equal(context.merge({ v: 2, iv: 'iv', data: 'own' }, mine).computers[0].id, 'real-id');
  const foreign = { v: 2, iv: 'iv', data: 'foreign' };
  assert.throws(() => context.merge(foreign, mine), /原电脑发布 v3/); assert.equal(foreign.data, 'foreign');
  const others = { id: 'other-id', iv: 'iv', data: 'foreign' };
  const merged = context.merge({ v: 3, computers: [others, mine] }, { ...mine, data: 'fresh' });
  assert.deepEqual(Array.from(merged.computers, row => row.id), ['other-id', 'real-id']);
  assert.equal(merged.computers[0], others); assert.equal(merged.computers[1].data, 'fresh');
});

test('Pages sync uses the selected repository and branch, uploading changed files in one tree commit', async () => {
  const calls = [];
  const context = vm.createContext({ fs, path, APP_DIR: path.resolve('app'), gitBlobSha,
    appFiles: () => ['index.html', 'js/core.js'], PUBLISH_REPO: 'unused/default', PAGES_BRANCH: 'unused',
    console: { log() {} },
    run: async (command, args, input) => {
      const route = args.find(value => value.startsWith('repos/')), body = input && JSON.parse(input);
      calls.push({ command, route, args, body });
      if (route.endsWith('/git/ref/heads/qa-branch')) return JSON.stringify({ object: { sha: 'head' } });
      if (route.endsWith('/git/commits/head')) return JSON.stringify({ tree: { sha: 'old-tree' } });
      if (route.endsWith('/git/trees/old-tree?recursive=1')) return JSON.stringify({ tree: [{ path: 'index.html', sha: gitBlobSha(fs.readFileSync('app/index.html')) }] });
      if (route.endsWith('/git/blobs')) return JSON.stringify({ sha: 'new-blob' });
      if (route.endsWith('/git/trees')) return JSON.stringify({ sha: 'new-tree' });
      if (route.endsWith('/git/commits')) return JSON.stringify({ sha: 'new-commit' });
      if (route.endsWith('/git/refs/heads/qa-branch')) return '{}';
      throw new Error('unexpected GitHub route: ' + route);
    },
  });
  vm.runInContext(fragment(read('server/publish/pages.mjs'), 'export async function syncApp(', '\nasync function readUrlDoc(').replace('export ', '') + ';this.sync=syncApp;', context);
  await context.sync(undefined, 'qa/selected', 'qa-branch');
  assert(calls.every(call => call.route.startsWith('repos/qa/selected/')));
  assert.equal(calls.filter(call => call.route.endsWith('/git/blobs')).length, 1);
  const tree = calls.find(call => call.route.endsWith('/git/trees')).body;
  assert.deepEqual(JSON.parse(JSON.stringify(tree.tree.map(row => row.path))), ['js/core.js']);
  assert.equal(tree.base_tree, 'old-tree');
  assert.equal(calls.filter(call => call.route.endsWith('/git/commits')).length, 1);
  assert.equal(calls.at(-1).body.sha, 'new-commit');
});

function pushBrowser() {
  let computer = { id: 'A', key: 'computer-A' }, beforeKey;
  const records = new Map([['A', { key: 'AQ', subscribed: false, enabled: false }], ['B', { key: 'Ag', subscribed: false, enabled: false }]]);
  const registrations = [], posts = [], calls = [], messages = [];
  const scope = id => `https://qa.example/app/push/${id}/`;
  const subscription = (reg, key) => ({ endpoint: 'https://push.example/' + reg.scope.split('/').at(-2) + '/' + key,
    options: { applicationServerKey: Uint8Array.from(Buffer.from(key, 'base64url')).buffer },
    async unsubscribe() { calls.push(['unsubscribe', reg.scope]); reg.sub = null; return true; },
    toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'public', auth: 'auth' } }; },
  });
  const serviceWorker = { getRegistrations: async () => registrations, async register(script, options) {
    calls.push(['register', script, options.scope]);
    let reg = registrations.find(r => r.scope === options.scope);
    if (!reg) {
      reg = { scope: options.scope, active: {}, pushManager: {
        getSubscription: async () => reg.sub,
        subscribe: async options => (reg.sub = subscription(reg, Buffer.from(options.applicationServerKey).toString('base64url'))),
      } };
      registrations.push(reg);
    }
    return reg;
  } };
  const context = vm.createContext({ window: { isSecureContext: true, PushManager: {}, Notification: {}, agentRemoteServiceWorker: Promise.resolve({}) },
    navigator: { serviceWorker }, Notification: { permission: 'granted' }, location: { href: 'https://qa.example/app/' }, URL, APP_VERSION: 'v478', inApp: false,
    currentComputer: () => computer, b64u: key => Uint8Array.from(Buffer.from(key, 'base64url')),
    api: async route => { const record = records.get(computer.id); if (route === '/api/push/key') await beforeKey?.(); return { ok: true, json: async () => ({ ...record }) }; },
    post: async (route, body) => { posts.push({ computer: computer.id, route, body }); const record = records.get(computer.id);
      Object.assign(record, route === '/api/push/subscribe' ? { endpoint: body.sub.endpoint, subscriptionKey: body.applicationServerKey, subscribed: true, enabled: true } : { enabled: body.enabled });
      return { ok: true }; }, status: (...args) => messages.push(args), $: () => null, setTimeout,
  });
  vm.runInContext(fragment(read('app/js/notify.js'), '/* ---------- notifications', 'function noticeTarget(')
    + ';this.notify={enable:enableNotify,sync:syncNotify,disable:disableNotify,state:()=>({on:notifyOn,subscribed:notifySubscribed})};', context);
  return { api: context.notify, records, registrations, posts, calls, messages, scope, subscription,
    select(id) { computer = { id, key: 'computer-' + id }; }, waitForKey(fn) { beforeKey = fn; } };
}

test('Web Push subscriptions isolate computers and replace only the selected computer mismatched key', async () => {
  const h = pushBrowser();
  const legacy = { scope: 'https://qa.example/app/', pushManager: { getSubscription() { assert.fail('must not reuse the app-wide subscription'); } } };
  h.registrations.push(legacy);
  await h.api.enable(); h.select('B'); await h.api.enable();
  assert.deepEqual(h.posts.map(row => [row.computer, row.body.applicationServerKey]), [['A', 'AQ'], ['B', 'Ag']]);
  assert(h.registrations.some(row => row.scope === h.scope('A'))); assert(h.registrations.some(row => row.scope === h.scope('B')));
  h.select('A'); h.records.get('A').key = 'Aw'; await h.api.sync(); assert.equal(h.api.state().on, false);
  await h.api.enable(); assert.deepEqual(h.calls.filter(row => row[0] === 'unsubscribe'), [['unsubscribe', h.scope('A')]]);
  assert.equal(h.registrations.find(row => row.scope === h.scope('B')).sub.endpoint.endsWith('/Ag'), true);
  assert.equal(h.posts.at(-1).body.applicationServerKey, 'Aw');
});

test('Web Push state checks the actual endpoint and key; reopening preserves a disabled subscription', async () => {
  const h = pushBrowser(); await h.api.enable(); await h.api.sync(); assert.equal(h.api.state().on, true);
  h.records.get('A').endpoint = 'https://push.example/stale'; await h.api.sync(); assert.equal(h.api.state().on, false);
  await h.api.enable(); await h.api.disable(); await h.api.sync();
  assert.equal(h.api.state().on, false); assert.equal(h.api.state().subscribed, true);
  assert.equal(h.calls.some(row => row[0] === 'unsubscribe'), false);
  assert.equal(h.posts.filter(row => row.route === '/api/push/subscribe').length, 2);
});

test('a Web Push enable completing after computer selection changes cannot register with the new relay', async () => {
  const h = pushBrowser(); let resolve;
  h.waitForKey(() => new Promise(done => { resolve = done; }));
  const pending = h.api.enable(); h.select('B'); resolve(); await pending;
  assert.equal(h.posts.length, 0); assert.equal(h.registrations.length, 0);
});

test('push subscription routes reject a foreign public key and report the registered endpoint and key', async () => {
  const updates = [], body = {}, context = { pushPublicKey: () => 'current-key', readJson: async () => body,
    json: (_req, _res, status, value) => ({ status, value }), updateDevice: (_id, value) => updates.push(value) };
  const route = vm.runInNewContext('(async(req,res,route,device)=>{' + fragment(read('server/http/api.mjs'), "  if (route === '/api/push/key')", "  if (route === '/api/push/apns'") + '})', context);
  body.sub = { endpoint: 'https://push.example/own', keys: { p256dh: 'public', auth: 'auth' } }; body.applicationServerKey = 'foreign-key';
  assert.equal((await route({ method: 'POST' }, {}, '/api/push/subscribe', { id: 'A' })).status, 409); assert.equal(updates.length, 0);
  body.applicationServerKey = 'current-key';
  assert.equal((await route({ method: 'POST' }, {}, '/api/push/subscribe', { id: 'A' })).status, 200);
  assert.equal(updates[0].pushKey, 'current-key');
  const device = { id: 'A', ...updates[0] }, state = await route({ method: 'GET' }, {}, '/api/push/state', device);
  assert.equal(state.value.endpoint, body.sub.endpoint); assert.equal(state.value.subscriptionKey, 'current-key');
  const old = await route({ method: 'GET' }, {}, '/api/push/state', { ...device, pushKey: 'old' });
  assert.equal(old.value.subscribed, false); assert.equal(old.value.enabled, false);
  body.enabled = true;
  assert.equal((await route({ method: 'POST' }, {}, '/api/push/state', { ...device, pushKey: 'old' })).status, 409);
  assert.equal((await route({ method: 'POST' }, {}, '/api/push/state', { id: 'A', apns: {} })).status, 200);
});

for (const changed of [false, true]) test(`VAPID mismatch invalidates only its original subscription (replaced=${changed})`, async () => {
  const device = { id: 'A', name: 'Test', lastSeen: Date.now(), push: { endpoint: 'https://push.example/old' }, pushKey: 'old-key' }, updates = [];
  const context = vm.createContext({ DATA_DIR: '.', path, computerId: () => 'computer-A', listDevices: () => [device],
    updateDevice: (_id, value) => updates.push(value), console: { log() {} }, webpush: { async sendNotification() {
      if (changed) device.push = { endpoint: 'https://push.example/new' };
      throw { statusCode: 400, body: '{"reason":"VapidPkHashMismatch"}' };
    } } });
  vm.runInContext(fragment(read('lib/notify.mjs'), 'const POLL_MS =', '/* ---------- Web Push keys')
    + fragment(read('lib/notify.mjs'), 'const streams =', '// The push service signs').replace(/^export /gm, '') + ';this.deliver=deliver;this.settle=()=>Promise.all([...pushChains.values()]);', context);
  await context.deliver({ kind: 'test', win: '', title: 'Test', body: 'Test' }, 'A'); await context.settle();
  assert.equal(updates.length, changed ? 0 : 1);
  if (!changed) assert.deepEqual(JSON.parse(JSON.stringify(updates[0])), { push: null, pushKey: null });
});

test('per-computer push worker keeps notification clicks on the app entry and preserves target identity', async () => {
  const handlers = new Map(), opened = [], shown = [], cache = new Map(), target = { computer: 'A', win: 'codex', windowId: 'desktop', threadId: 'thread-A' };
  const self = { location: { href: 'https://qa.example/app/push-sw.js?v=478' }, registration: { scope: 'https://qa.example/app/push/A/', showNotification: async (title, options) => shown.push({ title, options }) },
    addEventListener: (name, handler) => handlers.set(name, handler), clients: { matchAll: async () => [], openWindow: async url => opened.push(url) } };
  vm.runInNewContext(read('app/push-sw.js'), { self, URL, Response, importScripts() {}, RemoteAgentRules: { notificationTarget, notificationKey },
    caches: { open: async () => ({ match: async key => cache.get(key), put: async (key, value) => cache.set(key, value) }) } });
  let pending;
  handlers.get('push')({ data: { text: () => JSON.stringify({ ...target, kind: 'done', title: 'Done', seq: 1 }) }, waitUntil: value => { pending = value; } }); await pending;
  assert.deepEqual(shown[0].options.data.computer, 'A'); assert.equal(shown[0].options.icon, 'https://qa.example/app/icon-192.png');
  handlers.get('notificationclick')({ notification: { data: shown[0].options.data, close() {} }, waitUntil: value => { pending = value; } }); await pending;
  assert.equal(new URL(opened[0]).pathname, '/app/'); assert.deepEqual(JSON.parse(decodeURIComponent(new URL(opened[0]).hash.slice(5))), target);
});
