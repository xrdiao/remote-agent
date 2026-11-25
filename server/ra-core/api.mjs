import { json, readJson } from '../http/static.mjs';
import { RaCoreError } from './contract.mjs';

const routes = new Map([
  ['/api/ra-core/snapshot', 'GET'], ['/api/ra-core/work', 'GET'], ['/api/ra-core/links', 'GET'],
  ['/api/ra-core/activate', 'POST'], ['/api/ra-core/invoke', 'POST'], ['/api/ra-core/revoke', 'POST'],
]);

export async function handleRaCore(req, res, route, device, stillPaired, service) {
  const method = routes.get(route);
  if (!method) return json(req, res, 404, { error: 'not_found' });
  if (method !== req.method) return json(req, res, 405, { error: 'method_not_allowed' });
  if (!service) return json(req, res, 503, { error: 'journal_unavailable' });
  try {
    const query = new URL(req.url, 'http://relay').searchParams;
    const originId = query.get('originId');
    if (route === '/api/ra-core/snapshot') return json(req, res, 200, service.snapshot(device, originId));
    if (route === '/api/ra-core/work' || route === '/api/ra-core/links') {
      const operations = service.work(device, originId, query.get('operationId'));
      return json(req, res, 200, route.endsWith('/work') ? { operations } : {
        links: operations.map(({ id, origin, nodeId, workspaceId, artifacts }) => ({ operationId: id, origin, nodeId, workspaceId, artifacts })),
      });
    }
    const body = await readJson(req);
    if (route === '/api/ra-core/activate') return json(req, res, 200, { activation: await service.activate(device, body, stillPaired) });
    if (route === '/api/ra-core/revoke') return json(req, res, 200, service.revoke(device, body, stillPaired));
    const reply = await service.invoke(device, body, stillPaired);
    return json(req, res, reply.status, reply.body);
  } catch (error) {
    if (error instanceof RaCoreError) return json(req, res, error.status, { error: error.code });
    return json(req, res, 503, { error: 'ra_core_unavailable' });
  }
}
