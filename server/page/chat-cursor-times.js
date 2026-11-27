
  // Cursor keeps message times only in React props: any transcript bubble's fiber chain reaches the
  // composerHandle, whose cached data lists headers { bubbleId, type: 1 = human / 2 = AI, createdAt, startedAtMs, completedAtMs }.
  const cursorBubbleTimes = () => {
    const el = doc.querySelector('[data-message-id]');
    const cd = el && codexFiberProps(el, 40).find(p => p.source?.transcriptSource?.composerHandle)?.source?.transcriptSource?.composerHandle?._cachedData;
    const headers = cd?.fullConversationHeadersOnly;
    if (!Array.isArray(headers)) return null;
    const ms = h => Number.isFinite(h.startedAtMs) ? h.startedAtMs : Date.parse(h.createdAt || '');
    const byId = new Map();
    for (const h of headers) if (h.bubbleId && Number.isFinite(ms(h))) byId.set(h.bubbleId, ms(h));
    let generation = null;
    const lastHuman = headers.map((h, i) => h.type === 1 ? i : -1).filter(i => i >= 0).at(-1);
    const start = lastHuman != null ? byId.get(headers[lastHuman].bubbleId) : null;
    if (Number.isFinite(start)) {
      let end = null;
      if (!isBusy()) {
        for (const h of headers.slice(lastHuman + 1)) {
          const e = Number.isFinite(h.completedAtMs) ? h.completedAtMs : (Number.isFinite(h.startedAtMs) ? h.startedAtMs : Date.parse(h.createdAt || ''));
          if (Number.isFinite(e)) end = end == null ? e : Math.max(end, e);
        }
        end ??= start;
      }
      generation = { start, end };
    }
    return { byId, generation };
  };
