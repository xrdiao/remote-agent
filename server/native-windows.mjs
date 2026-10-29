import { Cdp, cdpRead, awaitCdpRead } from './cdp.mjs';
import { watchChat } from './agent/updates.mjs';
import { PAGE_SRC, helpersCall } from './page/build.mjs';
import { editorRoots } from '../lib/files.mjs';
import { bindOperation, publishDesktopState, withOperation } from './operations.mjs';
import { AgentContext } from './agent/context.mjs';

// Native connections and read state belong to windows, not to a phone's current view.
const windows = new Map();
let discover = null, discovering = null, discoveryAt = 0;
let targets = [];
export const nativeTargets = () => targets;

export class NativeCdp extends Cdp {
  constructor(url) {
    super(url);
    this.nativeWindow = windows.get(url);
    if (!this.nativeWindow) windows.set(url, this.nativeWindow = new NativeWindow(url));
    this.nativeWindow.clients.add(this);
  }
  get ws() { return this.nativeWindow.cdp.ws; }
  connect() { return awaitCdpRead(this.nativeWindow.connect()); }
  send(method, params, timeout) {
    if (method === 'Emulation.setFocusEmulationEnabled') {
      const focus = this.nativeWindow.focus;
      if (params.enabled) focus.add(this); else focus.delete(this);
      return this.nativeWindow.cdp.send(method, { enabled: !!focus.size }, timeout);
    }
    return this.nativeWindow.cdp.send(method, params, timeout);
  }
  on(method, fn) {
    super.on(method, fn);
    this.nativeWindow.cdp.on(method, event => {
      for (const client of this.nativeWindow.clients) client.handlers.get(method)?.(event);
    });
  }
  close() {
    if (this.nativeWindow.focus.has(this)) this.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
    this.nativeWindow.clients.delete(this);
    this.handlers.clear();
    this.onclose = null;
  }
}

export function nativeWindow(cdp) { return cdp?.nativeWindow; }
export const nativeWindowAt = url => windows.get(url);
export function configureNativeRetry(deviceId, source, settings) {
  for (const window of windows.values()) window.retrySettings.delete(deviceId);
  if (source && settings?.enabled) {
    source.retrySettings.set(deviceId, settings);
    source.read(true).catch(() => {});
  }
}

