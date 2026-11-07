import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { applyFusionControl, fusionTaskPrompt } from '../server/fusion/control.mjs';
import { fixture } from './fusion-fixture.mjs';

test('Fusion refreshes only its idle native thread instructions and keeps ordinary sends and actual model permissions intact', async () => {
  const source=fs.readFileSync(new URL('../server/page/session-actions.js',import.meta.url),'utf8');
  const calls=[],originalToolCalls=[],settings={model:'native-user-model',effort:'max',cwd:'/actual-project',serviceTier:null};
  const permissions={approvalPolicy:'on-request',approvalsReviewer:'auto_review',activePermissionProfile:{id:':workspace'},runtimeWorkspaceRoots:['/actual-project']};
  let busy=true;const conversation={latestThreadSettings:settings,currentPermissions:permissions};
  const manager={hostId:'local',getConversation:()=>conversation,isConversationStreaming:()=>busy,
    requestClient:{sendRequest(method,params){calls.push({method,params});return Promise.resolve({});}},
    threadExecution:{executeDynamicToolCall(request){originalToolCalls.push(request);}}};
  const context=vm.createContext({window:{},Map,WeakMap,Set,JSON,nativeValue:structuredClone,codexConversationManager:()=>manager,codexHistoryScopes:()=>[],remoteContext:{host:'local'}});
  const start=source.indexOf('  const nativeSessionAction ='),end=source.indexOf('  const nativeSessionRenameInput',start);
  vm.runInContext(source.slice(start,end)+';this.act=nativeSessionAction;',context);
  const spec={names:['ra_fusion'],authorization:{kind:'application',value:'current policy'},instructions:'Current Fusion instructions'};
  let result=await context.act('codex','fusion-main','bindTools',spec);assert.equal(result.profileReady,false);assert.equal(calls.length,0);
  const ordinary={threadId:'ordinary',input:[{type:'text',text:'keep my input'}],model:'ordinary-model',effort:'low',additionalContext:{existing:{kind:'application',value:'keep'}}};
  await manager.requestClient.sendRequest('turn/start',ordinary);assert.equal(calls[0].params,ordinary);assert.equal(calls[0].method,'turn/start');
  busy=false;result=await context.act('codex','fusion-main','bindTools',spec);assert.equal(result.profileReady,true);
  const update=calls[1];assert.equal(update.method,'thread/resume');assert.equal(update.params.threadId,'fusion-main');assert.equal(update.params.developerInstructions,spec.instructions);
  assert.equal(update.params.model,settings.model);assert.equal(update.params.config.model_reasoning_effort,'max');assert.equal(update.params.permissions,':workspace');assert.equal(update.params.approvalsReviewer,'auto_review');
  assert.deepEqual(update.params.runtimeWorkspaceRoots,permissions.runtimeWorkspaceRoots);assert.equal('dynamicTools' in update.params,false);assert.equal('input' in update.params,false);
  await context.act('codex','fusion-main','bindTools',spec);assert.equal(calls.length,2);
  const main={...ordinary,threadId:'fusion-main'};await manager.requestClient.sendRequest('turn/start',main);
  assert.equal(calls[2].params.model,main.model);assert.equal(calls[2].params.effort,main.effort);assert.deepEqual(calls[2].params.input,main.input);
  assert.equal(calls[2].params.additionalContext.ra_fusion_user_authorization,spec.authorization);assert.equal(calls[2].params.additionalContext.existing,ordinary.additionalContext.existing);
  manager.threadExecution.executeDynamicToolCall({params:{threadId:'ordinary',tool:'ordinary-tool'}});assert.equal(originalToolCalls.length,1);
  await context.act('codex','fusion-main','unbindTools');await manager.requestClient.sendRequest('turn/start',ordinary);assert.equal(calls.at(-1).params,ordinary);
});

