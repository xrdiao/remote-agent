  const nativeValue = value => doc.defaultView.JSON.parse(JSON.stringify(value));
  const codexConnectedRpc = (host, scopes = codexHistoryScopes()) => {
    for (const scope of scopes) for (const bindings of scope.familyBindings.values()) {
      const connection = codexHistoryBinding(scope, bindings.get(host))?.get();
      if (connection?.status === 'ready' && connection.client?.hostId === host) return connection.client.rpc;
    }
    return null;
  };
  const codexRpcCall = (client, method, ...args) => doc.defaultView.Reflect.apply(client[method], client, nativeValue(args));
  const cursorSessionInstantiation = () => {
    const props = [...doc.querySelectorAll('.ui-agent-status-dot, .vscode-model-picker__trigger')].flatMap(el => codexFiberProps(el, Infinity))
      .find(p => p.services?.workspace?.instantiationService);
    return props?.services.workspace.instantiationService;
  };
  const cursorSessionServices = (modeService = false) => {
    if (modeService && window.__remoteAgentCursorModes) return window.__remoteAgentCursorModes;
    if (!modeService && window.__remoteAgentCursorServices) return window.__remoteAgentCursorServices;
    const inst = cursorSessionInstantiation();
    if (!inst) return null;
    const ids = new Map();
    for (let scope = inst; scope; scope = scope._parent)
      for (const [id] of scope._services._entries) if (!ids.has(String(id))) ids.set(String(id), id);
    if (modeService) return window.__remoteAgentCursorModes = inst.invokeFunction(accessor => accessor.get(ids.get('composerModesService')));
    return window.__remoteAgentCursorServices = inst.invokeFunction(accessor => ({
      composer: accessor.get(ids.get('composerService')),
      data: accessor.get(ids.get('composerDataService')),
      background: accessor.get(ids.get('backgroundComposerService')),
      nativeHost: accessor.get(ids.get('nativeHostService')),
      get codeBlocks() { return inst.invokeFunction(scope => scope.get(ids.get('composerCodeBlockService'))); },
    }));
  };
  const cursorSessionWorkspaceUris = (current, header, workspace) => {
    const selected = header?.workspaceIdentifier || current.workspaceIdentifier;
    if (selected?.id === 'empty-window') return [];
    if (selected?.uri) return [selected.uri];
    if (current.workspaceIdentifier?.uri && selected?.id === current.workspaceIdentifier.id) return [current.workspaceIdentifier.uri];
    return selected?.id && selected.id === workspace.id
      ? workspace.folders.map(folder => folder.uri) : null;
  };
  const nativeSessionContext = async (app, id) => {
    if (app === 'codex') {
      const host = remoteContext?.app === 'codex' ? remoteContext.host || 'local' : codexChatRows(true).find(row => row.id === id)?.host || 'local';
      const scopes = codexHistoryScopes(), manager = codexConversationManager(id, scopes, host);
      const client = manager || codexConnectedRpc(host, scopes);
      if (!client) throw new Error('Codex 原生会话连接尚未就绪');
      const conversation = manager?.getConversation(id);
      const thread = conversation || (await codexRpcCall(client, 'readThread', id, { includeTurns: false })).thread;
      const workspace = manager?.getThreadWorkspaceState(id);
      const permissions = conversation?.currentPermissions || (!manager && codexThreadProjection(id, host, scopes)?.currentPermissions);
      const roots = workspace?.project?.projectSources || workspace?.applied?.projectSources || permissions?.runtimeWorkspaceRoots || [thread.cwd];
      return { app, threadId: id, host: host === 'local' ? '' : host, cwd: host === 'local' ? localFilePath(thread.cwd) : thread.cwd,
        roots: roots.filter(Boolean).map(root => ({ root: host === 'local' ? localFilePath(root) : root, host: host === 'local' ? '' : host })) };
    }
    if (app === 'cursor') {
      const services = cursorSessionServices();
      if (!services) throw new Error('Cursor 原生会话管理器尚未就绪');
      const handle = await services.data.getComposerHandleById(id);
      if (!handle) throw new Error('Cursor 原生目录中没有这个会话');
      const data = handle.data, workspace = services.composer.composerChatService._workspaceContextService.getWorkspace();
      const headers = (await services.data._storageService.collectionQuery('composerHeaders')).map(row => JSON.parse(row));
      const uris = cursorSessionWorkspaceUris(data, headers.find(row => row.composerId === id), workspace);
      const roots = (uris || []).map(uri => ({ root: uri.scheme === 'file' ? uriFilePath(uri) : uri.path, host: uri.scheme === 'file' ? '' : uri.authority.replace(/^ssh-remote\+/, '') }));
      const agentWorkspace = !roots.length && cursorWorkspace(id);
      if (agentWorkspace) roots.push(agentWorkspace);
      return { app, threadId: id, host: roots[0]?.host || '', cwd: roots[0]?.root || '', roots, projectless: !roots.length && uris?.length === 0 };
    }
    let session = devinSessionRecord(id);
    if (devinNativeId(id).startsWith('devin-acp/devin-cli/') && !devinDirectoryRow(id)) {
      await nativeSessionCatalog('devin', [id]);
      session = devinSessionRecord(id);
    }
    if (!session) throw new Error('Devin 原生目录中没有这个会话');
    if (session.providerId === 'devin-cli' && !session.cwd) throw new Error('Devin 原生目录尚未提供这个会话的项目路径');
    return { app, threadId: id, provider: session.providerId, host: '', cwd: localFilePath(session.cwd || ''), roots: session.cwd ? [{ root: localFilePath(session.cwd), host: '' }] : [] };
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
      const services = cursorSessionServices(), service = services?.data;
      if (!service) return { ready: false };
      await service.whenInitialComposerDataLoaded();
      const rows = (await service._storageService.collectionQuery('composerHeaders')).map(row => JSON.parse(row));
      const loaded = new Map(service.allComposersData.allComposers.map(row => [row.composerId, row]));
      const workspace = services.composer.composerChatService._workspaceContextService.getWorkspace();
      return { ready: true, complete: true, rows: rows.map(row => {
        const current = loaded.get(row.composerId) || row;
        const uris = cursorSessionWorkspaceUris(current, row, workspace), uri = uris?.[0];
        return { id: row.composerId, archived: !!row.isArchived, title: current.name || row.name || '',
          workspace: uri?.scheme === 'file' ? uriFilePath(uri) : uri?.path || '', host: uri && uri.scheme !== 'file' ? uri.authority.replace(/^ssh-remote\+/, '') : '',
          workspaceId: (row.workspaceIdentifier || current.workspaceIdentifier)?.id || '', projectless: uris?.length === 0,
          workspaceConfirmed: !!uri,
          lastUsed: current.lastUpdatedAt || row.createdAt || 0, running: cursorSessionRunning(row.composerId) };
      }) };
    }
    if (app === 'devin') {
      const native = await import('@exa/chat-client');
      const connectors = native.tryGetAcpSingleton('connectorService');
      if (!connectors?.hasReceivedConnectors()) return { ready: false };
      const sessionsInView = devinSessions();
      const at = Date.now(), cli = [], cliPrefix = 'acp/devin-cli/';
      const cliReady = connectors.getConnectors().some(connector => connector.id === 'devin-cli' && connector.status === 'connected');
      let cursor;
      if (cliReady) do {
        const page = await native.tryGetAcpSingleton('sendAgentRequest')('devin-cli', { method: 'session/list', params: cursor ? { cursor } : {} });
        cli.push(...page.sessions.map(row => ({ ...row, sessionId: 'acp/devin-cli/' + row.sessionId })));
        cursor = page.nextCursor;
      } while (cursor);
      const cliIds = new Set(cli.map(row => row.sessionId));
      const sessions = [...sessionsInView.filter(row => !cliReady || row.providerId !== 'devin-cli'
        || row._meta?.['cognition.ai/isArchived'] === true && !cliIds.has(row.sessionId)), ...cli];
      const displayed = new Map(sessionsInView.map(row => [row.sessionId, row]));
      const known = new Set(sessions.map(row => row.sessionId));
      const requests = Object.values(devinAgentRequests()).filter(request => request.status === 'completed'
        && ['session/archive', 'session/delete', 'session/load', 'session/resume'].includes(request.method));
      const times = new Map();
      for (const request of requests) times.set(request.params.sessionId, Math.max(times.get(request.params.sessionId) || 0, request.completedAt));
      const removed = requests.filter(request => request.method === 'session/delete' && !known.has(request.params.sessionId)).map(request => request.params.sessionId);
      const missing = ids.filter(id => cliReady && id.startsWith(cliPrefix) && !known.has(id));
      const rows = sessions.map(row => {
          const current = displayed.get(row.sessionId) || row;
          return { id: row.sessionId, archived: current._meta?.['cognition.ai/isArchived'] === true,
            at: Math.max(Date.parse(current.updatedAt) || 0, times.get(row.sessionId) || 0),
            title: current.title || row.title || '', workspace: localFilePath(row.cwd || current.cwd || ''), host: '',
            lastUsed: Date.parse(current.updatedAt || row.updatedAt) || 0, running: ['active', 'pending', 'canceling'].includes(current.status) };
        });
      window.__remoteAgentDevinDirectory = new Map(rows.map(row => [row.id, row]));
      return { ready: true, complete: false, rows,
        removed, removedAt: Object.fromEntries(removed.map(id => [id, times.get(id)])), missing, cliReady, at };
    }
    const scopes = codexHistoryScopes();
    const client = codexConversationManager(null, scopes, 'local')?.requestClient || codexConnectedRpc('local', scopes);
    if (typeof client?.sendRequest !== 'function') return { ready: false };
    const requestCatalog = (method, params) => codexRpcCall(client, 'sendRequest', method, params, { priority: 'background', source: 'thread_list' });
    const rows = [], active = new Set();
    const catalogRow = (row, archived) => ({ id: row.id, archived, path: row.path, title: row.name || '',
      workspace: localFilePath(row.cwd || ''), host: '', running: row.status?.type === 'active',
      waiting: row.status?.activeFlags?.includes('waitingOnUserInput') ? 'q:' : row.status?.activeFlags?.includes('waitingOnApproval') ? 'approval' : '',
      statusKnown: ['active', 'idle', 'systemError'].includes(row.status?.type), lastUsed: (row.updatedAt || 0) * 1000 });
    const request = Array.isArray(ids) ? { ids } : ids;
    let nextCursor = null;
    if (!request.threads) {
      const page = await requestCatalog('thread/list', { archived: false, cursor: request.cursor || null, limit: 100, modelProviders: null, sourceKinds: null, sortKey: 'updated_at', useStateDbOnly: true });
      for (const row of page.data) { active.add(row.id); rows.push(catalogRow(row, false)); }
      nextCursor = page.nextCursor;
    }
    const removed = [], unknown = [];
    await Promise.all((request.ids || []).filter(id => !active.has(id)).map(async id => {
      try {
        const { thread } = await requestCatalog('thread/read', { threadId: id, includeTurns: false });
        rows.push({ ...catalogRow(thread, /[\\/]archived_sessions[\\/]/.test(thread.path || '')), id });
      } catch (error) {
        const message = String(error);
        if (/thread.*not found|no rollout found|thread.*does not exist/i.test(message)) removed.push(id);
        // A zero-length rollout cannot supply metadata. Verify its archive state from its native path.
        else if (/(?:AppServerRequestError\(-32600\): |^Error: )thread not loaded:|failed to read session metadata .*: rollout at .* is empty$/i.test(message)) unknown.push(id);
        else throw error;
      }
    }));
    return { ready: true, complete: false, rows, removed, unknown, nextCursor };
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
    const status = (scopes = [], manager = null, host = '') => {
      const run = agentRun(app, id, scopes, manager), waiting = nativeWaiting(app, id, manager);
      return { threadId: id, host, run, busy: run?.status === 'running', ...waiting, statusKnown: !!run || !!waiting };
    };
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
      return { ...summary(messages.findLast(m => m?.text?.trim())?.text), status: status(), ...nativePreviewActivity(tools, model?.clientDisplayName || model?.inputboxShortModelName || selected?.modelId || data.modelConfig?.modelName, '', tasks) };
    }
    if (app === 'devin') {
      return devinReadSession(id, () => {
        const messages = devinMessages(id);
        const message = messages.findLast(m => ['agent_message', 'user_message'].includes(m.kind)
          && m.content?.some(block => block.content?.type === 'text' && block.content.text?.trim()));
        const model = devinSessionModel(id)?.name;
        const tools = messages.slice(messages.findLastIndex(m => m.kind === 'user_message') + 1).filter(m => m.kind === 'tool_call').map(m => ({
          id: m.content.toolCallId || m.id, label: m.content.title, status: m.content.status,
        }));
        const task = devinMessageItems(messages).findLast(item => item.k === 'tasks');
        const tasks = task ? { done: task.done, total: task.total, current: task.items.find(item => item.status === 'in_progress')?.t || '' } : null;
        return { ...summary(devinMessageText(message?.content)), status: status(), ...nativePreviewActivity(tools, model, '', tasks) };
      });
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
      if (previous?.historical) return { ...previous, status: status(scopes, manager, host === 'local' ? '' : host) };
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
    return { ...summary(text(items.findLast(item => text(item)?.trim()) || {})), historical, status: status(scopes, manager, host === 'local' ? '' : host),
      ...nativePreviewActivity(tools, conversation?.latestModel, conversation?.latestThreadSettings?.effort, tasks) };
  };
  const nativeSessionCleanup = async (app, id, perform = false) => {
    const releaseDevinTurnCache = () => {
      const owned = window.__remoteAgentDevinTurns?.get(id);
      owned?.stop?.(); window.__remoteAgentDevinTurns?.delete(id);
    };
    const inspect = async () => {
      if (app === 'codex') {
        const host = remoteContext?.host || 'local', scopes = codexHistoryScopes();
        const client = codexConversationManager(id, scopes, host) || codexConnectedRpc(host, scopes);
        if (!client) throw new Error('Codex 原生会话连接尚未就绪');
        let thread;
        try { ({ thread } = await codexRpcCall(client, 'readThread', id, { includeTurns: false })); }
        catch (error) {
          if (/thread.*not found|no rollout found|thread.*does not exist/i.test(String(error))) return { exists: false };
          throw error;
        }
        return { exists: true, title: thread.name || '', archived: /[\\/]archived_sessions[\\/]/.test(thread.path || ''), running: thread.status?.type === 'active',
          context: { cwd: host === 'local' ? localFilePath(thread.cwd) : thread.cwd, host: host === 'local' ? '' : host } };
      }
      const catalog = await nativeSessionCatalog(app, [id]);
      if (!catalog.ready || catalog.unknown?.includes(id) || catalog.missing?.includes(id) && !catalog.removed?.includes(id)) throw new Error('原生会话清理状态尚未确认');
      const row = catalog.rows.find(row => row.id === id);
      if (!row && !catalog.complete && !catalog.removed?.includes(id)) throw new Error('原生会话清理状态尚未确认');
      return { exists: !!row, title: row?.title || '', archived: !!row?.archived, running: !!row?.running,
        ...(app === 'cursor' ? { deletionBlocked: cursorSessionServices().data.allComposersData.allComposers.length <= 1 } : {}),
        context: row ? row.workspace ? { cwd: row.workspace, host: row.host || '' } : await nativeSessionContext(app, id) : null };
    };
    const before = await inspect();
    if (!perform) return before;
    if (!remoteContext || remoteContext.app !== app || remoteContext.threadId !== id) throw new Error('清理请求不属于这个原生 Binding');
    if (!before.exists || before.archived) {
      if (app === 'devin') releaseDevinTurnCache();
      return { confirmed: true, action: before.archived ? 'archive' : 'delete', already: true };
    }
    if (before.running) throw new Error('原生会话仍在运行，请先停止并核对');
    if (app === 'codex') {
      const host = remoteContext.host || 'local', scopes = codexHistoryScopes();
      const client = codexConversationManager(id, scopes, host) || codexConnectedRpc(host, scopes);
      if (!client) throw new Error('Codex 原生会话连接尚未就绪');
      await codexRpcCall(client, 'archiveConversation', id, { useAppServerPins: false });
    } else if (app === 'cursor') {
      if (cursorSessionServices().data.allComposersData.allComposers.length <= 1) throw new Error('Cursor 当前只有一个原生会话，清空不能代替删除或归档');
      await nativeSessionAction(app, id, 'delete');
    } else {
      const native = await import('@exa/chat-client'), session = devinSessionRecord(id);
      const connector = native.tryGetAcpSingleton('connectorService').getConnectorById(session.providerId);
      if (!connector?.capabilities?.sessionCapabilities?.delete) throw new Error('Devin 未提供该会话的后台删除能力');
      await devinSend(session.providerId,
        { method: 'session/delete', params: { sessionId: id } });
    }
    const after = await inspect();
    if (after.exists && !after.archived) throw new Error('桌面端尚未确认删除或归档完成');
    if (app === 'devin') releaseDevinTurnCache();
    return { confirmed: true, action: after.archived ? 'archive' : 'delete', already: false };
  };
  const cursorProjectPlacement = root => {
    const services = cursorSessionServices();
    const workbench = doc.defaultView.vscode?.context?.configuration?.()?.workspace;
    const folders = services?.composer.composerChatService._workspaceContextService.getWorkspace().folders || [];
    const matches = uri => uri?.scheme === 'file' && samePath(uriFilePath(uri), root);
    return workbench?.id && (matches(workbench.uri) || matches(folders[0]?.uri))
      ? workbench : cursorProjectPicker()?.recentProjects?.find(row => matches(row.workspaceIdentifier?.uri))?.workspaceIdentifier || null;
  };
  const cursorFusionSettings = id => {
    const services = cursorSessionServices();
    const handle = services?.data.getHandleIfLoaded(id);
    const modelConfig = services?.composer.composerChatService._modelConfigService;
    const selected = handle && modelConfig?.getSelectedModelsForComposer(handle)[0];
    const model = selected?.modelId || '';
    const effort = selected?.parameters?.find(row => row.id === 'reasoning_effort')?.value || '';
    return { model, effort, family: model, usage: null };
  };
  const nativeSessionInfo = (app, id, catalog = false, previous = null) => {
    if (app === 'codex' && catalog === 'requestReceipt') return (async () => {
      if (!remoteContext || remoteContext.app !== app || remoteContext.threadId !== id) throw new Error('请求不属于这个任务 Binding');
      const scopes = codexHistoryScopes(), host = codexRequestHost();
      const client = codexNativeManager() || codexConnectedRpc(host, scopes);
      if (!client) return null;
      const conversation = await codexRpcCall(client, 'getConversation', id);
      const state = codexHistoryState(conversation, false, scopes, id);
      const entry = state.entries.find(entry => entry.turnId === previous?.turnId);
      const source = entry && codexTurnSource(entry, scopes);
      if (previous?.itemId) {
        if (codexNativeRequests().some(request => request.id === previous.requestId
            && request.params?.threadId === id && request.params?.turnId === previous.turnId)) return null;
        const commands = (source?.rawItems || []).filter(item => item?.type === 'commandExecution' && item.id === previous.itemId);
        if (commands.length !== 1) return null;
        const item = commands[0];
        return { type: item.type, id: item.id, status: item.status, exitCode: item.exitCode, turnId: entry.turnId };
      }
      const receipts = (source?.rawItems || []).filter(item => item?.type === 'userInputResponse'
        && item.requestId === previous?.requestId && item.turnId === previous?.turnId
        && item.id === 'user-input-response-' + previous.requestId && item.completed === true);
      if (receipts.length !== 1 || JSON.stringify(receipts[0]).length > 64000) return null;
      return receipts[0];
    })();
    if (app === 'codex' && catalog === 'pendingRequests') {
      if (!remoteContext || remoteContext.app !== app || remoteContext.threadId !== id) throw new Error('请求不属于这个任务 Binding');
      const client = codexNativeManager() || codexConnectedRpc(codexRequestHost());
      const requests = codexNativeRequests().map(request => ({ id: request.id, method: request.method, params: request.params }));
      if (requests.length > 20 || JSON.stringify(requests).length > 64000) throw new Error('Codex 原生请求过大，无法完整核验');
      return { thread: id, requests, methods: ['replyWithUserInputResponse', 'replyWithCommandExecutionApprovalDecision']
        .filter(method => typeof client?.[method] === 'function') };
    }
    if (app === 'devin' && catalog === 'cancelState') {
      if (remoteContext && (remoteContext.app !== app || remoteContext.threadId !== id)) throw new Error('请求不属于这个任务 Binding');
      return devinCancelState(id);
    }
    if (catalog === 'fusionState') {
      const scopes = app === 'codex' ? codexHistoryScopes() : [];
      const manager = app === 'codex' ? codexNativeManager() : null;
      const questions = app === 'cursor' ? cursorNativeQuestions() : app === 'devin' ? devinQuestions(id)
        : { codex: true, requests: codexRequestData() };
      const waiting = nativeWaiting(app, id, manager) || {};
      if (questions?.requests?.length) Object.assign(waiting, {
        waiting: JSON.stringify([id, ...questions.requests.map(request => request.id)]),
        waitingText: questions.requests.map(request => request.text).join('\n'),
      });
      const items = app === 'cursor' ? (waiting.waitingToolIds || []).filter(approvalId => approvalId !== questions?.id)
        .map(approvalId => {
          const { capability, terminal } = cursorPendingTool(id);
          const tool = terminal?.toolCallId === approvalId ? terminal.tool : capability.getBubbleDataByToolCallId(approvalId);
          const scope = JSON.stringify(tool?.params || {}), permissionKey = JSON.stringify({ name: tool?.name, params: tool?.params || {} });
          return { i: approvalId, approvalId, permission: tool?.name || '', scope: scope.slice(0, 2000),
            permissionKey: permissionKey.length <= 64000 ? permissionKey : null, b: ['Run', 'Skip'],
            actions: [approvalId + ':accept', approvalId + ':reject'] };
        }) : [];
      let requestBinding = null;
      if (app === 'cursor' && waiting.waitingToolIds?.length === 1) {
        const { data, capability, decisions, terminal } = cursorPendingTool(id);
        const requestId = waiting.waitingToolIds[0];
        const bubbleId = terminal?.toolCallId === requestId ? terminal.bubbleId : capability.getPendingDecisionBubbleIdForToolCall(requestId);
        const headers = data.fullConversationHeadersOnly || [], at = headers.findIndex(header => header.bubbleId === bubbleId);
        const activeOwner = !!data.conversationActionManager && !data.conversationActionManager.signal.aborted;
        // The current Cursor may remove a pending ask_question tool bubble
        // from headers while still holding its unique live native decision.
        const liveQuestion = questions?.id === requestId && decisions.length === 1 && activeOwner
          && capability.getBubbleDataByToolCallId(requestId)?.name === 'ask_question';
        const user = at >= 0 ? headers.slice(0, at).findLast(header => header.type === 1)
          : bubbleId && liveQuestion ? headers.findLast(header => header.type === 1) : null;
        if (user && bubbleId && data.chatGenerationUUID)
          requestBinding = { bubbleId, messageId: user.bubbleId, generationId: data.chatGenerationUUID };
      }
      return { state: { ...waiting, thread: id }, questions, items, requestBinding,
        ...(app === 'devin' ? { permissions: devinPermissionState(id) } : {}) };
    }
    if (app === 'cursor' && catalog === 'projectPlacement') return cursorProjectPlacement(previous);
    if (app === 'cursor' && catalog === 'projectThread') return (async () => {
      const thread = agentStartupState(app, true)?.thread;
      if (!thread || !cursorChatReady(thread)) return null;
      const context = await nativeSessionContext(app, thread);
      return context.roots.some(root => !root.host && samePath(root.root, previous)) ? thread : null;
    })();
    if (app === 'devin' && catalog === 'missing') {
      const state = devinSessionData(id);
      return state?.loadStatus === 'failed' && state.loadErrorKind === 'session_not_found';
    }
    if (app === 'codex' && ['creationReady', 'cancelReady'].includes(catalog)) {
      const host = remoteContext?.host || 'local', scopes = codexHistoryScopes();
      const manager = codexConversationManager(id, scopes, host), client = manager || codexConnectedRpc(host, scopes);
      return catalog === 'creationReady'
        ? typeof client?.startConversation === 'function' && typeof client?.prepareThreadStart === 'function'
        : manager ? typeof manager.interruptConversation === 'function' : typeof client?.interruptConversationWithOutcome === 'function';
    }
    if (app === 'codex' && catalog === 'goal') return (async () => {
      const host = remoteContext?.app === 'codex' ? remoteContext.host || 'local' : codexChatRows(true).find(row => row.id === id)?.host || 'local';
      const scopes = codexHistoryScopes(), manager = codexConversationManager(id, scopes, host);
      const client = manager || codexConnectedRpc(host, scopes);
      if (!client) throw new Error('Codex 原生会话尚未就绪');
      if (previous.method === 'thread/goal/set' && previous.params.status === 'active') {
        const mode = (await codexRpcCall(client, 'getConversation', id))?.latestCollaborationMode;
        const settings = mode?.mode === 'plan' ? { collaborationMode: { ...mode, mode: 'default' } } : undefined;
        const goal = previous.params.objective
          ? await codexRpcCall(client, 'setThreadGoal', id, { objective: previous.params.objective, ...(settings ? { threadSettings: settings } : {}) })
          : await codexRpcCall(client, 'setThreadGoalStatus', id, { status: 'active', ...(settings ? { threadSettings: settings } : {}) });
        return { goal };
      }
      return manager ? manager.requestClient.sendRequest(previous.method, nativeValue(previous.params))
        : codexRpcCall(client, 'sendRequest', previous.method, previous.params);
    })();
    if (catalog === 'history' && (app === 'cursor' || app === 'devin')) return (async () => {
      const context = await nativeSessionContext(app, id);
      return nativeConversationChat(true, 160, previous, context);
    })();
    if (catalog === 'receipt' && app === 'devin') {
      // Send receipts read the already selected native store. Resuming here
      // reloads an active prompt and can wait for generation or approval.
      const data = devinSessionData(id);
      if (!data || data.loadStatus === 'failed') throw new Error('Devin 原生会话尚未就绪');
      const messages = devinMessages(id, data);
      const first = Math.max(0, messages.length - 120);
      return { thread: id, draft: composerDraft(), queued: devinQueued(id),
        human: devinMessageItems(messages.slice(first), 'acp', first).filter(item => item.k === 'human') };
    }
    if (app === 'codex' && catalog === 'toolDetails') {
      const scopes = codexHistoryScopes(), manager = codexConversationManager(id, scopes);
      const state = codexHistoryState(manager?.getConversation(id) || null, false, scopes, id), tools = new Set(previous);
      return state.entries.flatMap(entry => {
        const turn = codexStoredTurn(entry, scopes);
        return codexTurnItems(null, { ...entry, turn }, 0, tools, id).filter(item => tools.has(item.i));
      });
    }
    if (app === 'cursor' && catalog === 'connection') {
      const data = cursorSessionServices()?.data.getComposerDataIfLoaded(id);
      return data ? { updatedAt: Math.max(Number(data.lastUpdatedAt) || 0, Number(data.conversationCheckpointLastUpdatedAt) || 0) } : null;
    }
    if (app === 'cursor' && catalog === 'mode') {
      const modes = cursorSessionServices(true), current = modes.getComposerUnifiedMode(id);
      return { items: modes.getAllModes().map(mode => ({ label: mode.name, id: mode.id,
        desc: mode.description || '', checked: mode.id === current })) };
    }
    if (app === 'devin' && catalog === 'mode') {
      const config = devinSessionRecord(id).configOptions.find(option => option.category === 'mode');
      return { items: (config?.options || []).flatMap(group => group.options || [group]).map(option => ({
        label: option.name, id: option.value, desc: option.description || '', checked: option.value === config.currentValue })) };
    }
    if (app === 'codex' && catalog === 'refreshCatalog') return (async () => {
      const manager = codexConversationManager(null, codexHistoryScopes(), 'local');
      const queries = codexQueryClient();
      if (!queries) throw new Error('Codex 原生会话目录尚未就绪');
      if (manager) await manager.refreshRecentConversations({ afterCurrent: true });
      await queries.refetchQueries({ queryKey: ['recent-conversations-meta'], type: 'all' }, { throwOnError: true, cancelRefetch: false });
      if (id && manager) await manager.threadStore.hydrateThreads([id], {
        addToRecentConversations: true, notifyAnyCallbacks: true, shouldThrowOnReadError: true,
      });
      return true;
    })();
    if (app === 'codex' && catalog === 'connection') return (async () => {
      const scopes = codexHistoryScopes(), manager = codexConversationManager(id, scopes, 'local');
      const client = manager || codexConnectedRpc('local', scopes);
      if (!client) return null;
      const role = manager?.getStreamRole(id)?.role;
      const loaded = await codexRpcCall(client, 'sendRequest', 'thread/loaded/list', {});
      const local = loaded.data.includes(id);
      if (!local && role !== 'owner' && role !== 'follower') return null;
      const conversation = manager?.getConversation(id) || (await codexRpcCall(client, 'readThread', id, { includeTurns: false })).thread;
      return { cwd: localFilePath(conversation.cwd), role, loaded: local, visible: codexVisibleThread() === id };
    })();
    if (app === 'codex' && catalog === 'owner') {
      const manager = codexConversationManager(id, codexHistoryScopes(), 'local');
      return manager?.getStreamRole(id)?.role === 'owner' ? { cwd: localFilePath(manager.getConversation(id).cwd) } : null;
    }
    if (app === 'codex' && ['modelSettings', 'modelPage', 'speedRequirements'].includes(catalog)) return (async () => {
      const owner = await codexModelOwner(id), client = owner.client;
      if (catalog === 'modelPage') return codexRpcCall(owner.requestClient, 'sendRequest', 'model/list', previous);
      if (catalog === 'speedRequirements') return codexRpcCall(owner.requestClient, 'sendRequest', 'configRequirements/read', {});
      const conversation = owner.conversation;
      const settings = conversation.latestThreadSettings || {};
      const model = settings.model || conversation.latestModel;
      const picker = codexVisibleThread() === id ? codexSpeedPicker() : null;
      const pickerModel = picker?.model || (picker && codexPickerProps()?.model);
      const speed = picker && !picker.serviceTierOptionsLoading && (!pickerModel || pickerModel === model)
        ? { selected: picker.selectedServiceTier, options: picker.serviceTierOptions.filter(option => !option.disabled).map(option => ({
          id: option.value,
          label: (typeof option.label === 'string' ? option.label : option.label?.defaultMessage)
            || option.tier?.name || option.value || 'Standard',
          description: (typeof option.description === 'string' ? option.description : option.description?.defaultMessage) || '',
          icon: option.iconKind,
        })) } : null;
      return { model, effort: settings.effort ?? conversation.latestReasoningEffort,
        serviceTier: settings.serviceTier ?? null, modelProvider: settings.modelProvider || conversation.modelProvider,
        speed,
        ...(previous === true ? { account: await codexRpcCall(owner.requestClient, 'sendRequest', 'account/read', { refreshToken: false }) } : {}) };
    })();
    if (catalog === 'cleanup' || catalog === 'name') return nativeSessionCleanup(app, id);
    if (catalog === 'settings') {
      if (app === 'cursor') return cursorFusionSettings(id);
      if (app === 'codex') return (async () => {
        const { conversation: value } = await codexModelOwner(id);
        const settings = value.latestThreadSettings || {};
        return { model: settings.model || value.latestModel, effort: settings.effort ?? value.latestReasoningEffort ?? '', family: settings.model || value.latestModel,
          usage: value.latestTokenUsageInfo || null, usageBasis: '原生会话用量资料；不等于单任务账单' };
      })();
      const config = devinSessionRecord(id)?.configOptions.find(row => row.category === 'model');
      return { model: config?.currentValue || '', family: '', effort: '', usage: null,
        usageBasis: '原生 ACP 会话未提供可归因的任务账单；模型 ID 包含原生强度' };
    }
    if (catalog === 'creation') {
      const value = window.__remoteAgentNativeCreations?.get(previous);
      return value ? { status: value.status, context: value.context, nativeThreadId: value.nativeThreadId, error: value.error } : null;
    }
    if (catalog === 'actions' && app === 'devin') return (async () => {
      const native = await import('@exa/chat-client'), session = devinSessionRecord(id);
      if (!session) return null;
      const connector = native.tryGetAcpSingleton('connectorService').getConnectorById(session.providerId);
      if (connector?.status !== 'connected') throw new Error('Devin 原生连接尚未就绪');
      return { title: session.title || '', archived: session._meta?.['cognition.ai/isArchived'] === true,
        running: ['active', 'pending', 'canceling'].includes(session.status),
        actions: [...(connector.capabilities?._meta?.['cognition.ai/sessionRename'] ? ['rename'] : []),
          ...(connector.capabilities?._meta?.['cognition.ai/sessionArchiving'] ? ['archive'] : []),
          ...(connector.capabilities?.sessionCapabilities?.delete ? ['delete'] : [])] };
    })();
    if (app === 'cursor' && ['actions', 'list'].includes(catalog)) return (async () => {
      const value = await nativeSessionCatalog(app, [id]);
      if (!value.ready) {
        if (catalog === 'list') return null;
        throw new Error('Cursor 会话目录正在读取，请稍后重试');
      }
      if (catalog === 'actions') {
        const row = value.rows.find(row => row.id === id);
        return row ? { ...row, actions: ['rename', 'delete'] } : null;
      }
      const displayed = new Map(agentList().map(row => [row.id, row]));
      return value.rows.filter(row => !row.archived).map(row => ({ ...displayed.get(row.id), ...row,
        title: row.title || '新会话', current: row.id === activeThread(), titleNative: true }));
    })();
    if (catalog === 'actions') return nativeSessionInfo(app, id);
    if (catalog === 'tools') return fusionNativeTools.requests(app, id);
    if (catalog === 'toolReceipt' && app === 'codex') return fusionNativeTools.receipt(app, id, previous);
    if (catalog === 'fusionCall' && app === 'devin') return fusionDevinCall(id, previous);
    if (catalog === 'fusionCall' && app === 'codex') return fusionNativeTools.identify(app, id, previous);
    if (catalog === 'draft' && app === 'codex') return previous && typeof previous === 'object'
      ? codexConversationDraft(id, previous.text, previous.expected, previous.format) : codexConversationDraft(id, previous === null ? undefined : previous);
    if (catalog === 'clearDraft' && app === 'codex') return codexConversationDraft(id, '', previous);
    if (catalog === 'composer' && app === 'codex') return (async () => {
      const value = await codexComposerScope(id, false);
      if (!value) return null;
      const { scope, composer } = value;
      const draftEditedAt = doc.defaultView.__remoteAgentDraftEdits?.get(id) || 0;
      if (previous === 'draft') return codexConversationDraft(id, undefined, undefined, 'snapshot');
      const state = scope.get(composer.state);
      const ide = state.isAutoContextOn && codexQueryClient()?.getQueryData(['ide-context', null]);
      const activePath = ide?.activeFile?.path || '';
      const host = remoteContext?.host || '';
      let roots = remoteContext?.threadId === id && remoteContext.cwd ? [remoteContext.cwd] : [];
      if (activePath && codexConversationManager(id, codexHistoryScopes(), host || 'local')) {
        roots = (await nativeSessionContext(app, id)).roots.map(row => row.root);
      }
      return { ...state, draftEditedAt, ideContext: activePath && roots.some(root =>
        pathKey(activePath, !host).startsWith(pathKey(root, !host).replace(/\/$/, '') + '/')) ? ide : null };
    })();
    if (catalog === 'sendError') return window.__remoteAgentNativeSubmissions?.get(previous) || null;
    if (catalog === 'bind') return (async () => {
      if (app === 'devin') return devinReadSession(id, () => nativeSessionContext(app, id));
      const context = await nativeSessionContext(app, id);
      if (app === 'cursor') {
        const handles = window.__remoteAgentNativeHandles ||= new Map();
        const key = JSON.stringify([id, previous]);
        if (!handles.has(key)) handles.set(key, await cursorSessionServices().data.getComposerHandleById(id));
      } else if (app === 'codex') {
        const host = context.host || 'local', scopes = codexHistoryScopes(), manager = codexConversationManager(id, scopes, host);
        const client = manager || codexConnectedRpc(host, scopes);
        if (!client) throw new Error('Codex 原生会话连接尚未就绪');
        const conversation = await codexRpcCall(client, 'getConversation', id);
        if (!conversation || (manager ? manager.needsResume(id) : conversation.resumeState !== 'resumed')) {
          const state = await codexRpcCall(client, 'resumeConversation', { conversationId: id, model: null, reasoningEffort: null,
            workspaceRoots: context.roots.map(row => row.root), collaborationMode: conversation?.latestCollaborationMode || null });
          if (state.status === 'not-ready') throw new Error('Codex 原生会话尚未就绪');
        }
      }
      return context;
    })();
    if (catalog === 'context') return nativeSessionContext(app, id);
    if (catalog === 'preview') return nativeSessionPreview(app, id, previous);
    if (catalog) return nativeSessionCatalog(app, id);
    if (app === 'cursor') {
      const services = cursorSessionServices();
      const session = services?.data.allComposersData.allComposers.find(c => c.composerId === id);
      return session ? { title: session.name || 'New Agent', archived: !!session.isArchived, running: cursorSessionRunning(id, undefined, activeThread() === id && isBusy()), actions: ['rename', 'delete'] } : null;
    }
    const session = devinSessionRecord(id);
    if (!session) return null;
    const actions = devinSessionMenu(id)?.actions || [];
    return { title: session.title || '', archived: session._meta?.['cognition.ai/isArchived'] === true, running: ['active', 'pending', 'canceling'].includes(session.status),
      actions: ['rename', 'archive', 'delete'].filter(name => actions.some(a => a.label.toLowerCase() === name && !a.disabled)) };
  };
  const nativeCodexCreation = async (id, spec, prepare) => {
    const scopes = codexHistoryScopes();
    const host = remoteContext?.app === 'codex' ? remoteContext.host || 'local' : codexChatRows(true).find(row => row.id === id)?.host || 'local';
    const manager = codexConversationManager(id, scopes, host), client = manager || codexConnectedRpc(host, scopes);
    if (typeof client?.startConversation !== 'function' || typeof client?.prepareThreadStart !== 'function')
      throw new Error('当前 Codex 面板未提供原生会话创建接口');
    const parent = id ? await codexRpcCall(client, 'getConversation', id) : null;
    const { scope } = await codexComposerScope(codexVisibleThread() || '');
    const createInputs = await codexNativeModule('creation');
    const reader = createInputs(scope, host);
    const root = host === 'local' ? localFilePath(spec.root || parent?.cwd) : spec.root || parent?.cwd;
    if (!root) throw new Error('新建原生会话前需要明确项目目录');
    const options = { input: [], cwd: root, workspaceRoots: [root], initialTitle: spec.title,
      ...(samePath(root, parent?.cwd, host === 'local') ? { permissionsConfig: parent.currentPermissions } : { useAppServerPermissionDefault: true }),
      collaborationMode: spec.model ? { mode: 'default', settings: { model: spec.model, reasoning_effort: spec.effort || null, developer_instructions: null } } : parent?.latestCollaborationMode,
      additionalDeveloperInstructions: spec.instructions,
      ...(spec.mcp ? { config: { ['mcp_servers.' + spec.mcp.name]: { url: spec.mcp.url } } } : {}) };
    if (spec.mcp && (host !== 'local' || spec.role !== 'main' || spec.mcp.name !== 'ra-fusion'))
      throw new Error('Codex 会话级 Fusion MCP 仅用于 RA 创建的本机主控会话');
    const read = async (params, history) => {
      const inputs = await reader.readCreationInputs(params, history);
      if (spec.instructions) inputs.hasDeveloperInstructions = true;
      if (spec.tools?.length && !spec.mcp) {
        const original = inputs.readDynamicTools;
        inputs.hasDeveloperInstructions = true;
        inputs.readDynamicTools = async value => [...await original(value), ...nativeValue(spec.tools)];
      }
      return inputs;
    };
    if (prepare || spec.mcp) {
      const request = await client.prepareThreadStart(nativeValue(options), (params, history) => read(params, history));
      if (spec.mcp && (request.config?.['mcp_servers.' + spec.mcp.name]?.url !== spec.mcp.url
          || request.dynamicTools?.some(tool => tool.name === 'ra_fusion')))
        throw new Error('Codex 原生创建参数未保留会话级 Fusion MCP 配置');
      if (prepare) return { ...(spec.mcp ? { mcp: { name: spec.mcp.name, configured: true, transport: 'http' } } : {}),
        model: request.model, approvalPolicy: request.approvalPolicy, approvalsReviewer: request.approvalsReviewer,
        tools: request.dynamicTools?.map(tool => ({ name: tool.name, type: tool.type, namespace: tool.namespace || '',
          fields: Object.keys(tool), tools: tool.tools?.map(value => ({ name: value.name, type: value.type, fields: Object.keys(value) })) })),
        handlerWritable: manager ? Object.getOwnPropertyDescriptor(manager.threadExecution, 'executeDynamicToolCall')?.writable : false };
    }
    // Keep native input callbacks intact: JSON cloning would silently drop them.
    const record = window.__remoteAgentNativeCreations?.get(spec.requestId);
    const created = await client.startConversation(nativeValue(options), { readThreadCreationInputs: read,
      afterConversationCreated: conversationId => { if (record) record.nativeThreadId = conversationId; } });
    if (created.status !== 'created') throw new Error('原生新会话结果待核对，不能重新创建');
    if (typeof created.conversationId !== 'string' || !created.conversationId || created.conversationId === id
        || record?.nativeThreadId && record.nativeThreadId !== created.conversationId)
      throw new Error('Codex 原生创建身份不一致，不能重新创建');
    if (record) record.nativeThreadId = created.conversationId;
    const context = await nativeSessionContext('codex', created.conversationId);
    if ((context.host || 'local') !== host || !samePath(context.cwd, root, host === 'local')
        || context.roots.length !== 1 || (context.roots[0].host || 'local') !== host
        || !samePath(context.roots[0].root, root, host === 'local'))
      throw new Error('Codex 新会话项目不一致，不能重新创建');
    // An acknowledged empty native thread has no rollout to resume yet. Reuse
    // only this exact created profile in the same native document/client.
    if (spec.mcp) (doc.defaultView.__remoteAgentFusionCodexMcp ||= new Map()).set(
      JSON.stringify([context.host || '', context.threadId]), {
        client, document: doc, profile: JSON.stringify({ instructions: spec.instructions, mcp: spec.mcp }),
        project: JSON.stringify({ host: context.host || '', cwd: context.cwd, roots: context.roots }),
      });
    return context;
  };
  const nativeSessionAction = async (app, id, action, name) => {
    if (app === 'codex' && (action === 'question' || action === 'permission') && name?.requestKey) {
      if (!remoteContext || remoteContext.app !== app || remoteContext.threadId !== id) throw new Error('请求不属于这个任务 Binding');
      if (!['once', 'reject'].includes(name.decision)) throw new Error('仅支持单次原生请求决定');
      const context = await nativeSessionContext(app, id);
      const turn = await codexFusionTurn(name.receipt);
      if (context.host || context.roots.length !== 1 || !samePath(context.cwd, name.project)
          || context.roots.some(root => root.host || !samePath(root.root, name.project))
          || !turn?.current || turn.threadId !== id || turn.id !== name.messageId || turn.turnId !== name.turnId
          || turn.lastUserId !== turn.id || typeof name.nativeInputKey !== 'string'
          || !name.nativeInputKey || codexInputKey(turn.nativeInput) !== name.nativeInputKey
          || !Array.isArray(turn.nativeIds) || !turn.nativeIds.length
          || ![turn.id, id + ':user-message:' + turn.id, ...turn.nativeIds].includes(name.receipt))
        throw new Error('Codex 原生请求不属于该任务的当前轮次');
      const requests = codexNativeRequests().filter(request => request.params?.threadId === id && request.params?.turnId === name.turnId);
      const request = requests[0];
      if (requests.length !== 1 || request.id !== name.requestId || request.method !== name.method
          || JSON.stringify({ id: request.id, method: request.method, params: request.params }) !== name.requestKey)
        throw new Error('这个 Codex 原生请求已更新');
      const client = codexNativeManager() || codexConnectedRpc(codexRequestHost()), params = request.params;
      let method, response;
      if (action === 'question' && request.method === 'item/tool/requestUserInput') {
        method = 'replyWithUserInputResponse';
        if (!Array.isArray(params.questions) || !params.questions.length || params.questions.length > 20
            || new Set(params.questions.map(question => question.id)).size !== params.questions.length)
          throw new Error('原生问题格式无效');
        if (name.decision === 'once' && (!Array.isArray(name.answers) || name.answers.length !== params.questions.length))
          throw new Error('回答数量与原生问题不匹配');
        response = { answers: Object.fromEntries(params.questions.map((question, index) => {
          const values = name.decision === 'reject' ? [] : name.answers[index], options = question.options || [];
          if (name.decision === 'once' && (!Array.isArray(values) || values.length !== 1
              || typeof values[0] !== 'string' || !values[0].trim() || values[0].length > 4000 || values[0].includes('\0')
              || options.filter(option => option.label === values[0]).length > 1
              || options.length && question.isOther !== true && !options.some(option => option.label === values[0])))
            throw new Error('原生问题不接受这个回答');
          return [question.id, { answers: values }];
        })) };
      } else if (action === 'permission' && request.method === 'item/commandExecution/requestApproval') {
        method = 'replyWithCommandExecutionApprovalDecision';
        const decisions = params.availableDecisions ?? ['accept', 'acceptForSession', 'decline', 'cancel'];
        if (!Array.isArray(decisions)) throw new Error('原生命令决定列表无效');
        response = name.decision === 'once' ? 'accept' : decisions.includes('decline') ? 'decline' : 'cancel';
        if (turn.ended || !decisions.includes(response)
            || !params.itemId || params.additionalPermissions != null || params.networkApprovalContext != null)
          throw new Error('这条原生命令请求不支持此单次决定');
      } else throw new Error('这个原生请求没有已验证的回复接口');
      if (typeof client?.[method] !== 'function') throw new Error('Codex 原生请求接口尚未就绪');
      const ack = await codexRpcCall(client, method, id, request.id, response);
      if (ack === false || ack?.error || ack?.ok === false || ack?.accepted === false) return false;
      // Command RPC completion only records an attempt. It carries no native decision receipt.
      if (action === 'permission') return 'UNCONFIRMED';
      // The RPC can return void for a missing request after a concurrent UI reply.
      // Require the native completed receipt and exact answers, never absence alone.
      for (let i = 0; i < 9; i++) {
        const now = await codexFusionTurn(name.receipt);
        if (!now?.current || now.threadId !== id || now.id !== name.messageId || now.turnId !== name.turnId
            || now.lastUserId !== name.messageId || codexInputKey(now.nativeInput) !== name.nativeInputKey) return false;
        if (!codexNativeRequests().some(item => item.id === request.id && item.params?.threadId === id
            && item.params?.turnId === name.turnId)) {
          const receipt = await nativeSessionInfo('codex', id, 'requestReceipt', { turnId: name.turnId, requestId: request.id });
          const expectedQuestions = params.questions.map(question => ({ id: question.id, header: question.header,
            options: (question.options || []).map(option => ({ description: option.description, label: option.label })), question: question.question }));
          if (!receipt || receipt.type !== 'userInputResponse' || receipt.requestId !== request.id
              || receipt.turnId !== name.turnId || receipt.completed !== true
              || JSON.stringify(receipt.questions) !== JSON.stringify(expectedQuestions)
              || !receipt.answers || Object.keys(receipt.answers).length !== params.questions.length
              || params.questions.some(question => JSON.stringify(receipt.answers[question.id]) !== JSON.stringify(response.answers[question.id].answers)))
            return false;
          return true;
        }
        if (i < 8) await new Promise(resolve => setTimeout(resolve, 35));
      }
      return false;
    }
    if (app === 'codex' && action === 'modelSettings') {
      const owner = await codexModelOwner(id);
      owner.check();
      const accepted = await codexRpcCall(owner.client, 'updateThreadSettingsForNextTurn', id, name);
      if (accepted === false) throw new Error('Codex 原生设置未接受');
      await owner.read();
      return nativeSessionInfo(app, id, 'modelSettings');
    }
    if (action === 'project' && app === 'cursor') {
      const services = cursorSessionServices();
      if (!services) return false;
      await services.nativeHost.openWindow([{ folderUri: { $mid: 1, ...localFileUri(name), query: '', fragment: '' } }], { forceReuseWindow: true });
      return true;
    }
    if (action === 'question' && app === 'devin') {
      if (remoteContext && (remoteContext.app !== app || remoteContext.threadId !== id)) throw new Error('请求不属于这个任务 Binding');
      if (name.id.startsWith('devin-permission:')) return nativeSessionAction(app, id, 'permission', name);
      const entry = devinElicitationEntries(id).find(entry => entry.id === name.id);
      if (!entry) throw new Error('这条问题已处理或不属于当前会话');
      const choice = ['accept', 'decline', 'cancel'][name.n];
      if (!choice) throw new Error('问题选项已变化');
      const answer = { action: choice, ...(choice === 'accept' ? { content: RemoteAgentRules.elicitationFields(entry.params.requestedSchema, name.fields || []) } : {}) };
      const response = entry.row.providerId === 'devin-cloud' && entry.row.request.method === 'ext/method' ? { action: answer } : answer;
      return devinSessionHandle(id).respond(entry.key, response);
    }
    if (action === 'permission' && app === 'devin') {
      if (remoteContext && (remoteContext.app !== app || remoteContext.threadId !== id)) throw new Error('请求不属于这个任务 Binding');
      if (name.permissionKey) {
        const context = await nativeSessionContext(app, id);
        const state = devinPermissionState(id);
        if (!remoteContext || context.host || context.roots.length !== 1
            || !samePath(context.cwd, name.project) || context.roots.some(root => root.host || !samePath(root.root, name.project))
            || !state?.active || state.thread !== id || state.turnId == null || state.turnId === '' || state.turnId !== name.turnId
            || state.pendingCount !== 1 || state.entries.length !== 1
            || state.human?.i !== name.messageId || (state.human.t !== name.prompt
              && (!name.prompt.includes('\n') || state.human.t !== name.prompt.replace(/\n/g, '\n\n\n')))
            || JSON.stringify(state) !== name.permissionKey)
          throw new Error('Devin 原生权限不属于该任务的当前轮次');
      }
      const entry = devinPermissionEntries(id).find(entry => entry.id === name.id);
      if (!entry) throw new Error('这条权限请求已结束或不属于当前会话');
      const option = entry.row.request.params.options[name.n];
      if (!option) throw new Error('原生权限选项已变化');
      if (name.permissionKey && (entry.key !== name.key || option.optionId !== name.optionId
          || entry.row.request.params.options.length !== 6 || name.n !== (name.label === 'Allow' ? 0 : 5)
          || !['Allow', 'Reject'].includes(option.name) || option.name !== name.label
          || name.label === 'Allow' && option.kind !== 'allow_once'
          || name.label === 'Reject' && option.kind !== 'reject_once'))
        throw new Error('禁止持久化或不明确的原生权限决定');
      return devinSessionHandle(id).respond(entry.key, { outcome: { outcome: 'selected', optionId: option.optionId } });
    }
    if (app === 'devin' && ['rename', 'archive', 'delete'].includes(action)) {
      if (remoteContext && (remoteContext.app !== app || remoteContext.threadId !== id)) throw new Error('请求不属于这个任务 Binding');
      const session = devinSessionRecord(id);
      if (!session) throw new Error('没有找到这个会话');
      const info = await nativeSessionInfo(app, id, 'actions');
      if (!info.actions.includes(action)) throw new Error('此会话没有对应的原生操作入口');
      if (action === 'rename') await devinSend(session.providerId, { method: '_cognition.ai/session/rename', params: { sessionId: id, title: name } });
      else await devinSend(session.providerId,
        { method: action === 'archive' ? 'session/archive' : 'session/delete', params: { sessionId: id, ...(action === 'archive' ? { archived: true } : {}) } });
      const after = action === 'delete' ? await nativeSessionCleanup(app, id) : nativeSessionInfo(app, id);
      return { action, confirmed: action === 'rename' ? after?.title === name : action === 'archive' ? !!after?.archived : !after.exists, ...(remoteContext && action === 'rename' ? { title: after?.title } : {}) };
    }
    if (action === 'open' && app === 'devin') {
      const native = await import('@exa/chat-client');
      const api = codexFiberProps(document.querySelector('#chat'), Infinity)
        .find(props => props.vscodeAPI?.executeCommand)?.vscodeAPI;
      if (!api) throw new Error('Devin 原生会话导航尚未就绪');
      await api.executeCommand('devin.sendChatActionMessage', {
        actionType: 'openCascadeIdInChatPanel', payload: native.encodeOpenCascadeIdInChatPanelPayload(devinNativeId(id)),
      });
      return true;
    }
    if (action === 'rename' && remoteContext && app === 'codex') {
      if (remoteContext.app !== app || remoteContext.threadId !== id) throw new Error('请求不属于这个任务 Binding');
      const client = codexNativeManager() || codexConnectedRpc(remoteContext.host || 'local');
      if (!client) throw new Error('Codex 原生会话连接尚未就绪');
      await codexRpcCall(client, 'setThreadTitle', id, name, { requireAcknowledgement: true });
      const { thread } = await codexRpcCall(client, 'readThread', id, { includeTurns: false });
      return { action: 'rename', confirmed: thread.name === name, title: thread.name };
    }
    if (action === 'create') {
      const creations = window.__remoteAgentNativeCreations ||= new Map();
      if (!name.requestId) throw new Error('后台会话创建缺少请求身份');
      const previous = creations.get(name.requestId);
      if (previous) return previous.promise;
      const record = { status: 'creating', context: null };
      creations.set(name.requestId, record);
      record.promise = nativeSessionAction(app, id, 'createNative', name).then(context => {
        record.status = 'created'; record.context = context; return context;
      }, error => {
        record.status = record.nativeThreadId ? 'created_context_pending' : error.jsonRpcCode != null ? 'rejected' : 'unknown';
        record.error = String(error.message || error); throw error;
      });
      return record.promise;
    }
    if (action === 'bindTools') return fusionNativeTools.bind(app, id, name);
    if (action === 'cleanup') return nativeSessionCleanup(app, id, true);
    if (action === 'unbindTools') return fusionNativeTools.unbind(app, id, name);
    if (action === 'toolReply') return fusionNativeTools.reply(app, id, name);
    if (action === 'prepare' && app === 'codex') return nativeCodexCreation(id, name, true);
    if (action === 'createNative' && app === 'codex') return nativeCodexCreation(id, name, false);
    if (action === 'createProjectChat' && app === 'cursor') {
      const services = cursorSessionServices();
      if (!services) throw new Error('Cursor 原生会话管理器尚未就绪');
      const workspace = cursorProjectPlacement(name);
      if (!workspace) throw new Error('Cursor 原生窗口尚未确认所选项目');
      const placement = nativeValue({ workspaceIdentifier: workspace });
      const created = await services.composer.createComposer(nativeValue({ skipSelect: true, skipShowAndFocus: true, partialState: placement }));
      await services.data.persistComposerWorkspacePlacement(created.composerId, placement);
      await services.data.syncComposerHeadersFromCanonicalStorage();
      await services.composer.openComposer(created.composerId);
      return created.composerId;
    }
    if (action === 'release' && app === 'cursor') {
      const handles = window.__remoteAgentNativeHandles;
      const key = JSON.stringify([id, name]);
      handles?.delete(key);
      return true;
    }
    if (action === 'createNative' && app === 'cursor') {
      const services = cursorSessionServices();
      const loaded = id && services.data.getComposerDataIfLoaded(id);
      const owner = loaded && await nativeSessionContext(app, id);
      const host = remoteContext?.host || '';
      const parent = owner && owner.host === host && samePath(owner.cwd, name.root, !host) ? loaded : null;
      if (!parent && !name.workspacePlacement) throw new Error('主会话尚未在这个 Cursor 窗口就绪');
      const placement = { name: name.title, ...(name.workspacePlacement ? { workspaceIdentifier: name.workspacePlacement } : {}) };
      const created = await services.composer.createComposer(nativeValue({
        skipSelect: true, skipShowAndFocus: true,
        partialState: { composerId: name.threadId, ...placement, unifiedMode: 'agent',
          modelConfig: (name.role === 'main' || !parent) && name.model ? { ...parent?.modelConfig,
            selectedModels: [{ modelId: name.model,
              parameters: name.effort ? [{ id: 'reasoning_effort', value: name.effort }] : [] }] } : parent?.modelConfig,
          ...(name.role === 'main' || !parent ? {} : { subagentInfo: { parentComposerId: id, subagentTypeName: 'side-chat' } }) },
      }));
      window.__remoteAgentNativeCreations.get(name.requestId).nativeThreadId = created.composerId;
      await services.data.persistComposerWorkspacePlacement(created.composerId, placement);
      await services.data.syncComposerHeadersFromCanonicalStorage();
      return nativeSessionContext(app, created.composerId);
    }
    if (action === 'createNative' && app === 'devin') {
      const parent = devinSessionRecord(id || activeThread());
      const native = await import('@exa/chat-client');
      const cli = native.tryGetAcpSingleton('connectorService')?.getConnectorById('devin-cli');
      const provider = parent?.providerId || (cli?.status === 'connected' && cli.id);
      if (!provider) throw new Error('当前 Devin 窗口没有就绪的原生连接');
      const created = await devinSend(provider,
        { method: 'session/new', params: { cwd: localFilePath(name.root), mcpServers: name.mcp ? [name.mcp] : [],
          _meta: { 'cognition.ai/skipPreferenceSeeding': true } } });
      created.sessionId = created.sessionId.replace(/^devin-/, '');
      window.__remoteAgentNativeCreations.get(name.requestId).nativeThreadId = created.sessionId;
      return devinReadSession(created.sessionId, async () => {
        if (name.role === 'main' && name.model) await nativeSessionAction(app, created.sessionId, 'model', name.model);
        return nativeSessionContext(app, created.sessionId);
      });
    }
    if (action === 'capacityTarget' && app === 'codex') {
      const scopes = codexHistoryScopes(), manager = codexNativeManager();
      if (agentRun(app, id, scopes, manager)?.id !== name || codexVisibleThread() !== id) return null;
      const capacity = codexCapacityItem();
      return capacity?.b?.length ? codexPoint(capacity._retry) : null;
    }
    if ((action === 'queue' || action === 'submitPrompt') && app === 'devin')
      return devinSubmitComposer(id, { ...name, submit: action === 'submitPrompt' });
    if (action === 'questionText' && app === 'devin') return devinNativeQuestionText(id, name);
    if (action === 'send') {
      if (app === 'cursor' && name.requireActive && activeThread() !== id) throw new Error('会话已切换，消息未发送');
      const submissions = window.__remoteAgentNativeSubmissions ||= new Map();
      if (submissions.has(name.requestId)) return true;
      const record = { threadId: id, status: 'submitting', at: Date.now() };
      submissions.set(name.requestId, record);
      let submitted;
      if (app === 'codex') {
        const host = remoteContext?.host || 'local';
        const client = codexConversationManager(id, codexHistoryScopes(), host) || codexConnectedRpc(host);
        if (!client) throw new Error('Codex 原生会话连接尚未就绪');
        const conversation = await codexRpcCall(client, 'getConversation', id);
        if (!conversation) throw new Error('Codex 原生会话尚未就绪');
        const settings = conversation.latestThreadSettings || {};
        submitted = codexRpcCall(client, 'sendFollowUpMessage', id, { prompt: name.text, model: settings.model || conversation.latestModel,
          reasoningEffort: settings.effort ?? conversation.latestReasoningEffort, attachmentContext: name.composer });
      } else if (app === 'cursor') {
        if (remoteContext && !name.requireActive) Object.assign(record, { settings: cursorFusionSettings(id) });
        submitted = cursorSessionServices().composer.composerChatService.submitChatMaybeAbortCurrent(id, name.text,
          { ...(remoteContext ? { skipClearInput: true, skipFocusAfterSubmission: true, _internalPreserveDraft: true } : {}), ignoreQueuing: name.when === 'now' });
      } else {
        const session = devinSessionRecord(id);
        fusionDevinState(id);
        submitted = devinSend(session.providerId,
          { method: 'session/prompt', params: { sessionId: id, prompt: [{ type: 'text', text: name.text }],
            _meta: { 'cognition.ai/clientMessageId': name.requestId } } }, name.requestId);
      }
      Promise.resolve(submitted).then(() => { record.status = 'handler_finished'; }, error => {
        Object.assign(record, { status: 'error', message: String(error.message || error),
          outcome: error.delivery?.stage === 'outcome-unknown' ? 'unknown' : error.jsonRpcCode != null ? 'rejected' : 'unknown' });
        (window.__remoteAgentSubmitErrors ||= []).push({ requestId: name.requestId, message: String(error.message || error) });
        doc.defaultView.dispatchEvent(new doc.defaultView.Event('remote-agent-submit-error'));
      });
      return record.settings ? { settings: record.settings } : true;
    }
    if (action === 'stop') {
      if (app === 'codex') {
        if (remoteContext && (remoteContext.app !== app || remoteContext.threadId !== id)) throw new Error('请求不属于这个任务 Binding');
        const host = remoteContext?.app === 'codex' ? remoteContext.host || 'local' : codexChatRows(true).find(row => row.id === id)?.host || 'local';
        const scopes = codexHistoryScopes(), manager = codexConversationManager(id, scopes, host);
        const client = manager || codexConnectedRpc(host, scopes);
        if (!client) throw new Error('Codex 原生停止接口尚未就绪');
        const context = await nativeSessionContext(app, id);
        const turn = await codexFusionTurn(name?.messageId || '');
        if (!turn?.id || !turn.current || turn.ended || !turn.turnId || turn.threadId !== id
            || (context.host || 'local') !== host
            || name && !name.cancelKey && (remoteContext?.fusionController !== true
              || name.threadId !== id || name.turnId !== turn.turnId || name.messageId !== turn.id)
            || name?.cancelKey && (context.roots.length !== 1 || context.host
              || !samePath(context.cwd, name.project) || context.roots.some(root => root.host || !samePath(root.root, name.project))
              || typeof name.nativeInputKey !== 'string' || !name.nativeInputKey
              || codexInputKey(turn.nativeInput) !== name.nativeInputKey || turn.turnId !== name.turnId
              || JSON.stringify({ threadId: turn.threadId, id: turn.id, turnId: turn.turnId,
                nativeInputKey: codexInputKey(turn.nativeInput), nativeIds: turn.nativeIds, lastUserId: turn.lastUserId }) !== name.cancelKey)
            || (codexConversationManager(id, codexHistoryScopes(), host) || codexConnectedRpc(host)) !== client)
          throw new Error('Codex 原生已不在该任务的精确轮次');
        // Native RPC checks the expected turn again; never interrupt whichever turn is latest later.
        if (!manager) {
          if (typeof client.interruptConversationWithOutcome !== 'function') throw new Error('Codex 原生停止回执接口尚未就绪');
          const ack = await codexRpcCall(client, 'interruptConversationWithOutcome', id, turn.turnId);
          return ack?.status === 'accepted' && ack.interruptedTurnId === turn.turnId;
        }
        return await manager.interruptConversation(id, 'user-stop', turn.turnId) === turn.turnId;
      }
      if (app === 'devin' && name?.cancelKey) {
        if (!remoteContext || remoteContext.app !== app || remoteContext.threadId !== id) throw new Error('请求不属于这个任务 Binding');
        const context = await nativeSessionContext(app, id);
        const handle = devinSessionHandle(id), state = devinCancelState(id, handle);
        if (context.host || context.provider !== name.providerId || context.roots.length !== 1
            || !samePath(context.cwd, name.project) || context.roots.some(root => root.host || !samePath(root.root, name.project))
            || !state?.active || state.thread !== id || state.providerId !== name.providerId
            || state.turnId !== name.turnId || state.human?.i !== name.messageId
            || !devinNativePromptMatches(state.human.t, name.prompt)
            || JSON.stringify(state) !== name.cancelKey
            || typeof handle?.connection?.send !== 'function')
          throw new Error('Devin 原生已不在该任务的精确在途轮次');
        // No await or second handle lookup between this final native snapshot
        // and dispatch to this exact session connection. Never answer a tool permission.
        const ack = await handle.connection.send({ method: 'session/cancel', params: { sessionId: devinNativeId(id) } });
        return ack === true || !!ack && !ack.error && (ack.accepted === true || ack.ok === true || ack.cancelled === true);
      }
      if (app === 'devin' && /^acp\d+$/.test(name?.messageId || '')) throw new Error('Devin ACP 取消缺少任务轮次证明');
      if (name?.turnId) {
        const turn = await codexFusionTurn(name.messageId, '', [], name.generationId || '');
        if (turn.ended || !turn.current || turn.turnId !== name.turnId
            || name.generationId && turn.generationId !== name.generationId) throw new Error('原生已不在该任务轮次');
        if (app === 'cursor') {
          const live = cursorSessionServices().data.getComposerDataIfLoaded(id);
          if (turn.threadId !== id || turn.id !== name.messageId || !turn.generationId || live?.chatGenerationUUID !== turn.generationId
              || live.fullConversationHeadersOnly?.findLast(header => header.type === 1)?.bubbleId !== name.messageId)
            throw new Error('Cursor 原生已不在该任务轮次');
        }
      }
      if (app === 'cursor') await cursorSessionServices().composer.cancelChat(id);
      else {
        const session = devinSessionRecord(id);
        const ack = await devinSend(session.providerId,
          { method: 'session/cancel', params: { sessionId: id } });
        if (name?.turnId) return ack === true || !!ack && !ack.error && (ack.accepted === true || ack.ok === true || ack.cancelled === true);
      }
      return true;
    }
    if (action === 'model' && app === 'codex') return codexSetNativeModel(id, { model: name });
    if (action === 'effort' && app === 'codex') return codexSetNativeModel(id, { effort: name });
    if (action === 'mode' && app === 'cursor') {
      const modes = cursorSessionServices(true), option = modes.getAllModes().find(mode => mode.name === name);
      if (!option) throw new Error('模式不属于该 Cursor 会话的原生候选');
      const handle = await cursorSessionServices().data.getComposerHandleById(id);
      modes.setComposerUnifiedMode(handle, option.id);
      return modes.getComposerUnifiedMode(id) === option.id;
    }
    if (action === 'mode' && app === 'devin') {
      const session = devinSessionRecord(id), config = session.configOptions.find(option => option.category === 'mode');
      const option = config?.options.flatMap(group => group.options || [group]).find(option => option.name === name);
      if (!option) throw new Error('模式不属于该 Devin 会话的原生候选');
      await devinSend(session.providerId,
        { method: 'session/set_config_option', params: { sessionId: id, configId: config.id, value: option.value } });
      return true;
    }
    if (action === 'model' && app === 'devin') {
      if (remoteContext) {
        const session = devinSessionRecord(id), config = session.configOptions.find(option => option.category === 'model');
        if (!config?.options.flatMap(group => group.options || [group]).some(option => option.value === name)) throw new Error('模型不属于该原生会话的可用候选');
        await devinSend(session.providerId,
          { method: 'session/set_config_option', params: { sessionId: id, configId: config.id, value: name } });

        return true;
      }
      const picker = devinPickerProps(true), model = devinConfigs(picker).find(row => row.modelUid === name);
      if (!model) throw new Error('模型不属于当前 Devin 原生候选');
      await picker.onModelSelect(model); return true;
    }
    if (action === 'effort') return pickEffort(name);
    if (action === 'terminalPermission' && app === 'cursor') {
      const { terminal } = cursorPendingTool(id);
      if (!terminal || terminal.bubbleId !== name?.item || !name.actionId) return false;
      const button = name.label === 'Run' ? terminal.accept : name.label === 'Skip' ? terminal.reject : null;
      const suffix = name.label === 'Run' ? ':accept' : ':reject';
      if (!button || name.actionId !== button.dataset.remoteAction && name.actionId !== terminal.toolCallId + suffix) return false;
      button.click();
      return true;
    }
    if (['question', 'permission'].includes(action) && app === 'cursor' && remoteContext) {
      if (remoteContext.app !== app || remoteContext.threadId !== id) throw new Error('请求不属于这个任务 Binding');
      // MCP supplies an exact task turn. Recheck inside the native action after
      // asynchronous context/turn reads, before touching selections or submitting.
      if (name && typeof name === 'object' && name.messageId) {
        const context = await nativeSessionContext(app, id);
        const turn = await codexFusionTurn(name.messageId, '', [], name.generationId);
        const { data: live, capability, decisions, terminal } = cursorPendingTool(id);
        const headers = live?.fullConversationHeadersOnly || [];
        const bubbleId = terminal?.toolCallId === name.id ? terminal.bubbleId : capability?.getPendingDecisionBubbleIdForToolCall(name.id);
        const at = headers.findIndex(header => header.bubbleId === bubbleId);
        if (context.host || context.roots.length !== 1 || !samePath(context.cwd, name.project)
            || context.roots.some(root => root.host || !samePath(root.root, name.project))
            // ended alone does not finish Cursor's pending ask_question. The
            // unique live question and its exact raw ID/key are verified below.
            || action === 'permission' && turn.ended
            || !turn.current || turn.threadId !== id || turn.id !== name.messageId
            || turn.turnId !== name.turnId || !name.generationId || turn.generationId !== name.generationId
            || live?.chatGenerationUUID !== name.generationId
            || !live.conversationActionManager || live.conversationActionManager.signal.aborted
            || headers.findLast(header => header.type === 1)?.bubbleId !== name.messageId
            || bubbleId !== name.bubbleId || (at >= 0
              ? headers.slice(0, at).findLast(header => header.type === 1)?.bubbleId !== name.messageId
              : capability?.getBubbleDataByToolCallId(name.id)?.name !== 'ask_question'))
          throw new Error('Cursor 原生请求不属于该任务的当前轮次');
        if (decisions.length !== 1 || decisions[0].toolCallId !== name.id) throw new Error('Cursor 原生请求不唯一');
      }
    }
    if (action === 'question' && app === 'cursor' && remoteContext) {
      if (remoteContext.app !== app || remoteContext.threadId !== id) throw new Error('请求不属于这个任务 Binding');
      const { capability, decisions } = cursorPendingTool(), questions = cursorNativeQuestions();
      if (!questions || name.id !== questions.id || name.questionKey !== JSON.stringify(questions)) throw new Error('这个问题已更新，请重新查看');
      const bubbleId = capability.getPendingDecisionBubbleIdForToolCall(questions.id);
      const pending = decisions.find(row => row.toolCallId === questions.id);
      if (!pending || !bubbleId) throw new Error('这个问题已不再等待回答');
      const bubble = capability.getBubbleDataByToolCallId(questions.id);
      const confirmed = async (ack, requestId, expected = null) => {
        if (!name.messageId) return true;
        if (ack === false || !!ack && (ack.error || ack.accepted === false
            || ack.ok === false || ack.submitted === false)) return false;
        // These native methods synchronously consume the exact pending decision.
        // There is no await between the final native check and invoking them.
        // Absence alone is not an ACK: retain the exact bubble's recorded choice.
        for (let i = 0; i < 9; i++) {
          const now = cursorPendingTool(id), headers = now?.data?.fullConversationHeadersOnly || [];
          if (headers.findLast(header => header.type === 1)?.bubbleId !== name.messageId) return false;
          if (!now.decisions?.some(decision => decision.toolCallId === requestId)) {
            const consumed = now.capability.getBubbleData(name.bubbleId);
            if (!consumed || consumed.userDecision !== (name.part === 'skip' ? 'rejected' : 'accepted')
                || JSON.stringify(consumed.params?.questions) !== JSON.stringify(bubble.params.questions)) return false;
            if (expected && Object.keys(expected.currentSelections).some(key =>
              JSON.stringify(consumed.additionalData?.currentSelections?.[key]) !== JSON.stringify(expected.currentSelections[key])
              || expected.currentSelections[key].includes('__freeform_other__')
                && consumed.additionalData?.freeformTexts?.[key] !== expected.freeformTexts[key])) return false;
            return true;
          }
          if (i < 8) await new Promise(resolve => setTimeout(resolve, 35));
        }
        return false;
      };
      if (name.part === 'skip') {
        const ack = await capability.rejectToolCall(questions.id, nativeValue({ skipReason: 'user' }));
        return await confirmed(ack, questions.id);
      }
      if (name.part === 'answer' && name.messageId) {
        if (!Array.isArray(name.answers) || name.answers.length !== questions.list.length
            || bubble.params.questions.length !== questions.list.length) throw new Error('回答数量与原生问题不匹配');
        const currentSelections = Object.create(null), freeformTexts = Object.create(null);
        for (const [index, item] of questions.list.entries()) {
          const question = bubble.params.questions[index], values = name.answers[index];
          if (!question?.id || item.id !== question.id || !Array.isArray(values) || !values.length || values.length > 20
              || !item.multi && values.length !== 1 || new Set(values).size !== values.length)
            throw new Error('原生问题的回答格式不匹配');
          const selected = [];
          for (const value of values) {
            if (typeof value !== 'string' || !value.trim() || value.length > 4000 || value.includes('\0')) throw new Error('回答无效');
            const matches = question.options.filter(option => option.label === value);
            if (matches.length > 1) throw new Error('原生问题有重名选项');
            if (matches.length === 1) {
              if (typeof matches[0].id !== 'string' || !matches[0].id || matches[0].id === '__freeform_other__')
                throw new Error('原生问题选项标识无效');
              selected.push(matches[0].id);
            } else {
              if (!item.options.some(option => option.free) || selected.includes('__freeform_other__')) throw new Error('原生问题不接受这个回答');
              selected.push('__freeform_other__'); freeformTexts[question.id] = value;
            }
          }
          currentSelections[question.id] = selected;
        }
        capability.setBubbleDataOrThrow(bubbleId, nativeValue({ additionalData: { currentSelections, freeformTexts } }));
        const selected = cursorNativeQuestions();
        if (selected?.id !== questions.id || !selected.canSubmit || selected.list.some((item, index) =>
          item.id !== questions.list[index].id || item.options.some(option => option.sel !==
            currentSelections[item.id].includes(option.free ? '__freeform_other__' : option.id))
          || item.options.some(option => option.free && option.sel && option.value !== freeformTexts[item.id])))
          throw new Error('原生问题回答未确认');
        capability.setBubbleDataOrThrow(bubbleId, nativeValue({ status: 'completed', additionalData: { status: 'submitted' } }));
        return await confirmed(await capability.acceptToolCall(questions.id), questions.id, { currentSelections, freeformTexts });
      }
      if (name.part === 'submit') {
        if (!questions.canSubmit) throw new Error('请完成所有问题后再提交');
        capability.setBubbleDataOrThrow(bubbleId, nativeValue({ status: 'completed', additionalData: { status: 'submitted' } }));
        const ack = await capability.acceptToolCall(questions.id);
        return await confirmed(ack, questions.id);
      }
      if (name.part !== 'option') throw new Error('这个问题没有对应的操作');
      const question = bubble.params.questions[name.qi];
      if (!question || !questions.list[name.qi]?.options[name.oi]) throw new Error('问题选项已更新');
      const currentSelections = { ...bubble.additionalData?.currentSelections }, freeformTexts = { ...bubble.additionalData?.freeformTexts };
      const option = question.options[name.oi]?.id || '__freeform_other__', selected = currentSelections[question.id] || [];
      currentSelections[question.id] = question.allowMultiple
        ? option === '__freeform_other__' ? [...new Set([...selected, option])]
          : selected.includes(option) ? selected.filter(value => value !== option) : [...selected, option] : [option];
      if (option === '__freeform_other__') freeformTexts[question.id] = String(name.text || '');
      capability.setBubbleDataOrThrow(bubbleId, nativeValue({ additionalData: { currentSelections, freeformTexts } }));
      return true;
    }
    if (action === 'permission' && app === 'cursor' && remoteContext) {
      if (name && typeof name === 'object' && name.messageId) {
        if (!['once', 'reject'].includes(name.decision)) throw new Error('仅支持单次原生权限决定');
        const { capability, decisions, terminal } = cursorPendingTool(id);
        const bubble = terminal?.toolCallId === name.id ? terminal.tool : capability.getBubbleDataByToolCallId(name.id);
        if (decisions.length !== 1 || decisions[0].toolCallId !== name.id || !bubble || bubble.name === 'ask_question'
            || JSON.stringify({ name: bubble.name, params: bubble.params || {} }) !== name.permissionKey)
          throw new Error('这个原生权限请求已更新');
        if (terminal) {
          if (terminal.bubbleId !== name.bubbleId) throw new Error('这个原生权限请求已更新');
          (name.decision === 'once' ? terminal.accept : terminal.reject).click();
          for (let i = 0; i < 9; i++) {
            const { data } = cursorPendingTool(id);
            if (data?.fullConversationHeadersOnly.findLast(header => header.type === 1)?.bubbleId !== name.messageId) return false;
            const consumed = data.conversationMap[name.bubbleId]?.toolFormerData;
            if (consumed?.toolCallId === name.id && consumed.result?.rejected === (name.decision === 'reject')
                && JSON.stringify({ name: consumed.name, params: consumed.params || {} }) === name.permissionKey) return true;
            if (i < 8) await new Promise(resolve => setTimeout(resolve, 50));
          }
          return false;
        }
        const ack = await (name.decision === 'once' ? capability.acceptToolCall(name.id) : capability.rejectToolCall(name.id));
        if (ack === false || ack?.error || ack?.ok === false || ack?.accepted === false) return false;
        for (let i = 0; i < 9; i++) {
          const now = cursorPendingTool(id), headers = now?.data?.fullConversationHeadersOnly || [];
          if (headers.findLast(header => header.type === 1)?.bubbleId !== name.messageId) return false;
          if (!now.decisions.some(decision => decision.toolCallId === name.id)) {
            const consumed = now.capability.getBubbleData(name.bubbleId);
            return !!consumed && consumed.userDecision === (name.decision === 'once' ? 'accepted' : 'rejected')
              && JSON.stringify({ name: consumed.name, params: consumed.params || {} }) === name.permissionKey;
          }
          if (i < 8) await new Promise(resolve => setTimeout(resolve, 35));
        }
        return false;
      }
      const { capability, decisions, terminal } = cursorPendingTool();
      const accept = name.endsWith(':accept'), reject = name.endsWith(':reject');
      if (!accept && !reject) throw new Error('未知的原生权限决定');
      const toolCallId = name.slice(0, -7);
      if (terminal?.toolCallId === toolCallId) {
        (accept ? terminal.accept : terminal.reject).click();
        return true;
      }
      const pending = decisions.find(decision => decision.toolCallId === toolCallId);
      if (!pending || capability.getBubbleDataByToolCallId(toolCallId)?.name === 'ask_question') throw new Error('这个原生权限请求已更新');
      if (accept) await capability.acceptToolCall(toolCallId);
      else await capability.rejectToolCall(toolCallId);
      return true;
    }
    if (app === 'cursor') {
      const services = cursorSessionServices();
      if (action === 'open') { await services.composer.openComposer(id); return true; }
      if (action === 'model') {
        const props = cursorPickerProps(true), model = props.models.find(model => [model.clientDisplayName, model.inputboxShortModelName, model.name].includes(name));
        if (!model && name !== 'Auto') return false;
        props.onSelectionChange([{ modelId: model?.name || 'default', parameters: [] }]);
        return true;
      }
      const handle = await services.data.getComposerHandleById(id);
      const session = handle?.data;
      if (!session) throw new Error('没有找到这个会话');
      if (action === 'rename') {
        if (session.createdFromBackgroundAgent?.bcId) await services.background.renameBackgroundComposer(session.createdFromBackgroundAgent.bcId, name);
        else {
          await services.composer.renameComposer(id, name, { throwOnFailure: true });
          const [stored] = await services.data._storageService.collectionQuery('composerHeaders', { where: { composerId: id } });
          const workspaceIdentifier = stored ? JSON.parse(stored).workspaceIdentifier : session.workspaceIdentifier;
          await services.data.persistComposerWorkspacePlacement(id, { name, workspaceIdentifier });
          await services.data.syncComposerHeadersFromCanonicalStorage();
        }
      } else if (action === 'delete') {
        await services.composer.deleteComposer(id);
      } else throw new Error('此会话不支持这个操作');
      const after = (await nativeSessionCatalog('cursor')).rows.find(c => c.id === id);
      const empty = services.data.getComposerDataIfLoaded(id)?.fullConversationHeadersOnly?.length === 0;
      const outcome = action === 'rename' ? 'rename' : after?.archived ? 'archive' : !after ? 'delete' : empty ? 'clear' : null;
      return { confirmed: action === 'rename' ? after?.title === name : !!outcome, action: outcome,
        ...(remoteContext && action === 'rename' ? { title: after?.title } : {}) };
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
