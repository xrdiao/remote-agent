import test from 'node:test';
import { localFilePath, samePath } from '../lib/platform.mjs';
import { parseAgentRef } from '../lib/shared-rules.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexClient } from '../server/codex/client.mjs';
import { CodexState, codexBackend } from '../server/codex/state.mjs';
import { Session } from '../server/session.mjs';
import { generatedImageSource, readCodexImage } from '../server/codex/images.mjs';
import { adapter as codexAdapter } from '../server/apps/codex.mjs';
import { resolveRoute } from '../server/routes.mjs';
import { cdpRead, awaitCdpRead } from '../server/cdp.mjs';
import { currentOperation, withOperation } from '../server/operations.mjs';
import { watchChatUpdates } from '../server/agent/updates.mjs';
import vm from 'node:vm';
import path from 'node:path';
import fs from 'node:fs';
import { read, fragment, createPageContext } from './page-fixture.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('phone commands share a per-thread FIFO without selecting a primary phone', async () => {
  const { state } = fixture(), events = [];
  let release;
  const first = state.runCommand('A', async () => { events.push('phone-1'); await new Promise(resolve => { release = resolve; }); return 'one'; });
  const second = state.runCommand('A', async () => { events.push('phone-2'); return 'two'; });
  const other = state.runCommand('B', async () => { events.push('other-thread'); });
  await other;
  assert.deepEqual(events, ['phone-1', 'other-thread']);
  release(); assert.deepEqual(await Promise.all([first, second]), ['one', 'two']);
  assert.deepEqual(events, ['phone-1', 'other-thread', 'phone-2']); assert.equal(state.commands.size, 0);
});

test('a failed phone operation is reported once and does not block the next phone', async () => {
  const { state } = fixture(), events = [];
  const first = state.runCommand('A', () => { events.push('first'); throw new Error('rejected'); });
  const second = state.runCommand('A', () => { events.push('second'); return 'accepted'; });
  await assert.rejects(first, /rejected/); assert.equal(await second, 'accepted');
  assert.deepEqual(events, ['first', 'second']); assert.equal(state.commands.size, 0);
});

test('queued phone commands retain their request context and cannot follow an A/B switch', async () => {
  const events = []; let release;
  const phone = name => ({ app: 'codex', threadId: 'phone-order-test', windowId: 'backend',
    handleSelected: async message => { events.push([name, message.t, currentOperation()?.requestId]); if (name === 'one') await new Promise(resolve => { release = resolve; }); } });
  const one = phone('one'), two = phone('two');
  const first = withOperation({ requestId: 'first' }, () => Session.prototype.handle.call(one, { t: 'send' }));
  const second = withOperation({ requestId: 'second' }, () => Session.prototype.handle.call(two, { t: 'send' }));
  await tick(); assert.deepEqual(events, [['one', 'send', 'first']]);
  await Session.prototype.handle.call(two, { t: 'send', submit: false });
  assert.deepEqual(events.at(-1), ['two', 'send', undefined]);
  two.threadId = 'different-thread'; release(); await first;
  await assert.rejects(second, /会话已切换/); assert.equal(codexBackend.commands.size, 0);
});

test('writer lookup waits for a pending background release before choosing the write route', async () => {
  const id = 'release-order-test'; let release;
  codexBackend.writers.add(id);
  codexBackend.releasing.set(id, { promise: new Promise(resolve => { release = resolve; }) });
  let settled = false;
  try {
    const owner = codexAdapter.backendOwner(id).then(value => { settled = true; return value; });
    await tick(); assert.equal(settled, false);
    release(); assert.equal(await owner, null);
  } finally { codexBackend.releasing.delete(id); codexBackend.writers.delete(id); }
});

test('native writer discovery includes loaded threads outside the visible view and IPC followers', async () => {
  for (const [role, loaded, cached] of [[undefined, true, false], ['follower', false, true], ['owner', true, true], [undefined, false, true]]) {
    const calls = [], manager = {
      getStreamRole: () => role ? { role } : undefined,
      getConversation: () => cached ? { cwd: '/target-project' } : undefined,
      async sendRequest(method, params) {
        calls.push({ method, params });
        return method === 'thread/loaded/list' ? { data: loaded ? ['target'] : [] } : { thread: { cwd: '/target-project' } };
      },
    };
    const source = fragment(read('server/page/session-actions.js'), '  const nativeSessionInfo =', '  const nativeSessionAction =');
    const info = vm.runInContext(source + '\nnativeSessionInfo;', createPageContext({
      codexConversationManager: () => manager, codexHistoryScopes: () => [], nativeValue: value => value, localFilePath,
    }));
    const result = await info('codex', 'target', 'connection');
    if (!role && !loaded) assert.equal(result, null);
    else { assert.equal(result.cwd, '/target-project'); assert.equal(result.role, role); assert.equal(result.loaded, loaded); }
    assert.equal(calls[0].method, 'thread/loaded/list');
    if (!cached) assert.equal(calls[1].params.threadId, 'target');
  }
});

test('Codex creation releases its idle native writer; reading does not resume it', async () => {
  const { state, client } = fixture();
  const thread = await state.create('/A');
  assert.equal(state.hasWriter(thread.id), false);
  assert.equal(client.sent.find(row => row.method === 'thread/start').params.config.thread_unload_delay_secs, 0);
  client.sent.length = 0;
  await state.read(thread.id); await state.readChat(thread.id);
  assert.equal(client.sent.some(row => row.method === 'thread/resume'), false);
  assert.equal(state.hasWriter(thread.id), false);
});

test('Codex reconnects a read-only view without restoring its native writer', async () => {
  const { state, client } = fixture(), thread = await state.create('/read-reconnect');
  client.emit('disconnected', new Error('temporary exit'));
  assert.ok(state.chat(thread.id).items.some(row => /后台中断/.test(row.t)));
  await state.read(thread.id);
  assert.equal(state.hasWriter(thread.id), false);
  assert.equal(state.chat(thread.id).items.some(row => /后台中断/.test(row.t)), false);
});

test('Codex retains active turns, questions and queued work, releasing only after native close', async () => {
  const { state, client } = fixture(), thread = await state.create('/A');
  await state.send(thread.id, [{ type: 'text', text: 'work' }], '', 'work');
  assert.equal(state.hasWriter(thread.id), true);
  const request = { id: 7, method: 'item/tool/requestUserInput', params: { threadId: thread.id, turnId: 'turn', questions: [{ id: 'q', question: '?', options: [] }] } };
  client.emit('request', request);
  await state.releaseIdle(thread.id); assert.equal(state.hasWriter(thread.id), true);
  state.answer(thread.id, state.requestRows(thread.id)[0].id, 0);
  assert.deepEqual(client.sent.find(row => row.id === 7).result, { answers: { q: { answers: [] } } });
  state.queues.set(thread.id, [{ id: 'queue' }]);
  client.emit('notification', { method: 'turn/completed', params: { threadId: thread.id, turn: { id: 'turn', status: 'completed', items: [] } } });
  await tick(); assert.equal(state.hasWriter(thread.id), true);
  state.queues.set(thread.id, []);
  const release = state.releaseIdle(thread.id);
  assert.equal(state.hasWriter(thread.id), true, 'unsubscribe response alone is not a released writer');
  await release; assert.equal(state.hasWriter(thread.id), false);
});

test('Codex image generation supports native saved files, inline results and file IDs in streamed/history items', async () => {
  const { state } = fixture(), thread = await state.create('/images');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
  assert.equal(generatedImageSource({ status: 'completed', result: png }), 'data:image/png;base64,' + png);
  assert.equal(generatedImageSource({ status: 'completed', result: '', fileId: 'file-1' }), 'codex-file:file-1');
  assert.equal(generatedImageSource({ status: 'inProgress', result: png }), null);
  thread.turns.push({ id: 'images', status: 'completed', items: [
    { id: 'pending', type: 'imageGeneration', status: 'inProgress' },
    { id: 'saved', type: 'imageGeneration', status: 'completed', savedPath: '/images/out.png', fileId: 'file-1' },
    { id: 'failed', type: 'imageGeneration', status: 'failed', failure: { type: 'usageLimitExceeded' } },
  ] });
  const rows = state.chat(thread.id).items;
  assert.equal(rows[0].live, true);
  assert.equal(rows[1].k, 'assistant'); assert.deepEqual(rows[1].images, ['/images/out.png']);
  assert.match(rows[2].t, /usageLimitExceeded/);
});

test('Codex file-ID image download uses native login only for URL resolution and keeps credentials off the image host', async () => {
  const calls = [], bytes = Buffer.from('image');
  const result = await readCodexImage('file / 1', { readAuth: async () => JSON.stringify({ tokens: { access_token: 'private', account_id: 'account' } }),
    request: async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1 ? { ok: true, json: async () => ({ download_url: 'https://images.example/signed' }) }
        : { ok: true, headers: new Headers({ 'content-type': 'image/png' }), arrayBuffer: async () => bytes };
    } });
  assert.equal(result, 'data:image/png;base64,' + bytes.toString('base64'));
  assert.match(calls[0].url, /file%20%2F%201$/); assert.equal(calls[0].options.headers.authorization, 'Bearer private');
  assert.equal(calls[1].options, undefined);
});

function backendRoutesFor(extra) {
  return vm.runInContext(fragment(read('server/apps/codex.mjs'), 'function backendCommands(', 'async function syncCodexCatalog(')
    + fragment(read('server/apps/codex.mjs'), 'const backendRoutes =', 'function serializedCodexPrompt') + '\nbackendRoutes;', createPageContext({ path, localFilePath, samePath, parseAgentRef, awaitCdpRead, backendDraftSource: () => null, ...extra }));
}

