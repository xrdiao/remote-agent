import { publicErrorCode } from './errors.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, computerId, computerName, listDevices, needsTotp } from '../../../lib/auth.mjs';
import { overviewSnapshot } from '../../overview.mjs';
import { readSessionHistory } from './session-history.mjs';
import { openCode } from '../../opencode/state.mjs';
import { terminalService } from '../../terminal-service.mjs';
import * as local from '../chatgpt/local-files.mjs';
import * as taskService from './tasks.mjs';
import { discoverNativeApps, sendNativeMessage, readNativeProgress, cancelNativeTask, createNativeTaskSession,
  prepareNativeTaskApproval, controlNativeSession } from './native-apps.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const text=(max=16000)=>({type:'string',minLength:1,maxLength:max});
const field=(name,max=1024)=>[name,text(max)];
const root = () => fs.realpathSync(process.env.RA_MCP_TEST_ROOT || os.homedir());
const checkedRoot = () => {const dir=root();if(!fs.statSync(dir).isDirectory())throw Error('root_unavailable');return dir;};
function inside(base,target) {
  const rel=path.relative(base,target);
  return rel===''||(!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep));
}
function qaSessionAllowed(row) {
  if(!process.env.RA_MCP_TEST_ROOT)return true;
  try {return !!row.workspace && inside(checkedRoot(),fs.realpathSync(row.workspace));}
  catch{return false;}
}
const selected = (device, args) => {
  const snapshot=overviewSnapshot(device.id);
  const list=snapshot.sessions.filter(s=>s.app===args.app&&s.windowId===args.window_id&&s.threadId===args.thread_id&&!s.dormant&&qaSessionAllowed(s));
  if(list.length!==1 || list[0].host)throw Error('session_not_found_or_remote');
  return list[0];
};
const getValidDevice = id => {
  const d=listDevices().find(x=>x.id===id);
  if(!d||needsTotp(d))throw Error('device_pairing_revoked');
  return d;
};
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const safeErr = publicErrorCode;
const opdir=path.join(DATA_DIR,'ra-mcp-operations');
const locks=new Set(),terminalOwner=new Map();
function record(id) {
  try{return JSON.parse(fs.readFileSync(path.join(opdir,id+'.json'),'utf8'));}
  catch(e){if(e.code==='ENOENT')return null;throw e;}
}
function persist(id,obj,create=false) {
  fs.mkdirSync(opdir,{recursive:true,mode:0o700});
  const name=path.join(opdir,id+'.json'),tmp=name+'.'+crypto.randomUUID()+'.tmp';
  try {
    fs.writeFileSync(tmp,JSON.stringify(obj),{flag:'wx',mode:0o600});
    if(create)fs.linkSync(tmp,name);
    else fs.renameSync(tmp,name);
  }finally{fs.rmSync(tmp,{force:true});}
}
async function mutating(device,name,args,action) {
  if(!uuid.test(args.operation_id||''))throw Error('invalid_operation_id');
  getValidDevice(device.id);
  const id=args.operation_id,key=sha(JSON.stringify([device.id,name,args]));
  const previous=record(id);
  if(previous){
    if(previous.hash!==key||previous.device!==device.id)throw Error('operation_id_conflict');
    if(name==='approve_task')throw Error('approval_operation_already_processed');
    return previous.state==='STARTED'?{...previous,state:'UNKNOWN',error:'unconfirmed_outcome'}:previous;
  }
  if(locks.has(id))throw Error('operation_in_progress');
  locks.add(id);
  const row={id,name,device:device.id,hash:key,state:'STARTED',at:Date.now()};
  fs.mkdirSync(opdir,{recursive:true,mode:0o700});
  try {
    if(fs.readdirSync(opdir).filter(n=>n.endsWith('.json')).length>=3000)throw Error('operation_log_full');
    persist(id,row,true);
    let done;
    try {
      const value=await action();
      done={...row,state:value?.state||'SUCCEEDED',result:value,completedAt:Date.now()};
    }catch(e){
      done={...row,state:e?.outcomeUnknown?'UNKNOWN':'FAILED',error:safeErr(e),completedAt:Date.now()};
    }
    try { persist(id,done);return done; }
    catch {
      // The action may already have happened. A receipt storage failure must never
      // turn that action into a retryable FAILED result. STARTED remains a fence
      // even when the best-effort UNKNOWN write also fails.
      const unknown={...row,state:'UNKNOWN',error:'operation_receipt_unconfirmed',
        ...(done.result!==undefined?{result:done.result}:{}),completedAt:Date.now()};
      try { persist(id,unknown); } catch {}
      return unknown;
    }
  }finally{locks.delete(id);}
}
const mutation={readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true};
const reading={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true};
const tool=(name,description,properties={},annotations=reading)=>({
  name,description,inputSchema:{type:'object',properties,required:Object.keys(properties),additionalProperties:false},
  annotations,securitySchemes:[{type:'oauth2',scopes:[annotations.readOnlyHint?'ra:read':'ra:control']}]
});
const file={path:text(1024)};
const sess={app:{type:'string',enum:['opencode','codex','cursor','devin']},window_id:text(2048),thread_id:text(256)};
const operation={operation_id:{type:'string',pattern:uuid.source}};
const terminal={terminal_id:text(64)};
const taskOptional=(max=2048)=>({type:'string',minLength:0,maxLength:max});
const taskId={task_id:{type:'string',pattern:uuid.source}};
const when={type:'string',enum:['idle','queue','now']};
const setting={kind:{type:'string',enum:['model','effort','fast']}};
const taskInput={app:sess.app,project_path:text(2048),prompt:text(16000),
  window_id:taskOptional(2048),thread_id:taskOptional(256),model:taskOptional(180),effort:taskOptional(80),fast:taskOptional(80),when,...operation};
