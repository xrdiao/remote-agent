import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { bindDeviceConnection, computerId } from '../../lib/auth.mjs';
import { createPhoneConversation } from './conversation.mjs';

const phones = new Map(), tickets = new Map(), sessions = new Map();
const ticketLifetime = 20000;
const reconnectLifetime = 5 * 60 * 1000;
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

const participants = session => [...new Set([session.owner.id, session.host.device.id])];
const authorized = (session, deviceId) => session && participants(session).includes(deviceId);
const transportReady = session => session.host.socket.readyState === 1 && session.upload?.readyState === 1;
const phonePhase = session => session.permissionRequired ? 'permission'
  : transportReady(session) && session.geometry && session.layout ? 'ready' : 'reconnecting';
const conversationTarget = session => ({ id: session.id, name: session.host.device.name, computer: computerId(),
  win: session.chat.win, windowId: session.chat.windowId, threadId: session.chat.threadId, state: phonePhase(session) });

function publishPhase(session) {
  const state = phonePhase(session);
  if (session.phase === state) return;
  session.phase = state;
  send(session.viewer?.socket, { type: 'state', state });
  session.events.emit('change');
}

export function phoneTargets(deviceId) {
  return {
    phones: [...phones.values()].filter(phone => phone.device.id !== deviceId && !phone.session)
      .map(({ device, agentVersion }) => ({ id: device.id, name: device.name, conversation: agentVersion === 3 })),
    conversations: [...sessions.values()].filter(session => session.chat && authorized(session, deviceId))
      .map(session => ({ ...conversationTarget(session), canReshare: session.host.device.id === deviceId })),
  };
}

export function stopPhoneControl(deviceId, id) {
  const session = sessions.get(id);
  if (!authorized(session, deviceId)) return false;
  end(session, 'stopped');
  return true;
}

export function phoneTicket(device, { role, phone, session: id } = {}) {
  const session = sessions.get(id);
  if (role === 'resume' && session?.active && session.host.device.id === device.id)
    return ticket({ role: 'host', device, session });
  if (role === 'host' && !phones.has(device.id)) return ticket({ role, device });
  const host = phones.get(phone);
  if (role === 'controller' && device.id !== phone && host?.agentVersion === 3 && !host.session)
    return ticket({ role, device, phone });
  if (role === 'viewer' && authorized(session, device.id) && session.chat && !session.viewer)
    return ticket({ role, device, session });
  return null;
}

function end(session, reason) {
  const { host, requester, viewer } = session;
  if (host.session !== session) return;
  session.active = false;
  host.session = null;
  sessions.delete(session.id);
  if (requester) requester.session = null;
  if (viewer) viewer.session = null;
  clearTimeout(session.approvalTimer);
  clearTimeout(session.reconnectTimer);
  settleAction(session, { ok: false, reason });
  session.agentAccess.abort(new Error(`Phone session ended: ${reason}`));
  for (const authorization of session.authorization) authorization.release();
  session.chat?.close();
  session.frame = null;
  send(host.socket, { type: 'ended', reason });
  for (const client of [requester, viewer]) if (client) {
    send(client.socket, { type: 'ended', reason });
    client.socket.close();
  }
  session.upload?.close(4004, 'session ended');
  session.download?.close(4004, 'session ended');
}

function clearTransport(session) {
  const upload = session.upload;
  session.upload = null;
  session.framesReady = false;
  session.geometry = session.layout = session.frame = session.observation = null;
  settleAction(session, { ok: false, reason: 'outcomeUnknown' });
  upload?.close();
  publishPhase(session);
}

function reconnect(session, channel, code) {
  if (session.reconnectTimer) return;
  console.warn(`[phone] Reconnecting after ${channel} closed (${code})`);
  const host = session.host;
  if (phones.get(host.device.id) === host) phones.delete(host.device.id);
  host.socket.close(1012, 'reconnect');
  clearTransport(session);
  session.reconnectTimer = setTimeout(() => end(session, 'reconnectExpired'), reconnectLifetime);
  session.reconnectTimer.unref();
}

function suspendProjection(session, reason) {
  session.permissionRequired = true;
  console.info(`[phone] Capture paused (${reason})`);
  clearTransport(session);
}

function requestPhone(host, requester) {
  if (!host || host.agentVersion !== 3 || host.session || host.device.id === requester?.device.id) return false;
  const owner = requester?.device || host.device;
  const session = { id: crypto.randomUUID(), host, owner, requester, active: false, screen: 0, tree: 0, nextAction: 0,
    agentAccess: new AbortController(), events: new EventEmitter() };
  session.authorization = participants(session).map(id => bindDeviceConnection(id, () => end(session, 'authorizationExpired')));
  if (session.authorization.some(authorization => !authorization.valid)) {
    for (const authorization of session.authorization) authorization.release();
    return false;
  }
  session.approvalTimer = setTimeout(() => end(session, 'approvalExpired'), 90000);
  session.approvalTimer.unref();
  sessions.set(session.id, session);
  host.session = session;
  if (requester) {
    requester.session = session;
    send(requester.socket, { type: 'waiting' });
  }
  send(host.socket, { type: 'request', id: session.id, name: `${owner.name} · 手机会话` });
  return true;
}

