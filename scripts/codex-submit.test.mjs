import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { PAGE_SRC } from '../server/page/build.mjs';
import { ROUTES } from '../server/routes.mjs';
import { adapter, methods as codexMethods } from '../server/apps/codex.mjs';
import { methods as chatMethods } from '../server/agent/chat.mjs';
import { FOCUS_COMPOSER } from '../server/agent/context.mjs';
import { cdpRead, awaitCdpRead } from '../server/cdp.mjs';
import { withOperation } from '../server/operations.mjs';
import { NativeWindow } from '../server/native-windows.mjs';
import { nativePage } from './page-fixture.mjs';

for (const revision of ['first', 'renamed']) {
  test(`Codex discovers merged modules and renamed exports, retaining native per-thread drafts: ${revision}`, async () => {
    fs.mkdirSync('_shots', { recursive: true });
    const folder = fs.mkdtempSync('_shots/codex-module-test-'), base = pathToFileURL(process.cwd() + '/' + folder + '/');
    const names = revision === 'first' ? ['aa', 'bb', 'cc', 'dd', 'ee', 'ff'] : ['X', 'Y', 'Z', '$q', '$r', '$s'];
    const [scopeName, stateName, textName, editName, createName, initName] = names;
    const files = {
      'entry.js': `import('./shell-${revision}.js');`,
      [`shell-${revision}.js`]: `export{${scopeName}}from'./scope-${revision}.js';export{${stateName}}from'./merged-${revision}.js';export{${createName}}from'./inputs-${revision}.js';`,
      [`scope-${revision}.js`]: `function ignored(e,t){e.parent?.retainedScopeEntries.get(t)}function retained(e,t,n){if(t.parent==null)return null;let r=e.chain.get(t.parent.id).retainedScopeEntries.get(t)?.get(n)?.node;if(r==null)return null;let i=new Map(e.chain);return i.set(t.id,r),r.accessor}export{retained as ${scopeName}};`,
      [`merged-${revision}.js`]: 'function derive(s,read){return{read}}const S={},D={key:"draft"},V={key:"view"},T={key:"text"};' +
        'var C=derive(S,({get:g})=>({...g(V),prompt:g(T)}));' +
        'function edit(s,fn){let n=s.get(D)??{prompt:``,pullRequestChecks:[]},r=produce(n,fn);r!==n&&commit(s,r)}' +
        'function produce(d,fn){const next=structuredClone(d);fn(next);return next}function commit(s,next,{discardRetainedDraft=false}={}){s.set(D,next)}' +
        `export{C as ${stateName},T as ${textName},edit as ${editName}};`,
      [`inputs-${revision}.js`]: 'function once(fn){let ran=false;return()=>{if(!ran){ran=true;fn()}}}var Reader;function initClass(){Reader=class{constructor(params){this.params=params}async readCreationInputs(options,history){return{options,history,scope:this.params.scope.value,host:this.params.hostId}}}}' +
        'const Client={key:"client"};function factory(s,h){return new Reader({scope:s,hostId:h,requestClient:s.get(Client),dynamicTools:{}})}' +
        'function initialize(){return(initialize=once((()=>{initClass()})))()}' +
        `export{factory as ${createName},initialize as ${initName}};`,
    };
    for (const [name, source] of Object.entries(files)) {
      const renamed = revision === 'renamed' ? source.replace(/\b(retained|ignored|derive|edit|produce|commit|Reader|initClass|factory|initialize|once)\b/g, local => '$new_' + local) : source;
      fs.writeFileSync(new URL(name, base), renamed);
    }
    try {
      const token = { id: 'composer', __scopeBrand: 'ComposerScope', parent: { id: 'root' } };
      const drafts = new Map([['A', { prompt: 'draft A', pullRequestChecks: ['check-A'], attachment: { id: 'file-A' } }],
        ['B', { prompt: 'draft B', pullRequestChecks: [] }]]), writes = [];
      const root = { token: token.parent, value: {}, retainedScopeEntries: new Map(), familyBindings: new Map() };
      const children = new Map(); root.retainedScopeEntries.set(token, children);
      for (const id of drafts.keys()) {
        const accessor = { value: { conversationId: id }, query: { native: true },
          get(ref) { return ref.read ? ref.read({ get: value => this.get(value) }) : ref.key === 'draft' ? drafts.get(id)
            : ref.key === 'text' ? drafts.get(id).prompt : ref.key === 'view' ? { composerMode: 'local', isAutoContextOn: id === 'A' } : null; },
          set(ref, value) { assert.equal(ref.key, 'draft'); writes.push(id); drafts.set(id, value); },
        };
        const node = { token, key: id, parent: root, value: accessor.value, accessor,
          retainedScopeEntries: new Map(), familyBindings: new Map() };
        children.set(id, { node });
      }
      const reads = [], window = {}, document = { scripts: [{ src: new URL('entry.js', base).href }], getElementById: () => null };
      const fetch = async url => { reads.push(url); return { text: async () => fs.readFileSync(fileURLToPath(url), 'utf8') }; };
      const source = PAGE_SRC.replace('return { historyAtStart', 'return { codexNativeModule, historyAtStart');
      const page = new Function('document', 'window', 'fetch', 'return ' + source)(document, window, fetch);
      // Use the existing history-scope discovery with a native provider root.
      const provider = { getBoundingClientRect: () => ({ width: 10, height: 10 }),
        __reactFiberFixture: { memoizedProps: { value: new Map([['root', root]]) } } };
      document.querySelectorAll = selector => selector.includes('[data-composer-body]') ? [provider] : [];
      const [a, b] = await Promise.all([page.nativeSessionInfo('codex', 'A', 'draft'), page.nativeSessionInfo('codex', 'B', 'draft')]);
      assert.equal(a, 'draft A'); assert.equal(b, 'draft B');
      assert.equal(await page.nativeSessionInfo('codex', 'A', 'draft', 'updated A'), 'updated A');
      assert.deepEqual(writes, ['A']); assert.equal(drafts.get('B').prompt, 'draft B');
      assert.deepEqual(drafts.get('A').pullRequestChecks, ['check-A']); assert.deepEqual(drafts.get('A').attachment, { id: 'file-A' });
      assert.equal(await page.nativeSessionInfo('codex', 'A', 'clearDraft', 'old draft'), 'updated A');
      assert.equal(await page.nativeSessionInfo('codex', 'A', 'clearDraft', 'updated A'), '');
      assert.equal(drafts.get('B').prompt, 'draft B');
      const create = await page.codexNativeModule('creation'), reader = create(children.get('A').node.accessor, 'local');
      assert.equal(reader.params.scope.query.native, true);
      const options = { cwd: '/project-A', model: 'chosen-model', permissions: 'existing-policy', tools: ['ra_fusion'] };
      assert.deepEqual(await reader.readCreationInputs(options, []), { options, history: [], scope: { conversationId: 'A' }, host: 'local' });
      assert.equal(reads.length, Object.keys(files).length); assert.equal(new Set(reads).size, reads.length);
      assert(Object.values(await window.__remoteAgentNativeModules.get('graph')).every(module => !('source' in module)));
    } finally { fs.rmSync(folder, { recursive: true, force: true }); }
  });
}

