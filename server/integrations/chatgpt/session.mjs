import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { openCode } from '../../opencode/state.mjs';
import { overviewSession, overviewPreview } from '../../overview.mjs';
import { withTemporarySession } from '../../session.mjs';
import { fail } from './auth.mjs';

// V1 sends only to exact, pre-authorized local OpenCode sessions. Other
// native sessions may be explicitly registered for bounded preview reads.
async function openCodeSession(s,w) {
  await openCode.connect();
  const live=await openCode.client.request('/session/'+encodeURIComponent(s.threadId),{
    directory:w.root,signal:AbortSignal.timeout(8000)});
  if(live?.id!==s.threadId || live.parentID || live.time?.archived || s.windowId!==w.root
      || fs.realpathSync(live.directory)!==w.root || !openCode.sessions.has(s.threadId))
    throw fail('native_session_identity_changed',409);
  return live;
}
export async function readSession(client,s,w) {
  if(s.app==='opencode'){
    const live=await openCodeSession(s,w);
    await openCode.loadMessages(s.threadId,undefined,AbortSignal.timeout(10000));
    const chat=openCode.chat(s.threadId,{rows:openCode.messageRows(s.threadId).slice(-20),tools:new Set(),children:false});
    const messages=chat.items.filter(x=>x.k==='human'||x.k==='assistant'||x.k==='notice')
      .slice(-20).map(x=>({role:x.k==='human'?'user':x.k==='assistant'?'assistant':'status',text:String(x.t||'').slice(0,8000),id:x.i}));
    return {session_id:s.id,native_thread_id:live.id,busy:!!chat.busy,waiting:!!chat.waiting,model:chat.model,messages};
  }
  const target={win:s.win,windowId:s.windowId,threadId:s.threadId};
  const {session}=overviewSession(client,target);
  if(session.app!==s.app || session.threadId!==s.threadId || session.windowId!==s.windowId || session.host || session.dormant
      || !session.workspace || fs.realpathSync(session.workspace)!==w.root)throw fail('native_session_identity_changed',409);
  const preview=await overviewPreview(client,target);
  return {session_id:s.id,native_thread_id:s.threadId,available:preview.available===true,busy:!!session.busy,
    waiting:!!session.waiting,model:preview.model,last:String(preview.last||'').slice(0,600),text:String(preview.text||'').slice(0,600),preview_only:true};
}
export async function sendMessage(client,s,w,text,id,recheck) {
  if(s.app!=='opencode')throw fail('native_send_not_enabled_for_app',403);
  if(!text.trim() || /^\s*\//.test(text))throw fail('plain_nonempty_message_required',400);
  await openCodeSession(s,w);
  const [statuses,permissions,questions]=await Promise.all([
    openCode.client.request('/session/status',{directory:w.root,signal:AbortSignal.timeout(8000)}),
    openCode.client.request('/permission',{directory:w.root,signal:AbortSignal.timeout(8000)}),
    openCode.client.request('/question',{directory:w.root,signal:AbortSignal.timeout(8000)})]);
  if((statuses[s.threadId] && statuses[s.threadId].type!=='idle')
      || permissions.some(p=>p.sessionID===s.threadId) || questions.some(q=>q.sessionID===s.threadId)
      || openCode.automaticSessions.has(s.threadId))throw fail('agent_busy_waiting_or_auto_approved',409);
  let receipt=null;
  // Implement the local RA client contract without a network WebSocket.
  const clientView=Object.assign(new EventEmitter(),{readyState:1,send(raw,options,done){const p=JSON.parse(raw);
    if(p.requestId===id && p.t==='sent' && !p.pending && p.messageId)receipt={state:'ACKNOWLEDGED',nativeMessageId:p.messageId};
    if(p.requestId===id && p.t==='sendFailed')receipt={state:'REJECTED',reason:'native_send_rejected'};
    if(typeof options==='function')options();else if(typeof done==='function')done();
  },ping(data){this.emit('pong',data);}});
  return withTemporarySession(clientView,client,async view=>{
    view.visible=view.notifyVisible=false;
    await view.attach({id:'opencode',windowId:w.root,threadId:s.threadId,project:{root:w.root,host:''}});
    if(view.app!==s.app || view.threadId!==s.threadId || view.openCodeDirectory!==w.root || !view.bindingReady)
      throw fail('ra_session_binding_not_verified',409);
    recheck();
    // Existing RA send path and original native-message receipt; no separate agent
    // process, no model/approval override and no automatic retry.
    try {await view.handle({t:'send',text,submit:true,requestId:id,sel:view.selectionKey()});}
    catch {return {state:'UNKNOWN',reason:'native_submission_unconfirmed'};}
    for(let i=0;!receipt && i<40;i++)await delay(100);
    return receipt||{state:'UNKNOWN',reason:'native_receipt_not_observed'};
  });
}
