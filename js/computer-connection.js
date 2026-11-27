/* Each link owns one physical socket, authorization, and incoming relay state. */
const computerSockets = new Map();
const linkForComputerKey = key => computerSockets.get(key);
const computerLinks = () => computerSockets.values();
const COMPUTER_PING_MS = 15000;
const COMPUTER_BACKGROUND_MS = 5 * 60 * 1000;
let pingTimer = null;
let computerBackgroundAt = null;
function computerConnection(computer) {
  let link = computerSockets.get(computer.key);
  if (link && link.computer.token !== computer.token) { dropComputerSocket(computer.key); link = null; }
  if (!link) {
    link = { computer, expectedId: computer.id, socket: null, phase: 'idle', metadata: new Map(), retry: null, attempt: null,
      retryFailures: 0, retryProbe: false, probe: null,
      get authed() { return this.phase === 'ready'; },
      get restoring() { return this.phase === 'restoring'; },
      get rejected() { return this.phase === 'auth' || this.phase === 'identity'; },
      get replaced() { return this.phase === 'replaced'; } };
    computerSockets.set(computer.key, link);
  }
  link.computer = computer;
  if (computer.id) { link.expectedId = computer.id; ovStOf(computer.id).link = link; }
  return link;
}
function recordComputerConnection(link, event, detail = {}) {
  if (event === 'closed') link.lastClose = {};
  const record = link.lastClose;
  if (!record || record.ready || record[event]) return;
  record[event] = { at: Date.now(), visibility: document.visibilityState, backgroundAt: computerBackgroundAt,
    online: navigator.onLine !== false, phase: link.phase, socketState: link.socket?.readyState ?? null,
    current: !!link.socket && link.socket === ws, authed: link.authed, activeAuthed: authed, ...detail };
  if (sheetKind === 'connection-details' && connectionDetailsComputer === link.expectedId) showConnectionDetails(link.expectedId);
}
function stopComputerProbe(link) { link.probe = null; }
function probeComputerSocket(link) {
  if (!link.authed || link.socket?.readyState !== 1 || link.probe) return;
  link.probe = { checkedAt: Date.now(), missed: 0 };
  link.send({ t: 'ping', visible: link.socket === ws && conversationVisible() });
}
// Count unanswered checks while the page runs; a suspended page does not consume
// its response budget. Both normal heartbeats and foreground restoration use this probe.
function heartbeat() {
  if (document.visibilityState !== 'visible' || navigator.onLine === false) return;
  for (const link of computerSockets.values()) {
    if (!link.authed || link.socket?.readyState !== 1) continue;
    if (link.probe && Date.now() - link.probe.checkedAt >= COMPUTER_PING_MS) {
      link.probe.checkedAt = Date.now();
      link.probe.missed++;
    }
    if (link.probe?.missed >= 3) {
      link.error = '实时连接存活检测超时';
      closeSocket(link.socket, 'heartbeat');
    } else probeComputerSocket(link);
  }
}
function suspendComputerConnections() {
  computerBackgroundAt ??= Date.now();
  for (const link of computerSockets.values()) {
    clearComputerRetry(link.computer);
    stopComputerProbe(link);
    saveComputerResume(link);
    link.send?.({ t: 'visible', v: false, watching: false, background: true });
  }
}
// close() waits for the peer's close frame, which a dead path never sends — the
// socket then sits in CLOSING and onclose never fires. Force the cleanup.
function closeSocket(socket, source = 'connection') {
  const link = [...computerSockets.values()].find(link => link.socket === socket);
  if (!link) return;
  link.closeSource = source;
  stopComputerProbe(link);
  try { socket.close(); } catch {}
  if (socket.readyState === 3) return;
  link.closeTimer = setTimeout(() => {
    if (link.socket !== socket || socket.readyState === 3 || !socket.onclose) return;
    const onclose = socket.onclose;
    socket.onclose = null;
    try { onclose.call(socket, { code: 1006 }); } catch {}
  }, 5000);
}
function updateComputerRecord(computer, selection = {}) {
  const current = currentComputer()?.key;
  const metadata = Object.fromEntries(Object.entries(computer).filter(([key]) => ['id', 'name', 'device', 'relay'].includes(key)));
  const list = loadComputers().map(row => row.key === computer.key ? { ...row, ...metadata, ...selection } : row);
  saveComputers(list, current);
}
function dropComputerSocket(key) {
  const link = computerSockets.get(key);
  if (!link) return;
  clearComputerRetry({ key, id: link.expectedId });
  clearTimeout(link.closeTimer);
  stopComputerProbe(link);
  computerSockets.delete(key);
  link.finishFirstScreen?.();
  link.socket?.close();
  if (!computerSockets.size) { clearInterval(pingTimer); pingTimer = null; }
}
async function openComputerSocket(computer, relay) {
  await Promise.all([computerResumeReady, chatPreviewReady]);
  clearComputerRetry(computer);
  const expectedId = computer.id || await computerIdFromKey(computer.key);
  const link = computerConnection({ ...computer, id: expectedId });
  if (link.authed && link.socket?.readyState === 1) return link;
  if (link.relay === relay && link.socket?.readyState < 2) return link;
  const saved = computerResumes.get(expectedId);
  const old = link.socket;
  link.socket = null;
  link.finishFirstScreen?.();
  clearTimeout(link.closeTimer);
  stopComputerProbe(link);
  old?.close();
  const socket = new WebSocket(relay.replace(/^http/, 'ws') + '/ws');
  Object.assign(link, { relay, socket, expectedId, phase: 'connecting', opened: false, auth: null, error: '', closeSource: '', lastRx: 0,
    binding: undefined, preload: null, receive: null, closed: null, metadata: new Map() });
  recordComputerConnection(link, 'socket');
  link.firstScreen = new Promise(resolve => { link.finishFirstScreen = resolve; });
  link.send = message => { if (link.authed) socket.sendCommand?.(message); };
  const current = () => computerSockets.get(computer.key) === link && link.socket === socket;
  let timer = setTimeout(() => {
    if (!current()) return;
    link.error = '实时连接建立超时（30 秒）'; closeSocket(socket, 'handshake');
  }, 30000);
  socket.onopen = async () => {
    if (!current()) return;
    clearTimeout(timer);
    link.opened = true; link.phase = 'authenticating';
    ovRender();
    try {
      const proof = await entryProof(computer, 'WS /ws\n' + JSON.stringify([saved?.resumeId ?? null, true]));
      if (current() && socket.readyState === 1) {
        socket.send(JSON.stringify({ t: 'auth', token: computer.token, proof, resume: saved?.resumeId, selectiveOperations: true }));
        timer = setTimeout(() => {
          if (!current()) return;
          link.error = '设备验证超时'; closeSocket(socket, 'authentication');
        }, 5000);
      }
    } catch (error) { if (current()) { link.error = error.message; closeSocket(socket, 'proof'); } }
  };
  socket.onmessage = event => {
    if (!current()) return;
    receiveRelayEvent(link, event, { computer, relay, socket, expectedId, saved, current, authenticated: () => clearTimeout(timer) });
  };
  socket.onclose = event => {
    clearTimeout(timer);
    if (!current()) return;
    recordComputerConnection(link, 'closed', { code: event.code, source: link.closeSource || 'transport' });
    clearTimeout(link.closeTimer);
    stopComputerProbe(link);
    saveComputerResume(link);
    link.phase = event.code === 4002 ? 'replaced' : link.rejected ? link.phase : event.code === 4001 ? 'auth' : 'offline';
    link.binding = null;
    link.preload = null;
    link.finishFirstScreen();
    link.failure = { stage: link.rejected && link.failure ? link.failure.stage : link.opened ? '实时连接中断' : '实时连接建立',
      error: [link.error, 'WebSocket 关闭码 ' + event.code, link.closeSource || 'transport', new Date().toISOString(),
        `lastRx ${link.lastRx ? Date.now() - link.lastRx : 0}ms`].filter(Boolean).join(' · ') };
    ovRender();
    if (link.closed) link.closed(event);
    else disconnectPendingSends(expectedId);
    waitFileSave(expectedId);
    if (link.replaced || link.rejected || !loadComputers().some(row => row.key === computer.key && row.token === computer.token)) return;
    autoRetry({ ...computer, id: expectedId }, !link.auth?.ok, !!link.auth?.ok);
  };
  return link;
}

