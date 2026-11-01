const fusionWorkspaces = new Map(), fusionStates = new Map(), fusionConfigDrafts = new Map();
const fusionPending = new Map();
let fusionNewDraft = null, fusionSheetRun = '';
const fusionStateKey = (computer, run) => `${computer}|${run}`;
const fusionStatus = value => I18N.tr(({ ready: '待开始', running: '运行中', waiting: '等待结果', awaiting_user: '等你确认',
  recovering: '核对原生执行', blocked: '执行阻塞', stopping: '正在停止', stopped: '已停止', completed: '已完成',
  queued: '排队中', preparing: '准备中', submitting: '提交中', unknown: '结果待核对', awaiting_review: '等待主 Agent 验收',
  accepted: '已验收', needs_work: '需要补做', failed: '执行失败', cancelled: '已取消' })[value] || value || '');
store.set('fusion-setup-done', null);

function sendFusion(computer, message) {
  const entry = ovList.find(value => value.id === computer), link = entry?.c && computerSockets.get(entry.c.key);
  if (!link?.authed || link.socket.readyState !== 1) { status('这台电脑尚未连接', false); return false; }
  message.requestId ||= crypto.randomUUID();
  fusionPending.set(message.requestId, { computer, type: message.t, runId: message.runId });
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
  const entries = ovList.filter(value => !ovS.comp || value.id === ovS.comp);
  return `<div class="fusion-board"><h2>Fusion</h2><p class="hint">${I18N.tr('选择项目和主 Agent，由主 Agent 决定执行与分工。')}</p>`
    + `<button class="primary" data-fusion-new>${I18N.tr('新建 run')}</button>`
    + entries.map(entry => {
      const workspace = fusionWorkspaces.get(entry.id), runs = workspace?.runs || [];
      return `<section><h3>${esc(entry.name)}</h3><button data-fusion-new data-computer="${esc(entry.id)}">${I18N.tr('在这台电脑新建')}</button>`
        + (!workspace ? `<p class="hint">${ovComputerStatus(entry) === 'online' ? I18N.tr('正在读取 Fusion 状态…') : I18N.tr('电脑尚未连接')}</p>` : !runs.length ? `<p class="hint">${I18N.tr('暂无 Fusion run')}</p>` : runs.map(run =>
          `<button class="fusion-run-row" data-fusion-open="${esc(run.id)}" data-computer="${esc(entry.id)}"><span class="lbl"><span class="fusion-run-title">${esc(run.title)}</span><small>${esc(run.project?.name)} · ${esc(OV_AGENT[run.main.app])} · ${esc(run.main.model || I18N.tr('待配置模型'))}<br>${esc(fusionStatus(run.status))} · ${run.tasks.done}/${run.tasks.total} ${I18N.tr('项任务')}</small></span><span>›</span></button>`).join(''))
        + `</section>`;
    }).join('') + '</div>';
}
function fusionRunFor(computer, id) {
  if (currentComputer()?.id === computer && lastChat?.fusionRun?.id === id) return lastChat.fusionRun;
  return fusionStates.get(fusionStateKey(computer, id));
}
function showFusionNew(computer = ovS.comp || '') {
  fusionNewDraft = { computer, projectId: '', root: '', app: '', tier: 'balanced', requestId: crypto.randomUUID() };
  paintFusionNew();
}
function paintFusionNew() {
  const draft = fusionNewDraft, workspace = fusionWorkspaces.get(draft.computer);
  const computers = ovList.filter(value => !ovS.comp || value.id === ovS.comp);
  openSheet('fusion-create', `<h3>${I18N.tr('新建 Fusion run')}</h3><form class="fusion-form" id="fusionNewForm">`
    + `<label>${I18N.tr('执行电脑')}<select name="computer" required><option value="">${I18N.tr('请选择执行电脑')}</option>${computers.map(entry => `<option value="${esc(entry.id)}" ${entry.id === draft.computer ? 'selected' : ''}>${esc(entry.name)}</option>`).join('')}</select></label>`
    + `<label>${I18N.tr('项目')}<select name="projectId"><option value="">${I18N.tr('选择项目或填写目录')}</option>${(workspace?.projects || []).map(project => `<option value="${esc(project.id)}" ${project.id === draft.projectId ? 'selected' : ''}>${esc(project.root)}${project.host ? ' · ' + esc(project.host) : ''}</option>`).join('')}</select></label>`
    + `<label>${I18N.tr('项目目录')}<input name="root" value="${esc(draft.root)}" placeholder="${I18N.tr('电脑上的真实项目目录')}"></label>`
    + `<label>${I18N.tr('主 Agent 所属软件')}<select name="app" required><option value="">${I18N.tr('请选择软件')}</option>${['cursor', 'devin', 'codex'].map(app => `<option value="${app}" ${app === draft.app ? 'selected' : ''}>${OV_AGENT[app]}</option>`).join('')}</select></label>`
    + fusionTierSelect(draft.tier) + `<p class="hint">${I18N.tr('新建后选择主模型与思考强度，再进入主对话。')}</p><button class="primary" type="submit">${I18N.tr('新建并配置')}</button></form>`);
  const form = $('fusionNewForm');
  form.onchange = event => {
    draft[event.target.name] = event.target.value;
    if (event.target.name === 'computer') { draft.projectId = ''; draft.root = ''; sendFusion(draft.computer, { t: 'fusionWorkspace' }); paintFusionNew(); }
    if (event.target.name === 'projectId') { draft.root = workspace?.projects.find(value => value.id === draft.projectId)?.root || ''; form.elements.root.value = draft.root; }
  };
  form.oninput = event => { draft[event.target.name] = event.target.value; };
  form.onsubmit = event => {
    event.preventDefault();
    const project = workspace?.projects.find(value => value.id === draft.projectId) || { root: draft.root, host: '' };
    if (!draft.computer || !project.root || !draft.app) return status('请选择电脑、项目和主 Agent 软件', false);
    if (sendFusion(draft.computer, { t: 'fusionCreate', requestId: draft.requestId, project,
      main: { app: draft.app, model: '', effort: '' }, tier: draft.tier })) form.querySelector('[type=submit]').disabled = true;
  };
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
  const candidate = run.capabilities.find(value => value.app === draft.app);
  const model = candidate?.models.find(value => value.model === draft.model);
  openSheet('fusion-config', `<h3>${I18N.tr('主 Agent 配置')}</h3><p>${esc(ovCompName(run.computer))} · ${esc(run.project.name)}</p><form class="fusion-form" id="fusionConfigForm">`
    + `<label>${I18N.tr('主 Agent 所属软件')}<select name="app">${['cursor', 'devin', 'codex'].map(app => `<option value="${app}" ${draft.app === app ? 'selected' : ''}>${OV_AGENT[app]}</option>`).join('')}</select></label>`
    + `<button type="button" data-fusion-prepare="${esc(run.id)}" data-computer="${esc(run.computer)}">${I18N.tr('读取当前原生模型')}</button>`
    + (candidate?.error ? `<p class="fusion-error">${esc(candidate.error)}</p>` : '')
    + `<label>${I18N.tr('主模型')}<select name="model" required><option value="">${I18N.tr('请选择主模型')}</option>${(candidate?.models || []).map(value => `<option value="${esc(value.model)}" ${draft.model === value.model ? 'selected' : ''}>${esc(value.model)}</option>`).join('')}</select></label>`
    + (model?.efforts.length ? `<label>${I18N.tr('思考强度')}<select name="effort" required><option value="">${I18N.tr('请选择思考强度')}</option>${model.efforts.map(value => `<option value="${esc(value.label || value)}" ${(value.label || value) === draft.effort ? 'selected' : ''}>${esc(value.label || value)}</option>`).join('')}</select></label>` : '')
    + fusionTierSelect(draft.tier) + (candidate ? `<p class="hint">${esc(candidate.source)} · ${esc(new Date(candidate.at).toLocaleString())}<br>${I18N.tr('金额未知时仅作相对估计；档位不限制模型或思考强度。')}</p>` : '')
    + `<details><summary>${I18N.tr('主动设置预算（可选）')}</summary><label>${I18N.tr('预算限额')}<input name="budgetLimit" type="number" min="0" step="any" value="${esc(draft.budgetLimit)}"></label><label>${I18N.tr('原生单位')}<input name="budgetUnit" value="${esc(draft.budgetUnit)}"></label><p class="hint">${I18N.tr('留空不设预算；没有同单位的原生报价时，主 Agent 需要先向你确认。')}</p></details>`
    + `<button type="submit" class="primary">${I18N.tr('保存配置')}</button></form>`
    + `<div class="fusion-actions"><button data-fusion-open="${esc(run.id)}" data-computer="${esc(run.computer)}" ${!run.main.model ? 'disabled' : ''}>${I18N.tr('进入主对话')}</button><button data-fusion-tasks="${esc(run.id)}" data-computer="${esc(run.computer)}">${I18N.tr('任务与证据')}</button></div>`);
  const form = $('fusionConfigForm');
  form.onchange = event => {
    draft[event.target.name] = event.target.value;
    if (event.target.name === 'app') {
      draft.model = ''; draft.effort = '';
      sendFusion(run.computer, { t: 'fusionConfigure', runId: run.id, main: { app: draft.app, model: '', effort: '' } });
    }
    if (event.target.name === 'model') draft.effort = '';
    if (['app', 'model'].includes(event.target.name)) showFusionConfig(run);
  };
  form.oninput = event => { if (['budgetLimit', 'budgetUnit'].includes(event.target.name)) draft[event.target.name] = event.target.value; };
  form.onsubmit = event => { event.preventDefault(); sendFusion(run.computer, { t: 'fusionConfigure', runId: run.id,
    main: { app: draft.app, model: draft.model, effort: draft.effort || '' }, tier: draft.tier,
    budget: draft.budgetLimit || draft.budgetUnit ? { limit: Number(draft.budgetLimit), unit: draft.budgetUnit } : null }); };
}
function paintFusionRun(run) {
  const on = currentApp === 'fusion';
  document.body.classList.toggle('fusion', on);
  $('fusionHeader').hidden = $('fusionConfig').hidden = $('fusionBar').hidden = !on;
  $('fusionWelcome').hidden = !on || !!lastChat?.items?.length;
  $('meters').hidden = on;
  $('newChat').hidden = on;
  if (!on) return;
  $('pickAgents').hidden = true;
  $('add').hidden = true;
  $('fusionRunConfig').textContent = run ? `${OV_AGENT[run.main.app]} · ${run.main.model || I18N.tr('待配置')}` : I18N.tr('主 Agent 配置');
  $('fusionBar').innerHTML = run ? `<span>${esc(fusionStatus(run.status))}</span>`
    + (run.authorization?.required && !run.authorization.confirmed ? `<button data-fusion-confirm="${esc(run.authorization.planId)}">${I18N.tr('确认当前方案')}</button>` : '')
    + (['blocked', 'stopped', 'stopping'].includes(run.status) ? `<button data-fusion-resume>${I18N.tr('核对并继续')}</button>` : '')
    + (run.blockedReason ? `<span class="fusion-error">${esc(run.blockedReason)}</span>` : '') : '';
  if (run) {
    fusionStates.set(fusionStateKey(run.computer, run.id), run);
    if (sheetKind === 'fusion-tasks' && fusionSheetRun === fusionStateKey(run.computer, run.id)) showFusionTasks(run);
  }
}
function fusionNativeHtml(run, attempt) {
  const buttons = (attempt.live?.items || []).flatMap(item => (item.b || []).map((label, n) =>
    `<button data-fusion-native="button" data-attempt="${esc(attempt.id)}" data-binding="${esc(attempt.bindingId)}" data-item="${esc(item.btnItem || item.i)}" data-n="${n}" data-action-id="${esc(item.actions?.[n] || '')}" data-label="${esc(label)}">${esc(label)}</button>`)).join('');
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
function showFusionTasks(run) {
  if (!run) return;
  const same = sheetKind === 'fusion-tasks' && fusionSheetRun === fusionStateKey(run.computer, run.id);
  const drafts = same ? [...$('sheet').querySelectorAll('[data-fusion-field], [data-fusion-answer]')].map(input => ({ request: input.dataset.nativeRequest, field: input.dataset.fusionField, answer: input.dataset.fusionAnswer, value: input.value,
    focused: input === document.activeElement, selection: input.tagName === 'INPUT' ? [input.selectionStart, input.selectionEnd] : null })) : [];
  const expanded = same ? [...$('sheet').querySelectorAll('details')].map(detail => detail.open) : [];
  const scroll = same ? $('sheet').scrollTop : 0;
  fusionSheetRun = fusionStateKey(run.computer, run.id);
  const attempts = run.attempts;
  openSheet('fusion-tasks', `<h3>${I18N.tr('任务与证据')}</h3><p>${esc(run.project.name)} · ${esc(fusionStatus(run.status))}</p>`
    + (run.authorization ? `<details><summary>${I18N.tr('范围与完成标准')}</summary><pre class="fusion-evidence">${esc(run.authorization.summary)}\n${esc(run.authorization.scope.join('\n'))}\n${esc(run.criteria.map(value => value.id + ' · ' + value.text).join('\n'))}</pre></details>` : '')
    + (run.question ? `<p>${esc(run.question.text)}</p>` : '')
    + (run.blockedReason ? `<p class="fusion-error">${esc(run.blockedReason)}</p>` : '')
    + run.tasks.map(task => `<details class="fusion-task"><summary>${esc(task.id)} · ${esc(task.goal)} · ${esc(fusionStatus(task.status))}</summary><p class="hint">${esc(task.access)} · ${esc(task.dependsOn.join(', '))}</p>`
      + attempts.filter(attempt => attempt.taskId === task.id).map(attempt => `<p>${esc(OV_AGENT[attempt.app])} · ${esc(attempt.model)} · ${esc(attempt.effort)} · ${esc(fusionStatus(attempt.status))}</p>`
        + `<pre>${esc(attempt.result?.text || attempt.error || '')}</pre><details><summary>${I18N.tr('成本选择与执行事实')}</summary><pre>${esc(JSON.stringify({ cost: attempt.cost, durationMs: attempt.durationMs, usage: attempt.usage, native: attempt.native, baseline: attempt.baseline, changes: attempt.changes }, null, 2))}</pre></details>`).join('')
      + `<pre>${esc(JSON.stringify(task.reviews, null, 2))}</pre></details>`).join('')
    + (!run.tasks.length ? `<p class="hint">${I18N.tr('尚未创建执行任务；简单任务可以不创建子 Agent。')}</p>` : '')
    + attempts.filter(attempt => attempt.live).map(attempt => `<section class="fusion-task"><strong>${esc(attempt.taskId || I18N.tr('主 Agent 决策'))}</strong>${fusionNativeHtml(run, attempt)}</section>`).join('')
    + (run.delivery ? `<pre class="fusion-evidence">${esc(JSON.stringify(run.delivery, null, 2))}</pre>` : '')
    + `<div class="fusion-actions"><button data-fusion-stop>${I18N.tr('停止 run')}</button><button data-fusion-resume>${I18N.tr('核对并继续')}</button></div>`);
  [...$('sheet').querySelectorAll('details')].forEach((detail, index) => { detail.open = !!expanded[index]; });
  for (const input of $('sheet').querySelectorAll('[data-fusion-field], [data-fusion-answer]')) {
    const draft = drafts.find(value => value.request === input.dataset.nativeRequest && value.field === input.dataset.fusionField && value.answer === input.dataset.fusionAnswer);
    if (!draft) continue;
    input.value = draft.value;
    if (draft.focused) { input.focus(); if (draft.selection) input.setSelectionRange(...draft.selection); }
  }
  $('sheet').scrollTop = scroll;
}
function receiveFusion(message, link) {
  if (message.t === 'auth') {
    if (link.authed && ovS.level === 'fusion' && (!ovS.comp || ovS.comp === link.computer.id)) sendFusion(link.computer.id, { t: 'fusionWorkspace' });
    return false;
  }
  if (!['fusionWorkspace', 'fusionCreated', 'fusionState', 'fusionUpdate', 'fusionError'].includes(message.t)) return false;
  const computer = link.computer.id;
  if (!link.authed || message.computer !== computer) return true;
  const pending = fusionPending.get(message.requestId);
  fusionPending.delete(message.requestId);
  if (message.t === 'fusionError') {
    status(message.message, false);
    if (pending?.type === 'fusionMessage') failPendingSend(message.requestId, message.message, false);
    if (sheetKind?.startsWith('fusion-')) {
      let error = $('sheet').querySelector('.fusion-response-error');
      if (!error) { error = document.createElement('p'); error.className = 'fusion-error fusion-response-error'; $('sheet').append(error); }
      error.textContent = message.message;
      $('sheet').querySelector('[type=submit]')?.removeAttribute('disabled');
    }
    return true;
  }
  if (message.t === 'fusionWorkspace') {
    fusionWorkspaces.set(computer, message);
    if (sheetKind === 'fusion-create' && fusionNewDraft?.computer === computer) paintFusionNew();
  } else if (message.t === 'fusionUpdate') {
    const workspace = fusionWorkspaces.get(computer);
    if (workspace) workspace.runs = [message.run, ...workspace.runs.filter(run => run.id !== message.run.id)].sort((a, b) => b.updated - a.updated);
  } else {
    const run = message.run;
    fusionStates.set(fusionStateKey(computer, run.id), run);
    if (message.t === 'fusionCreated' && pending?.type === 'fusionCreate' && sheetKind === 'fusion-create') showFusionConfig(run);
    if (message.t === 'fusionState' && pending?.type === 'fusionRead') showFusionConfig(run);
    else if (message.t === 'fusionState' && sheetKind === 'fusion-config' && fusionSheetRun === fusionStateKey(computer, run.id)) showFusionConfig(run);
  }
  if (ovS.level === 'fusion') ovRender();
  return true;
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-fusion-new], [data-fusion-open], [data-fusion-config], [data-fusion-tasks], [data-fusion-prepare], [data-fusion-confirm], [data-fusion-stop], [data-fusion-resume], [data-fusion-native]');
  if (!button || button.disabled) return;
  const sheet = button.closest('#sheet') ? fusionSheetRun.split('|') : [];
  const computer = button.dataset.computer || sheet[0] || currentComputer()?.id;
  const runId = button.dataset.fusionTasks || button.dataset.fusionPrepare || sheet[1] || lastChat?.fusionRun?.id;
  const run = fusionRunFor(computer, runId);
  if ('fusionNew' in button.dataset) return showFusionNew(button.dataset.computer || ovS.comp || '');
  if ('fusionOpen' in button.dataset) { closeSheet(); return ovOpen({ computer, win: 'fusion', windowId: 'fusion', threadId: button.dataset.fusionOpen }); }
  if ('fusionConfig' in button.dataset) return showFusionConfig(run);
  if ('fusionTasks' in button.dataset) return showFusionTasks(run);
  if ('fusionPrepare' in button.dataset) { button.disabled = true; return sendFusion(computer, { t: 'fusionPrepare', runId }); }
  if ('fusionConfirm' in button.dataset) return sendFusion(computer, { t: 'fusionConfirm', runId, planId: button.dataset.fusionConfirm });
  if ('fusionStop' in button.dataset) return sendFusion(run.computer, { t: 'fusionStop', runId });
  if ('fusionResume' in button.dataset) return sendFusion(run.computer, { t: 'fusionResume', runId });
  if ('fusionNative' in button.dataset) {
    const action = { kind: button.dataset.fusionNative, bindingId: button.dataset.binding, item: button.dataset.item,
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
