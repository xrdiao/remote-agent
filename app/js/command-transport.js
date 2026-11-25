/* Foreground command routing and command-specific correlation fields. */
function signedCommands(socket, scope, connection, onError) {
  const prefix = ['ra-command-v1', scope, connection].join('\n') + '\n';
  let sequence = 0, pending = Promise.resolve();
  return message => {
    if (socket.readyState !== WebSocket.OPEN) return;
    const payload = JSON.stringify(message);
    pending = pending.then(async () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const number = ++sequence;
      const signature = await signEntry(prefix + number + '\n' + payload);
      if (socket.readyState === WebSocket.OPEN) socket.send(number + '.' + signature + '\n' + payload);
    }).catch(onError);
  };
}

const desktopAction = message => RemoteAgentRules.desktopAction(message, currentApp, mode);
function send(obj, target) {
  if (!['terminals', 'openTerminal', 'closeTerminal', 'newTerminal', 'termWrite', 'termResize', 'termSend', 'termComplete', 'termHistory'].includes(obj.t)) obj.sel ??= viewSel;
  if (['attach', 'openAgent', 'openProject'].includes(obj.t)) beginNavigation(obj, target);
  if (obj.t === 'attach') {
    const name = {cursor: 'Cursor', devin: 'Devin', codex: 'Codex', fusion: 'Fusion', opencode: 'OpenCode'}[String(obj.id || '').split(':')[0]];
    if (name) $('titleText').textContent = name + '…';
  }
  if (obj.t === 'openMenu') {
    obj.requestId = ++menuRequest;
    menuPending = { requestId: obj.requestId, kind: obj.kind, sel: viewSel };
  }
  if (obj.t === 'pickMenu' && (obj.kind === 'model' || obj.kind === 'effort' || obj.kind === 'fast' || currentApp === 'opencode' && obj.kind === 'permission')) {
    clearSwitchWatch();
    obj.requestId = ++menuPickRequest;
    modelSwitchRequest = { requestId: obj.requestId, sel: viewSel };
    status(obj.kind === 'fast' ? '设置中…' : '切换中…');
  }
  if (obj.t === 'docs') {
    obj.requestId = ++docsRequest;
    docsPending = { id: obj.requestId, sel: viewSel, computer: currentComputer()?.id || '' };
  }
  if (currentApp === 'codex' && ['settings', 'codexSetting', 'codexInstructions'].includes(obj.t)) obj.requestId = ++codexSettingsRequest;
  if (ws && ws.readyState === 1 && authed) {
    if (desktopAction(obj)) return sendDesktopOperation(obj);
    else ws.sendCommand(obj);
    return true;
  }
  status('未连接', false);
  return false;
}
