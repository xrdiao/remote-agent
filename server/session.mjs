import { Cdp, cdpRead } from './cdp.mjs';
import { listWindows, codexWindows } from './windows.mjs';
import { CODEX_CDP_URL } from './config.mjs';
import { PAGE_SRC, helpersCall } from './page/build.mjs';
import { AgentContext, appPlans } from './agent/index.mjs';
import { hasLaunched, takeLaunched } from './launch.mjs';
import { fusionViewers, fusionHistory, fusionWorkers } from './fusion/state.mjs';
import { FUSION_OWNER } from './fusion/owner.mjs';
import { FusionRunner } from './fusion/runner.mjs';
import { ROUTES, SKIP, flag } from './routes.mjs';
import { chatForWire } from './chat-images.mjs';
import { watchChat } from './agent/updates.mjs';
import { AGENT_REGISTRY } from './apps/index.mjs';
import { sessionRows } from '../lib/session-library.mjs';
import { catalogSessions, touchProjectWindow } from './project-windows.mjs';
import { leaseWindow, windowOperationLocked } from './window-use.mjs';
import {visualCapture, visualWindows, wayland} from './visual/capture.mjs';
import { rememberSelection, lastSelection, forgetSelection } from '../lib/auth.mjs';
import { editorRoots } from '../lib/files.mjs';
import { NativeCdp, nativeWindow, nativeWindowAt, nativeTargets } from './native-windows.mjs';
import { captureOperation } from './operations.mjs';

export class Session extends AgentContext {
  constructor(client, deviceId) {
    super({ deviceId });
    this.client = client;
    fusionViewers.add(this);
    this.fusionSaved = fusionHistory[deviceId] ||= { current: '', runs: [] };
    this.fusionRun = this.fusionSaved.runs.find(f => f.id === this.fusionSaved.current);
    // The phone reports when the app goes to the background; notifications skip the window it is looking at.
    this.visible = true;
    this.notifyVisible = true;
    this.notifyPresenceAt = Date.now();
    this.viewport = { w: 1000, h: 800 };
    this.mode = 'chat';
  }

  async setMode(mode, firstScreen = false) {
    const watchGeneration = this.chatWatchGeneration = (this.chatWatchGeneration || 0) + 1;
    cdpRead.run(null, () => this.chatUpdatesStop?.());
    this.chatUpdatesStop = null;
    if (this.mode === 'screen' && mode !== 'screen') this.stopVisual();
    this.mode = mode === 'screen' || mode === 'terminal' ? mode : 'chat';
    this.lastChatAt = this.lastTermAt = 0;
    clearInterval(this.chatTimer);
    clearInterval(this.termTimer);
    if (this.mode === 'screen') {
      visualCapture.subscribe(this);
      const windows = await this.visualList();
      await visualCapture.restore(windows);
      return;
    }
    if (!this.editorCdp || this.selectionHome && this.mode === 'chat') return;
    if (this.mode === 'chat') {
      const cdp = this.cdp;
      this.lastChat = '';
      const source = nativeWindow(cdp);
      if (source) {
        this.chatUpdatesStop = source.subscribe(error => {
          if (!this.visible || this.mode !== 'chat' || this.cdp !== cdp) return;
          if (error) this.emit({ t: 'status', ok: false, msg: error.message });
          else this.pollChat(true).catch(() => {});
        });
        if (firstScreen) await this.pollChat(true, true);
        else await this.pollChat(true);
        return;
      }
      this.chatTimer = cdpRead.run(null, () => setInterval(() => this.pollChat().catch(() => {}), 700));
      if (firstScreen) await this.pollChat(true, true);
      const watching = (async () => {
        const stop = await watchChat(cdp, () => {
          if (this.visible && this.mode === 'chat' && this.cdp === cdp) this.pollChat(true).catch(() => {});
        });
        if (this.chatWatchGeneration !== watchGeneration || this.cdp !== cdp || this.mode !== 'chat') { stop(); return; }
        this.chatUpdatesStop = stop;
      })();
      if (firstScreen) watching.catch(error => {
        if (this.cdp === cdp && this.chatWatchGeneration === watchGeneration && !cdpRead.getStore()?.aborted)
          this.emit({ t: 'status', ok: false, msg: error.message });
      });
      else { await watching; await this.pollChat(); }
    } else if (this.mode === 'terminal') {
      this.lastTermHash = undefined;
      await this.pollTerminal();
      if (this.chatWatchGeneration !== watchGeneration || this.mode !== 'terminal') return;
      this.termTimer = cdpRead.run(null, () => setInterval(() => this.pollTerminal().catch(() => {}), 250));
    }
  }

