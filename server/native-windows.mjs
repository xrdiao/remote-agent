import { localFilePath, samePath } from '../lib/platform.mjs';
import { Cdp, cdpRead, awaitCdpRead } from './cdp.mjs';
import { watchChat } from './agent/updates.mjs';
import { PAGE_SRC, helpersCall } from './page/build.mjs';
import { editorRoots } from '../lib/files.mjs';
import { bindOperation, publishDesktopState, withOperation } from './operations.mjs';
import { tapCss } from './agent/primitives.mjs';
import { projectSessionIds, reconcileSessionCatalog, updateProjectWindowTargets } from './project-windows.mjs';
import { codexSessionStates } from './windows.mjs';
import { rememberSessionStatuses, sessionId } from '../lib/session-library.mjs';

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
  if (error) {
    const read = catalogReads.get(app);
    if (read) read.error = error;
    console.error(`[catalog:${app}] ${error.message}`);
  }
  for (const changed of catalogListeners.get(app) || []) changed(error);
});
async function readCodexCatalog(source, ids) {
  const catalog = { ready: true, complete: false, rows: [], removed: [], unknown: [] };
  const page = async request => {
    try {
      return await source.cdp.evaluate(helpersCall(`nativeSessionInfo('codex', ${JSON.stringify(request)}, true)`));
    } catch (error) {
      throw new Error(`${source.win.id} ${request.threads ? '核验会话 ' + request.ids.join(',') : '目录分页 ' + (request.cursor || '首页')}：${error.message}`, { cause: error });
    }
  };
  let cursor = null;
  do {
    const result = await page({ cursor });
    if (!result.ready) return result;
    catalog.rows.push(...result.rows);
    cursor = result.nextCursor;
  } while (cursor);
  const active = new Set(catalog.rows.map(row => row.id)), missing = ids.filter(id => !active.has(id));
  for (let i = 0; i < missing.length; i += 6) {
    const result = await page({ threads: true, ids: missing.slice(i, i + 6) });
    if (!result.ready) return result;
    for (const key of ['rows', 'removed', 'unknown']) catalog[key].push(...result[key]);
  }
  return catalog;
}
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
async function refreshSessionCatalog(source, changed, background = false) {
  const app = source.win?.app;
  if (!['cursor', 'devin', 'codex'].includes(app)) return;
  if (!catalogReads.has(app)) catalogReads.set(app, { at: 0 });
  const read = catalogReads.get(app);
  if (read.promise) {
    if (!background && read.partial) {
      await read.promise;
      return refreshSessionCatalog(source, changed);
    }
    if (changed) read.pending = { source, background };
    return read.promise;
  }
  if (!changed && read.catalog && Date.now() - read.at < 15000) return;
  const candidates = app === 'devin' ? [...new Set([source, ...[...windows.values()].filter(window => window.win?.app === app)])] : [source];
  const deferred = background ? candidates.filter(window => window.foregroundReads) : [];
  for (const window of deferred) window.deferBackgroundRead('session-catalog', () => refreshSessionCatalog(window, true, true), null)
    .catch(error => { if (windows.get(window.cdp.wsUrl) === window) publishCatalog(app, error); });
  const sources = candidates.filter(window => !deferred.includes(window));
  if (!sources.length) return;
  read.partial = deferred.length > 0;
  read.at = Date.now();
  read.promise = (async () => {
    const ids = projectSessionIds(app);
    if (app === 'devin') for (const window of sources) {
      const id = sessionId(app, window.thread);
      if (id && !ids.includes(id)) ids.push(id);
    }
    const results = await Promise.allSettled(sources.map(async window => {
      await window.connect();
      if (app === 'codex') return readCodexCatalog(window, ids);
      const result = await window.cdp.evaluate(helpersCall(`nativeSessionInfo(${JSON.stringify(app)}, ${JSON.stringify(ids)}, true)`), { timeout: 30000 });
      if (app === 'devin' && result.ready) {
        const observedAt = result.at;
        window.devinCatalog = new Map(result.rows.map(row => [row.id, { ...row, observedAt }]));
      }
      return result;
    }));
    if (results.every(result => result.status === 'rejected')) throw results[0].reason;
    const catalogs = results.map(result => result.status === 'fulfilled' ? result.value : { ready: false });
    // A deferred renderer is unavailable for this scan, so partial reads cannot
    // establish that a Devin session is absent from every native directory.
    const catalog = app === 'devin' ? mergeDevinCatalogs([...catalogs, ...deferred.map(() => ({ ready: false }))]) : catalogs[0];
    if (!catalog.ready) return;
    if (deferred.length && read.catalog) {
      const seen = new Set([...catalog.rows.map(row => row.id), ...catalog.removed]);
      // Deferring one renderer must not erase its last published directory rows.
      catalog.rows.push(...read.catalog.rows.filter(row => !seen.has(row.id)));
    }
    catalog.observedAt = Date.now();
    catalog.rows = catalog.rows.map(row => row.host || !row.workspace ? row : { ...row, workspace: localFilePath(row.workspace) });
    if (app === 'codex' && catalog.unknown?.length) {
      const states = await codexSessionStates(catalog.unknown, catalog.rows.map(row => row.path).filter(Boolean));
      for (const [id, state] of states) {
        if (state === 'deleted') catalog.removed.push(id);
        else catalog.rows.push({ id, archived: state === 'archived' });
      }
    }
    const first = !read.catalog, recovered = !!read.error, reconciled = reconcileSessionCatalog(app, catalog);
    for (const id of [...(catalog.removed || []), ...catalog.rows.filter(row => row.archived).map(row => row.id)])
      for (const window of windows.values()) if (window.win?.app === app) window.forgetSession(id);
    read.catalog = catalog;
    read.error = null;
    if (first || changed || reconciled || recovered) publishCatalog(app);
  })().catch(error => publishCatalog(app, error)).finally(() => {
    read.promise = null;
    read.partial = false;
    const pending = read.pending;
    read.pending = null;
    if (pending) refreshSessionCatalog(pending.source, true, pending.background).catch(error => publishCatalog(app, error));
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
export function cursorSource(thread, project = null) {
  let selected, updatedAt = 0;
  for (const source of windows.values()) {
    if (source.win?.app !== 'cursor') continue;
    if (!source.roots?.length && source.snapshot?.chat?.thread !== thread) continue;
    if (project && !source.roots?.some(root => (root.host || '') === (project.host || '') && samePath(root.root, project.root, !project.host))) continue;
    const state = source.snapshot?.states.find(row => row.thread === thread);
    if (state?.nativeUpdatedAt > updatedAt) { selected = source; updatedAt = state.nativeUpdatedAt; }
  }
  return selected;
}
export async function devinSource(thread, preferred = '', project = null) {
  const id = sessionId('devin', thread);
  const sources = [...windows.values()].filter(source => source.win?.app === 'devin' && source.cdp.ws?.readyState === 1);
  const choose = candidates => candidates.find(source => source.win.id === preferred)
    || candidates.find(source => source.thread === id) || candidates[0];
  const confirmed = () => choose(sources.filter(source => {
    const row = source.devinCatalog?.get(id);
    return row?.workspace && !row.archived && (!project || samePath(row.workspace, project.root));
  }));
  const cached = confirmed();
  if (cached || !sources.length) return cached;
  if (id.startsWith('acp/devin-cli/')) {
    await awaitCdpRead(refreshSessionCatalog(choose(sources), true));
    return confirmed();
  }
  return choose(sources.filter(source => source.thread === id || source.catalog?.some(row => row.id === id)));
}
export const nativeWindowAt = url => windows.get(url);
function liveReadWindow(url, app, pageId) {
  const source = nativeWindowAt(url);
  if (!pageId || !source || source.cdp.ws?.readyState !== WebSocket.OPEN) return;
  const id = value => value?.startsWith(app + ':') ? value.slice(app.length + 1) : value;
  const matches = win => win?.app === app && id(win.pageId || win.id) === id(pageId);
  if (source.win) {
    if (source.win.ws === url && matches(source.win)) return source;
  } else if ((!source.app || source.app === app) && targets.some(win => win.editorWs === url && matches(win))) {
    // A Codex workbench and its chat webview have different CDP targets.
    return source;
  }
}

export async function withNativeWindowRead(url, app, pageId, read) {
  cdpRead.getStore()?.throwIfAborted();
  const source = liveReadWindow(url, app, pageId);
  if (source) return read(source.cdp);
  const cdp = new Cdp(url);
  try {
    await cdp.connect();
    return await read(cdp);
  } finally { cdp.close(); }
}

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
    this.codexOwners = new Map();
    this.contexts = new Map();
    this.foregroundLeases = new Set();
    this.backgroundReads = new Map();
    this.cdp.on('Runtime.executionContextCreated', ({ context }) => this.contexts.set(context.id, context));
    this.cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => this.contexts.delete(executionContextId));
    this.cdp.onclose = error => this.close(error);
    this.cdp.on('Runtime.executionContextsCleared', () => {
      this.contexts.clear();
      this.nativeApi = null;
      this.devinCatalog = null;
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
      if (!this.nativeApi) {
        const loading = cdpRead.run(null, async () => {
          await this.cdp.send('Runtime.enable');
          await this.cdp.evaluate(`(async () => {
            const map = () => [...document.querySelectorAll('script[type="importmap"]')].some(script => script.textContent.includes('@exa/chat-client'));
            const deadline = Date.now() + 8000;
            while (!map() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
            if (!map()) throw new Error('Devin 原生会话模块尚未就绪');
            window.__remoteAgentDevinNative = await import('@exa/chat-client');
          })()`);
        }).catch(error => {
          if (this.nativeApi === loading) this.nativeApi = null;
          throw error;
        });
        this.nativeApi = loading;
      }
      return this.nativeApi;
    });
  }
  async composerCall(call, context) {
    await this.connect();
    // A living old execution context does not prove that it still owns the
    // native webview. Resolve this exact window's current frame for every call.
    await this.cdp.send('Runtime.enable', {}, 3000);
    // DOM.getDocument invalidates frontend node IDs used by concurrent calls.
    const { result, exceptionDetails } = await this.cdp.send('Runtime.evaluate', {
      expression: "document.querySelector('#active-frame')",
    }, 3000);
    if (exceptionDetails || !result.objectId) throw new Error('当前 Codex 原生窗口没有就绪的会话 frame');
    let node;
    try {
      ({ node } = await this.cdp.send('DOM.describeNode', { objectId: result.objectId }, 3000));
    } finally {
      await cdpRead.run(null, () => this.cdp.send('Runtime.releaseObject', { objectId: result.objectId }, 3000)).catch(() => {});
    }
    const realms = [...this.contexts.values()].filter(value => value.auxData?.isDefault && value.auxData.frameId === node.frameId);
    if (realms.length !== 1) throw new Error('Codex 原生会话 frame 身份尚未唯一确认');
    const realm = this.composerRealm = realms[0].id;
    const check = context?.threadId ? `
      const expected = ${JSON.stringify(context)};
      let timer;
      const actual = await Promise.race([
        ${helpersCall("nativeSessionInfo('codex', " + JSON.stringify(context.threadId) + ", 'context')", context.host === undefined ? null : context)},
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Codex 会话身份核对超时')), 3000); }),
      ]).finally(() => clearTimeout(timer));
      if (actual?.app !== 'codex' || actual.threadId !== expected.threadId
          || expected.host !== undefined && (actual.host || '') !== (expected.host || '')
          || expected.cwd !== undefined && actual.cwd !== expected.cwd
          || expected.roots !== undefined && JSON.stringify(actual.roots) !== JSON.stringify(expected.roots))
        throw new Error('Codex 原生 frame 中的会话或项目与请求 Binding 不一致');` : '';
    return this.cdp.evaluate(`(async () => {
      const exactDocument = document, exactFrame = window.frameElement;
      ${check}
      if (document !== exactDocument || window.closed
          || exactFrame && (!exactFrame.isConnected || exactFrame.contentDocument !== exactDocument || exactFrame.contentWindow !== window))
        throw new Error('Codex 原生会话 frame 已更换，操作未提交');
      return ${helpersCall(call, context)};
    })()`, { contextId: realm, timeout: 15000 });
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
      this.deferBackgroundRead('startup-catalog', async () => {
        if (win.app === 'codex') await this.cdp.evaluate(helpersCall("nativeSessionInfo('codex', '', 'refreshCatalog')"));
        await refreshSessionCatalog(this, false, true);
      }, null).catch(error => { if (windows.get(this.cdp.wsUrl) === this) publishCatalog(win.app, error); });
      const observer = this.observer = new NativeCdp(this.cdp.wsUrl);
      this.stopWatch = await watchChat(observer, () => {
        this.revision++;
        this.readReceipts().catch(() => {});
        this.readInBackground().catch(() => {});
      }, win.app === 'codex');
      this.readInBackground().catch(() => {});
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
      if (value.status) rememberSessionStatuses([{ ...value.status, app: this.win.app, threadId }]);
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
  get foregroundReads() { return this.foregroundLeases.size; }
  beginForegroundRead(signal) {
    if (signal?.aborted) return () => {};
    const release = () => {
      if (!this.foregroundLeases.delete(release)) return;
      signal?.removeEventListener('abort', release);
      if (this.foregroundReads || !this.backgroundReads.size || this.backgroundFlush) return;
      // A newer foreground read may have overtaken the previous scheduled flush.
      // Give deferred work the next actual idle boundary in that case.
      if (this.backgroundFlushMissed) return this.flushBackgroundReads();
      this.backgroundFlush = setImmediate(() => {
        this.backgroundFlush = null;
        if (this.foregroundReads) this.backgroundFlushMissed = true;
        else this.flushBackgroundReads();
      });
    };
    this.foregroundLeases.add(release);
    signal?.addEventListener('abort', release, { once: true });
    return release;
  }
  async deferBackgroundRead(key, action, signal = cdpRead.getStore()) {
    signal?.throwIfAborted();
    if (windows.get(this.cdp.wsUrl) !== this) return;
    const previous = this.backgroundReads.get(key);
    if (previous) return awaitCdpRead(previous.promise);
    if (!this.foregroundReads) return cdpRead.run(signal, action);
    const job = {};
    const execute = bindOperation(action);
    const cleanup = () => {
      this.backgroundReads.delete(key);
      signal?.removeEventListener('abort', cancel);
    };
    const cancel = () => job.cancel(signal.reason);
    job.promise = new Promise((resolve, reject) => {
      job.cancel = error => { cleanup(); reject(error); };
      job.run = () => {
        cleanup();
        try { resolve(cdpRead.run(signal, execute)); }
        catch (error) { reject(error); }
      };
    });
    this.backgroundReads.set(key, job);
    signal?.addEventListener('abort', cancel, { once: true });
    return job.promise;
  }
  startBackgroundRead(key) {
    this.backgroundReads.get(key)?.run();
  }
  flushBackgroundReads() {
    this.backgroundFlushMissed = false;
    for (const key of this.backgroundReads.keys()) {
      if (this.foregroundReads) break;
      this.startBackgroundRead(key);
    }
  }
  readInBackground() {
    // Leave live transcript subscribers, running turns and receipt tracking
    // independent of first-screen priority.
    if (this.listeners.size || this.sends.size || this.snapshot?.chat?.busy || this.snapshot?.states?.some(state => state.busy))
      return this.read();
    return this.deferBackgroundRead('snapshot', () => this.read(), null);
  }
  invalidate() {
    this.revision++;
    this.updatedAt = 0;
    this.reading?.controller.abort(new Error('原生窗口内容已切换'));
    this.reading = null;
  }
  rememberCodexOwner(id, owner, pageId, revision) {
    if (revision !== this.revision) return;
    this.codexOwners.delete(id);
    if (owner?.role !== 'owner') return;
    this.codexOwners.set(id, { value: owner, pageId, revision, at: Date.now() });
    if (this.codexOwners.size > 16) this.codexOwners.delete(this.codexOwners.keys().next().value);
  }
  cachedCodexOwner(id, pageId) {
    const seen = this.codexOwners.get(id);
    if (seen?.pageId === pageId && this.cdp.ws?.readyState === 1 && seen.revision === this.revision
        && Date.now() - seen.at < this.interval()) return seen.value;
  }
  setThread(thread) {
    if (this.thread === thread) return;
    this.thread = thread;
    this.invalidate();
  }
  overviewStates(threadId) {
    const rows = this.snapshot?.states || [];
    const states = new Map((threadId ? rows.filter(row => row.thread === threadId) : rows).map(row => [row.thread, row]));
    if (this.win?.app === 'codex') for (const view of this.conversations.values()) {
      const state = view.snapshot?.state;
      if (!state?.thread || threadId && threadId !== state.thread || view.at < this.updatedAt && states.has(state.thread)) continue;
      states.set(state.thread, { ...states.get(state.thread), ...state, observedAt: view.at });
    }
    const runs = threadId ? (this.runStates.has(threadId) ? [[threadId, this.runStates.get(threadId)]] : []) : this.runStates;
    for (const [thread, run] of runs) if (!states.get(thread)?.run) {
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
  forgetSession(id) {
    this.devinCatalog?.delete(id);
    this.previews.delete(id);
    this.runStates.delete(id);
    this.itemCache.delete(id);
    for (const [key, view] of this.conversations) if (JSON.parse(key)[1] === id) {
      view.revision++;
      view.snapshot = null;
      view.key = null;
      if (!view.listeners.size && !view.management.size) this.conversations.delete(key);
    }
  }
  async readConversation(context, fresh = false) {
    const view = this.conversationView(context);
    if (view.reading) return awaitCdpRead(view.reading);
    if (!fresh && view.snapshot && view.readRevision === view.revision) return view.snapshot;
    const revision = view.revision;
    view.reading = cdpRead.run(null, async () => {
      await this.connect();
      const chat = await this.cdp.evaluate(helpersCall(`extract(false, [], ${context.app === 'codex' ? 120 : 0})`, context));
      const composer = chat && context.app === 'codex'
        ? await this.composerCall(`nativeSessionInfo('codex', ${JSON.stringify(context.threadId)}, 'composer')`, context) : null;
      if (chat && composer) chat.codex = { ...chat.codex,
        run: composer.composerMode[0].toUpperCase() + composer.composerMode.slice(1),
        ide: { on: composer.isAutoContextOn, file: composer.ideContext?.activeFile || null } };
      if (chat && composer) chat.draft = composer.prompt;
      const state = chat?._nativeState;
      if (chat) delete chat._nativeState;
      const result = { chat, state }, key = JSON.stringify(result), changed = view.key !== key;
      if (state) rememberSessionStatuses([{ ...state, app: context.app, threadId: state.thread }]);
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
        const chat = await h.extract(false, [], ${app === 'codex' ? 120 : 0}, ${app === 'cursor'});
        const activeTab = h.activeChatTab(), states = h.agentStates(${JSON.stringify(app)});
        ${app === 'cursor' ? "for (const state of states) state.nativeUpdatedAt = h.nativeSessionInfo('cursor', state.thread, 'connection')?.updatedAt || 0;" : ''}
        return { chat, activeTab, states,
          surface: h.devinSurface(),
          ${app === 'codex' ? "owner: chat?.thread && h.codexThread() === chat.thread && h.nativeSessionInfo('codex', chat.thread, 'owner')," : ''}
        };
      })()`);
      controller.signal.throwIfAborted();
      if (app === 'codex') {
        const { owner, chat } = result;
        if (chat?.thread) this.rememberCodexOwner(chat.thread, owner && { ...owner, role: 'owner', visible: true },
          this.win.pageId, revision);
        delete result.owner;
      }
      rememberSessionStatuses((result.states || []).map(state => ({ ...state, app, threadId: state.thread })));
      for (const state of result.states || []) if (state.run && state.run.status !== 'unknown') this.runStates.set(state.thread, state.run);
      if (fresh && !this.catalogDeferred) {
        // Resolve and publish the real first-screen read before scheduling the
        // next native catalog evaluation on the same renderer.
        this.catalogDeferred = setImmediate(() => {
          this.catalogDeferred = null;
          if (windows.get(this.cdp.wsUrl) === this && this.win?.app === app)
            this.readCatalog().catch(error => publishCatalog(app, error));
        });
        this.catalogDeferred.unref?.();
      } else if (!fresh && !this.catalogDeferred) this.readCatalog().catch(error => publishCatalog(app, error));
      const key = JSON.stringify(result);
      const changed = key !== this.snapshotKey;
      this.snapshotKey = key;
      this.snapshot = result;
      this.thread = result.chat?.thread;
      this.readError = null;
      this.readRevision = revision;
      this.updatedAt = Date.now();
      if (changed) withOperation(null, () => { for (const notify of this.listeners) notify(); });
      if (changed && app === 'cursor') withOperation(null, () => {
        for (const source of windows.values()) {
          if (source === this || source.win?.app !== 'cursor') continue;
          const thread = source.snapshot?.chat?.thread;
          const previous = source.snapshot?.states.find(row => row.thread === thread)?.nativeUpdatedAt || 0;
          if (result.states.some(row => row.thread === thread && row.nativeUpdatedAt > previous))
            for (const notify of source.listeners) notify();
        }
      });
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
        if (!controller.signal.aborted && revision !== this.revision) {
          this.readInBackground().catch(() => {});
        }
      }
    });
    this.reading = read;
    return awaitCdpRead(read.promise);
  }
  readCatalog() {
    if (this.foregroundReads) return this.deferBackgroundRead('window-catalog', () => this.readCatalog(), null);
    // Native catalog reads can take hundreds of milliseconds on a busy renderer.
    // Chat snapshots do not imply a changed catalog: coalesce the frequent
    // observer-triggered reads while direct user catalog requests stay fresh.
    if (['cursor', 'devin', 'codex'].includes(this.win?.app) && this.catalogAt && this.catalog) {
      const age = Date.now() - this.catalogAt;
      if (age < 900) {
        // A native event received during this window still needs a refresh
        // after the coalescing period, even if no further events arrive.
        if (!this.catalogTimer) {
          this.catalogTimer = setTimeout(() => {
            this.catalogTimer = null;
            this.readCatalog().catch(error => publishCatalog(this.win.app, error));
          }, Math.max(1, 900 - age));
          this.catalogTimer.unref?.();
        }
        return this.catalogReading || Promise.resolve(this.catalog);
      }
    }
    if (this.catalogTimer) { clearTimeout(this.catalogTimer); this.catalogTimer = null; }
    if (this.catalogReading) { this.catalogAgain = true; return this.catalogReading; }
    const app = this.win.app;
    this.catalogReading = cdpRead.run(null, async () => {
      await this.connect();
      const catalog = await this.cdp.evaluate(helpersCall(app === 'codex' ? 'codexChatRows(true)'
        : app === 'devin' ? 'sessionPickerRows(true)' : "nativeSessionInfo('cursor', '', 'list')")).catch(error => {
          throw new Error(`${this.win.id} 窗口会话列表：${error.message}`, { cause: error });
        });
      if (catalog === null) return;
      // A workbench can reuse the same CDP target after opening a project.
      // Its initial roots are no longer evidence of window ownership.
      let changedRoots = false, rootsError;
      if (app === 'cursor') {
        try {
          const roots = await editorRoots(this.cdp, app);
          changedRoots = JSON.stringify(roots) !== JSON.stringify(this.roots);
          this.roots = roots; this.rootsError = null;
        } catch (error) {
          changedRoots = this.roots !== undefined;
          this.roots = undefined; this.rootsError = error.message; rootsError = error;
        }
      }
      for (const row of catalog) if (!row.host && row.workspace) row.workspace = localFilePath(row.workspace);
      this.catalog = catalog;
      this.catalogAt = Date.now();
      const key = JSON.stringify(catalog.map(row => [row.id, row.title, row.workspace, row.host, row.current, row.running]));
      const changed = this.catalogKey != null && this.catalogKey !== key;
      this.catalogKey = key;
      if (changedRoots || rootsError) publishCatalog(app, rootsError);
      await refreshSessionCatalog(this, changed, true);
    }).finally(() => {
      this.catalogReading = null;
      if (this.catalogAgain) { this.catalogAgain = false; this.readCatalog().catch(error => publishCatalog(app, error)); }
    });
    return this.catalogReading;
  }
  interval() { return this.listeners.size || this.sends.size || this.snapshot?.states?.some(s => s.busy) ? 1800 : 15000; }
  run(action) {
    const result = this.queue.then(() => { cdpRead.getStore()?.throwIfAborted(); this.invalidate(); return action(); });
    this.queue = result.catch(() => {});
    return result;
  }
  registerSend(request, finish) {
    const row = { ...request, finish: bindOperation(finish) };
    const unregister = () => {
      if (this.sends.get(request.requestId) !== row) return false;
      this.sends.delete(request.requestId);
      clearTimeout(deadline);
      return true;
    };
    row.settle = (accepted, error, outcome) => {
      if (unregister()) row.finish(accepted, error, outcome);
    };
    const deadline = setTimeout(() => row.settle(null, '尚未读到本次发送的 Codex 原生回执', 'unknown'), 60000);
    deadline.unref();
    this.sends.set(request.requestId, row);
    this.revision++;
    this.updatedAt = 0;
    this.readReceipts().catch(() => {});
    return unregister;
  }
  async readReceipts() {
    if (this.win?.app !== 'codex' || !this.sends.size) return;
    if (this.receiptRead) {
      this.receiptAgain = true;
      return this.receiptRead.promise;
    }
    const requests = [...this.sends.values()].map(({ requestId, thread, afterTurn, trackClientId }) => ({ requestId, thread, afterTurn, trackClientId }));
    const read = { controller: new AbortController() };
    read.promise = cdpRead.run(read.controller.signal, async () => {
      await this.connect();
      const result = await this.cdp.evaluate(`(() => {
        const h = ${PAGE_SRC};
        const receipts = ${JSON.stringify(requests)}.map(request => ({
          ...h.codexSendState(false, request.thread || undefined, request.afterTurn), requestId: request.requestId,
          clientId: request.trackClientId ? h.nativeSessionInfo('codex', request.thread, 'dispatchClientId', request.requestId) : null,
          firstThread: request.thread ? null : h.nativeSessionInfo('codex', request.requestId, 'firstSubmission'),
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
        request.finish(null, error.message, 'pending');
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
      const receiptId = state.clientId && `${request.thread}:user-message:${state.clientId}`;
      const owns = (id, ids, text, expected) => request.trackClientId
        ? !!receiptId && (id === receiptId || ids?.includes(state.clientId))
        : expected ? text.trim() === expected : request.hasAttachments;
      const matches = row => !request.before.has(row.id) && !claimed.has(row.id)
        && !row.nativeIds?.some(id => request.beforeQueues.has(id) || claimed.has(id))
        && owns(row.i, row.nativeIds, row.t, request.expected);
      const messages = new Map(state.messages.filter(matches).map(row => [row.i, row]));
      if (request.action === 'send') for (const run of state.runs || []) {
        if (!request.beforeTurns.has(run.id) && !claimed.has(run.id)
            && owns(run.i, run.nativeIds, run.t, request.expected)) messages.set(run.i, run);
      }
      // Steer can temporarily occupy the native admission queue. Only an
      // accepted user message confirms Steer; a queue row cannot confirm it.
      const queued = request.action === 'steer' ? [] : state.queued.filter(row => !request.beforeQueues.has(row.id) && !claimed.has(row.id)
        && owns(row.messageId, null, row.t, request.queueExpected));
      if (messages.size + queued.length === 1 && (request.thread || state.turnCount === 1
          && state.firstThread && state.firstThread === state.thread)) {
        const row = queued[0] || messages.values().next().value;
        claimed.add(row.id);
        for (const nativeId of row.nativeIds || []) claimed.add(nativeId);
        while (claimed.size > 400) claimed.delete(claimed.values().next().value);
        request.settle({ queued: !!queued.length, thread: state.thread, ...(queued.length
          ? { queueId: row.id, ...(row.messageId ? { messageId: row.messageId } : {}) }
          : { messageId: row.i }) });
      } else {
        const error = result.errors?.find(error => error.requestId === id);
        if (error) request.settle(null, error.message);
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
        await cdpRead.run(null, () => tapCss(cdp, pos.x, pos.y));
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
    const count = targets.length;
    targets = targets.filter(target => target.ws !== this.cdp.wsUrl);
    if (targets.length !== count && this.win?.app) publishCatalog(this.win.app);
    this.reading?.controller.abort(error);
    if (this.catalogDeferred) clearImmediate(this.catalogDeferred);
    this.catalogDeferred = null;
    clearTimeout(this.catalogTimer);
    this.catalogTimer = null;
    clearImmediate(this.backgroundFlush);
    this.backgroundFlush = null;
    for (const job of this.backgroundReads.values()) job.cancel(error);
    for (const release of this.foregroundLeases) release();
    this.receiptRead?.controller.abort(error);
    this.stopWatch?.();
    this.observer?.close();
    const clients = [...this.clients];
    this.clients.clear();
    for (const client of clients) client.onclose?.(error);
    this.listeners.clear();
    for (const request of this.sends.values()) request.settle(null, error.message, 'unknown');
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
      if (source.win && Date.now() - source.updatedAt >= source.interval()) source.readInBackground().catch(() => {});
    }
  }, 1000).unref();
}
