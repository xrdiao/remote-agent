/* Independent native-renderer round trips; no focus, typing or conversation reads. */
const latencyValues = new Map(), latencyPending = new Map();
let latencySerial = 0, latencyTimer = 0;
const latencyLabels = { loading: '未就绪', timeout: '超时', offline: '未运行', unconfigured: '未配置' };
function latencyBadge(id, label = '') {
  const value = latencyValues.get(id);
  const state = value?.state || 'loading';
  const color = state !== 'ok' ? 'muted' : value.ms < 300 ? 'good' : value.ms < 800 ? 'warn' : 'bad';
  const caption = state === 'ok' ? `${value.ms} ms` : value ? latencyLabels[state] : '测量中';
  return `<span class="latency ${color}" title="手机到对应 Agent 界面的往返延迟"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 8h2v4H1zM5 5h2v7H5zM9 1h2v11H9z" fill="currentColor"/></svg>${label ? esc(label) + ' ' : ''}${caption}</span>`;
}
function latencyMarkup(id) {
  return id === 'fusion' ? `<span class="latencyPair">${latencyBadge('fusion:a', 'A')}${latencyBadge('fusion:b', 'B')}</span>` : latencyBadge(id);
}
function paintLatency() {
  $('titleLatency').innerHTML = currentWindow ? latencyMarkup(currentWindow) : '';
  for (const node of $('sheet').querySelectorAll('[data-latency]')) node.innerHTML = latencyMarkup(node.dataset.latency);
}
function resetLatency() {
  clearTimeout(latencyTimer);
  for (const pending of latencyPending.values()) clearTimeout(pending.timer);
  latencyPending.clear(); latencyValues.clear(); paintLatency();
}
function measureLatency() {
  clearTimeout(latencyTimer);
  if (!authed || document.hidden || !windowReady) return;
  const targets = sheetKind === 'windows' ? windows.map(w => w.id) : [currentWindow];
  const ids = [...new Set(targets.flatMap(id => id === 'fusion' ? ['fusion:a', 'fusion:b'] : id ? [id] : []))].filter(id => !latencyPending.has(id));
  if (ids.length) {
    const requestId = ++latencySerial, start = performance.now();
    for (const id of ids) {
      const timer = setTimeout(() => {
        latencyPending.delete(id); latencyValues.set(id, { state: 'timeout' }); paintLatency();
      }, 6500);
      latencyPending.set(id, { requestId, start, timer });
    }
    const computer = currentComputer();
    send({ t: 'latency', ids, requestId, codexWindowId: currentApp === 'codex' ? computer?.windowId : computer?.selections?.codex?.windowId });
  }
  latencyTimer = setTimeout(measureLatency, sheetKind === 'windows' ? 10000 : 5000);
}
function receiveLatency(message) {
  const pending = latencyPending.get(message.id);
  if (!pending || pending.requestId !== message.requestId) return;
  clearTimeout(pending.timer); latencyPending.delete(message.id);
  latencyValues.set(message.id, { state: message.state, ms: Math.max(1, Math.round(performance.now() - pending.start)) });
  paintLatency();
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) resetLatency();
  else measureLatency();
});
