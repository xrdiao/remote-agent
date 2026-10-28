/* ---------- gate: pairing / 2FA / offline ---------- */
let gateSubmit = null;
let gateRetryFn = null;
function gate({ msg = '', err = false, input = null, retry = false, repair = false, computers = false, appLink = null, onRetry = null, pairStatus = null } = {}) {
  connHide();
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
  offlineGen++;
  pending = null;
  authed = false;
  const old = ws;
  ws = null;
  try { old?.close(); } catch {}
  addComputer();
}
$('gateRepair').onclick = () => repairPairing();

// Presentation only: use the existing authentication and window-list messages.
const CONN_AGENTS = [
  { app: 'cursor', name: 'Cursor' }, { app: 'devin', name: 'Devin' }, { app: 'codex', name: 'Codex' },
];
const conn = { active: false, host: false, phase: '', agents: null, timer: 0, failure: null, conclusion: '', checks: [], diagRunning: false, open: new Set(), autoLaunched: false };
// app -> 'launching' | launcher status; cleared when a re-probe finds windows.
const connLaunchStatus = new Map();
const CONN_TEXT = { ok: '已连接', load: '连接中…', err: '连接失败', wait: '等待主机' };
const CONN_ICON = {
  ok: '<span class="cIc"><svg viewBox="0 0 12 12" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.2l2.3 2.3 4.7-4.9"/></svg></span>',
  load: '<span class="cSpin"></span>', err: '<span class="cIc">!</span>', wait: '<span class="cIc"></span>',
};
const CONN_RETRY_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8A5.5 5.5 0 1 1 11.9 4.1"/><path d="M12.2 1.8v2.6H9.6"/></svg>';
const CONN_HOST_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M9 20h6M12 16.5V20"/></svg>';
const ct = (tpl, vars = {}) => I18N.tr(tpl).replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
const DIAG_TEXT = { ok: '通过', load: '检测中…', err: '未通过', wait: '等待' };
function diagReason(r) {
  return ct({ offline: '手机处于离线状态，请检查 Wi-Fi 或移动数据', nourl: '尚未获取隧道地址', timeout: '{s} 秒内没有响应', http: '服务器返回 {v}', invalid: '返回内容不符合预期', json: '返回内容不是 JSON' }[r.code] || '请求失败：网络、DNS、证书或跨域原因未确定', { s: r.timeout || 8, v: r.http || '' });
}
function connRenderDiag() {
  const tr = I18N.tr, checks = conn.checks, f = conn.failure || {};
  const ok = checks.filter(c => c.st === 'ok').length;
  const realtime = /实时连接/.test(f.stage || '');
  const passed = checks.length === 3 && ok === 3 && !conn.diagRunning;
  const hostSub = realtime ? '实时连接未建立' : '电脑连接未建立';
  const lead = conn.diagRunning || !checks.length ? '正在检测连接…'
    : passed ? realtime ? '地址正常，实时连接未建立，请重试。' : '地址正常，电脑连接未建立，请重试。'
    : checks.find(c => c.key === 'net')?.st === 'err' ? '手机网络不可用，请检查网络连接。'
    : checks.find(c => c.key === 'page')?.st === 'err' ? '页面地址检测未通过，请重试。'
    : checks.find(c => c.key === 'relay')?.st === 'err' ? '隧道服务暂时无法访问，请重试。' : '连接未建立，请重试。';
  $('connLead').textContent = tr(lead);
  const summary = conn.diagRunning || !checks.length ? tr('正在检测连接…')
    : ct('{n}/{total} 检测通过', { n: ok, total: checks.length }) + (passed ? ' · ' + tr(realtime ? '失败在实时连接' : '失败在电脑连接') : ' · ' + tr('部分检测未通过'));
  const open = conn.open.has('connection-details');
  const rows = checks.map(c => {
    const label = { net: '手机网络', page: '页面地址', relay: '隧道服务' }[c.key];
    const note = c.st === 'ok' ? c.key === 'net' ? tr('在线') : ct('{ms} ms', { ms: c.ms ?? 0 }) : c.st === 'err' ? tr(c.code === 'timeout' ? '超时' : '异常') : tr('检测中…');
    return `<div class="cDiagCheck"><span>${esc(tr(label))}</span><span class="cCheckNote">${esc(note)}</span><span class="cCheckState ${c.st}"><i class="cDiagDot ${c.st}" aria-hidden="true"></i>${esc(tr(DIAG_TEXT[c.st]))}</span></div>`;
  }).join('');
  const technical = [ct('失败阶段：{v}', { v: tr(f.stage || '应用连接') }), f.error, ...checks.filter(c => c.st === 'err').map(c => tr(c.label) + '：' + diagReason(c))].filter(Boolean).map(esc);
  for (const c of checks.filter(c => c.url)) {
    const label = tr(c.key === 'page' ? '页面' : '隧道');
    technical.push(`${esc(label)}: ${/^https?:\/\//.test(c.url) ? `<a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.url)}</a>` : esc(c.url)}`);
  }
  if (realtime && base) technical.push(esc('WebSocket: ' + base.replace(/^http/, 'ws') + '/ws'));
  $('connHost').innerHTML = `<div class="cItem err"><div class="cRow"><div class="cTile">${CONN_HOST_SVG}</div><div class="cMeta"><div class="cName">${esc(currentComputer()?.name || tr('电脑'))}</div><div class="cSub">${esc(tr(hostSub))}</div></div><div class="cSt">${CONN_ICON.err}<span>${esc(tr('连接失败'))}</span></div></div></div>`
    + `<div class="cDiagSummary"><span class="cDiagDots" aria-hidden="true">${checks.map(c => `<i class="cDiagDot ${c.st}"></i>`).join('')}</span><span class="cDiagText">${esc(summary)}</span><button data-conn-why="connection-details" aria-expanded="${open}" aria-controls="connDetails">${esc(tr(open ? '收起' : '详情'))}</button></div>`
    + (open ? `<div class="cDiagDetails" id="connDetails">${rows}<pre class="cTechnical">${technical.join('\n')}</pre></div>` : '');
}

