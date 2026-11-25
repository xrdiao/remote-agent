import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { executeAgentControl, assertSendMode, readAgentSetting, setAgentSetting, manageAgentSession, runAgentControl } from '../../agent/control.mjs';
import { leaseWindow } from '../../window-use.mjs';
import { isAbortedOpenCodeRequest } from '../../opencode/requests.mjs';
import { normalizeOpenCodeQuestions, openCodeQuestionRejection, openCodePermissionRejection } from './questions.mjs';
import { assertNativeProject, readNativeContext, readNativeConversationProgress,
  inspectNativeWindow, prepareNativeView, createNativeSessionOnView, cancelExactNativeTurn, captureCodexNativeSubmission,
  prepareCursorNativeQuestion, prepareCursorNativePermission, prepareCodexNativeInteraction, prepareDevinNativePermission, prepareDevinNativeQuestion,
  readCodexBackendProgress, prepareCodexBackendInteraction, cancelExactCodexBackendTurn } from './native-task-adapter.mjs';

const APPS = Object.freeze({ codex: 'Codex', cursor: 'Cursor', devin: 'Devin', opencode: 'OpenCode' });
const NAMES = Object.keys(APPS);
const CODEX_BACKEND = 'backend';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const REQUEST_ID = /^[A-Za-z0-9_.:-]{4,160}$/;
// These native adapters recheck the exact turn inside nativeSessionAction.
const NATIVE_STOP_ADAPTERS = new Set(['codex', 'cursor', 'devin']);
const IMPLEMENTED = Object.freeze({
  codex: { create_session: true, send: true, cancel: true, approve: false },
  cursor: { create_session: true, send: true, cancel: true, approve: false },
  devin: { create_session: true, send: true, cancel: true, approve: false },
  opencode: { create_session: true, send: true, cancel: true, approve: true },
});
const str = value => value == null ? '' : String(value);
const fail = (code, message) => { throw Object.assign(new Error(message || code), { code, outcomeUnknown: false }); };

function deviceIdOf(device) {
  const id = device && typeof device === 'object' ? device.id : device;
  if (typeof id !== 'string' || !id) fail('invalid_device');
  return id;
}

function authScopes(auth) {
  if (!auth) return null;
  if (Array.isArray(auth.scope)) return auth.scope;
  if (typeof auth.scope === 'string') return auth.scope.split(/\s+/).filter(Boolean);
  return null;
}

function requireScope(auth, needed) {
  const scopes = authScopes(auth);
  if (!scopes || !needed.some(scope => scopes.includes(scope))) fail('scope_required');
}

function selectArgs(args, withMessage = false) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('invalid_args');
  const app = str(args.app), windowId = str(args.window_id), threadId = str(args.thread_id);
  if (!NAMES.includes(app)) fail('invalid_app');
  if (!windowId || !threadId) fail('invalid_session_ref');
  if (withMessage) {
    const message = args.message;
    if (typeof message !== 'string' || !message.length || message.length > 16000 || message.includes('\0')) fail('invalid_message');
    if (args.operation_id !== undefined && !UUID.test(str(args.operation_id))) fail('invalid_operation_id');
  }
  return { app, windowId, threadId };
}

function isBackendRow(row, app, env) {
  return app === 'codex' && (str(row.windowId) === CODEX_BACKEND || str(row.win).includes('backend')
    || (typeof env.isBackendThread === 'function' && env.isBackendThread(row)));
}

async function evaluate(row, app, native, env, deviceId) {
  if (row.host) return { ok: false, reason: 'remote_session' };
  if (isBackendRow(row, app, env)) {
    if (typeof env.backendInfo !== 'function') return { ok: false, reason: 'codex_backend_unavailable' };
    const info = await env.backendInfo(str(row.threadId), deviceId, row);
    if (!info?.exists || !info.allowed || !info.ready) return { ok: false, reason: 'codex_backend_unavailable' };
    if (info.nativeOwner) return { ok: false, reason: 'codex_backend_native_owner' };
    return { ok: true, backend: true, writer: !!info.writer };
  }
  if (row.dormant) return { ok: false, reason: 'native_window_not_ready' };
  if (app === 'opencode') return native.connected ? { ok: true } : { ok: false, reason: 'native_api_unavailable' };
  const targets = (native.targets || []).filter(item => item.app === app
    && str(item.pageId || item.id) === str(row.windowId) && item.ws);
  const target = targets.length === 1 ? targets[0] : null;
  return target ? { ok: true, target } : { ok: false, reason: 'native_cdp_unavailable' };
}

async function selectSession(deviceId, sel, env, reviewer, project = '', createdContext = null) {
  if (!await env.validDevice(deviceId)) fail('device_pairing_revoked');
  const snapshot = await env.snapshot(deviceId);
  const rows = (snapshot.sessions || []).filter(row => row && row.app === sel.app
    && str(row.windowId) === sel.windowId && str(row.threadId) === sel.threadId);
  const native = await env.nativeInfo(deviceId);
  // A newly created native session may not yet be in the overview catalog.
  // Only task callers supply a canonical authorized project, and the native
  // context must independently prove the complete app/window/thread/project.
  if (project && (!rows.length || createdContext && rows.length === 1 && !rows[0].workspace)
      && (createdContext || typeof env.readContext === 'function')) {
    const context = createdContext || await env.readContext(sel, native);
    assertNativeProject(context, project, sel.threadId);
    const row = { ...rows[0], app: sel.app, windowId: sel.windowId, threadId: sel.threadId, workspace: project };
    if (rows.length) rows[0] = row;
    else rows.push(row);
  }
  if (rows.length !== 1) fail('session_not_found_or_ambiguous');
  const row = rows[0];
  if (project && !await (env.projectMatches || sameProject)(row.workspace, project)) fail('task_project_mismatch');
  const verdict = await evaluate(row, sel.app, native, env, deviceId);
  if (!verdict.ok) fail(verdict.reason);
  if (typeof reviewer === 'function' && !reviewer(row)) fail('session_not_allowed');
  return { row, native, verdict };
}

