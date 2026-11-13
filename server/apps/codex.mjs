import { Cdp, cdpRead, awaitCdpRead } from '../cdp.mjs';
import { windowRoots, editorRoots, workspaceLabel } from '../../lib/files.mjs';
import { agentMarks } from '../../lib/marks.mjs';
import { IS_WIN, mod, normPath, pathKey } from '../../lib/platform.mjs';
import { codexWindows, codexContext } from '../windows.mjs';
import { CODEX_CDP_URL } from '../config.mjs';
import { PAGE_SRC, helpersCall } from '../page/build.mjs';
import { AgentContext, FOCUS_COMPOSER, codexUsage } from '../agent/context.mjs';
import { resetThinkingCaches } from '../agent/thinking-cache.mjs';
import { computerId, saveState } from '../../lib/auth.mjs';
import { conversationProjects, fusionProject, allFusionRuns } from '../fusion/state.mjs';
import { removeLibrarySession, publishSessionChange, rememberSessionMessage } from '../../lib/session-library.mjs';
import { NativeCdp, nativeWindowAt, nativeSessionCatalog, nativeTargets } from '../native-windows.mjs';
import { currentOperation } from '../operations.mjs';
import { codexBackend, CODEX_BACKEND } from '../codex/state.mjs';
import { safeHomePath, createProjectFolder, projectList, openFolder } from '../agent/projects.mjs';
import { rememberSelection } from '../../lib/auth.mjs';
import { uploads, pendingUploads, uploadAttachments, removeUpload, updateUpload } from '../../lib/uploads.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveLocal, writeTextFile } from '../../lib/files.mjs';
import { watchChatUpdates } from '../agent/updates.mjs';
import { orderedProjectWindows, bindProjectWindow, nativeCloseProjectWindow } from '../project-windows.mjs';
import { leaseWindow } from '../window-use.mjs';

function backendAgentRows(s) {
  return [...codexBackend.records.values()].map(row => ({ id: `thread:${CODEX_BACKEND}:${row.id}`,
    title: row.title, workspace: row.cwd, window: path.basename(row.cwd), group: '', lastUsed: row.updatedAt * 1000,
    current: s.codexBackend && row.id === s.threadId, running: !codexBackend.threads.get(row.id)?.disconnected && (codexBackend.threads.get(row.id)?.turns.some(turn => turn.status === 'inProgress') || false) }));
}

async function backendSkills(s) {
  const { data } = await codexBackend.client.request('skills/list', { cwds: [s.codexDirectory] });
  return data.flatMap(entry => entry.skills.filter(skill => skill.enabled).map(skill => ({ label: skill.name,
    sub: skill.shortDescription || skill.description, key: skill.path, path: skill.path, section: 'Skills' })));
}

function backendAttached(s, initial = false) {
  s.emit({ t: 'attached', id: 'codex', app: 'codex', title: 'Codex', appName: 'Codex',
    windowId: CODEX_BACKEND, threadId: s.threadId, project: path.basename(s.codexDirectory),
    sel: s.selectionKey(), ready: true, initial,
    capabilities: { ...capabilities, extraActions: false } });
}

function backendPublish(s, sent) {
  if (!codexBackend.threads.has(s.threadId)) return false;
  s.emit({ t: 'chat', sel: s.selectionKey(), chat: codexBackend.chat(s.threadId, s.codexHistoryLimit || 40) }, sent);
  return true;
}

async function bindBackend(s, req) {
  let directory = req.project?.root ? safeHomePath(req.project.root).real
    : req.threadId ? null : safeHomePath(s.codexDirectory || os.homedir()).real;
  const id = req.threadId || (!req.newSession && [...codexBackend.records.values()].filter(row => path.resolve(row.cwd) === directory)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))[0]?.id);
  if (id && (!codexBackend.threads.has(id) || codexBackend.threads.get(id).disconnected)) {
    const owner = await adapter.backendOwner(id);
    if (owner) {
      if (directory && path.resolve(owner.cwd) !== directory) throw new Error('Codex 会话不属于所选项目');
      await s.attach({ id: 'codex', windowId: owner.pageId, threadId: id, nativeOwner: { cwd: owner.cwd }, initial: req.initial });
      if (req.project) s.projectReady({ root: owner.cwd, newSession: false, threadId: id });
      return;
    }
  }
  const thread = await awaitCdpRead(id ? codexBackend.load(id) : codexBackend.create(directory));
  directory = safeHomePath(directory || thread.cwd).real;
  if (path.resolve(thread.cwd) !== directory) throw new Error('Codex 会话不属于所选项目');
  cdpRead.getStore()?.throwIfAborted();
  s.detach();
  s.clearViewState();
  s.app = s.targetId = 'codex';
  s.codexBackend = true;
  s.codexPageId = '';
  s.windowId = CODEX_BACKEND;
  s.codexDirectory = thread.cwd;
  s.threadId = s.selectedThread = thread.id;
  s.bindingReady = true;
  s.selectionHome = false;
  s.codexHistoryLimit = 40;
  rememberSelection(s.deviceId, { id: 'codex', app: 'codex', windowId: CODEX_BACKEND, threadId: thread.id, project: { root: thread.cwd, host: '' } });
  backendAttached(s, req.initial === true);
  await s.setMode(s.mode, true);
  if (req.project) s.projectReady({ root: directory, newSession: !id, threadId: id });
}

async function backendSettingsOwner(s) {
  if (!s.codexBackendSettings) {
    const context = new AgentContext({ deviceId: s.deviceId });
    context.app = 'codex';
    context.emit = message => s.emit(message);
    const owner = s.codexBackendSettings = { context };
    owner.ready = (async () => {
      let page = orderedProjectWindows('codex', await codexWindows(CODEX_CDP_URL))[0];
      if (!page) {
        await openFolder(s.codexDirectory, 'codex', true, true);
        const deadline = Date.now() + 30000;
        while (!page && Date.now() < deadline) {
          page = orderedProjectWindows('codex', await codexWindows(CODEX_CDP_URL))[0];
          if (!page) await awaitCdpRead(new Promise(resolve => setTimeout(resolve, 120)));
        }
        if (!page) throw new Error('Codex 设置窗口尚未就绪');
        owner.created = true;
      }
      owner.page = page;
      owner.release = leaseWindow('codex', page.pageId, owner);
      bindProjectWindow('codex', page.pageId);
      context.editorCdp = new Cdp(page.ws);
      await context.editorCdp.connect();
      if (!page.chatWs) {
        const pageId = page.pageId;
        await context.withFocus(async () => {
          await context.key(mod('Shift+p'), { cdp: context.editorCdp });
          await context.editorCdp.send('Input.insertText', { text: 'Codex: Open Codex Sidebar' });
          await context.key('Enter', { cdp: context.editorCdp });
        });
        const deadline = Date.now() + 30000;
        while (!page?.chatWs && Date.now() < deadline) {
          page = (await codexWindows(CODEX_CDP_URL, false, pageId))[0];
          if (!page?.chatWs) await awaitCdpRead(new Promise(resolve => setTimeout(resolve, 120)));
        }
        if (!page?.chatWs) throw new Error('Codex 设置需要已就绪的桌面插件侧边栏');
      }
      context.cdp = new Cdp(page.chatWs);
      await context.cdp.connect();
      return owner;
    })();
  }
  return awaitCdpRead(s.codexBackendSettings.ready);
}

async function closeBackendSettings(s, owner = s.codexBackendSettings) {
  if (s.codexBackendSettings === owner) s.codexBackendSettings = null;
  if (!owner) return;
  return owner.closing ||= (async () => {
    const context = owner.context;
    try {
      await owner.ready;
      await context.closeCodexSettings();
    } finally {
      clearTimeout(context.focusTimer);
      try {
        try {
          await Promise.all([...new Set([context.cdp, context.editorCdp])].filter(Boolean).map(async cdp => {
            try { await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }); }
            finally { cdp.close(); }
          }));
        } finally { if (owner.created) await nativeCloseProjectWindow({ webSocketDebuggerUrl: owner.page.ws }); }
      } finally { owner.release?.(); }
    }
  })();
}

async function withBackendSettings(s, action) {
  const ready = backendSettingsOwner(s), owner = s.codexBackendSettings;
  try {
    const { context } = await ready;
    return await context.withFocus(() => action(context));
  } catch (error) {
    try { await cdpRead.run(null, () => closeBackendSettings(s, owner)); }
    finally { throw error; }
  }
}

