import { authenticateDevice } from '../lib/device-proof.mjs';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { needsTotp, findDevice, updateDevice, computerId, computerName, bindDeviceConnection } from '../lib/auth.mjs';
import { addViewer, removeViewer } from '../lib/notify.mjs';
import { clientIp } from './http/ratelimit.mjs';
import { originAllowed } from './http/static.mjs';
import { Session } from './session.mjs';
import { subscribeLibrary } from '../lib/session-library.mjs';
import { quotaErrorMessage } from './agent/context.mjs';
import { ROUTES, flag } from './routes.mjs';
import { voiceWss } from './voice/service.mjs';
import { lastSelection } from '../lib/auth.mjs';
import { cdpRead } from './cdp.mjs';
import { beginOperation, withOperation, subscribeOperations } from './operations.mjs';
import { configureNativeRetry } from './native-windows.mjs';

const sameWindow = (session, msg) => !msg.sel || msg.sel.split('|', 2).join('|') === session.selectionKey().split('|', 2).join('|');
const navigationMessage = msg => ROUTES[msg.t]?.navigation === true;
const pureNavigation = msg => navigationMessage(msg) && msg.newSession !== true && msg.create !== true && !(msg.t === 'openAgent' && /^(?:new:|project-new:)/.test(msg.id || ''));
const RESUME_MS = 5 * 60 * 1000;

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
    if (client.alive === false) { client.closeSource = 'heartbeat'; client.terminate(); continue; }
    client.alive = false;
    try { client.ping(); } catch {}
  }
}, 20000);
const contexts = new Map();
const disposeContext = context => {
  clearTimeout(context.timer);
  if (contexts.get(context.session.resumeId) === context) contexts.delete(context.session.resumeId);
  context.expire?.();
  context.session.dispose();
};
wss.on('close', () => {
  clearInterval(heartbeat);
  for (const context of contexts.values()) disposeContext(context);
  contexts.clear();
});

