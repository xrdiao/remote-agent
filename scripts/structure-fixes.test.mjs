import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { beginOperation, captureOperation, withOperation, subscribeOperations, currentOperation } from '../server/operations.mjs';
import { PAGE_SRC } from '../server/page/build.mjs';
import { AgentContext, FOCUS_COMPOSER } from '../server/agent/context.mjs';
import { ensurePairedBrowser } from './paired-browser.mjs';
import { writeTextFile } from '../lib/files.mjs';
import { methods as menuMethods } from '../server/agent/menus.mjs';
import { methods as projectMethods } from '../server/agent/projects.mjs';
import { methods as codexMethods } from '../server/apps/codex.mjs';
import { ROUTES, flag } from '../server/routes.mjs';
import { cdpRead, awaitCdpRead } from '../server/cdp.mjs';

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

for (const label of ['Ask for approval', 'Approve for me', 'Full access']) {
  test(`permissions retain ${label} when the current control is collapsed and an old control stays mounted`, () => {
    let current = nativeNode({}, { innerText: '', textContent: label });
    const old = nativeNode({}, { innerText: 'Old permission', textContent: 'Old permission' }, false);
    const doc = { getElementById: () => null, querySelectorAll: () => [old, current] };
    const page = nativePage(doc, {}, 'permissionLabel');
    assert.equal(page.permissionLabel(), label);
    current.innerText = label;
    assert.equal(page.permissionLabel(), label);
    current = nativeNode({}, { innerText: '', textContent: ' Full access\n' });
    assert.equal(page.permissionLabel(), 'Full access');
    current = nativeNode({}, { textContent: label }, false);
    assert.equal(page.permissionLabel(), null);
  });
}

test('confirmed model refresh discards the window snapshot before reading chat once', async () => {
  const calls = [], context = { cdp: { nativeWindow: { invalidate() { calls.push('invalidate'); } } },
    async pollChat(immediate) { calls.push(['read', immediate]); } };
  await menuMethods.refreshModelChat.call(context);
  assert.deepEqual(calls, ['invalidate', ['read', true]]);
});

test('native reply images retain supported sources independently of cleaned HTML', () => {
  const images = [nativeNode({}, { currentSrc: 'data:image/png;base64,fixture' }),
    nativeNode({}, { src: 'blob:native-image' }), nativeNode({}, { src: 'https://fixture/image.png' }),
    nativeNode({}, { src: 'javascript:invalid' }), nativeNode({}, { src: 'https://fixture/hidden.png' }, false)];
  const page = nativePage({ getElementById: () => null }, {}, 'messageImages');
  assert.deepEqual(Array.from(page.messageImages({ querySelectorAll: () => images })),
    ['data:image/png;base64,fixture', 'blob:native-image', 'https://fixture/image.png']);
});

test('Codex imageView survives stored history without a mounted native turn', () => {
  const input = { id: 'native-image-id', type: 'imageView', path: '/project/generated.png' };
  const context = vm.createContext({ codexUserItem: () => null, CAPACITY_ERROR: /capacity/,
    codexThread: () => 'thread', codexForkProps: () => null, codexFiberProps: () => [],
    doc: { querySelectorAll: () => [] }, source: { metadata: { status: 'completed' }, rawItems: [input], positions: new Map([[input.id, 0]]), nativeComplete: true, ids: [input.id] } });
  const source = read('server/page/chat-extract.js');
  vm.runInContext(part(source, '  const codexStoredTurn =', '  const codexLatestEntry =')
    + part(source, '  const codexTurnItems =', '  const codexReadPage =')
    + '\nthis.turn=codexStoredTurn({},null,false,source);this.items=codexTurnItems(null,{turn});', context);
  const image = context.items.find(item => item.images?.length);
  assert.equal(image.i, 'thread:generated-image:native-image-id');
  assert.equal(image.images[0], input.path); assert.equal(image.keep, true);
});

test('terminal input reads the live prompt rather than candidate output retained by shell integration', () => {
  let value = 'user@host:~$ cat folder ';
  const terminal = { element: { dataset: { remoteTerminal: 'terminal' } },
    _addonManager: { _addons: [{ instance: { capabilities: new Map([[2, { commands: [], promptInputModel: { value: 'old command\ncandidates\nuser@host:~$ cat folder ' } }]]) } }] },
    buffer: { active: { baseY: 0, cursorY: 0, get cursorX() { return value.length; }, length: 1,
      getLine: () => ({ isWrapped: false, translateToString: (trim, start = 0, end) => trim ? value.trimEnd() : value.slice(start, end) }) } } };
  const page = nativePage({ getElementById: () => null, querySelector: () => ({ xterm: terminal }) });
  assert.equal(page.terminalHistory().input, 'cat folder ');
  assert.equal(page.terminalCommand(), 'cat folder');
  value = 'user@host:~$ ';
  assert.equal(page.terminalHistory().input, '');
});

for (const label of ['Recent chats', '最近聊天', '最近のチャット', 'واجهة محلية']) {
  test(`Codex native providers retain query, route and history ownership with label ${label}`, async () => {
    const routes = [], scope = { familyBindings: new Map() }, staleScope = { familyBindings: new Map() };
    const query = { getQueryData: () => [] }, router = { navigate: path => routes.push(path) };
    const root = fiber(nativeNode(), [{ value: query }, { value: { router } }, { value: new Map([['scope', scope]]) }]);
    const hidden = fiber(nativeNode({}, {}, false), [{ value: { getQueryData() {} } }, { value: new Map([['scope', staleScope]]) }]);
    const button = nativeNode({ 'aria-label': label });
    const doc = {
      getElementById: () => null,
      querySelectorAll: selector => selector.includes('[data-composer-body]') ? [hidden, root] : selector === 'button' ? [button] : [],
    };
    const page = nativePage(doc, {}, 'codexRootProps,codexQueryClient,codexHistoryScopes');
    assert.equal(page.codexQueryClient(), query);
    assert.deepEqual([...page.codexHistoryScopes()], [scope]);
    assert.equal(await page.openCodexThread('fixture-thread'), true);
    assert.deepEqual(routes, ['/local/fixture-thread']);
  });
}

test('Codex state remains readable when a Question replaces the main composer', () => {
  for (const anchor of ['[data-request-input-dismiss]', '[data-response-annotation-conversation]']) {
    const query = { getQueryData: () => [] }, scope = { familyBindings: new Map() };
    const question = fiber(nativeNode(), [{ value: query }, { value: new Map([['scope', scope]]) }]);
    const hidden = fiber(nativeNode({}, {}, false), [{ value: { getQueryData() {} } }]);
    const doc = { getElementById: () => null, querySelectorAll: selector => selector.includes(anchor) ? [hidden, question] : [] };
    const page = nativePage(doc, {}, 'codexQueryClient,codexHistoryScopes');
    assert.equal(page.codexQueryClient(), query);
    assert.deepEqual([...page.codexHistoryScopes()], [scope]);
  }
});

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
      : selector.includes('[data-composer-body]') ? [root] : [] };
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
      querySelectorAll: selector => selector === '[data-codex-intelligence-trigger]' ? [button] : selector.includes('[data-composer-body]') ? [root] : [] };
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
  const nodes = Object.fromEntries(['send', 'sendNow', 'stop', 'queueBar', 'attachments', 'askOk', 'askNo', 'msg'].map(id => [id, {}]));
  nodes.attachments.children = [];
  const packets = [], calls = [], computer = { id: 'computer-A' }, listeners = new Set();
  const document = new EventTarget();
  const add = document.addEventListener.bind(document), remove = document.removeEventListener.bind(document);
  document.addEventListener = (type, fn, options) => { listeners.add(fn); add(type, fn, options); };
  document.removeEventListener = (type, fn, options) => { listeners.delete(fn); remove(type, fn, options); };
  const context = vm.createContext({
    document, Event, $: id => nodes[id], currentComputer: () => computer,
    mode: 'chat', currentApp: 'codex', viewSel: 'codex|window|A', sheetKind: null, windowReady: true,
    text: { value: 'draft from A' }, pendingImageUploads: () => false,
    questionCompose: null, chatBusy: true, devinBusySplit: () => false, cursorBusyQueue: () => false,
    cancelVoice: () => calls.push('cancelVoice'),
    status(value) { context.pendingStatus = value; }, saveDraft() {}, codexFollow: () => 'queue', pushEcho() {},
    mentionsFor: () => ({}), submitComposerCommand: () => false, jumpToLatest() {}, esc: value => value,
    authed: true, ws: { readyState: 1, send: raw => packets.push(JSON.parse(raw)) },
    crypto: crypto.webcrypto, clearTimeout() {}, draftPushTimer: 0, draftEpoch: '',
    queuedChat: null, lastChat: { thread: 'A', items: [], queued: [] },
    activeDraft: 'computer-A|codex|window|A|chat', draftVersions: new Map(),
    inputRevision: 0, pendingSends: new Map(), pendingEchoes: [], messageScope: () => 'fixture',
    desktopAttachments: [], MN: { mentions: [], value: '' }, drafts: new Map(), draftMentions: new Map(),
    inputHistory: new Map(), dirtyDrafts: new Set(), submittedMessages: [], queueEditRequest: null,
    pendingStatus: '', draftRevision: 0, pendingDesktopDraft: null, mirroredDraft: '',
    queueChatRender() {}, queueDraftSync() {}, mentionHide() {}, endInputRecall() {}, ovEnterReady() {},
    autosize() { document.dispatchEvent(new Event('composer-state')); },
    openSheet(kind) { context.sheetKind = kind; },
    closeSheet() { vm.runInContext('askDone?.(false); sheetKind = null;', context); },
  });
  const composer = read('app/js/composer.js'), history = read('app/js/history.js');
  vm.runInContext(
    part(read('app/js/sheets.js'), 'let askDone = null;', '// Buttons on Cursor')
      + read('app/js/core.js').slice(read('app/js/core.js').indexOf('const desktopRequests = new Map();'))
      + part(composer, 'function composerSendMatches(', 'function reconcileSent(')
      + part(composer, 'function draftKey()', 'function restoreDraft(')
      + part(composer, 'function recordDraftEdit()', 'function queueDraftSync(')
      + part(composer, "$('stop').onclick =", 'function updateSendMode(')
      + part(composer, 'function sendComposer(', "$('insertNewline').addEventListener")
      + part(history, 'function sendQueueAction(', 'function editQueued(')
      + part(history, "$('queueBar').onclick =", 'function updateToBottom('), context);
  listeners.clear(); // Track the scoped confirmation listeners added after fixture setup.
  return {
    context, nodes, packets, listeners, calls,
    change(kind) {
      if (kind === 'computer') computer.id = 'computer-B';
      else if (kind === 'mode') context.mode = 'terminal';
      else { context.viewSel = 'codex|window|B'; context.lastChat = { thread: 'B', items: [], queued: [] }; }
      context.activeDraft = [computer.id, context.viewSel, context.mode].join('|');
      document.dispatchEvent(new Event('composer-state'));
    },
    accept() { nodes.askOk.onclick(); },
  };
}

function composerCommands() {
  const packets = [], echoes = [], timers = new Map(), listeners = new Map();
  let timerId = 0, receipts = 0;
  const box = { hidden: true, innerHTML: '', addEventListener: (type, callback) => listeners.set('box:' + type, callback), querySelector: () => null, insertAdjacentHTML() {} };
  const input = { value: '', selectionStart: 0, selectionEnd: 0,
    setRangeText(value, start, end) { this.value = this.value.slice(0, start) + value + this.value.slice(end); this.selectionStart = this.selectionEnd = start + value.length; },
    focus() {}, dispatchEvent() { context.inputRevision++; context.mentionUpdate(input); } };
  const nodes = { mentionBox: box, send: { disabled: false }, sendNow: { disabled: false }, attachments: { children: [] }, msg: { textContent: '' } };
  const context = vm.createContext({
    text: input, $: id => nodes[id], document: { addEventListener: (type, callback) => listeners.set(type, callback), dispatchEvent(event) { listeners.get(event.type)?.(event); } },
    Event: class { constructor(type) { this.type = type; } },
    currentApp: 'codex', mode: 'chat', viewSel: 'codex|fixture|thread', currentTerminalId: 'native-terminal', questionCompose: null, inputRevision: 0,
    ovToolInput: () => null, supportsCapability: () => true, updateComposeCompact() {}, esc: value => value,
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
    cancelVoice() {}, pendingImageUploads: () => false, saveDraft() {}, codexFollow: () => '', devinBusySplit: () => false,
    cursorBusyQueue: () => false, chatBusy: false, status() {}, sendReceipt: () => { receipts++; return { requestId: 'receipt-' + receipts }; },
    pushEcho: (...args) => echoes.push(args), mentionsFor: () => ({}), jumpToLatest() {}, failPendingSend() {},
    send: packet => { packets.push(packet); return true; },
    sendTerminalInput: () => packets.push({ t: 'termSend', text: input.value }),
  });
  const composer = read('app/js/composer.js');
  vm.runInContext(part(composer, 'const MN =', '// Mentions still present in the text')
    + part(composer, 'function sendComposer(', "$('insertNewline').addEventListener")
    + part(composer, 'let composing = false;', 'const composerInputHandlers ='), context);
  return { context, input, box, packets, echoes, nodes, timers,
    mn: () => vm.runInContext('MN', context),
    type(value) { input.value = value; input.selectionStart = input.selectionEnd = value.length; context.inputRevision++; context.mentionUpdate(input); },
    flush() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); },
    reply(rows, query = packets.findLast(packet => packet.t === 'mentionQuery')) {
      context.onMentions({ sel: query.sel || context.viewSel, seq: query.seq, q: query.q, rows });
    },
    send: () => context.sendComposer(),
    enter() { let prevented = false; context.submitOnEnter({ preventDefault() { prevented = true; } }); assert(prevented); },
    click(index = 0) { listeners.get('box:click')({ target: { closest: () => ({ dataset: { mi: String(index) } }) } }); },
    receipts: () => receipts,
  };
}

const compactSuggestion = { section: 'commands', key: 'commands:Compact conversation', label: 'Compact conversation' };

test('Codex slash Send uses the same native command choice as its suggestion button', () => {
  for (const action of ['send', 'click']) {
    const h = composerCommands(); h.type('/compact'); h.flush(); h.reply([compactSuggestion]); h[action]();
    const picks = h.packets.filter(packet => packet.t === 'codexPick');
    assert.equal(picks.length, 1); assert.equal(picks[0].key, compactSuggestion.key); assert.equal(picks[0].q, 'compact');
    assert.equal(picks[0].text, ''); assert.equal(h.receipts(), 0); assert.equal(h.echoes.length, 0);
    assert.equal(h.input.value, ''); assert.equal(h.box.hidden, true);
    assert.equal(h.packets.some(packet => packet.t === 'send'), false);
  }
});

test('Codex Enter reuses its in-flight slash query and repeated Enter executes once', () => {
  const h = composerCommands(); h.type('/compact'); h.flush();
  h.enter(); h.enter();
  assert.equal(h.packets.filter(packet => packet.t === 'mentionQuery').length, 1);
  h.reply([compactSuggestion]); h.enter();
  assert.equal(h.packets.filter(packet => packet.t === 'codexPick').length, 1);
  assert.equal(h.receipts(), 0); assert.equal(h.box.hidden, true);
});

test('sending a slash command before debounce queries immediately, including surrounding whitespace', () => {
  for (const value of ['/compact', ' /compact ']) {
    const h = composerCommands(); h.type(value); h.send(); h.flush();
    const queries = h.packets.filter(packet => packet.t === 'mentionQuery'); assert.equal(queries.length, 1);
    assert.equal(queries[0].trigger, '/'); assert.equal(queries[0].q, 'compact');
    h.reply([compactSuggestion]); assert.equal(h.packets.filter(packet => packet.t === 'codexPick').length, 1);
    assert.equal(h.input.value, ''); assert.equal(h.echoes.length, 0);
  }
});

test('a late command query cannot execute after an edit or a session change', () => {
  for (const change of ['edit', 'session']) {
    const h = composerCommands(); h.type('/compact'); h.send(); const query = h.packets.at(-1);
    if (change === 'edit') h.type('new unsent draft');
    else { h.context.mentionHide(); h.context.viewSel = 'codex|fixture|another'; h.type('new session draft'); }
    const value = h.input.value; h.reply([compactSuggestion], query);
    assert.equal(h.packets.some(packet => packet.t === 'codexPick' || packet.t === 'send'), false);
    assert.equal(h.input.value, value);
  }
});

test('ambiguous slash results remain choices, and an unknown slash retains ordinary message semantics', () => {
  const ambiguous = composerCommands(); ambiguous.type('/c'); ambiguous.send();
  ambiguous.reply([compactSuggestion, { section: 'commands', key: 'context', label: 'Context' }]);
  assert.equal(ambiguous.packets.some(packet => packet.t === 'codexPick' || packet.t === 'send'), false);
  assert.equal(ambiguous.box.hidden, false); assert.equal(ambiguous.input.value, '/c');
  const unknown = composerCommands(); unknown.type('/not-a-command'); unknown.send(); unknown.reply([]);
  const messages = unknown.packets.filter(packet => packet.t === 'send'); assert.equal(messages.length, 1);
  assert.equal(messages[0].text, '/not-a-command'); assert.equal(unknown.receipts(), 1);
});

test('Cursor and ordinary Codex messages keep their send path', () => {
  for (const setting of [{ app: 'cursor', mode: 'chat', value: '/compact' },
    { app: 'codex', mode: 'chat', value: 'ordinary text' }]) {
    const h = composerCommands(); h.context.currentApp = setting.app; h.context.mode = setting.mode; h.type(setting.value); h.send();
    assert.equal(h.packets.length, 1); assert.equal(h.packets[0].t, 'send');
    assert.equal(h.receipts(), 1);
  }
});

test('the restored terminal textbox delegates once without creating a chat submission', () => {
  const h = composerCommands(); h.context.mode = 'terminal'; h.type('keep chat draft'); h.send();
  assert.deepEqual(h.packets, [{ t: 'termSend', text: 'keep chat draft' }]); assert.equal(h.receipts(), 0);
  assert.equal(h.input.value, 'keep chat draft');
});