function authenticateComputerSocket(link, m, { computer, relay, socket, expectedId, saved, current, authenticated }) {
  authenticated();
  link.auth = m;
  if (m.ok && m.id === expectedId) {
    link.retryFailures = 0; link.retryProbe = false;
  }
  if (m.ok && m.id === expectedId && m.restoring) {
    link.phase = 'restoring';
    ovRender();
    return false;
  }
  if (m.ok && m.id === expectedId && !/^[A-Za-z0-9_-]{22}$/.test(m.commandSession || '')) {
    link.error = '中继不支持指令签名，请更新并重启电脑端中继';
    closeSocket(socket, 'proof');
    return false;
  }
  link.phase = m.id !== expectedId ? 'identity' : m.ok ? 'ready' : 'auth';
  if (link.authed) {
    socket.sendCommand = signedCommands(socket, '/ws', m.commandSession, error => {
      if (current()) { link.error = error.message; closeSocket(socket, 'proof'); }
    });
    recordComputerConnection(link, 'authenticated', { resumed: !!m.resumed });
    link.failure = null;
    pingTimer ||= setInterval(heartbeat, COMPUTER_PING_MS);
    updateComputerRecord({ ...computer, id: m.id, name: m.name, device: m.device, relay });
    if (m.resumed) {
      for (const message of m.metadata) link.metadata.set(message.t, message);
      if (saved?.binding.id === m.selection.id && saved.binding.windowId === m.selection.windowId && saved.binding.threadId === m.selection.threadId)
        link.binding = { ...saved.binding, chat: chatBySel.get(`${expectedId}|${saved.binding.sel}`), ready: false, cached: true };
    } else computerResumes.delete(expectedId);
    if (!link.receive && !(mode === 'terminal' && currentComputer()?.key === computer.key)) preloadComputerSocket(link);
    if (computerBackgroundAt !== null) link.send({ t: 'visible', v: false, watching: false, background: true });
    replayDesktopOperations(link);
  }
  else link.finishFirstScreen();
  return true;
}
