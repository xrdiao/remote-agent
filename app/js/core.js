const $ = id => document.getElementById(id);
const PRIMARY = /^(run|allow|accept|approve|keep|continue|build|yes|retry|运行|允许|接受|继续|重试)/i;
const store = {
  get: k => localStorage.getItem('cr-' + k),
  set: (k, v) => v == null ? localStorage.removeItem('cr-' + k) : localStorage.setItem('cr-' + k, v),
};
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const themeName = () => ({ dark: '深色', light: '浅色', auto: '跟随系统' })[store.get('theme') || 'dark'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const APP_VERSION = 'v456'; // keep in sync with the CACHE name in sw.js

let base = null, info = null, ws = null, authed = false;
let windowReady = false;
let menuRequest = 0;
let codexSettingsRequest = 0;
let mode = store.get('mode') || 'chat';
document.body.classList.toggle('chatmode', mode === 'chat');
let crop = store.get('crop') !== 'full';
let frame = { w: 1000, h: 800 }, panel = null, zoom = 1;
let windows = [], currentWindow = null, appPlans = {};
let currentApp = null;
let docsRequest = 0, docsPending = null;
const agentLists = new Map();
try {
  for (const [k, v] of Object.entries(JSON.parse(store.get('agentLists') || '{}') || {})) if (Array.isArray(v)) agentLists.set(k, v);
} catch {}
let agentListsTimer = 0;
const saveAgentLists = () => {
  clearTimeout(agentListsTimer);
  agentListsTimer = setTimeout(() => {
    try {
      const obj = {};
      for (const k of [...agentLists.keys()].slice(-12)) obj[k] = (agentLists.get(k) || []).slice(0, 300);
      store.set('agentLists', JSON.stringify(obj));
    } catch {}
  }, 500);
};
const setAgentList = (key, list) => { agentLists.delete(key); agentLists.set(key, list); saveAgentLists(); };
const agentListKey = () => (currentComputer()?.key || '') + ':' + currentApp + (currentApp === 'cursor' ? ':' + (currentComputer()?.windowId || currentWindow || '') : '');
function receiveAgents(m) {
  if (m.app && m.app !== currentApp) return;
  if (m.sel && m.sel !== viewSel) return;
  if (m.error) {
    finishPending(['正在读取 Agent 列表…']);
    if (sheetKind === 'agents') {
      openSheet('agents', `<h3>项目与会话</h3><p class="hint err">${esc(m.error)}</p><button class="opt" id="retryAgentList"><span class="lbl">${I18N.tr(selectionReady ? '重试' : '重试当前会话')}</span></button>`);
      $('retryAgentList').onclick = () => {
        if (selectionReady) openAgentList(true);
        else { closeSheet(); connRetryCurrent(); }
      };
    }
    return;
  }
  const key = agentListKey();
  const previous = agentLists.get(key) || [];
  const previousById = new Map(previous.map(a => [a.id, a]));
  let list = (m.list || []).filter(a => agentSessionAvailable(a));
  list = list.map(a => {
    const old = previousById.get(a.id);
    const running = old && !Object.hasOwn(a, 'running') && Object.hasOwn(old, 'running') ? { running: old.running } : {};
    return { ...a, ...running, title: a.title || old?.title || '未命名会话' };
  });
  if (m.partial) {
    const remaining = (agentLists.get(key) || []).filter(a => a.picker && agentSessionAvailable(a));
    list = [...list, ...remaining.filter(a => !list.some(b => agentThreadKey(b) === agentThreadKey(a)))];
  }
  const changed = JSON.stringify(agentLists.get(key)) !== JSON.stringify(list);
  if (changed) setAgentList(key, list);
  if (!m.silent) finishPending(['正在读取 Agent 列表…', '正在归档…']);
  if (sheetKind === 'agents' && changed) showAgents(list);
}
function requestAgentCatalog() {
  if (mode !== 'terminal' && authed && windowReady && !navigationPending && ['cursor', 'devin', 'codex', 'opencode'].includes(currentApp))
    return send({ t: 'agents', automatic: true, silent: true });
}
function openAgentList(refresh = false, entry = null) {
  if (entry || sheetKind !== 'agents') projectEntry = entry || { computer: currentComputer().id, source: 'conversation' };
  const cached = agentLists.get(agentListKey());
  if (cached) showAgents(cached);
  else { openSheet('agents', '<h3>项目与会话</h3><p class="hint">正在读取 Agent 列表…</p>'); status('正在读取 Agent 列表…'); }
  if (cached && !refresh) requestAgentCatalog();
  else send({ t: 'agents', checkTrust: true });
}
let currentAppName = I18N.tr('当前应用');
let viewSel = '';
// Only migrated agents declare capabilities; others retain their existing entry rules.
let capabilityOwner = '', agentCapabilities = null, capabilityBlock = '';
function supportsCapability(name, existing = true) {
  return capabilityOwner === currentApp && agentCapabilities ? agentCapabilities[name] === true : existing;
}
function capabilityState(name) {
  const supported = supportsCapability(name);
  if (capabilityOwner !== currentApp || !agentCapabilities) return { supported, available: supported, reason: '' };
  let reason = !supported ? '此 Agent 不支持此功能' : !authed || !windowReady ? '尚未连接 Agent' : capabilityBlock;
  if (!reason && ['model', 'effort', 'fileReferences'].includes(name) && !chatStale && lastChat?.readonly) reason = '当前对话尚不可操作';
  const effort = name === 'effort' && menuCache.get(menuCacheKey('effort'));
  if (!reason && effort && effort.model === lastChat?.model && !effort.items?.length) reason = '当前模型没有可选的思考强度';
  return { supported, available: supported && !reason, reason };
}

const appMessage = template => I18N.tr(template).replaceAll('{app}', currentAppName);
function updateAppText() {
  $('emptyHint').textContent = appMessage('请在 {app} 里打开 Agent 对话，或切到「画面」查看。');
  text.placeholder = mode === 'terminal' ? I18N.tr('发给终端…') : questionCompose?.sel === viewSel ? '回答当前问题…（仅提交文字）' : I18N.tr('输入你的问题，或粘贴图片、文档…');
}

// Temporary, opt-in viewport diagnostics. Never read input or pairing data.
let viewportTrace = null;
const VIEWPORT_TRACE_LIMIT = 400;
function viewportTraceRect(element) {
  if (!element) return null;
  const { top, left, right, bottom, width, height } = element.getBoundingClientRect();
  return { top, left, right, bottom, width, height };
}
function viewportTraceNode(element) {
  if (!element) return null;
  const style = getComputedStyle(element);
  return { ...viewportTraceRect(element), css: Object.fromEntries([
    'position', 'display', 'height', 'min-height', 'max-height', 'overflow', 'overflow-x', 'overflow-y',
    'padding-top', 'padding-bottom', 'padding-left', 'padding-right', 'margin-top', 'margin-bottom',
    'background-color', 'opacity', 'visibility', 'transform', 'transform-origin', 'filter', 'backdrop-filter',
    '-webkit-backdrop-filter', 'contain', 'will-change', 'z-index', 'view-transition-name',
  ].map(key => [key, style.getPropertyValue(key)])) };
}
function viewportTraceAsset(raw) {
  const base = new URL('./', document.baseURI), url = new URL(raw, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return null;
  const file = url.pathname.slice(base.pathname.length);
  if (!/^(?:index\.html|app\.css|i18n\.js|sw\.js|manifest\.webmanifest|js\/[\w-]+\.js|vendor\/xterm\.css)$/.test(file)) return null;
  const version = url.searchParams.get('v');
  return file + (version && /^v?\d+(?:\.\d+)*$/.test(version) ? '?v=' + version : '');
}
async function viewportTraceHash(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
}
async function viewportTraceResources() {
  const assets = [...document.querySelectorAll('script[src], link[rel="stylesheet"]')]
    .map(node => viewportTraceAsset(node.src || node.href)).filter(Boolean);
  const timings = performance.getEntriesByType('resource').map(entry => ({
    file: viewportTraceAsset(entry.name), type: entry.initiatorType, start: entry.startTime, duration: entry.duration,
    transfer: entry.transferSize, encoded: entry.encodedBodySize, decoded: entry.decodedBodySize,
  })).filter(entry => entry.file);
  const styles = await Promise.all([...document.styleSheets].filter(sheet => viewportTraceAsset(sheet.href || '')?.startsWith('app.css'))
    .map(async sheet => ({ file: viewportTraceAsset(sheet.href), source: 'loaded-cssom', disabled: sheet.disabled,
      sha256: await viewportTraceHash(new TextEncoder().encode([...sheet.cssRules].map(rule => rule.cssText).join('\n'))) })));
  const resources = { state: 'complete', executedCore: APP_VERSION, assets, timings, styles, caches: [] };
  if (!navigator.serviceWorker) return resources;
  const registration = await navigator.serviceWorker.getRegistration();
  const worker = value => value ? { file: viewportTraceAsset(value.scriptURL), state: value.state } : null;
  resources.worker = { controller: worker(navigator.serviceWorker.controller), active: worker(registration?.active),
    waiting: worker(registration?.waiting), installing: worker(registration?.installing) };
  if (!registration) return resources;
  const prefix = 'remote-agent:' + registration.scope + ':';
  const names = (await caches.keys()).filter(name => name.startsWith(prefix) && /^v\d+$/.test(name.slice(prefix.length)));
  const selected = ['index.html', ...assets.filter(file => /^(?:app\.css|i18n\.js|js\/(?:core|sheets|overview|composer)\.js)(?:\?|$)/.test(file))];
  for (const name of names) {
    const entries = [];
    for (const file of selected) {
      const response = await caches.match(new URL(file, document.baseURI).href, { cacheName: name });
      if (response) {
        const bytes = await response.arrayBuffer();
        entries.push({ file, status: response.status, bytes: bytes.byteLength, sha256: await viewportTraceHash(bytes) });
      }
    }
    resources.caches.push({ version: name.slice(prefix.length), source: 'cache-entry-not-proof-of-loaded-bytes', entries });
  }
  return resources;
}
function readViewportTraceResources(trace) {
  const ms = Math.round(performance.now() - trace.at);
  viewportTraceResources().then(resources => { trace.resources.push({ ms, ...resources }); }, error => {
    trace.resources.push({ ms, state: 'error', name: error.name });
  });
}
function viewportTraceEvent(event) {
  const scope = event.currentTarget === window ? 'window' : event.currentTarget === window.visualViewport ? 'visualViewport'
    : event.currentTarget === navigator.serviceWorker ? 'serviceWorker' : 'document';
  recordViewportTrace(scope + ':' + event.type);
  if (event.type === 'controllerchange' && viewportTrace?.active) readViewportTraceResources(viewportTrace);
}
function stopViewportTrace(reason = 'stopped') {
  const trace = viewportTrace;
  if (!trace?.active) return;
  trace.active = false;
  trace.reason = reason;
  cancelAnimationFrame(trace.frame);
  trace.frame = 0;
  for (const [target, event] of trace.listeners) target.removeEventListener(event, viewportTraceEvent);
  if (trace.loaded) document.removeEventListener('DOMContentLoaded', trace.loaded);
  trace.observer.disconnect();
  trace.probe.remove();
}
function startViewportTrace() {
  stopViewportTrace('restarted');
  const trace = viewportTrace = { active: true, reason: '', at: performance.now(), frame: 0, samples: [], resources: [],
    environment: { userAgent: navigator.userAgent, standalone: navigator.standalone === true,
      displayMode: ['standalone', 'fullscreen', 'minimal-ui', 'browser'].find(value => matchMedia('(display-mode: ' + value + ')').matches),
      pixelRatio: window.devicePixelRatio, screen: { width: window.screen.width, height: window.screen.height,
        availWidth: window.screen.availWidth, availHeight: window.screen.availHeight, orientation: window.screen.orientation?.type },
      viewportMeta: document.querySelector('meta[name="viewport"]')?.content,
      statusMeta: document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.content || null } };
  const before = { body: viewportTraceRect(document.body), scrollHeight: document.documentElement.scrollHeight, scrollY: window.scrollY };
  trace.probe = document.createElement('div');
  trace.probe.setAttribute('aria-hidden', 'true');
  trace.probe.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none';
  trace.measures = {};
  for (const unit of ['vh', 'dvh', 'svh', 'lvh', 'safe']) {
    const child = document.createElement('div');
    child.style.cssText = 'position:absolute;top:0;left:0;width:0;height:' + (unit === 'safe' ? '0' : '100' + unit)
      + ';padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    trace.probe.append(child);
    trace.measures[unit] = child;
  }
  document.body.append(trace.probe);
  trace.measurement = { before, after: { body: viewportTraceRect(document.body), scrollHeight: document.documentElement.scrollHeight, scrollY: window.scrollY } };
  trace.listeners = [...['pageshow', 'pagehide', 'resize', 'scroll', 'orientationchange', 'focus', 'blur', 'popstate'].map(event => [window, event]),
    ...['focusin', 'focusout', 'visibilitychange'].map(event => [document, event]),
    ...(window.visualViewport ? ['resize', 'scroll'].map(event => [window.visualViewport, event]) : []),
    ...(navigator.serviceWorker ? [[navigator.serviceWorker, 'controllerchange']] : [])];
  for (const [target, event] of trace.listeners) target.addEventListener(event, viewportTraceEvent);
  trace.observer = new MutationObserver(records => {
    if (viewportTrace !== trace || !trace.active) return;
    recordViewportTrace('mutation:' + [...new Set(records.map(record => (record.target === document.body ? 'body' : record.target === document.documentElement ? 'html' : record.target.id) + ':' + record.attributeName))].join(','));
  });
  for (const target of [document.documentElement, document.body, $('overview'), $('gate'), $('shade'), $('sheet'), $('viewer'), $('transfer')].filter(Boolean))
    trace.observer.observe(target, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'data-theme'] });
  if (document.readyState === 'loading') {
    trace.loaded = () => { trace.loaded = null; readViewportTraceResources(trace); };
    document.addEventListener('DOMContentLoaded', trace.loaded, { once: true });
  } else readViewportTraceResources(trace);
  recordViewportTrace('start');
}
function recordViewportTrace(source, decision) {
  const trace = viewportTrace;
  if (!trace?.active) return;
  const body = document.body, active = document.activeElement, vv = window.visualViewport;
  const focus = active === $('text') ? 'composer' : active?.matches('[data-ov-input]') ? 'card-composer'
    : active?.closest('#qnBar') ? 'question' : active === $('termText') ? 'terminal'
      : /^(INPUT|TEXTAREA)$/.test(active?.tagName) ? 'other-input' : active?.isContentEditable ? 'contenteditable' : 'none';
  const page = $('viewer')?.classList.contains('open') ? 'file' : $('transfer')?.hidden === false ? 'transfer'
    : body.classList.contains('conv') ? mode : 'overview';
  const sample = { ms: Math.round(performance.now() - trace.at), source, page, focus, decision,
    keyboard: body.classList.contains('kb'), classes: [...body.classList].filter(value => /^(?:conv|kb|land|wide|split|railCollapsed|chatmode|composeCompact|composeIdle|visual|fusion|metersText)$/.test(value)),
    innerHeight: window.innerHeight, innerWidth: window.innerWidth, scrollY: window.scrollY,
    clientHeight: document.documentElement.clientHeight, clientWidth: document.documentElement.clientWidth,
    rootScroll: document.scrollingElement?.scrollTop, visibility: document.visibilityState,
    visual: vv ? { height: vv.height, width: vv.width, offsetTop: vv.offsetTop, offsetLeft: vv.offsetLeft, pageTop: vv.pageTop, scale: vv.scale } : null,
    height: body.style.height, transform: body.style.transform,
    theme: document.documentElement.dataset.theme, themeColor: document.querySelector('meta[name="theme-color"]')?.content,
    history: { conversation: !!history.state?.ovConv, depth: history.state?.ovDepth },
    overlays: { sheet: !!$('sheet')?.classList.contains('open'), shade: !!$('shade')?.classList.contains('open'), image: !!$('imageEditor')?.open,
      gate: $('gate') ? getComputedStyle($('gate')).display !== 'none' : false } };
  if (source === 'frame') {
    sample.html = viewportTraceNode(document.documentElement);
    sample.root = viewportTraceNode(body);
    sample.overview = viewportTraceNode($('overview'));
    sample.header = viewportTraceNode(page === 'overview' ? document.querySelector('#overview .ov-top') : document.querySelector('body > header'));
    sample.footer = viewportTraceNode(page === 'overview' ? $('ovLevels') : document.querySelector('footer'));
    sample.chatHeader = viewportTraceNode(document.querySelector('body > header'));
    sample.input = viewportTraceRect(focus !== 'none' ? active : mode === 'terminal' ? $('termText') : $('text'));
    sample.units = Object.fromEntries(['vh', 'dvh', 'svh', 'lvh'].map(unit => [unit, getComputedStyle(trace.measures[unit]).height]));
    const safe = getComputedStyle(trace.measures.safe);
    sample.safeArea = { top: safe.paddingTop, right: safe.paddingRight, bottom: safe.paddingBottom, left: safe.paddingLeft };
    sample.topEdge = [0, Math.max(1, parseFloat(safe.paddingTop) || 1), Math.max(1, (sample.header?.top || 0) + 1)].map(y => ({ y,
      elements: document.elementsFromPoint(window.innerWidth / 2, y).slice(0, 5).map(element => {
        const style = getComputedStyle(element);
        return { tag: element.tagName, owner: element.closest('#overview') ? 'overview' : element.closest('#sheet') ? 'sheet'
          : element.closest('#gate') ? 'gate' : element.closest('body > header') ? 'chat-header' : element === body ? 'body' : 'other',
          position: style.position, background: style.backgroundColor, opacity: style.opacity, transform: style.transform };
      }) }));
  }
  trace.samples.push(sample);
  if (trace.samples.length === VIEWPORT_TRACE_LIMIT) stopViewportTrace('full');
  else if (source !== 'frame' && !trace.frame) trace.frame = requestAnimationFrame(() => {
    trace.frame = 0;
    if (viewportTrace === trace && trace.active) recordViewportTrace('frame');
  });
}
function viewportTraceText() {
  const trace = viewportTrace;
  return JSON.stringify({ version: APP_VERSION, state: trace?.active ? 'recording' : trace?.reason || 'not-started',
    limit: VIEWPORT_TRACE_LIMIT, environment: trace?.environment, measurement: trace?.measurement, resources: trace?.resources, samples: trace?.samples || [] }, null, 2);
}
function resumeViewportTrace() {
  if (store.get('viewport-trace-next') !== '1') return;
  store.set('viewport-trace-next', null);
  startViewportTrace();
}

