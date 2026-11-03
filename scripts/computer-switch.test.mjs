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
    document: Object.assign(new EventTarget(), { visibilityState: 'visible', activeElement: null, documentElement: { dataset: { theme: 'dark' } } }),
    $: element,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms, at: now + ms, repeat: true }); return id; },
    clearInterval: id => timers.delete(id),
    requestAnimationFrame: fn => { const id = ++timerId; timers.set(id, { fn, ms: 0, at: now }); return id; },
    fetch: async () => ({ ok: true, json: async () => ({ v: 3, computers: [] }) }),
    receiveFusion: () => false, receiveTerminal: () => false, entryProof: async () => 'test-proof', legacyAgentLibrary: () => [], trace,
  });
  context.window = context;
  context.addEventListener = () => {};
  const run = source => vm.runInContext(source, context);
  run(`
    var base = null, info = null, ws = null, authed = false;
    var mode = 'chat', windowReady = false, connGen = 0, usageTimer = 0;
    var currentApp = 'codex', currentAppName = 'Codex', currentWindow = 'codex', viewSel = '', currentProject = '', currentTerminalId = '';
    var windows = [], appPlans = {}, sheetKind = '', pendingStatus = '', qnSig = '', inApp = false;
    var capabilityOwner = '', agentCapabilities = null, capabilityBlock = '';
    var menuRequest = 0, menuPending = null, menuPickRequest = 0, modelSwitchRequest = null;
    var docsRequest = 0, docsPending = null, projectEntry = null, codexSettingsRequest = 0;
    var draftEpoch = '', draftRevision = 0, draftAckRevision = 0, pendingDesktopDraft = null, mirroredDraft = '';
    var activeDraft = '', draftPushTimer = 0, questionCompose = null, composing = false, inputRevision = 0;
    var drafts = new Map(), draftMentions = new Map(), dirtyDrafts = new Set(), draftVersions = new Map();
    var pendingSends = new Map(), pendingEchoes = [], desktopRequests = new Map(), MN = { mentions: [], value: '' }, desktopAttachments = [];
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
    'renderContext', 'renderQuota', 'renderQuestions', 'paintRail', 'checkAppUpdate', 'terminalDisconnected',
  ]) context[name] = () => {};
  context.resumeTerminal = () => trace.push(['terminal-resume', run('currentComputer().id')]);
  context.conversationVisible = () => true;
  const projectSheets = read('app/js/sheets.js');
  run(projectSheets.slice(projectSheets.indexOf('function projectSheet('), projectSheets.indexOf('function showProjects(')));
  run(core.slice(core.indexOf('function requestAgentCatalog()'), core.indexOf('function openAgentList(')));
  run(gate.slice(gate.indexOf('function newComputerConnection('), gate.indexOf('const connLaunchStatus')));
  run(gate.slice(gate.indexOf('function connReadFailed('), gate.indexOf('function connRetryCurrent(')));
  run(net);
  run(core.slice(core.indexOf('function desktopAction(obj)'), core.indexOf('\n\n', core.indexOf('function setWindowReady(ready)'))));
  context.mentionsFor = () => ({});
  run(composer.slice(composer.indexOf('function composerSendMatches('), composer.indexOf('function sendReceipt(')));
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

function useSendReceipts(h) {
  h.run(`var queuedChat = null, submittedMessages = [], inputHistory = new Map();
    function messageScope() { return currentComputer().id + '|' + viewSel; }
    queueChatRender = () => {};`);
  h.run(composer.slice(composer.indexOf('function echoTextMatches('), composer.indexOf('function pushEcho(')));
  h.run(composer.slice(composer.indexOf('function sendReceipt('), composer.indexOf('function failPendingSend(')));
}

test('an in-flight draft stays on its computer after another computer edits its own draft', async () => {
  const h = harness(); await h.bothReady(); useSendReceipts(h);
  const a = h.run(`text.value='draft A';saveDraft();sendReceipt(text.value)`);
  assert.equal(h.run("$('send').disabled"), true);
  await h.switchTo(1);
  assert.equal(h.run("$('send').disabled"), false);
  h.run(`text.value='draft B';recordDraftEdit()`);
  await h.switchTo(0);
  assert.equal(h.state().draft, 'draft A'); assert.equal(h.run("$('send').disabled"), true);
  h.run('setWindowReady(true)'); assert.equal(h.run("$('send').disabled"), true);
  h.run(`confirmSent({requestId:${JSON.stringify(a.requestId)},sel:viewSel})`);
  assert.equal(h.state().draft, ''); assert.equal(h.run("$('send').disabled"), false);
});

test('a late receipt from A does not clear or release the in-flight draft on B', async () => {
  const h = harness(); await h.bothReady(); useSendReceipts(h);
  const a = h.run(`text.value='draft A';saveDraft();sendReceipt(text.value)`);
  const selA = h.state().viewSel;
  await h.switchTo(1);
  const b = h.run(`text.value='draft B';recordDraftEdit();sendReceipt(text.value)`);
  h.run(`confirmSent({requestId:${JSON.stringify(a.requestId)},sel:${JSON.stringify(selA)}})`);
  assert.equal(h.state().draft, 'draft B'); assert.equal(h.run("$('send').disabled"), true);
  assert.equal(h.run('pendingSends.size'), 1);
  h.run(`confirmSent({requestId:${JSON.stringify(b.requestId)},sel:viewSel})`);
  assert.equal(h.state().draft, ''); assert.equal(h.run("$('send').disabled"), false);
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

for (const probe of [false, true]) test(`foreground recovery queued during a ${probe ? 'probe' : 'startup'} batch is replayed once after its first screens finish`, async () => {
  const h = harness({ count: 3 }); await h.start(); h.attached(0);
  await h.run('openComputerSocket(loadComputers()[1],loadComputers()[1].relay)');
  await h.open(2);
  const batch = h.run(`warmComputerSockets(${probe})`); await h.settle();
  h.link(1).socket.close(1006); await h.settle();
  h.run('document.visibilityState="hidden";suspendComputerConnections()'); h.jump(1000);
  h.run('document.visibilityState="visible";resumeComputerConnections();resumeComputerConnections()'); await h.settle();
  assert.equal(h.link(1).lastClose.reconnect, undefined);
  assert.equal(h.sockets.filter(socket => socket.url.includes('relay-b')).length, 1);
  h.attached(2); await h.settle(); await h.settle();
  assert.equal(h.sockets.filter(socket => socket.url.includes('relay-b')).length, 2);
  assert.equal(h.link(1).lastClose.reconnect.source, 'resume');
  assert.equal(h.link(1).phase, 'connecting');
  assert(h.state().authed && h.state().windowReady);
  await h.open(1); h.attached(1); await batch; await h.settle();
  assert.equal(h.link(1).attempt, null); assert.equal(h.link(1).retry, null);
  assert.equal(h.sockets.filter(socket => socket.url.includes('relay-b')).length, 2);
  for (const i of [0, 1, 2]) assert(h.link(i).authed);
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

test('terminal mode reuses an authenticated computer without treating chat as terminal content', async () => {
  const h = harness(); await h.bothReady(); h.run(`mode='terminal'`);
  const boots = h.state().bootCalls;
  await h.switchTo(1);
  assert.equal(h.state().bootCalls, boots);
  assert(h.trace.some(row => row[0] === 'terminal-resume' && row[1] === h.records[1].id));
  assert.equal(h.link(1).socket.sent.some(row => row.t === 'attach'), false);
  assert(h.link(1).socket.sent.some(row => row.t === 'mode' && row.mode === 'terminal'));
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
  h.run(`text.value='keep A';saveDraft();overviewFetches=[];`);
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

test('hidden events keep the original background start and a relay expiration never reconnects while hidden', async () => {
  const h = harness(); await h.bothReady();
  const sockets = [...h.sockets];
  h.run('document.visibilityState="hidden";suspendComputerConnections()');
  const started = h.run('computerBackgroundAt');
  await h.advance(150000); h.run('suspendComputerConnections()');
  assert.equal(h.run('computerBackgroundAt'), started);
  await h.advance(149999);
  for (const socket of sockets) assert.equal(socket.readyState, 1);
  await h.advance(1);
  for (const socket of sockets) socket.close(4000);
  for (const socket of sockets) assert.equal(socket.readyState, 3);
  const count = h.sockets.length;
  await h.advance(60000); assert.equal(h.sockets.length, count);
});

test('returning within five minutes keeps the existing connections and cancels the background deadline', async () => {
  const h = harness(); await h.bothReady(); const sockets = [...h.sockets];
  h.run('document.visibilityState="hidden";suspendComputerConnections()'); await h.advance(299999);
  h.run('document.visibilityState="visible";resumeComputerConnections()'); await h.settle();
  assert.equal(h.run('computerBackgroundAt'), null);
  for (const [i, socket] of sockets.entries()) {
    assert.equal(h.link(i).socket, socket); assert.equal(socket.readyState, 1);
    assert.equal(socket.sent.findLast(m => m.t === 'visible').background, false);
    assert.equal(socket.sent.filter(m => m.t === 'auth' || m.t === 'attach').length, 0);
  }
});

test('returning after a frozen five-minute background closes old sockets before reconnecting and verifying', async () => {
  const h = harness(); await h.bothReady(); const old = [...h.sockets];
  h.run('document.visibilityState="hidden";suspendComputerConnections()'); h.jump(300001);
  h.run('document.visibilityState="visible";resumeComputerConnections()'); await h.settle();
  for (const [i, socket] of old.entries()) {
    assert.equal(socket.readyState, 3); assert.notEqual(h.link(i).socket, socket); assert.equal(h.link(i).authed, false);
  }
  assert.equal(h.state().windowReady, false);
  await h.open(0); assert.equal(h.link(0).socket.sent.find(m => m.t === 'auth').proof, 'test-proof');
});

test('a transport loss while hidden waits until foreground before reconnecting', async () => {
  const h = harness(); await h.bothReady();
  h.run('document.visibilityState="hidden";suspendComputerConnections()');
  const count = h.sockets.length; h.link(1).socket.close(1006); await h.advance(5000);
  assert.equal(h.sockets.length, count);
  h.run('document.visibilityState="visible";resumeComputerConnections()'); await h.settle();
  assert.equal(h.sockets.length, count + 1); assert.equal(h.link(1).phase, 'connecting');
});

test('an authentication wait timeout remains retryable and an actual authorization rejection remains stopped', async () => {
  for (const code of [4000, 4001]) {
    const h = harness({ count: 1 });
    await h.run('openComputerSocket(currentComputer(),currentComputer().relay)'); await h.link(0).socket.open();
    h.link(0).socket.close(code); await h.settle();
    h.run('resumeComputerConnections()'); await h.settle();
    assert.equal(h.sockets.length, code === 4000 ? 2 : 1);
    assert.equal(h.link(0).phase, code === 4000 ? 'connecting' : 'auth');
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

test('a hidden current-computer close retains its foreground, reconnect, auth and binding milestones after recovery', async () => {
  const h = harness({ count: 1 }); await h.start(); h.attached(0);
  h.run(`text.value='private diagnostic draft';saveDraft();document.visibilityState='hidden';suspendComputerConnections()`);
  h.jump(1000); h.link(0).socket.close(1006); await h.settle();
  const record = h.link(0).lastClose;
  assert.equal(record.closed.visibility, 'hidden'); assert.equal(record.closed.backgroundAt, 100000);
  assert.equal(record.closed.current, true); assert.equal(record.closed.authed, true); assert.equal(record.closed.activeAuthed, true);
  assert.equal(record.closed.code, 1006); assert.equal(record.closed.source, 'transport'); assert.equal(record.closed.socketState, 3);
  assert.equal(h.state().authed, false);
  await h.advance(4000); assert.equal(h.sockets.length, 1); assert.equal(record.reconnect, undefined);
  const restoring = h.run(`document.visibilityState='visible';resumeComputerConnections()`); await h.settle();
  assert.equal(record.foreground.at, 105000); assert.equal(record.foreground.activeAuthed, false);
  assert.equal(record.reconnect.source, 'resume'); assert.equal(record.socket.socketState, 0);
  await h.open(0); assert.equal(h.link(0).failure, null); assert(record.authenticated); assert.equal(record.ready, undefined);
  h.attached(0); await restoring;
  assert(record.ready); assert.equal(h.link(0).lastClose, record); assert(h.state().windowReady);
  assert.equal(h.state().draft, 'private diagnostic draft');
  const json = JSON.stringify(record);
  for (const privateValue of [h.records[0].key, h.records[0].token, 'private diagnostic draft', h.records[0].relay]) assert(!json.includes(privateValue));
});

test('foreground close records the existing immediate automatic retry without inventing a foreground event', async () => {
  const h = harness({ count: 1 }); await h.start(); h.attached(0);
  h.run(`document.visibilityState='hidden';suspendComputerConnections();document.visibilityState='visible';resumeComputerConnections()`);
  h.link(0).socket.close(1006); const record = h.link(0).lastClose;
  assert.equal(record.closed.visibility, 'visible'); assert.equal(record.closed.backgroundAt, null);
  assert.equal(record.foreground, undefined);
  await h.advance(0); assert.equal(record.reconnect.source, 'auto'); assert(record.socket);
  await h.open(0); h.attached(0); await h.settle(); assert(record.ready);
});

test('five-minute foreground expiry records the original background deadline without changing reconnection', async () => {
  const h = harness({ count: 1 }); await h.start(); h.attached(0);
  h.run(`document.visibilityState='hidden';suspendComputerConnections()`); h.jump(300001);
  const restoring = h.run(`document.visibilityState='visible';resumeComputerConnections()`); await h.settle();
  const record = h.link(0).lastClose;
  assert.equal(record.closed.source, 'background'); assert.equal(record.closed.backgroundAt, 100000);
  assert.equal(record.closed.at - record.closed.backgroundAt, 300001); assert.equal(record.reconnect.source, 'resume');
  await h.open(0); h.attached(0); await restoring;
  assert.equal(h.link(0).lastClose, record); assert.equal(record.authenticated.resumed, false); assert(record.ready);
});

test('completed diagnostics remain stable and only the newest current socket close replaces the record', async () => {
  const h = harness({ count: 1 }); await h.start(); h.attached(0);
  const old = h.link(0).socket; old.close(1006); await h.advance(0); await h.open(0); h.attached(0); await h.settle();
  const record = h.link(0).lastClose, before = JSON.stringify(record);
  h.run('resumeComputerConnections();resumeComputerConnections()'); h.deliver(0, { t: 'pong' }); old.close(4002);
  assert.equal(JSON.stringify(record), before);
  h.link(0).socket.close(1006);
  assert.notEqual(h.link(0).lastClose, record); assert.deepEqual(Object.keys(h.link(0).lastClose), ['closed']);
});

test('retaining diagnostics never starts recovery for a rejected or replaced computer', async () => {
  for (const code of [4001, 4002]) {
    const h = harness({ count: 1 }); await h.start(); h.attached(0); h.link(0).socket.close(code);
    h.run('resumeComputerConnections()'); await h.advance(8000);
    const record = h.link(0).lastClose;
    assert.equal(record.closed.code, code); assert(record.foreground); assert.equal(record.reconnect, undefined);
    assert.equal(record.authenticated, undefined); assert.equal(h.sockets.length, 1);
  }
});

test('connection details show only the requested computer history after auth clears the current failure', async () => {
  const h = harness(); await h.bothReady(); h.link(1).socket.close(1006); await h.advance(0);
  await h.open(1); h.attached(1); await h.settle(); assert.equal(h.link(1).failure, null);
  const sheets = read('app/js/sheets.js'), esc = core.slice(core.indexOf('const esc ='), core.indexOf('\n', core.indexOf('const esc ='))).replace('const esc =', 'esc =');
  h.run(esc + `\nvar sheetHtml='';openSheet=(kind,html)=>{sheetKind=kind;sheetHtml=html};`);
  h.run(sheets.slice(sheets.indexOf('function connectionHistoryText('), sheets.indexOf('function showAgentManager(')));
  h.run(`showConnectionDetails(loadComputers()[0].id)`); assert(!h.run('sheetHtml').includes('data-connection-history'));
  h.link(1).lastClose.closed.source = '<test-source>';
  h.run(`showConnectionDetails(loadComputers()[1].id)`);
  const html = h.run('sheetHtml');
  assert(html.includes('最近一次关闭与恢复')); assert(html.includes('1006')); assert(html.includes('认证成功')); assert(html.includes('会话可用'));
  assert(html.includes('&lt;test-source&gt;')); assert(!html.includes('<test-source>'));
  assert(!html.includes(h.records[1].key)); assert(!html.includes(h.records[1].token));
  assert(h.state().authed); assert.equal(h.state().computer, h.records[0].id); assert.equal(h.link(0).lastClose, undefined);
});

test('a ready or partially ready directory is usable while its conversation is still restoring', async () => {
  const h = harness(); await h.bothReady();
  h.run(overview.slice(overview.indexOf('function ovComputerStatus('), overview.indexOf('function ovStOf(')));
  h.run(`conn.initialSelection=true;windowReady=false;var directory=ovStOf(ovList[0].id);directory.data={ready:true}`);
  assert.equal(h.run('ovComputerStatus(ovList[0])'), 'online'); assert.equal(h.state().windowReady, false);
  h.run('directory.data={ready:false,partial:true}');
  assert.equal(h.run('ovComputerStatus(ovList[0])'), 'online');
  h.run('directory.data={ready:false,partial:false}');
  assert.equal(h.run('ovComputerStatus(ovList[0])'), 'loading');
});

test('a valid directory response survives socket replacement for the same computer credentials', async () => {
  const h = harness(); await h.bothReady(); useOverviewReads(h);
  h.run('var directoryReads=[];ovRead=()=>new Promise(resolve=>directoryReads.push(resolve))');
  const reading = h.run('ovFetch(ovList[0])');
  h.link(0).socket.close(1006); await h.advance(0); await h.open(0); h.attached(0); await h.settle();
  assert.equal(h.run('directoryReads.length'), 1);
  h.run(`directoryReads[0]({data:{id:ovList[0].id,now:Date.now(),ready:true}})`); await reading;
  assert.equal(h.run('ovStOf(ovList[0].id).data.ready'), true); assert(h.link(0).authed);
});

test('directory results from revoked credentials cannot update the replacement pairing', async () => {
  const h = harness(); await h.bothReady(); useOverviewReads(h);
  const before = h.run('ovStOf(ovList[0].id).data');
  h.run('var resolveDirectory;ovRead=()=>new Promise(resolve=>resolveDirectory=resolve)');
  const reading = h.run('ovFetch(ovList[0])');
  h.run(`const rows=loadComputers();rows[0]={...rows[0],token:'replacement'};saveComputers(rows,rows[0].key);resolveDirectory({data:{id:ovList[0].id,now:Date.now(),ready:true}})`);
  await reading;
  assert.equal(h.run('ovStOf(ovList[0].id).data'), before);
});

function installOverviewOpening(h) {
  h.run(`var ovOpenRequest=0, ovEnterRequested=false, ovS={}, pendingAgentOpen='';
    function ovSaveHistory() {} function ovT(value) { return value; }
    function ovShowConversation() { trace.push(['enter',currentComputer().id,lastChat?.thread]); }`);
  h.run(notify.slice(notify.indexOf('function noticeTarget('), notify.indexOf('function finishWinBinding(')));
  h.run(notify.slice(notify.indexOf('function openPickedSession('), notify.indexOf("$('sheet').addEventListener('click'")));
  h.run(overview.slice(overview.indexOf('async function ovOpen('), overview.indexOf('function conversationVisible(')));
  h.run(overview.slice(overview.indexOf('function ovConversationOpened('), overview.indexOf('function ovLeave(')));
}

test('Codex cards confirm even the last ready target through one existing session request', async () => {
  for (const same of [true, false]) {
    const h = harness(); await h.bothReady(); installOverviewOpening(h);
    const thread = same ? 'thread-a' : 'thread-a-other';
    await h.run(`ovOpen({computer:loadComputers()[0].id,win:'codex',windowId:'window-a',threadId:${JSON.stringify(thread)}})`);
    const requests = h.link(0).socket.sent.filter(m => ['attach', 'openAgent'].includes(m.t));
    assert.equal(requests.length, 1); assert.equal(requests[0].t, 'openAgent');
    assert.equal(requests[0].id, `thread:window-a:${thread}`);
    assert.equal(h.state().windowReady, false); assert.equal(h.trace.some(row => row[0] === 'enter'), false);
    h.attached(0, { threadId: thread, sel: `codex|window-a|${thread}`, chat: { thread, items: [] } });
    assert.equal(h.state().thread, thread); assert.equal(h.trace.some(row => row[0] === 'enter'), true);
  }
});

test('unready, other-window, project restoration and other-Agent cards retain their normal binding path', async () => {
  for (const kind of ['unready', 'window', 'project', 'cursor']) {
    const h = harness(); await h.bothReady(); installOverviewOpening(h);
    if (kind === 'unready') h.run('windowReady=false');
    await h.run(`ovOpen({computer:loadComputers()[0].id,win:${JSON.stringify(kind === 'cursor' ? 'cursor:window-a' : 'codex')},
      windowId:${JSON.stringify(kind === 'window' ? 'other-window' : 'window-a')},threadId:'thread-a'
      ${kind === 'project' ? ",project:{root:'/project',host:''}" : ''}})`);
    const requests = h.link(0).socket.sent.filter(m => ['attach', 'openAgent'].includes(m.t));
    assert.equal(requests.length, 1); assert.equal(requests[0].t, 'attach');
    assert.equal(h.trace.some(row => row[0] === 'enter'), false);
  }
});

test('a Codex card adopts the destination computer before choosing its same or different conversation', async () => {
  for (const same of [true, false]) {
    const h = harness(); await h.bothReady(); installOverviewOpening(h);
    h.run(`text.value='keep source draft';saveDraft();ovEnterRequested=true`);
    const boots = h.state().bootCalls, sockets = h.sockets.length, thread = same ? 'thread-b' : 'thread-b-other';
    await h.run(`ovOpen({computer:loadComputers()[1].id,win:'codex',windowId:'window-b',threadId:${JSON.stringify(thread)}})`);
    assert.equal(h.state().bootCalls, boots); assert.equal(h.sockets.length, sockets);
    const requests = h.link(1).socket.sent.filter(m => ['auth', 'attach', 'openAgent'].includes(m.t));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].t, 'openAgent'); assert.equal(requests[0].id, `thread:window-b:${thread}`);
    assert.equal(h.state().windowReady, false);
    h.attached(1, { threadId: thread, sel: `codex|window-b|${thread}`, chat: { thread, items: [] } });
    assert.equal(h.state().computer, computers[1].id); assert.equal(h.state().thread, thread);
    assert.equal(h.trace.filter(row => row[0] === 'enter').length, 1);
    await h.switchTo(0); assert.equal(h.state().draft, 'keep source draft');
    assert.equal(h.link(0).socket.sent.some(m => ['attach', 'openAgent'].includes(m.t)), false);
  }
});

test('rapid cross-computer card choices cannot navigate the abandoned destination', async () => {
  const h = harness(); await h.bothReady(); installOverviewOpening(h);
  const boots = h.state().bootCalls;
  const first = h.run(`ovOpen({computer:loadComputers()[1].id,win:'codex',windowId:'window-b',threadId:'abandoned'})`);
  const second = h.run(`ovOpen({computer:loadComputers()[0].id,win:'codex',windowId:'window-a',threadId:'latest'})`);
  await Promise.all([first, second]);
  assert.equal(h.state().computer, computers[0].id); assert.equal(h.state().bootCalls, boots);
  assert.equal(h.link(1).socket.sent.some(m => ['attach', 'openAgent'].includes(m.t)), false);
  const requests = h.link(0).socket.sent.filter(m => ['attach', 'openAgent'].includes(m.t));
  assert.equal(requests.length, 1); assert.equal(requests[0].id, 'thread:window-a:latest');
});

test('an unfinished destination preload is not treated as a ready Codex conversation', async () => {
  const h = harness(); await h.start(); h.attached(0); await h.open(1); installOverviewOpening(h);
  await h.run(`ovOpen({computer:loadComputers()[1].id,win:'codex',windowId:'window-b',threadId:'thread-b-other'})`);
  await h.settle();
  assert.equal(h.state().windowReady, false); assert.equal(h.trace.some(row => row[0] === 'enter'), false);
  assert.equal(h.link(1).socket.sent.some(m => m.t === 'openAgent'), false);
  assert.equal(h.link(1).socket.sent.filter(m => m.t === 'attach').at(-1).threadId, 'thread-b-other');
});
