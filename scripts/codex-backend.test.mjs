import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexClient } from '../server/codex/client.mjs';
import { CodexState } from '../server/codex/state.mjs';
import { cdpRead } from '../server/cdp.mjs';
import { currentOperation, withOperation } from '../server/operations.mjs';
import { watchChatUpdates } from '../server/agent/updates.mjs';
import vm from 'node:vm';
import path from 'node:path';
import fs from 'node:fs';
import { read, fragment } from './page-fixture.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

function backendRoutesFor(extra) {
  return vm.runInContext(fragment(read('server/apps/codex.mjs'), 'const backendRoutes =', 'function serializedCodexPrompt') + '\nbackendRoutes;', vm.createContext({ path, ...extra }));
}

test('backend @ search uses the selected project and keeps distinct full paths; slash skills stay native', async () => {
  const calls = [], events = [];
  const routes = backendRoutesFor({ backendSkills: async () => [{ label: 'inspect', sub: 'review', key: '/skills/inspect', section: 'Skills' }],
    codexBackend: { client: { request: async (method, params) => {
      calls.push({ method, params }); return { files: [
        { root: '/B', path: 'src/a.js', file_name: 'a.js' }, { root: '/B', path: 'test/a.js', file_name: 'a.js' },
      ] };
    } } } });
  const session = { codexDirectory: '/B', selectionKey: () => 'B', emit: message => events.push(message) };
  await routes.mentionQuery.call(session, { trigger: '@', q: 'a', seq: 8 });
  assert.equal(calls[0].method, 'fuzzyFileSearch'); assert.deepEqual([...calls[0].params.roots], ['/B']);
  assert.deepEqual(Array.from(events[0].rows, row => row.key), ['/B/src/a.js', '/B/test/a.js']);
  assert.equal(events[0].seq, 8); assert.equal(events[0].sel, 'B');
  await routes.mentionQuery.call(session, { trigger: '/', q: 'insp', seq: 9 });
  assert.equal(calls.length, 1); assert.equal(events[1].rows[0].section, 'Skills');
});

test('backend sending resolves selected @ file keys without losing existing skills or local files', async () => {
  const sent = [], events = [], context = vm.createContext({
    pendingUploads: () => [], cdpRead, currentOperation: () => null, backendPublish: () => {}, rememberSessionMessage: () => {},
    uploadAttachments: () => [], codexBackend: { send: async (...args) => { sent.push(args); return { queued: false }; } },
  });
  const method = vm.runInContext('({' + fragment(read('server/apps/codex.mjs'), '  async sendBackendMessage(', '  async newChat(') + '}).sendBackendMessage', context);
  await method.call({ threadId: 'B', selectionKey: () => 'B', emit: value => events.push(value) }, 'question', true, '', [
    { section: 'files', key: '/B/src/a.js', label: 'a.js' }, { section: 'Skills', key: '/skills/inspect', label: 'inspect' },
    { section: 'local-files', path: '/outside/reference.txt' },
  ], { requestId: 'send' });
  assert.equal(sent[0][1][1].text, '引用文件：/B/src/a.js');
  assert.equal(sent[0][1][2].type, 'skill'); assert.equal(sent[0][1][2].path, '/skills/inspect');
  assert.equal(sent[0][1][3].text, '引用文件：/outside/reference.txt');
  assert.equal(events[0].t, 'sent');
});

async function retryFixture() {
  const { state, client } = fixture();
  const thread = await state.create('/A'), request = client.request;
  let number = 0;
  client.request = async (method, params) => method === 'turn/start'
    ? (client.sent.push({ method, params }), { turn: { id: 'retry-' + ++number, status: 'inProgress', items: [] } })
    : request(method, params);
  const fail = (id, info = 'serverOverloaded', willRetry = false) => {
    if (!thread.turns.some(turn => turn.id === id)) thread.turns.push({ id, status: 'inProgress', items: [] });
    const error = { message: 'capacity sample', codexErrorInfo: info };
    client.emit('notification', { method: 'error', params: { threadId: '/A', turnId: id, error, willRetry } });
    client.emit('notification', { method: 'turn/completed', params: { threadId: '/A', turn: { id, status: 'failed', items: [], error } } });
  };
  return { state, client, thread, fail, starts: () => client.sent.filter(row => row.method === 'turn/start') };
}

test('manual retry stays visible when auto retry is off and continues with empty input exactly once', async () => {
  const h = await retryFixture(); h.fail('failed');
  const notice = h.state.chat('/A').items.at(-1);
  assert.deepEqual(notice.b, ['重试']); assert.equal(notice.btnItem, 'failed');
  const routes = backendRoutesFor({ codexBackend: h.state });
  const session = { threadId: '/A', selectionKey: () => 'A', emit() {} };
  await routes.click.call(session, { sel: 'A', item: 'failed', n: 0, actionId: 'capacity-retry' });
  assert.equal(h.starts().length, 1); assert.deepEqual(h.starts()[0].params.input, []);
  assert.equal(h.starts()[0].params.turnTrigger, 'capacity_retry_manual');
  assert.equal(h.state.chat('/A').items.some(item => item.k === 'human'), false);
  await assert.rejects(routes.click.call(session, { sel: 'A', item: 'failed', n: 0, actionId: 'capacity-retry' }), /已更新/);
  assert.equal(h.starts().length, 1);
});

