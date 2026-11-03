import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const raw = fs.readFileSync(new URL('../server/windows.mjs', import.meta.url), 'utf8');
const source = raw.slice(raw.indexOf('export const codexContextFiles'), raw.indexOf('export function codexFolder')).replace(/export /g, '');
function contextReader() {
  let now = 1_000_000, version = 0;
  const files = new Map(), holds = new Map();
  const calls = { open: 0, read: 0, close: 0, directory: 0 };
  const directory = path.join('/fixture', 'sessions');
  const virtualFs = {
    async readdir() { calls.directory++; return [...files.keys()].map(file => path.relative(directory, file)); },
    async stat(file) { return { mtimeMs: files.get(file).version }; },
    async open(file) {
      const entry = files.get(file);
      calls.open++;
      return {
        async stat() { return { ino: 1, size: entry.body.length, mtimeMs: entry.version, ctimeMs: entry.version }; },
        async read(buffer, offset, length, position) {
          if (holds.has(file)) await holds.get(file).promise;
          calls.read++;
          entry.body.copy(buffer, offset, position, position + length);
          return { bytesRead: Math.min(length, entry.body.length - position) };
        },
        async close() { calls.close++; },
      };
    },
  };
  const api = vm.runInNewContext(source + '\n({codexContext,files:codexContextFiles,checks:codexContextChecks,cache:codexContextCache,reads:codexContextReads})', {
    fs: virtualFs, path, os: { homedir: () => '/fixture' }, process: { env: { CODEX_HOME: '/fixture' } }, Date: { now: () => now }, Buffer,
  });
  function write(thread, pct, variant = 'base') {
    const file = path.join(directory, `rollout-${variant}-${thread}.jsonl`);
    const body = Buffer.from(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
      model_context_window: 100, last_token_usage: { total_tokens: pct },
    } } }) + '\n');
    files.set(file, { body, version: ++version });
    return file;
  }
  function hold(file) {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    holds.set(file, { promise });
    return () => { holds.delete(file); release(); };
  }
  return { ...api, calls, disk: files, write, hold, advance(ms) { now += ms; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function sameKeys(h) {
  assert.deepEqual([...h.files.keys()].sort(), [...h.checks.keys()].sort());
  assert.deepEqual([...h.files.keys()].sort(), [...h.cache.keys()].sort());
}

test('concurrent reads of one thread share the same request and keep other thread values separate', async () => {
  const h = contextReader(), file = h.write('one', 10), release = h.hold(file);
  h.write('two', 20);
  const a = h.codexContext('one'), b = h.codexContext('one');
  assert.equal(a, b);
  assert.equal((await h.codexContext('two')).pct, 20);
  release();
  assert.equal((await a).pct, 10);
  assert.equal(h.calls.open, 2);
  assert.equal(h.calls.close, 2);
  assert.equal(h.reads.size, 0);
});

test('unchanged file signatures reuse context while changed content refreshes it', async () => {
  const h = contextReader();
  h.write('one', 10);
  const first = await h.codexContext('one'), count = h.calls.read;
  assert.equal(await h.codexContext('one'), first);
  assert.equal(h.calls.read, count);
  h.write('one', 20);
  assert.equal((await h.codexContext('one')).pct, 20);
  assert(h.calls.read > count);
  assert.equal(h.calls.open, h.calls.close);
});

test('the existing five second file lookup selects the newest matching session file', async () => {
  const h = contextReader();
  h.write('one', 10);
  await h.codexContext('one');
  h.write('one', 20, 'newer');
  h.advance(4999);
  assert.equal((await h.codexContext('one')).pct, 10);
  h.advance(1);
  assert.equal((await h.codexContext('one')).pct, 20);
});

test('a missing session file removes all cached metadata after the existing lookup interval', async () => {
  const h = contextReader(), file = h.write('one', 10);
  await h.codexContext('one');
  h.disk.delete(file);
  h.advance(5000);
  assert.equal(await h.codexContext('one'), null);
  assert.equal(h.files.size, 0);
  assert.equal(h.checks.size, 0);
  assert.equal(h.cache.size, 0);
  assert.equal(h.reads.size, 0);
});

test('completed metadata stays within 256 threads and recent access controls eviction', async () => {
  const h = contextReader();
  for (let i = 0; i < 256; i++) { h.write('thread-' + i, i % 100); await h.codexContext('thread-' + i); }
  await h.codexContext('thread-0');
  h.write('thread-256', 56);
  await h.codexContext('thread-256');
  assert.equal(h.files.size, 256);
  assert(h.files.has('thread-0'));
  assert(!h.files.has('thread-1'));
  sameKeys(h);
  const before = h.calls.read;
  assert.equal((await h.codexContext('thread-1')).pct, 1);
  assert.equal(h.files.size, 256);
  assert(h.calls.read > before);
  sameKeys(h);
});

test('an in-flight thread is retained while other completed threads are evicted', async () => {
  const h = contextReader(), file = h.write('held', 42), release = h.hold(file);
  const pending = h.codexContext('held');
  await settle();
  for (let i = 0; i < 257; i++) { h.write('thread-' + i, i % 100); await h.codexContext('thread-' + i); }
  assert(h.files.has('held'));
  assert(h.reads.has('held'));
  assert.equal(h.files.size, 257);
  assert.equal(h.cache.size, 256);
  release();
  assert.equal((await pending).pct, 42);
  assert.equal(h.files.size, 256);
  sameKeys(h);
  assert.equal(h.calls.open, h.calls.close);
});

test('a burst of concurrent threads may exceed the cap only until completed reads are trimmed', async () => {
  const h = contextReader(), releases = [], pending = [];
  for (let i = 0; i < 260; i++) {
    releases.push(h.hold(h.write('thread-' + i, i % 100)));
    pending.push(h.codexContext('thread-' + i));
  }
  await settle();
  assert.equal(h.reads.size, 260);
  assert.equal(h.files.size, 260);
  for (const release of releases) release();
  await Promise.all(pending);
  assert.equal(h.reads.size, 0);
  assert.equal(h.files.size, 256);
  sameKeys(h);
  assert.equal(h.calls.close, 260);
});

test('a partial final JSON record preserves the existing token count parsing and closes the file', async () => {
  const h = contextReader(), file = h.write('one', 35);
  h.disk.get(file).body = Buffer.concat([h.disk.get(file).body, Buffer.from('{"type":')]);
  assert.equal((await h.codexContext('one')).pct, 35);
  assert.equal(h.calls.close, 1);
  assert.equal(h.reads.size, 0);
});
