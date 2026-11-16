import { attr, by } from '../context.mjs';
import { Unavailable } from '../browser.mjs';
import { Cdp } from '../../../server/cdp.mjs';
import { listWindows, codexWindows } from '../../../server/windows.mjs';
import { CODEX_CDP_URL } from '../../../server/config.mjs';
import { helpersCall } from '../../../server/page/build.mjs';
import { OpenCodeClient } from '../../../server/opencode/client.mjs';

export default [
  { id: 'sessions.id-read', title: 'Devin 未在桌面展开的已有 ID 可读取摘要和正文', refs: ['F04', 'F07', 'R01'], mode: 'read', apps: ['devin'], async run(c, app) {
    const target = await c.target(app, 'cold'), page = (await listWindows(null, app)).find(page => page.id === target.window);
    if (!page) throw new Unavailable('Devin 桌面连接尚未就绪');
    const native = new Cdp(page.ws); await native.connect();
    try {
      const before = await native.evaluate(helpersCall('activeThread()'));
      if (before === target.thread) throw new Unavailable('指定样本已在桌面展开，需要另一个已有会话 ID');
      await c.reveal(target);
      const preview = await c.preview(target);
      c.check(preview.available, '未展开的会话按 ID 取得真实摘要');
      c.equal(await native.evaluate(helpersCall('activeThread()')), before, '读取摘要没有切换桌面会话');
      await c.open(target);
      c.equal(await c.b.read('lastChat.thread'), target.thread, '按相同 ID 打开正文');
      c.check(await c.b.read('lastChat.items.length>0'), '已有会话正文实际呈现');
      return { thread: target.thread, desktopBefore: before, previewAvailable: preview.available };
    } finally { native.close(); }
  } },
  { id: 'sessions.archive', title: '原生归档成功后移除列表和管理缓存', refs: ['F05', 'F09'], mode: 'write', apps: ['codex', 'opencode'], async run(c, app) {
    const target = await c.target(app, 'archive', true), card = await c.reveal(target);
    await c.b.hold(`${card} .ov-title`);
    await c.b.wait("sheetKind==='agent-actions'&&!document.querySelector('#sheet [role=status]')", '原生管理菜单');
    if (!await c.b.has('#sheet [data-agent-action="archive"]')) throw new Unavailable('此原生会话未提供归档操作');
    await c.b.click('#sheet [data-agent-action="archive"]');
    if (await c.b.has('#askOk')) await c.b.click('#askOk');
    await c.b.wait(`!ovRecs().some(row=>row.app===${attr(app)}&&row.threadId===${attr(target.thread)})`, '归档后普通列表移除');
    c.check(!(await c.overview()).sessions.some(row => row.app === app && row.threadId === target.thread), '原生目录同步确认归档');
    if (app === 'opencode') {
      const row = await new OpenCodeClient().request(`/session/${target.thread}`, { directory: target.root });
      c.check(row.time.archived > 0, 'OpenCode 原生归档时间已保存');
    } else {
      const page = (await codexWindows(CODEX_CDP_URL)).find(page => page.chatWs), native = new Cdp(page.chatWs);
      await native.connect();
      try {
        const catalog = await native.evaluate(helpersCall(`nativeSessionInfo('codex', {threads:true,ids:[${attr(target.thread)}]}, true)`));
        c.check(catalog.rows.some(row => row.id === target.thread && row.archived), 'Codex 原生记录确实已归档');
      } finally { native.close(); }
    }
    c.cleanup.sessions.push({ thread: target.thread, ok: true, action: 'archive' });
    c.owned.splice(c.owned.indexOf(target), 1); await c.persistResources();
    return { thread: target.thread, archived: true };
  } },
  { id: 'sessions.native-created', title: '空会话有原生 ID、持久记录和电脑端目录入口', refs: ['F04', 'F05', 'M03'], mode: 'write', apps: true, async run(c, app) {
    const target = await c.target(app, 'native-created', true); await c.open(target);
    c.check(!!target.thread, '发送第一条消息前已有原生会话 ID');
    c.check(!await c.b.read("lastChat.items.some(item=>item.k==='human')"), '检查对象是尚未发送消息的空会话');
    let row;
    if (app === 'opencode') {
      const client = new OpenCodeClient();
      row = await client.request(`/session/${target.thread}`, { directory: target.root });
      c.equal(row.id, target.thread, 'OpenCode 原生服务可按 ID 读取空会话');
      c.check((await client.sessions()).some(row => row.id === target.thread), 'OpenCode 原生界面会话目录含同一 ID');
    } else {
      const page = app === 'codex' ? (await codexWindows(CODEX_CDP_URL)).find(page => page.chatWs)
        : (await listWindows(null, app)).find(page => page.id === target.window);
      if (!page) throw new Unavailable('原生桌面窗口尚未就绪');
      const native = new Cdp(page.chatWs || page.ws); await native.connect();
      try {
        const rows = app === 'codex' ? await native.evaluate(helpersCall('codexChatRows(true)'))
          : (await native.evaluate(helpersCall(`nativeSessionInfo(${attr(app)}, [], true)`))).rows;
        row = rows.find(row => row.id === target.thread);
        c.check(!!row && !row.archived, '电脑端原生会话目录包含同一 ID');
      } finally { native.close(); }
    }
    c.check(!!row, '原生目录确认空会话已保存');
    await c.reveal(target); await c.open(target);
    c.equal(await c.b.read('lastChat.thread'), target.thread, '离开再打开仍是同一空会话');
    return { thread: target.thread, nativeListed: true, project: target.projectRead };
  } },
  { id: 'sessions.project', title: '跨项目新建及 A→B→A 归属', refs: ['F04', 'M03', 'M05', 'W02', 'W05', 'W06'], mode: 'write', apps: true, async run(c, app) {
    const a = await c.target(app, 'A', true), b = await c.target(app, 'B', true), results = [];
    for (const target of [a, b, a]) { await c.open(target); results.push(await c.verifyProject(target)); }
    c.equal(results[0].thread, results[2].thread, '返回同一 A 会话');
    c.check(results[0].root !== results[1].root, '两会话使用不同项目路径'); return { visits: results };
  } },
  { id: 'sessions.rename', title: '重命名确认到原生目录', refs: ['F05'], mode: 'write', apps: true, async run(c, app) {
    const target = await c.target(app, 'A', true), title = c.marker + '-' + app;
    const card = await c.reveal(target); await c.b.hold(`${card} .ov-title`);
    await c.b.dialog(title, () => c.b.click('#sheet [data-agent-action="rename"]'));
    await c.b.wait(`ovRecs().some(r=>r.threadId===${attr(target.thread)}&&r.title===${attr(title)})`, '原生标题回执');
    const data = await c.overview(), row = data.sessions.find(row => row.app === app && row.threadId === target.thread);
    c.equal(row.title, title, '原生目录标题与重命名一致'); return { thread: target.thread, confirmed: true };
  } },
  { id: 'sessions.fork', title: 'Codex 分叉历史、项目和权限', refs: ['F04', 'F09', 'M05'], mode: 'generate', apps: ['codex'], async run(c, app) {
    const source = await c.target(app, 'A', true); await c.open(source);
    if (!await c.b.has('[data-action-id="fork"]')) {
      await c.send(source, `只回复 ${c.marker}-FORK，不运行命令。`);
    }
    const before = {};
    for (const kind of ['permission', 'effort']) {
      before[kind] = (await c.menu(kind)).find(row => row.checked)?.label;
      c.check(!!before[kind], '分叉前原生菜单标识当前 ' + kind); await c.b.dismiss();
    }
    await c.b.click('[data-action-id="fork"]');
    await c.b.wait(`windowReady&&lastChat?.thread&&lastChat.thread!==${attr(source.thread)}`, '分叉首屏');
    const thread = await c.b.read('lastChat.thread');
    const row = await c.b.wait(`ovRecs().find(r=>r.app==='codex'&&r.threadId===${attr(thread)})`, '分叉原生目录');
    const fork = { ...source, key: row.key, project: row.project, thread, window: row.windowId, win: row.win, slot: 'fork' };
    c.owned.push(fork); await c.persistResources(); await c.verifyProject(fork);
    const after = {};
    for (const kind of ['permission', 'effort']) {
      after[kind] = (await c.menu(kind)).find(row => row.checked)?.label;
      c.check(!!after[kind], '分叉后原生菜单标识当前 ' + kind); await c.b.dismiss();
    }
    c.equal(after.permission, before.permission, '分叉保留权限'); c.equal(after.effort, before.effort, '分叉保留强度');
    c.check(await c.b.read('lastChat.items.length>0'), '分叉有原会话历史'); return { thread, ...after };
  } },
  { id: 'sessions.batch', title: '批量管理与取消入口', refs: ['F05'], mode: 'write', apps: true, async run(c, app) {
    const a = await c.target(app, 'A', true); await c.reveal(a, 'sessions');
    await c.b.menu('overviewBatch');
    await c.b.wait('!!ovBatch', '批量管理');
    await c.b.click(`${by('data-ov-session', a.key)} .ov-title`);
    c.equal(await c.b.read('ovBatch.selected.size'), 1, '批量目标只选本轮会话');
    await c.b.click('[data-ov="batch-exit"]'); c.check(await c.b.read('!ovBatch'), '取消管理释放选择');
    return { selected: a.thread, cancelled: true };
  } },
  { id: 'sessions.multi-window', title: '同会话多个原生窗口同步', refs: ['M01', 'M06', 'M07', 'W15'], mode: 'manual',
    reason: '需要同一真实会话的两个原生窗口及原生输出；单窗口打开成功不能代替。' },
];
