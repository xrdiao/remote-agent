/* ---------- RA interactive terminals ---------- */
let raTerminal = null;
let terminalOrigin = null, terminalListRequest = null, terminalCreateRequest = null;
let terminalSubscription = '', terminalSequence = 0, terminalReady = false;
let terminalComputer = '', terminalExited = false, terminalCwd = '', terminalFollow = true;
let terminalPasswordTarget = null, terminalPasswordRequest = null;

function terminalMessage(message = '', error = false) {
  $('termStatus').textContent = I18N.tr(message);
  $('termStatus').hidden = !message || mode !== 'terminal';
  $('termStatus').classList.toggle('err', error);
}
function terminalAvailable() {
  return mode === 'terminal' && authed && terminalReady && !terminalExited
    && terminalComputer === currentComputer()?.id;
}
function updateTerminalControls() {
  const available = terminalAvailable();
  if (mode === 'terminal') $('dot').className = authed && terminalReady ? 'ok' : '';
  if (raTerminal) raTerminal.options.disableStdin = !available;
  for (const id of ['termKeyboard', 'termInt', 'termSize', 'termPasswordToggle']) $(id).disabled = !available;
  for (const button of document.querySelectorAll('[data-termkey]')) button.disabled = !available;
  $('termCopy').disabled = $('termSelectAll').disabled = !raTerminal;
  $('newTerm').disabled = $('termEmptyNew').disabled = $('termFolder').disabled = !authed;
  if (!available) closeTerminalPassword();
}
function terminalDisconnected() {
  terminalReady = false;
  updateTerminalControls();
  if (mode === 'terminal') terminalMessage('终端连接已断开，等待重新连接…');
}
function terminalTheme() {
  const css = getComputedStyle(document.documentElement);
  const colors = getComputedStyle($('termText'));
  const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
  return { ...Object.fromEntries(names.flatMap((name, index) => {
    const color = colors.getPropertyValue('--term-ansi-' + index).trim();
    return color ? [[name, color]] : [];
  })), background: css.getPropertyValue('--term-bg').trim(), foreground: css.getPropertyValue('--term-fg').trim(),
    cursor: css.getPropertyValue('--term-fg').trim(), selectionBackground: '#7164c877' };
}
new MutationObserver(() => { if (raTerminal) raTerminal.options.theme = terminalTheme(); })
  .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
