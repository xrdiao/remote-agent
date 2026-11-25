// The transport can change without moving the conversation. A reference keeps the
// native owner and generation that an asynchronous action actually started with.
const identity = {
  app: null, targetId: '', windowId: '', threadId: '', cdp: null, editorCdp: null,
  codexPageId: '', codexBackend: false, codexDirectory: '', codexOwnerRoot: '', openCodeDirectory: '',
};
const metadata = {
  bindingReady: false, selectionHome: false, selectedThread: undefined,
  navigationId: undefined, sessionProject: null, sessionCwd: '', winTitle: '',
};
const record = Symbol('session binding');

export class ConversationRef {
  constructor(values) {
    Object.assign(this, values);
    this.key = [this.app || '', this.windowId || '', this.threadId || ''].join('|');
    Object.freeze(this);
  }

  static capture(context) {
    const binding = context[record];
    if (binding) return binding;
    const values = {};
    for (const name of Object.keys(identity)) values[name] = context[name];
    return new ConversationRef({ ...values, sel: context.sel });
  }

  isCurrent(context) {
    return this.sel === context.sel && this.key === context.selectionKey()
      && this.cdp === context.cdp && this.editorCdp === context.editorCdp;
  }

  assertCurrent(context) {
    if (!this.isCurrent(context)) throw new Error('会话已切换，操作未执行');
  }
}

export class SessionBinding {
  static initialize(context) {
    context[record] = new ConversationRef({ ...identity, ...metadata, sel: 0 });
  }

  static commit(context, changes, advance = false) {
    const previous = context[record];
    if (!previous) {
      Object.assign(context, changes);
      if (advance) context.sel = (context.sel || 0) + 1;
      return;
    }
    const moved = Object.keys(changes).some(name => name in identity && previous[name] !== changes[name]);
    context[record] = new ConversationRef({ ...previous, ...changes,
      sel: changes.sel ?? previous.sel + (advance || moved ? 1 : 0) });
    return context[record];
  }

  // Preserve the existing AgentContext properties for adapter callers. Updates
  // to several related fields use commit() to expose one coherent transition.
  static defineProperties(prototype) {
    const fields = [...Object.keys(identity), ...Object.keys(metadata), 'sel'];
    for (const name of fields) Object.defineProperty(prototype, name, {
      get() { return this[record]?.[name]; },
      set(value) { SessionBinding.commit(this, { [name]: value }); },
      configurable: true,
    });
  }
}
