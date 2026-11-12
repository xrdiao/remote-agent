/* ---------- bottom sheet ---------- */
let sheetKind = null;
let menuRefreshTimer = 0;
let menuPending = null, menuPickRequest = 0, modelSwitchRequest = null;
let projectEntry = null;
function finishModelPick(m) {
  if (!modelSwitchRequest || m.requestId !== modelSwitchRequest.requestId) return;
  modelSwitchRequest = null;
  if (m.sel !== viewSel) return;
  if (m.kind === 'fast') {
    $('sheet').querySelectorAll('[data-fast]').forEach(button => { button.disabled = false; button.removeAttribute('aria-busy'); button.querySelector('[data-fast-pending]')?.remove(); });
    return;
  }
  if (m.kind === 'permission' && currentApp === 'opencode') {
    menuCache.delete(menuCacheKey('permission'));
    if (m.ok) status(`已切换到 ${m.label}`);
    return;
  }
  menuCache.delete(menuCacheKey('model')); menuCache.delete(menuCacheKey('effort'));
  if (m.ok) status(`已切换到 ${m.label}`);
}
let pendingAgentOpen = '';
const agentOpened = JSON.parse(store.get('agent-opened') || '{}');
const agentUsage = JSON.parse(store.get('agent-usage') || '{}');
const agentFavorites = JSON.parse(store.get('agent-favorites') || '{}');
const agentFilters = JSON.parse(store.get('agent-filters') || '{}');
let sharedAgentLibrary = { computer: '', records: {} };
let pendingAgentFavorite = null;
let agentActionRequest = 0;
let pendingAgentActions = null;
let agentActionTarget = null;
let agentBatch = null;
function batchActive() { return agentBatch?.key === agentListKey(); }
function receiveSessionBatch(m) {
  if (!agentBatch || m.requestId !== agentBatch.requestId) return;
  agentBatch.progress = m;
  agentBatch.running = !m.done;
  for (const row of m.results) if (row.ok) agentBatch.selected.delete(row.id);
  if (sheetKind === 'agents' && batchActive()) renderAgentList();
}
function interruptSessionBatch() {
  if (!agentBatch?.running) return;
  agentBatch.running = false;
  agentBatch.selected.clear();
  agentBatch.progress = { ...agentBatch.progress, results: agentBatch.progress?.results || [], total: agentBatch.progress?.total || 0, done: true };
  agentLists.delete(agentBatch.key);
  saveAgentLists();
  if (sheetKind === 'agents') closeSheet();
  status('批量操作已中断，请刷新列表确认已完成结果', false);
}
function showProjectWindows(m) {
  openSheet('project-windows', `<h3>项目窗口</h3><button class="opt" data-window-enabled="${m.enabled ? '0' : '1'}"><span class="lbl">自动关闭空闲窗口</span><span class="switch${m.enabled ? ' on' : ''}"></span></button><label class="pSec">空闲分钟数<input data-window-idle type="number" min="1" value="${m.idleMinutes}"></label>${m.windows.map(w => `<div class="pSec">${esc(({cursor:'Cursor',devin:'Devin',codex:'Codex'})[w.app] + ' · ' + w.title)}</div><div class="hint">${esc(w.root)}<br>${esc(w.reason || (w.owned ? '已纳入自动管理' : '未纳入自动管理'))}</div><button class="opt" data-window-key="${esc(w.key)}" data-window-owned="${w.owned ? '0' : '1'}">${w.owned ? '退出自动管理' : '纳入自动管理'}</button><button class="opt" data-window-key="${esc(w.key)}" data-window-keep="${w.keep ? '0' : '1'}">${w.keep ? '取消保留' : '始终保留此窗口'}</button>`).join('')}`);
  $('sheet').querySelector('[data-window-idle]').onchange = e => send({ t: 'projectWindowSet', change: { idleMinutes: Number(e.target.value) } });
}
const agentOpenedKey = thread => `${currentComputer()?.id || ''}|${currentAppName}|${thread}`;
const agentUsageKey = id => `${currentComputer()?.id || currentComputer()?.key || ''}|${currentApp || currentAppName}|${id}`;
const agentFilterKey = () => `${currentComputer()?.id || currentComputer()?.key || ''}|${currentApp || currentAppName}`;
const agentFilterLabels = { all: '全部', common: '常用' };
function currentAgentFilters() {
  const saved = agentFilters[agentFilterKey()] || {};
  return { session: saved.session === 'common' ? 'common' : 'all' };
}
function setAgentFilter(value) {
  if (!agentFilterLabels[value]) return;
  agentFilters[agentFilterKey()] = { session: value };
  store.set('agent-filters', JSON.stringify(agentFilters));
}
function agentThreadKey(a, app = currentApp) {
  if (a.threadId) return a.threadId;
  return RemoteAgentRules.parseSessionRef(app, a.id);
}
function legacyAgentLibrary() {
  const entries = new Map();
  const prefixes = [currentComputer()?.id, currentComputer()?.key].filter(Boolean).map(id => id + '|');
  for (const key of new Set([...Object.keys(agentFavorites), ...Object.keys(agentUsage)])) {
    const prefix = prefixes.find(prefix => key.startsWith(prefix));
    if (!prefix) continue;
    const [appName, ...parts] = key.slice(prefix.length).split('|');
    const app = appName.toLowerCase();
    const id = RemoteAgentRules.parseSessionRef(app, parts.join('|'));
    if (!['cursor', 'devin', 'codex', 'opencode'].includes(app) || !id || /^(?:pick|new|win|window|project-new):/.test(id)) continue;
    const entry = entries.get(app + '|' + id) || { app, id };
    if (agentFavorites[key]) entry.favorite = true;
    entry.lastMessageAt = Math.max(entry.lastMessageAt || 0, Number(agentUsage[key]?.lastMessageAt) || 0);
    entries.set(app + '|' + id, entry);
  }
  return [...entries.values()];
}
function sharedAgentRecord(id, app = currentApp) {
  return sharedAgentLibrary.computer === currentComputer()?.id
    ? sharedAgentLibrary.records[app]?.[agentThreadKey({ id }, app)] || {} : {};
}
function agentSessionAvailable(row, app = currentApp) {
  const state = sharedAgentRecord(row.id, app);
  return row.ui || !state.archived && !state.deleted;
}
function receiveSessionLibrary(message) {
  if (message.computer !== currentComputer()?.id) return;
  sharedAgentLibrary = message;
  for (const app of ['cursor', 'devin', 'codex', 'opencode']) {
    const prefix = currentComputer().key + ':' + app;
    for (const [key, list] of [...agentLists]) {
      if (key !== prefix && !key.startsWith(prefix + ':')) continue;
      const available = list.filter(row => agentSessionAvailable(row, app));
      if (available.length !== list.length) setAgentList(key, available);
    }
  }
  if (pendingAgentFavorite && message.records[pendingAgentFavorite.app]?.[agentThreadKey({ id: pendingAgentFavorite.id }, pendingAgentFavorite.app)]?.favorite === pendingAgentFavorite.on) {
    status(pendingAgentFavorite.on ? '已设为常用' : '已取消常用');
    pendingAgentFavorite = null;
  }
  if (sheetKind === 'agents') renderAgentList();
  const here = currentComputer();
  if (windowReady && !navigationPending && !agentSessionAvailable({ id: here.threadId }))
    send({ t: 'attach', id: here.win, windowId: here.windowId, threadId: '' });
}
function receiveSessionChange(message) {
  if (message.computer !== currentComputer()?.id) return;
  const prefix = currentComputer().key + ':' + message.app;
  for (const [key, list] of [...agentLists]) {
    if (key !== prefix && !key.startsWith(prefix + ':')) continue;
    setAgentList(key, list.flatMap(a => agentThreadKey(a, message.app) !== message.id ? [a]
      : message.action === 'rename' ? [{ ...a, title: message.title }] : []));
  }
  if (sheetKind === 'agents' && currentApp === message.app) renderAgentList();
  const here = currentComputer();
  if (message.action !== 'rename' && currentApp === message.app && here.threadId === message.id)
    send({ t: 'attach', id: here.win, windowId: here.windowId, threadId: '' });
}
function agentSessionCommon(record) {
  const lastMessageAt = Number(record.lastMessageAt) || 0;
  const ageDays = lastMessageAt > 0 && lastMessageAt <= Date.now() ? (Date.now() - lastMessageAt) / 86400000 : Infinity;
  return record.favorite === true || (lastMessageAt > 0 && ageDays <= 7);
}
function agentUsageInfo(a) {
  const thread = agentThreadKey(a);
  const saved = { ...(agentUsage[agentUsageKey(thread)] || {}), ...(agentUsage[agentUsageKey(a.id)] || {}) };
  const opened = agentOpened[agentOpenedKey(thread)] || 0;
  const lastUsed = Math.max(Number(a.lastUsed) || 0, Number(saved.last) || 0, opened);
  const shared = sharedAgentRecord(a.id);
  const favorite = shared.favorite === true;
  return { ...a, ...(shared.title && !a.ui ? { title: shared.title } : {}), lastUsed, favorite, common: agentSessionCommon(shared) };
}
function agentFavoriteState(id) {
  return sharedAgentRecord(id).favorite === true;
}
function setAgentFavorite(id, on) {
  pendingAgentFavorite = { id, on, app: currentApp };
  if (!send({ t: 'sessionFavorite', app: currentApp, id: agentThreadKey({ id }), favorite: on })) pendingAgentFavorite = null;
}
function rememberAgentMessageTime(thread, at) {
  const timestamp = Number(at);
  if (!thread || !Number.isFinite(timestamp) || timestamp <= 0) return;
  const key = agentUsageKey(thread), previous = agentUsage[key] || {};
  if (timestamp <= (Number(previous.lastMessageAt) || 0)) return;
  agentUsage[key] = { ...previous, lastMessageAt: timestamp };
  store.set('agent-usage', JSON.stringify(agentUsage));
}
function rememberChatMessageTime(chat) {
  const latest = (chat?.items || []).reduce((at, item) => item.k === 'human' && Number.isFinite(item.sentAt) ? Math.max(at, item.sentAt) : at, 0);
  rememberAgentMessageTime(chat?.thread, latest);
}
function rememberAgentOpen(m) {
  const target = /^(?:thread|win|new):([^:]+)(?::(.+))?$/.exec(pendingAgentOpen);
  const matched = pendingAgentOpen.startsWith('thread:')
    ? agentThreadKey({ id: pendingAgentOpen }, m.app) === m.threadId
    : m.app === 'codex' ? target && m.windowId === target[1] && (!target[2] || m.threadId === target[2]) : pendingAgentOpen === m.threadId;
  if (!m.closed && pendingAgentOpen && matched && m.threadId) {
    const now = Date.now(), openedKey = agentOpenedKey(m.threadId), usageKey = agentUsageKey(m.threadId);
    agentOpened[openedKey] = now;
    const previous = agentUsage[usageKey] || {};
    agentUsage[usageKey] = { ...previous, count: (Number(previous.count) || 0) + 1, last: now };
    store.set('agent-opened', JSON.stringify(agentOpened));
    store.set('agent-usage', JSON.stringify(agentUsage));
    pendingAgentOpen = '';
  }
}
function openSheet(kind, html) {
  if (!['agents', 'agent-actions', 'projects', 'project-trust', 'computer-files'].includes(kind)) projectEntry = null;
  if (kind !== 'ask') askDone?.(false);
  if (kind !== 'agents') pendingProjectReveal = null;
  if (sheetKind === 'devices' && kind !== 'devices') deviceInviteGeneration++;
  cancelDocs();
  if (kind !== 'menu') { clearTimeout(menuRefreshTimer); menuPending = null; }
  if (kind !== 'devices') clearTimeout(deviceListTimer);
  const leavingVoice = sheetKind === 'local-voice' && kind !== 'local-voice';
  const sheet = $('sheet');
  const navScroll = sheetKind === kind ? sheet.querySelector('.codexSettingsNav')?.scrollLeft : 0;
  const swap = sheet.classList.contains('open') && sheetKind && sheetKind !== kind
    && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const h0 = swap ? sheet.offsetHeight : 0;
  sheetKind = kind;
  if (kind !== 'windows') delete sheet._winSig;
  sheet.dataset.kind = kind;
  sheet.innerHTML = html;
  const nav = sheet.querySelector('.codexSettingsNav');
  if (nav) nav.scrollLeft = navScroll || 0;
  if (swap) {
    // Kind changed while open: grow to the new height and fade the fresh content in.
    const h1 = sheet.offsetHeight;
    const easing = 'cubic-bezier(.2,.8,.2,1)';
    if (h1 !== h0) {
      sheet.style.overflow = 'hidden';
      const grow = sheet.animate([{ height: h0 + 'px' }, { height: h1 + 'px' }], { duration: 220, easing });
      const restore = () => { sheet.style.overflow = ''; };
      if (grow.finished) grow.finished.then(restore, restore); else { grow.onfinish = restore; grow.oncancel = restore; }
    }
    for (const child of sheet.children)
      child.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing });
  }
  $('shade').classList.add('open');
  sheet.classList.add('open');
  if (kind === 'agents') sheet.scrollTop = 0;
  if (leavingVoice) scheduleVoiceWarmup();
}
function closeSheet() {
  projectEntry = null;
  askDone?.(false);
  agentActionTarget = null;
  pendingProjectReveal = null;
  cancelDocs();
  clearTimeout(menuRefreshTimer);
  clearTimeout(deviceListTimer);
  const leavingVoice = sheetKind === 'local-voice';
  if (sheetKind === 'settings') send({ t: 'closeDesktopSettings' });
  if (sheetKind === 'devices') { deviceRemoval = []; deviceInviteGeneration++; }
  menuRequest++;
  menuPending = null;
  if (sheetKind === 'codex-settings') { codexSettingsRequest++; send({ t: 'closeCodexSettings' }); status(''); }
  sheetKind = null; menuSheetKind = '';
  delete $('sheet')._winSig;
  $('shade').classList.remove('open');
  $('sheet').classList.remove('open');
  if (leavingVoice) scheduleVoiceWarmup();
}
function codexAutoRetryEnabled() { return store.get('codex-auto-retry') === '1'; }
function codexAutoRetryCount() {
  const n = Number(store.get('codex-auto-retry-count'));
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 1;
}
function showCodexRetryMenu() {
  const enabled = codexAutoRetryEnabled(), count = codexAutoRetryCount();
  openSheet('codex-retry', `<h3>Codex 自动重试</h3>`
    + `<button class="opt" data-act="codexRetryToggle" role="switch" aria-checked="${enabled}"><span class="lbl">自动点击 Retry<span class="sub">模型容量不足时自动点击电脑端 Retry</span></span><span class="switch${enabled ? ' on' : ''}" aria-hidden="true"></span></button>`
    + `<label class="opt"><span class="lbl">每次最多点击次数<span class="sub">只限制同一条容量提示的自动点击次数</span></span><input id="codexRetryCount" type="number" min="1" max="5" step="1" value="${count}" ${enabled ? '' : 'disabled'}></label>`
    + '<p class="hint">默认关闭；达到次数后保留 Retry 按钮，由你手动决定是否继续。</p><button class="opt" data-act="codexRetryBack">← 返回菜单</button>');
  $('codexRetryCount').onchange = () => {
    const n = Math.max(1, Math.min(5, Math.round(Number($('codexRetryCount').value) || 1)));
    store.set('codex-auto-retry-count', String(n));
    $('codexRetryCount').value = n;
    syncCodexAutoRetry(lastChat, chatStale);
  };
}
function toggleCodexAutoRetry() {
  store.set('codex-auto-retry', codexAutoRetryEnabled() ? null : '1');
  syncCodexAutoRetry(lastChat, chatStale);
  showCodexRetryMenu();
}
$('shade').onclick = () => { closeSheet(); };

