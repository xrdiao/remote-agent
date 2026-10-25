// ---- local per-session history (Devin) ----
// The relay only remembers what it has seen since it started (and caps it), so the phone keeps its own copy of
// every row of every session: merged by item id, stored in IndexedDB, dropped only when the user clears it.
const SC = { key: null, items: new Map(), sig: new Map(), collapsed: new Set(), show: 400, dirty: false, timer: 0 };
const SC_MAX = 8000;
const acpNum = id => { const m = /^acp(\d+)/.exec(id || ''); return m ? Number(m[1]) : -1; };
let scDbP = null;
const scPending = new Map(), scItemBytes = new WeakMap();
let scSaveFrame = 0;
function scDb() {
  if (!scDbP) scDbP = new Promise((res, rej) => {
    if (!window.indexedDB) return rej(new Error('no indexedDB'));
    const r = indexedDB.open('cr-sessions', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('s');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return scDbP;
}
const scReq = (mode, fn) => scDb().then(db => new Promise((res, rej) => {
  const rq = fn(db.transaction('s', mode).objectStore('s'));
  rq.onsuccess = () => res(rq.result);
  rq.onerror = () => rej(rq.error);
})).catch(() => null);
const idbGet = k => scReq('readonly', s => s.get(k));
const idbPut = (k, v) => scReq('readwrite', s => s.put(v, k));
const chatCacheKey = sel => `${currentComputer()?.id || ''}|${sel}`;
const chatPreviewReady = idbGet('chat-previews').then(entries => {
  for (const [key, chat] of entries || []) if (!chatBySel.has(key)) lruPut(chatBySel, key, chat, 12);
});
let chatPreviewTimer = 0;
function cacheChat(sel, chat) {
  lruPut(chatBySel, chatCacheKey(sel), chat, 12);
  if (!chatPreviewTimer) chatPreviewTimer = setTimeout(function savePreview() {
    if (chatScrolling || chatTouching) { chatPreviewTimer = setTimeout(savePreview, 250); return; }
    chatPreviewTimer = 0;
    idbPut('chat-previews', [...chatBySel].map(([key, value]) => [key, { ...value, items: value.items.slice(-400) }]));
  }, 1000);
}
let chatFrame = 0, queuedChat = null, chatRenderEpoch = 0;
function invalidateChatRender() {
  chatRenderEpoch++;
  queuedChat = null;
  if (chatFrame) { cancelAnimationFrame(chatFrame); chatFrame = 0; }
}
function queueChatRender(chat = queuedChat?.chat || lastChat, stale = queuedChat?.stale ?? chatStale, sel = queuedChat?.sel || viewSel) {
  queuedChat = { chat, stale, sel, epoch: chatRenderEpoch };
  if (!chatFrame) chatFrame = requestAnimationFrame(() => {
    chatFrame = 0;
    const next = queuedChat;
    queuedChat = null;
    if (next?.epoch === chatRenderEpoch && windowReady && (!next.sel || !viewSel || next.sel === viewSel)) {
      renderChat(next.chat, next.stale);
      if (next.chat && (!next.stale || next.chat.imagePreview) && !deferredScrollRender
          && windowReady && (!next.sel || next.sel === viewSel)) {
        if (!next.chat.readonly) rememberConversation();
        connContentReady();
      }
    }
  });
}
const idbDel = k => scReq('readwrite', s => s.delete(k));
const idbKeys = () => scReq('readonly', s => s.getAllKeys());
// The Android app keeps the sessions in its own SQLite database (not in WebView storage, which Android may
// clear); in a browser they stay in IndexedDB. Keys are 'h:<key>' (rows) and 'm:<key>' (size, count, time).
const nativeHist = () => (window.AgentRemoteApp && window.AgentRemoteApp.histGet) ? window.AgentRemoteApp : null;
const parseJson = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
// Cache keys are '<computer>|<app>|<window>|<session id>'; the readable session name is kept beside them.
const SC_APPS = { devin: 'Devin', cursor: 'Cursor', codex: 'Codex' };
const scTitles = parseJson(store.get('scTitles')) || {};
function scSetTitle(key, title) {
  title = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!key || !title || scTitles[key] === title) return;
  scTitles[key] = title;
  const ks = Object.keys(scTitles);
  if (ks.length > 500) delete scTitles[ks[0]];
  store.set('scTitles', JSON.stringify(scTitles));
}
const scGet = k => {
  const pending = k.startsWith('h:') && scPending.get(k.slice(2));
  if (pending) return Promise.resolve(scSnapshot(pending));
  const n = nativeHist();
  if (!n) return idbGet(k);
  return Promise.resolve(parseJson(k.startsWith('h:') ? n.histGet(k.slice(2)) : n.histMeta(k.slice(2))));
};
const scDel = k => {
  const n = nativeHist();
  if (!n) return idbDel(k);
  n.histDel(k.slice(2));
  return Promise.resolve();
};
const scKeys = () => {
  const n = nativeHist();
  return n ? Promise.resolve((parseJson(n.histKeys()) || []).map(k => 'm:' + k)) : idbKeys();
};
const htmlText = h => h.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
// Plain text of every message, for searching all sessions.
const scIndex = items => items.flatMap(it => it.k === 'human' && it.t ? [{ id: it.i, role: 'human', body: it.t.slice(0, 4000) }]
  : it.k === 'assistant' && it.h ? [{ id: it.i, role: 'assistant', body: htmlText(it.h).slice(0, 6000) }] : []);
function scSave(key, items, collapsed) {
  const n = nativeHist();
  const updated = Date.now();
  if (n) {
    const json = JSON.stringify({ items, collapsed });
    return n.histPut(key, json, JSON.stringify({ n: items.length, bytes: json.length, updated }), JSON.stringify(scIndex(items)));
  }
  const bytes = JSON.stringify({ items: [], collapsed }).length + Math.max(0, items.length - 1) + items.reduce((sum, it) => {
    let size = scItemBytes.get(it);
    if (size === undefined) { size = JSON.stringify(it).length; scItemBytes.set(it, size); }
    return sum + size;
  }, 0);
  return Promise.all([idbPut('h:' + key, { items, collapsed }), idbPut('m:' + key, { n: items.length, bytes, updated })]);
}
// Sessions saved before the native database existed (IndexedDB) are copied over once.
async function scMigrate() {
  const n = nativeHist();
  if (!n || store.get('histMig1')) return;
  for (const mk of (await idbKeys() || []).map(String).filter(k => k.startsWith('m:'))) {
    const key = mk.slice(2), h = await idbGet('h:' + key);
    if (h?.items && !n.histGet(key)) scSave(key, h.items, h.collapsed || []);
  }
  store.set('histMig1', 1);
}
setTimeout(scMigrate, 2000);
const scKeyFor = sess => `${currentComputer()?.id || '-'}|${currentApp || '?'}|${currentComputer()?.windowId || ''}|${sess}`;
// A newer copy of a row replaces the stored one, except where the stored one holds more (thought text, task items).
function scKeep(prev, it) {
  if (!prev) return it;
  if (it.k === 'thinking' && prev.k === 'thinking') {
    const body = t => (t || '').split('\n').slice(1).join('\n');
    if (body(prev.t).length > body(it.t).length) { const m = { ...it, t: prev.t }; delete m.more; return m; }
  }
  if (it.k === 'tasks' && prev.k === 'tasks' && prev.items && !it.items && prev.done === it.done && prev.total === it.total) return { ...it, items: prev.items };
  return it;
}
function scSnapshot(pending) {
  let items = [...pending.items.values()].sort((a, b) => (a.order ?? acpNum(a.i)) - (b.order ?? acpNum(b.i)));
  if (items.length > SC_MAX) items = items.slice(-SC_MAX);
  return { items, collapsed: [...pending.collapsed] };
}
let scDrainTimer = 0;
function scDrain(force = false) {
  clearTimeout(scDrainTimer);
  scDrainTimer = 0;
  if (!force && (chatScrolling || chatTouching)) {
    scDrainTimer = setTimeout(() => scDrain(), 250);
    return Promise.resolve();
  }
  const saves = [];
  for (const [key, pending] of scPending) {
    if (pending.saving) { saves.push(pending.saving); continue; }
    const { items, collapsed } = scSnapshot(pending);
    pending.saving = Promise.resolve(scSave(key, items, collapsed)).then(() => {
      if (scPending.get(key) === pending) scPending.delete(key);
    });
    saves.push(pending.saving);
  }
  return Promise.all(saves);
}
function scFlush() {
  clearTimeout(SC.timer);
  SC.timer = 0;
  if (!SC.key || !SC.dirty) return;
  SC.dirty = false;
  scPending.set(SC.key, { items: SC.items, collapsed: new Set(SC.collapsed) });
  if (!scSaveFrame) scSaveFrame = requestAnimationFrame(() => {
    scSaveFrame = 0;
    setTimeout(scDrain, 0);
  });
}
function scDirty() {
  SC.dirty = true;
  if (!SC.timer) SC.timer = setTimeout(scFlush, 3000);
}
document.addEventListener('visibilitychange', () => { if (document.hidden) { scFlush(); scDrain(true); } });
addEventListener('pagehide', () => { scFlush(); scDrain(true); });
function scSwitch(sess) {
  scFlush();
  SC.key = sess ? scKeyFor(sess) : null;
  SC.items = new Map(); SC.sig = new Map(); SC.collapsed = new Set(); SC.show = 400;
  const k = SC.key;
  if (!k) return;
  scGet('h:' + k).then(v => {
    if (SC.key !== k || !v || lastChat?.empty) return;
    for (const it of v.items || []) {
      const cur = SC.items.get(it.i);
      SC.items.set(it.i, cur ? scKeep(it, cur) : it);
    }
    for (const c of v.collapsed || []) SC.collapsed.add(c);
    if (lastChat) renderChat(lastChat);
  });
}
// Merge what the relay sent into the stored session and return what to draw: all rows (older ones windowed
// to SC.show), minus the replies of folded turns. A turn is a user message plus everything up to the next one.
function scMerge(chat) {
  if (!SC.key) return { items: chat.items, all: chat.items, older: 0, stat: null };
  if (chat.empty && SC.items.size) {
    SC.items.clear(); SC.sig.clear(); SC.collapsed.clear(); scDirty();
  }
  let changed = false;
  for (const it of chat.items) {
    const sig = JSON.stringify(it);
    if (SC.sig.get(it.i) === sig && SC.items.has(it.i)) continue;
    scItemBytes.set(it, sig.length);
    SC.sig.set(it.i, sig);
    SC.items.set(it.i, scKeep(SC.items.get(it.i), it));
    changed = true;
  }
  if (changed) scDirty();
  const all = [...SC.items.values()].sort((a, b) => (a.order ?? acpNum(a.i)) - (b.order ?? acpNum(b.i)));
  const stat = new Map(), turnOf = new Map();
  let turn = null;
  for (const it of all) {
    if (it.k === 'human') { turn = it.i; stat.set(turn, { n: 0, tools: 0 }); }
    else if (turn) { const s = stat.get(turn); s.n++; if (it.k === 'tool') s.tools++; }
    turnOf.set(it.i, turn);
  }
  let items = all.filter(it => it.k === 'human' || !SC.collapsed.has(turnOf.get(it.i)));
  let older = 0;
  if (items.length > SC.show) { older = items.length - SC.show; items = items.slice(-SC.show); }
  return { items, all, older, stat, turnOf };
}
function scFold(turn, to) {
  if (!SC.key) return;
  const want = to ?? !SC.collapsed.has(turn);
  if (turn === '*') {
    SC.collapsed = new Set(want ? [...SC.items.values()].filter(it => it.k === 'human').map(it => it.i) : []);
  } else if (want) SC.collapsed.add(turn); else SC.collapsed.delete(turn);
  scDirty();
  if (lastChat) renderChat(lastChat);
}
// The desktop rewound the session (revert): rows from `from` on no longer exist, here or on the computer.
function scTrunc(from) {
  if (!SC.key || !(from >= 0)) return;
  for (const k of [...SC.items.keys()]) if (acpNum(k) >= from) { SC.items.delete(k); SC.sig.delete(k); }
  for (const c of [...SC.collapsed]) if (acpNum(c) >= from) SC.collapsed.delete(c);
  scDirty();
  if (lastChat) renderChat(lastChat);
}
function scJump(id) {
  if (!SC.items.has(id)) return false;
  const all = [...SC.items.values()].sort((a, b) => (a.order ?? acpNum(a.i)) - (b.order ?? acpNum(b.i)));
  let turn = null, pos = 0;
  all.forEach((it, n) => { if (it.k === 'human') turn = it.i; if (it.i === id) { if (turn) SC.collapsed.delete(turn); pos = n; } });
  SC.show = Math.max(SC.show, all.length - pos + 20);
  scDirty();
  if (lastChat) renderChat(lastChat);
  requestAnimationFrame(() => {
    const el = itemsEl.querySelector(`[data-i="${CSS.escape(id)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1800);
  });
  return true;
}
function scSearch(q) {
  const out = $('scResults');
  const n = nativeHist();
  const hits = n && q.trim() ? parseJson(n.histSearch(q)) || [] : [];
  out.innerHTML = !q.trim() ? '' : hits.length ? hits.map(h => {
    const title = scTitles[h.k] || '(未命名)';
    return `<button class="opt" data-sc-hit="${esc(h.k)}" data-sc-id="${esc(h.id)}"><span class="lbl">${esc(h.snip)}<span class="sub">${esc(title)} · ${h.role === 'human' ? '我' : 'Agent'}</span></span></button>`;
  }).join('') : '<div class="hint">没有找到。</div>';
}
async function scClear(key) {
  scPending.delete(key);
  await scDel('h:' + key);
  await scDel('m:' + key);
  if (key === SC.key) {
    SC.items = new Map(); SC.sig = new Map(); SC.collapsed = new Set(); SC.dirty = false;
    if (lastChat) renderChat(lastChat);
  }
}
function showBgSheet() {
  const app = window.AgentRemoteApp;
  if (!app?.listenStatus) return;
  const st = app.listenStatus();
  const err = app.listenError?.() || '';
  const label = (st === 'retry' || st === 'connecting') && err ? `断开了，正在重连…（${esc(err)}）`
    : { connected: '已连接', connecting: '连接中…', retry: '断开了，正在重连…', off: '未开启' }[st] || st;
  const battery = app.batteryOk();
  const notify = app.notifyAllowed ? app.notifyAllowed() : null;
  openSheet('bg', `<h3>后台连接</h3>
    <div class="hint">App 退到后台时，由一个常驻的通知保持和电脑的连接，Agent 完成或需要你确认时提醒你，也可以直接在通知里回复或选择。</div>
    <div class="opt" style="pointer-events:none"><span class="lbl">连接状态<span class="sub">${label}${st === 'off' ? '（先在菜单里开启通知）' : ''}</span></span></div>
    <div class="opt" style="pointer-events:none"><span class="lbl">电池优化<span class="sub">${battery ? '已放行，系统不会为了省电断开它' : '没放行：锁屏一段时间后系统可能会断开连接'}</span></span></div>
    ${battery ? '' : '<button class="opt" data-act="bgBattery"><span class="lbl">去放行电池优化</span></button>'}
    ${notify === null ? '' : `<div class="opt" style="pointer-events:none"><span class="lbl">系统通知权限<span class="sub">${notify ? '已允许' : '被关闭：收不到任何提醒'}</span></span></div>`}
    ${notify === false ? '<button class="opt" data-act="bgNotifySettings"><span class="lbl">去打开通知权限</span></button>' : ''}
    <button class="opt" data-act="bgReconnect"><span class="lbl">立即重连</span></button>`);
}
async function showCacheSheet() {
  scFlush();
  await scDrain(true);
  const keys = ((await scKeys()) || []).map(String).filter(k => k.startsWith('m:')).map(k => k.slice(2));
  const rows = (await Promise.all(keys.map(async k => {
    const m = await scGet('m:' + k);
    if (m && !scTitles[k]) {
      const first = ((await scGet('h:' + k))?.items || []).find(it => it.k === 'human' && it.t);
      if (first) scSetTitle(k, first.t.trim().split('\n')[0]);
    }
    return { k, m, app: k.split('|')[1] || '?', title: scTitles[k] || '(未命名)' };
  }))).filter(x => x.m).sort((a, b) => b.m.updated - a.m.updated);
  const order = Object.keys(SC_APPS);
  const apps = [...new Set(rows.map(r => r.app))].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  const list = apps.map(app => `<div class="pSec">${esc(SC_APPS[app] || app)}</div>` + rows.filter(r => r.app === app).map(({ k, m, title }) =>
    `<div class="optRow"><button class="opt ${k === SC.key ? 'cur' : ''}" data-sc-noop><span class="lbl">${esc(title)}<span class="sub">${m.n} 条 · ${fmtSize(m.bytes || 0)}</span></span>${k === SC.key ? '<span class="tag">当前</span>' : ''}</button><button data-sc-del="${esc(k)}">清除</button></div>`).join('')).join('');
  openSheet('cache', `<h3>会话缓存</h3>`
    + `<div class="hint">手机上保存了每个会话的完整对话，重启电脑端也不会丢；只有你清除时才会删除。</div>`
    + (nativeHist() ? '<input id="scQ" type="search" placeholder="搜索所有会话里的对话" style="width:100%;box-sizing:border-box;margin:8px 0"><div id="scResults"></div>' : '')
    + (SC.key ? `<div class="pRow" style="margin:10px 0"><button data-sc="fold">折叠所有轮次</button><button data-sc="unfold">展开所有轮次</button></div>` : '')
    + (list || '<div class="hint">还没有缓存的会话。</div>')
    + (rows.length ? `<button class="opt" data-sc="clearAll"><span class="lbl">清除全部会话缓存</span></button>` : ''));
  let t = 0;
  $('scQ')?.addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => scSearch(e.target.value), 250); });
}
// A selection inside the chat is lost when its nodes are replaced, so while text is selected the message list
// is left alone (the bars below still update) and drawn once the selection is gone; unchanged messages are
// never detached, so a selection in an older message survives a streaming update.
function userSelecting() {
  const sel = getSelection();
  return !!sel && !sel.isCollapsed && sel.rangeCount > 0 && itemsEl.contains(sel.getRangeAt(0).commonAncestorContainer);
}
let deferredRender = false;
let chatScrolling = false, chatTouching = false, chatMomentum = false, scrollIdle = 0, deferredScrollRender = false, lastScrollTop = 0;
let scrollMode = 'freeScroll', scrollCorrection = null, scrollFrame = 0, historyScrollSnapshot = null;
let historyRequest = null, historyRendering = false, historyExpanded = false, historyArmed = false, historySerial = 0, historyAtEnd = false;
let historyWaitingForIdle = false;
let pendingHistoryStatus = null;
let turnNavTimer = 0, turnNavHeld = false, turnNavUser = false, turnNavCursor = null, turnNavPending = null;
let turnNavPointer = null, turnNavSkipClick = false;
let restoringChatScroll = false;
let layoutDirty = false, syncScrollFlush = false, suppressHistoryArm = false;
function isFollowingBottom() { return scrollMode === 'followBottom'; }
function setScrollMode(next) {
  scrollMode = next;
  if (next === 'followBottom') {
    historyArmed = false;
    if (scrollCorrection?.kind === 'anchor' || scrollCorrection?.kind === 'bottom') scrollCorrection = null;
  }
  else {
    if (scrollCorrection?.kind === 'bottom' || scrollCorrection?.kind === 'anchor') scrollCorrection = null;
  }
}
function maxChatScrollTop() { return Math.max(0, list.scrollHeight - list.clientHeight); }
function setChatScrollTop(next) {
  next = Math.max(0, Math.min(maxChatScrollTop(), next));
  if (Math.abs(list.scrollTop - next) < 1) return false;
  restoringChatScroll = true;
  list.scrollTop = next;
  requestAnimationFrame(() => { restoringChatScroll = false; updateToBottom(); });
  return true;
}
function anchorScrollTop(anchor) {
  const el = [...itemsEl.children].find(e => e.dataset.i === anchor?.id);
  if (!el) return null;
  const nowTop = el.getBoundingClientRect().top - list.getBoundingClientRect().top;
  const userDelta = list.scrollTop - (anchor.scrollTop ?? list.scrollTop);
  return list.scrollTop + nowTop - anchor.top + userDelta;
}
function applyChatScrollCorrection() {
  const correction = scrollCorrection;
  scrollCorrection = null;
  if (chatTouching || chatMomentum || chatScrolling || turnNavPointer?.dragging) {
    if (correction) scrollCorrection = correction;
    layoutDirty = true;
    return false;
  }
  if (scrollMode === 'followBottom' || correction?.kind === 'bottom') setChatScrollTop(maxChatScrollTop());
  else if (correction?.kind === 'delta') setChatScrollTop(correction.top + list.scrollHeight - correction.height);
  else {
    const next = anchorScrollTop(correction?.anchor);
    if (next !== null) setChatScrollTop(next);
  }
  layoutDirty = false;
  updateTurnNav();
  return true;
}
function reconcileChatScroll(sync = false) {
  if (sync) {
    if (scrollFrame) { cancelAnimationFrame(scrollFrame); scrollFrame = 0; }
    applyChatScrollCorrection();
    return;
  }
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    applyChatScrollCorrection();
  });
}
function requestChatScroll() {
  setScrollMode('followBottom');
  scrollCorrection = { kind: 'bottom' };
  reconcileChatScroll();
}
function restoreChatPosition(anchor, stick = false) {
  if (stick) {
    setScrollMode('followBottom');
    scrollCorrection = { kind: 'bottom' };
  } else {
    setScrollMode('freeScroll');
    if (anchor && scrollCorrection?.kind !== 'delta') scrollCorrection = { kind: 'anchor', anchor };
  }
  reconcileChatScroll(syncScrollFlush);
}
const chatSizeObserver = new ResizeObserver(() => {
  if (chatTouching || chatMomentum || chatScrolling || turnNavPointer?.dragging || syncScrollFlush) {
    layoutDirty = true;
    return;
  }
  if (isFollowingBottom()) { requestChatScroll(); return; }
  if (scrollCorrection?.kind === 'delta') { reconcileChatScroll(); return; }
  layoutDirty = false;
});
for (const el of [itemsEl, $('older'), $('historyStatus'), $('cachedMore')]) chatSizeObserver.observe(el);
document.addEventListener('selectionchange', () => {
  if (deferredRender && !userSelecting()) { deferredRender = false; if (lastChat) renderChat(lastChat); }
});
function syncChildren(parent, els) {
  const keep = new Set(els);
  for (const child of [...parent.children]) if (!keep.has(child)) child.remove();
  let cursor = parent.firstElementChild;
  const fragment = document.createDocumentFragment();
  const flush = () => { if (fragment.childNodes.length) parent.insertBefore(fragment, cursor); };
  for (const el of els) {
    if (el === cursor) { flush(); cursor = cursor.nextElementSibling; }
    else if (el.parentNode === parent) { flush(); parent.insertBefore(el, cursor); }
    else fragment.append(el);
  }
  flush();
}
// Pictures / files attached to Devin's prompt, with an x that takes them off again.
// Devin's working directory (Agent view). Changeable only on a new session, before the first message.
let workdir = null, wantDir = false;
function paintWorkdir(wd) {
  workdir = wd || null;
  const b = $('pickDir');
  b.hidden = !wd;
  if (!wd) return;
  b.textContent = `📁 ${wd.name}${wd.extra ? ' ' + wd.extra : ''}`;
  b.title = wd.editable ? '更换工作目录' : '这个会话的工作目录';
  if (wantDir && wd.editable) { wantDir = false; send({ t: 'workdir' }); }
}
$('pickDir').onclick = async () => {
  if (!workdir) return;
  if (workdir.editable) return send({ t: 'workdir' });
  if (!await ask('工作目录只能在新会话发出第一条消息之前更换。\n现在新建一个对话来更换吗？', '新建')) return;
  wantDir = true;
  send({ t: 'newProjectChat' });
};
function showWorkdirs(m) {
  const cur = m.info?.name;
  const envs = ['Local', 'Worktree', 'Cloud'].map(e => `<button class="opt ${e === m.info?.env ? 'cur' : ''}" data-env="${e}" style="flex:1;justify-content:center"><span class="lbl">${e === 'Local' ? '本地' : e === 'Worktree' ? 'Worktree' : '云端'}</span></button>`).join('');
  const rows = m.rows.map((r, i) => `<button class="opt ${r.name === cur ? 'cur' : ''}" data-wd="${i}"><span class="lbl">${esc(r.name)}<span class="sub">${esc(r.path)}</span></span>${r.name === cur ? '<span class="tag">当前</span>' : ''}</button>`).join('');
  openSheet('workdir', `<h3>工作目录</h3><div class="pSec">运行位置</div><div class="pRow" style="display:flex;gap:6px;margin-bottom:8px">${envs}</div><div class="pSec">文件夹</div><button class="opt" data-act="projects">选择文件夹／新建项目</button>${rows || '<div class="hint">没有读到文件夹列表。</div>'}`);
  $('sheet')._wd = m.rows;
}
function pruneEchoes(chat) {
  if (!pendingEchoes.length) return;
  const humans = (chat?.items || []).filter(it => it.k === 'human');
  const queued = (chat?.queued || []).map(q => (q.t || '').trim());
  const queuedCount = Math.max(queued.length, chat?.queuedCount || 0);
  pendingEchoes = pendingEchoes.filter(p => {
    // A send that vanished with a dead socket would otherwise spin "发送中…" forever.
    if (Date.now() - p.at > (p.confirmed ? 60000 : 120000)) return false;
    if (p.sel !== viewSel) return true;
    const matches = humans.filter(it => echoTextMatches(it, p.text)).length;
    if (matches > p.before) return false;
    // Once the send is acknowledged, a human item stamped after the click is enough: the extracted
    // text can differ from the typed text (mentions, attachments), which would leave the echo forever.
    if (p.confirmed && humans.some(it => it.sentAt && it.sentAt >= p.at - 2000)) return false;
    if (p.kind === 'queue' && queued.some(t => echoTextMatches({ t }, p.text))) return false;
    // Queue row text is rendered (markdown, collapsed whitespace) and may never equal the
    // typed text; once confirmed, any non-empty queue already contains the echo.
    if (p.kind === 'queue' && p.confirmed && queuedCount > 0) return false;
    return true;
  });
}
function pendingEchoEls() {
  return pendingEchoes.filter(p => p.kind === 'chat' && p.sel === viewSel).map(p => {
    const el = document.createElement('div');
    el.className = 'msg human pending';
    el.innerHTML = `<div class="humanContent"><div class="bubble">${esc(p.text)}</div><div class="messageMeta">${I18N.tr(p.confirmed ? '已发送' : '发送中…')}</div></div>`;
    return el;
  });
}
const executionRecordsShown = () => store.get('show-execution-' + currentApp) === '1';
function executionRecord(it) {
  return it.k === 'tool' && (it.execution || ['command', 'read', 'search', 'explore'].includes(it.kind)
    || String(it.i).includes(':exec:'));
}
function visibleChatItems(items, busy) {
  const shown = executionRecordsShown();
  const latestTurn = busy ? Math.max(0, items.findLastIndex(it => it.k === 'human')) : items.length;
  return items.filter((it, n) => {
    if (!executionRecord(it)) return !(it.k === 'tool' && it.done);
    const attention = it.keep || it.b?.some(b => /^(?:run(?! in background)|allow|approve|reject|deny|retry|confirm|continue|accept)\b|^(?:运行|允许|批准|拒绝|重试|确认|继续|接受)/i.test(b))
      || /(?:^|\n)\s*(?:error\b|failed\b|permission denied\b|(?:(?:process|command) )?exit(?:ed)?(?: with)? code[: ]+[1-9]\d*|错误|失败|拒绝)/i.test([it.t, it.output].filter(Boolean).join('\n'));
    return shown || attention || (!it.done && n >= latestTurn);
  });
}
function toggleExecutionRecords() {
  store.set('show-execution-' + currentApp, executionRecordsShown() ? '0' : '1');
  renderChat(lastChat, chatStale);
  showMainMenu();
}
function renderChat(chat, stale, loading = false) {
  if (chat) reconcileSent(chat);
  chat = withMessageTimes(chat);
  rememberChatMessageTime(chat);
  pruneEchoes(chat);
  updateGenerationTime(chat, stale);
  chatStale = !!stale;
  if (chat?.items?.some(it => it.k === 'human')) $('sessionNotice').hidden = true;
  rememberInputHistory(chat);
  const previous = lastChat;
  if (chat && previous?.thread === chat.thread && (previous.model !== chat.model || previous.effort !== chat.effort)) {
    menuCache.delete(menuCacheKey('model'));
    menuCache.delete(menuCacheKey('effort'));
  }
  if (!chat || previous?.thread !== chat.thread) {
    resetTurnNav();
    historyRequest = null; historyRendering = false; historyExpanded = false; historyArmed = false; historyAtEnd = false; historyWaitingForIdle = false; scrollMode = 'followBottom'; scrollCorrection = null; historyScrollSnapshot = null; layoutDirty = false; syncScrollFlush = false; pendingHistoryStatus = null;
    $('older').disabled = false;
    $('historyStatus').hidden = true;
  }
  if (chat?.earlier === true) historyAtEnd = false;
  if (chat && previous?.thread === chat.thread && historyExpanded && currentApp !== 'devin') {
    const rows = historyRequest ? [...chat.items, ...previous.items] : [...previous.items, ...chat.items];
    const updates = new Map(chat.items.map(it => [it.i, it]));
    const merged = [...new Map(rows.map(it => [it.i, updates.get(it.i) || it])).values()];
    if (merged.every(it => Number.isFinite(it.order))) merged.sort((a, b) => a.order - b.order);
    chat = { ...chat, items: merged };
  }
  if ((chatTouching || chatMomentum || chatScrolling || turnNavPointer?.dragging) && chat && previous?.thread === chat.thread) {
    lastChat = chat;
    paintGenerationTime();
    deferredScrollRender = true;
    chatBusy = !!chat.busy;
    updateSendMode();
    renderQuestions(chat.readonly && !chat.questions?.codex ? null : chat.questions);
    return;
  }
  const followBottom = !historyRequest && !historyRendering && followingChat();
  const savedAnchor = null;
  lastChat = chat; updateTitle();
  paintGenerationTime();
  paintWorkdir(chat?.workdir);
  if (chat && 'context' in chat) renderContext(chat.context);
  const imageOnly = chat?.imagePreview && !chat.items.length;
  $('empty').hidden = !!chat && !imageOnly && !chat.loginRequired;
  $('empty').firstChild.textContent = I18N.tr(chat?.loginRequired ? '项目窗口已打开，请在电脑端登录此窗口的 Codex，登录后重新选择会话' : imageOnly ? '电脑端正在查看图片，暂无已同步的对话。关闭图片预览后会自动恢复。' : loading ? '正在加载对话…' : '没找到聊天面板。');
  $('emptyHint').hidden = loading || imageOnly || !!chat?.loginRequired;
  $('older').hidden = !chat || chat.earlier === false;
  $('pickMode').hidden = currentApp === 'devin' || currentApp === 'cursor' || !chat?.mode;
  $('pickModel').hidden = !supportsCapability('model') || (currentApp === 'codex' && (chatStale || !chat?.model));
  if (chat?.mode) { $('pickMode').textContent = chat.mode === 'Bypass Permissions' ? '⚠绕过' : chat.mode; $('pickMode').title = chat.mode; }
  $('pickMode').classList.toggle('bypass', chat?.mode === 'Bypass Permissions');
  const mdl = chat?.model || '模型';
  const effLabel = chat?.effort && chat.effort !== 'Effort' ? String(chat.effort).replace(/^([a-z])/, c => c.toUpperCase()) : '';
  const effSuffix = chat?.model !== 'Fusion' && effLabel && !mdl.toLowerCase().includes(effLabel.toLowerCase()) ? ` · ${effLabel}` : '';
  $('pickModel').textContent = mdl + effSuffix;
  $('pickModel').title = chat?.fusion ? `${chat.fusion.lead} · ${chat.fusion.effort} · ${chat.fusion.sidekick}${chat.fusion.fast ? ' · Fast' : ''}` : (chat?.model || '更换模型');
  const permName = PERM_LABEL[chat?.permission]?.[0];
  $('pickPerm').hidden = true;
  if (chat?.permission) { $('pickPerm').textContent = ({ 'Ask for approval': '询问', 'Approve for me': '替我审核', 'Full access': '完全批准' }[chat.permission] || permName || chat.permission); $('pickPerm').title = permName || chat.permission; }
  const codexBar = currentApp === 'codex' ? chat?.codex : null;
  $('add').hidden = false;
  $('pickPlan').hidden = true;
  if (codexBar) $('pickPlan').textContent = codexBar.plan ? 'Plan：开' : 'Plan：关';
  $('pickIde').hidden = true;
  if (codexBar?.ide) {
    const file = codexBar.ide.file;
    $('pickIde').textContent = 'IDE：' + (codexBar.ide.on ? '开' : '关');
    $('pickIde').title = file ? `${file.label}${file.range ? ' ' + file.range : ''}` : 'IDE 上下文';
  }
  $('pickRun').hidden = true;
  if (codexBar?.run) $('pickRun').textContent = codexBar.run;
  $('pickChat').hidden = true;
  paintFusion(currentApp === 'fusion' ? chat?.fusion : null);
  chatBusy = !!chat?.busy;
  updateSendMode();
  currentSurface = chat?.surface || null;
  paintSurface();
  if (!chat) {
    // A new chat has no transcript yet; its first message still shows as "发送中…".
    const echoes = pendingEchoEls();
    if (echoes.length) $('empty').hidden = true;
    itemsEl.replaceChildren(...echoes); itemsEl.classList.remove('stale'); renderQueue(false, []); renderQuestions(null); paintSessions(null); latestTasks = null; $('taskChip').hidden = true; return; }
  const sessionChanged = paintSessions(chat);
  const V = scMerge(chat);
  if (!sessionChanged && userSelecting()) {
    deferredRender = true;
    $('actionBar').innerHTML = buttonsHtml(chat.global, 'g');
    if (chat.global?.length) maybeAutoRetry({ i: 'global', btnItem: 'g', b: chat.global });
    $('actionBar').classList.toggle('show', chat.global.length > 0);
    renderQueue(chat.busy, chat.queued || [], chat.subagents || [], chat.readonly, chat.changed, chat.queuedCount);
    renderQuestions(chat.readonly && !chat.questions?.codex ? null : chat.questions);
    noteSwitch(chat);
    return;
  }
  if (SC.key && V.all.length) $('older').hidden = Math.min(...V.all.map(it => acpNum(it.i)).filter(n => n >= 0), Infinity) <= 0;
  $('older').hidden ||= historyAtEnd;
  $('cachedMore').hidden = !V.older;
  $('cachedMore').textContent = `↑ 显示更早的本地记录（${V.older} 条）`;
  const stick = followBottom || sessionChanged;
  const visibleItems = visibleChatItems(V.items, chat.busy);
  // Anchor on the first visible item so loading older messages doesn't jump.
  let anchor = savedAnchor;
  if (anchor && !visibleItems.some(it => String(it.i) === anchor.id)) anchor = null;
  if (!stick && !anchor) {
    const top = list.getBoundingClientRect().top;
    let lo = 0, hi = itemsEl.children.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (itemsEl.children[mid].getBoundingClientRect().bottom > top) hi = mid;
      else lo = mid + 1;
    }
    const retained = new Set(visibleItems.map(it => String(it.i)));
    for (let n = lo; n < itemsEl.children.length; n++) {
      const el = itemsEl.children[n];
      if (retained.has(el.dataset.i)) { anchor = { id: el.dataset.i, top: el.getBoundingClientRect().top - top }; break; }
    }
    if (!anchor) for (let n = lo - 1; n >= 0; n--) {
      const el = itemsEl.children[n];
      if (retained.has(el.dataset.i)) { anchor = { id: el.dataset.i, top: el.getBoundingClientRect().top - top }; break; }
    }
  }
  const els = visibleItems.map(it => {
    const key = JSON.stringify(it);
    const hit = cache.get(it.i);
    if (hit && hit.key === key) return hit.el;
    if (it.k === 'thinking' && hit?.el) {
      paintThinking(hit.el, it);
      cache.set(it.i, { key, el: hit.el });
      return hit.el;
    }
    const el = renderItem(it);
    if (it.k === 'tool' && it.kind === 'command' && hit?.el.classList.contains('toolrow') && patchToolRow(hit.el, el)) {
      cache.set(it.i, { key, el: hit.el });
      return hit.el;
    }
    if (it.k === 'tool' && hit?.el.classList.contains('toolrow')) {
      const open = hit.el.classList.contains('open');
      el.classList.toggle('open', open);
      const chev = el.querySelector('.chev');
      if (chev) chev.textContent = open ? '▾' : '▸';
    }
    el.dataset.i = it.i;
    cache.set(it.i, { key, el });
    return el;
  });
  visibleItems.forEach((it, n) => {
    const st = it.k === 'human' && V.stat?.get(it.i);
    if (!st) return;
    const el = els[n], folded = SC.collapsed.has(it.i);
    const fb = el.querySelector('[data-fold]');
    if (fb) fb.textContent = folded ? '▸' : '▾';
    const sm = el.querySelector('.turnSum');
    if (sm) sm.textContent = folded && st.n ? `${st.n} 条回复${st.tools ? ` · ${st.tools} 个工具` : ''}` : '';
  });
  // A fold button after the last reply of every turn, so a long answer can be folded from its end.
  if (V.turnOf) {
    const last = new Map();
    visibleItems.forEach((it, n) => { if (it.k === 'assistant' && V.turnOf.get(it.i)) last.set(V.turnOf.get(it.i), n); });
    const keep = new Set(last.values());
    visibleItems.forEach((it, n) => {
      const el = els[n];
      let b = el.querySelector(':scope > .endFold');
      if (!keep.has(n)) return b?.remove();
      if (!b) {
        b = document.createElement('button');
        b.className = 'endFold';
        b.textContent = '▴ 折叠这一轮';
        el.append(b);
      }
      b.dataset.fold = V.turnOf.get(it.i);
    });
  }
  els.push(...pendingEchoEls());
  syncChildren(itemsEl, els);
  if (historyScrollSnapshot) {
    scrollCorrection = { kind: 'delta', ...historyScrollSnapshot };
    historyScrollSnapshot = null;
  }
  itemsEl.classList.toggle('stale', chatStale);
  latestTasks = (chat.items || []).filter(it => it.k === 'tasks').pop() || null;
  $('taskChip').hidden = !latestTasks || (latestTasks.done >= latestTasks.total && !chat.busy);
  if (latestTasks) $('taskChip').innerHTML = `<span>${I18N.tr('任务')}</span> ${latestTasks.done}/${latestTasks.total}`;
  if (sheetKind === 'tasks') showTasks();
  const live = new Set(V.items.map(it => it.i));
  for (const k of cache.keys()) if (!live.has(k)) { thoughtObserver.unobserve(cache.get(k).el); cache.delete(k); }

  // A cached render is display-only: no action buttons, questions or queue actions until the fresh chat arrives.
  $('actionBar').innerHTML = chatStale ? '' : buttonsHtml(chat.global, 'g');
  if (!chatStale && chat.global?.length) maybeAutoRetry({ i: 'global', btnItem: 'g', b: chat.global });
  $('actionBar').classList.toggle('show', !chatStale && chat.global.length > 0);
  renderQueue(chatStale ? false : chat.busy, chatStale ? [] : (chat.queued || []), chat.subagents || [], chat.readonly, chat.changed, chat.queuedCount);
  renderQuestions(chatStale || (chat.readonly && !chat.questions?.codex) ? null : chat.questions);

  paintHistoryStatus();
  restoreChatPosition(anchor, stick);
  historyRendering = false;
  if (!stick && previous && JSON.stringify(previous.items) !== JSON.stringify(chat.items)) $('toBottom').textContent = '↓ 有新消息';
  updateToBottom();
  noteSwitch(chat);
  if (SC.jump && SC.items.has(SC.jump)) { const j = SC.jump; SC.jump = null; scJump(j); }
  completeTurnNavigation();
  resumeHistoryAfterIdle();
}

let subsOpen = false, queueOpen = store.get('queue-open') !== '0';
// Newest Devin task list (highest acp index); the chip above the chat and its sheet show it.
let latestTasks = null;
function showTasks() {
  if (!latestTasks) return closeSheet();
  openSheet('tasks', `<h3>${I18N.tr('任务')} ${latestTasks.done}/${latestTasks.total}</h3><div class="sheetTasks">${tasksHtml(latestTasks)}</div>`);
}
itemsEl.addEventListener('click', e => { const b = e.target.closest('[data-codex-agent]'); if (b) send({ t: 'openAgent', id: b.dataset.codexAgent }); });
$('taskChip').onclick = () => showTasks();
itemsEl.addEventListener('toggle', e => { const id = e.target.dataset.task; if (id) e.target.open ? taskOpen.add(id) : taskOpen.delete(id); }, true);
$('qnBar').addEventListener('click', e => {
  const compose = e.target.closest('[data-question-compose]');
  if (compose) { setQuestionCompose(compose.dataset.questionCompose); text.focus(); return; }
  const b = e.target.closest('[data-action][data-request]');
  if (b) {
    const id = b.dataset.request, n = Number(b.dataset.action);
    const request = qnState?.requests?.find(r => r.id === id);
    const fields = !id.startsWith('async:') || n === request.buttons.length - 1
      ? [...$('qnBar').querySelectorAll('[data-field]')].filter(el => el.dataset.request === id).map(el => ({ n: Number(el.dataset.field), value: el.value })) : [];
    sendQuestion({ t: 'codexRequest', id, n, fields, ...(id.startsWith('async:') && n < request.buttons.length - 2 ? { advance: true } : {}) });
  }
});
// The Agent's ask-question tool: a card with the questions, options, a free-text answer and submit / skip.
let qnSig = '', qnState = null, qnView = '', qnPending = null;
const qnDrafts = new Map();
const questionFieldKey = el => `${el.dataset.request}|${el.dataset.field}`;
function questionBusy() {
  const bar = $('qnBar');
  bar.setAttribute('aria-busy', String(!!qnPending));
  if (qnPending) bar.querySelectorAll('button,input,select').forEach(el => { el.disabled = true; });
}
function sendQuestion(message) {
  if (qnPending) return;
  if (!ws || ws.readyState !== 1 || !authed || !windowReady) { status('未连接', false); return; }
  const requestId = [...crypto.getRandomValues(new Uint32Array(4))].join('-');
  qnPending = { requestId, sel: viewSel, message };
  questionBusy();
  status('正在提交回答…');
  send({ ...message, requestId });
}
function setQuestionCompose(id) {
  if (questionCompose?.id === id && questionCompose.sel === viewSel || !questionCompose && !id) return;
  if (mode !== 'chat') { questionCompose = id ? { id, sel: viewSel } : null; updateAppText(); updateSendMode(); return; }
  saveDraft();
  const carry = !questionCompose && mode === 'chat' ? text.value : '';
  questionCompose = id ? { id, sel: viewSel } : null;
  restoreDraft();
  if (id && !drafts.has(activeDraft)) {
    text.value = qnDrafts.get(`${id}|0`) ?? qnState?.requests?.find(r => r.id === id)?.fields[0]?.value ?? '';
    if (!text.value) text.value = carry;
    syncQuestionDraft(text.value);
    autosize(); saveDraft();
  }
  updateAppText();
  updateSendMode();
}
function syncQuestionDraft(value) {
  if (mode !== 'chat' || questionCompose?.sel !== viewSel) return;
  qnDrafts.set(`${questionCompose.id}|0`, value);
  const field = [...$('qnBar').querySelectorAll('[data-field="0"]')].find(el => el.dataset.request === questionCompose.id);
  if (field) {
    field.value = value;
    const request = qnState?.requests?.find(r => r.id === questionCompose.id);
    const submit = [...$('qnBar').querySelectorAll('[data-action]')].find(el => el.dataset.request === questionCompose.id && Number(el.dataset.action) === request.buttons.length - 1);
    if (submit) submit.disabled = !!qnPending || request.buttons.every(b => b.disabled) || !value.trim();
  }
}
function submitQuestionCompose() {
  const request = qnState?.requests?.find(r => r.id === questionCompose?.id);
  if (!request) return status('当前问题已结束，请确认后再发送', false);
  if (!text.value.trim()) return;
  saveDraft();
  sendQuestion({ t: 'codexRequest', id: request.id, n: request.buttons.length - 1, fields: [{ n: 0, value: text.value }] });
}
function finishQuestion(m) {
  if (!qnPending || m.requestId !== qnPending.requestId) return;
  const pending = qnPending;
  qnPending = null;
  if (pending.sel !== viewSel) return;
  if (m.ok && pending.message.id) {
    const answerKey = [currentComputer()?.id || '', viewSel, 'chat', pending.message.id].join('|');
    drafts.delete(answerKey); draftMentions.delete(answerKey);
    if (pending.message.id.startsWith('async:') && (pending.message.advance || pending.message.n === (qnState?.requests?.find(r => r.id === pending.message.id)?.buttons.length || 0) - 1)) {
      qnState = { ...qnState, requests: qnState.requests.filter(r => r.id !== pending.message.id) };
    }
    for (const key of qnDrafts.keys()) if (key.startsWith(pending.message.id + '|')) qnDrafts.delete(key);
    if (questionCompose?.id === pending.message.id) {
      if (mode === 'chat') text.value = '';
      setQuestionCompose(null);
    }
  }
  qnSig = '';
  renderQuestions(qnState);
  status(m.ok ? '已提交' : '回答提交失败', m.ok);
}
function renderQuestions(qs) {
  const bar = $('qnBar');
  if (qs?.codex && currentApp !== 'codex') qs = null;
  if (qnView !== viewSel) { qnView = viewSel; qnSig = ''; qnPending = null; qnDrafts.clear(); }
  qnState = qs;
  const answers = qs?.codex ? qs.requests.filter(r => r.id.startsWith('async:')) : [];
  setQuestionCompose(answers.find(r => r.id === questionCompose?.id && questionCompose.sel === viewSel)?.id || null);
  bar.classList.toggle('codex', !!qs?.codex);
  const sig = JSON.stringify(qs);
  if (sig === qnSig) return;
  qnSig = sig;
  if (qs?.codex) {
    const focused = bar.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused?.matches('[data-field]') ? questionFieldKey(focused) : null;
    const selection = focusKey ? [focused.selectionStart, focused.selectionEnd] : null;
    const expanded = new Set([...bar.querySelectorAll('details[open]')].map(el => el.dataset.question));
    bar.innerHTML = `<div class="qnHead">Codex 等待你${qs.requests.some(r => r.id.startsWith('approval:')) ? '审批' : '回答'}<span class="qnCount">${qs.requests.length} 个请求</span></div>` + qs.requests.map(r => {
      const lines = r.text.trim().split('\n'), heading = lines.shift();
      const remaining = lines.join('\n').trim();
      return `<section class="qnRequest"><div class="qnQ">${esc(heading)}</div>`
      + (remaining ? `<details class="qnDetails" data-question="${esc(r.id)}" ${expanded.has(r.id) ? 'open' : ''}><summary>展开问题详情</summary>${esc(remaining)}</details>` : '')
      + (r.id.startsWith('async:') ? `<div class="qnOpts">${r.buttons.slice(0, -2).map((b, n) => `<button class="qnOpt ${b.selected ? 'on' : ''}" data-request="${esc(r.id)}" data-action="${n}" aria-pressed="${!!b.selected}" ${b.disabled ? 'disabled' : ''}>${esc(b.label)}</button>`).join('')}</div>` : '')
      + r.fields.map((f, n) => `<label class="qnFree">${esc(f.label)}${f.options ? `<select data-request="${esc(r.id)}" data-field="${n}">${f.options.map(o => `<option value="${esc(o.value)}" ${o.value === f.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>` : `<input data-request="${esc(r.id)}" data-field="${n}" type="${f.type === 'password' ? 'password' : 'text'}" value="${esc(f.value)}">`}</label>`).join('')
      + `<div class="qnAct">${r.id.startsWith('async:') ? `<button data-question-compose="${esc(r.id)}">在对话框回答</button>` : ''}${r.buttons.map((b, n) => r.id.startsWith('async:') && n < r.buttons.length - 2 ? '' : `<button data-request="${esc(r.id)}" data-action="${n}" aria-pressed="${!!b.selected}" ${b.disabled ? 'disabled' : ''}>${esc(b.label)}</button>`).join('')}</div></section>`; }).join('');
    bar.classList.toggle('show', qs.requests.length > 0);
    bar.querySelectorAll('[data-field]').forEach(el => {
      const key = questionFieldKey(el);
      if (qnDrafts.has(key)) el.value = qnDrafts.get(key);
      el.oninput = () => {
        qnDrafts.set(key, el.value);
        const r = qnState.requests.find(r => r.id === el.dataset.request);
        if (r.id.startsWith('async:') && el.dataset.field === '0' && mode === 'chat' && document.activeElement === el) {
          setQuestionCompose(r.id);
          text.value = el.value; autosize(); saveDraft();
        }
        if (r.id.startsWith('async:') && !r.buttons.every(b => b.disabled) && !qnPending) {
          const submit = [...bar.querySelectorAll('[data-action]')].find(b => b.dataset.request === r.id && Number(b.dataset.action) === r.buttons.length - 1);
          submit.disabled = !el.value.trim();
        }
      };
      if (el.dataset.request.startsWith('async:') && el.dataset.field === '0') el.onfocus = () => setQuestionCompose(el.dataset.request);
      el.onchange = () => { if (!el.dataset.request.startsWith('async:')) send({ t: 'codexRequest', id: el.dataset.request, field: Number(el.dataset.field), value: el.value }); };
      if (qnDrafts.has(key)) el.oninput();
      if (key === focusKey && !qnPending) {
        el.focus();
        if (el.tagName === 'INPUT') el.setSelectionRange(...selection);
      }
    });
    questionBusy();
    if (document.body.classList.contains('kb')) fitViewport();
    return;
  }
  if (!qs?.list?.length) { bar.innerHTML = ''; bar.classList.remove('show'); return; }
  if (qs.devin) {
    const q = qs.list[0], pg = qs.pager;
    bar.innerHTML = `<div class="qnHead">Devin 在问你${pg ? `（${pg.cur}/${pg.total}）` : ''}`
      + (pg && pg.total > 1 ? `<span class="qnPg"><button data-qpart="prev" ${qs.canPrev ? '' : 'disabled'}>‹</button><button data-qpart="next" ${qs.canNext ? '' : 'disabled'}>›</button></span>` : '') + '</div>'
      + `<div class="qnQ">${esc(q.text)}</div><div class="qnOpts">`
      + q.options.map((o, oi) => `<button class="qnOpt ${o.sel ? 'on' : ''}" data-qi="0" data-oi="${oi}"><b>${q.multi ? (o.sel ? '☑' : '☐') : String.fromCharCode(65 + oi)}</b><span>${esc(o.label)}${o.desc ? `<small>${esc(o.desc)}</small>` : ''}</span></button>`).join('')
      + `</div><div class="qnHint">想自己回答？直接在下方输入框写</div>`
      + `<div class="qnAct"><button data-qpart="skip">跳过</button>${qs.hasSubmit ? `<button class="primary" data-qpart="submit" ${qs.canSubmit ? '' : 'disabled'}>提交</button>` : ''}</div>`;
    bar.classList.add('show');
    questionBusy();
    return;
  }
  bar.innerHTML = `<div class="qnHead">Agent 在问你${qs.list.length > 1 ? `（${qs.list.length} 个问题）` : ''}</div>`
    + qs.list.map((q, qi) => `<div class="qnQ">${qs.list.length > 1 ? `${qi + 1}. ` : ''}${esc(q.text)}</div><div class="qnOpts">`
      + q.options.map((o, oi) => {
        const letter = String.fromCharCode(65 + oi);
        return o.free
          ? `<div class="qnFree ${o.sel ? 'on' : ''}"><input data-qi="${qi}" data-oi="${oi}" placeholder="其他…" value="${esc(o.value)}" enterkeyhint="done"><button data-qfree="${qi}:${oi}">填入</button></div>`
          : `<button class="qnOpt ${o.sel ? 'on' : ''}" data-qi="${qi}" data-oi="${oi}"><b>${letter}</b><span>${esc(o.label)}</span></button>`;
      }).join('') + '</div>').join('')
    + `<div class="qnAct"><button data-qpart="skip">跳过</button><button class="primary" data-qpart="submit" ${qs.canSubmit ? '' : 'disabled'}>提交</button></div>`;
  bar.classList.add('show');
  questionBusy();
}

$('qnBar').onclick = e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.qpart) {
    const p = b.dataset.qpart;
    return sendQuestion({ t: 'question', part: p });
  }
  if (b.dataset.qfree) {
    const [qi, oi] = b.dataset.qfree.split(':').map(Number);
    return sendQuestion({ t: 'question', qi, oi, part: 'option', text: b.previousElementSibling.value });
  }
  if (b.dataset.qi) sendQuestion({ t: 'question', qi: Number(b.dataset.qi), oi: Number(b.dataset.oi), part: 'option' });
};
$('qnBar').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !e.target.matches('input')) return;
  e.preventDefault();
  if ('field' in e.target.dataset) { e.target.blur(); return; }
  e.target.nextElementSibling.click();
});

