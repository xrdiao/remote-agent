import { Cdp, cdpRead, awaitCdpRead } from '../cdp.mjs';
import { windowRoots, editorRoots, workspaceLabel } from '../../lib/files.mjs';
import { agentMarks } from '../../lib/marks.mjs';
import { IS_WIN, mod, normPath, pathKey } from '../../lib/platform.mjs';
import { codexWindows, codexContext } from '../windows.mjs';
import { CODEX_CDP_URL } from '../config.mjs';
import { PAGE_SRC, helpersCall } from '../page/build.mjs';
import { FOCUS_COMPOSER, codexUsage } from '../agent/context.mjs';
import { resetThinkingCaches } from '../agent/thinking-cache.mjs';
import { computerId, saveState } from '../../lib/auth.mjs';
import { conversationProjects, fusionProject } from '../fusion/state.mjs';
import { removeLibrarySession, publishSessionChange, rememberSessionMessage } from '../../lib/session-library.mjs';
import { storedProjectSession } from '../project-windows.mjs';
import { NativeCdp, nativeWindowAt } from '../native-windows.mjs';
import { currentOperation } from '../operations.mjs';

// Native support; availability still follows the selected thread, model and controls.
export const capabilities = {
  model: true, effort: true, fast: true,
  queue: true, steer: true, queueEdit: true,
  questions: true, approvals: true, attachments: true, fileReferences: true,
  editor: true, terminal: true, settings: true, usage: true,
  fork: true, extraActions: true,
};

async function readCodexMenu(context, button, select = items => items.length ? items : null) {
  const pos = await context.cdp.evaluate(helpersCall(`codexButtonPoint(${JSON.stringify(button)})`));
  if (!pos) throw new Error(button === 'run' ? '当前没有执行位置菜单' : '当前会话没有 Chat actions');
  await context.tapCss(pos.x, pos.y);
  let value;
  for (let i = 0; i < 10 && !value; i++) {
    await new Promise(r => setTimeout(r, 120));
    value = select(await context.cdp.evaluate(helpersCall('codexRunItems()')) || []);
  }
  return value;
}

