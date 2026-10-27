/* ---------- relay discovery & auth ---------- */
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64u = s => b64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4));

// On GitHub Pages, url.json holds one encrypted address per computer. Each computer's key opens only its own entry.
async function computerIdFromKey(keyText) {
  const digest = await crypto.subtle.digest('SHA-256', b64u(keyText));
  return [...new Uint8Array(digest)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}
function loadComputers() {
  let list = [];
  try { list = JSON.parse(store.get('computers') || '[]'); } catch {}
  if (!Array.isArray(list)) list = [];
  list = list.filter(c => c && c.key && c.token);
  if (!list.length && store.get('key') && store.get('token')) {
    list = [{ id: store.get('computer') || '', name: '这台电脑', key: store.get('key'), token: store.get('token'), win: store.get('window') || '' }];
  }
  return list;
}
function currentComputer() {
  const list = loadComputers();
  const id = store.get('computer');
  const key = store.get('key');
  return list.find(c => id && c.id === id) || list.find(c => key && c.key === key) || (list.length === 1 ? list[0] : null);
}
function saveComputers(list, current) {
  const clean = (Array.isArray(list) ? list : []).filter(c => c && c.key && c.token);
  store.set('computers', JSON.stringify(clean));
  const cur = current ? clean.find(c => c.key === current || c.id === current) || null : null;
  store.set('computer', cur?.id || '');
  store.set('key', cur?.key || null);
  store.set('token', cur?.token || null);
  return cur;
}
function rememberComputer(comp) {
  if (!comp?.key || !comp?.token) return currentComputer();
  const list = loadComputers();
  const i = list.findIndex(c => c.key === comp.key);
  if (i >= 0) list[i] = { ...list[i], ...comp, key: list[i].key, token: comp.token || list[i].token };
  else list.push(comp);
  return saveComputers(list, comp.key);
}
function rememberConversation() {
  const here = currentComputer();
  if (!here || currentApp === 'fusion') return;
  const selection = { id: here.win, windowId: here.windowId, threadId: here.threadId };
  const last = here.lastConversation;
  if (last?.id === selection.id && last.windowId === selection.windowId && last.threadId === selection.threadId) return;
  rememberComputer({ ...here, lastConversation: selection,
    previousConversation: last && (last.id !== selection.id || last.windowId !== selection.windowId) ? last : here.previousConversation });
}
function forgetClosedWindow(id) {
  const here = currentComputer();
  if (!here || !id) return;
  const app = String(id).split(':')[0], selections = { ...here.selections };
  const current = here?.win === id, selected = selections[app]?.id === id;
  if (!current && !selected) return;
  if (selected) delete selections[app];
  delete selections[id];
  const next = { ...here, selections };
  if (current) { next.win = ''; next.windowId = ''; next.threadId = ''; }
  if (current && next.lastConversation?.id === id) next.lastConversation = null;
  rememberComputer(next);
  if (current) store.set('window', null);
}
let liveChatSelection = '';
let navigationSerial = 0, navigationPending = null, selectionReady = false, selectionMetadata = '';
let metadataWindow = '';
function beginNavigation(message) {
  message.navigationId = ++navigationSerial;
  navigationPending = { id: message.navigationId, windowId: message.t === 'attach' ? message.id : currentWindow, confirmed: '' };
  conn.attachFailed = false;
  conn.failedTargets?.delete(navigationPending.windowId);
  $('retryChat').hidden = true;
  selectionReady = false;
  setWindowReady(false);
  invalidateChatRender();
  $('items').inert = true;
  $('items').classList.add('stale');
  $('actionBar').replaceChildren();
  renderQuestions(null);
}
function selectionPreview() {
  $('items').inert = true;
  const preview = chatBySel.get(chatCacheKey(viewSel));
  renderChat(preview ? { ...preview, readonly: true, busy: false, global: [], questions: null, queued: [], queuedCount: 0, subagents: [] } : null, !!preview, !preview);
}
function confirmNavigation() {
  const previewed = navigationPending?.preview === viewSel;
  if (navigationPending && !navigationPending.positioning) {
    beginChatSelection();
    navigationPending.positioning = true;
  }
  if (navigationPending) navigationPending.confirmed = viewSel;
  if (mode === 'chat' && liveChatSelection !== viewSel && !previewed) {
    selectionPreview();
    if (navigationPending) navigationPending.preview = viewSel;
  }
  if (mode !== 'chat') { $('items').inert = false; setWindowReady(true); }
}
function refreshSelectionMetadata(initial = false) {
  const key = `${connGen}|${viewSel}|${navigationSerial}`;
  if (selectionMetadata === key) return;
  selectionMetadata = key;
  send({ t: 'usage', automatic: true });
  const window = `${connGen}|${currentApp}|${currentComputer()?.windowId || ''}`;
  if (metadataWindow !== window) {
    metadataWindow = window;
    if (!initial) send({ t: 'windows' });
  }
}
function applySelection(m, clearChat = true) {
  if (m.app) {
    currentApp = m.app; currentAppName = m.appName; currentWindow = m.id;
    capabilityOwner = m.app; agentCapabilities = m.capabilities || null; fusionSideCapabilities = m.sideCapabilities || {};
    updateAppText();
  }
  const changed = (m.sel || '') !== viewSel;
  if (changed) { if (typeof cancelVoice === 'function') cancelVoice(); menuRequest++; saveDraft(); }
  // A new chat gets its thread id once it materializes: keep its pending echoes attached to it.
  if (changed && viewSel.endsWith('|') && (m.sel || '').startsWith(viewSel)) for (const p of pendingEchoes) if (p.sel === viewSel) p.sel = m.sel;
  if (changed) {
    invalidateChatRender();
    selectionReady = false;
    setWindowReady(false);
    $('items').inert = true;
    capabilityBlock = ''; viewSel = m.sel || ''; liveChatSelection = ''; beginChatSelection(); thoughtObserver.disconnect(); cache.clear(); $('sessionNotice').hidden = true;
  }
  const here = currentComputer();
  const id = m.id || here?.win;
  const selection = { windowId: m.windowId ?? here?.windowId ?? '', threadId: m.threadId ?? here?.threadId ?? '' };
  if (here) rememberComputer({
    ...here,
    win: id,
    ...selection,
    selections: { ...here.selections, [id]: selection, [m.app || currentApp]: { id, ...selection } },
  });
  if (changed) { mirroredDraft = ''; restoreDraft(); renderAttachments([]); send({ t: 'attachments' }); }
  const cachedAgents = agentLists.get(agentListKey());
  if (cachedAgents && m.threadId) setAgentList(agentListKey(), cachedAgents.map(a => ({ ...a, current: a.id === m.threadId || a.id === 'tab:' + m.threadId || a.id === 'thread:' + m.windowId + ':' + m.threadId })));
  if (m.project) currentProject = m.project;
  updateTitle();
  if (clearChat && changed) renderChat(null, false, true);
}
async function decryptEntry(keyText, entry) {
  const key = await crypto.subtle.importKey('raw', b64u(keyText), 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(entry.iv) }, key, b64(entry.data));
  return JSON.parse(new TextDecoder().decode(plain)).url;
}

