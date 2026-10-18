import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { workspaces, windowRoots } from '../../lib/files.mjs';
import { saveState, computerId } from '../../lib/auth.mjs';
import { mod, findBin } from '../../lib/platform.mjs';
import { Cdp } from '../cdp.mjs';
import { listWindows, codexWindows, codexContext } from '../windows.mjs';
import { CODEX_CDP_URL, EDITORS } from '../config.mjs';
import { PAGE_SRC, helpersCall } from '../page/build.mjs';
import { AgentContext, FOCUS_COMPOSER, safeHomePath, projectList, openFolder } from '../agent/context.mjs';
import { FUSION_ACTIVE, fusionHistory, conversationProjects, fusionWorkers,
  newFusionRun, fusionCursorProjects, fusionProject, fusionModelSpec, fusionHtml, fusionMark, fusionLastAssistant } from './state.mjs';
import '../apps/index.mjs';

const execFileAsync = promisify(execFile);

export const FUSION_OWNER = {
fusionFinishJob() {
  this.fusionJob = null;
  this.fusionFlushUsage();
  if (fusionWorkers.get(this.fusionWorkerKey) === this) fusionWorkers.delete(this.fusionWorkerKey);
},

fusionProgress(side, items, complete = false) {
  const f = this.fusionRun;
  const prefix = `${f.id}:${f.turn}:${f.round}:${f.phase}:${side}:`;
  const known = new Map((f.progress || []).map(it => [it.i, it]));
  for (const it of items) {
    if (it.k === 'human' || (it.k === 'thinking' && !it.t?.includes('\n'))) continue;
    const i = prefix + it.i;
    const entry = { ...it, i, fusionPhase: f.phase, b: undefined, agents: undefined, btnItem: undefined, f: undefined };
    if (it.k === 'assistant') entry.h = `<div class="hint">${side.toUpperCase()}</div>` + (it.h || fusionHtml(it.t));
    if (it.k === 'thinking') entry.t = `${side.toUpperCase()} · ${it.t}`;
    known.set(i, entry);
  }
  if (complete) for (const [id, it] of known) {
    if (id.startsWith(prefix) && it.k === 'assistant') known.delete(id);
    else if (id.startsWith(prefix)) it.live = false;
  }
  const next = [...known.values()];
  if (JSON.stringify(next) !== JSON.stringify(f.progress || [])) {
    f.progress = next;
    this.fusionEmit();
  }
},

fusionItems(f = this.fusionRun) {
  if (!f) return [];
  const prefix = `${f.id}:${f.turn || 0}`;
  const push = (i, k, t) => t ? (k === 'human' ? { i: `${prefix}:${i}`, k, t } : { i: `${prefix}:${i}`, k: 'assistant', h: fusionHtml(t) }) : null;
  const progress = phase => (f.progress || []).filter(it => it.fusionPhase === phase);
  return [
    push('task', 'human', f.task), ...progress('planning'), push('plan', 'assistant', f.plan ? `方案\n${f.plan}` : ''),
    push('echo', 'assistant', f.echo ? `B 的复述\n${f.echo}` : ''),
    ...progress('execute'), push('result', 'assistant', f.result ? `B 的结果\n${f.result}` : ''),
    push('diff', 'assistant', f.diff ? `文件变更\n${f.diff}` : ''),
    ...progress('review'), ...progress('fix'), push('review', 'assistant', f.review ? `A 的检查\n${f.review}` : ''),
  ].filter(Boolean);
},

fusionEmit() {
  const f = this.fusionRun;
  if (!f) return;
  f.updated = Date.now();
  if (!this.fusionWorkerKey) this.fusionSaved.current = f.id;
  const index = this.fusionSaved.runs.findIndex(r => r.id === f.id);
  if (index < 0) this.fusionSaved.runs.push(f);
  else this.fusionSaved.runs[index] = f;
  saveState({ fusionHistory });
  if (this.windowId !== 'fusion') return;
  const side = spec => spec ? { id: spec.id, app: spec.app, title: spec.title, conversationTitle: spec.conversationTitle, model: spec.model || '', usage: spec.usage || {} } : null;
  this.emit({ t: 'chat', sel: `fusion|fusion|${f.id}`, chat: {
    items: [...(f.history || []), ...this.fusionItems(f)], earlier: false,
    global: [], busy: FUSION_ACTIVE.includes(f.phase), queued: [], changed: 0, questions: null, readonly: false,
    model: '', title: (f.history?.find(i => i.k === 'human')?.t || f.task || '新 Fusion 会话').split('\n')[0].slice(0, 60), thread: f.id,
    fusion: { project: f.project || null, phase: f.phase || 'idle', round: f.round || 0, a: side(f.a), b: side(f.b), busy: FUSION_ACTIVE.includes(f.phase) },
  } });
},

fusionListHistory() {
  this.emit({ t: 'fusionHistory', current: this.fusionRun?.id, list: [...this.fusionSaved.runs].sort((a, b) => b.updated - a.updated).map(f => ({
    id: f.id, title: (f.history?.find(i => i.k === 'human')?.t || f.task || '新 Fusion 会话').split('\n')[0].slice(0, 60), updated: f.updated,
  })) });
},

async fusionOpenHistory(id) {
  if (this.fusionCreating) throw new Error('正在创建会话，请稍后再切换');
  if (this.fusionJob) throw new Error('Fusion 正在进行，先停止再切换历史');
  const f = id ? this.fusionSaved.runs.find(f => f.id === id) : newFusionRun();
  if (!f) throw new Error('没有这个 Fusion 会话');
  this.fusionRun = f;
  this.clearViewState();
  this.threadId = f.id;
  this.emit({ t: 'thread', windowId: 'fusion', threadId: f.id, sel: this.selectionKey() });
  this.fusionEmit();
  if (f.a || f.b) { await this.fusionCatalog(); this.fusionEmit(); }
},

fusionUsageEmit() {
  if (this.windowId !== 'fusion') return;
  const f = this.fusionRun;
  if (f.a && f.b && f.a.id === f.b.id && this.fusionSideLive) {
    const active = f[this.fusionSideLive];
    const other = f[this.fusionSideLive === 'a' ? 'b' : 'a'];
    other.usage = { ...other.usage, context: active.usage?.context };
  }
  this.emit({ t: 'fusionUsage', sel: `fusion|fusion|${this.fusionRun.id}`, a: this.fusionRun.a?.usage || {}, b: this.fusionRun.b?.usage || {} });
},

async fusionUsage(automatic = false, only = '') {
  if (!this.fusionWorkerKey && this.fusionRun) {
    const worker = fusionWorkers.get(JSON.stringify([this.deviceId, this.fusionRun.id]));
    if (worker) return worker.fusionUsage(automatic, only);
  }
  if (this.fusionHold || this.fusionJob) {
    this.fusionUsagePending = { automatic, only };
    return this.fusionUsageEmit();
  }
  this.fusionUsagePending = null;
  const f = this.fusionRun;
  const sides = only ? [only] : f?.a && f?.b && f.a.id === f.b.id ? ['a'] : ['a', 'b'];
  for (const side of sides) {
    const spec = f?.[side];
    if (!spec) continue;
    const usage = await this.withFusionSideSpec(spec, async function () {
      const active = await this.cdp.evaluate(helpersCall('activeThread()'));
      const context = active === spec.agentId
        ? spec.app === 'codex' ? codexContext(active) : await this.cdp.evaluate(helpersCall('contextPct()'))
        : spec.usage?.context;
      try {
        const account = spec.app === 'codex' ? await this.readCodexAccount({ manual: !automatic, fusion: true })
          : spec.app === 'devin' ? await this.cdp.evaluate(helpersCall('readDevinUsage(true)')) : await this.withFocus(() => this.readCursorUsage(automatic));
        return { context, updated: Date.now(), ...(account || { missing: true }) };
      } catch (e) { return { ...spec.usage, context, error: e.message, cached: true }; }
    }, false).catch(e => ({ ...spec.usage, error: e.message, cached: true }));
    if (this.fusionRun === f && f[side] === spec) {
      spec.usage = usage;
      const other = f[side === 'a' ? 'b' : 'a'];
      if (other?.id === spec.id) other.usage = { ...usage };
    }
    this.fusionUsageEmit();
  }
  this.fusionEmit();
},

fusionFlushUsage() {
  const pending = this.fusionUsagePending;
  this.fusionUsagePending = null;
  if (pending && this.windowId === 'fusion') this.fusionUsage(pending.automatic, pending.only).catch(e => this.emit({ t: 'status', ok: false, msg: e.message }));
},

async fusionListProjects(dir) {
  if (dir !== undefined) return this.emit({ t: 'fusionProjects', browse: projectList(dir) });
  const projects = [...new Map(workspaces().map(w => {
    const project = fusionProject(w.root, w.host || '');
    return project && (project.host || fs.existsSync(project.root) && fs.statSync(project.root).isDirectory()) && [project.id, project];
  }).filter(Boolean)).values()];
  this.emit({ t: 'fusionProjects', list: projects, unknown: 0 });
},

fusionSetProject(id, folder = '') {
  if (this.fusionCreating) throw new Error('正在创建会话，请稍后再切换项目');
  if (this.fusionJob || FUSION_ACTIVE.includes(this.fusionRun.phase)) throw new Error('这一轮还在进行，先停止再更换项目');
  const workspace = workspaces().find(w => fusionProject(w.root, w.host || '')?.id === id);
  const project = folder ? fusionProject(safeHomePath(folder).real) : workspace && fusionProject(workspace.root, workspace.host || '');
  if (!project) throw new Error('项目未确认，请重新选择');
  if (this.fusionRun.project?.id !== id) {
    this.fusionRun.project = project;
    this.fusionRun.a = this.fusionRun.b = null;
  }
  this.fusionEmit();
},

async fusionCatalog() {
  const sides = [];
  const cursorProjects = fusionCursorProjects();
  const errors = new Map();
  for (const w of await listWindows()) {
    if (w.app === 'fusion') continue;
    const windows = w.app === 'codex' ? await codexWindows(CODEX_CDP_URL) : [w];
    for (const p of windows) {
      if (w.app === 'codex' && !p.chatWs) continue;
      const spec = { id: w.app === 'codex' ? `codex:${p.pageId}` : w.id, app: w.app,
        title: p.title, windowTitle: p.rawTitle || p.title, windowId: p.pageId || w.id,
        ws: p.ws, chatWs: p.chatWs || null };
      let rows;
      try { rows = await this.withFusionSideSpec(spec, async function () {
        if (this.app === 'codex') return this.codexThreadRows();
        if (this.app === 'devin' && await this.cdp.evaluate(helpersCall('devinSurface()')) === 'editor') {
          const rows = await this.cdp.evaluate(helpersCall('agentList()'));
          if (rows?.length) return rows;
          await this.setSurface('agent');
          try { return await this.cdp.evaluate(helpersCall('agentList()')) || []; }
          finally { await this.setSurface('editor'); }
        }
        if (this.app === 'cursor' && await this.cdp.evaluate(helpersCall('clickCloseSettings()'))) await new Promise(r => setTimeout(r, 100));
        return await this.cdp.evaluate(helpersCall('agentList()')) || [];
      }, false); } catch (e) { errors.set(w.app, e.message); continue; }
      for (const row of rows) {
        const roots = windowRoots(spec.windowTitle, spec.app);
        const cursorProject = w.app === 'cursor' ? cursorProjects.get(row.repository) : null;
        const root = row.workspace || cursorProject?.root || (roots.length === 1 ? roots[0].root : '');
        const host = row.workspace ? row.host || '' : cursorProject?.host || roots[0]?.host || '';
        const project = fusionProject(root, host);
        const id = JSON.stringify([computerId(), w.app, host, row.id]);
        const known = conversationProjects[id];
        if (project) conversationProjects[id] = { project, originProject: known?.originProject || known?.project || project };
        sides.push({ ...spec, id, agentId: row.id, available: true, originProject: conversationProjects[id]?.originProject || null,
          conversationTitle: row.title, project: project || known?.project || null,
          title: `${w.app === 'codex' ? 'Codex' : w.app === 'devin' ? 'Devin' : 'Cursor'} · ${p.title} · ${row.title}`,
          workspace: row.workspace || cursorProject?.root || '' });
      }
    }
  }
  for (const side of ['a', 'b']) {
    const spec = this.fusionRun?.[side];
    if (!spec) continue;
    const live = sides.find(s => s.app === spec.app && spec.agentId && s.agentId === spec.agentId && (s.project?.host || '') === (spec.project?.host || ''));
    if (live) Object.assign(spec, live);
    else if (!sides.some(s => s.id === spec.id)) sides.push({ ...spec, available: !!spec.draft });
  }
  this.fusionCatalogErrors = errors;
  this.fusionSides = sides;
  saveState({ conversationProjects });
  return sides;
},

async fusionListSides(side) {
  if (!this.fusionRun.project) throw new Error('先选择项目');
  const catalog = await this.fusionCatalog();
  const selected = [this.fusionRun.a, this.fusionRun.b].filter(Boolean);
  const list = catalog.filter(s => s.project?.id === this.fusionRun.project.id || selected.some(p => p.id === s.id));
  this.emit({ t: 'fusionSides', side: side === 'b' ? 'b' : 'a', apps: EDITORS.map(({ app, name }) => ({ app, name,
    unavailable: this.fusionCatalogErrors?.get(app) ? '读取失败：' + this.fusionCatalogErrors.get(app) : catalog.some(s => s.app === app && s.project && s.project.id !== this.fusionRun.project.id) ? '已打开的会话属于其他项目，请先在电脑上打开所选项目' : catalog.some(s => s.app === app && !s.project) ? '无法确认会话所属项目，请先在电脑上打开所选项目' : '当前项目没有已打开的会话',
  })), list: list.map(s => ({ ...s, ws: undefined, chatWs: undefined, unavailable: !s.available ? '暂不可连接，原选择已保留' : s.project?.id !== this.fusionRun.project.id ? '执行目录与所选项目不同' : '' })),
    other: catalog.filter(s => s.project?.id !== this.fusionRun.project.id && !list.includes(s)).map(({ id, app, conversationTitle, project }) => ({ id, app, conversationTitle, project })) });
},

async fusionSetSide(side, id) {
  if (this.fusionCreating) throw new Error('正在创建会话，请稍后再更换');
  const which = side === 'b' ? 'b' : 'a';
  if (!this.fusionRun) this.fusionRun = newFusionRun();
  if (['planning', 'echo', 'echo-check', 'execute', 'review', 'fix'].includes(this.fusionRun.phase)) throw new Error('这一轮还在进行，先停止再更换');
  const spec = this.fusionSides?.find(s => s.id === id);
  if (!spec?.available) throw new Error('会话暂不可连接，原选择已保留，请重新读取列表');
  if (!this.fusionRun.project || spec.project?.id !== this.fusionRun.project.id) throw new Error('会话不属于所选项目');
  const model = await this.withFusionSideSpec(spec, async function () {
    await this.fusionCheckProject(spec.project);
    const chat = await this.cdp.evaluate(helpersCall('extract()'));
    return chat?.model || '';
  });
  this.fusionRun[which] = { ...spec, ...fusionModelSpec(model) };
  this.fusionEmit();
  await this.fusionUsage(true, which);
  this.emit({ t: 'status', ok: true, msg: which === 'a' ? `A：${spec.title}` : `B：${spec.title}` });
  await this.fusionModelMenu(which);
},

async fusionConfirmTrust(approve) {
  const pending = this.fusionPendingTrust;
  if (!pending || pending.runId !== this.fusionRun?.id || pending.project.id !== this.fusionRun?.project?.id) throw new Error('项目已改变，请重新创建会话');
  this.fusionPendingTrust = null;
  if (!approve) return this.emit({ t: 'status', ok: true, msg: '已取消创建，原会话保留' });
  await this.withFusionSideSpec(pending.spec, async function () {
    this.pendingProject = { root: pending.project.root, app: this.app, windowId: this.windowId };
    this.finishProject = async () => { this.pendingProject = null; };
    await this.confirmProjectTrust(true);
  }, false);
  return this.fusionNewSide(pending.side, pending.app, pending.resumeContext);
},

async fusionContinue(side, id) {
  if (FUSION_ACTIVE.includes(this.fusionRun?.phase) || this.fusionCreating) throw new Error('这一轮还在进行');
  const source = this.fusionSides?.find(s => s.id === id && s.available);
  if (!source) throw new Error('原会话暂不可连接');
  const context = await this.withFusionSideSpec(source, async function () {
    const chat = await this.cdp.evaluate(helpersCall('extract()'));
    if (chat?.busy) throw new Error('原会话正在运行，请完成后再续接');
    return (chat?.items || []).filter(i => ['human', 'assistant'].includes(i.k)).slice(-8).map(i => `${i.k}: ${String(i.t || i.h || '').replace(/<[^>]*>/g, ' ').slice(0, 1500)}`).join('\n').slice(-6000);
  });
  await this.fusionNewSide(side, source.app, context);
},

async fusionNewSide(side, app, resumeContext = '') {
  if (this.fusionCreating) return;
  if (!['cursor', 'devin', 'codex'].includes(app)) throw new Error('请选择 Cursor、Devin 或 Codex');
  const f = this.fusionRun, project = f?.project, which = side === 'a' ? 'a' : 'b';
  if (!project) throw new Error('先选择项目');
  if (FUSION_ACTIVE.includes(f.phase)) throw new Error('这一轮还在进行，先停止再新建');
  this.fusionCreating = true;
  try {
    let target;
    const openingCodex = new Set();
    for (let i = 0; i < 40 && !target; i++) {
      const windows = app === 'codex' ? (await codexWindows(CODEX_CDP_URL)).map(p => ({ ...p, id: `codex:${p.pageId}`, app, title: p.rawTitle, windowId: p.pageId, windowTitle: p.rawTitle })) : (await listWindows()).filter(w => w.app === app);
      for (const w of windows) {
        const matches = await this.withFusionSideSpec({ ...w, windowId: w.windowId || w.id, windowTitle: w.title }, async function () {
          if (app === 'cursor') await this.cdp.evaluate(helpersCall('clickCloseSettings()'));
          const current = app === 'cursor' ? await this.cdp.evaluate(helpersCall('cursorWorkspace()')) || windowRoots(await this.editorCdp.evaluate('document.title'), app)[0] : app === 'codex' ? windowRoots(await this.editorCdp.evaluate('document.title'), app)[0] : windowRoots(await this.editorCdp.evaluate('document.title'), app)[0];
          return fusionProject(current?.root, current?.host || '')?.id === project.id;
        }, false);
        if (matches && app === 'codex' && !w.chatWs) {
          if (!openingCodex.has(w.id)) {
            openingCodex.add(w.id);
            await this.withFusionSideSpec({ ...w, windowId: w.windowId, windowTitle: w.title }, async function () {
              await this.key(mod('Shift+p'), { cdp: this.editorCdp });
              await this.editorCdp.send('Input.insertText', { text: 'Codex: Open Codex Sidebar' });
              await new Promise(r => setTimeout(r, 200));
              await this.key('Enter', { cdp: this.editorCdp });
            }, false);
          }
          continue;
        }
        if (matches || (app === 'devin' && !project.host)) { target = w; break; }
      }
      if (!target) {
        if (!i) {
          if (project.host) throw new Error('远程项目尚未打开，请先在电脑上打开所选项目');
          this.emit({ t: 'status', ok: true, msg: '正在打开项目…' }); await openFolder(project.root, app, true);
        }
        await new Promise(r => setTimeout(r, 250));
      }
    }
    if (!target) throw new Error('项目没有打开成功，请检查电脑上的软件窗口');
    this.emit({ t: 'status', ok: true, msg: '正在创建会话…' });
    const spec = { ...target, windowId: target.windowId || target.id, windowTitle: target.title, project, workspace: project.root };
    const created = await this.withFusionSideSpec(spec, async function () {
      if (app === 'devin' && await this.cdp.evaluate(helpersCall('devinSurface()')) === 'editor') await this.setSurface('agent');
      const trust = await this.editorCdp.evaluate(helpersCall('workspaceTrustState()'));
      if (trust.required) {
        this.fusionOwner.fusionPendingTrust = { side: which, app, project, spec, resumeContext, runId: f.id };
        this.emit({ t: 'fusionTrust', path: project.root });
        return null;
      }
      const before = await this.cdp.evaluate(helpersCall('activeThread()'));
      if (app === 'codex') {
        const emit = this.emit;
        this.emit = () => {};
        try { await this.newCodexChat(); } finally { this.emit = emit; }
      } else await this.pressControl('newChat');
      if (app === 'cursor') {
        await new Promise(r => setTimeout(r, 200));
        const current = await this.cdp.evaluate(helpersCall('cursorWorkspace()')) || windowRoots(await this.editorCdp.evaluate('document.title'), app)[0];
        if (fusionProject(current?.root, current?.host || '')?.id !== project.id && !await this.cdp.evaluate(helpersCall(`cursorSelectProject(${JSON.stringify(project.root)}, ${JSON.stringify(project.host || '')})`))) throw new Error('新会话的项目选项尚未加载');
      }
      if (app === 'devin') {
        for (let i = 0; i < 20 && !await this.cdp.evaluate(helpersCall('workdirInfo()')); i++) await new Promise(r => setTimeout(r, 150));
        const current = windowRoots(await this.editorCdp.evaluate('document.title'), app)[0];
        if (fusionProject(current?.root, current?.host || '')?.id !== project.id) await this.workdirPick(project.name, project.root, 60000);
      }
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 150));
        const chat = await this.cdp.evaluate(helpersCall('extract()'));
        if (chat && (!chat.thread || chat.thread !== before) && !chat.items?.length && await this.cdp.evaluate(helpersCall('hasComposer()'))) {
          await this.fusionCheckProject(project);
          return chat;
        }
      }
      throw new Error('没有读到新会话，请检查电脑上的新建界面');
    }, false);
    if (!created) return;
    const id = JSON.stringify([computerId(), app, project.host || '', created.thread || crypto.randomUUID()]);
    const other = f[which === 'a' ? 'b' : 'a'];
    if (created.thread && other?.agentId === created.thread) throw new Error('新建未产生独立会话，原选择已保留');
    f[which] = { ...spec, id, agentId: created.thread || '', draft: !created.thread, resumeContext, available: true,
      conversationTitle: created.title || '新会话', title: `${app === 'codex' ? 'Codex' : app === 'cursor' ? 'Cursor' : 'Devin'} · 新会话`, ...fusionModelSpec(created.model) };
    this.fusionEmit();
    await this.fusionListSides(which);
    this.emit({ t: 'status', ok: true, msg: '已创建并选择新会话' });
    await this.fusionModelMenu(which);
  } finally { this.fusionCreating = false; }
},

