import { authenticateDevice } from '../lib/device-proof.mjs';
import { WebSocketServer } from 'ws';
import { needsTotp, updateDevice, computerId, computerName, bindDeviceConnection } from '../lib/auth.mjs';
import { addViewer, removeViewer } from '../lib/notify.mjs';
import { clientIp } from './http/ratelimit.mjs';
import { originAllowed } from './http/static.mjs';
import { Session } from './session.mjs';
import { subscribeLibrary } from '../lib/session-library.mjs';
import { quotaErrorMessage } from './agent/context.mjs';
import { ROUTES, flag } from './routes.mjs';
import { voiceWss } from './voice/service.mjs';
import { cdpRead } from './cdp.mjs';

const SWITCH_READS = new Set(['attach', 'openAgent', 'agents', 'windows', 'connAgents', 'mode', 'visible', 'projects', 'docs', 'file', 'openMenu', 'params', 'terminals', 'termHistory', 'usage', 'settings', 'changes', 'thought', 'attachments', 'refresh', 'scrollChat', 'mentionQuery', 'workdir', 'codexSkills', 'codexRun', 'codexChat', 'sessionActions']);
const CONNECTION_MESSAGES = new Set(['mode', 'visible', 'lang', 'quality', 'windows', 'connAgents', 'visualList', 'visualSelect']);
const sameWindow = (session, msg) => !msg.sel || msg.sel.split('|', 2).join('|') === session.selectionKey().split('|', 2).join('|');

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

// A phone sent to the background often drops its socket without a close frame. Without a heartbeat the
// relay keeps that session as a visible viewer ("watching") and skips its notifications until TCP gives up.
const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (client.alive === false) { client.terminate(); continue; }
    client.alive = false;
    try { client.ping(); } catch {}
  }
}, 20000);
wss.on('close', () => clearInterval(heartbeat));

// The token arrives as the first message rather than in the URL, so it never shows up in proxy logs.
wss.on('connection', (ws, req) => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  let session = null;
  let authorization = null;
  const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), 5000);
  let queue = Promise.resolve();
  let questionQueue = Promise.resolve();
  let binding = 0;
  let reads = new AbortController();
  const agentReads = new Map();
  const imageActions = [];
  let imageGroup = 0;
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    if (!session) {
      clearTimeout(authTimer);
      const device = msg.t === 'auth' ? authenticateDevice(msg.token, msg.proof, 'WS /ws') : null;
      const identity = { id: computerId(), name: computerName(), device: device?.id || '' };
      if (!device || needsTotp(device)) {
        ws.send(JSON.stringify({ t: 'auth', ok: false, ...identity, needTotp: Boolean(device) }));
        return ws.close(4001, 'unauthorized');
      }
      updateDevice(device.id, { lastSeen: Date.now() });
      session = new Session(ws, device.id);
      authorization = bindDeviceConnection(device.id, () => ws.close(4001, 'unauthorized'));
      subscribeLibrary(ws);
      addViewer(session);
      ws.send(JSON.stringify({ t: 'auth', ok: true, ...identity }));
      console.log(`[+] client ${clientIp(req)}`);
      return;
    }
    if (!authorization.valid || ws.readyState !== 1) return;
    // Frame acks bypass the queue so a slow command never stalls the stream.
    if (msg.t === 'ack') return session.ack();
    const route = ROUTES[msg.t];
    const codexMention = msg.t === 'mentionQuery' && session.app === 'codex';
    if (codexMention) session.mentionSeq = msg.seq;
    const imageTransfer = msg.t === 'image' ? { cancelled: false } : null;
    if (imageTransfer) (session.imageTransfers ||= new Map()).set(msg.clientImageId, imageTransfer);
    if (route && flag(route.fast, session, msg)) {
      if (SWITCH_READS.has(msg.t)) {
        if (!sameWindow(session, msg)) return;
        const signal = reads.signal;
        cdpRead.run(signal, () => route.fastRun(session, msg)).catch(error => {
          if (!signal.aborted) session.emit({ t: 'status', ok: false, msg: error.message });
        });
      } else route.fastRun(session, msg);
      return;
    }
    const switching = msg.t === 'attach' || msg.t === 'openAgent';
    if (switching) {
      if (session.sessionBatch) session.sessionBatch.cancelled = true;
      binding++;
      reads.abort(new Error('窗口已切换'));
      reads = new AbortController();
    }
    const owner = binding;
    const readKind = msg.t === 'agents' ? `${!!msg.automatic}|${!!msg.silent}` : null;
    const readSerial = readKind && (agentReads.get(readKind) || 0) + 1;
    if (readKind) agentReads.set(readKind, readSerial);
    const imageAction = msg.t === 'removeAttachment' || msg.t === 'editImage';
    const group = msg.t === 'image' || imageAction ? imageGroup : ++imageGroup;
    let executed = false;
    const execute = async () => {
      if (!authorization.valid || ws.readyState !== 1) return;
      if (executed) return;
      executed = true;
      const actionIndex = imageActions.findIndex(action => action.execute === execute);
      if (actionIndex !== -1) imageActions.splice(actionIndex, 1);
      const staleSelection = !switching && !sameWindow(session, msg);
      if ((owner !== binding || staleSelection) && !CONNECTION_MESSAGES.has(msg.t)) {
        if (msg.t === 'saveFile') session.emit({ t: 'saved', requestId: msg.requestId, ok: false, error: '窗口已切换，保存未执行', path: msg.path, host: msg.host || '' });
        else route?.fail?.(session, msg);
        if (imageTransfer) session.imageTransfers.delete(msg.clientImageId);
        return;
      }
      if (codexMention && session.mentionSeq !== msg.seq) return;
      if (msg.t === 'image') {
        for (const action of imageActions.filter(action => action.group === group)) await action.execute();
      }
      if (readKind && agentReads.get(readKind) !== readSerial) return;
      if (!authorization.valid || ws.readyState !== 1) return;
      const q0 = Date.now();
      const signal = SWITCH_READS.has(msg.t) ? reads.signal : null;
      try {
        const queued = imageTransfer?.cancelled ? undefined : await cdpRead.run(signal, () => session.handle(msg));
        const ms = Date.now() - q0;
        if (ms > 3000) console.log(`[slow] ${msg.t} ${ms}ms ${session.app || ''}`);
        route?.after?.(session, msg, queued);
      } catch (e) {
        if (signal?.aborted) return;
        console.log(`[err] ${msg.t}: ${e.message}`);
        route?.fail?.(session, msg);
        session.emit({ t: 'status', ok: false, msg: quotaErrorMessage(session.app, e) || e.message });
      } finally {
        if (imageTransfer) session.imageTransfers.delete(msg.clientImageId);
      }
    };
    if (imageAction) imageActions.push({ group, execute });
    if (flag(route?.background, session, msg)) queue.then(execute);
    else if (msg.t === 'question' || msg.t === 'codexRequest') questionQueue = questionQueue.then(execute);
    else queue = (switching ? Promise.all([queue, questionQueue]) : queue).then(execute);
  });
  ws.on('close', () => {
    clearTimeout(authTimer);
    authorization?.release();
    reads.abort(new Error('连接已关闭'));
    if (!session) return;
    removeViewer(session);
    session.dispose();
    console.log(`[-] client ${clientIp(req)}`);
  });
});
}
