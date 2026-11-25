import { cdpRead } from '../cdp.mjs';
import { quotaErrorMessage } from '../agent/context.mjs';
import { beginOperation, withOperation } from '../operations.mjs';
import { configureNativeRetry } from '../native-windows.mjs';
import { ROUTES, resolveRoute, flag } from '../routes.mjs';
import { SendLifecycle } from './send-lifecycle.mjs';

const questions = new Set(['question', 'codexRequest', 'opencodeQuestion']);
const sameWindow = (session, msg) => !msg.sel || msg.sel.split('|', 2).join('|') === session.selectionKey().split('|', 2).join('|');
const pureNavigation = msg => msg.newSession !== true && msg.create !== true
  && !(msg.t === 'openAgent' && /^(?:new:|project-new:)/.test(msg.id || ''));
const switched = () => new Error('窗口已切换');
const disconnected = () => new Error('连接已断开，操作未执行');

export class CommandScheduler {
  #session;
  #authorized;
  #retired = false;
  #sends;
  #queue = Promise.resolve();
  #questions = Promise.resolve();
  #barrier = Promise.resolve();
  #generation = 0;
  #activeGeneration = 0;
  #reads = new AbortController();
  #navigationReads = new AbortController();
  #activeNavigation = null;
  #pendingNavigation = null;
  #metadataRevisions = new Map();
  #pendingMetadata = new Set();
  #imageActions = [];
  #imageGroup = 0;
  #tasks = new Set();

  constructor(session, authorized) {
    this.#session = session;
    this.#authorized = authorized;
    this.#sends = new SendLifecycle(session, ROUTES.send.fail);
  }

  accept(msg) {
    if (!this.#canRun()) return;
    const session = this.#session, route = resolveRoute(session, msg.t);
    const request = beginOperation(session, msg);
    if (request?.duplicate) return;
    if (request?.collision) {
      this.#fail(route, msg, new Error('操作编号已用于另一种操作，请使用新的编号'));
      return;
    }
    const operation = request?.operation;
    let batch;
    try { batch = route?.accept?.(session, msg); }
    catch (error) {
      this.#fail(route, msg, error);
      operation?.finish();
      return;
    }
    const send = this.#sends.receive(msg, operation);
    if (msg.t === 'mentionQuery') session.mentionSeq = msg.seq;
    if (msg.t === 'openMenu') session.menuRequest = msg.requestId;
    const image = msg.t === 'image' ? { cancelled: false } : null;
    if (image) (session.imageTransfers ||= new Map()).set(msg.clientImageId, image);
    const metadata = msg.t === 'agents' ? `agents|${!!msg.automatic}|${!!msg.silent}|${msg.projectWindow || ''}`
      : msg.t === 'windows' ? 'windows' : msg.t === 'usage' && msg.automatic === true ? 'usage' : '';
    const metadataKey = metadata && `${this.#generation}|${metadata}`;
    if (metadataKey && this.#pendingMetadata.has(metadataKey)) {
      operation?.finish();
      return;
    }
    if (metadataKey) this.#pendingMetadata.add(metadataKey);
    const task = { msg, route, operation, send, batch, image, metadata, metadataKey };
    if (route && flag(route.fast, session, msg)) return this.#run(task, () => this.#fast(task));

    task.switching = ROUTES[msg.t]?.navigation === true;
    if (task.switching) this.#scheduleNavigation(task);
    else if (!route?.switchRead && !route?.connection) this.#pendingNavigation = null;
    task.generation = this.#generation;
    if (metadata) {
      task.revision = (this.#metadataRevisions.get(metadata) || 0) + 1;
      this.#metadataRevisions.set(metadata, task.revision);
    }

    const imageAction = msg.t === 'removeAttachment' || msg.t === 'editImage';
    task.group = image || imageAction ? this.#imageGroup : ++this.#imageGroup;
    const execute = () => this.#run(task, () => send ? this.#sends.run(send, () => this.#execute(task)) : this.#execute(task));
    if (imageAction) this.#imageActions.push({ task, execute });
    if (flag(route?.background, session, msg)) this.#enqueue(this.#queue, execute, msg);
    else if (questions.has(msg.t)) this.#questions = this.#enqueue(Promise.all([this.#questions, this.#barrier]), execute, msg);
    else if (task.switching) this.#barrier = this.#queue = this.#enqueue(Promise.all([this.#queue, this.#questions]), execute, msg);
    else this.#queue = this.#enqueue(this.#queue, execute, msg);
  }

  retire() {
    this.#retired = true;
    this.#reads.abort(disconnected());
    if (this.#activeNavigation) this.abortNavigation();
    this.#sends.disconnected();
    if (this.#session.sessionBatch) this.#session.sessionBatch.cancelled = true;
  }

  abortNavigation() { this.#navigationReads.abort(disconnected()); }
  drain() { return Promise.allSettled([...this.#tasks]); }

  #canRun() { return !this.#retired && this.#authorized(); }

  #track(task) {
    this.#tasks.add(task);
    task.then(() => this.#tasks.delete(task), () => this.#tasks.delete(task));
    return task;
  }

  #enqueue(tail, execute, msg) {
    return this.#track(tail.then(execute).catch(error => {
      console.error(`[ws:${msg.t}] ${error.stack || error.message}`);
    }));
  }

  #run(task, action) {
    if (task.started) return;
    task.started = true;
    const session = this.#session, { operation } = task;
    const holdsExecution = operation || task.send;
    return this.#track(withOperation(operation, async () => {
      if (holdsExecution) session.activeOperations = (session.activeOperations || 0) + 1;
      try { return await action(); }
      finally {
        if (task.metadataKey) this.#pendingMetadata.delete(task.metadataKey);
        if (task.batch && session.sessionBatch === task.batch) session.sessionBatch = null;
        if (task.image && session.imageTransfers.get(task.msg.clientImageId) === task.image)
          session.imageTransfers.delete(task.msg.clientImageId);
        const index = this.#imageActions.findIndex(action => action.task === task);
        if (index !== -1) this.#imageActions.splice(index, 1);
        operation?.finish();
        if (holdsExecution && !--session.activeOperations && session.disposed) session.dispose();
      }
    }));
  }

