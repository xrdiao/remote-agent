// MCP task operations reuse the application's native, thread-addressed adapters.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { helpersCall, PAGE_SRC } from '../../page/build.mjs';
import { SessionBinding } from '../../session/binding.mjs';
import { nativeWindow, nativeWindowAt } from '../../native-windows.mjs';
import { correlateDevinCurrentReply, matchesDevinNativePrompt } from './devin-receipt.mjs';
import { codexInputKey } from '../../../lib/codex-input.mjs';
import { editorRoots } from '../../../lib/files.mjs';

const str = value => value == null ? '' : String(value);
const fail = code => { throw Object.assign(new Error(code), { code, outcomeUnknown: false }); };
const contextFor = row => ({ app: row.app, host: '', threadId: row.threadId });
const call = (cdp, expression, context) => {
  if (context?.app !== 'codex') return cdp.evaluate(helpersCall(expression, context), { timeout: 10000 });
  const attached = nativeWindow(cdp), source = nativeWindowAt(cdp.wsUrl);
  if (!source || attached && attached !== source || !attached && source.cdp !== cdp
      || source.cdp.wsUrl !== cdp.wsUrl || (source.app || source.win?.app) !== 'codex')
    fail('codex_exact_native_window_unavailable');
  return source.composerCall(expression, context);
};
const samePath = (a, b) => {
  if (!a || !b) return false;
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
};
const REQUEST_ID = /^[A-Za-z0-9_.:-]{4,160}$/;

function cursorQuestionRequestId(rawId) {
  // Native tool-call IDs are opaque and can contain actual newlines. Keep
  // their exact value in the binding, never in a control-plane request ID.
  if (typeof rawId !== 'string' || !rawId.trim() || rawId.length > 4096 || !rawId.isWellFormed())
    fail('invalid_native_question_id');
  // Reserve the hash namespace, so a safe native ID cannot alias another ID's hash.
  // A negated character class also rejects trailing line terminators, which
  // JavaScript's $ anchor otherwise permits before the end of a string.
  const safe = rawId.length >= 4 && rawId.length <= 160 && !/[^A-Za-z0-9_.:-]/.test(rawId);
  return safe && !rawId.startsWith('cursorq-') ? rawId
    : 'cursorq-' + crypto.createHash('sha256').update(rawId).digest('hex');
}

function cursorQuestionShape(question) {
  if (!question || !Array.isArray(question.list)
      || !question.list.length || question.list.length > 20
      || new Set(question.list.map(item => item.id)).size !== question.list.length) fail('invalid_native_question');
  return question.list.map(item => {
    if (typeof item.id !== 'string' || !item.id || item.id.length > 300
        || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 2000
        || !Array.isArray(item.options) || item.options.length > 21
        || item.options.some(option => typeof option.label !== 'string' || !option.label.trim() || option.label.length > 500))
      fail('invalid_native_question');
    const nativeOptions = item.options.filter(option => !option.free);
    if (nativeOptions.some(option => typeof option.id !== 'string' || !option.id || option.id === '__freeform_other__')
        || new Set(nativeOptions.map(option => option.id)).size !== nativeOptions.length) fail('invalid_native_question');
    return { question: item.text, options: item.options.filter(option => !option.free).map(option => option.label),
      allowMultiple: item.multi === true, allowCustom: item.options.some(option => option.free === true) };
  });
}

function nativeQuestionAnswers(answers, questions) {
  if (!Array.isArray(answers) || answers.length !== questions.length) fail('invalid_question_answers');
  return answers.map((entry, i) => {
    const values = typeof entry === 'string' ? [entry] : entry, question = questions[i];
    if (!Array.isArray(values) || !values.length || values.length > 20
        || !question.allowMultiple && values.length !== 1
        || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 4000 || value.includes('\0')
          || !value.isWellFormed()) || new Set(values).size !== values.length) fail('invalid_question_answers');
    let free = 0;
    for (const value of values) {
      const matches = question.options.filter(option => option === value).length;
      if (matches > 1) fail('native_question_option_ambiguous');
      if (!matches && (!question.allowCustom || ++free > 1)) fail('native_question_option_not_exact');
    }
    return values;
  });
}

export async function readDevinNativePermission(cdp, row, receipt, prompt) {
  const context = await readNativeContext(cdp, 'devin', row.threadId);
  assertNativeProject(context, row.workspace, row.threadId);
  if (context.roots?.length !== 1 || !samePath(context.roots[0].root, row.workspace)) fail('native_window_project_ambiguous');
  const fusion = await call(cdp, `nativeSessionInfo('devin', ${JSON.stringify(row.threadId)}, 'fusionState')`, contextFor(row));
  const after = await readNativeContext(cdp, 'devin', row.threadId);
  assertNativeProject(after, row.workspace, row.threadId);
  if (after.roots?.length !== 1 || !samePath(after.roots[0].root, row.workspace)) fail('native_window_project_ambiguous');
  const state = fusion?.permissions;
  const question = fusion?.questions?.requests?.filter(request => !request.id.startsWith('devin-permission:'));
  if (question?.length) {
    if (question.length !== 1 || state?.thread !== row.threadId || !/^acp\d+$/.test(receipt) || !state?.human || state.human.i !== receipt || !matchesDevinNativePrompt(state.human.t, prompt)
        || state.turnId == null || !str(state.turnId) || !Array.isArray(question[0].fields) || !question[0].fields.length)
      fail('native_request_turn_mismatch');
    const [request] = question, questionKey = JSON.stringify(request);
    return { turnId: state.turnId, pending: { kind: 'question', id: 'devinq-' + crypto.createHash('sha256').update(request.id).digest('hex'),
      questions: request.fields.map(field => ({ question: str(field.label), options: (field.options || []).filter(option => option.value !== '').map(option => str(option.label)),
        allowMultiple: field.multiple === true, allowCustom: !field.options?.length })),
      native: { rawId: request.id, turnId: state.turnId, messageId: receipt }, questionKey } };
  }
  if (!state || state.thread !== row.threadId || !/^acp\d+$/.test(receipt)
      || typeof prompt !== 'string' || !prompt.trim() || state.human?.i !== receipt || !matchesDevinNativePrompt(state.human.t, prompt)
      || !['string', 'number'].includes(typeof state.turnId) || !str(state.turnId)
      || !Array.isArray(state.entries)) fail('devin_permission_turn_unverifiable');
  if (state.pendingCount === 0 && state.entries.length === 0) return { pending: null, turnId: state.turnId };
  if (!state.active || state.pendingCount !== 1 || state.entries.length !== 1) fail('devin_permission_not_unique_or_active');
  const entry = state.entries[0], requests = fusion.questions?.requests;
  if (!Array.isArray(requests) || requests.length !== 1 || requests[0].id !== entry.id
      || typeof entry.id !== 'string' || !entry.id.startsWith('devin-permission:') || entry.id.length > 4096
      || !entry.id.isWellFormed() || !entry.key || entry.providerId !== state.providerId
      || entry.id !== 'devin-permission:' + JSON.stringify([row.threadId, entry.providerId, entry.key, entry.requestId])
      || entry.requestId === undefined || !Array.isArray(entry.options) || !entry.options.length || entry.options.length > 20
      || entry.options.some(option => typeof option.name !== 'string' || option.name.length > 500
        || typeof option.optionId !== 'string' || !option.optionId || option.optionId.length > 500)
      || new Set(entry.options.map(option => option.optionId)).size !== entry.options.length)
    fail('devin_permission_identity_unverifiable');
  const tool = entry.toolCall, scope = requests[0].text;
  if (!tool || tool.title !== undefined && (typeof tool.title !== 'string' || tool.title.length > 2000)
      || typeof scope !== 'string' || scope.length > 2000) fail('devin_permission_scope_unverifiable');
  const metaCommand = tool._meta?.['cognition.ai/editableCommand'], inputCommand = tool.rawInput?.command;
  if (metaCommand !== undefined && typeof metaCommand !== 'string'
      || inputCommand !== undefined && typeof inputCommand !== 'string'
      || metaCommand !== undefined && inputCommand !== undefined && metaCommand !== inputCommand)
    fail('devin_permission_command_ambiguous');
  const command = metaCommand ?? inputCommand ?? (tool._meta?.['cognition.ai/permissionRule'] === 'Exec(rm)' ? tool.title || '' : '');
  if (command.length > 2000) fail('devin_permission_scope_unverifiable');
  const permissionKey = JSON.stringify(state);
  if (permissionKey.length > 64000) fail('devin_permission_scope_unverifiable');
  return { turnId: state.turnId, pending: { kind: 'permission',
    id: 'devinp-' + crypto.createHash('sha256').update(entry.id).digest('hex'),
    permission: str(tool.kind ?? tool._meta?.['cognition.ai/permissionRule']), scope,
    action: tool.title || command || '', command, options: entry.options.map(option => option.name),
    native: { rawId: entry.id, key: entry.key, providerId: entry.providerId, requestId: entry.requestId,
      turnId: state.turnId, messageId: receipt }, permissionKey } };
}

