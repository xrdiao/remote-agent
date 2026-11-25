import net from 'node:net';
import fs from 'node:fs';
import { createDispatch } from './dispatch.mjs';
const LIMIT=2*1024*1024;

// No TCP route is added to RA's public HTTP server. The only bridge is a Unix
// socket inside the locally owned 0700 directory named in the explicit policy.
export async function startChatgptBridge(configPath) {
  const dispatch=createDispatch(configPath), socketPath=dispatch.socketPath;
  if(fs.existsSync(socketPath))throw new Error('chatgpt_socket_exists_refuse_to_replace');
  const connections=new Set();
  const server=net.createServer(socket=>{
    if(connections.size>=8){socket.destroy();return;}
    connections.add(socket);socket.once('close',()=>connections.delete(socket));
    socket.setTimeout(105000,()=>socket.destroy());
    socket.on('error',()=>{});
    let parts=[],total=0,handled=false;
    socket.on('data',async data=>{
      if(handled)return;
      total+=data.length;
      if(total>LIMIT){handled=true;socket.destroy();return;}
      parts.push(data);
      const combined=Buffer.concat(parts);
      const end=combined.indexOf(10);
      if(end<0)return;
      handled=true;parts=[];
      let reply;
      try{
        if(end!==combined.length-1)throw Object.assign(new Error('one_request_per_connection'),{status:400});
        const result=await dispatch.run(JSON.parse(combined.subarray(0,end).toString('utf8')));
        reply={ok:true,result};
      }catch(error){reply={ok:false,error:error.status?error.message:'request_failed',status:error.status||500};}
      if(!socket.destroyed)socket.end(JSON.stringify(reply)+'\n');
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
  fs.chmodSync(socketPath,0o600);
  const inode=fs.lstatSync(socketPath);
  return {socketPath,close(){
    for(const socket of connections)socket.destroy();
    server.close();
    try{const now=fs.lstatSync(socketPath);if(now.isSocket()&&now.ino===inode.ino&&now.dev===inode.dev)fs.unlinkSync(socketPath);}catch(e){if(e.code!=='ENOENT')throw e;}
  }};
}
