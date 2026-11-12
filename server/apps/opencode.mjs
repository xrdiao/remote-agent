import path from 'node:path';
import os from 'node:os';
import { openCode } from '../opencode/state.mjs';
import { cdpRead, awaitCdpRead } from '../cdp.mjs';
import { safeHomePath, projectList, createProjectFolder } from '../agent/projects.mjs';
import { rememberSelection } from '../../lib/auth.mjs';
import { resolveLocal, writeTextFile } from '../../lib/files.mjs';
import { publishSessionChange, rememberSessionMessage, removeLibrarySession } from '../../lib/session-library.mjs';
import { currentOperation, withOperation } from '../operations.mjs';
import { createMessageID } from '../opencode/client.mjs';
import { uploads, pendingUploads, uploadAttachments, removeUpload } from '../../lib/uploads.mjs';
import { openCodeAttachment } from '../opencode/attachments.mjs';
import { watchChatUpdates } from '../agent/updates.mjs';

export const capabilities = {
  model: true, effort: true, fast: false, queue: false, steer: false, queueEdit: false,
  questions: true, approvals: true, attachments: true, fileReferences: false,
  editor: true, terminal: true, settings: false, usage: false, fork: false, extraActions: false,
};

function selection(s) {
  return { id: 'opencode', app: 'opencode', windowId: s.openCodeDirectory, threadId: s.threadId,
    project: { root: s.openCodeDirectory, host: '' } };
}

function attached(s, initial = false) {
  s.emit({ t: 'attached', ...selection(s), title: 'OpenCode', appName: 'OpenCode', project: path.basename(s.openCodeDirectory),
    sel: s.selectionKey(), ready: true, initial });
}

const PAGE_SIZE = 20;
const messageKey = row => ({ created: row.info.time?.created || 0, id: row.info.id });
const beforeMessage = (row, key) => (row.info.time?.created || 0) < key.created
  || (row.info.time?.created || 0) === key.created && row.info.id.localeCompare(key.id) < 0;
function viewPage(id) {
  const rows = openCode.messageRows(id).slice(-PAGE_SIZE);
  return { start: rows.length ? messageKey(rows[0]) : null, tools: new Set() };
}
function viewRows(id, page) {
  return openCode.messageRows(id).filter(row => !page.start || !beforeMessage(row, page.start));
}
function hasEarlier(id, page) {
  return !!openCode.historyPages.get(id)?.before || !!page.start && openCode.messageRows(id).some(row => beforeMessage(row, page.start));
}

function publish(s, sent) {
  const selected = openCode.selection(s.threadId || s.openCodeDirectory);
  const page = s.openCodePages?.get(s.threadId);
  const chat = s.threadId ? openCode.chat(s.threadId, { rows: viewRows(s.threadId, page), tools: page.tools }) : { thread: '', items: [], busy: false,
    model: openCode.models.get(selected.key)?.name || selected.key,
    effort: selected.variant || '默认（服务端）', permission: '手动审批', context: openCode.context(s.openCodeDirectory),
    global: [], questions: null, queued: [], subagents: [] };
  s.emit({ t: 'chat', sel: s.selectionKey(), chat: { ...chat, windowed: true, earlier: !!page && hasEarlier(s.threadId, page), empty: !s.threadId } }, sent);
}

function confirmSend(s, requestID, pending) {
  const files = [...openCode.messages.get(pending.threadID)?.get(pending.messageID)?.parts.values() || []].filter(part => part.type === 'file');
  for (const expected of pending.attachments) {
    const index = files.findIndex(part => part.filename === expected.filename && part.mime === expected.mime);
    if (index < 0) return;
    files.splice(index, 1);
  }
  const message = openCode.messages.get(pending.threadID)?.get(pending.messageID);
  const text = [...message?.parts.values() || []].filter(part => part.type === 'text' && !part.synthetic).map(part => part.text).join('\n');
  if (text !== pending.text) return;
  const item = openCode.chat(pending.threadID, { rows: message ? [message] : [] }).items.find(row => row.i === pending.messageID && row.k === 'human');
  if (!item) return;
  pending.unsubscribe();
  s.openCodeSends.delete(requestID);
  rememberSessionMessage('opencode', pending.threadID, item.sentAt);
  if (pending.operation) pending.operation.pending = false;
  withOperation(pending.operation, () => s.emit({ t: 'sent', requestId: requestID, draft: pending.draft, sel: pending.sel, messageId: item.i, queued: false }));
}

