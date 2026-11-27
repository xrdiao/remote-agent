import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../../lib/auth.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { definitions, checkArgs, runTool } from './tools.mjs';
import { getStoredTask } from './tasks.mjs';
import { publicErrorCode } from './errors.mjs';

const byAction = new Map(definitions.map(def => [def.name, def]));
const read = definitions.filter(def => def.annotations.readOnlyHint === true).map(def => def.name);
const control = definitions.filter(def => def.annotations.readOnlyHint === false).map(def => def.name);
if (read.length + control.length !== byAction.size || byAction.size !== definitions.length || byAction.has('describe'))
  throw new Error('invalid_mcp_action_registry');

const taskActions = new Set(['create_task', 'submit_task']);
const requestId = { type: 'string', pattern: '^[A-Za-z0-9_.:-]{1,160}$' };
const operationIdPattern = new RegExp(byAction.get('operation_status').inputSchema.properties.operation_id.pattern);
const policy = { type: 'string', enum: ['reuse', 'new'], default: 'reuse' };
const wait = { type: 'integer', minimum: 0, maximum: 25000, default: 0 };
const descriptionParams = {
  type: 'object', additionalProperties: false, required: [],
  properties: { action: { type: 'string', enum: [...read, ...control] } },
};

function schemaFor(def) {
  const input = def.inputSchema;
  const properties = { ...input.properties };
  let required = [...input.required];
  if (!def.annotations.readOnlyHint) {
    properties.client_request_id = requestId;
    required = required.filter(key => key !== 'operation_id');
  }
  if (taskActions.has(def.name)) {
    properties.session_policy = policy;
    properties.continue_task_id = { ...input.properties.operation_id };
  }
  if (def.name === 'get_task') properties.wait_ms = wait;
  return { ...input, properties, required };
}

function signature(def) {
  const input = schemaFor(def);
  return def.name + '(' + Object.keys(input.properties)
    .filter(key => def.annotations.readOnlyHint || !['operation_id', 'client_request_id'].includes(key))
    .map(key => key + (input.required.includes(key) ? '' : '?')).join(',') + ')';
}

export const compactDefinitions = [true, false].map(readOnlyHint => {
  const actions = readOnlyHint ? read : control;
  const entries = actions.map(name => signature(byAction.get(name)));
  const securitySchemes = [{ type: 'oauth2', scopes: [readOnlyHint ? 'ra:read' : 'ra:control'] }];
  const summary = readOnlyHint
    ? 'Read native Remote Agent data. Use describe(action?) to inspect action details.'
    : 'Control Remote Agent. Use ra_read describe for exact schemas. Prefer stable client_request_id or operation_id for retries; never repeat UNKNOWN under a new ID. Only session_policy=new creates a session.';
  return {
    name: readOnlyHint ? 'ra_read' : 'ra_control',
    description: summary + ' ' + entries.join(' | '),
    securitySchemes,
    _meta: { securitySchemes },
    annotations: { readOnlyHint, destructiveHint: !readOnlyHint, idempotentHint: readOnlyHint, openWorldHint: true },
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { action: { type: 'string', enum: readOnlyHint ? [...actions, 'describe'] : actions }, params: { type: 'object' } },
      required: readOnlyHint ? ['action'] : ['action', 'params'],
    },
  };
});

const scopes = value => String(value || '').split(/\s+/);
export const hasControl = scope => scopes(scope).includes('ra:control');
const hasRead = scope => hasControl(scope) || scopes(scope).includes('ra:read');
const obj = value => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (code, fields) => { throw Object.assign(new Error(code), { fields }); };
const active = task => ['RUNNING', 'ACKNOWLEDGED', 'STARTING', 'CREATED', 'SUBMITTING'].includes(task.state)
  && !task.pending && !task.waiting;
const readsInFlight = new Map();
const waitingByDevice = new Map();
let waiterCount = 0;

