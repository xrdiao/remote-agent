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
import { read } from './page-fixture.mjs';
import { beginOperation, captureOperation, withOperation } from '../server/operations.mjs';

const base = new URL('../_shots/file-actions-tests/', import.meta.url);
await fsp.mkdir(base, { recursive: true });
async function fixture(t) {
  const directory = await fsp.mkdtemp(path.join(localFilePath(base.pathname), 'case-'));
  t.after(() => fsp.rm(directory, {
    recursive: true, force: true, maxRetries: process.platform === 'win32' ? 12 : 0,
  }));
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

test('ZIP creation and extraction preserve content, Unicode and empty directories', async t => {
  const directory = await fixture(t), source = path.join(directory, '来源 目录');
  await fsp.mkdir(path.join(source, '空文件夹'), { recursive: true });
  await fsp.writeFile(path.join(source, 'hello.txt'), 'hello\n');
  const created = await fileAction({ action: 'zip', directory, paths: [source], name: '测试.zip' });
  assert.equal(created.results[0].ok, true);
  const unpacked = await fileAction({ action: 'extract', directory, paths: [created.results[0].path] });
  assert.equal(unpacked.results[0].ok, true);
  const output = path.join(unpacked.results[0].path, path.basename(source));
  assert.equal(await fsp.readFile(path.join(output, 'hello.txt'), 'utf8'), 'hello\n');
  assert.equal((await fsp.stat(path.join(output, '空文件夹'))).isDirectory(), true);
  assert.equal((await fsp.readdir(directory)).some(name => name.startsWith('.remote-agent-')), false);
});

test('ZIP creation excludes inner directory links', async t => {
  const directory = await fixture(t), source = path.join(directory, 'source');
  await fsp.mkdir(source);
  await fsp.writeFile(path.join(source, 'keep.txt'), 'keep');
  try { await fsp.symlink(source, path.join(source, 'cycle'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EISDIR', 'ENOTSUP', 'EPERM'].includes(error.code)) { t.skip('当前文件系统或权限不支持目录链接：' + error.code); return; }
    throw error;
  }
  const created = await fileAction({ action: 'zip', directory, paths: [source], name: 'links.zip' });
  assert.equal(created.results[0].ok, true);
  const unpacked = await fileAction({ action: 'extract', directory, paths: [created.results[0].path] });
  assert.equal(unpacked.results[0].ok, true);
  const output = path.join(unpacked.results[0].path, 'source');
  assert.equal(await fsp.readFile(path.join(output, 'keep.txt'), 'utf8'), 'keep');
  await assert.rejects(fsp.stat(path.join(output, 'cycle')), { code: 'ENOENT' });
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

async function chatImageContext(directory, Cdp) {
  const code = read('server/chat-images.mjs');
  const context = vm.createContext({ fs, path, crypto, Buffer, DATA_DIR: directory, localFilePath, readFile, Cdp, helpersCall: code => code });
  vm.runInContext(code.replace(/^import .*;\n/gm, '').replace(/\bexport /g, '') + '\nthis.wire=chatForWire;this.readImage=readChatImage;', context);
  return context;
}

test('native local images remain available after the original file and window disappear', async t => {
  const directory = await fixture(t), source = path.join(directory, 'image.png');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1kAAAAASUVORK5CYII=', 'base64');
  await fsp.writeFile(source, png);
  const context = await chatImageContext(directory, class { constructor() { assert.fail('local images must not reconnect to the native window'); } });
  const image = context.wire({ items: [{ i: 'own-image', images: [source] }] }, 'ws://native-window').items[0].images[0];
  assert.match(image, /^chat-image:/);
  const first = await context.readImage(image.slice(11));
  assert.deepEqual(await fsp.readFile(first.file), png);
  await fsp.unlink(source);
  assert.deepEqual(await fsp.readFile((await context.readImage(image.slice(11))).file), png);
});

test('native image fetch failures reject without rewriting the source record and close CDP', async t => {
  const directory = await fixture(t);
  let closed = 0;
  const context = await chatImageContext(directory, class {
    async connect() {}
    async evaluate() { throw new TypeError('Failed to fetch'); }
    close() { closed++; }
  });
  const source = 'https://example.invalid/favicon.png';
  const id = context.wire({ items: [{ images: [source] }] }, 'ws://native-window').items[0].images[0].slice(11);
  const file = path.join(directory, 'chat-images', id), before = await fsp.readFile(file);
  assert.deepEqual(JSON.parse(before), { wsUrl: 'ws://native-window', source });
  await assert.rejects(context.readImage(id), { name: 'TypeError', message: 'Failed to fetch' });
  assert.equal(closed, 1);
  assert.deepEqual(await fsp.readFile(file), before);
});

test('chat-image HTTP failures return 502 while missing and successful images keep their responses', async t => {
  const directory = await fixture(t);
  const context = await chatImageContext(directory, class {
    async connect() {}
    async evaluate() { throw new TypeError('Failed to fetch'); }
    close() {}
  });
  Object.assign(context, {
    clientIp: () => '127.0.0.1', authenticateRequest: () => ({ id: 'paired-device' }), needsTotp: () => false,
    json: (req, res, status, body) => { res.status = status; res.body = JSON.stringify(body); },
    SECURITY_HEADERS: {}, corsHeaders: () => ({}),
    fs: { ...fs, createReadStream: file => ({ pipe: res => { res.file = file; return res; } }) },
  });
  const code = await fsp.readFile(new URL('../server/http/api.mjs', import.meta.url), 'utf8');
  vm.runInContext(code.replace(/^import .*;\n/gm, '').replace(/\bexport /g, '') + '\nthis.api=handleApi;', context);
  const request = async id => {
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers; } };
    await context.api({ method: 'GET', headers: {} }, res, '/api/chat-image/' + id);
    return res;
  };
  const failedId = context.wire({ items: [{ images: ['https://example.invalid/favicon.png'] }] }, 'ws://native-window').items[0].images[0].slice(11);
  const failed = await request(failedId);
  assert.equal(failed.status, 502);
  assert.deepEqual(JSON.parse(failed.body), { error: 'Failed to fetch' });
  const missing = await request('a'.repeat(64) + '.png');
  assert.equal(missing.status, 404);
  assert.deepEqual(JSON.parse(missing.body), { error: '图片不存在' });
  const imageId = context.wire({ items: [{ images: ['data:image/png;base64,aW1hZ2U='] }] }).items[0].images[0].slice(11);
  const success = await request(imageId);
  assert.equal(success.status, 200);
  assert.equal(success.headers['content-type'], 'image/png');
  assert.equal(success.file, path.join(directory, 'chat-images', imageId));
  assert.equal(await fsp.readFile(success.file, 'utf8'), 'image');
});

function transferFixture(conversation = false) {
  const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const elements = new Map(), listeners = new Map(), stored = new Map(), requests = [], uploads = [], operations = [], created = [];
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set(), children = new Map();
      elements.set(id, { hidden: false, value: '', textContent: '', innerHTML: '',
        classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x), toggle() {} },
        setAttribute() {}, append() {}, remove() {}, replaceChildren() {}, click() { this.onclick?.(); },
        querySelector(selector) { if (!children.has(selector)) children.set(selector, element(id + selector)); return children.get(selector); },
        querySelectorAll: () => [],
      });
    }
    return elements.get(id);
  }
  const computers = ['a', 'b'].map(id => ({ id, name: id, key: 'key-' + id, relay: 'https://' + id + '.invalid' }));
  const sockets = new Map(computers.map(c => [c.key, { authed: true, auth: { device: 'device-' + c.id }, socket: { readyState: 1 } }]));
  const states = [{ ov: { level: 'favorites', open: 'saved-card' }, ovScroll: 173, ovDepth: 0 }];
  let index = 0, selected = computers[0];
  if (conversation) { states.push({ ...states[0], ovConv: true, ovDepth: 1 }); index++; element('body').classList.add('conv'); }
  function navigate(step) {
    index += step;
    for (const listener of listeners.get('popstate') || []) listener();
  }
  const history = { get state() { return states[index]; }, get length() { return states.length; },
    replaceState(state) { states[index] = structuredClone(state); },
    pushState(state) { states.splice(++index); states.push(structuredClone(state)); },
    back: () => navigate(-1), forward: () => navigate(1),
  };
  const response = url => {
    const parsed = new URL(url), owner = parsed.hostname[0], directory = parsed.searchParams.get('path') || '/home/' + owner;
    const data = parsed.pathname.endsWith('/download') ? { url: '/download/own-file', name: 'own-file.txt' }
      : { home: '/home/' + owner, path: directory, parent: '/', entries: [], roots: ['/'] };
    return { ok: true, json: async () => data };
  };
  const context = vm.createContext({
    URLSearchParams, AbortController, crypto, setTimeout, clearTimeout, history,
    base: computers[0].relay, pending: null, currentComputer: () => selected, loadComputers: () => computers,
    computerSockets: sockets, store: { get: key => stored.get(key), set: (key, value) => stored.set(key, value) },
    document: { body: element('body'), createElement(tag) { const node = element('created-' + elements.size); node.tagName = tag; created.push(node); return node; } }, $: element,
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(listener); },
    esc: text => text, fmtSize: size => String(size), fileEntryIcon: () => '', closeSheet() {},
    ovSaveHistory() {}, ovMountComposerControls() {}, ovVisible() {},
    ovLeave() { element('body').classList.remove('conv'); }, ovRestore() {},
    entryHeaders: async computer => ({ 'X-Test-Computer': computer.id }),
    fetch: async (url, opts) => { requests.push({ url, opts }); return response(url); },
    sendDesktopOperation: (message, computer, socket, pending) => operations.push({ message, computer, socket, pending }),
    XMLHttpRequest: class {
      constructor() { this.upload = {}; this.headers = {}; uploads.push(this); }
      open(method, url) { this.method = method; this.url = url; }
      setRequestHeader(key, value) { this.headers[key] = value; }
      send(file) { this.file = file; this.status = 200; this.responseText = '{}'; this.onload(); this.onloadend(); }
    },
  });
  const net = read('app/js/net.js'), overview = read('app/js/overview.js');
  vm.runInContext(net.slice(net.indexOf('async function api('), net.indexOf('\nconst post =')), context);
  const pop = overview.indexOf("addEventListener('popstate', () => {");
  vm.runInContext(overview.slice(pop, overview.indexOf("\ndocument.addEventListener('visibilitychange'", pop)), context);
  vm.runInContext(read('app/js/ui-helpers.js') + read('app/js/transfer.js'), context);
  element('transferCollision').value = 'rename';
  const run = code => vm.runInContext(code, context);
  return { run, context, element, computers, sockets, requests, uploads, operations, response, history, created,
    select: computer => { selected = computer; },
  };
}