// The token arrives as the first message rather than in the URL, so it never shows up in proxy logs.
wss.on('connection', (ws, req) => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  let session = null;
  let context = null;
  let authenticating = false;
  let retired = false;
  let authorization = null;
  let unsubscribeOperations = null;
  const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), 5000);
  let queue = Promise.resolve();
  const sends = new Set();
  let questionQueue = Promise.resolve();
  let binding = 0;
  let activeBinding = 0;
  let reads = new AbortController();
  let navigationReads = new AbortController();
  let activeNavigation = null;
  let pendingNavigation = null;
  const agentReads = new Map();
  const pendingMetadata = new Set();
  const imageActions = [];
  let imageGroup = 0;
  const tasks = new Set();
  const track = task => {
    tasks.add(task);
    task.then(() => tasks.delete(task), () => tasks.delete(task));
    return task;
  };
  const retain = () => {
    context.owner = null;
    context.expires = Date.now() + RESUME_MS;
    context.expiry = new Promise(resolve => { context.expire = resolve; });
    context.timer = setTimeout(() => disposeContext(context), RESUME_MS);
    context.timer.unref();
    context.draining = Promise.allSettled([...tasks]).then(() => {
      if (!session.disposed && !context.owner) session.suspend();
    });
  };
  const connection = { ws, retire() {
    retired = true;
    authorization.valid = false;
    authorization.release();
    unsubscribeOperations?.();
    removeViewer(session);
    reads.abort(new Error('连接已移交'));
    retain();
    ws.close(4002, 'connection replaced');
  } };
  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    if (!session) {
      if (authenticating) return;
      authenticating = true;
      clearTimeout(authTimer);
      const device = msg.t === 'auth' ? authenticateDevice(msg.token, msg.proof, 'WS /ws') : null;
      const identity = { id: computerId(), name: computerName(), device: device?.id || '' };
      if (!device || needsTotp(device)) {
        ws.send(JSON.stringify({ t: 'auth', ok: false, ...identity, needTotp: Boolean(device) }));
        return ws.close(4001, 'unauthorized');
      }
      authorization = bindDeviceConnection(device.id, () => ws.close(4001, 'unauthorized'));
      if (!authorization.valid || ws.readyState !== 1) return;
      updateDevice(device.id, { lastSeen: Date.now() });
      const previous = contexts.get(msg.resume);
      const candidate = previous?.session.deviceId === device.id && previous.expires > Date.now()
        && !previous.session.disposed && previous.session.cdp?.ws?.readyState === 1
        && ['cursor', 'devin', 'codex'].includes(previous.session.app);
      if (candidate) {
        previous.claim?.close(4002, 'connection replaced');
        previous.claim = ws;
        ws.send(JSON.stringify({ t: 'auth', ok: true, ...identity, restoring: true }));
        previous.owner?.retire();
        await Promise.race([previous.draining, previous.expiry]);
        if (!authorization.valid || ws.readyState !== 1 || previous.claim !== ws) return;
        const currentDevice = findDevice(msg.token);
        if (!currentDevice || currentDevice.id !== device.id || needsTotp(currentDevice)) {
          authorization.valid = false;
          ws.send(JSON.stringify({ t: 'auth', ok: false, ...identity, needTotp: Boolean(currentDevice) }));
          return ws.close(4001, 'unauthorized');
        }
        previous.claim = null;
      }
      const resumed = candidate && contexts.get(msg.resume) === previous && previous.expires > Date.now()
        && previous.session.bindingReady && !previous.session.disposed && previous.session.cdp?.ws?.readyState === 1;
      if (resumed) {
        clearTimeout(previous.timer);
        context = previous;
        session = previous.session;
        session.client = ws;
      } else {
        if (candidate && contexts.get(msg.resume) === previous) disposeContext(previous);
        session = new Session(ws, device.id);
        session.resumeId = crypto.randomUUID();
        context = { session };
        contexts.set(session.resumeId, context);
      }
      context.owner = connection;
      context.expires = Infinity;
      subscribeLibrary(ws);
      addViewer(session);
      ws.send(JSON.stringify({ t: 'auth', ok: true, ...identity, lastSelection: lastSelection(device.id),
        resumeId: session.resumeId, resumed: !!resumed, mode: session.mode, draftEpoch: session.draftEpoch || '',
        ...(resumed ? { selection: { id: session.targetId, app: session.app, windowId: session.windowId, threadId: session.threadId },
          metadata: [...session.connectionMessages.values()].filter(message => message.t !== 'attached') } : {}) }));
      unsubscribeOperations = subscribeOperations(device.id, ws);
      console.log(`[+] client ${clientIp(req)}`);
      return;
    }
    if (!authorization.valid || ws.readyState !== 1) return;
    const route = ROUTES[msg.t];
    const request = beginOperation(session, msg);
    if (request?.duplicate) return;
    const operation = request?.operation;
    const run = action => track(withOperation(operation, async () => {
      if (operation) session.activeOperations = (session.activeOperations || 0) + 1;
      try { return await action(); }
      finally {
        operation?.finish();
        if (operation && !--session.activeOperations && session.disposed) session.dispose();
      }
    }));
    const sendRequest = msg.t === 'send' && msg.submit !== false && session.app !== 'fusion'
      ? { controller: new AbortController(), sel: msg.sel || session.selectionKey(), msg, operation } : null;
    if (sendRequest) sends.add(sendRequest);
    if (msg.t === 'stop' && session.app !== 'fusion') {
      const scope = msg.sel || session.selectionKey();
      for (const pending of sends) if (pending.sel === scope && !pending.operation?.submitted && !pending.controller.signal.aborted) {
        const error = Object.assign(new Error('发送已取消，草稿已保留'), { cancelled: true });
        pending.controller.abort(error);
        withOperation(pending.operation, () => ROUTES.send.fail(session, pending.msg, error));
      }
    }
    const mention = msg.t === 'mentionQuery';
    if (mention) session.mentionSeq = msg.seq;
    if (msg.t === 'openMenu') session.menuRequest = msg.requestId;
    const imageTransfer = msg.t === 'image' ? { cancelled: false } : null;
    if (imageTransfer) (session.imageTransfers ||= new Map()).set(msg.clientImageId, imageTransfer);
    const metadataKind = msg.t === 'agents' ? `agents|${!!msg.automatic}|${!!msg.silent}|${msg.projectWindow || ''}`
      : msg.t === 'windows' ? 'windows' : msg.t === 'usage' && msg.automatic === true ? 'usage' : '';
    const metadataKey = metadataKind && `${binding}|${metadataKind}`;
    if (metadataKey && pendingMetadata.has(metadataKey)) return;
    if (metadataKey) pendingMetadata.add(metadataKey);
    if (route && flag(route.fast, session, msg)) {
      if (route.switchRead && !sameWindow(session, msg)) { pendingMetadata.delete(metadataKey); return; }
      const signal = route.switchRead ? reads.signal : null;
      run(async () => {
        try { await cdpRead.run(signal, () => route.fastRun(session, msg)); }
        catch (error) {
          if (!signal?.aborted) {
            route.fail?.(session, msg, error);
            session.emit({ t: 'status', ok: false, msg: error.message });
          }
        } finally { pendingMetadata.delete(metadataKey); }
      });
      return;
    }
    const switching = navigationMessage(msg);
    const navigation = pureNavigation(msg) ? { started: false, superseded: false } : null;
    if (navigation) {
      if (pendingNavigation && !pendingNavigation.started) pendingNavigation.superseded = true;
      pendingNavigation = navigation;
    } else if (route?.switchRead !== true && route?.connection !== true) pendingNavigation = null;
    if (switching) {
      if (session.app !== 'fusion') configureNativeRetry(session.deviceId, null);
      if (navigation && activeNavigation) navigationReads.abort(new Error('窗口已切换'));
      session.chatRead?.controller.abort(new Error('窗口已切换'));
      if (session.sessionBatch) session.sessionBatch.cancelled = true;
      binding++;
      reads.abort(new Error('窗口已切换'));
      reads = new AbortController();
    }
    const owner = binding;
    const readKind = metadataKind;
    const readSerial = readKind && (agentReads.get(readKind) || 0) + 1;
    if (readKind) agentReads.set(readKind, readSerial);
    const imageAction = msg.t === 'removeAttachment' || msg.t === 'editImage';
    const group = msg.t === 'image' || imageAction ? imageGroup : ++imageGroup;
    let executed = false;
    const execute = async () => {
      if (!authorization.valid || ws.readyState !== 1) {
        if (operation) {
          const error = new Error('连接已断开，操作未执行');
          route?.fail?.(session, msg, error);
          if (msg.t !== 'send') session.emit({ t: 'status', ok: false, msg: error.message });
        }
        if (sendRequest) sends.delete(sendRequest);
        return;
      }
      if (executed) return;
      executed = true;
      try {
      if (sendRequest?.controller.signal.aborted) return;
      if (navigation?.superseded) return;
      if (navigation) navigation.started = true;
      const actionIndex = imageActions.findIndex(action => action.execute === executeRequest);
      if (actionIndex !== -1) imageActions.splice(actionIndex, 1);
      const staleSelection = !switching && !sameWindow(session, msg);
      if (metadataKind && owner !== binding) return;
      const readOnly = route?.switchRead === true && !switching;
      if ((!switching && owner !== (readOnly ? binding : activeBinding) || staleSelection) && route?.connection !== true) {
        if (msg.t === 'saveFile') session.emit({ t: 'saved', requestId: msg.requestId, ok: false, error: '窗口已切换，保存未执行', path: msg.path, host: msg.host || '' });
        else route?.fail?.(session, msg);
        if (operation && !route?.fail && msg.t !== 'saveFile') session.emit({ t: 'status', ok: false, msg: '会话已切换，操作未执行' });
        if (imageTransfer) session.imageTransfers.delete(msg.clientImageId);
        return;
      }
      if (mention && session.mentionSeq !== msg.seq) return;
      if (msg.t === 'openMenu' && session.menuRequest !== msg.requestId) return;
      if (msg.t === 'image') {
        for (const action of imageActions.filter(action => action.group === group)) await action.execute();
      }
      if (readKind && agentReads.get(readKind) !== readSerial) return;
      if (!authorization.valid || ws.readyState !== 1) return;
      if (switching) {
        activeBinding = owner;
        reads.abort(new Error('窗口已切换'));
        reads = new AbortController();
        navigationReads.abort(new Error('窗口已切换'));
        navigationReads = new AbortController();
        navigationReads.signal.navigationId = msg.navigationId;
        session.navigationId = msg.navigationId;
        activeNavigation = navigation;
      }
      const q0 = Date.now();
      const signal = sendRequest?.controller.signal || (switching ? navigationReads.signal : route?.switchRead === true ? reads.signal : null);
      const navigationDeadline = msg.t === 'attach' && msg.initial === true ? q0 + 30000 : null;
      if (navigationDeadline) signal.deadline = navigationDeadline;
      let timedOut = false;
      const navigationTimer = navigationDeadline ? setTimeout(() => {
        timedOut = true;
        navigationReads.abort(new Error('当前会话读取超时，请重试或切换 Agent'));
      }, Math.max(0, navigationDeadline - Date.now())) : null;
      const result = switching && session.app !== 'fusion' && msg.id !== 'fusion' ? { id: msg.navigationId } : null;
      if (result) session.navigationResult = result;
      try {
        const queued = imageTransfer?.cancelled ? undefined : await cdpRead.run(signal, () => session.handle(msg));
        if (result && !signal?.aborted) session.finishNavigationResult(result);
        const ms = Date.now() - q0;
        if (ms > 3000) console.log(`[slow] ${msg.t} ${ms}ms ${session.app || ''}`);
        route?.after?.(session, msg, queued);
      } catch (e) {
        if (session.navigationResult === result) session.navigationResult = null;
        if (signal?.aborted && !timedOut) return;
        console.log(`[err] ${msg.t}: ${e.message}`);
        if (switching && session.app !== 'fusion' && msg.id !== 'fusion') {
          navigationReads.abort(e);
          reads.abort(e);
          reads = new AbortController();
          await cdpRead.run(null, () => session.navigationFailed(msg, e));
          return;
        }
        route?.fail?.(session, msg, e);
        if (switching && msg.t !== 'attach') session.emit({ t: 'attachFailed', ready: session.bindingReady === true });
        if (msg.t !== 'send') session.emit({ t: 'status', ok: false, msg: quotaErrorMessage(session.app, e) || e.message });
      } finally {
        if (session.navigationResult === result) session.navigationResult = null;
        clearTimeout(navigationTimer);
        if (switching && activeNavigation === navigation) activeNavigation = null;
        if (imageTransfer) session.imageTransfers.delete(msg.clientImageId);
      }
      } finally {
        if (metadataKey) pendingMetadata.delete(metadataKey);
        if (sendRequest) sends.delete(sendRequest);
      }
    };
    const executeRequest = () => run(execute);
    if (imageAction) imageActions.push({ group, execute: executeRequest });
    if (flag(route?.background, session, msg)) track(queue.then(executeRequest));
    else if (msg.t === 'question' || msg.t === 'codexRequest') track(questionQueue = questionQueue.then(executeRequest));
    else track(queue = (switching ? Promise.all([queue, questionQueue]) : queue).then(executeRequest));
  });
  ws.on('close', code => {
    clearTimeout(authTimer);
    const authorized = authorization?.valid;
    authorization?.release();
    unsubscribeOperations?.();
    console.log(`[ws-close] ${new Date().toISOString()} code=${code} source=${ws.closeSource || 'peer'} authorized=${!!authorized}`);
    if (retired) return;
    reads.abort(new Error('连接已关闭'));
    if (!session || context.owner !== connection) return;
    if (session.sessionBatch) session.sessionBatch.cancelled = true;
    removeViewer(session);
    if (authorized && !session.disposed && session.cdp?.ws?.readyState === 1
        && ['cursor', 'devin', 'codex'].includes(session.app)) {
      retain();
    } else {
      navigationReads.abort(new Error('连接已关闭'));
      disposeContext(context);
    }
    console.log(`[-] client ${clientIp(req)}`);
  });
});
}