const offline = msg => Object.assign(new Error(msg), { offline: true });
function discoveryUrl() {
  const page = new URL('url.json', location.href).href;
  return pending ? pending.discovery || page : currentComputer()?.discovery || page;
}
// Cross-origin navigation carries bookmarks only; authorization stays in each origin.
function computerBookmarks(list) {
  const bookmarks = new Map();
  for (const c of list) {
    try {
      const discovery = new URL(c.discovery || new URL('url.json', location.href).href);
      if (!/^[a-f0-9]{16}$/.test(c.id) || !/^https?:$/.test(discovery.protocol) || discovery.username || discovery.password) continue;
      discovery.hash = ''; discovery.search = '';
      bookmarks.set(c.id, { id: c.id, name: String(c.name || '电脑'), discovery: discovery.href });
    } catch {}
  }
  return [...bookmarks.values()];
}
function loadComputerBookmarks() {
  try { return computerBookmarks(JSON.parse(store.get('computer-links') || '[]')); } catch { return []; }
}
function computerLink(url, current = '') {
  const target = new URL(url);
  const params = new URLSearchParams(target.hash.slice(1));
  params.delete('computers');
  params.delete('computer');
  params.set('computer-links', JSON.stringify(computerBookmarks([...loadComputerBookmarks(), ...loadComputers()])));
  if (current) params.set('computer', current);
  target.hash = params.toString();
  return target.href;
}
function openComputerEntry(url, current = '') {
  const link = computerLink(url, current);
  if (inApp) return window.AgentRemoteApp.setUrl(link);
  location.href = link;
}
async function resolveBase(data = info, comp = currentComputer(), current = () => true) {
  if (data.self) return new URL(comp?.discovery || discoveryUrl()).origin;
  if (!comp?.key) throw Object.assign(new Error(''), { unpaired: true });
  if (data.v === 2 && data.data) {
    try { return await decryptEntry(comp.key, data); }
    catch { throw offline('这台电脑的地址对不上当前发布的记录，配对还在，可以换一台或稍后重试'); }
  }
  if (data.v !== 3 || !Array.isArray(data.computers)) throw offline('电脑端还没有发布地址（或还在用旧版本），请在电脑上重启服务');
  const id = comp.id || await computerIdFromKey(comp.key);
  let entry = data.computers.find(c => c.id === id);
  if (!entry) {
    for (const c of data.computers) {
      try {
        const url = await decryptEntry(comp.key, c);
        if (current()) rememberComputer({ ...currentComputer(), id: c.id, name: c.name || comp.name || '电脑' });
        return url;
      } catch {}
    }
    throw offline('这台电脑还没有发布地址，请在那台电脑上重启服务');
  }
  if (current() && (!comp.id || (entry.name && entry.name !== comp.name))) rememberComputer({ ...currentComputer(), id: entry.id, name: entry.name || comp.name || '电脑' });
  try { return await decryptEntry(comp.key, entry); }
  catch { throw offline('这台电脑的地址对不上当前发布的记录，配对还在，可以换一台或稍后重试'); }
}