export async function prepareDevinNativeQuestion(source, row, receipt, pending, { decision, answers, prompt, beforeAction }) {
  const fresh = (await readDevinNativePermission(source.cdp, row, receipt, prompt)).pending;
  if (!fresh || fresh.kind !== 'question' || JSON.stringify(fresh) !== JSON.stringify(pending)) fail('native_request_changed');
  if (!['once', 'reject'].includes(decision)) fail('question_must_be_once_or_reject');
  const request = JSON.parse(fresh.questionKey);
  const chosen = decision === 'once' ? nativeQuestionAnswers(answers, fresh.questions) : [];
  const fields = request.fields.map((field, n) => ({ n, value: field.multiple
    ? chosen[n]?.map(value => field.options?.find(option => option.label === value)?.value ?? value)
    : field.options?.find(option => option.label === chosen[n]?.[0])?.value ?? chosen[n]?.[0] ?? '' }));
  return async () => {
    const current = (await readDevinNativePermission(source.cdp, row, receipt, prompt)).pending;
    if (JSON.stringify(current) !== JSON.stringify(fresh)) fail('native_request_changed');
    await beforeAction();
    const ack = await call(source.cdp, `nativeSessionAction('devin', ${JSON.stringify(row.threadId)}, 'question', ${JSON.stringify({
      id: fresh.native.rawId, n: decision === 'once' ? 0 : 1, fields,
    })})`, contextFor(row));
    return ack === true || !!ack && !ack.error && (ack.accepted === true || ack.ok === true || ack.submitted === true);
  };
}

export async function prepareDevinNativePermission(source, row, receipt, pending, { decision, prompt, answers = [], beforeAction }) {
  if (!['once', 'reject'].includes(decision)) fail('permission_must_be_once_or_reject');
  if (!Array.isArray(answers) || answers.length) fail('permission_answers_unsupported');
  const fresh = (await readDevinNativePermission(source.cdp, row, receipt, prompt)).pending;
  if (!fresh || JSON.stringify(fresh) !== JSON.stringify(pending)) fail('native_request_changed');
  const options = JSON.parse(fresh.permissionKey).entries[0].options;
  const label = decision === 'once' ? 'Allow' : 'Reject', kind = decision === 'once' ? 'allow_once' : 'reject_once';
  const n = decision === 'once' ? 0 : 5;
  if (options.length !== 6 || options[n].name !== label || options[n].kind !== kind
      || options.filter(option => option.name === label).length !== 1
      || options.filter(option => option.kind === kind).length !== 1) fail('devin_permission_option_not_once');
  return async () => {
    const current = (await readDevinNativePermission(source.cdp, row, receipt, prompt)).pending;
    if (JSON.stringify(current) !== JSON.stringify(fresh)) fail('native_request_changed');
    await beforeAction();
    const ack = await call(source.cdp, `nativeSessionAction('devin', ${JSON.stringify(row.threadId)}, 'permission', ${JSON.stringify({
      id: fresh.native.rawId, n, key: fresh.native.key, optionId: options[n].optionId, label,
      turnId: fresh.native.turnId, messageId: receipt, prompt, project: row.workspace, permissionKey: fresh.permissionKey,
    })})`, contextFor(row));
    return ack === true || !!ack && !ack.error && (ack.accepted === true || ack.ok === true || ack.submitted === true);
  };
}

function codexQuestionShape(params) {
  const questions = params?.questions;
  if (!Array.isArray(questions) || !questions.length || questions.length > 20) fail('invalid_native_question');
  const ids = new Set();
  return questions.map(question => {
    if (typeof question.id !== 'string' || !question.id || question.id.length > 300 || ids.has(question.id)
        || typeof question.question !== 'string' || !question.question.trim() || question.question.length > 2000
        || question.header != null && (typeof question.header !== 'string' || question.header.length > 500)
        || question.options != null && !Array.isArray(question.options)) fail('invalid_native_question');
    ids.add(question.id);
    const options = question.options || [];
    if (options.length > 20 || options.some(option => typeof option?.label !== 'string' || !option.label.trim()
        || option.label.length > 500 || option.description != null &&
          (typeof option.description !== 'string' || option.description.length > 2000))) fail('invalid_native_question');
    return { question: question.question, ...(question.header ? { header: question.header } : {}),
      options: options.map(option => option.label),
      ...(options.some(option => option.description != null) ? { optionDescriptions: options.map(option => option.description || '') } : {}),
      allowMultiple: false, allowCustom: question.isOther === true || !options.length,
      ...(question.isSecret === true ? { isSecret: true } : {}) };
  });
}

function codexSubmissionInput(row, receipt, prompt, submission, turn) {
  if (!submission || submission.version !== 1) fail('native_submission_receipt_missing');
  const key = codexInputKey(submission.input);
  if (!key || typeof prompt !== 'string' || submission.prompt_sha256 !== crypto.createHash('sha256').update(prompt).digest('hex')
      || submission.receipt !== receipt || submission.threadId !== row.threadId
      || submission.messageId !== turn?.id || submission.turnId !== turn?.turnId
      || !samePath(submission.project, row.workspace) || codexInputKey(turn?.nativeInput) !== key)
    fail('native_submission_receipt_mismatch');
  return key;
}

// Called only after the native send ACK, while the same window lease is held.
// The ACK already correlates the native serialized draft with this message ID.
// Capture is read-only and may precede complete turn history. Later actions
// still recheck current ownership before mutation. Persist the admitted input;
// later actions must not reinterpret the
// user's original text as the native composer's Markdown serialization.
export async function captureCodexNativeSubmission(source, row, receipt, prompt) {
  const check = context => {
    assertNativeProject(context, row.workspace, row.threadId);
    if (context.roots?.length !== 1 || !samePath(context.roots[0].root, row.workspace)) fail('native_window_project_ambiguous');
  };
  check(await readNativeContext(source.cdp, 'codex', row.threadId));
  // Native send ACK can precede persisted user items. Wait only for this
  // exact receipt's read projection; never submit or reinterpret the prompt.
  const turn = await readCodexReceiptTurn(source.cdp, row, receipt);
  const inputKey = codexInputKey(turn?.nativeInput);
  check(await readNativeContext(source.cdp, 'codex', row.threadId));
  if (typeof prompt !== 'string' || !prompt.trim() || turn?.threadId !== row.threadId
      || !turn.id || !turn.turnId || turn.lastUserId !== turn.id || !inputKey
      || !matchesCodexReceipt(row, receipt, turn))
    fail('native_submission_receipt_unverifiable');
  return { version: 1, project: fs.realpathSync(row.workspace), receipt, threadId: row.threadId,
    turnId: turn.turnId, messageId: turn.id,
    prompt_sha256: crypto.createHash('sha256').update(prompt).digest('hex'), input: JSON.parse(inputKey) };
}

