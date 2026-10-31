// 对话：聊天轮询、历史加载、发送与附件
import fs from 'node:fs';
import path from 'node:path';
import { IS_MAC, mod } from '../../lib/platform.mjs';
import { codexContext } from '../windows.mjs';
import { cdpRead, awaitCdpRead } from '../cdp.mjs';
import { PAGE_SRC, helpersCall } from '../page/build.mjs';
import { FOCUS_COMPOSER, uploads } from './context.mjs';
import { rememberSessionMessage, observeSessionTitle, readLibrary } from '../../lib/session-library.mjs';
import { nativeWindow } from '../native-windows.mjs';

// Cursor accepts images pasted into the composer; a synthetic paste event carrying a File works the same way.
const pasteImage = (b64, name, type) => `(async () => {
  if (!${FOCUS_COMPOSER}) return null;
  const doc = document.getElementById('active-frame')?.contentDocument || document;
  const ed = doc.activeElement.closest('[contenteditable="true"]') || doc.activeElement;
  let box = ed;
  for (let i = 0; i < 8 && box.parentElement; i++) box = box.parentElement;
  const nodes = () => [...doc.querySelectorAll('.context-pill-image, .image-pill-img, img[alt="Attached image"], .agent-panel-composer-pill')];
  const before = new Set(nodes());
  const beforeImages = box.querySelectorAll('img').length;
  const html = ed.innerHTML;
  const bin = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0));
  const dt = new doc.defaultView.DataTransfer();
  dt.items.add(new doc.defaultView.File([bin], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
  ed.dispatchEvent(new doc.defaultView.ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  for (let i = 0; i < 30; i++) {
    if (nodes().some(el => !before.has(el))) return true;
    if (ed.innerHTML !== html && /<img|blob:|Attached image/i.test(ed.innerHTML)) return true;
    if (box.querySelectorAll('img').length > beforeImages) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return nodes().some(el => !before.has(el));
})()`;


