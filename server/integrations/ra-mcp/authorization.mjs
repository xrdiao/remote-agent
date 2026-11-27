import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, computerId, listDevices, needsTotp, pairingSession } from '../../../lib/auth.mjs';
import { requestPairing, entryStatus } from '../../http/entries.mjs';

const AUTHORIZATION_VERSION = 2;
const random = () => crypto.randomBytes(32).toString('base64url');
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const same = (a,b) => typeof a==='string' && typeof b==='string' && a.length===b.length
  && crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
const device = id => listDevices().find(d=>d.id===id && !needsTotp(d));
const esc = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const json = (res,status,obj,more={}) => {res.writeHead(status,{'content-type':'application/json','cache-control':'no-store',
  'x-content-type-options':'nosniff','referrer-policy':'no-referrer',...more});res.end(JSON.stringify(obj));};
async function body(req,form=false) {
  const chunks=[];let n=0;
  for await(const chunk of req){n+=chunk.length;if(n>8192)throw Error('body_too_large');chunks.push(chunk);}
  const raw=Buffer.concat(chunks).toString('utf8');
  if (!form) return JSON.parse(raw);
  const params = new URLSearchParams(raw);
  for (const key of new Set(params.keys())) {
    if (params.getAll(key).length !== 1) throw Error('duplicate_form_parameter');
  }
  return Object.fromEntries(params);
}
const validPKCE=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{43,128}$/.test(v);
const validRedirect=s=>{
  try{const u=new URL(s);return !u.username&&!u.password&&!u.hash&&
    (u.protocol==='https:'||u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname));}
  catch{return false;}
};
function stateFailure(value) {
  if (value === null) return 'state_missing';
  if (value.length < 8) return 'state_too_short';
  if (Buffer.byteLength(value, 'utf8') > 4096) return 'state_too_long';
  if (/[\x00-\x1f]/.test(value)) return 'state_control_character';
  return null;
}
const DIAGNOSTIC_PARAMS = ['client_id','redirect_uri','response_type','code_challenge_method',
  'code_challenge','state','scope','resource'];
function authorizeDiagnostics() {
  if (process.env.RA_MCP_OAUTH_DIAGNOSTICS !== '1' || !process.env.RA_MCP_TEST_ROOT) return () => {};
  let remaining = 12;
  return (q, failures) => {
    if (remaining === 0) return;
    remaining--;
    const parameters = Object.fromEntries(DIAGNOSTIC_PARAMS.map(name => {
      const values = q.getAll(name);
      return [name, {
        present: values.length > 0,
        count: values.length,
        firstBytes: values.length ? Buffer.byteLength(values[0]) : null,
      }];
    }));
    console.log('[ra-mcp-oauth-qa] '+JSON.stringify({failures,parameters}));
  };
}
const cookie=req=>/^ra_mcp_tx=([A-Za-z0-9_-]{43})$/.exec((req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('ra_mcp_tx='))||'')?.[1];
const error=(res,code,status=400)=>json(res,status,{error:code});