async function pollTask(access, args, ms, signal, authorized) {
  const key = access.device.id + '\0' + args.task_id;
  const count = waitingByDevice.get(access.device.id) || 0;
  if (count >= 4 || waiterCount >= 24) fail('task_poll_busy');
  waitingByDevice.set(access.device.id, count + 1);
  waiterCount++;
  const deadline = performance.now() + ms;
  const controller = new AbortController();
  const stop = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const recheck = () => {
    if (signal?.aborted) fail('request_cancelled');
    if (!authorized()) fail('device_pairing_revoked');
  };
  try {
    let snapshot;
    while (true) {
      recheck();
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      let pending = readsInFlight.get(key);
      if (!pending) {
        if (readsInFlight.size >= 24 || [...readsInFlight.keys()].filter(value => value.startsWith(access.device.id + '\0')).length >= 4)
          fail('task_poll_busy');
        const readOnce = runTool(access.device, access.scope, 'get_task', args);
        pending = readOnce.finally(() => readsInFlight.delete(key));
        readsInFlight.set(key, pending);
      }
      // Periodic auth checks are independent of the native read duration.
      while (!snapshot || active(snapshot)) {
        const budget = Math.max(0, Math.min(250, deadline - performance.now()));
        const reply = await Promise.race([pending.then(task => ({ task })),
          delay(budget, null, { signal: stop })]);
        recheck();
        if (reply) { snapshot = reply.task; break; }
        if (deadline <= performance.now()) break;
      }
      if (snapshot && !active(snapshot)) return snapshot;
      if (deadline <= performance.now()) break;
      await delay(Math.max(0, Math.min(400, deadline - performance.now())), null, { signal: stop });
    }
    recheck();
    return { ...(snapshot || getStoredTask(access.device, args.task_id)),
      timed_out: true, ...(snapshot ? {} : { fresh: false }) };
  } finally {
    controller.abort();
    waiterCount--;
    const remaining = waitingByDevice.get(access.device.id) - 1;
    if (remaining) waitingByDevice.set(access.device.id, remaining);
    else waitingByDevice.delete(access.device.id);
  }
}

function reserveRequestId(access, action, clientRequestId, args, explicit, options) {
  const { operation_id: proposed, ...parameters } = args;
  if (!clientRequestId) return proposed;
  const digest = createHash('sha256').update(JSON.stringify([
    'remote-agent-mcp-operation-v2', access.client, access.device.id, action, clientRequestId,
  ])).digest('hex');
  const fingerprint = createHash('sha256').update(JSON.stringify([
    parameters, ...(taskActions.has(action) ? [options.sessionPolicy, options.continuation ?? null] : []),
  ])).digest('hex');
  const directory = path.join(DATA_DIR, 'ra-mcp-request-ids-v2');
  const target = path.join(directory, digest);
  const binding = () => {
    const saved = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (typeof saved?.id !== 'string' || !operationIdPattern.test(saved.id) || !/^[a-f0-9]{64}$/.test(saved.fingerprint))
      fail('operation_receipt_unconfirmed');
    if (saved.fingerprint !== fingerprint || explicit && saved.id !== proposed)
      throw Object.assign(Error('operation_id_conflict'), { operationId: saved.id });
    return saved.id;
  };
  try { return binding(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}$/.test(name)).length >= 3000)
    fail('operation_journal_capacity');
  const tmp = target + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({ id: proposed, fingerprint }), { mode: 0o600, flag: 'wx' });
    try { fs.linkSync(tmp, target); }
    catch (error) {
      if (error.code === 'EEXIST') return binding();
      throw error;
    }
    return proposed;
  } finally { fs.rmSync(tmp, { force: true }); }
}

function parameterError(input, params) {
  if (!obj(params) || Object.keys(params).some(key => !Object.hasOwn(input.properties, key)))
    fail('invalid_args');
  const missing = input.required.filter(key => !Object.hasOwn(params, key));
  if (missing.length) fail('missing_required_argument', missing);
}

function resultPacket(payload, error = false) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: error,
    ...(error ? { structuredContent: payload } : {}) };
}

function candidateReferences(code, candidates) {
  if (code !== 'ambiguous_reusable_session' || !Array.isArray(candidates)) return {};
  const fields = byAction.get('submit_task').inputSchema.properties;
  const isReference = (value, field) => typeof value === 'string' && value.trim() !== ''
    && value.length <= fields[field].maxLength && !/[\x00-\x1f\x7f]/.test(value)
    && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value) && !/^file:/i.test(value);
  return { candidates: candidates.slice(0, 20).filter(candidate => obj(candidate)
    && fields.app.enum.includes(candidate.app)
    && isReference(candidate.window_id, 'window_id') && isReference(candidate.thread_id, 'thread_id'))
    .map(({ app, window_id, thread_id }) => ({ app, window_id, thread_id })) };
}

function safeReceipt(row) {
  const { candidates, ...receipt } = row;
  const code = row.error && publicErrorCode(Error(row.error));
  return { ...receipt, ...(code ? { error: code } : {}), ...candidateReferences(code, candidates),
    ...(obj(row.result) && row.result.error ? { result: safeReceipt(row.result) } : {}) };
}

