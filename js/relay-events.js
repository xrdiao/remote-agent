/* Background link updates precede delivery into the foreground projection. */
function receiveRelayEvent(link, event, handshake) {
  const { computer, socket, expectedId } = handshake;
  const m = JSON.parse(event.data);
  link.lastRx = Date.now();
  stopComputerProbe(link);
  const wasReady = computerBindingReady(link);
  if (m.t === 'operation') return receiveDesktopOperation(link, m);
  if (m.t === 'auth' && !authenticateComputerSocket(link, m, handshake)) return;
  if (receiveFusion(m, link)) return;
  if (mode === 'terminal' && currentComputer()?.key === computer.key && ['terminals', 'termSnapshot'].includes(m.t)) link.finishFirstScreen();
  const currentNavigation = m.navigationId == null || m.navigationId === link.navigationId;
  if (currentNavigation && m.t === 'attached') {
    if (!link.receive && m.materializedFrom) materializeComposerDraft(expectedId, m.materializedFrom, m.sel);
    if (m.closed || m.ready === false && !link.preload) link.binding = null;
    else {
      link.binding = { ...(link.binding?.sel === m.sel ? link.binding : {}), ...m };
      if (m.chat) link.binding.cached = !!m.cached;
      if (m.app === 'opencode' && winBinding?.target.computer === expectedId
          && winBinding.target.win === 'opencode' && !winBinding.target.windowId) winBinding.target.windowId = m.windowId;
    }
  }
  if (currentNavigation && m.t === 'chat' && link.binding?.sel === m.sel) link.binding = { ...link.binding, chat: m.chat, cached: !!m.cached };
  if (currentNavigation && m.t === 'attachFailed') link.binding = null;
  if (currentNavigation && m.t === 'thread' && link.binding?.sel !== m.sel) {
    link.binding = null; link.preload = null; link.finishFirstScreen();
  }
  if (currentNavigation && link.preload) {
    if (m.t === 'attached' && !m.closed) {
      const selection = { win: m.id, windowId: m.windowId || '', threadId: m.threadId || '' };
      link.preload.target = { ...link.preload.target, ...selection };
      updateComputerRecord({ key: computer.key }, selection);
    }
    if (['attachFailed', 'projectTrust'].includes(m.t) || m.t === 'attached' && m.closed) link.preload.outcome = m;
    else if (computerBindingReady(link)) link.preload.outcome = null;
  }
  if (currentNavigation && (computerBindingReady(link) || ['attachFailed', 'projectTrust'].includes(m.t) || m.t === 'attached' && m.closed)) link.finishFirstScreen();
  if (['windows', 'connAgents', 'agentCatalog', 'plans', 'sessionLibrary'].includes(m.t)) link.metadata.set(m.t, m);
  if (sheetKind === 'computer-actions' && ['windows', 'agentCatalog'].includes(m.t)) {
    const tab = $('sheet').querySelector('[data-computer-app="opencode"][aria-pressed="true"]');
    if (tab?.dataset.computerId === expectedId) showComputerActions(expectedId, 'opencode');
  }
  if (link.receive) link.receive(m);
  else if (m.t === 'sent') confirmSent(m, true, link.expectedId);
  else if (m.t === 'sendFailed') receiveSendFailure(m, link.expectedId, false);
  else if (m.t === 'termSent' || m.t === 'termError' && m.action === 'termSend') receiveTerminalReceipt(m, link.expectedId);
  if (m.t === 'attached' || !wasReady && computerBindingReady(link) || link.metadata.has(m.t)) saveComputerResume(link);
  if (m.t === 'attached' || m.t === 'chat') deliverDeferredOperations(link);
  if (link.authed && ['auth', 'agentCatalog', 'agents', 'sessionLibrary'].includes(m.t)) {
    const entry = ovList.find(row => row.id === expectedId);
    if (entry) ovFetch(entry);
  }
  if (['auth', 'attached', 'attachFailed'].includes(m.t) || wasReady !== computerBindingReady(link)) ovRender();
  if (link.rejected) socket.close();
  if (currentNavigation && !wasReady && computerBindingReady(link)) recordComputerConnection(link, 'ready');
}

