import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { PAGE_SRC } from '../server/page/build.mjs';
import { methods as chatMethods } from '../server/agent/chat.mjs';
import { adapter as devinAdapter } from '../server/apps/devin.mjs';
import { ROUTES } from '../server/routes.mjs';

const SESSION = 'acp/devin-cli/sess-1';
const OPTION_KEYS = ['copyToAgentHost', 'httpUpload', 'maxEmbeddedResourceBytes', 'readFile', 'readTerminal'];
const plain = value => JSON.parse(JSON.stringify(value));
const STARTED_PROMPT = { method: 'session/prompt', status: 'started', params: { sessionId: SESSION } };

function fiberNode(contexts = [], hooks = [], parent = null) {
  return {
    memoizedState: hooks.length ? hooks.reduceRight((next, memoizedState) => ({ memoizedState, next }), null) : null,
    dependencies: contexts.length ? { firstContext: contexts.reduceRight((next, memoizedValue) => ({ memoizedValue, next }), null) } : null,
    return: parent,
  };
}
const selectorWrapped = value => ({ [Symbol.for('test.selector')]: { v: { current: value } } });

function nativePage({ contexts = [], hooks = [], options = true, sessions = [SESSION], queuedMessages = [],
  question = null, staleQuestion = null, controller = true, agentRequests, blocks, toAcpBlocks, focused } = {}) {
  const calls = { dispatch: [], cleared: 0, images: 0, quotes: 0, interrupt: [], submits: [], order: [] };
  const nativeOptions = { copyToAgentHost: undefined, readFile: undefined, maxEmbeddedResourceBytes: 1024, httpUpload: undefined, readTerminal: () => 'terminal-data' };
  const composer = {
    isEmpty: () => false,
    toAcpBlocks: optionsArg => { calls.toAcpBlocks = optionsArg; calls.order.push('convert'); return toAcpBlocks ? toAcpBlocks(optionsArg) : Promise.resolve(blocks || [{ type: 'text', text: 'converted' }]); },
    clear: () => { calls.cleared++; calls.order.push('clear'); },
  };
  const inputBox = {
    composerRef: { current: composer },
    getSelectedImages: () => [{ base64Data: 'QUJD', mimeType: 'image/png' }],
    setSelectedImages: value => { calls.images = value.length; calls.order.push('images'); },
    getSelectedQuotes: () => [{ artifact: { kind: 'file', path: '/a"b', versionRef: 'v1' }, anchor: { startLine: 1, endLine: 2 }, text: 'a<&"' }],
    setSelectedQuotes: value => { calls.quotes = value.length; calls.order.push('quotes'); },
  };
  const queueController = { cancelInvocation() {}, cancelInvocationAndWait() {}, isCanceling: false,
    interruptWithQueuedMessage: async id => { calls.interrupt.push(id); calls.order.push('interrupt'); calls.clearedAtInterrupt = calls.cleared; await Promise.resolve(); } };
  const makeQuestion = spec => spec === null ? null : {
    questions: [{ id: 'q0', question: 'pick', status: 'waiting', resetKey: spec === 'stale' ? 'req-old-0' : 'req-0' }], activeQuestionId: 'q0',
    setActiveQuestionId() {}, answerQuestion() {}, skipQuestion() {},
    isEditorDisabled: false, composerPlaceholder: null, composerAcceptsRichContent: false,
    handleComposerSubmit: spec === 'deny' ? null : value => { calls.submits.push(value); return spec === 'error' ? '答案无效' : spec === 'stale' ? '旧分支处理器' : null; },
  };
  const questionContext = makeQuestion(question), staleContext = makeQuestion(staleQuestion);
  const allContexts = [...contexts];
  if (inputBox && !contexts.some(value => value?.composerRef)) allContexts.push(selectorWrapped(inputBox));
  if (!contexts.some(value => typeof value?.getCurrentComposer === 'function'))
    allContexts.push(selectorWrapped({ getCurrentComposer: () => composer, registerInputBox() {}, unregisterInputBox() {}, activateInputBox() {}, activeInputBox: null, inputBoxes: new Map(), registerUserMessageEditCallback() {}, unregisterUserMessageEditCallback() {}, triggerLatestUserMessageEdit: () => false }));
  if (controller && !contexts.some(value => typeof value?.interruptWithQueuedMessage === 'function')) allContexts.push(selectorWrapped(queueController));
  // The native question hook is a Context Provider value on an ancestor fiber (tag 10),
  // not a consumer dependency of the Slate editor — mirror that real shape here.
  let questionProvider = null;
  if (questionContext || staleContext) {
    if (staleContext) {
      const currentRoot = { tag: 3, stateNode: {}, return: null };
      currentRoot.stateNode.current = currentRoot;
      const inactiveRoot = { tag: 3, stateNode: { current: currentRoot }, return: null };
      const currentProvider = { tag: 10, memoizedProps: { value: questionContext }, return: currentRoot, alternate: null };
      questionProvider = { tag: 10, memoizedProps: { value: staleContext }, return: inactiveRoot, alternate: currentProvider };
      currentProvider.alternate = questionProvider;
    } else {
      const hostRoot = { tag: 3, stateNode: {}, return: null };
      hostRoot.stateNode.current = hostRoot;
      questionProvider = { tag: 10, memoizedProps: { value: questionContext }, return: hostRoot, alternate: null };
    }
  }
  const fiber = fiberNode(allContexts, [...hooks, ...(options ? [nativeOptions] : [])], questionProvider);
  const editor = { parentElement: null, getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, bottom: 20, right: 40, width: 40, height: 20 }),
    querySelectorAll: () => [], querySelector: () => null, closest: () => null };
  editor.__reactFiber$fixture = fiber;
  const perSession = Object.fromEntries(sessions.map(id => [id, { queuedMessages: [...queuedMessages] }]));
  const store = {
    calls,
    state: { acp: { sessions: sessions.map(id => ({ sessionId: id, providerId: 'devin-cli', cwd: '/project', status: 'idle', title: 'T' })),
      perSession, agentRequests: { byId: agentRequests === undefined ? { 'req-1': { ...STARTED_PROMPT } } : agentRequests } } },
    dispatch(action) {
      calls.dispatch.push(action); calls.order.push('dispatch');
      if (action.type === 'acp/addQueuedMessage') {
        const list = perSession[action.payload.sessionId]?.queuedMessages;
        if (list && !action.payload.prepend) list.push(action.payload.message);
      }
    },
    getState() { return this.state; },
  };
  const document = { getElementById: () => null, querySelector: () => null, querySelectorAll: selector => selector.includes('data-slate-editor') ? [editor] : [],
    activeElement: null, body: { classList: { contains: () => false } }, defaultView: { Event: class {}, dispatchEvent: () => {} } };
  let focusedId = focused === undefined ? SESSION : focused;
  const window = { __acpStore: store,
    __SSG_COMPOSER_PROVIDER__: { getStates: () => [{ id: focusedId, state: 'focused' }] } };
  const page = vm.runInNewContext(PAGE_SRC, { document, window, crypto: crypto.webcrypto });
  return { page, calls, store, composer, inputBox, controller: queueController, questionContext, nativeOptions, blocks, fiber, document, editor,
    setFocused: id => { focusedId = id; } };
}

