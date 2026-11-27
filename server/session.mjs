import { parseAgentRef } from '../lib/shared-rules.mjs';
import { cdpRead } from './cdp.mjs';
import { PAGE_SRC, helpersCall } from './page/build.mjs';
import { AgentContext } from './agent/index.mjs';
import { savedFusion, allFusionRuns, rememberFusionMainWindow, stateOfFusionRun } from './fusion/state.mjs';
import { FUSION_OWNER } from './fusion/owner.mjs';
import { fusionViewers, safeFusionControllerView } from './fusion/presenter.mjs';
import { fusionRunner } from './fusion/runner.mjs';
import { resolveRoute, SKIP, flag } from './routes.mjs';
import { dispatchAgentControl } from './agent/control.mjs';
import { chatForWire } from './chat-images.mjs';
import { AGENT_REGISTRY } from './apps/index.mjs';
import { sessionRows } from '../lib/session-library.mjs';
import { catalogSessions, touchProjectWindow, bindProjectWindow } from './project-windows.mjs';
import { leaseWindow, windowOperationLocked } from './window-use.mjs';
import { visualCapture } from './visual/capture.mjs';
import { rememberSelection } from '../lib/auth.mjs';
import { nativeWindow } from './native-windows.mjs';
import { captureOperation } from './operations.mjs';
import { ConnectionView } from './session/connection-view.mjs';
import { bindingMethods } from './session/navigation.mjs';
import { ConversationRef } from './session/binding.mjs';
import { subscriptionMethods } from './session/subscriptions.mjs';
import { codexBackend } from './codex/state.mjs';

export async function withTemporarySession(client, deviceId, action) {
  const session = new Session(client, deviceId);
  try { return await action(session); }
  finally { session.dispose(); }
}

export class Session extends AgentContext {
  constructor(client, deviceId, { fusionBinding = false } = {}) {
    super({ deviceId });
    this.connectionView = new ConnectionView(client, !fusionBinding);
    this.fusionBinding = fusionBinding;
    if (!fusionBinding) fusionViewers.add(this);
    this.fusionRun = fusionBinding ? null : allFusionRuns().find(run => run.id === savedFusion(deviceId).current);
    this.viewport = { w: 1000, h: 800 };
    this.mode = 'chat';
    this.connectionMessages = new Map();
  }

  get client() { return this.connectionView.client; }
  set client(client) { this.connectionView.connect(client); }

  get visible() { return this.connectionView.visible; }
  set visible(value) { this.connectionView.visible = value; }
  get notifyVisible() { return this.connectionView.notifyVisible; }
  set notifyVisible(value) { this.connectionView.notifyVisible = value; }
  get notifyPresenceAt() { return this.connectionView.notifyPresenceAt; }
  set notifyPresenceAt(value) { this.connectionView.notifyPresenceAt = value; }

