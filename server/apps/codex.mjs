import { Cdp } from '../cdp.mjs';
import { windowRoots } from '../../lib/files.mjs';
import { agentMarks } from '../../lib/marks.mjs';
import { mod } from '../../lib/platform.mjs';
import { codexWindows, codexContext } from '../windows.mjs';
import { CODEX_CDP_URL } from '../config.mjs';
import { helpersCall } from '../page/build.mjs';
import { FOCUS_COMPOSER, codexUsage } from '../agent/context.mjs';
import { computerId, saveState } from '../../lib/auth.mjs';
import { conversationProjects, fusionProject } from '../fusion/state.mjs';

export const adapter = {
  async newChat() {
    return this.newCodexChat();
  },

  async openAgent(id, title = '') {
    await this.openCodexAgent(id);
  },

  async listAgents(silent, readOnly, emit) {
    const pages = await codexWindows(CODEX_CDP_URL);
    const list = [];
    const seen = new Set();
    const states = await Promise.all(pages.map(p => this.probeCodex(p)));
    for (const p of pages) {
      const group = p.title;
      if (p.chatWs) {
        list.push({ id: `new:${p.pageId}`, title: '＋ 新建会话', window: group, group: '', current: false, running: false, ui: true });
        const cdp = p.pageId === this.codexPageId ? this.cdp : new Cdp(p.chatWs);
        let rows = [];
        try {
          if (cdp !== this.cdp) await cdp.connect();
          rows = readOnly ? await cdp.evaluate(helpersCall('codexChatRows(true)')) : await this.codexThreadRows(cdp);
        } finally { if (cdp !== this.cdp) cdp.close(); }
        this.rememberCodexRoots(rows);
        const folderOf = ws => {
          const parts = String(ws || '').split(/[/\\]/).filter(Boolean);
          return parts.at(-1) || '';
        };
        for (const row of rows) {
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          const owner = pages.find((page, i) => states[i]?.roots?.includes(row.workspace)) || p;
          const state = states[pages.indexOf(owner)];
          const folder = folderOf(row.workspace);
          list.push({
            id: `thread:${owner.pageId}:${row.id}`,
            title: row.title,
            lastUsed: row.lastUsed,
            window: folder || owner.title,
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
    emit({ list });
  },

  async currentRoots() {
    const prefer = this.codexRoots?.get(this.threadId) || '';
    const pages = await codexWindows(CODEX_CDP_URL);
    const page = pages.find(p => p.pageId === this.codexPageId);
    return windowRoots(page?.rawTitle || page?.title || '', 'code', prefer).filter(w => !w.host);
  },

  async queueAction(id, action) {
    if (!await this.cdp.evaluate(helpersCall(`codexQueueAction(${JSON.stringify(String(id))}, ${JSON.stringify(action)})`))) throw new Error('Codex 排队消息或操作入口已不存在');
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  },

  async editQueued(id, text) {
    await this.codexFocusPrompt();
    await this.cdp.evaluate(helpersCall('codexSelectPrompt()'));
    await this.cdp.send('Input.insertText', { text });
    if (!await this.cdp.evaluate(helpersCall('submitCodexMessage()'))) throw new Error('Codex 保存排队消息的按钮不可用');
    setTimeout(() => this.pollChat().catch(() => {}), 300);
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
    await this.key('Ctrl+Shift+`', { cdp: this.editorCdp });
  },

  async mentionQuery(q, cat, seq, trigger) {
    return this.codexMentionQuery(q, trigger === '/' ? '/' : '@', seq);
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

  async submitPrompt(now, busy, when, queued) {
    const view = (await this.cdp.evaluate(helpersCall('codexFacts()')))?.view;
    const follow = view?.follow || 'queue';
    queued = !!busy && (when === 'queue' || (!when && follow === 'queue'));
    const opposite = !!busy && ((when === 'now' && follow !== 'steer') || (when === 'queue' && follow === 'steer'));
    if (opposite) {
      await this.cdp.evaluate(FOCUS_COMPOSER);
      await this.key(mod((view?.enter === 'enter' ? '' : 'Shift+') + 'Enter'));
    }
    else if (!await this.cdp.evaluate(helpersCall('submitCodexMessage()'))) throw new Error('Codex 发送按钮当前不可用');
    for (let i = 0; i < 12 && await this.cdp.evaluate(helpersCall('codexPromptText()')); i++) await new Promise(r => setTimeout(r, 100));
    if (await this.cdp.evaluate(helpersCall('codexPromptText()'))) throw new Error('Codex 未接受发送，草稿已保留');
    if (busy && !queued) this.emit({ t: 'status', ok: true, msg: '已追加到当前任务' });
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
    await new Promise(r => setTimeout(r, 150));
    await this.closeMenus();
    this.emit({ t: 'status', ok: true, msg: `已切换到 ${label}` });
    this.pollChat().catch(() => {});
    await this.openMenu('effort').catch(() => {});
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
    this.thinking = new Map();
    this.thinkingTried = new Map();
    this.keptThink = new Map();
    this.thinkLiveSeen = new Set();
    this.thinkFinal = new Set();
  }
  if (thread) this.threadId = thread;
  if (!this.itemCache) this.itemCache = new Map();
  const prev = this.itemCache.get(thread) || [];
  chat.items = [...new Map([...prev, ...chat.items].map(it => [it.i, it])).values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).slice(-400);
  chat.earlier = Math.min(...chat.items.map(it => Math.floor((it.order ?? Infinity) / 10000))) > 1;
  if (!chat.busy) chat.items.filter(it => it.k === 'thinking').forEach(it => { it.live = false; });
  if (!chat.busy) chat.items.filter(it => it.k === 'tool' && !it.keep).forEach(it => { it.done = true; });
  this.itemCache.set(thread, chat.items);
},

async selectCodexThread(convId, cdp = this.cdp) {
  const waitActive = async () => {
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 150));
      const actual = await cdp.evaluate(helpersCall('codexThread()')) || '';
      if (actual === convId) return true;
    }
    return false;
  };
  if (await cdp.evaluate(helpersCall(`openCodexThread(${JSON.stringify(convId)})`)) && await waitActive()) return true;
  const pos = await cdp.evaluate(helpersCall('codexRecentPoint()'));
  if (!pos) return false;
  await this.tapCss(pos.x, pos.y, 'left', cdp);
  let point = null;
  for (let i = 0; i < 8 && !point; i++) {
    await new Promise(r => setTimeout(r, 120));
    point = await cdp.evaluate(helpersCall(`codexChatPoint(${JSON.stringify(convId)})`));
  }
  if (!point) {
    await cdp.evaluate(helpersCall('closeCodexMenu()'));
    return false;
  }
  await this.tapCss(point.x, point.y, 'left', cdp);
  if (await waitActive()) return true;
  await cdp.evaluate(helpersCall('closeCodexMenu()'));
  return false;
},

async adoptCodexThread(thread, statusMsg) {
  this.clearViewState();
  this.threadId = thread || '';
  this.publishThread(statusMsg);
  await this.pollChat();
},

async newCodexChat() {
  if (!this.cdp) throw new Error('还没有连上 Codex');
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

async openCodexAgent(id) {
  if (id.startsWith('win:')) {
    await this.attach({ id: 'codex', windowId: id.slice(4), threadId: '' });
    this.emit({ t: 'status', ok: true, msg: '已切换窗口' });
    return;
  }
  if (id.startsWith('new:')) {
    const pageId = id.slice(4);
    if (pageId && pageId !== this.codexPageId) await this.attach({ id: 'codex', windowId: pageId, threadId: '' });
    await this.newCodexChat();
    return;
  }
  const match = /^thread:([^:]+):(.+)$/.exec(id || '');
  if (!match) throw new Error('这条会话已经不在列表里');
  const pageId = match[1], convId = match[2];
  this.clearViewState();
  this.switchingThread = true;
  const switchedWindow = pageId !== this.codexPageId;
  try {
    if (switchedWindow) await this.attach({ id: 'codex', windowId: pageId, threadId: convId });
    if (!this.cdp) throw new Error('还没有连上 Codex');
    const current = await this.cdp.evaluate(helpersCall('codexThread()')) || '';
    if (current !== convId && (switchedWindow || !await this.selectCodexThread(convId))) throw new Error('没有找到这个会话');
    this.emit({ t: 'status', ok: true, msg: !switchedWindow && current === convId ? '已是当前会话' : '已切换会话' });
  } finally {
    this.switchingThread = false;
    if (this.cdp) {
      this.threadId = await this.cdp.evaluate(helpersCall('codexThread()')) || '';
      this.publishThread();
      this.lastChatAt = 0;
      await this.pollChat();
    }
  }
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
  return matches.find(m => m.active)?.page || matches.find(m => m.inWorkspace)?.page || null;
},

async probeCodex(page) {
  if (!page?.chatWs && page?.pageId !== this.codexPageId) return null;
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
  return [...new Map([...rows, ...recent].map(row => [row.id, row])).values()];
},

async withCodexSettings(fn) {
  const editor = this.editorCdp, sidebar = this.cdp;
  const before = await editor.evaluate(`(() => { const t = [...document.querySelectorAll('.tab')].find(e => /^Codex Settings(?:,|$)/.test(e.getAttribute('aria-label') || '')); return !!t; })()`);
  let key = '';
  const settingsKey = () => editor.evaluate(`(() => { if (![...document.querySelectorAll('.tab.active')].some(e => /^Codex Settings(?:,|$)/.test(e.getAttribute('aria-label') || ''))) return ''; const el = [...document.querySelectorAll('iframe[src*="extensionId=openai.chatgpt"]')].find(e => !e.src.includes('purpose=webviewView') && e.getBoundingClientRect().height > 0); return el ? new URL(el.src).searchParams.get('id') : ''; })()`);
  key = await settingsKey();
  if (!key) {
    const account = await sidebar.evaluate(helpersCall('codexAccountPoint()'));
    if (!account) throw new Error('没有找到 Codex 设置菜单');
    await this.tapCss(account.x, account.y, 'left', sidebar);
    let pos;
    for (let i = 0; i < 10 && !pos; i++) {
      await new Promise(r => setTimeout(r, 100));
      pos = await sidebar.evaluate(helpersCall("codexMenuPoint('Codex settings')"));
    }
    if (!pos) throw new Error('Codex 菜单没有设置入口');
    await this.tapCss(pos.x, pos.y, 'left', sidebar);
    for (let i = 0; i < 30 && !key; i++) { await new Promise(r => setTimeout(r, 100)); key = await settingsKey(); }
    if (!key) throw new Error('Codex 设置页面尚未打开');
  }
  const targets = await (await fetch(`${CODEX_CDP_URL}/json/list`)).json();
  const target = targets.find(t => /extensionId=openai.chatgpt/.test(t.url || '') && new URL(t.url).searchParams.get('id') === key);
  if (!target) throw new Error('Codex 设置页面尚未连接');
  if (!before) this.codexSettingsOwned = { editorWs: editor.wsUrl, key };
  this.codexSettingsViewWs = target.webSocketDebuggerUrl;
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.connect();
  try { return await fn(cdp); } finally { cdp.close(); }
},

async showCodexSettings(id = '', requestId = 0) {
  const sel = this.sel;
  const data = await this.withCodexSettings(async cdp => {
    if (id) {
      const pos = await cdp.evaluate(helpersCall(`codexSettingPoint(${JSON.stringify(id)})`));
      if (!pos) throw new Error('设置选项已改变，请重新打开设置');
      await this.tapCss(pos.x, pos.y, 'left', cdp);
      await new Promise(r => setTimeout(r, 200));
    }
    let data;
    for (let i = 0; i < 20; i++) {
      data = await cdp.evaluate(helpersCall('codexSettingsData()'));
      if (data.nav.length) break;
      await new Promise(r => setTimeout(r, 100));
    }
    if (!data.nav.length) throw new Error('Codex 设置内容尚未加载');
    return data;
  });
  if (this.sel === sel && this.app === 'codex') this.emit({ t: 'settings', codex: true, requestId, ...data });
},

async closeCodexSettings() {
  const view = this.codexSettingsViewWs;
  this.codexSettingsViewWs = '';
  if (view) {
    const menu = new Cdp(view);
    await menu.connect();
    try { await this.key('Escape', { cdp: menu }); } finally { menu.close(); }
  }
  const owned = this.codexSettingsOwned;
  this.codexSettingsOwned = null;
  if (!owned) return;
  const cdp = new Cdp(owned.editorWs);
  await cdp.connect();
  try {
    const pos = await cdp.evaluate(`(() => { const el = [...document.querySelectorAll('iframe[src*="extensionId=openai.chatgpt"]')].find(e => new URL(e.src).searchParams.get('id') === ${JSON.stringify(owned.key)}); if (!el) return null; const tab = [...document.querySelectorAll('.tab')].find(e => /^Codex Settings(?:,|$)/.test(e.getAttribute('aria-label') || '')); const b = tab?.querySelector('.codicon-close'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (pos) await this.tapCss(pos.x, pos.y, 'left', cdp);
  } finally { cdp.close(); }
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

async codexMentionSettle() {
  let last = '', rows = [];
  for (let i = 0; i < 16; i++) {
    await new Promise(r => setTimeout(r, 140));
    rows = await this.cdp.evaluate(helpersCall('codexMentionRows()')) || [];
    const sig = JSON.stringify(rows.map(r => [r.section, r.key, r.label]));
    if (rows.length && sig === last && i >= 2) break;
    last = sig;
  }
  return rows;
},

mentionPayload(rows) {
  return rows.slice(0, 40).map(r => ({ label: r.label, sub: r.sub || '', key: r.key || '', section: r.section || '' }));
},

async codexMentionQuery(q, trigger, seq) {
  this.mentionSeq = seq;
  const out = await this.withMentionLock(seq, async () => {
    if (this.mentionSeq !== seq) return null;
    await this.codexFocusPrompt();
    const before = await this.codexPrompt();
    const typed = trigger + String(q || '');
    await this.cdp.send('Input.insertText', { text: typed });
    const rows = await this.codexMentionSettle();
    await this.codexRestorePrompt(before);
    let after = await this.codexPrompt();
    if (after !== before && !before) {
      await this.cdp.evaluate(helpersCall('codexSelectPrompt()'));
      await this.key('Backspace');
      after = await this.codexPrompt();
    }
    if (after !== before) throw new Error('查询菜单后没能恢复原来的输入');
    return rows;
  }).catch(e => { this.emit({ t: 'status', ok: false, msg: e.message }); return null; });
  if (out && this.mentionSeq === seq) this.emit({ t: 'mentions', seq, q, trigger, rows: this.mentionPayload(out) });
},

async codexOpenMention(trigger, q) {
  await this.codexFocusPrompt();
  await this.cdp.send('Input.insertText', { text: trigger + String(q || '') });
  return this.codexMentionSettle();
},

async codexPick(msg) {
  if (this.app !== 'codex') return;
  const before = await this.withMentionLock(null, async () => {
    await this.codexFocusPrompt();
    return this.codexPrompt();
  });
  const trigger = msg.section === 'commands' || msg.section === 'Skills' ? '/' : '@';
  const parentQ = String(msg.parentQ || msg.q || '').slice(0, 60);
  try {
    let rows = await this.codexOpenMention(trigger, parentQ);
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
      setTimeout(() => this.pollChat().catch(() => {}), 300);
      return;
    }
    const next = await this.cdp.evaluate(helpersCall('codexMentionRows()')) || [];
    const branched = next.length && !next.some(r => r.key === hit.key && r.label === hit.label);
    if (branched) {
      await this.codexRestorePrompt(before);
      this.emit({
        t: 'mentions', seq: Number(msg.seq) || 0, submenu: true, q: '',
        parent: { key: hit.key, label: hit.label, q: parentQ, section: hit.section || msg.section || '' },
        rows: this.mentionPayload(next),
      });
      return;
    }
    await this.codexRestorePrompt(before);
    const after = await this.codexPrompt();
    if (after !== before && !before) await this.codexRestorePrompt('');
    this.emit({ t: 'status', ok: true, msg: `已执行 ${hit.label.split('\n')[0]}` });
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  } catch (e) {
    await this.codexRestorePrompt(before).catch(() => {});
    throw e;
  }
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
  const pos = await this.cdp.evaluate(helpersCall(`codexButtonPoint('run')`));
  if (!pos) throw new Error('当前没有执行位置菜单');
  await this.tapCss(pos.x, pos.y);
  let items = [];
  for (let i = 0; i < 10 && !items.length; i++) {
    await new Promise(r => setTimeout(r, 120));
    items = await this.cdp.evaluate(helpersCall('codexRunItems()')) || [];
  }
  await this.closeMenus();
  this.emit({ t: 'menu', kind: 'codex-run', items: items.filter(it => /^(Local|Cloud|Worktree|Connect Codex web)\b/.test(it.label)).map(it => ({ label: it.label, checked: false })) });
},

async codexRunPick(label) {
  const pos = await this.cdp.evaluate(helpersCall(`codexButtonPoint('run')`));
  if (!pos) throw new Error('当前没有执行位置菜单');
  await this.tapCss(pos.x, pos.y);
  let hit = null;
  for (let i = 0; i < 10 && !hit; i++) {
    await new Promise(r => setTimeout(r, 120));
    const items = await this.cdp.evaluate(helpersCall('codexRunItems()')) || [];
    hit = items.find(it => it.label === label);
  }
  if (!hit) { await this.closeMenus(); throw new Error(`没找到执行位置：${label}`); }
  await this.tapCss(hit.x, hit.y);
  await new Promise(r => setTimeout(r, 300));
  const run = (await this.cdp.evaluate(helpersCall('codexFacts()')))?.view?.run || '';
  this.emit({ t: 'status', ok: true, msg: run ? `执行位置：${run}` : `已选择 ${label}` });
  setTimeout(() => this.pollChat().catch(() => {}), 300);
},

async codexChatMenu() {
  const pos = await this.cdp.evaluate(helpersCall(`codexButtonPoint('actions')`));
  if (!pos) throw new Error('当前会话没有 Chat actions');
  await this.tapCss(pos.x, pos.y);
  let items = [];
  for (let i = 0; i < 10 && !items.length; i++) {
    await new Promise(r => setTimeout(r, 120));
    items = await this.cdp.evaluate(helpersCall('codexRunItems()')) || [];
  }
  await this.closeMenus();
  this.emit({ t: 'menu', kind: 'codex-chat', items: items.map(it => ({ label: it.label, checked: false })) });
},

async codexChatPick(label, name) {
  const pos = await this.cdp.evaluate(helpersCall(`codexButtonPoint('actions')`));
  if (!pos) throw new Error('当前会话没有 Chat actions');
  await this.tapCss(pos.x, pos.y);
  let hit = null;
  for (let i = 0; i < 10 && !hit; i++) {
    await new Promise(r => setTimeout(r, 120));
    const items = await this.cdp.evaluate(helpersCall('codexRunItems()')) || [];
    hit = items.find(it => it.label === label);
  }
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
  if (now && now !== thread) this.emit({ t: 'thread', threadId: now, windowId: this.windowId });
  setTimeout(() => this.pollChat().catch(() => {}), 300);
  setTimeout(() => this.listAgents().catch(() => {}), 400);
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
    await this.tapCss(pos.x, pos.y, 'left', cdp);
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
    await new Promise(r => setTimeout(r, 400));
    const confirm = await cdp.evaluate(helpersCall('codexArchiveConfirm()'));
    if (confirm?.x) await this.tapCss(confirm.x, confirm.y, 'left', cdp);
    await new Promise(r => setTimeout(r, 400));
    await cdp.evaluate(helpersCall('closeCodexMenu()'));
    const rows = await this.codexThreadRows(cdp);
    if (rows.some(row => row.id === convId)) throw new Error('操作没有成功，会话还在列表里');
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
