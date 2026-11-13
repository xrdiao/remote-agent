import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { PAGE_SRC } from '../server/page/build.mjs';
import { methods as chatMethods } from '../server/agent/chat.mjs';
import { adapter as devinAdapter } from '../server/apps/devin.mjs';
import { ROUTES } from '../server/routes.mjs';

const SESSION = 'acp/devin-cli/sess-1';
const plain = value => JSON.parse(JSON.stringify(value));
const NATIVE = 'devin-' + SESSION;

function nativePage({ busy = true, question = false, staleQuestion = false, acceptQueue = true, mounted = true } = {}) {
  const calls = { submit: 0, enqueue: 0, sendNow: 0, answers: [], released: 0, requests: [], order: [] };
  const listeners = new Set(), pending = new Map();
  const data = { sessionId: NATIVE, messages: [], optimisticMessages: [], localQueuedMessages: [],
    loadStatus: 'replayed', promptInFlight: busy, pendingPrompts: 0, currentTurnId: null, lastPromptStopReason: null,
    status: {}, sessionInfo: { cwd: '/project', title: 'Test', configOptions: [] },
    setPromptInFlight(value, reason) { this.promptInFlight = value; this.lastPromptStopReason = reason; },
    replaceConfigOptions(options) { this.sessionInfo.configOptions = options; } };
  const handle = { sessionId: NATIVE, store: { getState: () => data, subscribe: callback => { listeners.add(callback); return () => listeners.delete(callback); } },
    resumeSession() {}, release() { calls.released++; }, pendingRequests: pending,
    respond(key, response) { calls.answers.push({ key, response }); return pending.delete(key); },
    connection: { async send(request) { calls.requests.push(request); return { stopReason: 'end_turn', configOptions: [] }; } } };
  const bounds = () => ({ x: 0, y: 0, top: 0, left: 0, width: 40, height: 20 });
  const rows = [], bar = { innerText: '1 message queued' };
  const enqueue = () => {
    calls.enqueue++; calls.order.push('enqueue');
    if (acceptQueue) rows.push({ className: 'cursor-grab', getBoundingClientRect: bounds,
      querySelectorAll: () => [{ getAttribute: () => 'Send now', click: () => { calls.sendNow++; calls.order.push('sendNow'); } }] });
  };
  const currentQuestion = question ? { currentQuestion: { id: 'q' }, currentEvent: { event_id: 'event' },
    submitAllWithText: async (text, rich) => { calls.answers.push({ text, rich }); return true; } } : null;
  const root = { tag: 3, return: null, stateNode: {} }; root.stateNode.current = root;
  const provider = { tag: 10, memoizedProps: { value: currentQuestion }, return: root };
  const mountedProvider = staleQuestion ? { tag: 10, memoizedProps: { value: { currentQuestion: { id: 'old' },
    submitAllWithText() { throw Error('stale handler'); } } }, return: { stateNode: {}, return: null }, alternate: provider } : provider;
  const props = { 'data-devin-input-box': true, channelId: 'channel', onSubmit: () => { calls.submit++; }, onEnqueue: busy ? enqueue : undefined };
  const fiber = { memoizedProps: props, return: mountedProvider, dependencies: { firstContext: { memoizedValue: handle } } };
  const editor = { __reactFiber$fixture: fiber, getBoundingClientRect: bounds, parentElement: null, closest: () => null };
  const document = { getElementById: () => null, querySelector: () => null, querySelectorAll: selector => selector.includes('data-slate-editor') ? mounted ? [editor] : []
    : selector === 'span.text-12' ? rows.length ? [bar] : [] : selector === 'ol li[role="button"]' ? rows : [],
    body: { classList: { contains: () => false } }, defaultView: { Event: class {}, dispatchEvent() {} } };
  let focused = SESSION;
  const native = { sharedAcpEngine: { peekSession: () => null, acquire: () => handle }, isKnownSession: id => id === NATIVE,
    getSessionRow: () => ({ cwd: '/project' }), sessionProviderId: () => 'devin-cli', sessionTitle: () => 'Test',
    sessionCwdOf: () => '/project', sessionConfigOptions: () => [], deriveAgentStatus: () => ({ isWorking: busy }),
    listedSessions: () => [{ sessionId: NATIVE }], subscribeSessionFeed: () => () => { calls.feedStopped = true; } };
  const window = { __remoteAgentDevinNative: native,
    __SSG_COMPOSER_PROVIDER__: { getStates: () => [{ id: focused, state: 'focused' }] } };
  const expose = PAGE_SRC.replace('return { historyAtStart,', () => 'return { devinReadSession,devinWatch,devinSend,devinClientRequests,devinMessages,devinSessionRecord,historyAtStart,');
  const page = vm.runInNewContext(expose, { document, window, crypto: crypto.webcrypto, requestAnimationFrame: callback => callback(), MutationObserver: class { observe() {} disconnect() { calls.observerStopped = true; } } });
  return { page, calls, data, handle, native, pending, document, editor, rows, props, window, listeners, setFocused: id => { focused = id; } };
}

