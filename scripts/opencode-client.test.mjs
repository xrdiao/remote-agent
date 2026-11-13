import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeClient, readEvents, createMessageID } from '../server/opencode/client.mjs';

test('OpenCode message IDs share native ordering so later turns are processed', t => {
  t.mock.method(Date, 'now', () => 1794148256219);
  const first = createMessageID(), second = createMessageID();
  assert.match(first, /^msg_1bb91c9db001[0-9a-f]{14}$/);
  assert.match(second, /^msg_1bb91c9db002[0-9a-f]{14}$/);
  assert(first > 'msg_1bb89f3a1001CO8x16kljq1FsY');
  assert(second > first);
});

test('OpenCode client passes project identity, request body and opaque pagination cursors', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: new URL(url), options });
    if (url.pathname.endsWith('/message')) return new Response(JSON.stringify([{ info: { id: 'msg_1' }, parts: [] }]), { headers: { 'x-next-cursor': 'opaque+/=' } });
    return new Response(null, { status: 204 });
  });
  const client = new OpenCodeClient('http://127.0.0.1:4096');
  const page = await client.messages('ses_1', '/home/user/中文 project', 'previous+/=');
  assert.equal(calls[0].url.searchParams.get('directory'), '/home/user/中文 project');
  assert.equal(calls[0].url.searchParams.get('before'), 'previous+/=');
  assert.equal(page.before, 'opaque+/=');
  await client.request('/permission/per_1/reply', { directory: '/project', method: 'POST', body: { reply: 'once' } });
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), { reply: 'once' });
});

test('OpenCode global session listing follows native cursors across pages', async t => {
  const cursors = [];
  t.mock.method(globalThis, 'fetch', async url => {
    cursors.push(url.searchParams.get('cursor'));
    return new Response(JSON.stringify([{ id: cursors.length }]), cursors.length === 1 ? { headers: { 'x-next-cursor': '123' } } : {});
  });
  assert.deepEqual(await new OpenCodeClient().sessions(), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(cursors, [null, '123']);
});

test('OpenCode SSE parser preserves split UTF-8, CRLF frames and event boundaries', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\n\r\ndata: {"payload":{"type":"message.part.delta","properties":{"delta":"你好"}}}\r\n\r\ndata: {"payload":{"type":"session.idle"}}\n\n');
  const response = new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }));
  const events = [];
  for await (const event of readEvents(response)) events.push(event);
  assert.equal(events.length, 2);
  assert.equal(events[0].payload.properties.delta, '你好');
  assert.equal(events[1].payload.type, 'session.idle');
});

test('OpenCode HTTP failures remain visible to the caller', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('native failure', { status: 500 }));
  await assert.rejects(new OpenCodeClient().request('/session'), /OpenCode 500: native failure/);
});

test('OpenCode mutating HTTP requests preserve their cancellation signal and body', async t => {
  const controller = new AbortController(), reason = new Error('send cancelled');
  let captured;
  t.mock.method(globalThis, 'fetch', (_url, options) => {
    captured = options;
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  });
  const pending = new OpenCodeClient().request('/session/ses_1/prompt_async', {
    method: 'POST', body: { parts: [{ type: 'text', text: 'test' }] }, signal: controller.signal,
  });
  assert.equal(captured.signal, controller.signal); assert.equal(captured.method, 'POST');
  assert.equal(JSON.parse(captured.body).parts[0].text, 'test');
  controller.abort(reason); await assert.rejects(pending, error => error === reason);
});

for (const phase of ['headers', 'body']) test(`OpenCode history cancellation releases a pending ${phase} read`, async t => {
  const controller = new AbortController(), reason = new Error('navigation cancelled');
  let received;
  t.mock.method(globalThis, 'fetch', (url, { signal }) => {
    received = { url, signal };
    if (phase === 'headers') return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    return Promise.resolve(new Response(new ReadableStream({ start(body) {
      body.enqueue(new TextEncoder().encode('[{"info":'));
      signal.addEventListener('abort', () => body.error(signal.reason), { once: true });
    } })));
  });
  const pending = new OpenCodeClient().messages('ses_1', '/project', 'opaque-cursor', controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received.signal, controller.signal);
  assert.equal(received.url.searchParams.get('before'), 'opaque-cursor');
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
});
