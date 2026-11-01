import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { NativeWindow } from '../server/native-windows.mjs';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const fragment = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));

function pageContext(extra = {}) {
  const context = vm.createContext({ window: {}, doc: { defaultView: {} }, ...extra });
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
    const context = vm.createContext({
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
  const context = vm.createContext({ doc: { querySelectorAll: () => [unrelated, model] }, vis: () => true, revealDevinComposer() {} });
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
  const context = vm.createContext({ doc: { defaultView: {} }, codexHistoryBinding: (_scope, value) => ({ get: () => value }) });
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
  const context = vm.createContext({ codexButton: () => button, codexPoint: () => ({ x: 1, y: 2 }), vis: () => true,
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
  const context = vm.createContext(extra), source = read('server/page/agents.js');
  vm.runInContext(fragment(source, '  const agentRun =', '  const agentStates =')
    + '\nthis.run = (app, thread, scopes=[]) => agentRun(app, thread, scopes, app === "codex" ? codexConversationManager(thread, scopes) : null);', context);
  return context;
}

test('Codex run status follows a loaded background native turn rather than current DOM controls', () => {
  const turn = { status: 'inProgress', turnStartedAtMs: 100 }, conversation = {};
  const context = nativeRunContext({ codexConversationManager: thread => ({ getConversation: id => id === 'background' ? conversation : null }),
    codexHistoryState: (_value, _watch, _scopes, thread) => { assert.equal(thread, 'background'); return { entries: [{ turnId: 'native-turn' }] }; },
    codexTurnSource: () => ({ metadata: turn }),
  });
  assert.equal(context.run('codex', 'background').status, 'running');
  turn.status = 'completed'; turn.durationMs = 50;
  const done = context.run('codex', 'background');
  assert.equal(done.id, 'native-turn'); assert.equal(done.status, 'completed'); assert.equal(done.completedAt, 150);
  assert.equal(context.run('codex', 'not-loaded'), null);
});

test('Codex stopped, failed and unreadable turn states cannot report a completed result', () => {
  const turn = { status: 'interrupted' };
  const context = nativeRunContext({ codexConversationManager: () => ({ getConversation: () => ({}) }),
    codexHistoryState: () => ({ entries: [{ turnId: 'turn' }] }), codexTurnSource: () => ({ metadata: turn }) });
  assert.equal(context.run('codex', 'thread').status, 'stopped');
  turn.status = 'completed'; turn.error = { message: 'native failure' };
  assert.equal(context.run('codex', 'thread').status, 'error');
  delete turn.error; turn.status = undefined;
  assert.equal(context.run('codex', 'thread').status, 'unknown');
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
  const context = vm.createContext({ agentState: () => ({ thread: 'new-thread', busy: true }),
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
  const context = vm.createContext({ agentState: () => ({ thread: 'selected', busy: false }),
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
