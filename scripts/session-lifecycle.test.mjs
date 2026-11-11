import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { NativeWindow } from '../server/native-windows.mjs';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const fragment = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));

function pageContext(extra = {}) {
  const context = vm.createContext({ remoteContext: null, window: {}, doc: { defaultView: {} }, ...extra });
  vm.runInContext(read('server/page/session-actions.js') + '\nthis.info = nativeSessionInfo; this.action = nativeSessionAction;', context);
  return context;
}

for (const result of ['archive', 'delete', 'clear']) {
  test(`Cursor removal uses the persisted native outcome: ${result}`, async () => {
    const row = { composerId: 'target', name: 'target' }, other = { composerId: 'other' };
    let headers = [row, other], loaded = result === 'clear' ? [row] : [row, other], empty = false;
    const data = { get allComposersData() { return { allComposers: loaded }; },
      async whenInitialComposerDataLoaded() {},
      _storageService: { collectionQuery: async () => headers.map(row => JSON.stringify(row)) },
      getComposerDataIfLoaded: () => ({ fullConversationHeadersOnly: empty ? [] : ['message'] }),
    };
    const composer = {
      async deleteComposer(id) {
        assert.equal(id, 'target'); loaded = [other];
        headers = result === 'archive' ? [{ ...row, isArchived: true }, other] : [other];
      },
      async resetComposer(id) { assert.equal(id, 'target'); empty = true; headers = [row]; },
    };
    const context = pageContext({ window: { __remoteAgentCursorServices: { data, composer } } });
    const actual = await context.action('cursor', 'target', 'delete');
    assert.equal(actual.confirmed, true); assert.equal(actual.action, result);
  });
}

for (const outcome of ['archive', 'clear', 'delete']) {
  test(`server records ${outcome} without turning other native outcomes into deletion`, async () => {
    const library = { favorite: true }, changes = [], messages = [];
    const context = vm.createContext({ remoteContext: null,
      sessionId: (_app, id) => id, helpersCall: call => call,
      removeLibrarySession: () => { library.favorite = false; library.deleted = true; },
      publishSessionChange: (_app, _id, change) => { changes.push(change.action); if (change.action === 'archive') library.archived = true; },
    });
    const methods = vm.runInContext(read('server/agent/session-actions.mjs').replace(/^import .*;\n/gm, '').replace('export const methods', 'const methods') + '\nmethods;', context);
    const session = { app: 'cursor', emit: message => messages.push(message),
      withManagedSession: (_id, callback) => callback({ evaluate: async call => call.startsWith('nativeSessionInfo(')
        ? { actions: ['delete'], running: false } : { confirmed: true, action: outcome } }, 'cursor', 'target') };
    await methods.manageSession.call(session, 'target', 'remove');
    assert.deepEqual(changes, [outcome]);
    assert.equal(library.favorite, outcome !== 'delete');
    assert.equal(!!library.deleted, outcome === 'delete');
    assert.equal(messages.at(-1).msg, { archive: '已归档会话', clear: '已清空会话', delete: '已删除会话' }[outcome]);
  });
}

test('compact Devin model buttons expose the same picker as text buttons', () => {
  const model = { textContent: '', getAttribute: name => name === 'aria-label' ? 'SWE-2 High' : '', closest: () => null };
  const unrelated = { ...model, textContent: 'Local', getAttribute: () => '' };
  const context = vm.createContext({ remoteContext: null, doc: { querySelectorAll: () => [unrelated, model] }, vis: () => true, revealDevinComposer() {} });
  const source = read('server/page/menus.js');
  vm.runInContext(fragment(source, '  const DEVIN_MODEL', '  const devinModelMenu') + '\nthis.button = devinModelButton;', context);
  assert.equal(context.button(false), model);
  model.textContent = 'SWE-2 High'; model.getAttribute = () => '';
  assert.equal(context.button(false), model);
});

test('Codex manager lookup on the empty home page follows the requested host', () => {
  const local = { hostId: 'local', getConversation: id => id === 'local-thread', loadOlderConversationTurnsPage() {} };
  const remote = { hostId: 'remote', getConversation: id => id === 'remote-thread', loadOlderConversationTurnsPage() {} };
  const scope = { familyBindings: new Map([['managers', new Map([['a', local], ['b', remote]])]]) };
  const context = vm.createContext({ remoteContext: null, doc: { defaultView: {} }, codexHistoryBinding: (_scope, value) => ({ get: () => value }) });
  const source = read('server/page/chat-extract.js');
  vm.runInContext(fragment(source, '  const codexConversationManager', '  const codexHistoryState') + '\nthis.manager = codexConversationManager;', context);
  assert.equal(context.manager(null, [scope], 'local'), local);
  assert.equal(context.manager('remote-thread', [scope]), remote);
  assert.equal(context.manager(null, [scope], 'local'), local);
  local.disposed = true; assert.equal(context.manager(null, [scope], 'local'), null);
});

