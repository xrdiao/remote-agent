import assert from 'node:assert/strict';
import test from 'node:test';
import '../server/routes.mjs';
import { adapter } from '../server/apps/codex.mjs';
import { cdpRead } from '../server/cdp.mjs';
import { withOperation } from '../server/operations.mjs';

function submission({ native = true, busy = false, when, follow = 'queue', payload = '  hello\n world  ',
  attachments = false, mentions, receipt = true, submitted = true, submitError, waitError, afterRead, afterWait } = {}) {
  const events = [], calls = [], operation = { pending: false, submitted: false }, controller = new AbortController();
  const before = { thread: 'thread-1', payload, draft: 'draft', hasDraftAttachments: attachments, follow,
    lastTurn: 'turn-1', runs: [{ id: 'turn-1' }], messages: [{ id: 'message-1' }], queued: [{ id: 'queue-1' }] };
  const intended = !!busy && (when === 'queue' || (!when && follow === 'queue'));
  const files = [{ pending: true }];
  let request, finish, unregister = 0;
  const context = { threadId: before.thread, scope: 'selection-1', lastDraft: 'original', sendNativeReceipt: {},
    selectionKey() { return this.scope; }, emit(message) { events.push(message); } };
  const args = (expression, name) => JSON.parse('[' + expression.slice(expression.lastIndexOf('.' + name + '(') + name.length + 2, -1) + ']');
  context.cdp = { async evaluate(expression) {
    if (expression.endsWith('.codexSendState(true)')) {
      calls.push('read');
      afterRead?.(context, controller);
      return structuredClone(before);
    }
    if (expression.includes('.submitCodexMessage(')) {
      calls.push(['submit', ...args(expression, 'submitCodexMessage')]);
      if (native) assert.equal(operation.submitted, true);
      if (submitError) throw submitError;
      return submitted;
    }
    calls.push(['wait', ...args(expression, 'waitCodexReceipt')]);
    if (waitError) throw waitError;
    afterWait?.(context, controller);
    return { queued: intended, messageId: 'message-2', ...(intended ? { queueId: 'queue-2' } : {}) };
  } };
  if (native) context.cdp.nativeWindow = { registerSend(value, callback) {
    assert.equal(context.sendNativeReceipt.pending, true);
    assert.equal(operation.pending, true);
    assert.equal(operation.submitted, false);
    calls.push('register'); request = value; finish = callback;
    return () => { unregister++; };
  } };
  return { context, before, events, calls, operation, controller, files, intended,
    get request() { return request; }, get unregister() { return unregister; },
    finish(...values) { finish(...values); },
    run() { return withOperation(operation, () => cdpRead.run(controller.signal,
      () => adapter.submitPrompt.call(context, when === 'now', busy, when, false, mentions,
        receipt ? { requestId: 'request-1' } : undefined, files))); } };
}

for (const native of [true, false]) {
  const mode = native ? 'window' : 'page';
  for (const intent of [{ busy: false }, { busy: true }, { busy: true, follow: 'steer' },
    { busy: true, when: 'queue' }, { busy: true, when: 'now' }, { busy: false, when: 'queue' }]) {
    test(`${mode}: send intent ${JSON.stringify(intent)}`, async () => {
      const state = submission({ native, ...intent });
      assert.equal(await state.run(), state.intended);
      assert.equal(state.context.lastDraft, state.before.draft);
      assert.equal(state.calls.filter(call => call === 'read').length, 1);
      const submits = state.calls.filter(call => Array.isArray(call) && call[0] === 'submit');
      assert.equal(submits.length, 1);
      assert.equal(submits[0][1], intent.when === 'now' ? 'steer' : intent.when === 'queue' ? 'queue' : '');
      if (native) {
        assert.deepEqual(state.calls.slice(0, 2), ['read', 'register']);
        assert.equal(submits[0][2], true);
        assert.equal(submits[0][3], 'request-1');
        assert.equal(state.request.action, state.intended ? 'queue' : intent.busy ? 'steer' : 'send');
        assert.equal(state.request.expected, 'hello\n world');
        assert.deepEqual([...state.request.before], ['message-1']);
        assert.deepEqual([...state.request.beforeQueues], ['queue-1']);
        assert.deepEqual([...state.request.beforeTurns], ['turn-1']);
        assert.equal(state.request.afterTurn, 'turn-1');
        assert.equal(state.context.sendNativeReceipt.pending, true);
      } else {
        assert.equal(submits[0].length, 2);
        const wait = state.calls.find(call => Array.isArray(call) && call[0] === 'wait');
        assert.deepEqual(wait[1], { thread: 'thread-1', messages: [{ id: 'message-1' }], queued: [{ id: 'queue-1' }] });
        assert.equal(wait[2], 'hello\n world');
        assert.equal(state.context.sendNativeReceipt.messageId, 'message-2');
      }
    });
  }

  for (const input of [{ attachments: true, payload: '' },
    { mentions: [{ section: 'local-files' }], payload: '' }, { payload: 'plain text' }]) {
    test(`${mode}: attachment facts ${JSON.stringify(input)}`, async () => {
      const state = submission({ native, ...input });
      await state.run();
      const expected = !!input.attachments || !!input.mentions?.length;
      assert.equal(native ? state.request.hasAttachments
        : state.calls.find(call => Array.isArray(call) && call[0] === 'wait')[3], expected);
    });
  }

  test(`${mode}: unavailable payload never submits`, async () => {
    const state = submission({ native, payload: null });
    await assert.rejects(state.run(), /Codex 输入尚未就绪/);
    assert.deepEqual(state.calls, ['read']);
    assert.equal(state.context.lastDraft, 'original');
    assert.equal(state.operation.submitted, false);
  });

  test(`${mode}: rejected submit does not report success`, async () => {
    const state = submission({ native, submitted: false });
    await assert.rejects(state.run(), /Codex 提交入口当前不可用/);
    assert.equal(state.unregister, native ? 1 : 0);
    assert.equal(state.operation.pending, false);
    assert.equal(!!state.context.sendNativeReceipt.pending, false);
    assert.deepEqual(state.events, []);
  });
}

