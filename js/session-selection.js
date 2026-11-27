/* Navigation and the selected conversation projected into the current UI. */
function rememberConversation() {
  const here = currentComputer();
  if (!here || currentApp === 'fusion') return;
  const selection = { id: here.win, windowId: here.windowId, threadId: here.threadId };
  const last = here.lastConversation;
  if (last?.id === selection.id && last.windowId === selection.windowId && last.threadId === selection.threadId) return;
  rememberComputer({ ...here, lastConversation: selection,
    previousConversation: last && (last.id !== selection.id || last.windowId !== selection.windowId) ? last : here.previousConversation });
}
function forgetClosedWindow(id) {
  const here = currentComputer();
  if (!here || !id) return;
  const app = String(id).split(':')[0], selections = { ...here.selections };
  const current = here?.win === id, selected = selections[app]?.id === id;
  if (!current && !selected) return;
  if (selected) delete selections[app];
  delete selections[id];
  const next = { ...here, selections };
  if (current) { next.win = ''; next.windowId = ''; next.threadId = ''; }
  if (current && next.lastConversation?.id === id) next.lastConversation = null;
  rememberComputer(next);
  if (current) store.set('window', null);
}
const selectedConversation = {
  live: '', serial: 0, navigation: null, ready: false, metadata: '', metadataWindow: '',
};

function setViewSelection(key) {
  viewSel = key;
}
function resetSelectionProjection() {
  Object.assign(selectedConversation, { live: '', navigation: null, ready: false, metadata: '', metadataWindow: '' });
}
function restoreSelectionProjection(navigationId, navigation) {
  selectedConversation.serial = navigationId;
  selectedConversation.navigation = navigation;
}
function failSelectionProjection() {
  selectedConversation.navigation = null;
  selectedConversation.ready = false;
}
const messageScope = () => [currentComputer()?.id || '', currentApp, currentComputer()?.windowId || ''].join('|');