// Confirmation for anything that interrupts the Agent or throws work away; resolves false if dismissed.
let askDone = null;
const confirmationScope = () => [currentComputer()?.id || '', viewSel, mode].join('|');
function ask(question, ok = '确定', scoped = false) {
  askDone?.(false);
  const owner = scoped ? confirmationScope() : '';
  return new Promise(resolve => {
    const changed = () => { if (owner !== confirmationScope()) closeSheet(); };
    askDone = v => {
      if (scoped) document.removeEventListener('composer-state', changed);
      askDone = null;
      resolve(v && (!scoped || owner === confirmationScope()));
    };
    if (scoped) document.addEventListener('composer-state', changed);
    openSheet('ask', `<h3 class="askQ">${esc(question)}</h3><div class="askBtns">`
      + `<button id="askNo">取消</button><button id="askOk" class="danger">${esc(ok)}</button></div>`);
    $('askOk').onclick = () => { askDone?.(true); closeSheet(); };
    $('askNo').onclick = () => { closeSheet(); };
  });
}
// Buttons on Cursor's own cards that stop, reject or discard work.
const RISKY = /^(stop|reject|deny|undo|discard|revert|cancel|delete|remove|停止|拒绝|撤销|丢弃|取消|删除)/i;

const KIND_TAG = { agents: 'Agents', ssh: 'SSH', local: '本地' };

// Cursor titles look like "file.py — Folder [SSH: host]"; the window is identified by folder (+ host), not the open file.
function cleanWindowTitle(title) {
  return RemoteAgentRules.cleanWindowTitle(title);
}
function winLabel(title) {
  const { name, file, host } = RemoteAgentRules.parseWindowTitle(title);
  return { name: host ? `${name} · ${host}` : name, file };
}

function windowEntries() {
  const saved = currentComputer()?.selections || {};
  const available = new Set(windows.flatMap(w => w.windowIds || [w.id]));
  const entries = windows.filter(w => ['cursor', 'devin', 'codex', 'opencode'].includes(w.app)).map(w => {
    const selected = saved[w.app]?.id;
    return { ...w, id: selected && available.has(selected) ? selected : w.id };
  });
  const missingAgents = ['cursor', 'devin', 'codex'].filter(a => !entries.some(w => w.app === a));
  return { entries, missingAgents };
}
// Same action whether a window row is tapped in the sheet or in the tablet rail.
function switchToWindow(id) {
  closeSheet();
  const entry = windowEntries().entries.find(w => w.id === id);
  send({ t: 'attach', id, restore: entry?.app !== 'fusion' });
}
function openSettings() {
  status('正在读取设置…');
  send({ t: 'settings' });
}
function showWindows() {
  const { entries, missingAgents } = windowEntries();
  entries.sort((a, b) => a.app.localeCompare(b.app));
  // A re-render replaces every row; if a windows/plans emit lands mid-press it swallows the
  // click. Row content only depends on this signature — skip the rebuild when nothing changed
  // (latency values paint in place via paintLatency).
  const sig = JSON.stringify([currentApp, I18N.lang, entries.map(w => [w.id, w.app, appPlans[w.app] || '']), missingAgents]);
  if (sheetKind === 'windows' && $('sheet')._winSig === sig) return measureLatency(entries.map(w => w.id));
  $('sheet')._winSig = sig;
  const rows = entries.map(w => {
    const software = { cursor: 'Cursor', devin: 'Devin', codex: 'Codex', fusion: 'Fusion', opencode: 'OpenCode' }[w.app] || w.app;
    const plan = appPlans[w.app] ? `<span class="winPlan">${esc(appPlans[w.app])}</span>` : '';
    return `<button class="opt ${w.app === currentApp ? 'cur' : ''}" data-win="${esc(w.id)}"><span class="optLogo" data-logo="${esc(w.app)}"></span><span class="lbl">${esc(software)}${plan}</span><span data-latency="${esc(w.id)}">${latencyMarkup(w.id)}</span></button>`;
  }).join('');
  const launchRow = missingAgents.length ? `<button class="opt" data-launch-missing="${missingAgents.join(',')}"><span class="lbl">${I18N.tr('启动未打开的 Agent')}<span class="sub">${esc(missingAgents.map(a => ({ cursor: 'Cursor', devin: 'Devin', codex: 'Codex' })[a]).join(I18N.lang === 'en' ? ', ' : '、'))}</span></span><span>›</span></button>` : '';
  openSheet('windows', `<h3>切换 Agent</h3>${rows || '<div class="hint">没有找到窗口</div>'}${launchRow}`);
  measureLatency(entries.map(w => w.id));
}

/* Split-layout rail (.split = wide screen with a wide-enough viewport, not visual mode):
   the same window list the switcher sheet builds, plus navigation rows. Collapses to an
   icon strip via body.railCollapsed; signature-skipped like the sheet so a refresh never
   swallows a tap. */
const railCollapsed = () => document.body.classList.contains('railCollapsed');
window.addEventListener('resize', () => paintRail());
function paintRail() {
  const rail = $('rail');
  if (!rail) return;
  const { entries, missingAgents } = windowEntries();
  entries.sort((a, b) => a.app.localeCompare(b.app));
  const collapsed = railCollapsed();
  const fusion = !!currentFusionRun();
  const sig = JSON.stringify([currentApp, fusion, mode, I18N.lang, currentComputer()?.name || '', $('dot').className, collapsed,
    entries.map(w => [w.id, w.app, appPlans[w.app] || '']), missingAgents]);
  // Latency probes only make sense where the badges render.
  const railOn = document.body.matches('.split');
  if (rail._sig === sig) { if (railOn) measureLatency(entries.map(w => w.id)); return; }
  rail._sig = sig;
  const names = { cursor: 'Cursor', devin: 'Devin', codex: 'Codex', fusion: 'Fusion', opencode: 'OpenCode' };
  const agentRows = entries.map(w => {
    const plan = appPlans[w.app] ? `<span class="tag">${esc(appPlans[w.app])}</span>` : '';
    const label = names[w.app] || w.app;
    return `<button class="railRow ${!fusion && w.app === currentApp ? 'cur' : ''}" data-win="${esc(w.id)}" title="${esc(label)}"><span class="railLogo" data-logo="${esc(w.app)}"></span><span class="lbl">${esc(label)}</span>${plan}<span class="latency muted" data-latency="${esc(w.id)}">${latencyMarkup(w.id)}</span></button>`;
  }).join('')
    + (missingAgents.length ? `<button class="railRow" data-rail="windows" title="${esc(I18N.tr('启动未打开的 Agent'))}"><span class="railIc"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></span><span class="lbl">${I18N.tr('启动未打开的 Agent')}</span></button>` : '');
  const row = (act, label, svg, cur) => `<button class="railRow${cur ? ' cur' : ''}" data-rail="${act}" title="${esc(I18N.tr(label))}"><span class="railIc">${svg}</span><span class="lbl">${I18N.tr(label)}</span></button>`;
  const ic = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const icChat = ic('<path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8l-6 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/>');
  const icTerm = ic('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/>');
  const icFolder = ic('<path d="M4 4h5l2 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/>');
  const icEdit = ic('<path d="M10 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v2"/><path d="m18 13 3 3-6 6h-3v-3Z"/>');
  const icTransfer = ic('<path d="M7 16V4m0 0L3 8m4-4 4 4M17 8v12m0 0 4-4m-4 4-4-4"/>');
  const icScreen = ic('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8m-4-4v4"/>');
  const icGear = ic('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.08a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.08a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z"/>');
  const icDots = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>';
  const icRail = ic('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16"/>');
  const toggleLabel = collapsed ? '展开侧栏' : '收起侧栏';
  rail.innerHTML = `
    <div class="railComputer"><img src="logo.png" alt=""><button class="railComputerName" data-rail="computers" title="${esc(I18N.tr('切换电脑'))}">${esc(currentComputer()?.name || 'Remote Agent')}</button><span class="railDot${$('dot').classList.contains('ok') ? ' ok' : ''}"></span><button class="railToggle" data-rail="toggle" title="${I18N.tr(toggleLabel)}" aria-label="${I18N.tr(toggleLabel)}">${icRail}</button></div>
    <div class="pSec">Agent</div>
    ${agentRows}
    <button class="railRow${fusion ? ' cur' : ''}" data-rail="fusion" title="Fusion"><span class="railLogo" data-logo="fusion"></span><span class="lbl">Fusion</span></button>
    <div class="pSec">${I18N.tr('工作区')}</div>
    ${row('agents', '项目/会话', icFolder)}
    ${supportsCapability('editor', ['cursor', 'devin', 'codex'].includes(currentApp)) ? row('editor', 'Editor', icEdit) : ''}
    ${row('mode-chat', '对话', icChat, mode === 'chat')}
    ${row('mode-terminal', '终端', icTerm, mode === 'terminal')}
    <div class="pSec">${I18N.tr('工具')}</div>
    ${row('transfer', '文件传输', icTransfer)}
    ${row('screen', '画面', icScreen)}
    ${row('settings', '设置', icGear)}
    ${row('menu', '更多', icDots).replace('class="railRow', 'class="railRow railMore')}
  `;
  if (railOn) measureLatency(entries.map(w => w.id));
}
$('rail')?.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.win) return switchToWindow(b.dataset.win);
  const act = b.dataset.rail;
  if (act === 'fusion') {
    if (currentFusionRun()) { fusionPanelOpen = true; fusionPanelCollapsed = false; readFusionView(currentFusionRun().computer, currentFusionRun().id, 'tasks'); }
    else { ovBackToBoard(); ovMove({ level: 'fusion', proj: null, open: null }); }
  }
  else if (act === 'windows') { send({ t: 'windows' }); showWindows(); }
  else if (act === 'computers') showComputers();
  else if (act === 'agents') openAgentList();
  else if (act === 'editor') startEditor();
  else if (act === 'mode-chat') setMode('chat');
  else if (act === 'mode-terminal') setMode('terminal');
  else if (act === 'transfer') openTransfer();
  else if (act === 'screen') setMode('screen');
  else if (act === 'settings') openSettings();
  else if (act === 'menu') showMainMenu();
  else if (act === 'toggle') {
    store.set('rail', railCollapsed() ? 'expanded' : 'collapsed');
    fitRail();
    paintRail();
  }
});

