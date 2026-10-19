import { windowRoots } from '../../lib/files.mjs';
import { mod } from '../../lib/platform.mjs';
import { helpersCall, PAGE_SRC } from '../page/build.mjs';
import { cursorUsage } from '../agent/context.mjs';

export const adapter = {
  async newChat() {
    const before = await this.cdp.evaluate(helpersCall('activeThread()'));
    await this.pressControl('newChat');
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 150));
      const chat = await this.cdp.evaluate(helpersCall('extract()'));
      if (!chat || (chat.thread === before && chat.items.length)) continue;
      this.clearViewState();
      this.threadId = chat.thread || '';
      this.publishThread('已新建对话');
      this.lastChatAt = 0;
      await this.pollChat();
      return;
    }
    throw new Error('新建对话没有生效');
  },

  // A freshly launched Cursor lands on the Agents home; open the most recent session.
  // agentList order is the sidebar's native order (Cursor lists most recent first).
  async openDefaultSession() {
    const st = await this.cdp.evaluate(`(() => {
      const h = ${PAGE_SRC};
      return { thread: h.activeThread(), panel: !!h.panelRect(), items: (h.extract() || {}).items?.length || 0 };
    })()`);
    if (st.panel && st.thread && st.items) return;
    const pickNewest = async () => {
      // A cold window can take a while to mount the agent list.
      let rows = [];
      for (let i = 0; i < 48 && !rows.length; i++) {
        rows = await this.cdp.evaluate(`(() => { const h = ${PAGE_SRC}; return h.agentList(); })()`) || [];
        if (!rows.length) await new Promise(r => setTimeout(r, 250));
      }
      return rows.find(r => r.id && !String(r.id).startsWith('new:')) || null;
    };
    const best = await pickNewest();
    if (!best) throw new Error('没有找到最近的会话');
    await this.adapter.openAgent.call(this, best.id);
  },

  async openAgent(id, title = '') {
    if (!id || id.length > 200) throw new Error('这条 Agent 已经不在列表里');
    this.clearViewState();
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
    const list = await this.cdp.evaluate(helpersCall('agentList()'));
    emit({ list: list || [] });
  },

  async currentRoots() {
    if (this.winTitle === 'Cursor Agents') {
      const workspace = await this.cdp.evaluate(helpersCall('cursorWorkspace()'));
      return workspace && !workspace.host ? [workspace] : [];
    }
    return windowRoots(this.winTitle || '', 'cursor', '').filter(w => !w.host);
  },

  async queueAction(id, action) {
    const call = a => this.cdp.evaluate(helpersCall(`queueTarget(${JSON.stringify(String(id))}${a ? `, ${JSON.stringify(a)}` : ''})`));
    const row = await call();
    if (!row) throw new Error('这条排队消息已经不在了（可能刚被发出）');
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y });
    let pos = null;
    for (let i = 0; i < 6 && !pos; i++) {
      await new Promise(r => setTimeout(r, 80));
      pos = await call(action);
    }
    if (!pos) throw new Error(this.appMessage('没找到排队消息的操作按钮（可能 {app} 版本不同）'));
    if (pos !== true) await this.tapCss(pos.x, pos.y);
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  },

  async editQueued(id, text) {
    const focus = () => this.cdp.evaluate(helpersCall(`focusQueueEdit(${JSON.stringify(String(id))})`));
    let ok = false;
    for (let i = 0; i < 10 && !ok; i++) {
      await new Promise(r => setTimeout(r, 100));
      ok = await focus();
    }
    if (!ok) throw new Error(this.appMessage('{app} 没有进入编辑状态，没改动'));
    await this.key(mod('A'));
    await this.typeText(text);
    await this.key('Enter');
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  },

  async changeAction(i, name, act) {
    if (!['keep', 'undo', 'bar'].includes(act)) throw new Error('不支持的操作');
    await this.withFiles(async s => {
      if (this.app === 'devin' && s.count && !s.files.length) throw new Error('这个界面看不到逐个文件的改动，请先切到 Agent 界面');
      const call = a => helpersCall(`fileTarget(${Number(i) || 0}, ${JSON.stringify(String(name))}, ${JSON.stringify(a)})`);
      if (act !== 'bar') {
        const row = await this.cdp.evaluate(call('row'));
        if (!row) throw new Error('文件列表已经变了，请重新打开');
        await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y });
        await new Promise(r => setTimeout(r, 120));
      }
      const pos = await this.cdp.evaluate(call(act));
      if (!pos) throw new Error(this.appMessage('没找到这个按钮（可能 {app} 版本不同）'));
      await this.tapCss(pos.x, pos.y);
      await new Promise(r => setTimeout(r, 400));
    }, { act: act !== 'bar' });
    await this.listChanges();
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  },

  async listChanges() {
    const s = await this.withFiles(async s => s);
    this.emit({ t: 'changes', ...s, ...(this.app === 'devin' ? { devin: true } : {}) });
  },

  async mentionQuery(q, cat, seq, trigger) {
  },

  async withFiles(fn, opts) {
    return this.withCursorFiles(fn);
  },

  async newTerminal() {
    await this.key('Ctrl+Shift+`', { cdp: this.editorCdp });
  },

  async usageContext() {
    return this.cdp.evaluate(helpersCall('contextPct()'));
  },

  async accountUsage(request, automatic) {
    return this.readCursorUsage(automatic);
  },

  async typeDraft(text, mentions) {
    await this.typeText(text);
  },

  async submitPrompt(now, busy, when, queued) {
    await this.key(now ? mod('Enter') : 'Enter');
    return queued;
  },

  async fileAgentMarks(f, text, changes, diff) {
    return null;
  },

  async pickModelMenu(label) {
    return false;
  },

  async showSettings(requestId = 0, section = '') {
    if (this.desktopSettingsOwned === undefined) this.desktopSettingsOwned = !await this.editorCdp.evaluate(helpersCall('settingsOpen()'));
    await this.ensureSettings();
    const data = await this.editorCdp.evaluate(`(async () => {
      const h = ${PAGE_SRC}, app = ${JSON.stringify(this.app)}, section = ${JSON.stringify(section)};
      if (section) h.desktopSettingsNav(section, app);
      const start = Date.now();
      do {
        const data = h.desktopSettingsData(section, app);
        if (data.sections.length && (!section || data.current === section)) return data;
        await new Promise(r => setTimeout(r,30));
      } while (Date.now() - start < 1200);
      return h.desktopSettingsData(section, app);
    })()`);
    this.desktopSettingsSection = data.current;
    this.emit({ t: 'settings', ...data });
  },
};

