/* ---------- chat view ---------- */
const list = $('list'), itemsEl = $('items');
const cache = new Map();
$('cachedMore').onclick = () => loadOlderMessages();
itemsEl.addEventListener('click', async e => {
  const copy = e.target.closest('[data-copy-message]');
  if (copy) { await copyText(copy.closest('.msg').copyText, copy, false); return; }
  const fold = e.target.closest('[data-fold]');
  if (fold) {
    const turn = fold.dataset.fold, fromEnd = fold.classList.contains('endFold');
    scFold(turn);
    if (fromEnd) requestAnimationFrame(() => itemsEl.querySelector(`[data-i="${CSS.escape(turn)}"]`)?.scrollIntoView({ block: 'center' }));
    return;
  }
  const rv = e.target.closest('[data-revert]');
  if (rv) {
    if (!await ask('回退到这条消息？之后的对话和文件改动会被撤销。', '回退')) return;
    send({ t: 'revert', i: rv.dataset.revert });
    return;
  }
  const tr = e.target.closest('[data-ttoggle]');
  if (tr && !e.target.closest('[data-file]')) {
    const box = tr.closest('.toolrow');
    box.classList.toggle('open');
    const chev = tr.querySelector('.chev');
    if (chev) chev.textContent = box.classList.contains('open') ? '▾' : '▸';
    if (pinnedBottom) { list.scrollTop = list.scrollHeight; requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; }); }
    return;
  }
  const b = e.target.closest('[data-think]');
  if (!b) return;
  const box = b.closest('.thinking');
  const body = box?.querySelector('.thb');
  const next = !box.classList.contains('open');
  thinkingPref.set(viewSel + '|' + b.dataset.think, next);
  box.classList.toggle('open', next);
  b.querySelector('.tha').textContent = next ? '收起' : '展开';
  if (body) body.hidden = !next;
  // Devin thoughts beyond the payload budget arrive title-only; fetch the body on first open.
  if (next && b.dataset.more && !thoughtFull.has(b.dataset.think)) {
    requestThought(b.dataset.think);
  }
});
const thoughtFull = new Map();
function requestThought(id) {
  if (thoughtFull.has(id)) return;
  thoughtFull.set(id, undefined);
  const body = itemsEl.querySelector(`[data-think="${CSS.escape(id)}"]`)?.closest('.thinking')?.querySelector('.thb');
  if (body) { body.textContent = '加载中…'; body.classList.add('loading'); }
  send({ t: 'thought', i: id });
}
const thoughtObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.target.isConnected) { thoughtObserver.unobserve(entry.target); continue; }
    if (!entry.isIntersecting || !entry.target.classList.contains('open')) continue;
    thoughtObserver.unobserve(entry.target);
    requestThought(entry.target.querySelector('[data-think]').dataset.think);
  }
}, { root: list, rootMargin: '100px' });
function onThought(m) {
  thoughtFull.set(m.i, m.text ?? null);
  const box = document.querySelector(`[data-think="${CSS.escape(m.i)}"]`)?.closest('.thinking')?.querySelector('.thb');
  if (!box) return;
  box.classList.remove('loading');
  box.textContent = m.text ?? '内容未保存';
}

function buttonsHtml(labels, item, actions = []) {
  return labels.map((l, n) =>
    `<button class="${PRIMARY.test(l) ? 'primary' : ''}" data-item="${esc(item)}" data-n="${n}" data-action-id="${esc(actions[n] || '')}" data-action-label="${esc(l)}">${esc(l)}</button>`).join('');
}