export const methods = {
  refreshSoon(ms) {
    return setTimeout(() => this.pollChat().catch(() => {}), ms);
  },

  thinkingBody(it) {
    return (it?.t || '').split('\n').slice(1).join('\n');
  },
  thinkingTitle(it) {
    return (it?.t || '').split('\n')[0] || '思考';
  },


  // The live block's id often changes when the turn finishes. Keep that text on the newest block.
  noteLiveThinking(it) {
    const body = this.thinkingBody(it);
    if (!it?.live || !body) return;
    const prev = this.latestThink?.id === it.i ? (this.latestThink.body || '') : '';
    this.latestThink = { id: it.i, body: body.length >= prev.length ? body : prev, at: Date.now() };
  },
  rememberThinking(chat) {
    for (const it of chat?.items || []) {
      if (it.k !== 'thinking') continue;
      const body = this.thinkingBody(it);
      const prev = this.thinking.get(it.i)?.body || '';
      const next = body.length >= prev.length ? body : prev;
      if (next) this.thinking.set(it.i, { body: next });
      this.noteLiveThinking(it);
    }
    const keep = this.latestThink?.id;
    while (this.thinking.size > 12) {
      const oldest = this.thinking.keys().next().value;
      if (oldest === keep) {
        const saved = this.thinking.get(oldest);
        this.thinking.delete(oldest);
        this.thinking.set(oldest, saved);
        if (this.thinking.size === 1) break;
        continue;
      }
      this.thinking.delete(oldest);
    }
  },
  fillThinking(chat) {
    const thoughts = (chat?.items || []).filter(it => it.k === 'thinking');
    for (const it of thoughts) {
      const saved = this.thinking.get(it.i)?.body || '';
      const body = this.thinkingBody(it);
      if (saved.length > body.length) it.t = `${this.thinkingTitle(it)}\n${saved}`;
      this.noteLiveThinking(it);
    }
    const last = thoughts[thoughts.length - 1];
    const carried = this.latestThink;
    if (last && carried?.body && last.i === carried.id && this.thinkingBody(last).length < carried.body.length) {
      itAssign(last, carried.body);
      this.thinking.set(last.i, { body: carried.body });
    }
    // Always send the newest trace. Drop older bodies once the payload gets large.
    let used = 0;
    const budget = 80000;
    for (let i = thoughts.length - 1; i >= 0; i--) {
      const it = thoughts[i];
      const title = this.thinkingTitle(it);
      const body = this.thinkingBody(it);
      const newest = i === thoughts.length - 1;
      if (!newest && body && used + body.length > budget) {
        it.t = title;
        continue;
      }
      used += body.length;
      delete it.h;
    }
    function itAssign(it, body) {
      it.t = `${(it.t || '').split('\n')[0] || '思考'}\n${body}`;
    }
  },


  // Cursor removes a finished thinking row from the transcript. Put the text we already
  // streamed back in front of that reply. Older traces are omitted once the payload is large.
  retainThinking(chat) {
    if (!chat?.items) return;
    if (!this.keptThink) this.keptThink = new Map();
    const items = chat.items;
    let prev = null;
    for (const it of items) {
      if (it.k !== 'thinking') { prev = it.i; continue; }
      const body = this.thinkingBody(it);
      const old = this.keptThink.get(it.i);
      const best = body.length >= (old?.body || '').length ? body : (old?.body || '');
      let title = this.thinkingTitle(it);
      if (/^thinking$/i.test(title) && old?.title && !/^thinking$/i.test(old.title)) title = old.title;
      this.keptThink.set(it.i, { i: it.i, title, body: best, after: prev, at: Date.now() });
    }
    const present = new Set(items.map(it => it.i));
    let missing = [...this.keptThink.values()].filter(k => k.body && !present.has(k.i) && k.after && items.some(it => it.i === k.after));
    missing.sort((a, b) => b.at - a.at);
    let used = items.filter(it => it.k === 'thinking').reduce((n, it) => n + this.thinkingBody(it).length, 0);
    const allow = new Set();
    for (const k of missing) {
      if (!allow.size || used + k.body.length <= 80000) {
        allow.add(k.i);
        used += k.body.length;
      }
    }
    missing = missing.filter(k => allow.has(k.i)).sort((a, b) => a.at - b.at);
    const placed = new Map();
    for (const k of missing) {
      const at = items.findIndex(it => it.i === k.after);
      if (at < 0) continue;
      const n = placed.get(k.after) || 0;
      const title = /^thinking$/i.test(k.title) ? 'Thought' : k.title;
      items.splice(at + 1 + n, 0, { i: k.i, k: 'thinking', t: `${title}\n${k.body}` });
      placed.set(k.after, n + 1);
    }
    if (this.keptThink.size > 24) {
      const ranked = [...this.keptThink.entries()].sort((a, b) => a[1].at - b[1].at);
      for (const [id] of ranked) {
        if (this.keptThink.size <= 16) break;
        if (id === this.latestThink?.id) continue;
        this.keptThink.delete(id);
      }
    }
  },
  async pollChat(immediate = false, firstScreen = false) {
    if (this.selectionHome) return;
    firstScreen &&= !this.fusionOwner;
    const cdp = this.cdp;
    const sel = this.sel;
    if (this.polling === sel && this.chatRead?.cdp === cdp) {
      if (firstScreen) return awaitCdpRead(this.chatRead.requestFirst());
      if (immediate) this.pollAgain = sel;
      return;
    }
    if (!cdp || !this.visible && !firstScreen || this.pendingProject?.trust || this.switchingThread || this.historyLoading || (this.fusionHold?.app === this.app && this.fusionHold?.windowId === this.windowId)) {
      if (firstScreen) throw new Error('当前会话尚未就绪，请重试');
      return;
    }
    if (!immediate && !firstScreen && Date.now() - (this.lastChatAt || 0) < (this.lastBusy ? 650 : 1800)) return;
    this.lastChatAt = Date.now();
    this.polling = sel;
    const controller = new AbortController(), parent = cdpRead.getStore();
    const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
    signal.navigationId = parent?.navigationId;
    const state = this.chatRead = { cdp, sel, controller, requested: false, sent: false, retrying: false };
    state.requestFirst = () => {
      if (!state.requested || state.sent) {
        state.sent = false;
        state.first = new Promise((resolve, reject) => { state.resolve = resolve; state.reject = reject; });
        state.first.catch(() => {});
      }
      state.requested = true;
      return state.first;
    };
    const first = firstScreen && state.requestFirst();
    const done = cdpRead.run(signal, () => this.pollChatRead(immediate, state));
    done.then(() => {
      if (state.requested && !state.sent && !state.retrying) state.reject(new Error('当前会话内容尚未就绪，请重试'));
    }, error => {
      state.reject?.(error);
      if (firstScreen && state.sent && this.liveRead(cdp, sel)) this.emit({ t: 'status', ok: false, msg: error.message });
    });
    return firstScreen ? awaitCdpRead(first) : done;
  },
  async pollChatRead(immediate, state) {
    const { cdp, sel } = state;
    const sendGen = this.sendGen || 0;
    const draftGeneration = this.draftGeneration, draftRevision = this.draftRevision;
    const readDraft = !this.mentionBusy && !this.draftWriting && !this.queueEditing;
    const publish = chat => {
      cdpRead.getStore()?.throwIfAborted();
      this.emit({ t: 'chat', sel: this.selectionKey(), chat });
      if (state.requested) { state.sent = true; state.resolve(); }
    };
    this.codexFreshView = false;
    const read = async () => {
      const child = this.mainTab?.cdp === cdp ? this.mainTab.child || '' : '';
      const known = (this.itemCache?.get(this.threadId || '')?.completeTurns || []).map(([id]) => id);
      const source = nativeWindow(cdp);
      const chat = source?.win ? structuredClone((await source.read(state.requested && !state.sent)).chat)
        : await cdp.evaluate(`(() => { const h = ${PAGE_SRC}, chat = h.extract(false, ${JSON.stringify(known)}, ${this.app === 'codex' && !this.fusionOwner ? 80 : 0}); if (chat) chat.subagent = !!(${JSON.stringify(child)} && h.activeChatTab() === ${JSON.stringify(child)} && chat.readonly); return chat; })()`);
      if (chat && source?.win) chat.subagent = !!(child && source.snapshot.activeTab === child && chat.readonly);
      if (chat) delete chat._revision;
      return chat;
    };
    try {
      let chat = await read();
      if (!this.liveRead(cdp, sel) || !this.acceptsChat(chat)) return;
      if (!chat && this.liveRead(cdp, sel) && await this.checkProjectTrust()) return;
      if (!chat && this.app === 'codex' && this.liveRead(cdp, sel) && await this.checkCodexLogin()) return;
      if (!this.liveRead(cdp, sel) || this.historyLoading) return;
      if (!this.acceptsChat(chat)) return;
      this.syncSession(chat);
      for (const file of uploads.values()) if (file.pending && file.awaitingReceipt && file.sel === this.selectionKey()
        && chat?.items.some(item => item.k === 'human' && item.t?.split('\n').includes(file.path))) file.pending = false;
      if (chat?.thread && chat.title && readLibrary()[this.app]?.[chat.thread]?.title && chat.title !== readLibrary()[this.app][chat.thread].title) {
        const title = await cdp.evaluate(helpersCall(`nativeConfirmedTitle(${JSON.stringify(this.app)}, ${JSON.stringify(chat.thread)})`));
        if (!this.liveRead(cdp, sel)) return;
        observeSessionTitle(this.app, chat.thread, title);
      }
      if (chat?.thread && chat.thread === this.threadId) rememberSessionMessage(this.app, chat.thread,
        Math.max(0, ...chat.items.filter(it => it.k === 'human').map(it => Number(it.sentAt) || 0)));
      if (this.app === 'codex' && chat) {
        if (chat.context) this.codexPageContext = { cdp, thread: chat.thread,
          value: { pct: chat.context.basis === 'remaining' ? 100 - chat.context.pct : chat.context.pct, basis: 'used' } };
        const page = this.codexPageContext;
        chat.context = page?.cdp === cdp && page.thread === chat.thread ? page.value : await awaitCdpRead(codexContext(chat.thread));
        if (!this.liveRead(cdp, sel) || !this.acceptsChat(chat)) return;
      }
      const emptyCodex = this.app === 'codex' && !this.threadId && !this.selectedThread && !chat?.thread && chat?.items?.length === 0 && (!chat.readonly || chat.empty === true);
      const extracted = chat && JSON.stringify({ ...chat, draft: undefined });
      if (this.app !== 'codex' && chat && chat.thread === (this.threadId || '') && (!this.lastChat || extracted !== this.lastExtractedChat || state.requested && !state.sent)) {
        const initial = { ...chat, items: chat.items.map(it => ({ ...it })) };
        delete initial.draft;
        this.mergeCodexItems(initial);
        this.lastExtractedChat = extracted;
        this.fillThinking(initial);
        this.retainThinking(initial);
        this.fillDevinCommands(initial);
        this.mergeDevinHistory(initial);
        if (initial?.model === 'Fusion' && this.fusion) initial.fusion = this.fusion;
        this.lastChat = JSON.stringify(initial);
        publish(initial);
      }
      const thinkingAction = async action => {
        const result = await cdp.evaluate(helpersCall(action));
        nativeWindow(cdp)?.invalidate();
        return result;
      };
      const details = fn => state.requested && state.sent
        ? this.withChatUiDetails(() => this.liveRead(cdp, sel) ? fn() : undefined) : fn();
      const readThinking = async () => {
        const liveClosed = this.app !== 'devin' && (chat?.items || []).some(it => it.k === 'thinking' && it.live && !(it.t || '').includes('\n'));
        if (liveClosed) {
          const idxs = await cdp.evaluate(helpersCall(`closedThinkingIndexes('live')`));
          if (!this.liveRead(cdp, sel)) return;
          if (idxs?.length) {
            if (!await thinkingAction(`clickThinking(${JSON.stringify(idxs)})`)) return;
            await new Promise(r => setTimeout(r, 250));
            if (!this.liveRead(cdp, sel)) return;
            chat = await read();
          }
        }
        if (!this.liveRead(cdp, sel)) return;
        const needFinal = this.app !== 'devin' && (chat?.items || []).some(it => it.k === 'thinking' && !it.live && !(it.t || '').includes('\n') && !this.thinkingTried.has(it.i));
        if (needFinal) {
          const idxs = await cdp.evaluate(helpersCall(`closedThinkingIndexes('done')`));
          if (!this.liveRead(cdp, sel)) return;
          if (idxs?.length) {
            if (!await thinkingAction(`clickThinking(${JSON.stringify(idxs)})`)) return;
            await new Promise(r => setTimeout(r, 250));
            if (!this.liveRead(cdp, sel)) return;
            chat = await read();
            if (!this.liveRead(cdp, sel)) return;
            await thinkingAction(`closeThinkingIfOpen(${JSON.stringify(idxs)})`);
          }
        }
      };
      // Only the native expand/read/fold transaction competes with Cursor's model menu.
      if (this.app !== 'codex') await details(async () => {
      if (this.app === 'cursor' && chat?.items?.some(it => it.k === 'thinking' && !this.thinkingBody(it) && (it.live || !this.thinkingTried.has(it.i))))
        await this.withCursorUiRead(readThinking);
      else await readThinking();
      });
      if (!this.liveRead(cdp, sel) || this.historyLoading || !chat) return;
      if (!this.acceptsChat(chat)) return;
      const prevThread = this.threadId || '';
      if (this.app === 'codex' && !chat.thread && !emptyCodex) { this.pendingThread = ''; return; }
      if (chat.thread !== prevThread) {
        if (this.app === 'codex' && this.pendingThread !== chat.thread) {
          this.pendingThread = chat.thread;
          this.lastChatAt = 0;
          return;
        }
        if (this.app === 'devin') { this.sel++; this.lastChat = ''; this.lastAttachments = null; }
        else this.clearViewState();
        this.threadId = chat.thread || '';
        this.publishThread('桌面上的会话已切换');
        this.lastChatAt = 0;
        return;
      }
      this.pendingThread = '';
      this.lastBusy = !!chat.busy;
      if (!this.liveRead(cdp, sel)) return;
      this.mergeCodexItems(chat);
      const draft = chat.draft;
      delete chat.draft;
      if (immediate && this.app !== 'codex') {
        if (chat?.model === 'Fusion' && this.fusion) chat.fusion = this.fusion;
        this.fillThinking(chat);
        this.retainThinking(chat);
        this.fillDevinCommands(chat);
        this.mergeDevinHistory(chat);
        if (this.app === 'devin') this.devinGeneration(chat);
        const json = JSON.stringify(chat);
        if ((json !== this.lastChat || state.requested && !state.sent) && this.liveRead(cdp, sel)) {
          this.lastChat = json;
          publish(chat);
        }
      }
      // A draft read before or during a send is the text being sent; pushing it would refill the phone's box.
      if (readDraft && !this.mentionBusy && !this.draftWriting && !this.queueEditing && draftGeneration === this.draftGeneration
        && draft !== undefined && draft !== this.lastDraft && !this.sending && (this.sendGen || 0) === sendGen && this.liveRead(cdp, sel)) {
        this.lastDraft = draft;
        this.emit({ t: 'draft', sel: this.selectionKey(), text: draft, draftEpoch: this.draftEpoch || '', revision: draftRevision });
      }
      // Devin task lists: read details for the current count and restore the original expansion state.
      await details(async () => {
      const taskRow = (chat?.items || []).find(it => it.k === 'tasks' && !it.items && this.tasksTried.get(it.i) !== `${it.done}/${it.total}`);
      if (taskRow) {
        const wasOpen = await cdp.evaluate(helpersCall(`setTasksOpen(${JSON.stringify(taskRow.i)}, true)`));
        if (wasOpen != null) {
          try {
            await new Promise(r => setTimeout(r, 250));
            const opened = await read();
            const tasks = opened?.items?.find(it => it.k === 'tasks' && it.i === taskRow.i && it.items);
            if (tasks) {
              this.tasksTried.set(taskRow.i, `${tasks.done}/${tasks.total}`);
              chat = opened;
            }
          } finally {
            if (!wasOpen) await cdp.evaluate(helpersCall(`setTasksOpen(${JSON.stringify(taskRow.i)}, false)`));
          }
        }
      }
      if (!this.liveRead(cdp, sel) || !this.acceptsChat(chat)) return;
      this.fillDevinCommands(chat);
      for (const item of (chat?.items || []).filter(it => it.src === 'devin' && it.kind === 'command' && !it.cmd)) {
        const cached = this.devinHist.get(item.i)?.cmd;
        if (cached) { item.cmd = cached; continue; }
        // A card whose text could not be read is retried at most every 30 s, not on every poll.
        if (Date.now() - (this.devinCmdTried.get(item.i) || 0) < 30000) continue;
        this.devinCmdTried.set(item.i, Date.now());
        const wasOpen = await cdp.evaluate(helpersCall(`setCommandOpen(${JSON.stringify(item.i)}, true)`));
        if (wasOpen == null) continue;
        try {
          await new Promise(r => setTimeout(r, 150));
          const full = await read();
          const command = full?.items?.find(it => it.i === item.i && it.cmd);
          if (command) { Object.assign(item, command); this.devinCmds.set(item.i, command.cmd); }
        } finally {
          if (!wasOpen) await cdp.evaluate(helpersCall(`setCommandOpen(${JSON.stringify(item.i)}, false)`));
        }
      }
      await this.captureThoughts(chat);
      });
      if (!this.liveRead(cdp, sel) || !this.acceptsChat(chat)) return;
      this.fillThinking(chat);
      this.rememberThinking(chat);
      this.retainThinking(chat);
      this.mergeDevinHistory(chat);
      const finished = this.app === 'devin' || (this.app === 'codex' && chat.busy) ? [] : (chat?.items || []).filter(it => it.k === 'thinking' && !it.live);
      finished.forEach((it, i) => {
        const has = this.thinkingBody(it).length > 0;
        const newest = i === finished.length - 1;
        if (has || !newest) this.thinkingTried.set(it.i, 1);
        else {
          const n = (this.thinkTries?.get(it.i) || 0) + 1;
          if (!this.thinkTries) this.thinkTries = new Map();
          this.thinkTries.set(it.i, n);
          if (n >= 3) this.thinkingTried.set(it.i, 1);
        }
      });
      if (chat?.model === 'Fusion') {
        if (this.fusion) chat.fusion = this.fusion;
        else this.queueFusionRead();
      } else this.fusion = null;
      if (this.app === 'devin') this.devinGeneration(chat);
      const json = JSON.stringify(chat);
      if (!this.liveRead(cdp, sel) || this.historyLoading || !this.acceptsChat(chat)) return;
      if (json !== this.lastChat || state.requested && !state.sent) {
        this.lastChat = json;
        publish(chat);
      }
      this.syncAttachments().catch(() => {});
    } finally {
      if (this.chatRead === state) {
        this.chatRead = null;
        this.polling = null;
        if (this.pollAgain === sel) {
          this.pollAgain = null;
          if (!cdpRead.getStore()?.aborted) {
            state.retrying = state.requested && !state.sent;
            this.pollChat(true, state.retrying).then(() => {
              if (state.retrying) state.resolve();
            }, error => {
              if (state.retrying) state.reject(error);
            });
          }
        }
      }
    }
  },
  async sendPanelRect() {
    const rect = await this.editorCdp.evaluate(helpersCall('panelRect()')).catch(() => null);
    const json = JSON.stringify(rect);
    if (json !== this.lastPanel) {
      this.lastPanel = json;
      this.emit({ t: 'panel', rect });
    }
  },
  // Devin shows a command's text only while its card is expanded. Once read (by briefly expanding the
  // card) it is kept here, so every emitted item carries it and later polls never toggle the card again.
  fillDevinCommands(chat) {
    if (this.app !== 'devin') return;
    this.syncSession(chat);   // acp ids repeat across sessions: switch to this session's cache first
    if (!this.devinCmds?.size) return;
    for (const it of chat?.items || []) if (it.src === 'devin' && it.kind === 'command' && !it.cmd && this.devinCmds.has(it.i)) it.cmd = this.devinCmds.get(it.i);
  },
  async editQueued(id, text) {
    if (!text.trim()) throw new Error('内容不能为空；不想要这条就点「删除」');
    await this.assertSelectedThread();
    const editing = { cdp: this.cdp, sel: this.selectionKey(), draft: await this.cdp.evaluate(helpersCall('composerDraft()')) };
    this.queueEditing = editing;
    this.draftGeneration++;
    let saved = false;
    try {
      await this.queueAction(id, 'edit');
      const result = await this.adapter.editQueued.call(this, id, text);
      saved = true;
      return result;
    } finally {
      if (this.queueEditing === editing) {
        this.queueEditing = null;
        this.draftGeneration++;
        if (saved && this.cdp === editing.cdp && this.selectionKey() === editing.sel) {
          const request = editing.request;
          const draft = request?.text === undefined ? editing.draft : String(request.text);
          const restore = async () => {
            if (!await editing.cdp.evaluate(FOCUS_COMPOSER)) return false;
            await this.key(mod('A'), { cdp: editing.cdp });
            await this.key('Backspace', { cdp: editing.cdp });
            await this.typeText(draft || '', editing.cdp);
            return await editing.cdp.evaluate(helpersCall('composerDraft()')) === (draft || '').replace(/\n+$/g, '');
          };
          const ok = this.app === 'codex' && !draft ? true : await restore().catch(() => false);
          if (ok) this.lastDraft = draft || '';
          if (request) this.emit({ t: 'draftAck', sel: editing.sel, ok, text: draft, read: request.text === undefined, draftEpoch: request.draftEpoch || '', revision: request.revision });
        }
      }
    }
  },
  async queuedText(id) {
    await this.assertSelectedThread();
    const text = await this.cdp.evaluate(helpersCall(`queueText(${JSON.stringify(String(id))})`));
    if (typeof text !== 'string') throw new Error('这条排队消息已经不在了');
    return text;
  },
  async queueAction(id, action) {
    await this.assertSelectedThread();
    if (!['send', 'remove', 'edit'].includes(action)) throw new Error('不支持的排队操作');
    return this.adapter.queueAction.call(this, id, action);
  },
  async stopButton(message) {
    const cdp = this.cdp, scope = this.selectionKey();
    if (message.sel && message.sel !== scope) return;
    await nativeWindow(cdp)?.stopRetry();
    await this.assertSelectedThread();
    if (cdp !== this.cdp || scope !== this.selectionKey()) return;
    const clicked = await cdp.evaluate(helpersCall('stopTarget(true)'));
    if (cdp === this.cdp && scope === this.selectionKey()) this.emit({ t: 'status', msg: clicked ? '已点击停止' : '当前没有停止按钮' });
  },
  async stopAgent() {
    await this.assertSelectedThread();
    const pos = await this.cdp.evaluate(helpersCall('stopTarget()'));
    const running = !!(await this.cdp.evaluate(helpersCall('agentState()')))?.busy;
    if (!pos && !(this.app === 'devin' && running)) throw new Error('Agent 当前没有在运行');
    if (pos) await this.tapCss(pos.x, pos.y);
    else {
      // Devin shows "Queue" instead of "Cancel" while the desktop prompt holds a draft, so there is no stop
      // button; its own cancel shortcut (shown in the button tooltip: Ctrl+Alt+C, Ctrl+C on a Mac) still works.
      if (!await this.cdp.evaluate(FOCUS_COMPOSER)) throw new Error('没找到可见的聊天输入框');
      await this.key(IS_MAC ? 'Ctrl+c' : 'Ctrl+Alt+c');
    }
    this.emit({ t: 'status', ok: true, msg: '正在停止…' });
    // A running command has to be killed first, so Devin can take several seconds to finish cancelling.
    let busy = true;
    for (let i = 0; i < 48; i++) {
      await new Promise(r => setTimeout(r, 250));
      busy = !!(await this.cdp.evaluate(helpersCall('agentState()')))?.busy;
      if (!busy) break;
    }
    await this.pollChat().catch(() => {});
    if (busy) throw new Error(pos ? '没有停下来，Agent 仍在运行，请到电脑上看一下' : '没有停下来：电脑上的输入框里还有没发出的文字，Devin 没有停止按钮。清空输入框，或在电脑上按 Ctrl+Alt+C');
    this.emit({ t: 'status', ok: true, msg: '已停止 Agent' });
  },
  async scrollChat(dy, automatic = false, history = false, beforeOrder = null, known = [], details = false) {
    if (this.app === 'codex' && history) {
      const cdp = this.cdp, sel = this.sel, thread = this.threadId;
      const page = await cdp.evaluate(helpersCall(`codexHistoryPage(${JSON.stringify(beforeOrder)}, ${JSON.stringify(known)}, ${details === true})`));
      if (!this.liveRead(cdp, sel) || page.thread !== thread) return;
      const snapshot = { ...page, historyBefore: page.before, _historyEarlier: page.earlier, busy: this.lastBusy };
      this.mergeCodexItems(snapshot);
      page.items = snapshot.items;
      return page;
    }
    if (this.app === 'codex') {
      if (this.historyLoading) return { pending: true };
      const cdp = this.cdp, sel = this.sel, thread = this.threadId;
      this.historyLoading = true;
      let before;
      try {
        before = await cdp.evaluate(helpersCall('scrollCodexHistory(false)'));
        if (!this.codexHistoryTop) this.codexHistoryTop = new Map();
        const top = this.codexHistoryTop.get(thread);
        if (before && top != null) {
          const rows = await cdp.evaluate(helpersCall('historyRows()'));
          await cdp.evaluate(helpersCall(`scrollCodexHistory(${top})`));
          await cdp.evaluate(helpersCall(`waitHistoryRows(${JSON.stringify(rows)}, 150)`));
        }
        if (!this.liveRead(cdp, sel)) return;
        const point = before && await cdp.evaluate(helpersCall('scrollCodexHistory()'));
        if (point) {
          const rows = await cdp.evaluate(helpersCall('historyRows()'));
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: dy });
          await cdp.evaluate(helpersCall(`waitHistoryRows(${JSON.stringify(rows)})`));
          const chat = await cdp.evaluate(helpersCall('extract(true)'));
          if (!this.liveRead(cdp, sel) || chat?.thread !== thread) return;
          const live = new Map((this.itemCache?.get(thread) || []).map(it => [it.i, it]));
          chat.items = chat.items.map(it => live.get(it.i) || it);
          this.mergeCodexItems({ ...chat, busy: true, capacityPresent: undefined });
          chat.items = this.itemCache.get(thread);
          const after = await cdp.evaluate(helpersCall('scrollCodexHistory(false)'));
          if (after) this.codexHistoryTop.set(thread, after.scrollTop);
          await cdp.evaluate(helpersCall(`scrollCodexHistory(${before.scrollTop})`));
          before = null;
          if (!this.liveRead(cdp, sel)) return;
          this.lastChat = JSON.stringify(chat);
          this.emit({ t: 'chat', sel: this.selectionKey(), chat });
          return { earlier: chat.earlier };
        }
      } finally {
        try {
          if (before && this.liveRead(cdp, sel) && await cdp.evaluate(helpersCall('codexThread()')) === thread) await cdp.evaluate(helpersCall(`scrollCodexHistory(${before.scrollTop})`));
        } finally {
          this.historyLoading = false;
          this.lastChatAt = 0;
        }
      }
    }
    const rect = await this.cdp.evaluate(helpersCall('panelRect()'));
    if (!rect) return history ? { error: '没有找到桌面聊天面板' } : undefined;
    if (history) {
      if (this.historyLoading) return { pending: true };
      const cdp = this.cdp, sel = this.sel, thread = this.threadId;
      this.historyLoading = true;
      let position;
      try {
        position = await cdp.evaluate(helpersCall('historyPosition()'));
        if (this.app === 'cursor') {
          const cursor = this.cursorHistory;
          if (cursor?.cdp === cdp && cursor.thread === thread && (cursor.before === beforeOrder || cursor.nextBefore === beforeOrder)) {
            const rows = await cdp.evaluate(helpersCall('historyRows()'));
            await cdp.evaluate(helpersCall(`historyPosition(${JSON.stringify({ top: cursor.top })})`));
            await cdp.evaluate(helpersCall(`waitHistoryRows(${JSON.stringify(rows)}, 150)`));
          }
        }
        if (this.app === 'devin') await cdp.evaluate(helpersCall('devinLoadEarlier()'), { timeout: 8000 });
        else {
          const rows = await cdp.evaluate(helpersCall('historyRows()'));
          const [x, y, w, h] = rect;
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: x + w / 2, y: y + h / 2, deltaX: 0, deltaY: dy });
          await cdp.evaluate(helpersCall(`waitHistoryRows(${JSON.stringify(rows)})`));
        }
        const chat = await cdp.evaluate(helpersCall('extract()'));
        if (!this.liveRead(cdp, sel) || chat?.thread !== thread) return;
        if (this.app === 'devin') this.mergeDevinHistory(chat, true);
        const earlier = !await cdp.evaluate(helpersCall('historyAtStart()'));
        if (this.app === 'cursor') {
          const after = await cdp.evaluate(helpersCall('historyPosition()'));
          this.cursorHistory = after && { cdp, thread, before: beforeOrder, nextBefore: chat.items[0]?.i, top: after.top };
        }
        return { thread, items: chat.items, earlier: this.app === 'devin' ? chat.earlier : earlier };
      } finally {
        try {
          if (position && this.liveRead(cdp, sel) && await cdp.evaluate(helpersCall('activeThread()')) === thread)
            await cdp.evaluate(helpersCall(`historyPosition(${JSON.stringify(position)})`));
        } finally {
          this.historyLoading = false;
          this.lastChatAt = 0;
        }
      }
    }
    const [x, y, w, h] = rect;
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: x + w / 2, y: y + h / 2, deltaX: 0, deltaY: dy });
    this.refreshSoon(400);
  },


  // Phone typed "@q" (or tapped a category): list what Devin offers, then put the prompt back.
  async mentionQuery(q, cat, seq, trigger, query) {
    return this.adapter.mentionQuery.call(this, q, cat, seq, trigger, query);
  },
  async withComposerQuery(query, fn) {
    const cdp = this.cdp;
    const value = query.text.slice(0, query.start) + query.text.slice(query.caret);
    try {
      await cdp.evaluate(helpersCall(`composerQuery(${JSON.stringify(value)}, ${query.start})`));
      return await fn(value);
    } finally {
      await cdpRead.run(null, () => cdp.evaluate(helpersCall('composerQuery("", 0, true)')));
    }
  },
  async submitPromptKey(key, queued) {
    const cdp = this.cdp, scope = this.selectionKey(), receipt = this.sendNativeReceipt;
    const read = timeout => cdp.evaluate(`(() => {
      const h = ${PAGE_SRC}, chat = h.extract();
      return { thread: chat?.thread || '', draft: h.composerDraft(),
        human: (chat?.items || []).filter(it => it.k === 'human'), queued: chat?.queued || [] };
    })()`, { timeout });
    const norm = value => (value || '').replace(/\s+/g, ' ').trim();
    const before = await read(), expected = norm(before.draft);
    this.lastDraft = before.draft;
    const human = new Set(before.human.map(it => `${it.i}:${it.sentAt || ''}`));
    const queues = new Set(before.queued.map(it => it.id));
    const queueText = norm(before.draft.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000));
    const queuedMatches = rows => rows.filter(it => norm(it.t) === queueText).length;
    await this.key(key);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      let after;
      try { after = await read(Math.max(1, deadline - Date.now())); } catch { break; }
      if (this.cdp !== cdp || this.selectionKey() !== scope || before.thread && after.thread && after.thread !== before.thread) break;
      const item = after.human.find(it => !human.has(`${it.i}:${it.sentAt || ''}`)
        && (!expected || norm((it.t || '').replace(/(?:^|\n)\[(?:图片|附件) \d+\](?:\n\[(?:图片|附件) \d+\])*$/, '')) === expected));
      if (item) { receipt.messageId = item.i; return false; }
      const pending = after.queued.find(it => norm(it.t) === queueText
        && (!queues.has(it.id) || this.app === 'devin' && queuedMatches(after.queued) > queuedMatches(before.queued)));
      if (pending) { receipt.queueId = pending.id; return true; }
      await new Promise(resolve => setTimeout(resolve, 125));
    }
    receipt.pending = true;
    return queued;
  },

  async sendMessage(text, submit, when, mentions, receipt) {
    const receiptToken = submit ? (this.sendNativeReceipt = {}) : null;
    const receiptScope = this.selectionKey(), receiptCdp = this.cdp;
    if (submit && receipt) this.draftEpoch = receipt.draftEpoch || '';
    if (this.app === 'fusion') {
      const queued = await this.adapter.sendMessage.call(this, text);
      if (receipt) this.emit({ t: 'sent', ...receipt, queued, sentAt: Date.now(), sel: this.selectionKey() });
      return queued;
    }
    await this.assertSelectedThread();
    const files = [...uploads.values()].filter(f => f.pending && f.sel === this.selectionKey());
    if (files.length) text += '\n\n附加文件（请读取这些电脑端文件）：\n' + files.map(f => f.path).join('\n');
    this.sendGen = (this.sendGen || 0) + 1;
    this.sending = true;
    let busy, now, queued;
    try {
      const input = this.app === 'codex' && nativeWindow(this.cdp) ? await this.cdp.evaluate(`(() => {
        const focused = ${FOCUS_COMPOSER}, h = ${PAGE_SRC};
        return { focused, busy: h.agentState()?.busy, draft: h.composerDraft() };
      })()`) : null;
      const found = input ? input.focused : await this.cdp.evaluate(FOCUS_COMPOSER);
      if (!found) throw new Error(this.appMessage('没找到 {app} 的聊天输入框：先在画面里打开 Agent 面板（或点「打开聊天」）'));
      // Read busy before typing: once the composer has text, apps replace the stop button with a send button and isBusy() reads false.
      busy = submit && (input ? input.busy : await this.cdp.evaluate(helpersCall('agentState()?.busy')));
      const sameDraft = !mentions?.length && (input ? input.draft : await this.cdp.evaluate(helpersCall('composerDraft()'))) === text;
      if (!sameDraft) {
        const draftCleared = await this.cdp.evaluate(helpersCall(`setComposerDraft('')`));
        for (let i = 0; !draftCleared && i < 2 && await this.cdp.evaluate(helpersCall('composerFocused()')) && await this.cdp.evaluate(helpersCall('composerDraft()')); i++) {
          await this.key(mod('A'));
          await this.key('Backspace');
        }
        await this.adapter.typeDraft.call(this, text, mentions);
      }
      now = this.app === 'devin' && when === 'now' && !!busy;
      queued = Boolean(busy) && !now;
      if (submit) queued = await this.adapter.submitPrompt.call(this, now, busy, when, queued, mentions, receipt, files);
    } catch (error) {
      if (this.app === 'codex' && mentions?.some(m => m.section === 'local-files')) {
        await this.cdp.evaluate(helpersCall('codexClearDraftAttachments()')).catch(() => false);
      }
      throw error;
    } finally {
      this.sending = false;
      this.sendGen++;
    }
    if (submit) {
      files.forEach(f => { if (receiptToken?.pending) f.awaitingReceipt = true; else f.pending = false; });
      if (!receiptToken?.pending) this.lastDraft = text;
      if (!queued && !receiptToken?.pending) rememberSessionMessage(this.app, this.threadId, Date.now());
    }
    if (submit && receipt) this.emit({ t: 'sent', ...receipt, ...(this.sendNativeReceipt === receiptToken && this.selectionKey() === receiptScope && this.cdp === receiptCdp ? receiptToken : {}), queued, sentAt: Date.now(), sel: this.selectionKey() });
    if (this.mode === 'chat') {
      this.lastChatAt = 0;
      this.pollChat(true).catch(() => {});
    }
    this.syncAttachments().catch(() => {});
    if (now && !receiptToken?.pending) this.emit({ t: 'status', ok: true, msg: '已打断当前任务并发送' });
    return queued;
  },
  async answerQuestion(qi, oi, part, text) {
    await this.assertSelectedThread();
    const call = p => helpersCall(`questionTarget(${Number(qi) || 0}, ${Number(oi) || 0}, ${JSON.stringify(p)})`);
    const pos = await this.cdp.evaluate(call(part));
    if (!pos) throw new Error('这个问题已经不在了（可能已在电脑上回答）');
    await this.tapCss(pos.x, pos.y);
    if (part === 'option' && typeof text === 'string') {
      await new Promise(r => setTimeout(r, 150));
      await this.cdp.evaluate(`document.activeElement?.select?.()`);
      if (text) await this.typeText(text);
      else await this.key('Backspace');
    }
    this.refreshSoon(300);
  },


  // Take a picture / file off the prompt again (the little x on its thumbnail on the desktop).
  async attachImage(data, name, type, replace = '', sel, transfer, uploadId) {
    const file = uploadId && uploads.get(uploadId);
    if (uploadId && (!file?.image || file.deviceId !== this.deviceId || file.sel !== sel)) throw new Error('找不到当前会话的上传图片');
    try {
    if (transfer?.cancelled) return;
    if (sel && sel !== this.selectionKey()) throw new Error('会话已切换，请回到原会话编辑图片');
    if (file) { data = fs.readFileSync(file.path).toString('base64'); name = file.name; type = file.type; }
    const before = await this.cdp.evaluate(`(() => { const h = ${PAGE_SRC}; if (${JSON.stringify(this.selectedThread || '')} && h.activeThread() !== ${JSON.stringify(this.selectedThread || '')}) throw new Error('当前窗口已不在所选会话，请重新连接'); return h.attachmentRows(); })()`);
    if (replace && !before.some(f => f.id === replace)) throw new Error('原图片已不在输入框中');
    if (!/^image\/(png|jpeg|gif|webp)$/.test(type) || typeof data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(data)) throw new Error('只支持 PNG / JPEG / GIF / WebP 图片');
    if (transfer?.cancelled) return;
    const ok = await this.cdp.evaluate(pasteImage(data, String(name || 'image').replace(/[^\w.\-]/g, '_').slice(0, 60), type));
    if (transfer?.cancelled && !ok) return;
    if (ok === null) throw new Error(this.appMessage('没找到 {app} 的聊天输入框：先在画面里打开 Agent 面板（或点「打开聊天」）'));
    if (!ok) throw new Error(this.appMessage('{app} 没有接收这张图片（当前模型可能不支持图片）'));
    const attached = await this.cdp.evaluate(helpersCall('attachmentRows(true)'));
    const added = attached.find(f => !before.some(old => old.id === f.id));
    if (transfer?.cancelled) {
      if (added) await this.removeAttachment(added.id);
      return;
    }
    if (replace) await this.removeAttachment(replace);
    await this.syncAttachments();
    if (transfer?.cancelled) {
      if (added) await this.removeAttachment(added.id);
      return;
    }
    this.emit({ t: 'status', ok: true, msg: this.appMessage('图片已附加到 {app} 输入框，写好文字后点发送') });
    const matches = JSON.parse(this.lastAttachments).filter(f => f.preview && f.preview === added?.preview);
    return matches.length === 1 ? matches[0].id : undefined;
    } finally {
      if (file) { fs.rmSync(path.dirname(file.path), { recursive: true, force: true }); uploads.delete(uploadId); }
    }
  },
  async editAttachmentImage(id, scope) {
    if (scope !== this.selectionKey()) throw new Error('会话已切换，请重新选择图片');
    const cdp = this.cdp, sel = this.sel;
    const image = await cdp.evaluate(helpersCall(`attachmentImage(${JSON.stringify(id)})`));
    if (this.liveRead(cdp, sel)) this.emit({ t: 'imageEdit', id, sel: scope, ...image });
  },
  async setDraft(text) {
    if (this.app === 'fusion' || text.length > 20000) return false;
    if (!this.cdp) return false;
    const native = await this.cdp.evaluate(`(() => { const h = ${PAGE_SRC}; return (!${JSON.stringify(this.selectedThread || '')} || h.activeThread() === ${JSON.stringify(this.selectedThread || '')}) && (h.composerDraft() === ${JSON.stringify(text)} || h.setComposerDraft(${JSON.stringify(text)})) ? { draft: h.composerDraft() } : null; })()`);
    if (native) { this.lastDraft = native.draft; return true; }
    return false;
  },
  async syncAttachments() {
    const cdp = this.cdp, sel = this.sel;
    if (!cdp) return;
    const list = await cdp.evaluate(helpersCall('attachmentRows()'));
    if (!this.liveRead(cdp, sel)) return;
    list.push(...[...uploads.entries()].filter(([, f]) => f.pending && f.sel === this.selectionKey()).map(([id, f]) => ({ id, name: f.name, size: f.size })));
    const json = JSON.stringify(list);
    if (json === this.lastAttachments) return;
    this.lastAttachments = json;
    this.emit({ t: 'attachments', sel: this.selectionKey(), list });
  },
  async removeAttachment(id) {
    const file = uploads.get(id);
    if (file?.pending && file.sel === this.selectionKey()) {
      fs.rmSync(path.dirname(file.path), { recursive: true });
      uploads.delete(id);
    } else {
      const point = await this.cdp.evaluate(helpersCall(`attachmentPoint(${JSON.stringify(id)})`));
      if (point) {
        await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
        await new Promise(r => setTimeout(r, 120));
      }
      const removed = await this.cdp.evaluate(helpersCall(`removeAttachment(${JSON.stringify(id)})`));
      if (!removed) throw new Error('附件已不在当前输入框中');
      for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 100));
        const list = await this.cdp.evaluate(helpersCall('attachmentRows()'));
        if (!list.some(f => f.id === id)) break;
        if (i === 7) throw new Error('附件没有删除成功');
      }
    }
    await this.syncAttachments();
  }
};