test('a related new task can select a retained Worker without changing earlier task or execution facts', () => {
  const h = fixture(), firstWork = h.create(); h.plan(firstWork);
  const first = h.apply({ action: 'dispatch', workId: firstWork, tasks: [h.task('first')] }).tasks[0];
  const worker = h.run.agents.find(row => row.id === first.workerId), attempt = h.run.attempts[0];
  worker.bindingId = 'retained-binding';
  h.run.bindings.push({ id: worker.bindingId, role: 'worker', app: 'codex', project: h.project, threadId: 'retained-native' });
  Object.assign(attempt, { bindingId: worker.bindingId, status: 'accepted', endedAt: 20, result: { completed: true, text: 'Original evidence' } });
  h.run.tasks[0].status = 'accepted';
  const old = structuredClone({ task: h.run.tasks[0], attempt, assignment: h.run.assignments[0] });
  const secondWork = h.create(); h.plan(secondWork);
  const result = h.apply({ action: 'dispatch', workId: secondWork, tasks: [h.task('related')],
    input: JSON.stringify({ related: { workerId: worker.id, reason: 'Retain the invoice analysis context' } }) }).tasks[0];
  assert.equal(h.run.agents.length, 1); assert.equal(result.workerId, worker.id);
  assert.notEqual(result.attemptId, first.attemptId); assert.equal(h.run.tasks[1].workId, secondWork);
  assert.deepEqual({ task: h.run.tasks[0], attempt: h.run.attempts[0], assignment: h.run.assignments[0] }, old);
  const board = h.apply({ action: 'read_workspace' });
  assert.deepEqual(board.agents[0].taskIds, ['first', 'related']); assert.equal(board.agents[0].project.id, h.project.id);
  const savedBinding = h.run.agents[0].bindingId;
  h.run.agents[0].bindingId = 'a-later-binding';
  assert.equal(h.apply({ action: 'read_task', taskId: 'first' }).binding.id, savedBinding);
});
test('dispatch requires an explicit per-task resource choice and rejects unrelated workers atomically', () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  assert.throws(() => applyFusionControl(h.run, { action: 'dispatch', workId, tasks: [h.task('A')] }, h.native()), /input/);
  h.apply({ action: 'dispatch', workId, tasks: [h.task('A')] });
  const worker = h.run.agents[0], before = JSON.stringify(h.run);
  const select = workerId => JSON.stringify({ B: { workerId, reason: 'A deliberate resource decision' } });
  assert.throws(() => h.apply({ action: 'dispatch', workId, tasks: [h.task('B')], input: select('missing') }), /不存在/);
  assert.throws(() => h.apply({ action: 'dispatch', workId, tasks: [h.task('B', 'cursor')], input: select(worker.id) }), /同一软件/);
  assert.equal(JSON.stringify(h.run), before);
  const other = h.create(); h.run.works.find(row => row.id === other).project = { ...h.project, id: 'other-host-project', host: 'other-host' }; h.plan(other);
  const beforeOther = JSON.stringify(h.run);
  assert.throws(() => h.apply({ action: 'dispatch', workId: other, tasks: [h.task('B')], input: select(worker.id) }), /实际项目/);
  assert.equal(JSON.stringify(h.run), beforeOther);
});
test('plan reports all missing fields and cannot silently consume a dispatch task list', () => {
  const h = fixture(), workId = h.create();
  assert.throws(() => h.apply({ action: 'plan', workId }), error => ['summary', 'scope', 'criteria', 'requiresConfirmation'].every(field => error.message.includes(field)));
  assert.throws(() => h.apply({ action: 'plan', workId, summary: 'Scope', scope: ['.'], criteria: [{ id: 'C', text: 'Evidence' }],
    requiresConfirmation: false, tasks: [h.task('A')] }), /plan.*dispatch/);
  assert.equal(h.run.tasks.length, 0); assert.equal(h.run.works[0].plans.length, 0);
});
test('review evidence uses its selected completed Attempt without requiring duplicated nested identity', () => {
  const h = fixture(), workId = h.create(); h.plan(workId); h.apply({ action: 'dispatch', workId, tasks: [h.task('A')] });
  const attempt = h.run.attempts[0]; Object.assign(attempt, { status: 'awaiting_review', endedAt: 20, result: { completed: true, text: 'Verified 62.70' } });
  h.apply({ action: 'review', taskId: 'A', attemptId: attempt.id, verdict: 'accept', reason: 'Recomputed from raw input',
    evidence: [{ criterion: 'A:1', detail: 'Independent result is 62.70', reference: 'native result' }] });
  assert.equal(h.run.tasks[0].status, 'accepted');
  assert.equal(h.run.tasks[0].reviews[0].evidence[0].attemptId, attempt.id);
  assert.equal(h.run.tasks[0].reviews[0].evidence[0].detail, 'Independent result is 62.70');
});

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
  const workspace = h.apply({ action: 'read_workspace' });
  assert.equal(typeof workspace.scheduling, 'string'); assert(workspace.scheduling.length > 0);
  assert.deepEqual(workspace.tasks.find(task => task.id === 'A').dependsOn, ['B']);
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

test('workspace and task evidence indexes exclude binary patches and long replies without changing stored facts', () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  h.apply({ action: 'dispatch', workId, tasks: [h.task('image')] });
  const attempt = h.run.attempts[0];
  const binary = 'diff --git a/image.png b/image.png\nGIT binary patch\nliteral 500000\n' + 'binary-payload'.repeat(100000) + '\n';
  Object.assign(attempt, { status: 'awaiting_review', endedAt: 20, result: { text: 'reply-text'.repeat(200000), completed: true, error: '' },
    changes: { available: true, diff: binary, files: [{ path: 'image.png', sha256: 'after' }] },
    baseline: { available: true, diff: binary, files: [{ path: 'image.png', sha256: 'before' }] } });
  // Includes a pending event persisted by the previous producer, still backed by the same Attempt.
  h.run.events.push({ id: 'pending-image', type: 'task_result', data: { workId, taskId: 'image', attemptId: attempt.id,
    result: attempt.result, changes: attempt.changes }, deliveredTo: '' });
  const before = structuredClone(h.run);
  const workspace = h.apply({ action: 'read_workspace' }), task = h.apply({ action: 'read_task', taskId: 'image' });
  for (const view of [workspace, task]) {
    const json = JSON.stringify(view);
    assert(json.length < 15000); assert(!json.includes('binary-payload')); assert(!json.includes('GIT binary patch'));
  }
  const event = workspace.events[0];
  assert.equal(event.id, 'pending-image'); assert.equal(event.data.attemptId, attempt.id);
  assert.deepEqual(event.data.evidence.read, { action: 'read_task', taskId: 'image', attemptId: attempt.id });
  assert.equal('changes' in event.data.evidence, false);
  assert.equal(task.attempts[0].result.text.characters, attempt.result.text.length);
  assert.equal(task.attempts[0].changes.diff.files[0].binary, true);
  assert.equal(task.attempts[0].baseline.files[0].sha256, 'before');
  assert.deepEqual(h.run, before); // Reading and summarizing do not acknowledge, accept or replace evidence.
});