export const adapter = {
  async newChat() {
    return this.newCodexChat();
  },

  // A cold start keeps the native home/new-chat view; only bind its webview.
  async openDefaultSession() {
    const page = (await codexWindows(CODEX_CDP_URL)).find(p => p.pageId === this.codexPageId);
    if (page && this.cdp === this.editorCdp) await this.ensureCodexReady({ id: page.pageId, ws: page.ws }, false);
    if (this.pendingProject?.trust) return;
    if (await this.checkCodexLogin()) return;
    const state = await this.waitFor('agentStartupState("codex")', 250);
    if (!state) throw new Error('Codex 项目与会话尚未就绪，请重试');
  },

  async openAgent(id, title = '') {
    await this.openCodexAgent(id);
  },

  async listAgents(silent, readOnly, emit) {
    const pages = await codexWindows(CODEX_CDP_URL);
    const list = [];
    const seen = new Set(), newRoots = new Set();
    const addNew = (p, root, label) => {
      if (!root || newRoots.has(pathKey(root))) return;
      newRoots.add(pathKey(root));
      list.push({ id: `new:${p.pageId}:${encodeURIComponent(root)}`, title: '＋ 新建会话', window: label, workspace: root, group: '', ui: true });
    };
    const states = await Promise.all(pages.map(p => this.probeCodex(p)));
    for (const p of pages) {
      const group = p.title;
      if (p.chatWs) {
        for (const root of states[pages.indexOf(p)]?.roots || []) addNew(p, root, group);
        const cdp = p.pageId === this.codexPageId ? this.cdp : this.fusionOwner ? new Cdp(p.chatWs) : new NativeCdp(p.chatWs);
        let rows = [];
        try {
          if (cdp !== this.cdp) await cdp.connect();
          rows = readOnly && cdp.nativeWindow?.catalog ? structuredClone(cdp.nativeWindow.catalog)
            : readOnly ? await cdp.evaluate(helpersCall('codexChatRows(true)')) : await this.codexThreadRows(cdp);
        } finally { if (cdp !== this.cdp) cdp.close(); }
        this.rememberCodexRoots(rows);
        const folderOf = ws => {
          const parts = String(ws || '').split(/[/\\]/).filter(Boolean);
          return parts.at(-1) || '';
        };
        for (const row of rows) {
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          const owner = pages.find((page, i) => states[i]?.thread === row.id && states[i]?.roots?.includes(row.workspace))
            || pages.find((page, i) => states[i]?.roots?.includes(row.workspace)) || p;
          const state = states[pages.indexOf(owner)];
          const folder = folderOf(row.workspace);
          if (!row.host) addNew(owner, row.workspace, folder || owner.title);
          list.push({
            id: `thread:${owner.pageId}:${row.id}`,
            title: row.title,
            titleNative: row.titleNative, titleAt: row.titleAt,
            lastUsed: row.lastUsed,
            window: folder || owner.title,
            workspace: row.workspace, host: row.host,
            group: '',
            current: owner.pageId === this.codexPageId && row.id === this.threadId,
            running: row.id === state?.thread ? !!state?.busy || !!row.running : !!row.running,
          });
        }
      } else {
        const state = states[pages.indexOf(p)];
        list.push({ id: `win:${p.pageId}`, title: '打开这个窗口', window: group, group: '', current: false, running: !!state?.busy || (state?.progress > 0), ui: true });
      }
    }
    const projectKey = (root, host) => `${host || ''}\0${pathKey(root, !host)}`;
    const projects = new Map();
    for (const row of list) if (row.workspace) {
      projects.set(projectKey(row.workspace, row.host), { root: IS_WIN && !row.host ? normPath(row.workspace) : row.workspace, host: row.host });
    }
    const allProjects = [...projects.values()];
    const labels = new Map(allProjects.map(project => {
      const { name, detail } = workspaceLabel(project, allProjects);
      return [projectKey(project.root, project.host), detail ? `${name} · ${detail}` : name];
    }));
    emit({ list: list.map(row => ({
      ...row, window: row.workspace ? labels.get(projectKey(row.workspace, row.host)) : row.window,
    })) });
  },

  async currentRoots() {
    return (await editorRoots(this.editorCdp, 'codex')).filter(w => !w.host);
  },

  async queueAction(id, action) {
    const target = action === 'send' ? await this.cdp.evaluate(helpersCall(`codexFacts()?.queued.find(item => item.id === ${JSON.stringify(String(id))})`)) : null;
    if (!await this.cdp.evaluate(helpersCall(`codexQueueAction(${JSON.stringify(String(id))}, ${JSON.stringify(action)})`))) throw new Error('Codex 排队消息或操作入口已不存在');
    if (action === 'send' && !await this.waitFor(`codexReceiptRows().some(item => item.i === ${JSON.stringify(target?.messageId || '')} || item.nativeIds?.includes(${JSON.stringify(String(id))}))`, 40))
      throw new Error('Codex 尚未确认立即追加结果，请查看会话或队列');
    this.refreshSoon(300);
  },

  async editQueued(id, text) {
    const wait = async call => {
      const deadline = Date.now() + 4800;
      while (Date.now() < deadline) {
        let value;
        try { value = await this.cdp.evaluate(helpersCall(call), { timeout: deadline - Date.now() }); }
        catch (error) {
          if (!cdpRead.getStore()?.aborted && Date.now() >= deadline) return null;
          throw error;
        }
        if (value) return value;
        await awaitCdpRead(new Promise(resolve => setTimeout(resolve, Math.min(120, Math.max(0, deadline - Date.now())))));
      }
      return null;
    };
    if (!await wait(`queueEditing() === ${JSON.stringify(String(id))}`)) throw new Error('Codex 没有进入对应队列消息的编辑状态');
    const before = await this.cdp.evaluate(helpersCall('codexQueued(false, null, []).map(item => item.id)'));
    await this.codexFocusPrompt();
    await this.cdp.evaluate(helpersCall('codexSelectPrompt()'));
    await this.cdp.send('Input.insertText', { text });
    if (!await this.cdp.evaluate(helpersCall('submitCodexMessage("queue")'))) throw new Error('Codex 保存排队消息的按钮不可用');
    const result = await wait(`codexQueued(true, null, ${JSON.stringify(before)}).find(item => item.t.trim() === ${JSON.stringify(text.trim())})`);
    if (!result) throw new Error('Codex 尚未确认排队消息已保存，请核对队列后重试');
    this.pollChat(true).catch(() => {});
    return { queueId: result.id, messageId: result.messageId };
  },

  async changeAction(i, name, act) {
    if (act !== 'bar') throw new Error('Codex 当前没有逐个文件的接受或撤销入口');
    const pos = await this.cdp.evaluate(helpersCall(`codexChangeTarget(${JSON.stringify(String(name))})`));
    if (!pos) throw new Error('文件操作入口已不存在');
    await this.tapCss(pos.x, pos.y);
    await this.listChanges();
  },

  async listChanges() {
    return this.emit({ t: 'changes', codex: true, ...await this.cdp.evaluate(helpersCall('codexChanges()')) });
  },

  async withFiles(fn, opts) {
    return this.withCursorFiles(fn);
  },

  async newTerminal() {
    // Let the workbench handle the shortcut instead of the focused Codex webview.
    await this.editorCdp.evaluate('document.activeElement?.blur()');
    await this.key('Ctrl+Shift+`', { cdp: this.editorCdp });
  },

  async mentionQuery(q, cat, seq, trigger, query) {
    return this.codexMentionQuery(q, trigger === '/' ? '/' : '@', seq, query);
  },

  async usageContext() {
    return codexContext(await this.cdp.evaluate(helpersCall('codexThread()')));
  },

  async accountUsage(request, automatic) {
    return this.readCodexAccount(request);
  },

  async typeDraft(text, mentions) {
    if (mentions?.length) await this.typeWithCodexMentions(text, mentions);
    else await this.typeText(text);
  },

  async submitPrompt(now, busy, when, queued, mentions, receipt, files = []) {
    const source = this.cdp?.nativeWindow;
    let token, sel, operation;
    if (source) {
      token = this.sendNativeReceipt;
      sel = this.selectionKey();
      cdpRead.getStore()?.throwIfAborted();
      operation = currentOperation();
    }
    const hasLocalFiles = mentions?.some(m => m.section === 'local-files');
    const before = await this.cdp.evaluate(helpersCall('codexSendState(true)'));
    const hasAttachments = hasLocalFiles || before.hasDraftAttachments;
    if (before.payload == null) throw new Error('Codex 输入尚未就绪');
    const expected = before.payload.trim();
    this.lastDraft = before.draft;
    queued = !!busy && (when === 'queue' || (!when && before.follow === 'queue'));
    const action = when === 'now' ? 'steer' : when === 'queue' ? 'queue' : '';
    if (source) {
      if (token) token.pending = true;
      let unregister;
      if (receipt) {
        if (operation) operation.pending = true;
        const request = { ...receipt, thread: before.thread, expected,
          action: queued ? 'queue' : busy ? 'steer' : 'send', afterTurn: before.lastTurn,
          beforeTurns: new Set(before.runs.map(row => row.id)),
          hasAttachments: !!hasAttachments,
          before: new Set(before.messages.map(row => row.id)), beforeQueues: new Set(before.queued.map(row => row.id)) };
        unregister = source.registerSend(request, (accepted, error, unknown = false) => {
          if (accepted) {
            if (token) Object.assign(token, accepted, { pending: false });
            for (const file of files) file.pending = false;
            if (!accepted.queued) rememberSessionMessage('codex', accepted.thread, Date.now());
            this.emit({ t: 'sent', ...receipt, ...accepted, sel, sentAt: Date.now() });
          } else if (unknown) this.emit({ t: 'sent', ...receipt, pending: true, message: error, sel });
          else this.emit({ t: 'sendFailed', requestId: receipt.requestId, message: error, sel });
        });
      }
      cdpRead.getStore()?.throwIfAborted();
      if (operation) operation.submitted = true;
      let submitted;
      try {
        submitted = await cdpRead.run(null, () => this.cdp.evaluate(helpersCall(`submitCodexMessage(${JSON.stringify(action)}, true, ${JSON.stringify(receipt?.requestId || '')})`)));
      } catch (error) {
        if (!receipt) throw error;
        if (token?.pending) this.emit({ t: 'sent', ...receipt, pending: true, message: error.message, sel });
        return queued;
      }
      if (!submitted) {
        unregister?.();
        if (operation) operation.pending = false;
        if (token) token.pending = false;
        throw new Error('Codex 提交入口当前不可用');
      }
      return queued;
    }
    const nativeReceipt = this.sendNativeReceipt;
    const receiptThread = this.threadId, receiptCdp = this.cdp, receiptScope = this.selectionKey();
    if (!await this.cdp.evaluate(helpersCall(`submitCodexMessage(${JSON.stringify(action)})`))) throw new Error('Codex 提交入口当前不可用');
    const baseline = { thread: before.thread, messages: before.messages.map(({ id }) => ({ id })), queued: before.queued.map(({ id }) => ({ id })) };
    const accepted = await this.cdp.evaluate(helpersCall(`waitCodexReceipt(${JSON.stringify(baseline)}, ${JSON.stringify(expected)}, ${!!hasAttachments})`), { timeout: 6000 }).catch(error => {
      cdpRead.getStore()?.throwIfAborted();
      return null;
    });
    if (accepted && this.cdp === receiptCdp && this.selectionKey() === receiptScope && (!receiptThread || before.thread === receiptThread)) {
      queued = accepted.queued;
      if (nativeReceipt) Object.assign(nativeReceipt, accepted);
      if (busy && !queued) this.emit({ t: 'status', ok: true, msg: '已追加到当前任务' });
      return queued;
    }
    if (nativeReceipt) nativeReceipt.pending = true;
    return queued;
  },

  async fileAgentMarks(f, text, changes, diff) {
    const edits = new Map();
    for (const file of changes.files) for (const hunk of (file.diff || '').split(/^@@[^\n]*\n/m)) {
      const diff = hunk.split('\n').filter(l => /^[ +\-]/.test(l) && !/^---|^\+\+\+/.test(l)).map(l => [l[0], l.slice(1)]);
      if (diff.length) edits.set(edits.size, { kind: 'edit', f: file.name, diff });
    }
    const marks = agentMarks(edits, f.path, text);
    if (marks) return { marks, markSource: 'agent', diff };
    return null;
  },

  async pickModelMenu(label) {
    if (!await this.cdp.evaluate(helpersCall(`pickCodexModel(${JSON.stringify(String(label))})`))) return false;
    await this.waitModel(label);
    await this.closeMenus();
    this.pollChat(true).catch(() => {});
    return true;
  },

  async showSettings(requestId = 0) {
    return this.showCodexSettings('', requestId);
  },
};