async function api(path, opts = {}) {
  const { timeout = 10000, ...request } = opts;
  const target = base;
  const computer = pending ? loadComputers().find(c => pending.key ? c.key === pending.key : c.id === pending.id) : currentComputer();
  const headers = { 'content-type': 'application/json', ...await entryHeaders(computer, opts.method || 'GET', path), ...opts.headers };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    return await fetch(target + path, { ...request, headers, signal: ctl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });

// Pairing links look like <app>#pair=<url key>.<one-time code>.
function parsePair(text) {
  const entry = /[#&]entry=([\w-]{43})\.([\w-]{43})/.exec(text || '');
  if (entry) return { key: entry[1], invitation: entry[2] };
  const m = /[#&]pair=([\w-]{43})\.([\w-]{16,})/.exec(text || '');
  return m ? { key: m[1], code: m[2] } : null;
}
let entryComputer = '';
{
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.has('computer-links') || params.has('computers') || params.has('computer')) {
    try {
      store.set('computer-links', JSON.stringify(computerBookmarks([...loadComputerBookmarks(), ...JSON.parse(params.get('computer-links') || '[]')])));
    } catch {}
    entryComputer = params.get('computer') || '';
    const selected = loadComputers().find(c => c.id === entryComputer);
    if (selected) saveComputers(loadComputers(), selected.key);
    params.delete('computer-links');
    params.delete('computers');
    params.delete('computer');
    history.replaceState(null, '', location.pathname + location.search + (params.size ? '#' + params.toString() : ''));
  }
}
let pending = parsePair(location.hash) || JSON.parse(sessionStorage.getItem('entry-request') || 'null');
if (pending) history.replaceState(null, '', location.pathname + location.search);
// Opened from a notification: <app>#win=<window id or JSON with windowId and threadId>.
let pendingNotice = '';
{
  const m = /[#&]win=([^&]+)/.exec(location.hash);
  if (m) {
    pendingNotice = decodeURIComponent(m[1]);
    history.replaceState(null, '', location.pathname + location.search);
  }
}
window.addEventListener('hashchange', () => {
  const p = parsePair(location.hash);
  if (!p) return;
  history.replaceState(null, '', location.pathname + location.search);
  pending = p;
  boot();
});
store.set('pw', null);

function deviceName() {
  const ua = navigator.userAgent;
  const model = /Android [\d.]+; (?:[a-z]{2}-[a-z]{2}; )?([^;)]+?)(?: Build|\))/i.exec(ua)?.[1];
  const kind = inApp ? '安卓 App' : /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? '安卓浏览器' : /Mac/.test(ua) ? 'Mac 浏览器' : '浏览器';
  return model && !/^K$/.test(model) ? `${model}（${kind}）` : kind;
}
function entryName() {
  const ua = navigator.userAgent;
  const browser = inApp ? 'App' : /MicroMessenger/.test(ua) ? '微信' : /Edg/.test(ua) ? 'Edge' : /CriOS|Chrome/.test(ua) ? 'Chrome' : /FxiOS|Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : '网页';
  return `${deviceName()} · ${browser}`;
}

function showUnpaired(msg = '') {
  gate({
    msg,
    err: !!msg,
    pairStatus: msg ? { state: 'error', title: '配对申请未完成' } : null,
    input: { placeholder: '输入配对链接或配对码', button: '连接', submit: pastePair, scan: true, inputMode: 'text' },
  });
}

async function pastePair(text) {
  const manual = /^([a-f0-9]{16})\.([\w-]{22})$/.exec(text.replace(/\s/g, ''));
  if (manual) {
    try {
      const discovery = new URL('url.json', location.href).href;
      const registry = await fetch(discovery + '?t=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(10000) }).then(r => { if (!r.ok) throw Error('地址记录读取失败'); return r.json(); });
      if (registry.self) {
        base = new URL(discovery).origin;
        const me = await fetch(base + '/api/me').then(r => r.json());
        if (me.id !== manual[1]) throw Error('配对码对应的电脑与当前入口不一致');
        pending = { id: manual[1], code: manual[2], discovery };
        connGen++;
        authed = false;
        ws?.close();
        return pair();
      }
      const entry = registry.computers?.find(c => c.id === manual[1]);
      if (!entry?.pairing || entry.pairing.expires <= Date.now()) throw Error('配对码未发布或已过期，请在电脑上重新运行 npm run pair');
      const rawKey = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(manual[2]));
      const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(entry.pairing.iv) }, key, b64(entry.pairing.data));
      const decoded = JSON.parse(new TextDecoder().decode(plain));
      if (decoded.id !== manual[1]) throw Error('配对码对应的电脑不一致');
      pending = { key: decoded.key, code: manual[2], discovery, stay: true };
      connGen++;
      authed = false;
      ws?.close();
      return boot();
    } catch (e) { return showUnpaired(e.name === 'OperationError' ? '配对码不正确' : e.message); }
  }
  const p = parsePair(text);
  if (!p) return showUnpaired('请输入完整配对链接或电脑码.一次性配对码');
  let target;
  try { target = new URL(text.trim()); } catch {}
  if (target && /^https?:$/.test(target.protocol) && target.origin !== location.origin) {
    return openComputerEntry(target.href);
  }
  if (target && /^https?:$/.test(target.protocol)) p.discovery = new URL('url.json', target).href;
  pending = p;
  connGen++;
  authed = false;
  const old = ws;
  ws = null;
  try { old?.close(); } catch {}
  boot();
}

function showTotp(onCode, err = '') {
  gate({
    msg: (err ? err + '\n' : '') + '请输入 Authenticator 里「Remote Agent」的 6 位验证码',
    err: !!err,
    input: { placeholder: '000000', button: '验证', code: true, submit: onCode },
  });
}

async function testEndpoint(url, relay = false, timeout = 8000) {
  const start = performance.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const response = await fetch(url + '?t=' + Date.now(), { cache: 'no-store', signal: ctl.signal });
    if (!response.ok) return { ok: false, code: 'http', http: 'HTTP ' + response.status, detail: 'HTTP ' + response.status };
    const data = await response.json();
    const valid = relay ? data?.self === true : data?.self === true || (data?.v === 3 && Array.isArray(data.computers)) || (data?.v === 2 && !!data.data);
    return { ok: valid, ms: Math.round(performance.now() - start), code: valid ? '' : 'invalid', detail: valid ? `正常 · ${Math.round(performance.now() - start)} ms` : '返回内容不符合预期' };
  } catch (error) {
    return { ok: false, timedOut: ctl.signal.aborted, timeout: timeout / 1000, code: ctl.signal.aborted ? 'timeout' : error instanceof SyntaxError ? 'json' : 'network', detail: ctl.signal.aborted ? `请求超时（${timeout / 1000} 秒）` : error instanceof SyntaxError ? '返回内容不是 JSON' : '请求失败（网络、DNS、证书或跨域原因未确定）' };
  } finally { clearTimeout(timer); }
}
let offlineGen = 0;
let lastFailure = { stage: '应用连接', error: '' };
async function diagnoseConnection(failure, gen) {
  const page = discoveryUrl();
  const relay = base ? base.replace(/\/$/, '') + '/url.json' : '';
  const online = navigator.onLine !== false;
  conn.checks = [
    { key: 'net', label: '手机网络', st: online ? 'ok' : 'err', code: online ? '' : 'offline' },
    { key: 'page', label: '页面地址发布', url: page, st: 'load' },
    { key: 'relay', label: '隧道和电脑服务', url: relay, st: relay ? 'load' : 'err', code: relay ? '' : 'nourl', detail: relay ? '' : '尚未获取隧道地址' },
  ];
  conn.diagRunning = true;
  const draw = () => { if (gen === offlineGen && conn.active) connRender(); };
  draw();
  const run = async (check, relayCheck) => {
    if (!check.url) return { ok: false, code: 'nourl', detail: '尚未获取隧道地址' };
    let result = await testEndpoint(check.url, relayCheck);
    if (gen !== offlineGen) return result;
    if (relayCheck && result.timedOut) {
      Object.assign(check, { retest: true });
      draw();
      result = await testEndpoint(check.url, true, 30000);
      result.slow = result.ok;
      if (result.ok) result.detail = '复测可达 · ' + result.detail;
    }
    Object.assign(check, { st: result.ok ? 'ok' : 'err', code: result.code, http: result.http, timeout: result.timeout, ms: result.ms, slow: !!result.slow, detail: result.detail, retest: false });
    draw();
    return result;
  };
  const results = await Promise.all([run(conn.checks[1], false), run(conn.checks[2], true)]);
  if (gen !== offlineGen) return '';
  conn.diagRunning = false;
  const conclusion = !online ? '手机处于离线状态，请检查 Wi-Fi 或移动数据'
    : results[1].slow ? '隧道复测可达；可能是慢连接或短暂波动，首次 8 秒检测超时。'
    : results[0].ok && results[1].timedOut ? '页面地址发布正常，隧道 30 秒复测仍超时；请切换 Wi-Fi 对比，尚不能确定具体网络原因。'
    : !relay ? '尚未获取隧道地址；当前只能检测页面地址发布。'
    : !results[0].ok && results[1].ok ? '电脑服务可达，页面地址发布请求异常。'
    : results[0].ok && !results[1].ok ? '页面地址发布正常，隧道请求异常。'
    : results.every(result => result.ok) ? '两个网址现在都正常；检查下方失败阶段。此前也可能是短暂网络波动。'
    : '两个请求均未通过；仅凭浏览器请求不能确定是手机网络、入口还是服务异常。';
  return conclusion;
}

