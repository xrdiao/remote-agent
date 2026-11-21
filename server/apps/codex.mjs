import { parseAgentRef } from '../../lib/shared-rules.mjs';
import { Cdp, cdpRead, awaitCdpRead } from '../cdp.mjs';
import { windowRoots, editorRoots, workspaceLabel } from '../../lib/files.mjs';
import { agentMarks } from '../../lib/marks.mjs';
import { IS_WIN, mod, normPath, pathKey, localFilePath, samePath } from '../../lib/platform.mjs';
import { codexWindows, codexContext } from '../windows.mjs';
import { CODEX_CDP_URL } from '../config.mjs';
import { PAGE_SRC, helpersCall } from '../page/build.mjs';
import { AgentContext, FOCUS_COMPOSER, appPlans } from '../agent/context.mjs';
import { resetThinkingCaches } from '../agent/thinking-cache.mjs';
import { computerId, saveState } from '../../lib/auth.mjs';
import { conversationProjects, fusionProject, allFusionRuns } from '../fusion/state.mjs';
import { removeLibrarySession, publishSessionChange, rememberSessionMessage, rememberSessionStatuses } from '../../lib/session-library.mjs';
import { NativeCdp, nativeWindowAt, nativeSessionCatalog, nativeTargets } from '../native-windows.mjs';
import { currentOperation } from '../operations.mjs';
import { codexBackend, codexAccountKey, CODEX_BACKEND, isCompletedFileChange } from '../codex/state.mjs';
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
import { createHash } from 'node:crypto';

const accountPlan = value => {
  const plan = value?.account?.planType || '';
  return plan.charAt(0).toUpperCase() + plan.slice(1);
};
const accountStamp = value => value ? createHash('sha256').update(codexAccountKey(value)).digest('hex') : '';
const goalCommand = { key: 'goal', label: 'Goal', sub: '设置或查看当前会话的目标', section: 'commands' };

function desktopCodexSource(preferred) {
  const targets = nativeTargets().filter(win => win.app === 'codex');
  const target = targets.find(win => (win.pageId || win.id) === preferred) || targets[0];
  return target && nativeWindowAt(target.ws);
}

async function desktopCodexAccount(preferred) {
  const source = desktopCodexSource(preferred);
  if (!source) return null;
  await source.connect();
  const account = await source.cdp.evaluate(helpersCall('refreshCodexUsage(false, true)'), { timeout: 8500 });
  if (!account) throw new Error('Codex 窗口仍在读取账号，请稍后重试');
  return account;
}

async function ensureBackendAccount(s) {
  const expected = await desktopCodexAccount(s.codexAccountWindowId);
  const account = await codexBackend.alignAccount(expected);
  if (!account.account && account.requiresOpenaiAuth) throw new Error('请先在电脑端登录 Codex');
  return account;
}

function codexAccountMetadata(value) {
  return { account: accountStamp(value), plan: accountPlan(value) };
}

async function codexUsageData(readAccount, readLimits, publish = () => {}) {
  const account = await readAccount();
  if (!account) throw new Error('Codex 账号尚未加载');
  const metadata = codexAccountMetadata(account);
  publish(metadata);
  if (account.account?.type !== 'chatgpt') return { ...metadata, missing: true, limits: [], quota: [] };
  const result = await readLimits();
  const workspace = account.workspaceRouting?.chatgptAccountId;
  const current = await readAccount();
  if (codexAccountKey(current) !== codexAccountKey(account)) {
    publish(codexAccountMetadata(current));
    throw new Error('Codex 账号已切换，请重新读取额度');
  }
  if (result.accountId && workspace && result.accountId !== workspace) throw new Error('Codex 返回的额度属于其他账号');
  const snapshot = result.rateLimitsByLimitId?.codex || result.rateLimits;
  const limits = [snapshot?.primary, snapshot?.secondary].filter(Boolean).map(row => ({
    label: row.windowDurationMins === 10080 ? '每周限制' : row.windowDurationMins === 300 ? '5 小时限制' : '额度限制',
    kind: 'limit', basis: 'remaining', pct: 100 - row.usedPercent,
    reset: row.resetsAt ? new Date(row.resetsAt * 1000).toLocaleString('zh-CN') : '',
  }));
  return { ...metadata, updated: Date.now(), missing: !limits.length, limits, quota: [] };
}

function publishCodexAccount(session, metadata) {
  if (session.codexAccount?.account !== metadata.account) session.codexModelCatalog = null;
  session.codexAccount = metadata;
  appPlans.codex = metadata.plan;
  session.emit({ t: 'codexAccount', sel: session.selectionKey(), ...metadata });
}

const goalVersion = goal => goal ? JSON.stringify([goal.updatedAt, goal.status, goal.objective]) : '';