export const methods = {

// A virtualized Codex list unmounts older turns. Keep text we already read for this thread.
mergeCodexItems(chat) {
  if (this.app !== 'codex' || !chat?.items) return;
  const thread = chat.thread || '';
  if (thread && this.threadId && thread !== this.threadId) {
    this.latestThink = null;
    this.thinkTries = new Map();
    resetThinkingCaches(this);
  }
  if (thread) this.threadId = thread;
  if (!this.itemCache) this.itemCache = new Map();
  const prev = this.itemCache.get(thread) || [];
  const rows = new Map(prev.map(it => {
    if (it.capacity && it.b?.length) {
      const { b, actions, btnItem, ...notice } = it;
      return [it.i, notice];
    }
    return [it.i, it];
  }));
  const completed = new Map([...(prev.completeTurns || []), ...(chat._completeTurnIds || [])]);
  delete chat._completeTurnIds;
  const partial = new Set(prev.partialTurns || []);
  for (const turn of chat._completeTurns || []) partial.delete(turn);
  for (const turn of chat._partialTurns || []) partial.add(turn);
  delete chat._completeTurns; delete chat._partialTurns;
  let tailOrder = Math.max(0, ...prev.map(it => it.order || 0), ...chat.items.map(it => it.order || 0));
  if (chat.capacityPresent === false) {
    for (const [id, it] of rows) if (it.syntheticCapacity) rows.delete(id);
  }
  for (const [index, { buttonsRead, htmlRead, ...it }] of chat.items.entries()) {
    const old = rows.get(it.i);
    if (htmlRead === false && it.k === 'assistant' && old?.t === it.t && old.bodyFormat === 'html' && old.h) {
      it.h = old.h;
      it.bodyFormat = 'html';
    }
    if (!Number.isFinite(it.order)) it.order = Number.isFinite(old?.order) ? old.order : ++tailOrder;
    // A stored turn has no footer DOM; a mounted turn is authoritative, including removal.
    const retained = buttonsRead === false && it.k === 'assistant' && old?.k === 'assistant'
      && it.completed === true && old.completed === true && it.t === old.t
      ? (old.b || []).map((label, n) => ({ label, action: old.actions?.[n] || '' }))
        .filter(button => /^(Copy message|View changed files|View file changes|Undo|View changes|Fork chat from here)$/.test(button.label)) : [];
    const buttons = retained.length ? [
      ...(it.b || []).map((label, n) => ({ label, action: it.actions?.[n] || '' })),
      ...retained.filter(button => !it.b?.includes(button.label)),
    ] : [];
    const row = buttons.length ? { ...old, ...it, b: buttons.map(button => button.label), btnItem: it.btnItem || old.btnItem || old.i,
      ...(old.actions || it.actions ? { actions: buttons.map(button => button.action) } : {}) } : it;
    chat.items[index] = row;
    rows.set(it.i, row);
  }
  const capacity = chat.capacityPresent && chat.items.find(it => it.syntheticCapacity);
  if (capacity) for (const [id, it] of rows) {
    if (id === capacity.i || !it.b?.length) continue;
    const buttons = it.b.map((label, index) => ({ label, action: it.actions?.[index] || '' }))
      .filter(button => !/^(Retry|Try(?: again)?|重试|再试一次)$/i.test(button.label));
    if (buttons.length !== it.b.length) rows.set(id, { ...it, b: buttons.map(button => button.label),
      ...(it.actions ? { actions: buttons.map(button => button.action) } : {}) });
  }
  if ('historyBefore' in chat) {
    chat.earlier = !!chat._historyEarlier;
    delete chat._historyEarlier; delete chat._historyStart;
    if (!chat.busy) for (const item of chat.items) {
      if (item.k === 'thinking') item.live = false;
      if (item.k === 'tool' && !item.keep) item.done = true;
    }
    // Only completed bodies survive a selection change; current controls come from this read.
    const completedRows = [...rows.values()].filter(item => item.k === 'human'
      || item.k === 'assistant' && item.completed || item.k === 'thinking' && !item.live
      || item.k === 'tool' && item.done || item.k === 'notice' && !item.live)
      .sort((a, b) => a.order - b.order).slice(-400);
    this.itemCache.delete(thread);
    this.itemCache.set(thread, completedRows);
    if (this.itemCache.size > 12) this.itemCache.delete(this.itemCache.keys().next().value);
    return;
  }
  const ordered = [...rows.values()].sort((a, b) => a.order - b.order);
  const turns = [...new Set(ordered.map(it => Math.floor(it.order / 10000)))].slice(-32);
  const retained = ordered.filter(it => turns.includes(Math.floor(it.order / 10000)));
  const anchors = new Set(retained.filter(it => it.k === 'human' || it.syntheticCapacity));
  for (const turn of turns) {
    const final = retained.findLast(it => Math.floor(it.order / 10000) === turn && it.k === 'assistant' && it.completed);
    if (final) anchors.add(final);
  }
  const details = new Set(retained.filter(it => !anchors.has(it)).slice(-400));
  chat.items = retained.filter(it => {
    if (anchors.has(it) || details.has(it)) return true;
    partial.add(Math.floor(it.order / 10000)); return false;
  });
  chat.items.partialTurns = [...partial].filter(turn => turns.includes(turn));
  chat.items.completeTurns = [...completed].filter(([, turn]) => turns.includes(turn));
  chat.earlier = chat._historyEarlier || this.codexEarlier(chat.items, undefined, chat._historyStart);
  delete chat._historyEarlier; delete chat._historyStart;
  if (!chat.busy) chat.items.filter(it => it.k === 'thinking').forEach(it => { it.live = false; });
  if (!chat.busy) chat.items.filter(it => it.k === 'tool' && !it.keep).forEach(it => { it.done = true; });
  this.itemCache.set(thread, chat.items);
},

async selectCodexThread(convId, cdp = this.cdp) {
  const deadline = cdpRead.getStore()?.deadline ?? Date.now() + 35000;
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error('Codex 会话导航超时，请重试');
    return ms;
  };
  const read = call => cdp.evaluate(helpersCall(call), { timeout: remaining() });
  const waitActive = (ms = 1800) => read(`codexWaitThread(${JSON.stringify(convId)}, ${Math.min(ms, remaining())})`);
  let opened = false, pos = null;
  do {
    opened = await read(`openCodexThread(${JSON.stringify(convId)})`);
    if (opened) break;
    pos = await read('codexRecentPoint()');
    if (pos) break;
    await awaitCdpRead(new Promise(r => setTimeout(r, Math.min(120, remaining()))));
  } while (Date.now() < deadline);
  if (!opened && !pos) throw new Error('Codex 会话导航尚未就绪，请稍后重试');
  if (opened) return waitActive(remaining());
  await this.tapCss(pos.x, pos.y, 'left', cdp);
  let point = null;
  for (let i = 0; i < 8 && !point; i++) {
    await awaitCdpRead(new Promise(r => setTimeout(r, Math.min(120, remaining()))));
    point = await read(`codexChatPoint(${JSON.stringify(convId)})`);
  }
  if (!point) {
    await read('closeCodexMenu()');
    return false;
  }
  await this.tapCss(point.x, point.y, 'left', cdp);
  if (await waitActive()) return true;
  await read('closeCodexMenu()');
  return false;
},