test('backend compact dispatches its native protocol without creating a user turn', async () => {
  const { state, client } = fixture(null), thread = await state.create('/compact');
  const events = [], routes = backendRoutesFor({ codexBackend: state, backendSkills: async () => [] });
  const session = { threadId: thread.id, selectionKey: () => 'compact', emit: event => events.push(event) };
  await routes.codexPick.call(session, { section: 'commands', key: 'compact' });
  assert.deepEqual(client.sent.filter(row => row.method === 'thread/compact/start').map(row => row.params), [{ threadId: thread.id }]);
  assert.equal(client.sent.some(row => row.method === 'turn/start'), false);
});

test('backend draft is shared by thread across entry connections and rejects an old input epoch', async () => {
  const { state } = fixture(null), routes = backendRoutesFor({ codexBackend: state });
  const events = [], session = (thread, epoch) => ({ threadId: thread, draftEpoch: epoch, draftGeneration: 0,
    selectionKey: () => thread, emit: event => events.push(event) });
  const a = session('A', 'first');
  await routes.draft.call(a, { text: 'phone edit', draftEpoch: 'first', revision: 1 });
  await routes.draft.call(session('A', 'second'), { draftEpoch: 'second', revision: 2 });
  assert.equal(events.at(-1).text, 'phone edit');
  await routes.draft.call(a, { text: 'late edit', draftEpoch: 'old', revision: 0 });
  assert.equal(state.draft('A'), 'phone edit'); assert.equal(state.draft('B'), '');
  await routes.draft.call(a, { text: '', draftEpoch: 'first', revision: 3 });
  assert.equal(state.draft('A'), ''); assert.equal(events.at(-1).read, false);
});

test('draft-only changes notify other entries without retransmitting the conversation body', () => {
  const { state } = fixture(null), events = [], bodies = [];
  state.subscribe('A', () => bodies.push('chat'));
  const publish = vm.runInNewContext(fragment(read('server/apps/codex.mjs'), 'function backendPublishDraft(', 'function backendDraftSource(')
    + 'backendPublishDraft;', { codexBackend: state });
  const session = { threadId: 'A', selectionKey: () => 'A', emit: event => events.push(event) };
  state.on('draftChanged', id => { if (id === session.threadId) publish(session); });
  state.draft('A', 'shared draft'); state.draft('A', 'shared draft'); state.draft('B', 'other');
  assert.equal(events.length, 1); assert.equal(events[0].t, 'draft'); assert.equal(events[0].text, 'shared draft');
  assert.equal(bodies.length, 0);
});

test('backend submission accepts the next draft epoch and keeps rejecting delayed pre-send edits', async () => {
  const { state, client } = fixture(null); await state.create('/A');
  const events = [], routes = backendRoutesFor({ codexBackend: state });
  const context = createPageContext({ codexBackend: state, cdpRead, pendingUploads: () => [],
    uploadAttachments: () => [], currentOperation: () => null, rememberSessionMessage() {}, backendPublish() {} });
  const send = vm.runInContext('({' + fragment(read('server/apps/codex.mjs'), '  async sendBackendMessage(', '  async newChat(') + '}).sendBackendMessage', context);
  const session = { threadId: '/A', draftEpoch: '', draftGeneration: 0, selectionKey: () => '/A', emit: event => events.push(event) };
  await routes.draft.call(session, { text: 'first message', draftEpoch: '', revision: 1 });
  await send.call(session, 'first message', true, '', [], { requestId: 'sent-epoch', draftEpoch: 'sent-epoch' });
  assert.equal(client.sent.filter(row => row.method === 'turn/start').length, 1);
  assert.equal(state.draft('/A'), ''); assert.equal(session.draftEpoch, 'sent-epoch');
  await routes.draft.call(session, { text: 'next message', draftEpoch: 'sent-epoch', revision: 2 });
  assert.equal(state.draft('/A'), 'next message');
  assert.equal(events.at(-1).t, 'draftAck'); assert.equal(events.at(-1).draftEpoch, 'sent-epoch');
  const count = events.length;
  await routes.draft.call(session, { text: 'delayed old edit', draftEpoch: '', revision: 1 });
  assert.equal(state.draft('/A'), 'next message'); assert.equal(events.length, count);
  assert.equal(state.draft('/B'), '');
});

test('backend draft subscriptions are removed on leaving a conversation and do not accumulate on reopening', async () => {
  const { state } = fixture(null); await state.create('/A');
  let updates = 0;
  const setMode = vm.runInNewContext('({' + fragment(read('server/apps/codex.mjs'), '  async setBackendMode(', '  async syncBackendDraft(')
    + '}).setBackendMode;', { codexBackend: state, awaitCdpRead, nativeTargets: () => [], backendPublish() {},
    backendPublishDraft: () => updates++, watchChatUpdates: (session, subscribe) => subscribe(() => {}) });
  const session = { threadId: '/A', visible: true, emit() {}, adapter: { syncBackendDraft: async () => {} } };
  for (let n = 0; n < 3; n++) {
    await setMode.call(session); assert.equal(state.listenerCount('draftChanged'), 1);
    state.draft('/A', 'draft ' + n); assert.equal(updates, n + 1);
    session.chatUpdatesStop(); assert.equal(state.listenerCount('draftChanged'), 0); assert.equal(state.listenerCount('changed'), 0);
  }
});

test('backend viewers receive retained desktop questions and release their scoped subscriptions on leaving', async () => {
  const { state } = fixture(null); await state.create('/questions');
  const requests = [{ id: 'async:retained', text: 'Still waiting', buttons: [{ label: 'One' }, { label: 'Skip' }, { label: 'Send' }], fields: [] }];
  const view = { snapshot: { chat: { questions: { codex: true, requests } } } };
  const callbacks = [], closed = [], published = [];
  const source = {
    subscribe(fn, context) { callbacks.push({ fn, context }); return () => closed.push(context?.threadId || 'draft'); },
    conversationView(context) { assert.equal(context.threadId, '/questions'); return view; },
    readConversation: async () => view.snapshot,
    async composerCall(call, context) { assert.equal(context.threadId, '/questions'); assert(call.startsWith('codexRequestAction(')); view.snapshot.chat.questions.requests = []; callbacks.find(row => row.context)?.fn(); return true; },
  };
  const context = createPageContext({ codexBackend: state, awaitCdpRead, nativeTargets: () => [{ app: 'codex', ws: 'native' }],
    nativeWindowAt: () => source, watchChatUpdates: (_session, subscribe) => subscribe(() => {}),
    backendPublishDraft() {}, backendPublish: session => published.push([...session.codexNativeQuestions.values()].flatMap(row => row.requests)),
  });
  const methods = vm.runInContext('({' + fragment(read('server/apps/codex.mjs'), '  async setBackendMode(', '  async syncBackendDraft(')
    + fragment(read('server/apps/codex.mjs'), '  async codexRequest(', '  async queue(') + '})', context);
  const session = { threadId: '/questions', codexDirectory: '/questions', visible: true, selectionKey: () => 'questions', emit() {}, adapter: { syncBackendDraft: async () => {} } };
  await methods.setBackendMode.call(session); await tick();
  assert.equal(session.codexNativeQuestions.get(source).requests[0].id, 'async:retained');
  await methods.codexRequest.call(session, { id: 'async:retained', n: 0, fields: [] });
  assert.equal(published.at(-1).length, 0);
  await assert.rejects(methods.codexRequest.call(session, { id: 'async:other-thread', n: 0 }), /不属于当前会话/);
  session.chatUpdatesStop(); assert.deepEqual(closed, ['draft', '/questions']); assert.equal(session.codexNativeQuestions.size, 0);
});

test('desktop transcript changes refresh a released backend view without claiming its writer', async () => {
  const { state, client } = fixture(), thread = await state.create('/desktop-updates');
  const desktop = structuredClone(thread), request = client.request;
  client.request = async (method, params) => method === 'thread/read' ? { thread: structuredClone(desktop) } : request(method, params);
  let changed;
  const source = { subscribe(fn, context) { if (context) changed = fn; return () => {}; },
    readConversation: async () => ({}), conversationView: () => ({ snapshot: { chat: { questions: { requests: [] } } } }) };
  const context = createPageContext({ codexBackend: state, awaitCdpRead, nativeTargets: () => [{ app: 'codex', ws: 'native' }],
    nativeWindowAt: () => source, watchChatUpdates: (_session, subscribe) => subscribe(() => {}), backendPublish() {} });
  const setMode = vm.runInContext('({' + fragment(read('server/apps/codex.mjs'), '  async setBackendMode(', '  async syncBackendDraft(') + '}).setBackendMode;', context);
  const session = { threadId: thread.id, visible: true, adapter: { syncBackendDraft: async () => {} }, emit() {} };
  await setMode.call(session); await tick();
  desktop.turns.push({ id: 'desktop-turn', status: 'completed', items: [{ id: 'desktop-answer', type: 'agentMessage', text: 'new desktop answer' }] });
  changed(); await tick();
  assert.equal(state.chat(thread.id).items.at(-1).t, 'new desktop answer');
  assert.equal(state.hasWriter(thread.id), false);
  assert.equal(client.sent.some(row => row.method === 'thread/resume'), false);
  session.chatUpdatesStop();
});

