import fs from 'node:fs/promises';
import path from 'node:path';
import { attr, by } from '../context.mjs';
import { Unavailable } from '../browser.mjs';

export default [
  { id: 'composer.drafts', title: '正文和卡片草稿、A/B 隔离', refs: ['F06'], mode: 'write', apps: true, async run(c, app) {
    const a = await c.target(app, 'A', true), b = await c.target(app, 'B', true);
    const av = c.marker + '-A', bv = c.marker + '-B';
    await c.open(a); await c.draft(av); await c.open(b); await c.draft(bv); await c.open(a);
    c.equal(await c.b.read('text.value'), av, '返回 A 保留 A 草稿');
    const card = await c.expand(a); c.equal(await c.b.read(`document.querySelector(${attr(card + ' [data-ov-input]')}).value`), av, '卡片与正文共享同一草稿');
    const edited = av + '-card'; await c.draft(edited, `${card} [data-ov-input]`); await c.open(a);
    c.equal(await c.b.read('text.value'), edited, '卡片编辑同步正文'); await c.draft('');
    await c.open(b); c.equal(await c.b.read('text.value'), bv, '卡片编辑未覆盖 B'); await c.draft('');
    return { a: a.thread, b: b.thread, mirrored: true };
  } },
  { id: 'composer.send', title: '真实发送、回执、草稿清空与重进', refs: ['F06', 'F16', 'F17'], mode: 'generate', apps: true, async run(c, app) {
    const target = await c.target(app, 'A', true); await c.open(target);
    const marker = c.marker + '-SEND-' + app, prompt = `只回复 ${marker}，不读写文件、不运行命令。`;
    const result = await c.send(target, prompt);
    c.equal(result.pending, 0, '发送有确定回执'); c.equal(result.draftLength, 0, '发送成功清空本轮草稿');
    c.check(await c.b.read(`lastChat.items.some(i=>i.k==='assistant'&&i.t?.includes(${attr(marker)}))`), '收到原生回复正文');
    await c.open(target); c.equal(await c.b.read('text.value'), '', '重进没有已发送草稿残留');
    if (await c.b.read("document.getElementById('composerFold').getAttribute('aria-expanded')==='false'")) await c.b.click('#composerFold');
    await c.b.click('#inputPrev'); c.equal(await c.b.read('text.value'), prompt, '输入历史逐字保留已发送原文');
    await c.draft(marker + '-NEXT');
    c.equal(await c.b.read('draftAckRevision'), await c.b.read('draftRevision'), '发送后的下一条草稿获得原生回执');
    await c.draft(''); return result;
  } },
  { id: 'composer.fold', title: '横竖屏输入框折叠保留未发草稿', refs: ['F06', 'F15', 'R03'], mode: 'write', apps: true, async run(c, app) {
    const target = await c.target(app, 'fold', true); await c.open(target);
    const value = c.marker + '-FOLD', sizes = [];
    try { for (const [width, height] of [[402, 874], [874, 402]]) {
      await c.b.viewport(width, height);
      if (await c.b.read("document.getElementById('composerFold').getAttribute('aria-expanded')==='false'")) await c.b.click('#composerFold');
      await c.draft(value); await c.b.click('#composerFold');
      c.equal(await c.b.read("document.getElementById('composerFold').getAttribute('aria-expanded')"), 'false', '手动收起输入框');
      await c.b.click('#composerFold'); c.equal(await c.b.read('text.value'), value, '展开后草稿逐字保留');
      sizes.push({ width, height });
    } } finally {
      if (await c.b.read("document.getElementById('composerFold').getAttribute('aria-expanded')==='false'")) await c.b.click('#composerFold');
      await c.draft(''); await c.b.viewport(c.original.width, c.original.height);
    }
    return { sizes };
  } },
  { id: 'composer.card-send', title: '卡片发送使用同一回执并进入正文', refs: ['F03', 'F06'], mode: 'generate', apps: true, async run(c, app) {
    const target = await c.target(app, 'A', true), card = await c.expand(target);
    const marker = c.marker + '-CARD-' + app;
    await c.draft(`只回复 ${marker}，不要运行工具。`, `${card} [data-ov-input]`);
    await c.b.click(`${card} [data-ov="send"]`);
    await c.b.wait(`pendingSends.size===0&&lastChat?.thread===${attr(target.thread)}&&lastChat.items.some(i=>i.k==='human'&&i.t?.includes(${attr(marker)}))`, '卡片原生接受', c.options.timeout);
    c.equal(await c.b.read(`document.querySelector(${attr(card + ' [data-ov-input]')}).value`), '', '卡片发送清空自己的草稿');
    await c.open(target); c.check(await c.b.read(`lastChat.items.some(i=>i.k==='human'&&i.t?.includes(${attr(marker)}))`), '正文出现同一条原生消息');
    await c.b.wait('!lastChat.busy', '卡片生成结束', c.options.generationTimeout); return { thread: target.thread };
  } },
  { id: 'composer.long-history', title: '长文本发送与输入历史不增加斜杠', refs: ['F06', 'F07'], mode: 'generate', apps: ['codex'], async run(c, app) {
    const target = await c.target(app, 'A', true); await c.open(target);
    const value = c.marker + '\n' + '这是用于核对长文本的测试数据，不需要执行。\n'.repeat(150) + '只回复 RECEIVED';
    await c.send(target, value); await c.b.click('#inputPrev');
    c.equal(await c.b.read('text.value'), value, '取回的长文本和原输入逐字相同');
    c.check(await c.b.read(`lastChat.items.some(i=>i.k==='human'&&i.t?.trim()===${attr(value.trim())})`), '原生正文未追加斜杠或换行转义');
    await c.draft(''); return { characters: value.length };
  } },
  { id: 'composer.image-only', title: '纯图片发送有缩略图和确定回执', refs: ['F06', 'F11', 'R10'], mode: 'generate', apps: true, async run(c, app) {
    const target = await c.target(app, 'A', true); await c.open(target); await c.draft('');
    const image = path.resolve(c.directory, 'pixel.png');
    await fs.writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
    await c.b.files('#imgFile', [image]);
    await c.b.wait('desktopAttachments.length>0&&desktopAttachments.every(f=>!f.pending)', '原生图片附加');
    c.check(await c.b.read("document.querySelectorAll('#attachments img').length>0"), '发送前显示真实图片缩略图');
    const result = await c.send(target, '', { complete: true });
    c.equal(result.draftLength, 0, '纯图完成后无草稿残留');
    c.check(await c.b.read("lastChat.items.some(i=>i.k==='human'&&i.images?.length)"), '原生用户消息保留图片'); return result;
  } },
  { id: 'composer.queue', title: '排队、编辑和删除', refs: ['F06'], mode: 'generate', apps: ['codex', 'cursor', 'devin'], async run(c, app) {
    const target = await c.target(app, 'queue', true); await c.open(target);
    await c.send(target, `仅在当前测试项目运行一条等待约 20 秒再输出 ${c.marker} 的命令，不修改任何文件。`, { complete: false });
    if (!await c.b.read("lastChat.busy&&document.getElementById('send').textContent.includes('排队')"))
      throw new Unavailable('原生生成已结束或当前不提供排队窗口；没有制造假排队');
    const marker = c.marker + '-QUEUED'; await c.draft(`只回复 ${marker}`); await c.b.click('#send');
    const queued = await c.b.wait(`lastChat.queued?.find(q=>q.t?.includes(${attr(marker)}))||null`, '原生队列接受');
    const draft = app === 'codex' ? c.marker + '-UNSENT-DRAFT' : '';
    if (draft) await c.draft(draft);
    if (!await c.b.has(`#queueBar ${by('data-q', queued.id)}[data-a="edit"]`)) await c.b.click('#queueBar [data-qfold]');
    await c.b.click(`#queueBar ${by('data-q', queued.id)}[data-a="edit"]`);
    if (app === 'devin') {
      await c.b.wait(`text.value.includes(${attr(marker)})&&!lastChat.queued?.some(q=>q.id===${attr(queued.id)})`, 'Devin 原生取回');
      c.check(await c.b.read("document.getElementById('msg').textContent.includes('取回')"), 'Devin 提示取回而非仍已排队');
      c.check(await c.b.read(`text.value.includes(${attr(marker)})`), '取回输入框后明确需要重新发送'); await c.draft('');
    } else {
      await c.b.wait("!document.getElementById('qEdit').disabled", '完整队列内容');
      await c.b.fill('#qEdit', `只回复 ${marker}-EDIT`); await c.b.click('#qSave');
      await c.b.wait(`lastChat.queued?.some(q=>q.id===${attr(queued.id)}&&q.t?.includes('-EDIT'))`, '原生队列修改');
      c.check(await c.b.read(`lastChat.queued.some(q=>q.id===${attr(queued.id)})`), '修改保持原队列身份');
      if (draft) c.equal(await c.b.read('text.value'), draft, '原位修改队列不覆盖正文草稿');
      await c.b.dismiss(); await c.b.click(`#queueBar ${by('data-q', queued.id)}[data-a="remove"]`);
      if (await c.b.has('#askOk')) await c.b.click('#askOk');
      await c.b.wait(`!lastChat.queued?.some(q=>q.id===${attr(queued.id)})`, '队列删除确认');
    }
    if (draft) await c.draft('');
    await c.b.dismiss(); await c.b.wait('!lastChat.busy', '原执行结束', c.options.generationTimeout);
    c.check(await c.b.read(`!lastChat.items.some(i=>i.k==='human'&&i.t?.includes(${attr(marker)}))`), '删除或取回的队列未误执行');
    return { queue: queued.id, action: app === 'devin' ? 'take-out' : 'edit-remove' };
  } },
  { id: 'composer.ime', title: '真实手机组合输入与软键盘', refs: ['F06', 'F15'], mode: 'manual',
    reason: 'Chrome 自动输入不能替代手机中文输入法、回车和系统软键盘。' },
];