test('Devin queue reuses the session native callback and send-now action without ordinary submission', async () => {
  for (const now of [false, true]) {
    const h = nativePage();
    const result = await h.page.nativeSessionAction('devin', SESSION, 'queue', { now });
    assert.deepEqual(plain(result), { queued: true, now });
    assert.equal(h.calls.enqueue, 1); assert.equal(h.calls.submit, 0); assert.equal(h.calls.sendNow, Number(now));
    assert.deepEqual(h.calls.order, now ? ['enqueue', 'sendNow'] : ['enqueue']);
  }
});

test('Devin explicit queue while idle reuses the native submit callback', async () => {
  const h = nativePage({ busy: false });
  await h.page.nativeSessionAction('devin', SESSION, 'queue', {});
  assert.equal(h.calls.submit, 1); assert.equal(h.calls.enqueue, 0);
});

test('Devin queue cannot use another session or an unrelated first editor', async () => {
  const h = nativePage();
  const unrelated = { ...h.editor, __reactFiber$fixture: { memoizedProps: { ...h.props, onEnqueue() { throw Error('foreign callback'); } } } };
  const query = h.document.querySelectorAll;
  h.document.querySelectorAll = selector => selector.includes('data-slate-editor') ? [unrelated, h.editor] : query(selector);
  await h.page.nativeSessionAction('devin', SESSION, 'queue', {}); assert.equal(h.calls.enqueue, 1);
  h.setFocused('other');
  await assert.rejects(h.page.nativeSessionAction('devin', SESSION, 'queue', {}), /会话已切换/);
  assert.equal(h.calls.enqueue, 1);
});

test('Devin queue reports native rejection and preserves native ownership of rich-content conversion', async () => {
  const h = nativePage({ acceptQueue: false });
  await assert.rejects(h.page.nativeSessionAction('devin', SESSION, 'queue', {}), /没有接受/);
  assert.equal(h.calls.enqueue, 1); assert.equal(h.calls.submit, 0); assert.equal(h.calls.sendNow, 0);
});

test('Devin text answer uses the current provider native rich-content handler', async () => {
  const h = nativePage({ question: true, staleQuestion: true });
  const result = await h.page.nativeSessionAction('devin', SESSION, 'questionText', { text: '新答案' });
  assert.deepEqual(plain(result), { answered: true });
  assert.deepEqual(plain(h.calls.answers), [{ text: '新答案', rich: [{ text: '新答案' }] }]);
  assert.equal(h.calls.enqueue, 0); assert.equal(h.calls.submit, 0);
});

test('Devin text answer rejects an empty answer or a missing current question', async () => {
  const h = nativePage({ question: true });
  await assert.rejects(h.page.nativeSessionAction('devin', SESSION, 'questionText', { text: ' ' }), /不能为空/);
  const none = nativePage({ staleQuestion: true });
  await assert.rejects(none.page.nativeSessionAction('devin', SESSION, 'questionText', { text: 'answer' }), /不支持自由文字/);
  assert.equal(none.calls.answers.length, 0);
});