test('Codex opens the identified recent-chat button once despite the archive toast', () => {
  let open = false, clicks = 0;
  const button = {};
  const context = vm.createContext({ remoteContext: null, codexButton: () => button, codexPoint: () => ({ x: 1, y: 2 }), vis: () => true,
    codexFiberProps: () => [{ triggerRef: { current: { contains: el => el === button } }, contentId: 'recent-menu', get open() { return open; }, onOpenChange(value) { clicks++; open = value; } }],
    doc: { querySelectorAll: () => open ? [{ innerText: 'Search recent chats' }] : [] } });
  const source = read('server/page/codex.js');
  vm.runInContext(fragment(source, '  const codexRecentState', '  const codexRecentMenu')
    + fragment(source, '  const codexRecentPoint', '  const codexNewPoint') + '\nthis.recent = codexRecentPoint;', context);
  context.recent(); assert.equal(clicks, 0);
  context.recent(true); context.recent(true); assert.equal(clicks, 1);
  context.recent(false); assert.equal(open, false);
  context.recent(true); assert.equal(clicks, 3);
});

test('Codex preview and catalog use the host connection without selecting a conversation', async () => {
  const requests = [];
  const manager = { hostId: 'local', getConversation: () => null, requestClient: {
    async sendRequest(method, args) {
      requests.push({ method, args });
      const thread = { id: 'background', name: 'task', cwd: '/project', updatedAt: 1,
        turns: [{ id: 'turn', items: [{ id: 'answer', type: 'agentMessage', text: 'BACKGROUND_OK' }] }] };
      return method === 'thread/list' ? { data: [thread], nextCursor: null } : { thread };
    },
  } };
  const context = pageContext({
    codexThread: () => { throw Error('Reading another session must not depend on the selected thread'); },
    codexHistoryScopes: () => [], codexChatRows: () => [{ id: 'background', host: '' }],
    codexConversationManager: (_thread, _scopes, host) => { assert.equal(host, 'local'); return manager; },
    codexStoredTurn: () => null, codexTurnItems: () => [], codexUserText: () => '',
  });
  const preview = await context.info('codex', 'background', 'preview');
  assert.equal(preview.text, 'BACKGROUND_OK');
  assert.equal(requests[0].args.threadId, 'background');
  const catalog = await context.info('codex', [], true);
  assert.equal(catalog.ready, true); assert.equal(catalog.rows[0].id, 'background');
  assert.deepEqual(requests.map(r => r.method), ['thread/read', 'thread/list']);
});

function nativeRunContext(extra) {
  const context = vm.createContext({ remoteContext: null, ...extra }), source = read('server/page/agents.js');
  vm.runInContext(fragment(source, '  const agentRun =', '  const agentStates =')
    + '\nthis.run = (app, thread, scopes=[]) => agentRun(app, thread, scopes, app === "codex" ? codexConversationManager(thread, scopes) : null);', context);
  return context;
}

function nativeWaitingState(app = 'codex') {
  const state = { thread: 'thread-A', requests: [], labels: [], busy: false, panel: true, questions: null };
  const item = { innerText: '任务已正常完成', matches: () => false, querySelector: () => null, querySelectorAll: () => [],
    hasAttribute: key => key === 'data-turn-key', getAttribute: () => 'native-turn' };
  const panel = {};
  const context = vm.createContext({ remoteContext: null, doc: { querySelectorAll: () => [] }, vis: () => true,
    agentList: () => [{ id: state.thread, current: true, title: '会话' }], activeThread: () => state.thread,
    codexButton: () => null, codexWorkspaceRoots: () => [], hasComposer: () => true,
    findPanel: () => state.panel ? panel : null, isBusy: () => state.busy, topItems: () => [item],
    buttonsIn: element => element === item ? state.labels.map(label => ({ label })) : [],
    itemKey: () => 'native-turn', summary: () => 'Edited 22 files+1,277-24View changes', inItem: () => true, inQn: () => false,
    devinLog: () => app === 'devin' ? {} : null, questions: () => state.questions, devinQuestions: () => state.questions,
    devinSession: () => null, devinTaskState: () => null, changedCount: () => 0, fileBarButtons: () => [], agentChanges: () => null,
    codexThread: () => app === 'codex' ? state.thread : '', codexRequestData: () => state.requests,
    codexLatestEntry: () => ({ conversationId: state.thread, turnKey: 'native-turn', turn: { items: [
      { type: 'assistant-message', completed: true, content: '任务已正常完成' },
    ] } }),
  });
  const source = read('server/page/agents.js');
  vm.runInContext(fragment(source, '  const WAIT =', '  // Per-file totals')
    + fragment(source, '  const agentState =', '  // Cursor Agents window:') + '\nthis.read = agentState;', context);
  return { state, read: () => context.read() };
}

test('Codex finished changes and ordinary action buttons are not pending native requests', () => {
  const h = nativeWaitingState();
  for (const label of ['Accept all changes', 'Run', 'Continue']) {
    h.state.labels = [label];
    const value = h.read();
    assert.equal(value.waiting, null); assert.equal(value.waitingText, '');
    assert.equal(value.busy, false); assert.equal(value.last, '任务已正常完成');
  }
});

