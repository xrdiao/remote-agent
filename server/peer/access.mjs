import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, computerId, computerName } from '../../lib/auth.mjs';

const direction = 'ra-peer-task-v1';
export const canRunPeerTasks = process.platform === 'linux';
export const peerId = v => typeof v === 'string' && /^[a-f0-9]{16}$/.test(v);
const taskId = v => typeof v === 'string' && /^[a-z0-9][a-z0-9._-]{0,47}$/.test(v);
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const grantPattern = new RegExp(`^${uuid}$`);
const jobPattern = new RegExp(`^\\d{13}-${uuid}$`);
export const peerGrantId = v => typeof v === 'string' && grantPattern.test(v);
export const newPeerJobId = () => `${Date.now()}-${crypto.randomUUID()}`;

export class PeerError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function readPeerFile(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export function writePeerFile(name, value) {
  const file = path.join(DATA_DIR, name), tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) { fs.rmSync(tmp, { force: true }); throw error; }
}

export function peerOrigin(address) {
  let url;
  try { url = new URL(address); }
  catch { throw new PeerError(400, '互控目标需要 HTTPS 地址或本机回环地址'); }
  const loopback = url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopback || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new PeerError(400, '互控目标需要 HTTPS 地址或本机回环地址');
  return url.origin;
}

export function peerSettings() {
  const { targets = {}, tasks = {} } = readPeerFile('peer.json', {});
  return {
    targets: new Map(Object.entries(targets).map(([id, address]) => {
      if (!peerId(id)) throw new PeerError(400, '本机互控配置含无效的电脑 ID');
      return [id, peerOrigin(address)];
    })),
    tasks: new Map(Object.entries(tasks).map(([id, row]) => {
      const { name, cwd, argv } = row || {};
      if (!taskId(id) || typeof name !== 'string' || !name.trim() || name.length > 80 || typeof cwd !== 'string' || !path.isAbsolute(cwd)
        || !Array.isArray(argv) || !argv.length || !argv.every(v => typeof v === 'string') || !path.isAbsolute(argv[0]))
        throw new PeerError(400, `本机的预设任务 ${id} 配置无效`);
      return [id, { name, cwd, argv }];
    })),
  };
}

function identity() {
  const file = path.join(DATA_DIR, 'peer-key.pem');
  try { return crypto.createPrivateKey(fs.readFileSync(file)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') return crypto.createPrivateKey(fs.readFileSync(file)); throw error; }
  return privateKey;
}

function verifyKey(value) {
  if (typeof value !== 'string' || !/^[\w-]{59}$/.test(value)) throw new PeerError(400, '发起电脑的互控身份无效');
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(value, 'base64url'), type: 'spki', format: 'der' });
    if (key.asymmetricKeyType === 'ed25519') return key;
  } catch {}
  throw new PeerError(400, '发起电脑的互控身份无效');
}

const trustDir = 'peer-workspace-trust';
const trustFile = id => `${trustDir}/${id}.json`;
const publicDer = key => key.export({ type: 'spki', format: 'der' });
const fingerprintOf = der => 'SHA256:' + crypto.createHash('sha256').update(der).digest('base64url');
export const peerFingerprint = () => fingerprintOf(publicDer(crypto.createPublicKey(identity())));

export function trustWorkspacePeer(id, fingerprint) {
  if (!peerId(id) || id === computerId()) throw new PeerError(400, '请输入对方电脑的 ID');
  const digest = typeof fingerprint === 'string' && /^SHA256:([\w-]{43})$/.exec(fingerprint)?.[1];
  if (!digest || Buffer.from(digest, 'base64url').toString('base64url') !== digest)
    throw new PeerError(400, '请输入对方电脑显示的完整 SHA256 公钥指纹');
  writePeerFile(trustFile(id), fingerprint);
  return { id, fingerprint };
}

