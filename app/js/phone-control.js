let phoneView = null;
let phoneConversationRequest = null;
let phoneChat = null;
const phoneConnectionLabels = {
  ready: '已连接手机。',
  reconnecting: '手机正在重连，中断期间暂停操作。',
  permission: '需要在被控手机上重新授权屏幕共享。',
};

function closePhoneControl() {
  const request = phoneConversationRequest;
  phoneConversationRequest = null;
  request?.socket?.close();
  if (!phoneView) return;
  const { control, video, pending, canvas } = phoneView;
  phoneView = null;
  control?.close();
  video?.close();
  clearTimeout(pending?.timer);
  if (canvas) canvas.width = 0;
}

addEventListener('pagehide', closePhoneControl);

async function phoneRequest(relay, body) {
  const response = body ? await post('/api/phone', body, { computer: relay })
    : await api('/api/phone', { computer: relay });
  if (response.status === 404) throw new Error('此电脑中继尚未支持手机远控');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '无法连接手机');
  return result;
}

function phoneSocket(relay, ticket) {
  const url = new URL('/phone', relay.relay);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url);
  socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'hello', ticket })), { once: true });
  return socket;
}

function showPhoneControl(sourceId) {
  closePhoneControl();
  const tr = I18N.tr;
  const scoped = sourceId !== undefined;
  const computers = loadComputers().filter(computer => computer.token && (!scoped ||
    computer.id === sourceId && (!computer.discovery || new URL(computer.discovery).origin === location.origin)));
  const nativeHost = typeof window.AgentRemoteApp?.openPhoneControl === 'function';
  openSheet('phone-control', `<h3>${tr('手机控制')}</h3>
    <div class="phone-picker">
      <label>${tr('发起电脑')}<select data-phone-relay${scoped || !computers.length ? ' disabled' : ''}></select></label>
      ${nativeHost && computers.length ? `<button type="button" data-phone-host>${tr('使用这台手机')}</button>` : ''}
      <button type="button" data-phone-refresh${computers.length ? '' : ' disabled'}>${tr('刷新手机')}</button>
    </div>
    <p class="hint ra-identity" data-phone-source></p>
    <div data-phone-list></div>
    <p class="hint" data-phone-status role="status"></p>`);
  const sheet = $('sheet'), select = sheet.querySelector('[data-phone-relay]'), status = sheet.querySelector('[data-phone-status]');
  const list = sheet.querySelector('[data-phone-list]'), identity = sheet.querySelector('[data-phone-source]');
  const open = () => sheetKind === 'phone-control' && sheet.classList.contains('open') && list.isConnected;
  for (const computer of computers) select.add(new Option(computer.name, computer.id));
  const initial = scoped ? sourceId : currentComputer()?.id;
  if (computers.some(row => row.id === initial)) select.value = initial;
  const selected = () => computers.find(row => row.id === (scoped ? sourceId : select.value));
  const carrier = () => peerRelay(selected());
  const showIdentity = computer => {
    identity.textContent = [computer?.name, computer?.id || sourceId,
      computer?.device && `${tr('配对设备 ID')} ${computer.device}`].filter(Boolean).join(' · ');
  };
  let request = 0;
  const refresh = async () => {
    if (!open()) return;
    const generation = ++request;
    list.replaceChildren();
    const computer = selected();
    showIdentity(computer);
    if (!computer) {
      status.textContent = tr(scoped ? '所选电脑未在此网页入口配对。' : '请先在此浏览器配对一台中继电脑。');
      return;
    }
    status.textContent = '正在查找手机…';
    try {
      const relay = carrier();
      showIdentity(relay);
      const { phones, conversations } = await phoneRequest(relay);
      const current = () => open() && generation === request && selected()?.id === relay.id;
      if (!current()) return;
      if (!Array.isArray(conversations)) throw new Error('请更新当前中继以使用手机控制会话。');
      if (conversations.some(target => target.computer !== relay.id)) throw new Error(tr('返回结果的电脑身份不匹配'));
      status.textContent = phones.length || conversations.length ? '' : '请在 Android App 里选择同一中继并设为可被控。';
      for (const target of conversations) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'opt';
        button.textContent = `${target.name} · ${tr('打开会话')}`;
        button.onclick = () => { if (current()) openPhoneConversation(relay, target); };
        list.append(button);
      }
      for (const phone of phones) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'opt';
        button.innerHTML = `<span class="lbl">${esc(phone.name)}<span class="sub ovRaw">${esc(phone.id)}</span></span>`;
        if (!phone.conversation) button.querySelector('.sub').textContent += ' · ' + tr('请更新 Android App');
        button.disabled = !phone.conversation;
        button.onclick = () => { if (current()) requestPhoneConversation(relay, phone); };
        list.append(button);
      }
    } catch (error) { if (open() && generation === request) status.textContent = error.message; }
  };
  select.onchange = refresh;
  sheet.querySelector('[data-phone-refresh]').onclick = refresh;
  const host = sheet.querySelector('[data-phone-host]');
  if (host) host.onclick = () => {
    if (!open() || !selected()) return;
    try {
      openPhoneHost(carrier());
    } catch (error) { status.textContent = error.message; }
  };
  refresh();
}

