/* ---------- overview: projects grouped by computer → sessions ---------- */
const OV_ROOT = { level: 'sessions', comp: null, proj: null, open: null };
const ovS = { ...OV_ROOT };
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
  '需要你': 'Needs you', '运行中': 'Running', '正在工作': 'Working', '已停止': 'Stopped', '已完成': 'Done', '空闲': 'Idle', '不活跃': 'Inactive', '全部会话': 'All sessions', '离线': 'Offline', '问题': 'Question',
  '等你确认': 'Waiting for you', '执行': 'Executing', '小修': 'Fixing', '已结束': 'Finished', '还没有配对的电脑': 'No paired computers yet',
  '打开项目': 'Open project', '个文件': 'files', '连接中…': 'Connecting…', '尚未连接': 'Not connected yet', '已发送': 'Sent', '操作失败': 'Action failed',
};
const ovT = s => I18N.lang === 'en' && OV_EN[s] || s;
const OV_ICON = {
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
};
const ovSt = new Map(), ovBusy = new Set(), ovErr = new Map(), ovDraft = new Map();
const ovCollapsed = new Set();
const ovExpanded = new Set();
const ovMain = $('overview').querySelector('.ov-main');
const ovDone = (() => { try { return JSON.parse(store.get('ov-done') || '{}'); } catch { return {}; } })();
let ovList = [], ovPaint = '', ovLaid = '', ovCrumbsPaint = '', ovSig = [], ovScroll;
const ovTn = new Map();
const ovTname = k => { let n = ovTn.get(k); if (!n) ovTn.set(k, n = 'ov-t' + (ovTn.size + 1)); return n; };

const ovFmt = ms => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; };
const ovAg = app => `<span class="ov-ag"><img class="on-dark" src="logo-${app}-dark.svg" alt=""><img class="on-light" src="logo-${app}-light.svg" alt=""></span>`;
const ovLogo = (inner, cls = '') => `<span class="ov-logo${cls}">${inner}</span>`;
const ovText = (raw, ui) => raw ? `<span class="ovRaw">${esc(raw)}</span>` : ui ? `<span>${ovT(ui)}</span>` : '';
const ovRecLogo = r => r.fusion ? ovLogo([r.a, r.b].filter(Boolean).map(ovAg).join(''), ' ov-duo') : ovLogo(ovAg(r.app));
const ovAgName = r => r.fusion ? `Fusion · ${[r.a, r.b].filter(Boolean).map(a => OV_AGENT[a] || a).join(' + ')}` : OV_AGENT[r.app] || r.app;
const ovTarget = x => ({ computer: x.comp, win: x.win, windowId: x.windowId, threadId: x.threadId || '' });
const ovNativeKey = (comp, s) => `${comp}|${s.windowId}|${s.threadId || s.win}`;
const ovRank = r => OV_RANK[r.state];
const ovRecency = r => Math.max(r.start || 0, r.ended || 0, r.used || 0);
const ovCount = recs => recs.reduce((k, r) => (k[r.state]++, k), { wait: 0, run: 0, err: 0, done: 0, idle: 0 });
const ovCompName = id => ovList.find(e => e.id === id)?.name || '';
const ovOn = e => ovSt.get(e.id)?.status === 'online';