// Small stroke icons for the queue / stop controls (the text is in title and aria-label).
const ICONS = {
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  enter: '<polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  back: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
};
const ibtn = (icon, label, attrs = '', cls = '') => `<button class="ib ${cls}" ${attrs} title="${label}" aria-label="${label}"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon]}</svg></button>`;
const hiddenChangeNotices = new Set();
const changeNoticeKey = () => `${currentComputer()?.id || ''}|${viewSel}`;
function toggleChangeNotice() {
  const key = changeNoticeKey();
  if (hiddenChangeNotices.has(key)) hiddenChangeNotices.delete(key); else hiddenChangeNotices.add(key);
  renderQueue(lastChat?.busy, lastChat?.queued || [], lastChat?.subagents || [], lastChat?.readonly, lastChat?.changed, lastChat?.queuedCount);
}
function renderQueue(busy, queued, subs = [], readonly = false, changed = 0, qCount = 0) {
  const bar = $('queueBar');
  const devin = currentApp === 'devin';
  let html = '';
  if (readonly) html += `<div class="run sub"><span>正在查看子 Agent 的对话（只读）</span>${ibtn('back', '返回主对话', 'data-main')}</div>`;
  if (subs.length && !readonly) {
    html += `<button class="qh fold" data-fold>${subsOpen ? '▾' : '▸'} <span>子 Agent 运行中 ${subs.length} 个</span></button>`;
    if (subsOpen) html += subs.map(n => `<div class="q"><span class="qt sa">${esc(n)}</span>`
      + ibtn('eye', '查看', `data-sub="${esc(n)}" data-part="open"`) + ibtn('stop', '停止', `data-sub="${esc(n)}" data-part="stop"`, 'del') + '</div>').join('');
  }
  const pending = pendingEchoes.filter(p => p.kind === 'queue' && p.sel === viewSel);
  const n = Math.max(queued.length, devin ? qCount || 0 : 0) + pending.length;
  if (n) {
    html += `<div class="qhRow"><button class="qh fold" data-qfold aria-expanded="${queueOpen}">${queueOpen ? '▾' : '▸'} <span>排队中 ${n} 条</span></button>${devin ? ibtn('trash', '清空', 'data-a="clear" data-q=""', 'del') : ''}</div>`;
  }
  if (n && queueOpen) {
    html += pending.map(p => `<div class="q pending"><span class="qt">${esc(p.text)}</span><span class="sub">${I18N.tr(p.confirmed ? '已排队' : '发送中…')}</span></div>`).join('');
    html += queued.map(q => `<div class="q"><span class="qt">${esc(q.t || '(空)')}</span>`
      + (supportsCapability('queueEdit') ? ibtn('edit', devin ? '从队列取出，放回输入框' : '修改', `data-q="${esc(q.id)}" data-a="edit"`) : '')
      + ibtn('enter', '打断当前这一轮，立刻发送', `data-q="${esc(q.id)}" data-a="send"`)
      + ibtn('x', '删除', `data-q="${esc(q.id)}" data-a="remove"`, 'del') + '</div>').join('');
    if (devin && !queued.length) html += `<div class="q"><span class="qt">内容读不到，只显示数量</span></div>`;
  }
  if (changed && !readonly && !hiddenChangeNotices.has(changeNoticeKey())) html += `<div class="changesNotice"><button class="qh fold" data-changes>改动了 ${changed} 个文件 ›</button>${ibtn('x', '隐藏改动提示', 'data-toggle-changes')}</div>`;
  bar.innerHTML = html;
  bar.classList.toggle('show', Boolean(html));
  if (document.body.classList.contains('kb')) fitViewport();
}