async adoptCodexThread(thread, statusMsg) {
  const switching = this.switchingThread;
  this.switchingThread = true;
  try {
    if (this.threadId !== (thread || '')) this.clearViewState();
    this.threadId = thread || '';
  } finally {
    this.switchingThread = switching;
  }
  this.publishThread(statusMsg);
  if (!switching) {
    await this.pollChat(true, true);
  }
},

async checkCodexLogin() {
  if (!await this.cdp.evaluate(helpersCall('codexNeedsLogin()'))) return false;
  const chat = { items: [], global: [], thread: '', readonly: true, loginRequired: true };
  const raw = JSON.stringify(chat);
  if (this.lastChat !== raw) {
    this.lastChat = raw;
    this.emit({ t: 'chat', sel: this.selectionKey(), chat });
    this.emit({ t: 'status', ok: false, msg: '项目窗口已打开，请在电脑端登录此窗口的 Codex，登录后重新选择会话' });
  }
  return true;
},

codexEarlier(items, partial = items.partialTurns?.length > 0, start = 1) {
  if (partial) return true;
  const turns = [...new Set(items.map(it => Math.floor((it.order ?? Infinity) / 10000)))].sort((a, b) => a - b);
  return !turns.length || turns[0] !== start || turns.some((n, i) => !Number.isFinite(n) || (i > 0 && n !== turns[i - 1] + 1));
},

async waitCodexNewChatReady() {
  for (let i = 0; i < 120; i++) {
    if (this.pendingProject?.trust) return;
    if (await this.checkCodexLogin()) return false;
    if (await this.cdp.evaluate(helpersCall('codexNewPoint()'))) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('项目已打开，但 Codex 会话入口尚未就绪');
},

async newCodexChat() {
  if (!this.cdp) throw new Error('还没有连上 Codex');
  if (await this.checkCodexLogin()) throw new Error('请先在电脑端登录此窗口的 Codex，再新建会话');
  const before = await this.cdp.evaluate(helpersCall('codexThread()')) || '';
  const pos = await this.cdp.evaluate(helpersCall('codexNewPoint()'));
  if (!pos) throw new Error('这个窗口里没有新建对话');
  await this.tapCss(pos.x, pos.y);
  let thread = before;
  let turns = 1;
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 150));
    const view = await this.cdp.evaluate(helpersCall('codexViewState()'));
    thread = view?.thread || '';
    turns = view?.turns ?? 1;
    if ((thread && thread !== before) || (!thread && turns === 0)) break;
  }
  if (thread === before && turns > 0) throw new Error('新建会话没有生效');
  await this.adoptCodexThread(thread === before ? '' : thread, '已新建会话');
},

async openCodexAgent(id, preferCurrentProject = false) {
  if (id.startsWith('win:')) {
    await this.attach({ id: 'codex', windowId: id.slice(4), threadId: '' });
    this.emit({ t: 'status', ok: true, msg: '已切换窗口' });
    return;
  }
  if (id.startsWith('new:')) {
    const [, pageId, encodedRoot] = id.split(':');
    const page = (await codexWindows(CODEX_CDP_URL)).find(p => p.pageId === pageId);
    const root = encodedRoot ? decodeURIComponent(encodedRoot) : windowRoots(page?.rawTitle || '', 'codex')[0]?.root;
    if (!root) throw new Error('无法确认新会话所属项目，请刷新项目与会话列表');
    return this.useProject(root, true);
  }
  const match = /^thread:([^:]+):(.+)$/.exec(id || '');
  if (!match) throw new Error('这条会话已经不在列表里');
  const convId = match[2];
  const own = match[1] === this.codexPageId;
  let row;
  if (preferCurrentProject) row = (await this.cdp.evaluate(helpersCall('codexChatRows(true)')) || []).find(r => r.id === convId);
  if (!row) {
    const page = own ? null : (await codexWindows(CODEX_CDP_URL, false, match[1]))[0];
    const source = own ? this.cdp : page?.chatWs ? new Cdp(page.chatWs) : null;
    try {
      if (source) {
        if (!own) await source.connect();
        row = (await source.evaluate(helpersCall('codexChatRows(true)')) || []).find(r => r.id === convId);
      }
    } finally { if (!own) source?.close(); }
  }
  const workspace = row?.workspace || this.codexRoots?.get(convId)
    || conversationProjects[JSON.stringify([computerId(), 'codex', '', convId])]?.project?.root
    || storedProjectSession('codex', id)?.workspace;
  if (preferCurrentProject && workspace && this.projectMatches(await editorRoots(this.editorCdp, 'codex'), workspace, row?.host || '')) {
    if (!await this.selectCodexThread(convId)) throw new Error('没有找到所选会话');
    await this.adoptCodexThread(convId, '已切换会话');
    return;
  }
  if (workspace && !row?.host) {
    return this.useProject(workspace, false, convId, '', match[1]);
  }
  if (row?.host) {
    const page = (await codexWindows(CODEX_CDP_URL, false, match[1]))[0];
    if (!page) throw new Error('所选会话窗口已经关闭');
    const state = await this.projectWindowState({ ...page, id: page.pageId });
    if (state.busy && state.thread !== convId) throw new Error('目标远程窗口正在运行，请先在电脑上为目标会话打开独立窗口');
    const switching = this.switchingThread, previousCdp = this.cdp;
    this.switchingThread = true;
    this.bindingReady = false;
    try {
      if (page.pageId !== this.codexPageId) await this.openBound({ id: 'codex', app: 'codex', title: page.rawTitle, ws: page.ws, port: CODEX_CDP_URL },
        page.ws, page.chatWs, { windowId: page.pageId, threadId: convId, deferred: true });
      if (await this.checkProjectTrust({ threadId: convId })) return;
      if (!await this.selectCodexThread(convId)) throw new Error('没有找到所选会话');
      await this.adoptCodexThread(convId, '已切换会话');
      this.bindingReady = true;
    } finally {
      if (switching) this.switchingThread = switching;
      else await this.resumeProjectSwitch(previousCdp);
    }
    return;
  }
  throw new Error('无法确认会话所属项目，请刷新项目与会话列表');
},

async codexPageForThread(pages, threadId) {
  const settled = await Promise.allSettled(pages.filter(p => p.chatWs).map(async page => {
    const cdp = new Cdp(page.chatWs);
    try {
      await cdp.connect();
      const state = await cdp.evaluate(helpersCall('agentState()'));
      const rows = await cdp.evaluate(helpersCall('codexChatRows(true)'));
      const row = rows.find(r => r.id === threadId);
      return { page, active: state?.thread === threadId, inWorkspace: !!row && (!row.workspace || state?.roots?.includes(row.workspace)) };
    } finally { cdp.close(); }
  }));
  const matches = settled.filter(s => s.status === 'fulfilled').map(s => s.value);
  return matches.find(m => m.active && m.inWorkspace)?.page || matches.find(m => m.inWorkspace)?.page || null;
},

async probeCodex(page) {
  if (!page?.chatWs && page?.pageId !== this.codexPageId) return null;
  const source = !this.fusionOwner && nativeWindowAt(page.chatWs);
  if (source?.snapshot) return (await source.read()).states.find(state => state.thread === source.snapshot.chat?.thread) || null;
  if (page.pageId === this.codexPageId && this.cdp) {
    try { return await this.cdp.evaluate(helpersCall('agentState()')); } catch { return null; }
  }
  if (!page.chatWs) return null;
  const cdp = new Cdp(page.chatWs);
  try {
    await cdp.connect();
    return await cdp.evaluate(helpersCall('agentState()'));
  } catch {
    return null;
  } finally {
    try { cdp.close(); } catch {}
  }
},