async function selectCreatedSession(id, sel, env, reviewer, args) {
  const proof = args.created_session;
  if (!proof || proof.task_id !== args.operation_id || proof.app !== sel.app || proof.project !== args.project_path
      || proof.window_id !== sel.windowId || proof.thread_id !== sel.threadId || !proof.transport
      || typeof env.readContext !== 'function') fail('native_creation_identity_mismatch');
  // Only read-only probes are retried. No attach, selection, creation or send
  // can run until this function has returned verified readiness.
  const timeout = Math.max(1, Math.min(3000, env.creationReadyTimeoutMs ?? 3000));
  const poll = Math.max(1, Math.min(100, env.creationReadyPollMs ?? 100));
  const deadline = performance.now() + timeout;
  const probe = async () => {
    if (!await env.validDevice(id)) fail('device_pairing_revoked');
    if (performance.now() >= deadline) return null;
    const native = await env.nativeInfo(id);
    if (performance.now() >= deadline) return null;
    const targets = (native.targets || []).filter(target => target.app === sel.app
      && str(target.pageId || target.id) === sel.windowId && target.ws);
    if (targets.length > 1) fail('native_creation_window_ambiguous');
    if (!targets.length) return null;
    if (targets[0].ws !== proof.transport) fail('native_window_context_changed');
    let context;
    try { context = await env.readContext(sel, native); }
    catch { return null; } // Read failure cannot have submitted a prompt.
    if (performance.now() >= deadline) return null;
    if (!context) return null;
    if (context.host || str(context.threadId) !== sel.threadId || context.roots?.some(root => root.host))
      fail('native_project_context_mismatch');
    if (!context.cwd || !context.roots?.length) return null;
    assertNativeProject(context, args.project_path, sel.threadId);
    if (context.roots.length !== 1 || !await sameProject(context.roots[0].root, args.project_path))
      fail('native_window_project_ambiguous');
    let selected;
    try { selected = await selectSession(id, sel, env, reviewer, args.project_path, context); }
    catch (error) {
      // A nonempty catalog workspace may also lag creation. Keep waiting for
      // it to agree, but only AFTER exact live native scope was proven above.
      if (['native_window_not_ready', 'task_project_mismatch'].includes(error.code)) return null;
      throw error;
    }
    if (selected.verdict.target?.ws !== proof.transport) fail('native_window_context_changed');
    return selected;
  };
  let timer;
  try {
    return await Promise.race([
      (async () => {
        while (performance.now() < deadline) {
          const selected = await probe();
          if (performance.now() >= deadline) break;
          if (selected) return selected;
          await new Promise(resolve => setTimeout(resolve, Math.min(poll, Math.max(1, deadline - performance.now()))));
        }
        fail('native_created_session_readiness_timeout');
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(
        Error('native_created_session_readiness_timeout'), { outcomeUnknown: false })), timeout); }),
    ]);
  } finally { clearTimeout(timer); }
}

function attachRequest(row, app, native, backend) {
  const windowId = str(row.windowId), threadId = str(row.threadId);
  if (app === 'opencode') return { req: { id: 'opencode', windowId, threadId }, windows: [] };
  if (backend) return { req: { id: 'codex', windowId: CODEX_BACKEND, threadId, backend: true }, windows: [] };
  const target = native.targets.find(item => item.app === app
    && str(item.pageId || item.id) === windowId && item.ws);
  return {
    req: { id: app === 'codex' ? 'codex' : windowId, windowId, threadId, projectSwitch: true },
    // The navigation adapter expects the merged Codex application entry,
    // not its per-webview notification target. Keep the exact page ID in req.
    windows: [app === 'codex' ? { ...target, id: 'codex', ws: target.editorWs || target.ws } : target],
  };
}

function assertBinding(view, row, app, backend) {
  if (!view) fail('binding_mismatch');
  const windowId = str(row.windowId), threadId = str(row.threadId);
  const actualWindow = str(backend || app === 'opencode' ? view.openCodeDirectory || view.windowId : view.windowId);
  const expectedWindow = backend ? CODEX_BACKEND : app === 'opencode' ? str(row.workspace || windowId) : windowId;
  if (view.app !== app || str(view.threadId) !== threadId || actualWindow !== expectedWindow
      || backend && view.codexBackend !== true) fail('binding_mismatch');
}

function ackResult(emitted, requestId, sel) {
  const base = { app: sel.app, window_id: sel.windowId, thread_id: sel.threadId, request_id: requestId };
  if (emitted.some(item => item.t === 'sendFailed' || item.t === 'send_failed'))
    return { ...base, state: 'UNKNOWN', reason: 'native_send_failed' };
  const ack = emitted.find(item => item.t === 'sent' && (item.messageId || item.queueId));
  if (ack) return { ...base, state: 'ACKNOWLEDGED', native_message_id: str(ack.messageId || ack.queueId), queued: !!ack.queueId || ack.queued === true, native_queue_id: str(ack.queueId) };
  if (emitted.some(item => item.t === 'sent' && item.pending))
    return { ...base, state: 'UNKNOWN', reason: 'native_receipt_pending' };
  return { ...base, state: 'UNKNOWN', reason: 'native_receipt_unconfirmed' };
}

function runIsRunning(run) {
  return !!run && ['running', 'in_progress', 'busy'].includes(str(run.status));
}

function verifiableWaitingRequest(info, app) {
  const candidate = info?.waitingRequest;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const kind = str(candidate.kind), id = str(candidate.id);
  if (!['permission', 'question'].includes(kind) || !REQUEST_ID.test(id)) return null;
  const bounded = { kind, id };
  if (kind === 'permission') {
    if (candidate.permission !== undefined) bounded.permission = str(candidate.permission).slice(0, 60);
    if (candidate.scope !== undefined) bounded.scope = str(candidate.scope).slice(0, 2000);
    if (Array.isArray(candidate.patterns))
      bounded.patterns = candidate.patterns.slice(0, 20).map(value => str(value).slice(0, 1024));
    if (typeof candidate.permissionKey === 'string' && candidate.permissionKey.length <= 64000) {
      bounded.action = candidate.action;
      bounded.command = candidate.command;
      bounded.options = candidate.options;
      bounded.native = candidate.native;
      bounded.permissionKey = candidate.permissionKey;
      if (candidate.grantScope === 'turn') bounded.grantScope = 'turn';
    }
  } else if (app === 'opencode') {
    try { bounded.questions = normalizeOpenCodeQuestions(candidate.questions); }
    catch { return null; }
  } else if (Array.isArray(candidate.questions)) {
    bounded.questions = candidate.questions.slice(0, 20).map(question => ({
      question: str(question?.question).slice(0, 2000),
      ...(typeof question?.header === 'string' ? { header: question.header.slice(0, 500) } : {}),
      ...(Array.isArray(question?.options)
        ? { options: question.options.slice(0, 20).map(option => str(option).slice(0, 500)) } : {}),
      ...(Array.isArray(question?.optionDescriptions) ? { optionDescriptions: question.optionDescriptions.slice(0, 20).map(value => str(value).slice(0, 2000)) } : {}),
      ...(typeof question?.allowMultiple === 'boolean' ? { allowMultiple: question.allowMultiple } : {}),
      ...(typeof question?.allowCustom === 'boolean' ? { allowCustom: question.allowCustom } : {}),
      ...(question?.isSecret === true ? { isSecret: true } : {}),
    }));
  }
  if (candidate.native && typeof candidate.questionKey === 'string') {
    bounded.native = candidate.native;
    bounded.questionKey = candidate.questionKey;
  }
  return bounded;
}

