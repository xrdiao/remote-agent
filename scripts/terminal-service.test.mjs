import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import vm from 'node:vm';
import pty from 'node-pty';
import { IS_WIN, findBin, localFilePath } from '../lib/platform.mjs';
import headless from '@xterm/headless';
import { TerminalService, terminalService } from '../server/terminal-service.mjs';
import { ROUTES } from '../server/routes.mjs';
import { Session } from '../server/session.mjs';
import { adapter as codexAdapter } from '../server/apps/codex.mjs';
import { beginOperation, captureOperation, withOperation, subscribeOperations } from '../server/operations.mjs';

const directory = path.resolve('_shots/terminal-service-tests-' + process.pid);
await fs.mkdir(path.join(directory, 'A'), { recursive: true });
await fs.mkdir(path.join(directory, 'B'), { recursive: true });
after(() => fs.rm(directory, { recursive: true, force: true }));

class FakePty extends EventEmitter {
  pid = 42;
  writes = [];
  sizes = [];
  killed = false;
  onData(callback) { this.on('data', callback); }
  onExit(callback) { this.on('exit', callback); }
  write(data) { this.writes.push(data); }
  resize(cols, rows) { this.sizes.push([cols, rows]); }
  kill() { this.killed = true; this.emit('exit', { exitCode: 0, signal: 0 }); }
}
function fixture({ ready = true, spawned } = {}) {
  const children = [];
  const service = new TerminalService({ shell: IS_WIN ? findBin('bash') : '/bin/bash', env: { LANG: 'C.UTF-8' }, spawn: (shell, args, options) => {
    const child = new FakePty();
    children.push({ child, shell, args, options });
    spawned?.(child);
    if (ready) queueMicrotask(() => child.emit('data', '\x1b]777;RA;ready;\x07'));
    return child;
  } });
  return { service, children };
}
const writeScreen = (screen, data) => new Promise(resolve => screen.write(data, resolve));
const lines = screen => Array.from({ length: screen.buffer.active.length }, (_, row) => screen.buffer.active.getLine(row).translateToString(true));