for (const id of ['async:question-1', 'approval:command-1']) test(`Codex ${id} is waiting even outside the message list or before an answer enables Send`, () => {
  const h = nativeWaitingState();
  h.state.requests = [{ id, text: '请选择处理方式', buttons: [{ label: 'Skip' }, { label: 'Send', disabled: true }], fields: [{ value: '' }] }];
  h.state.questions = { list: [{ text: 'unrelated legacy question' }] };
  for (const panel of [true, false]) {
    h.state.panel = panel;
    const value = h.read();
    assert(value.waiting.includes(id)); assert.equal(value.waitingText, '请选择处理方式');
    assert(value.waiting.includes(h.state.thread));
  }
});

test('Codex waiting follows native request and thread identity and clears when its card disappears', () => {
  const h = nativeWaitingState(), request = { id: 'async:first', text: '相同问题', fields: [{ value: '' }] };
  h.state.requests = [request]; const first = h.read().waiting;
  request.fields[0].value = 'answer draft'; assert.equal(h.read().waiting, first);
  h.state.requests = [{ ...request, id: 'async:next' }]; assert.notEqual(h.read().waiting, first);
  h.state.requests = []; assert.equal(h.read().waiting, null); assert.equal(h.read().waitingText, '');
  h.state.thread = 'thread-B'; assert.equal(h.read().waiting, null);
  h.state.requests = [request]; const second = h.read().waiting; assert.notEqual(second, first);
  h.state.thread = 'thread-A'; assert.equal(h.read().waiting, first);
});

for (const app of ['cursor', 'devin']) test(`${app} retains its existing button and Question waiting behavior`, () => {
  const h = nativeWaitingState(app); h.state.labels = ['Allow'];
  assert(h.read().waiting); assert.equal(h.read().waitingText, 'Edited 22 files+1,277-24View changes');
  h.state.questions = { list: [{ text: '原生问题', multi: false, options: [{ label: '第一项' }] }] };
  const value = h.read(); assert(value.waiting.startsWith('q:')); assert.equal(value.waitingText, '原生问题');
  if (app === 'devin') assert.equal(value.actions[0].label, '第一项');
});

function codexQuestionReader(questions = [{ id: 'choice', question: '请选择处理方式', isOther: true, options: [{ label: '继续' }, { label: '停止' }] }]) {
  const state = { thread: 'thread-A', mounted: true, drafts: [], submitted: [], controls: [] };
  const skip = { innerText: 'Skip', closest: () => null };
  const owner = { conversationId: state.thread, pendingRequest: { type: 'userInput', item: { type: 'userInput', requestId: 0, turnId: 'turn-A', questions, completed: false } } };
  const indexHook = { memoizedState: 0, queue: { dispatch(value) { indexHook.memoizedState = value; } } };
  const answersHook = { memoizedState: questions.map(question => ({ selectedOptionId: question.options[0]?.label ?? null, freeformText: null })),
    queue: { dispatch(value) { answersHook.memoizedState = value; } } };
  indexHook.next = answersHook;
  const form = { key: 'native-form', memoizedState: indexHook, memoizedProps: {
    questionAndOptions: questions.map(question => ({ ...question, options: question.options.map(option => ({ id: option.label, value: option.label })) })),
    onDraftChange(value) { state.drafts.push(value); },
    onSubmit(value) { state.submitted.push(value); state.mounted = false; },
  } };
  const root = { stateNode: {} }, parent = { memoizedProps: owner, return: root, child: form }, host = { stateNode: skip, return: form };
  root.stateNode.current = root; root.child = parent; form.return = parent; form.child = host; skip.__reactFiberFixture = host;
  const doc = { querySelectorAll(selector) {
    if (selector === '[data-request-input-dismiss]') return state.mounted ? [skip] : [];
    if (selector === 'button' || selector.startsWith('button, input')) return [...(state.mounted ? [skip] : []), ...state.controls];
    return [];
  } };
  const context = vm.createContext({ remoteContext: null, doc, document: doc, activeThread: () => state.thread, vis: () => true,
    codexFiberProps: el => el.props || [], codexPoint: () => ({ x: 1, y: 2 }), setTimeout });
  vm.runInContext(fragment(read('server/page/codex.js'), '  const codexAsyncRequestFiber =', '  const codexImage =')
    + '\nthis.data=codexRequestData;this.field=codexRequestField;this.action=codexRequestAction;', context);
  return { state, owner, form, root, host, skip, answersHook, ...context };
}

test('current Codex userInput request 0 is one native card, with stable conversation and turn ownership', () => {
  const h = codexQuestionReader(), request = h.data()[0];
  assert.equal(h.data().length, 1); assert(request.id.startsWith('async:'));
  assert.equal(request.text, '请选择处理方式'); assert.equal(request.fields[0].value, '继续');
  assert.equal(request.buttons[0].selected, true); assert.equal(request.buttons.at(-1).label, 'Send');
  h.field(request.id, 0, '自定义回答');
  assert.equal(h.data()[0].id, request.id); assert.equal(h.data()[0].fields[0].value, '自定义回答');
  assert.equal(h.answersHook.memoizedState[0].selectedOptionId, null);
  h.skip.parentElement = { querySelectorAll() { throw Error('a native card must not also become a generic card'); } };
  h.state.thread = 'thread-B'; assert.equal(h.data().length, 0);
  h.state.thread = 'thread-A'; assert.equal(h.data()[0].id, request.id);
  h.owner.pendingRequest.item.turnId = 'turn-B'; assert.notEqual(h.data()[0].id, request.id);
  h.owner.pendingRequest.item.completed = true; assert.equal(h.data().length, 0);
});