test('automatic capacity retries share a per-thread limit and retain the manual action after exhaustion', async () => {
  const h = await retryFixture(), notices = [], owner = {};
  h.state.setRetry(owner, '/A', { enabled: true, count: 2, notify: value => notices.push(value) });
  h.fail('first'); h.state.retryCapacity('/A'); await tick();
  assert.equal(h.starts().length, 1);
  h.fail('retry-1', 'policyCapacityUnavailable'); await tick();
  assert.equal(h.starts().length, 2);
  h.fail('retry-2'); await tick();
  assert.equal(h.starts().length, 2); assert.equal(notices.at(-1).count, 2);
  assert.deepEqual(h.state.chat('/A').items.at(-1).actions, ['capacity-retry']);
  assert(h.starts().every(row => row.params.turnTrigger === 'capacity_retry_automatic' && row.params.input.length === 0));
});

for (const kind of ['usageLimitExceeded', 'unauthorized', 'sandboxError']) test(`auto retry does not retry ${kind}`, async () => {
  const h = await retryFixture(); h.state.setRetry({}, '/A', { enabled: true, count: 5, notify() {} });
  h.fail('failed', kind); await tick();
  assert.equal(h.starts().length, 0); assert.equal(h.state.chat('/A').items.at(-1).b, undefined);
});

test('native retry in progress never triggers an additional RA retry', async () => {
  const h = await retryFixture(); h.state.setRetry({}, '/A', { enabled: true, count: 2, notify() {} });
  h.fail('native', 'serverOverloaded', true); await tick();
  assert.equal(h.starts().length, 0); assert.equal(h.state.chat('/A').items.at(-1).b, undefined);
  h.client.emit('notification', { method: 'turn/completed', params: { threadId: '/A', turn: { id: 'native', status: 'completed', items: [], error: null } } });
  assert.equal(h.state.chat('/A').items.some(item => item.k === 'notice'), false);
});

test('leaving a selected view cancels an automatic retry that has not dispatched', async () => {
  const h = await retryFixture(), owner = {}; h.fail('first');
  let resume;
  h.state.load = () => new Promise(resolve => { resume = () => resolve(h.thread); });
  h.state.setRetry(owner, '/A', { enabled: true, count: 2, notify() { throw Error('stale callback'); } });
  h.state.clearRetry(owner); resume(); await tick();
  assert.equal(h.starts().length, 0); assert.equal(h.state.retrySettings.size, 0);
});

test('duplicate manual requests share their in-flight native operation', async () => {
  const h = await retryFixture(); h.fail('first');
  const a = h.state.retry('/A', 'first'), b = h.state.retry('/A', 'first');
  assert.equal(a, b); await Promise.all([a, b]); assert.equal(h.starts().length, 1);
});

test('opening a Codex project resumes its latest backend thread; new-session explicitly creates one', async () => {
  const calls = [], records = new Map([['A', { id: 'A', cwd: '/A', updatedAt: 10 }], ['B', { id: 'B', cwd: '/B', updatedAt: 20 }]]);
  const context = vm.createContext({ path, os: { homedir: () => '/home' }, safeHomePath: real => ({ real }),
    CODEX_BACKEND: 'backend', cdpRead, awaitCdpRead: promise => promise, rememberSelection: () => {}, backendAttached: () => {},
    codexBackend: { records, load: async id => { calls.push(['load', id]); return { id, cwd: records.get(id).cwd }; },
      create: async cwd => { calls.push(['create', cwd]); return { id: 'new-B', cwd }; } },
  });
  const bind = vm.runInContext(fragment(read('server/apps/codex.mjs'), 'async function bindBackend(', 'const backendRoutes =') + '\nbindBackend;', context);
  const session = { detach() {}, clearViewState() {}, selectionKey: () => '', setMode: async () => {}, projectReady: pending => calls.push(['ready', pending.newSession]) };
  await bind(session, { project: { root: '/B' } });
  assert.equal(session.threadId, 'B');
  await bind(session, { project: { root: '/B' }, newSession: true });
  assert.equal(session.threadId, 'new-B');
  assert.deepEqual(calls, [['load', 'B'], ['ready', false], ['create', '/B'], ['ready', true]]);
});
function fixture(file = null) {
  const client = new EventEmitter();
  client.generation = 1;
  client.connect = async () => {};
  client.sent = [];
  client.request = async (method, params) => {
    client.sent.push({ method, params });
    if (method === 'thread/start') return { thread: { id: params.cwd, cwd: params.cwd, turns: [], createdAt: 1, updatedAt: 1 }, model: 'test' };
    if (method === 'thread/resume') return { thread: { id: params.threadId, cwd: params.threadId, turns: [], createdAt: 1, updatedAt: 1 }, model: 'test' };
    if (method === 'thread/fork') {
      const source = state.threads.get(params.threadId), end = source.turns.findIndex(turn => turn.id === params.lastTurnId);
      return { thread: structuredClone({ ...source, id: source.id + ':fork', turns: source.turns.slice(0, end + 1) }), model: 'test' };
    }
    if (method === 'thread/queue/list') return { data: [] };
    if (method === 'thread/queue/add') return { queuedSubmission: { id: 'queue', clientUserMessageId: params.clientUserMessageId,
      input: params.input.map(row => row.type === 'text' ? { ...row, text_elements: [] } : row) } };
    if (method === 'turn/start') return { turn: { id: 'turn', status: 'inProgress', startedAt: 2, items: [] } };
    if (method === 'turn/steer') return { turnId: params.expectedTurnId };
    return {};
  };
  client.reply = (id, result) => client.sent.push({ id, result });
  client.reject = (id, error) => client.sent.push({ id, error });
  const state = new CodexState({ client, file });
  return { client, state };
}

