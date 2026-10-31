/* ---------- overview: projects grouped by computer → sessions ---------- */
const OV_ROOT = { level: 'sessions', comp: null, proj: null, open: null };
const ovS = { ...OV_ROOT, level: store.get('ov-level') || OV_ROOT.level };
const OV_RUN = ['planning', 'echo', 'echo-check', 'execute', 'review', 'fix'];
const OV_WAIT = ['plan', 'disagree', 'check'];
const OV_LABEL = { planning: '写方案', echo: '复述', 'echo-check': '核对复述', execute: '执行', review: '评审', fix: '小修' };
const OV_NOW = { plan: '方案已写好，等你确认执行', disagree: '双方意见不一致，等你决定', check: '需要你选择：完成、小修或退回' };
const OV_STEP = { planning: 1, echo: 1, 'echo-check': 1, plan: 2, disagree: 2, execute: 3, review: 4, fix: 4, check: 4, done: 5 };
const OV_RANK = { wait: 0, err: 1, run: 2, idle: 3, done: 4 };
const OV_AGENT = { cursor: 'Cursor', devin: 'Devin', codex: 'Codex' };
const OV_EN = {
  '返回概览': 'Back to overview', '上一级': 'Up one level', '菜单': 'Menu', '全部': 'All', '在线': 'Online', '项目': 'Projects', '会话': 'Sessions',
  '概览': 'Overview', '全部电脑': 'All computers', '电脑范围': 'Computer scope', '不常用': 'Infrequent', '打开对话': 'Open conversation', '进行中': 'In progress',
  '查找地址…': 'Finding address…', '连接电脑…': 'Connecting…', '正在读取项目与会话…': 'Loading projects and sessions…',
  '正在验证设备…': 'Verifying device…', '正在恢复连接…': 'Restoring connection…',
  '暂时无法连接，已暂停自动重试': 'Unavailable; automatic retries paused',
  '重新连接': 'Reconnect', '重新授权': 'Authorize again', '连接详情': 'Connection details', '等待连接…': 'Waiting to connect…',
  '正在读取最新消息…': 'Loading the latest message…', '暂无可读取的摘要': 'No readable preview available', '暂无文本消息': 'No text messages yet', '摘要读取失败': 'Could not load the preview',
  '需要你': 'Needs you', '运行中': 'Running', '正在工作': 'Working', '已停止': 'Stopped', '已完成': 'Done', '空闲': 'Idle', '不活跃': 'Inactive', '全部会话': 'All sessions', '离线': 'Offline', '问题': 'Question',
  '等你确认': 'Waiting for you', '执行': 'Executing', '小修': 'Fixing', '已结束': 'Finished', '还没有配对的电脑': 'No paired computers yet',
  '打开项目': 'Open project', '个文件': 'files', '连接中…': 'Connecting…', '尚未连接': 'Not connected yet', '已发送': 'Sent', '操作失败': 'Action failed',
  '收藏': 'Favorites', '收藏会话': 'Favorite sessions', '还没有收藏会话': 'No favorite sessions yet', '长按会话卡片可收藏': 'Hold a session card to add it to favorites',
  '项目未打开': 'Project closed', '项目窗口已关闭，点击打开对话后加载': 'Project closed. Open the conversation to load it.',
  '尚未读取到项目路径，请在电脑上打开项目后重试': 'Project path unavailable. Open the project on the computer and try again.',
  '全选当前范围': 'Select this scope', '批量收藏': 'Add favorites', '删除／归档': 'Delete / archive', '退出管理': 'Done', '停止剩余操作': 'Stop remaining',
  '模型未提供': 'Model unavailable', '未提供任务进度': 'No task progress provided', '正在读取运行状态…': 'Loading run status…', '任务进度': 'Task progress',
  '更多操作': 'More actions', '本次发送': 'Send this message', '输入工具': 'Input tools',
};
const ovT = s => I18N.lang === 'en' && OV_EN[s] || s;
const OV_ICON = {
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="m12 3 2.8 5.7 6.3.9-4.5 4.4 1.1 6.2-5.7-3-5.7 3 1.1-6.2L3 9.6l6.2-.9z"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
};
const ovSt = new Map(), ovBusy = new Set(), ovErr = new Map();
const ovCollapsed = new Set();
const ovExpanded = new Set();
const ovPreviews = new Map();
let ovPreviewOwner = null;
const ovMain = $('overview').querySelector('.ov-main');
const ovDone = (() => { try { return JSON.parse(store.get('ov-done') || '{}'); } catch { return {}; } })();
let ovEnterRequested = false;
let ovToolState = null;
const ovComposerControls = { mic: $('mic'), stop: $('stop'), attachments: $('attachments').parentElement };
let ovBatch = null;
let ovList = [], ovPaint = '', ovCrumbsPaint = '', ovSig = [], ovScroll, ovEditing = null;
const ovTn = new Map();
const ovTname = k => { let n = ovTn.get(k); if (!n) ovTn.set(k, n = 'ov-t' + (ovTn.size + 1)); return n; };

const ovFmt = ms => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; };
const ovAg = app => `<span class="ov-ag"><img class="on-dark" src="logo-${app}-dark.svg" alt=""><img class="on-light" src="logo-${app}-light.svg" alt=""></span>`;
const ovLogo = (inner, cls = '') => `<span class="ov-logo${cls}">${inner}</span>`;
const ovText = (raw, ui) => raw ? `<span class="ovRaw">${esc(raw)}</span>` : ui ? `<span>${ovT(ui)}</span>` : '';
const ovRecLogo = r => r.fusion ? ovLogo([r.a, r.b].filter(Boolean).map(ovAg).join(''), ' ov-duo') : ovLogo(ovAg(r.app));
const ovAgName = r => r.fusion ? `Fusion · ${[r.a, r.b].filter(Boolean).map(a => OV_AGENT[a] || a).join(' + ')}` : OV_AGENT[r.app] || r.app;
const ovTarget = x => ({ computer: x.comp, win: x.win, windowId: x.windowId, threadId: x.threadId || '',
  ...(x.dormant ? { project: { root: x.workspace, host: x.host } } : {}) });
const ovNativeKey = (comp, s) => `${comp}|${s.windowId}|${s.threadId || s.win}`;
const ovRank = r => OV_RANK[r.state];
const ovRecency = r => Math.max(r.start || 0, r.ended || 0, r.used || 0);
const ovCount = recs => recs.reduce((k, r) => (k[r.state]++, k), { wait: 0, run: 0, err: 0, done: 0, idle: 0 });
const ovCompName = id => ovList.find(e => e.id === id)?.name || '';
const ovSessionIdentity = r => `${r.comp}|${r.app}|${r.threadId}`;
const ovCanManage = r => !r.fusion && !r.off && !!r.threadId;
const ovContext = r => `${ovS.level === 'favorites' ? ovCompName(r.comp) + ' · ' : ''}${r.projName} · ${ovAgName(r)}`;
const ovOn = e => ovComputerStatus(e) === 'online';

function ovComputerStatus(e, st = ovSt.get(e.id)) {
  const link = e.c && computerSockets.get(e.c.key), status = st?.dataStatus || 'loading';
  if (e.foreign) return status;
  if (link?.phase === 'identity') return 'offline';
  if (link?.rejected) return 'auth';
  if (status === 'old') return status;
  if (navigator.onLine === false || link?.phase === 'paused') return 'offline';
  if (link?.socket?.readyState < 2) {
    const foreground = e.c.key === currentComputer()?.key && link.socket === ws;
    const pending = foreground ? conn.initialSelection && !windowReady && !conn.attachFailed
      : link.preload && !computerBindingReady(link) && !link.preload.outcome;
    return link.authed && st?.data?.ready && !pending ? 'online' : 'loading';
  }
  if (link?.retry != null || link?.attempt) return 'loading';
  if (link?.socket?.readyState >= 2) return 'offline';
  return status === 'online' ? 'loading' : status;
}

