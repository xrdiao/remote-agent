// A trusted entry invites another browser; only an explicit approval grants a token.
import crypto from 'node:crypto';
import { addDevice, listDevices, needsTotp, removeDevice } from '../../lib/auth.mjs';

const requests = new Map();
const TTL = 10 * 60 * 1000;
const secret = () => crypto.randomBytes(32).toString('base64url');
function prune() {
  for (const [id, request] of requests) if (request.expires <= Date.now()) requests.delete(id);
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
export function joinEntry(invitation, name) {
  prune();
  const request = [...requests.values()].find(r => r.state === 'invited' && r.invitation === invitation);
  const owner = request && listDevices().find(d => d.id === request.owner);
  if (!owner || needsTotp(owner)) throw new Error('授权链接已失效，请由已配对入口重新生成');
  request.invitation = '';
  request.state = 'pending';
  request.name = String(name || '浏览器').slice(0, 60);
  request.secret = secret();
  request.code = String(crypto.randomInt(100000, 1000000));
  return { id: request.id, secret: request.secret, code: request.code, expires: request.expires };
}
export function entryRequests() {
  prune();
  const devices = listDevices();
  return [...requests.values()].filter(r => r.state === 'pending' && devices.some(d => d.id === r.owner && !needsTotp(d)))
    .map(({ id, code, name, groupName, expires }) => ({ id, code, name, groupName, expires }));
}
export function decideEntry(id, code, approve) {
  prune();
  const request = requests.get(id);
  const devices = listDevices();
  const owner = request && devices.find(d => d.id === request.owner);
  if (!request || request.state !== 'pending' || request.code !== code || !owner || needsTotp(owner)) throw new Error('请求已失效，请刷新列表');
  if (approve) {
    const group = devices.find(d => (d.groupId || d.id) === request.groupId);
    if (!group) throw new Error('设备分组已移除，请重新申请');
    const added = addDevice(request.name, { groupId: request.groupId, groupName: group.groupName || group.name, entryName: request.name });
    request.token = added.token;
    request.device = added.device.id;
  }
  request.state = approve ? 'approved' : 'denied';
}
export function entryStatus(id, proof) {
  prune();
  const request = requests.get(id);
  if (!request || !proof || request.secret !== proof) throw new Error('请求已失效，请重新打开授权链接');
  const devices = listDevices();
  const owner = devices.find(d => d.id === request.owner);
  if (!owner || needsTotp(owner)) throw new Error('授权入口已失效，请重新申请');
  if (request.state === 'approved' && !devices.some(d => d.id === request.device)) throw new Error('此入口已被撤销');
  return { state: request.state, ...(request.state === 'approved' ? { token: request.token, device: request.device } : {}) };
}
export function cancelEntry(id, proof) {
  entryStatus(id, proof);
  const request = requests.get(id);
  if (request.state === 'approved') removeDevice(request.device);
  request.state = 'denied';
  delete request.token;
}
