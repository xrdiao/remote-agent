// RA MCP durable task lifecycle, independent of the OAuth transport.
// Native app adapters are injected by the MCP tool dispatcher.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertSendMode } from '../../agent/control.mjs';
import { DATA_DIR } from '../../../lib/auth.mjs';
import { OPENCODE_URL } from '../../config.mjs';
import { isAbortedOpenCodeRequest } from '../../opencode/requests.mjs';
import { normalizeOpenCodeQuestions, validateOpenCodeAnswers, openCodeQuestionRejection, openCodePermissionRejection } from './questions.mjs';

const DIR = process.env.RA_MCP_TASKS_DIR || path.join(DATA_DIR, 'ra-mcp-tasks-v1');
const APPS = new Set(['opencode', 'codex', 'cursor', 'devin']);
const LOCKS = new Map();
const STATES = new Set(['QUEUED','STARTING','CREATED','SUBMITTING','RUNNING','WAITING','COMPLETED','FAILED','CANCELLED','UNKNOWN']);
const MODEL = /^[A-Za-z0-9._:-]+\/[A-Za-z0-9._:+-]+$/;
const REQUEST_ID = /^[A-Za-z0-9_.:-]{4,160}$/;
const uid = () => crypto.randomUUID();
const limit = (x,n) => String(x || '').slice(0,n);
const inside = (base,target) => {
  const rel = path.relative(base,target);
  return rel === '' || !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..'+path.sep);
};
function taskModel(value, app) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 180 || /[\0\r\n]/.test(value) || app === 'opencode' && !MODEL.test(value)) throw Error('invalid_task_model');
  return value;
}
function ownsRequest(request, row) {
  return !!request && (request.sessionID === row.thread_id || request.sessionId === row.thread_id);
}
function validatePermission(row, request, pending) {
  if (!ownsRequest(request, row) || request.id !== pending.id || !REQUEST_ID.test(String(request.id)))
    throw Error('native_request_identity_mismatch');
  const patterns = request.patterns;
  if (!Array.isArray(patterns) || !patterns.length || patterns.length > 20) throw Error('invalid_permission_patterns');
  if (patterns.some(pattern => typeof pattern !== 'string' || !pattern || pattern.length > 1024)) throw Error('invalid_permission_patterns');
  if (request.permission !== pending.permission) throw Error('native_request_changed');
  const stored = Array.isArray(pending.patterns) ? pending.patterns : [];
  if (JSON.stringify(stored) !== JSON.stringify(patterns)) throw Error('native_request_changed');
}
function validateQuestion(row, request, pending) {
  if (!ownsRequest(request, row) || request.id !== pending.id || !REQUEST_ID.test(String(request.id)))
    throw Error('native_request_identity_mismatch');
  const shape = normalizeOpenCodeQuestions(request.questions);
  if (JSON.stringify(pending.questions) !== JSON.stringify(shape)) throw Error('native_request_changed');
  return shape;
}
function root() {
  const base = fs.realpathSync(process.env.RA_MCP_TEST_ROOT || os.homedir());
  if (!fs.statSync(base).isDirectory()) throw Error('task_root_unavailable');
  return base;
}
function projectRoot(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || !path.isAbsolute(value))
    throw Error('invalid_task_project');
  const real = fs.realpathSync(value);
  if (!inside(root(),real) || !fs.statSync(real).isDirectory()) throw Error('task_project_outside_paired_root');
  return real;
}
function dir() {
  fs.mkdirSync(DIR,{recursive:true,mode:0o700});
  return DIR;
}
function file(id) {
  if (!/^[0-9a-f-]{36}$/.test(String(id||''))) throw Error('invalid_task_id');
  return path.join(dir(),id+'.json');
}
function load(device,id) {
  let row;
  try { row=JSON.parse(fs.readFileSync(file(id),'utf8')); }
  catch(e){if(e.code==='ENOENT')throw Error('task_not_found');throw e;}
  if (row.device!==device.id) throw Error('task_not_found');
  return row;
}
function save(row,create=false) {
  if (!STATES.has(row.state)) throw Error('invalid_task_state');
  const target=file(row.task_id);
  if (!create) {
    let previous;
    try { previous=JSON.parse(fs.readFileSync(target,'utf8')); }
    catch(error) { if(error.code!=='ENOENT') throw error; }
    const digest=crypto.createHash('sha256').update(row.prompt).digest('hex');
    if (previous && (previous.prompt!==row.prompt || previous.task_id!==row.task_id || previous.device!==row.device
      || previous.prompt_sha256 && previous.prompt_sha256!==digest)) throw Error('task_prompt_immutable');
    row.prompt_sha256=digest;
  }
  const tmp=target+'.'+uid()+'.tmp';
  row.updated=Date.now();
  try {
    fs.writeFileSync(tmp,JSON.stringify(row),{flag:'wx',mode:0o600});
    if (create) fs.linkSync(tmp,target);
    else fs.renameSync(tmp,target);
  } finally {fs.rmSync(tmp,{force:true});}
  return row;
}
function publicTask(row) {
  const {prompt,native_submission,approval_native_command, ...rest}=row;
  return {...rest,prompt_preview:limit(prompt,700),prompt_sha256:crypto.createHash('sha256').update(prompt).digest('hex')};
}
async function exclusive(key,fn) {
  const old=LOCKS.get(key)||Promise.resolve();
  const next=old.catch(()=>{}).then(fn);
  LOCKS.set(key,next);
  next.finally(()=>{if(LOCKS.get(key)===next)LOCKS.delete(key);}).catch(()=>{});
  return next;
}
async function api(route,{method='GET',body,timeout=11000}={}) {
  let response;
  try {response=await fetch(OPENCODE_URL+route,{method,headers:body?{'content-type':'application/json'}:{},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(timeout)});}
  catch(e){throw Object.assign(Error('native_api_unavailable'),{outcomeUnknown:method!=='GET'});}
  const str=await response.text();
  let value=null;try{value=JSON.parse(str);}catch{}
  if (!response.ok) throw Object.assign(Error('native_http_'+response.status),{outcomeUnknown:method!=='GET'&&response.status>=500});
  // OpenCode prompt_async and abort acknowledge successful asynchronous operations via HTTP 204.
  // A 204 has no JSON body; a generic HTTP 200 with an empty body remains unconfirmed.
  if (response.status===204 && method!=='GET') return { accepted: true, httpStatus: 204 };
  return value;
}
const qs = root => '?directory='+encodeURIComponent(root);
const sessionUrl = row => '/session/'+encodeURIComponent(row.thread_id)+qs(row.project);
const sessionApi = (row,suffix='',opts={}) => api('/session/'+encodeURIComponent(row.thread_id)+suffix+qs(row.project),opts);