test('Devin native submission skips an unrelated first visible editor for both queue and text answers', async () => {
  const h = nativePage({ question: 'allow' });
  const unrelated = { ...h.editor, __reactFiber$fixture: fiberNode() };
  h.document.querySelectorAll = selector => selector.includes('data-slate-editor') ? [unrelated, h.editor] : [];
  await h.page.nativeSessionAction('devin', SESSION, 'queue', {});
  assert.equal(h.calls.dispatch.length, 1);
  assert.equal(h.calls.toAcpBlocks, h.nativeOptions);
  await h.page.nativeSessionAction('devin', SESSION, 'questionText', { text: '正确会话的回答' });
  assert.equal(h.calls.submits.length, 1);
  assert.equal(h.calls.submits[0].text, '正确会话的回答');
});

test('Devin native submission uses the registered current composer instead of another input in the same registry', async () => {
  const h = nativePage();
  let foreignConverted = 0;
  const foreignInput = { composerRef: { current: { toAcpBlocks() { foreignConverted++; return []; } } } };
  const registry = { getCurrentComposer: () => h.composer, registerInputBox() {} };
  const other = { ...h.editor, __reactFiber$fixture: fiberNode([selectorWrapped(foreignInput), selectorWrapped(registry)], [h.nativeOptions]) };
  h.document.querySelectorAll = selector => selector.includes('data-slate-editor') ? [other, h.editor] : [];
  await h.page.nativeSessionAction('devin', SESSION, 'queue', { now: true });
  assert.equal(foreignConverted, 0);
  assert.equal(h.calls.interrupt.length, 1);
  assert.equal(h.calls.toAcpBlocks, h.nativeOptions);
});

