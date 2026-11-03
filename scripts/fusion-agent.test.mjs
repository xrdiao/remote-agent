import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { FusionScheduler } from '../server/fusion/scheduler.mjs';
import { fusionAttemptRole } from '../server/fusion/state.mjs';
const source = fs.readFileSync(new URL('../server/fusion/agent.mjs', import.meta.url), 'utf8');

function fixture(overrides = {}) {
  const changes = [], scheduler = new FusionScheduler();
  const context = vm.createContext({ crypto, Date, Map, Set, Promise, Error, Object,
    fusionScheduler: scheduler, fusionAttemptRole, publishFusion() {}, helpersCall: call => call, turnCall: (...args) => JSON.stringify(args),
    updateFusionWindow: (...args) => changes.push(args), fusionWorkspaceSnapshot: async () => ({ at: 1, available: true }),
    leaseWindow: () => () => {}, quotaBlockedMessage: () => '', rememberFusionSession() {},
    nativeWindow: () => ({ run: action => action() }), ...overrides,
  });
  vm.runInContext(source.slice(source.indexOf('export class FusionAgent')).replace('export class', 'class') + '\nthis.Agent = FusionAgent;', context);
  return { agent: new context.Agent(), changes, scheduler };
}
test('ownership changes and native drafts block before switching, typing or clearing anything', async () => {
  const h = fixture();
  let draft = '', thread = 'unrelated', calls = 0;
  const context = { app: 'cursor', cdp: { evaluate: async call => { calls++; return call === 'activeThread()' ? thread : draft; } } };
  await assert.rejects(h.agent.assertOwnership(context, { id: 'dedicated', bindingId: 'binding', expectedThread: 'owned' }), /归属变化/);
  assert.equal(calls, 1); assert.equal(h.changes[0][2].ownership, 'changed');
  thread = 'owned'; draft = 'unsent user draft';
  await assert.rejects(h.agent.assertOwnership(context, { id: 'dedicated', bindingId: 'binding', expectedThread: 'owned' }), /草稿已保留/);
  assert.equal(draft, 'unsent user draft');
});
test('main preparation uses the ordinary project flow, preserves main configuration, and keeps each native binding fact', async () => {
  const h = fixture(), calls = [];
  let thread = 'ordinary-thread';
  h.agent.projectContext = async () => ({ app: 'cursor', windowId: 'cursor:ordinary-window', bindingReady: true,
    get threadId() { return thread; }, withFocus: action => action(),
    waitFor: async () => true, cdp: { evaluate: async () => thread },
    useProject: async (...args) => { calls.push(args); if (args[1]) thread = 'new-main-thread'; }, dispose: () => calls.push('dispose') });
  const run = { id: 'run', deviceId: 'device', project: { id: 'project', root: '/project' },
    main: { app: 'cursor', model: 'Auto', effort: '', bindingId: '' }, bindings: [] };
  await h.agent.prepareMain(run);
  const first = run.bindings[0], original = JSON.stringify(first);
  assert.deepEqual(Array.from(calls[0]), ['/project', false, '', '', '']);
  assert.equal(first.threadId, 'ordinary-thread'); assert.equal(first.windowId, 'ordinary-window');
  assert.equal(first.role, 'main'); assert.equal(first.ownership, 'ordinary');
  assert.equal(run.main.model, 'Auto'); assert.equal(h.changes.length, 0);
  await h.agent.prepareMain(run, { newSession: true });
  assert.equal(run.bindings.length, 2); assert.equal(JSON.stringify(first), original);
  assert.equal(run.bindings[1].threadId, 'new-main-thread'); assert.equal(calls.filter(value => value === 'dispose').length, 2);
});
test('main workspace trust continues the same ordinary project operation and releases its context', async () => {
  const h = fixture(), calls = [];
  const run = { id: 'r', project: { id: 'p', root: '/p' }, main: { app: 'cursor', bindingId: '' }, bindings: [] };
  const context = { app: 'cursor', windowId: 'cursor:ordinary', threadId: 'thread', bindingReady: false,
    waitFor: async () => true, cdp: { evaluate: async () => 'thread' },
    withFocus: action => action(), async useProject() { this.pendingProject = { root: '/p', trust: true }; },
    async confirmProjectTrust(approve) { calls.push(approve); this.pendingProject = null; this.bindingReady = approve; },
    dispose() { calls.push('dispose'); } };
  h.agent.projectContext = async () => context;
  assert.equal((await h.agent.prepareMain(run)).trust.path, '/p');
  assert.equal(run.bindings.length, 0); assert.equal(calls.length, 0);
  assert.equal(h.agent.mainProjects.get('r'), context);
  await h.agent.prepareMain(run, { action: 'projectTrust', approve: true });
  assert.deepEqual(calls, [true, 'dispose']); assert.equal(run.bindings[0].threadId, 'thread');
  assert.equal(h.agent.mainProjects.size, 0);
});
test('a main native thread accepted before recovery is adopted from its confirmed receipt without resending', async () => {
  const h = fixture(), binding = { id: 'binding', role: 'main', app: 'cursor', windowId: 'ordinary', threadId: '' };
  const attempt = { id: 'attempt', bindingId: binding.id, receipt: { messageId: 'accepted-message' }, beforeIds: [] };
  const context = { app: 'cursor', cdp: { evaluate: async call => call === 'activeThread()' ? 'native-main'
    : call === 'composerDraft()' ? '' : { id: 'accepted-message', threadId: 'native-main', accepted: true } } };
  const run = { bindings: [binding] }, window = { id: 'ordinary', role: 'main', binding, bindingId: binding.id };
  await h.agent.recoverBinding(run, attempt, context, window, binding);
  assert.equal(binding.threadId, 'native-main'); assert.equal(context.selectedThread, 'native-main');
  assert.equal(binding.ownership, 'ordinary'); assert.equal(h.changes.length, 0);
});
test('stopping project setup releases only its pending context and leaves the native trust view intact', () => {
  const h = fixture(); let disposed = 0;
  h.agent.mainProjects.set('run', { dispose: () => disposed++ });
  h.agent.releaseMainProject({ id: 'run' });
  assert.equal(disposed, 1); assert.equal(h.agent.mainProjects.size, 0); assert.equal(h.changes.length, 0);
});
test('the main binds the selected ordinary thread without navigating, and leaves unrelated threads and drafts intact', async () => {
  const h = fixture(), binding = { id: 'main-binding', role: 'main', app: 'cursor', windowId: 'ordinary', threadId: 'chosen' };
  const run = { tasks: [], bindings: [binding], main: { bindingId: binding.id } }, attempt = { id: 'attempt' };
  let thread = 'chosen', draft = '', busy = false;
  const context = { app: 'cursor', cdp: { evaluate: async call => call === 'activeThread()' ? thread : call === 'composerDraft()' ? draft : { busy } } };
  const window = { id: 'ordinary', role: 'main', binding, bindingId: binding.id, expectedThread: binding.threadId };
  await h.agent.bind(run, attempt, context, window, false);
  assert.equal(attempt.bindingId, binding.id); assert.equal(h.changes.length, 0);
  thread = 'unrelated'; await assert.rejects(h.agent.bind(run, attempt, context, window, false), /切到其他会话/);
  assert.equal(thread, 'unrelated'); assert.equal(binding.observedThread, 'unrelated');
  thread = 'chosen'; draft = 'ordinary unsent draft';
  await assert.rejects(h.agent.bind(run, attempt, context, window, false), /草稿已保留/);
  assert.equal(draft, 'ordinary unsent draft'); assert.equal(h.changes.length, 0);
  draft = ''; busy = true; await assert.rejects(h.agent.bind(run, attempt, context, window, false), /仍在原生执行/);
});
test('main recovery observes the original ordinary binding and neither opens a child window nor reconfigures or resends', async () => {
  const h = fixture(), calls = [], binding = { id: 'original', role: 'main', app: 'cursor', windowId: 'ordinary', threadId: 'native-main' };
  const attempt = { id: 'attempt', kind: 'decision', app: 'cursor', bindingId: binding.id, submission: 'accepted' };
  const run = { tasks: [], bindings: [binding], main: { bindingId: 'new-config' }, attempts: [attempt] };
  h.agent.mainWindowFor = async (_run, value) => { assert.equal(value, attempt); return { id: 'ordinary', role: 'main', binding, bindingId: binding.id }; };
  h.agent.windowFor = async () => assert.fail('main recovery opened a child window');
  h.agent.context = async () => ({ app: 'cursor', cdp: { evaluate: async call => call === 'activeThread()' ? 'native-main' : '' } });
  h.agent.closeContext = () => calls.push('release'); h.agent.configure = async () => assert.fail('recovery configured a model');
  h.agent.observe = async () => { calls.push('observe'); return { completed: true }; };
  await h.agent.execute(run, attempt.id, 'original prompt', true);
  assert.deepEqual(calls, ['observe', 'release']); assert.equal(h.changes.length, 0);
});
test('native archive never opens or archives a main ordinary session', async () => {
  const h = fixture();
  h.agent.windowFor = async () => assert.fail('main archive opened a window');
  const binding = { id: 'ordinary-main', role: 'main', threadId: 'ordinary' };
  await h.agent.archive({ bindings: [binding] }, binding.id);
  assert.equal(binding.archived, undefined);
});
test('recovery uses the original binding and observes without configuring or submitting again', async () => {
  const h = fixture(), calls = [];
  const run = { stopRequested: false, project: { id: 'p' }, tasks: [{ id: 'B1', executor: 'child' }], capabilities: [],
    attempts: [{ id: 'a', app: 'cursor', taskId: 'B1', kind: 'task', submission: 'accepted', status: 'unknown' }] };
  h.agent.windowFor = async (_run, _app, create) => { calls.push(['window', create]); return { id: 'owned' }; };
  h.agent.context = async () => ({ cdp: {}, editorCdp: {}, focusTimer: null });
  h.agent.closeContext = () => calls.push(['release']);
  h.agent.bind = async (_run, _attempt, _context, _window, recovery) => { calls.push(['binding', recovery]); return { id: 'binding' }; };
  h.agent.configure = async () => assert.fail('recovery changed the model');
  h.agent.observe = async () => { calls.push(['observe']); return { completed: true }; };
  await h.agent.execute(run, 'a', 'original', true);
  assert.deepEqual(calls, [['window', false], ['binding', true], ['observe'], ['release']]);
  assert.equal(h.agent.active.size, 0);
});
test('native permission actions require the current attempt and binding', async () => {
  const h = fixture();
  await assert.rejects(h.agent.nativeAction('expired', { bindingId: 'old' }), /当前执行/);
  h.agent.active.set('a', { binding: { id: 'current' } });
  await assert.rejects(h.agent.nativeAction('a', { bindingId: 'old' }), /当前执行/);
});