function fusionUsageBars(m) {
  return [...(m.quota || []), ...(m.limits || []), ...((m.quota || m.limits) ? [] : (m.bars || []))].map(b => {
    if (b.pct == null || b.pct === '' || !Number.isFinite(Number(b.pct))) return b;
    const n = b.basis === 'remaining' ? Number(b.pct) : 100 - Number(b.pct);
    return { ...b, basis: 'remaining', pct: Number(Math.max(0, Math.min(100, n)).toFixed(2)) };
  });
}
function showTerminals(list) {
  const rows = list.map(t => `<div class="optRow"><button class="opt ${t.id === currentTerminalId ? 'cur' : ''}" data-term="${esc(t.id)}"><span class="lbl">${esc(t.title)}${t.exited ? ` · ${I18N.tr('已退出')}` : ''}<span class="sub ovRaw">${esc(t.cwd)}</span><span class="sub">${t.cols} × ${t.rows}</span></span>${t.id === currentTerminalId ? '<span class="tag">当前</span>' : ''}</button><button data-term-del="${esc(t.id)}" data-term-name="${esc(t.title)}">删除</button></div>`).join('');
  openSheet('terminals', `<h3>RA 终端</h3>${rows || '<div class="hint">还没有终端。</div>'}<button class="opt" data-act="newTerm"><span class="lbl">＋ 新建终端</span></button>`);
}
function showTerminalMore() {
  const row = (action, label) => `<button class="opt" data-terminal-action="${action}"${terminalActionAvailable(action) ? '' : ' disabled'}><span class="lbl">${I18N.tr(label)}</span></button>`;
  openSheet('terminal-more', `<h3>RA 终端</h3>${row('size', '尺寸')}${row('refresh', '刷新输出')}`);
}
function showTerminalSize() {
  if (!terminalAvailable()) return;
  openSheet('terminal-size', `<h3>${I18N.tr('终端尺寸')}</h3><p class="hint">${I18N.tr('尺寸独立于手机屏幕，显示不下时滚动查看。')}</p><form id="terminalSizeForm" class="terminalSizeForm"><label>${I18N.tr('列数')}<input id="terminalCols" type="number" min="2" step="1" required value="${raTerminal.cols}"></label><label>${I18N.tr('行数')}<input id="terminalRows" type="number" min="2" step="1" required value="${raTerminal.rows}"></label><button type="submit">${I18N.tr('应用')}</button></form>`);
  const target = { id: currentTerminalId, subscription: terminalSubscription, computer: currentComputer().id };
  $('terminalSizeForm').onsubmit = e => {
    e.preventDefault();
    if (!terminalAvailable() || target.computer !== currentComputer().id || target.id !== currentTerminalId || target.subscription !== terminalSubscription) return;
    send({ t: 'termResize', id: target.id, subscription: target.subscription,
      cols: Number($('terminalCols').value), rows: Number($('terminalRows').value) });
    closeSheet();
  };
}
// Devin: which of its two surfaces the desktop shows (chat.surface). Cursor never sets it.
let currentSurface = null;
function paintSurface() {
  const devin = currentApp === 'devin';
  document.body.classList.toggle('devin', devin);
  $('pickEditor').hidden = !supportsCapability('editor', ['cursor', 'devin', 'codex'].includes(currentApp));
  $('pickAgents').textContent = '项目/会话';
}
function startEditor() {
  const state = capabilityState('editor');
  if (!state.available) return status(state.reason, false);
  clearTimeout(menuRefreshTimer);
  return openComputerFiles(currentComputer().id, { current: true });
}
$('pickEditor').onclick = startEditor;
function showComputerActions(id, app = '') {
  const entry = ovList.find(e => e.id === id);
  const list = ovSt.get(id)?.data?.windows || [];
  const link = computerSockets.get(entry.c.key);
  const catalog = link.metadata.get('agentCatalog')?.agents || [];
  app ||= list.find(w => w.windowId === entry.c.windowId)?.app || list[0]?.app || 'cursor';
  const names = { cursor: 'Cursor', devin: 'Devin', codex: 'Codex', opencode: 'OpenCode' };
  const attr = `data-computer-id="${esc(id)}"`;
  const tabs = Object.entries(names).map(([key, name]) => `<button type="button" class="paramBtn${key === app ? ' cur' : ''}" data-computer-app="${key}" ${attr} aria-pressed="${key === app}">${name}</button>`).join('');
  const projects = list.filter(w => w.app === app);
  const targetAttr = w => `data-computer-target="${esc(JSON.stringify({ computer: id, win: w.win, windowId: w.windowId }))}"`;
  const selected = projects.find(w => w.windowId === entry.c.windowId) || projects[0];
  const service = app === 'opencode' && link.metadata.get('windows')?.list.find(w => w.app === 'opencode');
  const target = app === 'opencode' ? (service ? { win: service.id, windowId: selected?.windowId || '' } : null) : selected;
  const agent = catalog.find(a => a.app === app);
  const missing = `<p class="hint">${esc(I18N.tr(agent?.reason || '请先打开此 Agent'))}</p>${agent?.installed === true && !agent.running && agent.launchSupported ? `<button class="opt" data-computer-launch="${app}" ${attr}>${I18N.tr('启动')} ${names[app]}</button>` : ''}`;
  openSheet('computer-actions', `<h3>${I18N.tr('项目与会话')}</h3><p class="hint">${esc(entry.name)}</p><div class="pSec">${I18N.tr('选择 Agent')}</div><div class="computerAgentTabs">${tabs}</div>${target ? `<button class="opt" data-computer-action ${targetAttr(target)}>${I18N.tr('项目与会话')}</button>` : missing}`);
}
function showComputerFiles() {
  const state = computerFiles, dir = state.directory;
  const field = document.activeElement?.id === 'computerFilePath' ? document.activeElement : null;
  const selection = field && [field.selectionStart, field.selectionEnd];
  const entries = state.roots ? state.roots.map(p => ({ name: p.name, path: p.path, directory: true, selectable: true })) : dir?.entries || [];
  const rows = computerFileEntries(state, entries).map(e => `<button class="opt editorEntry${e.directory ? ' editorFolder' : ''}" data-computer-path="${esc(e.path)}" data-computer-directory="${!!e.directory}" ${e.selectable ? '' : 'disabled'}>${fileEntryIcon(e.directory)}<span class="lbl ovRaw">${esc(e.name)}</span>${e.directory ? '<span class="editorEntryArrow" aria-hidden="true">›</span>' : `<span class="sub">${e.selectable ? fmtSize(e.size) : I18N.tr('不可读取')}</span>`}</button>`).join('');
  const owner = state.project?.owner;
  const context = owner ? ` · Fusion · ${OV_AGENT[owner.app]}` : '';
  const actions = state.project && dir ? '<div class="computerFileActions"><button class="opt" data-computer-project="open">打开此文件夹</button><button class="opt" data-computer-project="chat">在此项目新建会话</button><button class="opt" data-computer-project="new">新建项目并创建会话</button></div>' : '';
  openSheet('computer-files', `<h3>${I18N.tr(state.project ? '选择文件夹' : '打开文件')}</h3><p class="hint ovRaw">${esc(state.computer.name + context)}</p><form id="computerFilePathForm" class="computerFilePath"><input id="computerFilePath" class="ovRaw" aria-label="${I18N.tr('文件路径')}" placeholder="${I18N.tr('输入路径')}" value="${esc(state.path)}" autocomplete="off" autocapitalize="off" spellcheck="false"><button type="button" data-computer-complete title="Tab">${I18N.tr('补全')} ⇥</button><button type="submit">${I18N.tr('前往')}</button></form><div id="computerFileCompletions"></div><div class="computerFileNav"><button type="button" data-computer-path="${esc(dir?.parent ?? '')}" data-computer-directory="true" ${dir?.parent == null ? 'disabled' : ''}>${I18N.tr('返回上一级')}</button><button type="button" data-computer-root>${I18N.tr('根目录')}</button></div><label class="opt computerFileHidden"><span class="lbl">${I18N.tr('不显示隐藏文件和文件夹')}</span><input id="computerFileHideHidden" type="checkbox" role="switch"${state.hideHidden ? ' checked' : ''}><span class="switch${state.hideHidden ? ' on' : ''}" aria-hidden="true"></span></label>${actions}<p id="computerFileStatus" class="hint${state.error ? ' err' : ''}" role="status">${esc(I18N.tr(state.message))}</p>${rows || (!state.message ? `<div class="hint">${I18N.tr('此目录暂无可显示的文件')}</div>` : '')}`);
  $('sheet').scrollTop = state.scroll;
  if (selection) { $('computerFilePath').focus(); $('computerFilePath').setSelectionRange(...selection); }
  else if (state.focusPath) { $('computerFilePath').focus(); state.focusPath = false; }
}
function cancelDocs() {
  docsPending = null;
  finishPending(['正在读取项目文件…']);
}
function agentButton(a) {
  if (batchActive()) {
    if (a.ui) return '';
    const checked = agentBatch.selected.has(a.id);
    return `<button class="opt${checked ? ' cur' : ''}" data-agent-batch-id="${esc(a.id)}" role="checkbox" aria-checked="${checked}" ${a.running || agentBatch.running ? 'disabled' : ''}><span>${checked ? '☑' : '☐'}</span><span class="lbl">${esc(a.title)}</span>${a.running ? '<span class="tag">运行中</span>' : ''}</button>`;
  }
  if (a.loadWindow) return `<button class="opt" data-project-load="${esc(a.loadWindow)}">${esc(a.title)}</button>`;
  const label = a.ui ? esc(a.title) : `<span class="lbl">${esc(a.title)}</span>`;
  const tags = a.running ? '<span class="tag">运行中</span>' : '';
  const main = `<button class="opt ${a.current ? 'cur' : ''}" data-agent="${esc(a.id)}" data-agent-title="${esc(a.title)}">${label}${tags}</button>`;
  if (a.ui || (!String(a.id || '').startsWith('thread:') && !['Cursor', 'Devin'].includes(currentAppName))) return main;
  const favorite = !!a.favorite;
  return `<div class="optRow">${main}<button type="button" class="agentFavBtn${favorite ? ' on' : ''}" data-agent-favorite="${esc(a.id)}" data-agent-favorite-value="${favorite ? '0' : '1'}" title="${favorite ? '取消常用' : '设置为常用'}" aria-label="${favorite ? '取消常用' : '设置为常用'}">${favorite ? '★' : '☆'}</button><button type="button" class="agentMoreBtn" data-agent-menu="${esc(a.id)}" data-agent-menu-title="${esc(a.title)}" title="更多操作" aria-label="更多操作">…</button></div>`;
}
let pendingProjectReveal = null, projectRevealRevision = 0;
for (const event of ['touchstart', 'pointerdown', 'wheel', 'keydown']) $('sheet').addEventListener(event, () => {
  pendingProjectReveal = null;
  projectRevealRevision++;
}, { passive: true });
function revealProjectSessions(button) {
  const key = button.dataset.projectFold;
  if (!key) return;
  pendingProjectReveal = { key, owner: agentListKey() };
  const sheet = $('sheet');
  sheet.scrollTop += button.getBoundingClientRect().top - sheet.getBoundingClientRect().top - 16;
  if (!button.nextElementSibling?.querySelector('[data-project-load]')) pendingProjectReveal = null;
}
function foldSection(name, inner, open, count, key) {
  if (!name) return inner;
  return `<button type="button" class="fold" data-fold data-project-fold="${esc(key)}" aria-expanded="${open ? 'true' : 'false'}"><span class="lbl">${esc(name)}</span><span class="tag">${count}</span><span class="chev">${open ? '▾' : '▸'}</span></button><div class="foldBody"${open ? '' : ' hidden'}>${inner}</div>`;
}
function agentFilterSlider(filters) {
  return `<div class="agentSessionFilter${filters.session === 'common' ? ' common' : ''}" role="group" aria-label="会话筛选">${Object.entries(agentFilterLabels).map(([value, text]) => `<button type="button" aria-pressed="${filters.session === value}" data-agent-filter-value="${value}">${text}</button>`).join('')}</div>`;
}
function showAgentActions(id, title, actions = null, target = null) {
  agentActionTarget = target;
  const current = !target && (agentLists.get(agentListKey()) || []).find(a => a.id === id);
  const codexThread = (target ? target.app === 'codex' : currentAppName === 'Codex') && String(id).startsWith('thread:');
  const favorite = target ? target.favorite : agentFavoriteState(id);
  const fusion = target?.fusion;
  const disabled = target?.off ? ' disabled' : '';
  const nativeDisabled = target?.off || target?.dormant ? ' disabled' : '';
  const rows = [
    current?.current ? '' : `<button class="opt" data-agent-action="open" data-agent-action-id="${esc(id)}" data-agent-action-title="${esc(title)}"${target?.dormant && !target.workspace ? ' disabled' : ''}><span class="lbl">${fusion ? I18N.tr('打开主对话') : '打开会话'}</span></button>`,
    (fusion ? target.resultKey && ['done', 'err'].includes(target.state) : target?.state === 'done') ? '<button class="opt" data-agent-action="read"><span class="lbl">已读</span></button>' : '',
    `<button class="opt" data-agent-action="favorite" data-agent-action-id="${esc(id)}"${disabled}><span class="lbl">${target ? favorite ? '取消收藏' : '收藏' : favorite ? '取消常用' : '设置为常用'}</span></button>`,
    codexThread ? `<button class="opt" data-agent-action="copyLink" disabled aria-busy="${!target?.off}"><span class="lbl">复制会话链接</span></button>` : '',
    ...(actions || (codexThread ? ['rename', 'archive'] : [])).map(action => `<button class="opt" data-agent-action="${action}" data-agent-action-id="${esc(id)}" data-agent-action-title="${esc(title)}"${nativeDisabled}><span class="lbl">${fusion ? I18N.tr(({ tasks: '查看任务', config: '工作台设置', rename: '重命名', stop: '停止工作台', remove: '删除工作台' })[action]) : action === 'rename' ? '重命名' : action === 'delete' ? '删除' : codexThread ? '删除／归档' : '归档'}</span></button>`),
    target?.off ? '<div class="hint">电脑离线，连接后可管理会话</div>' : target?.dormant ? '<div class="hint">项目窗口已关闭，打开对话后可重命名或归档／删除</div>' : actions === null && !codexThread ? '<div class="hint">正在读取会话操作…</div>' : '',
  ].filter(Boolean).join('');
  const owner = (target ? `<div class="hint">${esc(ovCompName(target.comp))} · ${esc(target.projName)} · ${esc(ovAgName(target))}</div>` : '')
    + (fusion && target.removal ? `<div class="hint">${I18N.tr('原生会话清理')} ${target.removal.done}/${target.removal.total}${target.removal.error ? `<br>${esc(target.removal.target.app)} · ${esc(target.removal.target.label || I18N.tr('主 Agent'))}：${esc(I18N.tr(target.removal.error))}` : ''}</div>` : '');
  openSheet('agent-actions', `<h3>${esc(title)}</h3>${owner}${rows || '<div class="hint">没有可用操作。</div>'}`);
  if (codexThread && !target?.off) {
    const requestId = ++agentActionRequest;
    const copyTarget = target || { comp: currentComputer().id, win: 'codex', windowId: id.split(':')[1], threadId: agentThreadKey({ id }, 'codex') };
    const active = () => sheetKind === 'agent-actions' && agentActionTarget === target && agentActionRequest === requestId;
    ovSessionRequest(copyTarget, 'copyLink').then(value => {
      if (!active()) return;
      const button = $('sheet').querySelector('[data-agent-action="copyLink"]');
      button.dataset.copyLink = value.text;
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }).catch(error => {
      if (!active()) return;
      $('sheet').querySelector('[data-agent-action="copyLink"]').removeAttribute('aria-busy');
      $('sheet').insertAdjacentHTML('beforeend', `<div class="hint">${esc(error.message)}</div>`);
    });
  }
  if (actions === null && !codexThread && !target?.off && !target?.dormant) {
    if (target) {
      const requestId = ++agentActionRequest;
      const active = () => sheetKind === 'agent-actions' && agentActionTarget === target && agentActionRequest === requestId;
      ovSessionRequest(target, 'actions').then(message => {
        if (active()) showAgentActions(id, title, message.actions, target);
      }).catch(error => {
        if (!active()) return;
        showAgentActions(id, title, [], target);
        $('sheet').insertAdjacentHTML('beforeend', `<div class="hint">${esc(error.message)}</div>`);
      });
      return;
    }
    pendingAgentActions = { id, title, requestId: ++agentActionRequest };
    send({ t: 'sessionActions', id, requestId: agentActionRequest });
  }
}
function receiveAgentActions(message) {
  if (agentActionTarget || sheetKind !== 'agent-actions' || message.app !== currentApp || message.requestId !== agentActionRequest) return;
  if (pendingAgentActions?.id === message.id) showAgentActions(message.id, pendingAgentActions.title, message.actions);
}
function renderAgentList() {
  const list = agentLists.get(agentListKey());
  if (list) showAgents(list);
  else openAgentList();
}
function showAgents(list) {
  const currentThread = agentThreadKey({ id: currentComputer()?.threadId });
  list = list.map(a => ({ ...a, current: a.ui ? a.current : !!currentThread && agentThreadKey(a) === currentThread,
    window: cleanWindowTitle(a.window), group: cleanWindowTitle(a.group), title: cleanWindowTitle(a.title) }));
  const keep = sheetKind === 'agents';
  const scroll = keep ? $('sheet').scrollTop : 0;
  const revision = projectRevealRevision;
  const opened = keep ? new Set([...$('sheet').querySelectorAll('button.fold[aria-expanded="true"]')].map(n => n.dataset.projectFold)) : null;
  const newest = items => Math.max(0, ...items.map(a => a.lastUsed || 0));
  const filters = currentAgentFilters();
  list = list.map(agentUsageInfo)
    .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  const order = [];
  const byWindow = new Map();
  for (const a of list) {
    const win = a.window || '';
    if (!byWindow.has(win)) { byWindow.set(win, []); order.push(win); }
    byWindow.get(win).push(a);
  }
  order.sort((a, b) => newest(byWindow.get(b)) - newest(byWindow.get(a)));
  const anyCurrent = list.some(a => a.current);
  let firstVisible = true;
  const rows = order.map(win => {
    const items = byWindow.get(win);
    const visible = items.filter(a => a.ui || filters.session === 'all' || a.common === (filters.session === 'common'));
    if (filters.session !== 'all' && !visible.some(a => !a.ui)) return '';
    if (!visible.length) return '';
    const loose = [];
    const groups = [];
    for (const a of visible) {
      if (!a.group) { loose.push(a); continue; }
      let g = groups.find(x => x.name === a.group);
      if (!g) groups.push(g = { name: a.group, items: [] });
      g.items.push(a);
    }
    loose.sort((a, b) => Number(!!b.ui) - Number(!!a.ui));
    groups.sort((a, b) => newest(b.items) - newest(a.items));
    const body = loose.map(agentButton).join('') + groups.map(g => foldSection(
      g.name, g.items.map(agentButton).join(''), opened ? opened.has(JSON.stringify([win, g.name])) : g.items.some(a => a.current), g.items.length, JSON.stringify([win, g.name]),
    )).join('');
    if (!win) return body;
    const key = JSON.stringify([win]);
    const open = opened ? opened.has(key) : items.some(a => a.current) || (!anyCurrent && firstVisible);
    firstVisible = false;
    return foldSection(win, body, open, visible.length, key);
  }).join('');
  const batch = batchActive();
  const progress = batch && agentBatch.progress;
  const manage = batch ? `<button class="opt" data-agent-batch="select" ${agentBatch.running ? 'disabled' : ''}>全选当前筛选结果</button><button class="opt" data-agent-batch="remove" ${!agentBatch.selected.size || agentBatch.running ? 'disabled' : ''}>删除／归档所选会话（${agentBatch.selected.size}）</button><button class="opt" data-agent-batch="${agentBatch.running ? 'cancel' : 'exit'}">${agentBatch.running ? '取消剩余操作' : '完成管理'}</button>${progress ? `<div class="hint">已处理 ${progress.results.length}/${progress.total}${progress.cancelled ? ' · 已取消' : ''}${progress.results.filter(r => !r.ok).map(r => `<p>${esc((list.find(a => a.id === r.id)?.title || r.id) + '：' + r.error)}</p>`).join('')}</div>` : ''}` : '<button class="opt" data-agent-batch="start">批量管理会话</button>';
  const html = `<div class="agentSheetTitle"><h3>项目与会话</h3>${agentFilterSlider(filters)}</div>${batch ? '' : '<button class="opt" data-act="agentsRefresh">刷新项目与会话</button><button class="opt" data-act="projects"><span class="lbl">选择文件夹／新建项目</span></button><button class="opt" data-act="projectNewChat"><span class="lbl">在当前项目新建会话</span></button><button class="opt" data-project-windows>项目窗口</button>'}${manage}${rows || `<div class="hint">${esc(appMessage('没有找到 {app} 的 Agent。请在电脑上打开对应的会话窗口。'))}</div>`}`;
  if (keep) {
    const template = document.createElement('template');
    template.innerHTML = html;
    const old = [...$('sheet').children];
    syncChildren($('sheet'), [...template.content.children].map(node => old.find(el => el.outerHTML === node.outerHTML) || node));
  } else openSheet('agents', html);
  if (keep) requestAnimationFrame(() => {
    if (sheetKind !== 'agents' || revision !== projectRevealRevision) return;
    const target = pendingProjectReveal?.owner === agentListKey() && [...$('sheet').querySelectorAll('[data-project-fold]')].find(b => b.dataset.projectFold === pendingProjectReveal.key && b.getAttribute('aria-expanded') === 'true');
    if (target) revealProjectSessions(target);
    else { pendingProjectReveal = null; $('sheet').scrollTop = scroll; }
  });
}
$('sheet').addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (sheetKind === 'main' && b.dataset.startView) {
    store.set('start-view', b.dataset.startView);
    const slider = b.closest('.agentSessionFilter');
    slider.classList.toggle('common', b.dataset.startView === 'conversation');
    slider.querySelectorAll('[data-start-view]').forEach(option => option.setAttribute('aria-pressed', String(option === b)));
    return;
  }
  if (sheetKind === 'project-windows') {
    const change = { ...(b.dataset.windowKey ? { window: b.dataset.windowKey } : {}) };
    for (const field of ['enabled', 'owned', 'keep']) if (b.hasAttribute('data-window-' + field)) change[field] = b.getAttribute('data-window-' + field) === '1';
    return send({ t: 'projectWindowSet', change });
  }
  if (sheetKind !== 'agents') return;
  if (b.hasAttribute('data-project-windows')) return send({ t: 'projectWindows' });
  if (b.dataset.agentBatch) {
    const act = b.dataset.agentBatch;
    if (act === 'start') agentBatch = { key: agentListKey(), selected: new Set(), running: false };
    if (act === 'exit') agentBatch = null;
    if (act === 'select') {
      agentBatch.selected.clear();
      for (const row of (agentLists.get(agentListKey()) || []).map(agentUsageInfo))
        if (!row.ui && !row.running && (currentAgentFilters().session === 'all' || row.common)) agentBatch.selected.add(row.id);
    }
    if (act === 'cancel') send({ t: 'sessionBatchCancel', requestId: agentBatch.requestId });
    if (act === 'remove') {
      if (!await ask(`删除或归档所选 ${agentBatch.selected.size} 个会话？\n逐条执行桌面端支持的操作，成功后无法通过取消恢复。`, '继续')) return;
      agentBatch.requestId = String(Date.now());
      agentBatch.running = true;
      if (!send({ t: 'sessionBatch', ids: [...agentBatch.selected], requestId: agentBatch.requestId })) agentBatch.running = false;
    }
    return renderAgentList();
  }
  if (b.dataset.agentBatchId && batchActive() && !agentBatch.running) {
    const id = b.dataset.agentBatchId;
    if (agentBatch.selected.has(id)) agentBatch.selected.delete(id); else agentBatch.selected.add(id);
    return renderAgentList();
  }
  if (b.dataset.agentFavorite) {
    setAgentFavorite(b.dataset.agentFavorite, b.dataset.agentFavoriteValue === '1');
    return;
  }
  if (b.dataset.agentMenu) {
    showAgentActions(b.dataset.agentMenu, b.dataset.agentMenuTitle || '会话操作');
    return;
  }
  if (b.dataset.agentFilterValue) {
    setAgentFilter(b.dataset.agentFilterValue);
    return renderAgentList();
  }
});
$('title').onclick = () => {
  if (document.body.matches('.split')) return openAgentList();
  send({ t: 'windows' }); showWindows();
};

