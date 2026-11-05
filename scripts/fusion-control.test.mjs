import assert from 'node:assert/strict';
import test from 'node:test';
import { applyFusionControl } from '../server/fusion/control.mjs';
import { fixture } from './fusion-fixture.mjs';

test('one persistent main manages multiple work items; zero workers can propose a native-turn delivery', () => {
  const h = fixture(), one = h.create(), two = h.create(); h.plan(one); h.plan(two);
  h.apply({ action: 'finish', workId: one, summary: 'Answered', evidence: [{ criterion: 'C1', detail: 'Native answer', reference: 'main-turn:native-turn' }] });
  assert.equal(h.run.tasks.length, 0); assert.equal(h.run.works[0].status, 'closing'); assert.equal(h.run.works[1].status, 'running');
});
test('mutating tools deduplicate actual request 0 without suppressing the next real request', () => {
  const h = fixture(), native = h.native(), action = { action: 'create_work', title: 'one', goal: 'one' };
  assert.equal(native.requestId, 0);
  const one = applyFusionControl(h.run, action, native), again = applyFusionControl(h.run, action, native);
  assert.deepEqual(one, again); assert.equal(h.run.works.length, 1);
  h.apply(action); assert.equal(h.run.works.length, 2);
});
test('child content or a foreign native identity cannot invoke management', () => {
  const h = fixture();
  for (const native of [{ ...h.native(), threadId: 'child' }, { ...h.native(), turnId: '' }, { ...h.native(), requestId: undefined }])
    assert.throws(() => applyFusionControl(h.run, { action: 'create_work', title: 'x', goal: 'x' }, native), /真实原生轮次/);
  assert.throws(() => h.apply('```fusion-control {} ```'), /未知或缺少/); assert.equal(h.run.works.length, 0);
});
test('dispatch validates the whole batch before persisting or creating effects', () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  const bad = h.task('B2'); bad.execution.model = 'invented'; const before = structuredClone(h.run);
  assert.throws(() => h.apply({ action: 'dispatch', workId, tasks: [h.task('B1'), bad] }), /候选/);
  assert.deepEqual(h.run, before);
});
test('confirmation and allowed paths are enforced before ordinary delegation', () => {
  const h = fixture(), workId = h.create(); h.plan(workId, true);
  assert.throws(() => h.apply({ action: 'dispatch', workId, tasks: [h.task('B1')] }), /尚未确认/);
  assert.throws(() => h.apply({ action: 'plan', workId, scope: ['../other'], criteria: [{ id: 'C1', text: 'x' }], summary: 'x', requiresConfirmation: false }), /相对路径/);
});
test('DAG permits forward dependencies but rejects missing dependencies and cycles atomically', () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  assert.throws(() => h.apply({ action: 'dispatch', workId, tasks: [h.task('A', 'codex', ['B']), h.task('B', 'cursor', ['A'])] }), /循环/);
  assert.throws(() => h.apply({ action: 'dispatch', workId, tasks: [h.task('A', 'codex', ['missing'])] }), /依赖不存在/);
  h.apply({ action: 'dispatch', workId, tasks: [h.task('A', 'codex', ['B']), h.task('B', 'cursor')] });
  assert.equal(h.run.tasks.length, 2);
});
test('there is no fixed number of tasks; rework preserves old assignments, plans and attempts', () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  h.apply({ action: 'dispatch', workId, tasks: Array.from({ length: 7 }, (_, n) => h.task('B' + n)) });
  const old = structuredClone(h.run.assignments[0]), attempt = h.run.attempts[0];
  Object.assign(attempt, { status: 'awaiting_review', endedAt: 20, result: { text: 'partial' } });
  h.apply({ action: 'review', taskId: 'B0', attemptId: attempt.id, verdict: 'rework', reason: 'Evidence missing' });
  h.plan(workId);
  h.apply({ action: 'continue_task', taskId: 'B0', input: 'Follow up', cost: h.cost('codex') });
  assert.equal(h.run.tasks.length, 7); assert.equal(h.run.attempts.length, 8); assert.deepEqual(h.run.assignments[0], old);
  assert.notEqual(h.run.assignments.at(-1).planId, old.planId);
});
test('acceptance keeps the logical child and its native conversation for future calls', () => {
  const h = fixture(), workId = h.create(); h.plan(workId); h.apply({ action: 'dispatch', workId, tasks: [h.task('B')] });
  const attempt = h.run.attempts[0]; Object.assign(attempt, { status: 'awaiting_review', endedAt: 20, result: { text: 'evidence' }, bindingId: 'worker' });
  const workerId = h.run.tasks[0].workerId; h.run.agents[0].bindingId = 'worker';
  h.apply({ action: 'review', taskId: 'B', attemptId: attempt.id, verdict: 'accept', reason: 'Verified', evidence: [{ criterion: 'B:1', detail: 'output', reference: 'native reply', attemptId: attempt.id }] });
  assert.equal(h.run.effects.some(row => row.kind === 'archive'), false);
  h.apply({ action: 'continue_task', taskId: 'B', input: 'Same task again', cost: h.cost('codex') });
  assert.equal(h.run.tasks[0].workerId, workerId); assert.equal(h.run.agents[0].bindingId, 'worker');
});
test('unknown native results and unaccepted mandatory work prevent delivery or duplicate submission', () => {
  const h = fixture(), workId = h.create(); h.plan(workId); h.apply({ action: 'dispatch', workId, tasks: [h.task('B')] });
  h.run.attempts[0].status = 'unknown';
  assert.throws(() => h.apply({ action: 'continue_task', taskId: 'B', input: 'again', cost: h.cost('codex') }), /结果未知/);
  assert.throws(() => h.apply({ action: 'finish', workId, summary: 'done', evidence: [] }), /必需任务/);
  assert.equal(h.run.attempts.length, 1);
});