function currentOpenCodeTurn(row, messages) {
  if (!Array.isArray(messages)) return false;
  const users=messages.filter(item=>item.info?.role==='user');
  // A dedicated session's HTTP ACK is not itself a message ID. Bind only the
  // sole native user message with the exact immutable submitted prompt.
  if(row.mode==='new_opencode_session' && row.native_message_id==='native_session:'+row.thread_id && users.length===1){
    const first=users[0], text=(first.parts||[]).filter(part=>part.type==='text').map(part=>part.text||'').join('\n');
    if(first.info.id && text===row.prompt){row.native_message_id=first.info.id;save(row);}
  }
  return !!row.native_message_id && users.at(-1)?.info?.id===row.native_message_id;
}

export function createTask(device,args) {
  if (!APPS.has(args.app)) throw Error('unsupported_task_app');
  if (typeof args.prompt!=='string' || !args.prompt.trim() || Buffer.byteLength(args.prompt)>16000)
    throw Error('invalid_task_prompt');
  const project=projectRoot(args.project_path);
  const windowId=limit(args.window_id,2048),threadId=limit(args.thread_id,256);
  if ((!!windowId)!=(!!threadId)) throw Error('task_native_session_must_be_complete');
  const model=taskModel(args.model,args.app);
  const when=args.when||'idle';
  if(!['idle','now','queue'].includes(when))throw Error('invalid_when');
  for(const kind of ['effort','fast'])if(args[kind]!==undefined&&(typeof args[kind]!=='string'||args[kind].length>80||/[\0\r\n]/.test(args[kind])))throw Error('invalid_'+kind);
  const task_id=uid();
  const row={task_id,device:device.id,app:args.app,project,prompt:args.prompt,
    prompt_sha256:crypto.createHash('sha256').update(args.prompt).digest('hex'),window_id:windowId,
    thread_id:threadId,model,when,effort:args.effort||'',fast:args.fast||'',state:'QUEUED',attempt:0,created:Date.now(),
    updated:Date.now(),native_message_id:'',pending:null,output:'',error:'',note:'',
    mode:windowId?'existing_session':args.app==='opencode'?'new_opencode_session':'new_native_session'};
  save(row,true);
  return publicTask(row);
}
export function listTasks(device, {max=60}={}) {
  const out=[];
  for(const f of fs.readdirSync(dir()).filter(x=>x.endsWith('.json')).slice(-3000)) {
    try {const row=JSON.parse(fs.readFileSync(path.join(DIR,f),'utf8'));
      if(row.device===device.id)out.push(publicTask(row));}catch{}
  }
  return {tasks:out.sort((a,b)=>b.created-a.created).slice(0,Math.max(1,Math.min(100,max)))};
}
export function getStoredTask(device,id) {return publicTask(load(device,id));}
export async function startTask(device,id,sendExisting,createNative) {
  return exclusive(device.id+':'+id,async()=>{
    let row=load(device,id);
    if(row.state!=='QUEUED')return publicTask(row);
    row.state='STARTING';save(row);
    let uncertain=false;
    try{
      taskModel(row.model,row.app);
      assertSendMode(row.app,row.when||'idle');
      if(['cursor','devin'].includes(row.app)&&row.when&&row.when!=='idle')throw Error('native_task_control_receipt_unavailable');
      if(projectRoot(row.project)!==row.project)throw Error('task_project_changed');
      if(row.mode==='new_native_session'||row.mode==='new_opencode_session'){
        if(typeof createNative!=='function')throw Error('native_creation_adapter_unavailable');
        uncertain=true;
        const created=await createNative(row);
        if(!created?.window_id||!created?.thread_id)throw Error('native_independent_session_unconfirmed');
        row.window_id=created.window_id;row.thread_id=created.thread_id;
        row.native_creation={task_id:row.task_id,app:row.app,project:row.project,
          window_id:created.window_id,thread_id:created.thread_id,transport:created.transport};
        row.state='CREATED';save(row);
      }
      row.state='SUBMITTING';save(row);
      uncertain=true;
      if(typeof sendExisting!=='function')throw Error('native_adapter_not_connected');
      const outcome=await sendExisting(row);
      if(outcome?.native_message_id)row.native_message_id=outcome.native_message_id;
      row.native_request_id=String(outcome?.request_id||'').slice(0,160);
      row.native_queued=outcome?.queued===true;
      row.native_queue_id=outcome?.native_queue_id||'';
      if(outcome?.state!=='ACKNOWLEDGED'||!outcome.native_message_id)
        throw Error(outcome?.reason||'native_submit_not_confirmed');
      if(row.app==='codex' && row.window_id!=='backend' && !row.native_queued){
        if(!outcome.native_submission)throw Error('native_submission_receipt_missing');
        row.native_submission=outcome.native_submission;
      }
      row.state='RUNNING';row.submitted=Date.now();save(row);return publicTask(row);
    } catch(error){
      if(row.mode!=='existing_session' && error?.created_session?.window_id && error.created_session.thread_id && !row.thread_id){
        row.window_id=error.created_session.window_id;row.thread_id=error.created_session.thread_id;
      }
      // A failed preflight does not undo creation. Preserve its identity and
      // prohibit retryTask from creating a replacement session automatically.
      const created=row.mode!=='existing_session' && !!row.window_id && !!row.thread_id;
      row.state=created || uncertain&&error?.outcomeUnknown!==false?'UNKNOWN':'FAILED';row.error=limit(error.message,400);save(row);
      return publicTask(row);
    }
  });
}
function reconcileCodexCommandApproval(row, evidence) {
  const expected = row.approval_native_command, response = row.approval_response;
  if (row.app !== 'codex' || response?.state !== 'UNCONFIRMED' || !evidence || !expected
      || evidence.itemId !== expected.itemId || evidence.turnId !== expected.turnId
      || evidence.outcome !== (response.decision === 'once' ? 'executed' : 'declined')) return false;
  row.approval_response = { request_id: response.request_id, decision: response.decision,
    state: 'CONFIRMED', evidence };
  return true;
}
export async function refreshTask(device,id,readExisting) {
  return exclusive(device.id+':'+id,async()=>{
    const row=load(device,id);
    // Older confirmed cancellations may retain an already-aborted request.
    // Reconcile only its exact native request/tool/user; do not answer it.
    if(row.app==='opencode' && row.state==='CANCELLED' && row.note==='native_cancel_acknowledged'
        && row.native_message_id && ['question','permission'].includes(row.pending?.kind) && REQUEST_ID.test(row.pending.id)) {
      try {
        const [messages, requests]=await Promise.all([sessionApi(row,'/message'),api('/'+row.pending.kind+qs(row.project))]);
        const request=Array.isArray(requests)?requests.find(item=>item?.id===row.pending.id && ownsRequest(item,row)):null;
        if(isAbortedOpenCodeRequest(request,messages,row.thread_id,row.native_message_id)) {
          row.pending=null;row.note='native_cancel_aborted_request_confirmed';save(row);
        }
      } catch { /* Preserve the original terminal receipt when native proof is unavailable. */ }
    }
    if(['QUEUED','FAILED','CANCELLED','COMPLETED'].includes(row.state)){
      if (row.app==='codex' && row.approval_response?.state==='UNCONFIRMED' && row.approval_native_command
          && typeof readExisting==='function') {
        let status;
        try { status=await readExisting(row); } catch { /* Preserve the terminal task and pending receipt. */ }
        if (reconcileCodexCommandApproval(row,status?.commandApproval)) save(row);
      }
      return publicTask(row);
    }
    if (['cursor','devin'].includes(row.app) && row.native_queued && row.state==='RUNNING') {
      row.state='UNKNOWN';row.note='native_queue_promotion_receipt_unavailable';save(row);
    }
    if (row.state === 'UNKNOWN') {
      // Native ACP cancel may have no immediate ACK. Only the exact frozen
      // turn's explicit native stop reason can settle this task.
      if (row.app === 'devin' && row.note === 'native_cancel_requested_unconfirmed'
          && row.cancel_native_turn_id !== undefined && row.native_message_id && typeof readExisting === 'function') {
        let evidence;
        try { evidence = await readExisting(row); } catch { /* fail closed */ }
        if (evidence?.confirmedCancellation === true && evidence.currentTurn === true
            && evidence.busy === false && !evidence.waiting && !evidence.pending
            && evidence.lastUserMessageId === row.native_message_id
            && evidence.nativeTurnId === row.cancel_native_turn_id) {
          row.state='CANCELLED';row.cancelled=Date.now();row.pending=null;row.error='';
          row.note='native_cancel_exact_turn_reconciled';save(row);
        }
        return publicTask(row);
      }
      // A desktop Agent may consume a native question/permission despite omitting a
      // boolean tool ACK. Reconcile only from a verified terminal reply for
      // THIS exact already-consumed request and the unchanged native user turn.
      if ((row.app === 'cursor' && row.pending?.kind === 'question'
          || row.app === 'devin' && ['permission','question'].includes(row.pending?.kind) && row.approval_native_turn_id !== undefined)
          && row.note === 'native_approval_submit_unconfirmed'
          && row.answered_request_ids?.includes(row.pending.id)
          && row.native_message_id && typeof readExisting === 'function') {
        let evidence;
        try { evidence = await readExisting(row); } catch { /* fail closed */ }
        if (evidence?.confirmedCompletion === true
            && (evidence.currentTurn === true || evidence.exactCompletion === true)
            && evidence.busy === false && !evidence.waiting && !evidence.pending
            && evidence.lastUserMessageId === row.native_message_id
            && (row.app !== 'devin' || evidence.nativeTurnId === row.approval_native_turn_id)
            && String(evidence.text || '').trim()) {
          row.state = 'COMPLETED';
          row.output = limit(evidence.text, 16000);
          row.pending = null; row.error = '';
          row.note = 'native_approval_exact_turn_reconciled';
          row.completed = Date.now();
          save(row);
        }
      }
      return publicTask(row);
    }
    if(!row.thread_id)return publicTask({...row,state:'UNKNOWN',note:'native_session_not_confirmed'});
    {
      if(typeof readExisting!=='function')return publicTask({...row,note:'native_status_adapter_unavailable'});
      const status=await readExisting(row);
      if(status?.nativeSubmission){row.native_submission=status.nativeSubmission;row.native_queued=false;}
      if(status?.nativeQueued===false)row.native_queued=false;
      reconcileCodexCommandApproval(row,status?.commandApproval);
      const candidate=status?.pending;
      const pending=candidate&&typeof candidate==='object'&&!Array.isArray(candidate)
        &&['permission','question'].includes(candidate.kind)&&REQUEST_ID.test(String(candidate.id||''))?candidate:null;
      row.note=limit(status?.note,300);
      row.pending=['codex','cursor','devin'].includes(row.app) && row.answered_request_ids?.includes(pending?.id)?null:pending;
      row.native_last_user_message_id=limit(status?.lastUserMessageId,200);
      // Only the adapter's exact current turn may publish ordinary assistant text.
      // Final output remains reserved for confirmed completion.
      if(status?.currentTurn===true && row.native_message_id && status.lastUserMessageId===row.native_message_id
          && typeof status.text==='string' && status.text.trim()) row.progress=limit(status.text,16000);
      if(row.app==='opencode' && status?.note==='native_session_missing'){
        row.state='UNKNOWN';row.note='native_session_no_longer_exists';row.error='native_session_missing';row.pending=null;
      }
      else if(status?.confirmedFailure){row.state='FAILED';row.error=limit(status.error||'native_turn_failed',2000);row.pending=null;}
      else if(status?.waiting){
        row.state='WAITING';
        if (!row.pending) row.note = pending && row.approval_response?.request_id === pending.id
          ? 'native_approval_submit_unconfirmed' : 'native_approval_request_unverifiable';
      }
      else if(status?.busy)row.state='RUNNING';
      else if(row.app==='codex' && row.approval_response?.decision==='reject' && status?.confirmedCancellation===true
          && status.lastUserMessageId===row.native_message_id
          && status.nativeTurnId===(row.native_submission?.turnId ?? row.approval_native_command?.turnId ?? row.approval_native_turn_id)) {
        row.state='CANCELLED';row.cancelled=Date.now();row.pending=null;row.error='';
        row.note='native_turn_interruption_confirmed';
      }
      else if(status?.confirmedCompletion && (status.currentTurn===true || status.exactCompletion===true) && String(status.text||'').trim()) {
        row.state='COMPLETED';row.output=limit(status.text,16000);
        row.completed=Date.now();
      } else if(status?.currentTurn===true && reconcileOpenCodeQuestionRejection(row,status.rejectedQuestion)) {
        // The native question was dismissed; absence of a final answer is not completion.
      } else if(status?.currentTurn===true && status.busy===false && !status.pending
          && reconcileOpenCodePermissionRejection(row,status.rejectedPermission)) {
        // Exact native rejection plus our persisted ACK proves this turn stopped.
      } else row.state='RUNNING';
      save(row);return publicTask(row);
    }
  });
}

