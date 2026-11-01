import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { beginOperation, captureOperation, withOperation, subscribeOperations, currentOperation } from '../server/operations.mjs';
import { PAGE_SRC } from '../server/page/build.mjs';
import { FOCUS_COMPOSER } from '../server/agent/context.mjs';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const part = (source, start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, start);
  return source.slice(a, b);
};

function nativePage(document, extra = {}, expose = '') {
  const source = PAGE_SRC.replace('  return { historyAtStart,', `  return { ${expose ? expose + ',' : ''} historyAtStart,`);
  return vm.runInNewContext(source, { document, window: {}, crypto: crypto.webcrypto, CSS: { escape: value => value }, ...extra });
}

function nativeNode(attributes = {}, properties = {}, visible = true) {
  return {
    getAttribute: key => attributes[key] ?? null,
    hasAttribute: key => key in attributes,
    getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, bottom: visible ? 20 : 0, right: visible ? 40 : 0, width: visible ? 40 : 0, height: visible ? 20 : 0 }),
    querySelectorAll: () => [], querySelector: () => null, closest: () => null, matches: () => false,
    contains(other) { return this === other; },
    ...properties,
  };
}

function fiber(element, props) {
  element.__reactFiberFixture = props.reduceRight((parent, memoizedProps) => ({ memoizedProps, return: parent }), null);
  return element;
}

for (const label of ['Recent chats', '最近聊天', '最近のチャット', 'واجهة محلية']) {
  test(`Codex native providers retain query, route and history ownership with label ${label}`, async () => {
    const routes = [], scope = { familyBindings: new Map() }, staleScope = { familyBindings: new Map() };
    const query = { getQueryData: () => [] }, router = { navigate: path => routes.push(path) };
    const root = fiber(nativeNode(), [{ value: query }, { value: { router } }, { value: new Map([['scope', scope]]) }]);
    const hidden = fiber(nativeNode({}, {}, false), [{ value: { getQueryData() {} } }, { value: new Map([['scope', staleScope]]) }]);
    const button = nativeNode({ 'aria-label': label });
    const doc = {
      getElementById: () => null,
      querySelectorAll: selector => selector === '[data-composer-body]' ? [hidden, root] : selector === 'button' ? [button] : [],
    };
    const page = nativePage(doc, {}, 'codexRootProps,codexQueryClient,codexHistoryScopes');
    assert.equal(page.codexQueryClient(), query);
    assert.deepEqual([...page.codexHistoryScopes()], [scope]);
    assert.equal(await page.openCodexThread('fixture-thread'), true);
    assert.deepEqual(routes, ['/local/fixture-thread']);
  });
}

for (const label of ['Recent chats. 1 in progress', '最近聊天。1 个处理中']) {
  test(`Codex recent popover uses the native trigger state and content ID: ${label}`, () => {
    const button = nativeNode({ 'aria-label': label }), hidden = nativeNode({ 'aria-label': label }, {}, false);
    const content = nativeNode({}, { querySelectorAll: () => [] });
    const menu = { triggerRef: { current: button }, contentId: 'native-menu', open: false,
      onOpenChange(value) { this.open = value; } };
    fiber(button, [menu]);
    const doc = { getElementById: id => id === 'native-menu' && menu.open ? content : null,
      querySelectorAll: selector => selector === 'button' ? [hidden, button] : [] };
    const page = nativePage(doc, {}, 'codexRecentMenu');
    assert.equal(page.codexRecentPoint().open, false);
    page.codexRecentPoint(true);
    assert.equal(page.codexRecentPoint().open, true);
    assert.equal(page.codexRecentMenu(), content);
    assert.equal(page.closeCodexMenu(), true);
    assert.equal(menu.open, false);
  });
}

