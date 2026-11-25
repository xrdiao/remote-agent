import { attr, by } from '../context.mjs';
import { Unavailable } from '../browser.mjs';

const tab = level => `#ovTabs ${by('data-v', level)}`;
const filter = level => `#ovFilters ${by('data-v', level)}`;
const search = '#ovFilters [data-ov-search]';

async function raSnapshot(c, surface) {
  const b = c.b;
  await b.wait(`[...document.querySelectorAll('[data-ov-computer] option')].some(o=>o.value===${attr(c.computer)})`, '当前电脑已出现在范围列表');
  await b.select('[data-ov-computer]', c.computer);
  await b.wait(`document.querySelector('[data-ra-${surface}="ready"]')?.dataset.raSource===${attr(c.computer)}`, '当前电脑的 RA Core 快照');
  return b.read(`(async()=>{
    const owner=peerRelay(currentComputer()), response=await api('/api/ra-core/snapshot',{computer:owner});
    if(!response.ok) throw Error('RA Core 快照 HTTP '+response.status);
    return response.json();
  })()`);
}

export default [
  { id: 'overview.actions', title: '长按卡片管理菜单及可用操作', refs: ['F03', 'F05'], mode: 'read', apps: true, async run(c, app) {
    const target = await c.target(app), card = await c.reveal(target);
    await c.b.hold(`${card} .ov-title`); await c.b.wait("sheetKind==='agent-actions'", '卡片管理菜单');
    const actions = await c.b.read("[...document.querySelectorAll('#sheet [data-agent-action]')].map(e=>e.dataset.agentAction)");
    c.check(actions.includes('rename'), '卡片提供重命名操作');
    c.check(actions.includes('archive') || actions.includes('delete'), '卡片提供原生归档或删除操作');
    await c.b.dismiss(); return { actions };
  } },
  { id: 'overview.levels', title: '概览、工作、设备三项底部导航', refs: ['F03'], mode: 'read', async run(c) {
    const b = c.b;
    await b.home();
    c.check(await b.read(`[...document.querySelectorAll('#ovTabs > button')].map(e=>e.textContent.trim()).join('|')
      ===[ovT('概览'),I18N.tr('工作'),I18N.tr('设备')].join('|')`), '底部恰有三项，顺序和标签正确');
    try {
      for (const level of ['sessions', 'fusion', 'devices']) {
        await b.click(tab(level));
        c.equal(await b.read('ovS.level'), level, '主页栏目切换 ' + level);
        c.equal(await b.read("document.querySelector('#ovTabs [aria-current=page]')?.dataset.v"), level, '选中项与可见栏目一致');
        c.equal(await b.has(search), level === 'sessions', '筛选位于概览');
      }
    } finally { await b.click(tab('sessions')); }
    return { visited: ['sessions', 'fusion', 'devices'] };
  } },
  { id: 'overview.filters', title: '项目入口、搜索、收藏及批量入口保留', refs: ['F03', 'F05'], mode: 'read', async run(c) {
    const b = c.b;
    await b.home(); await b.click(tab('sessions'));
    await b.wait(`ovSt.get(${attr(c.computer)})?.data?.windows.some(w=>w.project&&w.app!=='fusion')`, '真实项目目录');
    const project = await b.read(`(()=>{
      const row=ovSt.get(${attr(c.computer)}).data.windows.find(w=>w.project&&w.app!=='fusion');
      return {key:${attr(c.computer)}+'|'+row.projectId,name:row.project};
    })()`);
    await b.select('[data-ov-computer]', c.computer);
    await b.click(filter('projects'));
    await b.fill(search, project.name);
    const fold = `[data-ov="fold"]${by('data-id', c.computer)}[aria-expanded="false"]`;
    if (await b.has(fold)) await b.click(fold);
    const tile = `[data-ov="proj"]${by('data-id', project.key)}`;
    c.check(await b.has(tile), '真实项目可通过筛选和搜索找到');
    await b.click(tile);
    c.equal(await b.read('ovS.proj'), project.key, '保留原项目导航身份');
    await b.click('#ovUp');
    await b.wait(`ovS.level==='projects'&&!ovS.proj&&document.querySelector(${attr(search)})?.value===${attr(project.name)}`, '历史返回保留项目筛选与查询');
    await b.fill(search, '');
    c.check(await b.has(`[data-ov="computer-editor"]${by('data-id', c.computer)}`), '项目所在电脑的文件入口保留');
    await b.click(filter('favorites'));
    c.equal(await b.read('ovS.level'), 'favorites', '收藏筛选仍使用既有收藏状态');
    const favorites = await b.read(`(()=>{
      const rows=ovScopedRecs(), rendered=[...document.querySelectorAll('#ovBoard [data-ov-session],#ovBoard [data-ov-menu]')];
      return {count:rows.length,valid:rows.every(row=>row.favorite), visible:rendered.every(el=>rows.some(row=>row.key===(el.dataset.ovSession||el.dataset.ovMenu)))};
    })()`);
    c.check(favorites.valid && favorites.visible, '收藏只显示当前范围里已有的收藏');
    await b.menu('overviewBatch');
    c.check(await b.has('[data-ov="batch-all"]'), '收藏筛选中的批量入口可用');
    await b.dismiss();
    await b.select('[data-ov-computer]', '');
    await b.click(tab('sessions'));
    return { project: project.key, favoriteCount: favorites.count };
  } },
  { id: 'overview.batch-search', title: '批量删除确认与搜索范围一致', refs: ['F03', 'F05'], mode: 'read', apps: true, async run(c, app) {
    const target = await c.target(app), b = c.b;
    const card = await c.reveal(target, 'sessions');
    try {
      try { await b.menu('overviewBatch'); }
      catch (error) {
        const state = await b.read(`(()=>{
          const menu=document.querySelector('#sheet'), control=menu?.querySelector('[data-act=overviewBatch]');
          const r=control?.getBoundingClientRect(),cx=r?(r.left+r.right)/2:0,cy=r?(r.top+r.bottom)/2:0;
          const hit=r?document.elementFromPoint(cx,cy):null;
          return {level:ovS.level,app:currentApp,conversation:document.body.classList.contains('conv'),
            kind:sheetKind,open:menu?.classList.contains('open'),button:!!control,
            bounds:r&&{top:r.top,left:r.left,bottom:r.bottom,right:r.right},
            hit:hit?.tagName,hitId:hit?.id,hitClass:hit?.className?.toString().slice(0,80),
            within:!!control?.contains(hit),shade:document.querySelector('#shade')?.className,
            sheetStyle:menu&&{z:getComputedStyle(menu).zIndex,visible:getComputedStyle(menu).visibility,transform:getComputedStyle(menu).transform}};
        })()`);
        throw new Error(error.message + '；菜单前景诊断 ' + JSON.stringify(state));
      }
      await b.click(`${card} .ov-title`);
      c.equal(await b.read('ovBatch.selected.size'), 1, '选中一个真实会话');
      await b.click('[data-ov="batch-remove"]');
      const confirmation = await b.read("document.querySelector('#sheet .askQ')?.textContent");
      c.check(confirmation?.includes(target.thread) && confirmation.includes(target.comp), '删除确认显示会话和电脑的具体身份');
      await b.click('#askNo');
      await b.fill(search, `RAQA-no-match-${target.thread}`);
      c.check(!await b.has(card), '搜索已隐藏原卡片');
      c.equal(await b.read('ovBatch.selected.size'), 0, '隐藏的会话已取消选择');
      c.check(await b.has('[data-ov-batch-pruned]'), '批量工具栏显示取消选择的原因');
      c.check(await b.read("document.querySelector('[data-ov=batch-remove]')?.disabled"), '没有符合范围的选择时禁用删除');
      await b.fill(search, '');
      c.equal(await b.read('ovBatch.selected.size'), 0, '恢复搜索词不会恢复旧选择');
      return { thread: target.thread, cancelled: true };
    } finally {
      await b.dismiss();
      await b.click(tab('sessions'));
    }
  } },
  { id: 'overview.ra-devices', title: '已配对设备、能力状态和手动控制', refs: ['F03'], mode: 'read', async run(c) {
    const b = c.b;
    await b.home();
    try {
      await b.click(tab('devices'));
      const { nodes } = await raSnapshot(c, 'devices');
      c.check(await b.has('[data-ra-devices] [data-ov="ra-peer"]') && await b.has('[data-ra-devices] [data-ov="ra-phone"]'), '设备页保留电脑与手机手动入口');
      const rendered = await b.read(`[...document.querySelectorAll('[data-ra-node]')].map(el=>({
        id:el.dataset.raNode, unregistered:!!el.querySelector('[data-ra-registration="unregistered"]'),
        capabilities:[...el.querySelectorAll('[data-ra-capability]')].map(cap=>({id:cap.dataset.raCapability,workspace:cap.closest('[data-ra-workspace]')?.dataset.raWorkspace||'',state:cap.querySelector('[data-state]').dataset.state}))
      }))`);
      const local = nodes.find(n => n.kind === 'local' && n.id === c.computer);
      c.check(local?.capabilities.length, '实际快照包含当前电脑的本机能力');
      const expected = nodes.flatMap(node => [
        ...(node.capabilities || []).map(cap => ({ id: node.id, cap, workspace: '' })),
        ...(node.workspaces || []).flatMap(work => (work.capabilities || []).map(cap => ({ id: node.id, cap, workspace: work.id }))),
      ]);
      for (const { id, cap, workspace } of expected) {
        const label = rendered.find(row => row.id === id)?.capabilities.find(row => row.id === cap.id && row.workspace === workspace);
        c.equal(label?.state, cap.availability, '能力使用真实快照状态 ' + cap.id);
      }
      await b.select('[data-ov-computer]', '');
      await b.wait(`document.querySelector('[data-ra-devices="ready"]')?.dataset.raSource===${attr(c.computer)}`, '全部电脑范围的设备页已就绪');
      const known = await b.read('ovList.map(row=>row.id)');
      const expectedUnregistered = [...new Set([...known, ...nodes.map(row => row.id)])]
        .filter(id => id !== c.computer && !nodes.find(row => row.id === id)?.workspaces?.length);
      await b.wait(`!ovS.comp&&[...document.querySelectorAll('[data-ra-registration="unregistered"]')]
        .map(el=>el.closest('[data-ra-node]').dataset.raNode).sort().join('|')===${attr(expectedUnregistered.sort().join('|'))}`,
        '全部电脑范围的未登记状态完成渲染', 8000);
      const unregistered = await b.read("[...document.querySelectorAll('[data-ra-registration=unregistered]')].map(el=>el.closest('[data-ra-node]').dataset.raNode)");
      c.equal(unregistered.sort().join('|'), expectedUnregistered.sort().join('|'), '未登记标签对应无工作区绑定的电脑');
      return { nodes: nodes.length, unavailable: expected.filter(row => row.cap.availability === 'unavailable').length, unregistered: unregistered.length };
    } finally { await b.click(tab('sessions')); }
  } },
  { id: 'overview.ra-phone-scope', title: '手机选择器读取设备页所选电脑', refs: ['F03'], mode: 'read', async run(c) {
    const b = c.b;
    await b.home();
    const method = 'Network.requestWillBeSent', previous = b.cdp.handlers.get(method), requests = [];
    try {
      await b.click(tab('devices'));
      const source = await b.read(`(()=>{
        const entry=ovList.find(row=>row.id!==currentComputer()?.id&&row.c?.device&&!row.foreign&&linkForComputerKey(row.c.key)?.authed);
        if(!entry)return null;
        return {id:entry.id,device:entry.c.device,origin:new URL(peerRelay(entry.c).relay).origin,
          currentOrigin:new URL(peerRelay(currentComputer()).relay).origin};
      })()`);
      if (!source || source.origin === source.currentOrigin) throw new Unavailable('需要两台已配对且中继地址不同的在线电脑');
      await b.select('[data-ov-computer]', source.id);
      const picker = '[data-ra-devices] [data-ov="ra-phone"]';
      await b.wait(`document.querySelector(${attr(picker)})?.dataset.id===${attr(source.id)}`, '手机入口更新为所选电脑');
      b.cdp.on(method, event => {
        previous?.(event);
        const url = new URL(event.request.url);
        if (url.pathname !== '/api/phone' || event.request.method === 'OPTIONS') return;
        requests.push({ method: event.request.method, origin: url.origin,
          signed: Object.keys(event.request.headers).some(name => name.toLowerCase() === 'x-ra-proof') });
      });
      await b.click(picker);
      await b.wait(() => requests[0], '手机选择器首个网络请求');
      c.equal(await b.read("document.querySelector('#sheet [data-phone-relay]')?.value"), source.id, '手机选择器锁定到所选电脑');
      c.check(await b.read(`(()=>{const el=document.querySelector('#sheet [data-phone-source]');const select=document.querySelector('#sheet [data-phone-relay]');
        return select.disabled&&select.options.length===1&&el.textContent.includes(${attr(source.id)})&&el.textContent.includes(${attr(source.device)});})()`), '选择器显示同一个电脑和配对设备 ID');
      c.equal(requests[0].origin, source.origin, '首个手机请求发往所选中继');
      c.check(requests[0].signed, '手机列表请求携带配对签名');
      await b.dismiss();
      c.check(requests.every(row => row.method === 'GET' && row.origin === source.origin), '打开和关闭选择器只读取所选中继');
      c.equal(await b.read('currentComputer()?.id'), c.computer, '打开选择器保留当前会话电脑');
      return { source: source.id, requests: requests.length };
    } finally {
      if (previous) b.cdp.on(method, previous); else b.cdp.handlers.delete(method);
      await b.dismiss();
      await b.select('[data-ov-computer]', '');
      await b.click(tab('sessions'));
    }
  } },
  { id: 'overview.ra-work', title: '工作页原会话回执与自主编排工作台', refs: ['F03', 'F19'], mode: 'read', async run(c) {
    const b = c.b;
    await b.home();
    try {
      await b.click(tab('fusion'));
      const snapshot = await raSnapshot(c, 'work');
      c.check(await b.has('#ra-work-title') && await b.has('#ra-orchestration-title'), '关联操作与自主编排分别可见');
      c.equal(await b.read("document.querySelector('#ra-orchestration-title')?.textContent"), await b.read("I18N.tr('自主编排')"), '工作台使用产品名称');
      c.check(!await b.has('[data-ra-work] [data-ov-session]'), '关联操作区未复制普通会话卡片');
      const id = await b.read("document.querySelector('[data-ra-origin]')?.value||''");
      if (!id) {
        c.equal(snapshot.origins.length, 0, '无原会话时显示真实空态');
        c.check(await b.has('[data-ra-work] [role=status]'), '工作页有空态提示');
        return { operations: 0, hasOrigin: false };
      }
      const rows = await b.read(`(async()=>{
        const response=await api('/api/ra-core/work?'+new URLSearchParams({originId:${attr(id)}}),{computer:peerRelay(currentComputer())});
        if(!response.ok)throw Error('关联操作 HTTP '+response.status);
        return (await response.json()).operations.map(row=>row.id);
      })()`);
      await b.wait(`document.querySelector('[data-ra-records="ready"]')&&[...document.querySelectorAll('[data-ra-work] [data-ov="ra-operation"]')].map(el=>el.dataset.id).join('|')===${attr(rows.join('|'))}`, '关联操作对应真实持久化回执');
      if (rows.length) {
        await b.click(`[data-ra-work] [data-ov="ra-operation"]${by('data-id', rows[0])}`);
        c.check(await b.read(`sheetKind==='ra-core-receipt'&&document.querySelector('#sheet').textContent.includes(${attr(rows[0])})`), '可展开对应操作回执');
        await b.dismiss();
      }
      return { operations: rows.length, hasOrigin: true };
    } finally {
      await b.dismiss();
      await b.select('[data-ov-computer]', '');
      await b.click(tab('sessions'));
    }
  } },
  { id: 'overview.ra-origin', title: '卡片跨设备入口锁定真实原会话', refs: ['F03', 'R01'], mode: 'read', apps: true, async run(c, app) {
    const target = await c.target(app), b = c.b;
    // The RA origin is a live native binding, not a cached overview record.
    // Confirm that binding first instead of treating a pending composer attach
    // as a remote-authorization failure.
    const opened = await c.open(target);
    c.equal(opened.thread, target.thread, '原生会话已完成准确绑定');
    const card = await c.expand(target);
    const entry = `${card} [data-ov="ra-access"]`;
    if (await b.read(`!!ovRecs().find(row=>row.key===${attr(target.key)})?.host`)) throw new Unavailable('样本为非本机线程');
    c.check(await b.has(entry), '本机线程提供跨设备操作入口');
    try {
      await b.click(entry);
      await b.wait("sheetKind==='ra-core-access'&&!!document.querySelector('#sheet .ra-identity')", '卡片权限面板');
      c.equal(await b.read("document.querySelector('#sheet .ra-identity')?.textContent"), target.thread, '权限面板显示对应原生线程');
      await b.wait("!!document.querySelector('#sheet [data-ra-access]:not([data-ra-access=loading])')", '原会话绑定读取结束');
      const result = await b.read(`(async()=>{
        const owner=peerRelay(currentComputer()), response=await api('/api/ra-core/snapshot',{computer:owner});
        if(!response.ok)throw Error('RA Core 快照 HTTP '+response.status);
        const all=(await response.json()).origins;
        const matches=all.filter(row=>row.app===${attr(app)}&&row.threadId===${attr(target.thread)}
          &&row.computerId===${attr(c.computer)}&&row.deviceId===owner.device);
        const panel=document.querySelector('#sheet [data-ra-access]');
        return {ids:matches.map(row=>row.id),shown:panel?.dataset.raOrigin,state:panel?.dataset.raAccess};
      })()`);
      c.equal(result.ids.length, 1, '本机样本有唯一的会话与配对设备匹配记录');
      c.equal(result.state, 'ready', '权限面板完成原会话核对');
      c.equal(result.shown, result.ids[0], '面板绑定唯一且匹配原生线程的签名 OriginRef');
      c.check(!await b.read("!!document.querySelector('#sheet [data-ra-access-action=invoke]:not(:disabled)')"), '打开面板时执行按钮不可用');
      return { thread: target.thread };
    } finally { await b.dismiss(); }
  } },
  { id: 'overview.ra-actions', title: '显式授权面板的文件与终端动作和输入', refs: ['F03', 'R01'], mode: 'read', async run(c) {
    const b = c.b, target = await c.target('codex');
    await c.open(target);
    const card = await c.expand(target);
    await b.click(`${card} [data-ov="ra-access"]`);
    try {
      await b.wait("sheetKind==='ra-core-access' && !!document.querySelector('#sheet .ra-identity')", '跨设备原会话面板');
      await b.wait("!!document.querySelector('#sheet [data-ra-access]:not([data-ra-access=loading])')", '远端工作区读取结束');
      const nodes = await b.read("[...document.querySelectorAll('#sheet [data-ra-choice=node] option')].map(o=>o.value).filter(Boolean)");
      if (!nodes.length) throw new Unavailable('当前 QA 电脑尚未登记可用的远端工作区，真实动作面板待 B 恢复后验收');
      await b.select('#sheet [data-ra-choice=node]', nodes[0]);
      const workspaces = await b.read("[...document.querySelectorAll('#sheet [data-ra-choice=workspace] option')].map(o=>o.value).filter(Boolean)");
      if (!workspaces.length) throw new Unavailable('目标 B 无可用工作区登记');
      await b.select('#sheet [data-ra-choice=workspace]', workspaces[0]);
      const actions = await b.read("[...document.querySelectorAll('#sheet [data-ra-choice=action] option')].map(o=>o.value).filter(Boolean)");
      for (const required of ['list-files', 'read-file', 'save-file', 'send-terminal', 'read-terminal'])
        c.check(actions.includes(required), '工作区原生能力暴露 ' + required);
      await b.select('#sheet [data-ra-choice=action]', 'read-file');
      c.check(await b.has('#sheet [data-ra-arg=path]'), '读文件必须填写相对路径');
      c.check(!await b.has('#sheet [data-ra-arg=text]'), '读文件无需正文');
      await b.fill('#sheet [data-ra-arg=path]', 'notes/readme.txt');
      c.equal(await b.read("document.querySelector('#sheet [data-ra-arg=path]')?.value"), 'notes/readme.txt', '路径输入与所选动作关联');
      await b.select('#sheet [data-ra-choice=action]', 'send-terminal');
      c.check(await b.has('#sheet [data-ra-arg=text]'), '终端写入需要显式正文');
      c.check(!await b.has('#sheet [data-ra-arg=path]'), '终端操作不接受文件路径');
      await b.fill('#sheet [data-ra-arg=text]', 'echo RA-QA-NO-DISPATCH');
      c.equal(await b.read("document.querySelector('#sheet [data-ra-arg=text]')?.value"),
        'echo RA-QA-NO-DISPATCH', '终端输入保留到签名时校验');
      c.check(!await b.read("!!document.querySelector('#sheet [data-ra-access-action=invoke]:not(:disabled)')"),
        '没有激活不能执行任何终端命令');
      return { registeredNode: nodes[0], workspace: workspaces[0], actions, dispatched: false };
    } finally { await b.dismiss(); }
  } },
  { id: 'overview.card', title: '折叠卡片打开、返回、展开摘要', refs: ['F03', 'R01'], mode: 'read', apps: true, async run(c, app) {
    const target = await c.target(app), opened = await c.open(target);
    c.equal(opened.thread, target.thread, '打开指定卡片的正文');
    const card = await c.expand(target); const preview = await c.preview(target);
    c.check(preview.available, '原生摘要实际可读');
    c.equal(preview.threadId, target.thread, '卡片摘要属于当前会话');
    c.equal(preview.win, target.win, '摘要属于请求的软件路由');
    c.check((preview.text || '').length <= 600 && (preview.tools || []).length <= 3, '卡片摘要和工具数量遵守显示上限');
    c.check(await c.b.has(`${card} [data-ov="full"]`), '展开卡片保留打开正文入口');
    return { elapsedMs: opened.elapsedMs, previewCharacters: preview.text?.length || 0 };
  } },
  { id: 'overview.last-target', title: '展开 A 后打开 B，迟到内容不串会话', refs: ['F04', 'R02', 'M03'], mode: 'write', apps: true, async run(c, app) {
    const a = await c.target(app, 'A', true), b = await c.target(app, 'B', true);
    c.check(a.thread !== b.thread, '使用两个不同的真实会话'); await c.expand(a); const first = await c.open(b);
    await c.b.wait(`windowReady&&lastChat?.thread===${attr(b.thread)}&&pendingSends.size===0`, 'B 正文稳定');
    c.equal((await c.b.snapshot()).thread, b.thread, '最终目标仍为 B');
    return { from: a.thread, to: b.thread, elapsedMs: first.elapsedMs };
  } },
  { id: 'overview.status', title: '正文和展开卡片状态保存及刷新恢复', refs: ['F03', 'R01'], mode: 'read', apps: true, async run(c, app) {
    const target = await c.target(app); await c.open(target);
    const status = `sharedAgentRecord(${attr(target.thread)},${attr(app)}).statuses`;
    await c.b.wait(`Object.keys(${status}||{}).length>0`, '正文状态保存回执');
    await c.expand(target); await c.preview(target);
    const saved = await c.b.read(`JSON.stringify(${status})`);
    c.check(!!saved, '展开卡片后有已保存状态');
    await c.b.cdp.send('Page.reload', { ignoreCache: true });
    await c.b.wait('typeof authed!=="undefined"&&authed&&ws?.readyState===1', '刷新后恢复原配对连接');
    await c.b.wait(`JSON.stringify(${status})===${attr(saved)}`, '刷新后恢复相同会话状态');
    c.equal(await c.b.read(`JSON.stringify(${status})`), saved, '保存的会话状态跨刷新保留');
    return { thread: target.thread, restored: true };
  } },
  { id: 'overview.favorite', title: '收藏状态保存和恢复', refs: ['F03', 'F05'], mode: 'write', apps: true, async run(c, app) {
    const target = await c.target(app, 'A', true), card = await c.reveal(target);
    const before = await c.b.read(`ovRecs().find(r=>r.key===${attr(target.key)})?.favorite===true`);
    for (const expected of [!before, before]) {
      await c.b.hold(`${card} .ov-title`); await c.b.click('#sheet [data-agent-action="favorite"]');
      await c.b.wait(`ovRecs().find(r=>r.threadId===${attr(target.thread)})?.favorite===${expected}`, '收藏回执');
      await c.b.dismiss();
    }
    c.equal(await c.b.read(`ovRecs().find(r=>r.threadId===${attr(target.thread)})?.favorite===true`), before, '收藏恢复原值');
    return { thread: target.thread, restored: true };
  } },
];
