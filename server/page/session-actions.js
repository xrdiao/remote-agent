  const nativeValue = value => doc.defaultView.JSON.parse(JSON.stringify(value));
  const cursorSessionInstantiation = () => {
    const props = [...doc.querySelectorAll('[data-message-id], [data-glass-agent-id], .composer-container')]
      .flatMap(el => codexFiberProps(el, 40)).find(p => p.uiContextMenuServices);
    return props?.uiContextMenuServices?.instantiationService;
  };
  const cursorSessionServices = () => {
    if (window.__remoteAgentCursorServices) return window.__remoteAgentCursorServices;
    const inst = cursorSessionInstantiation();
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
      const host = remoteContext?.app === 'codex' ? remoteContext.host || 'local' : codexChatRows(true).find(row => row.id === id)?.host || 'local';
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
    return { app, threadId: id, provider: session.providerId, host: '', cwd: session.cwd || '', roots: session.cwd ? [{ root: session.cwd, host: '' }] : [] };
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
  const nativeSessionCleanup = async (app, id, perform = false) => {
    const inspect = async () => {
      if (app === 'codex') {
        const host = remoteContext?.host || 'local', manager = codexConversationManager(id, codexHistoryScopes(), host);
        let thread;
        try { ({ thread } = await manager.readThread(id, { includeTurns: false })); }
        catch (error) {
          if (/thread.*not found|no rollout found|thread.*does not exist/i.test(String(error))) return { exists: false };
          throw error;
        }
        return { exists: true, title: thread.name || '', archived: /[\\/]archived_sessions[\\/]/.test(thread.path || ''), running: thread.status?.type === 'active',
          context: { cwd: thread.cwd, host: host === 'local' ? '' : host } };
      }
      const catalog = await nativeSessionCatalog(app, [id]);
      if (!catalog.ready || catalog.unknown?.includes(id) || catalog.missing?.includes(id)) throw new Error('原生会话清理状态尚未确认');
      const row = catalog.rows.find(row => row.id === id);
      if (!row && !catalog.complete && !catalog.removed?.includes(id)) throw new Error('原生会话清理状态尚未确认');
      return { exists: !!row, title: row?.title || '', archived: !!row?.archived, running: !!row?.running,
        context: row ? row.workspace ? { cwd: row.workspace, host: row.host || '' } : await nativeSessionContext(app, id) : null };
    };
    const before = await inspect();
    if (!perform) return before;
    if (!remoteContext || remoteContext.app !== app || remoteContext.threadId !== id) throw new Error('清理请求不属于这个原生 Binding');
    if (!before.exists || before.archived) return { confirmed: true, action: before.archived ? 'archive' : 'delete', already: true };
    if (before.running) throw new Error('原生会话仍在运行，请先停止并核对');
    if (app === 'codex') {
      const manager = codexConversationManager(id, codexHistoryScopes(), remoteContext.host || 'local');
      await manager.archiveConversation(id, { useAppServerPins: false });
    } else if (app === 'cursor') {
      if (cursorSessionServices().data.allComposersData.allComposers.length <= 1) throw new Error('Cursor 当前只有一个原生会话，清空不能代替删除或归档');
      await nativeSessionAction(app, id, 'delete');
    } else {
      const native = await import('@exa/chat-client'), session = devinSessionRecord(id);
      const connector = native.tryGetAcpSingleton('connectorService').getConnectorById(session.providerId);
      if (!connector?.capabilities?.sessionCapabilities?.delete) throw new Error('Devin 未提供该会话的后台删除能力');
      await window.__acpStore.dispatch(native.sendAgentRequestThunk(session.providerId,
        { method: 'session/delete', params: { sessionId: id } }, native.tryGetAcpSingleton('sendAgentRequest')));
    }
    const after = await inspect();
    if (after.exists && !after.archived) throw new Error('桌面端尚未确认删除或归档完成');
    return { confirmed: true, action: after.archived ? 'archive' : 'delete', already: false };
  };
  const nativeSessionInfo = (app, id, catalog = false, previous = null) => {
    if (catalog === 'cleanup' || catalog === 'name') return nativeSessionCleanup(app, id);
    if (catalog === 'settings') {
      if (app === 'cursor') {
        const services = cursorSessionServices(), handle = services.data.getHandleIfLoaded(id);
        const selected = services.composer.composerChatService._modelConfigService.getSelectedModelsForComposer(handle)[0];
        return { model: selected.modelId, effort: effortItems().find(row => row.checked)?.label || '', family: selected.modelId, usage: null };
      }
      if (app === 'codex') {
        const value = codexConversationManager(id, codexHistoryScopes(), remoteContext?.host || 'local').getConversation(id);
        const settings = value.latestThreadSettings || {};
        return { model: settings.model || value.latestModel, effort: settings.effort ?? value.latestReasoningEffort ?? '', family: settings.model || value.latestModel,
          usage: value.latestTokenUsageInfo || null, usageBasis: '原生会话用量资料；不等于单任务账单' };
      }
      const config = devinSessionRecord(id)?.configOptions.find(row => row.category === 'model');
      return { model: config?.currentValue || '', family: '', effort: '', usage: null,
        usageBasis: '原生 ACP 会话未提供可归因的任务账单；模型 ID 包含原生强度' };
    }
    if (catalog === 'creation') {
      const value = window.__remoteAgentNativeCreations?.get(previous);
      return value ? { status: value.status, context: value.context, nativeThreadId: value.nativeThreadId, error: value.error } : null;
    }
    if (catalog === 'tools') return fusionNativeTools.requests(app, id);
    if (catalog === 'fusionCall' && app === 'devin') return fusionDevinCall(id, previous);
    if (catalog === 'draft' && app === 'codex') return codexConversationDraft(id, previous === null ? undefined : previous);
    if (catalog === 'clearDraft' && app === 'codex') return codexConversationDraft(id, '', previous);
    if (catalog === 'composer' && app === 'codex') return (async () => {
      const value = await codexComposerScope(id, false);
      if (!value) return null;
      const { scope, composer } = value;
      const state = scope.get(composer.q), context = await nativeSessionContext(app, id);
      const ide = codexQueryClient()?.getQueryData(['ide-context', null]);
      const activePath = ide?.activeFile?.path || '';
      return { ...state, workspaceRoots: context.roots.map(row => row.root),
        ideContext: state.isAutoContextOn && context.roots.some(row => activePath.startsWith(row.root + '/')) ? ide : null };
    })();
    if (catalog === 'sendError') return window.__remoteAgentNativeSubmissions?.get(previous) || null;
    if (catalog === 'bind') return (async () => {
      const context = await nativeSessionContext(app, id);
      if (app === 'cursor') {
        const handles = window.__remoteAgentNativeHandles ||= new Map();
        const key = JSON.stringify([id, previous]);
        if (!handles.has(key)) handles.set(key, await cursorSessionServices().data.getComposerHandleById(id));
      } else if (app === 'codex') {
        const manager = codexConversationManager(id, codexHistoryScopes(), context.host || 'local');
        if (!manager.getConversation(id) || manager.needsResume(id)) {
          const state = await manager.resumeConversation(nativeValue({ conversationId: id, model: null, reasoningEffort: null,
            workspaceRoots: context.roots.map(row => row.root), collaborationMode: manager.getConversation(id)?.latestCollaborationMode || null }));
          if (state.status === 'not-ready') throw new Error('Codex 原生会话尚未就绪');
        }
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
  const nativeCodexCreation = async (id, spec, prepare) => {
    const manager = codexConversationManager(id, codexHistoryScopes(), remoteContext?.host || 'local');
    const parent = manager.getConversation(id);
    const { scope } = await codexComposerScope(codexVisibleThread() || '');
    const native = await codexNativeModule('create-window-thread-creation-inputs');
    native.n();
    const reader = native.t(scope, manager.hostId);
    const root = spec.root || parent?.cwd;
    if (!root) throw new Error('新建原生会话前需要明确项目目录');
    const options = { input: [], cwd: root, workspaceRoots: [root], initialTitle: spec.title,
      ...(root === parent?.cwd ? { permissionsConfig: parent.currentPermissions } : { useAppServerPermissionDefault: true }),
      collaborationMode: spec.model ? { mode: 'default', settings: { model: spec.model, reasoning_effort: spec.effort || null, developer_instructions: null } } : parent?.latestCollaborationMode,
      additionalDeveloperInstructions: spec.instructions };
    const read = async (params, history) => {
      const inputs = await reader.readCreationInputs(params, history);
      if (spec.tools?.length) {
        const original = inputs.readDynamicTools;
        inputs.hasDeveloperInstructions = true;
        inputs.readDynamicTools = async value => [...await original(value), ...nativeValue(spec.tools)];
      }
      return inputs;
    };
    if (prepare) {
      const request = await manager.prepareThreadStart(options, read);
      return { model: request.model, approvalPolicy: request.approvalPolicy, approvalsReviewer: request.approvalsReviewer,
        tools: request.dynamicTools?.map(tool => ({ name: tool.name, type: tool.type, namespace: tool.namespace || '',
          fields: Object.keys(tool), tools: tool.tools?.map(value => ({ name: value.name, type: value.type, fields: Object.keys(value) })) })),
        handlerWritable: Object.getOwnPropertyDescriptor(manager.threadExecution, 'executeDynamicToolCall')?.writable };
    }
    const created = await manager.startConversation(options, { readThreadCreationInputs: read });
    if (created.status !== 'created') throw new Error('原生新会话结果待核对，不能重新创建');
    const record = window.__remoteAgentNativeCreations?.get(spec.requestId);
    if (record) record.nativeThreadId = created.conversationId;
    return nativeSessionContext('codex', created.conversationId);
  };
  const nativeSessionAction = async (app, id, action, name) => {
    if (action === 'rename' && remoteContext && ['codex', 'devin'].includes(app)) {
      if (remoteContext.app !== app || remoteContext.threadId !== id) throw new Error('请求不属于这个任务 Binding');
      if (app === 'codex') {
        const manager = codexNativeManager(), confirmed = await manager.setThreadTitle(id, name, { requireAcknowledgement: true });
        return { action: 'rename', confirmed, title: manager.getConversation(id)?.title };
      }
      const native = await import('@exa/chat-client'), session = devinSessionRecord(id);
      if (!session) throw new Error('没有找到这个会话');
      await window.__acpStore.dispatch(native.renameSessionThunk(session.providerId, id, name));
      return { action: 'rename', confirmed: true, title: name };
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
    if (action === 'release' && app === 'cursor') {
      const handles = window.__remoteAgentNativeHandles;
      const key = JSON.stringify([id, name]);
      handles?.delete(key);
      return true;
    }
    if (action === 'createNative' && app === 'cursor') {
      const services = cursorSessionServices();
      const parent = services.data.getComposerDataIfLoaded(id);
      if (!parent) throw new Error('主会话尚未在这个 Cursor 窗口就绪');
      const created = await services.composer.createComposer(nativeValue({
        skipSelect: true, skipShowAndFocus: true,
        partialState: { composerId: name.threadId, name: name.title, unifiedMode: 'agent',
          modelConfig: name.role === 'main' && name.model ? { ...parent.modelConfig,
            selectedModels: [{ modelId: name.model,
              parameters: name.effort ? [{ id: 'reasoning_effort', value: name.effort }] : [] }] } : parent.modelConfig,
          ...(name.role === 'main' ? {} : { subagentInfo: { parentComposerId: id, subagentTypeName: 'side-chat' } }) },
      }));
      window.__remoteAgentNativeCreations.get(name.requestId).nativeThreadId = created.composerId;
      return nativeSessionContext(app, created.composerId);
    }
    if (action === 'createNative' && app === 'devin') {
      const native = await import('@exa/chat-client'), parent = devinSessionRecord(id);
      if (!parent) throw new Error('当前 Devin 窗口没有就绪的原生会话');
      const created = await window.__acpStore.dispatch(native.sendAgentRequestThunk(parent.providerId,
        { method: 'session/new', params: { cwd: name.root, mcpServers: name.mcp ? [name.mcp] : [],
          _meta: { 'cognition.ai/skipPreferenceSeeding': true } } }, native.tryGetAcpSingleton('sendAgentRequest')));
      window.__remoteAgentNativeCreations.get(name.requestId).nativeThreadId = created.sessionId;
      if (name.role === 'main' && name.model) await nativeSessionAction(app, created.sessionId, 'model', name.model);
      return nativeSessionContext(app, created.sessionId);
    }
    if (action === 'capacityTarget' && app === 'codex') {
      const scopes = codexHistoryScopes(), manager = codexNativeManager();
      if (agentRun(app, id, scopes, manager)?.id !== name || codexVisibleThread() !== id) return null;
      const capacity = codexCapacityItem();
      return capacity?.b?.length ? codexPoint(capacity._retry) : null;
    }
    if (action === 'send') {
      const submissions = window.__remoteAgentNativeSubmissions ||= new Map();
      if (submissions.has(name.requestId)) return true;
      const record = { threadId: id, status: 'submitting', at: Date.now() };
      submissions.set(name.requestId, record);
      let submitted;
      if (app === 'codex') {
        const manager = codexNativeManager(), conversation = manager.getConversation(id);
        const settings = conversation.latestThreadSettings || {};
        submitted = manager.sendFollowUpMessage(id, nativeValue({ prompt: name.text, model: settings.model || conversation.latestModel,
          reasoningEffort: settings.effort ?? conversation.latestReasoningEffort, attachmentContext: name.composer }));
      } else if (app === 'cursor') {
        submitted = cursorSessionServices().composer.composerChatService.submitChatMaybeAbortCurrent(id, name.text,
          { skipClearInput: true, skipFocusAfterSubmission: true, _internalPreserveDraft: true, ignoreQueuing: name.when === 'now' });
      } else {
        const native = await import('@exa/chat-client'), session = devinSessionRecord(id);
        submitted = window.__acpStore.dispatch(native.sendAgentRequestThunk(session.providerId,
          { method: 'session/prompt', params: { sessionId: id, prompt: [{ type: 'text', text: name.text }],
            _meta: { 'cognition.ai/clientMessageId': name.requestId } } }, native.tryGetAcpSingleton('sendAgentRequest')));
      }
      Promise.resolve(submitted).then(() => { record.status = 'handler_finished'; }, error => {
        Object.assign(record, { status: 'error', message: String(error.message || error),
          outcome: error.delivery?.stage === 'outcome-unknown' ? 'unknown' : error.jsonRpcCode != null ? 'rejected' : 'unknown' });
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
    if (action === 'model' && app === 'codex') {
      const model = codexPickerProps().modelOptions.find(row => row.model.id === name)?.model;
      if (!model) throw new Error('模型不属于当前 Codex 原生候选');
      return pickCodexModel(model.displayName || model.id);
    }
    if (action === 'model' && app === 'devin') {
      if (remoteContext) {
        const session = devinSessionRecord(id), config = session.configOptions.find(option => option.category === 'model');
        if (!config?.options.flatMap(group => group.options || [group]).some(option => option.value === name)) throw new Error('模型不属于该原生会话的可用候选');
        const native = await import('@exa/chat-client');
        await window.__acpStore.dispatch(native.sendAgentRequestThunk(session.providerId,
          { method: 'session/set_config_option', params: { sessionId: id, configId: config.id, value: name } }, native.tryGetAcpSingleton('sendAgentRequest')));
        window.__acpStore.dispatch(native.setClientSideConfigValue({ sessionId: id, configId: config.id, value: name }));
        return true;
      }
      const picker = devinPickerProps(true), model = devinConfigs(picker).find(row => row.modelUid === name);
      if (!model) throw new Error('模型不属于当前 Devin 原生候选');
      await picker.onModelSelect(model); return true;
    }
    if (action === 'effort') return pickEffort(name);
    if (action === 'permission' && app === 'cursor' && remoteContext) {
      const { capability, decisions } = cursorPendingTool();
      const accept = name.endsWith(':accept'), reject = name.endsWith(':reject');
      if (!accept && !reject) throw new Error('未知的原生权限决定');
      const toolCallId = name.slice(0, -7);
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