async withFusionSideSpec(spec, fn, select = true) {
  const previous = this.fusionAccess || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    this.fusionHold = { app: spec.app, windowId: spec.windowId };
    const session = new AgentContext({ deviceId: this.deviceId });
    session.fusionOwner = this;
    session.emit = obj => this.emit(obj);
    // Everything the old Object.create(this) borrowed context inherited: reads fall through to the
    // owner until the side assigns its own value, which then shadows it like an own property did.
    for (const key of ['visible', 'mode', 'sel', 'dark', 'client', 'targetId', 'pendingThread',
      'lastChat', 'lastChatAt', 'lastAttachments', 'lastBusy', 'lastPanel', 'lastTerm', 'lastTermAt',
      'lastTermHash', 'lastDraft', 'switchingThread', 'polling', 'historyLoading', 'termPolling',
      'pendingProject', 'mentionSeq', 'mentionBusy', 'pendingRevert', 'thinkTries', 'thoughtPoll',
      'usageRead', 'latestThink', 'mainTab', 'sessStore', 'codexHistoryTop', 'codexSettingsOwned',
      'codexSettingsViewWs', 'curSession', 'codexRoots', 'fusion', 'fusionMiss', 'fusionLoading',
      'chatBySel', 'viewport', 'screencast', 'fusionRun', 'fusionCancel', 'fusionSaved', 'fusionHold',
      'fusionAccess', 'fusionConnection', 'fusionSideLive', 'fusionJob', 'fusionPendingTrust',
      'fusionWorkerKey', 'fusionCatalogErrors', 'fusionCreating', 'fusionSides', 'fusionUsagePending']) {
      Object.defineProperty(session, key, {
        configurable: true,
        get: () => this[key],
        set: v => Object.defineProperty(session, key, { value: v, writable: true, configurable: true, enumerable: true }),
      });
    }
    let editor, chat;
    try {
      editor = new Cdp(spec.ws);
      await editor.connect();
      chat = editor;
      if (spec.chatWs) {
        chat = new Cdp(spec.chatWs);
        await chat.connect();
      }
      session.cdp = chat;
      session.editorCdp = editor;
      session.app = spec.app;
      session.winTitle = spec.windowTitle;
      session.windowId = spec.windowId;
      session.codexPageId = spec.app === 'codex' ? spec.windowId : '';
      if (select && spec.app === 'cursor' && await session.cdp.evaluate(helpersCall('clickCloseSettings()'))) await new Promise(r => setTimeout(r, 100));
      if (select && spec.draft && await session.cdp.evaluate(helpersCall('activeThread()'))) {
        const emit = session.emit;
        session.emit = () => {};
        try { await session.newChat(); } finally { session.emit = emit; }
        if (spec.app === 'cursor') await session.cdp.evaluate(helpersCall(`cursorSelectProject(${JSON.stringify(spec.project.root)}, ${JSON.stringify(spec.project.host || '')})`));
      }
      if (select && spec.agentId) {
        if (spec.app === 'codex') {
          if (await session.cdp.evaluate(helpersCall('codexThread()')) !== spec.agentId && !await session.selectCodexThread(spec.agentId)) throw new Error('没有找到选中的会话');
        } else if (spec.agentId.startsWith('tab:')) {
          const pos = await session.cdp.evaluate(helpersCall(`devinTabTarget(${JSON.stringify(spec.agentId.slice(4))})`));
          if (!pos) throw new Error('没有找到选中的会话');
          await session.tapCss(pos.x, pos.y);
        } else if (await session.cdp.evaluate(helpersCall('activeThread()')) !== spec.agentId) {
          const editorSurface = spec.app === 'devin' && await session.cdp.evaluate(helpersCall('devinSurface()')) === 'editor';
          if (editorSurface) await session.openSessionPicker();
          const pos = await session.cdp.evaluate(helpersCall(editorSurface ? `sessionPickerTarget(${JSON.stringify(spec.agentId)})` : `agentTarget(${JSON.stringify(spec.agentId)}, ${spec.app === 'cursor'})`));
          if (!pos) throw new Error('没有找到选中的会话');
          if (pos !== true) await session.tapCss(pos.x, pos.y);
        }
        let active = false;
        for (let i = 0; i < 12 && !active; i++) {
          await new Promise(r => setTimeout(r, 150));
          active = await session.cdp.evaluate(helpersCall(spec.agentId.startsWith('tab:') ? `devinSession()?.tabs?.some(t => t.active && t.id === ${JSON.stringify(spec.agentId.slice(4))})` : `activeThread() === ${JSON.stringify(spec.agentId)}`));
        }
        if (!active) throw new Error('会话切换没有生效');
        session.threadId = await session.cdp.evaluate(helpersCall('activeThread()'));
      }
      this.fusionHold = false;
      this.fusionConnection = session;
      return await fn.call(session);
    } finally {
      this.fusionConnection = null;
      this.fusionHold = false;
      for (const c of new Set([chat, editor])) c?.close();
    }
  });
  this.fusionAccess = operation;
  return operation;
},

