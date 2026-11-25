import { boundPeerWorkspace, peerWorkspaceBindings, sendPeerWorkspace } from '../peer/workspace.mjs';

const pattern = /^ra-peer:([a-f0-9]{16}):([0-9a-f-]{36})$/;
export function remotePeerProject(project) {
  const found = pattern.exec(project?.host || '');
  return found ? { target: found[1], workspace: found[2], root: project.root } : null;
}
export function peerFusionProjects() {
  return peerWorkspaceBindings().map(({ target, workspace }) => ({
    target, workspace, host: 'ra-peer:' + target + ':' + workspace,
    app: 'opencode', kind: 'remote-agent',
  }));
}
export function verifyRemotePeerProject(project) {
  const peer = remotePeerProject(project);
  if (!peer) throw new Error('远程 Fusion 项目需使用已授权的 RA Peer host');
  // No implicit fallback from a remote assignment to local execution.
  boundPeerWorkspace(peer.workspace, peer.target);
  if (typeof peer.root !== 'string' || !peer.root.startsWith('/'))
    throw new Error('远程工作区必须使用目标机器上的绝对路径');
  return peer;
}
export async function remotePeerCatalog(project, signal) {
  const { target, workspace, root } = verifyRemotePeerProject(project);
  const catalog = await sendPeerWorkspace({ workspace }, 'agent-catalog', signal);
  if (catalog.computer !== target || catalog.root !== root || catalog.app !== 'opencode' || !catalog.ready)
    throw new Error('远端原生 Agent 身份或项目目录与授权不一致');
  if (typeof catalog.defaultModel !== 'string' || !/^[a-zA-Z0-9_.\/-]{3,180}$/.test(catalog.defaultModel) || !catalog.defaultModel.includes('/'))
    throw new Error('目标原生配置尚无已确认的默认模型，不能派工');
  return { computer: target, root, app: 'opencode', ready: true, model: catalog.defaultModel, effort: '', source: 'target-native-default-model', pricing: null,
    sessionReuse: catalog.sessionReuse === true };
}
export async function executeRemotePeer({ project, jobId, model, prompt, access = 'read', scope = ['.'], recovering = false,
  previousJobId, expectedThreadId, signal, onSubmitting = () => {}, onSubmitted = () => {}, onOpen = () => {}, onWaiting = () => {}, timeoutMs = 600000 }) {
  const { target, workspace, root } = verifyRemotePeerProject(project);
  const request = (action, fields = {}) => sendPeerWorkspace({ workspace, ...fields }, action, signal);
  if (!recovering) {
    const catalog = await remotePeerCatalog(project, signal);
    if (model && model !== catalog.model)
      throw new Error('远端模型不是当前原生已确认的默认模型，请先重新读取目标能力');
    if (previousJobId && !catalog.sessionReuse) throw new Error('目标 RA Peer 尚未支持原生 Worker 会话续接');
    const opened = await request('agent-open', { jobId, ...(previousJobId ? { previousJobId } : {}) });
    if (opened.state !== 'open' || !opened.threadId)
      throw new Error('远端创建结果未知：不能重新创建重复会话');
    if (previousJobId && opened.threadId !== expectedThreadId)
      throw new Error('远端未返回原 Worker 会话，不能继续提交');
    onOpen(opened.threadId);
    onSubmitting();
    const submitted = await request('agent-submit', { jobId, text: prompt, model, access, scope });
    if (submitted.state !== 'submitted' || submitted.threadId !== opened.threadId)
      throw new Error('远端提交结果未知：不能重复提交');
    onSubmitted(submitted.threadId, submitted.messageId);
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    signal?.throwIfAborted();
    const status = await request('agent-status', { jobId });
    if (status.computer !== target) throw new Error('远端状态回执身份不匹配');
    if (status.state === 'awaiting_user') {
      if (!status.waiting || !['permission', 'question'].includes(status.waiting.kind)
          || !status.waiting.id) throw new Error('远端审批身份不完整，任务保留待核对');
      onWaiting(status.waiting);
    } else onWaiting(null);
    if (status.state === 'stopped') return { stopped: true, completed: false, text: status.text || '', endedAt: Date.now(), usage: { actualCost: 'unknown', basis: '远端已停止' } };
    if (status.state === 'failed')
      return { completed: false, error: status.error || '远端原生 Agent 执行失败', text: status.text || '',
        endedAt: Date.now(), usage: { actualCost: 'unknown', basis: '远端未提供实际计费' } };
    if (status.state === 'completed')
      return { completed: true, text: status.text, endedAt: Date.now(),
        usage: { actualCost: 'unknown', basis: '远端未提供实际计费' },
        changes: { available: false, at: Date.now(), reason: '远端变更需以授权工作区文件回读复核' },
        remote: { target, workspace, threadId: status.threadId, tools: status.tools } };
    if (status.state === 'unknown') throw new Error('远端 Agent 状态未知：保留原任务 ID 待人工核对，禁止重新派工');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 600);
      function abort() { clearTimeout(timer); reject(signal.reason || new Error('远端执行已取消')); }
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  }
  throw new Error('远端 Agent 结果尚未确认：保留任务 ID，不重复提交');
}
export async function stopRemotePeer(project, jobId) {
  const peer = verifyRemotePeerProject(project);
  return sendPeerWorkspace({ workspace: peer.workspace, jobId }, 'agent-stop');
}
export async function closeRemotePeer(project, jobId) {
  const peer = verifyRemotePeerProject(project);
  return sendPeerWorkspace({ workspace: peer.workspace, jobId }, 'agent-close');
}

export async function readRemotePeer(project, jobId) {
  const peer = verifyRemotePeerProject(project);
  return sendPeerWorkspace({ workspace: peer.workspace, jobId }, 'agent-status');
}
export async function answerRemotePeer(project, jobId, waiting, reply) {
  const peer = verifyRemotePeerProject(project);
  if (!waiting || !['permission', 'question'].includes(waiting.kind) || !waiting.id)
    throw new Error('远端原生审批身份不完整');
  const args = { workspace: peer.workspace, jobId, kind: waiting.kind, requestId: waiting.id,
    ...(waiting.kind === 'permission' ? { reply } : { answers: reply }) };
  return sendPeerWorkspace(args, 'agent-answer');
}