  emit(obj, sent, committedNavigation = false) {
    if (captureOperation(this, obj)) return;
    if (!this.connectionView.matchesDelivery() || cdpRead.getStore()?.aborted) return;
    const deliver = this.connectionView.acceptsDelivery();
    if (!deliver && !committedNavigation) {
      this.stageNavigationEvent(obj, sent);
      return;
    }
    if (['attached', 'thread'].includes(obj?.t) && obj.app !== 'fusion') {
      const app = obj.app || this.app, threadId = obj.threadId ?? this.threadId;
      this.fusionRun = !this.fusionBinding && allFusionRuns().find(run => run.bindings.some(binding => binding.id === run.main.bindingId
        && binding.app === app && binding.threadId === threadId));
      const fusionController = this.fusionRun ? safeFusionControllerView(this.fusionRun) : null;
      if (!fusionController) this.fusionRun = null;
      this.fusionDetail = null;
      obj = { ...obj, fusionController };
    }
    if (this.stageNavigationEvent(obj, sent)) return;
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
      obj = { ...obj, capabilities: obj.capabilities || AGENT_REGISTRY[obj.app].capabilities };
      if (obj.ready && !this.fusionBinding && !this.codexBackend && ['codex', 'devin', 'cursor'].includes(obj.app))
        bindProjectWindow(obj.app, obj.windowId);
    }
    if ((obj?.t === 'chat' || obj?.t === 'attached') && obj.sel && obj.chat) {
      if (!this.fusionBinding && this.bindingReady && obj.sel === this.selectionKey() && !obj.cached
          && (!obj.chat.readonly || obj.chat.empty) && !obj.chat.subagent
          && obj.chat.thread === this.threadId && ['cursor', 'devin', 'codex'].includes(this.app)
          && this.rememberedSelection !== obj.sel && this.rememberingSelection?.generation !== this.sel) {
        const binding = ConversationRef.capture(this);
        const selection = { id: this.targetId, app: this.app, windowId: this.windowId, threadId: this.threadId };
        const pending = this.rememberingSelection = { key: obj.sel, generation: binding.sel };
        const project = this.sessionProject;
        const projectRoots = project?.generation === binding.sel ? Promise.resolve(project.roots) : this.currentRoots();
        projectRoots.then(roots => {
          if (this.bindingReady && binding.isCurrent(this) && this.connectionView.acceptsDelivery() && !cdpRead.getStore()?.aborted) {
            rememberSelection(this.deviceId, { ...selection, project: roots[0] || null });
            if (this.fusionRun) {
              const run = this.fusionRun, runner = fusionRunner(run);
              try { rememberFusionMainWindow(run, selection, roots); }
              catch (error) { stateOfFusionRun(run).report('window', error, run); }
              if (!runner.controller.context) cdpRead.run(null, () => runner.ensureMain()).catch(error => runner.report('window', error));
            }
            this.rememberedSelection = obj.sel;
          }
        }).catch(() => {}).finally(() => {
          if (this.rememberingSelection === pending) this.rememberingSelection = null;
        });
      }
      (this.chatBySel ||= new Map()).delete(obj.sel);
      this.chatBySel.set(obj.sel, obj.chat);
      if (this.chatBySel.size > 12) this.chatBySel.delete(this.chatBySel.keys().next().value);
      obj = { ...obj, chat: chatForWire(obj.chat, this.cdp?.wsUrl || '') };
    }
    if (obj?.t === 'historyPage') obj = { ...obj, items: chatForWire({ items: obj.items }, this.cdp?.wsUrl || '').items };
    if (['attached', 'windows', 'plans', 'connAgents', 'agentCatalog'].includes(obj?.t)) {
      const { chat, ...metadata } = obj;
      this.connectionMessages.set(obj.t, metadata);
    }
    if (deliver && this.client.readyState === 1) this.client.send(JSON.stringify(obj), obj?.t === 'frame' ? { compress: false } : undefined, sent);
  }

  liveRead(cdp, sel) {
    return this.connectionView.matchesDelivery() && !cdpRead.getStore()?.aborted && super.liveRead(cdp, sel);
  }

  // Warms the phone's sheet caches with whatever can be read without opening visible UI.

  async prefetchMenus() {
    return this.deferWindowRead('menus', () => this.readPrefetchedMenus());
  }

  async readPrefetchedMenus() {
    if (this.app === 'codex') {
      if (this.bindingReady && this.mode === 'chat' && this.threadId) await this.adapter.readModelMenu.call(this, 'model');
      return;
    }
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
    return fusionRunner(this.fusionRun);
  }

  async handle(msg) {
    const command = this.app === 'codex' && (['send', 'pickMenu', 'queue', 'codexRequest', 'codexPlan', 'codexPick'].includes(msg.t)
      || msg.t === 'codexGoal' && msg.action !== 'read')
      && !(msg.t === 'send' && msg.submit === false) && !(msg.t === 'queue' && msg.action === 'read');
    if (!command || this.agentControlCommand === this.threadId) return this.handleSelected(msg);
    const binding = ConversationRef.capture(this);
    return codexBackend.runCommand(binding.threadId || this, () => {
      cdpRead.getStore()?.throwIfAborted();
      return this.handleSelected(msg, binding);
    });
  }

  async handleSelected(msg, origin = ConversationRef.capture(this)) {
    origin.assertCurrent(this);
    if (['send', 'pickMenu', 'queue', 'question', 'codexRequest', 'codexPlan', 'codexPick', 'stop', 'opencodeQuestion', 'file', 'saveFile'].includes(msg.t)
        && msg.sel && msg.sel !== origin.key) {
      const first = this.codexFirstSend;
      if (origin.app !== 'codex' || msg.t !== 'pickMenu' || msg.kind !== 'permission'
          || first?.binding.key !== msg.sel || !first.successor?.isCurrent(this)) throw new Error('会话已切换，操作未执行');
      msg = { ...msg, sel: origin.key };
    }
    if (origin.codexBackend && ['send', 'pickMenu', 'queue', 'codexRequest', 'codexPlan', 'codexPick', 'stop'].includes(msg.t))
      msg = await this.followCodexOwner(msg, origin);
    const binding = ConversationRef.capture(this);
    if (!origin.codexBackend || binding.codexBackend) origin.assertCurrent(this);
    if (msg.t === 'send' && msg.submit !== false && this.mode === 'chat' && !this.fusionRun?.removedAt
        && this.fusionRun?.bindings.some(row => row.id === this.fusionRun.main.bindingId
          && row.app === binding.app && row.threadId === binding.threadId))
      await cdpRead.run(null, () => this.fusionWorker().ensureMain());
    binding.assertCurrent(this);
    const route = resolveRoute(this, msg.t);
    const execute = async () => {
      binding.assertCurrent(this);
      if (msg.t === 'draft') {
        if (msg.sel !== this.selectionKey()) throw new Error('会话已切换，草稿未同步');
        const epoch = this.draftEpoch || '';
        if ((msg.draftEpoch || '') !== epoch) return this.emit({ t: 'draftAck', sel: msg.sel, ok: false,
          draftEpoch: epoch, requestedEpoch: msg.draftEpoch || '', revision: msg.revision });
      }
      if (route?.native) return this.dispatch(msg, route);
      if (route?.pre) {
        const r = await route.pre(this, msg);
        if (r !== SKIP) return r;
        binding.assertCurrent(this);
      }
      const readOnly = flag(route?.readOnly, this, msg);
      return await (readOnly || this.codexBackend ? this.dispatch(msg) : this.withFocus(() => { binding.assertCurrent(this); return this.dispatch(msg); }));
    };
    if (route?.native && this.app !== 'opencode') return execute();
    const target = /^(?:project|thread):/.test(msg.id || '') ? parseAgentRef(msg.id).windowId : binding.windowId;
    if (windowOperationLocked(binding.app, target, this)) throw new Error('窗口正在批量处理会话，请稍后操作');
    const release = leaseWindow(binding.app, binding.windowId, this);
    if (!['ping', 'visible', 'usage', 'agents', 'connAgents', 'windows', 'sessionLibrary', 'sessionActions'].includes(msg.t)) touchProjectWindow(this.app, this.windowId);
    try {
      const source = nativeWindow(binding.cdp);
      if (source && route && !route.connection && !route.navigation && !flag(route.readOnly, this, msg))
        return await source.run(execute);
      return await execute();
    } finally { release(); }
  }

  async dispatch(msg, route = resolveRoute(this, msg.t)) {
    return dispatchAgentControl(this, msg, route);
  }

  suspend() {
    this.cancelWindowReads();
    this.releaseBackendSettings();
    this.visible = this.notifyVisible = false;
    this.invalidateChatWatchers();
    this.stopChatUpdates();
    this.stopCatalogUpdates();
    this.chatRead?.controller.abort(new Error('手机连接已挂起'));
    this.chatRead = null;
    this.polling = this.pollAgain = null;
    this.stopChatTimer();
    this.stopTerminalUpdates();
    this.stopVisual();
    clearTimeout(this.focusTimer);
    this.focusTimer = null;
    for (const connection of new Set([this.cdp, this.editorCdp]))
      connection?.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
  }

  dispose() {
    this.cancelWindowReads();
    this.disposed = true;
    this.connectionView.retire();
    fusionViewers.delete(this);
    this.stopChatUpdates();
    this.stopChatTimer();
    this.stopTerminalUpdates();
    if (this.activeOperations) return;
    this.detach();
  }
}
Object.assign(Session.prototype, subscriptionMethods, bindingMethods, FUSION_OWNER);
