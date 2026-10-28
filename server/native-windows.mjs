import { Cdp, cdpRead, awaitCdpRead } from './cdp.mjs';
import { watchChat } from './agent/updates.mjs';
import { PAGE_SRC } from './page/build.mjs';
import { editorRoots } from '../lib/files.mjs';

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

export class NativeWindow {
  constructor(url) {
    this.cdp = new Cdp(url);
    this.clients = new Set();
    this.listeners = new Set();
    this.sends = new Map();
    this.claimed = new Set();
    this.focus = new Set();
    this.revision = 0;
    this.updatedAt = 0;
    this.catalogAt = 0;
    this.queue = Promise.resolve();
    this.itemCache = new Map();
    this.cdp.onclose = () => this.close();
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
        this.read().catch(() => {});
      });
      await this.read();
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
  async read(fresh = false) {
    if (this.reading) return awaitCdpRead(this.reading.promise);
    if (!fresh && this.snapshot && this.readRevision === this.revision && Date.now() - this.updatedAt < this.interval()) return this.snapshot;
    const revision = this.revision, controller = new AbortController();
    const read = { controller };
    const app = this.win?.app;
    const receiptWanted = app === 'codex' && this.sends.size > 0;
    const pendingThreads = [...new Set([...this.sends.values()].map(request => request.thread).filter(Boolean))];
    read.promise = cdpRead.run(controller.signal, async () => {
      await this.connect();
      const result = await this.cdp.evaluate(`(() => {
        const h = ${PAGE_SRC};
        const chat = h.extract(false, [], ${app === 'codex' ? 80 : 0});
        const receipt = ${receiptWanted ? 'h.codexSendState()' : 'null'};
        const errors = window.__remoteAgentSubmitErrors || [];
        window.__remoteAgentSubmitErrors = [];
        return { chat, activeTab: h.activeChatTab(), states: h.agentStates(),
          receipt, errors,
          receipts: ${receiptWanted ? `${JSON.stringify(pendingThreads)}.filter(thread => thread !== receipt.thread).map(thread => h.codexSendState(false, thread))` : '[]'},
          surface: h.devinSurface(), catalog: ${app === 'codex' ? 'h.codexChatRows(true)' : 'h.agentList()'},
        };
      })()`);
      controller.signal.throwIfAborted();
      this.catalog = result.catalog || [];
      this.catalogAt = Date.now();
      const key = JSON.stringify(result);
      const changed = key !== this.snapshotKey;
      this.snapshotKey = key;
      this.snapshot = result;
      this.readRevision = revision;
      this.updatedAt = Date.now();
      this.confirmSends(result);
      if (changed) for (const notify of this.listeners) notify();
      return result;
    }).finally(() => {
      if (this.reading === read) {
        this.reading = null;
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
    this.sends.set(request.requestId, { ...request, finish });
    this.revision++;
    this.updatedAt = 0;
    this.read(true).catch(() => {});
    return () => this.sends.delete(request.requestId);
  }
  confirmSends(result) {
    const claimed = this.claimed;
    for (const [id, request] of this.sends) {
      const state = result.receipts?.find(state => state.thread === request.thread) || result.receipt;
      if (!state || request.thread && state.thread !== request.thread) continue;
      const matches = row => !request.before.has(row.id) && !claimed.has(row.id)
        && !row.nativeIds?.some(id => request.beforeQueues.has(id) || claimed.has(id))
        && (request.expected ? row.t.trim() === request.expected : request.hasAttachments);
      const messages = state.messages.filter(matches);
      const queued = state.queued.filter(row => !request.beforeQueues.has(row.id) && !claimed.has(row.id)
        && (request.expected ? row.t.trim() === request.expected : request.hasAttachments));
      if (messages.length + queued.length === 1) {
        const row = queued[0] || messages[0];
        claimed.add(row.id);
        for (const nativeId of row.nativeIds || []) claimed.add(nativeId);
        while (claimed.size > 400) claimed.delete(claimed.values().next().value);
        this.sends.delete(id);
        request.finish({ queued: !!queued.length, ...(queued.length
          ? { queueId: row.id, ...(row.messageId ? { messageId: row.messageId } : {}) }
          : { messageId: row.i }) });
      } else {
        const error = result.errors?.find(error => error.requestId === id);
        if (error) { this.sends.delete(id); request.finish(null, error.message); }
      }
    }
  }
  close() {
    if (windows.get(this.cdp.wsUrl) !== this) return;
    windows.delete(this.cdp.wsUrl);
    this.reading?.controller.abort(new Error('原生窗口已关闭'));
    this.stopWatch?.();
    this.observer?.close();
    const clients = [...this.clients];
    this.clients.clear();
    for (const client of clients) client.onclose?.();
    this.listeners.clear();
    this.sends.clear();
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
    for (const source of windows.values()) if (source.win && Date.now() - source.updatedAt >= source.interval()) source.read().catch(() => {});
  }, 1000).unref();
}
