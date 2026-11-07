import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import test from 'node:test';
import { FusionAgent } from '../server/fusion/agent.mjs';
import { NativeCdp, nativeWindow } from '../server/native-windows.mjs';
import { fixture } from './fusion-fixture.mjs';
import { helpersCall, PAGE_SRC } from '../server/page/build.mjs';
import { FUSION_TOOLS, fusionAutonomyContext, fusionControllerPrompt } from '../server/fusion/control.mjs';
import { FusionController } from '../server/fusion/controller.mjs';

test('Fusion reads the Codex model catalog without loading the ordinary conversation history', async () => {
  const {run}=fixture(),agent=new FusionAgent(),calls=[];
  const context={app:'codex',page:{id:'project-window'},native:{threadId:'ordinary-thread',host:''}};
  agent.carrierFor=async()=>context;
  agent.close=async value=>{assert.equal(value,context);calls.push('close');};
  agent.call=async(_context,code)=>{
    assert.equal(code,'modelItemsFast(true)');calls.push(code);
    return [{id:'current-model',label:'Current model',efforts:[{label:'low'}]}];
  };
  const snapshot=await agent.capabilities(run,'codex');
  assert.equal(snapshot.models[0].model,'current-model');
  assert.deepEqual(calls,['modelItemsFast(true)','close']);
  assert.equal(context.pinned,undefined);
});

test('the next actual native user turn answers its sole preceding Fusion question without another model request or plan approval', () => {
  const h = fixture(), workId = h.create(); h.plan(workId, true);
  const questionId = h.apply({ action: 'ask_user', workId, question: 'Use the displayed scope?', options: ['Yes', 'No'] }).questionId;
  h.run.attempts.push({ kind: 'main', origin: 'events', acceptedAt: 5, native: { threadId: 'main-thread', turnId: 'native-turn' } });
  h.run.observedMainTurns.push('native-turn', 'native-reply');
  const native = { threadId: 'main-thread', turnId: 'native-reply', messageId: 'user-reply' };
  h.run.attempts.push({ kind: 'main', origin: 'user', acceptedAt: 10, native });
  h.run.events.push({ id: 'native-user-event', type: 'user_input', at: 11,
    data: { text: '可以，但子模型改为Sol', native }, deliveredTo: native.turnId });
  const controller = new FusionController({ run: h.run, agent: { call: () => assert.fail('model or native action') } });
  const count = h.run.events.length; controller.acknowledgeUserAnswers();
  const question = h.run.questions.find(row => row.id === questionId);
  assert.equal(question.answer, '可以，但子模型改为Sol'); assert.equal(question.answeredAt, 11);
  assert.equal(question.inputId, 'native-user-event'); assert.equal(h.run.events.length, count);
  assert.equal(h.run.events.at(-1).data.questionId, questionId); assert.equal(h.run.events.at(-1).data.workId, workId);
  assert.equal(h.run.works[0].plans[0].confirmed, false);
  const revision = h.run.revision; controller.acknowledgeUserAnswers(); assert.equal(h.run.revision, revision);
});
test('multiple pending questions, event-generated turns and other-thread messages do not guess an answer target', () => {
  for (const mode of ['multiple', 'events', 'other-thread', 'not-next']) {
    const h = fixture(), workId = h.create(); h.plan(workId);
    h.apply({ action: 'ask_user', workId, question: 'Question one' });
    if (mode === 'multiple') h.apply({ action: 'ask_user', workId, question: 'Question two' });
    h.run.attempts.push({ kind: 'main', origin: 'events', acceptedAt: 5, native: { threadId: 'main-thread', turnId: 'native-turn' } });
    if (mode === 'not-next') h.run.attempts.push({ kind: 'main', origin: 'events', acceptedAt: 7,
      native: { threadId: 'main-thread', turnId: 'intervening-turn' } });
    h.run.observedMainTurns.push('native-turn', ...(mode === 'not-next' ? ['intervening-turn'] : []), 'reply-turn');
    const native = { threadId: mode === 'other-thread' ? 'ordinary-thread' : 'main-thread', turnId: 'reply-turn', messageId: 'reply' };
    h.run.attempts.push({ kind: 'main', origin: mode === 'events' ? 'events' : 'user', acceptedAt: 10, native });
    h.run.events.push({ id: 'reply-event', type: 'user_input', at: 11, data: { text: 'Yes', native } });
    new FusionController({ run: h.run }).acknowledgeUserAnswers();
    assert(h.run.questions.every(row => !row.answeredAt), mode); assert.equal(h.run.events[0].data.questionId, undefined);
  }
});

