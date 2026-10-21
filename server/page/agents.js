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
    const mountedMin = () => Math.min(...[...doc.querySelectorAll('[data-acp-msg-index]')].map(e => Number(e.getAttribute('data-acp-msg-index'))).filter(n => Number.isFinite(n)));
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
    const recentItems = items.slice(items.findLastIndex(el => el.matches('[data-message-kind="human"], [role=group][aria-label="User message"]') || el.querySelector('.composer-human-message, [data-message-kind="human"]')) + 1);
    const lastReply = [...recentItems].reverse().find(el => el.matches('[data-message-kind="assistant"], [role=group][aria-label="Devin message"]') || el.querySelector('[data-message-kind="assistant"]'));
    let last = lastReply ? lastReply.innerText.trim().replace(/\s+/g, ' ').slice(0, 160) : '';
    if (!last) {
      const tail = recentItems.flatMap(el => [...el.querySelectorAll('[class*="MarkdownRoot"]')]).filter(e => vis(e) && !e.closest('[class*="group/user-message"]')).at(-1);
      if (tail) last = tail.innerText.trim().replace(/\s+/g, ' ').slice(0, 160);
    }
    if (codexThread()) {
      const latest = items.filter(el => el.hasAttribute('data-turn-key')).at(-1);
      const reply = latest && codexTurnData(latest)?.items?.filter(it => it.type === 'assistant-message' && it.phase !== 'commentary' && it.completed).at(-1);
      last = (reply?.content || '').trim().replace(/\s+/g, ' ').slice(0, 160);
    }
    return { busy, waiting, waitingText, last, thread, agentId: active?.id || '', title, progress, roots, ...(actions ? { actions } : {}), ...(devin ? { devin: true, changed: changedCount(), tasks: devinTaskState() } : {}) };
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
        title: title.slice(0, 80),
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
    const focused = loaded.find(c => c.state === 'focused')?.id;
    if (tabs.length || loaded.length) return [...new Map([
      ...loaded.map(c => [c.id, { id: c.id, title: c.title || '新会话', current: c.state === 'focused', running: c.state === 'generating', workspace: '', host: '', group: '' }]),
      ...tabs.map(t => [t.dataset.resourceName, { id: t.dataset.resourceName, title: t.querySelector('.label-name')?.textContent || '新会话', current: focused ? t.dataset.resourceName === focused : t.classList.contains('active'), workspace: '', host: '', group: '' }]),
    ]).values()];
    // Read the native session id; titles can repeat or change.
    const lis = [...doc.querySelectorAll('li[data-slot="sidebar-menu-item"]')].map(li => {
      const btn = li.querySelector('button[aria-label]');
      const title = (btn?.getAttribute('aria-label') || '').trim();
      if (!title || DEVIN_NAV.has(title)) return null;
      const session = codexFiberProps(li).find(p => p.session)?.session;
      if (!session) return null;
      const slot = li.querySelector('[data-slot="sidebar-menu-button"]');
      return {
        id: session.sessionId,
        workspace: session.cwd || '',
        title: title.slice(0, 80),
        group: '',
        current: slot?.getAttribute('data-active') === 'true',
        running: ['active', 'pending', 'canceling'].includes(session.status),
        lastUsed: Date.parse(session.updatedAt) || 0,
        last: session.agentStopMessage || '',
      };
    }).filter(Boolean);
    // A freshly opened Devin window shows "Recent sessions" in the workspace welcome
    // layer instead of the sidebar list; those buttons carry the same session props.
    const welcome = [...doc.querySelectorAll('[class*="windsurf-workspace-welcome"] button')].flatMap(btn => {
      const session = codexFiberProps(btn).find(p => p.session?.sessionId)?.session;
      if (!session) return [];
      return [{
        id: session.sessionId,
        workspace: session.cwd || '',
        title: (btn.innerText || '').trim().split('\n')[0].slice(0, 80),
        group: '',
        current: false,
        running: ['active', 'pending', 'canceling'].includes(session.status),
        lastUsed: Date.parse(session.updatedAt) || 0,
        last: session.agentStopMessage || '',
      }];
    });
    const seen = new Set(lis.map(a => a.id));
    return [...lis, ...welcome.filter(a => !seen.has(a.id))];
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
    const li = [...doc.querySelectorAll('li[data-slot="sidebar-menu-item"]')].find(e => codexFiberProps(e).some(p => p.session?.sessionId === id));
    const btn = li && [...li.querySelectorAll('button[aria-label]')].find(vis);
    if (btn) {
      btn.scrollIntoView({ block: 'nearest' });
      if (click) { btn.click(); return true; }
      return center(btn);
    }
    // Fresh windows list sessions as welcome-layer "Recent sessions" buttons, not sidebar items.
    const wbtn = [...doc.querySelectorAll('[class*="windsurf-workspace-welcome"] button')].find(b => codexFiberProps(b).some(p => p.session?.sessionId === id));
    if (!wbtn || !vis(wbtn)) return null;
    wbtn.scrollIntoView({ block: 'nearest' });
    if (click) { wbtn.click(); return true; }
    return center(wbtn);
  };
  const agentStates = () => {
    const current = agentState();
    if (codexThread()) return current ? [current] : [];
    const agents = agentList();
    return agents.length ? agents.map(a => a.current && current ? current : {
      thread: a.id, agentId: a.id, title: a.title, busy: a.running, waiting: null, last: a.last || '',
    }) : current ? [current] : [];
  };

  // Integrated terminals: the Agents window puts them in editor tabs (aria-controls contains terminal-).
  // Older editor layouts use .terminal-tab. The xterm canvas itself is only used for the crop rectangle.
