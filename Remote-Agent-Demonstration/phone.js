/* Remote Agent demo — phone renderer. Renders the real app DOM (index.html
   structure + app.css classes) from state snapshots posted by the parent demo
   page. Never invents session content: everything arrives via
   postMessage({type:'state', state, instant}) or {type:'fx', name, ...}. */
(function () {
  'use strict';
  var $ = id => document.getElementById(id);
  var esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  var LANG = window.PHONE_LANG || 'zh';
  var L = {
    zh: {
      chat: '对话', term: '终端', ph: '发给 Agent…', send: '发送', agents: '项目/会话',
      newc: '＋ 新建', ctx: '上下文', menu: '菜单', copy: '复制', skip: '跳过', submit: '提交',
      qnHead: 'Agent 在问你', switchAgent: '切换 Agent', cur: '当前', running: '运行中',
      listening: '正在听…松开结束，文字不会自动发送', termBusy: 'Agent 正在运行',
      tList: '列表', tNew: '＋ 新建', tCopy: '复制', tAll: '全选', sendTerm: '发送到终端',
      termOps: '终端操作', older: '↑ 加载更早的消息', now: '现在',
      vSearch: '搜索', vWrap: '换行', vOnly: '只看改动', vSrc: 'Agent 的改动',
      phTerm: '发给终端…',
      mMenu: '菜单', mModel: '更换模型', mModelSub: '选择当前 Agent 的模型',
      mEditor: 'Editor · 项目文件编辑', mProj: '打开项目', mProjSub: '选择文件夹或新建项目',
      mSet: '设置', mScreen: '画面', mScreenSub: '查看绘图与仿真窗口',
      mPhone: '此手机 App', mVoice: '语音输入', mVoiceSub: '已开启 · 按住说话',
      mTheme: '主题', mLang: '语言 / Language', mLangSub: '中文 · English（中文）',
      thDark: '深色', thLight: '浅色', thSys: '跟随系统', thNow: '当前：',
      edited: 'Edited', read: 'Read', command: 'Command', runTests: 'Ran'
    },
    en: {
      chat: 'Chat', term: 'Terminal', ph: 'Message Agent…', send: 'Send', agents: 'Projects / sessions',
      newc: '+ New', ctx: 'Context', menu: 'Menu', copy: 'Copy', skip: 'Skip', submit: 'Submit',
      qnHead: 'The agent is asking', switchAgent: 'Switch Agent', cur: 'Current', running: 'Running',
      listening: 'Listening… release to finish; text is not sent automatically', termBusy: 'Agent is running',
      tList: 'List', tNew: '+ New', tCopy: 'Copy', tAll: 'Select all', sendTerm: 'Send to terminal',
      termOps: 'Terminal controls', older: '↑ Load earlier messages', now: 'now',
      vSearch: 'Find', vWrap: 'Wrap', vOnly: 'Changes only', vSrc: "Agent's edits",
      phTerm: 'Message the terminal…',
      mMenu: 'Menu', mModel: 'Change model', mModelSub: 'Choose the current Agent model',
      mEditor: 'Editor · project files', mProj: 'Open project', mProjSub: 'Pick a folder or create a project',
      mSet: 'Settings', mScreen: 'Screen', mScreenSub: 'View canvas and emulator windows',
      mPhone: 'This phone app', mVoice: 'Voice input', mVoiceSub: 'On · hold to talk',
      mTheme: 'Theme', mLang: '语言 / Language', mLangSub: '中文 · English（English）',
      thDark: 'Dark', thLight: 'Light', thSys: 'Follow system', thNow: 'now: ',
      edited: 'Edited', read: 'Read', command: 'Command', runTests: 'Ran'
    }
  }[LANG] || {};
  var SCREEN = new URLSearchParams(location.search).get('screen') || 'chat';

  var SVG = 'width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
  var ICON = {
    read: '<svg class="ticon" ' + SVG + '><path d="M4 1.5h5L12 4.5V14.5H4z"/><path d="M9 1.5v3h3"/><path d="M6 8h4M6 10.5h4"/></svg>',
    command: '<svg class="ticon" ' + SVG + '><path d="M3 4l4 4-4 4"/><path d="M8.5 12.5H13"/></svg>',
    edit: '<svg class="ticon" ' + SVG + '><path d="M9.5 2.5 13.5 6.5 6 14l-4.2.8L2.5 11z"/></svg>'
  };

  /* ---------- state ---------- */
  var ST = null;
  function itemsHtml(msgs) {
    return (msgs || []).map(function (m) {
      if (m.k === 'human') {
        return '<div class="msg human"><div class="humanContent"><div class="bubble">' + esc(m.t) + '</div>' +
          '<div class="messageMeta">' + (m.time ? '<time>' + esc(m.time) + '</time>' : '') +
          '<button data-copy-message>' + esc(L.copy) + '</button></div></div></div>';
      }
      if (m.k === 'assistant') return '<div class="msg assistant"><p>' + esc(m.t) + '</p></div>';
      if (m.k === 'ans') return '<div class="msg tool toolrow"><div class="trow"><span class="tdone">✓</span>' +
        '<span class="tl">' + esc(m.t) + '</span></div></div>';
      if (m.k === 'tool') {
        var st = m.state === 'done' ? '<span class="tdone">✓</span>' : '<span class="rspin"></span>';
        if (m.kind === 'edit') {
          return '<div class="msg tool toolrow open"><div class="trow toggle">' + st + ICON.edit +
            '<span class="tl">' + esc(L.edited) + '</span><code class="chip" data-file="' + esc(m.f || '') + '">' + esc(m.f || '') + '</code>' +
            '<span class="stat add">+' + (m.add || 0) + '</span><span class="stat del">-' + (m.del || 0) + '</span></div></div>';
        }
        if (m.kind === 'command') {
          return '<div class="msg tool toolrow open"><div class="trow toggle">' + st + ICON.command +
            '<span class="tl">' + esc(L.runTests) + '</span><code class="chip">' + esc(m.cmd || '') + '</code>' +
            '<span class="dur">' + (m.count || 0) + '/' + (m.total || 0) + '</span></div>' +
            '<pre class="tcmd">$ ' + esc(m.cmd || '') + '\n' + esc(m.out || '') + '</pre></div>';
        }
        return '<div class="msg tool toolrow"><div class="trow">' + st + ICON.read +
          '<span class="tl">' + esc(L.read) + '</span></div>' +
          '<div class="chips"><code class="chip" data-file="' + esc(m.f || '') + '">' + esc(m.f || '') + '</code></div></div>';
      }
      return '';
    }).join('');
  }
  function renderQuestion(q) {
    var bar = $('qnBar');
    if (!q || q.answer != null || ST.screen !== 'chat' || ST.lock) { bar.classList.remove('show'); bar.innerHTML = ''; return; }
    bar.innerHTML = '<div class="qnHead">' + esc(L.qnHead) + '</div>' +
      '<div class="qnQ">' + esc(q.q) + '</div><div class="qnOpts">' +
      q.opts.map(function (o, i) {
        return '<button class="qnOpt' + (q.sel === i ? ' on' : '') + '"><b>' + 'ABC'[i] + '</b><span>' + esc(o) + '</span></button>';
      }).join('') + '</div>' +
      '<div class="qnAct"><button>' + esc(L.skip) + '</button><button class="primary"' + (q.sel == null ? ' disabled' : '') + '>' + esc(L.submit) + '</button></div>';
    bar.classList.add('show');
  }
  function renderSheet() {
    var s = ST.sheet, sheet = $('sheet'), shade = $('shade');
    if (!s) { sheet.classList.remove('open'); shade.classList.remove('open'); return; }
    if (s.kind === 'menu') {
      var thNow = s.theme === 'dark' ? L.thDark : s.theme === 'light' ? L.thLight : L.thSys;
      var themeSub = LANG === 'en'
        ? 'Dark / Light / Follow system (now: ' + thNow + ')'
        : '深色 / 浅色 / 跟随系统（当前：' + thNow + '）';
      sheet.dataset.kind = 'main';
      sheet.innerHTML = '<h3>' + esc(L.mMenu) + '</h3>' +
        '<div class="pSec">' + esc(s.appName || 'Cursor') + '</div>' +
        '<button class="opt"><span class="lbl">' + esc(L.mModel) + '<span class="sub">' + esc(L.mModelSub) + '</span></span></button>' +
        '<button class="opt"><span class="lbl">' + esc(L.mEditor) + '</span></button>' +
        '<button class="opt"><span class="lbl">' + esc(L.mProj) + '<span class="sub">' + esc(L.mProjSub) + '</span></span></button>' +
        '<button class="opt"><span class="lbl">' + esc(L.mSet) + '</span></button>' +
        '<button class="opt"><span class="lbl">' + esc(L.mScreen) + '<span class="sub">' + esc(L.mScreenSub) + '</span></span></button>' +
        '<div class="pSec">' + esc(L.mPhone) + '</div>' +
        '<button class="opt"><span class="lbl">' + esc(L.mVoice) + '<span class="sub">' + esc(L.mVoiceSub) + '</span></span><span class="tag">›</span></button>' +
        '<button class="opt" data-act="theme" id="menuThemeRow"><span class="lbl">' + esc(L.mTheme) + '<span class="sub">' + esc(themeSub) + '</span></span></button>' +
        '<button class="opt"><span class="lbl">' + esc(L.mLang) + '<span class="sub">' + esc(L.mLangSub) + '</span></span></button>';
      sheet.classList.add('open'); shade.classList.add('open');
      return;
    }
    sheet.dataset.kind = 'windows';
    sheet.innerHTML = '<h3>' + esc(L.switchAgent) + '</h3>' + s.rows.map(function (r) {
      return '<button class="opt' + (r.cur ? ' cur' : '') + '"><span class="optLogo" data-logo="' + esc(r.logo) + '"></span>' +
        '<span class="lbl">' + esc(r.label) + '</span>' +
        (r.running ? '<span class="tag">' + esc(L.running) + '</span>' : '') +
        (r.cur ? '<span class="tag">' + esc(L.cur) + '</span>' : '') + '</button>';
    }).join('');
    sheet.classList.add('open'); shade.classList.add('open');
  }
  function renderLock() {
    var lk = $('lock'), n = $('notif');
    if (!ST.lock) { lk.classList.remove('on'); return; }
    lk.classList.add('on');
    $('lkTime').textContent = ST.lock.time || '';
    $('lkDate').textContent = ST.lock.date || '';
    if (ST.notif) {
      n.querySelector('.nTitle').textContent = ST.notif.title || '';
      n.querySelector('.nBody').textContent = ST.notif.body || '';
      n.querySelector('.nNow').textContent = L.now;
      n.classList.remove('away'); n.classList.add('show');
    } else { n.classList.remove('show'); }
  }
  function fillTerm() {
    var t = ST.term || {};
    var out = '$ ' + (t.cmd || '') + (t.lines && t.lines.length ? '\n' + t.lines.join('\n') : '');
    $('termText').textContent = out;
    var tt = $('termText'); tt.scrollTop = tt.scrollHeight;
  }
  function fillFile() {
    var f = ST.file || {};
    $('vName').textContent = f.name || '';
    $('vPath').textContent = f.path || '';
    $('vChanges').hidden = !f.marks;
    $('vSrc').textContent = f.marks ? L.vSrc : '';
    $('vChangeCount').textContent = f.marks ? '–/' + f.marks : '';
    var code = document.createElement('div');
    code.className = 'code';
    code.innerHTML = (f.lines || []).map(function (l) {
      return '<div class="l' + (l.mk ? ' mk-' + l.mk : '') + '" data-n="' + l.n + '"><i>' + l.n + '</i><span class="lc">' + (l.h || ' ') + '</span></div>';
    }).join('');
    $('vBody').replaceChildren(code);
  }
  function apply() {
    var st = ST;
    if (st.theme) document.documentElement.dataset.theme = st.theme;
    document.body.dataset.app = st.app || 'cursor';
    document.body.classList.toggle('term', st.screen === 'term');
    document.body.classList.toggle('chatmode', st.screen === 'chat');
    document.body.classList.toggle('kb', !!st.kb);
    $('titleText').textContent = st.title || 'Cursor';
    $('titleProject').textContent = st.project || '';
    $('tabChat').classList.toggle('on', st.screen !== 'term');
    $('tabTerm').classList.toggle('on', st.screen === 'term');
    $('chatView').classList.toggle('active', st.screen !== 'term');
    $('screenView').classList.toggle('active', st.screen === 'term');
    $('chatTools').hidden = st.screen !== 'chat';
    $('termTools').hidden = st.screen !== 'term';
    $('termToolsLabel').hidden = st.screen !== 'term';
    $('pickModel').textContent = st.model || 'Auto';
    $('pickAgents').textContent = L.agents;
    $('newChat').textContent = L.newc;
    $('older').textContent = L.older;
    $('text').placeholder = st.screen === 'term' ? L.phTerm : L.ph;
    $('text').value = st.draft || '';
    var busy = st.status !== 'done';
    var micVisible = st.screen === 'chat' && (!busy || st.focused);
    $('mic').hidden = !micVisible;
    $('stop').hidden = !(busy && !micVisible);
    $('mic').classList.toggle('on', !!st.voice);
    $('send').textContent = st.screen === 'term' ? L.sendTerm : L.send;
    $('termBusy').hidden = !(st.screen === 'term' && busy);
    $('termBusy').textContent = L.termBusy;
    $('termToolsLabel').textContent = L.termOps;
    $('msg').textContent = st.voice ? L.listening : (st.statusMsg || '');
    $('msg').classList.toggle('quiet', !(st.voice || st.statusMsg));
    $('meterCtxLabel').textContent = L.ctx;
    $('meterCtxTrack').setAttribute('data-n', '42');
    $('meterCtxTrack').style.setProperty('--pct', '42');
    $('items').innerHTML = itemsHtml(st.msgs);
    $('list').scrollTop = $('list').scrollHeight;
    renderQuestion(st.q);
    renderSheet();
    renderLock();
    if (st.screen === 'term') fillTerm();
    if (st.screen === 'file') { fillFile(); $('viewer').classList.add('open'); }
    else $('viewer').classList.remove('open');
    $('vFind').textContent = L.vSearch; $('vWrap').textContent = L.vWrap; $('vOnly').textContent = L.vOnly;
    document.querySelector('#tabChat .segLabel').textContent = L.chat;
    document.querySelector('#tabTerm .segLabel').textContent = L.term;
  }
  function noanim(fn) {
    document.documentElement.classList.add('noanim');
    fn();
    void document.body.offsetHeight;
    document.documentElement.classList.remove('noanim');
  }

  /* ---------- fx ---------- */
  function fxEl(args) {
    if (args && args.sel) { var e = document.querySelector(args.sel); if (e) return e; }
    return null;
  }
  function center(e, args) {
    var r = e.getBoundingClientRect();
    return [r.left + r.width / 2 + ((args && args.dx) || 0), r.top + r.height / 2 + ((args && args.dy) || 0)];
  }
  function spawn(cls, x, y) {
    var d = document.createElement('div');
    d.className = cls;
    d.style.left = x + 'px'; d.style.top = y + 'px';
    $('fx').appendChild(d);
    return d;
  }
  function fx(m) {
    var e = fxEl(m.args), p = e ? center(e, m.args) : [m.args.x || 0, m.args.y || 0];
    if (m.name === 'tap') { var r = spawn('rip', p[0], p[1]); setTimeout(function () { r.remove(); }, 650); }
    if (m.name === 'hold') {
      var h = spawn('hold', p[0], p[1]);
      setTimeout(function () { h.classList.add('end'); setTimeout(function () { h.remove(); }, 250); }, (m.dur || 800));
    }
    if (m.name === 'shake') { var n = $('notif'); n.classList.remove('shake'); void n.offsetWidth; n.classList.add('shake'); }
    if (m.args && m.args.report && e) {
      var fr = e.getBoundingClientRect();
      parent.postMessage({ type: 'fxrect', rect: [fr.left + fr.width / 2, fr.top + fr.height / 2] }, '*');
    }
  }

  window.addEventListener('message', function (e) {
    var m = e.data || {};
    if (m.type === 'state') {
      ST = m.state || {};
      ST.screen = ST.screen || SCREEN;
      if (m.instant) noanim(apply); else apply();
    } else if (m.type === 'theme') {
      /* ack at once: the parent's view-transition update phase suppresses
         rendering, so waiting for rAF here would stall until its timeout */
      noanim(function () { document.documentElement.dataset.theme = m.theme || 'light'; });
      parent.postMessage({ type: 'themed' }, '*');
    } else if (m.type === 'fx') { fx(m); }
  });

  /* ---------- initial labels + ready ---------- */
  document.querySelector('#tabChat .segLabel').textContent = L.chat;
  document.querySelector('#tabTerm .segLabel').textContent = L.term;
  $('text').placeholder = L.ph;
  $('send').textContent = L.send;
  $('pickAgents').textContent = L.agents;
  $('newChat').textContent = L.newc;
  $('meterCtxLabel').textContent = L.ctx;
  $('meterCtxTrack').setAttribute('data-n', '42');
  $('meterCtxTrack').style.setProperty('--pct', '42');
  if (SCREEN === 'term') {
    document.body.classList.add('term'); document.body.classList.remove('chatmode');
    $('chatView').classList.remove('active'); $('screenView').classList.add('active');
    $('tabChat').classList.remove('on'); $('tabTerm').classList.add('on');
    $('chatTools').hidden = true; $('termTools').hidden = false; $('termToolsLabel').hidden = false;
    $('send').textContent = L.sendTerm; $('termToolsLabel').textContent = L.termOps;
    $('text').placeholder = L.phTerm;
    $('pickTerms').textContent = L.tList; $('newTerm').textContent = L.tNew;
    $('termCopy').textContent = L.tCopy; $('termSelectAll').textContent = L.tAll;
    var sk = $('screenKeys').querySelector('[data-key="Enter"]'); if (sk) sk.textContent = LANG === 'en' ? 'Enter' : '回车';
  }
  if (SCREEN === 'file') { $('viewer').classList.add('open'); $('vFind').textContent = L.vSearch; $('vWrap').textContent = L.vWrap; $('vOnly').textContent = L.vOnly; }
  $('termEmpty').hidden = true;
  $('termEmptyNew').textContent = SCREEN === 'term' ? (LANG === 'en' ? 'New terminal' : '新建终端') : '';
  $('screenKeys').hidden = true;
  parent.postMessage({ type: 'ready' }, '*');
})();