const MENU_TITLE = { effort: '选择思考强度', mode: '选择模式', model: '选择模型', history: '历史对话', permission: '权限', 'codex-run': '执行位置', 'codex-chat': '会话操作', 'fusion-lead': 'Fusion Lead', 'fusion-effort': 'Fusion Effort', 'fusion-sidekick': 'Fusion Sidekick' };
const PERM_LABEL = {
  'Ask for approval': ['每次询问', '改外部文件和上网前都会询问'],
  'Approve for me': ['代为批准', '只在可能不安全时询问'],
  'Full access': ['完全访问', '可以访问网络和这台电脑上的文件'],
};
function modelPricingHtml(pricing, details = false) {
  if (!pricing) return '';
  const lines = [];
  if (pricing.tag && !Number.isFinite(pricing.creditMultiplier)) lines.push(`${/^\$+$/.test(pricing.tag) ? '相对成本' : '计费方式'}：${pricing.tag}`);
  if (Number.isFinite(pricing.creditMultiplier)) lines.push(`积分倍率：×${pricing.creditMultiplier}`);
  for (const c of pricing.costs || []) {
    if (!Number.isFinite(c.value)) continue;
    const label = ({ Input: '输入', 'Cached input': '缓存输入', Output: '输出' })[c.label] || c.label;
    const value = c.unit ? String(parseFloat(c.value.toFixed(3))) + ' ' + c.label : '$' + parseFloat(c.value.toFixed(2));
    lines.push(`${label}：${c.fuzzy ? '约 ' : ''}${value}${c.denominator ? ' / ' + c.denominator : ''}`);
  }
  if (details) lines.push(...new Set((pricing.costs || []).map(c => c.info).filter(Boolean)));
  return lines.length ? `<span class="modelPricing">${lines.map(line => `<span class="sub">${esc(line)}</span>`).join('')}</span>` : '';
}
function sortedEfforts(items) {
  const ranks = { none: 0, minimal: 1, light: 2, low: 3, medium: 4, high: 5, xhigh: 6, 'extra high': 6, max: 7, ultra: 8, persistent: 9, '无': 0, '低': 3, '中': 4, '高': 5, '很高': 6, '最大': 7, '最高': 8 };
  const rank = it => ranks[String(it.label).trim().toLowerCase()] ?? 100;
  return [...items].sort((a, b) => rank(a) - rank(b));
}
function fusionBlock(fusion) {
  if (!fusion) return '';
  const row = (part, title, value) => `<button class="opt" data-fusion="${part}"><span class="lbl">${title}<span class="sub">${esc(value || '')}</span></span></button>`;
  return `<div class="pSec">Fusion</div>${row('lead', 'Lead', fusion.lead)}${row('effort', 'Lead 思考强度', fusion.effort)}${row('sidekick', 'Sidekick', fusion.sidekick)}`
    + (fusion.fastSupported ? `<button class="opt" data-fusion="fast"><span class="lbl">Fast Mode</span><span class="switch ${fusion.fast ? 'on' : ''}"></span></button>` : '')
    + '<div class="hint">Lead 负责规划和关键判断，Sidekick 负责具体执行。</div>'
    + (fusion.pricing ? `<div class="pSec">当前配置成本</div><div class="hint" data-fusion-cost>${modelPricingHtml(fusion.pricing, true)}</div>` : '');
}
// Devin's permission modes: the desktop's own description, plus a Chinese one when the app is in Chinese.
const MODE_ZH = { Code: '写代码、改文件，正常提问', Smart: '模型判断安全的操作自动批准', Ask: '只回答问题，不改代码', Plan: '先做方案，再动手', 'Bypass Permissions': '自动批准所有工具调用（不再询问）' };
const modeDesc = it => (I18N.lang === 'zh' && MODE_ZH[it.label]) || it.desc;
const menuCacheKey = kind => `${currentApp}|${viewSel}|${kind}`;
function requestMenu(kind, loadingMsg) {
  clearTimeout(menuRefreshTimer);
  if (kind === 'model' || kind === 'effort') {
    const state = capabilityState(kind);
    if (!state.available) return status(state.reason, false);
  }
  const cached = menuCache.get(menuCacheKey(kind));
  if (cached) {
    menuRequest++;
    showMenu(kind, cached.items, cached.max, cached.fusion, cached.fast, cached.model, true, cached.pricing);
    menuRefreshTimer = setTimeout(() => send({ t: 'openMenu', kind }), 150);
  } else {
    status(loadingMsg);
    menuSheetKind = kind;
    openSheet('menu', `<h3>${MENU_TITLE[kind] || ''}</h3><p class="hint" role="status">${esc(I18N.tr(loadingMsg))}</p>`);
    if (!send({ t: 'openMenu', kind })) closeSheet();
  }
}
function showMenuError(kind, message) {
  menuSheetKind = kind;
  openSheet('menu', `<h3>${MENU_TITLE[kind] || ''}</h3><p class="hint" role="alert">${esc(I18N.tr(message))}</p>`);
  status(message, false);
}
function showMenu(kind, items, max, fusion, fast, model, refreshing, pricing) {
  finishPending(['读取思考强度…', '读取权限…', '读取模式列表…', '读取模型列表…', '读取历史对话…', '设置中…']);
  menuSheetKind = kind;
  const picking = /^fusion-(lead|effort|sidekick)$/.test(String(kind || ''));
  if (kind === 'effort' || kind === 'fusion-effort') items = sortedEfforts(items || []);
  if (!items?.length && !fusion && kind !== 'effort') return showMenuError(kind, appMessage('菜单是空的，可能 {app} 版本不同'));
  status('');
  const maxRow = typeof max === 'boolean'
    ? `<button class="opt" data-max><span class="lbl">MAX Mode<span class="sub">更大上下文、更贵</span></span><span class="switch ${max ? 'on' : ''}"></span></button>` : '';
  const part = picking ? kind.slice(7) : '';
  const rows = (items || []).map(it => {
    const perm = kind === 'permission' ? PERM_LABEL[it.label] : null;
    const effort = kind === 'effort' ? { low: '低', medium: '中', high: '高', xhigh: '很高', ultra: '最高', max: '最大', 'extra high': '很高' }[it.label.toLowerCase()] : '';
    const shown = perm ? `${esc(perm[0])}<span class="sub">${esc(perm[1])}</span>` : effort ? `${esc(effort)} · ${esc(it.label)}` : esc(it.label);
    const pick = picking
      ? `<button class="opt ${it.checked ? 'cur' : ''}" data-fusion-pick="${esc(part)}" data-label="${esc(it.label)}"><span class="lbl">${esc(it.label)}${modelPricingHtml(it.pricing, it.checked)}</span></button>`
      : `<button class="opt ${it.checked ? 'cur' : ''}" data-kind="${kind}" data-label="${esc(it.label)}"><span class="lbl">${shown}${it.desc ? `<span class="sub">${esc(modeDesc(it))}</span>` : ''}${modelPricingHtml(it.pricing, it.checked)}</span>${it.label === 'Bypass Permissions' ? '<span class="tag" style="color:var(--warn)">⚠</span>' : ''}</button>`;
    return it.params ? `<div class="optRow">${pick}<button class="paramBtn" data-params="${esc(it.id)}" data-plabel="${esc(it.label)}">参数</button></div>` : pick;
  }).join('');
  const agentRow = '';
  const fastRow = supportsCapability('fast') && fast && !fusion ? `<button class="opt" data-fast="${fast.on ? 'off' : 'on'}" data-fast-menu="${kind}"><span class="lbl">Fast 模式${fast.description ? `<span class="sub">${esc(fast.description)}</span>` : ''}</span><span class="switch ${fast.on ? 'on' : ''}"></span></button>` : '';
  const effortState = capabilityState('effort');
  const effortEntry = kind === 'model' && !fusion && supportsCapability('effort') ? `<button class="opt" data-effort-open ${effortState.available ? '' : 'disabled'}><span class="lbl">思考强度<span class="sub">${esc(effortState.reason || lastChat?.effort || '')}</span></span></button>` : '';
  const navigation = picking ? '<button class="opt" data-model-back>← 返回模型配置</button>' : kind === 'effort' ? `<button class="opt" data-model-back>← 返回模型列表</button><p>${esc(model || lastChat?.model || '')}</p>${!items?.length ? '<p class="hint">这个模型没有可选的思考强度。</p>' : ''}` : '';
  const done = kind === 'effort' && currentApp !== 'cursor' ? '<button class="opt" data-model-done>完成</button>' : '';
  const priceSummary = kind === 'effort' && pricing && !items?.length ? `<div class="hint">${modelPricingHtml(pricing, true)}</div>` : '';
  openSheet('menu', `<h3>${MENU_TITLE[kind] || ''}${refreshing ? ' <span class="hint">更新中…</span>' : ''}</h3>` + navigation + agentRow + (picking ? '' : fusionBlock(fusion)) + effortEntry + fastRow + maxRow + rows + priceSummary + done);
}

