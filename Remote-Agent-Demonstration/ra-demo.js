/* Remote Agent promo demo v2 — theme-aware, real-app phone UI in iframes.
   One session state object (AG) renders into the desktop agent panel and is
   posted to phone.html iframes, so both sides always match.
   Strings come from RA_STRINGS[DEMO_LANG]. */
(function () {
  'use strict';
  var LANG = window.DEMO_LANG || 'zh';
  var S = RA_STRINGS[LANG];

  var params = new URLSearchParams(location.search);
  var SPEED = parseFloat(params.get('speed') || '1');
  var SEEK = parseFloat(params.get('t') || 'NaN');
  var PAUSE = params.get('pause') === '1';
  var LOOP = params.get('loop') === '1';
  var DEBUG = params.get('debug') === '1';
  var FF = false; // fast-forward (seek) mode: everything instant

  document.documentElement.dataset.theme = 'light';
  document.body.dataset.lang = LANG;
  function fail(m) { document.title = 'ERR:' + m; }
  window.onerror = function (m) { fail(m); };
  window.addEventListener('unhandledrejection', function (e) { fail(e.reason); });

  var stage = document.getElementById('stage');
  var EASE = 'cubic-bezier(.22,.61,.36,1)';
  var SPRING = 'cubic-bezier(.34,1.56,.5,1)';
  var ORIENT = (window.DEMO_ORIENT || params.get('o') || 'landscape') === 'portrait' ? 'portrait' : 'landscape';
  if (ORIENT === 'portrait') document.getElementById('stage').classList.add('portrait');
  /* layout table: phone = left/top base + transform strings; mon/pulse/relay are world-space */
  var LAY = ({
    landscape: {
      W: 1920, H: 1080, phBase: [1290, 70], phoneSolo: 'translate(0px,0px) scale(1)',
      phonePov: 'translate(-540px,29px) scale(1)', phoneSplit: 'translate(0px,0px) scale(1)',
      phoneCenter: 'translate(-540px,10px) scale(.85)',
      monFull: 'translate(300px,60px) scale(1)', monSide: 'translate(40px,130px) scale(.85)',
      monSplit: 'translate(60px,195px) scale(.75)', monEnter: 'translate(-1450px,195px) scale(.75)',
      relay: { x: 1065, y: 508, w: 215, h: 5, vert: 0, lbl: [985, 528, 388] },
      pulse: { x0: 1070, y0: 510, x1: 1275, y1: 510 },
      mphone: [642, 615, 44, 88], povAbs: [750, 99], povS: 1,
      more: { main: 'translate(-540px,10px) scale(.85)', slide: 360,
        t: { x: 250, y: 150, s: .72, r: -8 }, f: { x: 1230, y: 150, s: .72, r: 8 },
        lbl: { term: [250, 945], agents: [750, 945], file: [1230, 945] } },
      vcall: null
    },
    portrait: {
      W: 1080, H: 1920, phBase: [203, 120], phoneSolo: 'translate(0px,0px) scale(1.6)',
      phonePov: 'translate(0px,0px) scale(1.6)', phoneSplit: 'translate(67px,560px) scale(1.28)',
      phoneCenter: 'translate(-50px,80px) scale(1.35)',
      monFull: 'translate(124px,110px) scale(.63)', monSide: 'translate(124px,110px) scale(.63)',
      monSplit: 'translate(124px,110px) scale(.63)', monEnter: 'translate(124px,-820px) scale(.63)',
      relay: { x: 536, y: 601, w: 5, h: 87, vert: 1, lbl: [556, 626, 320] },
      pulse: { x0: 531, y0: 601, x1: 531, y1: 660 },
      mphone: [620, 610, 56, 112], povAbs: [203, 120], povS: 1.6,
      more: { main: 'translate(127px,300px) scale(1.05)', slide: 300,
        t: { x: -24, y: 310, s: .68, r: -8 }, f: { x: 686, y: 310, s: .68, r: 8 },
        lbl: { term: [36, 1095], agents: [390, 1350], file: [746, 1095] } },
      vcall: [540, 4, 520, 100]
    }
  })[ORIENT];

  /* ---------------- stage scaling ---------------- */
  function fit() {
    var s = Math.min(innerWidth / LAY.W, innerHeight / LAY.H);
    stage.style.transform = 'translate(' + ((innerWidth - LAY.W * s) / 2) + 'px,' +
      ((innerHeight - LAY.H * s) / 2) + 'px) scale(' + s + ')';
  }
  addEventListener('resize', fit); fit();

  /* ---------------- DOM helpers ---------------- */
  function el(tag, cls, parent, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    (parent || stage).appendChild(e);
    return e;
  }
  function place(e, r) {
    e.style.left = r[0] + 'px'; e.style.top = r[1] + 'px';
    e.style.width = r[2] + 'px'; e.style.height = r[3] + 'px';
  }

  /* ---------------- clock ---------------- */
  var cues = [], sleepers = [], elapsed = 0, clockStarted = false;
  var vNow = 0, vsleep = []; // virtual clock used while seeking (FF)
  function at(t, fn) { cues.push({ t: t, fn: fn }); }
  var T = 0.35;
  function scene(id, dur, build) { var t0 = T; T += dur; build(t0); }
  var END_T = 0;
  function wait(sec) {
    if (FF) return new Promise(function (r) { vsleep.push({ t: vNow + sec, r: r }); });
    return new Promise(function (r) { sleepers.push({ t: elapsed + sec, r: r }); });
  }
  var lastNow = 0;
  var VT = params.get('vt') === '1'; // headless captures: timer-driven clock (rAF stalls under --virtual-time-budget)
  function step(dt) {
    elapsed += dt * SPEED;
    for (var i = sleepers.length - 1; i >= 0; i--) if (sleepers[i].t <= elapsed) { var s = sleepers.splice(i, 1)[0]; s.r(); }
    for (var j = 0; j < cues.length; j++) if (!cues[j].done && cues[j].t <= elapsed) { cues[j].done = true; cues[j].fn(); }
    if (LOOP && elapsed > END_T + 4) { location.reload(); return; }
  }
  function tick(now) {
    if (!clockStarted) return;
    var dt = (now - lastNow) / 1000; lastNow = now;
    if (document.hidden) { requestAnimationFrame(tick); return; }
    step(dt);
    requestAnimationFrame(tick);
  }
  function vtTick() {
    if (!clockStarted) return;
    step(0.0167);
    setTimeout(vtTick, 16);
  }

  /* ---------------- animation helpers ---------------- */
  function applyKf(elm, kf) {
    var last = kf[kf.length - 1];
    Object.keys(last).forEach(function (k) {
      if (k === 'offset' || k === 'easing') return;
      try { elm.style[k] = last[k]; } catch (e) {}
    });
  }
  function lerpStr(a, b, f) {
    var ra = String(a).match(/-?\d*\.?\d+/g), rb = String(b).match(/-?\d*\.?\d+/g);
    if (!ra || !rb || ra.length !== rb.length) return f < .5 ? a : b;
    var i = 0;
    return String(b).replace(/-?\d*\.?\d+/g, function () {
      var v = parseFloat(ra[i]) + (parseFloat(rb[i]) - parseFloat(ra[i])) * f; i++;
      return String(Math.round(v * 100) / 100);
    });
  }
  function applyKfAt(elm, kf, f) {
    var offs = kf.map(function (k, i) { return k.offset !== undefined ? k.offset : i / (kf.length - 1); });
    var a = kf[0], b = kf[kf.length - 1], oa = offs[0], ob = offs[offs.length - 1];
    for (var i = 0; i < kf.length - 1; i++) {
      if (f >= offs[i] && f <= offs[i + 1]) { a = kf[i]; b = kf[i + 1]; oa = offs[i]; ob = offs[i + 1]; break; }
    }
    var lf = ob > oa ? (f - oa) / (ob - oa) : 1;
    Object.keys(b).forEach(function (k) {
      if (k === 'offset' || k === 'easing') return;
      var va = a[k] !== undefined ? a[k] : b[k];
      try { elm.style[k] = lerpStr(va, b[k], lf); } catch (e) {}
    });
  }
  function tween(elm, kf, ms, easing) {
    if (FF || VT) {
      /* no smooth animation while seeking or in headless vt captures */
      var fv = FF ? Math.max(0, (SEEK - vNow) / (ms / 1000)) : 1;
      if (fv >= 1) applyKf(elm, kf); else applyKfAt(elm, kf, fv);
      return wait(ms / 1000);
    }
    var a = elm.animate(kf, { duration: ms / SPEED, easing: easing || EASE, fill: 'forwards' });
    return a.finished.catch(function () {});
  }
  function cutAnim(elm) { elm.getAnimations().forEach(function (a) { a.cancel(); }); }
  function pop(elm, ms) {
    elm.classList.remove('hidden');
    return tween(elm, [{ opacity: 0, transform: 'scale(.5)' }, { opacity: 1, transform: 'scale(1)' }], ms || 450, SPRING);
  }

  /* ---------------- caption ---------------- */
  var capbar = el('div', '', stage); capbar.id = 'capbar';
  var capIn = el('span', 'cap-inner', capbar);
  var capVisible = false;
  function capHtml(t) { return ORIENT === 'portrait' ? t : t.replace(/<br\s*\/?>/g, ''); }
  function caption(key) {
    var txt = S[key]; if (!txt) return Promise.resolve();
    if (!capVisible) {
      capVisible = true; capIn.innerHTML = capHtml(txt);
      return tween(capbar, [{ opacity: 0, transform: 'translateY(24px)' }, { opacity: 1, transform: 'translateY(0px)' }], 500);
    }
    return tween(capIn, [{ opacity: 1 }, { opacity: 0 }], 150).then(function () {
      capIn.innerHTML = capHtml(txt);
      return tween(capIn, [{ opacity: 0 }, { opacity: 1 }], 220);
    });
  }
  function captionOff() {
    if (!capVisible) return Promise.resolve();
    capVisible = false;
    return tween(capbar, [{ opacity: 1 }, { opacity: 0 }], 350);
  }

  /* ---------------- backdrop + brandmark ---------------- */
  var backdrop = el('div', 'backdrop', stage);
  el('div', 'bgglow g1', backdrop); el('div', 'bgglow g2', backdrop);
  el('div', 'bgdots', backdrop);
  backdrop.querySelector('.g1').animate([{ transform: 'translate(0,0)' }, { transform: 'translate(60px,30px)' }],
    { duration: 14000, direction: 'alternate', iterations: Infinity, easing: 'ease-in-out' });
  backdrop.querySelector('.g2').animate([{ transform: 'translate(0,0)' }, { transform: 'translate(-70px,-40px)' }],
    { duration: 17000, direction: 'alternate', iterations: Infinity, easing: 'ease-in-out' });
  var brandmark = el('div', '', stage); brandmark.id = 'brandmark';
  brandmark.innerHTML = '<img src="assets/ra-icon.svg" alt=""><span>Remote Agent</span>';

  /* ---------------- world ---------------- */
  var world = el('div', '', stage); world.id = 'world'; world.style.opacity = '0';
  var worldTx = 'translate(0px,0px) scale(1)';
  function worldTo(css, ms) {
    var from = worldTx; worldTx = css;
    return tween(world, [{ transform: from }, { transform: css }], ms || 550);
  }
  function worldZoomIn(ms) { return worldTo('translate(0px,0px) scale(1)', ms); }
  function rectInWorld(e) {
    var r = e.getBoundingClientRect(), sr = stage.getBoundingClientRect();
    var k = sr.width / LAY.W;
    return [(r.left - sr.left) / k, (r.top - sr.top) / k, r.width / k, r.height / k];
  }
  var dim = el('div', '', stage); dim.id = 'dim';

  /* ================= THE AGENT SESSION (single state, two renderers) ================= */
  var AG = { msgs: [], mid: 0, status: 'run', q: null, draft: '', screen: 'home',
             focused: false, kb: false, voice: false, sheet: null, lock: null, notif: null,
             clock: '12:02', statusMsg: '', theme: 'light',
             sess: { title: S.sess_t, project: S.project, app: 'Cursor' },
             home: { loading: 1, pct: 0, expanded: 0, opening: 0 }, prog: { done: 0, total: 7 } };

  /* ---------- desktop ---------- */
  var monWrap = el('div', '', world); monWrap.id = 'monwrap';
  monWrap.style.transform = LAY.monEnter;
  monWrap.style.opacity = '0';
  el('div', 'monframe', monWrap); el('div', 'monstand', monWrap); el('div', 'monbase', monWrap);
  var scr = el('div', 'scr', monWrap);

  function winHtml(body) { return '<div class="wtb"></div><div class="wc">' + body + '</div>'; }
  var wBrowser = el('div', 'bwin', scr); place(wBrowser, [24, 34, 300, 320]);
  wBrowser.innerHTML = winHtml('<div class="wurl"></div><div class="whero"></div>' +
    '<div class="wl" style="left:14px;top:160px;width:250px"></div><div class="wl" style="left:14px;top:182px;width:210px"></div>' +
    '<div class="wl" style="left:14px;top:204px;width:236px"></div><div class="wl" style="left:14px;top:226px;width:150px"></div>');
  var bwins = [wBrowser];

  var ide = el('div', 'ide', scr); place(ide, [270, 24, 1010, 690]);
  ide.innerHTML = '<div class="itb"><i></i><i></i><i></i><span>' + S.project + ' — Cursor</span></div>';
  var tree = el('div', 'tree', ide);
  [[10, 12, 'src/', 'dir'], [22, 34, 'auth/', 'dir'], [34, 56, 'token.ts', 'sel'], [34, 78, 'refresh.ts', ''],
   [10, 100, 'README.md', ''], [10, 122, 'package.json', '']
  ].forEach(function (n) {
    var t = el('div', 'tnode ' + n[3], tree, n[2]);
    t.style.left = n[0] + 'px'; t.style.top = n[1] + 'px';
  });
  var CODE = [
    '<span class="kw">import</span> { request } <span class="kw">from</span> <span class="str">\'./http\'</span>',
    '',
    '<span class="kw">export async function</span> <span class="fn">refreshToken</span>(<span class="ty">session</span>) {',
    '  <span class="kw">if</span> (session.expires &lt; Date.now()) {',
    '    <span class="kw">const</span> next = <span class="kw">await</span> <span class="fn">request</span>(<span class="str">\'/oauth/refresh\'</span>, {',
    '      method: <span class="str">\'POST\'</span>, body: session.refresh,',
    '      retry: { attempts: <span class="num">3</span>, backoff: <span class="str">\'exp\'</span> },',
    '    });',
    '    <span class="kw">return</span> <span class="fn">applyToken</span>(next); <span class="cm">// 失败时保留旧令牌</span>',
    '  }',
    '  <span class="kw">return</span> session.token;',
    '}',
    ''
  ];
  var editor = el('div', 'editor', ide); place(editor, [168, 34, 690, 456]);
  var clines = CODE.map(function (c, i) {
    return el('div', 'cline', editor, '<span class="ln">' + (i + 1) + '</span><span class="cc">' + (c || ' ') + '</span>');
  });
  var term = el('div', 'term', ide); place(term, [168, 496, 690, 194]);
  /* desktop terminal follows the AG test counter — never shows future results */
  var termTestLn = null, termSuiteIdx = 0;
  var TERM_SUITES = ['  ✓ auth/session.test.ts (12)', '  ✓ auth/token.test.ts (8)', '  ✓ api/legacy.test.ts (6)',
    '  ✓ auth/refresh.test.ts (9)', '  ✓ auth/compat.test.ts (11)', '  ✓ e2e/migrate.test.ts (24)'];
  function termPush(html) {
    var ln = el('div', 'tline', term, html);
    while (term.children.length > 9) term.firstElementChild.remove();
    return ln;
  }
  function termForTest(m) {
    var n = m.count || 0;
    var want = Math.min(TERM_SUITES.length, Math.floor(n / 18));
    while (termSuiteIdx < want) termPush(TERM_SUITES[termSuiteIdx++]);
    if (n > 0) {
      if (!termTestLn) termTestLn = termPush('');
      termTestLn.textContent = 'Tests: ' + n + ' of 132 passed';
    }
    if (m.state === 'done') {
      if (termTestLn) { termTestLn.remove(); termTestLn = null; }
      termPush('Test Suites: 14 passed, 14 total').classList.add('ok');
      termPush('Tests: 132 passed, 132 total').classList.add('ok');
    }
  }

  function flashCode(i) {
    var a = clines[(i * 5) % clines.length], b = clines[(i * 5 + 9) % clines.length];
    [a, b].forEach(function (c) { c.classList.remove('lit'); void c.offsetWidth; c.classList.add('lit'); });
    wait(1.0).then(function () { [a, b].forEach(function (c) { c.classList.remove('lit'); }); });
  }

  var dPanel = el('div', 'apanel dpanel', scr);
  dPanel.innerHTML = '<div class="ahead"></div><div class="abody"></div>' +
    '<div class="ainput"><div class="abox"><span class="ph">' + (LANG === 'en' ? 'Ask anything' : '问点什么') + '</span>' +
    '<span class="dt"></span><span class="caret"></span></div><div class="sendbtn">↑</div></div>';
  var dHead = dPanel.querySelector('.ahead'), dBody = dPanel.querySelector('.abody');
  var dBox = dPanel.querySelector('.abox'), dPh = dBox.querySelector('.ph'), dTxt = dBox.querySelector('.dt'),
      dCaret = dBox.querySelector('.caret');

  var taskbar = el('div', 'taskbar', scr);
  ['tb1', 'tb2', 'tb3', 'tb4', 'tb5'].forEach(function (c) { el('i', 'tbi ' + c, taskbar, ''); });

  /* ---------- voice callout (annotation over the desktop input) ---------- */
  var vcall = el('div', 'vcall', world);
  vcall.innerHTML = '<div class="vcap">' + S.lbl_pcinput + '</div><div class="vtxt"></div>';
  var vTxt = vcall.querySelector('.vtxt');
  var vlead = el('div', 'vlead', world);
  function showCallout() {
    if (FF) { vcall.style.opacity = '1'; vlead.style.opacity = '1'; }
    var r = rectInWorld(dBox);
    var cx, cy, w;
    if (LAY.vcall) { cx = LAY.vcall[0]; cy = LAY.vcall[1]; w = LAY.vcall[2]; }
    else {
      cx = Math.min(760, Math.max(120, r[0] - 320));
      cy = Math.max(46, Math.min(r[1] - 620, 160)); w = 400;
    }
    place(vcall, [cx, cy, w, LAY.vcall ? LAY.vcall[3] : 110]);
    /* leader from callout bottom to the input box top edge */
    var ax = cx + 200, ay = vcall.offsetTop + 110, bx = r[0] + r[2] / 2, by = r[1] + 8;
    var dx = bx - ax, dy = by - ay, len = Math.sqrt(dx * dx + dy * dy), ang = Math.atan2(dy, dx) * 180 / Math.PI;
    vlead.style.left = ax + 'px'; vlead.style.top = ay + 'px';
    vlead.style.width = len + 'px'; vlead.style.transform = 'rotate(' + ang + 'deg)';
    tween(vcall, [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'translateY(0px)' }], 400);
    tween(vlead, [{ opacity: 0 }, { opacity: 1 }], 400);
    dBox.classList.add('glow');
  }
  function hideCallout() {
    tween(vcall, [{ opacity: 1 }, { opacity: 0 }], 300);
    tween(vlead, [{ opacity: 1 }, { opacity: 0 }], 300);
    dBox.classList.remove('glow');
  }
  function setVText(t) { vTxt.textContent = t; }

  /* ---------- phone (parent chrome + iframe app) ---------- */
  var phoneWrap = el('div', '', world); phoneWrap.id = 'phonewrap';
  var pscrFx = '<div class="hscr"><div class="hgrid">' + [0,1,2,3,4,5,6,7,'RA',9,10,11].map(function (c) {
      return c === 'RA' ? '<div class="hic ra" id="raIcon"><img src="assets/ra-icon.svg"></div>'
        : '<div class="hic" style="background:' + ['#D8DEEA','#E5D9C8','#D9E4D9','#E8D2D2','#D5DCE8','#E3D8EA','#D2E0E4','#E9E0CE','#DCE2EC','#E6DBD2','#D8E3DA'][c] + '"></div>';
    }).join('') + '</div></div>' +
    '<div class="launch"><img class="lzicon" src="assets/ra-icon.svg"><div class="lname">Remote Agent</div>' +
    '<div class="ltag">' + S.brand_tag + '</div></div>' +
    '<div class="pflash"></div><div class="prip"></div>' +
    '<div class="pstatus"><span class="ptime">12:02</span><span class="sic"><span class="sbar"></span>' +
    '<span class="sbar"></span><span class="sbar"></span><svg class="wifi" viewBox="0 0 16 12"><path d="M8 10.5 2.5 5a8 8 0 0 1 11 0Z"/><circle cx="8" cy="10" r="1.6"/></svg>' +
    '<span class="batt"></span></span></div><div class="pisland"></div>';
  phoneWrap.innerHTML = '<div class="pframe"></div><div class="pscr">' +
    '<iframe class="papp" src="phone.html?lang=' + LANG + '&screen=home"></iframe>' + pscrFx + '</div>';
  var pScr = phoneWrap.querySelector('.pscr');
  var pApp = pScr.querySelector('.papp');
  var pHscr = pScr.querySelector('.hscr'), pLaunch = pScr.querySelector('.launch'),
      pFlash = pScr.querySelector('.pflash'), pRip = pScr.querySelector('.prip');
  var pTime = pScr.querySelector('.ptime');
  phoneWrap.style.left = LAY.phBase[0] + 'px'; phoneWrap.style.top = LAY.phBase[1] + 'px';
  phoneWrap.style.transform = LAY.phonePov;

  /* side phones for the "more" scene: same renderer, other screens */
  function sidePhone() {
    var w = el('div', 'sphone hidden', world);
    w.innerHTML = phoneWrap.innerHTML;
    return w;
  }
  var sPhoneT = sidePhone();
  sPhoneT.querySelector('.papp').src = 'phone.html?lang=' + LANG + '&screen=term';
  var sPhoneF = sidePhone();
  sPhoneF.querySelector('.papp').src = 'phone.html?lang=' + LANG + '&screen=file';
  [sPhoneT, sPhoneF].forEach(function (w) {
    var h = w.querySelector('.hscr'); if (h) h.remove();
    var l = w.querySelector('.launch'); if (l) l.remove();
  });
  var sAppT = sPhoneT.querySelector('.papp'), sAppF = sPhoneF.querySelector('.papp');
  var lblTerm = el('div', 'slbl hidden', world, S.lbl_term);
  var lblAgents = el('div', 'slbl hidden', world, S.lbl_agents);
  var lblFile = el('div', 'slbl hidden', world, S.lbl_file);

  var relay = el('div', 'relay hidden', world);
  if (LAY.relay.vert) relay.classList.add('vert');
  relay.style.left = LAY.relay.x + 'px'; relay.style.top = LAY.relay.y + 'px';
  if (LAY.relay.vert) { relay.style.width = '5px'; relay.style.height = '0px'; }
  else { relay.style.width = '0px'; relay.style.height = '5px'; }
  var relayLbl = el('div', 'relaylbl hidden', world, S.relay);
  relayLbl.style.left = LAY.relay.lbl[0] + 'px'; relayLbl.style.top = LAY.relay.lbl[1] + 'px';
  relayLbl.style.width = LAY.relay.lbl[2] + 'px';
  relayLbl.style.textAlign = LAY.relay.vert ? 'left' : 'center';

  /* ---------- iframe protocol ---------- */
  var frames = [pApp, sAppT, sAppF], readyCount = 0, themedCount = 0, themedWaiters = [], lastTapRect = null, tapWaiters = [];
  addEventListener('message', function (e) {
    var d = e.data || {};
    if (d.type === 'ready') readyCount++;
    if (d.type === 'probeRes') window.__probe = d;
    else if (d.type === 'themed') { themedCount++; themedWaiters.forEach(function (r) { r(); }); themedWaiters = []; }
    else if (d.type === 'fxrect') { lastTapRect = d.rect; tapWaiters.forEach(function (r) { r(d.rect); }); tapWaiters = []; }
  });
  function postTo(f, m) { try { f.contentWindow.postMessage(m, '*'); } catch (e) {} }
  function phoneMsgs() {
    return AG.msgs.map(function (m) {
      if (m.type === 'user') return { k: 'human', t: m.text, time: m.time };
      if (m.type === 'ai' || m.type === 'final') return { k: 'assistant', t: m.text };
      if (m.type === 'ans') return { k: 'ans', t: m.text };
      if (m.type === 'read') return { k: 'tool', kind: 'read', f: m.f, state: m.state };
      if (m.type === 'edit') return { k: 'tool', kind: 'edit', f: m.f, add: m.add, del: m.del, state: m.state };
      if (m.type === 'test') return { k: 'tool', kind: 'command', cmd: m.cmd, state: m.state, count: m.count, total: m.total,
        out: 'Tests: ' + m.count + ' of ' + m.total + ' passed' };
      if (m.type === 'qcard' && AG.q && AG.q.answer != null) return { k: 'ans', t: S.q_done };
      return null;
    }).filter(Boolean);
  }
  function baseState() {
    return {
      app: 'cursor', title: AG.sess.title, project: AG.sess.project, model: S.model,
      status: AG.status, msgs: phoneMsgs(), q: AG.q, draft: AG.draft,
      focused: AG.focused, kb: AG.kb, voice: AG.voice, sheet: AG.sheet,
      lock: AG.lock, notif: AG.notif, statusMsg: AG.statusMsg, theme: AG.theme,
      screen: AG.screen, home: AG.home, prog: AG.prog
    };
  }
  function syncPhone(instant) {
    var st = baseState();
    postTo(pApp, { type: 'state', state: st, instant: !!instant });
    var stT = baseState(); stT.screen = 'term'; stT.sheet = null; stT.lock = null; stT.notif = null;
    stT.term = { cmd: S.term_cmd, lines: S.term_lines };
    postTo(sAppT, { type: 'state', state: stT, instant: !!instant });
    var stF = baseState(); stF.screen = 'file'; stF.sheet = null; stF.lock = null; stF.notif = null;
    stF.file = fileState();
    postTo(sAppF, { type: 'state', state: stF, instant: !!instant });
  }
  function fx(frame, name, args, dur) {
    if (FF) return Promise.resolve();
    postTo(frame, { type: 'fx', name: name, args: args || {}, dur: dur });
    return wait(0.25);
  }
  function pTap(sel, args) {
    return fx(pApp, 'tap', Object.assign({ sel: sel }, args || {}));
  }
  /* tap and report the element's center (iframe coords) — used to anchor the theme circle */
  function pTapReport(sel) {
    if (FF) return Promise.resolve(null);
    var pr = new Promise(function (r) { tapWaiters.push(r); setTimeout(function () { r(lastTapRect); }, 800); });
    postTo(pApp, { type: 'fx', name: 'tap', args: { sel: sel, report: true }, dur: 0 });
    return pr;
  }

  /* file viewer payload (compat.ts with agent changes highlighted) */
  var FILE_LINES = null;
  function fileState() {
    if (!FILE_LINES) {
      var src = [
        ["import { Session } from './session';", ''],
        ["import { legacy } from '../api/legacy';", ''],
        ['', ''],
        ['// compat layer for the 3 legacy callers', 'cm'],
        ['export function compat(s: Session) {', 'add'],
        ['  const mapped = legacy.wrap(s, {', 'add'],
        ["    api: 'v1', strict: false,", 'add'],
        ['  });', 'add'],
        ['  return mapped.bind(s.token);', 'add'],
        ['}', 'add'],
        ['', ''],
        ['export async function refreshAll() {', ''],
        ['  await Session.refresh({ window: 300 });', 'mod'],
        ['  return Session.current();', ''],
        ['}', ''],
        ['', '']
      ];
      /* single-pass highlighter on raw text so markup never gets re-tokenized */
      var RX = /('[^']*'|\/\/.*$|\b(?:import|from|export|function|const|return|async|await)\b|\b(?:Session|legacy|mapped)\b|\b(?:wrap|bind|refresh|current|compat|refreshAll)\b|\b\d+\b)/g;
      FILE_LINES = src.map(function (l, i) {
        var raw = l[0].replace(/&/g, '&amp;').replace(/</g, '&lt;');
        var h = raw.replace(RX, function (m) {
          var c = /^'/.test(m) ? '#1A7F37' : /^\/\//.test(m) ? '#98A0AC'
            : /^(import|from|export|function|const|return|async|await)$/.test(m) ? '#8957E5'
            : /^(Session|legacy|mapped)$/.test(m) ? '#B7791F'
            : /^(wrap|bind|refresh|current|compat|refreshAll)$/.test(m) ? '#0958D9' : '#B4690E';
          return '<span style="color:' + c + '">' + m + '</span>';
        });
        return { n: i + 1, h: h || ' ', mk: l[1] === 'add' ? 'add' : l[1] === 'mod' ? 'mod' : '' };
      });
    }
    return { name: 'compat.ts', path: S.file_path, lines: FILE_LINES, marks: 6 };
  }

  /* ---------- theme beat ---------- */
  function setThemeInstant(th) {
    AG.theme = th;
    document.documentElement.dataset.theme = th;
    frames.forEach(function (f) { postTo(f, { type: 'theme', theme: th }); });
    syncPhone(FF);
  }
  function allThemed() {
    themedCount = 0;
    var target = frames.length;
    return new Promise(function (r) {
      var to = setTimeout(r, 600);
      themedWaiters.push(function () { if (themedCount >= target) { clearTimeout(to); r(); } });
    });
  }
  function switchTheme(th, px, py) {
    /* px,py = viewport coords of the tap point (circle origin) */
    /* keep AG.sheet in sync with the menu's current-theme label */
    function commit() {
      AG.theme = th;
      if (AG.sheet && AG.sheet.kind === 'menu') { AG.sheet.theme = th; }
    }
    if (FF || !document.startViewTransition) { commit(); setThemeInstant(th); return; }
    var R = Math.ceil(Math.max(
      Math.hypot(px, py), Math.hypot(innerWidth - px, py),
      Math.hypot(px, innerHeight - py), Math.hypot(innerWidth - px, innerHeight - py)));
    /* nothing may reach the phones before the old snapshot is captured,
       otherwise they flip ahead of the circle */
    var vt = document.startViewTransition(function () {
      commit();
      document.documentElement.dataset.theme = th;
      frames.forEach(function (f) { postTo(f, { type: 'theme', theme: th }); });
      syncPhone(false);
      return allThemed();
    });
    vt.ready.then(function () {
      document.documentElement.animate(
        [{ clipPath: 'circle(0px at ' + px + 'px ' + py + 'px)' },
         { clipPath: 'circle(' + R + 'px at ' + px + 'px ' + py + 'px)' }],
        { duration: 450 / SPEED, easing: 'ease-in-out', pseudoElement: '::view-transition-new(root)' });
    }).catch(function () {});
  }
  /* translate an iframe-space point to viewport coords */
  function iframeToViewport(f, pt) {
    var r = f.getBoundingClientRect();
    return [r.left + pt[0] / 393 * r.width, r.top + pt[1] / 805 * r.height];
  }

  /* ---------- mutators ---------- */
  function headHtml() {
    var lab = AG.status === 'wait' ? (LANG === 'en' ? 'Waiting' : '等待')
      : AG.status === 'done' ? (LANG === 'en' ? 'Done' : '已完成') : (LANG === 'en' ? 'Running' : '运行中');
    return '<span class="adot"></span><div class="hname"><span class="aname">' + AG.sess.title + '</span>' +
      '<span class="asub">' + AG.sess.project + ' · ' + AG.sess.app + '</span></div>' +
      '<span class="stpill ' + AG.status + '"><span class="sd"></span>' + lab + '</span>';
  }
  function qCardHtml(q) {
    if (q.answer != null) return '<div class="ansrow"><span class="check">✓</span>' + S.q_done + '</div>';
    var h = '<div class="qcard"><div class="qq">' + q.q + '</div>';
    q.opts.forEach(function (o, i) {
      h += '<div class="opt' + (q.sel === i ? ' sel' : '') + '"><span class="key">' + 'ABC'[i] + '</span>' + o + '</div>';
    });
    return h + '</div>';
  }
  function dMsgHtml(m) {
    if (m.type === 'user') return '<div class="msg user"><div class="bub">' + m.text + '</div></div>';
    if (m.type === 'final') return '<div class="msg ai"><div class="bub final"><span class="check">✓</span> ' + m.text + '</div></div>';
    if (m.type === 'ans') return '<div class="ansrow"><span class="check">✓</span>' + m.text + '</div>';
    if (m.type === 'ai') return '<div class="msg ai"><div class="bub">' + m.text + '</div></div>';
    if (m.type === 'qcard') return qCardHtml(AG.q);
    var st = m.state === 'done' ? '<span class="check">✓</span>' : '<span class="spin"></span>';
    if (m.type === 'read') return '<div class="trow ' + m.state + '"><span class="st">' + st + '</span><b>Read</b><span class="args">' + m.f + '</span></div>';
    if (m.type === 'edit') return '<div class="trow ' + m.state + '"><span class="st">' + st + '</span><b>Edited</b><span class="args">' + m.f + '</span>' +
      '<span class="stat add">+' + (m.add || 0) + '</span><span class="stat del">-' + (m.del || 0) + '</span></div>';
    if (m.type === 'test') return '<div class="trow ' + m.state + '"><span class="st">' + st + '</span><b>Ran</b><span class="args">' + m.cmd + '</span>' +
      '<span class="tcnt">' + m.count + '/' + m.total + '</span></div>';
    return '';
  }
  function renderDPanel() {
    dHead.innerHTML = headHtml();
    dBody.innerHTML = AG.msgs.map(dMsgHtml).join('');
  }
  function renderDDraft() {
    dPh.style.display = AG.draft ? 'none' : '';
    dTxt.style.display = AG.draft ? '' : 'none';
    dTxt.textContent = AG.draft;
    dCaret.style.display = AG.draft ? '' : 'none';
  }
  function agPush(msg) {
    msg.id = 'm' + (++AG.mid);
    msg.time = AG.clock;
    AG.msgs.push(msg);
    var d = el('div', '', dBody); d.innerHTML = dMsgHtml(msg); msg.d = d;
    if (!FF && !VT) d.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0px)' }],
      { duration: 240, easing: EASE, fill: 'forwards' });
    syncPhone(FF);
    return msg.id;
  }
  function agUpdate(id, patch) {
    var m = AG.msgs.filter(function (x) { return x.id === id; })[0];
    if (!m) return;
    Object.keys(patch).forEach(function (k) { m[k] = patch[k]; });
    if (m.d) m.d.innerHTML = dMsgHtml(m);
    if (m.type === 'test') termForTest(m);
    syncPhone(FF);
  }
  function agDraft(text, opts) {
    AG.draft = text;
    if (!opts || !opts.late) renderDDraft();
    setVText(text);
    syncPhone(FF);
  }
  function agDraftLate(text) {
    AG.draft = text;
    var expect = text;
    wait(0.4).then(function () { if (AG.draft === expect || AG.draft.indexOf(expect) === 0) renderDDraft(); });
    setVText(text);
    syncPhone(FF);
  }
  function agQuestion(q) { AG.q = { q: q.q, opts: q.opts, sel: null, answer: null }; agPush({ type: 'qcard' }); }
  function agSel(i) { if (AG.q) { AG.q.sel = i; renderDPanel(); syncPhone(FF); } }
  function agAnswer(i) {
    if (!AG.q) return;
    AG.q.sel = i; AG.q.answer = i;
    renderDPanel();
    syncPhone(FF);
  }
  function agStatus(s) { AG.status = s; renderDPanel(); syncPhone(FF); }
  function agScreen(s) { AG.screen = s; syncPhone(FF); }
  function agHome(patch) { Object.keys(patch).forEach(function (k) { AG.home[k] = patch[k]; }); syncPhone(FF); }
  function agRemove(id) { var i = AG.msgs.findIndex(function (m) { return m.id === id; }); if (i >= 0) AG.msgs.splice(i, 1); renderDPanel(); syncPhone(FF); }
  function agProg(d, t) { AG.prog.done = d; if (t) AG.prog.total = t; syncPhone(FF); }
  function agFocus(on) { AG.focused = on; AG.kb = on; syncPhone(FF); }
  function agVoice(on) {
    AG.voice = on;
    AG.statusMsg = '';
    syncPhone(FF);
  }
  function agLock(on) {
    AG.lock = on ? { time: AG.clock, date: S.lock_date } : null;
    if (!on) AG.notif = null;
    syncPhone(FF);
  }
  function agNotif(title, body) { AG.notif = { title: title, body: body }; syncPhone(FF); }
  function agSheet() {
    AG.sheet = { kind: 'agents', rows: [
      { logo: 'cursor', label: 'Cursor', sub: AG.sess.project + ' · ' + AG.sess.title, cur: true, running: true },
      { logo: 'devin', label: 'Devin' },
      { logo: 'codex', label: 'Codex' },
      { logo: 'fusion', label: 'Fusion' }
    ] };
    syncPhone(FF);
  }
  function agMenu() { AG.sheet = { kind: 'menu', appName: 'Cursor', theme: AG.theme }; syncPhone(FF); }
  function agSheetOff() { AG.sheet = null; syncPhone(FF); }
  function termState(cmd, lines) {
    var st = baseState(); st.screen = 'term';
    st.sheet = null; st.lock = null; st.notif = null;
    st.term = { cmd: cmd, lines: lines || [] };
    postTo(sAppT, { type: 'state', state: st, instant: FF });
  }

  function setTime(txt) {
    AG.clock = txt;
    pTime.textContent = txt;
    if (AG.lock) { AG.lock.time = txt; syncPhone(FF); }
    [sPhoneT, sPhoneF].forEach(function (w) {
      var t = w.querySelector('.ptime'); if (t) t.textContent = txt;
    });
  }

  function pulseBeam() {
    if (FF || VT) return;
    var b = el('div', 'pulsebeam', world);
    b.style.left = LAY.pulse.x0 + 'px'; b.style.top = LAY.pulse.y0 + 'px';
    tween(b, [{ left: LAY.pulse.x0 + 'px', top: LAY.pulse.y0 + 'px', opacity: 1 },
      { left: LAY.pulse.x1 + 'px', top: LAY.pulse.y1 + 'px', opacity: 1 }], 700, 'linear')
      .then(function () { return tween(b, [{ opacity: 1 }, { opacity: 0 }], 150); })
      .then(function () { b.remove(); });
  }

  /* focus the phone: dim monitor + relay to ~45% (no camera push-ins) */
  function focusPhone(on) {
    var to = on ? 0.45 : 1;
    tween(monWrap, [{ opacity: on ? 1 : 0.45 }, { opacity: to }], 450);
    tween(relay, [{ opacity: on ? 1 : 0.45 }, { opacity: to }], 450);
    tween(relayLbl, [{ opacity: on ? 1 : 0.45 }, { opacity: to }], 450);
  }

  renderDPanel(); renderDDraft(); syncPhone(true);

  /* ================= intro scenes ================= */
  var RI = RA_INTRO.build(ORIENT);
  var introL = el('div', 'introL', world);
  var quadPanes = [0, 1, 2, 3].map(function (i) {
    var p = el('div', 'ipanel', introL, RI.SC(0)[i] + '<div class="phvar">' + RI.SC(1)[i] + '</div>');
    place(p, [RI.PX[i & 1], RI.PY[i >> 1], RI.PW, RI.PH]);
    return p;
  });
  var pill = el('div', 'cpill', introL, (ORIENT === 'portrait' && S.intro_line_p) ? S.intro_line_p : S.intro_line);
  var blur = el('div', 'blurbg', introL, RI.svg(RI.DEFS + RI.cafe));
  blur.style.opacity = '0';
  var hands = el('div', 'povhands', introL, RI.povHands(1));
  hands.style.opacity = '0';
  var mphone = el('div', 'mphone', introL);
  place(mphone, LAY.mphone); mphone.style.opacity = '0';
  mphone.innerHTML = '<div class="mpscr">' + pscrFx + '</div>';
  var brandfly = el('div', 'brandfly', world);
  brandfly.innerHTML = '<img class="bfi" src="assets/ra-icon.svg"><div class="bft">Remote Agent</div>';
  world.style.opacity = '1';
  monWrap.style.transform = LAY.monEnter; monWrap.style.opacity = '0';

  /* intro 1 — four panels + pill appear together */
  scene('quad', 2.5, function (t0) {
    at(t0, function () {
      quadPanes.forEach(function (p) {
        tween(p, [{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'scale(1)' }], 500);
      });
      tween(pill, [{ opacity: 0, transform: 'translate(-50%,-50%) scale(.9)' },
        { opacity: 1, transform: 'translate(-50%,-50%) scale(1)' }], 450);
    });
  });

  /* intro 2 — pill fades, everyone raises a phone */
  scene('phoneout', 1.0, function (t0) {
    at(t0, function () {
      tween(pill, [{ opacity: 1 }, { opacity: 0 }], 280);
      quadPanes.forEach(function (p) {
        tween(p.querySelector('.phvar'), [{ opacity: 0, transform: 'translateY(10px)' },
          { opacity: 1, transform: 'translateY(0px)' }], 350);
      });
    });
  });

  /* intro 3 — cafe panel FLIP-expands, others shrink/fade */
  scene('expand', 0.9, function (t0) {
    at(t0, function () {
      var cafe = quadPanes[3];
      cafe.style.zIndex = '5';
      tween(cafe, [
        { left: RI.PX[1] + 'px', top: RI.PY[1] + 'px', width: RI.PW + 'px', height: RI.PH + 'px' },
        { left: '40px', top: '40px', width: (LAY.W - 80) + 'px', height: (LAY.H - 80) + 'px' }
      ], 800);
      [0, 1, 2].forEach(function (i) {
        tween(quadPanes[i], [{ opacity: 1, transform: 'scale(1)' },
          { opacity: 0, transform: 'scale(.7)' }], 500);
      });
    });
  });

  /* intro 4 — match cut: mini phone FLIPs into the real phone frame */
  scene('matchcut', 1.2, function (t0) {
    at(t0, function () {
      tween(blur, [{ opacity: 0 }, { opacity: 1 }], 450);
      tween(mphone, [{ opacity: 0 }, { opacity: 1 }], 200);
    });
    at(t0 + 0.5, function () {
      tween(hands, [{ opacity: 0 }, { opacity: 1 }], 380);
    });
    at(t0 + 0.25, function () {
      var scr = [LAY.povAbs[0] + 14 * LAY.povS, LAY.povAbs[1] + 14 * LAY.povS,
                 393 * LAY.povS, 854 * LAY.povS];
      tween(mphone, [
        { left: LAY.mphone[0] + 'px', top: LAY.mphone[1] + 'px', width: LAY.mphone[2] + 'px',
          height: LAY.mphone[3] + 'px', borderRadius: '10px', opacity: 1 },
        { left: scr[0] + 'px', top: scr[1] + 'px', width: scr[2] + 'px',
          height: scr[3] + 'px', borderRadius: '42px', opacity: 1 }
      ], 700);
      var msc = mphone.querySelector('.mpscr');
      tween(msc, [{ transform: 'scale(' + (LAY.mphone[2] / 393) + ',' + (LAY.mphone[3] / 854) + ')' },
        { transform: 'scale(1,1)' }], 700);
      tween(quadPanes[3], [{ opacity: 1 }, { opacity: 0 }], 500);
    });
    at(t0 + 0.95, function () {
      phoneWrap.style.opacity = '1';
      tween(mphone, [{ opacity: 1 }, { opacity: 0 }], 200);
      var ic = phoneWrap.querySelector('#raIcon');
      var ir = rectInWorld(ic);
      var rp = el('div', 'ripple', pRip);
      rp.style.left = (ir[0] + ir[2] / 2) + 'px'; rp.style.top = (ir[1] + ir[3] / 2) + 'px';
      rp.style.width = '56px'; rp.style.height = '56px'; rp.style.margin = '-28px 0 0 -28px';
      tween(rp, [{ opacity: 0.9, transform: 'scale(.3)' }, { opacity: 0, transform: 'scale(1.6)' }], 600)
        .then(function () { rp.remove(); });
    });
  });

  /* intro 5 — launch: icon zooms, brand, mark flies to the watermark */
  scene('launch', 1.5, function (t0) {
    at(t0, function () {
      pLaunch.classList.add('on');
      var lz = pLaunch.querySelector('.lzicon');
      tween(lz, [{ transform: 'scale(.55)', opacity: .5 }, { transform: 'scale(1)', opacity: 1 }], 450);
      tween(pLaunch.querySelector('.lname'), [{ opacity: 0 }, { opacity: 1 }], 350);
      tween(pLaunch.querySelector('.ltag'), [{ opacity: 0 }, { opacity: 1 }], 350);
      tween(hands, [{ opacity: 1, transform: 'translateY(0px)' },
        { opacity: 0, transform: 'translateY(120px)' }], 500);
      tween(blur, [{ opacity: 1 }, { opacity: 0 }], 600);
    });
    at(t0 + 0.7, function () {
      tween(pLaunch, [{ opacity: 1 }, { opacity: 0 }], 450);
    });
    at(t0 + 0.55, function () {
      brandfly.style.opacity = '1';
      /* fly the splash's icon+wordmark lockup: start exactly on it, arc up-left,
         shrink, land on the top-left watermark (brandmark fades in on arrival) */
      var ri = rectInWorld(pLaunch.querySelector('.lzicon'));
      var rn = rectInWorld(pLaunch.querySelector('.lname'));
      var sL = Math.min(ri[0], rn[0]), sR = Math.max(ri[0] + ri[2], rn[0] + rn[2]);
      var sT = Math.min(ri[1], rn[1]), sB = Math.max(ri[1] + ri[3], rn[1] + rn[3]);
      var scx = (sL + sR) / 2, scy = (sT + sB) / 2;
      var bm = rectInWorld(brandmark);
      var dcx = bm[0] + bm[2] / 2, dcy = bm[1] + bm[3] / 2;
      var W = 210, H = 200, k = 0.2;
      var mx = (scx + dcx) / 2 - 160, my = (scy + dcy) / 2 - 140;
      function bp(f) {
        var u = 1 - f;
        return [u * u * scx + 2 * u * f * mx + f * f * dcx,
                u * u * scy + 2 * u * f * my + f * f * dcy];
      }
      var kf = [0, .22, .5, .78, 1].map(function (f) {
        var p = bp(f), s = 1 + (k - 1) * f;
        return { left: (p[0] - W / 2) + 'px', top: (p[1] - H / 2) + 'px',
                 transform: 'scale(' + s + ')',
                 opacity: f > .82 ? Math.max(0, 1 - (f - .82) / .18) : 1,
                 offset: f };
      });
      tween(brandfly, kf, 620).then(function () { brandfly.style.opacity = '0'; });
      tween(phoneWrap.querySelector('.hscr'), [{ opacity: 1 }, { opacity: 0 }], 350);
    });
    at(t0 + 1.2, function () {
      tween(brandmark, [{ opacity: 0 }, { opacity: 1 }], 400);
      tween(pLaunch, [{ opacity: 1 }, { opacity: 0 }], 350);
      tween(pApp, [{ opacity: 0 }, { opacity: 1 }], 300);
      tween(introL, [{ opacity: 1 }, { opacity: 0 }], 300)
        .then(function () { introL.remove(); });
    });
  });

  /* seed the session the overview card mirrors (same AG the desktop panel shows) */
  scene('seed', 0.01, function (t0) {
    at(t0, function () {
      agPush({ type: 'user', text: S.prompt });
      agPush({ type: 'ai', text: S.ai_prev });
      agPush({ type: 'read', f: 'src/auth/token.ts', state: 'done' });
      agPush({ type: 'edit', f: 'src/auth/refresh.ts', add: 64, del: 21, state: 'done' });
      agPush({ type: 'ai', text: S.ai_mid });
      AG.testId = agPush({ type: 'test', cmd: 'npm test', count: 0, total: 132, state: 'run' });
      termPush('<span class="tp">$</span> npm test');
      termPush('Test Suites: running…');
      agProg(3, 7);
    });
  });

  /* ================= shot 1 — home loading ================= */
  scene('shot1', 2.5, function (t0) {
    at(t0, function () { caption('cap_s1'); agScreen('home'); agHome({ loading: 1, pct: 8 }); setTime('12:02'); });
    for (var i = 1; i <= 6; i++) {
      (function (n) { at(t0 + 0.3 + n * 0.25, function () { agHome({ pct: 8 + Math.round(82 * n / 6) }); }); })(i);
    }
  });

  /* ================= shot 2 — tiles fill in ================= */
  scene('shot2', 2.2, function (t0) {
    at(t0, function () { caption('cap_s2'); agHome({ loading: 0, pct: 100 }); });
    at(t0 + 1.2, function () { pTap('.ov-cursor'); });
  });

  /* ================= shot 3 — card expands + typing ================= */
  var DRAFT = S.draft, dN = DRAFT.length;
  scene('shot3', 4.6, function (t0) {
    at(t0, function () { caption('cap_s3'); agHome({ expanded: 1 }); });
    at(t0 + 0.4, function () { agFocus(true); });
    for (var i = 1; i <= dN; i++) {
      (function (n) { at(t0 + 1.0 + n * 0.09, function () { agDraft(DRAFT.slice(0, n)); }); })(i);
    }
  });

  /* ================= shot 4 — tap open ================= */
  scene('shot4', 1.5, function (t0) {
    at(t0, function () { caption('cap_s4'); agFocus(false); });
    at(t0 + 0.4, function () { pTap('.ov-open').then(function () { agHome({ opening: 1 }); }); });
  });

  /* ================= shot 5 — chat pushes in, send ================= */
  scene('shot5', 2.5, function (t0) {
    at(t0, function () { caption('cap_s5'); agScreen('chat'); agHome({ opening: 0 }); });
    at(t0 + 1.4, function () {
      pTap('#send').then(function () {
        agPush({ type: 'user', text: DRAFT });
        agDraft('');
        AG.home.sent = 1;
      });
    });
  });

  /* ================= shot 6 — back home + computer arrives ================= */
  scene('shot6', 4.0, function (t0) {
    at(t0, function () { caption('cap_s6'); agScreen('home'); });
    at(t0 + 0.3, function () {
      monWrap.style.opacity = '1';
      tween(monWrap, [{ transform: LAY.monEnter }, { transform: LAY.monSplit }], 850);
      tween(phoneWrap, [{ transform: LAY.phonePov }, { transform: LAY.phoneSplit }], 800);
    });
    at(t0 + 1.2, function () {
      relay.classList.remove('hidden');
      if (LAY.relay.vert) tween(relay, [{ height: '0px' }, { height: LAY.relay.h + 'px' }], 650);
      else tween(relay, [{ width: '0px' }, { width: LAY.relay.w + 'px' }], 650);
      relayLbl.classList.remove('hidden');
      tween(relayLbl, [{ opacity: 0 }, { opacity: 1 }], 400);
      pulseBeam();
    });
  });

  /* ================= shot 7 — new steps, mirrored ================= */
  scene('shot7', 3.5, function (t0) {
    at(t0, function () { caption('cap_s7'); });
    at(t0 + 0.3, function () {
      agRemove(AG.testId);
      agPush({ type: 'edit', f: 'README.md', state: 'done' });
      pulseBeam();
    });
    at(t0 + 1.4, function () {
      AG.testId = agPush({ type: 'test', cmd: 'npm test', count: 97, total: 132, state: 'run' });
      termPush('Tests: 97 of 132 passed');
      pulseBeam();
    });
    at(t0 + 2.1, function () { agProg(4, 7); });
    at(t0 + 3.1, function () { agScreen('chat'); });
  });

  /* ================= scene 6 — ask ================= */
  scene('ask', 7.5, function (t0) {
    at(t0, function () { caption('cap_ask'); setTime('12:28'); agScreen('chat'); });
    at(t0 + 0.2, function () {
      agStatus('wait');
      agQuestion({ q: S.q, opts: S.opts });
      pulseBeam();
    });
    at(t0 + 0.8, function () { agLock(true); });
    at(t0 + 1.3, function () {
      agNotif(S.notif_wait_t, S.q);
      fx(pApp, 'shake', {}, 0);
    });
    at(t0 + 2.2, function () { fx(pApp, 'shake', {}, 0); });
    at(t0 + 2.8, function () {
      pTap('#notif').then(function () { agLock(false); });
    });
    at(t0 + 3.5, function () { focusPhone(true); });
    at(t0 + 4.2, function () {
      pTap('.qnOpts .qnOpt:nth-child(2)').then(function () { agSel(1); });
    });
    at(t0 + 4.9, function () {
      pTap('.qnAct .primary').then(function () {
        agAnswer(1);
        agStatus('run');
      });
    });
    at(t0 + 5.6, function () { focusPhone(false); });
    at(t0 + 6.2, function () {
      var id = agPush({ type: 'edit', f: S.t_compat, add: 58, del: 4, state: 'run' });
      pulseBeam();
      wait(0.6).then(function () { agUpdate(id, { state: 'done' }); });
    });
  });

  /* ================= scene 7 — voice ================= */
  var words = S.voice_text.split(LANG === 'en' ? ' ' : '');
  scene('voice', 6.0, function (t0) {
    at(t0, function () { caption('cap_voice'); });
    at(t0 + 0.3, function () { pTap('#text'); });
    at(t0 + 0.7, function () {
      agFocus(true);
      showCallout();
    });
    at(t0 + 1.2, function () {
      fx(pApp, 'hold', { sel: '#mic' }, 2400);
      agVoice(true);
    });
    for (var i = 1; i <= words.length; i++) {
      (function (n) {
        at(t0 + 1.5 + n * 0.17, function () {
          agDraftLate(LANG === 'en' ? words.slice(0, n).join(' ') : words.slice(0, n).join(''));
        });
      })(i);
    }
    var typeEnd = t0 + 1.5 + words.length * 0.17;
    at(typeEnd + 0.4, function () { agVoice(false); });
    at(typeEnd + 0.8, function () {
      pTap('#send').then(function () {
        hideCallout();
        agPush({ type: 'user', text: S.voice_text });
        agDraft('');
        agFocus(false);
        renderDDraft();
        pulseBeam();
      });
    });
    at(typeEnd + 1.6, function () {
      var id = agPush({ type: 'edit', f: S.t_readme, add: 24, del: 6, state: 'run' });
      pulseBeam();
      wait(0.6).then(function () { agUpdate(id, { state: 'done' }); });
    });
  });

  /* ================= scene 7b — theme ================= */
  scene('theme', 2.7, function (t0) {
    at(t0, function () { caption('cap_theme'); });
    at(t0 + 0.15, function () { pTap('#menuBtn'); });
    at(t0 + 0.45, function () { agMenu(); });
    at(t0 + 0.85, function () {
      var tap = pTapReport('#menuThemeRow');
      (tap || Promise.resolve(null)).then(function (pt) {
        var vp = pt ? iframeToViewport(pApp, pt) : [innerWidth * 0.8, innerHeight * 0.7];
        switchTheme('dark', vp[0], vp[1]);
      });
    });
    at(t0 + 2.25, function () {
      var tap = pTapReport('#menuThemeRow');
      (tap || Promise.resolve(null)).then(function (pt) {
        var vp = pt ? iframeToViewport(pApp, pt) : [innerWidth * 0.8, innerHeight * 0.7];
        switchTheme('light', vp[0], vp[1]);
      });
    });
    at(t0 + 2.55, function () { agSheetOff(); });
  });

  /* ================= scene 8 — more ================= */
  scene('more', 6.5, function (t0) {
    at(t0, function () {
      caption('cap_more');
      tween(monWrap, [{ opacity: 1 }, { opacity: 0 }], 500);
      tween(relay, [{ opacity: 1 }, { opacity: 0 }], 400);
      tween(relayLbl, [{ opacity: 1 }, { opacity: 0 }], 300);
    });
    at(t0 + 0.4, function () {
      tween(phoneWrap, [{ transform: LAY.phoneSolo }, { transform: LAY.more.main }], 700);
    });
    var MO = LAY.more, SL = MO.slide;
    at(t0 + 0.7, function () {
      sPhoneT.classList.remove('hidden');
      sPhoneT.style.left = MO.t.x + 'px'; sPhoneT.style.top = MO.t.y + 'px';
      tween(sPhoneT, [{ transform: 'translate(' + (-SL) + 'px,0px) rotate(' + (MO.t.r - 2) + 'deg) scale(' + MO.t.s + ')', opacity: 0 },
        { transform: 'translate(0px,0px) rotate(' + MO.t.r + 'deg) scale(' + MO.t.s + ')', opacity: 1 }], 700);
      sPhoneF.classList.remove('hidden');
      sPhoneF.style.left = MO.f.x + 'px'; sPhoneF.style.top = MO.f.y + 'px';
      tween(sPhoneF, [{ transform: 'translate(' + SL + 'px,0px) rotate(' + (MO.f.r + 2) + 'deg) scale(' + MO.f.s + ')', opacity: 0 },
        { transform: 'translate(0px,0px) rotate(' + MO.f.r + 'deg) scale(' + MO.f.s + ')', opacity: 1 }], 700);
    });
    at(t0 + 1.6, function () {
      lblTerm.classList.remove('hidden'); lblAgents.classList.remove('hidden'); lblFile.classList.remove('hidden');
      lblTerm.style.left = MO.lbl.term[0] + 'px'; lblTerm.style.top = MO.lbl.term[1] + 'px';
      lblAgents.style.left = MO.lbl.agents[0] + 'px'; lblAgents.style.top = MO.lbl.agents[1] + 'px';
      lblFile.style.left = MO.lbl.file[0] + 'px'; lblFile.style.top = MO.lbl.file[1] + 'px';
      [lblTerm, lblAgents, lblFile].forEach(function (l) {
        tween(l, [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'translateY(0px)' }], 400);
      });
    });
    at(t0 + 2.2, function () { pTap('#title'); });
    at(t0 + 2.6, function () { agSheet(); });
    for (var ci = 1; ci <= S.term_cmd.length; ci++) {
      (function (n) {
        at(t0 + 1.0 + n * 0.07, function () { termState(S.term_cmd.slice(0, n), []); });
      })(ci);
    }
    for (var li = 0; li < S.term_lines.length; li++) {
      (function (n) {
        at(t0 + 2.4 + n * 0.22, function () { termState(S.term_cmd, S.term_lines.slice(0, n + 1)); });
      })(li);
    }
    at(t0 + 5.3, function () {
      agSheetOff();
      tween(sPhoneT, [{ opacity: 1, transform: 'translate(0px,0px) rotate(' + MO.t.r + 'deg) scale(' + MO.t.s + ')' },
        { opacity: 0, transform: 'translate(' + (-SL) + 'px,0px) rotate(' + (MO.t.r - 2) + 'deg) scale(' + MO.t.s + ')' }], 500)
        .then(function () { sPhoneT.classList.add('hidden'); });
      tween(sPhoneF, [{ opacity: 1, transform: 'translate(0px,0px) rotate(' + MO.f.r + 'deg) scale(' + MO.f.s + ')' },
        { opacity: 0, transform: 'translate(' + SL + 'px,0px) rotate(' + (MO.f.r + 2) + 'deg) scale(' + MO.f.s + ')' }], 500)
        .then(function () { sPhoneF.classList.add('hidden'); });
      [lblTerm, lblAgents, lblFile].forEach(function (l) {
        tween(l, [{ opacity: 1 }, { opacity: 0 }], 300).then(function () { l.classList.add('hidden'); });
      });
    });
    at(t0 + 5.7, function () {
      tween(phoneWrap, [{ transform: LAY.more.main }, { transform: LAY.phoneSolo }], 600);
      tween(monWrap, [{ opacity: 0 }, { opacity: 1 }], 600);
      tween(relay, [{ opacity: 0 }, { opacity: 1 }], 500);
      tween(relayLbl, [{ opacity: 0 }, { opacity: 1 }], 500);
    });
  });

  /* ================= scene 9 — done ================= */
  scene('done', 4.5, function (t0) {
    at(t0, function () { caption('cap_done'); setTime('12:41'); });
    for (var n = 1; n <= 8; n++) {
      (function (k) { at(t0 + k * 0.12, function () { agUpdate(AG.testId, { count: 97 + Math.round(35 * k / 8) }); }); })(n);
    }
    at(t0 + 1.2, function () {
      agUpdate(AG.testId, { state: 'done' });
      agPush({ type: 'final', text: S.final });
      agStatus('done');
      pulseBeam();
    });
    at(t0 + 1.9, function () { agLock(true); });
    at(t0 + 2.3, function () {
      agNotif(S.notif_done_t, S.final);
      fx(pApp, 'shake', {}, 0);
    });
    at(t0 + 3.2, function () {
      pTap('#notif').then(function () { agLock(false); });
    });
  });

  /* ================= scene 10 — outro ================= */
  var outro = el('div', 'outro', stage);
  outro.innerHTML = '<img class="o-icon" src="assets/ra-icon.svg"><div class="o-title">Remote Agent</div>' +
    '<div class="o-motto">' + Array.from(S.motto).map(function (w) { return '<span class="tok">' + w + '</span>'; }).join('') + '</div>' +
    '<div class="o-cards">' + [1, 2, 3].map(function (i) {
      return '<div class="ocard"><div class="ocbar" style="width:0%"></div><div class="ot">' + S['card' + i + '_t'] +
        '</div><div class="os">' + S['card' + i + '_s'] + '</div></div>';
    }).join('') + '</div>' +
    '<div class="cta">github.com/xrdiao/remote-agent</div><div class="o-meta">' + S.cta_meta + '</div>';
  var oIcon = outro.querySelector('.o-icon'), oTitle = outro.querySelector('.o-title'),
      oCards = outro.querySelectorAll('.ocard'),
      oBars = outro.querySelectorAll('.ocbar'), oCta = outro.querySelector('.cta'), oMeta = outro.querySelector('.o-meta');
  var mottoToks = S.motto.split(LANG === 'en' ? ' ' : '').filter(function (w) { return w.length; });
  var oMotto = outro.querySelector('.o-motto');
  oMotto.innerHTML = (LANG === 'en'
    ? mottoToks.map(function (w) { return '<span class="tok">' + w + ' </span>'; })
    : Array.from(S.motto).map(function (w) { return '<span class="tok">' + w + '</span>'; })).join('');
  var oToks = outro.querySelectorAll('.tok');

  scene('outro', 7.0, function (t0) {
    at(t0, function () {
      captionOff();
      tween(world, [{ opacity: 1 }, { opacity: 0 }], 500);
      tween(outro, [{ opacity: 0 }, { opacity: 1 }], 600);
      tween(brandmark, [{ opacity: 1 }, { opacity: 0 }], 300);
    });
    at(t0 + 0.2, function () { pop(oIcon, 520); });
    at(t0 + 0.5, function () { tween(oTitle, [{ opacity: 0, transform: 'translateY(28px)' }, { opacity: 1, transform: 'translateY(0px)' }], 500); });
    for (var i = 0; i < oToks.length; i++) {
      (function (n) {
        at(t0 + 0.9 + n * 0.05, function () {
          tween(oToks[n], [{ opacity: 0, transform: 'translateY(30px)' }, { opacity: 1, transform: 'translateY(0px)' }], 380);
        });
      })(i);
    }
    [0, 1, 2].forEach(function (i) {
      at(t0 + 2.2 + i * 0.35, function () {
        pop(oCards[i], 420);
        tween(oBars[i], [{ width: '0%' }, { width: '100%' }], 700);
      });
    });
    at(t0 + 3.6, function () {
      pop(oCta, 450).then(function () { oCta.classList.add('shine'); });
    });
    at(t0 + 4.2, function () { tween(oMeta, [{ opacity: 0 }, { opacity: 1 }], 480); });
  });
  END_T = T;

  /* ---------------- boot / seek ---------------- */
  cues.sort(function (a, b) { return a.t - b.t; });
  function start() {
    clockStarted = true; lastNow = performance.now();
    if (VT) setTimeout(vtTick, 16); else requestAnimationFrame(tick);
  }
  function boot() {
    var waited = 0;
    (function waitReady() {
      if (readyCount >= frames.length || waited > 3000) return go();
      waited += 50;
      setTimeout(waitReady, 50);
    })();
    function go() {
      syncPhone(true);
      if (!isNaN(SEEK)) {
        FF = true;
        (async function () {
          var qi = 0;
          while (true) {
            var nextCue = null;
            while (qi < cues.length && cues[qi].done) qi++;
            if (qi < cues.length && cues[qi].t <= SEEK) nextCue = cues[qi];
            var best = null;
            for (var i = vsleep.length - 1; i >= 0; i--) {
              var s = vsleep[i];
              if (s.t <= SEEK && (!best || s.t < best.t)) best = s;
            }
            if (!nextCue && !best) break;
            if (nextCue && (!best || nextCue.t <= best.t)) {
              vNow = Math.max(vNow, nextCue.t);
              nextCue.done = true; qi++;
              try { nextCue.fn(); } catch (e) { fail(e); }
            } else {
              vNow = Math.max(vNow, best.t);
              vsleep.splice(vsleep.indexOf(best), 1);
              best.r();
            }
            for (var k = 0; k < 20; k++) await Promise.resolve();
          }
          for (var m = 0; m < vsleep.length; m++) {
            (function (s) { sleepers.push({ t: SEEK + Math.max(0, s.t - vNow), r: s.r }); })(vsleep[m]);
          }
          vsleep.length = 0;
          elapsed = SEEK; FF = false;
          if (DEBUG) dumpDebug();
          if (!PAUSE) start();
        })();
      } else { if (DEBUG) wait(1).then(dumpDebug); start(); }
    }
  }
  function dumpDebug() {
    var out = {};
    ['world', 'monwrap', 'phonewrap', 'capbar'].forEach(function (id) {
      var e = document.getElementById(id);
      if (e) { var r = e.getBoundingClientRect(); out[id] = [r.left | 0, r.top | 0, r.width | 0, r.height | 0]; }
    });
    function rr(e) { if (!e) return null; var r = e.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; }
    function hit(a, b) { return a && b && a[0] < b[0] + b[2] && b[0] < a[0] + a[2] &&
      a[1] < b[1] + b[3] && b[1] < a[1] + a[3]; }
    function visOp(e) { return e ? parseFloat(getComputedStyle(e).opacity) : 0; }
    function rr2(e) { return visOp(e) > 0.05 ? rr(e) : null; }
    var pr = { phoneProbe: window.__probe || null, agHome: AG.home };
    pr.relayLblFit = relayLbl.scrollWidth <= relayLbl.clientWidth + 1;
    pr.vcallVsBrand = hit(rr2(vcall), rr2(brandmark));
    pr.brandOp = Math.round(parseFloat(getComputedStyle(brandmark).opacity) * 100) / 100;
    pr.mphoneScr = !!(mphone && mphone.querySelector('.mpscr'));
    var pairs = [];
    stage.querySelectorAll('.sphone').forEach(function (sp) {
      if (visOp(sp) < 0.05) return;
      stage.querySelectorAll('.slbl').forEach(function (lb) { pairs.push(hit(rr(sp), rr(lb))); });
    });
    pr.slblHitsPhone = pairs;
    out.probe = pr;
    var d = el('pre', '', stage); d.id = 'dbg';
    d.style.cssText = 'position:absolute;left:0;top:0;z-index:9999;color:#0f0;font-size:10px;';
    d.textContent = JSON.stringify(out) + ' title=' + document.title;
  }
  boot();
})();
