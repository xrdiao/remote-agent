import assert from 'node:assert/strict';
import test from 'node:test';
import { FusionRunner } from '../server/fusion/runner.mjs';
import { FusionScheduler } from '../server/fusion/scheduler.mjs';
import { newFusionRun, fusionEvent, fusionWorkers, fusionRuns, fusionWindowInUse } from '../server/fusion/state.mjs';
import { nativeCostSnapshot } from '../server/fusion/cost.mjs';
const flush = async () => { for (let count = 0; count < 8; count++) await new Promise(resolve => setImmediate(resolve)); };

function scenario(decide) {
  const run = newFusionRun('test', { id: 'p', root: '/project' }, { app: 'cursor', model: 'Auto', effort: '' });
  run.capabilities = [nativeCostSnapshot('cursor', [{ label: 'Auto' }], null, 1)];
  const scheduler = new FusionScheduler(), calls = [], pending = new Map(), stops = [];
  let decisions = 0;
  const agent = { async execute(currentRun, id, prompt, recovering) {
    const attempt = currentRun.attempts.find(value => value.id === id);
    calls.push({ id, kind: attempt.kind, prompt, recovering, slot: scheduler.slots.get(attempt.app)?.attemptId });
    const native = { threadId: 'main', turnId: id, messageId: id };
    attempt.submission = 'accepted'; attempt.acceptedAt = Date.now();
    if (attempt.kind !== 'decision') return new Promise(resolve => pending.set(id, result => resolve({ text: '实际结果', completed: true, native, ...result })));
    const request = currentRun.decisions.find(value => value.attemptId === id);
    const actions = await decide(currentRun, ++decisions, request);
    return { text: `回复\n\`\`\`fusion-control\n${JSON.stringify({ runId: currentRun.id, decisionId: request.id, actions })}\n\`\`\``, completed: true, native };
  }, reclaimRequests: new Map(), releaseMainProject() {}, async stop(id) { stops.push(id); }, async archive() {}, async recycle() {} };
  const runner = new FusionRunner(run, { agent, scheduler, publish() {} });
  runner.prepareCapabilities = async () => {};
  runner.projectInstructions = async () => '受控项目指令';
  return { run, runner, scheduler, calls, pending, stops, agent };
}
const plan = { type: 'plan', id: 'plan', scope: ['.'], summary: '读取并验证', requiresConfirmation: false, criteria: [{ id: 'C1', text: '实际核对' }] };
const cost = { selfExecute: '未知', delegate: '未知', planning: '一次', review: '一次', contextTransfer: '少量', rework: '未知', reason: '唯一候选', sources: ['cursor:1'],
  alternatives: [{ app: 'cursor', model: 'Auto', effort: '', estimate: '未知', reason: '当前候选' }] };
const dispatch = (id, dependsOn = []) => ({ type: 'dispatch', task: { id, goal: '只读核查', access: 'read', scope: ['.'], acceptance: ['返回证据'], dependsOn },
  execution: { app: 'cursor', model: 'Auto', effort: '', input: '只读任务' }, cost });