for (const chinese of [false, true]) for (const follow of ['', 'queue', 'steer']) for (const dispatch of [false, true]) {
  test(`native submit keeps the original ${follow || 'default'} action with ${chinese ? 'Chinese' : 'English'} controls, dispatch=${dispatch}`, async () => {
    const nativeCalls = [], clicked = [];
    const names = chinese ? ['发送', '排队', '引导'] : ['Send', 'Queue', 'Steer'];
    const buttons = names.map(label => ({ getBoundingClientRect: () => ({ width: 20, height: 20 }),
      getAttribute: key => key === 'aria-label' ? label : null, click: () => clicked.push(label) }));
    const root = { querySelectorAll: () => buttons };
    const editor = { getBoundingClientRect: () => ({ width: 40, height: 20 }), closest: () => null, contains: () => false,
      __reactFiberFixture: { memoizedProps: { handleSubmit: value => { nativeCalls.push(value); }, submitDisabled: false, isInteractionBlocked: false, interactionsEnabled: true,
        composerController: { getText: () => 'test draft' } } } };
    const document = { getElementById: () => null, querySelector: () => null,
      querySelectorAll: selector => selector === '.ProseMirror[contenteditable="true"]' ? [editor] : [] };
    const page = nativePage(document, { getComputedStyle: () => ({ visibility: 'visible' }) });
    assert.equal(await page.submitCodexMessage(follow, dispatch, 'request-fixture'), true);
    assert.equal(clicked.length, 0);
    assert.equal(nativeCalls.length, 1);
    assert.equal(nativeCalls[0]?.followUpSubmitAction, follow || undefined);
  });
}

function submitLifecycle(handleSubmit, flags = {}) {
  const events = [], nativeWindow = {};
  const draft = { value: 'draft', writes: 0 };
  const editor = { getBoundingClientRect: () => ({ width: 40, height: 20 }), closest: () => null, contains: () => false,
    __reactFiberFixture: { memoizedProps: { handleSubmit, submitDisabled: false, isInteractionBlocked: false, interactionsEnabled: true, ...flags, conversationId: 'thread', composerController: {
      getText: () => draft.value, setText: value => { draft.value = value; draft.writes++; },
    } } } };
  const document = { getElementById: () => null, querySelector: () => null,
    defaultView: { Event: class { constructor(type) { this.type = type; } }, dispatchEvent: event => events.push(event.type) },
    querySelectorAll: selector => selector === '.ProseMirror[contenteditable="true"]' || selector === '.ProseMirror' ? [editor] : [] };
  return { page: nativePage(document, { window: nativeWindow, getComputedStyle: () => ({ visibility: 'visible' }) }), nativeWindow, events, draft };
}

test('Codex submit and draft reads select the focused composer instead of the first visible blocked editor', async () => {
  const calls = [];
  const editor = (name, blocked) => ({ closest: () => null,
    contains: active => active === name, getBoundingClientRect: () => ({ width: 40, height: 20 }),
    __reactFiberFixture: { memoizedProps: { submitDisabled: blocked, isInteractionBlocked: blocked, interactionsEnabled: true,
      composerController: { getText: () => name }, handleSubmit: options => calls.push({ name, options }) } } });
  const blocked = editor('other-composer', true), selected = editor('selected-composer', false);
  const document = { activeElement: 'selected-composer', getElementById: () => null, querySelector: () => null,
    querySelectorAll: selector => selector === '.ProseMirror[contenteditable="true"]' ? [blocked, selected] : [] };
  const page = nativePage(document, { getComputedStyle: () => ({ visibility: 'visible' }) });
  assert.equal(page.codexPromptPayload(), 'selected-composer');
  assert.equal(await page.submitCodexMessage('queue', true, 'multiple-composers'), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'selected-composer');
  assert.equal(calls[0].options.followUpSubmitAction, 'queue');
  document.activeElement = 'other-composer';
  assert.equal(await page.submitCodexMessage('', true, 'blocked-composer'), false);
  assert.equal(calls.length, 1);
});

