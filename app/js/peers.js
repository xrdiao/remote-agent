const peerTaskStates = { running: '任务运行中', stopping: '正在停止任务', succeeded: '任务完成', failed: '任务失败',
  cancelled: '任务已停止', timeout: '任务超时且已停止', unknown: '任务结果待确认' };

function peerRelay(computer) {
  const owner = loadComputers().find(row => row.id === computer.id);
  const linked = computerSockets.get(computer.key);
  const relay = linked?.authed ? linked.relay : owner?.relay;
  if (!owner || !relay) throw new Error(I18N.tr('电脑未连接'));
  return { ...owner, relay };
}

async function peerTaskRequest(computer, action, body) {
  const owner = peerRelay(computer);
  const route = '/api/peers' + (action ? '/' + action : '');
  const response = action ? await post(route, body, { computer: owner, timeout: 12000 }) : await api(route, { computer: owner });
  const value = await response.json();
  if ((!action && (response.status === 404 || response.ok && value.v !== 1))
    || (action === 'workspace' && response.status === 404 && value.error === 'not found')) throw new Error(I18N.tr('电脑中继尚不支持新版互控'));
  if (!response.ok) throw new Error(I18N.tr(value.error || '互控请求失败'));
  if ((!action || action === 'workspace') && value.id !== computer.id) throw new Error(I18N.tr('返回结果的电脑身份不匹配'));
  return value;
}

function peerOptions(rows, id, scope = rows) {
  return rows.map(row => {
    const name = row.name || row.id;
    const label = scope.some(other => other.id !== row.id && other.name === name) ? `${row.id.slice(-6)} · ${name}` : name;
    return `<option value="${esc(row.id)}"${row.id === id ? ' selected' : ''}>${esc(label)}</option>`;
  }).join('');
}

