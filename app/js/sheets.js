/* ---------- bottom sheet ---------- */
let sheetKind = null;
let pendingAgentOpen = '';
const agentOpened = JSON.parse(store.get('agent-opened') || '{}');
const agentOpenedKey = thread => `${currentComputer()?.id || ''}|${currentAppName}|${thread}`;
function rememberAgentOpen(m) {
  const target = /^(?:thread|win|new):([^:]+)(?::(.+))?$/.exec(pendingAgentOpen);
  const matched = m.app === 'codex' ? target && m.windowId === target[1] && (!target[2] || m.threadId === target[2]) : pendingAgentOpen === m.threadId;
  if (!m.closed && pendingAgentOpen && matched && m.threadId) {
    agentOpened[agentOpenedKey(m.threadId)] = Date.now();
    store.set('agent-opened', JSON.stringify(agentOpened));
    pendingAgentOpen = '';
  }
}
function openSheet(kind, html) {
  sheetKind = kind;
  $('sheet').innerHTML = html;
  $('shade').classList.add('open');
  $('sheet').classList.add('open');
  if (kind === 'agents') $('sheet').scrollTop = 0;
}
function closeSheet() {
  menuRequest++;
  if (sheetKind === 'codex-settings') { codexSettingsRequest++; send({ t: 'closeCodexSettings' }); status(''); }
  sheetKind = null; menuSheetKind = '';
  $('shade').classList.remove('open');
  $('sheet').classList.remove('open');
}
$('shade').onclick = () => { closeSheet(); askDone?.(false); };

// Confirmation for anything that interrupts the Agent or throws work away; resolves false if dismissed.
let askDone = null;
function ask(question, ok = '确定') {
  askDone?.(false);
  return new Promise(resolve => {
    askDone = v => { askDone = null; resolve(v); };
    openSheet('ask', `<h3 class="askQ">${esc(question)}</h3><div class="askBtns">`
      + `<button id="askNo">取消</button><button id="askOk" class="danger">${esc(ok)}</button></div>`);
    $('askOk').onclick = () => { closeSheet(); askDone?.(true); };
    $('askNo').onclick = () => { closeSheet(); askDone?.(false); };
  });
}
// Buttons on Cursor's own cards that stop, reject or discard work.
const RISKY = /^(stop|reject|deny|undo|discard|revert|cancel|delete|remove|停止|拒绝|撤销|丢弃|取消|删除)/i;

const KIND_TAG = { agents: 'Agents', ssh: 'SSH', local: '本地' };

// Cursor titles look like "file.py — Folder [SSH: host]"; the window is identified by folder (+ host), not the open file.
function cleanWindowTitle(title) {
  return String(title || '').replace(/\s*\[(?:Administrator|Administer)\]/gi, '').trim();
}
function winLabel(title) {
  title = cleanWindowTitle(title);
  const windowsTitle = /\s+-\s+(?:Cursor|Devin|Visual Studio Code)$/.test(title);
  title = title.replace(/\s+-\s+(?:Cursor|Devin|Visual Studio Code)$/, '');
  const host = /\[SSH: ([^\]]+)\]/.exec(title)?.[1];
  const parts = title.replace(/\s*\[SSH: [^\]]+\]\s*$/, '').split(windowsTitle ? / — | - / : ' — ').map(s => s.replace(/^●\s*/, '').trim());
  const folder = parts.pop() || title;
  return { name: host ? `${folder} · ${host}` : folder, file: parts.join(' — ') };
}

function showWindows() {
  const rows = windows.map(w => {
    const software = { cursor: 'Cursor', devin: 'Devin', codex: 'Codex', fusion: 'Fusion' }[w.app] || w.app;
    const plan = appPlans[w.app] ? `<span class="winPlan">${esc(appPlans[w.app])}</span>` : '';
    return `<button class="opt ${w.id === currentWindow ? 'cur' : ''}" data-win="${esc(w.id)}"><span class="lbl">${esc(software)}${plan}</span></button>`;
  }).join('');
  openSheet('windows', `<h3>切换窗口</h3>${rows || '<div class="hint">没有找到窗口</div>'}`);
}

