import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const net = read('app/js/net.js');
const notify = read('app/js/notify.js');
const core = read('app/js/core.js');
const composer = read('app/js/composer.js');
const gate = read('app/js/gate.js');
const overview = read('app/js/overview.js');
const computers = ['a', 'b'].map(name => ({
  id: name.repeat(16), key: 'key-' + name, token: 'token-' + name,
  relay: 'https://relay-' + name + '.invalid', win: 'codex',
  windowId: 'window-' + name, threadId: 'thread-' + name,
}));

function harness({ sameSelection = false, count = 2 } = {}) {
  const records = Array.from({ length: count }, (_, i) => {
    const name = String.fromCharCode(97 + i);
    return { ...computers[0], id: name.repeat(16), key: 'key-' + name, token: 'token-' + name,
      relay: 'https://relay-' + name + '.invalid', windowId: 'window-' + name, threadId: 'thread-' + name };
  });
  if (sameSelection) Object.assign(records[1], { windowId: records[0].windowId, threadId: records[0].threadId });
  const stored = new Map([
    ['computers', JSON.stringify(records)], ['computer', records[0].id],
    ['key', records[0].key], ['token', records[0].token],
  ]);
  const elements = new Map(), sockets = [], timers = new Map(), trace = [];
  let timerId = 0, now = 100000;
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {
        value: '', disabled: false, hidden: false, innerHTML: '', textContent: '', dataset: {},
        classList: { add: key => classes.add(key), remove: key => classes.delete(key), contains: key => classes.has(key) },
        querySelector: () => null, querySelectorAll: () => [], replaceChildren() {},
      });
    }
    return elements.get(id);
  }
  class FakeWebSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(data) { assert.equal(this.readyState, 1); this.sent.push(JSON.parse(data)); }
    open() { this.readyState = 1; return this.onopen(); }
    receive(message) { this.onmessage({ data: JSON.stringify(message) }); }
    close(code = 1000) { this.readyState = 3; return this.onclose?.({ code }); }
  }
  const context = vm.createContext({
    URL, URLSearchParams, AbortController, AbortSignal, Event, crypto, performance, structuredClone,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
    WebSocket: FakeWebSocket,
    location: { href: 'https://phone.invalid/', origin: 'https://phone.invalid', pathname: '/', hash: '', search: '' },
    history: { replaceState() {} }, navigator: { userAgent: 'test' },
    sessionStorage: { getItem: () => null, removeItem() {} },
    store: { get: key => stored.get(key) ?? null, set: (key, value) => value == null ? stored.delete(key) : stored.set(key, value) },
    document: { visibilityState: 'visible', activeElement: null, documentElement: { dataset: { theme: 'dark' } }, dispatchEvent() {} },
    $: element,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms, at: now + ms, repeat: true }); return id; },
    clearInterval: id => timers.delete(id),
    requestAnimationFrame: fn => { const id = ++timerId; timers.set(id, { fn, ms: 0, at: now }); return id; },
    fetch: async () => ({ ok: true, json: async () => ({ v: 3, computers: [] }) }),
    entryProof: async () => 'test-proof', legacyAgentLibrary: () => [], trace,
  });
  context.window = context;
  context.addEventListener = () => {};
  const run = source => vm.runInContext(source, context);
  run(`
    var base = null, info = null, ws = null, authed = false;
    var mode = 'chat', windowReady = false, connGen = 0, usageTimer = 0;
    var currentApp = 'codex', currentAppName = 'Codex', currentWindow = 'codex', viewSel = '', currentProject = '';
    var windows = [], appPlans = {}, sheetKind = '', pendingStatus = '', qnSig = '', inApp = false;
    var capabilityOwner = '', agentCapabilities = null, fusionSideCapabilities = {}, capabilityBlock = '';
    var menuRequest = 0, menuPending = null, menuPickRequest = 0, modelSwitchRequest = null;
    var docsRequest = 0, docsPending = null, editorBrowsing = false, codexSettingsRequest = 0;
    var draftEpoch = '', draftRevision = 0, draftAckRevision = 0, pendingDesktopDraft = null, mirroredDraft = '';
    var activeDraft = '', draftPushTimer = 0, questionCompose = null, composing = false, inputRevision = 0;
    var drafts = new Map(), draftMentions = new Map(), dirtyDrafts = new Set(), draftVersions = new Map();
    var pendingSends = new Map(), pendingEchoes = [], desktopRequests = new Map(), MN = { mentions: [], value: '' };
    var agentLists = new Map(), cache = new Map(), chatBySel = new Map(), quotaCache = new Map();
    var lastChat = null, chatStale = false, text = $('text');
    var thoughtObserver = { disconnect() {} }, chatPreviewReady = Promise.resolve(), I18N = { lang: 'zh', tr: value => value };
    var computerResumes = new Map(), computerResumeReady = Promise.resolve();
    function saveComputerResume() {}
    function status(value) { pendingStatus = value; trace.push(['status', value]); }
    var compatibilityRequests = new Map(), compatibilityReports = new Map();
    function gate() { $('gate').classList.add('open'); }
    function ungate() { $('gate').classList.remove('open'); }
    function closeSheet() { sheetKind = ''; }
    function showComputers() { trace.push(['computer-list']); }
    function queueChatRender(chat, stale) {
      trace.push(['render', currentComputer().id, chat?.thread, lastChat?.thread ?? null]);
      lastChat = chat; chatStale = !!stale;
    }
    function renderChat(chat, stale) { trace.push(['preview', currentComputer().id, !!stale]); lastChat = chat; chatStale = !!stale; }
    function chatCacheKey(sel) { return currentComputer().id + '|' + sel; }
    function cacheChat(sel, chat) { chatBySel.set(chatCacheKey(sel), chat); }
    function connAgentResults(agents) { conn.agents = agents; }
    function agentCatalogResults(agents) { conn.catalogReady = true; }
    function renderAttachments(list) { trace.push(['attachments', currentComputer().id, list.length]); }
    function quotaKey() { return currentComputer().id; }
    function winLabel(value) { return { name: value || '' }; }
    function agentListKey() { return currentComputer().id; }
    function setAgentList(key, value) { agentLists.set(key, value); }
    function syncNotify() { trace.push(['notify', currentComputer().id]); }
    function openComputerEntry(url, id) { trace.push(['entry', url, id]); }
    function openSheet(kind) { trace.push(['sheet', kind]); }
    function esc(value) { return value; }
    var bootCalls = 0, overviewRefreshes = 0, overviewFetches = [];
    var ovList = JSON.parse(store.get('computers')).map((c,index)=>({id:c.id,c,index})), ovSt = new Map();
    function ovStOf(id) { if(!ovSt.has(id))ovSt.set(id,{dataStatus:'loading'});return ovSt.get(id); }
    function ovRender() { overviewRefreshes++; }
    function ovEnterReady() {}
    function ovFetch(e) { overviewFetches.push(e.id);return Promise.resolve(); }
    var connectionDetailsComputer = '';
    function showConnectionDetails() {}

  `);
  for (const name of [
    'resetLatency', 'finishPending', 'failFileRead', 'waitFileSave', 'cancelChatContentRequests',
    'interruptSessionBatch', 'cancelCodexAutoRetry', 'markUploadsDisconnected', 'disconnectPendingSends',
    'updateAppText', 'updateTitle', 'invalidateChatRender', 'beginChatSelection', 'endInputRecall',
    'mentionHide', 'autosize', 'rememberAgentOpen', 'requestCompatibility', 'scheduleLatency',
    'renderContext', 'renderQuota', 'renderQuestions', 'paintRail', 'checkAppUpdate',
  ]) context[name] = () => {};
  context.conversationVisible = () => true;
  run(core.slice(core.indexOf('function requestAgentCatalog()'), core.indexOf('function openAgentList(')));
  run(gate.slice(gate.indexOf('function newComputerConnection('), gate.indexOf('const connLaunchStatus')));
  run(gate.slice(gate.indexOf('function connReadFailed('), gate.indexOf('function connRetryCurrent(')));
  run(net);
  run(core.slice(core.indexOf('function desktopAction(obj)'), core.indexOf('\n\n', core.indexOf('function setWindowReady(ready)'))));
  run(composer.slice(composer.indexOf('function draftKey()'), composer.indexOf('function autosize()')));
  run(notify.slice(notify.indexOf('async function useComputer(i)'), notify.indexOf('async function removeComputer(i)')));
  run('var realBoot = boot; boot = function() { bootCalls++; return realBoot(); };');
  const state = () => JSON.parse(run(`JSON.stringify({ computer:currentComputer().id, authed, windowReady, selectionReady,
    thread:lastChat?.thread, body:lastChat?.items?.[0]?.t, chatStale, viewSel, draft:text.value, epoch:draftEpoch,
    revision:draftRevision, activeDraft, bootCalls, gateOpen:$('gate').classList.contains('open'), generation:bootGeneration,
    navigation:navigationPending?.id, failed:conn.attachFailed, status:pendingStatus })`));
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const link = i => run(`computerSockets.get(loadComputers()[${i}].key)`);
  async function open(i, { foreground = false, lastSelection } = {}) {
    const result = await run(`openComputerSocket(loadComputers()[${i}], loadComputers()[${i}].relay)`);
    if (result.authed) return result;
    if (foreground) await run(`base=currentComputer().relay;resetComputerConnection();connect()`);
    await result.socket.open();
    result.socket.receive({ t: 'auth', ok: true, id: records[i].id, name: 'computer-' + i, lastSelection: lastSelection ?? {
      id: records[i].win, windowId: records[i].windowId, threadId: records[i].threadId,
    } });
    await settle();
    return result;
  }
  function deliver(i, message) {
    link(i).socket.receive({ navigationId: link(i).navigationId, ...message });
  }
  function attached(i, options = {}) {
    const c = records[i], sel = `codex|${c.windowId}|${c.threadId}`;
    deliver(i, { t: 'attached', id: 'codex', app: 'codex', appName: 'Codex', title: 'Codex',
      windowId: c.windowId, threadId: c.threadId, sel, ready: true,
      chat: { thread: c.threadId, busy: false, items: [{ i: 'message-' + i, k: 'human', t: 'computer-' + i }] }, ...options });
  }
  async function switchTo(i) { await run(`useComputer(${i})`); await settle(); }
  const start = () => open(0, { foreground: true });
  async function bothReady() {
    await start(); attached(0);
    await open(1); attached(1);
    await switchTo(1);
    await switchTo(0);
    trace.length = 0;
    for (const socket of sockets) socket.sent.length = 0;
  }
  function flushDraft() {
    const pending = [...timers].filter(([, timer]) => timer.ms === 400);
    for (const [id, timer] of pending) { timers.delete(id); timer.fn(); }
  }
  async function advance(ms) {
    const until = now + ms;
    while (true) {
      const next = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      now = timer.at;
      if (timer.repeat) timer.at += timer.ms;
      else timers.delete(id);
      timer.fn(); await settle();
    }
    now = until;
    await settle();
  }
  return { run, state, settle, link, open, start, attached, deliver, switchTo, bothReady, records, trace, sockets, flushDraft,
    timers, advance, jump: ms => { now += ms; } };
}

