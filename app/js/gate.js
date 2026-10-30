/* ---------- pairing / 2FA / connection state ---------- */
let gateSubmit = null;
let gateRetryFn = null;
function gate({ msg = '', err = false, input = null, retry = false, repair = false, computers = false, appLink = null, onRetry = null, pairStatus = null } = {}) {
  $('gate').classList.add('open');
  $('gate').classList.toggle('pairing', !!input?.scan);
  $('gate').classList.toggle('pairStatus', !!pairStatus);
  $('gate').dataset.pairState = pairStatus?.state || '';
  $('gateStatus').hidden = $('gateLead').hidden = !pairStatus;
  $('gateStatusTitle').textContent = pairStatus?.title || '';
  $('gateStatusIcon').innerHTML = !pairStatus ? '' : pairStatus.state === 'loading' ? CONN_ICON.load : pairStatus.state === 'waiting' ? CONN_HOST_SVG : pairStatus.state === 'paired' ? CONN_ICON.ok : '!';
  $('gateStatusDetail').textContent = pairStatus?.detail || '';
  $('gateStatusDetail').hidden = !pairStatus?.detail;
  $('gateCode').textContent = pairStatus?.code || '';
  $('gateCode').hidden = !pairStatus?.code;
  $('gateNote').textContent = pairStatus?.note || '';
  $('gateNote').hidden = !pairStatus?.note;
  $('gateWaiting').hidden = pairStatus?.state !== 'waiting';
  $('gateMsg').textContent = msg;
  $('gateMsg').className = err ? 'err' : '';
  const inp = $('gateInput');
  inp.hidden = $('gateBtn').hidden = !input;
  $('gateEntry').hidden = !input;
  $('gatePaste').hidden = !input || !!input.code;
  gateSubmit = input?.submit || null;
  gateRetryFn = onRetry;
  if (input) {
    inp.value = '';
    inp.placeholder = input.placeholder;
    inp.className = input.code ? 'code' : '';
    inp.inputMode = input.code ? 'numeric' : input.inputMode || 'url';
    inp.autocomplete = input.code ? 'one-time-code' : 'off';
    $('gateBtn').textContent = input.button;
    if (input.code) setTimeout(() => inp.focus(), 50);
  }
  $('gateScan').hidden = !input?.scan;
  $('pairOr').hidden = $('gateScan').hidden;
  $('gateHelp').hidden = !input?.scan;
  $('pairIntro').hidden = !input?.scan;
  $('gateLang').querySelectorAll('[data-lang]').forEach(b => { b.classList.toggle('active', b.dataset.lang === I18N.lang); b.setAttribute('aria-pressed', String(b.dataset.lang === I18N.lang)); });
  $('gateApp').hidden = !appLink;
  if (appLink) $('gateApp').href = appLink;
  $('gateRetry').hidden = !retry;
  $('gateRetry').textContent = typeof retry === 'string' ? retry : '重试';
  $('gateComputers').hidden = !computers;
  $('gateRepair').hidden = !repair;
  $('gateActions').classList.toggle('show', !!(retry || repair || computers));
  $('gateInfo').textContent = info?.updated ? '电脑端地址更新于 ' + new Date(info.updated).toLocaleString() : '';
}
const ungate = () => $('gate').classList.remove('open');
$('gateBtn').onclick = () => gateSubmit?.($('gateInput').value.trim());
$('gateScan').onclick = () => window.AgentRemoteApp?.scan ? window.AgentRemoteApp.scan() : openScanner();
$('gateInput').onkeydown = e => { if (e.key === 'Enter') $('gateBtn').click(); };
$('gateLang').onclick = e => { const button = e.target.closest('[data-lang]'); if (button && button.dataset.lang !== I18N.lang) I18N.set(button.dataset.lang); };
$('gatePaste').onclick = async () => {
  try { $('gateInput').value = (await navigator.clipboard.readText()).trim(); $('gateInput').focus(); }
  catch { $('gateMsg').textContent = I18N.tr('无法读取剪贴板，请长按输入框粘贴'); }
};
$('gateHelp').onclick = () => openSheet('pair-help', '<h3>配对遇到问题？</h3><p>在电脑端运行 npm run pair，使用新生成的二维码、链接或完整手动配对码。</p><p>配对码 3 分钟内可重复申请，每个入口都需在电脑配对窗口批准。</p>');
$('gateRetry').onclick = () => { if (gateRetryFn) gateRetryFn(); else boot(); };
$('gateComputers').onclick = () => showComputers();
let connGen = 0;
function repairPairing() {
  connGen++;
  clearTimeout(retryTimer);
  pending = null;
  authed = false;
  const old = ws;
  ws = null;
  try { old?.close(); } catch {}
  addComputer();
}
$('gateRepair').onclick = () => repairPairing();