test('Codex native answer state preserves all questions and submits the answers array once', async () => {
  const h = codexQuestionReader([
    { id: 'first', question: '第一题', isOther: true, options: [{ label: '继续' }, { label: '停止' }] },
    { id: 'second', question: '第二题', isSecret: true, options: [] },
  ]);
  const first = h.data()[0]; assert.equal(first.buttons.at(-1).label, 'Next');
  await h.action(first.id, 1, [], true);
  const second = h.data()[0]; assert.notEqual(second.id, first.id); assert.equal(second.text, '第二题');
  assert.equal(second.fields[0].type, 'password'); assert.equal(second.buttons.at(-1).disabled, true);
  await h.action(second.id, 1, [{ n: 0, value: '补充说明' }]);
  assert.equal(h.state.submitted.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.submitted[0])), [
    { selectedOptionId: '停止', freeformText: null }, { selectedOptionId: null, freeformText: '补充说明' },
  ]);
  assert.equal(h.state.drafts.at(-1).questionIndex, 1); assert.equal(h.data().length, 0);
});

test('Codex native options without an other answer stay a select field', () => {
  const h = codexQuestionReader([{ id: 'only', question: '只能选项', options: [{ label: 'A' }, { label: 'B' }] }]);
  const request = h.data()[0]; assert.equal(request.fields[0].type, 'select');
  assert.deepEqual(Array.from(request.fields[0].options, option => option.value), ['A', 'B']);
  h.field(request.id, 0, 'B'); assert.equal(h.data()[0].buttons[1].selected, true);
});

test('Codex questions follow the mounted tree even when a reused control retains a stale return pointer', () => {
  const h = codexQuestionReader();
  const stale = { memoizedProps: { ...h.form.memoizedProps, questionAndOptions: [{ question: '旧题', options: [] }] }, return: h.root };
  h.host.return = stale;
  assert.equal(h.data()[0].text, '请选择处理方式');
  h.root.child = null; assert.equal(h.data().length, 0);
});

test('Codex existing questions props and execution approvals retain their native controls, including id 0', async () => {
  const h = codexQuestionReader();
  const props = { questionIndex: 0, questions: [{ id: 'existing', question: '已有问题', options: ['同意'], draft: '' }],
    onDraftChange(value) { props.questions[0].draft = value; }, onSubmit() { h.state.mounted = false; } };
  h.form.memoizedProps = props;
  const request = h.data()[0]; assert.equal(h.data().length, 1); assert.equal(request.id, 'async:existing');
  await h.action(request.id, 0, [], true); assert.equal(h.data().length, 0);
  const approval = { tagName: 'BUTTON', innerText: '允许', getAttribute: () => null, closest: selector => selector === '[data-codex-approval-surface]' ? {} : null,
    props: [{ item: { type: 'exec', approvalRequestId: 0, cmd: ['pwd'] }, onApprove() {} }] };
  h.state.controls = [approval];
  assert.equal(h.data()[0].id, 'approval:0'); assert(h.data()[0].text.includes('pwd'));
  approval.props = [{ request: { item: { requestId: 0, title: '原生请求' } } }];
  assert.equal(h.data()[0].id, '0'); assert.equal(h.data()[0].buttons[0].label, '允许');
});

for (const options of [[], ['继续']]) test(`Codex async Question with ${options.length} options keeps its outer request when the inner renderer is shared with userInput`, async () => {
  const h = codexQuestionReader();
  delete h.owner.pendingRequest;
  const question = { id: 'async-tool-question', question: '请补充说明', options, draft: '' };
  const props = { questionIndex: 0, questions: [question], onDraftChange(value) { question.draft = value; },
    onSubmit() { h.state.submitted.push(question.draft); h.state.mounted = false; } };
  h.form.memoizedProps = props;
  const renderer = { memoizedProps: { questionAndOptions: [{ question: { type: 'native-heading' }, options: [] }],
    onDraftChange() { assert.fail('the shared renderer does not own this request'); },
    onSubmit() { assert.fail('the answer belongs to the outer async request'); } }, return: h.form, child: h.host };
  h.form.child = renderer; h.host.return = renderer;
  const requests = h.data(); assert.equal(requests.length, 1);
  const request = requests[0]; assert.equal(request.id, 'async:async-tool-question'); assert.equal(request.text, question.question);
  assert.equal(request.fields.length, 1); assert.equal(request.fields[0].type, 'text');
  assert.equal(request.buttons.at(-1).disabled, true);
  if (options.length) { await h.action(request.id, 0); assert.equal(question.draft, '继续'); }
  await h.action(request.id, request.buttons.length - 1, [{ n: 0, value: '异步问题的回答' }]);
  assert.deepEqual(h.state.submitted, ['异步问题的回答']); assert.equal(h.data().length, 0);
});