for (const dispatch of [false, true]) for (const flags of [
  { submitDisabled: true }, { isInteractionBlocked: true }, { interactionsEnabled: false },
]) {
  test(`native submit respects ${Object.keys(flags)[0]}, dispatch=${dispatch}`, async () => {
    let calls = 0;
    const h = submitLifecycle(() => { calls++; }, flags);
    assert.equal(await h.page.submitCodexMessage('', dispatch, 'blocked-request'), false);
    assert.equal(calls, 0);
    assert.equal(h.draft.value, 'draft'); assert.equal(h.draft.writes, 0);
    assert.deepEqual(h.events, []);
  });
}

test('native submit confirmation stays pending until its handler settles, without clearing a newer draft', async () => {
  let confirm, calls = 0;
  const h = submitLifecycle(() => { calls++; return new Promise(resolve => { confirm = resolve; }); });
  await h.page.submitCodexMessage('', true, 'request');
  h.draft.value = '新的未发草稿';
  let settled = false;
  const wait = h.page.codexViewState(true).then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false); assert.equal(calls, 1);
  assert.equal(h.nativeWindow.__remoteAgentCodexSubmissions.size, 1);
  confirm(); await wait;
  assert.equal(settled, true); assert.equal(h.nativeWindow.__remoteAgentCodexSubmissions.size, 0);
  assert.equal(h.draft.value, '新的未发草稿'); assert.equal(h.draft.writes, 0); assert.equal(calls, 1);
});

test('native submit rejection preserves the existing error receipt and releases only the submission wait', async () => {
  const h = submitLifecycle(() => Promise.reject(new Error('native submit rejected')));
  await h.page.submitCodexMessage('queue', true, 'request-failed');
  await h.page.codexViewState(true);
  assert.deepEqual(h.events, ['remote-agent-submit-error']);
  assert.equal(h.nativeWindow.__remoteAgentSubmitErrors[0].requestId, 'request-failed');
  assert.equal(h.nativeWindow.__remoteAgentSubmitErrors[0].message, 'native submit rejected');
  assert.equal(h.nativeWindow.__remoteAgentCodexSubmissions.size, 0);
});

test('RA new chat waits for send confirmation and can proceed while the previous reply is generating', async () => {
  let confirm, clicked = false;
  const generating = true;
  const confirmation = new Promise(resolve => { confirm = resolve; });
  const context = { cdp: { evaluate: async expression => {
    if (expression.endsWith('.codexViewState(true)')) return confirmation;
    if (expression.endsWith('.codexThread()')) return 'previous';
    if (expression.endsWith('.codexNewPoint()')) return { x: 1, y: 1 };
    if (expression.endsWith('.codexViewState()')) return { thread: '', turns: 0 };
    assert.fail('unexpected native read');
  } }, checkCodexLogin: async () => false, tapCss: async () => { clicked = true; }, adoptCodexThread: async () => {} };
  const opening = codexMethods.newCodexChat.call(context);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(clicked, false);
  confirm(); await opening;
  assert.equal(clicked, true); assert.equal(generating, true);
});

function sendAfterSubmission(app = 'codex') {
  let settle;
  const pending = new Promise(resolve => { settle = resolve; });
  const writes = [], events = [], controller = new AbortController();
  let waits = 0, draft = 'later draft';
  const context = { app, scope: 'selection-1', sending: false,
    selectionKey() { return this.scope; }, assertSelectedThread: async () => {},
    emit: event => events.push(event), syncAttachments: async () => {},
    adapter: {
      async typeDraft(text) { writes.push(['draft', text]); draft = text; },
      async submitPrompt(now, busy, when) { writes.push(['submit', draft, busy, when]); return !!busy; },
    },
  };
  context.cdp = { nativeWindow: {}, async evaluate(expression) {
    if (expression.endsWith('.codexViewState(true)')) { waits++; return awaitCdpRead(pending); }
    if (expression.includes('return { focused, busy: h.agentState()?.busy, draft: h.composerDraft() };')) { writes.push(['focus']); return { focused: true, busy: true, draft }; }
    if (expression.endsWith('.composerDraft()')) return draft;
    if (expression.endsWith('.agentState()?.busy')) return true;
    if (expression.endsWith(".setComposerDraft('')")) { writes.push(['clear']); draft = ''; return true; }
    if (expression === FOCUS_COMPOSER) { writes.push(['focus']); return true; }
    if (expression.includes('h.setComposerDraft(')) { draft = 'newer mobile draft'; writes.push(['mirror', draft]); return { draft }; }
    assert.fail('unexpected send read');
  } };
  return { context, writes, events, controller, settle,
    get waits() { return waits; }, get draft() { return draft; },
    run(when) { return cdpRead.run(controller.signal, () => chatMethods.sendMessage.call(context,
      'next message', true, when, [], { requestId: 'next-request' })); },
  };
}