test('workspace summaries keep complete pending user input and retrieve full task and model details on demand', () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  h.apply({ action: 'dispatch', workId, tasks: [h.task('A')] });
  const task = h.run.tasks[0], text = '完整用户补充，不截断。'.repeat(1000);
  task.inputs.push({ id: 'user-supplement', text, deliveredAt: null });
  h.run.events.push({ id: 'user-supplement', type: 'user_input', data: { workId, taskId: task.id, text }, deliveredTo: '' });
  const before = structuredClone(h.run), workspace = h.apply({ action: 'read_workspace' });
  assert.equal(workspace.events[0].data.text, text);
  assert.deepEqual(workspace.tasks[0].pendingInputIds, ['user-supplement']);
  assert.equal('inputs' in workspace.tasks[0], false); assert.equal('reviews' in workspace.tasks[0], false);
  assert.equal('models' in workspace.capabilities[0], false);
  assert.equal(workspace.capabilities[0].modelCount, h.run.capabilities[0].models.length);
  assert.deepEqual(h.apply({ action: 'list_models', app: 'codex' }), h.run.capabilities[0]);
  assert.deepEqual(h.apply({ action: 'read_task', taskId: task.id }).task, task);
  assert.deepEqual(h.run, before);
});
test('child requests keep authorized scope, acceptance, exact new input and rework without embedding unrelated plans or dependency replies', () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  h.apply({ action: 'dispatch', workId, tasks: [h.task('A'), h.task('B', 'codex', ['A'])] });
  const [upstream, attempt] = h.run.attempts, task = h.run.tasks[1], assignment = h.run.assignments[1];
  upstream.result = { text: 'large-upstream-report'.repeat(10000), completed: true };
  h.run.tasks[0].status = 'accepted';
  task.inputs.push({ id: 'old', text: 'old unrelated supplement', deliveredAt: 1 }, { id: 'new', text: '完整的新补充\n保留换行', deliveredAt: null });
  attempt.inputIds = ['new'];
  task.reviews.push({ verdict: 'accept', reason: 'old review' }, { verdict: 'rework', reason: 'Recheck evidence', evidence: [] });
  assignment.input = '上游截图位于 _shots/phone.png；只修改 README 的相应图片。';
  h.run.works[0].plans[0].summary = 'unrelated-whole-plan'.repeat(1000);
  const before = structuredClone(h.run), prompt = fusionTaskPrompt(h.run, task, attempt), payload = JSON.parse(prompt.slice(prompt.indexOf('{')));
  assert.deepEqual(payload.scope, task.scope); assert.deepEqual(payload.acceptance, task.acceptance); assert.equal(payload.access, task.access);
  assert.equal(payload.input, assignment.input); assert.equal(payload.planId, assignment.planId);
  assert.deepEqual(payload.inputs, [{ id: 'new', text: '完整的新补充\n保留换行' }]);
  assert.deepEqual(payload.review, task.reviews.at(-1));
  assert.deepEqual(payload.dependencies, [{ id: 'A', goal: h.run.tasks[0].goal, status: 'accepted' }]);
  assert(!prompt.includes('large-upstream-report')); assert(!prompt.includes('unrelated-whole-plan')); assert(!prompt.includes('old unrelated supplement'));
  assert.equal(payload.attemptId, attempt.id); assert.deepEqual(h.run, before);
});

