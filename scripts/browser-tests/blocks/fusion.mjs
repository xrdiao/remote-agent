import fs from 'node:fs/promises';
import path from 'node:path';
import { attr, by } from '../context.mjs';
import { Unavailable } from '../browser.mjs';
async function current(c, id) {
  return c.b.read(`fusionWorkspaces.get(${attr(c.computer)})?.runs.find(r=>r.id===${attr(id)})||null`);
}
async function overview(c) {
  await c.b.home(); await c.b.click('#ovTabs [data-v="sessions"]');
}
async function open(c, run) {
  await c.b.home(); await c.b.click('#ovTabs [data-v="fusion"]');
  await c.b.click(`[data-fusion-open=${attr(run.id)}]${by('data-computer', c.computer)}`);
  await c.b.wait(`windowReady&&currentFusionRun()?.id===${attr(run.id)}&&lastChat?.thread===${attr(run.thread)}`, 'Fusion 主会话首屏');
}
async function openTasks(c, run) {
  const header = '#fusionHeader [data-fusion-relations]';
  await c.b.click(await c.b.has(header) ? header : '#fusionTasks');
  await c.b.wait(`fusionViewOwner?.runId===${attr(run.id)}&&fusionViewOwner.kind==='tasks'`, '关系面板身份');
}
async function create(c) {
  if (c.fusion.length) {
    // A previous test can register a QA resource before native preparation.
    // Never treat an incomplete binding as a reusable runnable workspace.
    if (!c.fusion[0].thread) throw new Unavailable('上一个 Fusion QA 工作台的原生准备未完成，后续场景不应继续发送');
    return c.fusion[0];
  }
  const b = c.b, app = c.options.fusionApp, root = path.resolve(c.directory, 'projects', 'fusion');
  await fs.mkdir(root, { recursive: true }); await b.home(); await b.click('#ovTabs [data-v="fusion"]');
  const choices = await b.read(`fusionWorkspaces.get(${attr(c.computer)})?.apps||[]`);
  if (!choices.some(row => row.app === app && row.controller && row.connected !== false))
    throw new Unavailable(`Fusion ${app} 主 Agent 未连接或不具备控制能力`);
  const before = await b.read(`(fusionWorkspaces.get(${attr(c.computer)})?.runs||[]).map(r=>r.id)`);
  await b.click(`[data-fusion-new]${by('data-computer', c.computer)}`);
  await b.select('#fusionNewForm [name="app"]', app); await b.click('#fusionNewForm [type="submit"]');
  await b.click('#sheet [data-project-path]'); await b.fill('#computerFilePath', root);
  await b.click('#computerFilePathForm button[type="submit"]');
  await b.wait(`computerFiles?.directory?.path===${attr(root.replaceAll(path.sep, '/'))}`, 'Fusion 测试项目');
  await b.click('[data-computer-project="open"]');
  const found = await b.wait(`fusionWorkspaces.get(${attr(c.computer)})?.runs.find(r=>!${JSON.stringify(before)}.includes(r.id))||null`, '工作台创建');
  const run = { id: found.id, app, root, thread: found.main?.target?.threadId || '' };
  c.fusion.push(run); await c.persistResources();
  await b.wait("!!document.getElementById('fusionConfigForm')", '工作台设置');
  // fusionCreated may arrive before asynchronous project preparation starts.
  // Observe the native model catalog or a real error, not the transient !preparing state.
  const prepareState = await b.wait(`(()=>{
    const r=fusionStates.get(fusionViewKey(${attr(c.computer)},${attr(run.id)},{kind:'config'}));
    if (!r) return null;
    if (!r.main.preparing && r.main.error) return {error:r.main.error};
    const models=(r.capabilities||[]).find(v=>v.app===${attr(app)})?.models||[];
    return !r.main.preparing && models.length &&
      document.querySelector('#fusionConfigForm [name="model"] option:not([value=""])')
      ? {ready:true,count:models.length} : null;
  })()`, '原生项目准备和主模型目录', 55000);
  if (prepareState.error) throw new Error('原生主控准备失败：' + prepareState.error);
  if (await b.has('[data-fusion-trust]')) {
    await b.click('[data-fusion-trust]'); await b.click('[data-project-trust="yes"]');
  }
  const preparation = await current(c, run.id);
  if (preparation.main.error) throw new Error(preparation.main.error);
  const model = await b.read(app === 'devin'
    ? "[...document.querySelector('#fusionConfigForm [name=model]').options].find(o=>/^swe-2-(flash-)?(high|medium|max)$/.test(o.value)&&!o.disabled)?.value"
    : "document.querySelector('#fusionConfigForm [name=model]')?.options[1]?.value");
  if (app === 'devin' && !model) throw new Unavailable('Devin 原生模型列表没有可以验收的免费 SWE-2');
  if (model) await b.select('#fusionConfigForm [name="model"]', model);
  const effort = await b.read("document.querySelector('#fusionConfigForm [name=effort]')?.options[1]?.value");
  if (effort) await b.select('#fusionConfigForm [name="effort"]', effort);
  if (!(await current(c, run.id)).main.bindingId) await b.click('#fusionConfigForm [type="submit"]');
  const enabled = await b.wait(`(()=>{const r=fusionWorkspaces.get(${attr(c.computer)})?.runs.find(r=>r.id===${attr(run.id)});return r?.main.bindingId&&r.main.target?.threadId?r:null})()`, '主会话绑定');
  run.thread = enabled.main.target.threadId; run.window = enabled.main.target.windowId;
  await c.persistResources(); await b.dismiss(); return run;
}

