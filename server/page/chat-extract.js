  const extract = (history = false, knownTurns = [], pageSize = 0, nativeCursor = false) => {
    if (nativeCursor) return cursorCurrentChat(extract(history, knownTurns), pageSize || 120);
    if (remoteContext?.app === 'codex') return codexConversationChat(history, pageSize || 120);
    if (remoteContext) return nativeConversationChat(history, pageSize || 120);
    const imagePreview = codexImagePreview();
    const log = devinLog();
    const devinThread = log && (devinNodeSessionId(log) || activeThread());
    const devinData = devinThread && devinSessionData(devinThread);
    const devinPage = devinData?.messages.length ? devinHistoryPage(devinMessages(devinThread, devinData), 120) : null;
    const panel = log || (devinSurface() ? null : findPanel());
    const scopes = pageSize && !log && !devinSurface() ? codexHistoryScopes() : null;
    const manager = scopes ? codexConversationManager(codexThread(), scopes) : null;
    const state = scopes ? codexHistoryState(manager?.getConversation(codexThread()) || null, false, scopes)
      : !log && !devinSurface() ? codexHistoryState() : null;
    const page = pageSize && state?.indexed ? codexReadPage(state, Infinity, [], false, pageSize) : null;
    if (page?.missingTurn && !page.items.length && state.entries.length) return null;
    const initialCapacity = !panel && !log ? codexCapacityItem() : null;
    const known = new Set(knownTurns);
    const nativeTail = (page ? [] : state?.entries.slice(-32) || []).filter(entry => entry.isLatestTurn
      || entry.turnNumber >= state.entries.at(-1).turnNumber - 1 || !known.has(entry.turnId)).flatMap(entry => {
      const turn = codexStoredTurn(entry, state.scopes);
      return turn ? [{ ...entry, turn }] : [];
    }) || [];
    // A brand-new Devin session has a composer and model chip, but no message list yet.
    if (!panel && !log && !initialCapacity && !nativeTail.length && !page?.items.length) {
      const pendingCodexRequests = !devinSurface() ? codexRequestData() : [];
      const modelEl = modelButton();
      const home = !hasComposer() && !activeThread() && (codexQueryClient() ? !!agentStartupState('codex') : agentList().length > 0);
      if (!modelEl && !hasComposer() && !home && !devinSurface() && !doc.querySelector('[data-request-input-dismiss]')) return null;
      return {
        _revision: chatRevision(), rect: [0, 0, 0, 0],
        items: [],
        capacityPresent: false,
        ...(imagePreview ? { imagePreview: true } : {}),
        ...(devinSurface() || home ? { empty: true } : {}),
        global: [],
        busy: isBusy(),
        queued: queued(),
        subagents: subagents(),
        changed: changedCount(),
        questions: codexThread() ? { codex: true, requests: codexRequestData() } : pendingCodexRequests.length ? { codex: true, requests: pendingCodexRequests } : null,
        ...(devinSurface() ? { session: devinSession(), workdir: workdirInfo() } : {}),
        readonly: !hasComposer(),
        mode: devinSurface() && activeThread() ? nativeSessionInfo('devin', activeThread(), 'mode').items.find(item => item.checked)?.label || null
          : devinModeChip()?.innerText.trim() || CONTROLS.mode()?.innerText.trim() || null,
        ...(devinSurface() ? { surface: devinSurface() } : {}),
        model: agentModelName(),
        permission: permissionLabel(), effort: effortName(),
        thread: activeThread(),
        title: agentState()?.title || '',
        context: contextPct(),
        draft: composerDraft(),
        ...(codexFacts()?.view ? { codex: codexFacts().view } : {}),
      };
    }
    if (!panel && !log && initialCapacity && !nativeTail.length && !page?.items.length) {
      delete initialCapacity._retry;
      delete initialCapacity._turnKey;
      return {
        _revision: chatRevision(), rect: [0, 0, 0, 0], items: [initialCapacity], global: [], busy: isBusy(), queued: queued(),
        subagents: subagents(), changed: changedCount(), questions: { codex: true, requests: codexRequestData() },
        readonly: !hasComposer(), model: agentModelName(), permission: permissionLabel(), effort: effortName(),
        capacityPresent: true, thread: activeThread(),
        ...(imagePreview ? { imagePreview: true } : {}), ...(codexFacts()?.view ? { codex: codexFacts().view } : {}),
      };
    }
    const r = (log || panel)?.getBoundingClientRect() || { x: 0, y: 0, width: 0, height: 0 };
    const partialTurns = new Set(), completeTurns = new Set(), completedIds = new Map();
    const collect = (el, entry) => {
      const turn = entry?.turn;
      const incomplete = turn?.partial;
      const rows = codexTurnItems(el, entry, history ? 0 : 400);
      const number = entry?.turnNumber;
      if (Number.isFinite(number)) (turn?.partial ? partialTurns : completeTurns).add(number);
      if (entry?.turnId && turn?.status === 'complete' && !incomplete) completedIds.set(entry.turnId, number);
      return rows;
    };
    const codexId = log ? '' : codexThread();
    const pendingCodexRequests = !log && !devinSurface() && !codexId ? codexRequestData() : null;
    const bubbleTimes = (!log && !codexId) ? cursorBubbleTimes() : null;
    const items = page ? page.items : log ? devinItems(log, devinPage) : (panel ? topItems(panel) : []).flatMap(el => {
      if (el.hasAttribute?.('data-turn-key')) {
        const key = el.getAttribute('data-turn-key');
        const entry = state?.entries.find(entry => entry.turnKey === key);
        const stored = entry && codexStoredTurn(entry, state.scopes);
        const visible = codexTurnData(el);
        const keyOf = item => `${item.type}:${item.sourceItemId || item.callId || item.responseAnnotationTargetId || item.clientUserMessageId || item.id || ''}`;
        const combined = new Map((visible?.items || []).map(item => [keyOf(item), item]));
        for (const item of stored?.items || []) combined.set(keyOf(item), { ...combined.get(keyOf(item)), ...item });
        const turn = stored ? { ...visible, ...stored, items: [...combined.values()] } : visible;
        return collect(el, entry ? { ...entry, turn } : null);
      }
      const thoughts = thinkingInside(el).map((th, n) => thinkingItem(th, el, n));
      if (isThinking(el)) return thoughts.length ? thoughts : [thinkingItem(el, el, 0)];
      const main = messageItem(el);
      if (main.k === 'human' && !main.sentAt && bubbleTimes) {
        const at = bubbleTimes.byId.get(el.dataset.messageId || el.querySelector('[data-message-id]')?.dataset.messageId || '');
        if (at) main.sentAt = at;
      }
      if (main.k === 'assistant' && !main.h && !main.b) return thoughts;
      return [...thoughts, ...(main.k === 'tool' ? cursorToolItems(el) : [main])];
    });
    const capacity = codexCapacityItem();
    const global = (panel ? buttonsIn(panel, true) : []).filter(x => !inItem(x.el) && !inQn(x.el) && x.el !== capacity?._retry && !x.el.hasAttribute('data-request-input-dismiss') && !/^stop generation\b/i.test(x.label)
      && !(panel?.querySelector('[data-turn-key]') && /^(stop|stop generating|停止)$/i.test(x.label))).map(x => x.label);
    const modeEl = [...doc.querySelectorAll('.composer-unified-dropdown[data-mode]')].find(vis);
    const modelEl = modelButton();
    const latestTurn = panel && [...panel.querySelectorAll('[data-turn-key]')].filter(vis).at(-1);
    const latest = page && state.entries.at(-1);
    const latestEntry = latest ? { ...latest, turn: codexStoredTurn(latest, state.scopes, false, codexTurnSource(latest, state.scopes, true)) }
      : nativeTail.at(-1) || (codexId && codexLatestEntry(latestTurn));
    for (const entry of nativeTail) {
      const rows = collect(null, entry), ids = new Set(items.map(item => item.i));
      items.push(...rows.filter(item => !ids.has(item.i)));
    }
    mergeCodexCapacity(items, state, capacity, !!page);
    const latestData = latestEntry?.turn || (latestTurn && codexTurnData(latestTurn));
    const turnTime = latestData?.items?.find(it => it.type === 'worked-for');
    let generation = turnTime?.startedAtMs ? { start: turnTime.startedAtMs, end: turnTime.completedAtMs || null } : null;
    if (!generation && latestData) {
      // Some turns lack the worked-for item entirely and it only appears after the turn ends.
      const start = latestData.items?.find(it => it.type === 'user-message')?.sentAtMs;
      if (Number.isFinite(start)) {
        let end = null;
        if (latestData.status === 'complete' || !isBusy()) {
          for (const it of latestData.items || []) {
            for (const e of [it.sentAtMs, Number.isFinite(it.startedAtMs) ? it.startedAtMs + (it.durationMs || 0) : NaN])
              if (Number.isFinite(e)) end = end == null ? e : Math.max(end, e);
          }
        }
        generation = { start, end };
      }
    }
    if (!generation && bubbleTimes?.generation) generation = bubbleTimes.generation;
    return {
      rect: [r.x, r.y, r.width, r.height].map(Math.round),
      _revision: chatRevision(),
      ...(codexId ? { _partialTurns: [...partialTurns], _completeTurns: [...completeTurns].filter(number => !partialTurns.has(number)), _completeTurnIds: [...completedIds],
        _historyEarlier: page ? page.earlier || !!page.missingTurn : state?.hasLoadedOldest === false,
        ...(page ? { historyBefore: page.before } : {}), _historyStart: state?.entries[0]?.turnNumber } : {}),
      ...(devinPage ? { historyBefore: devinPage.before, earlier: devinPage.earlier } : {}),
      ...(imagePreview ? { imagePreview: true } : {}),
      ...(generation ? { generation } : {}),
      capacityPresent: !!capacity,
      items,
      global,
      busy: isBusy(),
      queued: devinSurface() ? devinQueued() : (codexFacts()?.queued || queued()),
      ...(devinLog() ? { queuedCount: devinQueueCount() } : {}),
      subagents: subagents(),
      changed: changedCount(),
      questions: devinLog() ? devinQuestions() : codexId ? { codex: true, requests: codexRequestData() } : pendingCodexRequests?.length ? { codex: true, requests: pendingCodexRequests } : questions(),
      ...(log ? { devinTurnStart: items.filter(it => it.k === 'human' && Number.isFinite(it.sentAt)).at(-1)?.sentAt ?? null } : {}),
      ...(devinLog() ? { session: devinSession() } : {}),
      ...(devinSurface() ? { workdir: workdirInfo() } : {}),
      readonly: !hasComposer(),
      mode: devinSurface() && activeThread() ? nativeSessionInfo('devin', activeThread(), 'mode').items.find(item => item.checked)?.label || null
        : devinModeChip()?.innerText.trim() || (modeEl ? modeEl.innerText.trim() || modeEl.dataset.mode : null),
      permission: permissionLabel(), effort: effortName(),
      thread: activeThread(),
      title: agentState()?.title || '',
      model: agentModelName(),
      context: contextPct(),
      performance: log || devinSurface()
        ? nativePerformance('devin', activeThread(), agentRun('devin', activeThread()), agentModelName(), devinSessionData(activeThread()))
        : codexId ? nativePerformance('codex', codexId, agentRun('codex', codexId, scopes, manager), agentModelName(), manager?.getConversation(codexId)) : null,
      draft: composerDraft(),
      ...(devinSurface() ? { surface: devinSurface() } : {}),
      ...(codexFacts()?.view ? { codex: codexFacts().view } : {}),
    };
  };
  const cursorTerminalApproval = (thread, data) => {
    if (!data?.chatGenerationUUID || !data.conversationActionManager || data.conversationActionManager.signal.aborted
        || activeThread() !== thread) return null;
    const panel = findPanel(), headers = data.fullConversationHeadersOnly || [];
    const user = headers.findLastIndex(header => header.type === 1);
    if (!panel || user < 0) return null;
    const matches = [];
    for (const card of panel.querySelectorAll('[data-shell-tool-call-marker="root"].ui-shell-tool-call--pending')) {
      const bubbleId = card.closest('[data-message-id]')?.dataset.messageId;
      if (!headers.slice(user + 1).some(header => header.bubbleId === bubbleId)) continue;
      const tool = data.conversationMap[bubbleId]?.toolFormerData;
      if (tool?.name !== 'run_terminal_command_v2' || tool.status !== 'loading' || !tool.toolCallId
          || typeof tool.params?.command !== 'string' || !tool.params.command.trim()
          || ![...card.querySelectorAll('code')].some(code => vis(code) && code.innerText.trim() === '$ ' + tool.params.command.trim())) continue;
      const buttons = [...card.querySelectorAll('button')].filter(button => vis(button) && !button.disabled
        && button.getAttribute('aria-disabled') !== 'true');
      const accept = buttons.filter(button => button.innerText.trim() === 'Run');
      const reject = buttons.filter(button => button.innerText.trim() === 'Skip');
      if (accept.length === 1 && reject.length === 1)
        matches.push({ toolCallId: tool.toolCallId, bubbleId, tool, accept: accept[0], reject: reject[0] });
    }
    return matches.length === 1 ? matches[0] : null;
  };
  const cursorPendingTool = (thread = remoteContext?.threadId || activeThread()) => {
    const data = cursorSessionServices()?.data.getComposerDataIfLoaded(thread);
    const capability = data?.capabilities.find(capability => typeof capability.getPendingUserDecisionGroup === 'function');
    const decisions = capability?.getPendingUserDecisionGroup()() || [];
    // Cursor terminal Allowlist cards use the transcript's own decision controls.
    const terminal = !decisions.length ? cursorTerminalApproval(thread, data) : null;
    return { data, capability, decisions: terminal ? [terminal] : decisions, terminal };
  };
  const cursorNativeQuestions = () => {
    const { capability, decisions, terminal } = cursorPendingTool();
    if (terminal) return null;
    const matches = decisions.filter(decision => capability.getBubbleDataByToolCallId(decision.toolCallId)?.name === 'ask_question');
    if (matches.length !== 1) return null;
    const decision = matches[0];
    const bubble = decision && capability.getBubbleDataByToolCallId(decision.toolCallId);
    if (!bubble?.params?.questions) return null;
    const { currentSelections = {}, freeformTexts = {} } = bubble.additionalData || {};
    return { id: decision.toolCallId, list: bubble.params.questions.map(question => ({ id: question.id, text: question.prompt, multi: !!question.allowMultiple,
      options: [...question.options.map(option => ({ id: option.id, label: option.label, sel: !!currentSelections[question.id]?.includes(option.id) })),
        { label: '其他…', free: true, value: freeformTexts[question.id] || '', sel: !!currentSelections[question.id]?.includes('__freeform_other__') }] })),
      canSubmit: bubble.params.questions.every(question => currentSelections[question.id]?.length > 0) };
  };
  const nativeMarkdownItem = (id, kind, text, at, images = []) => ({ i: id, k: kind, t: text,
    ...(kind === 'human' && at ? { sentAt: at } : {}),
    ...(kind === 'assistant' ? { bodyFormat: 'markdown', h: esc(text).replace(/\n/g, '<br>') } : {}),
    ...(images.length ? { images } : {}) });
  const cursorMessageImages = message => (message.context?.selectedImages || []).map(image => image.path);
  const devinHistoryPage = (messages, limit, end = messages.length) => {
    if (!Number.isFinite(end)) throw new Error('历史起点已变化，请重新读取会话');
    const before = Math.max(0, end - limit);
    return { before, earlier: before > 0, items: devinMessageItems(messages.slice(before, end), 'acp', before) };
  };
  const nativeConversationChat = async (history, limit, beforeItem = null, context = remoteContext) => {
    if (context.app === 'devin') return devinReadSession(context.threadId,
      () => nativeConversationData(history, limit, beforeItem, context));
    return nativeConversationData(history, limit, beforeItem, context);
  };
  const nativeConversationData = async (history, limit, beforeItem, context) => {
    const { app, threadId: thread } = context;
    let items = [], earlier = false, before = 0, questions = null, title = '', draft, performanceData;
    if (app === 'cursor') {
      const { data, capability, decisions } = cursorPendingTool(thread);
      performanceData = data;
      const end = history && typeof beforeItem === 'string'
        ? data.fullConversationHeadersOnly.findIndex(row => beforeItem === row.bubbleId || beforeItem.startsWith(row.bubbleId + ':'))
        : history && Number.isFinite(context.before) ? context.before : data.fullConversationHeadersOnly.length;
      if (end < 0) throw new Error('历史起点已变化，请重新读取会话');
      const headers = data.fullConversationHeadersOnly.slice(Math.max(0, end - limit), end);
      const messages = await cursorMessages(thread, data, headers);
      const pending = new Map(decisions.map(decision => [decision.toolCallId, decision]));
      const rows = await Promise.all(messages.map(cursorNativeBubble));
      for (const [index, message] of messages.entries()) {
        const id = message.bubbleId, tool = message.toolFormerData;
        if (message.thinking?.text) items.push({ i: id + ':think', k: 'thinking', t: `Thoughts\n${message.thinking.text}`,
          live: !Number.isFinite(message.completedAtMs) && data.status === 'generating' });
        const row = rows[index];
        if (!row) continue;
        if (tool && pending.has(tool.toolCallId) && tool.name !== 'ask_question') {
          row.approvalId = tool.toolCallId;
          row.b = ['Run', 'Skip']; row.actions = [tool.toolCallId + ':accept', tool.toolCallId + ':reject'];
        }
        items.push(row);
      }
      items.push(...await cursorStructuredItems(thread, data));
      title = data.name || ''; draft = data.text;
      earlier = end > headers.length;
      before = headers[0]?.bubbleId || null;
      if (!history) questions = cursorNativeQuestions();
    } else {
      const data = devinSessionData(thread) || fusionDevinState(thread).data;
      performanceData = data;
      const failure = Object.entries(devinAgentRequests(thread)).findLast(([, request]) => request.method === 'session/prompt' && request.params?.sessionId === thread);
      const failed = failure?.[1].status === 'failed';
      const messages = devinMessages(thread, data), end = history && typeof beforeItem === 'string'
        ? Number(/^acp(\d+)/.exec(beforeItem)?.[1]) : history && Number.isFinite(context.before) ? context.before : messages.length;
      ({ items, before, earlier } = devinHistoryPage(messages, limit, end));
      const session = devinSessionRecord(thread);
      if (failed && !history)
        items.push({ i: 'acp' + messages.length + ':error', k: 'tool', src: 'devin', kind: 'error', t: failure[1].errorMessage, keep: true });
      title = session.title || '';
      questions = devinQuestions(thread);
    }
    if (history) {
      for (const item of items) { delete item.b; delete item.actions; delete item.btnItem; delete item.approvalId; }
      return { thread, items, earlier, before };
    }
    const scopes = [], run = agentRun(app, thread, scopes), changed = items.filter(item => item.kind === 'edit').length;
    const waiting = nativeWaiting(app, thread);
    if (app === 'devin' && questions?.requests?.length) Object.assign(waiting, {
      waiting: JSON.stringify([thread, ...questions.requests.map(request => request.id)]),
      waitingText: questions.requests.map(request => request.text).join('\n'),
    });
    return { thread, title, items, global: [], rect: [0, 0, 0, 0], busy: run?.status === 'running', readonly: false,
      _nativeState: { thread, title, run, busy: run?.status === 'running', host: remoteContext.host, workspace: remoteContext.cwd, ...waiting },
      queued: app === 'cursor' ? (cursorPendingTool().data.queueItems || []).map(item => ({ id: item.id, t: item.query, src: 'cursor' })) : devinQueued(thread),
      questions, changed, subagents: [], earlier, historyBefore: before,
      model: agentModelName(), effort: effortName(), permission: null, context: app === 'devin' ? contextPct() : null,
      ...((app === 'devin' || app === 'cursor') ? { mode: nativeSessionInfo(app, thread, 'mode').items.find(item => item.checked)?.label || null } : {}),
      performance: nativePerformance(app, thread, run, agentModelName(), performanceData),
      ...(draft !== undefined ? { draft } : {}),
      ...(app === 'devin' ? { surface: devinSurface(), session: { key: thread, cwd: remoteContext.cwd }, workdir: { cwd: remoteContext.cwd } } : {}),
      ...(run?.startedAt ? { generation: { start: run.startedAt, end: run.status === 'running' ? null : run.completedAt || null } } : {}) };
  };
  const contextPct = () => {
    if (devinSurface()) {
      const thread = remoteContext?.app === 'devin' ? remoteContext.threadId : activeThread();
      const usage = devinSessionData(thread)?.status?.contextUsage;
      return usage?.size > 0 ? { pct: Math.round(Math.min(100, usage.used / usage.size * 100)), basis: 'used' } : null;
    }
    const el = [...doc.querySelectorAll('button, [role=button], [role=img]')].find(e => vis(e) && /^(?:Context(?:\s+usage)?|上下文用量)[:：]?\s*\d+%/i.test(((e.getAttribute('aria-label') || e.innerText || '').replace(/\s+/g, ' ').trim())));
    if (el) {
      const text = ((el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' ').trim());
      return { pct: Number(/(\d+)%/.exec(text)[1]), basis: /left|remaining|剩余/i.test(text) ? 'remaining' : 'used' };
    }
    const thread = activeThread();
    const indicator = [...doc.querySelectorAll('.composer-context-usage-indicator')].find(e => vis(e)
      && (!e.closest('[data-glass-agent-id]') || e.closest('[data-glass-agent-id]').getAttribute('data-glass-agent-id') === thread));
    const ring = indicator?.querySelector('.token-ring-progress');
    if (!ring) return null;
    const length = Number(ring.getAttribute('stroke-dasharray'));
    return { pct: Math.round(Math.max(0, Math.min(100, (1 - Number(ring.getAttribute('stroke-dashoffset')) / length) * 100))), basis: 'used' };
  };
  // Cursor's Agents window shows several agent cards, each with its own composer; the selected one is the
  // sidebar row with data-active.