test('backend chat combines native RPC and retained desktop questions without duplicate request identities', async () => {
  const chat = { questions: { codex: true, requests: [{ id: 'same', text: 'native' }] }, busy: false, run: { id: 'turn-A', status: 'stopped' } }, sent = [], statuses = [];
  const requests = [{ id: 'same', text: 'duplicate' }, { id: 'async:folded', text: 'question' }];
  const source = { conversations: new Map([['A', { at: 1, snapshot: { chat: { thread: 'A', questions: { requests } } } }]]), overviewStates: () => [] };
  const context = createPageContext({ codexBackend: { threads: new Map([['A', {}]]), chat: () => structuredClone(chat) },
    nativeTargets: () => [{ app: 'codex', ws: 'native' }], nativeWindowAt: () => source, backendPublishDraft() {}, rememberSessionStatuses: rows => statuses.push(...rows) });
  const publish = vm.runInContext(fragment(read('server/apps/codex.mjs'), 'function backendQuestionState(', 'function backendPublishDraft(') + 'backendPublish;', context);
  publish({ threadId: 'A', selectionKey: () => 'A', emit: message => sent.push(message) });
  assert.deepEqual(Array.from(sent[0].chat.questions.requests, row => row.id), ['same', 'async:folded']);
  assert.equal(sent[0].chat.questions.requests[0].text, 'native');
  assert.equal(sent[0].chat.waiting, 'approval');
  assert.equal(statuses[0].threadId, 'A'); assert.equal(statuses[0].waiting, 'approval');
  assert.equal(statuses[0].run.status, 'stopped');
});

test('backend first screen grows to sixty items, keeps lazy tools and preserves history pagination', async () => {
  const { state } = fixture(null), thread = await state.create('/first-screen');
  thread.turns = [{ id: 'turn', startedAt: 10, completedAt: 20, status: 'completed', items: Array.from({ length: 90 }, (_, n) =>
    n % 2 ? { id: 'item-' + n, type: 'commandExecution', command: 'echo sample', aggregatedOutput: 'large output' }
      : { id: 'item-' + n, type: 'agentMessage', text: 'message-' + n }) }];
  const chat = state.chat(thread.id, undefined, undefined, new Set());
  assert.equal(chat.items.length, 60); assert.equal(chat.items[0].i, 'item-30'); assert.equal(chat.earlier, true);
  assert(chat.items.filter(item => item.k === 'tool').every(item => item.lazy && !item.details && item.output === undefined));
  assert.equal(state.chat(thread.id, 220).items.length, 90);
  assert.deepEqual(state.states()[0].run, chat.run); assert.equal(chat.run.status, 'completed');
});

test('backend overview and body share pending questions, clear fresh answers and isolate thread and host', () => {
  const request = { id: 'async:A', text: 'Question A' };
  const source = { conversations: new Map([
    ['A', { at: 10, snapshot: { chat: { thread: 'A', questions: { requests: [request] } }, state: { host: '' } } }],
    ['B', { at: 10, snapshot: { chat: { thread: 'B', questions: { requests: [{ id: 'async:B' }] } } } }],
    ['ssh', { at: 30, snapshot: { chat: { thread: 'A', questions: { requests: [{ id: 'foreign' }] } }, state: { host: 'ssh' } } }],
  ]), overviewStates: () => [] };
  const context = createPageContext({ nativeTargets: () => [{ app: 'codex', ws: 'native' }], nativeWindowAt: () => source });
  const facts = vm.runInContext(fragment(read('server/apps/codex.mjs'), 'function backendQuestionState(', 'function backendPublish(') + 'backendQuestionState;', context);
  assert.deepEqual(Array.from(facts('A').requests, row => row.id), ['async:A']);
  assert.equal(facts('A').waiting, 'approval'); assert.equal(facts('A').waitingText, 'Question A');
  source.conversations.set('A', { at: 40, snapshot: { chat: { thread: 'A', questions: { requests: [] } } } });
  assert.equal(facts('A').waiting, ''); assert.equal(facts('B').waiting, 'approval');
  source.conversations.delete('A');
  source.overviewStates = () => [{ thread: 'A', host: '', waiting: 'native-question', waitingText: 'still pending', run: { status: 'stopped' } }];
  assert.equal(facts('A').waiting, 'approval'); assert.equal(facts('A').waitingText, 'still pending');
  source.overviewStates = () => [];
  assert.equal(facts('A').waiting, '');
});

test('a desktop draft read finishing after a phone write or thread switch cannot overwrite the shared draft', async () => {
  const drafts = new Map(), selected = { id: 'A' };
  let finish;
  const context = createPageContext({ backendDraftSource: () => ({ composerCall: () => new Promise(resolve => { finish = resolve; }) }),
    codexBackend: { nativeDrafts: new Map(), draft: (id, text) => drafts.set(id, text) } });
  const sync = vm.runInContext('({' + fragment(read('server/apps/codex.mjs'), '  async syncBackendDraft(', '  async sendBackendMessage(') + '}).syncBackendDraft', context);
  const session = { threadId: 'A', draftGeneration: 1, selectionKey: () => selected.id };
  const old = sync.call(session); session.draftGeneration++; drafts.set('A', 'new phone'); finish({prompt:'old desktop',draftEditedAt:0}); await old;
  assert.equal(drafts.get('A'), 'new phone');
  const other = sync.call(session); selected.id = 'B'; finish({prompt:'other desktop',draftEditedAt:0}); await other;
  assert.equal(drafts.get('A'), 'new phone'); assert.equal(drafts.has('B'), false);
});

test('the first desktop observation gives priority to the genuinely newer draft', async () => {
  const { state } = fixture(null);
  let native = '', editedAt = 200;
  const writes = [], source = { composerCall: async call => {
    if (call.includes("'composer'")) return { prompt: native, draftEditedAt: editedAt };
    const value = JSON.parse(call.slice(call.indexOf("'draft', ") + 9, -1)); writes.push(value);
    native = value.text; return native;
  } };
  const text = read('server/apps/codex.mjs'), context = createPageContext({ codexBackend: state, backendDraftSource: () => source });
  const sync = vm.runInContext(fragment(text, 'function recordBackendNativeDraft(', 'function backendCommands(')
    + '({' + fragment(text, '  async syncBackendDraft(', '  async sendBackendMessage(') + '}).syncBackendDraft', context);
  const session = { threadId: 'A', draftGeneration: 1, selectionKey: () => 'A' };
  state.draft('A', 'phone while desktop hidden', 300);
  await sync.call(session);
  assert.equal(native, 'phone while desktop hidden'); assert.equal(writes.length, 1);
  state.nativeDrafts.delete('A'); state.draft('A', 'old phone', 100); native = 'new desktop';
  await sync.call(session); assert.equal(state.draft('A'), 'new desktop'); assert.equal(writes.length, 1);
});

test('a stale tool expansion is rejected before invoking the native handler', async () => {
  const calls = [], session = { app: 'codex', codexBackend: false, adapter: codexAdapter,
    selectionKey: () => 'A', pollChat: async force => calls.push(force) };
  const route = resolveRoute(session, 'toolDetails');
  await route.run(session, { sel: 'old-A', i: 'tool', open: true });
  assert.equal(calls.length, 0);
});

test('backend tool expansion sends only selected details, retains diffs and ignores a previous session request', async () => {
  const { state } = fixture(null), thread = await state.create('/A');
  const output = 'native output\n'.repeat(5000);
  thread.turns = [{ id: 'turn', startedAt: 1, completedAt: 2, status: 'completed', items: [
    { id: 'command', type: 'commandExecution', command: 'run command', aggregatedOutput: output, status: 'completed', exitCode: 0 },
    { id: 'edit', type: 'fileChange', status: 'completed', changes: [{ path: '/A/file.txt', diff: '-old\n+new' }] },
  ] }];
  const events = [], routes = backendRoutesFor({ codexBackend: state, backendPublish: s => {
    events.push(state.chat(s.threadId, 40, undefined, s.expandedTools));
  } });
  const session = { codexBackend: true, threadId: thread.id, expandedTools: new Set(), selectionKey: () => 'A' };
  const initial = state.chat(thread.id, 40, undefined, session.expandedTools);
  assert.equal(initial.items[0].output, undefined); assert.equal(initial.items[1].diff, undefined);
  assert(JSON.stringify(initial).length < 2500);
  await routes.toolDetails.call(session, { sel: 'B', i: 'command', open: true });
  assert.equal(events.length, 0);
  await routes.toolDetails.call(session, { sel: 'A', i: 'command', open: true });
  assert.equal(events.at(-1).items[0].output, output); assert.equal(events.at(-1).items[1].diff, undefined);
  await routes.toolDetails.call(session, { sel: 'A', i: 'command', open: false });
  assert.equal(events.at(-1).items[0].output, undefined);
  await routes.toolDetails.call(session, { sel: 'A', i: 'edit', open: true });
  assert.deepEqual(events.at(-1).items[1].diff, [['…', '/A/file.txt'], ['-', 'old'], ['+', 'new']]);
  assert.equal(events.at(-1).items[0].output, undefined);
});

test('a model list completing after a thread switch cannot be assigned to the new selection', async () => {
  let complete;
  const events = [], routes = backendRoutesFor({ codexBackend: {
    threads: new Map([['A', { settings: { model: 'native-A' } }]]),
    client: { request: () => new Promise(resolve => { complete = resolve; }) },
  } });
  const session = { threadId: 'A', selectionKey() { return 'codex|backend|' + this.threadId; }, emit: value => events.push(value) };
  const readMenu = routes.openMenu.call(session, { kind: 'model', requestId: 9 });
  session.threadId = 'B'; complete({ data: [{ model: 'native-A', displayName: 'Native A' }] }); await readMenu;
  assert.deepEqual(events, []);
});

