import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { Cdp, cdpRead } from '../server/cdp.mjs';
import { NativeWindow } from '../server/native-windows.mjs';
import { AgentContext } from '../server/agent/context.mjs';
import { methods as projects } from '../server/agent/projects.mjs';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const fragment = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const context = (threadId, host = '') => ({ app: 'codex', host, threadId, cwd: '/' + threadId, roots: [{ root: '/' + threadId, host }] });

test('CDP evaluation keeps default calls unchanged and passes an explicit native realm', async () => {
  const cdp = new Cdp('ws://fixture.invalid'), calls = [];
  cdp.send = async (...args) => { calls.push(args); return { result: { value: 'native' } }; };
  assert.equal(await cdp.evaluate('1'), 'native');
  await cdp.evaluate('2', { contextId: 17, timeout: 100 });
  assert.deepEqual(calls[0][1], { expression: '1', returnByValue: true, awaitPromise: true });
  assert.equal(calls[1][1].contextId, 17); assert.equal(calls[1][2], 100);
});

test('Codex iframe lookup uses the frame owner, caches it and separates window realms', async () => {
  for (const id of [17, 29]) {
    const source = new NativeWindow('ws://fixture-' + id), calls = [];
    source.connect = async () => {};
    source.contexts.set(5, { id: 5, auxData: { isDefault: true, frameId: 'other' } });
    source.contexts.set(id, { id, auxData: { isDefault: true, frameId: 'native' } });
    source.cdp.send = async method => {
      calls.push(method);
      return method === 'DOM.getDocument' ? { root: { nodeId: 1 } }
        : method === 'DOM.querySelector' ? { nodeId: 2 } : { node: { frameId: 'native' } };
    };
    source.cdp.evaluate = async (_expression, options) => options.contextId;
    assert.equal(await source.composerCall('composerDraft()', context('A')), id);
    assert.equal(await source.composerCall('composerDraft()', context('A')), id);
    assert.equal(calls.filter(method => method === 'DOM.getDocument').length, 1);
    source.contexts.delete(id); source.contexts.set(id + 1, { id: id + 1, auxData: { isDefault: true, frameId: 'native' } });
    assert.equal(await source.composerCall('composerDraft()', context('A')), id + 1);
  }
});

test('conversation reads share only the same host/thread cache and keep desktop facts separate', async () => {
  const source = new NativeWindow('ws://fixture.invalid'), a = context('A'), b = context('B');
  source.connect = async () => {};
  source.composerCall = async () => null;
  source.snapshot = { chat: { thread: 'desktop-B' } };
  const pending = [], calls = [];
  source.cdp.evaluate = expression => {
    const native = JSON.parse(/\}\)\((\{[^\n]*\})\)\.extract/.exec(expression)[1]);
    calls.push(native.threadId);
    return new Promise(resolve => pending.push(() => resolve({ thread: native.threadId, items: [], _nativeState: { thread: native.threadId } })));
  };
  for (const value of [a, b]) source.conversationView(value).listeners.add(() => {});
  const first = source.read(false, a), second = source.read(false, a), other = source.read(false, b);
  await Promise.resolve();
  assert.deepEqual(calls, ['A', 'B']);
  pending.reverse().forEach(resolve => resolve());
  assert.equal((await first).chat.thread, 'A'); assert.equal((await second).chat.thread, 'A');
  assert.equal((await other).chat.thread, 'B'); assert.equal(source.snapshot.chat.thread, 'desktop-B');
  assert.equal((await source.read(false, a)).chat.thread, 'A'); assert.equal(calls.length, 2);
  assert.notEqual(source.conversationView(a), source.conversationView(context('A', 'remote')));
});

test('late native project confirmation cannot overwrite a newer phone selection', async () => {
  let finish;
  const session = Object.assign(Object.create(AgentContext.prototype), { app: 'codex', threadId: 'A', sel: 1,
    cdp: { evaluate: () => new Promise(resolve => { finish = resolve; }) } });
  const reading = session.confirmConversation();
  session.threadId = 'B'; session.sel = 2; session.conversation = context('B');
  finish(context('A')); await reading;
  assert.equal(session.nativeContext().threadId, 'B');
  session.fusionBinding = {}; assert.equal(session.nativeContext(), null);
});

test('Editor and new terminal use the confirmed conversation roots rather than the desktop project', async () => {
  const session = { nativeContext: () => context('A'), adapter: { currentRoots: () => [{ root: '/B' }] } };
  assert.deepEqual(await projects.currentRoots.call(session), [{ root: '/A', host: '' }]);
});

