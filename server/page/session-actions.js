  // Values entering native application stores must belong to the application's frame.
  const nativeValue = value => doc.defaultView.JSON.parse(JSON.stringify(value));
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
      nativeHost: accessor.get(ids.get('nativeHostService')),
    }));
  };
  const devinSessionRecord = id => window.__acpStore?.getState().acp.sessions.find(s => devinRowSession(s) === id);
  const nativeSessionContext = async (app, id) => {
    if (app === 'codex') {
      const host = codexChatRows(true).find(row => row.id === id)?.host || 'local';
      const manager = codexConversationManager(id, codexHistoryScopes(), host);
      if (!manager) throw new Error('Codex 原生会话管理器尚未就绪');
      const conversation = manager.getConversation(id);
      const thread = conversation || (await manager.readThread(id, { includeTurns: false })).thread;
      const workspace = manager.getThreadWorkspaceState(id);
      const roots = workspace?.project?.projectSources || workspace?.applied?.projectSources || conversation?.currentPermissions?.runtimeWorkspaceRoots || [thread.cwd];
      return { app, threadId: id, host: host === 'local' ? '' : host, cwd: thread.cwd,
        roots: roots.filter(Boolean).map(root => ({ root, host: host === 'local' ? '' : host })) };
    }
    if (app === 'cursor') {
      const services = cursorSessionServices();
      if (!services) throw new Error('Cursor 原生会话管理器尚未就绪');
      const handle = await services.data.getComposerHandleById(id);
      if (!handle) throw new Error('Cursor 原生目录中没有这个会话');
      const data = handle.data, workspace = services.composer.composerChatService._workspaceContextService.getWorkspace();
      const selected = data.workspaceIdentifier;
      if (selected && !selected.uri && selected.id !== workspace.id) throw new Error('尚未读取到这个 Cursor 会话的项目目录');
      const uris = selected?.uri ? [selected.uri] : workspace.folders.map(folder => folder.uri);
      const roots = uris.map(uri => ({ root: uri.fsPath || uri.path, host: uri.scheme === 'file' ? '' : uri.authority.replace(/^ssh-remote\+/, '') }));
      return { app, threadId: id, host: roots[0]?.host || '', cwd: roots[0]?.root || '', roots };
    }
    const session = devinSessionRecord(id);
    if (!session) throw new Error('Devin 原生目录中没有这个会话');
    return { app, threadId: id, host: '', cwd: session.cwd || '', roots: session.cwd ? [{ root: session.cwd, host: '' }] : [] };
  };
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
  const nativeSessionCatalog = async (app, ids) => {
    if (app === 'cursor') {
      const service = cursorSessionServices()?.data;
      if (!service) return { ready: false };
      await service.whenInitialComposerDataLoaded();
      const rows = (await service._storageService.collectionQuery('composerHeaders')).map(row => JSON.parse(row));
      const loaded = new Map(service.allComposersData.allComposers.map(row => [row.composerId, row]));
      const running = new Set((window.__SSG_COMPOSER_PROVIDER__?.getStates?.() || []).filter(row => row.state === 'generating').map(row => row.id));
      return { ready: true, complete: true, rows: rows.map(row => {
        const current = loaded.get(row.composerId) || row, uri = current.workspaceIdentifier?.uri;
        return { id: row.composerId, archived: !!row.isArchived, title: current.name || row.name || '',
          workspace: uri?.fsPath || uri?.path || '', host: uri && uri.scheme !== 'file' ? uri.authority.replace(/^ssh-remote\+/, '') : '',
          workspaceId: row.workspaceIdentifier?.id || '', lastUsed: current.lastUpdatedAt || row.createdAt || 0, running: running.has(row.composerId) };
      }) };
    }
    if (app === 'devin') {
      const native = await import('@exa/chat-client');
      const connectors = native.tryGetAcpSingleton('connectorService');
      if (!connectors?.hasReceivedConnectors()) return { ready: false };
      const state = window.__acpStore.getState().acp;
      const at = Date.now(), cli = [], cliPrefix = native.prefixSessionId('devin-cli', '');
      const cliReady = connectors.getConnectors().some(connector => connector.id === 'devin-cli' && connector.status === 'connected');
      let cursor;
      if (cliReady) do {
        const page = await native.tryGetAcpSingleton('sendAgentRequest')('devin-cli', { method: 'session/list', params: cursor ? { cursor } : {} });
        cli.push(...page.sessions.map(row => ({ ...row, sessionId: native.prefixSessionId('devin-cli', row.sessionId) })));
        cursor = page.nextCursor;
      } while (cursor);
      const cliIds = new Set(cli.map(row => row.sessionId));
      const sessions = [...state.sessions.filter(row => !cliReady || row.providerId !== 'devin-cli'
        || row._meta?.['cognition.ai/isArchived'] === true && !cliIds.has(row.sessionId)), ...cli];
      const displayed = new Map(state.sessions.map(row => [row.sessionId, row]));
      const known = new Set(sessions.map(row => row.sessionId));
      const requests = Object.values(state.agentRequests.byId).filter(request => request.status === 'completed'
        && ['session/archive', 'session/delete', 'session/load', 'session/resume'].includes(request.method));
      const times = new Map();
      for (const request of requests) times.set(request.params.sessionId, Math.max(times.get(request.params.sessionId) || 0, request.completedAt));
      const removed = requests.filter(request => request.method === 'session/delete' && !known.has(request.params.sessionId)).map(request => request.params.sessionId);
      const missing = ids.filter(id => cliReady && id.startsWith(cliPrefix) && !known.has(id));
      return { ready: true, complete: false,
        rows: sessions.map(row => {
          const current = displayed.get(row.sessionId) || row;
          return { id: row.sessionId, archived: current._meta?.['cognition.ai/isArchived'] === true,
            at: Math.max(Date.parse(current.updatedAt) || 0, times.get(row.sessionId) || 0),
            title: current.title || row.title || '', workspace: row.cwd || current.cwd || '', host: '',
            lastUsed: Date.parse(current.updatedAt || row.updatedAt) || 0, running: ['active', 'pending', 'canceling'].includes(current.status) };
        }),
        removed, removedAt: Object.fromEntries(removed.map(id => [id, times.get(id)])), missing, cliReady, at };
    }
    const manager = codexConversationManager(null, codexHistoryScopes(), 'local');
    if (!manager || manager.hostId !== 'local') return { ready: false };
    const client = manager.requestClient, rows = [], active = new Set();
    const catalogRow = (row, archived) => ({ id: row.id, archived, path: row.path, title: row.name || '',
      workspace: row.cwd || '', host: '', running: row.status?.type === 'active', lastUsed: (row.updatedAt || 0) * 1000 });
    let cursor = null;
    do {
      const page = await client.sendRequest('thread/list', { archived: false, cursor, limit: 100, modelProviders: null, sourceKinds: null, sortKey: 'updated_at', useStateDbOnly: true }, { priority: 'background', source: 'thread_list' });
      for (const row of page.data) { active.add(row.id); rows.push(catalogRow(row, false)); }
      cursor = page.nextCursor;
    } while (cursor);
    const removed = [], unknown = [];
    for (let i = 0; i < ids.length; i += 6) await Promise.all(ids.slice(i, i + 6).filter(id => !active.has(id)).map(async id => {
      try {
        const { thread } = await client.sendRequest('thread/read', { threadId: id, includeTurns: false }, { priority: 'background', source: 'thread_list' });
        rows.push({ ...catalogRow(thread, /[\\/]archived_sessions[\\/]/.test(thread.path || '')), id });
      } catch (error) {
        if (/thread.*not found|no rollout found|thread.*does not exist/i.test(String(error))) removed.push(id);
        else if (/AppServerRequestError\(-32600\): thread not loaded:/i.test(String(error))) unknown.push(id);
        else throw error;
      }
    }));
    return { ready: true, complete: false, rows, removed, unknown };
  };
  const nativePreviewActivity = (tools, model, effort = '', tasks = null) => {
    const states = { completed: 'done', complete: 'done', in_progress: 'run', inProgress: 'run', running: 'run', failed: 'error', error: 'error', declined: 'error' };
    return { model: model || '', effort: effort || '', tasks, tools: [...new Map(tools.map(tool => [tool.id, tool])).values()].slice(-3).map(tool => ({
      id: tool.id, label: String(tool.label || '').replace(/\s+/g, ' ').trim().slice(0, 240), state: states[tool.status] || '',
    })).filter(tool => tool.label) };
  };
  const cursorMessages = async (id, data, headers) => {
    const missing = headers.filter(header => !data.conversationMap[header.bubbleId] || data.conversationMap[header.bubbleId].isPlaceholder);
    const service = cursorSessionServices().data;
    const stored = missing.length ? await service._composerMessageStorageService.retrieveMessagesBatch(id, missing.map(header => header.bubbleId)) : new Map();
    return headers.map(header => stored.get(header.bubbleId) || data.conversationMap[header.bubbleId]).filter(Boolean);
  };
  const nativeSessionPreview = async (app, id, previous) => {
    const summary = value => {
      const text = String(value || '').replace(/\s+/g, ' ').trim();
      return { available: true, last: text.slice(-600), text };
    };
    if (app === 'cursor') {
      const service = cursorSessionServices()?.data;
      const peek = await service.composerDataHandleManager.peekComposerData(id);
      const data = peek?.source === 'memory' ? peek.handle.data : peek?.data;
      if (!data) return { available: false };
      const headers = (data.fullConversationHeadersOnly || []).slice(-12);
      const messages = await cursorMessages(id, data, headers);
      const selected = data.modelConfig?.selectedModels?.[0], model = cursorPickerProps(true)?.models.find(m => m.name === selected?.modelId || m.id === selected?.modelId);
      const todos = data.todos || [], tasks = todos.length ? { done: todos.filter(t => t.status === 'completed').length, total: todos.length, current: todos.find(t => t.status === 'in_progress')?.content || '' } : null;
      const tools = messages.slice(messages.findLastIndex(m => m?.type === 1) + 1).filter(m => m?.toolFormerData).map(m => {
        const tool = m.toolFormerData;
        return { id: tool.toolCallId || m.bubbleId, label: tool.toolCall?.tool?.value?.description || tool.params?.commandDescription || tool.name, status: tool.error ? 'error' : tool.status };
      });
      return { ...summary(messages.findLast(m => m?.text?.trim())?.text), ...nativePreviewActivity(tools, model?.clientDisplayName || model?.inputboxShortModelName || selected?.modelId || data.modelConfig?.modelName, '', tasks) };
    }
    if (app === 'devin') {
      const messages = window.__acpStore?.getState().acp.perSession[id]?.messages;
      if (!messages) return { available: false };
      const message = messages.findLast(m => ['agent_message', 'user_message'].includes(m.kind)
        && m.content?.some(block => block.content?.type === 'text' && block.content.text?.trim()));
      const config = devinSessionRecord(id)?.configOptions?.find(c => c.category === 'model');
      const model = config?.options.flatMap(o => o.options || [o]).find(o => o.value === config.currentValue)?.name;
      const tools = messages.slice(messages.findLastIndex(m => m.kind === 'user_message') + 1).filter(m => m.kind === 'tool_call').map(m => ({
        id: m.content.toolCallId || m.id, label: m.content.title, status: m.content.status,
      }));
      return { ...summary(message?.content.filter(block => block.content?.type === 'text').map(block => block.content.text).join('\n')), ...nativePreviewActivity(tools, model) };
    }
    const scopes = codexHistoryScopes();
    const host = codexChatRows(true).find(row => row.id === id)?.host || 'local';
    const manager = codexConversationManager(id, scopes, host);
    const conversation = manager?.getConversation(id), history = conversation?.turnHistory?.history;
    const sourceOfTurn = turn => ({ metadata: turn, rawItems: turn.items || [], nativeComplete: true, ids: (turn.items || []).map(i => i.id), positions: new Map((turn.items || []).map((item, n) => [item.id, n])) });
    let sources = history ? history.islands.flatMap(island => island.entries).slice(-2).map(({ key }) => {
      const turn = history.entitiesByKey[key];
      return codexTurnSource({ historyEntityKey: key, turnId: turn.turnId, nativeTurn: turn }, scopes);
    }).filter(Boolean) : (conversation?.turns || []).slice(-2).map(sourceOfTurn);
    let items = sources.flatMap(source => source.rawItems).filter(Boolean);
    let historical = false;
    if (!items.some(item => ['agentMessage', 'userMessage'].includes(item.type))) {
      if (previous?.historical) return previous;
      if (!manager || manager.hostId !== 'local') return { available: false };
      const { thread } = await manager.requestClient.sendRequest('thread/read', { threadId: id, includeTurns: true }, { priority: 'background', source: 'thread_list' });
      items = (thread.turns || []).flatMap(turn => turn.items || []);
      sources = (thread.turns || []).slice(-1).map(sourceOfTurn);
      historical = true;
    }
    const text = item => item.type === 'agentMessage' ? item.text : item.type === 'userMessage' ? codexUserText(item.content || []) : '';
    const source = sources.at(-1), turn = source && codexStoredTurn({ turnId: source.metadata.turnId || '' }, scopes, false, source);
    const rows = turn ? codexTurnItems(null, { conversationId: id, turn }) : [];
    const task = rows.findLast(row => row.k === 'tasks');
    const tasks = task ? { done: task.done, total: task.total, current: task.items?.find(t => t.status === 'in_progress')?.t || '' } : null;
    const tools = rows.filter(row => row.k === 'tool').slice(-3).map(row => {
      const item = source.rawItems.find(item => item && row.i.endsWith(':' + item.id));
      return { id: item?.id || row.i, label: row.t, status: item?.status };
    });
    return { ...summary(text(items.findLast(item => text(item)?.trim()) || {})), historical,
      ...nativePreviewActivity(tools, conversation?.latestModel, conversation?.latestThreadSettings?.effort, tasks) };
  };
  const nativeSessionInfo = (app, id, catalog = false, previous = null) => {
    if (catalog === 'draft' && app === 'codex') return codexConversationDraft(id, previous === null ? undefined : previous);
    if (catalog === 'clearDraft' && app === 'codex') return codexConversationDraft(id, '', previous);
    if (catalog === 'composer' && app === 'codex') return (async () => {
      const { scope, composer } = await codexComposerScope(id);
      const state = scope.get(composer.q), context = await nativeSessionContext(app, id);
      const ide = codexQueryClient()?.getQueryData(['ide-context', null]);
      const activePath = ide?.activeFile?.path || '';
      return { ...state, workspaceRoots: context.roots.map(row => row.root),
        ideContext: state.isAutoContextOn && context.roots.some(row => activePath.startsWith(row.root + '/')) ? ide : null };
    })();
    if (catalog === 'sendError') return (window.__remoteAgentSubmitErrors || []).find(error => error.requestId === previous)?.message || '';
    if (catalog === 'bind') return (async () => {
      const context = await nativeSessionContext(app, id);
      if (app === 'codex') {
        const manager = codexConversationManager(id, codexHistoryScopes(), context.host || 'local');
        if (!manager.getConversation(id) || manager.needsResume(id)) {
          const state = await manager.resumeConversation(nativeValue({ conversationId: id, model: null, reasoningEffort: null,
            workspaceRoots: context.roots.map(row => row.root), collaborationMode: manager.getConversation(id)?.latestCollaborationMode || null }));
          if (state.status === 'not-ready') throw new Error('Codex 原生会话尚未就绪');
        }
        await manager.ensureConversationHistoryLoaded(id);
      } else if (app === 'devin') {
        const native = await import('@exa/chat-client');
        await window.__acpStore.dispatch(native.loadTranscriptsThunk([id]));
      }
      return context;
    })();
    if (catalog === 'context') return nativeSessionContext(app, id);
    if (catalog === 'preview') return nativeSessionPreview(app, id, previous);
    if (catalog) return nativeSessionCatalog(app, id);
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
    if (action === 'capacityTarget' && app === 'codex') {
      const scopes = codexHistoryScopes(), manager = codexNativeManager();
      if (agentRun(app, id, scopes, manager)?.id !== name || codexVisibleThread() !== id) return null;
      const capacity = codexCapacityItem();
      return capacity?.b?.length ? codexPoint(capacity._retry) : null;
    }
    if (action === 'send') {
      let submitted;
      if (app === 'codex') {
        const manager = codexNativeManager(), conversation = manager.getConversation(id);
        submitted = manager.sendFollowUpMessage(id, nativeValue({ prompt: name.text, model: conversation.latestModel,
          reasoningEffort: conversation.latestReasoningEffort, attachmentContext: name.composer }));
      } else if (app === 'cursor') {
        submitted = cursorSessionServices().composer.composerChatService.submitChatMaybeAbortCurrent(id, name.text,
          { skipClearInput: true, skipFocusAfterSubmission: true, _internalPreserveDraft: true, ignoreQueuing: name.when === 'now' });
      } else {
        const native = await import('@exa/chat-client'), session = devinSessionRecord(id);
        submitted = window.__acpStore.dispatch(native.sendAgentRequestThunk(session.providerId,
          { method: 'session/prompt', params: { sessionId: id, prompt: [{ type: 'text', text: name.text }] } }, native.tryGetAcpSingleton('sendAgentRequest')));
      }
      Promise.resolve(submitted).catch(error => {
        (window.__remoteAgentSubmitErrors ||= []).push({ requestId: name.requestId, message: String(error.message || error) });
        doc.defaultView.dispatchEvent(new doc.defaultView.Event('remote-agent-submit-error'));
      });
      return true;
    }
    if (action === 'stop') {
      if (app === 'codex') await codexNativeManager().interruptConversation(id, 'user-stop');
      else if (app === 'cursor') await cursorSessionServices().composer.cancelChat(id);
      else {
        const native = await import('@exa/chat-client'), session = devinSessionRecord(id);
        await window.__acpStore.dispatch(native.sendAgentRequestThunk(session.providerId,
          { method: 'session/cancel', params: { sessionId: id } }, native.tryGetAcpSingleton('sendAgentRequest')));
      }
      return true;
    }
    if (action === 'model' && app === 'codex') return pickCodexModel(name);
    if (action === 'model' && app === 'devin') return pickDevinModel(name);
    if (action === 'effort') return pickEffort(name);
    if (app === 'cursor') {
      const services = cursorSessionServices();
      if (action === 'open') { await services.composer.openComposer(id); return true; }
      if (action === 'model') {
        const props = cursorPickerProps(true), model = props.models.find(model => [model.clientDisplayName, model.inputboxShortModelName, model.name].includes(name));
        if (!model && name !== 'Auto') return false;
        props.onSelectionChange([{ modelId: model?.name || 'default', parameters: [] }]);
        return true;
      }
      const session = services?.data.allComposersData.allComposers.find(c => c.composerId === id);
      if (!session) throw new Error('没有找到这个会话');
      if (action === 'rename') {
        if (session.createdFromBackgroundAgent?.bcId) await services.background.renameBackgroundComposer(session.createdFromBackgroundAgent.bcId, name);
        else await services.composer.renameComposer(id, name);
      } else if (action === 'delete') {
        if (services.data.allComposersData.allComposers.length > 1) await services.composer.deleteComposer(id);
        else await services.composer.resetComposer(id);
      } else throw new Error('此会话不支持这个操作');
      const after = (await nativeSessionCatalog('cursor')).rows.find(c => c.id === id);
      const empty = services.data.getComposerDataIfLoaded(id)?.fullConversationHeadersOnly?.length === 0;
      const outcome = action === 'rename' ? 'rename' : after?.archived ? 'archive' : !after ? 'delete' : empty ? 'clear' : null;
      return { confirmed: action === 'rename' ? after?.title === name : !!outcome, action: outcome };
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
