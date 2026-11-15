import { attr, by } from '../context.mjs';
import { Unavailable } from '../browser.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

export default [
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
      const row = '#items ' + by('data-i', id); await c.b.click(row + ' [data-ttoggle]');
      const edit = await c.b.wait(`lastChat.items.find(i=>i.i===${attr(id)}&&i.details)||null`, '原生差异详情');
      c.check(edit.add != null && edit.del != null, '差异行数来自真实原生数据');
      c.check(!edit.diff.some(([, text])=>text==='unchanged line 0'||text==='unchanged line 29'), '未展示远处的未改动代码');
      c.check(await c.b.has(row + ' .tdiff'), '真实页面展示差异区块');
      for (const [kind, text] of edit.diff) if (kind==='…'&&/existing\.txt$|added\.txt$/.test(text)) paths.add(path.basename(text));
      adds += edit.add; dels += edit.del; await c.b.click(row + ' [data-ttoggle]');
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
    c.check(body.items === 0 || body.rendered > 0, '有原生条目时正文不是空白'); return body;
  } },
  { id: 'conversation.history', title: '历史分页、消息身份及首屏不变', refs: ['F07', 'F18', 'R07', 'S04'], mode: 'read', apps: true, async run(c, app) {
    const target = await c.target(app, 'long'); await c.open(target);
    const before = await c.b.read('({ids:lastChat.items.map(i=>i.i),earlier:lastChat.earlier,cursor:lastChat.historyBefore})');
    if (!await c.b.has('#older')) throw new Unavailable('所选会话没有更早历史；需要 --targets 配置 long 会话');
    const backend = app === 'codex' && await c.b.read("viewSel.startsWith('codex|backend|')");
    if (backend) c.equal(before.ids.length, 40, 'Codex 后台首屏保持 40 项');
    await c.b.click('#older'); await c.b.wait('!historyRequest&&!historyRendering', '历史分页');
    const after = await c.b.read('({ids:lastChat.items.map(i=>i.i),thread:lastChat.thread,cursor:historyCursor})');
    c.equal(after.thread, target.thread, '分页不改变会话'); c.equal(new Set(after.ids).size, after.ids.length, '历史按 ID 去重');
    c.check(after.ids.length > before.ids.length, '加载后确实增加历史条目');
    c.check(before.ids.every(id => after.ids.includes(id)), '分页保留原来尾部消息');
    if (backend) c.check(after.ids.length <= before.ids.length + 160, 'Codex 后台一次追加不超过 160 项');
    return { initial: before.ids.length, after: after.ids.length, cursor: after.cursor };
  } },
  { id: 'conversation.details', title: '工具与文件差异实际展开和收起', refs: ['F07', 'F18', 'R08'], mode: 'read', apps: true, async run(c, app) {
    await c.open(await c.target(app, 'long'));
    const selector = '#items [data-ttoggle]';
    if (!await c.b.has(selector)) throw new Unavailable('当前首屏没有可展开的工具，需要含工具的 long 会话');
    const before = await c.b.read("(()=>{const e=document.querySelector('#items [data-ttoggle]').closest('[data-i]');return{id:e.dataset.i,open:e.classList.contains('open')}})()");
    const row = '#items ' + by('data-i', before.id), toggle = row + ' [data-ttoggle]';
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
  } },
  { id: 'conversation.layout', title: '横竖屏工具与输入区域不越界', refs: ['F07', 'F15', 'R03', 'R08'], mode: 'read', apps: true, async run(c, app) {
    await c.open(await c.target(app, 'long')); const sizes = [];
    if (!await c.b.has('#items .toolrow')) throw new Unavailable('当前会话没有工具容器，需配置含工具的 long 样本');
    try { for (const [width, height] of [[402, 874], [874, 402]]) {
      await c.b.viewport(width, height);
      const measured = await c.b.read(`(()=>{const bounds=document.getElementById('items').getBoundingClientRect();return {
        documentOverflow:document.documentElement.scrollWidth-innerWidth,tools:[...document.querySelectorAll('#items .toolrow')].map(e=>({left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right})),
        composer:(()=>{const r=document.getElementById('text').closest('footer').getBoundingClientRect();return{left:r.left,right:r.right}})(),left:bounds.left,right:bounds.right}})()`);
      c.check(measured.documentOverflow <= 1, '页面没有横向溢出');
      c.check(measured.tools.every(tool => tool.left >= measured.left - 1 && tool.right <= measured.right + 1), '工具调用容器位于正文范围');
      c.check(measured.composer.left >= -1 && measured.composer.right <= width + 1, '输入区域位于视口范围');
      sizes.push({ width, height, tools: measured.tools.length });
    } } finally { await c.b.viewport(c.original.width, c.original.height); }
    return { sizes, evidence: 'Chrome 尺寸模拟，非手机安全区验收' };
  } },
  { id: 'conversation.empty-bubbles', title: 'OpenCode 完成后无空助手气泡', refs: ['F17', 'F18', 'R10'], mode: 'read', apps: ['opencode'], async run(c, app) {
    await c.open(await c.target(app));
    const empty = await c.b.read("lastChat.items.filter(i=>i.k==='assistant'&&!i.live&&!i.t?.trim()&&!i.h?.trim()&&!i.images?.length&&!i.b?.length&&!i.actions?.length).map(i=>i.i)");
    c.equal(empty.length, 0, '纯空且已结束的助手条目被排除'); return { empty: empty.length };
  } },
];
