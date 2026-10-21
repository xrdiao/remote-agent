const $ = id => document.getElementById(id);
const PRIMARY = /^(run|allow|accept|approve|keep|continue|build|yes|运行|允许|接受|继续)/i;
const store = {
  get: k => localStorage.getItem('cr-' + k),
  set: (k, v) => v == null ? localStorage.removeItem('cr-' + k) : localStorage.setItem('cr-' + k, v),
};
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const themeName = () => ({ dark: '深色', light: '浅色', auto: '跟随系统' })[store.get('theme') || 'dark'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const APP_VERSION = 'v162'; // keep in sync with the CACHE name in sw.js

let base = null, info = null, ws = null, authed = false, failures = 0;
let windowReady = false;
let menuRequest = 0;
let codexSettingsRequest = 0;
let mode = store.get('mode') || 'chat';
document.body.classList.toggle('chatmode', mode === 'chat');
let crop = store.get('crop') !== 'full';
let frame = { w: 1000, h: 800 }, panel = null, zoom = 1;
let windows = [], currentWindow = null, appPlans = {};
let currentApp = null;
let editorBrowsing = false, editorDirectory = null, returnToEditor = null;
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
  const key = agentListKey();
  const previous = agentLists.get(key) || [];
  const titles = new Map(previous.map(a => [a.id, a.title]));
  let list = m.list || [];
  list = list.map(a => ({ ...a, title: a.title || titles.get(a.id) || '未命名会话' }));
  if (m.partial) {
    const remaining = (agentLists.get(key) || []).filter(a => String(a.id).startsWith('pick:'));
    list = [...list, ...remaining.filter(a => !list.some(b => b.title === a.title))];
  }
  const changed = JSON.stringify(agentLists.get(key)) !== JSON.stringify(list);
  if (changed) setAgentList(key, list);
  if (!m.silent) finishPending(['正在读取 Agent 列表…', '正在归档…']);
  if (sheetKind === 'agents' && !changed) return;
  if (!m.silent || (sheetKind === 'agents' && changed)) {
    finishPending(['正在读取 Agent 列表…', '正在归档…']);
    showAgents(list);
  }
}
function openAgentList(refresh = false) {
  const cached = agentLists.get(agentListKey());
  if (cached) showAgents(cached);
  else status('正在读取 Agent 列表…');
  send({ t: 'agents', automatic: !!cached && !refresh, silent: !!cached && !refresh, checkTrust: true });
}
let currentAppName = I18N.tr('当前应用');
let viewSel = '';
const appMessage = template => I18N.tr(template).replaceAll('{app}', currentAppName);
function updateAppText() {
  $('emptyHint').textContent = appMessage('请在 {app} 里打开 Agent 对话，或切到「画面」查看。');
  text.placeholder = mode === 'terminal' ? I18N.tr('发给终端…') : I18N.tr('输入你的问题，或粘贴图片、文档…');
}

// iOS scrolls the page to reveal the focused field, which throws the chat off screen.
// Pin the shell to the visible area above the keyboard instead.
let stickOnKeyboard = false;
let vvApplied = '';
function fitViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const focused = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  const keyboard = !!focused && (vv.offsetTop > 0 || vv.height < window.innerHeight - 80);
  const key = `${keyboard}:${Math.round(vv.height)}:${Math.round(vv.offsetTop)}`;
  if (key !== vvApplied) {
    vvApplied = key;
    document.body.style.height = keyboard ? Math.round(vv.height) + 'px' : '';
    document.body.style.transform = keyboard ? `translateY(${Math.max(0, Math.round(vv.offsetTop))}px)` : '';
    document.body.classList.toggle('kb', keyboard);
  }
  if (keyboard) {
    const input = $('text');
    const overflow = Math.max(0, input.closest('footer').getBoundingClientRect().bottom - vv.height - Math.max(0, vv.offsetTop));
    const available = input.offsetHeight + $('listWrap').clientHeight - 72 - overflow;
    document.body.style.setProperty('--composer-max-height', Math.max(52, Math.floor(Math.min(vv.height * .28, available))) + 'px');
  } else document.body.style.removeProperty('--composer-max-height');
  if (stickOnKeyboard) list.scrollTop = list.scrollHeight;
}
window.addEventListener('resize', fitViewport);
window.addEventListener('pageshow', fitViewport);
document.addEventListener('focusout', () => { fitViewport(); setTimeout(fitViewport, 350); });
window.visualViewport?.addEventListener('resize', fitViewport);
window.visualViewport?.addEventListener('scroll', fitViewport);
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

// In-progress lines end with … and are cleared when the result arrives, or after a few seconds
// so a finished action cannot leave "正在…" on screen. A short result then fades on its own.
const ACTION_PENDING = new Set([
  '正在加载对话…',
  '正在发送…',
  '正在新建对话…', '正在切换窗口…', '正在切换 Agent…', '正在读取 Agent 列表…', '正在打开子 Agent…', '返回主对话…',
  '正在切换终端…', '正在删除终端…', '正在新建终端…', '正在读取终端列表…',
  '正在打开项目…', '正在读取项目…', '正在读取文件夹…', '正在读取文档…', '正在保存…',
  '正在读取设置…', '正在修改…', '正在读取额度…', '正在停止…',
  '正在撤销…', '正在保留…', '处理中…', '正在修改排队消息…',
  '切换 MAX Mode…', '读取模型参数…', '设置中…',
  '读取模式列表…', '读取模型列表…', '读取历史对话…',
]);
let statusGen = 0;
let statusTimer = 0;
let pendingStatus = '';
function status(text, ok = true) {
  const gen = ++statusGen;
  clearTimeout(statusTimer);
  pendingStatus = ok && ACTION_PENDING.has(text) ? text : '';
  $('msg').textContent = text || '';
  $('msg').className = text === '已连接' ? 'quiet' : (ok ? '' : 'err');
  const keep = text === '已连接' || (ok && /…$/.test(text || '') && !pendingStatus);
  if (!text || !ok || keep || pendingStatus) return;
  const wait = 2800;
  statusTimer = setTimeout(() => {
    if (gen !== statusGen) return;
    statusGen++;
    pendingStatus = '';
    $('msg').textContent = '';
    $('msg').className = '';
  }, wait);
}
function finishPending(list) {
  if (list.includes(pendingStatus)) status('');
}

function send(obj) {
  if (obj.t === 'attach') {
    conn.loaded = false;
    setWindowReady(false);
    status('正在切换窗口…');
    const name = {cursor: 'Cursor', devin: 'Devin', codex: 'Codex', fusion: 'Fusion'}[String(obj.id || '').split(':')[0]];
    if (name) $('titleText').textContent = name + '…';
  }
  if (obj.t === 'openMenu') obj.requestId = ++menuRequest;
  if (currentApp === 'codex' && ['settings', 'codexSetting', 'codexInstructions'].includes(obj.t)) obj.requestId = ++codexSettingsRequest;
  if (ws && ws.readyState === 1 && authed) ws.send(JSON.stringify(obj));
  else status('未连接', false);
}
function setWindowReady(ready) {
  if (!ready && typeof cancelVoice === 'function') cancelVoice();
  windowReady = ready;
  if (typeof updateVoiceButton === 'function') updateVoiceButton();
  $('send').disabled = $('sendNow').disabled = !ready;
}