rememberCodexRoots(rows) {
  if (!this.codexRoots) this.codexRoots = new Map();
  for (const row of rows || []) {
    if (row?.id && row.workspace) {
      this.codexRoots.set(row.id, row.workspace);
      const id = JSON.stringify([computerId(), 'codex', row.host || '', row.id]);
      const project = fusionProject(row.workspace, row.host || '');
      if (project) conversationProjects[id] = { project, originProject: conversationProjects[id]?.originProject || project };
    }
  }
  saveState({ conversationProjects });
},

async codexThreadRows(cdp = this.cdp) {
  const pos = await cdp.evaluate(helpersCall('codexRecentPoint()'));
  if (!pos) return [];
  await this.tapCss(pos.x, pos.y, 'left', cdp);
  let rows = [];
  for (let i = 0; i < 8 && !rows.length; i++) {
    await new Promise(r => setTimeout(r, 120));
    rows = await cdp.evaluate(helpersCall('codexChatRows()')) || [];
  }
  const recent = await cdp.evaluate(helpersCall('codexChatRows(true)')) || [];
  await cdp.evaluate(helpersCall('closeCodexMenu()'));
  const merged = new Map(recent.map(row => [row.id, row]));
  for (const row of rows) merged.set(row.id, { ...merged.get(row.id), ...row });
  return [...merged.values()];
},

async enableCodexMax() {
  try {
    await this.withCodexSettings(async cdp => {
      let data = await cdp.evaluate(helpersCall('codexSettingsData()'));
      const previous = data.nav.find(n => n.current);
      const navigate = async item => {
        const before = JSON.stringify(data);
        const pos = await cdp.evaluate(helpersCall(`codexSettingPoint(${JSON.stringify(item.id)})`));
        await this.tapCss(pos.x, pos.y, 'left', cdp);
        data = await cdp.evaluate(helpersCall(`waitSettings('codex', ${JSON.stringify(before)})`));
      };
      try {
        const config = data.nav.find(n => n.label === 'Configuration');
        if (!config) throw new Error('没有找到 Codex 原生配置入口');
        if (!config.current) await navigate(config);
        const row = data.rows.find(r => r.label === 'Available reasoning efforts');
        if (!row) throw new Error('没有找到 Codex 思考强度设置');
        const pos = await cdp.evaluate(helpersCall(`codexSettingPoint(${JSON.stringify(row.controls[0].id)})`));
        await this.tapCss(pos.x, pos.y, 'left', cdp);
        const choice = await cdp.evaluate(`(() => { const doc = document.getElementById('active-frame').contentDocument; const option = [...doc.querySelectorAll('[role=menuitemcheckbox]')].find(el => el.textContent.trim() === 'Max'); if (!option || option.getAttribute('aria-disabled') === 'true') return null; option.dataset.remoteSetting ||= crypto.randomUUID(); return { id: option.dataset.remoteSetting, enabled: option.getAttribute('aria-checked') === 'true' }; })()`);
        if (!choice) throw new Error('当前 Codex 无法启用 Max');
        if (!choice.enabled) {
          const target = await cdp.evaluate(helpersCall(`codexSettingPoint(${JSON.stringify(choice.id)})`));
          await this.tapCss(target.x, target.y, 'left', cdp);
          const checked = await cdp.evaluate(`new Promise(resolve => { const doc = document.getElementById('active-frame').contentDocument, started = Date.now(); const read = () => { const el = [...doc.querySelectorAll('[role=menuitemcheckbox]')].find(el => el.textContent.trim() === 'Max'); if (el?.getAttribute('aria-checked') === 'true') return resolve(true); if (Date.now() - started >= 2000) return resolve(false); setTimeout(read, 30); }; read(); })`);
          if (!checked) throw new Error('Codex 原生 Max 设置尚未生效');
        }
        await this.key('Escape', { cdp });
      } finally {
        if (previous && !data.nav.some(n => n.id === previous.id && n.current)) await navigate(previous);
      }
    });
  } finally { await cdpRead.run(null, () => this.closeCodexSettings()); }
},

