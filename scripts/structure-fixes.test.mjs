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
import { FOCUS_COMPOSER } from '../server/agent/context.mjs';
import { ensurePairedBrowser } from './paired-browser.mjs';
import { writeTextFile } from '../lib/files.mjs';
import { localFilePath } from '../lib/platform.mjs';

import { methods as sessionMethods } from '../server/agent/session-actions.mjs';
import { methods as menuMethods } from '../server/agent/menus.mjs';
import { methods as projectMethods } from '../server/agent/projects.mjs';
import { methods as codexMethods } from '../server/apps/codex.mjs';
import { methods as devinMethods } from '../server/apps/devin.mjs';
import { methods as chatMethods } from '../server/agent/chat.mjs';
import { ROUTES, flag } from '../server/routes.mjs';
import { cdpRead, awaitCdpRead } from '../server/cdp.mjs';
import { NativeCdp, cursorSource } from '../server/native-windows.mjs';
import { read, fragment as part, createPageContext, nativePage } from './page-fixture.mjs';

test('native Codex binding exposes owner and follower connections on both platforms', () => {
  const source = part(read('server/page/session-actions.js'), "    if (app === 'codex' && catalog === 'connection')", "    if (catalog === 'cleanup'");
  for (const IS_WIN of [true, false]) for (const role of ['owner', 'follower', null]) {
    const info = vm.runInContext('(function(app,id,catalog){' + source + '})', createPageContext({ IS_WIN,
      codexHistoryScopes: () => [], codexConversationManager: (id, scopes, host) => {
        assert.equal(id, 'target'); assert.equal(host, 'local');
        return { getStreamRole: thread => { assert.equal(thread, 'target'); return role ? { role } : null; },
          getConversation: thread => { assert.equal(thread, 'target'); return { cwd: '/target-project' }; },
          resumeConversation: () => assert.fail('must not resume an existing native connection') };
      },
    }));
    assert.deepEqual(JSON.parse(JSON.stringify(info('codex', 'target', 'owner'))), role === 'owner' ? { cwd: '/target-project' } : null);
    assert.deepEqual(JSON.parse(JSON.stringify(info('codex', 'target', 'connection'))), role === 'owner' || role === 'follower'
      ? { cwd: '/target-project', role } : null);
  }
});

test('Codex catalog synchronization on both platforms waits behind an existing native refresh without selecting a chat', async () => {
  const prefix = part(read('server/page/session-actions.js'), '  const nativeSessionInfo =', "    if (app === 'codex' && catalog === 'owner')");
  for (const IS_WIN of [true, false]) {
    let finish;
    const calls = [], pending = new Promise(resolve => { finish = resolve; });
    const info = vm.runInContext(prefix + "return 'original path'; }; nativeSessionInfo;", createPageContext({ IS_WIN,
      codexHistoryScopes: () => [], codexConversationManager: (id, scopes, host) => {
        assert.equal(id, null); assert.equal(host, 'local');
        return { refreshRecentConversations: options => { calls.push(options); return pending; } };
      },
      codexQueryClient: () => ({ refetchQueries: async (query, options) => { calls.push({ query, options }); } }),
    }));
    let settled = false;
    const result = Promise.resolve(info('codex', '', 'refreshCatalog')).then(value => { settled = true; return value; });
    await Promise.resolve();
    assert.equal(settled, false); assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ afterCurrent: true }]);
    finish(); assert.equal(await result, true);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), { query: { queryKey: ['recent-conversations-meta'], type: 'all' }, options: { throwOnError: true, cancelRefetch: false } });
  }
});

for (const IS_WIN of [true, false]) test(`${IS_WIN ? 'Windows' : 'Ubuntu'} Devin reads every native mode from its bound session and sends only that session configuration`, async () => {
  const calls = [], modes = [{ value: 'accept-edits', name: 'Code' }, { value: 'smart', name: 'Smart' },
    { value: 'ask', name: 'Ask' }, { value: 'plan', name: 'Plan' }, { value: 'bypass', name: 'Bypass Permissions' }];
  const record = { providerId: 'native-provider', configOptions: [{ id: 'mode', category: 'mode', currentValue: 'smart', options: modes }] };
  const context = createPageContext({ IS_WIN, devinSessionRecord: id => { assert.equal(id, 'bound-A'); return record; },
    devinSend: async (provider, request) => { calls.push({ provider, request }); record.configOptions[0].currentValue = request.params.value; },
  });
  const infoPrefix = part(read('server/page/session-actions.js'), '  const nativeSessionInfo =', "    if (app === 'codex' && catalog === 'refreshCatalog')");
  const info = vm.runInContext(infoPrefix + '}; nativeSessionInfo;', context);
  const data = info('devin', 'bound-A', 'mode');
  assert.deepEqual(Array.from(data.items, row => row.label), modes.map(row => row.name));
  assert.deepEqual(Array.from(data.items.filter(row => row.checked), row => row.label), ['Smart']);
  assert.deepEqual(calls, []);
  const action = part(read('server/page/session-actions.js'), "    if (action === 'mode' && app === 'devin')", "    if (action === 'model' && app === 'devin')");
  const select = vm.runInContext('(async function(app,id,action,name){' + action + '})', context);
  await select('devin', 'bound-A', 'mode', 'Plan');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ provider: 'native-provider', request: { method: 'session/set_config_option', params: { sessionId: 'bound-A', configId: 'mode', value: 'plan' } } }]);
  assert.equal(info('devin', 'bound-A', 'mode').items.find(row => row.checked).label, 'Plan');
  await assert.rejects(select('devin', 'bound-A', 'mode', 'not-native'), /原生候选/);
  assert.equal(calls.length, 1);
});

test('Windows Cursor mode choices use the bound composer handle and preserve the desktop composer', async () => {
  const selected = new Map([['bound-A', 'agent'], ['desktop-B', 'chat']]);
  const modes = [{ id: 'agent', name: 'Agent' }, { id: 'plan', name: 'Plan' }, { id: 'chat', name: 'Ask' }];
  const calls = [], service = { getAllModes: () => modes,
    getComposerUnifiedMode: id => { assert.equal(typeof id, 'string'); return selected.get(id); },
    setComposerUnifiedMode: (handle, mode) => { calls.push([handle.id, mode]); selected.set(handle.id, mode); },
  };
  const doc = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  const page = vm.runInContext(PAGE_SRC.replace(/const IS_WIN = (?:true|false);/, 'const IS_WIN = true;'), createPageContext({ document: doc,
    window: { __remoteAgentCursorModes: service,
      __remoteAgentCursorServices: { data: { getComposerHandleById: async id => ({ id }) } } } }));
  const info = page.nativeSessionInfo('cursor', 'bound-A', 'mode');
  assert.deepEqual(Array.from(info.items, row => row.label), ['Agent', 'Plan', 'Ask']);
  assert.deepEqual(Array.from(info.items.filter(row => row.checked), row => row.label), ['Agent']);
  assert.deepEqual(calls, []);
  assert.equal(await page.nativeSessionAction('cursor', 'bound-A', 'mode', 'Plan'), true);
  assert.deepEqual(calls, [['bound-A', 'plan']]);
  assert.equal(selected.get('desktop-B'), 'chat');
  await assert.rejects(page.nativeSessionAction('cursor', 'bound-A', 'mode', 'not-native'), /原生候选/);
});

test('Windows Devin mode adapter keeps reads and late menu results assigned to their original selection', async () => {
  let complete;
  const events = [], evaluations = [];
  const session = { sel: 1, threadId: 'bound-A', selectionKey: () => 'devin|bound-A',
    cdp: { evaluate: expression => { evaluations.push(expression); return new Promise(resolve => { complete = resolve; }); } },
    emit: value => events.push(value), refreshModelChat: async () => events.push('refresh'),
  };
  const stale = devinMethods.readWindowsDevinMode.call(session, 1);
  session.sel = 2; complete({ items: [{ label: 'Code', checked: true }] }); await stale;
  assert.deepEqual(events, []);
  const current = devinMethods.readWindowsDevinMode.call(session, 2);
  complete({ items: [{ label: 'Code', checked: true }, { label: 'Plan', checked: false }] }); await current;
  assert.equal(events[0].requestId, 2); assert.equal(events[0].kind, 'mode'); assert.equal(events[0].sel, 'devin|bound-A');
  const pick = devinMethods.pickWindowsDevinMode.call(session, 'Plan'); complete(true); await pick;
  assert(evaluations[2].endsWith('.nativeSessionAction(\'devin\', "bound-A", \'mode\', "Plan")'));
  assert(evaluations.every(expression => expression.includes('"app":"devin","threadId":"bound-A"')));
  assert.equal(events.at(-1), 'refresh');
});

test('Windows Devin foreground snapshots use native session modes instead of retained chip text', () => {
  const source = read('server/page/chat-extract.js');
  const fields = [...source.matchAll(/^( +)mode: devinSurface\(\)[^\n]*\n[^\n]*/gm)].map(match => match[0]);
  assert.equal(fields.length, 2);
  for (const field of fields) for (const IS_WIN of [true, false]) {
    const result = vm.runInContext('({' + field + '}).mode', createPageContext({ IS_WIN,
      activeThread: () => 'bound-A', devinSurface: () => 'editor',
      nativeSessionInfo: (app, id, kind) => { assert.equal(app, 'devin'); assert.equal(id, 'bound-A'); assert.equal(kind, 'mode'); return { items: [{ label: 'Plan', checked: true }] }; },
      devinModeChip: () => ({ innerText: 'Bypass Permissions' }),
    }));
    assert.equal(result, 'Plan');
  }
});

test('Devin mode menu dispatch shares native session configuration on Windows and Ubuntu', async () => {
  const source = read('server/agent/menus.mjs').slice(read('server/agent/menus.mjs').indexOf('export const methods =')).replace('export const', 'const');
  for (const IS_WIN of [true, false]) {
    const methods = vm.runInContext(source + '\nmethods;', createPageContext({ IS_WIN }));
    const calls = [], session = { app: 'devin',
      readWindowsDevinMode: id => calls.push(['read', id]), pickWindowsDevinMode: label => calls.push(['pick', label]),
      cdp: { evaluate: async () => { throw Error('original Linux control path'); } },
      closeMenus: async () => { throw Error('original Linux control path'); }, pressControl: async () => { throw Error('original Linux control path'); },
    };
    await methods.readMenu.call(session, 'mode', 3); await methods.pickMenu.call(session, 'mode', 'Plan');
    assert.deepEqual(calls, [['read', 3], ['pick', 'Plan']]);
  }
});

for (const selector of ['.composer-bar [contenteditable="true"]', '.auxiliarybar [contenteditable="true"]']) {
  test(`shared composer targeting reads, writes and focuses ${selector} without selecting history`, () => {
    const history = nativeNode({}, { innerText: 'history', closest: () => ({}) });
    const editor = nativeNode({}, { innerText: 'before', focus() { document.activeElement = editor; } });
    editor.editor = { commands: { setContent(value) { editor.innerText = value.content[0].content.map(row => row.type === 'hardBreak' ? '\n' : row.text).join(''); } } };
    const document = { activeElement: null, getElementById: () => null, querySelector: () => null,
      querySelectorAll: value => value === selector ? [history, editor] : [] };
    const page = nativePage(document, {}, 'composerTarget,composerFocused');
    assert.equal(page.composerTarget(document), editor);
    assert.equal(page.composerDraft(), 'before');
    assert.equal(page.setComposerDraft('new\ntext'), true);
    assert.equal(page.composerDraft(), 'new\ntext');
    editor.focus(); assert.equal(page.composerFocused(), true);
    document.activeElement = history; assert.equal(page.composerFocused(), false);
    assert.equal(history.innerText, 'history');
  });
}

test('shared composer targeting writes the selected Slate editor in an auxiliary bar', () => {
  const editor = nativeNode({}, { innerText: 'old' }), other = nativeNode({}, { innerText: 'other' });
  const slate = { children: [{ children: [{ text: 'old' }] }], apply() {}, select() {},
    deleteFragment() { editor.innerText = ''; }, insertBreak() { editor.innerText += '\n'; }, insertText(text) { editor.innerText += text; } };
  const document = { activeElement: editor, getElementById: () => null, querySelector: () => null,
    querySelectorAll: selector => selector === '.auxiliarybar [contenteditable="true"]' ? [editor, other] : [] };
  const source = read('server/page/composer-target.js')
    + part(read('server/page/composer.js'), '  const pickComposer', '  const queueEditing')
    + part(read('server/page/composer.js'), '  const setComposerDraft', '  // Typeahead queries');
  const context = createPageContext({ remoteContext: null, doc: document, document, codexFiberProps: () => [{ editor: slate }] });
  vm.runInContext(source + ';this.write=setComposerDraft;this.draft=composerDraft;', context);
  assert.equal(context.write('one\ntwo'), true); assert.equal(context.draft(), 'one\ntwo'); assert.equal(other.innerText, 'other');
});

test('image confirmation returns its local list when the shared attachment cache is null or unchanged', async () => {
  const list = [{ id: 'image', preview: 'data:image/png;base64,YQ==' }], events = [];
  const session = { cdp: { evaluate: async () => list }, sel: 1, lastAttachments: null,
    liveRead: () => true, selectionKey: () => 'image-test', emit: value => events.push(value) };
  assert.deepEqual(await chatMethods.syncAttachments.call(session), list);
  assert.deepEqual(await chatMethods.syncAttachments.call(session), list); assert.equal(events.length, 1);
  session.liveRead = () => false;
  assert.equal(await chatMethods.syncAttachments.call(session), undefined); assert.equal(events.length, 1);
});

for (const current of [true, false]) test(`image attachment confirms only its current local result: current=${current}`, async () => {
  const rows = [{ id: 'image', preview: 'preview' }], replies = [[], true, rows], events = [];
  const session = { cdp: { evaluate: async () => replies.shift() }, selectedThread: '', lastAttachments: null,
    selectionKey: () => 'scope', syncAttachments: async () => current ? rows : undefined,
    emit: event => events.push(event), appMessage: message => message };
  const pending = chatMethods.attachImage.call(session, 'YQ==', 'test.png', 'image/png', '', 'scope');
  if (current) assert.equal(await pending, 'image');
  else await assert.rejects(pending, /会话已切换，附件确认已取消/);
  assert.equal(events.some(event => event.ok === true), current);
});

test('Devin queue edit reports take-out while preserving the shared completion receipt', async () => {
  const events = [], session = { app: 'devin', selectionKey: () => 'devin|window|thread', emit: row => events.push(row),
    devinTakeOut: async id => { events.push({ t: 'unqueued', id }); } };
  const message = { action: 'edit', id: 'queued', requestId: 'edit', text: 'draft' };
  const result = await ROUTES.queue.run(session, message); ROUTES.queue.after(session, message, result);
  assert.equal(events[0].t, 'unqueued'); assert.equal(events[1].t, 'queueDone'); assert.equal(events[1].ok, true);
  assert.equal(events[2].msg, '已取回输入框，编辑后需重新发送');
});

test('visual snapshots and live frames share visibility and buffer rules while Wayland is read at entry', async () => {
  const env = {}, events = [], children = [], commands = [];
  const context = createPageContext({ process: { platform: 'linux', env }, Buffer, path, dir: '/visual', stateFile: '/state',
    fs: { existsSync: () => false, writeFileSync() {} },
    spawn(command) {
      commands.push(command); const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
      children.push(child); return child;
    },
  });
  vm.runInContext(part(read('server/visual/capture.mjs'), 'export const isWayland', 'function jpegSize').replace(/^export /gm, '')
    + part(read('server/visual/capture.mjs'), 'class VisualCapture', 'export const visualCapture') + ';this.capture=new VisualCapture();this.isWayland=isWayland;', context);
  const capture = context.capture, viewer = { visible: false, client: { bufferedAmount: 0 }, emit: event => events.push(event) };
  capture.viewers.add(viewer); capture.state.state = 'live'; capture.frame = { data: 'cached' };
  capture.publish(viewer); capture.sendFrame({ data: 'live' }); assert.equal(events.filter(row => row.t === 'frame').length, 0);
  viewer.visible = true; capture.publish(viewer); assert.equal(events.findLast(row => row.t === 'frame').data, 'live');
  viewer.client.bufferedAmount = 2 * 1024 * 1024; capture.publish(viewer); capture.sendFrame({ data: 'blocked' });
  assert.equal(events.filter(row => row.t === 'frame').length, 1);
  env.XDG_SESSION_TYPE = 'wayland'; assert.equal(context.isWayland(), true);
  viewer.client.bufferedAmount = 0; await capture.start('select'); assert.deepEqual(commands, ['/usr/bin/python3']);
  delete env.XDG_SESSION_TYPE; assert.equal(context.isWayland(), false);
  children[0].stdout.emit('data', Buffer.from('{"frame":"wayland-frame","w":10,"h":20}\n'));
  assert.equal(events.findLast(row => row.t === 'frame').data, 'wayland-frame'); capture.stop();
});

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