function watch(s) {
  return watchChatUpdates(s, refresh => openCode.subscribe(id => {
    if (id && id !== s.threadId) return;
    refresh();
  }), sent => {
    if (!openCode.connected) {
      s.emit({ t: 'status', ok: false, msg: openCode.error });
      return false;
    }
    if (s.threadId && !openCode.sessions.has(s.threadId)) {
      s.threadId = s.selectedThread = '';
      s.clearViewState();
      rememberSelection(s.deviceId, selection(s));
      attached(s);
      s.stopChatUpdates();
      s.chatUpdatesStop = watch(s);
    }
    publish(s, sent);
  });
}

async function bind(s, req) {
  await awaitCdpRead(openCode.connect());
  const native = req.threadId ? openCode.sessions.get(req.threadId) : null;
  if (req.threadId && !native) throw new Error('OpenCode 会话已不存在');
  const directory = safeHomePath(req.project?.root || native?.directory || req.windowId ||
    [...openCode.sessions.values()].sort((a, b) => b.time.updated - a.time.updated)[0]?.directory || os.homedir()).real;
  if (native && native.directory !== directory) throw new Error('OpenCode 会话不属于所选项目');
  const thread = native || (!req.newSession && [...openCode.sessions.values()]
    .filter(row => row.directory === directory).sort((a, b) => b.time.updated - a.time.updated)[0]);
  if (thread) await openCode.loadMessages(thread.id);
  cdpRead.getStore()?.throwIfAborted();
  s.detach();
  s.clearViewState();
  s.app = s.targetId = 'opencode';
  s.windowId = s.openCodeDirectory = directory;
  s.threadId = s.selectedThread = thread?.id || '';
  s.bindingReady = true;
  s.selectionHome = false;
  s.winTitle = 'OpenCode';
  s.openCodePages ||= new Map();
  if (thread) s.openCodePages.set(thread.id, viewPage(thread.id));
  rememberSelection(s.deviceId, selection(s));
  attached(s, req.initial === true);
  await s.setMode(s.mode, true);
}

async function list(s, m = {}) {
  await openCode.connect();
  const rows = [...openCode.sessions.values()].sort((a, b) => b.time.updated - a.time.updated).map(row => ({
    id: row.id, title: row.title, workspace: row.directory, window: path.basename(row.directory), group: '',
    current: s.threadId === row.id, running: openCode.statuses.get(row.id)?.type === 'busy', lastUsed: row.time.updated,
  }));
  rows.unshift({ id: 'new:' + encodeURIComponent(s.openCodeDirectory), title: '＋ 新建会话',
    workspace: s.openCodeDirectory, window: path.basename(s.openCodeDirectory), group: '', ui: true });
  s.emit({ t: 'agents', app: 'opencode', sel: s.selectionKey(), silent: m.silent === true, list: rows });
}

async function ensureSession(s) {
  if (s.threadId) return;
  const model = openCode.selection(s.openCodeDirectory);
  const native = await openCode.client.request('/session', { directory: s.openCodeDirectory, method: 'POST', body: {} });
  cdpRead.getStore()?.throwIfAborted();
  openCode.sessions.set(native.id, native);
  s.threadId = s.selectedThread = native.id;
  s.openCodePages.set(native.id, viewPage(native.id));
  s.clearViewState();
  openCode.selections.set(native.id, model);
  s.stopChatUpdates();
  s.chatUpdatesStop = watch(s);
  rememberSelection(s.deviceId, selection(s));
  attached(s);
}

export async function manageOpenCodeSession(id, action, name) {
  const session = openCode.sessions.get(id), directory = session.directory;
  if (action === 'actions') return { actions: ['rename', 'archive', 'delete'] };
  if (action === 'rename') {
    const updated = await openCode.client.request(`/session/${id}`, { directory, method: 'PATCH', body: { title: name } });
    openCode.sessions.set(id, updated);
    publishSessionChange('opencode', id, { action: 'rename', title: updated.title });
  } else if (action === 'archive') {
    await openCode.client.request(`/session/${id}`, { directory, method: 'PATCH', body: { time: { archived: Date.now() } } });
    openCode.sessions.delete(id);
    publishSessionChange('opencode', id, { action: 'archive' });
  } else if (action === 'delete' || action === 'remove') {
    await openCode.client.request(`/session/${id}`, { directory, method: 'DELETE' });
    openCode.sessions.delete(id);
    removeLibrarySession('opencode', id, 'delete');
  } else throw new Error('不支持的 OpenCode 会话操作');
  openCode.changed();
  return { ok: true };
}