// Track keyboard state for composer controls without resizing or translating the shell.
function fitViewport(event) {
  const source = event ? (event.currentTarget === window.visualViewport ? 'visualViewport:' : 'window:') + event.type : 'fitViewport';
  recordViewportTrace('before:' + source);
  const vv = window.visualViewport;
  if (!vv) return;
  const focused = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  const keyboard = !!focused && (vv.offsetTop > 0 || vv.height < window.innerHeight - 80);
  const wasKeyboard = document.body.classList.contains('kb');
  if (wasKeyboard !== keyboard) document.body.classList.toggle('kb', keyboard);
  if (keyboard) {
    const input = $('text');
    const overflow = Math.max(0, input.closest('footer').getBoundingClientRect().bottom - vv.height - Math.max(0, vv.offsetTop));
    const available = input.offsetHeight + $('listWrap').clientHeight - 72 - overflow;
    const maxHeight = Math.max(52, Math.floor(Math.min(vv.height * .28, available))) + 'px';
    if (document.body.style.getPropertyValue('--composer-max-height') !== maxHeight) {
      document.body.style.setProperty('--composer-max-height', maxHeight);
    }
    const room = input.closest('footer').getBoundingClientRect().top - document.querySelector('header').getBoundingClientRect().bottom
      - $('sessBar').offsetHeight - $('actionBar').offsetHeight - 16;
    document.body.style.setProperty('--question-max-height', Math.max(0, Math.floor(room)) + 'px');
  } else {
    document.body.style.removeProperty('--composer-max-height');
    document.body.style.removeProperty('--question-max-height');
  }
  if (wasKeyboard && !keyboard && typeof endComposerEditing === 'function') endComposerEditing();
  if (typeof noteChatLayoutChange === 'function') noteChatLayoutChange();
  recordViewportTrace(source, keyboard);
}
window.addEventListener('resize', fitViewport);
window.addEventListener('pageshow', fitViewport);
document.addEventListener('focusout', () => { fitViewport(); setTimeout(fitViewport, 350); });
window.visualViewport?.addEventListener('resize', fitViewport);
window.visualViewport?.addEventListener('scroll', fitViewport);
resumeViewportTrace();
fitViewport();