test('file transfer has its own history and returns to its originating conversation or board', async () => {
  for (const conversation of [true, false]) {
    const h = transferFixture(conversation), original = structuredClone(h.history.state), length = h.history.length;
    for (const close of [() => h.element('transferClose').click(), () => h.history.back()]) {
      await h.run('openTransfer()');
      assert.equal(h.history.length, length + 1);
      await h.run('openTransfer()');
      assert.equal(h.history.length, length + 1);
      assert.equal(h.history.state.transfer, 'a');
      close();
      assert.equal(h.run('transferPanel.hidden'), true);
      assert.equal(h.element('body').classList.contains('conv'), conversation);
      assert.deepEqual(h.history.state, original);
      h.history.forward();
      assert.equal(h.run('transferPanel.hidden'), false);
      assert.equal(h.run('transferComputer.id'), 'a');
      h.history.back();
    }
  }
});

test('directory picker cancel stays in transfer and late reads cannot replace another computer', async () => {
  const h = transferFixture(true);
  await h.run('openTransfer("b")');
  h.run('transferSwitchTab("upload")');
  h.element('transferChangeTarget').click();
  await new Promise(setImmediate);
  h.element('transferClose').click();
  assert.equal(h.history.state.transfer, 'b');
  assert.equal(h.run('transferPicker'), null);
  assert.equal(h.run('transferPanel.hidden'), false);
  const { promise, resolve } = Promise.withResolvers();
  h.context.fetch = async () => promise;
  const pending = h.run('transferBrowse("/late-b")');
  h.history.back();
  h.context.fetch = async url => h.response(url);
  await h.run('openTransfer("a")');
  resolve(h.response('https://b.invalid/api/transfer/list?path=/late-b'));
  await pending;
  assert.equal(h.run('transferDirectory.path'), '/home/a');
  assert.equal(h.run('transferComputer.id'), 'a');
  assert.equal(h.run('transferPicker'), null);
});

