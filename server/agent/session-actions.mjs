import { Cdp, cdpRead } from '../cdp.mjs';
import { listWindows } from '../windows.mjs';
import { helpersCall } from '../page/build.mjs';
import { mod } from '../../lib/platform.mjs';
import { sessionId, removeLibrarySession, publishSessionChange } from '../../lib/session-library.mjs';
import { leaseWindow } from '../window-use.mjs';
import { fusionWorkers, FUSION_ACTIVE } from '../fusion/state.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export const methods = {
  async batchSessions(ids, requestId) {
    if (this.sessionBatch) throw new Error('已有批量操作正在执行');
    const app = this.app;
    const rows = [...new Set(ids)].map(id => this.sessionEntries?.get(id)).filter(row => row?.app === app);
    if (!rows.length) throw new Error('请刷新会话列表后重新选择');
    rows.sort((a, b) => Number(sessionId(app, a.id) === this.threadId) - Number(sessionId(app, b.id) === this.threadId));
    const batch = this.sessionBatch = { requestId, cancelled: false };
    const results = [], releases = [];
    const progress = done => this.emit({ t: 'sessionBatchProgress', app, requestId, total: rows.length, results, done, cancelled: batch.cancelled });
    progress(false);
    try {
      for (const window of new Set(rows.map(row => row.id.startsWith('project:') ? decodeURIComponent(row.id.split(':')[1]) : row.id.startsWith('thread:') ? row.id.split(':')[1] : this.targetId))) releases.push(leaseWindow(app, window, this, true));
      for (const row of rows) {
        if (batch.cancelled || this.app !== app) break;
        try {
          const id = sessionId(app, row.id);
          const fusion = [...fusionWorkers.values()].some(worker => FUSION_ACTIVE.includes(worker.fusionRun?.phase) && ['a', 'b'].some(side => {
            const spec = worker.fusionRun[side];
            return spec?.app === app && sessionId(app, spec.agentId || spec.conversationId || spec.threadId) === id;
          }));
          if (row.running || fusion) throw new Error('会话正在运行，已跳过');
          if (app === 'codex') {
            const fresh = (await this.codexThreadRows(this.cdp)).find(r => r.id === id);
            const state = await this.cdp.evaluate(helpersCall('agentState()'));
            if (!fresh || fresh.running || state?.thread === id && state.busy) throw new Error('会话不存在或正在运行，已跳过');
            await this.codexArchiveThread(row.id);
          } else {
            await this.manageSession(row.id, 'remove');
          }
          results.push({ id: row.id, ok: true });
        } catch (error) { results.push({ id: row.id, ok: false, error: error.message }); }
        progress(false);
      }
    } finally {
      this.sessionBatch = null;
      for (const release of releases) release();
      progress(true);
    }
  },
  async withManagedSession(value, callback) {
    const app = this.app;
    if (!['cursor', 'devin'].includes(app)) throw new Error('当前 Agent 不支持此操作');
    let windowId = this.targetId;
    if (String(value).startsWith('project:')) windowId = decodeURIComponent(value.split(':')[1]);
    const id = sessionId(app, value);
    if (!id) throw new Error('没有读取到会话标识，请刷新会话列表');
    const own = windowId === this.targetId;
    const page = !own && (await listWindows(null, app)).find(w => w.id === windowId);
    if (!own && !page) throw new Error('会话所属窗口已经关闭，请刷新列表');
    const cdp = own ? this.cdp : new Cdp(page.ws);
    let surface, openedSidebar = false, openedDevinPicker = false;
    try {
      if (!own) {
        await cdp.connect();
        await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      }
      if (app === 'devin') {
        surface = await cdp.evaluate(helpersCall('devinSurface()'));
        if (surface === 'editor') {
          const point = await cdp.evaluate(helpersCall('sessionSearchTarget()'));
          if (!point) throw new Error('没有找到会话管理界面');
          if (!point.open) {
            await this.tapCss(point.x, point.y, 'left', cdp);
            openedDevinPicker = true;
          }
          for (let i = 0; i < 30 && !(await cdp.evaluate(helpersCall('sessionPickerRows()')))?.length; i++) await pause(100);
        }
        if (surface !== 'editor' && !await cdp.evaluate(`!!document.querySelector('li[data-slot="sidebar-menu-item"]')`)) {
          await this.key(mod('b'), { cdp });
          openedSidebar = true;
          for (let i = 0; i < 30 && !await cdp.evaluate(`!!document.querySelector('li[data-slot="sidebar-menu-item"]')`); i++) await pause(100);
        }
        for (let i = 0; i < 30; i++) {
          const info = await cdp.evaluate(helpersCall(`nativeSessionInfo('devin', ${JSON.stringify(id)})`));
          if (!info || info.actions.length) break;
          await pause(100);
        }
      }
      return await callback(cdp, app, id);
    } finally {
      await cdpRead.run(null, async () => {
        try {
          if (openedSidebar) await this.key(mod('b'), { cdp });
          if (openedDevinPicker) await this.key('Escape', { cdp });
        } finally {
          if (!own) {
            await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
            cdp.close();
          }
        }
      });
    }
  },
  async sessionActions(value, requestId) {
    const app = this.app;
    const info = await this.withManagedSession(value, (cdp, app, id) => cdp.evaluate(helpersCall(`nativeSessionInfo(${JSON.stringify(app)}, ${JSON.stringify(id)})`)));
    this.emit({ t: 'sessionActions', app, id: value, requestId, actions: info?.actions || [] });
  },
  async manageSession(value, action, name) {
    if (!['rename', 'delete', 'archive', 'remove'].includes(action)) throw new Error('不支持的会话操作');
    const title = String(name || '').trim().slice(0, 80);
    if (action === 'rename' && !title) throw new Error('会话名称不能为空');
    const app = this.app, id = sessionId(app, value);
    await this.withManagedSession(value, async (cdp, app, id) => {
      const args = `${JSON.stringify(app)}, ${JSON.stringify(id)}`;
      const before = await cdp.evaluate(helpersCall(`nativeSessionInfo(${args})`));
      if (action === 'remove') {
        if (before?.running) throw new Error('会话正在运行，已跳过');
        action = before?.actions.includes('delete') ? 'delete' : 'archive';
      }
      if (!before?.actions.includes(action)) throw new Error('此会话没有对应的原生操作入口');
      const result = await cdp.evaluate(helpersCall(`nativeSessionAction(${args}, ${JSON.stringify(action)}, ${JSON.stringify(title)})`));
      if (app === 'cursor') {
        if (result.confirmed) return;
        throw new Error('桌面端尚未确认会话操作完成，请刷新列表查看');
      }
      if (app === 'devin' && action === 'rename' && !result?.direct) {
        let input;
        for (let i = 0; i < 30 && !input; i++) {
          input = await cdp.evaluate(helpersCall(`nativeSessionRenameInput(${JSON.stringify(id)})`));
          if (!input) await pause(100);
        }
        if (!input) throw new Error('原生重命名输入框没有出现');
        await this.typeText(title, cdp);
        await this.key('Enter', { cdp });
      }
      for (let i = 0; i < 80; i++) {
        if (action !== 'rename') {
          const point = await cdp.evaluate(helpersCall(`nativeSessionConfirm(${JSON.stringify(action)})`));
          if (point) await this.tapCss(point.x, point.y, 'left', cdp);
        }
        const after = await cdp.evaluate(helpersCall(`nativeSessionInfo(${args})`));
        if (action === 'rename' ? after?.title === title : action === 'archive' ? after?.archived : !after) return;
        await pause(150);
      }
      throw new Error('桌面端尚未确认会话操作完成，请刷新列表查看');
    });
    if (action === 'delete') removeLibrarySession(app, id);
    publishSessionChange(app, id, { action, ...(action === 'rename' ? { title } : {}) });
    this.projectAgentCache?.clear();
    this.emit({ t: 'status', ok: true, msg: action === 'rename' ? '已重命名会话' : action === 'delete' ? '已删除会话' : '已归档会话' });
  },
};