  async visualList() {
    try {
      const windows = await visualWindows();
      this.emit({t: 'visualWindows', windows, wayland});
      return windows;
    } catch (error) {
      this.emit({t: 'visual', state: 'error', message: '读取绘图或仿真窗口失败：' + error.message, wayland});
      throw error;
    }
  }

  async visualSelect(id) {
    if (this.mode !== 'screen') return;
    await visualCapture.start(wayland ? 'select' : String(id));
  }

  stopVisual() { visualCapture.unsubscribe(this); }

  finishNavigationResult(result) {
    if (this.navigationResult !== result) return;
    this.navigationResult = null;
    if (!this.bindingReady) return;
    const binding = result.attached;
    if (!binding) return;
    if (this.mode === 'chat' && !result.chat) throw new Error('当前会话内容尚未就绪，请重试');
    this.emit({ ...binding, ready: true, windowId: this.windowId || '', threadId: this.threadId || '',
      sel: this.selectionKey(), ...(result.chat ? { chat: result.chat.chat } : {}),
      ...(result.project ? { projectReady: result.project } : {}) });
  }

  emit(obj) {
    if (captureOperation(this, obj)) return;
    if (cdpRead.getStore()?.aborted) return;
    const result = this.navigationResult;
    if (result && (cdpRead.getStore()?.navigationId ?? this.navigationId) === result.id) {
      if (obj?.t === 'attached' && !obj.closed) {
        result.attached = { ...result.attached, ...obj,
          keepQuota: result.attached ? !!result.attached.keepQuota && !!obj.keepQuota : obj.keepQuota };
        if (obj.ready !== false) return;
      } else if (obj?.t === 'thread') return;
      else if (obj?.t === 'chat' && obj.chat) { result.chat = obj; return; }
      else if (obj?.t === 'projectReady') {
        const { chat, ...project } = obj;
        result.project = project;
        if (chat) result.chat = { sel: obj.sel, chat };
        return;
      }
    }
    if (['attached', 'thread', 'chat', 'projectReady', 'attachFailed', 'status'].includes(obj?.t)) {
      const navigationId = cdpRead.getStore()?.navigationId ?? this.navigationId;
      if (navigationId != null) obj = { ...obj, navigationId };
    }
    if (obj?.t === 'agents' && !obj.error) {
      const app = obj.app || this.app;
      obj = { ...obj, list: sessionRows(app, catalogSessions(app, obj.list || [], this.windowId)) };
      this.sessionEntries = new Map(obj.list.filter(row => !row.ui).map(row => [row.id, { ...row, app: obj.app || this.app }]));
      if (app === 'codex') obj = { ...obj, list: obj.list.map(row => {
        if (row.dormant) return row;
        const { workspace, host, ...view } = row;
        return view;
      }) };
    }
    if (obj?.t === 'attached' && !obj.closed && AGENT_REGISTRY[obj.app]?.capabilities) {
      obj = { ...obj, capabilities: AGENT_REGISTRY[obj.app].capabilities };
      if (obj.app === 'fusion') obj.sideCapabilities = Object.fromEntries(Object.entries(AGENT_REGISTRY)
        .filter(([, entry]) => entry.kind !== 'orchestrator').map(([app, entry]) => [app, entry.capabilities]));
    }
    if ((obj?.t === 'chat' || obj?.t === 'attached') && obj.sel && obj.chat) {
      if (this.bindingReady && obj.sel === this.selectionKey() && !obj.cached
          && (!obj.chat.readonly || obj.chat.empty) && !obj.chat.subagent
          && obj.chat.thread === this.threadId && ['cursor', 'devin', 'codex'].includes(this.app)
          && this.rememberedSelection !== obj.sel && this.rememberingSelection?.key !== obj.sel) {
        const cdp = this.cdp, sel = this.sel;
        const selection = { id: this.targetId, app: this.app, windowId: this.windowId, threadId: this.threadId };
        const pending = this.rememberingSelection = { key: obj.sel };
        this.currentRoots().then(roots => {
          if (this.bindingReady && this.liveRead(cdp, sel) && obj.sel === this.selectionKey()) {
            rememberSelection(this.deviceId, { ...selection, project: roots[0] || null });
            this.rememberedSelection = obj.sel;
          }
        }).catch(() => {}).finally(() => {
          if (this.rememberingSelection === pending) this.rememberingSelection = null;
        });
      }
      (this.chatBySel ||= new Map()).delete(obj.sel);
      this.chatBySel.set(obj.sel, obj.chat);
      if (this.chatBySel.size > 12) this.chatBySel.delete(this.chatBySel.keys().next().value);
      obj = { ...obj, chat: chatForWire(obj.chat, this.app === 'codex' ? this.cdp?.wsUrl : '') };
    }
    if (obj?.t === 'historyPage') obj = { ...obj, items: chatForWire({ items: obj.items }, this.app === 'codex' ? this.cdp?.wsUrl : '').items };
    if (this.client.readyState === 1) this.client.send(JSON.stringify(obj), obj?.t === 'frame' ? { compress: false } : undefined);
  }

