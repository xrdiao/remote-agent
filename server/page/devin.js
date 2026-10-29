  const THINKING_ROOT = '.ui-thinking-collapsible, .chat-thinking-box, .highlight-wrapper';
  const ROW_SEL = `${ITEM_SEL}, ${THINKING_ROOT}`;
  const topItems = panel => [...panel.querySelectorAll(ROW_SEL)].filter(e => vis(e) && !e.parentElement?.closest(ROW_SEL));
  const thinkingHeaderEl = el => el.matches('.ui-thinking-collapsible')
    ? el.querySelector('.ui-collapsible-header')
    : el.matches('.chat-thinking-box')
      ? (el.querySelector('.chat-used-context-label .monaco-button, .chat-used-context-label button') || el.querySelector('.chat-used-context-label'))
      : el.querySelector('[class*="event-header"]');
  // Devin's expanded header is not the toggle; the chevron button is.
  const thinkingToggleEl = el => el.querySelector('button[aria-expanded]') || thinkingHeaderEl(el);
  const thinkingBodyEl = el => el.matches('.ui-thinking-collapsible')
    ? el.querySelector('.ui-collapsible-content')
    : el.matches('.chat-thinking-box')
      ? el.querySelector('.chat-thinking-item')
      : el.querySelector('.ui-collapsible-content, .self-start');
  const thinkingPlain = el => (thinkingBodyEl(el)?.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+$/, '');
  const thinkingTitleOf = el => (thinkingHeaderEl(el)?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const thinkingLive = el => el.classList.contains('chat-thinking-active')
    || !!el.querySelector('[data-loading]')
    || /^thinking\b/i.test(thinkingTitleOf(el));
  const thinkingNodes = () => {
    const rooted = [...doc.querySelectorAll(THINKING_ROOT)].filter(el => el.matches('.ui-thinking-collapsible, .chat-thinking-box') || /^(thinking|thoughts|thought(?: for)? )\b/i.test(thinkingTitleOf(el)));
    const rows = [...doc.querySelectorAll('[data-message-kind="thinking"]')].filter(el => !rooted.some(r => r === el || r.contains(el) || el.contains(r)));
    return [...rooted, ...rows];
  };
  // 'live' is still generating; 'done' has finished and folded its body away.
  const closedThinkingIndexes = (which = 'live') => {
    const idxs = thinkingNodes().flatMap((el, i) => {
      const live = thinkingLive(el);
      if (which === 'live' ? !live : live) return [];
      if (thinkingPlain(el).trim()) return [];
      const header = thinkingToggleEl(el);
      if (!header || header.getAttribute('aria-expanded') === 'true') return [];
      return [i];
    });
    // Finished blocks: read the newest ones. Older traces are optional.
    return (which === 'done' ? idxs.slice(-2) : idxs.slice(0, 4));
  };
  const clickThinking = indexes => {
    const nodes = thinkingNodes();
    for (const i of indexes || []) nodes[i] && thinkingToggleEl(nodes[i])?.click();
    return true;
  };
  // The current layout can change inside an IDE window without changing its window configuration.
  const devinSurface = () => {
    const modes = [...document.querySelectorAll('button[id*="devin-editor-mode-menu"]')];
    if (modes.length) {
      const picker = modes.find(vis);
      return picker && codexFiberProps(picker, 24).find(p => p.mode === 'agent' || p.mode === 'editor')?.mode || null;
    }
    const segments = [...document.querySelectorAll('button.switch-segment')];
    const seg = segments.find(e => vis(e) && e.classList.contains('active'));
    if (seg) return seg.classList.contains('agent-segment') ? 'agent' : 'editor';
    if (segments.length) return null;
    const configuration = window.vscode?.context?.configuration?.();
    if (configuration?.product?.applicationName !== 'devin-desktop' || typeof configuration.desktopShellOwnsWindow !== 'boolean') return null;
    return configuration.desktopShellOwnsWindow ? 'agent' : 'editor';
  };
  const devinRowSession = s => {
    const id = s?.sessionId || s?.devin_id || '';
    if (!id) return '';
    const nativeId = id.replace(/^devin-/, '');
    if (nativeId.startsWith('acp/')) return nativeId;
    return window.__acpStore?.getState().acp.sessions.find(session => session.providerId === 'devin-cloud'
      && session.sessionId === `acp/devin-cloud/${nativeId}`)?.sessionId || '';
  };
  const devinNodeSessionId = el => {
    const props = codexFiberProps(el, Infinity);
    const id = props.find(p => typeof p.sessionId === 'string' && p.sessionId)?.sessionId
      || props.map(p => devinRowSession(p.session) || devinRowSession({ devin_id: p.value?.devinId })).find(Boolean) || '';
    return devinRowSession({ sessionId: id });
  };
  const devinCatalogRow = session => ({
    id: devinRowSession(session), title: session.title || '', titleNative: !!session.title, titleAt: Date.now(),
    workspace: session.cwd || '', running: ['active', 'pending', 'canceling'].includes(session.status), lastUsed: 0,
  });
  const devinTranscriptRows = log => !log ? [] : log.matches('[data-chat-history-variant]')
    ? [...log.querySelectorAll('[data-transcript-row-key]')].filter(row => row.closest('[data-chat-history-variant]') === log)
    : [...log.children];
  const devinTranscriptIndex = el => {
    const row = el.closest('[data-transcript-row-key]');
    if (!row?.closest('[data-chat-history-variant]')) return null;
    const props = codexFiberProps(row, 40);
    const data = props.find(p => p.row)?.row;
    const sessionId = devinNodeSessionId(row);
    const messages = window.__acpStore?.getState()?.acp?.perSession?.[sessionId]?.messages;
    const index = messages?.findIndex(message => message.id === data?.item?.id || data?.memberIds?.includes(message.id));
    return index >= 0 ? index : null;
  };
  const surfaceTarget = (to, select = false) => {
    const seg = [...document.querySelectorAll(`button.switch-segment.${to}-segment`)].find(vis);
    if (seg) { if (select) { seg.click(); return true; } return center(seg); }
    const picker = [...document.querySelectorAll('button[id*="devin-editor-mode-menu"]')].find(vis);
    if (!picker) return null;
    if (!select) return center(picker);
    const props = codexFiberProps(picker, 24).find(p => (p.mode === 'agent' || p.mode === 'editor') && typeof p.onSelect === 'function');
    if (!props) throw new Error('Devin 原生视图切换入口尚未就绪');
    props.onSelect(to);
    return true;
  };
  const transcriptVisible = () => { const l = devinLog(); return (!!l && vis(l)) || [...document.querySelectorAll('[role="textbox"][aria-label="Prompt"]')].some(vis); };
  // IDE history is a native conversation picker, separate from the Agents sidebar.
  const sessionSearchTarget = () => {
    const b = [...document.querySelectorAll('button[aria-label]')].find(e => vis(e) && !e.disabled && /^(?:Past Conversations|Search agents\b)/.test(e.getAttribute('aria-label')));
    const input = doc.querySelector('input[placeholder="Search"][data-kb-navigate]');
    return b ? { ...center(b), open: !!input && vis(input) } : null;
  };
  const devinPickerSessions = async () => {
    const native = await import('@exa/chat-client');
    let sessions = native.filterActiveSessions(window.__acpStore.getState().acp.sessions);
    const connectors = native.tryGetAcpSingleton('connectorService');
    if (connectors?.hasReceivedConnectors()) {
      const ids = new Set(connectors.getConnectors().map(c => c.id));
      sessions = sessions.filter(s => s.providerId === 'cascade' || ids.has(s.providerId));
    }
    return native.sortSessions(sessions);
  };
  const sessionPickerRows = async (catalog = false) => {
    if (catalog) {
      const selected = devinTabs().find(tab => tab.active)?.id;
      return (await devinPickerSessions()).map(session => ({ ...devinCatalogRow(session), current: session.sessionId === selected }));
    }
    const rows = [...doc.querySelectorAll('div[data-kb-navigate="true"][tabindex="0"]')].flatMap(row => {
      const session = codexFiberProps(row, 12).find(p => devinRowSession(p.session))?.session;
      return session ? [{ id: devinRowSession(session), title: session.title || '', titleNative: !!session.title,
        titleAt: Date.now(), workspace: session.cwd || '', running: ['active', 'pending', 'canceling'].includes(session.status) }] : [];
    });
    if (rows.length) return rows;
    const w = [...document.querySelectorAll('.quick-input-widget')].find(vis);
    if (!w) return null;
    const sessions = await devinPickerSessions();
    return [...w.querySelectorAll('.monaco-list-row')].filter(vis).map(row => {
      const title = ((row.querySelector('.label-name') || row).innerText || '').trim().split('\n')[0].slice(0, 80);
      const session = sessions[Number(row.getAttribute('data-index'))];
      return { id: devinRowSession(session), title: session?.title || title, titleNative: !!session?.title, titleAt: Date.now(), running: /\bworking\b/i.test(row.innerText || '') };
    }).filter(r => r.title && r.id);
  };
  // Devin sessions use native ids. The Editor surface keeps the open sessions as tabs above
  // the transcript (the active one has the active-tab background); the Agent surface uses the sidebar.
  const sessNorm = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  // The tabs live in the chat panel (#chat) even when the open session is empty and has no transcript.
  const devinTabEls = () => [...document.querySelectorAll('#chat [draggable="true"]')].filter(e => vis(e) && /h-\[34px\]/.test(String(e.className)));
  const devinTabs = () => devinTabEls().map(t => {
    const id = codexFiberProps(t, 24).find(p => p.sessionId)?.sessionId || '';
    const session = window.__acpStore?.getState().acp.sessions.find(s => devinRowSession(s) === id);
    return { id, title: session?.title || sessNorm((t.querySelector('span') || t).innerText),
      titleNative: !!session?.title, titleAt: Date.now(), active: /bg-ide-tab-active-background-color/.test(String(t.className)) };
  }).filter(t => t.title);
  const devinSession = () => {
    if (!devinLog() && !devinSurface()) return null;
    const tabs = devinTabs(), surface = devinSurface();
    const active = agentList().find(a => a.current);
    const tab = surface === 'editor' ? devinTabEls()[tabs.findIndex(t => t.active)] : null;
    const node = devinLog() || tab || [...doc.querySelectorAll('[role="textbox"][aria-label="Prompt"]')].find(vis)
      || (surface === 'editor' ? doc.querySelector('.editor-group-container.has-pending-new-session-welcome [role="textbox"][aria-label="Prompt"]') : null);
    const key = (surface === 'agent' ? active?.id : '') || devinNodeSessionId(node);
    const session = window.__acpStore?.getState().acp.sessions.find(s => devinRowSession(s) === key);
    const title = (surface === 'editor' ? tabs.find(t => t.active)?.title : active?.title) || '';
    return { key, title, surface, tabs, cwd: (surface === 'agent' ? active?.workspace : '') || session?.cwd || active?.workspace || '' };
  };
  const devinTabTarget = id => {
    const el = devinTabEls().find(t => codexFiberProps(t, 24).some(p => p.sessionId === id));
    if (!el) return null;
    const r = (el.querySelector('span') || el).getBoundingClientRect();
    return { x: r.x + Math.min(r.width / 2, 40), y: r.y + r.height / 2 };
  };
  const clickDevinTab = id => {
    const el = devinTabEls().find(t => codexFiberProps(t, 24).some(p => p.sessionId === id));
    if (!el) return false;
    el.click();
    return true;
  };
  // The tab's own close button (an icon at its right edge, hover-revealed); null while it has no size.
  const devinTabCloseTarget = id => {
    const el = devinTabEls().find(t => codexFiberProps(t, 24).some(p => p.sessionId === id));
    const b = el?.querySelector('button');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return r.width > 2 && r.height > 2 ? { x: r.x + r.width * 0.78, y: r.y + r.height / 2 } : null;
  };
  const clickDevinTabClose = id => {
    const el = devinTabEls().find(t => codexFiberProps(t, 24).some(p => p.sessionId === id));
    el.querySelector('button').click();
  };
  const sessionPickerTarget = async (id, select = false) => {
    const nativeRow = [...doc.querySelectorAll('div[data-kb-navigate="true"][tabindex="0"]')]
      .find(row => codexFiberProps(row, 12).some(p => devinRowSession(p.session) === id));
    if (nativeRow) {
      if (select) {
        const props = codexFiberProps(nativeRow, 12).find(p => devinRowSession(p.session) === id && typeof p.onOpen === 'function');
        if (!props) return null;
        props.onOpen();
        return true;
      }
      nativeRow.scrollIntoView({ block: 'nearest' });
      return center(nativeRow);
    }
    const index = (await devinPickerSessions()).findIndex(s => devinRowSession(s) === id);
    if (index < 0) return null;
    const widget = [...document.querySelectorAll('.quick-input-widget')].find(vis);
    const scroller = widget?.querySelector('.monaco-list .monaco-scrollable-element');
    const first = widget?.querySelector('.monaco-list-row');
    if (scroller && first) {
      scroller.scrollTop = index * first.getBoundingClientRect().height;
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    const row = [...(widget?.querySelectorAll('.monaco-list-row') || [])].find(r => Number(r.getAttribute('data-index')) === index);
    if (!row) return null;
    if (select) { row.click(); return true; }
    row.scrollIntoView({ block: 'nearest' });
    return center(row);
  };

  // Devin "Revert to this point": a hover-only button at the left edge of a user message row.
  // Unverified on the live window (never clicked while developing); the dialog is read generically.
  const revertTarget = (i, part) => {
    const row = [...(devinLog()?.children || [])].find(r => itemKey(r) === i);
    if (!row || !row.querySelector('[role=group][aria-label="User message"]')) return null;
    if (part === 'row') { row.scrollIntoView({ block: 'center' }); return center(row); }
    const b = [...row.querySelectorAll('button')].find(x => /absolute/.test(x.className) && /left-full/.test(x.className));
    return b && vis(b) ? center(b) : null;
  };
  // Revert opens a preview that either confirms by itself (no file changes to undo: the transcript just
  // rewinds, no dialog) or, after ~0.5 s, a dialog listing the file changes with an "Apply these reverts"
  // checkbox and a Confirm (or Force revert) button.
  const revertConfirmBtn = () => [...document.querySelectorAll('button')].find(b => vis(b) && /^(Confirm|Force revert)$/.test((b.innerText || '').trim()) && !b.closest('[data-band-item]'));
  const revertDialogEl = () => {
    const b = revertConfirmBtn();
    if (!b) return null;
    const d = b.closest('[role="dialog"], [role="alertdialog"]');
    if (d) return d;
    let p = b;
    for (let i = 0; i < 8 && p.parentElement; i++) {
      p = p.parentElement;
      if (/^(fixed|absolute)$/.test(getComputedStyle(p).position) && p.getBoundingClientRect().width > 200) return p;
    }
    return b.parentElement?.parentElement || null;
  };
  const revertDialog = () => {
    const d = revertDialogEl();
    if (!d) return null;
    const box = d.querySelector('input[type="checkbox"]');
    return {
      title: ((d.querySelector('h1, h2, h3') || {}).innerText || '').trim().slice(0, 120),
      body: (d.innerText || '').trim().slice(0, 1200),
      apply: box ? box.checked : null,
      force: /force/i.test(revertConfirmBtn()?.innerText || ''),
    };
  };
  const revertDialogButton = which => {
    const d = revertDialogEl();
    if (!d) return null;
    if (which === 'toggle') { const t = d.querySelector('label') || d.querySelector('input[type="checkbox"]'); return t ? center(t) : null; }
    const cancel = b => /cancel|close|取消|关闭/i.test((b.innerText || b.getAttribute('aria-label') || '').trim());
    const btns = [...d.querySelectorAll('button')].filter(vis);
    const b = which === 'cancel' ? btns.find(cancel) : revertConfirmBtn();
    return b ? center(b) : null;
  };
  // Is the user message still in the transcript, and what is the highest index mounted?
  const revertState = i => {
    const rows = [...(devinLog()?.children || [])];
    const nums = rows.map(r => Number(/^acp(\d+)/.exec(itemKey(r) || '')?.[1])).filter(n => Number.isFinite(n));
    const row = rows.find(r => itemKey(r) === i);
    return { rowHas: !!row && !!row.querySelector('[role=group][aria-label="User message"]'), max: nums.length ? Math.max(...nums) : -1 };
  };

  // Devin thoughts by item id (acpN:think): the row's chevron, its open state, and its body text
  // (same lines devinItems reads: the event group minus its title). Collapsed rows carry no body.
  const thoughtRow = id => [...(devinLog()?.children || [])].find(r => itemKey(r) === String(id).replace(/:think$/, ''));
  const thoughtState = id => {
    const b = thoughtRow(id)?.querySelector('button[aria-expanded]');
    return b ? { expanded: b.getAttribute('aria-expanded') === 'true' } : null;
  };
  const setThoughtOpen = (id, open) => {
    const b = thoughtRow(id)?.querySelector('button[aria-expanded]');
    if (!b) return false;
    if ((b.getAttribute('aria-expanded') === 'true') !== open) b.click();
    return true;
  };
  const thoughtBodyText = id => {
    const row = thoughtRow(id);
    const eg = row && (row.classList.contains('event-group') ? row : row.querySelector('.event-group'));
    if (!eg) return '';
    return (eg.innerText || '').split('\n').map(s => s.trim()).filter(Boolean).slice(1).join('\n');
  };

  // Devin: transcript index (for clickThinking) of the thought with item id `acpN:think`.
  const thoughtIndexFor = id => thinkingNodes().findIndex(el => {
    const row = el.closest('[data-acp-msg-index]');
    return !!row && `${itemKey(row)}:think` === id;
  });
  const closeThinkingIfOpen = indexes => {
    const nodes = thinkingNodes();
    for (const i of indexes || []) {
      const el = nodes[i];
      if (el && thinkingPlain(el)) thinkingToggleEl(el)?.click();
    }
    return true;
  };

  // Messages sent while the Agent is running wait in Cursor's queue tray until the current turn ends.
  const QUEUE_ROW = '[data-queue-row], .composer-toolbar-queue-item[data-queue-item-id]';
  const queueRows = () => [...doc.querySelectorAll(QUEUE_ROW)].filter(vis);
  const queued = (full = false) => queueRows().map(e => ({
    id: e.dataset.queueItemId,
    t: full ? (e.dataset.queueItemQuery || e.innerText || '').trim() : (e.dataset.queueItemQuery || e.innerText || '').trim().slice(0, 4000),
  }));
  // The submit button becomes "Stop generation" while a turn is running.
  // The stop icon on a human bubble (Ctrl+Shift+Backspace) reverts that message instead.
  const stopGenerationButton = () => [...doc.querySelectorAll('button, [role=button]')].find(e => {
    if (!vis(e) || e.closest('.composer-human-message, .human-message-action-slot')) return false;
    const label = (e.getAttribute('aria-label') || '').trim();
    return /^stop generation\b/i.test(label) || (doc.querySelector('[data-turn-key], [data-codex-intelligence-trigger]') && /^(Stop|Stop generating)$/i.test(label));
  });
  const legacyStopIcon = () => [...document.querySelectorAll('.composer-button-area .codicon-debug-stop, .send-with-mode .codicon-debug-stop')].find(e => vis(e) && !e.closest('.composer-human-message, .human-message-action-slot'));
  // Devin: while a turn runs the submit button reads "Cancel" (empty input) or "Queue" (typed text).
  const devinSubmitBusy = () => {
    if (!devinSurface()) return false;
    const id = devinSession()?.key;
    const session = window.__acpStore?.getState().acp.sessions.find(s => devinRowSession(s) === id);
    return ['active', 'pending', 'canceling'].includes(session?.status);
  };
  const isBusy = () => !!stopGenerationButton() || !!legacyStopIcon() || devinSubmitBusy() || [...doc.querySelectorAll('button')].some(e => vis(e) && /^(Stop|Stop generating)$/i.test((e.getAttribute('aria-label') || '').trim()))
    || ([...doc.querySelectorAll('button[aria-label="Queue"], button[aria-label="Steer"]')].some(vis) && !!codexThread());
  // Devin's queue (verified live): a bar "N message(s) queued" with a "Clear all" button, then an <ol>
  // of li[role=button] rows holding the message text. Hovering a row reveals "Edit message",
  // "Remove from queue" and "Send now" (hidden until hover). Rows are read from textContent.
  const devinQueueText = () => devinQueueBar()?.innerText || '';
  const devinQueueBar = () => [...document.querySelectorAll('span.text-12')].find(s => {
    const text = s.innerText || '';
    return /\d+\s+messages?\s+queued/i.test(text) || /排队(?:中)?\s*\d+\s*条/.test(text);
  });
  const devinQueueCount = () => {
    const text = devinQueueText();
    return Number(/(\d+)\s+messages?\s+queued/i.exec(text)?.[1] || /排队(?:中)?\s*(\d+)\s*条/.exec(text)?.[1]) || 0;
  };
  const devinQueueRows = () => devinQueueBar() ? [...document.querySelectorAll('ol li[role="button"]')].filter(e => /cursor-grab/.test(e.className)) : [];
  const devinQueued = () => devinQueueRows().map((row, n) => ({
    id: `dq${n}`,
    t: (row.innerText || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000),
    src: 'devin',
  }));
  const devinQueueTarget = (n, action) => {
    const row = devinQueueRows()[Number(n)];
    if (!row || !vis(row)) return null;
    if (!action) return center(row);
    const label = { send: 'Send now', remove: 'Remove from queue' }[action];
    const b = label && [...row.querySelectorAll('button[aria-label]')].find(e => vis(e) && e.getAttribute('aria-label') === label);
    return b ? center(b) : null;
  };
  const devinQueueClearTarget = () => {
    const b = [...document.querySelectorAll('button[aria-label="Clear all"]')].find(vis);
    return b && devinQueueBar() ? center(b) : null;
  };

  // First call (no action) returns the row center to hover over; hover-only buttons appear after that.
  const queueTarget = (id, action) => {
    const row = queueRows().find(e => e.dataset.queueItemId === id);
    if (!row) return null;
    row.scrollIntoView({ block: 'nearest' });
    if (!action) return center(row);
    const b = row.querySelector(`[data-queue-action="${CSS.escape(action)}"]`)
      || [...row.querySelectorAll('[aria-label]')].find(e => e.getAttribute('aria-label') === { send: 'Send now', remove: 'Remove', edit: 'Edit' }[action]);
    if (!b || !vis(b)) return null;
    const p = center(b);
    return b.contains(doc.elementFromPoint(p.x, p.y)) ? p : (b.click(), true);
  };

  // Running subagents: task cards in the transcript plus the "N subagents running" tray above the composer.
  // Clicking a tray row opens that subagent's own transcript as a chat-editor tab (no composer there).
  const SUB_ROW = '.composer-toolbar-background-job-item';
  const subRowName = e => e.querySelector('.composer-toolbar-background-job-item-text')?.innerText.trim() || '';
  const subagents = () => {
    const names = new Set();
    for (const h of doc.querySelectorAll('.task-tool-call-header')) {
      if (!vis(h) || !h.closest(ITEM_SEL)?.querySelector('.ui-subagent-status-indicator--running-loader, .task-subagent-header-pill-button--stop')) continue;
      const n = h.querySelector('span.truncate')?.childNodes[0]?.textContent.trim();
      if (n) names.add(n);
    }
    for (const r of doc.querySelectorAll(SUB_ROW)) if (subRowName(r)) names.add(subRowName(r));
    return [...names];
  };
  const subTrayHeader = () => [...doc.querySelectorAll('div')].find(e => vis(e) && [...e.childNodes].some(n => n.nodeType === 3 && /^\d+ subagents? running$/.test(n.textContent.trim())));
  const subTarget = (name, part) => {
    const row = [...doc.querySelectorAll(SUB_ROW)].find(r => vis(r) && subRowName(r) === name);
    if (!row) { const h = subTrayHeader(); return h ? { expand: true, ...center(h) } : null; }
    if (part === 'stop') {
      const s = [...row.querySelectorAll('span.truncate')].find(e => e.innerText.trim() === 'Stop');
      return s ? center(s) : null;
    }
    return center(row.querySelector('.composer-toolbar-background-job-item-text') || row);
  };
  const activeChatTab = () => [...doc.querySelectorAll('.tab.active')].map(e => e.getAttribute('aria-label') || '').find(l => /Chat Editors/.test(l)) || null;
  const tabTarget = label => {
    const t = [...doc.querySelectorAll('.tab')].find(e => vis(e) && e.getAttribute('aria-label') === label);
    return t ? center(t) : null;
  };
  // A new Devin session draws its composer inside the welcome layer. Devin hides that
  // layer while any file tab is open, so the model chip and prompt have a 0-size box.
  // Show the welcome until the new session is no longer pending. The file tab stays open.
  const revealDevinComposer = () => {
    const groups = [...doc.querySelectorAll('.editor-group-container')];
    for (const group of groups) {
      if (group.classList.contains('has-pending-new-session-welcome')) continue;
      for (const el of group.querySelectorAll('[data-crl-devin-reveal]')) {
        el.style.removeProperty('display');
        el.removeAttribute('data-crl-devin-reveal');
      }
    }
    let shown = false;
    for (const group of groups) {
      if (!group.classList.contains('has-pending-new-session-welcome')) continue;
      const welcome = group.querySelector(':scope > .windsurf-welcome-container');
      const editor = group.querySelector(':scope > .editor-container');
      if (welcome && getComputedStyle(welcome).display === 'none') {
        welcome.style.setProperty('display', 'flex', 'important');
        welcome.setAttribute('data-crl-devin-reveal', '1');
      }
      if (editor && getComputedStyle(editor).display !== 'none') {
        editor.style.setProperty('display', 'none', 'important');
        editor.setAttribute('data-crl-devin-reveal', '1');
      }
      shown = true;
    }
    return shown;
  };
  const hasComposer = () => {
    revealDevinComposer();
    if ([...doc.querySelectorAll('.aislash-editor-input[contenteditable="true"], .ui-prompt-input-editor__input[contenteditable="true"]')].some(vis)) return true;
    // Devin's prompt is a plain contenteditable. Its message bubbles are role=group too, so only those are excluded.
    return [...doc.querySelectorAll('[contenteditable="true"]')].some(e => vis(e) && !e.closest('.monaco-editor, [aria-label="User message"], [aria-label="Devin message"]'));
  };

  // The Agent's ask-question tool renders as a toolbar above the composer, outside the message list.
  const QN = '.composer-questionnaire-toolbar';
  const qnBox = () => [...doc.querySelectorAll(QN)].find(vis);
  const inQn = el => !!el.closest(QN);
  const qnOptions = q => [...q.querySelectorAll('.composer-questionnaire-toolbar-option')];
  const qnAction = (box, re) => [...box.querySelectorAll('.composer-questionnaire-toolbar-actions > *')].find(e => vis(e) && re.test(e.innerText));
  const questions = () => {
    const box = qnBox();
    if (!box) return null;
    const list = [...box.querySelectorAll('.composer-questionnaire-toolbar-question')].map(q => ({
      text: (q.querySelector('.composer-questionnaire-toolbar-question-label .markdown-root') || q.querySelector('.composer-questionnaire-toolbar-question-label'))?.innerText.trim() || '',
      options: qnOptions(q).map(o => {
        const ta = o.querySelector('textarea');
        return {
          label: ta ? '' : o.querySelector('.composer-questionnaire-toolbar-option-label')?.innerText.trim() || '',
          free: !!ta, value: ta?.value || '',
          sel: !!o.querySelector('.composer-questionnaire-toolbar-option-letter-selected'),
        };
      }),
    }));
    const submit = qnAction(box, /continue|submit|继续|提交/i);
    return { list, canSubmit: !!submit && submit.dataset.disabled !== 'true' };
  };
  // Agent surface, new-session screen: "Local ▾" (where the agent runs: Local / Worktree / Cloud) and the folder
  // chip next to it. Both are only enabled before the first message; in a running session Local is disabled.
  // The folder chip opens a quick pick (role=listbox aria-label="Select a directory"; rows "name, path" and Browse...).
  const workdirChips = () => {
    if (!devinSurface()) return null;
    const btns = [...document.querySelectorAll('button')].filter(b => vis(b) && b.getBoundingClientRect().y > 120);
    const env = btns.find(b => /^(Local|Worktree|Cloud)$/.test((b.innerText || '').trim()) && b.getAttribute('aria-haspopup') === 'menu');
    if (!env) return null;
    const folder = env.nextElementSibling;
    return folder ? { env, folder } : null;
  };
  const workdirInfo = () => {
    const c = workdirChips();
    if (!c) return null;
    const lines = (c.folder.innerText || '').split('\n').map(x => x.trim()).filter(Boolean);
    return { name: lines[0] || '', extra: lines[1] || '', env: (c.env.innerText || '').trim(), editable: !c.env.disabled && !c.folder.disabled };
  };
  const workdirTarget = which => {
    const c = workdirChips();
    return c ? center(which === 'env' ? c.env : c.folder) : null;
  };
  const workdirRows = () => {
    const lb = [...document.querySelectorAll('[role="listbox"][aria-label="Select a directory"]')].find(vis);
    if (!lb) return null;
    return [...lb.querySelectorAll('[role="option"]')].filter(vis).map(o => {
      const label = o.getAttribute('aria-label') || (o.innerText || '').trim();
      const at = label.indexOf(', ');
      const r = o.getBoundingClientRect();
      return { name: at < 0 ? label : label.slice(0, at), path: at < 0 ? '' : label.slice(at + 2), browse: /Browse\.\.\./i.test(label), x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
  };
  const envRows = () => [...document.querySelectorAll('[role="menuitem"]')].filter(e => vis(e) && /^(Local|Worktree|Cloud)$/.test((e.innerText || '').trim()))
    .map(e => { const r = e.getBoundingClientRect(); return { label: (e.innerText || '').trim(), x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  // Devin "@" mentions: typing "@" in the prompt opens a listbox (root: Files, Directories, Git, Rules, Skills,
  // Conversations, Terminal, Codemaps; "@file:ser" lists files, "@terminal:" lists terminals). Clicking an option
  // swaps the typed text for a chip. composerState() is the prompt's text without placeholder / zero-width marks.
  const composerState = () => {
    const ed = [...document.querySelectorAll('[role="textbox"][aria-label="Prompt"]')].find(vis);
    if (!ed) return null;
    const ph = ed.querySelector('[data-slate-placeholder]')?.innerText || '';
    let t = ed.innerText || '';
    if (ph) t = t.split(ph).join('');
    return t.replace(/[\u200b\ufeff]/g, '').trim();
  };
  const mentionRows = () => {
    const lb = [...document.querySelectorAll('[role="listbox"]')].find(e => vis(e) && e.getBoundingClientRect().height > 20 && e.querySelector('[role="option"]'));
    if (!lb) return null;
    return [...lb.querySelectorAll('[role="option"]')].filter(vis).map(o => {
      const r = o.getBoundingClientRect();
      const lines = (o.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
      return { label: lines[0] || '', sub: lines.slice(1).join(' · ').slice(0, 120), sel: o.getAttribute('aria-selected') === 'true', x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }).filter(r => r.label && r.label !== 'Loading…');
  };
  // Devin: the question card sits in a `[data-band-item]` above the composer, one question at a time
  // (Skip, a "1 of 2" pager only when there are several, option rows `div[role=button]`; multi-select rows carry a role=checkbox and the
  // card has a Submit button). A single choice answers as soon as its row is clicked. Free text goes
  // through the normal composer ("Other answer" placeholder).
  const devinQnBand = () => !devinLog() ? null : [...document.querySelectorAll('[data-band-item]')]
    .find(e => vis(e) && e.querySelector('button[aria-label="Skip"]'));
  const devinQnRows = band => [...band.querySelectorAll('[data-slot="scroll-area-viewport"] > [role="button"]')];
  const devinQnButton = (band, name) => [...band.querySelectorAll('button')].find(b => vis(b) && (b.getAttribute('aria-label') === name || (b.innerText || '').trim() === name));
  const devinQuestions = () => {
    const band = devinQnBand();
    if (!band) return null;
    const pg = /\b(\d+) of (\d+)\b/.exec(band.innerText || '');
    const rows = devinQnRows(band);
    const options = rows.map(r => {
      const cb = r.querySelector('[role="checkbox"]');
      const ps = [...r.querySelectorAll('p')].map(p => (p.innerText || '').trim());
      return { label: ps[0] || (r.innerText || '').trim(), desc: ps[1] || '', sel: cb ? cb.getAttribute('aria-checked') === 'true' : false };
    });
    const multi = rows.some(r => r.querySelector('[role="checkbox"]'));
    const text = [...band.querySelectorAll('p')].find(p => !p.closest('[data-slot="scroll-area"]'))?.innerText.trim() || '';
    const submit = devinQnButton(band, 'Submit') || devinQnButton(band, 'Continue');
    const prev = devinQnButton(band, 'Previous question'), next = devinQnButton(band, 'Next question');
    return {
      devin: true, src: 'devin', list: [{ text, options, multi }],
      pager: pg ? { cur: Number(pg[1]), total: Number(pg[2]) } : null,
      canPrev: !!prev && !prev.disabled, canNext: !!next && !next.disabled,
      hasSubmit: !!submit, canSubmit: !!submit && !submit.disabled,
    };
  };
  const devinQuestionTarget = (oi, part) => {
    const band = devinQnBand();
    if (!band) return null;
    if (part === 'option') {
      const row = devinQnRows(band)[oi];
      if (!row) return null;
      row.scrollIntoView({ block: 'nearest' });
      return center(row);
    }
    const name = { skip: 'Skip', prev: 'Previous question', next: 'Next question' }[part];
    const b = part === 'submit' ? (devinQnButton(band, 'Submit') || devinQnButton(band, 'Continue')) : devinQnButton(band, name);
    return b && !b.disabled ? center(b) : null;
  };
  const questionTarget = (qi, oi, part) => {
    if (devinQnBand()) return devinQuestionTarget(oi, part);
    const box = qnBox();
    if (!box) return null;
    if (part === 'submit' || part === 'skip') {
      const b = qnAction(box, part === 'skip' ? /skip|跳过/i : /continue|submit|继续|提交/i);
      return b ? center(b) : null;
    }
    const q = box.querySelectorAll('.composer-questionnaire-toolbar-question')[qi];
    const o = q && qnOptions(q)[oi];
    if (!o) return null;
    o.scrollIntoView({ block: 'nearest' });
    return center(o.querySelector('textarea') || o);
  };

  // Files changed by the Agent: the "N Files" toggle above the composer expands a list with per-file undo / keep.
  const filesToggle = () => [...document.querySelectorAll('span.cursor-pointer')].find(e => vis(e) && /^\d+ Files?$/.test(e.innerText.trim().replace(/\s+/g, ' ')));
  // Devin's review bar: a "N files with changes" header above the composer, per-row
  // Accept file (check icon) / Reject file (x icon) buttons and Reject all / Accept all spans.
  const stripBidi = s => (s || '').replace(/[⁦-⁩]/g, '');
  // The bar is "N files | +a -d | Quick review | Reject all | Accept all" when collapsed; the
  // expanded list box sits above it. Collapsed, the list keeps its text but is display:none.
  const devinChangesHdr = () => [...document.querySelectorAll('div.group.cursor-pointer')]
    .find(e => /files? with changes/.test(stripBidi(e.innerText)));
  const devinChangesBox = () => {
    const h = devinChangesHdr();
    if (h) return h.closest('div.flex.min-w-0.flex-col.gap-1') || h.parentElement;
    return [...document.querySelectorAll('div.flex.min-w-0.flex-col.gap-1')].find(e => vis(e) && /\bReject all\b/.test(e.innerText || '')) || null;
  };
  const devinChangedRows = () => [...(devinChangesBox()?.querySelectorAll('div.group.cursor-pointer.hover\\:bg-tint-secondary') || [])];
  const devinBarLeft = () => [...(devinChangesBox()?.querySelectorAll('div.select-none') || [])]
    .find(e => vis(e) && /^\d+ files?\b/.test(e.innerText.trim()) && !/with changes/.test(e.innerText));
  const devinOpen = () => devinChangedRows().some(vis);
  // Devin's editor surface can drop the chat bar while its "Review N files" button (editor pane) still counts.
  const devinCascadeCount = () => devinLog() ? Number(/Review\s+(\d+)\s+files?/.exec(stripBidi([...document.querySelectorAll('.cascade-bar')].map(b => b.innerText || '').join(' ')))?.[1]) || 0 : 0;
  const changedCount = () => codexThread() ? codexChanges().count : parseInt(filesToggle()?.innerText || '0', 10) || 0
    || Number(/(\d+)\s+files?\b/.exec(stripBidi(devinChangesBox()?.innerText))?.[1]) || devinCascadeCount();
  const changedRows = () => [...document.querySelectorAll('.composer-file-list-item')].filter(vis);
  const changedFiles = () => {
    const rows = changedRows();
    if (rows.length) return rows.map(r => {
      const stat = [...r.querySelectorAll('.tabular-nums span')].map(s => s.innerText.trim());
      return {
        name: r.querySelector('span[style*="nowrap"]')?.innerText.trim() || r.innerText.trim().split('\n')[0],
        add: stat.find(s => s.startsWith('+')) || '',
        del: stat.find(s => /^[-−]/.test(s)) || '',
      };
    });
    return devinChangedRows().map(r => {
      const texts = [...r.querySelectorAll('span')].map(s => stripBidi(s.innerText).trim()).filter(Boolean);
      // Directory-prefixed rows render as two leaves ("app/" + "index.html"); join them.
      const name = texts.filter(t => !/^[+−-]\s?\d+$/.test(t)).join('') || stripBidi(r.innerText).split('\n').filter(Boolean)[0] || '';
      return {
        name,
        add: (texts.find(t => /^\+\s?\d+$/.test(t)) || '').replace(/\s+/g, ''),
        del: (texts.find(t => /^[−-]\s?\d+$/.test(t)) || '').replace(/\s+/g, ''),
      };
    });
  };
  const filesBar = () => {
    let t = filesToggle();
    while (t && !t.querySelector('[data-click-ready]')) t = t.parentElement;
    return t;
  };
  // Bar-level actions besides Stop (handled elsewhere) and Review (desktop-only diff view), e.g. Keep All / Undo All.
  const fileBarButtons = () => {
    const cur = [...(filesBar()?.querySelectorAll('[data-click-ready]') || [])].filter(vis)
      .map(e => ({ el: e, label: (e.querySelector('.truncate') || e).innerText.trim() }))
      .filter(x => x.label && !/^(stop|review)$/i.test(x.label));
    if (cur.length) return cur;
    const box = devinChangesBox();
    if (!box) return [];
    return [...box.querySelectorAll('span')].filter(e => vis(e) && /^(Reject all|Accept all)$/.test((e.innerText || '').trim()))
      .map(e => ({ el: e, label: e.innerText.trim() }));
  };
  const filesState = () => ({
    files: changedFiles(),
    actions: fileBarButtons().map(x => x.label),
    open: changedRows().length > 0 || (!!devinChangesBox() && devinOpen()),
    count: changedCount(),
  });
  // Devin: hovering a file row reveals two 18px icon buttons — first the check
  // ("Accept file", act 'keep'), then the x ("Reject file", act 'undo'). The
  // 'toggle' is the collapsed "N files" bar item, which expands/collapses the list.
  const devinFileTarget = (i, name, act) => {
    if (act === 'toggle') {
      // Folded: the "N files" group opens the list. Expanded: its header "N files with changes" folds it.
      const l = devinBarLeft() || (devinChangesHdr() && vis(devinChangesHdr()) ? devinChangesHdr() : null);
      return l ? center(l) : null;
    }
    if (act === 'bar') { const b = fileBarButtons().find(x => x.label === name); return b ? center(b.el) : null; }
    const row = devinChangedRows()[i];
    if (!row || !vis(row) || changedFiles()[i]?.name !== name) return null;
    row.scrollIntoView({ block: 'nearest' });
    if (act === 'row') return center(row);
    const pick = row.querySelectorAll('button')[act === 'undo' ? 1 : 0];
    return pick && vis(pick) ? center(pick) : null;
  };
  const fileTarget = (i, name, act) => {
    if (devinChangesBox()) return devinFileTarget(i, name, act);
    if (act === 'toggle') { const t = filesToggle(); return t ? center(t) : null; }
    if (act === 'bar') return (b => b ? center(b.el) : null)(fileBarButtons().find(x => x.label === name));
    const row = changedRows()[i];
    if (!row || changedFiles()[i].name !== name) return null;
    row.scrollIntoView({ block: 'nearest' });
    if (act === 'row') return center(row);
    const icon = row.querySelector(act === 'undo' ? '.codicon-x-two' : '.codicon-check-two');
    return icon ? center(icon.closest('.anysphere-icon-button') || icon) : null;
  };

  // Editing a queued message loads it into the main composer, which is tagged with the item id until saved.
  const focusQueueEdit = id => {
    const bar = [...doc.querySelectorAll('[data-editing-queue-item-id]')].find(e => vis(e) && e.dataset.editingQueueItemId === id);
    const ed = bar && [...bar.querySelectorAll('[contenteditable="true"]')].find(vis);
    if (!ed) return false;
    ed.focus();
    return true;
  };

  const stopTarget = (click = false) => {
    const target = el => {
      if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return null;
      if (!click) return center(el);
      el.click();
      return true;
    };
    const btn = stopGenerationButton();
    if (btn) return target(btn);
    const icon = legacyStopIcon();
    if (icon) return target(icon.closest('button, [role=button], .anysphere-icon-button') || icon);
    const cancel = devinLog() && [...document.querySelectorAll('button[aria-label="Cancel"]')].find(e => vis(e) && !e.disabled && e.querySelector('svg'));
    return target(cancel);
  };

  const permissionLabel = () => {
    const b = doc.querySelector('[data-composer-navigation-target="permissions"], button[aria-label="Change permissions"]');
    if (!b || !vis(b)) return null;
    return (b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40) || null;
  };
