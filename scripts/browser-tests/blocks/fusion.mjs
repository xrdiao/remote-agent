import fs from 'node:fs/promises';
import path from 'node:path';
import { attr, by } from '../context.mjs';
import { Unavailable } from '../browser.mjs';

async function current(c, id) {
  return c.b.read(`fusionWorkspaces.get(${attr(c.computer)})?.runs.find(r=>r.id===${attr(id)})||null`);
}
async function open(c, run) {
  await c.b.home(); await c.b.click('#ovLevels [data-v="fusion"]');
  await c.b.click(`[data-fusion-open=${attr(run.id)}]${by('data-computer', c.computer)}`);
  await c.b.wait(`windowReady&&currentFusionRun()?.id===${attr(run.id)}&&lastChat?.thread===${attr(run.thread)}`, 'Fusion 主会话首屏');
}
async function create(c) {
  if (c.fusion.length) return c.fusion[0];
  const b = c.b, app = c.options.fusionApp, root = path.resolve(c.directory, 'projects', 'fusion');
  await fs.mkdir(root, { recursive: true }); await b.home(); await b.click('#ovLevels [data-v="fusion"]');
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
  if (!(await current(c, run.id)).main.preparing && await b.has('[data-fusion-prepare]')) await b.click('[data-fusion-prepare]');
  await b.wait(`!fusionWorkspaces.get(${attr(c.computer)})?.runs.find(r=>r.id===${attr(run.id)})?.main.preparing`, '主 Agent 准备');
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
    await c.b.home(); await c.b.click('#ovLevels [data-v="fusion"]');
    const workspace = await c.b.read(`fusionWorkspaces.get(${attr(c.computer)})||null`);
    c.check(!!workspace, '执行电脑返回 Fusion 工作区');
    c.check(Array.isArray(workspace.runs) && Array.isArray(workspace.apps), '工作台列表与应用能力完整');
    const ids = workspace.runs.map(row => row.id); c.equal(new Set(ids).size, ids.length, '工作台身份没有重复');
    for (const run of workspace.runs.filter(r => r.main.bindingId)) {
      c.check(!!run.main.target?.threadId, '绑定后的工作台返回真实主会话导航目标');
      c.check(!!run.main.target?.windowId, '主会话包含路由窗口身份');
    }
    return { runs: ids.length, controllers: workspace.apps.filter(r => r.controller).map(r => r.app) };
  } },
  { id: 'fusion.create', title: '独立项目启用并打开主工作台', refs: ['F19', 'X01', 'X02'], mode: 'write', async run(c) {
    const run = await create(c); await open(c, run);
    c.equal(await c.b.read('lastChat.thread'), run.thread, '导航使用真实主会话身份');
    const value = await current(c, run.id);
    c.equal(path.resolve(value.project.root), run.root, '工作台项目归属正确');
    return { id: run.id, app: run.app, thread: run.thread };
  } },
  { id: 'fusion.navigation', title: '工作台→普通会话→工作台与关系面板', refs: ['F19', 'R04', 'X02', 'X08', 'X11'], mode: 'write', async run(c) {
    const run = await create(c), normal = await c.target(run.app, 'A', true);
    await open(c, run); await c.b.click('#fusionTasks');
    await c.b.wait(`fusionViewOwner?.runId===${attr(run.id)}&&fusionViewOwner.kind==='tasks'`, '关系面板身份');
    c.equal(await c.b.read('currentFusionRun().id'), run.id, '关系面板绑定同一工作台');
    await c.open(normal); c.check(await c.b.read('!currentFusionRun()'), '普通会话没有残留工作台身份');
    await open(c, run); c.equal(await c.b.read('lastChat.thread'), run.thread, '重回工作台不是管理 ID 或普通会话');
    return { run: run.id, normal: normal.thread };
  } },
  { id: 'fusion.management', title: '工作台重命名、收藏及恢复不改变任务进度', refs: ['F05', 'F19', 'X11'], mode: 'write', async run(c) {
    const run = await create(c), before = await current(c, run.id), title = 'QA workbench ' + Date.now();
    const card = `[data-fusion-open=${attr(run.id)}]${by('data-computer', c.computer)}`;
    const menu = async () => {
      await c.b.home(); await c.b.click('#ovLevels [data-v="fusion"]');
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
    await c.send({ ...run, app: run.app }, `只回复 ${marker}，不要创建子 Agent、工作任务或操作文件。`);
    c.check(await c.b.read(`lastChat.items.some(i=>i.k==='assistant'&&i.t?.includes(${attr(marker)}))`), '收到主 Agent 原生回复');
    c.equal((await current(c, run.id)).tasks.total, before, '直接答复没有多派子 Agent');
    const model = await c.b.read('lastChat.model'); c.check(!!model, '主模型数据可见');
    return { run: run.id, model };
  } },
  { id: 'fusion.dispatch', title: '子任务、审阅和交付真实闭环', refs: ['F19', 'X04', 'X05', 'X07'], mode: 'generate', async run(c) {
    const run = await create(c); await open(c, run);
    const marker = c.marker + '-CHILD';
    await c.send({ ...run, app: run.app }, `这是隔离测试项目。请用 Fusion 工具建立一项工作，并派一个子 Agent 只回复 ${marker}，不读写文件。审阅它的结果并正式交付，最后回复 ${marker}-DONE。`, { complete: false });
    const value = await c.b.wait(`(()=>{const r=fusionWorkspaces.get(${attr(c.computer)})?.runs.find(r=>r.id===${attr(run.id)});return r?.tasks?.total>0&&r.tasks.done>0&&r.works.done>0&&!lastChat.busy?r:null})()`, 'Fusion 派发审阅交付', c.options.generationTimeout);
    c.check(value.tasks.total > 0, '实际创建子任务'); c.check(value.tasks.done > 0 && value.works.done > 0, '子任务已接受且工作已交付');
    c.check(await c.b.read(`lastChat.items.some(i=>i.k==='assistant'&&i.t?.includes(${attr(marker + '-DONE')}))`), '收到主 Agent 完成回执');
    return { run: run.id, tasks: value.tasks, works: value.works, scope: '单子任务闭环；并行、复用和返工仍见待验清单' };
  } },
  { id: 'fusion.stop', title: '停止及核对继续入口', refs: ['F19', 'X10'], mode: 'write', async run(c) {
    const run = await create(c); await open(c, run); await c.b.click('#fusionTasks');
    await c.b.click('[data-fusion-stop]:not([data-work]):not([data-task])');
    await c.b.wait(`fusionWorkspaces.get(${attr(c.computer)})?.runs.find(r=>r.id===${attr(run.id)})?.status==='stopped'`, '工作台停止回执');
    c.equal((await current(c, run.id)).status, 'stopped', '停止有确定状态');
    c.check(await c.b.has('[data-fusion-resume]'), '保留人工核对继续入口'); return { id: run.id };
  } },
  { id: 'fusion.advanced', title: '并行依赖、复用返工、计划审批、预算和重启恢复', refs: ['F19', 'X04', 'X05', 'X06', 'X07', 'X09', 'X10', 'X11', 'X12'], mode: 'manual',
    reason: '现有代码只自动执行主会话和单子任务闭环；复杂编排需按原文档验收，未实现自动断言的分支不得由基础通过代替。' },
];
