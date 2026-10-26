import crypto from 'node:crypto';
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
    this.screencast = { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 2400 };
    this.awaitingAck = null;
    this.lastFrameAt = 0;
    this.lastHash = '';
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
      if (this.editorCdp) await this.editorCdp.send('Page.stopScreencast').catch(() => {});
      visualCapture.subscribe(this);
      const windows = await this.visualList();
      await visualCapture.restore(windows);
      return;
    }
    if (!this.editorCdp) return;
    if (this.mode === 'chat') {
      await this.editorCdp.send('Page.stopScreencast').catch(() => {});
      const cdp = this.cdp;
      const stop = await watchChat(cdp, () => {
        if (this.visible && this.mode === 'chat' && this.cdp === cdp) this.pollChat(true).catch(() => {});
      });
      if (this.chatWatchGeneration !== watchGeneration || this.cdp !== cdp || this.mode !== 'chat') { stop(); return; }
      this.chatUpdatesStop = stop;
      this.lastChat = '';
      this.chatTimer = cdpRead.run(null, () => setInterval(() => this.pollChat().catch(() => {}), 700));
      await this.pollChat(firstScreen, firstScreen);
    } else if (this.mode === 'terminal') {
      await this.editorCdp.send('Page.stopScreencast').catch(() => {});
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

  emit(obj) {
    if (cdpRead.getStore()?.aborted) return;
    if (['attached', 'thread', 'chat', 'projectReady', 'attachFailed', 'status'].includes(obj?.t)) {
      const navigationId = cdpRead.getStore()?.navigationId ?? this.navigationId;
      if (navigationId != null) obj = { ...obj, navigationId };
    }
    if (obj?.t === 'agents') {
      const app = obj.app || this.app;
      obj = { ...obj, list: sessionRows(app, catalogSessions(app, obj.list || [], this.windowId)) };
      this.sessionEntries = new Map(obj.list.filter(row => !row.ui).map(row => [row.id, { ...row, app: obj.app || this.app }]));
    }
    if (obj?.t === 'attached' && !obj.closed && AGENT_REGISTRY[obj.app]?.capabilities) {
      obj = { ...obj, capabilities: AGENT_REGISTRY[obj.app].capabilities };
      if (obj.app === 'fusion') obj.sideCapabilities = Object.fromEntries(Object.entries(AGENT_REGISTRY)
        .filter(([, entry]) => entry.kind !== 'orchestrator').map(([app, entry]) => [app, entry.capabilities]));
    }
    if (obj?.t === 'chat' && obj.sel && obj.chat) {
      (this.chatBySel ||= new Map()).delete(obj.sel);
      this.chatBySel.set(obj.sel, obj.chat);
      if (this.chatBySel.size > 12) this.chatBySel.delete(this.chatBySel.keys().next().value);
      obj = { ...obj, chat: chatForWire(obj.chat) };
    }
    if (obj?.t === 'historyPage') obj = { ...obj, items: chatForWire({ items: obj.items }).items };
    if (this.client.readyState === 1) this.client.send(JSON.stringify(obj), obj?.t === 'frame' ? { compress: false } : undefined);
  }

  liveRead(cdp, sel) {
    return !cdpRead.getStore()?.aborted && super.liveRead(cdp, sel);
  }

  // Asks Cursor's own Cmd+P index where a bare file name lives, then closes the picker again.

  async attach(target, windows) {
    const req = target && typeof target === 'object' ? target : { id: target || '' };
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
        // On reconnect, a closed Codex must not leave the phone stuck: fall back to any open app.
        if (req.initial) this.emit({ t: 'attached', id: 'codex', app: 'codex', windowId, threadId, closed: true, initial: true, ready: !!this.cdp });
        this.emit({ t: 'attachFailed', ready: this.app === 'fusion' || !!this.cdp });
        throw new Error(`读取 Codex 调试接口失败，请重试：${error.message}`);
      }
    }
    if (AGENT_REGISTRY[appId]?.kind === 'orchestrator') return AGENT_REGISTRY[appId].adapter.attach.call(this, req);
    const targetApp = Object.keys(AGENT_REGISTRY).find(app => appId === app || appId.startsWith(app + ':'));
    const wins = windows || (codexPages ? codexPages.length ? [{id: 'codex', app: 'codex', title: 'Codex', ws: codexPages[0].ws, port: CODEX_CDP_URL, kind: 'local'}] : [] : targetApp ? await AGENT_REGISTRY[targetApp].discover() : await listWindows());
    if (appId === 'codex') {
      const pages = codexPages;
      if (!pages.length) {
        this.emit({ t: 'attached', id: 'codex', title: 'Codex', app: 'codex', windowId, threadId, initial: req.initial === true, closed: true, ready: this.app === 'fusion' || !!this.cdp });
        this.emit({ t: 'status', ok: false, msg: '这个 Codex 窗口已经关闭，请重新选择' });
        return;
      }
      const picked = windowId && pages.some(p => p.pageId === windowId)
        ? pages.find(p => p.pageId === windowId)
        : (pages.find(p => !/^Welcome\b/.test(p.rawTitle || '') && p.chatWs) || pages.find(p => p.chatWs) || pages[0]);
      if (!picked) throw new Error('没有找到 Codex 窗口。请用 ./scripts/start-codex.sh 启动，并打开 Codex 侧边栏');
      const entry = wins.find(w => w.id === 'codex');
      if (!entry) throw new Error('没有找到 Codex 窗口。请用 ./scripts/start-codex.sh 启动，并打开 Codex 侧边栏');
      await this.openBound({ ...entry, title: picked.rawTitle }, picked.ws, picked.chatWs, { windowId: picked.pageId, threadId, deferred: req.projectSwitch === true, initial: req.initial === true });
      if (!picked.chatWs && !req.projectSwitch) this.emit({ t: 'status', ok: false, msg: 'Codex 侧边栏还没打开' });
      return;
    }
    const win = wins.find(w => w.id === appId) || wins.find(w => appId && w.id.endsWith(':' + appId))
      || (appId && !appId.includes(':') ? wins.find(w => w.app === appId) : null);
    if (appId && !win) {
      this.emit({ t: 'attached', id: appId, initial: req.initial === true, closed: true, ready: this.app === 'fusion' || !!this.cdp });
      this.emit({ t: 'status', ok: false, msg: '这个窗口已经关闭，请重新选择' });
      return;
    }
    const chosen = win || wins[0];
    if (!chosen) throw new Error('没有找到 Cursor、Devin 或 Codex 窗口。Cursor 用调试端口 9222，Devin 用 ./scripts/start-devin.sh，Codex 用 ./scripts/start-codex.sh');
    await this.openBound(chosen, chosen.ws, null, { windowId: chosen.id, threadId, deferred: req.projectSwitch === true, initial: req.initial === true });
  }

  async openBound(win, editorWs, chatWs, selection) {
    const editorCdp = new Cdp(editorWs);
    const cdp = chatWs ? new Cdp(chatWs) : editorCdp;
    // A phone-launched app lands on its most recent session, not the remembered thread.
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
    this.bindingReady = false;
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
    const onclose = () => {
      if (this.cdp !== cdp && this.editorCdp !== editorCdp) return;
      this.detach();
      this.emit({ t: 'status', ok: false, msg: this.appMessage('{app} 窗口连接已断开') });
    };
    for (const connection of new Set([cdp, editorCdp])) {
      connection.onclose = onclose;
      await connection.send('Page.enable');
    }
    editorCdp.on('Page.screencastFrame', p => this.onFrame(p));
    await this.refreshViewport();
    if (this.app !== 'codex') this.threadId = await this.cdp.evaluate(helpersCall('activeThread()')) || '';
    if (selection.deferred && selection.threadId) this.threadId = selection.threadId;
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
    const restore = !selection.deferred && selection.threadId && selection.threadId !== this.threadId && !launchDefault;
    const recoverInitial = win.app === 'codex' && selection.initial === true && !thread;
    const startup = !selection.deferred && (launchDefault || recoverInitial);
    if (restore) this.threadId = this.selectedThread = selection.threadId;
    if (startup || (restore && selection.initial)) attached();
    if (restore) {
      try {
        const id = win.app === 'codex' ? `thread:${this.codexPageId}:${selection.threadId}` : selection.threadId;
        await this.withFocus(() => this.openAgent(id));
      } catch (error) {
        this.emit({ t: 'chat', sel: this.selectionKey(), chat: null });
        throw error;
      }
      if (this.cdp !== cdp) return;
      if (this.bindingReady && this.chatUpdatesStop && this.lastChat) {
        this.prefetchMenus().catch(() => {});
        return;
      }
    } else if (startup) {
      const pending = this.startupPending = {};
      try {
        await this.withFocus(async () => {
          await this.adapter.openDefaultSession?.call(this);
          if (!await this.waitFor(`agentStartupState(${JSON.stringify(win.app)}, true)`, 250)) throw new Error('会话输入区尚未就绪，请重试');
        });
        cdpRead.getStore()?.throwIfAborted();
        this.startupPending = null;
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
          this.detach();
        }
        throw error;
      }
      return;
    } else if (win.app === 'cursor' && this.threadId && !await this.cdp.evaluate(helpersCall('panelRect()')).catch(() => null)) {
      await this.withFocus(() => this.adapter.openAgent.call(this, this.threadId));
    }
    this.bindingReady = !selection.deferred && !this.startupPending;
    attached();
    if (this.startupPending || selection.deferred) return;
    if (selection.initial) {
      await this.withFocus(() => this.setMode(this.mode, true));
      if (this.cdp === cdp) this.prefetchMenus().catch(() => {});
      return;
    }
    this.setMode(this.mode).then(() => {
      if (this.cdp === cdp && !selection.deferred) this.prefetchMenus().catch(() => {});
    }).catch(e => this.emit({ t: 'status', ok: false, msg: e.message }));
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
    this.listAgents(true, true).catch(() => {});
  }

  // Focus emulation breaks real typing while it is on, so it only wraps phone-driven
  // actions that type/tap, and is switched off again shortly after they finish.

  detach() {
    this.bindingReady = false;
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
    clearTimeout(this.ackTimer);
    this.awaitingAck = null;
    const connections = new Set([this.cdp, this.editorCdp]);
    this.cdp = this.editorCdp = null;
    cdpRead.run(null, () => {
      for (const cdp of connections) {
        if (cdp) cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {})
          .then(() => cdp.send('Page.stopScreencast').catch(() => {}))
          .finally(() => cdp.close());
      }
    });
  }

  async refreshViewport() {
    const v = await this.editorCdp.evaluate('({ w: innerWidth, h: innerHeight })');
    if (v) this.viewport = v;
  }

  async startScreencast() {
    await this.editorCdp.send('Page.startScreencast', { ...this.screencast, everyNthFrame: 1 });
  }

  async stopScreencast() {
    this.casting = false;
    await this.cdp.send('Page.stopScreencast').catch(() => {});
  }

  onFrame({ data, metadata, sessionId }) {
    if (this.mode === 'screen') {
      this.editorCdp?.send('Page.screencastFrameAck', {sessionId}).catch(() => {});
      return;
    }
    this.lastFrameAt = Date.now();
    if (metadata?.deviceWidth) this.viewport = { w: metadata.deviceWidth, h: metadata.deviceHeight };
    this.sendFrame(data);
    this.awaitingAck = sessionId;
    // Don't let a slow phone stall the stream forever.
    clearTimeout(this.ackTimer);
    this.ackTimer = setTimeout(() => this.ack(), 1500);
  }

  ack() {
    clearTimeout(this.ackTimer);
    if (this.awaitingAck == null || !this.editorCdp) return;
    const sessionId = this.awaitingAck;
    this.awaitingAck = null;
    this.editorCdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  }

  sendFrame(data, force = false) {
    const hash = crypto.createHash('md5').update(data).digest('hex');
    if (!force && hash === this.lastHash) return;
    this.lastHash = hash;
    this.emit({ t: 'frame', data, w: this.viewport.w, h: this.viewport.h });
  }

  async snapshot(force) {
    if (this.mode === 'screen') return visualCapture.publish(this);
    const { data } = await this.editorCdp.send('Page.captureScreenshot', { format: 'jpeg', quality: this.screencast.quality });
    this.sendFrame(data, force);
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
    try {
    const route = ROUTES[msg.t];
    if (route?.pre) {
      const r = await route.pre(this, msg);
      if (r !== SKIP) return r;
    }
    const readOnly = flag(route?.readOnly, this, msg);
    return await (readOnly ? this.dispatch(msg) : this.withFocus(() => this.dispatch(msg)));
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
    fusionViewers.delete(this);
    clearTimeout(this.ackTimer);
    this.detach();
  }
}
Object.assign(Session.prototype, FUSION_OWNER);