test('Codex run status follows a loaded background native turn rather than current DOM controls', () => {
  const turn = { turnId: 'native-turn', status: 'inProgress', turnStartedAtMs: 100 }, conversation = { turns: [turn] };
  const context = nativeRunContext({ codexConversationManager: thread => ({ getConversation: id => id === 'background' ? conversation : null }),
    codexHistoryState: () => assert.fail('card status must not parse full history'),
    codexTurnSource: () => assert.fail('card status must not scan item bindings'),
  });
  assert.equal(context.run('codex', 'background').status, 'running');
  turn.status = 'completed'; turn.durationMs = 50;
  const done = context.run('codex', 'background');
  assert.equal(done.id, 'native-turn'); assert.equal(done.status, 'completed'); assert.equal(done.completedAt, 150);
  assert.equal(context.run('codex', 'not-loaded'), null);
});

test('Codex stopped, failed and unreadable turn states cannot report a completed result', () => {
  const turn = { turnId: 'turn', status: 'interrupted' };
  const context = nativeRunContext({ codexConversationManager: () => ({ getConversation: () => ({ turns: [turn] }) }) });
  assert.equal(context.run('codex', 'thread').status, 'stopped');
  turn.status = 'completed'; turn.error = { message: 'native failure' };
  assert.equal(context.run('codex', 'thread').status, 'error');
  delete turn.error; turn.status = undefined;
  assert.equal(context.run('codex', 'thread').status, 'unknown');
});

test('Codex canonical card status reuses the native loaded-turn reader and skips entries without turn identity', () => {
  const history = {}, turn = { turnId: 'canonical-latest', status: 'completed', turnStartedAtMs: 400, durationMs: 25 };
  let reads = 0;
  const manager = { getConversation: () => ({ turnHistory: { kind: 'canonical', history } }),
    threadStore: { stateReaders: { getLoadedConversationHistoryTurns(value) {
      assert.equal(value, history); reads++; return [{ turnId: 'older', status: 'inProgress' }, turn, {}];
    } } } };
  const context = nativeRunContext({ codexConversationManager: () => manager });
  const run = context.run('codex', 'thread');
  assert.equal(run.id, 'canonical-latest'); assert.equal(run.status, 'completed');
  assert.equal(run.startedAt, 400); assert.equal(run.completedAt, 425); assert.equal(reads, 1);
  manager.threadStore.stateReaders.getLoadedConversationHistoryTurns = () => [];
  assert.equal(context.run('codex', 'thread'), null);
});

test('Cursor completion requires native completed status and retains its generation identity', () => {
  const data = { status: 'running', latestChatGenerationUUID: 'generation', fullConversationHeadersOnly: [
    { type: 1, bubbleId: 'user', startedAtMs: 100 }, { type: 2, bubbleId: 'reply', completedAtMs: 200 },
  ] }, provider = { state: 'generating' };
  const context = nativeRunContext({ cursorSessionServices: () => ({ data: { getComposerDataIfLoaded: () => data } }),
    window: { __SSG_COMPOSER_PROVIDER__: { getStates: () => [{ id: 'thread', ...provider }] } } });
  assert.equal(context.run('cursor', 'thread').status, 'running');
  provider.state = 'focused'; assert.equal(context.run('cursor', 'thread').status, 'unknown');
  data.status = 'completed'; const done = context.run('cursor', 'thread');
  assert.equal(done.status, 'completed'); assert.equal(done.id, 'generation'); assert.equal(done.completedAt, 200);
  data.status = 'aborted'; assert.equal(context.run('cursor', 'thread').status, 'stopped');
});

test('Devin native prompt results remain tied to their session and waiting execution', () => {
  const request = { id: 'request', method: 'session/prompt', params: { sessionId: 'thread' }, status: 'completed', completedAt: 200 }, session = { status: 'active' };
  const state = { agentRequests: { byId: { request } } };
  const context = nativeRunContext({ window: { __acpStore: { getState: () => ({ acp: state }) } }, devinSessionRecord: () => session });
  assert.equal(context.run('devin', 'thread').status, 'running');
  assert.equal(context.run('devin', 'another-thread'), null);
  session.status = 'idle'; assert.equal(context.run('devin', 'thread').status, 'completed');
  session.status = 'unknown_error'; assert.equal(context.run('devin', 'thread').status, 'error');
});

test('window-owned turn facts survive selection changes without assuming an unfinished turn ended', () => {
  const source = new NativeWindow('ws://fixture.invalid');
  source.runStates.set('background', { id: 'turn', status: 'running', startedAt: 100 });
  source.snapshot = { states: [{ thread: 'selected', busy: false }] };
  let background = source.overviewStates().find(row => row.thread === 'background');
  assert.equal(background.statusKnown, false); assert.equal(background.run.status, 'unknown');
  assert.equal(source.runStates.get('background').status, 'running');
  source.runStates.set('background', { id: 'turn', status: 'completed', startedAt: 100, completedAt: 200 });
  background = source.overviewStates().find(row => row.thread === 'background');
  assert.equal(background.statusKnown, true); assert.equal(background.run.status, 'completed');
  assert.equal(background.run.id, 'turn');
});