function navigationState(message) {
  const kind = message.initial ? 'initial' : message.t === 'attach'
    ? (String(message.id || '').split(':')[0] === currentApp ? 'window' : 'agent')
    : message.newSession || /^(new:|project-new:)/.test(message.id || '') ? 'new'
    : message.t === 'openProject' ? 'project' : /^(win:|window:)/.test(message.id || '') ? 'window' : 'session';
  const messageText = { initial: '正在加载对话…', agent: '正在切换 Agent…', window: '正在切换窗口…', project: '正在打开项目…', session: '正在切换会话…', new: '正在新建对话…' }[kind];
  return { id: message.navigationId, targetId: message.t === 'attach' ? message.id : currentWindow, windowId: message.t === 'attach' ? message.windowId || message.id : currentWindow, confirmed: '', kind, message: messageText };
}
function beginNavigation(message, target) {
  if (!message.initial) conn.initialSelection = false;
  failFileRead('目标已切换，文件读取已中断，请重新打开');
  message.navigationId = ++selectedConversation.serial;
  const link = linkForComputerKey(currentComputer()?.key);
  if (link) { link.navigationId = message.navigationId; link.binding = null; link.preload = null; }
  selectedConversation.navigation = navigationState(message);
  Object.assign(selectedConversation.navigation, { target, generation: connGen });
  ovNavigationChanged(selectedConversation.navigation, 'opening', '正在等待会话内容…');
  status(selectedConversation.navigation.message);
  conn.attachFailed = false;
  conn.failedTargets?.delete(selectedConversation.navigation.targetId);
  $('retryChat').hidden = true;
  selectedConversation.ready = false;
  setWindowReady(false);
  invalidateChatRender();
  $('items').inert = true;
  $('items').classList.add('stale');
  $('actionBar').replaceChildren();
  renderQuestions(null);
}
function finishNavigation() {
  const navigation = selectedConversation.navigation;
  const kind = selectedConversation.navigation?.kind;
  selectedConversation.navigation = null;
  if (kind) status({ initial: '已连接', agent: '已切换 Agent', window: '已切换窗口', project: '已打开项目', session: '已切换会话', new: '已新建会话' }[kind]);
  ovEnterReady();
  return navigation;
}
function cancelNavigation(target) {
  if (selectedConversation.navigation?.generation !== connGen || !sameWinTarget(selectedConversation.navigation?.target, target)) return;
  selectedConversation.navigation = null;
  selectedConversation.serial++;
  const link = linkForComputerKey(currentComputer()?.key);
  if (link) { link.navigationId = selectedConversation.serial; link.binding = null; link.preload = null; }
  invalidateChatRender();
}
function selectionPreview() {
  $('items').inert = true;
  const preview = chatBySel.get(chatCacheKey(viewSel));
  renderChat(preview ? { ...preview, readonly: true, busy: false, global: [], questions: null, queued: [], queuedCount: 0, subagents: [] } : null, !!preview, !preview);
}
function confirmNavigation() {
  const previewed = selectedConversation.navigation?.preview === viewSel;
  if (selectedConversation.navigation && !selectedConversation.navigation.positioning) {
    beginChatSelection();
    selectedConversation.navigation.positioning = true;
  }
  if (selectedConversation.navigation) selectedConversation.navigation.confirmed = viewSel;
  if (mode === 'chat' && selectedConversation.live !== viewSel && !previewed) {
    selectionPreview();
    if (selectedConversation.navigation) selectedConversation.navigation.preview = viewSel;
  }
  if (mode !== 'chat') { $('items').inert = false; setWindowReady(true); ovNavigationChanged(finishNavigation(), 'ready'); }
}
function receiveChat(m) {
  if (!m.sel || !viewSel || m.sel === viewSel) {
    if (selectedConversation.navigation && (m.navigationId !== selectedConversation.navigation.id || selectedConversation.navigation.confirmed !== viewSel)) return;
    if (m.cached && selectedConversation.live === (m.sel || viewSel)) return;
    const fresh = m.chat && !m.cached && selectedConversation.ready;
    if (fresh) {
      const becameReady = !windowReady;
      if (selectedConversation.navigation?.preview === viewSel && chatStale) for (const item of m.chat.items) if (item.b?.length) cache.delete(item.i);
      selectedConversation.live = m.sel || viewSel;
      const navigation = finishNavigation();
      $('retryChat').hidden = true;
      $('items').inert = false;
      setWindowReady(true);
      ovNavigationChanged(navigation, 'ready');
      if (becameReady) queueDraftSync();
    }
    if (m.chat && !m.cached && !m.chat.readonly) capabilityBlock = '';
    const preview = chatBySel.get(chatCacheKey(m.sel || viewSel));
    // Codex unmounts the transcript while its generated-image editor is open.
    const obscured = currentApp === 'codex' && !!m.chat?.imagePreview;
    const retain = obscured && m.chat.items.length === 0 && preview?.items.length > 0 && preview.thread === m.chat.thread;
    const chat = retain ? { ...preview, ...m.chat, items: preview.items } : m.chat;
    if (chat) cacheChat(m.sel || viewSel, chat);
    queueChatRender(chat, !!m.cached || obscured, m.sel);
    if (fresh) {
      const selection = viewSel, navigation = selectedConversation.serial;
      requestAnimationFrame(() => { if (windowReady && viewSel === selection && selectedConversation.serial === navigation) refreshSelectionMetadata(); });
    }
  }
}
function receiveProjectReady(m) {
  if (m.sel && m.sel !== viewSel) return;
  selectedConversation.ready = true;
  confirmNavigation();
  capabilityBlock = '';
  finishPending(['正在打开项目…', '正在新建对话…']);
  closeSheet(); currentProject = m.name;
  if (m.chat) {
    selectedConversation.live = viewSel;
    const navigation = finishNavigation();
    $('items').inert = false;
    setWindowReady(true);
    ovNavigationChanged(navigation, 'ready');
    cacheChat(viewSel, m.chat);
    renderChat(m.chat);
    refreshSelectionMetadata();
  }
  $('titleProject').textContent = m.name;
  $('sessionNotice').hidden = !m.newSession;
  $('sessionNotice').textContent = I18N.tr('会话创建成功，尚未发送消息。') + ' ' + m.name;
  status(m.newSession ? '已在所选项目新建会话' : m.sessionSwitch ? '已切换会话' : '已打开项目');
}
function refreshSelectionMetadata(initial = false) {
  const key = `${connGen}|${viewSel}|${selectedConversation.serial}`;
  if (selectedConversation.metadata === key) return;
  selectedConversation.metadata = key;
  requestAgentCatalog();
  send({ t: 'usage', automatic: true });
  const window = `${connGen}|${currentApp}|${currentComputer()?.windowId || ''}`;
  if (selectedConversation.metadataWindow !== window) {
    selectedConversation.metadataWindow = window;
    if (!initial) send({ t: 'windows' });
  }
}
const codexAccounts = new Map();
function applyCodexAccount(value) {
  if (!value) return;
  const key = quotaKey(), previous = codexAccounts.get(key);
  if (previous !== value.account) {
    codexAccounts.set(key, value.account);
    quotaCache.delete(key);
    if (previous !== undefined) {
      for (const name of [...menuCache.keys()]) if (name.startsWith(menuCachePrefix())) menuCache.delete(name);
      menuRequest++;
      if (menuPending) showMenuError(menuPending.kind, 'Codex 账号已更新，请重新读取菜单');
    }
    renderQuota({ missing: true, quota: [], limits: [] });
  }
  appPlans = { ...appPlans, codex: value.plan || '' };
  updateTitle();
}
function applySelection(m, clearChat = true) {
  const fusionChanged = 'fusionController' in m;
  if (fusionChanged) activeFusionController = m.fusionController;
  if (m.app) {
    currentApp = m.app;
    currentAppName = currentApp === 'fusion' ? 'Fusion' : CONN_AGENTS.find(agent => agent.app === currentApp)?.name || I18N.tr('当前应用');
    currentWindow = m.id;
    capabilityOwner = m.app; agentCapabilities = m.capabilities || null;
    updateAppText();
  }
  const changed = (m.sel || '') !== viewSel;
  if (changed && sheetKind === 'menu' && menuPending) showMenuError(menuPending.kind, '会话已切换，请重新读取菜单');
  if (changed) { if (typeof cancelVoice === 'function') cancelVoice(); menuRequest++; saveDraft(); }
  if (changed && m.materializedFrom === viewSel) materializeComposerDraft(currentComputer()?.id || '', viewSel, m.sel);
  if (changed) {
    if (sheetKind === 'codex-goal') closeSheet();
    failFileRead('目标已切换，文件读取已中断，请重新打开');
    invalidateChatRender();
    selectedConversation.ready = false;
    setWindowReady(false);
    $('items').inert = true;
    capabilityBlock = '';
    setViewSelection(m.sel || '');
    selectedConversation.live = '';
    beginChatSelection(); thoughtObserver.disconnect(); cache.clear(); $('sessionNotice').hidden = true;
    if (currentApp === 'codex') { menuCache.delete(menuCacheKey('model')); menuCache.delete(menuCacheKey('effort')); }
  }
  const here = currentComputer();
  const id = m.id || here?.win;
  const selection = { windowId: m.windowId ?? here?.windowId ?? '', threadId: m.threadId ?? here?.threadId ?? '' };
  if (here) rememberComputer({
    ...here,
    win: id,
    ...selection,
    selections: { ...here.selections, [id]: selection, [m.app || currentApp]: { id, ...selection } },
  });
  if (currentApp === 'codex' && m.codexAccount) applyCodexAccount(m.codexAccount);
  if (changed) { mirroredDraft = ''; restoreDraft(); renderAttachments([]); if (!m.home) send({ t: 'attachments' }); }
  const cachedAgents = agentLists.get(agentListKey());
  if (cachedAgents && m.threadId) setAgentList(agentListKey(), cachedAgents.map(a => ({ ...a, current: agentThreadKey(a) === agentThreadKey({ id: m.threadId }) })));
  if (m.project != null) currentProject = m.project;
  if (fusionChanged) paintFusionRun(null);
  updateTitle();
  if (clearChat && changed) renderChat(null, false, true);
}