for (const when of [undefined, 'queue', 'now']) {
  test(`Codex ${when || 'default'} waits before writing the next send, then submits once while generation continues`, async () => {
    const h = sendAfterSubmission(), sending = h.run(when);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.waits, 1); assert.deepEqual(h.writes, []); assert.deepEqual(h.events, []);
    assert.equal(h.draft, 'later draft');
    h.settle(); await sending;
    assert.deepEqual(h.writes, [['focus'], ['clear'], ['draft', 'next message'], ['submit', 'next message', true, when]]);
    assert.equal(h.events.length, 1); assert.equal(h.events[0].requestId, 'next-request');
  });
}

test('Codex stop cancels a send waiting for the previous submission without writes or a second submit', async () => {
  const h = sendAfterSubmission(), sending = h.run('queue');
  await new Promise(resolve => setImmediate(resolve));
  h.controller.abort(); await assert.rejects(sending, { name: 'AbortError' });
  h.settle(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.writes, []); assert.deepEqual(h.events, []); assert.equal(h.draft, 'later draft');
});

for (const change of ['selection', 'connection']) {
  test(`Codex waiting send cannot write to a changed ${change}`, async () => {
    const h = sendAfterSubmission(), sending = h.run('queue');
    await new Promise(resolve => setImmediate(resolve));
    if (change === 'selection') h.context.scope = 'selection-2';
    else h.context.cdp = { evaluate: () => assert.fail('must not write to the new connection') };
    h.settle(); await assert.rejects(sending, /会话已切换，消息未发送/);
    assert.deepEqual(h.writes, []); assert.deepEqual(h.events, []); assert.equal(h.draft, 'later draft');
  });
}

test('Codex draft editing remains available during native submission preparation', async () => {
  const h = sendAfterSubmission();
  assert.equal(await chatMethods.setDraft.call(h.context, 'newer mobile draft'), true);
  assert.equal(h.waits, 0); assert.equal(h.draft, 'newer mobile draft');
  assert.equal(h.context.lastDraft, 'newer mobile draft');
  assert.deepEqual(h.writes, [['mirror', 'newer mobile draft']]);
});

for (const value of ['中文 text', 'first\n\n第三行\n', Array.from({ length: 30 }, (_, i) => 'line ' + i).join('\n')]) {
  test(`Codex ordinary draft writes all ${value.split('\n').length} lines through one existing editor transaction`, async () => {
    const calls = [];
    const context = { cdp: { async evaluate(expression) {
      calls.push(expression);
      const expected = JSON.stringify(value);
      assert(expression.endsWith(`.setComposerDraft(${expected})`));
      return true;
    } }, typeText: () => assert.fail('ordinary text must not be retyped line by line'),
      typeWithCodexMentions: () => assert.fail('ordinary text has no references') };
    await adapter.typeDraft.call(context, value, []);
    assert.equal(calls.length, 1);
  });
}

test('Codex draft references keep their existing rich-input path and unavailable input reports failure', async () => {
  const mentions = [{ section: 'local-files', label: 'file.txt' }], calls = [];
  await adapter.typeDraft.call({ typeWithCodexMentions: async (...args) => calls.push(args),
    cdp: { evaluate: () => assert.fail('references must retain their native rich-input path') } }, 'body', mentions);
  assert.deepEqual(calls, [['body', mentions]]);
  await assert.rejects(adapter.typeDraft.call({ cdp: { evaluate: async () => false } }, 'body', []), /输入尚未就绪/);
});

test('Codex draft reads wait for native submission settlement and retain the genuinely newer desktop draft', async () => {
  let settle, value = 'already submitted', done = false;
  const pending = new Promise(resolve => { settle = resolve; }), events = [];
  const fixture = { async codexViewState(wait) { assert.equal(wait, true); await pending; }, composerDraft: () => value };
  const context = { app: 'codex', draftEpoch: 'epoch', draftGeneration: 0, selectionKey: () => 'codex|A',
    cdp: { evaluate: expression => vm.runInNewContext(expression.replace(PAGE_SRC, 'fixture'), { fixture }) },
    emit: event => events.push(event) };
  const reading = ROUTES.draft.pre(context, { draftEpoch: 'epoch', revision: 3 }).then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false); assert.equal(events.length, 0);
  value = 'new unsent desktop draft'; settle(); await reading;
  assert.equal(events[0].text, value); assert.equal(events[0].ok, true);
  assert.equal(events[0].revision, 3); assert.equal(events[0].sel, 'codex|A');
});

for (const app of ['cursor', 'devin']) test(`${app} draft reads retain their immediate native read`, async () => {
  const events = [], fixture = { composerDraft: () => app + ' draft', codexViewState: () => assert.fail('no Codex wait') };
  await ROUTES.draft.pre({ app, draftEpoch: 'epoch', draftGeneration: 0, selectionKey: () => app + '|A',
    cdp: { evaluate: expression => vm.runInNewContext(expression.replace(PAGE_SRC, 'fixture'), { fixture }) },
    emit: event => events.push(event) }, { draftEpoch: 'epoch', revision: 1 });
  assert.equal(events[0].text, app + ' draft'); assert.equal(events[0].ok, true);
});

for (const app of ['cursor', 'devin']) {
  test(`${app} sends keep their existing path without the Codex submission wait`, async () => {
    const h = sendAfterSubmission(app);
    await h.run();
    assert.equal(h.waits, 0); assert.equal(h.writes.filter(row => row[0] === 'submit').length, 1);
  });
}