test('creating a terminal waits for Readline rather than treating startup as foreground input', async t => {
  let created;
  const spawned = new Promise(resolve => { created = resolve; });
  const { service } = fixture({ ready: false, spawned: created }); t.after(() => service.dispose());
  let returned = false;
  const creating = service.create({ cwd: directory }).then(meta => { returned = true; return meta; });
  const child = await spawned;
  child.emit('data', '\x1b]777;RA;prompt;' + Buffer.from(directory).toString('base64') + '\x07');
  await service.get(service.list()[0].id).pending;
  assert.equal(returned, false); assert.deepEqual(child.writes, []);
  child.emit('data', '\x1b]777;RA;ready;\x07');
  const meta = await creating; assert.equal(returned, true);
  await service.submit(meta.id, 'printf first-command');
  assert.match(child.writes[0], /^\x1b\[97~/);
});

test('a Shell exiting before Readline rejects creation instead of leaving its request pending', async t => {
  let created;
  const spawned = new Promise(resolve => { created = resolve; });
  const { service } = fixture({ ready: false, spawned: created }); t.after(() => service.dispose());
  const creating = service.create({ cwd: directory });
  const child = await spawned; child.emit('exit', { exitCode: 1, signal: 0 });
  await assert.rejects(creating, /Shell 在输入就绪前退出：1/);
});

test('RA terminals preserve explicit project directories and sizes independently of subscribers', async t => {
  const { service, children } = fixture(); t.after(() => service.dispose());
  const a = await service.create({ cwd: path.join(directory, 'A') });
  const b = await service.create({ cwd: path.join(directory, 'B'), cols: 91, rows: 40 });
  assert.notEqual(a.id, b.id);
  assert.equal(children[0].options.cwd, a.cwd);
  assert.equal(children[0].options.cols, 120); assert.equal(children[0].options.rows, 50);
  if (IS_WIN) assert.equal(children[0].options.useConpty, true);
  assert.equal(children[1].options.cwd, b.cwd);
  assert.deepEqual(children[0].args, ['--rcfile', localFilePath(path.resolve('server/terminal-shell.bash')), '-i']);
  const stop = await service.subscribe(a.id, () => {}); stop();
  assert.equal(children[0].child.killed, false);
  assert.equal(service.list().length, 2);
  await service.write(a.id, 'unfinished command');
  assert.deepEqual(children[0].child.writes, ['unfinished command']);
  assert.deepEqual(children[1].child.writes, []);
});

test('invalid or remote directories do not launch a different local shell', async () => {
  const { service, children } = fixture();
  await assert.rejects(service.create({ cwd: directory, host: 'ssh-host' }), /远程/);
  await assert.rejects(service.create({ cwd: 'relative-project' }), /绝对目录/);
  await assert.rejects(service.create({ cwd: directory + '/missing' }), /ENOENT/);
  await assert.rejects(service.create({ cwd: directory, cols: 0 }), /整数/);
  assert.equal(children.length, 0);
});

test('a snapshot and following stream form one continuous terminal state', async t => {
  const { service, children } = fixture(); t.after(() => service.dispose());
  const terminal = await service.create({ cwd: directory, cols: 20, rows: 5 });
  children[0].child.emit('data', '\x1b[31mfirst\x1b[0m\r\n中文\r\n');
  const events = [];
  const subscribing = service.subscribe(terminal.id, event => events.push(event));
  children[0].child.emit('data', 'after snapshot\r\n');
  const stop = await subscribing; t.after(stop);
  await service.resize(terminal.id, 24, 6);
  children[0].child.emit('data', 'last\r\n');
  await service.get(terminal.id).pending;
  const snapshot = events[0];
  assert.equal(snapshot.t, 'termSnapshot'); assert.equal(snapshot.seq, 1);
  assert.equal(events[1].seq, 2); assert.equal(events[1].t, 'termData');
  const restored = new headless.Terminal({ cols: snapshot.cols, rows: snapshot.rows, allowProposedApi: true });
  t.after(() => restored.dispose());
  await writeScreen(restored, snapshot.data);
  for (const event of events.slice(1)) {
    if (event.t === 'termData') await writeScreen(restored, event.data);
    else if (event.t === 'termSize') restored.resize(event.cols, event.rows);
  }
  const source = service.get(terminal.id).screen;
  assert.deepEqual(lines(restored), lines(source));
  assert.equal(restored.buffer.active.cursorX, source.buffer.active.cursorX);
  assert.equal(restored.buffer.active.cursorY, source.buffer.active.cursorY);
});

test('alternate-screen contents and cursor survive a fresh subscription', async t => {
  const { service, children } = fixture(); t.after(() => service.dispose());
  const terminal = await service.create({ cwd: directory, cols: 30, rows: 50 });
  children[0].child.emit('data', '\x1b[?1049h\x1b[2J\x1b[1;1HHEADER\x1b[49;1HBOTTOM\x1b[50;2H');
  let snapshot;
  const stop = await service.subscribe(terminal.id, event => { snapshot = event; }); t.after(stop);
  const restored = new headless.Terminal({ cols: 30, rows: 50, allowProposedApi: true }); t.after(() => restored.dispose());
  await writeScreen(restored, snapshot.data);
  assert.equal(restored.buffer.active.type, 'alternate');
  assert(lines(restored)[48].includes('BOTTOM'));
  assert.equal(restored.buffer.active.cursorY, 49);
  assert.equal(restored.buffer.active.cursorX, 1);
});

test('private Shell messages can span output chunks and terminal queries have one server owner', async t => {
  const { service, children } = fixture(); t.after(() => service.dispose());
  const terminal = await service.create({ cwd: directory });
  const events = [];
  await service.subscribe(terminal.id, event => events.push(event));
  const prompt = '\x1b]777;RA;prompt;' + Buffer.from(directory).toString('base64') + '\x07';
  children[0].child.emit('data', 'visible\x1b]77');
  children[0].child.emit('data', prompt.slice(4) + '\x1b[6n');
  await service.get(terminal.id).pending;
  assert.equal(service.get(terminal.id).prompt, true);
  assert.equal(events.filter(e => e.t === 'termData').map(e => e.data).join(''), 'visible\x1b[6n');
  assert.equal(children[0].child.writes.length, 1);
  assert.match(children[0].child.writes[0], /^\x1b\[\d+;\d+R$/);
  assert(!JSON.stringify(events).includes('777;RA;'));
});

test('thirty subscription switches never cross terminal identities or create shells', async t => {
  const { service, children } = fixture(); t.after(() => service.dispose());
  const a = await service.create({ cwd: path.join(directory, 'A') });
  const b = await service.create({ cwd: path.join(directory, 'B') });
  let stop = () => {};
  for (let n = 0; n < 30; n++) {
    stop(); const index = n % 2, id = index ? b.id : a.id, events = [];
    stop = await service.subscribe(id, event => events.push(event));
    children[index].child.emit('data', `selected-${n}\r\n`);
    children[1 - index].child.emit('data', `other-${n}\r\n`);
    await Promise.all([...service.terminals.values()].map(terminal => terminal.pending));
    assert(events.every(event => event.id === id));
    assert(events.some(event => event.data?.includes(`selected-${n}`)));
    assert(!events.some(event => event.t === 'termData' && event.data.includes(`other-${n}`)));
  }
  stop(); assert.equal(children.length, 2);
});

test('close releases its own PTY and exit retains the final screen until close', async t => {
  const { service, children } = fixture(); t.after(() => service.dispose());
  const a = await service.create({ cwd: directory }), b = await service.create({ cwd: directory });
  const events = [];
  await service.subscribe(a.id, event => events.push(event));
  children[0].child.emit('data', 'final output\r\n');
  children[0].child.emit('exit', { exitCode: 7, signal: 0 });
  await service.get(a.id).pending;
  assert.equal(events.at(-1).t, 'termExit');
  assert.equal(service.list()[0].exited, true);
  await assert.rejects(service.write(a.id, 'ignored'), /退出/);
  await service.close(a.id);
  assert.equal(events.at(-1).t, 'termClosed');
  assert.equal(service.list().length, 1);
  assert.equal(children[1].child.killed, false);
  service.dispose(); assert.equal(children[1].child.killed, true);
  assert.throws(() => service.get(b.id), /已经不在/);
});

test('conversation creation freezes its actual project source before a session switch', async t => {
  const original = terminalService.create;
  t.after(() => { terminalService.create = original; });
  const projects = [], replies = [];
  terminalService.create = async project => { projects.push(project); return { id: 'created' }; };
  let release;
  const context = { app: 'codex', bindingReady: true, cdp: { root: '/project/A' },
    selectionKey: () => 'codex|window|A', emit: message => replies.push(message),
    adapter: { async terminalProject() { await new Promise(resolve => { release = resolve; }); return { root: this.cdp.root, host: '' }; } } };
  const creating = ROUTES.newTerminal.fastRun(context, { source: 'conversation', sel: 'codex|window|A', requestId: 'create' });
  context.cdp = { root: '/project/B' }; context.app = 'cursor'; release(); await creating;
  assert.deepEqual(projects, [{ cwd: '/project/A', host: '' }]);
  assert.equal(replies[0].t, 'termCreated');
  await assert.rejects(ROUTES.newTerminal.fastRun(context, { source: 'conversation', sel: 'stale' }), /会话已切换/);
});

test('terminal subscriptions detach independently of native binding and shell lifetime', async t => {
  const meta = await terminalService.create({ cwd: directory }); t.after(() => terminalService.close(meta.id));
  const events = [];
  const session = { visible: true, mode: 'terminal', emit: event => events.push(event), stopTerminalUpdates: Session.prototype.stopTerminalUpdates };
  await Session.prototype.selectTerminal.call(session, meta.id, 'first');
  assert.equal(events[0].subscription, 'first');
  session.stopTerminalUpdates();
  assert.equal(terminalService.get(meta.id).listeners.size, 0);
  assert.equal(terminalService.get(meta.id).exited, false);
  await Session.prototype.selectTerminal.call(session, meta.id, 'second');
  assert.equal(events.at(-1).t, 'termSnapshot'); assert.equal(events.at(-1).subscription, 'second');
  session.stopTerminalUpdates();
});

test('Windows reconnection restores connection mode and presence before opening a surviving terminal', async t => {
  const source = (await fs.readFile(new URL('../server/routes.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const start = source.indexOf('  mode: {'), end = source.indexOf('  lang:', start);
  const sameWindow = (session, message) => !message.sel || message.sel.split('|', 2).join('|') === session.selectionKey().split('|', 2).join('|');
  for (const windows of [false, true]) {
    const routes = vm.runInNewContext('({' + source.slice(start, end) + '})', { IS_WIN: windows });
    const meta = await terminalService.create({ cwd: directory });t.after(() => terminalService.close(meta.id));
    const events = [], session = { mode: 'chat', visible: false, selectionKey: () => 'cursor|fresh|', emit: message => events.push(message),
      stopTerminalUpdates: Session.prototype.stopTerminalUpdates, selectTerminal: Session.prototype.selectTerminal,
      setMode: async function(mode) { this.mode = mode; } };
    const requests = [{ t: 'mode', mode: 'terminal', sel: 'codex|old|A' }, { t: 'visible', v: true, sel: 'codex|old|A' }];
    for (const message of requests) {
      const route = routes[message.t];
      if (route.switchRead && !sameWindow(session, message)) continue;
      if (message.t === 'mode') await route.fastRun(session, message);else route.pre(session, message);
    }
    await session.selectTerminal(meta.id, 'restored');
    assert.equal(events.some(message => message.t === 'termSnapshot' && message.subscription === 'restored'), windows);
    assert.equal(routes.mode.switchRead, !windows);assert.equal(routes.visible.switchRead, !windows);
    session.stopTerminalUpdates();
  }
});

test('terminal creation and close reuse computer-owned operation receipts, never raw input', () => {
  const session = { deviceId: crypto.randomUUID(), app: 'codex', mode: 'terminal', selectionKey: () => 'native|selection' };
  const packets = [], client = { readyState: 1, send: packet => packets.push(JSON.parse(packet)) };
  const stop = subscribeOperations(session.deviceId, client);
  const message = { t: 'newTerminal', operationId: crypto.randomUUID(), requestId: 'create' };
  const first = beginOperation(session, message);
  withOperation(first.operation, () => captureOperation(session, { t: 'termCreated', terminal: { id: 'ra-terminal' } }));
  first.operation.finish();
  const again = beginOperation({ ...session, app: 'cursor' }, message);
  assert.equal(again.duplicate, true);
  assert.equal(packets.at(-1).app, ''); assert.equal(packets.at(-1).sel, '');
  assert.equal(packets.at(-1).events[0].message.terminal.id, 'ra-terminal');
  assert.equal(beginOperation(session, { t: 'termWrite', operationId: 'secret', data: 'fake-secret' }), null);
  assert(!JSON.stringify(packets).includes('fake-secret')); stop();
});

test('PTY input does not enter native focus and stale subscriptions reject before writing', async t => {
  const original = terminalService.write; const writes = [], events = [];
  t.after(() => { terminalService.write = original; });
  terminalService.write = async (...args) => writes.push(args);
  const session = { mode: 'terminal', terminalId: 'ra', terminalSubscription: 'current', emit: packet => events.push(packet) };
  await assert.rejects(ROUTES.termWrite.fastRun(session, { id: 'other', subscription: 'old', data: 'never' }), /已切换/);
  assert.deepEqual(writes, []);
  await ROUTES.termWrite.fastRun(session, { id: 'ra', subscription: 'current', data: 'fake-secret\r', requestId: 'secret' });
  assert.deepEqual(writes, [['ra', 'fake-secret\r']]);
  assert.deepEqual(events, [{ t: 'termWritten', id: 'ra', subscription: 'current', requestId: 'secret' }]);
  await ROUTES.termWrite.fastRun(session, { id: 'ra', subscription: 'current', data: '\x80', binary: true });
  assert.deepEqual(writes[1], ['ra', Buffer.from([0x80])]);
  assert.throws(() => ROUTES.key.run(session, { focus: 'terminal', key: 'Enter' }), /更新手机页面/);
});

test('Codex terminal creation uses the bound conversation project when the desktop displays another thread', async () => {
  const reads = [];
  const nativeHelpers = { nativeSessionInfo: (app, id, kind) => { reads.push([app, id, kind]); return { cwd: '/project/A', host: '' }; } };
  const { PAGE_SRC } = await import('../server/page/build.mjs');
  const context = { threadId: 'conversation-A', cdp: { evaluate: expression => vm.runInNewContext(
    expression.replace(PAGE_SRC, 'nativeHelpers'), { nativeHelpers }) } };
  assert.equal((await codexAdapter.terminalProject.call(context)).root, '/project/A');
  assert.deepEqual(reads, [['codex', 'conversation-A', 'context']]);
});

const frontendSource = await fs.readFile(new URL('../app/js/terminal.js', import.meta.url), 'utf8');
function frontendTerminal() {
  const effects = [];
  const context = vm.createContext({
    mode: 'terminal', terminalComputer: 'computer-A', currentComputer: () => ({ id: 'computer-A' }),
    currentTerminalId: 'terminal-A', terminalSubscription: 'subscription-A', terminalSequence: 5,
    terminalReady: true, terminalExited: false, terminalPasswordRequest: null,
    terminalCompletion: null, terminalHistoryRequest: null,
    terminalCreateRequest: { requestId: 'create-A', computer: 'computer-A' },
    terminalListRequest: { requestId: 'list-A', computer: 'computer-A' },
    raTerminal: { write: data => effects.push(['write', data]), resize: (cols, rows) => effects.push(['resize', cols, rows]) },
    renderTerminalSnapshot: message => effects.push(['snapshot', message.id]),
    terminalMessage: text => effects.push(['message', text]), updateTerminalControls() {},
    closeTerminalPassword() {}, terminalCursorVisible() {}, disposeTerminalView() {}, updateTermEmpty() {}, updateTitle() {}, saveDraft() {}, restoreDraft() {},
    showTerminals: list => effects.push(['list', list]), openRaTerminal: id => effects.push(['open', id]),
    requestTerminals() {}, store: { get: () => 'terminal-A', set() {} }, sheetKind: null,
    crypto: crypto.webcrypto, authed: true, terminalOrigin: { computer: 'computer-A', source: 'computer' },
    currentTerminal: '', terminalCwd: '', closeSheet() {}, send: message => { effects.push(['send', message]); return true; },
  });
  const start = frontendSource.indexOf('function receiveTerminal(m)'), end = frontendSource.indexOf("$('pickTerms').onclick", start);
  vm.runInContext(frontendSource.slice(start, end), context);
  return { context, effects, receive: message => context.receiveTerminal(message) };
}

test('late output and errors from another subscription cannot change the selected terminal', () => {
  const h = frontendTerminal();
  h.receive({ t: 'termData', id: 'terminal-B', subscription: 'subscription-A', seq: 6, data: 'other terminal' });
  h.receive({ t: 'termData', id: 'terminal-A', subscription: 'old', seq: 6, data: 'old subscription' });
  h.receive({ t: 'termError', id: 'terminal-A', subscription: 'old', message: 'old failure' });
  h.context.terminalComputer = 'computer-B';
  h.receive({ t: 'termData', id: 'terminal-A', subscription: 'subscription-A', seq: 6, data: 'other computer' });
  assert.deepEqual(h.effects, []);
  h.context.terminalComputer = 'computer-A';
  const current = { t: 'termData', id: 'terminal-A', subscription: 'subscription-A', seq: 6, data: 'current' };
  h.receive(current); h.receive(current);
  assert.deepEqual(h.effects, [['write', 'current']]); assert.equal(h.context.terminalSequence, 6);
});

test('late terminal lists and creation receipts do not reopen a sheet over chat', () => {
  const h = frontendTerminal(); h.context.mode = 'chat';
  h.receive({ t: 'terminals', requestId: 'list-A', list: [{ id: 'terminal-A' }] });
  h.receive({ t: 'termCreated', requestId: 'create-A', terminal: { id: 'new-terminal' } });
  h.receive({ t: 'termError', action: 'newTerminal', requestId: 'old-create', message: 'old' });
  assert.deepEqual(h.effects, []);
});

test('explicit creation and selection supersede an older automatic list and creation receipt', () => {
  const h = frontendTerminal();
  const openStart = frontendSource.indexOf('function openRaTerminal(id)'), openEnd = frontendSource.indexOf('function requestTerminals(', openStart);
  const createStart = frontendSource.indexOf('function createRaTerminal('), createEnd = frontendSource.indexOf('function removeRaTerminal(', createStart);
  vm.runInContext(frontendSource.slice(openStart, openEnd) + frontendSource.slice(createStart, createEnd), h.context);
  h.context.createRaTerminal();
  const request = h.effects.find(effect => effect[0] === 'send')[1];
  h.effects.length = 0;
  h.receive({ t: 'terminals', requestId: 'list-A', list: [{ id: 'terminal-A' }] });
  assert.deepEqual(h.effects, []);
  h.context.openRaTerminal('terminal-B');
  h.effects.length = 0;
  h.receive({ t: 'termCreated', requestId: request.requestId, terminal: { id: 'terminal-C' } });
  assert.deepEqual(h.effects, []);
  assert.equal(h.context.currentTerminalId, 'terminal-B');
});

test('new conversation terminals use the selection at creation instead of an earlier origin snapshot', () => {
  const h = frontendTerminal();
  h.context.terminalOrigin = { computer: 'computer-A', source: 'conversation', sel: 'codex|window|old-thread' };
  h.context.viewSel = 'codex|window|current-thread';
  const start = frontendSource.indexOf('function createRaTerminal('), end = frontendSource.indexOf('function removeRaTerminal(', start);
  vm.runInContext(frontendSource.slice(start, end), h.context);
  h.context.createRaTerminal();
  const packet = h.effects.find(effect => effect[0] === 'send')[1];
  assert.equal(packet.source, 'conversation'); assert.equal(packet.sel, h.context.viewSel);
});

async function frontendTerminalTools() {
  const h = frontendTerminal(), nodes = new Map(), actions = ['password', 'copy', 'selectAll', 'size', 'refresh'];
  let selected = 'selected output';
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', hidden: false, disabled: false, listeners: {},
      contains: value => value?.owner === id,
      classList: { toggle() {} }, addEventListener(type, fn) { this.listeners[type] = fn; },
      focus() { h.effects.push(['focus', id]); } });
    return nodes.get(id);
  };
  const buttons = actions.map(action => Object.assign(node(action), { dataset: { terminalAction: action },
    closest: () => node(action), click() { if (!this.disabled) return node('termTools').listeners.click({ target: this }); } }));
  Object.assign(h.context, { $: node, document: { querySelectorAll: selector => selector === '[data-terminal-action]' ? buttons : [] },
    window: { getSelection: () => null },
    terminalPrompt: true, terminalFollow: true,
    openSheet(kind, html) { h.menu = { kind, html }; }, I18N: { tr: String },
    copyText: (value, button) => h.effects.push(['copy', value, button.id]),
    showTerminalSize: () => h.effects.push(['size']),
    showTerminalMore() {}, requestTerminals: select => h.effects.push(['list', select]),
    raTerminal: { selectAll() { selected = 'all output\n'; h.effects.push(['selectAll']); },
      getSelection: () => selected, clearSelection() { selected = ''; h.effects.push(['clearSelection']); } },
  });
  const source = (start, end) => frontendSource.slice(frontendSource.indexOf(start), frontendSource.indexOf(end, frontendSource.indexOf(start)));
  const sheets = await fs.readFile(new URL('../app/js/sheets.js', import.meta.url), 'utf8');
  const notify = await fs.readFile(new URL('../app/js/notify.js', import.meta.url), 'utf8');
  const delegateStart = notify.indexOf('  if (b.dataset.terminalAction)'), delegateEnd = notify.indexOf("  else if (act === 'localVoiceToggle')", delegateStart);
  assert(delegateStart >= 0 && delegateEnd > delegateStart);
  vm.runInContext(source('function terminalAvailable()', 'function terminalTheme()')
    + source('function terminalSelection()', 'function terminalCursorVisible()')
    + source('function terminalWrite(', 'function openRaTerminal(')
    + source("$('pickTerms').onclick", "view.addEventListener('touchstart'")
    + source('function closeTerminalPassword()', "document.addEventListener('composer-state'")
    + sheets.slice(sheets.indexOf('function showTerminalMore()'), sheets.indexOf('function showTerminalSize()'))
    + 'function clickTerminalSheet(b) {' + notify.slice(delegateStart, delegateEnd) + '}', h.context);
  return { ...h, get menu() { return h.menu; }, nodes, buttons, node,
    click: action => node(action).click(), clickMore: action => h.context.clickTerminalSheet(node(action)),
  };
}

test('terminal toolbar and more reuse one action path without duplicate writes', async () => {
  const h = await frontendTerminalTools(); h.context.updateTerminalControls();
  h.click('password');
  assert.deepEqual(JSON.parse(JSON.stringify(h.context.terminalPasswordTarget)), { computer: 'computer-A', id: 'terminal-A', subscription: 'subscription-A' });
  assert.equal(h.node('termPasswordBox').hidden, false);
  await h.click('copy'); assert.deepEqual(h.effects.filter(e => e[0] === 'copy'), [['copy', 'selected output', 'copy']]);
  h.click('selectAll'); await h.click('copy');
  assert.deepEqual(h.effects.filter(e => e[0] === 'copy').at(-1), ['copy', 'all output\n', 'copy']);
  h.click('size'); h.clickMore('size'); assert.equal(h.effects.filter(e => e[0] === 'size').length, 2);
  h.click('refresh'); h.clickMore('refresh'); assert.equal(h.effects.filter(e => e[0] === 'open').length, 2);
  assert.equal(h.effects.filter(e => e[0] === 'send').length, 0);
});

test('terminal tools preserve offline copy and authenticated refresh while disabling unavailable writes', async () => {
  const h = await frontendTerminalTools(); h.context.terminalReady = false; h.context.updateTerminalControls();
  assert.equal(h.node('password').disabled, true); assert.equal(h.node('size').disabled, true); assert.equal(h.node('termInt').disabled, true);
  assert.equal(h.node('copy').disabled, false); assert.equal(h.node('selectAll').disabled, false); assert.equal(h.node('refresh').disabled, false);
  h.click('password'); h.click('size'); assert(!h.effects.some(e => e[0] === 'focus' || e[0] === 'size'));
  h.context.authed = false; h.context.updateTerminalControls(); assert.equal(h.node('refresh').disabled, true);
  h.context.raTerminal = null; h.context.updateTerminalControls(); assert.equal(h.node('copy').disabled, true); assert.equal(h.node('selectAll').disabled, true);
  h.context.authed = h.context.terminalReady = true; h.context.updateTerminalControls();
  h.node('termInt').onclick(); assert.equal(h.effects.filter(e => e[0] === 'send').length, 1);
  assert.equal(h.effects.find(e => e[0] === 'send')[1].data, '\x03');
});

test('terminal password toolbar retains subscription ownership and sends no ordinary command draft', async () => {
  const h = await frontendTerminalTools(); h.context.updateTerminalControls(); h.click('password');
  h.node('termPassword').value = 'fictional-secret'; h.context.terminalSubscription = 'subscription-B';
  h.node('termPasswordBox').onsubmit({ preventDefault() {} }); assert.equal(h.effects.filter(e => e[0] === 'send').length, 0);
  h.context.terminalSubscription = 'subscription-A'; h.node('termPasswordBox').onsubmit({ preventDefault() {} });
  const sent = h.effects.filter(e => e[0] === 'send'); assert.equal(sent.length, 1); assert.equal(sent[0][1].t, 'termWrite');
  assert.equal(sent[0][1].data, 'fictional-secret\r'); assert.equal(sent[0][1].subscription, 'subscription-A');
  assert.equal(h.node('termPassword').value, ''); assert.equal(h.node('termPasswordSend').disabled, true);
});

test('terminal more contains only size and refresh and refresh keeps the current terminal identity', async () => {
  const h = await frontendTerminalTools(); h.context.showTerminalMore();
  assert.equal(h.menu.kind, 'terminal-more');
  assert.deepEqual([...h.menu.html.matchAll(/data-terminal-action="([^"]+)"/g)].map(m => m[1]), ['size', 'refresh']);
  h.clickMore('refresh'); assert.deepEqual(h.effects.at(-1), ['open', 'terminal-A']);
  h.context.currentTerminalId = ''; h.clickMore('refresh'); assert.deepEqual(h.effects.at(-1), ['list', true]);
});

test('visual frame layout still fits its viewport and scales without terminal cropping', async () => {
  const source = await fs.readFile(new URL('../app/js/screen.js', import.meta.url), 'utf8');
  const start = source.indexOf('function layoutStage()'), end = source.indexOf('// One finger', start);
  const context = vm.createContext({ mode: 'screen', frame: { w: 800, h: 400 }, zoom: 1,
    view: { clientWidth: 320, clientHeight: 200 }, stage: { style: {} }, screen: { style: {} } });
  vm.runInContext(source.slice(start, end), context); context.layoutStage();
  assert.equal(context.stage.style.width, '320px'); assert.equal(context.stage.style.height, '160px');
  context.zoom = 2; context.layoutStage();
  assert.equal(context.stage.style.width, '640px'); assert.equal(context.stage.style.height, '320px');
  assert.equal(context.screen.style.left, '0px'); assert.equal(context.screen.style.top, '0px');
});

test('real Ubuntu PTY uses requested cwd and size and supports no-echo input', { skip: IS_WIN, timeout: 15000 }, async t => {
  const service = new TerminalService({ shell: '/bin/bash', spawn: (shell, args, options) => pty.spawn(shell, ['--noprofile', ...args],
    { ...options, env: { ...options.env, PS1: 'RA> ', PROMPT_COMMAND: '' } }) });
  t.after(() => service.dispose());
  const meta = await service.create({ cwd: path.join(directory, 'A') });
  let output = '';
  const changed = new EventEmitter();
  const stop = await service.subscribe(meta.id, event => { if (event.t === 'termData') { output += event.data; changed.emit('data'); } });
  t.after(stop);
  const waitFor = (text, atEnd = false) => new Promise((resolve, reject) => {
    const check = () => { if (atEnd ? output.endsWith(text) : output.includes(text)) { clearTimeout(timer); changed.off('data', check); resolve(); } };
    const timer = setTimeout(() => { changed.off('data', check); reject(new Error('PTY output did not include ' + text)); }, 5000);
    changed.on('data', check); check();
  });
  await service.write(meta.id, 'printf "__RA_CWD__%s|%s\\n" "$PWD" "$(stty size)"\r');
  await waitFor('__RA_CWD__' + meta.cwd + '|50 120');
  await service.resize(meta.id, 100, 60);
  await service.write(meta.id, 'printf "__RA_SIZE__%s\\n" "$(stty size)"\r');
  await waitFor('__RA_SIZE__60 100');
  await service.write(meta.id, 'read -r -s -p "__RA_PASSWORD__" RA_SECRET; printf "\\n__RA_LENGTH__%s\\n" "${#RA_SECRET}"\r');
  await waitFor('__RA_PASSWORD__', true);
  const before = output.length;
  await service.write(meta.id, 'fictional-password\r');
  await waitFor('__RA_LENGTH__18');
  assert(!output.slice(before).includes('fictional-password'));
  stop();
  assert.equal(service.get(meta.id).process.pid, meta.pid);
  const restored = [];
  const again = await service.subscribe(meta.id, event => restored.push(event)); t.after(again);
  assert.equal(restored[0].pid, meta.pid);
  assert(restored[0].data.includes('__RA_LENGTH__18'));
});

test('textbox completion, multiline submit, history and foreground input use the same Bash PTY', { skip: IS_WIN, timeout: 15000 }, async t => {
  await fs.writeFile(path.join(directory, '补全 fixture.txt'), '');
  await fs.writeFile(path.join(directory, 'completion-one'), '');
  await fs.writeFile(path.join(directory, 'completion-two'), '');
  const service = new TerminalService({ shell: '/bin/bash', env: { ...process.env, HISTFILE: '/dev/null' } });
  t.after(() => service.dispose());
  const meta = await service.create({ cwd: directory }), terminal = service.get(meta.id);
  let output = '', check;
  const stop = await service.subscribe(meta.id, event => {
    if (event.t === 'termData') output += event.data;
    check?.();
  });
  t.after(stop);
  const until = predicate => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { check = null; reject(new Error('Shell state did not arrive')); }, 5000);
    check = () => { if (predicate()) { clearTimeout(timer); check = null; resolve(); } };
    check();
  });
  assert.equal(terminal.prompt, true);
  await service.submit(meta.id, 'printf "__IMMEDIATE__\\n"');
  await until(() => terminal.prompt && output.includes('__IMMEDIATE__\r\n'));
  await terminal.pending;
  assert.equal(lines(terminal.screen).filter(line => line.includes('printf ')).length, 1);
  const result = await service.complete(meta.id, 'cat 补', 5);
  assert.match(result.text, /补全\\ fixture\.txt/);
  const first = await service.complete(meta.id, 'cat completion-', 15);
  const repeated = await service.complete(meta.id, first.text, first.caret);
  await terminal.pending;
  assert.equal(repeated.text, first.text);
  assert(output.includes('completion-one') && output.includes('completion-two'));
  const caret = await service.complete(meta.id, 'echo 中文 tail', 6);
  assert.equal(caret.caret, 6);
  await service.submit(meta.id, 'printf "__BOX_ONE__\\n"\nprintf "__BOX_TWO__\\n"');
  await until(() => terminal.prompt && output.includes('__BOX_TWO__\r\n'));
  const history = await service.history(meta.id);
  assert(history.some(command => command.includes('printf "__BOX_TWO__\\n"')), JSON.stringify(history));
  await service.submit(meta.id, 'read -rs -p __SECRET__ RA_SECRET; printf "\\n__LENGTH__%s\\n" "${#RA_SECRET}"');
  await until(() => output.endsWith('__SECRET__'));
  await assert.rejects(service.complete(meta.id, 'never', 5), /正在运行/);
  const before = output.length;
  await service.write(meta.id, 'fictional-secret\r');
  await until(() => terminal.prompt && output.includes('__LENGTH__16\r\n'));
  assert(!output.slice(before).includes('fictional-secret'));
  assert(!output.includes('777;RA;'));
  assert.equal(service.get(meta.id).process.pid, meta.pid);
});

test('native terminal selection copies selected text and leaves a selection outside the terminal intact', async () => {
  const h = await frontendTerminalTools();
  let selection = { anchorNode: { owner: 'termText' }, focusNode: { owner: 'termText' },
    toString: () => '中文\nselected output', removeAllRanges() { h.effects.push(['clearNative']); } };
  h.context.window.getSelection = () => selection;
  assert.equal(h.context.terminalSelection(), '中文\nselected output');
  await h.context.copyTerminal(h.node('copy'));
  assert.deepEqual(h.effects.filter(e => e[0] === 'copy'), [['copy', '中文\nselected output', 'copy']]);
  assert(h.effects.some(e => e[0] === 'clearNative'));
  h.effects.length = 0;
  selection = { anchorNode: { owner: 'chat' }, focusNode: { owner: 'chat' },
    toString: () => 'chat selection', removeAllRanges() { throw Error('outside selection must remain'); } };
  h.context.raTerminal.getSelection = () => 'legacy terminal selection';
  assert.equal(h.context.terminalSelection(), 'legacy terminal selection');
  h.context.clearTermSelection();
  assert.deepEqual(h.effects, [['clearSelection']]);
});
