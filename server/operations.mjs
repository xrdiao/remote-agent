import { AsyncLocalStorage } from 'node:async_hooks';

// Native results belong to the paired entry, not to its current WebSocket.
const entries = new Map();
const context = new AsyncLocalStorage();
const results = new Set(['status', 'sent', 'sendFailed', 'queueDone', 'questionDone', 'menuPicked', 'saved', 'sessionBatchProgress', 'codexArchived', 'clickDone', 'overviewManaged']);
const entry = id => {
  if (!entries.has(id)) entries.set(id, { clients: new Set(), requests: new Map() });
  return entries.get(id);
};
export const currentOperation = () => context.getStore();
export const withOperation = (operation, action) => context.run(operation, action);
export const bindOperation = action => {
  const operation = currentOperation();
  return (...args) => withOperation(operation, () => action(...args));
};
export function publishDesktopState(deviceId, message) {
  for (const client of entry(deviceId).clients) if (client.readyState === 1) client.send(JSON.stringify(message));
}

export function desktopAction(session, message) {
  if (message.t === 'overviewManage') return true;
  if (session.app === 'fusion') return false;
  return message.t === 'send' ? message.submit !== false && session.mode !== 'terminal'
    : message.t === 'queue' ? message.action !== 'read'
    : ['stop', 'pickMenu', 'question', 'codexRequest', 'click', 'subagent', 'saveFile', 'sessionManage', 'sessionBatch', 'codexRename', 'codexArchive'].includes(message.t);
}

export function beginOperation(session, message) {
  if (!message.operationId || !desktopAction(session, message)) return null;
  const owner = entry(session.deviceId), previous = owner.requests.get(message.operationId);
  if (previous) { previous.publish(); return { operation: previous, duplicate: true }; }
  const operation = {
    id: message.operationId, deviceId: session.deviceId, kind: message.t,
    app: message.t === 'overviewManage' ? String(message.win).split(':')[0] : session.app,
    sel: message.sel || session.selectionKey(), requestId: message.requestId,
    events: new Map(), revision: 0, done: false, started: false, submitted: false,
    publish(client) {
      const packet = JSON.stringify({ t: 'operation', id: this.id, kind: this.kind, app: this.app,
        sel: this.sel, requestId: this.requestId, done: this.done, events: [...this.events.values()] });
      for (const target of client ? [client] : owner.clients) if (target.readyState === 1) target.send(packet);
      if (this.done) {
        const completed = [...owner.requests.values()].filter(request => request.done);
        for (const old of completed.slice(0, -100)) owner.requests.delete(old.id);
      }
    },
    emit(message) {
      if (this.done) return;
      this.events.set(message.t, { revision: ++this.revision, message: { ...message, sel: this.sel, app: this.app } });
      if (message.t === 'overviewManaged' || message.t === 'sendFailed' || message.t === 'sent' && !message.pending) this.done = true;
      this.publish();
    },
    finish() {
      if (!this.pending) this.done = true;
      this.publish();
    },
  };
  owner.requests.set(operation.id, operation);
  return { operation, duplicate: false };
}

export function captureOperation(session, message) {
  const operation = currentOperation();
  if (!operation || operation.deviceId !== session.deviceId || !results.has(message.t)) return false;
  operation.emit(message);
  return true;
}

export function subscribeOperations(deviceId, client) {
  const owner = entry(deviceId);
  owner.clients.add(client);
  for (const operation of owner.requests.values()) operation.publish(client);
  return () => owner.clients.delete(client);
}