export function createMcpAuthorization(issuer) {
  const u=new URL(issuer),resource=issuer+'/mcp';
  if(u.origin!==issuer || u.pathname!=='/' ||
     !(u.protocol==='https:'||u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)))
    throw Error('RA_MCP_PUBLIC_URL must be HTTPS origin (or local QA)');
  const store=path.join(DATA_DIR,'ra-mcp-oauth.json'),transactions=new Map(),rates=new Map();
  const diagnoseAuthorize = authorizeDiagnostics();
  fs.mkdirSync(DATA_DIR,{recursive:true,mode:0o700});
  let db;
  try{db=JSON.parse(fs.readFileSync(store,'utf8'));}
  catch(e){if(e.code!=='ENOENT')throw e;db={clients:[],codes:[],tokens:[]};}
  function persist(){const tmp=store+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(db),{mode:0o600});fs.renameSync(tmp,store);}
  function prune(){
    const now=Date.now();
    for(const k of ['clients','codes','tokens'])db[k]=db[k].filter(v=>v.exp>now);
    for(const [k,v] of transactions)if(v.exp<now)transactions.delete(k);
  }
  function limit(req){
    const ip=String(req.headers['cf-connecting-ip']||req.socket.remoteAddress||'').slice(0,130);
    const now=Date.now(),a=(rates.get(ip)||[]).filter(t=>now-t<60000);a.push(now);rates.set(ip,a);
    return a.length>12;
  }
  const metadata={resource,authorization_servers:[issuer],scopes_supported:['ra:read','ra:control']};
  const server={issuer,authorization_endpoint:issuer+'/oauth/authorize',token_endpoint:issuer+'/oauth/token',
    registration_endpoint:issuer+'/oauth/register',response_types_supported:['code'],
    grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],
    token_endpoint_auth_methods_supported:['none'],scopes_supported:['ra:read','ra:control'],
    authorization_response_iss_parameter_supported:true,client_id_metadata_document_supported:false};
  // Diagnostic labels only: registered display names are not a verified client identity.
  function clientKind(id) {
    const name=db.clients.find(x=>x.id===id)?.name;
    return name==='Google'?'google':name==='ChatGPT'?'chatgpt':name?'other':'unknown';
  }
  function token(req) {
    const raw=/^Bearer ([A-Za-z0-9_-]{20,160})$/.exec(req.headers.authorization||'')?.[1];
    if(!raw)return null;
    prune();const t=db.tokens.find(x=>x.version===AUTHORIZATION_VERSION&&x.kind==='access'&&same(x.hash,hash(raw)));
    const paired=t&&device(t.device);
    return paired&&t.aud===resource?{device:paired,scope:t.scope,client:t.client}:null;
  }
  const challenge=res=>json(res,401,{error:'authentication_required'},
    {'www-authenticate':'Bearer resource_metadata="'+issuer+'/.well-known/oauth-protected-resource"'});
  function register(req,res,value){
    if(limit(req)||db.clients.length>=100)return error(res,'registration_limit',429);
    if(!Array.isArray(value?.redirect_uris)||!value.redirect_uris.length||value.redirect_uris.length>8||
      !value.redirect_uris.every(validRedirect)||typeof value.client_name!=='string'||value.client_name.length>100||
      value.token_endpoint_auth_method && value.token_endpoint_auth_method!=='none')return error(res,'invalid_client_metadata');
    const row={id:random(),name:value.client_name.slice(0,100),redirects:value.redirect_uris,exp:Date.now()+90*86400000};
    db.clients.push(row);persist();
    return json(res,201,{client_id:row.id,client_name:row.name,redirect_uris:row.redirects,
      token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],
      response_types:['code'],client_id_issued_at:Math.floor(Date.now()/1000)});
  }
  function authorize(req,res,url) {
    const q=url.searchParams,c=db.clients.find(x=>x.id===q.get('client_id')),redirect=q.get('redirect_uri');
    const requestedRaw = q.get('scope');
    const requested = requestedRaw === null ? ['ra:read'] : requestedRaw.split(' ');
    const scope = [...new Set(requested)].join(' '), state = q.get('state');
    const target = q.get('resource');
    const duplicates = DIAGNOSTIC_PARAMS.filter(name => q.getAll(name).length > 1);
    const failures=[
      ...duplicates.map(name => 'duplicate_'+name),
      !c && 'client_unregistered',
      redirect === null && 'redirect_missing',
      c && redirect !== null && !c.redirects.includes(redirect) && 'redirect_unregistered',
      q.get('response_type')!=='code' && 'response_type_not_code',
      q.get('code_challenge_method')!=='S256' && 'pkce_method_not_s256',
      !validPKCE(q.get('code_challenge')) && 'pkce_challenge_invalid',
      stateFailure(state),
      (requested.length<1||requested.some(x=>!['ra:read','ra:control'].includes(x))) && 'scope_unsupported',
      target !== null && target !== resource && 'resource_mismatch',
    ].filter(Boolean);
    if(failures.length){
      diagnoseAuthorize(q,failures);
      const type = failures.length === 1 && failures[0] === 'scope_unsupported' ? 'invalid_scope'
        : failures.length === 1 && failures[0] === 'resource_mismatch' ? 'invalid_target'
        : 'invalid_authorization_request';
      return error(res, type);
    }
    if(transactions.size>=24)return error(res,'too_many_pairings',429);
    const id=random(),tx={id,client:c.id,clientName:c.name,redirect,state,scope,
      challenge:q.get('code_challenge'),exp:Date.now()+600000,request:null};
    transactions.set(id,tx);
    const nonce=crypto.randomBytes(16).toString('base64');
    const markup='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>RA MCP 配对</title></head>'+
    '<body style="font:16px system-ui;margin:5vh auto;max-width:520px;padding:24px;line-height:1.6">'+
    '<h2>配对 '+esc(c.name)+' 至 Remote Agent</h2>'+
    '<p>在目标电脑使用已有的 RA 配对功能生成手动配对码，输入此处。无需 RA 账号。</p>'+
    '<p>申请权限：'+(scope.split(' ').includes('ra:control')?'控制 Agent、文件和终端':'只读访问')+'</p>'+
    '<form id="f"><input name="code" required autocomplete="off" style="width:92%;padding:10px" placeholder="电脑上显示的完整手动配对码">'+
    '<button type="submit">申请配对</button></form><p id="s">请先在电脑上启动配对窗口。</p>'+
    '<script nonce="'+nonce+'">const tx='+JSON.stringify(id)+';const f=document.getElementById("f"),s=document.getElementById("s");'+
    'f.addEventListener("submit",async e=>{e.preventDefault();const code=new FormData(f).get("code");'+
    'const r=await fetch("/oauth/pair",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({tx,code})});'+
    'const x=await r.json();s.textContent=r.ok?"请在电脑上核对并批准，验证码："+x.confirmation:"配对失败："+x.error;'+
    'if(r.ok){f.querySelector("button").disabled=true;poll();}});'+
    'async function poll(){const r=await fetch("/oauth/status?tx="+encodeURIComponent(tx));const x=await r.json();'+
    'if(x.state==="approved"&&x.redirect){location.assign(x.redirect);return;}'+
    'if(x.state==="denied"){s.textContent="电脑已拒绝配对";return;}'+
    'if(!r.ok){s.textContent="授权已失效，请重新连接";return;}setTimeout(poll,1200);}</script></body></html>';
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store',
      'referrer-policy':'no-referrer','x-frame-options':'DENY',
      'content-security-policy':"default-src 'none'; script-src 'nonce-"+nonce+"'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'",
      'set-cookie':'ra_mcp_tx='+id+'; HttpOnly; Path=/oauth; SameSite=Lax; Max-Age=600'+(u.protocol==='https:'?'; Secure':'')});
    res.end(markup);
  }
  function txFor(req,id){const t=transactions.get(id);return t&&t.exp>Date.now()&&cookie(req)===t.id?t:null;}
  function pair(req,res,value){
    if(limit(req))return error(res,'rate_limited',429);
    const tx=txFor(req,value?.tx);if(!tx||tx.request)return error(res,'authorization_expired');
    const [prefix,code,...extra]=String(value?.code||'').trim().split('.');
    if(extra.length||prefix!==computerId()||!code)return error(res,'invalid_pairing_code',401);
    const batch=pairingSession(code);
    if(!batch)return error(res,'invalid_or_expired_pairing_code',401);
    const {publicKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
    const key=publicKey.export({format:'der',type:'spki'}).toString('base64url');
    tx.request=requestPairing(batch,'MCP: '+tx.clientName,key,'RA MCP: '+new URL(tx.redirect).host);
    return json(res,202,{state:'pending',confirmation:tx.request.code});
  }
  function status(req,res,url){
    const tx=txFor(req,url.searchParams.get('tx'));
    if(!tx)return error(res,'authorization_expired',410);
    if(!tx.request)return json(res,200,{state:'waiting'});
    let result;
    try{result=entryStatus(tx.request.id,tx.request.secret);}
    catch{return error(res,'pairing_expired',410);}
    if(result.state!=='approved')return json(res,200,{state:result.state});
    if(!device(result.device))return error(res,'pairing_revoked',403);
    if(!tx.code){
      tx.code=random();
      db.codes.push({version:AUTHORIZATION_VERSION,hash:hash(tx.code),client:tx.client,redirect:tx.redirect,scope:tx.scope,
        challenge:tx.challenge,device:result.device,aud:resource,exp:Date.now()+60000});
      persist();
    }
    const redirect=new URL(tx.redirect);
    redirect.searchParams.set('code',tx.code);redirect.searchParams.set('state',tx.state);redirect.searchParams.set('iss',issuer);
    return json(res,200,{state:'approved',redirect:redirect.href});
  }
  function tokenEndpoint(req,res,v){
    if (req.headers.authorization || v.client_secret !== undefined || v.client_assertion !== undefined ||
        v.client_assertion_type !== undefined) return error(res,'invalid_client',401);
    const c=db.clients.find(x=>x.id===v.client_id);if(!c)return error(res,'invalid_client',401);
    let row;
    if(v.grant_type==='authorization_code'){
      row=db.codes.find(x=>x.version===AUTHORIZATION_VERSION&&same(x.hash,hash(String(v.code||''))));
      if(!row||row.client!==c.id||row.redirect!==v.redirect_uri||!validPKCE(v.code_verifier)||
        !same(row.challenge,crypto.createHash('sha256').update(v.code_verifier).digest('base64url')))
        return error(res,'invalid_grant');
      db.codes=db.codes.filter(x=>x!==row);
    }else if(v.grant_type==='refresh_token'){
      row=db.tokens.find(x=>x.version===AUTHORIZATION_VERSION&&x.kind==='refresh'&&same(x.hash,hash(String(v.refresh_token||''))));
      if(!row||row.client!==c.id)return error(res,'invalid_grant');
      db.tokens=db.tokens.filter(x=>x!==row);
    }else return error(res,'unsupported_grant_type');
    if (v.resource && v.resource !== row.aud) return error(res,'invalid_target');
    if (!device(row.device)) return error(res,'invalid_grant');
    const access=random(),refresh=random(),now=Date.now();
    db.tokens.push({version:AUTHORIZATION_VERSION,kind:'access',hash:hash(access),client:c.id,device:row.device,aud:row.aud,scope:row.scope,exp:now+3600000});
    db.tokens.push({version:AUTHORIZATION_VERSION,kind:'refresh',hash:hash(refresh),client:c.id,device:row.device,aud:row.aud,scope:row.scope,exp:now+30*86400000});
    persist();return json(res,200,{access_token:access,refresh_token:refresh,token_type:'Bearer',scope:row.scope,expires_in:3600});
  }
  async function handle(req,res,url,trace) {
    if(req.headers.host!==u.host)return error(res,'invalid_host',421);
    prune();const route=url.pathname;
    if(req.method==='GET'&&(route==='/.well-known/oauth-protected-resource'||route==='/.well-known/oauth-protected-resource/mcp'))
      return json(res,200,metadata);
    if(req.method==='GET'&&(route==='/.well-known/oauth-authorization-server'||route==='/.well-known/openid-configuration'))
      return json(res,200,server);
    if(req.method==='POST'&&route==='/oauth/register'){
      try{
        const v=await body(req);
        if(trace)trace.client=v?.client_name==='Google'?'google':v?.client_name==='ChatGPT'?'chatgpt':'other';
        return register(req,res,v);
      }catch{return error(res,'invalid_client_metadata');}
    }
    if(req.method==='GET'&&route==='/oauth/authorize'){
      if(trace)trace.client=clientKind(url.searchParams.get('client_id'));
      return authorize(req,res,url);
    }
    if(req.method==='POST'&&route==='/oauth/pair'){
      try{return pair(req,res,await body(req));}catch{return error(res,'pairing_request_failed');}
    }
    if(req.method==='GET'&&route==='/oauth/status')return status(req,res,url);
    if(req.method==='POST'&&route==='/oauth/token'){
      try{
        const v=await body(req,true);
        if(trace){
          trace.client=clientKind(v.client_id);
          trace.grant=v.grant_type==='authorization_code'?'authorization_code':v.grant_type==='refresh_token'?'refresh_token':'other';
        }
        return tokenEndpoint(req,res,v);
      }
      catch(e){return error(res, e?.message==='duplicate_form_parameter'?'invalid_request':'invalid_grant');}
    }
    return error(res,'not_found',404);
  }
  return {handle,token,challenge,issuer,resource,clientKind};
}
