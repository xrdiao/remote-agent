
  const codexCapacityItem = () => {
    if (devinSurface() || !doc.querySelector('.ProseMirror')) return null;
    const text = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const quoted = '.ProseMirror, [class*="MarkdownRoot"], [class*="user-message"], [data-message-kind="human"], pre, code, script, style';
    let capacity = null;
    for (let node = text.nextNode(); node; node = text.nextNode()) {
      if (!/^\s*(?:(?:The\s+)?(?:selected\s+)?model\s+is\s+at\s+capacity\b|(?:所选|选定|当前)模型.*(?:容量不足|模型容量))/i.test(node.textContent || '')) continue;
      let banner = node.parentElement;
      if (!banner || !vis(banner) || banner.closest(quoted)) continue;
      const turn = banner.closest('[data-turn-key]');
      const latest = turn && codexLatestEntry(turn);
      if (latest && latest.turnKey !== turn.getAttribute('data-turn-key')) continue;
      let retry = null;
      for (let parent = banner, n = 0; parent && n < 8; n++, parent = parent.parentElement) {
        if (parent.querySelector(quoted)) break;
        retry = [...parent.querySelectorAll('button, [role=button]')].find(button => vis(button)
          && /^(?:Retry|Try(?: again)?|重试|再试一次)(?:\s+in\s+\d+s)?$/i.test((button.innerText || button.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()));
        if (retry || parent.matches('aside, [role="alert"], [data-local-conversation-item-target-ids]')) { banner = parent; break; }
      }
      const label = (retry?.innerText || retry?.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const ready = retry && RETRY_LABEL.test(label) && !retry.disabled && retry.getAttribute('aria-disabled') !== 'true';
      const texts = doc.createTreeWalker(banner, NodeFilter.SHOW_TEXT), parts = [];
      for (let part = texts.nextNode(); part; part = texts.nextNode())
        if (!retry?.contains(part) && vis(part.parentElement)) parts.push(part.textContent);
      const body = parts.join(' ').replace(/\s+/g, ' ').trim();
      const owner = doc.defaultView;
      const previous = owner.__remoteAgentCapacity;
      const thread = codexThread(), turnKey = turn?.getAttribute('data-turn-key') || '';
      if (!previous || previous.thread !== thread || previous.turnKey !== turnKey)
        owner.__remoteAgentCapacity = { banner, thread, turnKey, id: 'capacity-' + (owner.__remoteAgentCapacitySerial = (owner.__remoteAgentCapacitySerial || 0) + 1) };
      const capacityInstance = owner.__remoteAgentCapacity.id;
      const key = `${codexThread()}:capacity`;
      capacity = { i: key, k: 'notice', kind: 'capacity', t: body.slice(0, 400), capacity: true, live: true,
        syntheticCapacity: true, capacityInstance, _retry: retry, _turnKey: turnKey,
        ...(ready ? { b: [label], actions: [capacityInstance], btnItem: key } : {}) };
    }
    if (!capacity) doc.defaultView.__remoteAgentCapacity = null;
    return capacity;
  };
  const codexReceiptState = (thread = codexThread()) => {
    const scopes = codexHistoryScopes();
    const conversation = codexConversationManager(thread, scopes)?.getConversation(thread);
    return codexHistoryState(conversation, false, scopes, thread);
  };
  const codexReceiptRows = (state = codexReceiptState(), from = -2) => {
    return state.entries.slice(from).flatMap(entry => {
      const source = codexTurnSource(entry, state.scopes, true);
      if (!source || source.metadata.pendingUserMessageAdmission) return [];
      const steering = new Map(source.rawItems.filter(item => item?.type === 'steeringUserMessage' && item.status === 'accepted').map(item => [item.serverUserMessageId, item]));
      return source.rawItems.map(item => codexUserItem(item, source.metadata, steering)).filter(Boolean)
        .map(item => ({ id: item.nativeIds[0] || item.clientUserMessageId, i: `${state.thread}:user-message:${item.clientUserMessageId}`, nativeIds: item.nativeIds, t: item.message }));
    });
  };
  const codexSendState = (draft = false, thread, afterTurn = null) => {
    const state = codexReceiptState(thread);
    const turnCount = state.entries.length;
    const from = afterTurn === null ? Math.max(0, state.entries.length - 2) : state.entries.findIndex(entry => entry.turnId === afterTurn);
    state.entries = state.entries.slice(Math.max(0, from));
    const runs = state.entries.flatMap(entry => {
      const turn = entry.nativeTurn;
      if (!turn?.turnId || turn.pendingUserMessageAdmission || !Number.isFinite(turn.turnStartedAtMs) || !turn.params?.clientUserMessageId) return [];
      return [{ id: turn.turnId, i: `${state.thread}:user-message:${turn.params.clientUserMessageId}`,
        nativeIds: [turn.turnId, turn.params.clientUserMessageId], startedAt: turn.turnStartedAtMs,
        t: codexUserText(turn.params.input || []) }];
    });
    const result = { thread: state.thread, turnCount, lastTurn: state.entries.at(-1)?.turnId || '', runs, messages: codexReceiptRows(state, 0), queued: codexQueued(true, state) };
    if (draft) {
      const editor = codexPromptEl();
      const props = codexComposerProps(editor, state.thread);
      result.draft = props ? codexPromptText() || '' : '';
      result.payload = props?.find(p => p.composerController)?.composerController.getText() ?? null;
      result.hasDraftAttachments = props?.some(p => p.hasVisibleAttachments === true) ?? false;
      result.follow = codexQueryClient()?.getQueryData(['vscode', 'get-settings'])?.values?.followUpQueueMode || 'queue';
    }
    return result;
  };
  const waitCodexReceipt = (before, expected, queueExpected, hasAttachments, timeout = 5000) => new Promise(resolve => {
    const messages = new Set(before.messages.map(item => item.id)), queues = new Set(before.queued.map(item => item.id));
    const win = doc.defaultView;
    let finished = false, pending = false;
    const finish = result => {
      if (finished) return;
      finished = true; clearTimeout(timer); win.removeEventListener('remote-agent-chat-update', changed); resolve(result);
    };
    const check = () => {
      if (finished) return;
      const after = codexSendState();
      if (before.thread && after.thread !== before.thread) return finish(null);
      const accepted = after.messages.filter(item => !messages.has(item.id) && !item.nativeIds?.some(id => queues.has(id)) && (expected ? item.t.trim() === expected : hasAttachments));
      const queued = after.queued.filter(item => !queues.has(item.id) && (queueExpected ? item.t.trim() === queueExpected : hasAttachments));
      if (accepted.length + queued.length === 1) finish(queued.length
        ? { queued: true, queueId: queued[0].id, ...(queued[0].messageId ? { messageId: queued[0].messageId } : {}) }
        : { queued: false, messageId: accepted[0].i });
    };
    const changed = () => { if (!pending) { pending = true; queueMicrotask(() => { pending = false; check(); }); } };
    const timer = setTimeout(() => { check(); finish(null); }, timeout);
    win.addEventListener('remote-agent-chat-update', changed);
    check();
  });
  const mergeCodexCapacity = (items, state, capacity, page = true) => {
    const capacityTurn = capacity?._turnKey && state?.entries.find(entry => entry.turnKey === capacity._turnKey);
    const capacityHost = capacityTurn && items.find(item => item.capacity && Math.floor(item.order / 10000) === capacityTurn.turnNumber);
    if (capacity) {
      delete capacity._retry; delete capacity._turnKey;
      if (page && capacityHost) {
        const { i, order } = capacityHost;
        Object.assign(capacityHost, capacity, { i, order });
      } else if (!capacityHost) {
        capacity.order = Math.max(0, ...items.map(item => item.order || 0)) + 1;
        items.push(capacity);
      }
    }
  };