test('ready computer switches onto its existing session and can send immediately without boot/auth/attach', async () => {
  const h = harness(); await h.bothReady();
  const boots = h.state().bootCalls, socket = h.link(1).socket;
  await h.switchTo(1);
  const state = h.state();
  assert.equal(state.computer, computers[1].id); assert.equal(state.thread, 'thread-b');
  assert(state.authed && state.windowReady && state.selectionReady && !state.chatStale);
  assert.equal(state.bootCalls, boots); assert.equal(state.gateOpen, false);
  assert.equal(h.trace.some(row => row[0] === 'preview'), false);
  assert.equal(socket.sent.some(row => ['auth', 'attach', 'mode'].includes(row.t)), false);
  h.run(`send({t:'send',text:'to computer B',submit:true})`);
  assert.equal(socket.sent.at(-1).t, 'send');
  assert.equal(socket.sent.at(-1).sel, 'codex|window-b|thread-b');
  assert.equal(h.link(0).socket.sent.some(row => row.t === 'send'), false);
});

test('a first-screen request completed after parking can be adopted without another load', async () => {
  const h = harness(); await h.start(); h.attached(0);
  await h.open(1); await h.switchTo(1);
  assert.equal(h.state().windowReady, false);
  await h.switchTo(0);
  h.attached(1);
  assert.equal(h.state().computer, computers[0].id);
  assert.equal(h.state().thread, 'thread-a');
  const boots = h.state().bootCalls;
  h.link(1).socket.sent.length = 0;
  await h.switchTo(1);
  assert.equal(h.state().bootCalls, boots);
  assert.equal(h.state().windowReady, true);
  assert.equal(h.state().thread, 'thread-b');
  assert.equal(h.link(1).socket.sent.some(row => row.t === 'attach'), false);
});

