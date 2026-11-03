/* ---------- RA interactive terminals ---------- */
let raTerminal = null;
let terminalOrigin = null, terminalListRequest = null, terminalCreateRequest = null;
let terminalSubscription = '', terminalSequence = 0, terminalReady = false;
let terminalComputer = '', terminalExited = false, terminalCwd = '', terminalFollow = true;
let terminalPrompt = false;
let terminalPasswordTarget = null, terminalPasswordRequest = null;
let terminalCompletion = null, terminalHistoryRequest = null;
const terminalInputHistory = new Map();
const terminalInputKey = () => [currentComputer()?.id || '', currentTerminalId].join('|');

function sendTerminalInput() {
  if (!terminalAvailable() || !text.value.trim()) return;
  saveDraft();
  const receipt = sendReceipt(text.value);
  if (!send({ t: 'termSend', id: currentTerminalId, subscription: terminalSubscription, text: text.value, ...receipt }))
    failPendingSend(receipt.requestId);
}
function completeTerminalInput() {
  if (!terminalAvailable()) return;
  if (terminalCompletion?.subscription === terminalSubscription && terminalCompletion.revision === inputRevision) { terminalCompletion.tabs++; return; }
  terminalCompletion = { requestId: crypto.randomUUID(), id: currentTerminalId, subscription: terminalSubscription, revision: inputRevision, tabs: 0 };
  if (!send({ t: 'termComplete', text: text.value, caret: text.selectionStart, ...terminalCompletion })) terminalCompletion = null;
}
function recallTerminalInput(direction, commands) {
  if (!terminalAvailable()) return;
  if (terminalHistoryRequest?.subscription === terminalSubscription && terminalHistoryRequest.revision === inputRevision) {
    terminalHistoryRequest.directions.push(direction);
    return;
  }
  const key = terminalInputKey();
  let state = terminalInputHistory.get(key);
  if (!state) {
    if (direction > 0) return;
    if (!commands) {
      terminalHistoryRequest = { requestId: crypto.randomUUID(), id: currentTerminalId, subscription: terminalSubscription, revision: inputRevision, direction, directions: [direction] };
      send({ t: 'termHistory', ...terminalHistoryRequest });
      return;
    }
    if (!commands.length) return terminalMessage('当前终端暂无可读取的命令历史');
    state = { rows: commands, index: commands.length, draft: text.value, selection: [text.selectionStart, text.selectionEnd, text.selectionDirection] };
    terminalInputHistory.set(key, state);
  }
  state.index = Math.max(0, Math.min(state.rows.length, state.index + direction));
  const atDraft = state.index === state.rows.length;
  text.value = atDraft ? state.draft : state.rows[state.index];
  if (atDraft) text.setSelectionRange(...state.selection);
  else text.setSelectionRange(text.value.length, text.value.length);
  inputRevision++; autosize(); saveDraft();
  if (atDraft) terminalInputHistory.delete(key);
  inputRecall = atDraft ? null : { history: terminalInputHistory, key };
}
function receiveTerminalInput(m) {
  if (mode !== 'terminal' || m.id !== currentTerminalId || m.subscription !== terminalSubscription) return;
  const request = m.t === 'termHistory' ? terminalHistoryRequest : terminalCompletion;
  if (request?.requestId !== m.requestId) return;
  if (m.t === 'termHistory') terminalHistoryRequest = null;
  else terminalCompletion = null;
  if (m.revision !== inputRevision) return;
  if (m.t === 'termHistory') {
    for (const direction of request.directions) recallTerminalInput(direction, m.commands);
    return;
  }
  text.value = m.text;
  text.setSelectionRange(m.caret, m.caret);
  recordDraftEdit();
  if (request.tabs) { completeTerminalInput(); if (terminalCompletion) terminalCompletion.tabs = request.tabs - 1; }
}

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
  if (mode === 'terminal') $('send').disabled = !available;
  for (const id of ['termInt', 'termSize', 'termPasswordToggle']) $(id).disabled = !available;
  for (const button of document.querySelectorAll('[data-termkey]')) button.disabled = !available || !terminalPrompt;
  $('termCopy').disabled = $('termSelectAll').disabled = !raTerminal;
  $('newTerm').disabled = $('termEmptyNew').disabled = $('termFolder').disabled = !authed;
  if (!available) closeTerminalPassword();
}
function terminalDisconnected() {
  terminalReady = false;
  terminalCompletion = terminalHistoryRequest = null;
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
  if (key === 'Tab') completeTerminalInput();
  else recallTerminalInput(key === 'ArrowUp' ? -1 : 1);
}
function openRaTerminal(id) {
  saveDraft();
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
  restoreDraft();
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
  saveDraft();
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
  terminalCompletion = terminalHistoryRequest = null;
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
  terminalPrompt = m.prompt;
  terminalSequence = m.seq; terminalFollow = !same;
  termState = 'text'; updateTermEmpty();
  const terminal = raTerminal = new Terminal({ cols: m.cols, rows: m.rows, scrollback: 1000,
    fontFamily: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace', fontSize: 13,
    cursorBlink: false, theme: terminalTheme(), allowProposedApi: true, disableStdin: true });
  terminal.open($('termText'));
  terminal.textarea.readOnly = true;
  terminal.textarea.tabIndex = -1;
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
  if (m.t === 'termInput' || m.t === 'termHistory') { receiveTerminalInput(m); return true; }
  if (m.t === 'termSent') {
    const sent = pendingSends.get(m.requestId);
    confirmSent(m, false);
    if (sent) terminalInputHistory.delete([sent.computer, m.id].join('|'));
    return true;
  }
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
    if (m.requestId === terminalCompletion?.requestId) terminalCompletion = null;
    if (m.requestId === terminalHistoryRequest?.requestId) terminalHistoryRequest = null;
    if (m.action === 'termSend') failPendingSend(m.requestId, m.message);
    if (mode === 'terminal') terminalMessage(m.message, true);
    return true;
  }
  if (m.t === 'termWritten') {
    if (m.requestId === terminalPasswordRequest) { closeTerminalPassword(); terminalMessage('密码输入已提交'); }
    return true;
  }
  if (!['termSnapshot', 'termData', 'termShell', 'termSize', 'termExit', 'termClosed'].includes(m.t)) return false;
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
  else if (m.t === 'termShell') { terminalCwd = m.cwd; terminalPrompt = m.prompt; updateTerminalControls(); }
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