const backendRoutes = {
  settings(m) { return withBackendSettings(this, context => context.showCodexSettings('', m.requestId)); },
  codexSetting(m) { return withBackendSettings(this, context => context.showCodexSettings(String(m.id || ''), m.requestId, typeof m.value === 'string' ? m.value : undefined)); },
  codexInstructions(m) { return withBackendSettings(this, context => context.saveCodexInstructions(String(m.text || ''), m.requestId)); },
  closeCodexSettings() { return closeBackendSettings(this); },
  async click(m) {
    let clicked = false;
    try {
      if (m.sel !== this.selectionKey()) throw new Error('会话已切换，请使用当前会话的按钮');
      if (!['fork', 'capacity-retry'].includes(m.actionId) || !codexBackend.chat(this.threadId, this.codexHistoryLimit || 40).items.some(item => item.btnItem === m.item && item.actions?.[m.n] === m.actionId))
        throw new Error('请求已更新，请查看最新选项');
      if (m.actionId === 'capacity-retry') await codexBackend.retry(this.threadId, m.item);
      else {
        const thread = await awaitCdpRead(codexBackend.fork(this.threadId, m.item));
        await bindBackend(this, { threadId: thread.id });
      }
      clicked = true;
    } finally { this.emit({ t: 'clickDone', item: m.item, actionId: m.actionId, sel: m.sel, clicked, requestId: m.requestId }); }
  },
  codexRetry(m) {
    if (m.sel !== this.selectionKey()) return;
    this.codexRetrySettings = { ...m };
    codexBackend.setRetry(this, this.threadId, { enabled: m.enabled === true && this.visible && this.mode === 'chat',
      count: Math.max(1, Math.min(5, Math.round(Number(m.count) || 1))),
      notify: result => this.emit({ t: 'codexRetryState', sel: m.sel, ...result }) });
  },
  async agents(m) {
    const list = backendAgentRows(this), windows = nativeTargets().filter(row => row.app === 'codex');
    for (const row of nativeSessionCatalog('codex')?.rows || []) {
      if (row.archived || codexBackend.owns(row.id)) continue;
      const win = windows.find(win => nativeWindowAt(win.ws)?.roots?.some(root => root.root === row.workspace && (root.host || '') === (row.host || ''))) || windows[0];
      if (win) list.push({ ...row, id: `thread:${win.pageId || win.id}:${row.id}`, window: path.basename(row.workspace || '') || win.title, group: '', current: false });
    }
    list.unshift({ id: `new:${CODEX_BACKEND}:${encodeURIComponent(this.codexDirectory)}`, title: '＋ 新建会话', window: path.basename(this.codexDirectory), workspace: this.codexDirectory, group: '', ui: true });
    this.emit({ t: 'agents', app: 'codex', sel: this.selectionKey(), silent: m.silent === true, list });
  },
  async openAgent(m) {
    const [kind, windowId, ...rest] = m.id.split(':');
    if (windowId !== CODEX_BACKEND) return this.attach({ id: 'codex', windowId, threadId: rest.join(':') });
    return bindBackend(this, kind === 'new' ? { project: { root: decodeURIComponent(rest.join(':')) }, newSession: true } : { threadId: rest.join(':') });
  },
  newProjectChat() { return bindBackend(this, { project: { root: this.codexDirectory }, newSession: true }); },
  openProject(m) { return bindBackend(this, { project: { root: m.path }, newSession: m.newSession }); },
  newProject(m) { return bindBackend(this, { project: { root: createProjectFolder(m.parent, m.name) }, newSession: true }); },
  projects(m) {
    const data = projectList(m.path || '');
    if (!m.path) data.recent = [...new Set([...codexBackend.records.values()].map(row => row.cwd))].map(root => ({ name: path.basename(root), path: root }));
    this.emit({ t: 'projects', ...data });
  },
  send(m) { return this.sendMessage(String(m.text || ''), m.submit !== false, m.when, m.mentions || [], { requestId: m.requestId, draft: m.draft, text: m.text, draftEpoch: m.draftEpoch }); },
  draft(m) {
    const read = m.text === undefined, key = this.selectionKey();
    this.codexDrafts ||= new Map();
    if (!read) { this.codexDrafts.set(key, String(m.text)); this.draftEpoch = m.draftEpoch; }
    this.emit({ t: 'draftAck', sel: key, ok: true, text: this.codexDrafts.get(key) || '', read, draftEpoch: this.draftEpoch || '', revision: m.revision });
  },
  async stop() {
    const thread = await codexBackend.load(this.threadId);
    const turn = thread.turns.findLast(turn => turn.status === 'inProgress');
    if (turn) await codexBackend.client.request('turn/interrupt', { threadId: this.threadId, turnId: turn.id });
  },
  async refresh() { await codexBackend.refresh(this.threadId); backendPublish(this); },
  scrollChat(m) {
    if (!m.history) return;
    this.codexHistoryLimit += 40;
    const chat = codexBackend.chat(this.threadId, this.codexHistoryLimit);
    this.emit({ t: 'historyPage', sel: this.selectionKey(), thread: this.threadId, requestId: m.requestId, items: chat.items, earlier: chat.earlier });
    this.emit({ t: 'historyDone', sel: this.selectionKey(), requestId: m.requestId, earlier: chat.earlier });
  },
  async openMenu(m) {
    const thread = codexBackend.threads.get(this.threadId), settings = thread.settings;
    const { data } = await codexBackend.client.request('model/list', {});
    const current = data.find(row => row.model === (settings.model || thread.model));
    const items = m.kind === 'model' ? data.filter(row => !row.hidden).map(row => ({ label: row.displayName, id: row.model, checked: current?.model === row.model }))
      : m.kind === 'effort' ? (current?.supportedReasoningEfforts || []).map(row => ({ label: row.reasoningEffort, checked: row.reasoningEffort === (settings.effort ?? settings.reasoningEffort) }))
      : m.kind === 'permission' ? ['Ask for approval', 'Full access'].map(label => ({ label, checked: label === codexBackend.chat(this.threadId).permission }))
      : m.kind === 'fast' ? ['Standard', 'Fast'].map(label => ({ label, checked: (settings.serviceTier === 'fast' ? 'Fast' : 'Standard') === label })) : [];
    this.emit({ t: 'menu', kind: m.kind, requestId: m.requestId, sel: this.selectionKey(), items,
      fast: { on: settings.serviceTier === 'fast' } });
  },
  async pickMenu(m) {
    let update;
    if (m.kind === 'codex-chat') {
      if (m.label === 'Archive') return backendRoutes.codexArchive.call(this, { id: `thread:backend:${this.threadId}` });
      return backendRoutes.codexRename.call(this, { id: `thread:backend:${this.threadId}`, name: m.name });
    }
    if (m.kind === 'model') {
      const { data } = await codexBackend.client.request('model/list', {});
      const model = data.find(row => row.displayName === m.label);
      if (!model) throw new Error('Codex 模型已不存在');
      update = { model: model.model, effort: model.defaultReasoningEffort };
    } else if (m.kind === 'effort') update = { effort: m.label };
    else if (m.kind === 'permission') update = { approvalPolicy: m.label === 'Full access' ? 'never' : 'on-request', sandboxPolicy: { type: m.label === 'Full access' ? 'dangerFullAccess' : 'workspaceWrite', ...(m.label === 'Full access' ? {} : { writableRoots: [this.codexDirectory], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }) } };
    else if (m.kind === 'fast') update = { serviceTier: m.label === 'on' || m.label === 'Fast' ? 'fast' : null };
    else throw new Error('当前后台没有此设置');
    await codexBackend.client.request('thread/settings/update', { threadId: this.threadId, ...update });
    Object.assign(codexBackend.threads.get(this.threadId).settings, update);
    if (m.kind === 'fast') this.emit({ t: 'fastState', sel: this.selectionKey(), fast: { on: update.serviceTier === 'fast' } });
    codexBackend.changed(this.threadId);
  },
  codexRequest(m) {
    if (m.field != null) return;
    codexBackend.answer(this.threadId, m.id, m.n, m.fields);
  },
  async queue(m) {
    const id = this.threadId, row = codexBackend.queues.get(id)?.find(row => row.id === m.id);
    if (!row) throw new Error('排队消息已不存在');
    if (m.action === 'read') return row.input.filter(part => part.type === 'text').map(part => part.text).join('\n');
    if (m.action === 'edit') await codexBackend.client.request('thread/queue/update', { threadId: id, queuedSubmissionId: m.id,
      input: [{ type: 'text', text: m.text }, ...row.input.filter(part => part.type !== 'text')] });
    else if (m.action === 'send') await codexBackend.startQueued(id, m.id);
    else await codexBackend.client.request('thread/queue/delete', { threadId: id, queuedSubmissionId: m.id });
    await codexBackend.readQueue(id);
    return { queued: m.action !== 'send' };
  },
  attachments() { this.emit({ t: 'attachments', sel: this.selectionKey(), list: uploadAttachments(this.selectionKey()) }); },
  image(m) {
    const file = uploads.get(m.uploadId);
    if (!file?.image || file.deviceId !== this.deviceId || file.sel !== this.selectionKey()) throw new Error('找不到当前会话的上传图片');
    if (this.imageTransfers?.get(m.clientImageId)?.cancelled) return;
    if (m.replace) {
      if (uploads.get(m.replace)?.sel !== file.sel) throw new Error('原图片已不在当前输入框中');
      removeUpload(m.replace);
    }
    updateUpload(file, { pending: true });
    backendRoutes.attachments.call(this);
    return m.uploadId;
  },
  removeAttachment(m) {
    if (uploads.get(m.id)?.sel !== this.selectionKey()) throw new Error('附件不属于当前会话');
    removeUpload(m.id); return backendRoutes.attachments.call(this);
  },
  async editImage(m) {
    const file = uploads.get(m.id);
    if (!file || file.sel !== this.selectionKey()) throw new Error('图片不属于当前会话');
    this.emit({ t: 'imageEdit', id: m.id, sel: this.selectionKey(), data: `data:${file.type};base64,${(await fs.readFile(file.path)).toString('base64')}`, name: file.name, type: file.type });
  },
  file(m) { return this.openFile(m.path, m.diff || '', m.changes === true, m.requestId); },
  async saveFile(m) {
    const file = await resolveLocal({ root: this.codexDirectory, host: '' }, m.path);
    const relative = path.relative(this.codexDirectory, file.path);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('只能修改当前项目里的文件');
    const size = await writeTextFile(file.path, String(m.text));
    this.emit({ t: 'saved', requestId: m.requestId, path: m.path, host: '', ok: true, size });
  },
  changes() {
    const thread = codexBackend.threads.get(this.threadId);
    const files = thread.turns.flatMap(turn => turn.items.filter(item => item.type === 'fileChange').flatMap(item => item.changes.map(row => ({ name: row.path, diff: row.diff }))));
    this.emit({ t: 'changes', historical: true, actions: [], files });
  },
  async usage(m) {
    const result = await codexBackend.client.request('account/rateLimits/read', {});
    const limits = result.rateLimits;
    this.emit({ t: 'usage', sel: this.selectionKey(), automatic: m.automatic, updated: Date.now(), context: codexBackend.chat(this.threadId).context,
      ...(limits ? { plan: limits.planType || '', limits: [limits.primary, limits.secondary].filter(Boolean).map(row => ({ label: row.windowDurationMins < 1440 ? '5h' : 'Weekly', pct: row.usedPercent, basis: 'used', reset: new Date(row.resetsAt * 1000).toLocaleString('zh-CN') })) } : {}) });
  },
  async codexPlan() {
    const thread = codexBackend.threads.get(this.threadId), settings = thread.settings;
    const collaborationMode = { mode: settings.collaborationMode?.mode === 'plan' ? 'default' : 'plan',
      settings: { model: settings.model || thread.model, reasoning_effort: settings.effort ?? settings.reasoningEffort ?? null } };
    await codexBackend.client.request('thread/settings/update', { threadId: this.threadId, collaborationMode });
    settings.collaborationMode = collaborationMode;
    codexBackend.changed(this.threadId);
  },
  async codexSkills() { this.emit({ t: 'codexSkills', rows: await backendSkills(this) }); },
  async mentionQuery(m) {
    let rows;
    if (m.trigger === '/') rows = (await backendSkills(this)).filter(row => (row.label + ' ' + row.sub).toLowerCase().includes(String(m.q || '').toLowerCase()));
    else {
      const { files } = await codexBackend.client.request('fuzzyFileSearch', { query: String(m.q || ''), roots: [this.codexDirectory] });
      rows = files.map(file => ({ label: file.file_name, sub: file.path, key: path.resolve(file.root, file.path), section: 'files' }));
    }
    this.emit({ t: 'mentions', sel: this.selectionKey(), seq: m.seq, q: m.q, trigger: m.trigger, rows });
  },
  codexChat() { this.emit({ t: 'menu', kind: 'codex-chat', items: [{ label: 'Rename' }, { label: 'Archive' }] }); },
  sessionActions(m) { this.emit({ t: 'sessionActions', app: 'codex', id: m.id, requestId: m.requestId, actions: ['rename', 'archive'] }); },
  async sessionBatch(m) {
    await this.batchSessions(m.ids, m.requestId, async row => {
      const [, windowId, ...rest] = row.id.split(':'), id = rest.join(':');
      if (windowId === CODEX_BACKEND) {
        const thread = await codexBackend.load(id);
        if (thread.turns.some(turn => turn.status === 'inProgress')) throw new Error('会话正在运行，已跳过');
        return backendRoutes.codexArchive.call(this, { id: row.id });
      }
      const page = nativeTargets().find(win => win.app === 'codex' && (win.pageId || win.id) === windowId);
      if (!page) throw new Error('这个窗口已经关闭');
      const context = new AgentContext({ deviceId: this.deviceId, emit: message => this.emit(message) });
      context.app = 'codex'; context.codexPageId = context.windowId = windowId;
      context.cdp = new NativeCdp(page.ws);
      context.listAgents = context.pollChat = async () => {};
      context.publishThread = () => {};
      try {
        await context.cdp.connect();
        context.threadId = await context.cdp.evaluate(helpersCall('codexThread()')) || '';
        await context.archiveBatchSession(row);
      } finally { context.cdp.close(); }
    });
    return backendRoutes.agents.call(this, {});
  },
  async codexRename(m) {
    const id = m.id.split(':').at(-1);
    await codexBackend.manage(id, 'rename', m.name);
    publishSessionChange('codex', id, { action: 'rename', title: m.name });
    return backendRoutes.agents.call(this, {});
  },
  async codexArchive(m) {
    const id = m.id.split(':').at(-1);
    await codexBackend.manage(id, 'archive');
    publishSessionChange('codex', id, { action: 'archive' });
    this.emit({ t: 'codexArchived', id: m.id });
    return backendRoutes.agents.call(this, {});
  },
};