function openPhoneHost({ id, relay, token }, session) {
  window.AgentRemoteApp.openPhoneControl(JSON.stringify({ id, relay, token, session }));
}

function openPhoneConversation(relay, target) {
  if (target?.computer !== relay.id) return false;
  openWin(JSON.stringify({ ...target, phoneConversation: true }));
  return true;
}

async function requestPhoneConversation(relay, phone) {
  closePhoneControl();
  openSheet('phone-control', `<h3>${esc(phone.name)}</h3><p class="hint" data-phone-status role="status">正在连接…</p>`);
  const status = $('sheet').querySelector('[data-phone-status]');
  const request = phoneConversationRequest = {};
  const active = () => phoneConversationRequest === request;
  const finish = reason => {
    if (!active()) return;
    closePhoneControl();
    status.textContent = reason;
  };
  try {
    const { ticket } = await phoneRequest(relay, { role: 'controller', phone: phone.id });
    if (!active()) return;
    const socket = request.socket = phoneSocket(relay, ticket);
    socket.onclose = socket.onerror = () => finish('手机连接已关闭。');
    socket.onmessage = ({ data }) => {
      if (!active()) return;
      const message = JSON.parse(data);
      if (message.type === 'waiting') status.textContent = '等待手机用户接受并共享屏幕…';
      if (message.type === 'started') status.textContent = '正在创建手机控制会话…';
      if (message.type === 'conversation' && !openPhoneConversation(relay, message.target)) finish(I18N.tr('返回结果的电脑身份不匹配'));
      if (message.type === 'conversationError') finish(message.message);
      if (message.type === 'ended') finish(message.reason === 'rejected' ? '手机拒绝了本次请求。'
        : message.reason === 'approvalExpired' ? '手机未在有效时间内确认。' : '手机远控已结束。');
    };
  } catch (error) { finish(error.message); }
}

function rememberPhoneChat(message) {
  phoneChat = message.phoneControl ? { ...message.phoneControl, selection: viewSel, computer: currentComputer()?.id } : null;
}

function currentPhoneChat() {
  return phoneChat?.selection === viewSel && phoneChat.computer === currentComputer()?.id ? phoneChat : null;
}

function bindPhoneChatMenu(button, phone) {
  button.onclick = () => connectPhoneView(phone);
  const status = button.querySelector('[data-phone-menu-status]');
  const relay = peerRelay(currentComputer());
  phoneRequest(relay).then(({ conversations }) => {
    if (!button.isConnected) return;
    const target = conversations?.find(row => row.id === phone.id);
    const state = target?.state;
    status.textContent = phoneConnectionLabels[state] || '手机远控已结束。';
    if (state === 'permission' && target.canReshare && typeof window.AgentRemoteApp?.openPhoneControl === 'function') {
      button.querySelector('.lbl').firstChild.textContent = '重新授权屏幕共享';
      button.onclick = () => openPhoneHost(relay, phone.id);
    }
  }, error => { if (button.isConnected) status.textContent = error.message; });
}