export const methods = {
async withCursorFiles(fn) {
  const state = () => this.cdp.evaluate(helpersCall('filesState()'));
  let s = await state();
  const opened = !s.open;
  if (opened) {
    const t = await this.cdp.evaluate(helpersCall('fileTarget(0, "", "toggle")'));
    if (!t) return fn(s);
    await this.tapCss(t.x, t.y);
    for (let i = 0; i < 8 && !s.open; i++) {
      await new Promise(r => setTimeout(r, 120));
      s = await state();
    }
  }
  try {
    return await fn(s);
  } finally {
    const t = opened && await this.cdp.evaluate(helpersCall('fileTarget(0, "", "toggle")'));
    if (t && (await state()).open) await this.tapCss(t.x, t.y);
  }
},

async readCursorUsage(automatic = false) {
  const cdp = this.cdp, editorCdp = this.editorCdp;
  if (automatic) {
    const usage = await cdp.evaluate(helpersCall('readUsage()'));
    if (usage?.limits?.length && !usage.loading && !usage.missing) {
      cursorUsage.data = { ...usage, updated: Date.now() };
      return cursorUsage.data;
    }
    if (cursorUsage.data) return { ...cursorUsage.data, cached: true };
    if (!cursorUsage.initial) cursorUsage.initial = this.withFocus(() => this.readCursorUsage(false))
      .finally(() => { cursorUsage.initial = null; });
    return cursorUsage.initial;
  }
  const wasOpen = await cdp.evaluate(helpersCall('settingsOpen()'));
  await this.ensureSettings(editorCdp);
  try {
    const nav = await cdp.evaluate(helpersCall('usageNavTarget()'));
    if (!nav) return { missing: true, quota: [], limits: [] };
    await this.tapCss(nav.x, nav.y, 'left', cdp);
    let usage = null;
    for (let i = 0; i < 160; i++) {
      await new Promise(r => setTimeout(r, 250));
      usage = await cdp.evaluate(helpersCall('readUsage()'));
      if (usage?.limits?.length && !usage.loading && !usage.missing) break;
    }
    if (usage?.limits?.length && !usage.missing) {
      cursorUsage.data = { ...usage, updated: Date.now() };
      return cursorUsage.data;
    }
    if (usage?.loading) throw new Error('额度还在加载');
    return usage || { missing: true, quota: [], limits: [] };
  } finally { if (!wasOpen) await this.closeSettings(editorCdp); }
},

async toggleMax() {
  await this.pressControl('model');
  const t = await this.waitFor('maxToggle()');
  if (!t) { await this.closeMenus(); throw new Error('这个 Cursor 版本没有 MAX Mode 开关'); }
  await this.tapCss(t.x, t.y);
  await new Promise(r => setTimeout(r, 250));
  await this.closeMenus();
  await this.pollChat(true);
  this.emit({ t: 'status', ok: true, msg: '设置已更新' });
},

queueFusionRead() {
  if (this.fusionLoading || this.fusionMiss) return;
  this.fusionLoading = true;
  this.readFusion(true).then(cfg => {
    if (cfg) { this.fusion = cfg; this.fusionMiss = false; this.lastChat = ''; }
    else this.fusionMiss = true;
  }).catch(() => { this.fusionMiss = true; }).finally(() => { this.fusionLoading = false; });
},


// Reuses the panel if the model menu is already open (pressing the button again would close it),
// and expands the model list like openMenu does when the panel does not show up on its own.
async openFusionPanel() {
  let fusion = await this.cdp.evaluate(helpersCall('fusionConfig()'));
  if (fusion) return fusion;
  await this.pressControl('model');
  for (let i = 0; i < 14 && !fusion; i++) {
    await new Promise(r => setTimeout(r, 150));
    fusion = await this.cdp.evaluate(helpersCall('fusionConfig()'));
    if (fusion) break;
    // The panel opens while the mouse hovers the Fusion row. Clicking that row would pick it and close the menu.
    const row = await this.cdp.evaluate(helpersCall(`menuItem('model', 'Fusion')`));
    if (row) { await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y }); continue; }
    if (i < 4) continue;
    const opened = await this.cdp.evaluate(helpersCall('clickModelListTrigger()'));
    if (opened) continue;
    const sub = await this.cdp.evaluate(helpersCall('modelListTrigger()'));
    if (sub) await this.tapCss(sub.x, sub.y);
  }
  return fusion;
},

