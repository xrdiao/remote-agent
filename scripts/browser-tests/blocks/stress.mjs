import { attr } from '../context.mjs';

export function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, min: sorted[0], median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)], max: sorted.at(-1) };
}
export default [
  { id: 'stress.open', title: '反复打开关闭与长会话后再次打开', refs: ['F16', 'R01', 'R07', 'S01', 'S04', 'S07', 'S08'], mode: 'stress', apps: true, async run(c, app) {
    const a = await c.target(app), long = await c.target(app, 'long'), times = [];
    for (let i = 0; i < c.options.iterations; i++) {
      const target = i % 2 ? long : a, value = await c.open(target); times.push(value.elapsedMs);
      c.equal(value.thread, target.thread, '重复打开目标正确 ' + i); await c.b.home();
    }
    const stats = distribution(times);
    c.check(stats.max < c.options.timeout, '没有任何一次超过导航超时');
    if (c.options.maxOpenMs) c.check(stats.p95 <= c.options.maxOpenMs, 'P95 不超过显式性能门限');
    return { timingMs: stats, samples: times, thresholdMs: c.options.maxOpenMs || null,
      note: '未设置 --max-open-ms 时只报告延迟，不把“未超时”视为速度合格' };
  } },
  { id: 'stress.menus', title: '重复模型菜单读取无卡死和身份漂移', refs: ['F08', 'S02'], mode: 'stress', apps: true, async run(c, app) {
    const target = await c.target(app), times = []; await c.open(target);
    for (let i = 0; i < c.options.iterations; i++) {
      const start = performance.now(), items = await c.menu('model');
      times.push(Math.round(performance.now() - start));
      c.check(items.length > 0, '模型菜单有真实候选 ' + i); await c.b.dismiss();
      c.equal(await c.b.read('lastChat.thread'), target.thread, '菜单不切换会话 ' + i);
    }
    return { timingMs: distribution(times), samples: times };
  } },
  { id: 'stress.last-target', title: '快速连续 A/B 点击最终只打开最后目标', refs: ['F16', 'R02', 'S01', 'S03'], mode: 'stress', apps: true, async run(c, app) {
    const rows = (await c.rows(app)).filter(row => row.thread && row.state !== 'run');
    c.check(rows.length >= 2, '真实目录至少有两个空闲会话'); const a = rows[0], b = rows[1];
    // Each navigation starts from the actual home cards; no direct ovOpen calls.
    for (let i = 0; i < c.options.iterations; i++) {
      await c.reveal(a); await c.b.click(`[data-ov-session=${attr(a.key)}] [data-ov="full"]`);
      await c.b.home(); const last = await c.open(b); c.equal(last.thread, b.thread, '最后选择 B ' + i);
    }
    return { iterations: c.options.iterations, a: a.thread, b: b.thread };
  } },
  { id: 'stress.remaining', title: '多电脑、持续资源、媒体、语音及 Fusion 压力分支', refs: ['S03', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10'], mode: 'manual',
    reason: '这里只自动执行重复导航与模型读取。10 分钟混合资源采样、第二电脑、20 次工具详情、Fusion 面板和媒体／真机压力仍按文档单独验收。' },
];
