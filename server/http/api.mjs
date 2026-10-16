import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, findDevice, needsTotp, totpConfig, verifyTotp, pairingValid, consumePairing, addDevice, listDevices, removeDevice, updateDevice, computerId, computerName, urlKey } from '../../lib/auth.mjs';
import { pushPublicKey, openEventStream, closeEventStreams, deliver } from '../../lib/notify.mjs';
import { clientIp, lockedOut, recordFailure } from './ratelimit.mjs';
import { json, readJson, originAllowed, corsHeaders, SECURITY_HEADERS } from './static.mjs';
import { readChatImage } from '../chat-images.mjs';
import { listWindows } from '../windows.mjs';
import { Cdp } from '../cdp.mjs';
import { helpersCall } from '../page/build.mjs';
import { Session } from '../session.mjs';
import { videoGrant, serveVideo } from './video.mjs';
import { uploads } from '../agent/context.mjs';

// A device is usable once paired and, when 2FA asks for it, re-verified.
function deviceFor(req) {
  return findDevice(bearer(req));
}

function bearer(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return m ? m[1] : '';
}

function deviceView(d, current) {
  return { id: d.id, name: d.name, created: d.created, lastSeen: d.lastSeen, current: d.id === current?.id };
}

async function actOnWindow(deviceId, { win, threadId, act, index, text, question }) {
  const wins = await listWindows();
  const w = wins.find(x => x.id === String(win));
  if (!w || w.app !== 'devin') throw new Error('找不到这个窗口，或它不支持通知里的操作');
  const s = new Session({ readyState: 3, send() {} }, deviceId);
  clearInterval(s.idleTimer);
  try {
    s.cdp = new Cdp(w.ws);
    await s.cdp.connect();
    s.app = w.app;
    s.targetId = w.id;
    s.windowId = w.id;
    s.editorCdp = s.cdp;
    s.threadId = await s.cdp.evaluate(helpersCall('activeThread()'));
    if (!threadId || s.threadId !== threadId) throw new Error('通知对应的会话已切换，请打开该会话后操作');
    if (question && question !== (await s.cdp.evaluate(helpersCall('agentState()')))?.waiting) throw new Error('通知中的问题已变更，请查看最新问题');
    const reply = String(text ?? '').trim().slice(0, 3000);
    if (act === 'opt') await s.answerQuestion(0, Math.max(0, Number(index) || 0), 'option');
    else if (act === 'reply') {
      if (!reply) throw new Error('回复内容为空');
      await s.sendMessage(reply, true);
    } else if (act === 'acceptAll') await s.changeAction(0, 'Accept all', 'bar');
    else throw new Error('不支持的操作');
  } finally {
    s.dispose();
  }
}

