import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { beginOperation, captureOperation, withOperation, subscribeOperations, currentOperation } from '../server/operations.mjs';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const part = (source, start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, start);
  return source.slice(a, b);
};

function confirmation() {
  const nodes = Object.fromEntries(['send', 'sendNow', 'stop', 'queueBar', 'attachments', 'askOk', 'askNo'].map(id => [id, {}]));
  nodes.attachments.children = [];
  const packets = [], calls = [], computer = { id: 'computer-A' }, listeners = new Set();
  const document = new EventTarget();
  const add = document.addEventListener.bind(document), remove = document.removeEventListener.bind(document);
  document.addEventListener = (type, fn) => { listeners.add(fn); add(type, fn); };
  document.removeEventListener = (type, fn) => { listeners.delete(fn); remove(type, fn); };
  const context = vm.createContext({
    document, $: id => nodes[id], currentComputer: () => computer,
    mode: 'chat', currentApp: 'codex', viewSel: 'codex|window|A', sheetKind: null,
    text: { value: 'draft from A' }, pendingImageUploads: () => false,
    questionCompose: null, chatBusy: true, devinBusySplit: () => false, cursorBusyQueue: () => false,
    cancelVoice: () => calls.push('cancelVoice'),
    status() {}, saveDraft() {}, codexFollow: () => 'queue', pushEcho() {},
    mentionsFor: () => ({}), jumpToLatest() {}, failPendingSend() {}, esc: value => value,
    authed: true, ws: { readyState: 1, send: raw => packets.push(JSON.parse(raw)) },
    crypto: crypto.webcrypto, clearTimeout() {}, draftPushTimer: 0, draftEpoch: '',
    queuedChat: null, lastChat: { thread: 'A', items: [], queued: [] },
    activeDraft: 'computer-A|codex|window|A|chat', draftVersions: new Map(),
    inputRevision: 0, pendingSends: new Map(), pendingEchoes: [], messageScope: () => 'fixture',
    openSheet(kind) { context.sheetKind = kind; },
    closeSheet() { vm.runInContext('askDone?.(false); sheetKind = null;', context); },
  });
  const composer = read('app/js/composer.js'), history = read('app/js/history.js');
  vm.runInContext(
    part(read('app/js/sheets.js'), 'let askDone = null;', '// Buttons on Cursor')
      + part(read('app/js/core.js'), 'const desktopRequests = new Map();', 'function setWindowReady(')
      + part(composer, 'function sendReceipt(', 'function confirmSent(')
      + part(composer, "$('stop').onclick =", 'function updateSendMode(')
      + part(composer, 'function sendComposer(', "$('insertNewline').addEventListener")
      + part(history, 'function sendQueueAction(', 'function editQueued(')
      + part(history, "$('queueBar').onclick =", 'function updateToBottom('), context);
  return {
    context, nodes, packets, listeners, calls,
    change(kind) {
      if (kind === 'computer') computer.id = 'computer-B';
      else if (kind === 'mode') context.mode = 'terminal';
      else { context.viewSel = 'codex|window|B'; context.lastChat = { thread: 'B', items: [], queued: [] }; }
      document.dispatchEvent(new Event('composer-state'));
    },
    accept() { nodes.askOk.onclick(); },
  };
}

for (const kind of ['thread', 'computer', 'mode']) {
  test(`append confirmation is cancelled when its ${kind} changes`, async () => {
    const h = confirmation(), work = h.nodes.sendNow.onclick();
    assert.equal(h.context.sheetKind, 'ask');
    h.change(kind);
    assert.equal(h.context.sheetKind, null);
    h.accept(); await work;
    assert.equal(h.packets.length, 0);
    assert.equal(h.listeners.size, 0);
  });
}

test('an unchanged append target keeps the original text and native send action', async () => {
  const h = confirmation(), work = h.nodes.sendNow.onclick();
  h.accept(); await work;
  assert.equal(h.packets.length, 1);
  assert.equal(h.packets[0].text, 'draft from A');
  assert.equal(h.packets[0].sel, 'codex|window|A');
  assert.equal(h.packets[0].when, 'now');
  assert.equal(h.listeners.size, 0);
});

for (const action of ['remove', 'send', 'clear']) {
  test(`queue ${action} confirmation never targets a newly selected conversation`, async () => {
    const h = confirmation(), button = { dataset: { q: 'queue-A', a: action } };
    const work = h.nodes.queueBar.onclick({ target: { closest: () => button } });
    h.change('thread'); h.accept(); await work;
    assert.equal(h.packets.length, 0);
    assert.equal(h.listeners.size, 0);
  });
}

test('a queue action on the same target keeps its queue identifier', async () => {
  const h = confirmation(), button = { dataset: { q: 'queue-A', a: 'remove' } };
  const work = h.nodes.queueBar.onclick({ target: { closest: () => button } });
  h.accept(); await work;
  assert.equal(h.packets[0].id, 'queue-A');
  assert.equal(h.packets[0].action, 'remove');
  assert.equal(h.packets[0].sel, 'codex|window|A');
});

test('stop shares scoped confirmation and leaves no selection listener', async () => {
  const h = confirmation(), work = h.nodes.stop.onclick();
  h.change('computer'); h.accept(); await work;
  assert.equal(h.packets.length, 0);
  assert.equal(h.listeners.size, 0);
});

test('confirmations unrelated to a conversation retain their existing behavior', async () => {
  const h = confirmation(), work = h.context.ask('device action');
  h.change('thread');
  assert.equal(h.context.sheetKind, 'ask');
  h.accept(); assert.equal(await work, true);
  assert.equal(h.listeners.size, 0);
});

function rename({ fail = false, restore = true, own = true, abort = false } = {}) {
  const readScope = new AsyncLocalStorage(), controller = new AbortController();
  let selected = 'A', closed = 0;
  const selections = [], refreshed = [], events = [];
  const cdp = {
    async connect() {}, close() { closed++; },
    async evaluate(source) {
      readScope.getStore()?.throwIfAborted();
      if (source === 'codexThread()') return selected;
      if (source.includes("codexButtonPoint('actions')")) return fail ? null : { x: 1, y: 1 };
      if (source === 'codexRunItems()') return [{ label: 'Rename', x: 1, y: 1 }];
      return true;
    },
  };
  const context = vm.createContext({
    CODEX_CDP_URL: 'fixture', codexWindows: async () => [{ pageId: 'window', chatWs: 'ws://fixture.invalid' }],
    helpersCall: value => value, Cdp: class { constructor() { return cdp; } },
    setTimeout: fn => { fn(); return 1; }, cdpRead: readScope, publishSessionChange() {},
  });
  const method = part(read('server/apps/codex.mjs'), 'async codexRenameThread(', '\nnoteFusionRemoved(').replace(/,\s*$/, '');
  const execute = vm.runInContext('({' + method + '}).codexRenameThread', context);
  const target = {
    app: 'codex', codexPageId: own ? 'window' : 'other-window', cdp,
    async selectCodexThread(thread) {
      selections.push(thread);
      if (thread === 'A' && !restore) return false;
      selected = thread;
      if (thread === 'B' && abort) controller.abort(new Error('rename cancelled'));
      return true;
    },
    async tapCss() {}, async typeText() {}, async key() {},
    async codexThreadRows() { return [{ id: 'B', title: 'new name' }]; },
    async pollChat() { refreshed.push(selected); }, async listAgents() {},
    emit(message) { events.push(message); },
  };
  return {
    run: () => readScope.run(controller.signal, () => execute.call(target, 'thread:window:B', 'new name')),
    selections, refreshed, events, selected: () => selected, closed: () => closed,
  };
}

