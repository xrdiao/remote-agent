// 对话：聊天轮询、历史加载、发送与附件
import fs from 'node:fs';
import path from 'node:path';
import { IS_MAC, mod } from '../../lib/platform.mjs';
import { codexContext } from '../windows.mjs';
import { helpersCall } from '../page/build.mjs';
import { FOCUS_COMPOSER, uploads } from './context.mjs';

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
  async pollChat(immediate = false) {
    const cdp = this.cdp;
    const sel = this.sel;
    const sendGen = this.sendGen || 0;
    if (!cdp || !this.visible || this.switchingThread || this.historyLoading || (this.fusionHold?.app === this.app && this.fusionHold?.windowId === this.windowId) || (!immediate && Date.now() - (this.lastChatAt || 0) < (this.lastBusy ? 650 : 1800))) return;
    if (this.polling === sel) { if (immediate) this.pollAgain = sel; return; }
    this.lastChatAt = Date.now();
    this.polling = sel;
    const freshView = this.codexFreshView === true;
    this.codexFreshView = false;
    try {
      let chat = await cdp.evaluate(helpersCall('extract()'));
      const before = this.app === 'codex' && !freshView && !chat?.busy ? await cdp.evaluate(helpersCall("scrollCodexHistory('latest')")) : null;
      try {
        if (before) await new Promise(r => setTimeout(r, 150));
        if (before) chat = await cdp.evaluate(helpersCall('extract()'));
      } finally {
        if (before && this.liveRead(cdp, sel) && await cdp.evaluate(helpersCall('codexThread()')) === before.thread) {
          await cdp.evaluate(helpersCall(`scrollCodexHistory(${before.scrollTop})`));
        }
      }
      if (!this.liveRead(cdp, sel) || this.historyLoading) return;
      this.syncSession(chat);
      const extracted = chat && JSON.stringify({ ...chat, draft: undefined });
      if (chat && chat.thread === (this.threadId || '') && (this.app !== 'codex' || chat.thread) && (!this.lastChat || extracted !== this.lastExtractedChat)) {
        this.lastExtractedChat = extracted;
        const initial = { ...chat, items: chat.items.map(it => ({ ...it })) };
        delete initial.draft;
        if (this.app === 'codex') for (const it of initial.items.filter(it => it.images?.length)) {
          const old = this.itemCache?.get(chat.thread)?.find(x => x.i === it.i);
          it.images = it.images.map((src, n) => old?.imageSources?.[n] === src ? old.images[n] : src);
        }
        if (this.app === 'codex') initial.context = codexContext(chat.thread);
        this.fillThinking(initial);
        this.retainThinking(initial);
        this.mergeDevinHistory(initial);
        this.lastChat = JSON.stringify(initial);
        this.emit({ t: 'chat', sel: this.selectionKey(), chat: initial });
      }
      const liveClosed = this.app !== 'devin' && !(this.app === 'codex' && chat?.busy) && (chat?.items || []).some(it => it.k === 'thinking' && it.live && !(it.t || '').includes('\n'));
      if (liveClosed) {
        const idxs = await cdp.evaluate(helpersCall(`closedThinkingIndexes('live')`));
        if (!this.liveRead(cdp, sel)) return;
        if (idxs?.length) {
          await cdp.evaluate(helpersCall(`clickThinking(${JSON.stringify(idxs)})`));
          await new Promise(r => setTimeout(r, 250));
          if (!this.liveRead(cdp, sel)) return;
          chat = await cdp.evaluate(helpersCall('extract()'));
        }
      }
      if (!this.liveRead(cdp, sel)) return;
      const needFinal = this.app !== 'devin' && !(this.app === 'codex' && chat?.busy) && (chat?.items || []).some(it => it.k === 'thinking' && !it.live && !(it.t || '').includes('\n') && !this.thinkingTried.has(it.i));
      if (needFinal) {
        const idxs = await cdp.evaluate(helpersCall(`closedThinkingIndexes('done')`));
        if (!this.liveRead(cdp, sel)) return;
        if (idxs?.length) {
          await cdp.evaluate(helpersCall(`clickThinking(${JSON.stringify(idxs)})`));
          await new Promise(r => setTimeout(r, 250));
          if (!this.liveRead(cdp, sel)) return;
          chat = await cdp.evaluate(helpersCall('extract()'));
          if (!this.liveRead(cdp, sel)) return;
          await cdp.evaluate(helpersCall(`closeThinkingIfOpen(${JSON.stringify(idxs)})`));
        }
      }
      if (!this.liveRead(cdp, sel) || this.historyLoading || !chat) return;
      const prevThread = this.threadId || '';
      if (this.app === 'codex' && !chat.thread) { this.pendingThread = ''; return; }
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
      if (this.app === 'codex') chat.context = codexContext(chat.thread);
      if (this.app === 'codex') {
        for (const it of chat.items.filter(it => it.images?.length)) {
          const old = this.itemCache?.get(chat.thread)?.find(x => x.i === it.i);
          const sources = [...it.images];
          it.images = await Promise.all(it.images.map(async (src, n) => {
            if (old?.imageSources?.[n] === src && old.images?.[n]) return old.images[n];
            try { return await cdp.evaluate(helpersCall(`codexImage(${JSON.stringify(src)})`), { timeout: 60000 }); } catch { return src; }
          }));
          it.imageSources = sources;
        }
        if (!this.liveRead(cdp, sel)) return;
      }
      this.mergeCodexItems(chat);
      const draft = chat.draft;
      delete chat.draft;
      if (immediate) {
        if (chat?.model === 'Fusion' && this.fusion) chat.fusion = this.fusion;
        this.fillThinking(chat);
        this.retainThinking(chat);
        this.mergeDevinHistory(chat);
        if (this.app === 'devin') this.devinGeneration(chat);
        const json = JSON.stringify(chat);
        if (json !== this.lastChat && this.liveRead(cdp, sel)) {
          this.lastChat = json;
          this.emit({ t: 'chat', sel: this.selectionKey(), chat });
        }
      }
      // A draft read before or during a send is the text being sent; pushing it would refill the phone's box.
      if (draft !== undefined && draft !== this.lastDraft && !this.sending && (this.sendGen || 0) === sendGen && this.liveRead(cdp, sel)) {
        this.lastDraft = draft;
        this.emit({ t: 'draft', sel: this.selectionKey(), text: draft, draftEpoch: this.draftEpoch || '' });
      }
      // Devin task lists: read details for the current count and restore the original expansion state.
      const taskRow = (chat?.items || []).find(it => it.k === 'tasks' && !it.items && this.tasksTried.get(it.i) !== `${it.done}/${it.total}`);
      if (taskRow) {
        const wasOpen = await cdp.evaluate(helpersCall(`setTasksOpen(${JSON.stringify(taskRow.i)}, true)`));
        if (wasOpen != null) {
          try {
            await new Promise(r => setTimeout(r, 250));
            const opened = await cdp.evaluate(helpersCall('extract()'));
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
      for (const item of (chat?.items || []).filter(it => it.src === 'devin' && it.kind === 'command' && !it.cmd)) {
        const cached = this.devinHist.get(item.i)?.cmd;
        if (cached) { item.cmd = cached; continue; }
        const wasOpen = await cdp.evaluate(helpersCall(`setCommandOpen(${JSON.stringify(item.i)}, true)`));
        if (wasOpen == null) continue;
        try {
          await new Promise(r => setTimeout(r, 150));
          const full = await cdp.evaluate(helpersCall('extract()'));
          const command = full?.items?.find(it => it.i === item.i && it.cmd);
          if (command) Object.assign(item, command);
        } finally {
          if (!wasOpen) await cdp.evaluate(helpersCall(`setCommandOpen(${JSON.stringify(item.i)}, false)`));
        }
      }
      await this.captureThoughts(chat);
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
      if (!this.liveRead(cdp, sel) || this.historyLoading) return;
      if (json !== this.lastChat) {
        this.lastChat = json;
        this.emit({ t: 'chat', sel: this.selectionKey(), chat });
      }
      this.syncAttachments().catch(() => {});
    } finally {
      if (this.polling === sel) {
        this.polling = null;
        if (this.pollAgain === sel) {
          this.pollAgain = null;
          this.pollChat(true).catch(() => {});
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
  async editQueued(id, text) {
    if (!text.trim()) throw new Error('内容不能为空；不想要这条就点「删除」');
    await this.queueAction(id, 'edit');
    return this.adapter.editQueued.call(this, id, text);
  },
  async queueAction(id, action) {
    if (!['send', 'remove', 'edit'].includes(action)) throw new Error('不支持的排队操作');
    return this.adapter.queueAction.call(this, id, action);
  },
  async stopAgent() {
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
  async scrollChat(dy, automatic = false, history = false) {
    if (this.app === 'codex') {
      if (automatic && (await this.cdp.evaluate(helpersCall('agentState()')))?.busy) return { blocked: true };
      if (this.historyLoading) return { blocked: true };
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
          const chat = await cdp.evaluate(helpersCall('extract()'));
          if (!this.liveRead(cdp, sel) || chat?.thread !== thread) return;
          const pageItems = chat.items;
          this.mergeCodexItems(chat);
          if (history) {
            chat.items = [...new Map([...pageItems, ...chat.items].map(it => [it.i, it])).values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
            chat.earlier = Math.min(...chat.items.map(it => Math.floor((it.order ?? Infinity) / 10000))) > 1;
          }
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
        if (before && this.liveRead(cdp, sel) && await cdp.evaluate(helpersCall('codexThread()')) === thread) await cdp.evaluate(helpersCall(`scrollCodexHistory(${before.scrollTop})`));
        this.historyLoading = false;
        this.lastChatAt = 0;
      }
    }
    const rect = await this.cdp.evaluate(helpersCall('panelRect()'));
    if (!rect) return;
    if (history && this.app === 'devin') {
      // A 900px wheel never crosses Devin's virtualization remount threshold; jump the scroller.
      const r = await this.cdp.evaluate(helpersCall('devinLoadEarlier()'), { timeout: 8000 }).catch(() => null);
      if (!r) return;
      this.lastChatAt = 0;
      await this.pollChat(true);
      const earlier = this.lastChat ? JSON.parse(this.lastChat).earlier : undefined;
      return { earlier: earlier === undefined ? !r.atStart : earlier };
    }
    const [x, y, w, h] = rect;
    const rows = history ? await this.cdp.evaluate(helpersCall('historyRows()')) : null;
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: x + w / 2, y: y + h / 2, deltaX: 0, deltaY: dy });
    if (history) {
      await this.cdp.evaluate(helpersCall(`waitHistoryRows(${JSON.stringify(rows)})`));
      this.lastChatAt = 0;
      await this.pollChat(true);
      const earlier = this.lastChat ? JSON.parse(this.lastChat).earlier : undefined;
      return { earlier: earlier === undefined ? !(await this.cdp.evaluate(helpersCall('historyAtStart()'))) : earlier };
    }
    setTimeout(() => this.pollChat().catch(() => {}), 400);
  },


  // Phone typed "@q" (or tapped a category): list what Devin offers, then put the prompt back.
  async mentionQuery(q, cat, seq, trigger) {
    return this.adapter.mentionQuery.call(this, q, cat, seq, trigger);
  },
  async sendMessage(text, submit, when, mentions, receipt) {
    if (submit && receipt) this.draftEpoch = receipt.draftEpoch || '';
    if (this.app === 'fusion') {
      const queued = await this.fusionUserSend(text);
      if (receipt) this.emit({ t: 'sent', ...receipt, queued, sentAt: Date.now(), sel: this.selectionKey() });
      return queued;
    }
    const files = [...uploads.values()].filter(f => f.pending && f.sel === this.selectionKey());
    if (files.length) text += '\n\n附加文件（请读取这些电脑端文件）：\n' + files.map(f => f.path).join('\n');
    this.sendGen = (this.sendGen || 0) + 1;
    this.sending = true;
    let busy, now, queued;
    try {
      const found = await this.cdp.evaluate(FOCUS_COMPOSER);
      if (!found) throw new Error(this.appMessage('没找到 {app} 的聊天输入框：先在画面里打开 Agent 面板（或点「打开聊天」）'));
      // Read busy before typing: once the composer has text, apps replace the stop button with a send button and isBusy() reads false.
      busy = submit && await this.cdp.evaluate(helpersCall('agentState()?.busy'));
      const sameDraft = !mentions?.length && await this.cdp.evaluate(helpersCall('composerDraft()')) === text;
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
      if (submit) queued = await this.adapter.submitPrompt.call(this, now, busy, when, queued);
    } finally {
      this.sending = false;
      this.sendGen++;
    }
    if (submit) {
      files.forEach(f => { f.pending = false; });
      this.lastDraft = text;
    }
    if (submit && receipt) this.emit({ t: 'sent', ...receipt, queued, sentAt: Date.now(), sel: this.selectionKey() });
    if (this.mode === 'chat') {
      this.lastChatAt = 0;
      this.pollChat(true).catch(() => {});
    }
    this.syncAttachments().catch(() => {});
    if (now) this.emit({ t: 'status', ok: true, msg: '已打断当前任务并发送' });
    return queued;
  },
  async answerQuestion(qi, oi, part, text) {
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
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  },


  // Take a picture / file off the prompt again (the little x on its thumbnail on the desktop).
  async attachImage(data, name, type, replace = '', sel, transfer) {
    if (transfer?.cancelled) return;
    if (sel && sel !== this.selectionKey()) throw new Error('会话已切换，请回到原会话编辑图片');
    const before = await this.cdp.evaluate(helpersCall('attachmentRows()'));
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
  },
  async editAttachmentImage(id, scope) {
    if (scope !== this.selectionKey()) throw new Error('会话已切换，请重新选择图片');
    const cdp = this.cdp, sel = this.sel;
    const image = await cdp.evaluate(helpersCall(`attachmentImage(${JSON.stringify(id)})`));
    if (this.liveRead(cdp, sel)) this.emit({ t: 'imageEdit', id, sel: scope, ...image });
  },
  async setDraft(text) {
    if (this.app === 'fusion' || text.length > 20000) return false;
    if (text === this.lastDraft) return true;
    if (this.cdp && await this.cdp.evaluate(helpersCall(`setComposerDraft(${JSON.stringify(text)})`))) { this.lastDraft = text; return true; }
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