async function codexGoalRequest(session, id, action, message) {
  const owner = session.codexBackend ? await adapter.backendOwner(id, action !== 'read', session.codexAccountWindowId) : null;
  const attached = session.codexBackend ? null : session.cdp;
  const cdp = attached || (owner && new Cdp(owner.chatWs));
  const context = owner && { app: 'codex', threadId: id, cwd: owner.cwd, host: '' };
  const request = (method, params = {}) => {
    const packet = { method: `thread/goal/${method}`, params: { ...params, threadId: id } };
    return cdp ? cdp.evaluate(helpersCall(`nativeSessionInfo('codex', ${JSON.stringify(id)}, 'goal', ${JSON.stringify(packet)})`, context))
      : codexBackend.client.request(packet.method, packet.params);
  };
  const change = async thread => {
    if (message.sel !== session.selectionKey()) throw new Error('会话已切换，请重新打开 Goal');
    const { goal } = await request('get');
    if (action === 'read') return goal;
    if (message.expected !== goalVersion(goal)) throw new Error('目标已在 Codex 更新，请刷新后再操作');
    if (action === 'clear') {
      await request('clear', { origin: 'user' });
      return (await request('get')).goal;
    }
    const update = action === 'set' ? { objective: message.objective.trim(), ...(!goal ? { status: 'active' } : {}) }
      : { status: action === 'pause' ? 'paused' : 'active' };
    if (update.status === 'active' && thread?.settings.collaborationMode?.mode === 'plan') {
      const collaborationMode = { ...thread.settings.collaborationMode, mode: 'default' };
      await codexBackend.client.request('thread/settings/update', { threadId: id, collaborationMode });
      thread.settings.collaborationMode = collaborationMode;
      codexBackend.remember(thread);
    }
    return (await request('set', { ...update, origin: 'user' })).goal;
  };
  try {
    if (owner) await cdp.connect();
    if (cdp) return await change();
    await codexBackend.client.connect();
    if (action === 'set' || action === 'resume') await ensureBackendAccount(session);
    const update = async thread => {
      const goal = await change(thread);
      codexBackend.goals.set(id, goal || null);
      codexBackend.changed(id);
      return goal;
    };
    return action === 'read' ? await update() : await codexBackend.withWriter(id, update, { deferGoalContinuation: true });
  } finally { if (owner) cdp.close(); }
}

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
    codexAccount: s.codexAccount, capabilities: { ...capabilities, extraActions: false } });
}

function backendQuestionState(id) {
  const requests = new Map();
  const sources = new Map();
  let waiting = '', waitingText = '';
  for (const win of nativeTargets().filter(win => win.app === 'codex')) {
    const source = nativeWindowAt(win.ws);
    const local = state => !state?.host || state.host === 'local';
    const snapshots = [...source.conversations.values()].filter(view => view.snapshot?.chat?.thread === id && local(view.snapshot.state));
    const status = source.overviewStates(id).find(row => local(row));
    if (source.snapshot?.chat?.thread === id && status) snapshots.push({ at: source.updatedAt, snapshot: source.snapshot });
    const current = snapshots.sort((a, b) => b.at - a.at)[0];
    for (const row of current?.snapshot.chat?.questions?.requests || []) {
      if ((sources.get(row.id)?.at ?? -1) > current.at) continue;
      requests.set(row.id, row);
      sources.set(row.id, { source, at: current.at });
    }
    if (status?.waiting) { waiting = 'approval'; waitingText = status.waitingText || ''; }
  }
  return { requests: [...requests.values()], sources, waiting: requests.size ? 'approval' : waiting,
    waitingText: [...requests.values()].map(row => row.text).join('\n') || waitingText };
}

function backendPublish(s, sent) {
  if (!codexBackend.threads.has(s.threadId)) return false;
  const chat = codexBackend.chat(s.threadId, s.codexHistoryLimit || 60, undefined, s.expandedTools || new Set());
  const requests = new Map(chat.questions.requests.map(row => [row.id, row]));
  const native = backendQuestionState(s.threadId);
  s.codexPublishedQuestions = new Map();
  for (const row of native.requests) if (!requests.has(row.id)) {
    requests.set(row.id, row);
    s.codexPublishedQuestions.set(row.id, { threadId: s.threadId, source: native.sources.get(row.id).source });
  }
  chat.questions.requests = [...requests.values()];
  chat.waiting = requests.size ? 'approval' : native.waiting;
  chat.waitingText = chat.questions.requests[0]?.text || native.waitingText;
  rememberSessionStatuses([{ app: 'codex', threadId: s.threadId, busy: chat.busy, waiting: chat.waiting, run: chat.run }]);
  s.emit({ t: 'chat', sel: s.selectionKey(), chat }, sent);
  backendPublishDraft(s);
  return true;
}

function backendPublishDraft(s) {
  const text = codexBackend.draft(s.threadId);
  if (!s.draftWriting && !s.sending && text !== s.lastDraft) {
    s.lastDraft = text;
    s.emit({ t: 'draft', sel: s.selectionKey(), text, draftEpoch: s.draftEpoch || '', revision: s.draftRevision });
  }
}

function backendDraftSource(id) {
  return nativeTargets().filter(win => win.app === 'codex').map(win => nativeWindowAt(win.ws))
    .find(source => source.snapshot?.chat?.thread === id && source.snapshot.chat.readonly === false);
}

function recordBackendNativeDraft(source, id, text) {
  let drafts = codexBackend.nativeDrafts.get(id);
  if (!drafts) codexBackend.nativeDrafts.set(id, drafts = new WeakMap());
  drafts.set(source, text);
}

function backendCommands() {
  return [
    ['compact', 'Compact', '压缩当前会话上下文'], ['plan', 'Plan', '切换计划模式'],
    ['model', 'Model', '选择模型'], ['permissions', 'Permissions', '选择权限模式'], ['skills', 'Skills', '查看技能'],
  ].map(([key, label, sub]) => ({ key, label, sub, section: 'commands' })).concat(goalCommand);
}

async function syncCodexCatalog(id = '') {
  await Promise.all(nativeTargets().filter(win => win.app === 'codex').map(async win => {
    const cdp = new Cdp(win.ws);
    try {
      await cdp.connect();
      await cdp.evaluate(helpersCall(`nativeSessionInfo('codex', ${JSON.stringify(id)}, 'refreshCatalog')`));
    } finally { cdp.close(); }
  }));
}

let codexCatalogSync = Promise.resolve();
codexBackend.on('catalogChanged', id => {
  codexCatalogSync = syncCodexCatalog(codexBackend.owns(id) ? id : '');
  codexCatalogSync.catch(error => console.error('Codex 桌面会话列表同步失败:', error.message));
});