function thinkingTitle(raw) {
  const line = (raw || '').split('\n')[0].trim();
  if (/^thinking$/i.test(line)) return '思考中';
  if (/^thoughts$/i.test(line)) return '思考';
  const m = /^thought(?: for)?\s+(.+)$/i.exec(line);
  if (m) return `思考了 ${m[1]}`;
  return line || '思考';
}
const SVG = 'width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
const ICON = {
  brain: `<svg class="brain" ${SVG}><path d="M6 2a2.5 2.5 0 0 0-2.5 2.5c0 .4.1.8.3 1.1A2.8 2.8 0 0 0 2.5 8c0 1 .5 1.9 1.4 2.4A2.6 2.6 0 0 0 6 14.2c.9.3 1.9-.2 2-1.2V3.2C8 2.5 7.1 2 6 2Z"/><path d="M10 2a2.5 2.5 0 0 1 2.5 2.5c0 .4-.1.8-.3 1.1A2.8 2.8 0 0 1 13.5 8c0 1-.5 1.9-1.4 2.4a2.6 2.6 0 0 1-2.1 3.8c-.9.3-1.9-.2-2-1.2V3.2C8 2.5 8.9 2 10 2Z"/></svg>`,
  search: `<svg class="ticon" ${SVG}><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/></svg>`,
  read: `<svg class="ticon" ${SVG}><path d="M4 1.5h5L12 4.5V14.5H4z"/><path d="M9 1.5v3h3"/><path d="M6 8h4M6 10.5h4"/></svg>`,
  explore: `<svg class="ticon" ${SVG}><path d="M1.5 3.5h4l1.8 2h7.2v8h-13z"/></svg>`,
  command: `<svg class="ticon" ${SVG}><path d="M3 4l4 4-4 4"/><path d="M8.5 12.5H13"/></svg>`,
  edit: `<svg class="ticon" ${SVG}><path d="M9.5 2.5 13.5 6.5 6 14l-4.2.8L2.5 11z"/></svg>`,
  other: `<svg class="ticon" ${SVG}><circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2"/></svg>`,
};
const TOOL_LABEL = { search: 'Searched', explore: 'Explored', read: 'Read', command: 'Command', edit: 'Edited' };
const thinkingPref = new Map();
function thinkingWantOpen(it) {
  const key = viewSel + '|' + it.i;
  if (thinkingPref.has(key)) return thinkingPref.get(key);
  return true;
}
function paintThinking(el, it) {
  const open = thinkingWantOpen(it);
  el.classList.toggle('live', !!it.live);
  el.classList.toggle('open', open);
  let rest = (it.t || '').split('\n').slice(1).join('\n');
  const full = thoughtFull.get(it.i);
  if (!rest && typeof full === 'string') rest = full;
  const more = !!it.more && !rest;
  let btn = el.querySelector('.thbtn');
  let box = el.querySelector('.thb');
  if (!btn || !box) {
    el.innerHTML = `<button type="button" class="thbtn" data-think="">${it.src === 'devin' ? ICON.brain : ''}<span class="tht"></span><span class="tha"></span></button><div class="thb"></div>`;
    btn = el.querySelector('.thbtn');
    box = el.querySelector('.thb');
  }
  btn.dataset.think = rest || more ? it.i : '';
  btn.dataset.more = more ? '1' : '';
  btn.querySelector('.tht').textContent = thinkingTitle(it.t);
  btn.querySelector('.tha').textContent = rest || more ? (open ? '收起' : '展开') : '';
  const follow = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
  if (box.textContent !== rest) box.textContent = rest;
  box.hidden = !open;
  if (open && more && !thoughtFull.has(it.i)) thoughtObserver.observe(el);
  if (open && it.live && follow) box.scrollTop = box.scrollHeight;
}

