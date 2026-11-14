import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { FusionStore } from '../server/fusion/store.mjs';
const directory = fileURLToPath(new URL('../_shots/fusion-store-test/', import.meta.url));
fs.mkdirSync(directory, { recursive: true });
test('snapshot replacement durably commits facts and effects together before updating the live controller', () => {
  const file = path.join(directory, `${process.pid}.json`); fs.rmSync(file, { force: true });
  const store = new FusionStore(file), controller = { id: 'c', deviceId: 'd', tasks: [], effects: [] };
  store.data.owners.d = { current: 'c', runs: [controller] };
  const next = { ...controller, tasks: [{ id: 'B' }], effects: [{ id: 'effect', kind: 'execute', status: 'pending' }] };
  store.replace(controller, next);
  const recovered = new FusionStore(file).data.owners.d.runs[0]; assert.deepEqual(recovered, next); assert.deepEqual(controller, next);
  assert.equal(fs.existsSync(file + '.pending'), false);
});
test('a failed durable write leaves the original live facts unchanged', () => {
  const store = new FusionStore(path.join(directory, 'memory.json'));
  const controller = { id: 'c', deviceId: 'd', tasks: [] }; store.data.owners.d = { runs: [controller] };
  store.write = () => { throw new Error('disk failure'); };
  assert.throws(() => store.replace(controller, { ...controller, tasks: [{ id: 'B' }] }), /disk failure/); assert.deepEqual(controller.tasks, []);
});

test('replacement removes omitted fields and keeps exported owners and controller references authoritative', () => {
  const file = path.join(directory, `${process.pid}-replace.json`); fs.rmSync(file, { force: true });
  const store = new FusionStore(file), controller = { id: 'c', deviceId: 'd', obsolete: 'remove', tasks: [] };
  const owners = store.data.owners; owners.d = { runs: [controller] };
  const next = { id: 'c', deviceId: 'd', tasks: [{ id: 'new' }] };
  store.replace(controller, next);
  assert.equal(store.data.owners, owners); assert.equal(owners.d.runs[0], controller);
  assert.equal(Object.hasOwn(controller, 'obsolete'), false);
  store.write(); assert.deepEqual(new FusionStore(file).data.owners.d.runs[0], next);
  fs.rmSync(file, { force: true });
});

test('replacement updates the stored entry even when the caller holds a separate controller object', () => {
  const file = path.join(directory, `${process.pid}-detached.json`); fs.rmSync(file, { force: true });
  const store = new FusionStore(file), controller = { id: 'c', deviceId: 'd', obsolete: true };
  store.data.owners.d = { runs: [{ ...controller }] };
  store.replace(controller, { id: 'c', deviceId: 'd', status: 'ready' });
  assert.equal(store.data.owners.d.runs[0], controller); store.write();
  assert.deepEqual(new FusionStore(file).data.owners.d.runs[0], controller);
  fs.rmSync(file, { force: true });
});

function replacementFixture(t, windows, rename) {
  const folder = fs.mkdtempSync(path.join(directory, 'replace-')), file = path.join(folder, 'fusion.json');
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const controller = { id: 'c', deviceId: 'd', tasks: [] };
  const initial = { version: 2, owners: { d: { runs: [controller] } } };
  fs.writeFileSync(file, JSON.stringify(initial));
  const source = fs.readFileSync(new URL('../server/fusion/store.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export const fusionStore =.*;\r?$/m, '').replace(/\bexport /g, '');
  const Store = vm.runInNewContext(source + '\nFusionStore;', {
    fs: { ...fs, renameSync: rename }, path, DATA_DIR: folder, IS_WIN: windows,
  });
  const store = new Store(file);
  store.data.owners.d.runs[0] = controller;
  return { store, controller, initial, file, next: { ...controller, tasks: [{ id: 'next' }] } };
}

test('a transient Windows replacement failure commits the pending snapshot before updating live facts', t => {
  let attempts = 0;
  const fixture = replacementFixture(t, true, (source, target) => {
    attempts++;
    assert.equal(source, fixture.file + '.pending'); assert.equal(target, fixture.file);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), fixture.initial);
    assert.deepEqual(fixture.controller.tasks, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(source, 'utf8')).owners.d.runs[0], fixture.next);
    if (attempts === 1) throw Object.assign(new Error('access denied'), { code: 'EPERM' });
    fs.renameSync(source, target);
  });
  fixture.store.replace(fixture.controller, fixture.next);
  assert.equal(attempts, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.file, 'utf8')).owners.d.runs[0], fixture.next);
  assert.deepEqual(fixture.controller, fixture.next);
  assert.equal(fixture.store.data.owners.d.runs[0], fixture.controller);
  assert.equal(fs.existsSync(fixture.file + '.pending'), false);
});

for (const { name, windows, code, attempts: expected } of [
  { name: 'persistent Windows EPERM', windows: true, code: 'EPERM', attempts: 2 },
  { name: 'other Windows IO errors', windows: true, code: 'EIO', attempts: 1 },
  { name: 'POSIX EPERM', windows: false, code: 'EPERM', attempts: 1 },
]) test(`${name} propagates without changing the previous snapshot or live facts`, t => {
  let attempts = 0;
  const error = Object.assign(new Error('replace failed'), { code });
  const fixture = replacementFixture(t, windows, () => { attempts++; throw error; });
  assert.throws(() => fixture.store.replace(fixture.controller, fixture.next), value => value === error);
  assert.equal(attempts, expected);
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.file, 'utf8')), fixture.initial);
  assert.deepEqual(fixture.controller.tasks, []);
  assert.equal(fixture.store.data.owners.d.runs[0], fixture.controller);
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.file + '.pending', 'utf8')).owners.d.runs[0], fixture.next);
});