function ovStOf(id) {
  let st = ovSt.get(id);
  if (!st) {
    ovSt.set(id, st = { dataStatus: 'loading', stage: 0, data: null, offset: 0, seen: 0, fetched: false, prev: new Map(), first: new Map(), flight: null,
      get failure() { return this.link?.failure; } });
    ovCollapsed.add(id);
  }
  return st;
}
function ovPrune() {
  const midnight = new Date().setHours(0, 0, 0, 0);
  for (const k in ovDone) if (ovDone[k] < midnight) delete ovDone[k];
}
async function ovSync() {
  const list = [];
  for (const [index, c] of loadComputers().entries()) {
    list.push({ id: c.id || await computerIdFromKey(c.key), c, index, name: c.name || '电脑', foreign: !!c.discovery && new URL(c.discovery).origin !== location.origin });
  }
  for (const b of loadComputerBookmarks()) if (!list.some(e => e.id === b.id)) list.push({ id: b.id, name: b.name, foreign: true });
  ovList = list;
}
function ovPoll() {
  if (document.visibilityState !== 'visible') return;
  ovSync().then(() => {
    for (const e of ovList) if (e.c && !e.foreign) ovFetch(e);
    ovRefreshPreview();
    ovRender();
  });
}
function ovRefreshPreview() {
  const r = !document.body.classList.contains('conv') && ovRecs().find(r => r.key === ovS.open && !r.fusion && !r.off && !r.dormant);
  if (ovPreviewOwner && ovPreviewOwner.key !== r?.key) {
    ovPreviewOwner.controller.abort();
    ovPreviewOwner = null;
  }
  if (!r || document.visibilityState !== 'visible') return;
  let preview = ovPreviews.get(r.key);
  if (preview?.flight || preview?.at && Date.now() - preview.at < 3500) return;
  if (!preview) {
    ovPreviews.set(r.key, preview = {});
    if (ovPreviews.size > 12) ovPreviews.delete(ovPreviews.keys().next().value);
  }
  const entry = ovList.find(e => e.id === r.comp), controller = new AbortController();
  const owner = ovPreviewOwner = { key: r.key, controller };
  const route = '/api/overview/preview?' + new URLSearchParams({ win: r.win, windowId: r.windowId, threadId: r.threadId });
  preview.flight = (async () => {
    try {
      const headers = await entryHeaders(entry.c, 'GET', route);
      const res = await fetch(entry.c.relay + route, { cache: 'no-store', headers, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
      const value = await res.json();
      if (ovPreviewOwner !== owner || ovS.open !== r.key || controller.signal.aborted) return;
      if (!res.ok) throw new Error(value.error || ovT('摘要读取失败'));
      if (value.computer !== r.comp || value.win !== r.win || value.windowId !== r.windowId || value.threadId !== r.threadId) throw new Error(ovT('摘要读取失败'));
      preview.value = value;
      preview.error = '';
    } catch (error) {
      if (controller.signal.aborted) return;
      preview.error = error.message;
    } finally {
      preview.at = Date.now();
      preview.flight = null;
      if (ovPreviewOwner === owner) { ovPreviewOwner = null; ovRender(); }
    }
  })();
}
function ovPreviewHtml(r) {
  if (r.dormant) return `<div class="ov-hint">${ovT(r.workspace ? '项目窗口已关闭，点击打开对话后加载' : '尚未读取到项目路径，请在电脑上打开项目后重试')}</div>`;
  if (r.fusion || r.off) return r.last ? `<div class="ov-last">${ovText(r.last)}</div>` : '';
  const preview = ovPreviews.get(r.key);
  const hint = preview?.error ? ovT('摘要读取失败') + '：' + preview.error
    : !preview?.value ? ovT('正在读取最新消息…')
    : !preview.value.available ? ovT('暂无可读取的摘要')
    : !preview.value.last ? ovT('暂无文本消息') : '';
  return hint ? `<div class="ov-hint">${esc(hint)}</div>` : `<div class="ov-last" data-ov-scroll="preview:${esc(r.key)}">${ovText(preview.value.text)}</div>`;
}
function ovFetch(e) {
  const st = ovStOf(e.id);
  if (!computerRetryAllowed(e.c)) return Promise.resolve();
  return st.flight ||= ovLoad(e, st).catch(error => { st.dataStatus = 'offline'; st.dataError = error.message; }).finally(() => { st.flight = null; ovRender(); });
}
async function ovRead(c, relay) {
  const res = await fetch(relay + '/api/overview', { cache: 'no-store', signal: AbortSignal.timeout(8000), headers: await entryHeaders(c, 'GET', '/api/overview') }).catch(() => null);
  if (!res) return { down: true };
  if (res.status === 401) return { auth: true };
  if (res.status === 404) return { old: true };
  if (!res.ok) return { down: true };
  return { data: await res.json() };
}
async function ovLoad(e, st) {
  const c = e.c;
  const link = computerSockets.get(c.key), socket = link?.socket, authorization = link?.auth;
  st.stage = c.relay ? 1 : 0;
  if (!c.relay) return;
  const r = await ovRead(c, c.relay);
  if (computerSockets.get(c.key)?.socket !== socket) return;
  if (!computerRetryAllowed(c)) return;
  if (r.down) throw new Error('down');
  if (r.auth) {
    if (link?.auth === authorization) rejectComputerConnection(c, 'auth');
    return;
  }
  if (r.old) { st.dataStatus = 'old'; return; }
  if (r.data.id !== e.id) { rejectComputerConnection(c, 'identity'); return; }
  st.offset = r.data.now - Date.now(); st.seen = Date.now(); st.dataStatus = 'online'; st.dataError = '';
  ovApply(e, st, r.data);
}
function ovApply(e, st, data) {
  const first = !st.fetched, prev = st.prev, next = new Map();
  st.fetched = true; st.data = data;
  const link = computerSockets.get(e.c.key);
  if (link?.authed) saveComputerResume(link);
  for (const s of data.sessions) {
    const key = ovNativeKey(e.id, s);
    if (s.busy && !st.first.has(key)) st.first.set(key, data.now);
    else if (!s.busy) st.first.delete(key);
  }
  let dirty = false;
  for (const r of ovRecsOf(e, st)) {
    const p = prev.get(r.key);
    next.set(r.key, { busy: r.busy, wait: !!r.wait, state: r.state });
    if ((r.busy || r.wait) && ovDone[r.key]) { delete ovDone[r.key]; dirty = true; }
    if (!p || first) continue;
    if (r.wait && !p.wait) ovNotify(r, 'wait');
    if (!r.fusion && p.busy && !r.busy && !r.wait) { ovDone[r.key] = Date.now(); dirty = true; ovNotify(r, 'done'); }
    if (r.fusion && p.state !== r.state && (r.state === 'done' || r.state === 'err')) ovNotify(r, r.state);
  }
  st.prev = next;
  if (dirty) { ovPrune(); store.set('ov-done', JSON.stringify(ovDone)); }
}
function ovNotify(r, kind) {
  if (document.body.classList.contains('conv')) return;
  const label = kind === 'wait' ? ovBadge(r) : kind === 'done' ? ovT('已完成') : ovT('已停止');
  ovToast(`${ovRecLogo(r)}<span class="ovRaw">${esc(r.title)}</span><small>${label}</small>`, r.key);
}
function ovRecsOf(e, st) {
  const off = ovComputerStatus(e, st) !== 'online', out = [];
  for (const s of st.data.sessions) {
    const key = ovNativeKey(e.id, s), done = ovDone[key], since = s.startedAt || st.first.get(key);
    out.push({ key, comp: e.id, off, state: s.dormant ? 'idle' : s.waiting ? 'wait' : s.busy ? 'run' : done ? 'done' : 'idle', busy: !!s.busy, wait: s.waiting || '',
      waitText: s.waitingText || '', last: s.last || '', tasks: s.tasks, actions: s.actions || [], devin: !!s.devin, changed: s.changed || 0, acceptAll: !!s.acceptAll,
      win: s.win, windowId: s.windowId, threadId: s.threadId || '', app: s.app, title: s.title || '', project: `${e.id}|${s.windowId}`, projName: s.project,
      start: since ? since - st.offset : 0, ended: done || 0, used: s.lastUsed ? s.lastUsed - st.offset : 0, changes: s.changes || null, favorite: s.favorite === true, common: agentSessionCommon(s),
      dormant: !!s.dormant, workspace: s.workspace || '', host: s.host || '' });
  }
  for (const f of st.data.fusion) {
    const phase = f.phase || 'idle', state = OV_RUN.includes(phase) ? 'run' : OV_WAIT.includes(phase) ? 'wait' : phase === 'done' ? 'done' : phase === 'stopped' ? 'err' : 'idle';
    out.push({ key: `${e.id}|fusion|${f.id}`, comp: e.id, off, state, busy: state === 'run', wait: state === 'wait' ? phase : '', fusion: true, phase, round: f.round || 0,
      a: f.a, b: f.b, app: 'fusion', title: f.title || '', project: `${e.id}|fusion`, projName: 'Fusion', waitText: '', last: '', tasks: null, actions: [],
      devin: false, changed: 0, win: 'fusion', windowId: 'fusion', threadId: f.id, start: f.updated ? f.updated - st.offset : 0, ended: 0, used: f.updated ? f.updated - st.offset : 0, changes: null });
  }
  return out;
}
const ovRecs = () => ovList.flatMap(e => ovSt.get(e.id)?.data ? ovRecsOf(e, ovSt.get(e.id)) : []);
function ovScopedRecs(all = ovRecs()) {
  if (ovS.level === 'favorites') return [...new Map(all.filter(r => r.favorite).map(r => [ovSessionIdentity(r), r])).values()];
  return all.filter(r => !r.dormant && (!ovS.comp || r.comp === ovS.comp) && (!ovS.proj || r.project === ovS.proj));
}
function ovProjects(all) {
  const map = new Map();
  for (const e of ovList) {
    const st = ovSt.get(e.id);
    if (!st?.data) continue;
    for (const w of st.data.windows) map.set(`${e.id}|${w.windowId}`, { key: `${e.id}|${w.windowId}`, comp: e.id, win: w.win, windowId: w.windowId, app: w.app, name: w.project });
    if (ovOn(e)) map.set(`${e.id}|fusion`, { key: `${e.id}|fusion`, comp: e.id, win: 'fusion', windowId: 'fusion', app: 'fusion', name: 'Fusion' });
  }
  for (const r of all) if (!map.has(r.project)) map.set(r.project, { key: r.project, comp: r.comp, win: r.win, windowId: r.windowId, app: r.app, name: r.projName });
  return [...map.values()];
}
function ovBadge(r) {
  if (r.off) return ovT('离线');
  if (r.dormant) return ovT('项目未打开');
  if (r.state === 'wait') return r.fusion ? ovT('等你确认') : r.wait.startsWith('q:') ? ovT('问题') : ovT('待确认');
  if (r.state === 'run') return r.fusion ? ovT(OV_LABEL[r.phase]) + (r.round > 1 ? ` · 第 ${r.round} 轮` : '') : ovT(ovS.proj ? '正在工作' : '运行中');
  return { done: ovT('已完成'), err: ovT('已停止'), idle: ovT(!r.common ? '不常用' : '空闲') }[r.state];
}
function ovNowHtml(r) {
  if (r.state === 'wait') return r.fusion ? ovText('', OV_NOW[r.phase]) : ovText(r.waitText, '等你确认');
  if (r.state === 'run') return ovText(r.tasks?.current || r.last, '正在工作…');
  if (r.state === 'done') return r.last ? ovText(r.last) : r.changes?.count != null ? `<span>${r.changes.count} ${ovT('个文件')}</span>` : ovText('', '已完成');
  if (r.state === 'err') return ovText('', '已停止');
  return ovText(r.last);
}
function ovProgress(r) {
  if (r.tasks) return { done: r.tasks.done, total: r.tasks.total };
  if (r.fusion) return { done: OV_STEP[r.phase] || 0, total: 5 };
  return null;
}
function ovTime(r) {
  if (!r.start) return '';
  if (r.fusion) return `${ovFmt(Date.now() - r.start)} 前`;
  if (r.state === 'run' || r.state === 'wait') return ovFmt(Date.now() - r.start);
  if (r.state === 'done' && r.ended) return `${ovFmt(Date.now() - r.ended)} 前`;
  return '';
}
function ovSeg(k) {
  const parts = [['wait', 'var(--ov-amber)'], ['err', 'var(--err)'], ['run', 'var(--accent)'], ['done', 'var(--ok)'], ['idle', 'var(--fg-4)']].filter(([n]) => k[n]);
  return `<span class="ov-seg">${parts.map(([n, c]) => `<i style="flex:${k[n]};background:${c}"></i>`).join('')}</span>`;
}
function ovAgg({ attrs, logo, title, sub, recs, badge, off, vt }) {
  const k = ovCount(recs), st = off ? 'idle' : k.wait ? 'wait' : k.err ? 'err' : k.run ? 'run' : k.done ? 'done' : 'idle';
  const label = badge || (k.wait ? `${k.wait} 个等你` : k.err ? `${k.err} 个已停止` : k.run ? `${k.run} 个运行中` : k.done ? ovT('已完成') : ovT('空闲'));
  ovSig.push(`${vt}:${st}:${off}`);
  return `<div class="ov-tile ov-agg ov-st-${st}${off ? ' ov-off' : ''}" style="view-transition-name:${ovTname(vt)}" ${attrs}>${logo}<span class="ov-badge">${label}</span>
    <div class="ov-title ovRaw">${esc(title)}</div><div class="ov-now">${sub}</div>
    <div class="ov-foot">${ovSeg(k)}<span class="ov-num">${k.wait + k.run}<small>活跃</small></span></div></div>`;
}
function ovComputerGroup(e, all, projs) {
  const st = ovSt.get(e.id), link = e.c && computerSockets.get(e.c.key);
  const status = ovComputerStatus(e, st);
  if (status === 'online' && !st.loaded) {
    st.loaded = true;
    if (!st.folded) ovCollapsed.delete(e.id);
  }
  const projects = projs.filter(p => p.comp === e.id), recs = all.filter(r => r.comp === e.id);
  const collapsed = ovCollapsed.has(e.id), loading = status === 'loading';
  let badge = ovT('在线'), action = '', detail = '';
  if (e.foreign) {
    badge = '在其入口中打开';
    action = e.c ? `data-ov="use" data-v="${e.index}"` : `data-ov="ext" data-id="${esc(e.id)}"`;
  } else if (status === 'auth') { badge = ovT('重新授权'); action = `data-ov="auth" data-id="${esc(e.id)}"`; }
  else if (status === 'old') { badge = '需要更新电脑端'; action = `data-ov="old" data-v="${e.index}"`; }
  else if (status === 'offline') {
    badge = ovT('重新连接'); action = `data-ov="retry" data-id="${esc(e.id)}"`;
    detail = link?.phase === 'paused' ? ovT('暂时无法连接，已暂停自动重试') : st?.seen ? `离线 · 最后在线 ${ovFmt(Date.now() - st.seen)} 前` : ovT('尚未连接');
  } else if (!loading) detail = ovS.level === 'projects' ? `${projects.length} 个项目` : `${recs.length} 个会话`;
  if (status === 'online' && e.c?.key === currentComputer()?.key && conn.attachFailed) detail = I18N.tr('当前会话尚未就绪');
  const stage = link?.authed || link?.restoring ? 2 : link?.opened ? 1 : st?.stage || 0;
  if (loading) detail = ovT(link?.retry != null || link?.attempt && link?.socket?.readyState >= 2 || link?.restoring ? '正在恢复连接…' : link?.authed ? '正在读取项目与会话…' : link?.opened ? '正在验证设备…' : !link?.socket && st?.data ? '等待连接…' : stage ? '连接电脑…' : '查找地址…');
  const progress = loading && !e.foreign ? `<span class="ov-computer-progress" aria-hidden="true">${[0, 1, 2].map(i => `<i class="${i < stage ? 'done' : i === stage ? 'current' : ''}"></i>`).join('')}</span>` : '';
  ovSig.push(`c:${e.id}:${status}:${loading ? stage : ''}:${collapsed}`);
  const body = !collapsed && st?.data ? ovS.level === 'projects' ? ovProjectTiles(projects, all, false) : ovSessions(recs, e.id) : '';
  const empty = status === 'online' && st?.data?.ready ? ovEmpty('这里还没有会话') : '';
  const tools = status === 'online' && !e.foreign ? `<button type="button" class="ov-computer-tool" data-ov="computer-projects" data-id="${esc(e.id)}" title="${I18N.tr('打开项目／新建会话')}" aria-label="${I18N.tr('打开项目／新建会话')}">${$('pickEditor').innerHTML}</button><button type="button" class="ov-computer-tool" data-ov="computer-editor" data-id="${esc(e.id)}" title="${I18N.tr('打开文件')}" aria-label="${I18N.tr('打开文件')}">${fileEntryIcon(false)}</button>` : '';
  return `<section class="ov-computer" data-ov-node="computer:${esc(e.id)}" style="view-transition-name:${ovTname('c:' + e.id)}"><div class="ov-computer-row ${status}"><button type="button" class="ov-computer-toggle" data-ov="fold" data-id="${esc(e.id)}" aria-expanded="${!collapsed}"><span class="ov-computer-dot" aria-hidden="true"></span><span class="ov-computer-label"><span class="ov-computer-name ovRaw">${esc(e.name)}</span>${detail ? `<span class="ov-computer-detail">${esc(detail)}</span>` : ''}${progress}</span></button>${tools}${action ? `<button type="button" class="ov-computer-action" ${action}>${badge}</button>` : ''}${!e.foreign && (status === 'offline' || loading && st?.failure) ? `<button type="button" class="ov-computer-info" data-ov="details" data-id="${esc(e.id)}" aria-label="${ovT('连接详情')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="8"/><path d="M12 10v7m0-11v1"/></svg></button>` : ''}<button type="button" class="ov-computer-fold" data-ov="fold" data-id="${esc(e.id)}" aria-expanded="${!collapsed}" aria-label="${I18N.tr(collapsed ? '展开电脑' : '折叠电脑')}"><svg class="ov-computer-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button></div>${body || empty && !collapsed ? `<div class="ov-board">${body || empty}</div>` : ''}</section>`;
}
function ovProjTile(p, all, showComputer = !ovS.comp) {
  const recs = all.filter(r => r.project === p.key), fusion = p.app === 'fusion';
  const apps = fusion ? [...new Set(recs.flatMap(r => [r.a, r.b]))].filter(Boolean) : [p.app];
  const attrs = fusion && !recs.length ? `data-ov="open" data-t="${esc(JSON.stringify(ovTarget(p)))}"` : `data-ov="proj" data-id="${esc(p.key)}"`;
  const sub = `${showComputer ? `<span class="ovRaw">${esc(ovCompName(p.comp))} · </span>` : ''}<span>${recs.length} 个会话</span>`;
  return ovAgg({ attrs, logo: ovLogo(apps.map(ovAg).join(''), ' ov-stack'), title: p.name, sub, recs, vt: 'p:' + p.key });
}
function ovProjectTiles(projects, all, showComputer = !ovS.comp) {
  return projects.sort((a, b) => {
    const rk = p => Math.min(5, ...all.filter(r => r.project === p.key).map(ovRank));
    const pr = p => Math.max(0, ...all.filter(r => r.project === p.key).map(ovRecency));
    return rk(a) - rk(b) || pr(b) - pr(a);
  }).map(p => ovProjTile(p, all, showComputer)).join('');
}
function ovSessTile(r) {
  const open = !ovBatch && ovS.open === r.key, p = ovProgress(r), fill = p ? Math.round(p.done / p.total * 100) : 0;
  const now = r.state === 'wait' ? ovNowHtml(r) : ovText(r.tasks?.current || r.last);
  const work = r.state === 'run' ? ovT(r.fusion ? OV_LABEL[r.phase] : '正在工作…') : ovBadge(r);
  const selected = !!ovBatch?.selected.has(ovSessionIdentity(r));
  const cls = ['ov-tile', 'ov-session', 'ov-compact', `ov-st-${r.state}`, open && 'ov-open', r.off && 'ov-off', ovBatch && 'ov-selecting', selected && 'ov-selected'].filter(Boolean).join(' ');
  ovSig.push(`${r.key}:${cls}`);
  return `<div class="${cls}" data-ov-session="${esc(r.key)}" style="--p:${fill}%;view-transition-name:${ovTname(r.key)}"${open ? '' : ` data-ov="sess" data-id="${esc(r.key)}"`}${ovBatch ? ` role="checkbox" aria-checked="${selected}" aria-disabled="${!ovCanManage(r) || ovBatch.running}" tabindex="0"` : ''}>
    ${ovBatch && ovCanManage(r) ? `<span class="ov-check" aria-hidden="true">${selected ? '✓' : ''}</span>` : ''}
    ${ovRecLogo(r)}<div class="ov-state"><span class="ov-badge">${esc(ovBadge(r))}</span><span class="ov-time">${esc(ovTime(r))}</span></div>
    <div class="ov-title ovRaw">${esc(r.title)}</div>
    <div class="ov-context ovRaw" title="${esc(ovContext(r))}">${esc(ovContext(r))}</div>
    <div class="ov-now">${now}</div>
    <div class="ov-foot"><span class="ov-num">${p ? `${p.done}<small>/${p.total}</small>` : ''}</span></div>
    ${open ? `<button class="ov-close" data-ov="close" aria-label="关闭">${OV_ICON.x}</button><div class="ov-card">${ovCard(r)}</div>` : `<div class="ov-actions"><span class="ov-work">${esc(work)}</span>${ovBatch ? '' : ovOpenLink(r, ' ov-direct')}</div>`}
  </div>`;
}
function ovOpenLink(r, cls = '') {
  return `<button class="ov-link${cls}" data-ov="full" data-id="${esc(r.key)}" data-t="${esc(JSON.stringify(ovTarget(r)))}"${r.dormant && !r.workspace ? ' disabled' : ''}>${ovT('打开对话')}</button>`;
}
function ovChangesRow(r) {
  const c = r.changes;
  if (!c) return '';
  const n = c.count != null ? `<span>${c.count} ${ovT('个文件')}</span>` : '';
  const a = c.add != null ? `<span class="ov-add">+${c.add}</span>` : '';
  const d = c.del != null ? `<span class="ov-del">−${c.del}</span>` : '';
  return n || a || d ? `<div class="ov-meta">${n}${a}${d}</div>` : '';
}
function ovRunHtml(r) {
  const value = ovPreviews.get(r.key)?.value, tasks = value?.tasks || r.tasks;
  const model = value?.model || '';
  const progress = tasks?.total > 0 ? tasks : null;
  const count = progress ? `${ovT('已完成')} ${progress.done}/${progress.total}` : ovT(value ? '未提供任务进度' : '正在读取运行状态…');
  const tools = value?.tools || [];
  return `<div class="ov-run-meta"><span class="ov-run-model ovRaw" title="${esc(model)}">${esc(model || ovT('模型未提供'))}</span><span class="ov-run-count">${esc(count)}</span></div>`
    + (progress ? `<div class="ov-progress" role="progressbar" aria-label="${ovT('任务进度')}" aria-valuemin="0" aria-valuemax="${progress.total}" aria-valuenow="${progress.done}" title="${esc(progress.current || '')}"><i style="width:${Math.round(progress.done / progress.total * 100)}%"></i></div>` : '')
    + (tools.length ? `<div class="ov-run-tools" data-ov-scroll="tools:${esc(r.key)}" tabindex="0" aria-label="${I18N.tr('工具调用')}">${tools.map(tool => `<div class="ov-run-tool ${tool.state}" title="${esc(tool.label)}"><span class="ov-run-mark" aria-hidden="true">${tool.state === 'done' ? '✓' : tool.state === 'error' ? '!' : tool.state === 'run' ? '◌' : '·'}</span><span class="ovRaw">${esc(tool.label)}</span></div>`).join('')}</div>` : '');
}
function ovCard(r) {
  const online = !r.off, dis = ovBusy.has(r.key) ? ' disabled' : '', key = esc(r.key);
  const status = `<div class="ov-status"><div class="ov-state"><span class="ov-badge">${esc(ovBadge(r))}</span><span class="ov-time">${esc(ovTime(r))}</span></div><span class="ovRaw" title="${esc(ovContext(r))}">${esc(ovContext(r))}</span></div>`;
  const canReply = !r.fusion && !r.dormant && online;
  const ready = ovComposerReady(r.key), replyDis = !ready || $('send').disabled ? ' disabled' : '';
  const composer = canReply ? `<div class="ov-attachments" data-ov-node="attachments:${key}" data-ov-control="attachments" data-ov-preserve></div><div class="ov-mentions" data-ov-preserve hidden></div><div class="ov-composer" data-ov-node="reply:${key}"><textarea data-ov-input="${key}" rows="1" enterkeyhint="send" placeholder="${r.state === 'wait' ? '输入回复…' : `告诉 ${OV_AGENT[r.app]} 下一步…`}"${replyDis}></textarea><button class="ov-send" data-ov="send" data-id="${key}" aria-label="${esc($('send').textContent)}" title="${esc($('send').textContent)}"${replyDis}>${OV_ICON.arrow}</button></div>` : '';
  let body;
  if (r.state === 'wait') {
    body = `<div class="ov-q">${ovNowHtml(r)}</div>` + (r.devin
      ? (r.actions.length ? `<div class="ov-opts">${r.actions.map(a => `<button class="ov-opt" data-ov="opt" data-id="${key}" data-v="${esc(a.id)}"${dis}>${ovText(a.label)}</button>`).join('')}</div>` : '')
      : '<div class="ov-hint">请在对话中处理</div>') + ovPreviewHtml(r) + composer;
  } else {
    const p = r.tasks && ovProgress(r);
    body = (r.state === 'run' && !r.fusion ? ovRunHtml(r) : p ? `<div class="ov-progress"><i style="width:${Math.round(p.done / p.total * 100)}%"></i></div><div class="ov-pmeta"><span><b>${p.done}</b><em>/${p.total} 项任务</em></span></div>${r.tasks.current ? `<div class="ov-cur">${ovText(r.tasks.current)}</div>` : ''}` : '')
      + ovPreviewHtml(r)
      + ovChangesRow(r)
      + (r.fusion ? `<div class="ov-meta"><span>第 ${r.round} 轮</span><span>A · ${esc(OV_AGENT[r.a] || r.a)}</span><span>B · ${esc(OV_AGENT[r.b] || r.b)}</span></div>` : '')
      + composer
      + (r.devin && r.state === 'done' && r.acceptAll ? `<button class="ov-btn ov-pri" data-ov="accept" data-id="${key}"${dis}>接受改动</button>` : '');
  }
  const err = ovErr.has(r.key) ? `<div class="ov-errbox">${esc(ovErr.get(r.key))}</div>` : '';
  const off = r.off ? '<div class="ov-hint">电脑离线</div>' : '';
  const tool = (id, disabled = dis, label = '') => `<button data-ov="tool" data-id="${key}" data-v="${id}" title="${esc(label || $(id).title)}" aria-label="${esc(label || $(id).ariaLabel)}"${disabled}>${label && ['send', 'sendNow'].includes(id) ? OV_ICON.arrow : $(id).innerHTML}${label ? `<span>${esc(label)}</span>` : ''}</button>`;
  const landscape = document.body.classList.contains('land');
  const sendChoices = ready && questionCompose?.sel !== viewSel && (devinBusySplit() || cursorBusyQueue() || codexFollow());
  const sends = !landscape || sendChoices ? tool('send', replyDis, $('send').textContent) + ($('sendNow').hidden ? '' : tool('sendNow', !ready || $('sendNow').disabled ? ' disabled' : '', $('sendNow').textContent)) : '';
  const queueCount = ready ? queuedMessages().count : 0;
  const queue = queueCount ? `<button class="ov-queue" data-ov="queue" data-id="${key}" aria-haspopup="dialog">${I18N.tr('排队')} ${queueCount} ▾</button>` : '';
  const inputs = ['inputPrev', 'inputNext', 'insertNewline'].map(id => tool(id, dis, landscape ? '' : $(id).ariaLabel)).join('');
  const more = landscape ? `<div class="ov-compose-inline">${inputs}${sends}</div>`
    : `<details class="ov-compose-more" data-ov-node="more:${key}"><summary data-ov="more" title="${ovT('更多操作')}" aria-label="${ovT('更多操作')}"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></summary><div class="ov-compose-more-menu"><div class="ov-compose-more-label">${ovT('本次发送')}</div>${sends}<div class="ov-compose-more-label">${ovT('输入工具')}</div>${inputs}</div></details>`;
  const tools = canReply ? `<div class="ov-tools">${['add', 'img', 'uploadDoc'].map(id => tool(id)).join('')}<span data-ov-node="mic:${key}" data-ov-control="mic" data-ov-preserve></span><span data-ov-node="stop:${key}" data-ov-control="stop" data-ov-preserve></span>${more}${queue}</div>` : '';
  const message = ready && $('msg').className !== 'quiet' ? $('msg').textContent : '';
  const toolStatus = tools && message ? `<div class="ov-tool-status ${$('msg').className}" role="status">${esc(message)}</div>` : '';
  return status + body + off + err + toolStatus + `<div class="ov-cfoot">${tools}${ovOpenLink(r)}</div>`;
}
function ovSessionGroup(label, recs, id) {
  if (!recs.length) return '';
  const expanded = ovExpanded.has(id);
  ovSig.push(`${id}:${expanded}`);
  return `<section class="ov-inactive" data-ov-node="group:${esc(id)}"><button class="ov-inactive-toggle" data-ov="group" data-id="${esc(id)}" aria-expanded="${expanded}"><span>${ovT(label)} · ${recs.length}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 5 7 7-7 7"/></svg></button>${expanded ? `<div class="ov-inactive-grid">${recs.map(ovSessTile).join('')}</div>` : ''}</section>`;
}
const ovBucket = r => r.state === 'idle' ? r.common ? 'idle' : 'inactive' : r.state === 'run' || r.state === 'done' ? r.state : 'wait';
function ovSessions(recs, scope) {
  const list = recs.slice().sort((a, b) => Math.min(ovRank(a), 3) - Math.min(ovRank(b), 3) || ovRecency(b) - ovRecency(a));
  const groups = { done: [], wait: [], run: [], idle: [], inactive: [] };
  // Keep the editing card in its current group while its live badge and content continue updating.
  for (const r of list) groups[ovEditing?.key === r.key ? ovEditing.bucket : ovBucket(r)].push(r);
  const { done, wait, run, idle, inactive } = groups;
  const sections = [['已完成', done], ['需要你', wait], ['进行中', run]];
  return sections.map(([label, rows]) => rows.length ? `<div class="ov-div">${ovT(label)} · ${rows.length}</div>${rows.map(ovSessTile).join('')}` : '').join('')
    + (ovS.proj ? idle.map(ovSessTile).join('') : ovSessionGroup('空闲', idle, scope + '|idle'))
    + ovSessionGroup('不常用', inactive, scope + '|inactive');
}
function ovEmpty(text) { return `<div class="ov-empty">${text}</div>`; }
function ovBoard(all, projs, scoped) {
  if (ovS.level === 'favorites') return scoped.sort((a, b) => ovRecency(b) - ovRecency(a)).map(ovSessTile).join('')
    || ovEmpty(`${ovT('还没有收藏会话')}<small>${ovT('长按会话卡片可收藏')}</small>`);
  if (!ovS.proj) {
    const list = ovList.filter(e => !ovS.comp || e.id === ovS.comp).sort((a, b) => ovOn(b) - ovOn(a));
    return list.map(e => ovComputerGroup(e, all, projs)).join('') || ovEmpty(ovT('还没有配对的电脑'));
  }
  const p = ovS.proj && projs.find(x => x.key === ovS.proj);
  return ovSessions(scoped, ovS.proj) || (p && p.app !== 'fusion'
    ? `<div class="ov-empty"><button class="ov-btn ov-pri" data-ov="open" data-t="${esc(JSON.stringify(ovTarget(p)))}">${ovT('打开项目')}</button></div>`
    : ovEmpty('这里还没有会话'));
}
function ovPlan() {
  const all = ovRecs().filter(r => ovS.level === 'favorites' || !r.dormant), projs = ovProjects(all);
  ovSig = [];
  const scoped = ovScopedRecs(all);
  const k = { ...ovCount(scoped), total: scoped.length, inactive: scoped.filter(r => r.state === 'idle' && !r.common).length }, anyWait = scoped.some(r => r.state === 'wait');
  const crumbs = [`<label class="ov-scope"><select class="ovRaw" data-ov-computer aria-label="${ovT('电脑范围')}"><option value=""${!ovS.comp ? ' selected' : ''}>${ovT('全部电脑')}</option>${ovList.map(e => `<option value="${esc(e.id)}"${ovS.comp === e.id ? ' selected' : ''}>${esc(e.name)}</option>`).join('')}</select><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></label>`];
  if (ovS.proj) crumbs.push(`<i>›</i><button data-ov="crumb" data-v="proj"><span class="ovRaw">${esc(projs.find(p => p.key === ovS.proj)?.name || '')}</span></button>`);
  if (ovS.level === 'favorites') crumbs.splice(0, crumbs.length, `<span class="ov-favorites-title">${ovT('收藏')}</span>`);
  const levels = [['sessions', ovT('概览'), OV_ICON.grid], ['projects', ovT('项目'), OV_ICON.folder], ['favorites', ovT('收藏'), OV_ICON.star]]
    .map(([v, l, ic]) => `<button class="ov-lv${ovS.level === v ? ' on' : ''}" data-ov="level" data-v="${v}"><i>${ic}${v === 'sessions' && anyWait && ovS.level !== 'sessions' ? '<span class="ov-dot"></span>' : ''}</i><span>${l}</span></button>`).join('');
  const summary = [['total', ovT(ovS.level === 'favorites' ? '收藏会话' : '全部会话'), 'var(--fg-3)'], ['wait', ovT('需要你'), 'var(--ov-amber)'], ['run', ovT('运行中'), 'var(--accent)'], ['err', ovT('已停止'), 'var(--err)'], ['done', '今日完成', 'var(--ok)'], ['inactive', ovT('不常用'), 'var(--fg-4)']]
    .filter(([n]) => k[n]).map(([n, l, c]) => `<span><i class="ov-d" style="background:${c}"></i><b>${k[n]}</b><em>${l}</em></span>`).join('');
  const lane = ovS.level !== 'projects' || ovS.proj ? '' : scoped.filter(r => r.state === 'wait').sort((a, b) => ovRecency(b) - ovRecency(a))
    .map(r => `<div class="ov-lane-item" data-ov="lane" data-id="${esc(r.key)}">${ovRecLogo(r)}<span class="ovRaw">${esc(r.title)}</span><small>${esc(ovBadge(r))}</small></div>`).join('');
  const board = ovBoard(all, projs, scoped);
  const batch = ovBatchHtml();
  const layout = [ovS.level, ovS.comp, ovS.proj, ovS.open, ovSig.join('|')].join('\u0001');
  const paint = [layout, crumbs.join(''), levels, summary, lane, board, batch].join('\u0001');
  return { up: !!(ovS.open || ovS.comp || ovS.proj), crumbs: crumbs.join(''), levels, summary, lane, board, batch, layout, paint };
}
function ovPatch(container, html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const active = document.activeElement;
  const key = node => node.nodeType === 1 ? [node.nodeName, node.getAttribute('data-ov') || '',
    node.getAttribute('data-ov-session') || node.getAttribute('data-ov-node') || node.getAttribute('data-ov-input') || node.getAttribute('data-ov-scroll')
      || node.getAttribute('data-id') || node.getAttribute('data-v') || node.getAttribute('class')?.split(' ')[0] || ''].join('|') : node.nodeName;
  const patch = (parent, next) => {
    const previous = [...parent.childNodes], pool = new Map();
    for (const node of previous) { const k = key(node); if (!pool.has(k)) pool.set(k, []); pool.get(k).push(node); }
    const children = [...next.childNodes].map(wanted => {
      const node = pool.get(key(wanted))?.shift();
      if (!node) return wanted;
      if (node.nodeType === 1 && node.hasAttribute('data-ov-preserve')) return node;
      if (node.isEqualNode(wanted)) return node;
      if (node.nodeType !== 1) node.nodeValue = wanted.nodeValue;
      else {
        for (const attribute of [...node.attributes]) if (!wanted.hasAttribute(attribute.name) && !(attribute.name === 'open' && node.matches('.ov-compose-more'))) node.removeAttribute(attribute.name);
        for (const attribute of wanted.attributes) if (node.getAttribute(attribute.name) !== attribute.value) node.setAttribute(attribute.name, attribute.value);
        patch(node, wanted);
      }
      return node;
    });
    // Move siblings around the focused subtree; moving that subtree would cancel native IME input.
    const pinned = children.findIndex(node => node.contains(active));
    let before = pinned >= 0 ? children[pinned] : parent.firstChild;
    for (let i = pinned - 1; i >= 0; i--) { if (children[i].nextSibling !== before) parent.insertBefore(children[i], before); before = children[i]; }
    before = pinned >= 0 ? children[pinned].nextSibling : parent.firstChild;
    for (let i = pinned + 1; i < children.length; i++) { if (children[i] !== before) parent.insertBefore(children[i], before); before = children[i].nextSibling; }
    const kept = new Set(children);
    if (ovToolState && previous.some(node => !kept.has(node) && node.contains(mentionInput))) {
      mentionHide(mentionInput); mentionInput = text;
    }
    for (const node of previous) if (!kept.has(node)) node.remove();
  };
  patch(container, template.content);
  for (const input of container.querySelectorAll('[data-ov-input]')) ovPaintComposerInput(input);
}
function ovCommit(p) {
  if (ovToolState && ovToolState.key !== ovS.open) ovReleaseComposer();
  const scrolls = new Map([...$('ovBoard').querySelectorAll('[data-ov-scroll]')].map(el => [el.dataset.ovScroll, { top: el.scrollTop, left: el.scrollLeft }]));
  ovPaint = p.paint;
  $('overview').classList.toggle('ov-project', !!ovS.proj);
  $('ovUp').classList.toggle('ov-hide', !p.up);
  if (ovCrumbsPaint !== p.crumbs) {
    ovPatch($('ovCrumbs'), p.crumbs);
    const scope = $('ovCrumbs').querySelector('[data-ov-computer]');
    if (scope) scope.value = ovS.comp || '';
    ovCrumbsPaint = p.crumbs;
  }
  ovPatch($('ovLevels'), p.levels);
  ovPatch($('ovSummary'), p.summary);
  ovPatch($('ovLane'), p.lane);
  $('ovLane').hidden = !p.lane;
  ovPatch($('ovBoard'), p.board);
  ovPatch($('ovBatch'), p.batch);
  $('ovBatch').hidden = !p.batch;
  for (const el of $('ovBoard').querySelectorAll('[data-ov-scroll]')) {
    const pos = scrolls.get(el.dataset.ovScroll);
    if (pos) { el.scrollTop = pos.top; el.scrollLeft = pos.left; }
  }
  ovPrepareVisibleComposer();
  ovMountComposerControls();
}
function ovRender(vt, scroll, locate = false) {
  if (winBinding && ovToolState) {
    const entry = ovList.find(e => e.id === winBinding.target.computer), state = entry && ovComputerStatus(entry);
    const failed = currentComputer()?.id === winBinding.target.computer && conn.attachFailed;
    if (failed || ['offline', 'auth', 'old'].includes(state)) {
      finishWinBinding(new Error(failed ? conn.failedTargets.get(winBinding.target.win) || '目标会话读取失败' : state === 'auth' ? '设备授权已失效，请重新授权' : '电脑尚未连接，请先重新连接'));
    }
  }
  ovRefreshPreview();
  if (document.body.classList.contains('conv')) return;
  const p = ovPlan();
  if (scroll != null) ovScroll = scroll;
  if (p.paint === ovPaint) {
    if (scroll != null) {
      const scope = $('ovCrumbs').querySelector('[data-ov-computer]');
      if (scope) scope.value = ovS.comp || '';
      ovMain.scrollTop = ovScroll;
      ovScroll = undefined;
    }
    ovPrepareVisibleComposer();
    return;
  }
  const commit = (next = p) => {
    const top = ovScroll ?? ovMain.scrollTop;
    ovScroll = undefined;
    ovCommit(next);
    ovMain.scrollTop = top;
    if (locate) ovLocateCard();
  };
  const motion = document.startViewTransition && !matchMedia('(prefers-reduced-motion:reduce)').matches;
  if (motion && vt) document.startViewTransition(() => commit(ovPlan())).ready.catch(() => {});
  else commit();
}
function ovHistory(scroll = ovMain.scrollTop) {
  return { ov: { ...ovS }, ovCollapsed: [...ovCollapsed], ovExpanded: [...ovExpanded], ovScroll: scroll };
}
function ovSaveHistory() {
  history.replaceState({ ...history.state, ...ovHistory() }, '');
  saveComputerResumes();
}
function ovRestoreComputers(saved) {
  for (const [id, value] of saved.entries) {
    const st = ovStOf(id);
    st.folded = value.folded;
    if (st.data || !value.overview) continue;
    st.data = value.overview;
    st.offset = value.offset;
  }
  if (!pendingNotice && store.get('start-view') !== 'conversation') {
    const sameLevel = saved.view.ov.level === ovS.level;
    if (sameLevel) Object.assign(ovS, saved.view.ov);
    ovCollapsed.clear();
    for (const id of saved.view.ovCollapsed) ovCollapsed.add(id);
    ovExpanded.clear();
    for (const id of saved.view.ovExpanded) ovExpanded.add(id);
    ovRender(false, sameLevel ? saved.view.ovScroll : 0);
  }
}
function ovRestore(st) {
  ovClearBatch();
  Object.assign(ovS, OV_ROOT, st?.ov);
  ovCollapsed.clear();
  for (const id of st?.ovCollapsed || []) ovCollapsed.add(id);
  ovExpanded.clear();
  for (const id of st?.ovExpanded || []) ovExpanded.add(id);
  ovRender(true, st?.ovScroll || 0);
}
function ovMove(change, push = false) {
  ovClearBatch();
  ovSaveHistory();
  const depth = history.state?.ovDepth || 0;
  Object.assign(ovS, change);
  history[push ? 'pushState' : 'replaceState']({ ...ovHistory(0), ovDepth: depth + Number(push) }, '');
  ovRender(true, 0);
}
function ovUp() {
  if (ovS.open) { ovS.open = null; ovSaveHistory(); return ovRender(true); }
  if (ovS.proj) {
    if ((history.state?.ovDepth || 0) > 0) return history.back();
    return ovMove({ proj: null, level: 'projects' });
  }
  if (ovS.comp) ovMove({ comp: null });
}
function ovFocusSession(key) {
  const r = ovRecs().find(x => x.key === key);
  if (!r) return;
  ovCollapsed.delete(r.comp);
  if (r.state === 'idle') ovExpanded.add(r.comp + (r.common ? '|idle' : '|inactive'));
  ovMove({ level: 'sessions', comp: r.comp, proj: null, open: key });
}
function ovToast(html, key) {
  const t = document.createElement('div');
  t.className = 'ov-toast';
  t.innerHTML = html;
  if (key) { t.dataset.ov = 'jump'; t.dataset.id = key; }
  $('ovToasts').append(t);
  setTimeout(() => t.classList.add('out'), 3400);
  setTimeout(() => t.remove(), 3800);
}
async function ovSend(key, act, extra, ok) {
  const r = ovRecs().find(x => x.key === key);
  if (!r) return;
  const e = ovList.find(x => x.id === r.comp);
  const route = '/api/act';
  ovBusy.add(key); ovErr.delete(key); ovRender();
  try {
    const res = await fetch(e.c.relay + route, { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/json', ...await entryHeaders(e.c, 'POST', route) },
      body: JSON.stringify({ win: r.win, threadId: r.threadId, act, ...(act === 'acceptAll' ? {} : { question: r.wait }), ...extra }) });
    const result = await res.json();
    if (!res.ok) ovErr.set(key, I18N.tr(result.error || ovT('操作失败')));
    else { ovToast(`<span>${ovT(ok)}</span>`); ovFetch(e); }
  } catch { ovErr.set(key, I18N.tr('连接电脑失败，请重试')); }
  ovBusy.delete(key);
  ovRender();
}
async function ovSessionRequest(r, action, extra = {}) {
  const entry = ovList.find(e => e.id === r.comp), route = '/api/overview/session';
  const res = await fetch(entry.c.relay + route, { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(60000),
    headers: { 'content-type': 'application/json', ...await entryHeaders(entry.c, 'POST', route) },
    body: JSON.stringify({ ...ovTarget(r), action, ...extra }) });
  const value = await res.json();
  if (!res.ok) throw new Error(value.error || ovT('操作失败'));
  return value;
}
async function ovManageSession(r, action, extra = {}) {
  ovBusy.add(r.key); ovRender();
  try {
    const value = await ovSessionRequest(r, action, extra);
    await ovFetch(ovList.find(e => e.id === r.comp));
    return value;
  } finally { ovBusy.delete(r.key); ovRender(); }
}
function ovSessionMenu(key) {
  const r = ovRecs().find(r => r.key === key);
  if (!r || r.fusion) return;
  const id = r.app === 'codex' ? `thread:${r.windowId}:${r.threadId}` : r.threadId;
  showAgentActions(id, r.title, null, r);
}
function ovStartBatch() {
  ovBatch ||= { selected: new Map(), running: false, cancelled: false, results: [], total: 0 };
  ovS.open = null;
  if (document.activeElement?.dataset?.ovInput) document.activeElement.blur();
  ovSaveHistory();
  ovRender();
}
function ovClearBatch() {
  if (ovBatch) ovBatch.cancelled = true;
  ovBatch = null;
}
function ovSelectSession(r) {
  if (!ovCanManage(r) || ovBatch.running) return;
  const id = ovSessionIdentity(r);
  if (ovBatch.selected.has(id)) ovBatch.selected.delete(id); else ovBatch.selected.set(id, r);
  ovRender();
}
function ovBatchHtml() {
  if (!ovBatch) return '';
  const b = ovBatch, disabled = !b.selected.size || b.running ? ' disabled' : '';
  const failed = b.results.filter(r => !r.ok);
  const report = b.total ? `<div class="ov-batch-report" role="status">${esc(I18N.tr(`已处理 ${b.results.length}/${b.total}，成功 ${b.results.length - failed.length}，失败 ${failed.length}`))}${failed.length ? `<details><summary>${esc(I18N.tr('失败详情'))}</summary>${failed.map(r => `<p>${esc(r.title)}：${esc(r.error)}</p>`).join('')}</details>` : ''}</div>` : '';
  return `<div class="ov-batch-head"><span>${esc(I18N.tr(`已选 ${b.selected.size} 个会话`))}</span><button data-ov="batch-all"${b.running ? ' disabled' : ''}>${ovT('全选当前范围')}</button></div>`
    + `<div class="ov-batch-actions"><button data-ov="batch-favorite"${disabled}>${ovT('批量收藏')}</button><button class="ov-danger" data-ov="batch-remove"${disabled}>${ovT('删除／归档')}</button><button data-ov="batch-exit">${ovT(b.running ? '停止剩余操作' : '退出管理')}</button></div>${report}`;
}
async function ovRunBatch(action) {
  const batch = ovBatch;
  if (!batch || batch.running || !batch.selected.size) return;
  const targets = [...batch.selected.values()].sort((a, b) => a.comp.localeCompare(b.comp) || a.app.localeCompare(b.app));
  if (action === 'remove' && !await ask(`删除或归档所选 ${targets.length} 个会话？\n逐条执行桌面端支持的操作，成功后无法通过取消恢复。`, '继续')) return;
  if (ovBatch !== batch) return;
  batch.running = true; batch.cancelled = false; batch.results = []; batch.total = targets.length;
  ovRender();
  try {
    for (const r of targets) {
      if (batch.cancelled) break;
      try {
        await ovManageSession(r, action, action === 'favorite' ? { favorite: true } : {});
        batch.results.push({ title: `${ovCompName(r.comp)} · ${r.title}`, ok: true });
        batch.selected.delete(ovSessionIdentity(r));
      } catch (error) { batch.results.push({ title: `${ovCompName(r.comp)} · ${r.title}`, ok: false, error: error.message }); }
      ovRender();
    }
  } finally { batch.running = false; ovRender(); }
}
function ovComposerReady(key = ovS.open) {
  return ovToolState?.key === key && ovToolState.phase === 'ready' && mode === 'chat'
    && winTargetReady(ovToolState.target) && ovToolState.sel === viewSel;
}
function ovToolInput() {
  if (!ovComposerReady() || document.body.classList.contains('conv')) return null;
  return document.querySelector('[data-ov-input="' + CSS.escape(ovToolState.key) + '"]');
}
function ovPaintComposerInput(input) {
  const value = ovComposerReady(input.dataset.ovInput) ? text.value : '';
  if (input.value !== value) {
    input.value = value;
    input.setSelectionRange(text.selectionStart, text.selectionEnd, text.selectionDirection);
  }
}
function ovReflectComposer() {
  if (!ovToolState || document.body.classList.contains('conv')) return;
  const input = ovToolInput();
  if (input) ovPaintComposerInput(input);
  ovRender();
}
document.addEventListener('composer-state', ovReflectComposer);
function ovReleaseComposer() {
  if (!ovToolState) return;
  const input = document.querySelector('[data-ov-input="' + CSS.escape(ovToolState.key) + '"]');
  if (input) mentionHide(input);
  mentionInput = text;
  ovToolState = null;
  ovMountComposerControls();
  finishWinBinding(new Error('目标会话已切换'));
}
function ovMountComposerControls() {
  let moved = false;
  const input = ovToolInput();
  for (const [id, node] of Object.entries(ovComposerControls)) {
    const parent = input ? $('ovBoard').querySelector(`[data-ov-control="${id}"]`)
      : id === 'attachments' ? document.querySelector('footer') : text.closest('.composerField');
    if (node.parentElement !== parent) {
      if (id === 'attachments' && !input) parent.prepend(node); else parent.append(node);
      if (id !== 'attachments') moved = true;
    }
  }
  if (moved) updateVoiceButton();
}
function ovPrepareVisibleComposer() {
  const input = $('ovBoard').querySelector('[data-ov-input]');
  if (input && ovToolState?.key !== input.dataset.ovInput) ovPrepareTools(input.dataset.ovInput);
}
function ovPrepareTools(key) {
  if (ovToolState?.key === key && (ovToolState.phase === 'binding' || ovComposerReady(key))) return ovToolState;
  const r = ovRecs().find(r => r.key === key);
  const state = ovToolState = { key, target: ovTarget(r), phase: 'binding' };
  const refresh = winTargetReady(state.target);
  ovErr.delete(key);
  mentionHide();
  state.ready = bindWin(state.target).then(() => {
    if (ovToolState !== state || ovS.open !== key || document.body.classList.contains('conv')) return false;
    state.phase = 'ready'; state.sel = viewSel;
    if (refresh) send({ t: 'attachments' });
    ovReflectComposer();
    return true;
  }, error => {
    if (ovToolState === state) { state.phase = 'error'; ovErr.set(key, error.message); ovRender(); }
    return false;
  });
  return state;
}
async function ovUseTool(key, tool) {
  const state = ovPrepareTools(key);
  if (tool === 'uploadDoc') return openDocumentPicker(state);
  if (!await state.ready || ovToolState !== state) return;
  const input = ovToolInput();
  if (tool === 'insertNewline') { endInputRecall(); insertComposerText('\n', input); }
  else if (tool === 'img') openImagePicker(state);
  else if (tool === 'add') openComposerAdd(input);
  else if (tool === 'send' || tool === 'sendNow') $(tool).click();
  else recallInput(tool === 'inputPrev' ? -1 : 1, input);
}
function ovLocateCard(reply = null) {
  const card = $('ovBoard').querySelector('.ov-open');
  if (!card) return;
  const origin = ovMain.getBoundingClientRect().top - ovMain.scrollTop;
  ovMain.scrollTop = Math.max(card.getBoundingClientRect().top - origin,
    reply ? reply.getBoundingClientRect().bottom - origin - ovMain.clientHeight : 0);
}
function ovLocateReply() {
  const input = document.activeElement;
  if (input?.dataset?.ovInput) ovLocateCard(input.closest('.ov-composer'));
}
function ovOpen(target) {
  if (target.project && !target.project.root) return status(ovT('尚未读取到项目路径，请在电脑上打开项目后重试'), false);
  const json = JSON.stringify(target), e = ovList.find(x => x.id === target.computer);
  if (e.c.key === currentComputer()?.key) return openWin(json);
  const here = rememberNotice(json);
  if (!here) return;
  if (target.project || !resumableComputerSocket(here)) pendingNotice = json;
  useComputer(loadComputers().findIndex(c => c.key === here.key));
}
function conversationVisible() { return document.visibilityState === 'visible' && document.body.classList.contains('conv'); }
function ovVisible() { if (authed) send({ t: 'visible', v: conversationVisible() }); }
function ovShowConversation() {
  if (document.body.classList.contains('conv')) return;
  ovClearBatch();
  ovSaveHistory();
  history.pushState({ ...ovHistory(), ovConv: true, ovDepth: (history.state?.ovDepth || 0) + 1 }, '');
  ovReleaseComposer();
  document.body.classList.add('conv');
  autosize(); ovVisible();
}
function ovConversationOpened(enter = true) { ovEnterRequested = enter; }
function ovEnterReady() {
  if (!ovEnterRequested || !authed || !windowReady || navigationPending) return;
  ovEnterRequested = false;
  ovShowConversation();
}
function ovLeave(st = history.state) {
  ovEnterRequested = false;
  document.body.classList.remove('conv');
  ovVisible();
  ovRestore(st);
}
function ovBackToBoard() {
  if (history.state?.ovConv && history.state.ovDepth > 0) return history.back();
  ovLeave();
  history.replaceState({ ...ovHistory(), ovDepth: 0 }, '');
}

let ovHold = null, ovHeld = '';
function ovCancelHold() { clearTimeout(ovHold?.timer); ovHold = null; }
$('overview').addEventListener('pointerdown', e => {
  if (e.target.closest('[data-ov="tool"][data-v="insertNewline"], .ov-mentions') && e.pointerType === 'mouse') e.preventDefault();
  ovCancelHold(); ovHeld = '';
  const card = e.target.closest('[data-ov-session]');
  if (!card || ovBatch || e.button !== 0 || e.target.closest('button, summary, input, textarea, a, [contenteditable], .ov-last')) return;
  const key = card.dataset.ovSession;
  ovHold = { x: e.clientX, y: e.clientY, timer: setTimeout(() => {
    ovHeld = key; ovCancelHold(); ovSessionMenu(key);
  }, 500) };
});
$('overview').addEventListener('pointermove', e => {
  if (ovHold && Math.hypot(e.clientX - ovHold.x, e.clientY - ovHold.y) > 10) ovCancelHold();
});
for (const event of ['pointerup', 'pointercancel']) addEventListener(event, ovCancelHold);
ovMain.addEventListener('scroll', ovCancelHold, { passive: true });
$('overview').addEventListener('click', e => {
  const more = $('ovBoard').querySelector('.ov-compose-more[open]');
  if (more && !more.contains(e.target)) more.open = false;
  if (e.target.closest('[data-ov-control]')) return;
  if (e.target.closest('.ov-mentions')) return pickMention(e);
  if (e.target.dataset.ovInput) return ovLocateReply();
  if (ovHeld && e.target.closest('[data-ov-session]')?.dataset.ovSession === ovHeld) { ovHeld = ''; e.preventDefault(); return; }
  const el = e.target.closest('[data-ov]');
  if (!el) return;
  const a = el.dataset.ov, id = el.dataset.id, v = el.dataset.v;
  switch (a) {
    case 'sess':
      if (ovBatch) return ovSelectSession(ovRecs().find(r => r.key === id));
      ovS.open = ovS.open === id ? null : id; ovSaveHistory(); return ovRender(true, undefined, !!ovS.open);
    case 'close': ovS.open = null; ovSaveHistory(); return ovRender(true);
    case 'lane': case 'jump': return ovFocusSession(id);
    case 'fold':
      if (ovCollapsed.has(id)) ovCollapsed.delete(id); else ovCollapsed.add(id);
      ovStOf(id).folded = ovCollapsed.has(id);
      ovSaveHistory();
      return ovRender(true);
    case 'group':
      if (ovExpanded.has(id)) ovExpanded.delete(id); else ovExpanded.add(id);
      ovSaveHistory();
      return ovRender(true);
    case 'proj': return ovMove({ comp: id.split('|')[0], proj: id, level: 'projects', open: null }, true);
    case 'level':
      store.set('ov-level', v);
      return ovMove({ level: v, comp: v === 'favorites' ? null : ovS.comp, proj: null, open: null });
    case 'batch-all':
      ovBatch.selected.clear();
      for (const r of ovScopedRecs().filter(ovCanManage)) ovBatch.selected.set(ovSessionIdentity(r), r);
      return ovRender();
    case 'batch-favorite': return ovRunBatch('favorite');
    case 'batch-remove': return ovRunBatch('remove');
    case 'batch-exit':
      if (ovBatch.running) ovBatch.cancelled = true; else ovBatch = null;
      return ovRender();
    case 'crumb':
      return ovMove({ open: null });
    case 'up': return ovUp();
    case 'menu': return showMainMenu();
    case 'computer-projects': return showComputerActions(id);
    case 'computer-editor': return openComputerFiles(id);
    case 'retry': return reconnectComputer(id);
    case 'auth': return authorizeComputer(id);
    case 'details': showConnectionDetails(id); return checkComputerConnection(id);
    case 'use': return useComputer(Number(v));
    case 'old': if (loadComputers()[Number(v)]?.key !== currentComputer()?.key) useComputer(Number(v)); return ovShowConversation();
    case 'ext': { const b = loadComputerBookmarks().find(x => x.id === id); return openComputerEntry(new URL('./', b.discovery).href, b.id); }
    case 'full':
      if (ovDone[id]) {
        delete ovDone[id];
        store.set('ov-done', JSON.stringify(ovDone));
        ovRender();
      }
      return ovOpen(JSON.parse(el.dataset.t));
    case 'open': return ovOpen(JSON.parse(el.dataset.t));
    case 'opt': return ovSend(id, 'opt', { index: Number(v.split(':')[1]) }, '已发送');
    case 'send': if (ovToolInput()?.dataset.ovInput === id) $('send').click(); return;
    case 'queue': return showQueuedMessages();
    case 'more': return;
    case 'tool':
      if (more) more.open = false;
      return ovUseTool(id, v);
    case 'accept': return ovSend(id, 'acceptAll', {}, '已接受改动');
  }
});
$('overview').addEventListener('change', e => {
  if (e.target.matches('[data-ov-computer]')) ovMove({ comp: e.target.value || null, proj: null, open: null });
});
$('overview').addEventListener('focusin', e => {
  const r = e.target.dataset.ovInput && ovRecs().find(r => r.key === e.target.dataset.ovInput);
  if (r) { ovEditing = { key: r.key, bucket: ovBucket(r) }; ovLocateReply(); }
});
$('overview').addEventListener('focusout', e => {
  const key = e.target.dataset.ovInput;
  if (!key) return;
  queueMicrotask(() => {
    if (ovEditing?.key !== key || document.activeElement?.dataset?.ovInput === key) return;
    ovEditing = null; ovPaint = ''; ovRender();
  });
});
$('overview').addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const more = e.target.closest('.ov-compose-more');
    if (more?.open) { more.open = false; more.querySelector('summary').focus(); }
  }
  if (ovBatch && ['Enter', ' '].includes(e.key) && e.target.dataset.ovSession) {
    e.preventDefault(); ovSelectSession(ovRecs().find(r => r.key === e.target.dataset.ovSession));
  }
});
for (const event of ['input', 'select', 'focusin', 'focusout', 'keydown', 'keyup', 'beforeinput', 'compositionstart', 'compositionend']) {
  $('overview').addEventListener(event, e => { if (e.target.dataset.ovInput) composerInputEvent(e); });
}
$('overview').addEventListener('paste', e => { if (e.target === ovToolInput()) pasteComposerFiles(e); });
$('ovBack').addEventListener('click', ovBackToBoard);
addEventListener('popstate', () => {
  const st = history.state;
  if (st?.viewer) return;
  if (st?.ovConv) {
    if (!document.body.classList.contains('conv')) { document.body.classList.add('conv'); ovMountComposerControls(); ovVisible(); }
    return;
  }
  if (document.body.classList.contains('conv')) return ovLeave(st);
  ovRestore(st);
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') ovPoll(); });
for (const [id, t] of [['ovBack', '返回概览'], ['ovUp', '上一级'], ['ovMenu', '菜单']]) $(id).setAttribute('aria-label', ovT(t));
const ovLayout = () => $('overview').classList.toggle('ov-landscape', innerWidth > innerHeight);
ovLayout();
addEventListener('resize', () => { ovLayout(); ovRender(); });
addEventListener('resize', ovLocateReply);
window.visualViewport?.addEventListener('resize', ovLocateReply);
window.visualViewport?.addEventListener('scroll', ovLocateReply);
ovPrune();
history.replaceState({ ...ovHistory(0), ovDepth: 0 }, '');
if (pendingNotice) ovConversationOpened();
else if (store.get('start-view') === 'conversation') {
  const c = currentComputer();
  if (c?.win) openWin(JSON.stringify({ computer: c.id, win: c.win, windowId: c.windowId || '', threadId: c.threadId || '' }));
  else ovConversationOpened();
}
ovRender();
ovPoll();
setInterval(ovPoll, 4000);