test('backend sending resolves selected @ file keys without losing existing skills or local files', async () => {
  const sent = [], events = [], context = createPageContext({
    pendingUploads: () => [], cdpRead, currentOperation: () => null, backendPublish: () => {}, rememberSessionMessage: () => {},
    uploadAttachments: () => [], backendDraftSource: () => null, codexBackend: { draft: () => '', send: async (...args) => { sent.push(args); return { queued: false }; } },
  });
  const method = vm.runInContext('({' + fragment(read('server/apps/codex.mjs'), '  async sendBackendMessage(', '  async newChat(') + '}).sendBackendMessage', context);
  await method.call({ threadId: 'B', selectionKey: () => 'B', emit: value => events.push(value) }, 'question', true, '', [
    { section: 'files', key: '/B/src/a.js', label: 'a.js' }, { section: 'Skills', key: '/skills/inspect', label: 'inspect' },
    { section: 'local-files', path: '/outside/reference.txt' },
  ], { requestId: 'send' });
  assert.equal(sent[0][1][1].text, '引用文件：/B/src/a.js');
  assert.equal(sent[0][1][2].type, 'skill'); assert.equal(sent[0][1][2].path, '/skills/inspect');
  assert.equal(sent[0][1][3].text, '引用文件：/outside/reference.txt');
  assert.equal(events[0].t, 'sent');
});

async function retryFixture() {
  const { state, client } = fixture();
  const thread = await state.create('/A'), request = client.request;
  let number = 0;
  client.request = async (method, params) => method === 'turn/start'
    ? (client.sent.push({ method, params }), { turn: { id: 'retry-' + ++number, status: 'inProgress', items: [] } })
    : request(method, params);
  const fail = (id, info = 'serverOverloaded', willRetry = false) => {
    if (!thread.turns.some(turn => turn.id === id)) thread.turns.push({ id, status: 'inProgress', items: [] });
    const error = { message: 'capacity sample', codexErrorInfo: info };
    client.emit('notification', { method: 'error', params: { threadId: '/A', turnId: id, error, willRetry } });
    client.emit('notification', { method: 'turn/completed', params: { threadId: '/A', turn: { id, status: 'failed', items: [], error } } });
  };
  return { state, client, thread, fail, starts: () => client.sent.filter(row => row.method === 'turn/start') };
}

test('manual retry stays visible when auto retry is off and continues with empty input exactly once', async () => {
  const h = await retryFixture(); h.fail('failed');
  const notice = h.state.chat('/A').items.at(-1);
  assert.deepEqual(notice.b, ['重试']); assert.equal(notice.btnItem, 'failed');
  const routes = backendRoutesFor({ codexBackend: h.state });
  const session = { threadId: '/A', selectionKey: () => 'A', emit() {} };
  await routes.click.call(session, { sel: 'A', item: 'failed', n: 0, actionId: 'capacity-retry' });
  assert.equal(h.starts().length, 1); assert.deepEqual(h.starts()[0].params.input, []);
  assert.equal(h.starts()[0].params.turnTrigger, 'capacity_retry_manual');
  assert.equal(h.state.chat('/A').items.some(item => item.k === 'human'), false);
  await assert.rejects(routes.click.call(session, { sel: 'A', item: 'failed', n: 0, actionId: 'capacity-retry' }), /已更新/);
  assert.equal(h.starts().length, 1);
});

test('automatic capacity retries share a per-thread limit and retain the manual action after exhaustion', async () => {
  const h = await retryFixture(), notices = [], owner = {};
  h.state.setRetry(owner, '/A', { enabled: true, count: 2, notify: value => notices.push(value) });
  h.fail('first'); h.state.retryCapacity('/A'); await tick();
  assert.equal(h.starts().length, 1);
  h.fail('retry-1', 'policyCapacityUnavailable'); await tick();
  assert.equal(h.starts().length, 2);
  h.fail('retry-2'); await tick();
  assert.equal(h.starts().length, 2); assert.equal(notices.at(-1).count, 2);
  assert.deepEqual(h.state.chat('/A').items.at(-1).actions, ['capacity-retry']);
  assert(h.starts().every(row => row.params.turnTrigger === 'capacity_retry_automatic' && row.params.input.length === 0));
});

for (const kind of ['usageLimitExceeded', 'unauthorized', 'sandboxError']) test(`auto retry does not retry ${kind}`, async () => {
  const h = await retryFixture(); h.state.setRetry({}, '/A', { enabled: true, count: 5, notify() {} });
  h.fail('failed', kind); await tick();
  assert.equal(h.starts().length, 0); assert.equal(h.state.chat('/A').items.at(-1).b, undefined);
});

test('native retry in progress never triggers an additional RA retry', async () => {
  const h = await retryFixture(); h.state.setRetry({}, '/A', { enabled: true, count: 2, notify() {} });
  h.fail('native', 'serverOverloaded', true); await tick();
  assert.equal(h.starts().length, 0); assert.equal(h.state.chat('/A').items.at(-1).b, undefined);
  h.client.emit('notification', { method: 'turn/completed', params: { threadId: '/A', turn: { id: 'native', status: 'completed', items: [], error: null } } });
  assert.equal(h.state.chat('/A').items.some(item => item.k === 'notice'), false);
});

test('leaving a selected view cancels an automatic retry that has not dispatched', async () => {
  const h = await retryFixture(), owner = {}; h.fail('first');
  let resume;
  h.state.load = () => new Promise(resolve => { resume = () => resolve(h.thread); });
  h.state.setRetry(owner, '/A', { enabled: true, count: 2, notify() { throw Error('stale callback'); } });
  h.state.clearRetry(owner); resume(); await tick();
  assert.equal(h.starts().length, 0); assert.equal(h.state.retrySettings.size, 0);
});

test('duplicate manual requests share their in-flight native operation', async () => {
  const h = await retryFixture(); h.fail('first');
  const a = h.state.retry('/A', 'first'), b = h.state.retry('/A', 'first');
  assert.equal(a, b); await Promise.all([a, b]); assert.equal(h.starts().length, 1);
});

function fixture(file = null, State = CodexState) {
  const client = new EventEmitter();
  client.generation = 1;
  client.connect = async () => {};
  client.sent = [];
  client.request = async (method, params) => {
    client.sent.push({ method, params });
    if (method === 'thread/start') return { thread: { id: params.cwd, cwd: params.cwd, turns: [], createdAt: 1, updatedAt: 1 }, model: 'test' };
    if (method === 'thread/resume') {
      const { settings = {}, disconnected, ...thread } = state.threads.get(params.threadId) || { id: params.threadId, cwd: params.threadId, turns: [], createdAt: 1, updatedAt: 1 };
      const { sandboxPolicy, effort, ...rest } = settings;
      return { ...rest, thread, sandbox: sandboxPolicy, reasoningEffort: effort, model: settings.model || 'test' };
    }
    if (method === 'thread/read') return { thread: state.threads.get(params.threadId) };
    if (method === 'thread/unsubscribe') { queueMicrotask(() => client.emit('notification', { method: 'thread/closed', params: { threadId: params.threadId } })); return { status: 'unsubscribed' }; }
    if (method === 'thread/fork') {
      const source = state.threads.get(params.threadId), end = source.turns.findIndex(turn => turn.id === params.lastTurnId);
      return { thread: structuredClone({ ...source, id: source.id + ':fork', turns: source.turns.slice(0, end + 1) }), model: 'test' };
    }
    if (method === 'thread/queue/list') return { data: [] };
    if (method === 'thread/queue/add') return { queuedSubmission: { id: 'queue', clientUserMessageId: params.clientUserMessageId,
      input: params.input.map(row => row.type === 'text' ? { ...row, text_elements: [] } : row) } };
    if (method === 'turn/start') return { turn: { id: 'turn', status: 'inProgress', startedAt: 2, items: [] } };
    if (method === 'turn/steer') return { turnId: params.expectedTurnId };
    return {};
  };
  client.reply = (id, result) => client.sent.push({ id, result });
  client.reject = (id, error) => client.sent.push({ id, error });
  const state = new State({ client, file });
  return { client, state };
}

function stateForPlatform(IS_WIN) {
  const source = fragment(read('server/codex/state.mjs'), 'export const CODEX_BACKEND', 'export const codexBackend').replace(/^export /gm, '');
  return vm.runInContext(source + '\nCodexState;', createPageContext({ IS_WIN, fs, path, EventEmitter,
    DATA_DIR: '.', cdpRead, withOperation, generatedImageSource }));
}

for (const IS_WIN of [true, false]) {
  test(`${IS_WIN ? 'Windows' : 'Linux'} Codex catalog notifications follow committed names, not streamed content`, async () => {
    const { state } = fixture(null, stateForPlatform(IS_WIN)), events = [];
    state.on('catalogChanged', id => events.push([id, state.records.get(id).title]));
    const thread = await state.create('/A');
    state.remember(thread);
    await state.send(thread.id, [{ type: 'text', text: 'new title' }], '', 'request');
    state.notification({ method: 'thread/name/updated', params: { threadId: thread.id, threadName: 'new title' } });
    state.notification({ method: 'thread/name/updated', params: { threadId: thread.id, threadName: 'desktop title' } });
    state.notification({ method: 'turn/completed', params: { threadId: thread.id, turn: { id: 'turn', status: 'completed', items: [] } } });
    assert.deepEqual(events, [['/A', '新会话'], ['/A', 'new title'], ['/A', 'desktop title'], ['/A', 'desktop title']]);
  });

  test(`${IS_WIN ? 'Windows' : 'Linux'} Codex permission menus read without mutation and switch the selected thread`, async () => {
    const { state, client } = fixture(null, stateForPlatform(IS_WIN));
    const thread = await state.create('/A');
    const request = client.request;
    client.request = (method, params) => method === 'model/list' ? Promise.resolve({ data: [] }) : request(method, params);
    client.sent.length = 0;
    const events = [], routes = backendRoutesFor({ IS_WIN, codexBackend: state });
    const session = { threadId: thread.id, codexDirectory: '/A', selectionKey: () => 'own-A', emit: value => events.push(value) };
    await routes.openMenu.call(session, { kind: 'permission', requestId: 7 });
    assert.deepEqual(Array.from(events[0].items, row => row.label), ['Ask for approval', 'Approve for me', 'Full access']);
    assert.equal(client.sent.some(row => row.method === 'thread/settings/update'), false);
    assert.equal(events[0].requestId, 7); assert.equal(events[0].sel, 'own-A');
    for (const label of ['Approve for me', 'Ask for approval', 'Approve for me', 'Full access']) {
      await routes.pickMenu.call(session, { kind: 'permission', label });
      const { params } = client.sent.findLast(row => row.method === 'thread/settings/update');
      assert.equal(params.threadId, thread.id);
      assert.equal(params.approvalPolicy, label === 'Full access' ? 'never' : 'on-request');
      assert.equal(params.sandboxPolicy.type, label === 'Full access' ? 'dangerFullAccess' : 'workspaceWrite');
      assert.equal(params.approvalsReviewer, label === 'Approve for me' ? (IS_WIN ? 'guardian_subagent' : 'auto_review') : 'user');
      assert.equal(state.chat(thread.id).permission, label);
    }
    state.threads.get(thread.id).settings = { approvalsReviewer: 'auto_review' };
    assert.equal(state.chat(thread.id).permission, 'Approve for me');
    state.threads.get(thread.id).settings = { approvalsReviewer: 'guardian_subagent' };
    assert.equal(state.chat(thread.id).permission, IS_WIN ? 'Approve for me' : 'Ask for approval');
  });
}

