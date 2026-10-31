// ---- local per-session history (Devin) ----
// The relay only remembers what it has seen since it started (and caps it), so the phone keeps its own copy of
// every row of every session: merged by item id, stored in IndexedDB, dropped only when the user clears it.
const SC = { key: null, items: new Map(), sig: new Map(), collapsed: new Set(), show: 400, dirty: false, timer: 0, cleared: false };
const SC_MAX = 8000;
const acpNum = id => { const m = /^acp(\d+)/.exec(id || ''); return m ? Number(m[1]) : -1; };
let scDbP = null;
const scPending = new Map(), scItemBytes = new WeakMap();
const scWriting = new Set(), scClears = new Set(), scVersions = new Map();
let scGeneration = 0;
const scVersion = key => `${scGeneration}:${scVersions.get(key) || 0}`;
const scClearing = key => [...scClears].some(clear => clear.key == null || clear.key === key);
function scTrackWrite(key, work) {
  const write = { key };
  write.promise = Promise.resolve(work).finally(() => scWriting.delete(write));
  scWriting.add(write);
  return write.promise;
}
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
const idbPut = (k, v) => scTrackWrite(k, scReq('readwrite', s => s.put(v, k)));
let chatPreviewTimer = 0, chatPreviewDirty = false, computerResumeDirty = false, computerResumeAt = 0;
const computerResumes = new Map();
const computerResumeReady = idbGet('computer-resumes').then(saved => {
  for (const [id, value] of saved?.entries || []) {
    if (loadComputers().some(c => c.id === id)) computerResumes.set(id, value);
  }
  if (saved && Date.now() - saved.at < 5 * 60 * 1000) ovRestoreComputers(saved);
});
function saveComputerResume(link) {
  if (computerSockets.get(link.computer.key) !== link || !link.auth?.resumeId || !computerBindingReady(link)) return;
  const foreground = link.socket === ws && !!link.receive;
  const { chat, ...binding } = link.binding;
  computerResumes.set(link.expectedId, {
    resumeId: link.auth.resumeId, binding,
    overview: ovSt.get(link.expectedId)?.data,
    offset: ovSt.get(link.expectedId)?.offset || 0,
  });
  if (!foreground) cacheChat(binding.sel, chat, link.expectedId);
  return saveComputerResumes();
}
function saveComputerResumes() {
  computerResumeDirty = true;
  computerResumeAt = Date.now();
  schedulePreviewSave();
}
const chatCacheKey = sel => `${currentComputer()?.id || ''}|${sel}`;
const chatPreviewGeneration = scGeneration, chatPreviewVersions = new Map(scVersions);
const chatPreviewReady = idbGet('chat-previews').then(entries => {
  let filtered = false;
  for (const [key, chat] of entries || []) {
    if (scGeneration !== chatPreviewGeneration || (scVersions.get(key) || 0) !== (chatPreviewVersions.get(key) || 0) || scClearing(key)) { filtered = true; continue; }
    if (!chatBySel.has(key)) lruPut(chatBySel, key, chat, 12);
  }
  if (filtered && chatBySel.size) saveChatPreview();
});
function chatTail(items, limit) {
  const start = Math.max(0, items.length - limit);
  const head = items.slice(0, start).findLast(it => it.k === 'human');
  return [...(head ? [head] : []), ...items.slice(start)];
}
function cacheChat(sel, chat, computer = currentComputer()?.id || '') {
  const key = `${computer}|${sel}`;
  const changed = chatBySel.get(key) !== chat;
  lruPut(chatBySel, key, chat, 12);
  if (key === SC.key) SC.cleared = false;
  if (changed) saveChatPreview();
}
function saveChatPreview() {
  chatPreviewDirty = true;
  schedulePreviewSave();
}
function schedulePreviewSave() {
  if (!chatPreviewTimer) chatPreviewTimer = setTimeout(function savePreview() {
    if (scClears.size || chatScrolling || chatTouching) { chatPreviewTimer = setTimeout(savePreview, 250); return; }
    flushPreviewSaves();
  }, 1000);
}
function flushPreviewSaves() {
  clearTimeout(chatPreviewTimer); chatPreviewTimer = 0;
  if (computerResumeDirty) {
    computerResumeDirty = false;
    const ids = new Set(loadComputers().map(c => c.id));
    for (const id of computerResumes.keys()) if (!ids.has(id)) computerResumes.delete(id);
    for (const [id, value] of computerResumes) value.folded = !!ovSt.get(id)?.folded && ovCollapsed.has(id);
    idbPut('computer-resumes', { at: computerResumeAt, entries: [...computerResumes], view: ovHistory() });
  }
  if (chatPreviewDirty && !scClears.size) {
    chatPreviewDirty = false;
    idbPut('chat-previews', [...chatBySel].map(([key, value]) => {
      const items = chatTail(value.items, 400);
      return [key, { ...value, items, earlier: items.length < value.items.length || value.earlier }];
    }));
  }
}
let chatFrame = 0, queuedChat = null, chatRenderEpoch = 0;
function invalidateChatRender() {
  chatRenderEpoch++;
  queuedChat = null;
  if (chatFrame) { cancelAnimationFrame(chatFrame); chatFrame = 0; }
}
function queueChatRender(chat = queuedChat?.chat || lastChat, stale = queuedChat?.stale ?? chatStale, sel = queuedChat?.sel || viewSel) {
  syncCodexAutoRetry(chat, stale, sel);
  queuedChat = { chat, stale, sel, epoch: chatRenderEpoch };
  if (!chatFrame) chatFrame = requestAnimationFrame(() => {
    chatFrame = 0;
    const next = queuedChat;
    queuedChat = null;
    if (next?.epoch === chatRenderEpoch && windowReady && (!next.sel || !viewSel || next.sel === viewSel)) {
      renderChat(next.chat, next.stale);
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
const scGet = async k => {
  const key = k.slice(2), version = scVersion(key);
  const pending = k.startsWith('h:') && scPending.get(k.slice(2));
  const n = nativeHist();
  const value = pending ? scSnapshot(pending) : scClearing(key) ? null
    : !n ? await idbGet(k) : parseJson(k.startsWith('h:') ? n.histGet(key) : n.histMeta(key));
  return version === scVersion(key) ? value : null;
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
    return scTrackWrite('h:' + key, n.histPut(key, json, JSON.stringify({ n: items.length, bytes: json.length, updated }), JSON.stringify(scIndex(items))));
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
    const key = mk.slice(2), version = scVersion(key), h = await idbGet('h:' + key);
    if (version === scVersion(key) && !scClearing(key) && h?.items && !n.histGet(key)) await scSave(key, h.items, h.collapsed || []);
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
    if (scClearing(key)) continue;
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
document.addEventListener('visibilitychange', () => { if (document.hidden) { scFlush(); scDrain(true); flushPreviewSaves(); } });
addEventListener('pagehide', () => { scFlush(); scDrain(true); flushPreviewSaves(); });
function scSwitch(sess) {
  scFlush();
  SC.key = sess ? scKeyFor(sess) : null;
  SC.items = new Map(); SC.sig = new Map(); SC.collapsed = new Set(); SC.show = 400; SC.cleared = false;
  const k = SC.key, version = scVersion(k);
  if (!k) return;
  scGet('h:' + k).then(v => {
    if (SC.key !== k || version !== scVersion(k) || !v || lastChat?.empty) return;
    for (const it of v.items || []) {
      const cur = SC.items.get(it.i);
      SC.items.set(it.i, cur ? scKeep(it, cur) : it);
    }
    for (const c of v.collapsed || []) SC.collapsed.add(c);
    if (lastChat) renderChat(lastChat, chatStale);
  });
}
// SC.show limits the initial tail. While reading, keep displayed rows as the tail grows;
// returning to the bottom can reclaim them. Folded turns stay in the data cache.
function scMerge(chat, retained = new Set()) {
  if (!SC.key) return { items: chat.items, all: chat.items, older: 0, stat: null };
  if (chat.empty && SC.items.size) {
    SC.items.clear(); SC.sig.clear(); SC.collapsed.clear(); scDirty();
  }
  let changed = false;
  for (const it of SC.cleared ? [] : chat.items) {
    const sig = JSON.stringify(it);
    if (SC.sig.get(it.i) === sig && SC.items.has(it.i)) continue;
    scItemBytes.set(it, sig.length);
    SC.sig.set(it.i, sig);
    SC.items.set(it.i, scKeep(SC.items.get(it.i), it));
    changed = true;
  }
  if (changed) scDirty();
  const all = [...(SC.cleared ? chat.items : SC.items.values())].sort((a, b) => (a.order ?? acpNum(a.i)) - (b.order ?? acpNum(b.i)));
  const stat = new Map(), turnOf = new Map();
  let turn = null;
  for (const it of all) {
    if (it.k === 'human') { turn = it.i; stat.set(turn, { n: 0, tools: 0 }); }
    else if (turn) { const s = stat.get(turn); s.n++; if (it.k === 'tool') s.tools++; }
    turnOf.set(it.i, turn);
  }
  let items = all.filter(it => it.k === 'human' || !SC.collapsed.has(turnOf.get(it.i)));
  let older = 0;
  if (items.length > SC.show) {
    const shown = new Set(chatTail(items, SC.show).map(it => String(it.i)));
    older = items.length;
    items = items.filter(it => shown.has(String(it.i)) || retained.has(String(it.i)));
    older -= items.length;
  }
  return { items, all, older, stat, turnOf };
}
function scFold(turn, to) {
  if (!SC.key) return;
  const want = to ?? !SC.collapsed.has(turn);
  if (turn === '*') {
    SC.collapsed = new Set(want ? [...(SC.cleared ? lastChat?.items || [] : SC.items.values())].filter(it => it.k === 'human').map(it => it.i) : []);
  } else if (want) SC.collapsed.add(turn); else SC.collapsed.delete(turn);
  scDirty();
  if (lastChat) renderChat(lastChat, chatStale, false, false);
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
  const clear = { key }, matches = value => key == null || value === key;
  scClears.add(clear);
  if (key == null) scGeneration++;
  else scVersions.set(key, (scVersions.get(key) || 0) + 1);
  clearTimeout(scDrainTimer); scDrainTimer = 0;
  if (scSaveFrame) { cancelAnimationFrame(scSaveFrame); scSaveFrame = 0; }
  clearTimeout(chatPreviewTimer); chatPreviewTimer = 0;
  chatPreviewDirty = false;
  for (const pending of scPending.keys()) if (matches(pending)) scPending.delete(pending);
  for (const cached of chatBySel.keys()) if (matches(cached)) chatBySel.delete(cached);
  for (const title of Object.keys(scTitles)) if (matches(title)) delete scTitles[title];
  store.set('scTitles', JSON.stringify(scTitles));
  if (matches(SC.key)) {
    clearTimeout(SC.timer); SC.timer = 0;
    SC.items = new Map(); SC.sig = new Map(); SC.collapsed = new Set(); SC.dirty = false; SC.cleared = true;
  }
  try {
    await Promise.all([...scWriting].filter(write => write.key === 'chat-previews' || matches(write.key.slice(2))).map(write => write.promise));
    const keys = key == null ? [...new Set([...(await scKeys() || []), ...(await idbKeys() || [])]
      .map(String).filter(k => k.startsWith('h:') || k.startsWith('m:')).map(k => k.slice(2)))] : [key];
    for (const session of keys) {
      await scDel('h:' + session); await scDel('m:' + session);
      if (nativeHist()) { await idbDel('h:' + session); await idbDel('m:' + session); }
    }
    await idbDel('chat-previews');
  } finally {
    scClears.delete(clear);
    if (chatBySel.size) saveChatPreview();
    else if (computerResumeDirty) schedulePreviewSave();
    scFlush(); scDrain();
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
let chatUserScroll = false, chatMotionFrame = 0, chatMotionOverflow = '';
let scrollMode = 'freeScroll', bottomFollowPending = false, scrollFrame = 0, historyPagePending = null;
let bottomScrollIntent = null, initialBottomSelection = null;
const readingExecutionRows = new Set();
let historyRequest = null, historyRendering = false, historyExpanded = false, historyArmed = false, historySerial = 0, historyAtEnd = false;
function clearHistoryRequest() {
  clearTimeout(historyRequest?.timer);
  historyRequest = null;
}
let historyCursor = null;
let pendingHistoryStatus = null;
let turnNavTimer = 0, turnNavHeld = false, turnNavUser = false, turnNavCursor = null, turnNavPending = null;
let turnNavPointer = null, turnNavSkipClick = false;
let restoringChatScroll = false;
let layoutDirty = false, syncScrollFlush = false, suppressHistoryArm = false;
function isFollowingBottom() { return scrollMode === 'followBottom'; }
function noteChatLayoutChange() {
  if (isFollowingBottom()) requestChatScroll();
}
function beginChatSelection() {
  cancelCodexAutoRetry();
  cancelChatMotion();
  restoringChatScroll = false;
  resetTurnNav();
  clearTimeout(scrollIdle);
  chatTouching = chatMomentum = chatScrolling = chatUserScroll = false;
  deferredScrollRender = deferredRender = false;
  bottomFollowPending = false; historyPagePending = null;
  bottomScrollIntent = null;
  readingExecutionRows.clear();
  initialBottomSelection = viewSel || null;
  setScrollMode('freeScroll');
}
function noteBottomScrollIntent(towardBottom) {
  initialBottomSelection = null;
  if (towardBottom && isFollowingBottom() && atBottom()) return;
  setScrollMode('freeScroll');
  bottomScrollIntent = towardBottom ? { sel: viewSel, top: chatScrollTop(), atBottom: atBottom() } : null;
}
function userReachedBottom() {
  const intent = bottomScrollIntent;
  if (!intent) return false;
  if (intent.sel !== viewSel) { bottomScrollIntent = null; return false; }
  return atBottom() && (intent.atBottom || chatScrollTop() > intent.top + 1);
}
function setScrollMode(next) {
  if (next === 'followBottom' && !atBottom()) return;
  scrollMode = next;
  if (next === 'followBottom') {
    bottomScrollIntent = null;
    if (readingExecutionRows.size) { readingExecutionRows.clear(); deferredScrollRender = true; }
    historyArmed = false;
    bottomFollowPending = false;
  }
  else {
    bottomFollowPending = false;
  }
}
function maxChatScrollTop() { return Math.max(0, list.scrollHeight - list.clientHeight); }
// Safari's bounce can report positions outside the actual scrollable range.
function chatScrollTop() { return Math.max(0, Math.min(maxChatScrollTop(), list.scrollTop)); }
function cancelChatMotion() {
  if (!chatMotionFrame) return;
  cancelAnimationFrame(chatMotionFrame);
  chatMotionFrame = 0;
  list.style.overflowY = chatMotionOverflow;
  if (scrollMode === 'programmatic') setScrollMode('freeScroll');
}
function stopChatMotion(jump) {
  initialBottomSelection = null;
  bottomScrollIntent = null;
  restoringChatScroll = false;
  if (readingExecutionRows.size) { readingExecutionRows.clear(); deferredScrollRender = true; }
  if (chatMotionFrame) cancelAnimationFrame(chatMotionFrame);
  else chatMotionOverflow = list.style.overflowY;
  // Keep the native scroller disabled for one paint, so its inertia cannot undo an explicit jump.
  list.style.overflowY = 'hidden';
  void list.offsetHeight;
  chatMotionFrame = requestAnimationFrame(() => {
    chatMotionFrame = requestAnimationFrame(() => {
      if (jump) jump();
      chatMotionFrame = requestAnimationFrame(() => {
        list.style.overflowY = chatMotionOverflow;
        chatMotionFrame = 0;
        applyPendingHistory();
      });
    });
  });
  clearTimeout(scrollIdle);
  if (scrollFrame) { cancelAnimationFrame(scrollFrame); scrollFrame = 0; }
  chatTouching = chatMomentum = chatScrolling = chatUserScroll = false;
  bottomFollowPending = false;
  historyArmed = historyPullUp = historyWheelPullUp = false;
  turnNavPending = null;
  layoutDirty = false;
  setScrollMode('programmatic');
}
function setChatScrollTop(next) {
  next = Math.max(0, Math.min(maxChatScrollTop(), next));
  if (Math.abs(list.scrollTop - next) < 1) return false;
  bottomScrollIntent = null;
  restoringChatScroll = true;
  list.scrollTop = next;
  updateToBottom();
  return true;
}
function applyBottomFollow() {
  if (!bottomFollowPending) return false;
  if (chatTouching || chatMomentum || chatScrolling || turnNavPointer?.dragging) {
    layoutDirty = true;
    return false;
  }
  bottomFollowPending = false;
  if (scrollMode === 'followBottom') setChatScrollTop(maxChatScrollTop());
  layoutDirty = false;
  updateTurnNav();
  return true;
}
function reconcileBottomFollow(sync = false) {
  if (sync) {
    if (scrollFrame) { cancelAnimationFrame(scrollFrame); scrollFrame = 0; }
    applyBottomFollow();
    return;
  }
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    applyBottomFollow();
  });
}
function requestChatScroll(sync = false) {
  if (!isFollowingBottom()) return;
  bottomFollowPending = true;
  reconcileBottomFollow(sync);
}
function restoreChatPosition(stick = false) {
  if (scrollMode === 'programmatic') return;
  if (stick && isFollowingBottom()) requestChatScroll();
}
const chatSizeObserver = new ResizeObserver(() => {
  if (chatTouching || chatMomentum || chatScrolling || turnNavPointer?.dragging || syncScrollFlush) {
    layoutDirty = true;
    return;
  }
  if (isFollowingBottom()) { requestChatScroll(true); return; }
  layoutDirty = false;
});
for (const el of [list, itemsEl, $('older'), $('historyStatus'), $('cachedMore')]) chatSizeObserver.observe(el);
document.addEventListener('selectionchange', () => {
  if (deferredRender && !userSelecting()) { deferredRender = false; if (lastChat) renderChat(lastChat, chatStale); }
  applyPendingHistory();
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
  const queued = chat?.queued || [];
  const claimedQueue = new Set();
  pendingEchoes = pendingEchoes.filter(p => {
    // A send that vanished with a dead socket would otherwise spin "发送中…" forever.
    if (!p.confirmed && Date.now() - p.at > 120000) return false;
    if (p.sel !== viewSel) return true;
    if (p.messageId && humans.some(it => it.i === p.messageId)) return false;
    p.represented = false;
    if (p.kind === 'queue' || p.queueId) {
      const index = p.confirmed ? queued.findIndex((q, n) => !claimedQueue.has(n) && (p.queueId && currentApp !== 'devin' ? q.id === p.queueId : echoTextMatches(q, p.text))) : -1;
      if (index >= 0) {
        claimedQueue.add(index);
        p.queueId = queued[index].id;
        p.kind = 'queue';
        if (queued[index].t) {
          p.text = queued[index].t;
          const receipt = submittedMessages.find(row => row.requestId === p.requestId);
          if (receipt) receipt.text = p.text;
        }
        p.represented = true;
        p.syncing = false;
      } else if (p.confirmed) {
        p.syncing = true;
        if (p.queueId) p.kind = 'chat';
      }
    }
    return true;
  });
}
function pendingEchoEls() {
  return pendingEchoes.filter(p => p.kind === 'chat' && p.sel === viewSel).map(p => {
    const el = document.createElement('div');
    el.className = 'msg human pending';
    el.innerHTML = `<div class="humanContent"><div class="bubble">${esc(p.text)}</div><div class="messageMeta">${I18N.tr(p.syncing ? '正在同步…' : p.confirmed ? '已发送' : p.unknown ? '发送结果待确认' : '发送中…')}</div></div>`;
    return el;
  });
}
const executionRecordsShown = () => store.get('show-execution-' + currentApp) === '1';
function executionRecord(it) {
  return it.k === 'tool' && (it.execution || ['command', 'read', 'search', 'explore'].includes(it.kind)
    || String(it.i).includes(':exec:'));
}
function visibleChatItems(items, busy, retained = new Set()) {
  const shown = executionRecordsShown();
  const latestTurn = busy ? Math.max(0, items.findLastIndex(it => it.k === 'human')) : items.length;
  return items.filter((it, n) => {
    if (it.k === 'tool' && retained.has(String(it.i))) return true;
    if (!executionRecord(it)) return !(it.k === 'tool' && it.done);
    const attention = it.keep || it.b?.some(b => /^(?:run(?! in background)|allow|approve|reject|deny|retry|confirm|continue|accept)\b|^(?:运行|允许|批准|拒绝|重试|确认|继续|接受)/i.test(b))
      || /(?:^|\n)\s*(?:error\b|failed\b|permission denied\b|(?:(?:process|command) )?exit(?:ed)?(?: with)? code[: ]+[1-9]\d*|错误|失败|拒绝)/i.test([it.t, it.output].filter(Boolean).join('\n'));
    return shown || attention || (!it.done && n >= latestTurn);
  });
}
function toggleExecutionRecords() {
  store.set('show-execution-' + currentApp, executionRecordsShown() ? '0' : '1');
  renderChat(lastChat, chatStale, false, false);
  showMainMenu();
}
function renderChat(chat, stale, loading = false, keepReading = true, historyInsertion = false) {
  if (chat) reconcileSent(chat);
  chat = withMessageTimes(chat);
  rememberChatMessageTime(chat);
  pruneEchoes(chat);
  updateGenerationTime(chat, stale);
  const previousStale = chatStale;
  chatStale = !!stale;
  if (chat?.items?.some(it => it.k === 'human')) $('sessionNotice').hidden = true;
  rememberInputHistory(chat);
  const previous = lastChat;
  if (chat && previous?.thread === chat.thread && (previous.model !== chat.model || previous.effort !== chat.effort)) {
    menuCache.delete(menuCacheKey('model'));
    menuCache.delete(menuCacheKey('effort'));
  }
  const threadChanged = !chat || previous?.thread !== chat.thread;
  if (threadChanged) {
    historyCursor = null;
    readingExecutionRows.clear();
    clearHistoryRequest(); historyRendering = false; historyExpanded = false; historyArmed = false; historyAtEnd = false; chatUserScroll = false; bottomScrollIntent = null; bottomFollowPending = false; historyPagePending = null; layoutDirty = false; syncScrollFlush = false; pendingHistoryStatus = null;
    $('older').disabled = false;
    $('historyStatus').hidden = true;
  }
  if (chat && !historyExpanded && Number.isFinite(chat.historyBefore)) historyCursor = chat.historyBefore;
  if (chat?.earlier === true && (currentApp !== 'codex' || !historyExpanded)) historyAtEnd = false;
  const paged = currentApp === 'codex' && Number.isFinite(chat?.historyBefore) && !stale && !previousStale;
  if (chat && previous?.thread === chat.thread && (historyExpanded || paged) && currentApp !== 'devin') {
    const updates = new Map(chat.items.map(it => [it.i, it]));
    const bodies = previous.items.flatMap(item => {
      if (updates.has(item.i)) return [updates.get(item.i)];
      if (paged && item.syntheticCapacity && chat.capacityPresent === false) return [];
      if (paged && item.capacity) { const { b, actions, btnItem, ...body } = item; return [body]; }
      if (paged && !chat.busy && item.k === 'thinking' && item.live) return [{ ...item, live: false }];
      return [item];
    });
    const rows = historyRequest ? [...chat.items, ...bodies] : [...bodies, ...chat.items];
    let merged = [...new Map(rows.map(it => [it.i, updates.get(it.i) || it])).values()];
    if (merged.every(it => Number.isFinite(it.order))) merged.sort((a, b) => a.order - b.order);
    if (paged && !historyExpanded) {
      const keep = new Set(chatTail(merged, 400).map(item => String(item.i)));
      if (!followingChat()) for (const el of itemsEl.children) keep.add(el.dataset.i);
      merged = merged.filter(item => keep.has(String(item.i)));
    }
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
  const followBottom = followingChat();
  const existing = new Set([...itemsEl.children].map(el => el.dataset.i));
  const restoreInsertion = !followBottom && !threadChanged && scrollMode === 'freeScroll'
    && historyInsertion
    ? historyInsertionPosition() : null;
  noteChatLayoutChange();
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
  const keepViewport = keepReading && !followBottom && !threadChanged && !sessionChanged && !historyInsertion && scrollMode === 'freeScroll';
  const V = scMerge(chat, keepViewport ? existing : new Set());
  if (keepViewport && V.items.length > SC.show + 1) deferredScrollRender = true;
  if (!sessionChanged && userSelecting()) {
    deferredRender = true;
    $('actionBar').innerHTML = buttonsHtml(chat.global, 'g');
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
  const stick = followBottom;
  if (keepReading && !threadChanged && !sessionChanged && scrollMode === 'freeScroll') {
    for (const el of itemsEl.children) if (el.classList.contains('tool')) readingExecutionRows.add(el.dataset.i);
  } else readingExecutionRows.clear();
  const edge = list.getBoundingClientRect().bottom;
  const readingEnd = keepViewport ? V.items.findLastIndex(it => {
    const el = cache.get(it.i)?.el;
    return el?.isConnected && el.getBoundingClientRect().top < edge;
  }) : -1;
  const readingRows = new Set(V.items.slice(0, readingEnd + 1).map(it => String(it.i)));
  const visibleItems = visibleChatItems(V.items, chat.busy, readingExecutionRows).filter(it => {
    if (!readingRows.has(String(it.i)) || existing.has(String(it.i))) return true;
    deferredScrollRender = true;
    return false;
  });
  const visibleIds = new Set(visibleItems.map(it => String(it.i)));
  for (const id of readingExecutionRows) if (!visibleIds.has(id)) readingExecutionRows.delete(id);
  const els = visibleItems.map(it => {
    const key = JSON.stringify(it);
    const hit = cache.get(it.i);
    if (hit && hit.key === key) return hit.el;
    const { b, actions, btnItem, live, agents, ...body } = it;
    const bodyKey = JSON.stringify([body, thoughtFull.get(it.i)]);
    if (hit?.bodyKey === bodyKey && hit.key !== null) {
      paintItemActions(hit.el, it);
      hit.key = key;
      return hit.el;
    }
    if (keepViewport && hit?.el.isConnected && !hit.refresh && hit.el.getBoundingClientRect().top < edge) {
      paintItemActions(hit.el, it);
      deferredScrollRender = true;
      return hit.el;
    }
    if (it.k === 'thinking' && hit?.el) {
      paintThinking(hit.el, it);
      paintItemActions(hit.el, it);
      cache.set(it.i, { key, bodyKey, el: hit.el });
      return hit.el;
    }
    const el = renderItem(it);
    if (it.k === 'tool' && it.kind === 'command' && hit?.el.classList.contains('toolrow') && patchToolRow(hit.el, el)) {
      cache.set(it.i, { key, bodyKey, el: hit.el });
      return hit.el;
    }
    if (it.k === 'tool' && hit?.el.classList.contains('toolrow')) {
      const open = hit.el.classList.contains('open');
      el.classList.toggle('open', open);
      const chev = el.querySelector('.chev');
      if (chev) chev.textContent = open ? '▾' : '▸';
    }
    el.dataset.i = it.i;
    cache.set(it.i, { key, bodyKey, el });
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
    if (keepViewport) visibleItems.forEach((it, n) => {
      if (existing.has(String(it.i)) && els[n].querySelector(':scope > .endFold') && els[n].getBoundingClientRect().top < edge)
        last.set(V.turnOf.get(it.i), n);
    });
    const keep = new Set(last.values());
    visibleItems.forEach((it, n) => {
      const el = els[n];
      let b = el.querySelector(':scope > .endFold');
      if (keepViewport && existing.has(String(it.i)) && el.getBoundingClientRect().top < edge) return;
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
  itemsEl.classList.toggle('stale', chatStale);
  latestTasks = (chat.items || []).filter(it => it.k === 'tasks').pop() || null;
  $('taskChip').hidden = !latestTasks || (latestTasks.done >= latestTasks.total && !chat.busy);
  if (latestTasks) $('taskChip').innerHTML = `<span>${I18N.tr('任务')}</span> ${latestTasks.done}/${latestTasks.total}`;
  if (sheetKind === 'tasks') showTasks();
  const live = new Set(V.items.map(it => it.i));
  for (const k of cache.keys()) if (!live.has(k)) { thoughtObserver.unobserve(cache.get(k).el); cache.delete(k); }

  // A cached render is display-only: no action buttons, questions or queue actions until the fresh chat arrives.
  $('actionBar').innerHTML = chatStale ? '' : buttonsHtml(chat.global, 'g');
  $('actionBar').classList.toggle('show', !chatStale && chat.global.length > 0);
  renderQueue(chatStale ? false : chat.busy, chatStale ? [] : (chat.queued || []), chat.subagents || [], chat.readonly, chat.changed, chat.queuedCount);
  renderQuestions(chatStale || (chat.readonly && !chat.questions?.codex) ? null : chat.questions);

  paintHistoryStatus(!!restoreInsertion);
  restoreInsertion?.();
  restoreChatPosition(stick);
  historyRendering = false;
  if (!stick && previous && JSON.stringify(previous.items) !== JSON.stringify(chat.items)) $('toBottom').textContent = '↓ 有新消息';
  updateToBottom();
  if (initialBottomSelection === viewSel && !chatStale && !loading && chat.items.length) {
    setChatScrollTop(maxChatScrollTop());
    setScrollMode('followBottom');
    initialBottomSelection = null;
    updateToBottom();
  }
  noteSwitch(chat);
  if (SC.jump && SC.items.has(SC.jump)) { const j = SC.jump; SC.jump = null; scJump(j); }
  completeTurnNavigation();
  applyPendingHistory();
  if ((!stale || chat.imagePreview) && !loading && windowReady && liveChatSelection === viewSel) {
    if (!chat.readonly) rememberConversation();
    connContentReady();
  }
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
  if (compose) {
    setQuestionCompose(compose.dataset.questionCompose);
    if (portraitComposer()) setComposerFold(false);
    text.focus();
    return;
  }
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
const questionCard = (head, body, open) => `<details class="qnCard" ${open ? 'open' : ''}><summary class="qnHead"><span class="qnHeading">${head}</span><svg class="arrowIcon qnFold" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary><div class="qnBody">${body}</div></details>`;
function questionBusy() {
  const bar = $('qnBar');
  bar.setAttribute('aria-busy', String(!!qnPending));
  if (qnPending) bar.querySelectorAll('button,input,select').forEach(el => { el.disabled = true; });
  updateComposeCompact();
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
  questionCompose = id ? { id, sel: viewSel } : null;
  restoreDraft();
  updateAppText();
  updateSendMode();
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
  const request = qnState?.requests?.find(r => r.id === pending.message.id);
  if (pending.message.id && !request) {
    qnSig = '';
    renderQuestions(qnState);
    finishPending(['正在提交回答…']);
    return;
  }
  if (m.ok && request) {
    const answerKey = [currentComputer()?.id || '', viewSel, 'chat', pending.message.id].join('|');
    drafts.delete(answerKey); draftMentions.delete(answerKey);
    if (pending.message.id.startsWith('async:') && (pending.message.advance || pending.message.n === request.buttons.length - 1)) {
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
  const keys = value => value?.codex ? value.requests.map(r => r.id)
    : (value?.list || []).map(q => JSON.stringify([!!value.devin, value.pager?.cur, q.text]));
  const known = new Set(keys(qnState));
  const open = qnView !== viewSel || keys(qs).some(key => !known.has(key)) || bar.querySelector('.qnCard')?.open !== false;
  if (qnView !== viewSel) { qnView = viewSel; qnSig = ''; qnPending = null; qnDrafts.clear(); }
  if (qnPending && (qnPending.message.id ? !qs?.requests?.some(r => r.id === qnPending.message.id) : !qs?.list?.length)) {
    qnPending = null;
    finishPending(['正在提交回答…']);
    questionBusy();
  }
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
    const expanded = new Set([...bar.querySelectorAll('.qnDetails[open]')].map(el => el.dataset.question));
    bar.innerHTML = questionCard(`Codex 等待你${qs.requests.some(r => r.id.startsWith('approval:')) ? '审批' : '回答'}<span class="qnCount">${qs.requests.length} 个请求</span>`, qs.requests.map(r => {
      const lines = r.text.trim().split('\n'), heading = lines.shift();
      const remaining = lines.join('\n').trim();
      return `<section class="qnRequest"><div class="qnQ">${esc(heading)}</div>`
      + (remaining ? `<details class="qnDetails" data-question="${esc(r.id)}" ${expanded.has(r.id) ? 'open' : ''}><summary>展开问题详情</summary>${esc(remaining)}</details>` : '')
      + (r.id.startsWith('async:') ? `<div class="qnOpts">${r.buttons.slice(0, -2).map((b, n) => `<button class="qnOpt ${b.selected ? 'on' : ''}" data-request="${esc(r.id)}" data-action="${n}" aria-pressed="${!!b.selected}" ${b.disabled ? 'disabled' : ''}>${esc(b.label)}</button>`).join('')}</div>` : '')
      + r.fields.map((f, n) => `<label class="qnFree">${esc(f.label)}${f.options ? `<select data-request="${esc(r.id)}" data-field="${n}">${f.options.map(o => `<option value="${esc(o.value)}" ${o.value === f.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>` : `<input data-request="${esc(r.id)}" data-field="${n}" type="${f.type === 'password' ? 'password' : 'text'}" value="${esc(f.value)}">`}</label>`).join('')
      + `<div class="qnAct">${r.id.startsWith('async:') ? `<button data-question-compose="${esc(r.id)}">在对话框回答</button>` : ''}${r.buttons.map((b, n) => r.id.startsWith('async:') && n < r.buttons.length - 2 ? '' : `<button data-request="${esc(r.id)}" data-action="${n}" aria-pressed="${!!b.selected}" ${b.disabled ? 'disabled' : ''}>${esc(b.label)}</button>`).join('')}</div></section>`; }).join(''), open);
    bar.classList.toggle('show', qs.requests.length > 0);
    bar.querySelectorAll('[data-field]').forEach(el => {
      const key = questionFieldKey(el);
      if (qnDrafts.has(key)) el.value = qnDrafts.get(key);
      el.oninput = () => {
        qnDrafts.set(key, el.value);
        const r = qnState.requests.find(r => r.id === el.dataset.request);
        if (r.id.startsWith('async:') && !r.buttons.every(b => b.disabled) && !qnPending) {
          const submit = [...bar.querySelectorAll('[data-action]')].find(b => b.dataset.request === r.id && Number(b.dataset.action) === r.buttons.length - 1);
          submit.disabled = !el.value.trim();
        }
      };
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
  if (!qs?.list?.length) { bar.innerHTML = ''; bar.classList.remove('show'); updateComposeCompact(); return; }
  if (qs.devin) {
    const q = qs.list[0], pg = qs.pager;
    bar.innerHTML = questionCard(`Devin 在问你<span class="qnCount">${pg ? `${pg.cur}/${pg.total}` : '1 个问题'}</span>`,
      (pg && pg.total > 1 ? `<div class="qnPg"><button data-qpart="prev" ${qs.canPrev ? '' : 'disabled'}>‹</button><button data-qpart="next" ${qs.canNext ? '' : 'disabled'}>›</button></div>` : '')
      + `<div class="qnQ">${esc(q.text)}</div><div class="qnOpts">`
      + q.options.map((o, oi) => `<button class="qnOpt ${o.sel ? 'on' : ''}" data-qi="0" data-oi="${oi}"><b>${q.multi ? (o.sel ? '☑' : '☐') : String.fromCharCode(65 + oi)}</b><span>${esc(o.label)}${o.desc ? `<small>${esc(o.desc)}</small>` : ''}</span></button>`).join('')
      + `</div><div class="qnHint">想自己回答？直接在下方输入框写</div>`
      + `<div class="qnAct"><button data-qpart="skip">跳过</button>${qs.hasSubmit ? `<button class="primary" data-qpart="submit" ${qs.canSubmit ? '' : 'disabled'}>提交</button>` : ''}</div>`, open);
    bar.classList.add('show');
    questionBusy();
    return;
  }
  bar.innerHTML = questionCard(`Agent 在问你<span class="qnCount">${qs.list.length} 个问题</span>`,
    qs.list.map((q, qi) => `<div class="qnQ">${qs.list.length > 1 ? `${qi + 1}. ` : ''}${esc(q.text)}</div><div class="qnOpts">`
      + q.options.map((o, oi) => {
        const letter = String.fromCharCode(65 + oi);
        return o.free
          ? `<div class="qnFree ${o.sel ? 'on' : ''}"><input data-qi="${qi}" data-oi="${oi}" placeholder="其他…" value="${esc(o.value)}" enterkeyhint="done"><button data-qfree="${qi}:${oi}">填入</button></div>`
          : `<button class="qnOpt ${o.sel ? 'on' : ''}" data-qi="${qi}" data-oi="${oi}"><b>${letter}</b><span>${esc(o.label)}</span></button>`;
      }).join('') + '</div>').join('')
    + `<div class="qnAct"><button data-qpart="skip">跳过</button><button class="primary" data-qpart="submit" ${qs.canSubmit ? '' : 'disabled'}>提交</button></div>`, open);
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
function queuedMessages(queued = chatStale ? [] : lastChat?.queued || [], qCount = chatStale ? 0 : lastChat?.queuedCount) {
  const devin = currentApp === 'devin';
  const pending = pendingEchoes.filter(p => p.kind === 'queue' && p.sel === viewSel && !p.represented);
  const nativeCount = Math.max(queued.length, devin ? qCount || 0 : 0);
  const count = queued.length ? nativeCount + pending.length : Math.max(nativeCount, pending.length);
  return { count, pending, queued, devin };
}
function queuedMessagesHtml({ count, pending, queued, devin }) {
  return pending.map(p => `<div class="q pending"><span class="qt">${esc(p.text)}</span><span class="sub">${I18N.tr(p.syncing ? '正在同步…' : p.confirmed ? '已排队' : p.unknown ? '发送结果待确认' : '发送中…')}</span></div>`).join('')
    + queued.map(q => `<div class="q"><span class="qt">${esc(q.t || '(空)')}</span>`
      + (supportsCapability('queueEdit') ? ibtn('edit', devin ? '从队列取出，放回输入框' : '修改', `data-q="${esc(q.id)}" data-a="edit"`) : '')
      + ibtn('enter', '打断当前这一轮，立刻发送', `data-q="${esc(q.id)}" data-a="send"`)
      + ibtn('x', '删除', `data-q="${esc(q.id)}" data-a="remove"`, 'del') + '</div>').join('')
    + (count && devin && !queued.length ? `<div class="q"><span class="qt">内容读不到，只显示数量</span></div>` : '');
}
const queueClearButton = queue => queue.devin ? ibtn('trash', '清空', 'data-a="clear" data-q=""', 'del') : '';
function renderQueuedList(queue) {
  const html = `<div class="qhRow"><span class="qh">排队中 ${queue.count} 条</span>${queue.count ? queueClearButton(queue) : ''}</div>`
    + (queue.count ? queuedMessagesHtml(queue) : `<div class="hint">${I18N.tr('(空)')}</div>`);
  if ($('queueList').innerHTML !== html) $('queueList').innerHTML = html;
}
function showQueuedMessages() {
  openSheet('queued', '<h3>排队</h3><div id="queueList"></div>');
  $('queueList').onclick = $('queueBar').onclick;
  renderQueuedList(queuedMessages());
}
function renderQueue(busy, queued, subs = [], readonly = false, changed = 0, qCount = 0) {
  const bar = $('queueBar'), queue = queuedMessages(queued, qCount);
  let html = '';
  if (readonly && !chatStale && lastChat?.subagent) html += `<div class="run sub"><span>正在查看子 Agent 的对话（只读）</span>${ibtn('back', '返回主对话', 'data-main')}</div>`;
  if (subs.length && !readonly) {
    html += `<button class="qh fold" data-fold>${subsOpen ? '▾' : '▸'} <span>子 Agent 运行中 ${subs.length} 个</span></button>`;
    if (subsOpen) html += subs.map(n => `<div class="q"><span class="qt sa">${esc(n)}</span>`
      + ibtn('eye', '查看', `data-sub="${esc(n)}" data-part="open"`) + ibtn('stop', '停止', `data-sub="${esc(n)}" data-part="stop"`, 'del') + '</div>').join('');
  }
  if (queue.count) {
    html += `<div class="qhRow"><button class="qh fold" data-qfold aria-expanded="${queueOpen}">${queueOpen ? '▾' : '▸'} <span>排队中 ${queue.count} 条</span></button>${queueClearButton(queue)}</div>`;
    if (queueOpen) html += queuedMessagesHtml(queue);
  }
  if (changed && !readonly && !hiddenChangeNotices.has(changeNoticeKey())) html += `<div class="changesNotice"><button class="qh fold" data-changes>改动了 ${changed} 个文件 ›</button>${ibtn('x', '隐藏改动提示', 'data-toggle-changes')}</div>`;
  bar.innerHTML = html;
  bar.classList.toggle('show', Boolean(html));
  if (sheetKind === 'queued') renderQueuedList(queue);
  if (document.body.classList.contains('kb')) fitViewport();
  document.dispatchEvent(new Event('composer-state'));
}

let queueEditRequest = null;
function sendQueueAction(id, action, text, requestId) {
  const echoes = pendingEchoes.filter(p => p.sel === viewSel && (action === 'clear'
    ? p.kind === 'queue' || p.represented : p.represented && p.queueId === id)).map(p => p.requestId);
  return send({ t: 'queue', id, action, text, requestId, echoes });
}
function editQueued(id) {
  const q = (lastChat?.queued || []).find(x => x.id === id);
  if (!q) return status('这条排队消息已经不在了', false);
  if (currentApp === 'devin') { status('正在取出…'); return sendQueueAction(id, 'edit'); }
  const edit = queueEditRequest = { id, sel: viewSel, requestId: crypto.randomUUID(), action: 'read' };
  openSheet('queueEdit', `<h3>修改排队消息</h3>
    <textarea id="qEdit" disabled style="width:100%;box-sizing:border-box;min-height:120px;max-height:50dvh;margin-bottom:10px"></textarea>
    <div id="qError" role="status">正在读取完整内容…</div>
    <button class="opt" id="qSave" disabled style="justify-content:center;background:var(--accent);border-color:var(--accent-b);color:#fff;font-weight:600">保存（仍在排队）</button>`);
  $('qSave').onclick = () => {
    if (edit.action === 'read') {
      edit.requestId = crypto.randomUUID(); $('qSave').disabled = true;
      $('qError').textContent = '正在读取完整内容…';
      if (!sendQueueAction(id, 'read', undefined, edit.requestId)) receiveQueueEdit({ ...edit, ok: false, error: '连接已断开，请重试' });
      return;
    }
    const v = $('qEdit').value;
    if (!v.trim()) return status('内容不能为空；不想要这条就点「删除」', false);
    edit.requestId = crypto.randomUUID(); edit.action = 'edit';
    $('qSave').disabled = true; $('qEdit').disabled = true; $('qError').textContent = '正在保存…';
    if (!sendQueueAction(id, 'edit', v, edit.requestId)) receiveQueueEdit({ ...edit, ok: false, error: '连接已断开，内容已保留' });
    status('正在修改排队消息…');
  };
  if (!sendQueueAction(id, 'read', undefined, edit.requestId)) receiveQueueEdit({ ...edit, ok: false, error: '连接已断开，请重试' });
}
function receiveQueueEdit(m) {
  const edit = queueEditRequest;
  if (!edit || sheetKind !== 'queueEdit' || edit.sel !== viewSel || m.sel !== edit.sel || m.requestId !== edit.requestId) return;
  if (!m.ok) {
    $('qError').textContent = m.error || '操作未完成，内容已保留';
    $('qSave').disabled = false;
    $('qEdit').disabled = edit.action === 'read';
    if (edit.action === 'read') $('qSave').textContent = '重新读取';
    return;
  }
  if (m.action === 'read') {
    $('qEdit').value = m.text; $('qEdit').disabled = false; $('qSave').disabled = false;
    $('qSave').textContent = '保存（仍在排队）'; $('qError').textContent = ''; edit.action = 'edit';
  } else { queueEditRequest = null; closeSheet(); queueDraftSync(); }
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
    if (b.dataset.part === 'stop' && !await ask(`停止子 Agent「${b.dataset.sub}」？\n它做到一半的工作会中断。`, '停止', true)) return;
    send({ t: 'subagent', name: b.dataset.sub, part: b.dataset.part });
    status(b.dataset.part === 'stop' ? '正在停止子 Agent…' : '正在打开子 Agent…');
    return;
  }
  if (b.dataset.a === 'edit') return editQueued(b.dataset.q);
  if (b.dataset.a === 'clear') {
    if (!await ask('清空 Devin 的排队消息？', '清空', true)) return;
    sendQueueAction('', 'clear');
    status('正在清空排队消息…');
    return;
  }
  if (b.dataset.a === 'send' && !await ask('立即发送这条消息？\nAgent 当前这一轮会被打断。', '立即发送', true)) return;
  if (b.dataset.a === 'remove' && !await ask('删除这条排队消息？', '删除', true)) return;
  sendQueueAction(b.dataset.q, b.dataset.a);
  status(b.dataset.a === 'send' ? '已立即发送这条排队消息' : '已删除这条排队消息');
};

function updateToBottom() {
  if (nearBottom()) $('toBottom').textContent = '↓ 最新';
  $('toBottom').style.display = atBottom() && isFollowingBottom() ? 'none' : 'block';
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
  initialBottomSelection = null;
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
  stopChatMotion(() => {
    const target = itemsEl.querySelector(`[data-i="${CSS.escape(String(id))}"]`);
    if (target) setChatScrollTop(list.scrollTop + target.getBoundingClientRect().top - list.getBoundingClientRect().top - 8);
    setScrollMode('freeScroll');
    lastScrollTop = list.scrollTop;
    updateToBottom();
  });
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
  if (!el) { setScrollMode('freeScroll'); return; }
  historyArmed = false;
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
  if (!lastChat) return;
  stopChatMotion();
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
    setScrollMode('freeScroll');
    turnNavPending = { sel: viewSel, thread: lastChat.thread, before: turns[0].i };
    if (historyRequest) return;
    clearTimeout(scrollIdle); chatScrolling = false;
    loadOlderMessages();
    if (!historyRequest && !deferredScrollRender) completeTurnNavigation();
  } else setScrollMode('freeScroll');
}
$('previousTurn').onclick = () => navigateTurn(-1);
$('nextTurn').onclick = () => navigateTurn(1);
$('toBottom').addEventListener('click', resetTurnNav);
$('turnNav').addEventListener('pointerdown', e => {
  if (e.button !== 0 || turnNavPointer) return;
  cancelChatMotion();
  restoringChatScroll = false;
  initialBottomSelection = null;
  bottomScrollIntent = null;
  e.preventDefault();
  suppressHistoryArm = true;
  historyArmed = false;
  historyPullUp = false;
  historyWheelPullUp = false;
  bottomFollowPending = false;
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
    bottomFollowPending = false;
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
    setScrollMode(pointer.progress === 1 && atBottom() ? 'followBottom' : 'freeScroll');
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
function paintHistoryStatus(inserting = false) {
  if (pendingHistoryStatus === null) return;
  const top = list.scrollTop, height = list.scrollHeight;
  $('older').disabled = !!historyRequest;
  if (historyAtEnd) $('older').hidden = true;
  $('historyStatus').hidden = false;
  $('historyStatus').textContent = pendingHistoryStatus;
  pendingHistoryStatus = null;
  if (!inserting && !isFollowingBottom() && !chatMotionFrame) setChatScrollTop(top + list.scrollHeight - height);
}
function showHistoryStatus(message) {
  pendingHistoryStatus = I18N.tr(message);
  // Apply status text together with pending chat content while a gesture is active.
  if (chatScrolling || chatTouching || chatFrame) return;
  paintHistoryStatus();
  restoreChatPosition(isFollowingBottom());
}
function loadOlderMessages() {
  if (!lastChat || historyRequest || historyPagePending) return;
  initialBottomSelection = null;
  setScrollMode('freeScroll');
  historyArmed = false;
  historyPullUp = false;
  historyWheelPullUp = false;
  if (!$('cachedMore').hidden) {
    historyRendering = true;
    historyPagePending = { local: true, sel: viewSel, thread: lastChat.thread };
    applyPendingHistory();
    return;
  }
  requestOlderRemote();
}
// Requests older data without moving the phone viewport.
function requestOlderRemote() {
  if (!lastChat || historyRequest) return;
  historyArmed = false;
  historyPullUp = false;
  historyWheelPullUp = false;
  if (historyAtEnd || $('older').hidden) {
    showHistoryStatus('已到最早消息');
    return;
  }
  const request = historyRequest = { id: String(++historySerial), sel: viewSel, thread: lastChat.thread, expanded: historyExpanded };
  request.timer = setTimeout(() => {
    if (historyRequest !== request) return;
    historyExpanded = request.expanded;
    clearHistoryRequest();
    historyRendering = false;
    showHistoryStatus('历史读取结果尚未返回，可重试');
  }, 30000);
  historyRendering = true;
  historyExpanded = true;
  showHistoryStatus('正在加载更早的消息…');
  const paging = {};
  if (currentApp === 'codex') {
    const orders = lastChat.items.map(it => it.order).filter(Number.isFinite);
    Object.assign(paging, { before: historyCursor ?? (orders.length ? Math.min(...orders) : null),
      known: SC.key ? [...SC.items.keys()] : lastChat.items.map(it => it.i), details: executionRecordsShown() });
  } else if (currentApp === 'cursor') paging.before = lastChat.items[0]?.i || null;
  if (send({ t: 'scrollChat', dy: -900, automatic: true, history: true, requestId: historyRequest.id, ...paging }) === false) {
    historyExpanded = historyRequest.expanded;
    clearHistoryRequest();
    historyRendering = false;
    showHistoryStatus('连接已断开，历史未加载，请重试');
  }
}
function cancelChatContentRequests() {
  if (historyRequest) {
    historyExpanded = historyRequest.expanded;
    clearHistoryRequest();
    historyRendering = false;
    showHistoryStatus('历史加载已中断，请重试');
  }
  historyPagePending = null;
  for (const [id, body] of thoughtFull) if (body === undefined) {
    thoughtFull.delete(id);
    const hit = cache.get(id);
    if (hit) hit.key = null;
  }
}
function receiveHistoryPage(m) {
  if (!historyRequest || m.requestId !== historyRequest.id || m.sel !== historyRequest.sel || m.thread !== historyRequest.thread || lastChat?.thread !== m.thread) return;
  historyPagePending = m;
  applyPendingHistory();
}
function applyPendingHistory() {
  if (!historyPagePending || chatMotionFrame || chatTouching || chatMomentum || chatScrolling || turnNavPointer?.dragging || userSelecting()) return;
  const page = historyPagePending;
  historyPagePending = null;
  if (page.sel !== viewSel || page.thread !== lastChat?.thread) return;
  // Finish live updates first, so the height difference below contains only the history insertion.
  if (queuedChat?.sel === viewSel) {
    const next = queuedChat;
    invalidateChatRender();
    renderChat(next.chat, next.stale);
  }
  let chat = lastChat;
  if (page.local) SC.show += 80;
  else {
    const known = new Set(chat.items.map(it => it.i));
    SC.show += page.items.filter(it => !known.has(it.i)).length;
    if (Number.isFinite(page.before)) historyCursor = page.before;
    const rows = [...new Map([...page.items, ...chat.items].map(it => [it.i, it])).values()];
    const order = it => Number.isFinite(it.order) ? it.order : Number(/^acp(\d+)/.exec(it.i)?.[1] || 0);
    rows.sort((a, b) => order(a) - order(b));
    chat = { ...chat, items: rows, earlier: page.earlier };
  }
  renderChat(chat, chatStale, false, true, true);
  if (isFollowingBottom()) requestChatScroll();
}
// Measure and commit only within the synchronous insertion; no reading position survives it.
function historyInsertionPosition() {
  const top = list.scrollTop, edge = list.getBoundingClientRect().top;
  const before = new Map([...itemsEl.children].map(el => {
    const r = el.getBoundingClientRect();
    return [el, { top: r.top - edge + top, bottom: r.bottom - edge + top }];
  }));
  return () => {
    const offset = list.scrollTop - list.getBoundingClientRect().top;
    let delta = 0, previous = null;
    for (const el of itemsEl.children) {
      const old = before.get(el);
      if (!old) continue;
      const r = el.getBoundingClientRect(), now = { top: r.top + offset, bottom: r.bottom + offset };
      if (!previous) delta = now.top - old.top;
      else if (previous.old.bottom <= top) delta += now.top - previous.now.bottom - (old.top - previous.old.bottom);
      if (old.bottom <= top) delta += now.bottom - now.top - (old.bottom - old.top);
      previous = { old, now };
    }
    setChatScrollTop(top + delta);
  };
}
function finishHistory(m) {
  if (!historyRequest || m.requestId !== historyRequest.id || m.sel !== historyRequest.sel) return;
  clearHistoryRequest();
  if (m.earlier === false) historyAtEnd = true;
  else if (m.earlier === true) historyAtEnd = false;
  showHistoryStatus(m.error || (m.pending ? '历史消息正在加载，请稍后重试' : m.earlier === false && $('cachedMore').hidden ? '已到最早消息' : '继续上滑可加载更早的消息'));
  if (!deferredScrollRender && !historyPagePending) historyRendering = false;
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
function flushSettledChat() {
  if (chatTouching) return;
  chatScrolling = false;
  chatMomentum = false;
  if (userReachedBottom()) setScrollMode('followBottom');
  // The compositor may deliver the last user scroll after this idle callback.
  chatUserScroll = false;
  bottomScrollIntent = null;
  if (isFollowingBottom() && layoutDirty && !bottomFollowPending) bottomFollowPending = true;
  if (deferredScrollRender && lastChat) {
    deferredScrollRender = false;
    layoutDirty = false;
    syncScrollFlush = true;
    try { renderChat(lastChat); } finally { syncScrollFlush = false; }
  } else if (pendingHistoryStatus !== null && !chatFrame) {
    paintHistoryStatus();
    restoreChatPosition(isFollowingBottom());
  }
  if (layoutDirty && !isFollowingBottom() && !bottomFollowPending) {
    layoutDirty = false;
  }
  if (bottomFollowPending) reconcileBottomFollow(true);
  applyPendingHistory();
  maybeLoadOlder();
  updateToBottom();
  updateComposeCompact();
}
function settleChatScroll() {
  const top = chatScrollTop();
  if (restoringChatScroll || !(chatTouching || chatMomentum || chatUserScroll || chatScrolling)) { lastScrollTop = top; updateToBottom(); return; }
  if (chatTouching && top < lastScrollTop) historyPullUp = true;
  if (chatUserScroll && !atBottom() && top < lastScrollTop && !chatTouching && !chatMomentum && !suppressHistoryArm && scrollMode !== 'programmatic' && (historyPullUp || historyWheelPullUp)) {
    historyArmed = true;
    setScrollMode('freeScroll');
  }
  lastScrollTop = top;
  if (userReachedBottom()) setScrollMode('followBottom');
  chatScrolling = true;
  clearTimeout(scrollIdle);
  scrollIdle = setTimeout(() => {
    if (chatTouching) return;
    // Scroll events can lag the compositor during momentum scrolling.
    if (chatScrollTop() !== lastScrollTop) { settleChatScroll(); return; }
    flushSettledChat();
  }, chatMomentum ? 300 : 150);
  updateToBottom();
  maybePrefetchOlder();
}
list.addEventListener('scroll', () => {
  if (restoringChatScroll) {
    restoringChatScroll = false;
    lastScrollTop = chatScrollTop();
    settleChatScroll();
    return;
  }
  if (!restoringChatScroll && turnNavUser) showTurnNav();
  if (!restoringChatScroll && (chatUserScroll || bottomScrollIntent) && scrollMode !== 'programmatic' && !atBottom() && chatScrollTop() < lastScrollTop) {
    setScrollMode('freeScroll');
    bottomScrollIntent = null;
  }
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
  if (e.deltaY) cancelChatMotion();
  turnNavGesture();
  restoringChatScroll = false;
  if (e.deltaY) { chatUserScroll = true; noteBottomScrollIntent(e.deltaY > 0); }
  if (e.deltaY < 0) { historyWheelPullUp = true; if (list.scrollTop <= 1) { historyArmed = true; settleChatScroll(); } }
  else if (e.deltaY > 0) { historyWheelPullUp = false; historyArmed = false; if (atBottom()) settleChatScroll(); }
}, { passive: true });
list.addEventListener('touchstart', e => { cancelChatMotion(); restoringChatScroll = false; bottomScrollIntent = null; historyTouchY = e.touches[0].clientY; historyPullUp = false; historyWheelPullUp = false; historyArmed = false; chatMomentum = false; chatUserScroll = false; chatTouching = true; chatScrolling = true; clearTimeout(scrollIdle); }, { passive: true });
list.addEventListener('touchmove', e => {
  turnNavGesture();
  restoringChatScroll = false;
  const y = e.touches[0].clientY, dy = y - historyTouchY;
  if (dy) { chatUserScroll = true; noteBottomScrollIntent(dy < 0); }
  if (dy && list.scrollTop <= 1) historyPullUp = true;
  if (dy < 0) {
    historyPullUp = true;
    if (list.scrollTop <= 1) historyArmed = true;
  }
  historyTouchY = y;
}, { passive: true });
for (const event of ['touchend', 'touchcancel']) list.addEventListener(event, () => {
  if (!chatTouching) return;
  chatMomentum = event === 'touchend' && chatUserScroll;
  if (event === 'touchcancel') bottomScrollIntent = null;
  chatTouching = false;
  restoringChatScroll = false;
  if (historyPullUp && list.scrollTop <= 1) historyArmed = true;
  if (!chatUserScroll) flushSettledChat();
  else settleChatScroll();
}, { passive: true });
function jumpToLatest() {
  stopChatMotion(() => {
    setChatScrollTop(maxChatScrollTop());
    setScrollMode('followBottom');
    updateToBottom();
  });
  resetTurnNav();
  suppressHistoryArm = false;
  if (deferredScrollRender && lastChat) {
    deferredScrollRender = false;
    renderChat(lastChat, chatStale);
  }
}
$('toBottom').onclick = jumpToLatest;
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
  if (currentApp === 'codex' && /^(View changes|View changed files|View file changes)$/i.test(b.dataset.actionLabel || '')) {
    status('读取改动的文件…');
    send({ t: 'changes' });
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
function showCodexSkills(rows, input = composerInput()) {
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
    closeSheet(); input.focus();
    input.setRangeText(token + ' ', input.selectionStart, input.selectionEnd, 'end');
    MN.mentions.push({ ...r, token, at: input.selectionStart - token.length - 1 });
    MN.value = input.value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  paint();
}
let codexFileRequest = 0;
async function openCodexFilePicker(token, input = composerInput()) {
  const scope = chatCacheKey(viewSel), selected = new Map();
  const start = token?.start ?? input.selectionStart, end = token?.end ?? token?.caret ?? input.selectionEnd;
  let directory = null;
  mentionHide(input);
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
      if (scope !== chatCacheKey(viewSel) || input !== composerInput()) { closeSheet(); return status('会话已切换，请重新选择文件', false); }
      if (takeMentions(input.value.slice(0, start) + input.value.slice(end)).length + selected.size > 12) return status('每条消息最多添加 12 个引用项', false);
      let at = start;
      const mentions = [...selected.values()].map(entry => {
        const token = '@' + entry.name;
        const mention = { token, q: entry.name, label: entry.name, path: entry.path, section: 'local-files', trigger: '@', at };
        at += token.length + 1;
        return mention;
      });
      input.setRangeText(mentions.map(m => m.token).join(' ') + (/\s/.test(input.value[end] || '') ? '' : ' '), start, end, 'end');
      MN.mentions.push(...mentions);
      MN.value = input.value;
      closeSheet(); input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
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
function openComposerAdd(input = text) {
  if (currentApp === 'fusion') {
    openSheet('add', '<h3>添加附件</h3><button class="opt" data-control="img">上传图片</button><button class="opt" data-control="uploadDoc">上传文档</button>');
    $('sheet').querySelectorAll('[data-control]').forEach(b => b.onclick = () => { closeSheet(); $(b.dataset.control).click(); });
    return;
  }
  const c = (input === text ? lastChat : chatBySel.get(chatCacheKey(viewSel)))?.codex;
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
    if (key === 'local-files') return openCodexFilePicker(undefined, input);
    input.focus();
    input.setRangeText(key === 'files' ? '@' : '/', input.selectionStart, input.selectionEnd, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true })); mentionUpdate(input);
  });
}
$('add').onclick = () => openComposerAdd(text);
$('pickPlan').onclick = () => { status('正在切换 Plan…'); send({ t: 'codexPlan' }); };
$('pickIde').onclick = () => send({ t: 'codexIde' });
$('pickRun').onclick = () => { status('读取执行位置…'); send({ t: 'codexRun' }); };
$('pickChat').onclick = () => { status('读取会话操作…'); send({ t: 'codexChat' }); };
$('pickAgents').onclick = () => openAgentList();
$('pickHistory').onclick = () => requestMenu('history', '读取历史对话…');
$('newChat').onclick = () => { status('正在新建对话…'); send({ t: 'newProjectChat' }); };