function phoneDecision(session, message) {
  if (session.active && !session.permissionRequired || message.id !== session.id) return false;
  if (message.type === 'reject') { end(session, 'rejected'); return true; }
  clearTimeout(session.approvalTimer);
  session.active = true;
  session.permissionRequired = false;
  startCapture(session);
  if (session.chat) send(session.host.socket, { type: 'conversation', target: conversationTarget(session) });
  else if (!session.creatingChat) {
    session.creatingChat = true;
    send(session.requester?.socket, { type: 'started' });
    startConversation(session);
  }
  return true;
}

function startCapture(session) {
  const { host } = session;
  const capture = session.capture = (session.capture || 0) + 1;
  publishPhase(session);
  send(host.socket, { type: 'started', ticket: ticket({ role: 'upload', device: host.device, session, host, capture }), agent: true });
}

async function startConversation(session) {
  try {
    const chat = await createPhoneConversation({ id: session.id, devices: participants(session), title: session.host.device.name }, {
      signal: session.agentAccess.signal, events: session.events,
      requireReady: () => {
        const state = phonePhase(session);
        if (state === 'permission') throw new Error('请在被控手机上重新授权屏幕共享，授权后可继续当前会话。');
        if (state !== 'ready') throw new Error('手机正在重连，请在连接恢复后继续。');
      },
      state: () => phonePhase(session) === 'ready' && session.observation && { ...session.observation, screen: session.geometry },
      image: () => phonePhase(session) === 'ready' && session.frame && { frame: session.frame.subarray(4), screen: session.geometry },
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
        send(session.viewer?.socket, { type: 'agentBusy', busy: true });
        try { return await run(); }
        finally {
          session.agentBusy = false;
          if (session.active) send(session.viewer?.socket, { type: 'agentBusy', busy: false });
        }
      },
    });
    if (!session.active) { chat.close(); return; }
    session.chat = chat;
    const message = { type: 'conversation', target: conversationTarget(session) };
    send(session.host.socket, message);
    send(session.requester?.socket, message);
  } catch (error) {
    if (!session.active) return;
    const message = { type: 'conversationError', message: error.message };
    send(session.host.socket, message);
    send(session.requester?.socket, message);
    end(session, 'conversationFailed');
  }
}

function startFrames(session) {
  if (!session.screen || !session.upload || session.framesReady) return;
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
  const state = phonePhase(session);
  if (!session.active || state !== 'ready' || !content || session.action) {
    reply({ ok: false, reason: !session.active ? 'ended' : state !== 'ready' ? state : content ? 'busy' : 'stale' });
    return;
  }
  const id = ++session.nextAction;
  const timer = setTimeout(() => settleAction(session, { ok: false, reason: 'outcomeUnknown' }), 6000);
  timer.unref();
  session.action = { id, kind: content.kind, timer, reply };
  send(session.host.socket, { type: 'action', id, ...content });
}