export class NativeWindow {
  constructor(url) {
    this.cdp = new Cdp(url);
    this.clients = new Set();
    this.listeners = new Set();
    this.sends = new Map();
    this.retrySettings = new Map();
    this.retryAttempts = new Map();
    this.claimed = new Set();
    this.focus = new Set();
    this.revision = 0;
    this.updatedAt = 0;
    this.catalogAt = 0;
    this.queue = Promise.resolve();
    this.itemCache = new Map();
    this.cdp.onclose = error => this.close(error);
    this.cdp.on('Runtime.executionContextsCleared', () => {
      if (!this.win) return;
      this.stopWatch?.();
      this.observer?.close();
      this.watching = null;
      this.invalidate();
      this.start(this.win).catch(() => {});
    });
  }
  connect() {
    return this.connecting ||= cdpRead.run(null, () => this.cdp.connect()).catch(error => {
      this.close();
      throw error;
    });
  }
  async start(win) {
    this.win = win;
    if (this.watching) return this.watching;
    this.watching = cdpRead.run(null, async () => {
      await this.connect();
      const editor = new NativeCdp(win.editorWs || win.ws);
      this.rootsRead = editor.connect().then(() => editorRoots(editor, win.app)).then(roots => { this.roots = roots; })
        .catch(() => {}).finally(() => editor.close());
      const observer = this.observer = new NativeCdp(this.cdp.wsUrl);
      this.stopWatch = await watchChat(observer, () => {
        this.revision++;
        this.readReceipts().catch(() => {});
        this.read().catch(() => {});
      }, win.app === 'codex');
      this.read().catch(() => {});
    }).catch(error => { this.watching = null; this.observer?.close(); throw error; });
    return this.watching;
  }
  subscribe(changed) {
    this.listeners.add(changed);
    return () => this.listeners.delete(changed);
  }
  invalidate() {
    this.revision++;
    this.updatedAt = 0;
    this.reading?.controller.abort(new Error('原生窗口内容已切换'));
    this.reading = null;
  }
  setThread(thread) {
    if (this.thread === thread) return;
    this.thread = thread;
    this.invalidate();
  }
  async read(fresh = false) {
    if (this.reading) return awaitCdpRead(this.reading.promise);
    if (!fresh && this.snapshot && this.readRevision === this.revision && Date.now() - this.updatedAt < this.interval()) return this.snapshot;
    const revision = this.revision, controller = new AbortController();
    const read = { controller };
    const app = this.win?.app;
    read.promise = cdpRead.run(controller.signal, async () => {
      await this.connect();
      const result = await this.cdp.evaluate(`(() => {
        const h = ${PAGE_SRC};
        const chat = h.extract(false, [], ${app === 'codex' ? 80 : 0});
        return { chat, activeTab: h.activeChatTab(), states: h.agentStates(),
          surface: h.devinSurface(), catalog: ${app === 'codex' ? 'h.codexChatRows(true)' : app === 'devin' ? 'null' : 'h.agentList()'},
        };
      })()`);
      if (app === 'devin') result.catalog = await this.cdp.evaluate(helpersCall('sessionPickerRows(true)'));
      controller.signal.throwIfAborted();
      this.catalog = result.catalog || [];
      this.catalogAt = Date.now();
      const key = JSON.stringify(result);
      const changed = key !== this.snapshotKey;
      this.snapshotKey = key;
      this.snapshot = result;
      this.thread = result.chat?.thread;
      this.readError = null;
      this.readRevision = revision;
      this.updatedAt = Date.now();
      if (changed) withOperation(null, () => { for (const notify of this.listeners) notify(); });
      return result;
    }).catch(error => {
      if (!controller.signal.aborted && this.readError !== error.message) {
        this.readError = error.message;
        withOperation(null, () => { for (const notify of this.listeners) notify(error); });
      }
      throw error;
    }).finally(() => {
      if (this.reading === read) {
        this.reading = null;
        if (!controller.signal.aborted) this.retryCapacity(this.snapshot);
        if (!controller.signal.aborted && revision !== this.revision) this.read().catch(() => {});
      }
    });
    this.reading = read;
    return awaitCdpRead(read.promise);
  }
  interval() { return this.listeners.size || this.sends.size || this.snapshot?.states?.some(s => s.busy) ? 1800 : 15000; }
  run(action) {
    const result = this.queue.then(() => { cdpRead.getStore()?.throwIfAborted(); this.invalidate(); return action(); });
    this.queue = result.catch(() => {});
    return result;
  }
  registerSend(request, finish) {
    this.sends.set(request.requestId, { ...request, finish: bindOperation(finish) });
    this.revision++;
    this.updatedAt = 0;
    this.readReceipts().catch(() => {});
    return () => this.sends.delete(request.requestId);
  }
  async readReceipts() {
    if (this.win?.app !== 'codex' || !this.sends.size) return;
    if (this.receiptRead) {
      this.receiptAgain = true;
      return this.receiptRead.promise;
    }
    const requests = [...this.sends.values()].map(({ requestId, thread, afterTurn }) => ({ requestId, thread, afterTurn }));
    const read = { controller: new AbortController() };
    read.promise = cdpRead.run(read.controller.signal, async () => {
      await this.connect();
      const result = await this.cdp.evaluate(`(() => {
        const h = ${PAGE_SRC};
        const receipts = ${JSON.stringify(requests)}.map(request => ({
          ...h.codexSendState(false, request.thread || undefined, request.afterTurn), requestId: request.requestId,
        }));
        const errors = window.__remoteAgentSubmitErrors || [];
        window.__remoteAgentSubmitErrors = [];
        return { receipts, errors };
      })()`);
      this.confirmSends(result);
    }).catch(error => {
      if (!read.controller.signal.aborted) for (const request of this.sends.values()) {
        if (request.readError === error.message) continue;
        request.readError = error.message;
        request.finish(null, error.message, true);
      }
      throw error;
    }).finally(() => {
      if (this.receiptRead !== read) return;
      this.receiptRead = null;
      const again = this.receiptAgain;
      this.receiptAgain = false;
      if (again && !read.controller.signal.aborted) this.readReceipts().catch(() => {});
    });
    this.receiptRead = read;
    return read.promise;
  }
  confirmSends(result) {
    const claimed = this.claimed;
    for (const [id, request] of this.sends) {
      const state = result.receipts?.find(state => state.requestId === id) || result.receipt;
      if (!state || request.thread && state.thread !== request.thread) continue;
      const matches = row => !request.before.has(row.id) && !claimed.has(row.id)
        && !row.nativeIds?.some(id => request.beforeQueues.has(id) || claimed.has(id))
        && (request.expected ? row.t.trim() === request.expected : request.hasAttachments);
      const messages = new Map(state.messages.filter(matches).map(row => [row.i, row]));
      if (request.action === 'send') for (const run of state.runs || []) {
        if (!request.beforeTurns.has(run.id) && !claimed.has(run.id)
            && (request.expected ? run.t.trim() === request.expected : request.hasAttachments)) messages.set(run.i, run);
      }
      const queued = state.queued.filter(row => !request.beforeQueues.has(row.id) && !claimed.has(row.id)
        && (request.expected ? row.t.trim() === request.expected : request.hasAttachments));
      if (messages.size + queued.length === 1) {
        const row = queued[0] || messages.values().next().value;
        claimed.add(row.id);
        for (const nativeId of row.nativeIds || []) claimed.add(nativeId);
        while (claimed.size > 400) claimed.delete(claimed.values().next().value);
        this.sends.delete(id);
        request.finish({ queued: !!queued.length, thread: state.thread, ...(queued.length
          ? { queueId: row.id, ...(row.messageId ? { messageId: row.messageId } : {}) }
          : { messageId: row.i }) });
      } else {
        const error = result.errors?.find(error => error.requestId === id);
        if (error) { this.sends.delete(id); request.finish(null, error.message); }
      }
    }
  }
  retryCapacity(result) {
    if (this.win?.app !== 'codex' || this.retrying) return;
    const chat = result?.chat;
    const retryLabel = /^(Retry|Try(?: again)?|重试|再试一次)$/i;
    const item = chat?.items?.find(row => (row.capacity || row.kind === 'capacity') && row.b?.some(label => retryLabel.test(label)));
    if (!item) { for (const attempt of this.retryAttempts.values()) attempt.ready = true; return; }
    const settings = [...this.retrySettings].filter(([, setting]) => !setting.thread || setting.thread === chat.thread);
    const limit = Math.max(0, ...settings.map(([, setting]) => setting.count));
    const key = `${chat.thread}|${item.capacityInstance || item.btnItem || item.i}`;
    if (!this.retryAttempts.has(key)) {
      this.retryAttempts.set(key, { count: 0, ready: true });
      if (this.retryAttempts.size > 100) this.retryAttempts.delete(this.retryAttempts.keys().next().value);
    }
    const attempt = this.retryAttempts.get(key);
    if (!attempt.ready || attempt.count >= limit) return;
    attempt.ready = false;
    const n = item.b.findIndex(label => retryLabel.test(label));
    const controller = this.retryController = new AbortController();
    this.retrying = cdpRead.run(controller.signal, () => this.run(async () => {
      const current = [...this.retrySettings.values()].filter(setting => !setting.thread || setting.thread === chat.thread);
      if (!current.some(setting => attempt.count < setting.count)) { attempt.ready = true; return; }
      const cdp = new NativeCdp(this.cdp.wsUrl);
      try {
        await cdp.connect();
        await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        const pos = await cdp.evaluate(`(() => { const h = ${PAGE_SRC};
          return h.activeThread() === ${JSON.stringify(chat.thread)} && h.locate(${JSON.stringify(String(item.btnItem || item.i))}, ${n}, ${JSON.stringify(item.actions?.[n] || '')}, ${JSON.stringify(item.b[n])}); })()`);
        if (!pos) return;
        controller.signal.throwIfAborted();
        controller.submitted = true;
        await cdpRead.run(null, () => AgentContext.prototype.tapCss.call({ cdp }, pos.x, pos.y));
        attempt.count++;
        for (const [deviceId, setting] of settings) publishDesktopState(deviceId, { t: 'codexRetryState', sel: setting.sel, count: attempt.count, limit });
      } finally { cdp.close(); }
    })).catch(error => {
      if (!controller.signal.aborted) for (const [deviceId, setting] of settings) publishDesktopState(deviceId, { t: 'codexRetryState', sel: setting.sel, count: attempt.count, limit, error: error.message });
    }).finally(() => { this.retrying = this.retryController = null; this.read(true).catch(() => {}); });
  }
  async stopRetry() {
    if (this.retryController?.submitted) await this.retrying;
    else this.retryController?.abort(new Error('自动重试已停止'));
    for (const attempt of this.retryAttempts.values()) attempt.ready = false;
  }
  close(error = new Error('原生窗口已关闭')) {
    if (windows.get(this.cdp.wsUrl) !== this) return;
    windows.delete(this.cdp.wsUrl);
    this.reading?.controller.abort(error);
    this.receiptRead?.controller.abort(error);
    this.stopWatch?.();
    this.observer?.close();
    const clients = [...this.clients];
    this.clients.clear();
    for (const client of clients) client.onclose?.(error);
    this.listeners.clear();
    for (const request of this.sends.values()) request.finish(null, error.message, true);
    this.sends.clear();
    this.retrySettings.clear();
    this.cdp.close();
  }
}

export function startNativeWindows(listWindows) {
  discover = listWindows;
  const scan = async () => {
    if (discovering) return;
    discovering = (async () => {
      targets = (await discover()).filter(win => win.ws && win.app !== 'fusion');
      for (const win of targets) {
        let source = windows.get(win.ws);
        if (!source) windows.set(win.ws, source = new NativeWindow(win.ws));
        source.start(win).catch(() => {});
      }
    })().catch(() => {}).finally(() => { discovering = null; discoveryAt = Date.now(); });
    return discovering;
  };
  scan();
  return setInterval(() => {
    if (Date.now() - discoveryAt >= 5000) scan();
    for (const source of windows.values()) {
      if (source.sends.size) source.readReceipts().catch(() => {});
      if (source.win && Date.now() - source.updatedAt >= source.interval()) source.read().catch(() => {});
    }
  }, 1000).unref();
}