function showPeerTasks() {
  const tr = I18N.tr;
  const computers = loadComputers().filter(row => row.id && (!row.discovery || new URL(row.discovery).origin === location.origin));
  const header = `<h3>${tr('电脑互控')}</h3>`;
  if (computers.length < 2) return openSheet('peer-workspace', header + `<p class="hint">${tr('请先从同一个网页入口配对两台电脑。')}</p>`);
  const initial = computers.find(row => row.id === currentComputer()?.id) || computers[0];
  openSheet('peer-workspace', header + `<form id="peerWorkspace">
    <label class="opt"><span class="lbl">${tr('发起电脑')}</span><select name="source">${peerOptions(computers, initial.id)}</select></label>
    <label class="opt"><span class="lbl">${tr('目标电脑')}</span><select name="target">${peerOptions(computers.filter(row => row.id !== initial.id), '', computers)}</select></label>
    <details data-peer-identity hidden><summary></summary><pre class="connection-technical"></pre></details>
    <p class="hint" data-peer-trust hidden>${esc(tr('请在两台电脑本机运行 npm run peer -- status 查看指纹，再运行 npm run peer -- trust <对方 ID> <指纹> 登记。'))}</p>
    <p class="hint" data-peer-scope hidden></p>
    <label class="opt" hidden><span class="lbl">${tr('目标目录')}</span><input name="root" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${tr('目标电脑上的绝对路径')}" required disabled></label>
    <label class="opt" hidden><span class="lbl">${tr('允许使用目标终端')}</span><input name="terminal" type="checkbox" required disabled></label>
    <label class="opt" hidden><span class="lbl">${tr('选择 Agent')}</span><select name="agent" required disabled></select></label>
    <button class="opt" type="submit" disabled>${tr('进入会话')}</button>
    <button class="opt" type="button" data-peer-revoke hidden>${tr('撤销工作区授权')}</button><p class="hint" role="status"></p>
    <button class="opt" type="button" data-peer-presets>${tr('预设任务管理')}</button></form>`);
  const form = $('peerWorkspace'), { source, target, root, terminal, agent } = form.elements;
  const scope = form.querySelector('[data-peer-scope]'), note = form.querySelector('[role="status"]');
  const identity = form.querySelector('[data-peer-identity]'), trustHint = form.querySelector('[data-peer-trust]');
  const submit = form.querySelector('[type="submit"]'), revoke = form.querySelector('[data-peer-revoke]');
  const selected = field => computers.find(row => row.id === field.value);
  const isOpen = () => form.isConnected && sheetKind === 'peer-workspace';
  let sourceInfo, targetInfo, grant, verified = false, busy = false;

  function fingerprintStatus(local, remote) {
    const registered = local.workspaceFingerprints?.[remote.id];
    return !registered ? '对方本机尚未登记' : registered === remote.fingerprint ? '对方核对通过' : '对方登记的指纹不匹配';
  }

  function render() {
    const needsGrant = verified && !grant;
    identity.hidden = !sourceInfo;
    trustHint.hidden = !sourceInfo || verified;
    if (sourceInfo) {
      identity.querySelector('summary').textContent = tr(verified ? '公钥指纹已核对' : '需要核对公钥指纹');
      identity.querySelector('pre').textContent = [[sourceInfo, targetInfo, '发起电脑'], [targetInfo, sourceInfo, '目标电脑']]
        .map(([computer, other, label]) => `${tr(label)} · ${computer.id}\n${computer.fingerprint}\n${tr(fingerprintStatus(other, computer))}`).join('\n\n');
    }
    root.closest('label').hidden = terminal.closest('label').hidden = !needsGrant;
    scope.hidden = !verified;
    scope.textContent = grant ? `${tr('目标目录')} · ${grant.root}` : tr('授权后，发起电脑的 Agent 可以修改该目录的文件，并以目标中继的账户权限运行终端命令。');
    agent.closest('label').hidden = !agent.options.length;
    revoke.hidden = !grant;
    submit.textContent = tr(needsGrant ? '授权并进入会话' : verified ? '进入会话' : sourceInfo ? '刷新指纹状态' : '重试连接');
    for (const field of form.elements) field.disabled = busy || !!field.closest('[hidden]');
  }

  async function refresh() {
    sourceInfo = targetInfo = grant = null;
    verified = false;
    root.value = ''; terminal.checked = false; agent.replaceChildren();
    const status = async computer => {
      const info = await peerTaskRequest(computer);
      if (info.workspaceVersion !== 2 || typeof info.fingerprint !== 'string') throw new Error(tr('电脑中继尚不支持新版互控'));
      return info;
    };
    const [a, b] = await Promise.allSettled([status(selected(source)), status(selected(target))]);
    const failures = [a, b].map((row, i) => row.status === 'rejected'
      ? `${tr(i === 0 ? '发起电脑' : '目标电脑')} · ${row.reason.message}` : '').filter(Boolean);
    if (failures.length) throw new Error(failures.join('\n'));
    sourceInfo = a.value;
    targetInfo = b.value;
    grant = targetInfo.workspaces.find(row => row.source === source.value);
    verified = sourceInfo.workspaceFingerprints?.[targetInfo.id] === targetInfo.fingerprint
      && targetInfo.workspaceFingerprints?.[sourceInfo.id] === sourceInfo.fingerprint;
    identity.open = !verified;
  }

  async function run(action) {
    if (busy) return;
    busy = true;
    note.textContent = tr('正在处理互控请求…');
    render();
    try {
      await action();
      note.textContent = '';
    } catch (error) {
      note.textContent = ['TypeError', 'AbortError', 'TimeoutError'].includes(error.name) ? tr('电脑未响应，请重试') : error.message;
    } finally { busy = false; if (isOpen()) render(); }
  }

  form.onchange = event => {
    if (event.target !== source && event.target !== target) return;
    if (event.target === source) target.innerHTML = peerOptions(computers.filter(row => row.id !== source.value), target.value, computers);
    run(refresh);
  };
  form.querySelector('[data-peer-presets]').onclick = () => showPeerPresets(computers, source.value, target.value);
  revoke.onclick = () => run(async () => {
    await peerTaskRequest(selected(target), 'workspace-revoke', { grant: grant.id });
    await refresh();
  });
  form.onsubmit = async event => {
    event.preventDefault();
    await run(async () => {
      if (!verified) return refresh();
      const computer = selected(source), destination = selected(target);
      if (!grant) ({ grant } = await peerTaskRequest(destination, 'workspace-grant', { source: computer.id,
        publicKey: sourceInfo.publicKey, root: root.value, terminal: terminal.checked }));
      const session = await peerTaskRequest(computer, 'workspace', { target: destination.id,
        workspace: grant.id, address: peerRelay(destination).relay });
      if (!isOpen()) return;
      const win = agent.value ? session.agents.find(row => row.id === agent.value) : session.agents.length === 1 ? session.agents[0] : null;
      if (!win) {
        agent.replaceChildren(new Option(tr('选择 Agent'), ''), ...session.agents.map(row => new Option(row.title, row.id)));
        return;
      }
      closeSheet();
      return ovOpen({ computer: computer.id, win: win.id, project: { root: session.root } });
    });
  };
  run(refresh);
}

function showPeerPresets(computers, sourceId, targetId) {
  const tr = I18N.tr;
  const header = `<h3>${tr('预设任务管理')}</h3>`;
  openSheet('peer-tasks', header + `<div id="peerTasks">
    <p class="hint">${tr('由目标电脑运行自己登记的任务，无需安装 Agent。')}</p>
    <label class="opt"><span class="lbl">${tr('目标电脑')}</span><select data-peer-select="target">${peerOptions(computers, targetId)}</select></label>
    <label class="opt"><span class="lbl">${tr('发起电脑')}</span><select data-peer-select="source">${peerOptions(computers.filter(row => row.id !== targetId), sourceId, computers)}</select></label>
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
      + (tasks.length ? `<label class="opt"><span class="lbl">${tr('预设任务')}</span><select data-peer-select="task"${busy ? ' disabled' : ''}>${peerOptions(tasks, chosen)}</select></label>` : '')
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
      if (field === 'target') sourceSelect.innerHTML = peerOptions(computers.filter(row => row.id !== targetSelect.value), sourceSelect.value, computers);
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