test('an accepted message closes only its own suggestions and preserves a newer draft', () => {
  for (const newer of [false, true]) {
    const h = composerCommands(); h.type('original text');
    const request = { requestId: 'accepted', computer: 'fixture', draft: 'draft-A', text: h.input.value,
      revision: h.context.inputRevision, mode: 'chat', version: 0, mentions: '{}', attachmentIds: [] };
    Object.assign(h.context, { pendingSends: new Map([['accepted', request]]), pendingEchoes: [], inputHistory: new Map(),
      drafts: new Map([['draft-A', request.text]]), draftMentions: new Map(), draftVersions: new Map(),
      currentComputer: () => ({ id: 'fixture' }), draftKey: () => 'draft-A', activeDraft: 'draft-A', pendingStatus: '',
      dirtyDrafts: new Set(), submittedMessages: [], lastChat: null, draftRevision: 0,
      queueDraftSync() {}, queueChatRender() {}, autosize() {}, desktopAttachments: [] });
    if (newer) h.type('/new');
    h.box.hidden = false;
    const seq = h.mn().seq;
    vm.runInContext(part(read('app/js/composer.js'), 'function composerSendMatches(', 'function pendingComposerSend(')
      + part(read('app/js/composer.js'), 'function confirmSent(', 'function failPendingSend('), h.context);
    h.context.confirmSent({ requestId: 'accepted', sel: h.context.viewSel });
    assert.equal(h.input.value, newer ? '/new' : '');
    assert.equal(h.box.hidden, !newer); assert.equal(h.mn().seq > seq, !newer);
  }
});

function acceptedDraft(newer) {
  const value = 'submitted text', input = { value, selectionStart: 0, selectionEnd: 0,
    setSelectionRange(start, end, direction) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; } };
  const sent = { requestId: 'request', computer: 'computer', draft: 'draft', text: value, revision: 1, version: 1, mode: 'chat', mentions: '{}', attachmentIds: [] };
  const context = vm.createContext({ text: input, mode: 'chat', currentApp: 'codex', questionCompose: null,
    currentComputer: () => ({ id: 'computer' }), draftKey: () => 'draft', activeDraft: 'draft', viewSel: 'codex|A',
    inputRevision: newer ? 2 : 1, draftRevision: 7, draftAckRevision: 7, draftEpoch: 'epoch',
    drafts: new Map([['draft', value]]), draftVersions: new Map([['draft', newer ? 2 : 1]]), draftMentions: new Map(),
    pendingSends: new Map([['request', sent]]), pendingEchoes: [], inputHistory: new Map(), submittedMessages: [],
    pendingDesktopDraft: { text: value }, pendingStatus: '', dirtyDrafts: new Set(), lastChat: null, mirroredDraft: value,
    MN: { value, mentions: [] }, desktopAttachments: [], mentionsFor: () => ({}), document: Object.assign(new EventTarget(), { activeElement: null }), Event, composing: false,
    $: () => ({ textContent: '' }), queueChatRender() {}, status() {}, mentionHide() {}, autosize() {}, saveDraft() {}, queueDraftSync() {},
  });
  vm.runInContext(part(read('app/js/composer.js'), 'function composerSendMatches(', 'function pendingComposerSend(')
    + part(read('app/js/composer.js'), 'function confirmSent(', 'function failPendingSend(')
    + part(read('app/js/composer.js'), 'function receiveDraft(', 'function autosize('), context);
  return { context, input, sent, ack: (revision, text) => context.receiveDraft({ t: 'draftAck', ok: true, read: true,
    sel: 'codex|A', draftEpoch: 'epoch', revision, text }) };
}

test('accepted clearing invalidates late draft reads and a current native draft still synchronizes', () => {
  const h = acceptedDraft(false);
  h.context.confirmSent({ requestId: 'request', sel: 'codex|A' });
  assert.equal(h.input.value, ''); assert.equal(h.context.draftRevision, 8); assert.equal(h.context.pendingDesktopDraft, null);
  h.ack(7, h.sent.text); assert.equal(h.input.value, '');
  h.ack(8, 'new desktop draft'); assert.equal(h.input.value, 'new desktop draft');
});

test('acceptance retains a later edit even when its text equals the previous submitted message', () => {
  const h = acceptedDraft(true);
  h.context.confirmSent({ requestId: 'request', sel: 'codex|A' });
  assert.equal(h.input.value, h.sent.text); assert(h.context.dirtyDrafts.has('draft'));
  h.ack(7, ''); assert.equal(h.input.value, h.sent.text);
});

function codexTranscript() {
  const history = read('app/js/history.js'), context = vm.createContext({ currentApp: 'codex' });
  const merge = part(history, '    const updates = new Map(chat.items.map', '    chat = { ...chat, items: merged };');
  vm.runInContext(part(history, 'function scKeep(', 'function scSnapshot(')
    + `\nthis.merge = (items, next, older = false) => {
      const previous = { items }, chat = next, historyRequest = older, paged = true, historyExpanded = true;
      ${merge}
      return merged;
    };`, context);
  return { context, merge: (previous, next, older) => context.merge(previous, next, older), ids: rows => Array.from(rows, row => row.i) };
}

test('Codex displayed transcript follows live message identity after cached order numbers are rebuilt', () => {
  const h = codexTranscript(), old = { i: 'older', k: 'human', order: 1400000, t: 'same text' },
    latest = { i: 'latest', k: 'human', order: 770000, t: 'same text' }, answer = { i: 'answer', k: 'assistant', order: 770001 };
  assert.deepEqual(h.ids(h.merge([old], { items: [latest, answer] })), ['older', 'latest', 'answer']);
  assert.deepEqual(h.ids(h.merge([latest, answer, old], { items: [latest, answer] })), ['older', 'latest', 'answer']);
  Object.assign(h.context, { SC: { key: null }, lastChat: { items: h.merge([old], { items: [latest, answer] }) } });
  vm.runInContext(part(read('app/js/history.js'), 'function conversationTurns(', 'function jumpToTurn('), h.context);
  assert.deepEqual(h.ids(h.context.conversationTurns()), ['older', 'latest']);
});

test('Codex displayed transcript retains omitted middle rows, longer thinking and task details', () => {
  const h = codexTranscript(), head = { i: 'human', k: 'human', order: 10000 }, tool = { i: 'tool', k: 'tool', order: 10001 },
    thought = { i: 'thinking', k: 'thinking', t: 'Thought\nfull reasoning', order: 10002 },
    task = { i: 'tasks', k: 'tasks', total: 1, done: 0, items: ['detail'], order: 10003 };
  const result = h.merge([head, tool, thought, task], { items: [{ ...head, order: 20000 }, { ...thought, order: 20001, t: 'Thought\nx' },
    { i: 'tasks', k: 'tasks', total: 1, done: 0, order: 20002 }, { i: 'new', k: 'human', order: 30000 }] });
  assert.deepEqual(h.ids(result), ['human', 'tool', 'thinking', 'tasks', 'new']);
  assert.equal(result[2].t, thought.t); assert.deepEqual(result[3].items, ['detail']);
});

test('Codex older pages precede the current tail and expired capacity Retry controls disappear', () => {
  const h = codexTranscript(), old = { i: 'old', k: 'human', order: 100000 }, shared = { i: 'shared', k: 'human', order: 200000 },
    latest = { i: 'latest', k: 'assistant', order: 200001 };
  assert.deepEqual(h.ids(h.merge([shared, latest], { items: [old, shared] }, true)), ['old', 'shared', 'latest']);
  const capacity = { i: 'capacity', k: 'notice', capacity: true, syntheticCapacity: true, b: ['Retry'], order: 200002 };
  const result = h.merge([shared, latest, capacity], { items: [shared, latest], capacityPresent: false });
  assert.deepEqual(h.ids(result), ['shared', 'latest']);
});

function readingWindow() {
  const calls = [];
  const context = { cdpRead, awaitCdpRead, AbortController, PAGE_SRC: '{}', helpersCall: call => call,
    refreshSessionCatalog: async () => {}, publishCatalog() {}, withOperation: (_operation, action) => action() };
  const methods = vm.runInNewContext('({' + part(read('server/native-windows.mjs'), '  async read(fresh = false)', '  interval()') + '})', context);
  const source = { revision: 1, readRevision: 0, snapshot: null, catalogKey: null,
    win: { app: 'codex' }, runStates: new Map(), listeners: new Set(), connect: async () => {}, retryCapacity() {}, interval: () => 1800,
    cdp: { evaluate: expression => expression === 'sessionPickerRows(true)' ? Promise.resolve([]) : new Promise(resolve => calls.push(resolve)) } };
  source.read = methods.read.bind(source);
  return { source, calls, release: (n, name) => calls[n]({ chat: { thread: 'A', items: [{ i: name }] }, states: [], catalog: [] }) };
}