function publishedComputers() {
  if (info?.v === 3 && Array.isArray(info.computers)) return info.computers.filter(c => c && c.id);
  return [];
}
function unseenPublished() {
  const saved = loadComputers();
  const entries = new Map([...publishedComputers(), ...loadComputerBookmarks()].map(p => [p.id, p]));
  return [...entries.values()].filter(p => !saved.some(c => c.id && c.id === p.id));
}
function offerComputers(msg, { err = true, repair = false } = {}) {
  const many = loadComputers().length > 1 || unseenPublished().length > 0;
  gate({ msg, err, retry: true, repair, computers: many || loadComputers().length > 0 });
  if (many) showComputers(msg);
  else autoRetry();
}
async function showOffline(failure = { stage: '应用连接', error: '' }) {
  const gen = ++offlineGen;
  lastFailure = failure;
  clearTimeout(retryTimer);
  ungate();
  conn.open.delete('connection-details');
  conn.checks = [];
  connOffline(failure);
  autoRetry();
  const conclusion = await diagnoseConnection(failure, gen);
  if (gen !== offlineGen) return;
  connOffline(failure, conclusion);
}

async function pair(totp) {
  gate({ pairStatus: { state: 'loading', title: '正在配对…' } });
  let r, body;
  try {
    const { publicKey } = await entryKey();
    r = await post('/api/pair', { code: pending.code, name: entryName(), publicKey, totp });
    body = await r.json().catch(() => ({}));
  } catch (error) {
    return showUnpaired(error.message);
  }
  if (r.ok) {
    if (body.pending) {
      Object.assign(pending, { key: body.key, requestId: body.id, secret: body.secret, code: body.code, expires: body.expires, desktop: true });
      sessionStorage.setItem('entry-request', JSON.stringify(pending));
      return joinEntryRequest();
    }
    return finishPair(body);
  }
  if (body.needTotp) return showTotp(code => pair(code), body.error);
  pending = null;
  if (store.get('token')) return gate({ msg: body.error || '配对失败', err: true, retry: '继续使用', pairStatus: { state: 'paired', title: '此入口已有配对记录', note: '这台设备之前已经配对过，可以继续使用。' } });
  showUnpaired(body.error || '配对失败');
}

async function finishPair(body) {
  const key = body.key || pending.key;
  const id = body.id || await computerIdFromKey(key);
  const prev = loadComputers().find(c => c.key === key);
  const list = loadComputers().filter(c => c.key !== key);
  list.push({ ...prev, id, name: body.name || prev?.name || '电脑', key, token: body.token, device: body.device || prev?.device || '', win: prev?.win || '', discovery: discoveryUrl(), relay: base });
  saveComputers(list, key);
  pending = null;
  entryComputer = '';
  sessionStorage.removeItem('entry-request');
  return connect();
}

