import { PAGE_SRC, helpersCall } from '../../page/build.mjs';

// The desktop Fusion model picker has native variants and a legacy menu.
export const fusionModelMenu = {
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
    this.refreshSoon(300);
  }
};
