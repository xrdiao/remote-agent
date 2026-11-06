import assert from 'node:assert/strict';
import test from 'node:test';
import { FusionScheduler } from '../server/fusion/scheduler.mjs';
const flush = () => new Promise(resolve => setImmediate(resolve));

test('one native Worker is sequential while another Worker in the same software remains parallel', async () => {
  const scheduler = new FusionScheduler(), started = [], release = {};
  const submit = (id, workerKey) => scheduler.submit({ runId: 'controller', app: 'codex', workerKey, ready: () => true,
    execute: () => { started.push(id); return new Promise(resolve => { release[id] = resolve; }); } });
  const first = submit('first', 'worker-one'), followup = submit('followup', 'worker-one'), independent = submit('independent', 'worker-two');
  await flush(); assert.deepEqual(started, ['first', 'independent']); assert.equal(scheduler.workerSlots.size, 2);
  release.first(); await first; await flush(); assert.deepEqual(started, ['first', 'independent', 'followup']);
  release.followup(); release.independent(); await Promise.all([followup, independent]); assert.equal(scheduler.workerSlots.size, 0);
});

test('independent jobs run concurrently regardless of software or project', async () => {
  const scheduler = new FusionScheduler(), started = [], finish = new Map();
  const job = (id, app, projectKey) => scheduler.submit({ runId: id, app, projectKey, access: 'read', ready: () => true,
    execute: () => { started.push(id); return new Promise(resolve => finish.set(id, resolve)); } });
  const first = job('one', 'cursor', 'p1'), second = job('two', 'cursor', 'p2'), third = job('three', 'codex', 'p1');
  await flush(); assert.deepEqual(started, ['one', 'two', 'three']);
  finish.get('one')(); finish.get('two')(); finish.get('three')(); await Promise.all([first, second, third]);
  assert.equal(scheduler.queue.length, 0);
});
test('the scheduler does not infer conflicts from project or write access', async () => {
  const scheduler = new FusionScheduler(), calls = [], release = {};
  const job = (id, app, access) => scheduler.submit({ runId: id, app, access, projectKey: 'same-project', ready: () => true,
    execute: () => { calls.push(id); return new Promise(resolve => { release[id] = resolve; }); } });
  const one = job('write1', 'cursor', 'write'), two = job('write2', 'codex', 'write'), read = job('read', 'devin', 'read');
  await flush(); assert.deepEqual(calls, ['write1', 'write2', 'read']);
  release.write1(); release.write2(); release.read(); await Promise.all([one, two, read]);
});
test('dependent jobs wait for acceptance and a cancelled run does not cancel another queue', async () => {
  const scheduler = new FusionScheduler(); let accepted = false, calls = 0;
  const job = scheduler.submit({ runId: 'dependent', app: 'cursor', access: 'read', projectKey: 'p', ready: () => accepted, execute: () => calls++ });
  const cancelled = scheduler.submit({ runId: 'cancel', app: 'codex', access: 'read', projectKey: 'p', ready: () => false, execute: () => assert.fail('cancelled job executed') });
  scheduler.cancel('cancel'); await assert.rejects(cancelled, /任务已取消/); assert.equal(calls, 0);
  accepted = true; scheduler.drain(); await job; assert.equal(calls, 1);
});
test('concurrent main project window requests share one native creation', async () => {
  const scheduler = new FusionScheduler(); let created = 0, release;
  const create = () => { created++; return new Promise(resolve => { release = resolve; }); };
  const one = scheduler.window('same-computer/app/host/project', create), two = scheduler.window('same-computer/app/host/project', create);
  assert.equal(one, two); await flush(); assert.equal(created, 1); release({ id: 'dedicated' });
  assert.equal(await one, await two); assert.equal(scheduler.creating.size, 0);
});
test('different software remains sequential when the main registers a dependency', async () => {
  const scheduler = new FusionScheduler(), started = []; let accepted = false, finish;
  const one = scheduler.submit({ runId: 'run', app: 'cursor', ready: () => true,
    execute: () => { started.push('screenshots'); return new Promise(resolve => { finish = resolve; }); } });
  const two = scheduler.submit({ runId: 'run', app: 'codex', ready: () => accepted, execute: () => started.push('readme') });
  await flush(); assert.deepEqual(started, ['screenshots']);
  finish(); await one; assert.deepEqual(started, ['screenshots']);
  accepted = true; scheduler.drain(); await two; assert.deepEqual(started, ['screenshots', 'readme']);
});

test('only the same main decision lane is sequential while independent workers and other mains can run', async () => {
  const scheduler = new FusionScheduler(), calls = [], release = {};
  const submit = (id, options) => scheduler.submit({ runId: 'controller', attemptId: id, app: 'codex', projectKey: 'project', ready: () => true,
    ...options, execute: () => { calls.push(id); return new Promise(resolve => { release[id] = resolve; }); } });
  const one = submit('write-a', {access:'write'}), main = submit('main', {lane:'main'});
  const two = submit('write-b', {access:'write'}), next = submit('main-next', {lane:'main'});
  const other = submit('other-main', {lane:'main', runId:'other'});
  await flush(); assert.deepEqual(calls, ['write-a','main','write-b','other-main']);
  release.main(); await main; await flush(); assert.equal(calls.at(-1), 'main-next');
  release['write-a'](); release['write-b'](); release['main-next'](); release['other-main']();
  await Promise.all([one,two,next,other]); assert.equal(scheduler.mainSlots.size, 0);
});
