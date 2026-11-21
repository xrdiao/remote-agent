import fs from 'node:fs/promises';
import path from 'node:path';
import { attr, by } from '../context.mjs';
import { Unavailable } from '../browser.mjs';
import { Cdp } from '../../../server/cdp.mjs';
import { codexWindows } from '../../../server/windows.mjs';
import { CODEX_CDP_URL } from '../../../server/config.mjs';
import { PAGE_SRC, helpersCall } from '../../../server/page/build.mjs';
import { CodexClient } from '../../../server/codex/client.mjs';

export default [
  { id: 'composer.codex-writer', title: '桌面进程持有会话时手机使用同一写入者发送', refs: ['F06', 'F16', 'F17'], mode: 'generate', apps: ['codex'], async run(c, app) {
    const writerWindow = c.options.targets?.codex?.writerWindow;
    const page = (await codexWindows(CODEX_CDP_URL)).find(page => page.chatWs && (!writerWindow || page.pageId === writerWindow));
    if (!page) throw new Unavailable('此场景需要已打开的 Codex 桌面窗口');
    const target = await c.target(app, 'writer', true), native = new Cdp(page.chatWs);
    await native.connect();
    const original = await native.evaluate(helpersCall('codexThread()'));
    try {
      await c.b.home();
      const prefix = PAGE_SRC.slice(0, PAGE_SRC.lastIndexOf('  return { historyAtStart'));
      const owner = await native.evaluate(prefix + `return (async()=>{
        const manager=codexConversationManager(${attr(target.thread)},codexHistoryScopes(),'local');
        await manager.resumeConversation(nativeValue({conversationId:${attr(target.thread)},model:null,reasoningEffort:null,workspaceRoots:[${attr(target.root)}],collaborationMode:null}));
        return nativeSessionInfo('codex',${attr(target.thread)},'connection');
      })();})()`);
      c.check(owner?.loaded, '原生 app-server 确实已加载该测试会话');
      await c.open(target);
      const marker = c.marker + '-WRITER', receipt = await c.send(target, `只回复 ${marker}，不要读写文件或运行工具。`);
      c.equal(receipt.pending, 0, '桌面持有时手机收到确定发送回执');
      c.equal(receipt.draftLength, 0, '发送成功清空手机草稿');
      c.check(await c.b.read(`lastChat.items.some(item=>item.k==='assistant'&&item.t?.includes(${attr(marker)}))`), '同一原生会话返回真实回复');
      const permissions = await c.menu('permission'), originalPermission = permissions.find(row => row.checked);
      c.check(!!originalPermission, '桌面原生权限菜单有当前选项');
      for (const label of ['Ask for approval', 'Approve for me', 'Full access', originalPermission.label]) {
        await c.b.click(`#sheet [data-kind="permission"]${by('data-label', label)}`);
        await c.b.wait('!menuPending', '桌面权限变更回执');
        if (label === 'Full access') {
          const request = await c.b.wait("lastChat.questions?.requests?.find(request=>request.id.startsWith('dialog:')&&/Full Access|完全访问/.test(request.text))", '原生完全访问确认卡片');
          const confirm = request.buttons.findIndex(button => /^(Confirm|确认)$/.test(button.label));
          c.check(confirm >= 0, '原生完全访问确认操作可见');
          await c.b.click(`#qnBar [data-request=${attr(request.id)}][data-action="${confirm}"]`);
          await c.b.wait(`!questionSubmissions.size&&!lastChat.questions?.requests?.some(row=>row.id===${attr(request.id)})`, '完全访问原生确认回执');
        }
        const actual = await c.menu('permission');
        c.check(actual.some(row => row.label === label && row.checked), '桌面写入者权限可切换：' + label);
      }
      await c.b.dismiss();
      const title = c.marker + '-DESKTOP-WRITER', card = await c.reveal(target);
      await c.b.hold(`${card} .ov-title`);
      await c.b.dialog(title, () => c.b.click('#sheet [data-agent-action="rename"]'));
      await c.b.wait(`ovRecs().some(row=>row.app==='codex'&&row.threadId===${attr(target.thread)}&&row.title===${attr(title)})`, '桌面写入者重命名回执');
      c.check((await c.overview()).sessions.some(row => row.threadId === target.thread && row.title === title), '重命名到达实际桌面写入者');
      return { thread: target.thread, nativeLoaded: owner.loaded, role: owner.role };
    } finally {
      if (original && await native.evaluate(helpersCall('codexThread()')) !== original) await native.evaluate(helpersCall(`openCodexThread(${attr(original)})`));
      native.close();
    }
  } },
  { id: 'composer.codex-release', title: '父子会话完成后释放写入权，退出 RA 后可被另一原生进程接管', refs: ['F06', 'F08', 'F17', 'S06'], mode: 'generate', apps: ['codex'], async run(c, app) {
    const target = await c.target(app, 'release', true); await c.open(target);
    await c.send(target, '这是会话释放验收。请用 spawn_agent 创建一个子 Agent，让它只回复 CHILD_DONE，不运行命令或修改文件；用 wait 等待它完成，不调用 close_agent；你最后只回复 PARENT_DONE。');
    const probe = new CodexClient();
    let owned, timer;
    try {
      await probe.connect();
      const { thread } = await probe.request('thread/read', { threadId: target.thread, includeTurns: true });
      const children = [...new Set(thread.turns.flatMap(turn => turn.items).filter(item => item.type === 'collabAgentToolCall').flatMap(item => item.receiverThreadIds))];
      c.check(children.length > 0, '实际生成了原生子 Agent');
      c.check(!thread.turns.some(turn => turn.status === 'inProgress'), '父会话已完成');
      await c.b.home();
      const releasedAfterMs = {};
      for (const id of [...children, target.thread]) {
        const started = Date.now(), deadline = started + c.options.timeout;
        let resumed;
        while (!resumed) {
          try { resumed = await probe.request('thread/resume', { threadId: id }); }
          catch (error) {
            if (!/already has an active writer/.test(error.message) || Date.now() >= deadline) throw error;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
        owned = id; releasedAfterMs[id] = Date.now() - started;
        c.equal(resumed.thread.id, id, '另一原生进程实际取得写入权：' + id);
        const closed = new Promise((resolve, reject) => {
          const changed = packet => { if (packet.method === 'thread/closed' && packet.params.threadId === id) { probe.off('notification', changed); resolve(); } };
          probe.on('notification', changed);
          timer = setTimeout(() => { probe.off('notification', changed); reject(new Error('接管验收进程未收到原生关闭确认')); }, c.options.timeout);
        });
        await probe.request('thread/unsubscribe', { threadId: id }); await closed; clearTimeout(timer); owned = null;
      }
      await c.open(target);
      const choices = await c.menu('permission');
      c.check(choices.length === 3, '接管并释放后，RA 权限菜单仍完整'); await c.b.dismiss();
      return { thread: target.thread, children, writerReleased: true, releasedAfterMs };
    } finally {
      clearTimeout(timer);
      if (owned) await probe.request('thread/unsubscribe', { threadId: owned });
      probe.close();
    }
  } },
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
    const reply = await c.b.wait(`lastChat.items.some(i=>i.k==='assistant'&&i.t?.includes(${attr(marker)}))`, '收到原生回复正文', c.options.generationTimeout);
    c.check(reply, '收到原生回复正文');
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
    const target = await c.target(app, 'A', true);
    if (c.options.targets?.[app]?.model) { await c.open(target); await c.selectSendModel(target); }
    const card = await c.expand(target), events = c.b.events.length;
    const marker = c.marker + '-CARD-' + app;
    await c.draft(`只回复 ${marker}，不要运行工具。`, `${card} [data-ov-input]`);
    await c.b.click(`${card} [data-ov="send"]`);
    const send = await c.b.wait(() => c.b.events.slice(events).find(event => event.type === 'send'), '卡片发送请求');
    await c.b.wait(`!pendingSends.has(${attr(send.requestId)})&&lastChat?.thread===${attr(target.thread)}&&lastChat.items.some(i=>i.k==='human'&&i.t?.includes(${attr(marker)}))`, '卡片原生接受', c.options.timeout);
    c.equal(await c.b.read(`document.querySelector(${attr(card + ' [data-ov-input]')}).value`), '', '卡片发送清空自己的草稿');
    await c.open(target); c.check(await c.b.read(`lastChat.items.some(i=>i.k==='human'&&i.t?.includes(${attr(marker)}))`), '正文出现同一条原生消息');
    await c.b.wait('!lastChat.busy', '卡片生成结束', c.options.generationTimeout); return { thread: target.thread };
  } },
  { id: 'composer.long-history', title: '长文本发送与输入历史不增加斜杠', refs: ['F06', 'F07'], mode: 'generate', apps: ['codex'], async run(c, app) {
    const target = await c.target(app, 'A', true); await c.open(target);
    const value = c.marker + '\n' + '这是用于核对长文本的测试数据，不需要执行。\n'.repeat(150) + '只回复 RECEIVED';
    await c.send(target, value);
    if (await c.b.read("document.getElementById('composerFold').getAttribute('aria-expanded')==='false'")) await c.b.click('#composerFold');
    await c.b.wait('!document.getElementById("inputPrev").hidden', '原生输入历史已出现');
    await c.b.click('#inputPrev');
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
    await c.b.dismiss(); await c.finishGeneration(target, '原执行结束');
    c.check(await c.b.read(`!lastChat.items.some(i=>i.k==='human'&&i.t?.includes(${attr(marker)}))`), '删除或取回的队列未误执行');
    return { queue: queued.id, action: app === 'devin' ? 'take-out' : 'edit-remove' };
  } },
  { id: 'composer.ime', title: '真实手机组合输入与软键盘', refs: ['F06', 'F15'], mode: 'manual',
    reason: 'Chrome 自动输入不能替代手机中文输入法、回车和系统软键盘。' },
];