function connOffline(failure, conclusion = '') {
  Object.assign(conn, { active: true, host: 'err', failure, conclusion });
  $('conn').classList.add('open');
  connRender();
}
function connHide() {
  clearTimeout(conn.timer);
  conn.active = false;
  $('conn').classList.remove('open');
}
function connShow(phase) {
  clearTimeout(conn.timer);
  compatibilityRequests.clear();
  compatibilityReports.clear();
  Object.assign(conn, { active: true, initialSelection: true, host: false, phase, agents: null, catalogReady: false, autoLaunched: false, loaded: false, attachFailed: false, enterRequested: false, failure: null, conclusion: '', checks: [], diagRunning: false, probeComplete: false, failedTargets: new Map() });
  conn.open.clear();
  $('conn').classList.add('open');
  connRender();
}
function connHostOk() {
  if (!conn.active) return;
  conn.host = true;
  connRender();
}
function connWindows(list) {
  if (!conn.active || conn.host !== true) return;
  // The connection page uses its own per-agent probe, including raw errors.
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
  if (conn.active) connRender();
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
function availableConnAgents() {
  const catalog = agentCatalog();
  return (conn.agents || []).filter(a => a.windows || (catalog && catalog.find(r => r.app === a.app)?.installed !== false));
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
  if (conn.active) { connRender(); connMaybeEnter(); }
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
  if (conn.active) connRender();
  ensureReadyAgent();
  connMaybeEnter();
}
function connLaunch(apps) {
  const targets = apps || selectedLaunchAgents();
  if (!targets.length) return;
  for (const app of targets) {
    connLaunchStatus.set(app, 'launching');
    conn.failedTargets?.delete(app);
  }
  send({ t: 'launchAgents', apps: targets });
  connRender();
  if (sheetKind === 'agent-manager') showAgentManager();
}
function connMissingApps() {
  const available = new Set(availableConnAgents().map(a => a.app));
  return (conn.agents || []).filter(a => available.has(a.app) && !a.windows).map(a => a.app);
}
function connLaunchResults(results) {
  for (const r of results || []) if (CONN_AGENTS.some(a => a.app === r.app)) connLaunchStatus.set(r.app, r.status);
  if (sheetKind === 'agent-manager') showAgentManager();
  if (conn.active) return connRender();
  // Launched from the agent list while the overlay is hidden: the sheet re-renders on
  // the next windows update, but a failed launch needs an explicit reason.
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
  window.AgentRemoteApp?.directDone?.();
  conn.initialSelection = false;
  if (pendingStatus === '正在加载对话…') status('已连接');
  conn.loaded = true;
  conn.attachFailed = false;
  connRender();
  connMaybeEnter();
}
// 'conn-auto-partial': '' / missing → off; '0' → off; anything else (incl. the old
// per-signature values like "cursor,devin") counts as on — enter whenever ≥1 agent is up.
const connAutoPartialOn = () => { const v = store.get('conn-auto-partial'); return v !== null && v !== '' && v !== '0'; };
function connMaybeEnter() {
  if (!conn.active || conn.host !== true || !conn.agents?.some(a => a.windows)) return;
  const agents = availableConnAgents(), ready = agents.filter(a => a.windows);
  if (conn.enterRequested || connAutoPartialOn() || conn.loaded && windowReady && conn.probeComplete
      && (ready.length === CONN_AGENTS.length || conn.catalogReady && ready.length === agents.length)) connHide();
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
  window.AgentRemoteApp?.directDone?.();
  const target = navigationPending?.targetId || currentWindow;
  if (target) conn.failedTargets.set(target, message);
  navigationPending = null;
  conn.attachFailed = true;
  selectionReady = false;
  setWindowReady(false);
  $('retryChat').hidden = false;
  status(message, false);
  if (conn.active) connRender();
}
function connRetryCurrent() {
  const chosen = currentComputer();
  send({ t: 'attach', id: chosen?.win || currentWindow || '', windowId: chosen?.windowId || '', threadId: chosen?.threadId || '', initial: true });
}
$('retryChat').onclick = connRetryCurrent;

function connRender() {
  const tr = I18N.tr;
  $('connVersion').textContent = `${tr('版本')} ${APP_VERSION}`;
  const failed = conn.host === 'err';
  $('conn').classList.toggle('failure', failed);
  $('connHostLabel').hidden = failed;
  $('connAgentsWrap').hidden = failed;
  $('connMore').hidden = !failed;
  $('connLaunchAll').hidden = true;
  $('connAutoPartial').hidden = failed;
  $('connAutoLaunch').hidden = failed;
  $('connPick').hidden = !failed && !loadComputers().length;
  if (failed) {
    $('connTitle').textContent = tr('连不上电脑');
    connRenderDiag();
    $('connGo').hidden = false;
    $('connGo').textContent = tr('重试');
    $('connNote').textContent = tr('每 15 秒自动重试');
    return;
  }
  $('connGo').textContent = tr('进入');
  const icon = st => st === 'load' ? '<span class="cSpin"></span>' : `<span class="cIc">${st === 'ok' ? '✓' : st === 'err' ? '!' : ''}</span>`;
  const row = (st, tile, name, sub, label, brand = false) => `<div class="cItem ${st}"><div class="cRow"><div class="cTile${brand ? ' cBrand' : ''}">${tile}</div><div class="cMeta"><div class="cName">${esc(name)}</div><div class="cSub">${esc(sub)}</div></div><div class="cSt">${icon(st)}<span>${esc(tr(label))}</span></div></div></div>`;
  // Keep the three Agent rows visible while the window probe is running. The catalog
  // remains an internal readiness/launch source and does not remove a display row.
  const probeReady = conn.agents !== null;
  const catalog = agentCatalog();
  const agents = CONN_AGENTS.map(a => ({ ...a, ...conn.agents?.find(r => r.app === a.app) }));
  const available = probeReady ? availableConnAgents() : [];
  const ready = available.filter(a => a.windows).length;
  const state = a => !conn.host ? 'wait' : !probeReady || a.pending ? 'load' : a.windows ? 'ok' : 'err';
  const names = available.filter(a => a.windows).map(a => a.name).join(I18N.lang === 'en' ? ', ' : '、');
  const missing = available.filter(a => !a.windows).map(a => a.name).join(I18N.lang === 'en' ? ', ' : '、');
  const allReady = ready > 0 && ((conn.catalogReady && available.length > 0 && ready === available.length) || ready === CONN_AGENTS.length);
  $('connTitle').textContent = !conn.host ? tr('正在连接电脑') : !probeReady ? tr('正在连接 Agent…')
    : conn.attachFailed ? tr('当前会话读取失败，可先进入后重试或切换 Agent') : allReady ? tr(conn.loaded ? '正在进入…' : '正在加载当前会话…') : ready ? ct('{ready} 已可用，{missing} 可稍后重试', { ready: names, missing }) : tr('没有可用的 Agent');
  $('connLead').textContent = '';
  $('connHost').innerHTML = row(conn.host ? 'ok' : 'load', CONN_HOST_SVG, currentComputer()?.name || tr('电脑'), tr(conn.host ? '实时连接已建立' : conn.phase), conn.host ? '已连接' : '连接中…');
  $('connAgents').innerHTML = agents.map(a => {
    const st = state(a), open = conn.open.has(a.app);
    const reason = a.timeout ? ct('超时，请检查 {agent} 是否卡住', { agent: a.name }) : a.error ? ct('连接失败，请检查 {agent} 是否已启动', { agent: a.name }) : tr('未找到窗口，请打开项目');
    const installed = catalog?.find(r => r.app === a.app);
    const sub = st === 'ok' ? ct('发现 {n} 个窗口', { n: a.windows }) : st === 'err' ? (connLaunchNote(a) || reason) : tr(st === 'wait' ? '等待主机' : '正在读取窗口…');
    const detail = st === 'ok' ? compatibilityText(a.app) : [ct('地址：{v}', { v: a.address || '' }), a.error || tr('调试服务已响应，但未找到可用的项目窗口。'), a.app === 'cursor' ? tr('启动指引：在电脑上以远程调试模式启动 Cursor，然后重试。') : ct('启动指引：在电脑上运行 {command}，然后重试。', { command: './scripts/start-' + a.app + '.sh' })].join('\n');
    const launch = st === 'err' ? connLaunchStatus.get(a.app) : '';
    const launchBtn = st === 'err' && installed?.installed === true && !installed.running && installed.launchSupported && launch !== 'missing' && launch !== 'unsupported'
      ? `<button class="cBtn cLaunch" data-conn-launch="${a.app}" ${launch === 'launching' ? 'disabled' : ''}>${launch === 'launching' ? `<span class="cSpin"></span>${esc(tr('启动中…'))}` : esc(tr('启动'))}</button>` : '';
    return `<div class="cItem ${st}"><div class="cRow"><div class="cTile cBrand"><img class="on-dark" src="logo-${a.app}-dark.svg" alt=""><img class="on-light" src="logo-${a.app}-light.svg" alt=""></div><div class="cMeta"><div class="cName">${a.name}</div><div class="cSub">${esc(sub)}</div></div><div class="cSt" aria-label="${esc(tr(CONN_TEXT[st]))}">${CONN_ICON[st]}${st === 'err' && !launchBtn ? `<span>${esc(tr('连接失败'))}</span>` : ''}</div>${st === 'err' || st === 'ok' ? `<button class="cWhy" data-conn-why="${a.app}" aria-expanded="${open}">${esc(tr(open ? '收起' : st === 'ok' ? '版本与适配' : '查看原因'))}</button>` : ''}${launchBtn}</div>${(st === 'err' || st === 'ok') && open ? `<div class="cErr"><pre class="cDetail">${esc(detail)}</pre><div class="cActs">${st === 'ok' ? `<button class="cBtn" data-conn-compatibility="${a.app}">${esc(tr('重新检查适配'))}</button>` : `<button class="cBtn" data-conn-retry="agents">${CONN_RETRY_SVG}${esc(tr('重试'))}</button>`}<button class="cBtn ghost" data-conn-why="${a.app}">${esc(tr('收起'))}</button></div></div>` : ''}</div>`;
  }).join('');
  $('connSum').textContent = probeReady ? `${ready}/${CONN_AGENTS.length} ${tr('已发现')}` : '';
  $('connBar').style.gridTemplateColumns = `repeat(${CONN_AGENTS.length}, 1fr)`;
  $('connBar').innerHTML = agents.map(a => `<i class="${state(a)}"></i>`).join('');
  $('connGo').hidden = !probeReady;
  $('connGo').textContent = ready ? tr('先进入') : tr('全部重试');
  const launchable = probeReady ? connMissingApps() : [];
  $('connLaunchAll').hidden = !launchable.length;
  $('connLaunchAll').disabled = launchable.length > 0 && launchable.every(app => connLaunchStatus.get(app) === 'launching');
  $('connAutoPartial').querySelector('.switch').classList.toggle('on', connAutoPartialOn());
  $('connAutoLaunch').querySelector('.switch').classList.toggle('on', store.get('conn-auto-launch') === '1');
  $('connMore').hidden = !probeReady || !!ready;
  $('connPick').hidden = true;
  $('connNote').textContent = probeReady && !ready ? tr('请在电脑上启动 Agent 的调试窗口，再点击全部重试。') : '';
}
$('connGo').onclick = () => {
  if (conn.host === 'err') return boot();
  if (!conn.agents?.some(a => a.windows)) return connRetryAgents();
  ensureReadyAgent();
  conn.enterRequested = true;
  connMaybeEnter();
};
function connRetryAgents() {
  clearTimeout(conn.timer);
  conn.agents = null;
  conn.probeComplete = false;
  conn.failedTargets.clear();
  connRender();
  send({ t: 'connAgents' });
}
$('connAutoPartial').onclick = () => {
  const on = !connAutoPartialOn();
  store.set('conn-auto-partial', on ? '1' : '0');
  connRender();
  // Same as the old button: turning it on while a partial result is showing enters at once.
  if (on) { conn.enterRequested = true; connMaybeEnter(); }
};
$('connPick').onclick = () => showComputers();
$('connRepair').onclick = () => repairPairing();
$('connLaunchAll').onclick = () => connLaunch(connMissingApps());
$('connAutoLaunch').onclick = () => {
  store.set('conn-auto-launch', store.get('conn-auto-launch') === '1' ? '0' : '1');
  connRender();
};
$('conn').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.connCompatibility) { requestCompatibility(b.dataset.connCompatibility, true); connRender(); return; }
  if (b.dataset.connLaunch) return connLaunch([b.dataset.connLaunch]);
  if (b.dataset.connRetry === 'agents') return connRetryAgents();
  if (b.dataset.connRetry === 'diag') return showOffline(lastFailure);
  const key = b.dataset.connWhy;
  if (key) { conn.open.has(key) ? conn.open.delete(key) : conn.open.add(key); connRender(); }
});
$('connSwitch').onclick = () => showComputers();