test('Codex catalog synchronization targets existing desktop webviews and closes CDP reads', async () => {
  const calls = [];
  const synchronize = vm.runInContext(fragment(read('server/apps/codex.mjs'), 'async function syncCodexCatalog()', "codexBackend.on(") + '\nsyncCodexCatalog;', createPageContext({
    nativeTargets: () => [{ app: 'cursor', ws: 'cursor' }, { app: 'codex', ws: 'A' }, { app: 'codex', ws: 'B' }],
    helpersCall: call => call,
    Cdp: class {
      constructor(ws) { this.ws = ws; }
      async connect() { calls.push([this.ws, 'connect']); }
      async evaluate(call) { calls.push([this.ws, call]); }
      close() { calls.push([this.ws, 'close']); }
    },
  }));
  await synchronize();
  for (const ws of ['A', 'B']) assert.deepEqual(calls.filter(row => row[0] === ws).map(row => row[1]), ['connect', "nativeSessionInfo('codex', '', 'refreshCatalog')", 'close']);
  assert.equal(calls.some(row => row[0] === 'cursor'), false);
});

test('an unregistered native thread resumes once with its original history, directory and queue', async () => {
  const { state, client } = fixture(), request = client.request;
  const turns = [{ id: 'old-turn', status: 'completed', items: [
    { type: 'userMessage', id: 'user', content: [{ type: 'text', text: 'old question' }] },
    { type: 'agentMessage', id: 'answer', text: 'old answer' },
  ] }];
  client.request = async (method, params) => {
    if (method === 'thread/resume') {
      client.sent.push({ method, params });
      return { thread: { id: 'legacy', cwd: '/B', name: 'Native title', turns, updatedAt: 7, createdAt: 1 }, model: 'native-model' };
    }
    if (method === 'thread/queue/list') return { data: [{ id: 'native-queued', input: [{ type: 'text', text: 'queued message' }] }] };
    return request(method, params);
  };
  const [first, second] = await Promise.all([state.load('legacy'), state.load('legacy')]);
  assert.equal(first, second); assert.equal(first.id, 'legacy'); assert.equal(first.cwd, '/B');
  assert.deepEqual(first.turns, turns); assert.equal(state.records.get('legacy').title, 'Native title');
  assert.equal(state.records.get('legacy').cwd, '/B'); assert.equal(state.queues.get('legacy')[0].id, 'native-queued');
  assert.equal(client.sent.filter(row => row.method === 'thread/resume').length, 1);
  assert.equal(client.sent.some(row => row.method === 'thread/start'), false);
  assert.deepEqual(state.chat('legacy').items.filter(row => ['human', 'assistant'].includes(row.k)).map(row => row.t), ['old question', 'old answer']);
});

test('a failed or mismatched native resume does not register a legacy thread', async () => {
  for (const wrongId of [false, true]) {
    const { state, client } = fixture();
    client.request = async () => {
      if (!wrongId) throw Error('native thread missing');
      return { thread: { id: 'other', cwd: '/B', turns: [] } };
    };
    await assert.rejects(state.load('legacy'), wrongId ? /ID/ : /native thread missing/);
    assert.equal(state.owns('legacy'), false); assert.equal(state.threads.has('legacy'), false);
    assert.equal(state.loading.size, 0);
  }
});

test('legacy backend binding uses the native directory instead of the previously selected project', async () => {
  const events = [], context = createPageContext({ path: path.posix, os: { homedir: () => '/home' },
    safeHomePath: real => ({ real }), CODEX_BACKEND: 'backend', cdpRead, awaitCdpRead: promise => promise,
    rememberSelection: (_device, selected) => events.push(selected), backendAttached() {},
    adapter: { backendOwner: async () => null },
    codexBackend: { hasWriter: () => false, read: async id => ({ id, cwd: '/B' }) } });
  const bind = vm.runInContext(fragment(read('server/apps/codex.mjs'), 'async function bindBackend(', 'async function backendSettingsOwner(') + '\nbindBackend;', context);
  const session = { codexDirectory: '/A', threadId: 'A', detach() {}, clearViewState() {}, setMode: async () => {} };
  await bind(session, { threadId: 'legacy' });
  assert.equal(session.codexDirectory, '/B'); assert.equal(session.threadId, 'legacy');
  assert.equal(events[0].project.root, '/B'); assert.equal(events[0].windowId, 'backend');
  await assert.rejects(bind(session, { threadId: 'legacy', project: { root: '/A' } }), /不属于所选项目/);
  assert.equal(session.codexDirectory, '/B'); assert.equal(session.threadId, 'legacy');
});

test('native read-only summaries never resume or register another process writer', async () => {
  const { state, client } = fixture();
  client.request = async (method, params) => {
    client.sent.push({ method, params });
    assert.equal(method, 'thread/read'); assert.equal(params.includeTurns, true);
    return { thread: { id: 'desktop', cwd: '/B', model: 'native-model', reasoningEffort: 'high', preview: 'Native title', turns: [
      { id: 'turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: 'latest answer' }] },
    ] } };
  };
  const chat = await state.readChat('desktop');
  assert.equal(chat.items[0].t, 'latest answer'); assert.equal(chat.model, 'native-model'); assert.equal(chat.effort, 'high');
  assert.equal(state.owns('desktop'), false); assert.equal(state.threads.size, 0); assert.equal(state.statistics.size, 0);
  assert.equal(client.sent.length, 1);
});

test('legacy binding reuses the exact native writer and does not resume or create a project window', async () => {
  const calls = [], context = createPageContext({ path: path.posix, os: { homedir: () => '/home' },
    safeHomePath: real => ({ real }),
    adapter: { backendOwner: async id => ({ pageId: 'writer-window', cwd: '/B', id }) },
    codexBackend: { hasWriter: () => false } });
  const bind = vm.runInContext(fragment(read('server/apps/codex.mjs'), 'async function bindBackend(', 'async function backendSettingsOwner(') + '\nbindBackend;', context);
  const session = { codexDirectory: '/A', attach: async req => calls.push(req), projectReady: value => calls.push(value) };
  await bind(session, { threadId: 'desktop', project: { root: '/B' }, initial: true });
  assert.equal(calls.length, 2); assert.equal(calls[0].windowId, 'writer-window'); assert.equal(calls[0].threadId, 'desktop');
  assert.equal(calls[0].project, undefined); assert.equal(calls[0].nativeOwner.cwd, '/B'); assert.equal(calls[0].initial, true);
  await assert.rejects(bind(session, { threadId: 'desktop', project: { root: '/A' } }), /不属于所选项目/);
  assert.equal(calls.length, 2);
});

test('writer lookup scans both windows and selects owner rather than visible follower', async () => {
  const closed = [], calls = [], context = createPageContext({ CODEX_CDP_URL: 'native',
    codexBackend: { hasWriter: () => false, releasing: new Map() }, helpersCall: value => value,
    codexWindows: async () => ['follower', 'writer'].map(id => ({ pageId: id, chatWs: id })),
    Cdp: class {
      constructor(ws) { this.ws = ws; }
      async connect() {}
      async evaluate(expression) { calls.push(expression); return this.ws === 'writer' ? { cwd: '/B' } : null; }
      close() { closed.push(this.ws); }
    },
  });
  const lookup = vm.runInContext('({' + fragment(read('server/apps/codex.mjs'), '  async backendOwner(', '  backendThread(') + '}).backendOwner', context);
  const owner = await lookup('desktop');
  assert.equal(owner.pageId, 'writer'); assert.equal(owner.cwd, '/B'); assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call === `nativeSessionInfo('codex', "desktop", 'connection')`));
  assert.deepEqual(closed.sort(), ['follower', 'writer']);
});

test('native legacy routing preserves remote sessions and every Fusion binding', () => {
  const context = createPageContext({
    nativeSessionCatalog: () => ({ rows: [{ id: 'remote', host: 'ssh-host' }] }),
    allFusionRuns: () => [{ bindings: [{ app: 'codex', threadId: 'fusion-main' }, { app: 'codex', threadId: 'fusion-worker' }] }],
  });
  const target = vm.runInContext('({' + fragment(read('server/apps/codex.mjs'), '  backendThread(', '  closeBackendSettings(') + '}).backendThread', context);
  assert.equal(target('local'), true); assert.equal(target('remote'), false);
  assert.equal(target('local', 'ssh-host'), false);
  assert.equal(target('fusion-main'), false); assert.equal(target('fusion-worker'), false);
});

