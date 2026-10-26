/* ---------- notifications ---------- */
// Android app: its own background listener. iOS app: APNs through the native shell. Elsewhere: Web Push (iPhone only from the home-screen app).
const nativeNotify = () => Boolean(window.AgentRemoteApp?.setNotify);
const iosPush = () => Boolean(window.AgentRemoteApp?.pushRegister);
const webPush = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
let notifyOn = false;
let notifySubscribed = false;

const serviceWorkerRegistration = () => {
  if (window.agentRemoteServiceWorker) return window.agentRemoteServiceWorker;
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return (window.agentRemoteServiceWorker = Promise.resolve(null));
  return (window.agentRemoteServiceWorker = navigator.serviceWorker.register('sw.js').catch(error => {
    window.agentRemoteServiceWorkerError = error;
    return null;
  }));
};
serviceWorkerRegistration();
const swReady = async () => {
  let registration;
  try {
    const registrationAttempt = serviceWorkerRegistration().then(reg => reg ? navigator.serviceWorker.ready : null);
    registration = await Promise.race([
      navigator.serviceWorker.ready,
      registrationAttempt,
      sleep(5000).then(() => { throw new Error('Service Worker 注册超时'); }),
    ]);
  } catch (error) {
    const reason = window.agentRemoteServiceWorkerError || error;
    throw new Error(reason?.message || String(reason) || 'Service Worker 注册失败');
  }
  if (!registration) {
    const reason = window.agentRemoteServiceWorkerError;
    throw new Error(reason?.message || 'Service Worker 注册失败');
  }
  return registration;
};
const pushSub = async () => webPush() ? (await swReady()).pushManager.getSubscription() : null;
const nativeConfig = () => JSON.stringify({ app: appAddress(), key: store.get('key') || '', token: store.get('token') || '', id: currentComputer()?.id || '' });

// After every connect, read this device's saved setting without enabling a retained subscription.
async function syncNotify() {
  try {
    if (nativeNotify()) {
      notifyOn = window.AgentRemoteApp.notifyEnabled();
      if (notifyOn) window.AgentRemoteApp.setNotify(nativeConfig());
    } else if (iosPush()) {
      const response = await api('/api/push/state');
      if (!response.ok) throw new Error('读取通知状态失败');
      const state = await response.json();
      notifySubscribed = state.subscribed;
      notifyOn = state.enabled;
    } else {
      const [response, sub] = await Promise.all([api('/api/push/state'), pushSub()]);
      if (!response.ok) throw new Error('读取通知状态失败');
      const state = await response.json();
      notifySubscribed = state.subscribed && Boolean(sub);
      notifyOn = state.enabled && Boolean(sub);
    }
  } catch {}
  paintNotifySwitch();
}

// Reflect the confirmed notification state into an open main-menu sheet.
function paintNotifySwitch() {
  const row = $('notifySwitchRow');
  if (!row) return;
  row.setAttribute('aria-checked', String(notifyOn));
  row.querySelector('.switch')?.classList.toggle('on', notifyOn);
}

async function enableNotify() {
  if (nativeNotify()) {
    window.AgentRemoteApp.setNotify(nativeConfig());
    notifyOn = true;
    setTimeout(() => { if (window.AgentRemoteApp.listenStatus?.() !== 'connected') showBgSheet(); }, 4000);
    return status('通知已开启，正在连接电脑。请在手机的电池设置里允许本 App 后台运行，否则切到后台后会收不到通知');
  }
  if (iosPush()) {
    try {
      const reg = await window.AgentRemoteApp.pushRegister();
      const r = await post('/api/push/apns', reg);
      if (!r.ok) throw new Error((await r.json()).error || '注册失败');
      notifySubscribed = true;
      notifyOn = true;
      return status('通知已开启');
    } catch (e) {
      return status('开启通知失败：' + e.message, false);
    }
  }
  if (inApp) return status('请先在菜单里更新安卓 App，新版才支持通知', false);
  if (!webPush()) {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    return status(ios && !standalone ? 'iPhone 要先「分享 → 添加到主屏幕」，从桌面图标打开后才能开启通知' : '这个浏览器不支持通知', false);
  }
  // Must be the first await: iOS only shows the permission prompt directly inside a tap.
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') return status('没有通知权限，请在系统设置里允许本 App 发通知', false);
  try {
    let r;
    if (notifySubscribed) r = await post('/api/push/state', { enabled: true });
    else {
      const reg = await swReady();
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const { key } = await api('/api/push/key').then(r => r.json());
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(key) });
      }
      r = await post('/api/push/subscribe', { sub: sub.toJSON() });
    }
    if (!r.ok) throw new Error((await r.json()).error || '注册失败');
    notifySubscribed = true;
    notifyOn = true;
    status('通知已开启');
  } catch (e) {
    status('开启通知失败：' + e.message, false);
  }
}