let entryJoinGeneration = 0;
async function joinEntryRequest() {
  const generation = ++entryJoinGeneration, request = pending;
  let terminal = false;
  const cancel = () => {
    post('/api/entries/cancel', { id: request.requestId, secret: request.secret }).catch(() => {});
    entryJoinGeneration++; pending = null; sessionStorage.removeItem('entry-request');
    showUnpaired('已取消入口授权');
  };
  try {
    if (!request.requestId) {
      gate({ pairStatus: { state: 'loading', title: '正在申请入口授权…' } });
      const { publicKey } = await entryKey();
      const r = await post('/api/entries/join', { invitation: request.invitation, name: entryName(), publicKey });
      const body = await r.json();
      if (!r.ok) { terminal = true; throw new Error(body.error || '申请失败'); }
      if (generation !== entryJoinGeneration || pending !== request) return;
      Object.assign(request, { requestId: body.id, secret: body.secret, code: body.code, expires: body.expires });
      delete request.invitation;
      sessionStorage.setItem('entry-request', JSON.stringify(request));
    }
    gate({ msg: request.desktop ? '请在电脑配对窗口核对验证码，然后点击「允许连接」。' : '请在已配对入口的「已配对设备」中核对验证码并同意。', pairStatus: { state: 'waiting', title: request.desktop ? '等待电脑批准' : '等待入口批准', detail: '请核对两端的验证码', code: request.code }, retry: '取消申请', onRetry: cancel });
    while (generation === entryJoinGeneration && pending === request) {
      const r = await post('/api/entries/status', { id: request.requestId, secret: request.secret });
      const body = await r.json();
      if (generation !== entryJoinGeneration || pending !== request) return;
      if (!r.ok) { terminal = true; throw new Error(body.error || '授权查询失败'); }
      if (body.state === 'approved') return finishPair(body);
      if (body.state === 'denied') { terminal = true; throw new Error('本次入口申请已被拒绝'); }
      if (Date.now() >= request.expires) { terminal = true; throw new Error('授权请求已过期，请重新生成链接'); }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } catch (error) {
    if (generation !== entryJoinGeneration || pending !== request) return;
    if (!terminal && request.requestId) return gate({ msg: '暂时无法查询授权，申请已保留，请重试。', err: true, retry: true, repair: true, pairStatus: { state: 'error', title: '配对申请未完成' } });
    sessionStorage.removeItem('entry-request'); pending = null;
    showUnpaired(error.message);
  }
}

async function verifyTotp(code) {
  gate({ msg: '正在验证…' });
  try {
    const r = await post('/api/totp', { code });
    const body = await r.json().catch(() => ({}));
    if (r.ok) return connect();
    showTotp(verifyTotp, body.error || '验证失败');
  } catch {
    showOffline();
  }
}

let bootGeneration = 0;
async function boot() {
  const generation = ++bootGeneration;
  connGen++;
  offlineGen++;
  const old = ws;
  if (authed) {
    markUploadsDisconnected();
    disconnectPendingSends();
    failFileSave('连接已断开，保存结果未确认，请重试');
    cancelChatContentRequests();
    interruptSessionBatch();
    cancelCodexAutoRetry();
  }
  ws = null;
  try { old?.close(); } catch {}
  clearInterval(pingTimer);
  authed = false;
  clearTimeout(retryTimer);
  // Android browser opened a pairing link: offer to hand it to the installed app instead.
  if (pending?.code && !pending.requestId && /Android/.test(navigator.userAgent) && !inApp && !pending.stay) {
    const link = `agentremote://pair?app=${encodeURIComponent(location.origin + location.pathname)}&d=${pending.key}.${pending.code}`;
    gate({ msg: '已收到配对链接。\n装了安卓 App 就在 App 里打开；否则直接在浏览器里用。', appLink: link, retry: '在浏览器里继续' });
    pending.stay = true;
    return;
  }
  gate({ msg: '正在查找电脑…' });
  if (pending?.key) {
    const saved = loadComputers().find(c => c.key === pending.key);
    if (saved) saveComputers(loadComputers(), saved.key);
  }
  if (!pending && currentComputer()) connShow('正在查找电脑…');
  const chosen = currentComputer();
  const current = () => generation === bootGeneration && currentComputer()?.key === chosen?.key;
  const discovery = fetch(discoveryUrl() + '?t=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(10000) }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  // An existing paired address can authenticate while the published directory refreshes.
  if (!pending && chosen?.relay && (!entryComputer || entryComputer === chosen.id)) {
    base = chosen.relay;
    discovery.then(async data => {
      const relay = await resolveBase(data, chosen, current);
      if (!current()) return;
      info = data;
      rememberComputer({ ...currentComputer(), relay });
      if (!authed && ws?.readyState === 3 && base !== relay) { base = relay; connect(); }
    }).catch(() => {});
    if (chosen.win) store.set('window', chosen.win);
    await chatPreviewReady;
    if (current()) connect();
    return;
  }
  try {
    const data = await discovery;
    if (!current()) return;
    info = data;
  } catch (error) {
    if (!current()) return;
    base = currentComputer()?.relay || '';
    return showOffline({ stage: '页面地址读取', error: error.message });
  }
  if (pending) {
    try { const relay = await resolvePending(); if (!current()) return; base = relay; }
    catch (e) { if (current()) return showUnpaired(e.message || '这台电脑还没有发布地址'); return; }
    return pending.invitation || pending.requestId ? joinEntryRequest() : pair();
  }
  if (entryComputer && !loadComputers().some(c => c.id === entryComputer)) {
    return showComputers('当前入口尚未配对这台电脑，请使用配对链接或由已配对入口添加授权。');
  }
  try {
    const relay = await resolveBase(info, chosen, current);
    if (!current()) return;
    base = relay;
  } catch (e) {
    if (!current()) return;
    if (!loadComputers().length) return e.unpaired ? showUnpaired(e.message) : gate({ msg: e.message, err: true, retry: true, repair: true });
    return showOffline({ stage: '地址发现', error: e.message });
  }
  if (!currentComputer()) return loadComputers().length ? offerComputers('选择要连接的电脑', { err: false }) : showUnpaired();
  rememberComputer({ ...currentComputer(), relay: base });
  if (chosen?.win) store.set('window', chosen.win);
  await chatPreviewReady;
  if (current()) connect();
}

async function resolvePending() {
  if (info.self) return new URL(discoveryUrl()).origin;
  if (info.v === 2 && info.data) return decryptEntry(pending.key, info);
  if (info.v !== 3 || !Array.isArray(info.computers)) throw new Error('电脑端还没有发布地址，请在那台电脑上重启服务');
  const id = await computerIdFromKey(pending.key);
  let entry = info.computers.find(c => c.id === id);
  if (!entry) {
    for (const c of info.computers) {
      try { await decryptEntry(pending.key, c); entry = c; break; } catch {}
    }
  }
  if (!entry) throw new Error('这台电脑还没有发布地址，请在那台电脑上重启服务');
  return decryptEntry(pending.key, entry);
}

let retryTimer = null, pingTimer = null, lastRx = 0;
// A dead network path can leave the socket looking open while sends vanish into it.
// Ping the relay when nothing has arrived for a while; if it stays silent, drop the
// socket so the normal reconnect path runs instead of waiting for a manual refresh.
function heartbeat() {
  if (!authed || !ws || ws.readyState !== 1) return;
  if (Date.now() - lastRx > 45000) return closeSocket(ws);
  ws.send(JSON.stringify({ t: 'ping', visible: document.visibilityState === 'visible' }));
}
// close() waits for the peer's close frame, which a dead path never sends — the
// socket then sits in CLOSING and onclose never fires. Force the cleanup.
function closeSocket(socket) {
  try { socket.close(); } catch {}
  setTimeout(() => {
    if (ws !== socket || socket.readyState === 3 || !socket.onclose) return;
    const onclose = socket.onclose;
    socket.onclose = null;
    try { onclose.call(socket, { code: 1006 }); } catch {}
  }, 5000);
}
function autoRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => { if (!authed) boot(); }, 15000);
}

