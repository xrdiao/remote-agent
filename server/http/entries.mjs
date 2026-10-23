// Each grant belongs to one entry key; grouping never shares credentials.
import crypto from 'node:crypto';
import { addDevice, listDevices, needsTotp, removeDevice, entryPublicKey, pairingSessionActive } from '../../lib/auth.mjs';

const requests = new Map();
const TTL = 10 * 60 * 1000;
const secret = () => crypto.randomBytes(32).toString('base64url');
function prune() {
  for (const [id, request] of requests) if (request.expires <= Date.now()) requests.delete(id);
}
function ownerValid(request) {
  if (request.batch) return pairingSessionActive(request.batch);
  const owner = listDevices().find(d => d.id === request.owner);
  return owner && !needsTotp(owner);
}
function pendingRequest(request, name, publicKey, origin) {
  request.publicKey = entryPublicKey(publicKey);
  request.origin = String(origin || '').slice(0, 300);
  request.state = 'pending';
  request.name = String(name || '浏览器').slice(0, 60);
  request.secret = secret();
  request.code = String(crypto.randomInt(100000, 1000000));
  return { id: request.id, secret: request.secret, code: request.code, expires: request.expires };
}
export function requestPairing(batch, name, publicKey, origin) {
  prune();
  if (requests.size >= 20) throw new Error('待授权入口过多，请稍后再试');
  const request = { id: crypto.randomBytes(8).toString('hex'), batch: batch.id, expires: batch.expires,
    groupId: batch.groupId, groupName: batch.groupName };
  const result = pendingRequest(request, name, publicKey, origin);
  requests.set(request.id, request);
  return result;
}
export function inviteEntry(owner, groupId) {
  prune();
  for (const [id, request] of requests) if (request.owner === owner.id && request.groupId === groupId && request.state === 'invited') requests.delete(id);
  if (requests.size >= 20) throw new Error('待授权入口过多，请稍后再试');
  const group = listDevices().find(d => (d.groupId || d.id) === groupId);
  if (!group) throw new Error('设备分组不存在，请刷新列表');
  const request = { id: crypto.randomBytes(8).toString('hex'), invitation: secret(), owner: owner.id,
    groupId, groupName: group.groupName || group.name, state: 'invited', expires: Date.now() + TTL };
  requests.set(request.id, request);
  return { invitation: request.invitation, expires: request.expires };
}
export function joinEntry(invitation, name, publicKey, origin) {
  prune();
  const request = [...requests.values()].find(r => r.state === 'invited' && r.invitation === invitation);
  if (!request || !ownerValid(request)) throw new Error('授权链接已失效，请由已配对入口重新生成');
  const result = pendingRequest(request, name, publicKey, origin);
  request.invitation = '';
  return result;
}
export function entryRequests(batch = '') {
  prune();
  return [...requests.values()].filter(r => r.state === 'pending' && (batch ? r.batch === batch : !r.batch) && ownerValid(r))
    .map(({ id, code, name, origin, groupName, expires }) => ({ id, code, name, origin, groupName, expires }));
}
function grant(request, groupId, groupName) {
  const added = addDevice(request.name, { groupId, groupName, entryName: request.name, publicKey: request.publicKey, origin: request.origin });
  request.token = added.token;
  request.device = added.device.id;
  request.state = 'approved';
  // Approval survives the pairing window ending, including the phone's next poll.
  request.expires = Date.now() + TTL;
}
export function decideEntries(batch, selections, approve) {
  prune();
  if (!Array.isArray(selections) || !selections.length || selections.length > 20 || new Set(selections.map(s => s.id)).size !== selections.length) throw new Error('请选择要核对的入口');
  const selected = selections.map(s => {
    const r = requests.get(s.id);
    if (!r || r.batch !== batch || r.state !== 'pending' || r.code !== s.code || !ownerValid(r)) throw new Error('请求已失效，请刷新列表');
    return r;
  });
  for (const r of selected) {
    if (approve) grant(r, r.groupId, r.groupName);
    else r.state = 'denied';
  }
}
export function decideEntry(id, code, approve) {
  prune();
  const request = requests.get(id);
  if (!request || request.batch || request.state !== 'pending' || request.code !== code || !ownerValid(request)) throw new Error('请求已失效，请刷新列表');
  if (approve) {
    const group = listDevices().find(d => (d.groupId || d.id) === request.groupId);
    if (!group) throw new Error('设备分组已移除，请重新申请');
    grant(request, request.groupId, group.groupName || group.name);
  } else request.state = 'denied';
}
export function entryStatus(id, proof) {
  prune();
  const request = requests.get(id);
  if (!request || !proof || request.secret !== proof) throw new Error('请求已失效，请重新打开授权链接');
  if (request.state === 'pending' && !ownerValid(request)) throw new Error('授权入口已失效，请重新申请');
  if (request.state === 'approved' && !listDevices().some(d => d.id === request.device)) throw new Error('此入口已被撤销');
  return { state: request.state, ...(request.state === 'approved' ? { token: request.token, device: request.device } : {}) };
}
export function cancelEntry(id, proof) {
  entryStatus(id, proof);
  const request = requests.get(id);
  if (request.state === 'approved') removeDevice(request.device);
  request.state = 'denied';
  delete request.token;
}