  liveRead(cdp, sel) {
    return !cdpRead.getStore()?.aborted && super.liveRead(cdp, sel);
  }

  // Asks Cursor's own Cmd+P index where a bare file name lives, then closes the picker again.

  async attach(target, windows) {
    let req = target && typeof target === 'object' ? target : { id: target || '' };
    const app = String(req.id || '').split(':')[0];
    if (req.resume && this.bindingReady && this.cdp?.ws?.readyState === 1 && this.app === app
        && this.windowId === req.windowId && this.threadId === (req.threadId || '')) {
      const actual = await this.cdp.evaluate(helpersCall(this.app === 'codex' ? 'codexThread()' : 'activeThread()'));
      if (actual === this.threadId) {
        this.visible = true;
        this.publishThread();
        return this.setMode(this.mode, true);
      }
    }
    if (req.restore) {
      const saved = lastSelection(this.deviceId, app);
      if (saved) req = { ...req, ...saved };
    }
    if (req.initial && hasLaunched(app)) req = { ...req, id: app, windowId: '', threadId: '', project: null };
    if (req.project && !req.projectSwitch) {
      const matches = nativeTargets().filter(win => win.app === app && this.projectMatches(nativeWindowAt(win.ws)?.roots || [], req.project.root, req.project.host));
      const picked = matches.find(win => (win.pageId || win.id) === req.windowId) || matches[0];
      if (picked) req = { ...req, id: app === 'codex' ? 'codex' : picked.id, windowId: picked.pageId || picked.id, project: null };
    }
    if (req.project && !req.projectSwitch) {
      // Bind only the app first. The saved project, not a fallback window, owns the thread.
      await this.attach({ ...req, id: app, windowId: '', restore: false, project: null, threadId: '', projectSwitch: true }, windows);
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
          const recovered = await this.codexPageForThread(codexPages, threadId);
          if (recovered) windowId = recovered.pageId;
        }
      } catch (error) {
        throw new Error(`读取 Codex 调试接口失败，请重试：${error.message}`);
      }
    }
    if (AGENT_REGISTRY[appId]?.kind === 'orchestrator') return AGENT_REGISTRY[appId].adapter.attach.call(this, req);
    const targetApp = Object.keys(AGENT_REGISTRY).find(app => appId === app || appId.startsWith(app + ':'));
    const wins = windows || (codexPages ? codexPages.length ? [{id: 'codex', app: 'codex', title: 'Codex', ws: codexPages[0].ws, port: CODEX_CDP_URL, kind: 'local'}] : [] : targetApp ? await AGENT_REGISTRY[targetApp].discover() : await listWindows());
    if (!appId && wins[0]?.app === 'codex') return this.attach({ ...req, id: 'codex' }, wins);
    if (appId === 'codex') {
      const pages = codexPages;
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
      await this.openBound({ ...entry, title: picked.rawTitle }, picked.ws, picked.chatWs, { windowId: picked.pageId, threadId, deferred: req.projectSwitch === true, initial: req.initial === true });
      if (this.cdp === this.editorCdp && !req.projectSwitch) this.emit({ t: 'status', ok: false, msg: 'Codex 侧边栏还没打开' });
      return;
    }
    const win = wins.find(w => w.id === appId) || wins.find(w => appId && w.id.endsWith(':' + appId))
      || (appId && !appId.includes(':') ? wins.find(w => w.app === appId) : null);
    if (appId && !win) {
      throw new Error('这个窗口已经关闭，请重新选择');
    }
    const chosen = win || wins[0];
    if (!chosen) throw new Error('没有找到 Cursor、Devin 或 Codex 窗口。Cursor 用调试端口 9222，Devin 用 ./scripts/start-devin.sh，Codex 用 ./scripts/start-codex.sh');
    await this.openBound(chosen, chosen.ws, null, { windowId: chosen.id, threadId, deferred: req.projectSwitch === true, initial: req.initial === true });
  }

  async openBound(win, editorWs, chatWs, selection) {
    const editorCdp = new NativeCdp(editorWs);
    const cdp = chatWs ? new NativeCdp(chatWs) : editorCdp;
    // A phone-launched app keeps its native home/new-chat view, not a remembered thread.
    // Keep the marker until startup and the first chat read complete successfully.
    const launchDefault = this.launchDefault = selection.initial === true && hasLaunched(win.app);
    let thread = '';
    let trust;
    try {
      await editorCdp.connect();
      if (cdp !== editorCdp) await cdp.connect();
      trust = await editorCdp.evaluate(helpersCall('workspaceTrustState()'));
      if (win.app === 'codex') {
        thread = await cdp.evaluate(helpersCall('codexThread()')) || '';
      }
    } catch (error) {
      for (const connection of new Set([cdp, editorCdp])) connection.close();
      this.emit({ t: 'attachFailed', ready: this.app === 'fusion' || !!this.cdp });
      throw error;
    }
    this.detach();
    this.clearViewState();
    this.editorCdp = editorCdp;
    this.cdp = cdp;
    this.itemCache = nativeWindow(cdp).itemCache;
    nativeWindow(cdp).start({ id: win.id, ws: cdp.wsUrl, editorWs, app: win.app, pageId: selection.windowId }).catch(() => {});
    this.bindingReady = false;
    this.selectionHome = false;
    this.windowId = selection.windowId;
    if (win.app === 'codex') this.codexPageId = selection.windowId;
    this.threadId = thread;
    this.selectedThread = thread;
    this.targetId = win.id;
    this.winTitle = win.title;
    this.app = win.app || 'cursor';
    if (this.pendingProject && (this.pendingProject.app !== this.app || this.pendingProject.windowId !== this.windowId)) this.pendingProject = null;
    this.lastChat = '';
    this.thinking = new Map();
    this.thinkingTried = new Map();
    this.tasksTried = new Map();
    this.devinHist = new Map();
    this.devinCmds = new Map();
    this.devinCmdTried = new Map();
    this.thoughtFails = new Map();
    this.curSession = undefined;
    this.keptThink = new Map();
    this.thinkLiveSeen = new Set();
    this.thinkFinal = new Set();
    const onclose = error => {
      if (this.cdp !== cdp && this.editorCdp !== editorCdp) return;
      this.detach();
      this.emit({ t: 'attached', id: win.id, app: win.app, windowId: selection.windowId,
        closed: true, ready: false, message: error?.message || this.appMessage('{app} 窗口连接已断开') });
    };
    for (const connection of new Set([cdp, editorCdp])) {
      connection.onclose = onclose;
    }
    await this.refreshViewport();
    if (this.app !== 'codex') this.threadId = await this.cdp.evaluate(helpersCall('activeThread()')) || '';
    if (selection.deferred && selection.threadId) this.threadId = selection.threadId;
    nativeWindow(cdp).setThread(this.threadId);
    this.selectedThread = this.threadId;
    const attached = () => this.emit({
      t: 'attached', id: win.id, title: this.app === 'codex' ? 'Codex' : win.title, app: win.app,
      appName: this.appMessage('{app}'), project: this.projectName(), windowId: this.windowId || '', threadId: this.threadId || '', sel: this.selectionKey(), plans: appPlans, initial: selection.initial === true, ready: this.bindingReady === true,
    });
    if (trust.required) {
      attached();
      await this.checkProjectTrust({ threadId: selection.threadId || '' }, trust);
      if (!selection.deferred) this.setMode(this.mode).catch(e => this.emit({ t: 'status', ok: false, msg: e.message }));
      return;
    }
    if (win.app === 'devin' && !selection.deferred
        && await this.withFocus(() => this.ensureDevinIde(selection.threadId?.replace(/^tab:/, '') || this.threadId))) {
      if (launchDefault) takeLaunched('devin');
      return;
    }
    const restore = !selection.deferred && selection.threadId && selection.threadId !== this.threadId && !launchDefault;
    const recoverInitial = win.app === 'codex' && selection.initial === true && !thread;
    const startup = !selection.deferred && (launchDefault || recoverInitial || win.app === 'devin' && !this.threadId);
    if (restore) this.threadId = this.selectedThread = selection.threadId;
    if (startup || (restore && selection.initial)) attached();
    if (restore) {
      const id = win.app === 'codex' ? `thread:${this.codexPageId}:${selection.threadId}` : selection.threadId;
      await this.withFocus(() => this.openAgent(id));
      if (this.cdp !== cdp) return;
      if (this.bindingReady && this.chatUpdatesStop && this.lastChat) {
        this.prefetchMenus().catch(() => {});
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
          this.threadId = this.selectedThread = state.thread || '';
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
        attached();
        await this.withFocus(() => this.setMode(this.mode, true));
        for (let i = 0; this.mode === 'chat' && !this.lastChat && i < 40; i++) {
          await new Promise(resolve => setTimeout(resolve, 120));
          cdpRead.getStore()?.throwIfAborted();
          await this.pollChat(true);
        }
        if (this.mode === 'chat' && !this.lastChat) throw new Error('当前会话尚未就绪，请重试');
        if (launchDefault) takeLaunched(win.app);
        this.prefetchMenus().catch(() => {});
      }
      catch (error) {
        if (this.startupPending === pending || !this.startupPending) {
          this.startupPending = null;
        }
        throw error;
      }
      return;
    } else if (win.app === 'cursor' && this.threadId && !await this.cdp.evaluate(helpersCall('panelRect()')).catch(() => null)) {
      await this.withFocus(() => this.adapter.openAgent.call(this, this.threadId));
    }
    this.bindingReady = !selection.deferred && !this.startupPending;
    attached();
    if (this.startupPending || selection.deferred) return { trust };
    await this.withFocus(() => this.setMode(this.mode, true));
    if (this.cdp === cdp) this.prefetchMenus().catch(() => {});
  }

  navigationFailed(message, error) {
    const app = message.t === 'attach' ? String(message.id || '').split(':')[0] || this.app : this.app;
    let failure = error.message;
    try { forgetSelection(this.deviceId, app); }
    catch (saveError) { failure += `；恢复记录清理失败：${saveError.message}`; }
    if (this.app !== app) this.detach();
    this.bindingReady = false;
    this.selectionHome = true;
    this.rememberedSelection = '';
    this.rememberingSelection = null;
    this.chatRead?.controller.abort(error);
    this.chatRead?.reject?.(error);
    this.chatRead = null;
    this.chatWatchGeneration = (this.chatWatchGeneration || 0) + 1;
    this.chatUpdatesStop?.();
    this.chatUpdatesStop = null;
    clearInterval(this.chatTimer);
    clearInterval(this.termTimer);
    this.startupPending = this.pendingProject = null;
    this.switchingThread = false;
    this.clearViewState();
    this.threadId = this.selectedThread = '';
    this.app = app;
    if (!this.cdp) this.windowId = this.targetId = '';
    this.emit({ t: 'attachFailed', home: true, ready: false, app, id: this.targetId || app,
      windowId: this.windowId || '', threadId: '', sel: this.selectionKey(), connected: !!this.cdp,
      navigationId: message.navigationId, message: failure });
  }

  // Warms the phone's sheet caches with whatever can be read without opening visible UI.

  async prefetchMenus() {
    const cdp = this.cdp;
    if (!cdp || this.app === 'fusion' || !this.visible) return;
    const sel = this.selectionKey(), generation = this.sel;
    const [items, fast, models] = await cdp.evaluate(`(() => {
      const h = ${PAGE_SRC};
      return ['effortItems', 'fastInfo', 'modelItemsFast'].map(name => {
        try { return h[name](); } catch { return null; }
      });
    })()`).catch(() => [null, null, null]);
    if (!this.liveRead(cdp, generation)) return;
    if (items?.length) this.emit({ t: 'menu', kind: 'effort', items, fast, cached: true, sel });
    if (models?.length) this.emit({ t: 'menu', kind: 'model', items: models, fast, cached: true, sel });
  }

  // Focus emulation breaks real typing while it is on, so it only wraps phone-driven
  // actions that type/tap, and is switched off again shortly after they finish.

  detach() {
    this.bindingReady = false;
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
    this.chatWatchGeneration = (this.chatWatchGeneration || 0) + 1;
    cdpRead.run(null, () => this.chatUpdatesStop?.());
    this.chatUpdatesStop = null;
    this.stopVisual();
    clearTimeout(this.focusTimer);
    this.focusTimer = null;
    this.focusCount = 0;
    clearInterval(this.chatTimer);
    clearInterval(this.termTimer);
    const connections = new Set([this.cdp, this.editorCdp]);
    this.cdp = this.editorCdp = null;
    cdpRead.run(null, () => {
      for (const cdp of connections) {
        if (cdp) cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {})
          .finally(() => cdp.close());
      }
    });
  }

  async refreshViewport() {
    const v = await this.editorCdp.evaluate('({ w: innerWidth, h: innerHeight })');
    if (v) this.viewport = v;
  }

  async snapshot() {
    return visualCapture.publish(this);
  }

  toCss(nx, ny) {
    return { x: Math.round(nx * this.viewport.w), y: Math.round(ny * this.viewport.h) };
  }

  async tap(nx, ny, button = 'left') {
    const { x, y } = this.toCss(nx, ny);
    await this.tapCss(x, y, button, this.editorCdp);
  }

  async wheel(nx, ny, dx, dy) {
    const { x, y } = this.toCss(nx, ny);
    await this.editorCdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy });
  }

  fusionWorker() {
    const key = JSON.stringify([this.deviceId, this.fusionRun.id]);
    let worker = fusionWorkers.get(key);
    if (!worker) {
      worker = new FusionRunner(this.deviceId, this.fusionRun, key);
      fusionWorkers.set(key, worker);
    }
    return worker;
  }

  async handle(msg) {
    const target = msg.id?.startsWith('project:') ? decodeURIComponent(msg.id.split(':')[1]) : msg.id?.startsWith('thread:') ? msg.id.split(':')[1] : this.windowId;
    if (windowOperationLocked(this.app, target, this)) throw new Error('窗口正在批量处理会话，请稍后操作');
    const release = leaseWindow(this.app, this.windowId, this);
    if (!['ping', 'visible', 'usage', 'agents', 'connAgents', 'windows', 'sessionLibrary', 'sessionActions'].includes(msg.t)) touchProjectWindow(this.app, this.windowId);
    const route = ROUTES[msg.t];
    const execute = async () => {
    if (route?.pre) {
      const r = await route.pre(this, msg);
      if (r !== SKIP) return r;
    }
    const readOnly = flag(route?.readOnly, this, msg);
    return await (readOnly ? this.dispatch(msg) : this.withFocus(() => this.dispatch(msg)));
    };
    try {
      const source = nativeWindow(this.cdp);
      if (source && route && !route.connection && !route.navigation && !flag(route.readOnly, this, msg))
        return await source.run(execute);
      return await execute();
    } finally { release(); }
  }

  async dispatch(msg) {
    const route = ROUTES[msg.t];
    const fusionFree = this.app === 'fusion' && flag(route?.fusionFree, this, msg);
    if (fusionFree) {
      if (route.fusion) return route.fusion(this, msg);
    } else if (!this.cdp) throw new Error(this.appMessage('尚未连接到 {app} 窗口'));
    if (!route) throw new Error(`未知指令: ${msg.t}`);
    return route.run(this, msg);
  }

  dispose() {
    this.disposed = true;
    fusionViewers.delete(this);
    this.chatUpdatesStop?.();
    clearInterval(this.chatTimer);
    clearInterval(this.termTimer);
    if (this.activeOperations) return;
    this.detach();
  }
}
Object.assign(Session.prototype, FUSION_OWNER);