function editQueued(id) {
  const q = (lastChat?.queued || []).find(x => x.id === id);
  if (!q) return status('这条排队消息已经不在了', false);
  if (currentApp === 'devin') { status('正在取出…'); return send({ t: 'queue', id, action: 'edit' }); }
  openSheet('queueEdit', `<h3>修改排队消息</h3>
    <textarea id="qEdit" style="width:100%;box-sizing:border-box;min-height:120px;max-height:50dvh;margin-bottom:10px"></textarea>
    <button class="opt" id="qSave" style="justify-content:center;background:var(--accent);border-color:var(--accent-b);color:#fff;font-weight:600">保存（仍在排队）</button>`);
  $('qEdit').value = q.t;
  $('qSave').onclick = () => {
    const v = $('qEdit').value;
    if (!v.trim()) return status('内容不能为空；不想要这条就点「删除」', false);
    send({ t: 'queue', id, action: 'edit', text: v });
    closeSheet();
    status('正在修改排队消息…');
  };
}

$('queueBar').onclick = async e => {
  const b = e.target.closest('button');
  if (!b) return;
  if ('toggleChanges' in b.dataset) {
    return toggleChangeNotice();
  }
  if ('changes' in b.dataset) { status('读取改动的文件…'); return send({ t: 'changes' }); }
  if ('qfold' in b.dataset) { queueOpen = !queueOpen; store.set('queue-open', queueOpen ? null : '0'); return renderQueue(lastChat?.busy, lastChat?.queued || [], lastChat?.subagents || [], lastChat?.readonly, lastChat?.changed, lastChat?.queuedCount); }
  if ('fold' in b.dataset) { subsOpen = !subsOpen; return renderQueue(lastChat?.busy, lastChat?.queued || [], lastChat?.subagents || [], lastChat?.readonly, lastChat?.changed, lastChat?.queuedCount); }
  if ('main' in b.dataset) { send({ t: 'mainChat' }); status('返回主对话…'); return; }
  if (b.dataset.sub) {
    if (b.dataset.part === 'stop' && !await ask(`停止子 Agent「${b.dataset.sub}」？\n它做到一半的工作会中断。`, '停止')) return;
    send({ t: 'subagent', name: b.dataset.sub, part: b.dataset.part });
    status(b.dataset.part === 'stop' ? '已停止子 Agent' : '正在打开子 Agent…');
    if (b.dataset.part === 'open') { setScrollMode('followBottom'); requestChatScroll(); }
    return;
  }
  if (b.dataset.a === 'edit') return editQueued(b.dataset.q);
  if (b.dataset.a === 'clear') {
    if (!await ask('清空 Devin 的排队消息？', '清空')) return;
    send({ t: 'queue', id: '', action: 'clear' });
    status('正在清空排队消息…');
    return;
  }
  if (b.dataset.a === 'send' && !await ask('立即发送这条消息？\nAgent 当前这一轮会被打断。', '立即发送')) return;
  if (b.dataset.a === 'remove' && !await ask('删除这条排队消息？', '删除')) return;
  send({ t: 'queue', id: b.dataset.q, action: b.dataset.a });
  status(b.dataset.a === 'send' ? '已立即发送这条排队消息' : '已删除这条排队消息');
};

