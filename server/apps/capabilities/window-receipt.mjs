import { ConversationRef } from '../../session/binding.mjs';
import { PAGE_SRC } from '../../page/build.mjs';
import { markSendSubmitted } from '../../ws/send-lifecycle.mjs';
import { normalizeReceiptText, withoutAttachmentLabels } from '../../../lib/shared-rules.mjs';

function readWindowTranscript(cdp, target, timeout) {
  return cdp.evaluate(`(() => {
    const h = ${PAGE_SRC}, chat = h.extract();
    return { thread: chat?.thread || '', draft: h.composerDraft(),
      human: (chat?.items || []).filter(it => it.k === 'human'), queued: chat?.queued || [] };
  })()`, { timeout });
}

// Cursor and Devin compare a baseline to the native transcript after writing.
// Each adapter supplies the evidence source and matching rules it supports.
export async function submitPromptKey(key, queued, submit, target, {
  readEvidence = readWindowTranscript, allowRepeatedQueueText = false,
} = {}) {
  const binding = ConversationRef.capture(this), cdp = binding.cdp, receipt = this.sendNativeReceipt;
  const stillSelected = () => binding.isCurrent(this);
  const imageCount = target?.imageCount || 0;
  const read = timeout => readEvidence(cdp, target, timeout);
  const norm = normalizeReceiptText;
  const before = await read();
  if (!stillSelected() || target && (target.cdp !== cdp || before.thread !== target.thread))
    throw new Error('会话已切换，消息未发送');
  const text = target?.text ?? before.draft;
  const expected = norm(text);
  const human = new Set(before.human.map(it => `${it.i}:${it.sentAt || ''}`));
  const queues = new Set(before.queued.map(it => it.id));
  const queueText = norm(text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000));
  const queuedMatches = rows => rows.filter(it => norm(it.t) === queueText).length;
  markSendSubmitted();
  this.lastDraft = text;
  let result, transportError;
  try { result = submit ? await submit() : await this.key(key, { cdp }); }
  catch (error) {
    if (error.code !== 'CDP_TRANSPORT') throw error;
    transportError = error.message;
  }
  if (result?.queueId && (result.imageCount || 0) >= imageCount) {
    receipt.queueId = result.queueId;
    if (result.message) receipt.message = result.message;
    return true;
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!stillSelected()) break;
    let after;
    try { after = await read(Math.max(1, deadline - Date.now())); } catch { break; }
    if (!stillSelected() || before.thread && after.thread && after.thread !== before.thread) break;
    const item = after.human.find(it => !human.has(`${it.i}:${it.sentAt || ''}`)
      && (it.images?.length || 0) >= imageCount
      && (!expected || norm(withoutAttachmentLabels(it.t)) === expected));
    if (item) { receipt.messageId = item.i; return false; }
    const pending = after.queued.find(it => norm(it.t) === queueText
      && (it.imageCount || 0) >= imageCount
      && (!queues.has(it.id) || allowRepeatedQueueText && queuedMatches(after.queued) > queuedMatches(before.queued)));
    if (pending) { receipt.queueId = pending.id; return true; }
    await new Promise(resolve => setTimeout(resolve, 125));
  }
  receipt.pending = true;
  if (transportError) receipt.message = transportError;
  return queued;
}
