  const activeThread = () => {
    const glass = [...doc.querySelectorAll('[data-glass-agent-id]')].filter(vis);
    // Cursor's composer provider keeps a stale 'focused' composer; the sidebar's data-active row is the selected one.
    const cursorSel = [...doc.querySelectorAll('[data-sidebar-item-key^="row:"]')].find(r => r.querySelector('[data-active="true"]'))?.getAttribute('data-sidebar-item-key').slice(4);
    return codexThread() || (devinSurface() ? devinSession()?.key : '') || (glass.length === 1 ? glass[0].getAttribute('data-glass-agent-id') : '') || cursorSel || window.__SSG_COMPOSER_PROVIDER__?.getStates?.().find(c => c.state === 'focused')?.id || agentList().find(a => a.current)?.id || '';
  };
  const codexTurnData = el => codexFiberProps(el.querySelector('[class*="agent-activity"]') || el.querySelector('button[aria-expanded]') || el, 40).find(p => p.turn)?.turn;
  // Current Codex list entries keep only IDs; their live items remain in the history atoms.
  const codexHistoryScopes = () => new Set(codexRootProps().flatMap(p => typeof p.value?.values === 'function' ? [...p.value.values()] : []).filter(v => v?.familyBindings));
  const codexHistoryBinding = (scope, binding) => {
    const ref = binding?.value;
    if (typeof ref?.get === 'function' && typeof ref.subscribe === 'function')
      return { key: ref, get: () => ref.get(), subscribe: changed => ref.subscribe(changed) };
    if (!ref) return null;
    for (let owner = scope; owner; owner = owner.parent) {
      const atom = owner.cachedBindings?.get(ref) || owner.signalBindings?.get(ref);
      if (!atom?.read) continue;
      const store = owner.store;
      return { key: atom, get: () => store.get(atom), subscribe: changed => store.sub(atom, changed) };
    }
    return null;
  };
  const codexConversationManager = (thread, scopes, host = null) => {
    const managers = doc.defaultView.__remoteAgentCodexManagers ||= new WeakMap();
    const matches = manager => manager && !manager.disposed && (host == null ? manager.getConversation(thread) : manager.hostId === host);
    for (const scope of scopes) {
      const manager = managers.get(scope);
      if (matches(manager)) return manager;
    }
    let manager = null, owner;
    for (const scope of scopes) for (const bindings of scope.familyBindings.values()) for (const binding of bindings.values()) {
      const value = codexHistoryBinding(scope, binding)?.get();
      if (typeof value?.loadOlderConversationTurnsPage === 'function' && matches(value)) {
        manager = value;
        owner = scope;
      }
    }
    if (manager) managers.set(owner, manager);
    return manager;
  };
  const codexHistoryState = (conversation = null, watchItems = true, scopes = codexHistoryScopes(), thread = codexThread()) => {
    const hostId = remoteContext?.app === 'codex' ? remoteContext.host || 'local' : codexChatRows(true).find(row => row.id === thread)?.host || 'local';
    const key = JSON.stringify({ hostId, threadId: thread });
    let index = null, hasLoadedOldest, nativeReader, nativeTurns;
    const atoms = new Map(), turns = new Map(), queued = new Map();
    for (const scope of scopes) for (const bindings of scope.familyBindings.values()) {
      const source = codexHistoryBinding(scope, bindings.get(key));
      const value = source?.get();
      if (Array.isArray(value) && value.some(turn => turn?.entityKey && turn.turnId)) index ||= value;
      for (const [name, binding] of bindings) if (typeof name === 'string' && thread && name.includes(thread)) {
        const source = codexHistoryBinding(scope, binding);
        if (!source) continue;
        atoms.set(source.key, source);
        const value = source.get();
        if (typeof value?.turnsPagination?.hasLoadedOldest === 'boolean') hasLoadedOldest = value.turnsPagination.hasLoadedOldest;
        for (const turn of value?.conversationTurns || []) if (turn.turnId && Array.isArray(turn.items)) turns.set(turn.turnId, turn);
        for (const entry of value?.visibleTurnEntries || []) if (entry.turnId && Array.isArray(entry.turn?.items)) turns.set(entry.turnId, entry.turn);
        if (Array.isArray(value)) for (const item of value) {
          const clientUserMessageId = item?.clientUserMessageId || item?.submissionOptions?.clientUserMessageId;
          if (typeof item?.id === 'string' && typeof item.text === 'string' && typeof clientUserMessageId === 'string' && clientUserMessageId)
            queued.set(item.id, { ...item, clientUserMessageId });
        }
      }
    }
    if (conversation) {
      nativeReader = (remoteContext?.app === 'codex' ? codexNativeManager() : codexConversationManager(thread, scopes))?.threadStore?.stateReaders;
      const wrapped = conversation.turnHistory?.kind === 'canonical';
      // Current native RPC conversations expose canonical history directly,
      // including background threads with no mounted projection atoms.
      const history = wrapped ? conversation.turnHistory.history : conversation.id === thread ? conversation.turnHistory : null;
      if (history?.entitiesByKey && Array.isArray(history.islands)) {
        nativeTurns = history.entitiesByKey;
        const nativeIndex = history.islands.flatMap(island => island.entries || []).flatMap(entry => {
          const key = wrapped ? entry.key : entry.value, turn = nativeTurns[key];
          return turn?.turnId ? [{ entityKey: key, turnId: turn.turnId }] : [];
        });
        index = nativeIndex.length ? nativeIndex : index || [];
        hasLoadedOldest = history?.isComplete === true;
      } else {
        const identity = nativeReader?.getLegacyTurnIdentity(conversation);
        const keys = new Map((index || []).map(turn => [turn.turnId, turn.entityKey]));
        const legacyTurns = Array.isArray(conversation.turns) ? conversation.turns : [];
        const nativeIndex = legacyTurns.flatMap((turn, n) => turn?.turnId
          ? [{ entityKey: identity?.entityKeys?.[n] || keys.get(turn.turnId) || turn.turnId, turnId: turn.turnId }] : []);
        index = nativeIndex.length ? nativeIndex : index || [];
        for (const turn of legacyTurns) if (turn?.turnId) turns.set(turn.turnId, turn);
        hasLoadedOldest = conversation.turnsPagination?.hasLoadedOldest === true;
      }
    }
    // Native pages prepend turns; keep already published numbers anchored to their turn IDs.
    const histories = doc.defaultView.__remoteAgentCodexTurnNumbers ||= new Map();
    if (!histories.has(thread)) histories.set(thread, new Map());
    const numbers = histories.get(thread), anchor = (index || []).findIndex(turn => numbers.has(turn.turnId));
    const first = anchor < 0 ? 1 : numbers.get(index[anchor].turnId) - anchor;
    const entries = (index || []).map((turn, n) => {
      const turnNumber = first + n;
      numbers.set(turn.turnId, turnNumber);
      return { conversationId: thread, historyEntityKey: turn.entityKey,
        turnId: turn.turnId, turnKey: 'history-content:turn:' + turn.turnId, turnNumber,
        isLatestTurn: n === index.length - 1, turnItemIds: [], metadata: turn,
        nativeTurn: nativeReader?.getSubscribedTurn(conversation, turn.entityKey) || nativeTurns?.[turn.entityKey] || turns.get(turn.turnId) };
    });
    for (const entry of entries.slice(-2)) for (const scope of scopes) for (const bindings of scope.familyBindings.values()) {
      const source = codexHistoryBinding(scope, bindings.get(entry.historyEntityKey));
      if (!source) continue;
      const value = source.get();
      if (value?.turnId === entry.turnId || Array.isArray(value) || Array.isArray(value?.entries) && Number.isFinite(value.length)) atoms.set(source.key, source);
      if (Array.isArray(value?.entries) && Number.isFinite(value.length)) entry.turnItemIds = value.entries.map(item => item.itemId);
    }
    if (watchItems) for (const entry of entries.slice(-2)) {
      const ids = new Set([entry.turnItemIds[0], ...entry.turnItemIds.slice(-400)]);
      for (const scope of scopes) for (const bindings of scope.familyBindings.values()) for (const id of ids) {
        const source = codexHistoryBinding(scope, bindings.get(JSON.stringify([entry.historyEntityKey, id])));
        if (source) atoms.set(source.key, source);
      }
    }
    return { thread, scopes, entries, atoms, queued: [...queued.values()], indexed: index !== null, hasLoadedOldest };
  };
  const chatRevision = () => doc.defaultView.__remoteAgentChatRevision || 0;
  const watchCodexData = changed => {
    const watchDraft = watch => {
      const input = event => {
        if (!composerTarget(doc)?.contains(event.target)) return;
        (doc.defaultView.__remoteAgentDraftEdits ||= new Map()).set(codexThread(), Date.now());
        changed();
      };
      doc.addEventListener('input', input, true);
      const stop = watch.stop;
      watch.stop = () => { doc.removeEventListener('input', input, true); stop(); };
      return watch;
    };
    if (remoteContext?.app === 'devin')
      return { stop: fusionDevinWatch(remoteContext.threadId, changed), refresh() {} };
    if (!remoteContext && devinSurface()) return devinWatch(changed);
    if (remoteContext?.app === 'codex' && codexNativeManager()) {
      const { threadId } = remoteContext, subscribed = new Map();
      let manager, stop;
      const refresh = () => {
        const current = codexNativeManager();
        if (current !== manager) {
          stop?.();
          manager = current;
          stop = manager?.addConversationCallback(threadId, changed);
        }
        const sources = manager ? codexAsyncQuestionState(threadId, manager.hostId).sources : new Map();
        for (const [key, unsubscribe] of subscribed) if (!sources.has(key)) { unsubscribe(); subscribed.delete(key); }
        for (const [key, source] of sources) if (!subscribed.has(key)) subscribed.set(key, source.subscribe(changed));
      };
      refresh();
      return watchDraft({ refresh, stop() { stop?.(); for (const unsubscribe of subscribed.values()) unsubscribe(); } });
    }
    if (remoteContext?.app === 'cursor' || !remoteContext && cursorSessionServices()) {
      const data = cursorSessionServices().data;
      let thread, subscription;
      const refresh = () => {
        const selected = remoteContext?.threadId || activeThread();
        if (selected === thread) return;
        subscription?.dispose();
        thread = selected;
        subscription = thread ? data.loadedComposers.subscribe(thread, changed) : null;
      };
      refresh();
      return { stop: () => subscription?.dispose(), refresh };
    }
    const subscribed = new Map();
    const update = () => changed();
    const refresh = () => {
      const state = codexHistoryState(), wanted = new Map();
      if (state.thread) {
        const manager = codexNativeManager();
        const host = manager?.hostId || codexRequestHost();
        if (manager) wanted.set('requests:' + host + ':' + state.thread, () => manager.addConversationCallback(state.thread, update));
        if (manager || codexConnectedRpc(host, state.scopes)) for (const [key, source] of codexAsyncQuestionState(state.thread, host).sources)
          wanted.set(key, () => source.subscribe(update));
      }
      for (const [key, source] of state.atoms) wanted.set(key, () => source.subscribe(update));
      for (const scope of state.scopes) if (scope.contextVersionAtom && typeof scope.store?.sub === 'function')
        wanted.set(scope, () => scope.store.sub(scope.contextVersionAtom, update));
      const cache = codexQueryClient()?.getQueryCache();
      if (cache) wanted.set(cache, () => cache.subscribe(event => {
        const key = JSON.stringify(event.query?.queryKey || []);
        if (key.includes(state.thread) || key.includes('queued-follow-ups') || key.includes('recent-conversations-meta')) update();
      }));
      for (const [source, stop] of subscribed) if (!wanted.has(source)) { stop(); subscribed.delete(source); }
      for (const [source, start] of wanted) if (!subscribed.has(source)) subscribed.set(source, start());
    };
    refresh();
    return watchDraft({ refresh, stop() { for (const stop of subscribed.values()) stop(); subscribed.clear(); } });
  };
  const codexUserText = content => {
    const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    const wrapper = /^# Context from my IDE setup:\r?\n(?=[\s\S]*^## (?:Active file|Open tabs|Active selection of the file):)[\s\S]*?^## My request:\r?\n/m.exec(text);
    return wrapper?.index === 0 ? text.slice(wrapper[0].length).replace(/\r?\n$/, '') : text;
  };
  const codexTurnSource = (entry, scopes, usersOnly = false, range = null) => {
    if (!entry.historyEntityKey) return null;
    const itemKey = id => JSON.stringify([entry.historyEntityKey, id]);
    let metadata = entry.nativeTurn, itemBindings, slots, itemTypes = [], matchedItems = 0;
    const nativeItems = new Map((entry.nativeTurn?.items || []).map(item => [item.id, item]));
    for (const scope of scopes) for (const bindings of scope.familyBindings.values()) {
      const atom = bindings.get(entry.historyEntityKey)?.value;
      const value = typeof atom?.get === 'function' ? atom.get() : null;
      if (!metadata && value?.turnId === entry.turnId) metadata = value;
      if (Array.isArray(value) && value.some(item => item?.itemId && item.type)) itemTypes = value;
      if (Array.isArray(value?.entries) && Number.isFinite(value.length)) slots = value;
    }
    if (!metadata) return null;
    const types = new Map(itemTypes.map(item => [item.itemId, item.type]));
    const nativeOrder = [...nativeItems.keys()];
    const nativeComplete = nativeOrder.length > 0 && (!slots || nativeOrder.length === slots.length
      && slots.entries.every(slot => nativeOrder[slot.index] === slot.itemId));
    let ids = nativeComplete ? nativeOrder : slots ? [...slots.entries].sort((a, b) => a.index - b.index).map(e => e.itemId) : entry.turnItemIds || [];
    const pagination = metadata.itemsPagination;
    const input = pagination?.oldestUserInput ?? metadata.params?.input;
    const clientId = pagination?.oldestUserInput == null ? metadata.params?.clientUserMessageId : pagination.openingUserMessageClientId;
    const openingId = pagination?.openingUserMessageId || clientId;
    // Codex stores the opening input separately from the visible item slots.
    const opening = openingId && input?.length && !metadata.pendingUserMessageAdmission && !ids.includes(openingId)
      && ![...nativeItems.values()].some(item => item.type === 'userMessage' && clientId && item.clientId === clientId);
    const offset = opening ? 1 : 0;
    const positions = new Map(nativeComplete || !slots ? ids.map((id, index) => [id, index + offset])
      : slots.entries.map(slot => [slot.itemId, slot.index + offset]));
    if (opening) {
      positions.set(openingId, 0);
      types.set(openingId, 'userMessage');
      ids = [openingId, ...ids];
    }
    const selected = usersOnly ? ids.filter(id => {
      const type = nativeItems.get(id)?.type || types.get(id);
      return !type || ['userMessage', 'steeringUserMessage', 'steered'].includes(type);
    }) : range ? ids.filter(id => positions.get(id) < range.before).slice(-range.limit) : ids;
    for (const scope of scopes) for (const bindings of scope.familyBindings.values()) {
      const count = selected.filter(id => bindings.get(itemKey(id))?.value?.get?.()?.id === id).length;
      if (count > matchedItems) { itemBindings = bindings; matchedItems = count; }
    }
    const readItem = id => {
      const native = nativeItems.get(id) || itemBindings?.get(itemKey(id))?.value?.get();
      return native || (id === openingId && input?.length ? { type: 'userMessage', id, clientId, content: input } : null);
    };
    const rawItems = selected.map(readItem);
    const userItems = range ? ids.filter(id => ['userMessage', 'steeringUserMessage', 'steered'].includes(nativeItems.get(id)?.type || types.get(id))).map(readItem).filter(Boolean) : [];
    return { metadata, rawItems, userItems, positions, nativeComplete, slots, ids, selected, offset };
  };
  const codexUserItem = (item, metadata, steering) => {
    if (!item) return null;
    const user = item.type === 'userMessage' ? item : item.type === 'steered' ? steering.get(item.id) : null;
    if (!user) return null;
    const content = user.type === 'steeringUserMessage' ? user.input || [] : user.content || [];
    return { type: 'user-message', clientUserMessageId: user.clientUserMessageId || user.clientId || user.id,
      nativeIds: [...new Set([item.id, user.id, user.clientId, user.clientUserMessageId, user.serverUserMessageId, user.serverClientUserMessageId].filter(Boolean))],
      message: codexUserText(content), nativeInput: codexInputKey(content) === null ? null : content,
      images: content.filter(c => c.type === 'image' || c.type === 'localImage'),
      attachments: user.attachments || [], sentAtMs: user.targetTurnStartedAtMs || metadata.turnStartedAtMs };
  };
  const codexStoredTurn = (entry, scopes = codexHistoryScopes(), patchesOnly = false, source = codexTurnSource(entry, scopes)) => {
    if (!source) return null;
    const { metadata, rawItems, positions, nativeComplete, slots, ids } = source;
    const complete = metadata.status === 'complete' || metadata.status === 'completed';
    let availableItems = 0;
    const steering = new Map([...(source.userItems || []), ...rawItems].filter(item => item?.type === 'steeringUserMessage' && item.status === 'accepted')
      .map(item => [item.serverUserMessageId, item]));
    const items = rawItems.flatMap(item => {
      if (!item) return [];
      availableItems++;
      if (patchesOnly && item.type !== 'fileChange') return [];
      const id = item.id;
      const done = complete || !!metadata.agentMessageCompletedAtMsById?.[id];
      const user = codexUserItem(item, metadata, steering);
      if (user) return user;
      if (item.type === 'agentMessage') return { type: 'assistant-message', responseAnnotationTargetId: item.id, content: item.text, phase: item.phase, completed: done };
      if (item.type === 'reasoning') return { type: 'reasoning', id: item.id, content: [...(item.summary || []), ...(item.content || [])].map(t => typeof t === 'string' ? t : t.text || '').join('\n'), completed: complete };
      if (item.type === 'commandExecution') return { type: 'exec', callId: item.id, cmd: [item.command], executionStatus: item.status,
        output: { aggregatedOutput: item.aggregatedOutput, exitCode: item.exitCode } };
      if (item.type === 'fileChange') return { type: 'patch', callId: item.id, executionStatus: item.status, changes: Object.fromEntries((item.changes || []).map(c => [c.path, c])) };
      if (item.type === 'plan') return { type: 'assistant-message', responseAnnotationTargetId: item.id, content: item.text || '', completed: done };
      if (item.type === 'todo-list') return item;
      if (item.type === 'mcpToolCall') return { ...item, type: 'mcp-tool-call' };
      if (item.type === 'dynamicToolCall') return { ...item, type: 'dynamic-tool-call' };
      if (item.type === 'collabAgentToolCall') return item;
      if (item.type === 'webSearch') return { type: 'web-search', id: item.id, query: item.query };
      if (item.type === 'imageView') return { type: 'generated-image', id: item.id, path: item.path };
      if (item.type === 'contextCompaction') return { type: 'context-compaction', id: item.id, source: item.source, status: complete ? 'completed' : 'inProgress' };
      return [];
    }).map(item => ({ ...item, sourceIndex: positions.get(item.callId || item.responseAnnotationTargetId || item.id || item.nativeIds?.[0]) }));
    if (!patchesOnly && CAPACITY_ERROR.test(metadata.error?.message || '')) items.push({
      type: 'system-error', id: entry.turnId + ':error', content: metadata.error.message,
      sourceIndex: slots ? slots.length + source.offset : ids.length,
    });
    const partial = !nativeComplete && slots && (slots.entries.length < slots.length || availableItems < slots.entries.length + source.offset);
    items.push({ type: 'worked-for', startedAtMs: metadata.turnStartedAtMs,
      completedAtMs: complete && Number.isFinite(metadata.durationMs) ? metadata.turnStartedAtMs + metadata.durationMs : null });
    return { status: complete ? 'complete' : metadata.status, items, partial };
  };
  const codexLatestEntry = el => {
    const state = codexHistoryState(), latest = state.entries.at(-1);
    const stored = latest && codexStoredTurn(latest, state.scopes);
    if (stored) return { ...latest, turn: stored };
    if (!el) return null;
    const props = codexFiberProps(el, 32);
    const thread = codexThread();
    const entry = props.find(p => p.entry?.isLatestTurn && p.entry.conversationId === thread)?.entry
      || props.find(p => Array.isArray(p.entries))?.entries.find(e => e.isLatestTurn && e.conversationId === thread);
    if (!entry) return null;
    if (entry.turn || entry.turnKey === el.getAttribute('data-turn-key')) return entry;
    const turn = codexStoredTurn(entry);
    return turn ? { ...entry, turn } : entry;
  };
  const codexFusionTurn = async (id = '', attemptId = '', previous = [], generationId = '') => {
    if (remoteContext?.app === 'devin') return fusionDevinTurn(remoteContext.threadId, id, generationId, remoteContext.fusionController ? '' : attemptId);
    if (remoteContext && remoteContext.app !== 'codex' || !codexThread()) {
      const threadId = remoteContext?.threadId || activeThread();
      if (devinSurface()) {
        const messages = devinMessages(threadId);
        const body = item => (item.content || []).filter(block => block.content?.type === 'text').map(block => block.content.text).join('\n');
        const users = messages.filter(item => item.kind === 'user_message' && !item.content?.some(block => block._meta?.['cognition.ai/isOptimistic']));
        const user = id ? users.find(item => item.id === id) : attemptId ? users.findLast(item => !previous.includes(item.id) && body(item).includes(attemptId)) : users.at(-1);
        const start = messages.indexOf(user), tail = start >= 0 ? messages.slice(start + 1) : [];
        const next = tail.findIndex(item => item.kind === 'user_message');
        const reply = (next < 0 ? tail : tail.slice(0, next)).findLast(item => item.kind === 'agent_message');
        const requests = Object.values(devinAgentRequests(threadId)).filter(request => request.method === 'session/prompt' && request.params?.sessionId === threadId);
        const request = remoteContext && generationId
          ? Object.entries(devinAgentRequests(threadId)).find(([key, request]) => key === generationId && requests.includes(request))?.[1]
          : requests.findLast(request => request.params?.prompt?.some?.(block => attemptId && block.text?.includes(attemptId)));
        const session = devinSessionRecord(threadId);
        const failed = remoteContext?.app === 'devin' && request?.status === 'failed';
        return { id: user?.id || '', ids: users.map(item => item.id), turnId: request?.id || user?.id || '', threadId, current: !!user && user === users.at(-1),
          text: reply ? body(reply) : '', completed: !!reply && request?.status === 'completed' && (remoteContext ? true : !['active', 'pending', 'canceling', 'unknown_error'].includes(session?.status)),
          ended: failed || request?.status === 'completed' && (remoteContext ? true : !['active', 'pending', 'canceling', 'unknown_error'].includes(session?.status)),
          error: failed ? request.errorMessage : session?.status === 'unknown_error' ? devinItems(devinLog()).find(item => item.kind === 'error')?.t || 'Devin 原生 unknown_error' : '', items: [] };
      }
      const service = cursorSessionServices()?.data;
      if (!service || !threadId) return { id: '', ids: [], threadId, text: '', completed: false };
      const peek = await service.composerDataHandleManager.peekComposerData(threadId);
      const data = peek?.source === 'memory' ? peek.handle.data : peek?.data;
      if (data?.composerId !== threadId) return { id: '', ids: [], threadId, text: '', completed: false };
      const headers = data?.fullConversationHeadersOnly || [];
      const users = headers.filter(header => header.type === 1);
      const load = async header => {
        const cached = data.conversationMap[header.bubbleId];
        if (cached && !cached.isPlaceholder) return cached;
        return (await service._composerMessageStorageService.retrieveMessagesBatch(threadId, [header.bubbleId])).get(header.bubbleId);
      };
      const accepted = (header, message) => header && message?.bubbleId === header.bubbleId && message.type === 1
        && !message.isPlaceholder && !message.isOptimistic && !message.isSteer && !message.isSimulatedMsg && !message.isDisplayOnly;
      let user = id ? users.find(header => header.bubbleId === id) : attemptId ? null : users.at(-1);
      if (!id && attemptId) for (const header of users.filter(header => !previous.includes(header.bubbleId)).reverse()) {
        const message = await load(header);
        if (accepted(header, message) && message.text?.includes(attemptId)) { user = header; break; }
      }
      const acceptedUser = user ? await load(user) : null;
      const nativeGeneration = acceptedUser?.requestId || '';
      const wrongGeneration = !!generationId && !!nativeGeneration && generationId !== nativeGeneration;
      const later = users.slice(users.indexOf(user) + 1);
      let supersededBy;
      if (accepted(user, acceptedUser) && !wrongGeneration) for (const header of later) {
        const message = await load(header);
        if (accepted(header, message) && message.requestId && message.requestId !== (nativeGeneration || generationId)) {
          supersededBy = { messageId: message.bubbleId, generationId: message.requestId };
          break;
        }
      }
      const start = headers.indexOf(user), end = later.length ? headers.indexOf(later[0]) : headers.length;
      const messages = start < 0 || supersededBy ? [] : await Promise.all(headers.slice(start + 1, end).filter(header => header.type === 2).map(load));
      const final = messages.findLast(item => item?.text?.trim() && !item.toolFormerData && !item.thinking);
      // The memory handle can change while a bubble is fetched. Use its current selection for live status.
      const live = peek?.source === 'memory' ? peek.handle.data : data;
      const latestGeneration = live.latestChatGenerationUUID || '';
      const liveHeaders = live.fullConversationHeadersOnly || [];
      const latestUser = liveHeaders.findLast(header => header.type === 1);
      const status = live.status;
      const matches = accepted(user, acceptedUser) && !wrongGeneration;
      const current = matches && !!latestGeneration && latestUser?.bubbleId === user.bubbleId
        && (!generationId || generationId === latestGeneration)
        && (nativeGeneration === latestGeneration || !nativeGeneration && status !== 'generating');
      const nativeAbort = !user && !!id && !!generationId && latestGeneration === generationId && status === 'aborted';
      if (supersededBy) {
        const before = liveHeaders.findIndex(header => header.type === 1 && header.bubbleId === user.bubbleId);
        const after = liveHeaders.findIndex(header => header.type === 1 && header.bubbleId === supersededBy.messageId);
        const expected = nativeGeneration || generationId;
        if (before < 0 || after <= before || expected && (latestGeneration === expected || live.chatGenerationUUID === expected))
          supersededBy = undefined;
      }
      const messageId = matches ? user.bubbleId : nativeAbort ? id : '';
      const ended = !!supersededBy || (nativeAbort || current && ['completed', 'aborted'].includes(status)) && (remoteContext || !isBusy());
      return { id: messageId, ids: users.map(header => header.bubbleId), turnId: messageId, threadId,
        accepted: matches && !!(nativeGeneration || current), user: acceptedUser?.text || '',
        generationId: current || nativeAbort ? latestGeneration : nativeGeneration, current: current || nativeAbort,
        ...(supersededBy ? { supersededBy } : {}),
        ...(remoteContext?.app === 'cursor' && current ? { settings: {
          ...cursorFusionSettings(threadId), nativeModel: acceptedUser.modelInfo?.modelName || '',
        } } : {}),
        text: final?.text || '', completed: !!(ended && current && final && status === 'completed'), ended: !!ended,
        error: (current || nativeAbort) && status === 'aborted' ? `Cursor 原生执行已中断：${live.abortReason || '原因未知'}` : '', items: [] };
    }
    const scoped = remoteContext?.app === 'codex';
    const scopes = scoped ? codexHistoryScopes() : null;
    const client = scoped && (codexConversationManager(remoteContext.threadId, scopes, remoteContext.host || 'local')
      || codexConnectedRpc(remoteContext.host || 'local', scopes));
    const conversation = scoped && client ? await codexRpcCall(client, 'getConversation', remoteContext.threadId) : null;
    if (scoped && !conversation) return { id: '', ids: [], threadId: remoteContext.threadId, text: '', completed: false };
    const state = scoped ? codexHistoryState(conversation, false, scopes, remoteContext.threadId) : codexHistoryState();
    const rows = scoped && codexVisibleThread() !== state.thread ? [] : [...doc.querySelectorAll('[data-turn-key]')];
    const entries = new Map(state.entries.map(entry => {
      const el = rows.find(e => e.getAttribute('data-turn-key') === entry.turnKey);
      const turn = codexStoredTurn(entry, state.scopes) || (el && codexTurnData(el));
      return [entry.turnId, { el, entry: { ...entry, turn } }];
    }));
    let latest = state.entries.at(-1)?.turnId;
    for (const el of rows) {
      const entry = codexFiberProps(el, 40).find(p => p.entry?.conversationId === state.thread && p.entry.turnId)?.entry;
      if (!entry) continue;
      if (!entries.has(entry.turnId)) entries.set(entry.turnId, { el, entry: { ...entry, turn: codexTurnData(el) } });
      if (entry.isLatestTurn) latest = entry.turnId;
    }
    const users = found => (found.entry.turn?.items || []).filter(it => it.type === 'user-message');
    const matches = it => id ? it.clientUserMessageId === id || it.nativeIds?.includes(id) || id === `${state.thread}:user-message:${it.clientUserMessageId}`
      : !!attemptId && String(it.message || '').includes(attemptId) && !previous.includes(it.clientUserMessageId);
    const found = id || attemptId ? [...entries.values()].reverse().find(found => users(found).some(matches)) : entries.get(latest);
    const turn = found?.entry.turn;
    const user = found && (id || attemptId ? users(found).find(matches) : users(found).at(-1));
    const reply = turn?.items?.filter(it => it.type === 'assistant-message' && it.phase !== 'commentary').at(-1);
    const ended = ['complete', 'completed', 'interrupted', 'failed'].includes(turn?.status);
    const active = turn?.status === 'inProgress' && found?.entry.nativeTurn?.pendingUserMessageAdmission !== true;
    const userSource = active && turn.partial ? codexTurnSource(found.entry, state.scopes, true) : null;
    const completeUsers = userSource?.slots?.entries.length === userSource?.slots?.length
      && userSource?.rawItems.every(Boolean) && !userSource.metadata.pendingUserMessageAdmission;
    const error = found?.entry.nativeTurn?.error?.message || turn?.items?.find(item => item.type === 'system-error')?.content
      || (turn?.status === 'interrupted' ? 'Codex 原生执行已中断' : turn?.status === 'failed' ? 'Codex 原生执行失败' : '');
    return { id: user?.clientUserMessageId || '', ids: [...entries.values()].flatMap(found => users(found).map(it => it.clientUserMessageId)).filter(Boolean),
      turnId: found?.entry.turnId || '', threadId: state.thread,
      current: !!found && !!turn && !!user && (!turn.partial || completeUsers) && found.entry.turnId === latest && user === users(found).at(-1),
      nativeIds: user?.nativeIds || [], lastUserId: found ? users(found).at(-1)?.clientUserMessageId || '' : '',
      user: user?.message || '', nativeInput: user?.nativeInput || null, text: reply?.content || '',
      accepted: !!user && codexSendState(false, state.thread).runs.some(value => value.id === found?.entry.turnId),
      active, ended, interrupted: turn?.status === 'interrupted',
      completed: ['complete', 'completed'].includes(turn?.status) && !!reply?.completed && !error, error,
      items: turn ? codexTurnItems(found.el, found.entry) : [] };

  };
  // One Codex turn can contain several markdown blocks. Keep them in order instead of keeping only the first reply.
  const codexTurnItems = (el, entry = null, limit = 0, tools = new Set(), thread = codexThread()) => {
    const blocks = el ? [...el.querySelectorAll('[class*="MarkdownRoot"]')] : [];
    const out = [];
    const turn = entry?.turn || codexTurnData(el);
    const markdown = new Map(blocks.map(block => {
      const item = codexFiberProps(block).find(p => p.item?.type === 'assistant-message')?.item;
      return [item?.responseAnnotationTargetId, { block, content: item?.content }];
    }));
    const textOf = v => typeof v === 'string' ? v.replace(/\u00a0/g, ' ').trim() : '';
    const finished = turn?.status === 'complete';
    const source = turn?.items || [], lastReply = source.findLast(item => item.type === 'assistant-message' && item.phase !== 'commentary');
    for (const [sourceIndex, item] of source.entries()) {
      if (limit && sourceIndex < source.length - limit && item.type !== 'user-message' && item !== lastReply) { turn.partial = true; continue; }
      const start = out.length;
      const id = `${thread}:${item.type}:${item.sourceItemId || item.callId || item.responseAnnotationTargetId || item.clientUserMessageId || item.id || ''}`;
      if (item.type === 'context-compaction') {
        const automatic = item.source === 'auto' || item.source === 'automatic';
        const live = item.status === 'inProgress';
        const state = live ? '正在' : item.status === 'completed' ? '已完成' : '已中断';
        out.push({ i: id, k: 'notice', kind: 'compaction', t: `${state}${automatic ? '自动' : ''}压缩上下文`, live });
      } else if (item.type === 'reasoning') {
        const body = textOf(item.content);
        if (body) out.push({ i: id, k: 'thinking', t: `${item.completed ? 'Thoughts' : 'Thinking'}\n${body}`, live: !item.completed });
      } else if (item.type === 'user-message') {
        const imgs = Array.isArray(item.images) ? item.images.length : 0;
        const images = (item.images || []).map((image, index) => {
          const src = typeof image === 'string' ? image : image.url;
          if (!/^data:image\//.test(src || '')) return src;
          const key = `codex-image:${id}:${index}`;
          (doc.defaultView.__remoteAgentChatImages ||= new Map()).set(key, src);
          return key;
        }).filter(src => typeof src === 'string' && /^(https?:|data:image\/|blob:|codex-image:)/.test(src));
        const atts = Array.isArray(item.uploadedFileAttachments) ? item.uploadedFileAttachments.length : (Array.isArray(item.attachments) ? item.attachments.length : 0);
        let t = item.message || '';
        if (imgs) t += `${t ? '\n' : ''}[图片 ${imgs}]`;
        if (atts) t += `${t ? '\n' : ''}[附件 ${atts}]`;
        if (!t.trim() && !imgs && !atts) continue;
        const nativeIds = item.nativeIds || [item.clientUserMessageId, item.sourceItemId, item.id].filter(Boolean);
        out.push({ i: id, k: 'human', t, ...(nativeIds.length ? { nativeIds } : {}), ...(images.length ? { images } : {}), ...(item.sentAtMs ? { sentAt: item.sentAtMs } : {}) });
      } else if (item.type === 'assistant-message' && item.content) {
        const rendered = markdown.get(item.responseAnnotationTargetId);
        const block = rendered?.content === item.content ? rendered.block : null;
        if (item.phase === 'commentary') out.push({ i: id, k: 'thinking', t: `工作过程\n${item.content}`, live: !item.completed });
        else out.push({ i: id, k: 'assistant', t: item.content, completed: item.completed, htmlRead: !!block, bodyFormat: block ? 'html' : 'markdown', h: block ? clean(block) : esc(item.content).replace(/\n/g, '<br>'), ...(block ? { images: messageImages(block) } : {}) });
      } else if (item.type === 'exec') {
        const cmd = (item.cmd || []).join('\n'), details = tools.has(id);
        out.push({ i: id, k: 'tool', src: 'codex', kind: 'command', t: cmd.slice(0, 240), lazy: true, details,
          ...(details ? { cmd, output: item.output?.aggregatedOutput || '' } : {}),
          exitCode: item.output?.exitCode, status: item.executionStatus, done: finished,
          ...(item.approvalRequestId != null || ['failed', 'declined'].includes(item.executionStatus) || (item.output?.exitCode != null && item.output.exitCode !== 0) ? { keep: true } : {}) });
      } else if (item.type === 'patch') {
        const files = Object.keys(item.changes || {}), details = tools.has(id);
        const diff = details ? codexFileDiff(files.map(path => ({ ...item.changes[path], path, change: item.changes[path] }))) : null;
        out.push({ i: id, k: 'tool', src: 'codex', kind: 'edit', t: `修改 ${files.join(', ')}`.slice(0, 240), f: files[0],
          lazy: true, details, ...(details ? diff : {}),
          status: item.executionStatus, done: finished });
      } else if (item.type === 'todo-list') {
        const steps = Array.isArray(item.plan) ? item.plan : (Array.isArray(item.items) ? item.items : []);
        const tasks = steps.map(step => ({
          t: textOf(step.step || step.text || step.title).slice(0, 300),
          status: step.status === 'completed' || step.completed ? 'done' : step.status === 'in_progress' ? 'in_progress' : 'pending',
        })).filter(step => step.t);
        out.push({ i: id, k: 'tasks', done: tasks.filter(step => step.status === 'done').length, total: tasks.length, items: tasks });
      } else if (item.type === 'web-search') {
        out.push({ i: id, k: 'tool', kind: 'search', src: 'codex', t: `搜索 ${textOf(item.query)}`.trim().slice(0, 240) });
      } else if (item.type === 'mcp-tool-call' || item.type === 'dynamic-tool-call') {
        const name = textOf(item.toolName || item.name || item.server) || item.type;
        const status = textOf(item.status || item.executionStatus);
        const raw = item.result ?? item.output ?? item.content;
        const result = (typeof raw === 'string' ? raw : raw == null ? '' : JSON.stringify(raw)).slice(0, 4000);
        out.push({ i: id, k: 'tool', kind: 'other', src: 'codex', t: `${item.type === 'mcp-tool-call' ? 'MCP' : '工具'} ${name}${status ? ' · ' + status : ''}${result ? ' · ' + result : ''}`.slice(0, 4400), keep: true });
      } else if (item.type === 'generated-image' || item.type === 'chatgpt-delayed-image-gen' || item.type === 'chatgpt-delayed-image-gen-received') {
        if (!el && !item.path) continue;
        const images = item.path ? [item.path] : messageImages(el);
        out.push({ i: id, k: 'tool', kind: 'other', src: 'codex', t: item.type === 'chatgpt-delayed-image-gen' ? '正在生成图片' : '生成的图片', images, keep: true });
      } else if (item.type === 'chatgpt-tool-approval') {
        out.push({ i: id, k: 'tool', kind: 'other', src: 'codex', t: `等待批准 ${textOf(item.title)}`.trim().slice(0, 240) });
      } else if (item.type === 'collabAgentToolCall' || item.type === 'chatgpt-subagent-activity') {
        out.push({ i: id, k: 'tool', src: 'codex', kind: 'other', t: `${item.tool || '子 Agent'} · ${item.status || ''}\n${JSON.stringify(item.agentsStates || item.agents || item.receiverThreadIds || [])}`, agents: (item.receiverThreadIds || []).map(id => ({ id, title: item.agentsStates?.[id]?.nickname || id })), keep: true });
      } else if (item.type === 'stream-error' || item.type === 'system-error' && CAPACITY_ERROR.test(textOf(item.content))) {
        const body = textOf(item.content);
        if (CAPACITY_ERROR.test(body)) {
          const capacityId = `${thread}:capacity:${entry?.turnId || item.turnId || el?.getAttribute('data-turn-key') || item.id || ''}`;
          if (!out.some(row => row.i === capacityId)) out.push({ i: capacityId, k: 'notice', kind: 'capacity', t: body.slice(0, 400), capacity: true, live: !finished && entry?.isLatestTurn !== false });
        }
        else if (!finished && body) out.push({ i: id, k: 'thinking', t: `连接\n${body}`.slice(0, 400), live: true });
      } else if (item.type === 'turn-diff') {
        out.push({ i: id, k: 'tool', kind: 'other', src: 'codex', t: '文件改动' });
      } else if (item.type !== 'automatic-approval-review' && item.type !== 'worked-for') {
        const body = textOf(item.content || item.message || item.query || item.title);
        if (body) out.push({ i: id, k: 'tool', kind: 'other', src: 'codex', t: body.slice(0, 400), done: finished && /exec|patch|command/.test(item.type) });
      }
      for (const row of out.slice(start)) row.sourceIndex = item.sourceIndex ?? sourceIndex;
    }
    const fork = finished && codexForkProps(el, entry);
    const turnButtons = [
      ...(el ? buttonsIn(el, false) : []),
      ...(fork ? [{ label: fork.forkLabel }] : []),
      ...[...doc.querySelectorAll('[data-local-conversation-item-target-ids], aside')]
        .filter(card => el && card.closest('[data-turn-key]') === el && CAPACITY_ERROR.test(card.innerText || ''))
        .flatMap(card => buttonsIn(card, false)),
    ].filter(x => !RETRY_LABEL.test(x.label) || !x.el.disabled && x.el.getAttribute('aria-disabled') !== 'true')
      .map(x => x.label).filter((l, n, rows) => ( /^(Copy message|Fork chat from here|View changed files|View changes|View file changes|Undo|Open agent|View agent|View subagent|Stop agent|Apply|Revert)$/i.test(l) || RETRY_LABEL.test(l)) && rows.indexOf(l) === n);
    const finalAssistant = finished ? [...out].reverse().find(it => it.k === 'assistant' && (it.completed === true || finished)) : null;
    const capacityHost = [...out].reverse().find(it => it.capacity);
    const host = finalAssistant || capacityHost;
    if (host) {
      host.buttonsRead = !!el;
      const buttons = finalAssistant ? turnButtons.filter(label => !capacityHost || !RETRY_LABEL.test(label)) : turnButtons.filter(label => RETRY_LABEL.test(label));
      if (finalAssistant && !buttons.includes('Copy message')) buttons.unshift('Copy message');
      if (buttons.length) { host.b = buttons; host.btnItem = entry?.turnKey || el?.getAttribute('data-turn-key') || host.i; }
    }
    if (capacityHost && finalAssistant) {
      const retry = turnButtons.filter(label => RETRY_LABEL.test(label));
      if (retry.length) { capacityHost.b = retry; capacityHost.btnItem = el.getAttribute('data-turn-key'); }
    }
    const number = entry?.turnNumber ?? codexFiberProps(el, 24).find(p => p.entry?.turnNumber)?.entry.turnNumber;
    return out.map(({ sourceIndex, ...item }, index) => ({ ...item, ...(Number.isFinite(number) ? { order: number * 10000 + (sourceIndex ?? index) } : {}) }));
  };
  // Initial, live and older reads share the same native order and coverage cursor.
  // Select raw item IDs before normalizing bodies; mounted DOM only enriches this page.
  const codexReadPage = (state, before = Infinity, known = [], details = false, limit = 80) => {
    const seen = new Set(known), items = [];
    const mounted = new Map((!remoteContext || codexVisibleThread() === state.thread ? [...doc.querySelectorAll('[data-turn-key]')] : []).map(el => [el.getAttribute('data-turn-key'), el]));
    const end = Number.isFinite(before) ? before : Infinity;
    let cursor = end, visible = 0, headEntry = null, missingTurn = null, earlier = state.hasLoadedOldest === false;
    outer: for (const entry of [...state.entries].reverse()) {
      const base = entry.turnNumber * 10000;
      if (base >= end) continue;
      let upper = end - base;
      for (;;) {
        const source = codexTurnSource(entry, state.scopes, false, { before: upper, limit });
        if (!source || source.rawItems.some(item => !item)) { missingTurn = entry; earlier = true; break outer; }
        if (!source.selected.length) {
          if (upper > 0 && entry.nativeTurn?.itemsPagination?.hasLoadedOldest === false) { missingTurn = entry; earlier = true; break outer; }
        }
        const turn = codexStoredTurn(entry, state.scopes, false, source);
        const rows = codexTurnItems(mounted.get(entry.turnKey) || null, { ...entry, turn });
        for (const item of [...rows].reverse()) {
          if (item.order >= end) continue;
          if (seen.has(item.i)) { cursor = item.order; continue; }
          if (visible === limit) { earlier = true; break outer; }
          items.push(item); seen.add(item.i); cursor = item.order; headEntry = entry;
          if (details || item.k !== 'tool' || !item.done || item.keep) visible++;
        }
        const lower = source.selected.length ? Math.min(...source.selected.map(id => source.positions.get(id))) : 0;
        cursor = base + lower;
        if (lower === 0) break;
        if (visible === limit) { earlier = true; break outer; }
        upper = lower;
      }
    }
    items.reverse();
    if (headEntry && items[0].order > headEntry.turnNumber * 10000) {
      const source = codexTurnSource(headEntry, state.scopes, true);
      const turn = codexStoredTurn(headEntry, state.scopes, false, source);
      const inputs = codexTurnItems(null, { ...headEntry, turn }).filter(item => item.k === 'human' && item.order < items[0].order && !seen.has(item.i));
      items.unshift(...inputs);
    }
    // A history page carries bodies, never replayable capacity operations.
    for (const item of items) if (item.capacity) { delete item.b; delete item.actions; delete item.btnItem; }
    return { thread: state.thread, items, before: Number.isFinite(cursor) ? cursor : null, earlier, ...(missingTurn ? { missingTurn } : {}) };
  };
  const codexHistoryPage = async (before, known = [], details = false) => {
    const scopes = codexHistoryScopes(), thread = codexThread();
    const manager = codexConversationManager(thread, scopes);
    const rpc = !manager && codexConnectedRpc(codexRequestHost(), scopes);
    if (!manager && !rpc) throw new Error('没有找到 Codex 历史加载入口');
    let state;
    const pagination = manager?.pagination, loaded = new Set();
    const read = async () => {
      for (;;) {
        const conversation = manager ? manager.getConversation(thread) : await codexRpcCall(rpc, 'getConversation', thread);
        state = codexHistoryState(conversation, false, scopes, thread);
        const page = codexReadPage(state, before, known, details, 160);
        if (!page.missingTurn) return page;
        const entry = page.missingTurn;
        if (loaded.has(entry.turnId)) throw new Error('这段历史尚未载入完整，请稍后重试');
        loaded.add(entry.turnId);
        if (pagination) await pagination.itemPagination.loadTurnItems(thread, entry.turnId, true);
        else await codexRpcCall(rpc, 'loadOlderConversationTurnsPage', thread, { turnId: entry.turnId });
      }
    };
    let page = await read();
    if (!page.items.length && state.hasLoadedOldest === false) {
      if (pagination) {
        await pagination.conversationTurnsLoads.get(thread)?.promise;
        await pagination.loadConversationTurns(thread, false, pagination.client.isCloudHost || manager.getConversation(thread).boundedCloudHistory === true ? 'summary' : undefined);
      } else await codexRpcCall(rpc, 'loadOlderConversationTurnsPage', thread);
      page = await read();
    }
    return page;
  };