for (const chinese of [false, true]) for (const available of [false, true]) {
  test(`native Max setting preserves selection and cleanup, Chinese=${chinese}, available=${available}`, async () => {
    const points = [], keys = [], calls = [];
    let current = 'general', enabled = false;
    const data = () => ({ nav: [{ id: 'general', label: 'General', current: current === 'general' },
      { id: 'config', label: chinese ? '配置' : 'Configuration', current: current === 'config' }],
      rows: [{ label: chinese ? '可用推理强度' : 'Available reasoning efforts', controls: [{ id: 'efforts' }] }] });
    const cdp = { async evaluate(source) {
      if (source.endsWith('.codexSettingsData()') || source.includes('.waitSettings(')) return data();
      if (source.includes('.codexSettingPoint(')) return { x: /"(general|config|efforts|max)"/.exec(source)[1], y: 1 };
      if (source.startsWith('new Promise')) return enabled;
      if (source.includes('[role=menuitemcheckbox]')) return available ? { id: 'max', enabled } : null;
      throw Error('unexpected Max test read');
    } };
    const context = {
      withCodexSettings: fn => fn(cdp), closeCodexSettings: async () => calls.push('close'),
      tapCss: async x => { points.push(x); if (x === 'config' || x === 'general') current = x; if (x === 'max') enabled = true; },
      key: async value => keys.push(value),
    };
    const work = codexMethods.enableCodexMax.call(context);
    if (available) { await work; assert.equal(enabled, true); assert.deepEqual(points, ['config', 'efforts', 'max', 'general']); assert.deepEqual(keys, ['Escape']); }
    else { await assert.rejects(work, /当前 Codex 无法启用 Max/); assert.equal(enabled, false); assert.deepEqual(points, ['config', 'efforts', 'general']); }
    assert.deepEqual(calls, ['close']); assert.equal(current, 'general');
  });
}

function submission({ native = true, busy = false, when, follow = 'queue', payload = '  hello\n world  ', serialized = payload,
  attachments = false, mentions, receipt = true, submitted = true, submitError, waitError, afterRead, afterWait } = {}) {
  const events = [], calls = [], operation = { pending: false, submitted: false }, controller = new AbortController();
  const before = { thread: 'thread-1', payload, draft: 'draft', hasDraftAttachments: attachments, follow,
    lastTurn: 'turn-1', runs: [{ id: 'turn-1' }], messages: [{ id: 'message-1' }], queued: [{ id: 'queue-1' }] };
  const intended = !!busy && (when === 'queue' || (!when && follow === 'queue'));
  const files = [{ pending: true }];
  let request, finish, unregister = 0;
  const context = { threadId: before.thread, scope: 'selection-1', lastDraft: 'original', sendNativeReceipt: {},
    selectionKey() { return this.scope; }, emit(message) { events.push(message); } };
  const args = (expression, name) => JSON.parse('[' + expression.slice(expression.lastIndexOf('.' + name + '(') + name.length + 2, -1) + ']');
  context.cdp = { async evaluate(expression) {
    if (expression.endsWith('.codexSendState(true)')) {
      calls.push('read');
      afterRead?.(context, controller);
      return structuredClone(before);
    }
    if (expression.includes(".nativeSessionInfo('codex',")) { controller.signal.throwIfAborted(); return serialized; }
    if (expression.includes('.submitCodexMessage(')) {
      calls.push(['submit', ...args(expression, 'submitCodexMessage')]);
      if (native) assert.equal(operation.submitted, true);
      if (submitError) throw submitError;
      return submitted;
    }
    calls.push(['wait', ...args(expression, 'waitCodexReceipt')]);
    if (waitError) throw waitError;
    afterWait?.(context, controller);
    return { queued: intended, messageId: 'message-2', ...(intended ? { queueId: 'queue-2' } : {}) };
  } };
  if (native) context.cdp.nativeWindow = {
    async composerCall(call) { controller.signal.throwIfAborted(); assert.equal(call, `nativeSessionInfo('codex', ${JSON.stringify(before.thread)}, 'draft')`); return serialized; },
    registerSend(value, callback) {
    assert.equal(context.sendNativeReceipt.pending, true);
    assert.equal(operation.pending, true);
    assert.equal(operation.submitted, false);
    calls.push('register'); request = value; finish = callback;
    return () => { unregister++; };
  } };
  return { context, before, events, calls, operation, controller, files, intended,
    get request() { return request; }, get unregister() { return unregister; },
    finish(...values) { finish(...values); },
    run() { return withOperation(operation, () => cdpRead.run(controller.signal,
      () => adapter.submitPrompt.call(context, when === 'now', busy, when, false, mentions,
        receipt ? { requestId: 'request-1' } : undefined, files))); } };
}

