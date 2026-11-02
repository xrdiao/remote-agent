import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileAction } from '../lib/file-actions.mjs';
import { readFile } from '../lib/files.mjs';
import { localFilePath } from '../lib/platform.mjs';
import { beginOperation, captureOperation, withOperation } from '../server/operations.mjs';

const base = new URL('../_shots/file-actions-tests/', import.meta.url);
await fsp.mkdir(base, { recursive: true });
async function fixture(t) {
  const directory = await fsp.mkdtemp(path.join(base.pathname, 'case-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('create, copy and move keep actual paths, contents and collision decisions', async t => {
  const directory = await fixture(t);
  const act = (action, extra = {}) => fileAction({ action, directory, ...extra });
  let result = await act('create-file', { name: '中文 文件.txt' });
  const original = result.results[0].path;
  await fsp.writeFile(original, 'original');
  result = await act('create-folder', { name: '目标' });
  const target = result.results[0].path;
  result = await act('copy', { paths: [original], directory: target });
  assert.equal(await fsp.readFile(result.results[0].path, 'utf8'), 'original');
  result = await act('copy', { paths: [original], directory: target });
  assert.match(result.results[0].path, /中文 文件 \(1\)\.txt$/);
  result = await act('move', { paths: [original], directory: target, mode: 'skip' });
  assert.equal(result.results[0].skipped, true); assert.equal(await fsp.readFile(original, 'utf8'), 'original');
  await fsp.writeFile(original, 'changed');
  result = await act('move', { paths: [original], directory: target, mode: 'replace' });
  assert.equal(result.results[0].ok, true);
  await assert.rejects(fsp.stat(original), { code: 'ENOENT' });
  assert.equal(await fsp.readFile(result.results[0].path, 'utf8'), 'changed');
});

test('a folder cannot replace itself or be pasted into its own descendant', async t => {
  const directory = await fixture(t), folder = path.join(directory, 'folder');
  await fsp.mkdir(path.join(folder, 'child'), { recursive: true });
  await fsp.writeFile(path.join(folder, 'keep'), 'keep');
  for (const destination of [directory, path.join(folder, 'child')]) {
    const result = await fileAction({ action: 'move', paths: [folder], directory: destination, mode: 'replace' });
    assert.equal(result.results[0].ok, false);
    assert.equal(await fsp.readFile(path.join(folder, 'keep'), 'utf8'), 'keep');
  }
});

test('ZIP creation and extraction preserve content, Unicode, empty directories and skip inner links', async t => {
  const directory = await fixture(t), source = path.join(directory, '来源 目录');
  await fsp.mkdir(path.join(source, '空文件夹'), { recursive: true });
  await fsp.writeFile(path.join(source, 'hello.txt'), 'hello\n');
  await fsp.symlink(source, path.join(source, 'cycle'));
  const created = await fileAction({ action: 'zip', directory, paths: [source], name: '测试.zip' });
  assert.equal(created.results[0].ok, true);
  const unpacked = await fileAction({ action: 'extract', directory, paths: [created.results[0].path] });
  assert.equal(unpacked.results[0].ok, true);
  const output = path.join(unpacked.results[0].path, path.basename(source));
  assert.equal(await fsp.readFile(path.join(output, 'hello.txt'), 'utf8'), 'hello\n');
  assert.equal((await fsp.stat(path.join(output, '空文件夹'))).isDirectory(), true);
  await assert.rejects(fsp.stat(path.join(output, 'cycle')), { code: 'ENOENT' });
  assert.equal((await fsp.readdir(directory)).some(name => name.startsWith('.remote-agent-')), false);
});

test('a failed extraction leaves an existing destination and archive unchanged', async t => {
  const directory = await fixture(t), archive = path.join(directory, 'bad.zip'), target = path.join(directory, 'bad');
  await fsp.writeFile(archive, 'invalid zip'); await fsp.mkdir(target); await fsp.writeFile(path.join(target, 'keep'), 'keep');
  const result = await fileAction({ action: 'extract', directory, paths: [archive], mode: 'replace' });
  assert.equal(result.results[0].ok, false);
  assert.equal(await fsp.readFile(path.join(target, 'keep'), 'utf8'), 'keep');
  assert.equal(await fsp.readFile(archive, 'utf8'), 'invalid zip');
  assert.equal((await fsp.readdir(directory)).some(name => name.startsWith('.remote-agent-')), false);
});

test('file operations retain partial results instead of repeating successful moves', async t => {
  const directory = await fixture(t), source = path.join(directory, 'source'), target = path.join(directory, 'target');
  await fsp.writeFile(source, 'once'); await fsp.mkdir(target);
  const result = await fileAction({ action: 'move', directory: target, paths: [source, path.join(directory, 'missing')] });
  assert.deepEqual(result.results.map(row => row.ok), [true, false]);
  const session = { deviceId: crypto.randomUUID(), app: 'codex', selectionKey: () => 'old-selection' };
  const message = { t: 'computerFileAction', operationId: crypto.randomUUID(), requestId: 'file-request' };
  const first = beginOperation(session, message);
  withOperation(first.operation, () => captureOperation(session, { t: 'computerFileDone', ok: true, ...result }));
  session.app = 'devin';
  assert.equal(beginOperation(session, message).duplicate, true);
  assert.equal(first.operation.done, true); assert.equal(first.operation.sel, '');
  assert.equal(await fsp.readFile(path.join(target, 'source'), 'utf8'), 'once');
});

test('native local images remain available after the original file and window disappear', async t => {
  const directory = await fixture(t), source = path.join(directory, 'image.png');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1kAAAAASUVORK5CYII=', 'base64');
  await fsp.writeFile(source, png);
  const code = await fsp.readFile(new URL('../server/chat-images.mjs', import.meta.url), 'utf8');
  const context = vm.createContext({ fs, path, crypto, Buffer, DATA_DIR: directory, localFilePath, readFile,
    Cdp: class { constructor() { assert.fail('local images must not reconnect to the native window'); } } });
  vm.runInContext(code.replace(/^import .*;\n/gm, '').replace(/\bexport /g, '') + '\nthis.wire=chatForWire;this.readImage=readChatImage;', context);
  const image = context.wire({ items: [{ i: 'own-image', images: [source] }] }, 'ws://native-window').items[0].images[0];
  assert.match(image, /^chat-image:/);
  const first = await context.readImage(image.slice(11));
  assert.deepEqual(await fsp.readFile(first.file), png);
  await fsp.unlink(source);
  assert.deepEqual(await fsp.readFile((await context.readImage(image.slice(11))).file), png);
});