export async function cancelTask(device,id,cancelExisting) {
  return exclusive(device.id+':'+id,async()=>{
    const row=load(device,id);
    if(row.state==='QUEUED'){row.state='CANCELLED';save(row);return publicTask(row);}
    if(['CANCELLED','COMPLETED','FAILED'].includes(row.state))return publicTask(row);
    if(row.state==='UNKNOWN')return publicTask({...row,note:'unconfirmed_outcome_manual_reconcile_required'});
    if(!row.thread_id||!row.window_id)throw Error('native_session_not_confirmed');
    const acpCancel=row.app==='devin' && /^acp\d+$/.test(row.native_message_id);
    const exactCancel=acpCancel || row.app==='codex';
    if(exactCancel && projectRoot(row.project)!==row.project)throw Error('task_project_changed');
    const cancelRecord=()=>({...publicTask(row),prompt:row.prompt,native_submission:row.native_submission});
    let binding;
    if(row.app==='opencode'){
      // A reused native session may have advanced to a different person's turn
      // after this task was submitted. Never abort another turn.
      let messages;
      try { messages=await sessionApi(row,'/message'); } catch { messages=null; }
      if(!currentOpenCodeTurn(row,messages)){
        row.state='UNKNOWN';row.note='cannot_prove_active_native_turn_for_cancel';save(row);
        return publicTask(row);
      }
    }
    {
      // Refuse unsupported/unimplemented adapters before touching task state.
      if(typeof cancelExisting!=='function')throw Error('native_cancel_adapter_unavailable');
      const preflight=await cancelExisting(cancelRecord(),{checkOnly:true});
      if(!preflight?.supported)throw Error(limit(preflight?.reason,200)||'native_cancel_adapter_unavailable');
      if(!row.native_message_id)throw Error('native_receipt_missing');
      binding=preflight.binding;
      if(exactCancel && (typeof binding?.native!=='string' || !binding.native || !binding.transport
          || !(typeof binding.turnId==='string' && binding.turnId.length>0 || Number.isSafeInteger(binding.turnId))))
        throw Error('native_cancel_binding_missing');
    }
    if(acpCancel)row.cancel_native_turn_id=binding.turnId;
    row.state='UNKNOWN';row.note='native_cancel_requested_unconfirmed';save(row);
    try{
      let ack;
      ack=await cancelExisting(cancelRecord(),{...(binding?{binding}:{})});
      const confirmed=ack?.supported===true&&ack?.state==='ACKNOWLEDGED';
      if(!confirmed)throw Error(row.app==='opencode'?'native_cancel_receipt_unconfirmed'
        :(limit(ack?.reason,200)||'native_cancel_receipt_unconfirmed'));
      row.state='CANCELLED';row.cancelled=Date.now();row.note='native_cancel_acknowledged';
      if(exactCancel || row.app==='opencode')row.pending=null;
      save(row);
    }catch(e){row.error=limit(e.message,300);save(row);}
    return publicTask(row);
  });
}
function reconcileOpenCodeQuestionRejection(row, evidence) {
  if (row.app !== 'opencode' || !evidence || evidence.sessionID !== row.thread_id
      || evidence.receipt !== row.native_message_id || !evidence.messageID || !evidence.callID
      || evidence.error !== 'The user dismissed this question' || !Number.isFinite(evidence.completed)) return false;
  const rejected = row.native_question_rejection;
  const confirmed = rejected?.acknowledged === true && rejected.requestId
    && rejected.sessionID === evidence.sessionID && rejected.receipt === evidence.receipt
    && rejected.messageID === evidence.messageID && rejected.callID === evidence.callID;
  row.state = confirmed ? 'CANCELLED' : 'UNKNOWN';
  row.note = confirmed ? 'native_question_rejection_confirmed' : 'native_question_rejected_without_terminal_reply';
  row.error = 'native_question_rejected'; row.pending = null;
  if (confirmed) row.completed = evidence.completed;
  return true;
}