test('Devin queue with a pending question writes the native queue once and never touches the question handler', async () => {
  const h = nativePage({ question: 'allow' });
  const result = await h.page.nativeSessionAction('devin', SESSION, 'queue', {});
  assert.equal(result.queued, true);
  assert.equal(h.calls.dispatch.length, 1);
  const action = h.calls.dispatch[0];
  assert.equal(action.type, 'acp/addQueuedMessage');
  assert.equal(action.payload.sessionId, SESSION);
  assert.equal(typeof action.payload.message.id, 'string');
  assert.deepEqual(action.payload.message.contentBlocks.map(b => b.type), ['text', 'image', 'text']);
  assert.equal(h.calls.submits.length, 0);
  assert.equal(h.calls.cleared, 1);
  assert.equal(h.calls.images, 0);
  assert.equal(h.calls.quotes, 0);
  assert.equal(h.calls.interrupt.length, 0);
});

test('Devin queue without a question still dispatches addQueuedMessage directly', async () => {
  const h = nativePage({ question: 'deny' });
  const result = await h.page.nativeSessionAction('devin', SESSION, 'queue', { now: false });
  assert.equal(result.queued, true);
  assert.equal(h.calls.dispatch.length, 1);
  assert.equal(h.calls.dispatch[0].payload.message.contentBlocks[0].text, 'converted');
  assert.equal(h.calls.interrupt.length, 0);
});

test('Devin queue now interrupts with the exact newly generated native message id', async () => {
  const h = nativePage();
  const result = await h.page.nativeSessionAction('devin', SESSION, 'queue', { now: true });
  assert.equal(result.now, true);
  assert.equal(h.calls.interrupt.length, 1);
  assert.equal(h.calls.interrupt[0], h.calls.dispatch[0].payload.message.id);
  assert.match(h.calls.interrupt[0], /^[0-9a-f-]{36}$/);
  assert.equal(h.calls.cleared, 1);
});

test('Devin queue clears owned input before awaiting the native controller and never re-clears', async () => {
  const h = nativePage();
  await h.page.nativeSessionAction('devin', SESSION, 'queue', { now: true });
  assert.equal(h.calls.clearedAtInterrupt, 1, 'composer already cleared when the controller runs');
  assert.equal(h.calls.cleared, 1, 'no cleanup runs after the controller await');
  assert.deepEqual(h.calls.order.slice(-4), ['clear', 'images', 'quotes', 'interrupt']);
});

test('Devin queue forwards the identical native options object to the real converter', async () => {
  const h = nativePage();
  await h.page.nativeSessionAction('devin', SESSION, 'queue', {});
  assert.equal(h.calls.toAcpBlocks, h.nativeOptions);
  assert.equal(typeof h.nativeOptions.readTerminal, 'function');
  assert.equal(h.nativeOptions.maxEmbeddedResourceBytes, 1024);
});

test('Devin queue finds native conversion options beyond five hundred linked hooks', async () => {
  const customOptions = { copyToAgentHost: undefined, httpUpload: undefined, maxEmbeddedResourceBytes: undefined, readFile: undefined, readTerminal: () => 't' };
  const h = nativePage({ options: false, hooks: [...Array.from({ length: 600 }, () => null), [customOptions, []]] });
  await h.page.nativeSessionAction('devin', SESSION, 'queue', {});
  assert.equal(h.calls.toAcpBlocks, customOptions);
});

test('Devin queue preserves native image and quoted-artifact content blocks', async () => {
  const h = nativePage();
  await h.page.nativeSessionAction('devin', SESSION, 'queue', {});
  const blocks = h.calls.dispatch[0].payload.message.contentBlocks;
  assert.deepEqual(plain(blocks[1]), { type: 'image', data: 'QUJD', mimeType: 'image/png' });
  const quote = blocks[2];
  assert.equal(quote.type, 'text');
  assert.equal(quote._meta.quote.artifact.kind, 'file');
  assert.match(quote.text, /<quoted_artifact kind="file" path="\/a&quot;b" version_ref="v1" start_line="1" end_line="2">/);
  assert.match(quote.text, /<content>\na&lt;&amp;&quot;\n<\/content>/);
});

