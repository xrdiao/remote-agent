import assert from 'node:assert/strict';
import test from 'node:test';
import '../server/routes.mjs';
import { AgentContext } from '../server/agent/context.mjs';
import { Session } from '../server/session.mjs';
import { NativeCdp, NativeWindow } from '../server/native-windows.mjs';
import { methods } from '../server/apps/codex.mjs';

const thinkingMaps = ['thinking', 'thinkingTried', 'keptThink'];
const thinkingSets = ['thinkLiveSeen', 'thinkFinal'];
const sessionMaps = ['tasksTried', 'devinHist', 'devinCmds', 'devinCmdTried', 'thoughtFails'];
const history = () => new Map([['thread-a', [{ i: 'human-a', k: 'human', t: 'saved history', order: 10001 }]]]);

function populated(cache = history(), app = 'codex') {
  const context = new AgentContext();
  context.app = app;
  context.threadId = 'thread-a';
  context.itemCache = cache;
  context.codexEarlier = methods.codexEarlier;
  for (const field of [...thinkingMaps, ...sessionMaps]) context[field].set('saved', field);
  for (const field of thinkingSets) context[field].add('saved');
  context.latestThink = { id: 'saved', body: 'saved thought' };
  context.thinkTries = new Map([['saved', 2]]);
  return context;
}

test('fresh contexts own independent thinking state without new lifecycle fields', () => {
  const first = new AgentContext(), second = new AgentContext();
  first.thinking.set('saved', 'first');
  first.thinkFinal.add('saved');
  assert.equal(second.thinking.has('saved'), false);
  assert.equal(second.thinkFinal.has('saved'), false);
  assert.equal(Object.hasOwn(first, 'latestThink'), false);
  assert.equal(Object.hasOwn(first, 'thinkTries'), false);
});

test('standalone initialization keeps its original full-reset scope', () => {
  const context = populated(), oldHistory = context.itemCache, latest = context.latestThink, tries = context.thinkTries;
  context.resetCaches();
  assert.notEqual(context.itemCache, oldHistory);
  assert.equal(context.itemCache.size, 0);
  assert.equal(oldHistory.get('thread-a')[0].t, 'saved history');
  assert.equal(context.tasksTried.size, 0);
  assert.equal(context.devinHist.size, 0);
  assert.equal(context.latestThink, latest);
  assert.equal(context.thinkTries, tries);
});

test('view reset invalidates its read while preserving window history and the other context', () => {
  const cache = history(), first = populated(cache), second = populated(cache);
  const oldThinking = first.thinking, peerThinking = second.thinking;
  const saved = Object.fromEntries(sessionMaps.map(field => [field, first[field]]));
  first.sel = 4;
  first.polling = 4;
  first.pendingThread = 'pending';
  first.lastDraft = 'draft';
  first.lastChat = first.lastExtractedChat = 'old';
  first.clearViewState();
  assert.equal(first.itemCache, cache);
  assert.equal(second.itemCache, cache);
  assert.equal(cache.get('thread-a')[0].t, 'saved history');
  assert.notEqual(first.thinking, oldThinking);
  assert.equal(oldThinking.get('saved'), 'thinking');
  assert.equal(second.thinking, peerThinking);
  assert.equal(second.thinking.get('saved'), 'thinking');
  for (const field of [...thinkingMaps, ...thinkingSets]) assert.equal(first[field].size, 0);
  for (const field of sessionMaps) assert.equal(first[field], saved[field]);
  assert.equal(first.latestThink, null);
  assert.equal(first.thinkTries.size, 0);
  assert.equal(first.sel, 5);
  assert.equal(first.polling, null);
  assert.equal(first.pendingThread, '');
  assert.equal(first.lastDraft, undefined);
  assert.equal(first.lastChat, '');
  assert.equal(first.lastExtractedChat, '');
});

test('Fusion side view reset replaces only its private history', () => {
  const nativeCache = history(), native = populated(nativeCache), fusion = populated();
  const previous = fusion.itemCache;
  fusion.fusionOwner = {};
  fusion.clearViewState();
  assert.notEqual(fusion.itemCache, previous);
  assert.equal(fusion.itemCache.size, 0);
  assert.equal(previous.get('thread-a')[0].t, 'saved history');
  assert.equal(native.itemCache, nativeCache);
  assert.equal(nativeCache.get('thread-a')[0].t, 'saved history');
});

