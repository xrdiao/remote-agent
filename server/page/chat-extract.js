  const thinkingItem = (el, host, n) => {
    const title = thinkingTitleOf(el) || '思考';
    const body = thinkingPlain(el).trim();
    const base = itemKey(host && host !== el ? host : el) || `${activeThread()}:thinking:${thinkingNodes().indexOf(el)}`;
    const item = { i: `${base}:think:${n}`, k: 'thinking', t: body ? `${title}\n${body}` : title };
    if (thinkingLive(el)) item.live = true;
    return item;
  };
  const isThinking = el => el.matches('.ui-thinking-collapsible, .chat-thinking-box')
    || (el.matches('.highlight-wrapper') && /^(thinking|thoughts|thought(?: for)? )\b/i.test(thinkingTitleOf(el)));
  const thinkingInside = root => [...root.querySelectorAll(THINKING_ROOT)].filter(th => th.closest(THINKING_ROOT) === th && isThinking(th));
  const withoutThinking = el => {
    const clone = el.cloneNode(true);
    clone.querySelectorAll(THINKING_ROOT).forEach(n => n.remove());
    return clone;
  };
  // Devin user messages: rendered KaTeX would read twice through innerText (MathML + glyphs), so rebuild the
  // text with the math as $tex$ / $$tex$$ from the KaTeX annotation. Without math the plain text is unchanged.
  const devinUserText = root => {
    if (!root.querySelector('.katex')) return root.innerText.trim();
    const tex = n => (n.querySelector('annotation')?.textContent || '').trim();
    const walk = n => {
      if (n.nodeType === 3) return n.textContent;
      if (n.nodeType !== 1 || n.matches('button, style, script, svg')) return '';
      if (n.matches('.katex-display, .katex-block') && tex(n)) return `\n$$${tex(n)}$$\n`;
      if (n.matches('.katex') && tex(n)) return `$${tex(n)}$`;
      if (n.tagName === 'BR') return '\n';
      const inner = [...n.childNodes].map(walk).join('');
      return /^(P|DIV|LI|UL|OL|PRE|BLOCKQUOTE|H[1-6]|TABLE|TR)$/.test(n.tagName) ? `\n${inner}\n` : inner;
    };
    return walk(root).replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  };
  const messageItem = el => {
    const kindEl = el.matches('[data-message-kind]') ? el : el.querySelector('[data-message-kind]');
    const aria = el.getAttribute('aria-label');
    const k = aria === 'User message' ? 'human'
      : aria === 'Devin message' ? 'assistant'
      : kindEl?.dataset.messageKind || (el.querySelector('.composer-human-message, .aislash-editor-input-readonly') ? 'human'
        : el.querySelector('.anysphere-markdown-container-root') ? 'assistant' : 'other');
    const item = { i: itemKey(el), k };
    const sentAt = Date.parse(el.querySelector('time[datetime]')?.getAttribute('datetime') || '');
    if (k === 'human' && Number.isFinite(sentAt)) item.sentAt = sentAt;
    if (k === 'thinking') {
      const action = (el.querySelector('.ui-collapsible-action')?.innerText || '').replace(/\s+/g, ' ').trim();
      let details = (el.querySelector('.ui-collapsible-details')?.innerText || '').replace(/\s+/g, ' ').trim();
      details = details.replace(/\b(\w+)(?:\s+\1)+\b/gi, '$1');
      const title = [action || 'Thought', details].filter(Boolean).join(' ').slice(0, 80);
      const content = el.querySelector('.ui-collapsible-content');
      const plain = (content?.textContent || '').replace(/\u00a0/g, ' ').trim();
      item.t = plain ? `${title}\n${plain}` : title;
      if (/^thinking\b/i.test(action) || el.querySelector('[data-loading]')) item.live = true;
      return item;
    }
    const readable = el.querySelector('.aislash-editor-input-readonly, .composer-human-message') || withoutThinking(el);
    if (k === 'human') item.t = aria === 'User message' ? devinUserText(readable) : (readable.innerText || readable.textContent || '').trim();
    else if (k === 'assistant') {
      const devinRoot = aria === 'Devin message' ? el.querySelector('.prose-main') : null;
      const md = [...el.querySelectorAll('.markdown-root, .ui-markdown, .rendered-markdown, .anysphere-markdown-container-root')].find(n => !n.closest(THINKING_ROOT));
      const body = devinRoot || md || withoutThinking(el);
      item.t = (body.innerText || body.textContent || '').trim();
      item.h = devinRoot ? devinRich(devinRoot) : md ? clean(md) : esc((withoutThinking(el).innerText || '').trim()).replace(/\n/g, '<br>');
    }
    else item.t = summary(withoutThinking(el));
    if (k === 'tool') {
      const f = toolFile(el); if (f) item.f = f;
      const host = el.closest('[data-message-kind="tool"]') || el;
      const row = codexFiberProps(host, 6).find(p => p.row)?.row;
      const entries = row?.items || (row?.entry ? [row.entry] : []);
      if (entries.length && entries.every(e => /^(?:shell|read|listDir|glob|grep|ripgrepSearch|search|webSearch|webFetch|getMcpTools)ToolCall$/.test(e.step?.toolCallVm?.case || e.summaryToolCase || ''))) item.execution = true;
      if (host.dataset.toolHasError === 'true' || host.dataset.toolStatus === 'error' || entries.some(e => e.step?.error)) item.keep = true;
    }
    const b = buttonsIn(el, false).filter(x => !x.el.closest(THINKING_ROOT));
    if (b.length) {
      item.b = b.map(x => x.label);
      item.actions = b.map(x => {
        if (!x.el.dataset.remoteAction) x.el.dataset.remoteAction = crypto.randomUUID();
        return x.el.dataset.remoteAction;
      });
    }
    return item;
  };

  const cursorToolItems = el => {
    const runs = buttonsIn(el, false).filter(b => /^(Run|运行)$/.test(b.label));
    if (runs.length < 2) return [messageItem(el)];
    return runs.map(({ el: button }) => {
      let card = button.parentElement;
      while (card.parentElement && card.parentElement !== el && el.contains(card.parentElement)
        && runs.filter(b => card.parentElement.contains(b.el)).length === 1) card = card.parentElement;
      const item = messageItem(card);
      item.k = 'tool';
      item.t = summary(card);
      return item;
    });
  };

  const codexThread = () => {
    let el = [...doc.querySelectorAll('.ProseMirror')].find(vis);
    while (el && !Object.keys(el).some(k => k.startsWith('__reactFiber'))) el = el.parentElement;
    const active = el && codexFiberProps(el, 40).find(p => typeof p.conversationId === 'string');
    return active?.conversationId || [...doc.querySelectorAll('[data-response-annotation-conversation]')].filter(vis).at(-1)?.getAttribute('data-response-annotation-conversation') || '';
  };
  const attachmentRows = (ready = false) => {
    const ed = [...doc.querySelectorAll(`${COMPOSER}, [data-slate-editor="true"][contenteditable="true"]`)].filter(vis).at(-1);
    if (!ed) return [];
    let box = ed;
    for (let i = 0; i < 8 && box.parentElement; i++) box = box.parentElement;
    const cursor = ed.closest('.ai-input-full-input-box');
    if (cursor) box = cursor;
    const buttons = [...box.querySelectorAll('button[aria-label^="Remove "]')].filter(button => button.parentElement.querySelector('img'));
    if (ready) {
      const images = [...buttons.map(button => button.parentElement.querySelector('img')), ...box.querySelectorAll('.context-pill-image img')];
      return Promise.all(images.map(img => img.decode())).then(() => attachmentRows());
    }
    return [...buttons, ...box.querySelectorAll('.context-pill-image')].filter(vis).map(button => {
      const pill = button.matches('.context-pill-image');
      const img = pill ? button.querySelector('img') : button.parentElement.querySelector('img');
      const source = img?.currentSrc || img?.src || '';
      if (!button.dataset.remoteAttachment || button.__remoteAttachmentSrc !== source) {
        button.dataset.remoteAttachment = crypto.randomUUID();
        button.__remoteAttachmentSrc = source;
      }
      let preview = '';
      if (img?.complete && img.naturalWidth) {
        const canvas = doc.createElement('canvas');
        canvas.width = 96; canvas.height = Math.max(1, Math.round(96 * img.naturalHeight / img.naturalWidth));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        preview = canvas.toDataURL('image/jpeg', 0.6);
      }
      const label = pill ? '图片' : button.getAttribute('aria-label').slice(7);
      const name = img?.alt && img.alt !== 'User attachment' ? img.alt.replace(/^User uploaded image (\d+)$/, '图片 $1') : label;
      return { id: button.dataset.remoteAttachment, name, preview };
    });
  };
  const attachmentImage = async id => {
    const row = attachmentRows().find(f => f.id === id);
    if (!row) throw new Error('图片已不在当前输入框中');
    const el = [...doc.querySelectorAll('[data-remote-attachment]')].find(e => e.dataset.remoteAttachment === id);
    const img = el.matches('.context-pill-image') ? el.querySelector('img') : el.parentElement.querySelector('img');
    await img.decode();
    const canvas = doc.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    return { name: row.name, data: canvas.toDataURL('image/png') };
  };
  const removeAttachment = id => {
    if (!attachmentRows().some(f => f.id === id)) return false;
    const el = [...doc.querySelectorAll('[data-remote-attachment]')].find(b => b.dataset.remoteAttachment === id);
    const button = el?.matches('.context-pill-image') ? el.querySelector('.image-pill-close-button') : el;
    if (!button) return false;
    button.click();
    return true;
  };
  const attachmentPoint = id => {
    const el = [...doc.querySelectorAll('[data-remote-attachment]')].find(e => e.dataset.remoteAttachment === id);
    return el ? center(el) : null;
  };
  const submitCodexMessage = () => {
    const button = [...doc.querySelectorAll('button[aria-label="Send"],button[aria-label="Queue"],button[aria-label="Steer"]')].filter(vis).at(-1);
    if (!button || button.disabled) return false;
    button.click();
    return true;
  };
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
  const codexHistoryState = () => {
    const thread = codexThread(), scopes = codexHistoryScopes();
    const hostId = codexChatRows(true).find(row => row.id === thread)?.host || 'local';
    const key = JSON.stringify({ hostId, threadId: thread });
    let index = null;
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
        for (const turn of value?.conversationTurns || []) if (turn.turnId && Array.isArray(turn.items)) turns.set(turn.turnId, turn);
        for (const entry of value?.visibleTurnEntries || []) if (entry.turnId && Array.isArray(entry.turn?.items)) turns.set(entry.turnId, entry.turn);
        if (Array.isArray(value)) for (const item of value) if (typeof item?.id === 'string' && typeof item.text === 'string' && item.clientUserMessageId) queued.set(item.id, item);
      }
    }
    const entries = (index || []).map((turn, n) => ({ conversationId: thread, historyEntityKey: turn.entityKey,
      turnId: turn.turnId, turnKey: 'history-content:turn:' + turn.turnId, turnNumber: n + 1,
      isLatestTurn: n === index.length - 1, turnItemIds: [], metadata: turn, nativeTurn: turns.get(turn.turnId) }));
    for (const entry of entries.slice(-2)) for (const scope of scopes) for (const bindings of scope.familyBindings.values()) {
      const source = codexHistoryBinding(scope, bindings.get(entry.historyEntityKey));
      if (!source) continue;
      const value = source.get();
      if (value?.turnId === entry.turnId || Array.isArray(value) || Array.isArray(value?.entries) && Number.isFinite(value.length)) atoms.set(source.key, source);
      if (Array.isArray(value?.entries) && Number.isFinite(value.length)) entry.turnItemIds = value.entries.map(item => item.itemId);
    }
    for (const entry of entries.slice(-2)) {
      const ids = new Set([entry.turnItemIds[0], ...entry.turnItemIds.slice(-400)]);
      for (const scope of scopes) for (const bindings of scope.familyBindings.values()) for (const id of ids) {
        const source = codexHistoryBinding(scope, bindings.get(JSON.stringify([entry.historyEntityKey, id])));
        if (source) atoms.set(source.key, source);
      }
    }
    return { thread, scopes, entries, atoms, queued: [...queued.values()], indexed: index !== null };
  };
  const chatRevision = () => doc.defaultView.__remoteAgentChatRevision || 0;
  const watchCodexData = changed => {
    const subscribed = new Map();
    let stopped = false, pending = false;
    const update = () => {
      changed();
      if (!pending) { pending = true; queueMicrotask(() => { pending = false; if (!stopped) refresh(); }); }
    };
    const refresh = () => {
      const state = codexHistoryState(), wanted = new Map();
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
    return { refresh, stop() { stopped = true; for (const stop of subscribed.values()) stop(); subscribed.clear(); } };
  };
  const codexUserText = content => {
    const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    const wrapper = /^# Context from my IDE setup:\r?\n(?=[\s\S]*^## (?:Active file|Open tabs|Active selection of the file):)[\s\S]*?^## My request:\r?\n/m.exec(text);
    return wrapper?.index === 0 ? text.slice(wrapper[0].length).replace(/\r?\n$/, '') : text;
  };
  const codexStoredTurn = (entry, scopes = codexHistoryScopes(), patchesOnly = false) => {
    if (!entry.historyEntityKey) return null;
    const itemKey = id => JSON.stringify([entry.historyEntityKey, id]);
    let metadata = entry.nativeTurn, itemBindings, slots, itemTypes = [], matchedItems = 0, availableItems = 0;
    const nativeItems = new Map((entry.nativeTurn?.items || []).map(item => [item.id, item]));
    for (const scope of scopes) for (const bindings of scope.familyBindings.values()) {
      const atom = bindings.get(entry.historyEntityKey)?.value;
      const value = typeof atom?.get === 'function' ? atom.get() : null;
      if (!metadata && value?.turnId === entry.turnId) metadata = value;
      if (Array.isArray(value) && value.some(item => item?.itemId && item.type)) itemTypes = value;
      if (Array.isArray(value?.entries) && Number.isFinite(value.length)) slots = value;
    }
    const ids = slots ? [...slots.entries].sort((a, b) => a.index - b.index).map(e => e.itemId) : entry.turnItemIds || [];
    for (const scope of scopes) for (const bindings of scope.familyBindings.values()) {
      const count = ids.filter(id => bindings.get(itemKey(id))?.value?.get?.()?.id === id).length;
      if (count > matchedItems) { itemBindings = bindings; matchedItems = count; }
    }
    if (!metadata) return null;
    const complete = metadata.status === 'complete' || metadata.status === 'completed';
    const items = ids.flatMap((id, index) => {
      const native = nativeItems.get(id) || itemBindings?.get(itemKey(id))?.value?.get();
      const item = native || (index === 0 && itemTypes.find(item => item.itemId === id)?.type === 'userMessage' && Array.isArray(metadata.params?.input) && metadata.params.input.length > 0
        ? { type: 'userMessage', id, clientId: metadata.params.clientUserMessageId, content: metadata.params.input } : null);
      if (!item) return [];
      availableItems++;
      if (patchesOnly && item.type !== 'fileChange') return [];
      const done = complete || !!metadata.agentMessageCompletedAtMsById?.[id];
      if (item.type === 'userMessage') return { type: 'user-message', clientUserMessageId: item.clientId || item.id, nativeIds: [...new Set([item.id, item.clientId].filter(Boolean))],
        message: codexUserText(item.content || []),
        images: (item.content || []).filter(c => c.type === 'image' || c.type === 'localImage'), sentAtMs: metadata.turnStartedAtMs };
      if (item.type === 'agentMessage') return { type: 'assistant-message', responseAnnotationTargetId: item.id, content: item.text, phase: item.phase, completed: done };
      if (item.type === 'reasoning') return { type: 'reasoning', id: item.id, content: [...(item.summary || []), ...(item.content || [])].map(t => typeof t === 'string' ? t : t.text || '').join('\n'), completed: complete };
      if (item.type === 'commandExecution') return { type: 'exec', callId: item.id, cmd: [item.command], executionStatus: item.status };
      if (item.type === 'fileChange') return { type: 'patch', callId: item.id, changes: Object.fromEntries((item.changes || []).map(c => [c.path, c])) };
      if (item.type === 'plan') return { type: 'todo-list', id: item.id, plan: item.plan || [] };
      if (item.type === 'mcpToolCall') return { ...item, type: 'mcp-tool-call' };
      if (item.type === 'dynamicToolCall') return { ...item, type: 'dynamic-tool-call' };
      if (item.type === 'collabAgentToolCall') return item;
      if (item.type === 'webSearch') return { type: 'web-search', id: item.id, query: item.query };
      if (item.type === 'contextCompaction') return { type: 'context-compaction', id: item.id, source: item.source, status: complete ? 'completed' : 'inProgress' };
      return [];
    }).map(item => ({ ...item, sourceIndex: slots?.entries.find(slot => slot.itemId === (item.callId || item.responseAnnotationTargetId || item.id || item.nativeIds?.[0]))?.index }));
    const partial = slots && (slots.entries.length < slots.length || availableItems < slots.entries.length);
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
  const codexFusionTurn = (id = '', message = '', previous = []) => {
    const rows = [...doc.querySelectorAll('[data-turn-key]')];
    const el = id ? rows.find(e => e.getAttribute('data-turn-key') === id)
      : message ? [...rows].reverse().find(e => !previous.includes(e.getAttribute('data-turn-key')) && codexTurnData(e)?.items?.some(it => it.type === 'user-message' && String(it.message || '').trim() === message.trim()))
      : rows.filter(vis).at(-1);
    const turn = el && codexTurnData(el);
    const user = turn?.items?.find(it => it.type === 'user-message');
    const reply = turn?.items?.filter(it => it.type === 'assistant-message' && it.phase !== 'commentary').at(-1);
    return { id: el?.getAttribute('data-turn-key') || '', ids: rows.map(e => e.getAttribute('data-turn-key')), user: user?.message || '', text: reply?.content || '', completed: turn?.status === 'complete' && !!reply?.completed, items: el ? codexTurnItems(el) : [] };
  };
  // One Codex turn can contain several markdown blocks. Keep them in order instead of keeping only the first reply.
  const codexTurnItems = (el, entry = null, limit = 0) => {
    const thread = codexThread();
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
        const automatic = item.source !== 'manual';
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
        else out.push({ i: id, k: 'assistant', t: item.content, completed: item.completed, h: block ? clean(block) : esc(item.content).replace(/\n/g, '<br>') });
      } else if (item.type === 'exec') {
        out.push({ i: id, k: 'tool', t: (item.cmd || []).join('\n').slice(0, 240), done: finished,
          ...(item.approvalRequestId != null || ['failed', 'declined'].includes(item.executionStatus) || (item.output?.exitCode != null && item.output.exitCode !== 0) ? { keep: true } : {}) });
      } else if (item.type === 'patch') {
        const files = Object.keys(item.changes || {});
        out.push({ i: id, k: 'tool', t: `修改 ${files.join(', ')}`.slice(0, 240), f: files[0], done: finished });
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
        if (!el) continue;
        const images = [...el.querySelectorAll('img')].filter(vis).map(img => img.currentSrc || img.src).filter(src => /^(https?:|data:image\/|blob:)/.test(src));
        out.push({ i: id, k: 'tool', kind: 'other', src: 'codex', t: item.type === 'chatgpt-delayed-image-gen' ? '正在生成图片' : '生成的图片', images, keep: true });
      } else if (item.type === 'chatgpt-tool-approval') {
        out.push({ i: id, k: 'tool', kind: 'other', src: 'codex', t: `等待批准 ${textOf(item.title)}`.trim().slice(0, 240) });
      } else if (item.type === 'collabAgentToolCall' || item.type === 'chatgpt-subagent-activity') {
        out.push({ i: id, k: 'tool', src: 'codex', kind: 'other', t: `${item.tool || '子 Agent'} · ${item.status || ''}\n${JSON.stringify(item.agentsStates || item.agents || item.receiverThreadIds || [])}`, agents: (item.receiverThreadIds || []).map(id => ({ id, title: item.agentsStates?.[id]?.nickname || id })), keep: true });
      } else if (item.type === 'stream-error') {
        const body = textOf(item.content);
        if (CAPACITY_ERROR.test(body)) out.push({ i: id, k: 'notice', kind: 'capacity', t: body.slice(0, 400), capacity: true, live: !finished });
        else if (!finished && body) out.push({ i: id, k: 'thinking', t: `连接\n${body}`.slice(0, 400), live: true });
      } else if (item.type === 'turn-diff') {
        out.push({ i: id, k: 'tool', kind: 'other', src: 'codex', t: '文件改动' });
      } else if (item.type !== 'automatic-approval-review' && item.type !== 'worked-for') {
        const body = textOf(item.content || item.message || item.query || item.title);
        if (body) out.push({ i: id, k: 'tool', kind: 'other', src: 'codex', t: body.slice(0, 400), capacity: CAPACITY_ERROR.test(body), done: finished && /exec|patch|command/.test(item.type) });
      }
      for (const row of out.slice(start)) row.sourceIndex = item.sourceIndex ?? sourceIndex;
    }
    const turnButtons = el ? [
      ...buttonsIn(el, false),
      ...[...doc.querySelectorAll('[data-local-conversation-item-target-ids], aside')]
        .filter(card => card.closest('[data-turn-key]') === el && CAPACITY_ERROR.test(card.innerText || ''))
        .flatMap(card => buttonsIn(card, false)),
    ].map(x => x.label).filter((l, n, rows) => ( /^(Copy message|Fork chat from here|View changed files|View changes|View file changes|Undo|Open agent|View agent|View subagent|Stop agent|Apply|Revert)$/i.test(l) || RETRY_LABEL.test(l)) && rows.indexOf(l) === n) : [];
    const finalAssistant = finished ? [...out].reverse().find(it => it.k === 'assistant' && (it.completed === true || finished)) : null;
    const capacityHost = [...out].reverse().find(it => it.capacity);
    const host = finalAssistant || capacityHost;
    if (host) {
      host.buttonsRead = !!el;
      const buttons = finalAssistant ? turnButtons : turnButtons.filter(label => RETRY_LABEL.test(label));
      if (buttons.length) { host.b = buttons; host.btnItem = el.getAttribute('data-turn-key') || host.i; }
    }
    const number = entry?.turnNumber || codexFiberProps(el, 24).find(p => p.entry?.turnNumber)?.entry.turnNumber;
    return out.map(({ sourceIndex, ...item }, index) => ({ ...item, ...(number ? { order: number * 10000 + (sourceIndex ?? index) } : {}) }));
  };
  const codexHistoryPage = (before, known = [], details = false) => {
    const state = codexHistoryState(), seen = new Set(known), items = [];
    const end = Number.isFinite(before) ? before : Infinity;
    const mounted = new Map([...doc.querySelectorAll('[data-turn-key]')].map(el => [el.getAttribute('data-turn-key'), el]));
    let earlier = false, head = null, visible = 0;
    outer: for (const entry of [...state.entries].reverse()) {
      if (entry.turnNumber * 10000 >= end) continue;
      const turn = codexStoredTurn(entry, state.scopes);
      if (!turn || turn.partial) throw new Error('这段历史尚未载入完整，请稍后重试');
      const el = mounted.get(entry.turnKey);
      const rows = codexTurnItems(el || null, { ...entry, turn });
      for (const item of [...rows].reverse()) {
        if (item.order >= end || seen.has(item.i)) continue;
        if (visible === 80) { earlier = true; break outer; }
        items.push(item);
        if (details || item.k !== 'tool' || !item.done || item.keep) visible++;
        head = rows.find(row => row.k === 'human' && row.order <= item.order) || null;
      }
    }
    items.reverse();
    const cursor = items[0]?.order ?? before;
    if (head && !seen.has(head.i) && !items.some(item => item.i === head.i)) items.unshift(head);
    return { thread: state.thread, items, before: cursor, earlier };
  };
  /* ---------- Devin transcript rows ---------- */

  const devinLog = () => {
    const selected = devinSurface() === 'agent' ? agentList().find(a => a.current)?.id : devinTabs().find(t => t.active)?.id;
    return [...doc.querySelectorAll('[role="log"][aria-label="Session transcript"]')].find(e => vis(e) && (!selected || codexFiberProps(e, 24).some(p => p.sessionId === selected || p.session?.sessionId === selected)));
  };

  // Event-group tool rows: "Searched<query>", "Explored<file> and searched <q>", "Read<file> #L…".
  const devinEventTool = (eg, i, lines) => {
    const title = lines[0] || '';
    const m = /^([A-Z][a-z]+)/.exec(title);
    const label = m ? m[1] : '';
    const kind = /^searched/i.test(label) ? 'search' : /^explored/i.test(label) ? 'explore' : /^read/i.test(label) ? 'read' : 'other';
    const rest = title.slice(label.length);
    const t = `${label} ${[rest, ...lines.slice(1)].join(' · ')}`.replace(/\s+/g, ' ').trim();
    const codes = [...eg.querySelectorAll('code')].map(c => (c.innerText || '').trim()).filter(Boolean).slice(0, 6);
    const item = { i, k: 'tool', kind, t, chips: codes.map(c => c.replace(/\n/g, ' ').slice(0, 120)) };
    item.chipFiles = codes.map(c => {
      const file = c.split(/\n|\s+#L/)[0].trim();
      const line = /#L(\d+)/.exec(c)?.[1];
      return /\.[A-Za-z0-9]{1,10}$/.test(file) || /^[A-Za-z]:[\\/]|^\//.test(file)
        ? file + (line ? ':' + line : '') : '';
    });
    const fileish = codes.map(c => c.split('\n')[0].trim())
      .filter(c => /\.[A-Za-z0-9]{1,10}$/.test(c) || /^[A-Za-z]:[\\/]|^\//.test(c));
    if (fileish.length === 1) {
      item.f = fileish[0];
      const code = codes.find(c => c.startsWith(fileish[0]));
      const r = /(#L[\d,\-]+)/.exec(code || '');
      if (r) item.r = r[1];
    }
    return item;
  };

  // "Command <what> in <dir>" rows: medium title, optional "30s" duration, then the command text.
  const devinCommand = (row, i) => {
    const med = row.querySelector('span.codeium-text-medium');
    const t = (med?.innerText || '').trim();
    if (!t || !/^command\b/i.test(t)) return null;
    const rest = (row.innerText || '').split('\n').slice(1);
    let d = '';
    if (rest.length && /^\d+\s*[smh]\b/i.test(rest[0].trim())) d = rest.shift().trim();
    const props = codexFiberProps(med, 16);
    const command = props.find(p => typeof p.commandLine === 'string');
    const output = props.find(p => Array.isArray(p.outputs));
    return { i, k: 'tool', kind: 'command', t, d,
      cmd: (command?.commandLine || row.querySelector('.terminal-text .monaco-tokenized-source')?.textContent || '').trim(),
      output: (output?.outputs.map(o => o.full || '').join('\n') || row.querySelector('pre')?.innerText || rest.join('\n')).trim().slice(0, 4000) };
  };

  const setCommandOpen = (id, open) => {
    const row = [...(devinLog()?.children || [])].find(r => itemKey(r) === id);
    const btn = row?.querySelector('button[aria-expanded], .command-card .group\\/header');
    if (!btn) return null;
    const previous = btn.getAttribute('aria-expanded') === 'true' || !!btn.querySelector('.lucide-chevron-down');
    if (previous !== open) btn.click();
    return previous;
  };

  // "N / M tasks done" rows (Devin's todo list). The counts are always there; the checklist
  // items only exist while the row is expanded (see setTasksOpen).
  const devinTasks = (row, i) => {
    const sp = [...row.querySelectorAll('span')].find(s => /^\d+\s*\/\s*\d+\s+tasks?\s+done$/.test((s.innerText || '').trim()));
    if (!sp) return null;
    const m = /^(\d+)\s*\/\s*(\d+)/.exec(sp.innerText.trim());
    const rowsEl = [...row.querySelectorAll('div.flex.items-start')].filter(r => r.querySelector('span.block'));
    const items = rowsEl.map(r => ({
      t: (r.querySelector('span.block')?.innerText || '').trim().slice(0, 300),
      status: r.querySelector('.animate-spin') ? 'in_progress' : r.querySelector('svg.text-text-green') ? 'done' : 'pending',
    })).filter(x => x.t);
    return { i, k: 'tasks', done: Number(m[1]), total: Number(m[2]), ...(rowsEl.length ? { items } : {}) };
  };
  // Expands or folds a tasks row by its acp id (the chevron button only; caller restores).
  const setTasksOpen = (id, open) => {
    const row = [...(devinLog()?.children || [])].find(r => itemKey(r) === id);
    const btn = row?.querySelector('button[aria-expanded]');
    if (!btn) return null;
    const previous = btn.getAttribute('aria-expanded') === 'true';
    if (previous !== open) btn.click();
    return previous;
  };

  // Latest todo list of the Devin session (the phone's task notification); current = the item being worked on.
  const devinTaskState = () => {
    for (const row of [...(devinLog()?.children || [])].slice(-40).reverse()) {
      if (!/tasks? done/.test(row.textContent)) continue;
      const t = devinTasks(row, '');
      if (t) return { done: t.done, total: t.total, current: t.items?.find(x => x.status === 'in_progress')?.t || '' };
    }
    return null;
  };

  // File-edit rows: medium file name, +N/-N counters, then a .diff-code-block of line divs.
  const devinEdit = (row, i) => {
    const block = row.querySelector('.diff-code-block');
    const med = row.querySelector('span.codeium-text-medium');
    if (!block || !med) return null;
    const diff = [...block.children].map(d => {
      const c = String(d.className || '');
      const type = /insert/.test(c) ? '+' : /delete/.test(c) ? '-' : ' ';
      return [type, (d.innerText || '').replace(/\n+$/, '')];
    }).filter(l => l[1] !== '');
    const over = diff.length > 200;
    const nums = [...row.querySelectorAll('span')].map(s => (s.textContent || '').trim());
    const num = re => Number((nums.find(t => re.test(t)) || '').slice(1)) || 0;
    const props = codexFiberProps(med, 16);
    const file = props.find(p => typeof p.fileUri === 'string');
    const tool = props.find(p => p.toolCall?.rawInput?.file_path)?.toolCall;
    const item = { i, k: 'tool', kind: 'edit', f: file?.fileUri || tool?.rawInput.file_path || med.innerText.trim(), add: num(/^\+\d+$/), del: num(/^[-−]\d+$/), diff: over ? diff.slice(0, 200) : diff };
    if (over) item.diff.push(['…', `… 省略 ${diff.length - 200} 行`]);
    return item;
  };

  const devinMessageTime = msg => {
    const ts = codexFiberProps(msg, 12).find(p => Array.isArray(p.content) && p.content[0]?._meta)?.content[0]._meta['cognition.ai/timestamp'];
    const at = Date.parse(ts || '');
    return Number.isFinite(at) ? at : null;
  };
  // Iterate the Devin transcript's direct children in order: messages, thought groups,
  // tool event rows, commands and file edits all become items. Unknown rows are skipped.
  const devinItems = log => {
    const rows = [...log.children].filter(vis);
    const last = [...rows].reverse().find(r => (r.innerText || '').trim());
    const items = [];
    rows.forEach((row, n) => {
      const i = itemKey(row) || `acpx${n}`;
      const msg = row.querySelector('[role=group][aria-label="User message"], [role=group][aria-label="Devin message"]');
      if (msg) {
        const it = messageItem(msg);
        if (!it.i) it.i = i;
        if (it.k === 'human' && !it.sentAt) {
          const at = devinMessageTime(msg);
          if (Number.isFinite(at)) it.sentAt = at;
        }
        items.push(it);
        return;
      }
      const tasks = devinTasks(row, i);
      if (tasks) { items.push(tasks); return; }
      const cmd = devinCommand(row, i);
      if (cmd) { items.push(cmd); return; }
      const eg = row.classList.contains('event-group') ? row : row.querySelector('.event-group');
      if (eg) {
        const lines = (eg.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
        const title = lines[0] || '';
        if (/^(thoughts?|thinking)\b/i.test(title)) {
          const body = lines.slice(1).join('\n');
          const it = { i: `${i}:think`, k: 'thinking', t: body ? `${title}\n${body}` : title };
          if (row === last && !/\d/.test(title)) it.live = true;
          items.push(it);
          return;
        }
        items.push(devinEventTool(eg, i, lines));
        return;
      }
      const edit = devinEdit(row, i);
      if (edit) { items.push(edit); return; }
    });
    return items.filter(Boolean).map(it => ({ ...it, src: 'devin' }));
  };

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

  const codexCapacityItem = () => {
    if (devinSurface() || !doc.querySelector('.ProseMirror')) return null;
    const text = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const quoted = '.ProseMirror, [class*="MarkdownRoot"], [class*="user-message"], [data-message-kind="human"], pre, code, script, style';
    let capacity = null;
    for (let node = text.nextNode(); node; node = text.nextNode()) {
      if (!CAPACITY_ERROR.test(node.textContent || '')) continue;
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
      const body = (banner.innerText || '').replace(/\s+/g, ' ').trim();
      const key = `${codexThread()}:capacity`;
      capacity = { i: key, k: 'notice', kind: 'capacity', t: body.slice(0, 400), capacity: true, live: true,
        syntheticCapacity: true, _retry: retry,
        ...(ready ? { b: [label], btnItem: key } : {}) };
    }
    return capacity;
  };
  const codexReceiptRows = () => {
    const state = codexHistoryState();
    return state.entries.slice(-2).flatMap(entry => (codexStoredTurn(entry, state.scopes)?.items || [])
      .filter(item => item.type === 'user-message').map(item => ({ id: item.nativeIds?.[0] || item.clientUserMessageId, i: `${state.thread}:user-message:${item.clientUserMessageId}`, nativeIds: item.nativeIds, t: item.message })));
  };
  const extract = (history = false) => {
    const imagePreview = codexImagePreview();
    const log = devinLog();
    const panel = log || (devinSurface() ? null : findPanel());
    const state = !log && !devinSurface() ? codexHistoryState() : null;
    const initialCapacity = !panel && !log ? codexCapacityItem() : null;
    const nativeTail = state?.entries.slice(-2).flatMap(entry => {
      const turn = codexStoredTurn(entry, state.scopes);
      return turn ? [{ ...entry, turn }] : [];
    }) || [];
    // A brand-new Devin session has a composer and model chip, but no message list yet.
    if (!panel && !log && !initialCapacity && !nativeTail.length) {
      const pendingCodexRequests = !devinSurface() ? codexRequestData() : [];
      const modelEl = modelButton();
      if (!modelEl && !hasComposer() && !devinSurface() && !doc.querySelector('[data-request-input-dismiss]')) return null;
      return {
        _revision: chatRevision(), rect: [0, 0, 0, 0],
        items: [],
        capacityPresent: false,
        ...(imagePreview ? { imagePreview: true } : {}),
        ...(devinSurface() ? { empty: true } : {}),
        global: [],
        busy: isBusy(),
        queued: queued(),
        subagents: subagents(),
        changed: changedCount(),
        questions: codexThread() ? { codex: true, requests: codexRequestData() } : pendingCodexRequests.length ? { codex: true, requests: pendingCodexRequests } : null,
        ...(devinSurface() ? { session: devinSession(), workdir: workdirInfo() } : {}),
        readonly: !hasComposer(),
        mode: devinModeChip()?.innerText.trim() || CONTROLS.mode()?.innerText.trim() || null,
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
    if (!panel && !log && initialCapacity && !nativeTail.length) {
      delete initialCapacity._retry;
      return {
        _revision: chatRevision(), rect: [0, 0, 0, 0], items: [initialCapacity], global: [], busy: isBusy(), queued: queued(),
        subagents: subagents(), changed: changedCount(), questions: { codex: true, requests: codexRequestData() },
        readonly: !hasComposer(), model: agentModelName(), permission: permissionLabel(), effort: effortName(),
        capacityPresent: true, thread: activeThread(),
        ...(imagePreview ? { imagePreview: true } : {}), ...(codexFacts()?.view ? { codex: codexFacts().view } : {}),
      };
    }
    const r = (log || panel)?.getBoundingClientRect() || { x: 0, y: 0, width: 0, height: 0 };
    const partialTurns = new Set(), completeTurns = new Set();
    const collect = (el, entry) => {
      const turn = entry?.turn;
      const rows = codexTurnItems(el, entry, history ? 0 : 400);
      const number = entry?.turnNumber;
      if (number) (turn?.partial ? partialTurns : completeTurns).add(number);
      return rows;
    };
    const codexId = log ? '' : codexThread();
    const pendingCodexRequests = !log && !devinSurface() && !codexId ? codexRequestData() : null;
    const bubbleTimes = (!log && !codexId) ? cursorBubbleTimes() : null;
    const items = log ? devinItems(log) : (panel ? topItems(panel) : []).flatMap(el => {
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
    const latestEntry = nativeTail.at(-1) || (codexId && codexLatestEntry(latestTurn));
    for (const entry of nativeTail) {
      const rows = collect(null, entry), ids = new Set(items.map(item => item.i));
      items.push(...rows.filter(item => !ids.has(item.i)));
    }
    if (capacity && !items.some(item => item.i === capacity.i)) {
      capacity.order = Math.max(0, ...items.map(item => item.order || 0)) + 1;
      items.push(capacity);
    }
    if (capacity) delete capacity._retry;
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
      ...(codexId ? { _partialTurns: [...partialTurns], _completeTurns: [...completeTurns].filter(number => !partialTurns.has(number)) } : {}),
      ...(imagePreview ? { imagePreview: true } : {}),
      ...(generation ? { generation } : {}),
      capacityPresent: !!capacity,
      items,
      global,
      busy: isBusy(),
      queued: devinLog() ? devinQueued() : (codexFacts()?.queued || queued()),
      ...(devinLog() ? { queuedCount: devinQueueCount() } : {}),
      subagents: subagents(),
      changed: changedCount(),
      questions: devinLog() ? devinQuestions() : codexId ? { codex: true, requests: codexRequestData() } : pendingCodexRequests?.length ? { codex: true, requests: pendingCodexRequests } : questions(),
      ...(log ? { devinTurnStart: items.filter(it => it.k === 'human' && Number.isFinite(it.sentAt)).at(-1)?.sentAt ?? null } : {}),
      ...(devinLog() ? { session: devinSession() } : {}),
      ...(devinSurface() ? { workdir: workdirInfo() } : {}),
      readonly: !hasComposer(),
      mode: devinModeChip()?.innerText.trim() || (modeEl ? modeEl.innerText.trim() || modeEl.dataset.mode : null),
      permission: permissionLabel(), effort: effortName(),
      thread: activeThread(),
      title: agentState()?.title || '',
      model: agentModelName(),
      context: contextPct(),
      draft: composerDraft(),
      ...(devinSurface() ? { surface: devinSurface() } : {}),
      ...(codexFacts()?.view ? { codex: codexFacts().view } : {}),
    };
  };
  const contextPct = () => {
    const el = [...doc.querySelectorAll('button, [role=button], [role=img]')].find(e => vis(e) && /^Context(?:\s+usage)?:?\s*\d+%/i.test(((e.getAttribute('aria-label') || e.innerText || '').replace(/\s+/g, ' ').trim())));
    if (el) {
      const text = ((el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' ').trim());
      return { pct: Number(/(\d+)%/.exec(text)[1]), basis: /left|remaining|剩余/i.test(text) ? 'remaining' : 'used' };
    }
    const thread = activeThread();
    const usage = window.__acpStore?.getState()?.acp?.perSession?.[thread]?.contextUsage;
    if (usage?.size > 0) return { pct: Math.round(Math.min(100, usage.used / usage.size * 100)), basis: 'used' };
    const indicator = [...doc.querySelectorAll('.composer-context-usage-indicator')].find(e => vis(e)
      && (!e.closest('[data-glass-agent-id]') || e.closest('[data-glass-agent-id]').getAttribute('data-glass-agent-id') === thread));
    const ring = indicator?.querySelector('.token-ring-progress');
    if (!ring) return null;
    const length = Number(ring.getAttribute('stroke-dasharray'));
    return { pct: Math.round(Math.max(0, Math.min(100, (1 - Number(ring.getAttribute('stroke-dashoffset')) / length) * 100))), basis: 'used' };
  };
  // Cursor's Agents window shows several agent cards, each with its own composer; the selected one is the
  // sidebar row with data-active.