test('Codex backend fast routes reuse their native handler; desktop and OpenCode routes retain theirs', async () => {
  const calls = [], desktop = () => calls.push('desktop'), native = function (m) { calls.push(['native', this.threadId, m.automatic]); };
  const context = vm.createContext({ ROUTES: { usage: { fast: true, fastRun: desktop }, stop: { fast: true, fastRun: desktop } } });
  const resolve = vm.runInContext(fragment(read('server/routes.mjs'), 'export function resolveRoute(', 'const fusionRoute')
    .replace('export function', 'function') + '\nresolveRoute;', context);
  const backend = { app: 'codex', codexBackend: true, threadId: 'A', adapter: { backendRoutes: { usage: native, stop: native } } };
  const route = resolve(backend, 'usage');
  assert.equal(route.fastRun, route.run); await route.fastRun(backend, { automatic: false });
  await resolve(backend, 'stop').fastRun(backend, { automatic: true });
  assert.equal(resolve({ app: 'codex' }, 'usage').fastRun, desktop);
  assert.equal(resolve({ app: 'opencode', adapter: { routes: { usage: native } } }, 'usage').fastRun, desktop);
  assert.deepEqual(calls, [['native', 'A', false], ['native', 'A', true]]);
});

test('backend quota preserves native used percent, reset time and update time; the existing renderer shows remaining', async () => {
  const events = [], limits = { planType: 'test-plan', primary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: 1800000000 }, secondary: null };
  const context = vm.createContext({ codexBackend: { client: { request: async method => { assert.equal(method, 'account/rateLimits/read'); return { rateLimits: limits }; } },
    chat: () => ({ context: { pct: 8 } }) } });
  const routes = vm.runInContext(fragment(read('server/apps/codex.mjs'), 'const backendRoutes =', 'function serializedCodexPrompt') + '\nbackendRoutes;', context);
  await routes.usage.call({ threadId: 'A', selectionKey: () => 'codex|backend|A', emit: row => events.push(row) }, { automatic: false });
  const result = events[0]; assert.equal(result.updated > 0, true);
  assert.equal(result.limits[0].pct, 18); assert.equal(result.limits[0].basis, 'used');
  assert.equal(result.limits[0].reset, new Date(1800000000 * 1000).toLocaleString('zh-CN'));
  assert.equal(result.limits[0].label, 'Weekly'); assert.equal(result.context.pct, 8);
  const bars = vm.runInContext(fragment(read('app/js/sheets.js'), 'function fusionUsageBars(', 'function showTerminals(') + '\nfusionUsageBars;', vm.createContext({}));
  assert.equal(bars(result)[0].pct, 82); assert.equal(bars(result)[0].basis, 'remaining');
});

function usageEvent(client, id, turnId, total, last = total) {
  client.emit('notification', { method: 'thread/tokenUsage/updated', params: {
    threadId: id, turnId, tokenUsage: { total, last, modelContextWindow: 1000 },
  } });
}
const firstUsage = { totalTokens: 100, inputTokens: 90, outputTokens: 10, reasoningOutputTokens: 2, cachedInputTokens: 40, cacheWriteInputTokens: 5 };