// window.screen explicitly: a top-level const named screen (the screen view) is declared further down.
function fitOrientation() {
  const t = window.screen.orientation?.type;
  document.body.classList.toggle('land', t ? t.startsWith('landscape') : window.screen.width > window.screen.height);
  // Screen size, not viewport: an open keyboard must never flip the layout.
  document.body.classList.toggle('wide', Math.min(window.screen.width, window.screen.height) >= 520);
  // .split = the rail layout. Width-based (not orientation): keyboards shrink only the
  // height, so near-square foldables and portrait tablets get the rail too.
  document.body.classList.toggle('split',
    document.body.classList.contains('wide') && window.innerWidth >= 768
    && !document.body.classList.contains('visual'));
  fitRail();
}
// Rail width: stored preference wins; otherwise auto-collapse under 1100px.
function fitRail() {
  const v = store.get('rail');
  document.body.classList.toggle('railCollapsed', v ? v === 'collapsed' : window.innerWidth < 1100);
}
window.screen.orientation?.addEventListener('change', fitOrientation);
window.addEventListener('orientationchange', fitOrientation);
window.addEventListener('resize', fitOrientation);
fitOrientation();

const appHeader = document.querySelector('body > header'), headerSlot = $('headerSlot');
function layoutHeader() {
  const rect = headerSlot.getBoundingClientRect();
  appHeader.style.left = rect.left + 'px';
  appHeader.style.width = rect.width + 'px';
  headerSlot.style.marginBottom = appHeader.getBoundingClientRect().height + 'px';
  if (typeof positionFusionPanel === 'function') positionFusionPanel();
}
const headerSizeObserver = new ResizeObserver(layoutHeader);
headerSizeObserver.observe(headerSlot);
headerSizeObserver.observe(appHeader);
layoutHeader();