export function workspaceFingerprints() {
  let files;
  try { files = fs.readdirSync(path.join(DATA_DIR, trustDir)); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  return Object.fromEntries(files.filter(file => /^[a-f0-9]{16}\.json$/.test(file))
    .map(file => [file.slice(0, -5), readPeerFile(`${trustDir}/${file}`, null)]));
}

export function workspaceFingerprint(id) {
  if (!peerId(id)) throw new PeerError(400, '互控电脑 ID 无效');
  const fingerprint = readPeerFile(trustFile(id), null);
  if (!fingerprint) throw new PeerError(403, '请在电脑本机登记对方的公钥指纹');
  return fingerprint;
}

export function verifyWorkspaceKey(id, key) {
  if (fingerprintOf(publicDer(key)) !== workspaceFingerprint(id))
    throw new PeerError(403, '互控公钥指纹不匹配，请在电脑本机重新核对');
}

export function checkPeerSource(source, publicKey) {
  if (!peerId(source) || source === computerId()) throw new PeerError(400, '请选择另一台发起电脑');
  return verifyKey(publicKey);
}

const grants = () => readPeerFile('peer-grants.json', []);
const grantView = ({ id, source, task }) => ({ id, source, task });

export function peerStatus() {
  const { targets, tasks } = peerSettings();
  const key = publicDer(crypto.createPublicKey(identity()));
  return { v: 1, id: computerId(), publicKey: key.toString('base64url'), fingerprint: fingerprintOf(key),
    canRun: canRunPeerTasks, targets: [...targets.keys()], tasks: canRunPeerTasks ? [...tasks].map(([id, row]) => ({ id, name: row.name })) : [],
    grants: grants().map(grantView) };
}

export function grantPeerTask({ source, publicKey, task }) {
  if (!canRunPeerTasks || !peerSettings().tasks.has(task)) throw new PeerError(404, '目标电脑未登记此预设任务');
  checkPeerSource(source, publicKey);
  const rows = grants(), old = rows.find(row => row.source === source && row.task === task);
  if (old && old.publicKey !== publicKey) throw new PeerError(409, '发起电脑身份已改变，请先撤销旧授权');
  if (old) return grantView(old);
  const row = { id: crypto.randomUUID(), source, publicKey, task };
  writePeerFile('peer-grants.json', [...rows, row]);
  return grantView(row);
}

export function revokePeerTask(id) {
  if (!peerGrantId(id)) throw new PeerError(400, '互控授权编号无效');
  const rows = grants();
  if (rows.some(row => row.id === id)) writePeerFile('peer-grants.json', rows.filter(row => row.id !== id));
}

function checkAction(action, id, task, grant) {
  if (!['start', 'read', 'cancel'].includes(action) || typeof id !== 'string' || !jobPattern.test(id) || (task !== '' && !taskId(task)) || !peerGrantId(grant))
    throw new PeerError(400, '任务操作或编号无效');
}

export const PEER_REQUEST_TTL = 60000;

export function signPeer(parts, { includeKey = false } = {}) {
  const payload = JSON.stringify(parts), key = identity();
  const signature = crypto.sign(null, Buffer.from(payload), key).toString('base64url');
  return includeKey ? { payload, signature, publicKey: publicDer(crypto.createPublicKey(key)).toString('base64url') } : { payload, signature };
}

export function readSignedPeer({ payload, signature }, expectedDomain, length, label) {
  if (typeof payload !== 'string' || typeof signature !== 'string' || !/^[\w-]{86}$/.test(signature))
    throw new PeerError(401, `互控${label}签名无效`);
  let parts;
  try { parts = JSON.parse(payload); } catch { throw new PeerError(400, `互控${label}请求无效`); }
  if (!Array.isArray(parts) || parts.length !== length) throw new PeerError(400, `互控${label}请求无效`);
  const [domain, source, target, ts] = parts;
  if (domain !== expectedDomain || !peerId(source) || target !== computerId() || !Number.isSafeInteger(ts) || Math.abs(Date.now() - ts) > PEER_REQUEST_TTL)
    throw new PeerError(401, `互控${label}身份或时间无效`);
  const valid = (publicKey, { checkFingerprint = false } = {}) => {
    const key = verifyKey(publicKey);
    if (checkFingerprint) verifyWorkspaceKey(source, key);
    return crypto.verify(null, Buffer.from(payload), key, Buffer.from(signature, 'base64url'));
  };
  return { source, ts, args: parts.slice(4), valid };
}

export function authenticatePeerTask(body) {
  const { source, args: [action, id, task, grant], valid } = readSignedPeer(body, direction, 8, '任务');
  const rows = grants().filter(row => row.source === source);
  if (action === 'list' && id === '' && task === '' && grant === '') {
    const trusted = rows.find(row => valid(row.publicKey));
    if (!trusted) throw new PeerError(403, '目标电脑尚未授权这台发起电脑');
    const presets = canRunPeerTasks ? peerSettings().tasks : new Map();
    const tasks = rows.filter(row => row.publicKey === trusted.publicKey && presets.has(row.task))
      .map(row => ({ task: row.task, name: presets.get(row.task).name, grant: row.id }));
    return { action, name: computerName(), tasks };
  }
  checkAction(action, id, task, grant);
  const row = rows.find(r => r.id === grant);
  if (!row || (task && row.task !== task) || !valid(row.publicKey)) throw new PeerError(403, '目标电脑未授权此任务');
  return { action, id, task: row.task, grant };
}

export async function sendSignedPeer({ target, address, route, domain, args, missingReply }, signal) {
  const source = computerId();
  if (!peerId(target) || source === target || !address) throw new PeerError(404, '发起电脑未登记该目标的地址');
  const origin = peerOrigin(address);
  const envelope = signPeer([domain, source, target, Date.now(), ...args]);
  let response, value;
  try {
    const timeout = AbortSignal.timeout(8000);
    response = await fetch(origin + route, { method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) });
    const chunks = []; let size = 0;
    for await (const data of response.body) {
      size += data.byteLength;
      if (size > 256 * 1024) throw new Error('Response too large');
      chunks.push(data);
    }
    value = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    signal?.throwIfAborted();
    throw new PeerError(502, missingReply);
  }
  return { status: response.status, ok: response.ok, value };
}

async function requestPeer({ target, action, id = '', task = '', grant = '' }, signal) {
  const { status, ok, value } = await sendSignedPeer({ target, address: peerSettings().targets.get(target), route: '/api/peer-task', domain: direction,
    args: [action, id, task, grant], missingReply: action === 'list' ? '未能读取目标电脑的授权任务' : '未能从目标电脑取得回执，请保留原任务号查询' }, signal);
  if (!ok) throw new PeerError(status, value?.error || '目标电脑没有接受请求');
  if (value?.computer !== target) throw new PeerError(502, '目标电脑回执不匹配');
  return value;
}

export async function listPeerTasks(target, signal) {
  const value = await requestPeer({ target, action: 'list' }, signal);
  if (!Array.isArray(value.tasks)) throw new PeerError(502, '目标电脑未返回授权任务列表');
  return { target, name: value.name, tasks: value.tasks };
}

export async function sendPeerTask({ target, action, id, task = '', grant }, signal) {
  checkAction(action, id, task, grant);
  const value = await requestPeer({ target, action, id, task, grant }, signal);
  if (value.job?.id !== id || !taskId(value.job?.task) || (task && value.job.task !== task)) throw new PeerError(502, '目标电脑回执不匹配');
  return value.job;
}