async function connect() {
  const gen = ++connGen, attempt = bootGeneration;
  resetLatency();
  liveChatSelection = '';
  navigationPending = null;
  selectionReady = false;
  selectionMetadata = metadataWindow = '';
  const computer = currentComputer();
  const expectedId = computer.id || await computerIdFromKey(computer.key);
  if (gen !== connGen || attempt !== bootGeneration || computer.key !== currentComputer()?.key) return;
  offlineGen++;
  draftEpoch = '';
  draftRevision = draftAckRevision = 0;
  if (text.value || drafts.has(activeDraft)) draftRevision++;
  setWindowReady(false);
  clearTimeout(retryTimer);
  if (conn.active || $('gate').classList.contains('open')) connShow('正在建立实时连接…');
  const previous = ws;
  try { previous?.close(); } catch {}
  ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
  let opened = false;
  const socket = ws;
  const connectTimer = setTimeout(() => { if (gen === connGen && !authed) closeSocket(socket); }, 10000);
  ws.onopen = async () => {
    opened = true;
    try {
      const proof = await entryProof(computer, 'WS /ws');
      if (gen === connGen && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'auth', token: computer.token, proof }));
    } catch (error) { if (gen !== connGen) return; rejected = true; socket.close(); showUnpaired(error.message); }
  };
  let rejected = false;
  ws.onclose = async event => {
    clearTimeout(connectTimer);
    if (gen !== connGen) return;
    resetLatency();
    setWindowReady(false);
    markUploadsDisconnected();
    disconnectPendingSends();
    failFileSave('连接已断开，保存结果未确认，请重试');
    qnPending = null;
    cancelChatContentRequests();
    interruptSessionBatch();
    cancelCodexAutoRetry();
    qnSig = '';
    renderQuestions(null);
    $('dot').className = '';
    if (!authed) {
      if (rejected) return;
      const relay = currentComputer()?.relay;
      if (relay && relay !== base) { base = relay; return connect(); }
      return showOffline({ stage: opened ? '实时连接认证' : '实时连接建立', error: 'WebSocket 关闭码 ' + event.code });
    }
    authed = false;
    clearInterval(pingTimer);
    failures++;
    status('断开，重连中…', false);
    await sleep(Math.min(8000, 800 * failures));
    // Rediscover the address using the saved computer identity and device token.
    if (gen === connGen && attempt === bootGeneration) boot();
  };
  ws.onmessage = ev => {
    if (gen !== connGen) return;
    const m = JSON.parse(ev.data);
    lastRx = Date.now();
    if (['attached', 'thread', 'chat', 'projectReady', 'attachFailed', 'status'].includes(m.t)
        && m.navigationId != null && m.navigationId !== navigationSerial) return;
    if (m.t === 'pong') return;
    if (m.t === 'auth') {
      clearTimeout(connectTimer);
      if (m.id !== expectedId || !m.ok) {
        rejected = true;
        socket.close();
        if (m.id !== expectedId) return showOffline({stage: '电脑身份验证', error: '地址对应的电脑身份不一致，正在等待最新地址'});
        if (m.needTotp) return showTotp(verifyTotp);
        return gate({msg: '设备授权已失效或被移除，请重新授权这台设备。', err: true, repair: true, computers: loadComputers().length > 1});
      }
      rememberComputer({...currentComputer(), id: m.id, name: m.name, device: m.device});
      authed = true; failures = 0;
      send({ t: 'sessionLibrary', entries: legacyAgentLibrary() });
      document.dispatchEvent(new Event('voice-authenticated'));
      ungate();
      connHostOk();
      if (sheetKind === 'computers') closeSheet();
      status('正在切换窗口…');
      send({ t: 'mode', mode });
      const fromNotice = window.AgentRemoteApp?.takeOpenWin?.() || pendingNotice;
      pendingNotice = '';
      if (fromNotice && noticeTarget(fromNotice)?.computer && noticeTarget(fromNotice).computer !== m.id) {
        if (!openWin(fromNotice)) showComputers('通知来源电脑未配对，请从电脑列表连接');
        return;
      }
      if (fromNotice) rememberNotice(fromNotice);
      const chosen = currentComputer();
      send({ t: 'attach', id: chosen?.win || store.get('window') || '', windowId: chosen?.windowId || '', threadId: chosen?.threadId || '', initial: true });
      send({ t: 'visible', v: document.visibilityState === 'visible' });
      send({ t: 'lang', v: I18N.lang });
      clearInterval(usageTimer);
      usageTimer = setInterval(() => { if (authed && document.visibilityState === 'visible') send({ t: 'usage', automatic: true }); }, 60 * 1000);
      clearInterval(pingTimer);
      pingTimer = setInterval(heartbeat, 15000);
      syncNotify();
      setTimeout(checkAppUpdate, 3000);
    }
    else if (m.t === 'sent') {
      confirmSent(m);
    }
    else if (m.t === 'queueDone') receiveQueueDone(m);
    else if (m.t === 'clickDone') {
      finishCodexAutoRetry(m);
      if (m.sel !== viewSel) return;
      const button = [...$('items').querySelectorAll('button[data-item]')].find(b => b.dataset.item === String(m.item) && b.dataset.actionId === (m.actionId || ''));
      button?.closest('.btns')?.querySelectorAll('button').forEach(b => { b.disabled = false; });
    }
    else if (m.t === 'sendFailed') failPendingSend(m.requestId, m.message || '发送失败，请重试');
    else if (m.t === 'questionDone') finishQuestion(m);
    else if (m.t === 'latency') receiveLatency(m);
    else if (m.t === 'visual') renderVisualState(m);
    else if (m.t === 'visualWindows') { receiveVisualWindows(m); if (mode === 'screen') connContentReady(); }
    else if (m.t === 'imageDone') { finishImageUpload(m); }
    else if (m.t === 'imageEdit') { if (m.sel === viewSel) openImageEditor(m).catch(e => status('图片编辑失败：' + e.message, false)); }
    else if (m.t === 'attachments') { if (m.sel === viewSel) renderAttachments(m.list); }
    else if (m.t === 'chat') {
      if (!m.sel || !viewSel || m.sel === viewSel) {
        if (navigationPending && (m.navigationId !== navigationPending.id || navigationPending.confirmed !== viewSel)) return;
        if (m.cached && liveChatSelection === (m.sel || viewSel)) return;
        const fresh = m.chat && !m.cached && selectionReady;
        if (fresh) {
          const becameReady = !windowReady;
          if (navigationPending?.preview === viewSel && chatStale) for (const item of m.chat.items) if (item.b?.length) cache.delete(item.i);
          liveChatSelection = m.sel || viewSel;
          navigationPending = null;
          $('retryChat').hidden = true;
          $('items').inert = false;
          setWindowReady(true);
          if (becameReady) queueDraftSync();
        }
        if (m.chat && !m.cached && !m.chat.readonly) capabilityBlock = '';
        const preview = chatBySel.get(chatCacheKey(m.sel || viewSel));
        // Codex unmounts the transcript while its generated-image editor is open.
        const obscured = currentApp === 'codex' && !!m.chat?.imagePreview;
        const retain = obscured && m.chat.items.length === 0 && preview?.items.length > 0 && preview.thread === m.chat.thread;
        const chat = retain ? { ...preview, ...m.chat, items: preview.items } : m.chat;
        if (chat) cacheChat(m.sel || viewSel, chat);
        queueChatRender(chat, !!m.cached || obscured, m.sel);
        if (fresh) {
          const selection = viewSel, navigation = navigationSerial;
          requestAnimationFrame(() => { if (windowReady && viewSel === selection && navigationSerial === navigation) refreshSelectionMetadata(); });
        }
      }
    }
    else if (m.t === 'draft') receiveDraft(m);
    else if (m.t === 'draftAck') receiveDraft(m);
    else if (m.t === 'historyPage') receiveHistoryPage(m);
    else if (m.t === 'historyDone') finishHistory(m);
    else if (m.t === 'thread') {
      applySelection(m);
      if (m.ready === true) { selectionReady = true; confirmNavigation(); }
    }
    else if (m.t === 'frame') onFrame(m);
    else if (m.t === 'panel') { panel = m.rect; updateTermEmpty(); layoutStage(); }
    else if (m.t === 'connAgents') connAgentResults(m.agents, m.complete !== false);
    else if (m.t === 'agentCatalog') agentCatalogResults(m.agents);
    else if (m.t === 'launchResult') connLaunchResults(m.results);
    else if (m.t === 'windows') { windows = m.list; currentWindow = m.current; connWindows(m.list); if (m.plans) { appPlans = { ...appPlans, ...m.plans }; updateTitle(); } if (sheetKind === 'windows') showWindows(); paintRail(); }
    else if (m.t === 'plans') { if (m.plans) { appPlans = { ...appPlans, ...m.plans }; updateTitle(); if (sheetKind === 'windows') showWindows(); paintRail(); } }
    else if (m.t === 'fusionTrust') openSheet('fusion-trust', `<h3>确认项目可信</h3><div class="hint">${esc(m.path)}</div><button class="opt" data-fusion-trust="yes"><span class="lbl">信任并创建会话</span></button><button class="opt" data-fusion-trust="no"><span class="lbl">取消</span></button>`);
    else if (m.t === 'fusionProjects') showFusionProjects(m);
    else if (m.t === 'fusionSides') showFusionSides(m);
    else if (m.t === 'fusionHistory') showFusionHistory(m);
    else if (m.t === 'fusionUsage') {
      if (currentApp !== 'fusion' || (m.sel && m.sel !== viewSel) || !lastChat?.fusion) return;
      for (const side of ['a', 'b']) if (lastChat.fusion[side]) lastChat.fusion[side].usage = m[side];
      renderFusionMeters(lastChat.fusion);
      finishPending(['正在读取额度…']);
    }
    else if (m.t === 'attached') {
      if (m.closed) {
        forgetClosedWindow(m.id);
        selectionReady = m.ready === true;
        connReadFailed('这个窗口已经关闭，请重试或切换 Agent');
        send({ t: 'windows' });
        if (conn.active) connRender();
        return;
      }
      if (m.plans) appPlans = { ...appPlans, ...m.plans };
      rememberAgentOpen(m);
      if (m.keepQuota) {
        applySelection(m, false);
        selectionReady = m.ready !== false;
        if (selectionReady) confirmNavigation();
        else { setWindowReady(false); renderChat(null, false, true); }
        return;
      }
      finishPending(['正在切换窗口…', '正在切换 Agent…']);
      store.set('window', m.id);
      applySelection(m, false);
      selectionReady = m.ready !== false;
      setWindowReady(selectionReady && mode !== 'chat');
      scheduleLatency();
      $('dot').className = 'ok';
      status(mode === 'chat' ? '正在加载对话…' : '已连接');
      $('titleText').textContent = m.app === 'fusion' ? 'Fusion' : m.app === 'devin' ? 'Devin agent' : m.app === 'codex' ? 'Codex' : winLabel(m.title).name;
      currentProject = m.app === 'fusion' ? '' : (m.project || winLabel(m.title).name);
      updateAppText(); updateTitle();
      if (selectionReady) confirmNavigation();
      else renderChat(null, false, true);
      renderContext(null);
      $('quotaMeters').innerHTML = '';
      $('quotaMeters').title = '';
      renderQuota(quotaCache.get(quotaKey()) || { missing: true, quota: [], limits: [] });
      send({ t: 'appTheme', dark: document.documentElement.dataset.theme !== 'light' });
      if (m.initial) metadataWindow = `${connGen}|${currentApp}|${m.windowId || ''}`;
      if (mode !== 'chat' && selectionReady) refreshSelectionMetadata(m.initial === true);
    }
    else if (m.t === 'attachFailed') {
      selectionReady = m.ready === true;
      connReadFailed(m.message || '当前会话读取失败，请重试或切换 Agent');
    }
    else if (m.t === 'sessionLibrary') receiveSessionLibrary(m);
    else if (m.t === 'sessionChanged') receiveSessionChange(m);
    else if (m.t === 'sessionActions') receiveAgentActions(m);
    else if (m.t === 'sessionBatchProgress') receiveSessionBatch(m);
    else if (m.t === 'projectWindows') showProjectWindows(m);
    else if (m.t === 'agents') receiveAgents(m);
    else if (m.t === 'codexArchived') {
      const conv = String(m.id || '').split(':').slice(2).join(':');
      if (conv) scKeys().then(keys => Promise.all((keys || []).map(async k => {
        const key = String(k).startsWith('m:') ? String(k).slice(2) : String(k);
        if (key.endsWith('|' + conv)) await scClear(key);
      }))).catch(() => {});
    }
    else if (m.t === 'terminals') { finishPending(['正在读取终端列表…']); showTerminals(m.list || []); }
    else if (m.t === 'agentBusy') $('termBusy').hidden = !(mode === 'terminal' && m.busy);
    else if (m.t === 'termText') { if (!m.sel || !viewSel || m.sel === viewSel) { renderTerm(m); connContentReady(); } }
    else if (m.t === 'termHistory') recallTerminal(m);
    else if (m.t === 'termInput' && mode === 'terminal') {
      text.value = m.text || '';
      const end = text.value.length;
      text.setSelectionRange(end, end);
      autosize();
    }
    else if (m.t === 'projects') { finishPending(['正在读取项目…', '正在读取文件夹…', '正在新建对话…']); showProjects(m); }
    else if (m.t === 'projectTrust') {
      if (m.sel && m.sel !== viewSel) return;
      capabilityBlock = '请先确认项目是否可信';
      connHide();
      finishPending(['正在打开项目…', '正在新建对话…']);
      openSheet('project-trust', `<h3>信任此项目？</h3><p class="hint">信任后，Agent 和扩展可运行此项目的代码。只信任你了解来源的项目。</p><p>${esc(m.path)}</p><button class="opt" data-project-trust="yes">信任此项目</button><button class="opt" data-project-trust="no">保持限制模式并返回上次对话</button>`);
    }
    else if (m.t === 'projectReady') {
      if (m.sel && m.sel !== viewSel) return;
      selectionReady = true;
      confirmNavigation();
      const refreshEditor = editorBrowsing && sheetKind === 'docs';
      capabilityBlock = '';
      finishPending(['正在打开项目…', '正在新建对话…']);
      closeSheet(); currentProject = m.name;
      if (m.chat) {
        liveChatSelection = viewSel;
        navigationPending = null;
        $('items').inert = false;
        setWindowReady(true);
        cacheChat(viewSel, m.chat);
        renderChat(m.chat);
        refreshSelectionMetadata();
      }
      $('titleProject').textContent = m.name;
      $('sessionNotice').hidden = !m.newSession;
      $('sessionNotice').textContent = I18N.tr('会话创建成功，尚未发送消息。') + ' ' + m.name;
      status(m.newSession ? '已在所选项目新建会话' : '已打开项目');
      if (refreshEditor) startEditor();
    }
    else if (m.t === 'docs') showDocs(m);
    else if (m.t === 'settings') { if (m.codex && m.requestId !== codexSettingsRequest) return; finishPending(['正在读取设置…', '正在修改…', '正在保存指令…']); m.codex ? showCodexSettings(m) : showSettings(m.sections || [], m.nav || [], m.current || '', m.choices || []); }
    else if (m.t === 'usage') {
      if (currentApp === 'fusion' || (m.sel && viewSel && m.sel !== viewSel)) return;
      if (m.plan) { appPlans = { ...appPlans, [currentApp]: m.plan }; updateTitle(); }
      if (m.missing) status('没有额度数据');
      renderQuota(m);
      if (!m.cached) finishPending(['正在读取额度…']);
    }
    else if (m.t === 'fastState') {
      if (m.sel && m.sel !== viewSel) return;
      for (const [key, cached] of menuCache) {
        if (!key.startsWith(`${currentApp}|${viewSel}|`)) continue;
        cached.fast = m.fast;
        if (m.fusion) cached.fusion = m.fusion;
      }
      if (m.fusion && lastChat?.fusion) lastChat.fusion = m.fusion;
      const cost = $('sheet').querySelector('[data-fusion-cost]');
      if (cost && m.fusion) cost.innerHTML = modelPricingHtml(m.fusion.pricing, true);
      $('sheet').querySelectorAll('[data-fast], [data-fusion="fast"]').forEach(button => {
        if (button.dataset.fast) button.dataset.fast = m.fast.on ? 'off' : 'on';
        button.querySelector('.switch')?.classList.toggle('on', m.fast.on);
      });
      finishPending(['设置中…', '正在修改…']);
    }
    else if (m.t === 'menuPicked') finishModelPick(m);
    else if (m.t === 'menu') {
      if (m.sel && viewSel && m.sel !== viewSel) return;
      if (m.requestId != null && (m.requestId !== menuRequest || m.requestId !== menuPending?.requestId
        || m.kind !== menuPending.kind || menuPending.sel !== viewSel)) return;
      lruPut(menuCache, menuCacheKey(m.kind), m, 24);
      if (currentApp === 'fusion' && /^fusion-(model|effort)-[ab]$/.test(m.kind) && fusionModelSide === m.kind.slice(-1)) {
        showMenu(m.kind, m.items, m.max, m.fusion, m.fast, m.model, false, m.pricing);
        return;
      }
      if (m.requestId == null && !(sheetKind === 'menu' && menuSheetKind === m.kind)) return;
      showMenu(m.kind, m.items, m.max, m.fusion, m.fast, m.model, false, m.pricing);
    }
    else if (m.t === 'params') showParams(m);
    else if (m.t === 'changes') showChanges(m);
    else if (m.t === 'file') { if (m.requestId === fileRequestId) showFile(m); }
    else if (m.t === 'fileMarks') {
      if (m.requestId === fileRequestId && viewing && viewing.path === m.path && String(viewing.host || '') === String(m.host || '')) {
        viewing.marks = m.marks || null;
        viewing.markSource = m.markSource;
        viewing.commit = m.commit;
        viewing.subject = m.subject;
        if (m.newFile) viewing.newFile = true;
        if (m.diff) viewing.diff = m.diff;
        if (editing) return;
        const body = $('vBody'), y = body.scrollTop;
        renderFileCode(viewing);
        body.scrollTop = y;
      }
    }
    else if (m.t === 'thought') onThought(m);
    else if (m.t === 'revertConfirm') {
      (async () => {
        const ok = await ask(m.title ? `${m.title}${m.body ? '\n' + m.body : ''}` : '确认回退？', '确认回退');
        if (!ok) return send({ t: 'revertCancel' });
        const apply = m.apply === null || m.apply === undefined ? undefined : await ask('同时撤销这些文件改动吗？\n取消 = 只回退对话，保留文件', '撤销文件');
        send({ t: 'revertOk', ...(apply === undefined ? {} : { apply }) });
      })();
    }
    else if (m.t === 'trunc') scTrunc(m.from);
    else if (m.t === 'workdirs') showWorkdirs(m);
    else if (m.t === 'mentions') onMentions(m);
    else if (m.t === 'codexSkills') showCodexSkills(m.rows || []);
    else if (m.t === 'unqueued') {
      text.value = text.value.trim() ? `${text.value.replace(/\s+$/, '')}\n${m.text}` : m.text;
      autosize();
      text.focus();
      status('已取出，放回输入框');
    }
    else if (m.t === 'saved') onSaved(m);
    else if (m.t === 'status') { if (!m.ok) pendingAgentOpen = ''; if (!m.ok && String(m.msg).startsWith('连不上 Cursor、Devin 或 Codex。')) connWindows([]); clearSwitchWatch(); status(m.msg, m.ok); }
  };
}

