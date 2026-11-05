const fusionWorkspaces = new Map(), fusionStates = new Map(), fusionConfigDrafts = new Map();
const fusionPending = new Map(), fusionContents = new Map(), fusionInputDrafts = new Map();
let fusionNewDraft = null, fusionSheetRun = '', fusionSheetTask = '', activeFusionController = null, fusionViewOwner = null;
const fusionAudits = new Map();
const fusionStateKey = (computer, run) => `${computer}|${run}`;
const fusionStatus = value => I18N.tr(({ ready: '待启用', running: '运行中', waiting: '等待新事件', awaiting_user: '需要你处理',
  recovering: '核对原生执行', blocked: '执行阻塞', stopping: '正在停止', stopped: '已停止', completed: '已完成', closing: '核对交付',
  planned: '已规划', queued: '排队中', preparing: '准备中', submitting: '提交中', unknown: '结果待核对', awaiting_review: '等待主 Agent 验收',
  accepted: '已验收', needs_work: '需要补做', failed: '执行失败', cancelled: '已取消', ended: '本轮结束' })[value] || value || '');
function sendFusion(computer, message, projectOwner) {
  const entry = ovList.find(value => value.id === computer), link = entry?.c && computerSockets.get(entry.c.key);
  if (!link?.authed || link.socket.readyState !== 1) { status('这台电脑尚未连接', false); return false; }
  message.requestId ||= crypto.randomUUID();
  if (['fusionPrepare', 'fusionConfigure'].includes(message.t)) Object.assign(message, { view: 'config', subscriptionId: fusionViewOwner?.requestId });
  fusionPending.set(message.requestId, { computer, type: message.t, runId: message.runId, purpose: message.purpose, projectOwner,
    ownerId: fusionViewOwner?.requestId });
  link.socket.send(JSON.stringify({ ...message, computer }));
  return true;
}
function refreshFusionWorkspace() {
  for (const entry of ovList.filter(value => !ovS.comp || value.id === ovS.comp)) {
    const link = entry.c && computerSockets.get(entry.c.key);
    if (link?.authed && link.socket.readyState === 1) sendFusion(entry.id, { t: 'fusionWorkspace' });
  }
}
function fusionBoard() {
  return `<div class="fusion-board"><h2>Fusion</h2><p class="hint">${I18N.tr('一个主 Agent 持续管理多项工作，子 Agent 在原生窗口后台执行。')}</p>`
    + ovList.filter(value => !ovS.comp || value.id === ovS.comp).map(entry => {
      const workspace = fusionWorkspaces.get(entry.id), runs = workspace?.runs || [];
      return `<section><h3>${esc(entry.name)}</h3><button data-fusion-new data-computer="${esc(entry.id)}">${I18N.tr('启用主工作台')}</button>`
        + (!workspace ? `<p class="hint">${ovComputerStatus(entry) === 'online' ? I18N.tr('正在读取 Fusion 状态…') : I18N.tr('电脑尚未连接')}</p>` : !runs.length ? `<p class="hint">${I18N.tr('暂无主工作台')}</p>` : runs.map(run =>
          `<button class="fusion-run-row" data-fusion-open="${esc(run.id)}" data-computer="${esc(entry.id)}"><span class="lbl"><span class="fusion-run-title">${esc(run.title)}</span><small>${esc(run.project?.name)} · ${esc(OV_AGENT[run.main.app])} · ${esc(fusionStatus(run.status))}<br>${run.works.done}/${run.works.total} ${I18N.tr('项工作')} · ${run.tasks.done}/${run.tasks.total} ${I18N.tr('项任务')}</small></span><span>${ovOpenLabel({ computer: entry.id, win: 'fusion', windowId: 'fusion', threadId: run.id }, '›')}</span></button>`
          + ovOpenFeedback({ computer: entry.id, win: 'fusion', windowId: 'fusion', threadId: run.id })
          + (run.main.bindingId ? `<div class="fusion-actions"><button data-fusion-new-input="${esc(run.id)}" data-computer="${esc(entry.id)}">${I18N.tr('交办新需求')}</button><button data-fusion-board-tasks="${esc(run.id)}" data-computer="${esc(entry.id)}">${I18N.tr('工作与 Agent')}</button></div>` : '')).join('')) + '</section>';
    }).join('') + '</div>';
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
  if (owner) sendFusion(owner.computer, { t: 'fusionRead', runId: owner.runId, view: 'close', subscriptionId: owner.requestId });
}
function readFusionView(computer, runId, kind, ids = {}) {
  releaseFusionView();
  ovCancelOpening();
  const owner = fusionViewOwner = { computer, runId, kind, ...ids, requestId: crypto.randomUUID() };
  fusionSheetRun = fusionStateKey(computer, runId); fusionSheetTask = ids.taskId || '';
  openSheet('fusion-' + kind, `<h3>${I18N.tr('正在读取工作台…')}</h3>`);
  if (!sendFusion(computer, { t: 'fusionRead', runId, view: kind, ...ids, requestId: owner.requestId })) fusionViewError('这台电脑尚未连接');
}
function fusionOwnsView(computer, runId, view) {
  return fusionViewOwner?.computer === computer && fusionViewOwner.runId === runId
    && fusionViewOwner.requestId === view.subscriptionId && sheetKind === 'fusion-' + fusionViewOwner.kind;
}
function fusionViewError(message) {
  const sheet = $('sheet');
  let error = sheet.querySelector('.fusion-response-error');
  if (!error) { error = document.createElement('p'); error.className = 'fusion-error fusion-response-error'; sheet.append(error); }
  error.textContent = message;
  sheet.querySelector('[type=submit]')?.removeAttribute('disabled');
  if (fusionViewOwner && !sheet.querySelector('[data-fusion-retry]')) {
    const retry = document.createElement('button'); retry.dataset.fusionRetry = ''; retry.textContent = I18N.tr('重试读取'); sheet.append(retry);
  }
}
const fusionSheetObserver = new MutationObserver(() => {
  if (fusionViewOwner && (!$('sheet').classList.contains('open') || sheetKind !== 'fusion-' + fusionViewOwner.kind)) releaseFusionView();
});
fusionSheetObserver.observe($('sheet'), { attributes: true, attributeFilter: ['class', 'data-kind'] });
function currentFusionRun() {
  return activeFusionController || (currentApp === 'fusion' ? lastChat?.fusionRun : null);
}
function openFusionController(computer, id) {
  const run = fusionWorkspaces.get(computer)?.runs.find(row => row.id === id) || fusionRunFor(computer, id) || currentFusionRun();
  if (run.main.bindingId) { closeSheet(); return ovOpen({ computer, win: 'fusion', windowId: 'fusion', threadId: id }); }
  return readFusionView(computer, id, 'config');
}
function showFusionNew(computer = ovS.comp || '') {
  releaseFusionView(); ovCancelOpening();
  fusionNewDraft = { computer, app: 'codex', tier: 'balanced', requestId: crypto.randomUUID() };
  paintFusionNew();
}
function paintFusionNew() {
  const draft = fusionNewDraft, computers = ovList.filter(value => !ovS.comp || value.id === ovS.comp);
  openSheet('fusion-create', `<h3>${I18N.tr('启用 Fusion 主工作台')}</h3><form class="fusion-form" id="fusionNewForm">`
    + `<label>${I18N.tr('所属电脑')}<select name="computer" required><option value="">${I18N.tr('请选择执行电脑')}</option>${computers.map(entry => `<option value="${esc(entry.id)}" ${entry.id === draft.computer ? 'selected' : ''}>${esc(entry.name)}</option>`).join('')}</select></label>`
    + `<p>${I18N.tr('主 Agent：Codex。子 Agent 可使用 Cursor、Devin 或 Codex。')}</p>` + fusionTierSelect(draft.tier)
    + `<p class="hint">${I18N.tr('复用已有项目窗口；没有该项目窗口时，使用现有打开项目流程。启用时创建独立的原生主会话。')}</p><button class="primary" type="submit">${I18N.tr('打开／新建项目')}</button></form>`);
  const form = $('fusionNewForm');
  form.onchange = event => { draft[event.target.name] = event.target.value; };
  form.onsubmit = event => { event.preventDefault(); if (draft.computer) fusionProjectAction({ t: 'projects', path: '' }, { ...draft }); };
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
      : `<p>${I18N.tr('主 Agent：Codex')}</p><button type="button" data-fusion-prepare ${run.main.preparing ? 'disabled' : ''}>${I18N.tr(run.main.preparing ? '正在准备项目…' : '读取原生模型')}</button>`
      + (run.main.projectTrust ? `<button type="button" data-fusion-trust>${I18N.tr('确认项目信任')}</button>` : '')
      + `<label>${I18N.tr('主模型')}<select name="model" required><option value="">${I18N.tr('请选择主模型')}</option>${(candidate?.models || []).map(value => `<option value="${esc(value.model)}" ${draft.model === value.model ? 'selected' : ''}>${esc(value.label || value.model)}</option>`).join('')}</select></label>`
      + (model?.efforts.length ? `<label>${I18N.tr('思考强度')}<select name="effort" required><option value="">${I18N.tr('请选择思考强度')}</option>${model.efforts.map(value => `<option value="${esc(value.label || value)}" ${(value.label || value) === draft.effort ? 'selected' : ''}>${esc(value.label || value)}</option>`).join('')}</select></label>` : ''))
    + fusionTierSelect(draft.tier) + `<details><summary>${I18N.tr('主动设置预算（可选）')}</summary><label>${I18N.tr('预算限额')}<input name="budgetLimit" type="number" min="0" step="any" value="${esc(draft.budgetLimit)}"></label><label>${I18N.tr('原生单位')}<input name="budgetUnit" value="${esc(draft.budgetUnit)}"></label><p class="hint">${I18N.tr('留空不设预算；未知金额不推算桌面订阅账单。')}</p></details>`
    + (run.main.error ? `<p class="fusion-error">${esc(run.main.error)}</p>` : '')
    + `<button type="submit" class="primary" ${run.main.preparing ? 'disabled' : ''}>${I18N.tr(run.main.bindingId ? '保存设置' : '启用主 Agent')}</button></form>`
    + (run.main.bindingId ? `<button data-fusion-open="${esc(run.id)}" data-computer="${esc(run.computer)}">${I18N.tr('进入主对话')}</button>` : ''));
  const form = $('fusionConfigForm');
  form.oninput = event => { draft[event.target.name] = event.target.value; };
  form.onchange = event => { draft[event.target.name] = event.target.value; if (event.target.name === 'model') { draft.effort = ''; showFusionConfig(run); } };
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
  $('fusionHeader').hidden = $('fusionBar').hidden = !on;
  $('fusionConfig').hidden = true;
  $('fusionWelcome').hidden = currentApp !== 'fusion';
  if (!on) return;
  $('fusionRunConfig').textContent = I18N.tr(run?.main.bindingId ? '工作台设置' : '启用主 Agent');
  $('fusionTasks').textContent = `${I18N.tr('任务')} ${run?.tasks.total || 0}`;
  $('fusionBar').innerHTML = run ? `<span>${esc(fusionStatus(run.status))}</span>`
    + (['blocked', 'stopped', 'stopping'].includes(run.status) ? `<button data-fusion-resume>${I18N.tr('核对并继续')}</button>` : '')
    + (run.blockedReason ? `<span class="fusion-error">${esc(run.blockedReason)}</span>` : '') : '';
}
function fusionNativeHtml(run, attempt) {
  const buttons = (attempt.live?.items || []).flatMap(item => (item.b || []).map((label, n) =>
    `<button data-fusion-native="button" data-attempt="${esc(attempt.id)}" data-binding="${esc(attempt.bindingId)}" data-fusion-item="${esc(item.btnItem || item.i)}" data-n="${n}" data-action-id="${esc(item.actions?.[n] || '')}" data-label="${esc(label)}">${esc(label)}</button>`)).join('');
  const requests = (attempt.live?.requests || []).map(request => `<div class="fusion-task"><p>${esc(request.text)}</p>`
    + request.fields.map((field, index) => `<label>${esc(field.label)}${field.options
      ? `<select data-fusion-field="${index}" data-native-request="${esc(request.id)}">${field.options.map(option => `<option value="${esc(option.value)}" ${field.value === option.value ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select>`
      : `<input type="${field.type === 'password' ? 'password' : 'text'}" data-fusion-field="${index}" data-native-request="${esc(request.id)}" value="${esc(field.value || '')}">`}</label>`).join('')
    + request.buttons.map((button, index) => `<button data-fusion-native="codexRequest" data-attempt="${esc(attempt.id)}" data-binding="${esc(attempt.bindingId)}" data-native-request="${esc(request.id)}" data-n="${index}" ${button.disabled ? 'disabled' : ''}>${esc(button.label)}</button>`).join('') + '</div>').join('');
  const questions = attempt.live?.questions;
  const questionKey = esc(JSON.stringify(questions));
  const questionButton = (label, qi, oi, part, extra = '') => `<button data-fusion-native="question" data-attempt="${esc(attempt.id)}" data-binding="${esc(attempt.bindingId)}" data-qi="${qi}" data-oi="${oi}" data-part="${part}" data-question-key="${questionKey}" ${extra}>${esc(label)}</button>`;
  const questionRows = (questions?.list || []).map((question, qi) => `<div class="fusion-task"><p>${esc(question.text)}</p>`
    + question.options.map((option, oi) => option.free ? `<input data-fusion-answer="${qi}:${oi}" value="${esc(option.value || '')}">${questionButton(I18N.tr('填入'), qi, oi, 'option')}` : questionButton(option.label, qi, oi, 'option')).join('') + '</div>').join('');
  const questionActions = questions?.list?.length ? questionButton(I18N.tr('跳过'), 0, 0, 'skip')
    + questionButton(I18N.tr('提交'), 0, 0, 'submit', questions.canSubmit ? '' : 'disabled')
    + (questions.pager ? questionButton('‹', 0, 0, 'prev', questions.canPrev ? '' : 'disabled') + questionButton('›', 0, 0, 'next', questions.canNext ? '' : 'disabled') : '') : '';
  return buttons + requests + questionRows + questionActions;
}
function fusionPreserveSheet(paint) {
  const scroll = $('sheet').scrollTop;
  const drafts = [...$('sheet').querySelectorAll('input, textarea, select')].map(input => ({ name: input.name, request: input.dataset.nativeRequest, field: input.dataset.fusionField,
    answer: input.dataset.fusionAnswer, value: input.value, focused: input === document.activeElement, start: input.selectionStart, end: input.selectionEnd }));
  const detailKey = detail => detail.dataset.fusionAudit || detail.querySelector('summary').textContent;
  const expanded = new Map([...$('sheet').querySelectorAll('details')].map(detail => [detailKey(detail), detail.open]));
  paint();
  for (const detail of $('sheet').querySelectorAll('details')) detail.open = !!expanded.get(detailKey(detail));
  for (const input of $('sheet').querySelectorAll('input, textarea, select')) {
    const draft = drafts.find(value => value.name === input.name && value.request === input.dataset.nativeRequest && value.field === input.dataset.fusionField && value.answer === input.dataset.fusionAnswer);
    if (!draft) continue;
    input.value = draft.value;
    if (draft.focused) { input.focus(); if (draft.start != null && input.setSelectionRange) input.setSelectionRange(draft.start, draft.end); }
  }
  $('sheet').scrollTop = scroll;
}
function showFusionTasks(run) {
  if (!run) return;
  const same = sheetKind === 'fusion-tasks' && fusionSheetRun === fusionStateKey(run.computer, run.id);
  const paint = () => {
    fusionSheetRun = fusionStateKey(run.computer, run.id); fusionSheetTask = '';
    openSheet('fusion-tasks', `<h3>${I18N.tr('工作与 Agent')}</h3><p>${esc(ovCompName(run.computer))} · ${esc(fusionStatus(run.status))}</p>`
      + `<p class="hint">${I18N.tr('主 Agent')} · ${esc(OV_AGENT[run.main.app])} → ${run.agents.length} ${I18N.tr('个子 Agent')}</p>`
      + run.works.map(work => {
        const plan = work.plans.find(row => row.id === work.planId);
        return `<section class="fusion-task"><h4>${esc(work.title)} · ${esc(fusionStatus(work.status))}</h4><p>${esc(work.goal)}</p><p class="hint">${esc(work.project.root)}</p>`
          + (plan ? `<details><summary>${I18N.tr('方案与完成标准')}</summary><pre>${esc(plan.summary)}\n${esc(plan.scope.join('\n'))}\n${esc(plan.criteria.map(row => row.id + ' · ' + row.text).join('\n'))}</pre></details>`
            + (!plan.confirmed ? `<button data-fusion-confirm="${esc(plan.id)}">${I18N.tr('确认这个方案')}</button>` : '') : '')
          + run.tasks.filter(task => task.workId === work.id).map(task => `<button class="fusion-run-row" data-fusion-task="${esc(task.id)}"><span class="lbl">${esc(task.goal)}<small>${esc(fusionStatus(task.status))} · ${esc(task.executor === 'main' ? I18N.tr('主 Agent 自己执行') : OV_AGENT[run.assignments.findLast(row => row.taskId === task.id)?.app] || '')}${task.dependsOn.length ? ' · ' + I18N.tr('依赖') + ' ' + esc(task.dependsOn.join(', ')) : ''}</small></span><span>›</span></button>`).join('')
          + run.questions.filter(question => question.workId === work.id && !question.answeredAt).map(question => `<div class="fusion-task"><p>${esc(question.text)}</p><button data-fusion-answer-work="${esc(work.id)}" data-question="${esc(question.id)}">${I18N.tr('回答')}</button></div>`).join('')
          + work.deliveries.map(delivery => fusionAuditHtml('delivery', { workId: work.id, index: delivery.index }, I18N.tr('交付与证据') + ' · ' + delivery.summary)).join('')
          + `<div class="fusion-actions"><button data-fusion-answer-work="${esc(work.id)}">${I18N.tr('补充需求')}</button><button data-fusion-stop data-work="${esc(work.id)}">${I18N.tr('停止这项工作')}</button></div></section>`;
      }).join('')
      + (!run.works.length ? `<p class="hint">${I18N.tr('向主 Agent 提出需求后，它会在这里登记工作与分工。简单问题可以直接回答。')}</p>` : '')
      + `<div class="fusion-actions"><button data-fusion-stop>${I18N.tr('停止整个工作台')}</button><button data-fusion-resume>${I18N.tr('核对并继续')}</button></div>`);
  };
  if (same) fusionPreserveSheet(paint); else paint();
}
function showFusionTask(run, taskId) {
  const task = run.tasks.find(row => row.id === taskId);
  if (!task) return;
  const same = sheetKind === 'fusion-task' && fusionSheetTask === taskId;
  const paint = () => {
    fusionSheetRun = fusionStateKey(run.computer, run.id); fusionSheetTask = taskId;
    const agent = run.agents.find(row => row.id === task.workerId), binding = run.bindings.find(row => row.id === agent?.bindingId);
    const content = binding && fusionContents.get(`${run.computer}|${run.id}|${binding.id}`);
    const attempt = run.attempts.findLast(row => row.taskId === taskId), live = attempt?.live;
    const items = content?.items || [];
    openSheet('fusion-task', `<button data-fusion-tasks>‹ ${I18N.tr('工作与 Agent')}</button><h3>${esc(task.goal)}</h3><p>${esc(fusionStatus(task.status))} · ${esc(task.access)}</p>`
      + (task.dependsOn.length ? `<p class="hint">${I18N.tr('依赖')}：${esc(task.dependsOn.join(', '))}</p>` : '')
      + `<div class="fusion-actions"><button data-fusion-answer-work="${esc(task.workId)}" data-task="${esc(task.id)}">${I18N.tr('给主 Agent 补充')}</button><button data-fusion-stop data-task="${esc(task.id)}">${I18N.tr('停止这个任务')}</button>`
      + (binding ? `<button data-fusion-content="${esc(binding.id)}">${I18N.tr('读取原生内容')}</button>` : '') + '</div>'
      + (content?.earlier ? `<button data-fusion-content="${esc(binding.id)}" data-history="true" data-before="${esc(content.before || '')}">${I18N.tr('加载更早内容')}</button>` : '')
      + `<div class="fusion-content">${items.filter(item => ['human', 'assistant'].includes(item.k)).map(item => `<article class="fusion-task"><small>${I18N.tr(item.k === 'human' ? '任务输入' : '子 Agent')}</small><div class="markdown">${codexMarkdown.render(item.t || '')}</div></article>`).join('')}</div>`
      + task.inputs.map(input => `<div class="fusion-task"><small>${I18N.tr(input.deliveredAt ? '已交给子 Agent' : '已登记，等待主 Agent 安排')}</small><p>${esc(input.text)}</p></div>`).join('')
      + (live && attempt ? fusionNativeHtml(run, attempt) : '')
      + run.attempts.map(row => fusionAuditHtml('attempt', { attemptId: row.id }, `${OV_AGENT[row.app]} · ${row.model} · ${row.effort} · ${fusionStatus(row.status)}`)).join('')
      + fusionAuditHtml('reviews', { taskId }, I18N.tr('主 Agent 的评审')));
  };
  if (same) fusionPreserveSheet(paint); else paint();
}
function showFusionInput(run, workId, taskId = '', questionId = '') {
  const question = run.questions.find(row => row.id === questionId), key = `${run.id}:${workId}:${taskId}:${questionId}`;
  fusionSheetRun = fusionStateKey(run.computer, run.id);
  openSheet('fusion-input', `<h3>${I18N.tr(question ? '回答主 Agent' : workId ? '补充需求' : '交办新需求')}</h3>${question ? `<p>${esc(question.text)}</p>` : ''}<form class="fusion-form" id="fusionInputForm"><textarea name="text" required rows="5">${esc(fusionInputDrafts.get(key) || '')}</textarea><button type="submit" class="primary">${I18N.tr('交给主 Agent')}</button></form>`);
  const form = $('fusionInputForm'); form.oninput = () => fusionInputDrafts.set(key, form.elements.text.value);
  form.onsubmit = event => { event.preventDefault(); if (sendFusion(run.computer, { t: 'fusionInput', runId: run.id, workId, taskId, questionId, text: form.elements.text.value })) { fusionInputDrafts.delete(key); closeSheet(); } };
}
function fusionAuditHtml(kind, ids, label) {
  const view = { kind, ...ids }, key = fusionViewKey(fusionViewOwner.computer, fusionViewOwner.runId, view);
  return `<details class="fusion-task" data-fusion-audit="${esc(JSON.stringify(view))}"><summary>${esc(label)}</summary><div class="fusion-audit-content">${fusionAudits.has(key) ? `<pre>${esc(JSON.stringify(fusionAudits.get(key), null, 2))}</pre>` : I18N.tr('展开后读取完整记录…')}</div></details>`;
}
document.addEventListener('toggle', event => {
  const detail = event.target;
  if (!detail.open || !detail.dataset.fusionAudit || !fusionViewOwner) return;
  const view = JSON.parse(detail.dataset.fusionAudit), owner = fusionViewOwner;
  const key = fusionViewKey(owner.computer, owner.runId, view);
  if (fusionAudits.has(key)) return;
  detail.querySelector('.fusion-audit-content').textContent = I18N.tr('正在读取完整记录…');
  sendFusion(owner.computer, { t: 'fusionRead', runId: owner.runId, view: view.kind, ...view, purpose: 'audit' });
}, true);
function receiveFusion(message, link) {
  if (message.t === 'auth') {
    if (link.authed && ovS.level === 'fusion' && (!ovS.comp || ovS.comp === link.computer.id)) sendFusion(link.computer.id, { t: 'fusionWorkspace' });
    if (link.authed && fusionViewOwner?.computer === link.computer.id && sheetKind === 'fusion-' + fusionViewOwner.kind) {
      const { computer, runId, kind, requestId, ...ids } = fusionViewOwner;
      sendFusion(computer, { t: 'fusionRead', runId, view: kind, requestId, ...ids });
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
    if (projectActive || ownerActive) { status(message.message, false); fusionViewError(message.message); }
    return true;
  }
  if (message.t === 'fusionWorkspace') {
    fusionWorkspaces.set(computer, message);
    if (projectActive && message.browse) showProjects(message.browse, pending.projectOwner);
  } else if (message.t === 'fusionUpdate') {
    const workspace = fusionWorkspaces.get(computer);
    if (workspace) workspace.runs = [message.run, ...workspace.runs.filter(run => run.id !== message.run.id)].sort((a, b) => b.updated - a.updated);
    if (activeFusionController?.id === message.run.id && activeFusionController.computer === computer) {
      activeFusionController = message.run; paintFusionRun(); updateTitle();
    }
  } else if (message.t === 'fusionContent') {
    const key = `${computer}|${message.runId}|${message.binding.id}`, previous = fusionContents.get(key), chat = message.chat;
    if (previous && pending?.purpose === 'history') chat.items = [...chat.items, ...previous.items.filter(row => !chat.items.some(item => item.i === row.i))];
    fusionContents.set(key, chat);
    if (ownerActive && sheetKind === 'fusion-task') showFusionTask(fusionRunFor(computer, message.runId), fusionSheetTask);
  } else if (message.t === 'fusionInputDone') {
    status('已登记，等待主 Agent 处理');
  } else if ((message.t === 'fusionState' || message.t === 'fusionCreated') && message.view.kind !== 'close') {
    const view = message.view, runId = message.runId, run = message.run;
    if (projectActive) { readFusionView(computer, runId, 'config'); return true; }
    if (['attempt', 'delivery', 'reviews'].includes(view.kind)) {
      if (!ownerActive) return true;
      const key = fusionViewKey(computer, runId, view); fusionAudits.set(key, run);
      for (const detail of $('sheet').querySelectorAll('[data-fusion-audit]')) {
        if (fusionViewKey(computer, runId, JSON.parse(detail.dataset.fusionAudit)) === key)
          detail.querySelector('.fusion-audit-content').innerHTML = `<pre>${esc(JSON.stringify(run, null, 2))}</pre>`;
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
      const binding = run.bindings[0];
      if (binding && pending?.type === 'fusionRead') sendFusion(computer, { t: 'fusionContent', runId, bindingId: binding.id });
    } else if (view.kind === 'input' && pending) showFusionInput(run, view.workId || '', view.taskId || '', view.questionId || '');
    if (message.projectTrust) showProjectTrust(message.projectTrust,
      { computer, app: run.main.app, runId, requestId: crypto.randomUUID() });
  }
  if (ovS.level === 'fusion') ovRender();
  return true;
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-fusion-retry], [data-fusion-new], [data-fusion-new-input], [data-fusion-board-tasks], [data-fusion-open], [data-fusion-config], [data-fusion-tasks], [data-fusion-task], [data-fusion-prepare], [data-fusion-trust], [data-fusion-confirm], [data-fusion-stop], [data-fusion-resume], [data-fusion-native], [data-fusion-content], [data-fusion-answer-work]');
  if (!button || button.disabled) return;
  const sheet = button.closest('#sheet') ? fusionSheetRun.split('|') : [];
  const computer = button.dataset.computer || sheet[0] || currentComputer()?.id;
  const runId = sheet[1] || currentFusionRun()?.id, run = fusionRunFor(computer, runId);
  if ('fusionNew' in button.dataset) return showFusionNew(button.dataset.computer || ovS.comp || '');
  if ('fusionRetry' in button.dataset) { const { computer, runId, kind, requestId, ...ids } = fusionViewOwner; return readFusionView(computer, runId, kind, ids); }
  if ('fusionNewInput' in button.dataset) return readFusionView(computer, button.dataset.fusionNewInput, 'input');
  if ('fusionBoardTasks' in button.dataset) return readFusionView(computer, button.dataset.fusionBoardTasks, 'tasks');
  if ('fusionOpen' in button.dataset) return openFusionController(computer, button.dataset.fusionOpen);
  if ('fusionConfig' in button.dataset) return readFusionView(computer, runId, 'config');
  if ('fusionTasks' in button.dataset) return readFusionView(computer, runId, 'tasks');
  if ('fusionTask' in button.dataset) return readFusionView(computer, runId, 'task', { taskId: button.dataset.fusionTask });
  if ('fusionTrust' in button.dataset) return showProjectTrust(run.main.projectTrust, { computer, app: run.main.app, runId, requestId: crypto.randomUUID() });
  if ('fusionPrepare' in button.dataset) { button.disabled = true; return sendFusion(computer, { t: 'fusionPrepare', runId }); }
  if ('fusionConfirm' in button.dataset) return sendFusion(computer, { t: 'fusionConfirm', runId, planId: button.dataset.fusionConfirm });
  if ('fusionStop' in button.dataset) return sendFusion(computer, { t: 'fusionStop', runId, workId: button.dataset.work, taskId: button.dataset.task });
  if ('fusionResume' in button.dataset) return sendFusion(computer, { t: 'fusionResume', runId });
  if ('fusionContent' in button.dataset) return sendFusion(computer, { t: 'fusionContent', runId, bindingId: button.dataset.fusionContent,
    history: button.dataset.history === 'true', before: button.dataset.before || undefined, purpose: button.dataset.history ? 'history' : 'content' });
  if ('fusionAnswerWork' in button.dataset) return readFusionView(computer, runId, 'input', { workId: button.dataset.fusionAnswerWork, taskId: button.dataset.task, questionId: button.dataset.question });
  if ('fusionNative' in button.dataset) {
    const action = { kind: button.dataset.fusionNative, bindingId: button.dataset.binding, item: button.dataset.fusionItem,
      actionId: button.dataset.actionId, label: button.dataset.label, n: Number(button.dataset.n), id: button.dataset.nativeRequest };
    if (action.kind === 'codexRequest') action.fields = [...$('sheet').querySelectorAll('[data-fusion-field]')].filter(input => input.dataset.nativeRequest === action.id).map(input => ({ n: Number(input.dataset.fusionField), value: input.value }));
    if (action.kind === 'question') {
      Object.assign(action, { qi: Number(button.dataset.qi), oi: Number(button.dataset.oi), part: button.dataset.part, questionKey: button.dataset.questionKey });
      const input = [...$('sheet').querySelectorAll('[data-fusion-answer]')].find(input => input.dataset.fusionAnswer === `${action.qi}:${action.oi}`);
      if (input) action.text = input.value;
    }
    sendFusion(computer, { t: 'fusionNative', runId, attemptId: button.dataset.attempt, action });
  }
});
