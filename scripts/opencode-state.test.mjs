import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeState } from '../server/opencode/state.mjs';

const native = (id, directory = '/project') => ({ id, directory, title: id, time: { created: 1, updated: 2 } });
const info = { id: 'msg_1', sessionID: 'ses_1', role: 'assistant', time: { created: 10 } };
const part = { id: 'prt_1', messageID: 'msg_1', sessionID: 'ses_1', type: 'text', text: 'A' };

test('OpenCode snapshot merging preserves deltas that arrive during a history read', async () => {
  let complete;
  const state = new OpenCodeState({ messages: () => new Promise(resolve => { complete = resolve; }) });
  state.sessions.set('ses_1', native('ses_1'));
  state.apply({ type: 'message.updated', properties: { info } });
  state.apply({ type: 'message.part.updated', properties: { part } });
  const read = state.loadMessages('ses_1');
  state.apply({ type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_1', partID: 'prt_1', field: 'text', delta: 'B' } });
  complete({ rows: [{ info, parts: [{ ...part, text: 'AB' }] }], before: 'older' });
  await read;
  assert.equal(state.chat('ses_1').items[0].t, 'AB');
  assert.equal(state.chat('ses_other').items.length, 0);
});

test('OpenCode permissions and questions stay with their native sessions and disappear after replies', () => {
  const state = new OpenCodeState();
  state.sessions.set('ses_1', native('ses_1'));
  state.sessions.set('ses_2', native('ses_2', '/other'));
  state.apply({ type: 'permission.asked', properties: { id: 'per_1', sessionID: 'ses_1', permission: 'edit', patterns: ['file.py'], metadata: { diff: '-bad\n+good' } } });
  state.apply({ type: 'question.asked', properties: { id: 'que_2', sessionID: 'ses_2', questions: [{ question: '选择？', options: [{ label: 'A' }] }] } });
  assert.equal(state.chat('ses_1').waiting, 'approval');
  assert.equal(state.chat('ses_2').waiting, 'question');
  assert.deepEqual(state.chat('ses_1').items[0].actions, ['once', 'reject']);
  assert.equal(state.chat('ses_2').items[0].requestID, 'que_2');
  state.apply({ type: 'permission.replied', properties: { requestID: 'per_1', sessionID: 'ses_1' } });
  state.apply({ type: 'question.rejected', properties: { requestID: 'que_2', sessionID: 'ses_2' } });
  assert.equal(state.chat('ses_1').waiting, '');
  assert.equal(state.chat('ses_2').waiting, '');
});

test('OpenCode tool records preserve real file paths, patches, command output and errors', () => {
  const state = new OpenCodeState();
  state.sessions.set('ses_1', native('ses_1'));
  state.apply({ type: 'message.updated', properties: { info } });
  state.apply({ type: 'message.part.updated', properties: { part: { ...part, type: 'tool', tool: 'edit', state: {
    status: 'completed', input: { filePath: '/project/file.py' }, metadata: { diff: '--- a\n+++ b\n@@ -1 +1 @@\n-bad\n+good' },
  } } } });
  state.apply({ type: 'message.part.updated', properties: { part: { ...part, id: 'prt_2', type: 'tool', tool: 'bash', state: {
    status: 'error', input: { command: 'python3 test.py' }, error: 'exit code 1',
  } } } });
  const [edit, command] = state.chat('ses_1').items;
  assert.equal(edit.f, '/project/file.py');
  assert.deepEqual(edit.diff, [['-', 'bad'], ['+', 'good']]);
  assert.equal(edit.done, false);
  assert.equal(command.cmd, 'python3 test.py');
  assert.equal(command.output, 'exit code 1');
  assert.equal(command.keep, true);
});

test('OpenCode overview groups sessions by directory and excludes archived and child sessions', () => {
  const state = new OpenCodeState();
  for (const row of [native('ses_1'), native('ses_2'), native('ses_3', '/other')])
    state.apply({ type: 'session.created', properties: { info: row } });
  state.apply({ type: 'session.created', properties: { info: { ...native('ses_child'), parentID: 'ses_1' } } });
  state.apply({ type: 'session.updated', properties: { info: { ...native('ses_2'), time: { updated: 3, archived: 3 } } } });
  assert.equal(state.overview().windows.length, 2);
  assert.deepEqual(state.overview().sessions.map(row => row.threadId), ['ses_1', 'ses_3']);
});

test('automatic approvals process pending and future requests once, leaving other sessions and questions alone', async () => {
  const requests = [];
  let finish;
  const state = new OpenCodeState({ request: (route, options) => {
    requests.push({ route, options });
    return new Promise(resolve => { finish = resolve; });
  } });
  state.sessions.set('ses_1', native('ses_1'));
  state.sessions.set('ses_2', native('ses_2', '/other'));
  const ask = (id, sessionID = 'ses_1') => state.apply({ type: 'permission.asked', properties: { id, sessionID, permission: 'bash', patterns: ['echo test'], metadata: {} } });
  ask('per_pending'); ask('per_other', 'ses_2');
  state.setAutomatic('ses_1', true);
  state.setAutomatic('ses_1', true);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { route: '/permission/per_pending/reply', options: { directory: '/project', method: 'POST', body: { reply: 'once' } } });
  finish(); await Promise.all(state.autoReplies.values());
  assert.equal(state.permissions.has('per_pending'), false);
  assert.equal(state.permissions.has('per_other'), true);
  ask('per_future');
  assert.equal(requests.length, 2);
  finish(); await Promise.all(state.autoReplies.values());
  state.apply({ type: 'question.asked', properties: { id: 'que_1', sessionID: 'ses_1', questions: [{ question: 'Choose' }] } });
  assert.equal(requests.length, 2);
  assert.equal(state.chat('ses_1').waiting, 'question');
  state.setAutomatic('ses_1', false);
  ask('per_manual');
  assert.equal(requests.length, 2);
  assert.equal(state.permissions.has('per_manual'), true);
  state.setAutomatic('ses_2', true);
  finish(); await Promise.all(state.autoReplies.values());
  state.close();
  assert.equal(state.approvalMode('ses_2'), '自动审批');
});

test('failed automatic approvals remain visible for manual handling without a retry loop', async () => {
  let calls = 0;
  const state = new OpenCodeState({ request: async () => { calls++; throw new Error('native failure'); } });
  state.sessions.set('ses_1', native('ses_1'));
  state.setAutomatic('ses_1', true);
  state.apply({ type: 'permission.asked', properties: { id: 'per_1', sessionID: 'ses_1', permission: 'edit', patterns: ['x'], metadata: {} } });
  await Promise.all(state.autoReplies.values());
  assert.equal(calls, 1);
  assert.equal(state.permissions.has('per_1'), true);
  assert.match(state.chat('ses_1').items[0].output, /自动审批失败：native failure/);
  state.apply({ type: 'permission.replied', properties: { requestID: 'per_1', sessionID: 'ses_1' } });
  assert.equal(state.approvalErrors.size, 0);
});

test('OpenCode context uses the last valid native call and its actual model limit rather than session totals or the next selected model', () => {
  const state = new OpenCodeState();
  state.defaultModel = 'local/bonsai';
  state.models.set('local/bonsai', { name: 'Bonsai', limit: { context: 131072 } });
  state.models.set('other/model', { name: 'Other', limit: { context: 1000 } });
  state.sessions.set('ses_1', { ...native('ses_1'), tokens: { total: 999999 } });
  assert.equal(state.context('ses_1').used, null);
  assert.equal(state.context('ses_1').limit, 131072);
  assert.equal(state.context('ses_1').durationMs, null);
  assert.equal(state.context('ses_1').speedTokS, null);
  assert.equal(state.context('ses_1').cacheRate, null);
  assert.equal(state.context('ses_1').tokens, null);
  const update = (id, created, tokens, completed = created + 1) => state.apply({ type: 'message.updated', properties: { info: {
    id, sessionID: 'ses_1', role: 'assistant', providerID: 'local', modelID: 'bonsai', time: { created, completed }, tokens,
  } } });
  update('msg_1', 10, { total: 99999, input: 7000, output: 100, reasoning: 200, cache: { read: 300, write: 400 } });
  const usage = state.context('ses_1');
  assert.equal(usage.used, 8000);
  assert.equal(usage.pct, 6.1);
  assert.equal(usage.updated, 11);
  assert.equal(usage.durationMs, 1);
  assert.equal(usage.speedTokS, 300000);
  assert.equal(usage.cacheRate, 3.9);
  assert.deepEqual(usage.tokens, { total: 99999, input: 7000, output: 100, reasoning: 200, cache: { read: 300, write: 400 } });
  state.selections.set('ses_1', { key: 'other/model', variant: '' });
  assert.deepEqual(state.context('ses_1'), usage);
  update('msg_2', 20, { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
  assert.deepEqual(state.context('ses_1'), usage);
  update('msg_2', 20, { input: 10000, output: 100, reasoning: 200, cache: { read: 300, write: 400 } }, null);
  assert.deepEqual(state.context('ses_1'), usage);
  update('msg_2', 20, { input: 10000, output: 100, reasoning: 200, cache: { read: 300, write: 400 } });
  assert.equal(state.context('ses_1').used, 11000);
  assert.equal(state.context('ses_2').used, null);
});

test('OpenCode live performance counts streamed Unicode text and reasoning once, then uses native completed tokens', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const state = new OpenCodeState();
  state.models.set('local/bonsai', { name: 'Bonsai', limit: { context: 1000 } });
  state.sessions.set('ses_1', native('ses_1'));
  state.statuses.set('ses_1', { type: 'busy' });
  const message = { id: 'msg_live', sessionID: 'ses_1', role: 'assistant', providerID: 'local', modelID: 'bonsai', time: { created: 1000 } };
  const update = info => state.apply({ type: 'message.updated', properties: { info } });
  const part = (id, type, text) => ({ id, type, text, sessionID: 'ses_1', messageID: 'msg_live' });
  const full = p => state.apply({ type: 'message.part.updated', properties: { part: p } });
  const delta = (id, text) => state.apply({ type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_live', partID: id, field: 'text', delta: text } });
  update(message);
  assert.equal(state.chat('ses_1').performance.rate, null);
  full(part('text', 'text', ''));
  delta('text', 'H😀');
  assert.equal(state.chat('ses_1').performance.rate, null);
  now = 2000; delta('text', '世界');
  let perf = state.chat('ses_1').performance;
  assert.equal(perf.unit, 'characters'); assert.equal(perf.rate, 2); assert.equal(perf.durationMs, 1000);
  assert.equal(perf.tokens, null); assert.equal(state.context('ses_1').used, null);
  full(part('text', 'text', 'H😀世界'));
  now = 3000; full(part('reason', 'reasoning', '想'));
  assert.equal(state.chat('ses_1').performance.rate, 1.5);
  full({ ...part('synthetic', 'text', '不计入统计'), synthetic: true });
  full({ ...part('tool', 'tool', '不计入统计'), tool: 'bash', state: { status: 'completed', input: {} } });
  assert.equal(state.chat('ses_1').performance.rate, 1.5);
  state.client.messages = async () => ({ rows: [{ info: message, parts: [part('text', 'text', 'H😀世界'), part('reason', 'reasoning', '想')] }], before: null });
  await state.loadMessages('ses_1');
  assert.equal(state.chat('ses_1').performance.rate, 1.5);
  update({ ...message, time: { created: 1000, completed: 4000 }, tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 0 } } });
  perf = state.chat('ses_1').performance;
  assert.equal(perf.unit, 'tokens'); assert.equal(perf.rate, 2); assert.equal(perf.durationMs, 3000);
  assert.equal(perf.tokens.reasoning, 2); assert.equal(perf.tokens.output, 4); assert.equal(perf.model, 'Bonsai');
  assert.equal(state.context('ses_1').used, 19);
  now = 5000; update({ ...message, id: 'msg_next', time: { created: 5000 } });
  assert.equal(state.chat('ses_1').performance.runId, 'msg_next');
  assert.equal(state.chat('ses_1').performance.rate, null);
  assert.equal(state.context('ses_1').used, 19);
  state.statuses.set('ses_1', { type: 'idle' });
  assert.equal(state.chat('ses_1').performance.runId, 'msg_live');
});

test('OpenCode output samples remain owned by their message and session, including removal and restarted observation', t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const state = new OpenCodeState();
  for (const id of ['A', 'B']) {
    state.sessions.set(id, native(id)); state.statuses.set(id, { type: 'busy' });
    state.apply({ type: 'message.updated', properties: { info: { id: 'same', sessionID: id, role: 'assistant', time: { created: 1 } } } });
    state.apply({ type: 'message.part.updated', properties: { part: { id: 'text', sessionID: id, messageID: 'same', type: 'text', text: 'a' } } });
  }
  now = 2000;
  state.apply({ type: 'message.part.delta', properties: { sessionID: 'A', messageID: 'same', partID: 'text', field: 'text', delta: 'bc' } });
  assert.equal(state.chat('A').performance.rate, 2); assert.equal(state.chat('B').performance.rate, null);
  state.apply({ type: 'message.part.removed', properties: { sessionID: 'A', messageID: 'same', partID: 'text' } });
  assert.equal(state.message('A', 'same').outputSample.chars, 0);
  state.apply({ type: 'message.removed', properties: { sessionID: 'A', messageID: 'same' } });
  assert.equal(state.chat('A').performance, null);
  state.apply({ type: 'session.deleted', properties: { info: native('B') } });
  assert.equal(state.messages.has('B'), false);
});

test('joining an OpenCode generation excludes the existing history prefix from the observed character rate', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const info = { id: 'live', sessionID: 'A', role: 'assistant', time: { created: 1 } };
  const state = new OpenCodeState({ messages: async () => ({ rows: [{ info, parts: [
    { id: 'reason', sessionID: 'A', messageID: 'live', type: 'reasoning', text: '旧思考' },
    { id: 'text', sessionID: 'A', messageID: 'live', type: 'text', text: '旧回复' },
  ] }], before: null }) });
  state.sessions.set('A', native('A')); state.statuses.set('A', { type: 'busy' });
  await state.loadMessages('A');
  assert.equal(state.message('A', 'live').outputSample, undefined);
  const delta = text => state.apply({ type: 'message.part.delta', properties: { sessionID: 'A', messageID: 'live', partID: 'text', field: 'text', delta: text } });
  now = 2000; delta('新'); assert.equal(state.chat('A').performance.rate, null);
  now = 3000; delta('增加'); assert.equal(state.chat('A').performance.rate, 2);
});