test('a new Codex conversation remains observable before it enters the recent catalog', () => {
  const context = vm.createContext({ remoteContext: null, agentState: () => ({ thread: 'new-thread', busy: true }),
    codexHistoryScopes: () => [], codexThread: () => 'new-thread', codexChatRows: () => [],
    codexConversationManager: () => ({}),
    codexQueryClient: () => ({ getQueryData: () => [] }),
    agentRun: () => ({ id: 'new-turn', status: 'running', startedAt: 100 }) });
  const source = read('server/page/agents.js');
  vm.runInContext(fragment(source, '  const agentStates =', '  // Integrated terminals:') + '\nthis.states = agentStates;', context);
  const states = context.states('codex');
  assert.equal(states.length, 1); assert.equal(states[0].thread, 'new-thread');
  assert.equal(states[0].runId, 'codex:new-turn'); assert.equal(states[0].busy, true);
});

test('one native read resolves each Codex host manager once for all background rows', () => {
  const calls = [], local = {}, remote = {};
  const context = vm.createContext({ remoteContext: null, agentState: () => ({ thread: 'selected', busy: false }),
    codexHistoryScopes: () => [], codexThread: () => 'selected',
    codexChatRows: () => Array.from({ length: 50 }, (_, n) => ({ id: 'thread-' + n, host: n % 2 ? 'remote' : '' })),
    codexQueryClient: () => ({ getQueryData: () => [] }),
    codexConversationManager: (_thread, _scopes, host) => { calls.push(host); return host === 'remote' ? remote : local; },
    agentRun: (_app, thread, _scopes, manager) => { assert.equal(manager, thread.startsWith('thread-') && Number(thread.slice(7)) % 2 ? remote : local); return null; } });
  const source = read('server/page/agents.js');
  vm.runInContext(fragment(source, '  const agentStates =', '  // Integrated terminals:') + '\nthis.states = agentStates;', context);
  assert.equal(context.states('codex').length, 51);
  assert.deepEqual(calls, ['local', 'remote']);
});

