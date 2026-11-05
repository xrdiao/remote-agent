import assert from 'node:assert/strict';
import test from 'node:test';
import { FusionRunner } from '../server/fusion/runner.mjs';
import { FusionScheduler } from '../server/fusion/scheduler.mjs';
import { fusionEvent } from '../server/fusion/state.mjs';
import { fixture, flush } from './fusion-fixture.mjs';
function scenario() {
  const h = fixture(), scheduler = new FusionScheduler(), calls = [], pending = new Map(), stops = [];
  const agent = { async execute(run, id, prompt, recovering) {
    const attempt = run.attempts.find(row => row.id === id);
    calls.push({ id, kind: attempt.kind, prompt, recovering });
    attempt.status = 'running'; attempt.submission = 'accepted'; attempt.acceptedAt ||= Date.now();
    attempt.native ||= { threadId: attempt.kind === 'main' ? 'main-thread' : id, turnId: id, messageId: id };
    return new Promise((resolve, reject) => pending.set(id, { resolve: result => resolve({ text: 'native evidence', completed: true, native: attempt.native, ...result }), reject }));
  }, async stop(id) { stops.push(id); } };
  const controller = { async start() {}, async idle() { return true; }, async stop(attempt) { stops.push(attempt.id); } };
  const runner = new FusionRunner(h.run, { scheduler, agent, controller });
  return { ...h, runner, agent, scheduler, controller, calls, pending, stops };
}
test('a same-software child does not occupy the main controller lane', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId);
  await h.runner.control({ action: 'dispatch', workId, tasks: [h.task('B')] }, h.native()); await flush();
  assert.equal(h.calls[0].kind, 'task');
  fusionEvent(h.run, 'user_input', { workId, text: 'follow up' }, 'followup'); h.runner.wake(); await flush();
  assert.deepEqual(h.calls.map(row => row.kind), ['task', 'main']);
  assert.equal(h.scheduler.slots.size, 1); assert.equal(h.scheduler.mainSlots.size, 1);
  h.pending.get(h.calls[1].id).resolve(); h.pending.get(h.calls[0].id).resolve(); await flush();
});
test('no pending events means no main model call; arrivals during a turn form one next batch', async () => {
  const h = scenario(); h.runner.wake(); await flush(); assert.equal(h.calls.length, 0);
  fusionEvent(h.run, 'user_input', { text: 'one' }, 'one'); h.runner.wake(); await flush();
  const first = h.calls[0];
  fusionEvent(h.run, 'task_result', { taskId: 'B' }, 'two'); fusionEvent(h.run, 'user_input', { text: 'three' }, 'three');
  h.runner.wake(); await flush(); assert.equal(h.calls.length, 1);
  h.pending.get(first.id).resolve(); await flush(); assert.equal(h.calls.length, 2);
  const second = h.run.attempts.find(row => row.id === h.calls[1].id); assert.deepEqual(second.eventIds, ['two', 'three']);
  h.pending.get(second.id).resolve(); await flush(); h.runner.wake(); await flush(); assert.equal(h.calls.length, 2);
});
test('dependent tasks wait for actual acceptance, not just generation completion', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId);
  h.run.status = 'blocked';
  await h.runner.control({ action: 'dispatch', workId, tasks: [h.task('A'), h.task('B', 'cursor', ['A'])] }, h.native()); await flush();
  const first = h.calls[0]; h.pending.get(first.id).resolve(); await flush(); assert.equal(h.calls.length, 1);
  await h.runner.control({ action: 'review', taskId: 'A', attemptId: first.id, verdict: 'accept', reason: 'verified',
    evidence: [{ criterion: 'A:1', detail: 'actual result', reference: 'native', attemptId: first.id }] }, h.native()); await flush();
  assert.equal(h.calls.length, 2); assert.equal(h.run.attempts.find(row => row.id === h.calls[1].id).taskId, 'B');
  h.pending.get(h.calls[1].id).resolve(); await flush();
});
test('stop cancels unsubmitted dependents and remains stopping until exact native execution ends', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId);
  await h.runner.control({ action: 'dispatch', workId, tasks: [h.task('A'), h.task('B', 'cursor', ['A'])] }, h.native()); await flush();
  const first = h.calls[0]; await h.runner.stop(); await flush();
  assert.equal(h.run.status, 'stopping'); assert.deepEqual(h.stops, [first.id]); assert.equal(h.run.tasks[1].status, 'cancelled');
  h.pending.get(first.id).resolve({ stopped: true, completed: false }); await flush();
  assert.equal(h.run.status, 'stopped'); assert.equal(h.calls.length, 1);
});
test('stopping one work item leaves another work item and its actual native target alone', async () => {
  const h = scenario(), a = h.create(), b = h.create(); h.plan(a); h.plan(b);
  await h.runner.control({ action: 'dispatch', workId: a, tasks: [h.task('A')] }, h.native());
  await h.runner.control({ action: 'dispatch', workId: b, tasks: [h.task('B', 'cursor')] }, h.native()); await flush();
  await h.runner.stop({ workId: a }); assert.equal(h.run.stopRequested, false); assert.equal(h.stops.length, 1);
  const first = h.run.attempts.find(row => row.workId === a), second = h.run.attempts.find(row => row.workId === b);
  assert.equal(second.status, 'running'); assert.deepEqual(h.stops, [first.id]);
  h.run.status = 'blocked'; h.pending.get(first.id).resolve({ stopped: true }); h.pending.get(second.id).resolve(); await flush();
});
test('unknown attempts reserve the software and recover the same attempt without a second prompt submission', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId); h.run.status = 'blocked';
  await h.runner.control({ action: 'dispatch', workId, tasks: [h.task('A')] }, h.native()); await flush();
  const id = h.calls[0].id; h.pending.get(id).reject(new Error('connection lost')); await flush();
  assert.equal(h.run.attempts[0].status, 'unknown'); assert.equal(h.scheduler.uncertain.get('codex'), id);
  h.run.events.forEach(event => { event.deliveredTo = 'known'; });
  await h.runner.resume(); await flush();
  assert.equal(h.calls[1].id, id); assert.equal(h.calls[1].recovering, true); assert.equal(h.run.attempts.length, 1);
  h.run.status = 'blocked'; h.pending.get(id).resolve(); await flush(); assert.equal(h.scheduler.uncertain.size, 0);
});
test('a delivery candidate becomes complete only after its native main turn ends and no new work input arrived', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId);
  const main = { id: 'main-end', kind: 'main', status: 'running', acceptedAt: Date.now(), native: { turnId: 'native-turn' } }; h.run.attempts.push(main);
  h.apply({ action: 'finish', workId, summary: 'ready', evidence: [{ criterion: 'C1', detail: 'native answer', reference: 'main-turn:native-turn' }] });
  assert.equal(h.run.works[0].status, 'closing');
  await h.runner.mainEnded(main.id, { text: 'answer', completed: true }); assert.equal(h.run.works[0].status, 'completed');
  const other = scenario(), work = other.create(); other.plan(work); other.run.status = 'blocked'; other.run.attempts.push({ ...main, endedAt: null });
  other.apply({ action: 'finish', workId: work, summary: 'ready', evidence: [{ criterion: 'C1', detail: 'native answer', reference: 'main-turn:native-turn' }] });
  fusionEvent(other.run, 'user_input', { workId: work, text: 'new requirement' });
  await other.runner.mainEnded(main.id, { text: 'answer', completed: true }); assert.equal(other.run.works[0].status, 'running');
  other.run.status = 'blocked'; await flush();
});
test('a question answer has an explicit work/task relationship and duplicate phone input does not redeliver', () => {
  const h = scenario(), workId = h.create(); h.plan(workId); h.run.status = 'blocked';
  const question = h.apply({ action: 'ask_user', workId, question: 'Which scope?' });
  const input = { requestId: 'phone-answer', workId, questionId: question.questionId, text: 'this project' };
  h.runner.input(input); h.runner.input(input);
  assert.equal(h.run.events.filter(event => event.id === input.requestId).length, 1);
  assert.equal(h.run.questions[0].answer, 'this project');
});
test('a new inbox request wakes the existing main without inventing a work item or touching desktop selection', async () => {
  const h = scenario();
  h.runner.input({ text: 'new request', requestId: 'inbox-new' }); await flush();
  assert.equal(h.run.works.length, 0); assert.equal(h.run.events[0].data.workId, '');
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].kind, 'main');
  h.pending.get(h.calls[0].id).resolve(); await flush();
  assert.equal(h.run.events[0].deliveredTo, h.run.attempts[0].native.turnId);
});
test('cancelling a dependency-blocked task removes its software queue entry', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId); h.run.status = 'blocked';
  await h.runner.control({ action: 'dispatch', workId, tasks: [h.task('A'), h.task('B', 'cursor', ['A'])] }, h.native()); await flush();
  await h.runner.control({ action: 'cancel_task', taskId: 'B', reason: 'no longer needed' }, h.native()); await flush();
  assert.equal(h.scheduler.queue.length, 0); assert.equal(h.run.tasks[1].status, 'cancelled');
  assert.equal(h.run.effects.find(row => row.data.attemptId === h.run.attempts[1].id).status, 'cancelled');
  h.pending.get(h.calls[0].id).resolve(); await flush();
});
test('the controller observer does not finish a native event attempt owned by the execution observer', async () => {
  const { FusionController } = await import('../server/fusion/controller.mjs');
  const h = scenario(), attempt = { id: 'event-main', kind: 'main', origin: 'events', bindingId: 'main', status: 'running',
    acceptedAt: 1, endedAt: null, native: { turnId: 'native-event', threadId: 'main-thread', messageId: 'message' } };
  h.run.attempts.push(attempt);
  const turn = { id: 'message', threadId: 'main-thread', turnId: 'native-event', accepted: true, ended: true, completed: true, text: 'done' };
  const driver = new FusionController(h.runner); let ended = 0;
  const original = h.runner.mainEnded.bind(h.runner); h.runner.mainEnded = (...args) => { ended++; return original(...args); };
  driver.context = { native: { threadId: 'main-thread' }, source: { readConversation: async () => ({ state: { run: { status: 'completed' } }, chat: { items: [] } }) } };
  h.agent.call = async (_context, code) => code === 'codexFusionTurn()' ? turn : [];
  await driver.read(); assert.equal(ended, 0); assert.equal(attempt.status, 'running'); assert.equal(attempt.endedAt, null);
  await h.runner.mainEnded(attempt.id, turn); assert.equal(ended, 1); assert.equal(attempt.status, 'ended'); assert(attempt.endedAt);
});
test('priority changes reorder dependency-blocked tasks when they become ready', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId); h.run.status = 'blocked';
  await h.runner.control({ action: 'dispatch', workId, tasks: [h.task('A'), h.task('B', 'cursor', ['A']), h.task('C', 'cursor', ['A'])] }, h.native()); await flush();
  await h.runner.control({ action: 'set_priority', taskId: 'C', priority: 10 }, h.native());
  const first = h.calls[0]; h.pending.get(first.id).resolve(); await flush();
  await h.runner.control({ action: 'review', taskId: 'A', attemptId: first.id, verdict: 'accept', reason: 'verified',
    evidence: [{ criterion: 'A:1', detail: 'actual', reference: 'native', attemptId: first.id }] }, h.native()); await flush();
  assert.equal(h.run.attempts.find(row => row.id === h.calls[1].id).taskId, 'C');
  h.pending.get(h.calls[1].id).resolve(); await flush(); h.pending.get(h.calls[2].id).resolve(); await flush();
});
