import { computerId } from '../../lib/auth.mjs';
import { json, readJson } from '../http/static.mjs';
import { authenticatePeerTask, grantPeerTask, peerStatus, PeerError, revokePeerTask, sendPeerTask } from './access.mjs';
import { peerJobAction, stopPeerJobs } from './jobs.mjs';

function peerFailure(req, res, error) {
  if (error instanceof PeerError) return json(req, res, error.status, { error: error.message });
  console.error('[peer]', error.message);
  return json(req, res, 500, { error: '互控配置或任务记录读取失败' });
}

export async function receivePeerTask(req, res) {
  if (req.method !== 'POST') return json(req, res, 405, { error: 'method not allowed' });
  try {
    const request = authenticatePeerTask(await readJson(req));
    const body = request.action === 'list' ? { name: request.name, tasks: request.tasks } : { job: peerJobAction(request) };
    return json(req, res, 200, { computer: computerId(), ...body });
  } catch (error) { return peerFailure(req, res, error); }
}

export async function managePeerTasks(req, res, route, stillPaired) {
  try {
    if (req.method === 'GET' && route === '/api/peers') return json(req, res, 200, peerStatus());
    if (req.method === 'POST' && ['/api/peers/grant', '/api/peers/revoke', '/api/peers/send'].includes(route)) {
      const data = await readJson(req);
      if (!stillPaired()) return json(req, res, 401, { error: '授权入口已失效' });
      if (route === '/api/peers/grant') return json(req, res, 200, { grant: grantPeerTask(data) });
      if (route === '/api/peers/send') return json(req, res, 200, { job: await sendPeerTask(data) });
      revokePeerTask(data.grant);
      try { return json(req, res, 200, { stopRequested: stopPeerJobs(data.grant), revoked: true }); }
      catch (error) { return json(req, res, 200, { revoked: true, warning: error.message }); }
    }
    return json(req, res, 404, { error: 'not found' });
  } catch (error) { return peerFailure(req, res, error); }
}
