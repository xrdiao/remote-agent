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
