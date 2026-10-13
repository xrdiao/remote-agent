  const codexButton = label => [...doc.querySelectorAll('button')].find(e => vis(e) && (e.getAttribute('aria-label') || '') === label)
    || [...doc.querySelectorAll('button')].find(e => vis(e) && (e.getAttribute('aria-label') || '').startsWith(label));
  const codexPoint = el => {
    const c = center(el);
    const frame = document.getElementById('active-frame');
    if (!frame || el.ownerDocument === document) return c;
    const o = frame.getBoundingClientRect();
    return { x: c.x + o.x, y: c.y + o.y };
  };
  const codexRecentPoint = () => { const b = codexButton('Recent chats'); return b ? codexPoint(b) : null; };
  const codexNewPoint = () => { const b = codexButton('New chat'); return b ? codexPoint(b) : null; };
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
  const codexArchiveTarget = id => {
    const menu = [...doc.querySelectorAll('[role=menu]')].find(e => vis(e) && /Search recent chats/.test(e.innerText || ''));
    if (!menu) return null;
    for (const el of menu.querySelectorAll('[role=button]')) {
      const hit = codexFiberProps(el).some(p => p.conversationId === id || (typeof p.href === 'string' && p.href.endsWith('/' + id)));
      if (!hit) continue;
      const buttons = [...el.querySelectorAll('button')].filter(b => b.getBoundingClientRect().width > 0);
      const labels = buttons.map(b => b.getAttribute('aria-label') || '');
      const action = labels.includes('Delete chat') ? 'Delete chat' : labels.includes('Archive chat') ? 'Archive chat' : '';
      const btn = buttons.find(b => (b.getAttribute('aria-label') || '') === action);
      if (!btn) return { action: '' };
      el.scrollIntoView({ block: 'nearest' });
      return { action, ...codexPoint(btn) };
    }
    return null;
  };
  const codexArchiveConfirm = () => {
    const dialog = [...doc.querySelectorAll('[role=dialog]')].find(e => vis(e) && e.getBoundingClientRect().height > 20);
    if (!dialog) return null;
    const buttons = [...dialog.querySelectorAll('button')].filter(vis);
    const btn = buttons.find(b => /^(Archive chat|Delete chat|Archive|Delete)$/i.test(((b.innerText || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())));
    if (!btn) return { label: '' };
    return { label: (btn.innerText || btn.getAttribute('aria-label') || '').trim(), ...codexPoint(btn) };
  };

  const codexPromptEl = () => doc.querySelector('.ProseMirror[contenteditable="true"]');
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
  const codexButtonPoint = which => {
    const buttons = [...doc.querySelectorAll('button')].filter(vis);
    const el = which === 'ide' ? buttons.find(b => /IDE context/i.test(b.getAttribute('aria-label') || ''))
      : which === 'run' ? buttons.find(b => (b.getAttribute('aria-label') || '') === 'Select where to run the chat')
      : which === 'actions' ? buttons.find(b => (b.getAttribute('aria-label') || '') === 'Chat actions')
      : null;
    return el ? codexPoint(el) : null;
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
    const value = codexQueryClient()?.getQueryData(['vscode', 'get-global-state', '{"key":"queued-follow-ups"}'])?.value;
    const raw = value && typeof value === 'object' ? value[thread] : null;
    if (!Array.isArray(raw)) return [];
    return raw.map((m, n) => ({
      id: String(m?.id || `cq${n}`),
      t: String(m?.text || m?.message || m?.content || '').slice(0, 4000),
      src: 'codex',
    })).filter(m => m.t);
  };
  const codexQueueAction = async (id, action) => {
    if (!codexQueued().some(m => m.id === id)) return false;
    const name = { send: 'onSendNowMessage', remove: 'onDeleteMessage', edit: 'onEditMessage' }[action];
    for (const el of doc.querySelectorAll('button')) {
      for (const p of codexFiberProps(el, 32)) {
        const actions = p.messageListActions || p;
        if (typeof actions[name] === 'function') { await actions[name](id); return true; }
      }
    }
    return false;
  };
  // Read pending native cards, keeping their real controls rather than reproducing approval semantics.
  const codexRequests = () => {
    if (!codexThread()) return [];
    const rows = new Map();
    const query = selector => [...new Set([doc, document])].flatMap(d => [...d.querySelectorAll(selector)]);
    for (const skip of query('[data-request-input-dismiss]').filter(vis)) {
      const props = codexFiberProps(skip, 48).find(p => Array.isArray(p.questions) && typeof p.onDraftChange === 'function' && typeof p.onSubmit === 'function');
      if (!props) continue;
      const index = props.questionIndex;
      const question = props.questions[index];
      if (!question) continue;
      const id = 'async:' + question.id;
      const buttons = question.options.map(option => ({ label: option, selected: question.draft === option, disabled: !!props.isSubmitting, action: () => props.onDraftChange(option) }));
      buttons.push({ el: skip, label: skip.innerText || 'Skip', disabled: !!props.isSubmitting });
      buttons.push({ label: index < props.questions.length - 1 ? 'Next' : props.hasSubmitted ? 'Send update' : 'Send', disabled: !!props.isSubmitting || !question.draft.trim(), action: () => index < props.questions.length - 1 ? props.onQuestionChange(index + 1) : props.onSubmit() });
      rows.set(id, { id, text: question.question, buttons, fields: [{ label: '回答', value: question.draft, type: 'text', onChange: props.onDraftChange }] });
    }
    for (const el of query('button, input, textarea, select, [role=radio], [role=checkbox]')) {
      if (!vis(el) || el.closest('[contenteditable=true]')) continue;
      const props = codexFiberProps(el, 32).find(p => p.request?.item?.requestId || (p.item?.requestId && (p.onReply || p.onApprove || p.onSubmit)));
      const request = props?.request || (props?.item ? props : null);
      const item = request?.item;
      if (!item) continue;
      const id = String(item.requestId);
      if (!rows.has(id)) rows.set(id, { id, text: item.title || item.reason || item.command || (item.questions || []).map(q => q.question || q.title || q.header).join('\n') || request.kind || 'Codex 请求', buttons: [], fields: [] });
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
    return [...rows.values()];
  };
  const codexRequestData = () => codexRequests().map(r => ({ id: r.id, text: String(r.text).slice(0, 6000), buttons: r.buttons.map(({ label, disabled, selected }) => ({ label, disabled, selected })), fields: r.fields.map(({ label, value, type, options }) => ({ label, value, type, options })) }));
  const codexRequestTarget = (id, n) => { const b = codexRequests().find(r => r.id === id)?.buttons[n]; return b?.el ? codexPoint(b.el) : null; };
  const codexRequestAction = async (id, n, fields = []) => {
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
    const button = codexRequests().find(r => r.id === id)?.buttons[n];
    if (!button?.action || button.disabled) return false;
    await button.action();
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
    const changedTurn = [...turns].reverse().find(el => codexTurnData(el)?.items?.some(item => item.type === 'patch'));
    for (const item of codexTurnData(changedTurn || doc.body)?.items || []) {
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
    const last = [...turns].reverse().find(el => buttonsIn(el, false).some(b => /^(Undo|Apply|Revert|View changes|View changed files)$/.test(b.label)));
    const actions = last ? buttonsIn(last, false).filter(b => /^(Undo|Apply|Revert|View changes|View changed files)$/.test(b.label)).map(b => b.label) : [];
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
    let plan = false, ideStatus = '', autoContext;
    const add = doc.querySelector('button[aria-label="Add files and more"]');
    let fiber = add?.[Object.keys(add).find(k => k.startsWith('__reactFiber'))];
    for (let i = 0; i < 40 && fiber; i++) {
      const props = fiber.memoizedProps || {};
      if (!plan && props.activeCollaborationMode?.mode) plan = props.activeCollaborationMode.mode === 'plan';
      if (!ideStatus && typeof props.ideContextStatus === 'string') ideStatus = props.ideContextStatus;
      if (typeof props.isAutoContextOn === 'boolean') autoContext = props.isAutoContextOn;
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
      view: {
        plan, follow, run, enter: codexQueryClient()?.getQueryData(['vscode', 'get-settings'])?.values?.composerEnterBehavior || 'enter',
        actions: !!codexButtonPoint('actions'),
        ide: ideBtn || ideStatus ? { on: ideOn, file: ideOn ? file : null } : null,
      },
    };
  };