// Rich tool rows (Devin transcript): icon + bold label + optional chips / duration /
// expandable command or diff. Tap the row to expand; file chips open the file viewer.
function renderTool(el, it) {
  const icon = ICON[it.kind] || ICON.other;
  const fileRef = (f, r) => f + (r ? ':' + ((String(r).match(/\d+/) || [''])[0]) : '');
  const chips = (it.chips || []).map((c, index) => {
    const isFile = it.f && (c === it.f || c.startsWith(it.f + ' ') || c.startsWith(it.f + '#'));
    const path = it.chipFiles?.[index] || (isFile ? fileRef(it.f, it.r) : '');
    return `<code class="chip"${path ? ` data-file="${esc(path)}"` : ''}>${esc(c)}${isFile && it.r ? ' ' + esc(it.r) : ''}</code>`;
  }).join('');
  if (it.kind === 'command') {
    const cmd = it.cmd || '';
    const output = it.output || '';
    el.innerHTML = `<div class="trow toggle" data-ttoggle>${icon}<span class="tl">${esc(it.t || TOOL_LABEL.command)}</span>${it.d ? `<span class="dur">${esc(it.d)}</span>` : ''}${cmd || output ? '<span class="chev">▸</span>' : ''}</div>`
      + (cmd ? `<pre class="tcmd">${esc(cmd)}</pre>` : '')
      + (output ? `<pre class="tcmd">${esc(output)}</pre>` : '');
    return;
  }
  if (it.kind === 'edit') {
    const diff = (it.diff || []).map(([ty, text]) => `<div class="dl ${ty === '+' ? 'di' : ty === '-' ? 'dd' : ty === '…' ? 'dm' : ''}">${esc(ty === '…' ? text : ty + ' ' + text)}</div>`).join('');
    el.innerHTML = `<div class="trow toggle" data-ttoggle>${icon}<span class="tl">${esc(TOOL_LABEL.edit)}</span><code class="chip" data-file="${esc(it.f || '')}">${esc(it.f || '')}</code>`
      + `<span class="stat add">+${it.add || 0}</span><span class="stat del">-${it.del || 0}</span><span class="chev">▾</span></div>`
      + `<div class="tdiff">${diff}</div>`;
    return;
  }
  const label = TOOL_LABEL[it.kind] || ((it.t || '').match(/^\S+/) || [''])[0];
  const rest = (it.t || '').replace(/^\S+\s*/, '');
  el.innerHTML = `<div class="trow">${icon}<span class="tl">${esc(label)}</span><span class="tsub">${esc(rest)}</span></div>`
    + (chips ? `<div class="chips">${chips}</div>` : '');
}

// Devin's todo list ("N / M tasks done"): progress bar + checklist; the same markup feeds the Tasks sheet.
const taskOpen = new Set();
const TASK_ICON = { done: '✓', in_progress: '◐', pending: '○' };
function tasksHtml(it) {
  const pct = it.total ? Math.round(it.done / it.total * 100) : 0;
  const list = (it.items || []).map(x => `<li class="${esc(x.status)}"><span class="ti">${TASK_ICON[x.status] || '○'}</span><span class="tt">${esc(x.t)}</span></li>`).join('');
  return `<div class="tprog"><i style="width:${pct}%"></i></div>` + (list ? `<ul class="tlist">${list}</ul>` : '');
}
function renderItem(it) {
  const el = document.createElement('div');
  el.className = 'msg ' + it.k;
  if (it.k === 'notice') { el.textContent = it.t; el.setAttribute('role', 'status'); el.classList.toggle('live', !!it.live); return el; }
  if (it.k === 'tasks') { el.innerHTML = `<details class="tcard" data-task="${esc(it.i)}" ${taskOpen.has(it.i) ? 'open' : ''}><summary class="tprog-head">${I18N.tr('任务')} ${it.done}/${it.total}</summary>${tasksHtml(it)}</details>`; return el; }
  if (it.k === 'human') {
    const mh = it.src === 'devin' ? mathHtml(it.t || '') : null;
    el.copyText = it.t || '';
    const stamp = it.sentAt ? new Date(it.sentAt) : null;
    const time = stamp ? `<time datetime="${stamp.toISOString()}" title="${esc(stamp.toLocaleString())}">${esc(stamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }))}</time>` : '';
    el.innerHTML = `<div class="humanContent"><div class="bubble">${mh?.any ? mh.html : esc(it.t || '')}</div><div class="messageMeta">${time}<button data-copy-message>复制</button></div></div>`;
    if (mh?.any) typesetMath(el);
    if (it.src === 'devin') el.insertAdjacentHTML('beforeend', `<div class="rv"><button class="foldBtn" data-fold="${esc(it.i)}" title="折叠这一轮">▾</button><span class="turnSum"></span><button class="revertBtn" data-revert="${esc(it.i)}">回到这里</button></div>`);
  }
  // it.h comes from the whitelist sanitizer in server/page/common.js (clean): plain tags only, text escaped.
  else if (it.k === 'assistant') { el.innerHTML = it.h || ''; dressMessage(el); }
  else if (it.k === 'thinking') paintThinking(el, it);
  else if (it.k === 'tool') {
    if (it.kind && (it.src === 'devin' || it.src === 'codex')) { renderTool(el, it); el.classList.add('toolrow'); if (it.kind !== 'command') el.classList.add('open'); }
    else {
      el.innerHTML = `<div class="txt">${esc(it.t || '')}</div>`;
      if (it.f) el.dataset.file = it.f;
    }
  }
  else el.textContent = it.t || '';
  if (it.agents?.length) el.insertAdjacentHTML('beforeend', `<div class="btns">${it.agents.map(a => `<button data-codex-agent="${esc(a.id)}">查看 ${esc(a.title)}</button>`).join('')}</div>`);
  if (it.images?.length) el.insertAdjacentHTML('beforeend', it.images.filter(src => /^(https?:|data:image\/)/.test(src)).map(src => `<a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt="生成的图片" style="max-width:100%;border-radius:8px"></a>`).join(''));
  if (it.b && it.k !== 'human') el.insertAdjacentHTML('beforeend', `<div class="btns">${buttonsHtml(it.b, it.btnItem || it.i, it.actions)}</div>`);
  if (it.k !== 'human') addImageCopyButtons(el);
  return el;
}