const routes = {
  agents(m) { return list(this, m); },
  openAgent(m) {
    return bind(this, m.id.startsWith('new:') ? { project: { root: decodeURIComponent(m.id.slice(4)) }, newSession: true } : { threadId: m.id });
  },
  newProjectChat() { return bind(this, { project: { root: this.openCodeDirectory }, newSession: true }); },
  openProject(m) { return bind(this, { project: { root: m.path }, newSession: m.newSession }); },
  newProject(m) { return bind(this, { project: { root: createProjectFolder(m.parent, m.name) }, newSession: true }); },
  projects(m) {
    const data = projectList(m.path || '');
    if (!m.path) data.recent = [...new Set([...openCode.sessions.values()].map(row => row.directory))].map(root => ({ name: path.basename(root), path: root }));
    this.emit({ t: 'projects', ...data });
  },
  async send(m) {
    if (m.submit === false) return routes.draft.call(this, m);
    cdpRead.getStore()?.throwIfAborted();
    const model = openCode.selection(this.threadId || this.openCodeDirectory), native = openCode.models.get(model.key);
    const sel = this.selectionKey();
    const files = pendingUploads(sel);
    const parts = m.text?.trim() ? [{ type: 'text', text: m.text }] : [];
    parts.push(...await Promise.all(files.map(([, file]) => openCodeAttachment(file))));
    cdpRead.getStore()?.throwIfAborted();
    await ensureSession(this);
    const messageID = createMessageID();
    this.openCodeSends ||= new Map();
    const pending = { messageID, threadID: this.threadId, text: m.text?.trim() ? m.text : '', draft: m.draft,
      attachments: parts.filter(part => part.type === 'file').map(({ filename, mime }) => ({ filename, mime })),
      sel: this.selectionKey(), operation: currentOperation() };
    if (pending.operation) pending.operation.pending = true;
    pending.unsubscribe = openCode.subscribe(id => { if (!id || id === pending.threadID) confirmSend(this, m.requestId, pending); });
    this.openCodeSends.set(m.requestId, pending);
    try {
      cdpRead.getStore()?.throwIfAborted();
      if (pending.operation) pending.operation.submitted = true;
      await openCode.client.request(`/session/${this.threadId}/prompt_async`, { directory: this.openCodeDirectory, method: 'POST', body: {
        messageID, model: { providerID: native.providerID, modelID: native.id },
        ...(model.variant ? { variant: model.variant } : {}), parts,
      } });
    } catch (error) {
      pending.unsubscribe(); this.openCodeSends.delete(m.requestId);
      if (pending.operation) pending.operation.pending = false;
      throw error;
    }
    for (const [, file] of files) file.pending = false;
    this.emit({ t: 'attachments', sel: pending.sel, list: uploadAttachments(pending.sel) });
    this.openCodeDrafts?.delete(m.sel || pending.sel);
    this.openCodeDrafts?.delete(pending.sel);
    this.draftEpoch = m.draftEpoch || this.draftEpoch;
    if (this.openCodeSends.has(m.requestId)) this.emit({ t: 'sent', requestId: m.requestId, sel: pending.sel, pending: true });
    publish(this);
  },
  async stop() {
    await openCode.client.request(`/session/${this.threadId}/abort`, { directory: this.openCodeDirectory, method: 'POST' });
  },
  async refresh() {
    await openCode.connect();
    if (this.threadId) await openCode.loadMessages(this.threadId);
    publish(this);
  },
  async scrollChat(m) {
    if (!m.history) return;
    const id = this.threadId, sel = this.selectionKey(), page = this.openCodePages.get(id);
    let rows = openCode.messageRows(id).filter(row => page.start && beforeMessage(row, page.start));
    const cursor = openCode.historyPages.get(id)?.before;
    if (!rows.length && cursor) {
      await openCode.loadMessages(id, cursor);
      if (this.threadId !== id || this.selectionKey() !== sel) return;
      rows = openCode.messageRows(id).filter(row => page.start && beforeMessage(row, page.start));
    }
    rows = rows.slice(-PAGE_SIZE);
    if (rows.length) {
      page.start = messageKey(rows[0]);
      this.emit({ t: 'historyPage', sel, requestId: m.requestId, thread: id,
        items: openCode.chat(id, { rows, tools: page.tools }).items, earlier: hasEarlier(id, page) });
    }
    this.emit({ t: 'historyDone', sel, requestId: m.requestId, earlier: hasEarlier(id, page) });
  },
  toolDetails(m) {
    if (m.sel !== this.selectionKey()) return;
    const page = this.openCodePages.get(this.threadId);
    if (m.open) page.tools.add(m.i);
    else page.tools.delete(m.i);
    publish(this);
  },
  draft(m) {
    if (m.sel !== this.selectionKey()) return;
    const read = m.text === undefined;
    this.openCodeDrafts ||= new Map();
    if (!read) { this.openCodeDrafts.set(m.sel, m.text); this.draftEpoch = m.draftEpoch; }
    this.emit({ t: 'draftAck', sel: this.selectionKey(), ok: true, text: this.openCodeDrafts.get(m.sel) || '', read,
      draftEpoch: this.draftEpoch || '', revision: m.revision });
  },
  async attachments(m) {
    const sel = m.sel || this.selectionKey();
    this.emit({ t: 'attachments', sel, list: uploadAttachments(sel) });
    return { ok: true };
  },
  async image(m) {
    const upload = uploads.get(m.uploadId);
    if (!upload) throw new Error('图片上传已失效');
    if (m.sel && upload.sel && m.sel !== upload.sel) throw new Error('上传所属会话不匹配');
    upload.pending = true;
    const sel = this.selectionKey();
    this.emit({ t: 'attachments', sel, list: uploadAttachments(sel) });
    this.emit({ t: 'imageDone', clientImageId: m.clientImageId, attachmentId: m.uploadId, ok: true });
    return { ok: true };
  },
  async removeAttachment(m) {
    const sel = m.sel || this.selectionKey();
    const f = uploads.get(m.id);
    if (f && f.pending && f.sel === sel) {
      removeUpload(m.id);
    }
    this.emit({ t: 'attachments', sel, list: uploadAttachments(sel) });
    return { ok: true };
  },
  async usage(m) {
    const id = this.threadId, sel = this.selectionKey();
    if (id && !m.automatic) await openCode.loadMessages(id);
    if (this.selectionKey() !== sel) return;
    this.emit({ t: 'usage', sel, context: openCode.context(id || this.openCodeDirectory), automatic: m.automatic });
  },
  async openMenu(m) {
    const selected = openCode.selection(this.threadId || this.openCodeDirectory), model = openCode.models.get(selected.key);
    const items = m.kind === 'model' ? [...openCode.models].map(([id, row]) => ({ id, label: row.label, checked: selected.key === id }))
      : m.kind === 'effort' ? [{ label: '默认（服务端）', checked: !selected.variant },
        ...Object.keys(model?.variants || {}).map(label => ({ label, checked: selected.variant === label }))]
      : m.kind === 'permission' ? ['手动审批', '自动审批'].map(label => ({ label, checked: openCode.approvalMode(this.threadId) === label })) : [];
    this.emit({ t: 'menu', kind: m.kind, requestId: m.requestId, sel: this.selectionKey(), items, model: model?.name });
  },
  async pickMenu(m) {
    const key = this.threadId || this.openCodeDirectory, selected = openCode.selection(key);
    if (m.kind === 'model') {
      const entry = [...openCode.models].find(([, row]) => row.label === m.label);
      if (!entry) throw new Error('OpenCode 模型已不存在');
      openCode.selections.set(key, { key: entry[0], variant: '' });
    } else if (m.kind === 'effort') {
      const model = openCode.models.get(selected.key);
      if (m.label !== '默认（服务端）' && !Object.hasOwn(model.variants, m.label)) throw new Error('OpenCode 思考强度已不存在');
      openCode.selections.set(key, { ...selected, variant: m.label === '默认（服务端）' ? '' : m.label });
    } else if (m.kind === 'permission') {
      if (!['手动审批', '自动审批'].includes(m.label)) throw new Error('未知的 OpenCode 审批模式');
      await ensureSession(this);
      const operation = currentOperation();
      if (operation) operation.sel = this.selectionKey();
      openCode.setAutomatic(this.threadId, m.label === '自动审批');
    }
    openCode.changed(this.threadId);
  },
  async click(m) {
    const id = String(m.item).slice('permission:'.length), request = openCode.permissions.get(id);
    try {
      if (m.sel !== this.selectionKey() || request?.sessionID !== this.threadId) throw new Error('审批已处理或会话已切换');
      if (!['once', 'reject'].includes(m.actionId)) throw new Error('未知的 OpenCode 审批操作');
      await openCode.client.request(`/permission/${id}/reply`, { directory: this.openCodeDirectory, method: 'POST', body: { reply: m.actionId } });
      openCode.permissions.delete(id); openCode.approvalErrors.delete(id); openCode.changed(this.threadId);
    } finally { this.emit({ t: 'clickDone', sel: m.sel, item: m.item, actionId: m.actionId }); }
  },
  async opencodeQuestion(m) {
    const request = openCode.questions.get(m.id);
    if (m.sel !== this.selectionKey() || request?.sessionID !== this.threadId) throw new Error('提问已处理或会话已切换');
    await openCode.client.request(`/question/${m.id}/${m.reject ? 'reject' : 'reply'}`, {
      directory: this.openCodeDirectory, method: 'POST', ...(m.reject ? {} : { body: { answers: m.answers } }),
    });
    openCode.questions.delete(m.id); openCode.changed(this.threadId);
  },
  sessionActions(m) { this.emit({ t: 'sessionActions', app: 'opencode', id: m.id, requestId: m.requestId, actions: ['rename', 'archive', 'delete'] }); },
  async sessionManage(m) { await manageOpenCodeSession(m.id, m.action, m.name); return list(this); },
  async sessionBatch(m) {
    const results = [];
    this.sessionBatch = { requestId: m.requestId, cancelled: false };
    try {
      for (const id of m.ids) {
        if (this.sessionBatch.cancelled) break;
        try { await manageOpenCodeSession(id, 'delete'); results.push({ id, ok: true }); }
        catch (error) { results.push({ id, ok: false, error: error.message }); }
        this.emit({ t: 'sessionBatchProgress', app: 'opencode', requestId: m.requestId, total: m.ids.length, results: [...results], done: false });
      }
      this.emit({ t: 'sessionBatchProgress', app: 'opencode', requestId: m.requestId, total: m.ids.length, results, done: true });
    } finally { this.sessionBatch = null; }
    return list(this);
  },
  file(m) {
    const context = Object.create(this);
    context.emit = this.emit.bind(this);
    context.resolveFile = ref => resolveLocal({ root: this.openCodeDirectory, host: '' }, ref);
    context.fileTheme = async () => this.dark === false ? 'light-plus' : 'dark-plus';
    return context.openFile(m.path, m.diff || '', m.changes === true, m.requestId);
  },
  async saveFile(m) {
    const file = await resolveLocal({ root: this.openCodeDirectory, host: '' }, m.path);
    const relative = path.relative(this.openCodeDirectory, file.path);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('只能修改当前项目里的文件');
    const size = await writeTextFile(file.path, m.text);
    this.emit({ t: 'saved', requestId: m.requestId, path: m.path, host: '', ok: true, size });
  },
  async changes() {
    const files = await openCode.client.request(`/session/${this.threadId}/diff`, { directory: this.openCodeDirectory });
    this.emit({ t: 'changes', historical: true, actions: [], files: files.map(row => ({ name: row.file, add: row.additions, del: row.deletions })) });
  },
};

export const adapter = {
  attach(req) { return bind(this, req); },
  routes,
  currentRoots() { return [{ root: this.openCodeDirectory, host: '' }]; },
  terminalProject() { return { root: this.openCodeDirectory, host: '' }; },
  async setMode() {
    if (this.mode !== 'chat') return;
    await awaitCdpRead(openCode.connect());
    this.chatUpdatesStop = watch(this);
    publish(this);
  },
  detach() {
    this.openCodePages?.get(this.threadId)?.tools.clear();
    this.stopChatUpdates();
  },
};
