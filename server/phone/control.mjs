import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { bindDeviceConnection } from '../../lib/auth.mjs';
import { bindPhoneMcp } from './mcp.mjs';

const phones = new Map(), tickets = new Map();
const ticketLifetime = 20000;
const maxFrame = 512 * 1024;
const nodeActions = new Set(['click', 'longClick', 'scrollForward', 'scrollBackward', 'text']);
const globalActions = new Set(['back', 'home', 'recents']);
const send = (socket, value) => {
  if (socket?.readyState === 1) socket.send(JSON.stringify(value));
};

function ticket(value) {
  const token = crypto.randomBytes(24).toString('base64url');
  const item = { ...value, timer: setTimeout(() => tickets.delete(token), ticketLifetime) };
  item.timer.unref();
  tickets.set(token, item);
  return token;
}

export function phoneTargets(deviceId) {
  return [...phones.values()].filter(phone => phone.device.id !== deviceId && !phone.session)
    .map(({ device, agentVersion }) => ({ id: device.id, name: device.name, agent: agentVersion === 1 }));
}

export function phoneTicket(device, { role, phone, agent } = {}) {
  if (role === 'host' && !phones.has(device.id)) return ticket({ role, device });
  const host = phones.get(phone);
  if (role === 'controller' && device.id !== phone && host && !host.session && (agent !== true || host.agentVersion === 1))
    return ticket({ role, device, phone, agent: agent === true });
  return null;
}

function end(session, reason) {
  const { host, viewer } = session;
  if (host.session !== session) return;
  session.active = false;
  host.session = null;
  viewer.session = null;
  clearTimeout(session.approvalTimer);
  settleAction(session, { ok: false, reason });
  session.agentAccess?.abort(new Error(`Phone session ended: ${reason}`));
  session.mcp?.close();
  session.frame = null;
  session.upload?.close();
  session.download?.close();
  send(host.socket, { type: 'ended', reason });
  send(viewer.socket, { type: 'ended', reason });
  viewer.socket.close();
}

function connectViewer(viewer, phoneId, agent) {
  const host = phones.get(phoneId);
  if (!host || host.session || host.device.id === viewer.device.id) return false;
  const session = { id: crypto.randomUUID(), host, viewer, active: false, screen: 0, tree: 0, nextAction: 0 };
  if (agent) {
    session.agentAccess = new AbortController();
    session.events = new EventEmitter();
  }
  session.approvalTimer = setTimeout(() => end(session, 'approvalExpired'), 90000);
  session.approvalTimer.unref();
  host.session = viewer.session = session;
  send(viewer.socket, { type: 'waiting' });
  send(host.socket, { type: 'request', id: session.id, name: agent ? `${viewer.device.name} · AI Agent` : viewer.device.name });
  return true;
}

function phoneDecision(session, message) {
  if (session.active || message.id !== session.id) return false;
  if (message.type === 'reject') { end(session, 'rejected'); return true; }
  clearTimeout(session.approvalTimer);
  session.active = true;
  const { host, viewer } = session;
  send(host.socket, { type: 'started', ticket: ticket({ role: 'upload', device: host.device, session }), agent: !!session.agentAccess });
  send(viewer.socket, { type: 'started', ticket: ticket({ role: 'download', device: viewer.device, session }) });
  if (session.agentAccess) startAgent(session);
  return true;
}

async function startAgent(session) {
  try {
    const mcp = await bindPhoneMcp({
      signal: session.agentAccess.signal, events: session.events,
      state: () => session.observation && { ...session.observation, screen: session.geometry },
      image: () => session.frame && { frame: session.frame, screen: session.geometry },
      act: (message, signal) => new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        startAction(session, actionContent(message, session, true), ack => {
          signal.removeEventListener('abort', abort);
          resolve(ack);
        });
      }),
      exclusive: async run => {
        if (session.agentBusy || session.action) throw Error('The phone is processing another operation');
        session.agentBusy = true;
        send(session.viewer.socket, { type: 'agentBusy', busy: true });
        try { return await run(); }
        finally {
          session.agentBusy = false;
          if (session.active) send(session.viewer.socket, { type: 'agentBusy', busy: false });
        }
      },
    });
    if (!session.active) { mcp.close(); return; }
    session.mcp = mcp;
    send(session.viewer.socket, { type: 'agentTools', url: mcp.url });
  } catch { if (session.active) send(session.viewer.socket, { type: 'agentTools', error: '无法启动本机 Agent 工具' }); }
}