test('read_task pages exact reply and text diffs by Attempt, while binary evidence stays a file reference', () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  h.apply({ action: 'dispatch', workId, tasks: [h.task('evidence')] });
  const attempt = h.run.attempts[0], text = 'diff --git a/read me.md b/read me.md\n--- a/read me.md\n+++ b/read me.md\n@@ -1 +1 @@\n-old\n+新内容\n';
  const binary = 'diff --git a/image.png b/image.png\nGIT binary patch\nliteral 5\nbytes\n';
  attempt.result = { text: 'exact reply\n'.repeat(1500), completed: true };
  attempt.changes = { diff: text + binary }; attempt.baseline = { diff: text.replace('+新内容', '+before') };
  h.run.attempts.push({ ...attempt, id: 'newer-attempt', result: { text: 'new reply' } });
  const read = query => h.apply({ action: 'read_task', taskId: 'evidence', attemptId: attempt.id, ...(query ? { input: JSON.stringify(query) } : {}) });
  const index = read(); assert.equal(index.attempts[0].id, attempt.id);
  const reference = index.attempts[0].result.text.read;
  let reply = '', offset = 0;
  do {
    const page = h.apply({ ...reference, input: JSON.stringify({ ...JSON.parse(reference.input), offset }) });
    assert.equal(page.totalCharacters, attempt.result.text.length);
    reply += page.text; offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(reply, attempt.result.text);
  const file = index.attempts[0].changes.diff.files[0];
  const page = h.apply({ ...file.read, input: JSON.stringify({ ...JSON.parse(file.read.input), offset: 13, length: 23 }) });
  assert.equal(page.text, text.slice(13, 36)); assert.equal(page.nextOffset, 36);
  assert.equal(read({ section: 'diff', snapshot: 'baseline', fileIndex: 0 }).text, attempt.baseline.diff);
  const image = read({ section: 'diff', fileIndex: 1 });
  assert.equal(image.binary, true); assert.match(image.header, /image.png/); assert.equal(image.text, undefined);
  assert.throws(() => read({ section: 'diff', fileIndex: 9 }), /差异文件/);
  assert.throws(() => read({ section: 'result', offset: -1 }), /offset/);
  assert.throws(() => read({ section: 'result', length: 0 }), /length/);
  assert.throws(() => read({ section: 'invented' }), /证据类型/);
  assert.throws(() => h.apply({ ...reference, input: '{invalid' }), /JSON/);
  assert.throws(() => h.apply({ ...reference, input: 'null' }), /JSON 对象/);
  assert.throws(() => h.apply({ ...reference, attemptId: 'other-task' }), /不属于/);
});

const { FUSION_OWNER, fusionRunView, fusionControllerView } = await import('../server/fusion/owner.mjs');