function serializedCodexPrompt(cdp, thread) {
  const call = `nativeSessionInfo('codex', ${JSON.stringify(thread)}, 'draft')`;
  return cdp.nativeWindow ? cdp.nativeWindow.composerCall(call) : cdp.evaluate(helpersCall(call));
}

// Native support; availability still follows the selected thread, model and controls.
export const capabilities = {
  model: true, effort: true, fast: true,
  queue: true, steer: true, queueEdit: true,
  questions: true, approvals: true, attachments: true, fileReferences: true,
  editor: true, terminal: true, settings: true, usage: true,
  fork: true, extraActions: true,
};

async function readCodexMenu(context, button, select = items => items.length ? items : null) {
  const pos = await context.cdp.evaluate(helpersCall(`codexButtonPoint(${JSON.stringify(button)})`));
  if (!pos) throw new Error(button === 'run' ? '当前没有执行位置菜单' : '当前会话没有 Chat actions');
  await context.tapCss(pos.x, pos.y);
  let value;
  for (let i = 0; i < 10 && !value; i++) {
    await new Promise(r => setTimeout(r, 120));
    value = select(await context.cdp.evaluate(helpersCall('codexRunItems()')) || []);
  }
  return value;
}

export const adapter = {
  backendRoutes,
  async backendOwner(id) {
    if (codexBackend.threads.has(id) && !codexBackend.threads.get(id).disconnected) return null;
    const pages = await codexWindows(CODEX_CDP_URL);
    const matches = await Promise.all(pages.filter(page => page.chatWs).map(async page => {
      const cdp = new Cdp(page.chatWs);
      try {
        await cdp.connect();
        const owner = await cdp.evaluate(helpersCall(`nativeSessionInfo('codex', ${JSON.stringify(id)}, 'owner')`));
        return owner ? { ...page, ...owner } : null;
      } finally { cdp.close(); }
    }));
    return matches.find(Boolean) || null;
  },
  backendThread(id, host = nativeSessionCatalog('codex')?.rows.find(row => row.id === id)?.host || '') {
    return !host && !allFusionRuns().some(run => run.bindings.some(binding => binding.app === 'codex' && binding.threadId === id));
  },
  closeBackendSettings() { return closeBackendSettings(this); },
  attachBackend(req) { return bindBackend(this, req); },
  async setBackendMode() {
    await awaitCdpRead(codexBackend.load(this.threadId));
    if (!this.visible) { backendPublish(this); return; }
    const stop = watchChatUpdates(this, refresh => codexBackend.subscribe(this.threadId, error => {
      if (error) this.emit({ t: 'status', ok: false, msg: error.message });
      refresh();
    }), sent => backendPublish(this, sent));
    this.chatUpdatesStop = () => { codexBackend.clearRetry(this); stop(); };
    if (this.codexRetrySettings) backendRoutes.codexRetry.call(this, this.codexRetrySettings);
    backendPublish(this);
  },
  async sendBackendMessage(text, submit, when, mentions, receipt) {
    if (!submit) return backendRoutes.draft.call(this, { text, draftEpoch: receipt?.draftEpoch });
    const id = this.threadId, sel = this.selectionKey(), files = pendingUploads(sel);
    const input = text.trim() ? [{ type: 'text', text }] : [];
    for (const [, file] of files) {
      if (file.type?.startsWith('image/')) input.push({ type: 'image', url: `data:${file.type};base64,${(await fs.readFile(file.path)).toString('base64')}` });
      else input.push({ type: 'text', text: `附加文件（请读取）：${file.path}` });
    }
    for (const mention of mentions || []) {
      if (mention.section === 'Skills') input.push({ type: 'skill', name: mention.label, path: mention.path || mention.key });
      else if (mention.section === 'files' || mention.path) input.push({ type: 'text', text: `引用文件：${mention.path || mention.key}` });
    }
    cdpRead.getStore()?.throwIfAborted();
    const operation = currentOperation();
    if (operation) operation.submitted = true;
    const result = await codexBackend.send(id, input, when, receipt.requestId);
    for (const [, file] of files) updateUpload(file, { pending: false });
    this.codexDrafts?.delete(sel);
    rememberSessionMessage('codex', id, Date.now());
    this.emit({ t: 'sent', ...receipt, ...result, sel, sentAt: Date.now() });
    this.emit({ t: 'attachments', sel, list: uploadAttachments(sel) });
    if (this.selectionKey() === sel) backendPublish(this);
    return result.queued;
  },
  async newChat() {
    return this.newCodexChat();
  },

  // A cold start keeps the native home/new-chat view; only bind its webview.
  async openDefaultSession() {
    const page = (await codexWindows(CODEX_CDP_URL)).find(p => p.pageId === this.codexPageId);
    if (page && this.cdp === this.editorCdp) await this.ensureCodexReady({ id: page.pageId, ws: page.ws }, false);
    if (this.pendingProject?.trust) return;
    if (await this.checkCodexLogin()) return;
    const state = await this.waitFor('agentStartupState("codex")', 250);
    if (!state) throw new Error('Codex 项目与会话尚未就绪，请重试');
  },

  async openAgent(id, title = '') {
    await this.openCodexAgent(id);
  },

  async listAgents(silent, readOnly, emit) {
    const pages = await codexWindows(CODEX_CDP_URL);
    const list = [];
    const seen = new Set(), newRoots = new Set();
    const addNew = (p, root, label) => {
      if (!root || newRoots.has(pathKey(root))) return;
      newRoots.add(pathKey(root));
      list.push({ id: `new:${p.pageId}:${encodeURIComponent(root)}`, title: '＋ 新建会话', window: label, workspace: root, group: '', ui: true });
    };
    const states = await Promise.all(pages.map(p => this.probeCodex(p)));
    for (const p of pages) {
      const group = p.title;
      if (p.chatWs) {
        for (const root of states[pages.indexOf(p)]?.roots || []) addNew(p, root, group);
        const cdp = p.pageId === this.codexPageId ? this.cdp : this.fusionBinding ? new Cdp(p.chatWs) : new NativeCdp(p.chatWs);
        let rows = [];
        try {
          if (cdp !== this.cdp) await cdp.connect();
          rows = readOnly && cdp.nativeWindow?.catalog ? structuredClone(cdp.nativeWindow.catalog)
            : readOnly ? await cdp.evaluate(helpersCall('codexChatRows(true)')) : await this.codexThreadRows(cdp);
        } finally { if (cdp !== this.cdp) cdp.close(); }
        this.rememberCodexRoots(rows);
        const folderOf = ws => {
          const parts = String(ws || '').split(/[/\\]/).filter(Boolean);
          return parts.at(-1) || '';
        };
        for (const row of rows) {
          if (codexBackend.owns(row.id)) continue;
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          const owner = pages.find((page, i) => states[i]?.thread === row.id && states[i]?.roots?.includes(row.workspace))
            || pages.find((page, i) => states[i]?.roots?.includes(row.workspace)) || p;
          const state = states[pages.indexOf(owner)];
          const folder = folderOf(row.workspace);
          if (!row.host) addNew(owner, row.workspace, folder || owner.title);
          list.push({
            id: `thread:${owner.pageId}:${row.id}`,
            title: row.title,
            titleNative: row.titleNative, titleAt: row.titleAt,
            lastUsed: row.lastUsed,
            window: folder || owner.title,
            workspace: row.workspace, host: row.host,
            group: '',
            current: owner.pageId === this.codexPageId && row.id === this.threadId,
            running: row.id === state?.thread ? !!state?.busy || !!row.running : !!row.running,
          });
        }
      } else {
        const state = states[pages.indexOf(p)];
        list.push({ id: `win:${p.pageId}`, title: '打开这个窗口', window: group, group: '', current: false, running: !!state?.busy || (state?.progress > 0), ui: true });
      }
    }
    list.push(...backendAgentRows(this));
    const projectKey = (root, host) => `${host || ''}\0${pathKey(root, !host)}`;
    const projects = new Map();
    for (const row of list) if (row.workspace) {
      projects.set(projectKey(row.workspace, row.host), { root: IS_WIN && !row.host ? normPath(row.workspace) : row.workspace, host: row.host });
    }
    const allProjects = [...projects.values()];
    const labels = new Map(allProjects.map(project => {
      const { name, detail } = workspaceLabel(project, allProjects);
      return [projectKey(project.root, project.host), detail ? `${name} · ${detail}` : name];
    }));
    emit({ list: list.map(row => ({
      ...row, window: row.workspace ? labels.get(projectKey(row.workspace, row.host)) : row.window,
    })) });
  },

  async currentRoots() {
    if (this.codexBackend) return [{ root: this.codexDirectory, host: '' }];
    if (this.codexOwnerRoot) return [{ root: this.codexOwnerRoot, host: '' }];
    return (await editorRoots(this.editorCdp, 'codex')).filter(w => !w.host);
  },

  async queueAction(id, action) {
    const target = action === 'send' ? await this.cdp.evaluate(helpersCall(`codexFacts()?.queued.find(item => item.id === ${JSON.stringify(String(id))})`)) : null;
    if (!await this.cdp.evaluate(helpersCall(`codexQueueAction(${JSON.stringify(String(id))}, ${JSON.stringify(action)})`))) throw new Error('Codex 排队消息或操作入口已不存在');
    if (action === 'send' && !await this.waitFor(`codexReceiptRows().some(item => item.i === ${JSON.stringify(target?.messageId || '')} || item.nativeIds?.includes(${JSON.stringify(String(id))}))`, 40))
      throw new Error('Codex 尚未确认立即追加结果，请查看会话或队列');
    this.refreshSoon(300);
  },

  async editQueued(id, text) {
    const wait = async call => {
      const deadline = Date.now() + 4800;
      while (Date.now() < deadline) {
        let value;
        try { value = await this.cdp.evaluate(helpersCall(call), { timeout: deadline - Date.now() }); }
        catch (error) {
          if (!cdpRead.getStore()?.aborted && Date.now() >= deadline) return null;
          throw error;
        }
        if (value) return value;
        await awaitCdpRead(new Promise(resolve => setTimeout(resolve, Math.min(120, Math.max(0, deadline - Date.now())))));
      }
      return null;
    };
    if (!await wait(`queueEditing() === ${JSON.stringify(String(id))}`)) throw new Error('Codex 没有进入对应队列消息的编辑状态');
    const before = await this.cdp.evaluate(helpersCall('codexSendState()'));
    await this.codexFocusPrompt();
    await this.cdp.evaluate(helpersCall('codexSelectPrompt()'));
    await this.cdp.send('Input.insertText', { text });
    const expected = (await serializedCodexPrompt(this.cdp, before.thread)).trim();
    if (!await this.cdp.evaluate(helpersCall('submitCodexMessage("queue")'))) throw new Error('Codex 保存排队消息的按钮不可用');
    const result = await this.cdp.evaluate(helpersCall(`waitCodexReceipt(${JSON.stringify(before)}, ${JSON.stringify(expected)}, ${JSON.stringify(text.trim())}, false)`), { timeout: 6000 });
    if (!result) throw new Error('Codex 尚未确认排队消息已保存，请核对队列后重试');
    this.pollChat(true).catch(() => {});
    return result;
  },

  async changeAction(i, name, act) {
    if (act !== 'bar') throw new Error('Codex 当前没有逐个文件的接受或撤销入口');
    const pos = await this.cdp.evaluate(helpersCall(`codexChangeTarget(${JSON.stringify(String(name))})`));
    if (!pos) throw new Error('文件操作入口已不存在');
    await this.tapCss(pos.x, pos.y);
    await this.listChanges();
  },

  async listChanges() {
    return this.emit({ t: 'changes', codex: true, ...await this.cdp.evaluate(helpersCall('codexChanges()')) });
  },

  async withFiles(fn, opts) {
    return this.withCursorFiles(fn);
  },

  async terminalProject() {
    if (this.codexBackend) return { root: this.codexDirectory, host: '' };
    if (this.codexOwnerRoot) return { root: this.codexOwnerRoot, host: '' };
    return this.cdp.evaluate(`(() => {
      const h = ${PAGE_SRC};
      if ((h.codexThread() || '') !== ${JSON.stringify(this.threadId || '')})
        throw new Error('电脑端会话已切换，请从当前会话新建终端');
      return h.codexCurrentProject();
    })()`);
  },

  async mentionQuery(q, cat, seq, trigger, query) {
    return this.codexMentionQuery(q, trigger === '/' ? '/' : '@', seq, query);
  },

  async usageContext() {
    return codexContext(await this.cdp.evaluate(helpersCall('codexThread()')));
  },

  async accountUsage(request, automatic) {
    return this.readCodexAccount(request);
  },

  async typeDraft(text, mentions) {
    if (mentions?.length) await this.typeWithCodexMentions(text, mentions);
    else if (!await this.cdp.evaluate(helpersCall(`setComposerDraft(${JSON.stringify(text)})`)))
      throw new Error('Codex 输入尚未就绪');
  },

  async submitPrompt(now, busy, when, queued, mentions, receipt, files = []) {
    const source = this.cdp?.nativeWindow;
    let token, sel, operation;
    if (source) {
      token = this.sendNativeReceipt;
      sel = this.selectionKey();
      cdpRead.getStore()?.throwIfAborted();
      operation = currentOperation();
    }
    const hasLocalFiles = mentions?.some(m => m.section === 'local-files');
    const before = await this.cdp.evaluate(helpersCall('codexSendState(true)'));
    const hasAttachments = hasLocalFiles || before.hasDraftAttachments;
    if (before.payload == null) throw new Error('Codex 输入尚未就绪');
    const expected = (await serializedCodexPrompt(this.cdp, before.thread)).trim();
    this.lastDraft = before.draft;
    queued = !!busy && (when === 'queue' || (!when && before.follow === 'queue'));
    const action = when === 'now' ? 'steer' : when === 'queue' ? 'queue' : '';
    if (source) {
      if (token) token.pending = true;
      let unregister;
      if (receipt) {
        if (operation) operation.pending = true;
        const request = { ...receipt, thread: before.thread, expected, queueExpected: before.payload.trim(),
          action: queued ? 'queue' : busy ? 'steer' : 'send', afterTurn: before.lastTurn,
          beforeTurns: new Set(before.runs.map(row => row.id)),
          hasAttachments: !!hasAttachments,
          before: new Set(before.messages.map(row => row.id)), beforeQueues: new Set(before.queued.map(row => row.id)) };
        unregister = source.registerSend(request, (accepted, error, unknown = false) => {
          if (accepted) {
            if (token) Object.assign(token, accepted, { pending: false });
            for (const file of files) updateUpload(file, { pending: false });
            if (!accepted.queued) rememberSessionMessage('codex', accepted.thread, Date.now());
            this.emit({ t: 'sent', ...receipt, ...accepted, sel, sentAt: Date.now() });
          } else if (unknown) this.emit({ t: 'sent', ...receipt, pending: true, message: error, sel });
          else this.emit({ t: 'sendFailed', requestId: receipt.requestId, message: error, sel });
        });
      }
      cdpRead.getStore()?.throwIfAborted();
      if (operation) operation.submitted = true;
      let submitted;
      try {
        submitted = await cdpRead.run(null, () => this.cdp.evaluate(helpersCall(`submitCodexMessage(${JSON.stringify(action)}, true, ${JSON.stringify(receipt?.requestId || '')})`)));
      } catch (error) {
        if (!receipt) throw error;
        if (token?.pending) this.emit({ t: 'sent', ...receipt, pending: true, message: error.message, sel });
        return queued;
      }
      if (!submitted) {
        unregister?.();
        if (operation) operation.pending = false;
        if (token) token.pending = false;
        throw new Error('Codex 提交入口当前不可用');
      }
      return queued;
    }
    const nativeReceipt = this.sendNativeReceipt;
    const receiptThread = this.threadId, receiptCdp = this.cdp, receiptScope = this.selectionKey();
    if (!await this.cdp.evaluate(helpersCall(`submitCodexMessage(${JSON.stringify(action)})`))) throw new Error('Codex 提交入口当前不可用');
    const baseline = { thread: before.thread, messages: before.messages.map(({ id }) => ({ id })), queued: before.queued.map(({ id }) => ({ id })) };
    const accepted = await this.cdp.evaluate(helpersCall(`waitCodexReceipt(${JSON.stringify(baseline)}, ${JSON.stringify(expected)}, ${JSON.stringify(before.payload.trim())}, ${!!hasAttachments})`), { timeout: 6000 }).catch(error => {
      cdpRead.getStore()?.throwIfAborted();
      return null;
    });
    if (accepted && this.cdp === receiptCdp && this.selectionKey() === receiptScope && (!receiptThread || before.thread === receiptThread)) {
      queued = accepted.queued;
      if (nativeReceipt) Object.assign(nativeReceipt, accepted);
      if (busy && !queued) this.emit({ t: 'status', ok: true, msg: '已追加到当前任务' });
      return queued;
    }
    if (nativeReceipt) nativeReceipt.pending = true;
    return queued;
  },

  async fileAgentMarks(f, text, changes, diff) {
    const edits = new Map();
    for (const file of changes?.files || []) for (const hunk of (file.diff || '').split(/^@@[^\n]*\n/m)) {
      const diff = hunk.split('\n').filter(l => /^[ +\-]/.test(l) && !/^---|^\+\+\+/.test(l)).map(l => [l[0], l.slice(1)]);
      if (diff.length) edits.set(edits.size, { kind: 'edit', f: file.name, diff });
    }
    const marks = agentMarks(edits, f.path, text);
    if (marks) return { marks, markSource: 'agent', diff };
    return null;
  },

  async pickModelMenu(label) {
    if (!await this.cdp.evaluate(helpersCall(`pickCodexModel(${JSON.stringify(String(label))})`))) return false;
    await this.waitModel(label);
    await this.closeMenus();
    this.refreshModelChat().catch(() => {});
    return true;
  },

  async showSettings(requestId = 0) {
    return this.showCodexSettings('', requestId);
  },
};