function receiveForegroundEvent(link, m, resumed = false) {
  if (['attached', 'thread', 'chat', 'projectReady', 'attachFailed', 'status'].includes(m.t)
      && m.navigationId != null && m.navigationId !== selectedConversation.serial) return;
  if (m.t === 'pong') return;
  if (m.t === 'auth') return receiveForegroundAuthorization(link, m);
  if (receiveTerminal(m)) return;
  else if (m.t === 'sent') {
    confirmSent(m, true, link.expectedId);
  }
  else if (m.t === 'queueDone') receiveQueueDone(m);
  else if (m.t === 'clickDone') {
    if (m.sel !== viewSel) return;
    const button = [...$('items').querySelectorAll('button[data-item]')].find(b => b.dataset.item === String(m.item) && b.dataset.actionId === (m.actionId || ''));
    button?.closest('.btns')?.querySelectorAll('button').forEach(b => { b.disabled = false; });
  }
  else if (m.t === 'codexRetryState') {
    if (m.sel === viewSel) status(m.error ? '自动重试结果未确认：' + m.error : `正在自动重试…（${m.count}/${m.limit}）`, !m.error);
  }
  else if (m.t === 'sendFailed') receiveSendFailure(m, link.expectedId);
  else if (m.t === 'questionDone') finishQuestion(m);
  else if (m.t === 'opencodeQuestionDone') finishOpenCodeQuestion(m);
  else if (m.t === 'latency') receiveLatency(m);
  else if (m.t === 'visual') renderVisualState(m);
  else if (m.t === 'visualWindows') { receiveVisualWindows(m); if (mode === 'screen') connContentReady(); }
  else if (m.t === 'imageDone') { finishImageUpload(m); }
  else if (m.t === 'imageEdit') { if (m.sel === viewSel) openImageEditor(m).catch(e => status('图片编辑失败：' + e.message, false)); }
  else if (m.t === 'attachments') { if (m.sel === viewSel) renderAttachments(m.list); }
  else if (m.t === 'chat') receiveChat(m);
  else if (m.t === 'draft') receiveDraft(m);
  else if (m.t === 'draftAck') receiveDraft(m);
  else if (m.t === 'historyPage') receiveHistoryPage(m);
  else if (m.t === 'historyDone') finishHistory(m);
  else if (m.t === 'thread') receiveThreadSelection(m);
  else if (m.t === 'frame') onFrame(m);
  else if (m.t === 'panel') { panel = m.rect; updateTermEmpty(); layoutStage(); }
  else if (m.t === 'connAgents') connAgentResults(m.agents, m.complete !== false);
  else if (m.t === 'compatibility') receiveCompatibility(m);
  else if (m.t === 'agentCatalog') agentCatalogResults(m.agents);
  else if (m.t === 'launchResult') connLaunchResults(m.results);
  else if (m.t === 'windows') { windows = m.list; currentWindow = m.current; if (m.plans) { appPlans = { ...appPlans, ...m.plans }; updateTitle(); } if (sheetKind === 'windows') showWindows(); paintRail(); }
  else if (m.t === 'plans') { if (m.plans) { appPlans = { ...appPlans, ...m.plans }; updateTitle(); if (sheetKind === 'windows') showWindows(); paintRail(); } }
  else if (m.t === 'attached') receiveAttached(m, resumed);
  else if (m.t === 'attachFailed') receiveAttachFailed(m);
  else if (m.t === 'sessionLibrary') receiveSessionLibrary(m);
  else if (m.t === 'sessionChanged') receiveSessionChange(m);
  else if (m.t === 'sessionActions') receiveAgentActions(m);
  else if (m.t === 'sessionBatchProgress') receiveSessionBatch(m);
  else if (m.t === 'projectWindows') showProjectWindows(m);
  else if (m.t === 'agents') receiveAgents(m);
  else if (m.t === 'codexArchived') {
    const conv = String(m.id || '').split(':').slice(2).join(':');
    if (conv) scKeys().then(keys => Promise.all((keys || []).map(async k => {
      const key = String(k).startsWith('m:') ? String(k).slice(2) : String(k);
      if (key.endsWith('|' + conv)) await scClear(key);
    }))).catch(() => {});
  }
  else if (m.t === 'projects') { finishPending(['正在读取项目…', '正在读取文件夹…', '正在新建对话…']); showProjects(m); }
  else if (m.t === 'projectTrust') {
    if (m.sel && m.sel !== viewSel) return;
    capabilityBlock = '请先确认项目是否可信';
    finishPending(['正在打开项目…', '正在新建对话…']);
    showProjectTrust(m);
  }
  else if (m.t === 'projectReady') receiveProjectReady(m);
  else if (m.t === 'docs') showDocs(m);
  else if (m.t === 'settings') { if (m.codex && m.requestId !== codexSettingsRequest) return; finishPending(['正在读取设置…', '正在修改…', '正在保存指令…']); m.codex ? showCodexSettings(m) : showSettings(m.sections || [], m.nav || [], m.current || '', m.choices || []); }
  else if (m.t === 'codexAccount') {
    if (currentApp === 'codex' && m.sel === viewSel) applyCodexAccount(m);
  }
  else if (m.t === 'codexGoal') receiveCodexGoal(m);
  else if (m.t === 'usage') {
    if (currentApp === 'fusion' || !windowReady || !viewSel || m.sel !== viewSel) return;
    if (currentApp === 'codex' && m.account != null && m.account !== codexAccounts.get(quotaKey())) return;
    if (m.plan) { appPlans = { ...appPlans, [currentApp]: m.plan }; updateTitle(); }
    if (m.missing) status('没有额度数据');
    renderQuota(m);
    if (!m.cached) finishPending(['正在读取额度…']);
  }
  else if (m.t === 'fastState') {
    if (m.sel && m.sel !== viewSel) return;
    for (const [key, cached] of menuCache) {
      if (!key.startsWith(menuCachePrefix())) continue;
      cached.fast = m.fast;
      if (m.fusion) cached.fusion = m.fusion;
    }
    if (currentApp === 'codex' && m.fast?.items && sheetKind === 'menu' && menuSheetKind === 'fast') {
      showMenu('fast', m.fast.items);
      return;
    }
    if (m.fusion && lastChat?.fusion) lastChat.fusion = m.fusion;
    const cost = $('sheet').querySelector('[data-fusion-cost]');
    if (cost && m.fusion) cost.innerHTML = modelPricingHtml(m.fusion.pricing, true);
    $('sheet').querySelectorAll('[data-fast], [data-fusion="fast"]').forEach(button => {
      if (button.dataset.fast) button.dataset.fast = m.fast.on ? 'off' : 'on';
      button.querySelector('.switch')?.classList.toggle('on', m.fast.on);
    });
    finishPending(['设置中…', '正在修改…']);
  }
  else if (m.t === 'menuPicked') finishModelPick(m);
  else if (m.t === 'menu') {
    if (m.sel && viewSel && m.sel !== viewSel) return;
    if (m.requestId != null && (m.requestId !== menuRequest || m.requestId !== menuPending?.requestId
      || m.kind !== menuPending.kind || menuPending.sel !== viewSel)) return;
    if (m.error) return showMenuError(m.kind, m.error);
    if (m.requestId != null) menuPending = null;
    if (currentApp === 'codex' && m.modelItems && m.effortItems) {
      lruPut(menuCache, menuCacheKey('model'), { ...m, kind: 'model', items: m.modelItems }, 24);
      lruPut(menuCache, menuCacheKey('effort'), { ...m, kind: 'effort', items: m.effortItems }, 24);
    } else lruPut(menuCache, menuCacheKey(m.kind), m, 24);
    if (m.requestId == null && !(sheetKind === 'menu' && menuSheetKind === m.kind)) return;
    showMenu(m.kind, m.items, m.max, m.fusion, m.fast, m.model, false, m.pricing);
  }
  else if (m.t === 'params') showParams(m);
  else if (m.t === 'changes') showChanges(m);
  else if (m.t === 'file') { if (m.requestId === fileRequestId && readingFile?.source.isCurrent()) showFile(m); }
  else if (m.t === 'fileMarks') {
    if (m.requestId === fileRequestId && viewing && viewing.path === m.path && String(viewing.host || '') === String(m.host || '')) {
      viewing.marks = m.marks || null;
      viewing.markSource = m.markSource;
      viewing.commit = m.commit;
      viewing.subject = m.subject;
      if (m.newFile) viewing.newFile = true;
      if (m.diff) viewing.diff = m.diff;
      if (editing) return;
      const body = $('vBody'), y = body.scrollTop;
      renderFileCode(viewing);
      body.scrollTop = y;
    }
  }
  else if (m.t === 'thought') onThought(m);
  else if (m.t === 'revertConfirm') {
    (async () => {
      const ok = await ask(m.title ? `${m.title}${m.body ? '\n' + m.body : ''}` : '确认回退？', '确认回退');
      if (!ok) return send({ t: 'revertCancel' });
      const apply = m.apply === null || m.apply === undefined ? undefined : await ask('同时撤销这些文件改动吗？\n取消 = 只回退对话，保留文件', '撤销文件');
      send({ t: 'revertOk', ...(apply === undefined ? {} : { apply }) });
    })();
  }
  else if (m.t === 'trunc') scTrunc(m.from);
  else if (m.t === 'workdirs') showWorkdirs(m);
  else if (m.t === 'mentions') onMentions(m);
  else if (m.t === 'codexSkills') showCodexSkills(m.rows || []);
  else if (m.t === 'unqueued') {
    if (m.sel && m.sel !== viewSel) return;
    const scope = messageScope();
    const original = submittedMessages.findLast(row => row.scope === scope && row.queueId === m.id);
    const recovered = original?.text || m.text;
    text.value = text.value.trim() ? `${text.value.replace(/\s+$/, '')}\n${recovered}` : recovered;
    if (currentApp === 'devin') text.dispatchEvent(new Event('input', { bubbles: true }));
    else autosize();
    text.focus();
    status('已取出，放回输入框');
  }
  else if (m.t === 'saved') onSaved(m);
  else if (m.t === 'status') { if (!m.ok) pendingAgentOpen = ''; clearSwitchWatch(); status(m.msg, m.ok); }
}