async function disableNotify() {
  if (nativeNotify()) window.AgentRemoteApp.setNotify('');
  else {
    const response = await post('/api/push/state', { enabled: false });
    if (!response.ok) throw new Error('关闭通知失败，请重试');
  }
  notifyOn = false;
  status('通知已关闭');
}

function noticeTarget(raw) {
  if (!raw) return null;
  let win = String(raw), windowId = '', threadId = '';
  if (win.startsWith('{')) {
    try {
      const o = JSON.parse(win);
      win = o.win || '';
      windowId = o.windowId || '';
      threadId = o.threadId || '';
    } catch { return null; }
  }
  return win ? { win, windowId, threadId } : null;
}
function rememberNotice(raw) {
  const n = noticeTarget(raw);
  if (!n) return;
  store.set('window', n.win);
  const here = currentComputer();
  if (here) rememberComputer({ ...here, win: n.win, windowId: n.windowId, threadId: n.threadId });
}
function openWin(id) {
  rememberNotice(id);
  if (!authed) return;
  const here = currentComputer();
  send({ t: 'attach', id: here?.win || store.get('window') || '', windowId: here?.windowId || '', threadId: here?.threadId || '' });
}
window.openWin = openWin;
navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.openWin) openWin(e.data.openWin); });
document.addEventListener('visibilitychange', () => {
  if (authed) {
    send({ t: 'visible', v: document.visibilityState === 'visible' });
    if (document.visibilityState === 'visible') send({ t: 'usage', automatic: true });
  }
});