test('Windows binds a native follower when its writer is external and prefers a visible owner across windows', async () => {
  for (const roles of [['follower'], ['follower', 'owner'], [null, 'follower', 'owner']]) {
    const closed = [], context = createPageContext({ IS_WIN: true, CODEX_CDP_URL: 'native',
      codexBackend: { hasWriter: () => false, releasing: new Map() }, helpersCall: value => value,
      codexWindows: async () => roles.map((role, i) => ({ pageId: String(i), chatWs: String(i) })),
      Cdp: class {
        constructor(ws) { this.index = Number(ws); }
        async connect() {}
        async evaluate(call) {
          assert.equal(call, `nativeSessionInfo('codex', "target", 'connection')`);
          return roles[this.index] ? { cwd: '/target-project', role: roles[this.index] } : null;
        }
        close() { closed.push(this.index); }
      },
    });
    const lookup = vm.runInContext('({' + fragment(read('server/apps/codex.mjs'), '  async backendOwner(', '  backendThread(') + '}).backendOwner', context);
    const owner = await lookup('target');
    assert.equal(owner.role, roles.includes('owner') ? 'owner' : 'follower');
    assert.equal(owner.pageId, String(roles.indexOf(owner.role)));
    assert.equal(closed.length, roles.length);
  }
});

test('Codex backend fast routes reuse their native handler; desktop and OpenCode routes retain theirs', async () => {
  const calls = [], desktop = () => calls.push('desktop'), native = function (m) { calls.push(['native', this.threadId, m.automatic]); };
  const context = createPageContext({ ROUTES: { usage: { fast: true, fastRun: desktop }, stop: { fast: true, fastRun: desktop } } });
  const resolve = vm.runInContext(fragment(read('server/routes.mjs'), 'export function resolveRoute(', 'const fusionRoute')
    .replace('export function', 'function') + '\nresolveRoute;', context);
  const backend = { app: 'codex', codexBackend: true, threadId: 'A', adapter: { backendRoutes: { usage: native, stop: native } } };
  const route = resolve(backend, 'usage');
  assert.equal(route.fastRun, route.run); await route.fastRun(backend, { automatic: false });
  await resolve(backend, 'stop').fastRun(backend, { automatic: true });
  assert.equal(resolve({ app: 'codex' }, 'usage').fastRun, desktop);
  assert.equal(resolve({ app: 'opencode', adapter: { routes: { usage: native } } }, 'usage').fastRun, desktop);
  assert.deepEqual(calls, [['native', 'A', false], ['native', 'A', true]]);
});

test('backend quota preserves the native percentage basis, reset time and update time', async () => {
  const events = [], limits = { planType: 'test-plan', primary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: 1800000000 }, secondary: null };
  const context = createPageContext({ codexBackend: { client: { request: async method => { assert.equal(method, 'account/rateLimits/read'); return { rateLimits: limits }; } },
    chat: () => ({ context: { pct: 8 } }) } });
  const routes = vm.runInContext(fragment(read('server/apps/codex.mjs'), 'const backendRoutes =', 'function serializedCodexPrompt') + '\nbackendRoutes;', context);
  await routes.usage.call({ threadId: 'A', selectionKey: () => 'codex|backend|A', emit: row => events.push(row) }, { automatic: false });
  const result = events[0]; assert.equal(result.updated > 0, true);
  assert.equal(result.limits[0].pct, 18); assert.equal(result.limits[0].basis, 'used');
  assert.equal(result.limits[0].reset, new Date(1800000000 * 1000).toLocaleString('zh-CN'));
  assert.equal(result.limits[0].label, 'Weekly'); assert.equal(result.context.pct, 8);
});

function usageEvent(client, id, turnId, total, last = total) {
  client.emit('notification', { method: 'thread/tokenUsage/updated', params: {
    threadId: id, turnId, tokenUsage: { total, last, modelContextWindow: 1000 },
  } });
}
const firstUsage = { totalTokens: 100, inputTokens: 90, outputTokens: 10, reasoningOutputTokens: 2, cachedInputTokens: 40, cacheWriteInputTokens: 5 };

test('backend sampling exposes only the current turn native output counter across updates, completion and session switches', async () => {
  const { state, client } = fixture(); await state.create('/A'); await state.create('/B');
  const start = (threadId, id) => client.emit('notification', { method: 'turn/started', params: {
    threadId, turn: { id, status: 'inProgress', items: [], startedAt: 100 },
  } });
  start('/A', 'first');
  assert.equal(state.chat('/A').performance.counter, null);
  usageEvent(client, '/A', 'first', firstUsage);
  assert.equal(state.chat('/A').performance.counter, 10);
  usageEvent(client, '/A', 'first', { ...firstUsage, outputTokens: 100 });
  assert.equal(state.chat('/A').performance.counter, 100);
  start('/B', 'other');
  usageEvent(client, '/B', 'other', { ...firstUsage, outputTokens: 0 });
  assert.equal(state.chat('/B').performance.counter, 0);
  assert.equal(state.chat('/A').performance.counter, 100);
  client.emit('notification', { method: 'turn/completed', params: { threadId: '/A', turn: {
    id: 'first', status: 'completed', items: [], startedAt: 100, completedAt: 105, durationMs: 5000,
  } } });
  assert.equal(state.chat('/A').performance.counter, 100);
  assert.equal(state.chat('/A').performance.busy, false);
  start('/A', 'next');
  assert.equal(state.chat('/A').performance.runId, 'next');
  assert.equal(state.chat('/A').performance.counter, null);
  usageEvent(client, '/A', 'next', { ...firstUsage, outputTokens: 130 });
  assert.equal(state.chat('/A').performance.counter, 130);
  assert.equal(state.chat('/A').performance.tokens.output, 30);
});

test('a turn sums all native calls without double counting, while context uses only the last call', async () => {
  const { state, client } = fixture(); await state.create('/A');
  client.emit('notification', { method: 'turn/started', params: { threadId: '/A', turn: { id: 'first', status: 'inProgress', items: [] } } });
  usageEvent(client, '/A', 'first', firstUsage);
  client.emit('notification', { method: 'turn/completed', params: { threadId: '/A', turn: { id: 'first', status: 'completed', items: [] } } });
  client.emit('notification', { method: 'turn/started', params: { threadId: '/A', turn: { id: 'second', status: 'inProgress', items: [], startedAt: 2 } } });
  const total = { totalTokens: 300, inputTokens: 260, outputTokens: 40, reasoningOutputTokens: 8, cachedInputTokens: 120, cacheWriteInputTokens: 20 };
  const last = { totalTokens: 80, inputTokens: 70, outputTokens: 10, reasoningOutputTokens: 2, cachedInputTokens: 30, cacheWriteInputTokens: 5 };
  usageEvent(client, '/A', 'second', { ...total, totalTokens: 200, inputTokens: 170, outputTokens: 30 }, last);
  usageEvent(client, '/A', 'second', total, last); usageEvent(client, '/A', 'second', total, last);
  state.threads.get('/A').settings.model = 'next-model';
  client.emit('notification', { method: 'turn/completed', params: { threadId: '/A', turn: { id: 'second', status: 'completed', items: [], startedAt: 2, completedAt: 4, durationMs: 2000 } } });
  const chat = state.chat('/A');
  assert.deepEqual(chat.performance.tokens, { input: 170, output: 30, reasoning: 6, cacheRead: 80, cacheWrite: 15 });
  assert.equal(chat.performance.rate, 15); assert.equal(chat.context.used, 80); assert.equal(chat.context.pct, 8);
  assert.equal(chat.performance.model, 'test'); assert.equal(chat.model, 'next-model');
});

test('fork and resume retain usage received before the transcript and copy only the selected history', async t => {
  fs.mkdirSync('_shots', { recursive: true });
  const directory = fs.mkdtempSync(path.resolve('_shots/codex-statistics-regression-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json'), { state, client } = fixture(file);
  const source = await state.create('/A');
  source.settings.model = 'historical-model';
  for (const [id, total] of [['first', firstUsage], ['second', { ...firstUsage, totalTokens: 200, inputTokens: 180, outputTokens: 20 }]]) {
    client.emit('notification', { method: 'turn/started', params: { threadId: '/A', turn: { id, status: 'inProgress', items: [] } } });
    usageEvent(client, '/A', id, total);
    client.emit('notification', { method: 'turn/completed', params: { threadId: '/A', turn: { id, status: 'completed', items: [], durationMs: 1000 } } });
  }
  const request = client.request;
  client.request = async (method, params) => {
    if (method === 'thread/fork') usageEvent(client, '/A:fork', 'first', firstUsage);
    return request(method, params);
  };
  const fork = await state.fork('/A', 'first');
  assert.equal(state.chat(fork.id).context.used, 100);
  assert.equal(state.chat(fork.id).performance.tokens.output, 10);
  assert.equal(state.chat(fork.id).performance.model, 'historical-model');
  assert.deepEqual(Object.keys(state.statistics.get(fork.id)), ['first']);
  assert.deepEqual(Object.keys(state.statistics.get('/A')), ['first', 'second']);
  const restored = fixture(file), resume = restored.client.request;
  restored.client.request = async (method, params) => {
    if (method === 'thread/resume') {
      usageEvent(restored.client, fork.id, 'first', firstUsage);
      return { thread: structuredClone(fork), model: 'current-model' };
    }
    return resume(method, params);
  };
  await restored.state.load(fork.id);
  assert.equal(restored.state.chat(fork.id).performance.tokens.output, 10);
  assert.equal(restored.state.chat(fork.id).performance.model, 'historical-model');
  assert.equal(restored.state.chat(fork.id).context.pct, 10);
  await restored.state.manage(fork.id, 'archive');
  assert.equal(restored.state.statistics.has(fork.id), false);
});

test('a fork restores persisted statistics even when the native resume does not emit usage', async () => {
  const { state, client } = fixture(); await state.create('/A');
  state.threads.get('/A').turns.push({ id: 'first', status: 'completed', items: [], durationMs: 1000 });
  usageEvent(client, '/A', 'first', firstUsage);
  const fork = await state.fork('/A', 'first'), records = structuredClone([...state.records]);
  const restored = fixture(); restored.state.records = new Map(records);
  restored.state.statistics = new Map(records.map(([id, row]) => [id, row.statistics]));
  const request = restored.client.request;
  restored.client.request = (method, params) => method === 'thread/resume' ? Promise.resolve({ thread: structuredClone(fork), model: 'test' }) : request(method, params);
  await restored.state.load(fork.id);
  assert.equal(restored.state.chat(fork.id).performance.rate, 10);
  assert.equal(restored.state.chat(fork.id).context.used, 100);
});

test('Codex app-server initialization is shared; replies, requests and events use separate channels', async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { this.emit('exit', 0); } });
  let spawned = 0;
  const sent = [];
  child.stdin.on('data', data => {
    const packet = JSON.parse(data);
    sent.push(packet);
    if (packet.method === 'initialize') child.stdout.write(JSON.stringify({ id: packet.id, result: {} }) + '\n');
  });
  const client = new CodexClient({ binary: async () => 'codex', spawnProcess: () => { spawned++; return child; } });
  await Promise.all([client.connect(), client.connect()]);
  assert.equal(spawned, 1);
  assert.equal(sent[0].method, 'initialize');
  assert.equal(sent[1].method, 'initialized');
  const events = [], requests = [];
  client.on('notification', p => events.push(p)); client.on('request', p => requests.push(p));
  const first = client.request('first'), second = client.request('second');
  child.stdout.write(JSON.stringify({ id: sent[3].id, result: 'second' }) + '\n');
  child.stdout.write(JSON.stringify({ id: 'approval', method: 'item/fileChange/requestApproval', params: {} }) + '\n');
  child.stdout.write(JSON.stringify({ method: 'turn/completed', params: {} }) + '\n');
  child.stdout.write(JSON.stringify({ id: sent[2].id, result: 'first' }) + '\n');
  assert.equal(await first, 'first'); assert.equal(await second, 'second');
  assert.equal(requests[0].id, 'approval'); assert.equal(events[0].method, 'turn/completed');
  const pending = client.request('pending');
  client.close();
  await assert.rejects(pending, /已退出/);
  assert.equal(client.pending.size, 0);
});