export async function readCodexDispatchReceipt(source, row, requestId) {
  const clientId = await call(source.cdp,
    `nativeSessionInfo('codex', ${JSON.stringify(row.threadId)}, 'dispatchClientId', ${JSON.stringify(requestId)})`,
    contextFor(row));
  return typeof clientId === 'string' && REQUEST_ID.test(clientId) ? `${row.threadId}:user-message:${clientId}` : '';
}

// A direct send ACK means native message admission, not task completion.
export async function readCodexDispatchAcknowledgement(source, row, requestId) {
  if (row.app !== 'codex' || row.windowId === 'backend' || !REQUEST_ID.test(requestId)) return null;
  const check = context => {
    assertNativeProject(context, row.workspace, row.threadId);
    if (context.roots?.length !== 1 || !samePath(context.roots[0].root, row.workspace))
      fail('native_window_project_ambiguous');
  };
  check(await readNativeContext(source.cdp, 'codex', row.threadId));
  const receipt = await readCodexDispatchReceipt(source, row, requestId);
  const prefix = row.threadId + ':user-message:';
  if (!receipt || !receipt.startsWith(prefix)) return null;
  const clientId = receipt.slice(prefix.length);
  const turn = await readNativeTurn(source.cdp, row, receipt, true);
  if (!turn || turn.threadId !== row.threadId || !turn.turnId || turn.id !== clientId
      || !turn.nativeIds?.includes(clientId) || !(turn.active || turn.ended)) return null;
  check(await readNativeContext(source.cdp, 'codex', row.threadId));
  return { native_message_id: receipt, native_turn_id: turn.turnId };
}

function matchesCodexReceipt(row, receipt, turn) {
  return !!receipt && !!turn?.id && !!turn.turnId && turn.threadId === row.threadId
    && !!turn.nativeIds?.length && [turn.id, `${row.threadId}:user-message:${turn.id}`, ...turn.nativeIds].includes(receipt);
}

async function readCodexReceiptTurn(cdp, row, receipt, active = false) {
  const deadline = performance.now() + 3000;
  const delays = [25, 40, 60, 100, 150];
  let turn;
  for (let i = 0; ; i++) {
    turn = await readNativeTurn(cdp, row, receipt, true);
    if (matchesCodexReceipt(row, receipt, turn) && codexInputKey(turn.nativeInput)
        && turn.lastUserId === turn.id && (!active || turn.current && turn.active)
        || active && turn?.ended || turn?.threadId && turn.threadId !== row.threadId
        || performance.now() >= deadline) return turn;
    await new Promise(resolve => setTimeout(resolve, delays[Math.min(i, delays.length - 1)]));
  }
}

export async function readCodexNativeRequest(cdp, row, receipt, prompt, submission) {
  if (!receipt || typeof prompt !== 'string' || !prompt.trim()) fail('native_question_receipt_missing');
  const snapshot = await cdp.evaluate(`(async () => {
    const codexInputKey = ${codexInputKey.toString()};
    const h = ${PAGE_SRC.slice(0, -2)}(${JSON.stringify(contextFor(row))});
    const context = await h.nativeSessionInfo('codex', ${JSON.stringify(row.threadId)}, 'context');
    const turn = await h.codexFusionTurn(${JSON.stringify(receipt)});
    const pending = await h.nativeSessionInfo('codex', ${JSON.stringify(row.threadId)}, 'pendingRequests');
    const after = await h.nativeSessionInfo('codex', ${JSON.stringify(row.threadId)}, 'context');
    return { context, after, pending, turn: turn && { id: turn.id, threadId: turn.threadId, turnId: turn.turnId,
      current: turn.current, ended: turn.ended, nativeInput: codexInputKey(turn.nativeInput) === null ? null : turn.nativeInput,
      nativeIds: Array.isArray(turn.nativeIds) && turn.nativeIds.length <= 100 ? turn.nativeIds : null, lastUserId: turn.lastUserId } };
  })()`, { timeout: 10000 });
  for (const context of [snapshot?.context, snapshot?.after]) {
    assertNativeProject(context, row.workspace, row.threadId);
    if (context.roots?.length !== 1 || !samePath(context.roots[0].root, row.workspace)) fail('native_window_project_ambiguous');
  }
  const { turn, pending } = snapshot;
  if (!turn?.id || !turn.turnId || turn.threadId !== row.threadId || turn.current !== true
      || turn.lastUserId !== turn.id || !Array.isArray(turn.nativeIds) || !turn.nativeIds.length
      || turn.nativeIds.some(id => typeof id !== 'string' || !id || id.length > 300)
      || ![turn.id, `${row.threadId}:user-message:${turn.id}`, ...turn.nativeIds].includes(receipt))
    fail('cannot_prove_active_native_turn_for_question');
  codexSubmissionInput(row, receipt, prompt, submission, turn);
  if (pending?.thread !== row.threadId || !Array.isArray(pending.requests) || !Array.isArray(pending.methods)) fail('native_request_unverifiable');
  const requests = pending.requests.filter(request => request.params?.threadId === row.threadId && request.params?.turnId === turn.turnId);
  if (!requests.length) fail('native_request_absent');
  if (requests.length !== 1) fail('native_request_ambiguous');
  const request = requests[0];
  if (request.method === 'item/tool/requestUserInput') {
    if (!pending.methods.includes('replyWithUserInputResponse')) fail('native_question_adapter_unavailable');
    const { id, native, key } = codexRequestIdentity(row, turn, request);
    return { kind: 'question', id, questions: codexQuestionShape(request.params), native, questionKey: key };
  }
  if (turn.ended || !pending.methods.includes('replyWithCommandExecutionApprovalDecision')) fail('native_permission_adapter_unavailable');
  return codexCommandApproval(row, turn, request);
}

function codexRequestIdentity(row, turn, request) {
  const rawId = request.id;
  if (!(typeof rawId === 'string' && rawId && rawId.length <= 4096 && rawId.isWellFormed()
      || Number.isSafeInteger(rawId))) fail('native_request_unverifiable');
  const key = JSON.stringify(request);
  if (key.length > 64000) fail('native_request_unverifiable');
  const id = 'codexr-' + crypto.createHash('sha256').update(JSON.stringify([row.threadId, turn.turnId, rawId])).digest('hex');
  const native = { messageId: turn.id, turnId: turn.turnId, requestId: rawId, method: request.method };
  return { id, native, key };
}

function codexCommandApproval(row, turn, request) {
  // The native command response accepts a single request, unlike a permissions
  // grant with scope:'turn'. Do not translate broader grants into "once".
  if (request.method !== 'item/commandExecution/requestApproval') fail('native_permission_method_unsupported');
  const { id, native, key } = codexRequestIdentity(row, turn, request);
  const { params } = request;
  const decisions = params.availableDecisions ?? ['accept', 'acceptForSession', 'decline', 'cancel'];
  const scope = JSON.stringify(params);
  if (typeof params.command !== 'string' || !params.command.trim() || typeof params.cwd !== 'string' || !path.isAbsolute(params.cwd)
      || typeof params.itemId !== 'string' || !params.itemId || scope.length > 2000
      || params.additionalPermissions != null || params.networkApprovalContext != null
      || !Array.isArray(decisions))
    fail('native_permission_scope_unverifiable');
  let relative;
  try { relative = path.relative(fs.realpathSync(row.workspace), fs.realpathSync(params.cwd)); }
  catch { fail('native_permission_scope_unverifiable'); }
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    fail('native_permission_scope_unverifiable');
  const options = [];
  if (decisions.includes('accept')) options.push('once');
  if (decisions.includes('decline') || decisions.includes('cancel')) options.push('reject');
  if (!options.length) fail('native_permission_scope_unverifiable');
  return { kind: 'permission', id, permission: 'commandExecution', scope, action: 'command', command: params.command,
    options, native, permissionKey: key };
}

