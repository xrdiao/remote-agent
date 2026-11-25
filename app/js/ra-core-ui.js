/* RA Core coordinates explicit, origin-bound requests from the overview. */
const RaCoreUI = (() => {
  const tr = I18N.tr;
  const path = '/api/ra-core/';
  const defaultAction = 'list-files', ttlSeconds = 300, maxUses = 1, cacheTtl = 20000;
  const fileActions = new Set(['list-files', 'read-file', 'create-file', 'save-file']);
  const textActions = new Set(['create-file', 'save-file', 'send-terminal']);
  const workRefreshMs = 5000;
  const writeLabels = { activate: '核验并激活', invoke: '列出工作区文件', revoke: '撤销激活' };
  const digest = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
  const actions = {
    'list-files': '列出工作区文件', 'read-file': '读取文件', 'create-file': '创建文件', 'save-file': '保存文件',
    'open-terminal': '打开终端', 'read-terminal': '读取终端', 'send-terminal': '向终端发送输入',
    'interrupt-terminal': '中断终端', 'close-terminal': '关闭终端',
  };
  const labels = {
    ready: '可用', unavailable: '不可用', unverified: '待核验', unregistered: '未登记',
    active: '已激活', expired: '已过期', exhausted: '用量已用完', revoked: '已撤销', stale: '绑定已变更',
    RESERVED: '已登记操作', STARTED: '正在执行', SUCCEEDED: '已完成', FAILED: '执行失败', UNKNOWN: '结果待核对',
  };
  const errors = {
    unauthorized: '设备授权不可用，请检查配对或二次验证。',
    pairing_unavailable: '设备配对已失效。',
    unsupported: '当前中继未提供 RA Core。',
    request_failed: '读取失败，请检查中继连接后刷新。',
    journal_unavailable: '操作日志不可用，请检查中继状态。',
    ra_core_unavailable: 'RA Core 暂时不可用。',
    origin_unavailable: '原会话未就绪，或该会话的记录已不可用。',
    origin_stale: '原会话已切换，请在对应卡片重新打开。',
    binding_stale: '远端工作区绑定已变更，请检查电脑互控中的登记。',
    peer_untrusted: '目标指纹未核验，请检查电脑互控中的登记。',
    peer_denied: '目标电脑拒绝请求，请检查工作区授权和指纹。',
    peer_unverified: '未收到目标的可验证回执，请检查 B 的连接和工作区授权。',
    peer_outcome_unknown: '未收到可验证的操作回执，请在工作页核对结果。',
    peer_rejected: '目标电脑拒绝执行，请检查工作区是否可用。',
    activation_exists: '这个工作区已有有效激活，请刷新后检查。',
    activation_required: '当前操作需要有效激活。',
    activation_unavailable: '激活已失效，请刷新后检查授权状态。',
    action_not_activated: '激活已失效，请刷新后检查授权状态。',
    activation_exhausted: '用量已用完',
    invalid_workspace_path: '请输入工作区内的相对路径，不允许上级目录、绝对路径或空路径。',
    invalid_workspace_text: '输入内容无效或超过操作大小限制。',
  };
  const snapshots = new Map(), submissions = new Map(), uncertainInvokes = new Map(), detached = new Set();
  let view = null, access = null, preferredOrigin = '';
  const actionLabel = id => tr(actions[id] || id);
  const bytes = value => new TextEncoder().encode(value).length;
  const operationArgs = state => {
    const action = state.action;
    if (!Object.hasOwn(actions, action)) return null;
    const path = fileActions.has(action) ? state.path ?? (action === 'list-files' ? '.' : '') : null;
    if (fileActions.has(action) && (typeof path !== 'string' || !path || bytes(path) > 1024
      || /[\\\u0000-\u001f\u007f]/.test(path) || /^[a-z]:/i.test(path)
      || (path !== '.' || action !== 'list-files') && path.split('/').some(part => !part || part === '.' || part === '..'))) return null;
    const text = textActions.has(action) ? state.text ?? '' : null;
    if (textActions.has(action) && (typeof text !== 'string' || text.includes('\0')
      || bytes(text) > (fileActions.has(action) ? 32768 : 8192)
      || !fileActions.has(action) && (!text.trim() || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)))) return null;
    return { ...(fileActions.has(action) ? { path } : {}), ...(textActions.has(action) ? { text } : {}) };
  };
  const errorText = error => {
    const code = error?.code || error;
    return errors[code] ? tr(errors[code]) : /^[a-z][a-z0-9_]+$/.test(code || '')
      ? tr('请求失败') + ' · ' + code : tr(errors.request_failed);
  };
  const stateBadge = state => `<span class="ra-label" data-state="${esc(state)}">${esc(tr(labels[state] || '状态待确认'))}</span>`;
  const message = (text, error = false) => `<p class="ra-status${error ? ' ra-error' : ''}" role="status">${esc(text)}</p>`;
  const button = (event, label, attrs = '') => `<button type="button" class="ra-control" data-ov="${event}" ${attrs}>${esc(tr(label))}</button>`;
  const nodeName = (id, entries = ovList) => entries.find(row => row.id === id)?.name || id;
  const appName = app => OV_AGENT[app] || app;
  const displayTime = at => at ? new Date(at).toLocaleString() : '';
  const ref = row => `${appName(row.app)} · ${row.threadId}`;
  const fail = code => Object.assign(new Error(code), { code });
  const ownOrigin = (owner, origin) => digest(origin?.id) && origin.computerId === owner.id && origin.deviceId === owner.device;
  const selectedOrigin = (origins, app, threadId) => {
    const rows = origins.filter(row => row.app === app && row.threadId === threadId);
    return rows.length === 1 ? rows[0] : null;
  };

  function source(entry) {
    const link = entry?.c && !entry.foreign && linkForComputerKey(entry.c.key);
    if (!link?.authed || link.socket?.readyState !== 1 || !link.relay || navigator.onLine === false) return null;
    const owner = loadComputers().find(row => row.id === entry.id && row.key === entry.c.key && row.token === link.computer.token);
    return owner?.device ? { owner: { ...owner, relay: link.relay }, link } : null;
  }

  async function get(owner, route, signal) {
    const target = path + route, headers = await entryHeaders(owner, 'GET', target);
    signal.throwIfAborted();
    const response = await fetch(owner.relay + target, { headers, cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw fail(response.status === 401 ? 'unauthorized' : response.status === 404 ? 'unsupported' : body.error || 'request_failed');
    return body;
  }

  async function snapshot(owner, signal, originId = '') {
    const data = await get(owner, 'snapshot' + (originId ? '?' + new URLSearchParams({ originId }) : ''), signal);
    if (data.version !== 1 || !Array.isArray(data.nodes) || !data.nodes.some(node => node.kind === 'local' && node.id === owner.id)
      || !Array.isArray(data.origins) || !Array.isArray(data.activations)) throw fail('invalid_snapshot');
    return { ...data, origins: data.origins.filter(row => ownOrigin(owner, row)),
      activations: data.activations.filter(row => row.originId === originId) };
  }

  async function mutate(owner, event, value, signal, beforeSend) {
    const target = path + event, body = JSON.stringify(value);
    const headers = { 'content-type': 'application/json', ...await entryHeaders(owner, 'POST', target, body) };
    signal.throwIfAborted();
    const timeout = AbortSignal.timeout(20000);
    beforeSend();
    // After dispatch, keep reading the original response even if the sheet closes.
    const response = await fetch(owner.relay + target, { method: 'POST', headers, body, cache: 'no-store', signal: timeout });
    const reply = await response.json();
    return { value: reply, ok: response.ok, error: response.status === 401 ? 'unauthorized' : reply.error || 'request_failed' };
  }

  function originHistory(owner, found) {
    const key = `ra-core-work-origins:${owner.id}:${owner.device}`;
    let rows;
    try { rows = JSON.parse(store.get(key) || '[]'); } catch {}
    rows = Array.isArray(rows) ? rows.filter(row => ownOrigin(owner, row)) : [];
    if (found) {
      const { id, app, threadId, computerId, deviceId } = found;
      rows = [{ id, app, threadId, computerId, deviceId }, ...rows.filter(row => row.id !== id)].slice(0, 100);
      store.set(key, JSON.stringify(rows));
    }
    return rows;
  }

  async function loadView(state, force = false) {
    const { owner, controller, binding, level } = state;
    if (!owner) return;
    state.loading = true;
    state.error = '';
    const cacheKey = `${owner.id}|${owner.device}|${owner.relay}`;
    try {
      const cached = snapshots.get(cacheKey);
      const recent = !force && cached?.socket === state.socket && cached.binding === binding.key && Date.now() - cached.at < cacheTtl;
      const data = recent ? cached.data : await snapshot(owner, controller.signal);
      if (view !== state || controller.signal.aborted) return;
      if (!recent) {
        snapshots.set(cacheKey, { socket: state.socket, binding: binding.key, at: Date.now(), data });
        if (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value);
      }
      const current = selectedOrigin(data.origins, binding.app, binding.thread);
      if (level === 'fusion') {
        state.data = data;
        state.origins = [...new Map([...data.origins, ...originHistory(owner)].map(row => [row.id, row])).values()];
        const next = state.origins.find(row => row.id === state.originId) || state.origins.find(row => row.id === preferredOrigin)
          || current || state.origins[0];
        preferredOrigin = '';
        if (next) loadWork(state, next.id);
      } else {
        let scoped = data, accessOrigin = null;
        if (current) {
          try {
            scoped = await snapshot(owner, controller.signal, current.id);
            if (selectedOrigin(scoped.origins, binding.app, binding.thread)?.id !== current.id) throw fail('origin_stale');
            accessOrigin = current;
          } catch (error) {
            if (error.code !== 'origin_unavailable') throw error;
          }
        }
        if (view !== state || controller.signal.aborted) return;
        state.data = scoped;
        state.accessOrigin = accessOrigin;
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        snapshots.delete(cacheKey);
        state.data = state.accessOrigin = null;
        state.error = errorText(error);
      }
    } finally {
      state.loading = false;
      if (view === state && !controller.signal.aborted) ovRender();
    }
  }

  async function loadWork(state, originId, polling = false) {
    clearTimeout(state.workTimer);
    state.workController?.abort();
    const controller = state.workController = new AbortController();
    const signal = AbortSignal.any([state.controller.signal, controller.signal]);
    state.originId = originId;
    if (!polling) {
      state.operations = [];
      state.workError = '';
      state.workLoading = true;
    }
    try {
      const rows = await get(state.owner, 'work?' + new URLSearchParams({ originId }), signal);
      if (signal.aborted || view !== state) return;
      state.operations = rows.operations.filter(row => row.origin?.id === originId && ownOrigin(state.owner, row.origin));
      state.workError = '';
      if (state.operations.length) originHistory(state.owner, state.operations[0].origin);
      reconcileInvokes(state.operations);
    } catch (error) {
      if (!signal.aborted) state.workError = errorText(error);
    } finally {
      if (view === state && !signal.aborted) {
        state.workLoading = false;
        if (state.operations?.some(row => row.state === 'RESERVED' || row.state === 'STARTED')) {
          state.workTimer = setTimeout(() => loadWork(state, originId, true), workRefreshMs);
        }
        ovRender();
      }
    }
  }

  function sync(nav, entries) {
    if (access && !locked(access)) detachAccess(access);
    const visible = document.visibilityState === 'visible' && !document.body.classList.contains('conv');
    const level = visible && ['devices', 'fusion'].includes(nav.level) ? nav.level : '';
    const id = level ? nav.comp || currentComputer()?.id : '';
    const entry = id && entries.find(row => row.id === id);
    const connection = level ? source(entry) : null;
    const binding = connection?.link.binding;
    const current = connection && currentComputer();
    const foregroundReady = current && current.id === id && windowReady && !selectedConversation.navigation && lastChat?.thread === current.threadId;
    const parkedReady = connection && computerBindingReady(connection.link);
    const app = foregroundReady ? currentApp : parkedReady ? binding.app : '';
    const thread = foregroundReady ? current.threadId : parkedReady ? binding.threadId : '';
    const key = JSON.stringify([level, id, connection?.owner.device, connection?.owner.relay, app, thread]);
    const socket = connection?.link.socket;
    if (view?.key === key && view.socket === socket) return;
    const previous = view;
    previous?.controller?.abort();
    clearTimeout(previous?.workTimer);
    view = level ? { key, socket, id, level, owner: connection?.owner, binding: { app, thread, key: JSON.stringify([app, thread]) },
      controller: new AbortController(), loading: !!connection,
      originId: previous?.id === id ? previous.originId : '' } : { key, socket };
    if (connection) {
      const state = view;
      queueMicrotask(() => { if (view === state) loadView(state); });
    }
  }

  function refresh() {
    if (!view?.owner || view.loading) return;
    loadView(view, true);
    ovRender();
  }

  function selectOrigin(id) {
    if (!view?.origins?.some(row => row.id === id)) return;
    loadWork(view, id);
    ovRender();
  }

  function summary(row) {
    const data = row.result || {};
    return [Number.isSafeInteger(data.entryCount) ? `${tr('目录条目')} ${data.entryCount}` : '',
      Number.isSafeInteger(data.size) ? `${data.size} B` : '', data.truncated ? tr('结果已截断') : '',
      data.sent ? tr('输入已提交') : '', data.closed ? tr('终端已关闭') : '',
      Number.isSafeInteger(data.exitCode) ? `${tr('退出码')} ${data.exitCode}` : ''].filter(Boolean).join(' · ');
  }

  function rowCard(row) {
    const state = labels[row.state] ? row.state : 'UNKNOWN';
    return `<article class="ra-card" data-ov-node="ra-operation:${esc(row.id)}"><strong>${esc(actionLabel(row.action))}</strong>
      <p>${stateBadge(state)} · ${esc(displayTime(row.finishedAt || row.startedAt || row.reservedAt))}</p>
      <p class="ovRaw">${esc(ref(row.origin))}</p><p class="ovRaw">${esc(nodeName(row.nodeId))} · ${esc(row.workspaceId)}</p>
      ${row.error ? message(errorText(row.error), true) : summary(row) ? message(summary(row)) : ''}
      ${button('ra-operation', '查看回执', `data-id="${esc(row.id)}"`)}</article>`;
  }

  function heading(id, label) {
    return `<div class="ra-section-head"><h2 id="${id}">${tr(label)}</h2>${button('ra-refresh', '刷新',
      (view?.loading || !view?.owner ? 'disabled' : '') + ' data-ra-refresh')}</div>`;
  }

  function viewStatus() {
    if (view?.loading) return message(tr('正在读取中继状态…'));
    if (view?.error) return message(view.error, true);
    if (!view?.owner) return message(tr('请选择已连接并通过配对验证的电脑。'));
    return '';
  }

  const viewState = () => view?.loading ? 'loading' : view?.error ? 'error' : view?.data ? 'ready' : 'unavailable';

  function work() {
    const origins = view?.origins || [], operations = view?.operations || [];
    const status = viewStatus();
    const picker = origins.length ? `<label class="ra-origin">${tr('原会话')}<select data-ra-origin>${origins.map(row =>
      `<option value="${esc(row.id)}"${row.id === view.originId ? ' selected' : ''}>${esc(ref(row))}</option>`).join('')}</select></label>` : '';
    const records = view?.workLoading ? 'loading' : view?.workError ? 'error' : 'ready';
    return `<section class="ra-section" data-ra-work="${viewState()}" data-ra-records="${records}" data-ra-source="${esc(view?.id || '')}" aria-labelledby="ra-work-title">
      ${heading('ra-work-title', '关联操作')}${status}${picker}
      ${view?.workLoading ? message(tr('正在读取操作记录…')) : view?.workError ? message(view.workError, true) : ''}
      ${operations.length ? `<div class="ra-grid">${operations.map(rowCard).join('')}</div>`
        : !status && !view?.workLoading && !view?.workError ? message(tr(origins.length ? '这个会话暂无关联操作。' : '暂无可读取的原会话。打开概览中的会话卡片以查看跨设备操作。')) : ''}
      </section>`;
  }

  function capabilities(rows = [], blocked = false) {
    return rows.length ? `<ul class="ra-list">${rows.map(row => {
      const name = row.id?.startsWith('agent:') ? appName(row.id.slice(6))
        : tr(({ files: '文件', terminal: '终端', phone: '手机' })[row.id] || row.id);
      const state = blocked ? 'unavailable' : ['ready', 'unavailable', 'unverified'].includes(row.availability) ? row.availability : 'unverified';
      return `<li data-ra-capability="${esc(row.id)}"><span>${esc(name)}</span>${stateBadge(state)}</li>`;
    }).join('')}</ul>` : '';
  }

  function activationInfo(row) {
    if (!row) return tr('远端授权待核验');
    const state = row.state === 'active' && row.expiresAt <= Date.now() ? 'expired' : row.state;
    return [tr(labels[state] || '状态待确认'), `${tr('授权核验')} ${displayTime(row.grantVerifiedAt)}`,
      `${tr('到期')} ${displayTime(row.expiresAt)}`, `${tr('用量')} ${row.uses}/${row.maxUses}`].join(' · ');
  }

  function devices(entries) {
    const scope = view?.id, nodeMap = new Map((view?.data?.nodes || []).map(node => [node.id, node]));
    const controls = `aria-haspopup="dialog" data-id="${esc(scope || '')}"${scope ? '' : ' disabled'}`;
    const ids = [...new Set([...nodeMap.keys(), ...entries.filter(e => !ovS.comp || e.id === scope).map(e => e.id)])];
    const cards = ids.map(id => {
      const node = nodeMap.get(id), entry = entries.find(row => row.id === id);
      const link = entry?.c && linkForComputerKey(entry.c.key);
      const status = !entry || entry.foreign ? 'unverified' : link?.authed && link.socket?.readyState === 1
        ? 'ready' : ['offline', 'auth', 'old'].includes(ovComputerStatus(entry)) ? 'unavailable' : 'unverified';
      const connection = !entry ? '中继已登记节点' : entry.foreign ? '从其网页入口连接'
        : status === 'ready' ? '配对连接在线' : link?.rejected ? '需要重新授权' : status === 'unavailable' ? '配对连接不可用' : '配对连接待确认';
      const remote = node?.kind === 'peer';
      return `<article class="ra-card" data-ov-node="ra-node:${esc(id)}" data-ra-node="${esc(id)}" data-ra-connection="${status}">
        <strong class="ovRaw">${esc(nodeName(id, entries))}</strong>${message(tr(connection))}
        ${node?.kind === 'local' ? capabilities(node.capabilities, status === 'unavailable') : ''}
        ${remote && node.knownIncomingGrants > 0 ? message(`${tr('本机发出的授权')} · ${node.knownIncomingGrants}`) : ''}
        ${remote ? (node.workspaces || []).map(workspace => {
          const activation = view.data.activations.find(row => row.nodeId === id && row.workspaceId === workspace.id);
          const registered = workspace.state === 'registered';
          return `<div data-ra-workspace="${esc(workspace.id)}" data-ra-registration="${registered ? 'registered' : 'unavailable'}">
            <p>${tr('远端工作区')} · ${tr(registered ? '已登记' : '不可用')}</p><p class="ovRaw">${esc(workspace.id)}</p>
            ${capabilities(workspace.capabilities, !registered)}${message(activationInfo(activation))}</div>`;
        }).join('') : ''}
        ${id !== scope && view?.data && (!node || remote && !node.workspaces?.length)
          ? `<p data-ra-registration="unregistered">${tr('远端工作区')} · ${stateBadge('unregistered')}</p>` : ''}
        ${entry && !entry.foreign && status === 'unavailable' ? button(link?.rejected ? 'auth' : 'retry', link?.rejected ? '重新授权' : '重新连接', `data-id="${esc(id)}"`) : ''}
        </article>`;
    }).join('');
    return `<section class="ra-section" data-ra-devices="${viewState()}" data-ra-source="${esc(scope || '')}" aria-labelledby="ra-devices-title">
      ${heading('ra-devices-title', '设备与能力')}
      ${scope ? message(`${tr('发起电脑')} · ${nodeName(scope, entries)} · ${scope}`) : ''}
      <div class="ra-controls">${button('ra-peer', '电脑互控', controls)}${button('ra-phone', '手机控制', controls)}</div>
      ${viewStatus()}${view?.accessOrigin ? message(`${tr('激活所属会话')} · ${ref(view.accessOrigin)}`) : ''}
      <div class="ra-grid">${cards}</div></section>`;
  }

  function receipt(row, result) {
    return `<div class="ra-details"><p>${stateBadge(labels[row.state] ? row.state : 'UNKNOWN')}</p>
      <ul class="ra-list">
        <li><span>${tr('原会话')}</span><span class="ovRaw">${esc(ref(row.origin))}</span></li>
        <li><span>${tr('发起电脑')}</span><span class="ovRaw">${esc(nodeName(row.origin.computerId))}</span></li>
        <li><span>${tr('目标电脑')}</span><span class="ovRaw">${esc(nodeName(row.nodeId))}</span></li>
        <li><span>${tr('工作区')}</span><span class="ovRaw">${esc(row.workspaceId)}</span></li>
        <li><span>${tr('操作 ID')}</span><span class="ovRaw">${esc(row.id)}</span></li>
        ${(row.artifacts || []).map(artifact => `<li><span>${tr(artifact.kind === 'directory' ? '目录引用' : '文件引用')}</span><span class="ovRaw">${esc(artifact.id)}</span></li>`).join('')}
      </ul>${row.error ? message(errorText(row.error), true) : ''}${summary(row) ? message(summary(row)) : ''}
      ${typeof result?.text === 'string' ? `<pre class="ra-output" data-ra-result="text">${esc(result.text)}</pre>` : ''}
      ${typeof result?.output === 'string' ? `<pre class="ra-output" data-ra-result="terminal">${esc(result.output)}</pre>` : ''}
      ${result?.entries?.length ? `<ul class="ra-list ra-file-list">${result.entries.map(row =>
        `<li><span class="ovRaw">${esc(row.name)}</span><span>${esc(tr(({ directory: '目录', file: '文件', symlink: '符号链接', other: '其他' })[row.type] || row.type))}</span></li>`).join('')}</ul>` : ''}
      </div>`;
  }

  function operation(id) {
    const row = view?.operations?.find(value => value.id === id);
    if (row) openSheet('ra-core-receipt', `<h3>${esc(actionLabel(row.action))}</h3>${receipt(row)}`);
  }

  const submissionKey = (owner, app, thread) => JSON.stringify([owner.id, owner.device, app, thread]);
  const submitted = $('raSubmitted');
  function paintSubmitted() {
    const rows = [...detached];
    submitted.hidden = !rows.length;
    submitted.innerHTML = rows.map((request, index) => `<article class="ra-card">
      <div role="status">
        <strong>${esc(tr(request.label || writeLabels[request.event]))} · ${esc(tr(labels[request.status] || '已发送，等待中继回执…'))}</strong>
        <p class="ovRaw">${esc(ref(request.origin))} · ${esc(request.origin.computerId)} → ${esc(request.node)} · ${esc(request.workspace)}</p>
        ${request.id ? message(`${tr('操作 ID')} · ${request.id}`) : ''}
        ${request.detail ? message(request.detail, request.status !== 'SUCCEEDED') : ''}
      </div>${request.status ? `<button type="button" class="ra-control" data-ra-dismiss="${index}">${tr('关闭')}</button>` : ''}</article>`).join('');
  }
  submitted.onclick = event => {
    const index = event.target.closest('[data-ra-dismiss]')?.dataset.raDismiss;
    if (index === undefined) return;
    detached.delete([...detached][Number(index)]);
    paintSubmitted();
  };

  function reconcileInvokes(operations) {
    let repaint = false;
    for (const [activationId, request] of uncertainInvokes) {
      const row = operations.find(row => row.id === request.id && row.origin.id === request.origin.id
        && row.nodeId === request.node && row.workspaceId === request.workspace);
      if (!row || row.state === 'RESERVED' || row.state === 'STARTED') continue;
      uncertainInvokes.delete(activationId);
      request.status = labels[row.state] ? row.state : 'UNKNOWN';
      request.detail = row.error ? errorText(row.error) : summary(row);
      repaint ||= detached.has(request);
    }
    if (repaint) paintSubmitted();
  }

  const accessOpen = state => sheetKind === 'ra-core-access' && $('sheet').classList.contains('open') && state.root.isConnected;
  function locked(state) {
    const current = currentComputer();
    return accessOpen(state) && document.visibilityState === 'visible' && !document.body.classList.contains('conv')
      && ovS.level === state.level && ovS.comp === state.comp && ovS.proj === state.project && ovS.open === state.card && ovComposerReady(state.card)
      && current?.id === state.owner.id && current.key === state.owner.key && current.token === state.owner.token && current.device === state.owner.device
      && ws === state.socket && ws.readyState === 1 && connGen === state.generation && selectedConversation.serial === state.navigation && viewSel === state.selection
      && currentApp === state.app && lastChat?.thread === state.target.threadId && winTargetReady(state.target);
  }

  function detachAccess(state) {
    state.controller.abort();
    state.observer?.disconnect();
    if (access === state) access = null;
    if (accessOpen(state)) {
      state.stale = true;
      paintAccess(state);
    }
    if (state.request?.sent && !detached.has(state.request)) {
      detached.add(state.request);
      paintSubmitted();
    }
  }

  function supported(workspace) {
    return [...new Set((workspace.capabilities || []).filter(cap => cap.availability !== 'unavailable')
      .flatMap(cap => cap.actions || []).filter(value => Object.hasOwn(actions, value)))];
  }

  function choices(data) {
    return data?.nodes.filter(node => node.kind === 'peer').flatMap(node =>
      (node.workspaces || []).filter(workspace => workspace.state === 'registered' && supported(workspace).length)
        .map(workspace => ({ node, workspace }))) || [];
  }

  function paintAccess(state) {
    if (!accessOpen(state)) return;
    const { root, origin, row, result } = state;
    root.dataset.raOrigin = state.data && !state.stale ? origin.id : '';
    root.dataset.raAccess = state.stale ? 'blocked' : state.loading ? 'loading' : state.data ? 'ready' : 'blocked';
    if (state.stale) {
      root.innerHTML = message(tr('原会话已切换，请在对应卡片重新打开。'), true);
      return;
    }
    const available = choices(state.data);
    const targets = available.filter(({ node }) => node.id === state.node);
    const selected = targets.find(({ workspace }) => workspace.id === state.workspace)?.workspace;
    const allowed = selected ? supported(selected) : [];
    const activation = state.data?.activations.find(value => value.nodeId === state.node && value.workspaceId === state.workspace);
    const active = activation?.state === 'active' && activation.expiresAt > Date.now() && activation.uses < activation.maxUses;
    const uncertain = uncertainInvokes.get(activation?.id);
    const canInvoke = active && activation.actions.includes(state.action) && !uncertain && !!operationArgs(state);
    const blocked = state.loading || state.request || !origin || !state.data, disabled = blocked ? ' disabled' : '';
    const canActivate = !blocked && allowed.includes(state.action)
      && !active && !state.attempted && activation?.state !== 'stale';
    const control = (event, label, enabled, primary = false) =>
      `<button type="button" class="ra-control${primary ? ' ra-primary' : ''}" data-ra-access-action="${event}"${enabled ? '' : ' disabled'}>${tr(label)}</button>`;
    root.innerHTML = `<p class="ra-status ovRaw">${esc(state.title || state.target.threadId)} · ${esc(appName(state.app))} · ${esc(nodeName(state.owner.id))}</p>
      <p class="ra-status ra-identity ovRaw">${esc(state.target.threadId)}</p>
      ${state.loading ? message(tr('正在核对原会话与远端工作区…')) : ''}
      ${!state.loading && !available.length && state.data ? message(tr('没有可选的已登记工作区。可在电脑互控中管理登记和授权。')) : ''}
      ${available.length ? `<div class="ra-fields">
        <label>${tr('目标电脑')}<select data-ra-choice="node"${disabled}><option value="">${tr('选择目标电脑')}</option>${[...new Set(available.map(({ node }) => node.id))].map(id =>
          `<option value="${esc(id)}"${id === state.node ? ' selected' : ''}>${esc(nodeName(id))}</option>`).join('')}</select></label>
        <label>${tr('工作区')}<select data-ra-choice="workspace"${blocked || !targets.length ? ' disabled' : ''}><option value="">${tr('选择工作区')}</option>${targets.map(({ workspace }) =>
          `<option value="${esc(workspace.id)}"${workspace.id === state.workspace ? ' selected' : ''}>${esc(workspace.id)}</option>`).join('')}</select></label>
        <label>${tr('授权动作')}<select data-ra-choice="action"${blocked || !state.workspace ? ' disabled' : ''}><option value="">${tr('选择动作')}</option>
          ${allowed.map(value => `<option value="${esc(value)}"${state.action === value ? ' selected' : ''}>${esc(actionLabel(value))}</option>`).join('')}</select></label>
        ${fileActions.has(state.action) ? `<label>${tr('工作区相对路径')}<input type="text" data-ra-arg="path" value="${esc(state.path ?? (state.action === 'list-files' ? '.' : ''))}" maxlength="1024" placeholder="${tr('例如：notes/report.txt')}"${disabled}></label>` : ''}
        ${textActions.has(state.action) ? `<label>${tr(state.action === 'send-terminal' ? '终端输入' : '文件正文')}<textarea data-ra-arg="text" rows="3" maxlength="${fileActions.has(state.action) ? 32768 : 8192}"${disabled}>${esc(state.text || '')}</textarea></label>` : ''}
        </div>${state.workspace ? message(activationInfo(activation)) : ''}
        ${activation?.actions?.length ? message(activation.actions.map(actionLabel).join(' · ')) : ''}
        ${state.action && !active ? message(tr('仅授权选中的操作一次，有效期 5 分钟；执行前再次确认目标与输入。')) : ''}
        <div class="ra-controls">${control('activate', '核验并激活', canActivate, true)}
          ${active || row ? control('invoke', state.action ? '执行操作 · ' + actions[state.action] : '执行操作', !blocked && canInvoke && !state.attempted, true) : ''}
          ${activation && !['revoked', 'expired'].includes(activation.state) ? control('revoke', '撤销激活', !blocked) : ''}
        </div>` : ''}
      ${state.request ? message(tr(state.request.sent ? '已发送，等待中继回执…' : '正在签名，请求尚未发送…')) : ''}
      ${uncertain && !state.error ? message(`${errorText('peer_outcome_unknown')} · ${tr('操作 ID')} ${uncertain.id}`, true) : ''}
      ${state.error ? message(state.error, true) : ''}${row ? receipt(row, result) : ''}
      <div class="ra-controls ra-details">${control('reload', '刷新授权状态', !state.request && !state.loading)}
        ${control('peer', '管理电脑互控', !state.request)}${state.attempted || uncertain ? control('work', '在工作中查看', !state.request) : ''}</div>`;
  }

  async function loadAccess(state) {
    state.loading = true;
    state.error = '';
    paintAccess(state);
    try {
      const data = await snapshot(state.owner, state.controller.signal);
      if (!locked(state)) return;
      const origin = selectedOrigin(data.origins, state.app, state.target.threadId);
      if (state.origin && state.origin.id !== origin?.id) throw fail('origin_stale');
      if (!origin) throw fail('origin_unavailable');
      state.origin = origin;
      const scoped = await snapshot(state.owner, state.controller.signal, origin.id);
      if (!locked(state)) return;
      if (selectedOrigin(scoped.origins, state.app, state.target.threadId)?.id !== origin.id) throw fail('origin_stale');
      state.data = scoped;
    } catch (error) {
      state.data = null;
      if (!state.controller.signal.aborted) state.error = errorText(error);
    } finally {
      state.loading = false;
      if (locked(state)) paintAccess(state);
    }
  }

  async function changeAccess(state, event) {
    if (access !== state || !locked(state) || !state.origin || state.request || state.loading || !state.data) return;
    const { owner, origin, node, workspace, key } = state, originId = origin.id;
    if (submissions.has(key)) return;
    const scoped = state.data.activations.find(row => row.nodeId === node && row.workspaceId === workspace);
    const target = choices(state.data).find(row => row.node.id === node && row.workspace.id === workspace);
    const selectedAction = state.action, args = operationArgs(state);
    if (event !== 'revoke' && (!target || !supported(target.workspace).includes(selectedAction))) return;
    const active = scoped?.state === 'active' && scoped.expiresAt > Date.now() && scoped.uses < scoped.maxUses;
    const scope = { originId, nodeId: node, workspaceId: workspace };
    let body;
    if (event === 'activate' && !active && !state.attempted && scoped?.state !== 'stale') body = { ...scope, actions: [selectedAction], ttlSeconds, maxUses };
    if (event === 'revoke' && scoped && !['revoked', 'expired'].includes(scoped.state)) body = { originId, activationId: scoped.id };
    if (event === 'invoke' && active && scoped.actions.includes(selectedAction) && args && !state.attempted && !uncertainInvokes.has(scoped.id)) {
      body = { ...scope, activationId: scoped.id, operationId: `${Date.now()}-${crypto.randomUUID()}`, action: selectedAction, args };
    }
    if (!body) return paintAccess(state);
    const request = state.request = { event, origin, node, workspace, id: body.operationId,
      label: event === 'invoke' ? actions[selectedAction] : writeLabels[event] };
    state.error = '';
    paintAccess(state);
    try {
      const reply = mutate(owner, event, body, state.controller.signal, () => {
        const connection = linkForComputerKey(owner.key);
        if (access !== state || !locked(state) || state.request !== request || submissions.has(key)
          || !connection?.authed || connection.socket !== state.socket || connection.relay !== owner.relay
          || state.origin !== origin || !ownOrigin(owner, origin)
          || selectedOrigin(state.data?.origins || [], state.app, state.target.threadId)?.id !== originId
          || state.node !== node || state.workspace !== workspace || state.action !== selectedAction
          || event === 'invoke' && JSON.stringify(operationArgs(state)) !== JSON.stringify(args)) throw fail('origin_stale');
        submissions.set(key, request);
        request.sent = true;
        if (event === 'invoke') state.attempted = true;
        queueMicrotask(() => {
          if (access === state && locked(state)) paintAccess(state);
        });
      });
      const { value, ok, error } = await reply;
      let recorded = false;
      if (event === 'invoke') {
        const row = value.operation;
        if (row?.id === body.operationId && row.origin?.id === originId && ownOrigin(owner, row.origin)
          && row.nodeId === node && row.workspaceId === workspace && row.action === selectedAction) {
          state.row = row;
          state.result = row.state === 'SUCCEEDED' ? value.result : null;
          request.status = labels[row.state] ? row.state : 'UNKNOWN';
          request.detail = row.error ? errorText(row.error) : summary(row);
          recorded = true;
          if (Number.isSafeInteger(row.useNumber)) {
            scoped.uses = Math.max(scoped.uses, row.useNumber);
            if (scoped.uses >= scoped.maxUses) scoped.state = 'exhausted';
          }
        } else if (ok) throw fail('peer_outcome_unknown');
      } else if (ok) {
        const row = value.activation;
        if (row?.originId !== originId || row.nodeId !== node || row.workspaceId !== workspace) throw fail('invalid_activation');
        state.data.activations = [...state.data.activations.filter(value => value.nodeId !== node || value.workspaceId !== workspace), row];
        request.status = 'SUCCEEDED';
        request.detail = activationInfo(row);
      }
      if (!ok && !recorded) {
        const ambiguous = ['peer_outcome_unknown', 'ra_core_unavailable', 'request_failed'].includes(error) || event === 'invoke' && error === 'unauthorized';
        request.status = ambiguous ? 'UNKNOWN' : 'FAILED';
        if (ambiguous && event === 'invoke') uncertainInvokes.set(body.activationId, request);
        state.error = request.detail = errorText(error);
      }
    } catch (error) {
      if (request.sent) {
        request.status = 'UNKNOWN';
        if (event === 'invoke') uncertainInvokes.set(body.activationId, request);
        state.error = request.detail = event === 'invoke' ? errorText('peer_outcome_unknown') : tr('请求已发送。请刷新原会话的授权状态以核对结果。');
        state.data = null;
      } else if (!state.controller.signal.aborted) {
        state.error = errorText(error);
      }
    } finally {
      const attached = access === state && locked(state);
      if (!attached) detachAccess(state);
      state.request = null;
      if (request.sent) {
        submissions.delete(key);
        if (event === 'invoke') originHistory(owner, origin);
      }
      if (attached) paintAccess(state);
      if (detached.has(request)) paintSubmitted();
      if (request.sent && view?.level === 'fusion' && view.owner?.id === owner.id && view.owner.device === owner.device && view.originId === originId) {
        loadWork(view, originId, true);
      }
    }
  }

  function open(row, target) {
    const connection = source(ovList.find(entry => entry.id === row.comp));
    if (!connection || row.host || !target.threadId) return;
    const key = submissionKey(connection.owner, row.app, target.threadId);
    if (submissions.has(key)) return;
    openSheet('ra-core-access', `<h3>${tr('跨设备操作')}</h3><div data-ra-access></div>`);
    const root = $('sheet').querySelector('[data-ra-access]');
    const state = access = { root, key, owner: connection.owner, socket: connection.link.socket, card: row.key, title: row.title, app: row.app,
      level: ovS.level, comp: ovS.comp, project: ovS.proj,
      target: { ...target }, generation: connGen, navigation: selectedConversation.serial, selection: viewSel, controller: new AbortController() };
    state.observer = new MutationObserver(() => {
      if (!accessOpen(state)) detachAccess(state);
    });
    state.observer.observe($('sheet'), { attributes: true, attributeFilter: ['class', 'data-kind'], childList: true });
    if (!locked(state)) return detachAccess(state);
    root.oninput = event => {
      if (!locked(state) || state.request) return;
      const name = event.target.dataset.raArg;
      if (!['path', 'text'].includes(name)) return;
      state[name] = event.target.value;
      const invoke = root.querySelector('[data-ra-access-action="invoke"]');
      const activation = state.data?.activations.find(row => row.nodeId === state.node && row.workspaceId === state.workspace);
      if (invoke) invoke.disabled = !operationArgs(state) || state.attempted || uncertainInvokes.has(activation?.id)
        || activation?.state !== 'active' || !activation.actions.includes(state.action)
        || activation.expiresAt <= Date.now() || activation.uses >= activation.maxUses;
    };
    root.onchange = event => {
      if (!locked(state) || state.request) return;
      const arg = event.target.dataset.raArg;
      if (['path', 'text'].includes(arg)) {
        // Blur can fire during mousePressed on the submit button. Replacing
        // innerHTML here would destroy that button before mouseReleased.
        state[arg] = event.target.value;
        return;
      }
      const name = event.target.dataset.raChoice;
      if (name === 'node') { state.node = event.target.value; state.workspace = state.action = ''; }
      if (name === 'workspace') { state.workspace = event.target.value; state.action = ''; }
      if (name === 'action') {
        state.action = event.target.value;
        state.path = state.action === defaultAction ? '.' : '';
        state.text = '';
      }
      paintAccess(state);
      root.querySelector(`[data-ra-choice="${name}"]`)?.focus({ preventScroll: true });
    };
    root.onclick = event => {
      if (!locked(state) || state.request) return;
      const command = event.target.closest('[data-ra-access-action]')?.dataset.raAccessAction;
      if (command === 'reload') return loadAccess(state);
      if (command === 'peer') return showPeerTasks(state.owner.id);
      if (command === 'work') {
        preferredOrigin = state.origin.id;
        closeSheet();
        store.set('ov-level', 'fusion');
        return ovMove({ level: 'fusion', comp: state.owner.id, proj: null, open: null });
      }
      if (['activate', 'revoke', 'invoke'].includes(command)) changeAccess(state, command);
    };
    loadAccess(state);
  }

  return { sync, work, devices, refresh, selectOrigin, operation, open };
})();
