export const maxFrame = 512 * 1024;
export const nodeActions = new Set(['click', 'longClick', 'scrollForward', 'scrollBackward', 'text']);

export function sendPhone(client, message) {
  if (client?.socket.readyState !== 1) return false;
  client.socket.send(JSON.stringify(message));
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
  const windows = detail.windows.filter(value => Number.isSafeInteger(value?.id)).map(value => ({
    id: value.id, type: Number.isSafeInteger(value.type) ? value.type : 0,
    active: value.active === true, focused: value.focused === true,
    ...(typeof value.title === 'string' ? { title: value.title.slice(0, 160) } : {}),
    ...(Array.isArray(value.bounds) && value.bounds.length === 4 && value.bounds.every(Number.isSafeInteger) ? { bounds: value.bounds } : {}),
  }));
  return { app, revision, window: Number.isSafeInteger(detail.window) ? detail.window : -1, windows,
    truncated: detail.truncated === true, elements };
}

export class PhoneTransport {
  constructor(session) {
    this.session = session;
    this.resetSnapshots();
    this.epoch = new AbortController();
    this.screenRevision = 0;
    this.treeRevision = 0;
    this.phase = 'reconnecting';
  }

  get state() {
    const { session } = this;
    if (session.ended) return 'ended';
    if (session.permissionRequired) return 'permission';
    return session.active && session.host.online && session.host.socket.readyState === 1 &&
      this.upload?.socket.readyState === 1 && this.geometry && this.layout ? 'ready' : 'reconnecting';
  }

  publish() {
    const state = this.state;
    if (state === this.phase) return;
    this.phase = state;
    sendPhone(this.session.viewer, { type: 'state', state });
    this.session.events.emit('change');
  }

  resetSnapshots() {
    this.framesReady = false;
    this.nativeScreen = this.nativeTree = 0;
    this.geometry = this.layout = this.previousTree = this.observation = this.frame = null;
  }

  reset(reason, code) {
    const upload = this.upload;
    this.upload = null;
    this.resetSnapshots();
    if (!this.session.ended && this.phase === 'ready') this.session.actions.requireObservation(true);
    this.session.actions.invalidate();
    const old = this.epoch;
    this.epoch = new AbortController();
    old.abort(new Error(reason));
    if (upload) {
      upload.session = null;
      upload.authorization.release();
      upload.socket.close(code);
    }
    this.publish();
  }

  attachUpload(client) {
    this.upload = client;
    this.startFrames();
    this.publish();
  }

  startFrames() {
    if (!this.geometry || !this.upload || this.framesReady) return;
    this.framesReady = sendPhone(this.session.host, { type: 'framesReady' });
  }

  screen(message) {
    const revision = message.revision;
    if (!Number.isInteger(revision) || revision <= this.nativeScreen || revision > 0xffffffff ||
      ![message.width, message.height].every(n => Number.isInteger(n) && n > 0 && n <= 10000)) return false;
    this.nativeScreen = revision;
    this.geometry = { revision: ++this.screenRevision, width: message.width, height: message.height };
    this.frame = null;
    sendPhone(this.session.viewer, { type: 'screen', ...this.geometry });
    this.startFrames();
    this.publish();
    this.session.events.emit('change');
    return true;
  }

  tree(message) {
    const native = message.revision;
    if (!Number.isSafeInteger(native) || native <= this.nativeTree ||
      typeof message.app !== 'string' || !Array.isArray(message.nodes) || message.nodes.length > 160) return false;
    const revision = ++this.treeRevision;
    this.previousTree = this.layout && { revision: this.layout.revision, native: this.nativeTree };
    this.nativeTree = native;
    const nodes = message.nodes.filter(node => node && Number.isSafeInteger(node.id) && Array.isArray(node.actions))
      .map(node => ({ id: node.id, label: typeof node.label === 'string' ? node.label.slice(0, 160) : '',
        actions: [...nodeActions].filter(action => node.actions.includes(action)) }));
    const app = message.app.slice(0, 160);
    this.observation = readObservation(message.observation, nodes, app, revision);
    this.layout = { type: 'tree', revision, app, nodes };
    sendPhone(this.session.viewer, this.layout);
    this.publish();
    this.session.events.emit('change');
    return true;
  }

  treeNativeRevision(revision) {
    if (this.layout?.revision === revision) return this.nativeTree;
    if (this.previousTree?.revision === revision && this.previousTree.native === this.nativeTree - 1) return this.previousTree.native;
    return null;
  }

  receiveFrame(client, bytes) {
    if (this.upload !== client || !this.session.active || !this.session.host.online || this.session.permissionRequired ||
      bytes.length < 8 || bytes[4] !== 255 || bytes[5] !== 216) return false;
    if (!this.geometry || bytes.readUInt32BE(0) !== this.nativeScreen) return true;
    const first = !this.frame;
    this.frame = Buffer.from(bytes);
    this.frame.writeUInt32BE(this.geometry.revision, 0);
    this.sendFrame(this.session.download);
    if (first) this.session.events.emit('change');
    return true;
  }

  sendFrame(client) {
    const socket = client?.socket;
    if (this.frame && socket?.readyState === 1 && socket.bufferedAmount < maxFrame)
      socket.send(this.frame, { binary: true });
  }
}