test('Codex rename restores the original conversation before reporting success', async () => {
  const h = rename(); await h.run();
  assert.deepEqual(h.selections, ['B', 'A']);
  assert.deepEqual(h.refreshed, ['A']);
  assert.equal(h.events.at(-1).ok, true);
});

test('a failed Codex rename restores the original conversation without reporting success', async () => {
  const h = rename({ fail: true });
  await assert.rejects(h.run(), { message: '当前会话没有操作菜单' });
  assert.equal(h.selected(), 'A');
  assert.deepEqual(h.refreshed, ['A']);
  assert.equal(h.events.length, 0);
});

test('Codex rename cleanup is not cancelled by the interrupted read scope', async () => {
  const h = rename({ abort: true });
  await assert.rejects(h.run(), { message: 'rename cancelled' });
  assert.equal(h.selected(), 'A');
  assert.deepEqual(h.refreshed, ['A']);
});

test('Codex rename retains its original error when restoring also fails', async () => {
  const h = rename({ fail: true, restore: false });
  await assert.rejects(h.run(), error => {
    assert.equal(error.message, '当前会话没有操作菜单');
    assert.deepEqual(Array.from(error.errors, e => e.message), ['当前会话没有操作菜单', '未能恢复原会话']);
    return true;
  });
  assert.equal(h.events.length, 0);
});

test('Codex rename reports restoration failure after a successful native rename', async () => {
  const h = rename({ restore: false });
  await assert.rejects(h.run(), { message: '未能恢复原会话' });
  assert.equal(h.events.length, 0);
});

test('Codex rename closes a temporary connection after an error', async () => {
  const h = rename({ fail: true, own: false });
  await assert.rejects(h.run(), { message: '当前会话没有操作菜单' });
  assert.equal(h.selected(), 'A');
  assert.equal(h.closed(), 1);
});

function previews({ saved, now = 1000 } = {}) {
  const computers = ['A', 'B', 'C'].map(id => ({ id, key: 'key-' + id }));
  const links = computers.map((computer, i) => ({
    computer, expectedId: computer.id, auth: { resumeId: 'resume-' + computer.id },
    socket: { id: i }, receive: i === 0 ? () => {} : null,
    binding: { sel: 'codex|window|' + computer.id, chat: { thread: computer.id, items: [] } },
  }));
  let clock = now, serial = 0, restored = 0;
  const timers = new Map(), writes = [], document = new EventTarget(), window = new EventTarget();
  const context = vm.createContext({
    document, addEventListener: window.addEventListener.bind(window),
    computerSockets: new Map(links.map(link => [link.computer.key, link])), ws: links[0].socket,
    computerBindingReady: () => true, loadComputers: () => computers, currentComputer: () => computers[0],
    ovSt: new Map(computers.map(c => [c.id, { data: { sessions: [] }, offset: 0 }])), ovCollapsed: new Set(),
    ovHistory: () => ({ ov: { level: 'sessions' } }), ovRestoreComputers() { restored++; },
    idbGet: async key => key === 'computer-resumes' ? saved : null,
    idbPut(key, value) { writes.push({ key, value: structuredClone(value) }); return Promise.resolve(); },
    Date: class extends Date { static now() { return clock; } },
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimeout: id => timers.delete(id),
    chatBySel: new Map(), SC: { key: null, dirty: false }, scGeneration: 0, scVersions: new Map(),
    scClears: new Set(), scPending: new Map(), scWriting: new Set(), scTitles: {},
    scDrainTimer: 0, scSaveFrame: 0, cancelAnimationFrame() {},
    chatScrolling: false, chatTouching: false, store: { set() {} },
    scKeys: async () => [], idbKeys: async () => [], scDel: async () => {}, idbDel: async () => {},
    nativeHist: () => null, scFlush() {}, scDrain: async () => {},
    lruPut(map, key, value, max) { map.delete(key); map.set(key, value); while (map.size > max) map.delete(map.keys().next().value); },
  });
  const history = read('app/js/history.js');
  vm.runInContext(part(history, 'let chatPreviewTimer =', 'let chatFrame =')
    + part(history, "document.addEventListener('visibilitychange',", 'function scSwitch(')
    + part(history, 'async function scClear(', 'function showBgSheet('), context);
  return {
    context, links, computers, writes, document, window, timers,
    ready: () => vm.runInContext('computerResumeReady', context),
    restored: () => restored,
    advance(ms) {
      clock += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.fn(); }
    },
  };
}

test('three computers share one restore write per round and unchanged chats are not saved again', async () => {
  const h = previews(); await h.ready();
  for (let round = 0; round < 2; round++) {
    for (const link of h.links) h.context.saveComputerResume(link);
    h.advance(1000);
  }
  const resumes = h.writes.filter(w => w.key === 'computer-resumes');
  assert.equal(resumes.length, 2);
  assert.equal(resumes.reduce((n, w) => n + w.value.entries.length, 0), 6);
  assert.equal(h.writes.filter(w => w.key === 'chat-previews').length, 1);
  h.links[1].binding.chat = { thread: 'B', items: [{ i: 'new-message', t: 'new content' }] };
  h.context.saveComputerResume(h.links[1]); h.advance(1000);
  const chats = h.writes.filter(w => w.key === 'chat-previews');
  assert.equal(chats.length, 2);
  assert.equal(chats.at(-1).value.find(([key]) => key.endsWith('|B'))[1].items[0].t, 'new content');
});

test('coalescing retains the latest observed restore time rather than the delayed flush time', async () => {
  const h = previews(); await h.ready();
  h.context.saveComputerResume(h.links[0]); h.advance(200);
  h.context.saveComputerResume(h.links[1]); h.advance(800);
  assert.equal(h.writes.find(w => w.key === 'computer-resumes').value.at, 1200);
});