function controllerMessage(session, client, message) {
  if (message.type === 'stop') { end(session, 'stopped'); return true; }
  if (client !== session.viewer || !session.active || message.type !== 'action' || !Number.isSafeInteger(message.id) || message.id <= 0) return false;
  const reply = result => send(client.socket, { type: 'ack', id: message.id, ...result });
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
  if (message.type === 'projectionPaused' && ['system', 'locked', 'accessibility', 'display'].includes(message.reason)) {
    suspendProjection(session, message.reason);
    return true;
  }
  if (session.permissionRequired) return ['screen', 'tree', 'ack'].includes(message.type);
  if (message.type === 'screen' && Number.isSafeInteger(message.revision) && message.revision > session.screen &&
    [message.width, message.height].every(n => Number.isInteger(n) && n > 0 && n <= 10000)) {
    session.screen = message.revision;
    session.geometry = { revision: message.revision, width: message.width, height: message.height };
    session.frame = null;
    send(session.viewer?.socket, { type: 'screen', ...session.geometry });
    session.events.emit('change');
    startFrames(session);
    publishPhase(session);
    return true;
  }
  if (message.type === 'tree' && Number.isSafeInteger(message.revision) && message.revision > session.tree &&
    typeof message.app === 'string' && Array.isArray(message.nodes) && message.nodes.length <= 160) {
    session.tree = message.revision;
    const nodes = message.nodes.filter(node => node && Number.isSafeInteger(node.id) && Array.isArray(node.actions))
      .map(node => ({ id: node.id, label: typeof node.label === 'string' ? node.label.slice(0, 160) : '',
        actions: [...nodeActions].filter(action => node.actions.includes(action)) }));
    const app = message.app.slice(0, 160);
    session.observation = readObservation(message.observation, nodes, app, message.revision);
    session.layout = { type: 'tree', revision: message.revision, app, nodes };
    session.events.emit('change');
    send(session.viewer?.socket, session.layout);
    publishPhase(session);
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
  const { role, device, session, phone, viewer } = item, { socket } = client;
  client.role = role;
  client.device = device;
  client.authorization = bindDeviceConnection(device.id, () => {
    if (client.session && role === 'host') end(client.session, 'authorizationExpired');
    socket.close(4003, 'authorization expired');
  });
  if (!client.authorization.valid) return false;
  if (role === 'host') {
    const current = phones.get(device.id);
    client.agentVersion = hello.agentVersion;
    if (session) {
      if (client.agentVersion !== 3 || !session.active || sessions.get(session.id) !== session ||
          session.host.device.id !== device.id || current && current.session !== session) return false;
      session.host.session = null;
      session.host.socket.close(1012, 'replaced');
      clearTransport(session);
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
      session.host = client;
      client.session = session;
      phones.set(device.id, client);
      // Each host connection supplies fresh snapshots. An app process that was relaunched also has fresh counters.
      session.screen = session.tree = 0;
      if (hello.capture === true && !session.permissionRequired) startCapture(session);
      else {
        suspendProjection(session, 'approvalRequired');
        send(socket, { type: 'request', id: session.id, name: `${session.owner.name} · 手机会话`, resume: true });
      }
      return true;
    }
    if (current) return false;
    phones.set(device.id, client);
    send(socket, { type: 'online' });
    return true;
  }
  if (role === 'controller') return requestPhone(phones.get(phone), client);
  if (!session.active || session.host.session !== session) return false;
  if (role === 'viewer') {
    if (!authorized(session, device.id) || session.viewer) return false;
    client.session = session;
    session.viewer = client;
    send(socket, { type: 'started', ticket: ticket({ role: 'download', device, session, viewer: client }),
      state: phonePhase(session), canReshare: session.host.device.id === device.id });
    if (session.geometry) send(socket, { type: 'screen', ...session.geometry });
    if (session.layout) send(socket, session.layout);
    if (session.agentBusy) send(socket, { type: 'agentBusy', busy: true });
    return true;
  }
  if (session[role] || role === 'download' && session.viewer !== viewer ||
      role === 'upload' && (session.host !== item.host || session.capture !== item.capture || session.permissionRequired)) return false;
  client.session = session;
  session[role] = socket;
  if (role === 'download' && session.frame) socket.send(session.frame, { binary: true });
  startFrames(session);
  publishPhase(session);
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
        if (role !== 'upload' || !session?.active || session.upload !== socket || session.host.session !== session || bytes.length < 8 ||
          bytes[4] !== 255 || bytes[5] !== 216) { socket.close(4002, 'invalid frame'); return; }
        if (bytes.readUInt32BE(0) === session.screen) {
          const first = !session.frame;
          session.frame = bytes;
          if (first) session.events.emit('change');
          if (session.download?.readyState === 1 && session.download.bufferedAmount < maxFrame) session.download.send(bytes, { binary: true });
        }
        return;
      }
      try {
        if (bytes.length > (role === 'host' && session ? 160 * 1024 : 65536)) throw new Error('message too large');
        const message = JSON.parse(bytes);
        if (!role && message.type === 'hello') {
          const item = tickets.get(message.ticket);
          if (item) {
            tickets.delete(message.ticket);
            clearTimeout(item.timer);
            clearTimeout(authTimer);
            if (acceptSocket(client, item, message)) return;
          }
        } else if (role === 'host' && message.type === 'self') {
          if (!session) requestPhone(client, null);
          return;
        }
        else if (!session && role === 'host' && message.type === 'stop') { socket.close(); return; }
        else if (!session && role === 'host' && message.type === 'reject') return;
        else if (session && role === 'host' && phoneMessage(session, message)) return;
        else if (session && ['controller', 'viewer'].includes(role) && controllerMessage(session, client, message)) return;
      } catch {}
      socket.close(4002, 'invalid phone message');
    });
    socket.on('close', code => {
      clearTimeout(authTimer);
      client.authorization?.release();
      if (client.role === 'host' && phones.get(client.device.id) === client) phones.delete(client.device.id);
      const { session, role } = client;
      if (!session) return;
      if (role === 'host' && session.host === client || role === 'upload' && session.upload === socket) {
        if (session.active) reconnect(session, role, code);
        else end(session, 'disconnected');
      } else if (role === 'controller' && !session.active) end(session, 'disconnected');
      else if (role === 'controller' && session.requester === client) session.requester = null;
      else if (role === 'viewer' && session.viewer === client) {
        session.viewer = null;
        session.download?.close();
        session.download = null;
      } else if (role === 'download' && session.download === socket) session.download = null;
    });
  });
  return wss;
}
