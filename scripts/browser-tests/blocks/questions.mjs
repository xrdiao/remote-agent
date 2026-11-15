import { attr } from '../context.mjs';
import { Unavailable } from '../browser.mjs';

export default [
  { id: 'questions.answer', title: '真实问题、切换保留和回答', refs: ['F09', 'X06'], mode: 'generate', apps: true, async run(c, app) {
    const a = await c.target(app, 'questions', true), b = await c.target(app, 'B', true); await c.open(a);
    if (app === 'codex' && await c.b.has('#pickPlan') && !await c.b.read('lastChat.codex?.plan')) {
      await c.b.click('#pickPlan'); await c.b.wait('lastChat.codex?.plan===true', '原生计划模式回执');
    }
    await c.send(a, `请使用提问工具问一个问题：${c.marker} 选择哪个测试值？选项为 QA_ONE 和 QA_TWO。只提问并等待，不执行工具或修改文件。`, { complete: false });
    try { await c.b.wait("!!(lastChat.questions?.requests?.length||lastChat.questions?.list?.length||lastChat.items.some(i=>i.k==='opencodeQuestion'))", '原生问题', c.options.generationTimeout); }
    catch { throw new Unavailable('模型没有产生原生问题；普通文本问句不能计为问题卡片通过'); }
    const draft = '#qnBar input[data-request^="async:"][data-field]:not([type="password"]):not(:disabled)';
    const edited = await c.b.has(draft);
    if (edited) await c.b.fill(draft, 'QA_ONE');
    const identity = "JSON.stringify(lastChat.questions?.requests?.map(r=>r.id)||lastChat.questions?.list?.map(r=>r.question)||lastChat.items.filter(i=>i.k==='opencodeQuestion').map(i=>i.requestID))";
    const before = await c.b.read(identity);
    await c.open(b); await c.open(a);
    c.equal(await c.b.read(identity), before, 'A 的问题身份没有被 B 替换');
    if (edited) c.equal(await c.b.read(`document.querySelector(${attr(draft)}).value`), 'QA_ONE', '返回后保留本轮问题的未发答案');
    if (await c.b.has('#qnBar [data-request][data-action="0"]')) {
      const request = await c.b.read("document.querySelector('#qnBar [data-request][data-action]').dataset.request");
      await c.b.click('#qnBar [data-request][data-action="0"]');
      if (request.startsWith('async:')) {
        const submit = await c.b.read(`[...document.querySelectorAll('#qnBar [data-request][data-action]')].filter(e=>e.dataset.request===${attr(request)}&&!e.disabled).at(-1)?.dataset.action`);
        if (submit != null) await c.b.click(`#qnBar [data-request=${attr(request)}][data-action=${attr(submit)}]`);
      }
      await c.b.wait('!questionSubmissions.size', '原生回答回执', c.options.timeout);
      c.check(await c.b.read('!lastChat.questions?.requests?.length'), '原生问题回答后移除');
    } else if (await c.b.has('#qnBar [data-qi][data-oi]')) {
      const count = await c.b.read('lastChat.questions.list.length');
      for (let i = 0; i < count; i++) await c.b.click(`#qnBar button[data-qi="${i}"][data-oi="0"]`);
      if (await c.b.has('#qnBar [data-qpart="submit"]')) await c.b.click('#qnBar [data-qpart="submit"]');
      await c.b.wait('!lastChat.questions?.list?.length&&!questionSubmissions.size', '原生选项提交回执');
      c.check(await c.b.read('!lastChat.questions?.list?.length'), '原生问题已经提交');
    } else if (app === 'opencode' && await c.b.has('[data-opencode-question]')) {
      const request = await c.b.read("document.querySelector('[data-opencode-question]').dataset.opencodeQuestion");
      const count = await c.b.read("document.querySelectorAll('[data-opencode-question] fieldset').length");
      for (let i = 0; i < count; i++) await c.b.click(`[data-opencode-question] fieldset:nth-of-type(${i + 1}) input[type="radio"], [data-opencode-question] fieldset:nth-of-type(${i + 1}) input[type="checkbox"]`);
      await c.b.click('[data-opencode-question] button[type="submit"]:not([name])');
      await c.b.wait(`!openCodeQuestionSubmissions.size&&!lastChat.items.some(i=>i.k==='opencodeQuestion'&&i.requestID===${attr(request)})`, 'OpenCode 问题回执');
      c.check(!await c.b.has(`[data-opencode-question=${attr(request)}]`), 'OpenCode 原生问题回答后移除');
    } else throw new Unavailable('当前原生问题不使用已实现的单选或 OpenCode 问卷入口，需补充该软件真实问卷样本');
    return { thread: a.thread, answer: 'QA_ONE', textDraftExercised: edited };
  } },
  { id: 'questions.approval', title: '原生审批、过期操作及折叠问题', refs: ['F09', 'M07'], mode: 'manual',
    reason: '需对应软件的真实待审批或折叠请求；不能用伪造弹窗或自动批准用户任务替代。' },
  { id: 'questions.retry', title: '原生容量不足与手动重试', refs: ['F09'], mode: 'manual',
    reason: '需原生真实容量错误；不重复生成制造容量限制。' },
];