test('a turn sums all native calls without double counting, while context uses only the last call', async () => {
  const { state, client } = fixture(); await state.create('/A');
  client.emit('notification', { method: 'turn/started', params: { threadId: '/A', turn: { id: 'first', status: 'inProgress', items: [] } } });
  usageEvent(client, '/A', 'first', firstUsage);
  client.emit('notification', { method: 'turn/completed', params: { threadId: '/A', turn: { id: 'first', status: 'completed', items: [] } } });
  client.emit('notification', { method: 'turn/started', params: { threadId: '/A', turn: { id: 'second', status: 'inProgress', items: [], startedAt: 2 } } });
  const total = { totalTokens: 300, inputTokens: 260, outputTokens: 40, reasoningOutputTokens: 8, cachedInputTokens: 120, cacheWriteInputTokens: 20 };
  const last = { totalTokens: 80, inputTokens: 70, outputTokens: 10, reasoningOutputTokens: 2, cachedInputTokens: 30, cacheWriteInputTokens: 5 };
  usageEvent(client, '/A', 'second', { ...total, totalTokens: 200, inputTokens: 170, outputTokens: 30 }, last);
  usageEvent(client, '/A', 'second', total, last); usageEvent(client, '/A', 'second', total, last);
  state.threads.get('/A').settings.model = 'next-model';
  client.emit('notification', { method: 'turn/completed', params: { threadId: '/A', turn: { id: 'second', status: 'completed', items: [], startedAt: 2, completedAt: 4, durationMs: 2000 } } });
  const chat = state.chat('/A');
  assert.deepEqual(chat.performance.tokens, { input: 170, output: 30, reasoning: 6, cacheRead: 80, cacheWrite: 15 });
  assert.equal(chat.performance.rate, 15); assert.equal(chat.context.used, 80); assert.equal(chat.context.pct, 8);
  assert.equal(chat.performance.model, 'test'); assert.equal(chat.model, 'next-model');
});

test('fork and resume retain usage received before the transcript and copy only the selected history', async t => {
  fs.mkdirSync('_shots', { recursive: true });
  const directory = fs.mkdtempSync(path.resolve('_shots/codex-statistics-regression-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json'), { state, client } = fixture(file);
  const source = await state.create('/A');
  source.settings.model = 'historical-model';
  for (const [id, total] of [['first', firstUsage], ['second', { ...firstUsage, totalTokens: 200, inputTokens: 180, outputTokens: 20 }]]) {
    client.emit('notification', { method: 'turn/started', params: { threadId: '/A', turn: { id, status: 'inProgress', items: [] } } });
    usageEvent(client, '/A', id, total);
    client.emit('notification', { method: 'turn/completed', params: { threadId: '/A', turn: { id, status: 'completed', items: [], durationMs: 1000 } } });
  }
  const request = client.request;
  client.request = async (method, params) => {
    if (method === 'thread/fork') usageEvent(client, '/A:fork', 'first', firstUsage);
    return request(method, params);
  };
  const fork = await state.fork('/A', 'first');
  assert.equal(state.chat(fork.id).context.used, 100);
  assert.equal(state.chat(fork.id).performance.tokens.output, 10);
  assert.equal(state.chat(fork.id).performance.model, 'historical-model');
  assert.deepEqual(Object.keys(state.statistics.get(fork.id)), ['first']);
  assert.deepEqual(Object.keys(state.statistics.get('/A')), ['first', 'second']);
  const restored = fixture(file), resume = restored.client.request;
  restored.client.request = async (method, params) => {
    if (method === 'thread/resume') {
      usageEvent(restored.client, fork.id, 'first', firstUsage);
      return { thread: structuredClone(fork), model: 'current-model' };
    }
    return resume(method, params);
  };
  await restored.state.load(fork.id);
  assert.equal(restored.state.chat(fork.id).performance.tokens.output, 10);
  assert.equal(restored.state.chat(fork.id).performance.model, 'historical-model');
  assert.equal(restored.state.chat(fork.id).context.pct, 10);
  await restored.state.manage(fork.id, 'archive');
  assert.equal(restored.state.statistics.has(fork.id), false);
});

test('a fork restores persisted statistics even when the native resume does not emit usage', async () => {
  const { state, client } = fixture(); await state.create('/A');
  state.threads.get('/A').turns.push({ id: 'first', status: 'completed', items: [], durationMs: 1000 });
  usageEvent(client, '/A', 'first', firstUsage);
  const fork = await state.fork('/A', 'first'), records = structuredClone([...state.records]);
  const restored = fixture(); restored.state.records = new Map(records);
  restored.state.statistics = new Map(records.map(([id, row]) => [id, row.statistics]));
  const request = restored.client.request;
  restored.client.request = (method, params) => method === 'thread/resume' ? Promise.resolve({ thread: structuredClone(fork), model: 'test' }) : request(method, params);
  await restored.state.load(fork.id);
  assert.equal(restored.state.chat(fork.id).performance.rate, 10);
  assert.equal(restored.state.chat(fork.id).context.used, 100);
});

test('Codex app-server initialization is shared; replies, requests and events use separate channels', async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { this.emit('exit', 0); } });
  let spawned = 0;
  const sent = [];
  child.stdin.on('data', data => {
    const packet = JSON.parse(data);
    sent.push(packet);
    if (packet.method === 'initialize') child.stdout.write(JSON.stringify({ id: packet.id, result: {} }) + '\n');
  });
  const client = new CodexClient({ binary: async () => 'codex', spawnProcess: () => { spawned++; return child; } });
  await Promise.all([client.connect(), client.connect()]);
  assert.equal(spawned, 1);
  assert.equal(sent[0].method, 'initialize');
  assert.equal(sent[1].method, 'initialized');
  const events = [], requests = [];
  client.on('notification', p => events.push(p)); client.on('request', p => requests.push(p));
  const first = client.request('first'), second = client.request('second');
  child.stdout.write(JSON.stringify({ id: sent[3].id, result: 'second' }) + '\n');
  child.stdout.write(JSON.stringify({ id: 'approval', method: 'item/fileChange/requestApproval', params: {} }) + '\n');
  child.stdout.write(JSON.stringify({ method: 'turn/completed', params: {} }) + '\n');
  child.stdout.write(JSON.stringify({ id: sent[2].id, result: 'first' }) + '\n');
  assert.equal(await first, 'first'); assert.equal(await second, 'second');
  assert.equal(requests[0].id, 'approval'); assert.equal(events[0].method, 'turn/completed');
  const pending = client.request('pending');
  client.close();
  await assert.rejects(pending, /已退出/);
  assert.equal(client.pending.size, 0);
});