test('Devin data reads use the native UI session and preserve optimistic insertion order', async () => {
  const h = nativePage(); h.data.messages = [{ id: 'a' }, { id: 'b' }]; h.data.optimisticMessages = [{ id: 'own' }]; h.data.optimisticInsertIndex = 1;
  assert.deepEqual(Array.from(h.page.devinMessages(SESSION), row => row.id), ['a', 'own', 'b']);
  assert.equal(h.page.devinSessionRecord(SESSION).cwd, '/project');
  await h.page.devinReadSession(SESSION, () => true);
  assert.equal(h.calls.released, 0, 'UI owns its session retention');
});

test('Devin prompt/config send uses the same native connection with a canonical wire target', async () => {
  const h = nativePage();
  await h.page.devinSend('devin-cli', { method: 'session/prompt', params: { sessionId: SESSION, prompt: [{ type: 'text', text: 'one' }] } }, 'request');
  assert.equal(h.calls.requests[0].params.sessionId, NATIVE); assert.equal(h.data.promptInFlight, false);
  assert.equal(h.window.__remoteAgentDevinRequests.get('request').status, 'completed');
  await h.page.devinSend('devin-cli', { method: 'session/set_config_option', params: { sessionId: SESSION, value: 'model' } });
  assert.deepEqual(plain(h.data.sessionInfo.configOptions), []);
});

test('Devin pending native requests preserve store keys and nested elicitation session ownership', () => {
  const h = nativePage(); h.pending.set('own', { id: 0, method: 'ext/method', params: { method: '_session/elicitation', params: { sessionId: 'wire' } } });
  const entry = h.page.devinClientRequests(SESSION).own;
  assert.equal(entry.request.id, 0); assert.equal(entry.request.params.params.sessionId, SESSION);
});

test('Devin background reads release their own lease and propagate native load failure', async () => {
  const h = nativePage({ mounted: false });
  await h.page.devinReadSession(SESSION, () => true);
  assert.equal(h.calls.released, 1);
  h.data.loadStatus = 'failed'; h.data.loadErrorKind = 'native-error';
  await assert.rejects(h.page.devinReadSession(SESSION, () => true), /native-error/);
  assert.equal(h.calls.released, 2);
});

test('Devin watcher releases background subscriptions and never releases UI-owned sessions', () => {
  for (const mounted of [false, true]) {
    const h = nativePage({ mounted }), watch = h.page.devinWatch(() => {}, SESSION);
    assert.equal(h.listeners.size, 1);
    watch.refresh(); assert.equal(h.listeners.size, 1);
    watch.stop();
    assert.equal(h.listeners.size, 0); assert.equal(h.calls.released, mounted ? 0 : 1);
    assert.equal(h.calls.feedStopped, true); assert.equal(h.calls.observerStopped, true);
  }
});

function devinSendContext({ busy = true, when = '', draft = 'hello', human = [], queued = [] } = {}) {
  const events = [], keys = [], evaluates = [];
  let reads = 0;
  const context = {
    app: 'devin', threadId: SESSION, scope: 'devin|window|' + SESSION, sendNativeReceipt: {},
    selectionKey() { return this.scope; },
    emit: event => events.push(event),
    key: async keyName => { keys.push(keyName); },
    submitPromptKey: chatMethods.submitPromptKey,
    refreshSoon() {},
  };
  context.cdp = { async evaluate(expression) {
    evaluates.push(expression);
    if (expression.includes(".nativeSessionAction('devin'")) {
      const now = expression.includes('"now":true');
      return { queued: true, id: 'native-msg-1', now };
    }
    if (expression.includes('extract()')) {
      reads++;
      return reads === 1
        ? { thread: SESSION, draft, human, queued }
        : { thread: SESSION, draft: '',
            human: !busy || when === 'now' ? [{ i: 'h1', t: draft, sentAt: 1 }] : [],
            queued: busy && when !== 'now' ? [{ id: 'q1', t: draft, src: 'devin' }] : [] };
    }
    if (expression.includes('composerDraft')) return reads > 1 ? '' : draft;
    if (expression.includes('agentState')) return busy;
    return true;
  } };
  return { context, events, keys, evaluates };
}

