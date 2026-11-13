import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { NativeWindow } from '../server/native-windows.mjs';
import { adapter as codexAdapter } from '../server/apps/codex.mjs';
import { adapter as cursorAdapter } from '../server/apps/cursor.mjs';
import { read, fragment, createPageContext } from './page-fixture.mjs';

function batchFixture(cancel = false) {
  const calls = [], events = [], archived = [], releases = [];
  const rows = [
    { id: 'thread:desktop:N', app: 'codex' }, { id: 'thread:backend:B', app: 'codex' },
    { id: 'thread:backend:busy', app: 'codex' }, { id: 'thread:backend:fusion', app: 'codex' },
    { id: 'thread:backend:missing', app: 'codex' },
  ];
  const common = vm.runInContext(read('server/agent/session-actions.mjs').replace(/^import .*;\n/gm, '').replace('export const methods', 'const methods') + '\nmethods;', vm.createContext({
    sessionId: (_app, id) => id.split(':').at(-1), helpersCall: value => value,
    fusionBindingInUse: (_app, id) => id === 'fusion', leaseWindow: (_app, id) => () => releases.push(id),
  }));
  class Context {
    constructor({ emit }) { this.emit = emit; }
    async codexThreadRows() { return [{ id: 'N', running: false }]; }
    async codexArchiveThread(id) { archived.push(id); }
  }
  Context.prototype.archiveBatchSession = common.archiveBatchSession;
  class Cdp {
    async connect() { calls.push('connect'); }
    async evaluate(call) { return call === 'codexThread()' ? 'N' : { thread: 'N', busy: false }; }
    close() { calls.push('close'); }
  }
  const routes = vm.runInContext(fragment(read('server/apps/codex.mjs'), 'const backendRoutes =', 'function serializedCodexPrompt') + '\nbackendRoutes;', vm.createContext({
    CODEX_BACKEND: 'backend', path, AgentContext: Context, NativeCdp: Cdp, helpersCall: value => value,
    nativeTargets: () => [{ app: 'codex', pageId: 'desktop', ws: 'ws' }], nativeSessionCatalog: () => ({ rows: [] }), backendAgentRows: () => [],
    publishSessionChange: (_app, id, value) => calls.push(['publish', id, value.action]),
    codexBackend: { load: async id => {
      if (id === 'missing') throw Error('sample missing');
      return { turns: id === 'busy' ? [{ status: 'inProgress' }] : [] };
    }, manage: async id => archived.push('thread:backend:' + id) },
  }));
  const session = { ...common, app: 'codex', codexBackend: true, codexDirectory: '/B', threadId: 'B', deviceId: 'test',
    selectionKey: () => 'B', sessionEntries: new Map(rows.map(row => [row.id, row])), emit: message => {
      events.push(message);
      if (cancel && message.t === 'sessionBatchProgress' && message.results.length === 1 && !message.done) session.sessionBatch.cancelled = true;
    } };
  return { calls, events, archived, releases, routes, session, rows };
}

test('mixed backend/native batch archive keeps the backend binding and checks fresh busy/Fusion state', async () => {
  const h = batchFixture(); await h.routes.sessionBatch.call(h.session, { ids: h.rows.map(row => row.id), requestId: 'mixed' });
  assert.deepEqual(h.archived, ['thread:desktop:N', 'thread:backend:B']);
  const done = h.events.findLast(row => row.t === 'sessionBatchProgress');
  assert.equal(done.done, true); assert.equal(done.results.length, 5);
  assert.equal(done.results.find(row => row.id.endsWith(':busy')).ok, false);
  assert.equal(done.results.find(row => row.id.endsWith(':fusion')).ok, false);
  assert.equal(done.results.find(row => row.id.endsWith(':missing')).ok, false);
  assert.equal(h.session.threadId, 'B'); assert.equal(h.session.codexBackend, true);
  assert.deepEqual(h.calls.filter(row => typeof row === 'string'), ['connect', 'close']);
  assert.equal(h.releases.length, 2); assert.equal(h.session.sessionBatch, null);
});

test('cancel mixed batch archive stops remaining rows and releases all window leases', async () => {
  const h = batchFixture(true); await h.routes.sessionBatch.call(h.session, { ids: h.rows.map(row => row.id), requestId: 'cancel' });
  assert.deepEqual(h.archived, ['thread:desktop:N']);
  const done = h.events.findLast(row => row.t === 'sessionBatchProgress');
  assert.equal(done.done, true); assert.equal(done.cancelled, true); assert.equal(done.results.length, 1);
  assert.equal(h.releases.length, 2); assert.equal(h.session.sessionBatch, null);
});

test('existing desktop batch still uses the same fresh native archive checks', async () => {
  const h = batchFixture(), removed = [];
  Object.assign(h.session, { codexBackend: false, cdp: { evaluate: async () => ({ busy: false }) },
    codexThreadRows: async () => [{ id: 'N' }], codexArchiveThread: async id => removed.push(id) });
  await h.session.batchSessions(['thread:desktop:N'], 'desktop');
  assert.deepEqual(removed, ['thread:desktop:N']);
});