test('creating in project B reads back native cwd and never changes project A', async () => {
  const { state } = fixture();
  const a = await state.create('/A'), b = await state.create('/B');
  assert.equal(a.cwd, '/A'); assert.equal(b.cwd, '/B');
  assert.equal(state.records.get('/A').cwd, '/A');
  assert.equal(state.records.get('/B').cwd, '/B');
});

test('forking preserves native history through the chosen turn, source identity and project', async () => {
  const { state, client } = fixture();
  const source = await state.create('/A');
  source.turns.push(...[1, 2].map(n => ({ id: 'turn-' + n, status: 'completed', items: [
    { id: 'human-' + n, type: 'userMessage', content: [{ type: 'text', text: 'question ' + n }] },
    { id: 'reply-' + n, type: 'agentMessage', text: 'reply ' + n },
  ] })));
  const child = await state.fork('/A', 'turn-1');
  assert.notEqual(child.id, source.id); assert.equal(child.cwd, '/A');
  assert.deepEqual(child.turns.map(turn => turn.id), ['turn-1']);
  assert.deepEqual(source.turns.map(turn => turn.id), ['turn-1', 'turn-2']);
  assert.equal(state.records.get(child.id).cwd, '/A');
  assert.deepEqual(client.sent.find(row => row.method === 'thread/fork').params,
    { threadId: '/A', lastTurnId: 'turn-1', deferGoalContinuation: true });
  assert.equal(client.sent.some(row => row.method === 'turn/start'), false);
});

test('fork actions identify completed turns and appear only on their final assistant message', async () => {
  const { state } = fixture();
  const thread = await state.create('/A');
  thread.turns.push({ id: 'completed', status: 'completed', items: [
    { id: 'commentary', type: 'agentMessage', text: 'working' }, { id: 'final', type: 'agentMessage', text: 'done' },
  ] }, { id: 'active', status: 'inProgress', items: [{ id: 'stream', type: 'agentMessage', text: 'next' }] });
  const rows = state.chat('/A').items;
  assert.equal(rows[0].b, undefined); assert.equal(rows[2].b, undefined);
  assert.deepEqual(rows[1].b, ['Fork chat from here']);
  assert.equal(rows[1].btnItem, 'completed'); assert.deepEqual(rows[1].actions, ['fork']);
});

test('backend settings reuse the desktop settings routes; fork click binds the newly returned thread', async () => {
  const calls = [], events = [];
  const desktop = { showCodexSettings: (...args) => calls.push(['settings', ...args]), saveCodexInstructions: (...args) => calls.push(['instructions', ...args]) };
  const context = vm.createContext({ withBackendSettings: (_s, fn) => fn(desktop), closeBackendSettings: s => calls.push(['close', s.threadId]),
    awaitCdpRead: promise => promise, bindBackend: (_s, req) => calls.push(['bind', req.threadId]),
    codexBackend: { chat: () => ({ items: [{ btnItem: 'turn-1', actions: ['fork'] }] }),
      fork: async (...args) => { calls.push(['fork', ...args]); return { id: 'child' }; } },
  });
  const routes = vm.runInContext(fragment(read('server/apps/codex.mjs'), 'const backendRoutes =', 'function serializedCodexPrompt') + '\nbackendRoutes;', context);
  const session = { threadId: 'source', selectionKey: () => 'codex|backend|source', emit: message => events.push(message) };
  await routes.settings.call(session, { requestId: 1 });
  await routes.codexSetting.call(session, { id: 'toggle', requestId: 2, value: 'value' });
  await routes.codexInstructions.call(session, { requestId: 3, text: 'instructions' });
  await routes.closeCodexSettings.call(session);
  await assert.rejects(routes.click.call(session, { sel: 'codex|backend|old', item: 'turn-1', n: 0, actionId: 'fork' }), /会话已切换/);
  await routes.click.call(session, { sel: session.selectionKey(), item: 'turn-1', n: 0, actionId: 'fork' });
  assert.deepEqual(calls, [['settings', '', 1], ['settings', 'toggle', 2, 'value'], ['instructions', 'instructions', 3],
    ['close', 'source'], ['fork', 'source', 'turn-1'], ['bind', 'child']]);
  assert.equal(events.at(-1).clicked, true);
});

