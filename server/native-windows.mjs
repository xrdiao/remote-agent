import { Cdp, cdpRead, awaitCdpRead } from './cdp.mjs';
import { watchChat } from './agent/updates.mjs';
import { PAGE_SRC, helpersCall } from './page/build.mjs';
import { editorRoots } from '../lib/files.mjs';
import { bindOperation, publishDesktopState, withOperation } from './operations.mjs';
import { AgentContext } from './agent/context.mjs';
import { projectSessionIds, reconcileSessionCatalog, updateProjectWindowTargets } from './project-windows.mjs';
import { codexSessionStates } from './windows.mjs';

// Native connections and read state belong to windows, not to a phone's current view.
const windows = new Map();
const catalogListeners = new Map(), catalogReads = new Map();
export const nativeSessionCatalog = app => catalogReads.get(app)?.catalog;
export function subscribeCatalog(app, changed) {
  if (!catalogListeners.has(app)) catalogListeners.set(app, new Set());
  const listeners = catalogListeners.get(app);
  listeners.add(changed);
  return () => listeners.delete(changed);
}
const publishCatalog = (app, error) => withOperation(null, () => {
  for (const changed of catalogListeners.get(app) || []) changed(error);
});
function mergeDevinCatalogs(catalogs) {
  const ready = catalogs.filter(catalog => catalog.ready), rows = new Map(), removedAt = {};
  for (const catalog of ready) {
    for (const row of catalog.rows) {
      const previous = rows.get(row.id);
      if (!previous || row.at > previous.at || row.at === previous.at && row.archived) rows.set(row.id, row);
    }
    for (const [id, at] of Object.entries(catalog.removedAt || {})) removedAt[id] = Math.max(removedAt[id] || 0, at);
  }
  if (catalogs.length === ready.length && ready.every(catalog => catalog.cliReady)) {
    const at = Math.min(...ready.map(catalog => catalog.at));
    for (const id of ready[0].missing) if (ready.every(catalog => catalog.missing.includes(id))) removedAt[id] = Math.max(removedAt[id] || 0, at);
  }
  return { ready: ready.length > 0, complete: false, rows: [...rows.values()], removed: Object.keys(removedAt), removedAt };
}
async function refreshSessionCatalog(source, changed) {
  const app = source.win?.app;
  if (!['cursor', 'devin', 'codex'].includes(app)) return;
  if (!catalogReads.has(app)) catalogReads.set(app, { at: 0 });
  const read = catalogReads.get(app);
  if (read.promise) {
    if (changed) read.pending = source;
    return read.promise;
  }
  if (!changed && read.catalog && Date.now() - read.at < 15000) return;
  read.at = Date.now();
  read.promise = (async () => {
    const sources = app === 'devin' ? [...new Set([source, ...[...windows.values()].filter(window => window.win?.app === app)])] : [source];
    const catalogs = await Promise.all(sources.map(async window => {
      await window.connect();
      return window.cdp.evaluate(helpersCall(`nativeSessionInfo(${JSON.stringify(app)}, ${JSON.stringify(projectSessionIds(app))}, true)`), { timeout: 30000 });
    }));
    const catalog = app === 'devin' ? mergeDevinCatalogs(catalogs) : catalogs[0];
    if (!catalog.ready) return;
    if (app === 'codex' && catalog.unknown?.length) {
      const states = await codexSessionStates(catalog.unknown, catalog.rows.map(row => row.path).filter(Boolean));
      for (const [id, state] of states) {
        if (state === 'deleted') catalog.removed.push(id);
        else catalog.rows.push({ id, archived: state === 'archived' });
      }
    }
    const first = !read.catalog, reconciled = reconcileSessionCatalog(app, catalog);
    read.catalog = catalog;
    if (first || changed || reconciled) publishCatalog(app);
  })().catch(error => publishCatalog(app, error)).finally(() => {
    read.promise = null;
    const pending = read.pending;
    read.pending = null;
    if (pending) refreshSessionCatalog(pending, true).catch(error => publishCatalog(app, error));
  });
  await read.promise;
}
let discover = null, discovering = null, discoveryAt = 0;
let targets = [];
export const nativeTargets = () => targets;