for (const age of [299999, 300000]) {
  test(`restore preview freshness retains its five-minute boundary at ${age} ms`, async () => {
    const h = previews({ now: 400000, saved: { at: 400000 - age, entries: [] } });
    await h.ready();
    assert.equal(h.restored(), age < 300000 ? 1 : 0);
  });
}

for (const event of ['visibilitychange', 'pagehide']) {
  test(`${event} flushes pending restore state before timers can be suspended`, async () => {
    const h = previews(); await h.ready();
    for (const link of h.links) h.context.saveComputerResume(link);
    assert.equal(h.writes.length, 0);
    if (event === 'visibilitychange') { h.document.hidden = true; h.document.dispatchEvent(new Event(event)); }
    else h.window.dispatchEvent(new Event(event));
    assert.equal(h.writes.filter(w => w.key === 'computer-resumes').length, 1);
    assert.equal(h.writes.filter(w => w.key === 'chat-previews').length, 1);
    h.advance(1000);
    assert.equal(h.writes.length, 2);
  });
}

test('clearing chat history keeps a pending restore save without recreating cleared previews', async () => {
  const h = previews(); await h.ready();
  h.context.saveComputerResume(h.links[1]);
  await h.context.scClear(null); h.advance(1000);
  assert.equal(h.writes.filter(w => w.key === 'computer-resumes').length, 1);
  assert.equal(h.writes.filter(w => w.key === 'chat-previews').length, 0);
  assert.equal(h.context.chatBySel.size, 0);
});

test('a computer removed before the flush is absent from the saved restore map', async () => {
  const h = previews(); await h.ready();
  for (const link of h.links) h.context.saveComputerResume(link);
  h.computers.pop(); h.advance(1000);
  assert.equal(h.writes.find(w => w.key === 'computer-resumes').value.entries.length, 2);
});

for (const mode of ['native', 'position', 'absent', 'error']) {
  test(`the shared model opener retains the ${mode} outcome`, async () => {
    const calls = [];
    const context = vm.createContext({ helpersCall: value => value });
    const method = part(read('server/agent/menus.mjs'), '  async openModelList()', '  async ensureSettings(').replace(/,\s*$/, '');
    const open = vm.runInContext('({' + method + '}).openModelList', context);
    const target = {
      cdp: { async evaluate(source) {
        calls.push(source);
        if (mode === 'error') throw new Error('native model read failed');
        if (source === 'clickModelListTrigger()') return mode === 'native';
        return mode === 'position' ? { x: 10, y: 20 } : null;
      } },
      async tapCss(x, y) { calls.push([x, y]); },
    };
    if (mode === 'error') {
      await assert.rejects(open.call(target), { message: 'native model read failed' });
      assert.equal(calls.length, 1);
    } else {
      assert.equal(await open.call(target), mode !== 'absent');
      assert.deepEqual(calls, mode === 'native' ? ['clickModelListTrigger()'] : mode === 'position'
        ? ['clickModelListTrigger()', 'modelListTrigger()', [10, 20]] : ['clickModelListTrigger()', 'modelListTrigger()']);
    }
  });
}

test('reading queue counts does not build buttons for any Agent', () => {
  for (const app of ['cursor', 'devin', 'codex']) {
    let buttons = 0;
    const context = vm.createContext({
      chatStale: false, currentApp: app, viewSel: 'fixture', pendingEchoes: [],
      lastChat: { queued: [1, 2, 3].map(id => ({ id: String(id), t: 'fixture' })) },
      I18N: { tr: value => value }, esc: value => value, supportsCapability: () => true,
      ibtn() { buttons++; return '<button></button>'; },
    });
    vm.runInContext(part(read('app/js/history.js'), 'function queuedMessages(', 'function renderQueuedList('), context);
    assert.equal(vm.runInContext('queuedMessages().count', context), 3);
    assert.equal(buttons, 0);
    vm.runInContext('queuedMessagesHtml(queuedMessages())', context);
    assert.equal(buttons, 9);
  }
});

function overviewClient() {
  const computers = ['A', 'B'].map(id => ({ id, key: 'key-' + id, relay: 'https://fixture.invalid' }));
  const packets = [], requests = [];
  const links = computers.map(computer => ({ expectedId: computer.id, authed: true, auth: { device: 'device-' + computer.id }, operations: new Map(),
    socket: { readyState: 1, send: raw => packets.push({ computer: computer.id, message: JSON.parse(raw) }) } }));
  const context = vm.createContext({
    currentComputer: () => computers[0], currentApp: 'codex', mode: 'chat', viewSel: 'codex|window|A',
    ws: links[0].socket, crypto: crypto.webcrypto, authed: true,
    ovList: computers.map(c => ({ id: c.id, c })), computerSockets: new Map(links.map((l, i) => [computers[i].key, l])),
    ovTarget: r => ({ computer: r.comp, win: r.app, windowId: r.windowId, threadId: r.threadId }),
    ovT: value => value, I18N: { tr: value => value }, AbortSignal,
    entryHeaders: async () => ({ 'x-fixture': 'test' }),
    fetch: async (url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true }) }; },
    status() {},
  });
  vm.runInContext(part(read('app/js/core.js'), 'const desktopRequests = new Map();', 'function setWindowReady(')
    + part(read('app/js/overview.js'), 'async function ovSessionRequest(', 'async function ovManageSession(')
    + part(read('app/js/net.js'), 'function receiveDesktopOperation(', 'async function warmComputerSocket('), context);
  return { context, packets, requests, links,
    target: { comp: 'B', app: 'codex', windowId: 'window-B', threadId: 'thread-B' },
    finish(ok = true) {
      const message = packets.at(-1).message;
      context.receiveDesktopOperation(links[1], { id: message.operationId, kind: 'overviewManage', done: true,
        events: [{ revision: 1, message: { t: 'overviewManaged', ok, value: { ok: true }, error: 'native action failed' } }] });
    },
    pending: () => vm.runInContext('desktopRequests.size', context),
  };
}

test('overview mutation uses its computer socket and accepts the result without switching the current computer', async () => {
  const h = overviewClient(), work = h.context.ovSessionRequest(h.target, 'rename', { name: 'new name' });
  assert.equal(h.requests.length, 0);
  assert.equal(h.packets.length, 1);
  assert.equal(h.packets[0].computer, 'B');
  assert.equal(h.packets[0].message.sel, 'codex|window-B|thread-B');
  assert.equal(h.packets[0].message.name, 'new name');
  h.finish(); assert.equal((await work).ok, true);
  assert.equal(h.pending(), 0);
});

test('an overview mutation already waiting for its result shares one request identity', async () => {
  const h = overviewClient();
  const first = h.context.ovSessionRequest(h.target, 'remove');
  const second = h.context.ovSessionRequest(h.target, 'remove');
  assert.equal(h.packets.length, 1);
  h.finish();
  assert.equal((await first).ok, true); assert.equal((await second).ok, true);
  assert.equal(h.pending(), 0);
});