async idleFusionRead() {
  for (let i = 0; i < 40 && this.fusionLoading; i++) await new Promise(r => setTimeout(r, 100));
},

async readFusion(open) {
  let cfg = await this.cdp.evaluate(helpersCall('fusionConfig()'));
  if (cfg || !open) return cfg;
  cfg = await this.openFusionPanel();
  await this.closeMenus();
  return cfg;
},

async fusionOptions(part) {
  if (!['lead', 'effort', 'sidekick'].includes(part)) throw new Error('没有这个 Fusion 选项');
  const native = await this.cdp.evaluate(`(() => { const h = ${PAGE_SRC}; if (!h.fusionConfig()?.lead) return null; return h.devinVariants(${JSON.stringify(part)}, true).map(({ label, checked, pricing }) => ({ label, checked, pricing })); })()`);
  if (native?.length) {
    this.emit({ t: 'menu', kind: `fusion-${part}`, items: native, fusion: await this.cdp.evaluate(helpersCall('fusionConfig(true)')) });
    return;
  }
  await this.idleFusionRead();
  const fusion = await this.openFusionPanel();
  if (!fusion) { await this.closeMenus(); throw new Error('先把模型切换到 Fusion'); }
  const opened = await this.cdp.evaluate(helpersCall(`clickFusionCombo(${JSON.stringify(part)})`));
  if (!opened) { await this.closeMenus(); throw new Error('Fusion 的这项没有打开'); }
  let items = [];
  for (let i = 0; i < 8 && !items.length; i++) {
    await new Promise(r => setTimeout(r, 120));
    items = await this.cdp.evaluate(helpersCall('fusionOptionItems()')) || [];
  }
  const current = fusion[part];
  items = items.map(it => ({ ...it, checked: it.label === current }));
  await this.closeMenus();
  if (!items.length) throw new Error('没有读到可切换的模型');
  this.emit({ t: 'menu', kind: `fusion-${part}`, items, fusion });
},