test('Devin adapter queues ordinary busy sends through the native queue action, never Enter', async () => {
  for (const [now, busy, when, queued] of [[false, true, '', true], [false, true, 'queue', true], [true, true, 'now', false]]) {
    const h = devinSendContext({ when });
    const result = await devinAdapter.submitPrompt.call(h.context, now, busy, when, queued);
    assert.equal(h.keys.length, 0, 'no keyboard submit for busy Devin sends');
    const queueCall = h.evaluates.find(expression => expression.includes(".nativeSessionAction('devin'"));
    assert.ok(queueCall, 'native queue action dispatched');
    assert.ok(queueCall.includes("'queue'"), 'queue action used');
    assert.equal(queueCall.includes('"now":true'), now, `now=${now} propagated`);
    assert.equal(result, !now);
  }
});

test('Devin adapter routes an explicit idle queue request through the native queue action', async () => {
  const h = devinSendContext({ busy: false, when: 'queue' });
  h.context.cdp.evaluate = async expression => {
    h.evaluates.push(expression);
    if (expression.includes(".nativeSessionAction('devin'")) return { queued: true, id: 'native-msg-1', now: false };
    if (expression.includes('extract()')) return { thread: SESSION, draft: 'hello', human: [{ i: 'h1', t: 'hello', sentAt: 1 }], queued: [] };
    return true;
  };
  const result = await devinAdapter.submitPrompt.call(h.context, false, false, 'queue', false);
  assert.equal(h.keys.length, 0, 'no Enter fallback for an explicit queue request');
  assert.ok(h.evaluates.some(expression => expression.includes(".nativeSessionAction('devin'") && expression.includes("'queue'")));
  assert.equal(result, false, 'receipt sees the delivered human message, not a queue row');
});

test('Devin adapter keeps Enter for idle sends', async () => {
  const h = devinSendContext({ busy: false });
  const result = await devinAdapter.submitPrompt.call(h.context, false, false, '', false);
  assert.deepEqual(h.keys, ['Enter']);
  assert.equal(h.evaluates.some(expression => expression.includes(".nativeSessionAction('devin'")), false);
  assert.equal(result, false);
});

test('Devin answerQuestion text goes straight to the native question handler', async () => {
  const evaluates = [], taps = [], typed = [];
  const context = { app: 'devin', threadId: SESSION, scope: 's', sendNativeReceipt: {},
    selectionKey() { return this.scope; },
    assertSelectedThread: async () => {},
    cdp: { evaluate: async expression => { evaluates.push(expression); return true; } },
    tapCss: async () => { taps.push(1); }, typeText: async () => { typed.push(1); }, refreshSoon() {},
  };
  await chatMethods.answerQuestion.call(context, 0, 0, 'text', 'card answer');
  assert.equal(evaluates.length, 1);
  assert.ok(evaluates[0].includes("'questionText'"));
  assert.ok(evaluates[0].includes('card answer'));
  assert.equal(taps.length, 0);
  assert.equal(typed.length, 0);
});

test('Devin answerQuestion keeps the DOM path for option parts', async () => {
  const evaluates = [];
  const context = { app: 'devin', threadId: SESSION, scope: 's', sendNativeReceipt: {},
    selectionKey() { return this.scope; },
    assertSelectedThread: async () => {},
    cdp: { evaluate: async expression => { evaluates.push(expression); return { x: 1, y: 2 }; } },
    tapCss: async () => {}, refreshSoon() {},
  };
  await chatMethods.answerQuestion.call(context, 0, 1, 'option');
  assert.ok(evaluates[0].includes('questionTarget'));
});

test('question route allows text only for Devin', async () => {
  const calls = [];
  const devin = { app: 'devin', answerQuestion: (...args) => calls.push(args) };
  const codex = { app: 'codex', answerQuestion: (...args) => calls.push(args) };
  ROUTES.question.run(devin, { part: 'text', text: 'free', qi: 0, oi: 0 });
  ROUTES.question.run(codex, { part: 'text', text: 'free', qi: 0, oi: 0 });
  assert.deepEqual(calls[0].slice(2), ['text', 'free']);
  assert.deepEqual(calls[1].slice(2), ['option', 'free']);
});

