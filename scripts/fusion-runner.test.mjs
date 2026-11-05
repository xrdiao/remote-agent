import assert from 'node:assert/strict';
import test from 'node:test';
import { FusionRunner } from '../server/fusion/runner.mjs';
import { FusionScheduler } from '../server/fusion/scheduler.mjs';
import { fusionEvent, fusionLive } from '../server/fusion/state.mjs';
import { fixture, flush } from './fusion-fixture.mjs';
function scenario() {
  const h = fixture(), scheduler = new FusionScheduler(), calls = [], pending = new Map(), stops = [];
  const agent = { async execute(run, id, prompt, recovering) {
    const attempt = run.attempts.find(row => row.id === id);
    calls.push({ id, kind: attempt.kind, prompt, recovering });
    attempt.status = 'running'; attempt.submission = 'accepted'; attempt.acceptedAt ||= Date.now();
    attempt.native ||= { threadId: attempt.kind === 'main' ? 'main-thread' : id, turnId: id, messageId: id };
    const task = run.tasks.find(row => row.id === attempt.taskId);
    if (task) task.status = 'running';
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
  assert.equal(h.runner.jobs.size, 1); assert.equal(h.scheduler.mainSlots.size, 1);
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
test('a completed child retains full evidence once and wakes the main with references, preserving event acknowledgement', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId); h.run.status = 'blocked';
  await h.runner.control({ action: 'dispatch', workId, tasks: [h.task('image')] }, h.native()); await flush();
  const child = h.calls[0], diff = 'diff --git a/image.png b/image.png\nGIT binary patch\nliteral 1000000\n' + 'patch-data'.repeat(120000);
  h.pending.get(child.id).resolve({ text: '截图已保存，待主 Agent 验收', changes: { available: true, diff } }); await flush();
  const attempt = h.run.attempts.find(row => row.id === child.id), event = h.run.events[0];
  assert.equal(attempt.changes.diff, diff); assert.equal(attempt.status, 'awaiting_review');
  assert.equal(event.data.changes, undefined); assert.equal(event.data.result, undefined);
  assert.equal(event.data.attemptId, child.id); assert(!event.deliveredTo);
  h.run.status = 'waiting'; h.runner.wake(); await flush();
  const main = h.calls[1]; assert(main.prompt.length < 10000); assert(!main.prompt.includes('patch-data'));
  assert(main.prompt.includes(child.id)); assert(main.prompt.includes('image.png'));
  assert(!event.deliveredTo); assert.equal(h.run.tasks[0].status, 'awaiting_review');
  h.runner.wake(); await flush(); assert.equal(h.calls.length, 2);
  h.pending.get(main.id).resolve(); await flush();
  assert.equal(event.deliveredTo, main.id); assert.equal(h.run.tasks[0].status, 'awaiting_review');
  assert.equal(attempt.changes.diff, diff); assert.equal(h.calls.length, 2);
});
test('resuming a rejected oversized inbox uses a new compact Attempt and preserves the rejected facts', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId);
  h.apply({ action: 'dispatch', workId, tasks: [h.task('image')] });
  const child = h.run.attempts[0];
  Object.assign(child, { status: 'awaiting_review', endedAt: 20, result: { text: 'ready', completed: true },
    changes: { diff: 'diff --git a/image.png b/image.png\nGIT binary patch\n' + 'old-bytes'.repeat(120000) } });
  h.run.effects[0].status = 'done';
  fusionEvent(h.run, 'task_result', { taskId: 'image', attemptId: child.id, changes: child.changes }, 'old-result');
  const rejected = { id: 'rejected-inbox', kind: 'main', origin: 'events', status: 'failed', endedAt: 30,
    submission: 'submitting', error: 'Input exceeds maximum length', prompt: JSON.stringify(h.run.events), eventIds: ['old-result'] };
  h.run.attempts.push(rejected); h.run.status = 'blocked';
  const before = structuredClone(rejected);
  await h.runner.resume(); await flush();
  assert.equal(h.calls.length, 1); assert.notEqual(h.calls[0].id, rejected.id); assert(!h.calls[0].recovering);
  assert(h.calls[0].prompt.length < 10000); assert(!h.calls[0].prompt.includes('old-bytes'));
  assert.deepEqual(rejected, before); assert(!h.run.events[0].deliveredTo);
  h.pending.get(h.calls[0].id).resolve(); await flush();
  assert.equal(h.run.events[0].deliveredTo, h.calls[0].id);
});
test('native management replies transmit evidence references through the existing tool fields and acknowledge only after reply', async t => {
  const { FusionController } = await import('../server/fusion/controller.mjs');
  const h = scenario(), workId = h.create(); h.plan(workId); h.run.status = 'blocked';
  h.apply({ action: 'dispatch', workId, tasks: [h.task('image')] }); h.run.effects[0].status = 'done';
  const child = h.run.attempts[0];
  Object.assign(child, { status: 'awaiting_review', endedAt: 20, result: { text: 'exact native reply', completed: true },
    changes: { diff: 'diff --git a/image.png b/image.png\nGIT binary patch\n' + 'binary-bytes'.repeat(100000) } });
  fusionEvent(h.run, 'task_result', { taskId: 'image', attemptId: child.id, changes: child.changes }, 'result-image');
  const savedLive = fusionLive.get('main');
  t.after(() => savedLive ? fusionLive.set('main', savedLive) : fusionLive.delete('main'));
  const driver = new FusionController(h.runner), replies = [];
  driver.context = { native: { threadId: 'main-thread' }, source: { readConversation: async () => ({ chat: { items: [] } }) } };
  let action = { action: 'read_workspace' }, release;
  h.agent.call = async (_context, code) => {
    if (code === 'codexFusionTurn()') return {};
    if (code.includes("'tools'")) return [{ id: 0, params: { threadId: 'main-thread', turnId: 'native-main', tool: 'ra_fusion', arguments: action } }];
    return new Function('nativeSessionAction', 'return ' + code)((app, threadId, operation, payload) => {
      assert.equal(app, 'codex'); assert.equal(threadId, 'main-thread'); assert.equal(operation, 'toolReply');
      replies.push(payload); return new Promise(resolve => { release = resolve; });
    });
  };
  const first = driver.read(); await flush();
  const reply = replies[0]; assert.equal(reply.result.success, true);
  assert(reply.result.contentItems[0].text.length < 10000); assert(!h.run.events[0].deliveredTo);
  const value = JSON.parse(reply.result.contentItems[0].text);
  action = value.events[0].data.evidence.result.text.read;
  // These fields are already registered on existing native main conversations.
  assert.deepEqual(Object.keys(action).sort(), ['action', 'attemptId', 'input', 'taskId']);
  release(true); await first; assert.equal(h.run.events[0].deliveredTo, 'native-main');
  const second = driver.read(); await flush(); release(true); await second;
  assert.equal(JSON.parse(replies[1].result.contentItems[0].text).text, 'exact native reply');
  assert.equal(h.run.attempts.length, 1); assert.equal(child.status, 'awaiting_review'); assert.equal(h.calls.length, 0);
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
test('an unknown attempt prevents its own resubmission but leaves independent same-app work runnable during recovery', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId); h.run.status = 'blocked';
  await h.runner.control({ action: 'dispatch', workId, tasks: [h.task('A')] }, h.native()); await flush();
  const id = h.calls[0].id; h.pending.get(id).reject(new Error('connection lost')); await flush();
  assert.equal(h.run.attempts[0].status, 'unknown');
  assert.throws(() => h.apply({ action: 'continue_task', taskId: 'A', input: 'again', cost: h.cost('codex') }), /结果未知/);
  await h.runner.control({ action: 'dispatch', workId, tasks: [h.task('independent')] }, h.native()); await flush();
  const other = h.calls[1]; assert(other); assert.notEqual(other.id, id); assert(!other.recovering);
  h.run.events.forEach(event => { event.deliveredTo = 'known'; });
  await h.runner.resume(); await flush();
  assert.equal(h.calls[2].id, id); assert.equal(h.calls[2].recovering, true); assert.equal(h.run.attempts.length, 2);
  h.run.status = 'blocked'; h.pending.get(id).resolve(); h.pending.get(other.id).resolve(); await flush();
  assert.equal(h.runner.jobs.size, 0);
});
test('independent same-project writes run in parallel and report to their own tasks when completed out of order', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId); h.run.status = 'blocked';
  const one = { ...h.task('feature-a'), access: 'write', scope: ['feature-a'] };
  const two = { ...h.task('feature-b'), access: 'write', scope: ['feature-b'] };
  await h.runner.control({ action: 'dispatch', workId, tasks: [one, two] }, h.native()); await flush();
  assert.equal(h.calls.length, 2);
  const [a, b] = h.calls; assert.notEqual(a.id, b.id);
  h.pending.get(b.id).resolve({ text: 'B evidence', changes: { files: ['feature-b'] } }); await flush();
  assert.equal(h.run.tasks[0].status, 'running'); assert.equal(h.run.tasks[1].status, 'awaiting_review');
  h.pending.get(a.id).resolve({ text: 'A evidence', changes: { files: ['feature-a'] } }); await flush();
  assert.equal(h.run.attempts.find(row => row.id === a.id).result.text, 'A evidence');
  assert.equal(h.run.attempts.find(row => row.id === b.id).result.text, 'B evidence');
  assert.deepEqual(h.run.events.map(event => event.data.taskId), ['feature-b', 'feature-a']);
  assert.equal(h.runner.jobs.size, 0);
});
test('parallel unknown native turns recover together without submitting new Attempts', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId); h.run.status = 'blocked';
  await h.runner.control({ action: 'dispatch', workId, tasks: [h.task('A'), h.task('B')] }, h.native()); await flush();
  const ids = h.calls.map(call => call.id); assert.equal(ids.length, 2);
  for (const id of ids) h.pending.get(id).reject(new Error('connection lost'));
  await flush(); assert(h.run.attempts.every(attempt => attempt.status === 'unknown'));
  h.run.events.forEach(event => { event.deliveredTo = 'already-read'; });
  await h.runner.resume(); await flush();
  assert.deepEqual(h.calls.slice(2).map(call => call.id), ids); assert(h.calls.slice(2).every(call => call.recovering));
  assert.equal(h.run.attempts.length, 2);
  h.run.status = 'blocked'; for (const id of ids) h.pending.get(id).resolve(); await flush();
  assert(h.run.attempts.every(attempt => attempt.status === 'awaiting_review')); assert.equal(h.runner.jobs.size, 0);
});
test('main self-execution can write alongside an independent child while its declared dependencies still apply', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId); h.run.status = 'blocked';
  await h.runner.control({ action: 'dispatch', workId, tasks: [{ ...h.task('child'), access: 'write', scope: ['child-file'] }] }, h.native()); await flush();
  const child = h.calls[0], spec = { goal: 'Independent main change', access: 'write', scope: ['main-file'], dependsOn: [], acceptance: ['main evidence'] };
  await assert.rejects(h.runner.control({ action: 'self_execute', workId, task: { ...spec, dependsOn: ['child'] }, cost: h.cost('codex') }, h.native()), /前置任务尚未验收/);
  const result = await h.runner.control({ action: 'self_execute', workId, task: spec, cost: h.cost('codex') }, h.native());
  const self = h.run.attempts.find(attempt => attempt.id === result.attemptId); assert(self.baseline);
  assert.equal(self.status, 'running'); assert.equal(h.run.tasks.find(task => task.id === 'child').status, 'running');
  h.run.attempts.push({ id: 'main-turn', kind: 'main', status: 'running', acceptedAt: 1, native: { turnId: 'native-turn' } });
  await h.runner.mainEnded('main-turn', { completed: true, text: 'main evidence' }); h.run.status = 'blocked';
  assert.equal(h.run.attempts.find(attempt => attempt.id === self.id).result.text, 'main evidence');
  h.pending.get(child.id).resolve({ text: 'child evidence' }); await flush();
  assert.equal(h.run.attempts.find(attempt => attempt.id === child.id).result.text, 'child evidence');
});
test('stopping parallel same-app tasks waits for each exact target and cancels only the unsubmitted dependency', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId);
  await h.runner.control({ action: 'dispatch', workId, tasks: [h.task('A'), h.task('dependent', 'codex', ['A']), h.task('B')] }, h.native()); await flush();
  assert.equal(h.calls.length, 2); const [one, two] = h.calls;
  await h.runner.stop(); assert.deepEqual(h.stops, [one.id, two.id]); assert.equal(h.run.status, 'stopping');
  assert.equal(h.run.tasks[1].status, 'cancelled');
  h.pending.get(two.id).resolve({ stopped: true, completed: false }); await flush(); assert.equal(h.run.status, 'stopping');
  h.pending.get(one.id).resolve({ stopped: true, completed: false }); await flush(); assert.equal(h.run.status, 'stopped');
  assert.equal(h.calls.length, 2);
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
