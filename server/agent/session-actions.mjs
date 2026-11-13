import { Cdp } from '../cdp.mjs';
import { listWindows } from '../windows.mjs';
import { helpersCall } from '../page/build.mjs';
import { sessionId, removeLibrarySession, publishSessionChange } from '../../lib/session-library.mjs';
import { leaseWindow } from '../window-use.mjs';
import { fusionBindingInUse } from '../fusion/state.mjs';

export const methods = {
  beginSessionBatch(requestId) {
    if (this.sessionBatch) throw new Error('已有批量操作正在执行');
    return this.sessionBatch = { requestId, app: this.app, cancelled: false };
  },
  async batchSessions(ids, requestId, remove) {
    const batch = this.sessionBatch || this.beginSessionBatch(requestId);
    if (batch.requestId !== requestId) throw new Error('已有批量操作正在执行');
    const app = batch.app;
    const rows = [...new Set(ids)].map(id => app === 'opencode' ? { id, app } : this.sessionEntries?.get(id)).filter(row => row?.app === app);
    if (!rows.length) { this.sessionBatch = null; throw new Error('请刷新会话列表后重新选择'); }
    rows.sort((a, b) => Number(sessionId(app, a.id) === this.threadId) - Number(sessionId(app, b.id) === this.threadId));
    const results = [], releases = [];
    const progress = done => this.emit({ t: 'sessionBatchProgress', app, requestId, total: rows.length, results, done, cancelled: batch.cancelled });
    progress(false);
    try {
      for (const window of new Set((app === 'opencode' ? [] : rows).map(row => row.id.startsWith('project:') ? decodeURIComponent(row.id.split(':')[1]) : row.id.startsWith('thread:') ? row.id.split(':')[1] : this.targetId))) releases.push(leaseWindow(app, window, this, true));
      for (const row of rows) {
        if (batch.cancelled || this.app !== app) break;
        try {
          const id = sessionId(app, row.id);
          const fusion = fusionBindingInUse(app, id);
          if (row.running || fusion) throw new Error('会话正在运行，已跳过');
          if (remove) await remove(row);
          else if (app === 'codex') await this.archiveBatchSession(row);
          else {
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
  async archiveBatchSession(row) {
    const id = sessionId('codex', row.id);
    const fresh = (await this.codexThreadRows(this.cdp)).find(r => r.id === id);
    const state = await this.cdp.evaluate(helpersCall('agentState()'));
    if (!fresh || fresh.running || state?.thread === id && state.busy) throw new Error('会话不存在或正在运行，已跳过');
    await this.codexArchiveThread(row.id);
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
    try {
      if (!own) { await cdp.connect(); }
      return await callback(cdp, app, id);
    } finally {
      if (!own) cdp.close();
    }
  },
  async sessionActions(value, requestId) {
    const app = this.app;
    const info = await this.withManagedSession(value, (cdp, app, id) => cdp.evaluate(helpersCall(`nativeSessionInfo(${JSON.stringify(app)}, ${JSON.stringify(id)}, 'actions')`)));
    this.emit({ t: 'sessionActions', app, id: value, requestId, actions: info?.actions || [] });
  },
  async manageSession(value, action, name) {
    if (!['rename', 'delete', 'archive', 'remove'].includes(action)) throw new Error('不支持的会话操作');
    const title = String(name || '').trim().slice(0, 80);
    if (action === 'rename' && !title) throw new Error('会话名称不能为空');
    const app = this.app, id = sessionId(app, value);
    await this.withManagedSession(value, async (cdp, app, id) => {
      const args = `${JSON.stringify(app)}, ${JSON.stringify(id)}`;
      const before = await cdp.evaluate(helpersCall(`nativeSessionInfo(${args}, 'actions')`));
      if (action === 'remove') {
        if (before?.running) throw new Error('会话正在运行，已跳过');
        action = app === 'devin' && before?.actions.includes('archive') ? 'archive' : before?.actions.includes('delete') ? 'delete' : 'archive';
      }
      if (!before?.actions.includes(action)) throw new Error('此会话没有对应的原生操作入口');
      const result = await cdp.evaluate(helpersCall(`nativeSessionAction(${args}, ${JSON.stringify(action)}, ${JSON.stringify(title)})`));
      if (!result?.confirmed) throw new Error('桌面端尚未确认会话操作完成，请刷新列表查看');
      action = result.action;
    });
    if (action === 'delete') removeLibrarySession(app, id);
    publishSessionChange(app, id, { action, ...(action === 'rename' ? { title } : {}) });
    this.projectAgentCache?.clear();
    this.emit({ t: 'status', ok: true, msg: action === 'rename' ? '已重命名会话' : action === 'delete' ? '已删除会话' : action === 'clear' ? '已清空会话' : '已归档会话' });
  },
};
