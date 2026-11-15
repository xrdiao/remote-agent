import { attr, by } from '../context.mjs';
import { Unavailable } from '../browser.mjs';

export default [
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
