import path from 'node:path';
import { windowRoots } from '../../lib/files.mjs';
import { agentMarks } from '../../lib/marks.mjs';
import { IS_WIN, mod, pathKey } from '../../lib/platform.mjs';
import { listWindows } from '../windows.mjs';
import { PAGE_SRC, helpersCall } from '../page/build.mjs';
import { FOCUS_COMPOSER } from '../agent/context.mjs';

// Shared across phone sessions: thread|start → end ms (null while the turn is still running).
const devinTurnEnds = new Map();

export const adapter = {
  async newChat() {
    return this.devinNewChat();
  },

  async openAgent(id, title = '', retried = false) {
    if (IS_WIN && id.startsWith('window:devin:')) {
      await this.attach(id.slice('window:'.length));
      await this.listAgents();
      return;
    }
    if (id.startsWith('tab:')) return this.switchTab(id.slice(4));
    let { surface, row, title: windowTitle } = await this.cdp.evaluate(`(() => {
      const h = ${PAGE_SRC};
      const surface = h.devinSurface();
      return { surface, title: document.title, row: surface === 'agent' ? h.agentList().find(row => row.id === ${JSON.stringify(id)}) : null };
    })()`);
    this.winTitle = windowTitle;
    if (surface === 'agent' && retried && !row) {
      // The session list on a freshly switched surface is still loading; wait for the row.
      for (let i = 0; i < 40 && !row; i++) {
        await new Promise(r => setTimeout(r, 250));
        row = await this.cdp.evaluate(`(() => {
          const h = ${PAGE_SRC};
          return h.agentList().find(row => row.id === ${JSON.stringify(id)});
        })()`);
      }
    }
    if (row?.workspace && !row.host && !windowRoots(windowTitle, 'devin').some(w => !w.host && pathKey(w.root) === pathKey(row.workspace))) {
      return this.useProject(row.workspace, false, id);
    }
    if (surface === 'editor') {
      const opened = await this.openSessionPicker();
      const pos = opened && await this.cdp.evaluate(helpersCall(`sessionPickerTarget(${JSON.stringify(id)}, ${JSON.stringify(title)})`));
      if (!pos) {
        if (opened) await this.key('Escape');
        // A window that just opened lands on the editor surface; its picker only knows
        // this project's sessions. Switch to the agent surface and try the row there.
        if (!retried) {
          await this.setSurface('agent');
          return this.adapter.openAgent.call(this, id, title, true);
        }
        throw new Error('这条 Agent 已经不在列表里');
      }
      await this.tapCss(pos.x, pos.y);
      this.resetDevinView();
      this.emit({ t: 'status', ok: true, msg: '已切换 Agent' });
      setTimeout(() => this.pollChat().catch(() => {}), 500);
      return;
    }
    if (!id || id.length > 200) throw new Error('这条 Agent 已经不在列表里');
    this.sel++; this.lastChat = ''; this.lastAttachments = null;
    this.switchingThread = true;
    try {
      const pos = await this.cdp.evaluate(helpersCall(`agentTarget(${JSON.stringify(id)}, true)`));
      if (!pos) throw new Error('这条 Agent 已经不在列表里');
      if (pos !== true) await this.tapCss(pos.x, pos.y);
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 150));
        const thread = await this.cdp.evaluate(helpersCall('activeThread()'));
        if (thread !== id) continue;
        this.threadId = thread;
        this.publishThread('已切换 Agent');
        return;
      }
      throw new Error('会话切换没有生效');
    } finally {
      this.switchingThread = false;
      this.lastChatAt = 0;
      await this.pollChat();
    }
  },

  async listAgents(silent, readOnly, emit) {
    const surface = await this.cdp.evaluate(helpersCall('devinSurface()'));
    if (surface === 'editor') {
      if (readOnly) {
        const session = await this.cdp.evaluate(helpersCall('devinSession()'));
        return emit({ list: (session?.tabs || []).map(tab => ({ id: `tab:${tab.id}`, title: tab.title, group: '已打开的会话', current: tab.active, running: false })), surface, partial: true });
      }
      return emit({ list: await this.editorSessions(), surface });
    }
    const list = await this.cdp.evaluate(helpersCall('agentList()'));
    return emit({ list: list || [], ...(surface ? { surface } : {}) });
  },

  async currentRoots() {
    const title = IS_WIN ? await this.editorCdp.evaluate('document.title') : this.winTitle || '';
    return windowRoots(title, 'devin', '').filter(w => !w.host);
  },

  async queueAction(id, action) {
    return this.devinQueueAction(id, action);
  },

  async listChanges() {
    const s = await this.withFiles(async s => s);
    if (!s.count) {
      const chat = await this.cdp.evaluate(helpersCall('extract()'));
      this.syncSession(chat);
      this.mergeDevinHistory(chat);
      const files = new Map();
      for (const it of chat?.items || []) if (it.kind === 'edit' && it.f) {
        const prev = files.get(it.f);
        const add = (prev?.add || 0) + (it.add || 0), del = (prev?.del || 0) + (it.del || 0);
        files.set(it.f, { name: it.f, add, del });
      }
      return this.emit({ t: 'changes', devin: true, historical: true, files: [...files.values()].map(f => ({ ...f, add: `+${f.add}`, del: `-${f.del}` })), actions: [], count: files.size });
    }
    this.emit({ t: 'changes', ...s, devin: true });
  },

  async mentionQuery(q, cat, seq, trigger) {
    this.mentionSeq = seq;
    const out = await this.withMentionLock(seq, async () => {
      if (this.mentionSeq !== seq) return null;
      if (!await this.cdp.evaluate(FOCUS_COMPOSER)) throw new Error('没找到可见的聊天输入框');
      const before = await this.cdp.evaluate(helpersCall('composerState()'));
      let typed = 1, prefix = '';
      await this.cdp.send('Input.insertText', { text: '@' });
      await new Promise(r => setTimeout(r, 450));
      if (cat) {
        const root = await this.mentionSettle();
        const idx = root.findIndex(r => r.label.toLowerCase() === cat.toLowerCase());
        if (idx >= 0) {
          for (let i = 0; i < idx; i++) await this.key('ArrowDown');
          await this.key('Enter');
          await new Promise(r => setTimeout(r, 350));
          const now = await this.cdp.evaluate(helpersCall('composerState()'));
          prefix = (now || '').slice((before || '').length).trim();
          typed = prefix.length || typed;
        }
      } else if (q) {
        await this.cdp.send('Input.insertText', { text: q });
        typed += q.length;
      }
      const rows = await this.mentionSettle();
      await this.mentionUndo(typed, before);
      return { rows, prefix };
    }).catch(e => { this.emit({ t: 'status', ok: false, msg: e.message }); return null; });
    if (out && this.mentionSeq === seq) {
      this.emit({ t: 'mentions', seq, q, cat, prefix: out.prefix, root: !q && !cat, rows: out.rows.slice(0, 40).map(r => ({ label: r.label, sub: r.sub })) });
    }
  
  },

  async withFiles(fn, { act = false } = {}) {
    const state = () => this.cdp.evaluate(helpersCall('filesState()'));
    const settle = async (s, ok) => { for (let i = 0; i < 15 && !ok(s); i++) { await new Promise(r => setTimeout(r, 100)); s = await state(); } return s; };
    let s = await settle(await state(), x => x.files.length >= x.count);
    if (!act) return fn(s);
    let toggled = false;
    if (!s.open) {
      const t = await this.cdp.evaluate(helpersCall('fileTarget(0, "", "toggle")'));
      if (t) {
        await this.tapCss(t.x, t.y);
        toggled = true;
        s = await settle(s, x => x.open);
      }
    }
    try {
      return await fn(s);
    } finally {
      if (toggled && (await state()).open) {
        const t = await this.cdp.evaluate(helpersCall('fileTarget(0, "", "toggle")'));
        if (t) await this.tapCss(t.x, t.y);
      }
    }
  
  },

  async newTerminal() {
    const menu = await this.editorCdp.evaluate(helpersCall('newTerminalMenu()'));
    if (!menu) throw new Error('当前窗口里找不到新建终端的按钮');
    await this.tapCss(menu.x, menu.y, 'left', this.editorCdp);
    let item = null;
    for (let i = 0; i < 10 && !item; i++) {
      await new Promise(r => setTimeout(r, 120));
      item = await this.editorCdp.evaluate(helpersCall('newTerminalItem()'));
    }
    if (!item) {
      await this.key('Escape', { cdp: this.editorCdp });
      throw new Error('菜单里没有终端这一项');
    }
    await this.tapCss(item.x, item.y, 'left', this.editorCdp);
  },

  async accountUsage(request, automatic) {
    return this.cdp.evaluate(helpersCall('readDevinUsage(true)'));
  },

  async typeDraft(text, mentions) {
    if (mentions?.length) await this.typeWithMentions(text, mentions);
    else await this.typeText(text);
  },

  async fileAgentMarks(f, text) {
    const m = agentMarks(this.devinHist, f.path, text);
    if (m && (m.add.length || m.del.length)) return { marks: m, markSource: 'agent' };
    return null;
  },

  async pickModelMenu(label) {
    if (!await this.cdp.evaluate(helpersCall(`pickDevinModel(${JSON.stringify(String(label))})`))) return false;
    this.emit({ t: 'status', ok: true, msg: `已切换到 ${label}` });
    this.pollChat().catch(() => {});
    await this.openMenu('effort').catch(() => {});
    return true;
  },
};