for (const native of [true, false]) {
  const mode = native ? 'window' : 'page';
  for (const intent of [{ busy: false }, { busy: true }, { busy: true, follow: 'steer' },
    { busy: true, when: 'queue' }, { busy: true, when: 'now' }, { busy: false, when: 'queue' }]) {
    test(`${mode}: send intent ${JSON.stringify(intent)}`, async () => {
      const state = submission({ native, ...intent });
      assert.equal(await state.run(), state.intended);
      assert.equal(state.context.lastDraft, state.before.draft);
      assert.equal(state.calls.filter(call => call === 'read').length, 1);
      const submits = state.calls.filter(call => Array.isArray(call) && call[0] === 'submit');
      assert.equal(submits.length, 1);
      assert.equal(submits[0][1], intent.when === 'now' ? 'steer' : intent.when === 'queue' ? 'queue' : '');
      if (native) {
        assert.deepEqual(state.calls.slice(0, 2), ['read', 'register']);
        assert.equal(submits[0][2], true);
        assert.equal(submits[0][3], 'request-1');
        assert.equal(state.request.action, state.intended ? 'queue' : intent.busy ? 'steer' : 'send');
        assert.equal(state.request.expected, 'hello\n world');
        assert.deepEqual([...state.request.before], ['message-1']);
        assert.deepEqual([...state.request.beforeQueues], ['queue-1']);
        assert.deepEqual([...state.request.beforeTurns], ['turn-1']);
        assert.equal(state.request.afterTurn, 'turn-1');
        assert.equal(state.context.sendNativeReceipt.pending, true);
      } else {
        assert.equal(submits[0].length, 2);
        const wait = state.calls.find(call => Array.isArray(call) && call[0] === 'wait');
        assert.deepEqual(wait[1], { thread: 'thread-1', messages: [{ id: 'message-1' }], queued: [{ id: 'queue-1' }] });
        assert.equal(wait[2], 'hello\n world');
        assert.equal(state.context.sendNativeReceipt.messageId, 'message-2');
      }
    });
  }

  for (const input of [{ attachments: true, payload: '' },
    { mentions: [{ section: 'local-files' }], payload: '' }, { payload: 'plain text' }]) {
    test(`${mode}: attachment facts ${JSON.stringify(input)}`, async () => {
      const state = submission({ native, ...input });
      await state.run();
      const expected = !!input.attachments || !!input.mentions?.length;
      assert.equal(native ? state.request.hasAttachments
        : state.calls.find(call => Array.isArray(call) && call[0] === 'wait')[4], expected);
    });
  }

  test(`${mode}: unavailable payload never submits`, async () => {
    const state = submission({ native, payload: null });
    await assert.rejects(state.run(), /Codex 输入尚未就绪/);
    assert.deepEqual(state.calls, ['read']);
    assert.equal(state.context.lastDraft, 'original');
    assert.equal(state.operation.submitted, false);
  });

  test(`${mode}: rejected submit does not report success`, async () => {
    const state = submission({ native, submitted: false });
    await assert.rejects(state.run(), /Codex 提交入口当前不可用/);
    assert.equal(state.unregister, native ? 1 : 0);
    assert.equal(state.operation.pending, false);
    assert.equal(!!state.context.sendNativeReceipt.pending, false);
    assert.deepEqual(state.events, []);
  });
}

test('window: uncertain submit retains pending receipt', async () => {
  const state = submission({ submitError: new Error('connection lost') });
  assert.equal(await state.run(), false);
  assert.equal(state.unregister, 0);
  assert.equal(state.operation.pending, true);
  assert.equal(state.context.sendNativeReceipt.pending, true);
  assert.equal(state.events[0].t, 'sent');
  assert.equal(state.events[0].pending, true);
});

test('window: submit without request receipt rethrows the original failure', async () => {
  const error = new Error('connection lost'), state = submission({ receipt: false, submitError: error });
  await assert.rejects(state.run(), actual => actual === error);
  assert.equal(state.calls.includes('register'), false);
  assert.deepEqual(state.events, []);
});

test('window: accepted queue clears the receipt and attachment pending state', async () => {
  const state = submission({ busy: true, when: 'queue' });
  await state.run();
  state.finish({ queued: true, thread: 'thread-1', queueId: 'queue-2' });
  assert.equal(state.context.sendNativeReceipt.pending, false);
  assert.equal(state.files[0].pending, false);
  assert.equal(state.events[0].queueId, 'queue-2');
});

test('window: result keeps the selection captured before the read', async () => {
  const state = submission({ afterRead: context => { context.scope = 'selection-2'; } });
  await state.run();
  state.finish(null, 'still unknown', true);
  assert.equal(state.events[0].sel, 'selection-1');
  assert.equal(state.events[0].pending, true);
});

test('window: explicit failure publishes sendFailed', async () => {
  const state = submission();
  await state.run();
  state.finish(null, 'not accepted', false);
  assert.equal(state.events[0].t, 'sendFailed');
  assert.equal(state.events[0].requestId, 'request-1');
});

test('window: cancellation before reading prevents registration and submit', async () => {
  const state = submission();
  state.controller.abort();
  await assert.rejects(state.run(), { name: 'AbortError' });
  assert.deepEqual(state.calls, []);
});

test('window: cancellation before serialized payload prevents registration and submit', async () => {
  const state = submission({ afterRead: (context, controller) => controller.abort() });
  await assert.rejects(state.run(), { name: 'AbortError' });
  assert.deepEqual(state.calls, ['read']);
  assert.equal(state.request, undefined);
});

test('page: read failure while waiting leaves the receipt pending', async () => {
  const state = submission({ native: false, waitError: new Error('read failed') });
  assert.equal(await state.run(), false);
  assert.equal(state.context.sendNativeReceipt.pending, true);
});

test('page: selection change cannot accept an old receipt', async () => {
  const state = submission({ native: false, afterWait: context => { context.scope = 'selection-2'; } });
  assert.equal(await state.run(), false);
  assert.equal(state.context.sendNativeReceipt.pending, true);
  assert.equal(state.context.sendNativeReceipt.messageId, undefined);
});

