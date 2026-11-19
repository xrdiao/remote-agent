const peerTaskStates = { running: '任务运行中', stopping: '正在停止任务', succeeded: '任务完成', failed: '任务失败',
  cancelled: '任务已停止', timeout: '任务超时且已停止', unknown: '任务结果待确认' };

async function peerTaskRequest(computer, action, body) {
  const linked = computerSockets.get(computer.key)?.computer;
  const owner = linked?.relay ? linked : loadComputers().find(row => row.id === computer.id);
  if (!owner?.relay) throw new Error(I18N.tr('电脑未连接'));
  const route = '/api/peers' + (action ? '/' + action : '');
  const response = action ? await post(route, body, { computer: owner, timeout: 12000 }) : await api(route, { computer: owner });
  const value = await response.json();
  if (!action && (response.status === 404 || response.ok && value.v !== 1)) throw new Error(I18N.tr('电脑中继尚不支持新版互控'));
  if (!response.ok) throw new Error(I18N.tr(value.error || '互控请求失败'));
  if (!action && value.id !== computer.id) throw new Error(I18N.tr('返回结果的电脑身份不匹配'));
  return value;
}

function showPeerTasks() {
  const tr = I18N.tr;
  const computers = loadComputers().filter(row => row.id && (!row.discovery || new URL(row.discovery).origin === location.origin));
  const header = `<h3>${tr('电脑互控')}</h3>`;
  if (computers.length < 2) return openSheet('peer-tasks', header + `<p class="hint">${tr('请先从同一个网页入口配对两台电脑。')}</p>`);
  const current = currentComputer()?.id;
  const targetInitial = computers.find(row => row.id === current) || computers[0];
  const sourceInitial = computers.find(row => row.id !== targetInitial.id);
  const options = (rows, id, scope = rows) => rows.map(row => {
    const name = row.name || row.id;
    const label = scope.some(other => other.id !== row.id && other.name === name) ? `${row.id.slice(-6)} · ${name}` : name;
    return `<option value="${esc(row.id)}"${row.id === id ? ' selected' : ''}>${esc(label)}</option>`;
  }).join('');
  openSheet('peer-tasks', header + `<div id="peerTasks">
    <p class="hint">${tr('由目标电脑运行自己登记的任务，无需安装 Agent。')}</p>
    <label class="opt"><span class="lbl">${tr('目标电脑')}</span><select data-peer-select="target">${options(computers, targetInitial.id)}</select></label>
    <label class="opt"><span class="lbl">${tr('发起电脑')}</span><select data-peer-select="source">${options(computers.filter(row => row.id !== targetInitial.id), sourceInitial.id, computers)}</select></label>
    <div data-peer-content></div><p class="hint" role="status" data-peer-note></p></div>`);
  const root = $('peerTasks'), targetSelect = root.querySelector('[data-peer-select="target"]'), sourceSelect = root.querySelector('[data-peer-select="source"]');
  const content = root.querySelector('[data-peer-content]'), note = root.querySelector('[data-peer-note]');
  const selected = select => computers.find(row => row.id === select.value);
  let sourceInfo = null, targetInfo = null, chosen = '', snapshot = null, busy = false;
  const matched = () => targetInfo?.grants.find(row => row.source === sourceSelect.value && row.task === chosen);
  const jobKey = grant => `peer-job:${targetSelect.value}:${grant.id}`;
  const stored = grant => store.get(jobKey(grant));
  const button = (act, title, disabled, value = '') => `<button class="opt" data-peer-action="${act}" data-peer-grant="${esc(value)}"${disabled ? ' disabled' : ''}>${esc(title)}</button>`;

  function render() {
    const target = targetSelect.value, grant = matched();
    const tasks = targetInfo?.tasks || [], task = tasks.find(row => row.id === chosen);
    const ready = !!sourceInfo?.targets.includes(target);
    const jobId = grant && stored(grant);
    const job = snapshot?.id === jobId ? snapshot : null;
    const active = ['running', 'stopping'].includes(job?.state);
    targetSelect.disabled = sourceSelect.disabled = busy;
    const info = !targetInfo ? '' : !targetInfo.canRun ? tr('目标电脑的平台暂不支持执行任务')
      : !tasks.length ? tr('目标电脑未登记预设任务') : sourceInfo && !ready ? tr('请先在发起电脑登记目标地址') : '';
    content.innerHTML = (info ? `<p class="hint">${esc(info)}</p>` : '')
      + (tasks.length ? `<label class="opt"><span class="lbl">${tr('预设任务')}</span><select data-peer-select="task"${busy ? ' disabled' : ''}>${options(tasks, chosen)}</select></label>` : '')
      + (task && !grant ? button('grant', tr('允许发起电脑执行此任务'), busy || !sourceInfo) : '')
      + (task && grant ? `<p class="hint">${tr('目标电脑已授权')}</p><div class="optRow" data-peer-actions>`
        + button('start', tr(jobId && !job ? '按原任务号重试' : '发起任务'), busy || !ready || active)
        + (jobId ? button('read', tr('查询状态'), busy || !ready) + button('cancel', tr('停止任务'), busy || !ready || !!job && job.state !== 'running') : '') + '</div>' : '')
      + (jobId ? `<p class="hint" data-peer-job>${esc(jobId)} · ${tr(peerTaskStates[job?.state] || '任务结果待确认')}</p>` : '')
      + (job?.error || job?.output ? `<pre class="connection-technical" data-peer-output>${esc([job.error, job.output].filter(Boolean).join('\n'))}</pre>` : '')
      + (job?.truncated ? `<p class="hint">${tr('输出已截断')}</p>` : '')
      + (targetInfo?.grants.filter(row => row.source === sourceSelect.value).map(row =>
        button('revoke', `${tr('撤销任务授权')} · ${tasks.find(task => task.id === row.task)?.name || row.task}`, busy, row.id)).join('') || '')
      + button('refresh', tr('刷新互控状态'), busy);
  }

  async function refresh() {
    const [a, b] = await Promise.allSettled([peerTaskRequest(selected(sourceSelect)), peerTaskRequest(selected(targetSelect))]);
    sourceInfo = a.status === 'fulfilled' ? a.value : null;
    targetInfo = b.status === 'fulfilled' ? b.value : null;
    if (!targetInfo?.tasks.some(task => task.id === chosen)) chosen = targetInfo?.tasks[0]?.id || '';
    note.textContent = [a, b].map((row, i) => row.status === 'rejected'
      ? `${tr(i === 0 ? '发起电脑' : '目标电脑')}：${row.reason.message}` : '').filter(Boolean).join(' · ');
  }

  async function change(action) {
    if (busy) return;
    busy = true; note.textContent = tr('正在处理互控请求…'); render();
    try { await action(); }
    catch (error) { note.textContent = error.name === 'AbortError' || error.name === 'TypeError' ? tr('电脑未响应，请刷新互控状态') : error.message; }
    finally { busy = false; if (root.isConnected) render(); }
  }

  root.addEventListener('change', event => {
    const field = event.target.dataset.peerSelect;
    if (field === 'task') { chosen = event.target.value; snapshot = null; render(); }
    else if (field === 'target' || field === 'source') {
      if (field === 'target') sourceSelect.innerHTML = options(computers.filter(row => row.id !== targetSelect.value), sourceSelect.value, computers);
      sourceInfo = targetInfo = snapshot = null;
      change(refresh);
    }
  });
  root.addEventListener('click', event => {
    const control = event.target.closest('[data-peer-action]');
    if (!control || busy) return;
    const action = control.dataset.peerAction, source = selected(sourceSelect), target = selected(targetSelect), grant = matched();
    change(async () => {
      if (action === 'refresh') return refresh();
      if (action === 'grant') {
        await peerTaskRequest(target, 'grant', { source: source.id, publicKey: sourceInfo.publicKey, task: chosen });
        return refresh();
      }
      if (action === 'revoke') {
        const result = await peerTaskRequest(target, 'revoke', { grant: control.dataset.peerGrant });
        await refresh();
        note.textContent = result.warning ? tr(result.warning) : tr(result.stopRequested ? '已撤销授权，目标电脑正在停止任务' : '目标电脑已撤销授权');
        return;
      }
      const before = stored(grant);
      const id = action === 'start' && (!before || snapshot?.id === before) ? `${Date.now()}-${crypto.randomUUID()}` : before;
      if (action === 'start') store.set(jobKey(grant), id);
      snapshot = (await peerTaskRequest(source, 'send', { target: target.id, grant: grant.id, action, id, task: grant.task })).job;
      note.textContent = '';
    });
  });
  change(refresh);
}
