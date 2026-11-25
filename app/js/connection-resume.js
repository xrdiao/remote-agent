/* Foreground projection, parked bindings, and reconnect scheduling. */
let connGen = 0, bootGeneration = 0;

function clearComputerRetry(computer) {
  if (!computer) return;
  const link = linkForComputerKey(computer.key);
  clearTimeout(link?.retry);
  if (link) link.retry = null;
}
function computerRetryAllowed(computer, probe = false) {
  if (pending || !computer || navigator.onLine === false || computerBackgroundAt !== null) return false;
  const link = linkForComputerKey(computer.key);
  if (link?.computer.token !== computer.token) return true;
  return (link?.phase !== 'paused' || probe) && !link?.replaced && !link?.rejected;
}
function autoRetry(computer = currentComputer(), failed = true, immediate = false) {
  if (!computerRetryAllowed(computer)) return;
  const link = computerConnection(computer);
  if (link.retry != null || link.attempt) return;
  if (failed) link.retryFailures++;
  if (link.retryProbe || link.retryFailures >= 3) {
    link.phase = 'paused'; link.retryProbe = false;
    ovRender();
    return;
  }
  link.retry = setTimeout(() => {
    link.retry = null;
    const saved = loadComputers().find(row => row.key === computer.key && row.token === computer.token);
    if (!saved) return;
    reconnectComputer(saved.id, 'auto');
  }, immediate ? 0 : 8000);
  ovRender();
}

function parkComputerSocket(socket = ws) {
  if (!socket) return;
  const link = [...computerLinks()].find(link => link.socket === socket);
  if (!link) { socket?.close(); return; }
  if (link.receive) {
    link.mode = mode;
    link.navigationId = selectedConversation.serial;
    link.composer = { epoch: draftEpoch, revision: draftRevision, ackRevision: draftAckRevision };
    link.connection = { ...conn };
    if (selectedConversation.navigation?.kind === 'initial') link.preload = { target: currentComputer(), navigation: { ...selectedConversation.navigation } };
  }
  link.send({ t: 'visible', v: false });
  link.receive = link.closed = null;
}
function computerBindingReady(link) {
  const binding = link.binding;
  return binding?.ready && !binding.cached && !!binding.chat && binding.chat.thread === (binding.threadId || '');
}
function resumableComputerSocket(computer) {
  const notice = pendingNotice && noticeTarget(pendingNotice);
  if (notice?.project && notice.computer === computer.id) return null;
  const link = linkForComputerKey(computer.key), binding = link?.binding;
  if (!link?.authed || link.socket?.readyState !== 1 || link.computer.token !== computer.token) return null;
  if (mode === 'terminal') return link;
  if (mode !== 'chat' || link.mode !== mode) return null;
  const target = link.preload?.target || { win: binding?.id, windowId: binding?.windowId, threadId: binding?.threadId };
  if (target.win !== computer.win || (target.windowId || '') !== (computer.windowId || '') || (target.threadId || '') !== (computer.threadId || '')) return null;
  return link.preload || computerBindingReady(link) ? link : null;
}
function preloadComputerSocket(link) {
  const chosen = link.auth.resumed ? link.auth.selection : link.auth.lastSelection;
  const message = { t: 'attach', id: chosen?.id || '', windowId: chosen?.windowId || '', threadId: chosen?.threadId || '',
    project: typeof chosen?.project === 'object' ? chosen.project : null, initial: true, resume: link.auth.resumed, navigationId: 1 };
  link.mode = 'chat';
  link.navigationId = message.navigationId;
  link.composer = { epoch: link.auth.draftEpoch || '', revision: 0, ackRevision: 0 };
  link.connection = { ...newComputerConnection(), host: true, lastSelection: chosen };
  link.preload = { target: loadComputers().find(row => row.key === link.computer.key), navigation: navigationState(message) };
  link.send({ t: 'visible', v: false });
  if (link.auth.resumed && link.auth.mode !== 'chat') link.send({ t: 'mode', mode: 'chat' });
  link.send(message);
}
async function warmComputerSocket(computer) {
  if (pending || navigator.onLine === false || linkForComputerKey(computer.key)?.phase === 'paused'
      || computer.discovery && new URL(computer.discovery).origin !== location.origin) return;
  const current = () => !pending && loadComputers().some(row => row.key === computer.key && row.token === computer.token);
  const previous = linkForComputerKey(computer.key), refresh = !computer.relay || !previous?.auth?.ok;
  const activate = async relay => {
    if (!current() || navigator.onLine === false) return null;
    const link = await openComputerSocket(computer, relay);
    if (current() && computer.key === currentComputer()?.key && (ws !== link.socket || !link.receive)) {
      base = link.relay;
      await connect(resumableComputerSocket(loadComputers().find(row => row.key === computer.key)));
    }
    return link;
  };
  let link = computer.relay ? await activate(computer.relay) : null;
  if (link?.authed) probeComputerSocket(link);
  const discover = async () => {
    const data = await fetchDiscovery(computer.discovery || discoveryUrl(), AbortSignal.timeout(10000));
    const relay = await resolveBase(data, computer, current);
    if (!current() || navigator.onLine === false || !computerRetryAllowed(computer)) return;
    updateComputerRecord({ ...computer, relay });
    if (!link || link.relay !== relay) link = await activate(relay);
  };
  if (refresh) {
    try { await discover(); } catch (error) { if (!link) throw error; }
  }
  await link?.firstScreen;
  if (!refresh && current() && link?.phase === 'offline') {
    await discover();
    await link?.firstScreen;
  }
  return link;
}