function startFrames(session) {
  if (!session.screen || !session.upload || !session.download || session.framesReady) return;
  session.framesReady = true;
  send(session.host.socket, { type: 'framesReady' });
}

const validPoint = v => typeof v === 'number' && v >= 0 && v <= 1;
function actionContent(message, session, agent = false) {
  const { kind, revision, node, action, text, x, y, endX, endY, duration } = message;
  if (kind === 'inspect') return { kind };
  if (agent && kind === 'apps') return { kind };
  if (agent && kind === 'launch' && typeof message.app === 'string' && /^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+$/.test(message.app))
    return { kind, app: message.app };
  if (kind === 'system' && globalActions.has(action)) return { kind, action };
  if (kind === 'node' && Number.isSafeInteger(revision) && revision > 0 && revision >= session.tree - 1 && revision <= session.tree &&
    Number.isSafeInteger(node) && node >= 0 && nodeActions.has(action)) {
    if (action !== 'text') return { kind, revision, node, action };
    if (typeof text === 'string' && text.length <= 2000) return { kind, revision, node, action, text };
  }
  if (kind === 'gesture' && revision > 0 && revision === session.screen && [x, y, endX, endY].every(validPoint) &&
    Number.isInteger(duration) && duration >= 1 && duration <= 1500) {
    const content = { kind, revision, x, y, endX, endY, duration };
    if (agent && message.window !== undefined) {
      if (!session.observation || message.window !== session.observation.window || message.app !== session.observation.app) return null;
      Object.assign(content, { window: message.window, app: message.app });
    }
    return content;
  }
  return null;
}

function settleAction(session, result) {
  const action = session.action;
  if (!action) return;
  session.action = null;
  clearTimeout(action.timer);
  action.reply(result);
}

function startAction(session, content, reply) {
  if (!session.active || !content || session.action) {
    reply({ ok: false, reason: !session.active ? 'ended' : content ? 'busy' : 'stale' });
    return;
  }
  const id = ++session.nextAction;
  const timer = setTimeout(() => settleAction(session, { ok: false, reason: 'timeout' }), 6000);
  timer.unref();
  session.action = { id, kind: content.kind, timer, reply };
  send(session.host.socket, { type: 'action', id, ...content });
}

function controllerMessage(session, message) {
  if (message.type === 'stop') { end(session, 'stopped'); return true; }
  if (!session.active || message.type !== 'action' || !Number.isSafeInteger(message.id) || message.id <= 0) return false;
  const reply = result => send(session.viewer.socket, { type: 'ack', id: message.id, ...result });
  if (session.agentBusy) reply({ ok: false, reason: 'busy' });
  else startAction(session, actionContent(message, session), reply);
  return true;
}

function readObservation(detail, nodes, app, revision) {
  if (!detail || !Array.isArray(detail.elements) || detail.elements.length > 600 || !Array.isArray(detail.windows) || detail.windows.length > 16) return null;
  const controls = new Map(nodes.map(node => [node.id, node]));
  const elements = detail.elements.map((value, index) => {
    const element = { parent: Number.isSafeInteger(value?.parent) && value.parent >= 0 && value.parent < index ? value.parent : -1 };
    for (const key of ['role', 'text', 'description', 'resource', 'hint']) if (typeof value?.[key] === 'string') element[key] = value[key].slice(0, 160);
    for (const key of ['checked', 'selected', 'enabled', 'focused', 'scrollable', 'heading']) if (typeof value?.[key] === 'boolean') element[key] = value[key];
    if (Array.isArray(value?.bounds) && value.bounds.length === 4 && value.bounds.every(Number.isSafeInteger)) element.bounds = value.bounds;
    Object.assign(element, controls.get(value?.id));
    return element;
  });
  return { app, revision, window: Number.isSafeInteger(detail.window) ? detail.window : -1, windows: detail.windows,
    truncated: detail.truncated === true, elements };
}