export const methods = {

// A virtualized Codex list unmounts older turns. Keep text we already read for this thread.
mergeCodexItems(chat) {
  if (this.app !== 'codex' || !chat?.items) return;
  const thread = chat.thread || '';
  if (thread && this.threadId && thread !== this.threadId) {
    this.latestThink = null;
    this.thinkTries = new Map();
    resetThinkingCaches(this);
  }
  if (thread) this.threadId = thread;
  if (!this.itemCache) this.itemCache = new Map();
  const prev = this.itemCache.get(thread) || [];
  const rows = new Map(prev.map(it => {
    if (it.capacity && it.b?.length) {
      const { b, actions, btnItem, ...notice } = it;
      return [it.i, notice];
    }
    return [it.i, it];
  }));
  const completed = new Map([...(prev.completeTurns || []), ...(chat._completeTurnIds || [])]);
  delete chat._completeTurnIds;
  const partial = new Set(prev.partialTurns || []);
  for (const turn of chat._completeTurns || []) partial.delete(turn);
  for (const turn of chat._partialTurns || []) partial.add(turn);
  delete chat._completeTurns; delete chat._partialTurns;
  let tailOrder = Math.max(0, ...prev.map(it => it.order || 0), ...chat.items.map(it => it.order || 0));
  if (chat.capacityPresent === false) {
    for (const [id, it] of rows) if (it.syntheticCapacity) rows.delete(id);
  }
  for (const [index, { buttonsRead, htmlRead, ...it }] of chat.items.entries()) {
    const old = rows.get(it.i);
    if (htmlRead === false && it.k === 'assistant' && old?.t === it.t && old.bodyFormat === 'html' && old.h) {
      it.h = old.h;
      it.bodyFormat = 'html';
    }
    if (!Number.isFinite(it.order)) it.order = Number.isFinite(old?.order) ? old.order : ++tailOrder;
    // A stored turn has no footer DOM; a mounted turn is authoritative, including removal.
    const retained = buttonsRead === false && it.k === 'assistant' && old?.k === 'assistant'
      && it.completed === true && old.completed === true && it.t === old.t
      ? (old.b || []).map((label, n) => ({ label, action: old.actions?.[n] || '' }))
        .filter(button => /^(Copy message|View changed files|View file changes|Undo|View changes|Fork chat from here)$/.test(button.label)) : [];
    const buttons = retained.length ? [
      ...(it.b || []).map((label, n) => ({ label, action: it.actions?.[n] || '' })),
      ...retained.filter(button => !it.b?.includes(button.label)),
    ] : [];
    const row = buttons.length ? { ...old, ...it, b: buttons.map(button => button.label), btnItem: it.btnItem || old.btnItem || old.i,
      ...(old.actions || it.actions ? { actions: buttons.map(button => button.action) } : {}) } : it;
    chat.items[index] = row;
    rows.set(it.i, row);
  }
  const capacity = chat.capacityPresent && chat.items.find(it => it.syntheticCapacity);
  if (capacity) for (const [id, it] of rows) {
    if (id === capacity.i || !it.b?.length) continue;
    const buttons = it.b.map((label, index) => ({ label, action: it.actions?.[index] || '' }))
      .filter(button => !/^(Retry|Try(?: again)?|重试|再试一次)$/i.test(button.label));
    if (buttons.length !== it.b.length) rows.set(id, { ...it, b: buttons.map(button => button.label),
      ...(it.actions ? { actions: buttons.map(button => button.action) } : {}) });
  }
  if ('historyBefore' in chat) {
    chat.earlier = !!chat._historyEarlier;
    delete chat._historyEarlier; delete chat._historyStart;
    if (!chat.busy) for (const item of chat.items) {
      if (item.k === 'thinking') item.live = false;
      if (item.k === 'tool' && !item.keep) item.done = true;
    }
    // Only completed bodies survive a selection change; current controls come from this read.
    const completedRows = [...rows.values()].filter(item => item.k === 'human'
      || item.k === 'assistant' && item.completed || item.k === 'thinking' && !item.live
      || item.k === 'tool' && item.done || item.k === 'notice' && !item.live)
      .sort((a, b) => a.order - b.order).slice(-400);
    this.itemCache.delete(thread);
    this.itemCache.set(thread, completedRows);
    if (this.itemCache.size > 12) this.itemCache.delete(this.itemCache.keys().next().value);
    return;
  }
  const ordered = [...rows.values()].sort((a, b) => a.order - b.order);
  const turns = [...new Set(ordered.map(it => Math.floor(it.order / 10000)))].slice(-32);
  const retained = ordered.filter(it => turns.includes(Math.floor(it.order / 10000)));
  const anchors = new Set(retained.filter(it => it.k === 'human' || it.syntheticCapacity));
  for (const turn of turns) {
    const final = retained.findLast(it => Math.floor(it.order / 10000) === turn && it.k === 'assistant' && it.completed);
    if (final) anchors.add(final);
  }
  const details = new Set(retained.filter(it => !anchors.has(it)).slice(-400));
  chat.items = retained.filter(it => {
    if (anchors.has(it) || details.has(it)) return true;
    partial.add(Math.floor(it.order / 10000)); return false;
  });
  chat.items.partialTurns = [...partial].filter(turn => turns.includes(turn));
  chat.items.completeTurns = [...completed].filter(([, turn]) => turns.includes(turn));
  chat.earlier = chat._historyEarlier || this.codexEarlier(chat.items, undefined, chat._historyStart);
  delete chat._historyEarlier; delete chat._historyStart;
  if (!chat.busy) chat.items.filter(it => it.k === 'thinking').forEach(it => { it.live = false; });
  if (!chat.busy) chat.items.filter(it => it.k === 'tool' && !it.keep).forEach(it => { it.done = true; });
  this.itemCache.set(thread, chat.items);
},

async selectCodexThread(convId, cdp = this.cdp) {
  const deadline = cdpRead.getStore()?.deadline ?? Date.now() + 35000;
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error('Codex 会话导航超时，请重试');
    return ms;
  };
  const read = call => cdp.evaluate(helpersCall(call), { timeout: remaining() });
  const waitActive = (ms = 1800) => read(`codexWaitThread(${JSON.stringify(convId)}, ${Math.min(ms, remaining())})`);
  let opened = false, pos = null;
  do {
    opened = await read(`openCodexThread(${JSON.stringify(convId)})`);
    if (opened) break;
    pos = await read('codexRecentPoint()');
    if (pos) break;
    await awaitCdpRead(new Promise(r => setTimeout(r, Math.min(120, remaining()))));
  } while (Date.now() < deadline);
  if (!opened && !pos) throw new Error('Codex 会话导航尚未就绪，请稍后重试');
  if (opened) return waitActive(remaining());
  await this.tapCss(pos.x, pos.y, 'left', cdp);
  let point = null;
  for (let i = 0; i < 8 && !point; i++) {
    await awaitCdpRead(new Promise(r => setTimeout(r, Math.min(120, remaining()))));
    point = await read(`codexChatPoint(${JSON.stringify(convId)})`);
  }
  if (!point) {
    await read('closeCodexMenu()');
    return false;
  }
  await this.tapCss(point.x, point.y, 'left', cdp);
  if (await waitActive()) return true;
  await read('closeCodexMenu()');
  return false;
},