test('fresh opening shares the existing followup read and stops at its captured revision while generation continues', async () => {
  const h = readingWindow(), first = h.source.read();
  await new Promise(resolve => setImmediate(resolve)); h.source.revision = 2;
  const latest = Array.from({ length: 20 }, () => h.source.read(true)), joined = h.source.read();
  h.release(0, 'old'); assert.equal((await first).chat.items[0].i, 'old'); assert.equal((await joined).chat.items[0].i, 'old');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(h.calls.length, 2);
  h.source.revision = 3; h.release(1, 'current');
  assert((await Promise.all(latest)).every(result => result.chat.items[0].i === 'current'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(h.calls.length, 3);
  const pending = h.source.read(); h.release(2, 'newer'); await pending;
});

test('cancelling a fresh consumer leaves the shared native read available to other consumers', async () => {
  const h = readingWindow(), first = h.source.read(), controller = new AbortController();
  await new Promise(resolve => setImmediate(resolve)); h.source.revision = 2;
  const fresh = cdpRead.run(controller.signal, () => h.source.read(true)); controller.abort(new Error('selection changed'));
  await assert.rejects(fresh, /selection changed/);
  h.release(0, 'old'); await first;
  await new Promise(resolve => setImmediate(resolve)); assert.equal(h.calls.length, 2);
  const next = h.source.read(); h.release(1, 'current'); assert.equal((await next).chat.items[0].i, 'current');
});

for (const app of ['cursor', 'devin']) test(`${app} latest reads share the existing followup and retain their catalog path`, async () => {
  const h = readingWindow(); h.source.win.app = app;
  const first = h.source.read(); await new Promise(resolve => setImmediate(resolve));
  h.source.revision = 2; const fresh = h.source.read(true);
  h.release(0, 'old'); await first; await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 2); h.release(1, 'current');
  assert.equal((await fresh).chat.items[0].i, 'current'); assert.equal(h.source.catalog.length, 0);
});

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
  const method = part(read('server/apps/codex.mjs'), 'async codexRenameThread(', '\nasync codexArchiveThread(').replace(/,\s*$/, '');
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

function previews({ saved, chatPreviews = null, now = 1000 } = {}) {
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
    idbGet: async key => key === 'computer-resumes' ? saved : key === 'chat-previews' ? chatPreviews : null,
    scClearing: () => false,
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

test('a late persisted Codex preview cannot replace the live snapshot already received for that selection', async () => {
  let release;
  const chatPreviews = new Promise(resolve => { release = resolve; }), h = previews({ chatPreviews });
  await h.ready();
  const sel = 'codex|window|A', live = { thread: 'A', items: [{ i: 'latest', k: 'human', order: 20000 }] };
  h.context.cacheChat(sel, live);
  release([['A|' + sel, { thread: 'A', items: [{ i: 'older', k: 'human', order: 90000 }] }]]);
  await vm.runInContext('chatPreviewReady', h.context);
  assert.equal(h.context.chatBySel.get('A|' + sel), live);
});

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

test('changed-file controls retain session and computer ownership outside the queue bar', () => {
  const packets = [], nodes = { changeNotice: { hidden: true }, queueBar: { innerHTML: '', classList: { toggle(_, visible) { this.visible = visible; } } } };
  const context = vm.createContext({
    $: id => nodes[id], computer: 'A', viewSel: 'codex|window|one', sheetKind: null, chatStale: false,
    currentComputer() { return { id: context.computer }; }, lastChat: { changed: 12345, queued: [] }, subsOpen: false, queueOpen: false,
    queuedMessages: () => ({ count: 0 }), I18N: { tr: value => value }, esc: value => value,
    fileEntryIcon: () => '<svg></svg>', ibtn: (_, label, attrs) => `<button ${attrs}>${label}</button>`,
    document: { body: { classList: { contains: () => false } }, dispatchEvent() {} }, Event,
    status() {}, send: message => packets.push(message),
  });
  const history = read('app/js/history.js');
  vm.runInContext(part(history, 'const hiddenChangeNotices = new Set();', 'function queuedMessages(')
    + part(history, 'function renderQueue(', 'let queueEditRequest = null;')
    + part(history, "$('changeNotice').onclick =", "$('queueBar').onclick ="), context);
  const render = () => context.renderQueue(false, [], [], false, context.lastChat.changed);
  const click = dataset => nodes.changeNotice.onclick({ target: { closest: () => ({ dataset }) } });
  render();
  assert.equal(nodes.changeNotice.hidden, false);
  assert.match(nodes.changeNotice.innerHTML, /aria-label="改动了 12345 个文件 ›"/);
  assert.equal(nodes.queueBar.innerHTML, ''); assert.equal(nodes.queueBar.classList.visible, false);
  click({ changes: '' }); assert.deepEqual(JSON.parse(JSON.stringify(packets)), [{ t: 'changes' }]);
  context.toggleChangeNotice(); assert.equal(nodes.changeNotice.hidden, true);
  context.viewSel = 'codex|window|two'; render(); assert.equal(nodes.changeNotice.hidden, false);
  context.viewSel = 'codex|window|one'; render(); assert.equal(nodes.changeNotice.hidden, true);
  context.toggleChangeNotice(); assert.equal(nodes.changeNotice.hidden, false);
  context.computer = 'B'; render(); assert.equal(nodes.changeNotice.hidden, false);
  context.renderQueue(false, [], [], true, 12345); assert.equal(nodes.changeNotice.hidden, true);
  context.lastChat.changed = 0; render(); assert.equal(nodes.changeNotice.hidden, true);
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

test('CSS, Markdown, voice worklet and KaTeX assets use the current shell without a network wait', async () => {
  const h = shellWorker();
  for (const prefix of ['app.css?', 'markdown-it/', 'js/voice-worklet.js?', 'katex/katex.min.js', 'katex/katex.min.css', 'katex/fonts/']) {
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

test('cards retain editing while a draft is in flight and keep their shared input tools', () => {
  const button = (textContent = '') => ({ textContent, innerHTML: '<svg/>', title: '', ariaLabel: '', disabled: false });
  for (const row of [
    { app: 'codex', follow: 'queue', landscape: true, immediate: true },
    { app: 'codex', follow: 'steer', landscape: true, immediate: false },
    { app: 'devin', follow: '', landscape: true, immediate: true },
    { app: 'cursor', follow: '', landscape: true, immediate: false },
    { app: 'codex', follow: 'queue', landscape: false, immediate: true },
    { app: 'codex', follow: 'queue', landscape: false, immediate: true, pending: true },
    { app: 'codex', follow: 'queue', landscape: false, immediate: true, ready: false },
    { app: 'codex', follow: 'queue', landscape: false, ready: false, opening: { phase: 'opening', message: 'QA_OPENING' } },
    { app: 'codex', follow: 'queue', landscape: false, ready: false, opening: { phase: 'error', message: 'QA_OPEN_ERROR' } },
    { app: 'codex', follow: 'queue', landscape: false, ready: false, error: 'QA_CARD_ACTION_ERROR' },
  ]) {
    const nodes = new Map([['send', button('排队')], ['sendNow', { ...button('立即追加'), hidden: row.app === 'cursor' }], ['msg', { className: 'quiet' }]]);
    nodes.get('send').disabled = !!row.pending;
    if (row.opening) Object.assign(nodes.get('msg'), { className: 'err', textContent: 'QA_OTHER_STATUS' });
    const context = vm.createContext({
      $: id => nodes.get(id) || button(), esc: String, OV_ICON: { arrow: '<svg/>' }, OV_AGENT: { [row.app]: row.app },
      I18N: { tr: value => value }, ovT: value => value, ovBusy: new Set(),
      ovErr: new Map(row.error ? [['card', row.error]] : row.opening?.phase === 'error' ? [['card', row.opening.message]] : []),
      ovBadge: () => '运行中', ovTime: () => '1m', ovContext: () => 'project', ovComposerReady: () => row.ready !== false,
      ovRunHtml: () => '', ovPreviewHtml: () => '', ovChangesRow: () => '', ovOpenLink: () => '',
      ovTarget: value => value, ovOpenState: () => row.opening || null,
      queuedMessages: () => ({ count: 0 }), questionCompose: null, viewSel: 'selection',
      devinBusySplit: () => row.app === 'devin', cursorBusyQueue: () => row.app === 'cursor', codexFollow: () => row.follow,
      document: { body: { classList: { contains: () => row.landscape } } },
    });
    vm.runInContext(part(read('app/js/overview.js'), 'function ovCard(', 'function ovSessionGroup('), context);
    const html = context.ovCard({ key: 'card', state: 'run', app: row.app, actions: [] });
    assert.equal(html.includes('data-v="send"'), false);
    assert.equal(html.includes('data-v="sendNow"'), false);
    assert.equal(html.includes('data-ov="send"'), true);
    assert.equal(/<textarea[^>]*\bdisabled/.test(html), row.ready === false);
    assert.equal(/<button[^>]*class="ov-send"[^>]*\bdisabled/.test(html), row.ready === false || !!row.pending);
    assert(html.indexOf('class="ov-input-history"') < html.indexOf('<textarea'));
    for (const id of ['inputPrev', 'inputNext']) assert(html.indexOf(`data-v="${id}"`) < html.indexOf('<textarea'));
    assert(html.indexOf('data-v="insertNewline"') > html.indexOf('class="ov-tools"'));
    assert.equal(html.includes('ov-compose-more'), false);
    assert.equal((html.match(/class="ov-tool-status/g) || []).length, 1);
    if (row.opening) {
      assert(html.includes(row.opening.message)); assert(!html.includes('QA_OTHER_STATUS'));
      assert.equal(html.includes('class="ov-tool-status err"'), row.opening.phase === 'error');
      assert(!html.includes('ov-errbox'));
    }
    if (row.error) { assert(html.includes('ov-errbox')); assert(html.includes(row.error)); }
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

for (const app of ['codex', 'cursor', 'devin']) {
  test(`${app} registers one operation for repeated activation of one in-flight draft`, () => {
    const h = confirmation(); h.context.currentApp = app;
    h.nodes.send.onclick();
    const packet = h.packets[0];
    assert.equal(h.nodes.send.disabled, true); assert.equal(h.nodes.sendNow.disabled, true);
    h.nodes.send.onclick(); h.context.sendComposer();
    assert.equal(h.context.sendReceipt(h.context.text.value), null);
    h.context.setWindowReady(false); h.context.setWindowReady(true);
    assert.equal(h.nodes.send.disabled, true);
    assert.equal(h.packets.length, 1); assert.equal(h.context.pendingSends.size, 1);
    assert.equal(h.context.pendingSends.get(packet.requestId).text, 'draft from A');
    const session = { deviceId: crypto.randomUUID(), app, mode: 'chat', selectionKey: () => 'fixture' };
    assert.equal(beginOperation(session, packet).duplicate, false);
    assert.equal(beginOperation(session, packet).duplicate, true);
    h.context.confirmSent({ requestId: packet.requestId, sel: h.context.viewSel, queued: true });
    assert.equal(h.context.text.value, ''); assert.equal(h.context.pendingSends.size, 0);
    assert.equal(h.nodes.send.disabled, false);
  });
}

test('a new draft and an explicitly edited identical draft can send before an older receipt', () => {
  for (const value of ['new draft', 'draft from A']) {
    const h = confirmation(); h.context.sendComposer(); const first = h.packets[0];
    h.context.text.value = value; h.context.recordDraftEdit();
    assert.equal(h.nodes.send.disabled, false);
    h.context.sendComposer(); const second = h.packets[1];
    assert.notEqual(first.requestId, second.requestId); assert.notEqual(first.operationId, second.operationId);
    h.context.confirmSent({ requestId: first.requestId, sel: h.context.viewSel });
    assert.equal(h.context.text.value, value); assert.equal(h.nodes.send.disabled, true);
    h.context.confirmSent({ requestId: second.requestId, sel: h.context.viewSel });
    assert.equal(h.context.text.value, ''); assert.equal(h.nodes.send.disabled, false);
  }
});

test('unknown delivery stays with its request while explicit failure releases it for retry', () => {
  const h = confirmation(); h.context.sendComposer(); const request = h.packets[0].requestId;
  h.context.confirmSent({ requestId: request, pending: true, message: 'read unavailable' });
  h.context.disconnectPendingSends(); h.context.setWindowReady(false); h.context.setWindowReady(true);
  h.context.sendComposer();
  assert.equal(h.packets.length, 1); assert.equal(h.context.pendingSends.size, 1);
  assert.equal(h.nodes.send.disabled, true); assert.equal(h.context.text.value, 'draft from A');
  h.context.failPendingSend(request, 'not submitted');
  assert.equal(h.nodes.send.disabled, false); assert.equal(h.context.pendingSends.size, 0);
  h.context.sendComposer();
  assert.equal(h.packets.length, 2); assert.notEqual(h.packets[1].requestId, request);
  h.context.confirmSent({ requestId: request, sel: h.context.viewSel });
  assert.equal(h.nodes.send.disabled, true); assert.equal(h.context.pendingSends.size, 1);
});

test('new attachment or reference content is a new draft and old acceptance cannot clear it', () => {
  for (const change of ['attachment', 'reference']) {
    const h = confirmation(); h.context.desktopAttachments = [{ id: 'old' }]; h.context.sendComposer();
    const first = h.packets[0];
    h.context.desktopAttachments = []; h.context.document.dispatchEvent(new Event('composer-state'));
    assert.equal(h.nodes.send.disabled, true);
    if (change === 'attachment') h.context.desktopAttachments = [{ id: 'new' }];
    else h.context.mentionsFor = () => ({ mentions: [{ key: 'new-reference' }] });
    h.context.document.dispatchEvent(new Event('composer-state'));
    assert.equal(h.nodes.send.disabled, false); h.context.sendComposer(); const second = h.packets[1];
    h.context.confirmSent({ requestId: first.requestId, sel: h.context.viewSel });
    assert.equal(h.context.text.value, 'draft from A'); assert.equal(h.nodes.send.disabled, true);
    assert.equal(h.context.drafts.get(h.context.activeDraft), 'draft from A');
    h.context.confirmSent({ requestId: second.requestId, sel: h.context.viewSel });
    assert.equal(h.context.text.value, ''); assert.equal(h.nodes.send.disabled, false);
  }
});

test('Enter event overlap and an immediate-action confirmation share the same in-flight draft', async () => {
  const h = confirmation(), source = read('app/js/composer.js');
  vm.runInContext(part(source, 'let composing = false;', 'function composerInputEvent('), h.context);
  vm.runInContext(`composerInputHandlers.keydown({key:'Enter',target:text,preventDefault(){}});
    composerInputHandlers.beforeinput({inputType:'insertLineBreak',target:text,preventDefault(){}});`, h.context);
  assert.equal(h.packets.length, 1);
  const other = confirmation(), work = other.context.sendComposerNow();
  other.context.sendComposer(); other.accept(); await work;
  assert.equal(other.packets.length, 1); assert.equal(other.context.pendingSends.size, 1);
});

test('Question and terminal actions remain available and stop settles its pending chat request', async () => {
  const h = confirmation(); h.context.sendComposer();
  h.context.questionCompose = { sel: h.context.viewSel }; let answers = 0;
  h.context.submitQuestionCompose = () => { answers++; };
  h.context.document.dispatchEvent(new Event('composer-state'));
  h.context.sendComposer(); assert.equal(answers, 1); assert.equal(h.packets.length, 1);
  h.context.questionCompose = null; h.change('mode'); let terminal = 0;
  h.context.sendTerminalInput = () => { terminal++; }; h.context.sendComposer(); assert.equal(terminal, 1);
  const stopped = confirmation(); stopped.context.sendComposer();
  const work = stopped.nodes.stop.onclick(); stopped.accept(); await work;
  assert.equal(stopped.context.pendingSends.size, 0); assert.equal(stopped.nodes.send.disabled, false);
  assert.equal(stopped.packets.at(-1).t, 'stop');
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

function questionCards(requests) {
  const handlers = new Map(), fields = [], buttons = [], packets = [];
  const bar = {
    innerHTML: '', classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(type, handler) { handlers.set(type, handler); },
    setAttribute() {}, contains: () => false, querySelector: () => null,
    querySelectorAll: selector => selector === '[data-field]' ? fields : selector === '[data-action]' ? buttons
      : selector === 'button,input,select' ? [...buttons, ...fields] : [],
  };
  for (const request of requests) {
    const actions = request.buttons.map((button, n) => {
      const node = { ...button, dataset: { request: request.id, action: String(n) },
        closest: selector => selector === '[data-question-compose]' ? null : node,
        click() {
          if (node.disabled) return;
          const event = { target: node };
          handlers.get('click')(event); bar.onclick(event);
        },
      };
      buttons.push(node); return node;
    });
    for (const [n, field] of request.fields.entries()) {
      const node = { value: field.value, dataset: { request: request.id, field: String(n) }, tagName: 'INPUT', disabled: false,
        matches: selector => selector === 'input' || selector === '[data-field]',
        closest: () => ({ querySelector: () => actions.at(-1) }),
        blur() { node.blurred = true; }, focus() {}, setSelectionRange() {},
      };
      fields.push(node);
    }
  }
  const text = { value: '普通聊天草稿' };
  const context = vm.createContext({
    $: () => bar, document: { activeElement: null, body: { classList: { contains: () => false } } },
    currentApp: 'codex', viewSel: 'codex|window|thread', mode: 'chat', questionCompose: null, text,
    ws: { readyState: 1 }, authed: true, windowReady: true, crypto: crypto.webcrypto,
    esc: value => String(value), updateComposeCompact() {}, status() {}, send: packet => packets.push(packet),
  });
  const source = read('app/js/history.js');
  vm.runInContext(part(source, "$('qnBar').addEventListener('click'", '// Small stroke icons'), context);
  context.renderQuestions({ codex: true, requests });
  return { bar, text, fields, buttons, packets,
    enter(target, extra = {}) {
      let prevented = false;
      handlers.get('keydown')({ key: 'Enter', target, isComposing: false, preventDefault() { prevented = true; }, ...extra });
      return prevented;
    },
  };
}

const questionRequest = (id, submit = 'Send', value = '') => ({
  id, text: '测试问题', fields: [{ label: '回答', value, type: 'text' }],
  buttons: [{ label: '预设选项', disabled: false }, { label: 'Skip', disabled: false }, { label: submit, disabled: !value }],
});

test('Codex Question cards expose only skip and native next or send actions', () => {
  const h = questionCards([questionRequest('async:first', 'Next'), questionRequest('async:second')]);
  const actions = [...h.bar.innerHTML.matchAll(/<div class="qnAct">([\s\S]*?)<\/div>/g)]
    .map(row => [...row[1].matchAll(/<button\b[^>]*>(.*?)<\/button>/g)].map(button => button[1]));
  assert.deepEqual(actions, [['Skip', 'Next'], ['Skip', 'Send']]);
  assert.equal((h.bar.innerHTML.match(/class="qnOpt /g) || []).length, 2);
});

test('Question Enter sends the edited answer once to its own request and preserves the chat draft', () => {
  const h = questionCards([questionRequest('async:first', 'Next'), questionRequest('async:second')]);
  const field = h.fields[1]; field.value = '卡片中的回答'; field.oninput();
  assert.equal(h.enter(field), true); h.enter(field);
  assert.equal(h.packets.length, 1);
  const packet = JSON.parse(JSON.stringify(h.packets[0]));
  assert.equal(packet.t, 'codexRequest'); assert.equal(packet.id, 'async:second'); assert.equal(packet.n, 2);
  assert.deepEqual(packet.fields, [{ n: 0, value: '卡片中的回答' }]);
  assert.equal(typeof packet.requestId, 'string');
  assert.equal(h.text.value, '普通聊天草稿'); assert.equal(field.blurred, undefined);
});

test('Question Enter respects disabled submit and IME, then uses the native next action', () => {
  const h = questionCards([questionRequest('async:first', 'Next')]), field = h.fields[0];
  h.enter(field); assert.equal(h.packets.length, 0);
  field.value = '下一题答案'; field.oninput();
  assert.equal(h.enter(field, { isComposing: true }), false);
  assert.equal(h.packets.length, 0); assert.equal(field.blurred, undefined);
  h.enter(field);
  assert.equal(h.packets.length, 1); assert.equal(h.packets[0].id, 'async:first'); assert.equal(h.packets[0].n, 2);
  assert.equal(h.packets[0].fields[0].value, '下一题答案');
});

test('Question Enter retains approval field blur and the existing free-answer fill action', () => {
  const h = questionCards([questionRequest('approval:exec', 'Approve', '执行理由')]);
  h.enter(h.fields[0]);
  assert.equal(h.fields[0].blurred, true); assert.equal(h.packets.length, 0);
  let filled = 0;
  h.enter({ dataset: {}, matches: () => true, nextElementSibling: { click: () => filled++ } });
  assert.equal(filled, 1); assert.equal(h.packets.length, 0);
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

function systemVoice() {
  const h = voiceComposer(), { context } = h, recognitions = [], timers = new Map(), classes = new Set(), attributes = {};
  let now = 0, timer = 0;
  const mic = { hidden: false, classList: { add: c => classes.add(c), remove: c => classes.delete(c) },
    setAttribute: (k, v) => { attributes[k] = v; } };
  const message = { textContent: '', className: '' }, document = new EventTarget(), textEvents = new EventTarget();
  const mirror = h.text.dispatchEvent.bind(h.text);
  h.text.addEventListener = textEvents.addEventListener.bind(textEvents);
  h.text.dispatchEvent = e => { mirror(e); return textEvents.dispatchEvent(e); };
  class Recognition {
    constructor() { this.calls = []; recognitions.push(this); }
    start() { this.calls.push('start'); if (context.startError) throw Object.assign(new Error('test startup'), { name: context.startError }); }
    stop() { this.calls.push('stop'); }
    abort() { this.calls.push('abort'); }
    emit(type, data = {}) { this['on' + type]?.(data); }
    result(value, final = false) { this.emit('result', { resultIndex: 0, results: [Object.assign([{ transcript: value }], { isFinal: final })] }); }
  }
  Object.assign(context, { voiceSession: null, voiceCatalog: { key: 'qa-engine', engines: [] }, systemVoiceTrace: null,
    document, $: id => id === 'mic' ? mic : message, windowReady: true, mode: 'chat', viewSel: 'codex|window-A|thread-A',
    currentComputer: () => ({ id: 'computer-A' }), voiceEngineKey: () => 'qa-engine', voiceEngine: () => 'system', voiceEnabled: () => true,
    SYSTEM_ENGINE: 'system', systemRecognition: () => Recognition, composerInput: () => h.input, I18N: { speech: 'zh-CN', tr: String }, esc: String,
    performance: { now: () => now }, ACTION_PENDING: new Set(),
    setTimeout: (fn, delay) => { const id = ++timer; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id), openSheet: (_kind, html) => { h.menu = html; } });
  vm.runInContext(part(read('app/js/core.js'), 'let statusGen = 0;', 'function finishPending(')
    + part(read('app/js/local-voice.js'), 'function voiceScope(', 'function prepareVoiceAudio(')
    + part(read('app/js/local-voice.js'), 'async function startVoice(', 'async function showLocalVoiceMenu(')
    + part(read('app/js/local-voice.js'), "text.addEventListener('input', () => { if (voiceSession", "for (const event of ['focus', 'input'])"), context);
  return { ...h, get menu() { return h.menu; }, recognitions, message, classes, attributes,
    press: () => context.startVoice({ button: 0, pointerId: null, preventDefault() {} }), release: () => context.endVoice(),
    advance(ms) { now += ms; for (const [id, t] of timers) if (t.at <= now) { timers.delete(id); t.fn(); } },
  };
}

test('system dictation waits for actual audio and retains the active status beyond the ordinary notice lifetime', async () => {
  const h = systemVoice(); await h.press(); const r = h.recognitions[0];
  assert.equal(h.message.textContent, '正在启动系统语音…'); assert.equal(h.classes.has('on'), false);
  h.advance(4000); assert.equal(h.message.textContent, '正在启动系统语音…');
  r.emit('start'); assert.equal(h.message.textContent, '系统识别已启动，等待麦克风…');
  r.emit('audiostart'); assert.equal(h.classes.has('on'), true); assert(h.message.textContent.startsWith('正在听'));
  h.advance(4000); assert(h.message.textContent.startsWith('正在听')); assert.equal(h.classes.has('on'), true);
  r.emit('soundstart'); assert.equal(h.message.textContent, '已检测到声音，等待识别…');
  r.emit('speechstart'); assert.equal(h.message.textContent, '已检测到语音，正在识别…');
  h.release(); assert.deepEqual(r.calls, ['start', 'stop']); assert.equal(h.classes.has('on'), false);
  h.advance(4000); assert.equal(h.message.textContent, '录音已结束，正在完成转录…');
  r.emit('end'); assert.equal(h.context.voiceSession, null); assert.equal(h.message.textContent, '没有识别到语音，请重试');
});

test('one deliberate system retry cancels the old recognizer and retains its transcript without accepting its late callbacks', async () => {
  const h = systemVoice(); await h.press(); const old = h.recognitions[0];
  old.emit('audiostart'); old.result(' first'); h.release(); await h.press();
  assert.equal(h.recognitions.length, 2); assert.deepEqual(old.calls, ['start', 'stop', 'abort']);
  const current = h.context.voiceSession, status = h.message.textContent, trace = h.context.systemVoiceTrace;
  old.result(' old'); old.emit('error', { error: 'network' }); old.emit('end');
  assert.equal(h.context.voiceSession, current); assert.equal(h.message.textContent, status); assert.equal(h.context.systemVoiceTrace, trace);
  assert.equal(h.text.value, 'saved first');
  h.recognitions[1].emit('audiostart'); h.recognitions[1].result(' second', true); h.release(); h.recognitions[1].emit('end');
  assert.equal(h.text.value, 'saved first second'); assert.equal(h.input.value, h.text.value);
  assert.equal(h.message.textContent, '转录完成，可编辑后发送'); assert.equal(h.context.voiceSession, null);
});

test('late start and speech events do not regress audio capture or restart capture after release', async () => {
  const h = systemVoice(); await h.press(); const r = h.recognitions[0];
  r.emit('audiostart'); const listening = h.message.textContent; r.emit('start'); assert.equal(h.message.textContent, listening);
  r.emit('audioend'); const finishing = h.message.textContent; r.emit('speechstart');
  assert.equal(h.message.textContent, finishing); assert.equal(h.classes.has('on'), false);
  h.release(); h.release(); assert.deepEqual(r.calls, ['start', 'stop']);
  const early = systemVoice(); await early.press(); early.release();
  early.recognitions[0].emit('start'); early.recognitions[0].emit('audiostart'); early.recognitions[0].emit('speechstart');
  assert.equal(early.message.textContent, '录音已结束，正在完成转录…'); assert.equal(early.classes.has('on'), false);
  assert.deepEqual(early.recognitions[0].calls, ['start', 'stop']);
});

test('system cancellation ends only its own status and releases ownership before notifying composer observers', async () => {
  const h = systemVoice(); await h.press(); h.recognitions[0].emit('audiostart');
  let observed; h.context.document.addEventListener('composer-state', () => { observed = h.context.voiceSession; });
  h.context.cancelVoice(); assert.equal(h.context.voiceSession, null); assert.equal(observed, null);
  assert.equal(h.message.textContent, ''); assert.equal(h.classes.has('on'), false);
  await h.press(); h.context.status('别的操作失败', false); h.context.cancelVoice();
  assert.equal(h.message.textContent, '别的操作失败'); assert.equal(h.message.className, 'err');
  const publishing = systemVoice();
  publishing.context.document.addEventListener('composer-state', () => publishing.context.cancelVoice(), { once: true });
  await publishing.press(); assert.equal(publishing.context.voiceSession, null); assert.equal(publishing.message.textContent, '');
  assert.deepEqual(publishing.recognitions[0].calls, ['start', 'abort']);
});

test('editing or changing a dictation target preserves the edited draft and rejects transcripts from the old scope', async () => {
  const h = systemVoice(); await h.press(); const old = h.recognitions[0];
  old.emit('audiostart'); h.text.value = 'manually edited'; h.text.dispatchEvent(new Event('input'));
  assert.equal(h.context.voiceSession, null); old.result(' late'); assert.equal(h.text.value, 'manually edited');
  await h.press(); const r = h.recognitions[1], status = h.message.textContent;
  h.context.viewSel = 'codex|window-A|thread-B'; r.result(' wrong target'); r.emit('error', { error: 'network' }); r.emit('end');
  assert.equal(h.text.value, 'manually edited'); assert.equal(h.message.textContent, status);
  h.context.cancelVoice(); assert.equal(h.context.voiceSession, null); assert.equal(h.message.textContent, '');
});

test('system error codes and synchronous startup failures release the recognizer without retrying or replacing the draft', async () => {
  for (const code of ['network', 'audio-capture', 'no-speech', 'not-allowed', 'service-not-allowed', 'aborted', 'language-not-supported']) {
    const h = systemVoice(); await h.press(); const r = h.recognitions[0];
    r.emit('error', { error: code }); const error = h.message.textContent; r.emit('end');
    assert(error.includes(code)); assert.equal(h.context.voiceSession, null); assert.equal(h.classes.has('on'), false);
    assert.equal(h.context.systemVoiceTrace.error, code); assert.equal(h.text.value, 'saved');
    assert.equal(h.message.textContent, error); assert.equal(h.recognitions.length, 1); assert.equal(h.message.className, 'err');
  }
  const h = systemVoice(); h.context.startError = 'InvalidStateError'; await h.press();
  assert.equal(h.context.voiceSession, null); assert.equal(h.context.systemVoiceTrace.error, 'InvalidStateError');
  assert(h.message.textContent.includes('InvalidStateError')); assert.equal(h.recognitions.length, 1);
});

test('the existing voice menu shows only the latest bounded event summary and never contains the draft or transcript', async () => {
  const h = systemVoice(); h.text.value = 'private draft'; h.text.selectionStart = h.text.selectionEnd = h.text.value.length;
  await h.press(); const r = h.recognitions[0]; h.advance(20); r.emit('audiostart'); h.advance(10); r.result(' private transcript');
  h.release(); r.emit('end'); h.context.renderVoiceMenu();
  assert(h.menu.includes('id="systemVoiceDetails"')); assert(h.menu.includes('开始采音 +20ms')); assert(h.menu.includes('返回文字 +30ms'));
  assert(!h.menu.includes('private')); assert(!JSON.stringify(h.context.systemVoiceTrace).includes('private'));
  await h.press(); h.context.renderVoiceMenu(); assert(!h.menu.includes('返回文字 +')); assert.equal(h.recognitions.length, 2);
});

test('computer dictation retains its explicit cancel-before-rerecord interaction', async () => {
  const h = systemVoice(); h.context.voiceEngine = () => 'qwen'; h.context.voiceSession = { held: false };
  await h.press(); assert.equal(h.context.voiceSession, null); assert.equal(h.recognitions.length, 0);
  assert.equal(h.message.textContent, '已取消等待转录，请重新按住录音');
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
  vm.runInContext(part(source, 'function fusionUsageBars(', 'function showTerminals(')
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

test('OpenCode context preserves native token details and distinguishes unknown usage from zero', () => {
  const h = usageMeters();
  h.context.renderContext({ source: 'opencode', used: null, limit: 131072, pct: null, basis: 'used', model: 'Bonsai', updated: null });
  assert.equal(h.node('meterCtxPct').textContent, '尚未统计 / 128K');
  const usage = { source: 'opencode', used: 8000, limit: 131072, pct: 6.1, basis: 'used', model: 'Bonsai', updated: 123456789 };
  h.context.renderContext(usage);
  assert.deepEqual(h.data().context, usage);
  assert.equal(h.node('meterCtxPct').textContent, '已用6.1%');
  assert.match(h.node('meterCtx').title, /上次调用/);
  let sheet, message;
  Object.assign(h.context, { openSheet: (_kind, html) => { sheet = html; }, closeSheet() {}, send: m => { message = m; } });
  vm.runInContext(part(read('app/js/sheets.js'), 'function showUsageDetails(', 'function menuGroup('), h.context);
  h.context.showUsageDetails('context');
  assert.match(sheet, /8000 \/ 131072 tokens/);
  assert.match(sheet, /Bonsai/);
  h.node('refreshUsage').onclick();
  assert.equal(message.t, 'usage');
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

function relayHeartbeat({ needsTwoFactor = false } = {}) {
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
    stopTerminalUpdates() {}
    dispose() { this.disposed = true; }
  }
  const context = vm.createContext({
    crypto, Buffer, URL, AbortController, Session, WebSocketServer: Server,
    Date: class extends Date { static now() { return now; } },
    setTimeout: schedule, clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, true), clearInterval: id => timers.delete(id),
    console: { log: message => logs.push(message) }, voiceWss: () => new EventEmitter(),
    findDevice: token => token === 'fixture-token' ? device : null, needsTotp: () => needsTwoFactor,
    computerId: () => 'fixture-computer', computerName: () => 'Fixture', updateDevice() {},
    bindDeviceConnection(_id, close) { const binding = { valid: true, close, release() {} }; bindings.push(binding); return binding; },
    subscribeLibrary() {}, subscribeOperations: () => () => {}, lastSelection: () => null,
    addViewer() {}, removeViewer() {}, clientIp: () => 'fixture', originAllowed: () => true,
    ROUTES: { visible: { connection: true } }, flag, configureNativeRetry() {},
    beginOperation, withOperation, cdpRead: new AsyncLocalStorage(),
  });
  const strip = source => source.replace(/^import .*;\n/gm, '').replace(/\bexport /g, '');
  vm.runInContext(strip(read('lib/device-proof.mjs')) + strip(read('server/ws.mjs')), context);
  context.attachWss(new EventEmitter());
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return {
    logs, sessions, settle, routes: context.ROUTES,
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

test('returning from terminal finishes chat mode restoration before a following native attachment', async () => {
  const h = relayHeartbeat(), socket = await h.socket(), session = h.bind(socket), trace = [];
  let finishRead;
  const reading = new Promise(resolve => { finishRead = resolve; });
  session.mode = 'terminal';
  session.setMode = async mode => { session.mode = mode; trace.push('mode-start'); await reading; trace.push('mode-end'); };
  session.handle = async message => { if (message.t === 'mode') return ROUTES.mode.pre(session, message); trace.push('attach'); };
  session.finishNavigationResult = () => {};
  h.routes.mode = ROUTES.mode;
  h.routes.attach = { navigation: true };
  socket.receive({ t: 'mode', mode: 'chat' });
  socket.receive({ t: 'attach', id: 'codex', navigationId: 1 });
  await h.settle();
  assert.deepEqual(trace, ['mode-start']);
  finishRead(); await h.settle(); await h.settle();
  assert.deepEqual(trace, ['mode-start', 'mode-end', 'attach']);
});

test('a stale terminal input error remains scoped and never overwrites the current chat status', async () => {
  const h = relayHeartbeat(), socket = await h.socket(), session = h.bind(socket);
  session.emit = message => socket.send(JSON.stringify(message));
  h.routes.termWrite = ROUTES.termWrite;
  socket.receive({ t: 'termWrite', id: 'old-terminal', subscription: 'old-subscription', data: 'never sent' });
  await h.settle();
  const errors = socket.sent.filter(message => message.t === 'termError');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].id, 'old-terminal'); assert.equal(errors[0].subscription, 'old-subscription');
  assert.equal(socket.sent.filter(message => message.t === 'status').length, 0);
});

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

function overviewDirectory() {
  const targets = [], sources = new Map(), catalogs = new Map(), library = {}, saved = { windows: {} }, fusionRuns = {};
  const context = vm.createContext({ path, Date, process: { platform: 'linux' }, saved, fusionRuns,
    openCode: { overview: () => ({ windows: [], sessions: [] }) },
    key: (app, id) => app + ':' + id.replace(/^(cursor|devin|codex):/, ''),
    nativeTargets: () => targets, nativeWindowAt: id => sources.get(id), nativeSessionCatalog: app => catalogs.get(app),
    sessionId: (_app, id) => id || '', readLibrary: () => library, storedProjectSession: () => null,
    normPath: value => String(value || '').replaceAll('\\', '/'), pathKey: value => value,
    samePath: (a, b) => a === b, windowName: title => title, workspaces: () => { throw Error('Do not rescan workspace storage'); },
    FUSION_ACTIVE: [], fusionSummary: value => value, allFusionRuns: () => Object.values(fusionRuns).flatMap(value => value.runs),
    fusionMainWindow: (app, id) => Object.values(fusionRuns).flatMap(value => value.runs).some(run => run.bindings.some(binding => binding.role === 'main' && binding.app === app && binding.windowId === id)),
  });
  vm.runInContext(part(read('lib/files.mjs'), 'export function workspaceLabel(', '// Returns the size').replace('export ', '')
    + part(read('server/project-windows.mjs'), 'export function fusionTargets(', 'export function clearLegacyFusionWindows(').replace('export ', '')
    + read('server/overview.mjs').replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), context);
  return { targets, sources, catalogs, library, saved, fusionRuns,
    add(app, id, root = '/project/remote-agent', host = '') {
      targets.push({ app, id: app + ':' + id, pageId: id, title: 'workspace alias', ws: id });
      const source = { roots: [{ root, host }], catalog: [], previews: new Map(), updatedAt: 100, snapshot: { chat: {}, states: [] },
        overviewStates() { return this.snapshot?.states || []; } };
      sources.set(id, source); return source;
    }, snapshot: () => JSON.parse(JSON.stringify(context.overviewSnapshot('device'))) };
}

test('ordinary windows for one actual project produce one session and keep its live source', () => {
  const h = overviewDirectory();
  h.add('codex', 'ordinary');
  const live = h.add('codex', 'other-title');
  live.snapshot = { chat: { thread: 'same-thread' }, states: [{ thread: 'same-thread', busy: true, run: { id: 'turn', status: 'running', startedAt: 10 } }] };
  h.catalogs.set('codex', { rows: [{ id: 'same-thread', workspace: '/project/remote-agent', running: false }] });
  const result = h.snapshot();
  assert.equal(result.windows.length, 1); assert.equal(result.windows[0].project, 'remote-agent');
  assert.equal(result.sessions.length, 1); assert.equal(result.sessions[0].windowId, 'other-title');
  assert.equal(result.sessions[0].busy, true); assert.equal(result.sessions[0].run.id, 'turn');
});

test('a temporarily unreadable selected window cannot replace confirmed native facts from another source', () => {
  const h = overviewDirectory(), selected = h.add('codex', 'selected'), confirmed = h.add('codex', 'confirmed');
  selected.snapshot = { chat: { thread: 'thread' }, states: [{ thread: 'thread', run: { id: 'turn', status: 'unknown', startedAt: 100 } }] };
  confirmed.snapshot = { chat: {}, states: [{ thread: 'thread', run: { id: 'turn', status: 'completed', startedAt: 100, completedAt: 200 } }] };
  h.catalogs.set('codex', { rows: [{ id: 'thread', workspace: '/project/remote-agent', running: false }] });
  const result = h.snapshot();
  assert.equal(result.sessions.length, 1); assert.equal(result.sessions[0].windowId, 'confirmed');
  assert.equal(result.sessions[0].run.status, 'completed');
});

test('Fusion workers stay outside ordinary cards while shared windows and main favorites remain ordinary', () => {
  const h = overviewDirectory(); h.add('codex', 'ordinary'); h.add('codex', 'fusion');
  h.saved.windows['codex:fusion'] = { app: 'codex', id: 'fusion', purpose: 'fusion' };
  h.fusionRuns.device = { runs: [{ updated: Date.now(), bindings: [{ role: 'B1', app: 'codex', threadId: 'fusion-thread' },
    { role: 'main', app: 'codex', threadId: 'ordinary-thread', windowId: 'ordinary' }] }] };
  h.catalogs.set('codex', { rows: ['ordinary-thread', 'fusion-thread'].map(id => ({ id, workspace: '/project/remote-agent', running: false })) });
  h.library.codex = { 'fusion-thread': { favorite: true }, 'ordinary-thread': { favorite: true } };
  const result = h.snapshot();
  assert.deepEqual(result.windows.map(row => row.windowId), ['ordinary']);
  assert.deepEqual(result.sessions.map(row => row.threadId), ['ordinary-thread']);
  assert.equal(result.sessions[0].favorite, true);
  assert.equal(result.fusion.length, 1);
});

test('project identity separates software, directories and hosts even with equal titles', () => {
  const h = overviewDirectory();
  h.add('codex', 'one', '/one/same'); h.add('codex', 'two', '/two/same'); h.add('cursor', 'three', '/one/same');
  h.add('codex', 'remote', '/one/same', 'ssh-host');
  h.catalogs.set('codex', { rows: [
    { id: 'a', workspace: '/one/same', running: false }, { id: 'b', workspace: '/two/same', running: false },
    { id: 'a', workspace: '/one/same', host: 'ssh-host', running: false },
  ] });
  h.catalogs.set('cursor', { rows: [{ id: 'c', workspace: '/one/same', running: false }] });
  const result = h.snapshot();
  assert.equal(new Set(result.windows.map(row => row.projectId)).size, 4);
  assert.equal(new Set(result.windows.map(row => row.project)).size, 3);
});

test('available directories do not wait for chat extraction or another window readiness', () => {
  const h = overviewDirectory(); const source = h.add('codex', 'ready'); source.snapshot = null;
  h.catalogs.set('codex', { rows: [{ id: 'thread', workspace: '/project/remote-agent', running: false }] });
  assert.equal(h.snapshot().ready, true); assert.equal(h.snapshot().sessions.length, 1);
  h.add('cursor', 'not-ready').roots = undefined;
  const result = h.snapshot();
  assert.equal(result.ready, false); assert.equal(result.partial, true); assert.equal(result.pendingWindows, 1);
  assert.equal(result.sessions.length, 1);
});

function overviewCards(saved = new Map()) {
  const source = read('app/js/overview.js'), notifications = [], opened = [], handlers = new Map();
  const entry = { id: 'computer', c: { key: 'paired' } }, state = { fetched: false, prev: new Map(), first: new Map(), offset: 0 };
  const context = vm.createContext({ Date, computerSockets: new Map(), saveComputerResume() {},
    ovComputerStatus: () => 'online', agentSessionCommon: () => true, ovNotify: (record, kind) => notifications.push({ thread: record.threadId, kind }),
    ovPrune() {}, store: { get: key => saved.get(key), set: (key, value) => saved.set(key, value) },
    ovS: { level: 'favorites' }, ovSessTile: row => row.key, ovEmpty: value => value, ovT: value => value, ovProjTile: project => project.key,
    $: () => ({ addEventListener: (type, handler) => handlers.set(type, handler) }),
    ovHeld: '', ovBatch: null, ovSaveHistory() {}, ovRender() {}, ovCancelOpening() {}, ovOpen: target => opened.push(target),
    ovRecs: () => context.ovRecsOf(entry, state),
  });
  vm.runInContext(part(source, 'const ovDone =', 'let ovEnterRequested =')
    + part(source, 'const OV_RANK =', 'const OV_AGENT =') + part(source, 'const ovNativeKey =', 'const ovCompName =')
    + part(source, 'function ovRecsOf(', 'const ovRecs =') + part(source, 'function ovApply(', 'function ovNotify(')
    + part(source, 'function ovMarkRead(', 'function ovStartBatch(')
    + part(source, 'function ovBoard(', 'function ovPlan(') + part(source, 'function ovProjectTiles(', 'function ovSessTile(')
    + part(source, "$('overview').addEventListener('click'", "$('overview').addEventListener('change'")
    + '\nthis.aggregate = ovAggregate; this.done = ovDone;', context);
  return { context, done: context.done, notifications, opened, saved, entry,
    apply(change = {}) { context.ovApply(entry, state, { now: Date.now(), sessions: [{ app: 'codex', projectId: 'project', windowId: 'window',
      threadId: 'thread', statusKnown: true, ...change }], fusion: [{ id: 'fusion-run' }] }); },
    rows: () => context.ovRecsOf(entry, state),
    click(action = 'full') {
      const row = context.ovRecsOf(entry, state)[0];
      const el = { dataset: { ov: action, id: row.key, t: JSON.stringify({ computer: row.comp, windowId: row.windowId, threadId: row.threadId }) },
        closest: selector => selector === '[data-ov]' ? el : null };
      handlers.get('click')({ target: el });
    },
  };
}

test('marking a completed card read persists locally, updates its project and allows a new completed turn', () => {
  const h = overviewCards();
  h.apply({ busy: true, run: { id: 'turn', status: 'running', startedAt: 100 } });
  h.apply({ run: { id: 'turn', status: 'completed', startedAt: 100 } });
  const key = h.rows()[0].key;
  h.done['other-computer|project|thread'] = { runId: 'other-turn', at: Date.now() };
  assert.equal(h.context.ovMarkRead(key), true);
  assert.equal(h.rows()[0].state, 'idle'); assert.equal(h.context.aggregate(h.rows()).state, 'idle');
  assert.equal(h.context.ovMarkRead(key), false); assert.equal(h.opened.length, 0);
  assert.equal(JSON.parse(h.saved.get('ov-done'))['other-computer|project|thread'].runId, 'other-turn');
  h.apply({ run: { id: 'turn', status: 'completed', startedAt: 100 } });
  assert.equal(h.rows()[0].state, 'idle'); assert.equal(h.notifications.length, 1);
  const reload = overviewCards(h.saved);
  reload.apply({ run: { id: 'turn', status: 'completed', startedAt: 100 } });
  assert.equal(reload.rows()[0].state, 'idle');
  reload.apply({ run: { id: 'next-turn', status: 'completed', startedAt: 200 } });
  assert.equal(reload.rows()[0].state, 'done'); assert.equal(reload.notifications.length, 1);
});

test('only completed overview cards offer a local read action without binding or managing the native session', async () => {
  const source = read('app/js/sheets.js'); let html = '', reads = 0, renders = 0, closes = 0;
  const context = vm.createContext({ agentActionTarget: null, esc: value => value, ovCompName: () => 'computer', ovAgName: () => 'Cursor',
    openSheet(_kind, body) { html = body; }, sheetKind: 'agent-actions', currentApp: 'cursor', projectEntry: null,
    closeSheet() { closes++; }, ovMarkRead(key) { assert.equal(key, 'card'); reads++; return true; }, ovRender() { renders++; },
    send: () => assert.fail('read must not send'), ovSessionRequest: () => assert.fail('read must not manage a native session'),
  });
  vm.runInContext(part(source, 'function showAgentActions(', 'function receiveAgentActions('), context);
  for (const state of ['done', 'idle', 'run', 'wait', 'err', 'unknown']) {
    context.showAgentActions('thread', 'title', [], { key: 'card', state, app: 'cursor', comp: 'computer', off: true });
    assert.equal(html.includes('data-agent-action="read"'), state === 'done');
  }
  context.showAgentActions('thread', 'title', [], { key: 'card', state: 'done', app: 'cursor', comp: 'computer', off: true });
  const notify = read('app/js/notify.js');
  const action = vm.runInContext('(async function(b) {' + part(notify, "  if (sheetKind === 'agent-actions'", "  if ('modelBack' in b.dataset)") + '})', context);
  await action({ dataset: { agentAction: 'read' } });
  assert.equal(reads, 1); assert.equal(renders, 1); assert.equal(closes, 1);
});

test('an already-ready Codex project checks native startup immediately without entering its wait loop', async () => {
  let reads = 0;
  const session = { windowId: 'window', editorCdp: {}, cdp: { wsUrl: 'chat', async evaluate(expression, options) {
    assert(expression.endsWith('.agentStartupState("codex", true)')); assert(options.timeout > 0 && options.timeout <= 25000);
    reads++; return { thread: 'thread' };
  } }, checkCodexLogin: async () => false, waitFor: () => assert.fail('ready project must not wait') };
  assert.equal(await projectMethods.ensureCodexReady.call(session, { id: 'window' }, false), true);
  assert.equal(reads, 1);
});

test('a genuinely unready Codex project retains its native wait, failure and new-chat readiness paths', async () => {
  for (const ready of [true, false]) {
    let waits = 0;
    const session = { windowId: 'window', editorCdp: {}, cdp: { wsUrl: 'chat', evaluate: async () => null },
      checkCodexLogin: async () => false, async waitFor(expression, tries) {
        assert.equal(expression, 'agentStartupState("codex", true)'); assert(tries > 0 && tries <= 209);
        waits++; return ready ? { thread: 'thread' } : null;
      } };
    if (ready) assert.equal(await projectMethods.ensureCodexReady.call(session, { id: 'window' }, false), true);
    else await assert.rejects(projectMethods.ensureCodexReady.call(session, { id: 'window' }, false), /Codex 会话数据尚未就绪/);
    assert.equal(waits, 1);
  }
  let logins = 0, newChats = 0;
  const session = { windowId: 'window', editorCdp: {}, cdp: { wsUrl: 'chat', evaluate: async () => ({ login: true }) },
    checkCodexLogin: async () => ++logins > 1, waitFor: () => assert.fail('login is a native result'),
    waitCodexNewChatReady: async () => { newChats++; return true; } };
  assert.equal(await projectMethods.ensureCodexReady.call(session, { id: 'window' }, false), false);
  assert.equal(logins, 2); logins = 0;
  assert.equal(await projectMethods.ensureCodexReady.call(session, { id: 'window' }, true), true);
  assert.equal(newChats, 1);
});

test('Codex thread adoption reads directly only for an established binding and preserves project-switch ownership', async () => {
  for (const bindingReady of [false, true]) for (const switchingThread of [false, true]) {
    const calls = [], session = { bindingReady, switchingThread, threadId: 'old',
      clearViewState: () => calls.push('clear'), publishThread: () => calls.push('publish'),
      pollChat: async (...args) => { assert.deepEqual(args, [true, true]); calls.push('read'); } };
    await codexMethods.adoptCodexThread.call(session, 'new');
    assert.equal(session.threadId, 'new'); assert.equal(session.switchingThread, switchingThread);
    assert.deepEqual(calls, bindingReady && !switchingThread ? ['clear', 'publish', 'read'] : ['clear', 'publish']);
  }
});

test('switching away or losing a live reading cannot turn a running session into completed', () => {
  const h = overviewCards(); h.apply({ busy: true, run: { id: 'turn', status: 'running' } });
  h.apply({ busy: false, statusKnown: false, run: null });
  assert.equal(h.notifications.length, 0); assert.equal(Object.keys(h.done).length, 0);
  assert.equal(h.rows()[0].state, 'unknown'); assert.equal(h.rows().length, 1);
});

test('Codex pending requests take card and project priority until the native request clears', () => {
  const h = overviewCards();
  h.apply({ run: { id: 'previous', status: 'completed', startedAt: 100 } });
  const waiting = 'codex:["thread","async:question"]';
  h.apply({ busy: true, waiting, waitingText: '请选择处理方式', run: { id: 'current', status: 'running', startedAt: 200 } });
  h.apply({ busy: true, waiting, waitingText: '请选择处理方式', run: { id: 'current', status: 'running', startedAt: 200 } });
  assert.equal(h.rows()[0].state, 'wait'); assert.equal(h.rows()[0].waitText, '请选择处理方式');
  assert.equal(h.context.aggregate(h.rows()).state, 'wait'); assert.equal(h.notifications.length, 1);
  h.apply({ waiting: '', waitingText: '', last: '正常完成', run: { id: 'current', status: 'completed', startedAt: 200 } });
  assert.equal(h.rows()[0].state, 'done'); assert.equal(h.rows()[0].waitText, '');
  assert.equal(h.context.aggregate(h.rows()).state, 'done');
  assert.deepEqual(h.notifications.map(value => value.kind), ['wait', 'done']);
  h.click(); h.apply({ run: { id: 'current', status: 'completed', startedAt: 200 } });
  assert.equal(h.rows()[0].state, 'idle');
});

test('a temporary unknown reading retains the observed native run until its real completion', () => {
  const h = overviewCards(); h.apply({ busy: true, run: { id: 'turn', status: 'running' } });
  h.apply({ statusKnown: false, run: { id: 'turn', status: 'unknown' } });
  assert.equal(h.notifications.length, 0); assert.equal(h.rows()[0].state, 'unknown');
  h.apply({ run: { id: 'turn', status: 'completed' } });
  assert.equal(h.notifications.length, 1); assert.equal(h.rows()[0].state, 'done');
  h.apply({ statusKnown: false, run: null }); h.apply({ run: { id: 'turn', status: 'completed' } });
  assert.equal(h.notifications.length, 1);
});

test('a confirmed completion belongs to its native turn and is notified only once', () => {
  const h = overviewCards(); h.apply({ busy: true, run: { id: 'turn', status: 'running' } });
  h.apply({ run: { id: 'turn', status: 'completed' } }); h.apply({ run: { id: 'turn', status: 'completed' } });
  assert.equal(h.notifications.length, 1); assert.equal(h.rows()[0].state, 'done');
  h.apply({ busy: true, run: { id: 'new-turn', status: 'running' }, windowId: 'replacement' });
  assert.equal(h.rows()[0].state, 'run'); assert.equal(Object.keys(h.done).length, 0);
  h.apply({ run: { id: 'turn', status: 'completed' } });
  assert.equal(h.notifications.length, 1); assert.notEqual(h.rows()[0].state, 'done');
});

test('a newer native completion marks a short turn even when its running snapshot was missed', () => {
  const h = overviewCards();
  h.apply({ run: { id: 'old', status: 'completed', startedAt: 100 } });
  assert.equal(h.notifications.length, 0); assert.equal(h.rows()[0].state, 'idle');
  const run = { id: 'short', status: 'completed', startedAt: 200 };
  h.apply({ run }); h.apply({ run });
  assert.equal(h.rows()[0].state, 'done'); assert.equal(h.context.aggregate(h.rows()).state, 'done');
  assert.equal(h.notifications.length, 1);
  h.click(); h.apply({ run });
  assert.equal(h.rows()[0].state, 'idle'); assert.equal(h.notifications.length, 1);
  const reload = overviewCards(h.saved); reload.apply({ run }); reload.apply({ run });
  assert.equal(reload.rows()[0].state, 'idle'); assert.equal(reload.notifications.length, 0);
  reload.apply({ run: { id: 'next-short', status: 'completed', startedAt: 300 } });
  assert.equal(reload.rows()[0].state, 'done'); assert.equal(reload.notifications.length, 1);
});

test('an unknown new turn keeps the confirmed baseline until its native completion arrives', () => {
  const h = overviewCards(); h.apply({ run: { id: 'old', status: 'completed', startedAt: 100 } });
  h.apply({ statusKnown: false, run: { id: 'new', status: 'unknown', startedAt: 200 } });
  assert.equal(h.rows()[0].state, 'unknown'); assert.equal(h.notifications.length, 0);
  h.apply({ run: { id: 'new', status: 'completed', startedAt: 200 } });
  assert.equal(h.rows()[0].state, 'done'); assert.equal(h.notifications.length, 1);
});

test('late older turns cannot clear or relight the latest completed turn', () => {
  const h = overviewCards(), latest = { id: 'latest', status: 'completed', startedAt: 200 };
  h.apply({ run: { id: 'old', status: 'completed', startedAt: 100 } }); h.apply({ run: latest });
  h.apply({ busy: true, run: { id: 'old', status: 'running', startedAt: 100 } });
  assert.equal(Object.values(h.done)[0]?.runId, latest.id);
  h.apply({ run: latest }); assert.equal(h.rows()[0].state, 'done');
  h.click();
  h.apply({ run: { id: 'old', status: 'completed', startedAt: 100 } }); h.apply({ run: latest });
  assert.equal(h.rows()[0].state, 'idle'); assert.equal(h.notifications.length, 1);
});

test('a different completed turn needs native chronological evidence before it can notify', () => {
  for (const times of [[0, 200], [100, 0], [100, 100], [200, 100]]) {
    const h = overviewCards(); h.apply({ run: { id: 'baseline', status: 'completed', startedAt: times[0] } });
    h.apply({ run: { id: 'unproven', status: 'completed', startedAt: times[1] } });
    assert.equal(h.rows()[0].state, 'idle'); assert.equal(h.notifications.length, 0);
  }
});

test('newer unknown stopped and failed turns do not become completion notifications', () => {
  for (const status of ['unknown', 'stopped', 'error']) {
    const h = overviewCards(); h.apply({ run: { id: 'old', status: 'completed', startedAt: 100 } });
    h.apply({ run: { id: 'new', status, startedAt: 200 } });
    assert.equal(h.notifications.length, 0); assert.equal(Object.keys(h.done).length, 0);
    assert.notEqual(h.rows()[0].state, 'done');
  }
});

test('stopped and failed native turns are not completion notifications', () => {
  for (const status of ['stopped', 'error']) {
    const h = overviewCards(); h.apply({ busy: true, run: { id: 'turn', status: 'running' } }); h.apply({ run: { id: 'turn', status } });
    assert.equal(h.notifications.length, 0); assert.equal(h.rows()[0].state, 'err');
  }
});

test('opening a stopped conversation keeps the same turn acknowledged after reload but not a new turn', () => {
  const h = overviewCards(); h.apply({ run: { id: 'turn', status: 'stopped' } });
  assert.equal(h.rows()[0].state, 'err'); h.click();
  assert.equal(h.rows()[0].state, 'idle');
  h.apply({ run: { id: 'turn', status: 'stopped' } }); assert.equal(h.rows()[0].state, 'idle');
  const reload = overviewCards(h.saved); reload.apply({ run: { id: 'turn', status: 'stopped' } });
  assert.equal(reload.rows()[0].state, 'idle');
  reload.apply({ busy: true, run: { id: 'new-turn', status: 'running' } }); assert.equal(reload.rows()[0].state, 'run');
  reload.apply({ run: { id: 'new-turn', status: 'stopped' } }); assert.equal(reload.rows()[0].state, 'err');
  assert.equal(reload.notifications.length, 0);
});

test('only opening the stopped conversation clears its card and project aggregate', () => {
  const h = overviewCards(); h.apply({ run: { id: 'turn', status: 'stopped' } }); h.click('sess');
  assert.equal(h.rows()[0].state, 'err'); assert.equal(h.context.aggregate(h.rows()).state, 'err');
  h.click();
  assert.equal(h.rows()[0].state, 'idle'); assert.equal(h.context.aggregate(h.rows()).state, 'idle');
  assert.equal(h.context.aggregate(h.rows()).counts.err, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(h.opened)), [{ computer: 'computer', windowId: 'window', threadId: 'thread' }]);
});

test('stopped acknowledgements belong to the native computer project and session', () => {
  const h = overviewCards(), run = { id: 'turn', status: 'stopped' };
  h.apply({ run }); h.click();
  for (const change of [{ projectId: 'other-project' }, { threadId: 'other-thread' }]) {
    h.apply({ run, ...change }); assert.equal(h.rows()[0].state, 'err');
    h.apply({ run }); assert.equal(h.rows()[0].state, 'idle');
  }
  h.entry.id = 'other-computer'; h.apply({ run }); assert.equal(h.rows()[0].state, 'err');
});

test('opening a conversation still clears completion and preserves actual failure', () => {
  const h = overviewCards(); h.apply({ busy: true, run: { id: 'turn', status: 'running' } });
  h.apply({ run: { id: 'turn', status: 'completed' } }); assert.equal(h.rows()[0].state, 'done');
  h.click(); h.apply({ run: { id: 'turn', status: 'completed' } });
  assert.equal(h.rows()[0].state, 'idle'); assert.equal(h.notifications.length, 1);
  h.apply({ run: { id: 'failed-turn', status: 'error' } }); h.click();
  assert.equal(h.rows()[0].state, 'err'); assert.equal(h.rows()[0].run.status, 'error');
});

test('favorites and project cards share completed-running-idle ordering and aggregate mixed projects', () => {
  const h = overviewCards(), rows = ['done', 'run', 'idle'].map((state, n) => ({ key: state, project: state, state, used: (n + 1) * 100 }));
  assert.equal(h.context.ovBoard(rows, [], rows.slice()), 'donerunidle');
  assert.equal(h.context.ovProjectTiles(rows.map(row => ({ key: row.key })), rows), 'donerunidle');
  assert.equal(h.context.aggregate([{ state: 'done' }, { state: 'idle' }]).state, 'done');
  assert.equal(h.context.aggregate([{ state: 'done' }, { state: 'run' }]).state, 'run');
  assert.equal(h.context.aggregate([{ state: 'done' }, { state: 'unknown' }]).state, 'unknown');
});

function foldingComposer(land) {
  const source = read('app/js/composer.js'), classes = new Set(land ? ['land'] : []), timers = [], handlers = {};
  const input = { value: '' }, attachments = { children: [] }, nodes = { attachments }, focus = { question: false };
  const context = vm.createContext({ mode: 'chat', text: input, composing: false,
    document: { activeElement: { matches: () => focus.question, disabled: false }, body: { classList: { contains: key => classes.has(key) } },
      querySelector: () => ({ addEventListener: (name, callback) => { handlers[name] = callback; } }) },
    $: id => nodes[id] ||= {}, composeCompactAllowed: () => true, composerLayoutBusy: () => false, micPressing: () => false,
    setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout() {},
    setComposerPresentation: (idle, compact) => { for (const [key, on] of [['composeIdle', idle], ['composeCompact', compact]]) on ? classes.add(key) : classes.delete(key); },
  });
  vm.runInContext(part(source, 'let composeCompactTimer =', 'function questionComposerFocused(')
    + part(source, 'function questionComposerFocused(', 'function micHeld(')
    + part(source, 'function composeCompactWanted(', 'function setComposerPresentation(')
    + 'function composeIdleWanted(){return !composerEngaged && !text.value && !composing && !questionComposerFocused();}\n'
    + 'function endComposerEditing(){composerEngaged=false;}\n'
    + part(source, 'function setComposeCompact(', '// A tap on the composer'), context);
  return { context, classes, input, focus, handlers, flush: () => { for (const timer of timers.splice(0)) timer(); } };
}

test('collapsed landscape tools retain their action and only a blank-area click expands the composer', () => {
  const h = foldingComposer(true); h.context.setComposeCompact(true);
  let intercepted = 0;
  h.handlers.click({ target: { closest: () => ({ tagName: 'BUTTON' }) }, preventDefault: () => intercepted++, stopPropagation: () => intercepted++ });
  h.context.updateComposeCompact();
  assert.equal(intercepted, 0); assert.equal(h.classes.has('composeCompact'), true);
  h.handlers.click({ target: { closest: () => null }, preventDefault: () => intercepted++, stopPropagation: () => intercepted++ });
  assert.equal(intercepted, 2); assert.equal(h.classes.has('composeCompact'), false);
});

test('question entry folds the main composer in both orientations and releases it on blur', () => {
  for (const land of [false, true]) {
    const h = foldingComposer(land); h.focus.question = true; h.context.updateComposeCompact();
    assert(h.classes.has('composeCompact')); assert(!h.classes.has('composeIdle'));
    h.focus.question = false; h.input.value = 'keep draft'; h.context.updateComposeCompact();
    assert(!h.classes.has('composeCompact')); assert.equal(h.input.value, 'keep draft');
  }
});

test('landscape retains idle automatic folding and click-to-open while preserving editing', () => {
  const h = foldingComposer(true); h.context.updateComposeCompact(); h.flush(); assert(h.classes.has('composeCompact'));
  let prevented = 0; h.handlers.click({ target: { closest: () => false }, preventDefault: () => prevented++, stopPropagation() {} });
  assert.equal(prevented, 1); assert(!h.classes.has('composeCompact'));
  h.input.value = 'typing draft'; h.context.updateComposeCompact(); h.flush();
  assert(!h.classes.has('composeCompact')); assert.equal(h.input.value, 'typing draft');
  h.context.setComposerFold(true); assert(h.classes.has('composeCompact')); h.context.setComposerFold(false);
  assert(!h.classes.has('composeCompact')); assert.equal(h.input.value, 'typing draft');
});

function nativeCompletionNotifications() {
  const source = read('lib/notify.mjs'), events = [], activeWorking = new Map(), state = {};
  const idle = Number(/const IDLE_POLLS = (\d+)/.exec(source)[1]);
  const context = vm.createContext({ Date, os: { hostname: () => 'fixture' }, notifySeq: 0,
    windowName: title => title, activeWorking, keyOf: event => event.win + '|' + event.threadId,
    deliver: event => events.push(event),
  });
  vm.runInContext(source.match(/^const (?:IDLE_POLLS|WAIT_POLLS) =[^;]+;/gm).join('\n')
    + '\n' + part(source, 'const extras =', '// Read the relay'), context);
  const win = { app: 'codex', id: 'codex', pageId: 'window', title: 'project' };
  const readState = (status, extra = {}) => context.check(win, state, { thread: 'thread', busy: status === 'running',
    runId: 'codex:turn', runAt: 100, run: { id: 'turn', status }, ...extra });
  readState('running');
  return { events, state, activeWorking, idle, read: readState,
    settle(status, extra = {}) { for (let i = 0; i < idle + 1; i++) readState(status, extra); } };
}

test('native notification completion is emitted once for a confirmed completed turn', () => {
  const h = nativeCompletionNotifications(); h.settle('completed'); h.settle('completed');
  assert.equal(h.events.filter(event => event.kind === 'done').length, 1);
  assert.equal(h.events.filter(event => event.kind === 'end').length, 1);
  assert.equal(h.state.busy, false); assert.equal(h.activeWorking.size, 0);
});

test('native stopped and failed turns end working without sending completion notifications', () => {
  for (const status of ['stopped', 'error']) {
    const h = nativeCompletionNotifications(); h.settle(status); h.settle(status);
    assert.equal(h.events.filter(event => event.kind === 'done').length, 0);
    assert.equal(h.events.filter(event => event.kind === 'end').length, 1);
    assert.equal(h.state.busy, false); assert.equal(h.activeWorking.size, 0);
  }
});

test('unknown native readings keep the running notification until its real completion is observed', () => {
  const h = nativeCompletionNotifications(); h.settle('unknown');
  assert.equal(h.events.filter(event => event.kind === 'done' || event.kind === 'end').length, 0);
  assert.equal(h.state.busy, true); assert.equal(h.activeWorking.size, 1);
  h.settle('completed'); h.settle('completed');
  assert.equal(h.events.filter(event => event.kind === 'done').length, 1);
  assert.equal(h.events.filter(event => event.kind === 'end').length, 1);
});

test('waiting for confirmation cannot send a native completion notification', () => {
  const h = nativeCompletionNotifications();
  for (let i = 0; i < 5; i++) h.read('completed', { waiting: 'q:approval', waitingText: 'Approve?' });
  assert.equal(h.events.filter(event => event.kind === 'done').length, 0);
  assert.equal(h.events.filter(event => event.kind === 'waiting').length, 1);
});

test('Codex request identity deduplicates pending notifications and completion resumes after answering', () => {
  const h = nativeCompletionNotifications();
  const waiting = 'codex:["thread","async:question"]';
  for (let i = 0; i < 8; i++) h.read('running', { waiting, waitingText: '请选择处理方式' });
  assert.equal(h.events.filter(event => event.kind === 'waiting').length, 1);
  assert.equal(h.events.find(event => event.kind === 'waiting').body, '请选择处理方式');
  assert.equal(h.events.filter(event => event.kind === 'done').length, 0);
  h.settle('completed', { waiting: null, waitingText: '' }); h.settle('completed', { waiting: null });
  assert.equal(h.events.filter(event => event.kind === 'done').length, 1);
  assert.equal(h.events.filter(event => event.kind === 'waiting').length, 1);
});

test('idle native controls without an explicit turn result are not proof of completion', () => {
  const h = nativeCompletionNotifications(); h.settle('completed', { run: null });
  assert.equal(h.events.filter(event => event.kind === 'done').length, 0);
});

function sharedFileBrowser(readDirectory = () => ({ path: '/project', parent: '/', os: 'linux', entries: [
  { name: 'reports', path: '/project/reports', directory: true, selectable: true },
  { name: 'readme.txt', path: '/project/readme.txt', directory: false, selectable: true, size: 12 },
] })) {
  const handlers = new Map(), requests = [], packets = [], opened = [], nodes = new Map(), preferences = new Map();
  const computers = ['computer-one', 'computer-two'].map(id => ({ id, name: id }));
  let selected = computers[0];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', value: '', scrollTop: 0,
      addEventListener: (event, handler) => handlers.set(event, handler), replaceChildren() { this.innerHTML = ''; },
      focus() { context.document.activeElement = this; }, setSelectionRange() {},
    });
    return nodes.get(id);
  };
  const context = vm.createContext({ URLSearchParams, $: node, loadComputers: () => computers, currentComputer: () => selected,
    sheetKind: '', projectEntry: null, docsPending: null, viewSel: 'selected-thread', menuRefreshTimer: 0, clearTimeout,
    store: { get: key => preferences.get(key), set: (key, value) => preferences.set(key, value) },
    document: { activeElement: null }, I18N: { tr: value => value }, esc: String, fmtSize: String,
    OV_AGENT: { cursor: 'Cursor' }, status() {}, finishPending() {}, capabilityState: () => ({ available: true }),
    openSheet(kind, html) { context.sheetKind = kind; node('sheet').innerHTML = html; node('computerFileCompletions').innerHTML = ''; },
    closeSheet() { context.sheetKind = ''; context.projectEntry = null; },
    send: packet => { packets.push(packet); return true; }, openFile: (...args) => opened.push(args),
    api: async (route, options) => {
      requests.push({ route, computer: options.computer.id, method: options.method || 'GET', body: options.body });
      const data = await readDirectory(new URL(route, 'http://fixture'), options.computer);
      return { ok: true, json: async () => data };
    },
  });
  const files = read('app/js/files.js'), sheets = read('app/js/sheets.js');
  vm.runInContext(part(files, 'let computerFiles = null;', 'function finishFileRead(')
    + part(sheets, 'function showComputerFiles(', 'function cancelDocs(')
    + part(sheets, 'function fileEntryIcon(', 'function projectSheet(')
    + part(sheets, 'function startEditor(', "$('pickEditor').onclick")
    + part(sheets, 'function openProjectPicker(', 'function showProjectTrust('), context);
  return { context, handlers, requests, packets, opened, node, computers,
    open: (...args) => context.openComputerFiles(...args),
    state: () => vm.runInContext('computerFiles', context),
    select: id => { selected = computers.find(computer => computer.id === id); },
    type(value) { node('computerFilePath').value = value; handlers.get('input')({ target: { id: 'computerFilePath', value } }); },
    hideHidden(checked) { handlers.get('change')({ target: { id: 'computerFileHideHidden', checked } }); },
  };
}

test('Editor initialization reads only native project metadata without enumerating its files', async () => {
  const { methods } = await import('../server/agent/files.mjs');
  const emitted = [], root = '/fixture-that-does-not-exist/current-project';
  await methods.showDocs.call({ currentRoots: async () => [{ root }], emit: data => emitted.push(data) }, 7);
  assert.deepEqual(emitted, [{ t: 'docs', requestId: 7, os: process.platform, root, path: root, host: '' }]);
});

test('Editor initialization offers multiple native roots without reading their directories', async () => {
  const { methods } = await import('../server/agent/files.mjs');
  const emitted = [], roots = [{ root: '/missing/project-one' }, { root: '/missing/project-two' }];
  const projects = roots.map(row => ({ path: row.root }));
  await methods.showDocs.call({ currentRoots: async () => roots,
    projectRows: rows => { assert.equal(rows, roots); return projects; }, emit: data => emitted.push(data) }, 8);
  assert.deepEqual(emitted, [{ t: 'docs', requestId: 8, os: process.platform, projects }]);
});

test('Editor initialization returns a native metadata failure to the owning request', async () => {
  const { methods } = await import('../server/agent/files.mjs');
  const emitted = [];
  await methods.showDocs.call({ currentRoots: async () => { throw new Error('native roots failed'); }, emit: data => emitted.push(data) }, 9);
  assert.deepEqual(emitted, [{ t: 'docs', requestId: 9, os: process.platform, error: 'native roots failed' }]);
});

test('the two Editor entries share one browser with different initial paths and one directory read', async () => {
  const home = sharedFileBrowser(); await home.open('computer-two');
  assert.equal(new URL(home.requests[0].route, 'http://fixture').searchParams.get('roots'), '1');
  assert.equal(home.requests[0].computer, 'computer-two');
  const current = sharedFileBrowser(); current.context.startEditor();
  assert.equal(current.requests.length, 0); assert.equal(current.packets[0].t, 'docs');
  await current.context.receiveCurrentFiles({ root: '/project' });
  assert.equal(current.requests.length, 1);
  assert.equal(new URL(current.requests[0].route, 'http://fixture').searchParams.get('path'), '/project');
  assert.equal(current.state().directory.path, '/project');
  assert(current.node('sheet').innerHTML.indexOf('computerFilePathForm') < current.node('sheet').innerHTML.indexOf('data-computer-path'));
});

test('file and project browsing share completion while project choices include directories only', async () => {
  for (const project of [null, { owner: { computer: 'computer-two', app: 'cursor' } }]) {
    const h = sharedFileBrowser(); await h.open('computer-two', { path: '/project', project });
    h.type('/project/re'); await h.context.completeComputerPath();
    assert.equal(h.node('computerFilePath').value, project ? '/project/reports/' : '/project/re');
    assert.equal(h.requests.every(request => request.computer === 'computer-two'), true);
    assert.equal(h.node('sheet').innerHTML.includes('readme.txt'), !project);
    if (project) assert(h.node('sheet').innerHTML.includes('data-computer-project="open"'));
  }
});

test('hidden entries default to hidden and the shared browser remembers the switch without refetching', async () => {
  const entries = ['.git', '.config', '.env', 'src', 'readme.txt'].map(name => ({
    name, path: '/project/' + name, directory: !['.env', 'readme.txt'].includes(name), selectable: true, size: 12,
  }));
  const h = sharedFileBrowser(() => ({ path: '/project', parent: '/', os: 'linux', entries }));
  await h.open('computer-two', { path: '/project', project: { owner: null } });
  assert.equal(h.state().hideHidden, true);
  assert(h.node('sheet').innerHTML.includes('data-computer-path="/project/src"'));
  assert(!h.node('sheet').innerHTML.includes('data-computer-path="/project/.git"'));
  h.node('sheet').scrollTop = 64;
  h.hideHidden(false);
  assert.equal(h.requests.length, 1);
  assert.equal(h.state().directory.entries.length, 5);
  assert.equal(h.node('sheet').scrollTop, 64);
  assert(h.node('sheet').innerHTML.includes('data-computer-path="/project/.git"'));
  assert(!h.node('sheet').innerHTML.includes('data-computer-path="/project/.env"'));
  await h.context.browseComputerFiles('/project');
  assert.equal(h.state().hideHidden, false);
  await h.open('computer-one', { path: '/project' });
  assert.equal(h.state().hideHidden, false);
  assert(h.node('sheet').innerHTML.includes('data-computer-path="/project/.env"'));
  assert(h.node('sheet').innerHTML.includes('data-computer-path="/project/readme.txt"'));
  const count = h.requests.length;
  h.hideHidden(true);
  assert.equal(h.requests.length, count);
  assert(!h.node('sheet').innerHTML.includes('data-computer-path="/project/.env"'));
  assert(!h.node('sheet').innerHTML.includes('data-computer-path="/project/.config"'));
  assert(h.node('sheet').innerHTML.includes('data-computer-path="/project/readme.txt"'));
  await h.open('computer-two', { path: '/project' });
  assert.equal(h.state().hideHidden, true);
});

test('hidden-entry completion follows the shared switch and still restricts project choices to folders', async () => {
  const entries = ['.git', '.config', '.env'].map(name => ({ name, path: '/project/' + name,
    directory: name !== '.env', selectable: true, size: 12 }));
  for (const project of [null, { owner: null }]) {
    const h = sharedFileBrowser(() => ({ path: '/project', parent: '/', os: 'linux', entries }));
    await h.open('computer-two', { path: '/project', project });
    h.type('/project/.'); await h.context.completeComputerPath();
    assert.equal(h.node('computerFilePath').value, '/project/.');
    assert(h.node('computerFileCompletions').innerHTML.includes('没有匹配项'));
    h.hideHidden(false);
    h.type('/project/.'); await h.context.completeComputerPath();
    assert(h.node('computerFileCompletions').innerHTML.includes('.git'));
    assert(h.node('computerFileCompletions').innerHTML.includes('.config'));
    assert.equal(h.node('computerFileCompletions').innerHTML.includes('.env'), !project);
    const count = h.requests.length;
    h.hideHidden(true);
    assert.equal(h.node('computerFileCompletions').innerHTML, '');
    assert.equal(h.requests.length, count);
  }
});

test('changing the hidden-entry switch releases the previous completion result', async () => {
  const data = { path: '/project', os: 'linux', entries: [{ name: '.git', path: '/project/.git', directory: true, selectable: true }] };
  let resolveCompletion, waiting = false;
  const h = sharedFileBrowser(() => waiting ? new Promise(resolve => { resolveCompletion = resolve; }) : data);
  await h.open('computer-two', { path: '/project' });
  h.hideHidden(false); h.type('/project/.g'); waiting = true;
  const pending = h.context.completeComputerPath();
  h.hideHidden(true);
  resolveCompletion(data); await pending;
  assert.equal(h.node('computerFilePath').value, '/project/.g');
  assert.equal(h.state().path, '/project/.g');
  assert.equal(h.node('computerFileCompletions').innerHTML, '');
  assert.equal(h.requests.length, 2);
});

test('shared Windows folder completion follows the computer OS and ignores file candidates', async () => {
  const h = sharedFileBrowser(() => ({ path: 'C:\\', parent: '', os: 'win32', entries: [
    { name: 'Users', path: 'C:\\Users', directory: true, selectable: true },
    { name: 'Usage.txt', path: 'C:\\Usage.txt', directory: false, selectable: true },
  ] }));
  await h.open('computer-two', { path: 'C:\\', project: { owner: null } });
  h.type('C:\\us'); await h.context.completeComputerPath();
  assert.equal(h.node('computerFilePath').value, 'C:\\Users\\');
});

test('multiple native project roots retain their owning Windows OS before the first directory read', async () => {
  const h = sharedFileBrowser(() => ({ path: 'C:\\', os: 'win32', entries: [
    { name: 'Users', path: 'C:\\Users', directory: true, selectable: true },
  ] }));
  await h.open('computer-two', { current: true, project: { owner: null } });
  h.context.receiveCurrentFiles({ projects: [{ name: 'one', path: 'C:\\one' }, { name: 'two', path: 'C:\\two' }], os: 'win32' });
  h.type('C:\\us'); await h.context.completeComputerPath();
  assert.equal(h.node('computerFilePath').value, 'C:\\Users\\');
});

test('an older computer browser read cannot overwrite a newly opened browser', async () => {
  const pending = [];
  const h = sharedFileBrowser(() => new Promise(resolve => pending.push(resolve)));
  const first = h.open('computer-one', { path: '/first' }), second = h.open('computer-two', { path: '/second' });
  pending[1]({ path: '/second', os: 'linux', entries: [] }); await second;
  pending[0]({ path: '/first', os: 'linux', entries: [] }); await first;
  assert.equal(h.state().computer.id, 'computer-two'); assert.equal(h.state().directory.path, '/second');
});

test('shared browsing opens a file on its owning computer and rejects a file as a project folder', async () => {
  const file = '/project/readme.txt', h = sharedFileBrowser(() => ({ file }));
  await h.open('computer-two', { path: file });
  assert.equal(h.opened.length, 1); assert.equal(h.opened[0][0], file); assert.equal(h.opened[0][3].id, 'computer-two');
  await h.open('computer-two', { path: file, project: { owner: null } });
  assert.equal(h.opened.length, 1); assert.equal(h.state().error, true); assert.equal(h.state().message, '请选择文件夹');
});

test('late Editor initialization stays with its request selection and computer', async () => {
  const h = sharedFileBrowser(); await h.open('computer-two', { current: true });
  h.context.docsPending = { id: 9, sel: 'selected-thread', computer: 'computer-two' };
  h.context.showDocs({ requestId: 9, root: '/old-computer' });
  assert.equal(h.requests.length, 0);
  h.select('computer-two');
  h.context.showDocs({ requestId: 8, root: '/old-request' }); assert.equal(h.requests.length, 0);
  await h.context.showDocs({ requestId: 9, root: '/project' });
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].computer, 'computer-two');
});

test('computer and conversation project entries share the session opener and keep their folder starting points', async () => {
  const h = sharedFileBrowser(), rendered = [];
  Object.assign(h.context, { ovS: {}, bindWin: async target => h.select(target.computer),
    agentLists: new Map([['selected', []]]), agentListKey: () => 'selected',
    showAgents: list => { rendered.push(list); h.context.sheetKind = 'agents'; }, requestAgentCatalog() {},
  });
  vm.runInContext(part(read('app/js/core.js'), 'function openAgentList(', 'let currentAppName =')
    + part(read('app/js/notify.js'), 'async function runComputerAction(', 'let updateUntouched ='), h.context);
  await h.context.runComputerAction({ computer: 'computer-two', windowId: 'window-two', win: 'cursor:two' });
  assert.equal(rendered.length, 1); assert.equal(h.context.projectEntry.source, 'computer');
  h.context.openProjectPicker(); assert.equal(h.packets.at(-1).t, 'projects'); assert.equal(h.requests.length, 0);
  h.context.sheetKind = ''; h.context.openAgentList();
  assert.equal(rendered.length, 2); assert.equal(h.context.projectEntry.source, 'conversation');
  h.context.openProjectPicker(); assert.equal(h.packets.at(-1).t, 'docs');
  assert.equal(h.state().project.owner, null); assert.equal(h.state().computer.id, 'computer-two');
});

test('typing a relative path during Editor initialization uses the native project as its base', async () => {
  const h = sharedFileBrowser(); h.context.startEditor(); h.type('reports');
  await h.context.receiveCurrentFiles({ root: '/project' });
  const query = new URL(h.requests[0].route, 'http://fixture').searchParams;
  assert.equal(query.get('base'), '/project'); assert.equal(query.get('path'), 'reports');
});

test('closing a shared Editor preview returns to the same directory and scroll without rereading it', async () => {
  const h = sharedFileBrowser(); await h.open('computer-two', { path: '/project' });
  h.node('viewer').classList = { remove() {} };
  Object.assign(h.context, { fileRequestId: 1, viewing: {}, dirtyEdit: () => false,
    finishFileRead() {}, finishFileSave() {}, stopVideo() {}, leaveEdit() {},
  });
  vm.runInContext(part(read('app/js/files.js'), 'function closeViewer(', "$('vClose').onclick")
    + '\nreturnToBrowser = { browser: computerFiles, scroll: 128 };', h.context);
  h.context.closeViewer();
  assert.equal(h.state().computer.id, 'computer-two'); assert.equal(h.state().directory.path, '/project');
  assert.equal(h.node('sheet').scrollTop, 128); assert.equal(h.requests.length, 1); assert.equal(h.packets.length, 0);
});

test('shared Editor saving uses its owning computer and updates text only from the confirmed result', async () => {
  const h = editorSave();
  await h.context.saveEdit();
  assert.equal(h.requests.length, 0); assert.equal(h.packets[0].computer, 'B');
  assert.equal(h.packets[0].message.t, 'saveComputerFile');
  assert.equal(h.context.viewing.text, 'old'); assert(h.context.saving);
  h.finish();
  assert.equal(h.context.viewing.text, 'new'); assert.equal(h.context.saving, null);
  assert.equal(h.node('vStatus').textContent, '已保存');
});

test('returning from an ordinary session action preserves the project pickers entry context', async () => {
  const h = sharedFileBrowser(), entry = { computer: 'computer-two', source: 'computer' };
  Object.assign(h.context, { currentApp: 'cursor', renderAgentList() { assert.equal(h.context.projectEntry, entry); } });
  vm.runInContext(part(read('app/js/notify.js'), 'async function runAgentMenuAction(', 'function openPickedSession('), h.context);
  await h.context.runAgentMenuAction('session', 'rename', { name: 'renamed' }, null, entry);
  h.context.openProjectPicker(); assert.equal(h.packets.at(-1).t, 'projects');
});

function pairedBrowserFixture(ready = { relay: true, browser: true }) {
  const config = { appUrl: 'http://127.0.0.1:13949/',
    browser: { executable: '/registered/chrome', profile: '_shots/paired-browser-fixture/profile', port: 19335 },
    relay: { dataDir: '_shots/paired-browser-fixture/relay-data', args: ['--import', './registered-isolate.mjs', 'server/index.mjs'],
      env: { PORT: '13949', HOST: '127.0.0.1' } },
  };
  const launches = [], probes = [], identities = [], pages = [];
  const runtime = {
    checkIdentity: async value => { identities.push(value); },
    probe: async url => {
      probes.push(url);
      return url.endsWith('/url.json') ? ready.relay && { ready: true }
        : ready.browser && { webSocketDebuggerUrl: 'ws://registered-browser' };
    },
    launch: async (executable, args, env, name) => {
      launches.push({ executable, args, env, name }); ready[name === 'chrome' ? 'browser' : 'relay'] = true;
      return 9000 + launches.length;
    },
    verifyPage: async (value, version) => {
      pages.push({ config: value, version });
      return { authenticated: true, version: 'v373', targetId: 'existing-paired-page' };
    },
  };
  return { config, runtime, launches, probes, identities, pages };
}

test('paired browser recovery reuses a ready relay, browser and authenticated page without launching processes', async () => {
  const h = pairedBrowserFixture(), result = await ensurePairedBrowser(h.config, h.runtime);
  assert.deepEqual(result.started, { relay: false, browser: false }); assert.equal(h.launches.length, 0);
  assert.equal(h.identities[0], h.config); assert.equal(h.pages[0].config, h.config);
  assert.equal(result.targetId, 'existing-paired-page'); assert.equal(result.authenticated, true); assert.equal(result.newPairing, false);
});

test('paired browser recovery starts only the registered relay and original browser profile when both are absent', async () => {
  const h = pairedBrowserFixture({ relay: false, browser: false }), result = await ensurePairedBrowser(h.config, h.runtime);
  assert.deepEqual(result.started, { relay: true, browser: true }); assert.equal(h.launches.length, 2);
  assert.deepEqual(h.launches[0], { executable: process.execPath, args: h.config.relay.args, env: h.config.relay.env, name: 'relay' });
  assert.equal(h.launches[1].executable, h.config.browser.executable);
  assert(h.launches[1].args.includes('--remote-debugging-port=19335'));
  assert(h.launches[1].args.includes('--user-data-dir=' + path.resolve(h.config.browser.profile)));
  assert.deepEqual(result.pids, { relay: 9001, browser: 9002 }); assert.equal(result.newPairing, false);
});

test('paired browser recovery restores a missing browser without restarting the ready relay', async () => {
  const h = pairedBrowserFixture({ relay: true, browser: false }), result = await ensurePairedBrowser(h.config, h.runtime);
  assert.deepEqual(result.started, { relay: false, browser: true });
  assert.deepEqual(h.launches.map(item => item.name), ['chrome']); assert.equal(h.pages.length, 1);
});

test('paired browser recovery reports missing original identity before starting any process', async () => {
  const h = pairedBrowserFixture({ relay: false, browser: false });
  h.runtime.checkIdentity = async () => { throw new Error('original profile missing'); };
  await assert.rejects(ensurePairedBrowser(h.config, h.runtime), /original profile missing/);
  assert.equal(h.probes.length, 0); assert.equal(h.launches.length, 0); assert.equal(h.pages.length, 0);
});

test('paired browser recovery reports failed original authentication without creating another pairing', async () => {
  const h = pairedBrowserFixture(); let attempts = 0;
  h.runtime.verifyPage = async () => { attempts++; return { authenticated: false }; };
  await assert.rejects(ensurePairedBrowser(h.config, h.runtime), /原配对认证未恢复；未创建新配对/);
  assert.equal(attempts, 1); assert.equal(h.launches.length, 0);
});

function nativeRoots() {
  let reads = 0, watches = 0, notices = 0, result = async () => [{ root: '/project' }];
  class Cdp {
    constructor(url) { this.wsUrl = url; this.handlers = new Map(); }
    on() {} close() {} async connect() {} async send() {}
    async evaluate(expression) { return expression.includes('nativeSessionInfo')
      ? { ready: true, rows: [], removed: [] } : { chat: { items: [], thread: 'thread' }, states: [], catalog: [] }; }
  }
  const context = vm.createContext({ Cdp, cdpRead: { run: (_signal, action) => action(), getStore: () => null }, awaitCdpRead: value => value,
    watchChat: async () => { watches++; return () => {}; }, editorRoots: async () => { reads++; return result(); },
    PAGE_SRC: '({})', helpersCall: value => value, projectSessionIds: () => [], reconcileSessionCatalog: () => false,
    updateProjectWindowTargets() {}, bindOperation: action => action, publishDesktopState() {}, withOperation: (_op, action) => action(),
    AgentContext: class {}, codexSessionStates: async () => [], AbortController, setTimeout, clearTimeout,
  });
  vm.runInContext(read('server/native-windows.mjs').replace(/^import .*;\n/gm, '').replace(/^export /gm, '')
    + '\nthis.Source = NativeWindow;', context);
  const source = new context.Source('ws://fixture/chat'), win = { app: 'cursor', ws: 'ws://fixture/chat', editorWs: 'ws://fixture/editor' };
  context.subscribeCatalog('cursor', () => notices++);
  return { source, win, context, start: () => source.start(win), reads: () => reads, watches: () => watches, notices: () => notices,
    result: action => { result = action; } };
}

test('failed project roots finish with their cause and recover through the next existing discovery call', async () => {
  const h = nativeRoots(); h.result(async () => { throw new Error('directory unavailable'); });
  await h.start(); await h.source.rootsRead;
  assert.equal(h.source.rootsError, 'directory unavailable'); assert.equal(h.source.rootsRead, null);
  assert.equal(h.reads(), 1); assert.equal(h.watches(), 1); assert(h.notices() > 0);
  h.result(async () => [{ root: '/project' }]);
  await h.start(); await h.source.rootsRead;
  assert.equal(h.source.roots[0].root, '/project'); assert.equal(h.source.rootsError, null);
  assert.equal(h.reads(), 2); assert.equal(h.watches(), 1);
  await h.start(); assert.equal(h.reads(), 2);
});

test('concurrent metadata initialization shares one read and an empty root list stays valid', async () => {
  const h = nativeRoots(); let release;
  h.result(() => new Promise(resolve => { release = resolve; }));
  await Promise.all([h.start(), h.start()]);
  assert.equal(h.reads(), 1); assert.equal(h.watches(), 1);
  const pending = h.source.rootsRead; release([]); await pending;
  assert.equal(h.source.roots.length, 0); await h.start(); assert.equal(h.reads(), 1);
});

test('directory errors end pending state while successful windows stay available and isolated', () => {
  const h = overviewDirectory(), failed = h.add('cursor', 'failed'); failed.roots = undefined; failed.rootsError = 'permission denied';
  let result = h.snapshot();
  assert.equal(result.ready, false); assert.equal(result.partial, false); assert.equal(result.pendingWindows, 0);
  assert.deepEqual(result.errors, [{ app: 'cursor', windowId: 'failed', error: 'permission denied' }]);
  h.add('codex', 'ready'); h.catalogs.set('codex', { rows: [] }); result = h.snapshot();
  assert.equal(result.partial, true); assert.equal(result.windows.length, 1); assert.equal(result.pendingWindows, 0);
  failed.roots = []; failed.rootsError = null; h.catalogs.set('cursor', { rows: [] }); result = h.snapshot();
  assert.equal(result.ready, true); assert.deepEqual(result.errors, []);
});

test('an authenticated computer with a directory error leaves the loading state', () => {
  const link = { authed: true, socket: { readyState: 1 } };
  const context = vm.createContext({ computerSockets: new Map([['key', link]]), navigator: { onLine: true } });
  vm.runInContext(part(read('app/js/overview.js'), 'function ovComputerStatus(', 'function ovStOf('), context);
  assert.equal(context.ovComputerStatus({ c: { key: 'key' } }, { data: { errors: [{ error: 'denied' }] } }), 'online');
  assert.equal(context.ovComputerStatus({ c: { key: 'key' } }, { data: { pendingWindows: 1 } }), 'loading');
});

function devinProject(thread = 'acp/devin-cli/new-session') {
  const emitted = [], calls = [], state = { thread, surface: 'editor', items: 0 };
  let active = thread;
  const context = vm.createContext({ path, helpersCall: value => value, fusionProject: root => ({ id: root }),
    cdpRead: { getStore: () => null }, setTimeout: action => action() });
  const adapter = vm.runInContext('({' + part(read('server/apps/devin.mjs'), '  async openDefaultSession() {', '  async openAgent(') + '})', context);
  const methods = vm.runInContext('({' + part(read('server/agent/projects.mjs'), '  async finishProject() {', '  projectName() {')
    + part(read('server/agent/projects.mjs'), '  async resumeProjectSwitch(', '  // Waits for the Codex')
    + part(read('server/apps/devin.mjs'), 'async confirmDevinThread(', '// Switching surface') + '})', context);
  const session = { ...methods, app: 'devin', mode: 'chat', chatUpdatesStop: () => {},
    pendingProject: { root: '/project', threadId: '', newSession: false }, threadId: 'old', selectedThread: 'old', adapter,
    editorCdp: { evaluate: async () => ({ required: false }) },
    cdp: { evaluate: async expression => expression === 'devinSurface()' ? 'editor' : expression === 'hasComposer()' ? true : active },
    waitFor: async () => { calls.push('startup'); return state; }, currentRoots: async () => [{ root: '/project' }],
    clearViewState() { calls.push('clear'); }, publishThread() { emitted.push({ t: 'thread', thread: this.threadId }); },
    selectionKey() { return 'devin|window|' + this.threadId; }, emit: value => emitted.push(value),
    async pollChat() { assert.equal(this.threadId, active); emitted.push({ t: 'chat', chat: { thread: active, items: [] } }); },
    prefetchMenus: async () => {},
  };
  return { session, emitted, calls, state, active: value => { active = value; } };
}

for (const thread of ['acp/devin-cli/new-session', '']) {
  test(`Devin project completion adopts the confirmed default identity before its first chat: ${thread || 'valid empty home'}`, async () => {
    const h = devinProject(thread); await h.session.finishProject();
    assert.equal(h.session.threadId, thread); assert.equal(h.session.selectedThread, thread);
    assert.equal(h.session.bindingReady, true); assert.equal(h.session.pendingProject, null);
    assert.equal(h.emitted.find(message => message.t === 'projectReady').sel, 'devin|window|' + thread);
    await h.session.resumeProjectSwitch(h.session.cdp);
    assert.equal(h.emitted.at(-1).chat.thread, thread);
  });
}

test('a default Devin identity which changed before confirmation does not finish project binding', async () => {
  const h = devinProject(); h.active('different');
  await assert.rejects(h.session.finishProject(), /Devin 项目会话尚未就绪/);
  assert.notEqual(h.session.bindingReady, true); assert(h.session.pendingProject);
  assert.equal(h.emitted.some(message => message.t === 'projectReady'), false);
});

test('explicit Devin history selection does not initialize or replace the requested session', async () => {
  const h = devinProject('requested'); h.session.pendingProject.threadId = 'requested';
  await h.session.finishProject(); assert.equal(h.calls.includes('startup'), false);
  assert.equal(h.session.threadId, 'requested');
});

function editorSave() {
  const h = overviewClient(), nodes = new Map(), feedback = [];
  h.node = id => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); };
  Object.assign(h.context, { $: h.node, editing: true, saving: null, saveRequestId: 0, fileRequestId: 3, editBase: 'old',
    viewing: { path: '/project/a.txt', host: '', text: 'old', computer: h.context.ovList[1].c },
    status: (message, ok) => feedback.push({ message, ok }), finishPending() {},
  });
  h.node('vEditBox').value = 'new';
  vm.runInContext(part(read('app/js/files.js'), 'function onSaved(', 'function closeViewer('), h.context);
  h.finish = (change = {}, link = h.links[1]) => {
    const message = h.packets.at(-1).message;
    h.context.receiveDesktopOperation(link, { id: message.operationId, kind: 'saveComputerFile', done: true,
      events: [{ revision: 1, message: { t: 'saved', ok: true, size: 3, path: message.path, requestId: message.requestId, ...change } }] });
  };
  return { ...h, feedback };
}

test('computer save waits through disconnection and replays its original identity only on its owning authenticated entry', async () => {
  const h = editorSave(); await h.context.saveEdit(); const id = h.packets[0].message.operationId;
  h.links[1].socket.readyState = 3; h.context.waitFileSave('B');
  assert(h.context.saving); assert.equal(h.node('vEdit').disabled, true);
  assert.match(h.node('vStatus').textContent, /等待电脑端保存结果/);
  h.context.replayDesktopOperations(h.links[0]); assert.equal(h.packets.length, 1);
  h.links[1].auth.device = 'other-entry'; h.context.replayDesktopOperations(h.links[1]); assert.equal(h.packets.length, 1);
  h.links[1].auth.device = 'device-B'; h.links[1].socket.readyState = 1;
  h.context.replayDesktopOperations(h.links[1]); assert.equal(h.packets.length, 2);
  assert.equal(h.packets[1].message.operationId, id); h.finish();
  assert.equal(h.context.viewing.text, 'new'); assert.equal(h.pending(), 0);
});

test('a disconnected different computer cannot change a pending editor save status', async () => {
  const h = editorSave(); await h.context.saveEdit(); h.context.waitFileSave('A');
  assert.equal(h.node('vStatus').textContent, '正在保存…');
  h.finish({}, h.links[0]); assert(h.context.saving);
  h.links[1].auth.device = 'other-entry'; h.finish(); assert(h.context.saving);
  h.links[1].auth.device = 'device-B'; h.finish(); assert.equal(h.context.saving, null);
});

test('saving without its owning control connection reports not sent and preserves edits', async () => {
  const h = editorSave(); h.links[1].socket.readyState = 3; await h.context.saveEdit();
  assert.equal(h.packets.length, 0); assert.equal(h.context.saving, null); assert.equal(h.node('vEditBox').value, 'new');
  assert.match(h.node('vStatus').textContent, /未发送保存/);
});

test('explicit save failure preserves edits and a late result cannot update another file or its feedback', async () => {
  const h = editorSave(); await h.context.saveEdit(); h.finish({ ok: false, error: 'permission denied' });
  assert.equal(h.context.viewing.text, 'old'); assert.equal(h.node('vEditBox').value, 'new');
  assert.equal(h.node('vStatus').textContent, 'permission denied');
  await h.context.saveEdit(); h.context.fileRequestId++; h.context.viewing = { path: '/different', text: 'other' };
  const feedback = h.feedback.length; h.finish({ ok: false, error: 'late error' });
  assert.equal(h.context.viewing.text, 'other'); assert.equal(h.feedback.length, feedback);
});

test('a computer save writes once outside known projects, preserves permissions and replays the recorded result', async () => {
  const parent = new URL('../_shots/', import.meta.url); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(new URL('computer-save-', parent)), file = path.join(directory, 'fixture.txt');
  try {
    fs.writeFileSync(file, 'before', { mode: 0o751 });
    const h = operationFixture(); h.message = { t: 'saveComputerFile', operationId: crypto.randomUUID(), requestId: 1, path: file, text: 'after' };
    let writes = 0;
    const route = vm.runInNewContext('({' + part(read('server/routes.mjs'), '  saveComputerFile:', '  overviewManage:') + '}).saveComputerFile', {
      realpath: async value => fs.realpathSync(value), writeTextFile: async (...args) => { writes++; return writeTextFile(...args); },
    });
    assert.equal(route.connection, true); assert.equal(route.fast, true);
    h.session.emit = message => captureOperation(h.session, message);
    const first = beginOperation(h.session, h.message);
    await withOperation(first.operation, () => route.fastRun(h.session, h.message)); first.operation.finish();
    assert.equal(fs.readFileSync(file, 'utf8'), 'after'); assert.equal(fs.statSync(file).mode & 0o777, 0o751);
    assert.equal(first.operation.app, ''); assert.equal(first.operation.sel, '');
    const packets = [], stop = subscribeOperations(h.session.deviceId, { readyState: 1, send: raw => packets.push(JSON.parse(raw)) });
    const duplicate = beginOperation(h.session, h.message);
    assert.equal(duplicate.duplicate, true); assert.equal(writes, 1);
    assert.equal(packets[0].events[0].message.t, 'saved'); assert.equal(packets[0].done, true);
    assert.equal(beginOperation({ ...h.session, deviceId: crypto.randomUUID() }, h.message).duplicate, false);
    stop();
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test('computer save failures are recorded as saved results instead of repeating the write', async () => {
  const h = operationFixture(); h.message = { t: 'saveComputerFile', operationId: crypto.randomUUID(), path: '/missing', requestId: 7 };
  const route = vm.runInNewContext('({' + part(read('server/routes.mjs'), '  saveComputerFile:', '  overviewManage:') + '}).saveComputerFile', {
    realpath: async () => { throw new Error('permission denied'); }, writeTextFile: () => assert.fail('must not write'),
  });
  h.session.emit = message => captureOperation(h.session, message);
  const first = beginOperation(h.session, h.message);
  await withOperation(first.operation, async () => {
    await assert.rejects(route.fastRun(h.session, h.message), /permission denied/);
    route.fail(h.session, h.message, new Error('permission denied')); first.operation.finish();
  });
  assert.equal(first.operation.events.get('saved').message.ok, false); assert.equal(first.operation.done, true);
  assert.equal(beginOperation(h.session, h.message).duplicate, true);
});

for (const needsTwoFactor of [false, true]) {
  test(`computer saving cannot bypass ${needsTwoFactor ? 'required two-factor verification' : 'entry authentication'}`, async () => {
    const h = relayHeartbeat({ needsTwoFactor }); let writes = 0;
    h.routes.saveComputerFile = { fast: true, connection: true, fastRun: () => { writes++; } };
    const socket = await h.socket({ authenticate: needsTwoFactor });
    socket.receive({ t: 'saveComputerFile', operationId: crypto.randomUUID(), path: '/fixture', text: 'must not write' }); await h.settle();
    assert.equal(socket.code, 4001); assert.equal(writes, 0); assert.equal(h.sessions.length, 0);
    assert.equal(socket.sent.find(message => message.t === 'auth').needTotp, needsTwoFactor);
  });
}

test('fixed header follows its existing grid slot and natural height without touching the page shell', () => {
  const observed = []; let callback, slotRect = { left: 0, width: 402 }, headerHeight = 56;
  const writes = (allowed, initial = {}) => new Proxy(initial, {
    set(target, property, value) { assert(allowed.includes(property), String(property)); target[property] = value; return true; },
  });
  const slot = { style: writes(['marginBottom'], { height: '0px' }), getBoundingClientRect: () => slotRect };
  const header = { style: writes(['left', 'width']), getBoundingClientRect: () => ({ height: headerHeight }) };
  const body = { style: writes([]) };
  const context = vm.createContext({
    document: { body, querySelector(selector) { assert.equal(selector, 'body > header'); return header; } },
    $(id) { assert.equal(id, 'headerSlot'); return slot; },
    ResizeObserver: class { constructor(fn) { callback = fn; } observe(node) { observed.push(node); } },
  });
  vm.runInContext(part(read('app/js/core.js'), 'const appHeader =', '// In-progress lines'), context);
  assert.deepEqual(observed, [slot, header]);
  assert.deepEqual({ ...header.style }, { left: '0px', width: '402px' });
  assert.equal(slot.style.marginBottom, '56px');
  slotRect = { left: 524.40625, width: 349.59375 }; headerHeight = 52; callback();
  assert.deepEqual({ ...header.style }, { left: '524.40625px', width: '349.59375px' });
  assert.equal(slot.style.marginBottom, '52px');
  slotRect = { left: 64, width: 756 }; headerHeight = 138; callback();
  assert.deepEqual({ ...header.style }, { left: '64px', width: '756px' });
  assert.equal(slot.style.marginBottom, '138px');
  assert.equal(slot.style.height, '0px'); assert.deepEqual({ ...body.style }, {});
});

function viewportTraceFixture() {
  const events = () => {
    const listeners = new Map(), once = new Set();
    return { listeners, addEventListener(type, listener, options) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener); if (options?.once) once.add(listener);
    }, removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    emit(type) { for (const listener of [...(listeners.get(type) || [])]) {
      if (once.has(listener)) listeners.get(type).delete(listener);
      listener({ type, currentTarget: this });
    } } };
  };
  const classes = new Set(['conv']), persisted = new Map(), writes = [], frames = new Map(), observers = [];
  let nextFrame = 0, time = 0, contentReads = 0, styleReads = 0, editingEnds = 0, layoutNotes = 0;
  const style = () => ({ height: '', transform: '', setProperty(key, value) { this[key] = value; },
    removeProperty(key) { delete this[key]; }, getPropertyValue(key) { return this[key] || ''; },
    set cssText(value) { this.height = value.match(/(?:^|;)height:([^;]+)/)?.[1] || ''; this.raw = value; } });
  const makeNode = (properties = {}) => nativeNode({}, { tagName: 'DIV', classList: { contains: () => false }, style: style(), children: [],
    append(child) { this.children.push(child); child.parentElement = this; },
    remove() { const parent = this.parentElement; if (parent) parent.children.splice(parent.children.indexOf(this), 1); },
    setAttribute() {}, closest: () => null,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 402, bottom: 874, width: 402, height: 874 }), ...properties });
  const body = makeNode({ classList: { contains: key => classes.has(key), toggle(key, on) { on ? classes.add(key) : classes.delete(key); }, [Symbol.iterator]: () => classes.values() } });
  const header = makeNode(), top = makeNode({ closest: selector => selector === '#overview' ? overview : null,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 402, bottom: 114, width: 402, height: 114 }) });
  const footer = makeNode({ getBoundingClientRect: () => ({ top: 700, left: 0, right: 402, bottom: 874, width: 402, height: 174 }) });
  const bottom = makeNode({ getBoundingClientRect: () => ({ top: 780, left: 0, right: 402, bottom: 874, width: 402, height: 94 }) });
  const overview = makeNode({ id: 'overview', closest: selector => selector === '#overview' ? overview : null });
  const input = makeNode({ tagName: 'TEXTAREA', offsetHeight: 52, closest: selector => selector === 'footer' ? footer : null });
  Object.defineProperty(input, 'value', { get() { contentReads++; throw Error('must not read private input'); } });
  const nodes = { text: input, termText: makeNode(), listWrap: { clientHeight: 500 }, sessBar: { offsetHeight: 0 }, actionBar: { offsetHeight: 0 },
    viewer: makeNode(), transfer: makeNode({ hidden: true }), sheet: makeNode(), shade: makeNode(), imageEditor: null, gate: null, overview, ovLevels: bottom };
  const html = makeNode({ dataset: { theme: 'light' }, clientHeight: 874, clientWidth: 402, scrollHeight: 874 });
  const document = { ...events(), body, documentElement: html, scrollingElement: { scrollTop: 0 }, activeElement: null,
    baseURI: 'https://example.test/remote-agent/?pair=PRIVATE_PAIR', readyState: 'complete', visibilityState: 'visible', styleSheets: [],
    createElement: () => makeNode(), querySelectorAll: () => [], elementsFromPoint: () => [top, overview, body],
    querySelector(selector) {
      if (selector === 'footer') return footer;
      if (selector === 'body > header' || selector === 'header') return header;
      if (selector === '#overview .ov-top') return top;
      if (selector.includes('theme-color')) return { content: '#ffffff' };
      if (selector.includes('name="viewport"')) return { content: 'width=device-width,viewport-fit=cover' };
      return null;
    } };
  const window = { ...events(), innerHeight: 874, innerWidth: 402, scrollY: 0, devicePixelRatio: 3,
    screen: { width: 402, height: 874, availWidth: 402, availHeight: 874, orientation: { type: 'portrait-primary' } },
    visualViewport: { ...events(), height: 874, width: 402, offsetTop: 0, offsetLeft: 0, pageTop: 0, scale: 1 } };
  const navigator = { userAgent: 'Fixture WebKit', standalone: true };
  const context = vm.createContext({ document, window, navigator, history: { state: { ovDepth: 0 } }, mode: 'chat', APP_VERSION: 'fixture',
    performance: { now: () => time++, getEntriesByType: () => [] }, URL, TextEncoder, Uint8Array, crypto: crypto.webcrypto,
    matchMedia: query => ({ matches: query.includes('standalone') }), $: id => nodes[id],
    store: { get(key) { assert.equal(key, 'viewport-trace-next'); return persisted.get(key); },
      set(key, value) { assert.equal(key, 'viewport-trace-next'); writes.push([key, value]); value == null ? persisted.delete(key) : persisted.set(key, value); } },
    requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; }, cancelAnimationFrame: id => frames.delete(id),
    MutationObserver: class { constructor(callback) { this.callback = callback; this.connected = true; observers.push(this); } observe() {} disconnect() { this.connected = false; } },
    getComputedStyle(element) {
      styleReads++;
      const values = { position: element === body && !('standalone' in html.dataset) ? 'fixed' : 'relative', transform: element.style.transform || 'none',
        display: 'flex', filter: 'none', 'backdrop-filter': 'none', height: /vh$/.test(element.style.height) ? '874px' : element.style.height || '874px',
        paddingTop: '62px', paddingRight: '0px', paddingBottom: '34px', paddingLeft: '0px', backgroundColor: 'rgb(255, 255, 255)', opacity: '1' };
      return { ...values, getPropertyValue: key => values[key] || '' };
    }, endComposerEditing() { editingEnds++; }, noteChatLayoutChange() { layoutNotes++; },
    localStorage: { getItem() { assert.fail('must not enumerate private storage'); }, setItem() { assert.fail('must not persist trace'); } },
    indexedDB: { open() { assert.fail('must not persist trace'); } }, screen: makeNode(), viewSel: 'PRIVATE_SESSION', base: 'PRIVATE_URL', token: 'PRIVATE_TOKEN' });
  vm.runInContext(part(read('app/js/core.js'), 'let viewportTrace =', "window.addEventListener('resize', fitViewport);"), context);
  return { context, frames, document, window, navigator, input, body, classes, persisted, writes, observers, nodes, events,
    run: source => vm.runInContext(source, context), data: () => JSON.parse(vm.runInContext('viewportTraceText()', context)),
    flush() { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } },
    counts: () => ({ contentReads, styleReads, editingEnds, layoutNotes }),
    layout: () => JSON.parse(JSON.stringify({ height: body.style.height, transform: body.style.transform, keyboard: classes.has('kb'), editingEnds, layoutNotes })) };
}

test('viewport diagnostics stay inactive until requested and consume only the explicit one-time startup flag', () => {
  const h = viewportTraceFixture(); h.run('resumeViewportTrace();fitViewport();');
  assert.equal(h.data().state, 'not-started'); assert.equal(h.frames.size, 0); assert.equal(h.counts().styleReads, 0);
  assert.equal(h.observers.length, 0); assert.equal(h.body.children.length, 0); assert.equal(h.writes.length, 0);
  h.persisted.set('viewport-trace-next', '1'); h.run('resumeViewportTrace();');
  assert.equal(h.data().state, 'recording'); assert.deepEqual(h.writes, [['viewport-trace-next', null]]);
  h.run('resumeViewportTrace();'); assert.equal(h.data().samples.length, 1);
});

test('viewport diagnostics record the actual overview header, footer, safe area and top paint owners without input or identity', async () => {
  const h = viewportTraceFixture(); h.classes.delete('conv'); h.run('startViewportTrace();');
  h.document.activeElement = h.input; h.document.emit('focusin'); h.window.emit('scroll');
  assert.equal(h.frames.size, 1); h.flush();
  const frame = h.data().samples.find(sample => sample.source === 'frame');
  assert.equal(frame.page, 'overview'); assert.equal(frame.header.height, 114); assert.equal(frame.header.css.height, '874px'); assert.equal(frame.footer.top, 780);
  assert.deepEqual(frame.safeArea, { top: '62px', right: '0px', bottom: '34px', left: '0px' });
  assert.equal(frame.units.dvh, '874px'); assert.equal(frame.topEdge[0].elements[0].owner, 'overview');
  assert.equal(h.data().environment.screen.height, 874); assert.deepEqual(h.data().measurement.before, h.data().measurement.after);
  assert.equal(h.counts().contentReads, 0); assert(!JSON.stringify(h.data()).includes('PRIVATE_'));
  h.run('stopViewportTrace();');
});

test('viewport diagnostics release listeners, probes and frame callbacks without admitting late records into a new trace', () => {
  const h = viewportTraceFixture(); h.run('startViewportTrace();');
  const oldFrame = [...h.frames.values()][0], oldObserver = h.observers[0];
  h.run("recordViewportTrace('stop');stopViewportTrace();");
  assert.equal(h.frames.size, 0); assert.equal(h.body.children.length, 0); assert(!oldObserver.connected);
  for (const target of [h.window, h.document, h.window.visualViewport]) assert([...target.listeners.values()].every(listeners => listeners.size === 0));
  h.run('startViewportTrace();'); const fresh = h.data(); oldFrame(); oldObserver.callback([{ target: h.body, attributeName: 'style' }]);
  assert.deepEqual(h.data(), fresh); assert.equal(h.frames.size, 1); h.run('stopViewportTrace();');
});

test('all entry modes retain keyboard controls without shell compensation during the recorded focusout sequences', () => {
  const run = (recording, standalone, sequence) => {
    const h = viewportTraceFixture(), states = [];
    if (standalone) h.document.documentElement.dataset.standalone = '';
    if (sequence.page === 'overview') h.classes.delete('conv');
    for (const property of ['height', 'transform']) Object.defineProperty(h.body.style, property, {
      get: () => '', set() { assert.fail(`keyboard processing must not write shell ${property}`); },
    });
    if (recording) h.run('startViewportTrace();');
    const resting = { focus: false, inner: 874, height: 874, offset: 0, scroll: 0 };
    const open = { focus: true, ...sequence };
    for (const phase of [resting, open, { ...open, focus: false }, resting]) {
      h.document.activeElement = phase.focus ? h.input : null;
      Object.assign(h.window, { innerHeight: phase.inner, scrollY: phase.scroll });
      Object.assign(h.window.visualViewport, { height: phase.height, offsetTop: phase.offset });
      h.run('fitViewport();'); h.flush(); states.push(h.layout());
    }
    if (recording) {
      const frames = h.data().samples.filter(sample => sample.source === 'frame');
      assert(frames.every(frame => frame.root.css.position === (standalone ? 'relative' : 'fixed')));
      assert(frames.every(frame => frame.root.css.transform === 'none'));
      assert.equal(h.counts().contentReads, 0);
    }
    h.run('stopViewportTrace();'); return states;
  };
  for (const standalone of [false, true]) for (const sequence of [
    { page: 'overview', inner: 768, height: 477, offset: 106, scroll: 106 },
    { page: 'chat', inner: 477, height: 477, offset: 335, scroll: 397 },
  ]) {
    const plain = run(false, standalone, sequence);
    assert.deepEqual(run(true, standalone, sequence), plain);
    assert.deepEqual(plain.map(value => [value.height, value.transform, value.keyboard, value.editingEnds]),
      [['', '', false, 0], ['', '', true, 0], ['', '', false, 1], ['', '', false, 1]]);
  }
});

test('viewport diagnostics record conversation visibility transitions and stop exactly at the stated limit', () => {
  const h = viewportTraceFixture(); h.classes.delete('conv'); h.run('startViewportTrace();'); h.flush();
  h.classes.add('conv'); h.observers[0].callback([{ target: h.body, attributeName: 'class' }]); h.flush();
  assert.equal(h.data().samples.at(-1).page, 'chat');
  h.classes.delete('conv'); h.observers[0].callback([{ target: h.body, attributeName: 'class' }]); h.flush();
  assert.equal(h.data().samples.at(-1).page, 'overview');
  h.run("for(let i=0;i<500;i++)recordViewportTrace('fixture');");
  const full = h.data(); assert.equal(full.state, 'full'); assert.equal(full.samples.length, full.limit); assert.equal(h.frames.size, 0); assert.equal(h.body.children.length, 0);
  h.document.emit('focusin'); assert.deepEqual(h.data(), full);
});

test('startup resource metadata waits for the parsed document and is cancelled when tracing stops before parsing finishes', () => {
  const h = viewportTraceFixture(); h.document.readyState = 'loading';
  h.run('startViewportTrace();'); assert.equal(h.document.listeners.get('DOMContentLoaded').size, 1);
  h.run('stopViewportTrace();'); assert.equal(h.document.listeners.get('DOMContentLoaded').size, 0);
  h.run('startViewportTrace();'); h.document.emit('DOMContentLoaded');
  assert.equal(h.document.listeners.get('DOMContentLoaded').size, 0); h.run('stopViewportTrace();');
});

test('viewport resource hashes distinguish loaded CSS from own cache entries and exclude credentials and unrelated resources', async () => {
  const h = viewportTraceFixture();
  h.document.querySelectorAll = () => [{ href: 'https://example.test/remote-agent/app.css?v=400&token=PRIVATE_TOKEN' },
    { src: 'https://example.test/remote-agent/js/core.js?v=402' }, { src: 'https://private.test/PRIVATE_URL.js' }];
  h.document.styleSheets = [{ href: 'https://example.test/remote-agent/app.css?v=400', disabled: false, cssRules: [{ cssText: 'body { color: red; }' }] }];
  const worker = { scriptURL: 'https://example.test/remote-agent/sw.js?v=402&pair=PRIVATE_PAIR', state: 'activated' };
  h.navigator.serviceWorker = { ...h.events(), controller: worker, getRegistration: async () => ({ scope: 'https://example.test/remote-agent/', active: worker }) };
  const matches = [];
  h.context.caches = { keys: async () => ['remote-agent:https://example.test/remote-agent/:v402', 'remote-agent:https://example.test/remote-agent/:notices', 'other-private-cache'],
    match: async (url, options) => { matches.push([url, options.cacheName]); return new Response('public shell fixture'); } };
  const data = JSON.parse(JSON.stringify(await h.run('viewportTraceResources()')));
  assert.deepEqual(data.assets, ['app.css?v=400', 'js/core.js?v=402']); assert.equal(data.worker.controller.file, 'sw.js?v=402');
  assert.equal(data.styles[0].source, 'loaded-cssom'); assert.equal(data.styles[0].sha256, crypto.createHash('sha256').update('body { color: red; }').digest('hex'));
  assert.equal(data.caches.length, 1); assert.equal(data.caches[0].source, 'cache-entry-not-proof-of-loaded-bytes');
  assert(matches.every(([url, name]) => !url.includes('PRIVATE') && name.endsWith(':v402')));
  assert(!JSON.stringify(data).includes('PRIVATE')); assert.equal(h.writes.length, 0);
});
