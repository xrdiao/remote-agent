import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { FusionRunner } from '../server/fusion/runner.mjs';
import { FusionScheduler } from '../server/fusion/scheduler.mjs';
import { fusionEvent, fusionLive } from '../server/fusion/state.mjs';
import { fixture, flush } from './fusion-fixture.mjs';
function scenario({ readWorkspace = true } = {}) {
  const h = fixture(), scheduler = new FusionScheduler(), calls = [], pending = new Map(), stops = [];
  const agent = { async execute(run, id, prompt, recovering) {
    const attempt = run.attempts.find(row => row.id === id);
    calls.push({ id, kind: attempt.kind, prompt, recovering });
    attempt.status = 'running'; attempt.submission = 'accepted'; attempt.acceptedAt ||= Date.now();
    attempt.native ||= { threadId: attempt.kind === 'main' ? 'main-thread' : id, turnId: id, messageId: id };
    const task = run.tasks.find(row => row.id === attempt.taskId);
    if (task) task.status = 'running';
    const readEvents = attempt.kind === 'main' && readWorkspace ? h.apply({ action: 'read_workspace' }).events.map(event => event.id) : [];
    return new Promise((resolve, reject) => pending.set(id, { resolve: result => {
      runner.acknowledge({ turnId: attempt.native.turnId }, readEvents);
      resolve({ text: 'native evidence', completed: true, native: attempt.native, ...result });
    }, reject }));
  }, async stop(id) { stops.push(id); } };
  const controller = { async start() {}, async idle() { return true; }, async stop(attempt) { stops.push(attempt.id); } };
  const runner = new FusionRunner(h.run, { scheduler, agent, controller });
  const control = (action, native) => runner.control(h.request(action), native);
  return { ...h, runner, control, agent, scheduler, controller, calls, pending, stops };
}
test('successful recovery clears the current block while preserving an ended native interruption', async () => {
  const h=scenario(),attempt={id:'historical-main',kind:'main',status:'failed',submission:'accepted',acceptedAt:5,endedAt:10,
    native:{threadId:'main-thread',turnId:'old-turn',messageId:'old-message'},result:{text:'',completed:false,error:'Codex interrupted'}};
  h.run.attempts.push(attempt);h.run.status='recovering';h.run.blockedReason=attempt.result.error;
  const before=structuredClone(attempt);
  await h.runner.recover();await flush();
  assert.equal(h.run.status,'waiting');assert.equal(h.run.blockedReason,'');
  assert.deepEqual(h.run.attempts[0],before);assert.equal(h.calls.length,0);assert.equal(h.run.events.length,0);
});
test('failed recovery remains blocked and does not erase the actual connection failure', async () => {
  const h=scenario();h.run.status='recovering';h.run.blockedReason='Old interruption';
  h.controller.start=async()=>{throw new Error('Native connection is still unavailable');};
  await h.runner.recover().catch(error=>h.runner.blockMain(error));await flush();
  assert.equal(h.run.status,'blocked');assert.equal(h.run.blockedReason,'Native connection is still unavailable');
  assert.equal(h.calls.length,0);assert.equal(h.run.attempts.length,0);
});
test('an unconfirmed native main turn stays unknown and blocked instead of clearing its error or resending', async () => {
  const h=scenario();h.run.status='recovering';h.run.blockedReason='Prior uncertainty';
  h.run.attempts.push({id:'unknown-main',kind:'main',origin:'user',status:'unknown',submission:'accepted',endedAt:null,
    native:{threadId:'main-thread',turnId:'unknown-turn',messageId:'unknown-message'}});
  h.agent.call=async()=>({id:''});h.controller.context={};
  await h.runner.recover();await flush();
  assert.equal(h.run.status,'blocked');assert.match(h.run.blockedReason,/无法确认/);
  assert.equal(h.run.attempts[0].status,'unknown');assert.equal(h.run.attempts[0].endedAt,null);
  assert.equal(h.calls.length,0);assert.equal(h.run.attempts.length,1);
});
test('reused Worker waits for its native result while independent work continues, including unknown-result recovery', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId); h.controller.idle = async () => false;
  await h.control({ action: 'dispatch', workId, tasks: [h.task('A')] }, h.native()); await flush();
  const first = h.run.tasks[0], attempt = h.run.attempts[0];
  await h.control({ action: 'dispatch', workId, tasks: [h.task('B'), h.task('C')], input: JSON.stringify({
    B: { workerId: first.workerId, reason: 'Continue the established analysis context' }, C: { workerId: null, reason: 'Independent topic' },
  }) }, h.native()); await flush();
  const started = () => h.calls.filter(row => row.kind === 'task').map(row => h.run.attempts.find(attempt => attempt.id === row.id).taskId);
  assert.deepEqual(started(), ['A', 'C']);
  h.pending.get(attempt.id).reject(new Error('Connection lost after native acceptance')); await flush();
  assert.equal(h.run.attempts[0].status, 'unknown'); h.scheduler.drain(); await flush(); assert.deepEqual(started(), ['A', 'C']);
  h.runner.completed(attempt.id, { completed: true, text: 'Recovered actual native result' }); h.scheduler.drain(); await flush();
  assert.deepEqual(started(), ['A', 'C', 'B']);
  for (const task of h.run.tasks.slice(1)) h.pending.get(task.attemptIds[0]).resolve({});
  await flush(); assert.equal(h.scheduler.workerSlots.size, 0);
});
test('a same-software child does not occupy the main controller lane', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId);
  await h.control({ action: 'dispatch', workId, tasks: [h.task('B')] }, h.native()); await flush();
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
  await h.control({ action: 'dispatch', workId, tasks: [h.task('image')] }, h.native()); await flush();
  const child = h.calls[0], diff = 'diff --git a/image.png b/image.png\nGIT binary patch\nliteral 1000000\n' + 'patch-data'.repeat(120000);
  h.pending.get(child.id).resolve({ text: '截图已保存，待主 Agent 验收', changes: { available: true, diff } }); await flush();
  const attempt = h.run.attempts.find(row => row.id === child.id), event = h.run.events[0];
  assert.equal(attempt.changes.diff, diff); assert.equal(attempt.status, 'awaiting_review');
  assert.equal(event.data.changes, undefined); assert.equal(event.data.result, undefined);
  assert.equal(event.data.attemptId, child.id); assert(!event.deliveredTo);
  h.run.status = 'waiting'; h.runner.wake(); await flush();
  const main = h.calls[1]; assert(main.prompt.length < 10000); assert(!main.prompt.includes('patch-data'));
  assert(main.prompt.includes(main.id)); assert(!main.prompt.includes('image.png'));
  const index = h.apply(h.apply({ action: 'read_workspace' }).events[0].data.evidence.read);
  assert(index.attempts[0].changes.diff.files[0].header.includes('image.png'));
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
  action = value.events[0].data.evidence.read;
  // These fields are already registered on existing native main conversations.
  assert.deepEqual(Object.keys(action).sort(), ['action', 'attemptId', 'taskId']);
  release(true); await first; assert.equal(h.run.events[0].deliveredTo, 'native-main');
  const second = driver.read(); await flush(); release(true); await second;
  action = JSON.parse(replies[1].result.contentItems[0].text).attempts[0].result.text.read;
  assert.deepEqual(Object.keys(action).sort(), ['action', 'attemptId', 'input', 'taskId']);
  const third = driver.read(); await flush(); release(true); await third;
  assert.equal(JSON.parse(replies[2].result.contentItems[0].text).text, 'exact native reply');
  assert.equal(h.run.attempts.length, 1); assert.equal(child.status, 'awaiting_review'); assert.equal(h.calls.length, 0);
});
test('a wake notification omits user text and an unread completed main turn preserves events without spinning', async () => {
  const h = scenario({ readWorkspace: false }), text = '完整用户原文'.repeat(10000);
  fusionEvent(h.run, 'user_input', { text }, 'unread-input'); h.runner.wake(); await flush();
  const main = h.calls[0]; assert(main.prompt.length < 300); assert(!main.prompt.includes(text));
  assert(main.prompt.includes(main.id)); assert.equal(h.apply({ action: 'read_workspace' }).events[0].data.text, text);
  h.pending.get(main.id).resolve(); await flush(); h.runner.wake(); await flush();
  assert.equal(h.run.events[0].deliveredTo, ''); assert.equal(h.run.status, 'blocked'); assert.equal(h.calls.length, 1);
  assert.equal(h.run.attempts[0].result.completed, true); // Native completion and inbox delivery remain separate facts.
});
test('dependent tasks wait for actual acceptance, not just generation completion', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId);
  h.run.status = 'blocked';
  await h.control({ action: 'dispatch', workId, tasks: [h.task('A'), h.task('B', 'cursor', ['A'])] }, h.native()); await flush();
  const first = h.calls[0]; h.pending.get(first.id).resolve(); await flush(); assert.equal(h.calls.length, 1);
  await h.control({ action: 'review', taskId: 'A', attemptId: first.id, verdict: 'accept', reason: 'verified',
    evidence: [{ criterion: 'A:1', detail: 'actual result', reference: 'native', attemptId: first.id }] }, h.native()); await flush();
  assert.equal(h.calls.length, 2); assert.equal(h.run.attempts.find(row => row.id === h.calls[1].id).taskId, 'B');
  h.pending.get(h.calls[1].id).resolve(); await flush();
});
test('stop cancels unsubmitted dependents and remains stopping until exact native execution ends', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId);
  await h.control({ action: 'dispatch', workId, tasks: [h.task('A'), h.task('B', 'cursor', ['A'])] }, h.native()); await flush();
  const first = h.calls[0]; await h.runner.stop(); await flush();
  assert.equal(h.run.status, 'stopping'); assert.deepEqual(h.stops, [first.id]); assert.equal(h.run.tasks[1].status, 'cancelled');
  h.pending.get(first.id).resolve({ stopped: true, completed: false }); await flush();
  assert.equal(h.run.status, 'stopped'); assert.equal(h.calls.length, 1);
});
test('stopping one work item leaves another work item and its actual native target alone', async () => {
  const h = scenario(), a = h.create(), b = h.create(); h.plan(a); h.plan(b);
  await h.control({ action: 'dispatch', workId: a, tasks: [h.task('A')] }, h.native());
  await h.control({ action: 'dispatch', workId: b, tasks: [h.task('B', 'cursor')] }, h.native()); await flush();
  await h.runner.stop({ workId: a }); assert.equal(h.run.stopRequested, false); assert.equal(h.stops.length, 1);
  const first = h.run.attempts.find(row => row.workId === a), second = h.run.attempts.find(row => row.workId === b);
  assert.equal(second.status, 'running'); assert.deepEqual(h.stops, [first.id]);
  h.run.status = 'blocked'; h.pending.get(first.id).resolve({ stopped: true }); h.pending.get(second.id).resolve(); await flush();
});
test('an unknown attempt prevents its own resubmission but leaves independent same-app work runnable during recovery', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId); h.run.status = 'blocked';
  await h.control({ action: 'dispatch', workId, tasks: [h.task('A')] }, h.native()); await flush();
  const id = h.calls[0].id; h.pending.get(id).reject(new Error('connection lost')); await flush();
  assert.equal(h.run.attempts[0].status, 'unknown');
  assert.throws(() => h.apply({ action: 'continue_task', taskId: 'A', input: 'again', cost: h.cost('codex') }), /结果未知/);
  await h.control({ action: 'dispatch', workId, tasks: [h.task('independent')] }, h.native()); await flush();
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
  await h.control({ action: 'dispatch', workId, tasks: [one, two] }, h.native()); await flush();
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
  await h.control({ action: 'dispatch', workId, tasks: [h.task('A'), h.task('B')] }, h.native()); await flush();
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
test('main work uses the actual native round, preserves its baseline and creates no self Task or Assignment', async () => {
  const h = scenario(), workId = h.create(); h.controller.idle = async () => false;
  const main = { id: 'main-round', kind: 'main', status: 'running', acceptedAt: Date.now(), bindingId: 'main',
    native: { threadId: 'main-thread', turnId: 'native-turn', messageId: 'main-input' }, workExecutions: [] };
  h.run.attempts.push(main);
  const current = () => h.run.attempts.find(row => row.id === main.id);
  fs.writeFileSync(h.project.root + '/main-file', 'preexisting');
  const action = { action: 'plan', workId, summary: 'Direct main work', scope: ['main-file'],
    input: JSON.stringify({ mainScope: ['main-file'] }), cost: h.cost('codex'),
    criteria: [{ id: 'C', text: 'Actual native evidence' }], requiresConfirmation: false };
  const native = h.native(); await h.control(action, native);
  assert.equal(h.run.tasks.length, 0); assert.equal(h.run.assignments.length, 0); assert.equal(h.run.agents.length, 0);
  assert.equal(current().workExecutions.length, 1); assert(current().workExecutions[0].baseline);
  const before = structuredClone(current().workExecutions[0]);
  await h.control(action, native); assert.equal(current().workExecutions.length, 1); assert.deepEqual(current().workExecutions[0], before);
  fs.writeFileSync(h.project.root + '/main-file', 'main change');
  await h.control({ action: 'finish', workId, summary: 'done', evidence: [{ criterion: 'C', detail: 'actual', reference: 'main-turn:native-turn' }] }, h.native());
  assert.equal(h.run.works[0].status, 'closing');
  await h.runner.mainEnded(main.id, { completed: true, text: 'native work complete' });
  assert.equal(h.run.works[0].status, 'completed'); assert(current().workExecutions[0].changes);
  assert.notEqual(current().workExecutions[0].baseline.files[0].sha256, current().workExecutions[0].changes.files[0].sha256);
  assert.equal(h.run.attempts.length, 1); assert.equal(h.calls.length, 0);
});
test('stopping direct main work targets its actual round, preserves unrelated work and waits for native confirmation', async () => {
  const h = scenario(), workId = h.create(), other = h.create(); h.plan(workId); h.plan(other);
  const attempt = { id: 'main-round', kind: 'main', status: 'running', acceptedAt: Date.now(), workExecutions: [{workId}],
    native: { threadId: 'main-thread', turnId: 'main-native', messageId: 'user' } };
  h.run.attempts.push(attempt);
  await h.runner.stop({ workId }); assert.deepEqual(h.stops, ['main-round']);
  assert.equal(h.run.works[0].status, 'stopping'); assert.equal(h.run.works[1].status, 'running');
  assert.equal(h.run.tasks.length, 0); assert.equal(attempt.status, 'stopping');
  await h.runner.mainEnded(attempt.id, { completed: false, error: 'native interrupted' }); h.runner.finishStop();
  assert.equal(h.run.works[0].status, 'stopped'); assert.equal(h.run.works[1].status, 'running');
});
test('stopping parallel same-app tasks waits for each exact target and cancels only the unsubmitted dependency', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId);
  await h.control({ action: 'dispatch', workId, tasks: [h.task('A'), h.task('dependent', 'codex', ['A']), h.task('B')] }, h.native()); await flush();
  assert.equal(h.calls.length, 2); const [one, two] = h.calls;
  await h.runner.stop(); assert.deepEqual(h.stops, [one.id, two.id]); assert.equal(h.run.status, 'stopping');
  assert.equal(h.run.tasks[1].status, 'cancelled');
  h.pending.get(two.id).resolve({ stopped: true, completed: false }); await flush(); assert.equal(h.run.status, 'stopping');
  h.pending.get(one.id).resolve({ stopped: true, completed: false }); await flush(); assert.equal(h.run.status, 'stopped');
  assert.equal(h.calls.length, 2);
});
test('recovery settles a stopped run with ended native facts without reconnecting its closed window', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId);
  h.run.stopRequested = true; h.run.status = 'stopping'; h.run.works[0].status = 'stopping';
  h.run.attempts.push({ id: 'ended-native', kind: 'main', workId, bindingId: 'main', status: 'ended',
    submission: 'accepted', acceptedAt: 10, endedAt: 20,
    native: { threadId: 'main-thread', turnId: 'ended-turn', messageId: 'ended-message' },
    result: { text: 'Recorded result', completed: true } });
  fusionEvent(h.run, 'task_result', { attemptId: 'ended-native' }, 'unread-result');
  const facts = structuredClone({ attempts: h.run.attempts, events: h.run.events });
  h.controller.start = async () => assert.fail('closed window must not be reconnected');
  await h.runner.recover(); await flush();
  assert.equal(h.run.status, 'stopped'); assert.equal(h.run.works[0].status, 'stopped');
  assert.deepEqual({ attempts: h.run.attempts, events: h.run.events }, facts);
  assert.equal(h.calls.length, 0); assert.equal(h.scheduler.queue.length, 0);
});
test('recovery still reconciles unknown or running native executions before confirming stop', async () => {
  for (const status of ['unknown', 'running']) {
    const h = scenario(); h.run.stopRequested = true; h.run.status = 'stopping';
    h.run.attempts.push({ id: 'unsettled-native', kind: 'main', bindingId: 'main', status,
      submission: 'accepted', acceptedAt: 10, endedAt: null,
      native: { threadId: 'main-thread', turnId: 'unsettled-turn', messageId: 'unsettled-message' } });
    const facts = structuredClone(h.run.attempts); let connects = 0;
    h.controller.start = async () => { connects++; throw new Error('Native window is closed'); };
    await h.runner.recover().catch(error => h.runner.blockMain(error)); await flush();
    assert.equal(connects, 1); assert.equal(h.run.status, 'stopping');
    assert.deepEqual(h.run.attempts, facts); assert.equal(h.calls.length, 0);
  }
});
test('resuming the controller preserves individually stopped work while accepting a new request', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId);
  await h.runner.stop({ workId }); assert.equal(h.run.works[0].status, 'stopped');
  await h.runner.stop();
  h.runner.input({ text: 'Independent new request; leave the old work stopped', requestId: 'new-work-input' });
  await h.runner.resume(); await flush();
  assert.equal(h.run.stopRequested, false); assert.equal(h.run.works[0].status, 'stopped');
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].kind, 'main');
  await assert.rejects(h.control({ action: 'finish', workId, summary: 'Old work must remain stopped',
    evidence: [{ criterion: 'C1', detail: 'Prior evidence', reference: 'main-turn:native-turn' }] }, h.native()), /该工作项已停止/);
  const created = await h.control({ action: 'create_work', title: 'New work', goal: 'New request' }, h.native());
  assert.notEqual(created.workId, workId); assert.equal(h.run.works[0].status, 'stopped');
  h.pending.get(h.calls[0].id).resolve(); await flush();
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
  await h.control({ action: 'dispatch', workId, tasks: [h.task('A'), h.task('B', 'cursor', ['A'])] }, h.native()); await flush();
  await h.control({ action: 'cancel_task', taskId: 'B', reason: 'no longer needed' }, h.native()); await flush();
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
  await h.control({ action: 'dispatch', workId, tasks: [h.task('A'), h.task('B', 'cursor', ['A']), h.task('C', 'cursor', ['A'])] }, h.native()); await flush();
  await h.control({ action: 'set_priority', taskId: 'C', priority: 10 }, h.native());
  const first = h.calls[0]; h.pending.get(first.id).resolve(); await flush();
  await h.control({ action: 'review', taskId: 'A', attemptId: first.id, verdict: 'accept', reason: 'verified',
    evidence: [{ criterion: 'A:1', detail: 'actual', reference: 'native', attemptId: first.id }] }, h.native()); await flush();
  assert.equal(h.run.attempts.find(row => row.id === h.calls[1].id).taskId, 'C');
  h.pending.get(h.calls[1].id).resolve(); await flush(); h.pending.get(h.calls[2].id).resolve(); await flush();
});