async adoptCodexThread(thread, statusMsg) {
  const switching = this.switchingThread;
  this.switchingThread = true;
  try {
    if (this.threadId !== (thread || '')) this.clearViewState();
    this.threadId = thread || '';
    if (this.codexOwnerRoot && thread) this.codexOwnerRoot = (await this.cdp.evaluate(helpersCall(`nativeSessionInfo('codex', ${JSON.stringify(thread)}, 'context')`))).cwd;
  } finally {
    this.switchingThread = switching;
  }
  this.publishThread(statusMsg);
  if (!switching && this.bindingReady) {
    await this.pollChat(true, true);
  }
},

async checkCodexLogin() {
  if (!await this.cdp.evaluate(helpersCall('codexNeedsLogin()'))) return false;
  const chat = { items: [], global: [], thread: '', readonly: true, loginRequired: true };
  const raw = JSON.stringify(chat);
  if (this.lastChat !== raw) {
    this.lastChat = raw;
    this.emit({ t: 'chat', sel: this.selectionKey(), chat });
    this.emit({ t: 'status', ok: false, msg: '项目窗口已打开，请在电脑端登录此窗口的 Codex，登录后重新选择会话' });
  }
  return true;
},

codexEarlier(items, partial = items.partialTurns?.length > 0, start = 1) {
  if (partial) return true;
  const turns = [...new Set(items.map(it => Math.floor((it.order ?? Infinity) / 10000)))].sort((a, b) => a - b);
  return !turns.length || turns[0] !== start || turns.some((n, i) => !Number.isFinite(n) || (i > 0 && n !== turns[i - 1] + 1));
},

async waitCodexNewChatReady() {
  for (let i = 0; i < 120; i++) {
    if (this.pendingProject?.trust) return;
    if (await this.checkCodexLogin()) return false;
    if (await this.cdp.evaluate(helpersCall('codexNewPoint()'))) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('项目已打开，但 Codex 会话入口尚未就绪');
},

async newCodexChat() {
  if (!this.cdp) throw new Error('还没有连上 Codex');
  if (await this.checkCodexLogin()) throw new Error('请先在电脑端登录此窗口的 Codex，再新建会话');
  await this.cdp.evaluate(helpersCall('codexViewState(true)'));
  const before = await this.cdp.evaluate(helpersCall('codexThread()')) || '';
  const pos = await this.cdp.evaluate(helpersCall('codexNewPoint()'));
  if (!pos) throw new Error('这个窗口里没有新建对话');
  await this.tapCss(pos.x, pos.y);
  let thread = before;
  let turns = 1;
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 150));
    const view = await this.cdp.evaluate(helpersCall('codexViewState()'));
    thread = view?.thread || '';
    turns = view?.turns ?? 1;
    if ((thread && thread !== before) || (!thread && turns === 0)) break;
  }
  if (thread === before && turns > 0) throw new Error('新建会话没有生效');
  await this.adoptCodexThread(thread === before ? '' : thread, '已新建会话');
},

