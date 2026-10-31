import crypto from 'node:crypto';
import QRCode from 'qrcode-terminal/vendor/QRCode/index.js';
import { authenticateRequest } from '../../lib/device-proof.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, findDevice, needsTotp, totpConfig, verifyTotp, pairingSession, pairingDetails, consumePairing, listDevices, removeDevice, updateDevice, computerId, computerName, urlKey, appBase, groupDevices, deviceGrouping } from '../../lib/auth.mjs';
import { inviteEntry, joinEntry, entryRequests, decideEntry, entryStatus, cancelEntry, requestPairing, decideEntries } from './entries.mjs';
import { pushPublicKey, openEventStream, closeEventStreams, deliver } from '../../lib/notify.mjs';
import { clientIp, lockedOut, recordFailure } from './ratelimit.mjs';
import { json, readJson, originAllowed, corsHeaders, SECURITY_HEADERS } from './static.mjs';
import { readChatImage } from '../chat-images.mjs';
import { listWindows } from '../windows.mjs';
import { Cdp } from '../cdp.mjs';
import { helpersCall } from '../page/build.mjs';
import { Session } from '../session.mjs';
import { videoGrant, serveVideo, servePdf } from './video.mjs';
import { transferApi, serveTransfer } from './transfer.mjs';
import { voiceStatus, loadWorker } from '../voice/service.mjs';
import { voiceEngines } from '../voice/config.mjs';
import { uploads } from '../agent/context.mjs';
import { overviewSnapshot, overviewPreview, overviewSession } from '../overview.mjs';
import { NativeCdp, nativeWindowAt } from '../native-windows.mjs';
import { favoriteSession } from '../../lib/session-library.mjs';
import { catalogSessions, storedProjectSession } from '../project-windows.mjs';

// A device is usable once paired and, when 2FA asks for it, re-verified.
function deviceFor(req) {
  return authenticateRequest(req);
}

function bearer(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return m ? m[1] : '';
}

function deviceView(d, current) {
  return { id: d.id, name: d.name, groupId: d.groupId || d.id, groupName: d.groupName || d.name, entryName: d.entryName || d.name,
    created: d.created, lastSeen: d.lastSeen, current: d.id === current?.id };
}