export const methods = {

// Devin virtualizes its transcript: only rows near the viewport stay mounted, so a poll
// sees a sliding window of acp-indexed rows. Merge each window into per-session history
// keyed by the stable acp ids; remembered rows keep their last seen content. Sorted by
// acp index (a thinking item `acpN:think` travels with row N) and capped at ~1500 items.
mergeDevinHistory(chat) {
  if (!chat?.items) return;
  this.syncSession(chat);
  if (chat.empty) { this.devinHist.clear(); chat.earlier = false; return; }
  if (!chat.items.some(it => it.src === 'devin') && !(this.devinHist?.size && !chat.items.length)) return;
  if (!this.devinHist) this.devinHist = new Map();
  const hist = this.devinHist;
  const num = id => {
    const m = /^acp(\d+)/.exec(id || '');
    return m ? Number(m[1]) : -1;
  };
  const mounted = chat.items.map(it => num(it.i)).filter(n => n >= 0);
  const minM = mounted.length ? Math.min(...mounted) : Infinity;
  const maxM = mounted.length ? Math.max(...mounted) : -1;
  if (hist.size && mounted.length) {
    const known = [...hist.keys()].map(num).filter(n => n >= 0);
    if (known.length) {
      const minR = Math.min(...known), maxR = Math.max(...known);
      const overlap = mounted.some(n => n >= minR && n <= maxR);
      // A new session restarts indexes at 0; sliding to a range entirely below what we
      // remember means the window was switched without an attach reset.
      if (maxM < minR || (!overlap && minM === 0)) hist.clear();
    }
  }
  // Sticky thoughts: a remounted collapsed thought has no body; keep the body we already have.
  for (const it of chat.items) {
    const next = it.src === 'devin' ? it : { ...it, src: 'devin' };
    const prev = hist.get(it.i);
    const pb = prev?.k === 'thinking' ? this.thinkingBody(prev) : '';
    if (next.k === 'tasks' && !next.items && prev?.items && prev.done === next.done && prev.total === next.total) hist.set(it.i, { ...next, items: prev.items });
    else hist.set(it.i, next.k === 'thinking' && pb.length > this.thinkingBody(next).length
      ? { ...next, t: `${this.thinkingTitle(next)}\n${pb}` }
      : next);
  }
  const merged = [...hist.values()].sort((a, b) => num(a.i) - num(b.i));
  while (merged.length > 1500) hist.delete(merged.shift().i);
  // Thought bodies are kept up to ~2 MB in total; the oldest drop to title-only first.
  let kept = 0;
  for (const it of merged.slice().reverse()) {
    if (it.k !== 'thinking') continue;
    const n = this.thinkingBody(it).length;
    if (!n) continue;
    if (kept + n > 2000000) hist.set(it.i, { ...it, t: this.thinkingTitle(it) });
    else kept += n;
  }
  // Payload: newest thoughts (12 or 80 KB) carry their body; older ones are title-only with more:true
  // and their body is requested on demand with {t:'thought', i}.
  let used = 0, count = 0;
  const full = [...hist.values()].sort((a, b) => num(a.i) - num(b.i));
  const sent = new Set();
  for (const it of full.slice().reverse()) {
    if (it.k !== 'thinking') continue;
    const n = this.thinkingBody(it).length;
    if (!n) continue;
    if (count < 12 && used + n <= 80000) { used += n; count++; sent.add(it.i); }
  }
  chat.items = full.map(it => it.k === 'thinking' && this.thinkingBody(it) && !sent.has(it.i)
    ? { ...it, t: this.thinkingTitle(it), more: true }
    : it);
  const known = [...hist.keys()].map(num).filter(n => n >= 0);
  const floor = known.length ? Math.min(...known) : minM;
  chat.earlier = floor > 0;
},


// Devin queue rows: hover the row (buttons appear on hover), then tap Send now / Remove from queue.
// Edit and reorder are not offered. "Clear all" is a bar-level button.
async devinQueueAction(id, action) {
  if (!['send', 'remove'].includes(action)) throw new Error('不支持的排队操作');
  const n = /^dq(\d+)$/.exec(String(id))?.[1];
  const row = n == null ? null : await this.cdp.evaluate(helpersCall(`devinQueueTarget(${n})`));
  if (!row) throw new Error('这条排队消息已经不在了（可能刚被发出）');
  await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y });
  let pos = null;
  for (let i = 0; i < 6 && !pos; i++) {
    await new Promise(r => setTimeout(r, 80));
    pos = await this.cdp.evaluate(helpersCall(`devinQueueTarget(${n}, ${JSON.stringify(action)})`));
  }
  if (!pos) throw new Error('没找到排队消息的操作按钮（可能 Devin 版本不同）');
  await this.tapCss(pos.x, pos.y);
  setTimeout(() => this.pollChat().catch(() => {}), 300);
},