test('a same-software child starts after the main decision releases its slot, then the main reviews and finishes', async () => {
  const h = scenario((run, n) => {
    if (n === 1) return [plan, dispatch('B1'), { type: 'wait' }];
    const attempt = run.attempts.find(value => value.taskId === 'B1');
    return [{ type: 'review', taskId: 'B1', attemptId: attempt.id, verdict: 'accept', reason: '证据充分', continueNeeded: false,
      evidence: [{ criterion: 'B1:1', attemptId: attempt.id, detail: '核对输出', reference: 'native result' }] },
    { type: 'finish', summary: '完成核对', evidence: [{ criterion: 'C1', attemptId: attempt.id, detail: '核对通过', reference: 'native result' }] }];
  });
  h.runner.message('读取项目', 'user-1'); await flush();
  assert.deepEqual(h.calls.map(value => value.kind), ['decision', 'task']);
  const child = h.calls[1]; assert.equal(child.slot, child.id);
  h.pending.get(child.id)(); await flush();
  assert.equal(h.run.status, 'completed'); assert.equal(h.run.tasks[0].status, 'accepted');
  assert.equal(h.scheduler.slots.size, 0);
});
test('wait without new events does not call the model again; arrivals during a decision are batched', async () => {
  let release;
  const batches = [];
  const h = scenario((run, count, request) => {
    batches.push(request.eventIds.map(id => run.events.find(event => event.id === id).type));
    if (count === 2) return new Promise(resolve => { release = resolve; });
    return [{ type: 'wait' }];
  });
  h.runner.message('one', 'one'); await flush(); assert.equal(h.calls.length, 1);
  h.runner.wake(); await flush(); assert.equal(h.calls.length, 1);
  h.runner.message('two', 'two'); await flush();
  fusionEvent(h.run, 'task_result', { taskId: 'known' }, 'result'); h.runner.message('three', 'three');
  await flush(); assert.equal(h.calls.length, 2);
  release([{ type: 'wait' }]); await flush();
  assert.equal(h.calls.length, 3); assert.deepEqual(batches[2], ['task_result', 'user']);
  h.runner.message('three', 'three'); await flush(); assert.equal(h.calls.length, 3);
});
test('stop cancels queued work and remains stopping until the actual native target ends', async () => {
  const h = scenario(() => [plan, dispatch('B1'), dispatch('B2', ['B1']), { type: 'wait' }]);
  h.runner.message('任务', 'user'); await flush();
  const child = h.calls.find(value => value.kind === 'task');
  await h.runner.stop(); assert.equal(h.run.status, 'stopping'); assert.deepEqual(h.stops, [child.id]);
  assert.equal(h.run.tasks.find(value => value.id === 'B2').status, 'cancelled');
  h.pending.get(child.id)({ stopped: true, completed: false }); await flush();
  assert.equal(h.run.status, 'stopped'); assert.equal(h.calls.filter(value => value.kind === 'decision').length, 1);
});
test('resuming an unknown native attempt observes it without generating a new task attempt or resending its prompt', async () => {
  const h = scenario(() => [{ type: 'wait' }]);
  h.run.tasks.push({ id: 'B1', access: 'read', executor: 'child', dependsOn: [], status: 'unknown', attemptIds: ['existing'] });
  h.run.attempts.push({ id: 'existing', taskId: 'B1', app: 'cursor', model: 'Auto', effort: '', kind: 'task', status: 'unknown', submission: 'accepted', prompt: 'original prompt', created: Date.now() });
  h.run.status = 'blocked'; h.runner.resume(); await flush();
  assert.equal(h.calls[0].recovering, true); assert.equal(h.calls[0].prompt, 'original prompt');
  h.pending.get('existing')(); await flush();
  assert.equal(h.run.attempts.filter(value => value.taskId === 'B1').length, 1);
  assert.equal(h.run.tasks[0].status, 'awaiting_review');
});
test('an invalid control receipt exposes the reason and stops automatic decision retries', async () => {
  const h = scenario(() => [{ type: 'invented-action' }]);
  h.runner.message('任务', 'user'); await flush();
  assert.equal(h.run.status, 'blocked'); assert.match(h.run.blockedReason, /未知 Fusion 动作/);
  await h.runner.wake(); await flush(); assert.equal(h.calls.length, 1);
});