function codexBackendTaskState(backend, row, receipt, prompt) {
  const thread = backend.threads.get(row.threadId);
  if (thread?.id !== row.threadId || !samePath(thread.cwd, row.workspace) || thread.disconnected
      || !backend.client.ready || typeof prompt !== 'string' || !prompt.trim()) return null;
  const messages = thread.turns.flatMap(turn => turn.items.filter(item => item.type === 'userMessage').map(item => ({ turn, item })));
  const match = messages.filter(({ item }) => item.clientId && receipt === row.threadId + ':user-message:' + item.clientId);
  if (match.length !== 1) return null;
  const [{ turn, item }] = match;
  if (!turn.id || !item.id || item.content?.length !== 1 || item.content[0].type !== 'text' || item.content[0].text !== prompt) return null;
  const requests = [...backend.requests.values()].filter(request => request.params?.threadId === row.threadId);
  return { turn, item, requests, current: messages.at(-1)?.item === item && thread.turns.at(-1)?.id === turn.id,
    busy: thread.turns.some(value => value.status === 'inProgress') };
}

export async function cancelExactCodexBackendTurn(backend, row, receipt, { prompt, binding, beforeStop } = {}) {
  const read = async () => {
    await backend.refresh(row.threadId, { reconcile: true });
    let state = codexBackendTaskState(backend, row, receipt, prompt);
    if (!state) {
      const thread = backend.threads.get(row.threadId), accepted = backend.submissions.get(row.threadId), turn = thread?.turns.at(-1);
      if (thread && samePath(thread.cwd, row.workspace) && !thread.disconnected
          && accepted?.messageId === receipt && accepted.turnId === turn?.id && turn.status === 'inProgress'
          && accepted.input.length === 1 && accepted.input[0].type === 'text' && accepted.input[0].text === prompt)
        state = { current: true, turn };
    }
    if (!state?.current || state.turn.status !== 'inProgress' || !backend.hasWriter(row.threadId)
        || backend.releasing.has(row.threadId)) fail('cannot_prove_active_native_turn_for_cancel');
    return state;
  };
  const initial = await read();
  const key = JSON.stringify({ threadId: row.threadId, turnId: initial.turn.id, receipt });
  if (binding !== undefined && binding !== key) fail('native_cancel_turn_changed');
  return { binding: key, turn: { turnId: initial.turn.id }, stop: async () => {
    await beforeStop?.();
    const current = await read();
    if (current.turn.id !== initial.turn.id) fail('native_cancel_turn_changed');
    // The exact same executor as the phone, with the frozen native turn guard.
    await backend.stop(row.threadId, initial.turn.id);
    await backend.refresh(row.threadId, { reconcile: true });
    const final = codexBackendTaskState(backend, row, receipt, prompt);
    return (final?.turn || backend.threads.get(row.threadId)?.turns.find(turn => turn.id === initial.turn.id))?.status === 'interrupted'
      && ![...backend.requests.values()].some(request => request.params.threadId === row.threadId && request.params.turnId === initial.turn.id);
  } };
}

function codexBackendPending(backend, row, state) {
  if (!state?.current || state.turn.status !== 'inProgress' || !backend.hasWriter(row.threadId)
      || backend.releasing.has(row.threadId) || state.requests.length !== 1) return null;
  const [request] = state.requests;
  if (request.params.turnId !== state.turn.id) return null;
  const turn = { id: state.item.id, turnId: state.turn.id };
  if (request.method === 'item/commandExecution/requestApproval') return codexCommandApproval(row, turn, request);
  const { id, native, key } = codexRequestIdentity(row, turn, request);
  if (request.method === 'item/tool/requestUserInput')
    return { kind: 'question', id, questions: codexQuestionShape(request.params), native, questionKey: key };
  const permissions = request.method === 'item/permissions/requestApproval';
  if (!permissions && request.method !== 'item/fileChange/requestApproval') fail('native_permission_method_unsupported');
  const options = permissions ? ['once', 'reject'] : [];
  if (!permissions) {
    const decisions = request.params.availableDecisions ?? ['accept', 'acceptForSession', 'decline', 'cancel'];
    if (!Array.isArray(decisions)) fail('native_permission_scope_unverifiable');
    if (decisions.includes('accept')) options.push('once');
    if (decisions.includes('decline') || decisions.includes('cancel')) options.push('reject');
  }
  return { kind: 'permission', id, permission: permissions ? 'permissions' : 'fileChange',
    scope: JSON.stringify(request.params), action: permissions ? 'grant' : 'fileChange',
    options, native, permissionKey: key, ...(permissions ? { grantScope: 'turn' } : {}) };
}

export function readCodexBackendProgress(backend, row, args) {
  const receipt = args.after_message_id;
  const state = codexBackendTaskState(backend, row, receipt, args.expected_prompt);
  if (!state) return {};
  const { turn, current, busy, requests } = state, expected = args.expected_command_approval;
  const reply = turn.items.findLast(item => item.type === 'agentMessage' && item.text?.trim());
  const exactCompletion = turn.status === 'completed' && !!reply, exactFailure = turn.status === 'failed';
  const command = expected?.turnId === turn.id && !requests.some(request => request.id === expected.requestId
    && request.params.turnId === turn.id) && turn.items.find(item => item.type === 'commandExecution' && item.id === expected.itemId);
  const commandApproval = command && (command.status === 'declined'
      || ['completed', 'failed'].includes(command.status) && Number.isInteger(command.exitCode))
    ? { itemId: command.id, turnId: turn.id, outcome: command.status === 'declined' ? 'declined' : 'executed', status: command.status } : null;
  let waitingRequest;
  try { waitingRequest = codexBackendPending(backend, row, state); }
  catch { /* Preserve waiting when a malformed native request cannot be represented. */ }
  const status = current && busy ? 'running' : ({ interrupted: 'stopped', failed: 'error' }[turn.status] || turn.status);
  return { currentTurn: current, exactCompletion, exactFailure, busy: exactCompletion || exactFailure ? false : busy,
    waiting: exactCompletion || exactFailure ? '' : requests.filter(request => request.params.turnId === turn.id).length ? 'approval' : '', statusKnown: true, nativeTurnId: turn.id,
    ...(current || exactCompletion || exactFailure ? { run: { id: turn.id, status } } : {}),
    lastUserMessageId: current || exactCompletion || exactFailure ? receipt : '', error: turn.error?.message || '', assistantAfter: !!reply, last: reply?.text || '',
    completed: exactCompletion,
    cancelled: current && turn.status === 'interrupted'
      && (commandApproval?.outcome === 'declined' || args.expected_cancel_turn_id === turn.id && !requests.length),
    waitingRequest, commandApproval };
}

export function prepareCodexBackendInteraction(backend, row, receipt, pending, { decision, answers, prompt, beforeAction }) {
  const read = () => codexBackendPending(backend, row, codexBackendTaskState(backend, row, receipt, prompt));
  const fresh = read();
  if (!fresh || JSON.stringify(fresh) !== JSON.stringify(pending)) fail('native_request_changed');
  if (!['once', 'reject'].includes(decision)) fail('native_approval_must_be_once_or_reject');
  if (fresh.kind === 'permission' && !fresh.options.includes(decision)) fail('native_permission_decision_unavailable');
  const response = fresh.kind === 'question' && decision === 'once' ? nativeQuestionAnswers(answers, fresh.questions) : null;
  return async () => {
    await beforeAction?.();
    const current = read();
    if (!current || JSON.stringify(current) !== JSON.stringify(fresh)) fail('native_request_changed');
    const { params } = JSON.parse(current.permissionKey || current.questionKey);
    const question = current.kind === 'question', grant = current.permission === 'permissions';
    const decisions = params.availableDecisions ?? ['accept', 'acceptForSession', 'decline', 'cancel'];
    const choice = decision === 'once' ? 'accept' : decisions.includes('decline') ? 'decline' : 'cancel';
    const index = question ? (params.questions.length === 1 ? params.questions[0].options?.length || 0 : 0) + (decision === 'once' ? 1 : 0)
      : grant ? (decision === 'once' ? 0 : 1) : decisions.indexOf(choice);
    const fields = question && response ? response.map((value, n) => ({ n, value: value[0] })) : [];
    const { threadId } = row, { turnId, requestId } = current.native;
    await backend.answer(threadId, (question ? 'async:' : 'approval:') + JSON.stringify([threadId, turnId, requestId]), index, fields, turnId);
    return current.permission === 'commandExecution' ? 'UNCONFIRMED' : true;
  };
}

