import { cdpRead } from '../cdp.mjs';
import { watchChat } from '../agent/updates.mjs';
import { nativeWindow, subscribeCatalog, cursorSource } from '../native-windows.mjs';
import { visualCapture, visualWindows, isWayland } from '../visual/capture.mjs';
import { terminalService } from '../terminal-service.mjs';

export const subscriptionMethods = {
  stopChatUpdates() {
    const stop = this.chatUpdatesStop;
    this.chatUpdatesStop = null;
    return stop?.();
  },

  stopTerminalUpdates() {
    this.terminalGeneration = (this.terminalGeneration || 0) + 1;
    this.terminalUpdatesStop?.();
    this.terminalUpdatesStop = null;
  },

  async selectTerminal(id, subscription) {
    this.stopTerminalUpdates();
    this.terminalId = id;
    this.terminalSubscription = subscription;
    if (!this.visible || this.mode !== 'terminal') return;
    const generation = this.terminalGeneration;
    const stop = await terminalService.subscribe(id, message => {
      if (this.terminalGeneration === generation && this.visible && this.mode === 'terminal' && !this.disposed)
        this.emit({ ...message, subscription });
    });
    if (this.terminalGeneration !== generation) stop();
    else this.terminalUpdatesStop = stop;
  },

  setMode(mode, firstScreen = false, resumeNavigation = false) {
    return this.syncSubscriptions(mode, firstScreen, resumeNavigation);
  },

  invalidateChatWatchers() {
    return this.chatWatchGeneration = (this.chatWatchGeneration || 0) + 1;
  },

  stopCatalogUpdates() {
    this.catalogUpdatesStop?.();
    this.catalogUpdatesStop = null;
  },

  stopChatTimer() { clearInterval(this.chatTimer); },

  setSubscriptionsVisible(message) {
    this.notifyVisible = Boolean(message.watching);
    this.notifyPresenceAt = Date.now();
    if (this.visible === Boolean(message.v)) return;
    this.visible = Boolean(message.v);
    if (this.mode === 'terminal') {
      if (!this.visible) return this.stopTerminalUpdates();
      if (this.terminalId) return this.selectTerminal(this.terminalId, this.terminalSubscription);
      return;
    }
    if (!this.visible) {
      this.navigationFirstScreen = null;
      this.stopChatUpdates();
    }
    if (!this.editorCdp && this.app !== 'opencode' && !this.codexBackend && this.mode !== 'screen') return;
    if (!this.visible && this.mode === 'screen') return this.stopVisual();
    if (this.visible) return this.setMode(this.mode, false, true);
  },

  async syncSubscriptions(mode, firstScreen = false, resumeNavigation = false) {
    if (firstScreen && mode === 'chat' && this.cdp) this.prioritizeNavigationRead(this.cdp, this.editorCdp);
    const connection = this.connectionView.generation;
    const first = this.navigationFirstScreen;
    const sourceAtEntry = nativeWindow(this.cdp);
    // A resume is eligible only for the very same real native snapshot that
    // was delivered in this navigation and has not been invalidated.
    const reuseFirst = () => !!(resumeNavigation && !firstScreen && mode === 'chat'
      && first && first.connection === connection && first.binding.isCurrent(this)
      && this.bindingReady && !this.selectionHome && !this.fusionBinding && !this.codexBackend
      && first.source === sourceAtEntry && sourceAtEntry?.snapshot === first.snapshot
      && sourceAtEntry?.revision === first.revision && sourceAtEntry.readRevision === first.revision
      && sourceAtEntry.cdp.ws?.readyState === 1 && this.lastChat);
    const preserveChat = reuseFirst();
    this.navigationFirstScreen = null;
    const watchGeneration = this.invalidateChatWatchers();
    const watchingView = () => this.connectionView.current(connection) && this.chatWatchGeneration === watchGeneration;
    cdpRead.run(null, () => this.stopChatUpdates());
    this.stopTerminalUpdates();
    this.stopCatalogUpdates();
    if (this.mode === 'screen' && mode !== 'screen') this.stopVisual();
    this.mode = mode === 'screen' || mode === 'terminal' ? mode : 'chat';
    if (this.visible && !this.fusionBinding && !this.codexBackend && ['cursor', 'devin', 'codex'].includes(this.app)) {
      const cdp = this.cdp, app = this.app;
      this.catalogUpdatesStop = subscribeCatalog(app, error => {
        if (!watchingView() || !this.visible || this.cdp !== cdp || this.app !== app || this.switchingThread || !this.bindingReady) return;
        this.catalogError = error ? { app, error } : null;
        if (error) return;
        if (this.catalogRefresh?.watchGeneration === watchGeneration) { this.catalogRefresh.again = true; return; }
        const refresh = this.catalogRefresh = { watchGeneration, again: false };
        this.connectionView.run(() => cdpRead.run(null, async () => {
          do {
            refresh.again = false;
            if (!watchingView() || !this.visible || this.cdp !== cdp || this.app !== app || !this.bindingReady) break;
            await this.deferWindowRead('catalog', () => {
              if (watchingView() && this.visible) return this.listAgents(true, true);
            });
          } while (refresh.again);
        }), connection).catch(error => {
          if (!watchingView()) return;
          this.catalogError = { app, error };
          console.error(`[catalog:${app}] ${error.message}`);
        }).finally(() => { if (this.catalogRefresh === refresh) this.catalogRefresh = null; });
      });
    }
    if (!preserveChat) this.lastChatAt = 0;
    this.stopChatTimer();
    if (this.fusionBinding) return;
    if (this.mode === 'terminal') return;
    if (this.mode === 'screen') {
      visualCapture.subscribe(this);
      const windows = await this.visualList();
      await visualCapture.restore(windows);
      return;
    }
    if (this.app === 'opencode' && this.mode === 'chat') return this.adapter.setMode.call(this);
    if (this.codexBackend && this.mode === 'chat') return this.adapter.setBackendMode.call(this);
    if (!this.editorCdp || this.selectionHome && this.mode === 'chat') return;
    if (this.mode === 'chat') {
      const cdp = this.cdp;
      if (!preserveChat) this.lastChat = '';
      const source = nativeWindow(cdp);
      if (source) {
        const stopWindowWatch = source.subscribe(error => {
          if (!watchingView() || !this.visible || this.mode !== 'chat' || this.cdp !== cdp) return;
          if (error) this.emit({ t: 'status', ok: false, msg: error.message });
          else if (this.app === 'cursor') {
            const newer = this.bindingReady && !this.switchingThread && cursorSource(this.threadId);
            this.connectionView.run(() => {
              const read = newer && newer.cdp.wsUrl !== cdp.wsUrl
                ? cdpRead.run(null, () => this.attach({ id: newer.win.id, windowId: newer.win.id, threadId: this.threadId })) : this.pollChat(true);
              read.catch(error => this.emit({ t: 'status', ok: false, msg: error.message }));
            }, connection);
          } else this.connectionView.run(() => this.pollChat(true).catch(() => {}), connection);
        });
        const owner = this.app === 'codex' && this.codexOwnerRoot && this.threadId && this.threadId === this.selectedThread
          ? { app: 'codex', threadId: this.threadId, host: '', cwd: this.codexOwnerRoot } : null;
        // The window observer follows the visible transcript. A desktop-owned
        // thread can also finish through its own native conversation observer.
        const stopOwnerWatch = owner && source.subscribe(error => {
          if (error || !watchingView() || !this.visible || this.mode !== 'chat' || this.cdp !== cdp
              || this.threadId !== owner.threadId || !this.lastBusy) return;
          source.invalidate();
          this.connectionView.run(() => this.pollChat(true).catch(() => {}), connection);
        }, owner, 'fusion-control');
        this.chatUpdatesStop = () => { stopWindowWatch(); stopOwnerWatch?.(); };
        if (firstScreen) await this.pollChat(true, true);
        else if (!reuseFirst()) await this.pollChat(true);
        return;
      }
      this.chatTimer = cdpRead.run(null, () => setInterval(() => {
        if (watchingView()) this.pollChat().catch(() => {});
      }, 700));
      if (firstScreen) await this.pollChat(true, true);
      const watching = (async () => {
        const stop = await watchChat(cdp, () => {
          if (watchingView() && this.visible && this.mode === 'chat' && this.cdp === cdp)
            this.connectionView.run(() => this.pollChat(true).catch(() => {}), connection);
        });
        if (!watchingView() || this.cdp !== cdp || this.mode !== 'chat') { stop(); return; }
        this.chatUpdatesStop = stop;
      })();
      if (firstScreen) watching.catch(error => {
        if (this.cdp === cdp && this.chatWatchGeneration === watchGeneration && !cdpRead.getStore()?.aborted)
          this.emit({ t: 'status', ok: false, msg: error.message });
      });
      else { await watching; await this.pollChat(); }
    }
  },

  async visualList() {
    try {
      const windows = await visualWindows();
      this.emit({t: 'visualWindows', windows, wayland: isWayland()});
      return windows;
    } catch (error) {
      this.emit({t: 'visual', state: 'error', message: '读取绘图或仿真窗口失败：' + error.message, wayland: isWayland()});
      throw error;
    }
  },

  async visualSelect(id) {
    if (this.mode !== 'screen') return;
    await visualCapture.start(isWayland() ? 'select' : String(id));
  },

  stopVisual() { visualCapture.unsubscribe(this); },
};