test('Codex thread change resets local thoughts and retains both threads in the shared window', () => {
  const cache = history(), context = populated(cache), peer = populated(cache);
  const previous = cache.get('thread-a'), peerThinking = peer.thinking;
  const protectedState = Object.fromEntries(sessionMaps.map(field => [field, context[field]]));
  methods.mergeCodexItems.call(context, { thread: 'thread-b', busy: true,
    items: [{ i: 'human-b', k: 'human', t: 'new history', order: 10001 }] });
  assert.equal(context.threadId, 'thread-b');
  assert.equal(context.itemCache, cache);
  assert.equal(cache.get('thread-a'), previous);
  assert.equal(cache.get('thread-b')[0].t, 'new history');
  for (const field of [...thinkingMaps, ...thinkingSets]) assert.equal(context[field].size, 0);
  for (const field of sessionMaps) assert.equal(context[field], protectedState[field]);
  assert.equal(context.latestThink, null);
  assert.equal(context.thinkTries.size, 0);
  assert.equal(peer.thinking, peerThinking);
  assert.equal(peerThinking.get('saved'), 'thinking');
});

test('Codex same-thread refresh retains accumulated thinking state', () => {
  const context = populated(), thoughts = context.thinking, final = context.thinkFinal, latest = context.latestThink;
  methods.mergeCodexItems.call(context, { thread: 'thread-a', busy: true,
    items: [{ i: 'human-a', k: 'human', t: 'updated history', order: 10001 }] });
  assert.equal(context.thinking, thoughts);
  assert.equal(context.thinking.get('saved'), 'thinking');
  assert.equal(context.thinkFinal, final);
  assert.equal(context.latestThink, latest);
  assert.equal(context.itemCache.get('thread-a')[0].t, 'updated history');
});

test('Codex merge leaves another Agent context untouched', () => {
  const context = populated(history(), 'cursor'), thoughts = context.thinking, cache = context.itemCache;
  const chat = { thread: 'thread-b', items: [] };
  methods.mergeCodexItems.call(context, chat);
  assert.equal(context.threadId, 'thread-a');
  assert.equal(context.thinking, thoughts);
  assert.equal(context.thinking.get('saved'), 'thinking');
  assert.equal(context.itemCache, cache);
  assert.equal(cache.size, 1);
});

for (const app of ['cursor', 'devin', 'codex']) {
  test(`${app}: attach rebinds the window cache without clearing another context`, async t => {
    t.mock.method(NativeCdp.prototype, 'connect', async () => {});
    t.mock.method(NativeWindow.prototype, 'start', async () => {});
    t.mock.method(NativeCdp.prototype, 'evaluate', async expression => {
      if (expression.endsWith('.workspaceTrustState()')) return { required: false };
      if (expression.endsWith('.codexThread()') || expression.endsWith('.activeThread()')) return 'thread-a';
      if (expression.endsWith('.panelRect()')) return [0, 0, 500, 500];
      throw new Error('Unexpected CDP read');
    });
    const editorUrl = `ws://thinking-cache-${app}/editor`, chatUrl = app === 'codex' ? `ws://thinking-cache-${app}/chat` : null;
    const holder = new NativeCdp(chatUrl || editorUrl), window = holder.nativeWindow;
    window.itemCache.set('thread-a', history().get('thread-a'));
    const peer = populated(window.itemCache), context = populated();
    const oldLocalHistory = context.itemCache, peerThoughts = peer.thinking;
    const messages = [];
    context.detach = () => {};
    context.refreshViewport = async () => {};
    context.projectName = () => 'test';
    context.emit = message => messages.push(message);
    t.after(() => {
      const connections = new Set([holder, context.cdp, context.editorCdp].filter(Boolean));
      const windows = new Set([...connections].map(connection => connection.nativeWindow));
      for (const connection of connections) connection.close();
      for (const item of windows) item.close();
    });
    await Session.prototype.openBound.call(context, { id: `${app}:window`, app, title: 'test' }, editorUrl, chatUrl,
      { windowId: 'window', threadId: 'thread-a', deferred: true, initial: false });
    assert.equal(context.itemCache, window.itemCache);
    assert.notEqual(context.itemCache, oldLocalHistory);
    assert.equal(window.itemCache.get('thread-a')[0].t, 'saved history');
    assert.equal(oldLocalHistory.get('thread-a')[0].t, 'saved history');
    assert.equal(peer.itemCache, window.itemCache);
    assert.equal(peer.thinking, peerThoughts);
    assert.equal(peer.thinking.get('saved'), 'thinking');
    assert.equal(context.thinking.size, 0);
    assert.equal(context.tasksTried.size, 0);
    assert.equal(context.devinHist.size, 0);
    assert.equal(context.latestThink, null);
    assert.equal(context.thinkTries.size, 0);
    assert.equal(context.threadId, 'thread-a');
    assert.equal(messages.some(message => message.t === 'attached' && message.app === app), true);
  });
}