function reconcileOpenCodePermissionRejection(row, evidence) {
  if (row.app !== 'opencode' || !evidence || evidence.sessionID !== row.thread_id
      || evidence.receipt !== row.native_message_id || !evidence.messageID || !evidence.callID
      || evidence.error !== 'The user rejected permission to use this specific tool call.'
      || !Number.isFinite(evidence.completed) || evidence.completed <= 0) return false;
  const rejected = row.native_permission_rejection;
  const confirmed = rejected?.acknowledged === true && rejected.requestId
    && rejected.sessionID === evidence.sessionID && rejected.receipt === evidence.receipt
    && rejected.messageID === evidence.messageID && rejected.callID === evidence.callID;
  row.state = confirmed ? 'CANCELLED' : 'UNKNOWN';
  row.note = confirmed ? 'native_permission_rejection_confirmed' : 'native_permission_rejected_without_terminal_reply';
  row.error = 'native_permission_rejected'; row.pending = null;
  if (confirmed) row.completed = evidence.completed;
  return true;
}

export async function approveTask(device,id,{kind,request_id,decision,answers=[]}={},prepareExisting) {
  return exclusive(device.id+':'+id,async()=>{
    const row=load(device,id);
    if(!['permission','question'].includes(kind))throw Error('invalid_approval_kind');
    if(typeof request_id!=='string'||!REQUEST_ID.test(request_id))throw Error('invalid_native_request_id');
    if(row.state!=='WAITING'||!row.pending||typeof row.pending!=='object'||Array.isArray(row.pending)
      ||row.pending.id!==request_id||row.pending.kind!==kind)
      throw Error('native_approval_not_current');
    const codexCommand = row.app === 'codex' && kind === 'permission' && row.pending.permission === 'commandExecution';
    const codexPermission = row.app === 'codex' && kind === 'permission';
    const nativeMethod = row.pending.native?.method;
    if((row.app==='codex' || row.app==='cursor' || row.app==='devin' && ['permission','question'].includes(kind)) && typeof prepareExisting==='function'){
      if(row.answered_request_ids?.includes(request_id))throw Error('native_approval_already_answered');
      if(!['once','reject'].includes(decision))throw Error(kind+'_must_be_once_or_reject');
      if(projectRoot(row.project)!==row.project)throw Error('task_project_changed');
      const prepared=await prepareExisting({...row},{kind,request_id,decision,answers});
      try{
        if(typeof prepared?.submit!=='function')throw Error('native_approval_adapter_unavailable');
        // Persist before the first native mutation, including option selection.
        if (codexCommand) {
          const { id: nativeRequestId, params } = JSON.parse(row.pending.permissionKey);
          row.approval_native_command = { requestId: nativeRequestId, turnId: params.turnId, itemId: params.itemId };
          row.approval_response = { request_id, decision, state: 'UNCONFIRMED' };
        }
        else {
          row.state = 'UNKNOWN';
          if (codexPermission) row.approval_response = { request_id, decision, state: 'UNCONFIRMED' };
        }
        row.note='native_approval_submit_unconfirmed';
        if(row.app==='devin' || row.app==='codex')row.approval_native_turn_id=row.pending.native.turnId;
        row.answered_request_ids=[...(row.answered_request_ids||[]),request_id];save(row);
        try{
          const submitted = await prepared.submit();
          if (submitted !== (codexCommand ? 'UNCONFIRMED' : true)) throw Error('native_approval_receipt_unconfirmed');
          row.pending = null;
          if (!codexCommand) {
            row.state = 'RUNNING'; row.error = ''; row.note = 'native_approval_acknowledged';
            if (codexPermission) row.approval_response = { request_id, decision, state: 'CONFIRMED',
              evidence: { method: nativeMethod, turnId: row.approval_native_turn_id, outcome: 'answered' } };
          }
        } catch (error) {
          if (codexPermission) row.approval_response.error = limit(error.message, 300);
          else row.error = limit(error.message, 300);
        }
        save(row);
        return publicTask(row);
      }finally{prepared?.release?.();}
    }
    if(row.app!=='opencode')throw Error('native_approval_adapter_unavailable');
    let messages;
    {
      // A reused session may have advanced past this task's user turn. Never
      // answer a request that belongs to somebody else's turn.
      try{messages=await sessionApi(row,'/message');}catch{throw Error('native_turn_unavailable');}
      if(!currentOpenCodeTurn(row,messages))
        throw Error('native_turn_changed');
    }
    if(kind==='permission'&&!['once','reject'].includes(decision))throw Error('permission_must_be_once_or_reject');
    if(kind==='question'&&!['once','reject'].includes(decision))throw Error('question_must_be_once_or_reject');
    const all=await api('/'+kind+qs(row.project));
    const request=Array.isArray(all)?all.find(item=>item && item.id===request_id && ownsRequest(item,row)):null;
    if(!request || isAbortedOpenCodeRequest(request,messages,row.thread_id))throw Error('native_request_expired');
    let reply;
    if(kind==='permission'){
      validatePermission(row,request,row.pending);
      reply={reply:decision};
    }
    else {
      const shape=validateQuestion(row,request,row.pending);
      if(decision==='once')reply={answers:validateOpenCodeAnswers(answers,shape)};
    }
    if(kind==='question' && decision==='reject') {
      const tool=request.tool;
      row.native_question_rejection={requestId:request_id,sessionID:row.thread_id,receipt:row.native_message_id,
        messageID:typeof tool?.messageID==='string'?limit(tool.messageID,300):'',
        callID:typeof tool?.callID==='string'?limit(tool.callID,300):'',acknowledged:false};
    }
    if(kind==='permission' && decision==='reject') {
      const tool=request.tool;
      row.native_permission_rejection={requestId:request_id,sessionID:row.thread_id,receipt:row.native_message_id,
        messageID:typeof tool?.messageID==='string'?limit(tool.messageID,300):'',
        callID:typeof tool?.callID==='string'?limit(tool.callID,300):'',acknowledged:false};
    }
    if(typeof prepareExisting!=='function')throw Error('native_approval_adapter_unavailable');
    const prepared=await prepareExisting({...row},{kind,request_id,decision,answers:reply?.answers,native_request:request});
    row.state='UNKNOWN';row.note='native_approval_submit_unconfirmed';save(row);
    try{
      const ack=await prepared.submit();
      if(ack!==true)throw Error('native_approval_receipt_unconfirmed');
      if(kind==='question' && decision==='reject') row.native_question_rejection.acknowledged=true;
      if(kind==='permission' && decision==='reject') row.native_permission_rejection.acknowledged=true;
      row.state='RUNNING';row.pending=null;row.note='native_approval_acknowledged';save(row);
    }catch(e){row.error=limit(e.message,300);save(row);}
    finally{prepared.release?.();}
    return publicTask(row);
  });
}
export function retryTask(device,id) {
  const row=load(device,id);
  if(!['FAILED','CANCELLED'].includes(row.state))throw Error('task_retry_not_safe');
  const retry=createTask(device,{app:row.app,project_path:row.project,prompt:row.prompt,
    window_id:row.mode==='existing_session'?row.window_id:'',
    thread_id:row.mode==='existing_session'?row.thread_id:'',model:row.model,when:row.when,effort:row.effort,fast:row.fast});
  const next=load(device,retry.task_id);
  next.retry_of=row.task_id;save(next);return publicTask(next);
}