test('OpenCode approval modes survive restart and remove saved automatic modes when switched to manual or deleted', () => {
  let saved = [];
  const restore = () => new OpenCodeState({}, saved, ids => { saved = ids; });
  const first = restore();
  first.setAutomatic('ses_auto', true);
  first.close();
  const restarted = restore();
  assert.equal(restarted.approvalMode('ses_auto'), '自动审批');
  assert.equal(restarted.approvalMode('ses_new'), '手动审批');
  restarted.setAutomatic('ses_auto', false);
  restarted.close();
  assert.equal(restore().approvalMode('ses_auto'), '手动审批');
  restarted.setAutomatic('ses_deleted', true);
  restarted.apply({ type: 'session.deleted', properties: { info: native('ses_deleted') } });
  assert.equal(restore().approvalMode('ses_deleted'), '手动审批');
});

test('OpenCode restores saved modes before processing pending approvals during startup', async () => {
  const replies = [];
  const pending = ['ses_auto', 'ses_manual'].map(id => ({ id: 'per_' + id, sessionID: id, permission: 'bash', patterns: ['printf test'], metadata: {} }));
  const client = {
    sessions: async () => ['ses_auto', 'ses_manual'].map(id => native(id)),
    request: async (route, options) => {
      if (route === '/global/event') return new Response(new ReadableStream({ start(controller) {
        options.signal.addEventListener('abort', () => controller.close(), { once: true });
      } }));
      if (route === '/config/providers') return { providers: [] };
      if (route === '/permission') return pending;
      if (route === '/question') return [{ id: 'que_1', sessionID: 'ses_auto' }];
      if (route.endsWith('/reply')) replies.push({ route, options });
      return {};
    },
  };
  const state = new OpenCodeState(client, ['ses_auto']);
  try {
    await state.connect();
    await Promise.all(state.autoReplies.values());
    assert.deepEqual(replies.map(row => row.route), ['/permission/per_ses_auto/reply']);
    assert.deepEqual(replies[0].options.body, { reply: 'once' });
    assert.equal(state.permissions.has('per_ses_manual'), true);
    assert.equal(state.questions.has('que_1'), true);
  } finally { state.close(); }
});