async openCodexAgent(id, preferCurrentProject = false) {
  if (id.startsWith('win:')) {
    await this.attach({ id: 'codex', windowId: id.slice(4), threadId: '' });
    this.emit({ t: 'status', ok: true, msg: '已切换窗口' });
    return;
  }
  if (id.startsWith('new:')) {
    const [, pageId, encodedRoot] = id.split(':');
    const page = (await codexWindows(CODEX_CDP_URL)).find(p => p.pageId === pageId);
    const root = encodedRoot ? decodeURIComponent(encodedRoot) : windowRoots(page?.rawTitle || '', 'codex')[0]?.root;
    if (!root) throw new Error('无法确认新会话所属项目，请刷新项目与会话列表');
    return this.useProject(root, true);
  }
  const match = /^thread:([^:]+):(.+)$/.exec(id || '');
  if (!match) throw new Error('这条会话已经不在列表里');
  const convId = match[2];
  const own = match[1] === this.codexPageId;
  const page = own ? null : (await codexWindows(CODEX_CDP_URL, false, match[1]))[0];
  const source = page?.chatWs ? new Cdp(page.chatWs) : this.cdp;
  let context;
  try {
    if (source !== this.cdp) await source.connect();
    context = await source.evaluate(helpersCall(`nativeSessionInfo('codex', ${JSON.stringify(convId)}, 'context')`));
  } finally { if (source !== this.cdp) source.close(); }
  const workspace = context?.cwd, host = context?.host || '';
  if (preferCurrentProject && workspace && this.projectMatches(await editorRoots(this.editorCdp, 'codex'), workspace, host)) {
    if (!await this.selectCodexThread(convId)) throw new Error('没有找到所选会话');
    await this.adoptCodexThread(convId, '已切换会话');
    return;
  }
  if (workspace && !host) {
    return this.useProject(workspace, false, convId, '', match[1]);
  }
  if (host) {
    const page = (await codexWindows(CODEX_CDP_URL, false, match[1]))[0];
    if (!page) throw new Error('所选会话窗口已经关闭');
    const state = await this.projectWindowState({ ...page, id: page.pageId });
    if (state.busy && state.thread !== convId) throw new Error('目标远程窗口正在运行，请先在电脑上为目标会话打开独立窗口');
    const switching = this.switchingThread, previousCdp = this.cdp;
    this.switchingThread = true;
    this.bindingReady = false;
    try {
      if (page.pageId !== this.codexPageId) await this.openBound({ id: 'codex', app: 'codex', title: page.rawTitle, ws: page.ws, port: CODEX_CDP_URL },
        page.ws, page.chatWs, { windowId: page.pageId, threadId: convId, deferred: true });
      if (await this.checkProjectTrust({ threadId: convId })) return;
      if (!await this.selectCodexThread(convId)) throw new Error('没有找到所选会话');
      await this.adoptCodexThread(convId, '已切换会话');
      this.bindingReady = true;
    } finally {
      if (switching) this.switchingThread = switching;
      else await this.resumeProjectSwitch(previousCdp);
    }
    return;
  }
  throw new Error('无法确认会话所属项目，请刷新项目与会话列表');
},

async codexPageForThread(pages, threadId) {
  const settled = await Promise.allSettled(pages.filter(p => p.chatWs).map(async page => {
    const cdp = new Cdp(page.chatWs);
    try {
      await cdp.connect();
      const state = await cdp.evaluate(helpersCall('agentState()'));
      const rows = await cdp.evaluate(helpersCall('codexChatRows(true)'));
      const row = rows.find(r => r.id === threadId);
      return { page, active: state?.thread === threadId, inWorkspace: !!row && (!row.workspace || state?.roots?.includes(row.workspace)) };
    } finally { cdp.close(); }
  }));
  const matches = settled.filter(s => s.status === 'fulfilled').map(s => s.value);
  return matches.find(m => m.active && m.inWorkspace)?.page || matches.find(m => m.inWorkspace)?.page || null;
},

async probeCodex(page) {
  if (!page?.chatWs && page?.pageId !== this.codexPageId) return null;
  const source = !this.fusionBinding && nativeWindowAt(page.chatWs);
  if (source?.snapshot) return (await source.read()).states.find(state => state.thread === source.snapshot.chat?.thread) || null;
  if (page.pageId === this.codexPageId && this.cdp) {
    try { return await this.cdp.evaluate(helpersCall('agentState()')); } catch { return null; }
  }
  if (!page.chatWs) return null;
  const cdp = new Cdp(page.chatWs);
  try {
    await cdp.connect();
    return await cdp.evaluate(helpersCall('agentState()'));
  } catch {
    return null;
  } finally {
    try { cdp.close(); } catch {}
  }
},

rememberCodexRoots(rows) {
  if (!this.codexRoots) this.codexRoots = new Map();
  for (const row of rows || []) {
    if (row?.id && row.workspace) {
      this.codexRoots.set(row.id, row.workspace);
      const id = JSON.stringify([computerId(), 'codex', row.host || '', row.id]);
      const project = fusionProject(row.workspace, row.host || '');
      if (project) conversationProjects[id] = { project, originProject: conversationProjects[id]?.originProject || project };
    }
  }
  saveState({ conversationProjects });
},

async codexThreadRows(cdp = this.cdp) {
  const pos = await cdp.evaluate(helpersCall('codexRecentPoint(true)'));
  if (!pos) return [];
  let rows = [];
  for (let i = 0; i < 8 && !rows.length; i++) {
    await new Promise(r => setTimeout(r, 120));
    rows = await cdp.evaluate(helpersCall('codexChatRows()')) || [];
  }
  const recent = await cdp.evaluate(helpersCall('codexChatRows(true)')) || [];
  await cdp.evaluate(helpersCall('closeCodexMenu()'));
  const merged = new Map(recent.map(row => [row.id, row]));
  for (const row of rows) merged.set(row.id, { ...merged.get(row.id), ...row });
  return [...merged.values()];
},

async enableCodexMax() {
  try {
    await this.withCodexSettings(async cdp => {
      let data = await cdp.evaluate(helpersCall('codexSettingsData()'));
      const previous = data.nav.find(n => n.current);
      const navigate = async item => {
        const before = JSON.stringify(data);
        const pos = await cdp.evaluate(helpersCall(`codexSettingPoint(${JSON.stringify(item.id)})`));
        await this.tapCss(pos.x, pos.y, 'left', cdp);
        data = await cdp.evaluate(helpersCall(`waitSettings('codex', ${JSON.stringify(before)})`));
      };
      try {
        const config = data.nav.find(n => /^(Configuration|配置)$/.test(n.label));
        if (!config) throw new Error('没有找到 Codex 原生配置入口');
        if (!config.current) await navigate(config);
        const row = data.rows.find(r => /^(Available reasoning efforts|可用推理强度)$/.test(r.label));
        if (!row) throw new Error('没有找到 Codex 思考强度设置');
        const pos = await cdp.evaluate(helpersCall(`codexSettingPoint(${JSON.stringify(row.controls[0].id)})`));
        await this.tapCss(pos.x, pos.y, 'left', cdp);
        const choice = await cdp.evaluate(`(() => { const doc = document.getElementById('active-frame').contentDocument; const option = [...doc.querySelectorAll('[role=menuitemcheckbox]')].find(el => el.textContent.trim() === 'Max'); if (!option || option.getAttribute('aria-disabled') === 'true') return null; option.dataset.remoteSetting ||= crypto.randomUUID(); return { id: option.dataset.remoteSetting, enabled: option.getAttribute('aria-checked') === 'true' }; })()`);
        if (!choice) throw new Error('当前 Codex 无法启用 Max');
        if (!choice.enabled) {
          const target = await cdp.evaluate(helpersCall(`codexSettingPoint(${JSON.stringify(choice.id)})`));
          await this.tapCss(target.x, target.y, 'left', cdp);
          const checked = await cdp.evaluate(`new Promise(resolve => { const doc = document.getElementById('active-frame').contentDocument, started = Date.now(); const read = () => { const el = [...doc.querySelectorAll('[role=menuitemcheckbox]')].find(el => el.textContent.trim() === 'Max'); if (el?.getAttribute('aria-checked') === 'true') return resolve(true); if (Date.now() - started >= 2000) return resolve(false); setTimeout(read, 30); }; read(); })`);
          if (!checked) throw new Error('Codex 原生 Max 设置尚未生效');
        }
        await this.key('Escape', { cdp });
      } finally {
        if (previous && !data.nav.some(n => n.id === previous.id && n.current)) await navigate(previous);
      }
    });
  } finally { await cdpRead.run(null, () => this.closeCodexSettings()); }
},