// In-progress lines end with … and are cleared when the result arrives, or after a few seconds
// so a finished action cannot leave "正在…" on screen. A short result then fades on its own.
const ACTION_PENDING = new Set([
  '正在加载对话…',
  '正在发送…', '正在确认电脑端接收…',
  '正在新建对话…', '正在切换窗口…', '正在切换 Agent…', '正在切换会话…', '正在读取 Agent 列表…', '正在打开子 Agent…', '返回主对话…',
  '正在切换终端…', '正在删除终端…', '正在新建终端…', '正在读取终端列表…',
  '正在打开项目…', '正在读取项目…', '正在读取文件夹…', '正在读取文档…', '正在保存…',
  '正在读取设置…', '正在修改…', '正在读取额度…', '正在读取上下文…', '正在停止…',
  '正在撤销…', '正在保留…', '处理中…', '正在修改排队消息…',
  '切换 MAX Mode…', '读取模型参数…', '设置中…',
  '读取模式列表…', '读取模型列表…', '读取历史对话…',
  '连接已断开，发送结果待确认',
]);
let statusGen = 0;
let statusTimer = 0;
let pendingStatus = '';
function paintComposeStatus(text, ok = true) {
  $('msg').textContent = text || '';
  $('msg').className = text === '已连接' ? 'quiet' : (ok ? '' : 'err');
  document.dispatchEvent(new Event('composer-state'));
}
function status(text, ok = true) {
  const gen = ++statusGen;
  clearTimeout(statusTimer);
  pendingStatus = ok && ACTION_PENDING.has(text) ? text : '';
  paintComposeStatus(text, ok);
  const keep = text === '已连接' || (ok && /…$/.test(text || '') && !pendingStatus);
  if (!text || !ok || keep || pendingStatus) return;
  const wait = 2800;
  statusTimer = setTimeout(() => {
    if (gen !== statusGen) return;
    statusGen++;
    pendingStatus = '';
    paintComposeStatus('');
  }, wait);
}
function finishPending(list) {
  if (list.includes(pendingStatus)) status('');
}

