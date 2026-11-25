// Local-only device connector; no public listener and no direct file/shell calls.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import WebSocket from 'ws';
import { readPrivateJson, loadPolicy, workspaceFor, sessionFor } from '../../server/integrations/chatgpt/auth.mjs';
import { sign,verify,envelope,checkCall,localHost,TOKEN_RE,UUID_RE,FRAME_LIMIT,bytes } from './protocol.mjs';

const file=process.argv[2];
if(process.argv.length!==3||!file||!path.isAbsolute(file))throw new Error('Usage: node device.mjs /absolute/private/device.json');
const cfg=readPrivateJson(file);
const url=new URL(cfg.url);
if(cfg.mode!=='local-test'||url.protocol!=='ws:'||!localHost(url.hostname)||url.pathname!=='/device'||url.search||url.hash||url.username||url.password
    ||!TOKEN_RE.test(cfg.deviceToken||'')||!TOKEN_RE.test(cfg.linkKey||'')||cfg.deviceToken===cfg.linkKey
    ||!Array.isArray(cfg.workspaces)||!Array.isArray(cfg.sessions))throw new Error('local_prototype_only');

function policy(){
  // Recheck local RA's actual grant and compare the pinned root/thread at every request.
  const p=loadPolicy(cfg.policyPath);
  if(p.clientId!==cfg.clientId||p.socketPath!==cfg.socketPath)throw new Error('bridge_identity_changed');
  for(const w of cfg.workspaces){const live=workspaceFor(p,w.id,'read');if(live.kind!=='local'||live.root!==w.root)throw new Error('workspace_changed');}
  for(const s of cfg.sessions){const live=sessionFor(p,s.id,'read');if(live.session.threadId!==s.threadId||live.session.app!==s.app||live.workspace.root!==s.root||!cfg.workspaces.some(w=>w.id===live.workspace.id&&w.root===s.root))throw new Error('session_changed');}
  return p;
}
function bridge(message){
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection(cfg.socketPath);let chunks=[],total=0,done=false;
    const end=(e,r)=>{if(done)return;done=true;socket.destroy();e?reject(e):resolve(r);};
    socket.setTimeout(10000,()=>end(new Error('bridge_timeout')));
    socket.on('error',()=>end(new Error('bridge_unavailable')));
    socket.once('connect',()=>socket.write(JSON.stringify(message)+'\n'));
    socket.on('data',data=>{
      total+=data.length;if(total>FRAME_LIMIT)return end(new Error('bridge_response_too_large'));
      chunks.push(data);
      if(data.includes(10)){try{end(null,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(e){end(e);}}
    });
    socket.on('close',()=>end(new Error('bridge_closed')));
  });
}
async function execute(name,args){
  checkCall(name,args);policy();
  if(args.workspace_id&&!cfg.workspaces.some(w=>w.id===args.workspace_id))throw new Error('workspace_denied');
  if(args.session_id&&!cfg.sessions.some(s=>s.id===args.session_id))throw new Error('session_denied');
  const r=await bridge({method:'tools/call',name,args});
  policy();
  if(!r.ok)return {ok:false,error:'local_ra_rejected'};
  if(name==='list_workspaces')r.result.workspaces=r.result.workspaces.filter(w=>cfg.workspaces.some(x=>x.id===w.workspace_id)).map(w=>({...w,permissions:['read']}));
  if(name==='list_sessions')r.result.sessions=r.result.sessions.filter(s=>cfg.sessions.some(x=>x.id===s.session_id)).map(s=>({...s,permissions:['read']}));
  if(name==='list_devices')r.result.devices=r.result.devices.filter(x=>x.kind==='local');
  return r;
}
policy();
let socket,heartbeat,reconnect,stopped=false,attempt=0;
function connect(){
  if(stopped)return;
  let connection=null,active=0;const seen=new Map();
  const ws=socket=new WebSocket(url,{headers:{authorization:'Bearer '+cfg.deviceToken},maxPayload:FRAME_LIMIT,handshakeTimeout:5000,perMessageDeflate:false});
  ws.on('open',()=>{
    // Protocol-level ping frames, not periodic application RPC calls.
    heartbeat=setInterval(()=>{if(ws.readyState===1)ws.ping();},30000);
  });
  ws.on('message',async (raw,binary)=>{
    let data;
    try {
      if(binary)throw new Error('bad_frame');
      data=await verify(cfg.linkKey,raw.toString('utf8'));
      if(data.device!==cfg.deviceId)throw new Error('wrong_device');
      if(data.kind==='hello'&&connection===null){
        policy();connection=data.connection;attempt=0;
        ws.send(await sign(cfg.linkKey,envelope('ready',cfg.deviceId,connection)));
        console.log('RA_GATEWAY_DEVICE_READY');return;
      }
      if(data.kind!=='call'||connection===null||data.connection!==connection||!UUID_RE.test(data.id||''))throw new Error('invalid_call');
      for(const [id,at] of seen)if(Date.now()-at>60000)seen.delete(id);
      if(seen.has(data.id))throw new Error('replay');
      if(seen.size>=256||active>=4)throw new Error('rate_limit');
      seen.set(data.id,Date.now());active++;
      let result;
      try{result=await execute(data.name,data.args);}catch{result={ok:false,error:'local_policy_or_bridge_rejected'};}
      finally{active--;}
      let reply;
      try{reply=await sign(cfg.linkKey,envelope('reply',cfg.deviceId,connection,{id:data.id,result}));}
      catch{reply=await sign(cfg.linkKey,envelope('reply',cfg.deviceId,connection,{id:data.id,result:{ok:false,error:'response_too_large'}}));}
      if(ws.readyState===1)ws.send(reply);
    }catch{ws.close(1008,'invalid or unauthorized frame');}
  });
  ws.on('error',()=>{});
  ws.once('close',()=>{
    clearInterval(heartbeat);if(stopped)return;
    console.log('RA_GATEWAY_DEVICE_OFFLINE');
    reconnect=setTimeout(connect,Math.min(15000,1000*2**Math.min(attempt++,4)));
  });
}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{
  stopped=true;clearTimeout(reconnect);clearInterval(heartbeat);socket?.terminate();
});
connect();