export async function dispatchCompact(access, name, envelope, { signal, authorized = () => true } = {}) {
  let def, inputSchema, id, describedAction;
  try {
    const reading = name === 'ra_read';
    if (!reading && name !== 'ra_control') fail('tool_not_found');
    if (reading ? !hasRead(access.scope) : !hasControl(access.scope)) fail('scope_required');
    if (!obj(envelope) || Object.keys(envelope).some(key => key !== 'action' && key !== 'params')) fail('invalid_args');
    const { action } = envelope;
    if (!Object.hasOwn(envelope, 'action')) fail('missing_required_argument', ['action']);
    if (reading && action === 'describe') {
      describedAction = 'describe';
      inputSchema = descriptionParams;
      const params = Object.hasOwn(envelope, 'params') ? envelope.params : {};
      parameterError(descriptionParams, params);
      if (!Object.hasOwn(params, 'action')) return resultPacket({ actions: definitions.map(entry => ({
        action: entry.name, signature: signature(entry), readOnlyHint: entry.annotations.readOnlyHint,
      })) });
      const described = byAction.get(params.action);
      if (!described) fail('unknown_action', ['action']);
      return resultPacket({ action: described.name, description: described.description,
        readOnlyHint: described.annotations.readOnlyHint, inputSchema: schemaFor(described) });
    }
    const selected = byAction.get(action);
    if (!selected || selected.annotations.readOnlyHint !== reading) fail('unknown_action', ['action']);
    def = selected;
    inputSchema = schemaFor(def);
    if (!reading && !Object.hasOwn(envelope, 'params')) fail('missing_required_argument', ['params']);
    const params = Object.hasOwn(envelope, 'params') ? envelope.params : {};
    parameterError(inputSchema, params);
    const args = Object.fromEntries(Object.keys(def.inputSchema.properties)
      .filter(key => Object.hasOwn(params, key)).map(key => [key, params[key]]));
    const clientRequestId = params.client_request_id;
    if (Object.hasOwn(params, 'client_request_id') && (typeof clientRequestId !== 'string' || !new RegExp(requestId.pattern).test(clientRequestId)))
      fail('invalid_client_request_id', ['client_request_id']);
    const sessionPolicy = Object.hasOwn(params, 'session_policy') ? params.session_policy : 'reuse';
    if (!policy.enum.includes(sessionPolicy)) fail('invalid_session_policy', ['session_policy']);
    if (Object.hasOwn(params, 'continue_task_id') && (typeof params.continue_task_id !== 'string'
        || !new RegExp(def.inputSchema.properties.operation_id.pattern).test(params.continue_task_id)))
      fail('invalid_continue_task_id', ['continue_task_id']);
    const ms = Object.hasOwn(params, 'wait_ms') ? params.wait_ms : 0;
    if (!Number.isInteger(ms) || ms < 0 || ms > wait.maximum) fail('invalid_wait_ms', ['wait_ms']);
    const explicit = Object.hasOwn(args, 'operation_id');
    if (!reading && !explicit) args.operation_id = randomUUID();
    checkArgs(def, args);
    if (!authorized()) fail('device_pairing_revoked');
    const options = { compact: true, sessionPolicy, continuation: params.continue_task_id };
    if (!reading) args.operation_id = id = reserveRequestId(access, action, clientRequestId, args, explicit, options);
    const result = ms ? await pollTask(access, args, ms, signal, authorized)
      : await runTool(access.device, access.scope, action, args, options);
    if (reading) {
      if (['get_task', 'read_task_output', 'operation_status'].includes(action)) return resultPacket(safeReceipt(result));
      if (action === 'list_tasks') return resultPacket({ ...result, tasks: result.tasks.map(safeReceipt) });
      return resultPacket(result);
    }
    const failed = ['FAILED', 'UNKNOWN'].includes(result.state);
    return resultPacket({ ...safeReceipt(result), operation_id: id }, failed);
  } catch (error) {
    const code = signal?.aborted ? 'request_cancelled' : publicErrorCode(error);
    const field = code.startsWith('invalid_') ? code.slice(8) : '';
    const fields = error.fields || (inputSchema && Object.hasOwn(inputSchema.properties, field) ? [field] : []);
    const operationId = id || (code === 'operation_id_conflict' ? error.operationId : undefined);
    return resultPacket({ error: code, ...(operationId ? { operation_id: operationId } : {}),
      ...candidateReferences(code, error.candidates),
      ...(fields.length ? { fields } : {}),
      ...(inputSchema && (code.startsWith('invalid_') || code === 'missing_required_argument')
        ? { action: def?.name || describedAction, inputSchema } : {}) }, true);
  }
}