function ovStOf(id) {
  let st = ovSt.get(id);
  if (!st) ovSt.set(id, st = { status: 'loading', data: null, offset: 0, seen: 0, fetched: false, prev: new Map(), first: new Map(), flight: null });
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
    ovRender();
  });
}
function ovFetch(e) {
  const st = ovStOf(e.id);
  return st.flight ||= ovLoad(e, st).catch(() => { if (st.status !== 'auth') st.status = 'offline'; }).finally(() => { st.flight = null; ovRender(); });
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
  let r = c.relay ? await ovRead(c, c.relay) : { down: true };
  if (r.down || r.auth || (r.data && r.data.id !== e.id)) {
    const relay = await relayOf({ ...c, discovery: c.discovery || new URL('url.json', location.href).href });
    if (relay !== c.relay) { updateComputerRecord({ ...c, relay }); r = await ovRead(c, relay); }
  }
  if (r.down) throw new Error('down');
  if (r.auth) { st.status = 'auth'; return; }
  if (r.old) { st.status = 'old'; return; }
  if (r.data.id !== e.id) throw new Error('id');
  st.offset = r.data.now - Date.now(); st.seen = Date.now(); st.status = 'online';
  ovApply(e, st, r.data);
}
function ovApply(e, st, data) {
  const first = !st.fetched, prev = st.prev, next = new Map();
  st.fetched = true; st.data = data;
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
  const off = st.status !== 'online', out = [];
  for (const s of st.data.sessions) {
    const key = ovNativeKey(e.id, s), done = ovDone[key], since = s.startedAt || st.first.get(key);
    out.push({ key, comp: e.id, off, state: s.waiting ? 'wait' : s.busy ? 'run' : done ? 'done' : 'idle', busy: !!s.busy, wait: s.waiting || '',
      waitText: s.waitingText || '', last: s.last || '', tasks: s.tasks, actions: s.actions || [], devin: !!s.devin, changed: s.changed || 0, acceptAll: !!s.acceptAll,
      win: s.win, windowId: s.windowId, threadId: s.threadId || '', app: s.app, title: s.title || '', project: `${e.id}|${s.windowId}`, projName: s.project,
      start: since ? since - st.offset : 0, ended: done || 0, used: s.lastUsed ? s.lastUsed - st.offset : 0, changes: s.changes || null, common: agentSessionCommon(s) });
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
function ovProjects(all) {
  const map = new Map();
  for (const e of ovList) {
    const st = ovSt.get(e.id);
    if (!st?.data) continue;
    for (const w of st.data.windows) map.set(`${e.id}|${w.windowId}`, { key: `${e.id}|${w.windowId}`, comp: e.id, win: w.win, windowId: w.windowId, app: w.app, name: w.project });
    if (st.status === 'online') map.set(`${e.id}|fusion`, { key: `${e.id}|fusion`, comp: e.id, win: 'fusion', windowId: 'fusion', app: 'fusion', name: 'Fusion' });
  }
  for (const r of all) if (!map.has(r.project)) map.set(r.project, { key: r.project, comp: r.comp, win: r.win, windowId: r.windowId, app: r.app, name: r.projName });
  return [...map.values()];
}
function ovBadge(r) {
  if (r.off) return ovT('离线');
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
  const st = ovSt.get(e.id), status = st?.status || 'loading', projects = projs.filter(p => p.comp === e.id), use = `data-ov="use" data-v="${e.index}"`;
  const recs = all.filter(r => r.comp === e.id);
  const collapsed = ovCollapsed.has(e.id);
  let attrs = '', badge = ovT('在线'), sub = '';
  if (e.foreign) { attrs = e.c ? use : `data-ov="ext" data-id="${esc(e.id)}"`; badge = '在其入口中打开'; }
  else if (status === 'auth') { attrs = use; badge = '需要重新连接'; }
  else if (status === 'old') { attrs = `data-ov="old" data-v="${e.index}"`; badge = '需要更新电脑端'; }
  else if (status === 'loading') { attrs = use; badge = ovT('连接中…'); }
  else if (status === 'offline') { badge = ovT('离线'); sub = st.seen ? `<span>最后在线 ${ovFmt(Date.now() - st.seen)} 前</span>` : `<span>${ovT('尚未连接')}</span>`; }
  else sub = ovS.level === 'projects' ? `<span>${projects.length} 个项目</span>` : `<span>${recs.length} 个会话</span>`;
  ovSig.push(`c:${e.id}:${status}:${collapsed}`);
  const meta = !attrs || sub ? `<span class="ov-computer-meta">${attrs ? '' : `<span>${badge}</span>`}${sub ? `<span class="ov-computer-detail">${sub}</span>` : ''}</span>` : '';
  const body = collapsed ? '' : ovS.level === 'projects' ? ovProjectTiles(projects, all, false) : ovSessions(recs, e.id);
  return `<section class="ov-computer" style="view-transition-name:${ovTname('c:' + e.id)}"><div class="ov-computer-row${status === 'online' ? ' online' : ''}"><button type="button" class="ov-computer-toggle" data-ov="fold" data-id="${esc(e.id)}" aria-expanded="${!collapsed}"><span class="ov-computer-dot" aria-hidden="true"></span><span class="ov-computer-name ovRaw">${esc(e.name)}</span>${meta}<svg class="ov-computer-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button>${attrs ? `<button type="button" class="ov-computer-action" ${attrs}>${badge}</button>` : ''}</div>${!collapsed ? `<div class="ov-board">${body || ovEmpty('这里还没有会话')}</div>` : ''}</section>`;
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
  const open = ovS.open === r.key, p = ovProgress(r), fill = p ? Math.round(p.done / p.total * 100) : 0;
  const cls = ['ov-tile', 'ov-session', `ov-st-${r.state}`, r.state === 'wait' && 'ov-wide', r.state === 'idle' && 'ov-compact', open && 'ov-open', r.off && 'ov-off'].filter(Boolean).join(' ');
  ovSig.push(`${r.key}:${cls}`);
  return `<div class="${cls}" style="--p:${fill}%;view-transition-name:${ovTname(r.key)}"${open ? '' : ` data-ov="sess" data-id="${esc(r.key)}"`}>
    ${ovRecLogo(r)}<span class="ov-badge">${esc(ovBadge(r))}</span>
    <div class="ov-title ovRaw">${esc(r.title)}</div>
    <div class="ov-context ovRaw">${esc(r.projName)} · ${esc(ovAgName(r))}</div>
    <div class="ov-now">${ovNowHtml(r)}</div>
    <div class="ov-foot"><span class="ov-num">${p ? `${p.done}<small>/${p.total}</small>` : ''}</span><span class="ov-time">${esc(ovTime(r))}</span></div>
    ${open ? `<button class="ov-close" data-ov="close" aria-label="关闭">${OV_ICON.x}</button><div class="ov-card">${ovCard(r)}</div>` : ovOpenLink(r, ' ov-direct')}
  </div>`;
}
function ovOpenLink(r, cls = '') {
  return `<button class="ov-link${cls}" data-ov="full" data-t="${esc(JSON.stringify(ovTarget(r)))}">${ovT('打开对话')} →</button>`;
}
function ovChangesRow(r) {
  const c = r.changes;
  if (!c) return '';
  const n = c.count != null ? `<span>${c.count} ${ovT('个文件')}</span>` : '';
  const a = c.add != null ? `<span class="ov-add">+${c.add}</span>` : '';
  const d = c.del != null ? `<span class="ov-del">−${c.del}</span>` : '';
  return n || a || d ? `<div class="ov-meta">${n}${a}${d}</div>` : '';
}
function ovCard(r) {
  const online = !r.off, dis = ovBusy.has(r.key) ? ' disabled' : '', key = esc(r.key);
  const status = `<div class="ov-status"><span class="ov-badge">${esc(ovBadge(r))}</span><span class="ovRaw">${esc(r.projName)} · ${esc(ovAgName(r))}</span><span class="ov-sp"></span><span class="ov-time">${esc(ovTime(r))}</span></div>`;
  const composer = r.devin && online ? `<div class="ov-composer"><input data-ov-input="${key}" placeholder="${r.state === 'wait' ? '或者输入你的回答…' : `告诉 ${OV_AGENT[r.app]} 下一步…`}" value="${esc(ovDraft.get(r.key) || '')}"${dis}><button class="ov-send" data-ov="send" data-id="${key}" aria-label="发送"${dis}>${OV_ICON.arrow}</button></div>` : '';
  let body;
  if (r.state === 'wait') {
    body = `<div class="ov-q">${ovNowHtml(r)}</div>` + (r.devin
      ? (r.actions.length ? `<div class="ov-opts">${r.actions.map(a => `<button class="ov-opt" data-ov="opt" data-id="${key}" data-v="${esc(a.id)}"${dis}>${ovText(a.label)}</button>`).join('')}</div>` : '') + composer
      : '<div class="ov-hint">请在对话中处理</div>');
  } else {
    const p = r.tasks && ovProgress(r);
    body = (p ? `<div class="ov-progress"><i style="width:${Math.round(p.done / p.total * 100)}%"></i></div><div class="ov-pmeta"><span><b>${p.done}</b><em>/${p.total} 项任务</em></span></div>${r.tasks.current ? `<div class="ov-cur">${ovText(r.tasks.current)}</div>` : ''}` : '')
      + (r.last ? `<div class="ov-last">${ovText(r.last)}</div>` : '')
      + ovChangesRow(r)
      + (r.fusion ? `<div class="ov-meta"><span>第 ${r.round} 轮</span><span>A · ${esc(OV_AGENT[r.a] || r.a)}</span><span>B · ${esc(OV_AGENT[r.b] || r.b)}</span></div>` : '')
      + composer
      + (r.devin && r.state === 'done' && r.acceptAll ? `<button class="ov-btn ov-pri" data-ov="accept" data-id="${key}"${dis}>接受改动</button>` : '');
  }
  const err = ovErr.has(r.key) ? `<div class="ov-errbox">${esc(ovErr.get(r.key))}</div>` : '';
  const off = r.off ? '<div class="ov-hint">电脑离线</div>' : '';
  return status + body + off + err + `<div class="ov-cfoot">${ovOpenLink(r)}</div>`;
}
function ovSessionGroup(label, recs, id) {
  if (!recs.length) return '';
  const expanded = ovExpanded.has(id);
  ovSig.push(`${id}:${expanded}`);
  return `<section class="ov-inactive"><button class="ov-inactive-toggle" data-ov="group" data-id="${esc(id)}" aria-expanded="${expanded}"><span>${ovT(label)} · ${recs.length}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 5 7 7-7 7"/></svg></button>${expanded ? `<div class="ov-inactive-grid">${recs.map(ovSessTile).join('')}</div>` : ''}</section>`;
}
function ovSessions(recs, scope) {
  const list = recs.slice().sort((a, b) => Math.min(ovRank(a), 3) - Math.min(ovRank(b), 3) || ovRecency(b) - ovRecency(a));
  const active = list.filter(r => ovRank(r) < 3), done = list.filter(r => r.state === 'done'), idle = list.filter(r => r.state === 'idle' && r.common), inactive = list.filter(r => r.state === 'idle' && !r.common);
  const sections = [['已完成', done], ['需要你', active.filter(r => r.state !== 'run')], ['进行中', active.filter(r => r.state === 'run')]];
  return sections.map(([label, rows]) => rows.length ? `<div class="ov-div">${ovT(label)} · ${rows.length}</div>${rows.map(ovSessTile).join('')}` : '').join('')
    + (ovS.proj ? idle.map(ovSessTile).join('') : ovSessionGroup('空闲', idle, scope + '|idle'))
    + ovSessionGroup('不常用', inactive, scope + '|inactive');
}
function ovEmpty(text) { return `<div class="ov-empty">${text}</div>`; }
function ovBoard(all, projs, scoped) {
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
  const focus = document.activeElement?.dataset?.ovInput, all = ovRecs(), projs = ovProjects(all);
  ovSig = [];
  const scoped = all.filter(r => (!ovS.comp || r.comp === ovS.comp) && (!ovS.proj || r.project === ovS.proj));
  const k = { ...ovCount(scoped), total: scoped.length, inactive: scoped.filter(r => r.state === 'idle' && !r.common).length }, anyWait = scoped.some(r => r.state === 'wait');
  const crumbs = [`<label class="ov-scope"><select class="ovRaw" data-ov-computer aria-label="${ovT('电脑范围')}"><option value=""${!ovS.comp ? ' selected' : ''}>${ovT('全部电脑')}</option>${ovList.map(e => `<option value="${esc(e.id)}"${ovS.comp === e.id ? ' selected' : ''}>${esc(e.name)}</option>`).join('')}</select><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></label>`];
  if (ovS.proj) crumbs.push(`<i>›</i><button data-ov="crumb" data-v="proj"><span class="ovRaw">${esc(projs.find(p => p.key === ovS.proj)?.name || '')}</span></button>`);
  const levels = [['sessions', ovT('概览'), OV_ICON.grid], ['projects', ovT('项目'), OV_ICON.folder]]
    .map(([v, l, ic]) => `<button class="ov-lv${ovS.level === v ? ' on' : ''}" data-ov="level" data-v="${v}"><i>${ic}${v === 'sessions' && anyWait && ovS.level !== 'sessions' ? '<span class="ov-dot"></span>' : ''}</i><span>${l}</span></button>`).join('');
  const summary = [['total', ovT('全部会话'), 'var(--fg-3)'], ['wait', ovT('需要你'), 'var(--ov-amber)'], ['run', ovT('运行中'), 'var(--accent)'], ['err', ovT('已停止'), 'var(--err)'], ['done', '今日完成', 'var(--ok)'], ['inactive', ovT('不常用'), 'var(--fg-4)']]
    .filter(([n]) => k[n]).map(([n, l, c]) => `<span><i class="ov-d" style="background:${c}"></i><b>${k[n]}</b><em>${l}</em></span>`).join('');
  const lane = ovS.level === 'sessions' || ovS.proj ? '' : scoped.filter(r => r.state === 'wait').sort((a, b) => ovRecency(b) - ovRecency(a))
    .map(r => `<div class="ov-lane-item" data-ov="lane" data-id="${esc(r.key)}">${ovRecLogo(r)}<span class="ovRaw">${esc(r.title)}</span><small>${esc(ovBadge(r))}</small></div>`).join('');
  const board = ovBoard(all, projs, scoped);
  const layout = [ovS.level, ovS.comp, ovS.proj, ovS.open, ovSig.join('|')].join('\u0001');
  const paint = [layout, crumbs.join(''), levels, summary, lane, board].join('\u0001');
  return { focus, up: !!(ovS.open || ovS.comp || ovS.proj), crumbs: crumbs.join(''), levels, summary, lane, board, layout, paint };
}
function ovCommit(p) {
  ovPaint = p.paint;
  ovLaid = p.layout;
  $('overview').classList.toggle('ov-project', !!ovS.proj);
  $('ovUp').classList.toggle('ov-hide', !p.up);
  if (ovCrumbsPaint !== p.crumbs) {
    $('ovCrumbs').innerHTML = p.crumbs;
    ovCrumbsPaint = p.crumbs;
  }
  $('ovLevels').innerHTML = p.levels;
  $('ovSummary').innerHTML = p.summary;
  $('ovLane').innerHTML = p.lane;
  $('ovLane').hidden = !p.lane;
  $('ovBoard').innerHTML = p.board;
  const input = p.focus && document.querySelector(`[data-ov-input="${CSS.escape(p.focus)}"]`);
  if (input) { input.focus({ preventScroll: true }); input.setSelectionRange(input.value.length, input.value.length); }
}
function ovRender(vt, scroll) {
  if (document.body.classList.contains('conv')) return;
  const p = ovPlan();
  if (scroll != null) ovScroll = scroll;
  if (p.paint === ovPaint) {
    if (scroll != null) {
      $('ovCrumbs').querySelector('[data-ov-computer]').value = ovS.comp || '';
      ovMain.scrollTop = ovScroll;
      ovScroll = undefined;
    }
    return;
  }
  const commit = (next = p) => {
    const top = ovScroll ?? ovMain.scrollTop;
    ovScroll = undefined;
    ovCommit(next);
    ovMain.scrollTop = top;
  };
  const motion = document.startViewTransition && !matchMedia('(prefers-reduced-motion:reduce)').matches;
  if (motion && (vt || (ovPaint && p.layout !== ovLaid))) document.startViewTransition(() => commit(ovPlan())).ready.catch(() => {});
  else commit();
}
function ovHistory(scroll = ovMain.scrollTop) {
  return { ov: { ...ovS }, ovCollapsed: [...ovCollapsed], ovExpanded: [...ovExpanded], ovScroll: scroll };
}
function ovSaveHistory() {
  history.replaceState({ ...history.state, ...ovHistory() }, '');
}
function ovRestore(st) {
  Object.assign(ovS, OV_ROOT, st?.ov);
  ovCollapsed.clear();
  for (const id of st?.ovCollapsed || []) ovCollapsed.add(id);
  ovExpanded.clear();
  for (const id of st?.ovExpanded || []) ovExpanded.add(id);
  ovRender(true, st?.ovScroll || 0);
}
function ovMove(change, push = false) {
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
  ovBusy.add(key); ovErr.delete(key); ovRender();
  try {
    const res = await fetch(e.c.relay + '/api/act', { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/json', ...await entryHeaders(e.c, 'POST', '/api/act') },
      body: JSON.stringify({ win: r.win, threadId: r.threadId, act, ...(act === 'acceptAll' ? {} : { question: r.wait }), ...extra }) });
    if (!res.ok) ovErr.set(key, I18N.tr((await res.json().catch(() => ({}))).error || ovT('操作失败')));
    else { if (extra.text !== undefined) ovDraft.delete(key); ovToast(`<span>${ovT(ok)}</span>`); ovFetch(e); }
  } catch { ovErr.set(key, I18N.tr('连接电脑失败，请重试')); }
  ovBusy.delete(key);
  ovRender();
}
function ovSubmit(key) {
  const text = (ovDraft.get(key) || '').trim();
  if (!text) return document.querySelector(`[data-ov-input="${CSS.escape(key)}"]`)?.focus();
  ovSend(key, 'reply', { text }, '已发送');
}
function ovOpen(target) {
  const json = JSON.stringify(target), e = ovList.find(x => x.id === target.computer);
  if (e.c.key === currentComputer()?.key) return openWin(json);
  const here = rememberNotice(json);
  if (!here) return;
  if (!resumableComputerSocket(here)) pendingNotice = json;
  useComputer(loadComputers().findIndex(c => c.key === here.key));
}
function conversationVisible() { return document.visibilityState === 'visible' && document.body.classList.contains('conv'); }
function ovVisible() { if (authed) send({ t: 'visible', v: conversationVisible() }); }
function ovShowConversation() {
  if (document.body.classList.contains('conv')) return;
  ovSaveHistory();
  history.pushState({ ...ovHistory(), ovConv: true, ovDepth: (history.state?.ovDepth || 0) + 1 }, '');
  document.body.classList.add('conv');
  ovVisible();
}
function ovConversationOpened() { ovShowConversation(); }
function ovLeave(st = history.state) {
  document.body.classList.remove('conv');
  ovVisible();
  ovRestore(st);
}
function ovBackToBoard() {
  if (history.state?.ovConv && history.state.ovDepth > 0) return history.back();
  ovLeave();
  history.replaceState({ ...ovHistory(), ovDepth: 0 }, '');
}

$('overview').addEventListener('click', e => {
  const el = e.target.closest('[data-ov]');
  if (!el) return;
  const a = el.dataset.ov, id = el.dataset.id, v = el.dataset.v;
  switch (a) {
    case 'sess': ovS.open = ovS.open === id ? null : id; ovSaveHistory(); return ovRender(true);
    case 'close': ovS.open = null; ovSaveHistory(); return ovRender(true);
    case 'lane': case 'jump': return ovFocusSession(id);
    case 'fold':
      if (ovCollapsed.has(id)) ovCollapsed.delete(id); else ovCollapsed.add(id);
      ovSaveHistory();
      return ovRender(true);
    case 'group':
      if (ovExpanded.has(id)) ovExpanded.delete(id); else ovExpanded.add(id);
      ovSaveHistory();
      return ovRender(true);
    case 'proj': return ovMove({ comp: id.split('|')[0], proj: id, level: 'projects', open: null }, true);
    case 'level': return ovMove({ level: v, proj: null, open: null });
    case 'crumb':
      return ovMove({ open: null });
    case 'up': return ovUp();
    case 'menu': return showMainMenu();
    case 'use': return useComputer(Number(v));
    case 'old': if (loadComputers()[Number(v)]?.key !== currentComputer()?.key) useComputer(Number(v)); return ovShowConversation();
    case 'ext': { const b = loadComputerBookmarks().find(x => x.id === id); return openComputerEntry(new URL('./', b.discovery).href, b.id); }
    case 'open': case 'full': return ovOpen(JSON.parse(el.dataset.t));
    case 'opt': return ovSend(id, 'opt', { index: Number(v.split(':')[1]) }, '已发送');
    case 'send': return ovSubmit(id);
    case 'accept': return ovSend(id, 'acceptAll', {}, '已接受改动');
  }
});
$('overview').addEventListener('change', e => {
  if (e.target.matches('[data-ov-computer]')) ovMove({ comp: e.target.value || null, proj: null, open: null });
});
$('overview').addEventListener('input', e => { if (e.target.dataset.ovInput) ovDraft.set(e.target.dataset.ovInput, e.target.value); });
$('overview').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing && e.target.dataset.ovInput) ovSubmit(e.target.dataset.ovInput); });
$('ovBack').addEventListener('click', ovBackToBoard);
addEventListener('popstate', () => {
  const st = history.state;
  if (st?.viewer) return;
  if (st?.ovConv) {
    if (!document.body.classList.contains('conv')) { document.body.classList.add('conv'); ovVisible(); }
    return;
  }
  if (document.body.classList.contains('conv')) return ovLeave(st);
  ovRestore(st);
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') ovPoll(); });
for (const [id, t] of [['ovBack', '返回概览'], ['ovUp', '上一级'], ['ovMenu', '菜单']]) $(id).setAttribute('aria-label', ovT(t));
const ovLayout = () => $('overview').classList.toggle('ov-landscape', innerWidth > innerHeight);
ovLayout();
addEventListener('resize', ovLayout);
ovPrune();
history.replaceState({ ...ovHistory(0), ovDepth: 0 }, '');
if (pendingNotice) ovShowConversation();
else if (store.get('start-view') === 'conversation') {
  const c = currentComputer();
  if (c?.win) openWin(JSON.stringify({ computer: c.id, win: c.win, windowId: c.windowId || '', threadId: c.threadId || '' }));
  else ovShowConversation();
}
ovRender();
ovPoll();
setInterval(ovPoll, 4000);