test('backend chat subscription cleanup removes its retry registration on return, switch and hide', async () => {
  const calls = [], context = vm.createContext({ awaitCdpRead: promise => promise,
    codexBackend: { load: async () => {}, subscribe: () => () => {}, clearRetry: owner => calls.push(owner) },
    watchChatUpdates: () => () => calls.push('unsubscribe'), backendPublish: () => {},
    backendRoutes: { codexRetry: () => calls.push('configure') },
  });
  const method = vm.runInContext('({' + fragment(read('server/apps/codex.mjs'), '  async setBackendMode(', '  async sendBackendMessage(') + '}).setBackendMode', context);
  const session = { threadId: 'A', visible: true, codexRetrySettings: { sel: 'A' } };
  await method.call(session); session.chatUpdatesStop();
  assert.equal(calls[0], 'configure'); assert.equal(calls[1], session); assert.equal(calls[2], 'unsubscribe');
});

test('retry menu distinguishes backend continuation from desktop Retry clicks', () => {
  for (const backend of [true, false]) {
    let html;
    const context = vm.createContext({ currentComputer: () => ({ windowId: backend ? 'backend' : 'desktop' }),
      codexAutoRetryEnabled: () => true, codexAutoRetryCount: () => 2, openSheet: (_kind, value) => { html = value; }, $: () => ({}) });
    vm.runInContext(fragment(read('app/js/sheets.js'), 'function showCodexRetryMenu(', 'function toggleCodexAutoRetry(') + '\nshowCodexRetryMenu();', context);
    assert.equal(html.includes('离开对话页后停止'), backend); assert.equal(html.includes('自动点击电脑端 Retry'), !backend);
    assert.equal(html.includes('保留'), true);
  }
});

function settingsOwnerFixture(created = false) {
  const calls = [], pages = created ? [] : [{ pageId: 'bound', ws: 'editor', chatWs: 'sidebar' }];
  class Context {
    async withFocus(fn) { return fn(); }
    async showCodexSettings() { calls.push('show'); return 'settings'; }
    async closeCodexSettings() { calls.push('restore'); }
  }
  class Cdp {
    constructor(ws) { this.ws = ws; }
    async connect() { calls.push(['connect', this.ws]); }
    async send(method) { calls.push(['send', this.ws, method]); }
    close() { calls.push(['disconnect', this.ws]); }
  }
  const context = createPageContext({ AgentContext: Context, Cdp, CODEX_CDP_URL: 'codex',
    clearTimeout, setTimeout, cdpRead: { run: (_signal, fn) => fn() }, awaitCdpRead: promise => promise,
    orderedProjectWindows: (_app, rows) => rows, codexWindows: async () => pages,
    bindProjectWindow: (_app, id) => calls.push(['bind-window', id]),
    leaseWindow: () => () => calls.push('release'), nativeCloseProjectWindow: async () => calls.push('close-window'),
    openFolder: async (...args) => { calls.push(['open-folder', ...args]); pages.push({ pageId: 'created', ws: 'editor', chatWs: 'sidebar' }); },
  });
  const helpers = vm.runInContext(fragment(read('server/apps/codex.mjs'), 'async function backendSettingsOwner(', 'const backendRoutes =')
    + '\n({backendSettingsOwner,closeBackendSettings,withBackendSettings});', context);
  const session = { deviceId: 'device', app: 'codex', threadId: 'backend-thread', cdp: null, editorCdp: null, codexDirectory: '/A', emit() {} };
  return { calls, helpers, session };
}

for (const created of [false, true]) test(`backend settings ${created ? 'create' : 'borrow'} a window while preserving the backend selection`, async () => {
  const h = settingsOwnerFixture(created), { session, helpers, calls } = h;
  assert.equal(await helpers.withBackendSettings(session, context => context.showCodexSettings()), 'settings');
  const owner = session.codexBackendSettings;
  await helpers.withBackendSettings(session, context => context.showCodexSettings());
  assert.equal(session.codexBackendSettings, owner);
  assert.equal(session.threadId, 'backend-thread'); assert.equal(session.cdp, null); assert.equal(session.editorCdp, null);
  await Promise.all([helpers.closeBackendSettings(session, owner), helpers.closeBackendSettings(session, owner)]);
  assert.equal(calls.filter(call => call === 'restore').length, 1);
  assert.equal(calls.filter(call => call === 'release').length, 1);
  assert.equal(calls.filter(call => call === 'close-window').length, created ? 1 : 0);
  assert.equal(calls.filter(call => Array.isArray(call) && call[0] === 'disconnect').length, 2);
});

test('closing an old settings owner after a session change never releases the new owner', async () => {
  const h = settingsOwnerFixture();
  const old = await h.helpers.backendSettingsOwner(h.session);
  h.session.codexBackendSettings = null;
  const next = await h.helpers.backendSettingsOwner(h.session);
  await h.helpers.closeBackendSettings(h.session, old);
  assert.equal(h.session.codexBackendSettings, next);
  assert.equal(next.closing, undefined);
  await h.helpers.closeBackendSettings(h.session);
});

for (const operation of ['detach', 'suspend']) test(`${operation} releases backend settings without stopping the background thread`, () => {
  const calls = [], context = createPageContext({ setTimeout, clearTimeout, clearInterval,
    cdpRead: { run: (_signal, fn) => fn() }, console,
  });
  const source = read('server/session.mjs');
  const release = fragment(source, '  releaseBackendSettings() {', '  detach() {');
  const action = operation === 'detach' ? fragment(source, '  detach() {', '  async refreshViewport() {') : fragment(source, '  suspend() {', '  dispose() {');
  const methods = vm.runInContext('({' + release.trimEnd() + ',\n' + action + '})', context);
  const session = { ...methods, app: 'codex', threadId: 'background', codexBackend: true, codexBackendSettings: {},
    adapter: { closeBackendSettings: async function () { this.codexBackendSettings = null; calls.push('release-settings'); } },
    stopChatUpdates() {}, stopTerminalUpdates() {}, stopVisual() {},
  };
  session[operation]();
  assert.deepEqual(calls, ['release-settings']);
  assert.equal(session.threadId, 'background');
});