test('Devin queue keeps converter resource blocks for files and terminals verbatim', async () => {
  const resource = { type: 'resource', resource: { uri: 'file:///tmp/a.txt', text: 'file body', mimeType: 'text/plain' }, _meta: { 'cognition.ai/scope-item-type': 'file' } };
  const terminal = { type: 'resource', resource: { uri: 'terminal://1', text: 'term', mimeType: 'text/plain' } };
  const h = nativePage({ blocks: [resource, { type: 'text', text: 'see attached' }, terminal] });
  await h.page.nativeSessionAction('devin', SESSION, 'queue', {});
  const blocks = h.calls.dispatch[0].payload.message.contentBlocks;
  assert.deepEqual(plain(blocks.slice(0, 3)), [resource, { type: 'text', text: 'see attached' }, terminal]);
});

test('Devin queue accepts image-only and quote-only composers after conversion', async () => {
  const imageOnly = nativePage({ blocks: [], toAcpBlocks: () => Promise.resolve([]) });
  imageOnly.inputBox.getSelectedQuotes = () => [];
  const imageResult = await imageOnly.page.nativeSessionAction('devin', SESSION, 'queue', {});
  assert.equal(imageResult.queued, true);
  assert.deepEqual(imageOnly.calls.dispatch[0].payload.message.contentBlocks.map(b => b.type), ['image']);
  const quoteOnly = nativePage({ blocks: [], toAcpBlocks: () => Promise.resolve([]) });
  quoteOnly.inputBox.getSelectedImages = () => [];
  const quoteResult = await quoteOnly.page.nativeSessionAction('devin', SESSION, 'queue', {});
  assert.equal(quoteResult.queued, true);
  assert.deepEqual(quoteOnly.calls.dispatch[0].payload.message.contentBlocks.map(b => b.type), ['text']);
  assert.equal(quoteOnly.calls.dispatch[0].payload.message.contentBlocks[0]._meta.quote.artifact.kind, 'file');
});

test('Devin queue rejects when conversion plus attachments still produce no content', async () => {
  const h = nativePage({ blocks: [], toAcpBlocks: () => Promise.resolve([]) });
  h.inputBox.getSelectedImages = () => [];
  h.inputBox.getSelectedQuotes = () => [];
  await assert.rejects(h.page.nativeSessionAction('devin', SESSION, 'queue', {}), /没有可发送的内容/);
  assert.equal(h.calls.dispatch.length, 0);
  assert.equal(h.calls.cleared, 0);
});

test('Devin queue conversion failure preserves the owned composer input', async () => {
  const h = nativePage();
  h.composer.toAcpBlocks = () => Promise.reject(new Error('convert failed'));
  await assert.rejects(h.page.nativeSessionAction('devin', SESSION, 'queue', {}), /转换失败/);
  assert.equal(h.calls.dispatch.length, 0);
  assert.equal(h.calls.cleared, 0);
  assert.equal(h.calls.images, 0);
  assert.equal(h.calls.quotes, 0);
});

test('Devin queue re-checks the active session after awaited conversion', async () => {
  const h = nativePage({ toAcpBlocks: () => { h.setFocused('acp/devin-cli/other'); return Promise.resolve([{ type: 'text', text: 'x' }]); } });
  await assert.rejects(h.page.nativeSessionAction('devin', SESSION, 'queue', {}), /会话已切换/);
  assert.equal(h.calls.dispatch.length, 0);
  assert.equal(h.calls.cleared, 0);
});

test('Devin queue clears only the owned input after native acceptance', async () => {
  const h = nativePage();
  h.store.state.acp.perSession[SESSION].queuedMessages = null;
  h.store.dispatch = action => { h.calls.dispatch.push(action); };
  await assert.rejects(h.page.nativeSessionAction('devin', SESSION, 'queue', {}), /没有接受/);
  assert.equal(h.calls.cleared, 0);
});

test('Devin queue rejects an empty composer without dispatching', async () => {
  const h = nativePage();
  h.composer.isEmpty = () => true;
  h.inputBox.getSelectedImages = () => [];
  h.inputBox.getSelectedQuotes = () => [];
  await assert.rejects(h.page.nativeSessionAction('devin', SESSION, 'queue', {}), /空的/);
  assert.equal(h.calls.dispatch.length, 0);
});