test('an empty Codex thread is committed natively before it is recorded; first text replaces only its automatic title', async () => {
  const { state, client } = fixture();
  await state.create('/A');
  assert.deepEqual(client.sent.slice(0, 2).map(row => row.method), ['thread/start', 'thread/name/set']);
  assert.equal(state.records.get('/A').untitled, true);
  await state.send('/A', [{ type: 'text', text: 'First request\nBody' }], '', 'first');
  assert.equal(state.records.get('/A').title, 'First request');
  assert.equal(state.records.get('/A').untitled, undefined);
  await state.manage('/A', 'rename', 'My title');
  await state.send('/A', [{ type: 'text', text: 'Next request' }], 'now', 'next');
  assert.equal(state.records.get('/A').title, 'My title');
});

test('listeners follow thread identity, returning home does not terminate an active generation', async () => {
  const { state, client } = fixture();
  await state.create('/A'); await state.create('/B');
  let a = 0, b = 0;
  const stop = state.subscribe('/A', () => a++);
  state.subscribe('/B', () => b++);
  await state.send('/A', [{ type: 'text', text: 'A' }], '', 'request-A');
  const before = a; stop();
  client.emit('notification', { method: 'item/started', params: { threadId: '/A', turnId: 'turn', item: { id: 'reply', type: 'agentMessage', text: '' } } });
  client.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: '/A', turnId: 'turn', itemId: 'reply', delta: 'continued' } });
  assert.equal(a, before); assert.equal(b, 0);
  assert.equal(state.chat('/A').items[0].t, 'continued');
  assert.equal(state.chat('/B').items.length, 0);
  assert.equal(client.sent.some(row => row.method === 'turn/interrupt'), false);
});

test('queue, steer and start go to one native thread with their original request identities', async () => {
  const { state, client } = fixture();
  await state.create('/A');
  await state.send('/A', [{ type: 'text', text: 'first' }], '', 'first');
  const queued = await state.send('/A', [{ type: 'text', text: 'queued' }], 'queue', 'queued');
  const steered = await state.send('/A', [{ type: 'text', text: 'now' }], 'now', 'now');
  assert.equal(queued.queued, true); assert.equal(steered.queued, false);
  assert.deepEqual(client.sent.filter(row => row.method?.startsWith('turn/') || row.method === 'thread/queue/add')
    .map(row => [row.method, row.params.threadId, row.params.clientUserMessageId]),
  [['turn/start', '/A', 'first'], ['thread/queue/add', '/A', 'queued'], ['turn/steer', '/A', 'now']]);
  assert.equal(client.sent.find(row => row.method === 'turn/steer').params.expectedTurnId, 'turn');
});

test('approval replies are tied to the originating thread and keep native choices', async () => {
  const { state, client } = fixture();
  await state.create('/A'); await state.create('/B');
  client.emit('request', { id: 7, method: 'item/commandExecution/requestApproval', params: {
    threadId: '/A', turnId: 'turn', itemId: 'command', command: 'echo test', availableDecisions: ['accept', 'decline'] } });
  assert.equal(state.chat('/A').questions.requests.length, 1);
  assert.equal(state.chat('/B').questions.requests.length, 0);
  const request = state.chat('/A').questions.requests[0].id;
  assert.throws(() => state.answer('/B', request, 0), /不属于/);
  state.answer('/A', request, 1);
  assert.deepEqual(client.sent.at(-1), { id: 7, result: { decision: 'decline' } });
  assert.equal(state.requests.size, 0);
});

test('disconnect invalidates loaded runtime state; resuming restores each native thread once', async () => {
  const { state, client } = fixture();
  await state.create('/A');
  client.emit('disconnected', new Error('closed'));
  assert.equal(state.threads.get('/A').disconnected, 'closed'); assert.equal(state.owns('/A'), true);
  assert.equal(state.chat('/A').busy, false);
  assert.match(state.chat('/A').items.at(-1).t, /后台中断.*结果待核对/);
  await Promise.all([state.load('/A'), state.load('/A')]);
  assert.equal(client.sent.filter(row => row.method === 'thread/resume').length, 1);
  assert.equal(state.threads.get('/A').cwd, '/A');
});

test('completion retains streamed items when the native turn summary has an empty item list', async () => {
  const { state, client } = fixture();
  await state.create('/A'); await state.send('/A', [{ type: 'text', text: 'run' }], '', 'request');
  client.emit('notification', { method: 'item/completed', params: { threadId: '/A', turnId: 'turn', item: { id: 'reply', type: 'agentMessage', text: 'done' } } });
  client.emit('notification', { method: 'turn/completed', params: { threadId: '/A', turn: { id: 'turn', status: 'completed', completedAt: 4, items: [] } } });
  const chat = state.chat('/A');
  assert.equal(chat.busy, false); assert.equal(chat.items[0].t, 'done');
  assert.equal(state.states()[0].run.status, 'completed');
  await tick();
});

