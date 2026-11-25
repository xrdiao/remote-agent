export async function withMentionLock(seq, fn) {
  const deadline = Date.now() + 20000;
  while (this.mentionBusy) {
    if (Date.now() > deadline) return null;
    await new Promise(r => setTimeout(r, 80));
    if (seq != null && this.mentionSeq !== seq) return null;
  }
  this.mentionBusy = true;
  this.draftGeneration++;
  try { return await fn(); } finally { this.mentionBusy = false; this.draftGeneration++; }
}