function updateToBottom() {
  if (nearBottom()) $('toBottom').textContent = '↓ 最新';
  $('toBottom').style.display = nearBottom() ? 'none' : 'block';
  updateTurnNav();
}
function updateTurnNav() {
  const track = $('turnNavTrack'), nav = $('turnNav');
  track.hidden = !itemsEl.querySelector(':scope > .human[data-i]') || list.scrollHeight <= list.clientHeight;
  if (!track.hidden) {
    const travel = track.clientHeight - nav.offsetHeight;
    track.hidden = travel < 0;
    if (!track.hidden) {
      const progress = turnNavPointer?.dragging ? turnNavPointer.progress : list.scrollTop / (list.scrollHeight - list.clientHeight);
      nav.style.top = Math.max(0, Math.min(1, progress)) * travel + 'px';
    }
  }
}
let turnNavFrame = 0;
function scheduleTurnNavUpdate() {
  if (turnNavFrame) return;
  turnNavFrame = requestAnimationFrame(() => { turnNavFrame = 0; updateTurnNav(); });
}
const turnNavSizeObserver = new ResizeObserver(scheduleTurnNavUpdate);
for (const el of [$('listWrap'), itemsEl]) turnNavSizeObserver.observe(el);
function resetTurnNav() {
  clearTimeout(turnNavTimer);
  if (turnNavPointer?.dragging) { chatTouching = chatScrolling = false; clearTimeout(scrollIdle); }
  turnNavPointer = null; turnNavSkipClick = false;
  suppressHistoryArm = false;
  historyArmed = false;
  historyPullUp = false;
  historyWheelPullUp = false;
  turnNavHeld = turnNavUser = false;
  turnNavCursor = turnNavPending = null;
  $('turnNav').classList.remove('show');
}
function showTurnNav() {
  if (!itemsEl.querySelector(':scope > .human[data-i]')) return;
  $('turnNav').classList.add('show');
  clearTimeout(turnNavTimer);
  if (!turnNavHeld) turnNavTimer = setTimeout(() => {
    $('turnNav').classList.remove('show');
    turnNavUser = false;
  }, 1500);
}
function turnNavGesture() {
  turnNavCursor = turnNavPending = null;
  turnNavUser = true;
  showTurnNav();
}
function conversationTurns() {
  return [...(SC.key ? SC.items.values() : lastChat?.items || [])]
    .filter(it => it.k === 'human')
    .sort((a, b) => (a.order ?? acpNum(a.i)) - (b.order ?? acpNum(b.i)));
}
function jumpToTurn(id) {
  clearTimeout(scrollIdle);
  chatScrolling = false;
  let el = itemsEl.querySelector(`[data-i="${CSS.escape(String(id))}"]`);
  if (!el || deferredScrollRender) {
    if (!el) {
      const all = [...SC.items.values()].sort((a, b) => (a.order ?? acpNum(a.i)) - (b.order ?? acpNum(b.i)));
      SC.show = Math.max(SC.show, all.length - all.findIndex(it => it.i === id));
    }
    deferredScrollRender = false;
    historyRendering = true;
    renderChat(lastChat, chatStale);
    el = itemsEl.querySelector(`[data-i="${CSS.escape(String(id))}"]`);
  }
  if (!el) return;
  historyArmed = false;
  restoreChatPosition({ id: String(id), top: 8 });
  lastScrollTop = list.scrollTop;
  turnNavCursor = { id, sel: viewSel, thread: lastChat.thread };
  el.classList.add('turnHighlight');
  setTimeout(() => el.classList.remove('turnHighlight'), 1800);
  updateToBottom();
  showTurnNav();
}
function completeTurnNavigation() {
  if (!turnNavPending) return;
  const pending = turnNavPending;
  if (pending.sel !== viewSel || pending.thread !== lastChat?.thread) { turnNavPending = null; return; }
  const turns = conversationTurns(), pos = turns.findIndex(it => it.i === pending.before);
  if (pos > 0) { turnNavPending = null; jumpToTurn(turns[pos - 1].i); }
  else if (!historyRequest) turnNavPending = null;
}
function navigateTurn(direction) {
  if (!lastChat || chatTouching) return;
  const turns = conversationTurns();
  let target;
  if (turnNavCursor?.sel === viewSel && turnNavCursor.thread === lastChat.thread) {
    target = turns[turns.findIndex(it => it.i === turnNavCursor.id) + direction];
  } else {
    const top = list.getBoundingClientRect().top + 8;
    const humans = [...itemsEl.querySelectorAll(':scope > .human[data-i]')];
    const el = direction < 0 ? humans.findLast(el => el.getBoundingClientRect().top < top - 2)
      : humans.find(el => el.getBoundingClientRect().top > top + 2);
    if (el) target = turns.find(it => String(it.i) === el.dataset.i);
    else if (direction < 0 && humans.length) target = turns[turns.findIndex(it => String(it.i) === humans[0].dataset.i) - 1];
  }
  if (target) { turnNavPending = null; jumpToTurn(target.i); }
  else if (direction < 0 && turns.length) {
    turnNavPending = { sel: viewSel, thread: lastChat.thread, before: turns[0].i };
    if (historyRequest) return;
    clearTimeout(scrollIdle); chatScrolling = false;
    loadOlderMessages();
    if (!historyRequest && !deferredScrollRender) completeTurnNavigation();
  }
}
$('previousTurn').onclick = () => navigateTurn(-1);
$('nextTurn').onclick = () => navigateTurn(1);
$('toBottom').addEventListener('click', resetTurnNav);
$('turnNav').addEventListener('pointerdown', e => {
  if (e.button !== 0 || turnNavPointer) return;
  e.preventDefault();
  suppressHistoryArm = true;
  historyArmed = false;
  historyPullUp = false;
  historyWheelPullUp = false;
  scrollCorrection = null;
  layoutDirty = false;
  const nav = $('turnNav');
  turnNavSkipClick = false;
  turnNavPointer = { id: e.pointerId, y: e.clientY, top: nav.offsetTop,
    travel: $('turnNavTrack').clientHeight - nav.offsetHeight,
    opened: nav.classList.contains('show') || nav.matches(':focus-within'), dragging: false };
  e.target.setPointerCapture(e.pointerId);
  turnNavHeld = true; showTurnNav();
});
$('turnNav').addEventListener('pointermove', e => {
  const pointer = turnNavPointer;
  if (!pointer || pointer.id !== e.pointerId) return;
  const dy = e.clientY - pointer.y;
  if (!pointer.dragging && Math.abs(dy) < 6) return;
  e.preventDefault();
  if (!pointer.dragging) {
    pointer.dragging = true;
    turnNavGesture();
    chatTouching = chatScrolling = true;
    suppressHistoryArm = true;
    layoutDirty = false;
    scrollCorrection = null;
    setScrollMode('programmatic');
    clearTimeout(scrollIdle);
  }
  pointer.progress = Math.max(0, Math.min(1, (pointer.top + dy) / pointer.travel));
  setChatScrollTop(pointer.progress * (list.scrollHeight - list.clientHeight));
  settleChatScroll();
});
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) $('turnNav').addEventListener(event, e => {
  const pointer = turnNavPointer;
  if (!pointer || pointer.id !== e.pointerId) return;
  turnNavSkipClick = event === 'pointerup' && (pointer.dragging || !pointer.opened);
  turnNavPointer = null; turnNavHeld = false;
  if (pointer.dragging) {
    chatTouching = false;
    setScrollMode(atBottom() ? 'followBottom' : 'freeScroll');
    historyPullUp = false;
    historyWheelPullUp = false;
    historyArmed = false;
    settleChatScroll();
    suppressHistoryArm = false;
    requestAnimationFrame(() => { if (!chatTouching) settleChatScroll(); });
  } else {
    suppressHistoryArm = false;
    if (deferredScrollRender) flushSettledChat();
  }
  updateTurnNav(); showTurnNav();
});
$('turnNav').addEventListener('click', e => {
  if (turnNavSkipClick) { e.preventDefault(); e.stopImmediatePropagation(); turnNavSkipClick = false; }
}, true);
$('turnNav').addEventListener('touchstart', e => {
  e.stopPropagation();
}, { passive: true });
function paintHistoryStatus() {
  if (pendingHistoryStatus === null) return;
  $('older').disabled = !!historyRequest;
  if (historyAtEnd) $('older').hidden = true;
  $('historyStatus').hidden = false;
  $('historyStatus').textContent = pendingHistoryStatus;
  pendingHistoryStatus = null;
}
function showHistoryStatus(message) {
  pendingHistoryStatus = I18N.tr(message);
  // A pending chat frame applies the notice and older rows under the same anchor.
  if (chatScrolling || chatTouching || chatFrame) return;
  paintHistoryStatus();
  restoreChatPosition(null);
}
function loadOlderMessages() {
  if (!lastChat || historyRequest) return;
  historyArmed = false;
  historyPullUp = false;
  historyWheelPullUp = false;
  if (!$('cachedMore').hidden) {
    historyScrollSnapshot = { top: list.scrollTop, height: list.scrollHeight };
    historyRendering = true;
    SC.show += 80;
    renderChat(lastChat);
    return;
  }
  requestOlderRemote();
}
// Asks the desktop for an older batch. Incoming chat renders remain anchored until scrolling settles.
function requestOlderRemote() {
  if (!lastChat || historyRequest) return;
  historyArmed = false;
  historyPullUp = false;
  historyWheelPullUp = false;
  if (historyAtEnd || $('older').hidden) {
    showHistoryStatus('已到最早消息');
    return;
  }
  if (currentApp === 'codex' && lastChat.busy) {
    historyWaitingForIdle = true;
    showHistoryStatus('生成中，稍后上滑加载历史');
    return;
  }
  historyScrollSnapshot = { top: list.scrollTop, height: list.scrollHeight };
  historyWaitingForIdle = false;
  historyRequest = { id: String(++historySerial), sel: viewSel };
  historyRendering = true;
  historyExpanded = true;
  showHistoryStatus('正在加载更早的消息…');
  send({ t: 'scrollChat', dy: -900, automatic: true, history: true, requestId: historyRequest.id });
}
function finishHistory(m) {
  if (!historyRequest || m.requestId !== historyRequest.id || m.sel !== historyRequest.sel) return;
  historyRequest = null;
  if (m.earlier === false) historyAtEnd = true;
  else if (m.earlier === true) historyAtEnd = false;
  if (m.error || m.blocked || m.earlier === false) historyScrollSnapshot = null;
  showHistoryStatus(m.error || (m.blocked ? '生成中，稍后上滑加载历史' : m.earlier === false && $('cachedMore').hidden ? '已到最早消息' : '继续上滑可加载更早的消息'));
  if (!deferredScrollRender) historyRendering = false;
  if (!deferredScrollRender && !chatFrame) completeTurnNavigation();
  maybePrefetchOlder();
}
function maybeLoadOlder() {
  if (historyArmed && list.scrollTop <= 1) {
    historyArmed = false;
    loadOlderMessages();
  }
}
function maybePrefetchOlder() {
  if (!chatTouching && !chatMomentum && !turnNavPointer?.dragging && !suppressHistoryArm && historyArmed && list.scrollTop <= 1 && !historyRequest && !deferredScrollRender && $('cachedMore').hidden && !historyAtEnd && !$('older').hidden) requestOlderRemote();
}
function resumeHistoryAfterIdle() {
  if (!historyWaitingForIdle || !lastChat || lastChat.busy || chatScrolling || chatTouching || historyRequest) return;
  if (list.scrollTop > 1) { historyWaitingForIdle = false; return; }
  historyWaitingForIdle = false;
  requestOlderRemote();
}
function flushSettledChat() {
  if (chatTouching) return;
  chatScrolling = false;
  chatMomentum = false;
  if (atBottom()) setScrollMode('followBottom');
  if (isFollowingBottom() && layoutDirty && !scrollCorrection) scrollCorrection = { kind: 'bottom' };
  if (deferredScrollRender && lastChat) {
    deferredScrollRender = false;
    layoutDirty = false;
    syncScrollFlush = true;
    try { renderChat(lastChat); } finally { syncScrollFlush = false; }
  } else if (pendingHistoryStatus !== null && !chatFrame) {
    paintHistoryStatus();
    restoreChatPosition(null);
  }
  if (layoutDirty && !isFollowingBottom() && !scrollCorrection) {
    layoutDirty = false;
  }
  if (scrollCorrection) reconcileChatScroll(true);
  maybeLoadOlder();
}
function settleChatScroll() {
  const top = list.scrollTop;
  if (restoringChatScroll) { lastScrollTop = top; updateToBottom(); return; }
  if (top < lastScrollTop && !chatTouching && !chatMomentum && !suppressHistoryArm && scrollMode !== 'programmatic' && (historyPullUp || historyWheelPullUp)) {
    historyArmed = true;
    setScrollMode('freeScroll');
  }
  lastScrollTop = top;
  if (!chatTouching && !chatMomentum && !deferredScrollRender) {
    if (atBottom()) setScrollMode('followBottom');
  }
  chatScrolling = true;
  clearTimeout(scrollIdle);
  scrollIdle = setTimeout(() => {
    if (chatTouching) return;
    // Scroll events can lag the compositor during momentum scrolling.
    if (list.scrollTop !== lastScrollTop) { settleChatScroll(); return; }
    flushSettledChat();
  }, chatMomentum ? 300 : 150);
  updateToBottom();
  maybePrefetchOlder();
}
list.addEventListener('scroll', () => {
  if (!restoringChatScroll && turnNavUser) showTurnNav();
  if (!suppressHistoryArm && !turnNavPointer?.dragging && (historyPullUp || historyWheelPullUp) && list.scrollTop <= 1) historyArmed = true;
  settleChatScroll();
}, { passive: true });
list.addEventListener('scrollend', () => {
  if (chatTouching || (!chatMomentum && !chatScrolling)) return;
  clearTimeout(scrollIdle);
  flushSettledChat();
}, { passive: true });
let historyTouchY = 0, historyPullUp = false, historyWheelPullUp = false;
list.addEventListener('wheel', e => {
  turnNavGesture();
  restoringChatScroll = false;
  if (e.deltaY < 0) { historyWheelPullUp = true; setScrollMode('freeScroll'); if (list.scrollTop <= 1) { historyArmed = true; settleChatScroll(); } }
  else if (e.deltaY > 0) { historyWheelPullUp = false; historyArmed = false; setScrollMode('freeScroll'); }
}, { passive: true });
list.addEventListener('touchstart', e => { historyTouchY = e.touches[0].clientY; historyPullUp = false; historyWheelPullUp = false; historyArmed = false; chatMomentum = false; chatTouching = true; chatScrolling = true; clearTimeout(scrollIdle); }, { passive: true });
list.addEventListener('touchmove', e => {
  turnNavGesture();
  restoringChatScroll = false;
  const y = e.touches[0].clientY, dy = y - historyTouchY;
  if (dy < 0) {
    historyPullUp = true;
    setScrollMode('freeScroll');
    if (list.scrollTop <= 1) historyArmed = true;
  } else if (dy > 0) {
    if (!atBottom()) setScrollMode('freeScroll');
  }
  historyTouchY = y;
}, { passive: true });
for (const event of ['touchend', 'touchcancel']) list.addEventListener(event, () => {
  chatMomentum = event === 'touchend';
  chatTouching = false;
  restoringChatScroll = false;
  if (historyPullUp && list.scrollTop <= 1) historyArmed = true;
  settleChatScroll();
}, { passive: true });
$('toBottom').onclick = () => {
  clearTimeout(scrollIdle);
  chatTouching = false;
  chatMomentum = false;
  chatScrolling = false;
  suppressHistoryArm = false;
  historyArmed = false;
  historyPullUp = false;
  historyWheelPullUp = false;
  layoutDirty = false;
  scrollCorrection = null;
  setScrollMode('followBottom');
  if (deferredScrollRender && lastChat) {
    deferredScrollRender = false;
    syncScrollFlush = true;
    try { renderChat(lastChat); } finally { syncScrollFlush = false; }
  }
  restoreChatPosition(null, true);
  updateToBottom();
};
$('older').onclick = () => loadOlderMessages();

