import { publicErrorCode } from './errors.mjs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMcpAuthorization } from './authorization.mjs';
import { definitions, runTool } from './tools.mjs';

const HEADERS = {'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
export function createRemoteMcpServer(publicUrl) {
  const auth=createMcpAuthorization(publicUrl);
  async function handle(req,res,url) {
    // QA trace only: method/path/status; never log tokens, cookies, OAuth codes, or query strings.
    if (process.env.RA_MCP_TRACE === '1') res.once('finish', () =>
      console.log('[ra-mcp-qa]', req.method, url.pathname, res.statusCode));
    if(url.pathname!=='/mcp')return auth.handle(req,res,url);
    if(req.headers.host!==new URL(publicUrl).host){
      res.writeHead(421,HEADERS).end('invalid_host');return;
    }
    const access=auth.token(req);
    if(!['POST','GET','DELETE'].includes(req.method)){
      res.writeHead(405,HEADERS).end();return;
    }
    const sdk=new Server({name:'remote-agent',version:'0.2.0'},
      {capabilities:{tools:{}},instructions:[
        'Remote Agent controls native agents on this paired computer. Discover available apps and sessions with list_app_capabilities before delegating.',
        'For a user-authorized substantial coding or project task, prefer submit_task with the complete objective, project path, constraints and acceptance criteria. Use create_task/start_task only when staging is needed. Use send_message for a follow-up in an existing session.',
        'Use get_task to check execution state and read_task_output to obtain results. ACKNOWLEDGED or RUNNING means submitted, not completed. Independently verify results where needed; avoid replacing agent execution with many low-level file or terminal calls.',
        'Use unique operation IDs for distinct actions and reuse the same ID for retransmission. Never resubmit an UNKNOWN operation or task under a new ID; reconcile its native state first.',
        'Respect user authorization and discovered app capabilities. Do not automatically approve native permissions or bypass a pending decision; only approve an exact supported request when the user has authorized that decision.'
      ].join(' ')});
    // Discovery is public, but tool execution always requires an RA-paired OAuth identity.
    // An unauthenticated list exposes schemas only, never device/session/file data.
    const canWrite=access?.scope.split(/\s+/).includes('ra:control');
    sdk.setRequestHandler(ListToolsRequestSchema,async()=>({tools:definitions.filter(x=>
      !access||canWrite||x.annotations.readOnlyHint)}));
    const oauthRequired=(scope,error='invalid_token')=>({
      content:[{type:'text',text:'Connect and approve this Remote Agent device to use this tool.'}],
      isError:true,
      _meta:{'mcp/www_authenticate':[
        'Bearer resource_metadata="'+auth.issuer+'/.well-known/oauth-protected-resource", error="'+error+
        '", error_description="Remote Agent device pairing required", scope="'+scope+'"'
      ]}
    });
    sdk.setRequestHandler(CallToolRequestSchema,async message=>{
      const {name,arguments:args={}}=message.params;
      const required=definitions.find(t=>t.name===name)?.annotations.readOnlyHint?'ra:read':'ra:control';
      if(!access)return oauthRequired(required);
      if(required==='ra:control'&&!canWrite)return oauthRequired(required,'insufficient_scope');
      try {
        const result=await runTool(access.device,access.scope,name,args);
        return {content:[{type:'text',text:JSON.stringify(result)}],isError:false};
      } catch(error) {
        return {content:[{type:'text',text:JSON.stringify({error:
          publicErrorCode(error)})}],isError:true};
      }
    });
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    try {
      await sdk.connect(transport);
      await transport.handleRequest(req,res);
    }catch(error){
      if(!res.headersSent){res.writeHead(500,HEADERS).end('mcp_unavailable');}
    }finally {
      if(res.writableFinished)await sdk.close().catch(()=>{});
      else res.once('close',()=>sdk.close().catch(()=>{}));
    }
  }
  return {handle,auth};
}