async function actOnWindow(deviceId, { win, threadId, act, index, text, question }) {
  const wins = await listWindows();
  const w = wins.find(x => x.id === String(win));
  if (!w || w.app !== 'devin') throw new Error('找不到这个窗口，或它不支持通知里的操作');
  const s = new Session({ readyState: 3, send() {} }, deviceId);
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

async function manageOverviewSession(deviceId, body) {
  if (body.computer !== computerId()) throw new Error('所选电脑已变化，请刷新概览后重试');
  const { session, target } = overviewSession(deviceId, body);
  const { app, threadId, windowId } = session, action = body.action;
  const id = app === 'codex' ? `thread:${windowId}:${threadId}` : threadId;
  if (action === 'favorite') {
    if (body.favorite === true && !session.dormant) {
      const row = { ...storedProjectSession(app, threadId), id, title: session.title,
        ...(session.workspace ? { workspace: session.workspace, host: session.host } : {}) };
      delete row.dormant;
      catalogSessions(app, [row], windowId);
    }
    favoriteSession(app, threadId, body.favorite === true);
    return { ok: true };
  }
  if (action === 'copyLink') {
    if (app !== 'codex' || session.host) throw new Error('此会话没有本地 deeplink');
    return { text: `codex://threads/${threadId}` };
  }
  if (session.dormant) {
    if (action === 'actions') return { actions: [] };
    throw new Error('项目窗口已关闭，请先打开对话');
  }
  if (action === 'actions' && app === 'codex') return { actions: ['rename', 'archive'] };
  if (!['actions', 'rename', 'archive', 'delete', 'remove'].includes(action)) throw new Error('不支持的会话操作');
  const messages = [];
  const s = new Session({ readyState: 1, send: raw => messages.push(JSON.parse(raw)) }, deviceId);
  s.visible = s.notifyVisible = false;
  s.app = app;
  s.targetId = target.id;
  s.windowId = s.codexPageId = windowId;
  s.threadId = nativeWindowAt(target.ws).snapshot.chat?.thread || '';
  s.cdp = s.editorCdp = new NativeCdp(target.ws);
  // Management uses the native menu and library; it does not load a conversation screen.
  s.pollChat = s.listAgents = async () => {};
  try {
    await s.cdp.connect();
    if (action === 'actions') {
      await s.handle({ t: 'sessionActions', id });
      return { actions: messages.find(m => m.t === 'sessionActions').actions };
    }
    if (action === 'remove') {
      s.sessionEntries = new Map([[id, { id, app, running: session.busy }]]);
      await s.handle({ t: 'sessionBatch', ids: [id], requestId: crypto.randomUUID() });
      const result = messages.findLast(m => m.t === 'sessionBatchProgress').results[0];
      if (!result.ok) throw new Error(result.error);
    } else {
      await s.handle(app === 'codex'
        ? { t: action === 'rename' ? 'codexRename' : 'codexArchive', id, name: body.name }
        : { t: 'sessionManage', id, action, name: body.name });
    }
    return { ok: true };
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
  if (route.startsWith('/api/pdf/') && ['GET', 'HEAD'].includes(req.method)) {
    const grant = videoGrant(route.slice('/api/pdf/'.length));
    if (!grant) return json(req, res, 401, { error: 'PDF 链接已过期或设备授权已失效，请重新打开 PDF' });
    return servePdf(req, res, grant);
  }
  if (route.startsWith('/api/transfer/get/') && req.method === 'GET') return serveTransfer(req, res, route.slice('/api/transfer/get/'.length));
  if (route.startsWith('/api/approval/')) {
    const approval = /^Approval (.+)$/.exec(req.headers.authorization || '')?.[1];
    const batch = pairingSession(approval, true);
    if (!batch) return json(req, res, 401, { error: '电脑授权窗口已失效，请重新运行 npm run pair' });
    if (route === '/api/approval/info' && req.method === 'GET') {
      const details = pairingDetails(approval), qr = new QRCode(-1, 1);
      qr.addData(details.link); qr.make();
      return json(req, res, 200, { ...details, qr: qr.modules });
    }
    if (route === '/api/approval/requests' && req.method === 'GET') return json(req, res, 200, { requests: entryRequests(batch.id), expires: batch.expires, groupName: batch.groupName });
    if (req.method !== 'POST') return json(req, res, 405, { error: 'method not allowed' });
    const body = await readJson(req);
    if (!pairingSession(approval, true)) return json(req, res, 401, { error: '电脑授权窗口已失效' });
    if (route === '/api/approval/close') { consumePairing(approval); return json(req, res, 200, { ok: true }); }
    if (route === '/api/approval/next') return json(req, res, 200, pairingDetails(approval, true));
    if (route === '/api/approval/decide' && typeof body.approve === 'boolean') {
      try { decideEntries(batch.id, body.selections, body.approve); return json(req, res, 200, { ok: true }); }
      catch (error) { return json(req, res, 409, { error: error.message }); }
    }
    return json(req, res, 400, { error: '授权操作无效' });
  }
  const device = deviceFor(req);

  if (['/api/entries/join', '/api/entries/status', '/api/entries/cancel'].includes(route) && req.method === 'POST') {
    if (lockedOut(ip)) return json(req, res, 429, { error: '尝试次数过多，请稍后再试' });
    const body = await readJson(req);
    try {
      if (route.endsWith('/cancel')) { cancelEntry(body.id, body.secret); return json(req, res, 200, { ok: true }); }
      const result = route.endsWith('/join') ? joinEntry(body.invitation, body.name, body.publicKey, req.headers.origin) : entryStatus(body.id, body.secret);
      return json(req, res, 200, { ...result, id: route.endsWith('/join') ? result.id : computerId(), name: computerName() });
    } catch (error) {
      recordFailure(ip);
      return json(req, res, 401, { error: error.message });
    }
  }

  if (route === '/api/me') {
    return json(req, res, 200, { paired: Boolean(device), needTotp: needsTotp(device), totp: Boolean(totpConfig()), id: computerId(), name: computerName(), device: device?.id || '' });
  }

  if (route === '/api/pair' && req.method === 'POST') {
    if (lockedOut(ip)) return json(req, res, 429, { error: '尝试次数过多，请 15 分钟后再试' });
    const { code, name, totp, publicKey } = await readJson(req);
    const batch = pairingSession(code);
    if (!device && !batch) {
      recordFailure(ip);
      return json(req, res, 401, { error: '配对链接无效或已过期（3 分钟内有效）。请在电脑上重新运行 npm run pair' });
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
    try {
      const request = requestPairing(batch, name, publicKey, req.headers.origin);
      return json(req, res, 202, { ...request, pending: true, key: urlKey().toString('base64url') });
    } catch (error) { return json(req, res, 400, { error: error.message }); }
  }

  if (!device) return json(req, res, 401, { error: '设备未配对' });

  // Removing your own device needs no fresh 2FA: a phone that deletes this computer must be able to say goodbye.
  if (route === '/api/logout' && req.method === 'POST') {
    removeDevice(device.id);
    closeEventStreams(device.id);
    console.log(`[unpair] 设备「${device.name}」自己退出`);
    return json(req, res, 200, { ok: true });
  }

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
  if (route === '/api/entries/invite' && req.method === 'POST') {
    const { groupId, base } = await readJson(req);
    try {
      const result = inviteEntry(device, groupId);
      let link = '';
      try {
        const target = new URL(String(base || ''));
        if (target.protocol === 'http:' || target.protocol === 'https:') {
          target.hash = `entry=${urlKey().toString('base64url')}.${result.invitation}`;
          link = target.href;
        }
      } catch {}
      if (!link) link = `${appBase()}#entry=${urlKey().toString('base64url')}.${result.invitation}`;
      const qr = new QRCode(-1, 1);
      qr.addData(link); qr.make();
      return json(req, res, 200, { ...result, link, qr: qr.modules });
    }
    catch (error) { return json(req, res, 400, { error: error.message }); }
  }
  if (route === '/api/entries/decide' && req.method === 'POST') {
    const { id, code, approve } = await readJson(req);
    if (typeof approve !== 'boolean') return json(req, res, 400, { error: '请选择同意或拒绝' });
    // readJson yields: recheck the approving credential before granting access.
    const approver = findDevice(bearer(req));
    if (!approver || needsTotp(approver)) return json(req, res, 401, { error: '授权入口已失效' });
    try { decideEntry(id, code, approve); return json(req, res, 200, { ok: true }); }
    catch (error) { return json(req, res, 409, { error: error.message }); }
  }
  if (route === '/api/devices/group' && req.method === 'POST') {
    const { ids, groupId, name } = await readJson(req);
    if (!Array.isArray(ids) || !groupDevices(ids, groupId, name)) return json(req, res, 400, { error: '设备分组或入口无效' });
    return json(req, res, 200, { ok: true });
  }
  if (route === '/api/voice' && req.method === 'GET') return json(req, res, 200, voiceStatus());
  if (route === '/api/voice' && req.method === 'POST') {
    const engine = new URL(req.url, 'http://localhost').searchParams.get('engine');
    if (!engine || !voiceEngines().some(e => e.id === engine)) return json(req, res, 400, { error: '缺少或未知的语音引擎' });
    // No client/device is attached: warming an engine must never stop another engine.
    try { await loadWorker(engine); return json(req, res, 200, voiceStatus()); }
    catch (error) { return json(req, res, 503, { error: error.message }); }
  }
  if (route.startsWith('/api/transfer/')) return transferApi(req, res, route, device);
  if (route.startsWith('/api/chat-image/') && req.method === 'GET') {
    const image = await readChatImage(route.slice('/api/chat-image/'.length));
    if (!image) return json(req, res, 404, { error: '图片不存在' });
    res.writeHead(200, { ...SECURITY_HEADERS, ...corsHeaders(req), 'content-type': image.type });
    return fs.createReadStream(image.file).pipe(res);
  }

  if (route === '/api/upload/cancel' && req.method === 'POST') {
    const { clientImageId } = await readJson(req);
    for (const [id, file] of uploads) if (file.clientImageId === clientImageId && file.deviceId === device.id && file.image) {
      file.request?.destroy();
      fs.rmSync(path.dirname(file.path), { recursive: true, force: true });
      uploads.delete(id);
    }
    return json(req, res, 200, { ok: true });
  }
  if (route === '/api/upload' && req.method === 'POST') {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const name = path.basename(query.get('name') || '');
    const image = query.get('image'), type = query.get('type');
    if (image ? !/^image\/(png|jpeg|gif|webp)$/.test(type) : !/\.(pdf|doc|docx|xlsx|pptx|txt|md|csv|json|py|js|ts|tsx|jsx|sh|yaml|yml|toml|ini|log|xml|html|css|c|cpp|h|rs|go)$/i.test(name)) return json(req, res, 400, { error: image ? '只支持 PNG / JPEG / GIF / WebP 图片' : '目前支持文档、表格、文本和代码文件' });
    const id = crypto.randomUUID();
    const dir = path.join(DATA_DIR, 'uploads', id);
    const filePath = path.join(dir, name);
    const file = { name, path: filePath, sel: query.get('sel') || '', deviceId: device.id, pending: !image };
    if (image) { Object.assign(file, { image: true, clientImageId: image, type, request: req }); uploads.set(id, file); }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 20 * 1024 * 1024) throw new Error('文件不能超过 20 MB');
        chunks.push(chunk);
      }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, Buffer.concat(chunks));
      delete file.request;
      file.size = size;
      uploads.set(id, file);
      return json(req, res, 200, { id, name, size });
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      uploads.delete(id);
      return json(req, res, 400, { error: error.message });
    }
  }

  if (route === '/api/devices') {
    const devices = listDevices(), groups = deviceGrouping(devices);
    return json(req, res, 200, { devices: devices.map(d => ({ ...deviceView(d, device), ...groups.get(d.id) })), requests: entryRequests() });
  }
  if (route === '/api/devices/remove' && req.method === 'POST') {
    const { id } = await readJson(req);
    removeDevice(String(id));
    closeEventStreams(String(id));
    console.log(`[unpair] 移除设备 ${id}（操作来自「${device.name}」）`);
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
  if (route === '/api/overview' && req.method === 'GET') return json(req, res, 200, { id: computerId(), name: computerName(), ...overviewSnapshot(device.id) });
  if (route === '/api/overview/preview' && req.method === 'GET') {
    try {
      const target = Object.fromEntries(new URL(req.url, 'http://relay').searchParams);
      return json(req, res, 200, { computer: computerId(), ...await overviewPreview(device.id, target) });
    } catch (error) { return json(req, res, 409, { error: error.message }); }
  }
  if (route === '/api/overview/session' && req.method === 'POST') {
    const body = await readJson(req);
    try { return json(req, res, 200, await manageOverviewSession(device.id, body)); }
    catch (error) { return json(req, res, 409, { error: error.message }); }
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