// Devin "edit": take the queued message out of the queue and hand its text to the phone's input box.
async devinTakeOut(id) {
  const q = (await this.cdp.evaluate(helpersCall('devinQueued()')) || []).find(x => x.id === id);
  if (!q || !q.t) throw new Error('这条排队消息已经不在了（可能刚被发出）');
  await this.devinQueueAction(id, 'remove');
  this.emit({ t: 'unqueued', id, text: q.t });
},

async devinClearQueue() {
  const pos = await this.cdp.evaluate(helpersCall('devinQueueClearTarget()'));
  if (!pos) throw new Error('没找到清空排队消息的按钮（可能 Devin 版本不同）');
  await this.tapCss(pos.x, pos.y);
  this.emit({ t: 'status', ok: true, msg: '已清空排队消息' });
  setTimeout(() => this.pollChat().catch(() => {}), 300);
},

async subagentAction(name, part) {
  const call = `subTarget(${JSON.stringify(String(name))}, ${JSON.stringify(part)})`;
  let pos = await this.cdp.evaluate(helpersCall(call));
  if (pos?.expand) {
    await this.tapCss(pos.x, pos.y);
    for (let i = 0; i < 8 && (!pos || pos.expand); i++) {
      await new Promise(r => setTimeout(r, 120));
      pos = await this.cdp.evaluate(helpersCall(call));
    }
  }
  if (!pos || pos.expand) throw new Error(this.appMessage('这个子 Agent 已经结束了，或者 {app} 里找不到它'));
  if (part === 'open') {
    const tab = await this.cdp.evaluate(helpersCall('activeChatTab()'));
    if (tab && await this.cdp.evaluate(helpersCall('hasComposer()'))) this.mainTab = tab;
  }
  await this.tapCss(pos.x, pos.y);
  setTimeout(() => this.pollChat().catch(() => {}), 500);
},

