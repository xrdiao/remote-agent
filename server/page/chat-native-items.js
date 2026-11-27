  // Token counters and elapsed time retain their native call/turn scope, separate from context capacity.
  const nativePerformance = (app, thread, run, model, data) => {
    if (!run) return null;
    let tokens = null, counter = null, usageId = run.id, runId = run.id, startedAt = run.startedAt, completedAt = run.completedAt;
    let busy = run.status === 'running';
    if (app === 'cursor') {
      const usage = data.turnTokenUsage;
      if (usage) tokens = { input: usage.inputTokens, output: usage.outputTokens,
        cacheRead: usage.cacheReadTokens, cacheWrite: usage.cacheWriteTokens };
      counter = tokens?.output ?? null;
      if (run.status === 'completed') {
        const last = data.conversationMap[data.fullConversationHeadersOnly.at(-1)?.bubbleId];
        if (Number.isFinite(last?.startedAtMs) && Number.isFinite(last?.turnDurationMs)) completedAt = last.startedAtMs + last.turnDurationMs;
      }
    } else if (app === 'codex') {
      const usage = data.latestTokenUsageInfo;
      if (usage?.last) tokens = { input: usage.last.inputTokens, output: usage.last.outputTokens,
        reasoning: usage.last.reasoningOutputTokens, cacheRead: usage.last.cachedInputTokens, cacheWrite: usage.last.cacheWriteInputTokens };
      counter = usage?.total?.outputTokens ?? null;
    } else {
      usageId = data?.currentTurnId || '';
      runId = usageId;
      const stats = data?.turnStats?.[usageId];
      const dimensions = stats?.responseDimensions;
      const user = data?.messages.findLast(message => message.kind === 'user_message'
        && message.content.some(block => block._meta?.['cognition.ai/clientMessageId'] === usageId));
      startedAt = Date.parse(user?.content.find(block => block._meta?.['cognition.ai/timestamp'])?._meta['cognition.ai/timestamp'] || '');
      const last = data?.messages.findLast(message => message.turnId === usageId && Array.isArray(message.content));
      completedAt = stats?.cause === 'complete'
        ? Date.parse(last?.content.findLast(block => block._meta?.['cognition.ai/timestamp'])?._meta['cognition.ai/timestamp'] || '') : 0;
      busy = stats?.cause !== 'complete' && busy;
      if (dimensions) {
        const values = Object.fromEntries(dimensions.map(row => [row.uid, row.kind.value]));
        tokens = { input: values.input_tokens, output: values.output_tokens,
          cacheRead: values.cached_input_tokens, cacheWrite: values.cached_write_tokens };
        counter = tokens.output ?? null;
        model = values.model || model;
      }
    }
    const durationMs = completedAt && Number.isFinite(startedAt) ? completedAt - startedAt : null;
    return { source: app, runId, usageId, busy, model, tokens, counter, startedAt, completedAt,
      unit: 'tokens', durationMs,
      rate: app !== 'codex' && !busy && counter != null && durationMs > 0 ? counter / (durationMs / 1000) : null };
  };
  const cursorNativeDiff = async result => {
    const chunks = result?.diff?.chunks;
    if (chunks?.length) return {
      add: chunks.reduce((sum, chunk) => sum + chunk.linesAdded, 0),
      del: chunks.reduce((sum, chunk) => sum + chunk.linesRemoved, 0),
      diff: chunks.flatMap(chunk => chunk.diffString.split(/\r?\n/).filter(line => /^[+ -]/.test(line))
        .map(line => [line[0], line.slice(1)])).slice(0, 200),
    };
    if (!result?.afterContentId || (!result.beforeContentId && !result.fileWasCreated)) return null;
    const cache = doc.defaultView.__remoteAgentCursorDiffs ||= new WeakMap();
    if (cache.has(result)) return cache.get(result);
    const pending = (async () => {
      const { data, codeBlocks } = cursorSessionServices();
      const storage = data._storageService;
      const [before, after] = await Promise.all([
        result.beforeContentId ? storage.cursorDiskKVGet(result.beforeContentId) : '', storage.cursorDiskKVGet(result.afterContentId),
      ]);
      if (typeof before !== 'string' || typeof after !== 'string') return null;
      const lines = text => text ? text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : [];
      const first = lines(before), second = lines(after);
      const diff = await codeBlocks.computeLinesDiffWithSemaphore({ first, second,
        options: { ignoreTrimWhitespace: false, computeMoves: false, maxComputationTimeMs: 2000 } });
      if (diff.hitTimeout) return null;
      let add = 0, del = 0;
      const rows = [];
      for (const { original, modified } of diff.changes) {
        const from = original.startLineNumber - 1, to = modified.startLineNumber - 1;
        const removed = original.endLineNumberExclusive - 1 - from, added = modified.endLineNumberExclusive - 1 - to;
        del += removed; add += added;
        if (rows.length >= 200) continue;
        rows.push(['…', `@@ -${from + 1},${removed} +${to + 1},${added} @@`]);
        for (const [kind, source, start, count] of [['-', first, from, removed], ['+', second, to, added]])
          for (let n = start; n < start + count && rows.length < 200; n++) rows.push([kind, source[n]]);
      }
      return { add, del, diff: rows };
    })();
    cache.set(result, pending);
    return pending;
  };
  const cursorNativeBubble = async message => {
    const i = message.bubbleId, tool = message.toolFormerData;
    if (!tool) {
      const images = cursorMessageImages(message);
      const at = Number(message.startedAtMs) || Date.parse(message.createdAt || '') || 0;
      if (message.text?.trim() || images.length) return nativeMarkdownItem(i, message.type === 1 ? 'human' : 'assistant', message.text || '', at, images);
      return null;
    }
    const file = tool.params?.relativeWorkspacePath || tool.params?.targetFile;
    const kind = /terminal|shell|command/.test(tool.name) ? 'command' : /^edit_file(?:_v\d+)?$/.test(tool.name) ? 'edit' : 'other';
    let details = {};
    if (kind === 'command') {
      if (typeof tool.params?.command === 'string') details.cmd = tool.params.command;
      if (typeof tool.result?.output === 'string') details.output = tool.result.output.slice(0, 4000);
    }
    if (kind === 'edit') details = await cursorNativeDiff(tool.result) || {};
    return { i, k: 'tool', src: 'cursor', t: tool.params?.commandDescription || tool.params?.command || tool.toolCall?.tool?.value?.description || tool.name || '',
      kind, execution: tool.name !== 'ask_question' && (kind !== 'edit' || !!details.diff?.length), ...details,
      ...(file ? { f: file } : {}), done: tool.status === 'completed' || tool.status === 'cancelled',
      ...(tool.error || tool.status === 'error' ? { keep: true } : {}) };
  };
  const cursorStructuredItems = async (thread, data) => {
    const rows = [], todos = data.todos || [];
    if (todos.length) rows.push({ i: thread + ':tasks', k: 'tasks', total: todos.length,
      done: todos.filter(todo => todo.status === 'completed').length,
      items: todos.map(todo => ({ t: todo.content, status: todo.status === 'completed' ? 'done' : todo.status })) });
    if (data.subagentComposerIds?.length) {
      const entries = await Promise.all(data.subagentComposerIds.map(async id => {
        const peek = await cursorSessionServices().data.composerDataHandleManager.peekComposerData(id);
        const child = peek?.source === 'memory' ? peek.handle.data : peek?.data;
        return child && !child.isArchived ? { id, title: child.name || id } : null;
      }));
      const agents = entries.filter(Boolean);
      if (agents.length) rows.push({ i: thread + ':subagents', k: 'tool', t: '子 Agent', agents });
    }
    return rows;
  };
  // The native transcript survives virtualization; mounted DOM rows retain their UI actions.
  const cursorCurrentChat = async (chat, limit) => {
    if (!chat?.thread) return chat;
    const data = cursorSessionServices().data.getComposerDataIfLoaded(chat.thread);
    const headers = data.fullConversationHeadersOnly;
    const positions = new Map(headers.map((header, index) => [header.bubbleId, index]));
    const messages = await cursorMessages(chat.thread, data, headers.slice(-limit));
    const rows = await Promise.all(messages.map(cursorNativeBubble));
    const native = new Map(rows.filter(item => item && (item.k !== 'tool' || item.kind === 'command' || item.kind === 'edit')).map(item => [item.i, item]));
    const existing = new Set(chat.items.map(item => item.i));
    const missing = [...native.values()].filter(item => !existing.has(item.i));
    const items = [];
    let next = 0;
    for (const item of chat.items) {
      const position = positions.get(item.i.split(':think')[0]);
      while (next < missing.length && positions.get(missing[next].i) < position) items.push(missing[next++]);
      items.push(native.has(item.i) ? { ...item, ...native.get(item.i) } : item);
    }
    items.push(...missing.slice(next));
    let first = headers.length;
    for (const { i } of items) {
      const position = positions.get(i.split(':think')[0]);
      if (position !== undefined && position < first) first = position;
    }
    items.push(...await cursorStructuredItems(chat.thread, data));
    const historyBefore = headers[first]?.bubbleId || null;
    return { ...chat, items, historyBefore, earlier: !!historyBefore && first > 0,
      performance: nativePerformance('cursor', chat.thread, agentRun('cursor', chat.thread), chat.model, data) };
  };
