  const fusionCodexBind = async (id, name) => {
      const manager = codexConversationManager(id, codexHistoryScopes(), remoteContext?.host || 'local');
      const managers = window.__remoteAgentNativeTools ||= new WeakMap();
      let bridge = managers.get(manager);
      if (!bridge) {
        const original = manager.threadExecution.executeDynamicToolCall;
        bridge = { original, threads: new Map() };
        bridge.dispatch = request => {
          const tools = bridge.threads.get(request.params.threadId);
          if (!tools?.has(request.params.tool)) return original.call(manager.threadExecution, request);
          manager.updateConversationState(request.params.threadId, conversation => { conversation.requests.push(request); });
        };
        manager.threadExecution.executeDynamicToolCall = bridge.dispatch;
        managers.set(manager, bridge);
      }
      bridge.threads.set(id, new Set(name.names));
      const client = manager.requestClient;
      const clients = window.__remoteAgentFusionRequests ||= new WeakMap();
      let requests = clients.get(client);
      if (!requests) {
        requests = { original: client.sendRequest, threads: new Map() };
        client.sendRequest = function(method, params, ...options) {
          const authorization = (method === 'turn/start' || method === 'turn/steer') && requests.threads.get(params.threadId);
          return requests.original.call(this, method, authorization ? { ...params,
            additionalContext: { ...params.additionalContext, ra_fusion_user_authorization: authorization },
          } : params, ...options);
        };
        clients.set(client, requests);
      }
      requests.threads.set(id, name.authorization);
      requests.profiles ||= new Map();
      if (requests.profiles.get(id) !== name.instructions && !manager.isConversationStreaming(id)) {
        const conversation = manager.getConversation(id), settings = conversation.latestThreadSettings, permissions = conversation.currentPermissions;
        await requests.original.call(client, 'thread/resume', nativeValue({
          threadId: id, excludeTurns: true, developerInstructions: name.instructions,
          model: settings.model, serviceTier: settings.serviceTier, cwd: settings.cwd,
          approvalPolicy: permissions.approvalPolicy, approvalsReviewer: permissions.approvalsReviewer,
          permissions: permissions.activePermissionProfile?.id, runtimeWorkspaceRoots: permissions.runtimeWorkspaceRoots,
          ...(settings.effort ? { config: { model_reasoning_effort: settings.effort } } : {}),
        }));
        requests.profiles.set(id, name.instructions);
      }
      return { profileReady: requests.profiles.get(id) === name.instructions };
  };
  const fusionCodexUnbind = (id) => {
      const manager = codexConversationManager(id, codexHistoryScopes(), remoteContext?.host || 'local');
      const bridge = window.__remoteAgentNativeTools.get(manager);
      bridge.threads.delete(id);
      if (!bridge.threads.size) {
        manager.threadExecution.executeDynamicToolCall = bridge.original;
        window.__remoteAgentNativeTools.delete(manager);
      }
      const client = manager.requestClient, requests = window.__remoteAgentFusionRequests.get(client);
      requests.threads.delete(id);
      if (!requests.threads.size) {
        client.sendRequest = requests.original;
        window.__remoteAgentFusionRequests.delete(client);
      }
      return true;
  };
  const fusionCodexReply = (id, name) => {
      const manager = codexConversationManager(id, codexHistoryScopes(), remoteContext?.host || 'local');
      const request = manager.getDynamicToolRequest(id, name.requestId);
      if (!window.__remoteAgentNativeTools.get(manager)?.threads.get(id)?.has(request?.tool)) throw new Error('管理工具请求已不属于这个主会话');
      return manager.replyWithDynamicToolResponse(id, name.requestId, nativeValue(name.result));
  };
  // Native tools are scoped to explicitly bound Fusion controller conversations.
  const fusionNativeControllers = () => window.__remoteAgentFusionControllers ||= new Map();
  const fusionNativeKey = (app, id) => JSON.stringify([app, id]);
  const fusionNativeChanged = (app, id) => doc.defaultView.dispatchEvent(new doc.defaultView.CustomEvent('remote-agent-fusion-tool', { detail: { app, threadId: id } }));
  const fusionCursorBridges = () => {
    const inst = cursorSessionInstantiation(), ids = new Map();
    for (let scope = inst; scope; scope = scope._parent)
      for (const [id] of scope._services._entries) if (!ids.has(String(id))) ids.set(String(id), id);
    const service = inst.invokeFunction(accessor => accessor.get(ids.get('extensionService')));
    return service._extensionHostManagers._extensionHostManagers.flatMap(manager =>
      Object.values(manager.extensionHost?._rpcProtocol?._locals || {}).filter(value =>
        value && Object.getOwnPropertyDescriptor(Object.getPrototypeOf(value) || {}, '$getMcpSnapshots')));
  };
  const fusionCursorSnapshot = spec => ({
    serverIdentifier: 'ra-fusion', serverName: 'Remote Agent Fusion', status: 'connected',
    instructions: spec.instructions, resources: [], prompts: [],
    tools: nativeValue(spec.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))),
  });
  const fusionCursorRequestContext = (value, spec) => {
    const context = value.clone(), type = (owner, name) => owner.constructor.fields.list().find(field => field.localName === name).T;
    const tools = spec.tools.map(({ name, description, inputSchema }) => ({ name: `ra-fusion-${name}`,
      providerIdentifier: 'Remote Agent Fusion', toolName: name, description, inputSchema }));
    context.tools = [...context.tools.filter(tool => !tool.name.startsWith('ra-fusion-')),
      ...tools.map(tool => type(context, 'tools').fromJson(tool))];
    context.mcpInstructions = [...context.mcpInstructions.filter(row => row.serverIdentifier !== 'ra-fusion'),
      type(context, 'mcpInstructions').fromJson({ serverName: 'Remote Agent Fusion', serverIdentifier: 'ra-fusion', instructions: spec.instructions })];
    if (context.mcpMetaToolOptions) context.mcpMetaToolOptions.mcpDescriptors = [
      ...context.mcpMetaToolOptions.mcpDescriptors.filter(row => row.serverIdentifier !== 'ra-fusion'),
      type(context.mcpMetaToolOptions, 'mcpDescriptors').fromJson({ serverName: 'Remote Agent Fusion', serverIdentifier: 'ra-fusion',
        serverUseInstructions: spec.instructions, tools: spec.tools.map(({ name, description, inputSchema }) => ({ toolName: name, description, inputSchema })) }),
    ];
    return context;
  };
  const fusionCursorCall = (id, tool, args, callId, token) => {
    const spec = fusionNativeControllers().get(fusionNativeKey('cursor', id));
    if (!spec.tools.some(row => row.name === tool)) throw new Error('没有登记这个主控工具');
    const data = cursorSessionServices().data.getComposerDataIfLoaded(id);
    const user = data.fullConversationHeadersOnly.findLast(row => row.type === 1);
    if (!user || !data.latestChatGenerationUUID || token?.isCancellationRequested) throw new Error('这个原生工具轮次已结束');
    return new Promise((resolve, reject) => {
      const request = { id: callId, params: { threadId: id, turnId: user.bubbleId,
        generationId: data.latestChatGenerationUUID, callId, tool, arguments: args } };
      const pending = { request, resolve, reject, stop: null };
      pending.stop = token?.onCancellationRequested(() => {
        spec.pending.delete(String(callId)); pending.stop?.dispose();
        reject(new Error('原生工具请求已取消')); fusionNativeChanged('cursor', id);
      });
      spec.pending.set(String(callId), pending); fusionNativeChanged('cursor', id);
    });
  };
  const fusionCursorBind = (id, spec) => {
    const key = fusionNativeKey('cursor', id), controllers = fusionNativeControllers();
    const prior = controllers.get(key);
    const state = { ...spec, pending: prior?.pending || new Map(), bridges: prior?.bridges || [] };
    controllers.set(key, state);
    let contextBridge = window.__remoteAgentFusionCursorContext;
    if (!contextBridge) {
      const service = cursorSessionServices().composer.composerChatService._composerAgentService;
      contextBridge = { service, threads: new Set(), original: service.buildComposerRequestContext,
        descriptor: Object.getOwnPropertyDescriptor(service, 'buildComposerRequestContext') };
      service.buildComposerRequestContext = async function(context, composerId, ...options) {
        const value = await contextBridge.original.call(this, context, composerId, ...options);
        const spec = controllers.get(fusionNativeKey('cursor', composerId));
        return spec ? fusionCursorRequestContext(value, spec) : value;
      };
      window.__remoteAgentFusionCursorContext = contextBridge;
    }
    contextBridge.threads.add(id);
    const installed = window.__remoteAgentFusionCursorRpc ||= new WeakMap();
    for (const target of fusionCursorBridges()) {
      let bridge = installed.get(target);
      if (!bridge) {
        bridge = { threads: new Set(), originals: {}, descriptors: {} };
        const get = context => controllers.get(fusionNativeKey('cursor', context?.composerId));
        for (const name of ['$getMcpSnapshots', '$getMcpSnapshot', '$getMcpSnapshotTools', '$callMcpLeaseTool']) {
          bridge.originals[name] = target[name]; bridge.descriptors[name] = Object.getOwnPropertyDescriptor(target, name);
        }
        target.$getMcpSnapshots = async function(context) {
          const value = await bridge.originals.$getMcpSnapshots.call(this, context), spec = get(context);
          return spec ? [...value, fusionCursorSnapshot(spec)] : value;
        };
        target.$getMcpSnapshot = function(server, context) {
          const spec = get(context);
          return server === 'ra-fusion' && spec ? fusionCursorSnapshot(spec) : bridge.originals.$getMcpSnapshot.call(this, server, context);
        };
        target.$getMcpSnapshotTools = async function(context) {
          const value = await bridge.originals.$getMcpSnapshotTools.call(this, context), spec = get(context);
          return spec ? [...value, { ...fusionCursorSnapshot(spec), source: 'internal' }] : value;
        };
        target.$callMcpLeaseTool = function(...args) {
          return args[0] === 'ra-fusion' && controllers.has(fusionNativeKey('cursor', args[6]))
            ? fusionCursorCall(args[6], args[1], args[2], args[3], args[7])
            : bridge.originals.$callMcpLeaseTool.apply(this, args);
        };
        installed.set(target, bridge);
      }
      bridge.threads.add(id);
      if (!state.bridges.includes(target)) state.bridges.push(target);
    }
    if (!state.bridges.length) throw new Error('当前 Cursor 原生工具桥尚未就绪');
    return { profileReady: true };
  };
  const fusionCursorUnbind = id => {
    const controllers = fusionNativeControllers(), key = fusionNativeKey('cursor', id), spec = controllers.get(key);
    if (!spec) return true;
    for (const pending of spec.pending.values()) { pending.stop?.dispose(); pending.reject(new Error('Fusion 主控工具连接已释放')); }
    controllers.delete(key);
    const contextBridge = window.__remoteAgentFusionCursorContext;
    contextBridge.threads.delete(id);
    if (!contextBridge.threads.size) {
      if (contextBridge.descriptor) Object.defineProperty(contextBridge.service, 'buildComposerRequestContext', contextBridge.descriptor);
      else delete contextBridge.service.buildComposerRequestContext;
      delete window.__remoteAgentFusionCursorContext;
    }
    for (const target of spec.bridges) {
      const bridge = window.__remoteAgentFusionCursorRpc.get(target);
      bridge.threads.delete(id);
      if (!bridge.threads.size) {
        for (const [name, descriptor] of Object.entries(bridge.descriptors)) {
          if (descriptor) Object.defineProperty(target, name, descriptor); else delete target[name];
        }
        window.__remoteAgentFusionCursorRpc.delete(target);
      }
    }
    return true;
  };
  const fusionDevinBody = message => (message?.content || []).filter(block => block.content?.type === 'text').map(block => block.content.text).join('\n');
  const fusionDevinCapture = (id, spec) => {
    const data = devinSessionData(id);
    if (data) spec.data = data;
    for (const [generationId, request] of Object.entries(devinAgentRequests(id)))
      if (request.method === 'session/prompt' && request.params.sessionId === id)
        spec.turns.set(generationId, { ...spec.turns.get(generationId), ...request, generationId });
    const messages = devinMessages(id);
    for (const turn of spec.turns.values()) {
      const clientId = turn.params._meta?.['cognition.ai/clientMessageId'];
      const user = clientId && messages.find(row => row.kind === 'user_message'
        && row.content.some(block => block._meta?.['cognition.ai/clientMessageId'] === clientId && !block._meta?.['cognition.ai/isOptimistic']));
      if (!user) continue;
      turn.messageId = user.id; turn.user = fusionDevinBody(user);
      const start = messages.indexOf(user), rest = messages.slice(start + 1), next = rest.findIndex(row => row.kind === 'user_message');
      const reply = (next < 0 ? rest : rest.slice(0, next)).findLast(row => row.kind === 'agent_message');
      if (reply) { turn.replyText = fusionDevinBody(reply); turn.hasReply = true; }
    }
  };
  const fusionDevinStates = () => window.__remoteAgentDevinTurns ||= new Map();
  const fusionDevinState = id => {
    const states = fusionDevinStates();
    let state = states.get(id);
    if (!state) {
      state = { turns: fusionNativeControllers().get(fusionNativeKey('devin', id))?.turns || new Map(), data: null, stop: null, listeners: new Set() };
      states.set(id, state);
      fusionDevinCapture(id, state);
    }
    return state;
  };
  const fusionDevinWatch = (id, changed) => {
    const state = fusionDevinState(id), listener = () => changed?.();
    state.listeners.add(listener);
    if (!state.stop) {
      const watch = devinWatch(() => {
        fusionDevinCapture(id, state);
        for (const notify of state.listeners) notify();
      }, id);
      state.stop = () => { state.stop = null; watch.stop(); };
    }
    fusionDevinCapture(id, state);
    return () => {
      state.listeners.delete(listener);
      if (!state.listeners.size) state.stop?.();
    };
  };
  const fusionDevinTurn = (id, messageId = '', generationId = '', attemptId = '') => {
    const spec = fusionDevinState(id);
    fusionDevinCapture(id, spec);
    const clientId = row => row.params._meta?.['cognition.ai/clientMessageId'], values = [...spec.turns.values()];
    let turn = generationId ? spec.turns.get(generationId)
      : messageId ? values.find(row => row.messageId === messageId)
      : attemptId ? values.find(row => clientId(row) === attemptId)
      : values.findLast(row => row.messageId);
    if (attemptId && (!turn || clientId(turn) !== attemptId)) turn = undefined;
    const ended = ['completed', 'failed'].includes(turn?.status);
    return { id: turn?.messageId || '', ids: [...spec.turns.values()].map(row => row.messageId).filter(Boolean), turnId: turn?.messageId || '',
      generationId: turn?.generationId || '', threadId: id, current: turn === [...spec.turns.values()].at(-1), accepted: !!turn?.messageId,
      user: turn?.user || '', text: turn?.replyText || '', ended, completed: turn?.status === 'completed' && !!turn?.hasReply,
      error: turn?.status === 'failed' ? turn.errorMessage || 'Devin 原生执行失败' : '', items: [] };
  };
  const fusionDevinBind = async (id, spec) => {
    const native = await import('@exa/chat-client'), session = devinSessionRecord(id);
    const connector = native.tryGetAcpSingleton('connectorService').getConnectors().find(row => row.id === session.providerId);
    if (!connector?.capabilities?.mcpCapabilities?.http) throw new Error('这个 Devin 连接器未提供会话级 HTTP MCP 工具');
    const controllers = fusionNativeControllers(), key = fusionNativeKey('devin', id), previous = controllers.get(key);
    const state = { ...spec, waiting: previous?.waiting || new Set(), turns: fusionDevinState(id).turns, applied: previous?.applied };
    controllers.set(key, state);
    state.stop = fusionDevinWatch(id);
    previous?.stop?.();
    const profile = JSON.stringify(spec.mcp);
    if (state.applied === profile || session.mcpServers?.some(server => JSON.stringify(server) === profile)) {
      state.applied = profile;
      return { profileReady: true };
    }
    if (['active', 'pending', 'canceling'].includes(session.status)) return { profileReady: false };
    await devinSend(session.providerId,
      { method: 'session/load', params: { sessionId: id, cwd: session.cwd, additionalDirectories: session.additionalDirectories || [],
        mcpServers: [...(session.mcpServers || []).filter(server => server.name !== spec.mcp.name), spec.mcp] } });
    state.applied = profile;
    return { profileReady: true };
  };
  const fusionDevinCall = (id, input) => {
    const spec = fusionNativeControllers().get(fusionNativeKey('devin', id));
    if (!spec) throw new Error('这个 Devin 会话没有绑定主控工具');
    const canonical = value => JSON.stringify(value && typeof value === 'object'
      ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item)))
        : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
    return new Promise((resolve, reject) => {
      const waiting = { stop: null, reject };
      const finish = (value, error) => { waiting.stop?.(); spec.waiting.delete(waiting); error ? reject(error) : resolve(value); };
      const read = () => {
        const session = devinSessionRecord(id);
        const messages = devinMessages(id);
        const user = messages.findLast(row => row.kind === 'user_message' && !row.content?.some(block => block._meta?.['cognition.ai/isOptimistic']));
        const start = messages.indexOf(user), tail = start >= 0 ? messages.slice(start + 1) : [];
        const matches = tail.filter(row => row.kind === 'tool_call' && row.content._meta?.['cognition.ai/toolName'] === 'mcp__ra-fusion__' + input.tool
          && ['pending', 'in_progress'].includes(row.content.status) && canonical(row.content.rawInput) === canonical(input.arguments));
        if (matches.length > 1) { finish(null, new Error('多个原生工具调用参数相同，无法确认本次归属')); return; }
        if (matches.length === 1 && user) {
          const tool = matches[0].content;
          fusionDevinCapture(id, spec);
          const generation = [...spec.turns.values()].find(row => row.messageId === user.id && row.status === 'started');
          if (!generation) { finish(null, new Error('没有找到这个工具的实际原生执行轮次')); return; }
          finish({ id: tool.toolCallId, params: { threadId: id, turnId: user.id, generationId: generation.generationId,
            callId: tool.toolCallId, tool: input.tool, arguments: input.arguments } });
        } else if (!['active', 'pending', 'canceling'].includes(session.status)) finish(null, new Error('原生轮次已结束，未找到对应管理工具请求'));
      };
      waiting.stop = devinWatch(read, id).stop; spec.waiting.add(waiting); read();
    });
  };
  const fusionNativeTools = {
    bind(app, id, spec) {
      if (app === 'codex') return fusionCodexBind(id, spec);
      if (app === 'cursor') return fusionCursorBind(id, spec);
      if (app === 'devin') return fusionDevinBind(id, spec);
      throw new Error('这个软件没有原生主控工具接口');
    },
    unbind(app, id) {
      if (app === 'codex') return fusionCodexUnbind(id);
      if (app === 'cursor') return fusionCursorUnbind(id);
      const controllers = fusionNativeControllers(), key = fusionNativeKey(app, id), spec = controllers.get(key);
      spec?.stop?.();
      for (const waiting of spec?.waiting || []) { waiting.stop(); waiting.reject(new Error('Fusion 主控工具连接已释放')); }
      controllers.delete(key); return true;
    },
    requests(app, id) {
      if (app === 'codex') {
        const manager = codexConversationManager(id, codexHistoryScopes(), remoteContext?.host || 'local');
        return (manager.getConversation(id)?.requests || []).filter(request => request.method === 'item/tool/call');
      }
      return [...(fusionNativeControllers().get(fusionNativeKey(app, id))?.pending || new Map()).values()].map(row => row.request);
    },
    reply(app, id, value) {
      if (app === 'codex') return fusionCodexReply(id, value);
      const pending = fusionNativeControllers().get(fusionNativeKey(app, id))?.pending.get(String(value.requestId));
      if (!pending) throw new Error('管理工具请求已结束，未回复其他原生请求');
      fusionNativeControllers().get(fusionNativeKey(app, id)).pending.delete(String(value.requestId));
      pending.stop?.dispose(); pending.resolve({ content: value.result.contentItems.map(item => ({ type: 'text', text: item.text })), isError: !value.result.success });
      fusionNativeChanged(app, id); return true;
    },
  };