for (const busy of [false, true]) {
  test(`Codex busy state uses the native response flag, independently of labels and queue capability: ${busy}`, () => {
    const root = nativeNode(), editor = fiber(nativeNode({}, { closest: selector => selector === '[data-composer-body]' ? root : null }),
      [{ isResponseInProgress: busy, isQueueingEnabled: true }]);
    const doc = { getElementById: () => null, querySelector: () => null,
      querySelectorAll: selector => selector === '.ProseMirror[contenteditable="true"]' ? [editor] : [] };
    const page = nativePage(doc, {}, 'isBusy');
    assert.equal(page.isBusy(), busy);
  });
}

test('a stop button in message content cannot mark an idle Codex composer as running', () => {
  const root = nativeNode(), editor = fiber(nativeNode({}, { closest: () => root }), [{ isResponseInProgress: false }]);
  const message = nativeNode(), stop = nativeNode({ 'aria-label': '停止生成' }, { closest: () => message });
  const doc = { getElementById: () => null,
    querySelectorAll: selector => selector === '.ProseMirror[contenteditable="true"]' ? [editor] : selector === 'button, [role=button]' ? [stop] : [] };
  assert.equal(nativePage(doc, {}, 'isBusy').isBusy(), false);
});

test('Codex follow-up preferences and draft facts come from the visible native add-context control', () => {
  const add = fiber(nativeNode(), [{ activeCollaborationMode: { mode: 'plan' }, hasDraftAttachments: true, isAutoContextOn: false }]);
  const root = fiber(nativeNode(), [{ value: { getQueryData: () => ({ values: { followUpQueueMode: 'queue', composerEnterBehavior: 'newline' } }) } }]);
  const doc = { getElementById: () => null, querySelector: () => null,
    querySelectorAll: selector => selector === '[data-composer-navigation-target="add-context"]' ? [nativeNode({}, {}, false), add]
      : selector === '[data-composer-body]' ? [root] : [] };
  const data = nativePage(doc).codexFacts();
  assert.equal(data.view.follow, 'queue'); assert.equal(data.view.enter, 'newline');
  assert.equal(data.view.plan, true); assert.equal(data.hasDraftAttachments, true);
});

for (const chinese of [false, true]) {
  test(`permissions use native selected icons rather than trigger text, ${chinese ? 'Chinese' : 'English'}`, () => {
    const labels = chinese ? ['请求批准', '帮我批准', '完全访问权限', '自定义 (config.toml)']
      : ['Ask for approval', 'Approve for me', 'Full access', 'Custom (config.toml)'];
    const button = nativeNode({}, { innerText: chinese ? '完全访问' : 'Full access' });
    const rows = labels.map((innerText, i) => fiber(nativeNode({}, { innerText }), [{ RightIcon: i === 2 ? () => {} : undefined }]));
    const doc = { getElementById: () => null,
      querySelectorAll: selector => selector === '[role=menuitem]' ? rows : selector.includes('permissions') ? [nativeNode({}, {}, false), button] : [] };
    const page = nativePage(doc), choices = page.menuItems('permission');
    assert.equal(page.control('permission').x, 20);
    assert.deepEqual(Array.from(choices, row => row.label), labels.slice(0, 3));
    assert.deepEqual(Array.from(choices, row => row.checked), [false, false, true]);
  });
}

for (const [text, basis] of [['20% remaining', 'remaining'], ['剩余 20%', 'remaining'], ['20% 已用', 'used'],
  ['已使用 20%', 'used'], ['80% used · 20% remaining', 'remaining']]) {
  test(`Cursor quota keeps its percentage direction: ${text}`, () => {
    const bar = nativeNode({ 'aria-valuenow': '20', 'aria-valuemax': '100', 'aria-label': 'usage', 'aria-valuetext': text });
    const root = nativeNode({}, { innerText: '当前套餐\nPro\n' + text,
      querySelectorAll: selector => selector === '[role=progressbar]' ? [bar] : [] });
    const context = vm.createContext({ settingsPanel: () => root, vis: () => true, fullText: el => el.innerText || '' });
    vm.runInContext(part(read('server/page/settings.js'), '  const readUsage =', '\n\n\n\n  // Full xterm') + '\nthis.result=readUsage();', context);
    assert.equal(context.result.plan, 'Pro');
    assert.equal(context.result.limits[0].pct, 20);
    assert.equal(context.result.limits[0].basis, basis);
  });
}