test('a completed summary contains only the final reply and must retain streamed human messages and images', async () => {
  const { state, client } = fixture();
  await state.create('/A'); await state.send('/A', [{ type: 'text', text: 'run' }], '', 'request');
  client.emit('notification', { method: 'item/completed', params: { threadId: '/A', turnId: 'turn', item: {
    id: 'human', type: 'userMessage', content: [{ type: 'text', text: 'run' }, { type: 'image', url: 'data:image/png;base64,YQ==' }] } } });
  client.emit('notification', { method: 'turn/completed', params: { threadId: '/A', turn: { id: 'turn', itemsView: 'summary', status: 'completed',
    items: [{ id: 'reply', type: 'agentMessage', text: 'done' }] } } });
  const chat = state.chat('/A');
  assert.deepEqual(chat.items.map(item => item.k), ['human', 'assistant']);
  assert.equal(chat.items[0].images[0], 'data:image/png;base64,YQ==');
});

test('shared backend events outlive the cancelled navigation and carry no originating send operation', () => {
  const { state } = fixture(), controller = new AbortController();
  const contexts = [];
  state.subscribe('/A', () => contexts.push([cdpRead.getStore(), currentOperation()]));
  controller.abort(new Error('navigation finished'));
  cdpRead.run(controller.signal, () => withOperation({ id: 'previous-send' }, () => state.changed('/A')));
  assert.deepEqual(contexts, [[null, null]]);
});

test('shared update scheduling waits for receipt and then sends only the latest state', async () => {
  const client = new EventEmitter(), frames = [], receipts = [];
  client.ping = receipt => receipts.push(receipt);
  const session = { app: 'codex', client, selectionKey: () => 'codex|backend|A', visible: true, mode: 'chat' };
  let refresh, value = 0, unsubscribed = false;
  const stop = watchChatUpdates(session, callback => { refresh = callback; return () => { unsubscribed = true; }; }, sent => { frames.push(value); sent(); });
  refresh(); await tick();
  value = 1; refresh(); value = 2; refresh(); await tick();
  assert.deepEqual(frames, [0]);
  client.emit('pong', receipts[0]); await tick();
  assert.deepEqual(frames, [0, 2]);
  value = 3; refresh(); stop(); client.emit('pong', receipts[1]); await tick();
  assert.deepEqual(frames, [0, 2]); assert.equal(unsubscribed, true); assert.equal(client.listenerCount('pong'), 0);
});

test('MCP elicitation preserves false, zero, numbers and enum types and rejects invalid values', async () => {
  const { state, client } = fixture(); await state.create('/A');
  const schema = { type: 'object', required: ['flag', 'count', 'rate', 'choice', 'text'], properties: {
    flag: { type: 'boolean' }, count: { type: 'integer' }, rate: { type: 'number' }, choice: { type: 'integer', enum: [0, 2] }, text: { type: 'string' }, optional: { type: 'string' },
  } };
  const ask = id => { state.request({ id, method: 'mcpServer/elicitation/request', params: { threadId: '/A', requestedSchema: schema } }); return state.requestRows('/A').at(-1).id; };
  const fields = ['false', '0', '1.5', '2', ''].map((value, n) => ({ n, value }));
  const id = ask('typed'); state.answer('/A', id, 0, fields);
  assert.deepEqual(client.sent.at(-1).result, { action: 'accept', content: { flag: false, count: 0, rate: 1.5, choice: 2, text: '' } });
  const invalid = ask('invalid');
  assert.throws(() => state.answer('/A', invalid, 0, fields.map(field => field.n === 1 ? { ...field, value: '1.1' } : field)), /数值格式/);
  assert(state.requests.has('invalid'));
  state.answer('/A', invalid, 2, []); assert.deepEqual(client.sent.at(-1).result, { action: 'cancel', content: null });
});