async function connectPhoneView(phone) {
  const relay = peerRelay(currentComputer());
  closePhoneControl();
  openSheet('phone-control', `<h3>${esc(phone.title)}</h3>
    <div class="phone-view">
      <div class="phone-stage"><canvas aria-label="手机屏幕"></canvas></div>
      <div class="phone-commands">
        <p class="hint" data-phone-status role="status">正在连接…</p>
        <button type="button" data-phone-reauthorize hidden>重新授权屏幕共享</button>
        <fieldset disabled>
          <div class="phone-actions">
            <button type="button" data-phone-action="back">返回</button>
            <button type="button" data-phone-action="home">桌面</button>
            <button type="button" data-phone-action="recents">最近任务</button>
            <button type="button" data-phone-action="inspect">读控件</button>
          </div>
          <p data-phone-app></p>
          <div class="phone-nodes" data-phone-nodes></div>
          <form class="phone-text" data-phone-text hidden>
            <label><span data-phone-input-label></span><input maxlength="2000" autocomplete="off"></label>
            <button type="submit">输入</button>
          </form>
        </fieldset>
        <button type="button" data-phone-stop>停止远控</button>
      </div>
    </div>`);
  const sheet = $('sheet'), canvas = sheet.querySelector('canvas'), commands = sheet.querySelector('fieldset');
  const status = sheet.querySelector('[data-phone-status]'), text = sheet.querySelector('[data-phone-text]');
  const reauthorize = sheet.querySelector('[data-phone-reauthorize]');
  const view = phoneView = { canvas, status, commands, text, id: 0 };
  const active = () => phoneView === view;
  reauthorize.onclick = () => openPhoneHost(relay, phone.id);
  const end = reason => {
    if (!active()) return;
    commands.disabled = true;
    sheet.querySelector('[data-phone-nodes]').replaceChildren();
    sheet.querySelector('[data-phone-app]').textContent = '';
    text.reset();
    text.hidden = true;
    closePhoneControl();
    status.textContent = reason;
  };
  sheet.querySelector('[data-phone-stop]').onclick = async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await phoneRequest(relay, { role: 'stop', session: phone.id });
      end('已停止远控');
    } catch (error) {
      if (!active()) return;
      button.disabled = false;
      status.textContent = error.message;
    }
  };
  const observationRequired = '请先读控件并核对当前手机状态，再决定下一步。';
  const updateControls = () => {
    commands.disabled = view.state !== 'ready' || !!view.agentBusy || !!view.pending;
    for (const control of commands.querySelectorAll('button, input')) {
      control.disabled = !!view.observationRequired && control.dataset.phoneAction !== 'inspect';
    }
  };
  const sendAction = content => {
    if (!active() || view.state !== 'ready' || view.pending || view.agentBusy || view.control?.readyState !== WebSocket.OPEN) return;
    if (view.observationRequired && content.kind !== 'inspect') return;
    const id = ++view.id;
    commands.disabled = true;
    status.textContent = '手机正在处理操作…';
    view.pending = { id, kind: content.kind, timer: setTimeout(() => {
      if (!active()) return;
      view.pending = null;
      updateControls();
      status.textContent = '手机未确认操作，请先核对当前画面。';
    }, 6500) };
    view.control.send(JSON.stringify({ type: 'action', id, ...content }));
  };
  for (const button of commands.querySelectorAll('[data-phone-action]')) button.onclick = () => {
    const action = button.dataset.phoneAction;
    sendAction(action === 'inspect' ? { kind: 'inspect' } : { kind: 'system', action });
  };
  text.onsubmit = event => {
    event.preventDefault();
    if (view.input?.revision !== view.tree) { status.textContent = '界面已变化，请重新选择输入框。'; return; }
    sendAction({ kind: 'node', ...view.input, action: 'text', text: text.querySelector('input').value });
  };

  let pointer;
  const updateState = state => {
    view.state = state;
    updateControls();
    reauthorize.hidden = state !== 'permission' || !view.canReshare || typeof window.AgentRemoteApp?.openPhoneControl !== 'function';
    status.textContent = state === 'ready' && view.observationRequired ? observationRequired : phoneConnectionLabels[state] || '正在连接…';
    if (state !== 'ready') {
      view.screen = view.tree = view.frame = view.next = view.input = pointer = null;
      sheet.querySelector('[data-phone-nodes]').replaceChildren();
      sheet.querySelector('[data-phone-app]').textContent = '';
      text.reset();
      text.hidden = true;
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    }
  };
  const point = event => {
    const rect = canvas.getBoundingClientRect(), clamp = n => Math.max(0, Math.min(1, n));
    return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) };
  };
  canvas.onpointerdown = event => {
    if (!active() || !view.frame || view.frame !== view.screen || view.pending || view.agentBusy || view.observationRequired || event.button !== 0 || pointer) return;
    canvas.setPointerCapture(event.pointerId);
    pointer = { id: event.pointerId, revision: view.frame, start: performance.now(), ...point(event) };
  };
  canvas.onpointercancel = () => { pointer = null; };
  canvas.onpointerup = event => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const { x, y, revision, start } = pointer, endPoint = point(event);
    pointer = null;
    if (revision !== view.frame || revision !== view.screen) return;
    const held = Math.round(performance.now() - start);
    sendAction({ kind: 'gesture', x, y, endX: endPoint.x, endY: endPoint.y, revision, duration: Math.max(55, Math.min(1200, held)) });
  };
  canvas.addEventListener('wheel', event => {
    if (!active() || !view.frame || view.frame !== view.screen || !event.deltaY) return;
    event.preventDefault();
    const { x, y } = point(event), yFrom = Math.min(.8, Math.max(.2, y));
    sendAction({ kind: 'gesture', revision: view.frame, x, y: yFrom, endX: x,
      endY: Math.max(.08, Math.min(.92, yFrom - Math.sign(event.deltaY) * .24)), duration: 180 });
  }, { passive: false });

  const renderNodes = message => {
    view.tree = message.revision;
    sheet.querySelector('[data-phone-app]').textContent = message.app;
    const names = { click: '点击', longClick: '长按', scrollForward: '向下滚动', scrollBackward: '向上滚动', text: '填写' };
    const rows = message.nodes.map(node => {
      const row = document.createElement('div'), label = document.createElement('span');
      label.textContent = node.label;
      row.append(label);
      for (const action of node.actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = names[action];
        button.onclick = () => {
          const target = { revision: message.revision, node: node.id };
          if (view.tree !== target.revision) return;
          if (action === 'text') {
            view.input = target;
            text.querySelector('[data-phone-input-label]').textContent = node.label;
            text.hidden = false;
            text.querySelector('input').focus();
          } else sendAction({ kind: 'node', ...target, action });
        };
        row.append(button);
      }
      return row;
    });
    sheet.querySelector('[data-phone-nodes]').replaceChildren(...rows);
    updateControls();
  };

  async function draw() {
    if (view.drawing) return;
    view.drawing = true;
    try {
      while (view.next && active()) {
        const bytes = view.next;
        view.next = null;
        const revision = new DataView(bytes).getUint32(0);
        if (revision !== view.screen) continue;
        const bitmap = await createImageBitmap(new Blob([bytes.slice(4)], { type: 'image/jpeg' }));
        try {
          if (!active() || revision !== view.screen) continue;
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
          }
          canvas.getContext('2d').drawImage(bitmap, 0, 0);
          view.frame = revision;
        } finally { bitmap.close(); }
      }
    } catch { if (active()) status.textContent = '暂时无法解码手机画面。'; }
    finally { view.drawing = false; }
  }

  const failed = () => end('手机远控连接已关闭');
  try {
    const { ticket } = await phoneRequest(relay, { role: 'viewer', session: phone.id });
    if (!active()) return;
    const control = view.control = phoneSocket(relay, ticket);
    control.onclose = failed;
    control.onerror = failed;
    control.onmessage = ({ data }) => {
      if (!active()) return;
      const message = JSON.parse(data);
      if (message.type === 'agentBusy') {
        view.agentBusy = message.busy === true;
        updateControls();
        if (view.state === 'ready') status.textContent = view.agentBusy ? 'Agent 正在操作手机…'
          : view.observationRequired ? observationRequired : 'Agent 本次操作已结束。';
      }
      if (message.type === 'observationRequired') {
        view.observationRequired = message.required === true;
        updateControls();
        if (view.state === 'ready') status.textContent = view.observationRequired ? observationRequired : '已重新读取手机状态。';
      }
      if (message.type === 'started') {
        view.canReshare = message.canReshare;
        updateState(message.state);
        const video = view.video = phoneSocket(relay, message.ticket);
        video.binaryType = 'arraybuffer';
        video.onclose = event => event.code === 4004 ? end('手机远控已结束。') : failed();
        video.onerror = failed;
        video.onmessage = ({ data: frame }) => {
          if (!active() || !(frame instanceof ArrayBuffer) || frame.byteLength < 8) return;
          view.next = frame;
          draw();
        };
      }
      if (message.type === 'state') updateState(message.state);
      if (message.type === 'screen') {
        view.screen = message.revision;
        view.frame = null;
        pointer = null;
        canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
      }
      if (message.type === 'tree') renderNodes(message);
      if (message.type === 'ack' && view.pending?.id === message.id) {
        const { kind, timer } = view.pending;
        clearTimeout(timer);
        view.pending = null;
        updateControls();
        if (view.state === 'ready') {
          if (view.observationRequired || message.reason === 'observationRequired') status.textContent = observationRequired;
          else if (message.ok) status.textContent = kind === 'inspect' ? '已读取手机状态。' : '手机已确认操作，请核对实际结果。';
          else if (message.reason === 'stale') status.textContent = '界面已变化，请查看最新画面后重试。';
          else if (message.reason === 'outcomeUnknown') status.textContent = '手机未确认操作结果，请先查看最新画面。';
          else status.textContent = '手机未确认操作成功。';
        }
      }
      if (message.type === 'ended') end(message.reason === 'rejected' ? '手机拒绝了本次请求。'
        : message.reason === 'approvalExpired' ? '手机未在有效时间内确认。' : '手机远控已结束。');
    };
  } catch (error) { end(error.message); }
}