async withFusionSide(side, fn) {
  const spec = side === 'b' ? this.fusionRun?.b : this.fusionRun?.a;
  if (!spec?.ws) throw new Error(side === 'b' ? '先选择 B' : '先选择 A');
  this.fusionSideLive = side === 'b' ? 'b' : 'a';
  try { return await this.withFusionSideSpec(spec, fn); }
  finally { this.fusionSideLive = ''; }
},

async fusionAsk(side, prompt) {
  return this.withFusionSide(side, async function () {
    const spec = this.fusionRun[side];
    await this.fusionCheckProject(this.fusionRun.project);
    await this.fusionEnsureModel(spec);
    const draft = await this.fusionDraft();
    if (draft) throw new Error('这一边的输入框里还有内容，Fusion 不会覆盖它');
    const before = await this.cdp.evaluate(helpersCall('extract()'));
    const beforeTurn = this.app === 'codex' ? await this.cdp.evaluate(helpersCall('codexFusionTurn()')) : null;
    const humanIds = new Set((before?.items || []).filter(it => it.k === 'human').map(it => it.i));
    const message = spec.resumeContext ? `以下为旧会话的历史摘录，仅作背景；执行目录为 ${this.fusionRun.project.root}，请以本次要求为准。\n${spec.resumeContext}\n\n${prompt}` : String(prompt);
    const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();
    await this.withFocus(async () => {
      const found = await this.cdp.evaluate(FOCUS_COMPOSER);
      if (!found) throw new Error('没找到这一边的输入框');
      await this.typeText(message);
      if (this.app === 'codex') {
        if (!await this.cdp.evaluate(helpersCall('submitCodexMessage()'))) throw new Error('这一边的发送按钮当前不可用');
      } else await this.key('Enter');
    });
    const deadline = Date.now() + 8 * 60 * 1000;
    let settled = '';
    let requestId = '';
    let expectedThread = before?.thread || '';
    while (Date.now() < deadline) {
      if (this.fusionCancel) throw new Error('已停止');
      await new Promise(r => setTimeout(r, 1200));
      if (this.fusionCancel) throw new Error('已停止');
      const chat = await this.cdp.evaluate(helpersCall('extract()'));
      if (this.app !== 'codex' && expectedThread && chat?.thread !== expectedThread) {
        const submitted = !humanIds.size && !requestId && chat?.items?.some(it => it.k === 'human' && normalize(it.t) === normalize(message));
        if (!submitted) throw new Error('等待回复时会话发生变化');
        expectedThread = chat.thread;
      }
      const spec = this.fusionRun[side];
      if (spec.draft && chat?.thread && chat.items?.some(it => it.k === 'human' && !humanIds.has(it.i) && normalize(it.t) === normalize(message))) {
        spec.agentId = chat.thread;
        spec.id = JSON.stringify([computerId(), this.app, spec.project?.host || '', chat.thread]);
        spec.draft = false;
        this.fusionOwner.fusionEmit();
      }
      spec.usage = { ...spec.usage, context: this.app === 'codex'
        ? codexContext(chat.thread) : chat?.context ?? await this.cdp.evaluate(helpersCall('contextPct()')) };
      this.fusionOwner.fusionUsageEmit();
      let last;
      if (this.app === 'codex') {
        const turn = await this.cdp.evaluate(helpersCall(`codexFusionTurn(${JSON.stringify(requestId)}, ${JSON.stringify(message)}, ${JSON.stringify(beforeTurn?.ids || [])})`));
        if (!requestId && turn?.id) requestId = turn.id;
        last = requestId && turn?.id === requestId ? turn : { text: '' };
      } else {
        const human = [...(chat?.items || [])].reverse().find(it => it.k === 'human' && !humanIds.has(it.i) && normalize(it.t) === normalize(message));
        if (human) requestId = human.i;
        last = requestId ? fusionLastAssistant(chat, requestId) : { text: '' };
      }
      if (requestId) delete spec.resumeContext;
      let items = [];
      if (this.app === 'codex') items = last.items || [];
      else if (requestId) {
        const start = chat.items.findIndex(it => it.i === requestId) + 1;
        if (start) {
          items = chat.items.slice(start);
          const end = items.findIndex(it => it.k === 'human');
          if (end >= 0) items = items.slice(0, end);
          const current = { ...chat, items };
          this.fusionOwner.fusionProgress(side, items);
          if (this.app === 'devin') {
            const live = items.find(it => it.k === 'thinking' && it.live && !this.thinkingBody(it));
            if (live) {
              const body = await this.readThought(live.i);
              if (body) live.t = `${this.thinkingTitle(live)}\n${body}`;
            }
          } else {
            const ids = items.filter(it => it.k === 'thinking' && !this.thinkingBody(it)).map(it => it.i);
            const closed = ids.length ? await this.cdp.evaluate(`(() => { const h = ${PAGE_SRC}; const wanted = ${JSON.stringify(ids)}.map(id => h.thoughtIndexFor(id)); return [...h.closedThinkingIndexes('live'), ...h.closedThinkingIndexes('done')].filter(i => wanted.includes(i)); })()` ) : [];
            if (closed.length) {
              await this.cdp.evaluate(helpersCall(`clickThinking(${JSON.stringify(closed)})`));
              await new Promise(r => setTimeout(r, 250));
              const expanded = await this.cdp.evaluate(helpersCall('extract()'));
              if (expanded?.thread === chat.thread) {
                for (const it of items) {
                  const full = expanded.items?.find(x => x.i === it.i);
                  if (full) Object.assign(it, full);
                }
              }
              await this.cdp.evaluate(helpersCall(`closeThinkingIfOpen(${JSON.stringify(closed)})`));
            }
          }
          await this.captureThoughts(current);
          this.fillThinking(current);
          this.rememberThinking(current);
          this.retainThinking(current);
          items = current.items;
        }
      }
      this.fusionOwner.fusionProgress(side, items);
      const ready = last.text && (this.app === 'codex' ? last.completed : !chat?.busy && last.completed !== false);
      if (ready && settled === last.text) {
        this.fusionOwner.fusionProgress(side, items, true);
        return last.text;
      }
      settled = ready ? last.text : '';
    }
    throw new Error(`等待 ${side.toUpperCase()} 本轮回复超时（阶段：${this.fusionRun.phase}）`);
  });
},