async fusionPick(part, value) {
  const previousFast = part === 'fast' ? await this.cdp.evaluate(helpersCall('fusionConfig()?.fast')) : null;
  const picked = await this.cdp.evaluate(`(() => { const h = ${PAGE_SRC}; if (!h.fusionConfig()) return false; const rows = h.devinVariants(${JSON.stringify(part)}); const row = rows.find(x => ${part === 'fast' ? '!x.checked' : `x.label === ${JSON.stringify(String(value))}`}); if (!row) return false; h.devinPickerProps().onModelSelect(row.config); return true; })()`);
  if (picked) {
    if (part === 'fast') return this.syncFast(!previousFast);
    const role = part === 'lead' || part === 'sidekick';
    if (role) await this.waitFor(`fusionConfig()?.[${JSON.stringify(part)}] === ${JSON.stringify(String(value))}`);
    else await this.pollChat();
    await this.openMenu('model');
    if (role) {
      this.lastChatAt = 0;
      this.pollChat().catch(() => {});
    }
    return;
  }
  await this.idleFusionRead();
  const ready = await this.openFusionPanel();
  if (!ready) { await this.closeMenus(); throw new Error('先把模型切换到 Fusion'); }
  if (part === 'fast') {
    const ok = await this.cdp.evaluate(helpersCall('clickFusionFast()'));
    if (!ok) throw new Error('没有找到 Fast Mode');
    try { await this.syncFast(!ready.fast); }
    finally { await this.closeMenus(); }
    return;
  } else {
    if (!['lead', 'effort', 'sidekick'].includes(part)) throw new Error('没有这个 Fusion 选项');
    const opened = await this.cdp.evaluate(helpersCall(`clickFusionCombo(${JSON.stringify(part)})`));
    if (!opened) throw new Error('Fusion 的这项没有打开');
    const pos = await this.waitFor(`fusionOptionTarget(${JSON.stringify(String(value))})`);
    if (!pos) { await this.closeMenus(); throw new Error(`没找到选项：${value}`); }
    await this.tapCss(pos.x, pos.y);
  }
  await new Promise(r => setTimeout(r, 250));
  const fusion = await this.waitFor('fusionConfig()') || ready;
  this.fusion = fusion;
  this.fusionMiss = false;
  this.lastChat = '';
  await this.closeMenus();
  this.emit({ t: 'status', ok: true, msg: part === 'fast' ? `Fast Mode 已${fusion.fast ? '打开' : '关闭'}` : `已切换到 ${value}` });
  await this.openMenu('model');
  setTimeout(() => this.pollChat().catch(() => {}), 300);
}
};
