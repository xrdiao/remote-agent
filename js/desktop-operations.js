/* Requests live across sockets. Only their owning computer and device can settle them. */
const desktopOperations = (() => {
  const requests = new Map();
  function register(message, computer, socket, { device = currentComputer()?.device, complete, resultType, overview, promise } = {}) {
    message.operationId ||= crypto.randomUUID();
    if (requests.has(message.operationId)) return false;
    requests.set(message.operationId, { computer, device, kind: message.t, sel: message.sel, requestId: message.requestId,
      revision: 0, deferred: null, complete, resultType, overview, promise });
    socket.sendCommand(message);
    return true;
  }
  function owned(link, request) {
    return request.computer === link.expectedId && request.device === link.auth?.device;
  }
  function receive(link, result) {
    const request = requests.get(result.id);
    if (!request || !owned(link, request)) return;
    const foreground = !!link.receive && currentComputer()?.id === request.computer;
    if (!request.complete && (request.kind !== 'send' && !foreground || result.unknown && foreground && !windowReady && mode !== 'terminal')) {
      const last = request.deferred;
      if (!last?.done && (!last || last.events.at(-1)?.revision <= result.events.at(-1)?.revision || result.done)) request.deferred = result;
      return;
    }
    request.deferred = null;
    for (const event of result.events.slice().sort((a, b) => a.revision - b.revision)) {
      if (event.revision <= request.revision) continue;
      request.revision = event.revision;
      const message = event.message;
      if (request.complete) {
        if (message.t === request.resultType) {
          // Callback-driven requests consume one typed result.
          requests.delete(result.id);
          request.complete(message);
          return;
        }
      } else if (message.t === 'sent') confirmSent(message, true, request.computer);
      else if (message.t === 'sendFailed') receiveSendFailure(message, request.computer);
      else if (foreground && (message.t !== 'status' || result.sel === viewSel && request.sel === viewSel)) link.receive(message);
    }
    if (result.done) finish(result.id, request);
  }
  function finish(id, request) {
    requests.delete(id);
    if (request.complete)
      request.complete({ ok: false, error: '操作结果无法确认，请先核对电脑上的状态。', requestId: request.requestId });
    else if (request.kind === 'send')
      failPendingSend(request.requestId, '发送结果无法确认。草稿已保留，请先核对对话再重试。', true, request.computer);
    else if (request.kind === 'question' || request.kind === 'codexRequest')
      finishQuestion({ requestId: request.requestId, ok: false, error: '回答结果无法确认，请核对卡片后重试' });
    else if (request.kind === 'opencodeQuestion')
      finishOpenCodeQuestion({ requestId: request.requestId, ok: false, error: '回答结果无法确认，请核对问卷后重试' });
  }
  return Object.freeze({
    register, receive,
    remove: id => requests.delete(id),
    find: predicate => [...requests.values()].find(predicate),
    get size() { return requests.size; },
    deliverDeferred(link) {
      for (const request of requests.values()) if (request.deferred && owned(link, request)) receive(link, request.deferred);
    },
    lookup(link) {
      const ids = [], questionIds = [], pendingIds = [];
      for (const [id, request] of requests) {
        if (request.computer !== link.expectedId) continue;
        if (!owned(link, request)) {
          finish(id, request);
          continue;
        }
        if (link.auth.selectiveOperations) pendingIds.push(id);
        else if (request.kind === 'send') ids.push(id);
        else if ((request.kind === 'question' || request.kind === 'codexRequest') && questionSubmissions.has(request.requestId)) questionIds.push(id);
      }
      if (pendingIds.length || ids.length || questionIds.length) link.send({ t: 'operationLookup', pendingIds, ids, questionIds });
    },
  });
})();
const sendDesktopOperation = (message, computer = currentComputer()?.id || '', socket = ws, options) =>
  desktopOperations.register(message, computer, socket, options);
const receiveDesktopOperation = (link, result) => desktopOperations.receive(link, result);
const deliverDeferredOperations = link => desktopOperations.deliverDeferred(link);
const replayDesktopOperations = link => desktopOperations.lookup(link);