let changeFiles = [];
function showChanges(m) {
  changeFiles = m.files;
  finishPending(['正在撤销…', '正在保留…', '处理中…']);
  status('');
  if (!m.files.length && m.devin && m.count) {
    return openSheet('changes', `<h3>Agent 改动的文件（${m.count}）</h3><div class="hint">这个界面里读不到逐个文件的改动。切到 Agent 界面可以看到完整列表。</div>`);
  }
  if (!m.files.length) { if (sheetKind === 'changes') closeSheet(); return status('没有待处理的改动'); }
  openSheet('changes', `<h3>${m.historical ? '会话修改记录' : 'Agent 改动的文件'}（${m.files.length}）</h3>`
    + (m.actions.length ? `<div class="pRow" style="margin-bottom:10px">${m.actions.map(a => `<button data-chbar="${esc(a)}">${esc(a)}</button>`).join('')}</div>` : '')
    + m.files.map((f, i) => `<div class="optRow"><button class="opt" data-chopen="${esc(f.name)}"><span class="lbl">${esc(f.name)}`
      + `<span class="sub"><span class="add">${esc(f.add)}</span> <span class="del">${esc(f.del)}</span></span></span></button>`
      + (m.codex || m.historical ? '' : `<button class="paramBtn" data-ch="${i}" data-name="${esc(f.name)}" data-act2="keep">保留</button>`)
      + (m.codex || m.historical ? '' : `<button class="paramBtn" data-ch="${i}" data-name="${esc(f.name)}" data-act2="undo">撤销</button>`) + '</div>').join('')
    + `<div class="hint">${m.historical ? '点文件名查看当前内容。这里显示会话中的修改记录。' : m.codex ? '点文件名查看内容。操作范围与 Codex 原生按钮一致。' : '点文件名查看内容。「保留」接受这个文件的改动，「撤销」把它恢复成改动前的样子。'}</div>`);
}

function showParams(m) {
  finishPending(['读取模型参数…', '设置中…']);
  status('');
  openSheet('params', `<h3>${esc(m.label || '模型')} 参数</h3>` + m.sections.map(s => `<div class="pSec">${esc(s.title)}</div><div class="pRow">`
    + (/effort|reasoning|thinking|思考|推理/i.test(s.title) ? sortedEfforts(s.items) : s.items).map(it => `<button class="${it.checked ? 'on' : ''} ${it.toggle ? 'tg' : ''}" data-model="${esc(m.model)}" data-plabel="${esc(m.label)}" data-section="${esc(s.title)}" data-value="${esc(it.label)}">${esc(it.label)}${it.toggle ? (it.checked ? '：开' : '：关') : ''}</button>`).join('')
    + '</div>').join('') + `<div class="hint">${esc(appMessage('改动会直接应用到电脑上 {app} 的这个模型。'))}</div>`);
}

const listManagement = { kind: '', owner: '', editing: false, selected: new Set() };
let pairedDevices = [];
let pendingEntries = [], deviceInvitation = null, deviceListTimer = 0, deviceListGeneration = 0, deviceInviteGeneration = 0;
let deviceRemoval = [], removingDevices = false;
function prepareListManagement(kind) {
  const owner = kind === 'devices' ? currentComputer()?.key || '' : '';
  if (listManagement.kind !== kind || listManagement.owner !== owner) {
    Object.assign(listManagement, { kind, owner, editing: false, selected: new Set() });
    if (kind === 'devices') { pairedDevices = []; pendingEntries = []; deviceInvitation = null; deviceRemoval = []; deviceInviteGeneration++; }
  }
}
function listTools() {
  const m = listManagement;
  if (!m.editing) return `<button data-list-action="manage">管理</button>${m.kind === 'computers' ? '<button data-list-action="new-group">新建分组</button>' : ''}`;
  return `<button data-list-action="all">全选</button><button data-list-action="clear">取消选择</button><button data-list-action="done">完成</button><span class="hint">${I18N.tr('已选择 {n} 项').replace('{n}', m.selected.size)}</span>`
    + `<button data-list-action="group" ${m.selected.size ? '' : 'disabled'}>${m.kind === 'devices' ? '归入设备' : '移至分组'}</button>`
    + (m.kind === 'computers' ? '<button data-list-action="new-group">新建分组</button>' : '')
    + `<button class="danger" data-list-action="delete" ${m.selected.size ? '' : 'disabled'}>${m.kind === 'devices' ? '批量移除' : '批量删除'}</button>`;
}
function listCheckbox(id) {
  return `<input type="checkbox" data-list-select="${esc(id)}" aria-label="${I18N.tr('选择')}" ${listManagement.selected.has(id) ? 'checked' : ''}>`;
}
function renderManagedList() {
  listManagement.kind === 'computers' ? showComputers() : renderDevices();
}
$('sheet').addEventListener('change', e => {
  const input = e.target.closest('[data-list-select]');
  if (!input) return;
  input.checked ? listManagement.selected.add(input.dataset.listSelect) : listManagement.selected.delete(input.dataset.listSelect);
  $('sheet').querySelector('.listTools').innerHTML = listTools();
});
function handleListAction(action) {
  const m = listManagement;
  if (action === 'manage') m.editing = true;
  else if (action === 'done') { m.editing = false; m.selected.clear(); }
  else if (action === 'clear') m.selected.clear();
  else if (action === 'all') m.selected = new Set(m.kind === 'computers' ? loadComputers().map(c => c.key) : pairedDevices.filter(d => !d.current).map(d => d.id));
  else if (action === 'delete') return m.kind === 'computers' ? removeComputers([...m.selected]) : removePairedDevices([...m.selected]);
  else if (action === 'group') return m.kind === 'devices' ? showDeviceGroupPicker() : showComputerGroupPicker();
  else if (action === 'new-group') return editComputerGroup();
  renderManagedList();
}
async function showDevices(refresh = false) {
  clearTimeout(deviceListTimer);
  prepareListManagement('devices');
  const generation = ++deviceListGeneration, owner = currentComputer()?.key;
  if (!refresh) renderDevices();
  try {
    const r = await api('/api/devices');
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || '读取设备失败');
    if (generation !== deviceListGeneration || owner !== currentComputer()?.key || sheetKind !== 'devices') return;
    const changed = JSON.stringify([pairedDevices, pendingEntries]) !== JSON.stringify([body.devices, body.requests]);
    pairedDevices = body.devices; pendingEntries = body.requests;
    const ids = new Set(pairedDevices.filter(d => !d.current).map(d => d.id));
    listManagement.selected = new Set([...listManagement.selected].filter(id => ids.has(id)));
    if (changed) renderDevices();
  } catch (error) { if (!refresh) status(error.message, false); }
  if (sheetKind === 'devices' && owner === currentComputer()?.key) deviceListTimer = setTimeout(() => {
    if (sheetKind === 'devices' && !document.hidden) showDevices(true);
  }, 2000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && sheetKind === 'devices') showDevices(true); });
function deviceGroups() {
  const groups = new Map();
  for (const d of pairedDevices) {
    if (!groups.has(d.groupId)) groups.set(d.groupId, { id: d.groupId, name: d.groupName, entries: [] });
    groups.get(d.groupId).entries.push(d);
  }
  return [...groups.values()].sort((a, b) => Number(b.entries.some(d => d.current)) - Number(a.entries.some(d => d.current)));
}
function drawEntryQr(modules) {
  const canvas = $('entryInviteQr');
  if (!canvas || !Array.isArray(modules) || !modules.length) return;
  drawQrModules(canvas, modules);
}
function renderDevices() {
  const when = t => new Date(t).toLocaleDateString();
  const scroll = $('sheet').querySelector('.deviceRows')?.scrollTop || 0;
  const confirmation = deviceRemoval.length ? `<div class="hint">${esc(`移除「${pairedDevices.filter(d => deviceRemoval.includes(d.id)).map(d => d.name).join('、')}」？它们会立即断开，要重新配对才能再用。`)}</div><div class="askBtns"><button data-device-remove-cancel>取消</button><button class="danger" data-device-remove-confirm>移除</button></div>` : '';
  const opened = new Map([...$('sheet').querySelectorAll('[data-device-group]')].map(el => [el.dataset.deviceGroup, el.open]));
  const invitation = deviceInvitation?.expires > Date.now() ? `<div class="entryInvite"><div class="hint">扫描二维码或打开此链接，再核对下方出现的验证码。10 分钟内有效，不要发给陌生人。</div><div class="entryInviteContent"><canvas id="entryInviteQr" class="entryInviteQr" aria-label="入口授权二维码"></canvas><div class="entryInviteText"><textarea id="entryInviteLink" readonly aria-label="入口授权链接">${esc(deviceInvitation.link)}</textarea><button data-entry-copy>复制授权链接</button></div></div></div>` : '';
  const requests = pendingEntries.map(r => `<div class="entryRequest"><strong>新入口请求 · ${esc(r.name)}</strong><div class="sub">入口 ${esc(r.origin || '未提供来源')} · 归入 ${esc(r.groupName)} · 验证码 <b>${esc(r.code)}</b></div><div class="hint">请与新浏览器显示的验证码核对，确认是你的入口。</div><div class="askBtns"><button data-entry-decide="${esc(r.id)}" data-code="${esc(r.code)}" data-approve="false">拒绝</button><button data-entry-decide="${esc(r.id)}" data-code="${esc(r.code)}" data-approve="true">同意</button></div></div>`).join('');
  openSheet('devices', `<div class="deviceHead"><h3>已配对设备</h3><div class="listTools" ${removingDevices ? 'inert' : ''}>${listTools()}</div>${removingDevices ? '<div class="hint">正在移除入口…</div>' : confirmation}</div><div class="deviceRows" ${removingDevices ? 'inert' : ''}>${invitation}${requests}` + deviceGroups().map(g => `<details class="deviceGroup" data-device-group="${esc(g.id)}" ${(opened.get(g.id) ?? g.entries.some(d => d.current)) ? 'open' : ''}><summary>${esc(g.name)}<span class="sub">${g.entries.length} 个入口</span></summary><div class="listTools"><button data-entry-invite="${esc(g.id)}">添加入口</button>${listManagement.editing ? `<button data-device-group-rename="${esc(g.id)}">重命名设备</button>` : ''}${g.entries.some(d => d.current) ? '' : `<button data-device-group-remove="${esc(g.id)}">移除设备</button>`}</div>` + g.entries.map(d => `
    <${listManagement.editing && !d.current ? 'label' : 'div'} class="opt static ${d.current ? 'cur' : ''}">${listManagement.editing && !d.current ? listCheckbox(d.id) : ''}<span class="lbl">${esc(d.entryName)}<span class="sub">${d.current ? '当前入口 · ' : ''}入口码 ${esc(d.id)} · 配对于 ${when(d.created)} · 最近使用 ${when(d.lastSeen)}</span></span>
    ${d.current || listManagement.editing ? '' : `<button data-remove="${esc(d.id)}" data-name="${esc(d.name)}">移除</button>`}</${listManagement.editing && !d.current ? 'label' : 'div'}>`).join('')
    + '</details>').join('') + '<div class="hint">有明确归属标识的入口会自动归组；同名但没有共同标识的旧入口仍分开展示。各入口授权独立。<br>添加新设备：在电脑上运行 npm run pair。<br>开启 Authenticator 二次验证：npm run 2fa。</div></div>');
  $('sheet').querySelector('.deviceRows').scrollTop = scroll;
  drawEntryQr(deviceInvitation?.qr);
}
async function inviteDeviceEntry(groupId) {
  const owner = currentComputer()?.key, generation = ++deviceInviteGeneration;
  const current = () => generation === deviceInviteGeneration && owner === currentComputer()?.key && sheetKind === 'devices';
  try {
    const currentLink = new URL(location.pathname, location.origin);
    const r = await post('/api/entries/invite', { groupId, base: currentLink.href }), body = await r.json();
    if (!current()) return;
    if (!r.ok) throw new Error(body.error || '生成授权链接失败');
    currentLink.hash = `entry=${owner}.${body.invitation}`;
    const link = body.link || currentLink.href;
    deviceInvitation = { link, qr: body.qr, expires: body.expires };
    if (sheetKind === 'devices') renderDevices();
  } catch (error) { if (current()) status(error.message, false); }
}
async function decideDeviceEntry(button) {
  button.closest('.entryRequest').querySelectorAll('button').forEach(b => { b.disabled = true; });
  try {
    const r = await post('/api/entries/decide', { id: button.dataset.entryDecide, code: button.dataset.code, approve: button.dataset.approve === 'true' });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || '授权失败');
  } catch (error) { status(error.message, false); }
  if (sheetKind === 'devices') showDevices(true);
}
function showDeviceGroupPicker() {
  openSheet('device-group-picker', '<h3>归入设备</h3><div class="hint">只合并属于同一设备的入口；每个入口的凭据和撤销仍独立。</div>' + deviceGroups().map(g => `<button class="opt" data-device-group-target="${esc(g.id)}">${esc(g.name)}</button>`).join('') + '<button class="opt" data-device-group-new>新建设备分组</button><button class="opt" data-act="devices">返回</button>');
}
async function moveDeviceEntries(groupId = '', name = '', ids = [...listManagement.selected]) {
  try {
    const r = await post('/api/devices/group', { ids, groupId, name });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || '归组失败');
    listManagement.selected.clear();
    await showDevices();
  } catch (error) { status(error.message, false); }
}
async function removePairedDevices(ids, confirmed = false) {
  const selected = pairedDevices.filter(d => !d.current && ids.includes(d.id));
  if (!selected.length) return;
  if (!confirmed) { deviceRemoval = selected.map(d => d.id); return renderDevices(); }
  deviceRemoval = []; removingDevices = true; renderDevices();
  const results = await Promise.allSettled(selected.map(async d => {
    const r = await post('/api/devices/remove', { id: d.id });
    if (!r.ok) throw new Error('移除设备失败');
    pairedDevices = pairedDevices.filter(item => item.id !== d.id);
    listManagement.selected.delete(d.id);
  }));
  removingDevices = false;
  const failed = results.find(r => r.status === 'rejected');
  if (failed) status(failed.reason.message, false);
  if (sheetKind === 'devices') renderDevices();
}

