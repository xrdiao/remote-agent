import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { CodexClient } from './client.mjs';
import { DATA_DIR } from '../../lib/auth.mjs';
import { cdpRead } from '../cdp.mjs';
import { withOperation } from '../operations.mjs';
import { elicitationFields } from '../../lib/shared-rules.mjs';

export const CODEX_BACKEND = 'backend';
const textInput = input => input.filter(part => part.type === 'text').map(part => part.text).join('\n');
const busyTurn = thread => thread.turns.findLast(turn => turn.status === 'inProgress');
const capacityFailure = turn => turn?.status === 'failed' && !turn.nativeRetrying
  && ['serverOverloaded', 'policyCapacityUnavailable'].includes(turn.error?.codexErrorInfo);
const requestKey = row => (row.method === 'item/tool/requestUserInput' ? 'async:' : 'approval:')
  + JSON.stringify([row.params.threadId, row.params.turnId, row.id]);
const threadSettings = ({ thread, sandbox, reasoningEffort, ...settings }) => ({ ...settings, sandboxPolicy: sandbox, effort: reasoningEffort });

export class CodexState extends EventEmitter {
  constructor({ client = new CodexClient(), file = path.join(DATA_DIR, 'codex-backend.json') } = {}) {
    super();
    this.client = client;
    this.file = file;
    this.records = new Map(file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).map(row => [row.id, row]) : []);
    this.statistics = new Map([...this.records].map(([id, row]) => [id, row.statistics || {}]));
    this.threads = new Map();
    this.requests = new Map();
    this.queues = new Map();
    this.loading = new Map();
    this.queueReads = new Map();
    this.queueRevisions = new Map();
    this.retrySettings = new Map();
    this.retryAttempts = new Map();
    this.retrying = new Map();
    client.on('notification', packet => this.notification(packet));
    client.on('request', packet => this.request(packet));
    client.on('disconnected', error => {
      for (const thread of this.threads.values()) thread.disconnected = error.message;
      this.requests.clear();
      this.queues.clear();
      this.retryAttempts.clear();
      for (const id of this.statistics.keys()) if (!this.owns(id)) this.statistics.delete(id);
      this.changed('', error);
    });
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify([...this.records.values()]), { mode: 0o600 });
  }
  owns(id) { return this.records.has(id); }
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
    });
    this.retrying.set(id, pending);
    return pending;
  }
  statisticsFor(id) {
    if (!this.statistics.has(id)) this.statistics.set(id, {});
    return this.statistics.get(id);
  }
  remember(thread) {
    const previous = this.records.get(thread.id);
    this.records.set(thread.id, { id: thread.id, cwd: thread.cwd, title: thread.name || thread.preview || previous?.title || '新会话',
      updatedAt: thread.updatedAt, createdAt: thread.createdAt, statistics: this.statisticsFor(thread.id), ...(previous?.untitled ? { untitled: true } : {}) });
    this.save();
  }

  async create(cwd) {
    await this.client.connect();
    const result = await this.client.request('thread/start', { cwd });
    const thread = { ...result.thread, settings: threadSettings(result), generation: this.client.generation };
    if (path.resolve(thread.cwd) !== path.resolve(cwd)) throw new Error('Codex 返回的会话项目与所选目录不一致');
    // Native naming commits an empty thread before it can be restored after process exit.
    await this.client.request('thread/name/set', { threadId: thread.id, name: '新会话' });
    thread.name = '新会话';
    this.threads.set(thread.id, thread);
    this.records.set(thread.id, { untitled: true });
    this.remember(thread);
    this.changed(thread.id);
    return thread;
  }

  load(id) {
    if (this.loading.has(id)) return this.loading.get(id);
    if (this.threads.has(id) && !this.threads.get(id).disconnected) return Promise.resolve(this.threads.get(id));
    if (!this.loading.has(id)) this.loading.set(id, (async () => {
      await this.client.connect();
      let thread = this.threads.get(id);
      if (!thread || thread.disconnected) {
        const result = await this.client.request('thread/resume', { threadId: id });
        thread = { ...result.thread, settings: threadSettings(result), generation: this.client.generation };
        if (thread.id !== id) throw new Error('Codex 返回的会话 ID 与所选会话不一致');
        const previous = this.records.get(id);
        if (previous && path.resolve(thread.cwd) !== path.resolve(previous.cwd)) throw new Error('Codex 原生会话项目已变化，请重新选择项目');
        this.threads.set(id, thread);
        this.remember(thread);
      }
      await this.readQueue(id);
      return thread;
    })().finally(() => this.loading.delete(id)));
    return this.loading.get(id);
  }

  async refresh(id) {
    await this.load(id);
    const revision = this.threads.get(id).revision || 0;
    const { thread } = await this.client.request('thread/read', { threadId: id, includeTurns: true });
    const old = this.threads.get(id);
    if ((old.revision || 0) !== revision) {
      const current = new Map(old.turns.map(turn => [turn.id, turn]));
      const historical = new Set(thread.turns.map(turn => turn.id));
      thread.turns = [...thread.turns.map(turn => current.get(turn.id) || turn), ...old.turns.filter(turn => !historical.has(turn.id))];
    }
    this.threads.set(id, { ...old, ...thread });
    this.remember(thread);
    this.changed(id);
  }

  async fork(id, turnId) {
    const source = await this.load(id);
    const result = await this.client.request('thread/fork', { threadId: id, lastTurnId: turnId, deferGoalContinuation: true });
    const thread = { ...result.thread, settings: threadSettings(result), generation: this.client.generation };
    if (path.resolve(thread.cwd) !== path.resolve(source.cwd)) throw new Error('Codex 分叉会话的项目与源会话不一致');
    const original = this.statisticsFor(id), early = this.statisticsFor(thread.id);
    this.statistics.set(thread.id, Object.fromEntries(thread.turns.filter(turn => original[turn.id] || early[turn.id]).map(turn =>
      [turn.id, structuredClone({ ...original[turn.id], ...early[turn.id], model: original[turn.id]?.model || early[turn.id]?.model })])));
    this.threads.set(thread.id, thread);
    this.remember(thread);
    this.changed(thread.id);
    return thread;
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
      this.queues.set(id, rows);
      this.changed(id);
    })().finally(() => this.queueReads.delete(id)));
    return this.queueReads.get(id);
  }

  notification({ method, params: p }) {
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
    if (!thread) return;
    thread.revision = (thread.revision || 0) + 1;
    if (method === 'thread/settings/updated') thread.settings = { ...thread.settings, ...p.threadSettings };
    else if (method === 'thread/status/changed') thread.status = p.status;
    else if (method === 'thread/name/updated') { thread.name = p.threadName; this.remember(thread); }
    else if (method === 'thread/queue/changed') {
      this.queueRevisions.set(id, (this.queueRevisions.get(id) || 0) + 1);
      this.readQueue(id).catch(error => this.changed(id, error));
    } else if (method === 'serverRequest/resolved') this.requests.delete(p.requestId);
    else if (method === 'turn/started' || method === 'turn/completed') {
      const old = thread.turns.find(turn => turn.id === p.turn.id);
      if (old) {
        const items = new Map(old.items.map(item => [item.id, item]));
        for (const item of p.turn.items) items.set(item.id, item);
        Object.assign(old, p.turn, { items: [...items.values()] });
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
      }
    } else if (method === 'item/started' || method === 'item/completed') {
      const turn = thread.turns.find(turn => turn.id === p.turnId);
      if (turn) {
        const previous = turn.items.find(item => item.id === p.item.id);
        if (previous) Object.assign(previous, p.item);
        else turn.items.push(p.item);
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
        fields: elicitation ? elicitationFields(p.requestedSchema) : [] };
    });
  }

  answer(id, requestId, n, fields = []) {
    const request = [...this.requests.values()].find(row => requestKey(row) === requestId && row.params.threadId === id);
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
    this.client.reply(request.id, result);
    this.requests.delete(request.id);
    this.changed(id);
  }

  async startQueued(id, queueId) {
    const thread = await this.load(id), turn = busyTurn(thread);
    const queued = this.queues.get(id)?.find(row => row.id === queueId);
    if (!queued) throw new Error('排队消息已不存在');
    if (turn) {
      let stop;
      const ended = new Promise((resolve, reject) => {
        stop = this.subscribe(id, error => {
          if (error) reject(error);
          else if (turn.status !== 'inProgress') resolve();
        });
      });
      try {
        await Promise.all([this.client.request('turn/interrupt', { threadId: id, turnId: turn.id }), ended]);
      } finally { stop(); }
      await this.readQueue(id);
      if (!this.queues.get(id)?.some(row => row.id === queueId)) {
        if (queued.clientUserMessageId && thread.turns.some(turn => turn.items.some(item => item.type === 'userMessage' && item.clientId === queued.clientUserMessageId))) return;
        throw new Error('排队消息已被其他操作处理');
      }
    }
    await this.client.request('thread/queue/start', { threadId: id, queuedSubmissionId: queueId });
  }

  async send(id, input, when, requestId) {
    const thread = await this.load(id), turn = busyTurn(thread);
    this.retryAttempts.delete(id);
    const title = textInput(input).trim().split('\n')[0].slice(0, 100);
    if (this.records.get(id).untitled && title) await this.manage(id, 'rename', title);
    if (turn && when !== 'now') {
      const result = await this.client.request('thread/queue/add', { threadId: id, input, clientUserMessageId: requestId });
      const row = result.queuedSubmission;
      if (row.clientUserMessageId !== requestId || textInput(row.input) !== textInput(input) || row.input.length !== input.length) throw new Error('Codex 队列回执与发送内容不一致');
      await this.readQueue(id);
      return { queued: true, queueId: row.id, messageId: `${id}:user-message:${row.clientUserMessageId}`, thread: id };
    }
    const result = await this.client.request(turn ? 'turn/steer' : 'turn/start', {
      threadId: id, input, clientUserMessageId: requestId, ...(turn ? { expectedTurnId: turn.id } : {}),
    });
    if (result.turn) {
      const old = thread.turns.find(row => row.id === result.turn.id);
      if (!old) thread.turns.push(result.turn);
      delete thread.error;
    }
    this.changed(id);
    return { queued: false, thread: id, turnId: result.turn?.id || result.turnId,
      messageId: `${id}:user-message:${requestId}` };
  }

  chat(id, limit = 40) {
    const thread = this.threads.get(id), turn = thread.disconnected ? null : busyTurn(thread), latest = thread.turns.at(-1), items = [];
    const all = thread.turns.flatMap(row => {
      const last = row.status === 'completed' && row.items.findLast(item => item.type === 'agentMessage' && item.text);
      return row.items.map(item => ({ item, turn: row, fork: item === last }));
    });
    for (const { item, turn: owner, fork } of all.slice(-limit)) {
      const base = { i: item.id, order: owner.startedAt * 1000 || thread.createdAt * 1000 };
      if (item.type === 'userMessage') {
        const images = item.content.filter(part => part.type === 'image').map(part => part.url).filter(Boolean);
        items.push({ ...base, ...(item.clientId ? { i: `${id}:user-message:${item.clientId}`, nativeIds: [item.id, item.clientId] } : {}),
          k: 'human', t: textInput(item.content), sentAt: base.order, ...(images.length ? { images } : {}) });
      } else if (item.type === 'agentMessage' || item.type === 'plan') {
        if (item.text) items.push({ ...base, k: 'assistant', bodyFormat: 'markdown', t: item.text,
          ...(fork ? { b: ['Fork chat from here'], btnItem: owner.id, actions: ['fork'] } : {}) });
      } else if (item.type === 'reasoning') {
        const text = (item.summary?.length ? item.summary : item.content || []).join('\n');
        if (text) items.push({ ...base, k: 'thinking', t: '思考\n' + text, live: !thread.disconnected && owner.status === 'inProgress' });
      } else if (item.type === 'commandExecution') items.push({ ...base, k: 'tool', src: 'codex', kind: 'command', t: item.command,
        cmd: item.command, output: item.aggregatedOutput || '', status: item.status, exitCode: item.exitCode });
      else if (item.type === 'fileChange') items.push({ ...base, k: 'tool', src: 'codex', kind: 'file', t: item.changes.map(row => row.path).join('\n'), output: item.changes.map(row => row.diff).join('\n'), status: item.status });
      else if (item.type === 'mcpToolCall') items.push({ ...base, k: 'tool', src: 'codex', kind: 'command', t: `${item.server} · ${item.tool}`, output: JSON.stringify(item.result || item.error || ''), status: item.status });
    }
    if (thread.disconnected) items.push({ i: id + ':disconnected', k: 'notice', t: 'Codex 后台中断，结果待核对：' + thread.disconnected });
    if (!thread.disconnected && (latest?.error || thread.error)) items.push({ i: id + ':error', k: 'notice', t: latest?.error?.message || thread.error,
      ...(capacityFailure(latest) ? { kind: 'capacity', b: ['重试'], btnItem: latest.id, actions: ['capacity-retry'] } : {}) });
    const settings = thread.settings, statistics = this.statisticsFor(id), current = latest && statistics[latest.id];
    const usageTurn = thread.turns.findLast(turn => statistics[turn.id]?.usage), usage = usageTurn && statistics[usageTurn.id].usage;
    const previous = thread.turns.at(-2), baseline = previous ? statistics[previous.id]?.usage?.total : {};
    const tokens = current?.usage && baseline ? Object.fromEntries(Object.entries(current.usage.total)
      .map(([key, value]) => [key, value - (baseline[key] || 0)])) : null;
    const durationMs = latest?.durationMs ?? (latest?.startedAt ? ((latest.completedAt || Date.now() / 1000) - latest.startedAt) * 1000 : null);
    const requests = this.requestRows(id);
    return { thread: id, title: thread.name || this.records.get(id).title, items, busy: !!turn,
      model: settings.model || thread.model || '', effort: settings.effort ?? settings.reasoningEffort ?? thread.reasoningEffort,
      permission: settings.approvalsReviewer === 'auto_review' ? 'Approve for me' : settings.sandboxPolicy?.type === 'dangerFullAccess' ? 'Full access' : 'Ask for approval',
      context: usage ? { used: usage.last.totalTokens, max: usage.modelContextWindow, pct: usage.modelContextWindow ? usage.last.totalTokens / usage.modelContextWindow * 100 : null } : null,
      queued: (this.queues.get(id) || []).map(row => ({ id: row.id, t: textInput(row.input), src: 'codex', messageId: `${id}:user-message:${row.clientUserMessageId}` })),
      questions: { codex: true, requests }, global: [], subagents: [], changed: 0,
      waiting: requests.length ? 'approval' : '', waitingText: requests[0]?.text || '',
      codex: { plan: settings.collaborationMode?.mode === 'plan', follow: 'queue', actions: true },
      generation: latest?.startedAt ? { start: latest.startedAt * 1000, end: turn || thread.disconnected ? null : latest.completedAt * 1000 || null } : null,
      performance: latest ? { source: 'codex', runId: latest.id, busy: !!turn, model: current?.model || '',
        unit: 'tokens', durationMs, rate: tokens && durationMs > 0 ? tokens.outputTokens / (durationMs / 1000) : null,
        tokens: tokens ? { input: tokens.inputTokens, output: tokens.outputTokens, reasoning: tokens.reasoningOutputTokens, cacheRead: tokens.cachedInputTokens, cacheWrite: tokens.cacheWriteInputTokens } : null } : null,
      windowed: true, earlier: all.length > limit,
    };
  }

  async manage(id, action, name) {
    await this.load(id);
    if (action === 'rename') {
      await this.client.request('thread/name/set', { threadId: id, name });
      this.threads.get(id).name = name;
      delete this.records.get(id).untitled;
      this.remember(this.threads.get(id));
    } else if (action === 'archive') {
      await this.client.request('thread/archive', { threadId: id });
      this.records.delete(id); this.threads.delete(id); this.queues.delete(id); this.statistics.delete(id); this.save();
      this.retryAttempts.delete(id);
    } else throw new Error('不支持的 Codex 会话操作');
    this.changed(id);
  }
  states() {
    return [...this.threads.keys()].map(id => {
      const chat = this.chat(id), turn = this.threads.get(id).turns.at(-1);
      return { thread: id, title: chat.title, busy: chat.busy, waiting: chat.waiting, waitingText: chat.waitingText,
        last: chat.items.findLast(item => item.k === 'assistant')?.t || '', generation: chat.generation,
        runId: turn?.id || '', run: turn ? { id: turn.id, status: chat.busy ? 'running' : ({ interrupted: 'stopped', failed: 'error' }[turn.status] || turn.status),
          startedAt: turn.startedAt * 1000, completedAt: turn.completedAt * 1000 } : null };
    });
  }
  close() { this.client.close(); }
}

export const codexBackend = new CodexState();
