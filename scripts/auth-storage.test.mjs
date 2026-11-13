import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../lib/auth.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');

function storage(initial = {}) {
  const files = new Map(Object.entries(initial)), errors = new Map(), writes = [], removedUploads = [];
  const context = vm.createContext({ path, Buffer, crypto, os: { homedir: () => '/fixture', hostname: () => 'fixture' },
    removeDeviceUploads: (root, id) => removedUploads.push({ root, id }),
    fs: {
      readFileSync(file) {
        const name = path.basename(file);
        if (errors.has(name)) throw Object.assign(new Error(errors.get(name)), { code: errors.get(name) });
        if (!files.has(name)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return files.get(name);
      },
      mkdirSync() {}, writeFileSync(file, value) { writes.push(path.basename(file)); files.set(path.basename(file), value); },
    },
  });
  vm.runInContext(source + '\nthis.api = { readState, saveState, readConfig, urlKey, computerId, listDevices, totpConfig, removeDevice };', context);
  return { ...context.api, files, errors, writes, removedUploads };
}

test('missing identity initializes once and subsequent reads preserve the same computer', () => {
  const h = storage(), key = h.urlKey(), id = h.computerId();
  assert.equal(key.length, 32); assert.deepEqual(h.urlKey(), key); assert.equal(h.computerId(), id);
  assert.deepEqual(h.writes, ['url-key']);
});

test('state initialization and normal updates preserve previously saved fields', () => {
  const h = storage(); assert.deepEqual(JSON.parse(JSON.stringify(h.readState())), {});
  h.saveState({ fusionRuns: { own: 1 }, entrySelections: { last: 'selection' } });
  h.saveState({ relayUrl: 'http://fixture' });
  assert.deepEqual(JSON.parse(h.files.get('state.json')), {
    fusionRuns: { own: 1 }, entrySelections: { last: 'selection' }, relayUrl: 'http://fixture',
  });
});

for (const code of ['EIO', 'EACCES']) {
  test(`a ${code} state read never overwrites the previous selections or Fusion data`, () => {
    const previous = JSON.stringify({ fusionRuns: { run: 'keep' }, entrySelections: { device: 'keep' } });
    const h = storage({ 'state.json': previous }); h.errors.set('state.json', code);
    assert.throws(() => h.saveState({ relayUrl: 'changed' }), { code });
    assert.equal(h.files.get('state.json'), previous); assert.equal(h.writes.length, 0);
  });

  test(`a ${code} identity read does not create or replace a key`, () => {
    const key = Buffer.alloc(32, 7).toString('base64url'), h = storage({ 'url-key': key }); h.errors.set('url-key', code);
    assert.throws(() => h.computerId(), { code }); assert.equal(h.files.get('url-key'), key); assert.equal(h.writes.length, 0);
  });
}

test('malformed state fails startup and malformed later state cannot be overwritten', () => {
  assert.throws(() => storage({ 'state.json': '{bad json' }), { name: 'SyntaxError' });
  const h = storage(); h.files.set('state.json', '{bad json');
  assert.throws(() => h.saveState({ relayUrl: 'changed' }), { name: 'SyntaxError' });
  assert.equal(h.files.get('state.json'), '{bad json'); assert.equal(h.writes.length, 0);
});

test('an existing invalid identity fails instead of silently replacing the computer', () => {
  const h = storage({ 'url-key': 'invalid' });
  assert.throws(() => h.urlKey(), /身份密钥无效/); assert.equal(h.files.get('url-key'), 'invalid'); assert.equal(h.writes.length, 0);
});

test('configuration, device and two-factor reads retain normal values and propagate read errors', () => {
  const h = storage({ 'config.json': '{"appUrl":"https://fixture.invalid"}', 'devices.json': '[{"id":"paired","publicKey":"fixture"}]', 'totp.json': '{"everyDays":7}' });
  assert.equal(h.readConfig().appUrl, 'https://fixture.invalid'); assert.equal(h.listDevices()[0].id, 'paired');
  assert.equal(h.totpConfig().everyDays, 7);
  for (const [file, read] of [['config.json', h.readConfig], ['devices.json', h.listDevices], ['totp.json', h.totpConfig]]) {
    h.errors.set(file, 'EACCES'); assert.throws(read, { code: 'EACCES' });
  }
  assert.equal(h.writes.length, 0);
});

test('all device removal callers share upload ownership cleanup', () => {
  const h = storage({ 'devices.json': '[{"id":"A","publicKey":"key-A"},{"id":"B","publicKey":"key-B"}]' });
  assert.equal(h.removeDevice('A'), true);
  assert.deepEqual(h.removedUploads, [{ root: '/fixture/.agent-remote/uploads', id: 'A' }]);
  assert.deepEqual(JSON.parse(h.files.get('devices.json')), [{ id: 'B', publicKey: 'key-B' }]);
});