async backToMain() {
  const pos = this.mainTab && await this.cdp.evaluate(helpersCall(`tabTarget(${JSON.stringify(this.mainTab)})`));
  if (!pos) throw new Error('找不到原来的主对话标签页，请在「画面」里手动切回');
  await this.tapCss(pos.x, pos.y);
  setTimeout(() => this.pollChat().catch(() => {}), 400);
},


// Devin thoughts beyond the payload budget are title-only; the body is read from the history,
// or expanded in the transcript once (and folded back) when it was never captured.
async thought(id) {
  if (!/^acp\d+:think$/.test(id)) return this.emit({ t: 'thought', i: id, text: null });
  const it = this.devinHist.get(id);
  let body = it ? this.thinkingBody(it) : '';
  if (!body && this.cdp) {
    body = await this.readThought(id);
    if (body && it) this.devinHist.set(id, { ...it, t: `${this.thinkingTitle(it)}\n${body}` });
  }
  this.emit({ t: 'thought', i: id, text: body || null });
},


// Devin: a collapsed thought has no body in the DOM. Expand it (only if the user has not), wait up to
// ~1.5 s for the body to render, read it, and fold it back to the state it was in. Returns '' if not read.
async readThought(id) {
  const st = await this.cdp.evaluate(helpersCall(`thoughtState(${JSON.stringify(id)})`));
  if (!st) return '';
  if (st.expanded) return this.cdp.evaluate(helpersCall(`thoughtBodyText(${JSON.stringify(id)})`)).then(t => t || '');
  await this.cdp.evaluate(helpersCall(`setThoughtOpen(${JSON.stringify(id)}, true)`));
  let body = '';
  for (let k = 0; k < 15 && !body; k++) {
    await new Promise(r => setTimeout(r, 100));
    body = (await this.cdp.evaluate(helpersCall(`thoughtBodyText(${JSON.stringify(id)})`))) || '';
  }
  await this.cdp.evaluate(helpersCall(`setThoughtOpen(${JSON.stringify(id)}, false)`));
  return body;
},


// Devin: finished thoughts in the mounted transcript that have no body yet, plus collapsed finished
// thoughts we hold a body for — it was captured mid-stream and may be truncated, so re-read once and
// treat the read as authoritative even when shorter. The live flag misses thoughts whose title shows
// a running timer, so a stored body (or a seen-live id) is the trigger; an empty extracted body means
// the row collapsed, i.e. finished. Expanded rows keep their extracted body — the merge handles those.
// Up to 2 per poll (finalization candidates first); a thought is only marked tried once its body was
// read, or after 3 failed reads on different polls.
async captureThoughts(chat) {
  if (this.app !== 'devin') return;
  this.thoughtPoll = (this.thoughtPoll || 0) + 1;
  this.thoughtFails = this.thoughtFails || new Map();
  this.thinkLiveSeen = this.thinkLiveSeen || new Set();
  this.thinkFinal = this.thinkFinal || new Set();
  const items = chat?.items || [];
  for (const it of items) if (it.k === 'thinking' && it.live && it.src === 'devin') this.thinkLiveSeen.add(it.i);
  while (this.thinkLiveSeen.size > 200) this.thinkLiveSeen.delete(this.thinkLiveSeen.keys().next().value);
  const fin = items.filter(it => it.k === 'thinking' && !it.live && it.src === 'devin'
    && !this.thinkingBody(it) && !this.thinkFinal.has(it.i)
    && (this.thinkLiveSeen.has(it.i) || this.thinkingBody(this.devinHist.get(it.i)) || this.thinking.get(it.i)?.body));
  const finIds = new Set(fin.map(it => it.i));
  const fresh = items.filter(it => it.k === 'thinking' && !it.live && it.src === 'devin' && !finIds.has(it.i)
    && !this.thinkingBody(it) && !this.thinkingTried.has(it.i) && !(this.devinHist.get(it.i) && this.thinkingBody(this.devinHist.get(it.i))));
  const todo = [...fin.reverse(), ...fresh.reverse()].slice(0, 2);
  for (const it of todo) {
    const body = await this.readThought(it.i);
    if (body) {
      it.t = `${this.thinkingTitle(it)}\n${body}`;
      this.thinkingTried.set(it.i, 1);
      this.thinkFinal.add(it.i);
      if (finIds.has(it.i)) {
        this.devinHist.set(it.i, { ...(this.devinHist.get(it.i) || it), t: it.t });
        this.thinking.set(it.i, { body });
        if (this.keptThink?.has(it.i)) this.keptThink.get(it.i).body = body;
        if (this.latestThink?.id === it.i) this.latestThink.body = body;
        this.thinkFinal.add(it.i);
      }
      continue;
    }
    const f = this.thoughtFails.get(it.i) || { n: 0, poll: 0 };
    if (f.poll !== this.thoughtPoll) f.n++;
    f.poll = this.thoughtPoll;
    this.thoughtFails.set(it.i, f);
    if (f.n >= 3) {
      this.thinkingTried.set(it.i, 1);
      if (finIds.has(it.i)) this.thinkFinal.add(it.i);
    }
  }
},