test('forking preserves native history through the chosen turn, source identity and project', async () => {
  const { state, client } = fixture();
  const source = await state.create('/A');
  Object.assign(source.settings, { effort: 'high', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandboxPolicy: { type: 'workspaceWrite' } });
  source.turns.push(...[1, 2].map(n => ({ id: 'turn-' + n, status: 'completed', items: [
    { id: 'human-' + n, type: 'userMessage', content: [{ type: 'text', text: 'question ' + n }] },
    { id: 'reply-' + n, type: 'agentMessage', text: 'reply ' + n },
  ] })));
  const child = await state.fork('/A', 'turn-1');
  assert.notEqual(child.id, source.id); assert.equal(child.cwd, '/A');
  assert.deepEqual(child.turns.map(turn => turn.id), ['turn-1']);
  assert.deepEqual(source.turns.map(turn => turn.id), ['turn-1', 'turn-2']);
  assert.equal(state.records.get(child.id).cwd, '/A');
  assert.deepEqual(client.sent.find(row => row.method === 'thread/fork').params,
    { threadId: '/A', lastTurnId: 'turn-1', deferGoalContinuation: true, cwd: '/A', model: 'test',
      approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write', config: { model_reasoning_effort: 'high', thread_unload_delay_secs: 0 } });
  assert.equal(client.sent.some(row => row.method === 'turn/start'), false);
});

test('a stale fork action cannot fork or bind another conversation', async () => {
  const events = [], routes = backendRoutesFor({
    codexBackend: { fork: () => assert.fail('stale action must not fork') },
    bindBackend: () => assert.fail('stale action must not bind'),
  });
  const session = { threadId: 'source', selectionKey: () => 'codex|backend|source', emit: message => events.push(message) };
  await assert.rejects(routes.click.call(session, { sel: 'codex|backend|old', item: 'turn-1', n: 0, actionId: 'fork' }), /会话已切换/);
  assert.equal(events.length, 1);
  assert.equal(events[0].t, 'clickDone'); assert.equal(events[0].clicked, false);
  assert.equal(events[0].sel, 'codex|backend|old');
});

test('an empty Codex thread is committed natively before it is recorded; first text replaces only its automatic title', async () => {
  const { state, client } = fixture();
  await state.create('/A');
  assert.deepEqual(client.sent.slice(0, 2).map(row => row.method), ['thread/start', 'thread/name/set']);
  assert.equal(state.records.get('/A').untitled, true);
  await state.send('/A', [{ type: 'text', text: 'First request\nBody' }], '', 'first');
  assert.equal(state.records.get('/A').title, 'First request');
  assert.equal(state.records.get('/A').untitled, undefined);
  await state.manage('/A', 'rename', 'My title');
  await state.send('/A', [{ type: 'text', text: 'Next request' }], 'now', 'next');
  assert.equal(state.records.get('/A').title, 'My title');
});

test('listeners follow thread identity, returning home does not terminate an active generation', async () => {
  const { state, client } = fixture();
  await state.create('/A'); await state.create('/B');
  let a = 0, b = 0;
  const stop = state.subscribe('/A', () => a++);
  state.subscribe('/B', () => b++);
  await state.send('/A', [{ type: 'text', text: 'A' }], '', 'request-A');
  const before = a; stop();
  client.emit('notification', { method: 'item/started', params: { threadId: '/A', turnId: 'turn', item: { id: 'reply', type: 'agentMessage', text: '' } } });
  client.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: '/A', turnId: 'turn', itemId: 'reply', delta: 'continued' } });
  assert.equal(a, before); assert.equal(b, 0);
  assert.equal(state.chat('/A').items[0].t, 'continued');
  assert.equal(state.chat('/B').items.length, 0);
  assert.equal(client.sent.some(row => row.method === 'turn/interrupt'), false);
});

test('queue, steer and start go to one native thread with their original request identities', async () => {
  const { state, client } = fixture();
  await state.create('/A');
  await state.send('/A', [{ type: 'text', text: 'first' }], '', 'first');
  const queued = await state.send('/A', [{ type: 'text', text: 'queued' }], 'queue', 'queued');
  const steered = await state.send('/A', [{ type: 'text', text: 'now' }], 'now', 'now');
  assert.equal(queued.queued, true); assert.equal(steered.queued, false);
  assert.deepEqual(client.sent.filter(row => row.method?.startsWith('turn/') || row.method === 'thread/queue/add')
    .map(row => [row.method, row.params.threadId, row.params.clientUserMessageId]),
  [['turn/start', '/A', 'first'], ['thread/queue/add', '/A', 'queued'], ['turn/steer', '/A', 'now']]);
  assert.equal(client.sent.find(row => row.method === 'turn/steer').params.expectedTurnId, 'turn');
});

test('approval replies are tied to the originating thread and keep native choices', async () => {
  const { state, client } = fixture();
  await state.create('/A'); await state.create('/B');
  client.emit('request', { id: 7, method: 'item/commandExecution/requestApproval', params: {
    threadId: '/A', turnId: 'turn', itemId: 'command', command: 'echo test', availableDecisions: ['accept', 'decline'] } });
  assert.equal(state.chat('/A').questions.requests.length, 1);
  assert.equal(state.chat('/B').questions.requests.length, 0);
  const request = state.chat('/A').questions.requests[0].id;
  assert.throws(() => state.answer('/B', request, 0), /不属于/);
  state.answer('/A', request, 1);
  assert.deepEqual(client.sent.at(-1), { id: 7, result: { decision: 'decline' } });
  assert.equal(state.requests.size, 0);
});

test('disconnect invalidates loaded runtime state; resuming restores each native thread once', async () => {
  const { state, client } = fixture();
  await state.create('/A');
  client.emit('disconnected', new Error('closed'));
  assert.equal(state.threads.get('/A').disconnected, 'closed'); assert.equal(state.owns('/A'), true);
  assert.equal(state.chat('/A').busy, false);
  assert.match(state.chat('/A').items.at(-1).t, /后台中断.*结果待核对/);
  await Promise.all([state.load('/A'), state.load('/A')]);
  assert.equal(client.sent.filter(row => row.method === 'thread/resume').length, 1);
  assert.equal(state.threads.get('/A').cwd, '/A');
});

test('completion retains streamed items when the native turn summary has an empty item list', async () => {
  const { state, client } = fixture();
  await state.create('/A'); await state.send('/A', [{ type: 'text', text: 'run' }], '', 'request');
  client.emit('notification', { method: 'item/completed', params: { threadId: '/A', turnId: 'turn', item: { id: 'reply', type: 'agentMessage', text: 'done' } } });
  client.emit('notification', { method: 'turn/completed', params: { threadId: '/A', turn: { id: 'turn', status: 'completed', completedAt: 4, items: [] } } });
  const chat = state.chat('/A');
  assert.equal(chat.busy, false); assert.equal(chat.items[0].t, 'done');
  assert.equal(state.states()[0].run.status, 'completed');
  await tick();
});

test('a completed summary contains only the final reply and must retain streamed human messages and images', async () => {
  const { state, client } = fixture();
  await state.create('/A'); await state.send('/A', [{ type: 'text', text: 'run' }], '', 'request');
  client.emit('notification', { method: 'item/completed', params: { threadId: '/A', turnId: 'turn', item: {
    id: 'human', type: 'userMessage', content: [{ type: 'text', text: 'run' }, { type: 'image', url: 'data:image/png;base64,YQ==' }] } } });
  client.emit('notification', { method: 'turn/completed', params: { threadId: '/A', turn: { id: 'turn', itemsView: 'summary', status: 'completed',
    items: [{ id: 'reply', type: 'agentMessage', text: 'done' }] } } });
  const chat = state.chat('/A');
  assert.deepEqual(chat.items.map(item => item.k), ['human', 'assistant']);
  assert.equal(chat.items[0].images[0], 'data:image/png;base64,YQ==');
});

