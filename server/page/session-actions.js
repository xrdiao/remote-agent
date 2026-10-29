  const cursorSessionServices = () => {
    if (window.__remoteAgentCursorServices) return window.__remoteAgentCursorServices;
    const props = [...doc.querySelectorAll('[data-message-id], [data-glass-agent-id], .composer-container')]
      .flatMap(el => codexFiberProps(el, 40)).find(p => p.uiContextMenuServices);
    const inst = props?.uiContextMenuServices?.instantiationService;
    if (!inst) return null;
    const ids = new Map();
    for (let scope = inst; scope; scope = scope._parent)
      for (const [id] of scope._services._entries) if (!ids.has(String(id))) ids.set(String(id), id);
    return window.__remoteAgentCursorServices = inst.invokeFunction(accessor => ({
      composer: accessor.get(ids.get('composerService')),
      data: accessor.get(ids.get('composerDataService')),
      background: accessor.get(ids.get('backgroundComposerService')),
    }));
  };
  const devinSessionRecord = id => window.__acpStore?.getState().acp.sessions.find(s => devinRowSession(s) === id);
  const devinSessionMenu = id => {
    for (const row of doc.querySelectorAll('li[data-slot="sidebar-menu-item"]')) {
      const props = codexFiberProps(row, 16);
      if (!props.some(p => devinRowSession(p.session) === id)) continue;
      return { row, actions: props.find(p => p.menuActions)?.menuActions || [] };
    }
    for (const row of doc.querySelectorAll('div[data-kb-navigate="true"][tabindex="0"]')) {
      const props = codexFiberProps(row, 12);
      if (!props.some(p => devinRowSession(p.session) === id)) continue;
      const actions = props.find(p => p.onRename && p.onArchiveToggle);
      return { row, actions: actions ? [
        { label: 'Rename', onClick: actions.onRename, direct: true },
        { label: 'Archive', onClick: actions.onArchiveToggle },
      ] : [] };
    }
    return null;
  };
  const nativeSessionInfo = (app, id) => {
    if (app === 'cursor') {
      const services = cursorSessionServices();
      const session = services?.data.allComposersData.allComposers.find(c => c.composerId === id);
      return session ? { title: session.name || 'New Agent', archived: !!session.isArchived, running: window.__SSG_COMPOSER_PROVIDER__?.getStates?.().some(c => c.id === id && c.state === 'generating') || (activeThread() === id && isBusy()), actions: ['rename', 'delete'] } : null;
    }
    const session = devinSessionRecord(id);
    if (!session) return null;
    const actions = devinSessionMenu(id)?.actions || [];
    return { title: session.title || '', archived: session._meta?.['cognition.ai/isArchived'] === true, running: ['active', 'pending', 'canceling'].includes(session.status),
      actions: ['rename', 'archive', 'delete'].filter(name => actions.some(a => a.label.toLowerCase() === name && !a.disabled)) };
  };
  const nativeSessionAction = async (app, id, action, name) => {
    if (app === 'cursor') {
      const services = cursorSessionServices();
      const session = services?.data.allComposersData.allComposers.find(c => c.composerId === id);
      if (!session) throw new Error('没有找到这个会话');
      if (action === 'rename') {
        if (session.createdFromBackgroundAgent?.bcId) await services.background.renameBackgroundComposer(session.createdFromBackgroundAgent.bcId, name);
        else await services.composer.renameComposer(id, name);
      } else if (action === 'delete') {
        if (services.data.allComposersData.allComposers.length > 1) await services.composer.deleteComposer(id);
        else await services.composer.resetComposer(id);
      } else throw new Error('此会话不支持这个操作');
      const after = services.data.allComposersData.allComposers.find(c => c.composerId === id);
      const empty = services.data.getComposerDataIfLoaded(id)?.fullConversationHeadersOnly?.length === 0;
      return { confirmed: action === 'rename' ? after?.name === name : !after || !!after.isArchived || empty };
    }
    const item = devinSessionMenu(id)?.actions.find(a => a.label.toLowerCase() === action && !a.disabled);
    if (!item) throw new Error('此会话没有对应的原生操作入口');
    await item.onClick(item.direct ? name : undefined);
    return { direct: !!item.direct };
  };
  const nativeSessionRenameInput = id => {
    const input = devinSessionMenu(id)?.row.querySelector('input');
    if (!input) return false;
    input.focus(); input.select(); return true;
  };
  const nativeSessionConfirm = action => {
    const dialog = [...doc.querySelectorAll('[role="dialog"], [role="alertdialog"]')].find(e => vis(e) && /(?:delete|archive).*session/i.test(e.innerText || ''));
    const button = dialog && [...dialog.querySelectorAll('button')].find(b => vis(b) && (b.innerText || '').trim().toLowerCase() === action);
    return button ? center(button) : null;
  };
  const nativeConfirmedTitle = (app, id) => {
    if (activeThread() !== id) return '';
    if (app === 'cursor') {
      const name = cursorSessionServices()?.data.allComposersData.allComposers.find(c => c.composerId === id)?.name;
      const tab = [...doc.querySelectorAll('.tab[data-resource-name]')].find(t => t.dataset.resourceName === id);
      const row = [...doc.querySelectorAll('[data-sidebar-item-key]')].find(t => t.getAttribute('data-sidebar-item-key') === 'row:' + id);
      const label = tab?.querySelector('.label-name')?.textContent || row?.querySelector('.ui-sidebar-menu-button-label')?.textContent;
      return name && label?.trim() === name ? name : '';
    }
    if (app === 'devin') {
      const name = devinSessionRecord(id)?.title;
      const tab = devinTabEls().find(t => codexFiberProps(t, 24).some(p => p.sessionId === id));
      const label = devinSessionMenu(id)?.row.querySelector('button[aria-label]')?.getAttribute('aria-label') || (tab?.querySelector('span') || tab)?.innerText;
      return name && label?.trim() === name ? name : '';
    }
    const query = codexQueryClient()?.getQueryState(['recent-conversations-meta', 'updated_at', '[]', 'live']);
    const row = query?.data?.find(t => t.conversationId === id);
    return row ? { title: row.title, at: query.dataUpdatedAt } : '';
  };