export async function handleApi(req, res, route) {
  const ip = clientIp(req);
  if (req.method === 'POST' && !originAllowed(req)) return json(req, res, 403, { error: 'bad origin' });
  if (route.startsWith('/api/video/') && ['GET', 'HEAD'].includes(req.method)) {
    const grant = videoGrant(route.slice('/api/video/'.length));
    if (!grant) return json(req, res, 401, { error: '视频链接已过期或设备授权已失效，请重新打开视频' });
    return serveVideo(req, res, grant);
  }
  const device = deviceFor(req);

  if (route === '/api/me') {
    return json(req, res, 200, { paired: Boolean(device), needTotp: needsTotp(device), totp: Boolean(totpConfig()), id: computerId(), name: computerName(), device: device?.id || '' });
  }

  if (route === '/api/pair' && req.method === 'POST') {
    if (lockedOut(ip)) return json(req, res, 429, { error: '尝试次数过多，请 15 分钟后再试' });
    const { code, name, totp } = await readJson(req);
    if (!device && !pairingValid(code)) {
      recordFailure(ip);
      return json(req, res, 401, { error: '配对链接无效或已过期（10 分钟内有效，只能用一次）。请在电脑上重新运行 npm run pair' });
    }
    const needsVerification = totpConfig() && (!device || needsTotp(device));
    if (needsVerification && !verifyTotp(totp)) {
      if (totp) recordFailure(ip);
      return json(req, res, 401, { needTotp: true, error: totp ? '验证码不对' : '' });
    }
    if (device) {
      if (needsVerification) updateDevice(device.id, { verifiedAt: Date.now() });
      return json(req, res, 200, { token: bearer(req), id: computerId(), name: computerName(), device: device.id, key: urlKey().toString('base64url') });
    }
    consumePairing();
    const { device: added, token } = addDevice(name);
    console.log(`[pair] 新设备「${added.name}」 ip=${ip}`);
    return json(req, res, 200, { token, id: computerId(), name: computerName(), device: added.id, key: urlKey().toString('base64url') });
  }

  if (!device) return json(req, res, 401, { error: '设备未配对' });

  if (route === '/api/totp' && req.method === 'POST') {
    if (lockedOut(ip)) return json(req, res, 429, { error: '尝试次数过多，请 15 分钟后再试' });
    const { code } = await readJson(req);
    if (!verifyTotp(code)) {
      recordFailure(ip);
      return json(req, res, 401, { error: '验证码不对' });
    }
    updateDevice(device.id, { verifiedAt: Date.now() });
    return json(req, res, 200, { ok: true });
  }
  if (needsTotp(device)) return json(req, res, 401, { needTotp: true, error: '需要二次验证' });
  if (route.startsWith('/api/chat-image/') && req.method === 'GET') {
    const image = readChatImage(route.slice('/api/chat-image/'.length));
    if (!image) return json(req, res, 404, { error: '图片不存在' });
    res.writeHead(200, { ...SECURITY_HEADERS, ...corsHeaders(req), 'content-type': image.type });
    return fs.createReadStream(image.file).pipe(res);
  }

  if (route === '/api/upload' && req.method === 'POST') {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const name = path.basename(query.get('name') || '');
    if (!/\.(pdf|doc|docx|xlsx|pptx|txt|md|csv|json|py|js|ts|tsx|jsx|sh|yaml|yml|toml|ini|log|xml|html|css|c|cpp|h|rs|go)$/i.test(name)) return json(req, res, 400, { error: '目前支持文档、表格、文本和代码文件' });
    const id = crypto.randomUUID();
    const dir = path.join(DATA_DIR, 'uploads', id);
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 20 * 1024 * 1024) throw new Error('文件不能超过 20 MB');
        chunks.push(chunk);
      }
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, name);
      fs.writeFileSync(filePath, Buffer.concat(chunks));
      uploads.set(id, { name, size, path: filePath, sel: query.get('sel') || '', deviceId: device.id, pending: true });
      return json(req, res, 200, { id, name, size });
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      return json(req, res, 400, { error: error.message });
    }
  }

  if (route === '/api/devices') return json(req, res, 200, { devices: listDevices().map(d => deviceView(d, device)) });
  if (route === '/api/devices/remove' && req.method === 'POST') {
    const { id } = await readJson(req);
    removeDevice(String(id));
    closeEventStreams(String(id));
    console.log(`[unpair] 移除设备 ${id}（操作来自「${device.name}」）`);
    return json(req, res, 200, { ok: true });
  }
  if (route === '/api/logout' && req.method === 'POST') {
    removeDevice(device.id);
    closeEventStreams(device.id);
    console.log(`[unpair] 设备「${device.name}」自己退出`);
    return json(req, res, 200, { ok: true });
  }

  // The Android app holds this open with POST: quick tunnels buffer GET event streams.
  if (route === '/api/events') return openEventStream(req, res, device.id);
  // Actions from an Android notification (reply / pick an option / accept the changes), run on that window.
  if (route === '/api/act' && req.method === 'POST') {
    const body = await readJson(req);
    try {
      await actOnWindow(device.id, body);
      return json(req, res, 200, { ok: true });
    } catch (e) {
      return json(req, res, 409, { error: e.message });
    }
  }
  if (route === '/api/push/key') return json(req, res, 200, { key: pushPublicKey() });
  if (route === '/api/push/state' && req.method === 'GET') {
    return json(req, res, 200, { subscribed: Boolean(device.push || device.apns), enabled: Boolean(device.push || device.apns) && device.pushEnabled !== false });
  }
  if (route === '/api/push/state' && req.method === 'POST') {
    const { enabled } = await readJson(req);
    if (typeof enabled !== 'boolean') return json(req, res, 400, { error: '通知状态无效' });
    if (enabled && !device.push && !device.apns) return json(req, res, 409, { error: '请先注册浏览器通知' });
    updateDevice(device.id, { pushEnabled: enabled });
    return json(req, res, 200, { ok: true });
  }
  if (route === '/api/push/subscribe' && req.method === 'POST') {
    const { sub } = await readJson(req);
    if (!/^https:\/\//.test(sub?.endpoint || '') || !sub.keys?.p256dh || !sub.keys?.auth) return json(req, res, 400, { error: '订阅信息无效' });
    updateDevice(device.id, { push: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, pushEnabled: true });
    return json(req, res, 200, { ok: true });
  }
  if (route === '/api/push/apns' && req.method === 'POST') {
    const { url, pushId, secret } = await readJson(req);
    const base = String(url || '').replace(/\/+$/, '');
    if (!/^https:\/\/[^\s]+$/.test(base) || base.length > 200) return json(req, res, 400, { error: '通知服务地址无效' });
    if (!/^[\w-]{10,100}$/.test(String(pushId || '')) || !/^[\w-]{10,100}$/.test(String(secret || ''))) return json(req, res, 400, { error: '通知凭据无效' });
    updateDevice(device.id, { apns: { url: base, pushId, secret }, pushEnabled: true });
    return json(req, res, 200, { ok: true });
  }
  if (route === '/api/push/unsubscribe' && req.method === 'POST') {
    updateDevice(device.id, { push: null, apns: null });
    return json(req, res, 200, { ok: true });
  }
  if (route === '/api/push/test' && req.method === 'POST') {
    await deliver({ kind: 'test', win: '', title: 'Remote Agent', body: '测试通知：能看到这条，说明通知已经通了 ✅',
      en: { body: 'Test notification: if you can see this, notifications work ✅' } }, device.id);
    return json(req, res, 200, { ok: true });
  }
  return json(req, res, 404, { error: 'not found' });
}
