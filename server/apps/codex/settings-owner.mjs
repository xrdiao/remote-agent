import { Cdp, cdpRead, awaitCdpRead } from '../../cdp.mjs';
import { CODEX_CDP_URL } from '../../config.mjs';
import { codexWindows } from '../../windows.mjs';
import { mod } from '../../../lib/platform.mjs';
import { helpersCall } from '../../page/build.mjs';
import { orderedProjectWindows, bindProjectWindow, nativeCloseProjectWindow } from '../../project-windows.mjs';
import { leaseWindow } from '../../window-use.mjs';
import { openFolder } from '../../agent/project-paths.mjs';

async function backendSettingsOwner(s) {
  if (!s.codexBackendSettings) {
    const { AgentContext } = await import('../../agent/context.mjs');
    const context = new AgentContext({ deviceId: s.deviceId });
    context.app = 'codex';
    context.emit = message => s.emit(message);
    const owner = s.codexBackendSettings = { context };
    owner.ready = (async () => {
      let page = orderedProjectWindows('codex', await codexWindows(CODEX_CDP_URL))[0];
      if (!page) {
        await openFolder(s.codexDirectory, 'codex', true, true);
        const deadline = Date.now() + 30000;
        while (!page && Date.now() < deadline) {
          page = orderedProjectWindows('codex', await codexWindows(CODEX_CDP_URL))[0];
          if (!page) await awaitCdpRead(new Promise(resolve => setTimeout(resolve, 120)));
        }
        if (!page) throw new Error('Codex 设置窗口尚未就绪');
        owner.created = true;
      }
      owner.page = page;
      owner.release = leaseWindow('codex', page.pageId, owner);
      bindProjectWindow('codex', page.pageId);
      context.editorCdp = new Cdp(page.ws);
      await context.editorCdp.connect();
      if (!page.chatWs) {
        const pageId = page.pageId;
        await context.withFocus(async () => {
          await context.key(mod('Shift+p'), { cdp: context.editorCdp });
          await context.editorCdp.send('Input.insertText', { text: 'Codex: Open Codex Sidebar' });
          await context.key('Enter', { cdp: context.editorCdp });
        });
        const deadline = Date.now() + 30000;
        while (!page?.chatWs && Date.now() < deadline) {
          page = (await codexWindows(CODEX_CDP_URL, false, pageId))[0];
          if (!page?.chatWs) await awaitCdpRead(new Promise(resolve => setTimeout(resolve, 120)));
        }
        if (!page?.chatWs) throw new Error('Codex 设置需要已就绪的桌面插件侧边栏');
      }
      context.cdp = new Cdp(page.chatWs);
      await context.cdp.connect();
      return owner;
    })();
  }
  return awaitCdpRead(s.codexBackendSettings.ready);
}

export async function closeBackendSettings(s, owner = s.codexBackendSettings) {
  if (s.codexBackendSettings === owner) s.codexBackendSettings = null;
  if (!owner) return;
  return owner.closing ||= (async () => {
    const context = owner.context;
    try {
      await owner.ready;
      await context.closeCodexSettings();
    } finally {
      clearTimeout(context.focusTimer);
      try {
        try {
          await Promise.all([...new Set([context.cdp, context.editorCdp])].filter(Boolean).map(async cdp => {
            try { await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }); }
            finally { cdp.close(); }
          }));
        } finally { if (owner.created) await nativeCloseProjectWindow({ webSocketDebuggerUrl: owner.page.ws }); }
      } finally { owner.release?.(); }
    }
  })();
}

export async function withBackendSettings(s, action) {
  const ready = backendSettingsOwner(s), owner = s.codexBackendSettings;
  try {
    const { context } = await ready;
    return await context.withFocus(() => action(context));
  } catch (error) {
    try { await cdpRead.run(null, () => closeBackendSettings(s, owner)); }
    finally { throw error; }
  }
}

export async function withCodexSettings(fn) {
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
}

export async function showCodexSettings(id = '', requestId = 0, value) {
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
}

export async function saveCodexInstructions(text, requestId = 0) {
  const sel = this.sel;
  const data = await this.withCodexSettings(cdp => cdp.evaluate(helpersCall(`codexSaveInstructions(${JSON.stringify(text)})`)));
  if (this.sel === sel && this.app === 'codex') {
    this.emit({ t: 'settings', codex: true, requestId, ...data });
    this.emit({ t: 'status', ok: true, msg: 'Codex instructions 已保存' });
  }
}

export async function closeCodexSettings() {
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
}