test('drafts and draft epochs stay with their computers through repeated switches', async () => {
  const h = harness(); await h.bothReady();
  h.run(`text.value='draft A';draftEpoch='epoch-a';saveDraft();`);
  await h.switchTo(1);
  h.run(`text.value='draft B';draftEpoch='epoch-b';saveDraft();`);
  await h.switchTo(0);
  assert.equal(h.state().draft, 'draft A'); assert.equal(h.state().epoch, 'epoch-a');
  h.flushDraft();
  assert.equal(h.link(0).socket.sent.at(-1).draftEpoch, 'epoch-a');
  await h.switchTo(1);
  assert.equal(h.state().draft, 'draft B'); assert.equal(h.state().epoch, 'epoch-b');
  h.flushDraft();
  assert.equal(h.link(1).socket.sent.at(-1).draftEpoch, 'epoch-b');
  assert(h.state().activeDraft.startsWith(computers[1].id + '|'));
});

test('rapid ready switches and late background updates do not change the active computer', async () => {
  const h = harness(); await h.bothReady();
  const boots = h.state().bootCalls;
  const b = h.run('useComputer(1)'), a = h.run('useComputer(0)');
  await Promise.all([a, b]); await h.settle();
  h.deliver(1, { t:'chat', sel:'codex|window-b|thread-b', chat:{thread:'thread-b',busy:false,items:[{i:'late-b',k:'human',t:'late B'}]} });
  assert.equal(h.state().computer, computers[0].id); assert.equal(h.state().thread, 'thread-a');
  assert.equal(h.state().bootCalls, boots);
  h.run(`send({t:'send',text:'to computer A',submit:true})`);
  assert.equal(h.link(0).socket.sent.at(-1).t, 'send');
  assert.equal(h.link(1).socket.sent.some(row => row.t === 'send'), false);
  await h.switchTo(1);
  assert.equal(h.state().body, 'late B');
});

test('identical window/thread identifiers on different computers still select separate content and drafts', async () => {
  const h = harness({sameSelection:true}); await h.bothReady();
  h.run(`text.value='local A';saveDraft();`);
  await h.switchTo(1);
  assert.equal(h.state().body, 'computer-1'); assert.equal(h.state().draft, '');
  assert.equal(h.trace.some(row=>row[0]==='preview'), false);
  h.run(`text.value='local B';saveDraft();`);
  await h.switchTo(0);
  assert.equal(h.state().body, 'computer-0'); assert.equal(h.state().draft, 'local A');
});

