import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as windows from '../lib/platform/windows.mjs';
import * as posix from '../lib/platform/posix.mjs';
import * as windowsTransfer from '../server/http/transfer/windows.mjs';
import * as posixTransfer from '../server/http/transfer/posix.mjs';
import { IS_WIN } from '../lib/platform.mjs';
import { resolveLocal } from '../lib/files.mjs';

test('Windows and POSIX retain distinct filename, root and URI rules independently of the host', () => {
  assert.equal(windows.windowsFilePath('file:///c:/Work%20Area/../Project'), 'C:/Project');
  assert.deepEqual(windows.localFileUri('\\\\server\\share\\Project'), { scheme: 'file', authority: 'server', path: '/share/Project' });
  assert.equal(posix.posixFilePath('file:///home/Case/a%5Cb'), '/home/Case/a\\b');
  for (const name of ['NUL.txt', 'report\\2026.txt', 'a:b.txt', 'trailing.']) {
    assert.equal(windows.validLocalName(name), false, name);
    assert.equal(posix.validLocalName(name), true, name);
  }
  assert.equal(windowsTransfer.parentPath('C:/'), null);
  assert.equal(windowsTransfer.parentPath('//server/share/'), null);
  assert.equal(posixTransfer.parentPath('/'), null);
  assert.equal(posixTransfer.parentPath('/home/Case'), '/home');
});

test('upload paths use their destination platform and reject navigation outside that destination', () => {
  assert.equal(windowsTransfer.uploadPath('c:\\Target', 'folder/中文.txt'), 'C:/Target/folder/中文.txt');
  assert.equal(posixTransfer.uploadPath('/target', 'folder/report\\2026.txt'), '/target/folder/report\\2026.txt');
  for (const file of ['../outside.txt', '/absolute.txt', 'folder/../outside.txt']) {
    assert.throws(() => windowsTransfer.uploadPath('C:/target', file));
    assert.throws(() => posixTransfer.uploadPath('/target', file));
  }
  assert.throws(() => windowsTransfer.uploadPath('C:/target', 'NUL.txt'));
  assert.throws(() => windowsTransfer.uploadPath('C:/target', 'D:/outside.txt'));
});

test('Ubuntu file references preserve case, backslashes, spaces, Unicode and symbolic links', { skip: IS_WIN }, async t => {
  await fs.mkdir('_shots/platform-rules', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('_shots/platform-rules/case-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ['A.txt', 'a.txt', 'report\\2026.txt', '中文 space.txt']) {
    const file = path.join(root, name);
    await fs.writeFile(file, name);
    assert.equal((await resolveLocal({ root, host: '' }, name)).path, file);
    assert.equal((await resolveLocal({ root, host: '' }, pathToFileURL(file).href)).path, file);
  }
  await fs.symlink(path.join(root, 'A.txt'), path.join(root, 'alias.txt'));
  assert.equal((await resolveLocal({ root, host: '' }, 'alias.txt')).path, path.join(root, 'alias.txt'));
});
