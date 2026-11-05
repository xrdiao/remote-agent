import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