test('the first visit stays usable while adopting the existing background load without another attach', async () => {
  const h = harness(); await h.start(); h.attached(0); await h.open(1);
  h.run(`text.value='stay on A';saveDraft();`);
  const boots = h.state().bootCalls;
  const attaches = h.link(1).socket.sent.filter(row => row.t === 'attach').length;
  await h.switchTo(1);
  assert.equal(h.state().bootCalls, boots);
  assert.equal(h.state().windowReady, false);
  assert.equal(h.state().draft, ''); assert.equal(h.state().thread, undefined);
  assert.equal(h.state().gateOpen, false);
  assert.equal(h.link(1).socket.sent.filter(row => row.t === 'attach').length, attaches);
  h.attached(1);
  assert.equal(h.state().windowReady, true);
  assert.equal(h.state().thread, 'thread-b');
});

test('a never visited computer loads its first screen without changing the current page or draft', async () => {
  const h = harness(); await h.start(); h.attached(0);
  h.run(`text.value='keep draft A';saveDraft();`);
  const before = h.state();
  await h.open(1);
  const socket = h.link(1).socket;
  assert.deepEqual(socket.sent.filter(row => row.t === 'visible'), [{ t: 'visible', v: false }]);
  const request = socket.sent.find(row => row.t === 'attach');
  assert.equal(request.windowId, 'window-b'); assert.equal(request.threadId, 'thread-b');
  h.deliver(1, { t: 'connAgents', agents: [{ app: 'codex', windows: 1 }] });
  h.deliver(1, { t: 'agentCatalog', agents: [{ app: 'codex', installed: true }] });
  h.attached(1);
  assert.deepEqual(h.state(), before);
  assert.equal(h.run('loadComputers()[1].name'), 'computer-1');
  assert(!h.link(1).receive);
  const boots = h.state().bootCalls;
  socket.sent.length = 0; h.trace.length = 0;
  await h.switchTo(1);
  assert.equal(h.state().thread, 'thread-b'); assert.equal(h.state().draft, '');
  assert.equal(h.state().bootCalls, boots); assert.equal(h.state().gateOpen, false);
  assert.equal(socket.sent.some(row => ['auth', 'attach', 'mode'].includes(row.t)), false);
  h.run(`send({t:'send',text:'first visit B',submit:true})`);
  assert.equal(socket.sent.at(-1).sel, 'codex|window-b|thread-b');
  await h.switchTo(0);
  assert.equal(h.state().draft, 'keep draft A');
});

test('a slow background load does not delay the current computer initial load', async () => {
  const h = harness();
  await h.run('boot()'); await h.settle();
  await h.open(0); h.attached(0);
  await h.open(1);
  assert(h.link(1).preload); assert.equal(h.link(1).binding, undefined);
  assert.equal(h.state().thread, 'thread-a'); assert.equal(h.state().windowReady, true);
  assert.equal(h.state().computer, computers[0].id);
});

test('an in-progress first visit can be parked and resumed again on the same request', async () => {
  const h = harness(); await h.start(); h.attached(0); await h.open(1);
  const boots = h.state().bootCalls;
  await h.switchTo(1); await h.switchTo(0); await h.switchTo(1);
  assert.equal(h.state().bootCalls, boots);
  assert.equal(h.link(1).socket.sent.filter(row => row.t === 'attach').length, 1);
  h.attached(1, { chat: undefined });
  assert.equal(h.state().windowReady, false);
  h.deliver(1, { t: 'chat', sel: 'codex|window-b|thread-b', chat: { thread: 'thread-b', items: [] } });
  assert.equal(h.state().windowReady, true);
  assert.equal(h.state().navigation, undefined);
});

test('a background failure stays on its computer and is shown on first visit without restarting it', async () => {
  const h = harness(); await h.start(); h.attached(0);
  const before = h.state(); await h.open(1);
  h.deliver(1, { t: 'attachFailed', ready: false, message: 'B login required' });
  await h.link(1).firstScreen;
  assert.deepEqual(h.state(), before);
  await h.switchTo(1);
  assert.equal(h.state().bootCalls, before.bootCalls);
  assert.equal(h.state().windowReady, false); assert.equal(h.state().failed, true);
  assert.equal(h.state().status, 'B login required');
  assert.equal(h.link(1).socket.sent.filter(row => row.t === 'attach').length, 1);
  await h.switchTo(0);
  assert.equal(h.state().thread, 'thread-a'); assert.equal(h.state().windowReady, true);
});

test('background project trust waits for its own foreground view', async () => {
  const h = harness(); await h.start(); h.attached(0); await h.open(1);
  h.attached(1, { ready: false, chat: undefined });
  h.deliver(1, { t: 'projectTrust', sel: 'codex|window-b|thread-b', path: '/fixture/project' });
  await h.link(1).firstScreen;
  assert.equal(h.trace.some(row => row[0] === 'sheet'), false);
  assert.equal(h.state().thread, 'thread-a');
  await h.switchTo(1);
  assert.equal(h.state().windowReady, false);
  assert(h.trace.some(row => row[0] === 'sheet' && row[1] === 'project-trust'));
  assert.equal(h.link(1).socket.sent.filter(row => row.t === 'attach').length, 1);
});