async function sameProject(workspace, project) {
  if (str(workspace) === str(project)) return true;
  try { return fs.realpathSync(str(workspace)) === str(project); }
  catch { return false; }
}

let realDeps;
async function createRealDeps() {
  const [overview, native, registry, sessionModule, authModule, opencodeModule, codexState,configModule, files] = await Promise.all([
    import('../../overview.mjs'),
    import('../../native-windows.mjs'),
    import('../../apps/index.mjs'),
    import('../../session.mjs'),
    import('../../../lib/auth.mjs'),
    import('../../opencode/state.mjs'),
    import('../../codex/state.mjs'),
    import('../../config.mjs'),
    import('../../../lib/files.mjs'),
  ]);
  const sourceFor = (sel, info) => {
    const targets = (info?.targets || native.nativeTargets()).filter(item => item.app === sel.app
      && str(item.pageId || item.id) === str(sel.windowId));
    if (targets.length !== 1 || !targets[0].ws) fail('native_cdp_unavailable');
    const source = native.nativeWindowAt(targets[0].ws);
    if (!source) fail('native_cdp_unavailable');
    return source;
  };
  return {
    validDevice: async id => {
      const row = authModule.listDevices().find(device => device.id === id);
      return !!row && !authModule.needsTotp(row);
    },
    snapshot: async id => overview.overviewSnapshot(id),
    nativeInfo: async () => ({
      targets: native.nativeTargets(),
      connected: !!opencodeModule.openCode.connected || await (async()=>{
        try {
          const response = await fetch(configModule.OPENCODE_URL + '/config',
            { signal: AbortSignal.timeout(1200) });
          return response.ok;
        } catch { return false; }
      })(),
      catalogReady: app => !!native.nativeSessionCatalog(app)?.ready,
    }),
    capabilities: async app => registry.AGENT_REGISTRY[app]?.capabilities || {},
    projectMatches: sameProject,
    readContext: async (sel, info) => {
      if (sel.app !== 'opencode') return readNativeContext(sourceFor(sel, info).cdp, sel.app, sel.threadId);
      const openCode = opencodeModule.openCode;
      await openCode.connect();
      const session = await openCode.client.request('/session/' + encodeURIComponent(sel.threadId), { directory: sel.windowId });
      if (session?.id !== sel.threadId || !await sameProject(session.directory, sel.windowId)) fail('native_session_directory_mismatch');
      openCode.sessions.set(session.id, session);
      return { app: 'opencode', threadId: session.id, cwd: session.directory, host: '', roots: [{ root: session.directory, host: '' }] };
    },
    manageSession: manageAgentSession,
    openCode: opencodeModule.openCode,
    createAPISession: async (project, title) => {
      await opencodeModule.openCode.connect();
      const { createSession } = await import('../../apps/opencode.mjs');
      return createSession(project, { title });
    },
    prepareView: prepareNativeView,
    prepareAPIView: async row => {
      const status = await opencodeModule.openCode.client.request('/session/status', { directory: row.workspace, signal: AbortSignal.timeout(10000) });
      if (status?.[row.threadId] && status[row.threadId].type !== 'idle') fail('session_busy_or_waiting');
    },
    createOnView: createNativeSessionOnView,
    windowState: async target => {
      const source = sourceFor({ app: target.app, windowId: target.pageId || target.id });
      const state = await inspectNativeWindow(source.cdp, target.app);
      if (state.context) return { ...state, workspace: state.context.cwd, host: state.context.host,
        ambiguous: state.context.roots?.length !== 1 };
      // Home/new-chat views have no thread context: read the live editor roots.
      const editor = new native.NativeCdp(target.editorWs || target.ws, target.app);
      try {
        await editor.connect();
        const roots = await files.editorRoots(editor, target.app);
        return { ...state, workspace: roots[0]?.root, host: roots[0]?.host, ambiguous: roots.length !== 1 };
      } finally { editor.close(); }
    },
    exactCancel: async (row, receipt, checkOnly, options) => {
      const verified = row.app === 'codex' && row.windowId === CODEX_BACKEND
        ? await cancelExactCodexBackendTurn(codexState.codexBackend, row, receipt, options)
        : await cancelExactNativeTurn(sourceFor({ app: row.app, windowId: row.windowId }), row, receipt, options);
      if (checkOnly) return { supported: true, binding: verified.binding, turnId: verified.turn.turnId };
      const ack = await verified.stop();
      return { supported: true, state: ack === true ? 'ACKNOWLEDGED' : 'UNKNOWN',
        reason: ack === true ? '' : 'native_cancel_receipt_unconfirmed', basis: 'native_exact_turn_ack' };
    },
    readSubmission: (row, receipt, prompt) => captureCodexNativeSubmission(
      sourceFor({ app: row.app, windowId: row.windowId }), row, receipt, prompt),
    prepareQuestion: (row, receipt, pending, options) => ({ codex: prepareCodexNativeInteraction, cursor: prepareCursorNativeQuestion, devin: prepareDevinNativeQuestion }[row.app])(
      sourceFor({ app: row.app, windowId: row.windowId }), row, receipt, pending, options),
    preparePermission: (row, receipt, pending, options) => {
      const prepare = { codex: prepareCodexNativeInteraction, cursor: prepareCursorNativePermission, devin: prepareDevinNativePermission }[row.app];
      return prepare(sourceFor({ app: row.app, windowId: row.windowId }), row, receipt, pending, options);
    },
    prepareBackendInteraction: (row, receipt, pending, options) =>
      prepareCodexBackendInteraction(codexState.codexBackend, row, receipt, pending, options),
    isBackendThread: row => row.app === 'codex' && str(row.windowId) === CODEX_BACKEND,
    backendInfo: async (id, deviceId) => {
      const backend = codexState.codexBackend;
      if (!backend.records.has(id)) return { exists: false };
      let nativeOwner = false;
      try { nativeOwner = !!await registry.AGENT_REGISTRY.codex.adapter.backendOwner(id, false, ''); }
      catch { nativeOwner = true; }
      return { exists: true, allowed: backend.canAccess(id, deviceId), ready: !!backend.client.ready,
        writer: backend.hasWriter(id), nativeOwner };
    },
    newRequestId: async () => crypto.randomUUID(),
    withSession: (id, client, action) => sessionModule.withTemporarySession(client, id, action),
    waitForAck: async (emitted, requestId) => {
      const ready = () => emitted.some(item => item.requestId === requestId
        && ((item.t === 'sent' && (item.messageId || item.queueId)) || item.t === 'sendFailed'));
      for (let i = 0; i < 45 && !ready(); i++) await new Promise(resolve => setTimeout(resolve, 100));
    },
    progress: async (id, row, args) => {
      if (row.app !== 'opencode' && !isBackendRow(row, row.app, {})) {
        return readNativeConversationProgress(sourceFor({ app: row.app, windowId: row.windowId }), row, args);
      }
      let base;
      try { base = await overview.overviewPreview(id, { win: row.win, windowId: row.windowId, threadId: row.threadId }) || {}; }
      catch { return { available: false }; }
      const available = base.available === true;
      const result = {
        available,
        busy: !!row.busy,
        waiting: str(row.waiting),
        last: str(base.last),
        statusKnown: available && (row.statusKnown ?? (!!row.busy || !!row.waiting || !!row.run || !!base.run)),
        run: base.run || row.run || null,
        assistantAfter: false,
      };
      if (!available || !args.after_message_id) return result;
      try {
        if (row.app === 'opencode') {
          const openCode = opencodeModule.openCode;
          const current = openCode.chat(row.threadId, { rows: [], tools: new Set(), children: false });
          result.busy = !!current.busy;
          result.waiting = str(current.waiting);
          const rows = openCode.messageRows(row.threadId) || [];
          const at = rows.findIndex(item => str(item.info?.id) === str(args.after_message_id));
          if (at >= 0) result.assistantAfter = rows.slice(at + 1)
            .some(item => item.info?.role === 'assistant' && !item.info?.synthetic);
          result.statusKnown = !!openCode.connected;
          const session = openCode.sessions.get(row.threadId);
          if (session && await sameProject(session.directory, row.workspace)) {
            const lastUser = rows.filter(item => item.info?.role === 'user').at(-1);
            result.lastUserMessageId = str(lastUser?.info?.id);
            result.currentTurn = at >= 0 && lastUser?.info?.id === args.after_message_id;
            const tail = result.currentTurn ? rows.slice(at + 1).filter(item => item.info?.role === 'assistant' && !item.info?.synthetic) : [];
            const reply = tail.at(-1);
            const parts = reply?.parts instanceof Map ? [...reply.parts.values()] : reply?.parts || [];
            result.last = parts.filter(part => part.type === 'text').map(part => part.text || '').join('\n').slice(0, 16000);
            result.completed = ['stop', 'end-turn', 'completed'].includes(reply?.info?.finish) && !reply?.info?.error;
            if (reply?.info?.error) {
              result.error = str(reply.info.error.data?.message || reply.info.error.name || 'native_turn_failed');
              result.run = { id: args.after_message_id, status: 'error' };
            }
            const requests = [
              ...[...openCode.questions.values()].map(request => ({ kind: 'question', request })),
              ...[...openCode.permissions.values()].map(request => ({ kind: 'permission', request })),
            ].filter(item => str(item.request?.sessionID) === str(row.threadId)
              && !isAbortedOpenCodeRequest(item.request, rows, row.threadId));
            const status = openCode.statuses.get(row.threadId);
            const rejectionState = { messages: rows, sessionID: row.threadId, receipt: args.after_message_id,
              idle: openCode.connected && !result.busy && !result.waiting && requests.length === 0 && (!status || status.type === 'idle') };
            result.questionRejection = openCodeQuestionRejection(rejectionState);
            result.permissionRejection = openCodePermissionRejection(rejectionState);
            if (result.questionRejection) result.reason = 'native_question_rejected_without_terminal_reply';
            if (result.permissionRejection) result.reason = 'native_permission_rejected_without_terminal_reply';
            if (requests.length === 1) {
              const { kind, request } = requests[0];
              result.waitingRequest = {
                kind,
                id: str(request.id),
                ...(kind === 'question'
                  ? { questions: Array.isArray(request.questions) ? request.questions : [] }
                  : { permission: str(request.permission),
                      patterns: Array.isArray(request.patterns) ? request.patterns : [] }),
              };
            }
          }
        } else if (str(row.windowId) === CODEX_BACKEND) {
          Object.assign(result, readCodexBackendProgress(codexState.codexBackend, row, args));
        }
      } catch { result.assistantAfter = false; }
      return result;
    },
  };
}