test('Cursor completion uses the native generation status and returns only the final reply of this turn', async () => {
  const page = fs.readFileSync(new URL('../server/page/chat-extract.js', import.meta.url), 'utf8');
  const headers = [{ type: 1, bubbleId: 'old' }, { type: 2, bubbleId: 'old-reply' },
    { type: 1, bubbleId: 'current' }, { type: 2, bubbleId: 'thought' }, { type: 2, bubbleId: 'final' }];
  const bubbles = { 'old-reply': { text: 'historical fusion-control' }, thought: { text: 'thinking fusion-control', thinking: true }, final: { text: '本轮最终回复' } };
  const data = { fullConversationHeadersOnly: headers, conversationMap: bubbles, status: 'completed', latestChatGenerationUUID: 'generation' };
  let busy = false;
  const context = vm.createContext({ codexThread: () => '', devinSurface: () => '', activeThread: () => 'thread',
    cursorSessionServices: () => ({ data: { composerDataHandleManager: { peekComposerData: async () => ({ source: 'memory', handle: { data } }) } } }),
    isBusy: () => busy, Number, Promise, String });
  const start = page.indexOf('  const codexFusionTurn =');
  vm.runInContext(page.slice(start, page.indexOf('  // One Codex turn', start)) + '\nthis.read = codexFusionTurn;', context);
  const result = await context.read('current');
  assert.equal(result.completed, true); assert.equal(result.text, '本轮最终回复');
  assert.equal(result.turnId, 'current');
  assert.equal(result.generationId, 'generation');
  busy = true; assert.equal((await context.read('current')).completed, false);
  busy = false; data.status = 'generating'; assert.equal((await context.read('current')).completed, false);
  data.status = 'completed'; headers.push({ type: 1, bubbleId: 'newer' });
  assert.equal((await context.read('current')).completed, false);
  assert.equal((await context.read('current')).current, false);
  headers.splice(2); data.status = 'aborted';
  const stopped = await context.read('current', '', [], result.generationId);
  assert.equal(stopped.id, 'current'); assert.equal(stopped.ended, true); assert.equal(stopped.completed, false);
  assert.equal((await context.read('current', '', [], 'unrelated-generation')).ended, false);
});

