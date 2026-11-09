import path from 'node:path';
import { OpenCodeClient, readEvents } from './client.mjs';
import { cdpRead } from '../cdp.mjs';
import { withOperation } from '../operations.mjs';
import { readState, saveState } from '../../lib/auth.mjs';

export class OpenCodeState {
  constructor(client = new OpenCodeClient(), automaticSessions = [], saveApprovals = () => {}) {
    this.client = client;
    this.saveApprovals = saveApprovals;
    this.sessions = new Map();
    this.messages = new Map();
    this.statuses = new Map();
    this.permissions = new Map();
    this.automaticSessions = new Set(automaticSessions);
    this.autoReplies = new Map();
    this.approvalErrors = new Map();
    this.questions = new Map();
    this.models = new Map();
    this.selections = new Map();
    this.listeners = new Set();
    this.revision = 0;
    this.connected = false;
    this.error = '';
  }

  changed(id = '') { for (const listener of this.listeners) listener(id); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async connect() {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = cdpRead.run(null, () => withOperation(null, () => this.initialize()))
      .finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async initialize() {
    this.controller?.abort();
    await this.client.request('/global/health');
    const controller = this.controller = new AbortController();
    const response = await this.client.request('/global/event', { signal: controller.signal, response: true });
    const pending = [];
    let loading = true, streamError;
    this.stream = (async () => {
      for await (const event of readEvents(response)) {
        if (loading) pending.push(event);
        else this.apply(event.payload);
      }
      if (!controller.signal.aborted) throw new Error('OpenCode 事件连接已关闭');
    })().catch(error => {
      if (this.controller !== controller || controller.signal.aborted) return;
      streamError = error;
      this.connected = false;
      this.error = error.message;
      this.changed();
    });
    try {
      const [sessions, catalog, config] = await Promise.all([
        this.client.sessions(), this.client.request('/config/providers'), this.client.request('/config'),
      ]);
      this.sessions = new Map(sessions.filter(row => !row.parentID && !row.time.archived).map(row => [row.id, row]));
      this.models.clear();
      for (const provider of catalog.providers)
        for (const model of Object.values(provider.models)) this.models.set(`${provider.id}/${model.id}`, {
          ...model, providerID: provider.id, label: `${provider.name} / ${model.name}`,
        });
      this.defaultModel = config.model;
      this.statuses.clear(); this.permissions.clear(); this.questions.clear();
      await Promise.all([...new Set(sessions.map(row => row.directory))].map(async directory => {
        const [statuses, permissions, questions] = await Promise.all([
          this.client.request('/session/status', { directory }), this.client.request('/permission', { directory }),
          this.client.request('/question', { directory }),
        ]);
        for (const [id, status] of Object.entries(statuses)) this.statuses.set(id, status);
        for (const request of permissions) this.permissions.set(request.id, request);
        for (const request of questions) this.questions.set(request.id, request);
      }));
      loading = false;
      for (const event of pending) this.apply(event.payload);
      if (streamError) throw streamError;
      if (controller.signal.aborted) return;
      this.connected = true;
      this.error = '';
      for (const request of this.permissions.values()) this.approveAutomatically(request.id);
      this.changed();
    } catch (error) {
      controller.abort();
      throw error;
    }
  }

  close() { this.connected = false; this.controller?.abort(); }

  approvalMode(id) { return this.automaticSessions.has(id) ? '自动审批' : '手动审批'; }

  setAutomatic(id, enabled) {
    const automatic = new Set(this.automaticSessions);
    if (enabled) automatic.add(id);
    else automatic.delete(id);
    this.saveApprovals([...automatic]);
    this.automaticSessions = automatic;
    this.changed(id);
    if (enabled) for (const request of this.permissions.values())
      if (request.sessionID === id) this.approveAutomatically(request.id);
  }

  forgetAutomatic(id) {
    if (this.automaticSessions.delete(id)) this.saveApprovals([...this.automaticSessions]);
  }

  approveAutomatically(id) {
    const request = this.permissions.get(id);
    if (!request || !this.automaticSessions.has(request.sessionID) || this.autoReplies.has(id)) return;
    const reply = this.client.request(`/permission/${id}/reply`, {
      directory: this.sessions.get(request.sessionID).directory, method: 'POST', body: { reply: 'once' },
    }).then(() => {
      this.permissions.delete(id);
      this.approvalErrors.delete(id);
    }).catch(error => {
      if (this.permissions.has(id)) this.approvalErrors.set(id, '自动审批失败：' + error.message);
    }).finally(() => {
      this.autoReplies.delete(id);
      this.changed(request.sessionID);
    });
    this.autoReplies.set(id, reply);
  }

  async discover(report) {
    try {
      await this.client.request('/global/health');
      report?.push({ app: 'opencode', windows: 1, address: this.client.url });
      return [{ id: 'opencode', app: 'opencode', title: 'OpenCode', kind: 'local' }];
    } catch (error) {
      report?.push({ app: 'opencode', windows: 0, address: this.client.url, error: error.message });
      return [];
    }
  }

  apply(event) {
    const p = event.properties || {};
    const id = p.sessionID || p.info?.sessionID || p.info?.id || p.part?.sessionID || '';
    this.revision++;
    switch (event.type) {
      case 'session.created': case 'session.updated':
        if (!p.info.parentID && !p.info.time.archived) this.sessions.set(p.info.id, p.info);
        else { this.sessions.delete(p.info.id); this.forgetAutomatic(p.info.id); }
        break;
      case 'session.deleted':
        this.sessions.delete(p.info.id); this.messages.delete(p.info.id); this.selections.delete(p.info.id);
        this.forgetAutomatic(p.info.id);
        break;
      case 'session.status': this.statuses.set(p.sessionID, p.status); break;
      case 'session.idle': this.statuses.set(p.sessionID, { type: 'idle' }); break;
      case 'message.updated': {
        const message = this.message(p.info.sessionID, p.info.id);
        Object.assign(message, { info: p.info, revision: this.revision });
        break;
      }
      case 'message.part.updated': {
        const message = this.message(p.part.sessionID, p.part.messageID);
        message.parts.set(p.part.id, { ...p.part, revision: this.revision });
        break;
      }
      case 'message.part.delta': {
        const part = this.message(p.sessionID, p.messageID).parts.get(p.partID);
        if (part) { part[p.field] = (part[p.field] || '') + p.delta; part.revision = this.revision; }
        break;
      }
      case 'message.removed': this.messages.get(p.sessionID)?.delete(p.messageID); break;
      case 'message.part.removed': this.messages.get(p.sessionID)?.get(p.messageID)?.parts.delete(p.partID); break;
      case 'permission.asked': this.permissions.set(p.id, p); this.approveAutomatically(p.id); break;
      case 'permission.replied': this.permissions.delete(p.requestID); this.approvalErrors.delete(p.requestID); break;
      case 'question.asked': this.questions.set(p.id, p); break;
      case 'question.replied': case 'question.rejected': this.questions.delete(p.requestID); break;
      case 'session.error':
        this.statuses.set(p.sessionID, { type: 'idle', error: p.error?.data?.message || p.error?.name || 'OpenCode 执行失败' });
        break;
      default: return;
    }
    this.changed(id);
  }

  message(sessionID, messageID) {
    if (!this.messages.has(sessionID)) this.messages.set(sessionID, new Map());
    const messages = this.messages.get(sessionID);
    if (!messages.has(messageID)) messages.set(messageID, { info: { id: messageID, sessionID }, parts: new Map(), revision: 0 });
    return messages.get(messageID);
  }

  async loadMessages(id, before, signal = cdpRead.getStore()) {
    const revision = this.revision;
    const page = await this.client.messages(id, this.sessions.get(id).directory, before, signal);
    for (const row of page.rows) {
      const message = this.message(id, row.info.id);
      if (message.revision <= revision) message.info = row.info;
      for (const part of row.parts)
        if ((message.parts.get(part.id)?.revision || 0) <= revision) message.parts.set(part.id, { ...part, revision });
    }
    return page;
  }

  selection(id) {
    const session = this.sessions.get(id);
    const native = session?.model;
    return this.selections.get(id) || { key: native ? `${native.providerID}/${native.id}` : this.defaultModel,
      variant: native?.variant && native.variant !== 'default' ? native.variant : '' };
  }

  context(id) {
    const calls = [...this.messages.get(id)?.values() || []].map(row => row.info)
      .filter(info => info.role === 'assistant' && info.time?.completed && info.tokens)
      .sort((a, b) => b.time.created - a.time.created || b.id.localeCompare(a.id));
    let call, used = null;
    for (const info of calls) {
      const t = info.tokens;
      const count = t.input + t.output + t.reasoning + t.cache.read + t.cache.write;
      if (count > 0) { call = info; used = count; break; }
    }
    const key = call ? `${call.providerID}/${call.modelID}` : this.selection(id).key;
    const model = this.models.get(key), limit = model?.limit?.context || null;
    return { source: 'opencode', basis: 'used', used, limit, model: model?.name || key || '',
      pct: used != null && limit ? Math.round(used / limit * 1000) / 10 : null,
      updated: call?.time.completed || null };
  }

  chat(id) {
    const session = this.sessions.get(id), items = [];
    const messages = [...this.messages.get(id)?.values() || []].sort((a, b) => (a.info.time?.created || 0) - (b.info.time?.created || 0) || a.info.id.localeCompare(b.info.id));
    for (const { info, parts } of messages) {
      const start = items.length;
      if (info.role === 'user') {
        items.push({ i: info.id, k: 'human', t: [...parts.values()].filter(p => p.type === 'text' && !p.synthetic).map(p => p.text).join('\n'), sentAt: info.time.created, order: info.time.created });
        continue;
      }
      for (const part of parts.values()) {
        if (part.type === 'text') items.push({ i: part.id, k: 'assistant', t: part.text || '' });
        if (part.type === 'reasoning') items.push({ i: part.id, k: 'thinking', t: '思考\n' + (part.text || ''), live: !info.time?.completed });
        if (part.type === 'tool') items.push(toolItem(part));
      }
      if (info.error) items.push({ i: info.id + ':error', k: 'notice', t: info.error.data?.message || info.error.name });
      for (let i = start; i < items.length; i++) items[i].order = info.time?.created || 0;
    }
    const permissions = [...this.permissions.values()].filter(p => p.sessionID === id);
    const questions = [...this.questions.values()].filter(p => p.sessionID === id);
    for (const p of permissions) items.push({ i: 'permission:' + p.id, k: 'tool', src: 'opencode', kind: 'command',
      t: '请求批准：' + p.permission, cmd: p.patterns.join('\n'), output: [this.approvalErrors.get(p.id), p.metadata.diff].filter(Boolean).join('\n'),
      b: ['允许一次', '拒绝'], actions: ['once', 'reject'], keep: true });
    for (const q of questions) items.push({ i: 'question:' + q.id, k: 'opencodeQuestion', requestID: q.id, questions: q.questions, keep: true });
    const selected = this.selection(id), model = this.models.get(selected.key), status = this.statuses.get(id);
    if (status?.error) items.push({ i: id + ':status', k: 'notice', t: status.error });
    return { thread: id, title: session?.title || '', items, busy: !!status && status.type !== 'idle',
      model: model?.name || selected.key || '', effort: selected.variant || '默认（服务端）',
      permission: this.approvalMode(id), context: this.context(id),
      global: [], questions: null, queued: [], subagents: [], changed: session?.summary?.files || 0,
      waiting: questions.length ? 'question' : permissions.length ? 'approval' : '',
      waitingText: questions[0]?.questions[0]?.question || permissions[0]?.patterns.join(' · ') || '',
    };
  }

  overview() {
    const windows = new Map(), sessions = [];
    for (const session of this.sessions.values()) {
      const root = session.directory, projectId = JSON.stringify(['opencode', '', root]);
      const project = path.basename(root) || root;
      windows.set(root, { projectId, win: 'opencode', windowId: root, app: 'opencode', workspace: root, host: '', project });
      const chat = this.chat(session.id);
      const last = chat.items.findLast(row => row.k === 'assistant')?.t || '';
      sessions.push({ ...windows.get(root), threadId: session.id, title: session.title,
        busy: chat.busy, waiting: chat.waiting, waitingText: chat.waitingText, last,
        run: null, statusKnown: this.connected, startedAt: 0, tasks: null, actions: [],
        changed: chat.changed, lastUsed: session.time.updated, lastMessageAt: session.time.updated });
    }
    return { windows: [...windows.values()], sessions };
  }
}

function toolItem(part) {
  const state = part.state, input = state.input || {}, meta = state.metadata || {};
  const kind = { read: 'read', grep: 'search', glob: 'explore', list: 'explore', bash: 'command', edit: 'edit', write: 'edit', apply_patch: 'edit' }[part.tool] || 'other';
  const diff = (meta.diff || '').split('\n').filter(line => /^[ +\-]/.test(line) && !/^(---|\+\+\+)/.test(line)).map(line => [line[0], line.slice(1)]);
  const f = input.filePath || meta.filepath || '';
  return { i: part.id, k: 'tool', src: 'opencode', kind,
    t: (state.status === 'error' ? '错误：' : '') + part.tool + ' ' + (state.title || input.pattern || f),
    f, chips: f ? [f] : [], cmd: input.command || '', output: state.error || state.output || '',
    diff, add: diff.filter(row => row[0] === '+').length, del: diff.filter(row => row[0] === '-').length,
    status: state.status, done: kind !== 'edit' && ['completed', 'error'].includes(state.status), keep: state.status === 'error' };
}

const client = new OpenCodeClient();
export const openCode = new OpenCodeState(client, readState().openCodeApprovals?.[client.url] || [], sessions => {
  saveState({ openCodeApprovals: { ...readState().openCodeApprovals, [client.url]: sessions } });
});