async function resolveDeps(deps) {
  if (deps) return deps;
  realDeps ||= await createRealDeps();
  return realDeps;
}

async function creationWindows(app, project, native, env, reviewer) {
  if (typeof env.windowState !== 'function' || typeof env.createOnView !== 'function') return [];
  const ready = [];
  const targets = (native.targets || []).filter(target => target.app === app && target.ws);
  for (const target of targets) {
    const windowId = str(target.pageId || target.id);
    if (targets.filter(item => str(item.pageId || item.id) === windowId).length !== 1) continue;
    try {
      const state = await env.windowState(target);
      const row = { app, windowId, threadId: str(state.threadId), workspace: str(state.workspace), host: state.host };
      if (!state.workspace || state.creationReady === false || state.host || state.busy || state.waiting || state.draft || state.ambiguous
          || project && !await (env.projectMatches || sameProject)(state.workspace, project)
          || reviewer && !reviewer(row)) continue;
      ready.push({ row, target });
    } catch { /* An unverified window is not reusable. */ }
  }
  return ready;
}

export async function createNativeTaskSession(device, task, auth, deps) {
  const env = await resolveDeps(deps), id = deviceIdOf(device);
  requireScope(auth, ['ra:control']);
  if (!await env.validDevice(id)) fail('device_pairing_revoked');
  if (task.app === 'opencode' && task.project) {
    const reviewer = auth?.allowSession || env.allowSession;
    if (reviewer && !reviewer({ app: task.app, workspace: task.project })) fail('session_not_allowed');
    if (typeof env.createAPISession !== 'function') fail('native_creation_adapter_unavailable');
    try {
      const session = await env.createAPISession(task.project, 'RA MCP Task ' + task.task_id.slice(0, 8));
      if (!session?.id || !await env.projectMatches(session.directory, task.project)) fail('native_session_directory_mismatch');
      return { window_id: task.project, thread_id: session.id, transport: 'opencode:api' };
    } catch (error) { throw Object.assign(error, { outcomeUnknown: true }); }
  }
  if (!NATIVE_STOP_ADAPTERS.has(task.app) || !task.project) fail('invalid_task');
  const native = await env.nativeInfo(id);
  const reviewer = auth?.allowSession || env.allowSession;
  const candidates = await creationWindows(task.app, task.project, native, env, reviewer);
  if (candidates.length !== 1) fail('native_creation_window_missing_or_ambiguous');
  const { row, target } = candidates[0], transport = target.ws;
  const client = Object.assign(new EventEmitter(), { readyState: 1, send() {}, ping(payload) { this.emit('pong', payload); } });
  let created;
  try {
    return await env.withSession(id, client, async view => {
      const release = leaseWindow(task.app, row.windowId, view, true);
      try {
        const { req, windows } = attachRequest(row, task.app, native, false);
        const attached = await view.attach(req, windows);
        if (attached?.trust?.required || view.pendingProject) fail('native_project_context_pending');
        assertBinding(view, row, task.app, false);
        const result = await env.createOnView(view, task);
        if (str(result?.window_id) !== row.windowId || !result?.thread_id) throw Error('binding_mismatch');
        created = { ...result, transport };
        return created;
      } finally { release(); }
    });
  } catch (error) {
    if (created) Object.assign(error, { outcomeUnknown: true, created_session: created });
    throw error;
  }
}

