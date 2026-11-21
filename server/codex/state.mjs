import fs from 'node:fs';
import { IS_WIN, localFilePath, samePath } from '../../lib/platform.mjs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { CodexClient } from './client.mjs';
import { DATA_DIR } from '../../lib/auth.mjs';
import { cdpRead } from '../cdp.mjs';
import { withOperation } from '../operations.mjs';
import { elicitationFields } from '../../lib/shared-rules.mjs';
import { codexFileDiff } from '../../lib/codex-diff.mjs';
import { generatedImageSource } from './images.mjs';

export const CODEX_BACKEND = 'backend';
export const codexAccountKey = value => value ? JSON.stringify([value.account?.type || '', value.userId || '',
  value.workspaceRouting?.chatgptAccountId || '']) : '';
const textInput = input => input.filter(part => part.type === 'text').map(part => part.text).join('\n');
const busyTurn = thread => thread?.turns.findLast(turn => turn.status === 'inProgress');
const mergeTurnItems = (first, second) => [...new Map([...first, ...second].map(item => [item.id, item])).values()];
const capacityFailure = turn => turn?.status === 'failed' && !turn.nativeRetrying
  && ['serverOverloaded', 'policyCapacityUnavailable'].includes(turn.error?.codexErrorInfo);
const requestKey = row => (row.method === 'item/tool/requestUserInput' ? 'async:' : 'approval:')
  + JSON.stringify([row.params.threadId, row.params.turnId, row.id]);
const threadSettings = ({ thread, sandbox, reasoningEffort, ...settings }) => ({ ...settings, sandboxPolicy: sandbox, effort: reasoningEffort });
const reasoningText = item => (item.summary?.length ? item.summary : item.content || []).join('\n');
export const isCompletedFileChange = item => item.type === 'fileChange' && item.status === 'completed' && item.changes.length > 0;
const chatTypes = new Set(['userMessage', 'todo-list', 'imageGeneration', 'imageView', 'contextCompaction',
  'commandExecution', 'fileChange', 'collabAgentToolCall', 'mcpToolCall']);

function readCatalog(file) {
  if (!file || !fs.existsSync(file)) return [];
  const json = fs.readFileSync(file, 'utf8');
  try {
    const rows = JSON.parse(json);
    if (!Array.isArray(rows) || rows.some(row => !row?.id || typeof row.cwd !== 'string'))
      throw new SyntaxError('会话目录格式无效');
    return rows;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const backup = file + '.invalid-' + randomUUID();
    fs.renameSync(file, backup);
    console.error(`[codex] 会话目录已损坏，原文件已保留在 ${backup}：${error.message}`);
    return [];
  }
}