test('a native abort stays stopping until generation has actually ended', async () => {
  let notify, ended = false, resolved = false, stops = 0;
  const h = fixture({ nativeWindow: () => ({ read: async () => ({ chat: { items: [], context: {} } }),
    subscribe: fn => { notify = fn; return () => {}; } }) });
  const attempt = { id: 'a', kind: 'decision', status: 'stopping', acceptedAt: 1, native: { messageId: 'u' } };
  const run = { attempts: [attempt], project: { id: 'p' }, capabilities: [] };
  const runtime = { run, attemptId: 'a', stopping: true, binding: { id: 'b', threadId: 't' }, window: { id: 'w' },
    context: { app: 'cursor', cdp: { evaluate: async () => ({ id: 'u', turnId: 'u', threadId: 't', current: true,
      accepted: true, ended, completed: false, error: 'Cursor 原生执行已中断：user' }) },
    adapter: { accountUsage: async () => ({}) } } };
  h.agent.stop = async () => { stops++; runtime.stopSubmitted = true; };
  const result = h.agent.observe(runtime).then(value => { resolved = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolved, false); assert.equal(attempt.status, 'stopping'); assert.equal(stops, 1);
  ended = true; await notify();
  assert.equal((await result).stopped, true); assert.ok(attempt.nativeGenerationEndedAt); assert.equal(stops, 1);
});

test('stop reconciles ended or unconfirmed rounds and never clicks a different native round', async () => {
  const h = fixture(); let turn = { id: '', accepted: false }, clicked = 0, checked = 0;
  const runtime = { run: { attempts: [{ id: 'a', native: { messageId: 'owned' } }] }, binding: { threadId: 't' },
    context: { cdp: { evaluate: async () => turn }, assertSelectedThread: async () => {}, withFocus: fn => fn(),
      stopButton: async () => { clicked++; }, selectionKey: () => 's' }, check: () => { checked++; } };
  h.agent.active.set('a', runtime);
  await h.agent.stop('a'); assert.equal(clicked, 0); assert.equal(checked, 1);
  turn = { id: 'owned', ended: true }; await h.agent.stop('a'); assert.equal(clicked, 0);
  turn = { id: 'owned', threadId: 't', current: false, ended: false };
  await assert.rejects(h.agent.stop('a'), /其他轮次/); assert.equal(clicked, 0);
  turn.current = true; await h.agent.stop('a'); await h.agent.stop('a'); assert.equal(clicked, 1);
});

test('Fusion requests native archive explicitly and never substitutes delete', () => {
  const page = fs.readFileSync(new URL('../server/page/codex.js', import.meta.url), 'utf8');
  let labels = ['Delete chat', 'Archive chat'];
  const row = { scrollIntoView() {}, querySelectorAll: () => labels.map(label => ({ label,
    getAttribute: () => label, getBoundingClientRect: () => ({ width: 10 }) })) };
  const context = vm.createContext({ codexArchiveRow: () => row, codexPoint: button => ({ selected: button.label }) });
  const start = page.indexOf('  const codexArchiveTarget =');
  vm.runInContext(page.slice(start, page.indexOf('  const codexArchiveConfirm', start)) + '\nthis.target = codexArchiveTarget;', context);
  assert.equal(context.target('thread').action, 'Delete chat');
  assert.equal(context.target('thread', 'Archive chat').selected, 'Archive chat');
  labels = ['Delete chat']; assert.equal(context.target('thread', 'Archive chat').action, '');
});

test('a child is marked archived only after native archive state is confirmed', async () => {
  for (const [supported, confirmed] of [[false, false], [true, false], [true, true]]) {
    const h = fixture(), binding = { id: 'binding', app: 'codex', threadId: 'thread' };
    const run = { bindings: [binding] };
    h.agent.windowFor = async () => ({ id: 'window' });
    h.agent.context = async () => ({ app: 'codex', cdp: { evaluate: async call => call === 'activeThread()' ? 'thread'
      : call === 'composerDraft()' ? '' : { rows: [{ id: 'thread', archived: confirmed }] } },
      codexThreadRows: async () => [{ id: 'thread', running: false }],
      codexArchiveThread: async (id, action) => { assert.equal(id, 'thread:window:thread'); assert.equal(action, 'Archive chat'); return supported; } });
    h.agent.closeContext = () => {};
    if (supported && !confirmed) await assert.rejects(h.agent.archive(run, 'binding'), /归档状态尚未确认/);
    else await h.agent.archive(run, 'binding');
    assert.equal(!!binding.archived, supported && confirmed);
    if (!supported) assert.equal(binding.archive.supported, false);
  }
});

test('continuing after window recycling opens the existing native session with a new binding and preserves the old fact', async () => {
  const h = fixture(), opened = [];
  const old = { id: 'old-binding', app: 'cursor', host: '', projectId: 'project', windowId: 'closed-window',
    threadId: 'native-thread', role: 'B1', archived: false };
  const task = { id: 'B1', executor: 'child', bindingId: old.id };
  const run = { project: { id: 'project' }, main: { app: 'codex' }, tasks: [task], bindings: [old] };
  const original = JSON.stringify(old), attempt = { id: 'new-attempt', app: 'cursor', kind: 'task', taskId: 'B1' };
  let current = '';
  const context = { app: 'cursor', cdp: { evaluate: async call => call === 'activeThread()' ? current
    : call === 'composerDraft()' ? '' : { busy: false } }, withFocus: fn => fn(),
    adapter: { openAgent: async id => { opened.push(id); current = id; }, newChat: async () => assert.fail('a resumed binding created a new chat') } };
  const binding = await h.agent.bind(run, attempt, context, { id: 'new-window' }, false);
  assert.deepEqual(opened, ['native-thread']); assert.equal(JSON.stringify(old), original);
  assert.notEqual(binding.id, old.id); assert.equal(binding.previousBindingId, old.id);
  assert.equal(binding.windowId, 'new-window'); assert.equal(binding.threadId, old.threadId);
  assert.equal(task.bindingId, binding.id); assert.equal(attempt.bindingId, binding.id);
  assert.equal(await h.agent.bind(run, attempt, context, { id: 'new-window', bindingId: binding.id, expectedThread: current }, true), binding);
  assert.deepEqual(opened, ['native-thread']);
});

test('after the last native window exits, Fusion starts its own workspace once with the CDP port', async () => {
  let launched = false, reads = 0;
  const launches = [], page = { id: 'new-window', type: 'page', url: 'workbench', webSocketDebuggerUrl: 'memory://new-window' };
  const h = fixture({ path, AbortSignal, DATA_DIR: '/memory', EDITORS: [{ app: 'cursor', url: 'memory://cursor' }],
    fs: { mkdir: async () => {}, writeFile: async () => {} }, fusionProjectWindows: () => [],
    fetch: async () => {
      reads++;
      if (!launched || reads === 2) throw Object.assign(new Error('not listening'), { cause: { code: 'ECONNREFUSED' } });
      return { json: async () => [page] };
    }, pause: async () => {},
    openFolder: async (...args) => { launches.push(args); launched = true; },
    Cdp: class { async connect() {} close() {} }, editorRoots: async () => [{ root: '/project' }], fusionProject: () => ({ id: 'project' }),
    trackFusionWindow: (_computer, app, target) => ({ app, id: target.id }) });
  const run = { computer: 'computer', project: { id: 'project', root: '/project' } };
  const [one, two] = await Promise.all([h.agent.windowFor(run, 'cursor'), h.agent.windowFor(run, 'cursor')]);
  assert.equal(one.id, 'new-window'); assert.equal(one, two); assert.equal(launches.length, 1);
  assert.equal(launches[0][1], 'cursor'); assert.equal(launches[0][2], true); assert.equal(launches[0][3], true);
});
test('Cursor child creation selects an available native window service before issuing a single open request', async () => {
  const probes = [], creates = [];
  let created = false;
  const page = id => ({ id, type: 'page', url: 'workbench', webSocketDebuggerUrl: id });
  const h = fixture({ path, AbortSignal, PAGE_SRC: '({})', DATA_DIR: '/memory', EDITORS: [{ app: 'cursor', url: 'memory://cursor' }],
    fs: { mkdir: async () => {}, writeFile: async () => {} }, fusionProjectWindows: () => [],
    fetch: async () => ({ json: async () => [page('empty-main'), page('native-service'), ...(created ? [page('child')] : [])] }),
    Cdp: class { constructor(id) { this.id=id; } async connect() {} close() {} async evaluate(call) {
      if (call.includes('nativeSessionInfo')) { probes.push(this.id); return this.id==='native-service'; }
      assert.match(call, /^cursorSelectProject/); creates.push(this.id); created=true;
    } },
    openFolder: async () => assert.fail('a missing service must not launch a second channel'),
    editorRoots: async () => [{ root: '/project' }], fusionProject: () => ({ id: 'project' }),
    trackFusionWindow: (_computer, app, target) => ({ app, id: target.id }), pause: async () => {},
  });
  const window = await h.agent.windowFor({ computer: 'computer', project: { id: 'project', root: '/project' } }, 'cursor');
  assert.deepEqual(probes, ['empty-main','native-service']); assert.deepEqual(creates, ['native-service']);
  assert.equal(window.id,'child');
});

test('the shared project opener preserves ordinary launch commands and adds CDP only on explicit Fusion requests', async () => {
  const text = fs.readFileSync(new URL('../server/agent/projects.mjs', import.meta.url), 'utf8');
  const source = text.slice(text.indexOf('export async function openFolder('), text.indexOf('// PID of the app')).replace('export async function', 'async function');
  for (const windows of [false, true]) {
    const calls = [];
    const context = vm.createContext({ path, URL, IS_WIN: windows, CDP_URL: 'http://localhost:9222', DEVIN_CDP_URL: 'http://localhost:9223', CODEX_CDP_URL: 'http://localhost:9224',
      safeHomePath: real => ({ real }), findBin: () => '/installed/editor', process: { env: { ELECTRON_RUN_AS_NODE: '1', VSCODE_IPC_HOOK_CLI: 'old' } },
      spawn: (command, args, options) => { calls.push({ command, args: Array.from(args), options }); return {
        stderr: { on() {} }, once: (event, callback) => { if (event === 'exit') queueMicrotask(() => callback(0)); }, unref() {},
      }; } });
    vm.runInContext(source + '\nthis.open = openFolder;', context);
    await context.open('/workspace/project.code-workspace', 'cursor', true);
    const ordinary = calls[0];
    if (windows) {
      assert.deepEqual(ordinary.args, ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; & '/installed/resources/app/bin/cursor.cmd' -n '/workspace/project.code-workspace'; exit $LASTEXITCODE"]);
    } else assert.deepEqual(ordinary.args, ['-n', '/workspace/project.code-workspace']);
    await context.open('/workspace/fusion.code-workspace', 'cursor', true, true);
    assert.ok(calls[1].args.some(arg => arg.includes('--remote-debugging-port=9222')));
    assert.equal(ordinary.options.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(ordinary.options.env.VSCODE_IPC_HOOK_CLI, undefined);
  }
});
test('main project opening reuses the ordinary resolver, while new main sessions leave ordinary drafts and child windows alone', async () => {
  const text = fs.readFileSync(new URL('../server/agent/projects.mjs', import.meta.url), 'utf8');
  for (const [fusion, newSession, child] of [[false, true, false], [true, false, false], [true, true, false], [true, false, true]]) {
    const calls = [], draft = 'ordinary draft', page = id => ({ id, title: id, type: 'page', url: 'workbench', webSocketDebuggerUrl: id });
    const pages = [page('ordinary')];
    const scope = vm.createContext({ Promise, Map, Set, Date, IS_WIN: false, AbortSignal,
      safeHomePath: root => ({ real: root }), fusionProject: root => ({ id: root }),
      fusionTargets: () => ({ windows: new Set(child ? ['cursor:ordinary'] : []) }),
      cdpRead: { getStore: () => null, run: () => Promise.resolve() }, EDITORS: [{ app: 'cursor', url: 'memory://cursor' }],
      editorRoots: async () => [{ root: '/project' }],
      Cdp: class { constructor(url) { this.wsUrl = url; } async connect() {} close() {} },
      fetch: async () => ({ json: async () => pages }), trackProjectWindow: (...args) => calls.push(['track', ...args]),
      openFolder: async (...args) => { calls.push(['open', ...args]); pages.push(page('new-window')); },
      awaitCdpRead: value => value, setTimeout: fn => fn(),
    });
    const methods = vm.runInContext(text.slice(text.indexOf('export const methods')).replace('export const methods', 'const methods') + '\nmethods;', scope);
    const current = { wsUrl: 'ordinary' };
    const session = { ...methods, app: 'cursor', fusionBinding: fusion, windowId: 'cursor:ordinary', editorCdp: current, cdp: current,
      projectWindowState: async (page, _thread, withDraft) => ({ thread: 'ordinary-thread', busy: false, draft: withDraft && page.id === 'ordinary' && !!draft }),
      emit() {}, async openBound(_win, _ws, _chat, selection) { this.windowId = selection.windowId; this.cdp = this.editorCdp = {}; },
      checkProjectTrust: async () => false, async finishProject() { calls.push(['ready', this.windowId]); },
      resumeProjectSwitch: async () => {}, listAgents: async () => {},
    };
    await session.useProject('/project', newSession);
    const opened = calls.find(call => call[0] === 'open');
    assert.equal(!!opened, fusion && (newSession || child));
    assert.deepEqual(calls.find(call => call[0] === 'ready'), ['ready', fusion && (newSession || child) ? 'cursor:new-window' : 'cursor:ordinary']);
    assert.equal(draft, 'ordinary draft');
    if (opened) assert.deepEqual(Array.from(opened), ['open', '/project', 'cursor', true]);
  }
});
test('Fusion project completion waits for the native model control before creating or binding, while ordinary completion keeps its existing timing', async () => {
  const text = fs.readFileSync(new URL('../server/agent/projects.mjs', import.meta.url), 'utf8');
  const scope = vm.createContext({ helpersCall: value => value, fusionProject: root => ({ id: root }), path,
    setTimeout: fn => fn() });
  const methods = vm.runInContext(text.slice(text.indexOf('export const methods')).replace('export const methods', 'const methods') + '\nmethods;', scope);
  for (const fusionBinding of [true,false]) {
    let ready, accepted = false, newChats = 0;
    const gate = new Promise(resolve => { ready = () => { accepted=true; resolve(true); }; });
    const context = { app: 'cursor', fusionBinding, pendingProject: { root: '/project', newSession: true },
      editorCdp: { evaluate: async () => ({ required: false }) },
      cdp: { evaluate: async call => call === 'hasComposer()' ? true : { thread: 'new-native', items: [] } },
      waitFor: async call => { assert.equal(call,'control("model")'); assert.equal(fusionBinding,true); return gate; },
      currentRoots: async () => [{ root: '/project' }], syncSession() {}, publishThread() {}, emit() {}, selectionKey: () => 'cursor|window|new-native',
      adapter: { newChat: async () => { if(fusionBinding)assert.equal(accepted,true);newChats++; } },
    };
    const work = methods.finishProject.call(context);
    await new Promise(resolve => setImmediate(resolve));
    if(fusionBinding) { assert.equal(newChats,0);assert.equal(context.bindingReady,undefined);ready(); }
    await work;assert.equal(newChats,1);assert.equal(context.bindingReady,true);assert.equal(context.threadId,'new-native');
  }
});
test('reading a stopped run main configuration stays read-only and does not resume or enqueue model execution', async () => {
  const calls = [], run = { id: 'run', computer: 'computer', stopRequested: true, status: 'stopped',
    project: { id: 'project', root: '/project' }, main: { app: 'cursor', model: 'Auto', bindingId: 'ordinary-main' }, attempts: [], capabilities: [] };
  const scheduler = new FusionScheduler();
  const agent = { capabilities: async (_run, app, role) => { calls.push([app,role]); return { app,models:[],available:true }; } };
  const scope = vm.createContext({ computerId: () => 'computer', findFusionRun: () => run,
    fusionRunner: () => ({ scheduler, agent }), publishFusion() {}, subscribeFusion() {},
    fusionTargets: () => ({ sessions: new Set() }), nativeSessionCatalog: () => null,
  });
  const ownerText = fs.readFileSync(new URL('../server/fusion/owner.mjs', import.meta.url), 'utf8').replace(/^import [\s\S]*?;\n/gm,'').replace('export const FUSION_OWNER','const FUSION_OWNER');
  const owner = vm.runInContext(ownerText+'\nFUSION_OWNER;',scope), emitted=[];
  await owner.fusionPrepare.call({deviceId:'device',emit:message=>emitted.push(message)},{computer:'computer',runId:'run',requestId:'read'});
  assert.deepEqual(calls,[['cursor','main']]);assert.equal(run.status,'stopped');assert.equal(run.stopRequested,true);
  assert.equal(run.attempts.length,0);assert.equal(emitted[0].t,'fusionState');assert.equal(scheduler.slots.size,0);
});

test('a newly opened Fusion Cursor window waits for its native model control before becoming initialized', async () => {
  let ready, watching = false, waiting = false;
  const gate = new Promise(resolve => { ready = resolve; });
  const h = fixture({
    AgentContext: class { async waitFor(call) {
      const result = vm.runInNewContext('({control: name => name === "model" ? {x: 1, y: 1} : null}).' + call);
      assert.ok(result); waiting = true; return gate;
    } },
    NativeCdp: class { constructor(url) { this.wsUrl = url; } async connect() {} async evaluate(call) { return call === 'workspaceTrustState()' ? { required: false } : ''; } close() {} },
    nativeWindow: () => ({ start: async () => { watching = true; } }),
  });
  const window = { id: 'reopened', page: { title: 'Fusion workspace', webSocketDebuggerUrl: 'memory://reopened' } };
  const opening = h.agent.context({ deviceId: 'test' }, 'cursor', window);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(waiting, true); assert.equal(watching, false);
  ready(true); const context = await opening;
  assert.equal(watching, true); assert.equal(window.initialized, true); assert.equal(context.windowId, 'reopened');
});