test('phone cache and drafts follow conversation identity across carriers while hosts stay separate', () => {
  const source = read('app/js/core.js'), c = vm.createContext({ currentComputer: () => ({ id: 'computer' }), viewSel: '' });
  vm.runInContext(fragment(source, 'const conversationContexts =', '// Only migrated agents') + '\nthis.key = conversationKey; this.contexts = conversationContexts;', c);
  assert.equal(c.key('codex|window-1|A'), c.key('codex|window-2|A'));
  c.contexts.set('computer|codex|window-2|A', context('A', 'remote'));
  assert.notEqual(c.key('codex|window-1|A'), c.key('codex|window-2|A'));
  assert.notEqual(c.key('codex|window-1|'), c.key('codex|window-2|'));
});

test('Codex async Question uses the active native group, including no-option input and answered history', () => {
  const values = new Map(), sources = new Map(), id = '["request_user_input_async","call",0]';
  const nativeKey = { entityKey: 'turn', hostId: 'local', itemId: id, threadId: 'A' };
  const group = new Map([['A', { selectedQuestionKey: nativeKey, questionIds: [id] }]]);
  const state = { question: { id, title: '请输入文字', options: [] }, status: 'completed', draft: '', lastSubmission: null, isSkipped: false };
  for (const [key, value] of [[JSON.stringify('local'), group], [JSON.stringify(nativeKey), state]]) {
    const binding = { value: {} }; values.set(key, binding); sources.set(binding, { key: binding, get: () => value });
  }
  const c = vm.createContext({ remoteContext: context('A'), doc: { defaultView: { Map } },
    codexHistoryScopes: () => [{ familyBindings: new Map([['native', values]]) }], codexHistoryBinding: (_scope, binding) => sources.get(binding) });
  const source = read('server/page/codex.js');
  vm.runInContext(fragment(source, '  const codexAsyncQuestionState =', '  const codexNativeRequests =') + '\nthis.rows = codexAsyncQuestionRows;', c);
  assert.equal(c.rows()[0].fields[0].type, 'text'); assert.equal(c.rows()[0].buttons.at(-1).disabled, true);
  state.draft = '回答'; assert.equal(c.rows()[0].buttons.at(-1).disabled, false);
  state.lastSubmission = '回答'; group.delete('A'); assert.equal(c.rows().length, 0);
});

test('Codex state remains readable when a Question replaces the main composer', () => {
  const anchor = { kind: 'Question' }, scopes = [{ familyBindings: new Map() }];
  const c = vm.createContext({ vis: () => true, doc: { querySelectorAll: selector => selector.includes('[data-request-input-dismiss]') ? [anchor] : [] },
    codexFiberProps: element => { assert.equal(element, anchor); return [{ value: new Map([['native', scopes[0]]]) }]; } });
  vm.runInContext(fragment(read('server/page/composer.js'), '  const codexRootProps =', '  const codexQueryClient =')
    + fragment(read('server/page/chat-extract.js'), '  const codexHistoryScopes =', '  const codexHistoryBinding =') + '\nthis.scopes = codexHistoryScopes;', c);
  assert.equal(c.scopes().size, 1);
});

test('native draft writes preserve rich metadata and acceptance clears only the submitted draft', async () => {
  let draft = { prompt: 'old', imageAttachments: ['image'], custom: 'keep' };
  const composer = { f: 'draft', M: 'text', gt: (_scope, next) => { draft = next; } };
  const scope = { get: ref => ref === 'draft' ? draft : draft.prompt };
  const c = vm.createContext({ codexComposerScope: async () => ({ scope, composer }) });
  const source = read('server/page/composer.js');
  vm.runInContext(fragment(source, '  const codexConversationDraft =', '  const pickComposer =') + '\nthis.draft = codexConversationDraft;', c);
  assert.equal(await c.draft('A', 'sent'), 'sent'); assert.equal(draft.custom, 'keep');
  assert.deepEqual(draft.imageAttachments, ['image']);
  await c.draft('A', 'new draft'); await c.draft('A', '', 'sent'); assert.equal(draft.prompt, 'new draft');
  await c.draft('A', '', 'new draft'); assert.equal(draft.prompt, '');
});

