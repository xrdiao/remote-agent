  const devinScroller = () => {
    const log = devinLog();
    if (!log) return null;
    let p = log;
    while (p && p !== document.body) {
      const st = getComputedStyle(p);
      if ((st.overflowY === 'auto' || st.overflowY === 'scroll') && p.scrollHeight > p.clientHeight) return p;
      p = p.parentElement;
    }
    return log;
  };
  const panelRect = () => {
    // findPanel's fallback can climb to Devin's whole virtualized log (taller than
    // the screen); the wheel must land inside the visible scroll container instead.
    const p = devinLog() ? devinScroller() : findPanel();
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height].map(Math.round);
  };
  const historyAtStart = () => {
    let el = devinLog() ? devinScroller() : findPanel();
    while (el && el !== doc.body) {
      const style = getComputedStyle(el);
      if (/auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight) {
        return style.flexDirection === 'column-reverse' ? el.scrollTop <= el.clientHeight - el.scrollHeight + 1 : el.scrollTop <= 1;
      }
      el = el.parentElement;
    }
    return true;
  };
  const historyRows = () => [...doc.querySelectorAll(`${ITEM_SEL}, [data-acp-msg-index]`)]
    .map(el => el.getAttribute('data-acp-msg-index') ?? el.getAttribute('data-turn-key') ?? el.getAttribute('data-flat-index') ?? el.getAttribute('data-message-kind') + ':' + (el.textContent || '').slice(0, 80)).join('|');
  const historyPosition = restore => {
    let el = devinLog() ? devinScroller() : findPanel();
    while (el && el !== doc.body) {
      if (/auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight) {
        if (restore) el.scrollTop = restore.top;
        return { top: el.scrollTop };
      }
      el = el.parentElement;
    }
    return null;
  };
  const projectWindowProbe = () => {
    if (!window.__remoteWindowInput) {
      window.__remoteWindowInput = { at: 0 };
      for (const type of ['pointerdown', 'keydown', 'wheel', 'input']) document.addEventListener(type, e => { if (e.isTrusted) window.__remoteWindowInput.at = Date.now(); }, { passive: true, capture: true });
    }
    const terms = [...new Set([...document.querySelectorAll('.xterm-wrapper, .terminal-wrapper')].map(el => el.xterm).filter(Boolean))];
    const terminalBusy = terms.some(term => {
      if (devinSurface() && term.options.disableStdin) return false;
      const detector = (term._addonManager?._addons || []).map(a => a.instance || a).find(a => a.capabilities)?.capabilities.get(2);
      return !detector || !!detector.currentCommand?.commandExecutedMarker;
    });
    let states = agentStates();
    const nativeSessions = window.__acpStore?.getState().acp.sessions;
    if (nativeSessions) {
      const root = window.vscode?.context?.configuration?.()?.workspace?.uri?.path;
      const open = new Set(devinTabs().map(t => t.id));
      open.add(activeThread());
      states = states.filter(s => open.has(s.thread) || nativeSessions.some(record => record.sessionId === s.thread && record.cwd === root));
    }
    return { ready: !!window.vscode?.context?.configuration?.()?.workspace || hasComposer(),
      focused: document.hasFocus(), dirty: !!document.querySelector('.tab.dirty, .tab[aria-label*="unsaved" i]'),
      dialog: [...document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="alertdialog"], .monaco-dialog-box, .quick-input-widget')].some(vis),
      terminalBusy: terminalBusy || !!document.querySelector('.statusbar-item .codicon-modifier-spin'),
      agentKnown: hasComposer() || !!states?.length,
      agentBusy: states?.some(s => s.busy || s.waiting || s.progress > 0) || !!composerDraft() || !!(codexThread() && (codexCapacityItem() || codexRequestData().length))
        || !!window.__SSG_COMPOSER_PROVIDER__?.getStates?.().some(s => s.state === 'generating')
        || !!nativeSessions?.some(s => s.sessionId === activeThread() && ['active', 'pending', 'canceling'].includes(s.status)),
      lastInput: window.__remoteWindowInput.at };
  };
  const waitHistoryRows = async (before, timeout = 400) => {
    const deadline = performance.now() + timeout;
    let previous = before, stable = 0;
    while (performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 30));
      const rows = historyRows();
      stable = rows !== before && rows === previous ? stable + 1 : 0;
      if (stable >= 2) return;
      previous = rows;
    }
  };
  // Devin virtualizes its transcript in ~50-row batches with a wide remount threshold: a small
  // mouse wheel near the bottom never exposes older rows. Jump the scroller instead and wait for
  // the mounted acp window to reach a lower index.
  const devinLoadEarlier = async (timeout = 2500) => {
    const sc = devinScroller();
    if (!sc) return { moved: false };
    const top = sc.scrollTop;
    const mountedMin = () => devinLog()?.matches('[data-chat-history-variant]')
      ? Math.min(...devinTranscriptRows(devinLog()).map(devinTranscriptIndex).filter(n => Number.isFinite(n)))
      : Math.min(...[...doc.querySelectorAll('[data-acp-msg-index]')].map(e => Number(e.getAttribute('data-acp-msg-index'))).filter(n => Number.isFinite(n)));
    const rowsBefore = historyRows();
    const deadline = performance.now() + timeout;
    const initialMin = mountedMin();
    let min = initialMin;
    while (performance.now() < deadline && sc.scrollTop > 1) {
      sc.scrollTop = Math.max(0, sc.scrollTop - sc.clientHeight * 3);
      const until = performance.now() + 250;
      while (performance.now() < until) {
        await new Promise(resolve => setTimeout(resolve, 30));
        const m = mountedMin();
        if (m < min) { min = m; break; }
      }
      if (min < initialMin) break;
    }
    await waitHistoryRows(rowsBefore, 200);
    return { moved: min < initialMin || sc.scrollTop <= 1, atStart: sc.scrollTop <= 1, min, top };
  };
  // While the scroller is up, Devin's virtualization never mounts streamed tail rows, so the phone
  // would miss new messages until re-attach. Restore the pre-jump position after the merge read.
  const devinScrollTop = top => { const sc = devinScroller(); if (sc && Number.isFinite(top)) sc.scrollTop = top; };

  // Cheap per-window check for notifications: is the Agent running, and is it waiting on a button?
  // "Run in background" shows up on any command running longer than ~5 s; it is not a request for approval.
  const WAIT = /^(?!.*(background|后台))(run|allow|accept|approve|continue|yes\b|运行|允许|接受|批准|继续)/i;
  const agentState = () => {
    const buttons = [...doc.querySelectorAll('button')].filter(vis);
    const back = buttons.findIndex(b => (b.getAttribute('aria-label') || '') === 'Back');
    const active = agentList().find(a => a.current);
    const title = active?.title || (back >= 0 ? ((buttons[back + 1]?.innerText || '').split('\n')[0] || '').trim().slice(0, 80) : '');
    const recent = buttons.find(b => (b.getAttribute('aria-label') || '').startsWith('Recent chats'));
    const progress = Number((/(\d+) in progress/.exec(recent?.getAttribute('aria-label') || '') || [])[1] || 0);
    const thread = activeThread();
    const roots = codexWorkspaceRoots();
    const panel = findPanel();
    if (!panel) {
      if (!thread && !hasComposer()) return null;
      return { busy: isBusy(), waiting: null, waitingText: '', last: '', thread, agentId: active?.id || '', title, progress, roots };
    }
    const busy = isBusy();
    const items = topItems(panel);
    let waiting = null, waitingText = '';
    for (const el of items.slice(-3)) {
      const labels = buttonsIn(el, false).map(x => x.label).filter(l => WAIT.test(l));
      if (labels.length) { waiting = `${itemKey(el)}:${labels.join('/')}`; waitingText = summary(el); }
    }
    const global = buttonsIn(panel, true).filter(x => !inItem(x.el) && !inQn(x.el) && WAIT.test(x.label)).map(x => x.label);
    if (!waiting && global.length) { waiting = `g:${global.join('/')}`; waitingText = global.join(' / '); }
    const devin = !!devinLog();
    const qs = devin ? devinQuestions() : questions();
    let actions;
    if (qs?.list.length) {
      const text = qs.list.map(q => q.text).join(' / ');
      waiting = `q:${text.slice(0, 120)}${qs.pager ? `:${qs.pager.cur}` : ''}`;
      waitingText = text;
      // Devin: single-choice options can be answered from the notification (Android shows three buttons).
      if (devin && !qs.list[0].multi) actions = qs.list[0].options.slice(0, 3).map((o, i) => ({ id: `opt:${i}`, label: o.label.slice(0, 40) }));
    }
    const humanIndex = items.findLastIndex(el => el.matches('[data-message-kind="human"], [role=group][aria-label="User message"]') || el.querySelector('.composer-human-message, [data-message-kind="human"]'));
    const recentItems = items.slice(humanIndex + 1);
    let runId = '', runAt = null, runIndex = null;
    if (devin && humanIndex >= 0) {
      const human = items[humanIndex], index = human.closest('[data-acp-msg-index]')?.getAttribute('data-acp-msg-index');
      runAt = devinMessageTime(human);
      if (index != null && /^\d+$/.test(index)) runIndex = Number(index);
      runId = runIndex != null ? `devin:acp:${runIndex}` : runAt != null ? `devin:time:${runAt}` : '';
    }
    const lastReply = [...recentItems].reverse().find(el => el.matches('[data-message-kind="assistant"], [role=group][aria-label="Devin message"]') || el.querySelector('[data-message-kind="assistant"]'));
    let last = lastReply ? lastReply.innerText.trim().replace(/\s+/g, ' ').slice(0, 160) : '';
    if (!last) {
      const tail = recentItems.flatMap(el => [...el.querySelectorAll('[class*="MarkdownRoot"]')]).filter(e => vis(e) && !e.closest('[class*="group/user-message"]')).at(-1);
      if (tail) last = tail.innerText.trim().replace(/\s+/g, ' ').slice(0, 160);
    }
    if (devin) {
      const body = lastReply?.querySelector('.prose-main');
      if (body) last = body.innerText.trim().replace(/\s+/g, ' ').slice(0, 160);
      const cwd = devinSession()?.cwd;
      if (cwd) roots.push({ root: cwd, host: '' });
    }
    if (codexThread()) {
      const thread = codexThread();
      const latest = items.filter(el => el.hasAttribute('data-turn-key')).at(-1);
      const latestEntry = latest && codexLatestEntry(latest);
      const turn = latestEntry?.turn || (latest && latestEntry?.turnKey === latest.getAttribute('data-turn-key') ? codexTurnData(latest) : null);
      const reply = turn?.items?.filter(it => it.type === 'assistant-message' && it.phase !== 'commentary' && it.completed).at(-1);
      last = latestEntry?.conversationId === thread
        ? (reply?.content || '').trim().replace(/\s+/g, ' ').slice(0, 160)
        : '';
      if (latestEntry?.conversationId === thread) {
        const key = latestEntry.turnKey || latestEntry.turnId;
        runId = key ? `codex:turn:${key}` : '';
        const at = turn?.items?.find(it => it.type === 'worked-for')?.startedAtMs
          ?? turn?.items?.find(it => it.type === 'user-message')?.sentAtMs;
        if (Number.isFinite(at)) runAt = at;
      }
    }
    return { busy, waiting, waitingText, last, thread, agentId: active?.id || '', title, progress, roots, ...(runId ? { runId } : {}), ...(runAt != null ? { runAt } : {}), ...(runIndex != null ? { runIndex } : {}), ...(actions ? { actions } : {}), ...(devin ? { devin: true, changed: changedCount(), tasks: devinTaskState() } : {}) };
  };

  // Cursor Agents window: the left sidebar lists conversations as row:<agent id>.
  const DEVIN_NAV = new Set(['New session', 'Sessions', 'Review', 'Automations', 'Security', 'Wiki', 'Cloud settings']);
  const cursorProjectPicker = () => {
    let el = [...doc.querySelectorAll('.aislash-editor-input[contenteditable="true"], .ui-prompt-input-editor__input[contenteditable="true"]')].find(vis);
    while (el && !Object.keys(el).some(k => k.startsWith('__reactFiber'))) el = el.parentElement;
    return el ? codexFiberProps(el, 40).find(p => p.projectSelectorProps)?.projectSelectorProps : null;
  };
  const cursorSelectProject = (root, host = '') => {
    const picker = cursorProjectPicker();
    const row = picker?.recentProjects?.find(p => {
      const uri = p.workspaceIdentifier?.uri;
      return (uri?.fsPath || uri?.path) === root && (uri.scheme === 'file' ? '' : uri.authority.replace(/^ssh-remote\+/, '')) === host;
    });
    if (!row) return false;
    picker.onSelectTarget({ type: 'workspace', id: row.workspaceIdentifier, displayName: row.name, repoUrls: row.repoUrls });
    return true;
  };
  const cursorWorkspace = id => {
    const el = [...doc.querySelectorAll('[data-glass-agent-id]')].find(e => !id || e.getAttribute('data-glass-agent-id') === id);
    const props = el && codexFiberProps(el, 24).find(p => p.agentWorkspace);
    const uri = props?.agentWorkspace.workspaceIdentifier?.uri || (!id && cursorProjectPicker()?.selectedTarget?.id?.uri);
    return uri ? { root: uri.fsPath || uri.path, host: uri.scheme === 'file' ? '' : uri.authority.replace(/^ssh-remote\+/, '') } : null;
  };
  const agentList = () => {
    const names = new Map((cursorSessionServices()?.data.allComposersData.allComposers || []).map(c => [c.composerId, c.name]));
    const active = [...doc.querySelectorAll('[data-glass-agent-id]')].find(vis)?.getAttribute('data-glass-agent-id') || '';
    const recentProjects = cursorProjectPicker()?.recentProjects || [];
    const cursor = [...doc.querySelectorAll('[data-sidebar-item-key^="row:"]')].map(row => {
      const id = row.getAttribute('data-sidebar-item-key').slice(4);
      const title = (row.querySelector('.ui-sidebar-menu-button-label') || row).textContent.trim().split('\n')[0];
      const repository = codexFiberProps(row).find(p => p.data?.kind === 'sidebar-agent')?.data?.dropSectionId?.replace(/^repo:/, '') || '';
      const projects = recentProjects.filter(p => p.repoUrls?.includes(repository));
      const uri = projects.length === 1 ? projects[0].workspaceIdentifier?.uri : null;
      const workspace = cursorWorkspace(id) || (uri && { root: uri.fsPath || uri.path, host: uri.scheme === 'file' ? '' : uri.authority.replace(/^ssh-remote\+/, '') });
      const group = row.closest('[data-sidebar-group]')?.querySelector('[data-sidebar-group-label]')?.textContent.trim() || '';
      return {
        id,
        title: (names.get(id) || title).slice(0, 80),
        titleNative: names.has(id),
        titleAt: Date.now(),
        group,
        repository,
        workspace: workspace?.root || '',
        host: workspace?.host || '',
        current: id === active || !!row.querySelector('[data-active="true"]'),
        running: !!row.querySelector('.ui-dot-grid-loader'),
      };
    }).filter(a => a.id && a.title);
    if (cursor.length) return cursor;
    const tabs = [...doc.querySelectorAll('.tab[data-resource-name]')].filter(t => t.querySelector('.composer-tab-label'));
    const loaded = window.__SSG_COMPOSER_PROVIDER__?.getStates?.() || [];
    const archived = new Set((tabs.length || loaded.length ? cursorSessionServices()?.data.allComposersData.allComposers || [] : []).filter(c => c.isArchived).map(c => c.composerId));
    const focused = loaded.find(c => c.state === 'focused')?.id;
    if (tabs.length || loaded.length) return [...new Map([
      ...loaded.map(c => [c.id, { id: c.id, title: c.title || '新会话', current: c.state === 'focused', running: c.state === 'generating', workspace: '', host: '', group: '' }]),
      ...tabs.map(t => [t.dataset.resourceName, { id: t.dataset.resourceName, title: t.querySelector('.label-name')?.textContent || '新会话', current: focused ? t.dataset.resourceName === focused : t.classList.contains('active'), workspace: '', host: '', group: '' }]),
    ]).values()].filter(row => !archived.has(row.id)).map(row => ({ ...row, title: names.get(row.id) || row.title, titleNative: names.has(row.id), titleAt: Date.now() }));
    if (devinSurface() === 'editor') {
      const selected = devinTabs().find(tab => tab.active)?.id;
      return (window.__acpStore?.getState().acp.sessions || []).filter(session => !session._meta?.['cognition.ai/isArchived'])
        .map(session => ({ ...devinCatalogRow(session), current: session.sessionId === selected }));
    }
    // Read the native session id; titles can repeat or change.
    const lis = [...doc.querySelectorAll('li[data-slot="sidebar-menu-item"]')].map(li => {
      const btn = li.querySelector('button[aria-label]');
      const title = (btn?.getAttribute('aria-label') || '').trim();
      if (!title || DEVIN_NAV.has(title)) return null;
      const session = codexFiberProps(li).find(p => devinRowSession(p.session))?.session;
      if (!session) return null;
      const id = devinRowSession(session);
      const slot = li.querySelector('[data-slot="sidebar-menu-button"]');
      return {
        id,
        workspace: session.cwd || '',
        title: (session.title || title).slice(0, 80),
        titleNative: !!session.title,
        titleAt: Date.now(),
        group: '',
        current: slot?.getAttribute('data-active') === 'true' || !!slot?.querySelector('[data-active="true"]'),
        running: ['active', 'pending', 'canceling'].includes(devinSessionRecord(id)?.status ?? session.status),
        lastUsed: Date.parse(session.latest_message_event_at || '') || 0,
        last: session.agentStopMessage || '',
      };
    }).filter(Boolean);
    // A freshly opened Devin window shows "Recent sessions" in the workspace welcome
    // layer instead of the sidebar list; those buttons carry the same session props.
    const welcome = [...doc.querySelectorAll('[class*="windsurf-workspace-welcome"] button')].flatMap(btn => {
      const session = codexFiberProps(btn).find(p => devinRowSession(p.session))?.session;
      if (!session) return [];
      const id = devinRowSession(session);
      return [{
        id,
        workspace: session.cwd || '',
        title: (btn.innerText || '').trim().split('\n')[0].slice(0, 80),
        group: '',
        current: false,
        running: ['active', 'pending', 'canceling'].includes(devinSessionRecord(id)?.status ?? session.status),
        lastUsed: Date.parse(session.updatedAt || session.updated_at) || 0,
        last: session.agentStopMessage || '',
      }];
    });
    const seen = new Set(lis.map(a => a.id));
    return [...lis, ...welcome.filter(a => !seen.has(a.id))];
  };
  const agentStartupState = (app, inputReady = false) => {
    if (app === 'codex') {
      const client = codexQueryClient();
      const recent = client?.getQueryData(['recent-conversations-meta', 'updated_at', '[]', 'live']);
      const workspace = client?.getQueryData(['vscode', 'workspace-root-options', '{"hostId":"local"}']);
      if (codexNeedsLogin()) return { login: true, rows: [], roots: [], thread: '' };
      if (!Array.isArray(recent) || !workspace) return null;
      return { rows: codexChatRows(true), roots: workspace.roots || [], thread: codexThread() };
    }
    const rows = agentList(), surface = app === 'devin' ? devinSurface() : null;
    if (inputReady && activeThread() && (!hasComposer() || !modelButton())) return null;
    if (!rows.length && !hasComposer() && !control('newChat') && !(surface === 'editor' && sessionSearchTarget())) return null;
    return { rows, surface, thread: activeThread(), items: (extract() || {}).items?.length || 0 };
  };
  const cursorChatReady = id => {
    if (activeThread() !== id) return false;
    const data = cursorSessionServices()?.data.getComposerDataIfLoaded(id);
    const panel = findPanel();
    return !!data?.hasLoaded && (!data.fullConversationHeadersOnly?.length || !!panel && topItems(panel).length > 0);
  };
  const agentTarget = (id, click = false) => {
    if (id && activeThread() === id) return true;
    const tab = [...doc.querySelectorAll('.tab[data-resource-name]')].find(t => t.dataset.resourceName === id && t.querySelector('.composer-tab-label'));
    if (tab) {
      tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      // The tab center can be covered by the sidebar header or the overflow "…" button; find an uncovered spot on its mid-line.
      const r = tab.getBoundingClientRect(), y = r.y + r.height / 2;
      for (let i = 0; i < 8; i++) {
        const x = r.x + r.width * (0.15 + 0.7 * i / 7);
        const hit = doc.elementFromPoint(x, y);
        if (hit && tab.contains(hit)) return { x, y };
      }
      if (!click) return null;
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) tab.dispatchEvent(new MouseEvent(type, { bubbles: true }));
      return true;
    }
    const row = [...doc.querySelectorAll('[data-sidebar-item-key]')].find(e => e.getAttribute('data-sidebar-item-key') === `row:${id}`);
    if (row && (click || vis(row))) {
      row.scrollIntoView({ block: 'nearest' });
      const hit = row.querySelector('.ui-sidebar-menu-button-content') || row.querySelector('[data-sidebar-menu-button]') || row;
      if (click) { hit.click(); return true; }
      return center(hit);
    }
    if (click && window.__SSG_COMPOSER_PROVIDER__) {
      const services = [...doc.querySelectorAll('[data-message-id]')].flatMap(el => codexFiberProps(el, 40)).find(p => p.uiContextMenuServices)?.uiContextMenuServices;
      if (services) return services.commandService.executeCommand('composer.openComposer', id).then(() => true);
    }
    const li = [...doc.querySelectorAll('li[data-slot="sidebar-menu-item"]')].find(e => codexFiberProps(e).some(p => devinRowSession(p.session) === id));
    const btn = li && ([...li.querySelectorAll('a[href]')].find(el => el.closest('li[data-slot="sidebar-menu-item"]') === li)
      || [...li.querySelectorAll('button[aria-label]')].find(vis));
    if (btn) {
      btn.scrollIntoView({ block: 'nearest' });
      if (click) { btn.click(); return true; }
      return center(btn);
    }
    // Fresh windows list sessions as welcome-layer "Recent sessions" buttons, not sidebar items.
    const wbtn = [...doc.querySelectorAll('[class*="windsurf-workspace-welcome"] button')].find(b => codexFiberProps(b).some(p => devinRowSession(p.session) === id));
    if (!wbtn || !vis(wbtn)) return null;
    wbtn.scrollIntoView({ block: 'nearest' });
    if (click) { wbtn.click(); return true; }
    return center(wbtn);
  };
  const agentStates = () => {
    const state = agentState();
    let generation = null;
    try { generation = state && typeof cursorBubbleTimes === 'function' ? cursorBubbleTimes()?.generation : null; } catch {}
    const current = generation ? { ...state, generation } : state;
    if (codexThread()) return current ? [current] : [];
    const agents = agentList();
    return agents.length ? agents.map(a => a.current && current ? current : {
      thread: a.id, agentId: a.id, title: a.title, busy: a.running, waiting: null, last: a.last || '',
    }) : current ? [current] : [];
  };

  // Integrated terminals: the Agents window puts them in editor tabs (aria-controls contains terminal-).
  // Older editor layouts use .terminal-tab. The xterm canvas itself is only used for the crop rectangle.
