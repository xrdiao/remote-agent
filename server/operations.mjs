import { AsyncLocalStorage } from 'node:async_hooks';
import { desktopAction as isDesktopAction } from '../lib/shared-rules.mjs';
import { bindConnectionDelivery } from './session/connection-view.mjs';

const results = new Set(['status', 'sent', 'sendFailed', 'queueDone', 'questionDone', 'opencodeQuestionDone', 'menuPicked', 'saved', 'computerFileDone', 'sessionBatchProgress', 'codexArchived', 'clickDone', 'overviewManaged', 'termCreated', 'termRemoved', 'termError']);
const terminalResults = new Set(['overviewManaged', 'computerFileDone', 'sendFailed', 'termCreated', 'termRemoved', 'termError']);
const computerActions = new Set(['saveComputerFile', 'computerFileAction', 'newTerminal', 'closeTerminal']);

export function desktopAction(session, message) {
  return isDesktopAction(message, session.app, session.mode);
}

class DesktopOperation {
  #events = new Map();
  #revision = 0;
  #awaitingReceipt = false;
  #done = false;
  #publish;

  constructor(session, message, publish) {
    const computerAction = computerActions.has(message.t);
    this.id = message.operationId;
    this.deviceId = session.deviceId;
    this.kind = message.t;
    this.app = computerAction ? '' : message.t === 'overviewManage' ? String(message.win).split(':')[0] : session.app;
    this.sel = computerAction ? '' : message.sel || session.selectionKey();
    this.requestId = message.requestId;
    this.#publish = publish;
  }

  get done() { return this.#done; }

  expectReceipt() {
    if (!this.#done) this.#awaitingReceipt = true;
  }

  releaseReceipt() { this.#awaitingReceipt = false; }

  publish(client) {
    this.#publish({ t: 'operation', id: this.id, kind: this.kind, app: this.app, sel: this.sel,
      requestId: this.requestId, done: this.#done, events: [...this.#events.values()] }, client);
  }

  emit(message) {
    if (this.#done) return;
    const sel = this.kind === 'send' && (message.t === 'sent' || message.t === 'sendFailed' && message.materializedFrom === this.sel) ? message.sel || this.sel : this.sel;
    this.#events.set(message.t, { revision: ++this.#revision, message: { ...message, sel, app: this.app } });
    if (terminalResults.has(message.t) || message.t === 'sent' && !message.pending) this.#complete();
    this.publish();
  }

  finish() {
    if (!this.#awaitingReceipt) this.#complete();
    this.publish();
  }

  #complete() {
    this.#done = true;
    this.#awaitingReceipt = false;
  }
}

// Operation results belong to the paired entry across WebSocket and Session replacement.
export class OperationRegistry {
  #entries = new Map();
  #context = new AsyncLocalStorage();
  #completedLimit;

  constructor({ completedLimit = 100 } = {}) {
    this.#completedLimit = completedLimit;
  }

  current() { return this.#context.getStore(); }

  run(operation, action) { return this.#context.run(operation, action); }

  bind(action) {
    const operation = this.current();
    return bindConnectionDelivery((...args) => this.run(operation, () => action(...args)));
  }

  publishState(deviceId, message) {
    this.#publish(this.#entry(deviceId).clients, message);
  }

  begin(session, message) {
    const id = message.operationId;
    if (!id) return null;
    const submittedSend = message.t === 'send' && message.submit !== false;
    const eligible = desktopAction(session, message);
    if (!eligible && !submittedSend) return null;
    const owner = this.#entries.get(session.deviceId);
    const previous = owner?.requests.get(id);
    const evictedSend = owner?.evictedSends.has(id);
    const previousKind = previous?.kind || (evictedSend ? 'send' : null);
    if (previousKind && previousKind !== message.t) {
      // STOP is safe to dispatch without claiming an earlier SEND's ID.
      if (previousKind === 'send' && message.t === 'stop') return null;
      return { collision: true };
    }
    // A retained SEND is still a duplicate after the session changes app or mode.
    if (previous) {
      previous.publish();
      return { operation: previous, duplicate: true };
    }
    if (evictedSend) {
      this.#unknown(session.client, id, 'send');
      return { duplicate: true };
    }
    if (!eligible) return null;
    const entry = owner || this.#entry(session.deviceId);
    const operation = new DesktopOperation(session, message, (packet, client) => {
      this.#publish(client ? [client] : entry.clients, packet);
      if (packet.done) this.#trim(entry);
    });
    entry.requests.set(id, operation);
    return { operation, duplicate: false };
  }

  capture(session, message) {
    const operation = this.current();
    if (!operation || operation.deviceId !== session.deviceId || !results.has(message.t)) return false;
    operation.emit(message);
    return true;
  }

  subscribe(deviceId, client, replay = true) {
    const owner = this.#entry(deviceId);
    owner.clients.add(client);
    if (replay) for (const operation of owner.requests.values()) operation.publish(client);
    return () => owner.clients.delete(client);
  }

  lookup(deviceId, client, ids, kinds = null) {
    const requests = this.#entry(deviceId).requests;
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      const request = requests.get(id);
      if (request && (!kinds || kinds.includes(request.kind))) request.publish(client);
      else this.#unknown(client, id, kinds?.[0]);
    }
  }

  #entry(deviceId) {
    if (!this.#entries.has(deviceId)) this.#entries.set(deviceId, { clients: new Set(), requests: new Map(), evictedSends: new Set() });
    return this.#entries.get(deviceId);
  }

  #publish(targets, message) {
    const packet = JSON.stringify(message);
    for (const target of targets) if (target.readyState === 1) target.send(packet);
  }

  #unknown(client, id, kind) {
    if (client) this.#publish([client], { t: 'operation', id, kind, unknown: true, done: true, events: [] });
  }

  #trim(owner) {
    const completed = [...owner.requests.values()].filter(request => request.done);
    for (const old of completed.slice(0, Math.max(0, completed.length - this.#completedLimit))) {
      owner.requests.delete(old.id);
      // Keep the identity after its event history is retired so a repeat cannot send again.
      if (old.kind === 'send') owner.evictedSends.add(old.id);
    }
  }
}

const registry = new OperationRegistry();
export const currentOperation = () => registry.current();
export const withOperation = (operation, action) => registry.run(operation, action);
export const bindOperation = action => registry.bind(action);
export const publishDesktopState = (deviceId, message) => registry.publishState(deviceId, message);
export const beginOperation = (session, message) => registry.begin(session, message);
export const captureOperation = (session, message) => registry.capture(session, message);
export const subscribeOperations = (deviceId, client, replay) => registry.subscribe(deviceId, client, replay);
export const lookupOperations = (deviceId, client, ids, kinds) => registry.lookup(deviceId, client, ids, kinds);
