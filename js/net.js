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
async function fetchDiscovery(url, signal) {
  const read = async (source, redirect) => {
    const endpoint = new URL(source, location.href);
    endpoint.searchParams.set('t', Date.now());
    const response = await fetch(endpoint, { cache: 'no-store', signal, redirect, credentials: 'omit' });
    if (!response.ok) throw Object.assign(new Error('HTTP ' + response.status), { status: response.status });
    return response.json();
  };
  const data = await read(url, 'follow');
  if (data?.v !== 4) return data;
  if (!/^https:\/\/raw\.githubusercontent\.com\/[\w-]+\/[\w.-]+\/[\w-][\w.-]*\/url\.json$/.test(data.registry || ''))
    throw new Error('地址登记链接无效');
  const registry = await read(data.registry, 'error');
  if (registry?.v !== 3 || !Array.isArray(registry.computers)) throw new Error('地址登记内容无效');
  return registry;
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
function findPublishedEntry(reg, id) {
  return (reg.computers || []).find(entry => entry.id === id);
}
async function readPublishedEntry(entries, read) {
  for (const entry of entries) {
    try { return { entry, value: await read(entry) }; } catch {}
  }
  return null;
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
  const entry = findPublishedEntry(data, id);
  if (!entry) {
    const found = await readPublishedEntry(data.computers, async c => {
      const url = await decryptEntry(comp.key, c);
      if (current()) updateComputerRecord({ ...comp, id: c.id, name: c.name || comp.name || '电脑' });
      return url;
    });
    if (found) return found.value;
    throw offline('这台电脑还没有发布地址，请在那台电脑上重启服务');
  }
  if (current() && (!comp.id || (entry.name && entry.name !== comp.name))) updateComputerRecord({ ...comp, id: entry.id, name: entry.name || comp.name || '电脑' });
  try { return await decryptEntry(comp.key, entry); }
  catch { throw offline('这台电脑的地址对不上当前发布的记录，配对还在，可以换一台或稍后重试'); }
}

async function api(path, opts = {}) {
  const { timeout = 10000, computer: owner, ...request } = opts;
  const target = owner ? owner.relay : base;
  const computer = owner || (pending ? loadComputers().find(c => pending.key ? c.key === pending.key : c.id === pending.id) : currentComputer());
  const headers = { 'content-type': 'application/json', ...await entryHeaders(computer, request.method || 'GET', path, request.body), ...opts.headers };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    return await fetch(target + path, { ...request, headers, signal: ctl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}
const post = (path, body, opts = {}) => api(path, { ...opts, method: 'POST', body: JSON.stringify(body || {}) });

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
    const known = loadComputers().find(c => c.id === manual[1] && c.relay);
    const request = pending = { id: manual[1], code: manual[2], discovery: known ? known.relay.replace(/\/$/, '') + '/url.json' : new URL('url.json', location.href).href };
    sessionStorage.removeItem('entry-request');
    bootGeneration++; connGen++;
    authed = false;
    const old = ws;
    ws = null;
    clearComputerRetry(currentComputer());
    try { old?.close(); } catch {}
    gate({ pairStatus: { state: 'loading', title: '正在配对…' } });
    try {
      const discovery = request.discovery;
      const registry = await fetchDiscovery(discovery, AbortSignal.timeout(10000)).catch(error => {
        if (!error.status) throw error;
        throw new Error(known ? '中继地址记录读取失败' : '入口地址记录读取失败，请改用电脑上的二维码或配对链接');
      });
      if (pending !== request) return;
      if (registry.self) {
        base = new URL(discovery).origin;
        const me = await fetch(base + '/api/me').then(r => r.json());
        if (pending !== request) return;
        if (me.id !== manual[1]) throw Error('配对码对应的电脑与当前入口不一致');
        return boot();
      }
      const entry = registry.computers?.find(c => c.id === manual[1]);
      if (!entry?.pairing || entry.pairing.expires <= Date.now()) throw Error('入口地址记录尚未更新或配对码已过期，请改用电脑上的二维码或配对链接');
      const rawKey = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(manual[2]));
      const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(entry.pairing.iv) }, key, b64(entry.pairing.data));
      if (pending !== request) return;
      const decoded = JSON.parse(new TextDecoder().decode(plain));
      if (decoded.id !== manual[1]) throw Error('配对码对应的电脑不一致');
      Object.assign(request, { key: decoded.key, stay: true });
      return boot();
    } catch (e) {
      if (pending !== request) return;
      pending = null;
      return showUnpaired(e.name === 'OperationError' ? '配对码与入口地址记录不匹配，请改用电脑上的二维码或配对链接'
        : e instanceof TypeError || e.name === 'TimeoutError' ? known
          ? '无法连接这台电脑的中继，请检查电脑服务和隧道，或使用电脑上的新配对链接'
          : '无法读取入口地址记录，请改用电脑上的二维码或配对链接'
        : e.message);
    }
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
    const data = await fetchDiscovery(url, ctl.signal);
    const valid = relay ? data?.self === true : data?.self === true || (data?.v === 3 && Array.isArray(data.computers)) || (data?.v === 2 && !!data.data);
    return { ok: valid, ms: Math.round(performance.now() - start), code: valid ? '' : 'invalid', detail: valid ? `正常 · ${Math.round(performance.now() - start)} ms` : '返回内容不符合预期' };
  } catch (error) {
    if (error.status) return { ok: false, code: 'http', http: error.message, detail: error.message };
    return { ok: false, timedOut: ctl.signal.aborted, timeout: timeout / 1000, code: ctl.signal.aborted ? 'timeout' : error instanceof SyntaxError ? 'json' : 'network', detail: ctl.signal.aborted ? `请求超时（${timeout / 1000} 秒）` : error instanceof SyntaxError ? '返回内容不是 JSON' : '请求失败（网络、DNS、证书或跨域原因未确定）' };
  } finally { clearTimeout(timer); }
}
async function diagnoseConnection(computer, state) {
  const page = computer.discovery || discoveryUrl();
  const relay = computer.relay ? computer.relay.replace(/\/$/, '') + '/url.json' : '';
  const online = navigator.onLine !== false;
  state.checks = [
    { key: 'net', label: '手机网络', st: online ? 'ok' : 'err', code: online ? '' : 'offline' },
    { key: 'page', label: '页面地址发布', url: page, st: 'load' },
    { key: 'relay', label: '隧道和电脑服务', url: relay, st: relay ? 'load' : 'err', code: relay ? '' : 'nourl', detail: relay ? '' : '尚未获取隧道地址' },
  ];
  state.diagRunning = true;
  const draw = () => {
    if (sheetKind === 'connection-details' && connectionDetailsComputer === computer.id) showConnectionDetails(computer.id);
  };
  draw();
  const run = async (check, relayCheck) => {
    if (!check.url) return { ok: false, code: 'nourl', detail: '尚未获取隧道地址' };
    let result = await testEndpoint(check.url, relayCheck);
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
  const results = await Promise.all([run(state.checks[1], false), run(state.checks[2], true)]);
  state.diagRunning = false;
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
async function checkComputerConnection(id) {
  const e = ovList.find(e => e.id === id), computer = e?.c;
  if (!computer) return;
  const state = ovStOf(id);
  return state.diagnostic ||= diagnoseConnection({ ...computer, id }, state).then(conclusion => { state.conclusion = conclusion; }).finally(() => {
    state.diagnostic = null;
    if (sheetKind === 'connection-details' && connectionDetailsComputer === id) showConnectionDetails(id);
  });
}
async function showOffline(failure = { stage: '应用连接', error: '' }, failed = true) {
  clearComputerRetry(currentComputer());
  ungate();
  conn.host = 'err';
  const computer = currentComputer();
  if (!computer) return;
  const id = computer.id || await computerIdFromKey(computer.key), link = computerConnection({ ...computer, id });
  if (!link.rejected) link.phase = 'offline';
  link.failure = failure;
  ovRender();
  autoRetry({ ...computer, id }, failed);
  if (computerRetryAllowed(computer)) return checkComputerConnection(id);
}
function authorizeComputer(id) {
  const index = loadComputers().findIndex(c => c.id === id);
  if (index < 0) return;
  requestedComputerAuth = loadComputers()[index].key;
  return useComputer(index);
}
function reconnectComputer(id, source = 'manual') {
  if (pending) return;
  const entry = ovList.find(e => e.id === id);
  if (!entry?.c || navigator.onLine === false) return;
  const computer = loadComputers().find(c => c.key === entry.c.key);
  const link = computerConnection(computer);
  if (link.attempt) return link.attempt;
  if (source !== 'manual' && !computerRetryAllowed(computer, source === 'resume')) return;
  recordComputerConnection(link, 'reconnect', { source });
  if (source === 'manual') {
    link.retryFailures = 0; link.retryProbe = false;
  } else if (link.phase === 'paused') {
    link.retryProbe = true;
  }
  if (link.phase === 'paused') link.phase = 'offline';
  link.failure = null;
  clearComputerRetry(computer);
  link.attempt = Promise.resolve().then(async () => {
    ovFetch(entry);
    await warmComputerSocket(computer);
  }).catch(error => {
    link.phase = 'offline'; link.failure = { stage: '电脑连接', error: error.message };
  }).finally(() => {
    link.attempt = null;
    if (linkForComputerKey(computer.key) === link && link.phase === 'offline') autoRetry(computer, !link.auth?.ok, !!link.auth?.ok);
    ovRender();
  });
  ovRender();
  return link.attempt;
}

async function pair(totp) {
  const request = pending, computer = { ...loadComputers().find(c => request.key ? c.key === request.key : c.id === request.id), relay: request.relay };
  gate({ pairStatus: { state: 'loading', title: '正在配对…' } });
  let r, body;
  try {
    const { publicKey } = await entryKey();
    if (pending !== request) return;
    r = await post('/api/pair', { code: request.code, name: entryName(), publicKey, totp }, { computer });
    body = await r.json().catch(() => ({}));
  } catch (error) {
    if (pending !== request) return;
    return showUnpaired(error.message);
  }
  if (pending !== request) return;
  if (r.ok) {
    if (body.pending) {
      Object.assign(request, { key: body.key, requestId: body.id, secret: body.secret, code: body.code, expires: body.expires, desktop: true });
      sessionStorage.setItem('entry-request', JSON.stringify(request));
      return joinEntryRequest();
    }
    return finishPair(body, request);
  }
  if (body.needTotp) return showTotp(code => pair(code), body.error);
  pending = null;
  if (store.get('token')) return gate({ msg: body.error || '配对失败', err: true, retry: '继续使用', pairStatus: { state: 'paired', title: '此入口已有配对记录', note: '这台设备之前已经配对过，可以继续使用。' } });
  showUnpaired(body.error || '配对失败');
}

async function finishPair(body, request = pending) {
  const key = body.key || request.key;
  const id = body.id || await computerIdFromKey(key);
  if (pending !== request) return;
  const prev = loadComputers().find(c => c.key === key);
  const list = loadComputers().filter(c => c.key !== key);
  list.push({ ...prev, id, name: body.name || prev?.name || '电脑', key, token: body.token, device: body.device || prev?.device || '', win: prev?.win || '', discovery: request.discovery || discoveryUrl(), relay: request.relay });
  saveComputers(list, key);
  base = request.relay;
  pending = null;
  entryComputer = '';
  sessionStorage.removeItem('entry-request');
  return connect();
}

let entryJoinGeneration = 0;
async function joinEntryRequest() {
  const generation = ++entryJoinGeneration, request = pending;
  const computer = { ...loadComputers().find(c => request.key ? c.key === request.key : c.id === request.id), relay: request.relay };
  let terminal = false;
  const cancel = () => {
    if (generation !== entryJoinGeneration || pending !== request) return;
    post('/api/entries/cancel', { id: request.requestId, secret: request.secret }, { computer }).catch(() => {});
    entryJoinGeneration++; pending = null; sessionStorage.removeItem('entry-request');
    showUnpaired('已取消入口授权');
  };
  try {
    if (!request.requestId) {
      gate({ pairStatus: { state: 'loading', title: '正在申请入口授权…' } });
      const { publicKey } = await entryKey();
      if (generation !== entryJoinGeneration || pending !== request) return;
      const r = await post('/api/entries/join', { invitation: request.invitation, name: entryName(), publicKey }, { computer });
      const body = await r.json();
      if (generation !== entryJoinGeneration || pending !== request) return;
      if (!r.ok) { terminal = true; throw new Error(body.error || '申请失败'); }
      Object.assign(request, { requestId: body.id, secret: body.secret, code: body.code, expires: body.expires });
      delete request.invitation;
      sessionStorage.setItem('entry-request', JSON.stringify(request));
    }
    gate({ msg: request.desktop ? '请在电脑配对窗口核对验证码，然后点击「允许连接」。' : '请在已配对入口的「已配对设备」中核对验证码并同意。', pairStatus: { state: 'waiting', title: request.desktop ? '等待电脑批准' : '等待入口批准', detail: '请核对两端的验证码', code: request.code }, retry: '取消申请', onRetry: cancel });
    while (generation === entryJoinGeneration && pending === request) {
      const r = await post('/api/entries/status', { id: request.requestId, secret: request.secret }, { computer });
      const body = await r.json();
      if (generation !== entryJoinGeneration || pending !== request) return;
      if (!r.ok) { terminal = true; throw new Error(body.error || '授权查询失败'); }
      if (body.state === 'approved') return finishPair(body, request);
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

function cancelConnectionWork() {
  markUploadsDisconnected();
  disconnectPendingSends();
  failFileRead('连接已断开，文件读取已中断，请重试');
  waitFileSave();
  cancelChatContentRequests();
  interruptSessionBatch();
  cancelCodexAutoRetry();
}

let requestedComputerAuth = '';
async function boot() {
  const generation = ++bootGeneration;
  connGen++;
  const old = ws;
  if (authed) cancelConnectionWork();
  ws = null;
  parkComputerSocket(old);
  authed = false;
  clearComputerRetry(currentComputer());
  if (pending && !pending.requestId) sessionStorage.removeItem('entry-request');
  if (pending?.requestId) { base = pending.relay; return joinEntryRequest(); }
  // Android browser opened a pairing link: offer to hand it to the installed app instead.
  if (pending?.code && !pending.requestId && /Android/.test(navigator.userAgent) && !inApp && !pending.stay) {
    const link = `agentremote://pair?app=${encodeURIComponent(location.origin + location.pathname)}&d=${pending.key}.${pending.code}`;
    gate({ msg: '已收到配对链接。\n装了安卓 App 就在 App 里打开；否则直接在浏览器里用。', appLink: link, retry: '在浏览器里继续' });
    pending.stay = true;
    return;
  }
  if (pending || !loadComputers().length) gate({ msg: '正在查找电脑…' });
  else { ungate(); resetComputerConnection(); ovRender(); }
  if (pending?.key) {
    const saved = loadComputers().find(c => c.key === pending.key);
    if (saved) saveComputers(loadComputers(), saved.key);
  }
  const chosen = currentComputer();
  if (!pending && chosen && (navigator.onLine === false || linkForComputerKey(chosen.key)?.phase === 'paused')) return ovRender();
  const current = () => generation === bootGeneration && currentComputer()?.key === chosen?.key;
  const discovery = fetchDiscovery(discoveryUrl(), AbortSignal.timeout(10000));
  warmComputerSockets().catch(() => {});
  // An existing paired address can authenticate while the published directory refreshes.
  if (!pending && chosen?.relay && (!entryComputer || entryComputer === chosen.id)) {
    base = chosen.relay;
    discovery.then(async data => {
      const relay = await resolveBase(data, chosen, current);
      if (!current()) return;
      info = data;
      rememberComputer({ ...currentComputer(), relay });
      if (!authed && ws?.readyState === 3 && base !== relay && computerRetryAllowed(currentComputer())) { base = relay; connect(); }
    }).catch(() => {});
    if (chosen.win) store.set('window', chosen.win);
    await chatPreviewReady;
    if (current()) return connect();
    return;
  }
  try {
    const data = await discovery;
    if (!current()) return;
    info = data;
  } catch (error) {
    if (!current()) return;
    if (pending) return showUnpaired(error.message);
    base = currentComputer()?.relay || '';
    return showOffline({ stage: '页面地址读取', error: error.message });
  }
  if (pending) {
    try { const relay = await resolvePending(); if (!current()) return; base = pending.relay = relay; }
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
  if (!currentComputer()) return loadComputers().length ? ovRender() : showUnpaired();
  rememberComputer({ ...currentComputer(), relay: base });
  if (chosen?.win) store.set('window', chosen.win);
  await chatPreviewReady;
  if (current()) return connect();
}

async function resolvePending() {
  if (info.self) return new URL(discoveryUrl()).origin;
  if (info.v === 2 && info.data) return decryptEntry(pending.key, info);
  if (info.v !== 3 || !Array.isArray(info.computers)) throw new Error('电脑端还没有发布地址，请在那台电脑上重启服务');
  const id = await computerIdFromKey(pending.key);
  let entry = findPublishedEntry(info, id);
  if (!entry) {
    entry = (await readPublishedEntry(info.computers, c => decryptEntry(pending.key, c)))?.entry;
  }
  if (!entry) throw new Error('这台电脑还没有发布地址，请在那台电脑上重启服务');
  return decryptEntry(pending.key, entry);
}