function phoneMessage(session, message) {
  if (['accept', 'reject'].includes(message.type)) return phoneDecision(session, message);
  if (message.type === 'stop') { end(session, 'stopped'); return true; }
  if (!session.active) return false;
  if (message.type === 'screen' && Number.isSafeInteger(message.revision) && message.revision > session.screen &&
    [message.width, message.height].every(n => Number.isInteger(n) && n > 0 && n <= 10000)) {
    session.screen = message.revision;
    session.geometry = { revision: message.revision, width: message.width, height: message.height };
    session.frame = null;
    send(session.viewer.socket, { type: 'screen', ...session.geometry });
    session.events?.emit('change');
    startFrames(session);
    return true;
  }
  if (message.type === 'tree' && Number.isSafeInteger(message.revision) && message.revision > session.tree &&
    typeof message.app === 'string' && Array.isArray(message.nodes) && message.nodes.length <= 160) {
    session.tree = message.revision;
    const nodes = message.nodes.filter(node => node && Number.isSafeInteger(node.id) && Array.isArray(node.actions))
      .map(node => ({ id: node.id, label: typeof node.label === 'string' ? node.label.slice(0, 160) : '',
        actions: [...nodeActions].filter(action => node.actions.includes(action)) }));
    const app = message.app.slice(0, 160);
    if (session.agentAccess) {
      session.observation = readObservation(message.observation, nodes, app, message.revision);
      session.events.emit('change');
    }
    send(session.viewer.socket, { type: 'tree', revision: message.revision, app, nodes });
    return true;
  }
  if (message.type === 'ack' && Number.isSafeInteger(message.id)) {
    if (session.action?.id !== message.id) return true;
    const apps = session.action.kind === 'apps' && Array.isArray(message.apps) ? message.apps.slice(0, 220)
      .filter(item => typeof item?.app === 'string' && typeof item.name === 'string')
      .map(item => ({ app: item.app.slice(0, 160), name: item.name.slice(0, 160) })) : undefined;
    settleAction(session, { ok: message.ok === true, apps, reason: ['stale', 'unsupported', 'locked'].includes(message.reason) ? message.reason : 'unsupported' });
    return true;
  }
  return false;
}

function acceptSocket(client, item, hello) {
  const { role, device, session, phone, agent } = item, { socket } = client;
  client.role = role;
  client.device = device;
  client.authorization = bindDeviceConnection(device.id, () => {
    if (client.session) end(client.session, 'authorizationExpired');
    socket.close(4003, 'authorization expired');
  });
  if (!client.authorization.valid) return false;
  if (role === 'host') {
    if (phones.has(device.id)) return false;
    client.agentVersion = hello.agentVersion;
    phones.set(device.id, client);
    send(socket, { type: 'online' });
    return true;
  }
  if (role === 'controller') return connectViewer(client, phone, agent);
  if (!session.active || session.host.session !== session || session[role]) return false;
  client.session = session;
  session[role] = socket;
  startFrames(session);
  return true;
}

export function phoneWss() {
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
    socket.on('error', () => socket.terminate());
    socket.on('message', (bytes, binary) => {
      const { role, session } = client;
      if (role && !client.authorization?.valid) { socket.close(4003, 'authorization expired'); return; }
      if (binary) {
        if (role !== 'upload' || !session?.active || session.host.session !== session || bytes.length < 8 ||
          bytes[4] !== 255 || bytes[5] !== 216) { socket.close(4002, 'invalid frame'); return; }
        if (bytes.readUInt32BE(0) === session.screen) {
          if (session.agentAccess) {
            const first = !session.frame;
            session.frame = bytes.subarray(4);
            if (first) session.events.emit('change');
          }
          if (session.download?.readyState === 1 && session.download.bufferedAmount < maxFrame) session.download.send(bytes, { binary: true });
        }
        return;
      }
      try {
        if (bytes.length > (role === 'host' && session?.agentAccess ? 160 * 1024 : 65536)) throw new Error('message too large');
        const message = JSON.parse(bytes);
        if (!role && message.type === 'hello') {
          const item = tickets.get(message.ticket);
          if (item) {
            tickets.delete(message.ticket);
            clearTimeout(item.timer);
            clearTimeout(authTimer);
            if (acceptSocket(client, item, message)) return;
          }
        } else if (!session && role === 'host' && message.type === 'stop') { socket.close(); return; }
        else if (!session && role === 'host' && message.type === 'reject') return;
        else if (session && role === 'host' && phoneMessage(session, message)) return;
        else if (session && role === 'controller' && controllerMessage(session, message)) return;
      } catch {}
      socket.close(4002, 'invalid phone message');
    });
    socket.on('close', () => {
      clearTimeout(authTimer);
      client.authorization?.release();
      if (client.role === 'host' && phones.get(client.device.id) === client) phones.delete(client.device.id);
      if (client.session) end(client.session, 'disconnected');
    });
  });
  return wss;
}