function rejectComputerConnection(computer, phase) {
  const link = computerConnection(computer);
  clearComputerRetry(computer);
  link.phase = phase;
  link.failure = phase === 'identity' ? { stage: '电脑身份验证', error: '地址对应的电脑身份不一致，正在等待最新地址' }
    : { stage: '设备验证', error: '设备授权已失效或被移除，请重新授权这台设备。' };
  link.error = link.failure.error;
  if (link.socket === ws) { authed = false; setWindowReady(false); }
  if (link.socket?.readyState < 2) closeSocket(link.socket, 'authorization');
  ovRender();
}
let computerWarmup = null;
async function warmComputerSockets(probe = false, fromBackground = false) {
  if (pending) return;
  for (const link of computerLinks()) if (!loadComputers().some(row => row.key === link.computer.key && row.token === link.computer.token)) {
    dropComputerSocket(link.computer.key);
  }
  if (computerWarmup) {
    if (probe && (!computerWarmup.probe || fromBackground)) computerWarmup.probeRequested = true;
    return computerWarmup;
  }
  const queue = loadComputers().filter(row => row.key !== currentComputer()?.key && computerRetryAllowed(row, probe));
  // Two complete first-screen loads at a time; the current computer never waits for them.
  computerWarmup = Promise.all([0, 1].map(async () => {
    while (queue.length) {
      const computer = queue.shift();
      if (!computerRetryAllowed(computer, probe) || !probe && linkForComputerKey(computer.key)?.retry != null) continue;
      const link = linkForComputerKey(computer.key);
      if (link?.socket?.readyState < 2) { await link.firstScreen; continue; }
      await reconnectComputer(computer.id, probe ? 'resume' : 'auto');
    }
  })).finally(() => {
    const requested = computerWarmup.probeRequested;
    computerWarmup = null;
    if (requested) return warmComputerSockets(true);
  });
  computerWarmup.probe = probe;
  return computerWarmup;
}

