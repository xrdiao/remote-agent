import test from 'node:test';
import assert from 'node:assert/strict';
import { codexFileDiff } from '../lib/codex-diff.mjs';

test('native new/deleted file contents become real added/deleted lines on both protocols', () => {
  for (const change of [{ type: 'add', content: 'one\n\ntwo\n' }, { kind: { type: 'add' }, diff: 'one\n\ntwo\n' }]) {
    const result = codexFileDiff([{ path: 'new.txt', ...change }]);
    assert.equal(result.add, 3); assert.equal(result.del, 0);
    assert.deepEqual(result.diff.slice(1), [['+', 'one'], ['+', ''], ['+', 'two']]);
  }
  const removed = codexFileDiff([{ path: 'deleted.txt', type: 'delete', content: 'old\r\nlast\r\n' }]);
  assert.equal(removed.del, 2); assert.equal(removed.add, 0);
  const patch = codexFileDiff([{ path: 'new.txt', kind: { type: 'add' }, diff: '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+one\n' }]);
  assert.equal(patch.add, 1); assert.deepEqual(patch.diff.at(-1), ['+', 'one']);
});
test('all supported native patch fields share counts and missing data never invents zero counts', () => {
  for (const field of ['diff', 'unified_diff', 'unifiedDiff', 'change']) {
    const result = codexFileDiff([{ path: 'a.txt', [field]: '-before\n+after' }]);
    assert.deepEqual([result.add, result.del], [1, 1]);
  }
  for (const change of [{}, { diff: 'this is the whole file\nunchanged text' }]) {
    const result = codexFileDiff([{ path: 'unknown.txt', ...change }]);
    assert.equal(result.add, null); assert.equal(result.del, null);
    assert(!result.diff.some(([, text]) => text.includes('whole file')));
  }
  const empty = codexFileDiff([{ path: 'empty.txt', type: 'add', content: '' }]);
  assert.equal(empty.add, 0); assert.deepEqual(empty.diff.at(-1), ['…', '空文件']);
  const mixed = codexFileDiff([{ path: 'known', diff: '+one' }, { path: 'unknown' }]);
  assert.equal(mixed.add, null);
});