test('MCP native titled enums and multi-select schemas preserve labels, defaults and array answers', async () => {
  const { state, client } = fixture(); await state.create('/A');
  const schema = { type: 'object', required: ['plan', 'tools'], properties: {
    plan: { type: 'string', title: '方案', oneOf: [{ const: 'a', title: '方案甲' }, { const: 'b', title: '方案乙' }], default: 'b' },
    tools: { type: 'array', items: { type: 'string', enum: ['read', 'write'] }, default: ['read'], minItems: 1, maxItems: 2 },
    titled: { type: 'array', items: { anyOf: [{ const: 'one', title: '第一项' }, { const: 'two', title: '第二项' }] }, default: ['two'] },
    legacy: { type: 'string', enum: ['low', 'high'], enumNames: ['低', '高'] },
  } };
  state.request({ id: 'native-form', method: 'mcpServer/elicitation/request', params: {
    threadId: '/A', turnId: null, serverName: 'qa', mode: 'form', message: '原生表单', requestedSchema: schema,
  } });
  const row = state.requestRows('/A')[0];
  assert.equal(row.fields[0].label, '方案'); assert.equal(row.fields[0].value, 'b');
  assert.deepEqual(row.fields[0].options.slice(1), [{ value: 'a', label: '方案甲' }, { value: 'b', label: '方案乙' }]);
  assert.equal(row.fields[1].multiple, true); assert.deepEqual(row.fields[1].value, ['read']);
  assert.deepEqual(row.fields[2].options, [{ value: 'one', label: '第一项' }, { value: 'two', label: '第二项' }]);
  assert.equal(row.fields[3].options[2].label, '高');
  state.answer('/A', row.id, 0, [{ n: 0, value: 'a' }, { n: 1, value: ['read', 'write'] }, { n: 2, value: ['two'] }, { n: 3, value: 'high' }]);
  assert.deepEqual(client.sent.at(-1).result, { action: 'accept', content: { plan: 'a', tools: ['read', 'write'], titled: ['two'], legacy: 'high' } });
});

test('MCP multi-select validates native options and counts while retaining failed answers and cancel semantics', async () => {
  const { state, client } = fixture(); await state.create('/A');
  const schema = { type: 'object', required: ['picks'], properties: {
    picks: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, minItems: 1, maxItems: 1 },
    optional: { type: 'array', items: { type: 'string', enum: ['x'] } },
  } };
  const ask = id => { state.request({ id, method: 'mcpServer/elicitation/request', params: { threadId: '/A', mode: 'form', requestedSchema: schema } }); return state.requestRows('/A').at(-1).id; };
  const id = ask('invalid-multi');
  for (const [value, error] of [[[], /选项数量/], [['a', 'b'], /选项数量/], [['unknown'], /请选择有效/]]) {
    assert.throws(() => state.answer('/A', id, 0, [{ n: 0, value }]), error);
    assert(state.requests.has('invalid-multi'));
  }
  state.answer('/A', id, 0, [{ n: 0, value: ['b'] }, { n: 1, value: [] }]);
  assert.deepEqual(client.sent.at(-1).result.content, { picks: ['b'] });
  for (const [button, action] of [[1, 'decline'], [2, 'cancel']]) {
    state.answer('/A', ask(action), button, []);
    assert.deepEqual(client.sent.at(-1).result, { action, content: null });
  }
});

test('disconnect retains transcript while removing active execution and stop resumes the native thread', async () => {
  const { state, client } = fixture(), thread = await state.create('/A');
  thread.turns.push({ id: 'running', status: 'inProgress', items: [{ id: 'body', type: 'agentMessage', text: 'last known answer' }] });
  client.emit('disconnected', new Error('native exit'));
  const chat = state.chat('/A'); assert.equal(chat.busy, false); assert.equal(chat.items[0].t, 'last known answer');
  assert(chat.items.some(item => /结果待核对/.test(item.t)));
  const routes = backendRoutesFor({ codexBackend: state }); await routes.stop.call({ threadId: '/A' });
  assert.equal(client.sent.filter(row => row.method === 'thread/resume').length, 1);
  assert.equal(state.chat('/A').items.some(item => /后台中断/.test(item.t)), false);
});

for (const mode of ['idle', 'active', 'already-started', 'disconnect']) test(`queued send-now follows authoritative native turn completion: ${mode}`, async () => {
  const { state, client } = fixture(), thread = await state.create('/A');
  const queued = { id: 'queue-one', clientUserMessageId: 'user-one', input: [{ type: 'text', text: 'queued text' }] };
  state.queues.set('/A', [queued]);
  if (mode !== 'idle') thread.turns.push({ id: 'running', status: 'inProgress', items: [] });
  const original = client.request;
  client.request = async (method, params) => {
    if (method === 'turn/interrupt') { client.sent.push({ method, params }); return {}; }
    if (method === 'thread/queue/list') return { data: mode === 'already-started' ? [] : [queued] };
    return original(method, params);
  };
  const pending = state.startQueued('/A', queued.id); await tick();
  assert.equal(client.sent.filter(row => row.method === 'thread/queue/start').length, mode === 'idle' ? 1 : 0);
  if (mode === 'disconnect') {
    client.emit('disconnected', new Error('closed before turn ended'));
    await assert.rejects(pending, /closed before/);
    assert.equal(client.sent.filter(row => row.method === 'thread/queue/start').length, 0);
  } else {
    if (mode !== 'idle') {
      if (mode === 'already-started') thread.turns.push({ id: 'next', status: 'inProgress', items: [{ id: 'accepted', type: 'userMessage', clientId: 'user-one' }] });
      client.emit('notification', { method: 'turn/completed', params: { threadId: '/A', turn: { id: 'running', status: 'interrupted', items: [] } } });
    }
    await pending;
    assert.equal(client.sent.filter(row => row.method === 'thread/queue/start').length, mode === 'already-started' ? 0 : 1);
  }
  assert.equal(state.listenerCount('changed'), 0);
});