// Devin sessions: everything remembered from a transcript (rows, thought bodies, task lists) belongs to ONE
// session. When the desktop shows another session (a tab was clicked there, the phone switched, a new
// session started) park this session's state under its title and load the other's, never merge them.
// A rename (the title changed while the set of tabs stayed the same) keeps the state.
syncSession(chat) {
  const sess = chat?.session;
  if (this.app !== 'devin' || !sess) return;
  // Keep the session's real working directory so the phone's project label is right
  // even when the window itself has no folder ("Untitled (Workspace)").
  if ((sess.cwd || '') !== this.sessionCwd) {
    this.sessionCwd = sess.cwd || '';
    this.emit({ t: 'thread', windowId: this.windowId || '', threadId: this.threadId || '', sel: this.selectionKey(), project: this.projectName() });
  }
  const key = chat.thread || sess.key;
  if (this.curSession === undefined || this.curSession === key) { this.curSession = key; return; }
  if (!this.sessStore) this.sessStore = new Map();
  const FIELDS = ['devinHist', 'thinking', 'thinkingTried', 'keptThink', 'tasksTried', 'thoughtFails', 'latestThink', 'thinkLiveSeen', 'thinkFinal'];
  const fresh = () => ({ devinHist: new Map(), thinking: new Map(), thinkingTried: new Map(), keptThink: new Map(), tasksTried: new Map(), thoughtFails: new Map(), latestThink: null, thinkLiveSeen: new Set(), thinkFinal: new Set() });
  const saved = {};
  for (const f of FIELDS) saved[f] = this[f];
  this.sessStore.set(this.curSession, saved);
  const next = this.sessStore.get(key) || fresh();
  for (const f of FIELDS) this[f] = next[f];
  while (this.sessStore.size > 24) this.sessStore.delete(this.sessStore.keys().next().value);
  this.curSession = key;
  this.lastChat = '';
  this.thoughtPoll = 0;
},


// Devin revert: hover + click the row's revert button. Devin then either rewinds the transcript at once
// (nothing on disk to undo: no dialog) or shows a confirmation with the file changes. Nothing is
// confirmed here; the phone answers with revertOk (confirm) or revertCancel.
async revert(i) {
  if (this.app !== 'devin' || !/^acp\d+$/.test(String(i))) throw new Error('不支持的操作');
  this.pendingRevert = null;
  const num = Number(/\d+/.exec(i)[0]);
  const row = await this.cdp.evaluate(helpersCall(`revertTarget(${JSON.stringify(i)}, 'row')`));
  if (!row) throw new Error('这条消息已经不在了');
  await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y });
  await new Promise(r => setTimeout(r, 150));
  let btn = null;
  for (let k = 0; k < 6 && !btn; k++) {
    btn = await this.cdp.evaluate(helpersCall(`revertTarget(${JSON.stringify(i)}, 'btn')`));
    if (!btn) await new Promise(r => setTimeout(r, 100));
  }
  if (!btn) throw new Error('没找到回退按钮（可能 Devin 版本不同）');
  await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y });
  await this.tapCss(btn.x, btn.y);
  const gone = async () => { const s = await this.cdp.evaluate(helpersCall(`revertState(${JSON.stringify(i)})`)); return !s.rowHas || s.max < num; };
  let dlg = null, done = false;
  for (let k = 0; k < 40 && !dlg && !done; k++) {
    await new Promise(r => setTimeout(r, 200));
    dlg = await this.cdp.evaluate(helpersCall('revertDialog()'));
    if (!dlg) done = await gone();
  }
  if (done) return this.afterRevert(num);
  if (!dlg) throw new Error('没有出现回退确认框，也没看到对话被回退，请到电脑上看一下');
  this.pendingRevert = { i, num };
  this.emit({ t: 'revertConfirm', i, title: dlg.title || '回退到这条消息？', body: dlg.body || '', apply: dlg.apply, force: !!dlg.force });
},

