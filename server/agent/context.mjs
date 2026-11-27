import { MOD, NAMED_KEYS, cdpRead, awaitCdpRead, pollUntil } from '../cdp.mjs';
import { EDITORS } from '../config.mjs';
import { helpersCall } from '../page/build.mjs';
import { tapCss } from './primitives.mjs';
import { AgentServices } from './services.mjs';
import { ADAPTERS } from '../apps/index.mjs';
import { resetThinkingCaches } from './thinking-cache.mjs';
import { ConversationRef, SessionBinding } from '../session/binding.mjs';
import { nativeWindow } from '../native-windows.mjs';

export * from './primitives.mjs';

export class AgentContext extends AgentServices {
  constructor({ deviceId = '', emit } = {}) {
    super();
    this.deviceId = deviceId;
    if (emit) this.emit = emit;
    SessionBinding.initialize(this);
    this.lastChat = '';
    this.lastExtractedChat = '';
    this.draftRevision = this.draftGeneration = 0;
    this.pollAgain = null;
    this.resetCaches();
    this.curSession = undefined;
    this.pendingThread = '';
    this.lastPanel = '';
    this.lastBusy = null;
    this.lastTermHash = undefined;
    this.focusCount = 0;
    this.focusTimer = null;
  }



  get adapter() { return ADAPTERS[this.app]; }

  emit() {}

  resetCaches() {
    resetThinkingCaches(this);
    this.tasksTried = new Map();
    this.devinHist = new Map();
    this.devinCmds = new Map();
    this.devinCmdTried = new Map();
    this.thoughtFails = new Map();
    this.itemCache = new Map();
  }



  appMessage(template) {
    if (this.app === 'fusion') return template.replaceAll('{app}', 'Fusion');
    const name = EDITORS.find(ed => ed.app === this.app)?.name || '当前应用';
    return template.replaceAll('{app}', name);
  }

  selectionKey() {
    return ConversationRef.capture(this).key;
  }

  clearViewState() {
    this.expandedTools = new Set();
    this.sel = (this.sel || 0) + 1;
    this.lastChat = '';
    this.lastExtractedChat = '';
    this.pollAgain = null;
    this.lastAttachments = null;
    this.latestThink = null;
    this.thinkTries = new Map();
    resetThinkingCaches(this);
    if (this.fusionBinding) this.itemCache = new Map();
    this.pendingThread = '';
    this.polling = null;
    this.lastDraft = undefined;
  }

  acceptsChat(chat) {
    if (this.selectedThread && chat?.thread && chat.thread !== this.selectedThread) {
      if (this.offThread !== chat.thread) {
        this.offThread = chat.thread;
        this.emit({ t: 'status', ok: false, msg: '桌面窗口已切到其他会话，手机保留原选择；请从项目/会话重新连接' });
      }
      return false;
    }
    this.offThread = '';
    return true;
  }

  async assertSelectedThread() {
    if (!this.selectedThread) return;
    const active = await this.cdp.evaluate(helpersCall('activeThread()'));
    if (active !== this.selectedThread) throw new Error('当前窗口已不在所选会话，请从项目/会话重新连接后操作');
  }

  liveRead(cdp, sel) {
    return cdp && cdp === this.cdp && sel === this.sel && !this.switchingThread;
  }

  async waitFor(call, tries = 10) {
    const cdp = this.cdp, expression = helpersCall(call);
    return pollUntil(() => cdp.evaluate(expression), { timeout: tries * 120, delays: [120] });
  }

  async deferWindowRead(kind, read, source = nativeWindow(this.cdp)) {
    const signal = cdpRead.getStore(), binding = ConversationRef.capture(this);
    const view = this.connectionView, connection = view?.generation;
    const current = () => !signal?.aborted && !this.disposed && binding.isCurrent(this) && (!view || view.current(connection));
    if (!current()) return;
    const run = () => {
      if (!current()) return;
      return view ? view.run(read, connection) : read();
    };
    if (!source) return run();
    let pending = this.windowReadKeys;
    if (pending?.sel !== binding.sel || pending?.connection !== connection) {
      this.cancelWindowReads();
      this.windowReadKeys = pending = { sel: binding.sel, connection, keys: new Map(), controller: new AbortController() };
    }
    if (!pending.keys.has(kind)) pending.keys.set(kind, {});
    const lifetime = pending.controller.signal;
    try {
      return await source.deferBackgroundRead(pending.keys.get(kind), run, signal ? AbortSignal.any([signal, lifetime]) : lifetime);
    } catch (error) {
      if (!lifetime.aborted) throw error;
    }
  }

  cancelWindowReads() {
    this.windowReadKeys?.controller.abort(new Error('窗口或连接已切换，后台读取已失效'));
    this.windowReadKeys = null;
  }



