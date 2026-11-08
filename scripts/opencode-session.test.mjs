import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL(`../_shots/opencode-tests-${process.pid}/`, import.meta.url));
fs.mkdirSync(root, { recursive: true });
const homedir = os.homedir;
os.homedir = () => root;
const { Session } = await import('../server/session.mjs');
const { openCode } = await import('../server/opencode/state.mjs');
os.homedir = homedir;
test.after(() => { openCode.close(); fs.rmSync(root, { recursive: true, force: true }); });

const native = id => ({ id, directory: root.slice(0, -1), title: id, time: { created: 1, updated: 2 } });
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  for (const map of [openCode.sessions, openCode.messages, openCode.statuses, openCode.permissions, openCode.questions, openCode.models, openCode.selections]) map.clear();
  openCode.listeners.clear();
  openCode.connected = true;
  openCode.defaultModel = 'local/model';
  openCode.models.set('local/model', { id: 'model', providerID: 'local', name: 'Local Model', label: 'Local / Model', variants: { high: {} } });
  t.mock.method(openCode, 'connect', async () => {});
  t.mock.method(openCode.client, 'messages', async () => ({ rows: [], before: null }));
  const events = [], requests = [];
  t.mock.method(openCode.client, 'request', async (route, options) => {
    requests.push({ route, options });
    if (route === '/session') return native('ses_new');
    return null;
  });
  const session = new Session({ readyState: 1, send: raw => events.push(JSON.parse(raw)) }, 'opencode-test');
  t.after(() => session.dispose());
  return { session, events, requests };
}

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
  assert.deepEqual(events.find(row => row.t === 'historyPage').items.map(row => row.t), ['older', 'newer']);
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