const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 120;

// pickMenu has no completion message until the relay restarts, so clear "切换中…"
// when the composer model/mode actually changes, or after a short fallback.
let switchWatch = null;
let switchTimer = 0;
function clearSwitchWatch() {
  switchWatch = null;
  clearTimeout(switchTimer);
}
function beginSwitch(kind) {
  switchWatch = {
    kind,
    model: lastChat?.model || '',
    mode: lastChat?.mode || '',
    sig: JSON.stringify((lastChat?.items || []).map(i => i.i)),
  };
  clearTimeout(switchTimer);
  switchTimer = setTimeout(() => {
    if (!switchWatch) return;
    switchWatch = null;
    const cur = $('msg').textContent;
    if (cur === '切换中…' || cur === 'Switching…') status('已切换');
  }, 6000);
  status('切换中…');
}
function noteSwitch(chat) {
  const w = switchWatch;
  if (!w || !chat) return;
  const cur = $('msg').textContent;
  if (cur !== '切换中…' && cur !== 'Switching…') return clearSwitchWatch();
  const changed = w.kind === 'model' ? (chat.model || '') !== w.model
    : w.kind === 'mode' ? (chat.mode || '') !== w.mode
    : JSON.stringify((chat.items || []).map(i => i.i)) !== w.sig;
  if (!changed) return;
  clearSwitchWatch();
  status(w.kind === 'model' && chat.model ? `已切换到 ${chat.model}` : '已切换');
}