test('main interaction projection keeps one question text, its native origin and the actual answer without mutating history', () => {
  const h = fixture(), workId = h.create(); h.plan(workId, true);
  const id = h.apply({ action: 'ask_user', workId, question: 'Canonical scope and criteria?', options: ['Approve', 'Change'] }).questionId;
  h.run.attempts.push({ kind: 'main', native: { threadId: 'main-thread', turnId: 'native-turn', messageId: 'proposal-message' } });
  const question = h.run.questions.find(row => row.id === id);
  Object.assign(question, { answeredAt: 20, answer: 'Approve with model Sol', inputId: 'native-answer' });
  h.run.events.push({ id: 'native-answer', type: 'user_input', data: { native: { threadId: 'main-thread', turnId: 'reply-turn', messageId: 'reply-message' } } });
  const before = JSON.stringify(h.run), board = fusionRunView(h.run, { kind: 'tasks' });
  assert.equal(board.questions.length, 1); assert.equal(board.questions[0].text, question.text);
  assert.equal(board.questions[0].native.messageId, 'proposal-message'); assert.equal(board.questions[0].answerNative.messageId, 'reply-message');
  assert.equal(board.works[0].plans[0].native.messageId, 'proposal-message');
  assert.deepEqual(fusionControllerView(h.run).overview.attention.map(row => row.kind), ['plan']);
  assert.equal(JSON.stringify(h.run), before);
});
const { fusionLive, fusionViewers, fusionRuns, fusionWorkers, savedFusion, findFusionRun, publishFusion } = await import('../server/fusion/state.mjs');
function largeViewFixture() {
  const h = fixture(), workId = h.create(); h.plan(workId);
  h.apply({ action: 'dispatch', workId, tasks: [h.task('view-task')] });
  const attempt = h.run.attempts[0], bindingId = 'view-binding';
  Object.assign(attempt, { bindingId, result: { text: 'result'.repeat(100000) }, changes: { diff: '+exact diff\n'.repeat(100000) }, baseline: { head: 'native-head' } });
  h.run.agents[0].bindingId = bindingId;
  h.run.bindings.push({ id: bindingId, role: 'worker', app: 'codex', threadId: 'native-child', windowId: 'native-window', project: h.project });
  h.run.events.push({ id: 'result-event', type: 'task_result', data: { attemptId: attempt.id, changes: attempt.changes } });
  h.run.works[0].deliveries.push({ summary: 'verified', evidence: [{ detail: 'evidence\n'.repeat(100000) }], mainAttemptId: attempt.id });
  h.run.attempts.push({ ...attempt, id: 'latest-attempt', result: { text: 'new result' } });
  h.run.tasks[0].status = 'awaiting_user';
  fusionLive.set(bindingId, { state: { waiting: 'approval' }, chat: { items: [{ i: 'body', k: 'assistant', t: 'live'.repeat(100000) },
    { i: 'native-action', b: ['Allow'], actions: ['allow-once'], btnItem: 'native-button' }],
    questions: { codex: true, requests: [{ id: 'approval', text: 'Approval', fields: [], buttons: [{ label: 'Allow' }] }] } } });
  return { ...h, workId, attempt, bindingId };
}
test('Fusion summary and selected views omit full history, diffs and repeated native transcripts', t => {
  const h = largeViewFixture(); t.after(() => fusionLive.delete(h.bindingId));
  for (const view of [{ kind: 'config' }, { kind: 'tasks' }, { kind: 'task', taskId: 'view-task' }, { kind: 'input' }]) {
    const result = fusionRunView(h.run, view), raw = JSON.stringify(result);
    assert(Buffer.byteLength(raw) < 20000, view.kind + ' must remain a small projection');
    assert(!raw.includes('+exact diff')); assert(!raw.includes('resultresult')); assert(!raw.includes('livelive'));
  }
  const task = fusionRunView(h.run, { kind: 'task', taskId: 'view-task' });
  assert.equal(task.attempts[0].live, undefined); assert.equal(task.attempts[1].live, undefined);
  assert.equal(task.board.nativeInteractions[0].items.length, 0);
  assert.equal(task.board.nativeInteractions[0].requests[0].id, 'approval');
  assert.equal(fusionControllerView(h.run).tasks.total, 1);
});
test('explicit audit reads preserve exact full diffs, native identity and delivery evidence', t => {
  const h = largeViewFixture(); t.after(() => fusionLive.delete(h.bindingId));
  const audit = fusionRunView(h.run, { kind: 'attempt', attemptId: h.attempt.id });
  assert.equal(audit.changes.diff, h.attempt.changes.diff); assert.deepEqual(audit.baseline, h.attempt.baseline);
  assert.deepEqual(audit.result, h.attempt.result); assert.equal(audit.events[0].data.changes.diff, h.attempt.changes.diff);
  assert.deepEqual(fusionRunView(h.run, { kind: 'delivery', workId: h.workId, index: 0 }), h.run.works[0].deliveries[0]);
  assert.deepEqual(fusionRunView(h.run, { kind: 'reviews', taskId: 'view-task' }).reviews, h.run.tasks[0].reviews);
});
test('UI summaries expose real agent assignments and dispatch identity without loading task inputs or evidence', t => {
  const h = largeViewFixture(); t.after(() => fusionLive.delete(h.bindingId));
  const task = h.run.tasks[0], command = h.run.commands.find(row => row.action === 'dispatch');
  task.inputs.push({ id: 'supplement', text: 'private-input-'.repeat(10000) });
  h.run.assignments[0].input = 'assignment-input-'.repeat(10000);
  h.run.attempts.push({ id: 'main-observation', kind: 'main', native: { ...command.native, messageId: 'real-human-message' } });
  const before = structuredClone(h.run), summary = fusionControllerView(h.run), board = fusionRunView(h.run, { kind: 'tasks' });
  const detail = fusionRunView(h.run, { kind: 'task', taskId: task.id });
  assert.equal(summary.overview.state, 'wait'); assert.equal(summary.overview.attention[0].taskId, task.id);
  assert.equal(board.tasks[0].workerId, task.workerId); assert.equal(board.tasks[0].model, h.run.assignments[0].model);
  assert.equal(board.tasks[0].access, task.access); assert.equal(board.dispatches[0].native.messageId, 'real-human-message');
  assert.equal(board.dispatches[0].tasks[0].attemptId, h.attempt.id);
  for (const value of [summary, board, detail]) {
    const raw = JSON.stringify(value);
    assert(!raw.includes('private-input-')); assert(!raw.includes('assignment-input-')); assert(!raw.includes('+exact diff'));
  }
  assert.equal(detail.tasks[0].inputs, undefined); assert.equal(detail.tasks[0].summary.text, 'new result');
  assert.equal(board.tasks[0].summary, undefined); assert.deepEqual(h.run, before);
});
test('explicit input reads return complete original data and leave the selected task subscription in place', t => {
  const h = largeViewFixture(); t.after(() => fusionLive.delete(h.bindingId));
  h.run.tasks[0].inputs.push({ id: 'input', text: 'exact-input'.repeat(5000), deliveredAt: null });
  const viewer = { emit() {} }, read = view => FUSION_OWNER.fusionRead.call(viewer, {
    runId: h.run.id, view, taskId: 'view-task', requestId: view,
  });
  read('task'); const before = structuredClone(h.run); read('inputs');
  assert.equal(viewer.fusionDetail.view.subscriptionId, 'task');
  const value = fusionRunView(h.run, { kind: 'inputs', taskId: 'view-task' });
  assert.deepEqual(value.inputs, h.run.tasks[0].inputs); assert.equal(value.assignments[0].input, h.run.assignments[0].input);
  assert.deepEqual(h.run, before);
});
test('task progress separates receipt, generation and delivery and does not guess directory change counts', t => {
  const h = largeViewFixture(); t.after(() => fusionLive.delete(h.bindingId));
  const attempt = h.run.attempts.at(-1);
  Object.assign(attempt, { submission: 'accepted', acceptedAt: 10, endedAt: 20, durationMs: 10,
    result: { text: '', error: 'native failure', completed: false },
    baseline: { available: true, files: [{ path: 'a.md', exists: true, sha256: 'before' }] },
    changes: { available: true, files: [{ path: 'a.md', exists: true, sha256: 'after' }] } });
  const selected = () => fusionRunView(h.run, { kind: 'task', taskId: 'view-task' }).tasks[0].summary;
  assert.equal(selected().files, 1); assert.equal(selected().submission, 'accepted');
  assert.equal(selected().completed, false); assert.equal(selected().delivered, false); assert.equal(selected().durationMs, 10);
  attempt.changes.files.push({ path: '.', exists: true, directory: true });
  assert.equal(selected().files, null);
});
test('detail subscriptions follow the requested view; audit reads and obsolete closes cannot replace it', t => {
  const h = largeViewFixture(), messages = [], viewer = { deviceId: 'test', emit: message => messages.push(message) };
  fusionViewers.add(viewer); t.after(() => { fusionViewers.delete(viewer); fusionLive.delete(h.bindingId); });
  const read = (view, requestId, ids = {}) => FUSION_OWNER.fusionRead.call(viewer, { computer: h.run.computer, runId: h.run.id, view, requestId, ...ids });
  read('tasks', 'list'); read('task', 'selected', { taskId: 'view-task' });
  read('attempt', 'audit', { attemptId: h.attempt.id });
  assert.equal(viewer.fusionDetail.view.subscriptionId, 'selected');
  read('close', 'close-old', { subscriptionId: 'list' });
  messages.length = 0; publishFusion(h.run, false);
  assert.deepEqual(messages.map(m => m.t), ['fusionUpdate', 'fusionState']);
  assert.equal(messages[1].view.kind, 'task'); assert.equal(messages[1].view.subscriptionId, 'selected');
  read('close', 'close-selected', { subscriptionId: 'selected' });
  messages.length = 0; publishFusion(h.run, false);
  assert.deepEqual(messages.map(m => m.t), ['fusionUpdate']);
});
test('a configuration receipt cannot take back a newer task subscription', async () => {
  const h = fixture(), workId = h.create(); h.plan(workId); h.apply({ action: 'dispatch', workId, tasks: [h.task('current-task')] });
  const viewer = { deviceId: 'test', emit() {} };
  FUSION_OWNER.fusionRead.call(viewer, { runId: h.run.id, view: 'task', taskId: 'current-task', requestId: 'current-view' });
  await FUSION_OWNER.fusionConfigure.call(viewer, { runId: h.run.id, view: 'config', subscriptionId: 'old-config', requestId: 'old-save' });
  assert.equal(viewer.fusionDetail.view.kind, 'task'); assert.equal(viewer.fusionDetail.view.subscriptionId, 'current-view');
});
test('every paired entry reads the same computer history without copying or changing its creator facts', async t => {
  const h = fixture(), messages = [], phone = 'paired-phone-' + h.run.id;
  const viewer = { deviceId: phone, emit: message => messages.push(message) };
  const before = structuredClone(h.run);
  t.after(() => { delete fusionRuns[phone]; });
  FUSION_OWNER.fusionWorkspace.call(viewer);
  assert(messages.at(-1).runs.some(run => run.id === h.run.id));
  assert.equal(messages.at(-1).current, '');
  FUSION_OWNER.fusionRead.call(viewer, { computer: h.run.computer, runId: h.run.id, view: 'tasks', requestId: 'phone-history' });
  assert.equal(messages.at(-1).run.id, h.run.id);
  assert.equal(findFusionRun(h.run.id), h.run);
  assert.deepEqual(h.run, before);
  const { overviewSnapshot } = await import('../server/overview.mjs');
  const creator = overviewSnapshot(h.run.deviceId), visitor = overviewSnapshot(phone);
  assert(visitor.fusion.some(run => run.id === h.run.id));
  assert.deepEqual(visitor.fusion, creator.fusion);
  assert.deepEqual(visitor.sessions, creator.sessions);
});
test('a different paired entry opens the original main binding and retains only its own recent selection', async t => {
  const h = fixture(), phone = 'paired-phone-' + h.run.id, requests = [];
  const { adapter } = await import('../server/apps/fusion.mjs');
  const before = structuredClone(h.run);
  t.after(() => { delete fusionRuns[phone]; });
  await adapter.attach.call({ deviceId: phone, attach: request => requests.push(request) }, { threadId: h.run.id });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].threadId, h.run.bindings[0].threadId);
  assert.equal(requests[0].windowId, h.run.bindings[0].windowId);
  assert.equal(savedFusion(phone).current, h.run.id);
  assert.deepEqual(savedFusion(phone).runs, []);
  assert.deepEqual(h.run, before);
});
test('paired entries share updates and inputs on one existing runner while closing only their own view', async t => {
  const h = fixture(), workId = h.create(), phone = 'paired-phone-' + h.run.id;
  const creatorMessages = [], phoneMessages = [];
  const creator = { deviceId: h.run.deviceId, emit: message => creatorMessages.push(message) };
  const viewer = { deviceId: phone, emit: message => phoneMessages.push(message) };
  fusionViewers.add(creator); fusionViewers.add(viewer);
  const { fusionRunner } = await import('../server/fusion/runner.mjs');
  const runner = fusionRunner(h.run); runner.wake = () => {};
  t.after(() => {
    fusionViewers.delete(creator); fusionViewers.delete(viewer); delete fusionRuns[phone];
    for (const [key, value] of fusionWorkers) if (value === runner) fusionWorkers.delete(key);
  });
  for (const entry of [creator, viewer]) FUSION_OWNER.fusionRead.call(entry, {
    computer: h.run.computer, runId: h.run.id, view: 'tasks', requestId: entry.deviceId,
  });
  creatorMessages.length = phoneMessages.length = 0;
  publishFusion(h.run, false);
  assert.deepEqual(creatorMessages.map(message => message.t), ['fusionUpdate', 'fusionState']);
  assert.deepEqual(phoneMessages.map(message => message.t), ['fusionUpdate', 'fusionState']);
  assert.equal(phoneMessages[1].view.subscriptionId, phone);
  FUSION_OWNER.fusionRead.call(viewer, { runId: h.run.id, view: 'close', subscriptionId: phone, requestId: 'close-phone' });
  creatorMessages.length = phoneMessages.length = 0;
  publishFusion(h.run, false);
  assert.deepEqual(creatorMessages.map(message => message.t), ['fusionUpdate', 'fusionState']);
  assert.deepEqual(phoneMessages.map(message => message.t), ['fusionUpdate']);
  FUSION_OWNER.fusionInput.call(viewer, { computer: h.run.computer, runId: h.run.id, workId, text: 'Continue the same work', requestId: 'phone-followup' });
  assert.equal(h.run.events.at(-1).data.workId, workId);
  assert.equal(h.run.events.at(-1).data.text, 'Continue the same work');
  assert.equal(fusionRunner(findFusionRun(h.run.id)), runner);
  assert.equal(h.run.deviceId, creator.deviceId);
  assert.equal(fusionRuns[creator.deviceId].runs[0], h.run);
  assert.equal(h.run.attempts.length, 0);
});