test('rework appends an attempt and dependent work waits for the accepted replacement result', async () => {
  const h = scenario((run, n) => {
    if (n === 1) return [plan, dispatch('B1'), dispatch('B2', ['B1']), { type: 'wait' }];
    const latest = run.attempts.filter(attempt => attempt.taskId === 'B1').at(-1);
    if (n === 2) return [{ type: 'review', taskId: 'B1', attemptId: latest.id, verdict: 'rework', reason: '缺少一项证据' },
      { type: 'continue_task', taskId: 'B1', execution: { app: 'cursor', model: 'Auto', effort: '', input: '补充证据' }, cost }, { type: 'wait' }];
    if (n === 3) return [{ type: 'review', taskId: 'B1', attemptId: latest.id, verdict: 'accept', reason: '证据已补齐', continueNeeded: false,
      evidence: [{ criterion: 'B1:1', attemptId: latest.id, detail: '补充结果', reference: 'native result' }] }, { type: 'wait' }];
    return [{ type: 'wait' }];
  });
  h.runner.message('两个有依赖的任务', 'user'); await flush();
  const first = h.calls.find(call => call.kind === 'task');
  h.pending.get(first.id)({ text: '第一版结果' }); await flush();
  const replacement = h.calls.filter(call => call.kind === 'task').at(-1);
  assert.notEqual(replacement.id, first.id);
  assert.equal(h.run.attempts.find(attempt => attempt.id === first.id).result.text, '第一版结果');
  assert.equal(h.calls.filter(call => call.kind === 'task').length, 2);
  h.pending.get(replacement.id)({ text: '已补齐证据' }); await flush();
  const dependent = h.calls.filter(call => call.kind === 'task').at(-1);
  assert.equal(h.run.attempts.find(attempt => attempt.id === dependent.id).taskId, 'B2');
  assert.equal(h.run.tasks.find(task => task.id === 'B1').status, 'accepted');
  h.pending.get(dependent.id)(); await flush();
});

test('ask_user waits without spinning and a follow-up produces one new decision', async () => {
  const h = scenario((_run, n) => n === 1 ? [{ type: 'ask_user', question: '请明确验收目标' }] : [plan, { type: 'finish', summary: '回答已确认目标',
    evidence: [{ criterion: 'C1', detail: '主 Agent 的本轮回答', reference: 'native/main/turn' }] }]);
  h.runner.message('需要补充信息', 'initial'); await flush();
  assert.equal(h.run.status, 'awaiting_user');
  await h.runner.wake(); await flush(); assert.equal(h.calls.length, 1);
  h.runner.message('补充验收目标', 'follow-up'); await flush();
  assert.equal(h.calls.length, 2); assert.equal(h.run.status, 'completed');
  assert.equal(h.run.tasks.length, 0);
});

test('a decision queued behind native work batches all events present when its slot starts', async () => {
  const batches = [];
  const h = scenario((_run, _count, request) => { batches.push(request.eventIds); return [{ type: 'wait' }]; });
  let release;
  const occupied = h.scheduler.submit({ app: 'cursor', runId: 'other-project', projectKey: 'other', access: 'read', ready: () => true,
    execute: () => new Promise(resolve => { release = resolve; }) });
  h.runner.message('排队期间的消息', 'user'); await flush();
  fusionEvent(h.run, 'task_result', { taskId: 'B1' }, 'arrived-while-queued');
  release(); await occupied; await flush();
  assert.deepEqual(batches[0], ['user', 'arrived-while-queued']);
  assert.equal(h.calls.length, 1);
});