test('reconnected overview requests retain the operation ID and are replayed only to their computer', async () => {
  const h = overviewClient(), work = h.context.ovSessionRequest(h.target, 'archive');
  const original = h.packets[0].message;
  h.context.replayDesktopOperations(h.links[0]); assert.equal(h.packets.length, 1);
  h.context.replayDesktopOperations(h.links[1]); assert.equal(h.packets.length, 2);
  assert.deepEqual(h.packets[1].message, original);
  h.finish(); await work;
  h.context.replayDesktopOperations(h.links[1]); assert.equal(h.packets.length, 2);
});

test('a native overview failure rejects its waiting action and releases the request record', async () => {
  const h = overviewClient(), work = h.context.ovSessionRequest(h.target, 'remove');
  h.finish(false); await assert.rejects(work, { message: 'native action failed' });
  assert.equal(h.pending(), 0);
});

test('overview mutation is not submitted over an unauthenticated connection', async () => {
  const h = overviewClient(); h.links[1].authed = false;
  await assert.rejects(h.context.ovSessionRequest(h.target, 'remove'), { message: '电脑尚未连接，请先重新连接' });
  assert.equal(h.packets.length, 0); assert.equal(h.pending(), 0);
});

test('favorites and read-only overview actions retain their HTTP path', async () => {
  const h = overviewClient();
  for (const action of ['favorite', 'actions', 'copyLink']) await h.context.ovSessionRequest(h.target, action);
  assert.equal(h.requests.length, 3); assert.equal(h.packets.length, 0);
});

function operationFixture() {
  const deviceId = crypto.randomUUID();
  const session = { deviceId, app: 'fusion', selectionKey: () => 'unrelated current selection' };
  const message = { t: 'overviewManage', operationId: crypto.randomUUID(), win: 'codex', sel: 'codex|window|thread' };
  return { session, message };
}

test('overview result deduplication is independent of the current Agent and survives client replacement', () => {
  const h = operationFixture(), first = beginOperation(h.session, h.message);
  assert(first && !first.duplicate); assert.equal(first.operation.app, 'codex');
  withOperation(first.operation, () => assert.equal(captureOperation(h.session, { t: 'overviewManaged', ok: true, value: { ok: true } }), true));
  const replayed = [], unsubscribe = subscribeOperations(h.session.deviceId, { readyState: 1, send: raw => replayed.push(JSON.parse(raw)) });
  assert.equal(replayed.length, 1); assert.equal(replayed[0].done, true);
  assert.equal(replayed[0].events[0].message.ok, true);
  assert.equal(replayed[0].sel, 'codex|window|thread');
  assert.equal(beginOperation(h.session, h.message).duplicate, true);
  unsubscribe();
});

test('pending overview duplicates do not create another operation and errors are recoverable results', () => {
  const h = operationFixture(), first = beginOperation(h.session, h.message);
  const duplicate = beginOperation(h.session, h.message);
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.operation, first.operation);
  withOperation(first.operation, () => captureOperation(h.session, { t: 'overviewManaged', ok: false, error: 'native failure' }));
  assert.equal(first.operation.done, true);
  assert.equal(first.operation.events.get('overviewManaged').message.error, 'native failure');
});

test('operation identities and replayed overview results remain scoped to the paired device', () => {
  const h = operationFixture(), first = beginOperation(h.session, h.message);
  const other = { ...h.session, deviceId: crypto.randomUUID() };
  assert.equal(beginOperation(other, h.message).duplicate, false);
  withOperation(first.operation, () => captureOperation(h.session, { t: 'overviewManaged', ok: true }));
  const messages = [], stop = subscribeOperations(crypto.randomUUID(), { readyState: 1, send: raw => messages.push(raw) });
  assert.equal(messages.length, 0); stop();
});

test('the overview route collects internal native messages separately from its terminal operation result', async () => {
  const h = operationFixture(), first = beginOperation(h.session, h.message), calls = [];
  h.session.emit = message => captureOperation(h.session, message);
  const context = vm.createContext({ withOperation,
    manageOverviewSession: async (device, body) => {
      assert.equal(currentOperation(), null); calls.push([device, body.operationId]);
      assert.equal(captureOperation(h.session, { t: 'sessionBatchProgress' }), false);
      return { ok: true };
    },
  });
  const route = vm.runInContext('({' + part(read('server/routes.mjs'), '  overviewManage:', '  compatibility:') + '}).overviewManage', context);
  await withOperation(first.operation, () => route.fastRun(h.session, h.message));
  assert.equal(calls.length, 1);
  assert.equal(first.operation.events.size, 1);
  assert.equal(first.operation.events.get('overviewManaged').message.ok, true);
});

test('the HTTP overview endpoint retains favorites and queries and no longer executes mutations', async () => {
  let executions = 0;
  const context = vm.createContext({
    URL, clientIp: () => 'fixture', originAllowed: () => true,
    authenticateRequest: () => ({ id: 'fixture-device' }), needsTotp: () => false,
    readJson: async request => request.body, json: (request, response, status, body) => ({ status, body }),
    manageOverviewSession: async () => { executions++; return { ok: true }; },
  });
  vm.runInContext(read('server/http/api.mjs').replace(/^import .*;\n/gm, '').replace(/\bexport /g, ''), context);
  for (const action of ['rename', 'delete', 'archive', 'remove']) {
    const result = await context.handleApi({ method: 'POST', headers: {}, body: { action } }, {}, '/api/overview/session');
    assert.equal(result.status, 400);
  }
  assert.equal(executions, 0);
  for (const action of ['favorite', 'actions', 'copyLink']) {
    const result = await context.handleApi({ method: 'POST', headers: {}, body: { action } }, {}, '/api/overview/session');
    assert.equal(result.status, 200);
  }
  assert.equal(executions, 3);
});

test('overview requests are not replayed or completed under a different paired identity', async () => {
  const h = overviewClient(), work = h.context.ovSessionRequest(h.target, 'remove');
  h.links[1].auth.device = 'replacement-device';
  h.context.replayDesktopOperations(h.links[1]); assert.equal(h.packets.length, 1);
  h.finish(); assert.equal(h.pending(), 1);
  h.links[1].auth.device = 'device-B'; h.finish();
  assert.equal((await work).ok, true); assert.equal(h.pending(), 0);
});