test('native Fusion attachments from another paired entry carry the same summary while ordinary chat packets keep their native transcript only', async () => {
  const { fusionControllerView } = await import('../server/fusion/owner.mjs');
  const sent = [], run = { id: 'controller', computer: 'computer', title: 'Fusion', status: 'waiting', project: { name: 'project' },
    main: { bindingId: 'main', app: 'codex', model: 'model', effort: 'low' }, tier: 'balanced', works: [], tasks: [], assignments: [], questions: [],
    bindings: [{ id: 'main', app: 'codex', threadId: 'main-thread' }], attempts: [{ changes: { diff: 'large-diff'.repeat(100000) } }] };
  const context = vm.createContext({ captureOperation: () => false, cdpRead: { getStore: () => null }, AGENT_REGISTRY: {},
    fusionControllerView, allFusionRuns: () => [run], chatForWire: value => value });
  const body = fragment(read('server/session.mjs'), '  emit(', '\n  liveRead(cdp, sel)');
  const emit = vm.runInContext(`({${body}}).emit`, context);
  const session = { deviceId: 'another-paired-entry', fusionSaved: { runs: [] }, app: 'codex', threadId: 'main-thread', connectionMessages: new Map(),
    selectionKey: () => 'native-selection', client: { readyState: 1, send: raw => sent.push(JSON.parse(raw)) } };
  emit.call(session, { t: 'attached', app: 'codex', threadId: 'main-thread' });
  assert.equal(sent[0].fusionController.id, run.id); assert.equal(sent[0].fusionController.tasks.total, 0);
  assert.equal('attempts' in sent[0].fusionController, false);
  emit.call(session, { t: 'chat', sel: 'native-selection', chat: { thread: 'main-thread', items: [{ i: 'native', t: 'native body' }] } });
  assert.equal('fusionRun' in sent[1].chat, false); assert.equal(sent[1].chat.items[0].t, 'native body');
  emit.call(session, { t: 'attached', app: 'codex', threadId: 'ordinary-thread' });
  assert.equal(sent[2].fusionController, null);
});
test('a fresh native main first screen persists its current Fusion window without resuming work or rewriting attempts', async () => {
  const { fixture, flush } = await import('./fusion-fixture.mjs');
  const { rememberFusionMainWindow } = await import('../server/fusion/state.mjs');
  const { fusionControllerView } = await import('../server/fusion/owner.mjs');
  const { run } = fixture(), binding = run.bindings[0], cdp = {}, saved = [];
  run.main.windowId = binding.windowId = 'closed-window'; run.stopRequested = true; run.status = 'stopping';
  run.attempts.push({ id: 'unknown-native', status: 'unknown', native: { turnId: 'old-turn' }, bindingId: binding.id });
  run.events.push({ id: 'pending-result', deliveredTo: '' });
  const facts = JSON.stringify([run.attempts, run.events, run.stopRequested, run.status]);
  const context = vm.createContext({ captureOperation: () => false, cdpRead: { getStore: () => null }, AGENT_REGISTRY: {},
    fusionControllerView, allFusionRuns: () => [run], chatForWire: value => value, rememberFusionMainWindow,
    rememberSelection: (_device, selection) => saved.push(selection) });
  const emit = vm.runInContext(`({${fragment(read('server/session.mjs'), '  emit(', '\n  liveRead(cdp, sel) {')}}).emit`, context);
  const session = { app: 'codex', cdp, sel: 1, deviceId: 'paired-entry', targetId: 'codex', windowId: 'current-window', threadId: binding.threadId,
    bindingReady: true, selectionKey: () => 'current-selection', liveRead: () => true, currentRoots: async () => [run.project],
    connectionMessages: new Map(), client: { readyState: 1, send() {} } };
  emit.call(session, { t: 'attached', app: 'codex', threadId: binding.threadId, sel: 'current-selection', ready: true,
    chat: { thread: binding.threadId, items: [] } });
  await flush();
  assert.equal(saved.length, 1); assert.equal(binding.windowId, 'current-window'); assert.equal(run.main.windowId, 'current-window');
  assert.equal(JSON.stringify([run.attempts, run.events, run.stopRequested, run.status]), facts);
  const revision = run.revision;
  rememberFusionMainWindow(run, saved[0], [run.project]);
  assert.equal(run.revision, revision);
  for (const change of [{ app: 'cursor' }, { threadId: 'ordinary-thread' }])
    rememberFusionMainWindow(run, { ...saved[0], windowId: 'unrelated', ...change }, [run.project]);
  rememberFusionMainWindow(run, { ...saved[0], windowId: 'unrelated' }, [{ root: run.project.root, host: 'other-host' }]);
  assert.equal(binding.windowId, 'current-window'); assert.equal(run.revision, revision);
});
test('cached, incomplete and superseded first screens do not move a Fusion main binding', async () => {
  const { fixture, flush } = await import('./fusion-fixture.mjs');
  const { fusionControllerView } = await import('../server/fusion/owner.mjs');
  const { run } = fixture(); let rootsReady, confirmations = 0;
  const context = vm.createContext({ captureOperation: () => false, cdpRead: { getStore: () => null }, AGENT_REGISTRY: {},
    fusionControllerView, allFusionRuns: () => [run], chatForWire: value => value,
    rememberFusionMainWindow: () => confirmations++, rememberSelection() {} });
  const emit = vm.runInContext(`({${fragment(read('server/session.mjs'), '  emit(', '\n  liveRead(cdp, sel) {')}}).emit`, context);
  const session = { app: 'codex', cdp: {}, sel: 1, windowId: 'new-window', threadId: 'main-thread', bindingReady: false,
    selectionKey: () => 'selection', liveRead: () => true, currentRoots: () => new Promise(resolve => { rootsReady = resolve; }),
    connectionMessages: new Map(), client: { readyState: 1, send() {} } };
  const first = { t: 'attached', app: 'codex', threadId: 'main-thread', sel: 'selection', chat: { thread: 'main-thread', items: [] } };
  emit.call(session, first); assert.equal(rootsReady, undefined);
  session.bindingReady = true; emit.call(session, { ...first, cached: true }); assert.equal(rootsReady, undefined);
  emit.call(session, first); session.liveRead = () => false; rootsReady([run.project]); await flush();
  assert.equal(confirmations, 0); assert.equal(run.bindings[0].windowId, 'shared');
});
test('a paired entry restores its recent shared Fusion workspace without creating or executing a run', () => {
  const run = { id: 'shared-controller', deviceId: 'creator-entry' }, saved = { current: run.id, runs: [] }, viewers = new Set();
  const context = vm.createContext({ AgentContext: class {}, savedFusion: () => saved, allFusionRuns: () => [run], fusionViewers: viewers });
  const constructor = fragment(read('server/session.mjs'), '  constructor(client, deviceId,', '\n  stopChatUpdates()');
  const Session = vm.runInContext(`(class extends AgentContext {${constructor}})`, context);
  const session = new Session({}, 'phone-entry');
  assert.equal(session.fusionRun, run); assert.equal(session.fusionSaved, saved);
  assert.equal(viewers.has(session), true); assert.equal(saved.runs.length, 0);
});

