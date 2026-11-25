import { nodeActions, sendPhone } from './transport.mjs';

const globalActions = new Set(['back', 'home', 'recents']);
const isPoint = value => typeof value === 'number' && value >= 0 && value <= 1;
const readOnly = kind => kind === 'inspect' || kind === 'apps';
const failure = reason => ({ ok: false, reason });

function actionContent(message, transport, agent) {
  const { kind, revision, node, action, text, x, y, endX, endY, duration } = message;
  if (kind === 'inspect' || agent && kind === 'apps') return { kind };
  if (agent && kind === 'launch' && typeof message.app === 'string' && /^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+$/.test(message.app))
    return { kind, app: message.app };
  if (kind === 'system' && globalActions.has(action)) return { kind, action };
  if (kind === 'node' && Number.isSafeInteger(revision) && revision > 0 && Number.isSafeInteger(node) && node >= 0 && nodeActions.has(action)) {
    const native = transport.treeNativeRevision(revision);
    if (!native) return null;
    if (action !== 'text') return { kind, revision: native, node, action };
    if (typeof text === 'string' && text.length <= 2000) return { kind, revision: native, node, action, text };
  }
  if (kind === 'gesture' && revision === transport.geometry?.revision && [x, y, endX, endY].every(isPoint) &&
    Number.isInteger(duration) && duration >= 1 && duration <= 1500) {
    const content = { kind, revision: transport.nativeScreen, x, y, endX, endY, duration };
    if (agent && message.window !== undefined) {
      const state = transport.observation;
      if (!state || message.window !== state.window || message.app !== state.app) return null;
      Object.assign(content, { window: message.window, app: message.app });
    }
    return content;
  }
  return null;
}

export class PhoneActionScheduler {
  constructor(session) {
    this.session = session;
    this.nextId = 0;
    this.observationRequired = false;
  }

  requireObservation(required) {
    if (this.observationRequired === required) return;
    this.observationRequired = required;
    sendPhone(this.session.viewer, { type: 'observationRequired', required });
  }

  async exclusive(signal, run) {
    signal.throwIfAborted();
    if (this.batch || this.pending) throw Error('The phone is processing another operation');
    const batch = this.batch = {};
    sendPhone(this.session.viewer, { type: 'agentBusy', busy: true });
    try {
      return await run(message => this.submit(message, { batch, signal }));
    } finally {
      if (this.batch === batch) {
        if (signal.aborted && batch.mutated) this.requireObservation(true);
        this.releaseBatch();
      }
    }
  }

  releaseBatch() {
    this.batch = null;
    sendPhone(this.session.viewer, { type: 'agentBusy', busy: false });
  }

  manual(viewer, message) {
    const { id } = message;
    const { replies } = viewer;
    if (id <= viewer.lastAction) {
      const result = replies.get(id);
      if (result) sendPhone(viewer, { type: 'ack', id, ...result });
      else if (!replies.has(id) && (this.pending?.viewer !== viewer || this.pending.requestId !== id))
        sendPhone(viewer, { type: 'ack', id, ok: false, reason: 'outcomeUnknown' });
      return;
    }
    viewer.lastAction = id;
    replies.set(id, null);
    if (replies.size > 32) replies.delete(replies.keys().next().value);
    this.submit(message, { viewer, requestId: id, signal: viewer.access.signal }).then(result => {
      if (this.session.viewer !== viewer) return;
      if (replies.has(id)) replies.set(id, result);
      sendPhone(viewer, { type: 'ack', id, ...result });
    }, () => {}); // A detached viewer has no recipient.
  }

  submit(message, { batch, viewer, requestId, signal }) {
    signal.throwIfAborted();
    const { session } = this;
    const { transport } = session;
    if (transport.state !== 'ready') return Promise.resolve(failure(transport.state));
    if (this.pending || (batch || null) !== (this.batch || null)) return Promise.resolve(failure('busy'));
    const content = actionContent(message, transport, !!batch);
    if (!content) return Promise.resolve(failure('stale'));
    if (this.observationRequired && !readOnly(content.kind)) return Promise.resolve(failure('observationRequired'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const action = { id, kind: content.kind, viewer, requestId, epoch: transport.epoch, host: session.host, resolve };
      const cancelled = () => {
        // Android may still be executing a gesture. Drain its ACK or deadline without re-dispatching.
        action.resolve = null;
        if (!readOnly(action.kind)) this.requireObservation(true);
        reject(signal.reason);
      };
      action.timer = setTimeout(() => this.finish(action, failure('outcomeUnknown')), 6000);
      action.timer.unref();
      action.unsubscribe = () => signal.removeEventListener('abort', cancelled);
      signal.addEventListener('abort', cancelled, { once: true });
      this.pending = action;
      if (sendPhone(action.host, { type: 'action', id, ...content })) {
        if (batch && !readOnly(content.kind)) batch.mutated = true;
      } else this.finish(action, failure('outcomeUnknown'));
    });
  }

  invalidate() {
    if (this.pending) this.finish(this.pending, failure('outcomeUnknown'));
    if (this.batch) this.releaseBatch();
  }

  finish(action, result) {
    if (this.pending !== action) return;
    this.pending = null;
    action.unsubscribe();
    clearTimeout(action.timer);
    if (result.reason === 'outcomeUnknown' && !readOnly(action.kind)) this.requireObservation(true);
    action.resolve?.({ operationId: action.id, ...result });
  }

  acknowledge(host, message) {
    const { pending } = this;
    if (!pending || pending.host !== host || pending.epoch !== this.session.transport.epoch || pending.id !== message.id ||
        typeof message.ok !== 'boolean') return;
    const { ok } = message;
    const apps = pending.kind === 'apps' && Array.isArray(message.apps) ? message.apps.slice(0, 220)
      .filter(item => typeof item?.app === 'string' && typeof item.name === 'string')
      .map(item => ({ app: item.app.slice(0, 160), name: item.name.slice(0, 160) })) : undefined;
    let reason;
    if (!ok) {
      // Older Android builds report a cancelled, possibly partial gesture as unsupported.
      reason = ['stale', 'locked', 'busy'].includes(message.reason) || (message.reason === 'unsupported' && pending.kind !== 'gesture')
        ? message.reason : 'outcomeUnknown';
    }
    // The v3 inspect ACK follows a fresh accessibility read, even when the snapshot is unchanged.
    if (ok && pending.resolve && pending.kind === 'inspect' && this.session.transport.state === 'ready') this.requireObservation(false);
    this.finish(pending, { ok, apps, reason });
  }
}
