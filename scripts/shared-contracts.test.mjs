import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { notificationTarget, notificationKey } from '../lib/shared-rules.mjs';
import { uploads, removeUpload } from '../lib/uploads.mjs';
import { read, fragment } from './page-fixture.mjs';
import { gitBlobSha } from '../server/publish/pages.mjs';

test('Live Activity forwarding retains every required Swift attribute, including the computer identity', () => {
  const source = read('push-service/index.mjs');
  const fields = fragment(source, 'const cut =', 'async function register(')
    + fragment(source, 'function liveFields(', '\nasync function live(');
  const context = vm.createContext();
  vm.runInContext(fields + ';this.convert=liveFields;', context);
  const attributes = { computer: 'computer-A', win: 'codex', windowId: 'window-A', threadId: 'thread-A', app: 'Codex', project: '/project', thread: 'Thread', pc: 'Computer' };
  const result = context.convert({ attributes, state: {} }, 100);
  assert.deepEqual(JSON.parse(JSON.stringify(result.attributes)), attributes);
  const swift = read('ios/Shared/AgentActivityAttributes.swift').split('var computer:')[1].split('var key:')[0];
  const required = ['computer', ...[...swift.matchAll(/(\w+): String/g)].map(match => match[1])];
  assert.deepEqual(required.sort(), Object.keys(result.attributes).sort());
  assert.equal(notificationKey(result.attributes), 'computer-A|codex|window-A|thread-A');
  assert.deepEqual(notificationTarget(result.attributes), notificationTarget(attributes));
  assert.notEqual(notificationKey({ ...attributes, computer: 'computer-B' }), notificationKey(attributes));
});

test('removing a staged upload deletes its UUID directory and preserves adjacent uploads', () => {
  fs.mkdirSync('_shots', { recursive: true });
  const root = fs.mkdtempSync('_shots/upload-lifecycle-');
  const own = path.join(root, 'own'), other = path.join(root, 'other');
  fs.mkdirSync(own); fs.mkdirSync(other);
  fs.writeFileSync(path.join(own, 'image.png'), 'sample');
  fs.writeFileSync(path.join(other, 'keep.txt'), 'keep');
  uploads.set('contract-own', { path: path.join(own, 'image.png') });
  try {
    removeUpload('contract-own');
    assert.equal(fs.existsSync(own), false);
    assert.equal(uploads.has('contract-own'), false);
    assert.equal(fs.readFileSync(path.join(other, 'keep.txt'), 'utf8'), 'keep');
  } finally { uploads.delete('contract-own'); fs.rmSync(root, { recursive: true, force: true }); }
});

test('Pages sync uses the selected repository and branch, uploading changed files in one tree commit', async () => {
  const calls = [];
  const context = vm.createContext({ fs, path, APP_DIR: path.resolve('app'), gitBlobSha,
    appFiles: () => ['index.html', 'js/core.js'], PUBLISH_REPO: 'unused/default', PAGES_BRANCH: 'unused',
    console: { log() {} },
    run: async (command, args, input) => {
      const route = args.find(value => value.startsWith('repos/')), body = input && JSON.parse(input);
      calls.push({ command, route, args, body });
      if (route.endsWith('/git/ref/heads/qa-branch')) return JSON.stringify({ object: { sha: 'head' } });
      if (route.endsWith('/git/commits/head')) return JSON.stringify({ tree: { sha: 'old-tree' } });
      if (route.endsWith('/git/trees/old-tree?recursive=1')) return JSON.stringify({ tree: [{ path: 'index.html', sha: gitBlobSha(fs.readFileSync('app/index.html')) }] });
      if (route.endsWith('/git/blobs')) return JSON.stringify({ sha: 'new-blob' });
      if (route.endsWith('/git/trees')) return JSON.stringify({ sha: 'new-tree' });
      if (route.endsWith('/git/commits')) return JSON.stringify({ sha: 'new-commit' });
      if (route.endsWith('/git/refs/heads/qa-branch')) return '{}';
      throw new Error('unexpected GitHub route: ' + route);
    },
  });
  vm.runInContext(fragment(read('server/publish/pages.mjs'), 'export async function syncApp(', '\nasync function readUrlDoc(').replace('export ', '') + ';this.sync=syncApp;', context);
  await context.sync(undefined, 'qa/selected', 'qa-branch');
  assert(calls.every(call => call.route.startsWith('repos/qa/selected/')));
  assert.equal(calls.filter(call => call.route.endsWith('/git/blobs')).length, 1);
  const tree = calls.find(call => call.route.endsWith('/git/trees')).body;
  assert.deepEqual(JSON.parse(JSON.stringify(tree.tree.map(row => row.path))), ['js/core.js']);
  assert.equal(tree.base_tree, 'old-tree');
  assert.equal(calls.filter(call => call.route.endsWith('/git/commits')).length, 1);
  assert.equal(calls.at(-1).body.sha, 'new-commit');
});
