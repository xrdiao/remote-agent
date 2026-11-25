import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { bindDeviceConnection, computerId } from '../../lib/auth.mjs';
import { createPhoneConversation } from './conversation.mjs';
import { PhoneActionScheduler } from './actions.mjs';
import { PhoneTransport, sendPhone } from './transport.mjs';

const participants = session => [...new Set([session.owner.id, session.host.device.id])];
const authorized = (session, deviceId) => session && participants(session).includes(deviceId);

export class PhoneSessionRegistry {
  #hosts = new Map();
  #tickets = new Map();
  #sessions = new Map();

  constructor({ createConversation = createPhoneConversation } = {}) {
    this.createConversation = createConversation;
  }

  #issue(item) {
    const token = randomBytes(24).toString('base64url');
    const timer = setTimeout(() => this.#tickets.delete(token), 20000);
    timer.unref();
    this.#tickets.set(token, { ...item, timer, expires: Date.now() + 20000 });
    return token;
  }

  #consume(token) {
    const item = this.#tickets.get(token);
    if (!item) return;
    this.#tickets.delete(token);
    clearTimeout(item.timer);
    if (Date.now() < item.expires) return item;
  }

  targets(deviceId) {
    return {
      phones: [...this.#hosts.values()].filter(host => host.online && host.device.id !== deviceId && !host.session)
        .map(host => ({ ...host.device, conversation: host.agentVersion === 3 })),
      conversations: [...this.#sessions.values()].filter(session => session.chat && authorized(session, deviceId))
        .map(session => ({ ...this.#target(session), canReshare: session.host.device.id === deviceId })),
    };
  }

  #target(session) {
    const { win, windowId, threadId } = session.chat;
    return { id: session.id, name: session.host.device.name, computer: computerId(), win, windowId, threadId, state: session.transport.state };
  }

  stop(deviceId, id) {
    const session = this.#sessions.get(id);
    if (!authorized(session, deviceId)) return false;
    this.#end(session, 'stopped');
    return true;
  }

  ticket({ id: deviceId, name }, { role, phone, session: id } = {}) {
    const device = { id: deviceId, name };
    const session = this.#sessions.get(id);
    if (role === 'resume' && session?.active && session.host.device.id === deviceId)
      return this.#issue({ role: 'host', device, session, host: session.host });
    if (role === 'host' && !this.#hosts.has(deviceId)) return this.#issue({ role, device });
    const host = this.#hosts.get(phone);
    if (role === 'controller' && deviceId !== phone && host?.online && host.agentVersion === 3 && !host.session)
      return this.#issue({ role, device, host });
    if (role === 'viewer' && authorized(session, deviceId) && session.chat && !session.viewer)
      return this.#issue({ role, device, session });
    return null;
  }

  connect(client, hello) {
    const item = this.#consume(hello.ticket);
    if (!item) return false;
    const { role, device, session } = item;
    Object.assign(client, { role, device });
    client.authorization = bindDeviceConnection(device.id, () => {
      this.disconnect(client);
      client.socket.close(4003, 'authorization expired');
    });
    if (!client.authorization.valid) return false;
    if (role === 'host') return this.#attachHost(client, item, hello);
    if (role === 'controller') return this.#request(item.host, client);
    if (!session.active || session.ended) return false;
    if (role === 'viewer') {
      if (!authorized(session, device.id) || session.viewer) return false;
      Object.assign(client, { session, replies: new Map(), lastAction: 0, access: new AbortController() });
      session.viewer = client;
      sendPhone(client, { type: 'started', ticket: this.#issue({ role: 'download', device, session, viewer: client }),
        state: session.transport.state, canReshare: session.host.device.id === device.id });
      if (session.transport.geometry) sendPhone(client, { type: 'screen', ...session.transport.geometry });
      if (session.transport.layout) sendPhone(client, session.transport.layout);
      if (session.actions.batch) sendPhone(client, { type: 'agentBusy', busy: true });
      if (session.actions.observationRequired) sendPhone(client, { type: 'observationRequired', required: true });
      return true;
    }
    if (role === 'upload') {
      if (session.transport.upload || session.host !== item.host || session.transport.epoch !== item.epoch ||
          session.permissionRequired || !session.host.online) return false;
      client.session = session;
      session.transport.attachUpload(client);
      if (session.transport.state === 'ready') this.#finishRecovery(session);
      return true;
    }
    if (session.download || session.viewer !== item.viewer) return false;
    client.session = session;
    session.download = client;
    session.transport.sendFrame(client);
    return true;
  }

  #attachHost(client, { session, host }, hello) {
    const id = client.device.id;
    client.agentVersion = hello.agentVersion;
    if (!session) {
      if (this.#hosts.has(id)) return false;
      client.online = true;
      this.#hosts.set(id, client);
      sendPhone(client, { type: 'online' });
      return true;
    }
    if (client.agentVersion !== 3 || !session.active || session.ended || session.host !== host || this.#hosts.get(id) !== host) return false;
    // Fence the previous connection before its asynchronous close and any in-flight ACK.
    host.online = false;
    host.session = null;
    host.authorization.release();
    this.#startRecoveryWindow(session);
    session.transport.reset('手机控制连接已接管，请重新观察手机。');
    host.socket.close(1012, 'replaced');
    session.host = client;
    client.session = session;
    client.online = true;
    this.#hosts.set(id, client);
    if (hello.capture === true && !session.permissionRequired) this.#startCapture(session);
    else {
      session.permissionRequired = true;
      session.transport.publish();
      this.#sendRequest(session, true);
    }
    return true;
  }

  #sendRequest(session, resume) {
    sendPhone(session.host, { type: 'request', id: session.id, name: `${session.owner.name} · 手机会话`,
      ...(resume ? { resume: true } : {}) });
  }

  #request(host, requester) {
    if (!host.online || host.socket.readyState !== 1 || host.agentVersion !== 3 || host.session ||
        this.#hosts.get(host.device.id) !== host || host.device.id === requester?.device.id) return false;
    const session = { id: randomUUID(), host, owner: requester?.device || host.device, requester, active: false,
      access: new AbortController(), events: new EventEmitter() };
    session.transport = new PhoneTransport(session);
    session.actions = new PhoneActionScheduler(session);
    session.authorization = participants(session).map(id => bindDeviceConnection(id, () => this.#end(session, 'authorizationExpired')));
    if (session.authorization.some(lease => !lease.valid)) {
      for (const lease of session.authorization) lease.release();
      return false;
    }
    this.#sessions.set(session.id, session);
    host.session = session;
    session.approvalTimer = setTimeout(() => this.#end(session, 'approvalExpired'), 90000);
    session.approvalTimer.unref();
    if (requester) {
      requester.session = session;
      sendPhone(requester, { type: 'waiting' });
    }
    this.#sendRequest(session, false);
    return true;
  }

  #startRecoveryWindow(session) {
    if (session.reconnectTimer) return;
    session.reconnectTimer = setTimeout(() => this.#end(session, 'reconnectExpired'), 5 * 60 * 1000);
    session.reconnectTimer.unref();
  }

  #finishRecovery(session) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }

  #startCapture(session) {
    this.#startRecoveryWindow(session);
    session.transport.publish();
    const { host, transport } = session;
    sendPhone(host, { type: 'started',
      ticket: this.#issue({ role: 'upload', device: host.device, session, host, epoch: transport.epoch }), agent: true });
  }

  #decision(session, message) {
    if ((session.active && !session.permissionRequired) || message.id !== session.id) return false;
    if (message.type === 'reject') { this.#end(session, 'rejected'); return true; }
    clearTimeout(session.approvalTimer);
    session.active = true;
    session.permissionRequired = false;
    this.#startCapture(session);
    if (session.chat) sendPhone(session.host, { type: 'conversation', target: this.#target(session) });
    else if (!session.creatingChat) {
      session.creatingChat = true;
      sendPhone(session.requester, { type: 'started' });
      void this.#startConversation(session);
    }
    return true;
  }

  async #startConversation(session) {
    const { transport, actions, access, events } = session;
    try {
      const chat = await this.createConversation({ id: session.id, devices: participants(session), title: session.host.device.name }, {
        signal: access.signal,
        onLost: () => this.#end(session, 'conversationFailed'),
        begin: callerSignal => {
          if (transport.state === 'permission') throw Error('请在被控手机上重新授权屏幕共享，授权后可继续当前会话。');
          if (transport.state !== 'ready') throw Error('手机连接不可用，请在连接恢复后重新观察手机。');
          return AbortSignal.any([callerSignal, access.signal, transport.epoch.signal]);
        },
        events,
        state: () => transport.state === 'ready' && transport.observation && { ...transport.observation, screen: transport.geometry },
        image: () => transport.state === 'ready' && transport.frame && { frame: transport.frame.subarray(4), screen: transport.geometry },
        needsObservation: () => actions.observationRequired,
        exclusive: (signal, run) => actions.exclusive(signal, run),
      });
      if (session.ended) { chat.close(); return; }
      session.chat = chat;
      const message = { type: 'conversation', target: this.#target(session) };
      sendPhone(session.host, message);
      sendPhone(session.requester, message);
    } catch (error) {
      if (session.ended) return;
      const message = { type: 'conversationError', message: error.message };
      sendPhone(session.host, message);
      sendPhone(session.requester, message);
      this.#end(session, 'conversationFailed');
    }
  }

  message(client, message) {
    const { role, session } = client;
    if (role === 'host') {
      if (!client.online || this.#hosts.get(client.device.id) !== client) return false;
      if (message.type === 'self') { if (!session) this.#request(client, null); return true; }
      if (!session) {
        if (message.type === 'stop') { client.socket.close(); return true; }
        return message.type === 'reject';
      }
      if (message.type === 'accept' || message.type === 'reject') return this.#decision(session, message);
      if (message.type === 'stop') { this.#end(session, 'stopped'); return true; }
      if (!session.active) return false;
      if (message.type === 'projectionPaused' && ['system', 'locked', 'accessibility', 'display'].includes(message.reason)) {
        session.permissionRequired = true;
        this.#finishRecovery(session);
        session.transport.reset('手机屏幕共享已暂停，重新授权后请观察手机。');
        return true;
      }
      if (session.permissionRequired) return ['screen', 'tree', 'ack'].includes(message.type);
      if (message.type === 'ack' && Number.isSafeInteger(message.id)) {
        session.actions.acknowledge(client, message);
        return true;
      }
      const valid = message.type === 'screen' ? session.transport.screen(message)
        : message.type === 'tree' && session.transport.tree(message);
      if (valid && session.transport.state === 'ready') this.#finishRecovery(session);
      return valid;
    }
    if (!session || session.ended || (client !== session.viewer && client !== session.requester)) return false;
    if (message.type === 'stop') { this.#end(session, 'stopped'); return true; }
    if (client !== session.viewer || !session.active || message.type !== 'action' || !Number.isSafeInteger(message.id) || message.id <= 0) return false;
    session.actions.manual(client, message);
    return true;
  }

  frame(client, bytes) {
    return client.role === 'upload' && client.session?.transport.receiveFrame(client, bytes);
  }

  disconnect(client) {
    client.authorization?.release();
    const { role, session } = client;
    if (role === 'host') {
      if (!client.online || this.#hosts.get(client.device.id) !== client) return;
      client.online = false;
      if (!session) { this.#hosts.delete(client.device.id); return; }
    } else client.session = null;
    if (!session || session.ended) return;
    if (role === 'host' && session.host === client || role === 'upload' && session.transport.upload === client) {
      if (!session.active) { this.#end(session, 'disconnected'); return; }
      const host = session.host;
      host.online = false;
      host.authorization.release();
      this.#startRecoveryWindow(session);
      session.transport.reset('手机连接已断开，请在恢复后重新观察手机。');
      host.socket.close(1012, 'reconnect');
    } else if (role === 'controller' && session.requester === client) {
      if (!session.active) this.#end(session, 'disconnected');
      else session.requester = null;
    } else if (role === 'viewer' && session.viewer === client) {
      session.viewer = null;
      client.access.abort(new Error('Phone viewer disconnected'));
      const download = session.download;
      session.download = null;
      this.#closeClient(download);
    } else if (role === 'download' && session.download === client) session.download = null;
  }

  #closeClient(client, code = 1000, reason) {
    if (!client) return;
    client.session = null;
    client.authorization?.release();
    client.socket.close(code, reason);
  }

  #end(session, reason) {
    if (this.#sessions.get(session.id) !== session) return;
    this.#sessions.delete(session.id);
    session.ended = true;
    const { host, requester, viewer, download, authorization } = session;
    host.session = session.requester = session.viewer = session.download = null;
    if (!host.online && this.#hosts.get(host.device.id) === host) this.#hosts.delete(host.device.id);
    clearTimeout(session.approvalTimer);
    this.#finishRecovery(session);
    for (const [token, item] of this.#tickets) if (item.session === session) this.#consume(token);
    for (const lease of authorization) lease.release();
    viewer?.access.abort(new Error(`Phone session ended: ${reason}`));
    session.access.abort(new Error(`Phone session ended: ${reason}`));
    session.transport.reset(`Phone session ended: ${reason}`, 4004);
    session.chat?.close();
    const ended = { type: 'ended', reason };
    sendPhone(host, ended);
    for (const client of [requester, viewer]) {
      sendPhone(client, ended);
      this.#closeClient(client);
    }
    this.#closeClient(download, 4004, 'session ended');
  }
}