async revertAnswer(ok, apply) {
  const pr = this.pendingRevert;
  if (!pr) return;
  this.pendingRevert = null;
  if (ok && typeof apply === 'boolean') {
    const d = await this.cdp.evaluate(helpersCall('revertDialog()'));
    if (d && d.apply !== null && d.apply !== apply) {
      const t = await this.cdp.evaluate(helpersCall('revertDialogButton("toggle")'));
      if (t) await this.tapCss(t.x, t.y);
    }
  }
  const pos = await this.cdp.evaluate(helpersCall(`revertDialogButton(${ok ? '"confirm"' : '"cancel"'})`));
  if (pos) await this.tapCss(pos.x, pos.y);
  else if (!ok) await this.key('Escape');
  else throw new Error('没找到回退确认按钮（可能 Devin 版本不同）');
  if (!ok) return void setTimeout(() => this.pollChat().catch(() => {}), 500);
  for (let k = 0; k < 40; k++) {
    await new Promise(r => setTimeout(r, 250));
    const s = await this.cdp.evaluate(helpersCall(`revertState(${JSON.stringify(pr.i)})`));
    if (!s.rowHas || s.max < pr.num) return this.afterRevert(pr.num);
  }
  this.emit({ t: 'status', ok: false, msg: '已点了确认，但还没看到对话被回退，请到电脑上看一下' });
},


// The transcript was rewound: rows from the reverted message on no longer exist. Forget them here and tell
// the phone to drop them from its local copy too.
afterRevert(num) {
  const n = id => Number(/^acp(\d+)/.exec(id || '')?.[1] ?? -1);
  for (const m of [this.devinHist, this.thinking, this.keptThink, this.thinkingTried, this.tasksTried, this.thoughtFails, this.thinkLiveSeen, this.thinkFinal]) {
    for (const k of [...(m?.keys() || [])]) if (n(k) >= num) m.delete(k);
  }
  this.lastChat = '';
  this.emit({ t: 'trunc', from: num });
  this.emit({ t: 'status', ok: true, msg: '已回退到这条消息之前' });
  setTimeout(() => this.pollChat().catch(() => {}), 300);
},

async setSurface(to) {
  if (this.app !== 'devin') throw new Error('不支持的操作');
  const want = to === 'editor' ? 'editor' : 'agent';
  const cur = await this.cdp.evaluate(helpersCall('devinSurface()'));
  if (cur === want) return this.emit({ t: 'status', ok: true, msg: want === 'editor' ? '已在 Editor 界面' : '已在 Agent 界面' });
  const pos = await this.cdp.evaluate(helpersCall(`surfaceTarget(${JSON.stringify(want)})`));
  if (!pos) throw new Error('找不到 Agent / Editor 切换按钮');
  await this.tapCss(pos.x, pos.y);
  let ready = false;
  for (let i = 0; i < 20 && !ready; i++) {
    await new Promise(r => setTimeout(r, 100));
    ready = (await this.cdp.evaluate(helpersCall('devinSurface()'))) === want;
  }
  this.resetDevinView();
  if (!ready) this.emit({ t: 'status', ok: false, msg: '这个界面还没有加载完，请稍后再试' });
  else this.emit({ t: 'status', ok: true, msg: want === 'editor' ? '已切到 Editor 界面' : '已切到 Agent 界面' });
  setTimeout(() => this.pollChat().catch(() => {}), 300);
},


// Devin's Editor surface has no session list in the panel; the titlebar "Search agents" quick pick
// lists every session by name. It is opened, read, and closed again with Escape.
async openSessionPicker() {
  const pos = await this.cdp.evaluate(helpersCall('sessionSearchTarget()'));
  if (!pos) throw new Error('没找到会话搜索按钮（可能 Devin 版本不同）');
  await this.tapCss(pos.x, pos.y);
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (await this.cdp.evaluate(helpersCall('sessionPickerRows()?.length'))) return true;
  }
  return false;
},

async editorSessions() {
  const sess = await this.cdp.evaluate(helpersCall('devinSession()'));
  const tabs = sess?.tabs || [];
  let rows = null, opened = false;
  try {
    opened = await this.openSessionPicker();
    rows = opened ? await this.cdp.evaluate(helpersCall('sessionPickerRows()')) : null;
  } catch (e) {
    if (!tabs.length) throw e;
  }
  if (opened) await this.key('Escape');
  if (!opened && !tabs.length) throw new Error('没有读到会话列表，请先切到 Agent 界面再试');
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const open = tabs.map(t => ({ id: `tab:${t.id}`, title: t.title, group: '已打开的会话', current: t.active, running: !!(rows || []).find(r => norm(r.title) === t.title)?.running }));
  const rest = (rows || []).filter(r => !tabs.some(t => t.title === norm(r.title))).map(r => ({ id: r.id, title: r.title, group: tabs.length ? '全部会话' : '', current: false, running: !!r.running }));
  return [...open, ...rest];
},


