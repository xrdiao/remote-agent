import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const moduleSource = file => read(file).replace(/^import .*;\n/gm, '').replace(/^export /gm, '');

function launcher({ running = false, missing = false, exits = false } = {}) {
  const calls = [], children = [];
  let healthy = running;
  const context = vm.createContext({ path, URL, AbortSignal, promisify, Date, console,
    DATA_DIR: '/test/.agent-remote', os: { homedir: () => '/test' }, process: { argv: [] },
    fs: { mkdirSync() {}, openSync: () => 7, closeSync: fd => calls.push({ closed: fd }) },
    OpenCodeClient: class {
      constructor() { this.url = 'http://127.0.0.1:19591'; }
      async request() { if (!healthy) throw new Error('ECONNREFUSED'); return { healthy: true }; }
    },
    execFile: (_command, _args, _options, done) => done(missing ? Object.assign(new Error('not installed'), { code: 'ENOENT' }) : null, '1.15.5', ''),
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      Object.assign(child, { pid: 1234, exitCode: exits ? 1 : null, signalCode: null, unref() { this.unreferenced = true; } });
      children.push(child);
      queueMicrotask(() => {
        if (missing) child.emit('error', Object.assign(new Error('not installed'), { code: 'ENOENT' }));
        else { healthy = !exits; child.emit('spawn'); }
      });
      return child;
    }, setTimeout,
  });
  vm.runInContext(moduleSource('server/opencode/launch.mjs').split('\nif (process.argv')[0], context);
  return { context, calls, children };
}

test('OpenCode detects an installed CLI while stopped and starts a detached process with file-backed logs', async () => {
  const h = launcher();
  assert.equal((await h.context.detectOpenCode()).status, 'installed');
  assert.equal(h.children.length, 0);
  const result = await h.context.launchOpenCode();
  assert.equal(result.status, 'started');
  assert.equal(result.pid, 1234);
  const spawn = h.calls.find(row => row.command);
  assert.equal(spawn.command, 'opencode');
  assert.deepEqual(Array.from(spawn.args), ['serve', '--hostname', '127.0.0.1', '--port', '19591']);
  assert.equal(spawn.options.detached, true);
  assert.equal(spawn.options.cwd, '/test');
  assert.deepEqual(Array.from(spawn.options.stdio), ['ignore', 7, 7]);
  assert.equal(h.children[0].unreferenced, true);
  assert.equal(h.calls.find(row => row.closed).closed, 7);
});

test('OpenCode reuses a healthy native service and reports missing or failed executables', async () => {
  const running = launcher({ running: true });
  assert.equal((await running.context.detectOpenCode()).status, 'reused');
  assert.equal((await running.context.launchOpenCode()).status, 'reused');
  assert.equal(running.children.length, 0);
  const missing = launcher({ missing: true });
  assert.equal((await missing.context.detectOpenCode()).status, 'missing');
  assert.equal((await missing.context.launchOpenCode()).status, 'missing');
  assert.equal((await launcher({ exits: true }).context.launchOpenCode()).status, 'failed');
});

function relayLauncher() {
  const events = [], desktop = [], native = [];
  let finish;
  const result = new Promise(resolve => { finish = resolve; });
  const context = vm.createContext({ path, os: { homedir: () => '/test' }, URL,
    fileURLToPath: url => new URL(url).pathname, IS_WIN: false, IS_MAC: false,
    EDITORS: ['cursor', 'devin', 'codex'].map(app => ({ app })), installDirs() {}, access() {}, readdir: async () => [],
    listWindows: async () => [{ app: 'opencode' }], Date, clearTimeout() {}, process: { env: {} },
    setTimeout(fn, ms) { if (ms < 45000) queueMicrotask(fn); },
    detectOpenCode: async () => ({ app: 'opencode', name: 'OpenCode', status: 'installed' }),
    launchOpenCode: async () => { native.push('opencode'); return { app: 'opencode', status: 'started' }; },
    spawn: (command, args) => {
      desktop.push({ command, args });
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => {};
      queueMicrotask(() => {
        child.stdout.emit('data', 'RESULT cursor installed\nRESULT devin installed\nRESULT codex installed\n');
        child.emit('close');
      });
      return child;
    },
  });
  vm.runInContext(moduleSource('server/launch.mjs').replaceAll('import.meta.url', JSON.stringify(new URL('../server/launch.mjs', import.meta.url).href)), context);
  const session = { emit(event) { events.push(event); finish(event); } };
  return { context, session, result, events, desktop, native };
}

