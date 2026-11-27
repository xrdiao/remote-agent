import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { PAGE_FACTORY, PAGE_VERSION } from './page/build.mjs';

// A window switch cancels only reads running in the previous binding's scope.
export const cdpRead = new AsyncLocalStorage();
const pageHelper = `globalThis.__remoteAgentPage_${PAGE_VERSION}`;
const helperMissing = `RemoteAgent page helper missing: ${PAGE_VERSION}`;
const helperInstalls = new WeakMap();

export function awaitCdpRead(pending) {
  const signal = cdpRead.getStore();
  signal?.throwIfAborted();
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(pending).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

export async function pollUntil(check, { timeout, delays = [25, 40, 60, 100, 150], signal = cdpRead.getStore() }) {
  signal?.throwIfAborted();
  if (timeout <= 0) return null;
  const deadline = performance.now() + timeout;
  const limit = new AbortController(), expired = new Error('Readiness deadline reached');
  const poll = signal ? AbortSignal.any([limit.signal, signal]) : limit.signal;
  const timer = setTimeout(() => limit.abort(expired), timeout);
  try {
    return await cdpRead.run(poll, async () => {
      for (let attempt = 0; performance.now() < deadline; attempt++) {
        poll.throwIfAborted();
        const value = await awaitCdpRead(check(attempt));
        poll.throwIfAborted();
        const remaining = deadline - performance.now();
        if (remaining <= 0) break;
        if (value) return value;
        await sleep(Math.min(remaining, delays[Math.min(attempt, delays.length - 1)]), undefined, { signal: poll });
      }
      return null;
    });
  } catch (error) {
    signal?.throwIfAborted();
    if (error === expired || error?.cause === expired) return null;
    throw error;
  } finally { clearTimeout(timer); }
}

export class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.onclose = null;
  }

  // Zombie targets can accept the TCP connection yet never answer the WebSocket handshake
  // (an app mid-restart leaves stale entries in /json/list); without a bound the caller
  // would wait forever and stall the session's whole command queue.
  connect(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const signal = cdpRead.getStore();
      signal?.throwIfAborted();
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      this.closeReason = null;
      let opened = false;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      const cancel = () => { cleanup(); reject(signal.reason); try { ws.close(); } catch {} };
      const timer = setTimeout(() => { cleanup(); try { ws.close(); } catch {} reject(new Error(`CDP connect timeout: ${this.wsUrl}`)); }, timeoutMs);
      signal?.addEventListener('abort', cancel, { once: true });
      ws.onopen = () => { opened = true; cleanup(); resolve(); };
      ws.onerror = () => { if (!opened) { cleanup(); reject(new Error(`CDP connect failed: ${this.wsUrl}`)); } };
      ws.onclose = () => {
        if (!opened) { cleanup(); reject(new Error(`CDP connect failed: ${this.wsUrl}`)); return; }
        const error = this.closeReason || new Error('CDP closed');
        const transportError = Object.assign(new Error(error.message, { cause: error }), { code: 'CDP_TRANSPORT' });
        for (const { reject } of this.pending.values()) reject(transportError);
        this.pending.clear();
        this.onclose?.(error);
      };
      ws.onmessage = ev => {
        const msg = JSON.parse(ev.data);
        if (msg.method === 'Inspector.detached') {
          this.closeReason = new Error('CDP 目标连接已解除: ' + msg.params.reason);
          ws.close();
          return;
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        } else if (msg.method) {
          cdpRead.run(null, () => this.handlers.get(msg.method)?.(msg.params));
        }
      };
    });
  }

  send(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const signal = cdpRead.getStore();
      signal?.throwIfAborted();
      if (this.ws?.readyState !== WebSocket.OPEN) return reject(this.closeReason || new Error('CDP 连接未打开'));
      const id = ++this.nextId;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      const fail = error => { if (this.pending.delete(id)) { cleanup(); reject(error); } };
      const cancel = () => fail(signal.reason);
      const timer = setTimeout(() => fail(Object.assign(new Error('CDP 调用超时: ' + method), { code: 'CDP_TRANSPORT' })), timeoutMs);
      this.pending.set(id, {
        resolve: v => { cleanup(); resolve(v); },
        reject: e => { cleanup(); reject(e); },
      });
      signal?.addEventListener('abort', cancel, { once: true });
      try { this.ws.send(JSON.stringify({ id, method, params })); } catch (error) { fail(error); }
    });
  }

  on(method, fn) {
    this.handlers.set(method, fn);
  }

  async evaluate(expression, opts = {}) {
    const params = { returnByValue: true, awaitPromise: true,
      ...(opts.contextId != null ? { contextId: opts.contextId } : {}) };
    const timeout = opts.timeout ?? 30000;
    const evaluate = (source, remaining = timeout) =>
      this.send('Runtime.evaluate', { ...params, expression: source }, remaining);
    let r;
    if (expression.includes(PAGE_FACTORY)) {
      const deadline = performance.now() + timeout;
      const remaining = () => Math.max(1, deadline - performance.now());
      // Guard before evaluating the caller's expression. On a context reset, only
      // the guard has run, so action expressions can safely follow installation.
      const cached = `typeof ${pageHelper} === "function"
        ? (${expression.replaceAll(PAGE_FACTORY, pageHelper)}\n)
        : (() => { throw ${JSON.stringify(helperMissing)}; })()`;
      r = await evaluate(cached, remaining());
      if (r.exceptionDetails?.exception?.value === helperMissing) {
        const socket = this.ws, context = opts.contextId ?? null;
        let installs = helperInstalls.get(socket);
        if (!installs) helperInstalls.set(socket, installs = new Map());
        let install = installs.get(context);
        if (!install) {
          // Other reads in the same execution context can use this installation
          // even if the navigation that initiated it is superseded.
          install = cdpRead.run(null, () =>
            evaluate(`typeof ${pageHelper} === "function" || (${pageHelper} = ${PAGE_FACTORY}, true)`, remaining()))
            .then(result => {
              if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'page helper install failed');
            }).finally(() => installs.delete(context));
          installs.set(context, install);
        }
        await awaitCdpRead(install);
        r = await evaluate(cached, remaining());
      }
    } else r = await evaluate(expression);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate failed');
    return r.result.value;
  }

  close() {
    try { this.ws?.close(); } catch {}
  }

}

export const MOD = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 };
export const NAMED_KEYS = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  Tab: { code: 'Tab', vk: 9 },
  Delete: { code: 'Delete', vk: 46 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  '`': { code: 'Backquote', vk: 192, text: '`' },
};