test('page: cancellation while waiting propagates', async () => {
  const state = submission({ native: false, waitError: new Error('read cancelled'),
    afterRead: (context, controller) => controller.abort() });
  await assert.rejects(state.run(), { name: 'AbortError' });
});

for (const native of [true, false]) test(`Codex receipt uses native serialized Markdown (${native ? 'window' : 'page'})`, async () => {
  const serialized = 'literal \\*\\*bold\\*\\* and C:\\tmp';
  const h = submission({ native, payload: 'literal **bold** and C:\\tmp', serialized });
  await h.run();
  if (native) { assert.equal(h.request.expected, serialized); assert.equal(h.request.queueExpected, 'literal **bold** and C:\\tmp'); }
  else { const call = h.calls.find(call => Array.isArray(call) && call[0] === 'wait'); assert.equal(call[2], serialized); assert.equal(call[3], 'literal **bold** and C:\\tmp'); }
});

for (const queued of [true, false]) test(`Codex queue edit confirms native ${queued ? 'queue' : 'already admitted message'}`, async () => {
  const calls = [], before = { thread: 'thread', messages: [{ id: 'old-user' }], queued: [{ id: 'old-queue' }] };
  const accepted = queued ? { queued: true, queueId: 'new-queue' } : { queued: false, messageId: 'new-user' };
  const cdp = { nativeWindow: { async composerCall(call) {
    assert.equal(call, `nativeSessionInfo('codex', "thread", 'draft')`); return 'literal \\*bold\\*';
  } }, async evaluate(expression) {
    calls.push(expression);
    if (expression.endsWith('.queueEditing() === "old-queue"')) return true;
    if (expression.endsWith('.codexSendState()')) return before;
    if (expression.endsWith('.codexSelectPrompt()')) return true;
    if (expression.endsWith('.submitCodexMessage("queue")')) return true;
    if (expression.includes('.waitCodexReceipt(')) {
      const args = JSON.parse('[' + expression.slice(expression.lastIndexOf('.waitCodexReceipt(') + 18, -1) + ']');
      assert.deepEqual(args[0], before); assert.equal(args[1], 'literal \\*bold\\*'); assert.equal(args[2], 'literal *bold*'); assert.equal(args[3], false); return accepted;
    }
    throw Error('unexpected queue edit read');
  }, async send(method, params) { assert.equal(method, 'Input.insertText'); assert.equal(params.text, 'literal *bold*'); } };
  const context = { cdp, codexFocusPrompt: async () => true, pollChat: async () => calls.push('poll') };
  assert.deepEqual(await adapter.editQueued.call(context, 'old-queue', 'literal *bold*'), accepted);
  assert(calls.includes('poll'));
});

test('Codex queue edit status reflects immediate execution without changing Devin take-out', () => {
  for (const [app, result, expected] of [['codex', { queued: false, messageId: 'sent' }, '已修改并已发送'],
    ['codex', { queued: true, queueId: 'queued' }, '已修改，仍在排队'], ['devin', undefined, '已修改，仍在排队']]) {
    const events = []; ROUTES.queue.after({ app, selectionKey: () => 'selection', emit: message => events.push(message) },
      { action: 'edit', id: 'old', text: 'new' }, result);
    assert.equal(events.at(-1).msg, expected);
  }
});

for (const queued of [true, false]) test(`page receipt distinguishes queued Markdown from serialized admission (queued=${queued})`, async () => {
  const text = '**bold** C:\\tmp', serialized = '\\*\\*bold\\*\\* C:\\tmp';
  const state = { thread: 'thread', messages: queued ? [] : [{ id: 'new-message', i: 'user-new', t: serialized }],
    queued: queued ? [{ id: 'new-queue', t: text }] : [] };
  const win = new EventTarget(), context = vm.createContext({ doc: { defaultView: win }, codexSendState: () => state, setTimeout, clearTimeout, queueMicrotask });
  const src = fs.readFileSync(new URL('../server/page/chat-extract.js', import.meta.url), 'utf8');
  vm.runInContext(src.slice(src.indexOf('  const waitCodexReceipt ='), src.indexOf('  const mergeCodexCapacity =')) + '\nglobalThis.waitReceipt = waitCodexReceipt;', context);
  const value = await context.waitReceipt({ thread: 'thread', messages: [], queued: [] }, serialized, text, false);
  assert.equal(value.queued, queued); assert.equal(queued ? value.queueId : value.messageId, queued ? 'new-queue' : 'user-new');
});

for (const scenario of ['queue', 'message', 'wrong-message-text', 'wrong-queue-text', 'old-queue', 'other-thread']) test(`shared native receipt retains strict identity with dual Markdown payloads: ${scenario}`, () => {
  const expected = '\\*bold\\*', queueExpected = '*bold*'; let result;
  const request = { thread: 'thread', expected, queueExpected, action: 'queue', before: new Set(['old-message']), beforeQueues: new Set(['old-queue']), beforeTurns: new Set(), finish: value => { result = value; } };
  const state = { thread: scenario === 'other-thread' ? 'other' : 'thread', messages: [], queued: [] };
  if (scenario.includes('message')) state.messages = [{ id: 'new-message', i: 'user-new', t: scenario === 'wrong-message-text' ? queueExpected : expected }];
  else state.queued = [{ id: scenario === 'old-queue' ? 'old-queue' : 'new-queue', t: scenario === 'wrong-queue-text' ? expected : queueExpected }];
  const source = { sends: new Map([['request', request]]), claimed: new Set() };
  NativeWindow.prototype.confirmSends.call(source, { receipt: state });
  if (scenario === 'queue' || scenario === 'message') { assert.equal(result.queued, scenario === 'queue'); assert.equal(source.sends.size, 0); }
  else { assert.equal(result, undefined); assert.equal(source.sends.size, 1); }
});