const desktopRequests = new Map();
function desktopAction(obj) {
  return RemoteAgentRules.desktopAction(obj, currentApp, mode);
}
function sendDesktopOperation(obj, computer = currentComputer()?.id || '', socket = ws, pending = {}) {
  obj.operationId ||= crypto.randomUUID();
  desktopRequests.set(obj.operationId, { computer, revision: 0, ...pending });
  socket.send(JSON.stringify(obj));
}
function send(obj, target) {
  if (!['terminals', 'openTerminal', 'closeTerminal', 'newTerminal', 'termWrite', 'termResize', 'termSend', 'termComplete', 'termHistory'].includes(obj.t)) obj.sel ??= viewSel;
  if (['attach', 'openAgent', 'openProject'].includes(obj.t)) beginNavigation(obj, target);
  if (obj.t === 'attach') {
    const name = {cursor: 'Cursor', devin: 'Devin', codex: 'Codex', fusion: 'Fusion', opencode: 'OpenCode'}[String(obj.id || '').split(':')[0]];
    if (name) $('titleText').textContent = name + '…';
  }
  if (obj.t === 'openMenu') {
    obj.requestId = ++menuRequest;
    menuPending = { requestId: obj.requestId, kind: obj.kind, sel: viewSel };
  }
  if (obj.t === 'pickMenu' && (obj.kind === 'model' || obj.kind === 'effort' || obj.kind === 'fast' || currentApp === 'opencode' && obj.kind === 'permission')) {
    clearSwitchWatch();
    obj.requestId = ++menuPickRequest;
    modelSwitchRequest = { requestId: obj.requestId, sel: viewSel };
    status(obj.kind === 'fast' ? '设置中…' : '切换中…');
  }
  if (obj.t === 'docs') {
    obj.requestId = ++docsRequest;
    docsPending = { id: obj.requestId, sel: viewSel, computer: currentComputer()?.id || '' };
  }
  if (currentApp === 'codex' && ['settings', 'codexSetting', 'codexInstructions'].includes(obj.t)) obj.requestId = ++codexSettingsRequest;
  if (ws && ws.readyState === 1 && authed) {
    if (desktopAction(obj)) sendDesktopOperation(obj);
    else ws.send(JSON.stringify(obj));
    return true;
  }
  status('未连接', false);
  return false;
}
function setWindowReady(ready) {
  if (!ready && typeof cancelVoice === 'function') cancelVoice();
  windowReady = ready;
  if (typeof updateVoiceButton === 'function') updateVoiceButton();
  document.dispatchEvent(new Event('composer-state'));
  if (ready) { ovEnterReady(); document.dispatchEvent(new Event('window-ready')); }
}

