import { WebSocketServer } from 'ws';
import { findDevice, needsTotp, updateDevice, computerId, computerName } from '../lib/auth.mjs';
import { addViewer, removeViewer } from '../lib/notify.mjs';
import { clientIp } from './http/ratelimit.mjs';
import { originAllowed } from './http/static.mjs';
import { Session } from './session.mjs';
import { ROUTES, flag } from './routes.mjs';
import { voiceWss } from './voice/service.mjs';

export function attachWss(server) {
const voice = voiceWss();
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 4 << 20,
  perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 6 } },
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (!['/ws', '/voice'].includes(url.pathname) || !originAllowed(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  const target = url.pathname === '/voice' ? voice : wss;
  target.handleUpgrade(req, socket, head, ws => target.emit('connection', ws, req));
});

// The token arrives as the first message rather than in the URL, so it never shows up in proxy logs.
wss.on('connection', (ws, req) => {
  let session = null;
  const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), 5000);
  let queue = Promise.resolve();
  let questionQueue = Promise.resolve();
  const agentReads = new Map();
  const imageActions = [];
  let imageGroup = 0;
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!session) {
      clearTimeout(authTimer);
      const device = msg.t === 'auth' ? findDevice(msg.token) : null;
      const identity = { id: computerId(), name: computerName(), device: device?.id || '' };
      if (!device || needsTotp(device)) {
        ws.send(JSON.stringify({ t: 'auth', ok: false, ...identity, needTotp: Boolean(device) }));
        return ws.close(4001, 'unauthorized');
      }
      updateDevice(device.id, { lastSeen: Date.now() });
      session = new Session(ws, device.id);
      addViewer(session);
      ws.send(JSON.stringify({ t: 'auth', ok: true, ...identity }));
      console.log(`[+] client ${clientIp(req)}`);
      return;
    }
    // Frame acks bypass the queue so a slow command never stalls the stream.
    if (msg.t === 'ack') return session.ack();
    const route = ROUTES[msg.t];
    const imageTransfer = msg.t === 'image' ? { cancelled: false } : null;
    if (imageTransfer) (session.imageTransfers ||= new Map()).set(msg.clientImageId, imageTransfer);
    if (route && flag(route.fast, session, msg)) { route.fastRun(session, msg); return; }
    const readKind = msg.t === 'agents' ? `${!!msg.automatic}|${!!msg.silent}` : null;
    const readSerial = readKind && (agentReads.get(readKind) || 0) + 1;
    if (readKind) agentReads.set(readKind, readSerial);
    const imageAction = msg.t === 'removeAttachment' || msg.t === 'editImage';
    const group = msg.t === 'image' || imageAction ? imageGroup : ++imageGroup;
    let executed = false;
    const execute = async () => {
      if (executed) return;
      executed = true;
      const actionIndex = imageActions.findIndex(action => action.execute === execute);
      if (actionIndex !== -1) imageActions.splice(actionIndex, 1);
      if (msg.t === 'image') {
        for (const action of imageActions.filter(action => action.group === group)) await action.execute();
      }
      if (readKind && agentReads.get(readKind) !== readSerial) return;
      const q0 = Date.now();
      try {
        const queued = imageTransfer?.cancelled ? undefined : await session.handle(msg);
        const ms = Date.now() - q0;
        if (ms > 3000) console.log(`[slow] ${msg.t} ${ms}ms ${session.app || ''}`);
        route?.after?.(session, msg, queued);
      } catch (e) {
        console.log(`[err] ${msg.t}: ${e.message}`);
        route?.fail?.(session, msg);
        session.emit({ t: 'status', ok: false, msg: e.message });
      } finally {
        if (imageTransfer) session.imageTransfers.delete(msg.clientImageId);
      }
    };
    if (imageAction) imageActions.push({ group, execute });
    if (flag(route?.background, session, msg)) queue.then(execute);
    else if (msg.t === 'question' || msg.t === 'codexRequest') questionQueue = questionQueue.then(execute);
    else queue = queue.then(execute);
  });
  ws.on('close', () => {
    clearTimeout(authTimer);
    if (!session) return;
    removeViewer(session);
    session.dispose();
    console.log(`[-] client ${clientIp(req)}`);
  });
});
}