function receiveAttached(m, resumed) {
  if (m.closed) {
    const [app, windowId, threadId] = viewSel.split('|');
    if (m.app === 'codex' && app === m.app && m.windowId === windowId && threadId
        && mode === 'chat' && windowReady && !selectedConversation.navigation) {
      const computer = currentComputer()?.id;
      const remote = ovRecs().some(row => row.comp === computer && row.app === app && row.threadId === threadId && row.host);
      if (!remote && send({ t: 'attach', id: m.id, windowId, threadId })) return;
    }
    forgetClosedWindow(m.id);
    selectedConversation.ready = m.ready === true;
    connReadFailed(m.message || '这个窗口已经关闭，请重试或切换 Agent');
    send({ t: 'windows' });
    return;
  }
  if (m.plans) appPlans = { ...appPlans, ...m.plans };
  if (m.ready !== false) {
    rememberAgentOpen(m);
    if (!m.keepQuota) requestCompatibility(m.app, true, m.windowId || m.id);
  }
  if (m.keepQuota) {
    applySelection(m, false);
    selectedConversation.ready = m.ready !== false;
    if (selectedConversation.ready) confirmNavigation();
    else { setWindowReady(false); renderChat(null, false, true); }
    if (m.projectReady) receiveProjectReady(m.projectReady);
    if (m.chat) receiveChat(m);
    return;
  }
  finishPending(['正在切换窗口…', '正在切换 Agent…']);
  store.set('window', m.id);
  applySelection(m, false);
  rememberPhoneChat(m);
  if (resumed) selectedConversation.live = viewSel;
  selectedConversation.ready = m.ready !== false;
  setWindowReady(selectedConversation.ready && mode !== 'chat');
  scheduleLatency();
  $('dot').className = 'ok';
  status(mode === 'chat' ? selectedConversation.navigation?.message || '正在加载对话…' : '已连接');
  $('titleText').textContent = m.app === 'fusion' ? 'Fusion' : m.app === 'devin' ? 'Devin agent' : m.app === 'codex' ? 'Codex' : m.app === 'opencode' ? 'OpenCode' : winLabel(m.title).name;
  currentProject = m.app === 'fusion' ? '' : (m.project ?? winLabel(m.title).name);
  updateAppText(); updateTitle();
  if (selectedConversation.ready) confirmNavigation();
  else renderChat(null, false, true);
  renderContext(null);
  $('quotaMeters').innerHTML = '';
  $('quotaMeters').title = '';
  renderQuota({ missing: true, quota: [], limits: [] });
  if (selectedConversation.ready) send({ t: 'appTheme', dark: document.documentElement.dataset.theme !== 'light' });
  if (m.initial) selectedConversation.metadataWindow = `${connGen}|${currentApp}|${m.windowId || ''}`;
  if (mode !== 'chat' && selectedConversation.ready) refreshSelectionMetadata(m.initial === true);
  if (m.projectReady) receiveProjectReady(m.projectReady);
  if (m.chat) receiveChat(m);
}