// LaTeX in text typed by the user ($..$, $..$, \\(..\\), \\[..\\]): turned into .math placeholders for KaTeX.
const TEX_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$\d])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g;
function mathHtml(src) {
  let out = '', last = 0, any = false, m;
  TEX_RE.lastIndex = 0;
  while ((m = TEX_RE.exec(src))) {
    const block = m[1] != null || m[2] != null;
    const tex = (m[1] ?? m[2] ?? m[3] ?? m[4]).trim();
    out += esc(src.slice(last, m.index)) + (block
      ? `<div class="math" data-tex="${esc(tex)}">${esc(m[0])}</div>`
      : `<span class="math" data-tex="${esc(tex)}">${esc(m[0])}</span>`);
    last = m.index + m[0].length;
    any = true;
  }
  return { html: out + esc(src.slice(last)), any };
}
function updateMathPrev() {
  const box = $('mathPrev');
  const r = mode === 'terminal' ? { any: false } : mathHtml($('text').value);
  box.hidden = !r.any;
  if (!r.any) return;
  box.innerHTML = r.html;
  typesetMath(box);
}
addEventListener('load', () => typesetMath(document.body));
function typesetMath(root) {
  if (!root || !window.katex) return;
  root.querySelectorAll('.math[data-tex]').forEach(el => {
    if (el.dataset.typeset) return;
    try {
      window.katex.render(el.dataset.tex, el, { displayMode: el.tagName === 'DIV', throwOnError: false, output: 'html' });
      el.dataset.typeset = '1';
    } catch {}
  });
}
function dressMessage(el) {
  // Codex history may contain raw Markdown when its native rendered block is unmounted.
  // Format emphasis in text only; retain literal backticks/escapes and all existing rich markup.
  if (currentApp === 'codex' && el.textContent.includes('**')) {
    const raw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), nodes = [];
    while (raw.nextNode()) if (!raw.currentNode.parentElement.closest('a, pre, code, textarea, strong, b, .math')) nodes.push(raw.currentNode);
    let ticks = '';
    for (const node of nodes) {
      const fragment = document.createDocumentFragment();
      let last = 0;
      for (const match of node.textContent.matchAll(/\\[\\*`]|`+|\*\*(\S(?:[^\n]*?\S)?)\*\*(?!\*)/g)) {
        fragment.append(node.textContent.slice(last, match.index));
        if (match[0].startsWith('`')) { ticks = ticks === match[0] ? '' : ticks || match[0]; fragment.append(match[0]); }
        else if (match[1] && !ticks) { const strong = document.createElement('strong'); strong.textContent = match[1]; fragment.append(strong); }
        else fragment.append(match[0]);
        last = match.index + match[0].length;
      }
      fragment.append(node.textContent.slice(last));
      node.replaceWith(fragment);
    }
  }
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) if (!walker.currentNode.parentElement.closest('a, pre, code, textarea, .math')) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const parts = node.textContent.split(/(https?:\/\/[^\s<>"`]+)/g);
    if (parts.length === 1) continue;
    const fragment = document.createDocumentFragment();
    parts.forEach((part, i) => {
      if (i % 2 === 0) fragment.append(part);
      else {
        const url = part.replace(/[.,;!?，。；！？]+$/, '');
        const a = document.createElement('a'); a.href = url; a.textContent = url;
        fragment.append(a, part.slice(url.length));
      }
    });
    node.replaceWith(fragment);
  }

  el.querySelectorAll('.codebox').forEach(box => {
    if (box.querySelector('.copy')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy';
    btn.textContent = '复制';
    box.appendChild(btn);
    const url = blockText(box.querySelector('pre')).trim();
    if (/^https?:\/\/\S+$/i.test(url)) {
      const a = document.createElement('a'); a.href = url; a.textContent = '打开'; a.className = 'openLink'; box.append(a);
    }
  });
  el.querySelectorAll('code').forEach(code => {
    if (code.closest('pre') || code.dataset.file) return;
    const t = code.textContent.trim();
    if (/^https?:\/\/\S+$/i.test(t) && !code.closest('a')) {
      const a = document.createElement('a'); a.href = t; a.textContent = t; code.replaceChildren(a); return;
    }
    if (!code.closest('a') && /^[^\s`<>]+\.(?:png|jpe?g|gif|webp|svg|bmp)$/i.test(t)) {
      code.dataset.file = t;
      return;
    }
    if (t.length >= 8 || /\s/.test(t)) code.classList.add('copyable');
  });
  el.querySelectorAll('a[href]').forEach(a => { a.target = inApp ? '_self' : '_blank'; a.rel = 'noopener noreferrer'; });
  typesetMath(el);
}
window.addEventListener('load', () => typesetMath($('items')));
function blockText(pre) {
  const src = pre.parentElement?.querySelector('textarea.src');
  const raw = src ? src.value : pre.textContent;
  return raw.replace(/\u00a0/g, ' ').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/, '');
}
// Terminals treat CR as a new line. A lone LF is often ignored and the command collapses into one line.
function forTerminalPaste(text) {
  return text.replace(/\n/g, '\r\n');
}
const chatImageUrls = new Map();
function loadChatImages(root) {
  return Promise.all([...root.querySelectorAll('[data-chat-image], .sentImage img')].map(img => {
    const id = img.dataset.chatImage;
    if (!id) return img.decode().catch(() => {});
    const key = `${currentComputer()?.id}|${id}`;
    if (!chatImageUrls.has(key)) chatImageUrls.set(key, api('/api/chat-image/' + id).then(async response => {
      if (!response.ok) throw new Error('图片读取失败');
      return URL.createObjectURL(await response.blob());
    }));
    return chatImageUrls.get(key).then(async url => {
      img.src = url;
      img.parentElement.href = url;
      addImageCopyButtons(img.parentElement);
      await img.decode();
    }).catch(error => { img.alt = error.message; chatImageUrls.delete(key); });
  }));
}
function addImageCopyButtons(root) {
  for (const img of root.querySelectorAll('img')) {
    if (img.closest('.generatedImage') || !/^(https?:|data:image|blob:)/i.test(img.src)) continue;
    const target = img.parentElement?.tagName === 'A' ? img.parentElement : img;
    const wrap = document.createElement('div');
    wrap.className = 'generatedImage';
    target.replaceWith(wrap);
    wrap.appendChild(target);
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.copyImage = '';
    button.textContent = '复制图片';
    wrap.appendChild(button);
  }
}
async function copyGeneratedImage(img, btn) {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('浏览器不支持图片复制，请打开图片后保存');
    const png = (async () => {
      const response = await fetch(img.src);
      if (!response.ok) throw new Error('图片读取失败');
      const blob = await response.blob();
      if (blob.type === 'image/png') return blob;
      const url = URL.createObjectURL(blob);
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext('2d').drawImage(image, 0, 0);
        return await new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('图片转换失败')), 'image/png'));
      } finally { URL.revokeObjectURL(url); }
    })();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    btn.textContent = '已复制图片';
    setTimeout(() => { btn.textContent = '复制图片'; }, 1200);
  } catch (e) { status('复制图片失败：' + e.message); }
}
async function copyText(text, btn, terminal = true) {
  const payload = terminal ? forTerminalPaste(text) : text;
  try {
    await navigator.clipboard.writeText(payload);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = payload;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = old; }, 1200);
  } else status('已复制');
}
document.addEventListener('click', async e => {
  const imageCopy = e.target.closest('[data-copy-image]');
  if (imageCopy) { e.preventDefault(); await copyGeneratedImage(imageCopy.closest('.generatedImage').querySelector('img'), imageCopy); return; }
  const sentImage = e.target.closest('#items .sentImage');
  if (sentImage) {
    e.preventDefault();
    const img = sentImage.querySelector('img');
    if (img.complete && img.naturalWidth) openChatImage(img.currentSrc || img.src);
    return;
  }
  const copyBtn = e.target.closest('.copy');
  const copyCode = !copyBtn && !e.target.closest('a') && e.target.closest('code.copyable');
  if (copyBtn || copyCode) {
    e.preventDefault();
    const pre = copyBtn?.parentElement?.querySelector('pre');
    await copyText(pre ? blockText(pre) : copyCode.textContent, copyBtn);
    return;
  }
  const b = e.target.closest('button[data-item]');
  const f = !b && e.target.closest('#items [data-file]');
  if (f) return openFile(f.dataset.file);
  if (!b) return;
  if (currentApp === 'codex' && b.dataset.actionLabel === 'Copy message') {
    await copyText(b.closest('.msg').copyText, b, false);
    return;
  }
  if (RISKY.test(b.textContent.trim()) && !await ask(`确定要点「${b.textContent.trim()}」吗？`, b.textContent.trim())) return;
  b.closest('.btns')?.querySelectorAll('button').forEach(button => { button.disabled = true; });
  send({ t: 'click', item: b.dataset.item, n: Number(b.dataset.n), actionId: b.dataset.actionId, label: b.dataset.actionLabel, sel: viewSel });
  status('已点击：' + b.textContent);
});

$('pickMode').onclick = () => requestMenu('mode', '读取模式列表…');
$('pickModel').onclick = () => requestMenu('model', '读取模型列表…');
$('pickPerm').onclick = () => requestMenu('permission', '读取权限…');
function showCodexSkills(rows) {
  openSheet('skills', '<h3>Skill · 技能</h3><input id="skillSearch" placeholder="搜索技能" style="width:100%;box-sizing:border-box;margin-bottom:8px"><div id="skillRows"></div>');
  const paint = () => {
    const q = $('skillSearch').value.toLowerCase();
    $('skillRows').innerHTML = rows.map((r, n) => ({ r, n })).filter(({ r }) => (r.label + ' ' + r.sub).toLowerCase().includes(q)).map(({ r, n }) => `<button class="opt" data-skill="${n}"><span>${esc(r.label)}<small class="sub">${esc(r.sub)}</small></span></button>`).join('') || '<div class="mnHint">没有匹配的可用技能</div>';
  };
  $('skillSearch').oninput = paint;
  $('skillRows').onclick = e => {
    const b = e.target.closest('[data-skill]');
    if (!b) return;
    const r = rows[Number(b.dataset.skill)], token = '/' + r.label;
    closeSheet(); text.focus();
    text.setRangeText(token + ' ', text.selectionStart, text.selectionEnd, 'end');
    MN.mentions.push({ ...r, token, at: text.selectionStart - token.length - 1 });
    MN.value = text.value;
    autosize(); saveDraft();
  };
  paint();
}
let codexFileRequest = 0;
async function openCodexFilePicker(token) {
  const scope = chatInputKey(), selected = new Map();
  const start = token?.start ?? text.selectionStart, end = token?.end ?? token?.caret ?? text.selectionEnd;
  let directory = null;
  mentionHide();
  const paint = (note = '') => {
    const showHidden = store.get('codex-files-show-hidden') === '1';
    const rows = (directory?.entries || []).map((entry, index) => !showHidden && entry.name.startsWith('.') ? '' : entry.directory
      ? `<button class="opt editorEntry editorFolder" data-cf-dir="${index}">${fileEntryIcon(true)}<span class="lbl">${esc(entry.name)}</span><span class="editorEntryArrow">›</span></button>`
      : `<label class="opt editorEntry"><input type="checkbox" data-cf-file="${index}" ${selected.has(entry.path) ? 'checked' : ''} ${entry.selectable ? '' : 'disabled'}>${fileEntryIcon(false)}<span class="lbl">${esc(entry.name)}</span></label>`).join('');
    openSheet('codex-files', `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px"><h3 style="margin:0;white-space:nowrap">添加电脑端文件</h3><button type="button" id="codexFileHidden" role="switch" aria-checked="${showHidden}" style="display:flex;align-items:center;gap:6px;flex:none;font-size:12px;padding:6px 0;background:transparent"><span>显示隐藏文件</span><span class="switch${showHidden ? ' on' : ''}" aria-hidden="true"></span></button></div><form id="codexFilePathForm" style="display:flex;gap:8px"><button type="button" id="codexFileUp" ${!directory || directory.path === directory.parent ? 'disabled' : ''}>↑ 上一级</button><input id="codexFilePath" aria-label="电脑目录" style="min-width:0;flex:1" value="${esc(directory?.path || '')}" placeholder="输入电脑目录路径"><button>前往</button></form><div class="hint">${esc(note)}</div><div id="codexFileRows" style="max-height:42vh;overflow-y:auto;overscroll-behavior:contain">${rows || '<div class="hint">暂无可显示的文件</div>'}</div><div class="askBtns"><button id="codexFileCancel">取消</button><button id="codexFileAdd" ${selected.size ? '' : 'disabled'}>添加（${selected.size}）</button></div>`);
    $('codexFilePathForm').onsubmit = e => { e.preventDefault(); browse($('codexFilePath').value); };
    $('codexFileUp').onclick = () => browse(directory.parent);
    $('codexFileHidden').onclick = () => { store.set('codex-files-show-hidden', showHidden ? '0' : '1'); paint(note); };
    $('codexFileRows').onclick = e => {
      const b = e.target.closest('[data-cf-dir]');
      if (b) browse(directory.entries[Number(b.dataset.cfDir)].path);
    };
    $('codexFileRows').onchange = e => {
      const entry = directory.entries[Number(e.target.dataset.cfFile)];
      if (e.target.checked) selected.set(entry.path, entry); else selected.delete(entry.path);
      $('codexFileAdd').disabled = !selected.size;
      $('codexFileAdd').textContent = `添加（${selected.size}）`;
    };
    $('codexFileCancel').onclick = closeSheet;
    $('codexFileAdd').onclick = () => {
      if (scope !== chatInputKey()) { closeSheet(); return status('会话已切换，请重新选择文件', false); }
      if (takeMentions(text.value.slice(0, start) + text.value.slice(end)).length + selected.size > 12) return status('每条消息最多添加 12 个引用项', false);
      let at = start;
      const mentions = [...selected.values()].map(entry => {
        const token = '@' + entry.name;
        const mention = { token, q: entry.name, label: entry.name, path: entry.path, section: 'local-files', trigger: '@', at };
        at += token.length + 1;
        return mention;
      });
      text.setRangeText(mentions.map(m => m.token).join(' ') + (/\s/.test(text.value[end] || '') ? '' : ' '), start, end, 'end');
      MN.mentions.push(...mentions);
      MN.value = text.value;
      closeSheet(); autosize(); saveDraft(); text.focus();
    };
  };
  const browse = async path => {
    const serial = ++codexFileRequest;
    paint('正在读取电脑目录…');
    try {
      const response = await api('/api/transfer/list?path=' + encodeURIComponent(path));
      const data = await response.json();
      if (serial !== codexFileRequest || sheetKind !== 'codex-files') return;
      if (!response.ok) throw Error(data.error);
      directory = data;
      paint();
    } catch (error) { if (serial === codexFileRequest && sheetKind === 'codex-files') paint(error.message); }
  };
  await browse('');
}
$('add').onclick = () => {
  if (currentApp === 'fusion') {
    openSheet('add', '<h3>添加附件</h3><button class="opt" data-control="img">上传图片</button><button class="opt" data-control="uploadDoc">上传文档</button>');
    $('sheet').querySelectorAll('[data-control]').forEach(b => b.onclick = () => { closeSheet(); $(b.dataset.control).click(); });
    return;
  }
  const c = lastChat?.codex;
  if (!c) {
    const controls = ['newChat', 'pickMode', 'pickDir'].filter(id => !$(id).hidden);
    const editorRow = currentApp === 'devin'
      ? `<div class="pSec">电脑端 Devin 界面</div><button class="opt ${currentSurface === 'agent' ? 'cur' : ''}" data-native-surface="agent">Agent 界面</button><button class="opt ${currentSurface === 'editor' ? 'cur' : ''}" data-native-surface="editor">Editor 界面</button>${currentSurface === 'editor' ? '<button class="opt" data-editor-chat>打开聊天面板</button>' : ''}` : '';
    openSheet('add', '<h3>' + esc(currentAppName) + '</h3>' + editorRow + controls.map(id => `<button class="opt" data-control="${id}">${esc($(id).textContent)}</button>`).join(''));
    $('sheet').querySelectorAll('[data-control]').forEach(b => b.onclick = () => { closeSheet(); $(b.dataset.control).click(); });
    return;
  }
  const rows = [['new', '新建会话'], ['plan', `Plan：${c.plan ? '开' : '关'}`], ['skills', 'Skill · 技能'], ...(supportsCapability('fileReferences') ? [['local-files', '添加电脑端文件'], ['files', '引用文件']] : []), ['commands', '扩展与命令']];
  if (c.ide) rows.push(['ide', `IDE 上下文：${c.ide.on ? '开' : '关'}`]);
  if (c.run) rows.push(['run', `执行位置：${c.run}`]);
  if (c.actions) rows.push(['chat', '会话操作']);
  openSheet('add', '<h3>Codex</h3>' + rows.map(([key, label]) => `<button class="opt" data-add="${key}">${esc(label)}</button>`).join(''));
  $('sheet').querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
    closeSheet();
    const key = b.dataset.add;
    if (key === 'new') return $('newChat').click();
    if (key === 'plan') return send({ t: 'codexPlan' });
    if (key === 'ide') return send({ t: 'codexIde' });
    if (key === 'run') return send({ t: 'codexRun' });
    if (key === 'chat') return send({ t: 'codexChat' });
    if (key === 'skills') return send({ t: 'codexSkills' });
    if (key === 'local-files') return openCodexFilePicker();
    text.focus();
    text.setRangeText(key === 'files' ? '@' : '/', text.selectionStart, text.selectionEnd, 'end');
    autosize(); saveDraft(); mentionUpdate();
  });
};
$('pickPlan').onclick = () => { status('正在切换 Plan…'); send({ t: 'codexPlan' }); };
$('pickIde').onclick = () => send({ t: 'codexIde' });
$('pickRun').onclick = () => { status('读取执行位置…'); send({ t: 'codexRun' }); };
$('pickChat').onclick = () => { status('读取会话操作…'); send({ t: 'codexChat' }); };
$('pickAgents').onclick = () => openAgentList();
$('pickHistory').onclick = () => requestMenu('history', '读取历史对话…');
$('newChat').onclick = () => { status('正在新建对话…'); send({ t: 'newProjectChat' }); };