test('Devin queue delivers immediately through the native controller when the session is idle', async () => {
  const h = nativePage({ agentRequests: {} });
  const result = await h.page.nativeSessionAction('devin', SESSION, 'queue', {});
  assert.equal(result.queued, true);
  assert.equal(h.calls.interrupt.length, 1);
  assert.equal(h.calls.interrupt[0], h.calls.dispatch[0].payload.message.id);
  assert.equal(h.calls.clearedAtInterrupt, 1);
});

test('Devin queue stays queued while a native prompt is in flight, even with a pending question', async () => {
  const h = nativePage({ question: 'allow', agentRequests: { 'req-1': { ...STARTED_PROMPT } } });
  await h.page.nativeSessionAction('devin', SESSION, 'queue', {});
  assert.equal(h.calls.interrupt.length, 0);
  const other = nativePage({ agentRequests: { 'req-2': { method: 'session/prompt', status: 'started', params: { sessionId: 'acp/devin-cli/other' } } } });
  await other.page.nativeSessionAction('devin', SESSION, 'queue', {});
  assert.equal(other.calls.interrupt.length, 1, 'a prompt for another session does not block delivery');
});

test('Devin queue validates the native controller before dispatch whenever delivery is needed', async () => {
  const idle = nativePage({ controller: false, agentRequests: {} });
  await assert.rejects(idle.page.nativeSessionAction('devin', SESSION, 'queue', {}), /控制器/);
  assert.equal(idle.calls.dispatch.length, 0);
  assert.equal(idle.calls.cleared, 0);
  const now = nativePage({ controller: false });
  await assert.rejects(now.page.nativeSessionAction('devin', SESSION, 'queue', { now: true }), /控制器/);
  assert.equal(now.calls.dispatch.length, 0);
  assert.equal(now.calls.cleared, 0);
  const busy = nativePage({ controller: false });
  const result = await busy.page.nativeSessionAction('devin', SESSION, 'queue', {});
  assert.equal(result.queued, true, 'a busy queue needs no controller');
  assert.equal(busy.calls.interrupt.length, 0);
});

test('Devin questionText invokes only the native handler with the exact payload', async () => {
  const h = nativePage({ question: 'allow' });
  const result = await h.page.nativeSessionAction('devin', SESSION, 'questionText', { text: '我的回答' });
  assert.deepEqual(plain(result), { answered: true });
  assert.equal(h.calls.submits.length, 1);
  assert.deepEqual(plain(h.calls.submits[0]), { text: '我的回答', items: [], images: [] });
  assert.equal(h.calls.dispatch.length, 0);
  assert.equal(h.calls.cleared, 0);
});

test('Devin questionText propagates native validation errors and rejects blank text', async () => {
  const h = nativePage({ question: 'error' });
  await assert.rejects(h.page.nativeSessionAction('devin', SESSION, 'questionText', { text: 'x' }), /答案无效/);
  const blank = nativePage({ question: 'allow' });
  await assert.rejects(blank.page.nativeSessionAction('devin', SESSION, 'questionText', { text: '  ' }), /不能为空/);
  assert.equal(blank.calls.submits.length, 0);
});

test('Devin questionText refuses questions without a native free-text handler', async () => {
  const h = nativePage({ question: 'deny' });
  await assert.rejects(h.page.nativeSessionAction('devin', SESSION, 'questionText', { text: 'x' }), /不支持自由文字/);
  assert.equal(h.calls.submits.length, 0);
});

test('Devin questionText reads the current provider branch, never the stale alternate', async () => {
  const h = nativePage({ question: 'allow', staleQuestion: 'stale' });
  const result = await h.page.nativeSessionAction('devin', SESSION, 'questionText', { text: '新答案' });
  assert.deepEqual(plain(result), { answered: true });
  assert.equal(h.calls.submits.length, 1);
  assert.equal(h.calls.submits[0].text, '新答案');
});

test('Devin questionText rejects when the current provider has no handler, never calling the stale one', async () => {
  const h = nativePage({ question: 'deny', staleQuestion: 'stale' });
  await assert.rejects(h.page.nativeSessionAction('devin', SESSION, 'questionText', { text: 'x' }), /不支持自由文字/);
  assert.equal(h.calls.submits.length, 0);
});

test('queue and questionText actions stay Devin-only', async () => {
  const h = nativePage();
  await assert.rejects(h.page.nativeSessionAction('cursor', 'cursor-1', 'queue', {}));
  await assert.rejects(h.page.nativeSessionAction('cursor', 'cursor-1', 'questionText', { text: 'x' }));
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