function pageContext(extra = {}, source = read('server/page/session-actions.js')) {
  const context = createPageContext({ remoteContext: null, window: {}, doc: { defaultView: {} }, activeThread: () => '', ...extra });
  vm.runInContext(source + '\nthis.info = nativeSessionInfo; this.action = nativeSessionAction;', context);
  return context;
}

test('Codex ownership uses native stream role, not the visible thread or cached conversation', () => {
  for (const role of ['owner', 'follower', undefined]) {
    let inspected = '';
    const page = pageContext({ codexHistoryScopes: () => [], codexConversationManager: id => ({
      getStreamRole: value => { inspected = value; return role ? { role } : null; },
      getConversation: value => { assert.equal(value, id); return { cwd: '/other-project' }; },
    }) });
    const value = page.info('codex', 'native-thread', 'owner');
    assert.equal(inspected, 'native-thread');
    assert.equal(value?.cwd || null, role === 'owner' ? '/other-project' : null);
  }
});

test('Cursor adopts the actual workspace thread only after its Agent panel is ready', async () => {
  const events = [], calls = [];
  const context = createPageContext({ path, helpersCall: value => value, fusionProject: root => ({ id: root }) });
  const methods = vm.runInContext('({' + fragment(read('server/agent/projects.mjs'), '  async finishProject() {', '  projectName() {') + '})', context);
  const session = { ...methods, app: 'cursor', pendingProject: { root: '/B', newSession: false },
    threadId: 'thread-A', selectedThread: 'thread-A', editorCdp: { evaluate: async () => ({ required: false }) },
    waitFor: async expression => { calls.push(expression); return { thread: 'thread-B' }; },
    clearViewState: () => calls.push('clear'), currentRoots: async () => [{ root: '/B' }],
    selectionKey: () => 'cursor|carrier|thread-B', emit: message => events.push(message),
  };
  await session.finishProject();
  assert.deepEqual(calls, ['agentStartupState("cursor", true)', 'clear']);
  assert.equal(session.threadId, 'thread-B'); assert.equal(session.selectedThread, 'thread-B');
  assert.equal(events[0].t, 'projectReady'); assert.equal(events[0].path, '/B');
});

test('Devin cross-project creation completes in one switch before reading the new first screen', async () => {
  const calls = [], controller = new AbortController();
  const context = createPageContext({ path, crypto: { randomUUID: () => 'request' },
    safeHomePath: real => ({ real }), cdpRead: { getStore: () => controller.signal }, helpersCall: value => value,
  });
  const methods = vm.runInContext('({' + fragment(read('server/agent/projects.mjs'), '  async useProject(', '  async resumeProjectSwitch(') + '})', context);
  const cdp = { evaluate: async () => ({ threadId: 'new-B', roots: [{ root: '/B' }] }) };
  const session = { ...methods, app: 'devin', cdp, threadId: 'old-A', mode: 'chat',
    projectMatches: (roots, root) => roots[0].root === root,
    adapter: { openAgent: async function (id) { assert.equal(this.switchingThread, true); assert.equal(this.bindingReady, false); this.threadId = id; calls.push('open'); } },
    projectReady: pending => calls.push(['projectReady', pending.root, pending.newSession]),
    async resumeProjectSwitch(previous) { assert.equal(previous, cdp); assert.equal(this.bindingReady, true); assert.equal(this.threadId, 'new-B'); this.switchingThread = false; calls.push('first-screen'); },
  };
  await session.useProject('/B', true);
  assert.deepEqual(calls, ['open', ['projectReady', '/B', true], 'first-screen']);
});

test('Devin opens the requested empty thread through the selected IDE window native main-panel command', async () => {
  const opened = [], chat = {}, id = 'acp/devin-cli/new-empty';
  const source = read('server/page/session-actions.js').replace("const native = await import('@exa/chat-client');\n      const api", 'const native = nativeModule;\n      const api');
  const context = pageContext({ document: { querySelector: () => chat }, devinRowSession: row => row.sessionId, devinSessionRecord: value => value === id ? { sessionId: id } : null, devinNativeId: id => 'devin-' + id,
    nativeModule: { encodeOpenCascadeIdInChatPanelPayload: value => [value] },
    window: { __acpStore: { getState: () => ({ acp: { sessions: [{ sessionId: id, cwd: '/B' }] } }) } },
    codexFiberProps: element => { assert.equal(element, chat); return [{ vscodeAPI: { executeCommand: async (command, action) => opened.push([command, action]) } }]; } }, source);
  assert.equal(await context.action('devin', id, 'open'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [['devin.sendChatActionMessage', { actionType: 'openCascadeIdInChatPanel', payload: ['devin-' + id] }]]);
});

test('Cursor project replacement calls the selected window native host with forceReuseWindow', async () => {
  class Uri { static file(value) { return { scheme: 'file', path: value }; } }
  const calls = [], uri = new Uri();
  const context = pageContext({ window: { __remoteAgentCursorServices: {
    composer: { composerChatService: { _workspaceContextService: { getWorkspace: () => ({ folders: [{ uri }] }) } } },
    nativeHost: { openWindow: async (...args) => calls.push(args) },
  } } });
  await context.action('cursor', '', 'project', '/B');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [[[{ folderUri: { scheme: 'file', path: '/B' } }], { forceReuseWindow: true }]]);
});

