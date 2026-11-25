import { resolveRoute, flag } from '../routes.mjs';
import { computerId } from '../../lib/auth.mjs';
import { manageOverviewSession } from '../overview-actions.mjs';
import { codexBackend } from '../codex/state.mjs';
import { ConversationRef } from '../session/binding.mjs';
import { AGENT_REGISTRY } from '../apps/index.mjs';

// Shared by phone Session dispatch and structured clients. Selection, ownership,
// serialization and window leases remain in Session.handle.
export function dispatchAgentControl(session, message, route = resolveRoute(session, message.t)) {
  const fusionFree = session.app === 'fusion' && flag(route?.fusionFree, session, message);
  if (fusionFree) {
    if (route.fusion) return route.fusion(session, message);
  } else if (!session.cdp && session.app !== 'opencode' && !session.codexBackend)
    throw new Error(session.appMessage('尚未连接到 {app} 窗口'));
  if (!route) throw new Error(`未知指令: ${message.t}`);
  return route.run(session, message);
}

export async function executeAgentControl(session, operation) {
  const { action, requestId } = operation;
  const sel = session.selectionKey();
  let message;
  switch (action) {
    case 'send': message = { t: 'send', text: operation.text, submit: true, when: operation.when, requestId, sel }; break;
    case 'read_setting': message = { t: 'openMenu', kind: operation.kind, requestId, sel }; break;
    case 'set_setting': message = { t: 'pickMenu', kind: operation.kind, label: operation.label, name: operation.name, requestId, sel }; break;
    case 'stop': message = { t: 'stop', requestId, sel }; break;
    case 'permission': message = { t: 'click', item: 'permission:' + operation.id, actionId: operation.decision, requestId, sel }; break;
    case 'question': message = { t: 'opencodeQuestion', id: operation.id, answers: operation.answers, reject: operation.decision === 'reject', requestId, sel }; break;
    case 'queue': message = { t: 'queue', ...operation.message, requestId, sel }; break;
    default: throw Object.assign(new Error('native_operation_unsupported'), { outcomeUnknown: false });
  }
  await session.controlAuthorization?.();
  const value = await session.handle(message);
  if (session.selectionKey() !== sel) throw new Error('binding_mismatch');
  return { action, selection: sel, value };
}

export function runAgentControl(session, action) {
  if (!session.codexBackend) return action();
  const binding = ConversationRef.capture(session);
  return codexBackend.runCommand(binding.threadId, async () => {
    binding.assertCurrent(session);
    session.agentControlCommand = binding.threadId;
    try { return await action(); }
    finally { delete session.agentControlCommand; }
  });
}

export function assertSendMode(app, when = '') {
  if (!['', 'idle', 'now', 'queue'].includes(when)) throw Object.assign(new Error('invalid_when'), { outcomeUnknown: false });
  const caps = AGENT_REGISTRY[app]?.capabilities;
  if (when === 'now' && !caps?.steer || when === 'queue' && !caps?.queue)
    throw Object.assign(new Error('native_operation_unsupported'), { outcomeUnknown: false });
}

// Menus, choices and mutations are the phone's existing native paths. The
// caller supplies events from its own Session connection, never another view.
export async function readAgentSetting(session, kind, events, requestId) {
  if (!['model', 'effort', 'fast'].includes(kind) || !AGENT_REGISTRY[session.app]?.capabilities[kind])
    throw Object.assign(new Error('native_operation_unsupported'), { outcomeUnknown: false });
  const from = events.length, menuKind = kind === 'fast' && session.app !== 'codex' ? 'model' : kind;
  await executeAgentControl(session, { action: 'read_setting', kind: menuKind, requestId });
  const menu = events.slice(from).findLast(row => row.t === 'menu' && row.kind === menuKind
    && row.requestId === requestId && row.sel === session.selectionKey());
  if (!menu) throw Object.assign(new Error('native_settings_receipt_unconfirmed'), { outcomeUnknown: false });
  let items = menu.items || [];
  if (kind === 'fast' && session.app !== 'codex') {
    if (!menu.fast || menu.fast.supported === false) throw Object.assign(new Error('native_operation_unsupported'), { outcomeUnknown: false });
    items = ['off', 'on'].map(label => ({ label, checked: menu.fast.on === (label === 'on') }));
  }
  return { kind, items: items.filter(row => row.id !== '__codex_default__').map(row => ({
    ...row, value: row.id === null ? 'default' : String(row.id ?? row.label),
  })), model: menu.model, fast: menu.fast, selection: session.selectionKey() };
}

export async function setAgentSetting(session, kind, value, events, requestId) {
  const before = await readAgentSetting(session, kind, events, requestId);
  const candidates = before.items.filter(item => !item.disabled && (item.value === value || item.label === value
    || kind === 'fast' && (value === 'on' && item.icon === 'fast' || value === 'off' && item.id === null)));
  if (candidates.length !== 1) throw Object.assign(new Error('native_setting_not_available'), { outcomeUnknown: false });
  const [choice] = candidates;
  try {
    await executeAgentControl(session, { action: 'set_setting', kind, label: choice.label,
      name: choice.id == null ? '' : String(choice.id), requestId });
    const after = await readAgentSetting(session, kind, events, requestId);
    if (!after.items.some(item => item.value === choice.value && item.checked))
      throw Object.assign(new Error('native_settings_receipt_unconfirmed'), { outcomeUnknown: false });
    return { ...after, state: 'CONFIRMED', applies_to: 'next_submission' };
  } catch (error) { throw Object.assign(error, { outcomeUnknown: true }); }
}

export function manageAgentSession(deviceId, row, action, name) {
  if (!['actions', 'rename', 'archive', 'delete'].includes(action)) throw Object.assign(new Error('native_operation_unsupported'), { outcomeUnknown: false });
  return manageOverviewSession(deviceId, { computer: computerId(), win: row.win || row.app,
    windowId: row.windowId, threadId: row.threadId, action, name });
}