function receiveAttachFailed(m) {
  const navigation = selectedConversation.navigation;
  if (m.home) {
    conn.initialSelection = false;
    conn.lastSelection = null;
    selectedConversation.navigation = null;
    applySelection(m, false);
    selectedConversation.ready = false;
    setWindowReady(false);
    currentProject = '';
    selectedConversation.live = '';
    renderChat(null, false);
    $('items').inert = false;
    $('items').classList.remove('stale');
    $('empty').firstChild.textContent = I18N.tr('请从项目/会话选择要打开的内容');
    renderContext(null);
    $('quotaMeters').innerHTML = '';
    updateTitle();
    conn.attachFailed = !m.connected;
    ovNavigationChanged(navigation, 'error', m.message || '打开失败，请重试');
    ovRender();
    status(m.message, false);
    finishWinBinding(new Error(m.message || '打开失败，请重试'));
    return;
  }
  selectedConversation.ready = m.ready === true;
  connReadFailed(m.message || '当前会话读取失败，请重试或切换 Agent');
  ovNavigationChanged(navigation, 'error', m.message || '当前会话读取失败，请重试');
  finishWinBinding(new Error(m.message || '当前会话读取失败，请重试'));
}

function receiveThreadSelection(m) {
  applySelection(m);
  if (m.ready === true) {
    selectedConversation.ready = true;
    confirmNavigation();
  }
}