// Close a session tab (Editor surface). The session itself stays in Devin's session list.
async closeTab(title) {
  if (this.app !== 'devin') throw new Error('不支持的操作');
  const before = await this.cdp.evaluate(helpersCall('devinSession()'));
  const tabs = before?.tabs || [];
  if (!tabs.some(t => t.id === title)) throw new Error('这个会话标签已经关闭了');
  if (tabs.length <= 1) throw new Error('这是唯一打开的会话标签，不能关闭');
  const pos = await this.cdp.evaluate(helpersCall(`devinTabTarget(${JSON.stringify(title)})`));
  if (!pos) throw new Error('这个会话标签已经关闭了');
  await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
  let x = null;
  for (let i = 0; i < 8 && !x; i++) {
    await new Promise(r => setTimeout(r, 80));
    x = await this.cdp.evaluate(helpersCall(`devinTabCloseTarget(${JSON.stringify(title)})`));
  }
  if (!x) throw new Error('没找到这个标签的关闭按钮（可能 Devin 版本不同）');
  await this.cdp.evaluate(helpersCall(`clickDevinTabClose(${JSON.stringify(title)})`));
  let gone = false;
  for (let i = 0; i < 20 && !gone; i++) {
    await new Promise(r => setTimeout(r, 100));
    gone = !((await this.cdp.evaluate(helpersCall('devinSession()')))?.tabs || []).some(t => t.id === title);
  }
  this.resetDevinView();
  this.emit({ t: 'status', ok: gone, msg: gone ? '已关闭会话标签' : '没有关掉，Devin 可能在等你确认，请到电脑上看一下' });
  setTimeout(() => this.pollChat().catch(() => {}), 300);
},


// Editor surface: the open sessions are tabs above the transcript; clicking one switches the transcript.
async switchTab(title) {
  const clicked = await this.cdp.evaluate(helpersCall(`clickDevinTab(${JSON.stringify(String(title))})`));
  if (!clicked) throw new Error('这个会话标签已经关闭了');
  let on = false;
  for (let i = 0; i < 15 && !on; i++) {
    await new Promise(r => setTimeout(r, 100));
    on = (await this.cdp.evaluate(helpersCall('devinSession()')))?.key === title;
  }
  this.resetDevinView();
  this.emit({ t: 'status', ok: on, msg: on ? '已切换会话' : '这个会话还没有切过去，请稍后再试' });
  setTimeout(() => this.pollChat().catch(() => {}), 300);
},


// Switching surface resets what was read from the old transcript, like opening another agent.
resetDevinView() {
  this.lastChat = '';
  this.lastChatAt = 0;
},

async openEditorChat() {
  if (this.app !== 'devin' || await this.cdp.evaluate(helpersCall('devinSurface()')) !== 'editor') throw new Error('请先切换到 Devin Editor');
  await this.key(mod('l'), { cdp: this.editorCdp });
  if (!await this.waitFor('transcriptVisible()')) throw new Error('聊天面板没有打开');
  this.resetDevinView();
  await this.pollChat();
  this.emit({ t: 'status', ok: true, msg: '聊天面板已打开' });
},


// Devin "New": the Agent surface has the New session control. The Editor surface has none
// visible, so it switches to Agent first and stays there (the new session lives in Agent).
async devinNewChat() {
  const surface = await this.cdp.evaluate(helpersCall('devinSurface()'));
  const switched = surface === 'editor';
  if (switched) await this.setSurface('agent');
  await this.pressControl('newChat');
  this.resetDevinView();
  this.lastChatAt = 0;
  await this.pollChat();
  this.emit({ t: 'status', ok: true, msg: switched ? '已切到 Agent 界面并新建对话' : '已新建对话' });
},


// ---- Devin working directory (Agent surface, before the first message) ----
async openWorkdirChip(which) {
  const pos = await this.cdp.evaluate(helpersCall(`workdirTarget(${JSON.stringify(which)})`));
  if (!pos) throw new Error('现在没有可以更换的工作目录');
  await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
  await this.tapCss(pos.x, pos.y);
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 120));
    const rows = await this.cdp.evaluate(helpersCall(which === 'env' ? 'envRows()' : 'workdirRows()'));
    if (rows?.length) return rows;
  }
  return [];
},

async workdirInfoChecked() {
  const info = await this.cdp.evaluate(helpersCall('workdirInfo()'));
  if (!info) throw new Error('这里没有工作目录选项（要在 Agent 界面、新会话里）');
  if (!info.editable) throw new Error('这个会话已经开始了，工作目录只能在新会话发出第一条消息之前更换');
  return info;
},

async workdirList() {
  const info = await this.workdirInfoChecked();
  const rows = await this.openWorkdirChip('folder');
  await this.key('Escape');
  this.emit({ t: 'workdirs', info, rows: rows.filter(r => !r.browse).map(({ name, path }) => ({ name, path })) });
},

async workdirPick(name, dirPath, waitMs = 20000) {
  await this.workdirInfoChecked();
  const rows = await this.openWorkdirChip('folder');
  const hit = rows.find(r => r.name === name && r.path === dirPath) || rows.find(r => r.name === name);
  if (!hit) { await this.key('Escape'); throw new Error('这个文件夹已经不在列表里'); }
  await this.tapCss(hit.x, hit.y);
  // Devin switches the whole workspace: the chip reads "Switching workspace..." and the window reloads the
  // folder, which takes a few seconds (the page is gone for a moment, so evaluations may fail meanwhile).
  this.emit({ t: 'status', ok: true, msg: '正在切换工作区，Devin 会重新载入文件夹…' });
  let info = null;
  for (let i = 0; i < Math.ceil(waitMs / 250); i++) {
    await new Promise(r => setTimeout(r, 250));
    info = await this.cdp.evaluate(helpersCall('workdirInfo()')).catch(() => null);
    if (info?.name === name) break;
  }
  this.lastChat = '';
  this.emit({ t: 'status', ok: info?.name === name, msg: info?.name === name ? `工作目录：${name}` : '没有切换成功，请到电脑上看一下' });
  setTimeout(() => this.pollChat().catch(() => {}), 300);
},

