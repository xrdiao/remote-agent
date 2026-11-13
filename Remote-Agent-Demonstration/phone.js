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
      tList: '列表', tNew: '＋ 新建', tCopy: '复制', tAll: '全选', sendTerm: '发送',
      termOps: '终端操作', older: '↑ 加载更早的消息', now: '现在',
      vSearch: '搜索', vWrap: '换行', vOnly: '只看改动', vSrc: 'Agent 的改动',
      phTerm: '发给终端…',
      vBack: '返回对话', vLive: '实时', vPreview: '窗口预览', vRead: '只读',
      vHint: '双指缩放 · 拖动查看', vRefresh: '刷新', vFit: '适应',
      mMenu: '菜单', mModel: '更换模型', mModelSub: '选择当前 Agent 的模型',
      mEditor: 'Editor · 项目文件编辑', mProj: '打开项目', mProjSub: '选择文件夹或新建项目',
      mSet: '设置', mScreen: '画面', mScreenSub: '查看绘图与仿真窗口',
      mPhone: '此手机 App', mVoice: '语音输入', mVoiceSub: '已开启 · 按住说话',
      mTheme: '主题', mLang: '语言 / Language', mLangSub: '中文 · English（中文）',
      thDark: '深色', thLight: '浅色', thSys: '跟随系统', thNow: '当前：',
      edited: 'Edited', read: 'Read', command: 'Command', runTests: 'Ran',
      home: '概览', allC: '全部电脑', wk: '工作站', wkLoad: '正在读取项目与会话…',
      gNeed: '需要你', gRun: '进行中', gDone: '已完成',
      openC: '打开对话', opening: '正在打开…', wkQuota: '周额度', used38: '已用38%',
      left72: '剩余72%', progDone: '已完成', phNext: '告诉 Cursor 下一步…', yourMsg: '你',
      bWait: '待确认', bRun: '运行中', bDone: '已完成',
      tWait: '迁移脚本', tCur: '重构令牌刷新', tCodex: '修复表格分页', tDoc: '更新 API 文档',
      nWait: '需要确认：是否覆盖现有表结构？', nCur: '正在编辑 src/auth/refresh.ts…',
      nCodex: '正在调整分页状态逻辑…', nDoc: '已提交 3 个文件',
      wWork: '正在工作…', sumAll: '全部会话', sumNeed: '需要你', sumRun: '运行中', sumDone: '今日完成',
      aiPrev: '好，我先看一下现有的实现，再拆出刷新逻辑。',
      qnCount: '个问题',
      mEntry: '默认进入', mEntrySub: '下次打开或刷新生效', mEntryOv: '缩略图', mEntryConv: '会话内容',
      mModelG: '模型', mGeneral: '通用', mConn: 'Agent 与连接', mSettingsG: '应用设置与帮助',
      mMode: '模式', mModeSub: '写代码、改文件，正常提问', mScreenItem: '画面', mSetItem: '设置',
      mExec: '显示执行指令', mExecSub: '包含工具读取和搜索记录；关闭后在本轮结束时隐藏',
      mAgentMgr: 'Agent 管理', mAgentMgrSub: '检测安装状态、选择并启动 Agent',
      mAutoLaunch: '自动启动未打开的 Agent', mAutoLaunchSub: '连接电脑时自动启动没有运行的 Agent',
      mReconnect: '重新连接', mDevices: '已配对设备', mDeletePc: '删除这台电脑',
      mNotify: '开启通知', mNotifySub: 'Agent 完成或等你确认时提醒',
      mCache: '会话缓存', mCacheSub: '手机上保存的对话记录，可折叠、可清除',
      mVer: '网页版本 2.4.0', mTransfer: '文件传输', mVoiceMenu: '语音输入', mComputer: '电脑',
      mTerms: '终端列表 ▾', mTermPwd: '密码输入', mTermCopy: '复制', mTermAll: '全选',
      mTermSize: '尺寸', mTermRefresh: '刷新输出', mTermMore: '更多', mTermInt: '中断',
      termTitle: 'RA 终端', termSub: 'studio-pc · ~/work/auth-service'
    },
    en: {
      chat: 'Chat', term: 'Terminal', ph: 'Message Agent…', send: 'Send', agents: 'Projects / sessions',
      newc: '+ New', ctx: 'Context', menu: 'Menu', copy: 'Copy', skip: 'Skip', submit: 'Submit',
      qnHead: 'The agent is asking', switchAgent: 'Switch Agent', cur: 'Current', running: 'Running',
      listening: 'Listening… release to finish; text is not sent automatically', termBusy: 'Agent is running',
      tList: 'List', tNew: '+ New', tCopy: 'Copy', tAll: 'Select all', sendTerm: 'Send',
      termOps: 'Terminal controls', older: '↑ Load earlier messages', now: 'now',
      vSearch: 'Find', vWrap: 'Wrap', vOnly: 'Changes only', vSrc: "Agent's edits",
      phTerm: 'Message the terminal…',
      vBack: 'Back to chat', vLive: 'Live', vPreview: 'Window preview', vRead: 'Read only',
      vHint: 'Pinch to zoom · Drag to pan', vRefresh: 'Refresh', vFit: 'Fit',
      mMenu: 'Menu', mModel: 'Change model', mModelSub: 'Choose the current Agent model',
      mEditor: 'Editor · project files', mProj: 'Open project', mProjSub: 'Pick a folder or create a project',
      mSet: 'Settings', mScreen: 'Screen', mScreenSub: 'View canvas and emulator windows',
      mPhone: 'This phone app', mVoice: 'Voice input', mVoiceSub: 'On · hold to talk',
      mTheme: 'Theme', mLang: '语言 / Language', mLangSub: '中文 · English（English）',
      thDark: 'Dark', thLight: 'Light', thSys: 'Follow system', thNow: 'now: ',
      edited: 'Edited', read: 'Read', command: 'Command', runTests: 'Ran',
      home: 'Overview', allC: 'All machines', wk: 'Workstation', wkLoad: 'Loading projects & sessions…',
      gNeed: 'Needs you', gRun: 'Running', gDone: 'Done',
      openC: 'Open conversation', opening: 'Opening…', wkQuota: 'Weekly quota', used38: '38% used',
      left72: '72% left', progDone: 'Done', phNext: 'Tell Cursor the next step…', yourMsg: 'You',
      bWait: 'Waiting', bRun: 'Running', bDone: 'Done',
      tWait: 'Migrate scripts', tCur: 'Refactor token refresh', tCodex: 'Fix table paging', tDoc: 'Update API docs',
      nWait: 'Confirm: overwrite existing table schema?', nCur: 'Editing src/auth/refresh.ts…',
      nCodex: 'Adjusting paging state logic…', nDoc: 'Committed 3 files',
      wWork: 'Working…', sumAll: 'All sessions', sumNeed: 'Needs you', sumRun: 'Running', sumDone: 'Done today',
      aiPrev: 'Sure — let me look at the current implementation, then split out the refresh logic.',
      qnCount: 'questions',
      mEntry: 'Open to', mEntrySub: 'Applies next launch or refresh', mEntryOv: 'Thumbnails', mEntryConv: 'Conversation',
      mModelG: 'Model', mGeneral: 'General', mConn: 'Agent & connection', mSettingsG: 'App settings & help',
      mMode: 'Mode', mModeSub: 'Write code, edit files, ask normally', mScreenItem: 'Screen', mSetItem: 'Settings',
      mExec: 'Show execution log', mExecSub: 'Includes tool reads and searches; hidden at turn end when off',
      mAgentMgr: 'Agent manager', mAgentMgrSub: 'Detect installs, pick and launch agents',
      mAutoLaunch: 'Auto-launch closed agents', mAutoLaunchSub: 'Start agents that are not running on connect',
      mReconnect: 'Reconnect', mDevices: 'Paired devices', mDeletePc: 'Remove this computer',
      mNotify: 'Notifications', mNotifySub: 'Alert when the agent finishes or needs you',
      mCache: 'Session cache', mCacheSub: 'Conversations saved on this phone; collapsible, clearable',
      mVer: 'Web version 2.4.0', mTransfer: 'File transfer', mVoiceMenu: 'Voice input', mComputer: 'Computer',
      mTerms: 'Terminals ▾', mTermPwd: 'Password', mTermCopy: 'Copy', mTermAll: 'Select all',
      mTermSize: 'Size', mTermRefresh: 'Refresh output', mTermMore: 'More', mTermInt: 'Interrupt',
      termTitle: 'RA Terminal', termSub: 'studio-pc · ~/work/auth-service'
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
        var pic = m.img ? '<span class="sentImage"><img src="' + m.img + '" alt=""></span>' : '';
        return '<div class="msg human">' + pic + '<div class="humanContent"><div class="bubble">' + esc(m.t) + '</div>' +
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
    /* master renderQuestions() generic card: details.qnCard > summary.qnHead + .qnBody */
    bar.innerHTML = '<details class="qnCard" open><summary class="qnHead"><span class="qnHeading">' + esc(L.qnHead) +
      '<span class="qnCount">1 ' + esc(L.qnCount) + '</span></span>' +
      '<svg class="arrowIcon qnFold" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary>' +
      '<div class="qnBody"><div class="qnQ">' + esc(q.q) + '</div><div class="qnOpts">' +
      q.opts.map(function (o, i) {
        return '<button class="qnOpt' + (q.sel === i ? ' on' : '') + '" data-qi="0" data-oi="' + i + '"><b>' + 'ABC'[i] + '</b><span>' + esc(o) + '</span></button>';
      }).join('') + '</div>' +
      '<div class="qnAct"><button data-qpart="skip">' + esc(L.skip) + '</button><button class="primary" data-qpart="submit"' +
      (q.sel == null ? ' disabled' : '') + '>' + esc(L.submit) + '</button></div></div></details>';
    bar.classList.add('show');
  }
  function renderSheet() {
    var s = ST.sheet, sheet = $('sheet'), shade = $('shade');
    if (!s) { sheet.classList.remove('open'); shade.classList.remove('open'); return; }
    if (s.kind === 'menu') {
      /* master showMainMenu(): header actions + entry row + model/general groups */
      var thNow = s.theme === 'dark' ? L.thDark : s.theme === 'light' ? L.thLight : L.thSys;
      var themeSub = LANG === 'en'
        ? 'Dark / Light / Follow system (now: ' + thNow + ')'
        : '深色 / 浅色 / 跟随系统（当前：' + thNow + '）';
      sheet.dataset.kind = 'main';
      sheet.innerHTML =
        '<div class="mainMenuHeader"><h3>' + esc(L.mMenu) + '</h3><div class="mainMenuActions">' +
        '<button class="menuHeaderAction" data-act="transfer" aria-label="' + esc(L.mTransfer) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M7 16V4m0 0L3 8m4-4 4 4M17 8v12m0 0 4-4m-4 4-4-4"/></svg></button>' +
        '<button class="menuHeaderAction" data-act="localVoiceMenu" aria-label="' + esc(L.mVoiceMenu) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button>' +
        '<button class="menuHeaderAction menuComputer" data-act="computers" aria-label="' + esc(L.mComputer) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg></button></div></div>' +
        '<div class="opt"><span class="lbl">' + esc(L.mEntry) + '<span class="sub">' + esc(L.mEntrySub) + '</span></span>' +
        '<div class="agentSessionFilter" style="width:176px;max-width:70%;margin:0" role="group"><button type="button" aria-pressed="true">' + esc(L.mEntryOv) + '</button><button type="button" aria-pressed="false">' + esc(L.mEntryConv) + '</button></div></div>' +
        '<details class="mainGroup" data-menu-group="model" open><summary>' + esc(L.mModelG) + '</summary><div class="mainGroupBody">' +
        '<div class="pSec">' + esc(s.appName || 'Cursor') + '</div>' +
        '<button class="opt" data-act="mode"><span class="lbl">' + esc(L.mMode) + '<span class="sub">' + esc(L.mModeSub) + '</span></span></button>' +
        '<button class="opt" data-act="screen"><span class="lbl">' + esc(L.mScreenItem) + '<span class="sub">' + esc(L.mScreenSub) + '</span></span></button>' +
        '<button class="opt" data-act="settings"><span class="lbl">' + esc(L.mSetItem) + '</span></button>' +
        '<button class="opt" data-act="executionToggle" role="switch" aria-checked="true"><span class="lbl">' + esc(L.mExec) + '<span class="sub">' + esc(L.mExecSub) + '</span></span><span class="switch on" aria-hidden="true"></span></button>' +
        '</div></details>' +
        '<details class="mainGroup" data-menu-group="general" open><summary>' + esc(L.mGeneral) + '</summary><div class="mainGroupBody">' +
        '<details class="mainGroup" data-menu-group="connection" open><summary>' + esc(L.mConn) + '</summary><div class="mainGroupBody">' +
        '<button class="opt" data-act="agentManager"><span class="lbl">' + esc(L.mAgentMgr) + '<span class="sub">' + esc(L.mAgentMgrSub) + '</span></span></button>' +
        '<button class="opt" id="menuLaunchRow" data-act="connLaunchToggle" role="switch" aria-checked="true"><span class="lbl">' + esc(L.mAutoLaunch) + '<span class="sub">' + esc(L.mAutoLaunchSub) + '</span></span><span class="switch on" aria-hidden="true"></span></button>' +
        '<button class="opt" data-act="reconnect"><span class="lbl">' + esc(L.mReconnect) + '</span></button>' +
        '<button class="opt" data-act="devices"><span class="lbl">' + esc(L.mDevices) + '</span></button>' +
        '<button class="opt" data-act="logout"><span class="lbl">' + esc(L.mDeletePc) + '</span></button>' +
        '</div></details>' +
        '<details class="mainGroup" data-menu-group="settings" open><summary>' + esc(L.mSettingsG) + '</summary><div class="mainGroupBody">' +
        '<button class="opt" id="notifySwitchRow" data-act="notifyToggle" role="switch" aria-checked="true"><span class="lbl">' + esc(L.mNotify) + '<span class="sub">' + esc(L.mNotifySub) + '</span></span><span class="switch on" aria-hidden="true"></span></button>' +
        '<button class="opt" data-act="theme" id="menuThemeRow"><span class="lbl">' + esc(L.mTheme) + '<span class="sub">' + esc(themeSub) + '</span></span></button>' +
        '<button class="opt" data-act="cache"><span class="lbl">' + esc(L.mCache) + '<span class="sub">' + esc(L.mCacheSub) + '</span></span></button>' +
        '<button class="opt" data-act="lang"><span class="lbl">' + esc(L.mLang) + '<span class="sub">' + esc(L.mLangSub) + '</span></span></button>' +
        '</div></details></div></details>' +
        '<p class="hint">' + esc(L.mVer) + '</p>';
      sheet.classList.add('open'); shade.classList.add('open');
      return;
    }
    /* master showWindows(): 切换 Agent sheet */
    sheet.dataset.kind = 'windows';
    sheet.innerHTML = '<h3>' + esc(L.switchAgent) + '</h3>' + s.rows.map(function (r) {
      var lg = r.logo === 'fusion'
        ? '<span class="optLogo" data-logo="fusion"><svg class="flogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4.5" r="2.5" fill="currentColor" stroke="none"/><path d="M12 7v4M4 15v-4h16v4M12 11v4"/><circle cx="4" cy="18" r="2.5"/><circle cx="12" cy="18" r="2.5"/><circle cx="20" cy="18" r="2.5"/></svg></span>'
        : '<span class="optLogo" data-logo="' + esc(r.logo) + '"></span>';
      return '<button class="opt' + (r.cur ? ' cur' : '') + '">' + lg +
        '<span class="lbl">' + esc(r.label) + (r.sub ? '<span class="sub">' + esc(r.sub) + '</span>' : '') + '</span>' +
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
    var html = '<span class="tprompt">' + esc(t.prompt || '$') + '</span>';
    if (t.cmd) html += ' ' + esc(t.cmd);
    if (t.lines && t.lines.length) html += '\n' + t.lines.map(esc).join('\n');
    $('termText').innerHTML = html;
    var tt = $('termText'); tt.scrollTop = 0;
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
  /* ---------- home (overview) screen — ported 1:1 from approved storyboard (master DOM) ---------- */
  var OV_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  var OV_ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  var OV_HIST = '<div class="ov-input-history"><button><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg></button><button><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button></div>';
  var OV_TOOL_ICONS = '<button title="add"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>'
    + '<button title="image"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></svg></button>'
    + '<button title="file"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6 3h8l4 4v14H6zM14 3v5h4"/></svg></button>'
    + '<button title="newline"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m9 10-5 5 5 5M20 4v7a4 4 0 0 1-4 4H4"/></svg></button>';
  var OV_USAGE = '<svg viewBox="0 0 40 40"><circle class="ov-meter-track" cx="20" cy="20" r="18.5" pathLength="100" stroke-dasharray="47 53" stroke-dashoffset="-1.5" transform="rotate(90 20 20)"/><circle class="ov-meter-context" cx="20" cy="20" r="18.5" pathLength="100" stroke-dasharray="17.86 82.14" stroke-dashoffset="-1.5" transform="rotate(90 20 20)"/><circle class="ov-meter-track" cx="20" cy="20" r="18.5" pathLength="100" stroke-dasharray="47 53" stroke-dashoffset="-51.5" transform="rotate(90 20 20)"/><circle class="ov-meter-quota" cx="20" cy="20" r="18.5" pathLength="100" stroke-dasharray="33.84 66.16" stroke-dashoffset="-51.5" transform="rotate(90 20 20)"/></svg>';
  function ovLogo(app) {
    return '<span class="ov-ag"><img class="on-dark" src="app-ui/logo-' + app + '-dark.svg" alt=""><img class="on-light" src="app-ui/logo-' + app + '-light.svg" alt=""></span>';
  }
  function ovTool(state, label) {
    var mark = state === 'done' ? '✓' : state === 'error' ? '!' : state === 'run' ? '◌' : '·';
    return '<div class="ov-run-tool ' + state + '" title="' + esc(label) + '"><span class="ov-run-mark">' + mark + '</span><span class="ovRaw">' + esc(label) + '</span></div>';
  }
  function toolLabel(m) { /* derive card tool row from the same AG.msgs the desktop shows */
    if (m.kind === 'read') return 'Read ' + (m.f || '');
    if (m.kind === 'edit') return 'Edited ' + (m.f || '') + ((m.add || m.del) ? ' +' + m.add + ' −' + m.del : '');
    if (m.kind === 'command') return 'Ran ' + (m.cmd || '') + (m.count > 0 ? ' · ' + m.count + '/' + m.total : '');
    return 'Ran';
  }
  function sessTile(o) {
    return '<div class="ov-tile ov-session ov-compact ov-st-' + o.st + (o.cls ? ' ' + o.cls : '') + '">' +
      '<span class="ov-card-surface" aria-hidden="true"></span>' +
      '<span class="ov-logo">' + ovLogo(o.app) + '</span><div class="ov-state"><span class="ov-badge">' + esc(o.badge) + '</span><span class="ov-time">' + (o.time || '') + '</span></div>' +
      '<div class="ov-title ovRaw">' + esc(o.title) + '</div>' +
      '<div class="ov-context ovRaw" title="' + esc(o.ctx) + '">' + esc(o.ctx) + '</div>' +
      '<div class="ov-now"><span class="ovRaw">' + esc(o.now) + '</span></div>' +
      '<div class="ov-foot"><span class="ov-num">' + (o.num || '') + '</span></div>' +
      '<div class="ov-actions"><span class="ov-work">' + esc(o.work) + '</span><button class="ov-link ov-direct">' + esc(L.openC) + '</button></div></div>';
  }
  function ovTop() {
    return '<div class="ov-top"><button class="ov-ibtn ov-hide"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>' +
      '<div class="ov-crumbs"><button>' + esc(L.home) + '</button><i>·</i><label class="ov-scope"><select class="ovRaw"><option selected>' + esc(L.allC) + '</option></select><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg></label></div>' +
      '<button class="ov-ibtn"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg></button></div>';
  }
  function ovSummary() {
    return '<div class="ov-sum"><span><i class="ov-d" style="background:var(--fg-3)"></i><b>4</b><em>' + esc(L.sumAll) + '</em></span>' +
      '<span><i class="ov-d" style="background:var(--ov-amber)"></i><b>1</b><em>' + esc(L.sumNeed) + '</em></span>' +
      '<span><i class="ov-d" style="background:var(--accent)"></i><b>2</b><em>' + esc(L.sumRun) + '</em></span>' +
      '<span><i class="ov-d" style="background:var(--ok)"></i><b>1</b><em>' + esc(L.sumDone) + '</em></span></div>';
  }
  function openCard(h, pr, f7) {
    var tools = (ST.msgs || []).filter(function (m) { return m.k === 'tool'; });
    var toolHtml = tools.map(function (m) { return ovTool(m.state, toolLabel(m)); });
    var sent = (ST.msgs || []).filter(function (m) { return m.k === 'human'; }).pop();
    var lastAi = null;
    (ST.msgs || []).forEach(function (m) { if (m.k === 'assistant') lastAi = m.t; });
    var preview = (sent && h.sent)
      ? '<div class="ov-last"><span class="ovRaw">' + esc(L.yourMsg) + '：' + esc(sent.t) + '</span></div>'
      : '<div class="ov-last"><span class="ovRaw">' + esc(lastAi || L.aiPrev) + '</span></div>';
    var link = h.opening ? '<button class="ov-link">' + esc(L.opening) + '</button>' : '<button class="ov-link">' + esc(L.openC) + '</button>';
    var draft = ST.draft
      ? '<div class="faket" style="font:inherit">' + esc(ST.draft) + '<span class="vcaret"></span></div>'
      : '<div class="faket" style="color:var(--fg-4,#9AA0AA);flex:1">' + esc(L.phNext) + '</div>';
    var shot = ST.attach ? '<img class="ov-shot" src="' + ST.attach.src + '" alt="">' : '';
    /* approved order: tools first, latest-message line last (shot7 splits 2+preview+2) */
    var mid = toolHtml.length > 3
      ? toolHtml.slice(0, 2).join('') + '</div>' + preview + '<div class="ov-run-tools">' + toolHtml.slice(2).join('')
      : toolHtml.join('') + '</div>' + preview + '<div class="ov-run-tools">';
    var pct = Math.round(100 * pr.done / pr.total);
    return '<div class="ov-tile ov-session ov-compact ov-st-run ov-open" style="--p:' + pct + '%">' +
      '<span class="ov-logo">' + ovLogo('cursor') + '<span class="ov-usage">' + OV_USAGE + '</span></span>' +
      '<div class="ov-state"><span class="ov-badge">' + esc(L.bRun) + '</span><span class="ov-time">14m</span></div>' +
      '<div class="ov-title ovRaw">' + esc(L.tCur) + '</div>' +
      '<button class="ov-close" aria-label="close">' + OV_X + '</button>' +
      '<div class="ov-card">' +
      '<div class="ov-status"><div class="ov-state"><span class="ov-badge">' + esc(L.bRun) + '</span><span class="ov-time">14m</span></div><span class="ovRaw">Cursor · auth-service</span></div>' +
      '<div class="ov-run-meta"><span class="ov-run-model ovRaw">Claude 4.5 Sonnet</span><span class="ov-run-count">' + esc(L.progDone) + ' ' + pr.done + '/' + pr.total + '</span></div>' +
      '<div class="ov-progress"><i style="width:' + pct + '%"></i></div>' +
      '<div class="ov-run-tools" tabindex="0">' + mid + '</div>' +
      '<div class="ov-composer">' + shot + OV_HIST + draft + '<button class="ov-send">' + OV_ARROW + '</button></div>' +
      '<div class="ov-cfoot"><div class="ov-tools">' + OV_TOOL_ICONS + '</div>' + link + '</div>' +
      '</div></div>';
  }
  function renderHome() {
    var h = ST.home || {}, pr = ST.prog || { done: 3, total: 7 };
    var board;
    if (h.loading) {
      var d1 = h.pct > 33 ? 'done' : 'current', d2 = h.pct > 66 ? 'done' : h.pct > 33 ? 'current' : '', d3 = h.pct > 66 ? 'current' : '';
      board = '<section class="ov-computer"><div class="ov-computer-row loading"><button type="button" class="ov-computer-toggle" aria-expanded="true"><span class="ov-computer-dot"></span><span class="ov-computer-label"><span class="ov-computer-name ovRaw">' + esc(L.wk) + '</span><span class="ov-computer-detail">' + esc(L.wkLoad) + '</span><span class="ov-computer-progress"><i class="' + d1 + '"></i><i class="' + d2 + '"></i><i class="' + d3 + '"></i></span></span></button><button type="button" class="ov-computer-fold"><svg class="ov-computer-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 5 7 7-7 7"/></svg></button></div>' +
        '<div class="ov-board">' + '<div class="ov-skel"><i></i><i></i><i></i></div>'.repeat(4) + '</div></section>';
    } else {
      var f7 = (ST.msgs || []).some(function (m) { return m.f === 'README.md'; });
      var cursor = h.expanded ? openCard(h, pr, f7)
        : sessTile({ st: 'run', app: 'cursor', cls: 'ov-cursor', badge: L.bRun, time: '14m', title: L.tCur, ctx: 'Cursor · auth-service', now: L.nCur, num: pr.done + '<small>/' + pr.total + '</small>', work: L.wWork });
      board = '<section class="ov-computer"><div class="ov-computer-row online"><button type="button" class="ov-computer-toggle" aria-expanded="true"><span class="ov-computer-dot"></span><span class="ov-computer-label"><span class="ov-computer-name ovRaw">' + esc(L.wk) + '</span></span></button><button type="button" class="ov-computer-fold"><svg class="ov-computer-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 5 7 7-7 7"/></svg></button></div>' +
        '<div class="ov-board">' +
        '<div class="ov-div">' + esc(L.gNeed) + ' · 1</div>' +
        sessTile({ st: 'wait', app: 'devin', badge: L.bWait, title: L.tWait, ctx: 'Devin · data-pipeline', now: L.nWait, work: L.bWait }) +
        '<div class="ov-div">' + esc(L.gRun) + ' · 2</div>' + cursor +
        sessTile({ st: 'run', app: 'codex', badge: L.bRun, time: '8m', title: L.tCodex, ctx: 'Codex · web-console', now: L.nCodex, work: L.wWork }) +
        '<div class="ov-div">' + esc(L.gDone) + ' · 1</div>' +
        sessTile({ st: 'done', app: 'cursor', badge: L.bDone, title: L.tDoc, ctx: 'Cursor · docs', now: L.nDoc, work: L.bDone }) +
        '</div></section>';
    }
    $('homeRoot').innerHTML = '<div id="overview" class="ov-root">' + ovTop() +
      '<div class="ov-body"><div class="ov-levels"></div><div class="ov-main">' +
      (h.loading ? '<div class="ov-sum"></div>' : ovSummary()) +
      '<div class="ov-lane" hidden></div><div class="ov-board">' + board + '</div></div></div></div>';
    /* keep the expanded card's composer visible above the fake keyboard (storyboard scroll rule) */
    if (!h.loading && h.expanded) {
      var b = $('homeRoot').querySelector('.ov-board'), c = $('homeRoot').querySelector('.ov-open .ov-cfoot');
      if (b && c) {
        /* park the card's composer/footer just above the board bottom (storyboard rule) */
        b.scrollTop = Math.max(0, c.getBoundingClientRect().bottom - b.getBoundingClientRect().top
          + b.scrollTop - b.clientHeight + 16);
      }
    }
  }
  /* Same fit as the app's screen view: the window keeps its aspect and sits in the middle. */
  function layoutVisual(retry) {
    var view = $('view'), stage = $('stage'), img = $('screen');
    var rw = img.naturalWidth || 442, rh = img.naturalHeight || 250;
    var stageW = Math.min(view.clientWidth || 0, (view.clientHeight || 0) * rw / rh);
    if (!stageW) { if (!retry) requestAnimationFrame(function () { layoutVisual(true); }); return; }
    var scale = stageW / rw;
    stage.style.width = stageW + 'px';
    stage.style.height = (rh * scale) + 'px';
    img.style.width = (rw * scale) + 'px';
    img.style.height = (rh * scale) + 'px';
    img.style.left = '0px';
    img.style.top = '0px';
    var sim = $('sim');
    if (sim) {
      sim.style.width = img.style.width;
      sim.style.height = img.style.height;
    }
  }
  /* One pass: the ball rolls in, slowly pushes the cube, then rolls away. The cube stays. */
  var SIM = { on: false, t0: 0, raf: 0, ready: 0, cx: 220, cy: 128, bx: 258, by: 156 };
  var simBg = new Image(), simCube = new Image(), simBall = new Image();
  function simCenter(img) {
    try {
      var c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      var g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      var d = g.getImageData(0, 0, c.width, c.height).data, w = c.width;
      var sx = 0, sy = 0, n = 0;
      for (var i = 3; i < d.length; i += 16) {
        if (d[i] > 40) {
          var p = (i - 3) >> 2;
          sx += p % w; sy += (p / w) | 0; n++;
        }
      }
      return n ? [sx / n, sy / n] : null;
    } catch (e) { return null; }
  }
  function simPose(t) {
    var approach = 1, push = 2.5, leave = 1.15;
    function sm(u) { u = u < 0 ? 0 : u > 1 ? 1 : u; return u * u * (3 - 2 * u); }
    if (t < approach) {
      var u = sm(t / approach);
      return { cube: 0, ball: 36 * (1 - u), spin: 36 * u };
    }
    t -= approach;
    if (t < push) {
      var d = -26 * (t / push);
      return { cube: d, ball: d, spin: 36 - d };
    }
    t -= push;
    var v = sm(t < 0 ? 0 : t > leave ? 1 : t / leave);
    return { cube: -26, ball: -26 + 52 * v, spin: 62 + 52 * v };
  }
  function drawSim() {
    var c = $('sim');
    if (!c || !simBg.naturalWidth) return;
    var ctx = c.getContext('2d');
    var w = simBg.naturalWidth, h = simBg.naturalHeight;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    var p = simPose(SIM.on ? (performance.now() - SIM.t0) / 1000 : 0);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(simBg, 0, 0);
    function shade(x, y, rx, ry) {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(rx, ry);
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, 6.2832);
      ctx.fillStyle = 'rgba(0,0,0,.32)';
      ctx.fill();
      ctx.restore();
    }
    shade(SIM.cx + p.cube, SIM.cy + 16, 30, 9);
    shade(SIM.bx + p.ball, SIM.by + 9, 12, 5);
    ctx.drawImage(simCube, p.cube, 0);
    ctx.save();
    ctx.translate(SIM.bx + p.ball, SIM.by);
    ctx.rotate(-p.spin / 13);
    ctx.drawImage(simBall, -SIM.bx, -SIM.by);
    ctx.restore();
  }
  function simLoop() {
    drawSim();
    if (SIM.on) SIM.raf = requestAnimationFrame(simLoop);
  }
  function startSim() {
    if (SIM.on) return;
    SIM.on = true;
    SIM.t0 = performance.now();
    if (SIM.ready >= 3) simLoop();
  }
  function stopSim() {
    SIM.on = false;
    if (SIM.raf) cancelAnimationFrame(SIM.raf);
    SIM.raf = 0;
  }
  function simWatch(img, src, pivot) {
    img.onload = function () {
      if (pivot) {
        var c = simCenter(img);
        if (c) { SIM[pivot + 'x'] = c[0]; SIM[pivot + 'y'] = c[1]; }
      }
      SIM.ready++;
      if (SIM.ready >= 3 && SIM.on && !SIM.raf) simLoop();
    };
    img.src = src;
  }
  simWatch(simBg, 'assets/mujoco-bg.png');
  simWatch(simCube, 'assets/mujoco-cube.png', 'c');
  simWatch(simBall, 'assets/mujoco-ball.png', 'b');
  var prevScreen = null;
  function apply(instant) {
    var st = ST;
    if (st.theme) document.documentElement.dataset.theme = st.theme;
    document.body.dataset.app = st.app || 'cursor';
    document.body.classList.toggle('term', st.screen === 'term');
    document.body.classList.toggle('chatmode', st.screen === 'chat');
    document.body.classList.toggle('home', st.screen === 'home');
    $('homeView').classList.toggle('active', st.screen === 'home');
    $('chatView').classList.toggle('active', st.screen === 'chat' || st.screen === 'term');
    document.body.classList.toggle('kb', !!st.kb);
    if (!instant && st.screen !== prevScreen && prevScreen) {
      var dir = st.screen === 'chat' ? 'pushin' : 'pushout';
      document.body.classList.remove('pushin', 'pushout');
      void document.body.offsetHeight;
      document.body.classList.add(dir);
    }
    prevScreen = st.screen;
    $('titleText').textContent = st.screen === 'term' ? L.termTitle : (st.title || 'Cursor');
    $('titleProject').textContent = st.screen === 'term' ? L.termSub : (st.project || '');
    $('tabChat').classList.toggle('on', st.screen !== 'term');
    $('tabTerm').classList.toggle('on', st.screen === 'term');
    $('chatView').classList.toggle('active', st.screen !== 'term' && st.screen !== 'visual');
    $('screenView').classList.toggle('active', st.screen === 'term' || st.screen === 'visual');
    document.body.classList.toggle('visual', st.screen === 'visual');
    var visualOn = st.screen === 'visual';
    var head = document.querySelector('body > header');
    var underHeader = (visualOn || st.screen === 'term') && head;
    $('screenView').style.top = underHeader ? head.offsetHeight + 'px' : '';
    if (st.screen === 'term') document.documentElement.dataset.theme = 'dark';
    ['visualHeader', 'visualCaption', 'visualHint'].forEach(function (id) { $(id).hidden = !visualOn; });
    $('view').classList.toggle('gesture', visualOn);
    if (visualOn) {
      $('chatView').classList.remove('active');
      $('homeView').classList.remove('active');
      $('visualEmpty').hidden = true;
      $('termEmpty').hidden = true;
      $('termBusy').hidden = true;
      $('screenKeys').hidden = true;
      $('visualBack').setAttribute('aria-label', L.vBack);
      $('visualTitle').textContent = st.screenTitle || '';
      $('visualChoose').title = st.screenTitle || '';
      $('visualStatus').textContent = L.vLive;
      $('visualStatus').dataset.state = 'live';
      $('visualPreview').textContent = L.vPreview;
      $('visualRead').textContent = L.vRead;
      $('zoom').hidden = false;
      $('zoom').textContent = L.vFit;
      $('refresh').textContent = L.vRefresh;
      $('visualHintText').textContent = L.vHint;
      $('visualZoom').textContent = '100%';
      $('stage').hidden = false;
      if (st.screenImg && $('screen').dataset.shot !== st.screenImg) {
        $('screen').onload = function () { layoutVisual(); };
        $('screen').src = st.screenImg;
        $('screen').dataset.shot = st.screenImg;
      }
      layoutVisual();
      startSim();
    } else stopSim();
    var attRow = document.querySelector('footer > .attachmentRow');
    if (attRow) {
      if (st.attach && st.screen === 'chat') {
        attRow.hidden = false;
        $('attachments').innerHTML = '<div class="attachment"><img src="' + st.attach.src + '" alt=""><span>' + esc(st.attach.name) + '</span></div>';
      } else {
        attRow.hidden = true;
        $('attachments').innerHTML = '';
      }
    }
    $('chatTools').hidden = st.screen !== 'chat';
    $('termTools').hidden = st.screen !== 'term';
    $('termToolsLabel').hidden = st.screen !== 'term';
    $('pickModelLabel').textContent = st.model || 'Auto';
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
    $('meterCtxTrack').setAttribute('data-n', '38');
    $('meterCtxTrack').style.setProperty('--pct', '38');
    $('meterCtxPct').textContent = L.used38;
    if (!$('quotaMeters').firstChild) {
      var qb = document.createElement('button');
      qb.className = 'meter'; qb.id = 'meterQuota'; qb.type = 'button';
      qb.innerHTML = '<span class="track" data-n="72" style="--pct:72"><i></i></span>' +
        '<span class="meterText"><span class="meterLabel">' + esc(L.wkQuota) + '</span><b>' + esc(L.left72) + '</b></span>';
      $('quotaMeters').appendChild(qb);
    }
    $('items').innerHTML = itemsHtml(st.msgs);
    $('list').scrollTop = $('list').scrollHeight;
    renderQuestion(st.q);
    renderSheet();
    renderLock();
    if (st.screen === 'term') fillTerm();
    if (st.screen === 'home') renderHome();
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
      if (m.instant) noanim(function () { apply(true); }); else apply();
      try {
        parent.postMessage({ type: 'probeRes',
          card: !!document.querySelector('#homeView .ov-card'),
          kb: document.body.classList.contains('kb'),
          scr: ST.screen, draft: (ST.draft || '').length }, '*');
      } catch (e) {}
    } else if (m.type === 'theme') {
      /* ack at once: the parent's view-transition update phase suppresses
         rendering, so waiting for rAF here would stall until its timeout */
      noanim(function () {
        document.documentElement.dataset.theme = document.body.classList.contains('term') ? 'dark' : (m.theme || 'light');
      });
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
    var sk = $('screenKeys').querySelector('[data-key="Enter"]'); if (sk) sk.textContent = LANG === 'en' ? 'Enter' : '回车';
  }
  if (SCREEN === 'file') { $('viewer').classList.add('open'); $('vFind').textContent = L.vSearch; $('vWrap').textContent = L.vWrap; $('vOnly').textContent = L.vOnly; }
  $('termEmpty').hidden = true;
  $('termEmptyNew').textContent = SCREEN === 'term' ? (LANG === 'en' ? 'New terminal' : '新建终端') : '';
  $('screenKeys').hidden = true;
  parent.postMessage({ type: 'ready' }, '*');
})();
