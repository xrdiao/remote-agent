import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fail, inside } from './auth.mjs';

export const MAX_TEXT = 256 * 1024;
export const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const decoder = new TextDecoder('utf-8', {fatal:true,ignoreBOM:true});
function resolve(root, input, create = false, list = false) {
  if (fs.realpathSync(root) !== root || !fs.statSync(root).isDirectory()) throw fail('workspace_root_changed',409);
  if (input === '.' && list) return root;
  if (!input || path.isAbsolute(input) || input.includes('\\') || input.includes('\0') ||
      input.split('/').some(p => !p || p === '.' || p === '..')) throw fail('relative_path_required',403);
  let result = root;
  const parts = input.split('/');
  for (let i=0;i<parts.length;i++) {
    result = path.join(result,parts[i]);
    if (create && i===parts.length-1) break;
    const st = fs.lstatSync(result);
    if (st.isSymbolicLink() || (i<parts.length-1 && !st.isDirectory())) throw fail('symlink_or_invalid_path',403);
  }
  if (!inside(root,result) || fs.realpathSync(path.dirname(result)) !== path.dirname(result)) throw fail('workspace_escape',403);
  return result;
}
function readBytes(file) {
  const fd = fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw fail('regular_single_link_file_required',403);
    if (st.size>MAX_TEXT) throw fail('file_too_large',413);
    const data=Buffer.allocUnsafe(MAX_TEXT+1); let n=0;
    while(n<data.length){const got=fs.readSync(fd,data,n,data.length-n,null);if(!got)break;n+=got;}
    if(n>MAX_TEXT)throw fail('file_too_large',413);
    const end=fs.fstatSync(fd);
    if(st.size!==end.size || st.mtimeMs!==end.mtimeMs || st.ctimeMs!==end.ctimeMs || n!==end.size) throw fail('file_changed_during_read',409);
    const bytes=data.subarray(0,n); let text;
    try{text=decoder.decode(bytes);}catch{throw fail('utf8_text_only',415);}
    if(text.includes('\0'))throw fail('utf8_text_only',415);
    return {bytes,text,sha256:digest(bytes),st};
  }finally{fs.closeSync(fd);}
}
function textBuffer(text) {
  const data=Buffer.from(text,'utf8');
  if(data.length>MAX_TEXT || text.includes('\0') || decoder.decode(data)!==text)throw fail('invalid_or_oversized_utf8',413);
  return data;
}
export function listFiles(root,input) {
  const dir=fs.opendirSync(resolve(root,input,false,true));
  const entries=[];let more;
  try{while((more=dir.readSync())&&entries.length<128)entries.push({name:more.name,type:more.isSymbolicLink()?'symlink-denied':more.isDirectory()?'directory':more.isFile()?'file':'other'});}
  finally{dir.closeSync();}
  return {path:input,entries:entries.sort((a,b)=>a.name.localeCompare(b.name)),truncated:!!more};
}
export function readFile(root,input) {
  const r=readBytes(resolve(root,input));
  return {path:input,text:r.text,size:r.bytes.length,sha256:r.sha256};
}
export function writeFile(root,input,text,expected) {
  const creating = expected===undefined, data=textBuffer(text), file=resolve(root,input,creating);
  const previous=creating?null:readBytes(file);
  if(previous && previous.sha256!==expected)throw fail('expected_sha256_mismatch',409);
  const tmp=path.join(path.dirname(file),'.ra-mcp-'+crypto.randomUUID()+'.tmp');
  let fd, published=false;
  try {
    fd=fs.openSync(tmp,'wx',previous?previous.st.mode&0o777:0o600);
    fs.writeFileSync(fd,data);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    if(resolve(root,input,creating)!==file)throw fail('workspace_path_changed',409);
    if(creating)fs.linkSync(tmp,file); // publish atomically; EEXIST never overwrites
    else {
      const current=readBytes(file);
      if(current.sha256!==expected || current.st.ino!==previous.st.ino || current.st.dev!==previous.st.dev)
        throw fail('file_changed_before_write',409);
      fs.renameSync(tmp,file);
    }
    published=true;
    // Durable receipt is separate from content; if fsync fails after publication,
    // report an unknown outcome instead of retrying.
    const parent=fs.openSync(path.dirname(file),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
    try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
    return {path:input,size:data.length,sha256:digest(data)};
  }catch(e){if(published)throw Object.assign(fail('write_outcome_unknown',502),{outcomeUnknown:true});throw e;}
  finally {if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT'){if(published)throw Object.assign(fail('write_outcome_unknown',502),{outcomeUnknown:true});throw e;}}}
}
