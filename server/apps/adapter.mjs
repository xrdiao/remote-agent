// UI flags are advertised on the wire. Transport capabilities own the executable
// actions for a specific binding (a Codex window and backend have separate owners).
const record = source => Object.assign(Object.create(null), source);
const immutable = source => Object.freeze(record(source));

function handlers(source = {}) {
  for (const [name, method] of Object.entries(source))
    if (typeof method !== 'function') throw new TypeError(`Invalid adapter handler: ${name}`);
  return immutable(source);
}

export function defineAgentAdapter({ adapter, methods, capabilities, nativeCapabilities, ...entry }) {
  const native = Object.create(null);
  for (const [transport, { composer, actions, queue, routes }] of Object.entries(nativeCapabilities)) {
    if (composer && (typeof composer.typeDraft !== 'function' || typeof composer.submitPrompt !== 'function'))
      throw new TypeError(`Incomplete composer: ${entry.app}/${transport}`);
    native[transport] = Object.freeze({
      composer: composer && immutable(composer),
      actions: handlers(actions),
      queue: handlers(queue),
      routes: handlers(routes),
    });
  }
  if (!native[entry.kind]) throw new TypeError(`Missing primary transport: ${entry.app}/${entry.kind}`);
  // Existing non-action callers use this facade. Its method names cannot grow
  // through inherited keys or app registration, and the receiver remains the context.
  return Object.freeze({ ...entry, adapter: Object.seal(record(adapter)), methods: handlers(methods),
    capabilities: Object.freeze({ ...capabilities }), native: Object.freeze(native) });
}

export function unsupportedCapability(app, action) {
  return new Error(`${app || '当前应用'} 不支持此操作（${action}）`);
}