function terminalSelection() { return raTerminal?.getSelection() || ''; }
function clearTermSelection() { raTerminal?.clearSelection(); }
function disposeTerminalView() {
  raTerminal?.dispose(); raTerminal = null;
  $('termText').replaceChildren();
}
function terminalCursorVisible() {
  if (!raTerminal || !terminalFollow || terminalSelection()) return;
  const cell = $('termText').querySelector('.xterm-screen').clientHeight / raTerminal.rows;
  const y = raTerminal.buffer.active.cursorY * cell + $('termText').offsetTop;
  if (y < view.scrollTop) view.scrollTop = y;
  else if (y + cell > view.scrollTop + view.clientHeight) view.scrollTop = y + cell - view.clientHeight;
}
function terminalWrite(data, requestId, binary = false) {
  if (!terminalAvailable()) return false;
  terminalFollow = true;
  return send({ t: 'termWrite', id: currentTerminalId, subscription: terminalSubscription, data,
    ...(requestId ? { requestId } : {}), ...(binary ? { binary: true } : {}) });
}
function terminalKey(key) {
  const cursor = raTerminal?.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[';
  const keys = { Enter: '\r', Tab: '\t', Escape: '\x1b',
    ArrowUp: cursor + 'A', ArrowDown: cursor + 'B', ArrowRight: cursor + 'C', ArrowLeft: cursor + 'D' };
  terminalWrite(keys[key]);
}
function openRaTerminal(id) {
  closeSheet();
  closeTerminalPassword();
  terminalListRequest = terminalCreateRequest = null;
  if (id !== currentTerminalId || terminalComputer !== currentComputer()?.id) {
    disposeTerminalView();
    currentTerminal = terminalCwd = '';
    termState = 'loading'; updateTermEmpty(); updateTitle();
  }
  terminalReady = false;
  terminalComputer = currentComputer().id;
  currentTerminalId = id;
  terminalSubscription = crypto.randomUUID();
  terminalSequence = 0;
  terminalMessage('正在恢复终端…');
  updateTerminalControls();
  send({ t: 'openTerminal', id, subscription: terminalSubscription });
}
function requestTerminals(select = false) {
  if (!authed) return;
  terminalListRequest = { requestId: crypto.randomUUID(), computer: currentComputer().id, select };
  send({ t: 'terminals', requestId: terminalListRequest.requestId });
}
function resumeTerminal() {
  if (terminalOrigin?.computer !== currentComputer().id) terminalOrigin = { computer: currentComputer().id, source: 'computer' };
  terminalReady = false;
  terminalComputer = currentComputer().id;
  terminalSubscription = '';
  currentTerminalId = '';
  currentTerminal = '';
  disposeTerminalView();
  termState = 'empty'; updateTermEmpty();
  terminalMessage('正在读取终端列表…');
  updateTitle(); updateTerminalControls();
  requestTerminals(true);
}
function enterTerminalMode(fromChat) {
  if (fromChat && terminalOrigin?.source !== 'computer') terminalOrigin = { computer: currentComputer()?.id, source: 'conversation', sel: viewSel };
  terminalOrigin ||= { computer: currentComputer()?.id, source: 'computer' };
  if (authed) resumeTerminal();
  else { terminalDisconnected(); terminalMessage('正在连接电脑…'); }
}
function leaveTerminalMode() {
  terminalReady = false;
  terminalSubscription = '';
  terminalOrigin = null;
  terminalListRequest = terminalCreateRequest = null;
  closeTerminalPassword();
  updateTerminalControls();
  $('termStatus').hidden = true;
  $('dot').className = authed && windowReady ? 'ok' : '';
}
async function openComputerTerminal(id) {
  const index = loadComputers().findIndex(computer => computer.id === id);
  if (index < 0) return;
  terminalOrigin = { computer: id, source: 'computer' };
  // Mode is selected before changing computers, so authentication opens the terminal directly.
  if (currentComputer()?.id !== id) {
    saveDraft();
    mode = 'terminal'; store.set('mode', mode);
    terminalDisconnected();
    await useComputer(index);
    setMode('terminal');
  } else setMode('terminal');
  ovShowConversation();
}
function createRaTerminal(cwd = '') {
  const computer = currentComputer()?.id;
  if (!authed || terminalOrigin?.computer && terminalOrigin.computer !== computer)
    return terminalMessage('电脑已切换，请从当前电脑新建终端', true);
  const origin = cwd ? { source: 'computer' } : terminalOrigin || { source: 'computer' };
  terminalListRequest = null;
  terminalCreateRequest = { requestId: crypto.randomUUID(), computer };
  terminalMessage('正在新建终端…');
  send({ t: 'newTerminal', requestId: terminalCreateRequest.requestId, source: origin.source,
    ...(origin.source === 'conversation' ? { sel: origin.sel } : {}), ...(cwd ? { cwd } : {}) });
}
function removeRaTerminal(id) {
  send({ t: 'closeTerminal', id, requestId: crypto.randomUUID() });
}
function renderTerminalSnapshot(m) {
  const same = terminalComputer === currentComputer().id && raTerminal && currentTerminalId === m.id;
  const scroll = same ? [view.scrollLeft, view.scrollTop] : [0, 0];
  disposeTerminalView();
  currentTerminalId = m.id; currentTerminal = m.title; terminalCwd = m.cwd;
  terminalExited = m.exited;
  terminalSequence = m.seq; terminalFollow = !same;
  termState = 'text'; updateTermEmpty();
  const terminal = raTerminal = new Terminal({ cols: m.cols, rows: m.rows, scrollback: 1000,
    fontFamily: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace', fontSize: 13,
    cursorBlink: true, theme: terminalTheme(), allowProposedApi: true, disableStdin: true });
  terminal.open($('termText'));
  terminal.onData(data => { if (terminal === raTerminal) terminalWrite(data); });
  terminal.onBinary(data => { if (terminal === raTerminal) terminalWrite(data, undefined, true); });
  const subscription = terminalSubscription;
  terminal.write(m.data, () => {
    if (raTerminal !== terminal || terminalSubscription !== subscription) return;
    terminalReady = true;
    store.set('terminal-' + terminalComputer, m.id);
    view.scrollLeft = scroll[0]; view.scrollTop = scroll[1];
    updateTerminalControls(); terminalCursorVisible();
  });
  terminalMessage(m.exited ? ct('终端已退出（{code}）', { code: m.exitCode }) : '');
  updateTitle(); updateTerminalControls();
}
function receiveTerminal(m) {
  if (m.t === 'terminals') {
    const request = terminalListRequest;
    if (mode !== 'terminal' || !request || request.computer !== currentComputer()?.id || m.requestId !== request.requestId) return true;
    terminalListRequest = null;
    if (request.select) {
      const saved = store.get('terminal-' + request.computer);
      if (m.list.some(terminal => terminal.id === saved)) openRaTerminal(saved);
      else {
        store.set('terminal-' + request.computer, null);
        terminalMessage('');
        if (m.list.length) showTerminals(m.list);
      }
    } else { terminalMessage(''); showTerminals(m.list); }
    return true;
  }
  if (m.t === 'termCreated') {
    if (m.requestId === terminalCreateRequest?.requestId && terminalCreateRequest.computer === currentComputer()?.id && mode === 'terminal') {
      terminalCreateRequest = null; openRaTerminal(m.terminal.id);
    }
    return true;
  }
  if (m.t === 'termRemoved') {
    if (sheetKind === 'terminals') requestTerminals();
    return true;
  }
  if (m.t === 'termError') {
    if (m.subscription && m.subscription !== terminalSubscription) return true;
    if (m.action === 'newTerminal' && m.requestId !== terminalCreateRequest?.requestId) return true;
    if (m.action === 'terminals' && m.requestId !== terminalListRequest?.requestId) return true;
    if (m.requestId === terminalPasswordRequest) closeTerminalPassword();
    if (mode === 'terminal') terminalMessage(m.message, true);
    return true;
  }
  if (m.t === 'termWritten') {
    if (m.requestId === terminalPasswordRequest) { closeTerminalPassword(); terminalMessage('密码输入已提交'); }
    return true;
  }
  if (!['termSnapshot', 'termData', 'termSize', 'termExit', 'termClosed'].includes(m.t)) return false;
  if (mode !== 'terminal' || terminalComputer !== currentComputer()?.id || m.id !== currentTerminalId || m.subscription !== terminalSubscription) return true;
  if (m.t === 'termSnapshot') { renderTerminalSnapshot(m); return true; }
  if (m.seq <= terminalSequence) return true;
  if (m.seq !== terminalSequence + 1) {
    terminalReady = false; updateTerminalControls();
    terminalMessage('终端输出顺序不连续，请刷新终端', true);
    return true;
  }
  terminalSequence = m.seq;
  if (m.t === 'termData') raTerminal.write(m.data, terminalCursorVisible);
  else if (m.t === 'termSize') { raTerminal.resize(m.cols, m.rows); updateTitle(); }
  else if (m.t === 'termExit') {
    terminalExited = true; updateTerminalControls(); terminalMessage(ct('终端已退出（{code}）', { code: m.exitCode }));
  } else if (m.t === 'termClosed') {
    terminalReady = false; currentTerminalId = ''; currentTerminal = ''; terminalCwd = '';
    store.set('terminal-' + terminalComputer, null);
    disposeTerminalView(); termState = 'empty'; updateTermEmpty(); updateTitle(); updateTerminalControls();
    terminalMessage('已关闭终端');
  }
  return true;
}

$('pickTerms').onclick = () => requestTerminals();
$('newTerm').onclick = $('termEmptyNew').onclick = () => createRaTerminal();
$('termFolder').onclick = () => openProjectFolders(terminalCwd, { computer: currentComputer().id, source: 'terminal' });
$('termKeyboard').onclick = () => { terminalFollow = true; raTerminal?.focus(); terminalCursorVisible(); };
$('termInt').onclick = () => terminalWrite('\x03');
$('termRefresh').onclick = () => { if (currentTerminalId) openRaTerminal(currentTerminalId); else requestTerminals(true); };
$('termSize').onclick = showTerminalSize;
for (const button of document.querySelectorAll('[data-termkey]')) {
  button.addEventListener('pointerdown', e => e.preventDefault());
  button.onclick = () => terminalKey(button.dataset.termkey);
}
for (const id of ['termCopy', 'termSelectAll']) $(id).addEventListener('pointerdown', e => e.preventDefault());
$('termSelectAll').onclick = () => raTerminal?.selectAll();
$('termCopy').onclick = async () => {
  if (!raTerminal) return;
  let value = terminalSelection();
  if (!value) {
    raTerminal.selectAll();
    value = raTerminal.getSelection().trimEnd();
  }
  await copyText(value, $('termCopy'), false);
  clearTermSelection();
};
view.addEventListener('touchstart', () => { if (mode === 'terminal') terminalFollow = false; }, { passive: true });
view.addEventListener('wheel', () => { if (mode === 'terminal') terminalFollow = false; }, { passive: true });
$('termText').addEventListener('focusin', () => { fitViewport(); });
$('termText').addEventListener('focusout', () => { fitViewport(); });
$('zoom').onclick = () => setZoom(1);
$('refresh').onclick = () => send({ t: 'refresh' });
document.querySelectorAll('[data-key]').forEach(b => b.onclick = () => send({ t: 'key', key: b.dataset.key }));

function closeTerminalPassword() {
  $('termPassword').value = '';
  $('termPasswordBox').hidden = true;
  $('termPasswordSend').disabled = false;
  terminalPasswordTarget = terminalPasswordRequest = null;
}
$('termPasswordToggle').onclick = () => {
  terminalPasswordTarget = { computer: terminalComputer, id: currentTerminalId, subscription: terminalSubscription };
  $('termPasswordBox').hidden = false;
  $('termPassword').focus();
};
$('termPasswordCancel').onclick = closeTerminalPassword;
$('termPasswordBox').onsubmit = e => {
  e.preventDefault();
  if (!terminalPasswordTarget || terminalPasswordRequest || terminalPasswordTarget.computer !== currentComputer()?.id
      || terminalPasswordTarget.id !== currentTerminalId || terminalPasswordTarget.subscription !== terminalSubscription) return;
  const requestId = crypto.randomUUID();
  if (!terminalWrite($('termPassword').value + '\r', requestId)) return;
  terminalPasswordRequest = requestId;
  $('termPassword').value = '';
  $('termPasswordSend').disabled = true;
  terminalMessage('正在提交密码…');
};
document.addEventListener('composer-state', updateTerminalControls);