export async function discoverNativeApps(deviceId, allowSession, deps) {
  const env = await resolveDeps(deps);
  const id = deviceIdOf(deviceId);
  if (!await env.validDevice(id)) fail('device_pairing_revoked');
  const reviewer = typeof allowSession === 'function' ? allowSession : env.allowSession;
  const [snapshot, native] = await Promise.all([env.snapshot(id), env.nativeInfo(id)]);
  const rows = (snapshot.sessions || []).filter(row => row && NAMES.includes(row.app)
    && (!reviewer || reviewer(row)));
  const apps = {}, sendable = [];
  for (const app of NAMES) {
    const list = rows.filter(row => row.app === app);
    const sessions = [], limited = [];
    for (const row of list) {
      const verdict = await evaluate(row, app, native, env, id);
      const item = {
        app,
        window_id: str(row.windowId),
        thread_id: str(row.threadId),
        title: str(row.title),
        workspace: str(row.workspace),
        native: verdict.ok,
        backend: !!verdict.backend,
        sendable: verdict.ok && !row.busy && !row.waiting,
        busy: !!row.busy,
        waiting: str(row.waiting),
      };
      if (verdict.ok) sessions.push(item);
      else limited.push({ ...item, reason: verdict.reason });
    }
    const limitations = [];
    if (['cursor', 'devin'].includes(app)) limitations.push('task_busy_submission_receipt_unavailable_use_send_message');
    if (app !== 'opencode' && native.catalogReady && !native.catalogReady(app)) limitations.push('native_catalog_not_ready');
    if (app === 'opencode' && !native.connected) limitations.push('native_api_unavailable');
    if (limited.some(row => row.reason === 'codex_backend_native_owner')) limitations.push('codex_backend_native_owner');
    if (limited.some(row => row.reason === 'codex_backend_unavailable')) limitations.push('codex_backend_unavailable');
    if (limited.some(row => row.reason === 'native_cdp_unavailable')) limitations.push('native_cdp_unavailable');
    if (limited.some(row => row.reason === 'native_window_not_ready')) limitations.push('native_window_not_ready');
    const base = await env.capabilities(app);
    const impl = IMPLEMENTED[app];
    const nativeSessionReady = sessions.length > 0;
    // OpenCode can create an independent task session whenever its native HTTP
    // service is reachable, even if no existing session belongs to this device.
    const canCreateSession = app === 'opencode' ? !!native.connected && impl.create_session
      : (await creationWindows(app, '', native, env, reviewer)).length > 0;
    const canCreateTask = nativeSessionReady || canCreateSession;
    const serviceReady = app === 'opencode' ? !!native.connected : nativeSessionReady || canCreateSession;
    const canSend = nativeSessionReady && impl.send;
    const canCancel = app === 'opencode' ? serviceReady && impl.cancel
      : nativeSessionReady && typeof env.exactCancel === 'function';
    const canApprove = serviceReady && (impl.approve || ['codex', 'cursor', 'devin'].includes(app) && typeof env.preparePermission === 'function');
    // Command decisions stay UNCONFIRMED until their exact native execution item resolves.
    const action = (available, reason) => ({ available: !!available, reason: available ? '' : reason });
    const supported = { create_session: canCreateSession, send: canSend, cancel: canCancel, approve: canApprove };
    const unavailable = Object.keys(impl).filter(key => !supported[key]).map(key => key + '_unavailable');
    if (!serviceReady) unavailable.push('native_service_unavailable');
    apps[app] = {
      app,
      name: APPS[app],
      available: canCreateTask,
      native: nativeSessionReady,
      service_available: serviceReady,
      can_create_session: canCreateSession,
      can_create_task: canCreateTask,
      sessions,
      limited,
      limitations,
      actions: Object.freeze({
        create_task: action(canCreateTask, 'create_task_no_native_session'),
        create_session: action(canCreateSession, 'create_session_adapter_unavailable'),
        send: action(canSend, 'send_adapter_unavailable'),
        cancel: action(canCancel, 'native_cancel_adapter_unavailable'),
        approve: action(canApprove, 'native_approval_adapter_unavailable'),
      }),
      unavailable,
      task_submission_modes: app === 'codex' ? ['idle', 'queue', 'now'] : ['idle'],
      capabilities: Object.freeze({
        ...base,
        send: canSend,
        read: list.length > 0,
        progress: nativeSessionReady,
        create_task: canCreateTask,
        create_session: canCreateSession,
        cancel: canCancel,
        approve: canApprove,
        model: nativeSessionReady && !!base.model,
        effort: nativeSessionReady && !!base.effort,
        fast: nativeSessionReady && !!base.fast,
        queue: nativeSessionReady && !!base.queue,
        steer: nativeSessionReady && !!base.steer,
        // Native registry support does not imply this MCP exposes the action;
        // override registry approval/question flags with real adapter support.
        approvals: canApprove,
        questions: app === 'opencode' && canApprove || ['codex', 'cursor', 'devin'].includes(app) && serviceReady && typeof env.prepareQuestion === 'function',
      }),
    };
    sendable.push(...sessions.filter(item => item.sendable));
  }
  return {
    device: id,
    ready: !!snapshot.ready,
    pending_windows: Number(snapshot.pendingWindows) || 0,
    apps,
    sessions: sendable,
  };
}