$('sheet').addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (sheetKind === 'agent-actions' && b.dataset.agentAction) {
    const id = b.dataset.agentActionId || '', name = b.dataset.agentActionTitle || '';
    if (b.dataset.agentAction === 'open') {
      pendingAgentOpen = id;
      closeSheet(); status('正在切换 Agent…');
      return send({ t: 'openAgent', id, title: name });
    }
    if (b.dataset.agentAction === 'favorite') {
      const on = !agentFavoriteState(id);
      closeSheet(); setAgentFavorite(id, on);
      return status(on ? '已设为常用' : '已取消常用');
    }
    if (b.dataset.agentAction === 'rename') {
      const next = window.prompt('新的会话名称', name);
      if (!next?.trim()) return;
      closeSheet(); status('正在重命名…');
      return send({ t: 'codexRename', id, name: next.trim().slice(0, 80) });
    }
    if (b.dataset.agentAction === 'archive') {
      if (!await ask(`删除或归档「${name}」？\n桌面端会根据当前入口执行删除或归档。`, '继续')) return;
      closeSheet(); status('正在删除／归档…');
      return send({ t: 'codexArchive', id });
    }
  }
  if ('modelBack' in b.dataset) return requestMenu('model', '读取模型列表…');
  if ('effortOpen' in b.dataset) return requestMenu('effort', '读取思考强度…');
  if ('modelDone' in b.dataset) { closeSheet(); return; }
  if (b.dataset.fast) { status('设置中…'); return send({ t: 'pickMenu', kind: 'fast', label: b.dataset.fast, name: b.dataset.fastMenu }); }
  if ('editorChat' in b.dataset) { closeSheet(); status('正在打开聊天面板…'); return send({ t: 'openEditorChat' }); }
  if ('editorReturn' in b.dataset) { closeSheet(); return; }
  if (b.dataset.nativeSurface) { closeSheet(); status('正在切换界面…'); return send({ t: 'surface', to: b.dataset.nativeSurface }); }
  if (b.dataset.sc) {
    if (b.dataset.sc === 'fold' || b.dataset.sc === 'unfold') { scFold('*', b.dataset.sc === 'fold'); return showCacheSheet(); }
    if (b.dataset.sc === 'clearAll') {
      if (!await ask('清除手机上保存的全部会话缓存？\n电脑上的对话不受影响。', '清除')) return;
      await scClear();
      return showCacheSheet();
    }
  }
  if (b.dataset.wd != null) {
    const r = $('sheet')._wd?.[Number(b.dataset.wd)];
    if (!r) return;
    if (r.name !== workdir?.name && !await ask(`把 Devin 的工作目录换成「${r.name}」？\nDevin 会切换工作区并重新载入这个文件夹，需要几秒钟，正在运行的任务可能被打断。`, '更换')) return;
    closeSheet();
    status('正在更换工作目录…');
    return send({ t: 'workdirPick', name: r.name, path: r.path });
  }
  if (b.dataset.env) { closeSheet(); status('正在更换运行位置…'); return send({ t: 'envPick', label: b.dataset.env }); }
  if (b.dataset.scHit) {
    const key = b.dataset.scHit, id = b.dataset.scId;
    if (key === SC.key) { closeSheet(); scJump(id); return; }
    const sessionId = key.split('|').slice(3).join('|');
    if ((lastChat?.session?.tabs || []).some(t => t.id === sessionId)) {
      SC.jump = id;
      closeSheet();
      status('正在切换会话…');
      return send({ t: 'openAgent', id: `tab:${sessionId}` });
    }
    return status('这个会话现在没有在电脑上打开，先到「会话」里打开它', false);
  }
  if (b.dataset.scDel) {
    if (!await ask('清除这个会话在手机上的缓存？\n电脑上的对话不受影响。', '清除')) return;
    await scClear(b.dataset.scDel);
    return showCacheSheet();
  }
  if ('fold' in b.dataset) {
    const open = b.getAttribute('aria-expanded') !== 'true';
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
    const chev = b.querySelector('.chev');
    if (chev) chev.textContent = open ? '▾' : '▸';
    const body = b.nextElementSibling;
    if (body) body.hidden = !open;
    if (open && sheetKind === 'agents') body?.querySelectorAll('[data-project-load]').forEach(el => {
      el.textContent = '正在加载会话…';
      send({ t: 'agents', projectWindow: el.dataset.projectLoad, automatic: true, silent: true });
    });
    return;
  }
  if (b.dataset.projectLoad) {
    b.textContent = '正在加载会话…';
    return send({ t: 'agents', projectWindow: b.dataset.projectLoad, automatic: true, silent: true });
  }
  if (b.dataset.launchMissing) {
    status('正在启动 Agent…');
    b.disabled = true;
    const sub = b.querySelector('.sub');
    if (sub) sub.textContent = I18N.tr('正在启动…');
    return send({ t: 'launchAgents', apps: b.dataset.launchMissing.split(',') });
  }
  if (b.dataset.win) return switchToWindow(b.dataset.win);
  if ('fusionTrust' in b.dataset) { closeSheet(); return send({ t: 'fusionTrust', approve: b.dataset.fusionTrust === 'yes' }); }
  if ('fusionDir' in b.dataset) { status('正在读取项目…'); return send({ t: 'fusionProjects', path: b.dataset.fusionDir }); }
  if ('fusionPath' in b.dataset) {
    const path = window.prompt(I18N.tr('电脑上的文件夹完整路径'));
    if (path?.trim()) { status('正在读取项目…'); send({ t: 'fusionProjects', path: path.trim() }); }
    return;
  }
  if (b.dataset.fusionFolder) { closeSheet(); return send({ t: 'fusionProject', path: b.dataset.fusionFolder }); }
  if (b.dataset.fusionContinue) {
    if (!await ask('在当前项目创建新会话，并携带旧会话最近的历史摘录？原会话保留，不会发送任务。', '续接')) return;
    closeSheet(); status('正在创建会话…');
    return send({ t: 'fusionContinue', side: b.dataset.fusionSide, id: b.dataset.fusionContinue });
  }
  if ('saveInstructions' in b.dataset) {
    status('正在保存指令…');
    return send({ t: 'codexInstructions', text: $('codexInstructions').value });
  }
  if (b.dataset.codexSetting) {
    const label = b.textContent.trim();
    if (RISKY.test(label) && !await ask(label + '？')) return;
    status('正在读取设置…'); return send({ t: 'codexSetting', id: b.dataset.codexSetting });
  }
  if (b.dataset.fusionProject) { closeSheet(); return send({ t: 'fusionProject', id: b.dataset.fusionProject }); }
  if (b.dataset.fusionHistory) { closeSheet(); return send({ t: 'fusionOpen', id: b.dataset.fusionHistory }); }
  if (b.dataset.fusionRefresh) { closeSheet(); status('正在读取额度…'); return send({ t: 'fusionUsage', side: b.dataset.fusionRefresh }); }
  if (b.dataset.fusionSelect) { closeSheet(); return send({ t: 'fusionSides', side: b.dataset.fusionSelect }); }
  if (b.dataset.fusionNew) { closeSheet(); status('正在创建会话…'); return send({ t: 'fusionNewSide', side: b.dataset.fusionSide, app: b.dataset.fusionNew }); }
  if (b.dataset.fusionId) { closeSheet(); return send({ t: 'fusionSide', side: b.dataset.fusionPick, id: b.dataset.fusionId }); }
  if (b.dataset.codexArchive) {
    const id = b.dataset.codexArchive, name = b.dataset.codexName || '';
    if (!await ask(`归档「${name}」？\n它会从当前列表移除，历史记录仍保留。`, '归档')) { send({ t: 'agents' }); return; }
    status('正在归档…');
    return send({ t: 'codexArchive', id });
  }
  if (b.dataset.agent) { pendingAgentOpen = b.dataset.agent; closeSheet(); status('正在切换 Agent…'); return send({ t: 'openAgent', id: b.dataset.agent, title: b.dataset.agentTitle || '' }); }
  if (b.dataset.term) { closeSheet(); status('正在切换终端…'); return send({ t: 'openTerminal', id: b.dataset.term }); }
  if ('projectPath' in b.dataset) {
    const path = window.prompt(I18N.tr('电脑上的文件夹完整路径'));
    if (!path?.trim()) return;
    status('正在读取文件夹…');
    return send({ t: 'projects', path: path.trim() });
  }
  if ('projectNew' in b.dataset) {
    const name = window.prompt(I18N.tr('新项目的文件夹名称'));
    if (!name?.trim()) return;
    closeSheet(); status('正在打开项目…');
    return send({ t: 'newProject', parent: b.dataset.projectNew, name: name.trim(), newSession: true });
  }
  if ('projectChat' in b.dataset) { closeSheet(); status('正在打开项目…'); return send({ t: 'openProject', path: b.dataset.projectChat, newSession: true }); }
  if ('projectTrust' in b.dataset) {
    const here = currentComputer();
    const last = here?.lastConversation;
    const returnTo = last?.windowId !== here?.windowId ? last : here?.previousConversation;
    closeSheet(); status('正在打开项目…');
    return send({ t: 'projectTrust', approve: b.dataset.projectTrust === 'yes', returnTo });
  }
  if (b.dataset.open) { closeSheet(); status('正在打开项目…'); return send({ t: 'openProject', path: b.dataset.open }); }
  if (b.dataset.dir) { status('正在读取文件夹…'); return send({ t: 'projects', path: b.dataset.dir }); }
  if (b.dataset.docsFile) { openFile(b.dataset.docsFile, b.dataset.docsEditor === 'true'); closeSheet(); return; }
  if ('docsUp' in b.dataset) {
    status('正在读取文档…');
    if (!b.dataset.docsUp) return send({ t: 'docs', editor: editorBrowsing });
    return send({ t: 'docs', editor: editorBrowsing, root: b.dataset.root, host: b.dataset.docsHost || '', path: b.dataset.docsUp });
  }
  if (b.dataset.docsRoot) { status('正在读取文档…'); return send({ t: 'docs', editor: editorBrowsing, root: b.dataset.docsRoot, host: b.dataset.docsHost || '', path: b.dataset.docsDir || b.dataset.docsRoot }); }
  if (b.dataset.settingsNav) { status('正在读取设置…'); return send({ t: 'settings', section: b.dataset.settingsNav }); }
  if (b.dataset.setting) { status('正在修改…'); return send({ t: 'toggleSetting', label: b.dataset.setting }); }
  if (b.dataset.termDel) {
    if (!await ask(`删除终端「${b.dataset.termName || ''}」？\n里面正在跑的命令会停掉。`, '删除')) return;
    closeSheet(); status('正在删除终端…'); return send({ t: 'closeTerminal', id: b.dataset.termDel });
  }
  if (b.dataset.fusionPick) { menuSheetKind = 'model'; status('正在修改…'); return send({ t: 'fusionPick', part: b.dataset.fusionPick, value: b.dataset.label }); }
  if (b.dataset.fusion) {
    status('正在修改…');
    if (b.dataset.fusion === 'fast') return send({ t: 'fusionPick', part: 'fast' });
    menuSheetKind = `fusion-${b.dataset.fusion}`;
    const fm = menuCache.get(menuCacheKey(`fusion-${b.dataset.fusion}`));
    if (fm) showMenu(fm.kind, fm.items, fm.max, fm.fusion, fm.fast, fm.model, true, fm.pricing);
    return send({ t: 'fusionOptions', part: b.dataset.fusion });
  }
  if (b.dataset.kind) {
    if (b.dataset.kind === 'codex-chat' && b.dataset.label === 'Archive' && !await ask('归档当前会话？', '归档')) return;
    if (b.dataset.kind === 'codex-chat' && b.dataset.label === 'Rename') {
      const name = window.prompt('新的会话名称');
      if (!name) return;
      closeSheet();
      return send({ t: 'pickMenu', kind: 'codex-chat', label: 'Rename', name });
    }
    // Bypass Permissions lets the Agent run every tool call (commands, edits, deletes) without asking.
    if (b.dataset.kind === 'mode' && b.dataset.label === 'Bypass Permissions' && !b.classList.contains('cur')
      && !await ask('切到「Bypass Permissions」？\nAgent 之后的所有操作（运行命令、改文件、删文件）都会自动批准，不再询问你。', '切换')) return;
    closeSheet();
    if (b.dataset.kind === 'model' || b.dataset.kind === 'effort') {
      menuCache.delete(menuCacheKey('model'));
      menuCache.delete(menuCacheKey('effort'));
    }
    if (/^fusion-model-[ab]$/.test(b.dataset.kind)) fusionModelSide = b.dataset.kind.slice(-1);
    if (b.dataset.kind !== 'codex-run' && b.dataset.kind !== 'codex-chat' && !/^fusion-(model|effort)-/.test(String(b.dataset.kind || ''))) beginSwitch(b.dataset.kind);
    return send({ t: 'pickMenu', kind: b.dataset.kind, label: b.dataset.label });
  }
  if (b.dataset.chopen) { const diff = changeFiles.find(f => f.name === b.dataset.chopen)?.diff || ''; closeSheet(); return openFile(b.dataset.chopen, false, diff, true); }
  if (b.dataset.ch) {
    const undo = b.dataset.act2 === 'undo';
    if (undo && !await ask(`撤销「${b.dataset.name}」的改动？\n文件会恢复成 Agent 改之前的样子。`, '撤销')) return send({ t: 'changes' });
    status(undo ? '正在撤销…' : '正在保留…');
    return send({ t: 'change', i: Number(b.dataset.ch), name: b.dataset.name, act: b.dataset.act2 });
  }
  if (b.dataset.chbar) {
    if (RISKY.test(b.dataset.chbar) && !await ask(`确定要点「${b.dataset.chbar}」吗？`, b.dataset.chbar)) return send({ t: 'changes' });
    status('处理中…');
    return send({ t: 'change', i: 0, name: b.dataset.chbar, act: 'bar' });
  }
  if ('max' in b.dataset) { status('切换 MAX Mode…'); return send({ t: 'toggleMax' }); }
  if (b.dataset.params) { status('读取模型参数…'); return send({ t: 'params', model: b.dataset.params, label: b.dataset.plabel }); }
  if (b.dataset.section) { status('设置中…'); return send({ t: 'pickParam', model: b.dataset.model, label: b.dataset.plabel, section: b.dataset.section, value: b.dataset.value }); }
  const act = b.dataset.act;
  if ('deviceRemoveCancel' in b.dataset) { deviceRemoval = []; return renderDevices(); }
  if ('deviceRemoveConfirm' in b.dataset) return removePairedDevices(deviceRemoval, true);
  if (b.dataset.entryInvite) return inviteDeviceEntry(b.dataset.entryInvite);
  if ('entryCopy' in b.dataset) return copyText(deviceInvitation.link, b);
  if (b.dataset.entryDecide) return decideDeviceEntry(b);
  if (b.dataset.deviceGroupRemove) return removePairedDevices(pairedDevices.filter(d => d.groupId === b.dataset.deviceGroupRemove).map(d => d.id));
  if (b.dataset.deviceGroupTarget) return moveDeviceEntries(b.dataset.deviceGroupTarget);
  if (b.dataset.deviceGroupRename) {
    const group = deviceGroups().find(g => g.id === b.dataset.deviceGroupRename);
    const name = window.prompt('设备名称', group.name)?.trim();
    if (name) return moveDeviceEntries(group.id, name, group.entries.map(d => d.id));
    return;
  }
  if ('deviceGroupNew' in b.dataset) {
    const name = window.prompt('设备名称')?.trim();
    if (name) return moveDeviceEntries('', name);
    return;
  }
  if (b.dataset.listAction) return handleListAction(b.dataset.listAction);
  if (b.dataset.groupMove != null) return moveSelectedComputers(b.dataset.groupMove);
  if (b.dataset.groupRename != null) return editComputerGroup(b.dataset.groupRename);
  if (b.dataset.groupDelete != null) return deleteComputerGroup(b.dataset.groupDelete);
  if (act === 'toggleChanges') { toggleChangeNotice(); return closeSheet(); }
  if (act === 'executionToggle') return toggleExecutionRecords();
  if (act === 'newTerm') { closeSheet(); status('正在新建终端…'); return send({ t: 'newTerminal' }); }
  else if (act === 'fusionHistory') { closeSheet(); return send({ t: 'fusionHistory' }); }
  else if (act === 'fusionNew') { closeSheet(); return send({ t: 'fusionNew' }); }
  else if (act === 'localVoiceToggle') return toggleLocalVoice();
  else if (act === 'agentManager' || act === 'agentRefresh') return showAgentManager(true);
  else if (act === 'agentBack') return showMainMenu();
  else if (act === 'agentStart') return connLaunch();
  else if (act === 'agentInstall') {
    const a = CONN_AGENTS.find(a => a.app === b.dataset.agent);
    openSheet('agent-install', `<h3>${esc(a.name)} · ${I18N.tr('安装与启动')}</h3><p>${I18N.tr('请在电脑端安装对应应用；Codex 需先安装 VS Code，再安装 Codex 扩展并登录。')}</p><p>${I18N.tr('安装后使用仓库的启动脚本开启调试端口，再返回重新检测。')}</p><pre>Linux: ./scripts/start-${a.app}.sh<br>Windows: window_start/start-agents.ps1 -Apps ${a.app}</pre><p class="hint">${I18N.tr('macOS 请在电脑端以远程调试模式启动应用，当前不支持远程启动。')}</p><button class="opt" data-act="agentManager">返回 Agent 管理</button>`);
  }
  else if (act === 'localVoiceMenu') return showLocalVoiceMenu();
  else if (act === 'voiceBack') return showMainMenu();
  else if (act === 'codexRetryMenu') return showCodexRetryMenu();
  else if (act === 'codexRetryToggle') return toggleCodexAutoRetry();
  else if (act === 'codexRetryBack') return showMainMenu();
  else if (b.dataset.voiceEngine) return selectVoiceEngine(b.dataset.voiceEngine);
  else if (act === 'transfer') return openTransfer();
  else if (act === 'model') return requestMenu('model', '读取模型列表…');
  else if (act === 'mode') return requestMenu('mode', '读取模式列表…');
  else if (act === 'permission') return requestMenu(lastChat?.permission ? 'permission' : 'mode', '读取权限…');
  else if (act === 'agentsRefresh') return openAgentList(true);
  else if (act === 'projects') { status('正在读取项目…'); return send({ t: 'projects' }); }
  else if (act === 'projectNewChat') { closeSheet(); status('正在新建对话…'); return send({ t: 'newProjectChat' }); }
  else if (act === 'codexResetHelp') {
    openSheet('codex-reset', `<h3>Codex 额度重置</h3><p>官方发放的重置券用于恢复指定的额度窗口，不是充值余额。</p><ol><li>登录与电脑端 Codex 相同的 ChatGPT 账号，打开官方额度页面。</li><li>找到 Usage limit resets → Available，检查可用次数、重置范围和到期时间。</li><li>点击所选券的 Use reset，按官方页面提示确认。</li><li>完成后回到这里，点击额度展示并刷新数据。</li></ol><p class="hint">Full reset 用于恢复 5 小时和每周额度；具体范围以券的说明为准。已使用记录可在 History 查看。</p><a class="opt" href="https://chatgpt.com/codex/settings/usage" target="_blank" rel="noopener noreferrer">打开官方额度页面</a>`);
  }
  else if (act === 'editor') { return startEditor(); }
  else if (act === 'settings') return openSettings();
  else if (act === 'screen') { closeSheet(); return setMode('screen'); }
  else if (act === 'changeUrl') window.AgentRemoteApp?.changeUrl();
  else if (act === 'connPartialToggle' || act === 'connLaunchToggle') {
    const partial = act === 'connPartialToggle';
    const on = partial ? !connAutoPartialOn() : store.get('conn-auto-launch') !== '1';
    store.set(partial ? 'conn-auto-partial' : 'conn-auto-launch', on ? '1' : '0');
    const row = $(partial ? 'menuPartialRow' : 'menuLaunchRow');
    row?.setAttribute('aria-checked', String(on));
    row?.querySelector('.switch')?.classList.toggle('on', on);
    if (conn.active) connRender();
    if (partial && on) { conn.enterRequested = true; connMaybeEnter(); }
  }
  else if (act === 'notifyToggle') {
    const row = $('notifySwitchRow');
    if (row?.getAttribute('aria-busy') === 'true') return;
    const want = !notifyOn;
    row?.setAttribute('aria-busy', 'true');
    status(want ? '正在开启通知…' : '正在关闭通知…');
    // Called synchronously in the tap: iOS needs Notification.requestPermission() before any await.
    const done = want ? enableNotify() : disableNotify();
    Promise.resolve(done).catch(e => status(e.message, false)).finally(() => { row?.removeAttribute('aria-busy'); paintNotifySwitch(); });
  }
  else if (act === 'appUpdate') {
    if (apkUpdate()) { closeSheet(); installAppUpdate(); }
    else { await checkAppUpdate(true); if (apkUpdate()) showMainMenu(); }
  }
  else if (act === 'reconnect') { closeSheet(); ws?.close(); }
  else if (act === 'theme') {
    const next = { dark: 'light', light: 'auto', auto: 'dark' }[store.get('theme') || 'dark'];
    setAppTheme(next);
    send({ t: 'appTheme', dark: document.documentElement.dataset.theme !== 'light' });
    showMainMenu();
  }
  else if (act === 'cache') showCacheSheet();
  else if (act === 'bg') showBgSheet();
  else if (act === 'bgBattery') { window.AgentRemoteApp.askBattery(); closeSheet(); }
  else if (act === 'bgNotifySettings') { window.AgentRemoteApp.openNotifySettings(); closeSheet(); }
  else if (act === 'bgReconnect') { window.AgentRemoteApp.reconnectListen(); status('正在重连…'); setTimeout(showBgSheet, 1500); }
  else if (act === 'lang') I18N.set(I18N.lang === 'en' ? 'zh' : 'en');
  else if (act === 'computers') showComputers();
  else if (act === 'addComputer') addComputer();
  else if (act === 'devices') showDevices();
  else if (b.dataset.remove) return removePairedDevices([b.dataset.remove]);
  else if (b.dataset.computerPub != null) {
    const entry = unseenPublished().find(c => c.id === b.dataset.computerPub);
    if (entry?.discovery && new URL(entry.discovery).origin !== location.origin) return openComputerEntry(new URL('./', entry.discovery).href, entry.id);
    return pairPublished(b.dataset.computerName);
  }
  else if (b.dataset.computerI != null) { closeSheet(); return useComputer(b.dataset.computerI); }
  else if (b.dataset.computerDel != null) return removeComputer(b.dataset.computerDel);
  else if (act === 'logout') {
    const cur = currentComputer();
    if (!cur) return;
    const i = loadComputers().findIndex(c => c.key === cur.key);
    if (i < 0) return;
    return removeComputer(i);
  }
});