test('a background first screen that has recovered does not replay an obsolete trust prompt', async () => {
  const h = harness(); await h.start(); h.attached(0); await h.open(1);
  h.attached(1, { ready: false, chat: undefined });
  h.deliver(1, { t: 'projectTrust', path: '/fixture/project' });
  h.attached(1);
  await h.switchTo(1);
  assert.equal(h.state().windowReady, true);
  assert.equal(h.trace.some(row => row[0] === 'sheet'), false);
});

test('a background server selection is saved for that computer without selecting it on the phone', async () => {
  const h = harness(); await h.start(); h.attached(0);
  await h.open(1, { lastSelection: { id: 'codex', windowId: 'other-window', threadId: 'other-thread' } });
  h.attached(1, { windowId: 'other-window', threadId: 'other-thread', sel: 'codex|other-window|other-thread',
    chat: { thread: 'other-thread', items: [] } });
  assert.equal(h.state().computer, computers[0].id);
  assert.equal(h.run('loadComputers()[1].threadId'), 'other-thread');
  await h.switchTo(1);
  assert.equal(h.state().thread, 'other-thread');
  assert.equal(h.link(1).socket.sent.filter(row => row.t === 'attach').length, 1);
});

test('the two background workers wait for first screens, including across repeated warmup calls', async () => {
  const h = harness({ count: 4 }); await h.start(); h.attached(0);
  const first = h.run('warmComputerSockets()'); await h.settle();
  const second = h.run('warmComputerSockets()'); await h.settle();
  assert(h.link(1) && h.link(2)); assert.equal(h.link(3), undefined);
  await h.open(1); await h.open(2);
  await h.settle(); assert.equal(h.link(3), undefined);
  h.attached(1); await h.settle();
  assert(h.link(3));
  await h.open(3); h.deliver(2, { t: 'attachFailed', ready: false, message: 'C unavailable' });
  h.attached(3); await Promise.all([first, second]);
  assert.equal(h.state().thread, 'thread-a'); assert.equal(h.state().windowReady, true);
});

test('a changed background thread invalidates the never visited preloaded destination', async () => {
  const h = harness(); await h.start(); h.attached(0); await h.open(1); h.attached(1);
  h.deliver(1, { t: 'thread', sel: 'codex|window-b|other-thread', threadId: 'other-thread' });
  const boots = h.state().bootCalls;
  await h.switchTo(1);
  assert.equal(h.state().bootCalls, boots + 1);
  assert.equal(h.state().windowReady, false);
});

for (const [name, invalidate] of [
  ['cached preview', h => h.deliver(1,{t:'chat',sel:'codex|window-b|thread-b',cached:true,chat:{thread:'thread-b',items:[]}})],
  ['closed binding', h => h.deliver(1,{t:'attached',closed:true,ready:false})],
  ['failed attachment', h => h.deliver(1,{t:'attachFailed',ready:false})],
  ['different thread', h => h.deliver(1,{t:'thread',sel:'codex|window-b|other-thread',threadId:'other-thread'})],
  ['incomplete binding', h => h.deliver(1,{t:'attached',ready:false})],
]) test(name + ' cannot be promoted as an already loaded session', async () => {
  const h = harness(); await h.bothReady(); invalidate(h);
  const boots = h.state().bootCalls;
  await h.switchTo(1);
  assert.equal(h.state().bootCalls, boots + 1);
  assert.equal(h.state().windowReady, false);
});

test('a closed background socket invalidates its binding without disrupting the active connection', async () => {
  const h = harness(); await h.bothReady();
  await h.link(1).socket.close();
  assert.equal(h.link(1).binding, null);
  assert.equal(h.state().computer, computers[0].id);
  assert(h.state().authed && h.state().windowReady);
  const boots = h.state().bootCalls;
  await h.switchTo(1);
  assert.equal(h.state().bootCalls, boots+1);
  assert.equal(h.state().windowReady, false);
});

test('superseded navigation messages cannot replace the parked session', async () => {
  const h = harness(); await h.bothReady();
  h.deliver(1,{t:'attached',navigationId:h.link(1).navigationId-1,closed:true,ready:false});
  const boots = h.state().bootCalls;
  await h.switchTo(1);
  assert.equal(h.state().bootCalls, boots);
  assert.equal(h.state().thread, 'thread-b');
});

test('an explicit destination change loads that destination rather than promoting another cached thread', async () => {
  const h = harness(); await h.bothReady();
  h.run(`saveComputers(loadComputers().map((c,i)=>i===1?{...c,threadId:'notification-thread'}:c),currentComputer().key)`);
  const boots = h.state().bootCalls;
  await h.switchTo(1);
  assert.equal(h.state().bootCalls, boots+1);
  assert.equal(h.state().windowReady, false);
});

test('changing the requested display mode does not reuse a chat first screen as terminal content', async () => {
  const h = harness(); await h.bothReady(); h.run(`mode='terminal'`);
  const boots = h.state().bootCalls;
  await h.switchTo(1);
  assert.equal(h.state().bootCalls, boots+1);
});

