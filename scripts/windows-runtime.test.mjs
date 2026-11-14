import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { IS_WIN, localFilePath, localFileUri, uriFilePath, pathKey, samePath, validLocalName, launchCommand } from '../lib/platform.mjs';
import { parseAgentRef, parseSessionRef } from '../lib/shared-rules.mjs';
import { safeHomePath } from '../server/agent/projects.mjs';
import { fusionProject } from '../server/fusion/state.mjs';
import { projectWindowSettings } from '../server/project-windows.mjs';
import { CodexState } from '../server/codex/state.mjs';
import { OpenCodeState } from '../server/opencode/state.mjs';
import { OpenCodeClient } from '../server/opencode/client.mjs';
import { transferApi } from '../server/http/transfer.mjs';
import { TerminalService } from '../server/terminal-service.mjs';
import { loadWorker } from '../server/voice/service.mjs';
import { voiceEngines } from '../server/voice/config.mjs';
import { uploadPathKey } from '../lib/uploads.mjs';
import { read, fragment } from './page-fixture.mjs';
import { PAGE_SRC } from '../server/page/build.mjs';

const run = promisify(execFile);
function platformFixture(files = [], python = {}) {
  const key = value => localFilePath(value, true).toLowerCase();
  const present = new Set(files.map(key)), calls = [];
  const env = { PATH: 'C:/Empty;D:/Tools', ProgramFiles: 'C:/Apps64', 'ProgramFiles(x86)': 'C:/Apps32',
    LOCALAPPDATA: 'C:/Users/test/Local', APPDATA: 'C:/Users/test/Roaming' };
  const context = vm.createContext({ path: path.win32, URL, fileURLToPath,
    process: { platform: 'win32', env }, os: { homedir: () => 'C:/Users/test' },
    fs: { existsSync: file => present.has(key(file)), statSync: file => {
      if (!present.has(key(file))) throw new Error('not installed');
      return { isFile: () => true };
    } },
    spawnSync: (command, args, options) => {
      calls.push({ command, args, options });
      if (command === 'py.exe' && python.launcher) return { status: 0, stdout: python.launcher };
      if (key(command) === key(python.installed || '')) return { status: 0, stdout: '' };
      return { status: null, error: Object.assign(new Error('not installed'), { code: 'ENOENT' }) };
    },
    execFileSync: (command, args, options) => {
      calls.push({ command, args, options });
      if (python.noCim && args.join(' ').includes('Win32_LogicalDisk')) throw new Error('CIM unavailable');
      if (python.noDrives) return '';
      return args.join(' ').includes('Get-NetTCPConnection') ? 'D:\\Portable\\Cursor\\Cursor.exe' : 'C:\r\nD:\r\n';
    },
  });
  vm.runInContext(read('lib/platform.mjs').replace(/^import .*;\n/gm, '').replace(/^export /gm, '')
    .replaceAll('import.meta.url', JSON.stringify(new URL('../lib/platform.mjs', import.meta.url).href))
    + '\nthis.api = { findBin, localDrives };', context);
  return { ...context.api, calls, env };
}
async function directory(t) {
  await fs.mkdir('_shots/windows-runtime/tests', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('_shots/windows-runtime/tests/case-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('Windows drive-prefix, file URI, UNC and lexical paths normalize without resolving on the wrong drive', () => {
  for (const input of ['C:\\Work\\项目', '/c:/Work/项目/', 'c:/Work/temp/../项目', 'file:///c:/Work/%E9%A1%B9%E7%9B%AE'])
    assert.equal(localFilePath(input, true), 'C:/Work/项目');
  assert.equal(localFilePath('C:\\', true), 'C:/');
  assert.equal(localFilePath('\\\\server\\share\\project', true), '//server/share/project');
  assert.equal(localFilePath('file://server/share/project', true), '//server/share/project');
  assert.equal(localFilePath('/home/Case', false), '/home/Case');
  assert.equal(samePath('/home/Case', '/home/case', false), false);
});

test('POSIX file URI decoding matches Node on both the server and the injected page', () => {
  const source = PAGE_SRC.slice(PAGE_SRC.indexOf('const IS_WIN ='), PAGE_SRC.indexOf('// Runs inside the desktop page'))
    .replace(/const IS_WIN = (?:true|false);/, 'const IS_WIN = false;');
  const page = vm.runInNewContext(source + '\n({ localFilePath, samePath });', { URL });
  for (const input of ['/home/Case', './src', '../work', '/home/report\\2026.txt',
    'file:///home/Case', 'file://localhost/home/project', 'file:///home/%E9%A1%B9%E7%9B%AE',
    'file:///home/a%20b', 'file:///home/a%5Cb', 'file:///home/a%252Fb']) {
    const expected = input.startsWith('file:') ? fileURLToPath(input, { windows: false }) : input;
    assert.equal(localFilePath(input, false), expected, input);
    assert.equal(page.localFilePath(input), expected, input);
  }
  for (const input of ['file://server/home/project', 'file:///home/a%2Fb', 'file:///home/a%2fb', 'file:///home/bad%']) {
    assert.throws(() => fileURLToPath(input, { windows: false }), input);
    assert.throws(() => localFilePath(input, false), input);
    assert.throws(() => page.localFilePath(input), input);
  }
  assert.equal(page.samePath('/home/Case', '/home/case'), false);
});

test('upload naming keeps POSIX basename behavior and applies Windows name rules only on Windows', async () => {
  const platform = read('lib/platform.mjs');
  const validName = fragment(platform, 'export function validLocalName(', 'const USER_DIRS =').replace('export ', '');
  const body = fragment(read('server/http/api.mjs'), "  if (route === '/api/upload'", "  if (route === '/api/devices')");
  for (const windows of [false, true]) {
    const files = new Map(), names = [], context = vm.createContext({ IS_WIN: windows, path: windows ? path.win32 : path.posix,
      URL, Buffer, DATA_DIR: windows ? 'C:/agent' : '/agent', crypto: { randomUUID: () => 'new-id' },
      device: { id: 'paired-device' }, json: (_req, _res, status, data) => ({ status, data }),
      uploadDocument: name => name.endsWith('.txt'), imageTypes: {}, localFilePath: value => localFilePath(value, windows),
      registerUpload: (_root, _id, file) => names.push(file.name), updateUpload() {}, removeUpload() {},
      fs: { writeFileSync: (file, content) => files.set(file, content.toString()) },
    });
    vm.runInContext(validName + '\nasync function upload(req, res, route) {' + body + '}', context);
    for (const name of ['report\\2026.txt', 'folder/report.txt', 'NUL.txt', 'report.txt']) {
      const req = { method: 'POST', url: '/api/upload?' + new URLSearchParams({ name }) };
      req[Symbol.asyncIterator] = async function* () { yield Buffer.from('payload'); };
      const reply = await context.upload(req, {}, '/api/upload');
      const accepted = !windows || name === 'report.txt';
      assert.equal(reply.status, accepted ? 200 : 400, `${windows ? 'Windows' : 'POSIX'}: ${name}`);
      if (accepted) assert.equal(names.at(-1), windows ? name : path.posix.basename(name));
    }
    if (!windows) assert.equal(files.get('/agent/uploads/new-id/report\\2026.txt'), 'payload');
    assert.equal(context.validLocalName('report\\2026.txt'), !windows);
  }
});

test('typed session IDs round-trip drive colons, percent signs, spaces and Unicode', () => {
  const root = 'C:\\Work\\100% 项目', window = 'cursor:window-one', thread = 'native:thread';
  for (const kind of ['project', 'project-new', 'thread', 'new']) {
    const id = `${kind}:${encodeURIComponent(window)}:${encodeURIComponent(kind === 'project-new' || kind === 'new' ? root : thread)}`;
    const parsed = parseAgentRef(id);
    assert.equal(parsed.windowId, window);
    assert.equal(parsed.id, kind === 'project-new' || kind === 'new' ? root : thread);
  }
  assert.equal(parseAgentRef('new:' + encodeURIComponent(root)).id, root);
  assert.equal(parseAgentRef('new:C:/Work/project').id, 'C:/Work/project');
  assert.equal(parseAgentRef('project:C:/Work/project:thread-one').windowId, 'C:/Work/project');
  assert.equal(parseAgentRef('project-new:' + encodeURIComponent(window)).windowId, window);
  assert.equal(parseAgentRef('project-new:' + encodeURIComponent(window)).id, '');
  assert.equal(parseAgentRef('new:desktop-window').windowId, 'desktop-window');
  assert.equal(parseSessionRef('codex', 'thread:backend:native:thread'), thread);
  assert.equal(parseSessionRef('cursor', `project:${encodeURIComponent(window)}:${encodeURIComponent(thread)}`), thread);
});

test('Windows binary discovery handles portable apps, per-user installs and missing tools independently of the host', () => {
  const h = platformFixture(['D:/Portable/Cursor/Cursor.exe', 'C:/Apps64/GitHub CLI/gh.exe', 'C:/Apps32/cloudflared/cloudflared.exe',
    'C:/Apps64/LibreOffice/program/soffice.com', 'C:/Users/test/Local/Google/Chrome/Application/chrome.exe',
    'C:/Users/test/Local/Programs/Git/bin/bash.exe', 'D:/Tools/opencode.cmd']);
  assert.equal(localFilePath(h.findBin('cursor', 9222), true), 'D:/Portable/Cursor/Cursor.exe');
  assert.equal(localFilePath(h.findBin('gh'), true), 'C:/Apps64/GitHub CLI/gh.exe');
  assert.equal(localFilePath(h.findBin('cloudflared'), true), 'C:/Apps32/cloudflared/cloudflared.exe');
  assert.equal(localFilePath(h.findBin('libreoffice'), true), 'C:/Apps64/LibreOffice/program/soffice.com');
  assert.equal(localFilePath(h.findBin('chrome'), true), 'C:/Users/test/Local/Google/Chrome/Application/chrome.exe');
  assert.equal(localFilePath(h.findBin('bash'), true), 'C:/Users/test/Local/Programs/Git/bin/bash.exe');
  assert.equal(localFilePath(h.findBin('opencode'), true), 'D:/Tools/opencode.cmd');
  assert(h.calls.every(call => call.options.windowsHide === true));
  assert.equal(platformFixture().findBin('bash'), 'bash');
  assert.deepEqual(Array.from(platformFixture([], { noCim: true }).localDrives()), ['C', 'D']);
  assert.throws(() => platformFixture([], { noDrives: true }).localDrives(), /无法读取 Windows/);
});

test('Windows Python discovery validates launcher and PATH interpreters and reports absence', () => {
  const launched = platformFixture([], { launcher: 'D:/Python/python.exe\n', installed: 'D:/Python/python.exe' });
  assert.equal(launched.findBin('python'), 'D:/Python/python.exe');
  const onPath = platformFixture(['D:/Tools/python.exe'], { installed: 'D:/Tools/python.exe' });
  assert.equal(onPath.findBin('python'), 'D:/Tools/python.exe');
  const missing = platformFixture(['D:/Tools/python.exe']);
  assert.throws(() => missing.findBin('python'), /需要可用的 Python 3/);
  assert(launched.calls.every(call => call.options.windowsHide === true));
});

test('Windows FFmpeg discovery uses PATH and per-user install links and reports an actionable missing dependency', () => {
  const onPath = platformFixture(['D:/Tools/ffmpeg.exe']);
  assert.equal(onPath.findBin('ffmpeg'), 'D:/Tools/ffmpeg.exe');
  const installed = platformFixture(['C:/Users/test/Local/Microsoft/WinGet/Links/ffmpeg.exe']);
  assert.equal(installed.findBin('ffmpeg'), 'C:/Users/test/Local/Microsoft/WinGet/Links/ffmpeg.exe');
  assert.throws(() => platformFixture().findBin('ffmpeg'), /Windows.*FFmpeg.*PATH.*重启 relay/);
});

test('Cursor Windows native services become available without an agent status row', () => {
  const anchor = {}, data = {}, services = { composerService: {}, composerDataService: data, backgroundComposerService: {}, nativeHostService: {} };
  const instantiationService = { _services: { _entries: new Map(Object.keys(services).map(id => [id, id])) },
    invokeFunction: fn => fn({ get: id => services[id] }) };
  let ready = false;
  const context = vm.createContext({ IS_WIN: true, window: {}, doc: { querySelector: selector => {
    assert.equal(selector, '.vscode-model-picker__trigger');return ready ? anchor : null;
  } }, codexFiberProps: element => element ? [{ services: { workspace: { instantiationService } } }] : [] });
  vm.runInContext(fragment(read('server/page/session-actions.js'), '  const cursorSessionInstantiation =', '  const nativeSessionContext =')
    + '\nthis.services = cursorSessionServices;', context);
  assert.equal(context.services(), null);
  assert.equal(context.window.__remoteAgentCursorServices, undefined);
  ready = true;
  assert.equal(context.services().data, data);
  assert.equal(context.services(), context.window.__remoteAgentCursorServices);
});

test('Windows Cursor startup waits for native services; Linux keeps its original readiness', () => {
  const source = fragment(read('server/page/agents.js'), '  const agentStartupState =', '  const cursorChatReady =');
  for (const windows of [false, true]) {
    let ready = false;
    const context = vm.createContext({ IS_WIN: windows, cursorSessionServices: () => ready ? {} : null,
      agentList: () => [], activeThread: () => 'empty', hasComposer: () => true, modelButton: () => ({}),
      extract: () => ({ items: [] }) });
    const startup = vm.runInContext(source + '\nagentStartupState;', context);
    assert.equal(startup('cursor', true) === null, windows);
    ready = true;
    assert.equal(startup('cursor', true).thread, 'empty');
  }
});

test('Windows Cursor model reads and changes retain the bound thread instead of the desktop foreground thread', async () => {
  const context = vm.createContext({ JSON, states: { bound: 'Model A', foreground: 'Model B' }, selected: [], emitted: [],
    PAGE_SRC: `((context) => ({
      nativeSessionInfo: async (_app, id) => { if(id !== context.threadId) throw Error('wrong owner'); },
      modelItemsFast: () => ['Model A','Model B'].map(label => ({label,checked:states[context.threadId]===label})),
      nativeSessionAction: async (_app,id,_action,label) => { selected.push(id);states[id]=label;return true; },
      fastInfo: () => null, agentModelName: () => states[context.threadId], effortItems: () => [],
    }))()`,
  });
  const source = fragment(read('server/apps/cursor.mjs'), 'async readWindowsCursorMenu(', 'async withCursorUiRead(');
  const methods = vm.runInContext('({' + source + '})', context);
  const session = { sel: 'bound', threadId: 'bound', selectionKey: () => 'cursor|window|bound',
    cdp: { evaluate: expression => vm.runInContext(expression, context) },
    emit: message => context.emitted.push(message), refreshModelChat: async () => {} };
  await methods.readWindowsCursorMenu.call(session, 'model', 7);
  assert.equal(context.emitted[0].items.find(item => item.checked).label, 'Model A');
  assert.deepEqual({ ...context.states }, { bound: 'Model A', foreground: 'Model B' });
  await methods.pickWindowsCursorMenu.call(session, 'model', 'Model B');
  assert.equal(context.states.bound, 'Model B');
  await methods.pickWindowsCursorMenu.call(session, 'model', 'Model A');
  assert.equal(context.states.foreground, 'Model B');assert.equal(context.states.bound, 'Model A');
  assert.deepEqual(Array.from(context.selected), ['bound', 'bound']);
});

test('Cursor model dispatch is Windows-only and leaves Linux native menu calls intact', async () => {
  const source = read('server/agent/menus.mjs');
  const readMenu = fragment(source, '  async readMenu(', '  async closeMenus(');
  const pickMenu = source.slice(source.indexOf('  async pickMenu('), source.lastIndexOf('\n};'));
  for (const windows of [false, true]) {
    const calls = [], replies = [];
    const context = vm.createContext({ IS_WIN: windows, helpersCall: value => value, PAGE_SRC: 'native-page' });
    const methods = vm.runInContext('({' + readMenu + pickMenu + '})', context);
    const session = { app: 'cursor', sel: 'A', selectionKey: () => 'cursor|window|A',
      readWindowsCursorMenu: async () => calls.push('windows-read'),
      pickWindowsCursorMenu: async () => calls.push('windows-pick'), withCursorUiRead: fn => fn(),
      adapter: { pickModelMenu: async () => { calls.push('linux-pick');return true; } },
      emit: message => replies.push(message),
      cdp: { evaluate: async expression => expression.includes('modelItemsFast') ? [{ label: 'Linux native' }]
        : expression.includes('fusionConfig') ? null : expression.includes('extract') ? { model: 'Linux native' } : null },
    };
    await methods.readMenu.call(session, 'model', 7);
    await methods.pickMenu.call(session, 'model', 'Model A');
    if (windows) assert.deepEqual(calls, ['windows-read','windows-pick']);
    else { assert.deepEqual(calls, ['linux-pick']);assert.equal(replies[0].items[0].label, 'Linux native'); }
  }
});

test('Windows Devin surface follows shell visibility rather than a retained mode-menu tree', () => {
  const source = fragment(read('server/page/devin.js'), '  const devinSurface =', '  const devinRowSession =');
  let visibility = 'hidden';const shell = {}, picker = {};
  const context = vm.createContext({ IS_WIN: true, document: {
    querySelector: selector => selector === '.desktop-shell-root' ? shell : null,
    querySelectorAll: selector => selector.includes('mode-menu') ? [picker] : [],
  }, getComputedStyle: () => ({ visibility }), vis: () => true,
    codexFiberProps: () => [{ mode: 'agent' }] });
  const surface = vm.runInContext(source + '\ndevinSurface;', context);
  assert.equal(surface(), 'editor');visibility = 'visible';assert.equal(surface(), 'agent');
  context.IS_WIN = false;
  assert.equal(surface(), 'agent');
});

test('Windows Devin awaits the native view-switch command; Linux keeps the picker path', async () => {
  const source = fragment(read('server/page/devin.js'), '  const surfaceTarget =', '  const transcriptVisible =');
  const calls = [];let finish;
  const context = vm.createContext({ IS_WIN: true, document: { querySelector: () => ({}), querySelectorAll: () => [] },
    codexFiberProps: () => [{ vscodeAPI: { executeCommand: command => { calls.push(command);return new Promise(resolve => { finish = resolve; }); } } }],
    vis: () => true });
  const target = vm.runInContext(source + '\nsurfaceTarget;', context);
  let done = false;const pending = target('editor', true).then(value => { done = value; });
  assert.equal(done, false);assert.equal(calls[0], 'workbench.action.switchFromWindsurfAgentWindowToNormalMode');
  finish();await pending;assert.equal(done, true);
  context.IS_WIN = false;
  assert.equal(target('editor', true), null);assert.equal(calls.length, 1);
});

test('Windows Devin editor binding checks the actual desktop workspace while Linux keeps its existing workspace check', async () => {
  const source = fragment(read('server/apps/devin.mjs'), 'async setSurface(', '// The IDE history');
  for (const windows of [true, false]) {
    const calls = [];let clock = 0;
    class NativeCdp {
      constructor(id) { this.id = id; }
      async connect() {} close() {}
      async evaluate(expression) {
        if (expression.includes('devinSurface')) return 'editor';
        assert(expression.includes('nativeSessionInfo'));
        if (this.id === 'missing-thread') { calls.push('thread-cwd-missing');return { roots: [] }; }
        calls.push('thread-cwd');
        return { roots: [{ root: 'D:/own/thread-project', host: '' }] };
      }
    }
    const context = vm.createContext({ IS_WIN: windows, Cdp: NativeCdp, PAGE_SRC: 'native-page', helpersCall: value => value,
      Date: { now: () => clock += 20000 }, setTimeout: fn => fn(), awaitCdpRead: p => p,
      listWindows: async () => [{ app: 'devin', id: 'missing-thread', ws: 'missing-thread' }, { app: 'devin', id: 'native-window', ws: 'native-window' }],
      editorRoots: async () => { calls.push('editor-cwd');return [{ root: 'D:/desktop-project', host: '' }]; },
    });
    const methods = vm.runInContext('({' + source + '})', context);
    const session = { app: 'devin', windowId: 'old-window', cdp: { evaluate: async () => true, nativeWindow: { invalidate() {} } },
      devinWindowRoots: async cdp => { calls.push('desktop-cwd-' + cdp.id); return [{ root: cdp.id === 'native-window' ? 'D:/own/thread-project' : 'D:/other-project' }]; },
      projectMatches: (roots, cwd) => roots.some(row => row.root === cwd),
      openBound: async () => { calls.push('bind'); }, checkProjectTrust: async () => false,
      adapter: { openAgent: async id => { assert.equal(id, 'own-thread');calls.push('open'); } },
      resumeProjectSwitch: async () => {}, emit() {},
    };
    const changing = methods.setSurface.call(session, 'editor', { key: 'own-thread', cwd: 'D:/own/thread-project' });
    if (windows) { await changing;assert.deepEqual(calls, ['desktop-cwd-missing-thread','desktop-cwd-native-window','bind','open']); }
    else { await assert.rejects(changing, /尚未打开对应视图/);assert(calls.includes('editor-cwd'));assert(!calls.includes('thread-cwd')); }
  }
});

test('Windows local identities agree across session, upload, filesystem and Fusion boundaries', { skip: !IS_WIN }, async t => {
  const root = await directory(t), canonical = localFilePath(root), uriPath = '/' + canonical;
  assert(samePath(root, uriPath.toLowerCase()));
  assert.equal(pathKey(root), uploadPathKey({ path: uriPath.toLowerCase() }));
  assert.equal(safeHomePath(uriPath).real, safeHomePath(root).real);
  assert.equal(safeHomePath(pathToFileURL(root).href).real, canonical);
  assert.equal(fusionProject(uriPath).id, fusionProject(root.toLowerCase()).id);
  assert(!samePath('C:/Work', 'D:/Work'));
});

test('Cursor selects matching Windows URI shapes and opens drive and UNC workspace URIs', { skip: !IS_WIN }, () => {
  let selected, opened;
  const row = { workspaceIdentifier: { uri: { scheme: 'file', fsPath: 'c:\\work\\project', path: '/c:/work/project' } } };
  const select = vm.runInNewContext(fragment(read('server/page/agents.js'), '  const cursorSelectProject =', '  const cursorWorkspace =') + '\ncursorSelectProject;', {
    IS_WIN, localFilePath, localFileUri, uriFilePath, samePath,
    cursorProjectPicker: () => ({ recentProjects: [row], onSelectTarget: value => { selected = value; } }),
    cursorSessionServices: () => ({ nativeHost: { openWindow: value => { opened = value[0].workspaceUri; } } }),
  });
  assert.equal(select('/C:/Work/Project'), true);
  assert.equal(selected.id, row.workspaceIdentifier);
  select('C:\\Work\\Project', '', true);
  assert.equal(opened.path, '/C:/Work/Project');
  select('\\\\server\\share\\Project', '', true);
  assert.equal(opened.authority, 'server'); assert.equal(opened.path, '/share/Project');
  row.workspaceIdentifier.uri = { scheme: 'file', authority: 'server', path: '/share/Project' };
  assert.equal(select('\\\\server\\share\\Project'), true);
});

test('Codex create and resume keep a normalized project and reject another drive', { skip: !IS_WIN }, async () => {
  const client = new EventEmitter();
  client.generation = 1; client.connect = async () => {};
  let cwd = '/c:/Work/Project', requested;
  client.request = async (method, params) => {
    if (method === 'thread/start') requested = params.cwd;
    if (method === 'thread/queue/list') return { data: [] };
    return { thread: { id: 'thread-one', cwd, turns: [], updatedAt: 1 } };
  };
  const state = new CodexState({ client, file: null });
  const created = await state.create('c:\\Work\\Project');
  assert.equal(requested, 'C:/Work/Project');
  assert.equal(created.cwd, 'C:/Work/Project');
  created.disconnected = 'reconnect'; cwd = 'c:\\work\\project';
  assert(samePath((await state.load(created.id)).cwd, requested));
  state.threads.get(created.id).disconnected = 'reconnect'; cwd = 'D:/work/project';
  await assert.rejects(state.load(created.id), /项目已变化/);
});

test('Windows Codex background project switches, returns and new-session IDs keep the selected target', { skip: !IS_WIN }, async t => {
  const root = await directory(t), a = path.join(root, '项目 A 100%'), b = path.join(root, '项目 B');
  await Promise.all([fs.mkdir(a), fs.mkdir(b)]);
  const threads = new Map([['one', { id: 'one', cwd: localFilePath(a) }], ['two', { id: 'two', cwd: localFilePath(b) }]]);
  const records = new Map([...threads].map(([id, row]) => [id, { ...row, cwd: '/' + row.cwd.toLowerCase(), updatedAt: 1 }]));
  const views = [], saved = [], created = [];
  const source = read('server/apps/codex.mjs');
  const context = vm.createContext({ path, safeHomePath, localFilePath, samePath, parseAgentRef,
    CODEX_BACKEND: 'backend', cdpRead: { getStore: () => null }, awaitCdpRead: value => value,
    backendAttached() {}, rememberSelection: (_device, value) => saved.push(value),
    adapter: { backendOwner: () => assert.fail('a backend switch looked for a desktop writer') },
    codexBackend: { threads, records, load: async id => threads.get(id), create: async cwd => {
      created.push(cwd); return { id: 'new', cwd };
    } },
  });
  vm.runInContext(fragment(source, 'async function bindBackend(', 'async function backendSettingsOwner(')
    + fragment(source, 'const backendRoutes =', 'function serializedCodexPrompt') + '\nthis.routes = backendRoutes;', context);
  const session = { deviceId: 'test', mode: 'chat', detach() {}, clearViewState() {}, projectReady() {},
    attach() { assert.fail('a backend switch attached a desktop window'); },
    async setMode() { views.push({ thread: this.threadId, directory: this.codexDirectory }); } };
  await context.routes.openProject.call(session, { path: '/' + localFilePath(a).toLowerCase() });
  await context.routes.openAgent.call(session, { id: 'thread:backend:two' });
  await context.routes.openAgent.call(session, { id: 'thread:backend:one' });
  await context.routes.openAgent.call(session, { id: 'new:backend:' + encodeURIComponent(b) });
  assert.deepEqual(views.map(view => view.thread), ['one', 'two', 'one', 'new']);
  assert(views.every((view, i) => samePath(view.directory, i === 0 || i === 2 ? a : b)));
  assert.equal(created.length, 1); assert(samePath(created[0], b));
  assert.deepEqual(saved.map(value => value.threadId), ['one', 'two', 'one', 'new']);
  assert(saved.every(value => value.windowId === 'backend'));
});

test('OpenCode event directories share one project identity across Windows forms', { skip: !IS_WIN }, () => {
  const state = new OpenCodeState();
  for (const [id, directory] of [['one', '/c:/Work/Project'], ['two', 'C:\\work\\project']])
    state.apply({ type: 'session.created', properties: { info: { id, directory, title: id, time: { updated: 1 } } } });
  assert.equal(state.overview().windows.length, 1);
  const sessions = state.overview().sessions;
  assert.equal(sessions[0].projectId, sessions[1].projectId);
  assert.equal(state.sessions.get('one').directory, 'C:/Work/Project');
});

test('OpenCode HTTP directory uses local normalization at the request boundary', { skip: !IS_WIN }, async t => {
  let url;
  t.mock.method(globalThis, 'fetch', async value => { url = value; return { ok: true, status: 200, json: async () => [] }; });
  await new OpenCodeClient('http://localhost').request('/session', { directory: '/c:/Work/Project' });
  assert.equal(url.searchParams.get('directory'), 'C:/Work/Project');
});

async function transfer(route, parameters, body) {
  const req = Readable.from(body === undefined ? [] : [body]);
  req.method = body === undefined ? 'GET' : 'POST'; req.url = route + '?' + new URLSearchParams(parameters); req.headers = {};
  let status, data;
  const res = { writeHead: value => { status = value; }, end: value => { data = JSON.parse(value); } };
  await transferApi(req, res, route, { id: 'windows-runtime-test' });
  return { status, data };
}

test('Windows disk-list, drive-root and directory parents form a consistent navigation chain', { skip: !IS_WIN }, async t => {
  const roots = await transfer('/api/transfer/list', { roots: '1' });
  assert.equal(roots.status, 200); assert.equal(roots.data.atRoots, true);
  assert.equal(roots.data.path, null); assert.equal(roots.data.parent, null);
  const root = path.parse(await directory(t)).root;
  assert(roots.data.roots.includes(localFilePath(root)));
  assert(roots.data.roots.every(drive => /^[A-Z]:\/$/.test(drive)));
  const disk = await transfer('/api/transfer/list', { path: root });
  assert.equal(disk.data.atRoots, false); assert.equal(disk.data.parent, null);
  assert.equal(disk.data.path, localFilePath(root));
});

test('transfer UI navigates disk roots and disables parent and destination actions at the disk list', () => {
  const nodes = new Map(), calls = [];
  const node = id => { if (!nodes.has(id)) nodes.set(id, { setAttribute() {} }); return nodes.get(id); };
  const state = { $: node, esc: String, transferTab: 'download', transferPicker: null, transferUploadPath: '',
    transferDirectory: { path: null, parent: null, atRoots: true, os: 'win32', roots: ['C:/'] },
    transferSelection: new Map(), transferFileOperation: null, transferClipboard: { computer: 'pc' }, transferComputer: { id: 'pc' },
    renderTransferRows() {}, transferCount() {}, renderTransferUploads() {},
    transferBrowse: (path, roots) => calls.push({ path, roots }),
  };
  state.transferCurrentDirectory = () => state.transferPicker || state.transferDirectory;
  const context = vm.createContext(state), source = read('app/js/transfer.js');
  vm.runInContext(fragment(source, 'function renderTransferPage()', 'function renderTransferRows()')
    + fragment(source, "$('transferParent').onclick =", "$('transferRoots').onchange =") + '\nthis.render = renderTransferPage;', context);
  context.render();
  assert.equal(node('transferParent').disabled, true); assert.equal(node('transferPathButton').textContent, '磁盘');
  assert.equal(node('transferNewFile').disabled, true); assert.equal(node('transferPaste').disabled, true);
  state.transferDirectory = { path: 'C:/', parent: null, atRoots: false, os: 'win32' };
  context.render(); assert.equal(node('transferParent').disabled, false);
  node('transferParent').onclick(); assert.deepEqual(calls.pop(), { path: null, roots: true });
  state.transferDirectory = { path: 'C:/Work', parent: 'C:/', atRoots: false, os: 'win32' };
  context.render(); node('transferParent').onclick(); assert.deepEqual(calls.pop(), { path: 'C:/', roots: false });
  state.transferDirectory = { path: '/', parent: null, atRoots: false, os: 'linux' };
  context.render(); assert.equal(node('transferParent').disabled, true);
  state.transferPicker = { path: null, parent: null, atRoots: true, os: 'win32' };
  context.render(); assert.equal(node('transferUseDirectory').disabled, true);
  state.transferPicker = { path: 'C:/Work', parent: 'C:/', atRoots: false, os: 'win32' };
  context.render(); assert.equal(node('transferUseDirectory').disabled, false);
});

test('upload directory normalizes before joining and Windows invalid names are rejected', { skip: !IS_WIN }, async t => {
  const root = await directory(t);
  const result = await transfer('/api/transfer/upload', { directory: '/' + localFilePath(root), name: '子目录/文件.txt', mode: 'rename' }, 'payload');
  assert.equal(result.status, 200);
  assert.equal(await fs.readFile(path.join(root, '子目录', '文件.txt'), 'utf8'), 'payload');
  for (const name of ['NUL.txt', 'con', 'COM1.log', 'LPT9.txt', 'bad:name.txt', 'trailing.txt.', 'end ', 'a?.txt']) {
    assert.equal(validLocalName(name), false, name);
    const failed = await transfer('/api/transfer/upload', { directory: root, name, mode: 'rename' }, 'payload');
    assert.equal(failed.status, 400, name);
  }
  assert.equal(validLocalName('console.txt'), true);
});

test('Fusion scope containment uses Windows identity and respects drive and directory boundaries', { skip: !IS_WIN }, () => {
  const within = vm.runInNewContext(fragment(read('server/fusion/control.mjs'), 'function within(', 'function authorize(') + '\nwithin;', { path, pathKey, localFilePath });
  const project = { root: 'C:/Work/Project', host: '' };
  assert(within('src', 'C:\\work\\project\\src\\a.js', project));
  assert(within('/c:/work/project/src', 'src/a.js', project));
  assert(!within('src', 'src-two/a.js', project));
  assert(!within('src', '../outside/a.js', project));
  assert(!within('src', 'D:/Work/Project/src/a.js', project));
  assert(!within('Src', 'src/a.js', { root: '/remote', host: 'ssh' }));
});

test('Windows npm cmd shims preserve spaces and metacharacters in arguments', { skip: !IS_WIN }, async t => {
  const root = await directory(t), shim = path.join(root, 'test shim.cmd');
  const target = path.join(root, '参数 & 100%RA_SHIM_TEST% ! project');
  const previous = process.env.RA_SHIM_TEST;
  process.env.RA_SHIM_TEST = 'must-stay-literal';
  t.after(() => { if (previous === undefined) delete process.env.RA_SHIM_TEST; else process.env.RA_SHIM_TEST = previous; });
  const script = path.join(root, 'write-argument.mjs');
  await fs.writeFile(script, "import fs from 'node:fs'; fs.writeFileSync(process.argv[2], 'argument preserved');");
  await fs.writeFile(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  const { command, args } = launchCommand(shim, [target]);
  await run(command, args, { windowsHide: true });
  assert.equal(await fs.readFile(target, 'utf8'), 'argument preserved');
  assert.equal(launchCommand(process.execPath, ['--version']).command, process.execPath);
});

test('Windows rejects unsupported Qwen runtime and automatic window cleanup explicitly', { skip: !IS_WIN }, async () => {
  assert(!voiceEngines().some(engine => engine.id === 'qwen'));
  await assert.rejects(loadWorker('qwen'), /仅支持 Linux/);
  const settings = projectWindowSettings();
  assert.equal(settings.supported, false); assert.equal(settings.enabled, false);
  assert.throws(() => projectWindowSettings({ enabled: true }), /Windows 暂不支持/);
});

test('missing node-pty and unsupported Windows shells return explicit errors', { skip: !IS_WIN }, async () => {
  const missing = new TerminalService({ spawn: null });
  await assert.rejects(missing.create({ cwd: 'C:/project' }), /无法加载 node-pty/);
  const shell = new TerminalService({ shell: 'C:/Windows/System32/cmd.exe', spawn: () => assert.fail('unsupported shell spawned') });
  await assert.rejects(shell.create({ cwd: 'C:/project' }), /仅支持 Git Bash/);
});

test('Windows tunnel restart checks executable, origin and actual process exit before replacement', async () => {
  let rows = [
    { ProcessId: 10, ExecutablePath: 'C:\\Tools\\cloudflared.exe', CommandLine: 'cloudflared tunnel --url http://127.0.0.1:12345' },
    { ProcessId: 20, ExecutablePath: 'C:\\Other\\cloudflared.exe', CommandLine: 'cloudflared tunnel --url http://127.0.0.1:12345' },
    { ProcessId: 30, ExecutablePath: 'C:\\Tools\\cloudflared.exe', CommandLine: 'cloudflared tunnel --url http://127.0.0.1:123456' },
  ];
  let failExit = false, launches = 0;
  const commands = [];
  const context = vm.createContext({ path: path.win32, IS_WIN: true, promisify, Date, URL, AbortSignal,
    console: { log() {} }, clearTimeout, DATA_DIR: 'C:/test', PORT: 12345,
    findBin: () => 'C:/Tools/cloudflared.exe', samePath: (a, b) => localFilePath(a, true).toLowerCase() === localFilePath(b, true).toLowerCase(),
    execFileSync: () => JSON.stringify(rows),
    execFile: (command, args, options, callback) => { commands.push({ command, args, options }); if (!failExit) rows = rows.filter(row => row.ProcessId !== 10); callback(null, '', ''); },
    fs: { readFileSync: () => '10' }, fetch: async () => ({ ok: false }),
    process: { kill() { assert.fail('Windows tunnel must use its Windows process lifecycle'); } },
    launchObserved: () => { launches++; },
  });
  vm.runInContext(read('server/publish/tunnel.mjs').replace(/^import .*;\n/gm, '').replace(/^export /gm, '')
    + '\nlaunchTunnel = launchObserved; this.api = { findTunnelPid, checkTunnel, setState: value => { tunnel = value; } };', context);
  assert.equal(context.api.findTunnelPid(), 10);
  const state = { pid: 10, owned: true, url: 'https://test.trycloudflare.com', unhealthyAt: Date.now() - 61000 };
  context.api.setState(state);
  await context.api.checkTunnel();
  assert.equal(commands[0].command, 'taskkill.exe'); assert.equal(commands[0].options.windowsHide, true);
  assert.deepEqual(Array.from(commands[0].args), ['/PID', '10', '/T', '/F']);
  assert.equal(state.exited, true); assert.equal(launches, 0);
  await context.api.checkTunnel(); assert.equal(launches, 1);
  rows.unshift({ ProcessId: 10, ExecutablePath: 'C:/Tools/cloudflared.exe', CommandLine: 'cloudflared tunnel --url http://127.0.0.1:12345' });
  failExit = true;
  const stuck = { pid: 10, owned: true, url: 'https://test.trycloudflare.com', unhealthyAt: Date.now() - 61000 };
  context.api.setState(stuck);
  await assert.rejects(context.api.checkTunnel(), /进程尚未退出/);
  assert.equal(stuck.restarting, false); assert.equal(launches, 1);
});

test('real Windows Git Bash PTY reports cwd, accepts input and confirms natural and requested exit', { skip: !IS_WIN, timeout: 25000 }, async t => {
  const root = await directory(t), service = new TerminalService();
  t.after(() => service.dispose());
  const meta = await service.create({ cwd: '/' + localFilePath(root) });
  const terminal = service.get(meta.id);
  let output = '';
  const changed = new EventEmitter();
  const stop = await service.subscribe(meta.id, event => { if (event.t === 'termData') { output += event.data; changed.emit('data'); } });
  t.after(stop);
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('PTY command output missing')), 5000);
    const check = () => { if (output.includes('__RA_WINDOWS_OK__')) { clearTimeout(timer); changed.off('data', check); resolve(); } };
    changed.on('data', check);
  });
  await service.submit(meta.id, 'printf "__RA_WINDOWS_%s__\\n" OK');
  await ready;
  assert(samePath(terminal.cwd, root), JSON.stringify({ actual: terminal.cwd, expected: root }));
  await service.write(meta.id, 'exit 7\r');
  await terminal.exit;
  assert.equal(terminal.exited, true); assert.equal(terminal.exitCode, 7);
  await service.close(meta.id);
  const next = await service.create({ cwd: root });
  const killed = service.get(next.id);
  await service.close(next.id);
  assert.equal(killed.exited, true);
  assert(!service.terminals.has(next.id));
});
