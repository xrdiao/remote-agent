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