test('history reads use the actual project carrier and original child thread while execution keeps its recorded window', async () => {
  const { run } = fixture(), original = { id: 'worker', role: 'worker', app: 'codex', project: run.project,
    windowId: 'closed-window', threadId: 'original-worker', host: '' };
  run.bindings.push(original);
  const agent = new FusionAgent({ publish: () => assert.fail('history must not publish or resume') }), calls = [], carriers = [];
  agent.carrierFor = async (_run, app, project, windowId) => {
    carriers.push({ app, project, windowId });
    if (windowId) throw new Error('绑定的原生窗口已关闭，实际执行结果需要核对');
    return { app, page: { id: 'current-project-window' }, native: {}, leaseId: 'read-only-lease' };
  };
  agent.close = async () => calls.push('close');
  agent.call = async (context, code, native = context.native) => {
    calls.push({ code, threadId: native.threadId, before: native.before });
    if (code.startsWith('nativeSessionInfo(')) return { app: 'codex', threadId: original.threadId, cwd: run.project.root, host: '' };
    assert.equal(code, 'extract(true, [], 80)'); return { thread: native.threadId, items: [{ i: 'worker-result', t: 'Original result' }] };
  };
  const before = JSON.stringify(run), result = await agent.readBinding(run, original.id, true, 'earlier-cursor');
  assert.equal(result.chat.thread, original.threadId); assert.equal(result.binding, original);
  assert.deepEqual(carriers.map(row => row.windowId), ['']);
  assert.equal(calls[1].threadId, original.threadId); assert.equal(calls[1].before, 'earlier-cursor'); assert.equal(calls[2], 'close');
  assert.equal(JSON.stringify(run), before);
  await assert.rejects(agent.openBinding(run, original), /绑定的原生窗口已关闭/);
  assert.equal(carriers[1].windowId, 'closed-window');
});
test('history reads reject a child with a mismatched native project and release its connection', async () => {
  const { run } = fixture(), agent = new FusionAgent({ publish() {} }); let closed = 0;
  agent.carrierFor = async () => ({ app: 'codex', native: {}, leaseId: 'history' });
  agent.call = async () => ({ app: 'codex', threadId: 'main-thread', cwd: run.project.root, host: 'different-host' });
  agent.close = async () => closed++;
  await assert.rejects(agent.readBinding(run, 'main'), /原生会话目录与该任务项目不一致/);
  assert.equal(closed, 1);
});
test('same-software workers use the main window and other-software workers use an existing carrier', async () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  h.apply({ action: 'dispatch', workId, tasks: [h.task('A'), h.task('B', 'cursor')] });
  const agent = new FusionAgent({ publish() {} }), requests = [];
  agent.createBinding = async (_run, owner, app, project, role, spec, preferred) => {
    requests.push({ app, project, role, preferred }); const binding = { id: 'child-' + app, role, app, threadId: app + '-thread', project, windowId: 'shared' };
    h.run.bindings.push(binding); owner.bindingId = binding.id; return binding;
  };
  for (const task of h.run.tasks) await agent.workerBinding(h.run, task, h.run.assignments.find(row => row.taskId === task.id));
  assert.deepEqual(requests.map(row => row.preferred), ['shared', '']);
  assert.equal(requests.every(row => row.role === 'worker'), true);
  const task = h.run.tasks[0], binding = h.run.bindings.find(row => row.id === h.run.agents[0].bindingId);
  assert.equal(await agent.workerBinding(h.run, task, h.run.assignments[0]), binding);
  assert.equal(requests.length, 2);
});
test('a different-software assignment creates a new binding without overwriting old native facts', async () => {
  const h = fixture(), workId = h.create(); h.plan(workId); h.apply({ action: 'dispatch', workId, tasks: [h.task('A')] });
  const task = h.run.tasks[0], worker = h.run.agents[0], old = { id: 'old', app: 'codex', role: 'worker', threadId: 'native-old', windowId: 'shared' };
  worker.bindingId = old.id; h.run.bindings.push(old);
  const agent = new FusionAgent({ publish() {} }); let created = 0;
  agent.createBinding = async () => { created++; return { id: 'new' }; };
  await agent.workerBinding(h.run, task, { app: 'cursor' });
  assert.equal(created, 1); assert.equal(old.threadId, 'native-old'); assert.equal(h.run.bindings[1], old);
});
test('releasing a worker removes only its cursor data handle and own connection', async () => {
  const calls = [], ordinary = { draft: 'real draft', selection: 'ordinary', model: 'Auto' }, before = structuredClone(ordinary);
  const agent = new FusionAgent({ publish() {} }); agent.call = async (_ctx, code) => calls.push(code);
  const context = { app: 'cursor', pinned: true, leaseId: 'lease', native: { threadId: 'child' }, cdp: { close: () => calls.push('client-close') },
    source: { watching: true, clients: new Set([ordinary]), conversations: new Map(), listeners: new Set(), close: () => assert.fail('shared source closed') } };
  await agent.close(context);
  assert.match(calls[0], /'release'/); assert.equal(calls[1], 'client-close'); assert.deepEqual(ordinary, before);
});
test('finishing one same-window worker retains the other worker and ordinary client with their own subscriptions', async t => {
  const ordinary = new NativeCdp('ws://fusion-concurrency-unit'), one = new NativeCdp(ordinary.wsUrl), two = new NativeCdp(ordinary.wsUrl);
  const source = nativeWindow(ordinary), closed = [];
  t.after(() => { one.close(); two.close(); ordinary.close(); source.close(); });
  const context = threadId => ({ app: 'codex', threadId, host: 'local' });
  const views = ['one', 'two'].map(threadId => {
    const view = source.conversationView(context(threadId));
    view.watching = Promise.resolve(); view.stop = () => closed.push(threadId);
    return view;
  });
  const stopOne = source.subscribe(() => {}, context('one')), stopTwo = source.subscribe(() => {}, context('two'));
  const agent = new FusionAgent({ publish() {} });
  stopOne(); await agent.close({ app: 'codex', cdp: one, source, native: context('one') });
  assert.deepEqual(closed, ['one']); assert.equal(source.clients.has(ordinary), true); assert.equal(source.clients.has(two), true);
  assert.equal(source.clients.has(one), false); assert.equal(views[1].listeners.size, 1);
  assert.equal(source.conversations.has(JSON.stringify(['local', 'two'])), true);
  stopTwo(); await agent.close({ app: 'codex', cdp: two, source, native: context('two') });
  assert.deepEqual(closed, ['one', 'two']); assert.equal(source.clients.has(ordinary), true);
});
test('concurrent Codex calls initialize the same window realm once and retain independent native contexts', async t => {
  const cdp = new NativeCdp('ws://fusion-realm-concurrency-unit'), source = nativeWindow(cdp);
  t.after(() => { cdp.close(); source.close(); });
  source.connect = async () => {};
  source.contexts.set(7, { id: 7, auxData: { isDefault: true, frameId: 'active' } });
  let document = 0;
  source.cdp.send = async (method, params) => {
    if (method === 'DOM.getDocument') return { root: { nodeId: ++document } };
    if (method === 'DOM.querySelector') {
      if (params.nodeId !== document) throw new Error('Could not find node with given id');
      return { nodeId: 100 };
    }
    if (method === 'DOM.describeNode') return { node: { frameId: 'active' } };
    assert.equal(method, 'Runtime.enable'); return {};
  };
  const evaluated = [];
  source.cdp.evaluate = async (code, options) => { evaluated.push({ code, contextId: options.contextId }); return options.contextId; };
  const one = { app: 'codex', host: 'local', threadId: 'one' }, two = { ...one, threadId: 'two' };
  assert.deepEqual(await Promise.all([source.composerCall('activeThread()', one), source.composerCall('activeThread()', two)]), [7, 7]);
  assert.equal(document, 1); assert.equal(evaluated[0].code, helpersCall('activeThread()', one));
  assert.equal(evaluated[1].code, helpersCall('activeThread()', two));
  await source.composerCall('activeThread()', one); assert.equal(document, 1);
});
test('a stale stop cannot interrupt a newer native round', async () => {
  const h = fixture(), attempt = { id: 'attempt', native: { messageId: 'one', turnId: 'old-turn' }, beforeIds: [] }; h.run.attempts.push(attempt);
  const agent = new FusionAgent({ publish() {} }); let calls = 0;
  agent.active.set(attempt.id, { controller: h.run, attemptId: attempt.id, binding: { app: 'codex', threadId: 'worker' }, context: {} });
  agent.call = async () => { calls++; return { current: true, turnId: 'new-turn' }; };
  await assert.rejects(agent.stop(attempt.id), /不能停止其他执行/); assert.equal(calls, 1);
});
test('a retained Worker exposes native interaction only on its active task and marks that task for attention', async t => {
  const { fusionLive } = await import('../server/fusion/state.mjs');
  const { fusionRunView, fusionControllerView } = await import('../server/fusion/owner.mjs');
  const h = fixture(), workId = h.create(); h.plan(workId);
  h.apply({ action: 'dispatch', workId, tasks: [h.task('old')] });
  h.apply({ action: 'dispatch', workId, tasks: [h.task('current')], input: JSON.stringify({
    current: { workerId: h.run.agents[0].id, reason: 'Continue established context' },
  }) });
  const binding = { id: 'retained-' + h.run.id, role: 'worker', app: 'codex', threadId: 'retained-thread', windowId: 'shared', project: h.project };
  h.run.bindings.push(binding); h.run.agents[0].bindingId = binding.id;
  Object.assign(h.run.attempts[0], { bindingId: binding.id, status: 'accepted', endedAt: 20, result: { text: 'Old result', completed: true } });
  h.run.tasks[0].status = 'accepted';
  Object.assign(h.run.attempts[1], { bindingId: binding.id, status: 'running', acceptedAt: 30,
    native: { threadId: binding.threadId, turnId: 'current-turn' } });
  h.run.tasks[1].status = 'awaiting_user';
  const request = { id: 'current-request', text: 'Current approval', fields: [], buttons: [{ label: 'accept' }] };
  fusionLive.set(binding.id, { state: { waiting: 'approval-request' }, chat: { items: [], questions: { codex: true, requests: [request] } } });
  t.after(() => fusionLive.delete(binding.id));
  const old = fusionRunView(h.run, { kind: 'task', taskId: 'old' }), current = fusionRunView(h.run, { kind: 'task', taskId: 'current' });
  assert.equal(old.attempts[0].live, undefined); assert.equal(old.tasks[0].needsUser, false); assert.equal(old.tasks[0].state, 'done');
  assert.deepEqual(current.board.nativeInteractions[0].requests, [request]);
  assert(!old.board.nativeInteractions.some(row => row.taskId === 'old-task'));
  assert.equal(current.tasks[0].needsUser, true); assert.equal(current.tasks[0].state, 'wait');
  assert.deepEqual(fusionControllerView(h.run).overview.attention.map(row => row.taskId), ['current']);
});
test('an ended Attempt cannot act on a retained thread current request and does not open a native connection', async () => {
  const h = fixture(), binding = { id: 'retained', app: 'codex', threadId: 'retained-thread' };
  h.run.bindings.push(binding);
  h.run.attempts.push({ id: 'old', bindingId: binding.id, endedAt: 20 }, { id: 'current', bindingId: binding.id, endedAt: null });
  const agent = new FusionAgent({ publish() {} }), calls = [];
  agent.openBinding = async () => { calls.push('open'); return {}; };
  agent.close = async () => calls.push('close');
  agent.call = async (_context, code) => { calls.push(code); return true; };
  const action = { bindingId: binding.id, kind: 'codexRequest', id: 'current-request', n: 0, fields: [] };
  await assert.rejects(agent.nativeAction(h.run, 'old', action), /该次执行已结束/); assert.deepEqual(calls, []);
  assert.equal(await agent.nativeAction(h.run, 'current', action), true);
  assert.equal(calls[0], 'open'); assert.match(calls[1], /codexRequestAction\("current-request", 0, \[\]\)/); assert.equal(calls[2], 'close');
});
test('default page helper calls preserve their ordinary context while Fusion calls carry an explicit native identity', () => {
  assert.equal(helpersCall('activeThread()'), `${PAGE_SRC}.activeThread()`);
  const scoped = helpersCall('activeThread()', { app: 'codex', threadId: 'worker', host: 'local' });
  assert.match(scoped, /"threadId":"worker"/); assert.notEqual(scoped, helpersCall('activeThread()'));
});
test('single-conversation tool routing leaves every ordinary tool dispatch on the original native handler', async () => {
  const source = fs.readFileSync(new URL('../server/page/session-actions.js', import.meta.url), 'utf8');
  const start = source.indexOf('  const nativeSessionAction ='), end = source.indexOf('  const nativeSessionConfirm', start);
  const ordinary = [], replies = [], main = { requests: [] };
  const manager = { requestClient: { sendRequest() {} }, threadExecution: { executeDynamicToolCall: request => ordinary.push(request) },
    updateConversationState: (_id, edit) => edit(main), getDynamicToolRequest: (_id, id) => main.requests.find(row => row.id === id)?.params,
    replyWithDynamicToolResponse: (_id, id, result) => { replies.push({ id, result }); main.requests.splice(main.requests.findIndex(row => row.id === id), 1); } };
  const original = manager.threadExecution.executeDynamicToolCall;
  const context = vm.createContext({ Map, Set, WeakMap, Error, window: {}, remoteContext: { host: '' }, nativeValue: value => value,
    codexConversationManager: () => manager, codexHistoryScopes: () => [] });
  vm.runInContext(source.slice(start, end) + '\nthis.action = nativeSessionAction;', context);
  await context.action('codex', 'main', 'bindTools', { names: ['ra_fusion'], authorization: fusionAutonomyContext({ id: 'workbench' }) });
  manager.threadExecution.executeDynamicToolCall({ id: 0, method: 'item/tool/call', params: { threadId: 'main', turnId: 't', tool: 'ra_fusion' } });
  manager.threadExecution.executeDynamicToolCall({ id: 1, params: { threadId: 'ordinary', tool: 'ra_fusion' } });
  manager.threadExecution.executeDynamicToolCall({ id: 2, params: { threadId: 'main', tool: 'ordinary-tool' } });
  assert.equal(main.requests.length, 1); assert.equal(main.requests[0].id, 0); assert.equal(ordinary.length, 2);
  await context.action('codex', 'main', 'toolReply', { requestId: 0, result: { success: true } }); assert.equal(replies[0].id, 0);
  await context.action('codex', 'main', 'unbindTools'); assert.equal(manager.threadExecution.executeDynamicToolCall, original);
});
test('native request context authorizes only registered Fusion mains and preserves ordinary calls, payloads and shared-client cleanup', async () => {
  const source = fs.readFileSync(new URL('../server/page/session-actions.js', import.meta.url), 'utf8');
  const start = source.indexOf('  const nativeSessionAction ='), end = source.indexOf('  const nativeSessionConfirm', start);
  const calls = [], response = Promise.resolve({ accepted: true });
  const client = { sendRequest(method, params, ...options) { assert.equal(this, client); calls.push({ method, params, options }); return response; } };
  const original = client.sendRequest, manager = () => ({ requestClient: client, threadExecution: { executeDynamicToolCall() {} } });
  const one = manager(), two = manager();
  const context = vm.createContext({ Map, Set, WeakMap, window: {}, remoteContext: { host: '' },
    codexConversationManager: id => id === 'main-one' ? one : two, codexHistoryScopes: () => [] });
  vm.runInContext(source.slice(start, end) + '\nthis.action = nativeSessionAction;', context);
  const authOne = fusionAutonomyContext({ id: 'workbench-one' }), authTwo = fusionAutonomyContext({ id: 'workbench-two' });
  await context.action('codex', 'main-one', 'bindTools', { names: ['ra_fusion'], authorization: authOne });
  const wrapped = client.sendRequest;
  await context.action('codex', 'main-two', 'bindTools', { names: ['ra_fusion'], authorization: authTwo });
  assert.equal(client.sendRequest, wrapped);
  const input = [{ type: 'text', text: '只给需求 @file.js', text_elements: [{ range: { start: 5, end: 13 }, placeholder: '@file.js' }] },
    { type: 'localImage', path: '/project/screenshot.png' }];
  for (const method of ['turn/start', 'turn/steer']) {
    const params = { threadId: 'main-one', input, clientUserMessageId: 'native-message', expectedTurnId: 'native-turn',
      model: 'user-model', effort: 'high', additionalContext: { original: { kind: 'application', value: 'native context' } } };
    const before = structuredClone(params), options = { timeoutMs: 1234 };
    assert.equal(client.sendRequest(method, params, options), response);
    const sent = calls.at(-1);
    assert.equal(sent.params.input, input); assert.equal(sent.options[0], options); assert.deepEqual(params, before);
    assert.deepEqual(JSON.parse(JSON.stringify(sent.params)), { ...before, additionalContext: { ...before.additionalContext, ra_fusion_user_authorization: authOne } });
  }
  for (const [method, threadId] of [['turn/start', 'ordinary'], ['turn/steer', 'child'], ['thread/resume', 'main-one']]) {
    const params = { threadId, input }; assert.equal(client.sendRequest(method, params), response); assert.equal(calls.at(-1).params, params);
  }
  await context.action('codex', 'main-one', 'unbindTools');
  const detached = { threadId: 'main-one', input }; client.sendRequest('turn/start', detached); assert.equal(calls.at(-1).params, detached);
  client.sendRequest('turn/start', { threadId: 'main-two', input });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).params.additionalContext.ra_fusion_user_authorization)), authTwo);
  await context.action('codex', 'main-two', 'unbindTools'); assert.equal(client.sendRequest, original);
});
test('connecting a persistent controller registers its own workbench authorization without submitting a turn', async () => {
  const { run } = fixture(), calls = [], context = { native: { threadId: 'main-thread' }, cdp: {},
    source: { subscribe: () => () => calls.push({ action: 'unsubscribe' }) } };
  const agent = { openBinding: async (_run, binding) => { assert.equal(binding.id, run.main.bindingId); return context; },
    async call(_context, code) { return new Function('nativeSessionAction', 'return ' + code)((app, thread, action, value) => calls.push({ app, thread, action, value })); },
    close: async value => assert.equal(value, context) };
  const controller = new FusionController({ run, agent }); controller.check = async () => {};
  await controller.start(); await controller.start();
  assert.equal(calls.length, 1); assert.equal(calls[0].action, 'bindTools'); assert.equal(calls[0].thread, 'main-thread');
  assert.deepEqual(calls[0].value, { names: FUSION_TOOLS.map(tool => tool.name), authorization: fusionAutonomyContext(run), instructions: fusionControllerPrompt(run) });
  assert.equal(calls[0].value.authorization.kind, 'application'); assert(calls[0].value.authorization.value.includes(run.id));
  assert(Buffer.byteLength(JSON.stringify(calls[0].value.authorization)) < 700);
  await controller.close(); assert.deepEqual(calls.slice(1).map(call => call.action), ['unsubscribe', 'unbindTools']);
});
test('an unmounted Codex worker reads its native history rather than a different mounted conversation', async () => {
  const source = fs.readFileSync(new URL('../server/page/chat-extract.js', import.meta.url), 'utf8');
  const start = source.indexOf('  const codexFusionTurn ='), end = source.indexOf('  // One Codex turn', start);
  const conversation = { id: 'worker' }, turn = { status: 'complete', partial: false, items: [
    { type: 'user-message', clientUserMessageId: 'user', message: 'attempt-1' },
    { type: 'assistant-message', completed: true, content: 'worker-result' } ] };
  const context = vm.createContext({ Map, Set, remoteContext: { app: 'codex', threadId: 'worker' },
    codexThread: () => 'worker', codexVisibleThread: () => 'ordinary', codexNativeManager: () => ({ getConversation: id => { assert.equal(id, 'worker'); return conversation; } }),
    codexHistoryState: native => { assert.equal(native, conversation); return { thread: 'worker', scopes: [], entries: [{ turnId: 'native-turn' }] }; },
    doc: { querySelectorAll: () => assert.fail('ordinary DOM read') }, codexStoredTurn: () => turn, codexTurnItems: () => [],
    codexSendState: () => ({ runs: [{ id: 'native-turn' }] }) });
  vm.runInContext(source.slice(start, end) + '\nthis.read = codexFusionTurn;', context);
  const result = await context.read('', 'attempt-1', []);
  assert.equal(result.threadId, 'worker'); assert.equal(result.id, 'user'); assert.equal(result.turnId, 'native-turn');
  assert.equal(result.accepted, true); assert.equal(result.ended, true); assert.equal(result.completed, true); assert.equal(result.text, 'worker-result');
});
test('Fusion native end status is independent of partial history and interrupted execution is never completed', async () => {
  const source = fs.readFileSync(new URL('../server/page/chat-extract.js', import.meta.url), 'utf8');
  const start = source.indexOf('  const codexFusionTurn ='), end = source.indexOf('  // One Codex turn', start);
  for (const status of ['complete', 'completed', 'interrupted', 'failed', 'inProgress']) {
    const turn = { status, partial: true, items: [{ type: 'user-message', clientUserMessageId: 'user', message: 'attempt' },
      { type: 'assistant-message', completed: true, content: 'Actual final text' }] };
    const context = vm.createContext({ Map, Set, remoteContext: { app: 'codex', threadId: 'worker' }, codexThread: () => 'worker',
      codexVisibleThread: () => 'ordinary', codexNativeManager: () => ({ getConversation: () => ({}) }),
      codexHistoryState: () => ({ thread: 'worker', scopes: [], entries: [{ turnId: 'native-turn', nativeTurn: { status,
        ...(status === 'failed' ? { error: { message: 'Original native failure' } } : {}) } }] }),
      doc: { querySelectorAll: () => assert.fail('ordinary conversation read') }, codexStoredTurn: () => turn,
      codexTurnItems: () => [], codexSendState: () => ({ runs: [{ id: 'native-turn' }] }) });
    vm.runInContext(source.slice(start, end) + '\nthis.read = codexFusionTurn;', context);
    const result = await context.read();
    assert.equal(result.ended, status !== 'inProgress', status);
    assert.equal(result.completed, ['complete', 'completed'].includes(status), status);
    if (status === 'interrupted') assert.match(result.error, /中断/);
    if (status === 'failed') assert.equal(result.error, 'Original native failure');
  }
});
test('a failed Devin native request ends its own Fusion round after transient messages are removed', async () => {
  const source = fs.readFileSync(new URL('../server/page/chat-extract.js', import.meta.url), 'utf8');
  const start = source.indexOf('  const codexFusionTurn ='), end = source.indexOf('  // One Codex turn', start);
  const error = 'Permission denied: internal server error: error number 13';
  const current = { method: 'session/prompt', params: { sessionId: 'worker', prompt: [{ text: 'attempt-1' }] }, status: 'failed', errorMessage: error };
  const state = { perSession: {}, agentRequests: { byId: { current, foreign: { ...current, params: { sessionId: 'other' }, errorMessage: 'foreign failure' } } } };
  const context = vm.createContext({ remoteContext: { app: 'devin', threadId: 'worker' }, window: { __acpStore: { getState: () => ({ acp: state }) } },
    devinSurface: () => true, devinSessionRecord: () => ({ status: 'idle' }), devinLog: () => assert.fail('ordinary DOM read'), devinItems: () => assert.fail('ordinary DOM read') });
  vm.runInContext(source.slice(start, end) + '\nthis.read = codexFusionTurn;', context);
  const result = await context.read('known-user', 'attempt-1', [], 'current');
  assert.equal(result.threadId, 'worker'); assert.equal(result.ended, true); assert.equal(result.completed, false); assert.equal(result.error, error);
  const foreign = await context.read('known-user', 'attempt-1', [], 'foreign');
  assert.equal(foreign.ended, false); assert.equal(foreign.error, '');
  state.agentRequests.byId.current = { ...current, status: 'pending', errorMessage: undefined };
  const pending = await context.read('known-user', 'attempt-1', [], 'current'); assert.equal(pending.ended, false);
});
test('Fusion Devin content reports a native failure without requiring a pruned transcript or showing another request error', async () => {
  const source = fs.readFileSync(new URL('../server/page/chat-extract.js', import.meta.url), 'utf8');
  const start = source.indexOf('  const nativeConversationChat ='), end = source.indexOf('  const contextPct =', start);
  const error = 'Permission denied: internal server error: error number 13';
  const state = { perSession: {}, agentRequests: { byId: { current: { method: 'session/prompt', params: { sessionId: 'worker' }, status: 'failed', errorMessage: error } } } };
  let messageReads = 0;
  const context = vm.createContext({ remoteContext: { app: 'devin', threadId: 'worker', cwd: '/project', host: '' },
    window: { __acpStore: { getState: () => ({ acp: state }) } },
    nativeModule: { getAllMessages: data => { messageReads++; assert(data, 'failed native transcript has been pruned'); return data.messages; } },
    devinSessionRecord: () => ({ status: 'idle', title: 'Worker' }), activeThread: () => 'ordinary', devinQuestions: () => assert.fail('ordinary questions read'),
    agentRun: () => ({ id: 'current', status: state.agentRequests.byId.current.status === 'failed' ? 'error' : 'completed' }), nativeWaiting: () => ({}),
    agentModelName: () => 'SWE-2 High', effortName: () => '', devinSurface: () => 'editor',
    nativeMarkdownItem: (i, k, t, at) => ({ i, k, t, at }) });
  vm.runInContext(source.slice(start, end).replace("await import('@exa/chat-client')", 'nativeModule') + '\nthis.read = nativeConversationChat;', context);
  const failed = await context.read(false, 80);
  assert.equal(failed.thread, 'worker'); assert.equal(failed._nativeState.run.status, 'error');
  assert.equal(failed.items.length, 1); assert.equal(failed.items[0].kind, 'error'); assert.equal(failed.items[0].t, error); assert.equal(messageReads, 0);
  state.perSession.worker = { messages: [{ id: 'reply', kind: 'agent_message', content: [{ content: { type: 'text', text: 'worker-ok' } }] }] };
  state.agentRequests.byId.current = { ...state.agentRequests.byId.current, status: 'completed', errorMessage: undefined };
  state.agentRequests.byId.foreign = { method: 'session/prompt', params: { sessionId: 'other' }, status: 'failed', errorMessage: 'foreign failure' };
  const completed = await context.read(false, 80);
  assert.equal(completed.items.length, 1); assert.equal(completed.items[0].t, 'worker-ok'); assert.equal(messageReads, 1);
});
test('a background Codex free-text question can send its answer to the exact native request', async () => {
  const source = fs.readFileSync(new URL('../server/page/codex.js', import.meta.url), 'utf8');
  const start = source.indexOf('  const codexNativeRequests ='), end = source.indexOf('  const codexConversationChat =', start);
  const replies = [], manager = {
    getConversation: () => ({ requests: [{ id: 0, method: 'item/tool/requestUserInput',
      params: { threadId: 'worker', turnId: 'turn', questions: [{ id: 'q', question: '请补充说明', options: [] }] } }] }),
    replyWithUserInputResponse: async (...args) => replies.push(args),
  };
  const context = vm.createContext({ remoteContext: { threadId: 'worker' }, codexNativeManager: () => manager, nativeValue: value => value });
  vm.runInContext(source.slice(start, end) + '\nthis.rows = codexNativeRequestRows; this.answer = codexNativeRequestAction;', context);
  const row = context.rows()[0];
  assert.equal(row.buttons[1].label, 'Send'); assert.notEqual(row.buttons[1].disabled, true);
  await context.answer(row.id, 1, [{ n: 0, value: '仅处理这个子任务' }]);
  assert.equal(replies[0][0], 'worker'); assert.equal(replies[0][1], 0);
  assert.equal(replies[0][2].answers.q.answers[0], '仅处理这个子任务');
});
test('attempt evidence keeps the scoped preexisting file hash without attaching unrelated repository diffs', async () => {
  const { fusionWorkspaceSnapshot } = await import('../server/fusion/agent.mjs');
  const { fileURLToPath } = await import('node:url');
  const relative = '_shots/fusion-superagent-unit/baseline-input.txt';
  const root = fileURLToPath(new URL('../', import.meta.url));
  fs.writeFileSync(new URL('../' + relative, import.meta.url), 'preexisting');
  const before = await fusionWorkspaceSnapshot({ root, host: '' }, [relative]);
  fs.writeFileSync(new URL('../' + relative, import.meta.url), 'this attempt');
  const after = await fusionWorkspaceSnapshot({ root, host: '' }, [relative]);
  assert.equal(before.available, true); assert.equal(after.available, true);
  assert.equal(before.diff, ''); assert.equal(after.diff, '');
  assert.notEqual(before.files[0].sha256, after.files[0].sha256);
  assert.equal(before.files[0].path, relative);
});