async function withNativeControl(device, args, auth, options, action, deps) {
  const env = await resolveDeps(deps), id = deviceIdOf(device);
  requireScope(auth, options.readOnly ? ['ra:read', 'ra:control'] : ['ra:control']);
  const sel = selectArgs(args), requestId = str(args.operation_id) || await env.newRequestId();
  const reviewer = typeof auth?.allowSession === 'function' ? auth.allowSession : env.allowSession;
  const { row, native, verdict } = args.created_session
    ? await selectCreatedSession(id, sel, env, reviewer, args)
    : await selectSession(id, sel, env, reviewer, args.project_path);
  const events = [], client = Object.assign(new EventEmitter(), { readyState: 1,
    send(raw) { const message = JSON.parse(raw); events.push(message); },
    ping(payload) { this.emit('pong', payload); } });
  const { req, windows } = attachRequest(row, sel.app, native, verdict.backend);
  let started = false;
  try { return await env.withSession(id, client, async view => {
    view.visible = view.notifyVisible = false;
    view.controlAuthorization = async () => {
      if (!await env.validDevice(id)) fail('device_pairing_revoked');
      if (reviewer && !reviewer(row)) fail('session_not_allowed');
    };
    const release = !verdict.backend && sel.app !== 'opencode' ? leaseWindow(sel.app, sel.windowId, view, true) : () => {};
    try {
      const attached = await view.attach(req, windows);
      if (attached?.trust?.required || view.pendingProject) fail('native_project_context_pending');
      assertBinding(view, row, sel.app, verdict.backend);
      if (!verdict.backend && sel.app !== 'opencode') {
        if (typeof env.prepareView !== 'function') fail('native_selection_adapter_unavailable');
        await env.prepareView(view, row, args.project_path || row.workspace, options);
        assertBinding(view, row, sel.app, false);
      }
      if (sel.app === 'opencode' && !options.allowBusy) await env.prepareAPIView(row);
      // Recheck authorization and the transport after attaching/selecting.
      const current = await selectSession(id, sel, env, reviewer, args.project_path);
      if (current.verdict.backend !== verdict.backend || current.verdict.target?.ws !== verdict.target?.ws)
        fail('native_window_context_changed');
      return await runAgentControl(view, () => { started = true; return action({ view, row, verdict, env, events, requestId, sel }); });
    } finally { release(); }
  }); } catch (error) {
    if (error.outcomeUnknown === undefined) error.outcomeUnknown = started && !options.readOnly;
    throw error;
  }
}

export async function controlNativeSession(device, args, auth, deps) {
  if (['session_actions', 'manage_session'].includes(args.action)) {
    const env = await resolveDeps(deps), id = deviceIdOf(device), sel = selectArgs(args);
    requireScope(auth, args.action === 'session_actions' ? ['ra:read', 'ra:control'] : ['ra:control']);
    const { row } = await selectSession(id, sel, env, auth?.allowSession || env.allowSession);
    if (typeof env.manageSession !== 'function') fail('native_operation_unsupported');
    const action = args.action === 'session_actions' ? 'actions' : args.session_action;
    if (args.action === 'manage_session' && !['rename', 'archive', 'delete'].includes(action)) fail('native_operation_unsupported');
    if (action === 'rename' && !str(args.name).trim()) fail('invalid_name');
    try { return await env.manageSession(id, row, action, args.name); }
    catch (error) { throw Object.assign(error, { outcomeUnknown: args.action === 'manage_session' }); }
  }
  const readOnly = ['read_setting', 'read_queue'].includes(args.action);
  return withNativeControl(device, args, auth, { readOnly, allowBusy: true, preserveDraft: true },
    async ({ view, events, requestId, env }) => {
      if (args.action === 'read_setting') return readAgentSetting(view, args.kind, events, requestId);
      if (args.action === 'set_setting') return setAgentSetting(view, args.kind, args.value, events, requestId);
      const caps = await env.capabilities(view.app);
      if (!caps.queue) fail('native_operation_unsupported');
      if (args.action === 'read_queue') {
        if (view.codexBackend || view.app === 'opencode') await view.handle({ t: 'refresh' });
        else await view.pollChat(true, true);
        const chat = events.findLast(message => message.t === 'chat' && message.sel === view.selectionKey());
        if (!chat) fail('native_receipt_missing');
        return { selection: view.selectionKey(), queued: chat.chat?.queued || [] };
      }
      if (args.action === 'queue') {
        if (!['read', 'edit', 'send', 'remove'].includes(args.queue_action)) fail('native_operation_unsupported');
        if (args.queue_action === 'edit' && !str(args.text).trim()) fail('invalid_text');
        try {
          const value = await executeAgentControl(view, { action: 'queue', requestId,
            message: { action: args.queue_action, id: args.queue_id, text: args.text } });
          return { ...value, state: 'ACKNOWLEDGED' };
        } catch (error) { throw Object.assign(error, { outcomeUnknown: args.queue_action !== 'read' }); }
      }
      fail('native_operation_unsupported');
    }, deps);
}

export async function sendNativeMessage(device, args, auth, deps) {
  selectArgs(args, true);
  const when = args.when || 'idle';
  assertSendMode(args.app, when);
  return withNativeControl(device, args, auth, { allowBusy: ['now', 'queue'].includes(when) },
    async ({ view, row, verdict, env, events, requestId, sel }) => {
      for (const kind of ['model', 'effort', 'fast']) if (args[kind])
        await setAgentSetting(view, kind, args[kind], events, requestId);
      try {
        await executeAgentControl(view, { action: 'send', text: args.message, when, requestId });
        if (typeof env.waitForAck === 'function') await env.waitForAck(events, requestId);
      } catch (error) { throw Object.assign(error, { outcomeUnknown: error.outcomeUnknown ?? true }); }
      let outcome = ackResult(events.filter(event => str(event.requestId) === requestId), requestId, sel);
      if (args.capture_native_submission === true && sel.app === 'codex' && !verdict.backend && outcome.state === 'ACKNOWLEDGED' && !outcome.queued) {
        try {
          if (typeof env.readSubmission !== 'function') fail('native_submission_receipt_unavailable');
          outcome.native_submission = await env.readSubmission(row, outcome.native_message_id, args.message);
          if (!outcome.native_submission) fail('native_submission_receipt_unverifiable');
        } catch (error) {
          outcome = { ...outcome, state: 'UNKNOWN', reason: error.code || error.message || 'native_submission_receipt_unverifiable' };
        }
      }
      if (when === 'now' && outcome.queued) outcome = { ...outcome, state: 'UNKNOWN', reason: 'native_immediate_send_unconfirmed_still_queued' };
      return outcome;
    }, deps);
}

