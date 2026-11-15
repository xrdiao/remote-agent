import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { parseSessionRef } from '../lib/shared-rules.mjs';

const source = fs.readFileSync(new URL('../lib/session-library.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
function library(files = new Map(), computer = 'first') {
  let writes = 0;
  const context = vm.createContext({ path, Date, JSON, parseSessionRef, DATA_DIR: '/' + computer,
    computerId: () => computer, fs: { existsSync: p => files.has(p), readFileSync: p => files.get(p), mkdirSync() {},
      writeFileSync: (p, text) => { writes++; files.set(p, text); } } });
  vm.runInContext(source, context);
  return { api: context, files, writes: () => writes };
}
const row = (app, overrides = {}) => ({ app, threadId: 'same-id', host: '', statusKnown: true, busy: false, waiting: '',
  run: { id: 'round-1', status: 'completed', startedAt: 10, completedAt: 20 }, ...overrides });

test('all four apps retain their last confirmed status across library reload and computer boundaries', () => {
  const first = library();
  const rows = ['codex', 'cursor', 'devin', 'opencode'].map(app => row(app));
  assert.equal(first.api.rememberSessionStatuses(rows, 30), true);
  assert.equal(first.writes(), 1);
  assert.equal(first.api.rememberSessionStatuses(rows, 40), false);
  assert.equal(first.writes(), 1);
  const restored = library(first.files);
  for (const app of rows.map(r => r.app)) {
    assert.equal(restored.api.storedSessionStatus(app, 'same-id').run.status, 'completed');
    assert.equal(restored.api.storedSessionStatus(app, 'same-id').at, 30);
  }
  assert.equal(library(first.files, 'other').api.storedSessionStatus('codex', 'same-id'), null);
});

test('unknown window reads cannot replace confirmed state; newer rounds and hosts stay independent', () => {
  const { api } = library();
  api.rememberSessionStatuses([row('codex')], 30);
  api.rememberSessionStatuses([row('codex', { run: { status: 'unknown' } })], 40);
  api.rememberSessionStatuses([row('codex', { statusKnown: false, busy: true })], 50);
  api.rememberSessionStatuses([row('codex', { dormant: true })], 60);
  assert.equal(api.storedSessionStatus('codex', 'same-id').at, 30);
  api.rememberSessionStatuses([row('codex', { busy: true, run: { id: 'round-2', status: 'running', startedAt: 100 } })], 110);
  api.rememberSessionStatuses([row('codex')], 120);
  assert.equal(api.storedSessionStatus('codex', 'same-id').run.id, 'round-2');
  api.rememberSessionStatuses([row('codex', { host: 'remote', waiting: 'q:question' })], 130);
  assert.equal(api.storedSessionStatus('codex', 'same-id', 'remote').waiting, 'q:');
  assert.equal(api.storedSessionStatus('codex', 'same-id').waiting, '');
});

test('archive and delete clear recorded status without removing favorites on unrelated sessions', () => {
  const { api } = library();
  api.rememberSessionStatuses([row('cursor'), row('devin'), row('codex')]);
  api.favoriteSession('codex', 'same-id', true);
  api.publishSessionChange('cursor', 'same-id', { action: 'archive' });
  api.removeLibrarySession('devin', 'same-id');
  assert.equal(api.storedSessionStatus('cursor', 'same-id'), null);
  assert.equal(api.storedSessionStatus('devin', 'same-id'), null);
  assert.equal(api.readLibrary().codex['same-id'].favorite, true);
  api.rememberSessionStatuses([row('cursor'), row('devin')]);
  assert.equal(api.storedSessionStatus('cursor', 'same-id'), null);
  assert.equal(api.storedSessionStatus('devin', 'same-id'), null);
});

test('fresh pending questions persist despite unknown run state; older observations cannot replace them', () => {
  const first = library();
  first.api.rememberSessionStatuses([row('codex')], 30);
  const pending = row('codex', { statusKnown: false, waiting: 'question', run: { status: 'unknown' } });
  assert.equal(first.api.rememberSessionStatuses([pending], 50), true);
  const restored = library(first.files);
  assert.equal(restored.api.storedSessionStatus('codex', 'same-id').waiting, 'approval');
  assert.equal(restored.api.storedSessionStatus('codex', 'same-id').run, null);
  assert.equal(restored.api.rememberSessionStatuses([row('codex')], 40), false);
  assert.equal(restored.api.storedSessionStatus('codex', 'same-id').at, 50);
  assert.equal(restored.api.rememberSessionStatuses([row('codex', { run: null })], 60), true);
  assert.equal(restored.api.storedSessionStatus('codex', 'same-id').waiting, '');
});
