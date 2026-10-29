import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const net = read('app/js/net.js');
const notify = read('app/js/notify.js');
const core = read('app/js/core.js');
const composer = read('app/js/composer.js');
const computers = ['a', 'b'].map(name => ({
  id: name.repeat(16), key: 'key-' + name, token: 'token-' + name,
  relay: 'https://relay-' + name + '.invalid', win: 'codex',
  windowId: 'window-' + name, threadId: 'thread-' + name,
}));

function harness({ sameSelection = false } = {}) {
  const records = structuredClone(computers);
  if (sameSelection) Object.assign(records[1], { windowId: records[0].windowId, threadId: records[0].threadId });
  const stored = new Map([
    ['computers', JSON.stringify(records)], ['computer', records[0].id],
    ['key', records[0].key], ['token', records[0].token],
  ]);
  const elements = new Map(), sockets = [], timers = new Map(), trace = [];
  let timerId = 0;
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
    close() { this.readyState = 3; return this.onclose?.({ code: 1000 }); }
  }
  const context = vm.createContext({
    URL, URLSearchParams, AbortSignal, Event, crypto, structuredClone,
    WebSocket: FakeWebSocket,
    location: { href: 'https://phone.invalid/', origin: 'https://phone.invalid', pathname: '/', hash: '', search: '' },
    history: { replaceState() {} }, navigator: { userAgent: 'test' },
    sessionStorage: { getItem: () => null, removeItem() {} },
    store: { get: key => stored.get(key) ?? null, set: (key, value) => value == null ? stored.delete(key) : stored.set(key, value) },
    document: { visibilityState: 'visible', activeElement: null, documentElement: { dataset: { theme: 'dark' } }, dispatchEvent() {} },
    $: element,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => ++timerId, clearInterval() {},
    requestAnimationFrame: fn => { const id = ++timerId; timers.set(id, { fn, ms: 0 }); return id; },
    fetch: async () => ({ ok: true, json: async () => ({ v: 3, computers: [] }) }),
    entryProof: async () => 'test-proof', legacyAgentLibrary: () => [], trace,
  });
  context.window = context;
  context.addEventListener = () => {};
  const run = source => vm.runInContext(source, context);
  run(`
    var base = null, info = null, ws = null, authed = false, failures = 0;
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
    var conn = { active: false, host: false, open: new Set(), loaded: false, timer: 0 };
    var thoughtObserver = { disconnect() {} }, chatPreviewReady = Promise.resolve(), I18N = { lang: 'zh', tr: value => value };
    function status(value) { pendingStatus = value; trace.push(['status', value]); }
    function connShow(value) { conn.active = true; trace.push(['loading', value]); $('conn').classList.add('open'); }
    function connHide() { conn.active = false; $('conn').classList.remove('open'); }
    function gate() { $('gate').classList.add('open'); }
    function ungate() { $('gate').classList.remove('open'); }
    function connHostOk() { conn.host = true; }
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
    var bootCalls = 0;
  `);
  for (const name of [
    'resetLatency', 'finishPending', 'failFileRead', 'waitFileSave', 'cancelChatContentRequests',
    'interruptSessionBatch', 'cancelCodexAutoRetry', 'markUploadsDisconnected', 'disconnectPendingSends',
    'updateAppText', 'updateTitle', 'invalidateChatRender', 'beginChatSelection', 'endInputRecall',
    'mentionHide', 'autosize', 'rememberAgentOpen', 'requestCompatibility', 'scheduleLatency',
    'renderContext', 'renderQuota', 'renderQuestions', 'connWindows', 'paintRail', 'checkAppUpdate',
  ]) context[name] = () => {};
  run(net);
  run(core.slice(core.indexOf('function desktopAction(obj)'), core.indexOf('\n\n', core.indexOf('function setWindowReady(ready)'))));
  run(composer.slice(composer.indexOf('function draftKey()'), composer.indexOf('function autosize()')));
  run(notify.slice(notify.indexOf('async function useComputer(i)'), notify.indexOf('async function removeComputer(i)')));
  run('var realBoot = boot; boot = function() { bootCalls++; return realBoot(); };');
  const state = () => JSON.parse(run(`JSON.stringify({ computer:currentComputer().id, authed, windowReady, selectionReady,
    thread:lastChat?.thread, body:lastChat?.items?.[0]?.t, chatStale, viewSel, draft:text.value, epoch:draftEpoch,
    revision:draftRevision, activeDraft, bootCalls, loading:conn.active, generation:bootGeneration })`));
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const link = i => run(`computerSockets.get(loadComputers()[${i}].key)`);
  async function open(i) {
    const result = await run(`openComputerSocket(loadComputers()[${i}], loadComputers()[${i}].relay)`);
    await result.socket.open();
    result.socket.receive({ t: 'auth', ok: true, id: records[i].id, name: 'computer-' + i, lastSelection: {
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
  async function bothReady() {
    await open(0); await run('connect()'); attached(0);
    await open(1);
    await switchTo(1); attached(1);
    await switchTo(0);
    trace.length = 0;
    for (const socket of sockets) socket.sent.length = 0;
  }
  function flushDraft() {
    const pending = [...timers].filter(([, timer]) => timer.ms === 400);
    for (const [id, timer] of pending) { timers.delete(id); timer.fn(); }
  }
  return { run, state, settle, link, open, attached, deliver, switchTo, bothReady, records, trace, sockets, flushDraft };
}

test('ready computer switches onto its existing session and can send immediately without boot/auth/attach', async () => {
  const h = harness(); await h.bothReady();
  const boots = h.state().bootCalls, socket = h.link(1).socket;
  await h.switchTo(1);
  const state = h.state();
  assert.equal(state.computer, computers[1].id); assert.equal(state.thread, 'thread-b');
  assert(state.authed && state.windowReady && state.selectionReady && !state.chatStale);
  assert.equal(state.bootCalls, boots); assert.equal(state.loading, false);
  assert.equal(h.trace.some(row => row[0] === 'loading'), false);
  assert.equal(h.trace.some(row => row[0] === 'preview'), false);
  assert.equal(socket.sent.some(row => ['auth', 'attach', 'mode'].includes(row.t)), false);
  h.run(`send({t:'send',text:'to computer B',submit:true})`);
  assert.equal(socket.sent.at(-1).t, 'send');
  assert.equal(socket.sent.at(-1).sel, 'codex|window-b|thread-b');
  assert.equal(h.link(0).socket.sent.some(row => row.t === 'send'), false);
});

test('a first-screen request completed after parking can be adopted without another load', async () => {
  const h = harness(); await h.open(0); await h.run('connect()'); h.attached(0);
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

test('an authenticated background socket with only agent metadata still performs actual initial loading', async () => {
  const h = harness(); await h.open(0); await h.run('connect()'); h.attached(0); await h.open(1);
  const boots = h.state().bootCalls;
  await h.switchTo(1);
  assert.equal(h.state().bootCalls, boots + 1);
  assert.equal(h.state().windowReady, false);
  assert(h.link(1).socket.sent.some(row=>row.t==='attach'));
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
