// Read-only, loopback-only prototype contract. Do not deploy this as an OAuth server.
import { definitions, validateTool } from '../../server/integrations/chatgpt/tools.mjs';

const names = new Set(['list_devices','list_workspaces','list_files','read_file','list_sessions','read_session']);
export const tools = definitions.filter(t => names.has(t.name));
export const FRAME_LIMIT = 2 * 1024 * 1024;
export const REQUEST_LIMIT = 8192;
export const CALL_TIMEOUT = 15000;
export const TOKEN_RE = /^[a-f0-9]{64}$/;
export const UUID_RE = /^[a-f0-9-]{36}$/;
export const utf8 = new TextEncoder();
export const bytes = value => utf8.encode(value).byteLength;
export const localHost = host => ['127.0.0.1','localhost','[::1]'].includes(host);
export function checkCall(name,args) {
  if (!names.has(name)) throw new Error('read_only_gateway');
  validateTool(name,args);
}
function keyBytes(value) {
  if (typeof value!=='string'||!TOKEN_RE.test(value)) throw new Error('invalid_key');
  return Uint8Array.from(value.match(/../g),v=>parseInt(v,16));
}
const hex = value => [...new Uint8Array(value)].map(b=>b.toString(16).padStart(2,'0')).join('');
const key = async secret => crypto.subtle.importKey('raw', keyBytes(secret), {name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
export async function sameToken(actual, expected) {
  if (typeof actual!=='string'||typeof expected!=='string'||!TOKEN_RE.test(actual)||!TOKEN_RE.test(expected))return false;
  const k = await key(expected);
  const signature=await crypto.subtle.sign('HMAC',k,keyBytes(expected));
  return crypto.subtle.verify('HMAC',k,signature,keyBytes(actual));
}
export async function sign(secret, data) {
  const payload=JSON.stringify(data);
  if(bytes(payload)>FRAME_LIMIT-256)throw new Error('payload_too_large');
  return JSON.stringify({payload,mac:hex(await crypto.subtle.sign('HMAC',await key(secret),utf8.encode(payload)))});
}
export async function verify(secret, raw) {
  if(typeof raw!=='string'||bytes(raw)>FRAME_LIMIT)throw new Error('bad_frame');
  const outer=JSON.parse(raw);
  if(!outer||typeof outer.payload!=='string'||!TOKEN_RE.test(outer.mac||''))throw new Error('bad_frame');
  if(!await crypto.subtle.verify('HMAC',await key(secret),keyBytes(outer.mac),utf8.encode(outer.payload)))throw new Error('invalid_signature');
  const data=JSON.parse(outer.payload);
  if(!data||data.v!==1||typeof data.device!=='string'||!UUID_RE.test(data.connection||'')
      ||!Number.isSafeInteger(data.at)||Math.abs(Date.now()-data.at)>30000)throw new Error('stale_or_invalid_frame');
  return data;
}
export const envelope=(kind,device,connection,extra={})=>({v:1,kind,device,connection,at:Date.now(),...extra});