function fileEntryIcon(folder) {
  return `<svg class="editorEntryIcon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${folder ? '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/>' : '<path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h4M9 12h6M9 16h6"/>'}</svg>`;
}
function showDocs(m) {
  if (!docsPending || m.requestId !== docsPending.id || docsPending.sel !== viewSel || docsPending.computer !== (currentComputer()?.id || '')) return;
  docsPending = null;
  finishPending(['正在读取项目文件…']);
  return receiveCurrentFiles(m);
}
function projectSheet(kind, html, owner) {
  if (owner) projectEntry = null;
  openSheet(kind, owner ? `<div data-project-context="${esc(JSON.stringify(owner))}">${html}</div>` : html);
}
function projectSheetOwner(element = $('sheet')) {
  const owner = element.closest('[data-project-context]') || element.querySelector('[data-project-context]');
  return owner ? JSON.parse(owner.dataset.projectContext) : null;
}
function sendProjectAction(message, owner) {
  return owner ? fusionProjectAction(message, owner) : send(message);
}
function openProjectPicker() {
  if (projectEntry?.source === 'computer') {
    status('正在读取项目…');
    return send({ t: 'projects' });
  }
  return openComputerFiles(currentComputer().id, { current: true, project: { owner: null } });
}
function openPickedProject(message, owner) {
  if (projectEntry?.source === 'computer') ovShowConversation();
  closeSheet(); status('正在打开项目…');
  return sendProjectAction(message, owner);
}
function showProjectTrust(m, owner = null) {
  projectSheet('project-trust', `<h3>信任此项目？</h3><p class="hint">信任后，Agent 和扩展可运行此项目的代码。只信任你了解来源的项目。</p><p>${esc(m.path)}</p><button class="opt" data-project-trust="yes">信任此项目</button><button class="opt" data-project-trust="no">保持限制模式并返回上次对话</button>`, owner);
}
function showProjects(m, owner = null) {
  if (m.browsing) return openProjectFolders(m.path, owner);
  const context = owner ? `<p class="hint">${esc(ovCompName(owner.computer))} · Fusion · ${esc(OV_AGENT[owner.app])}</p>`
    : projectEntry ? `<p class="hint">${esc(currentComputer().name)} · ${esc(currentAppName)}</p>` : '';
  const rows = (m.recent || []).map(p => `<div class="optRow"><button class="opt" data-open="${esc(p.path)}"><span class="lbl">${esc(p.name)}<span class="sub">${esc(p.path)}</span></span></button><button class="opt computerProjectNew" data-project-chat="${esc(p.path)}">${I18N.tr('新建会话')}</button></div>`).join('');
  projectSheet('projects', `<h3>打开项目</h3>${context}<div class="projectBrowserTools"><button class="opt" data-project-browse="${esc(m.path)}"><span class="lbl">浏览文件夹</span></button><button class="opt" data-project-path="${esc(m.path)}"><span class="lbl">输入文件夹路径</span></button></div>${rows || '<div class="hint">还没有最近打开的本地项目。</div>'}`, owner);
}
function showCodexSettings(m) {
  const button = c => `<button class="paramBtn ${c.on || c.current ? 'cur' : ''}" data-codex-setting="${esc(c.id)}" ${c.disabled ? 'disabled' : ''}>${esc(c.label)}</button>`;
  const nav = `<div class="codexSettingsNav">${(m.nav || []).map(button).join('')}</div>`;
  const choices = m.choices?.length ? `<div class="pSec">选项</div>${m.choices.map(c => `<button class="opt ${c.on ? 'cur' : ''}" data-codex-setting="${esc(c.id)}"><span class="lbl">${esc(c.label)}</span></button>`).join('')}` : '';
  const rows = (m.rows || []).map(row => {
    const sw = row.controls.find(c => c.role === 'switch');
    const detail = row.detail ? `<div class="hint">${esc(row.detail)}</div>` : '';
    if (sw) return `<button class="opt" data-codex-setting="${esc(sw.id)}" ${sw.disabled ? 'disabled' : ''}><span class="lbl">${esc(row.label)}</span><span class="switch ${sw.on ? 'on' : ''}"></span></button>`;
    return `<div class="pSec">${esc(row.label)}</div>${detail}<div class="paramRow">${row.controls.map(button).join('')}</div>`;
  }).join('');
  const instructions = m.instructions ? `<div class="pSec">Codex instructions</div><textarea id="codexInstructions" rows="9" style="width:100%;box-sizing:border-box" ${m.instructions.disabled ? 'disabled' : ''}>${esc(m.instructions.value)}</textarea><button class="opt" data-save-instructions ${m.instructions.disabled ? 'disabled' : ''}>保存指令</button>` : '';
  const fields = (m.fields || []).map(f => `<label class="pSec">${esc(f.label)}</label>${f.type === 'select' ? `<select data-codex-field="${esc(f.id)}" ${f.disabled ? 'disabled' : ''}>${f.options.map(o => `<option value="${esc(o.value)}" ${o.value === f.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>` : f.type === 'textarea' ? `<textarea data-codex-field="${esc(f.id)}" ${f.disabled ? 'disabled' : ''}>${esc(f.value)}</textarea>` : `<input data-codex-field="${esc(f.id)}" type="${esc(f.type)}" aria-label="${esc(f.label)}" value="${esc(f.value)}" ${f.disabled ? 'disabled' : ''}>`}`).join('');
  const extras = (m.extra || []).map(button).join('');
  const summary = m.summary ? `<div class="hint">${esc(m.summary)}</div>` : '';
  openSheet('codex-settings', `<h3>Codex 设置</h3>${nav}${choices}${summary}${instructions}${fields}${extras}${rows || (instructions || fields || extras ? '' : '<div class="hint">电脑端此栏目当前也没有可操作的设置项。</div>')}`);
}
function showSettings(sections, nav = [], current = '', choices = []) {
  const action = it => `<button class="opt ${it.on ? 'cur' : ''}" data-setting="${esc(it.id || it.label)}" ${it.disabled ? 'disabled' : ''}><span class="lbl">${esc(it.label)}${it.detail ? `<span class="sub">${esc(it.detail)}</span>` : ''}</span>${it.on !== undefined ? `<span class="switch ${it.on ? 'on' : ''}"></span>` : it.value ? `<span class="tag">${esc(it.value)}</span>` : ''}</button>`;
  const body = sections.map(s => `<div class="pSec">${esc(s.title)}</div>${s.summary ? `<div class="hint">${esc(s.summary)}</div>` : ''}` + s.items.map(it => {
    if (it.type) return `<label class="pSec">${esc(it.label)}</label>${it.type === 'select' ? `<select data-setting-field="${esc(it.id)}" ${it.disabled ? 'disabled' : ''}>${it.options.map(o=>`<option value="${esc(o.value)}" ${o.value===it.value?'selected':''}>${esc(o.label)}</option>`).join('')}</select>` : it.type === 'textarea' ? `<textarea data-setting-field="${esc(it.id)}" ${it.disabled ? 'disabled' : ''}>${esc(it.value)}</textarea>` : `<input type="${esc(it.type)}" data-setting-field="${esc(it.id)}" value="${esc(it.value)}" ${it.disabled ? 'disabled' : ''}>`}`;
    if (it.toggle === false) return `<div class="opt static"><span class="lbl">${esc(it.label)}<span class="sub">${esc(it.detail || '')}</span></span></div>`;
    return action(it);
  }).join('')).join('');
  const navigation = nav.length ? `<div class="codexSettingsNav">${nav.map(name => `<button class="paramBtn ${name === current ? 'cur' : ''}" data-settings-nav="${esc(name)}">${esc(name)}</button>`).join('')}</div>` : '';
  openSheet('settings', `<h3>${currentAppName ? currentAppName + ' 设置' : '设置'}</h3>${navigation}${choices.length ? '<div class="pSec">选项</div>' + choices.map(action).join('') : ''}${body || '<div class="hint">没有读到设置。</div>'}`);
}

function meterFill(pct, basis) {
  if (pct == null) return '';
  const tight = basis === 'remaining' ? pct <= 10 : pct >= 90;
  const warm = basis === 'remaining' ? pct <= 25 : pct >= 75;
  return tight ? 'hot' : warm ? 'warm' : '';
}
const meterPercent = pct => pct == null ? null : Math.max(0, Math.min(100, Number(pct)));
const contextMeterScope = () => [currentComputer()?.id || '', viewSel].join('|');
let contextInfo = null, quotaInfo = null;
let contextMeterOwner = '', quotaMeterOwner = '';
function quotaMeterData(m) {
  return fusionUsageBars(m).filter(b => b?.label && !/^loading\b/i.test(String(b.label)))
    .map(b => ({ ...b, pct: meterPercent(b.pct), basis: b.basis || 'used' }));
}
function currentUsageMeters() {
  return { context: contextMeterOwner === contextMeterScope() ? contextInfo : null,
    quota: quotaMeterOwner === quotaKey() && !quotaInfo.missing ? quotaMeterData(quotaInfo) : [] };
}
function renderContext(info) {
  const basis = info && typeof info === 'object' ? (info.basis || 'used') : 'used';
  const pct = info == null ? null : typeof info === 'object' ? info.pct : info;
  const n = meterPercent(pct === '' ? null : pct);
  contextInfo = info?.source === 'opencode' ? { ...info, pct: n, basis } : { pct: n, basis };
  contextMeterOwner = contextMeterScope();
  const local = info?.source === 'opencode';
  const capacity = local && info.limit ? (info.limit % 1024 === 0 ? info.limit / 1024 + 'K' : info.limit) : '';
  $('meterCtxPct').textContent = n == null ? (local ? '尚未统计' + (capacity ? ' / ' + capacity : '') : '未获取') : (basis === 'remaining' ? '剩余' : '已用') + n + '%';
  const fill = $('meterCtxFill');
  fill.style.width = (n ?? 0) + '%';
  fill.parentElement.style.setProperty('--pct', n ?? 0);
  fill.parentElement.dataset.n = n == null ? '' : Math.round(n);
  fill.className = meterFill(n, basis);
  $('meterCtx').title = local ? '上下文 · ' + (info.updated ? '上次调用 · ' : '') + $('meterCtxPct').textContent
    : '上下文 · ' + (basis === 'remaining' ? '剩余' : '已用') + ' ' + (n ?? '–') + '%';
  $('meterCtx').setAttribute('aria-label', $('meterCtx').title);
  $('meterCtx').onclick = () => showUsageDetails('context');
  renderPerfChip(lastChat?.performance);
  document.dispatchEvent(new Event('usage-state'));
}
/* ---------- native performance (footer) ---------- */
let _perfOpen = false, perfSample = null;
function fmtTokPerSec(tokS) {
  if (tokS == null) return '—';
  return tokS >= 1000 ? (tokS / 1000).toFixed(1).replace(/\.?0$/, '') + ' kt/s' : Math.round(tokS) + ' tok/s';
}
function fmtDuration(ms) {
  if (ms == null) return '—';
  const s = ms / 1000;
  if (s < 0.06) return Math.round(ms) + 'ms';
  if (s < 60) return Math.round(s) + 's';
  return Math.floor(s / 60) + 'm' + Math.round(s % 60) + 's';
}
function fmtTok(n) {
  if (n == null) return '—';
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.?0$/, '') + 'k' : String(n);
}
function buildPerfPanel(panel, info) {
  const row = (label, val) => '<div class="perf-row"><span class="perf-key">' + label + '</span><span class="perf-val">' + esc(val) + '</span></div>';
  const tokens = info.tokens;
  panel.innerHTML = row(info.label, info.speed) + row(info.interval ? '统计区间' : '时长', fmtDuration(info.durationMs))
    + (tokens ? row('输入 token', fmtTok(tokens.input)) + row('输出 token', fmtTok(tokens.output))
      + (tokens.reasoning != null ? row('推理 token', fmtTok(tokens.reasoning)) : '')
      + row('缓存读取 token', fmtTok(tokens.cacheRead)) + row('缓存写入 token', fmtTok(tokens.cacheWrite)) : '')
    + (info.cacheRate != null ? row('缓存命中率', info.cacheRate + '%') : '') + row('模型', info.model || '—');
}
function renderPerfChip(info) {
  const chip = $('perfChip'), panel = $('perfPanel');
  if (!info) { _perfOpen = false; perfSample = null; chip.hidden = true; panel.hidden = true; return; }
  const key = JSON.stringify([contextMeterScope(), info.source, info.runId, info.usageId, info.model]);
  const now = performance.now();
  if (perfSample?.key !== key) {
    _perfOpen = false;
    perfSample = { key, counter: info.counter, at: now, rate: null, durationMs: null };
  } else if (info.counter !== perfSample.counter) {
    const elapsed = now - perfSample.at, difference = info.counter - perfSample.counter;
    perfSample.rate = info.counter != null && perfSample.counter != null && difference > 0 && elapsed > 0 ? difference / (elapsed / 1000) : null;
    perfSample.durationMs = perfSample.rate == null ? null : elapsed;
    perfSample.counter = info.counter;
    perfSample.at = now;
  }
  const interval = info.rate == null && perfSample.rate != null;
  const rate = info.rate ?? perfSample.rate;
  const label = info.unit === 'characters' ? '实时字符速度' : info.source === 'opencode' ? '本次平均'
    : interval ? '区间平均' : info.rate != null ? '轮次平均' : '等待统计更新';
  const speed = rate == null ? info.busy ? '统计中' : '—' : info.unit === 'characters' ? Math.round(rate) + ' 字符/秒' : fmtTokPerSec(rate);
  chip.textContent = speed;
  chip.title = label;
  chip.setAttribute('aria-label', label + ' · ' + speed);
  chip.hidden = false;
  buildPerfPanel(panel, { ...info, label, speed, interval, durationMs: interval ? perfSample.durationMs : info.durationMs });
  panel.hidden = !_perfOpen;
}
// Phones show the value text ("已用 56%") beside each ring whenever every meter fits that way next to
// a readable title; otherwise the number moves inside the ring. Measured, so fonts/languages don't matter.
let meterFitFrame = 0;
function fitMeters() {
  meterFitFrame = 0;
  const body = document.body, m = $('meters');
  if (body.classList.contains('wide') || !m.offsetParent) { body.classList.remove('metersText'); return; }
  body.classList.add('metersText');
  // The title keeps 64px, or less when its own text is shorter than that (e.g. "Devin").
  const titleNeeds = Math.min(64, Math.max($('titleText').scrollWidth, $('titleProject').scrollWidth));
  const fits = m.scrollWidth <= m.clientWidth + 1 && $('menuBtn').getBoundingClientRect().right <= window.innerWidth
    && document.querySelector('.titleLabels').getBoundingClientRect().width >= titleNeeds;
  if (!fits) body.classList.remove('metersText');
}
const queueFitMeters = () => { if (!meterFitFrame) meterFitFrame = requestAnimationFrame(fitMeters); };
for (const id of ['meters', 'title']) new MutationObserver(queueFitMeters).observe($(id), { childList: true, subtree: true, characterData: true });
window.addEventListener('resize', queueFitMeters);
const quotaCache = new Map();
const quotaKey = () => [currentComputer()?.id || '', ...viewSel.split('|').slice(0, 2)].join('|');
function renderQuota(m) {
  if ('context' in m) renderContext(m.context);
  if (m.context?.source === 'opencode' && !m.automatic) finishPending(['正在读取上下文…']);
  if (m.error) { $('quotaStatus').textContent = m.error; $('quotaStatus').title = $('quotaMeters').title = m.detail || m.error; if (!m.automatic) status('额度刷新失败：' + m.error, false); return; }
  if (!m.cached || m.updated > (quotaCache.get(quotaKey())?.updated || 0)) $('quotaStatus').textContent = '';
  if (m.refreshError) { $('quotaStatus').textContent = '刷新失败，显示桌面缓存'; $('quotaStatus').title = m.refreshError; }

  if (m.loading) return;
  if (!('quota' in m) && !('limits' in m) && !('bars' in m)) {
    return;
  }
  quotaInfo = m;
  quotaMeterOwner = quotaKey();
  if (!m.missing && !m.loading) quotaCache.set(quotaKey(), m);
  const bars = quotaMeterData(m);
  document.dispatchEvent(new Event('usage-state'));
  $('quotaMeters').classList.toggle('devinLimits', currentApp === 'devin' && bars.length > 1);
  const when = m.updated ? new Date(m.updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  if (m.missing || !bars.length) {
    $('quotaMeters').title = (m.missing ? '没有额度数据' : '没有额度指标') + (when ? ` · 更新于 ${when}` : '');
    $('quotaMeters').innerHTML = `<button class="meter" type="button"><span class="track"></span><span class="meterText"><span class="meterLabel">额度</span><b>未获取</b></span></button>`;
    $('quotaMeters').querySelector('button').onclick = () => showUsageDetails('quota');
    return;
  }
  const reset = [...new Set(bars.map(b => b.reset).filter(Boolean))].join(' · ') || (m.lines || []).find(l => /reset/i.test(l)) || '';
  $('quotaMeters').title = [reset, when ? `更新于 ${when}` : ''].filter(Boolean).join(' · ');
  $('quotaMeters').innerHTML = bars.map(b => {
    const basis = b.basis;
    const n = b.pct;
    const num = n == null ? (b.value ?? '未获取') : (basis === 'remaining' ? '剩余' : '已用') + `${n}%`;
    const label = /week|每周|周额度/i.test(b.label) ? '周额度' : /daily|每日|日额度/i.test(b.label) ? '日额度' : b.label;
    return `<button class="meter" type="button" title="${esc(b.label + ' · ' + basis + ' · ' + (b.reset || ''))}" aria-label="${esc(b.label + ' ' + num)}"><span class="track" style="--pct:${n ?? 0}" data-n="${n == null ? '' : Math.round(n)}"><i class="${meterFill(n, basis)}" style="width:${n ?? 0}%"></i></span><span class="meterText"><span class="meterLabel">${esc(label)}</span><b>${esc(String(num))}</b></span></button>`;
  }).join('');
  if (when) $('quotaMeters').insertAdjacentHTML('beforeend', `<span class="quotaUpdated">${m.cached ? '缓存 ' : ''}${esc(when)}</span>`);
  $('quotaMeters').querySelectorAll('button').forEach(btn => btn.onclick = () => showUsageDetails('quota'));
}
function showUsageDetails(kind) {
  const context = kind === 'context';
  const local = context && contextInfo?.source === 'opencode';
  const m = quotaInfo || {};
  const bars = fusionUsageBars(m);
  const value = b => b?.pct == null ? String(b?.value || '未获取') : `${b.basis === 'remaining' ? '剩余' : '已用'} ${b.pct}%`;
  const rows = local ? `<p>${contextInfo.used == null ? '尚未统计' : esc(String(contextInfo.used))} / ${contextInfo.limit == null ? '未获取' : esc(String(contextInfo.limit))} tokens</p><p>模型 · ${esc(contextInfo.model)}</p>${contextInfo.updated ? `<p>上次调用 · ${esc(new Date(contextInfo.updated).toLocaleString())}</p>` : ''}<p class="hint">显示最近一次有效模型调用的 token 用量；生成期间保留上次调用数据。</p>`
    : context ? `<p>${esc(value(contextInfo))}</p><p class="hint">上下文表示当前会话的上下文容量使用情况，与账号额度分别统计。</p>`
    : `<p class="hint">额度表示账号在对应周期内的使用限制，百分比统一显示剩余额度。</p>` + (m.plan ? `<p>方案 · ${esc(m.plan)}</p>` : '') + (m.missing || !bars.length ? '<p>未获取额度数据</p>' : bars.map(b => `<p>${esc(b.label)} · ${esc(value(b))}${b.detail ? `<br><span class="hint">${esc(b.detail)}</span>` : ''}${b.reset ? `<br><span class="hint">${esc(b.reset)}</span>` : ''}</p>`).join(''))
      + (m.extra ? `<p>额外用量余额 · ${esc(m.extra)}</p>` : '');
  const updated = m.updated ? new Date(m.updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  openSheet('usage', `<h3>${context ? '上下文说明' : '额度说明'}</h3>${rows}${!context && updated ? `<p class="hint">${m.cached ? '缓存数据' : '最近更新'} · ${esc(updated)}</p>` : ''}${!context && $('quotaStatus').textContent ? `<p class="hint">${esc($('quotaStatus').textContent)}</p>` : ''}<button id="refreshUsage" class="opt">刷新数据</button>`);
  $('refreshUsage').onclick = () => { closeSheet(); status(local ? '正在读取上下文…' : '正在读取额度…'); send({ t: 'usage' }); };
}
function menuGroup(key, label, content, initial = true) {
  const saved = store.get('menu-group:' + key);
  const open = saved === null ? initial : saved === '1';
  return `<details class="mainGroup" data-menu-group="${key}" ${open ? 'open' : ''}><summary>${esc(I18N.tr(label))}</summary><div class="mainGroupBody">${content}</div></details>`;
  }
function closePerfPanel() {
  _perfOpen = false;
  $('perfPanel').hidden = true;
}
function togglePerfPanel() {
  _perfOpen = !_perfOpen;
  $('perfPanel').hidden = !_perfOpen;
}
$('perfChip').addEventListener('click', togglePerfPanel);
document.addEventListener('pointerdown', e => {
  if (_perfOpen && !e.target.closest('#perfPanel, #perfChip')) closePerfPanel();
});
$('sheet').addEventListener('toggle', e => {
  if (e.target.matches('details[data-menu-group]')) store.set('menu-group:' + e.target.dataset.menuGroup, e.target.open ? '1' : '0');
  if (e.target.dataset.compatibilityApp) {
    const key = compatibilityKey(e.target.dataset.compatibilityApp);
    e.target.open ? compatibilityOpen.add(key) : compatibilityOpen.delete(key);
  }
}, true);
$('sheet').addEventListener('click', e => {
  const app = e.target.closest('[data-compatibility-refresh]')?.dataset.compatibilityRefresh;
  if (app) { requestCompatibility(app, true); showAgentManager(); }
});
$('sheet').addEventListener('change', e => {
  const app = e.target.dataset.agentStart;
  if (!app) return;
  const selected = new Set(startupAgents());
  e.target.checked ? selected.add(app) : selected.delete(app);
  store.set('agent-start:' + agentComputerKey(), JSON.stringify([...selected]));
  showAgentManager();
});
let connectionDetailsComputer = '';
function connectionHistoryText(record) {
  if (!record) return '';
  const tr = I18N.tr, closed = record.closed, foreground = record.foreground;
  const time = event => event ? new Date(event.at).toISOString() : tr('未记录');
  const environment = event => `${tr(event.visibility === 'visible' ? '前台' : '后台')} · ${tr(event.online ? '网络在线' : '网络离线')} · ${event.phase} · Socket ${event.socketState}`;
  return [
    `${tr('关闭时间')}：${time(closed)}`,
    `${tr('关闭码')}：${closed.code} · ${tr('客户端来源')}：${closed.source}`,
    `${tr('关闭时')}：${environment(closed)} · ${tr(closed.current ? '当前电脑' : '其他电脑')}`,
    `${tr('后台计时')}：${closed.backgroundAt == null ? tr('未启动') : `${closed.at - closed.backgroundAt} ms`}`,
    `${tr('关闭前连接认证')}：${tr(closed.authed ? '已验证' : '未验证')} · ${tr('当前页面认证')}：${tr(closed.activeAuthed ? '已验证' : '未验证')}`,
    `${tr('回到前台')}：${time(foreground)}${foreground ? `\n${environment(foreground)} · ${tr('当前页面认证')}：${tr(foreground.activeAuthed ? '已验证' : '未验证')}` : ''}`,
    `${tr('重连请求')}：${time(record.reconnect)}${record.reconnect ? ` · ${record.reconnect.source}` : ''}`,
    `${tr('新建连接')}：${time(record.socket)}`,
    `${tr('认证成功')}：${time(record.authenticated)}${record.authenticated ? ` · ${tr(record.authenticated.resumed ? '复用中继会话' : '新建中继会话')}` : ''}`,
    `${tr('会话可用')}：${time(record.ready)}`,
  ].join('\n');
}
function showConnectionDetails(id) {
  const e = ovList.find(e => e.id === id);
  if (!e?.c) return;
  connectionDetailsComputer = id;
  const state = ovStOf(id), tr = I18N.tr, failure = state.failure;
  const checks = (state.checks || []).map(c => `<div class="connection-check"><span>${esc(tr(c.label))}</span><span class="${c.st}">${esc(tr(DIAG_TEXT[c.st]))}</span></div>`).join('');
  const technical = [failure?.stage, failure?.error, ...(state.checks || []).filter(c => c.st === 'err').map(c => tr(c.label) + '：' + diagReason(c))].filter(Boolean).join('\n');
  const history = connectionHistoryText(state.link?.lastClose);
  openSheet('connection-details', `<h3>连接详情</h3><p class="hint ovRaw">${esc(e.name)}</p>
    <p class="hint">${esc(tr(state.diagRunning ? '正在检测连接…' : state.conclusion || '连接未建立，请重试。'))}</p>
    ${checks}${technical ? `<pre class="connection-technical">${esc(technical)}</pre>` : ''}
    ${history ? `<div class="pSec">${tr('最近一次关闭与恢复')}</div><pre class="connection-technical" data-connection-history>${esc(history)}</pre><p class="hint">${tr('transport 表示未记录到客户端主动关闭来源，需结合中继日志判断。记录仅保留到本页关闭或刷新。')}</p>` : ''}
    <div class="optRow"><button class="opt" data-act="connectionRetry" data-computer="${esc(id)}">重新连接</button><button class="opt" data-act="connectionDiagnose" data-computer="${esc(id)}" ${state.diagRunning ? 'disabled' : ''}>重新检测</button></div>`);
}

function showAgentManager(refresh = false) {
  if (refresh) {
    send({ t: 'connAgents' });
    for (const app of CONN_AGENTS) requestCompatibility(app.app, true);
  }
  const catalog = agentCatalog(), selected = startupAgents();
  const rows = (catalog || []).map(a => ({ ...CONN_AGENTS.find(r => r.app === a.app), ...a }));
  const known = rows.filter(a => a.installed === true), unknown = rows.filter(a => a.installed === null), missing = rows.filter(a => a.installed === false);
  const row = a => {
    const ready = agentReports.get(agentComputerKey())?.find(r => r.app === a.app)?.windows;
    if (a.app === 'opencode') {
      const note = connLaunchNote(a) || (ready || a.running ? '已连接' : a.reason || '未启动 · 点击启动后在后台运行');
      return `<label class="opt agentManageRow"><span class="optLogo" data-logo="opencode"></span><span class="lbl">OpenCode<span class="sub">${esc(I18N.tr(note))}</span></span>${a.installed === true ? `<input type="checkbox" data-agent-start="opencode" aria-label="OpenCode" ${selected.includes(a.app) ? 'checked' : ''}>` : ''}</label>`;
    }
    const note = connLaunchNote(a) || (ready ? '已连接' : a.running ? '已运行，请开启调试端口' : a.reason || (a.installed === null ? '安装状态待确认' : '未启动'));
    return `<label class="opt agentManageRow"><span class="cTile cBrand agentManageLogo"><img class="on-dark" src="logo-${a.app}-dark.svg" alt=""><img class="on-light" src="logo-${a.app}-light.svg" alt=""></span><span class="lbl">${esc(a.name)}<span class="sub">${esc(I18N.tr(note))}</span></span>${a.installed === true ? `<input type="checkbox" data-agent-start="${a.app}" aria-label="${esc(a.name)}" ${selected.includes(a.app) ? 'checked' : ''}>` : ''}</label><details data-compatibility-app="${a.app}" ${compatibilityOpen.has(compatibilityKey(a.app)) ? 'open' : ''}><summary>${esc(I18N.tr('版本与适配'))}</summary><pre class="hint">${esc(compatibilityText(a.app))}</pre><button class="opt" data-compatibility-refresh="${a.app}">${esc(I18N.tr('重新检查适配'))}</button></details>`;
  };
  openSheet('agent-manager', `<h3>Agent 管理</h3><p class="hint">${esc(currentComputer()?.name || I18N.tr('当前电脑'))} · ${I18N.tr('选择仅记录启动偏好，不会关闭正在运行的 Agent。')}</p>
    <div class="optRow"><button class="opt" data-act="agentRefresh">重新检测</button><button class="opt" data-act="agentBack">返回菜单</button></div>
    ${!catalog ? '<p class="hint">正在检测已安装的 Agent…</p>' : ''}
    ${catalog ? `<section class="agentManageSection"><div class="pSec">已安装</div>${known.map(row).join('') || '<p class="hint">未检测到已安装的 Agent</p>'}
    <button class="opt" data-act="agentStart" ${selectedLaunchAgents().length ? '' : 'disabled'}>启动所选 Agent</button></section>
    ${unknown.length ? `<section class="agentManageSection"><div class="pSec">待确认</div>${unknown.map(row).join('')}</section>` : ''}
    <section class="agentManageSection"><div class="pSec">未安装</div>${missing.map(a => `<button class="opt" data-act="agentInstall" data-agent="${a.app}"><span class="lbl">${a.name}<span class="sub">查看安装与启动指引</span></span><span class="tag">›</span></button>`).join('') || '<p class="hint">没有未安装的 Agent</p>'}</section>` : ''}
    <p class="hint">${I18N.tr('Codex 需要 VS Code 和 Codex 扩展；调试端口未开启不代表没有安装。')}</p>`);
}

function showViewportTrace() {
  const trace = viewportTrace, armed = store.get('viewport-trace-next') === '1';
  const state = !trace ? '尚未开始记录' : trace.active ? '正在记录布局' : trace.reason === 'full' ? '记录已达上限' : '记录已停止';
  openSheet('viewport-trace', `<h3>页面布局记录</h3>
    <p class="hint">记录视口、安全区、页面坐标和应用资源摘要，不含正文或配对信息，不上传；刷新后记录清除。</p>
    <p role="status">${esc(I18N.tr(state))} · ${trace?.samples.length || 0} / ${VIEWPORT_TRACE_LIMIT}</p>
    <button id="viewportTraceStart" class="opt" ${trace?.active ? 'disabled' : ''}>开始记录</button>
    <button id="viewportTraceStop" class="opt" ${trace?.active ? '' : 'disabled'}>停止记录</button>
    <button id="viewportTraceCopy" class="opt" ${!trace?.samples.length || trace.active ? 'disabled' : ''}>复制记录</button>
    <button id="viewportTraceArm" class="opt">${armed ? '取消下次启动记录' : '记录下次启动'}</button>
    <p class="hint">记录下次启动只保存一次性开关；关闭菜单后手动刷新或重新打开，即自动开始。不会自动刷新。</p>
    <p class="hint">依次复现：刷新主页、卡片键盘展开和收起、进入会话再返回；最后停止并复制。重新开始会替换旧记录。</p>
    <details><summary>查看记录</summary><pre class="ovRaw" style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(viewportTraceText())}</pre></details>
    <button id="viewportTraceBack" class="opt">返回菜单</button>`);
  $('viewportTraceStart').onclick = () => { startViewportTrace(); closeSheet(); };
  $('viewportTraceStop').onclick = () => { recordViewportTrace('stop'); stopViewportTrace(); showViewportTrace(); };
  $('viewportTraceCopy').onclick = () => copyText(viewportTraceText(), $('viewportTraceCopy'), false);
  $('viewportTraceArm').onclick = () => { store.set('viewport-trace-next', armed ? null : '1'); showViewportTrace(); };
  $('viewportTraceBack').onclick = showMainMenu;
}

let usageTimer = null;
function showMainMenu() {
  const fusionRun = activeFusionController || currentApp === 'fusion' ? currentFusionRun() : null;
  const fusionItem = fusionRun ? `<button class="opt" data-fusion-config data-computer="${esc(fusionRun.computer)}" data-fusion-run="${esc(fusionRun.id)}"><span class="lbl">${I18N.tr(fusionRun.main.bindingId ? '工作台设置' : '启用主 Agent')}</span></button>` : '';
  const startConversation = store.get('start-view') === 'conversation';
  const entryItem = `<div class="opt"><span class="lbl">默认进入<span class="sub">下次打开或刷新生效</span></span><div class="agentSessionFilter${startConversation ? ' common' : ''}" style="width:176px;max-width:70%;margin:0" role="group" aria-label="${esc(I18N.tr('默认进入'))}"><button type="button" data-start-view="overview" aria-pressed="${!startConversation}" style="padding:4px 2px">${I18N.tr('缩略图')}</button><button type="button" data-start-view="conversation" aria-pressed="${startConversation}" style="padding:4px 2px">${I18N.tr('会话内容')}</button></div></div>`;
  const manageItem = !document.body.classList.contains('conv') && ovS.level !== 'projects'
    ? '<button class="opt" data-act="overviewBatch"><span class="lbl">批量管理会话</span></button>' : '';
  const notifyItem = `<button class="opt" id="notifySwitchRow" data-act="notifyToggle" role="switch" aria-checked="${notifyOn}"><span class="lbl">开启通知<span class="sub">Agent 完成或等你确认时提醒</span></span><span class="switch${notifyOn ? ' on' : ''}" aria-hidden="true"></span></button>`;
  const autoLaunchOn = store.get('conn-auto-launch') === '1';
  const connItems = `<button class="opt" id="menuLaunchRow" data-act="connLaunchToggle" role="switch" aria-checked="${autoLaunchOn}"><span class="lbl">自动启动未打开的 Agent<span class="sub">连接电脑时自动启动没有运行的 Agent</span></span><span class="switch${autoLaunchOn ? ' on' : ''}" aria-hidden="true"></span></button>`;
  const update = apkUpdate()
    ? `<button class="opt" data-act="appUpdate"><span class="lbl">更新安卓 App（v${esc(appVersion)} → v${esc(apkUpdate())}）</span><span class="tag">新</span></button>`
    : `<button class="opt" data-act="appUpdate"><span class="lbl">检查 App 更新（当前 v${esc(appVersion)}）</span></button>`;
  const appName = currentAppName;
  const modelItems = `
    ${currentApp === 'cursor' && lastChat?.mode ? `<button class="opt" data-act="mode"><span class="lbl">${I18N.tr('模式')}<span class="sub">${esc(lastChat.mode === 'Bypass Permissions' ? '⚠ 绕过权限' : lastChat.mode)}</span></span></button>` : ''}
    ${lastChat?.permission || (currentApp === 'devin' && lastChat?.mode) ? `<button class="opt" data-act="permission"><span class="lbl">权限模式<span class="sub">${esc(lastChat.permission || lastChat.mode)}</span></span></button>` : ''}
    <button class="opt" data-act="screen"><span class="lbl">画面<span class="sub">查看绘图与仿真窗口</span></span></button>
    ${currentApp === 'codex' ? '<button class="opt" data-act="codexRetryMenu"><span class="lbl">Codex 自动重试<span class="sub">' + (codexAutoRetryEnabled() ? `已开启 · 最多 ${codexAutoRetryCount()} 次` : '已关闭') + '</span></span><span class="tag">›</span></button>' : ''}
    ${supportsCapability('settings') ? '<button class="opt" data-act="settings"><span class="lbl">设置</span></button>' : ''}
    ${['cursor', 'devin', 'codex', 'fusion', 'opencode'].includes(currentApp) ? `<button class="opt" data-act="executionToggle" role="switch" aria-checked="${executionRecordsShown()}"><span class="lbl">显示执行指令<span class="sub">包含工具读取和搜索记录；关闭后在本轮结束时隐藏</span></span><span class="switch${executionRecordsShown() ? ' on' : ''}" aria-hidden="true"></span></button>` : ''}
    ${lastChat?.changed && !lastChat?.readonly ? `<button class="opt" data-act="toggleChanges"><span class="lbl">${hiddenChangeNotices.has(changeNoticeKey()) ? '显示改动' : '隐藏改动提示'}</span></button>` : ''}`;
  const connectionItems = `
    <button class="opt" data-act="agentManager"><span class="lbl">Agent 管理<span class="sub">检测安装状态、选择并启动 Agent</span></span></button>
    ${connItems}
    ${inApp ? '<button class="opt" data-act="changeUrl"><span class="lbl">更换 App 地址</span></button>' : ''}
    <button class="opt" data-act="reconnect"><span class="lbl">重新连接</span></button>
    <button class="opt" data-act="devices"><span class="lbl">已配对设备</span></button>
    <button class="opt" data-act="logout"><span class="lbl">删除这台电脑</span></button>`;
  const settingsItems = `
    ${iosApp && !window.AgentRemoteApp?.pushRegister ? '' : notifyItem}
    ${inApp && appVersion ? update : ''}
    <button class="opt" data-act="theme"><span class="lbl">主题<span class="sub">深色 / 浅色 / 跟随系统（当前：${themeName()}）</span></span></button>
    ${inApp && window.AgentRemoteApp?.listenStatus ? '<button class="opt" data-act="bg"><span class="lbl">后台连接<span class="sub">状态、电池优化、立即重连</span></span></button>' : ''}
    <button class="opt" data-act="cache"><span class="lbl">会话缓存<span class="sub">手机上保存的对话记录，可折叠、可清除</span></span></button>
    <button class="opt" data-act="lang"><span class="lbl">语言 / Language<span class="sub">中文 · English（${I18N.lang === 'en' ? 'English' : '中文'}）</span></span></button>
    <button class="opt" id="viewportTraceEntry"><span class="lbl">页面布局记录</span></button>`;
  openSheet('main', `<div class="mainMenuHeader"><h3>菜单</h3><div class="mainMenuActions"><button class="menuHeaderAction" data-act="transfer" aria-label="${esc(I18N.tr('文件传输'))}" title="${esc(I18N.tr('文件传输'))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 16V4m0 0L3 8m4-4 4 4M17 8v12m0 0 4-4m-4 4-4-4"/></svg></button><button class="menuHeaderAction" data-act="localVoiceMenu" aria-label="${esc(I18N.tr('语音输入'))}" title="${esc(I18N.tr('语音输入'))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button><button class="menuHeaderAction menuComputer" data-act="computers" aria-label="${esc(I18N.tr('电脑'))}" title="${esc(I18N.tr('电脑'))}">${CONN_HOST_SVG}</button></div></div>${entryItem}${manageItem}${fusionItem}${document.body.classList.contains('conv') ? menuGroup('model', '模型', (appName ? `<div class="pSec">${esc(appName)}</div>` : '') + modelItems) : ''}
    ${menuGroup('general', '通用', menuGroup('connection', 'Agent 与连接', connectionItems, false)
      + menuGroup('settings', '应用设置与帮助', settingsItems, false))}<p class="hint">网页版本 ${esc(APP_VERSION)}</p>`);
  $('viewportTraceEntry').onclick = showViewportTrace;
}
$('menuBtn').onclick = showMainMenu;

const inApp = /AgentRemoteApp/.test(navigator.userAgent);
const iosApp = /AgentRemoteApp-iOS/.test(navigator.userAgent);
const APK_RELEASE = 'https://github.com/xrdiao/remote-agent/releases/latest/download/AgentRemote.apk';
// A copy on the user's own GitHub Pages downloads more reliably in mainland China than GitHub Releases.
let apkUrl = APK_RELEASE;
// Only the Android app / an Android browser can install the APK, so other clients never probe for it.
if ((inApp && !iosApp) || /Android/i.test(navigator.userAgent))
  fetch('AgentRemote.apk', { method: 'HEAD' }).then(r => { if (r.ok) apkUrl = new URL('AgentRemote.apk', location.href).href; }).catch(() => {});
const appAddress = () => location.origin + location.pathname.replace(/index\.html$/, '');

// The page itself updates with GitHub Pages; only the Android shell needs a new APK now and then.
const appVersion = /AgentRemoteApp\/v?([\d.]+)/.exec(navigator.userAgent)?.[1];
const newerThan = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
const apkUpdate = () => {
  const latest = store.get('apkLatest');
  return appVersion && latest && newerThan(latest, appVersion) ? latest : null;
};
async function checkAppUpdate(manual = false) {
  if (!inApp || !appVersion) return;
  if (!manual && Date.now() - (store.get('apkChecked') || 0) < 6 * 3600e3) return;
  try {
    const r = await fetch('https://api.github.com/repos/xrdiao/remote-agent/releases/latest', { cache: 'no-store' });
    if (!r.ok) throw new Error();
    store.set('apkLatest', String((await r.json()).tag_name || '').replace(/^v/, ''));
    store.set('apkChecked', Date.now());
  } catch {
    if (manual) status('检查更新失败，请稍后再试', false);
    return;
  }
  if (apkUpdate()) status(`安卓 App 有新版本 v${apkUpdate()}，点右上角「⋯」更新`);
  else if (manual) status('已经是最新版本');
}
function installAppUpdate() {
  if (window.AgentRemoteApp?.update) {
    window.AgentRemoteApp.update(apkUrl);
    status('正在下载新版本，下载完会弹出安装界面');
  }
  // Older shells can't download: an off-site link opens in the system browser instead.
  else location.href = APK_RELEASE;
}

