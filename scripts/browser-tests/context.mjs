import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Unavailable, pause } from './browser.mjs';

export const attr = value => JSON.stringify(String(value));
export const by = (name, value) => `[${name}=${attr(value)}]`;

export class Context {
  constructor(browser, options, directory) {
    this.b = browser; this.options = options; this.directory = directory;
    this.owned = []; this.terminals = []; this.fusion = []; this.data = new Map();
    this.marker = 'RAQA-' + path.basename(directory); this.cleanup = { sessions: [], terminals: [], errors: [] };
    this.assertions = [];
  }
  check(value, message) { this.assertions.push(message); assert(value, message); }
  equal(actual, expected, message) { this.assertions.push(message); assert.equal(actual, expected, message); }
  async start() {
    this.original = await this.b.read(`({computer:currentComputer()?.id,target:winBinding?.target||(lastChat?.thread?{computer:currentComputer()?.id,win:currentApp,windowId:viewSel.split('|')[1],threadId:lastChat.thread}:null),mode,
      overview:{...ovS},conversation:document.body.classList.contains('conv'),width:innerWidth,height:innerHeight,
      theme:store.get('theme')||'dark',language:I18N.lang,draft:text.value,
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
        root:r.workspace||'',state:r.state,title:r.title}))`);
  }
  async target(app, slot = 'A', owned = false) {
    if (owned) {
      const previous = this.owned.find(row => row.app === app && row.slot === slot);
      return previous || this.create(app, slot);
    }
    const rows = await this.rows(app), selected = this.options.targets?.[app]?.[slot];
    const target = selected ? rows.find(row => row.thread === selected) : rows.find(row => row.thread && row.state !== 'run');
    if (!target) throw new Unavailable(`${app} 没有可读的空闲会话`);
    return target;
  }
  async reveal(target) {
    const b = this.b; await b.home();
    await b.click('#ovLevels [data-v="projects"]');
    const project = `[data-ov="proj"]${by('data-id', target.project)}`;
    if (!await b.has(project)) {
      const fold = `[data-ov="fold"]${by('data-id', target.comp)}`;
      if (await b.has(fold)) await b.click(fold);
    }
    await b.click(project);
    const card = by('data-ov-session', target.key);
    if (!await b.has(card)) {
      const groups = await b.read("[...document.querySelectorAll('[data-ov=group][aria-expanded=false]')].map(e=>e.dataset.id)");
      for (const group of groups) { await b.click(`[data-ov="group"]${by('data-id', group)}`); if (await b.has(card)) break; }
    }
    await b.wait(`!!document.querySelector(${attr(card)})`, '会话卡片');
    return card;
  }
  async open(target) {
    const b = this.b, card = await this.reveal(target), started = Date.now();
    await b.click(`${card} [data-ov="full"]`);
    const outcome = await b.wait(`ovOpening?.phase==='error'?{error:ovOpening.message}:
      windowReady&&!navigationPending&&lastChat?.thread===${attr(target.thread)}&&currentApp===${attr(target.app)}&&document.body.classList.contains('conv')?{ready:true}:null`, '会话新鲜首屏');
    if (outcome.error) throw new Error('会话打开失败：' + outcome.error);
    return { elapsedMs: Date.now() - started, ...await b.snapshot() };
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
    await b.click('#pickAgents'); await b.click('#sheet [data-act="projects"]');
    await b.click('#sheet [data-project-path]'); await b.fill('#computerFilePath', root);
    await b.click('#computerFilePathForm button[type="submit"]');
    await b.wait(`computerFiles?.directory?.path===${attr(root.replaceAll(path.sep, '/'))}&&!computerFiles?.message`, '测试项目目录');
    const previous = await b.read('lastChat?.thread');
    await b.click('[data-computer-project="chat"]');
    await b.wait(`(windowReady&&lastChat?.thread&&lastChat.thread!==${attr(previous)})||!!document.querySelector('[data-project-trust="yes"]')`, '项目创建或信任确认');
    if (await b.has('[data-project-trust="yes"]')) await b.click('[data-project-trust="yes"]');
    await b.wait(`windowReady&&!navigationPending&&lastChat?.thread&&lastChat.thread!==${attr(previous)}&&currentApp===${attr(app)}`, '新建会话', this.options.timeout);
    const thread = await b.read('lastChat.thread');
    const row = await b.wait(`ovRecs().find(r=>r.comp===${attr(this.computer)}&&r.app===${attr(app)}&&r.threadId===${attr(thread)})||null`, '新建会话目录');
    const target = { key: row.key, project: row.project, app, comp: row.comp, thread, window: row.windowId, win: row.win, root, slot };
    this.owned.push(target); await this.persistResources();
    await this.verifyProject(target); return target;
  }
  async verifyProject(target) {
    const rows = await this.overview();
    const row = rows.sessions.find(row => row.app === target.app && row.threadId === target.thread);
    assert(row, '原生目录没有新会话');
    const actual = row.workspace || row.cwd;
    assert(actual, '原生目录未返回项目路径');
    const normalize = value => process.platform === 'win32' ? path.resolve(value).replaceAll('\\', '/').toLowerCase() : path.resolve(value);
    assert.equal(normalize(actual), normalize(target.root), '项目归属不一致');
    return { thread: target.thread, root: target.root };
  }
  async overview() { return this.b.read("(async()=>{const r=await api('/api/overview');if(!r.ok)throw Error('原生目录 HTTP '+r.status);return r.json()})()"); }
  async preview(target) {
    const query = new URLSearchParams({ win: target.win, windowId: target.window, threadId: target.thread });
    return this.b.read(`(async()=>{const r=await api(${attr('/api/overview/preview?' + query)});if(!r.ok)throw Error('原生摘要 HTTP '+r.status);return r.json()})()`);
  }
  async draft(value, selector = '#text') {
    await this.b.fill(selector, value);
    await this.b.wait('draftAckRevision===draftRevision', '原生草稿回执');
  }
  async send(target, text, options = {}) {
    const b = this.b;
    assert(this.owned.some(row => row.thread === target.thread && row.app === target.app)
      || this.fusion.some(row => row.thread === target.thread && row.app === target.app), '发送目标必须属于本轮');
    assert.equal(await b.read('lastChat?.thread'), target.thread, '发送前目标发生变化');
    const before = await b.read('(lastChat?.items||[]).filter(i=>i.k===\'human\').map(i=>i.i)');
    if (text) await this.draft(text);
    await b.click(options.now ? '#sendNow' : '#send');
    await b.wait(`pendingSends.size===0&&(lastChat?.items||[]).some(i=>i.k==='human'&&!${JSON.stringify(before)}.includes(i.i)${text ? `&&i.t?.includes(${attr(text)})` : '&&i.images?.length'})`, '原生发送接受', this.options.timeout);
    const receipt = await b.read(`({thread:lastChat.thread,draftLength:text.value.length,pending:pendingSends.size,
      ids:lastChat.items.filter(i=>i.k==='human'&&!${JSON.stringify(before)}.includes(i.i)).map(i=>i.i)})`);
    assert.equal(receipt.ids.length, 1, '同一次发送出现重复原生用户消息');
    if (options.complete !== false) await b.wait('!lastChat.busy', '原生生成完成', this.options.generationTimeout);
    return receipt;
  }
  async menu(kind) {
    const b = this.b; await b.dismiss();
    if (kind === 'effort') { await this.menu('model'); await b.click('#sheet [data-effort-open]'); }
    else {
    const selectors = { model: '#pickModel', permission: '#pickPerm', mode: '#pickMode' };
    if (selectors[kind] && await b.has(selectors[kind])) await b.click(selectors[kind]);
    else await b.menu(kind);
    }
    await b.wait(`!menuPending&&document.querySelectorAll('#sheet [data-kind=${attr(kind)}]').length>0`, kind + ' 原生候选');
    return b.read(`[...document.querySelectorAll('#sheet [data-kind=${attr(kind)}]')].map(e=>({label:e.dataset.label,checked:e.classList.contains('cur'),disabled:e.disabled}))`);
  }
  async cleanupSession(target) {
    const b = this.b; await b.dismiss();
    const card = await this.reveal(target); await b.hold(`${card} .ov-title`);
    await b.wait("sheetKind==='agent-actions'", '会话管理菜单');
    const archive = '#sheet [data-agent-action="archive"]', remove = '#sheet [data-agent-action="delete"]';
    const selector = await b.has(archive) ? archive : remove;
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
        await b.click('#pickTerms'); await b.click(by('data-term-del', id)); await b.click('#askOk');
        await b.click('#pickTerms');
        await b.wait(`!document.querySelector(${attr(by('data-term', id))})`, '终端关闭后从原生列表移除');
        await b.dismiss();
        this.cleanup.terminals.push({ id, ok: true });
      } catch (error) { this.cleanup.errors.push({ terminal: id, error: error.message }); }
    }
    for (const target of this.owned.slice().reverse()) {
      try { await this.cleanupSession(target); this.cleanup.sessions.push({ thread: target.thread, ok: true }); }
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
      }
      if (!this.original.conversation) await b.home();
      if (await b.has(`#ovLevels [data-v=${attr(this.original.overview.level)}]`))
        await b.click(`#ovLevels [data-v=${attr(this.original.overview.level)}]`);
      await b.viewport(this.original.width, this.original.height);
      this.cleanup.restored = await b.snapshot();
      assert.equal(await b.read('text.value'), this.original.draft, '原草稿未恢复');
    } catch (error) { this.cleanup.errors.push({ restore: error.message }); }
    if (!this.cleanup.errors.length && this.owned.length) await fs.rm(path.join(this.directory, 'projects'), { recursive: true });
    await this.persistResources(); return this.cleanup;
  }
}
