import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { browserDeadline, Unavailable, pause } from './browser.mjs';

export const attr = value => JSON.stringify(String(value));
export const by = (name, value) => `[${name}=${attr(value)}]`;
const platform = await import(process.platform === 'win32' ? './platform/windows.mjs' : './platform/posix.mjs');

export class Context {
  constructor(browser, options, directory) {
    this.b = browser; this.options = options; this.directory = directory;
    this.owned = []; this.terminals = []; this.fusion = []; this.data = new Map();
    this.marker = 'RAQA-' + path.basename(directory); this.cleanup = { sessions: [], terminals: [], errors: [] };
    this.assertions = [];
    this.prerequisites = new Map();
  }
  async prerequisite(key, action) {
    if (this.prerequisiteCase !== this.test) {
      this.prerequisiteCase = this.test;
      this.prerequisites.clear();
    }
    if (this.prerequisites.has(key)) throw new Unavailable(`前置条件 ${key} 已失败：${this.prerequisites.get(key)}`);
    try { return await action(); }
    catch (error) { this.prerequisites.set(key, error.message); error.prerequisite ||= key; throw error; }
  }
  check(value, message) { this.assertions.push(message); assert(value, message); }
  equal(actual, expected, message) { this.assertions.push(message); assert.equal(actual, expected, message); }
  async start() {
    this.original = await this.b.read(`(()=>{
      const computer=currentComputer()?.id, conversation=document.body.classList.contains('conv');
      const [,windowId,selectedThread]=viewSel.split('|'), threadId=lastChat?.thread||selectedThread;
      const target=conversation&&windowReady&&!selectedConversation.navigation&&threadId ?
        {app:currentApp,windowId,threadId} : null;
      return {computer,view:{conversation,target,level:ovS.level,query:ovS.query,comp:ovS.comp,proj:ovS.proj,open:ovS.open,
        mode,inputExpanded:document.getElementById('composerFold').getAttribute('aria-expanded')},
        width:innerWidth,height:innerHeight,draft:text.value,draftKey:activeDraft};
    })()`);
    this.computer = this.options.computer || this.original.computer;
    if (!this.computer) throw new Unavailable('没有已配对的执行电脑');
    if (this.options.computer && this.options.computer !== this.original.computer)
      throw new Unavailable('请先在既有配对浏览器选择 --computer 指定的电脑');
    this.initial = await this.b.snapshot();
  }
  async rows(app) {
    await this.b.wait(`!!ovSt.get(${attr(this.computer)})?.data`, '已配对电脑的会话目录');
    return this.b.read(`ovRecs().filter(r=>r.comp===${attr(this.computer)}${app ? `&&r.app===${attr(app)}` : ''}&&!r.fusion&&!r.off)
      .map(r=>({key:r.key,project:r.project,app:r.app,comp:r.comp,thread:r.threadId,window:r.windowId,win:r.win,
        root:r.workspace||'',state:r.state,title:r.title,missing:r.workspaceMissing}))`);
  }
  async target(app, slot = 'A', owned = false) {
    if (owned) {
      if (['fold', 'models', 'commands', 'terminal'].includes(slot)) slot = 'A';
      const previous = this.owned.find(row => row.app === app && row.slot === slot);
      if (previous && !previous.thread && previous.creationRequested) throw new Unavailable(`${app} 的 ${slot} 测试会话创建结果待核对`);
      const target = await this.prerequisite(`create:${app}:${slot}`, () => previous?.thread ? previous : this.create(app, slot, previous));
      return target;
    }
    const selected = this.options.targets?.[app]?.[slot];
    if (slot === 'long' && !selected) throw new Unavailable(`${app} 需要通过 --targets 登记真实 long 会话，不用普通空闲会话替代`);
    const label = selected ? `${app} 已登记的 ${slot} 会话` : `${app} 可读的空闲会话`;
    // Default real QA candidates must be loadable. A previously failed
    // native session can still be present in Overview, but it is not a
    // suitable source for a live read/control scenario.
    const candidate = selected ? `r.threadId===${attr(selected)}`
      : "r.threadId&&['idle','done','wait'].includes(r.state)";
    try {
      await this.b.wait(`ovRecs().some(r=>r.comp===${attr(this.computer)}&&r.app===${attr(app)}
        &&!r.off&&!r.workspaceMissing&&(${candidate}))`, label);
    } catch (error) {
      if (error.message.startsWith(label + '超时')) throw new Unavailable(error.message);
      throw error;
    }
    const rows = await this.rows(app);
    const target = selected ? rows.find(row => row.thread === selected && !row.missing)
      : rows.find(row => row.thread && ['idle', 'done', 'wait'].includes(row.state) && !row.missing);
    if (!target) throw new Unavailable(`${app} 没有可读的空闲会话`);
    return target;
  }
  async reveal(target, level = 'projects') {
    await this.refreshTarget(target);
    const b = this.b; await b.home();
    // Projects and Favorites are Overview filters as of v518, not first-level tabs.
    await b.click('#ovTabs [data-v="sessions"]');
    if (['projects', 'favorites'].includes(level)) await b.click(`#ovFilters [data-v="${level}"]`);
    return this.revealCard(target, level);
  }
  async revealCard(target, level) {
    const b = this.b;
    const project = `[data-ov="proj"]${by('data-id', target.project)}`;
    const card = by('data-ov-session', target.key);
    if (await b.read(`ovCollapsed.has(${attr(target.comp)})`)) {
      const fold = `[data-ov="fold"]${by('data-id', target.comp)}`;
      await b.click(fold);
    }
    if (level === 'projects') {
      await b.click(project, { dom: true });
      await b.wait(`ovS.proj===${attr(target.project)}`, '所选项目');
    }
    if (!await b.has(card)) {
      const groups = await b.read("[...document.querySelectorAll('[data-ov=group][aria-expanded=false]')].map(e=>e.dataset.id)");
      for (const group of groups) { await b.click(`[data-ov="group"]${by('data-id', group)}`); if (await b.has(card)) break; }
    }
    await b.wait(`!!document.querySelector(${attr(card)})`, '会话卡片');
    return card;
  }
  async open(target) {
    return this.prerequisite(`open:${target.app}:${target.thread || target.root}`, async () => {
      if (!target.thread) {
        const started = Date.now(); await this.openProject(target);
        return { elapsedMs: Date.now() - started, ...await this.b.snapshot() };
      }
      const b = this.b, card = await this.reveal(target), started = Date.now();
      const eventStart = b.events.length;
      await b.click(`${card} [data-ov="full"]`);
      const outcome = await b.wait(`ovOpening?.phase==='error'?{error:ovOpening.message}:
        windowReady&&!selectedConversation.navigation&&lastChat?.thread===${attr(target.thread)}&&currentApp===${attr(target.app)}&&document.body.classList.contains('conv')?{ready:true}:null`, '会话新鲜首屏');
      if (outcome.error) throw new Error('会话打开失败：' + outcome.error);
      const error = b.events.slice(eventStart).find(event => event.type === 'relay-status-error'
        && event.sel?.split('|').at(-1) === target.thread);
      if (error) throw Object.assign(new Error('打开会话时中继报错：' + error.message), { kind: 'product' });
      await this.refreshTarget(target);
      return { elapsedMs: Date.now() - started, ...await b.snapshot() };
    });
  }
  async expand(target) {
    const card = await this.reveal(target);
    if (!await this.b.has(`${card} .ov-close`)) await this.b.click(`${card} .ov-title`);
    await this.b.wait(`!!document.querySelector(${attr(card + ' [data-ov-input]')})&&!document.querySelector(${attr(card + ' [data-ov-input]')}).disabled`, '卡片输入就绪');
    return card;
  }
  async create(app, slot, previous) {
    const b = this.b, seed = await this.target(app), root = path.resolve(this.directory, 'projects', app, slot);
    await fs.mkdir(root, { recursive: true }); await this.open(seed);
    const target = previous || { app, comp: this.computer, thread: '', root, slot, owned: true };
    if (!previous) { this.owned.push(target); await this.persistResources(); }
    await this.openProject(target);
    if (target.thread) await this.refreshTarget(target);
    target.projectRead = await this.verifyProject(target);
    await this.persistResources(); return target;
  }
  async refreshTarget(target) {
    if (!target.thread) return target;
    const host = target.host == null ? '' : `&&r.host===${attr(target.host)}`;
    const row = await this.b.wait(`ovRecs().find(r=>r.comp===${attr(target.comp)}&&r.app===${attr(target.app)}&&r.threadId===${attr(target.thread)}${host})||null`, '按原生身份定位会话');
    Object.assign(target, { key: row.key, project: row.project, window: row.windowId, win: row.win });
    return target;
  }
  async openProject(target) {
    const b = this.b, { app, root } = target;
    await b.click('#pickAgents'); await b.click('#sheet [data-act="projects"]');
    await b.wait("sheetKind==='computer-files'&&computerFiles?.message!=='正在读取目录…'", '项目目录入口就绪');
    await b.fill('#computerFilePath', root);
    await b.click('#computerFilePathForm button[type="submit"]');
    const folder = await b.wait(`computerFiles?.error ? {error:computerFiles.message} :
      computerFiles?.directory?.path===${attr(root.replaceAll(path.sep, '/'))}&&!computerFiles?.message ? {ready:true} : null`, '测试项目目录');
    if (folder.error) throw new Error(`测试项目目录读取失败：${folder.error}`);
    const previous = await b.read('lastChat?.thread');
    target.creationRequested = true;
    await this.persistResources();
    await b.click('[data-computer-project="chat"]');
    const ready = `windowReady&&!selectedConversation.navigation&&lastChat?.thread&&lastChat.thread!==${attr(previous)}&&currentApp===${attr(app)}`;
    await b.wait(`(${ready})||!!document.querySelector('[data-project-trust="yes"]')`, '项目创建或信任确认');
    if (await b.has('[data-project-trust="yes"]')) await b.click('[data-project-trust="yes"]');
    await b.wait(ready, '新建原生会话');
    Object.assign(target, await b.read("({thread:lastChat.thread,win:currentWindow,window:viewSel.split('|')[1]})"));
    await this.persistResources();
  }
  async verifyProject(target) {
    const normalize = value => process.platform === 'win32' ? path.resolve(value).replaceAll('\\', '/').toLowerCase() : path.resolve(value);
    if (!target.thread) {
      assert.equal(normalize(await this.b.read("viewSel.split('|')[1]")), normalize(target.root), '未持久化项目归属一致');
      assert.equal(await this.b.read('lastChat?.empty'), true, '首次发送前保留原生空会话');
      return { thread: '', root: target.root, persisted: false };
    }
    const started = Date.now(), first = (await this.overview()).sessions.find(row => row.app === target.app && row.threadId === target.thread);
    const match = `r.app===${attr(target.app)}&&r.threadId===${attr(target.thread)}`;
    await this.b.wait(`(async()=>{const d=await(await api('/api/overview')).json(),r=d.sessions.find(r=>${match});
      const p=r?.workspace||r?.cwd||'';return ${process.platform === 'win32' ? "p.replaceAll('\\\\','/').toLowerCase()" : 'p'}===${attr(normalize(target.root))}})()`, '原生目录确认新项目归属');
    await this.refreshTarget(target);
    return { thread: target.thread, root: target.root, firstRoot: first?.workspace || first?.cwd || '', confirmedMs: Date.now() - started };
  }
  async overview() { return this.b.read("(async()=>{const r=await api('/api/overview');if(!r.ok)throw Error('原生目录 HTTP '+r.status);return r.json()})()"); }
  async preview(target) {
    const query = new URLSearchParams({ win: target.win, windowId: target.window, threadId: target.thread });
    return this.b.read(`(async()=>{const r=await api(${attr('/api/overview/preview?' + query)});if(!r.ok)throw Error('原生摘要 HTTP '+r.status);return r.json()})()`);
  }
  async input(value, selector = '#text') {
    if (selector === '#text' && await this.b.read("document.getElementById('composerFold').getAttribute('aria-expanded')==='false'"))
      await this.b.click('#composerFold');
    await this.b.fill(selector, value);
  }
  async draft(value, selector = '#text') {
    const sel = await this.b.read('viewSel');
    return this.prerequisite('draft:' + sel, async () => {
      const events = this.b.events.length;
      await this.input(value, selector);
      const { revision, epoch } = await this.b.read('({revision:draftRevision,epoch:draftEpoch})');
      await this.b.wait('draftAckRevision===draftRevision', '原生草稿回执', this.options.timeout, () => {
        const rejected = this.b.events.slice(events).find(e => e.type === 'draft-ack' && e.sel === sel && e.epoch === epoch && e.revision === revision && e.ok === false);
        return rejected && Object.assign(new Error(`原生拒绝草稿回执（revision ${revision}）`), { kind: 'product' });
      });
    });
  }
  async send(target, text, options = {}) {
    const b = this.b;
    const modelError = this.prerequisites.get('model:' + target.app);
    if (modelError) throw Object.assign(new Unavailable(modelError), { kind: 'environment' });
    return this.prerequisite(`send:${target.app}:${target.thread || target.root}`, async () => {
      assert(this.owned.includes(target)
        || this.owned.some(row => row.thread && row.thread === target.thread && row.app === target.app)
        || this.fusion.some(row => row.thread === target.thread && row.app === target.app), '发送目标必须属于本轮');
      assert.equal(await b.read('lastChat?.thread'), target.thread, '发送前目标发生变化');
      const before = await b.read('(lastChat?.items||[]).filter(i=>i.k===\'human\').map(i=>i.i)');
      await this.selectSendModel(target);
      if (text) await this.draft(text);
      const events = b.events.length;
      await b.click(options.now ? '#sendNow' : '#send');
      const send = await b.wait(() => b.events.slice(events).find(event => event.type === 'send'), '发送请求');
      await b.wait(`!pendingSends.has(${attr(send.requestId)})&&(lastChat?.items||[]).some(i=>i.k==='human'&&!${JSON.stringify(before)}.includes(i.i)${text ? `&&i.t?.includes(${attr(text)})` : '&&i.images?.length'})`, '原生发送接受', this.options.timeout);
      if (!target.thread) {
        target.thread = await b.read('lastChat.thread');
        assert(target.thread, '首次发送获得真实会话 ID');
        await this.persistResources(); await this.refreshTarget(target);
      }
      const receipt = await b.read(`({thread:lastChat.thread,draftLength:text.value.length,pending:pendingSends.size,
        ids:lastChat.items.filter(i=>i.k==='human'&&!${JSON.stringify(before)}.includes(i.i)).map(i=>i.i)})`);
      assert.equal(receipt.ids.length, 1, '同一次发送出现重复原生用户消息');
      const fusion = target.app === 'cursor' && this.fusion.find(row => row.app === target.app && row.thread === target.thread);
      if (fusion) b.steps.push({ action: 'fusion-native-accept', run: fusion.id, thread: receipt.thread, messageId: receipt.ids[0],
        ...await b.read('({model:lastChat.model,effort:lastChat.effort})') });
      if (options.complete !== false) await this.finishGeneration(target, '原生生成完成');
      return receipt;
    });
  }
  async selectSendModel(target) {
    const label = this.options.targets?.[target.app]?.model;
    if (!label) return;
    const choices = await this.menu('model');
    const match = choices.find(row => row.label === label && !row.disabled);
    if (!match) throw new Unavailable(`原生菜单没有配置的测试模型 ${label}`);
    if (!match.checked) {
      await this.b.click(`#sheet [data-kind="model"]${by('data-label', label)}`);
      await this.b.wait('!modelSwitchRequest', '选定测试模型回执');
      assert((await this.menu('model')).some(row => row.label === label && row.checked), '原生回读确认测试模型');
    }
    await this.b.dismiss();
  }
  async finishGeneration(target, label) {
    const result = await this.b.wait(`(()=>{
      const failure=lastChat.items.find(item=>item.k==='notice'&&/Cannot connect to API|Unable to connect/.test(item.t||''));
      if(failure)return {error:failure.t};
      if(!lastChat.busy)return {done:true};
      const approval=lastChat.questions?.requests?.find(request=>request.id.startsWith('devin-permission:')&&request.text.includes(${attr(this.marker)}));
      return approval?{approval:approval.id}:null;
    })()`, label, this.options.generationTimeout).catch(async error => {
      if (this.owned.some(row => row.app === target.app && row.thread === target.thread)
        || this.fusion.some(row => row.app === target.app && row.thread === target.thread)) {
        try { await this.stopOwnedRun(target); }
        catch (stopError) { this.cleanup.errors.push({ thread: target.thread, error: stopError.message }); }
      }
      throw error;
    });
    if (result.error) {
      this.prerequisites.set('model:' + target.app, result.error);
      throw Object.assign(new Unavailable(result.error), { kind: 'environment' });
    }
    if (result.approval) {
      assert(this.owned.includes(target), '只审批本轮隔离测试会话的标记命令');
      await this.b.click(`#qnBar [data-request=${attr(result.approval)}][data-action="0"]`);
      await this.b.wait(`!questionSubmissions.size&&!lastChat.questions?.requests?.some(request=>request.id===${attr(result.approval)})`, '测试命令单次审批回执');
      await this.b.wait('!lastChat.busy', label, this.options.generationTimeout);
    }
  }
  async menu(kind) {
    const b = this.b; await b.dismiss();
    // The model picker belongs to the composer. A valid native session can
    // start with its composer folded; expand via the actual UI before lookup.
    if (kind === 'model' && await b.read("document.getElementById('composerFold')?.getAttribute('aria-expanded')==='false'"))
      await b.click('#composerFold');
    if (kind === 'effort') { await this.menu('model'); await b.click('#sheet [data-effort-open]'); }
    else {
    const selectors = { model: '#pickModel', permission: '#pickPerm', mode: '#pickMode' };
    if (selectors[kind] && await b.has(selectors[kind])) await b.click(selectors[kind]);
    else await b.menu(kind);
    }
    await b.wait(`!menuPending&&menuSheetKind===${attr(kind)}`, kind + ' 原生菜单响应');
    const error = await b.read("document.querySelector('#sheet [role=alert]')?.textContent");
    if (error) throw new Error(error);
    return b.read(`[...document.querySelectorAll('#sheet [data-kind=${attr(kind)}]')].map(e=>({label:e.dataset.label,checked:e.classList.contains('cur'),disabled:e.disabled}))`);
  }
  async terminalMenu() {
    if (await this.b.read('sheetKind') !== 'terminals') await this.b.click('#pickTerms');
  }
  async stopOwnedRun(target) {
    const b = this.b;
    const matches = `currentApp===${attr(target.app)}&&lastChat?.thread===${attr(target.thread)}`;
    if (!await b.read(`(${matches})&&lastChat.busy`)) return;
    if (await b.read("document.getElementById('composerFold').getAttribute('aria-expanded')==='false'")) await b.click('#composerFold');
    const state = await b.wait(`(()=>{
      if (!(${matches})) throw Error('清理时选中的原生会话已变化');
      if (!lastChat.busy) return 'idle';
      const stop=document.getElementById('stop');
      if (!stop?.getClientRects().length || stop.disabled) return null;
      stop.click(); return 'confirm';
    })()`, '测试会话已结束或可停止');
    if (state === 'idle') return;
    await b.wait(`(()=>{
      if (!(${matches})) throw Error('确认停止时选中的原生会话已变化');
      const button=document.getElementById(lastChat.busy?'askOk':'askNo');
      if (!button?.getClientRects().length || button.disabled) return false;
      button.click(); return true;
    })()`, '测试会话停止确认');
    await b.wait(`(${matches})&&!lastChat.busy`, '停止本轮测试会话后清理');
  }
  async cleanupSession(target) {
    const b = this.b; await b.dismiss();
    await this.open(target);
    await this.stopOwnedRun(target);
    const card = await this.reveal(target); await b.hold(`${card} .ov-title`);
    await b.wait("sheetKind==='agent-actions'&&!document.querySelector('#sheet [role=status]')&&document.querySelector('#sheet [data-agent-action=rename]')", '原生会话管理操作加载');
    const archive = '#sheet [data-agent-action="archive"]', remove = '#sheet [data-agent-action="delete"]';
    const selector = await b.has(remove) ? remove : archive;
    if (!await b.has(selector)) throw new Error('本轮测试会话没有原生归档或删除入口');
    await b.click(selector);
    if (await b.has('#askOk')) await b.click('#askOk');
    const query = `!d.sessions.some(r=>r.app===${attr(target.app)}&&r.threadId===${attr(target.thread)})`;
    await b.wait(`(async()=>{const d=await(await api('/api/overview')).json();return ${query}})()`, '原生清理确认');
  }
  async persistResources() {
    await fs.writeFile(`${this.directory}/resources.json`, JSON.stringify({ sessions: this.owned, terminals: this.terminals, fusion: this.fusion }, null, 2));
  }
  async stressProgress(progress) {
    await fs.appendFile(path.join(this.directory, 'stress-progress.jsonl'), JSON.stringify({ at: Date.now(), ...progress }) + '\n');
    if (progress.phase === 'overview' && progress.state === 'started')
      console.log(`stress.last-target/${progress.app} · ${progress.iteration}/${this.options.iterations}`);
  }
  async codexRestoreTarget(target) {
    const catalog = await this.overview();
    if (catalog.id !== this.original.computer || catalog.ready !== true || !Array.isArray(catalog.sessions))
      throw new Error('原电脑的 Codex 会话目录不可用');
    const matches = catalog.sessions.filter(row => row.app === 'codex' && row.threadId === target.threadId);
    const row = matches.find(row => row.windowId === target.windowId) || (matches.length === 1 ? matches[0] : null);
    if (!row && matches.length) throw new Error('无法确认原 Codex 会话的窗口归属');
    if (!row) return { reason: '原 Codex 会话已不在当前目录' };
    if (row.workspaceMissing) return { reason: '原 Codex 会话的项目目录已移除' };
    const params = new URLSearchParams({ computer: catalog.id, win: row.win, windowId: row.windowId, threadId: row.threadId });
    const result = await this.b.read(`(async()=>{
      const response=await api(${attr('/api/overview/session?' + params)});
      const result=await response.json();
      if(!response.ok)throw Error(result.error||'Codex 原生目录 HTTP '+response.status);
      return result;
    })()`);
    if (result.threadId !== target.threadId) throw new Error('Codex 原生目录返回了不同的会话');
    if (result.status === 'missing') return { reason: '原 Codex 会话已从原生目录移除' };
    if (result.status === 'archived') return { reason: '原 Codex 会话已归档' };
    if (result.status === 'workspace-missing') return { reason: '原 Codex 会话的项目目录已移除' };
    if (result.status !== 'available') throw new Error('Codex 原生会话目录不可用');
    return { row: { app: row.app, comp: catalog.id, thread: row.threadId, host: row.host || '' } };
  }
  async restoreOriginal() {
    const b = this.b, { computer, view, width, height, draft, draftKey } = this.original;
    await b.dismiss();
    if (await b.has('#transferClose')) await b.click('#transferClose');
    if (await b.has('#vClose')) await b.click('#vClose');
    // Restoring a visible overview does not need to wait for every unrelated
    // page animation to settle after Back. Verify the actual view instead.
    if (await b.read("document.body.classList.contains('conv')")) {
      await b.click('#ovBack', { settle: false });
      await b.wait("!document.body.classList.contains('conv')", '恢复概览');
    }
    await b.viewport(width, height);
    assert.equal(await b.read('currentComputer()?.id'), computer, '恢复时电脑已变化');
    const tab = ['fusion', 'devices'].includes(view.level) ? view.level : 'sessions';
    if (await b.read(`document.querySelector('#ovTabs [aria-current=page]')?.dataset.v`) !== tab)
      await b.click(`#ovTabs [data-v="${tab}"]`);
    // Restore the complete visible Overview scope, not just the bottom tab.
    // The QA scenarios deliberately modify project, computer and search filters.
    // Restoring only ovS.level silently leaves the user in the wrong subview.
    if ((await b.read('ovS.comp')) !== view.comp)
      await b.select('[data-ov-computer]', view.comp || '');
    if (['sessions', 'projects', 'favorites'].includes(view.level)) {
      // Projects and Favorites are Overview filters, not separate bottom tabs.
      // Reselecting the filter also clears any QA-selected project card.
      if ((await b.read('ovS.level')) !== view.level || (await b.read('ovS.proj')) !== view.proj)
        await b.click(`#ovFilters [data-v="${view.level === 'sessions' ? 'all' : view.level}"]`);
      if (view.proj && (await b.read('ovS.proj')) !== view.proj) {
        // Do not let a QA search hide the original project before reopening it.
        if (await b.read('ovS.query')) await b.fill('#ovFilters [data-ov-search]', '');
        const project = `#ovBoard [data-ov="proj"]${by('data-id', view.proj)}`;
        const folded = `[data-ov="fold"]${by('data-id', view.proj.split('|')[0])}[aria-expanded="false"]`;
        if (await b.has(folded)) await b.click(folded);
        await b.click(project);
      }
      if ((await b.read('ovS.query')) !== view.query)
        await b.fill('#ovFilters [data-ov-search]', view.query || '');
      if (view.open && (await b.read('ovS.open')) !== view.open)
        await b.click(`#ovBoard [data-ov="sess"]${by('data-id', view.open)}`);
    } else if ((await b.read('ovS.query')) !== view.query) {
      // Search is hidden in Work/Devices. Set it through the actual UI before
      // returning to the original tab; never inject the application state.
      await b.click('#ovTabs [data-v="sessions"]');
      await b.fill('#ovFilters [data-ov-search]', view.query || '');
      await b.click(`#ovTabs [data-v="${view.level}"]`);
    }
    assert.equal(await b.read('ovS.level'), view.level, '原概览层级未恢复');
    assert.equal(await b.read('ovS.comp'), view.comp, '原电脑筛选未恢复');
    assert.equal(await b.read('ovS.proj'), view.proj, '原项目筛选未恢复');
    assert.equal(await b.read('ovS.query'), view.query, '原搜索条件未恢复');
    assert.equal(await b.read('ovS.open'), view.open, '原展开卡片未恢复');

    let restoration = { status: 'overview' };
    if (view.conversation) {
      const target = view.target;
      if (!target) throw new Error('启动时的可见会话身份未确认');
      const result = target.app === 'codex' ? await this.codexRestoreTarget(target)
        : { row: (await this.rows(target.app)).find(row => row.thread === target.threadId) };
      if (result.row) {
        const opened = await this.open(result.row);
        assert(opened.conversation && opened.computer === computer && opened.app === target.app && opened.thread === target.threadId,
          '打开的会话与原可见会话不一致');
        if (view.mode === 'terminal') await b.click('#tabTerm');
        if (view.mode === 'chat' && await b.read("document.getElementById('composerFold').getAttribute('aria-expanded')") !== view.inputExpanded)
          await b.click('#composerFold');
        restoration = { status: 'exact', thread: target.threadId };
      } else if (result.reason) restoration = { status: 'overview-fallback', thread: target.threadId, exact: false, reason: result.reason };
      else throw new Error('原会话已不在目录中');
    }

    this.cleanup.restored = await b.snapshot();
    assert.equal(this.cleanup.restored.computer, computer, '未恢复到原电脑');
    assert.equal(this.cleanup.restored.conversation, restoration.status === 'exact', '未恢复预期的可见视图');
    const retainedDraft = restoration.status === 'exact' ? 'text.value'
      : `activeDraft===${attr(draftKey)}?text.value:(drafts.get(${attr(draftKey)})||'')`;
    assert.equal(await b.read(retainedDraft), draft, '原归属的草稿未恢复');
    return restoration;
  }
  async finish() {
    const b = this.b;
    for (const run of this.fusion.slice().reverse()) {
      try {
        await b.home(); await b.click('#ovTabs [data-v="fusion"]');
        const card = `[data-fusion-open]${by('data-fusion-open', run.id)}${by('data-computer', this.computer)}`;
        await b.hold(card); await b.click('#sheet [data-agent-action="remove"]');
        if (await b.has('#askOk')) await b.click('#askOk');
        const outcome = await b.wait(`(()=>{
          const r=fusionWorkspaces.get(${attr(this.computer)})?.runs.find(row=>row.id===${attr(run.id)});
          return !r ? { removed: true } : r.removal?.error ? { error: r.removal.error } : null;
        })()`, '测试工作台删除回执');
        if (outcome.error) throw new Error('原生工作台清理被拒绝：' + outcome.error);
        (this.cleanup.fusion ||= []).push({ id: run.id, ok: true });
      } catch (error) { this.cleanup.errors.push({ fusion: run.id, error: error.message }); }
    }
    for (const terminal of this.terminals.slice().reverse()) {
      const { id } = terminal;
      try {
        const owner = this.owned.find(row => row.thread === terminal.thread && row.app === terminal.app);
        await this.open(owner); await b.click('#tabTerm');
        await this.terminalMenu();
        await b.click(by('data-term-del', id)); await b.click('#askOk');
        await this.terminalMenu();
        await b.wait(`!document.querySelector(${attr(by('data-term', id))})`, '终端关闭后从原生列表移除');
        await b.dismiss();
        this.cleanup.terminals.push({ id, ok: true });
      } catch (error) { this.cleanup.errors.push({ terminal: id, error: error.message }); }
    }
    for (const target of this.owned.slice().reverse()) {
      try {
        if (!target.thread) {
          const row = (await this.overview()).sessions.find(row => row.app === target.app && (row.workspace || row.cwd) === target.root);
          if (row) { target.thread = row.threadId; await this.persistResources(); }
        }
        if (target.thread) await this.cleanupSession(target);
        this.cleanup.sessions.push({ thread: target.thread, root: target.root, ok: true });
      }
      catch (error) { this.cleanup.errors.push({ thread: target.thread, error: error.message }); }
    }
    try { this.cleanup.restoration = await browserDeadline(this.options.timeout, '恢复原可见视图', () => this.restoreOriginal()); }
    catch (error) {
      this.cleanup.restoration = { status: 'failed', reason: error.message };
      this.cleanup.errors.push({ restore: error.message });
    }
    if (!this.cleanup.errors.length && this.owned.length) {
      try { this.cleanup.platform = await platform.cleanupProjects(this.directory, this.options.registryConfig, this.computer, () => this.overview()); }
      catch (error) { this.cleanup.errors.push({ projects: error.message }); }
    }
    for (const name of ['files', 'downloads', 'office-downloads', 'preview-downloads', 'zip-downloads']) {
      try { await fs.rm(path.join(this.directory, name), { recursive: true, force: true }); }
      catch (error) { this.cleanup.errors.push({ temporary: name, error: error.message }); }
    }
    await this.persistResources(); return this.cleanup;
  }
}