export async function prepareCodexNativeInteraction(source, row, receipt, pending, { decision, answers, prompt, submission, beforeAction }) {
  const fresh = await readCodexNativeRequest(source.cdp, row, receipt, prompt, submission);
  if (JSON.stringify(fresh) !== JSON.stringify(pending)) fail('native_request_changed');
  if (!['once', 'reject'].includes(decision)) fail('native_approval_must_be_once_or_reject');
  if (fresh.kind === 'permission' && !fresh.options.includes(decision)) fail('native_permission_decision_unavailable');
  const response = fresh.kind === 'question' && decision === 'once' ? nativeQuestionAnswers(answers, fresh.questions) : null;
  return async () => {
    const current = await readCodexNativeRequest(source.cdp, row, receipt, prompt, submission);
    if (JSON.stringify(current) !== JSON.stringify(fresh)) fail('native_request_changed');
    await beforeAction?.();
    return call(source.cdp, `nativeSessionAction('codex', ${JSON.stringify(row.threadId)}, ${JSON.stringify(fresh.kind)}, ${JSON.stringify({
      ...fresh.native, requestKey: fresh.questionKey || fresh.permissionKey, project: row.workspace,
      nativeInputKey: codexInputKey(submission.input), receipt, decision, answers: response,
    })})`, contextFor(row));
  };
}

export async function readCursorNativeRequest(cdp, row, receipt) {
  assertNativeProject(await readNativeContext(cdp, 'cursor', row.threadId), row.workspace, row.threadId);
  const snapshot = await cdp.evaluate(`(async () => {
    const h = ${PAGE_SRC.slice(0, -2)}(${JSON.stringify(contextFor(row))});
    const turn = await h.codexFusionTurn(${JSON.stringify(receipt)});
    const fusion = await h.nativeSessionInfo('cursor', ${JSON.stringify(row.threadId)}, 'fusionState');
    return { turn: turn && { id: turn.id, threadId: turn.threadId, turnId: turn.turnId,
      generationId: turn.generationId, current: turn.current, ended: turn.ended, completed: turn.completed }, fusion };
  })()`, { timeout: 10000 });
  const context = await readNativeContext(cdp, 'cursor', row.threadId);
  assertNativeProject(context, row.workspace, row.threadId);
  if (context.roots?.length !== 1 || !samePath(context.roots[0].root, row.workspace)) fail('native_window_project_ambiguous');
  const { turn, fusion } = snapshot || {}, ids = fusion?.state?.waitingToolIds;
  if (!receipt || !turn?.id || !turn.turnId || !turn.generationId || turn.threadId !== row.threadId
      || !turn.current || ![turn.id, `${row.threadId}:user-message:${turn.id}`].includes(receipt))
    fail('cannot_prove_active_native_turn_for_question');
  if (fusion?.state?.thread !== row.threadId || !Array.isArray(ids) || !ids.length) fail('native_request_absent');
  if (fusion.state.nativeOwner !== true) fail('native_turn_inactive');
  if (ids.length !== 1 || typeof ids[0] !== 'string') fail('native_request_ambiguous');
  const binding = fusion.requestBinding;
  if (!binding?.bubbleId || binding.messageId !== turn.id || binding.generationId !== turn.generationId)
    fail('native_request_turn_mismatch');
  const native = { messageId: turn.id, turnId: turn.turnId, generationId: turn.generationId, bubbleId: binding.bubbleId };
  if (fusion.questions) {
    const question = fusion.questions;
    if (question.id !== ids[0]) fail('native_request_ambiguous');
    // Cursor may mark a turn ended while ask_question is still pending. Only
    // this proven live question can override ended; completed turns cannot.
    // Cursor's tool turn may be marked completed while a verified native ask_question decision remains live.
    const id = cursorQuestionRequestId(question.id);
    const questions = cursorQuestionShape(question), questionKey = JSON.stringify(question);
    if (questionKey.length > 32000) fail('invalid_native_question');
    return { kind: 'question', id, questions, native: { ...native, requestId: question.id }, questionKey };
  }
  if (turn.ended) fail('cannot_prove_active_native_turn_for_question');
  const items = fusion.items;
  if (!Array.isArray(items) || items.length !== 1 || items[0].approvalId !== ids[0]
      || !items[0].permission || items[0].permission === 'ask_question') fail('native_request_unverifiable');
  const permissionKey = items[0].permissionKey, scope = items[0].scope;
  if (typeof scope !== 'string' || !scope || scope.length > 2000 || typeof permissionKey !== 'string'
      || !permissionKey || permissionKey.length > 64000 || items[0].permission.length > 60) fail('native_permission_scope_unverifiable');
  const raw = JSON.parse(permissionKey);
  if (raw.name !== items[0].permission || JSON.stringify(raw.params) !== scope) fail('native_permission_scope_changed');
  return { kind: 'permission', id: 'cursorp-' + crypto.createHash('sha256').update(ids[0]).digest('hex'),
    permission: items[0].permission, scope, native: { ...native, requestId: ids[0] }, permissionKey };
}

export async function prepareCursorNativeQuestion(source, row, receipt, pending, { decision, answers, beforeAction }) {
  const fresh = await readCursorNativeRequest(source.cdp, row, receipt);
  if (fresh.kind !== 'question' || JSON.stringify(fresh) !== JSON.stringify(pending)) fail('native_request_changed');
  if (!['once', 'reject'].includes(decision)) fail('question_must_be_once_or_reject');
  const response = decision === 'once' ? nativeQuestionAnswers(answers, fresh.questions) : null;
  return async () => {
    const current = await readCursorNativeRequest(source.cdp, row, receipt);
    if (JSON.stringify(current) !== JSON.stringify(fresh)) fail('native_request_changed');
    await beforeAction?.();
    return await call(source.cdp, `nativeSessionAction('cursor', ${JSON.stringify(row.threadId)}, 'question', ${JSON.stringify({
      ...fresh.native, id: fresh.native.requestId, questionKey: fresh.questionKey, project: row.workspace,
      part: decision === 'reject' ? 'skip' : 'answer', answers: response,
    })})`, contextFor(row)) === true;
  };
}

export async function prepareCursorNativePermission(source, row, receipt, pending, { decision, beforeAction }) {
  const fresh = await readCursorNativeRequest(source.cdp, row, receipt);
  if (fresh.kind !== 'permission' || JSON.stringify(fresh) !== JSON.stringify(pending)) fail('native_request_changed');
  if (!['once', 'reject'].includes(decision)) fail('permission_must_be_once_or_reject');
  return async () => {
    const current = await readCursorNativeRequest(source.cdp, row, receipt);
    if (JSON.stringify(current) !== JSON.stringify(fresh)) fail('native_request_changed');
    await beforeAction?.();
    return await call(source.cdp, `nativeSessionAction('cursor', ${JSON.stringify(row.threadId)}, 'permission', ${JSON.stringify({
      ...fresh.native, id: fresh.native.requestId, permissionKey: fresh.permissionKey, project: row.workspace, decision,
    })})`, contextFor(row)) === true;
  };
}

