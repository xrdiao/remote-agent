import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { FusionScheduler } from '../server/fusion/scheduler.mjs';

const source = fs.readFileSync(new URL('../server/project-windows.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/^export /gm, '').replaceAll('import.meta.url', JSON.stringify(new URL('../server/project-windows.mjs', import.meta.url).href));

test('automatic window binding is stable across discovery order and switches only after a new successful binding', () => {
  const h = fixture();
  const read = expression => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, h.context));
  assert.deepEqual(read("orderedProjectWindows('cursor',[{id:'two'},{id:'one'}]).map(row=>row.id)"), ['one', 'two']);
  vm.runInContext("bindProjectWindow('cursor','cursor:two')", h.context);
  assert.deepEqual(read("orderedProjectWindows('cursor',[{id:'one'},{id:'two'}]).map(row=>row.id)"), ['two', 'one']);
  assert.deepEqual(read("orderedProjectWindows('cursor',[{id:'one'}]).map(row=>row.id)"), ['one']);
  assert.equal(read("ownedProjectWindow('cursor','one')"), true);
  assert.equal(read("ownedProjectWindow('cursor','two')"), false);
});

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

test('system authentication service does not block every project when its cwd is private', async () => {
  const h = fixture({ processes: [{ id: 1, args: ['/usr/bin/ssh-agent', '-D'], denied: true }] });
  await h.scan(); assert.deepEqual([...h.closed], ['one']);
  const unknown = fixture({ processes: [{ id: 2, args: ['/project/ssh-agent'], denied: true }] });
  await unknown.scan(); assert.equal(unknown.calls.length, 0);
  assert.equal(unknown.state().windows['cursor:one'].reason, '无法确认后台进程状态');
});

test('a shared window is retained only while Fusion is actually using it; no dedicated recycling is triggered', async () => {
  const h = fixture(); h.context.fusionWindowInUse = () => true;
  await h.scan(); assert.equal(h.calls.length, 0); assert.equal(h.state().windows['cursor:one'].reason, 'Fusion 正在使用窗口');
  h.context.fusionWindowInUse = () => false;
  vm.runInContext("saved.windows['cursor:one'].lastUsed -= 120000", h.context);
  await h.scan(); assert.deepEqual([...h.closed], ['one']);
});
test('Fusion hides worker sessions while main sessions and shared windows remain ordinary', () => {
  const h = fixture();
  vm.runInContext("fusionRuns.entry={runs:[{bindings:[{role:'main',app:'cursor',threadId:'main',windowId:'one'},{role:'worker',app:'cursor',threadId:'child',windowId:'one'}]}]}", h.context);
  const excluded = vm.runInContext('fusionTargets()', h.context);
  assert.equal(excluded.sessions.has('cursor:main'), false); assert.equal(excluded.sessions.has('cursor:child'), true);
  assert.equal(excluded.windows.size, 0); assert.equal(h.calls.length, 0);
});

function codexOpening({ own = true, closed = false, prefer = false, host = '', cwd = '/native/project-B', error } = {}) {
  const calls = [], pageId = own ? 'current' : 'other', pages = closed ? [] : [{ pageId: 'other', chatWs: 'other-view', ws: 'other-editor', rawTitle: 'Other' }];
  const evaluate = async expression => {
    assert(expression.endsWith(`.nativeSessionInfo('codex', "thread-B", 'context')`));
    calls.push('native-context'); if (error) throw error; return { cwd, host, roots: [{ root: cwd, host }] };
  };
  const cdp = { evaluate }, scope = vm.createContext({
    CODEX_CDP_URL: 'fixture', helpersCall: call => '.' + call,
    codexWindows: async () => pages, editorRoots: async () => [{ root: '/native/project-B' }],
    Cdp: class { async connect() { calls.push('connect-other'); } async evaluate(expression) { return evaluate(expression); } close() { calls.push('close-other'); } },
  });
  const text = fs.readFileSync(new URL('../server/apps/codex.mjs', import.meta.url), 'utf8');
  vm.runInContext('globalThis.open = ({' + text.slice(text.indexOf('async openCodexAgent('), text.indexOf('async codexPageForThread(')) + '}).openCodexAgent;', scope);
  const session = { codexPageId: 'current', cdp, editorCdp: cdp, codexRoots: new Map([['thread-B', '/stale/project-A']]),
    useProject: (...args) => calls.push(['project', ...args]), projectMatches: (_roots, root, host) => root === '/native/project-B' && !host,
    selectCodexThread: async id => { calls.push(['select', id]); return true; }, adoptCodexThread: async id => calls.push(['adopt', id]),
    projectWindowState: async () => ({ busy: false }), checkProjectTrust: async () => false,
    openBound: async (...args) => calls.push(['open-bound', ...args]), resumeProjectSwitch: async () => calls.push('resume'),
  };
  return { calls, run: () => scope.open.call(session, `thread:${pageId}:thread-B`, prefer) };
}

for (const mode of [{ own: true }, { own: false }, { own: false, closed: true }]) {
  test(`Codex protocol-created thread reads its own native cwd ${JSON.stringify(mode)}`, async () => {
    const h = codexOpening(mode); await h.run();
    assert.deepEqual(h.calls.find(c => Array.isArray(c) && c[0] === 'project'), ['project', '/native/project-B', false, 'thread-B', '', mode.own ? 'current' : 'other']);
    assert(h.calls.includes('native-context'));
    assert.equal(h.calls.includes('close-other'), !mode.own && !mode.closed);
  });
}

test('Codex current-project optimization uses the selected native thread rather than stale cached roots', async () => {
  const h = codexOpening({ prefer: true }); await h.run();
  assert(h.calls.some(c => Array.isArray(c) && c[0] === 'select' && c[1] === 'thread-B'));
  assert(!h.calls.some(c => Array.isArray(c) && c[0] === 'project'));
});

test('Codex remote native context stays in its own carrier', async () => {
  const h = codexOpening({ own: false, host: 'remote-host', cwd: '/remote/project' }); await h.run();
  assert(h.calls.some(c => Array.isArray(c) && c[0] === 'open-bound' && c[1].ws === 'other-editor'));
  assert(!h.calls.some(c => Array.isArray(c) && c[0] === 'project'));
});

test('Codex unknown native cwd cannot borrow the cached project root', async () => {
  const h = codexOpening({ cwd: '' }); await assert.rejects(h.run(), /无法确认会话所属项目/);
  assert(!h.calls.some(c => Array.isArray(c) && c[0] === 'project'));
});

test('Codex native context failure closes the borrowed connection without guessing a project', async () => {
  const h = codexOpening({ own: false, error: Error('thread missing') }); await assert.rejects(h.run(), /thread missing/);
  assert(h.calls.includes('close-other'));
  assert(!h.calls.some(c => Array.isArray(c) && c[0] === 'project'));
});