function devinCreation({ active = 'acp/devin-cli/old', appearAfter = 0, recordDelay = 0, cwd = '/project', extractCwd = '/project', newCwd = '/project' } = {}) {
  const emitted = [], calls = [], sessions = new Set(['acp/devin-cli/old']);
  const NEW = 'acp/devin-cli/new-1';
  let polls = 0, activeNow = active, created = false;
  const context = vm.createContext({ path, helpersCall: value => value, fusionProject: root => ({ id: root }),
    setTimeout: action => action(), PAGE_SRC: 'H' });
  const newChat = vm.runInContext('({' + fragment(read('server/apps/devin.mjs'), 'async devinNewChat() {', '// ---- Devin working directory') + '})', context);
  const finish = vm.runInContext('({' + fragment(read('server/agent/projects.mjs'), '  async finishProject() {', '  projectName() {') + '})', context);
  const sessionCwd = () => activeNow === NEW ? newCwd : cwd;
  const session = { ...newChat, ...finish, app: 'devin', mode: 'chat',
    pendingProject: { root: '/project', threadId: '', newSession: true },
    threadId: 'acp/devin-cli/old', selectedThread: 'acp/devin-cli/old',
    adapter: { newChat: async function () { await this.devinNewChat(); } },
    projectMatches(roots, root, host = '') {
      return roots.some(project => (project.host || '') === host && project.root === root);
    },
    editorCdp: { evaluate: async () => ({ required: false }) },
    cdp: { evaluate: async expression => {
      calls.push(expression.slice(0, 60));
      if (expression === 'activeThread()') return activeNow;
      if (expression === 'devinSession()') return { surface: 'editor', key: activeNow, cwd: sessionCwd() };
      if (expression === 'hasComposer()') return true;
      if (expression === "control('newChat')") { created = true; return { x: 1, y: 1 }; }
      if (expression === 'extract()') return { thread: activeNow, items: [], session: { key: activeNow, cwd: extractCwd } };
      if (expression.includes('nativeSessionInfo')) {
        polls++;
        if (created && polls > appearAfter) { activeNow = NEW; sessions.add(NEW); }
        const thread = activeNow;
        const ready = polls > recordDelay && thread !== 'acp/devin-cli/old' && sessions.has(thread);
        return { thread, key: thread, surface: 'editor', cwd: sessionCwd(), composer: true, record: ready };
      }
      return null;
    } },
    waitFor: async () => null, currentRoots: async () => [{ root: '/project' }],
    resetDevinView() { calls.push('resetView'); }, clearViewState() { calls.push('clearView'); },
    publishThread() { emitted.push({ t: 'thread', threadId: this.threadId }); },
    selectionKey() { return 'devin|window|' + this.threadId; }, emit: value => emitted.push(value),
    async pollChat(immediate, firstScreen) {
      if (this.switchingThread && firstScreen) throw new Error('当前会话尚未就绪，请重试');
      emitted.push({ t: 'chat', chat: { thread: activeNow, items: [] } });
    },
    tapCss: async () => { calls.push('tapNew'); }, setSurface: async () => { calls.push('setSurface'); },
    syncSession(chat) { this.lastChat = chat; },
    prefetchMenus: async () => {},
  };
  return { session, emitted, calls, get polls() { return polls; }, get activeNow() { return activeNow; } };
}

test('Devin new chat never accepts the old empty view as the new session', async () => {
  const h = devinCreation({ appearAfter: 999 });
  await assert.rejects(h.session.finishProject(), /新会话尚未就绪/);
  assert.equal(h.session.pendingProject.newSession, true);
  assert.equal(h.emitted.some(message => message.t === 'projectReady'), false);
  assert.equal(h.session.threadId, 'acp/devin-cli/old');
});

test('Devin new chat binds only after a distinct native identity appears', async () => {
  const h = devinCreation({ appearAfter: 3 });
  await h.session.finishProject();
  assert.equal(h.session.threadId, 'acp/devin-cli/new-1');
  assert.equal(h.session.selectedThread, 'acp/devin-cli/new-1');
  const ready = h.emitted.find(message => message.t === 'projectReady');
  assert.equal(ready.chat.thread, 'acp/devin-cli/new-1');
  assert.equal(ready.chat.session.cwd, '/project');
  assert.equal(h.emitted.some(message => message.t === 'chat'), false, 'the helper does not publish a first screen during a project switch');
  assert.equal(h.emitted.some(message => message.t === 'status' && message.msg === '已新建对话'), false);
});

test('Devin project new chat never polls a first screen while the thread switch is still active', async () => {
  const h = devinCreation({ appearAfter: 2 });
  h.session.switchingThread = true;
  await h.session.finishProject();
  assert.equal(h.session.threadId, 'acp/devin-cli/new-1');
  assert.equal(h.emitted.some(message => message.t === 'projectReady'), true);
});

test('Devin standalone new chat publishes its own first screen after adoption', async () => {
  const h = devinCreation({ appearAfter: 1 });
  h.session.pendingProject = null;
  await h.session.devinNewChat();
  assert.equal(h.session.threadId, 'acp/devin-cli/new-1');
  assert.deepEqual(h.emitted.map(message => message.t), ['thread', 'chat', 'status']);
  assert.equal(h.emitted.at(-1).msg, '已新建对话');
  assert.equal(h.emitted.find(message => message.t === 'chat').chat.thread, 'acp/devin-cli/new-1');
});

test('Devin new chat rejects a new session rooted in another directory before adopting it', async () => {
  const h = devinCreation({ appearAfter: 1, newCwd: '/other-project' });
  await assert.rejects(h.session.finishProject(), /工作目录与所选项目不一致/);
  assert.equal(h.session.threadId, 'acp/devin-cli/old');
  assert.equal(h.calls.includes('clearView'), false);
  assert.equal(h.emitted.some(message => message.t === 'projectReady' || message.t === 'thread'), false);
});

test('Devin new chat requires the native session record before confirming', async () => {
  const h = devinCreation({ appearAfter: 0, recordDelay: 5 });
  await h.session.finishProject();
  assert.ok(h.polls > 5);
  assert.equal(h.session.threadId, 'acp/devin-cli/new-1');
});

test('Devin project creation rejects a new session rooted in another directory', async () => {
  const h = devinCreation({ extractCwd: '/other-project' });
  await assert.rejects(h.session.finishProject(), /工作目录与所选项目不一致/);
  assert.equal(h.session.pendingProject.newSession, true);
  assert.equal(h.emitted.some(message => message.t === 'projectReady'), false);
});
