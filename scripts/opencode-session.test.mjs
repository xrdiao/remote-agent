import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { cdpRead } from '../server/cdp.mjs';
import { createDocuments } from './fixtures/opencode-documents.mjs';

const root = fileURLToPath(new URL(`../_shots/opencode-tests-${process.pid}/`, import.meta.url));
fs.mkdirSync(root, { recursive: true });
const homedir = os.homedir;
os.homedir = () => root;
const { Session } = await import('../server/session.mjs');
const { openCode } = await import('../server/opencode/state.mjs');
const { uploads } = await import('../server/agent/context.mjs');
os.homedir = homedir;
test.after(() => { openCode.close(); fs.rmSync(root, { recursive: true, force: true }); });

const native = id => ({ id, directory: root.slice(0, -1), title: id, time: { created: 1, updated: 2 } });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('cancelled OpenCode history leaves the previous selection unbound and does not publish a first screen', async t => {
  const { session, events } = fixture(t);
  openCode.sessions.set('ses_one', native('ses_one'));
  const controller = new AbortController(), reason = new Error('target changed');
  const previousReady = session.bindingReady;
  let reading = false;
  t.mock.method(openCode.client, 'messages', (_id, _directory, _before, signal) => {
    assert.equal(signal, controller.signal);
    reading = true;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const pending = cdpRead.run(controller.signal, () => session.handle({ t: 'attach', id: 'opencode', threadId: 'ses_one' }));
  await tick(); assert(reading);
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(events.some(row => ['attached', 'chat'].includes(row.t)), false);
  assert.equal(session.bindingReady, previousReady);
  assert.equal(openCode.messages.has('ses_one'), false);
});

test('cancelling a navigation releases its shared OpenCode initialization wait without stopping initialization', async t => {
  const { session, events } = fixture(t);
  openCode.sessions.set('ses_one', native('ses_one'));
  let ready, completed = false;
  const connecting = new Promise(resolve => { ready = () => { completed = true; resolve(); }; });
  t.mock.method(openCode, 'connect', () => connecting);
  const controller = new AbortController(), reason = new Error('target changed');
  const pending = cdpRead.run(controller.signal, () => session.handle({ t: 'attach', id: 'opencode', threadId: 'ses_one' }));
  await tick(); controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(completed, false);
  assert.equal(events.some(row => row.t === 'attached'), false);
  ready(); await tick();
  assert.equal(events.some(row => row.t === 'attached'), false);
  await session.handle({ t: 'attach', id: 'opencode', threadId: 'ses_one' });
  assert.equal(events.filter(row => row.t === 'attached').length, 1);
  assert.equal(events.findLast(row => row.t === 'chat').chat.thread, 'ses_one');
});

function fixture(t) {
  uploads.clear();
  for (const map of [openCode.sessions, openCode.messages, openCode.historyPages, openCode.statuses, openCode.permissions, openCode.questions, openCode.models, openCode.selections,
    openCode.automaticSessions, openCode.autoReplies, openCode.approvalErrors]) map.clear();
  openCode.listeners.clear();
  openCode.connected = true;
  openCode.defaultModel = 'local/model';
  openCode.models.set('local/model', { id: 'model', providerID: 'local', name: 'Local Model', label: 'Local / Model', variants: { high: {} }, limit: { context: 131072 } });
  t.mock.method(openCode, 'connect', async () => {});
  t.mock.method(openCode.client, 'messages', async () => ({ rows: [], before: null }));
  const events = [], requests = [];
  t.mock.method(openCode.client, 'request', async (route, options) => {
    requests.push({ route, options });
    if (route === '/session') return native('ses_new');
    return null;
  });
  const client = Object.assign(new EventEmitter(), {
    readyState: 1,
    send(raw, _options, sent) { events.push(JSON.parse(raw)); sent?.(); },
    ping(data) { this.emit('pong', data); },
  });
  const session = new Session(client, 'opencode-test');
  t.after(() => session.dispose());
  return { session, events, requests };
}

function holdWrites(session, events) {
  const writes = [];
  session.client.send = (raw, _options, sent) => {
    events.push(JSON.parse(raw));
    if (sent) writes.push(sent);
  };
  return writes;
}

function messageText(id, text) {
  openCode.apply({ type: 'message.updated', properties: { info: { id: 'msg_stream', sessionID: id, role: 'assistant', time: { created: 3 } } } });
  openCode.apply({ type: 'message.part.updated', properties: { part: { id: 'part_stream', sessionID: id, messageID: 'msg_stream', type: 'text', text } } });
}

test('OpenCode waits for a snapshot write and then publishes the latest text, status and approval together', async t => {
  const { session, events } = fixture(t);
  openCode.sessions.set('ses_one', native('ses_one'));
  await session.handle({ t: 'attach', id: 'opencode', threadId: 'ses_one' });
  const writes = holdWrites(session, events);
  events.length = 0;
  openCode.statuses.set('ses_one', { type: 'busy' });
  messageText('ses_one', 'first');
  await tick();
  assert.equal(writes.length, 1);
  for (let i = 0; i < 30; i++) {
    messageText('ses_one', 'latest-' + i);
    await tick();
  }
  openCode.statuses.set('ses_one', { type: 'idle' });
  openCode.permissions.set('per_stream', { id: 'per_stream', sessionID: 'ses_one', patterns: ['file.py'], permission: 'edit', metadata: {} });
  openCode.changed('ses_one');
  await tick();
  assert.equal(events.filter(e => e.t === 'chat').length, 1);
  assert.equal(events[0].chat.busy, true);
  writes.shift()();
  await tick();
  const chats = events.filter(e => e.t === 'chat');
  assert.equal(chats.length, 2);
  assert.equal(chats[1].chat.items[0].t, 'latest-29');
  assert.equal(chats[1].chat.busy, false);
  assert.equal(chats[1].chat.waiting, 'approval');
  assert(chats[1].chat.items.some(item => item.i === 'permission:per_stream' && item.actions.includes('once')));
  writes.shift()();
  await tick();
  assert.equal(events.filter(e => e.t === 'chat').length, 2);
});

test('OpenCode waits for its browser receipt rather than a completed server write or an unrelated heartbeat pong', async t => {
  const { session, events } = fixture(t);
  openCode.sessions.set('ses_one', native('ses_one'));
  await session.handle({ t: 'attach', id: 'opencode', threadId: 'ses_one' });
  const receipts = [];
  session.client.ping = data => receipts.push(data);
  const writes = holdWrites(session, events);
  events.length = 0;
  messageText('ses_one', 'first'); await tick();
  writes.shift()();
  assert.equal(receipts.length, 1);
  for (let i = 0; i < 30; i++) { messageText('ses_one', 'latest-' + i); await tick(); }
  session.client.emit('pong', Buffer.alloc(0));
  await tick();
  assert.equal(events.filter(e => e.t === 'chat').length, 1);
  session.client.emit('pong', receipts.shift()); await tick();
  assert.deepEqual(events.filter(e => e.t === 'chat').map(e => e.chat.items[0].t), ['first', 'latest-29']);
  writes.shift()();
  await session.handle({ t: 'visible', v: false });
  assert.equal(session.client.listenerCount('pong'), 0);
  const before = events.length;
  session.client.emit('pong', receipts.shift()); await tick();
  assert.equal(events.length, before);
});

test('returning home and reopening the same OpenCode session discards the old pending refresh and its write callback', async t => {
  const { session, events } = fixture(t);
  openCode.sessions.set('ses_one', native('ses_one'));
  await session.handle({ t: 'attach', id: 'opencode', threadId: 'ses_one' });
  const writes = holdWrites(session, events);
  messageText('ses_one', 'old write'); await tick();
  const oldWrite = writes.shift();
  messageText('ses_one', 'old pending'); await tick();
  await session.handle({ t: 'visible', v: false });
  await session.handle({ t: 'visible', v: true });
  events.length = 0;
  messageText('ses_one', 'new write'); await tick();
  assert.equal(writes.length, 1);
  messageText('ses_one', 'new pending'); await tick();
  oldWrite(); await tick();
  assert.deepEqual(events.filter(e => e.t === 'chat').map(e => e.chat.items[0].t), ['new write']);
  writes.shift()(); await tick();
  assert.deepEqual(events.filter(e => e.t === 'chat').map(e => e.chat.items[0].t), ['new write', 'new pending']);
});

test('switching OpenCode sessions releases A updates without letting its late write interfere with B', async t => {
  const { session, events } = fixture(t);
  for (const id of ['ses_one', 'ses_two']) openCode.sessions.set(id, native(id));
  await session.handle({ t: 'attach', id: 'opencode', threadId: 'ses_one' });
  const writes = holdWrites(session, events);
  messageText('ses_one', 'A write'); await tick();
  const oldWrite = writes.shift();
  messageText('ses_one', 'A pending'); await tick();
  await session.handle({ t: 'openAgent', id: 'ses_two' });
  events.length = 0;
  messageText('ses_two', 'B write'); await tick();
  messageText('ses_one', 'A late event');
  messageText('ses_two', 'B pending'); await tick();
  oldWrite(); await tick();
  assert.deepEqual(events.filter(e => e.t === 'chat').map(e => e.chat.thread), ['ses_two']);
  writes.shift()(); await tick();
  const chats = events.filter(e => e.t === 'chat');
  assert.deepEqual(chats.map(e => [e.chat.thread, e.chat.items[0].t]), [['ses_two', 'B write'], ['ses_two', 'B pending']]);
});

test('OpenCode stops pending refreshes on terminal switch and on disposal', async t => {
  const { session, events } = fixture(t);
  openCode.sessions.set('ses_one', native('ses_one'));
  await session.handle({ t: 'attach', id: 'opencode', threadId: 'ses_one' });
  const writes = holdWrites(session, events);
  messageText('ses_one', 'first'); await tick();
  messageText('ses_one', 'pending'); await tick();
  await session.setMode('terminal');
  events.length = 0;
  writes.shift()(); await tick();
  assert.equal(events.length, 0);
  await session.setMode('chat');
  messageText('ses_one', 'after terminal'); await tick();
  messageText('ses_one', 'pending disposal'); await tick();
  session.dispose();
  events.length = 0;
  writes.shift()(); await tick();
  assert.equal(events.length, 0);
});

test('a first-screen snapshot waits for the combined navigation reply to be written before advancing live updates', async t => {
  const { session, events } = fixture(t);
  openCode.sessions.set('ses_one', native('ses_one'));
  session.navigationId = 1;
  const result = session.navigationResult = { id: 1 };
  const writes = holdWrites(session, events);
  await session.handle({ t: 'attach', id: 'opencode', threadId: 'ses_one' });
  messageText('ses_one', 'captured'); await tick();
  messageText('ses_one', 'latest while first screen waits'); await tick();
  assert.equal(events.length, 0);
  assert.equal(writes.length, 0);
  session.finishNavigationResult(result);
  assert.equal(events.length, 1);
  assert.equal(events[0].t, 'attached');
  assert.equal(events[0].chat.items[0].t, 'captured');
  assert.equal(writes.length, 1);
  writes.shift()(); await tick();
  assert.equal(events[1].t, 'chat');
  assert.equal(events[1].chat.items[0].t, 'latest while first screen waits');
});

test('OpenCode attaches and switches native sessions without any CDP or desktop window', async t => {
  const { session, events } = fixture(t);
  openCode.sessions.set('ses_one', native('ses_one'));
  openCode.sessions.set('ses_two', native('ses_two'));
  await session.handle({ t: 'attach', id: 'opencode', threadId: 'ses_one' });
  assert.equal(session.cdp, null);
  assert.equal(session.editorCdp, null);
  assert.equal(events.find(row => row.t === 'attached').capabilities.approvals, true);
  await session.handle({ t: 'openAgent', id: 'ses_two' });
  events.length = 0;
  openCode.apply({ type: 'message.updated', properties: { info: { id: 'msg_old', sessionID: 'ses_one', role: 'assistant', time: { created: 3 } } } });
  openCode.apply({ type: 'message.part.updated', properties: { part: { id: 'prt_old', sessionID: 'ses_one', messageID: 'msg_old', type: 'text', text: 'old thread' } } });
  await tick();
  assert.equal(events.filter(row => row.t === 'chat').length, 0);
  openCode.apply({ type: 'message.updated', properties: { info: { id: 'msg_new', sessionID: 'ses_two', role: 'assistant', time: { created: 4 } } } });
  openCode.apply({ type: 'message.part.updated', properties: { part: { id: 'prt_new', sessionID: 'ses_two', messageID: 'msg_new', type: 'text', text: 'current thread' } } });
  await tick();
  const chat = events.findLast(row => row.t === 'chat');
  assert.equal(chat.chat.thread, 'ses_two');
  assert.deepEqual(chat.chat.items.map(row => row.t), ['current thread']);
});

test('OpenCode confirms a send only after the matching native user message is saved', async t => {
  const { session, events, requests } = fixture(t);
  await session.handle({ t: 'attach', id: 'opencode', project: { root }, newSession: true });
  await session.handle({ t: 'pickMenu', kind: 'effort', label: 'high' });
  await session.handle({ t: 'send', text: 'read files', requestId: 'receipt-one', draftEpoch: 'epoch' });
  const prompt = requests.find(row => row.route.endsWith('/prompt_async'));
  assert.equal(prompt.options.directory, root.slice(0, -1));
  assert.equal(prompt.options.body.variant, 'high');
  assert.equal(events.find(row => row.t === 'sent').pending, true);
  assert.equal(events.some(row => row.t === 'sent' && !row.pending), false);
  const messageID = prompt.options.body.messageID;
  openCode.apply({ type: 'message.updated', properties: { info: { id: messageID, sessionID: 'ses_new', role: 'user', time: { created: Date.now() } } } });
  assert.equal(events.some(row => row.t === 'sent' && !row.pending), false);
  openCode.apply({ type: 'message.part.updated', properties: { part: { id: 'prt_user', messageID, sessionID: 'ses_new', type: 'text', text: 'read files' } } });
  assert.equal(events.findLast(row => row.t === 'sent').messageId, messageID);
  assert.equal(events.findLast(row => row.t === 'sent').pending, undefined);
  await tick();
  assert.equal(events.findLast(row => row.t === 'chat').chat.items[0].t, 'read files');
});

test('OpenCode approvals require the current session and forward only the selected native reply', async t => {
  const { session, requests } = fixture(t);
  openCode.sessions.set('ses_one', native('ses_one'));
  await session.handle({ t: 'attach', id: 'opencode', threadId: 'ses_one' });
  openCode.permissions.set('per_one', { id: 'per_one', sessionID: 'ses_one', patterns: ['file.py'], permission: 'edit', metadata: {} });
  const message = { t: 'click', sel: session.selectionKey(), item: 'permission:per_one', actionId: 'once' };
  await assert.rejects(session.handle({ ...message, sel: 'opencode|other|ses_other' }), /会话已切换/);
  assert.equal(requests.length, 0);
  await session.handle(message);
  assert.equal(requests[0].route, '/permission/per_one/reply');
  assert.deepEqual(requests[0].options.body, { reply: 'once' });
  assert.equal(openCode.permissions.has('per_one'), false);
});

test('OpenCode question replies preserve all selections and free text', async t => {
  const { session, requests } = fixture(t);
  openCode.sessions.set('ses_one', native('ses_one'));
  await session.handle({ t: 'attach', id: 'opencode', threadId: 'ses_one' });
  openCode.questions.set('que_one', { id: 'que_one', sessionID: 'ses_one' });
  await session.handle({ t: 'opencodeQuestion', id: 'que_one', sel: session.selectionKey(), answers: [['A', 'B'], ['custom text']] });
  assert.equal(requests[0].route, '/question/que_one/reply');
  assert.deepEqual(requests[0].options.body, { answers: [['A', 'B'], ['custom text']] });
  assert.equal(openCode.questions.has('que_one'), false);
});

test('OpenCode history requests use the native opaque cursor rather than a DOM position', async t => {
  const { session, events } = fixture(t);
  openCode.sessions.set('ses_one', native('ses_one'));
  const cursors = [];
  t.mock.method(openCode.client, 'messages', async (_id, _directory, before) => {
    cursors.push(before);
    return { rows: [{ info: { id: before ? 'msg_older' : 'msg_newer', sessionID: 'ses_one', role: 'user', time: { created: before ? 1 : 2 } },
      parts: [{ id: before ? 'prt_older' : 'prt_newer', type: 'text', text: before ? 'older' : 'newer' }] }], before: before ? null : 'opaque+/=' };
  });
  await session.handle({ t: 'attach', id: 'opencode', threadId: 'ses_one' });
  await session.handle({ t: 'scrollChat', history: true, requestId: 'history-one' });
  assert.deepEqual(cursors, [undefined, 'opaque+/=']);
  assert.deepEqual(events.find(row => row.t === 'historyPage').items.map(row => row.t), ['older']);
  assert.equal(events.find(row => row.t === 'historyDone').earlier, false);
});

test('OpenCode drafts belong to the selected conversation and stale draft writes do not cross threads', async t => {
  const { session, events } = fixture(t);
  openCode.sessions.set('ses_one', native('ses_one'));
  openCode.sessions.set('ses_two', native('ses_two'));
  await session.handle({ t: 'attach', id: 'opencode', threadId: 'ses_one' });
  const old = session.selectionKey();
  await session.handle({ t: 'draft', sel: old, text: 'draft one', draftEpoch: 'epoch-one' });
  await session.handle({ t: 'openAgent', id: 'ses_two' });
  await session.handle({ t: 'draft', sel: old, text: 'late write' });
  await session.handle({ t: 'draft', sel: session.selectionKey() });
  assert.equal(events.findLast(e => e.t === 'draftAck').text, '');
  await session.handle({ t: 'openAgent', id: 'ses_one' });
  await session.handle({ t: 'draft', sel: session.selectionKey() });
  assert.equal(events.findLast(e => e.t === 'draftAck').text, 'draft one');
});

test('archiving the selected native OpenCode session returns its view to an empty conversation', async t => {
  const { session, events } = fixture(t);
  openCode.sessions.set('ses_one', native('ses_one'));
  await session.handle({ t: 'attach', id: 'opencode', threadId: 'ses_one' });
  openCode.apply({ type: 'session.updated', properties: { info: { ...native('ses_one'), time: { updated: 3, archived: 3 } } } });
  await tick();
  assert.equal(session.threadId, '');
  assert.equal(events.findLast(e => e.t === 'attached').appName, 'OpenCode');
  assert.equal(events.findLast(e => e.t === 'chat').chat.empty, true);
});

test('OpenCode permission menu works before the first send and its mode stays with the native session', async t => {
  const { session, events, requests } = fixture(t);
  await session.handle({ t: 'attach', id: 'opencode', project: { root }, newSession: true });
  assert.equal(events.findLast(e => e.t === 'chat').chat.context.limit, 131072);
  await session.handle({ t: 'openMenu', kind: 'permission' });
  assert.deepEqual(events.findLast(e => e.t === 'menu').items, [
    { label: '手动审批', checked: true }, { label: '自动审批', checked: false },
  ]);
  await session.handle({ t: 'pickMenu', kind: 'permission', label: '自动审批' });
  assert.equal(session.threadId, 'ses_new');
  assert.equal(openCode.approvalMode('ses_new'), '自动审批');
  await session.handle({ t: 'send', text: 'hello', requestId: 'auto-first-send' });
  assert.equal(requests.filter(r => r.route === '/session').length, 1);
  await session.handle({ t: 'newProjectChat' });
  assert.equal(events.findLast(e => e.t === 'chat').chat.permission, '手动审批');
  await session.handle({ t: 'openAgent', id: 'ses_new' });
  assert.equal(events.findLast(e => e.t === 'chat').chat.permission, '自动审批');
  await session.handle({ t: 'pickMenu', kind: 'permission', label: '手动审批' });
  assert.equal(openCode.approvalMode('ses_new'), '手动审批');
});

test('OpenCode context refresh loads native history and discards responses after switching sessions', async t => {
  const { session, events } = fixture(t);
  for (const id of ['ses_one', 'ses_two']) openCode.sessions.set(id, native(id));
  await session.handle({ t: 'attach', id: 'opencode', threadId: 'ses_one' });
  const reads = [];
  t.mock.method(openCode.client, 'messages', async id => {
    reads.push(id);
    return { rows: [{ info: { id: 'msg_usage', sessionID: id, role: 'assistant', providerID: 'local', modelID: 'model',
      time: { created: 10, completed: 20 }, tokens: { input: 500, output: 50, reasoning: 10, cache: { read: 200, write: 0 } } }, parts: [] }], before: null };
  });
  await session.handle({ t: 'usage', automatic: true });
  assert.equal(reads.length, 0);
  await session.handle({ t: 'usage' });
  assert.deepEqual(reads, ['ses_one']);
  assert.equal(events.findLast(e => e.t === 'usage').context.used, 760);
  let complete;
  t.mock.method(openCode.client, 'messages', id => id === 'ses_one' ? new Promise(resolve => { complete = resolve; }) : Promise.resolve({ rows: [], before: null }));
  const pending = session.handle({ t: 'usage' });
  await session.handle({ t: 'openAgent', id: 'ses_two' });
  events.length = 0;
  complete({ rows: [], before: null });
  await pending;
  assert.equal(events.some(e => e.t === 'usage'), false);
});

test('OpenCode sends parsed Excel from an empty conversation and confirms only when all native parts are saved', async t => {
  const { session, events, requests } = fixture(t);
  const documents = await createDocuments(root + 'excel');
  await session.handle({ t: 'attach', id: 'opencode', project: { root }, newSession: true });
  const source = session.selectionKey();
  uploads.set('excel', { name: '工作簿.XLSX', path: documents.xlsx, pending: true, sel: source });
  uploads.set('other', { name: 'other.txt', path: documents.txt, pending: true, sel: 'another-session' });
  await session.handle({ t: 'send', text: '读取第二表', requestId: 'excel-send' });
  const prompt = requests.find(row => row.route.endsWith('/prompt_async')).options.body;
  assert.equal(prompt.parts.length, 2);
  assert.equal(prompt.parts[1].mime, 'text/plain');
  assert.match(Buffer.from(prompt.parts[1].url.split(',')[1], 'base64').toString(), /第二表[\s\S]*ZEBRA_731/);
  assert.equal(uploads.get('excel').pending, false);
  assert.equal(uploads.get('other').pending, true);
  assert.notEqual(session.selectionKey(), source);
  assert.equal(events.findLast(e => e.t === 'attachments').sel, session.selectionKey());
  openCode.apply({ type: 'message.updated', properties: { info: { id: prompt.messageID, sessionID: 'ses_new', role: 'user', time: { created: 10 } } } });
  openCode.apply({ type: 'message.part.updated', properties: { part: { id: 'part_text', messageID: prompt.messageID, sessionID: 'ses_new', type: 'text', text: '读取第二表' } } });
  assert.equal(events.some(e => e.t === 'sent' && !e.pending), false);
  openCode.apply({ type: 'message.part.updated', properties: { part: { ...prompt.parts[1], id: 'part_file', messageID: prompt.messageID, sessionID: 'ses_new' } } });
  assert.equal(events.findLast(e => e.t === 'sent').pending, undefined);
  assert.equal(events.findLast(e => e.t === 'sent').sel, session.selectionKey());
});

test('OpenCode parse failures keep uploads pending without creating a native session or a hanging send', async t => {
  const { session, events, requests } = fixture(t);
  const file = root + 'broken.xlsx'; fs.writeFileSync(file, 'not an Excel workbook');
  await session.handle({ t: 'attach', id: 'opencode', project: { root }, newSession: true });
  uploads.set('broken', { name: 'broken.xlsx', path: file, pending: true, sel: session.selectionKey() });
  const subscribers = openCode.listeners.size;
  await assert.rejects(session.handle({ t: 'send', text: '读取附件', requestId: 'bad-file' }));
  assert.equal(requests.length, 0);
  assert.equal(session.threadId, '');
  assert.equal(session.openCodeSends?.size || 0, 0);
  assert.equal(openCode.listeners.size, subscribers);
  assert.equal(uploads.get('broken').pending, true);
  assert.equal(events.some(e => e.t === 'sent'), false);
  await session.handle({ t: 'removeAttachment', id: 'broken', sel: session.selectionKey() });
  await session.handle({ t: 'send', text: '继续文字提问', requestId: 'after-bad-file' });
  assert.deepEqual(requests.find(row => row.route.endsWith('/prompt_async')).options.body.parts, [{ type: 'text', text: '继续文字提问' }]);
});

test('an attachment-only OpenCode send waits for its native file part rather than an empty user shell', async t => {
  const { session, events, requests } = fixture(t);
  const file = root + 'only.txt'; fs.writeFileSync(file, 'ATTACHMENT_ONLY_738');
  await session.handle({ t: 'attach', id: 'opencode', project: { root }, newSession: true });
  uploads.set('only', { name: 'only.txt', path: file, pending: true, sel: session.selectionKey() });
  await session.handle({ t: 'send', text: '   ', requestId: 'file-only' });
  const prompt = requests.find(row => row.route.endsWith('/prompt_async')).options.body;
  assert.equal(prompt.parts.length, 1);
  openCode.apply({ type: 'message.updated', properties: { info: { id: prompt.messageID, sessionID: 'ses_new', role: 'user', time: { created: 10 } } } });
  assert.equal(events.some(e => e.t === 'sent' && !e.pending), false);
  openCode.apply({ type: 'message.part.updated', properties: { part: { ...prompt.parts[0], id: 'part_file_only', messageID: prompt.messageID, sessionID: 'ses_new' } } });
  assert.equal(events.findLast(e => e.t === 'sent').pending, undefined);
});

test('a failed native OpenCode submission retains the prepared upload for retry', async t => {
  const { session } = fixture(t);
  const file = root + 'retry.txt'; fs.writeFileSync(file, 'RETRY_739');
  openCode.sessions.set('ses_one', native('ses_one'));
  await session.handle({ t: 'attach', id: 'opencode', threadId: 'ses_one' });
  uploads.set('retry', { name: 'retry.txt', path: file, pending: true, sel: session.selectionKey() });
  t.mock.method(openCode.client, 'request', async () => { throw new Error('native submission failed'); });
  await assert.rejects(session.handle({ t: 'send', text: 'read', requestId: 'retry-file' }), /native submission failed/);
  assert.equal(uploads.get('retry').pending, true);
  assert.equal(session.openCodeSends.size, 0);
});

const pageRows = (from, to) => Array.from({ length: to - from }, (_, i) => {
  const n = from + i, id = 'msg_' + String(n).padStart(3, '0');
  return { info: { id, sessionID: 'ses_one', role: 'user', time: { created: n + 1 } },
    parts: [{ id: 'part_' + n, type: 'text', text: String(n) }] };
});
test('OpenCode first view is 20 native messages, pages cached rows first, and reopening resets only the view', async t => {
  const { session, events } = fixture(t);
  openCode.sessions.set('ses_one', native('ses_one'));
  const cursors = [];
  t.mock.method(openCode.client, 'messages', async (_id, _directory, before) => {
    cursors.push(before); return { rows: before ? pageRows(0, 20) : pageRows(20, 100), before: before ? null : 'older' };
  });
  await session.handle({ t: 'attach', id: 'opencode', threadId: 'ses_one' });
  assert.deepEqual(events.findLast(row => row.t === 'chat').chat.items.map(row => row.t), Array.from({ length: 20 }, (_, n) => String(n + 80)));
  assert.equal(openCode.messages.get('ses_one').size, 80);
  for (let n = 0; n < 3; n++) await session.handle({ t: 'scrollChat', history: true, requestId: String(n) });
  assert.deepEqual(cursors, [undefined]);
  assert.equal(events.filter(row => row.t === 'historyPage').flatMap(row => row.items).length, 60);
  await session.handle({ t: 'scrollChat', history: true, requestId: 'native' });
  assert.deepEqual(cursors, [undefined, 'older']);
  assert.equal(events.findLast(row => row.t === 'historyDone').earlier, false);
  assert.equal(openCode.messages.get('ses_one').size, 100);
  await session.handle({ t: 'refresh' });
  assert.equal(events.findLast(row => row.t === 'chat').chat.items.length, 100);
  await session.handle({ t: 'attach', id: 'opencode', threadId: 'ses_one' });
  assert.equal(events.findLast(row => row.t === 'chat').chat.items.length, 20);
  assert.equal(openCode.messages.get('ses_one').size, 100);
  for (let n = 0; n < 4; n++) await session.handle({ t: 'scrollChat', history: true, requestId: 'reopen-' + n });
  assert.deepEqual(cursors, [undefined, 'older', undefined, undefined]);
  assert.equal(events.findLast(row => row.t === 'historyDone').earlier, false);
});

test('OpenCode tool detail belongs to the current view, follows native changes, and resumes after visibility changes', async t => {
  const { session, events } = fixture(t);
  for (const id of ['ses_one', 'ses_two']) openCode.sessions.set(id, native(id));
  messageText('ses_one', 'answer');
  const tool = output => ({ id: 'tool', messageID: 'msg_stream', sessionID: 'ses_one', type: 'tool', tool: 'bash',
    state: { status: 'running', input: { command: 'echo test' }, output } });
  openCode.apply({ type: 'message.part.updated', properties: { part: tool('first') } });
  await session.handle({ t: 'attach', id: 'opencode', threadId: 'ses_one' });
  const sel = session.selectionKey(), last = () => events.findLast(row => row.t === 'chat').chat.items.find(row => row.i === 'tool');
  assert.equal(last().output, undefined);
  await session.handle({ t: 'toolDetails', sel, i: 'tool', open: true });
  assert.equal(last().output, 'first');
  openCode.apply({ type: 'message.part.updated', properties: { part: tool('first\nsecond') } });
  await tick(); assert.equal(last().output, 'first\nsecond');
  await session.handle({ t: 'toolDetails', sel, i: 'tool', open: false });
  assert.equal(last().output, undefined);
  await session.handle({ t: 'toolDetails', sel, i: 'tool', open: true });
  await session.handle({ t: 'visible', v: false });
  assert.equal(session.openCodePages.get('ses_one').tools.size, 1);
  await session.handle({ t: 'visible', v: true });
  assert.equal(last().output, 'first\nsecond');
  await session.handle({ t: 'attach', id: 'opencode', threadId: 'ses_two' });
  assert.equal(session.openCodePages.get('ses_one').tools.size, 0);
  const count = events.length;
  await session.handle({ t: 'toolDetails', sel, i: 'tool', open: true });
  assert.equal(events.length, count);
});

test('OpenCode navigation during a native history read cannot deliver old rows into another session', async t => {
  const { session, events } = fixture(t);
  for (const id of ['ses_one', 'ses_two']) openCode.sessions.set(id, native(id));
  let resolve;
  t.mock.method(openCode.client, 'messages', async (id, _directory, before) => before
    ? new Promise(done => { resolve = done; }) : { rows: id === 'ses_one' ? pageRows(20, 21) : [], before: id === 'ses_one' ? 'older' : null });
  await session.handle({ t: 'attach', id: 'opencode', threadId: 'ses_one' });
  const pending = session.handle({ t: 'scrollChat', history: true, requestId: 'A' });
  await session.handle({ t: 'attach', id: 'opencode', threadId: 'ses_two' });
  resolve({ rows: pageRows(0, 20), before: null }); await pending;
  assert.equal(events.some(row => row.t === 'historyPage' && row.requestId === 'A'), false);
  assert.equal(events.findLast(row => row.t === 'chat').chat.thread, 'ses_two');
});
