const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
const integer = { type: 'integer' };
const point = { type: 'number', minimum: 0, maximum: 1 };
const target = schema({ id: integer, revision: integer, label: string, resource: string, text: string, role: string });
const expected = schema({ app: string, target, text: string, changed: { type: 'boolean' } });
const actions = ['launch', 'click', 'longClick', 'text', 'scrollForward', 'scrollBackward', 'back', 'home', 'recents', 'tap', 'swipe'];
const step = schema({ action: { type: 'string', enum: actions }, app: string, target, text: string,
  screen: integer, x: point, y: point, endX: point, endY: point, expect: expected }, ['action']);
const tool = (name, description, inputSchema = schema(), readOnlyHint = true) => ({ name, description, inputSchema,
  annotations: { readOnlyHint, openWorldHint: true } });

export const phoneTools = [
  tool('phone_observe', 'Read the current Android accessibility snapshot: visible text, element hierarchy, window information, numbered controls and screen geometry. Supply since only if you already have that tree revision.', schema({ since: integer })),
  tool('phone_apps', 'List apps that can be launched on this authorized Android phone.'),
  tool('phone_act', 'Execute up to 12 steps in order and return the resulting snapshot. Select a control by one or more exact matching fields, or use its id AND revision. When changing screens use expect (app, visible text substring, target, or changed). A failed action or expectation stops the batch. Tap and swipe take normalized coordinates and the screen revision from phone_screenshot.',
    schema({ steps: { type: 'array', items: step, minItems: 1, maxItems: 12 } }, ['steps']), false),
  tool('phone_read_list', 'Read the visible text in a scrollable list across up to five pages, deduplicated. Select the list with an exact label or resource selector when the page has multiple lists. The tool scrolls the phone and stops if the active window changes.',
    schema({ target, pages: { type: 'integer', minimum: 1, maximum: 5 } }), false),
  tool('phone_screenshot', 'Read an image of the current screen and its revision, for visual details absent from the accessibility snapshot.'),
];

const fields = ['label', 'resource', 'text', 'role'];
const supported = new Set(['click', 'longClick', 'text', 'scrollForward', 'scrollBackward']);
const global = new Set(['back', 'home', 'recents']);
const appId = value => typeof value === 'string' && value.length <= 160 && /^[a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+$/.test(value);
const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const validTarget = (value, byId = true) => shape(value, [...fields, 'id', 'revision']) &&
  (value.id === undefined ? value.revision === undefined && fields.some(key => value[key] !== undefined)
    : byId && Number.isSafeInteger(value.id) && value.id >= 0 && Number.isSafeInteger(value.revision) && value.revision > 0) &&
  fields.every(key => value[key] === undefined || typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 160);
const validExpected = value => shape(value, ['app', 'target', 'text', 'changed']) && Object.keys(value).length > 0 &&
  (value.app === undefined || appId(value.app)) && (value.target === undefined || validTarget(value.target)) &&
  (value.text === undefined || typeof value.text === 'string' && value.text.length > 0 && value.text.length <= 160) &&
  (value.changed === undefined || value.changed === true);
const isPoint = value => typeof value === 'number' && value >= 0 && value <= 1;

function validateStep(value) {
  if (!shape(value, ['action', 'app', 'target', 'text', 'screen', 'x', 'y', 'endX', 'endY', 'expect']) ||
      !actions.includes(value.action) || value.expect !== undefined && !validExpected(value.expect)) throw Error('Invalid action or expectation');
  if (value.action === 'launch' && !appId(value.app)) throw Error('Launch requires an exact app package');
  if (supported.has(value.action) && !validTarget(value.target)) throw Error('Select a control by exact attributes, or supply both id and revision');
  if (value.action === 'text' && (typeof value.text !== 'string' || value.text.length > 2000)) throw Error('Text must be at most 2000 characters');
  if (value.action === 'tap' || value.action === 'swipe') {
    const points = value.action === 'tap' ? ['x', 'y'] : ['x', 'y', 'endX', 'endY'];
    if (!Number.isSafeInteger(value.screen) || value.screen <= 0 || !points.every(key => isPoint(value[key])))
      throw Error('Gesture requires the screen revision and normalized points');
  }
}

function matching(state, target, action) {
  if (target?.revision !== undefined && target.revision !== state.revision) return [];
  return state.elements.filter(element => (target?.id === undefined || target.id === element.id) &&
    fields.every(key => target?.[key] === undefined || target[key] === element[key]) &&
    (!action || element.actions?.includes(action)));
}

function meets(state, expect, before) {
  return (!expect.app || expect.app === state.app) && (!expect.changed || before !== state.revision) &&
    (!expect.target || matching(state, expect.target).length === 1) &&
    (!expect.text || state.elements.some(element => [element.text, element.description, element.label]
      .some(value => typeof value === 'string' && value.includes(expect.text))));
}

function waitFor(ctx, read, timeout, signal, label) {
  signal.throwIfAborted();
  const now = read();
  if (now) return Promise.resolve(now);
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', interrupted);
      ctx.events.off('change', updated);
      if (error) reject(error); else resolve(value);
    };
    const updated = () => {
      const value = read();
      if (value) finish(null, value);
    };
    const interrupted = () => finish(signal.reason);
    const timer = setTimeout(() => finish(Error(label)), timeout);
    ctx.events.on('change', updated);
    signal.addEventListener('abort', interrupted, { once: true });
  });
}

