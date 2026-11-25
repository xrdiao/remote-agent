import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { bindDeviceConnection } from '../../lib/auth.mjs';
import { Session } from '../session.mjs';

const RESUME_MS = 5 * 60 * 1000;
const CLAIM_DRAIN_MS = 3000;

function resumable(session) {
  return session.mode === 'terminal'
    || session.bindingReady && (session.app === 'opencode' || session.codexBackend
      || session.cdp?.ws?.readyState === 1 && ['cursor', 'devin', 'codex'].includes(session.app));
}

export class SessionRecovery {
  #contexts = new Map();

  *activeSessions(deviceId) {
    for (const { owner, session } of this.#contexts.values()) {
      if (owner?.authorized() && session.deviceId === deviceId) yield session;
    }
  }

  candidate(id, deviceId) {
    const context = this.#contexts.get(id);
    if (context?.session.deviceId !== deviceId) return;
    if (context.retention?.deadline > Date.now() || this.#available(context)) return context;
    // A valid resume ID still identifies the old connection while its binding is
    // provisional. Retire its transport before issuing a fresh session.
    if (context.owner) context.owner.retire(false);
    else if (!context.claim) this.#dispose(context);
  }

  async claim(context, connection) {
    const previous = context.claim;
    context.claim = connection;
    previous?.close(4002, 'connection replaced');
    context.owner?.retire(true);
    const retention = context.retention;
    if (!retention) return;
    const timer = new AbortController();
    try {
      await Promise.race([retention.draining, retention.expiry.promise,
        delay(CLAIM_DRAIN_MS, undefined, { signal: timer.signal, ref: false })]);
    } finally { timer.abort(); }
  }

  releaseClaim(context, connection) {
    if (context?.claim === connection) context.claim = null;
  }

  activate(candidate, connection, deviceId) {
    // A new connection may authenticate while a retired native operation is
    // still settling. Only transfer a binding after its old scheduler drained.
    const resumed = !!candidate?.retention?.drained && this.#available(candidate);
    if (resumed) this.#clearRetention(candidate);
    else if (candidate) this.#dispose(candidate);
    const session = resumed ? candidate.session : new Session(connection.ws, deviceId);
    if (!resumed) session.resumeId = randomUUID();
    const context = resumed ? candidate : { session };
    context.owner = connection;
    context.claim = null;
    this.#contexts.set(session.resumeId, context);
    return { context, resumed };
  }

  disconnect(context, connection, authorized) {
    if (context.owner !== connection) return;
    context.owner = null;
    if (!authorized || context.session.disposed || !resumable(context.session)) {
      connection.scheduler.abortNavigation();
      this.#dispose(context);
      return;
    }
    const retention = context.retention = {
      deadline: Date.now() + RESUME_MS,
      expiry: Promise.withResolvers(),
      scheduler: connection.scheduler,
      drained: false,
    };
    retention.draining = retention.scheduler.drain().then(() => {
      if (context.retention === retention && !context.session.disposed) context.session.suspend();
      retention.drained = true;
    });
    retention.timer = setTimeout(() => this.#dispose(context), RESUME_MS);
    retention.timer.unref();
    // A retained binding still belongs to an authorized entry while no socket owns it.
    retention.authorization = bindDeviceConnection(context.session.deviceId, () => this.#dispose(context));
  }

  close() {
    for (const context of this.#contexts.values()) this.#dispose(context);
  }

  #available(context) {
    return this.#contexts.get(context.session.resumeId) === context && !context.session.disposed
      && (context.owner || context.retention?.deadline > Date.now()) && resumable(context.session);
  }

  #clearRetention(context) {
    const retention = context.retention;
    if (!retention) return;
    context.retention = null;
    clearTimeout(retention.timer);
    retention.authorization?.release();
    retention.expiry.resolve();
  }

  #dispose(context) {
    if (this.#contexts.get(context.session.resumeId) !== context) return;
    this.#contexts.delete(context.session.resumeId);
    context.retention?.scheduler.abortNavigation();
    this.#clearRetention(context);
    context.session.dispose();
  }
}