test('computer entry owns browse, download, uploads, file operations and preferences without selecting it', async () => {
  const h = transferFixture();
  await h.run('openTransfer("b")');
  assert.equal(h.history.state.transfer, 'b');
  assert.equal(h.run('currentComputer().id'), 'a');
  assert.equal(h.requests[0].url, 'https://b.invalid/api/transfer/list?path=');
  h.run('transferSelection.set("/home/b/own-file.txt", {name:"own-file.txt"})');
  await h.element('transferDownload').onclick();
  const download = h.requests.find(r => r.url.endsWith('/download'));
  assert.equal(download.url, 'https://b.invalid/api/transfer/download');
  assert.equal(download.opts.headers['X-Test-Computer'], 'b');
  assert.equal(h.created.find(node => node.tagName === 'a').href, 'https://b.invalid/download/own-file');
  h.run('chooseTransferFiles([{name:"upload.txt",size:4}]);transferFileAction("create-file", {name:"created.txt"})');
  assert.equal(h.operations.length, 1);
  assert.equal(h.operations[0].computer, 'b');
  assert.equal(h.operations[0].socket, h.sockets.get('key-b').socket);
  assert.equal(h.operations[0].pending.device, 'device-b');
  h.operations[0].pending.complete({ ok: true, results: [{ ok: true, path: '/home/b/created.txt' }] });
  await new Promise(setImmediate);
  h.run("$('transferCopy').click()");
  assert.equal(h.run('transferClipboard.computer'), 'b');
  assert.equal(h.run('transferDirectories.b.download'), '/home/b');
  const item = h.run('transferUploads[0]');
  h.history.back();
  await h.run('openTransfer("a")');
  assert.equal(h.element('transferPaste').disabled, true);
  h.context.uploadItem = item;
  await h.run('transferSendFile(uploadItem)');
  assert.equal(h.uploads[0].url.startsWith('https://b.invalid/api/transfer/upload?'), true);
  assert.equal(h.uploads[0].headers['X-Test-Computer'], 'b');
  assert.equal(h.run('currentComputer().id'), 'a');
});