export async function readNativeProgress(device, args, deps) {
  const env = await resolveDeps(deps);
  const id = deviceIdOf(device);
  requireScope(args?.auth, ['ra:read', 'ra:control']);
  const sel = selectArgs(args);
  const reviewer = typeof args?.auth?.allowSession === 'function' ? args.auth.allowSession : env.allowSession;
  let selected;
  try { selected = await selectSession(id, sel, env, reviewer, args.project_path); }
  catch (error) {
    return { app: sel.app, window_id: sel.windowId, thread_id: sel.threadId, available: false,
      busy: false, waiting: '', last_reply: '', status_known: false, assistant_after: false,
      can_confirm_completion: false, waiting_request: null, approval_available: false,
      last_user_message_id: '', reason: sel.app === 'opencode' && error.status === 404 ? 'native_session_missing' : error.code || 'session_unavailable' };
  }
  let submission = args.expected_native_submission;
  if (sel.app === 'codex' && !selected.verdict.backend && args.native_queued && !submission) {
    try { submission = await env.readSubmission(selected.row, args.after_message_id, args.expected_prompt); }
    catch { return { available: true, busy: true, waiting: '', last_reply: '', can_confirm_completion: false,
      current_turn: false, reason: 'native_queue_promotion_unconfirmed' }; }
  }
  let info;
  try { info = await env.progress(id, selected.row, { ...args, expected_native_submission: submission }) || {}; }
  catch (error) { info = { reason: error.code || 'native_info_unavailable' }; }
  const available = info.available === true;
  const busy = available && !!info.busy;
  const waiting = available ? str(info.waiting) : '';
  const waitingRequest = verifiableWaitingRequest(info, sel.app);
  const statusKnown = available && !!info.statusKnown && !runIsRunning(info.run);
  const correlated = available && !!args.after_message_id && !!info.assistantAfter
    && (info.currentTurn === true || info.exactCompletion === true);
  return {
    app: sel.app,
    window_id: sel.windowId,
    thread_id: sel.threadId,
    ...(submission ? { native_submission: submission } : {}),
    available,
    busy,
    waiting,
    last_reply: available && correlated ? str(info.last).slice(0, 16000) : '',
    status_known: statusKnown,
    assistant_after: correlated,
    current_turn: available && info.currentTurn === true,
    exact_completion: available && info.exactCompletion === true,
    can_confirm_failure: statusKnown && !busy && (info.currentTurn === true || info.exactFailure === true)
      && !!args.after_message_id && info.lastUserMessageId === args.after_message_id && ['error', 'failed'].includes(info.run?.status),
    native_error: str(info.error).slice(0, 2000),
    ...(args.native_queued && info.currentTurn === true ? { native_queued: false } : {}),
    can_confirm_completion: statusKnown && !busy && !waiting && !waitingRequest && correlated
      && info.completed === true && !!str(info.last).trim(),
    can_confirm_cancellation: statusKnown && !busy && !waiting && !waitingRequest
      && info.cancelled === true && (info.currentTurn === true || sel.app === 'codex' && info.exactCancellation === true)
      && !!args.after_message_id
      && info.lastUserMessageId === args.after_message_id,
    waiting_request: waitingRequest,
    native_question_rejection: available && info.currentTurn === true ? info.questionRejection || null : null,
    native_permission_rejection: available && info.currentTurn === true ? info.permissionRejection || null : null,
    ...(available && info.commandApproval ? { native_command_approval: info.commandApproval } : {}),
    approval_available: !!waitingRequest && (IMPLEMENTED[sel.app]?.approve === true
      || sel.app === 'codex' && selected.verdict.backend && typeof env.prepareBackendInteraction === 'function'
      || ['codex', 'cursor', 'devin'].includes(sel.app) && waitingRequest.kind === 'question' && typeof env.prepareQuestion === 'function'
      || ['codex', 'cursor', 'devin'].includes(sel.app) && !selected.verdict.backend && waitingRequest.kind === 'permission' && typeof env.preparePermission === 'function'),
    last_user_message_id: str(info.lastUserMessageId),
    ...(info.nativeTurnId !== undefined ? { native_turn_id: info.nativeTurnId } : {}),
    reason: available ? (info.reason || (correlated || info.cancelled === true || waitingRequest && info.currentTurn === true ? '' : 'no_native_send_correlation')) : (info.reason || 'native_info_unavailable'),
    ...(info.run ? { run: info.run } : {}),
  };
}

async function openCodeTaskControl(device, task, auth, operation, options = {}, deps) {
  return withNativeControl(device, { app: task.app, window_id: task.window_id, thread_id: task.thread_id,
    project_path: task.project, operation_id: task.task_id }, auth, { allowBusy: true, preserveDraft: true },
  async ({ view, env, requestId }) => {
    const native = env.openCode;
    if (!native) fail('native_api_unavailable');
    await native.loadMessages(task.thread_id, undefined, AbortSignal.timeout(10000));
    const user = native.messageRows(task.thread_id).findLast(row => row.info?.role === 'user');
    const parts = user?.parts instanceof Map ? [...user.parts.values()] : user?.parts || [];
    if (user?.info?.id !== task.native_message_id || parts.filter(part => part.type === 'text' && !part.synthetic).map(part => part.text || '').join('\n') !== task.prompt)
      fail('native_turn_changed');
    if (operation === 'stop') {
      if (options.checkOnly) return { supported: true };
      const result = await executeAgentControl(view, { action: 'stop', requestId });
      return { supported: true, state: result.value === true ? 'ACKNOWLEDGED' : 'UNKNOWN', basis: 'native_exact_message_abort' };
    }
    const fresh = await native.client.request('/' + options.kind, { directory: task.project, signal: AbortSignal.timeout(10000) });
    const request = Array.isArray(fresh) && fresh.find(row => row.id === options.request_id && row.sessionID === task.thread_id);
    if (!request || JSON.stringify(request) !== JSON.stringify(options.native_request)) fail('native_request_changed');
    const requests = options.kind === 'permission' ? native.permissions : native.questions;
    requests.set(request.id, request);
    const result = await executeAgentControl(view, { action: options.kind, id: request.id,
      decision: options.decision, answers: options.answers, requestId });
    return result.value;
  }, deps);
}