const observation = (ctx, signal) => waitFor(ctx, ctx.state, 6000, signal,
  'No structured phone state received. Confirm the phone is connected and uses the current Android build.');

async function action(ctx, content, signal) {
  const ack = await ctx.act(content, signal);
  if (ack.reason === 'outcomeUnknown') throw Error('手机未确认操作结果。连接恢复后请先检查手机状态，再决定下一步。');
  if (!ack.ok) throw Error(`Phone action ${ack.reason || 'failed'}`);
  return ack;
}

async function execute(ctx, steps, signal) {
  const completed = [];
  for (const [index, value] of steps.entries()) {
    signal.throwIfAborted();
    const before = await observation(ctx, signal);
    let content;
    try {
      if (value.action === 'launch') content = { kind: 'launch', app: value.app };
      else if (global.has(value.action)) content = { kind: 'system', action: value.action };
      else if (supported.has(value.action)) {
        const find = () => {
          const state = ctx.state();
          const matches = state ? matching(state, value.target, value.action) : [];
          return matches.length === 1 ? { state, node: matches[0] } : null;
        };
        const resolved = await waitFor(ctx, find, value.target.id === undefined ? 4000 : 30, signal,
          'Control is missing, stale, or ambiguous. Read the current state and use a unique selector.');
        content = { kind: 'node', action: value.action, node: resolved.node.id, revision: resolved.state.revision, text: value.text };
      } else {
        if (value.screen !== before.screen?.revision) throw Error('The screenshot revision changed. Read a fresh screenshot.');
        const { x, y, endX = x, endY = y } = value;
        content = { kind: 'gesture', revision: value.screen, x, y, endX, endY, duration: value.action === 'tap' ? 60 : 240 };
      }
      await action(ctx, content, signal);
      completed.push(value.action);
      const expect = value.action === 'launch' ? { ...value.expect, app: value.app } : value.expect;
      if (expect) await waitFor(ctx, () => {
        const state = ctx.state();
        return state && meets(state, expect, before.revision) ? state : null;
      }, 5500, signal, 'Expected phone state did not appear');
    } catch (error) {
      signal.throwIfAborted();
      return { error: error.message, step: index + 1, completed, state: ctx.state() };
    }
  }
  await action(ctx, { kind: 'inspect' }, signal);
  return { completed, state: await observation(ctx, signal) };
}

function listNodes(state, root) {
  return state.elements.filter(element => {
    for (let index = element.parent; index >= 0; index = state.elements[index]?.parent ?? -1) {
      if (state.elements[index] === root) return true;
    }
    return false;
  });
}

