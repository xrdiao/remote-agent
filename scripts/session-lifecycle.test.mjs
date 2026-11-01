import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

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
