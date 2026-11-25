import { WebSocketServer } from 'ws';
import { PhoneSessionRegistry } from './session-registry.mjs';
import { maxFrame } from './transport.mjs';

const registry = new PhoneSessionRegistry();

export const phoneTargets = deviceId => registry.targets(deviceId);
export const stopPhoneControl = (deviceId, id) => registry.stop(deviceId, id);
export const phoneTicket = (device, request) => registry.ticket(device, request);

export function phoneWss(sessions = registry) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxFrame, perMessageDeflate: false });
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.phoneAlive) { socket.terminate(); continue; }
      socket.phoneAlive = false;
      if (socket.readyState === 1) socket.ping();
    }
  }, 12000);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));
  wss.on('connection', socket => {
    const client = { socket };
    socket.phoneAlive = true;
    socket.on('pong', () => { socket.phoneAlive = true; });
    const authTimer = setTimeout(() => socket.close(4003, 'ticket timeout'), 5000);
    const disconnect = () => {
      clearTimeout(authTimer);
      if (client.retired) return;
      client.retired = true;
      sessions.disconnect(client);
    };
    socket.on('error', () => { disconnect(); socket.terminate(); });
    socket.on('message', (bytes, binary) => {
      if (client.retired) return;
      if (client.role && !client.authorization?.valid) {
        disconnect();
        socket.close(4003, 'authorization expired');
        return;
      }
      try {
        if (binary) {
          if (sessions.frame(client, bytes)) return;
        } else if (bytes.length <= (client.role === 'host' && client.session ? 160 * 1024 : 65536)) {
          const message = JSON.parse(bytes);
          if (!client.role && message.type === 'hello' && sessions.connect(client, message)) {
            clearTimeout(authTimer);
            return;
          }
          if (client.role && sessions.message(client, message)) return;
        }
      } catch {}
      disconnect();
      socket.close(4002, 'invalid phone message');
    });
    socket.on('close', disconnect);
  });
  return wss;
}