function cardSubscription() {
  const packets = [], classes = new Set();
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { classList: { toggle() {} }, querySelectorAll: () => [], querySelector: () => null });
    return nodes.get(id);
  };
  const context = vm.createContext({
    document: { visibilityState: 'visible', body: { classList: { contains: value => classes.has(value) } } },
    authed: true, mode: 'chat', viewSel: 'codex|window|thread', targetReady: true,
    ovS: { open: 'card' }, ovToolState: { key: 'card', phase: 'ready', sel: 'codex|window|thread', target: {} },
    winTargetReady: () => context.targetReady, send: message => packets.push(message),
    $: node, ovRender() {}, ovToolInput: () => null, ovPatch() {},
    ovPrepareVisibleComposer() {}, ovMountComposerControls() {}, ovCrumbsPaint: '',
    ovUpdateUsage() {},
    ovReleaseComposer: () => { context.ovToolState = null; },
  });
  const overview = read('app/js/overview.js');
  vm.runInContext(part(overview, 'function ovComposerReady(', 'function ovToolInput(')
    + part(overview, 'function conversationVisible(', 'function ovShowConversation(')
    + part(read('app/js/net.js'), 'function ovVisible(', 'function startComputerUpdates(')
    + part(overview, 'function ovReflectComposer(', "document.addEventListener('composer-state'")
    + part(overview, 'function ovCommit(', 'function ovRender('), context);
  return { context, packets, classes, update: () => context.ovReflectComposer(),
    close() {
      context.ovS.open = null;
      context.ovCommit({ paint: '', crumbs: '', levels: '', summary: '', lane: '', board: '', batch: '' });
    },
  };
}

test('an expanded bound card subscribes to chat updates while keeping overview notification presence', () => {
  const h = cardSubscription(); h.update();
  assert.deepEqual(JSON.parse(JSON.stringify(h.packets)), [{ t: 'visible', v: true, watching: false, background: false }]);
});

test('binding and a changed native target do not subscribe an unrelated card', () => {
  const h = cardSubscription(); h.context.ovToolState.phase = 'binding'; h.update();
  assert.equal(h.packets.at(-1).v, false);
  h.context.ovToolState.phase = 'ready'; h.update(); assert.equal(h.packets.at(-1).v, true);
  h.context.targetReady = false; h.update(); assert.equal(h.packets.at(-1).v, false);
});

test('ordinary card composer updates do not repeatedly send the same subscription state', () => {
  const h = cardSubscription(); h.update(); h.update(); h.update();
  assert.equal(h.packets.length, 1);
});

test('a full conversation retains both live reads and its original notification watching state', () => {
  const h = cardSubscription(); h.classes.add('conv'); h.context.ovToolState = null;
  h.context.ovVisible();
  assert.equal(h.packets.at(-1).v, true); assert.equal(h.packets.at(-1).watching, true);
});

test('backgrounding and returning restore only the active card subscription', () => {
  const h = cardSubscription(); h.update();
  h.context.document.visibilityState = 'hidden'; h.context.ovVisible();
  assert.equal(h.packets.at(-1).v, false); assert.equal(h.packets.at(-1).watching, false);
  h.context.document.visibilityState = 'visible'; h.context.ovVisible();
  assert.equal(h.packets.at(-1).v, true); assert.equal(h.packets.at(-1).watching, false);
});

test('closing a card releases its subscription before a different card can bind', () => {
  const h = cardSubscription(); h.update(); h.close();
  assert.equal(h.packets.at(-1).v, false);
  h.context.ovS.open = 'other';
  h.context.ovToolState = { key: 'other', phase: 'binding', target: {}, sel: h.context.viewSel };
  h.update(); assert.equal(h.packets.at(-1).v, false);
  h.context.ovToolState.phase = 'ready'; h.update(); assert.equal(h.packets.at(-1).v, true);
});

for (const app of ['cursor', 'devin', 'codex']) {
  test(`${app}: the existing visible route and chat watcher update and clear a card queue`, async () => {
    const listeners = new Set(), snapshots = [];
    let queued = [], subscriptions = 0;
    const source = { subscribe(listener) { subscriptions++; listeners.add(listener); return () => listeners.delete(listener); } };
    const context = vm.createContext({
      AgentContext: class {}, FUSION_OWNER: {}, cdpRead: new AsyncLocalStorage(),
      nativeWindow: () => source, subscribeCatalog: () => () => {}, clearInterval() {},
    });
    vm.runInContext(read('server/session.mjs').replace(/^import .*;\n/gm, '').replace(/\bexport /g, '') + '\nthis.Session=Session;', context);
    const route = vm.runInContext('({' + part(read('server/routes.mjs'), '  visible:', '  lang:') + '}).visible', context);
    const cdp = {}, session = Object.assign(Object.create(context.Session.prototype), {
      app, cdp, editorCdp: cdp, mode: 'chat', visible: false,
      pollChat: async () => { snapshots.push(queued.slice()); },
    });
    await route.pre(session, { v: true, watching: false });
    assert.equal(session.notifyVisible, false); assert.equal(listeners.size, 1);
    queued = ['first']; for (const listener of listeners) listener();
    assert.deepEqual(snapshots.at(-1), ['first']);
    queued = []; for (const listener of listeners) listener();
    assert.deepEqual(snapshots.at(-1), []);
    await route.pre(session, { v: true, watching: true });
    assert.equal(session.notifyVisible, true); assert.equal(subscriptions, 1);
    await route.pre(session, { v: false, watching: false });
    assert.equal(listeners.size, 0); assert.equal(session.notifyVisible, false);
  });
}

function shellWorker() {
  const handlers = new Map(), cached = new Map(), requests = [], writes = [];
  const scope = 'https://fixture.invalid/remote-agent/';
  const context = vm.createContext({
    URL, Request, Response, Promise,
    self: { registration: { scope }, addEventListener: (type, handler) => handlers.set(type, handler) },
    location: { origin: new URL(scope).origin },
    caches: { open: async () => ({
      match: async request => cached.get(request.url)?.clone(),
      put: async (request, response) => { writes.push(request.url); cached.set(request.url, response); },
    }) },
    fetch: async (request, options) => { requests.push({ url: request.url, options }); return context.network(request); },
    network: async () => new Response('network-source'),
  });
  vm.runInContext(read('app/sw.js'), context);
  return { context, cached, requests, writes, scope,
    core: vm.runInContext('SHELL.find(path => path.startsWith("js/core.js?"))', context),
    resource(prefix) { return vm.runInContext(`SHELL.find(path => path.startsWith(${JSON.stringify(prefix)}))`, context); },
    fetch(path, options = {}) {
      const request = { url: new URL(path, scope).href, method: 'GET', mode: 'cors', ...options };
      let response; handlers.get('fetch')({ request, respondWith: value => { response = value; } }); return response;
    },
    cache(path, value = 'cached-source') { cached.set(new URL(path, scope).href, new Response(value)); },
  };
}

test('a cached current shell script returns immediately without waiting for the network', async () => {
  const h = shellWorker(); h.cache(h.core); h.context.network = () => new Promise(() => {});
  assert.equal(await (await h.fetch(h.core)).text(), 'cached-source');
  assert.equal(h.requests.length, 0);
});