test('window: uncertain submit retains pending receipt', async () => {
  const state = submission({ submitError: new Error('connection lost') });
  assert.equal(await state.run(), false);
  assert.equal(state.unregister, 0);
  assert.equal(state.operation.pending, true);
  assert.equal(state.context.sendNativeReceipt.pending, true);
  assert.equal(state.events[0].t, 'sent');
  assert.equal(state.events[0].pending, true);
});

test('window: submit without request receipt rethrows the original failure', async () => {
  const error = new Error('connection lost'), state = submission({ receipt: false, submitError: error });
  await assert.rejects(state.run(), actual => actual === error);
  assert.equal(state.calls.includes('register'), false);
  assert.deepEqual(state.events, []);
});

test('window: accepted queue clears the receipt and attachment pending state', async () => {
  const state = submission({ busy: true, when: 'queue' });
  await state.run();
  state.finish({ queued: true, thread: 'thread-1', queueId: 'queue-2' });
  assert.equal(state.context.sendNativeReceipt.pending, false);
  assert.equal(state.files[0].pending, false);
  assert.equal(state.events[0].queueId, 'queue-2');
});

test('window: result keeps the selection captured before the read', async () => {
  const state = submission({ afterRead: context => { context.scope = 'selection-2'; } });
  await state.run();
  state.finish(null, 'still unknown', true);
  assert.equal(state.events[0].sel, 'selection-1');
  assert.equal(state.events[0].pending, true);
});

test('window: explicit failure publishes sendFailed', async () => {
  const state = submission();
  await state.run();
  state.finish(null, 'not accepted', false);
  assert.equal(state.events[0].t, 'sendFailed');
  assert.equal(state.events[0].requestId, 'request-1');
});

test('window: cancellation before reading prevents registration and submit', async () => {
  const state = submission();
  state.controller.abort();
  await assert.rejects(state.run(), { name: 'AbortError' });
  assert.deepEqual(state.calls, []);
});

test('window: cancellation during preparation still prevents submit', async () => {
  const state = submission({ afterRead: (context, controller) => controller.abort() });
  await assert.rejects(state.run(), { name: 'AbortError' });
  assert.deepEqual(state.calls, ['read', 'register']);
});

test('page: read failure while waiting leaves the receipt pending', async () => {
  const state = submission({ native: false, waitError: new Error('read failed') });
  assert.equal(await state.run(), false);
  assert.equal(state.context.sendNativeReceipt.pending, true);
});

test('page: selection change cannot accept an old receipt', async () => {
  const state = submission({ native: false, afterWait: context => { context.scope = 'selection-2'; } });
  assert.equal(await state.run(), false);
  assert.equal(state.context.sendNativeReceipt.pending, true);
  assert.equal(state.context.sendNativeReceipt.messageId, undefined);
});

test('page: cancellation while waiting propagates', async () => {
  const state = submission({ native: false, waitError: new Error('read cancelled'),
    afterRead: (context, controller) => controller.abort() });
  await assert.rejects(state.run(), { name: 'AbortError' });
});