async function bindBackend(s, req) {
  const preferred = req.windowId && req.windowId !== CODEX_BACKEND ? req.windowId : s.codexAccountWindowId;
  let directory = req.project?.root ? safeHomePath(req.project.root).real
    : req.threadId ? null : safeHomePath(s.codexDirectory || os.homedir()).real;
  const id = req.threadId || (!req.newSession && [...codexBackend.records.values()].filter(row => samePath(path.resolve(localFilePath(row.cwd)), directory))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))[0]?.id);
  if (id && !codexBackend.hasWriter(id)) {
    const owner = await adapter.backendOwner(id, true, preferred);
    if (owner) {
      if (directory && !samePath(path.resolve(localFilePath(owner.cwd)), directory)) throw new Error('Codex 会话不属于所选项目');
      await s.attach({ id: 'codex', windowId: owner.pageId, threadId: id, nativeOwner: { cwd: owner.cwd }, initial: req.initial });
      if (req.project) s.projectReady({ root: owner.cwd, newSession: false, threadId: id });
      return;
    }
  }
  if (!id) await ensureBackendAccount({ codexAccountWindowId: preferred });
  const thread = await awaitCdpRead(id ? codexBackend.read(id) : codexBackend.create(directory));
  const account = await (async () => await desktopCodexAccount(preferred) || await codexBackend.account())().catch(() => null);
  if (!id) await awaitCdpRead(codexCatalogSync);
  directory = safeHomePath(directory || thread.cwd).real;
  if (!samePath(path.resolve(localFilePath(thread.cwd)), directory)) throw new Error('Codex 会话不属于所选项目');
  cdpRead.getStore()?.throwIfAborted();
  s.detach();
  s.clearViewState();
  s.app = s.targetId = 'codex';
  s.codexBackend = true;
  s.codexPageId = '';
  s.windowId = CODEX_BACKEND;
  s.codexDirectory = localFilePath(thread.cwd);
  s.threadId = s.selectedThread = thread.id;
  s.bindingReady = true;
  s.selectionHome = false;
  s.codexHistoryLimit = 60;
  s.codexAccountWindowId = preferred;
  s.codexAccount = codexAccountMetadata(account);
  rememberSelection(s.deviceId, { id: 'codex', app: 'codex', windowId: CODEX_BACKEND, threadId: thread.id, project: { root: thread.cwd, host: '' } });
  backendAttached(s, req.initial === true);
  s.prefetchMenus().catch(() => {});
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

async function withCodexModelOwner(s, action, readOnly = false) {
  const id = s.threadId;
  if (!id) throw new Error('Codex 会话尚未加载');
  if (!s.codexBackend) return action({ id, cdp: s.cdp });
  const owner = await s.adapter.backendOwner(id, !readOnly);
  if (!owner) {
    const account = await ensureBackendAccount(s);
    return readOnly ? action({ id, account, thread: await codexBackend.readModelState(id) })
      : codexBackend.withWriter(id, thread => action({ id, account, thread }));
  }
  const cdp = new Cdp(owner.chatWs), context = { app: 'codex', threadId: id, host: '', cwd: owner.cwd };
  try {
    await cdp.connect();
    return await action({ id, cdp, context });
  } finally { cdp.close(); }
}

async function codexModelSettings(owner, withAccount = false) {
  if (owner.thread) return { ...owner.thread.settings, model: owner.thread.settings.model || owner.thread.model,
    ...(withAccount ? { account: owner.account } : {}) };
  return owner.cdp.evaluate(helpersCall(`nativeSessionInfo('codex', ${JSON.stringify(owner.id)}, 'modelSettings', ${withAccount})`, owner.context));
}