async fusionDiff(side) {
  const spec = side === 'b' ? this.fusionRun?.b : this.fusionRun?.a;
  const roots = windowRoots(spec?.windowTitle || '', spec?.app || 'cursor', spec?.workspace || '');
  const root = roots.find(r => !r.host)?.root || roots[0]?.root;
  if (!root) return '没有定位到工作区';
  try {
    const git = findBin('git');
    let { stdout: out } = await execFileAsync(git, ['diff', 'HEAD', '--', '.'], { cwd: root, encoding: 'utf8', timeout: 8000 });
    const { stdout } = await execFileAsync(git, ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', timeout: 8000 });
    const untracked = stdout.split('\0').filter(Boolean);
    for (const name of untracked) {
      if (out.length >= 10000) break;
      // git diff exits with 1 when changes exist; retain stdout just as the previous spawnSync did.
      const diff = await execFileAsync(git, ['diff', '--no-index', '--', '/dev/null', name], { cwd: root, encoding: 'utf8', timeout: 8000 }).catch(error => error);
      out += diff.stdout || '';
    }
    return out.length > 10000 ? `${out.slice(0, 10000)}\n[差异未完整展示，请按方案检查实际文件]` : out.trim() || '没有未提交的差异';
  } catch {
    return '没有读到 git 差异';
  }
},

async fusionModelMenu(side) {
  const which = side === 'b' ? 'b' : 'a';
  await this.withFusionSide(which, async function () {
    await this.pressControl('model');
    let items = [];
    for (let i = 0; i < 12 && !items.length; i++) {
      await new Promise(r => setTimeout(r, 150));
      items = await this.cdp.evaluate(helpersCall(`menuItems('model')`)) || [];
      if (!items.length) await this.cdp.evaluate(helpersCall('clickModelListTrigger()'));
    }
    await this.closeMenus();
    this.emit({ t: 'menu', kind: `fusion-model-${which}`, items: items.map(it => ({ ...it, params: false })) });
  });
},

async fusionModelPick(side, label, effort = false) {
  const which = side === 'b' ? 'b' : 'a';
  if (FUSION_ACTIVE.includes(this.fusionRun?.phase)) throw new Error('这一轮还在进行，先停止再换模型');
  let options;
  const spec = this.fusionRun[which];
  await this.withFusionSide(which, async function () {
    options = await this.fusionPickNativeModel(label, effort);
    const chat = await this.cdp.evaluate(helpersCall('extract()'));
    Object.assign(spec, fusionModelSpec(chat?.model || label));
    if (options) { spec.modelLabel = label; spec.modelEffort = ''; spec.model = ''; }
  });
  this.fusionEmit();
  if (options) this.emit({ t: 'menu', kind: `fusion-effort-${which}`, items: options });
  this.emit({ t: 'status', ok: true, msg: options ? '请选择推理强度' : `已切换到 ${label}` });
},

fusionStop() {
  if (!this.fusionWorkerKey) return this.fusionWorker().fusionStop();
  this.fusionCancel = true;
  if (this.fusionRun) this.fusionRun.phase = 'idle';
  const live = this.fusionSideLive;
  if (live && this.fusionConnection) this.fusionConnection.stopAgent().catch(() => {});
  this.fusionEmit();
  this.emit({ t: 'status', ok: true, msg: 'Fusion 已停止' });
},

fusionUserSend(text) {
  if (!this.fusionWorkerKey) return this.fusionWorker().fusionUserSend(text);
  const f = this.fusionRun;
  if (!f?.a || !f?.b) throw new Error('先选择 A 和 B');
  if (!f.project || f.a.project?.id !== f.project.id || f.b.project?.id !== f.project.id) throw new Error('先为同一项目选择 A 和 B');
  if (!f.a.model || !f.b.model) throw new Error('先选择 A 和 B 的模型');
  if (this.fusionJob) throw new Error('Fusion 正在进行');
  if (!['idle', 'done', 'stopped'].includes(f.phase)) throw new Error('这一轮还在进行。方案写好后点「执行方案」，或先停止');
  f.history = [...(f.history || []), ...this.fusionItems(f)];
  f.turn = (f.turn || 0) + 1;
  f.task = text;
  f.progress = [];
  f.plan = f.brief = f.echo = f.result = f.diff = f.review = '';
  f.round = 1;
  f.miss = 0;
  f.phase = 'planning';
  this.fusionCancel = false;
  this.fusionEmit();
  this.fusionJob = this.fusionPlan(text).catch(e => {
    if (this.fusionRun) this.fusionRun.phase = 'idle';
    this.fusionEmit();
    this.emit({ t: 'status', ok: false, msg: e.message });
  }).finally(() => { this.fusionFinishJob(); });
},

async fusionPlan(text) {
  const plan = await this.fusionAsk('a', `根据以下用户要求生成详细修改方案，暂不修改文件。\n方案包含：目标、允许修改的文件、不要动的范围、步骤、约束、可核对的完成标准（测试命令、函数行为或文件中必须出现的内容）。\n\n用户要求：\n${text}`);
  if (this.fusionCancel) return;
  this.fusionRun.plan = plan;
  this.fusionRun.brief = plan;
  this.fusionRun.phase = 'plan';
  this.fusionEmit();
  this.emit({ t: 'status', ok: true, msg: '方案已写好。确认后点「执行方案」' });
},

fusionGo() {
  if (!this.fusionWorkerKey) return this.fusionWorker().fusionGo();
  const f = this.fusionRun;
  if (!f || this.fusionJob) throw new Error('Fusion 正在进行');
  if (f.phase !== 'plan' && f.phase !== 'disagree') throw new Error('现在还不能交给 B');
  this.fusionCancel = false;
  this.fusionJob = this.fusionExecute().catch(e => {
    if (this.fusionRun) this.fusionRun.phase = 'idle';
    this.fusionEmit();
    this.emit({ t: 'status', ok: false, msg: e.message });
  }).finally(() => { this.fusionFinishJob(); });
},

async fusionExecute() {
  const f = this.fusionRun;
  if ((f.round || 1) > 4) {
    f.phase = 'stopped';
    this.fusionEmit();
    this.emit({ t: 'status', ok: false, msg: '已到 4 轮，Fusion 停止' });
    return;
  }
  f.phase = 'execute';
  this.fusionEmit();
  const baseline = await this.fusionDiff('b');
  f.result = await this.fusionAsk('b', `执行以下方案，先完成实际修改和验证，再返回结果；不要只复述准备做什么。遇到阻塞则明确说明。\n结果分三段：改了哪些文件、实际验证结果、哪里没完成或没把握。\n\n方案：\n${f.brief}`);
  if (this.fusionCancel) return;
  f.diff = await this.fusionDiff('b');
  f.phase = 'review';
  this.fusionEmit();
  f.review = await this.fusionAsk('a', `根据方案、实际执行结果和文件差异检查是否完成。执行前已有的改动不算本轮成果；不涉及文件修改的任务按实际验证结果判断。\n完成则最后一行写 FUSION: done\n只需你自己小改则最后一行写 FUSION: fix\n仍需修改则最后一行写 FUSION: return，前面给出后续执行说明，保留原方案范围和完成标准，已经做对的不要重做。\n\n方案：\n${f.brief}\n\n执行结果：\n${f.result}\n\n执行前差异：\n${baseline}\n\n执行后差异：\n${f.diff}`);
  if (this.fusionCancel) return;
  await this.fusionApply(fusionMark(f.review));
},

async fusionApply(mark) {
  const f = this.fusionRun;
  if (mark.kind === 'done') {
    f.phase = 'done';
    this.fusionEmit();
    this.emit({ t: 'status', ok: true, msg: 'Fusion 完成' });
    return;
  }
  if (mark.kind === 'fix') {
    f.phase = 'fix';
    this.fusionEmit();
    f.review = await this.fusionAsk('a', `按你刚决定的小修直接改文件，然后用完成标准复查。最后一行写 FUSION: done 或 FUSION: return。\n\n${mark.body || f.review}`);
    if (this.fusionCancel) return;
    const again = fusionMark(f.review);
    return this.fusionApply(again.kind === 'fix' ? { kind: '', body: again.body } : again);
  }
  if (mark.kind === 'return') {
    f.brief = mark.body || f.brief;
    f.round = (f.round || 1) + 1;
    return this.fusionExecute();
  }
  f.phase = 'check';
  this.fusionEmit();
  this.emit({ t: 'status', ok: false, msg: 'A 没有给出完成、小修或退回。请点下面的按钮' });
},

fusionDecide(kind) {
  if (!this.fusionWorkerKey) return this.fusionWorker().fusionDecide(kind);
  const f = this.fusionRun;
  if (!f || f.phase !== 'check') throw new Error('现在不需要选择');
  if (!['done', 'fix', 'return'].includes(kind)) throw new Error('没有这个决定');
  if (this.fusionJob) throw new Error('Fusion 正在进行');
  this.fusionCancel = false;
  this.fusionJob = this.fusionApply({ kind, body: f.review || f.brief }).catch(e => {
    this.emit({ t: 'status', ok: false, msg: e.message });
  }).finally(() => { this.fusionFinishJob(); });
}
};