export class NativeCdp extends Cdp {
  constructor(url, app) {
    super(url);
    this.nativeWindow = windows.get(url);
    if (!this.nativeWindow) windows.set(url, this.nativeWindow = new NativeWindow(url));
    if (app) this.nativeWindow.app = app;
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
    this.previews = new Map();
    this.runStates = new Map();
    this.conversations = new Map();
    this.contexts = new Map();
    this.cdp.on('Runtime.executionContextCreated', ({ context }) => this.contexts.set(context.id, context));
    this.cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => this.contexts.delete(executionContextId));
    this.cdp.onclose = error => this.close(error);
    this.cdp.on('Runtime.executionContextsCleared', () => {
      this.contexts.clear();
      this.nativeApi = null;
      for (const view of this.conversations.values())
        for (const listener of [...view.listeners, ...view.management]) listener(new Error('原生页面已重载，需要核对后台会话与轮次'));
      if (!this.win) return;
      this.stopWatch?.();
      this.observer?.close();
      this.watching = null;
      this.invalidate();
      this.start(this.win).catch(() => {});
    });
  }
  connect() {
    const connecting = this.connecting ||= cdpRead.run(null, () => this.cdp.connect()).catch(error => {
      this.close();
      throw error;
    });
    return connecting.then(() => {
      if ((this.app || this.win?.app) !== 'devin') return;
      return this.nativeApi ||= cdpRead.run(null, () => this.cdp.evaluate(`(async () => {
        window.__remoteAgentDevinNative = await import('@exa/chat-client');
      })()`));
    });
  }
  async composerCall(call, context) {
    await this.connect();
    if (!this.contexts.has(this.composerRealm)) {
      this.composerRealmRead ||= (async () => {
        await this.cdp.send('Runtime.enable');
        const { root } = await this.cdp.send('DOM.getDocument');
        const { nodeId } = await this.cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#active-frame' });
        const { node } = await this.cdp.send('DOM.describeNode', { nodeId });
        this.composerRealm = [...this.contexts.values()].find(value => value.auxData.isDefault && value.auxData.frameId === node.frameId).id;
      })().finally(() => { this.composerRealmRead = null; });
      await this.composerRealmRead;
    }
    return this.cdp.evaluate(helpersCall(call, context), { contextId: this.composerRealm });
  }
  async start(win) {
    this.win = win;
    if (this.roots === undefined && !this.rootsRead) {
      const editor = new NativeCdp(win.editorWs || win.ws);
      this.rootsRead = cdpRead.run(null, async () => {
        await editor.connect();
        this.roots = await editorRoots(editor, win.app);
        this.rootsError = null;
      }).catch(error => { this.rootsError = error.message; }).finally(() => {
        editor.close();
        this.rootsRead = null;
        publishCatalog(win.app);
      });
    }
    if (this.watching) return this.watching;
    this.watching = cdpRead.run(null, async () => {
      await this.connect();
      refreshSessionCatalog(this, false).catch(error => publishCatalog(win.app, error));
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
  subscribe(changed, context = null, owner = null) {
    if (context) {
      const view = this.conversationView(context);
      const listeners = owner === 'fusion-control' ? view.management : view.listeners;
      listeners.add(changed);
      if (!view.watching) {
        const observer = view.observer = new NativeCdp(this.cdp.wsUrl);
        view.watching = cdpRead.run(null, () => watchChat(observer, () => {
          if (!view.listeners.size && !view.management.size) return;
          view.revision++;
          withOperation(null, () => { for (const listener of view.management) listener(); });
          if (view.listeners.size) {
            this.readReceipts().catch(() => {});
            this.readConversation(context).catch(() => {});
          }
        }, false, context)).then(stop => { view.stop = stop; }, error => {
          withOperation(null, () => { for (const listener of [...view.listeners, ...view.management]) listener(error); });
        });
      }
      return () => {
        listeners.delete(changed);
        if (!view.listeners.size && !view.management.size) {
          const watching = view.watching;
          watching?.then(() => { view.stop?.(); view.observer?.close(); });
          this.conversations.delete(JSON.stringify([context.host, context.threadId]));
        }
      };
    }
    this.listeners.add(changed);
    return () => this.listeners.delete(changed);
  }
  async preview(threadId, state = {}) {
    let entry = this.previews.get(threadId);
    if (entry?.flight) return entry.flight;
    if (entry?.at && Date.now() - entry.at < 3500) return entry.value;
    if (!entry) {
      this.previews.set(threadId, entry = {});
      if (this.previews.size > 12) this.previews.delete(this.previews.keys().next().value);
    }
    entry.flight = (async () => {
      await this.connect();
      const previous = !state.busy && state.lastUsed > 0 && entry.lastUsed === state.lastUsed ? entry.value : null;
      const value = await this.cdp.evaluate(helpersCall(`nativeSessionInfo(${JSON.stringify(this.win.app)}, ${JSON.stringify(threadId)}, 'preview', ${JSON.stringify(previous || null)})`), { timeout: 15000 });
      const chat = this.snapshot?.chat;
      if (chat?.thread === threadId) {
        value.model = chat.model || value.model;
        value.effort = chat.effort || value.effort;
      }
      const tasks = this.snapshot?.states?.find(row => row.thread === threadId)?.tasks;
      if (!value.tasks && tasks?.total > 0) value.tasks = tasks;
      entry.value = value;
      entry.lastUsed = state.lastUsed;
      entry.at = Date.now();
      return value;
    })().finally(() => { entry.flight = null; });
    return entry.flight;
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
  overviewStates() {
    const states = new Map((this.snapshot?.states || []).map(row => [row.thread, row]));
    for (const [thread, run] of this.runStates) if (!states.get(thread)?.run) {
      const observed = states.get(thread), known = run.status !== 'running';
      states.set(thread, { ...observed, thread, busy: !!observed?.busy,
        run: known ? run : { ...run, status: 'unknown' }, statusKnown: known });
    }
    return [...states.values()];
  }
  conversationView(context) {
    const key = JSON.stringify([context.host, context.threadId]);
    if (!this.conversations.has(key)) this.conversations.set(key, { revision: 0, at: 0, listeners: new Set(), management: new Set() });
    return this.conversations.get(key);
  }
  async readConversation(context, fresh = false) {
    const view = this.conversationView(context);
    if (view.reading) return awaitCdpRead(view.reading);
    if (!fresh && view.snapshot && view.readRevision === view.revision) return view.snapshot;
    const revision = view.revision;
    view.reading = cdpRead.run(null, async () => {
      await this.connect();
      const [chat, composer] = await Promise.all([
        this.cdp.evaluate(helpersCall(`extract(false, [], ${context.app === 'codex' ? 80 : 0})`, context)),
        context.app === 'codex' ? this.composerCall(`nativeSessionInfo('codex', ${JSON.stringify(context.threadId)}, 'composer')`, context) : null,
      ]);
      if (chat && composer) chat.codex = { ...chat.codex,
        run: composer.composerMode[0].toUpperCase() + composer.composerMode.slice(1),
        ide: { on: composer.isAutoContextOn, file: composer.ideContext?.activeFile || null } };
      const state = chat?._nativeState;
      if (chat) delete chat._nativeState;
      const result = { chat, state }, key = JSON.stringify(result), changed = view.key !== key;
      view.snapshot = result; view.key = key; view.readRevision = revision; view.at = Date.now();
      if (changed) withOperation(null, () => { for (const listener of view.listeners) listener(); });
      return result;
    }).catch(error => {
      withOperation(null, () => { for (const listener of view.listeners) listener(error); });
      throw error;
    }).finally(() => {
      view.reading = null;
      if (view.listeners.size && revision !== view.revision) this.readConversation(context).catch(() => {});
      if (!view.listeners.size && !view.management.size && this.conversations.get(JSON.stringify([context.host, context.threadId])) === view)
        this.conversations.delete(JSON.stringify([context.host, context.threadId]));
    });
    return awaitCdpRead(view.reading);
  }
  async read(fresh = false) {
    const wantedRevision = this.revision;
    while (this.reading) {
      const result = await awaitCdpRead(this.reading.promise);
      if (!fresh || this.readRevision >= wantedRevision) return result;
    }
    if (!fresh && this.snapshot && this.readRevision === this.revision && Date.now() - this.updatedAt < this.interval()) return this.snapshot;
    const revision = this.revision, controller = new AbortController();
    const read = { controller };
    const app = this.win?.app;
    read.promise = cdpRead.run(controller.signal, async () => {
      await this.connect();
      const result = await this.cdp.evaluate(`(async () => {
        const h = ${PAGE_SRC};
        const chat = await h.extract(false, [], ${app === 'codex' ? 80 : 0}, ${app === 'cursor'});
        return { chat, activeTab: h.activeChatTab(), states: h.agentStates(${JSON.stringify(app)}),
          surface: h.devinSurface(), catalog: ${app === 'codex' ? 'h.codexChatRows(true)' : app === 'devin' ? 'null' : "await h.nativeSessionInfo('cursor', '', 'list')"},
        };
      })()`);
      if (app === 'devin') result.catalog = await this.cdp.evaluate(helpersCall('sessionPickerRows(true)'));
      controller.signal.throwIfAborted();
      for (const state of result.states || []) if (state.run && state.run.status !== 'unknown') this.runStates.set(state.thread, state.run);
      this.catalog = result.catalog || [];
      this.catalogAt = Date.now();
      const catalogKey = JSON.stringify(this.catalog.map(row => [row.id, row.title, row.workspace, row.host, row.current, row.running]));
      const catalogChanged = this.catalogKey != null && catalogKey !== this.catalogKey;
      this.catalogKey = catalogKey;
      refreshSessionCatalog(this, catalogChanged).catch(error => publishCatalog(app, error));
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
        && (request.queueExpected ? row.t.trim() === request.queueExpected : request.hasAttachments));
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
    this.runStates.clear();
    for (const view of this.conversations.values()) { view.stop?.(); view.observer?.close(); }
    this.conversations.clear();
    this.cdp.close();
  }
}

export function startNativeWindows(listWindows) {
  discover = listWindows;
  const scan = async () => {
    if (discovering) return;
    discovering = (async () => {
      const previous = targets;
      targets = (await discover()).filter(win => win.ws && win.app !== 'fusion');
      updateProjectWindowTargets(targets);
      for (const win of targets) {
        let source = windows.get(win.ws);
        if (!source) windows.set(win.ws, source = new NativeWindow(win.ws));
        source.start(win).catch(() => {});
      }
      for (const app of ['cursor', 'devin', 'codex']) {
        const signature = rows => JSON.stringify(rows.filter(window => window.app === app).map(window => window.ws).sort());
        if (signature(previous) !== signature(targets)) publishCatalog(app);
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