export function assertNativeProject(context, project, threadId) {
  // The realpath comparator deliberately rejects empty paths. Only an explicit
  // Cursor empty-workspace context can match an empty requested project.
  const projectless = context?.app === 'cursor' && project === '' && context.cwd === ''
    && context.projectless === true && Array.isArray(context.roots) && context.roots.length === 0;
  if (!context || context.host || str(context.threadId) !== str(threadId)
      || (!projectless && !samePath(context.cwd, project)) || context.roots?.some(root => root.host))
    fail('native_project_context_mismatch');
}

export async function readNativeContext(cdp, app, threadId) {
  return call(cdp, `nativeSessionInfo(${JSON.stringify(app)}, ${JSON.stringify(threadId)}, 'context')`);
}

export async function readNativeTurn(cdp, row, receipt, includeUser = false) {
  // Do not transfer the unbounded history/items returned by the native helper.
  return cdp.evaluate(`(async () => {
    const helpers = ${PAGE_SRC.slice(0, -2)};
    const codexInputKey = ${codexInputKey.toString()};
    let turn;
    try { turn = await helpers(${JSON.stringify(contextFor(row))}).codexFusionTurn(${JSON.stringify(receipt)}); }
    catch (error) { ${row.app === 'codex' ? '' : 'throw error;'} }
    ${row.app === 'codex' ? `if (!turn?.id || !turn.ended && !turn.current) {
      const visible = helpers();
      if (await visible.codexThread() === ${JSON.stringify(row.threadId)}) {
        const local = await visible.codexFusionTurn(${JSON.stringify(receipt)});
        if (local?.id && local.threadId === ${JSON.stringify(row.threadId)}
            && await visible.codexThread() === local.threadId && (!turn?.id || local.turnId === turn.turnId))
          turn = local;
      }
    }` : ''}
    if (!turn) return null;
    return { id: turn.id, threadId: turn.threadId, turnId: turn.turnId,
      generationId: turn.generationId || '', current: turn.current === true,
      ${includeUser ? `user: typeof turn.user === 'string' && turn.user.length <= 64000 ? turn.user : null,
      nativeInput: codexInputKey(turn.nativeInput) === null ? null : turn.nativeInput,
      nativeIds: Array.isArray(turn.nativeIds) && turn.nativeIds.length <= 100
        && turn.nativeIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 300) ? turn.nativeIds : null,
      lastUserId: typeof turn.lastUserId === 'string' && turn.lastUserId.length <= 300 ? turn.lastUserId : '',` : ''}
      active: turn.active === true, ended: turn.ended === true, completed: turn.completed === true, interrupted: turn.interrupted === true,
      lastUserMessageId: turn.ids?.at(-1) || '',
      text: String(turn.text || '').slice(0, 16000), error: String(turn.error || '').slice(0, 400) };
  })()`, { timeout: 10000 });
}

export async function readNativeConversationProgress(source, row, args) {
  if (!source?.cdp) return { available: false, reason: 'native_cdp_unavailable' };
  const context = await readNativeContext(source.cdp, row.app, row.threadId);
  const project = args.project_path || row.workspace;
  assertNativeProject(context, project, row.threadId);
  const receipt = str(args.after_message_id);
  let commandApproval = null;
  if (row.app === 'codex' && receipt && args.expected_command_approval) {
    try {
      const expected = args.expected_command_approval;
      const turn = await readNativeTurn(source.cdp, row, receipt, true);
      if (turn?.threadId === row.threadId && turn.turnId === expected.turnId) {
        codexSubmissionInput(row, receipt, args.expected_prompt, args.expected_native_submission, turn);
        const evidence = await call(source.cdp, `nativeSessionInfo('codex', ${JSON.stringify(row.threadId)}, 'requestReceipt', ${JSON.stringify(expected)})`, contextFor(row));
        if (evidence?.type === 'commandExecution' && evidence.id === expected.itemId && evidence.turnId === expected.turnId
            && (evidence.status === 'declined' || ['completed', 'failed'].includes(evidence.status) && Number.isInteger(evidence.exitCode))) {
          assertNativeProject(await readNativeContext(source.cdp, row.app, row.threadId), project, row.threadId);
          commandApproval = { itemId: evidence.id, turnId: evidence.turnId,
            outcome: evidence.status === 'declined' ? 'declined' : 'executed', status: evidence.status };
        }
      }
    } catch { /* A missing or partial native record cannot confirm this decision. */ }
  }
  if (row.app === 'codex' && receipt && args.expected_cancel_turn_id !== undefined) {
    const turn = await readNativeTurn(source.cdp, row, receipt, true);
    if (turn?.interrupted && turn.threadId === row.threadId && turn.turnId === args.expected_cancel_turn_id) {
      codexSubmissionInput(row, receipt, args.expected_prompt, args.expected_native_submission, turn);
      assertNativeProject(await readNativeContext(source.cdp, row.app, row.threadId), project, row.threadId);
      return { available: true, busy: false, waiting: '', run: { id: turn.turnId, status: 'stopped' },
        statusKnown: true, cancelled: true, exactCancellation: true, currentTurn: turn.current,
        lastUserMessageId: receipt, nativeTurnId: turn.turnId, commandApproval };
    }
  }
  let conversation;
  try { conversation = await source.readConversation(contextFor(row), true); }
  catch (error) {
    if (row.app !== 'codex') throw error;
    // A native conversation can be readable even when the optional composer
    // enrichment in NativeWindow.readConversation is unavailable.
    conversation = await source.cdp.evaluate(`(async () => {
      const chat = await ${helpersCall('extract(false, [], 120)', contextFor(row))};
      if (!chat) return null;
      return { chat: { thread: chat.thread, items: (chat.items || []).filter(item => item.k === 'human')
        .slice(-120).map(item => ({ k: item.k, i: item.i, nativeIds: item.nativeIds })) }, state: chat._nativeState };
    })()`, { timeout: 10000 });
  }
  const { chat, state } = conversation || {};
  if (chat?.thread !== row.threadId || state?.thread !== row.threadId)
    return { available: false, reason: 'native_conversation_mismatch' };
  const items = chat.items || [];
  const human = items.find(item => item.k === 'human'
    && (str(item.i) === receipt || item.nativeIds?.includes(receipt)));
  if (row.app === 'devin') {
    if (args.expected_cancel_turn_id !== undefined) {
      // Do not infer cancellation from idle, an empty reply, or generic
      // completion. Use RA's shared stopped run and the exact ACP stop reason.
      let cancelled = false, terminal;
      if (state.run?.status === 'stopped' && !state.busy && !state.waiting && /^acp\d+$/.test(receipt)) {
        try {
          terminal = await call(source.cdp, `nativeSessionInfo('devin', ${JSON.stringify(row.threadId)}, 'cancelState')`, contextFor(row));
          const currentContext = await readNativeContext(source.cdp, 'devin', row.threadId);
          assertNativeProject(currentContext, args.project_path || row.workspace, row.threadId);
          if (currentContext.provider !== 'devin-cli' || currentContext.roots?.length !== 1
              || !samePath(currentContext.roots[0].root, args.project_path || row.workspace)) fail('native_cancel_project_or_provider_mismatch');
          cancelled = terminal?.thread === row.threadId && terminal.providerId === 'devin-cli'
            && terminal.turnId === args.expected_cancel_turn_id && terminal.active === false
            && terminal.request === null && terminal.stopReason === 'cancelled'
            && Array.isArray(terminal.pending) && terminal.pending.length === 0
            && terminal.human?.i === receipt && matchesDevinNativePrompt(terminal.human.t, args.expected_prompt);
        } catch { /* unverified cancellation */ }
      }
      return { available:true,busy:!!state.busy,waiting:str(state.waiting),run:state.run,
        currentTurn:cancelled,statusKnown:cancelled,cancelled,completed:false,assistantAfter:false,last:'',
        lastUserMessageId:cancelled?receipt:'',nativeTurnId:cancelled?terminal.turnId:undefined,
        reason:cancelled?'':'native_cancel_terminal_unverifiable' };
    }
    let permission;
    if (state.waiting || args.expected_turn_id !== undefined) {
      try {
        permission = await readDevinNativePermission(source.cdp, row, receipt, args.expected_prompt);
      } catch (error) {
        return { available: true, busy: !!state.busy, waiting: str(state.waiting), last: '',
          completed: false, currentTurn: false, reason: error.message };
      }
      if (args.expected_turn_id !== undefined && permission.turnId !== args.expected_turn_id)
        return { available: true, busy: !!state.busy, waiting: str(state.waiting), last: '',
          completed: false, currentTurn: false, reason: 'devin_permission_turn_changed' };
      if (permission.pending) return { available: true, busy: true, waiting: permission.pending.id,
        waitingRequest: permission.pending, currentTurn: true, lastUserMessageId: receipt, last: '', completed: false };
    }
    const verified = correlateDevinCurrentReply({ items, state, receipt, expectedPrompt:args.expected_prompt });
    if (verified) return { ...verified, ...(permission ? { nativeTurnId: permission.turnId } : {}) };
  }
  const turn = receipt ? await readNativeTurn(source.cdp, row, receipt, row.app === 'codex') : null;
  let waitingRequest = null, requestReason = '';
  if (['codex', 'cursor'].includes(row.app) && receipt) {
    try { waitingRequest = row.app === 'codex'
      ? await readCodexNativeRequest(source.cdp, row, receipt, args.expected_prompt, args.expected_native_submission)
      : await readCursorNativeRequest(source.cdp, row, receipt); }
    catch (error) { requestReason = error.message; }
  }
  const matches = row.app === 'codex' ? matchesCodexReceipt(row, receipt, turn) : !!turn?.id && turn.threadId === row.threadId && !!turn.turnId
    && (turn.id === receipt || receipt === `${row.threadId}:user-message:${turn.id}`
      || !!human && (human.i === turn.id || human.nativeIds?.includes(turn.id)));
  const currentTurn = matches && turn.current === true;
  const runMatches = !state.run?.id || [turn?.turnId, turn?.generationId].includes(state.run.id);
  if (row.app === 'codex' && args.reconcile_codex_send && matches && turn.interrupted && turn.ended) {
    codexSubmissionInput(row, receipt, args.expected_prompt, args.expected_native_submission, turn);
    return { available: true, busy: false, waiting: '', run: { id: turn.turnId, status: 'stopped' },
      statusKnown: true, cancelled: true, exactCancellation: true, currentTurn,
      lastUserMessageId: receipt, nativeTurnId: turn.turnId };
  }
  const exactCompletion = matches && turn.ended === true && turn.completed === true && !turn.error
    && !waitingRequest && !!str(turn.text).trim() && (!currentTurn || runMatches && !state.busy && !state.waiting
      && !['running', 'in_progress', 'busy', 'inProgress'].includes(state.run?.status));
  const run = exactCompletion ? { id: turn.turnId, status: 'completed' } : state.run;
  const text = currentTurn || exactCompletion ? str(turn.text).slice(0, 16000) : '';
  return { available: true, busy: exactCompletion ? false : !!state.busy, commandApproval,
    waiting: waitingRequest ? waitingRequest.id : exactCompletion ? '' : str(state.waiting), run, waitingRequest,
    last: text, lastUserMessageId: row.app === 'codex' && (currentTurn || exactCompletion) ? receipt : str(turn?.lastUserMessageId), currentTurn,
    ...(row.app === 'codex' && matches ? { nativeTurnId: turn.turnId, exactActive: currentTurn && runMatches && turn.active } : {}),
    assistantAfter: (currentTurn || exactCompletion) && !!text.trim(),
    statusKnown: (currentTurn && runMatches || exactCompletion) && turn.ended === true,
    completed: exactCompletion, exactCompletion,
    reason: matches && !currentTurn && !exactCompletion ? 'native_turn_changed' : !matches ? 'no_native_send_correlation'
      : state.waiting && requestReason ? requestReason : '',
  };
}

