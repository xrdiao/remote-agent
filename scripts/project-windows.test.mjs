import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { FusionScheduler } from '../server/fusion/scheduler.mjs';

const source = fs.readFileSync(new URL('../server/project-windows.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');

function fixture({ favorite = false, keep = false, owned = true, failClose = false, focused = false, nativeFocus = 2, busy = false, processes = [], singleWindow = false, nativePid = 0, endpointCloses = false } = {}) {
  const library = { cursor: { session: { favorite } } }, calls = [], closed = new Set(), probes = [];
  const pages = (singleWindow ? ['one'] : ['one', 'two']).map((id, i) => ({ id, title: 'same title', type: 'page', url: 'workbench', webSocketDebuggerUrl: id, handle: i + 1 }));
  let failure = failClose, beforeProbe;
  const saved = { enabled: true, idleMinutes: 1, sessions: { 'cursor:session': { id: 'session', workspace: '/project', ownerWindow: 'old-window' } },
    windows: Object.fromEntries(pages.map(p => ['cursor:' + p.id, { app: 'cursor', id: p.id, root: p.id === 'one' ? '/project' : '/other', owned: p.id === 'one' && owned, keep: p.id === 'one' && keep, lastUsed: Date.now() - 120000 }])) };
  const context = vm.createContext({
    path, Buffer, Date, URL, AbortSignal, setTimeout: fn => { fn(); return { unref() {} }; }, clearTimeout() {},
    process: { platform: 'linux', env: { DISPLAY: ':0' }, getuid: () => 1000, pid: 9999 },
    fs: { existsSync: () => true, readFileSync: () => JSON.stringify(saved), mkdirSync() {}, writeFileSync() {},
      promises: {
        readdir: async () => processes.map(p => String(p.id)),
        readlink: async file => {
          const p = processes.find(p => file.includes('/' + p.id + '/'));
          if (p.denied) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
          return file.endsWith('/exe') ? p.exe || p.args[0] : p.cwd || '/project';
        },
        readFile: async file => {
          const p = processes.find(p => file.includes('/' + p.id + '/'));
          return file.endsWith('/status') ? `Name:\t${path.basename(p.args[0])}\nUid:\t1000` : p.args.join('\0');
        },
      } },
    DATA_DIR: '/memory', normPath: x => path.normalize(x), readLibrary: () => library, sessionId: (_app, id) => id,
    syncLibrarySessions: () => false, EDITORS: [{ app: 'cursor', url: 'memory://cursor' }],
    CODEX_CDP_URL: '', codexWindows: async () => [], helpersCall: call => call, PAGE_SRC: '({})', pidByPort: () => nativePid,
    x11ActiveWindow: async () => nativeFocus,
    Cdp: class {
      constructor(id) { this.id = id; }
      async connect() {}
      async evaluate() {
        probes.push(this.id);
        await beforeProbe?.(this.id);
        return { ready: true, windowHandle: [this.id === 'one' ? 1 : 2, 0, 0, 0], focused, dirty: false, dialog: false,
          terminalBusy: false, agentKnown: true, agentBusy: busy && this.id === 'one', lastInput: 0, thread: 'owned', draft: false };
      }
      async send(method) { calls.push({ id: this.id, method }); if (failure) throw Error('close failed'); closed.add(this.id); }
      close() {}
    },
    editorRoots: async cdp => [{ root: cdp.id === 'one' ? '/project' : '/other' }],
    fusionViewers: new Set(), fusionRuns: {}, fusionMainWindow: () => false, fusionWindowInUse: () => false, fusionScheduler: new FusionScheduler(),
    windowLeased: () => false, leaseWindow: () => () => {},
    fetch: async () => {
      if (endpointCloses && closed.has('one')) throw new Error('native browser exited');
      return { json: async () => pages.filter(p => !closed.has(p.id)) };
    },
  });
  vm.runInContext(source, context);
  return { calls, library, closed, context, probes,
    scan: () => vm.runInContext('scanProjectWindows()', context),
    recycle: () => vm.runInContext("recycleFusionWindows('computer','cursor',{id:'project'})", context),
    state: () => JSON.parse(vm.runInContext('JSON.stringify(saved)', context)),
    fail(value) { failure = value; }, beforeProbe(fn) { beforeProbe = fn; },
  };
}

test('favorite project survives a window replacement and becomes eligible after unfavoriting', async () => {
  const h = fixture({ favorite: true });
  await h.scan(); assert.equal(h.calls.length, 0);
  assert.equal(h.state().windows['cursor:one'].reason, '项目包含收藏会话');
  h.library.cursor.session.favorite = false;
  vm.runInContext("saved.windows['cursor:one'].lastUsed -= 120000", h.context);
  await h.scan(); assert.deepEqual([...h.closed], ['one']);
});

test('an archived favorite learned from the native catalog retains its project association', async () => {
  const h = fixture({ favorite: true });
  vm.runInContext("saved.sessions = {}; reconcileSessionCatalog('cursor', {rows:[{id:'session', archived:true, workspace:'/project'}], complete:false})", h.context);
  await h.scan(); assert.equal(h.calls.length, 0);
  assert.equal(h.state().sessions['cursor:session'].workspace, '/project');
});

test('a favorite from another project or software does not retain an unrelated window', async () => {
  for (const other of ['project', 'software']) {
    const h = fixture({ favorite: true });
    if (other === 'project') vm.runInContext("saved.sessions['cursor:session'].workspace='/different'", h.context);
    else { h.library.codex = h.library.cursor; h.library.cursor = {}; }
    await h.scan(); assert.deepEqual([...h.closed], ['one']);
  }
});

test('a favorite added during a scan is checked again before closing', async () => {
  const h = fixture();
  h.beforeProbe(id => { if (id === 'two') h.library.cursor.session.favorite = true; });
  await h.scan(); assert.equal(h.calls.length, 0);
});

test('close failure does not become manual keep and a later scan can close the same target', async () => {
  const h = fixture({ failClose: true });
  await h.scan(); assert.equal(h.state().windows['cursor:one'].keep, false);
  assert.equal(h.state().windows['cursor:one'].reason, 'close failed');
  h.fail(false); await h.scan(); assert.deepEqual([...h.closed], ['one']);
});

for (const options of [{ keep: true }, { owned: false }, { busy: true }, { nativeFocus: 1 }]) {
  test(`existing window ownership and activity still prevent closing: ${JSON.stringify(options)}`, async () => {
    const h = fixture(options); await h.scan(); assert.equal(h.calls.length, 0);
  });
}

test('simulated document focus does not retain a physically inactive window; same titles close by target', async () => {
  const h = fixture({ focused: true }); await h.scan();
  assert.deepEqual(h.calls, [{ id: 'one', method: 'Page.close' }]);
});

test('resident protocol servers are idle but their actual child commands still retain the project', async () => {
  const servers = [
    { id: 1, args: ['/editor', '--type=utility'] },
    { id: 2, args: ['/editor', '/editor/resources/app/extensions/json/server', '--node-ipc'] },
    { id: 3, args: ['/editor/resources/app/extensions/agent/bin/agent', 'acp'] },
    { id: 4, args: ['/node', '/mcp/server.js', 'serve', '--mcp'] },
  ];
  const idle = fixture({ processes: servers }); await idle.scan(); assert.deepEqual([...idle.closed], ['one']);
  const busy = fixture({ processes: [...servers, { id: 5, args: ['/bin/bash', '-c', 'sleep 20'] }] });
  await busy.scan(); assert.equal(busy.calls.length, 0);
  assert.equal(busy.state().windows['cursor:one'].reason, '项目进程或后台命令仍在运行');
});

test('ordinary executables are not excluded just because an argument mentions an editor flag', async () => {
  const h = fixture({ processes: [{ id: 1, args: ['/node', '/project/task.js', 'text --type=utility'] }] });
  await h.scan(); assert.equal(h.calls.length, 0);
});

test('a Fusion window switched to an unrelated session is retained by the existing idle scanner', async () => {
  const h = fixture();
  vm.runInContext("Object.assign(saved.windows['cursor:one'], {purpose:'fusion', ownership:'changed'})", h.context);
  await h.scan();
  assert.equal(h.calls.length, 0);
  assert.equal(h.state().windows['cursor:one'].reason, 'Fusion 窗口归属已变化，等待用户处理');
});

test('system authentication service does not block every project when its cwd is private', async () => {
  const h = fixture({ processes: [{ id: 1, args: ['/usr/bin/ssh-agent', '-D'], denied: true }] });
  await h.scan(); assert.deepEqual([...h.closed], ['one']);
  const unknown = fixture({ processes: [{ id: 2, args: ['/project/ssh-agent'], denied: true }] });
  await unknown.scan(); assert.equal(unknown.calls.length, 0);
  assert.equal(unknown.state().windows['cursor:one'].reason, '无法确认后台进程状态');
});

function fusion(h) {
  vm.runInContext("Object.assign(saved.windows['cursor:one'], {purpose:'fusion',computer:'computer',projectId:'project',ownership:'fusion',bindingId:'binding',expectedThread:'owned',lastUsed:Date.now()})", h.context);
}

test('an unused Fusion window closes immediately, including the last window, while an ordinary window keeps its idle rules', async () => {
  const owned = fixture({ singleWindow: true }); fusion(owned);
  await owned.recycle(); assert.deepEqual([...owned.closed], ['one']);
  const ordinary = fixture({ singleWindow: true });
  await ordinary.scan(); assert.equal(ordinary.state().windows['cursor:one'].reason, '保留最后一个可用窗口');
  const recent = fixture(); vm.runInContext("saved.windows['cursor:one'].lastUsed=Date.now()", recent.context);
  await recent.scan(); assert.equal(recent.calls.length, 0);
});

test('a Fusion cleanup request never probes or closes an ordinary window', async () => {
  const h = fixture(); fusion(h);
  vm.runInContext("saved.windows['cursor:two'].owned=true", h.context);
  await h.recycle(); assert.deepEqual([...h.closed], ['one']);
  assert.ok(h.probes.every(id => id === 'one'));
  assert.equal(h.state().windows['cursor:two'].closed, undefined);
});
test('main ordinary sessions remain in normal lists and their windows are excluded from child recycling', async () => {
  const h = fixture();
  vm.runInContext(`saved.windows['cursor:one'].purpose='fusion'; saved.windows['cursor:one'].computer='computer';
    saved.windows['cursor:one'].projectId='project';
    fusionRuns.entry={runs:[{bindings:[{role:'main',app:'cursor',threadId:'main',windowId:'one'},
      {role:'B1',app:'cursor',threadId:'child',windowId:'two'}]}]};`, h.context);
  h.context.fusionMainWindow = (app, id) => app === 'cursor' && id === 'one';
  const excluded = vm.runInContext('fusionTargets()', h.context);
  assert.equal(excluded.sessions.has('cursor:main'), false); assert.equal(excluded.sessions.has('cursor:child'), true);
  assert.equal(excluded.windows.has('cursor:one'), false);
  await h.recycle(); assert.equal(h.probes.length, 0); assert.equal(h.calls.length, 0);
  await h.scan(); assert.equal(h.closed.has('one'), false);
});

test('shared Fusion use, native drafts, favorites, manual keep and foreground focus retain the window', async () => {
  for (const reason of ['shared', 'draft', 'favorite', 'keep', 'foreground', 'ownership']) {
    const h = fixture({ favorite: reason === 'favorite', keep: reason === 'keep', nativeFocus: reason === 'foreground' ? 1 : 2 }); fusion(h);
    if (reason === 'shared') h.context.fusionWindowInUse = () => true;
    if (reason === 'draft') h.context.Cdp.prototype.evaluate = async () => ({ ready: true, windowHandle: [1, 0, 0, 0], agentKnown: true, draft: true });
    if (reason === 'ownership') vm.runInContext("saved.windows['cursor:one'].ownership='changed'", h.context);
    await h.recycle(); assert.equal(h.calls.length, 0, reason);
  }
});

test('a new native task or session change observed during the final check prevents Fusion closure', async () => {
  for (const change of ['task', 'session']) {
    const h = fixture(); fusion(h); let reads = 0;
    h.beforeProbe(() => {
      if (++reads === 2) {
        if (change === 'task') h.context.fusionWindowInUse = () => true;
        else vm.runInContext("saved.windows['cursor:one'].expectedThread='different'", h.context);
      }
    });
    await h.recycle(); assert.equal(h.calls.length, 0, change);
  }
});

test('a cleanup arriving during a scan is processed without another timer tick', async () => {
  const h = fixture(); fusion(h); let entered, release, first = true;
  const started = new Promise(resolve => { entered = resolve; });
  h.beforeProbe(async () => { if (first) { first = false; entered(); await new Promise(resolve => { release = resolve; }); } });
  const scan = h.scan();
  await started;
  const requested = h.recycle(); release(); await scan; await requested;
  assert.deepEqual([...h.closed], ['one']);
});

test('Fusion excludes verified native resident processes, while actual project commands still block and ordinary behavior is unchanged', async () => {
  const processes = [
    { id: 9999, args: ['/node', 'server/index.mjs'] },
    { id: 1, args: ['Code --remote-debugging-port=9224'], exe: '/editor/code' },
    { id: 2, args: ['Code --type=utility'], exe: '/editor/code' },
    { id: 3, args: ['/editor/chrome_crashpad_handler'], exe: '/editor/chrome_crashpad_handler' },
    { id: 4, args: ['/user/.vscode/extensions/openai.chatgpt-version/bin/codex', 'app-server'] },
  ];
  const h = fixture({ processes, nativePid: 1 }); fusion(h);
  await h.recycle(); assert.deepEqual([...h.closed], ['one']);
  const ordinary = fixture({ processes, nativePid: 1 }); await ordinary.scan(); assert.equal(ordinary.calls.length, 0);
  const command = fixture({ processes: [...processes, { id: 5, args: ['/node', '/project/task.js', 'text --type=utility'] }], nativePid: 1 }); fusion(command);
  await command.recycle(); assert.equal(command.calls.length, 0);
  assert.equal(command.state().windows['cursor:one'].reason, '项目进程或后台命令仍在运行');
});

test('Fusion Codex cleanup binds only its registered window webview and leaves ordinary windows alone', async () => {
  const h = fixture(); fusion(h);
  vm.runInContext("saved.windows = Object.fromEntries(Object.entries(saved.windows).map(([key,row]) => [key.replace('cursor:','codex:'),{...row,app:'codex'}])); EDITORS=[{app:'codex',url:'memory://codex'}]", h.context);
  h.context.codexWindows = async (_base, _report, pageId) => { assert.equal(pageId, 'one'); return [{ pageId: 'one', chatWs: 'one-chat' }]; };
  await vm.runInContext("recycleFusionWindows('computer','codex',{id:'project'})", h.context);
  assert.deepEqual([...h.closed], ['one']);
  assert.ok(h.probes.every(id => id === 'one' || id === 'one-chat'));
});

test('closing the last Fusion window confirms native process exit without repeating the close request', async () => {
  const h = fixture({ singleWindow: true, endpointCloses: true, nativePid: 1, processes: [{ id: 1, args: ['/editor/code'] }] }); fusion(h);
  let checks = 0;
  h.context.process.kill = (pid, signal) => { assert.equal(pid, 1); assert.equal(signal, 0); if (++checks === 2) throw Object.assign(new Error('exited'), { code: 'ESRCH' }); };
  await h.recycle(); assert.equal(h.state().windows['cursor:one'].closed, true);
  assert.equal(checks, 2); assert.equal(h.calls.length, 1);
  const unknown = fixture({ singleWindow: true, endpointCloses: true }); fusion(unknown);
  await unknown.recycle(); assert.equal(unknown.state().windows['cursor:one'].closed, false);
  assert.match(unknown.state().windows['cursor:one'].reason, /无法确认窗口关闭/);
});

test('periodic Fusion cleanup also waits for the software slot before probing or closing', async () => {
  const h = fixture(); fusion(h); let release;
  const native = h.context.fusionScheduler.submit({ runId: 'other-run', app: 'cursor', projectKey: 'other-project', access: 'read', ready: () => true,
    execute: () => new Promise(resolve => { release = resolve; }) });
  await new Promise(resolve => setImmediate(resolve));
  await h.scan(); assert.equal(h.calls.length, 0); assert.equal(h.probes.length, 0);
  assert.equal(h.context.fusionScheduler.queue.length, 1);
  release(); await native;
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...h.closed], ['one']);
});