test('a paired cold start and connection failure never open a full-page gate', async () => {
  const h = harness();
  h.run(`fetch=async()=>{throw new Error('fixture offline')}`);
  await h.run('boot()'); await h.settle();
  assert.equal(h.state().gateOpen, false);
  h.link(0).socket.close(); await h.settle();
  assert.equal(h.state().gateOpen, false);
  assert.equal(h.link(0).phase, 'offline');
});

test('reconnecting B reuses one targeted load without changing A or its draft', async () => {
  const h = harness(); await h.bothReady();
  h.run(`text.value='keep A';saveDraft();`);
  h.link(1).socket.close();
  const before = h.state();
  const first = h.run(`reconnectComputer(loadComputers()[1].id)`);
  const second = h.run(`reconnectComputer(loadComputers()[1].id)`);
  assert.equal(first, second);
  await h.settle();
  assert.deepEqual(h.state(), before);
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(overviewFetches)')), [computers[1].id]);
  await h.open(1); h.attached(1); await first;
  assert.deepEqual(h.state(), before);
  assert.equal(h.link(0).socket.sent.some(m => m.t === 'attach' || m.t === 'send'), false);
  assert.equal(h.link(1).attempt, null);
});

test('authorization failure stays in the computer row until authorization is explicitly requested', async () => {
  const h = harness(); await h.run('boot()'); await h.settle();
  await h.link(0).socket.open();
  h.link(0).socket.receive({ t: 'auth', ok: false, id: computers[0].id, needTotp: true });
  await h.settle();
  assert.equal(h.state().gateOpen, false);
  assert.equal(h.link(0).phase, 'auth');
  await h.run('authorizeComputer(loadComputers()[0].id)'); await h.settle();
  await h.link(0).socket.open();
  h.link(0).socket.receive({ t: 'auth', ok: false, id: computers[0].id, needTotp: true });
  await h.settle();
  assert.equal(h.state().gateOpen, true);
});

test('connection diagnostics use B address and retain A selection and content', async () => {
  const h = harness(); await h.bothReady();
  const before = h.state();
  h.run(`var diagnosticUrls=[];fetch=async url=>{diagnosticUrls.push(url);return{ok:true,json:async()=>({self:true})}}`);
  await h.run('checkComputerConnection(loadComputers()[1].id)');
  const urls = JSON.parse(h.run('JSON.stringify(diagnosticUrls)'));
  assert(urls.some(url => url.startsWith(computers[1].relay + '/url.json')));
  assert(!urls.some(url => url.startsWith(computers[0].relay)));
  assert.equal(h.run('ovStOf(loadComputers()[1].id).diagRunning'), false);
  assert.deepEqual(h.state(), before);
});

test('a delayed heartbeat probes every connected computer instead of closing on an old receive timestamp', async () => {
  const h = harness(); await h.bothReady();
  const sockets = h.sockets.slice();
  h.jump(60000); h.run('heartbeat()');
  for (const socket of sockets) {
    assert.equal(socket.readyState, 1);
    assert.deepEqual(socket.sent.map(m => m.t), ['ping']);
  }
});

test('foreground restoration and periodic checks share one outstanding probe and accept any new reply', async () => {
  const h = harness(); await h.bothReady();
  h.jump(60000);
  h.run('resumeComputerConnections();resumeComputerConnections();heartbeat()');
  h.jump(5000); h.run('heartbeat()');
  for (let i = 0; i < 2; i++) {
    assert.equal(h.link(i).socket.readyState, 1);
    assert.equal(h.link(i).socket.sent.filter(m => m.t === 'ping').length, 1);
    h.deliver(i, { t: 'pong' });
  }
  h.run('heartbeat()');
  for (let i = 0; i < 2; i++) assert.equal(h.link(i).socket.sent.filter(m => m.t === 'ping').length, 2);
});

test('background suspension cancels old probes and does not consume their foreground response budget', async () => {
  const h = harness(); await h.bothReady(); h.run('heartbeat()');
  h.run('document.visibilityState="hidden";suspendComputerConnections()');
  h.jump(120000); h.run('heartbeat()');
  for (const socket of h.sockets) assert.equal(socket.sent.filter(m => m.t === 'ping').length, 1);
  h.run('document.visibilityState="visible";resumeComputerConnections();heartbeat()');
  for (let i = 0; i < 2; i++) {
    assert.equal(h.link(i).socket.readyState, 1);
    assert.equal(h.link(i).socket.sent.filter(m => m.t === 'ping').length, 2);
  }
});

test('a silent B connection is replaced after unanswered checks without disturbing responsive A or its draft', async () => {
  const h = harness(); await h.bothReady();
  h.run(`text.value='keep current draft';saveDraft()`);
  const before = h.state(), a = h.link(0).socket, b = h.link(1).socket;
  for (let n = 0; n < 4; n++) { await h.advance(15000); h.deliver(0, { t: 'pong' }); }
  assert.equal(a.readyState, 1); assert.equal(b.readyState, 3);
  assert.equal(h.link(1).socket.readyState, 0);
  assert.equal(h.link(1).retryFailures, 0);
  assert.deepEqual(h.state(), before);
  assert.equal(a.sent.some(m => m.t === 'send'), false);
});