test('CSS, Markdown and voice worklet assets share the exact current shell cache path', async () => {
  const h = shellWorker();
  for (const prefix of ['app.css?', 'markdown-it/', 'js/voice-worklet.js?']) {
    const asset = h.resource(prefix); h.cache(asset, prefix);
    assert.equal(await (await h.fetch(asset)).text(), prefix);
  }
  assert.equal(h.requests.length, 0);
});

test('a missing current shell asset downloads and fills its original cache entry', async () => {
  const h = shellWorker();
  assert.equal(await (await h.fetch(h.core)).text(), 'network-source');
  assert.equal(h.requests.length, 1); assert.equal(h.writes.length, 1);
  assert.equal(await (await h.fetch(h.core)).text(), 'network-source');
  assert.equal(h.requests.length, 1);
});

test('HTML and navigation retain network updates and the existing offline fallback', async () => {
  const h = shellWorker(); h.cache('index.html'); h.cache('./');
  assert.equal(await (await h.fetch('index.html')).text(), 'network-source');
  assert.equal(h.requests[0].options.cache, 'no-cache');
  assert.equal(await (await h.fetch('./', { mode: 'navigate' })).text(), 'network-source');
  h.context.network = async () => { throw Error('fixture offline'); };
  assert.equal(await (await h.fetch('index.html')).text(), 'network-source');
  assert.equal(h.requests.length, 3);
});

test('a different resource version never matches the current shell asset by pathname alone', async () => {
  const h = shellWorker(), old = h.core.replace(/\?v=.*/, '?v=old'); h.cache(old);
  assert.equal(await (await h.fetch(old)).text(), 'network-source');
  assert.equal(h.requests.length, 1);
});

test('published discovery, other origins and non-GET requests retain their original bypass', () => {
  const h = shellWorker();
  assert.equal(h.fetch('url.json?t=1'), undefined);
  assert.equal(h.fetch('https://relay.invalid/api/overview'), undefined);
  assert.equal(h.fetch('api/overview', { method: 'POST' }), undefined);
  assert.equal(h.requests.length, 0);
});

test('same-origin API data and resources outside the shell keep their original network-first path', async () => {
  const h = shellWorker();
  for (const path of ['api/overview', '../other-app/js/core.js?v=359']) {
    h.cache(path); assert.equal(await (await h.fetch(path)).text(), 'network-source');
  }
  assert.equal(h.requests.length, 2);
});

function preedit() {
  const timers = [], edits = [], selections = [];
  const input = { value: 'pinyin', dataset: { ovInput: 'card' }, selectionStart: 6, selectionEnd: 6,
    setSelectionRange: (...selection) => selections.push(selection) };
  const text = { value: 'old draft', selectionStart: 1, selectionEnd: 1, selectionDirection: 'none', setSelectionRange() {} };
  const context = vm.createContext({
    document: { activeElement: input }, input, text, composing: true,
    ovComposerReady: () => true, composerInput: () => context.owner, owner: input,
    setTimeout: callback => timers.push(callback), updateComposeCompact() {}, queueDraftSync() {},
    endInputRecall() {}, syncMentions() {}, mentionUpdate() {},
    recordDraftEdit: () => edits.push(text.value),
  });
  vm.runInContext(part(read('app/js/overview.js'), 'function ovPaintComposerInput(', 'function ovReflectComposer(')
    + part(read('app/js/composer.js'), 'function editComposerInput(', '// ---- "@" mentions')
    + part(read('app/js/composer.js'), 'const composerInputHandlers =', 'function composerInputEvent(')
    + '\nthis.finishComposition=()=>composerInputHandlers.compositionend({target:input});', context);
  return { context, input, text, selections, edits,
    paint: () => context.ovPaintComposerInput(input), flush: () => { for (const callback of timers.splice(0)) callback(); } };
}

test('a focused IME preedit owns its value and selection when the shared draft differs', () => {
  const h = preedit(); h.paint();
  assert.equal(h.input.value, 'pinyin'); assert.equal(h.text.value, 'old draft');
  assert.equal(h.selections.length, 0);
});

test('an ordinary card input still reflects the shared draft after composition', () => {
  const h = preedit(); h.context.composing = false; h.paint();
  assert.equal(h.input.value, 'old draft'); assert.deepEqual(h.selections, [[1, 1, 'none']]);
});

test('composition end commits the current editor final value through the original draft edit path', () => {
  const h = preedit(); h.input.value = '拼音'; h.context.finishComposition();
  assert.equal(h.text.value, 'old draft'); h.flush();
  assert.equal(h.context.composing, false); assert.equal(h.text.value, '拼音');
  assert.deepEqual(h.edits, ['拼音']);
});

test('composition end after switching editors does not copy old text into the new owner', () => {
  const h = preedit(); h.context.finishComposition(); h.context.owner = h.text; h.flush();
  assert.equal(h.context.composing, false); assert.equal(h.text.value, 'old draft'); assert.equal(h.edits.length, 0);
});

test('composition end does not duplicate a final input event already saved to the shared draft', () => {
  const h = preedit(); h.text.value = h.input.value; h.context.finishComposition(); h.flush();
  assert.equal(h.edits.length, 0);
});

test('cards put input history before text and expose newline without secondary send menus', () => {
  const button = (textContent = '') => ({ textContent, innerHTML: '<svg/>', title: '', ariaLabel: '', disabled: false });
  for (const row of [
    { app: 'codex', follow: 'queue', landscape: true, immediate: true },
    { app: 'codex', follow: 'steer', landscape: true, immediate: false },
    { app: 'devin', follow: '', landscape: true, immediate: true },
    { app: 'cursor', follow: '', landscape: true, immediate: false },
    { app: 'codex', follow: 'queue', landscape: false, immediate: true },
  ]) {
    const nodes = new Map([['send', button('排队')], ['sendNow', { ...button('立即追加'), hidden: row.app === 'cursor' }], ['msg', { className: 'quiet' }]]);
    const context = vm.createContext({
      $: id => nodes.get(id) || button(), esc: String, OV_ICON: { arrow: '<svg/>' }, OV_AGENT: { [row.app]: row.app },
      I18N: { tr: value => value }, ovT: value => value, ovBusy: new Set(), ovErr: new Map(),
      ovBadge: () => '运行中', ovTime: () => '1m', ovContext: () => 'project', ovComposerReady: () => true,
      ovRunHtml: () => '', ovPreviewHtml: () => '', ovChangesRow: () => '', ovOpenLink: () => '',
      queuedMessages: () => ({ count: 0 }), questionCompose: null, viewSel: 'selection',
      devinBusySplit: () => row.app === 'devin', cursorBusyQueue: () => row.app === 'cursor', codexFollow: () => row.follow,
      document: { body: { classList: { contains: () => row.landscape } } },
    });
    vm.runInContext(part(read('app/js/overview.js'), 'function ovCard(', 'function ovSessionGroup('), context);
    const html = context.ovCard({ key: 'card', state: 'run', app: row.app, actions: [] });
    assert.equal(html.includes('data-v="send"'), false);
    assert.equal(html.includes('data-v="sendNow"'), false);
    assert.equal(html.includes('data-ov="send"'), true);
    assert(html.indexOf('class="ov-input-history"') < html.indexOf('<textarea'));
    for (const id of ['inputPrev', 'inputNext']) assert(html.indexOf(`data-v="${id}"`) < html.indexOf('<textarea'));
    assert(html.indexOf('data-v="insertNewline"') > html.indexOf('class="ov-tools"'));
    assert.equal(html.includes('ov-compose-more'), false);
  }
});

