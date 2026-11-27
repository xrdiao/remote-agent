import { localFilePath } from '../../lib/platform.mjs';
import { editorRoots } from '../../lib/files.mjs';
import { lastSelection } from '../../lib/auth.mjs';
import { pendingUploads, updateUpload, uploads } from '../../lib/uploads.mjs';
import { Cdp, cdpRead } from '../cdp.mjs';
import { listWindows } from '../windows.mjs';
import { CODEX_CDP_URL } from '../config.mjs';
import { helpersCall, PAGE_SRC } from '../page/build.mjs';
import { appPlans } from '../agent/context.mjs';
import { hasLaunched, takeLaunched } from '../launch.mjs';
import { allFusionRuns, assertFusionReady } from '../fusion/state.mjs';
import { AGENT_REGISTRY } from '../apps/index.mjs';
import { orderedProjectWindows } from '../project-windows.mjs';
import { NativeCdp, nativeWindow, nativeSessionCatalog } from '../native-windows.mjs';
import { codexBackend } from '../codex/state.mjs';
import { ConversationRef, SessionBinding } from './binding.mjs';

export const bindingMethods = {
  async attach(target, windows) {
    const origin = ConversationRef.capture(this);
    let req = target && typeof target === 'object' ? target : { id: target || '' };
    const app = String(req.id || '').replace(/:.*$/, '');
    if (req.restore) {
      const saved = lastSelection(this.deviceId, app);
      if (saved) req = { ...req, ...saved };
    }
    if (req.threadId && !codexBackend.canAccess(req.threadId, this.deviceId)) throw new Error('当前设备未获准访问此手机会话');
    const fusionMain = req.threadId && !req.projectSwitch && !this.fusionBinding && allFusionRuns().flatMap(run => run.bindings
      .filter(binding => binding.id === run.main.bindingId)).find(binding => binding.reuseWindow && binding.app === app && binding.threadId === req.threadId);
    if (fusionMain) {
      if (req.project && !this.projectMatches([{ root: fusionMain.project.root, host: fusionMain.host }], req.project.root, req.project.host))
        throw new Error('Fusion 主会话不属于所选项目');
      const window = app === 'codex' || fusionMain.windowId.startsWith(app + ':') ? fusionMain.windowId : `${app}:${fusionMain.windowId}`;
      req = { ...req, id: app === 'codex' ? app : window, windowId: window, project: null,
        ...(app === 'codex' ? { nativeOwner: { cwd: fusionMain.project.root } } : {}) };
    }
    if (!fusionMain && ['cursor', 'devin'].includes(app) && req.threadId && !req.project && !req.projectSwitch && !this.fusionBinding) {
      const row = nativeSessionCatalog(app)?.rows.find(row => row.id === req.threadId);
      if (row?.workspace) req = { ...req, project: { root: row.workspace, host: row.host || '' } };
    }
    const nativeThread = !fusionMain && req.threadId && !req.projectSwitch && !this.fusionBinding;
    const agent = AGENT_REGISTRY[app], navigation = agent?.navigation;
    const carrier = nativeThread && navigation?.threadCarrier?.call(this, req);
    const requestedWindow = req.windowId || (String(req.id || '').startsWith(app + ':') && req.id);
    const sameWindow = this.bindingReady && this.app === app && this.mode === 'chat'
      && this.cdp?.ws?.readyState === 1 && !this.pendingProject && !this.selectionHome;
    if (nativeThread && sameWindow && !req.initial && !req.resume && (!requestedWindow || requestedWindow === this.windowId)
        && navigation?.canReuseWindow?.call(this, req, carrier)) {
      const options = await navigation.sameWindowOptions.call(this, req, origin);
      if (options) {
        const tracked = this.prioritizeNavigationRead(this.cdp, this.editorCdp);
        const release = tracked ? null : nativeWindow(this.cdp)?.beginForegroundRead(cdpRead.getStore());
        try {
          await this.withFocus(() => this.adapter.openAgent.call(this, req.threadId, '', options));
          // Overview hides the viewer, not the verified binding. Reinstall only
          // the missing subscription, without re-reading the same first screen.
          if (this.visible && !this.chatUpdatesStop) await this.setMode('chat', false, true);
          return;
        } finally { release?.(); }
      }
    }
    if (carrier) req = await navigation.bindThreadCarrier.call(this, req, carrier);
    if (req.project && !req.project.host) req = { ...req, project: { ...req.project, root: localFilePath(req.project.root) } };
    if (app === 'opencode') return AGENT_REGISTRY.opencode.adapter.attach.call(this, req);
    const backend = navigation?.backendAttach?.call(this, req);
    if (backend) return agent.adapter.attachBackend.call(this, backend);
    if (sameWindow && app === 'codex' && req.nativeOwner?.visible && !req.initial && !req.resume
        && req.windowId === this.windowId && req.threadId === this.threadId
        && this.cdp.nativeWindow?.cachedCodexOwner(req.threadId, req.windowId)?.visible
        && req.nativeOwner.cwd === this.codexOwnerRoot && this.sessionProject?.selection === origin.key
        && !(await this.editorCdp.evaluate(helpersCall('workspaceTrustState()'))).required) {
      origin.assertCurrent(this);
      this.prioritizeNavigationRead(this.cdp, this.editorCdp);
      await this.currentRoots(this.sessionProject.roots);
      this.publishThread();
      await this.pollChat(true, true);
      if (this.visible && !this.chatUpdatesStop) await this.setMode('chat', false, true);
      return;
    }
    if (req.resume && this.bindingReady && this.cdp?.ws?.readyState === 1 && this.app === app
        && this.windowId === req.windowId && this.threadId === (req.threadId || '')) {
      const actual = await this.cdp.evaluate(helpersCall(this.app === 'codex' ? 'codexThread()' : 'activeThread()'));
      origin.assertCurrent(this);
      cdpRead.getStore()?.throwIfAborted();
      if (actual === origin.threadId) {
        this.prioritizeNavigationRead(this.cdp, this.editorCdp);
        this.emit({ ...this.connectionMessages.get('attached'), keepQuota: false, initial: req.initial === true, ready: true });
        return this.setMode(this.mode, true);
      }
    }
    if (req.initial && !req.nativeOwner && !fusionMain && hasLaunched(app)) req = { ...req, id: app, windowId: '', threadId: '', project: null };
    if (req.project && !req.projectSwitch && navigation?.projectAttach)
      req = navigation.projectAttach.call(this, req);
    if (req.project && !req.projectSwitch) {
      // Bind only the app first. The saved project, not a fallback window, owns the thread.
      const source = navigation?.projectThreadCarrier && req.threadId && !req.project.host
        ? await navigation.projectThreadCarrier.call(this, req) : null;
      const carrier = source?.win || navigation?.projectWindowCarrier?.call(this, req);
      origin.assertCurrent(this);
      await this.attach({ ...req, id: carrier?.id || app, windowId: carrier?.id || '', restore: false, project: null, threadId: '', projectSwitch: true }, windows);
      if (!this.cdp || this.app !== app) throw new Error('所选 Agent 尚未连接，请重试');
      if (!req.project.host) return this.useProject(req.project.root, false, req.threadId || '', '', req.windowId || '');
      if (!this.projectMatches(await this.currentRoots(), req.project.root, req.project.host)) {
        const pages = app === 'codex' ? await AGENT_REGISTRY.codex.discover(true) : await AGENT_REGISTRY[app].discover();
        let match;
        for (const page of pages) {
          const cdp = new Cdp(page.ws);
          try {
            await cdp.connect();
            if (this.projectMatches(await editorRoots(cdp, app), req.project.root, req.project.host)) { match = page; break; }
          } finally { cdp.close(); }
        }
        if (!match) throw new Error('远程项目窗口未打开，请在电脑端打开后重新选择');
        await this.attach({ id: match.id || app, windowId: match.pageId || match.id, projectSwitch: true });
      }
      if (app === 'codex') {
        await this.ensureCodexReady({ id: this.windowId, ws: this.editorCdp.wsUrl }, false);
        if (req.threadId && !await this.selectCodexThread(req.threadId)) throw new Error('没有找到所选会话');
        await this.adoptCodexThread(req.threadId || await this.cdp.evaluate(helpersCall('codexThread()')) || '');
      } else if (req.threadId) await this.withFocus(() => this.adapter.openAgent.call(this, req.threadId));
      this.bindingReady = true;
      await this.currentRoots();
      this.publishThread();
      return this.setMode(this.mode, true);
    }
    let appId = String(req.id || '');
    let windowId = String(req.windowId || '');
    const threadId = String(req.threadId || '');
    if (appId.startsWith('codex:')) {
      windowId = windowId || appId.slice('codex:'.length);
      appId = 'codex';
    }
    let codexPages;
    if (appId === 'codex') {
      try {
        codexPages = await AGENT_REGISTRY.codex.discover(true);
        if (windowId && !codexPages.some(p => p.pageId === windowId) && threadId) {
          const recovered = await AGENT_REGISTRY.codex.methods.codexPageForThread.call(this, codexPages, threadId);
          if (recovered) windowId = recovered.pageId;
        }
      } catch (error) {
        throw new Error(`读取 Codex 调试接口失败，请重试：${error.message}`);
      }
    }
    if (AGENT_REGISTRY[appId]?.kind === 'orchestrator') {
      assertFusionReady();
      return AGENT_REGISTRY[appId].adapter.attach.call(this, req);
    }
    const targetApp = Object.keys(AGENT_REGISTRY).find(app => appId === app || appId.startsWith(app + ':'));
    const wins = windows || (codexPages ? codexPages.length ? [{id: 'codex', app: 'codex', title: 'Codex', ws: codexPages[0].ws, port: CODEX_CDP_URL, kind: 'local'}] : [] : targetApp ? await AGENT_REGISTRY[targetApp].discover() : await listWindows());
    cdpRead.getStore()?.throwIfAborted();
    origin.assertCurrent(this);
    if (!appId && ['codex', 'opencode'].includes(wins[0]?.app)) return this.attach({ ...req, id: wins[0].app }, wins);
    if (appId === 'codex') {
      const pages = orderedProjectWindows('codex', codexPages);
      if (!pages.length) {
        throw new Error('这个 Codex 窗口已经关闭，请重新选择');
      }
      if (windowId && !pages.some(p => p.pageId === windowId)) throw new Error('这个 Codex 窗口已经关闭，请重新选择');
      const picked = windowId && pages.some(p => p.pageId === windowId)
        ? pages.find(p => p.pageId === windowId)
        : (pages.find(p => !/^Welcome\b/.test(p.rawTitle || '') && p.chatWs) || pages.find(p => p.chatWs) || pages[0]);
      if (!picked) throw new Error('没有找到 Codex 窗口。请用 ./scripts/start-codex.sh 启动，并打开 Codex 侧边栏');
      const entry = wins.find(w => w.id === 'codex');
      if (!entry) throw new Error('没有找到 Codex 窗口。请用 ./scripts/start-codex.sh 启动，并打开 Codex 侧边栏');
      await this.openBound({ ...entry, title: picked.rawTitle }, picked.ws, picked.chatWs, { windowId: picked.pageId, threadId, nativeOwner: req.nativeOwner, deferred: req.projectSwitch === true, initial: req.initial === true });
      if (this.cdp === this.editorCdp && !req.projectSwitch) this.emit({ t: 'status', ok: false, msg: 'Codex 侧边栏还没打开' });
      return;
    }
    const win = wins.find(w => w.id === appId) || wins.find(w => appId && w.id.endsWith(':' + appId))
      || (appId && !appId.includes(':') ? orderedProjectWindows(appId, wins.filter(w => w.app === appId))[0] : null);
    if (appId && !win) {
      throw new Error('这个窗口已经关闭，请重新选择');
    }
    const chosen = win || wins[0];
    if (!chosen) throw new Error('没有找到 Cursor、Devin 或 Codex 窗口。Cursor 用调试端口 9222，Devin 用 ./scripts/start-devin.sh，Codex 用 ./scripts/start-codex.sh');
    await this.openBound(chosen, chosen.ws, null, { windowId: chosen.id, threadId, deferred: req.projectSwitch === true,
      initial: req.initial === true, fusionMain: fusionMain || null });
  },

  async openBound(win, editorWs, chatWs, selection) {
    const origin = ConversationRef.capture(this);
    const editorCdp = new NativeCdp(editorWs, win.app);
    const cdp = chatWs ? new NativeCdp(chatWs, win.app) : editorCdp;
    this.prioritizeNavigationRead(cdp, editorCdp);
    // A phone-launched app keeps its native home/new-chat view, not a remembered thread.
    // Keep the marker until startup and the first chat read complete successfully.
    const launchDefault = !selection.nativeOwner && !selection.fusionMain && selection.initial === true && hasLaunched(win.app);
    let thread = '', trust, viewport, home = false;
    try {
      await editorCdp.connect();
      if (cdp !== editorCdp) await cdp.connect();
      const checkMissing = win.app === 'devin' && !selection.deferred && !selection.threadId;
      const [state, chatThread] = await Promise.all([editorCdp.evaluate(`(async () => {
        const h = ${PAGE_SRC};
        const trust = h.workspaceTrustState(), viewport = { w: innerWidth, h: innerHeight };
        const thread = ${cdp !== editorCdp ? "''" : win.app === 'codex' ? "h.codexThread()" : "h.activeThread()"} || '';
        const home = ${checkMissing} && !!thread && await h.nativeSessionInfo('devin', thread, 'missing');
        return { trust, viewport, thread: home ? '' : thread, home };
      })()`), cdp !== editorCdp && cdp.evaluate(helpersCall('codexThread()'))]);
      ({ trust, viewport, thread, home } = state);
      if (cdp !== editorCdp) thread = chatThread || '';
      cdpRead.getStore()?.throwIfAborted();
      origin.assertCurrent(this);
      if (cdp.ws?.readyState !== 1 || editorCdp.ws?.readyState !== 1) throw new Error('窗口连接已断开');
    } catch (error) {
      for (const connection of new Set([cdp, editorCdp])) connection.close();
      this.emit({ t: 'attachFailed', ready: this.app === 'fusion' || !!this.cdp });
      throw error;
    }
    const startupThread = thread;
    if (selection.deferred && selection.threadId) thread = selection.threadId;
    this.replaceBinding({
      editorCdp, cdp, bindingReady: false, selectionHome: home, windowId: selection.windowId,
      ...(win.app === 'codex' ? { codexPageId: selection.windowId } : {}),
      codexOwnerRoot: localFilePath(selection.nativeOwner?.cwd || ''), threadId: thread, selectedThread: thread,
      targetId: win.id, winTitle: win.title, app: win.app || 'cursor',
    });
    if (win.app === 'codex') {
      this.codexAccountWindowId = selection.windowId;
      this.codexAccount = null;
    }
    this.launchDefault = launchDefault;
    if (viewport) this.viewport = viewport;
    const source = nativeWindow(cdp);
    source.start({ id: win.id, ws: cdp.wsUrl, editorWs, app: win.app, pageId: selection.windowId }).catch(() => {});
    source.setThread(thread);
    if (this.pendingProject && (this.pendingProject.app !== this.app || this.pendingProject.windowId !== this.windowId)) this.pendingProject = null;
    this.resetCaches();
    this.itemCache = source.itemCache;
    this.curSession = undefined;
    const onclose = error => {
      if (this.cdp !== cdp || this.editorCdp !== editorCdp) return;
      this.detach();
      this.emit({ t: 'attached', id: win.id, app: win.app, windowId: selection.windowId,
        closed: true, ready: false, message: error?.message || this.appMessage('{app} 窗口连接已断开') });
    };
    for (const connection of new Set([cdp, editorCdp])) {
      connection.onclose = onclose;
    }
    const attached = async () => {
      const binding = ConversationRef.capture(this);
      if (binding.bindingReady && this.sessionProject?.generation !== binding.sel) await this.currentRoots();
      binding.assertCurrent(this);
      cdpRead.getStore()?.throwIfAborted();
      this.emit({
        t: 'attached', id: win.id, title: this.app === 'codex' ? 'Codex' : win.title, app: win.app,
        appName: this.appMessage('{app}'), project: this.projectName(), windowId: this.windowId || '', threadId: this.threadId || '', sel: this.selectionKey(), plans: appPlans, initial: selection.initial === true, ready: this.bindingReady === true,
      });
    };
    if (trust.required) {
      await attached();
      await this.checkProjectTrust({ threadId: selection.threadId || '' }, trust);
      if (!selection.deferred) this.setMode(this.mode).catch(e => this.emit({ t: 'status', ok: false, msg: e.message }));
      return;
    }
    if (win.app === 'devin' && !selection.deferred && !this.selectionHome
        && await this.withFocus(() => this.ensureDevinIde(selection.threadId?.replace(/^tab:/, '') || this.threadId))) {
      if (launchDefault) takeLaunched('devin');
      return;
    }
    const restore = !selection.deferred && selection.threadId && selection.threadId !== this.threadId && !launchDefault;
    const recoverInitial = win.app === 'codex' && selection.initial === true && !startupThread;
    const startup = !selection.deferred && !this.selectionHome && (launchDefault || recoverInitial || win.app === 'devin' && !this.threadId);
    if (restore) SessionBinding.commit(this, { threadId: selection.threadId, selectedThread: selection.threadId });
    if (startup || (restore && selection.initial)) await attached();
    if (restore) {
      const id = win.app === 'codex' ? `thread:${this.codexPageId}:${selection.threadId}` : selection.threadId;
      await this.withFocus(async () => {
        if (selection.nativeOwner) {
          if (!await this.selectCodexThread(selection.threadId)) throw new Error('没有找到所选会话');
          await this.adoptCodexThread(selection.threadId);
        } else if (selection.fusionMain) await this.adapter.openAgent.call(this, id, '', { reuseWindow: true });
        else await this.openAgent(id);
      });
      if (this.cdp !== cdp) return;
      if (this.bindingReady && this.chatUpdatesStop && this.lastChat) {
        if (win.app !== 'codex') this.prefetchMenus().catch(() => {});
        return;
      }
    } else if (startup) {
      const pending = this.startupPending = {};
      try {
        const state = await this.withFocus(async () => {
          await this.adapter.openDefaultSession?.call(this);
          if (this.pendingProject?.trust) return null;
          const state = await this.waitFor(`agentStartupState(${JSON.stringify(win.app)}, true)`, 250);
          if (!state) throw new Error('会话输入区尚未就绪，请重试');
          cdpRead.getStore()?.throwIfAborted();
          SessionBinding.commit(this, { threadId: state.thread || '', selectedThread: state.thread || '' });
          return state;
        });
        cdpRead.getStore()?.throwIfAborted();
        this.startupPending = null;
        if (this.pendingProject?.trust) return;
        if (state.login) {
          this.emit({ t: 'attachFailed', ready: false, message: '请先在电脑端登录 Codex，再重试当前会话' });
          return;
        }
        this.bindingReady = true;
        await attached();
        await this.withFocus(() => this.setMode(this.mode, true));
        for (let i = 0; this.mode === 'chat' && !this.lastChat && i < 40; i++) {
          await new Promise(resolve => setTimeout(resolve, 120));
          cdpRead.getStore()?.throwIfAborted();
          await this.pollChat(true);
        }
        if (this.mode === 'chat' && !this.lastChat) throw new Error('当前会话尚未就绪，请重试');
        if (launchDefault) takeLaunched(win.app);
        if (win.app !== 'codex') this.prefetchMenus().catch(() => {});
      }
      catch (error) {
        if (this.startupPending === pending || !this.startupPending) {
          this.startupPending = null;
        }
        throw error;
      }
      return;
    } else if (!selection.deferred && win.app === 'cursor' && this.threadId && !await this.cdp.evaluate(helpersCall('hasComposer()'))) {
      await this.withFocus(() => this.adapter.openAgent.call(this, this.threadId));
    }
    this.bindingReady = !selection.deferred && !this.startupPending;
    await attached();
    if (this.startupPending || selection.deferred) return { trust };
    // A restored Cursor thread can still be enriching the first read. That
    // work waits for focus to be released before another first read can finish.
    if (this.mode === 'chat' && (restore && win.app === 'cursor' || selection.nativeOwner && win.app === 'codex'))
      await this.setMode(this.mode, true);
    else await this.withFocus(() => this.setMode(this.mode, true));
    if (this.cdp === cdp && win.app !== 'codex') this.prefetchMenus().catch(() => {});
  },

  navigationFailed(message, error) {
    this.stopCatalogUpdates();
    const app = message.t === 'attach' ? String(message.id || '').replace(/:.*$/, '') || this.app : this.app;
    const failure = error.message;
    if (this.app !== app) this.detach();

    this.rememberedSelection = '';
    this.rememberingSelection = null;
    this.chatRead?.controller.abort(error);
    this.chatRead?.reject?.(error);
    this.chatRead = null;
    this.invalidateChatWatchers();
    this.stopChatUpdates();
    this.stopChatTimer();
    this.startupPending = this.pendingProject = null;
    this.switchingThread = false;
    this.clearViewState();
    SessionBinding.commit(this, { app, bindingReady: false, selectionHome: true, threadId: '', selectedThread: '',
      ...(!this.cdp ? { windowId: '', targetId: '' } : {}) });
    this.emit({ t: 'attachFailed', home: true, ready: false, app, appName: this.appMessage('{app}'), id: this.targetId || app,
      windowId: this.windowId || '', threadId: '', sel: this.selectionKey(), connected: !!this.cdp,
      navigationId: message.navigationId, message: failure });
  },

  releaseBackendSettings() {
    if (this.codexBackendSettings) cdpRead.run(null, () => this.adapter.closeBackendSettings.call(this))
      .catch(error => console.log('[settings close]', error.message));
  },

  replaceBinding(changes) {
    cdpRead.getStore()?.throwIfAborted();
    this.releaseBinding(changes);
  },

  detach() { this.releaseBinding(); },

  releaseBinding(changes) {
    this.cancelWindowReads();
    this.navigationFirstScreen = null;
    this.releaseBackendSettings();
    if (this.codexBackend) cdpRead.run(null, () => codexBackend.releaseIdle(this.threadId))
      .catch(error => this.emit({ t: 'status', ok: false, msg: error.message }));
    if (this.app === 'opencode') this.adapter.detach.call(this);
    this.stopCatalogUpdates();
    this.rememberedSelection = '';
    const read = this.chatRead;
    this.chatRead = null;
    this.polling = this.pollAgain = null;
    const reason = new Error('窗口已切换或断开');
    read?.controller.abort(reason);
    read?.reject?.(reason);
    this.desktopSettingsOwned = undefined;
    this.desktopSettingsSection = '';
    this.codexSettingsCdp?.close();
    this.codexSettingsCdp = null;
    this.codexSettingsEditor = null;
    this.codexSettingsReturn = '';
    this.invalidateChatWatchers();
    cdpRead.run(null, () => this.stopChatUpdates());
    this.stopVisual();
    clearTimeout(this.focusTimer);
    this.focusTimer = null;
    this.focusCount = 0;
    this.stopChatTimer();
    const connections = new Set([this.cdp, this.editorCdp]);
    if (changes) this.clearViewState();
    SessionBinding.commit(this, { cdp: null, editorCdp: null, bindingReady: false, codexBackend: false,
      codexOwnerRoot: '', sessionProject: null, sessionCwd: '', ...changes }, true);
    cdpRead.run(null, () => {
      for (const cdp of connections) {
        if (cdp) cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {})
          .finally(() => cdp.close());
      }
    });
  },

  async refreshViewport() {
    const v = await this.editorCdp.evaluate('({ w: innerWidth, h: innerHeight })');
    if (v) this.viewport = v;
  },

  async followCodexOwner(msg, origin = ConversationRef.capture(this)) {
    if (!origin.codexBackend) return msg;
    const owner = await this.adapter.backendOwner(origin.threadId);
    origin.assertCurrent(this);
    cdpRead.getStore()?.throwIfAborted();
    if (!owner) return msg;
    const files = pendingUploads(origin.key, this.deviceId);
    await this.attach({ id: 'codex', windowId: owner.pageId, threadId: origin.threadId, nativeOwner: { cwd: owner.cwd } });
    const binding = ConversationRef.capture(this);
    if (binding.app !== 'codex' || binding.threadId !== origin.threadId || binding.windowId !== owner.pageId
        || !binding.bindingReady) throw new Error('会话已切换，操作未执行');
    for (const [id, file] of files) {
      if (uploads.get(id) === file && file.sel === origin.key) updateUpload(file, { sel: binding.key });
    }
    return msg.sel === origin.key ? { ...msg, sel: binding.key } : msg;
  },

  beginNavigation(message, signal, collect) {
    this.cancelWindowReads();
    this.navigationFirstScreen = null;
    SessionBinding.commit(this, { navigationId: message.navigationId }, true);
    if (collect) return signal.navigation = this.navigationResult = { id: message.navigationId };
  },

  prioritizeNavigationRead(...connections) {
    const signal = cdpRead.getStore(), result = signal?.navigation;
    if (!result || result !== this.navigationResult || signal.aborted || this.mode !== 'chat') return;
    const sources = new Set(connections.map(nativeWindow).filter(Boolean));
    const reads = result.foregroundReads ||= new Map();
    for (const source of sources) if (!reads.has(source)) reads.set(source, source.beginForegroundRead(signal));
    for (const [source, release] of reads) {
      if (sources.has(source)) continue;
      release();
      reads.delete(source);
    }
    return true;
  },

  stageNavigationEvent(obj, sent) {
    const result = cdpRead.getStore()?.navigation;
    if (!result || result !== this.navigationResult) return false;
    if (obj?.t === 'attached' && !obj.closed) {
      result.attached = { ...result.attached, ...obj,
        keepQuota: result.attached ? !!result.attached.keepQuota && !!obj.keepQuota : obj.keepQuota };
      return obj.ready !== false;
    }
    if (obj?.t === 'thread') return true;
    if (obj?.t === 'chat' && obj.chat) {
      result.chat = obj;
      if (sent) result.chatSent = sent;
      return true;
    }
    if (obj?.t === 'projectReady') {
      const { chat, ...project } = obj;
      result.project = project;
      if (chat) result.chat = { sel: obj.sel, chat };
      return true;
    }
    return false;
  },

  clearNavigationResult(result) {
    if (result && this.navigationResult === result) this.navigationResult = null;
    for (const release of result?.foregroundReads?.values() || []) release();
    result?.foregroundReads?.clear();
  },

  finishNavigationResult(result) {
    if (this.navigationResult !== result) return;
    this.navigationResult = null;
    if (!this.bindingReady) return;
    const binding = result.attached;
    if (!binding) return;
    if (this.mode === 'chat' && (!result.chat || result.chat.sel !== this.selectionKey()
      || result.chat.chat.thread !== (this.threadId || ''))) throw new Error('当前会话内容尚未就绪，请重试');
    this.emit({ ...binding, ready: true, windowId: this.windowId || '', threadId: this.threadId || '',
      sel: this.selectionKey(), ...(result.chat ? { chat: result.chat.chat } : {}),
      ...(result.project ? { projectReady: result.project } : {}) }, result.chatSent, true);
  },

};