const FUSION_PHASE = { idle: '待开始', planning: '正在生成方案', plan: '方案待确认', execute: '正在执行方案', review: '正在检查结果', fix: '正在小修', disagree: '方案待确认', check: '请选择下一步', stopped: '未完成，已停止', done: '完成' };
function paintFusion(fx) {
  const on = !!fx;
  $('fusionConfig').hidden = !on;
  $('fusionBar').hidden = !on;
  document.body.classList.toggle('fusion', currentApp === 'fusion');
  $('fusionHeader').hidden = currentApp !== 'fusion';
  $('fusionWelcome').hidden = !on || !!lastChat?.items?.length;
  $('newChat').hidden = on;
  $('meters').hidden = currentApp === 'fusion';
  if (on) { $('pickModel').hidden = true; $('pickAgents').hidden = true; $('pickMode').hidden = true; }
  else $('pickAgents').hidden = false;
  if (!on) return;
  renderFusionMeters(fx);
  $('fusionProject').textContent = '项目 ▾';
  $('fusionProject').title = fx.project?.root || '';
  $('fusionProject').disabled = !!fx.busy;
  for (const side of ['a', 'b']) {
    $('fusion' + side.toUpperCase()).disabled = !fx.project || !!fx.busy;
    $('fusionModel' + side.toUpperCase()).disabled = !fx.project || !!fx.busy;
  }
  const short = s => String(s || '').slice(0, 28);
  const roleTitle = s => `${({ codex: 'Codex', cursor: 'Cursor', devin: 'Devin' })[s.app] || s.app} · ${cleanWindowTitle(s.conversationTitle || s.title)}`;
  for (const side of ['a', 'b']) {
    const label = side.toUpperCase(), spec = fx[side];
    $('fusion' + label).title = spec ? roleTitle(spec) : `选择 ${label}`;
    $('fusionModel' + label).textContent = `${label} 模型 ▾`;
    $('fusionModel' + label).title = spec?.model || `${label} 模型`;
  }
  const acts = fx.phase === 'plan' ? '<button type="button" data-fusion-act="go">执行方案</button>'
    : fx.phase === 'disagree' ? '<button type="button" data-fusion-act="go">按 A 的说明继续</button>'
    : fx.phase === 'check' ? '<button type="button" data-fusion-act="done">完成</button><button type="button" data-fusion-act="fix">小修</button><button type="button" data-fusion-act="return">退回 B</button>'
    : '';
  $('fusionBar').hidden = fx.phase === 'idle';
  $('fusionBar').innerHTML = `<span class="hint">第 ${fx.round || 0} 轮 · ${FUSION_PHASE[fx.phase] || fx.phase}</span>${acts}`;
}
function showFusionProjects(m) {
  finishPending(['正在读取项目…']);
  if (m.browse) {
    const b = m.browse;
    const dirs = (b.dirs || []).map(d => `<button class="opt" data-fusion-dir="${esc(d.path)}"><span class="lbl">${esc(d.name)}</span></button>`).join('');
    return openSheet('fusion-project', `<h3>选择项目目录</h3><div class="hint">${esc(b.path)}</div><button class="opt" data-fusion-folder="${esc(b.path)}"><span class="lbl">选择此目录</span></button>${b.parent ? `<button class="opt" data-fusion-dir="${esc(b.parent)}"><span class="lbl">上级目录</span></button>` : ''}<button class="opt" data-fusion-path><span class="lbl">输入文件夹路径</span></button>${(b.drives || []).map(d => `<button class="opt" data-fusion-dir="${esc(d)}"><span class="lbl">${esc(d)}</span></button>`).join('')}${dirs}`);
  }
  openSheet('fusion-project', `<h3>选择 Fusion 项目</h3><button class="opt" data-fusion-dir=""><span class="lbl">＋ 选择本地目录</span></button>${(m.list || []).map(p => `<button class="opt ${p.id === lastChat?.fusion?.project?.id ? 'cur' : ''}" data-fusion-project="${esc(p.id)}"><span class="lbl">${esc(p.name)}<span class="sub">${esc(p.host ? p.host + ':' + p.root : p.root)}</span></span></button>`).join('') || '<div class="hint">没有已确认的项目</div>'}${m.unknown ? `<div class="hint">${m.unknown} 个对话的项目未确认，未加入候选。</div>` : ''}`);
}
function showFusionSides(m) {
  const selected = lastChat?.fusion?.[m.side]?.id;
  const apps = new Map((m.apps || []).map(a => [a.app, new Map()]));
  for (const s of m.list || []) {
    if (!apps.has(s.app)) apps.set(s.app, new Map());
    const wins = apps.get(s.app);
    if (!wins.has(s.windowId)) wins.set(s.windowId, { title: cleanWindowTitle(s.windowTitle), rows: [] });
    wins.get(s.windowId).rows.push({ ...s, conversationTitle: cleanWindowTitle(s.conversationTitle) });
  }
  const rows = [...apps].map(([app, wins]) => `<details ${[...wins.values()].some(w => w.rows.some(s => s.id === selected)) ? 'open' : ''}><summary>${esc(({ codex: 'Codex', cursor: 'Cursor', devin: 'Devin' })[app] || app)}</summary>${wins.size ? [...wins.values()].map(w => `<details ${w.rows.some(s => s.id === selected) ? 'open' : ''}><summary>${esc(w.title)}</summary>${w.rows.map(s => `<button class="opt ${s.id === selected ? 'cur' : ''}" data-fusion-pick="${esc(m.side)}" data-fusion-id="${esc(s.id)}" ${s.unavailable ? 'disabled' : ''}><span class="lbl">${esc(s.conversationTitle)}${s.unavailable ? `<span class="sub">${esc(s.unavailable)}</span>` : ''}</span></button>`).join('')}</details>`).join('') : `<div class="hint">${esc(m.apps?.find(a => a.app === app)?.unavailable || '当前项目没有已打开的会话')}</div>`}${['cursor', 'devin', 'codex'].includes(app) ? `<button class="opt" data-fusion-new="${esc(app)}" data-fusion-side="${esc(m.side)}"><span class="lbl">＋ 新增会话</span></button>` : ''}</details>`).join('');
  const other = (m.other || []).map(s => `<button class="opt" data-fusion-continue="${esc(s.id)}" data-fusion-side="${esc(m.side)}"><span class="lbl">${esc(s.conversationTitle)}<span class="sub">${esc(s.app)} · ${esc(s.project?.root || '目录未确认')} · 在当前项目续接</span></span></button>`).join('');
  openSheet('fusion-side', `<h3>选择 ${m.side === 'b' ? 'B 执行' : 'A 方案'}</h3><div class="hint">仅显示所选项目。按软件、窗口、对话依次展开，再选择模型。A/B 可以使用同一软件或同一会话。</div><div class="fusionTree">${rows || '<div class="hint">没有可选的对话</div>'}${other ? `<details><summary>其它项目的会话</summary><div class="hint">续接会创建新会话并携带最近历史摘录，原会话保留。</div>${other}</details>` : ''}</div>`);
}
function showFusionHistory(m) {
  openSheet('fusion-history', `<h3>Fusion 历史会话</h3>${(m.list || []).map(f => `<button class="opt ${f.id === m.current ? 'cur' : ''}" data-fusion-history="${esc(f.id)}"><span class="lbl">${esc(f.title)}<span class="sub">${esc(new Date(f.updated).toLocaleString())}</span></span></button>`).join('') || '<div class="hint">暂无历史会话</div>'}`);
}
function fusionUsageBars(m) {
  return [...(m.quota || []), ...(m.limits || []), ...((m.quota || m.limits) ? [] : (m.bars || []))];
}
function fusionMetricValue(b) {
  return b?.pct == null ? String(b?.value || '未获取') : `${b.basis === 'remaining' ? '剩余' : '已用'} ${b.pct}%`;
}
function renderFusionMeters(fx) {
  for (const side of ['a', 'b']) {
    const spec = fx?.[side], usage = spec?.usage || {};
    const context = typeof usage.context === 'number' ? { pct: usage.context } : usage.context;
    const bars = fusionUsageBars(usage);
    const quota = bars.find(b => /week|每周|周额度/i.test(b.label)) || bars[0];
    const metric = (kind, label, b) => `<button type="button" data-side="${side}" data-metric="${kind}" title="${esc(label + ' · ' + fusionMetricValue(b))}">${esc(label)} ${esc(b?.pct == null ? '未获取' : b.pct + '%')}</button>`;
    $('fusionMeters' + side.toUpperCase()).innerHTML = `<span class="fusionRing" style="--pct:${context?.pct ?? 0}"></span><span class="fusionMetricText">${metric('context', '上下文', context)}${metric('quota', '额度', quota)}</span>`;
  }
}
function showFusionUsage(side, kind) {
  const spec = lastChat?.fusion?.[side], m = spec?.usage || {};
  const context = typeof m.context === 'number' ? { pct: m.context } : m.context;
  const rows = kind === 'context' ? `<p>${esc(fusionMetricValue(context))}</p><p class="hint">上下文表示该对话的容量使用情况。</p>`
    : `<p class="hint">额度属于账号，已用或剩余以指标说明为准。</p>${fusionUsageBars(m).map(b => `<p>${esc(b.label)} · ${esc(fusionMetricValue(b))}${b.reset ? `<br>${esc(b.reset)}` : ''}</p>`).join('') || '<p>未获取额度数据</p>'}`;
  openSheet('fusion-usage', `<h3>${side.toUpperCase()} · ${kind === 'context' ? '上下文说明' : '额度说明'}</h3><p>${esc(spec?.title || '未选择')}</p>${rows}${m.updated ? `<p class="hint">${m.cached ? '缓存数据' : '最近更新'} · ${esc(new Date(m.updated).toLocaleString())}</p>` : ''}${m.error ? `<p class="hint">${esc(m.error)}</p>` : ''}${spec ? `<button class="opt" data-fusion-refresh="${side}">刷新数据</button>` : ''}`);
}
$('fusionHeader').addEventListener('click', e => {
  const b = e.target.closest('[data-metric]');
  if (b) showFusionUsage(b.dataset.side, b.dataset.metric);
});
function showTerminals(list) {
  const rows = list.map(t => `<div class="optRow"><button class="opt ${t.current ? 'cur' : ''}" data-term="${esc(t.id)}"><span class="lbl">${esc(t.title)}</span>${t.current ? '<span class="tag">当前</span>' : ''}</button><button data-term-del="${esc(t.id)}" data-term-name="${esc(t.title)}">删除</button></div>`).join('');
  openSheet('terminals', `<h3>终端</h3>${rows || '<div class="hint">还没有终端。</div>'}<button class="opt" data-act="newTerm"><span class="lbl">＋ 新建终端</span></button>`);
}
// Devin: which of its two surfaces the desktop shows (chat.surface). Cursor never sets it.
let currentSurface = null;
function paintSurface() {
  const devin = currentApp === 'devin';
  document.body.classList.toggle('devin', devin);
  $('pickEditor').hidden = !['cursor', 'devin', 'codex'].includes(currentApp);
  $('pickAgents').textContent = '项目 ▾';
}
function startEditor() {
  editorBrowsing = true;
  editorDirectory = null;
  status('正在读取项目文件…');
  send({ t: 'docs', editor: true });
}
$('pickEditor').onclick = startEditor;
function agentButton(a) {
  const label = a.ui ? esc(a.title) : `<span class="lbl">${esc(a.title)}</span>`;
  const tags = `${a.running && !a.current ? '<span class="tag">运行中</span>' : ''}${a.current ? '<span class="tag">当前</span>' : ''}`;
  const main = `<button class="opt ${a.current ? 'cur' : ''}" data-agent="${esc(a.id)}" data-agent-title="${esc(a.title)}">${label}${tags}</button>`;
  if (a.ui || !String(a.id || '').startsWith('thread:')) return main;
  return `<div class="optRow">${main}<button type="button" class="archBtn" data-codex-archive="${esc(a.id)}" data-codex-name="${esc(a.title)}" title="归档" aria-label="归档">归档</button></div>`;
}
function foldSection(name, inner, open, count) {
  if (!name) return inner;
  return `<button type="button" class="fold" data-fold aria-expanded="${open ? 'true' : 'false'}"><span class="lbl">${esc(name)}</span><span class="tag">${count}</span><span class="chev">${open ? '▾' : '▸'}</span></button><div class="foldBody"${open ? '' : ' hidden'}>${inner}</div>`;
}
function showAgents(list) {
  list = list.map(a => ({ ...a, window: cleanWindowTitle(a.window), group: cleanWindowTitle(a.group), title: cleanWindowTitle(a.title) }));
  const keep = sheetKind === 'agents';
  const scroll = keep ? $('sheet').scrollTop : 0;
  const opened = keep ? new Set([...$('sheet').querySelectorAll('button.fold[aria-expanded="true"] > .lbl')].map(n => n.textContent)) : null;
  const newest = items => Math.max(0, ...items.map(a => a.lastUsed || 0));
  list = list.map(a => ({ ...a, lastUsed: Math.max(a.lastUsed || 0, agentOpened[agentOpenedKey(currentAppName === 'Codex' ? a.id.split(':').slice(2).join(':') : a.id)] || 0) }))
    .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  const order = [];
  const byWindow = new Map();
  for (const a of list) {
    const win = a.window || '';
    if (!byWindow.has(win)) { byWindow.set(win, []); order.push(win); }
    byWindow.get(win).push(a);
  }
  order.sort((a, b) => newest(byWindow.get(b)) - newest(byWindow.get(a)));
  const anyCurrent = list.some(a => a.current);
  const rows = order.map((win, index) => {
    const items = byWindow.get(win);
    const loose = [];
    const groups = [];
    for (const a of items) {
      if (!a.group) { loose.push(a); continue; }
      let g = groups.find(x => x.name === a.group);
      if (!g) groups.push(g = { name: a.group, items: [] });
      g.items.push(a);
    }
    loose.sort((a, b) => Number(!!b.ui) - Number(!!a.ui));
    groups.sort((a, b) => newest(b.items) - newest(a.items));
    const body = loose.map(agentButton).join('') + groups.map(g => foldSection(
      g.name, g.items.map(agentButton).join(''), opened ? opened.has(g.name) : g.items.some(a => a.current), g.items.length,
    )).join('');
    if (!win) return body;
    const open = opened ? opened.has(win) : items.some(a => a.current) || (!anyCurrent && index === 0);
    return foldSection(win, body, open, items.length);
  }).join('');
  openSheet('agents', `<h3>项目与会话</h3><button class="opt" data-act="agentsRefresh">刷新项目与会话</button><button class="opt" data-act="projects"><span class="lbl">选择文件夹／新建项目</span></button><button class="opt" data-act="projectNewChat"><span class="lbl">在当前项目新建会话</span></button>${rows || `<div class="hint">${esc(appMessage('没有找到 {app} 的 Agent。请在电脑上打开对应的会话窗口。'))}</div>`}`);
  if (keep) requestAnimationFrame(() => { $('sheet').scrollTop = scroll; });
}
$('title').onclick = () => { send({ t: 'windows' }); showWindows(); };