test('management handles the current native request and call identity without reading transcript content', async () => {
  const { FusionController } = await import('../server/fusion/controller.mjs');
  const h = scenario(); h.run.status = 'blocked'; h.controller.idle = async () => false;
  const requests = [{ id: 0, params: { threadId: 'main-thread', turnId: 'current-turn', callId: 'actual-call',
    tool: 'ra_fusion', arguments: { action: 'create_work', title: 'current', goal: 'current' } } }];
  let replies = 0, contentReads = 0;
  h.agent.call = async (_ctx, code) => {
    if (code === 'codexFusionTurn()') return { id: 'current-message', threadId: 'main-thread', turnId: 'current-turn', accepted: true, ended: false };
    if (code.includes("'tools'")) return requests;
    if (code.includes("'settings'")) return { model: 'cheap', effort: 'low' };
    if (code.includes("'toolReply'")) { replies++; return true; }
    throw Error(code);
  };
  const driver = new FusionController(h.runner);
  driver.context = { native: { threadId: 'main-thread' }, source: { readConversation() { contentReads++; throw Error('Body not ready'); } } };
  await driver.read(); assert.equal(contentReads, 0); assert.equal(replies, 1);
  const command = h.run.commands.at(-1); assert.equal(command.native.callId, 'actual-call'); assert.equal(command.native.requestId, 0);
  assert.equal(h.run.tasks.length, 0); assert.equal(h.run.works.length, 1); assert.equal(h.calls.length, 0);
  await driver.read(); assert.equal(h.run.works.length, 1); assert.equal(h.run.commands.length, 1);
});
