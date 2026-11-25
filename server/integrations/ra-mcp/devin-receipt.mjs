// Fail-closed fallback for native ACP message IDs when Devin's Fusion ledger
// does not track an ordinary MCP task. Only the latest, exactly echoed prompt
// can be reconciled against its own completed native request.
const str = v => v == null ? '' : String(v);
// The native Devin transcript inserts two additional LF characters for each
// LF in a submitted prompt. Accept only these two byte-exact representations.
export function matchesDevinNativePrompt(nativeText, submitted) {
  return typeof nativeText === 'string' && typeof submitted === 'string'
    && (nativeText === submitted || submitted.includes('\n') && nativeText === submitted.replace(/\n/g, '\n\n\n'));
}
export function correlateDevinCurrentReply({ items, state, receipt, expectedPrompt }) {
  if (!Array.isArray(items) || !state || typeof receipt !== 'string' || !/^acp\d+$/.test(receipt)
      || typeof expectedPrompt !== 'string' || !expectedPrompt.trim()
      || state.busy || state.waiting || state.run?.status !== 'completed' || !str(state.run.id))
    return null;
  const humans = items.map((item, index) => ({ item, index }))
    .filter(({item}) => item?.k === 'human');
  const exact = humans.filter(({ item }) =>
    str(item.i) === receipt || Array.isArray(item.nativeIds) && item.nativeIds.includes(receipt));
  if (exact.length !== 1 || humans.at(-1) !== exact[0]) return null;
  const { item: human, index } = exact[0];
  if (!matchesDevinNativePrompt(str(human.t), expectedPrompt)) return null;
  // The native run must not precede the user message when both timestamps
  // are present (allow a small transport clock/dispatch skew).
  const started = Number(state.run.startedAt) || 0, sent = Number(human.sentAt) || 0;
  if (started && sent && started + 10000 < sent) return null;
  const tail = items.slice(index + 1);
  if (tail.some(item => item.k === 'human')) return null;
  const replies = tail.filter(item => item.k === 'assistant' && str(item.t).trim());
  if (!replies.length) return null;
  const final = replies.at(-1);
  return { available:true, busy:false, waiting:'', run:state.run,
    last:str(final.t).slice(0,16000), lastUserMessageId:receipt,
    currentTurn:true, assistantAfter:true, statusKnown:true,
    completed:true, exactCompletion:true, reason:'' };
}