const MENU_TITLE = { effort: '选择思考强度', mode: '选择模式', model: '选择模型', history: '历史对话', permission: '权限', 'codex-run': '执行位置', 'codex-chat': '会话操作', 'fusion-model-a': 'A 模型', 'fusion-model-b': 'B 模型', 'fusion-effort-a': 'A 推理强度', 'fusion-effort-b': 'B 推理强度', 'fusion-lead': 'Fusion Lead', 'fusion-effort': 'Fusion Effort', 'fusion-sidekick': 'Fusion Sidekick' };
const PERM_LABEL = {
  'Ask for approval': ['每次询问', '改外部文件和上网前都会询问'],
  'Approve for me': ['代为批准', '只在可能不安全时询问'],
  'Full access': ['完全访问', '可以访问网络和这台电脑上的文件'],
};
function fusionShort(name) {
  return String(name || '').replace(/^(Claude|Gemini)\s+/i, '').replace(/\s+(Low|Medium|High|Max|Thinking)$/i, '').trim();
}
function fusionBlock(fusion) {
  if (!fusion) return '';
  const row = (part, title, value) => `<button class="opt" data-fusion="${part}"><span class="lbl">${title}<span class="sub">${esc(value || '')}</span></span></button>`;
  return `<div class="pSec">Fusion</div>${row('lead', 'Lead', fusion.lead)}${row('effort', 'Effort', fusion.effort)}${row('sidekick', 'Sidekick', fusion.sidekick)}`
    + (fusion.fastSupported ? `<button class="opt" data-fusion="fast"><span class="lbl">Fast Mode</span><span class="switch ${fusion.fast ? 'on' : ''}"></span></button>` : '')
    + '<div class="hint">Lead 负责规划和关键判断，Sidekick 负责具体执行。</div>';
}
// Devin's permission modes: the desktop's own description, plus a Chinese one when the app is in Chinese.
const MODE_ZH = { Code: '写代码、改文件，正常提问', Smart: '模型判断安全的操作自动批准', Ask: '只回答问题，不改代码', Plan: '先做方案，再动手', 'Bypass Permissions': '自动批准所有工具调用（不再询问）' };
const modeDesc = it => (I18N.lang === 'zh' && MODE_ZH[it.label]) || it.desc;
const menuCacheKey = kind => `${currentApp}|${viewSel}|${kind}`;
function requestMenu(kind, loadingMsg) {
  const cached = menuCache.get(menuCacheKey(kind));
  if (cached) showMenu(kind, cached.items, cached.max, cached.fusion, cached.fast, cached.model, true);
  else status(loadingMsg);
  send({ t: 'openMenu', kind });
}
function showMenu(kind, items, max, fusion, fast, model, refreshing) {
  finishPending(['读取思考强度…', '读取权限…', '读取模式列表…', '读取模型列表…', '读取历史对话…', '设置中…']);
  menuSheetKind = kind;
  const picking = /^fusion-(lead|effort|sidekick)$/.test(String(kind || ''));
  if (!items?.length && !fusion && kind !== 'effort') return status(appMessage('菜单是空的，可能 {app} 版本不同'), false);
  status('');
  const maxRow = typeof max === 'boolean'
    ? `<button class="opt" data-max><span class="lbl">MAX Mode<span class="sub">更大上下文、更贵</span></span><span class="switch ${max ? 'on' : ''}"></span></button>` : '';
  const part = picking ? kind.slice(7) : '';
  const rows = (items || []).map(it => {
    const perm = kind === 'permission' ? PERM_LABEL[it.label] : null;
    const effort = kind === 'effort' ? { low: '低', medium: '中', high: '高', xhigh: '很高', ultra: '最高', max: '最大', 'extra high': '很高' }[it.label.toLowerCase()] : '';
    const shown = perm ? `${esc(perm[0])}<span class="sub">${esc(perm[1])}</span>` : effort ? `${esc(effort)} · ${esc(it.label)}` : esc(it.label);
    const pick = picking
      ? `<button class="opt ${it.checked ? 'cur' : ''}" data-fusion-pick="${esc(part)}" data-label="${esc(it.label)}"><span class="lbl">${esc(it.label)}</span></button>`
      : `<button class="opt ${it.checked ? 'cur' : ''}" data-kind="${kind}" data-label="${esc(it.label)}"><span class="lbl">${shown}${it.desc ? `<span class="sub">${esc(modeDesc(it))}</span>` : ''}</span>${it.label === 'Bypass Permissions' ? '<span class="tag" style="color:var(--warn)">⚠</span>' : ''}</button>`;
    return it.params ? `<div class="optRow">${pick}<button class="paramBtn" data-params="${esc(it.id)}" data-plabel="${esc(it.label)}">参数</button></div>` : pick;
  }).join('');
  const role = /^fusion-model-([ab])$/.exec(kind || '')?.[1];
  const agentRow = role ? `<button class="opt" data-fusion-select="${role}"><span class="lbl">更换 ${role.toUpperCase()} Agent / 会话<span class="sub">${esc(lastChat?.fusion?.[role]?.title || '未选择')}</span></span></button>` : '';
  const fastRow = fast && !fusion ? `<button class="opt" data-fast="${fast.on ? 'off' : 'on'}" data-fast-menu="${kind}"><span class="lbl">Fast 模式${fast.description ? `<span class="sub">${esc(fast.description)}</span>` : ''}</span><span class="switch ${fast.on ? 'on' : ''}"></span></button>` : '';
  const effortEntry = kind === 'model' ? `<button class="opt" data-effort-open><span class="lbl">思考强度<span class="sub">${esc(lastChat?.effort || '')}</span></span></button>` : '';
  const navigation = kind === 'effort' ? `<button class="opt" data-model-back>← 返回模型列表</button><p>${esc(model || lastChat?.model || '')}</p>${!items?.length ? '<p class="hint">这个模型没有可选的思考强度。</p>' : ''}` : '';
  const done = kind === 'effort' ? '<button class="opt" data-model-done>完成</button>' : '';
  openSheet('menu', `<h3>${MENU_TITLE[kind] || ''}${refreshing ? ' <span class="hint">更新中…</span>' : ''}</h3>` + navigation + agentRow + (picking ? '' : fusionBlock(fusion)) + effortEntry + fastRow + maxRow + rows + done);
}