function pausedQueueDialog(remoteThread = 'thread-A') {
  const calls = [], nativeWindow = { __remoteAgentCodexSubmitRequests: new Map([['thread-A', 'send-A'], ['thread-B', 'send-B']]) };
  const props = { open: true, queuedMessageCount: 2,
    onSubmit() { calls.push('keep'); }, onClearQueue() { calls.push('clear'); },
    onOpenChange(value) { calls.push(['open', value]); } };
  const context = vm.createContext({ window: nativeWindow, remoteContext: { app: 'codex', threadId: remoteThread },
    codexVisibleThread: () => 'thread-A', codexFiberProps: () => [props], vis: () => true,
    doc: { querySelectorAll: () => [{}], defaultView: { Event: class { constructor(type) { this.type = type; } },
      dispatchEvent: event => calls.push(['event', event.type]) } } });
  const src = fs.readFileSync(new URL('../server/page/chat-extract.js', import.meta.url), 'utf8');
  vm.runInContext(src.slice(src.indexOf('  const codexSubmitError ='), src.indexOf('  const submitCodexMessage ='))
    + ';globalThis.requests=codexQueueConfirmRequests;', context);
  return { calls, nativeWindow, props, context, rows: () => context.requests() };
}

for (const n of [0, 1, 2]) test(`paused native queue confirmation preserves the explicit user decision: ${n}`, async () => {
  const h = pausedQueueDialog(), [row] = h.rows();
  assert.equal(row.buttons.length, 3); assert(row.id.includes('send-A'));
  await row.buttons[n].action();
  assert.equal(h.nativeWindow.__remoteAgentCodexSubmitRequests.has('thread-A'), false);
  assert.equal(h.nativeWindow.__remoteAgentCodexSubmitRequests.get('thread-B'), 'send-B');
  if (n === 2) {
    assert.deepEqual(h.calls, [['event', 'remote-agent-submit-error'], ['open', false]]);
    assert.equal(h.nativeWindow.__remoteAgentSubmitErrors[0].requestId, 'send-A');
    assert.match(h.nativeWindow.__remoteAgentSubmitErrors[0].message, /已取消发送/);
  } else { assert.deepEqual(h.calls, [n === 0 ? 'keep' : 'clear']); assert.equal(h.nativeWindow.__remoteAgentSubmitErrors, undefined); }
});

test('paused queue confirmation belongs only to the visible selected thread', () => {
  const h = pausedQueueDialog('thread-B'); assert.equal(h.rows().length, 0); assert.deepEqual(h.calls, []);
  assert.equal(h.nativeWindow.__remoteAgentCodexSubmitRequests.get('thread-A'), 'send-A');
});

test('native queue confirmation action rejects a stale request instead of acting on a new dialog', async () => {
  const h = pausedQueueDialog(), src = fs.readFileSync(new URL('../server/page/codex.js', import.meta.url), 'utf8');
  vm.runInContext(src.slice(src.indexOf('  const codexRequestAction ='), src.indexOf('  const codexRequestField ='))
    + ';globalThis.act=codexRequestAction;', h.context);
  const id = h.rows()[0].id;
  h.nativeWindow.__remoteAgentCodexSubmitRequests.set('thread-A', 'new-send');
  await assert.rejects(h.context.act(id, 0), /这条队列确认已不在所选会话中/);
  assert.deepEqual(h.calls, []);
});

test('native accepted and explicitly not-sent callbacks settle only their own submit record', async () => {
  let options;
  const h = submitLifecycle(value => { options = value; });
  await h.page.submitCodexMessage('', true, 'send-1'); await h.page.codexViewState(true);
  assert.equal(h.nativeWindow.__remoteAgentCodexSubmitRequests.get('thread'), 'send-1');
  options.onSubmitted(); assert.equal(h.nativeWindow.__remoteAgentCodexSubmitRequests.size, 0);
  await h.page.submitCodexMessage('', true, 'send-2'); await h.page.codexViewState(true);
  options.onNotSent(); assert.equal(h.nativeWindow.__remoteAgentSubmitErrors[0].requestId, 'send-2');
  assert.equal(h.draft.value, 'draft');
});

test('normal Codex read includes the paused queue confirmation once rather than a generic duplicate dialog', () => {
  const dialog = {}, row = { id: 'queue-confirm:thread', dialog, text: 'paused queue', buttons: [{ label: 'keep' }], fields: [] };
  const document = { querySelectorAll: selector => selector === '[role=dialog]' ? [dialog] : [] };
  const context = vm.createContext({ remoteContext: null, activeThread: () => 'thread', codexQueueConfirmRequests: () => [row],
    doc: document, document, vis: () => true });
  const source = fs.readFileSync(new URL('../server/page/codex.js', import.meta.url), 'utf8');
  vm.runInContext(source.slice(source.indexOf('  const codexRequests ='), source.indexOf('  const codexRequestData =')) + ';globalThis.read=codexRequests;', context);
  const rows = context.read(); assert.equal(rows.length, 1); assert.equal(rows[0].id, row.id);
});
