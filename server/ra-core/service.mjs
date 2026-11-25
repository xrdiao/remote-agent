import { peerGrantId, PeerError, peerId } from '../peer/access.mjs';
import { actionArgs, digestId, fields, operationId, peerResult, RaCoreError, workspaceActions } from './contract.mjs';
import { activationView, operationView } from './journal.mjs';

function scope({ originId, nodeId, workspaceId }) {
  if (!digestId(originId) || !peerId(nodeId) || !peerGrantId(workspaceId)) throw new RaCoreError(400, 'invalid_scope');
}

function requirePaired(stillPaired) {
  if (!stillPaired()) throw new RaCoreError(403, 'pairing_unavailable');
}

const rejectedStatus = new Map([[400, 400], [401, 403], [403, 403], [404, 409], [409, 409]]);

export function createRaCoreService({ journal, origins, nodes, now = Date.now }) {
  function workspace(workspaceId, nodeId) {
    try { return nodes.workspace(workspaceId, nodeId); }
    catch (error) {
      if (error instanceof PeerError && error.status === 403) throw new RaCoreError(403, 'peer_untrusted');
      if (error instanceof PeerError && [400, 404, 409].includes(error.status)) throw new RaCoreError(409, 'binding_stale');
      throw error;
    }
  }

  function publicActivation(row) {
    const view = activationView(row, now());
    if (view.state === 'active') {
      try {
        if (workspace(view.workspaceId, view.nodeId).key !== row.binding_key) view.state = 'stale';
      } catch (error) {
        if (!(error instanceof RaCoreError)) throw error;
        view.state = 'stale';
      }
    }
    return view;
  }

  return {
    snapshot(device, originId) {
      const activations = [];
      if (originId !== null) {
        origins.require(device, originId);
        activations.push(...journal.activations(device, originId).map(publicActivation));
      }
      return { version: 1, nodes: nodes.list(device), origins: origins.list(device), activations };
    },

    work(device, originId, id) {
      if (!digestId(originId) || id !== null && !operationId(id)) throw new RaCoreError(400, 'invalid_work_query');
      const rows = journal.work(device, originId, id);
      if (!rows.length && !journal.activations(device, originId).length
        && !(id && journal.work(device, originId, null).length)) origins.require(device, originId);
      return rows.map(operationView);
    },

    async activate(device, body, stillPaired) {
      fields(body, ['originId', 'nodeId', 'workspaceId', 'actions', 'ttlSeconds', 'maxUses']);
      scope(body);
      const { originId, nodeId, workspaceId, actions, ttlSeconds, maxUses } = body;
      if (!Array.isArray(actions) || !actions.length || actions.some(action => !workspaceActions.includes(action))
        || new Set(actions).size !== actions.length
        || !Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86_400
        || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100) throw new RaCoreError(400, 'invalid_activation_limits');
      requirePaired(stillPaired);
      origins.require(device, originId);
      journal.assertCanActivate(device, originId, nodeId, workspaceId, now());
      const peer = workspace(workspaceId, nodeId);
      let reply;
      try { reply = await peer.request('inspect', {}); }
      catch (error) {
        const status = error instanceof PeerError && error.status === 403 ? 403 : 502;
        throw new RaCoreError(status, status === 403 ? 'peer_denied' : 'peer_unverified');
      }
      const verifiedAt = now();
      if (reply.status !== 200) {
        const status = rejectedStatus.get(reply.status) || 502;
        throw new RaCoreError(status, status === 403 ? 'peer_denied' : 'peer_unverified');
      }
      if (typeof reply.result?.root !== 'string' || !reply.result.root) throw new RaCoreError(502, 'peer_unverified');
      await origins.verify(device, originId);
      requirePaired(stillPaired);
      if (workspace(workspaceId, nodeId).key !== peer.key) throw new RaCoreError(409, 'binding_stale');
      const activatedAt = now();
      return activationView(journal.activate({ device, origin: originId, node: nodeId, workspace: workspaceId,
        bindingKey: peer.key, actions, verifiedAt, expiresAt: activatedAt + ttlSeconds * 1000, maxUses }, activatedAt), activatedAt);
    },

    revoke(device, body, stillPaired) {
      fields(body, ['originId', 'activationId']);
      if (!digestId(body.originId) || !peerGrantId(body.activationId)) throw new RaCoreError(400, 'invalid_scope');
      requirePaired(stillPaired);
      const { row, inFlight } = journal.revoke(device, body.originId, body.activationId, now());
      return { activation: activationView(row, now()), inFlight: inFlight.map(operationView), inFlightCount: inFlight.length };
    },

    async invoke(device, body, stillPaired) {
      fields(body, ['originId', 'nodeId', 'workspaceId', 'activationId', 'operationId', 'action', 'args']);
      scope(body);
      const { originId, nodeId, workspaceId, activationId, operationId: id, action } = body;
      if (activationId == null) throw new RaCoreError(403, 'activation_required');
      if (!peerGrantId(activationId) || !operationId(id) || !workspaceActions.includes(action))
        throw new RaCoreError(400, 'invalid_operation');
      const args = actionArgs(action, body.args);
      requirePaired(stillPaired);
      const { view: activation } = journal.requireAction(device, originId, activationId, nodeId, workspaceId, action, now());
      const origin = await origins.verify(device, originId);
      requirePaired(stillPaired);
      const peer = workspace(workspaceId, nodeId);
      const { row, replay } = journal.reserve({ id, origin, activationId, node: nodeId, workspace: workspaceId,
        bindingKey: peer.key, action, args }, now);
      if (replay) return { status: 200, body: { operation: operationView(row), replayed: true } };

      let rejected = journal.start(row, now);
      if (!rejected) {
        // The STARTED commit can cross the activation deadline before the request is sent.
        const dispatchAt = now();
        if (activation.expiresAt <= dispatchAt)
          rejected = journal.finish(row, { state: 'FAILED', error: 'action_not_activated' }, dispatchAt);
      }
      if (rejected) return { status: 403, body: { operation: operationView(rejected), replayed: false, error: rejected.error_code } };
      let reply, transportStatus;
      try { reply = await peer.request(action, args); }
      catch (error) { if (error instanceof PeerError && error.status === 403) transportStatus = 403; }

      const result = reply?.status === 200 ? peerResult(action, reply.result) : null;
      const rejection = rejectedStatus.get(reply?.status);
      const outcome = result ? { state: 'SUCCEEDED', result: result.summary, peerStatus: 200 }
        : rejection ? { state: 'FAILED', error: rejection === 403 ? 'peer_denied' : 'peer_rejected', peerStatus: reply.status }
        : { state: 'UNKNOWN', error: 'peer_outcome_unknown' };
      const operation = operationView(journal.finish(row, outcome, now()));
      requirePaired(stillPaired);
      return { status: result ? 200 : rejection || transportStatus || 502,
        body: { operation, replayed: false, ...(result?.data ? { result: result.data } : {}), ...(outcome.error ? { error: outcome.error } : {}) } };
    },
  };
}