let changeFiles = [];
function showChanges(m) {
  changeFiles = m.files;
  finishPending(['正在撤销…', '正在保留…', '处理中…']);
  status('');
  if (!m.files.length && m.devin && m.count) {
    return openSheet('changes', `<h3>Agent 改动的文件（${m.count}）</h3><div class="hint">这个界面里读不到逐个文件的改动。切到 Agent 界面可以看到完整列表。</div>`);
  }
  if (!m.files.length) { if (sheetKind === 'changes') closeSheet(); return status('没有待处理的改动'); }
  openSheet('changes', `<h3>${m.historical ? '会话修改记录' : 'Agent 改动的文件'}（${m.files.length}）</h3>`
    + (m.actions.length ? `<div class="pRow" style="margin-bottom:10px">${m.actions.map(a => `<button data-chbar="${esc(a)}">${esc(a)}</button>`).join('')}</div>` : '')
    + m.files.map((f, i) => `<div class="optRow"><button class="opt" data-chopen="${esc(f.name)}"><span class="lbl">${esc(f.name)}`
      + `<span class="sub"><span class="add">${esc(f.add)}</span> <span class="del">${esc(f.del)}</span></span></span></button>`
      + (m.codex || m.historical ? '' : `<button class="paramBtn" data-ch="${i}" data-name="${esc(f.name)}" data-act2="keep">保留</button>`)
      + (m.codex || m.historical ? '' : `<button class="paramBtn" data-ch="${i}" data-name="${esc(f.name)}" data-act2="undo">撤销</button>`) + '</div>').join('')
    + `<div class="hint">${m.historical ? '点文件名查看当前内容。这里显示会话中的修改记录。' : m.codex ? '点文件名查看内容。操作范围与 Codex 原生按钮一致。' : '点文件名查看内容。「保留」接受这个文件的改动，「撤销」把它恢复成改动前的样子。'}</div>`);
}

