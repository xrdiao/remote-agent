  const codexButton = label => [...doc.querySelectorAll('button')].find(e => vis(e) && (e.getAttribute('aria-label') || '') === label)
    || [...doc.querySelectorAll('button')].find(e => vis(e) && (e.getAttribute('aria-label') || '').startsWith(label));
  const codexPoint = el => {
    const c = center(el);
    const frame = document.getElementById('active-frame');
    if (!frame || el.ownerDocument === document) return c;
    const o = frame.getBoundingClientRect();
    return { x: c.x + o.x, y: c.y + o.y };
  };
  const codexRecentPoint = () => {
    const b = codexButton('Recent chats');
    return b ? { ...codexPoint(b), open: [...doc.querySelectorAll('[role=menu]')].some(e => vis(e) && /Search recent chats/.test(e.innerText || '')) } : null;
  };
  const codexNewPoint = () => { const b = codexButton('New chat'); return b ? codexPoint(b) : null; };
  const codexNeedsLogin = () => [...doc.querySelectorAll('button')].some(b => vis(b) && /^(Sign in with ChatGPT|Use API Key|Use device code)$/.test(b.textContent.trim()));
  const codexAccountPoint = () => {
    const buttons = [...doc.querySelectorAll('button')].filter(e => {
      const r = e.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.y < 0 || r.y > 70) return false;
      if ((e.getAttribute('aria-label') || '') || (e.innerText || '').trim()) return false;
      return (e.getAttribute('aria-haspopup') || e.parentElement?.getAttribute('aria-haspopup')) === 'menu';
    });
    return buttons[0] ? codexPoint(buttons[0]) : null;
  };
  const codexMenuPoint = label => {
    const el = [...doc.querySelectorAll('button, [role=menuitem], a')].find(e => {
      const r = e.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.bottom < 0) return false;
      const text = ((e.getAttribute('aria-label') || e.innerText || '').replace(/\s+/g, ' ').trim());
      return text === label || text.startsWith(label);
    });
    return el ? codexPoint(el) : null;
  };
  const scrollCodexHistory = restore => {
    const first = [...doc.querySelectorAll('[data-turn-key]')].find(vis);
    let el = first;
    while (el && el !== doc.body) {
      if (/auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight) {
        if (typeof restore === 'number') { el.scrollTop = restore; return null; }
        const scrollTop = el.scrollTop;
        if (restore === false) return { ...codexPoint(el), scrollTop };
        if (restore === 'latest') {
          const rows = [...doc.querySelectorAll('[data-turn-key]')];
          if (rows.some(row => codexFiberProps(row, 16).some(p => p.entry?.isLatestTurn))) return null;
          el.scrollTop = getComputedStyle(el).flexDirection === 'column-reverse' ? 0 : el.scrollHeight;
          return { scrollTop, thread: codexThread() };
        }
        first.scrollIntoView({ block: 'start' });
        return { ...codexPoint(el), scrollTop };
      }
      el = el.parentElement;
    }
    return null;
  };
  const codexViewState = () => ({ thread: codexThread(), turns: [...doc.querySelectorAll('[data-turn-key]')].filter(vis).length });
  // In-page waits: resolve as soon as the condition holds instead of round-trip polling.
  const codexWaitThread = (id, ms = 1800) => new Promise(resolve => {
    const t0 = Date.now();
    const tick = () => {
      if (codexThread() === id) return resolve(true);
      if (Date.now() - t0 >= ms) return resolve(false);
      setTimeout(tick, 30);
    };
    tick();
  });
  const codexWaitTurns = (ms = 1200) => new Promise(resolve => {
    const t0 = Date.now();
    const tick = () => {
      if ([...doc.querySelectorAll('[data-turn-key]')].some(vis)) return resolve(true);
      if (Date.now() - t0 >= ms) return resolve(false);
      setTimeout(tick, 30);
    };
    tick();
  });
  const codexImagePreview = () => [...doc.querySelectorAll('img[class*="ZoomableImage"]')].some(vis);
  const codexFiberProps = (el, depth = 16) => {
    while (el && !Object.keys(el).some(k => k.startsWith('__reactFiber'))) el = el.parentElement;
    const key = el && Object.keys(el).find(k => k.startsWith('__reactFiber'));
    let fiber = key ? el[key] : null;
    const props = [];
    for (let i = 0; i < depth && fiber; i++) {
      if (fiber.memoizedProps && typeof fiber.memoizedProps === 'object') props.push(fiber.memoizedProps);
      fiber = fiber.return;
    }
    return props;
  };
  // Recent-chat rows carry the conversation id on the React node, not on a stable attribute.
  const codexChatRows = (readOnly = false) => {
    const menu = [...doc.querySelectorAll('[role=menu]')].find(e => vis(e) && /Search recent chats/.test(e.innerText || ''));
    const seen = new Set();
    const rows = [];
    const recent = codexQueryClient()?.getQueryData(['recent-conversations-meta', 'updated_at', '[]', 'live']) || [];
    if (readOnly) return recent.map(thread => ({ id: thread.conversationId, title: thread.title || '', workspace: thread.cwd || '', host: thread.hostId === 'local' ? '' : thread.hostId || '', lastUsed: thread.updatedAt || 0 }));
    if (!menu) return [];
    const usedAt = new Map(recent.map(thread => [thread.conversationId, thread.updatedAt]));
    const metadata = new Map(recent.map(thread => [thread.conversationId, thread]));
    for (const el of menu.querySelectorAll('[role=button]')) {
      let id = '', title = '', current = false, workspace = '', running = false;
      for (const p of codexFiberProps(el)) {
        if (p.conversationId) id = String(p.conversationId);
        else if (typeof p.href === 'string' && p.href.startsWith('/local/')) id = p.href.split('/').pop();
        if (typeof p.title === 'string' && p.title) title = p.title;
        if (p.isActive === true) current = true;
        if (typeof p.envTooltip === 'string') workspace = p.envTooltip;
        if (p.isRunning === true || p.running === true) running = true;
      }
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (/in progress/i.test(text)) running = true;
      const meta = metadata.get(id);
      rows.push({ id, title: (title || text).split('\n')[0].slice(0, 80), current, workspace: meta?.cwd || workspace, host: meta?.hostId && meta.hostId !== 'local' ? meta.hostId : '', running, lastUsed: usedAt.get(id) || 0 });
    }
    return rows;
  };
  const codexChatPoint = id => {
    const menu = [...doc.querySelectorAll('[role=menu]')].find(e => vis(e) && /Search recent chats/.test(e.innerText || ''));
    if (!menu) return null;
    for (const el of menu.querySelectorAll('[role=button]')) {
      const hit = codexFiberProps(el).some(p => p.conversationId === id || (typeof p.href === 'string' && p.href.endsWith('/' + id)));
      if (hit) { el.scrollIntoView({ block: 'nearest' }); return codexPoint(el); }
    }
    return null;
  };
  // Each recent-chat row has its own Archive chat button. Delete chat is used only when that row actually shows it.
  const codexArchiveRow = id => {
    const menu = [...doc.querySelectorAll('[role=menu]')].find(e => vis(e) && /Search recent chats/.test(e.innerText || ''));
    return menu && [...menu.querySelectorAll('[role=button]')].find(el => codexFiberProps(el).some(p => p.conversationId === id || (typeof p.href === 'string' && p.href.endsWith('/' + id))));
  };
  const codexArchiveTarget = id => {
    const el = codexArchiveRow(id);
    if (!el) return null;
    const buttons = [...el.querySelectorAll('button')].filter(b => b.getBoundingClientRect().width > 0);
    const labels = buttons.map(b => b.getAttribute('aria-label') || '');
    const action = labels.includes('Delete chat') ? 'Delete chat' : labels.includes('Archive chat') ? 'Archive chat' : '';
    const btn = buttons.find(b => (b.getAttribute('aria-label') || '') === action);
    if (!btn) return { action: '' };
    el.scrollIntoView({ block: 'nearest' });
    return { action, ...codexPoint(btn) };
  };
  const codexArchiveConfirm = id => {
    const dialog = [...doc.querySelectorAll('[role=dialog]')].find(e => vis(e) && e.getBoundingClientRect().height > 20);
    const scope = dialog || codexArchiveRow(id);
    if (!scope) return null;
    const buttons = [...scope.querySelectorAll('button')].filter(b => vis(b) && !b.disabled);
    const btn = buttons.find(b => dialog
      ? b.hasAttribute('data-archive-confirm-button') || /^(Archive chat|Delete chat|Archive|Delete|Stop and archive|Archive and remove)$/i.test((b.innerText || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
      : /^Confirm$/i.test((b.innerText || b.getAttribute('aria-label') || '').trim()));
    if (!btn) return null;
    return { label: (btn.innerText || btn.getAttribute('aria-label') || '').trim(), ...codexPoint(btn) };
  };
  const codexArchiveDone = (id, action) => {
    if (codexChatRows(true).some(row => row.id === id)) return false;
    if (action === 'Delete chat') return true;
    for (const scope of codexHistoryScopes()) for (const bindings of scope.familyBindings.values()) for (const binding of bindings.values()) {
      const manager = typeof binding.value?.get === 'function' ? binding.value.get() : null;
      if (typeof manager?.isConversationArchiving === 'function' && manager.isConversationSuppressedAfterArchive(id)) return !manager.isConversationArchiving(id);
    }
    return false;
  };

  const codexPromptEl = () => [...doc.querySelectorAll('.ProseMirror[contenteditable="true"]')].find(vis);
  const codexPromptText = () => {
    const ed = codexPromptEl();
    if (!ed) return null;
    return (ed.innerText || '').replace(/[\u200b\ufeff]/g, '').replace(/^\n/, '').replace(/\n+$/g, '');
  };
  const codexSelectPrompt = () => {
    const ed = codexPromptEl();
    if (!ed) return false;
    ed.focus();
    const sel = ed.ownerDocument.getSelection();
    const range = ed.ownerDocument.createRange();
    range.selectNodeContents(ed);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  };
  const codexPromptPoint = () => {
    const ed = codexPromptEl();
    if (!ed || !vis(ed)) return null;
    const r = ed.getBoundingClientRect();
    return codexPoint(ed);
  };
  const codexClearDraftAttachments = () => {
    let el = codexPromptEl();
    while (el && !Object.keys(el).some(k => k.startsWith('__reactFiber'))) el = el.parentElement;
    let fiber = el && el[Object.keys(el).find(k => k.startsWith('__reactFiber'))];
    while (fiber) {
      const clear = fiber.memoizedProps?.clearDraftAttachments;
      if (typeof clear === 'function') { clear(); return true; }
      fiber = fiber.return;
    }
    return false;
  };
  const codexButtonPoint = which => {
    const buttons = [...doc.querySelectorAll('button')].filter(vis);
    const el = which === 'ide' ? buttons.find(b => /IDE context/i.test(b.getAttribute('aria-label') || ''))
      : which === 'run' ? buttons.find(b => (b.getAttribute('aria-label') || '') === 'Select where to run the chat')
      : which === 'actions' ? buttons.find(b => (b.getAttribute('aria-label') || '') === 'Chat actions')
      : null;
    return el ? codexPoint(el) : null;
  };
  const codexAddFiles = paths => {
    let el = codexPromptEl();
    while (el && !Object.keys(el).some(k => k.startsWith('__reactFiber'))) el = el.parentElement;
    let fiber = el && el[Object.keys(el).find(k => k.startsWith('__reactFiber'))];
    while (fiber) {
      const actions = fiber.updateQueue?.memoCache?.data?.flat().find(v => typeof v?.addFileDescriptorsAsMentions === 'function');
      if (actions) {
        actions.addFileDescriptorsAsMentions(paths.map(path => ({ fsPath: path, path, label: path.split(/[\\/]/).pop() })));
        return true;
      }
      fiber = fiber.return;
    }
    throw new Error('当前 Codex 输入框没有可用的添加文件入口');
  };
  const codexMentionRows = () => {
    const root = doc.querySelector('[data-mention-list-scroll-area]');
    if (!root || root.getBoundingClientRect().height < 8) return [];
    const rows = [];
    for (const sec of doc.querySelectorAll('[data-mention-section-id]')) {
      const section = sec.getAttribute('data-mention-section-id') || '';
      for (const item of sec.querySelectorAll('[data-list-navigation-item]')) {
        const r = item.getBoundingClientRect();
        if (r.height < 8 || r.width < 8) continue;
        const lines = (item.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
        let key = '';
        for (const p of codexFiberProps(item, 8)) {
          if (typeof p.key === 'string' && p.key) { key = p.key; break; }
        }
        const label = (lines[0] || '').slice(0, 80);
        if (!label) continue;
        rows.push({
          section, key: key || `${section}:${label}:${lines.slice(1).join(' ')}`, label,
          sub: lines.slice(1).join(' ').slice(0, 160),
          ...codexPoint(item),
        });
      }
    }
    return rows;
  };
  const codexRunItems = () => [...doc.querySelectorAll('[role=menuitem]')].filter(vis).map(e => {
    const label = (e.innerText || '').replace(/\s+/g, ' ').trim();
    const r = e.getBoundingClientRect();
    return { label, ...codexPoint(e) };
  }).filter(x => x.label);
  const codexQueued = () => {
    const thread = codexThread();
    if (!thread) return [];
    // Newer Codex keeps the queue in the composer's own rows (props carry messageId / fullMessageText);
    // older builds kept it in the queued-follow-ups global state read below.
    const rows = [...doc.querySelectorAll('[aria-label^="Preview queued message"]')].filter(vis)
      .map(el => {
        const props = codexFiberProps(el, 96);
        return props.some(p => p.conversationId === thread)
          ? props.find(p => typeof p.messageId === 'string' && 'fullMessageText' in p) : null;
      }).filter(Boolean);
    const native = [...new Map(rows.map(p => [p.messageId, p])).values()].map(p => ({
      id: p.messageId, t: String(p.fullMessageText || p.messageText || '').slice(0, 4000), src: 'codex',
    })).filter(m => m.t);
    const value = codexQueryClient()?.getQueryData(['vscode', 'get-global-state', '{"key":"queued-follow-ups"}'])?.value;
    const raw = value && typeof value === 'object' ? value[thread] : null;
    if (!Array.isArray(raw)) return native;
    const stored = raw.map((m, n) => ({
      id: String(m?.id || `cq${n}`),
      t: String(m?.text || m?.message || m?.content || '').slice(0, 4000),
      src: 'codex',
    })).filter(m => m.t);
    const merged = new Map(native.map(m => [m.id, m]));
    for (const item of stored) if (!merged.has(item.id)) merged.set(item.id, item);
    return [...merged.values()];
  };
  const codexQueueAction = async (id, action) => {
    if (!codexQueued().some(m => m.id === id)) return false;
    const name = { send: 'onSendNowMessage', remove: 'onDeleteMessage', edit: 'onEditMessage' }[action];
    for (const el of doc.querySelectorAll('button')) {
      for (const p of codexFiberProps(el, 96)) {
        const actions = p.messageListActions || p;
        if (typeof actions[name] === 'function') { await actions[name](id); return true; }
      }
    }
    return false;
  };
  // Read pending native cards, keeping their real controls rather than reproducing approval semantics.
  const codexAsyncRequestFiber = el => {
    const key = Object.keys(el).find(k => k.startsWith('__reactFiber'));
    const fiber = key ? el[key] : null;
    let root = fiber;
    while (root?.return) root = root.return;
    const stack = root?.stateNode?.current ? [[root.stateNode.current, null]] : [];
    // A reused child can retain an old return pointer. Follow the mounted tree's child links instead.
    while (stack.length) {
      const [node, parentRequest] = stack.pop();
      const p = node.memoizedProps;
      const request = Array.isArray(p?.questions) && typeof p.onDraftChange === 'function' && typeof p.onSubmit === 'function' ? node : parentRequest;
      if (node.stateNode === el) return request;
      if (node.sibling) stack.push([node.sibling, parentRequest]);
      if (node.child) stack.push([node.child, request]);
    }
    return null;
  };
  const codexRequests = () => {
    if (!activeThread()) return [];
    const rows = new Map();
    const query = selector => [...new Set([doc, document])].flatMap(d => [...d.querySelectorAll(selector)]);
    for (const skip of query('[data-request-input-dismiss]').filter(vis)) {
      const fiber = codexAsyncRequestFiber(skip);
      const props = fiber?.memoizedProps;
      if (!props) continue;
      const index = props.questionIndex;
      const question = props.questions[index];
      if (!question) continue;
      const id = 'async:' + question.id;
      const buttons = question.options.map(option => ({ label: option, selected: question.draft === option, disabled: !!props.isSubmitting, action: () => props.onDraftChange(option) }));
      buttons.push({ el: skip, label: skip.innerText || 'Skip', disabled: !!props.isSubmitting });
      buttons.push({ label: index < props.questions.length - 1 ? 'Next' : props.hasSubmitted ? 'Send update' : 'Send', disabled: !!props.isSubmitting || !question.draft.trim(), submit: index === props.questions.length - 1, action: () => index < props.questions.length - 1 ? props.onQuestionChange(index + 1) : props.onSubmit() });
      rows.set(id, { id, submissionKey: fiber.key, text: question.question, buttons, fields: [{ label: '回答', value: question.draft, type: 'text', onChange: props.onDraftChange }] });
    }
    for (const el of query('button, input, textarea, select, [role=radio], [role=checkbox]')) {
      if (!vis(el) || el.closest('[contenteditable=true]')) continue;
      const approvalCard = el.closest('[data-codex-approval-surface]');
      const props = codexFiberProps(el, 32).find(p => p.request?.item?.requestId || (p.item?.requestId && (p.onReply || p.onApprove || p.onSubmit))
        || (approvalCard && p.item?.type === 'exec' && p.item.approvalRequestId != null));
      const request = props?.request || (props?.item ? props : null);
      const item = request?.item;
      if (!item) continue;
      const approval = item.type === 'exec' && item.approvalRequestId != null;
      const id = approval ? 'approval:' + item.approvalRequestId : String(item.requestId);
      if (!rows.has(id)) rows.set(id, { id, text: approval ? ['终端命令执行审批', ...(item.cmd || []), item.approvalReason].filter(Boolean).join('\n') : item.title || item.reason || item.command || (item.questions || []).map(q => q.question || q.title || q.header).join('\n') || request.kind || 'Codex 请求', buttons: [], fields: [] });
      const row = rows.get(id);
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !/^(checkbox|radio|hidden)$/.test(el.type)) {
        row.fields.push({ el, label: el.getAttribute('aria-label') || el.placeholder || el.name || '回答', value: el.value || '', type: el.type, options: el.tagName === 'SELECT' ? [...el.options].map(o => ({ value: o.value, label: o.text })) : null });
      } else {
        const label = (el.getAttribute('aria-label') || el.innerText || '').trim();
        if (label && !row.buttons.some(b => b.el === el)) row.buttons.push({ el, label, selected: el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true' || el.getAttribute('data-state') === 'checked', disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', ...codexPoint(el) });
      }
    }
    const questionCards = new Set(query('[role=dialog]').filter(vis));
    for (const field of query('textarea,input,[contenteditable=true]').filter(vis)) {
      for (let card = field.parentElement, depth = 0; card && depth < 7; card = card.parentElement, depth++) {
        const heading = [...card.querySelectorAll('h1,h2,h3,[role=heading],span,p,div')].find(e => e.children.length === 0 && /^(Question|提问|问题)$/.test(e.textContent.trim()));
        if (heading) { questionCards.add(card); break; }
      }
    }
    for (const dialog of questionCards) {
      if ([...rows.values()].some(r => [...r.buttons, ...r.fields].some(b => b.el && dialog.contains(b.el)))) continue;
      const title = dialog.getAttribute('aria-label') || dialog.querySelector('h1,h2,h3')?.innerText || 'Codex';
      const content = dialog.cloneNode(true);
      content.querySelectorAll('button,input,textarea,select,[contenteditable=true],[role=radio],[role=checkbox]').forEach(el => el.remove());
      const text = (content.textContent || title).trim();
      const id = 'dialog:' + title + ':' + text.slice(0, 160);
      rows.set(id, {
        id, text: text.slice(0, 6000),
        buttons: [...dialog.querySelectorAll('button, [role=radio], [role=checkbox]')].filter(vis).map(el => ({ el, label: el.getAttribute('aria-label') || el.innerText || el.title || '确认', selected: el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true' || el.getAttribute('data-state') === 'checked', disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', ...codexPoint(el) })),
        fields: [...dialog.querySelectorAll('input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable=true]')].filter(vis).map(el => ({ el, label: el.getAttribute('aria-label') || el.placeholder || el.name || '输入', value: el.value ?? el.innerText ?? '', type: el.type, options: el.tagName === 'SELECT' ? [...el.options].map(o => ({ value: o.value, label: o.text })) : null })),
      });
    }
    const questionAction = /^(Skip|Previous question|Next question|Submit|Send|Continue|跳过|上一题|下一题|提交|发送|继续)$/i;
    const questionHash = value => {
      let h = 2166136261;
      for (const ch of value) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
      return (h >>> 0).toString(16);
    };
    for (const skip of query('button').filter(el => vis(el) && (el.innerText || '').trim() === 'Skip')) {
      let card = skip.parentElement, options = [], fields = [];
      for (let depth = 0; card && depth < 12; depth++, card = card.parentElement) {
        options = [...card.querySelectorAll('button[role="radio"]')].filter(vis);
        fields = [...card.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea, select, [contenteditable=true]')].filter(vis);
        if (options.length || fields.length) break;
      }
      if (!card || (!options.length && !fields.length)) continue;
      const buttons = [...card.querySelectorAll('button, [role=button], [role=radio]')].filter(vis).flatMap(el => {
        const label = (el.getAttribute('aria-label') || el.innerText || el.title || '').replace(/\s+/g, ' ').trim();
        if (!el.matches('[role="radio"]') && !questionAction.test(label)) return [];
        return [{ el, label: label || '选项', selected: el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true' || el.getAttribute('data-state') === 'checked', disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', ...codexPoint(el) }];
      });
      const clone = card.cloneNode(true);
      clone.querySelectorAll('button, [role=button], [role=radio], input, textarea, select, [contenteditable=true]').forEach(el => el.remove());
      const text = (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
      const fieldRows = fields.map(el => ({
        el,
        label: el.getAttribute('aria-label') || el.placeholder || el.name || '回答',
        value: el.value ?? el.innerText ?? '',
        type: el.tagName === 'SELECT' ? 'select' : el.type || 'text',
        options: el.tagName === 'SELECT' ? [...el.options].map(o => ({ value: o.value, label: o.text })) : null,
      }));
      const signature = [text, ...buttons.map(b => b.label), ...fieldRows.map(f => f.label)].join('\n');
      const id = 'question:' + questionHash(signature);
      if (!options.length && text === 'Codex 请求') continue;
      if (!rows.has(id)) rows.set(id, { id, text: text || buttons.filter(b => b.el.matches('[role="radio"]')).map(b => b.label).join(' / ') || 'Codex 请求', buttons, fields: fieldRows });
    }
    return [...rows.values()].filter(row => row.id.startsWith('async:') || row.id.startsWith('approval:') || row.text.trim() !== 'Codex 请求');
  };
  const codexRequestData = () => codexRequests().map(r => ({ id: r.id, text: String(r.text).slice(0, 6000), buttons: r.buttons.map(({ label, disabled, selected }) => ({ label, disabled, selected })), fields: r.fields.map(({ label, value, type, options }) => ({ label, value, type, options })) }));
  const codexRequestTarget = (id, n) => { const b = codexRequests().find(r => r.id === id)?.buttons[n]; return b?.el ? codexPoint(b.el) : null; };
  const codexRequestAction = async (id, n, fields = [], advance = false) => {
    for (const field of fields) {
      if (!codexRequestField(id, field.n, field.value)) throw new Error('请求输入框已不存在');
    }
    if (fields.length) {
      for (let i = 0; i < 20; i++) {
        const request = codexRequests().find(r => r.id === id);
        if (request && fields.every(f => request.fields[f.n]?.value === f.value)) break;
        if (i === 19) throw new Error('回答尚未同步到电脑');
        await new Promise(resolve => setTimeout(resolve, 16));
      }
    }
    const before = codexRequests().find(r => r.id === id);
    const button = before?.buttons[n];
    if (id.startsWith('async:') && (!button || button.disabled)) throw new Error(before ? '问题控件尚未就绪，请等待电脑端更新' : '这条问题已不在电脑端的待回答列表中');
    if (!button?.action) return false;
    await button.action();
    if (advance && id.startsWith('async:') && n < before.buttons.length - 2) {
      for (let i = 0; i < 20; i++) {
        const request = codexRequests().find(r => r.id === id);
        if (request?.fields[0]?.value === button.label && !request.buttons.at(-1).disabled) return codexRequestAction(id, request.buttons.length - 1);
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      throw new Error('选项尚未同步到电脑，请重试');
    }
    if (button.submit) {
      // Codex changes this key (lastSubmission), or removes the card, only after the reply is accepted.
      for (let i = 0; i < 150; i++) {
        const request = codexRequests().find(r => r.id === id);
        if (!request || request.submissionKey !== before.submissionKey) return true;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('电脑端尚未确认收到回答，请检查 Codex 中的请求状态');
    }
    return true;
  };
  const codexRequestField = (id, n, value) => {
    const field = codexRequests().find(r => r.id === id)?.fields[n];
    if (field?.onChange) { field.onChange(value); return true; }
    const el = field?.el;
    if (!el) return false;
    const w = el.ownerDocument.defaultView;
    if (el.isContentEditable) {
      el.focus();
      el.ownerDocument.execCommand('selectAll', false);
      el.ownerDocument.execCommand('insertText', false, value);
      return true;
    }
    const proto = el.tagName === 'TEXTAREA' ? w.HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? w.HTMLSelectElement.prototype : w.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new w.Event('input', { bubbles: true }));
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
    return true;
  };
  const codexImage = async src => {
    if (src.startsWith('codex-image:')) src = doc.defaultView.__remoteAgentChatImages.get(src);
    if (src.startsWith('data:image/')) {
      if (atob(src.slice(src.indexOf(',') + 1)).length > 8 * 1024 * 1024) throw new Error('图片超过预览限制');
      return src;
    }
    const r = await fetch(src);
    if (!r.ok) throw new Error('图片读取失败');
    const blob = await r.blob();
    if (!blob.type.startsWith('image/') || blob.size > 8 * 1024 * 1024) throw new Error('图片超过预览限制');
    return await new Promise((resolve, reject) => { const f = new FileReader(); f.onload = () => resolve(f.result); f.onerror = reject; f.readAsDataURL(blob); });
  };
  const codexSkills = () => {
    const queries = codexQueryClient()?.getQueryCache().getAll().filter(q => q.queryKey[0] === 'skills') || [];
    const skills = queries.flatMap(q => q.state.data?.data || []).flatMap(d => d.skills || []).filter(s => s.enabled);
    return [...new Map(skills.map(s => [s.path, { label: s.interface?.displayName || s.name, q: s.interface?.displayName || s.name, sub: `${s.name} · ${s.interface?.shortDescription || s.description || ''}`, section: 'skills', trigger: '/' }])).values()];
  };
  const codexChanges = () => {
    const files = new Map();
    const turns = [...doc.querySelectorAll('[data-turn-key]')];
    const entries = turns.length ? codexFiberProps(turns[0], 50).find(p => Array.isArray(p.entries))?.entries : null;
    let changed;
    if (entries) {
      const thread = codexThread(), scopes = codexHistoryScopes();
      const patchTurns = doc.__remoteCodexPatchTurns ||= new WeakMap();
      const mounted = new Map(turns.map(el => [el.getAttribute('data-turn-key'), el]));
      for (const entry of [...entries].reverse()) {
        if (entry.conversationId !== thread) continue;
        const el = mounted.get(entry.turnKey);
        let turn = entry.turn || (el && codexTurnData(el)) || patchTurns.get(entry);
        if (!turn) {
          turn = codexStoredTurn(entry, scopes, true);
          if (turn?.status === 'complete' && !entry.isLatestTurn) patchTurns.set(entry, turn);
        }
        if (turn?.items?.some(item => item.type === 'patch')) { changed = turn; break; }
      }
    } else {
      const changedTurn = [...turns].reverse().find(el => codexTurnData(el)?.items?.some(item => item.type === 'patch'));
      changed = codexTurnData(changedTurn || doc.body);
    }
    for (const item of changed?.items || []) {
      if (item.type !== 'patch') continue;
      for (const [name, change] of Object.entries(item.changes || {})) {
        const diff = typeof change === 'string' ? change : change.unified_diff || change.diff || change.unifiedDiff || (change.type === 'add' ? String(change.content || '').replace(/\n$/, '').split('\n').map(l => '+' + l).join('\n') : '');
        const lines = diff.split('\n');
        const previous = files.get(name);
        const add = lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
        const del = lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length;
        files.set(name, { name, add: diff ? '+' + (add + Number(previous?.add || 0)) : '未获取', del: diff ? '-' + (del + Math.abs(Number(previous?.del || 0))) : '', diff: [previous?.diff, diff].filter(Boolean).join('\n') });
      }
    }
    const last = [...turns].reverse().find(el => buttonsIn(el, false).some(b => /^(Undo|Apply|Revert|View changes|View changed files|View file changes)$/.test(b.label)));
    const actions = last ? buttonsIn(last, false).filter(b => /^(Undo|Apply|Revert|View changes|View changed files|View file changes)$/.test(b.label)).map(b => b.label) : [];
    return { files: [...files.values()], actions, count: files.size, turn: last?.getAttribute('data-turn-key') || '' };
  };
  const codexChangeTarget = label => {
    const turn = codexChanges().turn;
    const el = [...doc.querySelectorAll('[data-turn-key]')].find(el => el.getAttribute('data-turn-key') === turn);
    const b = el && buttonsIn(el, false).find(b => b.label === label);
    return b ? codexPoint(b.el) : null;
  };
  const codexFacts = () => {
    if (!doc.querySelector('button[aria-label="Add files and more"]')) return null;
    let plan = false, ideStatus = '', autoContext, hasDraftAttachments;
    const add = doc.querySelector('button[aria-label="Add files and more"]');
    let fiber = add?.[Object.keys(add).find(k => k.startsWith('__reactFiber'))];
    for (let i = 0; i < 40 && fiber; i++) {
      const props = fiber.memoizedProps || {};
      if (!plan && props.activeCollaborationMode?.mode) plan = props.activeCollaborationMode.mode === 'plan';
      if (!ideStatus && typeof props.ideContextStatus === 'string') ideStatus = props.ideContextStatus;
      if (typeof props.isAutoContextOn === 'boolean') autoContext = props.isAutoContextOn;
      if (typeof props.hasDraftAttachments === 'boolean') hasDraftAttachments = props.hasDraftAttachments;
      fiber = fiber.return;
    }
    const ideBtn = [...doc.querySelectorAll('button')].find(e => vis(e) && /IDE context/i.test(e.getAttribute('aria-label') || ''));
    const runBtn = [...doc.querySelectorAll('button')].find(e => vis(e) && (e.getAttribute('aria-label') || '') === 'Select where to run the chat');
    const ideOn = autoContext ?? (ideBtn ? /^turn off/i.test(ideBtn.getAttribute('aria-label') || '') : false);
    let file = null;
    if (ideOn) {
      const active = codexQueryClient()?.getQueryData(['ide-context', null])?.activeFile;
      const sel = active?.selection;
      const start = sel?.start?.line;
      const end = sel?.end?.line;
      const range = Number.isInteger(start) && (start !== end || sel.start.character !== sel.end.character) ? `${start + 1}-${(end ?? start) + 1}` : '';
      if (active?.label) file = { label: active.label, path: active.path || '', range };
    }
    const follow = codexQueryClient()?.getQueryData(['vscode', 'get-settings'])?.values?.followUpQueueMode || '';
    const run = runBtn ? (runBtn.innerText || '').replace(/\s+/g, ' ').trim() : '';
    return {
      queued: codexQueued(),
      hasDraftAttachments: hasDraftAttachments === true,
      view: {
        plan, follow, run, enter: codexQueryClient()?.getQueryData(['vscode', 'get-settings'])?.values?.composerEnterBehavior || 'enter',
        actions: !!codexButtonPoint('actions'),
        ide: ideBtn || ideStatus ? { on: ideOn, file: ideOn ? file : null } : null,
      },
    };
  };