async envPick(label) {
  if (!['Local', 'Worktree', 'Cloud'].includes(label)) throw new Error('不支持的运行位置');
  await this.workdirInfoChecked();
  const rows = await this.openWorkdirChip('env');
  const hit = rows.find(r => r.label === label);
  if (!hit) { await this.key('Escape'); throw new Error('没找到这个选项'); }
  await this.tapCss(hit.x, hit.y);
  await new Promise(r => setTimeout(r, 500));
  this.emit({ t: 'status', ok: true, msg: `运行位置：${label}` });
  setTimeout(() => this.pollChat().catch(() => {}), 300);
},


// ---- Devin "@" mentions: drive Devin's own typeahead so the result is a real chip ----
// Waits until the listbox stops changing (it loads asynchronously) and returns its rows.
async mentionSettle() {
  let last = '', same = 0, rows = null;
  for (let i = 0; i < 18; i++) {
    await new Promise(r => setTimeout(r, 150));
    rows = await this.cdp.evaluate(helpersCall('mentionRows()'));
    const sig = JSON.stringify((rows || []).map(r => [r.label, r.sub]));
    same = sig === last ? same + 1 : 0;
    last = sig;
    if (rows?.length && same >= 1 && i >= 2) break;
  }
  return rows || [];
},


// Remove what was typed for a query (Escape closes the menu, Backspace removes the text) and check that the
// prompt looks like it did before; if it does not and it was empty, clear it.
async mentionUndo(typed, before) {
  await this.key('Escape');
  await new Promise(r => setTimeout(r, 150));
  for (let i = 0; i < typed; i++) await this.key('Backspace');
  await new Promise(r => setTimeout(r, 250));
  const now = await this.cdp.evaluate(helpersCall('composerState()'));
  if (now !== before && !before) {
    await this.key(mod('A'));
    await this.key('Backspace');
  }
},

async withMentionLock(seq, fn) {
  const deadline = Date.now() + 20000;
  while (this.mentionBusy) {
    if (Date.now() > deadline) return null;
    await new Promise(r => setTimeout(r, 80));
    if (seq != null && this.mentionSeq !== seq) return null;
  }
  this.mentionBusy = true;
  try { return await fn(); } finally { this.mentionBusy = false; }
},


// Type "@q" and click the option with this label (and folder) so Devin turns it into a chip. False = not found.
async insertMention(m) {
  return this.withMentionLock(null, async () => {
    const before = await this.cdp.evaluate(helpersCall('composerState()'));
    await this.cdp.send('Input.insertText', { text: '@' });
    await new Promise(r => setTimeout(r, 450));
    if (m.q) await this.cdp.send('Input.insertText', { text: m.q });
    const rows = await this.mentionSettle();
    const hit = rows.find(r => r.label === m.label && r.sub === (m.sub || '')) || rows.find(r => r.label === m.label);
    if (!hit) { await this.mentionUndo(1 + (m.q || '').length, before); return false; }
    await this.tapCss(hit.x, hit.y);
    await new Promise(r => setTimeout(r, 400));
    return true;
  });
},


// Devin's transcript carries no end-of-turn timestamp, so the relay stamps it: the page reports
// devinTurnStart (the last user message's time); while busy the turn is open-ended, and the first
// idle poll after a busy one records the end. A turn that finished before the relay ever saw it
// busy (e.g. across a relay restart) gets no generation — the phone would otherwise tick forever.
devinGeneration(chat) {
  const start = chat.devinTurnStart;
  delete chat.devinTurnStart;
  if (!Number.isFinite(start)) return;
  const key = `${chat.thread}|${start}`;
  if (!devinTurnEnds.has(key) && devinTurnEnds.size >= 200) devinTurnEnds.delete(devinTurnEnds.keys().next().value);
  if (chat.busy) {
    if (!devinTurnEnds.has(key)) devinTurnEnds.set(key, null);
    chat.generation = { start, end: null };
    return;
  }
  const seen = devinTurnEnds.get(key);
  if (seen === undefined) return;
  if (seen === null) devinTurnEnds.set(key, Date.now());
  chat.generation = { start, end: devinTurnEnds.get(key) };
},

// Text with @tokens: type the text, and at every token let Devin's typeahead insert the real chip.
async typeWithMentions(text, mentions) {
  let rest = text;
  for (const m of mentions) {
    const at = rest.indexOf(m.token);
    if (at < 0) continue;
    if (at > 0) await this.typeText(rest.slice(0, at));
    rest = rest.slice(at + m.token.length);
    if (await this.insertMention(m)) rest = rest.replace(/^ /, '');
    else await this.typeText(m.token);
  }
  if (rest) await this.typeText(rest);
}
};
