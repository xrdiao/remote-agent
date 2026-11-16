const fusionWorkspaces = new Map(), fusionStates = new Map(), fusionConfigDrafts = new Map();
const fusionPending = new Map(), fusionContents = new Map(), fusionInputDrafts = new Map();
let fusionNewDraft = null, fusionSheetRun = '', fusionSheetTask = '', activeFusionController = null, fusionViewOwner = null;
const fusionAudits = new Map();
const fusionBoards = new Map(), fusionComputerFolds = new Map();
const fusionInteractionCards = new Map();
let fusionFocusInteraction = '', fusionPendingGroup = null;
let fusionPanelOpen = false, fusionPanelCollapsed = false, fusionChatKey = '', fusionFocusTask = '', fusionFocusPending = false;
const fusionStateKey = (computer, run) => `${computer}|${run}`;
const fusionResultSeen = JSON.parse(store.get('fusion-result-seen') || '{}');
const fusionStatus = value => I18N.tr(({ ready: '待启用', running: '运行中', waiting: '等待新事件', awaiting_user: '待处理',
  recovering: '核对原生执行', blocked: '执行阻塞', stopping: '正在停止', stopped: '已停止', completed: '已完成', closing: '核对交付',
  planned: '已规划', queued: '排队中', preparing: '准备中', submitting: '提交中', unknown: '结果待核对', awaiting_review: '等待主 Agent 验收',
  accepted: '已验收', needs_work: '需要补做', failed: '执行失败', cancelled: '已取消', ended: '本轮结束' })[value] || value || '');