test('the shared primary send keeps native queue policies and receipt ownership', () => {
  for (const row of [
    { app: 'codex', follow: 'queue', when: 'queue' },
    { app: 'codex', follow: 'steer', when: 'now' },
    { app: 'devin', follow: '', when: 'queue' },
    { app: 'cursor', follow: '', when: 'queue' },
  ]) {
    const h = confirmation();
    Object.assign(h.context, { currentApp: row.app, codexFollow: () => row.follow,
      devinBusySplit: () => row.app === 'devin', cursorBusyQueue: () => row.app === 'cursor' });
    assert.equal(h.nodes.send.onclick, h.context.sendComposer);
    h.context.sendComposer();
    assert.equal(h.packets.length, 1);
    assert.equal(h.packets[0].when, row.when);
    assert.equal(h.packets[0].sel, 'codex|window|A');
    assert.equal(h.context.pendingSends.get(h.packets[0].requestId).text, 'draft from A');
    assert.deepEqual(h.calls, ['cancelVoice']);
  }
});

test('the shared immediate action stops voice and keeps the original scoped confirmation', async () => {
  const h = confirmation();
  assert.equal(h.nodes.sendNow.onclick, h.context.sendComposerNow);
  const work = h.context.sendComposerNow();
  assert.deepEqual(h.calls, ['cancelVoice']);
  assert.equal(h.packets.length, 0); assert.equal(h.context.sheetKind, 'ask');
  h.accept(); await work;
  assert.equal(h.packets[0].when, 'now'); assert.equal(h.packets[0].text, 'draft from A');
});

test('direct send actions keep the existing disabled-button behavior', async () => {
  const h = confirmation(); h.nodes.send.disabled = h.nodes.sendNow.disabled = true;
  h.context.sendComposer(); await h.context.sendComposerNow();
  Object.assign(h.context, { composing: false, shiftEnter: false });
  vm.runInContext(part(read('app/js/composer.js'), 'function submitOnEnter(', 'const composerInputHandlers ='), h.context);
  h.context.submitOnEnter({ preventDefault() {} });
  assert.equal(h.packets.length, 0); assert.equal(h.context.sheetKind, null);
  assert.deepEqual(h.calls, []);
});

test('Enter uses the shared send action and still leaves IME and Shift+Enter untouched', () => {
  const h = confirmation();
  Object.assign(h.context, { composing: false, shiftEnter: false });
  vm.runInContext(part(read('app/js/composer.js'), 'function submitOnEnter(', 'const composerInputHandlers ='), h.context);
  let prevented = 0;
  for (const overrides of [{ shiftKey: true }, { isComposing: true }])
    h.context.submitOnEnter({ preventDefault: () => prevented++, ...overrides });
  h.context.composing = true; h.context.submitOnEnter({ preventDefault: () => prevented++ });
  assert.equal(prevented, 0); assert.equal(h.packets.length, 0);
  h.context.composing = false; h.context.submitOnEnter({ preventDefault: () => prevented++ });
  assert.equal(prevented, 1); assert.equal(h.packets.length, 1); assert.equal(h.packets[0].when, 'queue');
  assert.deepEqual(h.calls, ['cancelVoice']);
});

test('card input tools retain the bound editor for history and newline actions', async () => {
  const calls = [], state = { ready: Promise.resolve(true) }, input = {};
  const context = vm.createContext({
    ovToolState: state, ovPrepareTools: () => state, ovToolInput: () => input,
    recallInput: (direction, editor) => { assert.equal(editor, input); calls.push(direction); },
    endInputRecall: () => calls.push('end'),
    insertComposerText: (text, editor) => { assert.equal(editor, input); calls.push(text); },
  });
  vm.runInContext(part(read('app/js/overview.js'), 'async function ovUseTool(', 'function ovLocateCard('), context);
  await context.ovUseTool('card', 'inputPrev'); await context.ovUseTool('card', 'inputNext');
  await context.ovUseTool('card', 'insertNewline');
  assert.deepEqual(calls, [-1, 1, 'end', '\n']);
  context.ovToolState = {}; await context.ovUseTool('card', 'inputPrev');
  assert.deepEqual(calls, [-1, 1, 'end', '\n']);
});

function voiceComposer() {
  const calls = [], input = { value: 'saved', selectionStart: 5, selectionEnd: 5 };
  const text = { value: 'saved', selectionStart: 5, selectionEnd: 5,
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    dispatchEvent() { input.value = text.value; input.selectionStart = text.selectionStart; input.selectionEnd = text.selectionEnd; } };
  const context = vm.createContext({
    input, text, Event, CSS: { escape: value => value }, ovToolState: { key: 'card' },
    document: { querySelector: () => input }, $: () => ({ classList: { remove() {} }, setAttribute() {} }),
    voiceSession: { input, expected: 'saved', prefix: '', suffix: '', selection: '',
      recognition: { abort: () => calls.push('abort') }, stream: { getTracks: () => [{ stop: () => calls.push('stop') }] } },
    clearTimeout() {}, updateVoiceButton() {}, mentionHide() {}, mentionInput: input,
    finishWinBinding() {}, ovMountComposerControls: () => calls.push('mount'),
    scrollVoiceInput: editor => { assert.equal(editor, input); calls.push('scroll'); },
  });
  context.voiceLive = session => context.voiceSession === session;
  const source = read('app/js/local-voice.js');
  vm.runInContext(part(source, 'function releaseVoiceMedia(', 'function voiceText(')
    + part(source, 'function voiceText(', 'function scrollVoiceInput(')
    + part(read('app/js/overview.js'), 'function ovReleaseComposer(', 'function ovMountComposerControls('), context);
  return { context, input, text, calls };
}