// Connection state is shared by preloading and Agent management; presentation lives in the overview.
const CONN_AGENTS = [
  { app: 'cursor', name: 'Cursor' }, { app: 'devin', name: 'Devin' }, { app: 'codex', name: 'Codex' },
];
function newComputerConnection() {
  return { initialSelection: true, host: false, agents: null, catalogReady: false, autoLaunched: false, attachFailed: false, probeComplete: false, failedTargets: new Map() };
}
const conn = newComputerConnection();
function resetComputerConnection() {
  compatibilityRequests.clear();
  compatibilityReports.clear();
  Object.assign(conn, newComputerConnection());
}
function connHostOk() {
  conn.host = true;
  ovRender();
}
const connLaunchStatus = new Map();
const CONN_ICON = {
  ok: '<span class="cIc"><svg viewBox="0 0 12 12" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.2l2.3 2.3 4.7-4.9"/></svg></span>',
  load: '<span class="cSpin"></span>',
};
const CONN_HOST_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M9 20h6M12 16.5V20"/></svg>';
const ct = (tpl, vars = {}) => I18N.tr(tpl).replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
const DIAG_TEXT = { ok: '通过', load: '检测中…', err: '未通过', wait: '等待' };
function diagReason(r) {
  return ct({ offline: '手机处于离线状态，请检查 Wi-Fi 或移动数据', nourl: '尚未获取隧道地址', timeout: '{s} 秒内没有响应', http: '服务器返回 {v}', invalid: '返回内容不符合预期', json: '返回内容不是 JSON' }[r.code] || '请求失败：网络、DNS、证书或跨域原因未确定', { s: r.timeout || 8, v: r.http || '' });
}
const agentCatalogs = new Map();
const agentReports = new Map();
const agentComputerKey = () => currentComputer()?.id || currentComputer()?.key || base;
const agentCatalog = () => agentCatalogs.get(agentComputerKey());
const compatibilityReports = new Map(), compatibilityRequests = new Map(), compatibilityOpen = new Set();
let compatibilitySerial = 0;
const compatibilityKey = app => `${agentComputerKey()}|${app}`;
function requestCompatibility(app, force = false, windowId = '') {
  if (!authed || !CONN_AGENTS.some(a => a.app === app)) return;
  const key = compatibilityKey(app), previous = compatibilityRequests.get(key);
  if (!force && previous && (!windowId || previous.windowId === windowId)) return;
  const request = { requestId: ++compatibilitySerial, windowId: windowId || previous?.windowId || '' };
  compatibilityRequests.set(key, request);
  compatibilityReports.set(key, { state: 'loading' });
  send({ t: 'compatibility', app, ...request });
}
function receiveCompatibility(m) {
  const key = compatibilityKey(m.app), request = compatibilityRequests.get(key);
  if (!request || request.requestId !== m.requestId) return;
  if (request.windowId && m.windowId && request.windowId !== m.windowId) return;
  if (m.windowId) request.windowId = m.windowId;
  compatibilityReports.set(key, m);
  if (sheetKind === 'agent-manager') showAgentManager();
}
function compatibilityText(app) {
  const tr = I18N.tr, report = compatibilityReports.get(compatibilityKey(app));
  if (!report) return tr('尚未检查版本与适配');
  if (report.state === 'loading') return tr('正在只读检查版本与适配…');
  if (report.reason) return tr(report.reason === 'window-unavailable' ? '窗口尚未就绪，未检查适配' : '适配信息读取失败，请重新检查');
  const versions = report.versions || {};
  const lines = [`${tr(app === 'codex' ? 'VS Code 版本' : '应用版本')}：${versions.application || tr('未知')}`];
  if (versions.base) lines.push(`${tr('基础版本')}：${versions.base}`);
  if (app === 'codex') lines.push(`${tr('Codex 扩展版本')}：${versions.extension || tr('未知')}`);
  const labels = { input: '输入入口', models: '模型数据', sessions: '会话标识' };
  const states = { identified: '已识别', pending: '尚未就绪', unknown: '尚未确认' };
  for (const [key, feature] of Object.entries(report.features || {})) lines.push(`${tr(labels[key] || key)}：${tr(states[feature.state] || '尚未确认')}`);
  lines.push(tr('只读检查仅确认入口和数据，未执行原生操作。'));
  return lines.join('\n');
}
function startupAgents() {
  const saved = store.get('agent-start:' + agentComputerKey());
  return saved === null ? CONN_AGENTS.map(a => a.app) : JSON.parse(saved);
}
function selectedLaunchAgents() {
  const selected = startupAgents(), reports = agentReports.get(agentComputerKey()) || [];
  return (agentCatalog() || []).filter(a => a.installed === true && !a.running && a.launchSupported && selected.includes(a.app)
    && !reports.some(r => r.app === a.app && r.windows) && connLaunchStatus.get(a.app) !== 'launching').map(a => a.app);
}
function autoLaunchAgents() {
  if (store.get('conn-auto-launch') !== '1' || conn.autoLaunched || !conn.catalogReady || !conn.probeComplete || !conn.agents) return;
  conn.autoLaunched = true;
  connLaunch(selectedLaunchAgents());
}
function agentCatalogResults(results) {
  agentCatalogs.set(agentComputerKey(), results);
  conn.catalogReady = true;
  autoLaunchAgents();
  ovRender();
  if (sheetKind === 'agent-manager') showAgentManager();
}
function connAgentResults(results, complete = true) {
  conn.probeComplete = complete;
  agentReports.set(agentComputerKey(), results);
  for (const r of results) if (r.windows) connLaunchStatus.delete(r.app);
  conn.agents = CONN_AGENTS.map(a => ({ ...a, pending: !results.some(r => r.app === a.app), ...results.find(r => r.app === a.app) }));
  for (const r of results) if (r.windows) requestCompatibility(r.app);
  autoLaunchAgents();
  if (sheetKind === 'agent-manager') showAgentManager();
  if (conn.host !== true) return;
  ovRender();
  ensureReadyAgent();
}
function connLaunch(apps) {
  const targets = apps || selectedLaunchAgents();
  if (!targets.length) return;
  for (const app of targets) {
    connLaunchStatus.set(app, 'launching');
    conn.failedTargets?.delete(app);
  }
  send({ t: 'launchAgents', apps: targets });
  ovRender();
  if (sheetKind === 'agent-manager') showAgentManager();
}
function connLaunchResults(results) {
  for (const r of results || []) if (CONN_AGENTS.some(a => a.app === r.app)) connLaunchStatus.set(r.app, r.status);
  if (sheetKind === 'agent-manager') showAgentManager();
  // Failed launches remain visible in the existing Agent management flow.
  const fail = (results || []).find(r => ['missing', 'running', 'timeout', 'failed', 'unsupported'].includes(r.status));
  if (fail) status(connLaunchNote({ app: fail.app, name: CONN_AGENTS.find(a => a.app === fail.app)?.name || fail.app }), false);
}
function connLaunchNote(a) {
  const st = connLaunchStatus.get(a.app);
  if (st === 'launching') return I18N.tr('正在启动…');
  return { missing: ct('电脑上没有安装 {agent}', { agent: a.name }), running: ct('{agent} 已在运行但没有开启调试端口，请先退出后再启动', { agent: a.name }),
    unsupported: I18N.tr('这台电脑暂不支持远程启动'), timeout: I18N.tr('启动失败，请在电脑上检查'), failed: I18N.tr('启动失败，请在电脑上检查') }[st] || '';
}
function connContentReady() {
  conn.initialSelection = false;
  if (pendingStatus === '正在加载对话…') status('已连接');
  conn.attachFailed = false;
  ovEnterReady();
  ovRender();
}