test('Cursor settings root is located through its native container independently of navigation labels', () => {
  const root = nativeNode(), doc = { getElementById: () => null, querySelectorAll: selector => selector === '.cursor-settings-pane-outer-wrapper' ? [root] : [] };
  const page = nativePage(doc, {}, 'settingsPanel');
  assert.equal(page.settingsPanel(), root);
  assert.equal(page.settingsOpen(), true);
});

test('Cursor quota reads the plan container rather than its heading-only child', () => {
  const heading = { innerText: '当前套餐' }, card = { innerText: '当前套餐\nPro\n剩余20%' };
  const bar = nativeNode({ 'aria-valuenow': '20', 'aria-label': 'usage', 'aria-valuetext': '剩余20%' });
  const root = { innerText: card.innerText, querySelectorAll: selector => selector === 'div, section' ? [heading, card] : selector === '[role=progressbar]' ? [bar] : [] };
  const context = vm.createContext({ settingsPanel: () => root, vis: () => true, fullText: el => el.innerText || '' });
  vm.runInContext(part(read('server/page/settings.js'), '  const readUsage =', '\n\n\n\n  // Full xterm') + '\nthis.result=readUsage();', context);
  assert.equal(context.result.plan, 'Pro'); assert.equal(context.result.limits[0].basis, 'remaining');
});

test('native effort IDs match their displayed casing without losing non-Latin labels', () => {
  const rows = ['Low', 'High', '深度', 'unrelated'].map(innerText => nativeNode({}, { innerText }));
  const context = vm.createContext({ effortItems: () => [{ label: 'low' }, { label: 'high' }, { label: '深度' }],
    doc: { querySelectorAll: () => rows }, vis: () => true, normLabel: value => value });
  vm.runInContext('this.menu={' + part(read('server/page/controls.js'), '    effort: () => {', '    mode: () => {') + '};this.result=menu.effort();', context);
  assert.deepEqual(Array.from(context.result, row => row.label), ['Low', 'High', '深度']);
});

for (const supported of [false, true]) {
  test(`Codex includes hidden Max only when its native model capability supports it: ${supported}`, () => {
    const efforts = ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort }));
    const picker = { model: 'model-id', reasoningEffort: 'high', modelOptions: [{ model: { id: 'model-id', supportedReasoningEfforts: efforts } }], onSelectModelOption() {} };
    const button = fiber(nativeNode(), [picker]);
    const model = { id: 'model-id', supportedReasoningEfforts: [...efforts, ...(supported ? [{ reasoningEffort: 'max' }] : [])] };
    const client = { getQueryData: () => [], getQueryCache: () => ({ getAll: () => [{ queryKey: ['models', '', 'local'], state: { data: { data: [model] } } }] }) };
    const root = fiber(nativeNode(), [{ value: client }]);
    const doc = { getElementById: () => null, querySelector: () => null,
      querySelectorAll: selector => selector === '[data-codex-intelligence-trigger]' ? [button] : selector === '[data-composer-body]' ? [root] : [] };
    const page = nativePage(doc);
    assert.deepEqual(Array.from(page.effortItems(false, true), row => row.label), [...efforts.map(row => row.reasoningEffort), ...(supported ? ['max'] : [])]);
  });
}

for (const generating of [false, true]) {
  test(`Cursor running state follows the selected native composer, generating=${generating}`, () => {
    const states = [{ id: 'current', state: generating ? 'generating' : 'focused' }, { id: 'other', state: 'generating' }];
    const source = part(read('server/page/devin.js'), '  const isBusy =', "  // Devin's queue");
    const context = vm.createContext({ window: { __SSG_COMPOSER_PROVIDER__: { getStates: () => states } },
      codexPromptEl: () => null, activeThread: () => 'current', stopGenerationButton: () => null, legacyStopIcon: () => null, devinSubmitBusy: () => false });
    vm.runInContext(source + '\nthis.busy=isBusy();', context);
    assert.equal(context.busy, generating);
  });
}

