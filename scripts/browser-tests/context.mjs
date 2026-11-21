import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Unavailable, pause } from './browser.mjs';

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
    this.original = await this.b.read(`({computer:currentComputer()?.id,target:windowReady?(winBinding?.target||(lastChat?.thread?{computer:currentComputer()?.id,win:currentApp,windowId:viewSel.split('|')[1],threadId:lastChat.thread}:null)):null,mode,
      overview:{...ovS},conversation:document.body.classList.contains('conv'),width:innerWidth,height:innerHeight,
      theme:store.get('theme')||'dark',language:I18N.lang,draft:text.value,inputExpanded:document.getElementById('composerFold').getAttribute('aria-expanded'),
      expanded:[...ovExpanded],collapsed:[...ovCollapsed]})`);
    this.computer = this.options.computer || this.original.computer;
    if (!this.computer) throw new Unavailable('没有已配对的执行电脑');
    if (this.options.computer && this.options.computer !== this.original.computer)
      throw new Unavailable('请先在既有配对浏览器选择 --computer 指定的电脑');
    this.initial = await this.b.snapshot();
  }
  async rows(app) {
    return this.b.read(`ovRecs().filter(r=>r.comp===${attr(this.computer)}${app ? `&&r.app===${attr(app)}` : ''}&&!r.fusion&&!r.off)
      .map(r=>({key:r.key,project:r.project,app:r.app,comp:r.comp,thread:r.threadId,window:r.windowId,win:r.win,
        root:r.workspace||'',state:r.state,title:r.title,missing:r.workspaceMissing}))`);
  }
  async target(app, slot = 'A', owned = false) {
    if (owned) {
      if (['fold', 'models', 'commands', 'terminal'].includes(slot)) slot = 'A';
      const previous = this.owned.find(row => row.app === app && row.slot === slot);
      if (previous && !previous.thread && !previous.projectRead) throw new Unavailable(`${app} 的 ${slot} 测试会话创建结果待核对`);
      const target = await this.prerequisite(`create:${app}:${slot}`, async () => previous || this.create(app, slot));
      return target;
    }
    const rows = await this.rows(app), selected = this.options.targets?.[app]?.[slot];
    if (slot === 'long' && !selected) throw new Unavailable(`${app} 需要通过 --targets 登记真实 long 会话，不用普通空闲会话替代`);
    const target = selected ? rows.find(row => row.thread === selected && !row.missing) : rows.find(row => row.thread && row.state !== 'run' && !row.missing);
    if (!target) throw new Unavailable(`${app} 没有可读的空闲会话`);
    return target;
  }
  async reveal(target, level = 'projects') {
    await this.refreshTarget(target);
    const b = this.b; await b.home();
    await b.click(`#ovLevels [data-v="${level}"]`);
    const project = `[data-ov="proj"]${by('data-id', target.project)}`;
    const card = by('data-ov-session', target.key);
    if (await b.read(`ovCollapsed.has(${attr(target.comp)})`)) {
      const fold = `[data-ov="fold"]${by('data-id', target.comp)}`;
      await b.click(fold);
    }
    if (level === 'projects') await b.click(project);
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
        windowReady&&!navigationPending&&lastChat?.thread===${attr(target.thread)}&&currentApp===${attr(target.app)}&&document.body.classList.contains('conv')?{ready:true}:null`, '会话新鲜首屏');
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
  async create(app, slot) {
    const b = this.b, seed = await this.target(app), root = path.resolve(this.directory, 'projects', app, slot);
    await fs.mkdir(root, { recursive: true }); await this.open(seed);
    const target = { app, comp: this.computer, thread: '', root, slot, owned: true };
    this.owned.push(target); await this.persistResources();
    await this.openProject(target);
    if (target.thread) await this.refreshTarget(target);
    target.projectRead = await this.verifyProject(target);
    await this.persistResources(); return target;
  }
  async refreshTarget(target) {
    if (!target.thread) return target;
    const row = await this.b.wait(`ovRecs().find(r=>r.comp===${attr(target.comp)}&&r.app===${attr(target.app)}&&r.threadId===${attr(target.thread)})||null`, '按原生身份定位会话');
    Object.assign(target, { key: row.key, project: row.project, window: row.windowId, win: row.win });
    return target;
  }
  async openProject(target) {
    const b = this.b, { app, root } = target;
    await b.click('#pickAgents'); await b.click('#sheet [data-act="projects"]');
    await b.fill('#computerFilePath', root);
    await b.click('#computerFilePathForm button[type="submit"]');
    await b.wait(`computerFiles?.directory?.path===${attr(root.replaceAll(path.sep, '/'))}&&!computerFiles?.message`, '测试项目目录');
    const previous = await b.read('lastChat?.thread');
    await b.click('[data-computer-project="chat"]');
    const ready = `windowReady&&!navigationPending&&lastChat?.thread&&lastChat.thread!==${attr(previous)}&&currentApp===${attr(app)}`;
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
      if (options.complete !== false) await this.prerequisite(`generation:${target.app}:${target.thread}`,
        () => this.finishGeneration(target, '原生生成完成'));
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
    })()`, label, this.options.generationTimeout);
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
  async cleanupSession(target) {
    const b = this.b; await b.dismiss();
    await this.open(target);
    if (await b.read('lastChat.busy')) {
      if (await b.read("document.getElementById('composerFold').getAttribute('aria-expanded')==='false'")) await b.click('#composerFold');
      await b.click('#stop'); await b.click('#askOk');
      await b.wait('!lastChat.busy', '停止本轮测试会话后清理');
    }
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
  async finish() {
    const b = this.b;
    for (const run of this.fusion.slice().reverse()) {
      try {
        await b.home(); await b.click('#ovLevels [data-v="fusion"]');
        const card = `[data-fusion-open]${by('data-fusion-open', run.id)}${by('data-computer', this.computer)}`;
        await b.hold(card); await b.click('#sheet [data-agent-action="remove"]');
        if (await b.has('#askOk')) await b.click('#askOk');
        await b.wait(`!fusionWorkspaces.get(${attr(this.computer)})?.runs.some(r=>r.id===${attr(run.id)})`, '测试工作台删除');
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
    try {
      await b.dismiss();
      if (await b.has('#transferClose')) await b.click('#transferClose');
      if (await b.has('#vClose')) await b.click('#vClose');
      if (this.original.target?.threadId && (await b.read('lastChat?.thread') !== this.original.target.threadId || this.original.conversation)) {
        const row = (await this.rows()).find(row => row.thread === this.original.target.threadId && row.comp === this.original.computer);
        if (row) await this.open(row);
        else throw new Error('原会话已不在目录中，保留现场');
        if (this.original.mode === 'terminal') await b.click('#tabTerm');
        if (this.original.mode === 'chat' && await b.read("document.getElementById('composerFold').getAttribute('aria-expanded')") !== this.original.inputExpanded)
          await b.click('#composerFold');
      }
      if (!this.original.conversation) await b.home();
      if (await b.has(`#ovLevels [data-v=${attr(this.original.overview.level)}]`))
        await b.click(`#ovLevels [data-v=${attr(this.original.overview.level)}]`);
      await b.viewport(this.original.width, this.original.height);
      this.cleanup.restored = await b.snapshot();
      assert.equal(await b.read('text.value'), this.original.draft, '原草稿未恢复');
    } catch (error) { this.cleanup.errors.push({ restore: error.message }); }
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
