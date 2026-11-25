import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { computerId, computerName, DATA_DIR } from '../../../lib/auth.mjs';
import { boundPeerWorkspace } from '../../peer/workspace.mjs';
import { fail, loadPolicy, privateDirectory, workspaceFor, sessionFor, inside } from './auth.mjs';
import { validateTool, exposedTools } from './tools.mjs';
import * as files from './local-files.mjs';
import { readSession, sendMessage } from './session.mjs';

const canonical = v => JSON.stringify(Object.keys(v).sort().map(k=>[k,v[k]]));
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const utc = () => new Date().toISOString();
const errCode = e => e.status && /^[a-z0-9_]+$/.test(e.message) ? e.message : ({ENOENT:'path_not_found',EEXIST:'file_exists',EACCES:'permission_denied',EPERM:'permission_denied',ENOTDIR:'invalid_path',ELOOP:'symlink_denied'}[e.code]||'operation_failed');
function writeRecord(file, value, creating=false) {
  const tmp=file+'.'+crypto.randomUUID()+'.tmp';let fd;
  try{
    fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    if(creating)fs.linkSync(tmp,file);else fs.renameSync(tmp,file);
    const dir=fs.openSync(path.dirname(file),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
    try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
  }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
export function createDispatch(configPath) {
  function checkedPolicy() {
    const p=loadPolicy(configPath);
    const protectedRoots=[DATA_DIR,path.join(os.homedir(),'.agent-remote')].map(d=>path.resolve(d));
    if(p.workspaces.some(w=>w.kind==='local' && protectedRoots.some(d=>inside(d,w.root)||inside(w.root,d))))
      throw fail('ra_internal_data_cannot_be_shared',403);
    return p;
  }
  const initial=checkedPolicy();
  const state=path.join(path.dirname(configPath),'operations-'+initial.clientId);
  fs.mkdirSync(state,{recursive:true,mode:0o700});privateDirectory(state);
  const active=new Set(), sessionLocks=new Set();
  function current(){
    const p=checkedPolicy();
    if(p.clientId!==initial.clientId || p.socketPath!==initial.socketPath)throw fail('integration_identity_changed_restart_required',403);
    return p;
  }
  const getRecord=id=>{try{return JSON.parse(fs.readFileSync(path.join(state,id+'.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
  const view=row=>{const {requestHash, ...safe}=row;return safe;};
  // Crash recovery is fail-closed: a previously reserved ID may have executed.
  // Only one live bridge can use this policy/socket/state directory.
  function status(id) {
    const row=getRecord(id);if(!row)throw fail('operation_not_found',404);
    if(row.state==='STARTED'&&!active.has(id))return {...view(row),state:'UNKNOWN',reason:'relay_restarted_or_receipt_not_persisted'};
    return view(row);
  }
  async function mutate(name,args,binding,run) {
    const id=args.operation_id,requestHash=hash(canonical(args)+'\n'+JSON.stringify(binding)+'\n'+name);
    const prior=getRecord(id);
    if(prior){if(prior.requestHash!==requestHash)throw fail('operation_id_conflict',409);return status(id);}
    if(fs.readdirSync(state).filter(n=>n.endsWith('.json')).length>=1000)throw fail('operation_journal_capacity',409);
    const file=path.join(state,id+'.json'), row={operation_id:id,tool:name,state:'STARTED',requestHash,startedAt:utc()};
    writeRecord(file,row,true);active.add(id);
    try{
      const result=await run();
      const next={...row,state:result.state||'SUCCEEDED',result,finishedAt:utc()};
      try{writeRecord(file,next);}catch{return {...view(row),state:'UNKNOWN',reason:'operation_result_not_persisted'};}
      return view(next);
    }catch(e){
      const code=errCode(e);
      const next={...row,state:e.status===502?'UNKNOWN':'FAILED',error:code,finishedAt:utc()};
      try{writeRecord(file,next);}catch{return {...view(row),state:'UNKNOWN',reason:'operation_result_not_persisted'};}
      return view(next);
    }finally{active.delete(id);}
  }
  return {socketPath:initial.socketPath, async run(message){
    const p=current();
    if(message.method==='tools/list')return {tools:exposedTools(p)};
    if(message.method!=='tools/call')throw fail('unsupported_method');
    const {name,args}=message;validateTool(name,args);
    if(!exposedTools(p).some(t=>t.name===name))throw fail('tool_not_authorized',403);
    const client='chatgpt:'+p.clientId;
    if(name==='list_devices'){
      const id=computerId(),nodes=new Map([[id,{id,label:computerName(),kind:'local'}]]);
      for(const w of p.workspaces.filter(w=>w.kind==='peer'))nodes.set(w.nodeId,{id:w.nodeId,label:w.label,kind:'peer'});
      return {devices:[...nodes.values()]};
    }
    if(name==='list_workspaces')return {workspaces:p.workspaces.map(w=>({workspace_id:w.id,label:w.label,device_id:w.kind==='local'?computerId():w.nodeId,kind:w.kind,permissions:w.permissions})),expires_at:p.expiresAt};
    if(name==='list_sessions')return {sessions:p.sessions.map(s=>({session_id:s.id,label:s.label,app:s.app,workspace_id:s.workspaceId,permissions:s.permissions}))};
    if(name==='operation_status')return status(args.operation_id);
    if(name==='read_session'||name==='send_message'){
      const permission=name==='read_session'?'read':'send';
      const {session,workspace}=sessionFor(p,args.session_id,permission);
      const binding={session,root:workspace.root};
      const recheck=()=>{const fresh=sessionFor(current(),args.session_id,permission);
        if(JSON.stringify({session:fresh.session,root:fresh.workspace.root})!==JSON.stringify(binding))throw fail('session_authorization_changed',403);};
      if(name==='read_session')return readSession(client,session,workspace);
      const lock=session.app+':'+session.threadId;
      if(sessionLocks.has(lock))throw fail('agent_operation_in_progress',409);
      sessionLocks.add(lock);
      try{return await mutate(name,args,binding,()=>{recheck();return sendMessage(client,session,workspace,args.text,args.operation_id,recheck);});}
      finally{sessionLocks.delete(lock);}
    }
    const writing=['create_file','save_file'].includes(name), w=workspaceFor(p,args.workspace_id,writing?'write':'read');
    if(w.kind==='peer'){
      const bound=boundPeerWorkspace(w.peerWorkspaceId,w.nodeId);
      if(bound.key!==w.bindingKey)throw fail('peer_binding_changed_reauthorization_required',403);
      if(writing)throw fail('peer_writes_not_enabled',403);
      const action=name==='list_files'?'list-files':'read-file';
      const reply=await bound.request(action,{path:args.path});
      if(reply.status!==200)throw fail('peer_request_rejected',reply.status);
      return {device_id:reply.computer,...reply.result};
    }
    if(name==='list_files')return files.listFiles(w.root,args.path);
    if(name==='read_file')return files.readFile(w.root,args.path);
    if(writing)return mutate(name,args,{workspace:w},()=>{
      const fresh=workspaceFor(current(),w.id,'write');
      if(JSON.stringify(fresh)!==JSON.stringify(w))throw fail('workspace_authorization_changed',403);
      return files.writeFile(w.root,args.path,args.content,name==='save_file'?args.expected_sha256:undefined);
    });
    throw fail('unknown_tool');
  }};
}