test('Cursor stop control is identified by its native state independently of the accessible label', () => {
  const button = nativeNode({ 'aria-label': 'opaque native label' }, { matches: selector => selector === '.ui-prompt-input-submit-button[data-state="stop"]' });
  const doc = { getElementById: () => null, querySelectorAll: selector => selector === 'button, [role=button]' ? [button] : [] };
  assert.equal(nativePage(doc, {}, 'stopGenerationButton').stopGenerationButton(), button);
});

for (const label of ['Context: 35%', 'Context usage: 35%', '上下文用量：35%']) {
  test(`Codex context percentage reads its verified native label: ${label}`, () => {
    const button = nativeNode({ 'aria-label': label });
    const doc = { getElementById: () => null, querySelectorAll: () => [button] };
    const result = nativePage(doc).contextPct();
    assert.equal(result.pct, 35); assert.equal(result.basis, 'used');
  });
}

test('Devin translated controls share the native translation keys for new session, queue and workdir', () => {
  const strings = {
    'sidebar.newSession': 'translated session', 'inputBox.queuedMessagesSendNow': 'translated send now',
    'inputBox.queuedMessagesRemove': 'translated remove', 'inputBox.queuedMessagesClearAll': 'translated clear',
    'agents.local': 'translated local', 'inputBox.queuedMessagesCount': '2 translated queued',
  };
  const locale = { t(key, options) { assert.equal(options.ns, 'translation'); return strings[key] || key; } };
  const editor = fiber(nativeNode(), [{ value: { i18n: locale } }]);
  const clicked = [], fresh = nativeNode({ 'aria-label': strings['sidebar.newSession'] }, { click: () => clicked.push('new') });
  const send = nativeNode({ 'aria-label': strings['inputBox.queuedMessagesSendNow'] }), remove = nativeNode({ 'aria-label': strings['inputBox.queuedMessagesRemove'] });
  const row = nativeNode({}, { className: 'cursor-grab', querySelectorAll: () => [send, remove] });
  const count = nativeNode({}, { innerText: '2 translated queued' }), clear = nativeNode({ 'aria-label': strings['inputBox.queuedMessagesClearAll'] });
  const doc = { getElementById: () => null,
    querySelectorAll: selector => selector.includes('data-slate-editor') ? [editor] : selector === 'button, a, [role=button]' ? [fresh]
      : selector === 'span.text-12' ? [count] : selector === 'ol li[role="button"]' ? [row] : selector === 'button[aria-label]' ? [clear] : [] };
  const page = nativePage(doc, {}, 'nativeLabel');
  assert.equal(page.nativeLabel('translated local', 'Local'), true);
  assert.equal(page.nativeLabel('unrelated', 'Local'), false);
  assert.equal(page.clickControl('newChat'), true); assert.deepEqual(clicked, ['new']);
  assert.equal(page.devinQueueCount(), 2);
  assert(page.devinQueueTarget(0, 'send')); assert(page.devinQueueTarget(0, 'remove')); assert(page.devinQueueClearTarget());
});

test('Devin settings navigation reads the native translated section names', () => {
  const editor = fiber(nativeNode(), [{ value: { i18n: { t: key => ({ 'localSettings.sections.general': 'translated general', 'localSettings.sections.planInformation': 'translated plan' })[key] || key } } }]);
  const buttons = ['translated general', 'translated plan', 'unrelated'].map(innerText => nativeNode({}, { innerText }));
  const doc = { getElementById: () => null,
    querySelectorAll: selector => selector.includes('data-slate-editor') ? [editor] : selector === 'button' ? buttons : [] };
  const page = nativePage(doc, { innerHeight: 1000, innerWidth: 1000 });
  assert.deepEqual(Array.from(page.devinSettingsNav()), ['translated general', 'translated plan']);
});

