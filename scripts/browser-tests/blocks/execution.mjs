import { attr, by } from '../context.mjs';
import { Unavailable } from '../browser.mjs';

async function generating(c, app) {
  const target = await c.target(app, 'execution', true); await c.open(target);
  await c.send(target, `不要使用任何工具。先写出 ${c.marker}，再输出从 1 到 400 的编号，每个数字单独一行。`, { complete: false });
  if (!await c.b.read('lastChat.busy')) throw new Unavailable('模型已完成，未捕捉到真实生成窗口');
  return target;
}
async function enqueue(c, marker) {
  if (!await c.b.read("document.getElementById('send').textContent.includes('排队')")) throw new Unavailable('当前原生软件未提供排队入口');
  await c.draft(`只回复 ${marker}，不运行工具。`); await c.b.click('#send');
  return c.b.wait(`lastChat.queued?.find(q=>q.t?.includes(${attr(marker)}))||null`, '队列原生接受');
}
async function stopGeneration(c) {
  if (await c.b.read("document.getElementById('composerFold').getAttribute('aria-expanded')==='false'")) await c.b.click('#composerFold');
  await c.b.click('#stop');
  await c.b.wait("!!document.querySelector('#askOk')", '停止确认');
  await c.b.click('#askOk');
  await c.b.wait('!lastChat.busy', '原生停止', c.options.generationTimeout);
}
export default [
  { id: 'execution.queue-delivery', title: '排队后按顺序自然发送', refs: ['F06'], mode: 'generate', apps: ['codex', 'cursor', 'devin'], async run(c, app) {
    const target = await generating(c, app), marker = c.marker + '-QUEUE-NATURAL'; await enqueue(c, marker);
    c.check(await c.b.read('lastChat.queued.length>0'), '真实队列含待发送消息');
    await c.finishGeneration(target, '排队执行完成');
    await c.b.wait(`!lastChat.busy&&!lastChat.queued?.length&&lastChat.items.some(i=>i.k==='human'&&i.t?.includes(${attr(marker)}))`, '排队后自动执行', c.options.generationTimeout);
    const count = await c.b.read(`lastChat.items.filter(i=>i.k==='human'&&i.t?.includes(${attr(marker)})).length`);
    c.equal(count, 1, '排队原文只提交一次'); c.equal(await c.b.read('text.value'), '', '排队后草稿清空'); return { thread: target.thread };
  } },
  { id: 'execution.queue-now', title: '已排队消息立即发送并离开队列', refs: ['F06'], mode: 'generate', apps: ['codex', 'cursor', 'devin'], async run(c, app) {
    const target = await generating(c, app), marker = c.marker + '-QUEUE-NOW', queued = await enqueue(c, marker);
    const button = `#queueBar ${by('data-q', queued.id)}[data-a="send"]`;
    if (!await c.b.has(button)) await c.b.click('#queueBar [data-qfold]'); await c.b.click(button); await c.b.click('#askOk');
    await c.b.wait(`!lastChat.queued?.some(q=>q.id===${attr(queued.id)})&&lastChat.items.some(i=>i.k==='human'&&i.t?.includes(${attr(marker)}))`, '立即发送原生回执');
    c.check(await c.b.read(`!lastChat.queued?.some(q=>q.id===${attr(queued.id)})`), '立即发送从队列移除');
    await c.finishGeneration(target, '立即发送后生成完成'); return { thread: target.thread, queue: queued.id };
  } },
  { id: 'execution.stop', title: '原生生成中停止并恢复可编辑', refs: ['F06', 'F17'], mode: 'generate', apps: true, async run(c, app) {
    const target = await generating(c, app);
    await stopGeneration(c);
    if (app === 'codex') c.equal(await c.b.read('lastChat.run?.status'), 'stopped', 'Codex 本轮由停止操作结束');
    c.check(await c.b.read("!document.getElementById('text').disabled"), '停止后输入框可编辑');
    await c.draft(c.marker + '-AFTER-STOP'); c.equal(await c.b.read('text.value'), c.marker + '-AFTER-STOP', '停止后草稿可正常写入');
    await c.draft(''); return { thread: target.thread };
  } },
  { id: 'execution.generating-navigation', title: '生成中返回主页并切换 B 后再回 A', refs: ['F04', 'F17', 'R05', 'R06'], mode: 'generate', apps: true, async run(c, app) {
    const b = await c.target(app, 'B', true), a = await generating(c, app);
    const result = await c.open(b); c.equal(result.thread, b.thread, 'A 生成未阻塞 B 导航');
    c.check(await c.b.read('!lastChat.busy'), '空白 B 没有沿用 A 的生成状态');
    await c.open(a); c.equal(await c.b.read('lastChat.thread'), a.thread, '回到生成中的 A');
    await c.finishGeneration(a, 'A 结束并同步正文');
    c.check(await c.b.read('lastChat.items.length>0'), '最终原生消息仍能加载'); return { a: a.thread, b: b.thread, openBMs: result.elapsedMs };
  } },
  { id: 'execution.live-stats', title: '生成时统计模型、计数及速度数据', refs: ['F08', 'F16', 'R11'], mode: 'generate', apps: true, async run(c, app) {
    const target = await generating(c, app), samples = [], deadline = Date.now() + Math.min(c.options.generationTimeout, 30000);
    while (Date.now() < deadline) {
      const row = await c.b.read('({busy:lastChat.busy,model:lastChat.model,performance:lastChat.performance,chip:document.getElementById("perfChip").textContent})');
      samples.push({ at: Date.now(), ...row }); if (!row.busy) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    c.check(samples.some(row => row.model), '生成阶段存在模型名称');
    c.check(samples.some(row => row.performance), '生成阶段返回原生性能统计');
    c.check(samples.every(row => !/NaN|Infinity/.test(row.chip)), '速度展示没有无效数值');
    await c.b.click('#perfChip');
    const fields = await c.b.read("[...document.querySelectorAll('#perfPanel .perf-key')].map(e=>e.textContent)");
    for (const key of ['耗时', '输入 token', '输出 token', '推理 token', '模型']) c.check(fields.includes(key), '统计面板包含 ' + key);
    await c.b.click('#perfChip');
    if (await c.b.read('lastChat.busy')) await stopGeneration(c);
    return { thread: target.thread, samples, note: '记录原生提供的计数及采样时间；不把未知速度视为速度测量通过' };
  } },
  { id: 'execution.commands', title: '命令补全和 compact 菜单不误提交', refs: ['F06'], mode: 'write', apps: ['codex', 'opencode'], async run(c, app) {
    const target = await c.target(app, 'commands', true); await c.open(target);
    const events = c.b.events.length;
    try {
      await c.draft('/');
      await c.b.wait("!document.getElementById('mentionBox').hidden&&document.querySelectorAll('#mentionBox .mnRow').length>0", '原生斜杠菜单');
      const rows = await c.b.read("document.getElementById('mentionBox')._rows.map(r=>({label:r.label,section:r.section}))");
      c.check(rows.length>0, '原生命令列表非空');
      const compact = rows.findIndex(row => /compact|压缩/i.test(row.label));
      c.check(compact >= 0, '菜单含原生 compact 压缩命令');
      if (app === 'opencode') {
        await c.b.click(`#mentionBox [data-mi="${compact}"]`);
        c.equal(await c.b.read('text.value.trim()'), '/compact', '选择命令后保留草稿，等用户提交');
      }
      c.equal(c.b.events.slice(events).filter(event => event.type === 'send' && event.sel?.split('|').at(-1) === target.thread).length,
        0, '只补全没有产生发送'); return { commands: rows };
    } finally { await c.draft(''); }
  } },
];
