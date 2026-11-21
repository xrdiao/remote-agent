import { attr, by } from '../context.mjs';
import { Unavailable } from '../browser.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

async function withTools(c, app, inspect) {
  await c.open(await c.target(app, 'long'));
  const shown = await c.b.read('executionRecordsShown()');
  try {
    if (!shown) { await c.b.menu('executionToggle'); await c.b.dismiss(); }
    return await inspect();
  } finally {
    if (!shown) { await c.b.menu('executionToggle'); await c.b.dismiss(); }
  }
}

export default [
  { id: 'conversation.codex-empty-reasoning', title: '旧 Codex 会话空思考不占首屏名额，正文及历史保持可见', refs: ['F07', 'F18', 'R07'], mode: 'read', apps: ['codex'], async run(c, app) {
    const target = await c.target(app, 'long'); await c.open(target);
    const first = await c.b.read('({items:lastChat.items.map(i=>({id:i.i,k:i.k,text:i.t,order:i.order})),earlier:lastChat.earlier})');
    if (!first.earlier) throw new Unavailable('该原生会话未超出首屏分页范围，需要真实长会话');
    const extra = Math.max(0, first.items.length - 60);
    c.check(first.items.length >= 60 && first.items.slice(0, extra).every(item => item.k === 'human' && item.order === first.items[extra].order),
      '首屏保留 60 条有效内容，以及同一页首轮次的用户消息');
    c.check(first.items.some(item => item.k === 'assistant' && item.text?.trim()), '旧样本首屏有助手正文');
    c.check(!first.items.some(item => item.k === 'thinking' && !item.text?.replace(/^思考\s*/, '').trim()), '空思考未占分页名额');
    await c.b.wait("document.getElementById('items').textContent.trim().length>0", '旧样本正文实际呈现');
    await c.b.click('#older');
    await c.b.wait(`lastChat?.thread===${attr(target.thread)}&&lastChat.items.length>${first.items.length}&&!historyRequest&&!historyRendering`, '旧样本有效历史呈现完成');
    const after = await c.b.read('({ids:lastChat.items.map(i=>i.i),thread:lastChat.thread})');
    c.equal(after.thread, target.thread, '分页不改变所属会话');
    c.equal(new Set(after.ids).size, after.ids.length, '追加历史没有重复条目');
    c.check(after.ids.length > first.items.length, '追加历史包含更早有效内容');
    return { first: first.items.length, after: after.ids.length };
  } },
  { id: 'conversation.tasks', title: '原生任务清单、完成进度及折叠状态', refs: ['F07', 'F18'], mode: 'read', apps: true, async run(c, app) {
    const target = await c.target(app); await c.open(target);
    const task = await c.b.read("lastChat.items.findLast(item=>item.k==='tasks')||null");
    if (!task) throw new Unavailable('当前样本没有原生任务清单，需登记含任务的 A 样本');
    c.equal(task.done, task.items.filter(item => item.status === 'done').length, '进度与任务状态一致');
    c.equal(task.total, task.items.length, '任务总数与清单一致');
    const selector = '#items details' + by('data-task', task.i), original = await c.b.read(`document.querySelector(${attr(selector)}).open`);
    try {
      if (!original) await c.b.click(selector + '>summary');
      c.equal(await c.b.read(`document.querySelector(${attr(selector)}).querySelectorAll('.tlist>li').length`), task.total, '展开显示全部任务项');
      await c.b.home(); await c.open(target);
      await c.b.wait(`document.querySelector(${attr(selector)})?.open`, '任务折叠状态在重新进入后保留');
    } finally { if (!original && await c.b.has(selector + '>summary')) await c.b.click(selector + '>summary'); }
    return { done: task.done, total: task.total };
  } },
  { id: 'conversation.subtasks', title: '子 Agent 执行内容与父会话归属', refs: ['F07', 'F18'], mode: 'read', apps: true, async run(c, app) {
    return withTools(c, app, async () => {
      const parent = await c.b.read('lastChat.thread');
      let tool = await c.b.read("lastChat.items.find(item=>item.children?.length||item.agents?.length||item.childId)||null");
      while (!tool && await c.b.has('#older')) {
        await c.b.click('#older'); await c.b.wait('!historyRequest&&!historyRendering', '查找原生子任务历史页');
        tool = await c.b.read("lastChat.items.find(item=>item.children?.length||item.agents?.length||item.childId)||null");
      }
      if (!tool) throw new Unavailable('当前样本没有子 Agent，需登记包含子任务的 long 样本');
      const row = '#items ' + by('data-i', tool.i);
      if (tool.agents?.length && !tool.children?.length) {
        try {
          await c.b.click(row + ' [data-codex-agent]');
          await c.b.wait(`lastChat.thread===${attr(tool.agents[0].id)}&&!chatStale`, '原生子会话正文');
          c.check(await c.b.read('lastChat.items.length>0'), '子会话确有执行内容');
        } finally { await c.open(await c.target(app, 'long')); }
      } else {
        if (tool.lazy && !tool.details) await c.b.click(row + ' [data-ttoggle]');
        await c.b.wait(`document.querySelector(${attr(row)})?.querySelector('.taskChildren details .msg')`, '原生子 Agent 执行内容');
        await c.b.click(row + ' .taskChildren details>summary');
        c.equal(await c.b.read('lastChat.thread'), parent, '查看内嵌子任务不切换父会话');
      }
      return { parent, tool: tool.i };
    });
  } },
  { id: 'conversation.codex-diff', title: 'Codex 原生修改、新建文件的差异区块和行数', refs: ['F07', 'F10', 'F18'], mode: 'generate', apps: ['codex'], async run(c, app) {
    const target = await c.target(app, 'diff', true), file = path.join(target.root, 'existing.txt'), added = path.join(target.root, 'added.txt');
    const lines = Array.from({ length: 30 }, (_, i) => 'unchanged line ' + i); lines[15] = 'old value';
    await fs.writeFile(file, lines.join('\n') + '\n'); await c.open(target);
    if (await c.b.read("document.getElementById('composerFold').getAttribute('aria-expanded')==='false'")) await c.b.click('#composerFold');
    await c.send(target, '请只用 apply_patch 做两处测试修改：把 existing.txt 的 old value 改成 new value；新建 added.txt，内容严格为 alpha 和 beta 两行，各以换行结束。不要修改其他文件，不要提交。完成后只回复 DIFF_DONE。');
    const expected = [...lines]; expected[15] = 'new value';
    c.equal(await fs.readFile(file, 'utf8'), expected.join('\n') + '\n', '真实旧文件只修改指定行');
    c.equal(await fs.readFile(added, 'utf8'), 'alpha\nbeta\n', '真实新文件有两行');
    const ids = await c.b.read("lastChat.items.filter(i=>i.kind==='edit'&&i.src==='codex').map(i=>i.i)");
    c.check(ids.length>0, '实际出现原生文件修改条目');
    let adds = 0, dels = 0; const paths = new Set();
    for (const id of ids) {
      const row = '#items ' + by('data-i', id); await c.b.click(row + ' [data-ttoggle] .chev');
      const edit = await c.b.wait(`lastChat.items.find(i=>i.i===${attr(id)}&&i.details)||null`, '原生差异详情');
      c.check(edit.add != null && edit.del != null, '差异行数来自真实原生数据');
      c.check(!edit.diff.some(([, text])=>text==='unchanged line 0'||text==='unchanged line 29'), '未展示远处的未改动代码');
      c.check(await c.b.has(row + ' .tdiff'), '真实页面展示差异区块');
      for (const [kind, text] of edit.diff) if (kind==='…'&&/existing\.txt$|added\.txt$/.test(text)) paths.add(path.basename(text));
      adds += edit.add; dels += edit.del; await c.b.click(row + ' [data-ttoggle] .chev');
    }
    c.equal(adds, 3, '合计三行新增'); c.equal(dels, 1, '合计一行删除');
    c.check(paths.has('existing.txt')&&paths.has('added.txt'), '两份文件都有差异详情');
    c.check(await c.b.read('!lastChat.questions?.requests?.length'), '已完成的修改条目没有被误认作待回答问题');
    return { adds, dels, files: [...paths] };
  } },
  { id: 'conversation.body', title: '正文与原生摘要归属一致', refs: ['F07', 'R06', 'F17'], mode: 'read', apps: true, async run(c, app) {
    const target = await c.target(app); const state = await c.open(target), native = await c.preview(target);
    c.equal(state.thread, target.thread, '正文读取正确会话'); c.equal(native.threadId, target.thread, '原生摘要读取同一会话');
    const body = await c.b.read("({items:lastChat.items.length,rendered:document.getElementById('items').textContent.trim().length})");
    if (!body.items) throw new Unavailable('所选会话没有正文，需配置包含消息的 A 样本；空会话不作为正文同步通过');
    c.check(body.rendered > 0, '非空原生会话正文实际渲染'); return body;
  } },
  { id: 'conversation.history', title: '历史分页、消息身份及首屏不变', refs: ['F07', 'F18', 'R07', 'S04'], mode: 'read', apps: true, async run(c, app) {
    const target = await c.target(app, 'long'); await c.open(target);
    if (await c.b.has('#cachedMore')) {
      const ids = "[...document.querySelectorAll('#items > [data-i]')].map(row=>row.dataset.i)";
      const before = await c.b.read(ids);
      await c.b.click('#cachedMore');
      const after = await c.b.wait(`(() => { const ids=${ids}; return ids.length>${before.length}&&!historyRendering?ids:null; })()`, '更早的本地历史呈现');
      c.equal(await c.b.read('lastChat.thread'), target.thread, '本地分页保留原生会话身份');
      c.equal(new Set(after).size, after.length, '本地翻页没有重复条目');
      c.check(before.every(id => after.includes(id)), '本地翻页保留原有消息');
      return { source: 'cached', initial: before.length, after: after.length };
    }
    const before = await c.b.read('({ids:lastChat.items.map(i=>i.i),earlier:lastChat.earlier,cursor:lastChat.historyBefore})');
    if (!await c.b.has('#older')) throw new Unavailable('所选会话没有更早历史；需要 --targets 配置 long 会话');
    const backend = app === 'codex' && await c.b.read("viewSel.startsWith('codex|backend|')");
    const backendWindow = async limit => {
      const opening = await c.b.read(`(() => {
        const items=lastChat.items, start=Math.max(0,items.length-${limit});
        return items.slice(0,start).every(item=>item.k==='human'&&item.order===items[start].order);
      })()`);
      c.check(opening, '超出后台分页预算的记录均为页首轮次的用户消息');
    };
    if (backend) {
      c.check(before.ids.length >= 60, 'Codex 后台首屏包含最近 60 条记录');
      await backendWindow(60);
    }
    await c.b.click('#older');
    await c.b.wait(`!historyRequest&&!historyRendering&&lastChat.items.length > ${before.ids.length}`, '新增历史条目');
    const after = await c.b.read('({ids:lastChat.items.map(i=>i.i),thread:lastChat.thread,cursor:historyCursor})');
    c.equal(after.thread, target.thread, '分页不改变会话'); c.equal(new Set(after.ids).size, after.ids.length, '历史按 ID 去重');
    c.check(after.ids.length > before.ids.length, '加载后确实增加历史条目');
    c.check(before.ids.every(id => after.ids.includes(id)), '分页保留原来尾部消息');
    if (backend) await backendWindow(220);
    return { initial: before.ids.length, after: after.ids.length, cursor: after.cursor };
  } },
  { id: 'conversation.details', title: '工具与文件差异实际展开和收起', refs: ['F07', 'F18', 'R08'], mode: 'read', apps: true, async run(c, app) {
    return withTools(c, app, async () => {
    const selector = '#items [data-ttoggle]';
    if (!await c.b.has(selector)) throw new Unavailable('当前首屏没有可展开的工具，需要含工具的 long 会话');
    const before = await c.b.read("(()=>{const e=document.querySelector('#items [data-ttoggle]').closest('[data-i]');return{id:e.dataset.i,open:e.classList.contains('open')}})()");
    const row = '#items ' + by('data-i', before.id), toggle = row + ' [data-ttoggle] .chev';
    try {
      if (before.open) await c.b.click(toggle);
      c.check(await c.b.read(`!document.querySelector(${attr(row)}).classList.contains('open')`), '指定工具确实处于收起状态');
      await c.b.click(toggle);
      await c.b.wait(`document.querySelector(${attr(row)}).classList.contains('open')&&document.querySelector(${attr(row + ' .tcmd, ' + row + ' .tdiff')})?.textContent.trim().length>0`, '指定工具详情实际加载');
      c.check(await c.b.has(row + ' .tcmd, ' + row + ' .tdiff'), '指定工具展开后的正文可见');
      await c.b.click(toggle);
      c.check(await c.b.read(`!document.querySelector(${attr(row)}).classList.contains('open')`), '指定工具可再次收起');
    } finally {
      if (await c.b.read(`document.querySelector(${attr(row)}).classList.contains('open')`) !== before.open) await c.b.click(toggle);
    }
    return { item: before.id };
    });
  } },
  { id: 'conversation.layout', title: '横竖屏工具与输入区域不越界', refs: ['F07', 'F15', 'R03', 'R08'], mode: 'read', apps: true, async run(c, app) {
    return withTools(c, app, async () => {
    const sizes = [];
    if (!await c.b.has('#items .toolrow')) throw new Unavailable('当前会话没有工具容器，需配置含工具的 long 样本');
    try { for (const [width, height] of [[402, 874], [874, 402]]) {
      await c.b.viewport(width, height);
      await c.b.settled();
      const measured = await c.b.read(`(()=>{const bounds=document.getElementById('items').getBoundingClientRect();return {
        documentOverflow:document.documentElement.scrollWidth-innerWidth,tools:[...document.querySelectorAll('#items .toolrow')].map(e=>({left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right})),
        composer:(()=>{const r=document.getElementById('text').closest('footer').getBoundingClientRect();return{left:r.left,right:r.right}})(),left:bounds.left,right:bounds.right}})()`);
      c.check(measured.documentOverflow <= 1, '页面没有横向溢出');
      c.check(measured.tools.every(tool => tool.left >= measured.left - 1 && tool.right <= measured.right + 1), '工具调用容器位于正文范围');
      c.check(measured.composer.left >= -1 && measured.composer.right <= width + 1, '输入区域位于视口范围');
      sizes.push({ width, height, tools: measured.tools.length });
    } } finally { await c.b.viewport(c.original.width, c.original.height); await c.b.settled(); }
    return { sizes, evidence: 'Chrome 尺寸模拟，非手机安全区验收' };
    });
  } },
  { id: 'conversation.empty-bubbles', title: 'OpenCode 完成后无空助手气泡', refs: ['F17', 'F18', 'R10'], mode: 'read', apps: ['opencode'], async run(c, app) {
    await c.open(await c.target(app));
    const empty = await c.b.read("lastChat.items.filter(i=>i.k==='assistant'&&!i.live&&!i.t?.trim()&&!i.h?.trim()&&!i.images?.length&&!i.b?.length&&!i.actions?.length).map(i=>i.i)");
    c.equal(empty.length, 0, '纯空且已结束的助手条目被排除'); return { empty: empty.length };
  } },
];