test('the existing launch route accepts OpenCode alone and shares one in-flight launch across callers', async () => {
  const h = relayLauncher();
  h.context.launchAgents(h.session, ['opencode']);
  h.context.launchAgents(h.session, ['opencode']);
  const result = await h.result;
  assert.equal(h.native.length, 1);
  assert.equal(h.desktop.length, 0);
  assert.equal(result.results[0].app, 'opencode');
  assert.equal(result.results[0].status, 'started');
});

test('agent detection includes OpenCode without changing the default desktop launch targets', async () => {
  const h = relayLauncher();
  const catalog = await h.context.detectAgents();
  const native = catalog.find(row => row.app === 'opencode');
  assert.equal(native.installed, true);
  assert.equal(native.running, false);
  assert.equal(native.launchSupported, true);
  h.context.launchAgents(h.session, []);
  await h.result;
  assert.equal(h.native.length, 0);
  assert.deepEqual(Array.from(h.desktop[1].args.slice(1)), ['cursor', 'devin', 'codex']);
});

test('phone Agent management exposes the OpenCode launch checkbox through the existing selection flow', () => {
  let html;
  const context = vm.createContext({
    CONN_AGENTS: [{ app: 'opencode', name: 'OpenCode' }], agentCatalog: () => [{ app: 'opencode', installed: true, running: false, launchSupported: true }],
    startupAgents: () => ['opencode'], selectedLaunchAgents: () => ['opencode'], agentReports: new Map(), agentComputerKey: () => 'test',
    connLaunchNote: () => '', currentComputer: () => ({ name: 'Test computer' }), I18N: { tr: text => text }, esc: String,
    openSheet: (_kind, value) => { html = value; },
  });
  const source = read('app/js/sheets.js');
  vm.runInContext(source.slice(source.indexOf('function showAgentManager('), source.indexOf('function showViewportTrace(')), context);
  context.showAgentManager();
  assert.match(html, /data-agent-start="opencode"[^>]*checked/);
  assert.match(html, /data-act="agentStart" >启动所选 Agent/);
  assert.match(html, /后台运行/);
});