function listPage(state, target) {
  const roots = matching(state, target).filter(element => element.scrollable || element.actions?.includes('scrollForward'));
  if (roots.length !== 1) return { reason: roots.length ? 'ambiguousList' : 'listNotScrollable' };
  const root = roots[0];
  const text = listNodes(state, root).map(element => element.text || element.description).filter(Boolean);
  return { root, text, signature: JSON.stringify(text) };
}

function listSwipe(state, root) {
  if (!state.screen || !root.bounds) return null;
  const { width, height, revision } = state.screen;
  const [left, top, right, bottom] = root.bounds;
  const x1 = Math.max(0, left), y1 = Math.max(0, top), x2 = Math.min(width, right), y2 = Math.min(height, bottom);
  if (x1 >= x2 || y1 >= y2) return null;
  const x = (x1 + x2) / (2 * width), length = y2 - y1;
  return { kind: 'gesture', revision, x, endX: x, y: (y1 + length * .8) / height,
    endY: (y1 + length * .24) / height, duration: 320, window: state.window, app: state.app };
}

async function readList(ctx, args, signal) {
  const initial = await observation(ctx, signal);
  let state = initial, pages = 0, reason = 'limit';
  const text = new Set(), limit = args.pages ?? 3;
  let page = listPage(initial, args.target);
  while (pages < limit) {
    if (!page.root) { reason = page.reason; break; }
    for (const value of page.text) text.add(value);
    pages++;
    if (pages === limit) break;
    const swipe = listSwipe(state, page.root);
    if (!swipe) { reason = 'listBoundsUnavailable'; break; }
    const ack = await ctx.act(swipe, signal);
    if (!ack.ok) { reason = ack.reason; break; }
    const next = await waitFor(ctx, () => {
      const latest = ctx.state();
      if (!latest || latest.revision === state.revision) return null;
      if (latest.app !== initial.app || latest.window !== initial.window) return { reason: 'windowChanged' };
      const result = listPage(latest, args.target);
      return result.root && result.signature !== page.signature ? { state: latest, page: result } : null;
    }, 2500, signal, 'unchanged').catch(error => { signal.throwIfAborted(); if (error.message !== 'unchanged') throw error; return null; });
    if (!next) { reason = 'unchanged'; break; }
    if (next.reason) { reason = next.reason; break; }
    ({ state, page } = next);
  }
  return { app: initial.app, pages, reason, text: [...text].slice(0, 200) };
}

export async function runPhoneTool(ctx, name, args, callerSignal) {
  const signal = AbortSignal.any([callerSignal, ctx.signal]);
  signal.throwIfAborted();
  if (name === 'phone_observe') {
    if (!shape(args, ['since']) || args.since !== undefined && !Number.isSafeInteger(args.since)) throw Error('Invalid observation arguments');
    const state = await observation(ctx, signal);
    return state.revision === args.since ? { unchanged: true, revision: state.revision, app: state.app, screen: state.screen } : state;
  }
  if (name === 'phone_screenshot') {
    if (!shape(args, [])) throw Error('Invalid screenshot arguments');
    const { frame, screen } = await waitFor(ctx, ctx.image, 5500, signal, 'The phone has not produced a current screenshot');
    return { image: frame.toString('base64'), screen };
  }
  if (name === 'phone_apps') {
    if (!shape(args, [])) throw Error('Invalid app list arguments');
    return ctx.exclusive(async () => ({ apps: (await action(ctx, { kind: 'apps' }, signal)).apps }));
  }
  if (name === 'phone_act') {
    if (!shape(args, ['steps']) || !Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > 12) throw Error('Expected 1 to 12 steps');
    args.steps.forEach(validateStep);
    return ctx.exclusive(() => execute(ctx, args.steps, signal));
  }
  if (!shape(args, ['target', 'pages']) || args.target !== undefined && !validTarget(args.target, false) ||
      args.pages !== undefined && (!Number.isInteger(args.pages) || args.pages < 1 || args.pages > 5)) throw Error('Invalid list arguments');
  return ctx.exclusive(() => readList(ctx, args, signal));
}