export class CodexState extends EventEmitter {
  constructor({ client = new CodexClient(), file = path.join(DATA_DIR, 'codex-backend.json') } = {}) {
    super();
    this.client = client;
    this.file = file;
    this.records = new Map(readCatalog(file).map(row => [row.id, { ...row, cwd: localFilePath(row.cwd) }]));
    this.statistics = new Map([...this.records].map(([id, row]) => [id, row.statistics || {}]));
    this.threads = new Map();
    this.childChats = new Map();
    this.requests = new Map();
    this.queues = new Map();
    this.drafts = new Map();
    this.draftTimes = new Map();
    this.nativeDrafts = new Map();
    this.manualCompactions = new Set();
    this.loading = new Map();
    this.commands = new Map();
    this.writers = new Set();
    this.childParents = new Map();
    this.releasing = new Map();
    this.using = new Map();
    this.reading = new Map();
    this.queueReads = new Map();
    this.queueRevisions = new Map();
    this.goals = new Map();
    this.retrySettings = new Map();
    this.retryAttempts = new Map();
    this.retrying = new Map();
    client.on('notification', packet => this.notification(packet));
    client.on('request', packet => this.request(packet));
    client.on('disconnected', error => {
      this.writers.clear();
      this.childParents.clear();
      for (const release of this.releasing.values()) release.reject(error);
      this.releasing.clear();
      for (const thread of this.threads.values()) thread.disconnected = error.message;
      this.requests.clear();
      this.goals.clear();
      this.queues.clear();
      this.childChats.clear();
      this.manualCompactions.clear();
      this.retryAttempts.clear();
      for (const id of this.statistics.keys()) if (!this.owns(id)) this.statistics.delete(id);
      this.changed('', error);
    });
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.pending-' + randomUUID();
    try {
      fs.writeFileSync(temporary, JSON.stringify([...this.records.values()]), { mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  owns(id) { return this.records.has(id); }
  hasWriter(id) { return this.writers.has(id); }
  async account() {
    await this.client.connect();
    return this.client.request('account/read', { refreshToken: false });
  }
  async alignAccount(expected) {
    const key = codexAccountKey(expected);
    if (!key) return this.account();
    return this.runCommand('account', async () => {
      const current = await this.account();
      if (codexAccountKey(current) === key) return current;
      if (!expected.account) throw new Error('请先在电脑端登录 Codex');
      const workspace = expected.workspaceRouting?.chatgptAccountId;
      if (expected.account.type !== 'chatgpt' || !expected.userId || !workspace)
        throw new Error('无法确认后台与电脑窗口使用同一个 Codex 账号');
      const { sessions } = await this.client.request('accountSession/list');
      const session = sessions.find(row => row.userId === expected.userId && row.workspaces.some(item => item.accountId === workspace));
      if (!session) throw new Error('Codex 后台尚未识别电脑端选中的账号，请先在电脑端打开该会话');
      if (this.writers.size || this.using.size || this.loading.size) throw new Error('Codex 后台还有会话占用账号，结束后可同步电脑端账号');
      await this.client.request('accountSession/switch', { sessionId: session.sessionId, accountId: workspace, allowBrowserLogin: false });
      const updated = await this.account();
      if (codexAccountKey(updated) !== key) throw new Error('Codex 后台尚未确认账号切换完成');
      return updated;
    });
  }
  async runCommand(id, action) {
    const previous = this.commands.get(id) || Promise.resolve();
    const command = previous.then(action, action);
    this.commands.set(id, command);
    try { return await command; }
    finally { if (this.commands.get(id) === command) this.commands.delete(id); }
  }

  async withWriter(id, action, options) {
    await this.commands.get('account');
    this.using.set(id, (this.using.get(id) || 0) + 1);
    try { return await action(await this.load(id, options)); }
    finally {
      const remaining = this.using.get(id) - 1;
      if (remaining) this.using.set(id, remaining); else this.using.delete(id);
      this.releaseIdle(id).catch(error => this.changed(id, error));
    }
  }
  canRelease(id) {
    const parent = this.childParents.get(id);
    const thread = this.threads.get(id);
    return this.writers.has(id) && !this.using.has(id) && !busyTurn(thread) && thread?.status?.type !== 'active'
      && this.goals.get(id)?.status !== 'active'
      && !this.queueReads.has(id) && !this.queues.get(id)?.length
      && !this.manualCompactions.has(id) && !this.retrying.has(id) && ![...this.requests.values()].some(row => row.params.threadId === id)
      && !(parent && this.hasWriter(parent) && busyTurn(this.threads.get(parent)));
  }
  async releaseIdle(id) {
    if (this.releasing.has(id)) return this.releasing.get(id).promise;
    if (!this.canRelease(id)) return;
    const children = [...this.childParents].filter(([, parent]) => parent === id).map(([child]) => child);
    if (children.length) {
      await Promise.all(children.map(child => this.releaseIdle(child)));
      if (children.some(child => this.hasWriter(child))) return;
      if (this.releasing.has(id)) return this.releasing.get(id).promise;
      if (!this.canRelease(id)) return;
    }
    return this.releaseWriter(id);
  }

  async releaseWriter(id) {
    if (this.releasing.has(id)) return this.releasing.get(id).promise;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const release = { promise, resolve, reject };
    this.releasing.set(id, release);
    const timer = setTimeout(() => reject(new Error('Codex 尚未确认释放会话写入权')), 15000);
    this.client.request('thread/unsubscribe', { threadId: id }).then(async ({ status }) => {
      if (this.releasing.get(id) !== release || status === 'unsubscribed') return;
      if (status === 'notSubscribed') {
        const { data } = await this.client.request('thread/loaded/list');
        if (this.releasing.get(id) !== release) return;
        if (data.includes(id)) throw new Error('Codex 会话已取消订阅，但后台仍在加载该会话');
      } else if (status !== 'notLoaded') throw new Error('Codex 返回了未知的会话释放状态');
      this.threadClosed(id);
    }).catch(reject);
    try { await promise; }
    finally {
      clearTimeout(timer);
      if (this.releasing.get(id) === release) this.releasing.delete(id);
    }
  }
  async acquireWriter(method, params, prepare) {
    const result = await this.client.request(method, params, {
      onLateResult: ({ thread }) => {
        const id = thread?.id;
        if (id && !this.writers.has(id) && !this.loading.has(id)) {
          this.writers.add(id);
          this.releaseWriter(id).catch(error => this.changed(id, error));
        }
      },
    });
    const thread = { ...result.thread, settings: threadSettings(result), generation: this.client.generation };
    try {
      await prepare(thread);
      this.writers.add(thread.id);
      this.threads.set(thread.id, thread);
      return thread;
    } catch (error) {
      this.writers.add(thread.id);
      await this.releaseWriter(thread.id).catch(releaseError => this.changed(thread.id, releaseError));
      throw error;
    }
  }
  threadClosed(id) {
    this.childChats.delete(id);
    this.writers.delete(id);
    const release = this.releasing.get(id);
    this.releasing.delete(id);
    release?.resolve();
    const parent = this.childParents.get(id);
    this.childParents.delete(id);
    if (parent) {
      this.threads.delete(id);
      this.statistics.delete(id);
      this.queues.delete(id);
      this.releaseIdle(parent).catch(error => this.changed(parent, error));
    }
  }
  async trackChild(parent, id) {
    if (this.childParents.has(id)) return;
    this.childParents.set(id, parent);
    this.threads.set(id, { id, cwd: this.threads.get(parent).cwd, turns: [], settings: {} });
    this.writers.add(id);
    return this.withWriter(id, async () => {
      const thread = await this.refresh(id);
      if (thread.parentThreadId !== parent) throw new Error('原生子会话的父会话与创建回执不一致');
    });
  }
  draft(id, text, at = Date.now()) {
    if (text !== undefined) {
      const changed = text !== this.drafts.get(id);
      this.drafts.set(id, text);
      this.draftTimes.set(id, at);
      if (changed) cdpRead.run(null, () => withOperation(null, () => this.emit('draftChanged', id)));
    }
    return this.drafts.get(id) || '';
  }
  changed(id, error) { cdpRead.run(null, () => withOperation(null, () => this.emit('changed', id, error))); }
  subscribe(id, fn) {
    const listener = (thread, error) => { if (!thread || !id || thread === id) fn(error); };
    this.on('changed', listener);
    return () => this.off('changed', listener);
  }
  setRetry(owner, id, settings) {
    if (settings.enabled) this.retrySettings.set(owner, { ...settings, id });
    else this.clearRetry(owner);
    this.retryCapacity(id);
  }
  clearRetry(owner) { this.retrySettings.delete(owner); }
  retryCapacity(id) {
    const turn = this.threads.get(id)?.turns.at(-1);
    if (!capacityFailure(turn) || this.retrying.has(id)) return;
    const settings = [...this.retrySettings].filter(([, row]) => row.id === id);
    const limit = Math.max(0, ...settings.map(([, row]) => row.count));
    if ((this.retryAttempts.get(id) || 0) >= limit) return;
    this.retry(id, turn.id, true).then(started => {
      if (started) for (const [owner, row] of settings) if (this.retrySettings.get(owner) === row)
        row.notify({ count: this.retryAttempts.get(id), limit });
    }).catch(error => {
      for (const [owner, row] of settings) if (this.retrySettings.get(owner) === row)
        row.notify({ count: this.retryAttempts.get(id), limit, error: error.message });
    });
  }
  retry(id, turnId, automatic = false) {
    if (this.retrying.has(id)) return this.retrying.get(id);
    let started = false;
    const pending = (async () => {
      const thread = await this.load(id), turn = thread.turns.at(-1);
      if (turn?.id !== turnId || !capacityFailure(turn) || busyTurn(thread)) throw new Error('此轮已不再等待容量重试');
      if (automatic) {
        const limit = Math.max(0, ...[...this.retrySettings.values()].filter(row => row.id === id).map(row => row.count));
        if ((this.retryAttempts.get(id) || 0) >= limit) return false;
        this.retryAttempts.set(id, (this.retryAttempts.get(id) || 0) + 1);
      } else this.retryAttempts.set(id, 0);
      const result = await this.client.request('turn/start', { threadId: id, input: [],
        turnTrigger: automatic ? 'capacity_retry_automatic' : 'capacity_retry_manual' });
      if (!thread.turns.some(row => row.id === result.turn.id)) thread.turns.push(result.turn);
      started = true;
      delete thread.error;
      this.changed(id);
      return true;
    })().finally(() => {
      this.retrying.delete(id);
      if (started) this.retryCapacity(id);
      this.releaseIdle(id).catch(error => this.changed(id, error));
    });
    this.retrying.set(id, pending);
    return pending;
  }
  statisticsFor(id) {
    if (!this.statistics.has(id)) this.statistics.set(id, {});
    return this.statistics.get(id);
  }
  remember(thread) {
    if (this.childParents.has(thread.id)) return;
    thread.cwd = localFilePath(thread.cwd);
    const previous = this.records.get(thread.id);
    this.records.set(thread.id, { id: thread.id, cwd: thread.cwd, title: thread.name || thread.preview || previous?.title || '新会话',
      updatedAt: thread.updatedAt, createdAt: thread.createdAt, settings: thread.settings, statistics: this.statisticsFor(thread.id), ...(previous?.untitled ? { untitled: true } : {}) });
    this.save();
    if (previous?.title !== this.records.get(thread.id).title)
      cdpRead.run(null, () => withOperation(null, () => this.emit('catalogChanged', thread.id)));
  }

  async create(cwd, { title = '新会话', model, effort } = {}) {
    cwd = localFilePath(cwd);
    await this.client.connect();
    const thread = await this.acquireWriter('thread/start', { cwd, ...(model ? { model } : {}) }, async thread => {
      if (!samePath(path.resolve(localFilePath(thread.cwd)), path.resolve(cwd))) throw new Error('Codex 返回的会话项目与所选目录不一致');
      // Native naming commits an empty thread before it can be restored after process exit.
      await this.client.request('thread/name/set', { threadId: thread.id, name: title });
      thread.name = title;
      if (effort) {
        await this.client.request('thread/settings/update', { threadId: thread.id, effort });
        thread.settings.effort = effort;
      }
    });
    try {
      if (title === '新会话') this.records.set(thread.id, { untitled: true });
      this.remember(thread);
      this.changed(thread.id);
      return thread;
    } finally { await this.releaseIdle(thread.id); }
  }

  load(id, { deferGoalContinuation = false } = {}) {
    if (this.loading.has(id)) return this.loading.get(id);
    if (this.writers.has(id) && !this.releasing.has(id)) return Promise.resolve(this.threads.get(id));
    if (!this.loading.has(id)) this.loading.set(id, (async () => {
      await this.client.connect();
      await this.releasing.get(id)?.promise;
      let thread = this.threads.get(id);
      if (!this.writers.has(id)) {
        thread = await this.acquireWriter('thread/resume', { threadId: id, ...(deferGoalContinuation ? { deferGoalContinuation } : {}) }, thread => {
          if (thread.id !== id) throw new Error('Codex 返回的会话 ID 与所选会话不一致');
          const previous = this.records.get(id);
          if (previous && !samePath(path.resolve(localFilePath(thread.cwd)), path.resolve(localFilePath(previous.cwd)))) throw new Error('Codex 原生会话项目已变化，请重新选择项目');
        });
        this.remember(thread);
      }
      await this.readQueue(id);
      return thread;
    })().finally(() => this.loading.delete(id)));
    return this.loading.get(id);
  }

  async refresh(id, { reconcile = false } = {}) {
    await this.client.connect();
    const before = this.threads.get(id);
    const revision = before?.revision || 0;
    const status = before?.status;
    const { thread } = await this.client.request('thread/read', { threadId: id, includeTurns: true });
    thread.cwd = localFilePath(thread.cwd);
    const old = this.threads.get(id);
    if (before && !old) return thread;
    if (old && (old !== before || (old.revision || 0) !== revision)) {
      const current = new Map(old.turns.map(turn => [turn.id, turn]));
      const historical = new Set(thread.turns.map(turn => turn.id));
      thread.turns = [...thread.turns.map(turn => {
        const live = current.get(turn.id);
        if (!live) return turn;
        if (reconcile && live.status === 'inProgress' && turn.status !== 'inProgress') {
          Object.assign(live, turn, { items: mergeTurnItems(live.items, turn.items) });
        } else live.items = mergeTurnItems(turn.items, live.items);
        return live;
      }), ...old.turns.filter(turn => !historical.has(turn.id))];
      if (old.status !== status) thread.status = old.status;
    }
    const settings = { ...this.records.get(id)?.settings, ...old?.settings,
      ...(thread.model ? { model: thread.model } : {}), ...(thread.reasoningEffort ? { effort: thread.reasoningEffort } : {}) };
    const current = Object.assign(old || {}, thread, { settings, revision: (old?.revision || 0) + 1 });
    current.observedAt = Date.now();
    this.threads.set(id, current);
    delete current.disconnected;
    if (reconcile) {
      for (const [key, request] of this.requests) {
        if (request.params.threadId === id && thread.turns.some(turn => turn.id === request.params.turnId && turn.status !== 'inProgress'))
          this.requests.delete(key);
      }
    }
    this.remember(current);
    this.changed(id);
    if (reconcile) this.releaseIdle(id).catch(error => this.changed(id, error));
    return current;
  }

  read(id) {
    if (this.writers.has(id)) return Promise.resolve(this.threads.get(id));
    if (!this.reading.has(id)) this.reading.set(id, this.refresh(id).finally(() => this.reading.delete(id)));
    return this.reading.get(id);
  }

  async readModelState(id) {
    if (this.hasWriter(id)) return this.threads.get(id);
    await this.client.connect();
    const { thread } = await this.client.request('thread/read', { threadId: id, includeTurns: false });
    return { ...thread, settings: {
      ...this.records.get(id)?.settings, ...this.threads.get(id)?.settings,
      ...(thread.modelProvider ? { modelProvider: thread.modelProvider } : {}),
      ...(thread.model ? { model: thread.model } : {}),
      ...(thread.reasoningEffort ? { effort: thread.reasoningEffort } : {}),
    } };
  }

  async fork(id, turnId, defaultEffort) {
    return this.withWriter(id, async source => {
      const settings = source.settings;
      const effort = settings.effort || source.reasoningEffort || await defaultEffort?.(source);
      const thread = await this.acquireWriter('thread/fork', { threadId: id, lastTurnId: turnId, deferGoalContinuation: true,
        cwd: source.cwd, model: settings.model || source.model,
        modelProvider: settings.modelProvider || source.modelProvider, serviceTier: settings.serviceTier,
        approvalPolicy: settings.approvalPolicy, approvalsReviewer: settings.approvalsReviewer,
        sandbox: { readOnly: 'read-only', workspaceWrite: 'workspace-write', dangerFullAccess: 'danger-full-access' }[settings.sandboxPolicy?.type],
        ...(effort ? { config: { model_reasoning_effort: effort } } : {}) }, thread => {
        if (!samePath(path.resolve(localFilePath(thread.cwd)), path.resolve(localFilePath(source.cwd)))) throw new Error('Codex 分叉会话的项目与源会话不一致');
      });
      try {
        const original = this.statisticsFor(id), early = this.statisticsFor(thread.id);
        this.statistics.set(thread.id, Object.fromEntries(thread.turns.filter(turn => original[turn.id] || early[turn.id]).map(turn =>
          [turn.id, structuredClone({ ...original[turn.id], ...early[turn.id], model: original[turn.id]?.model || early[turn.id]?.model })])));
        this.remember(thread);
        this.changed(thread.id);
        return thread;
      } finally { await this.releaseIdle(thread.id); }
    });
  }

  async compact(id) {
    return this.withWriter(id, async () => {
      this.manualCompactions.add(id);
      try { await this.client.request('thread/compact/start', { threadId: id }); }
      catch (error) { this.manualCompactions.delete(id); throw error; }
    });
  }

  readQueue(id) {
    if (!this.queueReads.has(id)) this.queueReads.set(id, (async () => {
      let rows, revision;
      do {
        revision = this.queueRevisions.get(id);
        rows = [];
        let cursor;
        do {
          const result = await this.client.request('thread/queue/list', { threadId: id, cursor });
          rows.push(...result.data);
          cursor = result.nextCursor;
        } while (cursor);
      } while (revision !== this.queueRevisions.get(id));
      const removed = this.queues.get(id)?.some(row => !rows.some(current => current.id === row.id));
      this.queues.set(id, rows);
      if (removed) await this.refresh(id);
      this.changed(id);
    })().finally(() => this.queueReads.delete(id)));
    return this.queueReads.get(id);
  }

  refreshQueue(id) {
    this.readQueue(id).then(() => this.releaseIdle(id)).catch(error =>
      this.changed(id, new Error('Codex 队列列表刷新失败：' + error.message)));
  }

  notification({ method, params: p }) {
    if (method === 'thread/goal/updated' || method === 'thread/goal/cleared') {
      this.goals.set(p.threadId, p.goal || null);
      this.changed(p.threadId);
      this.releaseIdle(p.threadId).catch(error => this.changed(p.threadId, error));
      return;
    }
    if (method === 'thread/closed') {
      this.threadClosed(p.threadId);
      return;
    }
    if (method === 'thread/started' || method === 'thread/name/updated') {
      if (this.owns(p.thread?.id || p.threadId) && p.thread) this.remember(p.thread);
    }
    const id = p?.threadId || p?.thread?.id, thread = this.threads.get(id);
    // Usage can precede the thread/start, resume or fork response that registers the transcript.
    if (method === 'thread/tokenUsage/updated') {
      const rows = this.statisticsFor(id), previous = rows[p.turnId];
      rows[p.turnId] = { ...previous, usage: p.tokenUsage,
        ...(thread && !previous?.model ? { model: thread.settings.model || thread.model } : {}) };
      if (thread) {
        thread.revision = (thread.revision || 0) + 1;
        if (thread.turns.some(turn => turn.id === p.turnId && turn.status !== 'inProgress')) this.remember(thread);
        this.changed(id);
      }
      return;
    }
    if (method === 'serverRequest/resolved' && this.requests.get(p.requestId)?.params.threadId === id) this.requests.delete(p.requestId);
    if (!thread) return;
    thread.observedAt = Date.now();
    const becameIdle = method === 'thread/status/changed' && thread.status?.type === 'active' && p.status.type === 'idle';
    thread.revision = (thread.revision || 0) + 1;
    if (method === 'thread/settings/updated') thread.settings = { ...thread.settings, ...p.threadSettings };
    else if (method === 'thread/status/changed') thread.status = p.status;
    else if (method === 'thread/name/updated') { thread.name = p.threadName; this.remember(thread); }
    else if (method === 'thread/queue/changed') {
      this.queueRevisions.set(id, (this.queueRevisions.get(id) || 0) + 1);
      this.refreshQueue(id);
    } else if (method === 'turn/plan/updated') {
      const rows = this.statisticsFor(id);
      rows[p.turnId] = { ...rows[p.turnId], plan: p.plan };
      this.remember(thread);
    }
    else if (method === 'turn/started' || method === 'turn/completed') {
      const old = thread.turns.find(turn => turn.id === p.turn.id);
      if (old) {
        Object.assign(old, p.turn, { items: mergeTurnItems(old.items, p.turn.items) });
      }
      else thread.turns.push(p.turn);
      if (method === 'turn/started') {
        delete thread.error;
        const statistics = this.statisticsFor(id);
        statistics[p.turn.id] = { ...statistics[p.turn.id], model: thread.settings.model || thread.model };
      }
      if (method === 'turn/completed') {
        if (p.turn.status !== 'failed') delete thread.error;
        for (const [key, request] of this.requests) if (request.params.threadId === id && request.params.turnId === p.turn.id) this.requests.delete(key);
        thread.updatedAt = Math.floor(Date.now() / 1000);
        this.remember(thread);
        cdpRead.run(null, () => withOperation(null, () => this.emit('catalogChanged', id)));
      }
    } else if (method === 'item/started' || method === 'item/completed') {
      const turn = thread.turns.find(turn => turn.id === p.turnId);
      if (turn) {
        const previous = turn.items.find(item => item.id === p.item.id);
        const item = p.item.type === 'contextCompaction' ? { ...p.item, source: previous?.source || (this.manualCompactions.has(id) ? 'manual' : 'auto') } : p.item;
        if (previous) Object.assign(previous, item);
        else turn.items.push(item);
        if (method === 'item/completed' && item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent'
          && item.senderThreadId === id && this.hasWriter(id))
          for (const child of item.receiverThreadIds)
            this.trackChild(id, child).catch(error => this.changed(id, error));
        if (item.type === 'contextCompaction' && method === 'item/completed') this.manualCompactions.delete(id);
      }
    } else if (method.startsWith('item/') && method.endsWith('Delta') || method === 'item/agentMessage/delta' || method === 'item/plan/delta') {
      const item = thread.turns.find(turn => turn.id === p.turnId)?.items.find(item => item.id === p.itemId);
      if (item) {
        if (method.includes('reasoning/')) {
          const key = method.includes('summary') ? 'summary' : 'content', index = p.summaryIndex ?? p.contentIndex ?? 0;
          item[key] ||= [];
          item[key][index] = (item[key][index] || '') + p.delta;
        } else if (method.includes('outputDelta')) item.aggregatedOutput = (item.aggregatedOutput || '') + p.delta;
        else item.text = (item.text || '') + p.delta;
      }
    } else if (method === 'error') {
      thread.error = p.error.message;
      const turn = thread.turns.find(turn => turn.id === p.turnId);
      if (turn) { turn.error = p.error; turn.nativeRetrying = p.willRetry; }
    }
    this.changed(id);
    if (method === 'turn/completed') this.retryCapacity(id);
    if (becameIdle && busyTurn(thread))
      this.refresh(id, { reconcile: true }).catch(error => this.changed(id, error));
    else if (method === 'turn/completed' || method === 'serverRequest/resolved' || method === 'thread/status/changed')
      this.releaseIdle(id).catch(error => this.changed(id, error));
  }

  request(packet) {
    if (packet.method === 'currentTime/read') return this.client.reply(packet.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'item/permissions/requestApproval', 'mcpServer/elicitation/request'].includes(packet.method))
      return this.client.reject(packet.id, `Remote Agent 没有注册 ${packet.method}`);
    this.requests.set(packet.id, packet);
    this.changed(packet.params.threadId);
  }

  requestRows(id) {
    return [...this.requests.values()].filter(row => row.params.threadId === id).map(row => {
      const p = row.params;
      if (row.method === 'item/tool/requestUserInput') {
        const options = p.questions.length === 1 ? p.questions[0].options || [] : [];
        return { id: requestKey(row), text: p.questions.map(q => q.question).join('\n'),
          buttons: [...options.map(option => ({ label: option.label })), { label: 'Skip' }, { label: 'Send' }],
          fields: p.questions.map(q => ({ label: q.question, value: '', type: q.isSecret ? 'password' : 'text',
            options: !q.isOther && q.options?.length ? q.options.map(o => ({ value: o.label, label: o.label })) : null })) };
      }
      const permission = row.method === 'item/permissions/requestApproval';
      const elicitation = row.method === 'mcpServer/elicitation/request';
      return { id: requestKey(row), text: [p.command, p.reason, p.message, p.cwd, permission ? JSON.stringify(p.permissions) : ''].filter(Boolean).join('\n'),
        buttons: (elicitation ? ['accept', 'decline', 'cancel'] : permission ? ['accept', 'decline'] : p.availableDecisions || ['accept', 'acceptForSession', 'decline', 'cancel'])
          .map(decision => ({ label: typeof decision === 'string' ? decision : Object.keys(decision)[0] })),
        fields: elicitation ? elicitationFields(p.requestedSchema) : [], submitOnly: elicitation };
    });
  }

  async answer(id, requestId, n, fields = [], expectedTurnId) {
    const request = [...this.requests.values()].find(row => requestKey(row) === requestId && row.params.threadId === id
      && (expectedTurnId === undefined || row.params.turnId === expectedTurnId));
    if (!request) throw new Error('这条请求已处理或不属于当前会话');
    const p = request.params;
    let result;
    if (request.method === 'item/tool/requestUserInput') {
      const options = p.questions.length === 1 ? p.questions[0].options || [] : [], skip = n === options.length;
      result = { answers: Object.fromEntries(p.questions.map((q, index) => {
        const value = p.questions.length === 1 && n < options.length ? options[n].label : fields.find(f => f.n === index)?.value || '';
        if (!skip && !value.trim()) throw new Error('请完成所有问题后再发送');
        return [q.id, { answers: skip ? [] : [value] }];
      })) };
    } else if (request.method === 'item/permissions/requestApproval') result = { permissions: n === 0 ? p.permissions : {}, scope: 'turn' };
    else if (request.method === 'mcpServer/elicitation/request') {
      const action = ['accept', 'decline', 'cancel'][n];
      if (!action) throw new Error('请求选项已变化');
      result = { action, content: action === 'accept' ? elicitationFields(p.requestedSchema, fields) : null };
    } else {
      const decision = (p.availableDecisions || ['accept', 'acceptForSession', 'decline', 'cancel'])[n];
      if (decision === undefined) throw new Error('请求选项已变化');
      result = { decision };
    }
    await this.client.replyToRequest(request, result);
  }

  async stop(id, expectedTurnId) {
    const turn = busyTurn(this.threads.get(id));
    if (!turn) return;
    if (expectedTurnId !== undefined && turn.id !== expectedTurnId) throw new Error('原生已不在该任务轮次');
    if (!this.hasWriter(id) || this.releasing.has(id)) {
      await this.refresh(id);
      return;
    }
    return this.withWriter(id, async thread => {
      if (busyTurn(thread)?.id !== turn.id) return;
      try {
        await this.client.request('turn/interrupt', { threadId: id, turnId: turn.id });
      } catch (error) {
        if (error.message.toLowerCase() !== 'no active turn to interrupt') throw error;
        const current = await this.refresh(id, { reconcile: true });
        if (current.turns.some(row => row.id === turn.id && row.status === 'inProgress')) throw error;
      }
    });
  }

  async startQueued(id, queueId) {
    const thread = await this.load(id), turn = busyTurn(thread);
    const queued = this.queues.get(id)?.find(row => row.id === queueId);
    if (!queued) throw new Error('排队消息已不存在');
    if (turn) {
      let stop, timer;
      const ended = new Promise((resolve, reject) => {
        stop = this.subscribe(id, error => {
          if (error) reject(error);
          else if (turn.status !== 'inProgress') resolve();
        });
        timer = setTimeout(() => reject(new Error('Codex 尚未确认原轮次停止，请先核对队列')), 15000);
      });
      try {
        await Promise.all([this.client.request('turn/interrupt', { threadId: id, turnId: turn.id }), ended]);
      } finally { clearTimeout(timer); stop(); }
      await this.readQueue(id);
      if (!this.queues.get(id)?.some(row => row.id === queueId)) {
        if (queued.clientUserMessageId && thread.turns.some(turn => turn.items.some(item => item.type === 'userMessage' && item.clientId === queued.clientUserMessageId))) return;
        throw new Error('排队消息已被其他操作处理');
      }
    }
    await this.client.request('thread/queue/start', { threadId: id, queuedSubmissionId: queueId });
  }

  async send(id, input, when, requestId) {
    return this.withWriter(id, async thread => {
      const turn = busyTurn(thread);
      if (turn && when === 'idle') throw new Error('Codex 后台会话仍有未结束的轮次');
      this.retryAttempts.delete(id);
      const title = textInput(input).trim().split('\n')[0].slice(0, 100);
      if (this.records.get(id).untitled && title) await this.manage(id, 'rename', title);
      if (turn && when !== 'now') {
        const result = await this.client.request('thread/queue/add', { threadId: id, input, clientUserMessageId: requestId });
        const row = result.queuedSubmission;
        if (row.clientUserMessageId !== requestId || textInput(row.input) !== textInput(input) || row.input.length !== input.length) throw new Error('Codex 队列回执与发送内容不一致');
        this.refreshQueue(id);
        return { queued: true, queueId: row.id, messageId: `${id}:user-message:${row.clientUserMessageId}`, thread: id };
      }
      const result = await this.client.request(turn ? 'turn/steer' : 'turn/start', {
        threadId: id, input, clientUserMessageId: requestId, ...(turn ? { expectedTurnId: turn.id } : {}),
      });
      if (result.turn) {
        const old = thread.turns.find(row => row.id === result.turn.id);
        if (!old) thread.turns.push(result.turn);
        else old.items = mergeTurnItems(result.turn.items, old.items);
        delete thread.error;
      }
      this.changed(id);
      // Fusion tracks the first turn through native events while its transcript is materializing.
      if (when !== 'idle' && !thread.turns.some(row => row.items.some(item => item.type === 'userMessage' && item.clientId === requestId)))
        this.refresh(id).catch(error => this.changed(id, error));
      return { queued: false, thread: id, turnId: result.turn?.id || result.turnId,
        messageId: `${id}:user-message:${requestId}` };
    });
  }

  async readChat(id) {
    if (this.writers.has(id)) return this.chat(id);
    await this.client.connect();
    const { thread } = await this.client.request('thread/read', { threadId: id, includeTurns: true });
    return this.chat(id, 60, thread);
  }

  async readChildren(parent, item) {
    if (item.senderThreadId !== parent.id) throw new Error('子 Agent 工具不属于当前会话');
    const cache = this.childChats.get(parent.id) || new Map();
    this.childChats.set(parent.id, cache);
    await Promise.all([...new Set(item.receiverThreadIds || [])].map(async id => {
      cache.delete(id);
      const { thread } = await this.client.request('thread/read', { threadId: id, includeTurns: true });
      if (thread.id !== id || thread.parentThreadId !== parent.id
        || parent.projectId && thread.projectId !== parent.projectId) return;
      // Archiving/closing the parent while the read is pending must not restore its cache.
      if (this.childChats.get(parent.id) === cache) cache.set(id, this.chat(id, 60, thread));
    }));
  }

  chat(id, limit = 60, thread = this.threads.get(id), tools = null) {
    const turn = thread.disconnected ? null : busyTurn(thread), latest = thread.turns.at(-1), items = [];
    const all = thread.turns.flatMap(row => {
      const last = row.status === 'completed' && row.items.findLast(item => item.type === 'agentMessage' && item.text?.trim());
      const plan = this.statistics.get(id)?.[row.id]?.plan || [];
      return [...row.items, ...(plan.length ? [{ type: 'todo-list', id: row.id + ':tasks', plan }] : [])].map(item => ({ item, turn: row, finalReply: item === last }));
    }).filter(({ item }) => item.type === 'reasoning' ? !!reasoningText(item).trim()
      : item.type === 'agentMessage' || item.type === 'plan' ? !!item.text?.trim() : chatTypes.has(item.type));
    for (const { item, turn: owner, finalReply } of all.slice(-limit)) {
      const base = { i: item.id, order: owner.startedAt * 1000 || thread.createdAt * 1000 };
      if (item.type === 'userMessage') {
        const images = item.content.filter(part => part.type === 'image').map(part => part.url).filter(Boolean);
        items.push({ ...base, ...(item.clientId ? { i: `${id}:user-message:${item.clientId}`, nativeIds: [item.id, item.clientId] } : {}),
          k: 'human', t: textInput(item.content), sentAt: base.order, ...(images.length ? { images } : {}) });
      } else if (item.type === 'agentMessage' || item.type === 'plan') {
        const reply = { ...base, k: 'assistant', bodyFormat: 'markdown', t: item.text };
        if (finalReply) {
          reply.b = ['Copy message', 'Fork chat from here'];
          reply.btnItem = owner.id;
          reply.actions = ['copy', 'fork'];
          if (owner.items.some(isCompletedFileChange)) {
            reply.b.push('View changes');
            reply.actions.push('view-changes');
          }
        }
        items.push(reply);
      } else if (item.type === 'todo-list') {
        items.push({ ...base, k: 'tasks', total: item.plan.length,
          done: item.plan.filter(step => step.status === 'completed').length,
          items: item.plan.map(step => ({ t: step.step, status: step.status === 'completed' ? 'done' : step.status })) });
      } else if (item.type === 'reasoning') {
        const text = reasoningText(item);
        if (text) items.push({ ...base, k: 'thinking', t: '思考\n' + text, live: !thread.disconnected && owner.status === 'inProgress' });
      } else if (item.type === 'imageGeneration') {
        const image = generatedImageSource(item);
        items.push({ ...base, k: image ? 'assistant' : 'notice', t: image ? '' : item.failure ? '图片生成失败：' + item.failure.type
          : item.status === 'completed' ? '图片生成完成' : item.status === 'failed' ? '图片生成失败' : '正在生成图片',
          ...(image ? { images: [image] } : { live: item.status === 'inProgress' }) });
      } else if (item.type === 'imageView') items.push({ ...base, k: 'assistant', t: '', images: [item.path] });
      else if (item.type === 'contextCompaction') items.push({ ...base, k: 'notice', kind: 'compaction',
        t: `${owner.status === 'inProgress' ? '正在' : owner.status === 'completed' ? '已完成' : '已中断'}${item.source === 'auto' || item.source === 'automatic' ? '自动' : ''}压缩上下文`, live: owner.status === 'inProgress' });
      else if (item.type === 'commandExecution') items.push({ ...base, k: 'tool', src: 'codex', kind: 'command', t: item.command.slice(0, 240),
        ...(!tools || tools.has(item.id) ? { cmd: item.command, output: item.aggregatedOutput || '' } : {}), status: item.status, exitCode: item.exitCode });
      else if (item.type === 'fileChange') {
        const details = !tools || tools.has(item.id);
        const diff = details ? codexFileDiff(item.changes) : null;
        items.push({ ...base, k: 'tool', src: 'codex', kind: 'edit', t: item.changes.map(row => row.path).join(', ').slice(0, 240), f: item.changes[0]?.path,
          ...(details ? diff : {}), status: item.status });
      } else if (item.type === 'collabAgentToolCall') {
        const details = !tools || tools.has(item.id);
        items.push({ ...base, k: 'tool', src: 'codex', kind: 'other', t: `${item.tool} · ${item.status}`, status: item.status,
          ...(details ? { output: JSON.stringify(item.agentsStates || {}), children: (item.receiverThreadIds || []).filter(child => this.childChats.get(id)?.has(child)).map(child => ({
            id: child, title: item.agentsStates?.[child]?.nickname || child, items: this.childChats.get(id).get(child).items,
          })) } : {}) });
      } else if (item.type === 'mcpToolCall') items.push({ ...base, k: 'tool', src: 'codex', kind: 'command', t: `${item.server} · ${item.tool}`.slice(0, 240),
        ...(!tools || tools.has(item.id) ? { output: JSON.stringify(item.result || item.error || '') } : {}), status: item.status });
    }
    if (tools) for (const item of items) if (item.k === 'tool') { item.lazy = true; item.details = tools.has(item.i); }
    if (thread.disconnected) items.push({ i: id + ':disconnected', k: 'notice', t: 'Codex 后台中断，结果待核对：' + thread.disconnected });
    if (!thread.disconnected && (latest?.error || thread.error)) items.push({ i: id + ':error', k: 'notice', t: latest?.error?.message || thread.error,
      ...(capacityFailure(latest) ? { kind: 'capacity', b: ['重试'], btnItem: latest.id, actions: ['capacity-retry'] } : {}) });
    const settings = thread.settings || {}, statistics = this.statistics.get(id) || {}, current = latest && statistics[latest.id];
    const usageTurn = thread.turns.findLast(turn => statistics[turn.id]?.usage), usage = usageTurn && statistics[usageTurn.id].usage;
    const previous = thread.turns.at(-2), baseline = previous ? statistics[previous.id]?.usage?.total : {};
    const tokens = current?.usage && baseline ? Object.fromEntries(Object.entries(current.usage.total)
      .map(([key, value]) => [key, value - (baseline[key] || 0)])) : null;
    const durationMs = latest?.durationMs ?? (latest?.startedAt ? ((latest.completedAt || Date.now() / 1000) - latest.startedAt) * 1000 : null);
    const requests = this.requestRows(id);
    const task = items.findLast(item => item.k === 'tasks');
    return { thread: id, title: thread.name || this.records.get(id)?.title || thread.preview, items, busy: !!turn,
      tasks: task ? { done: task.done, total: task.total, current: task.items.find(item => item.status === 'in_progress')?.t || '' } : null,
      run: latest ? { id: latest.id, status: turn ? 'running' : ({ inProgress: 'unknown', interrupted: 'stopped', failed: 'error' }[latest.status] || latest.status),
        startedAt: latest.startedAt * 1000, completedAt: latest.completedAt * 1000 } : null,
      model: settings.model || thread.model || '', effort: settings.effort ?? settings.reasoningEffort ?? thread.reasoningEffort,
      permission: settings.approvalsReviewer === 'auto_review' || IS_WIN && settings.approvalsReviewer === 'guardian_subagent' ? 'Approve for me' : settings.sandboxPolicy?.type === 'dangerFullAccess' ? 'Full access' : 'Ask for approval',
      context: usage ? { used: usage.last.totalTokens, max: usage.modelContextWindow, pct: usage.modelContextWindow ? usage.last.totalTokens / usage.modelContextWindow * 100 : null } : null,
      queued: (this.queues.get(id) || []).map(row => ({ id: row.id, t: textInput(row.input), src: 'codex', messageId: `${id}:user-message:${row.clientUserMessageId}` })),
      questions: { codex: true, requests }, global: [], subagents: [], changed: 0,
      waiting: requests.length ? 'approval' : '', waitingText: requests[0]?.text || '',
      codex: { plan: settings.collaborationMode?.mode === 'plan', follow: 'queue', actions: true,
        ...(this.goals.has(id) ? { goal: this.goals.get(id)?.status || '' } : {}) },
      generation: latest?.startedAt ? { start: latest.startedAt * 1000, end: turn || thread.disconnected ? null : latest.completedAt * 1000 || null } : null,
      performance: latest ? { source: 'codex', runId: latest.id, busy: !!turn, model: current?.model || '',
        unit: 'tokens', counter: current?.usage?.total?.outputTokens ?? null,
        durationMs, rate: tokens && durationMs > 0 ? tokens.outputTokens / (durationMs / 1000) : null,
        tokens: tokens ? { input: tokens.inputTokens, output: tokens.outputTokens, reasoning: tokens.reasoningOutputTokens, cacheRead: tokens.cachedInputTokens, cacheWrite: tokens.cacheWriteInputTokens } : null } : null,
      windowed: true, earlier: all.length > limit,
    };
  }

  forget(id) {
    this.manualCompactions.delete(id);
    this.childChats.delete(id);
    for (const children of this.childChats.values()) children.delete(id);
    this.records.delete(id); this.threads.delete(id); this.queues.delete(id); this.goals.delete(id); this.drafts.delete(id); this.draftTimes.delete(id); this.nativeDrafts.delete(id); this.statistics.delete(id); this.save();
    this.writers.delete(id);
    this.retryAttempts.delete(id);
    for (const [key, request] of this.requests) if (request.params.threadId === id) this.requests.delete(key);
    for (const [owner, settings] of this.retrySettings) if (settings.id === id) this.retrySettings.delete(owner);
    this.emit('catalogChanged', id);
  }
  async manage(id, action, name) {
    return this.withWriter(id, async () => {
      if (action === 'rename') {
        await this.client.request('thread/name/set', { threadId: id, name });
        this.threads.get(id).name = name;
        delete this.records.get(id).untitled;
        this.remember(this.threads.get(id));
      } else if (action === 'archive') {
        await this.client.request('thread/archive', { threadId: id });
        this.forget(id);
      } else throw new Error('不支持的 Codex 会话操作');
      this.changed(id);
    });
  }
  states(threadId) {
    const ids = threadId ? (this.threads.has(threadId) ? [threadId] : []) : [...this.threads.keys()];
    return ids.filter(id => !this.childParents.has(id)).map(id => {
      const thread = this.threads.get(id), chat = this.chat(id);
      return { thread: id, title: chat.title, busy: chat.busy, waiting: chat.waiting, waitingText: chat.waitingText,
        observedAt: thread.observedAt || 0, statusKnown: !thread.disconnected && (!!chat.run || ['active', 'idle'].includes(thread.status?.type)),
        last: chat.items.findLast(item => item.k === 'assistant')?.t || '', generation: chat.generation,
        runId: chat.run?.id || '', run: chat.run, tasks: chat.tasks };
    });
  }
  close() { this.client.close(); }
}

export const codexBackend = new CodexState();