function resumeComputerConnections() {
  if (document.visibilityState !== 'visible') return;
  const fromBackground = computerBackgroundAt !== null;
  if (computerBackgroundAt !== null && Date.now() - computerBackgroundAt >= COMPUTER_BACKGROUND_MS)
    for (const link of computerLinks()) if (link.socket?.readyState < 2) closeSocket(link.socket, 'background');
  for (const link of computerLinks()) recordComputerConnection(link, 'foreground');
  computerBackgroundAt = null;
  if (navigator.onLine === false) return;
  const foreground = !authed && (!ws || ws.readyState >= 2) ? reconnectComputer(currentComputer()?.id, 'resume') : null;
  for (const link of computerLinks()) {
    if (link.socket === ws) ovVisible();
    else link.send?.({ t: 'visible', v: false, watching: false, background: false });
    probeComputerSocket(link);
  }
  warmComputerSockets(true, fromBackground).catch(() => {});
  return foreground;
}

function ovVisible() {
  if (!authed) return;
  const watching = conversationVisible();
  send({ t: 'visible', v: watching || document.visibilityState === 'visible' && ovComposerReady(), watching, background: document.visibilityState !== 'visible' });
}
function startComputerUpdates() {
  requestAgentCatalog();
  ovVisible();
  send({ t: 'lang', v: I18N.lang });
  clearInterval(usageTimer);
  usageTimer = setInterval(() => { if (authed && mode !== 'terminal' && document.visibilityState === 'visible') send({ t: 'usage', automatic: true }); }, 60 * 1000);
  syncNotify();
  setTimeout(checkAppUpdate, 3000);
}
function restoreTerminalChat() {
  if (!authed || mode !== 'chat' || windowReady || selectedConversation.navigation) return;
  const link = linkForComputerKey(currentComputer()?.key);
  const chosen = link?.binding || conn.lastSelection;
  send({ t: 'attach', id: chosen?.id || '', windowId: chosen?.windowId || '', threadId: chosen?.threadId || '',
    project: typeof chosen?.project === 'object' ? chosen.project : null, initial: true, resume: !!link?.binding });
}
async function connect(resumeLink = null) {
  const computer = currentComputer();
  if (pending || !computer || navigator.onLine === false || linkForComputerKey(computer.key)?.phase === 'paused') return;
  const gen = ++connGen, attempt = bootGeneration;
  if (!resumeLink) {
    parkComputerSocket(ws);
    ws = null;
    authed = false;
    setWindowReady(false);
    resetComputerConnection();
  }
  resetLatency();
  resetSelectionProjection();
  draftEpoch = resumeLink?.composer?.epoch || '';
  draftRevision = resumeLink?.composer?.revision || 0;
  draftAckRevision = resumeLink?.composer?.ackRevision || 0;
  if (!resumeLink && (text.value || drafts.has(activeDraft))) draftRevision++;
  pendingDesktopDraft = null;
  clearComputerRetry(computer);
  const link = resumeLink || await openComputerSocket(computer, base);
  if (gen !== connGen || attempt !== bootGeneration || computer.key !== currentComputer()?.key) return;
  const socket = ws = link.socket;
  base = link.relay;
  link.closed = () => {
    if (gen !== connGen || computer.key !== currentComputer()?.key || ws !== socket) return;
    if (sheetKind === 'menu' && menuPending) showMenuError(menuPending.kind, '电脑连接已断开，请重新读取菜单');
    resetLatency();
    setWindowReady(false);
    cancelConnectionWork();
    qnSig = '';
    $('qnBar').classList.remove('show');
    $('dot').className = '';
    authed = false;
    if (mode === 'terminal') terminalDisconnected();
    conn.host = 'err';
    if (link.replaced) {
      status('连接已在其他页面恢复', false);
      return;
    }
    if (link.rejected) return;
    status('断开，重连中…', false);
  };
  link.receive = (message, resumed = false) => {
    if (gen !== connGen || computer.key !== currentComputer()?.key || ws !== socket) return;
    receiveForegroundEvent(link, message, resumed);
  };
  if (resumeLink) {
    if (mode === 'terminal') {
      authed = link.authed;
      conn.host = true; conn.initialSelection = false;
      link.mode = mode;
      ungate();
      send({ t: 'mode', mode });
      startComputerUpdates();
      resumeTerminal();
      return;
    }
    const ready = computerBindingReady(link), preload = link.preload;
    link.preload = null;
    Object.assign(conn, link.connection);
    authed = link.authed;
    restoreSelectionProjection(link.navigationId, ready ? null : preload.navigation);
    lastChat = null; viewSel = '';
    ungate();
    if (ready) {
      Object.assign(conn, { initialSelection: false, attachFailed: false });
    } else {
      setWindowReady(false);
      currentProject = '';
      restoreDraft();
      renderChat(null, false, true);
      ovRender();
    }
    if (link.binding) link.receive({ ...link.binding, keepQuota: false, initial: !ready }, ready);
    if (ready) deliverDeferredOperations(link);
    for (const message of link.metadata.values()) link.receive(message);
    if (preload?.outcome) link.receive(preload.outcome);
    if (preload) send({ t: 'sessionLibrary', entries: legacyAgentLibrary() });
    document.dispatchEvent(new Event('voice-authenticated'));
    startComputerUpdates();
  } else if (link.auth && !link.restoring && socket.readyState === 1) link.receive(link.auth);
}