test('shared backend events outlive the cancelled navigation and carry no originating send operation', () => {
  const { state } = fixture(), controller = new AbortController();
  const contexts = [];
  state.subscribe('/A', () => contexts.push([cdpRead.getStore(), currentOperation()]));
  controller.abort(new Error('navigation finished'));
  cdpRead.run(controller.signal, () => withOperation({ id: 'previous-send' }, () => state.changed('/A')));
  assert.deepEqual(contexts, [[null, null]]);
});

test('shared update scheduling waits for receipt and then sends only the latest state', async () => {
  const client = new EventEmitter(), frames = [], receipts = [];
  client.ping = receipt => receipts.push(receipt);
  const session = { app: 'codex', client, selectionKey: () => 'codex|backend|A', visible: true, mode: 'chat' };
  let refresh, value = 0, unsubscribed = false;
  const stop = watchChatUpdates(session, callback => { refresh = callback; return () => { unsubscribed = true; }; }, sent => { frames.push(value); sent(); });
  refresh(); await tick();
  value = 1; refresh(); value = 2; refresh(); await tick();
  assert.deepEqual(frames, [0]);
  client.emit('pong', receipts[0]); await tick();
  assert.deepEqual(frames, [0, 2]);
  value = 3; refresh(); stop(); client.emit('pong', receipts[1]); await tick();
  assert.deepEqual(frames, [0, 2]); assert.equal(unsubscribed, true); assert.equal(client.listenerCount('pong'), 0);
});

test('MCP elicitation preserves false, zero, numbers and enum types and rejects invalid values', async () => {
  const { state, client } = fixture(); await state.create('/A');
  const schema = { type: 'object', required: ['flag', 'count', 'rate', 'choice', 'text'], properties: {
    flag: { type: 'boolean' }, count: { type: 'integer' }, rate: { type: 'number' }, choice: { type: 'integer', enum: [0, 2] }, text: { type: 'string' }, optional: { type: 'string' },
  } };
  const ask = id => { state.request({ id, method: 'mcpServer/elicitation/request', params: { threadId: '/A', requestedSchema: schema } }); return state.requestRows('/A').at(-1).id; };
  const fields = ['false', '0', '1.5', '2', ''].map((value, n) => ({ n, value }));
  const id = ask('typed'); state.answer('/A', id, 0, fields);
  assert.deepEqual(client.sent.at(-1).result, { action: 'accept', content: { flag: false, count: 0, rate: 1.5, choice: 2, text: '' } });
  const invalid = ask('invalid');
  assert.throws(() => state.answer('/A', invalid, 0, fields.map(field => field.n === 1 ? { ...field, value: '1.1' } : field)), /数值格式/);
  assert(state.requests.has('invalid'));
  state.answer('/A', invalid, 2, []); assert.deepEqual(client.sent.at(-1).result, { action: 'cancel', content: null });
});

test('MCP native titled enums and multi-select schemas preserve labels, defaults and array answers', async () => {
  const { state, client } = fixture(); await state.create('/A');
  const schema = { type: 'object', required: ['plan', 'tools'], properties: {
    plan: { type: 'string', title: '方案', oneOf: [{ const: 'a', title: '方案甲' }, { const: 'b', title: '方案乙' }], default: 'b' },
    tools: { type: 'array', items: { type: 'string', enum: ['read', 'write'] }, default: ['read'], minItems: 1, maxItems: 2 },
    titled: { type: 'array', items: { anyOf: [{ const: 'one', title: '第一项' }, { const: 'two', title: '第二项' }] }, default: ['two'] },
    legacy: { type: 'string', enum: ['low', 'high'], enumNames: ['低', '高'] },
  } };
  state.request({ id: 'native-form', method: 'mcpServer/elicitation/request', params: {
    threadId: '/A', turnId: null, serverName: 'qa', mode: 'form', message: '原生表单', requestedSchema: schema,
  } });
  const row = state.requestRows('/A')[0];
  assert.equal(row.fields[0].label, '方案'); assert.equal(row.fields[0].value, 'b');
  assert.deepEqual(row.fields[0].options.slice(1), [{ value: 'a', label: '方案甲' }, { value: 'b', label: '方案乙' }]);
  assert.equal(row.fields[1].multiple, true); assert.deepEqual(row.fields[1].value, ['read']);
  assert.deepEqual(row.fields[2].options, [{ value: 'one', label: '第一项' }, { value: 'two', label: '第二项' }]);
  assert.equal(row.fields[3].options[2].label, '高');
  state.answer('/A', row.id, 0, [{ n: 0, value: 'a' }, { n: 1, value: ['read', 'write'] }, { n: 2, value: ['two'] }, { n: 3, value: 'high' }]);
  assert.deepEqual(client.sent.at(-1).result, { action: 'accept', content: { plan: 'a', tools: ['read', 'write'], titled: ['two'], legacy: 'high' } });
});

test('MCP multi-select validates native options and counts while retaining failed answers and cancel semantics', async () => {
  const { state, client } = fixture(); await state.create('/A');
  const schema = { type: 'object', required: ['picks'], properties: {
    picks: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, minItems: 1, maxItems: 1 },
    optional: { type: 'array', items: { type: 'string', enum: ['x'] } },
  } };
  const ask = id => { state.request({ id, method: 'mcpServer/elicitation/request', params: { threadId: '/A', mode: 'form', requestedSchema: schema } }); return state.requestRows('/A').at(-1).id; };
  const id = ask('invalid-multi');
  for (const [value, error] of [[[], /选项数量/], [['a', 'b'], /选项数量/], [['unknown'], /请选择有效/]]) {
    assert.throws(() => state.answer('/A', id, 0, [{ n: 0, value }]), error);
    assert(state.requests.has('invalid-multi'));
  }
  state.answer('/A', id, 0, [{ n: 0, value: ['b'] }, { n: 1, value: [] }]);
  assert.deepEqual(client.sent.at(-1).result.content, { picks: ['b'] });
  for (const [button, action] of [[1, 'decline'], [2, 'cancel']]) {
    state.answer('/A', ask(action), button, []);
    assert.deepEqual(client.sent.at(-1).result, { action, content: null });
  }
});

test('backend fast stop follows the desktop owner without resuming a second writer', async () => {
  const routes = backendRoutesFor({ codexBackend: { withWriter() { assert.fail('must use the desktop writer'); } } });
  let stopped;
  const session = { codexBackend: true, async followCodexOwner(m) { this.codexBackend = false; return { ...m, sel: 'desktop:A' }; },
    handle: async m => { stopped = m; } };
  await routes.stop.call(session, { t: 'stop', sel: 'backend:A' });
  assert.equal(stopped.sel, 'desktop:A'); assert.equal(stopped.t, 'stop');
});

test('disconnect retains transcript while removing active execution and stop resumes the native thread', async () => {
  const { state, client } = fixture(), thread = await state.create('/A');
  thread.turns.push({ id: 'running', status: 'inProgress', items: [{ id: 'body', type: 'agentMessage', text: 'last known answer' }] });
  client.emit('disconnected', new Error('native exit'));
  const chat = state.chat('/A'); assert.equal(chat.busy, false); assert.equal(chat.items[0].t, 'last known answer');
  assert(chat.items.some(item => /结果待核对/.test(item.t)));
  const routes = backendRoutesFor({ codexBackend: state }); await routes.stop.call({ threadId: '/A', codexBackend: true, followCodexOwner: async m => m }, { t: 'stop' });
  assert.equal(client.sent.filter(row => row.method === 'thread/resume').length, 1);
  assert.equal(state.chat('/A').items.some(item => /后台中断/.test(item.t)), false);
});

for (const mode of ['idle', 'active', 'already-started', 'disconnect']) test(`queued send-now follows authoritative native turn completion: ${mode}`, async () => {
  const { state, client } = fixture(), thread = await state.create('/A');
  const queued = { id: 'queue-one', clientUserMessageId: 'user-one', input: [{ type: 'text', text: 'queued text' }] };
  state.writers.add('/A');
  state.queues.set('/A', [queued]);
  if (mode !== 'idle') thread.turns.push({ id: 'running', status: 'inProgress', items: [] });
  const original = client.request;
  client.request = async (method, params) => {
    if (method === 'turn/interrupt') { client.sent.push({ method, params }); return {}; }
    if (method === 'thread/queue/list') return { data: mode === 'already-started' ? [] : [queued] };
    return original(method, params);
  };
  const pending = state.startQueued('/A', queued.id); await tick();
  assert.equal(client.sent.filter(row => row.method === 'thread/queue/start').length, mode === 'idle' ? 1 : 0);
  if (mode === 'disconnect') {
    client.emit('disconnected', new Error('closed before turn ended'));
    await assert.rejects(pending, /closed before/);
    assert.equal(client.sent.filter(row => row.method === 'thread/queue/start').length, 0);
  } else {
    if (mode !== 'idle') {
      if (mode === 'already-started') thread.turns.push({ id: 'next', status: 'inProgress', items: [{ id: 'accepted', type: 'userMessage', clientId: 'user-one' }] });
      client.emit('notification', { method: 'turn/completed', params: { threadId: '/A', turn: { id: 'running', status: 'interrupted', items: [] } } });
    }
    await pending;
    assert.equal(client.sent.filter(row => row.method === 'thread/queue/start').length, mode === 'already-started' ? 0 : 1);
  }
  assert.equal(state.listenerCount('changed'), 0);
});