const cursorDraftThread = id => id === 'empty-state-draft' || id.startsWith('draft-');

export async function inspectNativeWindow(cdp, app, allowCursorDraft = false) {
  const startup = await call(cdp, `agentStartupState(${JSON.stringify(app)}, true)`);
  if (!startup || startup.login) fail('native_window_not_ready');
  const state = await call(cdp, 'agentState()');
  const draft = await call(cdp, 'composerDraft()');
  if (!state || str(state.thread) !== str(startup.thread)) fail('native_window_context_changed');
  return { threadId: str(startup.thread), busy: !!state.busy, waiting: str(state.waiting), draft: !!draft,
    creationReady: app !== 'codex' || await call(cdp,
      `nativeSessionInfo('codex', ${JSON.stringify(str(startup.thread))}, 'creationReady')`) === true,
    context: startup.thread && !(allowCursorDraft && app === 'cursor' && cursorDraftThread(startup.thread))
      ? await readNativeContext(cdp, app, startup.thread) : null };
}

export async function prepareNativeView(view, row, project, { allowBusy = false, preserveDraft = false } = {}) {
  const cdp = view.cdp, windowId = view.windowId;
  if (typeof view.projectWindowState !== 'function') fail('native_window_safety_unavailable');
  const safety = await view.projectWindowState({ id: windowId }, row.threadId, true);
  const before = await inspectNativeWindow(cdp, row.app, true);
  const sameThread = before.threadId === row.threadId;
  if ((safety.busy || before.busy || before.waiting) && !(allowBusy && sameThread)
      || (safety.draft || before.draft) && !(preserveDraft && sameThread)) fail('native_window_busy_waiting_or_draft');
  const cursorRoots = row.app === 'cursor' ? await editorRoots(view.editorCdp, row.app) : null;
  if (cursorRoots && (project ? !cursorRoots.some(root => !root.host && samePath(root.root, project))
      : cursorRoots.length !== 0)) fail('native_project_context_mismatch');
  if (row.app === 'cursor' && !sameThread && (cursorDraftThread(before.threadId) || before.context?.projectless === true)) {
    // In an empty renderer, a confirmed projectless target is legal. A
    // project-bearing target still requires the existing exact single root.
    if (project && (cursorRoots.length !== 1 || cursorRoots[0].host || !samePath(cursorRoots[0].root, project))) fail('native_project_context_mismatch');
  } else if (before.context) assertNativeProject(before.context, project, before.threadId);
  const target = await readNativeContext(cdp, row.app, row.threadId);
  assertNativeProject(target, project, row.threadId);
  if (before.threadId !== row.threadId) {
    if (row.app === 'codex') {
      if (!await view.selectCodexThread(row.threadId)) fail('native_thread_selection_failed');
      await view.adoptCodexThread(row.threadId);
    } else {
      // reuseWindow avoids Devin ensureDevinIde and Cursor source-window routing.
      await view.adapter.openAgent.call(view, row.threadId, '', { reuseWindow: true });
    }
  }
  if (view.cdp !== cdp || view.windowId !== windowId) fail('native_window_context_changed');
  const after = await inspectNativeWindow(cdp, row.app);
  if (after.threadId !== row.threadId) fail('native_thread_selection_failed');
  if ((after.busy || after.waiting) && !allowBusy || after.draft && !preserveDraft) fail('native_window_busy_waiting_or_draft');
  assertNativeProject(after.context, project, row.threadId);
  if (row.app === 'cursor' && !project && (await editorRoots(view.editorCdp, row.app)).length)
    fail('native_project_context_mismatch');
  SessionBinding.commit(view, { threadId: row.threadId, selectedThread: row.threadId, bindingReady: true });
  await view.assertSelectedThread();
}