function receiveForegroundAuthorization(link, m) {
  if (m.id !== link.expectedId || !m.ok) {
    link.socket.close();
    if (m.id !== link.expectedId) return showOffline({stage: '电脑身份验证', error: '地址对应的电脑身份不一致，正在等待最新地址'});
    ovRender();
    if (requestedComputerAuth !== link.computer.key) return;
    if (m.needTotp) return showTotp(verifyTotp);
    return gate({msg: '设备授权已失效或被移除，请重新授权这台设备。', err: true, repair: true, computers: loadComputers().length > 1});
  }
  conn.lastSelection = m.resumed ? m.selection : m.lastSelection;
  draftEpoch = m.draftEpoch || '';
  authed = link.authed;
  if (requestedComputerAuth === link.computer.key) requestedComputerAuth = '';
  send({ t: 'sessionLibrary', entries: legacyAgentLibrary() });
  document.dispatchEvent(new Event('voice-authenticated'));
  ungate();
  connHostOk();
  if (sheetKind === 'computers') closeSheet();
  status('正在切换窗口…');
  if (!m.resumed || m.mode !== mode) send({ t: 'mode', mode });
  if (mode === 'terminal') {
    link.mode = mode;
    link.composer = { epoch: draftEpoch, revision: draftRevision, ackRevision: draftAckRevision };
    conn.initialSelection = false;
    startComputerUpdates();
    resumeTerminal();
    return;
  }
  if (m.resumed) for (const message of link.metadata.values()) link.receive(message);
  const fromNotice = window.AgentRemoteApp?.takeOpenWin?.() || pendingNotice;
  pendingNotice = '';
  if (fromNotice && noticeTarget(fromNotice)?.computer && noticeTarget(fromNotice).computer !== m.id) {
    if (!openWin(fromNotice)) showComputers('通知来源电脑未配对，请从电脑列表连接');
    return;
  }
  const notice = fromNotice ? rememberNotice(fromNotice) : null;
  const chosen = fromNotice ? { ...currentComputer(), ...notice, id: currentComputer()?.win } : link.binding || conn.lastSelection;
  if (link.binding?.chat && !fromNotice) {
    applySelection(link.binding, false);
    selectionPreview();
  }
  send({ t: 'attach', id: chosen?.id || '', windowId: chosen?.windowId || '', threadId: chosen?.threadId || '',
    project: typeof chosen?.project === 'object' ? chosen.project : null, initial: !notice?.project, resume: (m.resumed || !!link.binding) && !fromNotice }, fromNotice ? { ...noticeTarget(fromNotice), computer: m.id } : undefined);
  startComputerUpdates();
}
