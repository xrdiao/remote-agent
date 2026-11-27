import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../../lib/auth.mjs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMcpAuthorization } from './authorization.mjs';
import { compactDefinitions, dispatchCompact, hasControl } from './compact.mjs';

const HEADERS = {'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};

// Temporary opt-in diagnostics, activated only by a local, time-bounded marker.
// Do not log arbitrary client-supplied strings, URLs, headers, payloads, IDs or error messages.
const TRACE_ROUTES = new Set(['/mcp','/oauth/register','/oauth/authorize','/oauth/pair','/oauth/status','/oauth/token',
  '/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server','/.well-known/openid-configuration']);
const TRACE_METHODS = new Set(['initialize','notifications/initialized','tools/list','tools/call','ping',
  'resources/list','prompts/list','resources/templates/list']);
const TRACE_VERSIONS = new Set(['2025-11-25','2025-06-18','2025-03-26','2024-11-05','2024-10-07']);
const TRACE_ERRORS = new Set([-32700,-32600,-32601,-32602,-32603,-32000,-32001,-32002]);
const versionKind = v => TRACE_VERSIONS.has(v)?v:v?'other':'missing';
const mediaKind = v => {
  const s=typeof v==='string'?v.toLowerCase():'';
  const j=s.includes('application/json'), e=s.includes('text/event-stream');
  return j&&e?'json+sse':j?'json':e?'sse':s.includes('application/x-www-form-urlencoded')?'form':s?'other':'missing';
};
function connectionDiagnostics() {
  let until=0;
  try {
    const marker=path.join(DATA_DIR,'ra-mcp-connection-diagnostic.json');
    if(fs.statSync(marker).size<=128){
      const t=JSON.parse(fs.readFileSync(marker,'utf8')).until;
      if(Number.isSafeInteger(t)&&t>Date.now()&&t<=Date.now()+15*60000)until=t;
    }
  } catch {}
  let remaining=180, seq=0;
  return (req,res,url) => {
    if(!until||Date.now()>=until||remaining<=0||!TRACE_ROUTES.has(url.pathname))return null;
    // The name, agent hint, and clientInfo are never copied from requests.
    const t={seq:++seq,route:url.pathname,httpMethod:['GET','POST','DELETE','OPTIONS'].includes(req.method)?req.method:'other',
      client:'unknown',auth:'not_checked',scope:'none',accept:mediaKind(req.headers.accept),
      contentType:mediaKind(req.headers['content-type']),version:versionKind(req.headers['mcp-protocol-version']),
      sessionHeader:Boolean(req.headers['mcp-session-id']),authorizationHeader:Boolean(req.headers.authorization),
      agentHint:/google|gemini/i.test(typeof req.headers['user-agent']==='string'?req.headers['user-agent']:'')?'google_hint':'unknown',
      rpc:[],rpcErrors:[],toolError:false,transportError:false};
    const start=Date.now();
    let reported=false;
    const finish=closed=>{
      if(reported)return;
      reported=true;
      if(t.client==='chatgpt'||Date.now()>=until||remaining<=0)return;
      remaining--;
      try { console.log('[ra-mcp-connection-trace] '+JSON.stringify({...t,httpStatus:res.headersSent?res.statusCode:null,
        responseType:mediaKind(res.getHeader('content-type')),closedBeforeFinish:closed,elapsedMs:Date.now()-start})); } catch {}
    };
    res.once('finish',()=>finish(false));
    res.once('close',()=>finish(!res.writableFinished));
    return t;
  };
}
function observeTransport(transport,t) {
  if(!t)return;
  const incoming=transport.onmessage;
  transport.onmessage=(message,extra)=>{
    try{
      const m=message?.method;
      if(t.rpc.length<8&&typeof m==='string'){
        const item={method:TRACE_METHODS.has(m)?m:'other'};
        if(m==='initialize')item.version=versionKind(message.params?.protocolVersion);
        t.rpc.push(item);
      }
    }catch{}
    return incoming?.(message,extra);
  };
  const send=transport.send.bind(transport);
  transport.send=(message,options)=>{
    try{
      if(message?.error&&t.rpcErrors.length<8)t.rpcErrors.push(TRACE_ERRORS.has(message.error.code)?message.error.code:'other');
      if(message?.result?.isError===true)t.toolError=true;
      if(Array.isArray(message?.result?.tools))t.toolCount=message.result.tools.length;
    }catch{}
    return send(message,options);
  };
}
export function createRemoteMcpServer(publicUrl) {
  const auth=createMcpAuthorization(publicUrl), beginTrace=connectionDiagnostics();
  async function handle(req,res,url) {
    const trace=beginTrace(req,res,url);
    // QA trace only: method/path/status; never log tokens, cookies, OAuth codes, or query strings.
    if (process.env.RA_MCP_TRACE === '1') res.once('finish', () =>
      console.log('[ra-mcp-qa]', req.method, url.pathname, res.statusCode));
    if(url.pathname!=='/mcp')return auth.handle(req,res,url,trace);
    if(req.headers.host!==new URL(publicUrl).host){
      res.writeHead(421,HEADERS).end('invalid_host');return;
    }
    const access=auth.token(req);
    if(trace){
      trace.auth=access?'valid':req.headers.authorization?'invalid':'missing';
      trace.client=access?auth.clientKind(access.client):'unknown';
      trace.scope=access?.scope.split(/\s+/).includes('ra:control')?'control':access?'read':'none';
    }
    if(!['POST','GET','DELETE'].includes(req.method)){
      res.writeHead(405,HEADERS).end();return;
    }
    // Preserve anonymous POST tool discovery, but challenge unauthenticated GET SSE connections.
    if (!access && req.method === 'GET') return auth.challenge(res);
    const sdk=new Server({name:'remote-agent',version:'0.3.0'},
      {capabilities:{tools:{}},instructions:[
        'Use ra_read for discovery and status, and ra_control for an authorized action.',
        'Discover exact parameters with ra_read describe. Existing safe idle sessions are reused by default.',
        'Use stable operation_id or client_request_id for retry. Never resend UNKNOWN under a new ID.',
        'Keep native permission and question requests pending until explicitly authorized.'
      ].join(' ')});
    const canWrite=hasControl(access?.scope);
    sdk.setRequestHandler(ListToolsRequestSchema,async()=>({tools:compactDefinitions.filter(tool=>
      !access||canWrite||tool.annotations.readOnlyHint)}));
    const oauthRequired=(scope,error='invalid_token')=>({
      content:[{type:'text',text:'Connect and approve this Remote Agent device to use this tool.'}],
      isError:true,
      _meta:{'mcp/www_authenticate':[
        'Bearer resource_metadata="'+auth.issuer+'/.well-known/oauth-protected-resource", error="'+error+
        '", error_description="Remote Agent device pairing required", scope="'+scope+'"'
      ]}
    });
    const cancellation = new AbortController();
    res.once('close', () => cancellation.abort());
    sdk.setRequestHandler(CallToolRequestSchema,async (message, context)=>{
      const {name,arguments:args={}}=message.params;
      const required=name==='ra_read'?'ra:read':'ra:control';
      if(!access)return oauthRequired(required);
      if(name==='ra_control'&&!canWrite)return oauthRequired(required,'insufficient_scope');
      return dispatchCompact(access,name,args,{
        signal: AbortSignal.any([cancellation.signal, context.signal]),
        authorized: () => {
          const current = auth.token(req);
          return current?.device.id === access.device.id && current.client === access.client && current.scope === access.scope;
        },
      });
    });
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    try {
      await sdk.connect(transport);
      observeTransport(transport,trace);
      await transport.handleRequest(req,res);
    }catch(error){
      if(trace)trace.transportError=true;
      if(!res.headersSent){res.writeHead(500,HEADERS).end('mcp_unavailable');}
    }finally {
      if(res.writableFinished)await sdk.close().catch(()=>{});
      else res.once('close',()=>sdk.close().catch(()=>{}));
    }
  }
  return {handle,auth};
}