let lastChat = null, mirroredDraft = '';
const submittedMessages = [], messageTimes = new Map(), generationClocks = new Map();
const messageScope = () => [currentComputer()?.id || '', currentApp, currentComputer()?.windowId || ''].join('|');
const generationKey = chat => messageScope() + '|' + (chat?.thread || '');
let activeGeneration = '';
function withMessageTimes(chat) {
  if (!chat) return chat;
  const scope = messageScope();
  return { ...chat, items: chat.items.map(it => {
    if (it.k !== 'human') return it;
    const key = generationKey(chat) + '|' + it.i;
    if (!messageTimes.has(key)) {
      const index = submittedMessages.findIndex(m => m.scope === scope && (!m.thread || m.thread === chat.thread) && !m.before.has(it.i)
        && ((it.t || '').trim() === m.text.trim() || (it.t || '').startsWith(m.text + '\n\n附加文件（')));
      if (index >= 0) {
        const receipt = submittedMessages.splice(index, 1)[0];
        messageTimes.set(key, it.sentAt || receipt.sentAt);
      }
    }
    const sentAt = it.sentAt || messageTimes.get(key);
    return sentAt ? { ...it, sentAt } : it;
  }) };
}
function paintGenerationTime() {
  const clock = generationClocks.get(activeGeneration);
  const el = $('elapsed');
  el.hidden = mode !== 'chat' || activeGeneration !== generationKey(lastChat) || !clock?.start;
  if (el.hidden) return;
  const seconds = Math.max(0, Math.floor(((clock.end || Date.now()) - clock.start) / 1000));
  const parts = [Math.floor(seconds / 60), seconds % 60];
  if (seconds >= 3600) parts.splice(0, 1, Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60);
  el.textContent = I18N.tr('耗时') + ' ' + parts.map(n => String(n).padStart(2, '0')).join(':');
}
function updateGenerationTime(chat, stale) {
  const key = generationKey(chat);
  if (key !== activeGeneration && generationClocks.get(activeGeneration)?.start && !generationClocks.get(activeGeneration).end) generationClocks.delete(activeGeneration);
  activeGeneration = key;
  if (chat && !stale) {
    const previous = generationClocks.get(activeGeneration);
    let clock = previous || { start: null, end: null };
    if (chat.generation?.start && (!chat.busy || !chat.generation.end)) clock = { ...chat.generation };
    else if (previous && chat.busy && !previous.busy) clock = { start: Date.now(), end: null };
    else if (previous?.start && previous.busy && !chat.busy && !clock.end) clock = { ...clock, end: Date.now() };
    generationClocks.set(activeGeneration, { ...clock, busy: !!chat.busy });
  }
}
setInterval(paintGenerationTime, 1000);
const chatBySel = new Map(), menuCache = new Map();
const lruPut = (map, key, val, max) => { map.delete(key); map.set(key, val); while (map.size > max) map.delete(map.keys().next().value); };
let menuSheetKind = '', chatStale = false;
let currentProject = '', currentTerminal = '';
function updateTitle() {
  const first = lastChat?.items?.find(it => it.k === 'user');
  const conversation = mode === 'terminal' ? currentTerminal : (lastChat?.title || first?.t || '');
  $('titleText').textContent = currentAppName || '连接中…';
  const plan = appPlans[currentApp] || '';
  $('titlePlan').textContent = plan;
  $('titlePlan').hidden = !plan;
  $('titleProject').textContent = cleanWindowTitle(currentProject).replace(/\s+-\s+Devin(?:\s+-.*)?$/, '') || conversation.split('\n')[0].slice(0, 40);
  $('title').title = [cleanWindowTitle(currentProject), conversation].filter(Boolean).join(' · ');
}
// Devin sessions: each session has its own rows, thought bodies, tasks, questions and queue. When the desktop
// shows another session, drop everything cached for the old one so the two never mix in one scroll.
let curSessKey = null;
function paintSessions(chat) {
  const s = chat?.session || null, bar = $('sessBar');
  const key = s?.key ? scKeyFor(s.key) : null;
  const changed = key !== curSessKey;
  if (changed) {
    curSessKey = key;
    thoughtObserver.disconnect();
    cache.clear();
    thoughtFull.clear();
    qnSig = '';
    latestTasks = null;
    scSwitch(s?.key || null);
    itemsEl.replaceChildren();
    list.scrollTop = list.scrollHeight;
  }
  const tabs = s?.tabs || [];
  for (const t of tabs) if (t.id) scSetTitle(scKeyFor(t.id), t.title);
  if (key) scSetTitle(key, s.title);
  bar.hidden = !s || !tabs.length;
  const chipsHtml = tabs.map(t => `<span class="sessTab ${t.active ? 'on' : ''}"><button class="sessChip ${t.active ? 'on' : ''}" data-sess="${esc(t.id)}" title="${esc(t.title)}">${esc(t.title)}</button>${tabs.length > 1 ? `<button class="sessX" data-sessx="${esc(t.id)}" title="关闭会话标签" aria-label="关闭会话标签">✕</button>` : ''}</span>`).join('');
  if (bar._sig !== chipsHtml) {
    bar._sig = chipsHtml;
    bar.innerHTML = chipsHtml;
    bar.querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  return changed;
}
$('sessBar').onclick = async e => {
  const x = e.target.closest('[data-sessx]');
  if (x) {
    if (!await ask(`关闭会话标签「${x.closest('.sessTab').querySelector('.sessChip').title}」？\n会话本身不会删除，之后还能从「会话」里重新打开。`, '关闭')) return;
    status('正在关闭会话标签…');
    return send({ t: 'closeTab', id: x.dataset.sessx });
  }
  const b = e.target.closest('[data-sess]');
  if (!b || b.classList.contains('on')) return;
  status('正在切换会话…');
  send({ t: 'openAgent', id: `tab:${b.dataset.sess}` });
};