export default [
  { id: 'fusion.catalog', title: '工作台目录、主 Agent 能力和卡片身份', refs: ['F19', 'X01', 'X02'], mode: 'read', async run(c) {
    await c.b.home(); await c.b.click('#ovTabs [data-v="fusion"]');
    const workspace = await c.b.read(`fusionWorkspaces.get(${attr(c.computer)})||null`);
    c.check(!!workspace, '执行电脑返回 Fusion 工作区');
    c.check(Array.isArray(workspace.runs) && Array.isArray(workspace.apps), '工作台列表与应用能力完整');
    const ids = workspace.runs.map(row => row.id); c.equal(new Set(ids).size, ids.length, '工作台身份没有重复');
    for (const run of workspace.runs.filter(r => r.main.bindingId)) {
      c.check(!!run.main.target?.threadId, '绑定后的工作台返回真实主会话导航目标');
      c.check(!!run.main.target?.windowId, '主会话包含路由窗口身份');
    }
    await overview(c);
    return { runs: ids.length, controllers: workspace.apps.filter(r => r.controller).map(r => r.app), availability: workspace.apps.map(r => ({ app: r.app, controller: r.controller, connected: r.connected, reason: r.reason || '' })) };
  } },
  { id: 'fusion.create', title: '独立项目启用并打开主工作台', refs: ['F19', 'X01', 'X02'], mode: 'write', async run(c) {
    const run = await create(c); await open(c, run);
    c.equal(await c.b.read('lastChat.thread'), run.thread, '导航使用真实主会话身份');
    const value = await current(c, run.id);
    c.equal(path.resolve(value.project.root), run.root, '工作台项目归属正确');
    return { id: run.id, app: run.app, thread: run.thread };
  } },
  { id: 'fusion.navigation', title: '工作台→普通会话→工作台与关系面板', refs: ['F19', 'R04', 'X02', 'X08', 'X11'], mode: 'write', async run(c) {
    const run = await create(c);
    await overview(c);
    const normal = await c.target(run.app, 'A', true);
    await open(c, run); await openTasks(c, run);
    c.equal(await c.b.read('currentFusionRun().id'), run.id, '关系面板绑定同一工作台');
    await overview(c);
    await c.open(normal); c.check(await c.b.read('!currentFusionRun()'), '普通会话没有残留工作台身份');
    await open(c, run); c.equal(await c.b.read('lastChat.thread'), run.thread, '重回工作台不是管理 ID 或普通会话');
    return { run: run.id, normal: normal.thread };
  } },
  { id: 'fusion.management', title: '工作台重命名、收藏及恢复不改变任务进度', refs: ['F05', 'F19', 'X11'], mode: 'write', async run(c) {
    const run = await create(c), before = await current(c, run.id), title = 'QA workbench ' + Date.now();
    const card = `[data-fusion-open=${attr(run.id)}]${by('data-computer', c.computer)}`;
    const menu = async () => {
      await c.b.home(); await c.b.click('#ovTabs [data-v="fusion"]');
      await c.b.hold(card); await c.b.wait("sheetKind==='agent-actions'", '工作台管理菜单');
    };
    try {
      await menu(); await c.b.dialog(title, () => c.b.click('#sheet [data-agent-action="rename"]'));
      await c.b.wait(`fusionWorkspaces.get(${attr(c.computer)})?.runs.find(r=>r.id===${attr(run.id)})?.title===${attr(title)}`, '工作台原生重命名回执');
      c.equal((await current(c, run.id)).title, title, '工作台显示已确认的新名称');
      await menu(); await c.b.click('#sheet [data-agent-action="favorite"]');
      await c.b.wait(`!!fusionWorkspaces.get(${attr(c.computer)})?.runs.find(r=>r.id===${attr(run.id)})?.favorite===${!before.favorite}`, '工作台收藏回执');
      c.equal((await current(c, run.id)).tasks.total, before.tasks.total, '管理操作没有创建或删除任务');
    } finally {
      if (!!(await current(c, run.id)).favorite !== !!before.favorite) {
        await menu(); await c.b.click('#sheet [data-agent-action="favorite"]');
        await c.b.wait(`!!fusionWorkspaces.get(${attr(c.computer)})?.runs.find(r=>r.id===${attr(run.id)})?.favorite===${!!before.favorite}`, '工作台恢复原收藏状态');
      }
      if ((await current(c, run.id)).title !== before.title) {
        await menu(); await c.b.dialog(before.title, () => c.b.click('#sheet [data-agent-action="rename"]'));
        await c.b.wait(`fusionWorkspaces.get(${attr(c.computer)})?.runs.find(r=>r.id===${attr(run.id)})?.title===${attr(before.title)}`, '工作台恢复原名称');
      }
      await c.b.dismiss();
    }
    return { id: run.id, restored: true };
  } },
  { id: 'fusion.main-direct', title: '主 Agent 直接回复及主模型统计', refs: ['F19', 'R11', 'X03', 'X09'], mode: 'generate', async run(c) {
    const run = await create(c); await open(c, run);
    const before = (await current(c, run.id)).tasks.total;
    const marker = c.marker + '-FUSION-MAIN';
    // A submitted native user message may briefly display busy=false before
    // the real Agent turn starts. Only the NEW assistant output proves progress.
    await c.send({ ...run, app: run.app }, `只回复 ${marker}，不要创建子 Agent、工作任务或操作文件。`, { complete: false });
    const assistant = await c.b.wait(`lastChat?.thread===${attr(run.thread)}
      && lastChat.items.find(i=>i.k==='assistant'&&i.t?.includes(${attr(marker)}))?.i||null`,
      '主 Agent 原生完成标记', c.options.generationTimeout);
    c.check(!!assistant, '收到主 Agent 原生回复');
    await c.b.wait(`lastChat?.thread===${attr(run.thread)}&&!lastChat.busy`, '主 Agent 原生轮次结束', c.options.generationTimeout);
    c.equal((await current(c, run.id)).tasks.total, before, '直接答复没有多派子 Agent');
    const model = await c.b.read('lastChat.model'); c.check(!!model, '主模型数据可见');
    return { run: run.id, model };
  } },
  { id: 'fusion.dispatch', title: '子任务、审阅和交付真实闭环', refs: ['F19', 'X04', 'X05', 'X07'], mode: 'generate', async run(c) {
    const run = await create(c); await open(c, run);
    const marker = c.marker + '-CHILD';
    const started = Date.now(), deadline = started + c.options.generationTimeout, milestones = [];
    const runExpr = `fusionWorkspaces.get(${attr(c.computer)})?.runs.find(r=>r.id===${attr(run.id)})`;
    const waitPhase = async (label, condition) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Fusion ${label} 未完成，已达到全程 ${c.options.generationTimeout}ms 上限`);
      let value;
      try {
        value = await c.b.wait(`(()=>{const r=${runExpr};return r && (${condition}) ? r : null})()`, `Fusion ${label}`, remaining);
      } catch (error) {
        // Report the last REAL source-of-truth projection; no synthetic completion.
        let state = null;
        try {
          state = await c.b.read(`(()=>{const r=${runExpr};return r&&{status:r.status,tasks:r.tasks,works:r.works,busy:lastChat?.busy}})()`);
        } catch {}
        throw new Error(`${error.message}；最后状态 ${JSON.stringify(state)}`);
      }
      const elapsedMs = Date.now() - started;
      milestones.push({ stage: label, elapsedMs });
      console.log(`Fusion QA ${label}: ${elapsedMs}ms`);
      return value;
    };
    await c.send({ ...run, app: run.app }, `这是隔离测试项目。请用 Fusion 工具建立一项工作，并派一个子 Agent 只回复 ${marker}，不读写文件。审阅它的结果并正式交付，最后回复 ${marker}-DONE。`, { complete: false });
    await waitPhase('已创建子任务', 'r.tasks?.total>0');
    await waitPhase('子任务验收', 'r.tasks?.done>0');
    const value = await waitPhase('工作正式交付', 'r.works?.done>0');
    await waitPhase('主控原生回复终态', `!lastChat?.busy && lastChat?.thread===${attr(run.thread)}`);
    c.check(value.tasks.total > 0 && value.tasks.done > 0 && value.works.done > 0, '真实子任务验收与工作交付已登记');
    c.check(await c.b.read(`lastChat.items.some(i=>i.k==='assistant'&&i.t?.includes(${attr(marker + '-DONE')}))`), '收到主 Agent 完成回执');
    return { run: run.id, tasks: value.tasks, works: value.works, elapsedMs: Date.now() - started, milestones,
      scope: '单子任务闭环；并行、复用和返工仍见待验清单' };
  } },
  { id: 'fusion.stop', title: '停止及核对继续入口', refs: ['F19', 'X10'], mode: 'write', async run(c) {
    const run = await create(c); await open(c, run); await openTasks(c, run);
    await c.b.click('[data-fusion-stop]:not([data-work]):not([data-task])');
    await c.b.wait(`fusionWorkspaces.get(${attr(c.computer)})?.runs.find(r=>r.id===${attr(run.id)})?.status==='stopped'`, '工作台停止回执');
    c.equal((await current(c, run.id)).status, 'stopped', '停止有确定状态');
    c.check(await c.b.has('[data-fusion-resume]'), '保留人工核对继续入口'); return { id: run.id };
  } },
  { id: 'fusion.advanced', title: '并行依赖、复用返工、计划审批、预算和重启恢复', refs: ['F19', 'X04', 'X05', 'X06', 'X07', 'X09', 'X10', 'X11', 'X12'], mode: 'manual',
    reason: '现有代码只自动执行主会话和单子任务闭环；复杂编排需按原文档验收，未实现自动断言的分支不得由基础通过代替。' },
];