test('background capacity Retry retains the native turn while visible disabled controls stay authoritative', () => {
  const c = vm.createContext({ remoteContext: context('A'), codexThread: () => 'A', codexForkProps: () => null,
    codexFiberProps: () => [], doc: { querySelectorAll: () => [] }, CAPACITY_ERROR: /at capacity/i, RETRY_LABEL: /^Retry$/ });
  const source = read('server/page/chat-extract.js');
  vm.runInContext(fragment(source, '  const codexTurnItems =', '  const codexReadPage =')
    + fragment(source, '  const mergeCodexCapacity =', '  const extract =') + '\nthis.rows=codexTurnItems;this.merge=mergeCodexCapacity;', c);
  const entry = { turnId: 'turn-A', turnKey: 'key-A', turnNumber: 1, isLatestTurn: true,
    turn: { status: 'complete', items: [{ type: 'system-error', id: 'error', content: 'The model is at capacity.' }] } };
  const rows = c.rows(null, entry);
  assert.equal(rows[0].b[0], 'Retry'); assert.equal(rows[0].actions[0], 'retry:["A","turn-A"]');
  assert.equal(c.rows(null, { ...entry, isLatestTurn: false })[0].b, undefined);
  c.merge(rows, { entries: [entry] }, { i: 'A:capacity', capacity: true, _turnKey: entry.turnKey });
  assert.equal(rows[0].b, undefined);
});

test('automatic Retry targets one native turn once per error occurrence and keeps its count across UI switches', async () => {
  const calls = [], clicks = [], notices = [];
  class Link {
    constructor(wsUrl) { this.wsUrl = wsUrl; }
    on() {} async connect() {} async send() {} close() {}
    async evaluate(expression) { calls.push(expression); return expression.includes('.nativeSessionAction(') ? { x: 1, y: 2 } : true; }
  }
  const c = vm.createContext({ Cdp: Link, NativeCdp: Link, cdpRead, AbortController, helpersCall: (call, context) => JSON.stringify(context) + '.' + call,
    PAGE_SRC: '{}', publishDesktopState: (...args) => notices.push(args),
    AgentContext: { prototype: { tapCss: async (...args) => clicks.push(args) } } });
  const source = read('server/native-windows.mjs');
  vm.runInContext(fragment(source, 'export class NativeWindow', 'export function startNativeWindows').replace('export class', 'class') + '\nthis.Source=NativeWindow;', c);
  const window = new c.Source('ws://owned-A'); window.win = { app: 'codex' }; window.run = action => action(); window.read = async () => {};
  window.retrySettings.set('device', { thread: 'A', count: 2 });
  const error = { state: { host: '' }, chat: { thread: 'A', items: [{ i: 'A:capacity:turn-A', capacity: true,
    retryTurn: 'turn-A', b: ['Retry'], actions: ['retry:["A","turn-A"]'] }] } };
  window.retryCapacity(error); await window.retrying; assert.equal(clicks.length, 1);
  window.retryCapacity(error); assert.equal(clicks.length, 1);
  window.retryCapacity({ chat: { items: [] } }); window.retryCapacity(error); await window.retrying; assert.equal(clicks.length, 2);
  window.retryCapacity({ chat: { items: [] } }); window.retryCapacity(error); assert.equal(clicks.length, 2);
  assert.equal(notices.length, 2); assert(calls.some(call => call.includes("openCodexThread(\"A\")")));
  assert(calls.some(call => call.includes("'capacityTarget', \"turn-A\"")));
});

test('background Cursor model list uses its native visibility and selected conversation', () => {
  const picker = { models: [{ name: 'default', defaultOn: true, clientDisplayName: 'Auto' },
    { name: 'A-model', defaultOn: true, clientDisplayName: 'Model A' }, { name: 'hidden', defaultOn: false }],
    initialSelections: [{ modelId: 'B-model' }], selections: [{ modelId: 'A-model' }] };
  const c = vm.createContext({ remoteContext: { app: 'cursor' }, cursorPickerProps: () => picker });
  vm.runInContext(fragment(read('server/page/menus.js'), '  const modelItemsFast =', '  const pickDevinModel =') + '\nthis.items=modelItemsFast;', c);
  const items = c.items(); assert.equal(items.length, 2); assert.equal(items.find(item => item.checked).id, 'A-model');
});

test('Devin Fast awaits the native setting result and propagates its failure', async () => {
  let reject, settled = false;
  const pending = new Promise((_resolve, failure) => { reject = failure; });
  const c = vm.createContext({ remoteContext: { app: 'devin' }, fastProps: () => null,
    devinVariants: () => [{ order: 1, config: { modelUid: 'native-fast' } }],
    devinPickerProps: () => ({ onModelSelect: () => pending }) });
  vm.runInContext(fragment(read('server/page/menus.js'), '  const pickFast =', '  const fastTarget =') + '\nthis.pick=pickFast;', c);
  const selecting = c.pick(true); selecting.then(() => { settled = true; }, () => {});
  await Promise.resolve(); assert.equal(settled, false);
  reject(new Error('native setting rejected')); await assert.rejects(selecting, /native setting rejected/);
});