for (const result of ['archive', 'delete', 'clear']) {
  test(`Cursor removal uses the persisted native outcome: ${result}`, async () => {
    const row = { composerId: 'target', name: 'target' }, other = { composerId: 'other' };
    let headers = [row, other], loaded = result === 'clear' ? [row] : [row, other], empty = false;
    const data = { get allComposersData() { return { allComposers: loaded }; },
      async whenInitialComposerDataLoaded() {},
      async getComposerHandleById(id) { return { data: loaded.find(row => row.composerId === id) }; },
      _storageService: { collectionQuery: async () => headers.map(row => JSON.stringify(row)) },
      getComposerDataIfLoaded: () => ({ fullConversationHeadersOnly: empty ? [] : ['message'] }),
    };
    const composer = {
      composerChatService: { _workspaceContextService: { getWorkspace: () => ({ id: 'workspace', folders: [] }) } },
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
    const context = createPageContext({ remoteContext: null,
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
  const context = createPageContext({ remoteContext: null, doc: { querySelectorAll: () => [unrelated, model] }, vis: () => true,
    codexFiberProps: () => [], revealDevinComposer() {} });
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
  const context = createPageContext({ remoteContext: null, doc: { defaultView: {} }, codexHistoryBinding: (_scope, value) => ({ get: () => value }) });
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
  const context = createPageContext({ remoteContext: null, codexButton: () => button, codexPoint: () => ({ x: 1, y: 2 }), vis: () => true,
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
  const context = createPageContext({ remoteContext: null, devinAgentRequests: () => extra.window.__acpStore.getState().acp.agentRequests.byId, ...extra }), source = read('server/page/agents.js');
  vm.runInContext(fragment(source, '  const agentRun =', '  const agentStates =')
    + '\nthis.run = (app, thread, scopes=[]) => agentRun(app, thread, scopes, app === "codex" ? codexConversationManager(thread, scopes) : null);', context);
  return context;
}

function nativeWaitingState(app = 'codex') {
  const state = { thread: 'thread-A', requests: [], labels: [], busy: false, panel: true, questions: null };
  const item = { innerText: '任务已正常完成', matches: () => false, querySelector: () => null, querySelectorAll: () => [],
    hasAttribute: key => key === 'data-turn-key', getAttribute: () => 'native-turn' };
  const panel = {};
  const context = createPageContext({ remoteContext: null, doc: { querySelectorAll: () => [] }, vis: () => true,
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
  const context = createPageContext({ codexThread: () => 'native-thread', codexRootProps: () => [], remoteContext: null, doc, document: doc, activeThread: () => state.thread, vis: () => true,
    codexQueueConfirmRequests: () => [], codexFiberProps: el => el.props || [], codexPoint: () => ({ x: 1, y: 2 }), setTimeout });
  vm.runInContext(fragment(read('server/page/codex.js'), '  const codexAsyncRequestFiber =', '  const codexImage =')
    + '\nthis.data=codexRequestData;this.field=codexRequestField;this.action=codexRequestAction;', context);
  return { state, owner, form, root, host, skip, answersHook, ...context, context };
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
  const context = createPageContext({ remoteContext: null, agentState: () => ({ thread: 'new-thread', busy: true }),
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
  const context = createPageContext({ remoteContext: null, agentState: () => ({ thread: 'selected', busy: false }),
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
    bindings: [{ id: 'main', app: 'codex', threadId: 'main-thread', windowId: 'main-window', project: { root: '/project' } }], attempts: [{ changes: { diff: 'large-diff'.repeat(100000) } }] };
  const context = createPageContext({ captureOperation: () => false, cdpRead: { getStore: () => null }, AGENT_REGISTRY: {},
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
  const context = createPageContext({ captureOperation: () => false, cdpRead: { getStore: () => null }, AGENT_REGISTRY: {},
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
  const context = createPageContext({ captureOperation: () => false, cdpRead: { getStore: () => null }, AGENT_REGISTRY: {},
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
  const context = createPageContext({ AgentContext: class {}, savedFusion: () => saved, allFusionRuns: () => [run], fusionViewers: viewers });
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
  const context = createPageContext({ path, helpersCall: value => value, fusionProject: root => ({ id: root }),
    setTimeout: action => action(), PAGE_SRC: 'H', editorRoots: async () => [{ root: '/project' }] });
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

for (const app of ['cursor', 'devin', 'codex', 'opencode']) test(`failed project navigation retains the previous successful selection: ${app}`, () => {
  const saved = { app, threadId: 'A', project: { root: '/A' } }, emitted = [], calls = [];
  const scope = createPageContext({ forgetSelection: () => assert.fail('successful persisted selection was discarded') });
  const fn = vm.runInContext('({' + fragment(read('server/session.mjs'), '  navigationFailed(', '  // Warms') + '}).navigationFailed', scope);
  const session = { app, deviceId: 'one-entry', cdp: null, rememberedSelection: 'A', threadId: 'A', selectedThread: 'A',
    chatWatchGeneration: 0, stopChatUpdates: () => calls.push('stop'), clearViewState: () => calls.push('clear'),
    selectionKey: () => app + '||', emit: message => emitted.push(message), selectionStore: saved };
  scope.clearInterval = () => {};
  fn.call(session, { t: 'openProject', path: '/missing' }, new Error('missing directory'));
  assert.equal(session.selectionStore, saved); assert.equal(session.selectionStore.threadId, 'A');
  assert.equal(session.bindingReady, false); assert.equal(emitted[0].t, 'attachFailed'); assert.equal(emitted[0].message, 'missing directory');
  assert.deepEqual(calls, ['stop', 'clear']);
});

test('native mention segmentation shares ordering while preserving application insert callbacks', async () => {
  const context = createPageContext(), source = read('server/agent/context.mjs');
  const fn = vm.runInContext('({' + fragment(source, '  async typeWithNativeMentions(', '  async withFocus(') + '}).typeWithNativeMentions', context);
  const calls = [], mentions = [{ token: '@a' }, { token: '@missing' }, { token: '@b' }];
  await fn.call({ typeText: async text => calls.push(['text', text]) }, 'pre @a between @b end', mentions,
    async mention => { calls.push(['insert', mention.token]); return mention.token === '@a'; });
  assert.deepEqual(calls, [['text', 'pre '], ['insert', '@a'], ['text', 'between '], ['insert', '@b'], ['text', '@b'], ['text', ' end']]);
});

test('Codex request detection cannot promote generic Cursor IDE notifications into approvals', () => {
  const h = codexQuestionReader(); assert(h.data().length);
  h.context.codexThread = () => ''; h.context.codexRootProps = () => [];
  assert.equal(h.data().length, 0);
});

test('Devin text fragments join within their native stream and retain independent paragraphs', () => {
  const context = createPageContext(); vm.runInContext(fragment(read('server/page/devin.js'), '  const devinMessageText =', '  const THINKING_ROOT =') + ';this.join=devinMessageText;', context);
  const block = (text, id) => ({ content: { type: 'text', text }, _meta: { 'cognition.ai/streamingMessageId': id } });
  assert.equal(context.join([block('RA_DEV', 's'), block('IN 中文', 's'), block('🙂', 's'), block('new paragraph', 't'), block(' plain', null)]), 'RA_DEVIN 中文🙂\nnew paragraph\n plain');
});

test('Devin native permission replies preserve provider, store key and exact option identity', async () => {
  const row = { status: 'pending', providerId: 'devin-cli', request: { id: 0, method: 'session/request_permission', params: { sessionId: 'A',
    toolCall: { title: 'Run command' }, options: [{ optionId: 'allow-project', name: 'Allow in project' }, { optionId: 'reject_once', name: 'Reject' }] } } };
  const state = { clientRequests: { 'store-key-A': row, other: { ...row, request: { ...row.request, params: { ...row.request.params, sessionId: 'B' } } } } }, dispatched = [];
  const nativeModule = { clientRequestCompleted: payload => ({ type: 'complete', payload }) };
  const context = pageContext({ devinClientRequests: () => state.clientRequests, devinSessionHandle: () => ({ respond: (key, response) => dispatched.push({ payload: { clientRequestId: key, response } }) }), nativeModule,
    activeThread: () => 'acp/devin-cli/A', remoteContext: null }, read('server/page/session-actions.js').replaceAll("await import('@exa/chat-client')", 'nativeModule'));
  vm.runInContext(fragment(read('server/page/devin.js'), '  const devinPermissionEntries =', '  const devinQuestions =') + ';this.requests=devinPermissions;', context);
  const requests = context.requests('acp/devin-cli/A'); assert.equal(requests.length, 1); assert.equal(requests[0].buttons[0].label, 'Allow in project');
  await context.action('devin', 'acp/devin-cli/A', 'permission', { id: requests[0].id, n: 1 });
  assert.equal(dispatched.length, 1); assert.equal(dispatched[0].payload.clientRequestId, 'store-key-A');
  assert.equal(dispatched[0].payload.response.outcome.optionId, 'reject_once');
  await assert.rejects(context.action('devin', 'acp/devin-cli/B', 'permission', { id: requests[0].id, n: 0 }), /不属于/);
  assert.equal(dispatched.length, 1);
});

test('deferred Cursor project binding leaves native session opening to finishProject', async () => {
  for (const deferred of [true, false]) {
    const calls = [], events = [];
    class Connection {
      constructor(wsUrl) { this.wsUrl = wsUrl; }
      async connect() {}
      close() {}
      async evaluate(call) {
        if (call === 'workspaceTrustState()') return { required: false };
        if (call === 'activeThread()') return 'thread-A';
        if (call === 'hasComposer()') { calls.push('composer-ready'); return false; }
        throw Error(call);
      }
    }
    const context = vm.createContext({ NativeCdp: Connection, helpersCall: value => value,
      nativeWindow: () => ({ itemCache: new Map(), start: async () => {}, setThread() {} }),
      resetThinkingCaches() {}, appPlans: [], hasLaunched: () => false,
    });
    const open = vm.runInContext('({' + fragment(read('server/session.mjs'), '  async openBound(', '  navigationFailed(') + '}).openBound', context);
    const session = { detach() {}, clearViewState() {}, refreshViewport: async () => {},
      appMessage: value => value, projectName: () => 'Project', selectionKey: () => 'selection', currentRoots: async () => [{ root: '/Project' }],
      emit: value => events.push(value), withFocus: task => task(), setMode: async () => calls.push('mode'),
      prefetchMenus: async () => {}, adapter: { openAgent: async id => calls.push(['open', id]) } };
    await open.call(session, { id: 'cursor:window', app: 'cursor' }, 'ws', null,
      { windowId: 'cursor:window', threadId: 'thread-A', deferred });
    assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'open'), !deferred);
    assert.equal(calls.includes('composer-ready'), !deferred);
    assert.equal(session.bindingReady, !deferred);
    assert.equal(events.at(-1).ready, !deferred);
  }
});

test('an existing Codex writer opens its exact thread without the project-window navigation path', async () => {
  const calls = [], events = [];
  const context = vm.createContext({
    NativeCdp: class {
      constructor(wsUrl) { this.wsUrl = wsUrl; }
      async connect() {}
      close() {}
      async evaluate(expression) { return expression === 'workspaceTrustState()' ? { required: false } : 'visible-other-thread'; }
    },
    helpersCall: value => value, hasLaunched: () => true, resetThinkingCaches() {}, appPlans: [],
    nativeWindow: () => ({ itemCache: new Map(), start: async () => {}, setThread() {} }),
  });
  const open = vm.runInContext('({' + fragment(read('server/session.mjs'), '  async openBound(', '  navigationFailed(') + '}).openBound', context);
  const session = { detach() {}, clearViewState() {}, refreshViewport: async () => {}, withFocus: fn => fn(),
    appMessage: value => value, projectName: () => 'Target', selectionKey: () => 'selected', currentRoots: async () => [{ root: '/B' }], emit: value => events.push(value),
    selectCodexThread: async id => { calls.push(['select', id]); return true; },
    adoptCodexThread: async id => { calls.push(['adopt', id]); }, setMode: async () => calls.push('mode'), prefetchMenus: async () => {},
  };
  await open.call(session, { id: 'codex', app: 'codex' }, 'editor-writer', 'chat-writer', {
    windowId: 'writer', threadId: 'target', nativeOwner: { cwd: '/B' }, initial: true,
  });
  assert.deepEqual(calls, [['select', 'target'], ['adopt', 'target'], 'mode']);
  assert.equal(session.codexOwnerRoot, '/B'); assert.equal(session.bindingReady, true);
  assert.equal(events.at(-1).threadId, 'target'); assert.equal(events.at(-1).windowId, 'writer');
});

test('Cursor cold history opens from persisted headers, retains native menu metadata and excludes archived rows', async () => {
  const cold = { composerId: 'cold', name: 'Cold history', workspaceIdentifier: { id: 'workspace' } };
  const rows = [cold, { composerId: 'ordinary', name: 'Ordinary' }, { composerId: 'archived', isArchived: true }];
  const data = { allComposersData: { allComposers: [rows[1]] }, whenInitialComposerDataLoaded: async () => {},
    _storageService: { collectionQuery: async () => rows.map(row => JSON.stringify(row)) } };
  const workspace = { id: 'workspace', folders: [{ uri: { scheme: 'file', fsPath: '/same-project' } }] };
  const page = pageContext({ window: { __remoteAgentCursorServices: { data,
    composer: { composerChatService: { _workspaceContextService: { getWorkspace: () => workspace } } } } },
    agentList: () => [{ id: 'ordinary', group: 'Native group' }], activeThread: () => 'ordinary' });
  assert.equal(page.info('cursor', 'cold'), null);
  assert.equal((await page.info('cursor', 'cold', 'actions')).title, 'Cold history');
  const listed = JSON.parse(JSON.stringify(await page.info('cursor', '', 'list')));
  assert.deepEqual(listed.map(row => row.id), ['cold', 'ordinary']);
  assert.equal(listed[0].workspace, '/same-project'); assert.equal(listed[1].current, true);
  assert.equal(listed[1].group, 'Native group');
});

function projectAttachFixture(app, { catalogReady = true, targetOpen = false } = {}) {
  const calls = [], page = id => ({ id: app === 'codex' ? app : `${app}:${id}`, app, pageId: id,
    ws: `ws-${id}`, chatWs: `chat-${id}`, roots: [{ root: `/${id}` }] });
  const pages = [page('A'), ...(targetOpen ? [page('B')] : [])];
  const context = vm.createContext({ cdpRead: { getStore: () => null }, hasLaunched: () => false,
    lastSelection: () => null, CODEX_BACKEND: 'backend', CODEX_CDP_URL: 'native', helpersCall: value => value,
    codexBackend: { owns: id => id === 'backend-thread' }, nativeTargets: () => pages,
    nativeWindowAt: ws => ({ roots: catalogReady ? pages.find(row => row.ws === ws).roots : [] }),
    orderedProjectWindows: (_app, rows) => rows,
    AGENT_REGISTRY: { [app]: { discover: async () => pages, adapter: {
      backendThread: (id, host) => !host && !id.startsWith('fusion-'),
      attachBackend: async function (req) {
        calls.push({ kind: 'backend', thread: req.threadId, root: req.project?.root });
        this.cdp = null; this.app = app;
      },
    } } },
  });
  const attach = vm.runInContext('({' + fragment(read('server/session.mjs'), '  async attach(', '  async openBound(') + '}).attach', context);
  const session = { app, cdp: null, threadId: '', windowId: '', attach,
    projectMatches: (roots, root) => roots.some(row => row.root === root),
    async openBound(_win, _editor, _chat, selection) {
      calls.push({ kind: 'desktop', window: selection.windowId, thread: selection.threadId, deferred: selection.deferred });
      this.app = app; this.cdp = {}; this.windowId = selection.windowId;
    },
    async useProject(root, newSession, thread, title, ownerWindow) {
      calls.push({ kind: 'project', root, newSession, thread, ownerWindow });
    },
  };
  return { session, calls };
}

test('project attachment and cold reconnect preserve the target using the native backend or desktop carrier', async () => {
  for (const app of ['codex', 'cursor', 'devin']) for (const initial of [false, true]) {
    const { session, calls } = projectAttachFixture(app, { catalogReady: !initial });
    const windowId = app === 'codex' ? 'B' : `${app}:B`;
    await session.attach({ id: app, windowId, threadId: 'native-B', project: { root: '/B' }, initial });
    assert.deepEqual(calls, app === 'codex' ? [{ kind: 'backend', thread: 'native-B', root: '/B' }] : [
      { kind: 'desktop', window: app === 'codex' ? 'A' : `${app}:A`, thread: '', deferred: true },
      { kind: 'project', root: '/B', newSession: false, thread: 'native-B', ownerWindow: windowId },
    ], `${app}: initial=${initial}`);
  }
});

test('Codex legacy threads use the backend even when the old project window is open', async () => {
  const { session, calls } = projectAttachFixture('codex', { targetOpen: true });
  await session.attach({ id: 'codex', windowId: 'B', threadId: 'native-B', project: { root: '/B' } });
  assert.deepEqual(calls, [{ kind: 'backend', thread: 'native-B', root: '/B' }]);
});

test('resolved native writer attachment bypasses backend recursion and keeps its window on initial reconnect', async () => {
  const { session, calls } = projectAttachFixture('codex', { targetOpen: true });
  await session.attach({ id: 'codex', windowId: 'B', threadId: 'native-B', nativeOwner: { cwd: '/other-project' }, initial: true });
  assert.deepEqual(calls, [{ kind: 'desktop', window: 'B', thread: 'native-B', deferred: false }]);
});

test('Codex default project entry and owned background threads still use the backend', async () => {
  for (const selected of [{}, { windowId: 'backend', threadId: 'native-B' }, { windowId: 'old-window', threadId: 'backend-thread' }]) {
    const { session, calls } = projectAttachFixture('codex');
    await session.attach({ id: 'codex', project: { root: '/B' }, ...selected });
    assert.deepEqual(calls, [{ kind: 'backend', root: '/B', thread: selected.threadId }]);
  }
});

test('live reconnect keeps Cursor and Devin bindings while Codex legacy threads move to their backend', async () => {
  for (const app of ['codex', 'cursor', 'devin']) {
    const { session, calls } = projectAttachFixture(app);
    Object.assign(session, { bindingReady: true, windowId: 'A', threadId: 'native-A',
      cdp: { ws: { readyState: 1 }, evaluate: async () => 'native-A' },
      connectionMessages: new Map([['attached', { t: 'attached', threadId: 'native-A' }]]),
      emit: message => calls.push(message), setMode: async () => calls.push('mode') });
    await session.attach({ id: app, windowId: 'A', threadId: 'native-A', project: { root: '/A' }, resume: true, initial: true });
    if (app === 'codex') { assert.deepEqual(calls, [{ kind: 'backend', thread: 'native-A', root: '/A' }]); continue; }
    assert.equal(calls.length, 2); assert.equal(calls[0].threadId, 'native-A');
    assert.equal(calls[0].ready, true); assert.equal(calls[1], 'mode');
  }
});

test('a Codex Fusion project still connects its original desktop binding', async () => {
  const { session, calls } = projectAttachFixture('codex', { targetOpen: true });
  await session.attach({ id: 'codex', windowId: 'B', threadId: 'fusion-main', project: { root: '/B' } });
  assert.deepEqual(calls, [{ kind: 'desktop', window: 'B', thread: 'fusion-main', deferred: false }]);
});

test('Codex project and session-menu entries share the backend binding for legacy threads', async () => {
  const { methods } = await import('../server/agent/projects.mjs');
  const calls = [], session = { app: 'codex',
    adapter: { backendThread: () => true, attachBackend: async req => calls.push(req) } };
  await methods.openAgent.call(session, 'thread:closed-window:legacy');
  assert.equal(calls[0].threadId, 'legacy');
  await methods.useProject.call(session, process.cwd(), false, 'legacy');
  assert.equal(calls[1].threadId, 'legacy'); assert.equal(calls[1].project.root, process.cwd());
});

test('Cursor context and catalog agree on a cold thread project in another window', async () => {
  const uri = root => ({ scheme: 'file', fsPath: root });
  const headers = [{ composerId: 'B', workspaceIdentifier: { uri: uri('/B') } },
    { composerId: 'unknown', workspaceIdentifier: { id: 'unloaded-workspace' } }];
  const loaded = { composerId: 'B' }, workspace = { id: 'A-workspace', folders: [{ uri: uri('/A') }] };
  const data = { allComposersData: { allComposers: [loaded] }, whenInitialComposerDataLoaded: async () => {},
    getComposerHandleById: async id => ({ data: { composerId: id } }),
    _storageService: { collectionQuery: async () => headers.map(row => JSON.stringify(row)) } };
  const page = pageContext({ activeThread: () => 'A', window: { __remoteAgentCursorServices: { data,
    composer: { composerChatService: { _workspaceContextService: { getWorkspace: () => workspace } } } } } });
  const catalog = await page.info('cursor', [], true);
  const context = await page.info('cursor', 'B', 'context');
  assert.equal(catalog.rows.find(row => row.id === 'B').workspace, '/B');
  assert.equal(context.cwd, '/B');
  assert.equal((await page.info('cursor', 'A', 'context')).cwd, '/A');
  await assert.rejects(page.info('cursor', 'unknown', 'context'), /项目目录/);
  await assert.rejects(page.info('cursor', 'missing', 'context'), /项目目录/);
});

function sessionProjectMethods() {
  const source = read('server/agent/projects.mjs');
  return vm.runInContext('({' + fragment(source, '  async currentRoots() {', '  projectRows(')
    + fragment(source, '  projectName() {', '  publishThread(')
    + fragment(source, '  async newProjectChat() {', '  async confirmProjectTrust(') + '})',
    createPageContext({ path, normPath: value => value }));
}

test('desktop Codex and Cursor project labels, files and new-chat target follow the selected thread rather than its carrier', async () => {
  for (const [app, adapter] of [['codex', codexAdapter], ['cursor', cursorAdapter]]) {
    const methods = sessionProjectMethods(), created = [];
    const session = { ...methods, app, adapter, winTitle: 'CWM', threadId: 'thread',
      selectionKey() { return app + '|' + this.threadId; },
      cdp: { evaluate: async expression => {
        assert(expression.endsWith(`.nativeSessionInfo('${app}', "thread", 'context')`));
        return { cwd: '/remote-agent', host: '', roots: [{ root: '/remote-agent', host: '' }] };
      } },
      editorCdp: { evaluate: async () => { throw Error('window project must not be used'); } },
      useProject: async (...args) => created.push(args),
    };
    assert.equal((await session.currentRoots())[0].root, '/remote-agent');
    assert.equal(session.projectName(), 'remote-agent');
    await session.newProjectChat();
    assert.deepEqual(created, [['/remote-agent', true]]);
  }
});

test('a delayed A project read cannot overwrite B identity, including after returning to an empty view', async () => {
  const methods = sessionProjectMethods(); let finishA;
  const session = { ...methods, app: 'cursor', threadId: 'A', winTitle: 'old-window',
    selectionKey() { return this.threadId; }, adapter: { currentRoots() { return this.threadId === 'A'
      ? new Promise(resolve => { finishA = resolve; }) : Promise.resolve([{ root: '/B' }]); } },
  };
  const pending = session.currentRoots(); session.threadId = 'B'; await session.currentRoots();
  finishA([{ root: '/A' }]); await pending;
  assert.equal(session.projectName(), 'B');
  session.threadId = ''; assert.equal(session.projectName(), '');
});

test('Devin and OpenCode preserve their native project while their carrier title belongs elsewhere', async () => {
  const methods = sessionProjectMethods();
  for (const app of ['devin', 'opencode']) {
    const session = { ...methods, app, winTitle: 'CWM', threadId: 'thread', selectionKey: () => app + '|thread',
      sessionCwd: '/old', adapter: { currentRoots: async () => [{ root: '/remote-agent' }] } };
    await session.currentRoots(); assert.equal(session.projectName(), 'remote-agent');
    if (app === 'devin') { session.sessionCwd = '/native-changed'; assert.equal(session.projectName(), 'native-changed'); }
  }
});

test('cross-project creation verifies the carrier workspace before creating and reads the new thread afterwards', async () => {
  const calls = [], context = createPageContext({ path, helpersCall: value => value, fusionProject: root => ({ id: root }),
    editorRoots: async () => { calls.push('carrier-B'); return [{ root: '/B' }]; } });
  const methods = vm.runInContext('({' + fragment(read('server/agent/projects.mjs'), '  async finishProject() {', '  projectName() {') + '})', context);
  const session = { ...methods, app: 'cursor', pendingProject: { root: '/B', newSession: true }, threadId: 'A',
    editorCdp: { evaluate: async () => ({ required: false }) },
    cdp: { evaluate: async expression => expression === 'hasComposer()' ? true : { thread: 'B', items: [] } },
    waitFor: async () => ({ thread: 'A' }),
    adapter: { newChat: async () => { calls.push('create-B'); } }, syncSession() {},
    currentRoots: async function () { calls.push('thread-' + this.threadId); return [{ root: '/' + this.threadId }]; },
    publishThread() { calls.push('publish-' + this.threadId); }, selectionKey: () => 'B', emit() {},
  };
  await session.finishProject();
  assert.deepEqual(calls, ['carrier-B', 'create-B', 'thread-B', 'publish-B', 'thread-B']);
  assert.equal(session.bindingReady, true);
});


test('Devin cold native connection initializes its module once and reload resets initialization', async () => {
  for (const app of ['devin', 'cursor', 'codex']) {
    const source = new NativeWindow('ws://fixture-' + app); source.app = app;
    const calls = [];
    source.cdp.connect = async () => calls.push('connect');
    source.cdp.evaluate = async expression => { assert.match(expression, /import\('@exa\/chat-client'\)/); calls.push('native-api'); };
    await Promise.all([source.connect(), source.connect()]);
    assert.deepEqual(calls, app === 'devin' ? ['connect', 'native-api'] : ['connect']);
    source.cdp.handlers.get('Runtime.executionContextsCleared')();
    await source.connect();
    assert.equal(calls.filter(call => call === 'native-api').length, app === 'devin' ? 2 : 0);
  }
});
