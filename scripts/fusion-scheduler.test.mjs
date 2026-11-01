import assert from 'node:assert/strict';
import test from 'node:test';
import { FusionScheduler } from '../server/fusion/scheduler.mjs';
const flush = () => new Promise(resolve => setImmediate(resolve));

test('software slots are shared across projects while different software can run concurrently', async () => {
  const scheduler = new FusionScheduler(), started = [], finish = new Map();
  const job = (id, app, projectKey) => scheduler.submit({ runId: id, app, projectKey, access: 'read', ready: () => true,
    execute: () => { started.push(id); return new Promise(resolve => finish.set(id, resolve)); } });
  const first = job('one', 'cursor', 'p1'), second = job('two', 'cursor', 'p2'), third = job('three', 'codex', 'p1');
  await flush(); assert.deepEqual(started, ['one', 'three']);
  finish.get('one')(); await first; await flush(); assert.deepEqual(started, ['one', 'three', 'two']);
  finish.get('two')(); finish.get('three')(); await Promise.all([second, third]);
  assert.equal(scheduler.slots.size, 0);
});
test('one project writer excludes another writer while independent reads remain parallel', async () => {
  const scheduler = new FusionScheduler(), calls = [], release = {};
  const job = (id, app, access) => scheduler.submit({ runId: id, app, access, projectKey: 'same-project', ready: () => true,
    execute: () => { calls.push(id); return new Promise(resolve => { release[id] = resolve; }); } });
  const one = job('write1', 'cursor', 'write'), two = job('write2', 'codex', 'write'), read = job('read', 'devin', 'read');
  await flush(); assert.deepEqual(calls, ['write1', 'read']);
  release.write1(); await one; await flush(); assert.equal(calls.at(-1), 'write2');
  release.write2(); release.read(); await Promise.all([two, read]);
});
test('dependent jobs wait for acceptance and a cancelled run does not cancel another queue', async () => {
  const scheduler = new FusionScheduler(); let accepted = false, calls = 0;
  const job = scheduler.submit({ runId: 'dependent', app: 'cursor', access: 'read', projectKey: 'p', ready: () => accepted, execute: () => calls++ });
  const cancelled = scheduler.submit({ runId: 'cancel', app: 'codex', access: 'read', projectKey: 'p', ready: () => false, execute: () => assert.fail('cancelled job executed') });
  scheduler.cancel('cancel'); await assert.rejects(cancelled, /队列已取消/); assert.equal(calls, 0);
  accepted = true; scheduler.drain(); await job; assert.equal(calls, 1);
});
test('concurrent requests for the same dedicated window share one creation', async () => {
  const scheduler = new FusionScheduler(); let created = 0, release;
  const create = () => { created++; return new Promise(resolve => { release = resolve; }); };
  const one = scheduler.window('same-computer/app/host/project', create), two = scheduler.window('same-computer/app/host/project', create);
  assert.equal(one, two); await flush(); assert.equal(created, 1); release({ id: 'dedicated' });
  assert.equal(await one, await two); assert.equal(scheduler.creating.size, 0);
});
test('an unknown native write reserves its software and project until reconciliation', async () => {
  const scheduler = new FusionScheduler(), started = [];
  scheduler.uncertain.set('cursor', 'unknown'); scheduler.uncertainWriters.set('p', 'unknown');
  const run = (id, app) => scheduler.submit({ runId: id, attemptId: id, app, projectKey: 'p', access: 'write', ready: () => true, execute: () => { started.push(id); } });
  const other = run('other', 'codex'), reconciliation = run('unknown', 'cursor');
  await reconciliation; assert.deepEqual(started, ['unknown']);
  scheduler.uncertain.delete('cursor'); scheduler.uncertainWriters.delete('p'); scheduler.drain(); await other;
  assert.deepEqual(started, ['unknown', 'other']);
});
