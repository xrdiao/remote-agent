import { AsyncLocalStorage } from 'node:async_hooks';

// A window switch cancels only reads running in the previous binding's scope.
export const cdpRead = new AsyncLocalStorage();

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
      let opened = false;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      const cancel = () => { cleanup(); reject(signal.reason); try { ws.close(); } catch {} };
      const timer = setTimeout(() => { cleanup(); try { ws.close(); } catch {} reject(new Error(`CDP connect timeout: ${this.wsUrl}`)); }, timeoutMs);
      signal?.addEventListener('abort', cancel, { once: true });
      ws.onopen = () => { opened = true; cleanup(); resolve(); };
      ws.onerror = () => { if (!opened) { cleanup(); reject(new Error(`CDP connect failed: ${this.wsUrl}`)); } };
      ws.onclose = () => {
        if (!opened) { cleanup(); reject(new Error(`CDP connect failed: ${this.wsUrl}`)); return; }
        for (const { reject } of this.pending.values()) reject(new Error('CDP closed'));
        this.pending.clear();
        this.onclose?.();
      };
      ws.onmessage = ev => {
        const msg = JSON.parse(ev.data);
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
      const id = ++this.nextId;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      const fail = error => { if (this.pending.delete(id)) { cleanup(); reject(error); } };
      const cancel = () => fail(signal.reason);
      const timer = setTimeout(() => fail(new Error('CDP 调用超时: ' + method)), timeoutMs);
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
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, opts.timeout ?? 30000);
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