function showComputers(note = '') {
  prepareListManagement('computers');
  const list = loadComputers();
  const cur = currentComputer();
  const row = (c, i) => {
    const pub = publishedComputers().find(p => p.id === c.id);
    const name = (pub?.name && (c.name === '电脑' || c.name === '这台电脑')) ? pub.name : (c.name || pub?.name || '电脑');
    const here = cur && c.key === cur.key;
    const tag = listManagement.editing ? 'label' : 'button';
    return `<div class="optRow"><${tag} class="opt ${listManagement.editing ? 'static' : ''} ${here ? 'cur' : ''}" ${listManagement.editing ? '' : `data-computer-i="${i}"`}>${listManagement.editing ? listCheckbox(c.key) : ''}<span class="lbl">${esc(name)}${here ? '<span class="sub">当前</span>' : ''}</span></${tag}>${listManagement.editing ? '' : `<button class="paramBtn" data-computer-del="${i}">删除</button>`}</div>`;
  };
  const groups = computerGroupNames();
  const saved = ['', ...groups].map(group => {
    const rows = list.map((c, i) => (c.group || '') === group ? row(c, i) : '').join('');
    if (!group && !rows) return '';
    const heading = groups.length ? `<div class="computerGroupHead"><strong>${group ? esc(group) : '未分组'}</strong>${group && listManagement.editing ? `<button data-group-rename="${esc(group)}">重命名</button><button data-group-delete="${esc(group)}">删除分组</button>` : ''}</div>` : '';
    return heading + rows + (group && !rows ? '<div class="hint">暂无电脑</div>' : '');
  }).join('');
  const extra = unseenPublished().map(p => `<button class="opt" data-computer-pub="${esc(p.id)}" data-computer-name="${esc(p.name || '电脑')}"><span class="lbl">${esc(p.name || '电脑')}<span class="sub">${p.discovery && new URL(p.discovery).origin !== location.origin ? '打开入口' : '未配对'}</span></span></button>`).join('');
  const hint = note ? `<div class="hint">${esc(note).replace(/\n/g, '<br>')}</div>` : '';
  openSheet('computers', `<h3>电脑</h3><div class="listTools">${listTools()}</div>${hint}${saved}${extra || (saved ? '' : '<div class="hint">还没有配对的电脑。</div>')}<button class="opt" data-act="addComputer"><span class="lbl">＋ 配对另一台电脑</span></button><div class="hint">在那台电脑上运行 npm run pair，把链接粘贴过来。已配对的电脑会保留。</div>`);
}
function computerGroupNames() {
  return [...new Set([...JSON.parse(store.get('computerGroups') || '[]'), ...loadComputers().map(c => c.group).filter(Boolean)])];
}
function showComputerGroupPicker() {
  openSheet('computer-group-picker', '<h3>移至分组</h3><button class="opt" data-group-move="">未分组</button>' + computerGroupNames().map(name => `<button class="opt" data-group-move="${esc(name)}">${esc(name)}</button>`).join('') + '<button class="opt" data-list-action="new-group">＋ 新建分组</button><button class="opt" data-act="computers">返回</button>');
}
function moveSelectedComputers(group) {
  saveComputers(loadComputers().map(c => listManagement.selected.has(c.key) ? { ...c, group } : c), currentComputer()?.key || '');
  listManagement.selected.clear();
  showComputers();
}
function editComputerGroup(previous = null) {
  const moving = sheetKind === 'computer-group-picker';
  const name = window.prompt(I18N.tr(previous == null ? '新分组名称' : '重命名分组'), previous || '')?.trim();
  if (!name || name === previous) return;
  const names = computerGroupNames();
  if (names.includes(name) || name === I18N.tr('未分组') || name === '未分组') return status('分组名称已存在', false);
  store.set('computerGroups', JSON.stringify(previous == null ? [...names, name] : names.map(n => n === previous ? name : n)));
  if (previous != null) saveComputers(loadComputers().map(c => c.group === previous ? { ...c, group: name } : c), currentComputer()?.key || '');
  moving ? moveSelectedComputers(name) : showComputers();
}
async function deleteComputerGroup(name) {
  if (!await ask(`删除分组「${name}」？电脑会移到未分组，不会删除配对。`, '删除')) return showComputers();
  store.set('computerGroups', JSON.stringify(computerGroupNames().filter(n => n !== name)));
  saveComputers(loadComputers().map(c => c.group === name ? { ...c, group: '' } : c), currentComputer()?.key || '');
  showComputers();
}
function pairPublished(name) {
  closeSheet();
  gate({
    msg: `「${name || '这台电脑'}」还没在这只手机上配对。\n在那台电脑上运行 npm run pair，扫码或把链接粘贴到下面。已配对的电脑会保留。`,
    input: { placeholder: '粘贴配对链接', button: '配对', submit: pastePair, scan: true },
    retry: '返回',
    onRetry: () => showComputers(),
  });
}
function addComputer() {
  closeSheet();
  gate({
    input: { placeholder: '粘贴配对链接', button: '配对', submit: pastePair, scan: true },
    retry: '返回',
    onRetry: () => loadComputers().length ? showComputers() : showUnpaired(),
  });
}
async function useComputer(i) {
  const list = loadComputers();
  const c = list[Number(i)];
  if (!c) return showComputers();
  saveDraft();
  if (c.discovery && new URL(c.discovery).origin !== location.origin) {
    return openComputerEntry(new URL('./', c.discovery).href, c.id || await computerIdFromKey(c.key));
  }
  entryComputer = '';
  saveComputers(list, c.key);
  restoreDraft();
  store.set('window', c.win || null);
  connGen++;
  offlineGen++;
  authed = false;
  const old = ws;
  ws = null;
  try { old?.close(); } catch {}
  closeSheet();
  boot();
}
async function removeComputer(i) {
  const list = loadComputers();
  const c = list[Number(i)];
  if (!c) return showComputers();
  return removeComputers([c.key]);
}
// A deleted computer must forget this phone even when we're not connected to it, or it keeps pushing notifications here.
// Queued in localStorage and retried on the next start until the relay answers.
const logoutQueue = () => { try { return JSON.parse(store.get('pending-logouts') || '[]'); } catch { return []; } };
function queueLogouts(list) {
  const q = logoutQueue().filter(p => !list.some(c => c.token === p.token));
  store.set('pending-logouts', JSON.stringify([...q, ...list.map(c => ({ id: c.id || '', key: c.key, token: c.token, discovery: c.discovery || new URL('url.json', location.href).href }))]));
}
async function relayOf(c) {
  const reg = await fetch(c.discovery + '?t=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(8000) }).then(r => r.json());
  if (reg.self) return new URL(c.discovery).origin;
  if (reg.v === 2 && reg.data) return decryptEntry(c.key, reg);
  const id = c.id || await computerIdFromKey(c.key);
  const entry = (reg.computers || []).find(e => e.id === id);
  if (!entry) throw Error('not published');
  return decryptEntry(c.key, entry);
}
async function flushLogouts() {
  for (const p of logoutQueue()) {
    let done = false;
    try {
      const r = await fetch(await relayOf(p) + '/api/logout', { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(8000),
        headers: { 'content-type': 'application/json', ...await entryHeaders(p, 'POST', '/api/logout') }, body: '{}' });
      const body = r.status === 401 ? await r.json().catch(() => ({})) : {};
      // 401 without needTotp: the relay already forgot this device. 403: that relay doesn't accept this page's origin; the relay's own expiry covers it.
      done = r.ok || r.status === 403 || (r.status === 401 && !body.needTotp);
    } catch {}
    if (done) store.set('pending-logouts', JSON.stringify(logoutQueue().filter(x => x.token !== p.token)));
  }
}
async function removeComputers(keys) {
  const selected = loadComputers().filter(c => keys.includes(c.key));
  if (!selected.length) return;
  if (!await ask(`删除电脑「${selected.map(c => c.name || '电脑').join('、')}」？\n这台手机不再连接它们。`, '删除')) return showComputers();
  const cur = currentComputer();
  const removingCurrent = cur && keys.includes(cur.key);
  let loggedOut = '';
  if (removingCurrent && authed) await post('/api/logout').then(r => { if (r.ok) loggedOut = cur.key; }).catch(() => {});
  queueLogouts(selected.filter(c => c.key !== loggedOut));
  flushLogouts();
  const nextList = loadComputers().filter(x => !keys.includes(x.key));
  const next = nextList[0];
  saveComputers(nextList, removingCurrent ? '' : (cur?.key || ''));
  listManagement.selected.clear();
  if (!next) {
    connGen++;
    authed = false;
    try { ws?.close(); } catch {}
    ws = null;
    closeSheet();
    return showUnpaired();
  }
  if (removingCurrent) return useComputer(loadComputers().findIndex(x => x.key === next.key));
  showComputers();
}


$('sheet').addEventListener('change', e => {
  const field = e.target.closest('[data-codex-field]');
  if (field) { status('正在读取设置…'); send({ t: 'codexSetting', id: field.dataset.codexField, value: field.value }); }
});

$('sheet').addEventListener('change', e => {
  const field = e.target.closest('[data-setting-field]');
  if (field) { status('正在修改…'); send({ t:'toggleSetting', label:field.dataset.settingField, value:field.value }); }
});

// Retry queued logouts from previous deletions (fire and forget; must not block startup).
flushLogouts();
