import { PAGE_SRC, helpersCall } from '../../page/build.mjs';

export async function withDesktopFiles(fn) {
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
}

export async function changeDesktopFiles(i, name, act) {
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
  this.refreshSoon(300);
}

export async function terminalProjectFromRoots() {
  const roots = await this.currentRoots();
  return roots.length === 1 ? roots[0] : null;
}

export async function desktopUsageContext() {
  return this.cdp.evaluate(helpersCall('contextPct()'));
}

export async function showDesktopSettings(requestId = 0, section = '') {
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
}