const taskTool=(name,description,properties,required=[],annotations=reading)=>{
  const entry=tool(name,description,properties,annotations);
  entry.inputSchema.required=required;
  return entry;
};

export const definitions=[
  tool('list_devices','List the paired RA computer represented by this server.'),
  tool('list_agents','Discover native agents available on this paired computer.'),
  tool('list_sessions','List RA native agent sessions on this computer.'),
  taskTool('read_session','Read session status and bounded native conversation messages in chronological order. For Codex, Cursor and Devin, use limit (1–30) and next_before as before to page within recent history.',
    {...sess,limit:{type:'integer',minimum:1,maximum:30},before:text(2048)},Object.keys(sess)),
  taskTool('send_message','Send to an exact native session. Default idle refuses busy; explicitly choose queue or now (native steer/Devin interrupt). Unsupported modes fail. ACK is not completion.',{...sess,message:text(),when,...operation},[...Object.keys(sess),'message','operation_id'],mutation),
  tool('read_session_setting','Read native model/effort/fast candidates and checked values through the phone control path.',{...sess,...setting}),
  tool('set_session_setting','Set an exact advertised candidate and read it back. Settings apply to the next submission, including while a turn runs.',{...sess,...setting,value:text(180),...operation},mutation),
  tool('list_session_actions','Read the same native session management actions as the phone overview.',sess),
  taskTool('manage_session','Use the phone session manager for rename/archive/delete. Only advertised native actions are supported.',{...sess,action:{type:'string',enum:['rename','archive','delete']},name:taskOptional(80),...operation},[...Object.keys(sess),'action','operation_id'],mutation),
  tool('read_session_queue','Read this session native queue through the phone projection.',sess),
  taskTool('queue_action','Operate an exact native queue item through the phone executor; never simulate steer with stop+send.',{...sess,action:{type:'string',enum:['read','edit','send','remove']},queue_id:text(300),text:taskOptional(16000),...operation},[...Object.keys(sess),'action','queue_id','operation_id'],mutation),
  tool('operation_status','Inspect a durable receipt. An UNKNOWN result must not be resubmitted under a new ID.',operation),
  tool('list_files','List directory entries, relative to the paired computer root.',file),
  tool('read_file','Read bounded UTF-8 file and SHA-256 in the paired computer root.',file),
  tool('create_file','Create UTF-8 file without overwriting an existing file.',{...file,content:text(131072),...operation},mutation),
  tool('save_file','Replace existing UTF-8 file only if its SHA-256 matches.',{...file,content:text(131072),
    expected_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},...operation},mutation),
  tool('list_terminals','List RA terminals belonging to this paired client.'),
  tool('open_terminal','Open an RA terminal in the requested directory; shell commands can access other OS paths.',{cwd:text(1024),...operation},mutation),
  tool('send_terminal','Submit text to a previously opened RA terminal.',{...terminal,command:text(8192),...operation},mutation),
  tool('read_terminal','Read a snapshot of a previously opened RA terminal.',terminal),
  tool('close_terminal','Close a previously opened RA terminal.',{...terminal,...operation},mutation),
  taskTool('list_app_capabilities','Discover real native agent session capabilities for Codex, Cursor, Devin and OpenCode; unavailable sessions are not writable.',{},[]),
  taskTool('create_task','Persist a new queued RA task. Never starts execution until explicitly started.',taskInput,['app','project_path','prompt','operation_id'],mutation),
  taskTool('submit_task','Create and start an RA task in one idempotent operation. Returned RUNNING is not COMPLETED.',taskInput,['app','project_path','prompt','operation_id'],mutation),
  taskTool('start_task','Start an existing queued RA task, with a durable native submission receipt.',{...taskId,...operation},['task_id','operation_id'],mutation),
  taskTool('get_task','Poll real native agent state and return bounded output or pending approval.',taskId,['task_id']),
  taskTool('list_tasks','List tasks owned by the current paired device.',{},[]),
  taskTool('read_task_output','Read bounded native agent output for a task owned by this device.',taskId,['task_id']),
  taskTool('cancel_task','Cancel a queued task or request a native agent abort. Unknown outcomes are never retried automatically.',{...taskId,...operation},['task_id','operation_id'],mutation),
  taskTool('approve_task','Answer a native question or permission request through the native app. Codex backend file decisions apply to one request. Extra permissions use the native turn scope shown by grantScope. Poll get_task for matching command evidence. Codex command decisions without it remain UNCONFIRMED. Reject can cancel the turn. Never resend the same request.',{...taskId,kind:{type:'string',enum:['permission','question']},
    request_id:text(140),decision:{type:'string',enum:['once','reject']},answers_json:taskOptional(3200),...operation},
    ['task_id','kind','request_id','operation_id'],mutation),
  taskTool('retry_task','Explicitly clone a FAILED/CANCELLED task with a new ID. UNKNOWN cannot be auto-retried.',{...taskId,...operation},['task_id','operation_id'],mutation),

];
function checkArgs(def,args) {
  if(!args||typeof args!=='object'||Array.isArray(args))throw Error('invalid_args');
  if(Object.keys(args).some(k=>!Object.hasOwn(def.inputSchema.properties,k)))throw Error('invalid_args');
  for(const [name,schema] of Object.entries(def.inputSchema.properties)){
    const value=args[name];
    if(value===undefined&&!def.inputSchema.required.includes(name))continue;
    if (schema.type === 'integer') {
      if (!Number.isInteger(value) || value < schema.minimum || value > schema.maximum) throw Error('invalid_'+name);
      continue;
    }
    if(typeof value!=='string'||value.length<(schema.minLength||0)||value.length>(schema.maxLength||1e7)
      ||value.includes('\0')||schema.pattern&&!new RegExp(schema.pattern).test(value)
      ||schema.enum&&!schema.enum.includes(value))throw Error('invalid_'+name);
  }
}
async function readSession(device,args) {
  const row=selected(device,args);
  if(row.app==='opencode') {
    if (args.limit !== undefined || args.before !== undefined) throw Error('native_operation_unsupported');
    await openCode.connect();
    if(!openCode.sessions.has(row.threadId))throw Error('native_session_missing');
    await openCode.loadMessages(row.threadId,undefined,AbortSignal.timeout(10000));
    const chat=openCode.chat(row.threadId,{rows:openCode.messageRows(row.threadId).slice(-30),tools:new Set(),children:false});
    return {app:row.app,thread_id:row.threadId,busy:chat.busy,waiting:chat.waiting,
      messages:chat.items.filter(x=>['human','assistant','notice'].includes(x.k)).slice(-30)
        .map(x=>({role:x.k==='human'?'user':x.k==='assistant'?'assistant':'status',text:String(x.t||'').slice(0,8000)}))};
  }
  const history = await readSessionHistory(row, args);
  getValidDevice(device.id);
  const current = selected(device, args);
  if (current.workspace !== row.workspace) throw Error('native_project_context_mismatch');
  return { app: row.app, window_id: row.windowId, thread_id: row.threadId,
    busy: current.busy, waiting: current.waiting, status_known: current.statusKnown, ...history };
}

