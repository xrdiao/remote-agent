import { cdpRead } from '../cdp.mjs';
import { withOperation } from '../operations.mjs';
import { ConversationRef } from '../session/binding.mjs';

const requestsBySignal = new WeakMap();

class SendRequest {
  #controller = new AbortController();
  #submitted = false;

  constructor(message, selection, operation, binding) {
    this.message = message;
    this.selection = selection;
    this.operation = operation;
    this.binding = binding;
    requestsBySignal.set(this.signal, this);
  }

  get signal() { return this.#controller.signal; }

  submit() {
    if (this.#submitted) throw new Error('发送请求已提交');
    this.#submitted = true;
  }

  cancel(message) {
    if (this.#submitted || this.signal.aborted) return;
    const error = Object.assign(new Error(message), { cancelled: true });
    this.#controller.abort(error);
    return error;
  }
}

// Called synchronously at the native write, after any cancellable preparation.
export function markSendSubmitted() {
  const signal = cdpRead.getStore();
  signal?.throwIfAborted();
  requestsBySignal.get(signal)?.submit();
}

export class SendLifecycle {
  #requests = new Set();
  #session;
  #fail;
  #withOperation;

  constructor(session, fail, runOperation = withOperation) {
    this.#session = session;
    this.#fail = fail;
    this.#withOperation = runOperation;
  }

  receive(message, operation) {
    if (this.#session.app === 'fusion') return;
    if (message.t === 'stop') {
      const selection = message.sel || this.#session.selectionKey();
      this.#cancel(request => request.selection === selection, '发送已取消，草稿已保留');
    }
    if (message.t !== 'send' || message.submit === false) return;
    const current = ConversationRef.capture(this.#session);
    const selection = message.sel || current.key;
    const request = new SendRequest(message.sel ? message : { ...message, sel: selection }, selection, operation,
      selection === current.key ? current : null);
    this.#requests.add(request);
    return request;
  }

  navigating() {
    if (this.#session.app === 'opencode') this.#cancel(() => true, '会话已切换，消息未提交，草稿已保留');
  }

  disconnected() {
    this.#cancel(() => true, '连接已断开，消息未提交，草稿已保留');
  }

  async run(request, execute) {
    try {
      if (!request.signal.aborted) return await execute();
    } finally {
      this.#requests.delete(request);
    }
  }

  dispatch(request) {
    if (request.selection !== this.#session.selectionKey() || request.binding && !request.binding.isCurrent(this.#session))
      throw new Error('会话已切换，操作未执行');
    return cdpRead.run(request.signal, () => this.#session.handle(request.message));
  }

  #cancel(matches, message) {
    for (const request of this.#requests) {
      if (!matches(request)) continue;
      const error = request.cancel(message);
      if (error) cdpRead.run(null, () => this.#withOperation(request.operation, () => this.#fail(this.#session, request.message, error)));
    }
  }
}