  #fail(route, msg, error) {
    route?.fail?.(this.#session, msg, error);
    this.#session.emit({ t: 'status', ok: false, msg: error.message });
  }

  async #fast({ route, msg }) {
    const session = this.#session;
    if (route.switchRead && !sameWindow(session, msg)) return;
    const signal = route.switchRead ? this.#reads.signal : null;
    try { await cdpRead.run(signal, () => route.fastRun(session, msg)); }
    catch (error) {
      if (signal?.aborted) return;
      route.fail?.(session, msg, error);
      if (route.errorStatus !== false) session.emit({ t: 'status', ok: false, msg: error.message });
    }
  }

  #scheduleNavigation(task) {
    const session = this.#session;
    if (pureNavigation(task.msg)) {
      if (this.#pendingNavigation && !this.#pendingNavigation.started) this.#pendingNavigation.superseded = true;
      this.#pendingNavigation = task;
      if (this.#activeNavigation) this.#navigationReads.abort(switched());
      task.coalescible = true;
    } else this.#pendingNavigation = null;
    this.#sends.navigating();
    if (session.app !== 'fusion') configureNativeRetry(session.deviceId, null);
    session.chatRead?.controller.abort(switched());
    if (session.sessionBatch) session.sessionBatch.cancelled = true;
    this.#generation++;
    this.#resetReads();
  }

  #resetReads(reason = switched()) {
    this.#reads.abort(reason);
    this.#reads = new AbortController();
  }

  #unavailable({ operation, route, msg }) {
    if (!operation) return;
    const error = disconnected();
    route?.fail?.(this.#session, msg, error);
    if (msg.t !== 'send') this.#session.emit({ t: 'status', ok: false, msg: error.message });
  }

  async #execute(task) {
    const { msg, route, operation, switching, generation, metadata, revision, image, group, send } = task;
    const session = this.#session;
    if (!this.#canRun()) return this.#unavailable(task);
    if (task.superseded || metadata && generation !== this.#generation) return;
    const readOnly = route?.switchRead && !switching;
    if (!route?.connection && !switching &&
        (generation !== (readOnly ? this.#generation : this.#activeGeneration) || !sameWindow(session, msg))) {
      const error = new Error('会话已切换，操作未执行');
      route?.fail?.(session, msg, error);
      if (operation && !route?.fail) session.emit({ t: 'status', ok: false, msg: error.message });
      return;
    }
    if (msg.t === 'mentionQuery' && session.mentionSeq !== msg.seq) return;
    if (msg.t === 'openMenu' && session.menuRequest !== msg.requestId) return;
    if (image) for (const action of this.#imageActions.filter(action => action.task.group === group)) await action.execute();
    if (metadata && this.#metadataRevisions.get(metadata) !== revision) return;
    if (!this.#canRun()) return this.#unavailable(task);

    let navigation;
    if (switching) {
      this.#activeGeneration = generation;
      this.#resetReads();
      this.#navigationReads.abort(switched());
      this.#navigationReads = new AbortController();
      this.#navigationReads.signal.navigationId = msg.navigationId;
      this.#activeNavigation = task.coalescible ? task : null;
      navigation = session.beginNavigation(msg, this.#navigationReads.signal, session.app !== 'fusion' && msg.id !== 'fusion');
    }
    const controller = this.#navigationReads;
    const signal = send?.signal || (switching ? controller.signal : readOnly ? this.#reads.signal : null);
    const start = Date.now();
    let timedOut = false, timer;
    if (switching && msg.t === 'attach' && msg.initial === true) {
      signal.deadline = start + 30000;
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('当前会话读取超时，请重试或切换 Agent'));
      }, 30000);
    }
    try {
      const result = image?.cancelled ? undefined : await (send
        ? this.#sends.dispatch(send) : cdpRead.run(signal, () => session.handle(msg)));
      if (signal?.aborted) {
        if (timedOut) throw signal.reason;
        return;
      }
      if (navigation) session.finishNavigationResult(navigation);
      const duration = Date.now() - start;
      if (duration > 3000) console.log(`[slow] ${msg.t} ${duration}ms ${session.app || ''}`);
      route?.after?.(session, msg, result);
    } catch (error) {
      session.clearNavigationResult(navigation);
      if (signal?.aborted && !timedOut) return;
      console.log(`[err] ${msg.t}: ${error.message}`);
      if (switching && session.app !== 'fusion' && msg.id !== 'fusion') {
        controller.abort(error);
        this.#resetReads(error);
        await cdpRead.run(null, () => session.navigationFailed(msg, error));
        return;
      }
      route?.fail?.(session, msg, error);
      if (switching && msg.t !== 'attach') session.emit({ t: 'attachFailed', ready: session.bindingReady === true });
      if (msg.t !== 'send') session.emit({ t: 'status', ok: false, msg: quotaErrorMessage(session.app, error) || error.message });
    } finally {
      session.clearNavigationResult(navigation);
      clearTimeout(timer);
      if (this.#activeNavigation === task) this.#activeNavigation = null;
    }
  }
}