test('Devin background elicitation uses the shared MCP field types and exact native request identity', async () => {
  const { elicitationFields } = await import('../lib/shared-rules.mjs');
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('../server/page/devin.js', import.meta.url), 'utf8');
  const actions = fs.readFileSync(new URL('../server/page/session-actions.js', import.meta.url), 'utf8');
  const schema = { type: 'object', required: ['count', 'flag', 'plan', 'tools'], properties: {
    count: { type: 'integer', default: 0 }, flag: { type: 'boolean', default: false },
    plan: { type: 'string', oneOf: [{ const: 'a', title: 'Plan A' }, { const: 'b', title: 'Plan B' }] },
    tools: { type: 'array', items: { anyOf: [{ const: 'read', title: 'Read' }, { const: 'write', title: 'Write' }] }, default: ['read'] },
  } };
  for (const provider of ['devin-cli', 'devin-cloud']) for (const method of ['elicitation/create', 'ext/method']) {
    const thread = 'acp/' + provider + '/session', replies = [], params = { sessionId: 'session', message: 'Choose', requestedSchema: schema };
    const row = { providerId: provider, status: 'pending', request: { id: 0, method, params: method === 'ext/method' ? { method: '_session/elicitation', params } : params } };
    const state = { clientRequests: { own: row, foreign: { ...row, request: { ...row.request, params: method === 'ext/method'
      ? { method: '_session/elicitation', params: { ...params, sessionId: 'other' } } : { ...params, sessionId: 'other' } } } } };
    const context = vm.createContext({ RemoteAgentRules: { elicitationFields }, remoteContext: { app: 'devin', threadId: thread },
      nativeModule: {},
      devinClientRequests: () => state.clientRequests,
      devinSessionHandle: () => ({ respond(key, response) { replies.push({ clientRequestId: key, response }); state.clientRequests[key].status = 'completed'; return true; } }),
      window: { __acpStore: { getState: () => ({ acp: state }), dispatch(value) { replies.push(value); state.clientRequests[value.clientRequestId].status = 'completed'; } } } });
    vm.runInContext(source.slice(source.indexOf('  const devinPermissionEntries ='), source.indexOf('  const devinQuestions ='))
      + actions.slice(actions.indexOf('  const nativeSessionAction ='), actions.indexOf('  const nativeSessionRenameInput =')).replaceAll("await import('@exa/chat-client')", 'nativeModule')
      + ';this.requests=devinNativeRequests;this.answer=nativeSessionAction;', context);
    const requests = context.requests(thread); assert.equal(requests.length, 1);
    assert.deepEqual(plain(requests[0].fields), elicitationFields(schema));
    assert.equal(requests[0].fields[0].value, '0'); assert.equal(requests[0].fields[1].value, 'false');
    await assert.rejects(context.answer('devin', 'acp/' + provider + '/other', 'question', { id: requests[0].id, n: 0 }), /Binding/);
    const fields = [{ n: 0, value: '0' }, { n: 1, value: 'false' }, { n: 2, value: 'b' }, { n: 3, value: ['read', 'write'] }];
    await context.answer('devin', thread, 'question', { id: requests[0].id, n: 0, fields });
    const expected = { action: 'accept', content: { count: 0, flag: false, plan: 'b', tools: ['read', 'write'] } };
    assert.deepEqual(plain(replies[0]), { clientRequestId: 'own', response: provider === 'devin-cloud' && method === 'ext/method' ? { action: expected } : expected });
    assert.equal(state.clientRequests.foreign.status, 'pending');
    await assert.rejects(context.answer('devin', thread, 'question', { id: requests[0].id, n: 0, fields }), /已处理/);
    for (const n of [1, 2]) {
      row.status = 'pending'; await context.answer('devin', thread, 'question', { id: requests[0].id, n });
      const value = provider === 'devin-cloud' && method === 'ext/method' ? replies.at(-1).response.action : replies.at(-1).response;
      assert.deepEqual(plain(value), { action: n === 1 ? 'decline' : 'cancel' });
    }
  }
});
