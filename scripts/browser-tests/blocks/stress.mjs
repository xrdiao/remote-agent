import { attr } from '../context.mjs';
import { browserDeadline, Unavailable } from '../browser.mjs';

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
    const { timeout, stressTimeout, iterations } = c.options;
    const started = performance.now(), samples = [];
    let lastPhase;
    const phase = (iteration, name, action, details) => {
      const step = lastPhase = { app, iteration, phase: name, ...details };
      return browserDeadline(timeout, name, async signal => {
        const start = performance.now();
        await c.stressProgress({ ...step, state: 'started' });
        signal.throwIfAborted();
        const value = await action();
        signal.throwIfAborted();
        await c.stressProgress({ ...step, state: 'done', elapsedMs: Math.round(performance.now() - start) });
        return value;
      });
    };
    c.b.traceNavigation = true;
    try {
      return await browserDeadline(stressTimeout, 'A/B 压力场景总时限', async () => {
        const a = await phase(0, 'lookup-A', () => c.target(app));
        const b = await phase(0, 'lookup-B', async () => {
          // Devin's historical idle catalog may include an externally locked
          // session. When no explicit B is supplied, create a fresh,
          // test-owned native session instead of silently selecting one.
          const target = c.options.targets?.[app]?.B ? await c.target(app, 'B')
            : app === 'devin' ? await c.target(app, 'stress', true)
              : (await c.rows(app)).find(row => row.thread && row.thread !== a.thread && row.state !== 'run' && !row.missing);
          if (!target || a.state === 'run' || target.state === 'run') throw new Unavailable(`${app} 缺少两个可用的空闲会话`);
          c.check(a.thread !== target.thread, '真实目录选定两个不同的空闲会话');
          return target;
        });
        await phase(0, 'open-B-baseline', () => c.open(b));
        for (let i = 1; i <= iterations; i++) {
          const round = performance.now();
          // Instrument the actual back navigation separately from opening
          // Sessions. A timeout here used to collapse both operations into
          // an unhelpful overview failure.
          await phase(i, 'dismiss', () => c.b.dismiss());
          const inConversation = await phase(i, 'read-conversation', () =>
            c.b.read("document.body.classList.contains('conv')"));
          if (inConversation) {
            await phase(i, 'click-back', () => c.b.click('#ovBack', { settle: false }));
            await phase(i, 'overview-ready', () =>
              c.b.wait("!document.body.classList.contains('conv')", '返回主页'));
          }
          await phase(i, 'sessions-level', () => c.b.click('#ovTabs [data-v="sessions"]'));
          const locate = async target => {
            await c.refreshTarget(target);
            return `${await c.revealCard(target, 'sessions')} [data-ov="full"]`;
          };
          const first = await phase(i, 'locate-A', () => locate(a));
          const last = await phase(i, 'locate-B', () => locate(b));
          const navigationId = await phase(i, 'click-A-B', async () => {
            // Both clicks run in the same browser task.
            const received = await c.b.read(`(()=>{
              const visible = element => element && !element.disabled && element.getClientRects().length;
              const a = document.querySelector(${attr(first)}), b = document.querySelector(${attr(last)});
              const before = {clicks:ovOpenRequest, navigation:selectedConversation.serial};
              if(visible(a)&&visible(b)){
                a.click();
                const next = document.querySelector(${attr(last)});
                if(visible(next))next.click();
              }
              return {clicks:ovOpenRequest-before.clicks, before:before.navigation, navigationId:selectedConversation.serial,
                target:selectedConversation.navigation?.target?.threadId};
            })()`);
            c.equal(received.clicks, 2, '页面依次收到 A 和 B 的卡片点击 ' + i);
            c.check(received.navigationId > received.before, '本轮产生新的导航代次 ' + i);
            c.equal(received.target, b.thread, '新导航代次明确指向 B ' + i);
            return received.navigationId;
          });
          await phase(i, 'fresh-B', async () => {
            const result = await c.b.wait(`ovOpening?.phase==='error' ? {error:ovOpening.message} :
              selectedConversation.serial===${navigationId} && windowReady && !selectedConversation.navigation && !chatStale
              && lastChat?.thread && document.body.classList.contains('conv') ? {thread:lastChat.thread,app:currentApp} : null`, '最后一次点击的正文');
            if (result.error) throw new Error('最后一次点击打开会话失败：' + result.error);
            c.equal(result.thread, b.thread, '最后选择 B ' + i);
            c.equal(result.app, app, '最后选择的软件 ' + i);
          }, { navigationId });
          samples.push(Math.round(performance.now() - round));
        }
        return { iterations, a: a.thread, b: b.thread, timeout, stressTimeout, timingMs: distribution(samples), samples };
      });
    } catch (error) {
      const progress = { ...lastPhase, state: 'failed', elapsedMs: Math.round(performance.now() - started), roundsCompleted: samples.length };
      error.stressProgress = progress;
      error.message = `${app} A/B 第 ${progress.iteration || 0}/${iterations} 轮 ${progress.phase || 'setup'}：${error.message}`;
      await c.stressProgress({ ...progress, error: error.message });
      throw error;
    } finally {
      c.b.traceNavigation = false;
    }
  } },
  { id: 'stress.remaining', title: '多电脑、持续资源、媒体、语音及 Fusion 压力分支', refs: ['S03', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10'], mode: 'manual',
    reason: '这里只自动执行重复导航与模型读取。10 分钟混合资源采样、第二电脑、20 次工具详情、Fusion 面板和媒体／真机压力仍按文档单独验收。' },
];