async withCodexSettings(fn) {
  const editor = this.editorCdp, sidebar = this.cdp;
  const deadline = cdpRead.getStore()?.deadline || Date.now() + 30000;
  const read = (cdp, source) => cdp.evaluate(source, { timeout: Math.max(1, deadline - Date.now()) });
  const until = async (read, message) => {
    while (Date.now() < deadline) {
      const value = await read();
      if (value) return value;
      await awaitCdpRead(new Promise(resolve => setTimeout(resolve, Math.min(30, Math.max(0, deadline - Date.now())))));
    }
    throw new Error(message);
  };
  const settingsKey = () => read(editor, `(() => { if (![...document.querySelectorAll('.tab.active')].some(e => /^Codex Settings(?:,|$)/.test(e.getAttribute('aria-label') || ''))) return ''; const el = [...document.querySelectorAll('iframe[src*="extensionId=openai.chatgpt"]')].find(e => !e.src.includes('purpose=webviewView') && e.getBoundingClientRect().height > 0); return el ? new URL(el.src).searchParams.get('id') : ''; })()`);
  try {
    const before = await read(editor, `(() => { const t = [...document.querySelectorAll('.tab')].find(e => /^Codex Settings(?:,|$)/.test(e.getAttribute('aria-label') || '')); return !!t; })()`);
    let key = await settingsKey();
    let cdp = key && key === this.codexSettingsKey && this.codexSettingsEditor === editor && this.codexSettingsCdp?.ws?.readyState === 1 ? this.codexSettingsCdp : null;
    if (!cdp) {
      this.codexSettingsCdp?.close();
      this.codexSettingsCdp = null;
      this.codexSettingsEditor = editor;
      if (!key) {
        this.codexSettingsReturn = await read(editor, `(() => { const tab = document.querySelector('.editor-group-container.active .tab.active'); if (!tab || /^Codex Settings(?:,|$)/.test(tab.getAttribute('aria-label') || '')) return ''; tab.dataset.remoteSettingsReturn ||= crypto.randomUUID(); return tab.dataset.remoteSettingsReturn; })()`);
        if (before) {
          const pos = await read(editor, `(() => { const tab = [...document.querySelectorAll('.tab')].find(e => /^Codex Settings(?:,|$)/.test(e.getAttribute('aria-label') || '')); const r = tab.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
          await this.tapCss(pos.x, pos.y, 'left', editor);
        } else {
          const account = await until(() => read(sidebar, helpersCall('codexAccountPoint()')), '没有找到 Codex 设置菜单');
          await this.tapCss(account.x, account.y, 'left', sidebar);
          const pos = await until(() => read(sidebar, helpersCall("codexMenuPoint('Codex settings')")), 'Codex 菜单没有设置入口');
          await this.tapCss(pos.x, pos.y, 'left', sidebar);
        }
        key = await until(settingsKey, 'Codex 设置页面尚未打开');
      }
      const target = await until(async () => {
        const targets = await awaitCdpRead(fetch(`${CODEX_CDP_URL}/json/list`, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) }).then(response => response.json()));
        return targets.find(t => /extensionId=openai.chatgpt/.test(t.url || '') && new URL(t.url).searchParams.get('id') === key);
      }, 'Codex 设置页面尚未连接');
      this.codexSettingsViewWs = target.webSocketDebuggerUrl;
      cdp = this.codexSettingsCdp = new Cdp(target.webSocketDebuggerUrl);
      await cdp.connect(Math.max(1, deadline - Date.now()));
      this.codexSettingsKey = key;
    }
    await until(() => read(cdp, `!!document.getElementById('active-frame')?.contentDocument?.querySelector('[data-appearance] button.sidebar-item')`), 'Codex 设置内容尚未加载');
    return await fn(cdp);
  } catch (error) {
    try { await cdpRead.run(null, () => this.closeCodexSettings()); }
    finally { throw error; }
  }
},

async showCodexSettings(id = '', requestId = 0, value) {
  const sel = this.sel;
  const data = await this.withCodexSettings(async cdp => {
    const previous = id ? await cdp.evaluate(helpersCall('codexSettingsData()')) : null;
    const before = previous ? JSON.stringify(previous) : '';
    const navigating = previous?.nav.find(n => n.id === id && !n.current);
    if (id) {
      if (value !== undefined) await cdp.evaluate(helpersCall(`codexSettingValue(${JSON.stringify(id)}, ${JSON.stringify(value)})`));
      else {
        const pos = await cdp.evaluate(helpersCall(`codexSettingPoint(${JSON.stringify(id)})`));
        if (!pos) throw new Error('设置选项已改变，请重新打开设置');
        await this.tapCss(pos.x, pos.y, 'left', cdp);
      }
    }
    const data = await cdp.evaluate(helpersCall(`waitSettings('codex', ${JSON.stringify(before)}, ${navigating || !before ? 1200 : 200})`));
    if (!data.nav.length) throw new Error('Codex 设置内容尚未加载');
    if (navigating && (!data.nav.some(n => n.current && n.label === navigating.label) || (!data.dialog && data.title !== navigating.label)))
      throw new Error('Codex 设置栏目尚未切换，请重试');
    return data;
  });
  if (this.sel === sel && this.app === 'codex') this.emit({ t: 'settings', codex: true, requestId, ...data });
},

async saveCodexInstructions(text, requestId = 0) {
  const sel = this.sel;
  const data = await this.withCodexSettings(cdp => cdp.evaluate(helpersCall(`codexSaveInstructions(${JSON.stringify(text)})`)));
  if (this.sel === sel && this.app === 'codex') {
    this.emit({ t: 'settings', codex: true, requestId, ...data });
    this.emit({ t: 'status', ok: true, msg: 'Codex instructions 已保存' });
  }
},

async closeCodexSettings() {
  const editor = this.codexSettingsEditor || this.editorCdp;
  this.codexSettingsKey = '';
  this.codexSettingsCdp?.close();
  this.codexSettingsCdp = null;
  this.codexSettingsEditor = null;
  const view = this.codexSettingsViewWs;
  this.codexSettingsViewWs = '';
  if (view) {
    const menu = new Cdp(view);
    await menu.connect();
    try { await this.key('Escape', { cdp: menu }); } finally { menu.close(); }
  }
  const previous = this.codexSettingsReturn;
  this.codexSettingsReturn = '';
  if (previous && editor) {
    const pos = await editor.evaluate(`(() => { const tab = document.querySelector('[data-remote-settings-return="' + ${JSON.stringify(previous)} + '"]'); if (!tab) return null; const r = tab.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (pos) await this.tapCss(pos.x, pos.y, 'left', editor);
  }
},

async readCodexAccount(request) {
  const cdp = this.cdp, sel = this.sel;
  const native = await cdp.evaluate(helpersCall('refreshCodexUsage(false)'));
  if (native && (!codexUsage.data || native.updated > codexUsage.data.updated)) {
    codexUsage.data = native;
    codexUsage.retryAt = 0;
    codexUsage.failures = 0;
  }
  if (!request.fusion && codexUsage.data && this.liveRead(cdp, sel)) this.emit({ t: 'usage', sel: this.selectionKey(), ...codexUsage.data, cached: true });
  if (!request.manual && Date.now() < codexUsage.retryAt) throw codexUsage.error;
  if (!request.manual && codexUsage.data && Date.now() - codexUsage.data.updated < 60000) return { ...codexUsage.data, cached: true };
  if (!codexUsage.refresh) {
    codexUsage.refresh = cdp.evaluate(helpersCall('refreshCodexUsage()'), { timeout: 120000 }).then(data => {
      codexUsage.data = data;
      codexUsage.failures = 0;
      codexUsage.retryAt = 0;
      return data;
    }).catch(error => {
      codexUsage.error = error;
      codexUsage.retryAt = Date.now() + Math.min(60000 * 2 ** ++codexUsage.failures, 300000);
      throw error;
    }).finally(() => { codexUsage.refresh = null; });
  }
  return codexUsage.refresh;
},

async codexPrompt() {
  const text = await this.cdp.evaluate(helpersCall('codexPromptText()'));
  return typeof text === 'string' ? text : '';
},

async codexFocusPrompt() {
  if (!await this.cdp.evaluate(FOCUS_COMPOSER)) throw new Error('没找到 Codex 的输入框');
  const pos = await this.cdp.evaluate(helpersCall('codexPromptPoint()'));
  if (pos) await this.tapCss(pos.x, pos.y);
},

async codexRestorePrompt(before) {
  let now = await this.codexPrompt();
  if (now === before) return;
  await this.closeMenus();
  await new Promise(r => setTimeout(r, 120));
  now = await this.codexPrompt();
  if (now === before) return;
  if (before && now.startsWith(before)) {
    const extra = now.slice(before.length);
    for (let i = 0; i < extra.length; i++) await this.key('Backspace');
    if (await this.codexPrompt() === before) return;
  }
  if (!before) {
    await this.cdp.evaluate(helpersCall('codexSelectPrompt()'));
    await this.key('Backspace');
    await new Promise(r => setTimeout(r, 80));
  }
},

async codexMentionSettle(seq) {
  let last = '', rows = [];
  for (let i = 0; i < 16; i++) {
    if (seq != null && this.mentionSeq !== seq) return null;
    await new Promise(r => setTimeout(r, 140));
    if (seq != null && this.mentionSeq !== seq) return null;
    rows = await this.cdp.evaluate(helpersCall('codexMentionRows()')) || [];
    if (seq != null && this.mentionSeq !== seq) return null;
    const sig = JSON.stringify(rows.map(r => [r.section, r.key, r.label]));
    if (rows.length && sig === last && i >= 2) break;
    last = sig;
  }
  return rows;
},

mentionPayload(rows) {
  return rows.slice(0, 40).map(r => ({ label: r.label, sub: r.sub || '', key: r.key || '', section: r.section || '' }));
},

async codexMentionQuery(q, trigger, seq, query) {
  const out = await this.withMentionLock(seq, async () => {
    if (this.mentionSeq !== seq) return null;
    return this.withComposerQuery(query, async () => {
      await this.cdp.send('Input.insertText', { text: trigger + String(q || '') });
      return this.codexMentionSettle(seq);
    });
  }).catch(e => { this.emit({ t: 'status', ok: false, msg: e.message }); return null; });
  if (out && this.mentionSeq === seq) this.emit({ t: 'mentions', sel: this.selectionKey(), seq, q, trigger, rows: this.mentionPayload(out) });
},

async codexOpenMention(trigger, q) {
  await this.codexFocusPrompt();
  await this.cdp.send('Input.insertText', { text: trigger + String(q || '') });
  return this.codexMentionSettle();
},

async codexPick(msg) {
  if (this.app !== 'codex') return;
  const trigger = msg.section === 'commands' || msg.section === 'Skills' ? '/' : '@';
  const parentQ = String(msg.parentQ || msg.q || '').slice(0, 60);
  return this.withMentionLock(null, () => this.withComposerQuery(msg, async () => {
    await this.cdp.send('Input.insertText', { text: trigger + parentQ });
    let rows = await this.codexMentionSettle();
    if (msg.parentKey) {
      const parent = rows.find(r => r.key === msg.parentKey) || rows.find(r => r.label === msg.parentLabel) || rows.find(r => msg.parentLabel && r.label.startsWith(msg.parentLabel));
      if (!parent) throw new Error('电脑上的菜单里没有上一级');
      await this.tapCss(parent.x, parent.y);
      await new Promise(r => setTimeout(r, 350));
      rows = await this.codexMentionSettle();
    }
    const hit = rows.find(r => msg.key && r.key === msg.key) || rows.find(r => r.label === msg.label) || rows.find(r => msg.label && (r.label === msg.label || r.label.startsWith(msg.label)));
    if (!hit) throw new Error('电脑上的菜单里没有这一项');
    await this.tapCss(hit.x, hit.y);
    await new Promise(r => setTimeout(r, 400));
    const dialog = await this.cdp.evaluate(`(() => { const doc = document.getElementById('active-frame')?.contentDocument || document; return [...doc.querySelectorAll('[role=dialog]')].some(e => e.getBoundingClientRect().height > 40); })()`);
    if (dialog) {
      this.emit({ t: 'status', ok: true, msg: '请在请求卡片中确认' });
      this.refreshSoon(300);
      return;
    }
    const next = await this.cdp.evaluate(helpersCall('codexMentionRows()')) || [];
    const branched = next.length && !next.some(r => r.key === hit.key && r.label === hit.label);
    if (branched) {
      this.emit({
        t: 'mentions', sel: this.selectionKey(), seq: Number(msg.seq) || 0, submenu: true, q: '',
        parent: { key: hit.key, label: hit.label, q: parentQ, section: hit.section || msg.section || '' },
        rows: this.mentionPayload(next),
      });
      return;
    }
    this.emit({ t: 'status', ok: true, msg: `已执行 ${hit.label.split('\n')[0]}` });
    this.refreshSoon(300);
  }));
},

async codexSkillList() {
  const rows = await this.withMentionLock(null, async () => {
    await this.codexFocusPrompt();
    const before = await this.codexPrompt();
    try {
      // Opening the native menu loads skills even after its query cache has expired.
      await this.codexOpenMention('/', '');
      return await this.cdp.evaluate(helpersCall('codexSkills()'));
    } finally { await this.codexRestorePrompt(before); }
  });
  this.emit({ t: 'codexSkills', rows });
},

async codexTogglePlan() {
  const before = (await this.cdp.evaluate(helpersCall('codexFacts()')))?.view?.plan;
  await this.codexPick({ section: 'commands', key: 'plan-mode', label: 'Plan mode', q: '' });
  const after = (await this.cdp.evaluate(helpersCall('codexFacts()')))?.view?.plan;
  if (after === before) throw new Error('Plan 模式没有跟着电脑变化');
  this.emit({ t: 'status', ok: true, msg: after ? '已打开 Plan' : '已关闭 Plan' });
},

async codexToggleIde() {
  const before = (await this.cdp.evaluate(helpersCall('codexFacts()')))?.view?.ide?.on;
  await this.codexPick({ section: 'commands', label: 'IDE context', q: 'ide' });
  let after = before;
  for (let i = 0; i < 12 && after === before; i++) {
    await new Promise(r => setTimeout(r, 150));
    after = (await this.cdp.evaluate(helpersCall('codexFacts()')))?.view?.ide?.on;
  }
  if (after === before) throw new Error('IDE 上下文没有切换成功');
  this.emit({ t: 'status', ok: true, msg: after ? 'IDE 上下文已打开' : 'IDE 上下文已关闭' });
},

async codexRunMenu() {
  const items = await readCodexMenu(this, 'run') || [];
  await this.closeMenus();
  this.emit({ t: 'menu', kind: 'codex-run', items: items.filter(it => /^(Local|Cloud|Worktree|Connect Codex web)\b/.test(it.label)).map(it => ({ label: it.label, checked: false })) });
},

async codexRunPick(label) {
  const hit = await readCodexMenu(this, 'run', items => items.find(it => it.label === label));
  if (!hit) { await this.closeMenus(); throw new Error(`没找到执行位置：${label}`); }
  await this.tapCss(hit.x, hit.y);
  await new Promise(r => setTimeout(r, 300));
  const run = (await this.cdp.evaluate(helpersCall('codexFacts()')))?.view?.run || '';
  this.emit({ t: 'status', ok: true, msg: run ? `执行位置：${run}` : `已选择 ${label}` });
  this.refreshSoon(300);
},

async codexChatMenu() {
  const items = await readCodexMenu(this, 'actions') || [];
  await this.closeMenus();
  this.emit({ t: 'menu', kind: 'codex-chat', items: items.map(it => ({ label: it.label, checked: false })) });
},

async codexChatPick(label, name) {
  const hit = await readCodexMenu(this, 'actions', items => items.find(it => it.label === label));
  if (!hit) { await this.key('Escape'); throw new Error(`没找到会话操作：${label}`); }
  const thread = await this.cdp.evaluate(helpersCall('codexThread()'));
  await this.tapCss(hit.x, hit.y);
  await new Promise(r => setTimeout(r, 300));
  if (label === 'Rename' && name) {
    const opened = await this.cdp.evaluate(`(() => {
      const doc = document.getElementById('active-frame')?.contentDocument || document;
      const input = [...doc.querySelectorAll('input, textarea')].find(e => e.getBoundingClientRect().height > 8);
      if (!input) return false;
      input.focus();
      input.select?.();
      return true;
    })()`);
    if (!opened) throw new Error('重命名输入框没有出现');
    await this.typeText(String(name).slice(0, 80));
    await this.key('Enter');
  }
  this.emit({ t: 'status', ok: true, msg: `已执行 ${label}` });
  const now = await this.cdp.evaluate(helpersCall('codexThread()'));
  if (now && now !== thread) await this.adoptCodexThread(now);
  this.refreshSoon(300);
  setTimeout(() => this.listAgents().catch(() => {}), 400);
},

async codexRenameThread(agentId, name) {
  if (this.app !== 'codex') throw new Error('只有 Codex 会话可以重命名');
  const next = String(name || '').trim().slice(0, 80);
  if (!next) throw new Error('会话名称不能为空');
  const match = /^thread:([^:]+):(.+)$/.exec(String(agentId || ''));
  if (!match) throw new Error('这条会话不能重命名');
  const pageId = match[1], convId = match[2];
  const page = (await codexWindows(CODEX_CDP_URL)).find(p => p.pageId === pageId);
  if (!page?.chatWs) throw new Error('这个窗口已经关闭');
  const own = pageId === this.codexPageId && this.cdp;
  const cdp = own ? this.cdp : new Cdp(page.chatWs);
  let beforeThread = '';
  try {
    if (!own) await cdp.connect();
    beforeThread = await cdp.evaluate(helpersCall('codexThread()')) || '';
    if (beforeThread !== convId && !await this.selectCodexThread(convId, cdp)) throw new Error('没有找到这个会话');
    const pos = await cdp.evaluate(helpersCall(`codexButtonPoint('actions')`));
    if (!pos) throw new Error('当前会话没有操作菜单');
    await this.tapCss(pos.x, pos.y, 'left', cdp);
    let hit = null;
    for (let i = 0; i < 10 && !hit; i++) {
      await new Promise(r => setTimeout(r, 120));
      hit = (await cdp.evaluate(helpersCall('codexRunItems()')) || []).find(it => /^Rename(?: chat)?$/i.test(String(it.label || '').replace(/\s+/g, ' ').trim()));
    }
    if (!hit) { await cdp.evaluate(helpersCall('closeCodexMenu()')); throw new Error('没有找到重命名入口'); }
    await this.tapCss(hit.x, hit.y, 'left', cdp);
    const opened = await cdp.evaluate(`(() => {
      const doc = document.getElementById('active-frame')?.contentDocument || document;
      const input = [...doc.querySelectorAll('input, textarea')].find(e => e.getBoundingClientRect().height > 8);
      if (!input) return false;
      input.focus(); input.select?.(); return true;
    })()`);
    if (!opened) throw new Error('重命名输入框没有出现');
    await this.typeText(next, cdp);
    await this.key('Enter', { cdp });
    let renamed = false;
    for (let i = 0; i < 20 && !renamed; i++) {
      await new Promise(r => setTimeout(r, 150));
      const rows = await this.codexThreadRows(cdp).catch(() => []);
      renamed = rows.some(row => row.id === convId && String(row.title || '').trim() === next);
    }
    if (!renamed) throw new Error('桌面端未确认会话名称已更新');
    if (beforeThread && beforeThread !== convId) await this.selectCodexThread(beforeThread, cdp);
    if (own) { this.lastChatAt = 0; await this.pollChat(); }
    await this.listAgents();
  publishSessionChange('codex', convId, { action: 'rename', title: next });
    this.emit({ t: 'status', ok: true, msg: '已重命名会话' });
  } finally {
    if (!own) { try { cdp.close(); } catch {} }
  }
},

noteFusionRemoved(convId) {
  if (!this.fusionRun) return false;
  let hit = false;
  for (const which of ['a', 'b']) {
    const side = this.fusionRun[which];
    if (side && (side.agentId === convId || String(side.id || '').endsWith(':' + convId))) {
      this.fusionRun[which] = null;
      hit = true;
    }
  }
  if (hit) (this.fusionOwner || this).fusionEmit();
  return hit;
},

async codexArchiveThread(agentId) {
  if (this.app !== 'codex') throw new Error('只有 Codex 会话可以这样移除');
  const match = /^thread:([^:]+):(.+)$/.exec(String(agentId || ''));
  if (!match) throw new Error('这条会话不能移除');
  const pageId = match[1], convId = match[2];
  const pages = await codexWindows(CODEX_CDP_URL);
  const page = pages.find(p => p.pageId === pageId);
  if (!page?.chatWs) throw new Error('这个窗口已经关闭');
  const own = pageId === this.codexPageId && this.cdp;
  const cdp = own ? this.cdp : new Cdp(page.chatWs);
  const wasCurrent = !!own && this.threadId === convId;
  try {
    if (!own) await cdp.connect();
    const beforeThread = await cdp.evaluate(helpersCall('codexThread()')) || '';
    const pos = await cdp.evaluate(helpersCall('codexRecentPoint()'));
    if (!pos) throw new Error('没有找到会话列表');
    if (!pos.open) await this.tapCss(pos.x, pos.y, 'left', cdp);
    let target = null;
    for (let i = 0; i < 8 && !target; i++) {
      await new Promise(r => setTimeout(r, 120));
      target = await cdp.evaluate(helpersCall(`codexArchiveTarget(${JSON.stringify(convId)})`));
    }
    if (!target?.action) {
      await cdp.evaluate(helpersCall('closeCodexMenu()'));
      throw new Error(target ? '这个会话没有归档或删除入口' : '没有找到这个会话');
    }
    await this.tapCss(target.x, target.y, 'left', cdp);
    let removed = false;
    for (let i = 0; i < 60 && !removed; i++) {
      await new Promise(r => setTimeout(r, 150));
      const confirm = await cdp.evaluate(helpersCall(`codexArchiveConfirm(${JSON.stringify(convId)})`));
      if (confirm) await this.tapCss(confirm.x, confirm.y, 'left', cdp);
      removed = await cdp.evaluate(helpersCall(`codexArchiveDone(${JSON.stringify(convId)}, ${JSON.stringify(target.action)})`));
    }
    await cdp.evaluate(helpersCall('closeCodexMenu()'));
    if (!removed) throw new Error('桌面端尚未确认删除或归档完成');
    const afterThread = await cdp.evaluate(helpersCall('codexThread()')) || '';
    if (!wasCurrent && afterThread && beforeThread && afterThread !== beforeThread) {
      const phoneThread = this.threadId;
      const saved = this.cdp;
      this.cdp = cdp;
      try { if (!await this.selectCodexThread(beforeThread) && own) this.threadId = afterThread; }
      finally { this.cdp = saved; if (!own) this.threadId = phoneThread; }
    } else if (wasCurrent) {
      this.threadId = afterThread;
      this.publishThread();
      this.lastChatAt = 0;
      await this.pollChat();
    }
    const fusion = this.noteFusionRemoved(convId);
    await this.listAgents();
    if (target.action === 'Delete chat') removeLibrarySession('codex', convId);
    publishSessionChange('codex', convId, { action: target.action === 'Delete chat' ? 'delete' : 'archive' });
    this.emit({ t: 'codexArchived', id: agentId, action: target.action });
    this.emit({ t: 'status', ok: true, msg: fusion ? '会话已移除，请重新选择' : (target.action === 'Delete chat' ? '已删除' : '已归档') });
  } catch (e) {
    await this.listAgents().catch(() => {});
    throw e;
  } finally {
    if (!own) { try { cdp.close(); } catch {} }
  }
},

async insertCodexMention(m, before) {
  if (m.section === 'local-files') return this.cdp.evaluate(helpersCall(`codexAddFiles(${JSON.stringify([m.path])})`));
  const trigger = m.trigger === '/' ? '/' : '@';
  const typed = trigger + (m.q || m.label);
  await this.cdp.send('Input.insertText', { text: typed });
  const rows = await this.codexMentionSettle();
  const hit = rows.find(r => m.key && r.key === m.key) || rows.find(r => r.label === m.label) || rows.find(r => m.label && r.label.startsWith(m.label));
  if (!hit) { await this.codexRestorePrompt(before); return false; }
  await this.tapCss(hit.x, hit.y);
  await new Promise(r => setTimeout(r, 250));
  return true;
},

async typeWithCodexMentions(text, mentions) {
  let rest = text;
  for (const m of mentions) {
    const at = rest.indexOf(m.token);
    if (at < 0) continue;
    if (at > 0) await this.typeText(rest.slice(0, at));
    rest = rest.slice(at + m.token.length);
    const before = await this.codexPrompt();
    if (await this.insertCodexMention(m, before)) rest = rest.replace(/^ /, '');
    else await this.typeText(m.token);
  }
  if (rest) await this.typeText(rest);
}
};
