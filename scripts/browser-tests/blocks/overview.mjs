import { attr, by } from '../context.mjs';

export default [
  { id: 'overview.actions', title: '长按卡片管理菜单及可用操作', refs: ['F03', 'F05'], mode: 'read', apps: true, async run(c, app) {
    const target = await c.target(app), card = await c.reveal(target);
    await c.b.hold(`${card} .ov-title`); await c.b.wait("sheetKind==='agent-actions'", '卡片管理菜单');
    const actions = await c.b.read("[...document.querySelectorAll('#sheet [data-agent-action]')].map(e=>e.dataset.agentAction)");
    c.check(actions.includes('rename'), '卡片提供重命名操作');
    c.check(actions.includes('archive') || actions.includes('delete'), '卡片提供原生归档或删除操作');
    await c.b.dismiss(); return { actions };
  } },
  { id: 'overview.levels', title: '概览、项目、收藏、Fusion 导航', refs: ['F03'], mode: 'read', async run(c) {
    await c.b.home(); const visited = [];
    for (const level of ['sessions', 'projects', 'favorites', 'fusion']) {
      await c.b.click(`#ovLevels ${by('data-v', level)}`);
      c.equal(await c.b.read('ovS.level'), level, '主页栏目切换 ' + level); visited.push(level);
    }
    return { visited };
  } },
  { id: 'overview.card', title: '折叠卡片打开、返回、展开摘要', refs: ['F03', 'R01'], mode: 'read', apps: true, async run(c, app) {
    const target = await c.target(app), opened = await c.open(target);
    c.equal(opened.thread, target.thread, '打开指定卡片的正文');
    const card = await c.expand(target); const preview = await c.preview(target);
    c.check(preview.available, '原生摘要实际可读');
    c.equal(preview.threadId, target.thread, '卡片摘要属于当前会话');
    c.equal(preview.win, target.win, '摘要属于请求的软件路由');
    c.check((preview.text || '').length <= 600 && (preview.tools || []).length <= 3, '卡片摘要和工具数量遵守显示上限');
    c.check(await c.b.has(`${card} [data-ov="full"]`), '展开卡片保留打开正文入口');
    return { elapsedMs: opened.elapsedMs, previewCharacters: preview.text?.length || 0 };
  } },
  { id: 'overview.last-target', title: '展开 A 后打开 B，迟到内容不串会话', refs: ['F04', 'R02', 'M03'], mode: 'write', apps: true, async run(c, app) {
    const a = await c.target(app, 'A', true), b = await c.target(app, 'B', true);
    c.check(a.thread !== b.thread, '使用两个不同的真实会话'); await c.expand(a); const first = await c.open(b);
    await c.b.wait(`windowReady&&lastChat?.thread===${attr(b.thread)}&&pendingSends.size===0`, 'B 正文稳定');
    c.equal((await c.b.snapshot()).thread, b.thread, '最终目标仍为 B');
    return { from: a.thread, to: b.thread, elapsedMs: first.elapsedMs };
  } },
  { id: 'overview.favorite', title: '收藏状态保存和恢复', refs: ['F03', 'F05'], mode: 'write', apps: true, async run(c, app) {
    const target = await c.target(app, 'A', true), card = await c.reveal(target);
    const before = await c.b.read(`ovRecs().find(r=>r.key===${attr(target.key)})?.favorite===true`);
    for (const expected of [!before, before]) {
      await c.b.hold(`${card} .ov-title`); await c.b.click('#sheet [data-agent-action="favorite"]');
      await c.b.wait(`ovRecs().find(r=>r.threadId===${attr(target.thread)})?.favorite===${expected}`, '收藏回执');
      await c.b.dismiss();
    }
    c.equal(await c.b.read(`ovRecs().find(r=>r.threadId===${attr(target.thread)})?.favorite===true`), before, '收藏恢复原值');
    return { thread: target.thread, restored: true };
  } },
];