function computerActions({ online = true, projects = [] } = {}) {
  let html;
  const metadata = new Map([
    ['windows', { list: online ? [{ id: 'opencode', app: 'opencode' }] : [] }],
    ['agentCatalog', { agents: [{ app: 'opencode', installed: true, running: online, launchSupported: true }] }],
  ]);
  const context = vm.createContext({
    ovList: [{ id: 'computer', name: 'Test computer', c: { key: 'key', windowId: '/chosen' } }],
    ovSt: new Map([['computer', { data: { windows: projects } }]]),
    computerSockets: new Map([['key', { metadata }]]), I18N: { tr: text => text },
    esc: text => String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;'),
    openSheet: (_kind, value) => { html = value; },
  });
  const source = read('app/js/sheets.js');
  vm.runInContext(source.slice(source.indexOf('function showComputerActions('), source.indexOf('function showComputerFiles(')), context);
  return {
    show(app = 'opencode') { context.showComputerActions('computer', app); return html; },
    target() { return JSON.parse(html.match(/data-computer-target="([^"]+)"/)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')); },
  };
}

test('the computer OpenCode entry opens a healthy service without any projects or session history', () => {
  const h = computerActions();
  const html = h.show();
  assert.match(html, /data-computer-action /);
  assert.equal(html.includes('请先打开此 Agent'), false);
  assert.deepEqual(h.target(), { computer: 'computer', win: 'opencode', windowId: '' });
});

test('a stopped OpenCode service offers launch even when a cached project exists', () => {
  const h = computerActions({ online: false, projects: [{ app: 'opencode', win: 'opencode', windowId: '/chosen' }] });
  const html = h.show();
  assert.match(html, /data-computer-launch="opencode"/);
  assert.equal(html.includes('data-computer-action '), false);
});

test('the computer entry retains the selected OpenCode project and existing desktop Agent targets', () => {
  const h = computerActions({ projects: [
    { app: 'opencode', win: 'opencode', windowId: '/other' },
    { app: 'opencode', win: 'opencode', windowId: '/chosen' },
    { app: 'codex', win: 'codex', windowId: 'desktop-window' },
  ] });
  h.show();
  assert.equal(h.target().windowId, '/chosen');
  h.show('codex');
  assert.deepEqual(h.target(), { computer: 'computer', win: 'codex', windowId: 'desktop-window' });
});

test('late metadata refreshes only the open OpenCode panel belonging to that computer', () => {
  const refreshed = [], metadata = new Map();
  const tab = { dataset: { computerId: 'computer' } };
  const context = vm.createContext({
    sheetKind: 'computer-actions', expectedId: 'computer', link: { metadata }, m: null,
    $: () => ({ querySelector: () => tab }),
    showComputerActions: (id, app) => refreshed.push({ id, app, online: metadata.get('windows')?.list.length > 0 }),
  });
  const net = read('app/js/net.js');
  const source = net.slice(net.indexOf("    if (['windows', 'connAgents', 'agentCatalog', 'plans', 'sessionLibrary'].includes(m.t))"), net.indexOf('    if (link.receive) link.receive(event);'));
  context.m = { t: 'windows', list: [{ id: 'opencode', app: 'opencode' }] };
  vm.runInContext(source, context);
  assert.deepEqual(refreshed, [{ id: 'computer', app: 'opencode', online: true }]);
  context.expectedId = 'another-computer';
  vm.runInContext(source, context);
  context.expectedId = 'computer'; context.sheetKind = 'computer-files';
  vm.runInContext(source, context);
  assert.equal(refreshed.length, 1);
});

test('the first OpenCode service binding adopts its native directory and finishes without another attach', () => {
  let resolved = 0, attaches = 0;
  const context = vm.createContext({ currentNavigation: true, expectedId: 'computer', link: { binding: null },
    m: { t: 'attached', id: 'opencode', app: 'opencode', windowId: '/native/project', sel: 'opencode|/native/project|', ready: true },
    winBinding: { target: { computer: 'computer', win: 'opencode', windowId: '' }, resolve: () => { resolved++; } },
    currentComputer: () => ({ id: 'computer', windowId: '/native/project', threadId: '' }),
    authed: true, windowReady: true, navigationPending: null, currentApp: 'opencode', openWin: () => { attaches++; },
  });
  const net = read('app/js/net.js');
  const binding = net.slice(net.indexOf("    if (currentNavigation && m.t === 'attached') {"), net.indexOf("    if (currentNavigation && m.t === 'chat'"));
  vm.runInContext(binding, context);
  const notify = read('app/js/notify.js');
  vm.runInContext(notify.slice(notify.indexOf('function winTargetReady('), notify.indexOf('function bindWin(')), context);
  context.finishWinBinding();
  assert.equal(resolved, 1);
  assert.equal(attaches, 0);
});

test('an OpenCode native directory from another computer cannot resolve the current service binding', () => {
  const target = { computer: 'current-computer', win: 'opencode', windowId: '' };
  const context = vm.createContext({ currentNavigation: true, expectedId: 'another-computer', link: { binding: null },
    m: { t: 'attached', app: 'opencode', windowId: '/other/project', ready: true }, winBinding: { target },
  });
  const net = read('app/js/net.js');
  vm.runInContext(net.slice(net.indexOf("    if (currentNavigation && m.t === 'attached') {"), net.indexOf("    if (currentNavigation && m.t === 'chat'")), context);
  assert.equal(target.windowId, '');
});