async withCodexSettings(fn) {
  const editor = this.editorCdp, sidebar = this.cdp;
  const deadline = cdpRead.getStore()?.deadline || Date.now() + 30000;
  const read = (cdp, source) => cdp.evaluate(source, { timeout: Math.max(1, deadline - Date.now()) });
  const until = async (read, message) => {
    while (Date.now() < deadline) {
      const value = await read();
      if (value) return value;
      await awaitCdpRead(new Promise(resolve => setTimeout(resolve, Math.min(30, Math.max(0, deadline - Date.now())))));
    }
    throw new Error(message);
  };
  const settingsKey = () => read(editor, `(() => { if (![...document.querySelectorAll('.tab.active')].some(e => /^Codex Settings(?:,|$)/.test(e.getAttribute('aria-label') || ''))) return ''; const el = [...document.querySelectorAll('iframe[src*="extensionId=openai.chatgpt"]')].find(e => !e.src.includes('purpose=webviewView') && e.getBoundingClientRect().height > 0); return el ? new URL(el.src).searchParams.get('id') : ''; })()`);
  try {
    const before = await read(editor, `(() => { const t = [...document.querySelectorAll('.tab')].find(e => /^Codex Settings(?:,|$)/.test(e.getAttribute('aria-label') || '')); return !!t; })()`);
    let key = await settingsKey();
    let cdp = key && key === this.codexSettingsKey && this.codexSettingsEditor === editor && this.codexSettingsCdp?.ws?.readyState === 1 ? this.codexSettingsCdp : null;
    if (!cdp) {
      this.codexSettingsCdp?.close();
      this.codexSettingsCdp = null;
      this.codexSettingsEditor = editor;
      if (!key) {
        this.codexSettingsReturn = await read(editor, `(() => { const tab = document.querySelector('.editor-group-container.active .tab.active'); if (!tab || /^Codex Settings(?:,|$)/.test(tab.getAttribute('aria-label') || '')) return ''; tab.dataset.remoteSettingsReturn ||= crypto.randomUUID(); return tab.dataset.remoteSettingsReturn; })()`);
        if (before) {
          const pos = await read(editor, `(() => { const tab = [...document.querySelectorAll('.tab')].find(e => /^Codex Settings(?:,|$)/.test(e.getAttribute('aria-label') || '')); const r = tab.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
          await this.tapCss(pos.x, pos.y, 'left', editor);
        } else {
          const account = await until(() => read(sidebar, helpersCall('codexAccountPoint()')), '没有找到 Codex 设置菜单');
          await this.tapCss(account.x, account.y, 'left', sidebar);
          const pos = await until(() => read(sidebar, helpersCall("codexMenuPoint('Codex settings')")), 'Codex 菜单没有设置入口');
          await this.tapCss(pos.x, pos.y, 'left', sidebar);
        }
        key = await until(settingsKey, 'Codex 设置页面尚未打开');
      }
      const target = await until(async () => {
        const targets = await awaitCdpRead(fetch(`${CODEX_CDP_URL}/json/list`, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) }).then(response => response.json()));
        return targets.find(t => /extensionId=openai.chatgpt/.test(t.url || '') && new URL(t.url).searchParams.get('id') === key);
      }, 'Codex 设置页面尚未连接');
      this.codexSettingsViewWs = target.webSocketDebuggerUrl;
      cdp = this.codexSettingsCdp = new Cdp(target.webSocketDebuggerUrl);
      await cdp.connect(Math.max(1, deadline - Date.now()));
      this.codexSettingsKey = key;
    }
    await until(() => read(cdp, `!!document.getElementById('active-frame')?.contentDocument?.querySelector('[data-appearance] button.sidebar-item')`), 'Codex 设置内容尚未加载');
    return await fn(cdp);
  } catch (error) {
    try { await cdpRead.run(null, () => this.closeCodexSettings()); }
    finally { throw error; }
  }
},

async showCodexSettings(id = '', requestId = 0, value) {
  const sel = this.sel;
  const data = await this.withCodexSettings(async cdp => {
    const previous = id ? await cdp.evaluate(helpersCall('codexSettingsData()')) : null;
    const before = previous ? JSON.stringify(previous) : '';
    const navigating = previous?.nav.find(n => n.id === id && !n.current);
    if (id) {
      if (value !== undefined) await cdp.evaluate(helpersCall(`codexSettingValue(${JSON.stringify(id)}, ${JSON.stringify(value)})`));
      else {
        const pos = await cdp.evaluate(helpersCall(`codexSettingPoint(${JSON.stringify(id)})`));
        if (!pos) throw new Error('设置选项已改变，请重新打开设置');
        await this.tapCss(pos.x, pos.y, 'left', cdp);
      }
    }
    const data = await cdp.evaluate(helpersCall(`waitSettings('codex', ${JSON.stringify(before)}, ${navigating || !before ? 1200 : 200})`));
    if (!data.nav.length) throw new Error('Codex 设置内容尚未加载');
    if (navigating && (!data.nav.some(n => n.current && n.label === navigating.label) || (!data.dialog && data.title !== navigating.label)))
      throw new Error('Codex 设置栏目尚未切换，请重试');
    return data;
  });
  if (this.sel === sel && this.app === 'codex') this.emit({ t: 'settings', codex: true, requestId, ...data });
},

async saveCodexInstructions(text, requestId = 0) {
  const sel = this.sel;
  const data = await this.withCodexSettings(cdp => cdp.evaluate(helpersCall(`codexSaveInstructions(${JSON.stringify(text)})`)));
  if (this.sel === sel && this.app === 'codex') {
    this.emit({ t: 'settings', codex: true, requestId, ...data });
    this.emit({ t: 'status', ok: true, msg: 'Codex instructions 已保存' });
  }
},

async closeCodexSettings() {
  const editor = this.codexSettingsEditor || this.editorCdp;
  this.codexSettingsKey = '';
  this.codexSettingsCdp?.close();
  this.codexSettingsCdp = null;
  this.codexSettingsEditor = null;
  const view = this.codexSettingsViewWs;
  this.codexSettingsViewWs = '';
  if (view) {
    const menu = new Cdp(view);
    await menu.connect();
    try { await this.key('Escape', { cdp: menu }); } finally { menu.close(); }
  }
  const previous = this.codexSettingsReturn;
  this.codexSettingsReturn = '';
  if (previous && editor) {
    const pos = await editor.evaluate(`(() => { const tab = document.querySelector('[data-remote-settings-return="' + ${JSON.stringify(previous)} + '"]'); if (!tab) return null; const r = tab.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (pos) await this.tapCss(pos.x, pos.y, 'left', editor);
  }
},

async readCodexAccount(request) {
  const cdp = this.cdp, sel = this.sel;
  const native = await cdp.evaluate(helpersCall('refreshCodexUsage(false)'));
  if (native && (!codexUsage.data || native.updated > codexUsage.data.updated)) {
    codexUsage.data = native;
    codexUsage.retryAt = 0;
    codexUsage.failures = 0;
  }
  if (!request.fusion && codexUsage.data && this.liveRead(cdp, sel)) this.emit({ t: 'usage', sel: this.selectionKey(), ...codexUsage.data, cached: true });
  if (!request.manual && Date.now() < codexUsage.retryAt) throw codexUsage.error;
  if (!request.manual && codexUsage.data && Date.now() - codexUsage.data.updated < 60000) return { ...codexUsage.data, cached: true };
  if (!codexUsage.refresh) {
    codexUsage.refresh = cdp.evaluate(helpersCall('refreshCodexUsage()'), { timeout: 120000 }).then(data => {
      codexUsage.data = data;
      codexUsage.failures = 0;
      codexUsage.retryAt = 0;
      return data;
    }).catch(error => {
      codexUsage.error = error;
      codexUsage.retryAt = Date.now() + Math.min(60000 * 2 ** ++codexUsage.failures, 300000);
      throw error;
    }).finally(() => { codexUsage.refresh = null; });
  }
  return codexUsage.refresh;
},

async codexPrompt() {
  const text = await this.cdp.evaluate(helpersCall('codexPromptText()'));
  return typeof text === 'string' ? text : '';
},

async codexFocusPrompt() {
  if (!await this.cdp.evaluate(FOCUS_COMPOSER)) throw new Error('没找到 Codex 的输入框');
  const pos = await this.cdp.evaluate(helpersCall('codexPromptPoint()'));
  if (pos) await this.tapCss(pos.x, pos.y);
},

async codexRestorePrompt(before) {
  let now = await this.codexPrompt();
  if (now === before) return;
  await this.closeMenus();
  await new Promise(r => setTimeout(r, 120));
  now = await this.codexPrompt();
  if (now === before) return;
  if (before && now.startsWith(before)) {
    const extra = now.slice(before.length);
    for (let i = 0; i < extra.length; i++) await this.key('Backspace');
    if (await this.codexPrompt() === before) return;
  }
  if (!before) {
    await this.cdp.evaluate(helpersCall('codexSelectPrompt()'));
    await this.key('Backspace');
    await new Promise(r => setTimeout(r, 80));
  }
},

async codexMentionSettle(seq) {
  let last = '', rows = [];
  for (let i = 0; i < 16; i++) {
    if (seq != null && this.mentionSeq !== seq) return null;
    await new Promise(r => setTimeout(r, 140));
    if (seq != null && this.mentionSeq !== seq) return null;
    rows = await this.cdp.evaluate(helpersCall('codexMentionRows()')) || [];
    if (seq != null && this.mentionSeq !== seq) return null;
    const sig = JSON.stringify(rows.map(r => [r.section, r.key, r.label]));
    if (rows.length && sig === last && i >= 2) break;
    last = sig;
  }
  return rows;
},

mentionPayload(rows) {
  return rows.slice(0, 40).map(r => ({ label: r.label, sub: r.sub || '', key: r.key || '', section: r.section || '' }));
},

async codexMentionQuery(q, trigger, seq, query) {
  const out = await this.withMentionLock(seq, async () => {
    if (this.mentionSeq !== seq) return null;
    return this.withComposerQuery(query, async () => {
      await this.cdp.send('Input.insertText', { text: trigger + String(q || '') });
      return this.codexMentionSettle(seq);
    });
  }).catch(e => { this.emit({ t: 'status', ok: false, msg: e.message }); return null; });
  if (out && this.mentionSeq === seq) this.emit({ t: 'mentions', sel: this.selectionKey(), seq, q, trigger, rows: this.mentionPayload(out) });
},

async codexOpenMention(trigger, q) {
  await this.codexFocusPrompt();
  await this.cdp.send('Input.insertText', { text: trigger + String(q || '') });
  return this.codexMentionSettle();
},

async codexPick(msg) {
  if (this.app !== 'codex') return;
  const trigger = msg.section === 'commands' || msg.section === 'Skills' ? '/' : '@';
  const parentQ = String(msg.parentQ || msg.q || '').slice(0, 60);
  return this.withMentionLock(null, () => this.withComposerQuery(msg, async () => {
    await this.cdp.send('Input.insertText', { text: trigger + parentQ });
    let rows = await this.codexMentionSettle();
    if (msg.parentKey) {
      const parent = rows.find(r => r.key === msg.parentKey) || rows.find(r => r.label === msg.parentLabel) || rows.find(r => msg.parentLabel && r.label.startsWith(msg.parentLabel));
      if (!parent) throw new Error('电脑上的菜单里没有上一级');
      await this.tapCss(parent.x, parent.y);
      await new Promise(r => setTimeout(r, 350));
      rows = await this.codexMentionSettle();
    }
    const hit = rows.find(r => msg.key && r.key === msg.key) || rows.find(r => r.label === msg.label) || rows.find(r => msg.label && (r.label === msg.label || r.label.startsWith(msg.label)));
    if (!hit) throw new Error('电脑上的菜单里没有这一项');
    await this.tapCss(hit.x, hit.y);
    await new Promise(r => setTimeout(r, 400));
    const dialog = await this.cdp.evaluate(`(() => { const doc = document.getElementById('active-frame')?.contentDocument || document; return [...doc.querySelectorAll('[role=dialog]')].some(e => e.getBoundingClientRect().height > 40); })()`);
    if (dialog) {
      this.emit({ t: 'status', ok: true, msg: '请在请求卡片中确认' });
      this.refreshSoon(300);
      return;
    }
    const next = await this.cdp.evaluate(helpersCall('codexMentionRows()')) || [];
    const branched = next.length && !next.some(r => r.key === hit.key && r.label === hit.label);
    if (branched) {
      this.emit({
        t: 'mentions', sel: this.selectionKey(), seq: Number(msg.seq) || 0, submenu: true, q: '',
        parent: { key: hit.key, label: hit.label, q: parentQ, section: hit.section || msg.section || '' },
        rows: this.mentionPayload(next),
      });
      return;
    }
    this.emit({ t: 'status', ok: true, msg: `已执行 ${hit.label.split('\n')[0]}` });
    this.refreshSoon(300);
  }));
},

async codexSkillList() {
  const rows = await this.withMentionLock(null, async () => {
    await this.codexFocusPrompt();
    const before = await this.codexPrompt();
    try {
      // Opening the native menu loads skills even after its query cache has expired.
      await this.codexOpenMention('/', '');
      return await this.cdp.evaluate(helpersCall('codexSkills()'));
    } finally { await this.codexRestorePrompt(before); }
  });
  this.emit({ t: 'codexSkills', rows });
},

async codexTogglePlan() {
  const before = (await this.cdp.evaluate(helpersCall('codexFacts()')))?.view?.plan;
  await this.codexPick({ section: 'commands', key: 'plan-mode', label: 'Plan mode', q: '' });
  const after = (await this.cdp.evaluate(helpersCall('codexFacts()')))?.view?.plan;
  if (after === before) throw new Error('Plan 模式没有跟着电脑变化');
  this.emit({ t: 'status', ok: true, msg: after ? '已打开 Plan' : '已关闭 Plan' });
},

async codexToggleIde() {
  const before = (await this.cdp.evaluate(helpersCall('codexFacts()')))?.view?.ide?.on;
  await this.codexPick({ section: 'commands', label: 'IDE context', q: 'ide' });
  let after = before;
  for (let i = 0; i < 12 && after === before; i++) {
    await new Promise(r => setTimeout(r, 150));
    after = (await this.cdp.evaluate(helpersCall('codexFacts()')))?.view?.ide?.on;
  }
  if (after === before) throw new Error('IDE 上下文没有切换成功');
  this.emit({ t: 'status', ok: true, msg: after ? 'IDE 上下文已打开' : 'IDE 上下文已关闭' });
},

async codexRunMenu() {
  const items = await readCodexMenu(this, 'run') || [];
  await this.closeMenus();
  this.emit({ t: 'menu', kind: 'codex-run', items: items.filter(it => /^(Local|Cloud|Worktree|Connect Codex web)\b/.test(it.label)).map(it => ({ label: it.label, checked: false })) });
},

async codexRunPick(label) {
  const hit = await readCodexMenu(this, 'run', items => items.find(it => it.label === label));
  if (!hit) { await this.closeMenus(); throw new Error(`没找到执行位置：${label}`); }
  await this.tapCss(hit.x, hit.y);
  await new Promise(r => setTimeout(r, 300));
  const run = (await this.cdp.evaluate(helpersCall('codexFacts()')))?.view?.run || '';
  this.emit({ t: 'status', ok: true, msg: run ? `执行位置：${run}` : `已选择 ${label}` });
  this.refreshSoon(300);
},

async codexChatMenu() {
  const items = await readCodexMenu(this, 'actions') || [];
  await this.closeMenus();
  this.emit({ t: 'menu', kind: 'codex-chat', items: items.map(it => ({ label: it.label, checked: false })) });
},

async codexChatPick(label, name) {
  const hit = await readCodexMenu(this, 'actions', items => items.find(it => it.label === label));
  if (!hit) { await this.key('Escape'); throw new Error(`没找到会话操作：${label}`); }
  const thread = await this.cdp.evaluate(helpersCall('codexThread()'));
  await this.tapCss(hit.x, hit.y);
  await new Promise(r => setTimeout(r, 300));
  if (label === 'Rename' && name) {
    const opened = await this.cdp.evaluate(`(() => {
      const doc = document.getElementById('active-frame')?.contentDocument || document;
      const input = [...doc.querySelectorAll('input, textarea')].find(e => e.getBoundingClientRect().height > 8);
      if (!input) return false;
      input.focus();
      input.select?.();
      return true;
    })()`);
    if (!opened) throw new Error('重命名输入框没有出现');
    await this.typeText(String(name).slice(0, 80));
    await this.key('Enter');
  }
  this.emit({ t: 'status', ok: true, msg: `已执行 ${label}` });
  const now = await this.cdp.evaluate(helpersCall('codexThread()'));
  if (now && now !== thread) await this.adoptCodexThread(now);
  this.refreshSoon(300);
  setTimeout(() => this.listAgents().catch(() => {}), 400);
},

async codexRenameThread(agentId, name) {
  if (this.app !== 'codex') throw new Error('只有 Codex 会话可以重命名');
  const next = String(name || '').trim().slice(0, 80);
  if (!next) throw new Error('会话名称不能为空');
  const match = /^thread:([^:]+):(.+)$/.exec(String(agentId || ''));
  if (!match) throw new Error('这条会话不能重命名');
  const pageId = match[1], convId = match[2];
  const page = (await codexWindows(CODEX_CDP_URL)).find(p => p.pageId === pageId);
  if (!page?.chatWs) throw new Error('这个窗口已经关闭');
  const own = pageId === this.codexPageId && this.cdp;
  const cdp = own ? this.cdp : new Cdp(page.chatWs);
  let beforeThread = '', failure;
  try {
    if (!own) await cdp.connect();
    beforeThread = await cdp.evaluate(helpersCall('codexThread()')) || '';
    if (beforeThread !== convId && !await this.selectCodexThread(convId, cdp)) throw new Error('没有找到这个会话');
    const pos = await cdp.evaluate(helpersCall(`codexButtonPoint('actions')`));
    if (!pos) throw new Error('当前会话没有操作菜单');
    await this.tapCss(pos.x, pos.y, 'left', cdp);
    let hit = null;
    for (let i = 0; i < 10 && !hit; i++) {
      await new Promise(r => setTimeout(r, 120));
      hit = (await cdp.evaluate(helpersCall('codexRunItems()')) || []).find(it => /^Rename(?: chat)?$/i.test(String(it.label || '').replace(/\s+/g, ' ').trim()));
    }
    if (!hit) { await cdp.evaluate(helpersCall('closeCodexMenu()')); throw new Error('没有找到重命名入口'); }
    await this.tapCss(hit.x, hit.y, 'left', cdp);
    const opened = await cdp.evaluate(`(() => {
      const doc = document.getElementById('active-frame')?.contentDocument || document;
      const input = [...doc.querySelectorAll('input, textarea')].find(e => e.getBoundingClientRect().height > 8);
      if (!input) return false;
      input.focus(); input.select?.(); return true;
    })()`);
    if (!opened) throw new Error('重命名输入框没有出现');
    await this.typeText(next, cdp);
    await this.key('Enter', { cdp });
    let renamed = false;
    for (let i = 0; i < 20 && !renamed; i++) {
      await new Promise(r => setTimeout(r, 150));
      const rows = await this.codexThreadRows(cdp).catch(() => []);
      renamed = rows.some(row => row.id === convId && String(row.title || '').trim() === next);
    }
    if (!renamed) throw new Error('桌面端未确认会话名称已更新');
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await cdpRead.run(null, async () => {
        if (beforeThread && beforeThread !== convId && !await this.selectCodexThread(beforeThread, cdp)) throw new Error('未能恢复原会话');
        if (own) { this.lastChatAt = 0; await this.pollChat(); }
      });
    } catch (error) {
      if (failure) throw new AggregateError([failure, error], failure.message);
      throw error;
    } finally {
      if (!own) { try { cdp.close(); } catch {} }
    }
  }
  await this.listAgents();
  publishSessionChange('codex', convId, { action: 'rename', title: next });
  this.emit({ t: 'status', ok: true, msg: '已重命名会话' });
},

async codexArchiveThread(agentId, requiredAction = '') {
  if (this.app !== 'codex') throw new Error('只有 Codex 会话可以这样移除');
  const match = /^thread:([^:]+):(.+)$/.exec(String(agentId || ''));
  if (!match) throw new Error('这条会话不能移除');
  const pageId = match[1], convId = match[2];
  const pages = await codexWindows(CODEX_CDP_URL);
  const page = pages.find(p => p.pageId === pageId);
  if (!page?.chatWs) throw new Error('这个窗口已经关闭');
  const own = pageId === this.codexPageId && this.cdp;
  const cdp = own ? this.cdp : new Cdp(page.chatWs);
  const wasCurrent = !!own && this.threadId === convId;
  try {
    if (!own) await cdp.connect();
    const beforeThread = await cdp.evaluate(helpersCall('codexThread()')) || '';
    const pos = await cdp.evaluate(helpersCall('codexRecentPoint(true)'));
    if (!pos) throw new Error('没有找到会话列表');
    let target = null;
    for (let i = 0; i < 8 && !target; i++) {
      await new Promise(r => setTimeout(r, 120));
      target = await cdp.evaluate(helpersCall(`codexArchiveTarget(${JSON.stringify(convId)}, ${JSON.stringify(requiredAction)})`));
    }
    if (!target?.action) {
      await cdp.evaluate(helpersCall('closeCodexMenu()'));
      if (requiredAction) return false;
      throw new Error(target ? '这个会话没有归档或删除入口' : '没有找到这个会话');
    }
    await this.tapCss(target.x, target.y, 'left', cdp);
    let removed = false;
    for (let i = 0; i < 60 && !removed; i++) {
      await new Promise(r => setTimeout(r, 150));
      const confirm = await cdp.evaluate(helpersCall(`codexArchiveConfirm(${JSON.stringify(convId)})`));
      if (confirm) await this.tapCss(confirm.x, confirm.y, 'left', cdp);
      removed = await cdp.evaluate(helpersCall(`codexArchiveDone(${JSON.stringify(convId)}, ${JSON.stringify(target.action)})`));
    }
    await cdp.evaluate(helpersCall('closeCodexMenu()'));
    if (!removed) throw new Error('桌面端尚未确认删除或归档完成');
    const afterThread = await cdp.evaluate(helpersCall('codexThread()')) || '';
    if (!wasCurrent && afterThread && beforeThread && afterThread !== beforeThread) {
      const phoneThread = this.threadId;
      const saved = this.cdp;
      this.cdp = cdp;
      try { if (!await this.selectCodexThread(beforeThread) && own) this.threadId = afterThread; }
      finally { this.cdp = saved; if (!own) this.threadId = phoneThread; }
    } else if (wasCurrent) {
      this.threadId = afterThread;
      this.publishThread();
      this.lastChatAt = 0;
      await this.pollChat();
    }
    await this.listAgents();
    if (target.action === 'Delete chat') removeLibrarySession('codex', convId);
    publishSessionChange('codex', convId, { action: target.action === 'Delete chat' ? 'delete' : 'archive' });
    this.emit({ t: 'codexArchived', id: agentId, action: target.action });
    this.emit({ t: 'status', ok: true, msg: target.action === 'Delete chat' ? '已删除' : '已归档' });
    if (requiredAction) return true;
  } catch (e) {
    await this.listAgents().catch(() => {});
    throw e;
  } finally {
    if (!own) { try { cdp.close(); } catch {} }
  }
},

async insertCodexMention(m, before) {
  if (m.section === 'local-files') return this.cdp.evaluate(helpersCall(`codexAddFiles(${JSON.stringify([m.path])})`));
  const trigger = m.trigger === '/' ? '/' : '@';
  const typed = trigger + (m.q || m.label);
  await this.cdp.send('Input.insertText', { text: typed });
  const rows = await this.codexMentionSettle();
  const hit = rows.find(r => m.key && r.key === m.key) || rows.find(r => r.label === m.label) || rows.find(r => m.label && r.label.startsWith(m.label));
  if (!hit) { await this.codexRestorePrompt(before); return false; }
  await this.tapCss(hit.x, hit.y);
  await new Promise(r => setTimeout(r, 250));
  return true;
},

async typeWithCodexMentions(text, mentions) {
  return this.typeWithNativeMentions(text, mentions, async mention => this.insertCodexMention(mention, await this.codexPrompt()));
}
};