test('child plans do not require main scope or reserve main costs and preserve actual native identity', () => {
  const h=fixture(),workId=h.create(),native={...h.native(),callId:'native-plan-item'};
  const action={action:'plan',workId,summary:'Delegate review',scope:['src'],criteria:[{id:'C',text:'Real result'}],requiresConfirmation:false};
  applyFusionControl(h.run,action,native);const plan=h.run.works[0].plans[0];
  assert.equal('mainScope' in plan,false);assert.equal('cost' in plan,false);
  assert.equal(fusionRunView(h.run,{kind:'tasks'}).works[0].plans[0].native.callId,'native-plan-item');
  assert.equal(h.run.tasks.length,0);assert.equal(h.run.assignments.length,0);
  assert.throws(()=>h.apply({action:'self_execute',workId}),/未知/);
});
test('explicit budgets still include previously confirmed main cost facts before a child is dispatched', () => {
  const h=fixture(),workId=h.create();h.plan(workId);h.run.capabilities.find(row=>row.app==='codex').models[0].pricing={unit:'credits'};h.run.budget={limit:10,unit:'credits'};
  Object.assign(h.run.works[0].plans[0],{mainScope:['historical-main-file'],cost:{...h.cost('codex'),estimate:{amount:6,unit:'credits'}}});
  const child={...h.task('child'),cost:{...h.cost('codex'),estimate:{amount:5,unit:'credits'}}};
  assert.throws(()=>h.apply({action:'dispatch',workId,tasks:[child]}),/超过用户预算/);assert.equal(h.run.assignments.length,0);assert.equal(h.run.tasks.length,0);
});

