import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import test from 'node:test';
import { FusionAgent } from '../server/fusion/agent.mjs';
import { NativeCdp, nativeWindow } from '../server/native-windows.mjs';
import { fixture } from './fusion-fixture.mjs';
import { helpersCall, PAGE_SRC } from '../server/page/build.mjs';

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
test('default page helper calls preserve their ordinary context while Fusion calls carry an explicit native identity', () => {
  assert.equal(helpersCall('activeThread()'), `${PAGE_SRC}.activeThread()`);
  const scoped = helpersCall('activeThread()', { app: 'codex', threadId: 'worker', host: 'local' });
  assert.match(scoped, /"threadId":"worker"/); assert.notEqual(scoped, helpersCall('activeThread()'));
});
test('single-conversation tool routing leaves every ordinary tool dispatch on the original native handler', async () => {
  const source = fs.readFileSync(new URL('../server/page/session-actions.js', import.meta.url), 'utf8');
  const start = source.indexOf('  const nativeSessionAction ='), end = source.indexOf('  const nativeSessionConfirm', start);
  const ordinary = [], replies = [], main = { requests: [] };
  const manager = { threadExecution: { executeDynamicToolCall: request => ordinary.push(request) },
    updateConversationState: (_id, edit) => edit(main), getDynamicToolRequest: (_id, id) => main.requests.find(row => row.id === id)?.params,
    replyWithDynamicToolResponse: (_id, id, result) => { replies.push({ id, result }); main.requests.splice(main.requests.findIndex(row => row.id === id), 1); } };
  const original = manager.threadExecution.executeDynamicToolCall;
  const context = vm.createContext({ Map, Set, WeakMap, Error, window: {}, remoteContext: { host: '' }, nativeValue: value => value,
    codexConversationManager: () => manager, codexHistoryScopes: () => [] });
  vm.runInContext(source.slice(start, end) + '\nthis.action = nativeSessionAction;', context);
  await context.action('codex', 'main', 'bindTools', ['ra_fusion']);
  manager.threadExecution.executeDynamicToolCall({ id: 0, method: 'item/tool/call', params: { threadId: 'main', turnId: 't', tool: 'ra_fusion' } });
  manager.threadExecution.executeDynamicToolCall({ id: 1, params: { threadId: 'ordinary', tool: 'ra_fusion' } });
  manager.threadExecution.executeDynamicToolCall({ id: 2, params: { threadId: 'main', tool: 'ordinary-tool' } });
  assert.equal(main.requests.length, 1); assert.equal(main.requests[0].id, 0); assert.equal(ordinary.length, 2);
  await context.action('codex', 'main', 'toolReply', { requestId: 0, result: { success: true } }); assert.equal(replies[0].id, 0);
  await context.action('codex', 'main', 'unbindTools'); assert.equal(manager.threadExecution.executeDynamicToolCall, original);
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