test('an authenticated transport loss gets one immediate attempt and three failed attempts pause further retries', async () => {
  const h = harness({ count: 1 }); await h.start(); h.attached(0);
  const original = h.link(0).socket;
  original.close(1006); await h.advance(0);
  assert.notEqual(h.link(0).socket, original);
  assert.equal(h.link(0).socket.readyState, 0);
  for (let failed = 1; failed <= 3; failed++) {
    h.link(0).socket.close(1006); await h.settle();
    assert.equal(h.link(0).retryFailures, failed);
    if (failed < 3) await h.advance(8000);
  }
  assert.equal(h.link(0).phase, 'paused');
  const count = h.sockets.length;
  await h.advance(120000);
  assert.equal(h.sockets.length, count);
});

test('old socket messages and close callbacks cannot reject or disconnect a newer connection', async () => {
  const h = harness(); await h.bothReady();
  const old = h.link(1).socket;
  old.close(1006); await h.advance(0);
  await h.open(1); h.attached(1);
  const current = h.link(1).socket;
  old.receive({ t: 'auth', ok: false, id: h.records[1].id });
  old.close(4002); await h.settle();
  assert.equal(h.link(1).socket, current); assert(h.link(1).authed);
  assert.equal(h.link(1).retry, null);
});

test('authorization rejection, mismatched identity and ownership transfer stop automatic reconnects', async () => {
  for (const kind of ['auth', 'identity', 'replaced']) {
    const h = harness(); await h.bothReady();
    if (kind === 'replaced') h.link(1).socket.close(4002);
    else h.deliver(1, { t: 'auth', ok: kind === 'identity', id: kind === 'identity' ? 'wrong-computer' : h.records[1].id });
    await h.settle();
    const count = h.sockets.length;
    h.run('resumeComputerConnections();heartbeat()');
    await h.advance(60000);
    assert.equal(h.sockets.filter(s => s.url.includes('relay-b')).length, 1);
    assert.equal(h.link(1).phase, kind);
    assert(count <= h.sockets.length);
  }
});

test('HTTP snapshot failures do not override a healthy realtime connection or its retry count', async () => {
  const h = harness(); await h.bothReady();
  h.run(overview.slice(overview.indexOf('function ovComputerStatus('), overview.indexOf('function ovStOf(')));
  h.run(`const st=ovStOf(loadComputers()[0].id);st.dataStatus='offline';st.data={ready:true}`);
  assert.equal(h.run('ovComputerStatus(ovList[0])'), 'online');
  assert.equal(h.link(0).retryFailures, 0);
});

test('foreground reconnection preserves its initialization generation and skips address discovery when the saved endpoint works', async () => {
  const h = harness(); await h.bothReady();
  h.run(`text.value='recovery draft';saveDraft();var discoveries=[];fetch=async url=>{discoveries.push(url);return{ok:true,json:async()=>({v:3,computers:[]})}}`);
  const before = h.state();
  h.link(0).socket.close(1006); await h.advance(0);
  assert.equal(h.state().bootCalls, before.bootCalls);
  assert.equal(h.state().generation, before.generation);
  assert.equal(h.state().draft, before.draft);
  assert.equal(h.run('discoveries.length'), 0);
  assert(!h.state().windowReady);
  await h.open(0); h.attached(0); await h.settle();
  assert(h.state().windowReady);
  assert.equal(h.run('discoveries.length'), 0);
  assert.equal(h.link(0).attempt, null);
});

test('a connection attempt remains shared through authentication and binding without waiting for an HTTP snapshot', async () => {
  const h = harness(); await h.bothReady();
  h.run('ovFetch=()=>new Promise(()=>{})');
  h.link(1).socket.close(1006); await h.advance(0);
  const first = h.run(`reconnectComputer(loadComputers()[1].id,'auto')`);
  assert.equal(h.run(`reconnectComputer(loadComputers()[1].id,'resume')`), first);
  const count = h.sockets.length;
  await h.open(1);
  assert.equal(h.run(`reconnectComputer(loadComputers()[1].id,'auto')`), first);
  assert.equal(h.sockets.length, count);
  h.attached(1); await first;
  assert.equal(h.link(1).attempt, null);
  assert(h.link(1).authed);
});

test('a failed saved endpoint refreshes only that computer address and authenticates its replacement once', async () => {
  const h = harness(); await h.bothReady();
  const a = h.link(0).socket;
  h.run(`var discoveries=[];fetch=async url=>{discoveries.push(url);return{ok:true,json:async()=>({v:3,computers:[]})}};resolveBase=async()=> 'https://relay-b-new.invalid'`);
  h.link(1).socket.close(1006); await h.advance(0);
  h.link(1).socket.close(1006); await h.settle(); await h.settle();
  assert.equal(h.link(1).socket.url, 'wss://relay-b-new.invalid/ws');
  assert.equal(h.run('discoveries.length'), 1);
  assert.equal(h.link(1).retryFailures, 0);
  assert.equal(h.link(0).socket, a); assert.equal(a.readyState, 1);
  await h.open(1); h.attached(1); await h.settle();
  const auth = h.link(1).socket.sent.filter(m => m.t === 'auth');
  assert.equal(auth.length, 1); assert.equal(auth[0].token, h.records[1].token);
  assert(h.link(1).authed);
  assert.equal(h.link(1).attempt, null);
});