  // Focus emulation breaks real typing while it is on, so it only wraps phone-driven
  // actions that type/tap, and is switched off again shortly after they finish.
  async withChatUiDetails(fn) {
    const previous = this.chatUiDetails;
    let release;
    const pending = this.chatUiDetails = new Promise(resolve => { release = resolve; });
    try {
      if (previous) await awaitCdpRead(previous);
      while (this.focusDone) await awaitCdpRead(this.focusDone);
      cdpRead.getStore()?.throwIfAborted();
      return await fn();
    } finally {
      const done = () => { release(); if (this.chatUiDetails === pending) this.chatUiDetails = null; };
      if (previous) previous.then(done, done);
      else done();
    }
  }
  async typeWithNativeMentions(text, mentions, insert) {
    let rest = text;
    for (const mention of mentions) {
      const at = rest.indexOf(mention.token);
      if (at < 0) continue;
      if (at > 0) await this.typeText(rest.slice(0, at));
      rest = rest.slice(at + mention.token.length);
      if (await insert(mention)) rest = rest.replace(/^ /, '');
      else await this.typeText(mention.token);
    }
    if (rest) await this.typeText(rest);
  }

  async withFocus(fn) {
    while (!this.focusCount && this.chatUiDetails) await awaitCdpRead(this.chatUiDetails);
    cdpRead.getStore()?.throwIfAborted();
    this.focusCount++;
    const connections = [...new Set([this.cdp, this.editorCdp].filter(Boolean))];
    if (this.focusCount === 1) {
      this.focusDone = new Promise(resolve => { this.finishFocus = resolve; });
      clearTimeout(this.focusTimer);
      this.focusTimer = null;
      for (const c of connections) await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    }
    try { cdpRead.getStore()?.throwIfAborted(); return await fn(); }
    finally {
      this.focusCount = Math.max(0, this.focusCount - 1);
      if (!this.focusCount) { this.finishFocus?.(); this.focusDone = this.finishFocus = null; }
      if (!this.focusCount && !this.focusTimer) {
        this.focusTimer = setTimeout(() => {
          this.focusTimer = null;
          cdpRead.run(null, () => { for (const c of connections) c.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {}); });
        }, 1500);
      }
    }
  }

  tapCss(x, y, button = 'left', cdp = this.cdp) {
    return tapCss(cdp, x, y, button);
  }

  async key(combo, opts = {}) {
    const cdp = opts.cdp || this.cdp;
    const parts = combo.split('+');
    const name = parts.pop();
    const modifiers = parts.reduce((m, p) => m | (MOD[p] || 0), 0);
    let spec = NAMED_KEYS[name];
    if (!spec && name.length === 1) {
      const up = name.toUpperCase();
      spec = { code: /[A-Z]/.test(up) ? `Key${up}` : /\d/.test(up) ? `Digit${up}` : '', vk: up.charCodeAt(0), text: name };
    }
    if (!spec) throw new Error(`未知按键: ${combo}`);
    const withText = spec.text && !(modifiers & (MOD.Ctrl | MOD.Meta));
    const ev = { key: name, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, modifiers };
    await cdp.send('Input.dispatchKeyEvent', { type: withText ? 'keyDown' : 'rawKeyDown', ...ev, ...(withText ? { text: spec.text } : {}) });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
  }

  async typeText(text, cdp = this.cdp) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await this.key('Shift+Enter', { cdp });
      if (lines[i]) await cdp.send('Input.insertText', { text: lines[i] });
    }
  }

  async clickButton(item, n, actionId, label, sel, requestId) {
    let clicked = false;
    try {
    await this.assertSelectedThread();
    if (sel != null && sel !== this.selectionKey()) throw new Error('会话已切换，请使用当前会话的按钮');
    const terminalDecision = this.app === 'cursor' && actionId && (label === 'Run' || label === 'Skip')
      && await this.cdp.evaluate(helpersCall(`nativeSessionAction('cursor', ${JSON.stringify(this.threadId)}, 'terminalPermission', ${JSON.stringify({ item, actionId, label })})`));
    if (!terminalDecision) {
      const pos = await this.cdp.evaluate(helpersCall(`locate(${JSON.stringify(String(item))}, ${Number(n) || 0}, ${JSON.stringify(actionId || '')}, ${JSON.stringify(label || '')})`));
      if (!pos) { await this.pollChat(true); throw new Error('请求已更新，请查看最新选项'); }
      if (/^(Fork chat from here|Open agent|View agent|View subagent)$/.test(label || '')) this.selectedThread = '';
      if (pos.fork) {
        if (!await this.cdp.evaluate(helpersCall(`forkCodexTurn(${JSON.stringify(String(item))})`))) throw new Error('请求已更新，请查看最新选项');
      } else await this.tapCss(pos.x, pos.y);
    }
    clicked = true;
    await new Promise(r => setTimeout(r, 200));
    await this.pollChat(true);
    } finally { this.emit({ t: 'clickDone', item, actionId, sel, clicked, requestId }); }
  }
  }