for (const chinese of [false, true]) {
  test(`terminal reading and operation targets preserve IDs with ${chinese ? 'Chinese' : 'English'} labels`, () => {
    const kill = nativeNode({ 'aria-label': chinese ? '终止终端' : 'Kill Terminal' });
    const terminal = nativeNode({ 'aria-label': chinese ? '终端1 bash' : 'Terminal 1 bash', 'aria-selected': 'true' },
      { querySelectorAll: () => [kill], scrollIntoView() {} });
    const tabs = nativeNode({ 'aria-label': chinese ? '终端选项卡' : 'Terminal tabs' }, { querySelectorAll: () => [terminal] });
    const fresh = nativeNode({ 'aria-label': chinese ? '新建终端 (Ctrl+Shift+`)' : 'New Terminal (Ctrl+Shift+`)' });
    const doc = { getElementById: () => null, querySelector: () => null,
      querySelectorAll: selector => selector === '[aria-label]' ? [tabs, fresh]
        : selector === '.part.panel .title-actions [aria-label]' ? [nativeNode({ 'aria-label': 'Kill Terminal' }, {}, false), kill] : [] };
    const page = nativePage(doc);
    assert.deepEqual(JSON.parse(JSON.stringify(page.terminalList())), [{ id: 'term-vt1', title: 'bash', current: true }]);
    assert(page.terminalTarget('term-vt1')); assert(page.terminalCloseTarget('term-vt1'));
    assert(page.terminalKillActiveTarget()); assert(page.newTerminalDirect());
  });
}