export async function createNativeSessionOnView(view, task) {
  const cdp = view.cdp, windowId = view.windowId;
  if (typeof view.projectWindowState !== 'function') fail('native_window_safety_unavailable');
  const safety = await view.projectWindowState({ id: windowId }, '', true);
  if (safety.busy || safety.draft) fail('native_window_busy_waiting_or_draft');
  const before = await inspectNativeWindow(cdp, task.app);
  if (!before.creationReady) fail('native_creation_adapter_unavailable');
  if (before.busy || before.waiting || before.draft) fail('native_window_busy_waiting_or_draft');
  if (before.context) assertNativeProject(before.context, task.project, before.threadId);
  const roots = await view.currentRoots();
  if (roots.length !== 1 || roots[0].host || !samePath(roots[0].root, task.project))
    fail('native_window_project_ambiguous');
  if (view.cdp !== cdp || view.windowId !== windowId) fail('native_window_context_changed');
  const creationContext = task.app === 'codex' ? {
    ...(before.context || { host: '', cwd: task.project, roots }), app: 'codex', threadId: before.threadId,
  } : undefined;
  let threadId;
  // Once creation is attempted, an exception is an unknown outcome, never a retry.
  try {
    if (task.app === 'cursor') {
      threadId = await call(cdp, `nativeSessionAction('cursor', '', 'createProjectChat', ${JSON.stringify(task.project)})`);
    } else {
      const created = await call(cdp, `nativeSessionAction(${JSON.stringify(task.app)}, ${JSON.stringify(before.threadId)}, 'create', ${JSON.stringify({
        root: task.project, requestId: task.task_id, role: 'main', title: 'RA MCP Task ' + task.task_id.slice(0, 8),
      })})`, creationContext);
      threadId = created?.threadId;
    }
    if (typeof threadId !== 'string' || !threadId || threadId === before.threadId || threadId.length > 256)
      throw Error('native_independent_session_unconfirmed');
    if (view.cdp !== cdp || view.windowId !== windowId) throw Error('native_window_context_changed');
    // Return the irreversible creation identity before waiting on the new
    // session's projections. First submission performs fresh preparation.
    return { window_id: windowId, thread_id: threadId };
  } catch (error) {
    if (task.app === 'codex' && !threadId) {
      // Creation can ACK its identity before the later context read fails.
      // Read only the exact original request record; never create or send again.
      try {
        const record = await call(cdp, `nativeSessionInfo('codex', ${JSON.stringify(before.threadId)}, 'creation', ${JSON.stringify(task.task_id)})`, creationContext);
        if (typeof record?.nativeThreadId === 'string' && record.nativeThreadId
            && record.nativeThreadId.length <= 256 && !/[\0\r\n]/.test(record.nativeThreadId)) threadId = record.nativeThreadId;
      } catch { /* The original creation outcome remains UNKNOWN. */ }
    }
    throw Object.assign(error, { outcomeUnknown: true,
      ...(typeof threadId === 'string' && threadId && threadId !== before.threadId && threadId.length <= 256
        ? { created_session: { window_id: windowId, thread_id: threadId } } : {}) });
  }
}

export async function cancelExactNativeTurn(source, row, receipt, options = {}) {
  if (row.app === 'devin' && /^acp\d+$/.test(receipt)) {
    const prompt = options.prompt;
    if (typeof prompt !== 'string' || !prompt.trim()) fail('native_cancel_prompt_missing');
    const checkProject = context => {
      assertNativeProject(context, row.workspace, row.threadId);
      if (context.provider !== 'devin-cli' || context.roots?.length !== 1
          || !samePath(context.roots[0].root, row.workspace)) fail('native_cancel_project_or_provider_mismatch');
    };
    checkProject(await readNativeContext(source.cdp, 'devin', row.threadId));
    const state = await call(source.cdp, `nativeSessionInfo('devin', ${JSON.stringify(row.threadId)}, 'cancelState')`, contextFor(row));
    checkProject(await readNativeContext(source.cdp, 'devin', row.threadId));
    if (!state?.active || state.thread !== row.threadId || state.providerId !== 'devin-cli'
        || !['string', 'number'].includes(typeof state.turnId) || !str(state.turnId) || str(state.turnId).length > 300
        || state.human?.i !== receipt || !matchesDevinNativePrompt(state.human.t, prompt)
        || !state.request?.key || !['string', 'number'].includes(typeof state.request.id)
        || !str(state.request.id) || typeof state.turnId === 'number' && !Number.isSafeInteger(state.turnId)
        || typeof state.request.id === 'number' && !Number.isSafeInteger(state.request.id))
      fail('cannot_prove_active_native_acp_turn_for_cancel');
    // Accept the two known LF representations above, then freeze the actual
    // native snapshot byte-exactly for all subsequent revalidation.
    const binding = JSON.stringify(state);
    if (binding.length > 64000 || options.binding !== undefined && options.binding !== binding) fail('native_cancel_turn_changed');
    return { binding, turn: { id: receipt, threadId: row.threadId, turnId: state.turnId,
      generationId: state.request.key, current: true, ended: false }, stop: async () => {
      await options.beforeStop?.();
      return call(source.cdp, `nativeSessionAction('devin', ${JSON.stringify(row.threadId)}, 'stop', ${JSON.stringify({
        messageId: receipt, prompt, turnId: state.turnId, providerId: state.providerId, project: row.workspace, cancelKey: binding,
      })})`, contextFor(row));
    } };
  }
  assertNativeProject(await readNativeContext(source.cdp, row.app, row.threadId), row.workspace, row.threadId);
  if (row.app === 'codex') {
    if (typeof options.prompt !== 'string' || !options.prompt.trim()) fail('native_cancel_prompt_missing');
    if (await call(source.cdp, `nativeSessionInfo('codex', ${JSON.stringify(row.threadId)}, 'cancelReady')`, contextFor(row)) !== true)
      fail('native_cancel_adapter_unavailable');
    const turn = await readCodexReceiptTurn(source.cdp, row, receipt, true);
    const context = await readNativeContext(source.cdp, row.app, row.threadId);
    assertNativeProject(context, row.workspace, row.threadId);
    if (context.app !== 'codex' || context.roots?.length !== 1 || !samePath(context.roots[0].root, row.workspace))
      fail('native_cancel_project_mismatch');
    if (!matchesCodexReceipt(row, receipt, turn) || !turn.current || !turn.active || turn.ended || turn.lastUserId !== turn.id)
      fail('cannot_prove_active_native_turn_for_cancel');
    const nativeInputKey = codexSubmissionInput(row, receipt, options.prompt, options.submission, turn);
    const binding = JSON.stringify({ threadId: turn.threadId, id: turn.id, turnId: turn.turnId,
      nativeInputKey, nativeIds: turn.nativeIds, lastUserId: turn.lastUserId });
    if (binding.length > 64000 || options.binding !== undefined && options.binding !== binding) fail('native_cancel_turn_changed');
    return { turn, binding, stop: async () => {
      await options.beforeStop?.();
      return call(source.cdp, `nativeSessionAction('codex', ${JSON.stringify(row.threadId)}, 'stop', ${JSON.stringify({
        messageId: receipt, nativeInputKey, project: row.workspace, turnId: turn.turnId, cancelKey: binding,
      })})`, contextFor(row));
    } };
  }
  const turn = await readNativeTurn(source.cdp, row, receipt);
  if (!turn?.id || !turn.turnId || turn.threadId !== row.threadId || !turn.current || turn.ended
      || ![turn.id, `${row.threadId}:user-message:${turn.id}`].includes(receipt)
      || row.app !== 'codex' && !turn.generationId) fail('cannot_prove_active_native_turn_for_cancel');
  const name = { messageId: receipt, turnId: turn.turnId, generationId: turn.generationId };
  return { turn, stop: async () => {
    await options.beforeStop?.();
    return call(source.cdp,
      `nativeSessionAction(${JSON.stringify(row.app)}, ${JSON.stringify(row.threadId)}, 'stop', ${JSON.stringify(name)})`, contextFor(row));
  } };
}
