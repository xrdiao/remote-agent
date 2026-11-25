import { authenticateDevice, commandVerifier } from '../lib/device-proof.mjs';
import { WebSocketServer } from 'ws';
import { needsTotp, findDevice, updateDevice, computerId, computerName, bindDeviceConnection, lastSelection } from '../lib/auth.mjs';
import { addViewer, removeViewer } from '../lib/notify.mjs';
import { clientIp } from './http/ratelimit.mjs';
import { originAllowed } from './http/static.mjs';
import { subscribeLibrary } from '../lib/session-library.mjs';
import { subscribeOperations } from './operations.mjs';
import { voiceWss } from './voice/service.mjs';
import { phoneWss } from './phone/control.mjs';
import { CommandScheduler } from './ws/scheduler.mjs';
import { SessionRecovery } from './ws/recovery.mjs';

const BACKGROUND_MS = 5 * 60 * 1000;

export function attachWss(server, recovery = new SessionRecovery()) {
  const voice = voiceWss();
  const phone = phoneWss();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4 << 20,
    perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 6 } },
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (!['/ws', '/voice', '/phone'].includes(url.pathname) || !originAllowed(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    const target = url.pathname === '/phone' ? phone : url.pathname === '/voice' ? voice : wss;
    target.handleUpgrade(req, socket, head, ws => target.emit('connection', ws, req));
  });

  // Mobile backgrounding can silently drop TCP and leave a viewer counted as watching.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.alive === false && !client.backgroundTimer) {
        client.closeSource = 'heartbeat';
        client.terminate();
        continue;
      }
      client.alive = false;
      try { client.ping(); } catch {}
    }
  }, 20000);
  wss.on('close', () => {
    clearInterval(heartbeat);
    recovery.close();
  });
  wss.on('connection', (ws, req) => connect(ws, req, recovery));
}

function connect(ws, req, recovery) {
  let authenticating = false, retired = false;
  let authorization, context, restoring, scheduler, commands, unsubscribeOperations, unsubscribeLibrary;
  const authorized = () => !retired && authorization?.valid === true && ws.readyState === 1;
  const authTimer = setTimeout(() => ws.close(4000, 'auth timeout'), 5000);
  ws.alive = true;
  ws.backgroundTimer = null;
  ws.on('pong', () => { ws.alive = true; });

  const connection = {
    ws,
    authorized,
    get scheduler() { return scheduler; },
    close(code, reason) { ws.close(code, reason); },
    retire(keepBinding) {
      retire(keepBinding);
      ws.close(4002, 'connection replaced');
    },
  };

  function retire(keepBinding) {
    if (retired) return;
    retired = true;
    authorization?.release();
    unsubscribeOperations?.();
    unsubscribeLibrary?.();
    if (!context) { recovery.releaseClaim(restoring, connection); return; }
    const session = context.session;
    session.connectionView.retire();
    session.stopTerminalUpdates();
    removeViewer(session);
    scheduler.retire();
    recovery.disconnect(context, connection, keepBinding);
  }

  async function authenticate(msg) {
    authenticating = true;
    clearTimeout(authTimer);
    const resume = typeof msg.resume === 'string' ? msg.resume : null;
    const scope = 'WS /ws\n' + JSON.stringify([resume, msg.selectiveOperations === true]);
    const device = msg.t === 'auth' ? authenticateDevice(msg.token, msg.proof, scope) : null;
    const identity = { id: computerId(), name: computerName(), device: device?.id || '' };
    if (!device || needsTotp(device)) {
      ws.send(JSON.stringify({ t: 'auth', ok: false, ...identity, needTotp: Boolean(device) }));
      return ws.close(4001, 'unauthorized');
    }
    authorization = bindDeviceConnection(device.id, () => {
      retire(false);
      ws.close(4001, 'unauthorized');
    });
    if (!authorized()) return;
    updateDevice(device.id, { lastSeen: Date.now() });
    const previous = restoring = recovery.candidate(resume, device.id);
    if (previous) {
      ws.send(JSON.stringify({ t: 'auth', ok: true, ...identity, restoring: true }));
      await recovery.claim(previous, connection);
      if (!authorized() || previous.claim !== connection) return;
      const current = findDevice(msg.token);
      if (!current || current.id !== device.id || needsTotp(current)) {
        ws.send(JSON.stringify({ t: 'auth', ok: false, ...identity, needTotp: Boolean(current) }));
        retire(false);
        return ws.close(4001, 'unauthorized');
      }
    }

    const { context: next, resumed } = recovery.activate(previous, connection, device.id);
    restoring = null;
    context = next;
    const session = context.session;
    session.connectionView.connect(ws, authorized);
    scheduler = new CommandScheduler(session, authorized);
    commands = commandVerifier(device, '/ws');
    const recipient = session.connectionView.recipient();
    unsubscribeLibrary = subscribeLibrary(recipient);
    addViewer(session);
    ws.send(JSON.stringify({ t: 'auth', ok: true, ...identity, lastSelection: lastSelection(device.id),
      resumeId: session.resumeId, resumed, mode: session.mode, draftEpoch: session.draftEpoch || '',
      selectiveOperations: true, commandSession: commands.connection,
      ...(resumed ? { selection: { id: session.targetId, app: session.app, windowId: session.windowId, threadId: session.threadId },
        metadata: [...session.connectionMessages.values()].filter(message => message.t !== 'attached') } : {}) }));
    if (authorized()) unsubscribeOperations = subscribeOperations(device.id, recipient, msg.selectiveOperations !== true);
    console.log(`[+] client ${clientIp(req)}`);
  }

  // The entry token is sent in the first message so it does not appear in proxy URLs.
  ws.on('message', async (raw, binary) => {
    if (retired || context && !authorized()) return;
    let msg;
    try { msg = !binary && (commands ? commands.read(raw) : JSON.parse(raw)); } catch {}
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      if (context) {
        retire(authorization.valid);
        ws.close(4003, 'invalid command proof');
      }
      return;
    }
    if (!context) {
      if (!authenticating) await authenticate(msg);
      return;
    }
    if (msg.t === 'visible' && typeof msg.background === 'boolean') {
      if (!msg.background) {
        if (ws.backgroundTimer) ws.alive = true;
        clearTimeout(ws.backgroundTimer);
        ws.backgroundTimer = null;
      } else ws.backgroundTimer ||= setTimeout(() => {
        ws.closeSource = 'background';
        ws.close(4000, 'background timeout');
      }, BACKGROUND_MS);
    }
    return context.session.connectionView.run(() => scheduler.accept(msg));
  });

  ws.on('close', code => {
    clearTimeout(authTimer);
    clearTimeout(ws.backgroundTimer);
    console.log(`[ws-close] ${new Date().toISOString()} code=${code} source=${ws.closeSource || 'peer'} authorized=${!!authorization?.valid} background=${!!ws.backgroundTimer}`);
    if (retired) return;
    retire(authorization?.valid);
    if (context) console.log(`[-] client ${clientIp(req)}`);
  });
}