function showParams(m) {
  finishPending(['读取模型参数…', '设置中…']);
  status('');
  openSheet('params', `<h3>${esc(m.label || '模型')} 参数</h3>` + m.sections.map(s => `<div class="pSec">${esc(s.title)}</div><div class="pRow">`
    + s.items.map(it => `<button class="${it.checked ? 'on' : ''} ${it.toggle ? 'tg' : ''}" data-model="${esc(m.model)}" data-plabel="${esc(m.label)}" data-section="${esc(s.title)}" data-value="${esc(it.label)}">${esc(it.label)}${it.toggle ? (it.checked ? '：开' : '：关') : ''}</button>`).join('')
    + '</div>').join('') + `<div class="hint">${esc(appMessage('改动会直接应用到电脑上 {app} 的这个模型。'))}</div>`);
}

async function showDevices() {
  let list = [];
  try { list = (await api('/api/devices').then(r => r.json())).devices || []; } catch {}
  const when = t => new Date(t).toLocaleDateString();
  openSheet('devices', `<h3>已配对设备</h3>` + list.map(d => `
    <div class="opt ${d.current ? 'cur' : ''}"><span class="lbl">${esc(d.name)}<span class="sub">配对于 ${when(d.created)} · 最近使用 ${when(d.lastSeen)}</span></span>
    ${d.current ? '' : `<button data-remove="${esc(d.id)}" data-name="${esc(d.name)}">移除</button>`}</div>`).join('')
    + '<div class="hint">添加新设备：在电脑上运行 npm run pair。<br>开启 Authenticator 二次验证：npm run 2fa。</div>');
}

