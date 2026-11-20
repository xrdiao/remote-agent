import { computerId } from '../../lib/auth.mjs';
import { json, readBody, readJson } from '../http/static.mjs';
import { authenticatePeerTask, confirmWorkspaceFingerprints, grantPeerTask, peerStatus, PeerError, revokePeerTask, sendPeerTask,
  workspaceFingerprints } from './access.mjs';
import { peerJobAction, stopPeerJobs } from './jobs.mjs';
import { grantPeerWorkspace, openPeerWorkspace, PEER_WORKSPACE_BODY_LIMIT, PEER_WORKSPACE_VERSION, peerWorkspaceAction, peerWorkspaceGrants,
  revokePeerWorkspace } from './workspace.mjs';
import { listWindows, phoneWindows } from '../windows.mjs';

function peerFailure(req, res, error) {
  if (error instanceof PeerError) return json(req, res, error.status, { error: error.message });
  console.error('[peer]', error.message);
  return json(req, res, 500, { error: '电脑中继未能完成互控操作' });
}

export async function receivePeerTask(req, res) {
  if (req.method !== 'POST') return json(req, res, 405, { error: 'method not allowed' });
  try {
    const request = authenticatePeerTask(await readJson(req));
    const body = request.action === 'list' ? { name: request.name, tasks: request.tasks } : { job: peerJobAction(request) };
    return json(req, res, 200, { computer: computerId(), ...body });
  } catch (error) { return peerFailure(req, res, error); }
}

export async function receivePeerWorkspace(req, res) {
  if (req.method !== 'POST') return json(req, res, 405, { error: 'method not allowed' });
  req.setEncoding('utf8');
  let data;
  try { data = JSON.parse(await readBody(req, PEER_WORKSPACE_BODY_LIMIT)); }
  catch { return json(req, res, 400, { error: '互控工作区请求无效' }); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return json(req, res, 400, { error: '互控工作区请求无效' });
  try { return json(req, res, 200, await peerWorkspaceAction(data)); }
  catch (error) { return peerFailure(req, res, error); }
}

export async function managePeerTasks(req, res, route, stillPaired) {
  try {
    if (req.method === 'GET' && route === '/api/peers') return json(req, res, 200, { ...peerStatus(), workspaceVersion: PEER_WORKSPACE_VERSION,
      workspaces: peerWorkspaceGrants(), workspaceFingerprints: workspaceFingerprints(), canConfirmFingerprints: true });
    const confirm = route === '/api/peers/workspace-fingerprints';
    if (req.method === 'POST' && (confirm || ['/api/peers/grant', '/api/peers/revoke', '/api/peers/send', '/api/peers/workspace',
      '/api/peers/workspace-grant', '/api/peers/workspace-revoke'].includes(route))) {
      req.setEncoding('utf8');
      const data = confirm ? await readBody(req) : await readJson(req);
      if (!stillPaired()) return json(req, res, 401, { error: '授权入口已失效' });
      if (confirm) {
        if (data !== '{}') throw new PeerError(400, '指纹确认参数必须用配对密钥签名');
        // authenticateRequest already verified the method and the exact URL, including these parameters.
        const params = new URL(req.url, 'http://relay').searchParams;
        return json(req, res, 200, confirmWorkspaceFingerprints(Object.fromEntries(params)));
      }
      if (route === '/api/peers/workspace') {
        const agents = phoneWindows(await listWindows().catch(() => []));
        if (!agents.length) throw new PeerError(404, '发起电脑没有可用的 Agent');
        const root = await openPeerWorkspace(data);
        return json(req, res, 200, { id: computerId(), root, agents });
      }
      if (route === '/api/peers/workspace-grant') return json(req, res, 200, { grant: grantPeerWorkspace(data) });
      if (route === '/api/peers/workspace-revoke') {
        await revokePeerWorkspace(data.grant);
        return json(req, res, 200, { revoked: true });
      }
      if (route === '/api/peers/grant') return json(req, res, 200, { grant: grantPeerTask(data) });
      if (route === '/api/peers/send') return json(req, res, 200, { job: await sendPeerTask(data) });
      revokePeerTask(data.grant);
      try { return json(req, res, 200, { stopRequested: stopPeerJobs(data.grant), revoked: true }); }
      catch (error) { return json(req, res, 200, { revoked: true, warning: error.message }); }
    }
    return json(req, res, 404, { error: 'not found' });
  } catch (error) { return peerFailure(req, res, error); }
}