test('window use includes pending attempts, review, main ownership, and archive work across runs', () => {
  const run = newFusionRun('window-test', { id: 'recycle-project', root: '/project' }, { app: 'cursor', model: 'Auto' });
  const row = { computer: run.computer, projectId: run.project.id, app: 'codex', id: 'child-window' };
  const attempt = { id: 'child-attempt', app: 'codex', taskId: 'B1', status: 'queued' };
  run.attempts.push(attempt); run.tasks.push({ id: 'B1', executor: 'child', status: 'queued' });
  run.bindings.push({ id: 'child', role: 'B1', app: 'codex', windowId: row.id }, { id: 'main', role: 'main', app: 'cursor', windowId: 'ordinary-main' });
  run.main.bindingId = 'main';
  const worker = { run, archiving: new Set() };
  fusionRuns['window-test'] = { runs: [run] }; fusionWorkers.set('window-test', worker);
  try {
    assert.equal(fusionWindowInUse(row), true);
    attempt.status = 'unknown'; assert.equal(fusionWindowInUse(row), true);
    attempt.status = 'awaiting_review'; run.tasks[0].status = 'awaiting_review'; assert.equal(fusionWindowInUse(row), true);
    run.stopRequested = true; run.status = 'stopped'; assert.equal(fusionWindowInUse(row), false);
    attempt.status = 'unknown'; assert.equal(fusionWindowInUse(row), true);
    run.stopRequested = false; run.status = 'running'; attempt.status = 'awaiting_review';
    run.tasks[0].status = 'accepted'; assert.equal(fusionWindowInUse(row), false);
    const other = newFusionRun('other-run', run.project, { app: 'cursor', model: 'Auto' });
    other.tasks.push({ id: 'B1', executor: 'child' });
    other.attempts.push({ id: 'another-attempt', taskId: 'B1', app: 'codex', status: 'queued' });
    fusionRuns['window-test'].runs.push(other); assert.equal(fusionWindowInUse(row), true);
    other.attempts[0].status = 'completed'; assert.equal(fusionWindowInUse(row), false);
    worker.archiving.add('child'); assert.equal(fusionWindowInUse(row), true); worker.archiving.clear();
    run.messages.push({ role: 'human', text: '任务' }); run.status = 'waiting';
    assert.equal(fusionWindowInUse({ ...row, app: 'cursor', id: 'ordinary-main' }), true);
    assert.equal(fusionWindowInUse({ ...row, app: 'cursor' }), false);
    run.status = 'completed'; assert.equal(fusionWindowInUse({ ...row, app: 'cursor', id: 'ordinary-main' }), false);
    attempt.status = 'queued';
    assert.equal(fusionWindowInUse({ ...row, computer: 'another-computer' }), false);
    assert.equal(fusionWindowInUse({ ...row, projectId: 'another-project' }), false);
  } finally { delete fusionRuns['window-test']; fusionWorkers.delete('window-test'); }
});

test('retirement requests cleanup after archive releases its slot and keeps shared work until then', async () => {
  const observed = []; let releaseArchive;
  const h = scenario((run, count) => {
    if (count === 1) return [plan, dispatch('B1'), { type: 'wait' }];
    const attempt = run.attempts.find(a => a.taskId === 'B1');
    return [{ type: 'review', taskId: 'B1', attemptId: attempt.id, verdict: 'accept', reason: '完成', continueNeeded: false,
      evidence: [{ criterion: 'B1:1', attemptId: attempt.id, detail: '输出已核对', reference: 'native result' }] },
      { type: 'finish', summary: '完成', evidence: [{ criterion: 'C1', attemptId: attempt.id, detail: '完成', reference: 'native result' }] }];
  });
  const row = { computer: h.run.computer, projectId: h.run.project.id, app: 'cursor' };
  h.agent.archive = async () => new Promise(resolve => { releaseArchive = resolve; });
  h.agent.recycle = async (_run, app) => { if (app === 'cursor') observed.push({ needed: fusionWindowInUse(row), slot: h.scheduler.slots.has(app) }); };
  fusionWorkers.set('cleanup-order', h.runner);
  try {
    h.runner.message('只读任务', 'user'); await flush();
    const attempt = h.run.attempts.find(a => a.taskId === 'B1');
    attempt.bindingId = 'child'; h.run.bindings.push({ id: 'child', app: 'cursor', threadId: 'native-child' });
    h.pending.get(attempt.id)(); await flush();
    assert.equal(h.run.status, 'completed'); assert.equal(h.runner.archiving.has('child'), true);
    assert.equal(fusionWindowInUse(row), true);
    releaseArchive(); await flush();
    assert.equal(h.runner.archiving.size, 0);
    assert.equal(observed.at(-1).needed, false);
    assert.ok(observed.every(value => value.slot));
    assert.equal(h.scheduler.slots.size, 0);
  } finally { fusionWorkers.delete('cleanup-order'); }
});
