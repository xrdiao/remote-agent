// 菜单：模型/参数/设置/额度
import { PAGE_SRC, helpersCall } from '../page/build.mjs';
import { appPlans } from './context.mjs';

export const methods = {
  async openModelList() {
    if (await this.cdp.evaluate(helpersCall('clickModelListTrigger()'))) return true;
    const target = await this.cdp.evaluate(helpersCall('modelListTrigger()'));
    if (!target) return false;
    await this.tapCss(target.x, target.y);
    return true;
  },
  async ensureSettings(editorCdp = this.editorCdp) {
    const waitOpen = () => editorCdp.evaluate(helpersCall("waitSettings('open')"));
    if (await editorCdp.evaluate(helpersCall('settingsOpen()'))) return;
    // Click the gear directly. A coordinate click on the 24px footer button often misses.
    if (await editorCdp.evaluate(helpersCall('clickSettingsButton()')) && await waitOpen()) return;
    // Cursor and Devin both bind Settings to Ctrl+Comma.
    const comma = { key: ',', code: 'Comma', windowsVirtualKeyCode: 188, modifiers: 2 };
    await editorCdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...comma });
    await editorCdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...comma });
    if (await waitOpen()) return;
    throw new Error('设置没有打开');
  },
  async closeSettings(editorCdp = this.editorCdp) {
    const how = await editorCdp.evaluate(helpersCall('clickCloseSettings()'));
    if (how === 'tab') await this.key('Ctrl+w', { cdp: editorCdp });
  },
  async showSettings(requestId = 0, section = '') {
    return this.adapter.showSettings.call(this, requestId, section);
  },
  async closeDesktopSettings() {
    const owned = this.desktopSettingsOwned;
    this.desktopSettingsOwned = undefined;
    this.desktopSettingsSection = '';
    if (owned && this.editorCdp) await this.closeSettings();
  },
  async toggleSetting(label, value) {
    await this.ensureSettings();
    const args = `${JSON.stringify(this.desktopSettingsSection || '')}, ${JSON.stringify(this.app)}`;
    const before = JSON.stringify(await this.editorCdp.evaluate(helpersCall(`desktopSettingsData(${args})`)));
    if (typeof value === 'string') {
      if (!await this.editorCdp.evaluate(helpersCall(`desktopSettingValue(${JSON.stringify(label)}, ${JSON.stringify(value)})`))) throw new Error('设置未生效，请重新读取后重试');
    }
    else {
      const pos = await this.editorCdp.evaluate(helpersCall(`settingTarget(${JSON.stringify(label)})`));
      if (!pos) throw new Error('找不到这项设置');
      await this.tapCss(pos.x, pos.y, 'left', this.editorCdp);
    }
    const data = await this.editorCdp.evaluate(`(async()=>{const read=()=>${helpersCall(`desktopSettingsData(${args})`)};const start=Date.now();let data;do{data=read();if(JSON.stringify(data)!==${JSON.stringify(before)})return data;await new Promise(r=>setTimeout(r,30))}while(Date.now()-start<1200);return data})()`);
    this.emit({ t:'settings', ...data });
    if (JSON.stringify(data) === before) throw new Error('设置未生效，请重新读取后重试');
    this.emit({ t:'status', ok:true, msg:'已更新设置' });
  },
  showUsage(automatic = false) {
    if (this.app === 'fusion') return this.fusionUsage(automatic);
    if (this.usageRead?.sel === this.sel) {
      if (!automatic) this.usageRead.manual = true;
      return this.usageRead.promise;
    }
    const request = { sel: this.sel, manual: !automatic };
    this.usageRead = request;
    request.promise = this.fetchUsage(request).finally(() => {
      if (this.usageRead === request) this.usageRead = null;
    });
    return request.promise;
  },
  async fetchUsage(request) {
    const automatic = !request.manual;
    const cdp = this.cdp, sel = this.sel;
    let context;
    try { context = await this.adapter.usageContext.call(this); }
    catch { context = undefined; }
    if (context !== undefined && cdp === this.cdp && this.liveRead(cdp, sel)) this.emit({ t: 'usage', sel: this.selectionKey(), context });
    if (!this.liveRead(cdp, sel)) return;
    try {
      const account = await this.adapter.accountUsage.call(this, request, automatic);
      if (!this.liveRead(cdp, sel)) return;
      if (typeof account?.plan === 'string' && account.plan) appPlans[this.app] = account.plan;
      if (!account && !request.manual) { this.emit({ t: 'usage', sel: this.selectionKey(), ...(context === undefined ? {} : { context }) }); return; }
      if (!account) throw new Error('没有读到额度');
      this.emit({ t: 'usage', sel: this.selectionKey(), updated: Date.now(), ...(context === undefined ? {} : { context }), ...account });
    } catch (e) {
      if (!this.liveRead(cdp, sel)) return;
      const error = /timeout|timed out|超时/i.test(e.message) ? '额度查询超时' : !this.cdp ? '电脑连接已断开' : '额度接口请求失败';
      this.emit({ t: 'usage', sel: this.selectionKey(), error, detail: e.message, automatic: !request.manual, ...(context === undefined ? {} : { context }) });
    }
  },
  async pressControl(name) {
    const clicked = await this.cdp.evaluate(helpersCall(`clickControl(${JSON.stringify(name)})`));
    if (clicked) return;
    const pos = await this.cdp.evaluate(helpersCall(`control(${JSON.stringify(name)})`));
    if (!pos) throw new Error(this.appMessage('当前窗口里没有这个按钮（可能是 {app} 版本或布局不同）'));
    await this.tapCss(pos.x, pos.y);
  },


  // Menus are read by opening them in Cursor, then closed again so the desktop UI is left as it was.
  async openEffortMenu() {
    await this.pressControl('model');
    const pos = await this.waitFor('effortTrigger()');
    if (!pos) { await this.closeMenus(); throw new Error('当前模型没有可选的思考强度'); }
    await this.tapCss(pos.x, pos.y);
    await this.waitFor('menuItems("effort").length');
  },
  async openMenu(kind, requestId) {
    const read = () => this.readMenu(kind, requestId);
    return this.app === 'cursor' && (kind === 'model' || kind === 'effort')
      ? this.withCursorUiRead(read) : read();
  },
  async readMenu(kind, requestId) {
    const sel = this.sel;
    if (this.app === 'codex' && (kind === 'model' || kind === 'effort')) {
      const data = await this.cdp.evaluate(`(() => {
        const h = ${PAGE_SRC};
        if (!h.codexPickerProps()) return null;
        return { items: ${kind === 'model' ? 'h.modelItemsFast()' : 'h.effortItems(true, true)'}, fast: h.fastInfo(), model: h.agentModelName() };
      })()`);
      if (data) {
        if (this.sel === sel) this.emit({ t: 'menu', kind, ...data, requestId, sel: this.selectionKey() });
        return;
      }
    }
    if (kind === 'effort') {
      let items = await this.cdp.evaluate(helpersCall(`effortItems(true, ${this.app === 'codex'})`));
      let fast = await this.cdp.evaluate(helpersCall('fastInfo()'));
      if (!items.length) {
        await this.pressControl('model');
        await this.waitFor('menuOpen()');
        fast = await this.cdp.evaluate(helpersCall('fastInfo()'));
        const pos = await this.cdp.evaluate(helpersCall('effortTrigger()'));
        if (pos) {
          await this.tapCss(pos.x, pos.y);
          await this.waitFor('menuItems("effort").length');
          items = await this.cdp.evaluate(helpersCall('menuItems("effort")'));
        }
        await this.closeMenus();
      }
      const chat = await this.cdp.evaluate(helpersCall('extract()'));
      const pricing = this.app === 'devin' ? await this.cdp.evaluate(helpersCall('devinPricing()')) : null;
      if (this.sel === sel) this.emit({ t: 'menu', kind, items, fast, pricing, model: chat?.model, requestId, sel: this.selectionKey() });
      return;
    }
    if (kind === 'model') {
      // Prop-driven lists (Codex options, Devin visibleModelConfigs) need no visible menu.
      const [items, fast, fusion] = await Promise.all([
        this.cdp.evaluate(helpersCall('modelItemsFast()')),
        this.cdp.evaluate(helpersCall('fastInfo()')),
        this.cdp.evaluate(helpersCall('fusionConfig(true)')),
      ]);
      if (items?.length) {
        if (fusion) this.fusion = fusion;
        const model = this.app === 'devin' && fusion ? 'Fusion' : (await this.cdp.evaluate(helpersCall('extract()')))?.model;
        if (this.sel === sel) this.emit({ t: 'menu', kind, items, fast, fusion, model, requestId, sel: this.selectionKey() });
        return;
      }
    }
    const modelOpen = kind === 'model' && this.app === 'cursor' && await this.cdp.evaluate(`(() => { const h = ${PAGE_SRC}; return !!h.modelListTrigger() || !!h.menuItems('model').length; })()`);
    if (!modelOpen) await this.pressControl(kind);
    let items = [];
    let fast = null;
    for (let i = 0; i < 12 && !items.length; i++) {
      await new Promise(r => setTimeout(r, 150));
      if (kind === 'model') fast ||= await this.cdp.evaluate(helpersCall('fastInfo()'));
      items = await this.cdp.evaluate(helpersCall(`menuItems(${JSON.stringify(kind)})`));
      if (kind === 'model' && !items.length) {
        await this.openModelList();
      }
    }
    const max = kind === 'model' ? await this.cdp.evaluate(helpersCall('maxToggle()?.on ?? null')) : null;
    let fusion = null;
    if (kind === 'model') {
      fusion = await this.cdp.evaluate(helpersCall('fusionConfig(true)'));
      if (fusion) this.fusion = fusion;
    }
    if (!modelOpen) await this.closeMenus();
    if (kind === 'model' && !items.length) throw new Error('模型列表未加载，请确认电脑端模型菜单可以打开');
    if (this.sel === sel) this.emit({ t: 'menu', kind, items, max, fusion, fast, requestId, sel: this.selectionKey() });
  },
  async closeMenus() {
    if (await this.cdp.evaluate(helpersCall('closeModelMenu()'))) await new Promise(r => setTimeout(r, 150));
    if (this.app === 'codex') {
      await this.cdp.evaluate(helpersCall('closeCodexMenu()'));
      return;
    }
    for (let i = 0; i < 3 && await this.cdp.evaluate(helpersCall('menuOpen()')); i++) {
      await this.key('Escape');
      await new Promise(r => setTimeout(r, 120));
    }
  },

  async waitModel(label) {
    const name = JSON.stringify(String(label));
    const selected = await this.waitFor(this.app === 'codex'
      ? `modelItemsFast()?.some(item => item.checked && item.label === ${name})`
      : `agentModelName() === ${name}`);
    if (!selected) throw new Error(`尚未确认切换到 ${label}，请重新读取模型列表`);
  },


  // Leaves the parameter submenu open; callers must closeMenus().
  async openParamMenu(model) {
    const id = JSON.stringify(String(model));
    await this.pressControl('model');
    const row = await this.waitFor(`modelTarget(${id})`);
    if (!row) { await this.closeMenus(); throw new Error('模型列表里找不到这个模型'); }
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y });
    const edit = await this.waitFor(`modelTarget(${id}, 'edit')`, 6);
    if (!edit) { await this.closeMenus(); throw new Error('这个模型没有可调的参数'); }
    await this.tapCss(edit.x, edit.y);
    const params = await this.waitFor('modelParams()');
    if (!params) { await this.closeMenus(); throw new Error(this.appMessage('参数菜单没有打开（可能 {app} 版本不同）')); }
    return params;
  },
  async showParams(model, label) {
    try {
      this.emit({ t: 'params', model, label, sections: await this.openParamMenu(model) });
    } finally {
      await this.closeMenus();
    }
  },
  async pickParam(model, label, section, value) {
    try {
      await this.openParamMenu(model);
      const pos = await this.cdp.evaluate(helpersCall(`paramTarget(${JSON.stringify(String(section))}, ${JSON.stringify(String(value))})`));
      if (!pos) throw new Error(`没找到参数：${section} / ${value}`);
      await this.tapCss(pos.x, pos.y);
      await new Promise(r => setTimeout(r, 250));
    } finally {
      await this.closeMenus();
    }
    await this.showParams(model, label);
    this.refreshSoon(300);
  },
  async syncFast(on) {
    const result = await this.cdp.evaluate(`(async () => {
      const h = ${PAGE_SRC};
      const deadline = performance.now() + 1200;
      do {
        const fast = h.fastInfo();
        if (fast?.on === ${on}) {
          const fusion = h.fusionConfig(true);
          return { fast, fusion, ...(${this.app === 'devin'} && !fusion ? { effort: { items: h.effortItems(true), pricing: h.devinPricing() } } : {}) };
        }
        await new Promise(resolve => setTimeout(resolve, 30));
      } while (performance.now() < deadline);
      return null;
    })()`);
    if (!result) throw new Error('Fast 模式未同步到电脑，请重试');
    const { effort, ...state } = result;
    if (state.fusion) this.fusion = state.fusion;
    this.emit({ t: 'fastState', sel: this.selectionKey(), ...state });
    if (effort) this.emit({ t: 'menu', kind: 'effort', ...effort, sel: this.selectionKey() });
  },
  async pickMenu(kind, label, name) {
    if (kind === 'fast') {
      const on = label === 'on';
      if (!await this.cdp.evaluate(helpersCall(`pickFast(${on})`))) {
        let pos = await this.cdp.evaluate(helpersCall('fastTarget()'));
        if (!pos) {
          await this.pressControl('model');
          pos = await this.cdp.evaluate(helpersCall('fastTarget()')) || await this.waitFor('fastTarget()');
        }
        if (!pos) { await this.closeMenus(); throw new Error('当前模型不支持 Fast'); }
        const current = await this.cdp.evaluate(helpersCall('fastInfo()'));
        if (current.on !== on) await this.cdp.evaluate(helpersCall('clickCursorFast()'));
      }
      try { await this.syncFast(on); }
      finally { await this.closeMenus(); }
      this.emit({ t: 'status', ok: true, msg: '设置已更新' });
      return;
    }
    if (kind === 'effort') {
      if (this.app === 'codex' && label === 'max') {
        const max = await this.cdp.evaluate(`(() => {
          const h = ${PAGE_SRC};
          if (h.effortItems().some(x => x.label === 'max')) return 'visible';
          return h.effortItems(false, true).some(x => x.label === 'max') ? 'hidden' : null;
        })()`);
        if (!max) throw new Error('当前 Codex 模型不支持 Max');
        if (max === 'hidden') await this.enableCodexMax();
      }
      const picked = await this.cdp.evaluate(helpersCall(`pickEffort(${JSON.stringify(label)})`));
      if (!picked) {
        await this.openEffortMenu();
        const pos = await this.waitFor(`menuItem("effort", ${JSON.stringify(label)})`);
        if (!pos) { await this.closeMenus(); throw new Error('没有找到这个思考强度'); }
        await this.tapCss(pos.x, pos.y);
        await this.closeMenus();
      }
      if (this.app === 'codex' && !await this.waitFor(`effortItems().some(item => item.checked && item.label === ${JSON.stringify(label)})`)) throw new Error('尚未确认电脑端思考强度，请重新读取强度列表');
      this.pollChat(this.app === 'codex').catch(() => {});
      return;
    }
    if (String(kind || '').startsWith('fusion-effort-')) return this.fusionModelPick(kind.slice('fusion-effort-'.length), label, true);
    if (String(kind || '').startsWith('fusion-model-')) return this.fusionModelPick(kind.slice('fusion-model-'.length), label);
    if (kind === 'codex-run') return this.codexRunPick(String(label || ''));
    if (kind === 'codex-chat') return this.codexChatPick(String(label || ''), name ? String(name).slice(0, 80) : '');
    if (kind === 'model' && await this.adapter.pickModelMenu.call(this, label)) return;
    if (!(kind === 'model' && this.app === 'cursor' && await this.cdp.evaluate(`(() => { const h = ${PAGE_SRC}; return !!h.modelListTrigger() || !!h.menuItems('model').length; })()`))) await this.pressControl(kind);
    if (kind === 'model' && this.app !== 'codex') {
      for (let i = 0; i < 8; i++) {
        if (await this.cdp.evaluate(helpersCall('menuItems("model").length'))) break;
        if (await this.openModelList()) break;
        await new Promise(r => setTimeout(r, 120));
      }
    }
    let pos = await this.cdp.evaluate(helpersCall(`menuItem(${JSON.stringify(kind)}, ${JSON.stringify(String(label))})`));
    for (let i = 0; i < 10 && !pos; i++) {
      await new Promise(r => setTimeout(r, 100));
      pos = await this.cdp.evaluate(helpersCall(`menuItem(${JSON.stringify(kind)}, ${JSON.stringify(String(label))})`));
    }
    if (!pos) {
      await this.closeMenus();
      throw new Error(`没找到选项：${label}`);
    }
    await this.tapCss(pos.x, pos.y);
    if (kind === 'model' && label !== 'Fusion') {
      await this.waitModel(label);
      await this.closeMenus();
      this.pollChat(this.app === 'cursor' || this.app === 'codex').catch(() => {});
      return;
    }
    let pending = false;
    if (this.app === 'codex' && kind === 'permission') {
      await new Promise(r => setTimeout(r, 150));
      pending = (await this.cdp.evaluate(helpersCall('codexRequestData()'))).length > 0;
    }
    this.emit({ t: 'status', ok: true, msg: pending ? '请在下方确认权限变更' : `已切换到 ${label}` });
    if (kind === 'model' && label === 'Fusion') {
      this.fusion = null;
      this.fusionMiss = false;
      await new Promise(r => setTimeout(r, 300));
      await this.closeMenus();
      await this.pollChat(true);
      return;
    }
    this.refreshSoon(500);
  }
};