test('OpenCode skips synthetic users and empty assistant parts while keeping real attachments and errors', () => {
  const state = new OpenCodeState();
  state.sessions.set('ses_1', native('ses_1'));
  const add = (id, role, parts, error) => {
    state.apply({ type: 'message.updated', properties: { info: { ...info, id, role, error } } });
    for (const p of parts) state.apply({ type: 'message.part.updated', properties: { part: { ...part, ...p, messageID: id } } });
  };
  add('synthetic', 'user', [{ id: 's', synthetic: true, text: 'Continue' }]);
  add('empty', 'assistant', [{ id: 'e', text: ' ' }, { id: 'r', type: 'reasoning', text: '' }]);
  add('file', 'user', [{ id: 'f', type: 'file', filename: 'notes.txt', mime: 'text/plain', url: 'file:///notes.txt' }]);
  add('image', 'user', [{ id: 'im', type: 'file', filename: 'icon.png', mime: 'image/png', url: 'data:image/png;base64,AA==' }]);
  add('error', 'assistant', [], { name: 'MessageAbortedError', data: { message: '已中止' } });
  const items = state.chat('ses_1').items;
  assert.equal(items.some(row => ['synthetic', 'e', 'r'].includes(row.i)), false);
  assert.equal(items.find(row => row.i === 'file').t, '[附件：notes.txt]');
  assert.deepEqual(items.find(row => row.i === 'image').images, ['data:image/png;base64,AA==']);
  assert.equal(items.find(row => row.i === 'error:error').t, '已中止');
});