export async function prepareNativeTaskApproval(device, task, options, auth, deps) {
  const env = await resolveDeps(deps), id = deviceIdOf(device);
  requireScope(auth, ['ra:control']);
  if (task.device !== id) fail('task_not_found');
  if (task.app === 'opencode') {
    if (task.state !== 'WAITING' || task.pending?.id !== options.request_id || task.pending?.kind !== options.kind) fail('native_approval_not_current');
    return { submit: () => openCodeTaskControl(device, task, auth, 'answer', options, deps) };
  }
  const question = ['codex', 'cursor', 'devin'].includes(task.app) && task.pending?.kind === 'question';
  const permission = ['codex', 'cursor', 'devin'].includes(task.app) && task.pending?.kind === 'permission';
  if ((!question && !permission) || task.pending.id !== options.request_id || task.pending.kind !== options.kind && options.kind !== undefined
      || task.state !== 'WAITING' || !task.project) fail('native_approval_not_current');
  if (!task.native_message_id || !task.native_request_id || task.native_request_id !== task.task_id)
    fail('native_receipt_task_mismatch');
  const { row, verdict } = await selectSession(id, { app: task.app, windowId: task.window_id, threadId: task.thread_id },
    env, auth?.allowSession || env.allowSession, task.project);
  if (verdict.backend) {
    if (typeof env.prepareBackendInteraction !== 'function') fail('native_approval_adapter_unavailable');
    const beforeAction = async () => {
      const current = await selectSession(id, { app: task.app, windowId: task.window_id, threadId: task.thread_id },
        env, auth?.allowSession || env.allowSession, task.project);
      if (!current.verdict.backend) fail('native_window_context_changed');
    };
    const submit = await env.prepareBackendInteraction(row, task.native_message_id, task.pending, { ...options, prompt: task.prompt, beforeAction });
    return { submit };
  }
  const prepare = question ? env.prepareQuestion : env.preparePermission;
  if (typeof prepare !== 'function') fail('native_approval_adapter_unavailable');
  const release = leaseWindow(task.app, row.windowId, {}, true);
  try {
    const windowTransport = verdict.target?.ws;
    const beforeAction = async () => {
      // Pairing and the exact window transport can change after preflight.
      const current = await selectSession(id, { app: task.app, windowId: task.window_id, threadId: task.thread_id },
        env, auth?.allowSession || env.allowSession, task.project);
      if (current.verdict.target?.ws !== windowTransport) fail('native_window_context_changed');
    };
    const submit = await prepare(row, task.native_message_id, task.pending, { ...options, prompt: task.prompt, submission: task.native_submission, beforeAction });
    return { submit, release };
  } catch (error) { release(); throw error; }
}

export const prepareNativeTaskQuestion = prepareNativeTaskApproval;

export async function cancelNativeTask(device, task, options = {}, deps) {
  const env = await resolveDeps(deps);
  const id = deviceIdOf(device);
  if (!await env.validDevice(id)) fail('device_pairing_revoked');
  if (!task || typeof task !== 'object' || Array.isArray(task)) fail('invalid_task');
  requireScope(options.auth, ['ra:control']);
  const app = str(task.app), windowId = str(task.window_id), threadId = str(task.thread_id);
  if (!NAMES.includes(app)) fail('invalid_app');
  if (!windowId || !threadId) fail('task_native_session_incomplete');
  const project = str(task.project);
  if (!project) fail('task_project_missing');
  const receipt = str(task.native_message_id);
  if (!receipt || receipt.length > 300 || /[\0\r\n]/.test(receipt)) fail('native_receipt_missing');
  const expectedRequest = str(task.native_request_id);
  if (expectedRequest && expectedRequest !== str(task.task_id)) fail('native_receipt_task_mismatch');
  const acp = app === 'devin' && /^acp\d+$/.test(receipt);
  const exact = acp || app === 'codex';
  if (exact && (task.device !== id || !expectedRequest || expectedRequest !== task.task_id)) fail('native_receipt_task_mismatch');
  if (exact && (typeof task.prompt !== 'string' || !task.prompt.trim())) fail('native_cancel_prompt_missing');
  if (exact && !options.checkOnly && (!options.binding?.native || !options.binding.transport)) fail('native_cancel_binding_missing');
  const base = { app, window_id: windowId, thread_id: threadId, request_id: receipt };
  if (app === 'opencode') return openCodeTaskControl(device, task, options.auth, 'stop', options, deps);
  if (!NATIVE_STOP_ADAPTERS.has(app)) return { ...base, supported: false, reason: 'native_cancel_adapter_unavailable' };
  const { row, verdict } = await selectSession(id, { app, windowId, threadId }, env,
    options.auth?.allowSession || env.allowSession, project);
  if (!await env.projectMatches(row.workspace, project)) fail('task_project_mismatch');
  if (typeof env.exactCancel !== 'function')
    return { ...base, supported: false, reason: 'native_cancel_adapter_unavailable' };
  const transport = verdict.backend ? CODEX_BACKEND : verdict.target?.ws;
  if (exact && options.binding && options.binding.transport !== transport) fail('native_window_context_changed');
  const release = leaseWindow(app, windowId, {}, true);
  try {
    const beforeStop = async () => {
      const current = await selectSession(id, { app, windowId, threadId }, env,
        options.auth?.allowSession || env.allowSession, project);
      if ((current.verdict.backend ? CODEX_BACKEND : current.verdict.target?.ws) !== transport) fail('native_window_context_changed');
    };
    const result = await env.exactCancel(row, receipt, !!options.checkOnly, {
      prompt: task.prompt, submission: task.native_submission, binding: exact ? options.binding?.native : undefined, beforeStop,
    });
    if (result?.supported !== true) return { ...base, supported: false, reason: result?.reason || 'native_cancel_adapter_unavailable' };
    if (options.checkOnly) return { ...base, supported: true,
      ...(exact ? { binding: { native: result.binding, transport, turnId: result.turnId } } : {}) };
    return { ...base, supported: true, state: result?.state === 'ACKNOWLEDGED' ? 'ACKNOWLEDGED' : 'UNKNOWN',
      reason: result?.reason || '', basis: result?.basis || '' };
  } catch (error) {
    if (options.checkOnly) throw error;
    return { ...base, supported: true, state: 'UNKNOWN', reason: error.code || error.message || 'native_stop_outcome_unknown' };
  } finally { release(); }
}