test('Fusion management notifications share the native watch but do not wait for or change ordinary snapshot subscribers', async () => {
  const source=fs.readFileSync(new URL('../server/native-windows.mjs',import.meta.url),'utf8');
  const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
  const watches=[],trace=[];let release,closed=0,stopped=0;
  const body=new Promise(resolve=>release=resolve);
  const context=vm.createContext({Map,Set,JSON,Date,Promise,
    NativeCdp:class {close(){closed++;}},cdpRead:{run:(_owner,fn)=>Promise.resolve().then(fn)},awaitCdpRead:p=>p,
    watchChat:async(_cdp,changed,_shared,native)=>{watches.push({changed,native});return ()=>{stopped++;};},
    withOperation:(_owner,fn)=>fn(),helpersCall:s=>s});
  const Window=vm.runInContext('(class {'+section('  subscribe(changed','  async preview(')
    +section('  conversationView(context)','  async read(fresh')+'})',context);
  const window=Object.assign(new Window(),{conversations:new Map(),cdp:{wsUrl:'owned-test',evaluate:async()=>{trace.push('body');return body;}},
    connect:async()=>{},readReceipts:async()=>trace.push('receipts'),composerCall:async()=>null});
  const native={app:'codex',threadId:'main',host:''};
  const stopManagement=window.subscribe(()=>trace.push('management'),native,'fusion-control');
  await window.conversationView(native).watching;watches[0].changed();await new Promise(r=>setImmediate(r));
  assert.deepEqual(trace,['management']);assert.equal(watches.length,1);
  const stopOrdinary=window.subscribe(()=>trace.push('ordinary'),native);
  watches[0].changed();await new Promise(r=>setImmediate(r));
  assert.deepEqual(trace,['management','management','receipts','body']);
  stopManagement();release({items:[],_nativeState:{run:{status:'idle'}}});
  await window.conversationView(native).reading;assert.equal(trace.at(-1),'ordinary');
  assert.equal(window.conversations.size,1);assert.equal(closed,0);
  stopOrdinary();await new Promise(r=>setImmediate(r));assert.equal(stopped,1);assert.equal(closed,1);assert.equal(window.conversations.size,0);
});