function sendFusion(computer, message, projectOwner) {
  const entry = ovList.find(value => value.id === computer), link = entry?.c && computerSockets.get(entry.c.key);
  if (!link?.authed || link.socket.readyState !== 1) { status('这台电脑尚未连接', false); return false; }
  message.requestId ||= crypto.randomUUID();
  if (['fusionPrepare', 'fusionConfigure'].includes(message.t)) Object.assign(message, { view: 'config', subscriptionId: fusionViewOwner?.requestId });
  fusionPending.set(message.requestId, { computer, type: message.t, runId: message.runId, purpose: message.purpose, projectOwner,
    ownerId: fusionViewOwner?.requestId, bindingId: message.bindingId,
    questionId: message.questionId, planId: message.planId, workId: message.workId, taskId: message.taskId,
    viewKey: fusionViewKey(computer, message.runId, { ...message, kind: message.view }) });
  link.socket.send(JSON.stringify({ ...message, computer }));
  return true;
}
function refreshFusionWorkspace() {
  for (const entry of ovList.filter(value => !ovS.comp || value.id === ovS.comp)) {
    const link = entry.c && computerSockets.get(entry.c.key);
    if (link?.authed && link.socket.readyState === 1) sendFusion(entry.id, { t: 'fusionWorkspace' });
  }
}
function fusionOverviewState(run) {
  return run.overview.resultKey && fusionResultSeen[fusionStateKey(run.computer, run.id)] === run.overview.resultKey
    ? 'idle' : run.overview.state;
}
function fusionMarkResultRead() {
  const run = currentFusionRun();
  if (!run?.overview?.resultKey || !fusionChatActive(run) || !conversationVisible() || !authed || !windowReady
    || navigationPending || chatStale) return false;
  const computer = currentComputer();
  if (run.computer !== computer?.id || lastChat?.thread !== computer.threadId) return false;
  return fusionReadResult(run);
}
function fusionReadResult(run) {
  const key = fusionStateKey(run.computer, run.id);
  if (!run.overview.resultKey) return false;
  if (fusionResultSeen[key] === run.overview.resultKey) return false;
  fusionResultSeen[key] = run.overview.resultKey;
  store.set('fusion-result-seen', JSON.stringify(fusionResultSeen));
  return true;
}
function fusionWorkbenchRecord(run) {
  const entry = ovList.find(value => value.id === run.computer), state = fusionOverviewState(run);
  return { key: 'fusion:' + fusionStateKey(run.computer, run.id), comp: run.computer, app: 'fusion', win: 'fusion', windowId: 'fusion',
    threadId: run.id, fusion: true, main: run.main, title: run.title, projName: run.project.name,
    workspace: run.project.root, host: run.project.host, project: run.project.id, state, busy: state === 'run',
    favorite: run.favorite === true, resultKey: run.overview.resultKey, removal: run.removal, common: true, used: run.updated,
    off: ovComputerStatus(entry) !== 'online' };
}
function fusionWorkbenchRecords() {
  return ovList.flatMap(entry => (fusionWorkspaces.get(entry.id)?.runs || []).map(fusionWorkbenchRecord));
}
function fusionOpenTarget(run) {
  return run.main.bindingId ? run.main.target
    : { computer: run.computer, win: 'fusion', windowId: 'fusion', threadId: run.id };
}
function fusionWorkbenchTile(entry, run) {
  const online = ovComputerStatus(entry) === 'online', state = fusionOverviewState(run);
  const target = fusionOpenTarget(run);
  const label = ({ run: '运行中', wait: '待处理', done: '已完成', err: '执行阻塞', idle: '空闲' })[state];
  const progress = run.tasks.total ? run.tasks : run.works, context = `${entry.name} · ${run.project.name}`;
  return `<div class="ov-tile ov-session ov-compact ov-st-${state} fusion-workbench${!online ? ' ov-off' : ''}" style="--p:${progress.total ? progress.done / progress.total * 100 : 0}%" role="button" tabindex="0" data-fusion-open="${esc(run.id)}" data-computer="${esc(entry.id)}" data-ov-menu="${esc(fusionWorkbenchRecord(run).key)}">`
    + `<span class="ov-card-surface" aria-hidden="true"></span>${ovOpenFeedback(target)}${ovLogo(fusionLogo('fusion'))}`
    + `<div class="ov-state"><span class="ov-badge">${I18N.tr(ovT(label))}</span></div><div class="ov-title ovRaw">${esc(run.title)}</div>`
    + `<div class="ov-context ovRaw" title="${esc(context)}">${esc(context)}</div>`
    + `<div class="ov-foot"><span class="ov-num">${run.tasks.done}<small>/${run.tasks.total} ${I18N.tr('任务')}</small></span>${ovSeg(run.overview.counts)}</div></div>`;
}
function fusionUpdateWorkspace(computer, run) {
  const workspace = fusionWorkspaces.get(computer);
  if (workspace) workspace.runs = [...(run.removedAt ? [] : [run]), ...workspace.runs.filter(row => row.id !== run.id)].sort((a, b) => b.updated - a.updated);
  if (activeFusionController?.id === run.id && activeFusionController.computer === computer) {
    if (run.removedAt) {
      releaseFusionView(); activeFusionController = null;
      if (lastChat?.fusionRun?.id === run.id) lastChat.fusionRun = null;
    } else activeFusionController = run;
    paintFusionRun(); updateTitle();
  }
}
function fusionBoard() {
  const computers = ovList.filter(value => !ovS.comp || value.id === ovS.comp);
  const all = computers.flatMap(entry => (fusionWorkspaces.get(entry.id)?.runs || []).map(run => ({ entry, run })));
  const counts = { run: 0, wait: 0, done: 0, err: 0, idle: 0 };
  for (const { run } of all) counts[fusionOverviewState(run)]++;
  const stats = [['run', '运行中'], ['wait', '待处理'], ['done', '已完成'], ['err', '执行阻塞']]
    .filter(([key]) => counts[key]).map(([key, label]) => `<span class="fusion-stat fusion-tone-${key}"><i></i><b>${counts[key]}</b>${I18N.tr(label)}</span>`).join('');
  const attention = all.flatMap(({ entry, run }) => run.overview.attention.map(item =>
    `<button class="ov-lane-item" ${item.kind === 'question' || item.kind === 'plan'
      ? `data-fusion-locate="${item.kind}:${esc(item.questionId || item.planId)}" data-fusion-run="${esc(run.id)}"`
      : `data-fusion-board-tasks="${esc(run.id)}" data-focus-task="${esc(item.taskId || '')}"`} data-computer="${esc(entry.id)}">${fusionLogo(run.main.app)}<span class="ovRaw">${esc(item.kind === 'plan' ? I18N.tr('确认方案') + ' · ' + item.text : item.text)}</span><small class="ovRaw">${esc(entry.name)}</small></button>`)).join('');
  return `<div class="fusion-board"><div class="fusion-home-summary">${stats || `<span class="hint">${I18N.tr('一个主 Agent，持续管理多项工作')}</span>`}</div>`
    + (attention ? `<div class="ov-lane fusion-attention">${attention}</div>` : '')
    + computers.map(entry => {
      const workspace = fusionWorkspaces.get(entry.id), runs = workspace?.runs || [], online = ovComputerStatus(entry) === 'online';
      const folded = fusionComputerFolds.has(entry.id) ? fusionComputerFolds.get(entry.id) : !online;
      const running = runs.filter(run => fusionOverviewState(run) === 'run').length;
      return `<section class="ov-computer" data-fusion-computer="${esc(entry.id)}"><div class="ov-computer-row">`
        + `<button class="ov-computer-toggle" data-fusion-fold="${esc(entry.id)}" aria-expanded="${!folded}"><i class="fusion-computer-dot${online ? ' online' : ''}"></i><span class="lbl"><strong class="ovRaw">${esc(entry.name)}</strong><small>${!online ? I18N.tr('未连接') + ' · ' : ''}${runs.length} ${I18N.tr('个工作台')}${running ? ' · ' + running + ' ' + I18N.tr('运行中') : ''}</small></span></button>`
        + `<button class="ov-computer-action" data-fusion-new data-computer="${esc(entry.id)}" ${online ? '' : 'disabled'}>＋ ${I18N.tr('启用')}</button>`
        + `<button class="ov-computer-fold" data-fusion-fold="${esc(entry.id)}" aria-expanded="${!folded}" aria-label="${I18N.tr(folded ? '展开电脑' : '收起电脑')}"><svg class="ov-computer-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m9 5 7 7-7 7"/></svg></button></div>`
        + (folded ? '' : `<div class="ov-board fusion-grid">${!workspace ? `<p class="hint">${I18N.tr(online ? '正在读取 Fusion 状态…' : '电脑尚未连接')}</p>` : !runs.length ? `<p class="hint">${I18N.tr('暂无主工作台')}</p>` : runs.map(run => fusionWorkbenchTile(entry, run)).join('')}</div>`) + '</section>';
    }).join('') + '</div>';
}
function fusionLogo(app) { return `<span class="fusion-logo" data-logo="${esc(app)}" aria-label="${esc(OV_AGENT[app] || app)}"></span>`; }
function fusionTaskStatus(task) { return task.needsUser ? I18N.tr('待处理') : fusionStatus(task.status); }
function fusionSurface() { return fusionViewOwner?.surface === 'panel' ? $('fusionPanelBody') : $('sheet'); }
function fusionChatActive(run = currentFusionRun()) {
  return !!run && document.body.classList.contains('conv') && mode === 'chat';
}
function fusionDraw(kind, html) {
  const owner = fusionViewOwner;
  if (owner.surface === 'strip') return;
  if (owner.surface === 'panel') {
    $('fusionPanelBody').innerHTML = html;
    $('fusionPanel').hidden = false;
  } else openSheet('fusion-' + kind, html);
  const root = fusionSurface();
  root.dataset.fusionComputer = owner.computer; root.dataset.fusionRun = owner.runId;
  root.dataset.fusionView = kind === 'task' ? 'task:' + owner.taskId : kind;
  fitFusionLayout();
}
function fusionViewKey(computer, id, view) {
  return JSON.stringify([computer, id, view.kind, view.taskId || '', view.workId || '', view.questionId || '', view.attemptId || '', view.index ?? '']);
}
function fusionRunFor(computer, id) {
  return fusionViewOwner && fusionViewOwner.computer === computer && fusionViewOwner.runId === id
    ? fusionStates.get(fusionViewKey(computer, id, fusionViewOwner)) : null;
}
function releaseFusionView() {
  const owner = fusionViewOwner;
  fusionViewOwner = null;
  fusionAudits.clear();
  $('fusionPanel').hidden = true;
  $('fusionScrim').hidden = true;
  document.body.classList.remove('fusionPanelVisible');
  if (owner) sendFusion(owner.computer, { t: 'fusionRead', runId: owner.runId, view: 'close', subscriptionId: owner.requestId });
}
function readFusionView(computer, runId, kind, ids = {}, surface) {
  releaseFusionView();
  const run = currentFusionRun(), embedded = fusionChatActive(run) && run.computer === computer && run.id === runId;
  surface ||= embedded && ['tasks', 'task'].includes(kind) ? (kind === 'task' && !document.body.classList.contains('split') ? 'sheet' : 'panel') : 'sheet';
  if (surface !== 'strip') ovCancelOpening();
  if (surface === 'panel') closeSheet();
  const owner = fusionViewOwner = { computer, runId, kind, ...ids, surface, requestId: crypto.randomUUID() };
  fusionSheetRun = fusionStateKey(computer, runId); fusionSheetTask = ids.taskId || '';
  if (surface !== 'strip') { fusionSurface().dataset.fusionView = ''; fusionSurface().scrollTop = 0; }
  fusionDraw(kind, `<p class="hint">${I18N.tr('正在读取工作台…')}</p>`);
  if (!sendFusion(computer, { t: 'fusionRead', runId, view: kind, ...ids, requestId: owner.requestId })) fusionViewError('这台电脑尚未连接');
}
function fusionOwnsView(computer, runId, view) {
  return fusionViewOwner?.computer === computer && fusionViewOwner.runId === runId
    && fusionViewOwner.requestId === view.subscriptionId && (fusionViewOwner.surface === 'sheet'
      ? sheetKind === 'fusion-' + fusionViewOwner.kind : fusionChatActive() && currentFusionRun().id === runId && currentFusionRun().computer === computer);
}
function fusionViewError(message) {
  if (fusionViewOwner?.surface === 'strip') {
    const bar = $('fusionBar');
    bar.hidden = false;
    bar.dataset.fusionRun = fusionViewOwner.runId; bar.dataset.fusionComputer = fusionViewOwner.computer;
    bar.innerHTML = fusionNoticeHtml(I18N.tr('工作台读取失败'), message, `<button data-fusion-retry>${I18N.tr('重试读取')}</button>`);
    return;
  }
  const sheet = fusionSurface();
  let error = sheet.querySelector('.fusion-response-error');
  if (!error) { error = document.createElement('p'); error.className = 'fusion-error fusion-response-error'; sheet.append(error); }
  error.textContent = message;
  sheet.querySelector('[type=submit]')?.removeAttribute('disabled');
  if (fusionViewOwner && !sheet.querySelector('[data-fusion-retry]')) {
    const retry = document.createElement('button'); retry.dataset.fusionRetry = ''; retry.textContent = I18N.tr('重试读取'); sheet.append(retry);
  }
}
const fusionSheetObserver = new MutationObserver(() => {
  if (fusionViewOwner?.surface === 'sheet' && (!$('sheet').classList.contains('open') || sheetKind !== 'fusion-' + fusionViewOwner.kind)) releaseFusionView();
  if (!$('sheet').classList.contains('open')) fusionEnsureBoard();
});
fusionSheetObserver.observe($('sheet'), { attributes: true, attributeFilter: ['class', 'data-kind'] });
function currentFusionRun() {
  return activeFusionController || (currentApp === 'fusion' ? lastChat?.fusionRun : null);
}
function openFusionController(computer, id) {
  const run = fusionWorkspaces.get(computer)?.runs.find(row => row.id === id) || fusionRunFor(computer, id) || currentFusionRun();
  if (run.main.bindingId) {
    closeSheet();
    if (ovS.level !== 'favorites') { ovS.level = 'fusion'; ovS.proj = null; ovSaveHistory(); }
    return ovOpen(fusionOpenTarget(run));
  }
  return readFusionView(computer, id, 'config');
}
function focusFusionInput(computer, id) {
  const run = currentFusionRun();
  if (!fusionChatActive(run) || run.computer !== computer || run.id !== id) return openFusionController(computer, id);
  closeSheet(); fusionPanelOpen = false; fusionPanelCollapsed = true;
  readFusionView(computer, id, 'tasks', {}, 'strip');
  text.focus({ preventScroll: true });
}
function showFusionNew(computer = ovS.comp || '') {
  releaseFusionView(); ovCancelOpening();
  fusionNewDraft = { computer, app: 'codex', tier: 'balanced', requestId: crypto.randomUUID() };
  paintFusionNew();
}
function fusionAppSelect(computer, selected, disabled = false) {
  const apps = (fusionWorkspaces.get(computer)?.apps || []).filter(app => app.controller);
  return `<label>${I18N.tr('主 Agent 所属软件')}<select name="app" required ${disabled ? 'disabled' : ''}><option value="">${I18N.tr('请选择软件')}</option>${apps.map(app => `<option value="${esc(app.app)}" ${selected === app.app ? 'selected' : ''}>${esc(app.name)}${app.connected === false ? ' · ' + I18N.tr('未连接') : ''}</option>`).join('')}</select></label>`;
}
function paintFusionNew() {
  const draft = fusionNewDraft, computers = ovList.filter(value => !ovS.comp || value.id === ovS.comp);
  openSheet('fusion-create', `<h3>${I18N.tr('启用 Fusion 主工作台')}</h3><form class="fusion-form" id="fusionNewForm">`
    + `<label>${I18N.tr('所属电脑')}<select name="computer" required><option value="">${I18N.tr('请选择执行电脑')}</option>${computers.map(entry => `<option value="${esc(entry.id)}" ${entry.id === draft.computer ? 'selected' : ''}>${esc(entry.name)}</option>`).join('')}</select></label>`
    + fusionAppSelect(draft.computer, draft.app) + `<p class="hint">${I18N.tr('子 Agent 的软件和模型由主 Agent 按任务选择。')}</p>` + fusionTierSelect(draft.tier)
    + `<p class="hint">${I18N.tr('复用已有项目窗口；没有该项目窗口时，使用现有打开项目流程。启用时创建独立的原生主会话。')}</p><button class="primary" type="submit">${I18N.tr('打开／新建项目')}</button></form>`);
  const form = $('fusionNewForm');
  form.onchange = event => {
    draft[event.target.name] = event.target.value;
    if (event.target.name === 'computer') sendFusion(draft.computer, { t: 'fusionWorkspace', purpose: 'new-apps' });
  };
  form.onsubmit = event => { event.preventDefault(); if (draft.computer && draft.app) fusionProjectAction({ t: 'projects', path: '' }, { ...draft }); };
}
function fusionProjectAction(message, owner) {
  const { t, ...action } = message;
  projectSheet('projects', `<h3>${I18N.tr(t === 'projects' ? '正在读取项目…' : '正在打开项目…')}</h3>`, owner);
  if (t === 'projects') return sendFusion(owner.computer, { t: 'fusionWorkspace', path: message.path || '' }, owner);
  return sendFusion(owner.computer, { ...action, t: 'fusionProject', action: t, runId: owner.runId,
    requestId: owner.requestId, main: { app: owner.app, model: '', effort: '' }, tier: owner.tier }, owner);
}
function fusionTierSelect(tier) {
  return `<label>${I18N.tr('成本偏好')}<select name="tier">${[['economy', '省钱'], ['balanced', '均衡'], ['performance', '性能']].map(([id, label]) => `<option value="${id}" ${tier === id ? 'selected' : ''}>${I18N.tr(label)}</option>`).join('')}</select></label>`;
}
function showFusionConfig(run) {
  if (!run) return;
  fusionSheetRun = fusionStateKey(run.computer, run.id);
  let draft = fusionConfigDrafts.get(fusionSheetRun);
  if (!draft) fusionConfigDrafts.set(fusionSheetRun, draft = { ...run.main, tier: run.tier,
    budgetLimit: run.budget?.limit || '', budgetUnit: run.budget?.unit || '' });
  const candidate = run.capabilities.find(value => value.app === draft.app), model = candidate?.models.find(value => value.model === draft.model);
  openSheet('fusion-config', `<h3>${I18N.tr('主工作台设置')}</h3><p>${esc(ovCompName(run.computer))} · ${esc(run.project.name)}</p><form class="fusion-form" id="fusionConfigForm">`
    + (run.main.bindingId ? `<p>${I18N.tr('主会话已启用。模型、强度、文件、终端和权限继续使用普通会话入口。')}</p>`
      : fusionAppSelect(run.computer, draft.app, run.main.preparing) + `<button type="button" data-fusion-prepare ${run.main.preparing ? 'disabled' : ''}>${I18N.tr(run.main.preparing ? '正在准备项目…' : '读取原生模型')}</button>`
      + (run.main.projectTrust ? `<button type="button" data-fusion-trust>${I18N.tr('确认项目信任')}</button>` : '')
      + `<label>${I18N.tr('主模型')}<select name="model" required><option value="">${I18N.tr('请选择主模型')}</option>${(candidate?.models || []).map(value => `<option value="${esc(value.model)}" ${draft.model === value.model ? 'selected' : ''}>${esc(value.label || value.model)}</option>`).join('')}</select></label>`
      + (model?.efforts.length ? `<label>${I18N.tr('思考强度')}<select name="effort" required><option value="">${I18N.tr('请选择思考强度')}</option>${model.efforts.map(value => `<option value="${esc(value.label || value)}" ${(value.label || value) === draft.effort ? 'selected' : ''}>${esc(value.label || value)}</option>`).join('')}</select></label>` : ''))
    + fusionTierSelect(draft.tier) + `<details><summary>${I18N.tr('主动设置预算（可选）')}</summary><label>${I18N.tr('预算限额')}<input name="budgetLimit" type="number" min="0" step="any" value="${esc(draft.budgetLimit)}"></label><label>${I18N.tr('原生单位')}<input name="budgetUnit" value="${esc(draft.budgetUnit)}"></label><p class="hint">${I18N.tr('留空不设预算；未知金额不推算桌面订阅账单。')}</p></details>`
    + (run.main.error ? `<p class="fusion-error">${esc(run.main.error)}</p>` : '')
    + `<button type="submit" class="primary" ${run.main.preparing ? 'disabled' : ''}>${I18N.tr(run.main.bindingId ? '保存设置' : '启用主 Agent')}</button></form>`
    + (run.main.bindingId ? `<button data-fusion-open="${esc(run.id)}" data-computer="${esc(run.computer)}">${I18N.tr('进入主对话')}</button>` : ''));
  const form = $('fusionConfigForm');
  form.oninput = event => { draft[event.target.name] = event.target.value; };
  form.onchange = event => {
    draft[event.target.name] = event.target.value;
    if (event.target.name === 'app') { draft.model = ''; draft.effort = ''; showFusionConfig(run); }
    if (event.target.name === 'model') { draft.effort = ''; showFusionConfig(run); }
  };
  form.onsubmit = event => {
    event.preventDefault(); form.querySelector('[type=submit]').disabled = true;
    sendFusion(run.computer, { t: 'fusionConfigure', runId: run.id, enable: !run.main.bindingId,
      ...(!run.main.bindingId ? { main: { app: draft.app, model: draft.model, effort: draft.effort || '' } } : {}), tier: draft.tier,
      budget: draft.budgetLimit || draft.budgetUnit ? { limit: Number(draft.budgetLimit), unit: draft.budgetUnit } : null });
  };
}
function paintFusionRun(run) {
  run ||= currentFusionRun();
  const on = !!run || currentApp === 'fusion';
  document.body.classList.toggle('fusion', on);
  $('fusionHeader').hidden = $('fusionTaskStrip').hidden = !on;
  const bar = $('fusionBar');
  bar.hidden = true;
  $('fusionConfig').hidden = true;
  $('fusionWelcome').hidden = currentApp !== 'fusion';
  if (!on) { fitFusionLayout(); return; }
  if (run && ['blocked', 'stopped', 'stopping'].includes(run.status)) {
    const paint = () => {
      bar.innerHTML = fusionNoticeHtml(fusionStatus(run.status), run.blockedReason,
        `<button class="primary" data-fusion-resume>${I18N.tr('核对并继续')}</button><button data-fusion-new-input="${esc(run.id)}">${I18N.tr('补充需求')}</button><button data-fusion-relations="">${I18N.tr('查看工作台')}</button>`);
    };
    if (bar.dataset.fusionRun === run.id && bar.dataset.fusionComputer === run.computer) fusionPreserveSheet(paint, bar); else paint();
    bar.dataset.fusionRun = run.id; bar.dataset.fusionComputer = run.computer; bar.hidden = false;
  } else bar.innerHTML = '';
  paintFusionTaskStrip(); fitFusionLayout(); fusionEnsureBoard();
}
function fusionNoticeHtml(title, reason, actions) {
  return `<section class="fusion-run-notice" role="status"><strong>${esc(title)}</strong>`
    + (reason ? `<details><summary>${I18N.tr('具体原因')}</summary><p class="ovRaw">${esc(reason)}</p></details>` : '')
    + `<div class="fusion-notice-actions">${actions}</div></section>`;
}
function fusionEnsureBoard() {
  fusionMarkResultRead();
  const run = currentFusionRun();
  if (!fusionChatActive(run) || fusionViewOwner || $('sheet').classList.contains('open')) return;
  readFusionView(run.computer, run.id, 'tasks', {}, fusionPanelOpen ? 'panel' : 'strip');
}
function positionFusionPanel() {
  if (fusionChatActive()) document.body.style.setProperty('--fusion-panel-top', document.querySelector('body > header').getBoundingClientRect().bottom + 'px');
}
function fitFusionLayout() {
  const run = currentFusionRun(), active = fusionChatActive(run), split = document.body.classList.contains('split');
  if (!active) {
    if (fusionViewOwner && fusionViewOwner.surface !== 'sheet') releaseFusionView();
    $('fusionPanel').hidden = $('fusionScrim').hidden = true;
    document.body.classList.toggle('fusionPanelVisible', false);
    fusionChatKey = '';
    return;
  }
  const key = fusionStateKey(run.computer, run.id);
  if (fusionViewOwner && fusionViewOwner.surface !== 'sheet'
      && (fusionViewOwner.computer !== run.computer || fusionViewOwner.runId !== run.id)) releaseFusionView();
  if (fusionChatKey !== key) { fusionChatKey = key; fusionPanelOpen = split; fusionPanelCollapsed = false; fusionFocusTask = ''; fusionFocusPending = false; $('fusionTaskStrip').scrollLeft = 0; }
  if (split && !fusionPanelCollapsed) fusionPanelOpen = true;
  const owner = fusionViewOwner;
  if (owner?.computer === run.computer && owner.runId === run.id && ['tasks', 'task'].includes(owner.kind)) {
    const next = owner.kind === 'task' ? (split ? 'panel' : 'sheet') : owner.surface === 'sheet' ? 'sheet' : fusionPanelOpen ? 'panel' : 'strip';
    if (next !== owner.surface) {
      if (owner.kind === 'tasks') {
        owner.surface = next;
        if (next === 'panel') closeSheet();
        if (next === 'panel') {
          const board = fusionBoards.get(key);
          if (board) showFusionTasks(board); else fusionDraw('tasks', `<p class="hint">${I18N.tr('正在读取工作台…')}</p>`);
        } else $('fusionPanel').hidden = true;
      } else {
        const html = fusionSurface().innerHTML;
        fusionPreserveSheet(() => { owner.surface = next; if (next === 'panel') closeSheet(); fusionDraw(owner.kind, html); });
      }
    }
  }
  const visible = owner?.surface === 'panel' && !['config', 'input'].includes(owner.kind);
  $('fusionPanel').hidden = !visible;
  $('fusionScrim').hidden = !visible || split;
  document.body.classList.toggle('fusionPanelVisible', !!visible);
  positionFusionPanel();
}
let fusionLayoutSignature = '';
const fusionLayoutObserver = new MutationObserver(() => {
  const signature = ['conv', 'split', 'chatmode', 'fusion', 'visual'].map(name => document.body.classList.contains(name)).join('|');
  if (signature === fusionLayoutSignature) return;
  fusionLayoutSignature = signature;
  fitFusionLayout(); fusionEnsureBoard();
});
fusionLayoutObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
window.addEventListener('resize', () => { fitFusionLayout(); fusionEnsureBoard(); });
document.addEventListener('window-ready', fusionEnsureBoard);
document.addEventListener('visibilitychange', fusionMarkResultRead);
function fusionRememberBoard(run) {
  const board = run.board || run, key = fusionStateKey(run.computer, run.id), previous = fusionBoards.get(key);
  fusionBoards.set(key, { ...board, id: run.id, computer: run.computer, main: run.main, status: run.status });
  if (currentFusionRun()?.id !== run.id || currentFusionRun().computer !== run.computer) return;
  paintFusionTaskStrip();
  if (fusionChatActive() && lastChat?.thread === currentComputer()?.threadId
      && (JSON.stringify(previous?.questions) !== JSON.stringify(board.questions)
        || JSON.stringify(previous?.nativeInteractions) !== JSON.stringify(board.nativeInteractions)
        || JSON.stringify(previous?.works) !== JSON.stringify(board.works)))
    renderChat(lastChat, chatStale);
}
function paintFusionTaskStrip() {
  const run = currentFusionRun(), board = run && fusionBoards.get(fusionStateKey(run.computer, run.id));
  const strip = $('fusionTaskStrip'), key = run ? fusionStateKey(run.computer, run.id) : '';
  const left = strip.scrollLeft, edge = strip.getBoundingClientRect().left;
  const anchor = left > 0 ? [...strip.querySelectorAll('[data-fusion-relations]')].find(node => node.getBoundingClientRect().right > edge) : null;
  const anchorId = anchor?.dataset.fusionRelations, offset = anchor ? anchor.getBoundingClientRect().left - edge : 0;
  const tasks = (board?.tasks || []).map((task, index) => ({ ...task, index }))
    .sort((a, b) => b.updated - a.updated || b.index - a.index);
  strip.innerHTML = tasks.map(task => `<button class="fusion-task-pill fusion-tone-${task.state}" data-fusion-relations="${esc(task.id)}">${fusionLogo(task.app)}<span class="ovRaw">${esc(task.goal)}</span><i class="fusion-state-dot"></i></button>`).join('')
    + `<button class="fusion-all-tasks" id="fusionTasks" data-fusion-relations="">${I18N.tr('全部')} ${tasks.length || run?.tasks.total || 0} ›</button>`;
  if (strip.dataset.fusionScroll !== key) strip.scrollLeft = 0;
  else if (left > 0) {
    const next = [...strip.querySelectorAll('[data-fusion-relations]')].find(node => node.dataset.fusionRelations === anchorId);
    if (next) strip.scrollLeft += next.getBoundingClientRect().left - strip.getBoundingClientRect().left - offset;
    else strip.scrollLeft = left;
  }
  strip.dataset.fusionScroll = key;
  strip.dataset.fusionRun = run?.id || ''; strip.dataset.fusionComputer = run?.computer || '';
}
function fusionVisibleItems(items) {
  const run = currentFusionRun();
  if (!fusionChatActive(run)) return items;
  const ids = new Set((run.internalInputs || []).filter(row => row.threadId === currentComputer()?.threadId).map(row => row.messageId));
  return items.filter(item => item.k !== 'human' || !ids.has(item.i) && !item.nativeIds?.some(id => ids.has(id)));
}
function fusionAnswerKey(run, question) { return [fusionStateKey(run.computer, run.id), question.workId, question.taskId || '', question.id].join('|'); }
function fusionInteractionButton(kind, id) {
  return `<button class="fusion-pending-link" data-fusion-locate="${kind}:${esc(id)}">${I18N.tr(kind === 'plan' ? '待你确认方案' : '待你回答')} · ${I18N.tr('前往主对话')} ›</button>`;
}
function fusionLocateInteraction(computer, runId, key) {
  fusionFocusInteraction = fusionStateKey(computer, runId) + '|' + key;
  const current = currentFusionRun();
  if (!fusionChatActive(current) || current.id !== runId || current.computer !== computer) return openFusionController(computer, runId);
  closeSheet(); fusionPanelOpen = false; fusionPanelCollapsed = true;
  readFusionView(computer, runId, 'tasks', {}, 'strip');
  if (lastChat) renderChat(lastChat, chatStale);
}
function fusionInteractionNode(run, work, kind, item) {
  const key = fusionStateKey(run.computer, run.id) + '|' + kind + ':' + item.id;
  let node = fusionInteractionCards.get(key);
  if (!node) { node = document.createElement('section'); node.className = 'fusion-interaction'; fusionInteractionCards.set(key, node); }
  node.dataset.fusionInteraction = kind + ':' + item.id;
  node.dataset.fusionComputer = run.computer; node.dataset.fusionRun = run.id;
  const signature = JSON.stringify({ item, title: work?.title });
  if (node._interaction === signature) return node;
  node._interaction = signature;
  const done = kind === 'plan' ? item.confirmed || item.decision : item.answeredAt;
  node.classList.toggle('fusion-interaction-pending', !done);
  fusionPreserveSheet(() => {
  const planStatus = item.decision === 'revise' ? '已要求修改' : item.decision === 'reject' ? '方案已拒绝' : '方案已确认';
  node.innerHTML = `<div class="fusion-dispatch-head"><strong>${I18N.tr(kind === 'plan' ? '确认方案' : '主 Agent 提问')}</strong><span>${I18N.tr(done ? kind === 'plan' ? planStatus : '已回复' : kind === 'plan' ? '待你确认方案' : '待你回答')}</span></div>`
    + `<small class="ovRaw">${esc([work?.title, work?.project?.root].filter(Boolean).join(' · '))}</small><p class="ovRaw">${esc(kind === 'plan' ? item.summary : item.text)}</p>`
    + (kind === 'plan' ? `<details><summary>${I18N.tr('方案与完成标准')}</summary><pre class="ovRaw">${esc(item.scope.join('\n'))}\n${esc(item.criteria.map(row => row.text).join('\n'))}</pre></details>`
      + (done ? item.feedback ? `<p class="ovRaw">${esc(item.feedback)}</p>` : ''
        : `<div class="fusion-plan-actions"><button class="primary" data-fusion-confirm="${esc(item.id)}" data-decision="confirm">${I18N.tr('确认执行')}</button><button data-fusion-confirm="${esc(item.id)}" data-decision="reject">${I18N.tr('拒绝方案')}</button></div>`
        + `<details class="fusion-plan-revision"><summary>${I18N.tr('要求修改')}</summary><form class="fusion-form"><textarea name="answer" rows="3" required aria-label="${I18N.tr('希望如何修改方案')}"></textarea><button type="submit" class="primary">${I18N.tr('提交修改意见')}</button></form></details><span class="fusion-answer-status" role="status"></span>`)
      : done ? (!item.answerNative ? `<p class="fusion-answer-text ovRaw">${esc(item.answer)}</p>` : '')
        : `<form class="fusion-form"><div class="fusion-question-options">${item.options.map((option, index) => `<button type="button" data-fusion-option="${index}">${esc(option)}</button>`).join('')}</div><textarea name="answer" rows="3" required aria-label="${I18N.tr('回答主 Agent')}"></textarea><button type="submit" class="primary">${I18N.tr('交给主 Agent')}</button><span class="fusion-answer-status" role="status"></span></form>`);
  const form = node.querySelector('form');
  if (form) {
    const draftKey = fusionAnswerKey(run, item);
    form.elements.answer.value = fusionInputDrafts.get(draftKey) || '';
    form.oninput = () => fusionInputDrafts.set(draftKey, form.elements.answer.value);
    form.onsubmit = event => {
      event.preventDefault();
      if (!form.elements.answer.value.trim()) return;
      fusionInputDrafts.set(draftKey, form.elements.answer.value);
      const message = kind === 'plan' ? { t: 'fusionConfirm', planId: item.id, decision: 'revise', purpose: 'plan' }
        : { t: 'fusionInput', questionId: item.id, purpose: 'answer' };
      if (sendFusion(run.computer, { ...message, runId: run.id, workId: item.workId, taskId: item.taskId, text: form.elements.answer.value })) {
        form.querySelector('[type=submit]').disabled = true;
        node.querySelector('.fusion-answer-status').textContent = I18N.tr('已登记，等待主 Agent 处理');
      }
    };
  }
  }, node);
  return node;
}
function fusionChatAnchor(items, native) {
  if (native?.callId) {
    const index = items.findIndex(item => item.i === `${native.threadId}:dynamic-tool-call:${native.callId}`);
    if (index >= 0) return index + 1;
  }
  const start = items.findIndex(item => item.k === 'human' && item.nativeIds?.includes(native?.messageId));
  if (start < 0) return null;
  const next = items.findIndex((item, index) => index > start && item.k === 'human');
  return next < 0 ? items.length : next;
}
function fusionNativeNode(run, item) {
  const key = fusionStateKey(run.computer, run.id) + '|native:' + item.id;
  let node = fusionInteractionCards.get(key);
  if (!node) { node = document.createElement('section'); node.className = 'fusion-interaction fusion-native-card'; fusionInteractionCards.set(key, node); }
  node.dataset.fusionNativeCard = item.id; node.dataset.fusionRun = run.id; node.dataset.fusionComputer = run.computer;
  const signature = JSON.stringify(item);
  if (node._nativeInteraction !== signature) fusionPreserveSheet(() => {
    node.innerHTML = `<div class="fusion-dispatch-head"><strong>${I18N.tr('待处理')} · ${I18N.tr('原生交互')}</strong></div>`
      + `<p class="ovRaw">${esc(OV_AGENT[item.app])} · ${esc(item.goal)}</p>`
      + `<details class="fusion-native-details"><summary>${I18N.tr('交互详情')}</summary>${fusionNativeHtml(run, item)}</details>`;
    node._nativeInteraction = signature;
  }, node);
  return node;
}
function fusionChatRows(items, rows, keepViewport, edge) {
  const run = currentFusionRun(), board = run && fusionBoards.get(fusionStateKey(run.computer, run.id));
  if (!board) return;
  const additions = [], pending = [];
  const interactions = [...board.questions.map(item => ({ kind: 'question', item, work: board.works.find(work => work.id === item.workId) })),
    ...board.works.flatMap(work => work.plans.filter(item => item.requiresConfirmation).map(item => ({ kind: 'plan', item, work })))].sort((a, b) => a.item.created - b.item.created);
  for (const { kind, item, work } of interactions) {
    if (!(kind === 'question' ? item.answeredAt : item.confirmed || item.decision)) { pending.push(fusionInteractionNode(run, work, kind, item)); continue; }
    const index = fusionChatAnchor(items, item.native);
    if (index === null) continue;
    const key = fusionStateKey(run.computer, run.id) + '|' + kind + ':' + item.id;
    if (!fusionInteractionCards.has(key) && keepViewport && rows[index - 1]?.isConnected && rows[index - 1].getBoundingClientRect().top < edge
        && fusionFocusInteraction !== key) { deferredScrollRender = true; continue; }
    additions.push({ index, node: fusionInteractionNode(run, work, kind, item) });
  }
  for (const item of board.nativeInteractions || []) pending.push(fusionNativeNode(run, item));
  for (const { index, node } of additions.reverse().sort((a, b) => b.index - a.index)) rows.splice(index, 0, node);
  if (pending.length) {
    fusionPendingGroup ||= document.createElement('section');
    fusionPendingGroup.className = 'fusion-pending-interactions';
    fusionPendingGroup.setAttribute('aria-label', I18N.tr('待处理'));
    syncChildren(fusionPendingGroup, pending); rows.push(fusionPendingGroup);
  }
  const focus = fusionInteractionCards.get(fusionFocusInteraction);
  if (focus) queueMicrotask(() => {
    if (!focus.isConnected || !fusionFocusInteraction) return;
    fusionFocusInteraction = '';
    stopChatMotion(() => {
      const current = currentFusionRun();
      if (!fusionChatActive(current) || current.id !== focus.dataset.fusionRun || current.computer !== focus.dataset.fusionComputer) return;
      setScrollMode('freeScroll'); focus.scrollIntoView({ block: 'start' });
    });
  });
}
function fusionStateBadge(task) { return `<span class="fusion-state fusion-tone-${task.state}">${esc(fusionTaskStatus(task))}</span>`; }
function fusionNativeHtml(run, attempt) {
  const buttons = (attempt.items || []).flatMap(item => item.buttons.map(button =>
    `<button class="${PRIMARY.test(button.label) ? 'primary' : ''}" data-fusion-native="button" data-attempt="${esc(attempt.attemptId)}" data-binding="${esc(attempt.bindingId)}" data-fusion-item="${esc(item.btnItem)}" data-n="${button.n}" data-action-id="${esc(button.actionId)}" data-label="${esc(button.label)}">${esc(button.label)}</button>`)).join('');
  const requests = (attempt.requests || []).map(request => `<div class="fusion-task"><p class="ovRaw">${esc(request.text)}</p>`
    + request.fields.map((field, index) => `<label><span class="ovRaw">${esc(field.label)}</span>${field.options
      ? `<select data-fusion-field="${index}" data-attempt="${esc(attempt.attemptId)}" data-native-request="${esc(request.id)}"${field.multiple ? ' multiple' : ''}>${field.options.map(option => `<option value="${esc(option.value)}" ${(field.multiple ? field.value.includes(option.value) : field.value === option.value) ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select>`
      : `<input type="${field.type === 'password' ? 'password' : 'text'}" data-fusion-field="${index}" data-attempt="${esc(attempt.attemptId)}" data-native-request="${esc(request.id)}" value="${esc(field.value || '')}">`}</label>`).join('')
    + request.buttons.map((button, index) => `<button class="${PRIMARY.test(button.label) ? 'primary' : ''}" data-fusion-native="codexRequest" data-attempt="${esc(attempt.attemptId)}" data-binding="${esc(attempt.bindingId)}" data-native-request="${esc(request.id)}" data-n="${index}" ${button.disabled ? 'disabled' : ''}>${esc(button.label)}</button>`).join('') + '</div>').join('');
  const questions = attempt.questions;
  const questionKey = esc(JSON.stringify(questions));
  const questionButton = (label, qi, oi, part, extra = '') => `<button data-fusion-native="question" data-attempt="${esc(attempt.attemptId)}" data-binding="${esc(attempt.bindingId)}" data-qi="${qi}" data-oi="${oi}" data-part="${part}" data-native-request="${esc(questions.id)}" data-question-key="${questionKey}" ${extra}>${esc(label)}</button>`;
  const questionRows = (questions?.list || []).map((question, qi) => `<div class="fusion-task"><p class="ovRaw">${esc(question.text)}</p>`
    + question.options.map((option, oi) => option.free ? `<input data-fusion-answer="${qi}:${oi}" data-attempt="${esc(attempt.attemptId)}" value="${esc(option.value || '')}">${questionButton(I18N.tr('填入'), qi, oi, 'option')}` : questionButton(option.label, qi, oi, 'option')).join('') + '</div>').join('');
  const questionActions = questions?.list?.length ? questionButton(I18N.tr('跳过'), 0, 0, 'skip')
    + questionButton(I18N.tr('提交'), 0, 0, 'submit', questions.canSubmit ? '' : 'disabled')
    + (questions.pager ? questionButton('‹', 0, 0, 'prev', questions.canPrev ? '' : 'disabled') + questionButton('›', 0, 0, 'next', questions.canNext ? '' : 'disabled') : '') : '';
  return buttons + requests + questionRows + questionActions;
}
function fusionPreserveSheet(paint, surface = null) {
  const root = surface || fusionSurface(), scroll = root.scrollTop;
  const dialogue = root.querySelector('[data-fusion-dialogue]');
  const transcript = dialogue?.open ? dialogue.querySelector('.fusion-content') : null;
  const drafts = [...root.querySelectorAll('input, textarea, select')].map(input => ({ name: input.name, attempt: input.dataset.attempt, request: input.dataset.nativeRequest, field: input.dataset.fusionField,
    answer: input.dataset.fusionAnswer, value: questionFieldValue(input), focused: input === document.activeElement, start: input.selectionStart, end: input.selectionEnd }));
  const detailKey = detail => detail.dataset.fusionAgent ? 'agent:' + detail.dataset.fusionAgent : detail.dataset.fusionAudit || ('fusionRecords' in detail.dataset ? 'records'
    : 'fusionDialogue' in detail.dataset ? 'dialogue' : detail.querySelector('summary').textContent);
  const expanded = new Map([...root.querySelectorAll('details')].map(detail => [detailKey(detail), detail.open]));
  paint();
  const next = surface || fusionSurface();
  const nextDialogue = next.querySelector('[data-fusion-dialogue]');
  if (transcript && nextDialogue?.dataset.binding === dialogue.dataset.binding)
    nextDialogue.querySelector('.fusion-content').replaceWith(transcript);
  for (const detail of next.querySelectorAll('details')) detail.open = !!expanded.get(detailKey(detail));
  for (const input of next.querySelectorAll('input, textarea, select')) {
    const draft = drafts.find(value => value.name === input.name && value.attempt === input.dataset.attempt && value.request === input.dataset.nativeRequest && value.field === input.dataset.fusionField && value.answer === input.dataset.fusionAnswer);
    if (!draft) continue;
    setQuestionFieldValue(input, draft.value);
    if (draft.focused) { input.focus({ preventScroll: true }); if (draft.start != null && input.setSelectionRange) input.setSelectionRange(draft.start, draft.end); }
  }
  next.scrollTop = scroll;
}
function showFusionTasks(run) {
  if (!run) return;
  fusionRememberBoard(run);
  if (fusionViewOwner.surface === 'strip') return;
  const same = fusionSurface().dataset.fusionView === 'tasks';
  const taskRow = task => `<button class="fusion-tree-task${task.needsUser ? ' fusion-needs-user' : ''}${fusionFocusTask === task.id ? ' fusion-focused' : ''}" data-fusion-task="${esc(task.id)}"><span class="lbl"><strong class="ovRaw">${esc(task.id)} ${esc(task.goal)}</strong><small>${task.dependsOn.length ? I18N.tr('依赖') + ' ' + esc(task.dependsOn.join(', ')) : I18N.tr('无前置依赖')}</small></span>${fusionStateBadge(task)}</button>`;
  const group = (id, label, app, model, tasks) => `<details class="fusion-tree-agent${tasks.some(task => task.needsUser) ? ' fusion-needs-user' : ''}" data-fusion-agent="${esc(id)}"><summary class="fusion-agent-heading">${fusionLogo(app)}<span><strong class="ovRaw" title="${esc(label)}">${esc(label)}</strong><small class="ovRaw">${esc([OV_AGENT[app], model].filter(Boolean).join(' · '))}</small><small>${I18N.tr('任务')} ${tasks.length}</small></span></summary>${tasks.map(taskRow).join('')}</details>`;
  const paint = () => {
    fusionSheetRun = fusionStateKey(run.computer, run.id); fusionSheetTask = '';
    fusionDraw('tasks', `<div class="fusion-panel-heading"><h3>${I18N.tr('Agent 关系与分工')}</h3><button data-fusion-collapse aria-label="${I18N.tr('收起')}">${I18N.tr('收起')} ‹</button></div>`
      + `<div class="fusion-main-agent">${fusionLogo(run.main.app)}<span><strong>${I18N.tr('主 Agent')} · ${esc(OV_AGENT[run.main.app])}</strong><small>${esc([run.main.model, run.main.effort].filter(Boolean).join(' · '))}</small><small>${I18N.tr('规划、派工、验收与交付')}</small></span><span class="fusion-state">${esc(fusionStatus(run.status))}</span></div>`
      + `<div class="fusion-tree">${run.agents.map(agent => {
        const tasks = run.tasks.filter(task => task.workerId === agent.id).sort((a, b) => b.updated - a.updated), latest = tasks[0];
        return latest ? group(agent.id, agent.label, latest.app, [latest.model, latest.effort].filter(Boolean).join(' · '), tasks) : '';
      }).join('')}${run.tasks.some(task => task.executor === 'main') ? group('history-main', I18N.tr('历史主 Agent 执行'), run.main.app, '', run.tasks.filter(task => task.executor === 'main').sort((a, b) => b.updated - a.updated)) : ''}</div>`
      + (!run.tasks.length ? `<p class="hint">${I18N.tr('还没有子任务，主 Agent 可以直接完成简单需求。')}</p>` : '')
      + `<details class="fusion-work-items"><summary>${I18N.tr('工作项')} · ${run.works.length}</summary>${run.works.map(work => {
        const plan = work.plans.find(row => row.id === work.planId);
        return `<section class="fusion-task"><h4 class="ovRaw">${esc(work.title)} · ${esc(fusionStatus(work.status))}</h4><p class="ovRaw">${esc(work.goal)}</p><p class="hint ovRaw">${esc(work.project.root)}</p>`
          + (plan ? `<details><summary>${I18N.tr('方案与完成标准')}</summary><pre class="ovRaw">${esc(plan.summary)}\n${esc(plan.scope.join('\n'))}\n${esc(plan.criteria.map(row => row.id + ' · ' + row.text).join('\n'))}</pre></details>` : '')
          + work.deliveries.map(delivery => fusionAuditHtml('delivery', { workId: work.id, index: delivery.index }, I18N.tr('交付与证据') + ' · ' + delivery.summary)).join('')
          + `<div class="fusion-actions"><button data-fusion-answer-work="${esc(work.id)}">${I18N.tr('补充需求')}</button><button data-fusion-stop data-work="${esc(work.id)}">${I18N.tr('停止这项工作')}</button></div></section>`;
      }).join('')}</details>`
      + run.questions.filter(question => !question.answeredAt).map(question => fusionInteractionButton('question', question.id)).join('')
      + run.works.flatMap(work => work.plans.filter(plan => !plan.confirmed && !plan.decision).map(plan => fusionInteractionButton('plan', plan.id))).join('')
      + `<div class="fusion-detail-actions"><button data-fusion-new-input="${esc(run.id)}">${I18N.tr('交办新需求')}</button><button data-fusion-stop>${I18N.tr('停止整个工作台')}</button><button data-fusion-resume>${I18N.tr('核对并继续')}</button></div>`);
    fusionSurface().dataset.fusionView = 'tasks';
  };
  if (same) fusionPreserveSheet(paint); else paint();
  if (fusionFocusPending) {
    const task = [...fusionSurface().querySelectorAll('[data-fusion-task]')].find(node => node.dataset.fusionTask === fusionFocusTask);
    if (task) { task.closest('[data-fusion-agent]').open = true; task.scrollIntoView({ block: 'nearest' }); }
    fusionFocusPending = false;
  }
}
function showFusionTask(run, taskId) {
  const task = run.tasks.find(row => row.id === taskId);
  if (!task) return;
  fusionRememberBoard(run);
  const same = fusionSurface().dataset.fusionView === 'task:' + taskId;
  const paint = () => {
    fusionSheetRun = fusionStateKey(run.computer, run.id); fusionSheetTask = taskId;
    const attempt = run.attempts.at(-1), summary = task.summary;
    const steps = [['派工', task.attemptCount > 0], ['执行', !!summary.endedAt], ['验收', task.status === 'accepted'], ['交付', summary.delivered]];
    const step = task.status === 'accepted' ? 3 : summary.endedAt ? 2 : task.attemptCount ? 1 : 0;
    fusionDraw('task', `<button class="fusion-detail-back" data-fusion-tasks>‹ ${I18N.tr('Agent 关系与分工')}</button><h3 class="fusion-detail-title ovRaw">${esc(task.id)} ${esc(task.goal)}</h3>`
      + `<div class="fusion-tags"><span class="ovRaw">${esc(OV_AGENT[task.app])} · ${esc([task.model, task.effort].filter(Boolean).join(' · '))}</span><span>${I18N.tr(task.access === 'write' ? '写入' : '只读')}</span>${task.dependsOn.length ? `<span>${I18N.tr('依赖')} ${esc(task.dependsOn.join(', '))}</span>` : ''}<span>${I18N.tr('第 {n} 次执行').replace('{n}', task.attemptCount)}</span></div>`
      + `<ol class="fusion-milestones" aria-label="${I18N.tr('任务进度')}">${steps.map(([label, done], index) => `<li class="${done ? 'done' : index === step ? 'current' : ''}">${I18N.tr(label)}</li>`).join('')}</ol>`
      + `<section class="fusion-progress-card"><div class="fusion-progress-heading">${fusionLogo(task.app)}<span>${I18N.tr('进展概括')}</span>${task.updated ? `<time datetime="${new Date(task.updated).toISOString()}">${esc(new Date(task.updated).toLocaleString())}</time>` : ''}</div><p class="ovRaw">${esc(summary.text || fusionTaskStatus(task))}</p>`
      + `<div class="fusion-tags"><span>${I18N.tr('改动文件')} ${summary.files ?? I18N.tr('未提供')}</span><span>${I18N.tr('耗时')} ${summary.durationMs == null ? I18N.tr('未提供') : fusionDuration(summary.durationMs)}</span><span>${I18N.tr('原生回执')} · ${I18N.tr(summary.submission === 'accepted' ? '已接受' : summary.submission === 'not_submitted' ? '未提交' : '待核对')}</span></div>${fusionStateBadge(task)}</section>`
      + (run.board.nativeInteractions.some(row => row.taskId === task.id) ? `<button class="fusion-pending-link" data-fusion-locate="native:${esc(attempt?.id || '')}">${I18N.tr('待处理')} · ${I18N.tr('前往主对话')} ›</button>` : '')
      + run.board.questions.filter(question => question.taskId === taskId && !question.answeredAt).map(question => fusionInteractionButton('question', question.id)).join('')
      + `<details class="fusion-fold" data-fusion-dialogue data-binding="${esc(attempt?.bindingId || '')}" data-attempt="${esc(attempt?.id || '')}"><summary>${I18N.tr(task.executor === 'main' ? '主 Agent 对话' : '子 Agent 对话')}<small>${I18N.tr('点开后读取')} ›</small></summary><div class="fusion-content"></div></details>`
      + fusionAuditHtml('inputs', { taskId }, I18N.tr('任务输入'))
      + fusionAuditHtml('reviews', { taskId }, I18N.tr('主 Agent 评审'))
      + `<details class="fusion-fold" data-fusion-records><summary>${I18N.tr('执行记录')}<small>${run.attempts.length} · ${I18N.tr('点开后读取')} ›</small></summary>${[...run.attempts].reverse().map((row, index) => fusionAuditHtml('attempt', { attemptId: row.id }, `${I18N.tr('第 {n} 次执行').replace('{n}', run.attempts.length - index)} · ${row.model} · ${fusionStatus(row.status)}`)).join('')}</details>`
      + `<div class="fusion-detail-actions"><button data-fusion-answer-work="${esc(task.workId)}" data-task="${esc(task.id)}">${I18N.tr('给主 Agent 补充')}</button><button class="fusion-stop-task" data-fusion-stop data-task="${esc(task.id)}">${I18N.tr('停止任务')}</button></div>`);
    fusionSurface().dataset.fusionView = 'task:' + taskId;
  };
  if (same) fusionPreserveSheet(paint); else paint();
  fusionFillDialogue();
}
function fusionDuration(ms) { return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`; }
function fusionFillDialogue() {
  const root = fusionSurface(), detail = root.querySelector('[data-fusion-dialogue]');
  if (!detail?.open) return;
  const owner = fusionViewOwner, bindingId = detail.dataset.binding;
  const content = fusionContents.get(`${owner.computer}|${owner.runId}|${bindingId}`);
  const target = detail.querySelector('.fusion-content');
  if (target._chat === content && target._binding === bindingId) return;
  target._chat = content; target._binding = bindingId;
  target.innerHTML = (content?.earlier ? `<button data-fusion-content="${esc(bindingId)}" data-history="true" data-before="${esc(content.before || '')}">${I18N.tr('加载更早内容')}</button>` : '')
    + (content ? content.items.filter(item => ['human', 'assistant'].includes(item.k)).map(item => `<article class="fusion-task"><small>${I18N.tr(item.k === 'human' ? '任务输入' : 'Agent 回复')}</small><div class="markdown ovRaw">${codexMarkdown.render(item.t || '')}</div></article>`).join('') : `<p class="hint">${I18N.tr(bindingId ? '正在读取原生内容…' : '原生会话尚未建立')}</p>`)
    + (bindingId ? `<button data-fusion-content="${esc(bindingId)}">${I18N.tr('刷新对话')}</button>` : '');
}
function showFusionInput(run, workId, taskId = '', questionId = '') {
  const question = run.questions.find(row => row.id === questionId), key = `${run.id}:${workId}:${taskId}:${questionId}`;
  fusionSheetRun = fusionStateKey(run.computer, run.id);
  openSheet('fusion-input', `<h3>${I18N.tr(question ? '回答主 Agent' : workId ? '补充需求' : '交办新需求')}</h3>${question ? `<p class="ovRaw">${esc(question.text)}</p>` : ''}<form class="fusion-form" id="fusionInputForm"><textarea name="text" required rows="5">${esc(fusionInputDrafts.get(key) || '')}</textarea><button type="submit" class="primary">${I18N.tr('交给主 Agent')}</button></form>`);
  const form = $('fusionInputForm'); form.oninput = () => fusionInputDrafts.set(key, form.elements.text.value);
  form.onsubmit = event => { event.preventDefault(); if (sendFusion(run.computer, { t: 'fusionInput', runId: run.id, workId, taskId, questionId, text: form.elements.text.value })) { fusionInputDrafts.delete(key); closeSheet(); } };
}
function fusionAuditHtml(kind, ids, label) {
  const view = { kind, ...ids }, key = fusionViewKey(fusionViewOwner.computer, fusionViewOwner.runId, view);
  return `<details class="fusion-fold" data-fusion-audit="${esc(JSON.stringify(view))}"><summary>${esc(label)}<small>${I18N.tr('点开后读取')} ›</small></summary><div class="fusion-audit-content">${fusionAudits.has(key) ? fusionAuditBody(kind, fusionAudits.get(key)) : I18N.tr('展开后读取完整记录…')}</div></details>`;
}
function fusionAuditBody(kind, value) {
  if (kind === 'inputs') return value.assignments.map(row => `<article class="fusion-task"><small>${I18N.tr('派工输入')} · ${esc(new Date(row.created).toLocaleString())}</small><pre class="ovRaw">${esc(row.input)}</pre></article>`).join('')
    + value.inputs.map(row => `<article class="fusion-task"><small>${I18N.tr(row.deliveredAt ? '已交给子 Agent' : '已登记，等待主 Agent 安排')}</small><pre class="ovRaw">${esc(row.text)}</pre></article>`).join('');
  return `<pre class="ovRaw">${esc(JSON.stringify(value, null, 2))}</pre>`;
}
document.addEventListener('toggle', event => {
  const detail = event.target;
  if (!detail.open || !fusionViewOwner || !fusionSurface().contains(detail)) return;
  if ('fusionDialogue' in detail.dataset) {
    fusionFillDialogue();
    const key = detail.dataset.attempt;
    if (detail.dataset.binding && fusionViewOwner.dialogueAttempt !== key) {
      fusionViewOwner.dialogueAttempt = key;
      sendFusion(fusionViewOwner.computer, { t: 'fusionContent', runId: fusionViewOwner.runId, bindingId: detail.dataset.binding });
    }
    return;
  }
  if ('fusionRecords' in detail.dataset) {
    if (![...detail.querySelectorAll('[data-fusion-audit]')].some(row => row.open)) detail.querySelector('[data-fusion-audit]')?.setAttribute('open', '');
    return;
  }
  if (!detail.dataset.fusionAudit) return;
  const view = JSON.parse(detail.dataset.fusionAudit), owner = fusionViewOwner;
  const key = fusionViewKey(owner.computer, owner.runId, view);
  if (fusionAudits.has(key) || [...fusionPending.values()].some(row => row.ownerId === owner.requestId && row.viewKey === key)) return;
  detail.querySelector('.fusion-audit-content').textContent = I18N.tr('正在读取完整记录…');
  sendFusion(owner.computer, { t: 'fusionRead', runId: owner.runId, view: view.kind, ...view, purpose: 'audit' });
}, true);
function receiveFusion(message, link) {
  if (message.t === 'auth') {
    if (link.authed && ['fusion', 'favorites'].includes(ovS.level) && (!ovS.comp || ovS.comp === link.computer.id)) sendFusion(link.computer.id, { t: 'fusionWorkspace' });
    if (link.authed && fusionViewOwner?.computer === link.computer.id && fusionOwnsView(link.computer.id, fusionViewOwner.runId, { subscriptionId: fusionViewOwner.requestId })) {
      delete fusionViewOwner.dialogueAttempt;
      const { computer, runId, kind, requestId, taskId, workId, questionId } = fusionViewOwner;
      sendFusion(computer, { t: 'fusionRead', runId, view: kind, requestId, taskId, workId, questionId });
    }
    return false;
  }
  if (!['fusionWorkspace', 'fusionCreated', 'fusionState', 'fusionUpdate', 'fusionError', 'fusionContent', 'fusionInputDone'].includes(message.t)) return false;
  const computer = link.computer.id;
  if (!link.authed || message.computer !== computer) return true;
  const pending = fusionPending.get(message.requestId); fusionPending.delete(message.requestId);
  const projectActive = pending?.projectOwner && sheetKind === 'projects' && projectSheetOwner()?.requestId === pending.projectOwner.requestId;
  const ownerActive = fusionViewOwner && pending?.ownerId === fusionViewOwner.requestId;
  if (message.t === 'fusionError') {
    if (pending?.purpose === 'answer' || pending?.purpose === 'plan') {
      const node = fusionInteractionCards.get(fusionStateKey(computer, pending.runId) + (pending.purpose === 'plan' ? '|plan:' + pending.planId : '|question:' + pending.questionId));
      const submit = node?.querySelector('[type=submit]');
      if (submit) submit.disabled = false;
      const feedback = node?.querySelector('.fusion-answer-status');
      if (feedback) feedback.textContent = message.message;
    }
    if (projectActive || ownerActive && !['answer', 'plan'].includes(pending?.purpose)) {
      if (projectActive) status(message.message, false);
      fusionViewError(message.message);
      if (pending.type === 'fusionContent') for (const button of fusionSurface().querySelectorAll('[data-fusion-content]'))
        if (button.dataset.fusionContent === pending.bindingId) button.disabled = false;
    }
    return true;
  }
  if (message.t === 'fusionWorkspace') {
    fusionWorkspaces.set(computer, message);
    if (projectActive && message.browse) showProjects(message.browse, pending.projectOwner);
    if (sheetKind === 'fusion-create' && fusionNewDraft?.computer === computer)
      fusionPreserveSheet(paintFusionNew, $('sheet'));
  } else if (message.t === 'fusionUpdate') {
    fusionUpdateWorkspace(computer, message.run);
  } else if (message.t === 'fusionContent') {
    const key = `${computer}|${message.runId}|${message.binding.id}`, previous = fusionContents.get(key), chat = message.chat;
    if (previous && pending?.purpose === 'history') chat.items = [...chat.items, ...previous.items.filter(row => !chat.items.some(item => item.i === row.i))];
    fusionContents.set(key, chat);
    if (ownerActive && fusionViewOwner.kind === 'task') showFusionTask(fusionRunFor(computer, message.runId), fusionSheetTask);
  } else if (message.t === 'fusionInputDone') {
    if (pending?.purpose === 'answer') fusionInputDrafts.delete(fusionAnswerKey({ computer, id: pending.runId },
      { workId: pending.workId, taskId: pending.taskId, id: pending.questionId }));
    if (pending?.purpose === 'plan') fusionInputDrafts.delete(fusionAnswerKey({ computer, id: pending.runId },
      { workId: pending.workId, taskId: pending.taskId, id: pending.planId }));
    status('已登记，等待主 Agent 处理');
  } else if ((message.t === 'fusionState' || message.t === 'fusionCreated') && message.view.kind !== 'close') {
    const view = message.view, runId = message.runId, run = message.run;
    if (projectActive) { readFusionView(computer, runId, 'config'); return true; }
    if (['attempt', 'delivery', 'reviews', 'inputs'].includes(view.kind)) {
      if (!ownerActive) return true;
      const key = fusionViewKey(computer, runId, view); fusionAudits.set(key, run);
      for (const detail of fusionSurface().querySelectorAll('[data-fusion-audit]')) {
        if (fusionViewKey(computer, runId, JSON.parse(detail.dataset.fusionAudit)) === key)
          detail.querySelector('.fusion-audit-content').innerHTML = fusionAuditBody(view.kind, run);
      }
      return true;
    }
    fusionStates.set(fusionViewKey(computer, runId, view), run);
    if (!fusionOwnsView(computer, runId, view)) return true;
    if (view.kind === 'config') {
      if (sheetKind === 'fusion-config') fusionPreserveSheet(() => showFusionConfig(run)); else showFusionConfig(run);
    } else if (view.kind === 'tasks') showFusionTasks(run);
    else if (view.kind === 'task') {
      showFusionTask(run, view.taskId);
    } else if (view.kind === 'input' && pending) showFusionInput(run, view.workId || '', view.taskId || '', view.questionId || '');
    if (message.projectTrust) showProjectTrust(message.projectTrust,
      { computer, app: run.main.app, runId, requestId: crypto.randomUUID() });
  }
  if (['fusion', 'favorites'].includes(ovS.level)) ovRender();
  return true;
}

document.addEventListener('click', event => {
  if (event.defaultPrevented) return;
  const button = event.target.closest('[data-fusion-fold], [data-fusion-collapse], [data-fusion-relations], [data-fusion-retry], [data-fusion-new], [data-fusion-new-input], [data-fusion-board-tasks], [data-fusion-open], [data-fusion-config], [data-fusion-tasks], [data-fusion-task], [data-fusion-prepare], [data-fusion-trust], [data-fusion-confirm], [data-fusion-stop], [data-fusion-resume], [data-fusion-native], [data-fusion-content], [data-fusion-answer-work], [data-fusion-locate], [data-fusion-option]');
  if (!button || button.disabled) return;
  const surface = button.closest('[data-fusion-run]');
  const computer = button.dataset.computer || surface?.dataset.fusionComputer || currentComputer()?.id;
  const runId = surface?.dataset.fusionRun || currentFusionRun()?.id, run = fusionRunFor(computer, runId);
  if ('fusionLocate' in button.dataset) return fusionLocateInteraction(computer, runId, button.dataset.fusionLocate);
  if ('fusionOption' in button.dataset) {
    const node = button.closest('[data-fusion-interaction]'), questionId = node.dataset.fusionInteraction.slice('question:'.length);
    const question = fusionBoards.get(fusionStateKey(computer, runId)).questions.find(row => row.id === questionId);
    const field = node.querySelector('textarea'); field.value = question.options[Number(button.dataset.fusionOption)];
    field.dispatchEvent(new Event('input', { bubbles: true })); field.focus(); return;
  }
  if ('fusionFold' in button.dataset) {
    const id = button.dataset.fusionFold, entry = ovList.find(value => value.id === id);
    const folded = fusionComputerFolds.has(id) ? fusionComputerFolds.get(id) : ovComputerStatus(entry) !== 'online';
    fusionComputerFolds.set(id, !folded); return ovRender();
  }
  if ('fusionCollapse' in button.dataset) {
    if (fusionViewOwner?.surface === 'sheet') return closeSheet();
    fusionPanelOpen = false; fusionPanelCollapsed = true;
    return readFusionView(computer, runId, 'tasks', {}, 'strip');
  }
  if ('fusionRelations' in button.dataset) {
    fusionPanelOpen = true; fusionPanelCollapsed = false; fusionFocusTask = button.dataset.fusionRelations; fusionFocusPending = !!fusionFocusTask;
    return readFusionView(computer, runId, 'tasks');
  }
  if ('fusionNew' in button.dataset) return showFusionNew(button.dataset.computer || ovS.comp || '');
  if ('fusionRetry' in button.dataset) { const { computer, runId, kind, surface, taskId, workId, questionId } = fusionViewOwner; return readFusionView(computer, runId, kind, { taskId, workId, questionId }, surface); }
  if ('fusionNewInput' in button.dataset) return focusFusionInput(computer, button.dataset.fusionNewInput);
  if ('fusionBoardTasks' in button.dataset) { fusionFocusTask = button.dataset.focusTask || ''; fusionFocusPending = !!fusionFocusTask; return readFusionView(computer, button.dataset.fusionBoardTasks, 'tasks'); }
  if ('fusionOpen' in button.dataset) return openFusionController(computer, button.dataset.fusionOpen);
  if ('fusionConfig' in button.dataset) return readFusionView(computer, runId, 'config');
  if ('fusionTasks' in button.dataset) { fusionPanelOpen = true; fusionPanelCollapsed = false; return readFusionView(computer, runId, 'tasks'); }
  if ('fusionTask' in button.dataset) return readFusionView(computer, runId, 'task', { taskId: button.dataset.fusionTask });
  if ('fusionTrust' in button.dataset) return showProjectTrust(run.main.projectTrust, { computer, app: run.main.app, runId, requestId: crypto.randomUUID() });
  if ('fusionPrepare' in button.dataset) { button.disabled = true; return sendFusion(computer, { t: 'fusionPrepare', runId,
    main: { app: fusionConfigDrafts.get(fusionStateKey(computer, runId)).app } }); }
  if ('fusionConfirm' in button.dataset) return sendFusion(computer, { t: 'fusionConfirm', runId, planId: button.dataset.fusionConfirm, decision: button.dataset.decision, purpose: 'plan' });
  if ('fusionStop' in button.dataset) return sendFusion(computer, { t: 'fusionStop', runId, workId: button.dataset.work, taskId: button.dataset.task });
  if ('fusionResume' in button.dataset) return sendFusion(computer, { t: 'fusionResume', runId });
  if ('fusionContent' in button.dataset) {
    button.disabled = true;
    return sendFusion(computer, { t: 'fusionContent', runId, bindingId: button.dataset.fusionContent,
      history: button.dataset.history === 'true', before: button.dataset.before || undefined, purpose: button.dataset.history ? 'history' : 'content' });
  }
  if ('fusionAnswerWork' in button.dataset) return readFusionView(computer, runId, 'input', { workId: button.dataset.fusionAnswerWork, taskId: button.dataset.task, questionId: button.dataset.question });
  if ('fusionNative' in button.dataset) {
    const action = { kind: button.dataset.fusionNative, bindingId: button.dataset.binding, item: button.dataset.fusionItem,
      actionId: button.dataset.actionId, label: button.dataset.label, n: Number(button.dataset.n), id: button.dataset.nativeRequest };
    const nativeCard = button.closest('[data-fusion-native-card]');
    if (action.kind === 'codexRequest') action.fields = [...nativeCard.querySelectorAll('[data-fusion-field]')].filter(input => input.dataset.nativeRequest === action.id).map(input => ({ n: Number(input.dataset.fusionField), value: questionFieldValue(input) }));
    if (action.kind === 'question') {
      Object.assign(action, { qi: Number(button.dataset.qi), oi: Number(button.dataset.oi), part: button.dataset.part, questionKey: button.dataset.questionKey });
      const input = [...nativeCard.querySelectorAll('[data-fusion-answer]')].find(input => input.dataset.fusionAnswer === `${action.qi}:${action.oi}`);
      if (input) action.text = input.value;
    }
    sendFusion(computer, { t: 'fusionNative', runId, attemptId: button.dataset.attempt, action });
  }
});
document.addEventListener('keydown', event => {
  const card = event.target.closest('.fusion-workbench');
  if (card && event.target === card && ['Enter', ' '].includes(event.key)) { event.preventDefault(); card.click(); }
});