async function codexModelList(owner, settings) {
  const models = [];
  let cursor = null;
  do {
    const params = { cursor, limit: 100, includeHidden: true, modelProvider: settings.modelProvider || null };
    const page = owner.thread ? await codexBackend.client.request('model/list', params)
      : await owner.cdp.evaluate(helpersCall(`nativeSessionInfo('codex', ${JSON.stringify(owner.id)}, 'modelPage', ${JSON.stringify(params)})`, owner.context));
    models.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return models;
}

const codexModelLists = new WeakMap();
async function codexMenuModels(owner, settings, account) {
  if (!account?.account) return codexModelList(owner, settings);
  const source = owner.thread ? codexBackend.client : nativeWindowAt(owner.cdp.wsUrl) || owner.cdp;
  const key = JSON.stringify([accountStamp(account), accountPlan(account), settings.modelProvider || null,
    owner.thread ? codexBackend.client.generation : owner.cdp.wsUrl, owner.context?.host || '']);
  const previous = codexModelLists.get(source);
  if (previous?.key === key && previous.until > Date.now()) return previous.result;
  const entry = { key, until: Infinity };
  entry.result = cdpRead.run(null, () => codexModelList(owner, settings)).then(models => {
    entry.until = Date.now() + 60000;
    return models;
  }, error => {
    if (codexModelLists.get(source) === entry) codexModelLists.delete(source);
    throw error;
  });
  codexModelLists.set(source, entry);
  return entry.result;
}

const codexModelId = model => model.model || model.id;
const codexFastTier = model => model?.serviceTiers?.find(tier =>
  ['priority', 'fast'].includes(tier.id) || ['fast', 'priority'].includes(String(tier.name || '').trim().toLowerCase()));
function codexFastState(model, settings) {
  const tier = codexFastTier(model);
  if (!tier) return null;
  return { on: settings.serviceTier === tier.id, description: tier.description || '' };
}

async function readCodexModelMenu(kind, requestId) {
  const sel = this.selectionKey(), id = this.threadId, generation = this.sel;
  const prefetch = requestId == null;
  const previous = this.codexModelRead;
  const sameSelection = previous && previous.sel === sel && previous.generation === generation;
  if (prefetch && sameSelection) return;
  const read = this.codexModelRead = { sel, generation, prefetch };
  const load = async owner => {
    const { account, ...settings } = await codexModelSettings(owner, true);
    const models = await codexMenuModels(owner, settings, account);
    return { settings, models, account: accountStamp(account) };
  };
  // A prefetch may use the current backend account, but must not switch it.
  const query = () => withCodexModelOwner(this, load, true);
  const warm = async () => {
    const account = await codexBackend.account();
    if (accountStamp(account) !== this.codexAccount?.account || !account.account || this.selectionKey() !== sel || this.sel !== generation) return null;
    return load({ id, account, thread: await codexBackend.readModelState(id) });
  };
  const pending = !prefetch && sameSelection && previous.prefetch ? previous.pending : null;
  read.pending = prefetch && this.codexBackend ? warm() : pending
    ? pending.then(result => result || query(), query) : query();
  const result = await read.pending.finally(() => { read.pending = null; });
  if (!result || this.codexModelRead !== read || this.selectionKey() !== sel || this.threadId !== id || this.sel !== generation) return;
  const { settings, models, account } = result;
  this.codexModelCatalog = { id, account, provider: settings.modelProvider || null, models };
  const current = models.find(row => codexModelId(row) === settings.model);
  const modelItems = models.filter(row => !row.hidden).map(row => ({ label: row.displayName || codexModelId(row),
    id: codexModelId(row), checked: codexModelId(row) === settings.model }));
  if (models.some(row => row.isDefault)) modelItems.unshift({ id: '__codex_default__', label: 'Default Recommended set of models', checked: false });
  const effortItems = (current?.supportedReasoningEfforts || []).map(row => ({ label: row.reasoningEffort,
    checked: row.reasoningEffort === (settings.effort ?? settings.reasoningEffort ?? current.defaultReasoningEffort) }));
  const fast = codexFastState(current, settings), model = current?.displayName || settings.model;
  const items = kind === 'effort' ? effortItems : kind === 'fast'
    ? ['Standard', 'Fast'].map(label => ({ label, checked: !!fast?.on === (label === 'Fast') })) : modelItems;
  this.emit({ t: 'menu', kind, requestId, sel, items, modelItems, effortItems, fast, model });
}

async function pickCodexModelMenu(kind, label, name) {
  const id = this.threadId, sel = this.selectionKey(), generation = this.sel, catalog = this.codexModelCatalog;
  if (!catalog || catalog.id !== id) throw new Error('请重新打开 Codex 模型菜单');
  const result = await withCodexModelOwner(this, async owner => {
    const { account, ...settings } = await codexModelSettings(owner, true);
    if (accountStamp(account) !== catalog.account) throw new Error('Codex 账号已切换，请重新打开菜单');
    if ((settings.modelProvider || null) !== catalog.provider) throw new Error('Codex 模型来源已变化，请重新打开菜单');
    const current = catalog.models.find(row => codexModelId(row) === settings.model);
    let update;
    if (kind === 'model') {
      const model = name === '__codex_default__' ? catalog.models.find(row => row.isDefault)
        : catalog.models.find(row => codexModelId(row) === name && !row.hidden);
      if (!model) throw new Error('Codex 模型已不存在');
      const effort = name === '__codex_default__' ? model.defaultReasoningEffort
        : model.supportedReasoningEfforts.find(row => row.reasoningEffort === settings.effort)?.reasoningEffort || model.defaultReasoningEffort;
      update = { model: codexModelId(model), effort };
    } else if (kind === 'effort') {
      if (!current?.supportedReasoningEfforts.some(row => row.reasoningEffort === label)) throw new Error('当前模型不支持这个思考强度');
      update = { effort: label };
    } else {
      const tier = codexFastTier(current);
      if (!tier) throw new Error('当前模型不支持 Fast');
      update = { serviceTier: label === 'on' || label === 'Fast' ? tier.id : null };
    }
    if (this.selectionKey() !== sel || this.threadId !== id || this.sel !== generation) throw new Error('会话已切换，请重新操作');
    if (owner.thread) {
      await codexBackend.client.request('thread/settings/update', { threadId: id, ...update });
      Object.assign(owner.thread.settings, update);
      codexBackend.remember(owner.thread);
      return owner.thread.settings;
    }
    return owner.cdp.evaluate(helpersCall(`nativeSessionAction('codex', ${JSON.stringify(id)}, 'modelSettings', ${JSON.stringify(update)})`, owner.context));
  });
  if (this.selectionKey() !== sel || this.threadId !== id || this.sel !== generation) return;
  if (kind === 'fast') {
    const current = catalog.models.find(row => codexModelId(row) === result.model);
    this.emit({ t: 'fastState', sel, fast: codexFastState(current, result) });
  }
  if (this.codexBackend) codexBackend.changed(id);
  else this.refreshModelChat().catch(() => {});
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
      if (!['fork', 'capacity-retry'].includes(m.actionId) || !codexBackend.chat(this.threadId, this.codexHistoryLimit || 60).items.some(item => item.btnItem === m.item && item.actions?.[m.n] === m.actionId))
        throw new Error('请求已更新，请查看最新选项');
      if (m.actionId === 'capacity-retry') await codexBackend.retry(this.threadId, m.item);
      else {
        const thread = await awaitCdpRead(codexBackend.fork(this.threadId, m.item, async source => {
          const owner = { thread: source };
          const settings = await codexModelSettings(owner);
          const models = await codexModelList(owner, settings);
          return models.find(model => codexModelId(model) === settings.model)?.defaultReasoningEffort;
        }));
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
      const win = windows.find(win => nativeWindowAt(win.ws)?.roots?.some(root => samePath(root.root, row.workspace, !row.host) && (root.host || '') === (row.host || ''))) || windows[0];
      if (win) list.push({ ...row, id: `thread:${win.pageId || win.id}:${row.id}`, window: path.basename(row.workspace || '') || win.title, group: '', current: false });
    }
    list.unshift({ id: `new:${CODEX_BACKEND}:${encodeURIComponent(this.codexDirectory)}`, title: '＋ 新建会话', window: path.basename(this.codexDirectory), workspace: this.codexDirectory, group: '', ui: true });
    this.emit({ t: 'agents', app: 'codex', sel: this.selectionKey(), silent: m.silent === true, list });
  },
  async openAgent(m) {
    const { kind, windowId, id } = parseAgentRef(m.id);
    if (kind === 'new') return bindBackend(this, { project: { root: id }, newSession: true });
    if (windowId !== CODEX_BACKEND) return this.attach({ id: 'codex', windowId, threadId: id });
    return bindBackend(this, { threadId: id });
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
  async draft(m) {
    if ((m.draftEpoch || '') !== (this.draftEpoch || '')) return;
    const read = m.text === undefined, key = this.selectionKey();
    this.draftRevision = m.revision;
    this.draftGeneration++;
    this.draftWriting = true;
    let text;
    try {
      const id = this.threadId, source = backendDraftSource(id);
      if (read) {
        this.draftWriting = false;
        if (source) await this.adapter.syncBackendDraft.call(this);
        text = codexBackend.draft(id);
      } else {
        text = source ? await source.composerCall(`nativeSessionInfo('codex', ${JSON.stringify(id)}, 'draft', ${JSON.stringify(String(m.text))})`, { app: 'codex', threadId: id }) : String(m.text);
        codexBackend.draft(id, text);
        if (source) recordBackendNativeDraft(source, id, text);
      }
      this.lastDraft = text;
    } finally { this.draftWriting = false; }
    this.emit({ t: 'draftAck', sel: key, ok: true, text, read, draftEpoch: m.draftEpoch || '', revision: m.revision });
  },
  async stop(m) {
    if (m.sel && m.sel !== this.selectionKey()) throw new Error('会话已切换，操作未执行');
    const id = this.threadId;
    m = await this.followCodexOwner(m);
    if (!this.codexBackend) return this.handle(m);
    return codexBackend.stop(id);
  },
  async refresh() { await codexBackend.refresh(this.threadId); backendPublish(this); },
  async toolDetails(m) {
    if (m.sel !== this.selectionKey()) return;
    if (this.codexBackend && m.open) {
      const id = this.threadId, thread = codexBackend.threads.get(id) || await codexBackend.read(id);
      if (m.sel !== this.selectionKey()) return;
      const item = thread.turns.flatMap(turn => turn.items).find(item => item.id === m.i);
      if (item?.type === 'collabAgentToolCall') {
        if (!samePath(localFilePath(thread.cwd), this.codexDirectory)) throw new Error('Codex 会话项目已变化，请重新打开会话');
        await codexBackend.readChildren(thread, item);
        if (m.sel !== this.selectionKey()) return;
      }
    }
    this.expandedTools ||= new Set();
    if (m.open) this.expandedTools.add(m.i); else this.expandedTools.delete(m.i);
    if (this.codexBackend) return backendPublish(this);
    return this.pollChat(true);
  },
  scrollChat(m) {
    if (!m.history) return;
    this.codexHistoryLimit += 160;
    const chat = codexBackend.chat(this.threadId, this.codexHistoryLimit, undefined, this.expandedTools || new Set());
    this.emit({ t: 'historyPage', sel: this.selectionKey(), thread: this.threadId, requestId: m.requestId, items: chat.items, earlier: chat.earlier });
    this.emit({ t: 'historyDone', sel: this.selectionKey(), requestId: m.requestId, earlier: chat.earlier });
  },
  async openMenu(m) {
    if (['model', 'effort', 'fast'].includes(m.kind)) return readCodexModelMenu.call(this, m.kind, m.requestId);
    const sel = this.selectionKey();
    const items = m.kind === 'permission' ? ['Ask for approval', 'Approve for me', 'Full access'].map(label => ({ label, checked: label === codexBackend.chat(this.threadId).permission })) : [];
    this.emit({ t: 'menu', kind: m.kind, requestId: m.requestId, sel, items });
  },
  async pickMenu(m) {
    const id = this.threadId, directory = this.codexDirectory;
    if (['model', 'effort', 'fast'].includes(m.kind)) return pickCodexModelMenu.call(this, m.kind, m.label, m.name);
    let update;
    if (m.kind === 'codex-chat') {
      if (m.label === 'Archive') return backendRoutes.codexArchive.call(this, { id: `thread:backend:${id}` });
      return backendRoutes.codexRename.call(this, { id: `thread:backend:${id}`, name: m.name });
    }
    if (m.kind === 'permission') update = { approvalPolicy: m.label === 'Full access' ? 'never' : 'on-request', approvalsReviewer: m.label === 'Approve for me' ? (IS_WIN ? 'guardian_subagent' : 'auto_review') : 'user', sandboxPolicy: { type: m.label === 'Full access' ? 'dangerFullAccess' : 'workspaceWrite', ...(m.label === 'Full access' ? {} : { writableRoots: [directory], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }) } };
    else throw new Error('当前后台没有此设置');
    await codexBackend.withWriter(id, async thread => {
      await codexBackend.client.request('thread/settings/update', { threadId: id, ...update });
      Object.assign(thread.settings, update); codexBackend.remember(thread);
    });
    codexBackend.changed(id);
  },
  async codexRequest(m) {
    if (codexBackend.requestRows(this.threadId).some(row => row.id === m.id)) {
      if (m.field == null) await codexBackend.answer(this.threadId, m.id, m.n, m.fields);
      return;
    }
    const published = this.codexPublishedQuestions?.get(m.id);
    if (!published || published.threadId !== this.threadId) throw new Error('这条请求已处理或不属于当前会话');
    const { source, threadId } = published;
    const context = { app: 'codex', threadId, host: '', cwd: this.codexDirectory };
    const call = m.field != null ? `codexRequestField(${JSON.stringify(m.id)}, ${Number(m.field)}, ${JSON.stringify(m.value || '')})`
      : `codexRequestAction(${JSON.stringify(m.id)}, ${Number(m.n)}, ${JSON.stringify(m.fields || [])}, ${m.advance === true})`;
    const result = await source.composerCall(call, context);
    if (!result) throw new Error('原生问题操作未完成');
    await source.readConversation(context, true);
    backendPublish(this);
    return result;
  },
  async queue(m) {
    const id = this.threadId;
    if (m.action === 'read') {
      await codexBackend.readQueue(id);
      const row = codexBackend.queues.get(id)?.find(row => row.id === m.id);
      if (!row) throw new Error('排队消息已不存在');
      return row.input.filter(part => part.type === 'text').map(part => part.text).join('\n');
    }
    return codexBackend.withWriter(id, async () => {
      const row = codexBackend.queues.get(id)?.find(row => row.id === m.id);
      if (!row) throw new Error('排队消息已不存在');
      if (m.action === 'edit') await codexBackend.client.request('thread/queue/update', { threadId: id, queuedSubmissionId: m.id,
        input: [{ type: 'text', text: m.text }, ...row.input.filter(part => part.type !== 'text')] });
      else if (m.action === 'send') await codexBackend.startQueued(id, m.id);
      else await codexBackend.client.request('thread/queue/delete', { threadId: id, queuedSubmissionId: m.id });
      codexBackend.refreshQueue(id);
      return { queued: m.action !== 'send' };
    });
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
    const relative = path.relative(localFilePath(this.codexDirectory), localFilePath(file.path));
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('只能修改当前项目里的文件');
    const size = await writeTextFile(file.path, String(m.text));
    this.emit({ t: 'saved', requestId: m.requestId, path: m.path, host: '', ok: true, size });
  },
  changes(m) {
    const thread = codexBackend.threads.get(this.threadId);
    let turns = thread.turns;
    let isFileChange = item => item.type === 'fileChange';
    if (m.turnId) {
      if (m.sel !== this.selectionKey()) throw new Error('会话已切换，请使用当前会话的按钮');
      turns = turns.filter(turn => turn.id === m.turnId && turn.status === 'completed');
      isFileChange = isCompletedFileChange;
    }
    const files = turns.flatMap(turn => turn.items.filter(isFileChange)
      .flatMap(item => item.changes.map(row => ({ name: row.path, diff: row.diff }))));
    const rows = m.turnId ? Array.from(Map.groupBy(files, row => row.name),
      ([name, changes]) => ({ name, diff: changes.map(row => row.diff).filter(Boolean).join('\n') })) : files;
    this.emit({ t: 'changes', historical: true, actions: [], files: rows });
  },
  async usage(m) {
    const sel = this.selectionKey(), generation = this.sel, thread = this.threadId;
    const request = this.codexUsageRequest = {};
    const current = () => this.sel === generation && this.selectionKey() === sel && this.codexUsageRequest === request;
    const publish = metadata => { if (current()) publishCodexAccount(this, metadata); };
    const context = codexBackend.chat(thread).context;
    try {
      const source = desktopCodexSource(this.codexAccountWindowId);
      if (source) await source.connect();
      const data = source ? await adapter.readCodexUsage(source.cdp, publish) : await codexUsageData(
        () => codexBackend.account(), () => codexBackend.client.request('account/rateLimits/read', {}), publish);
      if (current()) this.emit({ t: 'usage', sel, automatic: m.automatic, context, ...data });
    } catch (error) {
      if (current()) this.emit({ t: 'usage', sel, automatic: m.automatic, context, error: '额度接口请求失败', detail: error.message });
    }
  },
  async codexPlan() {
    return codexBackend.withWriter(this.threadId, async thread => {
      const settings = thread.settings;
      const collaborationMode = { mode: settings.collaborationMode?.mode === 'plan' ? 'default' : 'plan',
        settings: { model: settings.model || thread.model, reasoning_effort: settings.effort ?? settings.reasoningEffort ?? null } };
      await codexBackend.client.request('thread/settings/update', { threadId: this.threadId, collaborationMode });
      settings.collaborationMode = collaborationMode;
      codexBackend.remember(thread);
      codexBackend.changed(this.threadId);
    });
  },
  async codexSkills() { this.emit({ t: 'codexSkills', rows: await backendSkills(this) }); },
  async mentionQuery(m) {
    let rows;
    if (m.trigger === '/') rows = [...backendCommands(), ...await backendSkills(this)].filter(row => (row.label + ' ' + row.sub).toLowerCase().includes(String(m.q || '').toLowerCase()));
    else {
      const { files } = await codexBackend.client.request('fuzzyFileSearch', { query: String(m.q || ''), roots: [this.codexDirectory] });
      rows = files.map(file => ({ label: file.file_name, sub: file.path, key: localFilePath(path.resolve(localFilePath(file.root), localFilePath(file.path))), section: 'files' }));
    }
    this.emit({ t: 'mentions', sel: this.selectionKey(), seq: m.seq, q: m.q, trigger: m.trigger, rows });
  },
  async codexPick(m) {
    const command = backendCommands().find(row => row.key === m.key && m.section === 'commands');
    if (!command) throw new Error('当前后台没有这条命令');
    if (command.key === 'compact') {
      await codexBackend.compact(this.threadId);
      this.emit({ t: 'status', ok: true, msg: '已请求压缩当前会话上下文' });
    } else if (command.key === 'plan') await backendRoutes.codexPlan.call(this);
    else if (command.key === 'skills') await backendRoutes.codexSkills.call(this);
    else await backendRoutes.openMenu.call(this, { kind: command.key === 'permissions' ? 'permission' : 'model' });
  },
  codexGoal(m) { return this.codexGoal(m); },
  codexChat() { this.emit({ t: 'menu', kind: 'codex-chat', items: [{ label: 'Rename' }, { label: 'Archive' }] }); },
  sessionActions(m) { this.emit({ t: 'sessionActions', app: 'codex', id: m.id, requestId: m.requestId, actions: ['rename', 'archive'] }); },
  async sessionBatch(m) {
    await this.batchSessions(m.ids, m.requestId, async row => {
      const { windowId, id } = parseAgentRef(row.id);
      if (windowId === CODEX_BACKEND) {
        const thread = await codexBackend.read(id);
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
    const id = parseAgentRef(m.id).id;
    const title = await adapter.manageBackendThread(id, 'rename', m.name);
    publishSessionChange('codex', id, { action: 'rename', title });
    return backendRoutes.agents.call(this, {});
  },
  async codexArchive(m) {
    const id = parseAgentRef(m.id).id;
    await adapter.manageBackendThread(id, 'archive');
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
  backendQuestionState,
  backendRoutes,
  readModelMenu: readCodexModelMenu,
  readCodexUsage(cdp, publish) {
    return codexUsageData(() => cdp.evaluate(helpersCall('refreshCodexUsage(false)'), { timeout: 5000 }),
      () => cdp.evaluate(helpersCall('refreshCodexUsage()'), { timeout: 30000 }), publish);
  },
  async accountForDesktop(cdp) {
    return codexAccountMetadata(await cdp.evaluate(helpersCall('refreshCodexUsage(false, true)'), { timeout: 8500 }));
  },
  pickModelSetting: pickCodexModelMenu,
  routes: { toolDetails: backendRoutes.toolDetails },
  async backendOwner(id, waitForRelease = true, preferred = '') {
    if (waitForRelease) await codexBackend.releasing.get(id)?.promise;
    if (codexBackend.hasWriter(id)) return null;
    const pages = await codexWindows(CODEX_CDP_URL);
    const results = await Promise.allSettled(pages.filter(page => page.chatWs).map(async page => {
      const cdp = new Cdp(page.chatWs);
      try {
        await cdp.connect();
        const owner = await cdp.evaluate(helpersCall(`nativeSessionInfo('codex', ${JSON.stringify(id)}, 'connection')`));
        return owner ? { ...page, ...owner } : null;
      } finally { cdp.close(); }
    }));
    const matches = results.flatMap(row => row.status === 'fulfilled' && row.value ? [row.value] : []);
    return matches.find(row => row.pageId === preferred && row.role === 'owner') || matches.find(row => row.role === 'owner')
      || matches.find(row => row.pageId === preferred) || matches[0] || null;
  },
  async manageBackendThread(id, action, name) {
    const owner = await adapter.backendOwner(id, action !== 'rename');
    if (!owner) return codexBackend.manage(id, action, name);
    const cdp = new Cdp(owner.chatWs);
    try {
      await cdp.connect();
      const context = { app: 'codex', threadId: id, host: '', cwd: owner.cwd };
      if (!['rename', 'archive'].includes(action)) throw new Error('不支持的 Codex 会话操作');
      const result = await cdp.evaluate(helpersCall(`nativeSessionAction('codex', ${JSON.stringify(id)}, ${JSON.stringify(action === 'archive' ? 'cleanup' : action)}, ${JSON.stringify(name)})`, context));
      if (!result?.confirmed) throw new Error('Codex 桌面端尚未确认会话操作');
      if (action === 'archive') {
        codexBackend.forget(id);
        codexBackend.changed(id);
      } else {
        const thread = await codexBackend.refresh(id);
        if (!thread.name) throw new Error('Codex 尚未确认会话名称');
        return thread.name;
      }
    } finally { cdp.close(); }
  },
  backendThread(id, host = nativeSessionCatalog('codex')?.rows.find(row => row.id === id)?.host || '') {
    return !host && !allFusionRuns().some(run => run.bindings.some(binding => binding.app === 'codex' && binding.threadId === id));
  },
  closeBackendSettings() { return closeBackendSettings(this); },
  attachBackend(req) { return bindBackend(this, req); },
  async setBackendMode() {
    if (!codexBackend.threads.has(this.threadId)) await awaitCdpRead(codexBackend.read(this.threadId));
    if (!this.visible) { backendPublish(this); return; }
    const stop = watchChatUpdates(this, refresh => {
      const stops = [codexBackend.subscribe(this.threadId, error => {
        if (error) this.emit({ t: 'status', ok: false, msg: error.message });
        refresh();
      })];
      for (const win of nativeTargets().filter(win => win.app === 'codex')) {
        const source = nativeWindowAt(win.ws), context = { app: 'codex', threadId: this.threadId, host: '', cwd: this.codexDirectory };
        const changed = error => {
          if (error) { this.emit({ t: 'status', ok: false, msg: error.message }); return; }
          if (codexBackend.hasWriter(context.threadId)) refresh();
          else codexBackend.read(context.threadId).then(refresh, changed);
        };
        stops.push(source.subscribe(changed, context), source.subscribe(() => {
          if (source.snapshot?.chat?.thread !== context.threadId || source.snapshot.chat.readonly) return;
          this.adapter.syncBackendDraft.call(this).catch(error => changed(error));
        }));
        source.readConversation(context).catch(() => {});
      }
      return () => { for (const stop of stops) stop(); };
    }, sent => backendPublish(this, sent));
    const draftChanged = id => { if (id === this.threadId) backendPublishDraft(this); };
    codexBackend.on('draftChanged', draftChanged);
    const threadId = this.threadId;
    this.chatUpdatesStop = () => {
      codexBackend.off('draftChanged', draftChanged); codexBackend.clearRetry(this); stop();
      codexBackend.releaseIdle(threadId).catch(error => this.emit({ t: 'status', ok: false, msg: error.message }));
    };
    if (this.codexRetrySettings) backendRoutes.codexRetry.call(this, this.codexRetrySettings);
    await this.adapter.syncBackendDraft.call(this);
    backendPublish(this);
  },
  async syncBackendDraft() {
    const id = this.threadId, sel = this.selectionKey(), generation = this.draftGeneration, source = backendDraftSource(id);
    if (!source || this.draftWriting || this.sending) return;
    const context = { app: 'codex', threadId: id };
    const composer = await source.composerCall(`nativeSessionInfo('codex', ${JSON.stringify(id)}, 'composer', 'draft')`, context);
    if (!composer || this.selectionKey() !== sel || generation !== this.draftGeneration || this.draftWriting || this.sending) return;
    const previous = codexBackend.nativeDrafts.get(id), first = !previous?.has(source);
    let text = composer.prompt;
    const phoneOwns = first ? (codexBackend.draftTimes.get(id) || 0) > composer.draftEditedAt : previous.get(source) === text;
    if (phoneOwns && codexBackend.drafts.has(id) && codexBackend.draft(id) !== text) {
      text = await source.composerCall(`nativeSessionInfo('codex', ${JSON.stringify(id)}, 'draft', ${JSON.stringify({ text: codexBackend.draft(id), expected: text })})`, context);
      if (this.selectionKey() !== sel || generation !== this.draftGeneration || this.draftWriting || this.sending) return;
    }
    if (first || previous.get(source) !== text) codexBackend.draft(id, text);
    recordBackendNativeDraft(source, id, text);
  },
  async sendBackendMessage(text, submit, when, mentions, receipt) {
    if (!submit) return backendRoutes.draft.call(this, { text, draftEpoch: receipt?.draftEpoch });
    if (receipt) this.draftEpoch = receipt.draftEpoch || '';
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
    await ensureBackendAccount(this);
    cdpRead.getStore()?.throwIfAborted();
    if (this.selectionKey() !== sel) throw new Error('会话已切换，消息未发送');
    const operation = currentOperation();
    if (operation) operation.submitted = true;
    const result = await codexBackend.send(id, input, when, receipt.requestId);
    for (const [, file] of files) updateUpload(file, { pending: false });
    if (codexBackend.draft(id) === text) codexBackend.draft(id, '');
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
      projects.set(projectKey(row.workspace, row.host), { root: !row.host ? localFilePath(row.workspace) : row.workspace, host: row.host });
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
    if (this.threadId) {
      const context = await this.cdp.evaluate(helpersCall(`nativeSessionInfo('codex', ${JSON.stringify(this.threadId)}, 'context')`));
      return [{ root: context.cwd, host: context.host }, ...context.roots.filter(root => !samePath(root.root, context.cwd, !root.host) || root.host !== context.host)]
        .filter(root => !root.host).map(root => ({ ...root, root: localFilePath(root.root) }));
    }
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
    const result = await this.cdp.evaluate(helpersCall(`codexQueueAction(${JSON.stringify(String(id))}, "update", ${JSON.stringify(this.threadId)}, ${JSON.stringify(text)})`));
    if (!result) throw new Error('Codex 排队消息已不属于当前会话');
    await this.pollChat(true);
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
    const context = await this.cdp.evaluate(helpersCall(`nativeSessionInfo('codex', ${JSON.stringify(this.threadId)}, 'context')`));
    return { root: context.cwd, host: context.host || '' };
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

  async showSettings(requestId = 0) {
    return this.showCodexSettings('', requestId);
  },
};

export const methods = {
async codexGoal(message) {
  const { action, requestId, sel, objective } = message, id = this.threadId;
  if (sel !== this.selectionKey()) return;
  const generation = this.sel;
  const report = result => { if (generation === this.sel && sel === this.selectionKey()) this.emit({ t: 'codexGoal', requestId, sel, action, ...result }); };
  try {
    if (!id) throw new Error('请先打开或新建一个 Codex 会话');
    if (!['read', 'set', 'pause', 'resume', 'clear'].includes(action)) throw new Error('未知的 Goal 操作');
    if (action === 'set' && (typeof objective !== 'string' || !objective.trim() || objective.trim().length > 4000))
      throw new Error('请输入 1–4000 字的目标');
    const goal = await codexGoalRequest(this, id, action, message);
    if (goal && goal.threadId !== id) throw new Error('Codex 返回了其他会话的目标');
    report({ goal: goal || null, version: goalVersion(goal) });
  } catch (error) { report({ error: error.message }); }
},

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
    if (await read('codexNeedsLogin()')) throw new Error('请先在电脑端登录此窗口的 Codex，再打开所选会话');
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
    const roots = await this.currentRoots();
    if (this.codexOwnerRoot) this.codexOwnerRoot = roots[0]?.root || '';
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
    const { windowId: pageId, id: requestedRoot } = parseAgentRef(id);
    const page = (await codexWindows(CODEX_CDP_URL)).find(p => p.pageId === pageId);
    const root = requestedRoot || windowRoots(page?.rawTitle || '', 'codex')[0]?.root;
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
      return { page, active: state?.thread === threadId, inWorkspace: !!row && (!row.workspace || state?.roots?.some(root => samePath(root, row.workspace, !row.host))) };
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

async readCodexAccount() {
  const cdp = this.cdp, sel = this.sel;
  return adapter.readCodexUsage(cdp, metadata => { if (this.liveRead(cdp, sel)) publishCodexAccount(this, metadata); });
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
  if (out && this.mentionSeq === seq) {
    const rows = this.mentionPayload(out);
    if (trigger === '/' && 'goal'.startsWith(String(q || '').toLowerCase())) {
      const index = rows.findIndex(row => row.section === 'commands' && (row.key === 'goal' || /^goal$/i.test(row.label)));
      if (index < 0) rows.unshift(goalCommand);
      else rows[index] = goalCommand;
    }
    this.emit({ t: 'mentions', sel: this.selectionKey(), seq, q, trigger, rows });
  }
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
  await this.codexPick({ section: 'commands', key: 'plan-mode', label: 'Plan mode', q: '', text: await this.codexPrompt(), start: 0, caret: 0 });
  const after = (await this.cdp.evaluate(helpersCall('codexFacts()')))?.view?.plan;
  if (after === before) throw new Error('Plan 模式没有跟着电脑变化');
  this.emit({ t: 'status', ok: true, msg: after ? '已打开 Plan' : '已关闭 Plan' });
},

async codexToggleIde() {
  const before = (await this.cdp.evaluate(helpersCall('codexFacts()')))?.view?.ide?.on;
  await this.codexPick({ section: 'commands', label: 'IDE context', q: 'ide', text: await this.codexPrompt(), start: 0, caret: 0 });
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
      await this.currentRoots();
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