for (const primary of [false, true]) {
  test(`focusing the composer excludes localized transcript editors, primary selector=${primary}`, () => {
    const focused = [], body = nativeNode();
    const make = (name, message) => nativeNode({}, { closest: selector => message && selector.includes('[data-transcript-row-key]') ? body : null,
      focus: () => focused.push(name) });
    const message = make('message', true), composer = make('composer', false);
    const document = { getElementById: () => null, querySelector: () => null,
      querySelectorAll: selector => selector === (primary ? '.ProseMirror[contenteditable="true"]' : '[contenteditable="true"]') ? [composer, message] : [],
      createRange: () => ({ selectNodeContents() {}, collapse() {} }),
      defaultView: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) } };
    vm.runInNewContext(FOCUS_COMPOSER, { document, getComputedStyle: () => ({ visibility: 'visible' }) });
    assert.deepEqual(focused, ['composer']);
  });
}

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
  const html = h.html(), tracks = [...html.matchAll(/class="ov-meter-track"[^>]*stroke-dasharray="([^"]+)" stroke-dashoffset="([^"]+)"/g)];
  assert.deepEqual([...new Set([...html.matchAll(/\br="([^"]+)"/g)].map(m => m[1]))], ['18.5']);
  assert.equal(tracks.length, 2);
  assert.deepEqual(tracks.map(m => Number(m[1].split(' ')[0])), [47, 47]);
  assert.deepEqual(tracks.map(m => Number(m[2])), [-1.5, -51.5]);
  assert.equal((html.match(/transform="rotate\(90 20 20\)"/g) || []).length, 4);
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

test('two quota periods and context share one three-part ring with separated boundaries', () => {
  const h = usageMeters(); h.context.renderQuota({ context: { pct: 20, basis: 'remaining' }, limits: [
    { label: 'weekly', pct: 40, basis: 'used' }, { label: 'daily', pct: 70, basis: 'used' },
  ] });
  const html = h.html();
  assert(html.includes('上下文 已用 80%')); assert(html.includes('weekly 剩余 60%')); assert(html.includes('daily 剩余 30%'));
  assert.equal((html.match(/class="ov-meter-quota /g) || []).length, 2);
  const tracks = [...html.matchAll(/class="ov-meter-track"[^>]*stroke-dasharray="([^"]+)" stroke-dashoffset="([^"]+)"/g)];
  assert.deepEqual([...new Set([...html.matchAll(/\br="([^"]+)"/g)].map(m => m[1]))], ['18.5']);
  assert.equal(tracks.length, 3);
  assert.equal((html.match(/transform="rotate\(120 20 20\)"/g) || []).length, 6);
  for (const [i, track] of tracks.entries()) {
    assert(Math.abs(Number(track[1].split(' ')[0]) - (100 / 3 - 3)) < 1e-9);
    assert(Math.abs(Number(track[2]) - (-i * 100 / 3 - 1.5)) < 1e-9);
  }
});

test('card context keeps its header color while quota reuses remaining-usage warning colors', () => {
  const h = usageMeters();
  for (const [remaining, fill] of [[60, ''], [25, 'warm'], [10, 'hot']]) {
    h.context.renderQuota({ context: 95, limits: [{ label: 'weekly', pct: 100 - remaining, basis: 'used' }] });
    const html = h.html();
    assert(html.includes('class="ov-meter-context "'));
    assert(html.includes(`class="ov-meter-quota ${fill}"`));
    assert(h.node('quotaMeters').innerHTML.includes(`<i class="${fill}"`));
  }
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

function relayHeartbeat() {
  let now = 1000000, wss;
  const timers = new Map(), sessions = [], bindings = [], logs = [];
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const device = { id: crypto.randomUUID(), publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') };
  const schedule = (fn, ms, repeat = false) => {
    const id = { unref() {} }; timers.set(id, { fn, at: now + ms, ms, repeat }); return id;
  };
  class Server extends EventEmitter {
    constructor() { super(); this.clients = new Set(); wss = this; }
  }
  class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 1; this.sent = []; this.pings = 0; }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    ping() { this.pings++; }
    receive(message) { this.emit('message', JSON.stringify(message)); }
    close(code, reason) {
      if (this.readyState !== 1) return;
      this.code = code; this.reason = reason; this.readyState = 3;
      wss.clients.delete(this); this.emit('close', code);
    }
    terminate() { this.close(1006); }
  }
  class Session {
    constructor(client, deviceId) { Object.assign(this, { client, deviceId, mode: 'chat', connectionMessages: new Map() }); sessions.push(this); }
    selectionKey() { return `${this.app}|${this.windowId}|${this.threadId}`; }
    async handle() {}
    suspend() { this.suspended = true; }
    dispose() { this.disposed = true; }
  }
  const context = vm.createContext({
    crypto, Buffer, URL, AbortController, Session, WebSocketServer: Server,
    Date: class extends Date { static now() { return now; } },
    setTimeout: schedule, clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, true), clearInterval: id => timers.delete(id),
    console: { log: message => logs.push(message) }, voiceWss: () => new EventEmitter(),
    findDevice: token => token === 'fixture-token' ? device : null, needsTotp: () => false,
    computerId: () => 'fixture-computer', computerName: () => 'Fixture', updateDevice() {},
    bindDeviceConnection(_id, close) { const binding = { valid: true, close, release() {} }; bindings.push(binding); return binding; },
    subscribeLibrary() {}, subscribeOperations: () => () => {}, lastSelection: () => null,
    addViewer() {}, removeViewer() {}, clientIp: () => 'fixture', originAllowed: () => true,
    ROUTES: { visible: { connection: true } }, flag: value => !!value,
    beginOperation, withOperation, cdpRead: new AsyncLocalStorage(),
  });
  const strip = source => source.replace(/^import .*;\n/gm, '').replace(/\bexport /g, '');
  vm.runInContext(strip(read('lib/device-proof.mjs')) + strip(read('server/ws.mjs')), context);
  context.attachWss(new EventEmitter());
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return {
    logs, sessions, settle,
    async socket({ valid = true, resume, authenticate = true } = {}) {
      const socket = new Socket(); wss.clients.add(socket); wss.emit('connection', socket, { headers: {} });
      if (authenticate) {
        const proof = { ts: now, nonce: crypto.randomBytes(16).toString('base64url') };
        const payload = ['ra-entry-v1', 'fixture-computer', 'fixture-token', 'WS /ws', proof.ts, proof.nonce].join('\n');
        proof.signature = valid ? crypto.sign('sha256', Buffer.from(payload), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') : 'A'.repeat(86);
        socket.receive({ t: 'auth', token: 'fixture-token', proof, resume }); await settle();
      }
      return socket;
    },
    bind(socket) {
      const session = sessions.find(s => s.client === socket);
      Object.assign(session, { app: 'codex', targetId: 'codex', windowId: 'window-A', threadId: 'thread-A', bindingReady: true, cdp: { ws: { readyState: 1 } } });
      return session;
    },
    revoke() { for (const binding of bindings) if (binding.valid) { binding.valid = false; binding.close(); } },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next; now = timer.at;
        if (timer.repeat) timer.at += timer.ms; else timers.delete(id);
        timer.fn();
      }
      now = end;
    },
  };
}

test('background deadline owns unanswered relay heartbeats for five minutes without extending on repeated visibility', async () => {
  const h = relayHeartbeat(), socket = await h.socket(); h.bind(socket);
  socket.receive({ t: 'visible', v: false, background: true });
  const timer = socket.backgroundTimer;
  for (const ms of [5000, 15000, 20000, 259000]) {
    h.advance(ms); assert.equal(socket.readyState, 1);
    socket.receive({ t: 'visible', v: false, background: true }); assert.equal(socket.backgroundTimer, timer);
  }
  assert.equal(socket.pings, 14);
  h.advance(1000);
  assert.equal(socket.code, 4000); assert.equal(socket.closeSource, 'background'); assert.equal(socket.reason, 'background timeout');
  assert(h.logs.some(line => /source=background authorized=true background=true$/.test(line)));
});

test('returning to foreground starts a fresh probe budget but repeated foreground notices do not renew it', async () => {
  const h = relayHeartbeat(), socket = await h.socket(); h.bind(socket);
  socket.receive({ t: 'visible', v: false, background: true }); h.advance(59000);
  socket.receive({ t: 'visible', v: true, background: false });
  assert.equal(socket.backgroundTimer, null); assert.equal(socket.alive, true);
  h.advance(1000); assert.equal(socket.readyState, 1); assert.equal(socket.alive, false);
  socket.receive({ t: 'visible', v: true, background: false });
  assert.equal(socket.alive, false);
  h.advance(20000); assert.equal(socket.code, 1006); assert.equal(socket.closeSource, 'heartbeat');
  assert(h.logs.some(line => /source=heartbeat authorized=true background=false$/.test(line)));
});

test('foreground relay pongs still renew liveness and missing pongs still close the socket', async () => {
  const h = relayHeartbeat(), socket = await h.socket(); h.bind(socket);
  h.advance(20000); assert.equal(socket.readyState, 1); socket.emit('pong');
  h.advance(20000); assert.equal(socket.readyState, 1);
  h.advance(20000); assert.equal(socket.code, 1006); assert.equal(socket.closeSource, 'heartbeat');
});

test('background state cannot skip device proof or prevent authorization revocation', async () => {
  const h = relayHeartbeat(), unauthenticated = await h.socket({ authenticate: false });
  unauthenticated.receive({ t: 'visible', v: false, background: true });
  assert.equal(unauthenticated.code, 4001); assert.equal(unauthenticated.backgroundTimer, null);
  const invalid = await h.socket({ valid: false }); assert.equal(invalid.code, 4001);
  const valid = await h.socket(); const session = h.bind(valid);
  valid.receive({ t: 'visible', v: false, background: true }); h.advance(40000); h.revoke();
  assert.equal(valid.code, 4001); assert.equal(session.disposed, true);
});

test('peer loss during background still requires fresh proof to recover the retained session', async () => {
  const h = relayHeartbeat(), first = await h.socket(), session = h.bind(first), resume = session.resumeId;
  first.receive({ t: 'visible', v: false, background: true }); h.advance(5000); first.close(1006); await h.settle();
  assert.equal(session.suspended, true);
  const invalid = await h.socket({ valid: false, resume }); assert.equal(invalid.code, 4001);
  h.advance(1000);
  const recovered = await h.socket({ resume }), auth = recovered.sent.findLast(m => m.t === 'auth');
  assert.equal(auth.resumed, true); assert.equal(session.client, recovered); assert.equal(h.sessions.length, 1);
  assert.equal(recovered.backgroundTimer, null);
});