test('ordinary message buttons never become native interactions and native approval keeps its actual task and request', t => {
  const h=largeViewFixture();t.after(()=>fusionLive.delete(h.bindingId));
  let board=fusionRunView(h.run,{kind:'tasks'});
  assert.equal(board.nativeInteractions.length,1);assert.equal(board.nativeInteractions[0].taskId,'view-task');
  assert.equal(board.nativeInteractions[0].requests[0].id,'approval');assert.equal(board.nativeInteractions[0].items.length,0);
  fusionLive.set(h.bindingId,{state:{},chat:{items:[{i:'copy',b:['Copy message','Fork chat from here']}]}});
  assert.equal(fusionRunView(h.run,{kind:'tasks'}).nativeInteractions.length,0);
  fusionLive.set(h.bindingId,{state:{waiting:'native-item:Allow'},chat:{items:[{i:'native-item',b:['Copy message','Allow'],actions:['copy','allow']} ]}});
  const item=fusionRunView(h.run,{kind:'tasks'}).nativeInteractions[0].items[0];
  assert.deepEqual(item.buttons,[{label:'Allow',n:1,actionId:'allow'}]);
  h.run.attempts.at(-1).endedAt=30;
  assert.equal(fusionRunView(h.run,{kind:'tasks'}).nativeInteractions.length,0);
});
test('pending interaction stays after new output and completed cards use the actual native tool position', () => {
  const source=fs.readFileSync(new URL('../app/js/fusion.js',import.meta.url),'utf8');
  const run={id:'run',computer:'computer'},plan={id:'plan',created:1,confirmed:false,requiresConfirmation:true,native:{threadId:'thread',messageId:'old',callId:'call'}};
  const board={dispatches:[],questions:[],nativeInteractions:[],works:[{id:'work',plans:[plan]}]};
  const nodes=new Map(),context=vm.createContext({currentFusionRun:()=>run,fusionBoards:new Map([['computer|run',board]]),fusionStateKey:(c,r)=>c+'|'+r,
    fusionDispatchCards:new Map(),fusionInteractionCards:nodes,fusionFocusInteraction:'',fusionPendingGroup:null,deferredScrollRender:false,
    fusionInteractionNode(_r,_w,kind,item){const k='computer|run|'+kind+':'+item.id;if(!nodes.has(k))nodes.set(k,{id:item.id});return nodes.get(k);},
    document:{createElement:()=>({setAttribute(){},children:[]})},I18N:{tr:s=>s},syncChildren:(parent,children)=>{parent.children=children;},queueMicrotask(){}});
  const a=source.indexOf('function fusionChatAnchor('),b=source.indexOf('function fusionNativeNode(',a);
  const c=source.indexOf('function fusionChatRows('),d=source.indexOf('function fusionStateBadge(',c);
  vm.runInContext(source.slice(a,b)+source.slice(c,d)+';this.paint=fusionChatRows;',context);
  const items=[{i:'user',k:'human',nativeIds:['old']},{i:'thread:dynamic-tool-call:call',k:'tool'},{i:'reply',k:'assistant'}];
  const rows=items.map(i=>({id:i.i}));context.paint(items,rows,false,0);
  assert.equal(rows.at(-1).children[0].id,'plan');
  const updated=[...items,{i:'next-reply',k:'assistant'}],next=updated.map(i=>({id:i.i}));context.paint(updated,next,false,0);
  assert.equal(next.at(-2).id,'next-reply');assert.equal(next.at(-1).children[0].id,'plan');
  plan.confirmed=true;const completed=items.map(i=>({id:i.i}));context.paint(items,completed,false,0);
  assert.deepEqual(completed.map(n=>n.id),['user','thread:dynamic-tool-call:call','plan','reply']);
});
test('a native-only board update redraws the main conversation without another task or plan change', () => {
  const source=fs.readFileSync(new URL('../app/js/fusion.js',import.meta.url),'utf8');
  const run={id:'run',computer:'computer',tasks:[],works:[],questions:[],dispatches:[],nativeInteractions:[]};
  let paints=0;
  const context=vm.createContext({currentFusionRun:()=>run,fusionBoards:new Map(),fusionStateKey:(c,r)=>c+'|'+r,
    paintFusionTaskStrip(){},fusionDispatchCards:new Map(),fusionChatActive:()=>true,lastChat:{thread:'main'},
    currentComputer:()=>({threadId:'main'}),chatStale:false,renderChat(){paints++;}});
  const a=source.indexOf('function fusionRememberBoard('),b=source.indexOf('function paintFusionTaskStrip(',a);
  vm.runInContext(source.slice(a,b)+';this.remember=fusionRememberBoard;',context);
  context.remember(run);paints=0;
  const approval={...run,nativeInteractions:[{id:'attempt',requests:[{id:'approval'}]}]};
  context.remember(approval);assert.equal(paints,1);
  context.remember(approval);assert.equal(paints,1);
  context.remember(run);assert.equal(paints,2);
});
test('worker responsibility labels update when reused while retaining the native binding and earlier task facts', () => {
  const h=fixture(),workId=h.create();h.plan(workId);
  const first=h.apply({action:'dispatch',workId,tasks:[h.task('audit')],input:JSON.stringify({audit:{workerId:null,label:'训练协议审查',reason:'Independent audit'}})}).tasks[0];
  h.run.agents[0].bindingId='existing-native-binding';
  const before=structuredClone({task:h.run.tasks[0],attempt:h.run.attempts[0]});
  const reused=h.apply({action:'dispatch',workId,tasks:[h.task('related')],input:JSON.stringify({related:{workerId:first.workerId,label:'训练与证据复核',reason:'Reuse related evidence'}})}).tasks[0];
  assert.equal(reused.workerId,first.workerId);assert.equal(h.run.agents.length,1);assert.equal(h.run.agents[0].bindingId,'existing-native-binding');
  assert.equal(fusionRunView(h.run,{kind:'tasks'}).agents[0].label,'训练与证据复核');
  assert.deepEqual({task:h.run.tasks[0],attempt:h.run.attempts[0]},before);
});

test('dispatch without an explicit responsibility label fails without creating a worker or task', () => {
  const h=fixture(),workId=h.create();h.plan(workId);
  assert.throws(()=>applyFusionControl(h.run,{action:'dispatch',workId,tasks:[h.task('new')],input:JSON.stringify({new:{workerId:null,reason:'New context'}})},h.native()),/职责短名/);
  assert.equal(h.run.tasks.length,0);assert.equal(h.run.agents.length,0);assert.equal(h.run.attempts.length,0);
});