function showDocs(m) {
  editorBrowsing = !!m.editor;
  const heading = m.editor ? 'Editor · 项目文件' : '查看文档';
  const back = m.editor ? '<button class="opt" data-editor-return>返回对话</button>' : '';
  if (m.editor && m.root) editorDirectory = { root: m.root, path: m.path, host: m.host || '' };
  if (m.error) { closeSheet(); return status(m.error, false); }
  if (m.projects) {
    const rows = m.projects.map(p => `<button class="opt" data-docs-root="${esc(p.path)}" data-docs-host="${esc(p.host || '')}"><span class="lbl">${esc(p.name)}${p.detail ? `<span class="sub">${esc(p.detail)}</span>` : ''}</span></button>`).join('');
    openSheet('docs', `<h3>${heading}</h3>${back}<div class="hint">选择要查看的项目</div>${rows || '<div class="hint">没有可查看的项目。</div><button class="opt" data-act="projects">选择文件夹／新建项目</button>'}`);
    return;
  }
  const hostAttr = ` data-docs-host="${esc(m.host || '')}"`;
  const up = `<button class="opt" data-docs-up="${esc(m.parent || '')}" data-root="${esc(m.root)}"${hostAttr}><span class="lbl">返回上一级</span></button>`;
  const folders = (m.folders || []).map(d => `<button class="opt" data-docs-root="${esc(m.root)}" data-docs-dir="${esc(d.path)}"${hostAttr}><span class="lbl">${esc(d.name)}</span><span class="sub">文件夹</span></button>`).join('');
  const row = (f, tag) => `<button class="opt" data-docs-file="${esc(f.path)}" data-docs-editor="${!!m.editor}"><span class="lbl">${esc(f.name)}</span><span class="sub">${tag}</span></button>`;
  const docs = (m.docs || []).map(f => row(f, '文档')).join('');
  const code = (m.code || []).map(f => row(f, '代码')).join('');
  const files = (m.files || []).map(f => row(f, '文件')).join('');
  const empty = !folders && !docs && !code && !files ? '<div class="hint">这个文件夹里没有可查看的文档或代码。</div>' : '';
  openSheet('docs', `<h3>${heading}</h3>${back}<div class="hint">${esc(m.name || '')}${m.path ? ' · ' + esc(m.path) : ''}</div>${up}${folders}${docs}${code}${files}${empty}`);
}
function showProjects(m) {
  const pathInput = '<button class="opt" data-project-path><span class="lbl">输入文件夹路径</span></button>';
  const drives = (m.drives || []).map(p => `<button class="opt" data-dir="${esc(p)}"><span class="lbl">${esc(p)}</span></button>`).join('');
  if (!m.browsing) {
    const rows = (m.recent || []).map(p => `<button class="opt" data-open="${esc(p.path)}"><span class="lbl">${esc(p.name)}<span class="sub">${esc(p.path)}</span></span></button>`).join('');
    openSheet('projects', `<h3>打开项目</h3>${rows || '<div class="hint">还没有最近打开的本地项目。</div>'}<button class="opt" data-dir="${esc(m.path)}"><span class="lbl">浏览文件夹</span></button>${pathInput}${drives}`);
    return;
  }
  const up = m.parent ? `<button class="opt" data-dir="${esc(m.parent)}"><span class="lbl">上级目录</span></button>` : '';
  const dirs = (m.dirs || []).map(d => `<button class="opt" data-dir="${esc(d.path)}"><span class="lbl">${esc(d.name)}</span></button>`).join('');
  openSheet('projects', `<h3>浏览文件夹</h3><div class="hint">${esc(m.path)}</div><button class="opt" data-open="${esc(m.path)}"><span class="lbl">打开此文件夹</span></button><button class="opt" data-project-chat="${esc(m.path)}"><span class="lbl">在此项目新建会话</span></button><button class="opt" data-project-new="${esc(m.path)}"><span class="lbl">新建项目并创建会话</span></button>${pathInput}${up}${drives}${dirs || '<div class="hint">没有子文件夹。</div>'}`);
}
function showCodexSettings(m) {
  const button = c => `<button class="paramBtn ${c.on || c.current ? 'cur' : ''}" data-codex-setting="${esc(c.id)}" ${c.disabled ? 'disabled' : ''}>${esc(c.label)}</button>`;
  const nav = `<div class="codexSettingsNav">${(m.nav || []).map(button).join('')}</div>`;
  const choices = m.choices?.length ? `<div class="pSec">选项</div>${m.choices.map(c => `<button class="opt ${c.on ? 'cur' : ''}" data-codex-setting="${esc(c.id)}"><span class="lbl">${esc(c.label)}</span></button>`).join('')}` : '';
  const rows = (m.rows || []).map(row => {
    const sw = row.controls.find(c => c.role === 'switch');
    const detail = row.detail ? `<div class="hint">${esc(row.detail)}</div>` : '';
    if (sw) return `<button class="opt" data-codex-setting="${esc(sw.id)}" ${sw.disabled ? 'disabled' : ''}><span class="lbl">${esc(row.label)}</span><span class="switch ${sw.on ? 'on' : ''}"></span></button>`;
    return `<div class="pSec">${esc(row.label)}</div>${detail}<div class="paramRow">${row.controls.map(button).join('')}</div>`;
  }).join('');
  openSheet('codex-settings', `<h3>Codex 设置</h3>${nav}${choices}${rows || '<div class="hint">当前页面没有可操作的设置项。</div>'}`);
}
function showSettings(sections) {
  const body = sections.map(s => `<div class="pSec">${esc(s.title)}</div>` + s.items.map(it => {
    const label = `<span class="lbl">${esc(it.label)}${it.detail ? `<span class="sub">${esc(it.detail)}</span>` : ''}</span>`;
    if (it.toggle === false) return `<div class="opt static">${label}</div>`;
    return `<button class="opt" data-setting="${esc(it.label)}">${label}<span class="switch ${it.on ? 'on' : ''}"></span></button>`;
  }).join('')).join('');
  const appName = currentAppName;
  openSheet('settings', `<h3>${appName ? appName + ' 设置' : '设置'}</h3>${body || '<div class="hint">没有读到设置。</div>'}`);
}
function meterFill(pct, basis) {
  if (pct == null) return '';
  const tight = basis === 'remaining' ? pct <= 10 : pct >= 90;
  const warm = basis === 'remaining' ? pct <= 25 : pct >= 75;
  return tight ? 'hot' : warm ? 'warm' : '';
}
let contextInfo = null, quotaInfo = null;
function renderContext(info) {
  const basis = info && typeof info === 'object' ? (info.basis || 'used') : 'used';
  const pct = info == null ? null : typeof info === 'object' ? info.pct : info;
  const n = pct == null || pct === '' ? null : Math.max(0, Math.min(100, Number(pct)));
  contextInfo = { pct: n, basis };
  $('meterCtxPct').textContent = n == null ? '未获取' : (basis === 'remaining' ? '剩余' : '已用') + n + '%';
  const fill = $('meterCtxFill');
  fill.style.width = (n ?? 0) + '%';
  fill.parentElement.style.setProperty('--pct', n ?? 0);
  fill.className = meterFill(n, basis);
  $('meterCtx').title = '上下文 · ' + (basis === 'remaining' ? '剩余' : '已用') + ' ' + (n ?? '–') + '%';
  $('meterCtx').setAttribute('aria-label', $('meterCtx').title);
  $('meterCtx').onclick = () => showUsageDetails('context');
}
const quotaCache = new Map();
const quotaKey = () => [currentComputer()?.id || '', ...viewSel.split('|').slice(0, 2)].join('|');
function renderQuota(m) {
  if ('context' in m) renderContext(m.context);
  if (m.error) { $('quotaStatus').textContent = m.error; $('quotaStatus').title = $('quotaMeters').title = m.detail || m.error; if (!m.automatic) status('额度刷新失败：' + m.error, false); return; }
  if (!m.cached || m.updated > (quotaCache.get(quotaKey())?.updated || 0)) $('quotaStatus').textContent = '';

  if (m.loading) return;
  if (!('quota' in m) && !('limits' in m) && !('bars' in m)) {
    return;
  }
  quotaInfo = m;
  if (!m.missing && !m.loading) quotaCache.set(quotaKey(), m);
  const bars = [...(m.quota || []), ...(m.limits || []), ...((m.quota || m.limits) ? [] : (m.bars || []))]
    .filter(b => b?.label && !/^loading\b/i.test(String(b.label)));
  $('quotaMeters').classList.toggle('devinLimits', currentApp === 'devin' && bars.length > 1);
  const when = m.updated ? new Date(m.updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  if (m.missing) {
    $('quotaMeters').title = '没有额度数据' + (when ? ` · 更新于 ${when}` : '');
    $('quotaMeters').innerHTML = `<button class="meter" type="button"><span class="track"></span><span class="meterText"><span class="meterLabel">额度</span><b>未获取</b></span></button>`;
    $('quotaMeters').querySelector('button').onclick = () => showUsageDetails('quota');
    return;
  }
  if (!bars.length) {
    $('quotaMeters').title = '没有额度指标' + (when ? ` · 更新于 ${when}` : '');
    $('quotaMeters').innerHTML = `<button class="meter" type="button"><span class="track"></span><span class="meterText"><span class="meterLabel">额度</span><b>未获取</b></span></button>`;
    $('quotaMeters').querySelector('button').onclick = () => showUsageDetails('quota');
    return;
  }
  const reset = [...new Set(bars.map(b => b.reset).filter(Boolean))].join(' · ') || (m.lines || []).find(l => /reset/i.test(l)) || '';
  $('quotaMeters').title = [reset, when ? `更新于 ${when}` : ''].filter(Boolean).join(' · ');
  $('quotaMeters').innerHTML = bars.map(b => {
    const basis = b.basis || 'used';
    const n = b.pct == null ? null : Math.max(0, Math.min(100, Number(b.pct)));
    const num = n == null ? (b.value ?? '未获取') : (basis === 'remaining' ? '剩余' : '已用') + `${n}%`;
    const label = /week|每周|周额度/i.test(b.label) ? '周额度' : /daily|每日|日额度/i.test(b.label) ? '日额度' : b.label;
    return `<button class="meter" type="button" title="${esc(b.label + ' · ' + basis + ' · ' + (b.reset || ''))}" aria-label="${esc(b.label + ' ' + num)}"><span class="track" style="--pct:${n ?? 0}"><i class="${meterFill(n, basis)}" style="width:${n ?? 0}%"></i></span><span class="meterText"><span class="meterLabel">${esc(label)}</span><b>${esc(String(num))}</b></span></button>`;
  }).join('');
  if (when) $('quotaMeters').insertAdjacentHTML('beforeend', `<span class="quotaUpdated">${m.cached ? '缓存 ' : ''}${esc(when)}</span>`);
  $('quotaMeters').querySelectorAll('button').forEach(btn => btn.onclick = () => showUsageDetails('quota'));
}
function showUsageDetails(kind) {
  const context = kind === 'context';
  const m = quotaInfo || {};
  const bars = [...(m.quota || []), ...(m.limits || []), ...((m.quota || m.limits) ? [] : (m.bars || []))];
  const value = b => b?.pct == null ? String(b?.value || '未获取') : `${b.basis === 'remaining' ? '剩余' : '已用'} ${b.pct}%`;
  const rows = context ? `<p>${esc(value(contextInfo))}</p><p class="hint">上下文表示当前会话的上下文容量使用情况，与账号额度分别统计。</p>`
    : `<p class="hint">额度表示账号在对应周期内的使用限制，已用或剩余以指标说明为准。</p>` + (m.plan ? `<p>方案 · ${esc(m.plan)}</p>` : '') + (m.missing || !bars.length ? '<p>未获取额度数据</p>' : bars.map(b => `<p>${esc(b.label)} · ${esc(value(b))}${b.detail ? `<br><span class="hint">${esc(b.detail)}</span>` : ''}${b.reset ? `<br><span class="hint">${esc(b.reset)}</span>` : ''}</p>`).join(''))
      + (m.extra ? `<p>额外用量余额 · ${esc(m.extra)}</p>` : '');
  const updated = m.updated ? new Date(m.updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  openSheet('usage', `<h3>${context ? '上下文说明' : '额度说明'}</h3>${rows}${!context && updated ? `<p class="hint">${m.cached ? '缓存数据' : '最近更新'} · ${esc(updated)}</p>` : ''}${!context && $('quotaStatus').textContent ? `<p class="hint">${esc($('quotaStatus').textContent)}</p>` : ''}<button id="refreshUsage" class="opt">刷新数据</button>`);
  $('refreshUsage').onclick = () => { closeSheet(); status('正在读取额度…'); send({ t: 'usage' }); };
}
let usageTimer = null;
function showMainMenu() {
  const notifyItem = notifyOn
    ? `<button class="opt" data-act="notifyOff"><span class="lbl">通知：已开启<span class="sub">Agent 完成或等你确认时提醒</span></span><span class="tag">关闭</span></button>
       <button class="opt" data-act="notifyTest"><span class="lbl">发一条测试通知</span></button>`
    : `<button class="opt" data-act="notifyOn"><span class="lbl">开启通知<span class="sub">Agent 完成或等你确认时提醒</span></span></button>`;
  const update = apkUpdate()
    ? `<button class="opt" data-act="appUpdate"><span class="lbl">更新安卓 App（v${esc(appVersion)} → v${esc(apkUpdate())}）</span><span class="tag">新</span></button>`
    : `<button class="opt" data-act="appUpdate"><span class="lbl">检查 App 更新（当前 v${esc(appVersion)}）</span></button>`;
  const appName = currentAppName;
  openSheet('main', `<h3>菜单</h3>
    ${appName ? `<div class="pSec">${appName}</div>` : ''}
    ${currentApp === 'fusion' ? `<button class="opt" data-act="fusionHistory">历史会话</button><button class="opt" data-act="fusionNew" ${lastChat?.fusion?.busy ? 'disabled' : ''}>＋ 新建</button>` : `<button class="opt" data-act="model"><span class="lbl">更换模型<span class="sub" id="menuModel">${esc(lastChat?.model || '选择当前 Agent 的模型')}</span></span></button>`}
    ${lastChat?.permission || (currentApp === 'devin' && lastChat?.mode) ? `<button class="opt" data-act="permission"><span class="lbl">权限模式<span class="sub">${esc(lastChat.permission || lastChat.mode)}</span></span></button>` : ''}
    ${['cursor', 'devin', 'codex'].includes(currentApp) ? '<button class="opt" data-act="editor"><span class="lbl">Editor · 项目文件编辑</span></button>' : ''}
    ${['cursor', 'devin', 'codex'].includes(currentApp) ? '<button class="opt" data-act="projects"><span class="lbl">打开项目<span class="sub">选择文件夹或新建项目</span></span></button>' : ''}
    ${currentApp === 'codex' ? '<button class="opt" data-act="codexResetHelp"><span class="lbl">Codex 额度重置</span></button>' : ''}
    <button class="opt" data-act="settings"><span class="lbl">设置</span></button>
    <button class="opt" data-act="screen"><span class="lbl">画面<span class="sub">${esc(appMessage('直接看电脑上的 {app}'))}</span></span></button>
    <div class="pSec">此手机 App</div>
    ${notifyItem}
    ${inApp && appVersion ? update : ''}
    ${inApp ? '<button class="opt" data-act="changeUrl"><span class="lbl">更换 App 地址</span></button>' : ''}
    <button class="opt" data-act="reconnect"><span class="lbl">重新连接</span></button>
    <button class="opt" data-act="theme"><span class="lbl">主题<span class="sub">深色 / 浅色 / 跟随系统（当前：${themeName()}）</span></span></button>
    ${inApp && window.AgentRemoteApp?.listenStatus ? '<button class="opt" data-act="bg"><span class="lbl">后台连接<span class="sub">状态、电池优化、立即重连</span></span></button>' : ''}
    <button class="opt" data-act="cache"><span class="lbl">会话缓存<span class="sub">手机上保存的对话记录，可折叠、可清除</span></span></button>
    <button class="opt" data-act="lang"><span class="lbl">语言 / Language<span class="sub">中文 · English（${I18N.lang === 'en' ? 'English' : '中文'}）</span></span></button>
    <button class="opt" data-act="computers"><span class="lbl">电脑<span class="sub">${esc(currentComputer()?.name || '未配对')}</span></span></button>
    <button class="opt" data-act="devices"><span class="lbl">已配对设备</span></button>
    <button class="opt" data-act="logout"><span class="lbl">删除这台电脑</span></button>`);
}
$('menuBtn').onclick = showMainMenu;

const inApp = /AgentRemoteApp/.test(navigator.userAgent);
const APK_RELEASE = 'https://github.com/xrdiao/remote-agent/releases/latest/download/AgentRemote.apk';
// A copy on the user's own GitHub Pages downloads more reliably in mainland China than GitHub Releases.
let apkUrl = APK_RELEASE;
fetch('AgentRemote.apk', { method: 'HEAD' }).then(r => { if (r.ok) apkUrl = new URL('AgentRemote.apk', location.href).href; }).catch(() => {});
const appAddress = () => location.origin + location.pathname.replace(/index\.html$/, '');

// The page itself updates with GitHub Pages; only the Android shell needs a new APK now and then.
const appVersion = /AgentRemoteApp\/v?([\d.]+)/.exec(navigator.userAgent)?.[1];
const newerThan = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
const apkUpdate = () => {
  const latest = store.get('apkLatest');
  return appVersion && latest && newerThan(latest, appVersion) ? latest : null;
};
async function checkAppUpdate(manual = false) {
  if (!inApp || !appVersion) return;
  if (!manual && Date.now() - (store.get('apkChecked') || 0) < 6 * 3600e3) return;
  try {
    const r = await fetch('https://api.github.com/repos/xrdiao/remote-agent/releases/latest', { cache: 'no-store' });
    if (!r.ok) throw new Error();
    store.set('apkLatest', String((await r.json()).tag_name || '').replace(/^v/, ''));
    store.set('apkChecked', Date.now());
  } catch {
    if (manual) status('检查更新失败，请稍后再试', false);
    return;
  }
  if (apkUpdate()) status(`安卓 App 有新版本 v${apkUpdate()}，点右上角「⋯」更新`);
  else if (manual) status('已经是最新版本');
}
function installAppUpdate() {
  if (window.AgentRemoteApp?.update) {
    window.AgentRemoteApp.update(apkUrl);
    status('正在下载新版本，下载完会弹出安装界面');
  }
  // Older shells can't download: an off-site link opens in the system browser instead.
  else location.href = APK_RELEASE;
}