test('an offline phone does not reconnect or add failures until a lifecycle event reports it online', async () => {
  const h = harness(); await h.bothReady();
  h.run('navigator.onLine=false'); h.link(0).socket.close(1006);
  const count = h.sockets.length;
  await h.advance(60000); h.run('resumeComputerConnections()');
  assert.equal(h.sockets.length, count); assert.equal(h.link(0).retryFailures, 0);
  const restoring = h.run('navigator.onLine=true;resumeComputerConnections()'); await h.settle();
  assert.equal(h.sockets.length, count + 1);
  await h.open(0); h.attached(0); await restoring;
  assert(h.state().authed);
});

test('an authorization close blocks sending and automatic recovery until explicit authorization', async () => {
  const h = harness(); await h.bothReady();
  h.link(0).socket.close(4001); await h.advance(0);
  assert.equal(h.link(0).phase, 'auth'); assert(!h.state().authed); assert(!h.state().windowReady);
  const count = h.sockets.length;
  h.run('resumeComputerConnections()'); await h.advance(8000);
  assert.equal(h.sockets.length, count);
});

function useOverviewReads(h) {
  h.run(overview.slice(overview.indexOf('function ovFetch('), overview.indexOf('function ovApply(')));
  h.run('ovApply=(e,st,data)=>{st.data=data}');
}

test('a failed overview HTTP request records only a data error and does not start discovery or reconnect', async () => {
  const h = harness(); await h.bothReady(); useOverviewReads(h);
  h.run(`ovRead=async()=>({down:true});ovStOf(loadComputers()[0].id).data={ready:true}`);
  const socket = h.link(0).socket, count = h.sockets.length;
  await h.run('ovFetch(ovList[0])');
  assert.equal(h.link(0).socket, socket); assert(h.link(0).authed);
  assert.equal(h.link(0).retryFailures, 0); assert.equal(h.sockets.length, count);
  assert.equal(h.run('ovStOf(loadComputers()[0].id).dataStatus'), 'offline');
});

test('HTTP rejection from an old socket cannot revoke a newer authenticated connection', async () => {
  const h = harness(); await h.bothReady(); useOverviewReads(h);
  h.run('var pendingReads=[];ovRead=()=>new Promise(resolve=>{pendingReads.push(resolve)})');
  const reading = h.run('ovLoad(ovList[0],ovStOf(ovList[0].id))');
  h.link(0).socket.close(1006); await h.advance(0);
  await h.open(0); h.attached(0); await h.settle();
  h.run('pendingReads[0]({auth:true})'); await reading;
  assert(h.link(0).authed); assert(h.state().authed);
});

test('a current HTTP authorization rejection or identity mismatch ends only that computer connection', async () => {
  for (const response of [{ auth: true }, { data: { id: 'wrong-computer' } }]) {
    const h = harness(); await h.bothReady(); useOverviewReads(h);
    const a = h.link(0).socket;
    h.run(`ovRead=async()=>(${JSON.stringify(response)})`);
    await h.run('ovFetch(ovList[1])');
    assert.equal(h.link(1).phase, response.auth ? 'auth' : 'identity');
    assert.equal(h.link(1).socket.readyState, 3); assert.equal(h.link(1).retry, null);
    assert.equal(h.link(0).socket, a); assert(h.state().authed);
  }
});

test('a paused computer gets one lifecycle probe, while an explicit manual retry starts a fresh attempt round', async () => {
  const h = harness(); await h.bothReady();
  h.run(`const link=computerSockets.get(loadComputers()[1].key);link.phase='paused';link.retryFailures=3;link.socket.readyState=3`);
  const first = h.run('resumeComputerConnections()');
  h.run('resumeComputerConnections()'); await h.settle();
  const count = h.sockets.length;
  assert(h.link(1).retryProbe);
  h.link(1).socket.close(1006); await h.settle(); await h.settle(); await first;
  assert.equal(h.link(1).phase, 'paused'); assert.equal(h.link(1).retry, null);
  await h.advance(16000); assert.equal(h.sockets.length, count);
  const manual = h.run('reconnectComputer(loadComputers()[1].id)'); await h.settle();
  assert.equal(h.link(1).retryFailures, 0); assert.equal(h.link(1).retryProbe, false);
  await h.open(1); h.attached(1); await manual;
  assert(h.link(1).authed); assert(h.link(0).authed);
});

test('a proof failure belonging to an old socket cannot overwrite a replacement connection', async () => {
  const h = harness({ count: 1 });
  h.run('var failOldProof;entryProof=()=>new Promise((resolve,reject)=>{failOldProof=reject})');
  const link = await h.run('openComputerSocket(currentComputer(),currentComputer().relay)');
  const old = link.socket, opening = old.open();
  old.close(1006);
  h.run('entryProof=async()=>"test-proof"'); await h.advance(8000);
  await h.open(0); h.attached(0); await h.settle();
  const replacement = h.link(0).socket;
  h.run('failOldProof(new Error("old proof failure"))'); await opening;
  assert.equal(h.link(0).socket, replacement); assert(h.link(0).authed);
  assert.equal(h.link(0).error, ''); assert.equal(replacement.readyState, 1);
});