function devinAccountUsage({ inactive = false, fail = false, emit = true, unchanged = false,
  missingApi = false, missingSnapshot = false, daily = false, unrelatedFirst = false } = {}) {
  const calls = [], listeners = new Set();
  const planInfo = { planName: 'Max', hideDailyQuota: !daily, hideWeeklyQuota: daily };
  class UserStatus {
    constructor(remaining) {
      this.planStatus = { planInfo, dailyQuotaRemainingPercent: 75, weeklyQuotaRemainingPercent: remaining,
        overageBalanceMicros: daily ? 0n : 11311950n, dailyQuotaResetAtUnix: 1794384000n, weeklyQuotaResetAtUnix: 1794729600n };
    }
    static fromBinary(bytes) {
      const key = Buffer.from(bytes).toString();
      calls.push(['decode', key]);
      return snapshots[key];
    }
  }
  const snapshots = { cached: new UserStatus(40), fresh: new UserStatus(35) };
  let snapshot = missingSnapshot ? '' : 'cached';
  const auth = {
    getUserStatusBinaryBase64: () => snapshot ? btoa(snapshot) : '',
    onDidChangeUserStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const api = { auth, async executeCommand(command) {
    assert.equal(command, 'devin.updatePlanInfo');
    calls.push(['refresh']);
    if (fail) throw new Error('native account unavailable');
    if (!unchanged && !missingSnapshot) snapshot = 'fresh';
    if (emit) for (const fn of listeners) fn();
  } };
  const currentRoot = { stateNode: {} }, oldRoot = { stateNode: {} };
  currentRoot.stateNode.current = currentRoot;
  oldRoot.stateNode.current = currentRoot;
  const currentAccount = { tag: 10, memoizedProps: { value: { userStatus: snapshots.cached } } };
  const currentApi = { tag: 10, memoizedProps: { value: missingApi ? {} : { api } }, child: currentAccount };
  currentRoot.child = currentApi;
  oldRoot.child = { tag: 10, memoizedProps: { value: { api: { auth: {}, executeCommand() { throw Error('stale API must not run'); } } } } };
  const mount = nativeNode({}, { __reactContainerTest: inactive ? oldRoot : currentRoot });
  const unrelatedRoot = { stateNode: {} }; unrelatedRoot.stateNode.current = unrelatedRoot;
  const unrelated = nativeNode({}, { __reactContainerTest: unrelatedRoot });
  const input = nativeNode({}, { isContentEditable: false }, false);
  const badge = nativeNode({ 'aria-label': 'Max, Weekly: 18% quota used' });
  const document = {
    getElementById: id => id === 'codeium.windsurf.settings.planInfo' ? badge : null,
    querySelector: selector => selector.includes('data-slate-editor') ? input : null,
    querySelectorAll: selector => selector === '*' ? unrelatedFirst ? [unrelated, mount] : [mount]
      : selector.includes('data-slate-editor') ? [input] : [],
  };
  return { page: nativePage(document, { atob, Uint8Array }), calls, listeners, currentAccount, currentApi, unrelatedRoot, document };
}

test('Devin quota refresh reads the native account snapshot, not stale React data or a window badge', async () => {
  const h = devinAccountUsage();
  const usage = await h.page.readDevinUsage(true);
  assert.equal(usage.missing, false);
  assert.equal(usage.plan, 'Max');
  assert.equal(usage.limits.length, 1);
  assert.equal(usage.limits[0].basis, 'remaining');
  assert.equal(usage.limits[0].pct, 35);
  assert.equal(usage.limits[0].reset, new Date(1794729600000).toLocaleString('zh-CN'));
  assert.equal(usage.extra, '$11.31');
  assert.equal(typeof usage.updated, 'number');
  assert.equal(usage.cached, undefined);
  assert.deepEqual(h.calls, [['refresh'], ['decode', 'fresh']]);
  assert.equal(h.listeners.size, 0);
});

test('Devin quota chooses the current native provider when the DOM root points to its alternate', async () => {
  const h = devinAccountUsage({ inactive: true });
  const usage = await h.page.readDevinUsage(true);
  assert.equal(usage.limits[0].pct, 35);
  assert.deepEqual(h.calls, [['refresh'], ['decode', 'fresh']]);
});

test('Devin quota keeps the account decoder and native API in the same mounted root', async () => {
  const h = devinAccountUsage({ unrelatedFirst: true });
  h.unrelatedRoot.child = h.currentAccount;
  h.currentApi.child = null;
  const result = await h.page.readDevinUsage(true);
  assert.equal(result.missing, true); assert.equal(h.calls.length, 0);
});

test('Devin quota still reads the native account when no composer is mounted', async () => {
  const h = devinAccountUsage(), query = h.document.querySelectorAll;
  h.document.querySelectorAll = selector => selector === '*' ? query(selector) : [];
  const result = await h.page.readDevinUsage(false);
  assert.equal(result.limits[0].pct, 40);
  assert.equal(result.cached, true);
});

test('an unchanged native quota snapshot still confirms a successful account refresh', async () => {
  const h = devinAccountUsage({ unchanged: true });
  const usage = await h.page.readDevinUsage(true);
  assert.equal(usage.limits[0].pct, 40);
  assert.equal(typeof usage.updated, 'number');
  assert.equal(usage.cached, undefined);
  assert.equal(h.listeners.size, 0);
});

test('a failed native account refresh returns explicit cached quota without a new timestamp', async () => {
  const h = devinAccountUsage({ fail: true });
  const usage = await h.page.readDevinUsage(true);
  assert.equal(usage.limits[0].pct, 40);
  assert.equal(usage.cached, true);
  assert.match(usage.refreshError, /native account unavailable/);
  assert.equal(usage.updated, undefined);
  assert.equal(h.listeners.size, 0);
});

test('an unconfirmed native account refresh is not labeled freshly updated', async () => {
  const h = devinAccountUsage({ emit: false });
  const usage = await h.page.readDevinUsage(true);
  assert.equal(usage.cached, true);
  assert(usage.refreshError);
  assert.equal(usage.updated, undefined);
  assert.equal(h.listeners.size, 0);
});

test('reading native quota without refresh does not invent freshness', async () => {
  const h = devinAccountUsage();
  const usage = await h.page.readDevinUsage(false);
  assert.equal(usage.limits[0].pct, 40);
  assert.equal(usage.cached, true);
  assert.equal(usage.updated, undefined);
  assert.deepEqual(h.calls, [['decode', 'cached']]);
});

for (const options of [{ missingApi: true }, { missingSnapshot: true }]) {
  test(`missing native account data is unknown, not a freshly read window badge: ${JSON.stringify(options)}`, async () => {
    const h = devinAccountUsage(options);
    const usage = await h.page.readDevinUsage(true);
    assert.equal(usage.missing, true);
    assert.equal(usage.updated, undefined);
    assert.equal(usage.limits.length, 0);
    assert.equal(h.listeners.size, 0);
  });
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

for (const [text, basis] of [['20% remaining', 'remaining'], ['剩余 20%', 'remaining'], ['20% 已用', 'used'],
  ['已使用 20%', 'used'], ['80% used · 20% remaining', 'remaining']]) {
  test(`Cursor quota keeps its percentage direction: ${text}`, () => {
    const bar = nativeNode({ 'aria-valuenow': '20', 'aria-valuemax': '100', 'aria-label': 'usage', 'aria-valuetext': text });
    const root = nativeNode({}, { innerText: '当前套餐\nPro\n' + text,
      querySelectorAll: selector => selector === '[role=progressbar]' ? [bar] : [] });
    const context = createPageContext({ settingsPanel: () => root, vis: () => true, fullText: el => el.innerText || '' });
    vm.runInContext(part(read('server/page/settings.js'), '  const readUsage =', '\n\n\n\n  // Full xterm') + '\nthis.result=readUsage();', context);
    assert.equal(context.result.plan, 'Pro');
    assert.equal(context.result.limits[0].pct, 20);
    assert.equal(context.result.limits[0].basis, basis);
  });
}

test('native effort IDs match their displayed casing without losing non-Latin labels', () => {
  const rows = ['Low', 'High', '深度', 'unrelated'].map(innerText => nativeNode({}, { innerText }));
  const context = createPageContext({ effortItems: () => [{ label: 'low' }, { label: 'high' }, { label: '深度' }],
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
      querySelectorAll: selector => selector === '[data-composer-navigation-target="reasoning"]' ? [button] : selector.includes('[data-composer-body]') ? [root] : [] };
    const page = nativePage(doc);
    assert.deepEqual(Array.from(page.effortItems(false, true), row => row.label), [...efforts.map(row => row.reasoningEffort), ...(supported ? ['max'] : [])]);
  });
}

for (const label of ['Context: 35%', 'Context usage: 35%', '上下文用量：35%']) {
  test(`Codex context percentage reads its verified native label: ${label}`, () => {
    const button = nativeNode({ 'aria-label': label });
    const doc = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [button] };
    const result = nativePage(doc).contextPct();
    assert.equal(result.pct, 35); assert.equal(result.basis, 'used');
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
  const context = createPageContext({
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
      + part(composer, 'function submitComposerReceipt(', "$('insertNewline').addEventListener")
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
  const context = createPageContext({
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
    + part(composer, 'function submitComposerReceipt(', "$('insertNewline').addEventListener")
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
  const context = createPageContext({ text: input, mode: 'chat', currentApp: 'codex', questionCompose: null,
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

test('image-only optimistic messages retain previews, reuse image rendering and disappear on their own native receipt', () => {
  const image = 'data:image/png;base64,fixture', rendered = [], nodes = [];
  const context = createPageContext({ desktopAttachments: [{ id: 'image-A', preview: image }], viewSel: 'codex|window|A',
    pendingEchoes: [], submittedMessages: [], currentApp: 'codex', Date, I18N: { tr: value => value }, queueChatRender() {},
    renderItem(item) {
      rendered.push(item);
      const bubble = {}, meta = {}, node = { classList: { add(value) { node.pending = value; } },
        querySelector: selector => selector === '.bubble' ? bubble : meta, bubble, meta };
      nodes.push(node); return node;
    } });
  vm.runInContext(part(read('app/js/composer.js'), 'function pushEcho(', 'let inputRevision =')
    + part(read('app/js/history.js'), 'function pruneEchoes(', 'const executionRecordsShown ='), context);
  context.pushEcho('image-request', '', 'chat');
  context.desktopAttachments.length = 0;
  assert.equal(context.pendingEchoes[0].images[0], image);
  const pending = context.pendingEchoEls();
  assert.equal(pending.length, 1); assert.equal(rendered[0].k, 'human'); assert.equal(rendered[0].images[0], image);
  assert.equal(nodes[0].bubble.hidden, true); assert.equal(nodes[0].meta.textContent, '发送中…');
  context.pendingEchoes[0].confirmed = true; context.pendingEchoes[0].messageId = 'image-user';
  context.pruneEchoes({ items: [{ i: 'other-user', k: 'human', t: '' }], queued: [] });
  assert.equal(context.pendingEchoes.length, 1);
  context.viewSel = 'codex|window|B'; assert.equal(context.pendingEchoEls().length, 0);
  context.pruneEchoes({ items: [{ i: 'image-user', k: 'human', t: '' }], queued: [] });
  assert.equal(context.pendingEchoes.length, 1);
  context.viewSel = 'codex|window|A';
  context.pruneEchoes({ items: [{ i: 'image-user', k: 'human', t: '' }], queued: [] });
  assert.equal(context.pendingEchoEls().length, 0);
  context.pushEcho('text-request', 'caption', 'chat'); context.pendingEchoEls();
  assert.equal(nodes.at(-1).bubble.hidden, false); assert.equal(rendered.at(-1).t, 'caption');
});

function syncingDraft(newer = false) {
  const h = acceptedDraft(newer), scheduled = new Map(), packets = [];
  let next = 0, key = 'draft';
  Object.assign(h.context, { windowReady: true, draftPushTimer: 0, endInputRecall() {},
    draftKey: () => key, send: message => packets.push({ ...message, sel: h.context.viewSel }),
    setTimeout: callback => { scheduled.set(++next, callback); return next; }, clearTimeout: id => scheduled.delete(id),
  });
  const source = read('app/js/composer.js');
  vm.runInContext(part(source, 'function saveDraft()', 'function autosize(')
    + part(source, 'function failPendingSend(', 'function disconnectPendingSends('), h.context);
  return { ...h, packets,
    flush() { const callbacks = [...scheduled.values()]; scheduled.clear(); for (const callback of callbacks) callback(); },
    navigate(target, sel) { h.context.saveDraft(); key = target; h.context.viewSel = sel; h.context.restoreDraft(); },
    writeAck(message) { h.context.receiveDraft({ ...message, t: 'draftAck', ok: true, read: false }); },
  };
}

test('desktop draft mirrors into a focused idle input while unacknowledged phone edits and IME retain priority', () => {
  const h = acceptedDraft(false), c = h.context;
  c.pendingSends.clear(); c.document.activeElement = h.input;
  const update = (text, revision = c.draftRevision) => c.receiveDraft({ t: 'draft', sel: c.viewSel, draftEpoch: c.draftEpoch, revision, text });
  update('desktop edit'); assert.equal(h.input.value, 'desktop edit');
  h.input.value = 'phone edit'; c.draftRevision++;
  update('older desktop'); assert.equal(h.input.value, 'phone edit');
  c.receiveDraft({ t: 'draftAck', sel: c.viewSel, draftEpoch: c.draftEpoch, revision: c.draftRevision, text: 'phone edit', ok: true, read: false });
  c.composing = true; update('latest desktop'); assert.equal(h.input.value, 'phone edit');
  c.composing = false; c.receiveDraft(c.pendingDesktopDraft); assert.equal(h.input.value, 'latest desktop');
  c.receiveDraft({ t: 'draft', sel: 'other', draftEpoch: c.draftEpoch, revision: c.draftRevision, text: 'other entry' });
  assert.equal(h.input.value, 'latest desktop');
});

test('native Codex desktop input invalidates its subscription and releases the input listener on stop', () => {
  const handlers = new Map(), editor = {}, calls = [];
  const doc = { defaultView: {}, addEventListener: (event, fn) => handlers.set(event, fn), removeEventListener: event => handlers.delete(event) };
  const context = createPageContext({ doc, remoteContext: { app: 'codex', threadId: 'A' },
    codexThread: () => 'A', composerTarget: () => ({ contains: target => target === editor }),
    codexNativeManager: () => ({ addConversationCallback: () => () => calls.push('stopped') }),
    codexAsyncQuestionState: () => ({ sources: new Map() }) });
  const watch = vm.runInContext(part(read('server/page/chat-extract.js'), '  const watchCodexData =', '  const codexUserText =') + '\nwatchCodexData;', context)(() => calls.push('changed'));
  handlers.get('input')({ target: {} }); assert.equal(calls.length, 0);
  handlers.get('input')({ target: editor }); assert.deepEqual(calls, ['changed']); assert(doc.defaultView.__remoteAgentDraftEdits.get('A') > 0);
  watch.stop(); assert.equal(handlers.size, 0); assert.equal(calls.at(-1), 'stopped');
});

for (const app of ['cursor', 'devin']) test(`${app} native history returns 160 preceding messages without replaying actions`, async () => {
  const headers = Array.from({ length: 300 }, (_, n) => ({ bubbleId: String(n) }));
  const data = { fullConversationHeadersOnly: headers, todos: [] };
  const context = createPageContext({ remoteContext: { app, threadId: 'bound' },
    cursorPendingTool: id => { assert.equal(id, 'bound'); return { data, decisions: [] }; },
    cursorMessages: async (_id, _data, selected) => selected.map(row => ({ ...row, type: 2, text: row.bubbleId })),
    cursorMessageImages: () => [], nativeMarkdownItem: (i, k, t) => ({ i, k, t }),
    devinSessionData: () => ({}), devinAgentRequests: () => ({}), devinNativeRequests: () => [], activeThread: () => 'other',
    devinSessionRecord: () => ({ title: 'test' }), devinMessageText: blocks => blocks[0].text,
    devinMessages: () => Array.from({ length: 300 }, (_, n) => ({ kind: 'agent_message', content: [{ text: String(n) }] })),
  });
  const load = vm.runInContext(part(read('server/page/chat-extract.js'), '  const nativeConversationChat =', '  const contextPct =') + '\nnativeConversationChat;', context);
  const page = await load(true, 160, app === 'cursor' ? '250:think' : 'acp250:think');
  assert.equal(page.items.length, 160); assert.equal(page.items[0].t, '90'); assert.equal(page.items.at(-1).t, '249');
  assert.equal(page.earlier, true); assert.equal(page.before, 90);
  assert(page.items.every(row => !row.b && !row.actions));
});

for (const app of ['codex', 'cursor', 'devin', 'opencode']) test(`${app} acceptance writes an empty draft before reading desktop state again`, () => {
  const h = syncingDraft(); h.context.currentApp = app;
  h.context.confirmSent({ requestId: 'request', sel: h.context.viewSel });
  h.flush();
  const clear = h.packets.at(-1);
  assert.equal(clear.t, 'draft'); assert.equal(clear.text, ''); assert.equal(h.input.value, '');
  assert(h.context.dirtyDrafts.has('draft'));
  h.ack(7, h.sent.text); assert.equal(h.input.value, '');
  h.writeAck(clear); assert.equal(h.context.dirtyDrafts.has('draft'), false);
  h.navigate('draft', 'codex|A'); h.flush();
  const reopened = h.packets.at(-1);
  assert.equal(Object.hasOwn(reopened, 'text'), false);
  h.ack(reopened.revision, ''); assert.equal(h.input.value, '');
  h.context.receiveDraft({ t: 'draft', sel: 'codex|A', text: 'new desktop draft', draftEpoch: 'epoch', revision: reopened.revision });
  assert.equal(h.input.value, 'new desktop draft');
});

test('a failed empty-draft write remains pending for the originating conversation', () => {
  const h = syncingDraft(); h.context.confirmSent({ requestId: 'request', sel: 'codex|A' }); h.flush();
  const clear = h.packets.at(-1);
  h.context.receiveDraft({ ...clear, t: 'draftAck', ok: false, read: false });
  assert(h.context.dirtyDrafts.has('draft')); assert.equal(h.input.value, '');
  h.navigate('draft', 'codex|A'); h.flush(); assert.equal(h.packets.at(-1).text, '');
});

for (const sameText of [false, true]) test(`an A receipt preserves B and clears A when reopened, identical text=${sameText}`, () => {
  const h = syncingDraft(); h.navigate('draft-B', 'codex|B');
  const value = sameText ? h.sent.text : 'new B command';
  h.input.value = value; h.context.recordDraftEdit();
  h.context.confirmSent({ requestId: 'request', sel: 'codex|A' });
  assert.equal(h.input.value, value); assert.equal(h.context.drafts.has('draft'), false);
  assert(h.context.dirtyDrafts.has('draft')); h.flush();
  assert.equal(h.packets.at(-1).sel, 'codex|B'); assert.equal(h.packets.at(-1).text, value);
  h.navigate('draft', 'codex|A'); h.flush();
  assert.equal(h.input.value, ''); assert.equal(h.packets.at(-1).text, '');
  assert.equal(h.context.drafts.get('draft-B'), value);
});

test('a newer A draft survives an older acceptance delivered while B is selected', () => {
  const h = syncingDraft();
  h.input.value = 'new A text'; h.context.recordDraftEdit(); h.navigate('draft-B', 'codex|B');
  h.context.confirmSent({ requestId: 'request', sel: 'codex|A' });
  assert.equal(h.context.drafts.get('draft'), 'new A text');
  h.navigate('draft', 'codex|A'); h.flush();
  assert.equal(h.input.value, 'new A text'); assert.equal(h.packets.at(-1).text, 'new A text');
});

test('a later edit, including identical text, is synchronized instead of cleared by an earlier receipt', () => {
  for (const sameText of [false, true]) {
    const h = syncingDraft(true); if (!sameText) { h.input.value = 'new command'; h.context.recordDraftEdit(); }
    h.context.confirmSent({ requestId: 'request', sel: 'codex|A' }); h.flush();
    assert.equal(h.packets.at(-1).text, sameText ? h.sent.text : 'new command');
    assert.equal(h.context.pendingDesktopDraft, null);
  }
});

test('pending or rejected sends retain their drafts and do not schedule an empty write', () => {
  const h = syncingDraft();
  h.context.confirmSent({ requestId: 'request', pending: true }); h.flush();
  assert.equal(h.input.value, h.sent.text); assert.equal(h.packets.length, 0);
  h.context.failPendingSend('request', 'not submitted'); h.flush();
  assert.equal(h.input.value, h.sent.text); assert.equal(h.packets.length, 0);
});

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

function takenOutDraft(app = 'devin', value = '') {
  const document = { activeElement: null }, calls = [];
  const input = Object.assign(new EventTarget(), { value, selectionStart: 0, selectionEnd: 0,
    focus() { document.activeElement = input; }, setSelectionRange() {} });
  const context = createPageContext({
    currentApp: app, mode: 'chat', questionCompose: null, text: input, document, Event,
    viewSel: app + '|window|thread', activeDraft: 'draft', draftEpoch: 'epoch',
    inputRevision: 5, draftRevision: 5, draftAckRevision: 5, pendingDesktopDraft: null,
    drafts: new Map(), draftMentions: new Map(), draftVersions: new Map(), dirtyDrafts: new Set(),
    pendingSends: new Map(), composing: false, MN: { value, mentions: [] }, mirroredDraft: '',
    endInputRecall() {}, autosize() { calls.push('resize'); },
    syncMentions(next) { context.MN.value = next; }, mentionUpdate() {},
    queueDraftSync() { calls.push('sync'); }, status() {}, fitViewport() {}, updateComposeCompact() {}, setTimeout() {},
  });
  const composer = read('app/js/composer.js');
  vm.runInContext(part(composer, 'function saveDraft()', 'function restoreDraft(')
    + part(composer, 'function recordDraftEdit()', 'function queueDraftSync(')
    + part(composer, 'function receiveDraft(', 'function autosize(')
    + part(composer, 'function editComposerInput(', '// ---- "@" mentions')
    + part(composer, 'const composerInputHandlers =', 'function composerInputEvent(')
    + 'this.blurDraft=()=>{document.activeElement=null;composerInputHandlers.blur();};\n'
    + 'this.takeOut=m=>{' + part(read('app/js/net.js'), "else if (m.t === 'unqueued') {", "else if (m.t === 'saved')")
      .replace('else if', 'if') + '};', context);
  input.addEventListener('input', event => context.editComposerInput(input, event));
  return { context, input, calls,
    oldDraft: () => context.receiveDraft({ t: 'draft', sel: context.viewSel, draftEpoch: 'epoch', revision: 5, text: '' }) };
}

for (const initial of ['', 'existing ordinary draft']) {
  test(`Devin take-out registers its draft before a stale empty desktop read and blur: ${JSON.stringify(initial)}`, () => {
    const h = takenOutDraft('devin', initial);
    h.context.takeOut({ t: 'unqueued', text: 'queued follow-up' });
    const expected = initial ? initial + '\nqueued follow-up' : 'queued follow-up';
    assert.equal(h.context.draftRevision, 6);
    assert.equal(h.context.drafts.get('draft'), expected);
    assert.equal(h.context.MN.value, expected);
    assert.equal(h.context.dirtyDrafts.has('draft'), true);
    assert(h.calls.includes('sync'));
    h.oldDraft(); h.context.blurDraft();
    assert.equal(h.input.value, expected);
    assert.equal(h.context.pendingDesktopDraft, null);
    h.context.receiveDraft({ t: 'draftAck', ok: true, read: true,
      sel: h.context.viewSel, draftEpoch: 'epoch', revision: 6, text: 'current desktop draft' });
    assert.equal(h.input.value, 'current desktop draft');
  });
}

function codexTranscript() {
  const history = read('app/js/history.js'), context = createPageContext({ currentApp: 'codex' });
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

function cursorBodyFixture() {
  const data = new Map(), reads = [];
  const service = { getComposerDataIfLoaded: id => data.get(id), _composerMessageStorageService: {
    async retrieveMessagesBatch(id, ids) {
      reads.push({ id, ids });
      return new Map(ids.map(key => [key, data.get(id).stored.get(key)]));
    },
  } };
  const context = createPageContext({ cursorSessionServices: () => ({ data: service }), agentRun: () => null, esc: value => value.replace(/</g, '&lt;') });
  const source = read('server/page/chat-extract.js');
  vm.runInContext(part(read('server/page/session-actions.js'), '  const cursorMessages =', '  const nativeSessionPreview =')
    + part(source, '  const nativePerformance =', '  const cursorCurrentChat =')
    + part(source, '  const nativeMarkdownItem =', '  const nativeConversationChat =')
    + part(source, '  const cursorCurrentChat =', '  const extract =') + '\nthis.update = cursorCurrentChat;', context);
  return { reads, update: (chat, limit = 80) => context.update(chat, limit),
    load(id, messages, stored = new Map()) {
      data.set(id, { fullConversationHeadersOnly: messages.map(message => ({ bubbleId: message.bubbleId })),
        conversationMap: Object.fromEntries(messages.map(message => [message.bubbleId, message])), stored });
    } };
}

test('Cursor body reads only the native tail, loads its placeholders and keeps message storage scoped to the thread', async () => {
  const h = cursorBodyFixture();
  const messages = Array.from({ length: 100 }, (_, i) => ({ bubbleId: String(i), type: 2, text: 'A-' + i }));
  messages[99] = { bubbleId: '99', isPlaceholder: true };
  h.load('A', messages, new Map([['99', { bubbleId: '99', type: 2, text: 'A最新' }]]));
  h.load('B', [{ bubbleId: '99', type: 2, text: 'B最新' }]);
  const a = await h.update({ thread: 'A', items: [] });
  assert.equal(a.items.length, 80);
  assert.equal(a.items[0].i, '20');
  assert.equal(a.items.at(-1).t, 'A最新');
  const b = await h.update({ thread: 'B', items: [] });
  assert.equal(b.items[0].t, 'B最新');
  assert.deepEqual(h.reads.map(row => ({ id: row.id, ids: Array.from(row.ids) })), [{ id: 'A', ids: ['99'] }]);
});

test('ordinary Cursor data subscriptions follow the active thread and release the previous native listener', () => {
  let selected = 'A', changes = 0;
  const active = new Map(), disposed = [];
  const context = createPageContext({ remoteContext: null, devinSurface: () => null, activeThread: () => selected,
    cursorSessionServices: () => ({ data: { loadedComposers: {
      subscribe(id, changed) { active.set(id, changed); return { dispose() { active.delete(id); disposed.push(id); } }; },
    } } }) });
  vm.runInContext(part(read('server/page/chat-extract.js'), '  const watchCodexData =', '  const codexUserText =')
    + '\nthis.watch = watchCodexData;', context);
  const watch = context.watch(() => changes++);
  active.get('A')();
  watch.refresh(); assert.equal(active.size, 1);
  selected = 'B'; watch.refresh();
  assert.equal(active.has('A'), false); active.get('B')();
  assert.equal(changes, 2);
  watch.stop(); assert.equal(active.size, 0);
  assert.deepEqual(disposed, ['A', 'B']);
  context.remoteContext = { app: 'cursor', threadId: 'fixed' };
  const fixed = context.watch(() => changes++);
  selected = 'C'; fixed.refresh();
  assert.equal(active.has('fixed'), true); assert.equal(active.has('C'), false);
  fixed.stop(); assert.equal(active.size, 0);
});

test('native window snapshots await Cursor text before publishing and keep the other app extract paths', async () => {
  for (const app of ['cursor', 'codex', 'devin']) {
    const calls = [], saved = [], chat = { thread: 'A', items: [{ i: 'latest', k: 'assistant', t: '已完成读取' }] };
    const state = { thread: 'A', busy: false, run: { id: 'turn-A', status: 'completed' } };
    const helper = { extract(...args) { calls.push(args); return app === 'cursor' ? Promise.resolve(chat) : chat; },
      activeChatTab: () => '', agentStates: () => [state], devinSurface: () => null, agentList: () => [], nativeSessionInfo: async () => [], codexChatRows: () => [] };
    const context = createPageContext({ cdpRead, awaitCdpRead, AbortController, IS_WIN: false, windows: new Map(), PAGE_SRC: 'helper', helpersCall: call => call,
      rememberSessionStatuses: rows => saved.push(...rows),
      refreshSessionCatalog: async () => {}, publishCatalog() {}, withOperation: (_operation, action) => action() });
    const methods = vm.runInNewContext('({' + part(read('server/native-windows.mjs'), '  async read(fresh = false)', '  interval()').replace('\n  readCatalog()', ',\n  readCatalog()') + '})', context);
    const source = { revision: 1, win: { app }, runStates: new Map(), listeners: new Set(), connect: async () => {}, retryCapacity() {},
      cdp: { evaluate: expression => expression === 'sessionPickerRows(true)' ? [] : vm.runInNewContext(expression, { helper, ...helper }) } };
    Object.assign(source, methods);
    const snapshot = await source.read();
    assert.equal(snapshot.chat, chat);
    assert.equal(source.snapshot.chat.items[0].t, '已完成读取');
    assert.equal(calls[0][0], false);
    assert.equal(calls[0][1].length, 0);
    assert.equal(calls[0][2], app === 'codex' ? 120 : 0);
    assert.equal(calls[0][3], app === 'cursor');
    assert.deepEqual(JSON.parse(JSON.stringify(saved)), [{ ...state, app, threadId: 'A' }]);
  }
});

function readingWindow() {
  const calls = [];
  const context = createPageContext({ cdpRead, awaitCdpRead, AbortController, IS_WIN: false, windows: new Map(), PAGE_SRC: '{}', helpersCall: call => call,
    refreshSessionCatalog: async () => {}, publishCatalog() {}, withOperation: (_operation, action) => action() });
  const methods = vm.runInNewContext('({' + part(read('server/native-windows.mjs'), '  async read(fresh = false)', '  interval()').replace('\n  readCatalog()', ',\n  readCatalog()') + '})', context);
  const source = { revision: 1, readRevision: 0, snapshot: null, catalogKey: null,
    win: { app: 'codex' }, runStates: new Map(), listeners: new Set(), connect: async () => {}, retryCapacity() {}, interval: () => 1800,
    cdp: { evaluate: expression => !expression.startsWith('(async') ? Promise.resolve([]) : new Promise(resolve => calls.push(resolve)) } };
  Object.assign(source, methods);
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
  assert.equal((await fresh).chat.items[0].i, 'current'); await h.source.catalogReading; assert.equal(h.source.catalog.length, 0);
});

test('slow native catalogs do not block body snapshots and coalesce concurrent refreshes', async () => {
  const h = readingWindow(), catalog = [], evaluate = h.source.cdp.evaluate;
  h.source.cdp.evaluate = expression => expression.startsWith('(async') ? evaluate(expression)
    : new Promise(resolve => catalog.push(resolve));
  const first = h.source.read();
  await new Promise(resolve => setImmediate(resolve)); h.release(0, 'first');
  assert.equal((await first).chat.items[0].i, 'first');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(catalog.length, 1);
  h.source.revision++;
  const second = h.source.read(true);
  await new Promise(resolve => setImmediate(resolve)); h.release(1, 'second');
  assert.equal((await second).chat.items[0].i, 'second');
  assert.equal(catalog.length, 1);
  const pending = h.source.catalogReading;
  catalog[0]([{ id: 'A', title: 'old' }]); await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(catalog.length, 2);
  catalog[1]([{ id: 'B', title: 'latest' }]); await h.source.catalogReading;
  assert.equal(h.source.catalog[0].id, 'B');
});

test('repeated opening after long native conversations retains the latest thread identity', async () => {
  const h = readingWindow();
  for (let index = 0; index < 20; index++) {
    const thread = index % 2 ? 'B' : 'A', count = index % 3 ? 1 : 80;
    h.source.revision++;
    const work = h.source.read(true);
    await new Promise(resolve => setImmediate(resolve));
    h.calls[index]({ chat: { thread, items: Array.from({ length: count }, (_, i) => ({ i: String(i), t: thread.repeat(2000) })) }, states: [] });
    const snapshot = await work;
    assert.equal(snapshot.chat.thread, thread); assert.equal(snapshot.chat.items.length, count);
    assert.equal(h.source.reading, null);
    await h.source.catalogReading;
  }
});

function firstBodyFixture({ target = 'A', actual = 'A', windows = false, items = [{ i: 'last', k: 'assistant', t: '最新正文' }] } = {}) {
  let finishContext, resolved = 0;
  const events = [], context = new Promise(resolve => { finishContext = resolve; });
  const methods = vm.runInNewContext('({' + part(read('server/agent/chat.mjs'), '  async pollChatRead(immediate, state)', '  async sendPanelRect()') + '})', {
    cdpRead, awaitCdpRead, IS_WIN: windows, nativeWindow: () => null, PAGE_SRC: '{}', uploads: new Map(), readLibrary: () => ({}),
    rememberSessionMessage() {}, codexContext: () => context,
  });
  const cdp = { evaluate: async () => ({ thread: actual, model: 'Codex', items, draft: 'native draft' }) };
  const source = { app: 'codex', cdp, threadId: target, sel: 1, selectionKey: () => 'codex|window|' + source.threadId,
    liveRead: (readCdp, sel) => source.cdp === readCdp && source.sel === sel,
    acceptsChat: chat => chat?.thread === source.threadId, syncSession() {}, emit: event => events.push(event),
    mergeCodexItems() {}, fillThinking() {}, retainThinking() {}, fillDevinCommands() {}, mergeDevinHistory() {},
    withChatUiDetails: action => action(), captureThoughts: async () => {}, rememberThinking() {}, syncAttachments: async () => {} };
  const state = { cdp, sel: 1, requested: true, sent: false, resolve: () => resolved++ };
  return { source, state, events, finishContext, resolved: () => resolved, run: () => methods.pollChatRead.call(source, false, state) };
}

test('Codex first body resolves before context enrichment and never publishes a stale target afterwards', async () => {
  const h = firstBodyFixture(), work = h.run();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.resolved(), 1); assert.equal(h.events.length, 1);
  assert.equal(h.events[0].chat.items[0].t, '最新正文');
  assert.equal(h.events[0].chat.draft, undefined);
  h.source.threadId = 'B'; h.source.sel++;
  h.finishContext({ pct: 10 }); await work;
  assert.equal(h.events.length, 1);
});

test('Codex first body preserves context enrichment and rejects a body from another conversation', async () => {
  const h = firstBodyFixture(), work = h.run();
  await new Promise(resolve => setImmediate(resolve));
  h.finishContext({ pct: 25 }); await work;
  assert.equal(h.events.filter(event => event.t === 'chat').length, 2);
  assert.equal(h.events.at(-1).chat.context.pct, 25);
  const other = firstBodyFixture({ actual: 'B' }); await other.run();
  assert.equal(other.events.length, 0); assert.equal(other.resolved(), 0);
});

for (const windows of [true, false]) test(`Codex first body keeps lazy tool summaries on Windows=${windows}`, async () => {
  const items = [{ i: 'last', k: 'assistant', t: '最新正文' },
    { i: 'exec', k: 'tool', src: 'codex', lazy: true, kind: 'command', t: 'command', cmd: 'full command', output: 'large output'.repeat(2000), exitCode: 0 },
    { i: 'patch', k: 'tool', src: 'codex', lazy: true, kind: 'edit', t: '修改 a.txt', f: 'a.txt', diff: [['+', 'line']] }];
  const h = firstBodyFixture({ windows, items });
  h.source.mergeCodexItems = chat => { h.source.cached = chat.items; };
  const work = h.run();
  await new Promise(resolve => setImmediate(resolve));
  const first = h.events[0].chat;
  assert.equal(h.resolved(), 1); assert.equal(first.items[0].t, '最新正文');
  assert.equal(first.items[1].i, 'exec'); assert.equal(first.items[1].exitCode, 0);
  assert.equal(first.items[1].cmd, undefined); assert.equal(first.items[1].output, undefined);
  assert.equal(first.items[2].diff, undefined); assert(JSON.stringify(first).length < 1000);
  h.finishContext({ pct: 25 }); await work;
  const enriched = h.events.filter(event => event.t === 'chat').at(-1).chat;
  assert.equal(enriched.items[1].output, undefined); assert.equal(enriched.context.pct, 25);
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
  const context = createPageContext({
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
  const context = createPageContext({
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

for (const mode of ['absent', 'error']) {
  test(`the shared model opener retains the ${mode} outcome`, async () => {
    const calls = [];
    const context = createPageContext({ helpersCall: value => value });
    const method = part(read('server/agent/menus.mjs'), '  async openModelList()', '  async ensureSettings(').replace(/,\s*$/, '');
    const open = vm.runInContext('({' + method + '}).openModelList', context);
    const target = {
      cdp: { async evaluate(source) {
        calls.push(source);
        if (mode === 'error') throw new Error('native model read failed');
        if (source === 'clickModelListTrigger()') return false;
        return null;
      } },
      async tapCss() { assert.fail('absent native model control must not receive a click'); },
    };
    if (mode === 'error') {
      await assert.rejects(open.call(target), { message: 'native model read failed' });
      assert.equal(calls.length, 1);
    } else {
      assert.equal(await open.call(target), false);
    }
  });
}

test('reading queue counts does not build buttons for any Agent', () => {
  for (const app of ['cursor', 'devin', 'codex']) {
    let buttons = 0;
    const context = createPageContext({
      chatStale: false, currentApp: app, viewSel: 'fixture', pendingEchoes: [],
      lastChat: { queued: [1, 2, 3].map(id => ({ id: String(id), t: 'fixture' })) },
      I18N: { tr: value => value }, esc: value => value, supportsCapability: () => true,
      ibtn() { buttons++; return '<button></button>'; },
    });
    vm.runInContext(part(read('app/js/history.js'), 'function queuedMessages(', 'function renderQueuedList('), context);
    assert.equal(vm.runInContext('queuedMessages().count', context), 3);
    assert.equal(buttons, 0);
  }
});

test('changed-file controls retain session and computer ownership outside the queue bar', () => {
  const packets = [], nodes = { changeNotice: { hidden: true }, queueBar: { innerHTML: '', classList: { toggle(_, visible) { this.visible = visible; } } } };
  const context = createPageContext({
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
  const context = createPageContext({
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
  const context = createPageContext({ withOperation,
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
  const context = createPageContext({
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
  const context = createPageContext({
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

test('Codex binding resolves the actual writer window only after its exact thread is ready', () => {
  const source = part(read('app/js/notify.js'), 'function finishWinBinding(', 'function bindWin(');
  for (const [app, currentThread, computer, expected] of [
    ['codex', 'thread', 'computer', 'resolved'], ['codex', 'other-thread', 'computer', 'retry'],
    ['cursor', 'thread', 'computer', 'retry'], ['devin', 'thread', 'computer', 'retry'],
    ['codex', 'thread', 'other-computer', 'pending'],
  ]) {
    const calls = [], target = { computer: 'computer', win: app, windowId: 'follower', threadId: 'thread', project: { root: '/B' } };
    const context = createPageContext({ authed: true, windowReady: true, navigationPending: null, currentApp: app,
      currentComputer: () => ({ id: computer, windowId: 'writer', threadId: currentThread }),
      winBinding: { target, resolve: value => calls.push(['resolved', value]), reject: () => assert.fail('unexpected rejection') },
      winTargetReady: value => value.windowId === 'writer' && value.threadId === currentThread,
      openWin: raw => calls.push(['retry', JSON.parse(raw)]),
    });
    vm.runInContext(source, context); context.finishWinBinding();
    assert.equal(calls[0]?.[0] || 'pending', expected);
    if (expected === 'resolved') {
      assert.equal(context.winBinding, null); assert.equal(calls[0][1].windowId, 'writer');
      assert.equal(calls[0][1].project.root, '/B'); assert.equal(target.windowId, 'follower');
    } else if (expected === 'retry') assert.equal(calls[0][1].windowId, 'follower');
  }
});

test('expanded Codex card retains its resolved writer target across composer redraws', async () => {
  let bindings = 0;
  const target = { computer: 'computer', win: 'codex', windowId: 'follower', threadId: 'thread' };
  const resolved = { ...target, windowId: 'writer' };
  const context = createPageContext({ ovToolState: null, ovS: { open: 'card' }, viewSel: 'codex|writer|thread',
    ovRecs: () => [{ key: 'card' }], ovTarget: () => target, ovErr: new Map(), mentionHide() {},
    document: { body: { classList: { contains: () => false } } }, ovReflectComposer() {},
    bindWin: async () => { bindings++; return resolved; }, winTargetReady: value => value.windowId === 'writer',
    ovComposerReady: () => context.ovToolState?.phase === 'ready' && context.ovToolState.target.windowId === 'writer',
  });
  vm.runInContext(part(read('app/js/overview.js'), 'function ovPrepareTools(', 'async function ovUseTool('), context);
  const state = context.ovPrepareTools('card'); assert.equal(await state.ready, true);
  assert.equal(state.target, resolved); assert.equal(state.sel, 'codex|writer|thread');
  assert.equal(context.ovPrepareTools('card'), state); assert.equal(bindings, 1);
});

test('an already-ready window binding returns its resolved target without another attach', async () => {
  const context = createPageContext({ finishWinBinding() {}, mode: 'chat', winTargetReady: () => true });
  vm.runInContext(part(read('app/js/notify.js'), 'function bindWin(', "document.addEventListener('window-ready'"), context);
  const target = { computer: 'computer', win: 'codex', windowId: 'writer', threadId: 'thread' };
  assert.equal(await context.bindWin(target), target);
});

test('overview patching retains its captured microphone while replacing the card subtree', () => {
  const microphone = { classList: { contains: () => false } };
  let connected = true;
  const wrapper = { nodeType: 1, nodeName: 'DIV', getAttribute: () => null,
    remove() { connected = false; container.childNodes = []; } };
  const container = { childNodes: [wrapper], firstChild: wrapper, querySelectorAll: () => [] };
  const empty = { childNodes: [], firstChild: null, querySelectorAll: () => [] };
  const scope = createPageContext({ document: { activeElement: null,
    createElement: () => ({ content: { childNodes: [] } }) },
    $: () => connected ? microphone : null, ovComposerControls: { mic: microphone }, ovToolState: null,
  });
  vm.runInContext(part(read('app/js/overview.js'), 'function ovPatch(', 'function ovCommit(') + ';this.patch=ovPatch;', scope);
  scope.patch(container, '');
  assert.equal(connected, false);
  assert.doesNotThrow(() => scope.patch(empty, ''));
});

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
    const context = createPageContext({
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
  const context = createPageContext({
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
  const context = createPageContext({
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
      if (field.options) {
        node.tagName = 'SELECT'; node.multiple = !!field.multiple;
        node.options = field.options.map(option => ({ ...option, selected: field.multiple ? field.value.includes(option.value) : option.value === field.value }));
        Object.defineProperty(node, 'selectedOptions', { get: () => node.options.filter(option => option.selected) });
      }
      fields.push(node);
    }
  }
  const text = { value: '普通聊天草稿' };
  const context = createPageContext({
    $: () => bar, document: { activeElement: null, body: { classList: { contains: () => false } } },
    currentApp: 'codex', viewSel: 'codex|window|thread', mode: 'chat', questionCompose: null, text,
    chatStale: false, navigationPending: null, lastChat: { thread: 'thread', items: [] }, currentComputer: () => ({ id: 'computer' }),
    ws: { readyState: 1 }, authed: true, windowReady: true, crypto: crypto.webcrypto,
    esc: value => String(value), updateComposeCompact() {}, status() {}, send: packet => packets.push(packet),
  });
  const source = read('app/js/history.js');
  vm.runInContext(part(source, "$('qnBar').addEventListener('click'", '// Small stroke icons'), context);
  context.renderQuestions({ codex: true, requests });
  return { bar, text, fields, buttons, packets, context,
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

function devinQuestionCards(qs) {
  const handlers = new Map(), packets = [];
  const renders = [];
  const bar = {
    _html: '', classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(type, handler) { handlers.set(type, handler); },
    setAttribute() {},
    contains: el => renders.some(render => render.qtext === el || render.qanswer === el),
    querySelector: selector => selector === '[data-qtext]' ? renders.at(-1)?.qtext || null
      : selector === '[data-qanswer]' ? renders.at(-1)?.qanswer || null : null,
    querySelectorAll: selector => selector === 'button,input,select' ? renders.at(-1) ? [renders.at(-1).qanswer, renders.at(-1).qtext].filter(Boolean) : [] : [],
  };
  Object.defineProperty(bar, 'innerHTML', {
    get() { return this._html; },
    set(value) {
      this._html = value;
      const qkey = (/data-qkey="([^"]*)"/.exec(value)?.[1] || '').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      const qtext = { value: '', dataset: { qtext: '', qkey }, tagName: 'INPUT', disabled: false,
        selectionStart: 0, selectionEnd: 0,
        matches: selector => selector === 'input' || selector === '[data-qtext]',
        closest: selector => selector === 'input' ? qtext : null,
        focus() { this.focused = true; },
        setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
        get nextElementSibling() { return renders.at(-1)?.qanswer || null; } };
      const qanswer = { dataset: { qanswer: '' }, disabled: false,
        closest: selector => selector === 'button' ? qanswer : null,
        click() { if (!this.disabled) { handlers.get('click')({ target: this }); bar.onclick({ target: this }); } } };
      renders.push({ qtext, qanswer, html: value });
    },
  });
  const text = { value: '普通聊天草稿' };
  const context = createPageContext({
    $: () => bar, document: { activeElement: null, body: { classList: { contains: () => false } } },
    currentApp: 'devin', viewSel: 'devin|window|thread', mode: 'chat', questionCompose: null, text,
    chatStale: false, navigationPending: null, lastChat: { thread: 'thread', items: [] },
    ws: { readyState: 1 }, authed: true, windowReady: true, crypto: crypto.webcrypto,
    esc: value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;'), updateComposeCompact() {}, status() {}, send: packet => packets.push(packet),
    qnState: null, qnSig: '', qnView: '', qnPending: null,
    setQuestionCompose() {}, submitQuestionCompose() {}, finishPending() {},
    currentComputer: () => null, drafts: new Map(), draftMentions: new Map(),
  });
  const source = read('app/js/history.js');
  vm.runInContext(part(source, "$('qnBar').addEventListener('click'", '// Small stroke icons'), context);
  context.renderQuestions(qs);
  return { bar, text, packets, renders, handlers, context,
    enter(target, extra = {}) {
      let prevented = false;
      handlers.get('keydown')({ key: 'Enter', target, isComposing: false, preventDefault() { prevented = true; }, ...extra });
      return prevented;
    },
  };
}

const devinQuestionState = (overrides = {}) => ({
  devin: true, src: 'devin', canText: true, textKey: 'req-0',
  list: [{ text: '选哪条路径？', options: [{ label: '路径 A', desc: '', sel: false }, { label: '路径 B', desc: '', sel: false }], multi: false }],
  pager: null, canPrev: false, canNext: false, hasSubmit: false, canSubmit: false, ...overrides,
});

test('Devin question text sends one native text answer without an ordinary echo and keeps IME safe', () => {
  const h = devinQuestionCards(devinQuestionState());
  const input = h.renders.at(-1).qtext, answer = h.renders.at(-1).qanswer;
  input.value = '自由文本回答'; input.oninput();
  assert.equal(h.enter(input, { isComposing: true }), false);
  assert.equal(h.packets.length, 0);
  assert.equal(h.enter(input), true);
  assert.equal(h.packets.length, 1);
  const packet = JSON.parse(JSON.stringify(h.packets[0]));
  assert.equal(packet.t, 'question'); assert.equal(packet.part, 'text'); assert.equal(packet.text, '自由文本回答');
  assert.equal(typeof packet.qkey, 'string'); assert.equal(typeof packet.requestId, 'string');
  assert.equal(h.text.value, '普通聊天草稿');
  answer.click();
  assert.equal(h.packets.length, 1);
});

test('Devin question answer clears only its own draft on success and keeps it on failure', () => {
  const h = devinQuestionCards(devinQuestionState());
  const input = h.renders.at(-1).qtext;
  input.value = '待清除草稿'; input.oninput();
  h.renders.at(-1).qanswer.click();
  const failedId = h.packets[0].requestId;
  h.context.finishQuestion({ t: 'questionDone', requestId: failedId, sel: h.context.viewSel, ok: false });
  h.context.renderQuestions(devinQuestionState({ canNext: true }));
  assert.equal(h.renders.at(-1).qtext.value, '待清除草稿', 'a failed answer keeps the draft on the same card');
  h.context.renderQuestions(devinQuestionState());
  h.renders.at(-1).qanswer.click();
  const doneId = h.packets[1].requestId;
  h.context.finishQuestion({ t: 'questionDone', requestId: doneId, sel: h.context.viewSel, ok: true });
  h.context.renderQuestions(devinQuestionState({ canNext: true }));
  assert.equal(h.renders.at(-1).qtext.value, '', 'a successful answer clears the draft on the same card');
});

test('Devin question draft is keyed by the native request so an identical new question starts empty', () => {
  const h = devinQuestionCards(devinQuestionState({ textKey: 'req-0' }));
  const input = h.renders.at(-1).qtext;
  input.value = '旧请求的回答'; input.oninput();
  h.renders.at(-1).qanswer.click();
  const requestId = h.packets[0].requestId;
  h.context.renderQuestions(null);
  assert.equal(h.bar.innerHTML, '');
  h.context.finishQuestion({ t: 'questionDone', requestId, sel: h.context.viewSel, ok: true });
  h.context.renderQuestions(devinQuestionState({ textKey: 'req2-0' }));
  assert.equal(h.renders.at(-1).qtext.value, '', 'a new elicitation with the same text gets an empty input');
  assert.equal(h.text.value, '普通聊天草稿', 'the ordinary composer draft is untouched');
});

function voiceComposer() {
  const calls = [], input = { value: 'saved', selectionStart: 5, selectionEnd: 5 };
  const text = { value: 'saved', selectionStart: 5, selectionEnd: 5,
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    dispatchEvent() { input.value = text.value; input.selectionStart = text.selectionStart; input.selectionEnd = text.selectionEnd; } };
  const context = createPageContext({
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

function usageMeters() {
  const nodes = new Map(), computer = { id: 'computer-A' }, document = new EventTarget();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', title: '', style: { setProperty() {} },
      parentElement: { style: { setProperty() {} }, dataset: {} }, classList: { toggle() {} }, setAttribute() {},
      querySelector: () => ({}), querySelectorAll: () => [], insertAdjacentHTML(_where, html) { this.innerHTML += html; } });
    return nodes.get(id);
  };
  let clock = 0;
  const context = createPageContext({ document, Event, $: node, currentComputer: () => computer, lastChat: null, performance: { now: () => clock }, Date: class extends Date { static now() { return 100000 + clock; } },
    currentApp: 'codex', viewSel: 'codex|window-A|thread-A', windowReady: true, esc: String, ready: true, status() {} });
  context.ovComposerReady = key => context.ready && key === 'card';
  const source = read('app/js/sheets.js');
  vm.runInContext(part(source, 'function fusionUsageBars(', 'function showTerminals(')
    + part(source, 'function meterFill(', '// Phones show the value text')
    + part(source, 'const quotaCache = new Map();', 'function showUsageDetails(')
    + part(read('app/js/overview.js'), 'function ovUsageHtml(', 'function ovUpdateUsage('), context);
  return { context, computer, nodes, node, at: ms => { clock = ms; },
    data: () => JSON.parse(JSON.stringify(context.currentUsageMeters())), html: () => context.ovUsageHtml('card') };
}

test('context stays scoped to a conversation while quota stays scoped to its computer and window', () => {
  const h = usageMeters(); h.context.renderQuota({ context: 30, quota: [{ label: 'weekly', pct: 60, basis: 'remaining' }] });
  h.context.viewSel = 'codex|window-A|thread-B';
  assert.equal(h.data().context, null); assert.equal(h.data().quota[0].pct, 60);
  h.context.viewSel = 'codex|window-B|thread-B'; assert.deepEqual(h.data(), { context: null, quota: [] });
  h.context.viewSel = 'codex|window-A|thread-A'; h.computer.id = 'computer-B';
  assert.deepEqual(h.data(), { context: null, quota: [] });
});

test('disconnect clears displayed usage and a failed read cannot retain an old quota percentage', () => {
  const h = usageMeters();
  h.context.renderQuota({ context: 62, bars: [{ label: 'Weekly', pct: 68, basis: 'remaining' }] });
  h.context.windowReady = false;
  h.context.document.dispatchEvent(new Event('composer-state'));
  assert.deepEqual(h.data(), { context: null, quota: [] });
  assert.equal(h.node('meterCtxPct').textContent, '未获取');
  assert.doesNotMatch(h.node('quotaMeters').innerHTML, /68%/);
  h.context.windowReady = true;
  h.context.renderQuota({ bars: [{ label: 'Weekly', pct: 56, basis: 'remaining' }] });
  h.context.renderQuota({ error: '额度接口请求失败', automatic: true });
  assert.deepEqual(h.data().quota, []);
  assert.match(h.node('quotaMeters').innerHTML, /未获取/);
  assert.equal(h.node('quotaStatus').textContent, '额度接口请求失败');
});

test('Linux Devin view switching follows a new matching project window while the original remains in agent mode', async () => {
  const calls = [], surfaces = { old: 'agent', wrong: 'editor', target: 'editor' };
  let scans = 0;
  const context = createPageContext({ IS_WIN: false, helpersCall: value => value, awaitCdpRead: value => value,
    setTimeout: resolve => resolve(),
    listWindows: async () => (++scans === 1 ? ['old', 'wrong'] : ['old', 'wrong', 'target'])
      .map(id => ({ id, app: 'devin', ws: id })),
    editorRoots: async cdp => [{ root: cdp.id === 'target' ? '/project' : '/other-project' }],
    Cdp: class {
      constructor(id) { this.id = id; }
      async connect() {}
      async evaluate() { return surfaces[this.id]; }
      close() { calls.push(['close', this.id]); }
    },
  });
  const switchSurface = vm.runInContext('({' + part(read('server/apps/devin.mjs'), 'async setSurface(', '// The IDE history') + '}).setSurface', context);
  const session = { app: 'devin', windowId: 'old', cdp: { evaluate: async () => true },
    projectMatches: (roots, cwd) => roots[0].root === cwd,
    openBound: async window => { calls.push(['bind', window.id]); }, checkProjectTrust: async () => false,
    adapter: { openAgent: async id => calls.push(['thread', id]) }, resumeProjectSwitch: async () => {}, emit() {},
  };
  await switchSurface.call(session, 'editor', { surface: 'agent', key: 'bound-thread', cwd: '/project' });
  assert.equal(scans, 2); assert.equal(session.bindingReady, true);
  assert.deepEqual(calls.filter(row => row[0] === 'bind'), [['bind', 'target']]);
  assert(calls.some(row => row[0] === 'thread' && row[1] === 'bound-thread'));
  assert.equal(surfaces.old, 'agent');
});

test('usage reads cannot relabel a previous selection result as the newly bound thread', async () => {
  let finish;
  const emitted = [], session = { app: 'codex', sel: 1, cdp: {}, selection: 'codex|window|old',
    selectionKey() { return this.selection; }, liveRead: () => true, emit: value => emitted.push(value),
    adapter: { usageContext: () => new Promise(resolve => { finish = resolve; }),
      accountUsage: () => { throw new Error('Must not query quota for a superseded selection'); } } };
  const readUsage = menuMethods.fetchUsage.call(session, { manual: true });
  session.selection = 'codex|window|new'; finish(62); await readUsage;
  assert.deepEqual(emitted, []);
});

test('OpenCode context preserves native token details and distinguishes unknown usage from zero', () => {
  const h = usageMeters();
  h.context.renderContext({ source: 'opencode', used: null, limit: 131072, pct: null, basis: 'used', model: 'Bonsai', updated: null });
  assert.equal(h.node('meterCtxPct').textContent, '尚未统计 / 128K');
  const usage = { source: 'opencode', used: 8000, limit: 131072, pct: 6.1, basis: 'used', model: 'Bonsai', updated: 123456789 };
  h.context.renderContext(usage);
  assert.deepEqual(h.data().context, { ...usage, pct: 6 });
  assert.equal(h.node('meterCtxPct').textContent, '已用6%');
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

function nativePerformanceFixture(requests = {}) {
  const context = createPageContext({ window: { __acpStore: { getState: () => ({ acp: { agentRequests: { byId: requests } } }) } } });
  vm.runInContext(part(read('server/page/chat-extract.js'), '  const nativePerformance =', '  const cursorCurrentChat =')
    + '\nthis.read=nativePerformance;', context);
  return (...args) => JSON.parse(JSON.stringify(context.read(...args)));
}

test('native performance uses output counters and keeps Codex reasoning inside its native output total', () => {
  const take = nativePerformanceFixture(), run = { id: 'run', status: 'running', startedAt: 1000, completedAt: 0 };
  const codex = take('codex', 'thread', run, 'model', { latestTokenUsageInfo: {
    total: { outputTokens: 10000 }, last: { inputTokens: 9000, outputTokens: 500, reasoningOutputTokens: 200, cachedInputTokens: 8000, cacheWriteInputTokens: 0 },
  } });
  assert.equal(codex.counter, 10000); assert.equal(codex.tokens.output, 500); assert.equal(codex.tokens.reasoning, 200);
  assert.equal(codex.rate, null); assert.equal(codex.durationMs, null);
  const data = { fullConversationHeadersOnly: [{ bubbleId: 'last' }], conversationMap: { last: { startedAtMs: 2000, turnDurationMs: 3000 } },
    turnTokenUsage: { inputTokens: 8000, outputTokens: 400, cacheReadTokens: 7000, cacheWriteTokens: 0 } };
  const cursor = take('cursor', 'thread', { ...run, status: 'completed' }, 'actual', data);
  assert.equal(cursor.counter, 400); assert.equal(cursor.durationMs, 4000); assert.equal(cursor.rate, 100);
  assert.equal(cursor.model, 'actual');
  assert.equal(take('cursor', 'thread', run, 'actual', { ...data, turnTokenUsage: undefined }).counter, null);
});

test('Devin metrics and elapsed time share the native turn identity independently of client request IDs', () => {
  const take = nativePerformanceFixture(), run = { id: 'client-request', status: 'completed', startedAt: 500, completedAt: 8000 };
  const data = { currentTurnId: 'turn', messages: [
    { kind: 'user_message', content: [{ _meta: { 'cognition.ai/clientMessageId': 'turn', 'cognition.ai/timestamp': '1970-01-01T00:00:01.000Z' } }] },
    { kind: 'agent_message', turnId: 'old', content: [{ _meta: { 'cognition.ai/timestamp': '1970-01-01T00:00:20.000Z' } }] },
    { kind: 'agent_message', turnId: 'turn', content: [{ _meta: { 'cognition.ai/timestamp': '1970-01-01T00:00:05.000Z' } }] },
  ], turnStats: { turn: { requestId: 'server-request', cause: 'complete', responseDimensions: [
    { uid: 'model', kind: { value: 'Actual SWE' } }, { uid: 'input_tokens', kind: { value: 8000 } },
    { uid: 'output_tokens', kind: { value: 200 } }, { uid: 'cached_input_tokens', kind: { value: 6000 } },
  ] } } };
  const perf = take('devin', 'thread', run, 'selected', data);
  assert.equal(perf.runId, 'turn'); assert.equal(perf.counter, 200); assert.equal(perf.rate, 50);
  assert.equal(perf.durationMs, 4000);
  assert.equal(perf.tokens.cacheRead, 6000); assert.equal(perf.model, 'Actual SWE');
  data.currentTurnId = 'next-turn';
  const next = take('devin', 'thread', { ...run, status: 'running' }, 'selected', data);
  assert.equal(next.counter, null); assert.equal(next.rate, null); assert.equal(next.runId, 'next-turn');
});

test('token estimates settle fixed three-second windows, ignore duplicate snapshots and reset on scope changes', () => {
  const h = usageMeters(), info = { source: 'cursor', runId: 'run-1', usageId: 'run-1', model: 'model-1', unit: 'tokens',
    busy: true, tokens: { input: 90000, output: 100, reasoning: 40, cacheRead: 80000 }, counter: 1000, rate: null, startedAt: 100000 };
  const paint = perf => { h.context.lastChat = { performance: perf }; h.context.renderContext({ pct: 40, basis: 'used' }); };
  paint(info);
  assert.equal(h.node('perfChip').textContent, '统计中');
  h.at(1000); paint({ ...info, counter: 1030 }); h.at(2500); paint({ ...info, counter: 1090 });
  assert.equal(h.node('perfChip').textContent, '统计中');
  h.at(3000); paint({ ...info, counter: 1120 });
  assert.equal(h.node('perfChip').textContent, '40 tok/s'); assert.equal(h.node('perfChip').title, '3 秒估算速度');
  assert.match(h.node('perfPanel').innerHTML, /统计区间<\/span><span class="perf-val">3s/);
  h.at(4000); paint({ ...info, counter: 1150 }); assert.equal(h.node('perfChip').textContent, '40 tok/s');
  h.at(6000); paint({ ...info, counter: 1180 }); assert.equal(h.node('perfChip').textContent, '20 tok/s');
  assert.match(h.node('perfPanel').innerHTML, /耗时<\/span><span class="perf-val">6s/);
  h.at(9000); paint({ ...info, counter: 1180 }); assert.equal(h.node('perfChip').textContent, '统计中');
  h.at(10000); paint({ ...info, counter: 10 }); assert.equal(h.node('perfChip').textContent, '统计中');
  h.at(11000); paint({ ...info, counter: 40 }); assert.equal(h.node('perfChip').textContent, '统计中');
  h.at(13000); paint({ ...info, counter: 70 }); assert.equal(h.node('perfChip').textContent, '20 tok/s');
  paint({ ...info, counter: null }); assert.equal(h.node('perfChip').textContent, '统计中');
  h.at(14000); paint({ ...info, counter: 20 }); assert.equal(h.node('perfChip').textContent, '统计中');
  h.at(23000); paint({ ...info, counter: 920 }); assert.equal(h.node('perfChip').textContent, '统计中');
  for (const change of [() => { h.computer.id = 'computer-B'; }, () => { h.context.viewSel = 'codex|window-A|thread-B'; }]) {
    change(); paint({ ...info, counter: 30 }); assert.equal(h.node('perfChip').textContent, '统计中');
  }
  paint({ ...info, runId: 'run-2', counter: 40 }); assert.equal(h.node('perfChip').textContent, '统计中');
  paint({ ...info, runId: 'run-2', model: 'model-2', counter: 50 }); assert.equal(h.node('perfChip').textContent, '统计中');
  paint(null); assert.equal(h.node('perfChip').hidden, true); assert.equal(h.node('perfPanel').hidden, true);
});

test('Codex speed uses elapsed time between changed counters and preserves its measured interval', () => {
  for (const rate of [null, 999]) {
    const h = usageMeters(), info = { source: 'codex', runId: 'turn', model: 'actual', unit: 'tokens',
      busy: true, counter: 100, rate, durationMs: 10000 };
    h.context.renderPerfChip(info);
    assert.equal(h.node('perfChip').textContent, '待更新');
    assert.match(h.node('perfPanel').innerHTML, /统计区间<\/span><span class="perf-val">—/);
    h.at(1000); h.context.renderPerfChip(info);
    assert.equal(h.node('perfChip').textContent, '待更新');
    h.at(12000); h.context.renderPerfChip({ ...info, counter: 400 });
    assert.equal(h.node('perfChip').textContent, '25 tok/s');
    assert.equal(h.node('perfChip').title, '更新区间平均速度');
    assert.match(h.node('perfPanel').innerHTML, /统计区间<\/span><span class="perf-val">12s/);
    h.at(13000); h.context.renderPerfChip({ ...info, counter: 400 });
    assert.equal(h.node('perfChip').textContent, '25 tok/s');
    h.at(30000); h.context.renderPerfChip({ ...info, counter: 1300 });
    assert.equal(h.node('perfChip').textContent, '50 tok/s');
    assert.match(h.node('perfPanel').innerHTML, /统计区间<\/span><span class="perf-val">18s/);
    h.at(33000); h.context.renderPerfChip({ ...info, busy: false, counter: 1450, rate: 999, durationMs: 35000 });
    assert.equal(h.node('perfChip').textContent, '50 tok/s');
    assert.match(h.node('perfPanel').innerHTML, /统计区间<\/span><span class="perf-val">3s/);
    assert.match(h.node('perfPanel').innerHTML, /耗时<\/span><span class="perf-val">35s/);
    h.at(50000); h.context.renderPerfChip({ ...info, busy: false, counter: 1450, rate: 999, durationMs: 35000 });
    assert.equal(h.node('perfChip').textContent, '50 tok/s');
    assert.match(h.node('perfPanel').innerHTML, /统计区间<\/span><span class="perf-val">3s/);
    h.context.renderPerfChip({ ...info, runId: 'historical', busy: false, counter: 1000, rate: 999 });
    assert.equal(h.node('perfChip').textContent, '—');
    h.context.renderPerfChip({ ...info, runId: 'next', counter: null });
    assert.equal(h.node('perfChip').textContent, '待更新');
    h.at(60000); h.context.renderPerfChip({ ...info, runId: 'next', busy: false, counter: 200, rate: 999 });
    assert.equal(h.node('perfChip').textContent, '—');
  }
});

test('Codex update intervals restart at missing or rolled-back counters and remain scoped to their owner', () => {
  const h = usageMeters(), info = { source: 'codex', runId: 'turn', model: 'actual', unit: 'tokens', busy: true, rate: null };
  const paint = counter => h.context.renderPerfChip({ ...info, counter });
  paint(null); h.at(4000); paint(1000);
  assert.equal(h.node('perfChip').textContent, '待更新');
  h.at(14000); paint(1300); assert.equal(h.node('perfChip').textContent, '30 tok/s');
  h.at(15000); paint(1); assert.equal(h.node('perfChip').textContent, '待更新');
  h.at(17000); paint(61); assert.equal(h.node('perfChip').textContent, '30 tok/s');
  for (const change of [() => { h.computer.id = 'other-computer'; },
    () => { h.context.viewSel = 'codex|window|other-thread'; },
    () => { info.runId = 'other-turn'; }, () => { info.model = 'other-model'; }]) {
    change(); paint(61); assert.equal(h.node('perfChip').textContent, '待更新');
    assert.match(h.node('perfPanel').innerHTML, /统计区间<\/span><span class="perf-val">—/);
  }
});

for (const app of ['cursor', 'devin']) test(`${app} live native counters enter three-second sampling and completion retains its native average`, () => {
  const h = usageMeters(), take = nativePerformanceFixture();
  const run = { id: 'turn', status: 'running', startedAt: 100000, completedAt: 0 };
  const data = output => app === 'cursor' ? {
    fullConversationHeadersOnly: [{ bubbleId: 'last' }],
    conversationMap: { last: { startedAtMs: 100000, turnDurationMs: 5000 } },
    turnTokenUsage: { inputTokens: 90000, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 },
  } : {
    currentTurnId: 'turn', messages: [
      { kind: 'user_message', content: [{ _meta: { 'cognition.ai/clientMessageId': 'turn', 'cognition.ai/timestamp': '1970-01-01T00:01:40.000Z' } }] },
      { kind: 'agent_message', turnId: 'turn', content: [{ _meta: { 'cognition.ai/timestamp': '1970-01-01T00:01:45.000Z' } }] },
    ], turnStats: { turn: { responseDimensions: [
      { uid: 'model', kind: { value: 'actual' } }, { uid: 'input_tokens', kind: { value: 90000 } },
      { uid: 'output_tokens', kind: { value: output } },
    ] } },
  };
  const paint = (output, completed = false) => {
    const native = data(output);
    if (app === 'devin' && completed) native.turnStats.turn.cause = 'complete';
    const info = take(app, 'thread', { ...run, status: completed ? 'completed' : 'running' }, 'actual', native);
    assert.equal(info.counter, output);
    assert.equal(info.rate, completed ? 50 : null);
    h.context.renderPerfChip(info);
  };
  paint(100);
  h.at(1000); paint(160); assert.equal(h.node('perfChip').textContent, '统计中');
  h.at(3000); paint(190);
  assert.equal(h.node('perfChip').textContent, '30 tok/s');
  assert.equal(h.node('perfChip').title, '3 秒估算速度');
  h.at(5000); paint(250, true);
  assert.equal(h.node('perfChip').textContent, '50 tok/s');
  assert.equal(h.node('perfChip').title, '轮次平均');
});

test('performance distinguishes live characters, completed native tokens and turn averages without changing context meters', () => {
  const h = usageMeters(), paint = performance => {
    h.context.lastChat = { performance }; h.context.renderContext({ source: 'opencode', pct: 12, used: 120, limit: 1000 });
  };
  const live = { source: 'opencode', runId: 'message', busy: true, unit: 'characters', rate: null, model: 'Bonsai', durationMs: null, tokens: null };
  paint(live); assert.equal(h.node('perfChip').hidden, false); assert.equal(h.node('perfChip').textContent, '统计中');
  paint({ ...live, rate: 25, durationMs: 2000 });
  assert.equal(h.node('perfChip').textContent, '25 字符/秒'); assert.equal(h.node('perfChip').title, '实时字符速度');
  paint({ ...live, unit: 'tokens', busy: false, rate: 40, durationMs: 6000, tokens: { input: 50, output: 240, reasoning: 0, cacheRead: 0, cacheWrite: 0 } });
  assert.equal(h.node('perfChip').textContent, '40 tok/s'); assert.equal(h.node('perfChip').title, '本次平均');
  assert.equal(h.node('meterCtxPct').textContent, '已用12%');
  paint({ source: 'cursor', runId: 'turn', unit: 'tokens', busy: false, rate: 60, durationMs: 1000, tokens: { output: 60 } });
  assert.equal(h.node('perfChip').title, '轮次平均');
});

test('unbound and missing card metrics remain unknown rather than becoming zero', () => {
  const h = usageMeters(); h.context.renderQuota({ context: 0, missing: true, quota: [] });
  assert(h.html().includes('上下文 已用 0%')); assert(h.html().includes('额度 未获取'));
  h.context.ready = false; assert(h.html().includes('上下文 未获取'));
  assert.equal(h.html().includes('已用 0%'), false);
});

test('multiple quota periods retain their own percentage directions', () => {
  const h = usageMeters(); h.context.renderQuota({ context: { pct: 20, basis: 'remaining' }, limits: [
    { label: 'weekly', pct: 40, basis: 'used' }, { label: 'daily', pct: 70, basis: 'used' },
  ] });
  const html = h.html();
  assert(html.includes('上下文 已用 80%')); assert(html.includes('weekly 剩余 60%')); assert(html.includes('daily 剩余 30%'));
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

function relayHeartbeat({ needsTwoFactor = false, operations = false } = {}) {
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
  const context = createPageContext({
    crypto, Buffer, URL, AbortController, Session, WebSocketServer: Server,
    Date: class extends Date { static now() { return now; } },
    setTimeout: schedule, clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, true), clearInterval: id => timers.delete(id),
    console: { log: message => logs.push(message) }, voiceWss: () => new EventEmitter(),
    findDevice: token => token === 'fixture-token' ? device : null, needsTotp: () => needsTwoFactor,
    computerId: () => 'fixture-computer', computerName: () => 'Fixture', updateDevice() {},
    bindDeviceConnection(_id, close) { const binding = { valid: true, close, release() {} }; bindings.push(binding); return binding; },
    subscribeLibrary() {}, subscribeOperations: operations ? subscribeOperations : () => () => {}, lastSelection: () => null,
    addViewer() {}, removeViewer() {}, clientIp: () => 'fixture', originAllowed: () => true,
    ROUTES: { visible: { connection: true } }, flag, configureNativeRetry() {},
    resolveRoute: (session, type) => context.ROUTES[type],
    beginOperation, withOperation, cdpRead: new AsyncLocalStorage(),
  });
  const strip = source => source.replace(/^import .*;\n/gm, '').replace(/\bexport /g, '');
  vm.runInContext(strip(read('lib/device-proof.mjs')) + strip(read('server/ws.mjs')), context);
  context.attachWss(new EventEmitter());
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return {
    logs, sessions, settle, routes: context.ROUTES, readScope: context.cdpRead,
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

for (const submitted of [false, true]) for (const tracked of [false, true]) {
  test(`OpenCode switching cancels only unsubmitted sends and preserves origin receipts: submitted=${submitted}, operation=${tracked}`, async () => {
    const h = relayHeartbeat({ operations: tracked }), socket = await h.socket(), session = h.bind(socket), events = [];
    session.app = 'opencode'; session.cdp = null;
    const origin = session.selectionKey(); let signal, complete;
    session.emit = message => {
      if (captureOperation(session, message) || h.readScope.getStore()?.aborted) return;
      events.push(message); socket.send(JSON.stringify(message));
    };
    session.finishNavigationResult = () => {};
    session.handle = async message => {
      if (message.t === 'attach') { session.threadId = 'thread-B'; return; }
      signal = h.readScope.getStore();
      if (submitted) { signal.submitted = true; if (currentOperation()) currentOperation().submitted = true; }
      await new Promise((resolve, reject) => { complete = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
      session.emit({ t: 'sent', requestId: message.requestId, sel: origin });
    };
    h.routes.send = ROUTES.send; h.routes.attach = ROUTES.attach;
    socket.receive({ t: 'send', requestId: 'open-code-send', text: 'test', sel: origin, ...(tracked ? { operationId: 'operation-send' } : {}) });
    await h.settle(); socket.receive({ t: 'attach', id: 'opencode', navigationId: 2 }); await h.settle();
    assert.equal(signal.aborted, !submitted);
    if (submitted) complete();
    await h.settle(); await h.settle();
    const results = tracked ? socket.sent.filter(row => row.t === 'operation').flatMap(row => row.events.map(event => event.message)) : events;
    const result = results.findLast(row => row.t === (submitted ? 'sent' : 'sendFailed'));
    assert(result); if (submitted && tracked) assert.equal(result.sel, origin);
    if (!submitted) assert.equal(result.cancelled, true);
    assert.equal(results.some(row => row.t === (submitted ? 'sendFailed' : 'sent')), false);
    assert.equal(session.threadId, 'thread-B'); socket.close(1000);
  });
}

test('switching away from an unfinished OpenCode history read releases the shared queue for another app', async t => {
  const { OpenCodeClient } = await import('../server/opencode/client.mjs');
  const h = relayHeartbeat(), socket = await h.socket(), session = h.bind(socket), trace = [];
  const client = new OpenCodeClient('http://controlled.invalid');
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => {
    trace.push('history-start');
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
      trace.push('history-cancelled'); reject(signal.reason);
    }, { once: true }));
  });
  session.handle = async message => {
    if (message.id === 'opencode') return client.messages('held-thread', '/project', undefined, h.readScope.getStore());
    trace.push('codex-attach');
  };
  session.finishNavigationResult = () => {};
  session.emit = message => socket.send(JSON.stringify(message));
  h.routes.attach = ROUTES.attach; h.routes.ping = ROUTES.ping;
  socket.receive({ t: 'attach', id: 'opencode', navigationId: 1 }); await h.settle();
  assert.deepEqual(trace, ['history-start']);
  socket.receive({ t: 'attach', id: 'codex', navigationId: 2 });
  await h.settle(); await h.settle();
  assert.deepEqual(trace, ['history-start', 'history-cancelled', 'codex-attach']);
  assert.equal(socket.readyState, 1);
  socket.receive({ t: 'ping' }); await h.settle();
  assert.equal(socket.sent.at(-1).t, 'pong');
  socket.close(1000);
});

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

function overviewDirectory(overrides = {}) {
  const targets = [], sources = new Map(), catalogs = new Map(), library = {}, saved = { windows: {}, sessions: {} }, fusionRuns = {};
  const codexBackend = { records: new Map(), states: () => [], owns: id => codexBackend.records.has(id) };
  const context = createPageContext({ IS_WIN: false, path, Date, process: { platform: 'linux' }, saved, fusionRuns,
    codexBackend, CODEX_BACKEND: 'backend',
    openCode: { overview: () => ({ windows: [], sessions: [] }) },
    key: (app, id) => app + ':' + id.replace(/^(cursor|devin|codex):/, ''),
    nativeTargets: () => targets, nativeWindowAt: id => sources.get(id), nativeSessionCatalog: app => catalogs.get(app),
    sessionId: (_app, id) => id || '', readLibrary: () => library, storedProjectSession: (app, id) => saved.sessions[app + ':' + id],
    normPath: value => String(value || '').replaceAll('\\', '/'), pathKey: value => value,
    samePath: (a, b) => a === b, windowName: title => title, workspaces: () => { throw Error('Do not rescan workspace storage'); },
    FUSION_ACTIVE: [], fusionSummary: value => value, allFusionRuns: () => Object.values(fusionRuns).flatMap(value => value.runs),
    fusionMainWindow: (app, id) => Object.values(fusionRuns).flatMap(value => value.runs).some(run => run.bindings.some(binding => binding.role === 'main' && binding.app === app && binding.windowId === id)),
    ...overrides,
  });
  context.codexAdapter = vm.runInContext('({' + part(read('server/apps/codex.mjs'), '  backendThread(', '  closeBackendSettings(') + '})', context);
  vm.runInContext(part(read('lib/files.mjs'), 'export function workspaceLabel(', '// Returns the size').replace('export ', '')
    + part(read('server/project-windows.mjs'), 'export function fusionTargets(', 'export function clearLegacyFusionWindows(').replace('export ', '')
    + read('server/overview.mjs').replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), context);
  return { targets, sources, catalogs, library, saved, fusionRuns, codexBackend,
    add(app, id, root = '/project/remote-agent', host = '') {
      targets.push({ app, id: app + ':' + id, pageId: id, title: 'workspace alias', ws: id });
      const source = { roots: [{ root, host }], catalog: [], previews: new Map(), updatedAt: 100, snapshot: { chat: {}, states: [] },
        overviewStates() { return this.snapshot?.states || []; } };
      sources.set(id, source); return source;
    }, snapshot: () => JSON.parse(JSON.stringify(context.overviewSnapshot('device'))) };
}

test('Windows Cursor cards include other project sessions from the complete catalog with their own directories', () => {
  for (const IS_WIN of [true, false]) {
    const h = overviewDirectory({ IS_WIN });
    const source = h.add('cursor', 'carrier', '/project/A');
    source.catalog = [{ id: 'A', workspace: '/project/A' }, { id: 'B', workspace: '/project/B' }];
    h.catalogs.set('cursor', { rows: [...source.catalog, { id: 'archived', workspace: '/project/B', archived: true }] });
    const snapshot = h.snapshot();
    assert.deepEqual(snapshot.sessions.map(row => row.threadId).sort(), ['A', 'B']);
    {
      const row = snapshot.sessions.find(row => row.threadId === 'B');
      assert.equal(row.workspace, '/project/B');
      assert.equal(row.projectId, JSON.stringify(['cursor', '', '/project/B']));
    }
  }
});

test('Windows Devin idle cards use confirmed current activity without treating an unknown historical turn as completed', () => {
  for (const IS_WIN of [true, false]) for (const busy of [false, true]) for (const statusKnown of [true, false]) {
    const h = overviewDirectory({ IS_WIN });
    const source = h.add('devin', 'window', '/project/A');
    h.catalogs.set('devin', { rows: [{ id: 'thread', workspace: '/project/A', running: busy }] });
    source.snapshot.states = [{ thread: 'thread', busy, statusKnown, run: { id: 'historic', status: 'unknown' } }];
    const row = h.snapshot().sessions[0];
    assert.equal(row.busy, busy);
    assert.equal(row.statusKnown, statusKnown);
    assert.deepEqual(row.run, !busy && statusKnown ? null : { id: 'historic', status: 'unknown' });
    const cards = overviewCards(); cards.apply({ ...row, threadId: 'thread' });
    assert.equal(cards.rows()[0].state, busy ? 'run' : statusKnown ? 'idle' : 'unknown');
    assert.equal(Object.keys(cards.done).length, 0);
  }
});

test('overview labels share normalized Windows identities including an omitted local host', () => {
  const h = overviewDirectory({
    normPath: value => localFilePath(value, true),
    pathKey: (value, local) => local ? localFilePath(value, true).toLowerCase() : value,
  });
  const source = h.add('cursor', 'window', '/C:/Project/Work');
  delete source.roots[0].host;
  source.catalog = [{ id: 'thread', workspace: 'c:\\Project\\Work', title: 'thread' }];
  const first = h.snapshot(), second = h.snapshot();
  assert(first.windows.length > 0); assert(first.windows.every(row => row.project.includes('Work')));
  assert.deepEqual(second.windows, first.windows);
});

test('closed-project Codex status waits for current native data instead of using a saved running flag', () => {
  const h = overviewDirectory(); h.library.codex = { old: { favorite: true } };
  h.saved.sessions['codex:old'] = { workspace: '/project/B', host: '', ownerWindow: 'closed', running: true };
  const cards = overviewCards();
  for (const running of [undefined, false, true, undefined]) {
    h.catalogs.set('codex', { rows: running === undefined ? [] : [{ id: 'old', workspace: '/project/B', running }] });
    const row = h.snapshot().sessions[0]; cards.apply(row);
    assert.equal(row.statusKnown, running !== undefined); assert.equal(row.busy, running === true);
    assert.equal(cards.rows()[0].state, running === undefined ? 'unknown' : running ? 'run' : 'idle');
  }
});

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
  const context = createPageContext({ Date, computerSockets: new Map(), saveComputerResume() {},
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
      currentRoots: async () => [{ root: '/new' }],
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

function nativeCompletionNotifications() {
  const source = read('lib/notify.mjs'), events = [], activeWorking = new Map(), state = {};
  const idle = Number(/const IDLE_POLLS = (\d+)/.exec(source)[1]);
  const context = createPageContext({ Date, os: { hostname: () => 'fixture' }, notifySeq: 0,
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
      querySelector: selector => selector === '.computerFileActions' && node('sheet').innerHTML.includes('computerFileActions') ? node('computerFileActions') : null,
      addEventListener: (event, handler) => handlers.set(event, handler), replaceChildren() { this.innerHTML = ''; },
      focus() { context.document.activeElement = this; }, setSelectionRange() {},
    });
    return nodes.get(id);
  };
  const context = createPageContext({ URLSearchParams, $: node, loadComputers: () => computers, currentComputer: () => selected,
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

for (const [os, initial] of [['linux', '/home/alice/project'], ['win32', 'D:/audit/project']]) {
  test(`${os} file browsing preserves the successful directory for relative retries and parent navigation`, async () => {
    const paths = os === 'linux' ? path.posix : path.win32;
    const h = sharedFileBrowser(url => {
      const input = url.searchParams.get('path');
      if (input === 'missing') throw new Error('目录不存在');
      const directory = paths.resolve(url.searchParams.get('base') || (os === 'linux' ? '/home/alice' : 'C:/Users/alice'), input);
      return { path: directory, parent: paths.dirname(directory), os, entries: [
        { name: 'hello.txt', path: paths.join(directory, 'hello.txt'), directory: false, selectable: true },
      ] };
    });
    await h.open('computer-two', { path: initial, project: { owner: null } });
    const confirmed = h.state().directory;
    await h.context.browseComputerFiles('missing');
    assert.equal(h.state().directory, confirmed);
    assert(h.node('sheet').innerHTML.includes(`data-computer-path="${confirmed.parent}"`));
    await h.context.browseComputerFiles('src');
    const retry = new URL(h.requests.at(-1).route, 'http://fixture');
    assert.equal(retry.searchParams.get('base'), confirmed.path);
    assert.equal(h.state().directory.path, paths.join(confirmed.path, 'src'));
    assert.match(h.node('sheet').innerHTML, /hello.txt/);
    assert.match(h.node('sheet').innerHTML, /data-computer-project="open"/);
    await h.context.browseComputerFiles(h.state().directory.parent);
    assert.equal(h.state().directory.path, confirmed.path);
  });
}

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
  const context = createPageContext({ Cdp, cdpRead: { run: (_signal, action) => action(), getStore: () => null }, awaitCdpRead: value => value,
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
  const context = createPageContext({ computerSockets: new Map([['key', link]]), navigator: { onLine: true } });
  vm.runInContext(part(read('app/js/overview.js'), 'function ovComputerStatus(', 'function ovStOf('), context);
  assert.equal(context.ovComputerStatus({ c: { key: 'key' } }, { data: { errors: [{ error: 'denied' }] } }), 'online');
  assert.equal(context.ovComputerStatus({ c: { key: 'key' } }, { data: { pendingWindows: 1 } }), 'loading');
});

function devinProject(thread = 'acp/devin-cli/new-session') {
  const emitted = [], calls = [], state = { thread, surface: 'editor', items: 0 };
  let active = thread;
  const context = createPageContext({ path, helpersCall: value => value, fusionProject: root => ({ id: root }),
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
    const originalMode = fs.statSync(file).mode & 0o777;
    const h = operationFixture(); h.message = { t: 'saveComputerFile', operationId: crypto.randomUUID(), requestId: 1, path: file, text: 'after' };
    let writes = 0;
    const route = vm.runInNewContext('({' + part(read('server/routes.mjs'), '  saveComputerFile:', '  overviewManage:') + '}).saveComputerFile', {
      realpath: async value => fs.realpathSync(value), writeTextFile: async (...args) => { writes++; return writeTextFile(...args); },
    });
    assert.equal(route.connection, true); assert.equal(route.fast, true);
    h.session.emit = message => captureOperation(h.session, message);
    const first = beginOperation(h.session, h.message);
    await withOperation(first.operation, () => route.fastRun(h.session, h.message)); first.operation.finish();
    assert.equal(fs.readFileSync(file, 'utf8'), 'after'); assert.equal(fs.statSync(file).mode & 0o777, originalMode);
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
  const context = createPageContext({ document, window, navigator, history: { state: { ovDepth: 0 } }, mode: 'chat', APP_VERSION: 'fixture',
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

test('viewport diagnostics collect an overview sample without reading input, identity or changing page geometry', async () => {
  const h = viewportTraceFixture(); h.classes.delete('conv'); h.run('startViewportTrace();');
  h.document.activeElement = h.input; h.document.emit('focusin'); h.window.emit('scroll');
  assert.equal(h.frames.size, 1); h.flush();
  const frame = h.data().samples.find(sample => sample.source === 'frame');
  assert.equal(frame.page, 'overview'); assert.deepEqual(h.data().measurement.before, h.data().measurement.after);
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

test('OpenCode history persistence stores tool metadata without expanded output', () => {
  const context = createPageContext({ SC_MAX: 100, acpNum: () => -1 });
  vm.runInContext(part(read('app/js/history.js'), 'function scSnapshot(', 'let scDrainTimer') + '\nthis.snapshot = scSnapshot;', context);
  const tool = { i: 'tool', lazy: true, details: true, t: 'read', cmd: 'command', output: 'large body', diff: [['+', 'line']] };
  const snapshot = context.snapshot({ items: new Map([['tool', tool]]), collapsed: new Set() });
  assert.equal(snapshot.items[0].output, undefined); assert.equal(snapshot.items[0].details, false);
  assert.equal(tool.output, 'large body');
});

for (const app of ['devin', 'cursor', 'codex', 'opencode']) test(`small WebP follows ${app} native format`, async () => {
  const blobs = [], file = new File([new Uint8Array([1])], 'transparent.webp', { type: 'image/webp' });
  let closed = false;
  const context = createPageContext({ File, Blob,
    createImageBitmap: async () => ({ width: 20, height: 10, close: () => { closed = true; } }),
    document: { createElement: () => ({ getContext: () => ({ drawImage() {} }),
      toBlob(fn, type) { blobs.push(type); fn(new Blob([new Uint8Array([1])], { type })); } }) },
  });
  vm.runInContext(part(read('app/js/voice.js'), 'async function shrinkImage(', 'const imageUploads ='), context);
  const converted = await context.shrinkImage(file, undefined, app);
  if (app === 'devin') {
    assert.equal(converted.name, 'transparent.png'); assert.equal(converted.type, 'image/png');
    assert.deepEqual(blobs, ['image/png']); assert.equal(closed, true);
  } else { assert.equal(converted, file); assert.deepEqual(blobs, []); }
});

for (const [app, mime, converted] of [['devin', 'image/webp', true], ['devin', 'image/png', false], ['cursor', 'image/webp', false]]) {
  test(`prepared image upload retains its captured owner (${app}, ${mime})`, async () => {
    const original = new File(['fixture'], 'sample.webp', { type: mime }), calls = [], options = { prepared: true };
    const record = { app, file: original, options, scope: 'owner-A', sel: 'thread-A' };
    const context = createPageContext({ imageUploads: new Map([['upload', record]]), currentApp: 'other-app',
      shrinkImage: async (file, canvas, owner) => { calls.push(['convert', owner]); return new File(['png'], 'sample.png', { type: 'image/png' }); },
      imageUploadScope: () => 'owner-A', viewSel: 'thread-A', authed: true, ws: { readyState: 1 },
      uploadDocument: async file => { calls.push(['upload', file.type]); return { id: 'server-upload' }; },
      send: message => { calls.push(['send', message.sel]); }, finishImageUpload() {}, status() {},
    });
    vm.runInContext(part(read('app/js/voice.js'), 'async function uploadImageFile(', '// Older Android'), context);
    assert.equal(await context.uploadImageFile('upload'), true);
    assert.deepEqual(calls, [...(converted ? [['convert', app]] : []), ['upload', converted ? 'image/png' : mime], ['send', 'thread-A']]);
  });
}

function answerDraftFixture() {
  const context = createPageContext({ currentApp: 'codex', currentComputer: () => ({ id: 'computer-one' }), lastChat: { thread: 'A' }, viewSel: 'codex|carrier|A',
    list: { querySelectorAll: () => [] }, status() {} });
  const source = read('app/js/history.js');
  vm.runInContext(part(source, 'const qnDrafts =', 'const questionCard =')
    + ';Object.assign(globalThis,{qnDrafts,questionScope,questionDraftKey,clearQuestionDraft,syncQuestionDrafts});', context);
  vm.runInContext(part(read('app/js/chat.js'), 'const openCodeQuestionSubmissions =', "list.addEventListener('submit'")
    + ';this.submissions=openCodeQuestionSubmissions;', context);
  return context;
}

test('answer drafts survive A/B navigation while isolating identical request IDs by computer and application', () => {
  const h = answerDraftFixture(), keyA = h.questionDraftKey('same-request', '0');
  h.syncQuestionDrafts(['same-request']); h.qnDrafts.set(keyA, 'answer A');
  h.lastChat = { thread: 'B' }; h.syncQuestionDrafts(['same-request']);
  const keyB = h.questionDraftKey('same-request', '0'); assert.notEqual(keyA, keyB); assert.equal(h.qnDrafts.has(keyB), false);
  h.qnDrafts.set(keyB, 'answer B'); h.lastChat = { thread: 'A' }; assert.equal(h.qnDrafts.get(h.questionDraftKey('same-request', '0')), 'answer A');
  h.currentApp = 'opencode'; assert.equal(h.qnDrafts.has(h.questionDraftKey('same-request', '0')), false);
  h.currentApp = 'codex'; h.currentComputer = () => ({ id: 'computer-two' }); assert.equal(h.qnDrafts.has(h.questionDraftKey('same-request', '0')), false);
});

test('answer success after switching clears only the submitted origin, while failure retains its draft', () => {
  const h = answerDraftFixture(); h.currentApp = 'opencode';
  const scopeA = h.questionScope(), keyA = h.questionDraftKey('request', '0'); h.qnDrafts.set(keyA, 'A');
  h.submissions.set('submit-A', { id: 'request', scope: scopeA, sel: 'opencode|carrier|A' });
  h.lastChat = { thread: 'B' }; h.viewSel = 'opencode|carrier|B'; const keyB = h.questionDraftKey('request', '0'); h.qnDrafts.set(keyB, 'B');
  h.finishOpenCodeQuestion({ requestId: 'submit-A', id: 'request', ok: false, error: 'native failure' });
  assert.equal(h.qnDrafts.get(keyA), 'A'); assert.equal(h.qnDrafts.get(keyB), 'B');
  h.submissions.set('submit-A2', { id: 'request', scope: scopeA, sel: 'opencode|carrier|A' });
  h.finishOpenCodeQuestion({ requestId: 'submit-A2', id: 'request', ok: true });
  assert.equal(h.qnDrafts.has(keyA), false); assert.equal(h.qnDrafts.get(keyB), 'B');
  h.syncQuestionDrafts(['request']); h.syncQuestionDrafts([]); assert.equal(h.qnDrafts.has(keyB), false);
});

test('Codex card preview keeps only the current turn tools across repeated turns', async () => {
  const items = [{ k: 'human', t: 'old user' }, { k: 'tool', i: 'old', t: 'old command', status: 'completed' },
    { k: 'human', t: 'current user' }, { k: 'assistant', t: 'current answer without tools' }];
  const saved = [], run = { id: 'current-turn', status: 'completed' };
  const scope = createPageContext({ CODEX_BACKEND: 'backend',
    overviewSession: () => ({ session: { app: 'codex' } }),
    codexAdapter: { backendOwner: async () => null, backendQuestionState: id => { assert.equal(id, 'qa'); return { waiting: 'approval' }; } },
    rememberSessionStatuses: rows => saved.push(...rows),
    codexBackend: { readChat: async () => ({ items, model: 'native', effort: 'high', busy: false, run }) } });
  vm.runInContext(read('server/overview.mjs').slice(read('server/overview.mjs').indexOf('export async function overviewPreview'))
    .replace('export async function', 'async function') + ';this.preview=overviewPreview;', scope);
  const target = { win: 'codex', windowId: 'backend', threadId: 'qa' };
  const first = await scope.preview('qa', target);
  assert.equal(first.tools.length, 0); assert.equal(first.text, 'current user\n\ncurrent answer without tools');
  assert.equal(first.last, 'current answer without tools'); assert.equal(first.model, 'native'); assert.equal(first.effort, 'high');
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), [{ app: 'codex', threadId: 'qa', busy: false, waiting: 'approval', run }]);
  items.push(...['completed', 'completed', 'failed', 'inProgress'].map((status, n) => ({ k: 'tool', i: 'new-' + n, t: 'command-' + n, status })));
  const next = await scope.preview('qa', target);
  assert.deepEqual([...next.tools].map(row => [row.id, row.state]), [['new-1', 'done'], ['new-2', 'error'], ['new-3', 'run']]);
  items.push({ k: 'human', t: 'next user' });
  const pending = await scope.preview('qa', target);
  assert.equal(pending.tools.length, 0); assert.equal(pending.text, 'next user');
  items.push({ k: 'tool', i: 'latest', t: 'latest command', status: 'completed' });
  assert.deepEqual([...(await scope.preview('qa', target)).tools].map(row => row.id), ['latest']);
});

test('legacy Codex card preview reads native backend content after its project window closes', async () => {
  const calls = [], saved = [], scope = createPageContext({ CODEX_BACKEND: 'backend',
    overviewSession: () => ({ session: { app: 'codex', host: '', dormant: true } }),
    codexAdapter: { backendThread: () => true, backendOwner: async () => null, backendQuestionState: id => { assert.equal(id, 'legacy'); return { waiting: '' }; } },
    rememberSessionStatuses: rows => saved.push(...rows),
    codexBackend: { readChat: async id => { calls.push(id); return { items: [{ k: 'human', t: 'old question' },
      { k: 'assistant', t: 'old answer' }], model: 'native', effort: 'high', busy: false, run: { id: 'old-turn', status: 'stopped' } }; } } });
  vm.runInContext(read('server/overview.mjs').slice(read('server/overview.mjs').indexOf('export async function overviewPreview'))
    .replace('export async function', 'async function') + ';this.preview=overviewPreview;', scope);
  const preview = await scope.preview('device', { win: 'codex', windowId: 'closed', threadId: 'legacy' });
  assert.deepEqual(calls, ['legacy']); assert.equal(preview.available, true);
  assert.equal(preview.threadId, 'legacy'); assert.equal(preview.last, 'old answer');
  assert.equal(saved[0].threadId, 'legacy'); assert.equal(saved[0].run.status, 'stopped');
});

test('Codex live preview reads the writer without changing its visible thread or claiming ownership', async () => {
  const calls = [], scope = createPageContext({ CODEX_BACKEND: 'backend', helpersCall: value => value,
    overviewSession: () => ({ session: { app: 'codex', host: '' } }),
    codexAdapter: { backendThread: () => true, backendOwner: async () => ({ chatWs: 'writer' }) },
    Cdp: class {
      constructor(ws) { assert.equal(ws, 'writer'); }
      async connect() {}
      async evaluate(expression) { calls.push(expression); return { available: true, last: 'live answer', tools: [] }; }
      close() { calls.push('close'); }
    } });
  vm.runInContext(read('server/overview.mjs').slice(read('server/overview.mjs').indexOf('export async function overviewPreview'))
    .replace('export async function', 'async function') + ';this.preview=overviewPreview;', scope);
  const value = await scope.preview('device', { win: 'codex', windowId: 'follower', threadId: 'desktop' });
  assert.equal(value.last, 'live answer'); assert.equal(value.windowId, 'follower');
  assert.deepEqual(calls, [`nativeSessionInfo('codex', "desktop", 'preview')`, 'close']);
});

test('a batch cancelled while its request waits in the relay queue never reaches a native removal', async () => {
  for (const app of ['codex', 'cursor', 'devin', 'opencode']) {
    const h = relayHeartbeat(), socket = await h.socket(), session = h.bind(socket), removed = [];
    Object.assign(session, sessionMethods, { app, emit: message => socket.send(JSON.stringify(message)),
      sessionEntries: new Map(['one', 'two'].map(id => [id, { id, app }])) });
    let release;
    const held = new Promise(resolve => { release = resolve; });
    h.routes.hold = { run: () => held };
    h.routes.sessionBatch = ROUTES.sessionBatch; h.routes.sessionBatchCancel = ROUTES.sessionBatchCancel;
    session.handle = msg => msg.t === 'hold' ? held : session.batchSessions(msg.ids, msg.requestId, row => { removed.push(row.id); });
    socket.receive({ t: 'hold' }); await h.settle();
    socket.receive({ t: 'sessionBatch', ids: ['one', 'two'], requestId: 'batch-' + app });
    assert.equal(session.sessionBatch.requestId, 'batch-' + app);
    socket.receive({ t: 'sessionBatchCancel', requestId: 'other-batch' }); await h.settle();
    assert.equal(session.sessionBatch.cancelled, false);
    socket.receive({ t: 'sessionBatchCancel', requestId: 'batch-' + app }); await h.settle();
    assert.equal(session.sessionBatch.cancelled, true);
    release(); await h.settle(); await h.settle();
    assert.deepEqual(removed, []);
    const done = socket.sent.findLast(message => message.t === 'sessionBatchProgress' && message.done);
    assert.equal(done.cancelled, true); assert.equal(done.results.length, 0);
    assert.equal(session.sessionBatch, null); socket.close(1000);
  }
});

function codexInputRecall() {
  const h = acceptedDraft(), source = read('app/js/composer.js');
  Object.assign(h.sent, { app: 'codex', thread: 'A', scope: 'computer|codex|window', before: new Set(), beforeQueues: new Set() });
  Object.assign(h.context, { chatInputCache: new Map(), sentInputCache: new Map(), inputRecall: null,
    chatBySel: new Map(), chatCacheKey: value => value, receiveQueueEdit() {},
  });
  h.input.dispatchEvent = () => {};
  vm.runInContext(part(source, 'function endInputRecall()', 'const pendingSends =')
    + part(source, 'function rememberSentInput(', 'function confirmSent(')
    + part(source, 'function receiveQueueDone(', 'function draftKey(')
    + part(source, 'function recallInput(', "$('inputPrev').onclick"), h.context);
  return h;
}

test('a late Codex receipt preserves A original without leaking through another thread, computer or app', () => {
  const h = codexInputRecall(); h.sent.text = 'original A';
  h.context.viewSel = 'codex|B';
  h.context.confirmSent({ requestId: 'request', sel: 'codex|A', messageId: 'shared-id' }, false);
  const makeChat = thread => ({ thread, items: [{ i: 'shared-id', k: 'human', t: 'native\\\n' }] });
  const cached = chat => {
    h.context.rememberInputHistory(chat);
    return [...h.context.chatInputCache.values()].at(-1).at(-1)[1];
  };
  assert.equal(cached(makeChat('B')), 'native\\\n');
  h.context.viewSel = 'codex|A';
  assert.equal(cached(makeChat('A')), 'original A');
  h.context.chatInputCache.clear(); h.context.currentComputer = () => ({ id: 'other-computer' });
  assert.equal(cached(makeChat('A')), 'native\\\n');
  h.context.currentComputer = () => ({ id: 'computer' }); h.context.currentApp = 'cursor';
  h.context.chatInputCache.clear(); assert.equal(cached(makeChat('A')), 'native\\\n');
});

test('Codex queued original follows an explicit queue edit and its execution message alias', () => {
  const h = codexInputRecall(); h.sent.text = 'queued original';
  h.context.confirmSent({ requestId: 'request', sel: h.context.viewSel, queueId: 'queue-before', queued: true }, false);
  const edited = 'edited /\nC:\\project\\';
  h.context.receiveQueueDone({ ok: true, sel: h.context.viewSel, action: 'edit', text: edited,
    queueId: 'queue-after', echoes: ['request'] });
  const chat = { thread: 'A', items: [{ i: 'executed-message', nativeIds: ['queue-after'], k: 'human', t: edited + '\\\n' }] };
  h.context.lastChat = chat; h.context.recallInput(-1);
  assert.equal(h.input.value, edited);
});

for (const IS_WIN of [false, true]) test('Cursor loaded connection metadata is shared: ' + IS_WIN, () => {
  const prefix = part(read('server/page/session-actions.js'), '  const nativeSessionInfo =', "    if (app === 'cursor' && catalog === 'mode')");
  const info = vm.runInContext(prefix + "return 'original'; }; nativeSessionInfo;", createPageContext({ IS_WIN,
    cursorSessionServices: () => ({ data: { getComposerDataIfLoaded: id => id === 'A' ? { lastUpdatedAt: 10, conversationCheckpointLastUpdatedAt: 20 } : null } }),
  }));
  assert.equal(info('cursor', 'A', 'connection')?.updatedAt || info('cursor', 'A', 'connection'), 20);
  assert.equal(info('cursor', 'missing', 'connection'), null);
});

test('Windows Cursor chooses the freshest loaded conversation across windows and not an unrelated thread', t => {
  const a = new NativeCdp('ws://qa-cursor-older'), b = new NativeCdp('ws://qa-cursor-newer');
  t.after(() => { a.nativeWindow.close(); b.nativeWindow.close(); });
  for (const [cdp, id, updatedAt] of [[a, 'old', 10], [b, 'new', 20]]) {
    cdp.nativeWindow.win = { app: 'cursor', id };
    cdp.nativeWindow.snapshot = { chat: { thread: 'A' }, states: [{ thread: 'A', nativeUpdatedAt: updatedAt }] };
  }
  assert.equal(cursorSource('A'), b.nativeWindow); assert.equal(cursorSource('B'), undefined);
  a.nativeWindow.snapshot.states[0].nativeUpdatedAt = 30;
  assert.equal(cursorSource('A'), a.nativeWindow);
});

for (const IS_WIN of [false, true]) test('Devin desktop workspace reading uses the correct platform configuration: ' + IS_WIN, async () => {
  const calls = [], source = part(read('server/apps/devin.mjs'), 'async devinWindowRoots(', 'async readWindowsDevinMode(');
  const methods = vm.runInContext('({' + source + '})', createPageContext({ IS_WIN,
    editorRoots: async (cdp, app) => { calls.push([cdp, app]); return [{ root: '/desktop-project', source: app }]; },
  }));
  const cdp = {}, roots = await methods.devinWindowRoots.call({ editorCdp: cdp });
  assert.equal(calls[0][1], IS_WIN ? 'code' : 'devin'); assert.equal(roots[0].root, '/desktop-project'); assert.equal(roots[0].source, 'devin');
});

test('Codex folded native questions are read without a selected group and stay scoped to thread and host', () => {
  const bind = (key, question, more = {}) => [JSON.stringify(key), { value: { get: () => ({ question, draft: '', lastSubmission: null, ...more }), subscribe: () => () => {} } }];
  const key = { entityKey: 'turn', hostId: 'local', itemId: 'q-A', threadId: 'A' };
  const scope = { familyBindings: new Map([['questions', new Map([
    bind(key, { id: 'q-A', title: 'Question A', options: ['one'] }),
    bind({ ...key, itemId: 'q-B', threadId: 'B' }, { id: 'q-B' }),
    bind({ ...key, itemId: 'remote', hostId: 'ssh' }, { id: 'remote' }),
    bind({ ...key, itemId: 'answered' }, { id: 'answered' }, { lastSubmission: '', draft: '' }),
  ])]]) };
  const source = part(read('server/page/codex.js'), '  const codexAsyncQuestionState =', '  const codexAsyncQuestionRows =');
  const context = createPageContext({ codexHistoryScopes: () => [scope], doc: { defaultView: { Map } },
    codexHistoryBinding: (_scope, binding) => binding && ({ key: binding.value, get: binding.value.get, subscribe: binding.value.subscribe }),
  });
  const reader = vm.runInContext(source + 'codexAsyncQuestionState;', context), state = reader('A', 'local');
  assert.deepEqual(Array.from(state.questions, item => item.question.id), ['q-A']);
  assert.equal(state.questions[0].key.threadId, 'A'); assert.equal(state.sources.size, 2);
});

test('native Codex question module loads the original group state without loading composer modules', async t => {
  const folder = fs.mkdtempSync('_shots/codex-question-module-');
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.writeFileSync(folder + '/entry.js', 'import { n } from "./questions.js";');
  fs.writeFileSync(folder + '/questions.js', 'const state={},groups={resolve(){}};const host=k=>k.hostId;const batch=(_s,fn)=>fn();function write(s,k,v){s.set(groups,host(k),m=>{if((m.get(k.threadId)??null)===v)return m;let next=new Map(m);return v==null?next.delete(k.threadId):next.set(k.threadId,v),next})}function choose(s,k){if(s.get(state,k)==null)return;let g=k;batch(s,()=>{write(s,g,{selectedQuestionKey:k,questionIds:[k.itemId]})})}export{groups as n};');
  const base = new URL('../' + folder + '/', import.meta.url), window = {}, document = { getElementById: () => null, scripts: [{ src: new URL('entry.js', base).href }] };
  const fetch = async url => ({ text: async () => fs.readFileSync(new URL(url), 'utf8') });
  const source = PAGE_SRC.replace('return { historyAtStart', 'return { codexNativeModule, historyAtStart');
  const page = new Function('document', 'window', 'fetch', 'return ' + source)(document, window, fetch);
  const native = await page.codexNativeModule('questions');
  assert.equal(typeof native.groups.resolve, 'function');
  assert.equal(window.__remoteAgentNativeModules.has('graph'), false);
});

for (const IS_WIN of [true, false]) test('Codex question operations use the correct native realm: Windows=' + IS_WIN, async () => {
  const calls = [], routes = vm.runInContext('({' + part(read('server/routes.mjs'), '  codexRequest: {', '  opencodeQuestion: {') + '})', createPageContext({ IS_WIN,
    nativeWindow: cdp => cdp.nativeWindow, helpersCall: method => method, questionDone() {}, questionFailed() {},
  }));
  const session = { app: 'codex', cdp: { nativeWindow: { composerCall: async method => { calls.push(['inner', method]); return true; } },
    evaluate: async method => { calls.push(['original', method]); return true; } }, pollChat: async () => {} };
  await routes.codexRequest.run(session, { id: 'async:A', field: 0, value: 'draft' });
  await routes.codexRequest.run(session, { id: 'async:A', n: 1, fields: [{ n: 0, value: 'answer' }] });
  assert.deepEqual(calls.map(call => call[0]), ['inner', 'inner']);
  assert(calls[0][1].includes('codexRequestField')); assert(calls[1][1].includes('codexRequestAction'));
});

test('opening a folded Codex question updates only its native host and thread group', async () => {
  const groups = {}, writes = [], key = { entityKey: 'turn-A', hostId: 'local', itemId: 'q-A', threadId: 'A' };
  let selected = false;
  const accessor = { set(atom, host, update) {
    assert.equal(atom, groups); assert.equal(host, 'local');
    const before = new Map([['B', { selectedQuestionKey: { itemId: 'q-B' } }]]), after = update(before);
    assert.equal(before.has('A'), false); assert.equal(after.get('B'), before.get('B'));
    writes.push(after.get('A')); selected = true;
  } };
  const source = part(read('server/page/codex.js'), '  const codexOpenQuestion =', '  const codexNativeRequests =');
  const context = createPageContext({ codexRequestThread: () => 'A', codexVisibleThread: () => 'B', openCodexThread: async thread => { assert.equal(thread, 'A'); return true; }, codexNativeManager: () => ({ hostId: 'local' }),
    codexAsyncQuestionState: () => ({ questions: [{ question: { id: 'q-A' }, key }] }),
    codexComposerScope: async thread => { assert.equal(thread, 'A'); return { scope: accessor }; },
    codexNativeModule: async kind => { assert.equal(kind, 'questions'); return { groups }; },
    codexRequests: () => selected ? [{ id: 'async:q-A', buttons: [{ action() {} }] }] : [],
    nativeValue: value => value, doc: { defaultView: { Map } },
  });
  await vm.runInContext(source + 'codexOpenQuestion;', context)('async:q-A');
  assert.deepEqual(JSON.parse(JSON.stringify(writes)), [{ selectedQuestionKey: key, questionIds: ['q-A'] }]);
});