async function exec(device,name,args) {
  if(name==='list_devices')return {devices:[{id:computerId(),name:computerName(),kind:'local',root:checkedRoot()}]};
  if(name==='list_agents'){
    const s=overviewSnapshot(device.id);
    return {agents:[...new Set(s.sessions.filter(qaSessionAllowed).map(x=>x.app))].map(app=>({app,ready:s.sessions.some(x=>x.app===app&&!x.dormant&&qaSessionAllowed(x))}))};
  }
  if(name==='list_sessions'){
    const s=overviewSnapshot(device.id);
    return {sessions:s.sessions.filter(x=>!x.host&&qaSessionAllowed(x)).slice(0,150).map(x=>
      ({app:x.app,window_id:x.windowId,thread_id:x.threadId,title:x.title,workspace:x.workspace,
        busy:x.busy,waiting:x.waiting,dormant:!!x.dormant}))};
  }
  if(name==='read_session')return readSession(device,args);
  if(name==='operation_status'){
    const r=record(args.operation_id);
    if(!r||r.device!==device.id)throw Error('operation_not_found');
    return r.state==='STARTED'?{...r,state:'UNKNOWN',error:'unconfirmed_outcome'}:r;
  }
  if(name==='list_app_capabilities')
    return discoverNativeApps(device.id,qaSessionAllowed);
  const controlAuth={scope:'ra:control',allowSession:qaSessionAllowed};
  if(name==='read_session_setting')return controlNativeSession(device,{...args,action:'read_setting'}, {scope:'ra:read',allowSession:qaSessionAllowed});
  if(name==='set_session_setting')return mutating(device,name,args,()=>controlNativeSession(device,{...args,action:'set_setting'},controlAuth));
  if(name==='read_session_queue')return controlNativeSession(device,{...args,action:'read_queue'}, {scope:'ra:read',allowSession:qaSessionAllowed});
  if(name==='queue_action')return mutating(device,name,args,()=>controlNativeSession(device,{...args,action:'queue',queue_action:args.action},controlAuth));
  if(name==='list_session_actions')return controlNativeSession(device,{...args,action:'session_actions'}, {scope:'ra:read',allowSession:qaSessionAllowed});
  if(name==='manage_session')return mutating(device,name,args,()=>controlNativeSession(device,{...args,action:'manage_session',session_action:args.action},controlAuth));
  const submitExisting=async row=>{
    const native={app:row.app,window_id:row.window_id,thread_id:row.thread_id,
      project_path:row.project,message:row.prompt,operation_id:row.task_id,when:row.when,model:row.model,effort:row.effort,fast:row.fast,capture_native_submission:row.app==='codex',
      ...(row.mode==='new_native_session'?{created_session:row.native_creation}:{})};
    return sendNativeMessage(device,native,{scope:'ra:control',allowSession:qaSessionAllowed});
  };
  const createNative=row=>createNativeTaskSession(device,row,{scope:'ra:control',allowSession:qaSessionAllowed});
  if(name==='create_task')
    return mutating(device,name,args,()=>taskService.createTask(device,args));
  if(name==='submit_task')
    return mutating(device,name,args,async()=>{
      const created=taskService.createTask(device,args);
      return taskService.startTask(device,created.task_id,submitExisting,createNative);
    });
  if(name==='start_task')
    return mutating(device,name,args,()=>taskService.startTask(device,args.task_id,submitExisting,createNative));
  if(name==='get_task')
    return taskService.refreshTask(device,args.task_id,async row=>{
      const state=await readNativeProgress(device,{
        app:row.app,window_id:row.window_id,thread_id:row.thread_id,
        project_path:row.project,after_message_id:row.native_message_id,expected_prompt:row.prompt,
        expected_native_submission:row.native_submission,native_queued:row.native_queued,
        expected_command_approval:row.approval_response?.state==='UNCONFIRMED'
          || row.app==='codex' && row.window_id==='backend' && row.approval_response?.decision==='reject'
          ? row.approval_native_command : undefined,
        expected_turn_id:row.app==='devin'?row.approval_native_turn_id:undefined,
        expected_cancel_turn_id:row.app==='codex' && row.approval_response?.decision==='reject' ? row.native_submission?.turnId ?? row.approval_native_turn_id
          : row.app==='devin' && row.note==='native_cancel_requested_unconfirmed' ? row.cancel_native_turn_id : undefined,
        auth:{scope:'ra:read',allowSession:qaSessionAllowed}});
      return {busy:state.busy,waiting:state.waiting,text:state.last_reply,
        confirmedCompletion:state.can_confirm_completion,confirmedFailure:state.can_confirm_failure,error:state.native_error,nativeQueued:state.native_queued,confirmedCancellation:state.can_confirm_cancellation,
        currentTurn:state.current_turn,exactCompletion:state.exact_completion,note:state.reason,nativeSubmission:state.native_submission,
        pending:state.waiting_request,lastUserMessageId:state.last_user_message_id,nativeTurnId:state.native_turn_id,
        rejectedQuestion:state.native_question_rejection,rejectedPermission:state.native_permission_rejection,
        commandApproval:state.native_command_approval};
    });
  if(name==='list_tasks')return taskService.listTasks(device);
  if(name==='read_task_output'){
    const t=taskService.getStoredTask(device,args.task_id);
    return {task_id:t.task_id,app:t.app,state:t.state,progress:t.progress||'',output:t.output||'',error:t.error||''};
  }
  if(name==='cancel_task')
    return mutating(device,name,args,()=>taskService.cancelTask(device,args.task_id,
      (task,options)=>cancelNativeTask(device,task,{...options,auth:{scope:'ra:control',allowSession:qaSessionAllowed}})));
  if(name==='approve_task')
    return mutating(device,name,args,()=>taskService.approveTask(device,args.task_id,{
      kind:args.kind,request_id:args.request_id,decision:args.decision,
      answers:args.answers_json?JSON.parse(args.answers_json):[]},
      (task,options)=>prepareNativeTaskApproval(device,task,options,{scope:'ra:control',allowSession:qaSessionAllowed})));
  if(name==='retry_task')
    return mutating(device,name,args,()=>taskService.retryTask(device,args.task_id));
  if(name==='list_files')return local.listFiles(checkedRoot(),args.path);
  if(name==='read_file')return local.readFile(checkedRoot(),args.path);
  if(name==='save_file'||name==='create_file')
    return mutating(device,name,args,()=>local.writeFile(checkedRoot(),args.path,args.content,
      name==='save_file'?args.expected_sha256:undefined));
  if(name==='send_message')return mutating(device,name,args,()=>
    sendNativeMessage(device,args,{scope:'ra:control',allowSession:qaSessionAllowed}));
  if(name==='list_terminals'){
    const owned=[...terminalOwner].filter(([,id])=>id===device.id);
    return {terminals:terminalService.list().filter(t=>owned.some(([tid])=>t.id===tid))};
  }
  if(name==='read_terminal'){
    if(terminalOwner.get(args.terminal_id)!==device.id)throw Error('terminal_not_owned');
    return terminalService.snapshot(args.terminal_id);
  }
  if(name==='open_terminal')return mutating(device,name,args,async()=>{
    const cwd=fs.realpathSync(path.resolve(checkedRoot(),args.cwd));
    if(!fs.statSync(cwd).isDirectory()||process.env.RA_MCP_TEST_ROOT&&!inside(checkedRoot(),cwd))throw Error('invalid_terminal_directory');
    const t=await terminalService.create({cwd});terminalOwner.set(t.id,device.id);
    return {terminal_id:t.id,terminal:terminalService.snapshot(t.id)};
  });
  if(name==='send_terminal')return mutating(device,name,args,async()=>{
    if(terminalOwner.get(args.terminal_id)!==device.id)throw Error('terminal_not_owned');
    await terminalService.submit(args.terminal_id,args.command);
    return {sent:true,terminal_id:args.terminal_id};
  });
  if(name==='close_terminal')return mutating(device,name,args,async()=>{
    if(terminalOwner.get(args.terminal_id)!==device.id)throw Error('terminal_not_owned');
    await terminalService.close(args.terminal_id);terminalOwner.delete(args.terminal_id);
    return {closed:true};
  });
  throw Error('tool_not_found');
}
export async function runTool(device,scope,name,args) {
  const d=definitions.find(x=>x.name===name);
  if(!d)throw Error('tool_not_found');
  checkArgs(d,args);
  if(!String(scope||'').split(/\s+/).includes('ra:control')&&!d.annotations.readOnlyHint)throw Error('write_scope_required');
  if (name === 'read_session' && !String(scope || '').split(/\s+/).some(value => value === 'ra:read' || value === 'ra:control'))
    throw Error('scope_required');
  getValidDevice(device.id);
  return exec(device,name,args);
}
