import { pathKey, samePath } from '../../lib/platform.mjs';
import { helpersCall } from '../page/build.mjs';
import { ConversationRef } from '../session/binding.mjs';
import { digestId, hash, RaCoreError } from './contract.mjs';

export function createOriginRegistry({ computerId, sessions, agents, openCode, codex }) {
  function candidate(deviceId, session) {
    const binding = ConversationRef.capture(session);
    const { app, threadId, codexBackend, codexDirectory, openCodeDirectory, sessionProject } = binding;
    if (session.deviceId !== deviceId || session.disposed || session.switchingThread || session.offThread
      || !binding.bindingReady || binding.selectionHome || !agents[app]?.discover
      || typeof threadId !== 'string' || !threadId || threadId.length > 512 || /[\x00-\x1f\x7f]/.test(threadId)) return;
    let roots;
    if (app === 'opencode') {
      const native = openCode.sessions.get(threadId);
      if (!openCode.connected || !native || !samePath(native.directory, openCodeDirectory)) return;
      roots = [{ root: openCodeDirectory }];
    } else if (codexBackend) {
      const native = codex.threads.get(threadId);
      if (!codex.canAccess(threadId, deviceId) || !codex.client.ready || !native || !samePath(native.cwd, codexDirectory)) return;
      roots = [{ root: codexDirectory }];
    } else {
      if (app === 'codex' && !codex.canAccess(threadId, deviceId)) return;
      if (binding.cdp?.ws?.readyState !== 1 || binding.editorCdp?.ws?.readyState !== 1
        || sessionProject?.generation !== binding.sel || sessionProject.selection !== binding.key) return;
      roots = sessionProject.roots;
    }
    const project = roots.filter(row => row.root).map(({ host, root }) => JSON.stringify([host || '', pathKey(root, !host)])).sort();
    const projectId = project.length ? hash(project) : undefined;
    const origin = { id: hash([computerId, deviceId, app, threadId, projectId || null]), deviceId, computerId, app, threadId,
      ...(projectId ? { projectId } : {}) };
    return { origin, session, binding };
  }

  const candidates = deviceId => [...sessions(deviceId)].map(session => candidate(deviceId, session)).filter(Boolean);
  const find = (deviceId, id) => {
    if (!digestId(id)) throw new RaCoreError(400, 'invalid_origin');
    const row = candidates(deviceId).find(({ origin }) => origin.id === id);
    if (!row) throw new RaCoreError(403, 'origin_unavailable');
    return row;
  };

  return {
    list: deviceId => [...new Map(candidates(deviceId).map(({ origin }) => [origin.id, origin])).values()],
    require: (deviceId, id) => find(deviceId, id).origin,
    async verify(deviceId, id) {
      const { origin, session, binding } = find(deviceId, id);
      if (binding.app !== 'opencode' && !binding.codexBackend) {
        let thread;
        try {
          thread = await binding.cdp.evaluate(helpersCall(binding.app === 'codex' ? 'codexThread()' : 'activeThread()'), { timeout: 5000 });
        } catch { throw new RaCoreError(409, 'origin_stale'); }
        if (thread !== origin.threadId) throw new RaCoreError(409, 'origin_stale');
      }
      if (!binding.isCurrent(session) || ![...sessions(deviceId)].includes(session) || candidate(deviceId, session)?.origin.id !== id)
        throw new RaCoreError(409, 'origin_stale');
      return origin;
    },
  };
}