test('closing a voice-owned card releases microphone and recognition before returning its controls', () => {
  const h = voiceComposer(); h.context.ovReleaseComposer();
  assert.deepEqual(h.calls, ['abort', 'stop', 'mount']);
  assert.equal(h.context.voiceSession, null); assert.equal(h.context.ovToolState, null);
  assert.equal(h.input.value, 'saved'); assert.equal(h.text.value, 'saved');
});

test('a delayed transcript cannot write after its card recording is cancelled', () => {
  const h = voiceComposer(), session = h.context.voiceSession; h.context.ovReleaseComposer();
  h.context.voiceText(session, 'late transcript');
  assert.equal(h.text.value, 'saved'); assert.equal(h.calls.includes('scroll'), false);
});

test('releasing a card does not cancel a recording owned by the full composer', () => {
  const h = voiceComposer(); h.context.voiceSession.input = h.text;
  h.context.ovReleaseComposer();
  assert.deepEqual(h.calls, ['mount']); assert(h.context.voiceSession);
});

test('dictation keeps the shared draft and scrolls the recording owner after mirroring', () => {
  const h = voiceComposer(); h.context.voiceText(h.context.voiceSession, 'recognized words');
  assert.equal(h.text.value, 'recognized words'); assert.equal(h.input.value, 'recognized words');
  assert.deepEqual(h.calls, ['scroll']);
});

test('the shared voice caret calculation scrolls its supplied editor without changing another textarea', () => {
  const hidden = { scrollTop: 7 }, editor = { value: 'words', selectionEnd: 5, clientWidth: 180, clientHeight: 36, scrollHeight: 150, scrollTop: 0 };
  let caretTop = 100;
  const context = vm.createContext({ text: hidden,
    getComputedStyle: input => { assert.equal(input, editor); return { lineHeight: '22px', paddingBottom: '0px' }; },
    document: { body: { append() {} }, createElement: tag => ({ style: {}, append() {}, remove() {}, getBoundingClientRect: () => ({ top: tag === 'span' ? caretTop : 0 }) }) },
  });
  vm.runInContext(part(read('app/js/local-voice.js'), 'function scrollVoiceInput(', 'async function startVoice('), context);
  context.scrollVoiceInput(editor); assert.equal(editor.scrollTop, 86); assert.equal(hidden.scrollTop, 7);
  caretTop = 10; context.scrollVoiceInput(editor); assert.equal(editor.scrollTop, 10);
});

function usageMeters() {
  const nodes = new Map(), computer = { id: 'computer-A' }, document = new EventTarget();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', title: '', style: { setProperty() {} },
      parentElement: { style: { setProperty() {} }, dataset: {} }, classList: { toggle() {} }, setAttribute() {},
      querySelector: () => ({}), querySelectorAll: () => [], insertAdjacentHTML(_where, html) { this.innerHTML += html; } });
    return nodes.get(id);
  };
  const context = vm.createContext({ document, Event, $: node, currentComputer: () => computer,
    currentApp: 'codex', viewSel: 'codex|window-A|thread-A', esc: String, ready: true, status() {} });
  context.ovComposerReady = key => context.ready && key === 'card';
  const source = read('app/js/sheets.js');
  vm.runInContext(part(source, 'function fusionUsageBars(', 'function fusionMetricValue(')
    + part(source, 'function meterFill(', '// Phones show the value text')
    + part(source, 'const quotaCache = new Map();', 'function showUsageDetails(')
    + part(read('app/js/overview.js'), 'function ovUsageHtml(', 'function ovUpdateUsage('), context);
  return { context, computer, nodes, node,
    data: () => JSON.parse(JSON.stringify(context.currentUsageMeters())), html: () => context.ovUsageHtml('card') };
}

test('card rings share the existing context and quota percentage conversion with the header', () => {
  const h = usageMeters();
  h.context.renderQuota({ context: { pct: 40, basis: 'used' }, limits: [{ label: 'weekly', pct: 25, basis: 'used' }] });
  assert.equal(h.node('meterCtxPct').textContent, '已用40%');
  assert(h.node('quotaMeters').innerHTML.includes('剩余75%'));
  assert(h.html().includes('上下文 已用 40%')); assert(h.html().includes('weekly 剩余 75%'));
  assert.equal(h.data().quota[0].pct, 75);
});

test('context stays scoped to a conversation while quota stays scoped to its computer and window', () => {
  const h = usageMeters(); h.context.renderQuota({ context: 30, quota: [{ label: 'weekly', pct: 60, basis: 'remaining' }] });
  h.context.viewSel = 'codex|window-A|thread-B';
  assert.equal(h.data().context, null); assert.equal(h.data().quota[0].pct, 60);
  h.context.viewSel = 'codex|window-B|thread-B'; assert.deepEqual(h.data(), { context: null, quota: [] });
  h.context.viewSel = 'codex|window-A|thread-A'; h.computer.id = 'computer-B';
  assert.deepEqual(h.data(), { context: null, quota: [] });
});

test('unbound and missing card metrics remain unknown rather than becoming zero', () => {
  const h = usageMeters(); h.context.renderQuota({ context: 0, missing: true, quota: [] });
  assert(h.html().includes('上下文 已用 0%')); assert(h.html().includes('额度 未获取'));
  h.context.ready = false; assert(h.html().includes('上下文 未获取'));
  assert.equal(h.html().includes('已用 0%'), false);
});

test('multiple quota periods have independent segments and retain their original values', () => {
  const h = usageMeters(); h.context.renderQuota({ context: { pct: 20, basis: 'remaining' }, limits: [
    { label: 'weekly', pct: 40, basis: 'used' }, { label: 'daily', pct: 70, basis: 'used' },
  ] });
  const html = h.html();
  assert(html.includes('上下文 已用 80%')); assert(html.includes('weekly 剩余 60%')); assert(html.includes('daily 剩余 30%'));
  assert.equal((html.match(/class="ov-meter-quota /g) || []).length, 2);
  assert(html.includes('stroke-dashoffset="-50"'));
});

test('unchanged usage updates leave the ring DOM intact and never repaint the card body', () => {
  const h = usageMeters(); let value = '', writes = 0;
  const holder = { closest: () => ({ dataset: { ovSession: 'card' } }) };
  Object.defineProperty(holder, 'innerHTML', { get: () => value, set: html => { value = html; writes++; } });
  h.context.document.body = { classList: { contains: () => false } };
  h.context.$ = () => ({ querySelector: () => holder });
  vm.runInContext(part(read('app/js/overview.js'), 'function ovUpdateUsage(', "document.addEventListener('usage-state'"), h.context);
  h.context.ovUpdateUsage(); h.context.ovUpdateUsage(); assert.equal(writes, 1);
  h.context.$ = h.node; h.context.renderContext(50); h.context.$ = () => ({ querySelector: () => holder });
  h.context.ovUpdateUsage(); assert.equal(writes, 2);
});
