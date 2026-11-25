import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

export function scopedNativePermissions(grant, access, scope, nativeBase) {
  if (!['read', 'write'].includes(access) || !Array.isArray(scope) || scope.length === 0)
    throw new PeerError(400, '远端任务访问权限无效');
  if (typeof nativeBase !== 'string' || !path.isAbsolute(nativeBase)
      || path.relative(nativeBase,grant.root) === '' || path.relative(nativeBase,grant.root).startsWith('..'))
    throw new PeerError(409, '未核实原生工作区权限基准目录，不能执行远程任务');
  const root = fs.realpathSync(grant.root);
  const base = fs.realpathSync(nativeBase);
  const rules = [
    ...['bash', 'external_directory', 'task', 'worktree_create', 'worktree_delete', 'execute', 'webfetch', 'websearch']
      .map(permission => ({ permission, pattern: '*', action: 'deny' })),
    ...['read', 'edit'].map(permission => ({ permission, pattern: '*', action: 'deny' })),
  ];
  const unrestricted = scope.length === 1 && scope[0] === '.';
  if (!unrestricted) rules.push(...['glob','grep','list'].map(permission => ({permission,pattern:'*',action:'deny'})));
  for (const item of scope) {
    if (typeof item !== 'string' || !item.trim() || item.length > 320 || item.startsWith('/')
        || item.includes('\\') || item.split('/').includes('..') || /[?*[\]]/.test(item))
      throw new PeerError(400, '远端任务范围包含无效路径或通配符');
    const full = path.resolve(root, item), relative = path.relative(root, full);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new PeerError(400, '远端任务范围超出授权工作区');
    let walk = root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      walk = path.join(walk,part);
      try { if (fs.lstatSync(walk).isSymbolicLink()) throw new PeerError(403, '远端范围不能包含符号链接'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const isDir = item === '.' || item.endsWith('/') || (()=>{
      try { return fs.statSync(full).isDirectory(); } catch { return false; }
    })();
    const relativeFromNative = path.relative(base, full).split(path.sep).join('/');
    const patterns = [relativeFromNative, full,
      ...(isDir ? [relativeFromNative.replace(/\/$/, '')+'/*', full+'/*'] : [])];
    for (const permission of ['read', ...(access === 'write' ? ['edit'] : [])])
      for (const pattern of [...new Set(patterns)])
        rules.push({permission,pattern,action:permission === 'edit' ? 'ask' : 'allow'});
  }
  return rules;
}

import { OPENCODE_URL } from '../config.mjs';
import { computerId } from '../../lib/auth.mjs';
import { createMessageID } from '../opencode/client.mjs';
import { PeerError, readPeerFile, writePeerFile } from './access.mjs';

const journalName = 'peer-native-requests.json';
const journal = () => readPeerFile(journalName, {});
const persist = rows => writePeerFile(journalName, rows);
const locks = new Map();
function sequential(key, fn) {
  const previous = locks.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  locks.set(key, next);
  next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => {});
  return next;
}
function jobKey(grant, id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{24,80}$/.test(id)) throw new PeerError(400, '远程任务 ID 无效');
  return grant.id + ':' + id;
}
async function api(route, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(OPENCODE_URL + route, {
      method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
  } catch { throw new PeerError(503, '目标 OpenCode 原生服务不可用'); }
  let value = null;
  const content = await response.text();
  try { value = content ? JSON.parse(content) : null; } catch {}
  if (!response.ok) throw new PeerError(502, '目标 OpenCode 原生操作未获确认：HTTP ' + response.status);
  return value;
}
const directoryQuery = root => '?directory=' + encodeURIComponent(root);
const sessionApi = (row, suffix = '') => '/session/' + encodeURIComponent(row.threadId) + suffix + directoryQuery(row.root);
function rowFor(grant, id) {
  const key = jobKey(grant, id), row = journal()[key];
  if (!row || row.grant !== grant.id || row.root !== grant.root)
    throw new PeerError(404, '远程 Agent 任务不存在或工作区已变化');
  return { key, row };
}
function save(key, row) { const rows = journal(); rows[key] = row; persist(rows); return row; }
function statusSummary(row, messages, busy) {
  const assistant = messages.filter(x => x.info?.role === 'assistant');
  const errors = assistant.map(x => x.info?.error?.data?.message).filter(Boolean);
  const last = assistant.at(-1);
  const text = (last?.parts || []).filter(x => x.type === 'text').map(x => x.text).join('\n').slice(0,32000);
  const tools = assistant.flatMap(x => (x.parts || []).filter(p => p.type === 'tool')
    .map(p => ({ tool: p.tool, state: p.state?.status || 'unknown' }))).slice(-50);
  const pending = tools.some(x => x.state === 'pending' || x.state === 'running');
  const finished = ['stop', 'end-turn', 'completed'].includes(last?.info?.finish);
  return { state: errors.length ? 'failed' : busy || pending || !finished ? 'running' : text ? 'completed' : 'running',
    text, error: errors.at(-1) || '', tools, threadId: row.threadId, jobId: row.id,
    submitted: row.submission === 'submitted' };
}
async function nativeJobState(row) {
  const directory = directoryQuery(row.root);
  const [messages, statuses, permissions, questions] = await Promise.all([
    api(sessionApi(row, '/message')), api('/session/status' + directory),
    api('/permission' + directory), api('/question' + directory),
  ]);
  if (![messages, permissions, questions].every(Array.isArray)) throw new PeerError(502, '远程 Agent 状态格式无效');
  const nativeStatus = statuses?.[row.threadId]?.type;
  const busy = !!nativeStatus && nativeStatus !== 'idle';
  const latest = messages.findLast(item => item.info?.role === 'user')?.info.id || '';
  const current = !row.messageId || latest === row.messageId;
  const turns = row.messageId ? messages.filter(item => item.info?.role === 'assistant' && item.info.parentID === row.messageId) : messages;
  const sessionRequests = [permissions, questions].map(rows => rows.filter(entry => (entry?.sessionID || entry?.sessionId) === row.threadId));
  const ownsRequest = entry => !row.previousJobId || current && turns.some(item => item.info?.id === entry.tool?.messageID);
  const pending = [...sessionRequests[0].filter(ownsRequest).map(item => ({ kind: 'permission', id: item.id,
    detail: JSON.stringify({ permission: item.permission, patterns: item.patterns }).slice(0,1800) })),
  ...sessionRequests[1].filter(ownsRequest).map(item => ({ kind: 'question', id: item.id,
    detail: JSON.stringify(item.questions || []).slice(0,1800) }))];
  const base = statusSummary(row, turns, busy);
  const status = pending.length ? { ...base, state: 'awaiting_user', waiting: pending[0] } : base;
  return { current, busy, latest, pending: sessionRequests.some(items => items.length), status };
}
export async function peerNativeAction(grant, action, args = {}) {
  if (action === 'agent-catalog') {
    const config = await api('/config' + directoryQuery(grant.root));
    return { computer: computerId(), app: 'opencode', ready: true, defaultModel: config?.model || '', root: grant.root, sessionReuse: true };
  }
  const id = args.jobId, key = jobKey(grant, id);
  const previousId = action === 'agent-open' ? args.previousJobId : undefined;
  const previousKey = previousId === undefined ? '' : jobKey(grant, previousId);
  const rows = journal(), lockOwner = rows[key] || rows[previousKey];
  return sequential(lockOwner ? jobKey(grant, lockOwner.sessionOwnerJobId || lockOwner.id) : key, async () => {
    if (action === 'agent-open') {
      const existed = journal()[key];
      if (existed) {
        if ((existed.previousJobId || '') !== (previousId || '')) throw new PeerError(409, '远程任务已绑定其他前序执行');
        return { jobId: id, state: existed.phase, threadId: existed.threadId || '' };
      }
      const intent = { grant: grant.id, root: grant.root, id, phase: 'opening', submission: 'none',
        createdAt: Date.now(), threadId: '' };
      if (previousKey) {
        const { row: previous } = rowFor(grant, previousId);
        if (previous.replacedBy || !previous.threadId || !['open', 'stopped'].includes(previous.phase) || previous.submission !== 'submitted')
          throw new PeerError(409, '前序远程执行不可续接');
        const session = await api(sessionApi(previous));
        const native = await nativeJobState(previous);
        const terminal = previous.phase === 'stopped' ? { state: 'stopped', threadId: previous.threadId } : native.status;
        if (session?.id !== previous.threadId || session.directory !== grant.root || session.time?.archived
            || !native.current || !native.latest || native.busy || native.pending || !['completed','failed','stopped'].includes(terminal.state))
          throw new PeerError(409, '前序原生会话未确认空闲并结束，不能续接');
        const latest = journal();
        if (latest[key] || latest[previousKey]?.replacedBy) throw new PeerError(409, '远程任务的会话归属已变化');
        latest[previousKey] = { ...previous, terminal, replacedBy: id };
        latest[key] = { ...intent, phase: 'open', threadId: previous.threadId, previousJobId: previousId,
          sessionOwnerJobId: previous.sessionOwnerJobId || previous.id, previousMessageId: native.latest };
        persist(latest);
        return { jobId: id, state: 'open', threadId: previous.threadId };
      }
      save(key, intent);
      try {
        const session = await api('/session?directory=' + encodeURIComponent(grant.root),
          { method: 'POST', body: { title: 'RA Fusion Remote · ' + id.slice(0, 8) } });
        if (!session?.id || session.directory !== grant.root) throw new PeerError(502, '远程原生会话目录未确认');
        save(key, { ...intent, phase: 'open', threadId: session.id });
        return { jobId: id, state: 'open', threadId: session.id };
      } catch (error) { throw error; } // Keep opening intent UNKNOWN; never silently create twice.
    }
    const { row } = rowFor(grant, id);
    if (action === 'agent-submit') {
      if (row.phase === 'closed') return { jobId: id, state: 'closed' };
      if (row.replacedBy) throw new PeerError(409, '远程执行已由后续任务接管');
      if (row.submission !== 'none') {
        if (typeof args.text === 'string' && row.promptHash
            && row.promptHash !== crypto.createHash('sha256').update(args.text).digest('hex'))
          throw new PeerError(409, '远端任务 ID 已绑定不同输入，拒绝覆盖原任务');
        return { jobId: id, state: row.submission, threadId: row.threadId, messageId: row.messageId };
      }
      if (row.phase !== 'open') return { jobId: id, state: 'unknown' };
      const prompt = args.text, model = args.model || '';
      if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 16000)
        throw new PeerError(400, '远程 Agent 输入须为 1-16000 字节 UTF-8');
      if (typeof model !== 'string' || model.length > 180 || model && !/^[a-zA-Z0-9_./-]+$/.test(model))
        throw new PeerError(400, '远程模型名称无效');
      const nativeConfig = await api('/config' + directoryQuery(grant.root));
      if (model && nativeConfig.model !== model) throw new PeerError(403, '远端模型尚未通过目标原生配置确认');
      const access = args.access || 'read', scope = args.scope || ['.'];
      const nativeProject = await api('/project/current' + directoryQuery(grant.root));
      const candidates = [nativeProject?.worktree, ...(nativeProject?.sandboxes || [])]
        .filter(v => typeof v === 'string' && path.isAbsolute(v))
        .filter(v => { const relative = path.relative(v,grant.root); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); })
        .sort((a,b)=>b.length-a.length);
      const nativeBase = candidates[0];
      if (!nativeBase) throw new PeerError(409,'原生项目根目录尚未确认，拒绝派工');
      const rules = scopedNativePermissions(grant, access, scope, nativeBase);
      if (row.previousJobId) {
        const { row: previous } = rowFor(grant, row.previousJobId);
        const native = await nativeJobState(previous);
        if (previous.replacedBy !== id || native.busy || native.pending || native.latest !== row.previousMessageId)
          throw new PeerError(409, '远程原生会话在续接前已发生变化');
      }
      await api(sessionApi(row), {
        method: 'PATCH',body:{ permission:rules },
      });
      const messageId = createMessageID();
      const payload = { messageID: messageId, parts: [{ type: 'text', text: prompt }] };
      if (model) {
        const parts = model.split('/');
        if (parts.length < 2) throw new PeerError(400, '远程模型需要 provider/model');
        payload.model = { providerID: parts[0], modelID: parts.slice(1).join('/') };
      }
      const submission = { ...row, access, scope, nativeBase, messageId, promptHash: crypto.createHash('sha256').update(prompt).digest('hex') };
      save(key, { ...submission, submission: 'submitting' });
      await api(sessionApi(row, '/prompt_async'), { method: 'POST', body: payload });
      save(key, { ...submission, submission: 'submitted', submittedAt: Date.now() });
      return { jobId: id, state: 'submitted', threadId: row.threadId, messageId };
    }
    if (action === 'agent-answer') {
      const kind = args.kind, requestId = args.requestId;
      if (!['permission', 'question'].includes(kind) || typeof requestId !== 'string'
          || !/^[a-zA-Z0-9_-]{5,120}$/.test(requestId))
        throw new PeerError(400, '远端审批身份无效');
      const choice = kind === 'permission' ? args.reply : args.answers;
      if (kind === 'permission' && !['once', 'reject'].includes(choice))
        throw new PeerError(400, '只能单次允许或拒绝；不允许持久权限授权');
      if (kind === 'question' && (!Array.isArray(choice) || !choice.length
          || choice.some(row => !Array.isArray(row) || row.some(v => typeof v !== 'string' || v.length > 256))))
        throw new PeerError(400, '远端问题答案无效');
      const approved = row.approvals || {}, approvalId = kind + ':' + requestId;
      if (approved[approvalId]) return { jobId: id, state: approved[approvalId].state, requestId };
      if (row.replacedBy || row.phase !== 'open' || row.submission !== 'submitted') throw new PeerError(409, '审批不属于当前远程执行');
      if (row.previousJobId) {
        const { status } = await nativeJobState(row);
        if (status.waiting?.id !== requestId || status.waiting.kind !== kind) throw new PeerError(409, '审批不属于当前原生轮次');
      }
      const pending = await api('/' + kind + '?directory=' + encodeURIComponent(grant.root));
      const requested = pending.find(entry => entry.id === requestId
        && (entry.sessionID === row.threadId || entry.sessionId === row.threadId));
      if (!requested) throw new PeerError(409, '远程审批请求不属于当前会话或已过期');
      if (kind === 'permission' && choice === 'once') {
        if (!['read', 'edit'].includes(requested.permission)
            || requested.permission === 'edit' && row.access !== 'write')
          throw new PeerError(403, '远程任务不允许批准此类工具');
        if (!row.nativeBase || !Array.isArray(row.scope) || !Array.isArray(requested.patterns)
            || !requested.patterns.length)
          throw new PeerError(403, '远程权限范围缺少可验证的身份');
        const root = fs.realpathSync(grant.root);
        const within = (base, target) => {
          const rel = path.relative(base, target);
          return rel === '' || rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
        };
        for (const pattern of requested.patterns) {
          if (typeof pattern !== 'string' || !pattern
              || pattern.includes('*') || pattern.includes('?')
              || pattern.includes('[') || pattern.includes(']')
              || pattern.includes('\\'))
            throw new PeerError(403, '原生审批请求含未经授权的模式');
          const target = path.resolve(row.nativeBase, pattern);
          if (!within(root, target)) throw new PeerError(403, '原生审批路径超出已配对工作区');
          const authorized = row.scope.some(value => {
            const selected = path.resolve(root, value);
            let directory = value === '.' || value.endsWith('/');
            try { directory ||= fs.statSync(selected).isDirectory(); } catch {}
            return directory ? within(selected, target) : selected === target;
          });
          if (!authorized) throw new PeerError(403, '原生审批路径超出本次任务范围');
          let component = root;
          for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
            component = path.join(component, part);
            try {
              if (fs.lstatSync(component).isSymbolicLink())
                throw new PeerError(403, '原生审批路径包含符号链接');
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
        }
      }
      save(key, { ...row, approvals: { ...approved, [approvalId]: { state: 'submitting', at: Date.now() } } });
      const endpoint = kind === 'permission' ? '/permission/' + encodeURIComponent(requestId) + '/reply'
        : '/question/' + encodeURIComponent(requestId) + '/reply';
      const body = kind === 'permission' ? { reply: choice } : { answers: choice };
      const confirmed = await api(endpoint + '?directory=' + encodeURIComponent(grant.root), { method: 'POST', body });
      if (confirmed !== true) throw new PeerError(502, '远端原生审批未确认');
      save(key, { ...row, approvals: { ...approved, [approvalId]: { state: 'answered', at: Date.now() } } });
      return { jobId: id, state: 'answered', requestId };
    }
    if (action === 'agent-status') {
      const identity = { computer: computerId(), root: grant.root };
      if (row.phase === 'stopped') return { ...identity, jobId: id, state: 'stopped', threadId: row.threadId };
      if (row.phase !== 'open' || row.submission !== 'submitted')
        return { ...identity, jobId: id, state: 'unknown', phase: row.phase, submission: row.submission };
      const status = row.replacedBy ? row.terminal : (await nativeJobState(row)).status;
      return { ...identity, ...status, jobId: id };
    }
    if (action === 'agent-stop') {
      if (row.phase === 'stopped') return { jobId: id, state: 'stopped' };
      if (row.replacedBy) return { jobId: id, state: row.terminal?.state || 'unknown' };
      if (row.phase !== 'open' || !row.threadId) return { jobId: id, state: 'unknown' };
      await api(sessionApi(row, '/abort'), { method: 'POST' });
      save(key, { ...row, phase: 'stopped' });
      return { jobId: id, state: 'stopped' };
    }
    if (action === 'agent-close') {
      if (row.phase === 'closed') return { jobId: id, state: 'closed' };
      if (row.threadId && !row.replacedBy) await api(sessionApi(row), { method: 'DELETE' });
      save(key, { ...row, phase: 'closed' });
      return { jobId: id, state: 'closed' };
    }
    throw new PeerError(400, '未知远程 Agent 操作');
  });
}