test('OpenCode tool summaries omit bodies without changing native detail or approval data', () => {
  const state = new OpenCodeState();
  state.sessions.set('ses_1', native('ses_1'));
  state.apply({ type: 'message.updated', properties: { info } });
  state.apply({ type: 'message.part.updated', properties: { part: { ...part, type: 'tool', tool: 'edit', state: {
    status: 'completed', input: { filePath: '/a' }, output: 'full output', metadata: { diff: '--- a\n+++ b\n-a\n+b' },
  } } } });
  state.permissions.set('p', { id: 'p', sessionID: 'ses_1', permission: 'edit', patterns: ['/a'], metadata: { diff: 'approval diff' } });
  const compact = state.chat('ses_1', { tools: new Set() }).items;
  assert.equal(compact[0].output, undefined); assert.equal(compact[0].diff, undefined);
  assert.equal(compact[0].add, 1); assert.equal(compact[0].del, 1);
  assert.equal(compact[1].output, 'approval diff'); assert.deepEqual(compact[1].actions, ['once', 'reject']);
  const full = state.chat('ses_1', { tools: new Set(['prt_1']) }).items[0];
  assert.equal(full.output, 'full output'); assert.deepEqual(full.diff, [['-', 'a'], ['+', 'b']]);
  assert.equal(state.messages.get('ses_1').get('msg_1').parts.get('prt_1').state.output, 'full output');
});

test('OpenCode shared history cursor does not move forward when an overview reloads the latest page', async () => {
  let page;
  const state = new OpenCodeState({ messages: async () => page });
  state.sessions.set('ses_1', native('ses_1'));
  const row = n => ({ info: { ...info, id: 'msg_' + n, time: { created: n } }, parts: [] });
  page = { rows: [row(20), row(40)], before: 'before20' }; await state.loadMessages('ses_1');
  page = { rows: [row(1), row(10)], before: 'before1' }; await state.loadMessages('ses_1', 'before20');
  page = { rows: [row(20), row(40)], before: 'before20' }; await state.loadMessages('ses_1');
  assert.equal(state.historyPages.get('ses_1').before, 'before1');
  page = { rows: [], before: null }; await state.loadMessages('ses_1', 'before1');
  page = { rows: [row(40)], before: 'before40' }; await state.loadMessages('ses_1');
  assert.equal(state.historyPages.get('ses_1').before, null);
});