function ensureReadyAgent() {
  if (!conn.initialSelection || navigationPending || windowReady) return;
  const ready = (conn.agents || []).filter(a => a.windows).map(a => a.app);
  if (!ready.length) return;
  const appOf = id => String(id || '').split(':')[0];
  const saved = conn.lastSelection;
  const want = saved?.app || '';
  const picks = (windows || []).filter(w => ready.includes(appOf(w.id)))
    .flatMap(w => (w.windowIds || [w.id]).map(id => ({ id, app: appOf(id) })))
    .filter(w => !want || w.app === want)
    .filter(w => !conn.failedTargets?.has(w.id));
  picks.sort((a, b) => Number(b.app === want) - Number(a.app === want) || Number(b.id === saved?.id) - Number(a.id === saved?.id));
  const pick = picks[0];
  if (!pick) return;
  send({ t: 'attach', ...(saved || { id: pick.id }), initial: true });
}
function connReadFailed(message) {
  const target = navigationPending?.targetId || currentWindow;
  if (target) conn.failedTargets.set(target, message);
  navigationPending = null;
  conn.attachFailed = true;
  selectionReady = false;
  setWindowReady(false);
  $('retryChat').hidden = false;
  status(message, false);
  ovRender();
}
function connRetryCurrent() {
  const chosen = currentComputer();
  send({ t: 'attach', id: chosen?.win || currentWindow || '', windowId: chosen?.windowId || '', threadId: chosen?.threadId || '', initial: true });
}
$('retryChat').onclick = connRetryCurrent;
