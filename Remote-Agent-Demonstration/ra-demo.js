/* Remote Agent promo demo — pure geometry (no screenshots). One session
   state object (AG) rendered simultaneously into the desktop agent panel
   and the phone chat, so both sides always match.
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

  document.body.dataset.lang = LANG;
  function fail(m) { document.title = 'ERR:' + m; }
  window.onerror = function (m) { fail(m); };
  window.addEventListener('unhandledrejection', function (e) { fail(e.reason); });

  var stage = document.getElementById('stage');
  var EASE = 'cubic-bezier(.22,.61,.36,1)';
  var SPRING = 'cubic-bezier(.34,1.56,.5,1)';
  var PHONE_RECT = [1250, 44, 430, 880];
  var MODELS = ['Model A', 'Model B', 'Model C', 'Model D'];
  var MODEL_COL = ['#1E88E5', '#7C5CF6', '#1A9F5A', '#C98A12'];
  var CODE_LINES = [
    '<span class="kw">import</span> { Session } <span class="kw">from</span> <span class="str">\'./session\'</span>',
    '<span class="kw">import</span> { legacy } <span class="kw">from</span> <span class="str">\'../api/legacy\'</span>',
    '',
    '<span class="kw">export function</span> <span class="fn">compat</span>(s: Session) {',
    '  <span class="kw">return</span> legacy.wrap(s, { <span class="str">\'v1\'</span> });',
    '}'
  ];

  /* ---------------- stage scaling ---------------- */
  function fit() {
    var s = Math.min(innerWidth / 1920, innerHeight / 1080);
    stage.style.transform = 'translate(' + ((innerWidth - 1920 * s) / 2) + 'px,' +
      ((innerHeight - 1080 * s) / 2) + 'px) scale(' + s + ')';
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
  function tick(now) {
    if (!clockStarted) return;
    var dt = (now - lastNow) / 1000; lastNow = now;
    if (document.hidden) { requestAnimationFrame(tick); return; }
    elapsed += dt * SPEED;
    for (var i = sleepers.length - 1; i >= 0; i--) if (sleepers[i].t <= elapsed) { var s = sleepers.splice(i, 1)[0]; s.r(); }
    for (var j = 0; j < cues.length; j++) if (!cues[j].done && cues[j].t <= elapsed) { cues[j].done = true; cues[j].fn(); }
    if (LOOP && elapsed > END_T + 4) { location.reload(); return; }
    requestAnimationFrame(tick);
  }

  /* ---------------- animation helpers ---------------- */
  function applyKf(elm, kf) {
    var last = kf[kf.length - 1];
    Object.keys(last).forEach(function (k) {
      if (k === 'offset' || k === 'easing') return;
      try { elm.style[k] = last[k]; } catch (e) {}
    });
  }
  /* interpolate a keyframe list at fraction f (for mid-tween seeks) */
  function lerpStr(a, b, f) {
    var ra = String(a).match(/-?\d+\.?\d*/g), rb = String(b).match(/-?\d+\.?\d*/g);
    if (!ra || !rb || ra.length !== rb.length) return f < .5 ? a : b;
    var i = 0;
    return String(b).replace(/-?\d+\.?\d*/g, function () {
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
  /* while seeking, jump to the end state (or the interpolated mid-state when
     the seek point cuts through the tween) but still spend the duration on
     the virtual clock, so ?t= lands where real playback would be */
  function tween(elm, kf, ms, easing) {
    if (FF) {
      var f = (SEEK - vNow) / (ms / 1000);
      if (f >= 1) applyKf(elm, kf); else applyKfAt(elm, kf, Math.max(0, f));
      return wait(ms / 1000);
    }
    var a = elm.animate(kf, { duration: ms / SPEED, easing: easing || EASE, fill: 'forwards' });
    return a.finished.catch(function () {});
  }
  function show(elm, ms) { elm.classList.remove('hidden'); return tween(elm, [{ opacity: 0 }, { opacity: 1 }], ms || 400); }
  function hide(elm, ms) {
    return tween(elm, [{ opacity: 1 }, { opacity: 0 }], ms || 400).then(function () {
      elm.classList.add('hidden');
    });
  }
  function pop(elm, ms) {
    elm.classList.remove('hidden');
    return tween(elm, [{ opacity: 0, transform: 'scale(.5)' }, { opacity: 1, transform: 'scale(1)' }], ms || 450, SPRING);
  }

  /* ---------------- caption + pain->solution kicker ---------------- */
  var capbar = el('div', '', stage); capbar.id = 'capbar';
  var kicker = el('div', 'kicker', capbar);
  var capIn = el('span', 'cap-inner', capbar);
  var capVisible = false;
  function kickerHtml(pain, sol) {
    return (pain ? '<span class="pain">✕ ' + pain + '</span><span class="arr"> → </span>' : '') +
      (sol ? '<span class="sol">✓ ' + sol + '</span>' : '');
  }
  function caption(key, pain, sol) {
    var txt = S[key]; if (!txt) return Promise.resolve();
    var kh = pain === undefined && sol === undefined ? null : kickerHtml(pain, sol);
    function apply() { capIn.textContent = txt; if (kh !== null) kicker.innerHTML = kh; }
    if (!capVisible) {
      capVisible = true; apply();
      return tween(capbar, [{ opacity: 0, transform: 'translateY(24px)' }, { opacity: 1, transform: 'translateY(0px)' }], 500);
    }
    var parts = kh !== null && kh !== kicker.innerHTML ? [capIn, kicker] : [capIn];
    return Promise.all(parts.map(function (p) { return tween(p, [{ opacity: 1 }, { opacity: 0 }], 150); }))
      .then(function () {
        apply();
        return Promise.all(parts.map(function (p) { return tween(p, [{ opacity: 0 }, { opacity: 1 }], 220); }));
      });
  }
  function captionOff() {
    if (!capVisible) return Promise.resolve();
    capVisible = false;
    return tween(capbar, [{ opacity: 1 }, { opacity: 0 }], 350);
  }

  /* ---------------- backdrop + black fade ---------------- */
  var backdrop = el('div', 'backdrop', stage);
  [[90, 70, 340, 230], [1480, 40, 380, 250], [40, 690, 300, 210], [1560, 720, 320, 230], [700, 900, 260, 160], [1260, 300, 200, 130]]
    .forEach(function (r, i) {
      var f = el('div', 'bgframe', backdrop); place(f, r);
      f.animate([{ transform: 'translate(0px,0px)' },
        { transform: 'translate(' + (i % 2 ? -18 : 22) + 'px,' + (i % 3 ? 14 : -16) + 'px)' }],
        { duration: 7000 + i * 900, direction: 'alternate', iterations: Infinity, easing: 'ease-in-out' });
    });
  var black = el('div', '', stage); black.style.cssText = 'position:absolute;inset:0;background:#FFFFFF;z-index:9500;';
  at(0.05, function () {
    tween(black, [{ opacity: 1 }, { opacity: 0 }], 350).then(function () { black.remove(); });
  });

  /* ---------------- world camera ---------------- */
  var world = el('div', '', stage); world.id = 'world';
  var wcam = { tx: 0, ty: 0, s: 1 };
  function wcamCss(c) { return 'translate(' + c.tx + 'px,' + c.ty + 'px) scale(' + c.s + ')'; }
  function worldTo(c, ms) {
    var from = wcamCss(wcam), to = wcamCss(c);
    wcam = c;
    return tween(world, [{ transform: from }, { transform: to }], ms || 550);
  }
  function worldZoom(rect, s, ms) {
    var cx = rect[0] + rect[2] / 2, cy = rect[1] + rect[3] / 2;
    var tx = Math.min(0, Math.max(1920 * (1 - s), 960 - cx * s));
    var ty = Math.min(0, Math.max(1080 * (1 - s), 540 - cy * s));
    return worldTo({ tx: tx, ty: ty, s: s }, ms);
  }
  function worldZoomOut(ms) { return worldTo({ tx: 0, ty: 0, s: 1 }, ms || 450); }
  /* element rect -> world-space coords (undoes stage fit + world cam) */
  function rectInWorld(e) {
    var r = e.getBoundingClientRect(), sr = stage.getBoundingClientRect();
    var k = sr.width / 1920;
    var x = (r.left - sr.left) / k, y = (r.top - sr.top) / k;
    x = (x - wcam.tx) / wcam.s; y = (y - wcam.ty) / wcam.s;
    return [x, y, r.width / k / wcam.s, r.height / k / wcam.s];
  }

  /* ---------------- time chip ---------------- */
  var timechip = el('div', '', stage); timechip.id = 'timechip';
  timechip.innerHTML = '<span class="tick"></span><span class="tv">12:02</span>';
  var pclock = null; // phone status-bar clock, filled at build
  function setTime(txt, ms) {
    timechip.querySelector('.tv').textContent = txt;
    if (pclock) pclock.textContent = txt;
    if (!FF) tween(timechip, [{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }], ms || 300);
  }

  /* ================= THE AGENT SESSION (single state, two renderers) ================= */
  var AG = { msgs: [], byId: {}, mid: 0, status: 'run', q: null, view: null, vdata: {}, testId: null };

  /* ---------- desktop: back windows, IDE, taskbar, QR overlay (monitor at world origin) ---------- */
  var monWrap = el('div', '', world); monWrap.id = 'monwrap';
  monWrap.style.transform = 'translate(200px,70px) scale(1)';
  el('div', 'monframe', monWrap); el('div', 'monstand', monWrap); el('div', 'monbase', monWrap);
  var scr = el('div', 'scr', monWrap);

  function winHtml(body) { return '<div class="wtb"></div><div class="wc">' + body + '</div>'; }
  var bwins = [];
  var wBrowser = el('div', 'bwin', scr); place(wBrowser, [16, 40, 296, 300]);
  wBrowser.innerHTML = winHtml('<div class="wurl"></div><div class="whero"></div>' +
    '<div class="wl" style="left:14px;top:170px;width:250px"></div><div class="wl" style="left:14px;top:192px;width:210px"></div>' +
    '<div class="wl" style="left:14px;top:214px;width:236px"></div><div class="wl" style="left:14px;top:236px;width:150px"></div>') +
    '<span class="ntag">' + S.unneeded + '</span>';
  var wFolder = el('div', 'bwin', scr); place(wFolder, [120, 300, 260, 240]);
  wFolder.innerHTML = winHtml(
    '<i class="wfi" style="left:16px;top:20px;background:#DCEBFA"></i><i class="wfi" style="left:96px;top:20px;background:#E9E2FA"></i>' +
    '<i class="wfi" style="left:176px;top:20px;background:#DDF3E8"></i><i class="wfi" style="left:16px;top:110px;background:#FBE9CF"></i>' +
    '<i class="wfi" style="left:96px;top:110px;background:#DCEBFA"></i><i class="wfi" style="left:176px;top:110px;background:#E9E2FA"></i>' +
    '<div class="wl" style="left:16px;top:172px;width:200px"></div><div class="wl" style="left:16px;top:192px;width:150px"></div>') +
    '<span class="ntag">' + S.unneeded + '</span>';
  var wPhoto = el('div', 'bwin', scr); place(wPhoto, [16, 470, 300, 220]);
  wPhoto.innerHTML = winHtml('<div class="wpic"></div>') + '<span class="ntag">' + S.unneeded + '</span>';
  bwins = [wBrowser, wFolder, wPhoto];

  var ide = el('div', 'ide', scr); place(ide, [330, 40, 950, 656]);
  ide.innerHTML = '<div class="itb"><i></i><i></i><i></i><span>Cursor — auth-migration</span></div>';
  var tree = el('div', 'tree', ide);
  [[16, 20, 96], [30, 42, 110], [30, 62, 84], [16, 84, 120], [30, 104, 100], [16, 126, 112], [30, 146, 88], [16, 168, 118],
   [30, 188, 104], [16, 210, 96], [30, 230, 120], [16, 252, 80], [30, 272, 110]].forEach(function (n, i) {
    var t = el('div', 'tnode', tree);
    t.style.left = n[0] + 'px'; t.style.top = n[1] + 'px'; t.style.width = n[2] + 'px';
    if (i === 4) t.style.background = 'rgba(30,136,229,.28)';
  });
  var editor = el('div', 'editor', ide);
  var PASTEL = ['#9EC5F5', '#C8B6F0', '#A6DEC4', '#F5C99B', '#B7C4D6'];
  var INDENT = [0, 1, 1, 2, 2, 0, 1, 2, 3, 2, 1, 1, 0, 1, 2, 2, 1, 0];
  var clines = [];
  INDENT.forEach(function (ind, i) {
    var ln = el('div', 'cline', editor);
    ln.style.marginLeft = (ind * 18) + 'px';
    var segs = 2 + (i % 2);
    for (var k = 0; k < segs; k++) {
      var sg = el('i', 'cseg', ln);
      sg.style.width = (40 + ((i * 53 + k * 71) % 130)) + 'px';
      sg.style.background = PASTEL[(i + k) % PASTEL.length];
    }
    clines.push(ln);
  });
  var term = el('div', 'term', ide);
  var tCount = 0;
  function termLine() {
    var ln = el('div', 'tline', term);
    var n = 1 + (tCount % 3);
    for (var k = 0; k < n; k++) {
      var s = el('i', 'tseg', ln);
      s.style.width = (40 + ((tCount * 37 + k * 61) % 150)) + 'px';
      if ((tCount + k) % 4 === 0) s.style.background = '#3FA37A';
    }
    tCount++;
    if (term.children.length > 7) term.firstElementChild.remove();
  }
  function flashCode(i) {
    var a = clines[(i * 5) % clines.length], b = clines[(i * 5 + 9) % clines.length];
    [a, b].forEach(function (c) { c.classList.add('lit'); });
    wait(0.9).then(function () { [a, b].forEach(function (c) { c.classList.remove('lit'); }); });
  }

  var dPanel = el('div', 'apanel dpanel', scr);
  dPanel.innerHTML = '<div class="ahead"></div><div class="abody"></div>' + inputHtml();
  place(dPanel, [840, 76, 440, 620]);
  var dHead = dPanel.querySelector('.ahead'), dBody = dPanel.querySelector('.abody');
  var dBox = dPanel.querySelector('.abox'), dPh = dBox.querySelector('.ph'), dTxt = dBox.querySelector('.dt'),
      dCaret = dBox.querySelector('.caret');

  var taskbar = el('div', 'taskbar', scr);
  [['#9EC5F5', 28], ['#C8B6F0', 62], ['#A6DEC4', 96], ['#F5C99B', 130], ['#B7C4D6', 164]].forEach(function (t) {
    var b = el('i', 'tbi', taskbar, ''); b.style.background = t[0]; b.style.left = t[1] + 'px';
  });

  var qrWrap = el('div', 'qrwrap', scr);
  qrWrap.innerHTML = '<div class="qrbox"><div class="qrg">' + qrCells() + '</div></div>' +
    '<div class="qrok"><span class="pcheck">✓</span><span>' + S.paired + '</span></div>';
  var qrBox = qrWrap.querySelector('.qrbox'), qrOk = qrWrap.querySelector('.qrok');

  function inputHtml() {
    return '<div class="ainput"><div class="abox"><span class="ph">' + S.ph_input + '</span>' +
      '<span class="dt"></span><span class="caret"></span></div><div class="sendbtn">↑</div></div>';
  }

  /* ---------- phone ---------- */
  var phoneWrap = el('div', '', world); phoneWrap.id = 'phonewrap';
  phoneWrap.innerHTML = '<div class="pframe"></div><div class="pnotch"></div><div class="pscr">' +
    '<div class="pstatus"><span class="pc">12:02</span><span class="sic"><span class="sbar"></span>' +
    '<span class="sbar"></span><span class="sbar"></span><span class="batt"></span></span></div>' +
    '<div class="apanel pchat"><div class="ahead"></div><div class="abody"></div>' + inputHtml() + '</div>' +
    '<div class="pbanner"><span class="bdot"></span><span>' + S.a4_banner + '</span></div>' +
    '<div class="pkbd"></div>' +
    '<div class="lockview"><div class="lkt">12:41</div><div class="lkd"></div>' +
    '<div class="pnotif"><div class="nh">' + S.notif_t + '</div><div class="nb"><span class="ok">✓</span>' + S.notif_b + '</div></div></div>' +
    '<div class="blackoff"></div><div class="pflash"></div>' +
    '<div class="pinchlay"><i class="pinchd" style="left:180px"></i><i class="pinchd" style="left:220px"></i></div>' +
    '<div class="ripplelay"></div></div>';
  var pScr = phoneWrap.querySelector('.pscr');
  pclock = pScr.querySelector('.pc');
  var pChat = pScr.querySelector('.pchat');
  var pHead = pChat.querySelector('.ahead'), pBody = pChat.querySelector('.abody');
  var pBox = pChat.querySelector('.abox'), pPh = pBox.querySelector('.ph'), pTxt = pBox.querySelector('.dt'),
      pCaret = pBox.querySelector('.caret');
  var pBanner = pScr.querySelector('.pbanner'), pKbd = pScr.querySelector('.pkbd'), pLock = pScr.querySelector('.lockview'),
      pNotif = pLock.querySelector('.pnotif'), pBlack = pScr.querySelector('.blackoff'), pFlash = pScr.querySelector('.pflash'),
      pPinch = pScr.querySelector('.pinchlay'), pRip = pScr.querySelector('.ripplelay');
  var pdots = pPinch.querySelectorAll('.pinchd');
  var pView = el('div', 'aview pview hidden', pScr);
  var dView = el('div', 'aview dview hidden', dPanel);
  phoneWrap.style.transform = 'translate(340px,190px)';
  (function () {
    for (var r = 0; r < 4; r++) {
      var row = el('div', 'krow', pKbd);
      var n = r === 3 ? 1 : 10;
      for (var k = 0; k < n; k++) el('i', 'pkey' + (r === 3 ? ' wide' : ''), row);
    }
  })();
  var kbdKeys = pKbd.querySelectorAll('.pkey');
  var pSend = pChat.querySelector('.sendbtn');

  /* ---------- relay, chips, lens, comparison phone ---------- */
  var relay = el('div', 'relay', world);
  var relayLbl = el('div', 'relaylbl', world, S.relay);
  var chipPc = el('div', 'lochip', world, '<span class="ld" style="background:#7E8FAE"></span>' + S.chip_pc);
  chipPc.style.left = '460px'; chipPc.style.top = '676px';
  var chipPhone = el('div', 'lochip', world, '<span class="ld" style="background:var(--accent)"></span>' + S.chip_phone);
  chipPhone.style.left = '1360px'; chipPhone.style.top = '928px';
  var rdPhone = el('div', 'rdphone', world);
  (function () {
    var mini = '';
    for (var r = 0; r < 26; r++) {
      var y = 14 + r * 15;
      mini += '<i style="left:' + (10 + (r * 17) % 40) + 'px;top:' + y + 'px;width:' + (60 + (r * 29) % 140) + 'px"></i>';
      mini += '<i style="left:' + (150 + (r * 11) % 40) + 'px;top:' + y + 'px;width:' + (40 + (r * 23) % 60) + 'px"></i>';
    }
    rdPhone.innerHTML = '<div class="rdlabel">' + S.rd_label + '</div><div class="rdmini">' + mini + '</div>' +
      '<div class="rdmag"></div><div class="rdstrike"></div>';
  })();
  var lens = el('div', 'lens', world, '<span class="lt"></span><span class="caret"></span>');
  var lensTxt = lens.querySelector('.lt');
  var lensOn = false;

  function positionLens() {
    if (!lensOn) return;
    var r = rectInWorld(dBox);
    lens.style.left = Math.round(r[0] + r[2] / 2 - lens.offsetWidth / 2) + 'px';
    lens.style.top = Math.round(r[1] - lens.offsetHeight - 24) + 'px';
  }

  /* ---------- person + desk (world level, sitting then standing) ---------- */
  var desk = el('div', 'cdesk', world); desk.style.left = '110px'; desk.style.top = '870px'; desk.style.width = '1740px';
  var sitting = el('div', '', world);
  sitting.innerHTML =
    '<div class="chair-back" style="position:absolute;left:1838px;top:470px;width:36px;height:330px;border-radius:14px;background:#C9D3E0"></div>' +
    '<div class="chair-seat" style="position:absolute;left:1640px;top:760px;width:230px;height:40px;border-radius:14px;background:#C9D3E0"></div>' +
    '<div class="chair-post" style="position:absolute;left:1740px;top:800px;width:16px;height:150px;background:#C9D3E0"></div>' +
    '<div style="position:absolute;left:1680px;top:520px;width:130px;height:240px;border-radius:46px 46px 18px 18px;background:#7FB3E6"></div>' +
    '<div style="position:absolute;left:1684px;top:430px;width:92px;height:96px;border-radius:50%;background:#F2C7A0"></div>' +
    '<div style="position:absolute;left:1680px;top:418px;width:100px;height:46px;border-radius:50px 50px 10px 10px;background:#4A4F5C"></div>' +
    '<div style="position:absolute;left:1560px;top:620px;width:190px;height:42px;border-radius:21px;background:#7FB3E6"></div>' +
    '<div style="position:absolute;left:1600px;top:706px;width:150px;height:56px;border-radius:28px;background:#5B6B80"></div>' +
    '<div style="position:absolute;left:1600px;top:740px;width:56px;height:150px;border-radius:28px;background:#5B6B80"></div>';
  var deskPhone = el('div', 'desk-phone', world, '');
  deskPhone.style.cssText = 'position:absolute;left:1500px;top:812px;width:30px;height:58px;border-radius:8px;background:#1C2230;';
  var standing = el('div', '', world);
  standing.style.cssText = 'position:absolute;left:0;top:0;opacity:0;';
  standing.innerHTML =
    '<div style="position:absolute;left:1690px;top:430px;width:92px;height:96px;border-radius:50%;background:#F2C7A0"></div>' +
    '<div style="position:absolute;left:1690px;top:418px;width:100px;height:46px;border-radius:50px 50px 10px 10px;background:#4A4F5C"></div>' +
    '<div style="position:absolute;left:1690px;top:520px;width:130px;height:240px;border-radius:46px 46px 18px 18px;background:#7FB3E6"></div>' +
    '<div style="position:absolute;left:1700px;top:740px;width:56px;height:200px;border-radius:28px;background:#5B6B80"></div>' +
    '<div style="position:absolute;left:1760px;top:740px;width:56px;height:200px;border-radius:28px;background:#5B6B80"></div>' +
    '<div style="position:absolute;left:1812px;top:560px;width:40px;height:150px;border-radius:20px;background:#7FB3E6"></div>' +
    '<div style="position:absolute;left:1818px;top:620px;width:30px;height:56px;border-radius:8px;background:#1C2230"></div>';

  /* ---------- mutators (the only way session content changes) ---------- */
  function headHtml() {
    var lab = AG.status === 'wait' ? S.st_wait : AG.status === 'done' ? S.st_done : S.st_run;
    return '<span class="adot"></span><div class="hname"><span class="aname">' + S.agent_name + '</span>' +
      '<span class="asub">' + S.session + '</span></div>' +
      '<span class="stpill ' + AG.status + '"><span class="sd"></span>' + lab + '</span>';
  }
  function qHtml(m) {
    if (m.answer !== undefined && m.answer !== null && m.collapsed)
      return '<div class="ansrow"><span class="check">✓</span>' + S.a4_done + '</div>';
    var h = '<div class="qcard"><div class="qq">' + m.q + '</div>';
    m.opts.forEach(function (o, i) {
      h += '<div class="opt' + (m.answer === i ? ' sel' : '') + '"><span class="key">' +
        'ABC'[i] + '</span>' + o + '</div>';
    });
    return h + '</div>';
  }
  function msgHtml(m) {
    if (m.type === 'user') return '<div class="msg user"><div class="bub">' + m.text + '</div></div>';
    if (m.type === 'final') return '<div class="msg ai"><div class="bub final"><span class="check">✓</span> ' + m.text + '</div></div>';
    if (m.type === 'fileref') return '<div class="msg ai"><span class="fref">' + S.fileref + '</span></div>';
    if (m.type === 'qcard') return qHtml(m);
    if (m.type === 'test') {
      var pct = Math.round(100 * m.count / m.total);
      return '<div class="trow ' + m.state + '"><span class="st">' +
        (m.state === 'done' ? '<span class="check">✓</span>' : '<span class="spin"></span>') + '</span><b>' + m.name +
        '</b><span class="tprog"><i style="width:' + pct + '%"></i></span><span class="tcnt">' + m.count + '/' + m.total + '</span></div>';
    }
    return '<div class="trow ' + m.state + '"><span class="st">' +
      (m.state === 'done' ? '<span class="check">✓</span>' : '<span class="spin"></span>') + '</span><b>' + m.name +
      '</b><span class="args">' + m.args + '</span></div>';
  }
  function updateMsgDom(m) {
    [m.d, m.p].forEach(function (d) { if (d) d.innerHTML = msgHtml(m); });
  }
  function renderHeads() { [dHead, pHead].forEach(function (h) { h.innerHTML = headHtml(); }); }
  function agPush(msg) {
    msg.id = 'm' + (++AG.mid);
    AG.msgs.push(msg); AG.byId[msg.id] = msg;
    msg.d = el('div', '', dBody);
    msg.p = el('div', '', pBody);
    updateMsgDom(msg);
    if (!FF) {
      [msg.d, msg.p].forEach(function (d) {
        d.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0px)' }],
          { duration: 240, easing: EASE, fill: 'forwards' });
      });
    }
    return msg.id;
  }
  function agUpdate(id, patch) {
    var m = AG.byId[id]; if (!m) return;
    Object.keys(patch).forEach(function (k) { m[k] = patch[k]; });
    updateMsgDom(m);
  }
  function agDraft(text) {
    AG.draft = text;
    [[dPh, dTxt, dCaret], [pPh, pTxt, pCaret]].forEach(function (t) {
      t[0].style.display = text ? 'none' : '';
      t[1].style.display = text ? '' : 'none';
      t[1].textContent = text;
      t[2].style.display = text ? '' : 'none';
    });
    lensTxt.textContent = text;
    positionLens();
  }
  function agQuestion(q) {
    AG.q = q;
    return agPush({ type: 'qcard', q: q.q, opts: q.opts, answer: null, collapsed: false });
  }
  function agAnswer(i) {
    var m = AG.msgs[AG.msgs.length - 1];
    if (m && m.type === 'qcard') {
      m.answer = i; updateMsgDom(m);
      wait(.8).then(function () { m.collapsed = true; updateMsgDom(m); });
    }
  }
  function agStatus(s) {
    AG.status = s;
    renderHeads();
  }

  /* ---------- agent views (A7 / A8): same state, both renderers ---------- */
  function selTop(k, i) { return k === 'p' ? 110 + i * 82 : 70 + i * 64; }
  function rowH(k) { return k === 'p' ? 62 : 50; }
  function fTrans(z) { return 'translate(0px,' + (-115 * (z - 1)).toFixed(1) + 'px) scale(' + z + ')'; }
  function vTitle() {
    var d = AG.vdata;
    if (AG.view === 'models') return 'Cursor · ' + MODELS[d.sel || 0];
    if (AG.view === 'term') return S.vhead_term;
    if (AG.view === 'file') return S.fileref;
    if (AG.view === 'cam') return S.vhead_cam;
    return '';
  }
  function viewHtml(k) {
    var v = AG.view, d = AG.vdata;
    var head = '<div class="vhead"><span class="vback">‹</span><b class="vtitle">' + vTitle() + '</b></div>';
    if (v === 'models') {
      var rows = '';
      MODELS.forEach(function (n, i) {
        rows += '<div class="mrow" style="top:' + selTop(k, i) + 'px;height:' + rowH(k) + 'px">' +
          '<i class="mdot" style="background:' + MODEL_COL[i] + '"></i><b>' + n + '</b><span class="mbar"></span></div>';
      });
      return head + '<div class="mlist"><div class="selbox" style="top:' + (selTop(k, d.sel || 0) - 6) + 'px;height:' +
        (rowH(k) + 12) + 'px"></div>' + rows + '</div><div class="mcur">model: <b>' + MODELS[d.sel || 0] + '</b></div>';
    }
    if (v === 'term') {
      var lines = (d.lines || []).map(function (l) { return '<div class="tl">' + l + '</div>'; }).join('');
      return head + '<div class="vterm"><div class="tcmd"><span class="tp">$</span>' + (d.cmd || '') +
        '<span class="caret"></span></div>' + lines + '</div>';
    }
    if (v === 'file') {
      var code = '';
      CODE_LINES.forEach(function (c, i) {
        code += '<div class="cl' + (i === 3 ? ' hl' : '') + '"><span class="ln">' + (i + 1) + '</span><span>' + c + '</span></div>';
      });
      return head + '<div class="vfile"><div class="fbar">' + S.fileref + '</div><div class="vcode"><div class="fcode" style="transform:' +
        fTrans(d.zoom || 1) + '">' + code + '</div></div></div>';
    }
    if (v === 'cam') {
      if (k === 'd') return '';
      var body = d.paired
        ? '<div class="pairdone"><span class="pcheck">✓</span><span class="pt">' + S.paired + '</span></div>'
        : '<div class="vf"><div class="qrg vf-qr">' + qrCells() + '</div><i class="scanl"></i><div class="vf-hint">' + S.scan_hint + '</div></div>';
      return head + '<div class="camwrap">' + body + '</div>';
    }
    return '';
  }
  function renderViews() {
    [dView, pView].forEach(function (c, i) {
      var k = i ? 'p' : 'd';
      var hidden = !AG.view || (AG.view === 'cam' && k === 'd');
      c.classList.toggle('hidden', hidden);
      if (!hidden) c.innerHTML = viewHtml(k);
    });
  }
  function moveSel(from, to) {
    [dView, pView].forEach(function (c, i) {
      var k = i ? 'p' : 'd';
      var sb = c.querySelector('.selbox'), tt = c.querySelector('.vtitle');
      if (tt) tt.textContent = vTitle();
      if (sb) tween(sb, [{ top: (selTop(k, from) - 6) + 'px' }, { top: (selTop(k, to) - 6) + 'px' }], 520);
    });
  }
  function zoomFile(from, to) {
    [dView, pView].forEach(function (c) {
      var fc = c.querySelector('.fcode'); if (!fc) return;
      tween(fc, [{ transform: fTrans(from) }, { transform: fTrans(to) }], 1000);
    });
  }
  function agView(name, data) {
    var prev = AG.view, old = AG.vdata;
    AG.view = name; AG.vdata = data || {};
    if (name && name === prev && name === 'models') return moveSel(old.sel || 0, AG.vdata.sel || 0);
    if (name && name === prev && name === 'file') return zoomFile(old.zoom || 1, AG.vdata.zoom || 1);
    renderViews();
  }

  /* ---------- QR pattern (deterministic) ---------- */
  function qrOn(r, c) {
    var corner = (r < 7 && c < 7) || (r < 7 && c >= 18) || (r >= 18 && c < 7);
    if (corner) {
      var rr = r < 7 ? r : r - 18, cc = c < 7 ? c : c - 18;
      return rr === 0 || rr === 6 || cc === 0 || cc === 6 || (rr >= 2 && rr <= 4 && cc >= 2 && cc <= 4);
    }
    return ((r * 7 + c * 13 + r * c) % 5) < 2;
  }
  function qrCells() {
    var h = '';
    for (var r = 0; r < 25; r++) for (var c = 0; c < 25; c++) h += qrOn(r, c) ? '<i class="on"></i>' : '<i></i>';
    return h;
  }

  /* ---------- taps: finger ripple on the phone (pScr design coords) ---------- */
  function tapFx(x, y) {
    var rp = el('div', 'ripple', pRip);
    rp.style.left = (x - 22) + 'px'; rp.style.top = (y - 22) + 'px';
    return tween(rp, [{ opacity: 0.9, transform: 'scale(.3)' }, { opacity: 0, transform: 'scale(1.6)' }], 520).then(function () { rp.remove(); });
  }
  function pTap(elm) {
    var pr = pScr.getBoundingClientRect(), r = elm.getBoundingClientRect(), k = pr.width / 398;
    return tapFx((r.left + r.width / 2 - pr.left) / k, (r.top + r.height / 2 - pr.top) / k);
  }
  function flashConnector(id) {
    var m = AG.byId[id];
    if (!m || !m.d || !m.p) return;
    var a = rectInWorld(m.d), b = rectInWorld(m.p);
    var x0 = a[0] + a[2], x1 = b[0], y = a[1] + a[3] / 2;
    if (x1 <= x0) return;
    var c = el('div', 'conn', world);
    c.style.left = x0 + 'px'; c.style.top = (y - 1) + 'px'; c.style.width = (x1 - x0) + 'px';
    tween(c, [{ opacity: 0 }, { opacity: 1 }, { opacity: 0 }], 900).then(function () { c.remove(); });
  }
  renderHeads();

  var flight = null;

  /* ================= C0 — cold open: the agent waits, the chair is empty ================= */
  var cold = el('div', 'intro', stage); cold.style.zIndex = 150;
  var coldCam = el('div', 'cold-cam', cold);
  coldCam.innerHTML =
    '<div class="cmon"><div class="cscr"><div class="cbar"><i></i><i></i><i></i></div>' +
    '<div class="cpill"><span class="sd"></span>' + S.c0_status + '</div>' +
    '<div class="cq"><span class="cqm">?</span><span class="cqt">' + S.c0_q + '</span></div>' +
    '<div class="cbars"><i style="width:62%"></i><i style="width:80%"></i><i style="width:44%"></i></div>' +
    '<div class="ctimer">' + S.c0_wait.replace('{n}', 23) + '</div></div></div>' +
    '<div class="cmonstand"></div><div class="cdesk" style="left:220px;top:730px;width:1480px"></div>' +
    '<div class="chair-back" style="position:absolute;left:1420px;top:420px;width:36px;height:330px;border-radius:14px;background:#C9D3E0"></div>' +
    '<div class="chair-seat" style="position:absolute;left:1270px;top:640px;width:230px;height:40px;border-radius:14px;background:#C9D3E0"></div>' +
    '<div class="chair-post" style="position:absolute;left:1370px;top:680px;width:16px;height:150px;background:#C9D3E0"></div>';
  var coldTimer = coldCam.querySelector('.ctimer');
  var coldLine = el('div', 'coldline', coldCam, S.cold_line);

  scene('c0', 3.5, function (t0) {
    at(t0, function () { tween(cold, [{ opacity: 0 }, { opacity: 1 }], 500); });
    at(t0 + 0.3, function () { tween(coldCam, [{ transform: 'scale(1.22)' }, { transform: 'scale(1)' }], 2000); });
    [1, 2, 3].forEach(function (n) {
      at(t0 + 0.6 + 0.8 * n, function () { coldTimer.textContent = S.c0_wait.replace('{n}', 23 + n); });
    });
    at(t0 + 2.3, function () { tween(coldLine, [{ opacity: 0, transform: 'translateY(24px)' }, { opacity: 1, transform: 'translateY(0px)' }], 520); });
    at(t0 + 3.0, function () { tween(cold, [{ opacity: 1 }, { opacity: 0 }], 400); });
  });

  /* ================= S0 — remote desktop pain ================= */
  var hook = el('div', 'intro', stage); hook.style.zIndex = 150;
  var hookQ = el('div', 'hook-q', hook, S.hook_q);
  var hookAns = el('div', 'hook-ans', hook, S.hook_ans);
  var PAIN = [S.pain1, S.pain2, S.pain3];
  var pcards = [], xbs = [], ptags = [], rips = [], searches = [];
  var painArt = [
    '<div class="mphone"><div class="mdesk"><i style="width:80%"></i><i style="width:60%"></i><i style="width:90%"></i>' +
      '<i style="width:50%"></i><i style="width:70%"></i><i style="width:85%"></i></div></div><i class="pd pd1"></i><i class="pd pd2"></i>',
    '<div class="mwin mw1"></div><div class="mwin mw2"></div><div class="mwin mw3"></div><div class="magent"></div><div class="psearch"></div>',
    '<div class="mbtns"><i></i><i></i><i></i><i></i><i></i><i></i></div><div class="mkbd"></div><div class="rip"></div><span class="ptag">' + S.pt_tag + '</span>'
  ];
  for (var pi = 0; pi < 3; pi++) {
    var pc = el('div', 'pain-card', hook);
    pc.style.left = (215 + pi * 520) + 'px';
    pc.innerHTML = '<div class="xb">✕</div><div class="pcanvas">' + painArt[pi] + '</div><div class="pain-title">' + PAIN[pi] + '</div>';
    pcards.push(pc);
    xbs.push(pc.querySelector('.xb'));
  }
  searches.push(pcards[1].querySelector('.psearch'));
  rips.push(pcards[2].querySelector('.rip'));
  ptags.push(pcards[2].querySelector('.ptag'));

  scene('s0', 6.5, function (t0) {
    at(t0, function () {
      tween(hook, [{ opacity: 0 }, { opacity: 1 }], 400);
      tween(hookQ, [{ opacity: 0, transform: 'translateY(24px)' }, { opacity: 1, transform: 'translateY(0px)' }], 500);
      pcards.forEach(function (c, i) {
        wait(0.4 + i * 0.3).then(function () {
          return tween(c, [{ opacity: 0, transform: 'translateY(40px) scale(1)' }, { opacity: 1, transform: 'translateY(0px) scale(1)' }], 480);
        });
      });
      var sp = [[40, 60], [210, 130], [70, 200], [250, 70]];
      var sEl = searches[0];
      sEl.style.left = sp[0][0] + 'px'; sEl.style.top = sp[0][1] + 'px';
      var cur = sp[0];
      sp.slice(1).forEach(function (p, k) {
        wait(1.2 + k * 0.7).then(function () {
          var from = cur; cur = p;
          return tween(sEl, [{ left: from[0] + 'px', top: from[1] + 'px' }, { left: p[0] + 'px', top: p[1] + 'px' }], 450);
        });
      });
      wait(2.2).then(function () {
        return tween(rips[0], [{ opacity: 0.9, transform: 'scale(.3)' }, { opacity: 0, transform: 'scale(1.6)' }], 520);
      });
      wait(2.7).then(function () { return pop(ptags[0], 360); });
    });
    at(t0 + 3.2, function () {
      xbs.forEach(function (x, i) { wait(i * 0.12).then(function () { return pop(x, 340); }); });
    });
    at(t0 + 4.3, function () {
      pcards.forEach(function (c) {
        tween(c, [{ opacity: 1, transform: 'translateY(0px) scale(1)' }, { opacity: 0, transform: 'translateY(0px) scale(.86)' }], 450);
      });
      tween(hookQ, [{ opacity: 1 }, { opacity: 0 }], 400);
    });
    at(t0 + 4.7, function () { pop(hookAns, 480); });
    at(t0 + 6.1, function () { tween(hook, [{ opacity: 1 }, { opacity: 0 }], 380); });
  });

  /* ================= S1 — brand ================= */
  var brand = el('div', 'intro', stage); brand.style.zIndex = 150;
  brand.innerHTML = '<div class="brand-wrap"><img class="title-icon" src="assets/ra-icon.svg">' +
    '<div class="title-main">Remote Agent</div><div class="title-tag">' + S.brand_sub + '</div>' +
    '<div class="app-row"><div class="app-pill"><i class="adot" style="background:#1E88E5"></i>Cursor</div>' +
    '<div class="app-pill"><i class="adot" style="background:#7C5CF6"></i>Devin</div>' +
    '<div class="app-pill"><i class="adot" style="background:#1A9F5A"></i>Codex</div></div></div>';
  var bIcon = brand.querySelector('.title-icon'), bTtl = brand.querySelector('.title-main'),
      bTag = brand.querySelector('.title-tag'), bPills = brand.querySelectorAll('.app-pill');

  scene('s1', 3.2, function (t0) {
    at(t0, function () { tween(brand, [{ opacity: 0 }, { opacity: 1 }], 400); pop(bIcon, 520); });
    at(t0 + 0.5, function () { tween(bTtl, [{ opacity: 0, transform: 'translateY(28px)' }, { opacity: 1, transform: 'translateY(0px)' }], 500); });
    at(t0 + 0.8, function () { tween(bTag, [{ opacity: 0 }, { opacity: 1 }], 400); });
    [0, 1, 2].forEach(function (i) { at(t0 + 1.05 + i * 0.18, function () { pop(bPills[i], 420); }); });
    at(t0 + 2.55, function () {
      tween(brand, [{ opacity: 1 }, { opacity: 0 }], 500);
      tween(world, [{ opacity: 0 }, { opacity: 1 }], 620);
    });
  });

  /* ================= A1 — the long task is running ================= */
  scene('a1', 7.5, function (t0) {
    at(t0, function () {
      caption('cap_a1', S.k1_pain, S.k1_sol);
      show(timechip, 400); setTime('12:02');
    });
    at(t0 + 0.15, function () { agPush({ type: 'user', text: S.a1_prompt }); });
    var m1 = null, m2 = null;
    at(t0 + 0.65, function () { m1 = agPush({ type: 'tool', name: 'read_file', args: 'src/auth/session.ts', state: 'run' }); });
    at(t0 + 1.2, function () { agUpdate(m1, { state: 'done' }); });
    at(t0 + 1.9, function () { m2 = agPush({ type: 'tool', name: 'edit', args: '6 files', state: 'run' }); });
    at(t0 + 2.4, function () { agUpdate(m2, { state: 'done' }); });
    at(t0 + 3.0, function () {
      AG.testId = agPush({ type: 'test', name: 'run npm test', state: 'run', count: 0, total: 132 });
    });
    for (var i = 1; i <= 19; i++) {
      (function (n) {
        at(t0 + 3.0 + n * 0.09, function () { agUpdate(AG.testId, { count: Math.round(38 * n / 19) }); });
      })(i);
    }
    for (var ti = 0; ti < 14; ti++) at(t0 + 0.3 + ti * 0.5, termLine);
    for (var ei = 0; ei < 12; ei++) (function (n) { at(t0 + 0.6 + n * 0.5, function () { flashCode(n); }); })(ei);
    /* ~4.5 s: the person stands, takes the phone and walks off to the right */
    at(t0 + 4.5, function () {
      sitting.style.display = 'none';
      deskPhone.style.opacity = '0';
      standing.style.opacity = '1';
    });
    at(t0 + 4.7, function () {
      tween(standing, [{ transform: 'translateX(0px)' }, { transform: 'translateX(640px)' }], 1750);
    });
    at(t0 + 6.5, function () { standing.style.opacity = '0'; });
  });

  /* ================= A2 — only the agent flies into the phone ================= */
  scene('a2', 6.5, function (t0) {
    at(t0, function () {
      caption('cap_a2', S.k2_pain, S.k2_sol);
      bwins.forEach(function (w) {
        tween(w, [{ filter: 'grayscale(0) opacity(1)' }, { filter: 'grayscale(1) opacity(0.45)' }], 500);
        pop(w.querySelector('.ntag'), 320);
      });
      dPanel.classList.add('liftoff');
    });
    at(t0 + 0.9, function () {
      var r = rectInWorld(dPanel);
      dPanel.classList.remove('liftoff');
      dPanel.style.opacity = '0';
      flight = el('div', 'flight', world);
      place(flight, r);
      flight.style.borderRadius = '10px';
      var clone = dPanel.cloneNode(true);
      clone.classList.add('fclone'); clone.classList.remove('liftoff');
      clone.style.cssText = 'opacity:1;left:0px;top:0px;width:100%;height:100%;';
      flight.appendChild(clone);
      tween(flight, [
        { left: r[0] + 'px', top: r[1] + 'px', width: r[2] + 'px', height: r[3] + 'px', borderRadius: '10px' },
        { offset: 0.3, left: (r[0] - 60) + 'px', top: '20px', width: (r[2] * 1.03) + 'px', height: (r[3] * 1.03) + 'px', borderRadius: '16px' },
        { offset: 0.65, left: '1000px', top: '40px', width: '420px', height: '760px', borderRadius: '28px' },
        { left: '1266px', top: '94px', width: '398px', height: '814px', borderRadius: '40px' }
      ], 2600);
    });
    at(t0 + 2.4, function () {
      tween(phoneWrap, [{ transform: 'translate(340px,190px)', opacity: 0 }, { transform: 'translate(0px,0px)', opacity: 1 }], 1100);
    });
    at(t0 + 3.5, function () {
      tween(flight, [{ opacity: 1 }, { opacity: 0 }], 250).then(function () { flight.remove(); });
      tween(dPanel, [{ opacity: 0 }, { opacity: 1 }], 300);
      tween(pChat, [{ opacity: 0 }, { opacity: 1 }], 300);
      tween(pFlash, [{ opacity: 0 }, { opacity: 0.85 }, { opacity: 0 }], 420);
      tween(phoneWrap, [{ transform: 'translate(0px,0px) scale(1)' }, { transform: 'translate(0px,-8px) scale(1.02)' },
        { transform: 'translate(0px,0px) scale(1)' }], 460);
    });
    at(t0 + 3.6, function () {
      tween(monWrap, [{ transform: 'translate(200px,70px) scale(1)' }, { transform: 'translate(217px,237px) scale(0.52)' }], 800);
    });
    at(t0 + 3.9, function () {
      tween(relay, [{ width: '0px' }, { width: '347px' }], 700);
      tween(relayLbl, [{ opacity: 0 }, { opacity: 1 }], 400);
      tween(chipPc, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'translateY(0px)' }], 400);
      tween(chipPhone, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'translateY(0px)' }], 400);
    });
    at(t0 + 4.6, function () {
      tween(rdPhone, [{ opacity: 0 }, { opacity: 0.92 }], 450);
      tween(relayLbl, [{ opacity: 1 }, { opacity: 0 }], 300);
    });
    at(t0 + 6.1, function () {
      tween(rdPhone, [{ opacity: 0.92 }, { opacity: 0 }], 380);
      tween(relayLbl, [{ opacity: 0 }, { opacity: 1 }], 300);
    });
  });

  /* ================= A3 — real-time sync ================= */
  scene('a3', 5.5, function (t0) {
    at(t0, function () { caption('cap_a3', S.k3_pain, S.k3_sol); setTime('12:15'); });
    var mA = null, mB = null;
    at(t0 + 0.35, function () {
      mA = agPush({ type: 'tool', name: 'edit', args: 'src/auth/token.ts', state: 'run' });
      flashConnector(mA);
    });
    at(t0 + 0.95, function () {
      agUpdate(mA, { state: 'done' });
      mB = agPush({ type: 'tool', name: 'edit', args: 'src/auth/refresh.ts', state: 'run' });
      flashConnector(mB);
    });
    at(t0 + 1.5, function () { agUpdate(mB, { state: 'done' }); });
    for (var n = 1; n <= 20; n++) {
      (function (k) {
        at(t0 + 1.0 + k * 0.075, function () {
          agUpdate(AG.testId, { count: 38 + Math.round(59 * k / 20) });
          if (k % 7 === 0) flashConnector(AG.testId);
        });
      })(n);
    }
    at(t0 + 3.0, function () { worldZoom(PHONE_RECT, 1.25, 650); });
    at(t0 + 4.3, function () { worldZoomOut(600); });
  });

  /* ================= A4 — the agent asks a question ================= */
  scene('a4', 7.5, function (t0) {
    at(t0, function () { caption('cap_a4', S.k4_pain, S.k4_sol); setTime('12:28'); });
    at(t0 + 0.2, function () {
      agStatus('wait');
      tween(pBanner, [{ top: '-110px' }, { top: '44px' }], 480, SPRING);
    });
    at(t0 + 0.55, function () {
      var id = agQuestion({ q: S.a4_q, opts: S.a4_opts });
      flashConnector(id);
    });
    at(t0 + 1.7, function () { worldZoom(PHONE_RECT, 1.25, 650); });
    at(t0 + 2.6, function () {
      var optB = AG.msgs[AG.msgs.length - 1].p.querySelectorAll('.opt')[1];
      pTap(optB).then(function () {
        agAnswer(1);
        agStatus('run');
        tween(pBanner, [{ top: '44px' }, { top: '-110px' }], 420);
      });
    });
    at(t0 + 3.0, function () { worldZoomOut(600); });
    at(t0 + 4.4, function () {
      var id = agPush({ type: 'tool', name: 'edit', args: 'src/auth/compat.ts', state: 'run' });
      flashConnector(id);
      wait(0.6).then(function () { agUpdate(id, { state: 'done' }); });
    });
    at(t0 + 5.4, function () {
      var id = agPush({ type: 'tool', name: 'read_file', args: 'src/api/legacy.ts', state: 'run' });
      flashConnector(id);
      wait(0.6).then(function () { agUpdate(id, { state: 'done' }); });
    });
  });

  /* ================= A5 — typing syncs both ways ================= */
  var chars = Array.from(S.a5_text);
  function flashKey(i) {
    var kk = kbdKeys[i % kbdKeys.length];
    kk.classList.add('lit');
    wait(0.12).then(function () { kk.classList.remove('lit'); });
  }
  function typeChar(i) {
    if (i >= chars.length) return wait(0.35).then(sendDraft);
    agDraft(chars.slice(0, i + 1).join(''));
    flashKey(i);
    return wait(0.075).then(function () { return typeChar(i + 1); });
  }
  function sendDraft() {
    return pTap(pSend).then(function () {
      var id = agPush({ type: 'user', text: S.a5_text });
      flashConnector(id);
      agDraft('');
      lensOn = false;
      tween(lens, [{ opacity: 1 }, { opacity: 0 }], 300);
      tween(pKbd, [{ transform: 'translateY(0%)' }, { transform: 'translateY(100%)' }], 420);
      tween(pChat, [{ bottom: '272px' }, { bottom: '0px' }], 420);
    });
  }
  scene('a5', 7.5, function (t0) {
    at(t0, function () { caption('cap_a5', S.k5_pain, S.k5_sol); });
    at(t0 + 0.2, function () {
      tween(pKbd, [{ transform: 'translateY(100%)' }, { transform: 'translateY(0%)' }], 500);
      tween(pChat, [{ bottom: '0px' }, { bottom: '272px' }], 500);
    });
    at(t0 + 0.9, function () {
      lensOn = true;
      positionLens();
      tween(lens, [{ opacity: 0 }, { opacity: 1 }], 300);
    });
    at(t0 + 1.0, function () { typeChar(0); });
  });

  /* ================= A6 — completion reminder on the phone ================= */
  scene('a6', 6.5, function (t0) {
    at(t0, function () {
      caption('cap_a6', S.k6_pain, S.k6_sol);
      tween(pBlack, [{ opacity: 0 }, { opacity: 1 }], 350);
    });
    at(t0 + 0.2, function () { setTime('12:41'); });
    for (var n = 1; n <= 7; n++) {
      (function (k) { at(t0 + 0.2 + k * 0.15, function () { agUpdate(AG.testId, { count: 97 + Math.round(35 * k / 7) }); }); })(n);
    }
    at(t0 + 1.5, function () {
      agUpdate(AG.testId, { state: 'done' });
      agPush({ type: 'final', text: S.a6_msg });
      agStatus('done');
    });
    at(t0 + 2.0, function () {
      tween(pBlack, [{ opacity: 1 }, { opacity: 0 }], 300);
      tween(pLock, [{ opacity: 0 }, { opacity: 1 }], 300);
    });
    at(t0 + 2.6, function () {
      tween(pNotif, [{ top: '-150px' }, { top: '110px' }], 600, SPRING);
    });
    at(t0 + 3.3, function () {
      tween(pNotif, [{ transform: 'translateX(0px)' }, { offset: 0.2, transform: 'translateX(-6px)' },
        { offset: 0.4, transform: 'translateX(6px)' }, { offset: 0.6, transform: 'translateX(-4px)' },
        { offset: 0.8, transform: 'translateX(4px)' }, { transform: 'translateX(0px)' }], 400);
    });
    at(t0 + 4.0, function () {
      pTap(pNotif).then(function () { return tween(pLock, [{ opacity: 1 }, { opacity: 0 }], 400); });
    });
  });

  /* ================= A7 — more capabilities, on the phone ================= */
  scene('a7', 7.0, function (t0) {
    at(t0, function () { caption('cap_a7', S.k7_pain, S.k7_sol); });
    at(t0 + 0.2, function () { agView('models', { sel: 0 }); });
    at(t0 + 1.0, function () {
      pTap(pView.querySelectorAll('.mrow')[1]).then(function () { agView('models', { sel: 1 }); });
    });
    at(t0 + 2.2, function () { agView(null); });
    function typeCmd(i) {
      if (AG.view !== 'term') return;
      if (i > S.term_cmd.length) return lineOut(0);
      agView('term', { cmd: S.term_cmd.slice(0, i), lines: [] });
      return wait(0.09).then(function () { return typeCmd(i + 1); });
    }
    function lineOut(j) {
      if (AG.view !== 'term') return;
      if (j >= S.term_lines.length) return;
      agView('term', { cmd: S.term_cmd, lines: S.term_lines.slice(0, j + 1) });
      return wait(0.3).then(function () { return lineOut(j + 1); });
    }
    at(t0 + 2.4, function () {
      agView('term', { cmd: '', lines: [] });
      wait(0.2).then(function () { return typeCmd(0); });
    });
    at(t0 + 4.4, function () { agView(null); });
    at(t0 + 4.5, function () { agPush({ type: 'fileref' }); });
    at(t0 + 4.9, function () {
      var fr = AG.msgs[AG.msgs.length - 1].p.querySelector('.fref');
      pTap(fr).then(function () { agView('file', { zoom: 1, hl: 3 }); });
    });
    at(t0 + 5.7, function () { tween(pPinch, [{ opacity: 0 }, { opacity: 1 }], 200); });
    at(t0 + 5.9, function () {
      tween(pdots[0], [{ left: '180px' }, { left: '90px' }], 900);
      tween(pdots[1], [{ left: '220px' }, { left: '310px' }], 900);
      agView('file', { zoom: 2.2, hl: 3 });
    });
    at(t0 + 6.7, function () { tween(pPinch, [{ opacity: 1 }, { opacity: 0 }], 250); });
  });

  /* ================= A8 — pairing ================= */
  var pillWrap = el('div', 'pills', world);
  scene('a8', 4.5, function (t0) {
    at(t0, function () {
      caption('cap_a8', S.k8_pain, S.k8_sol);
      agView('cam', { paired: false });
      tween(qrWrap, [{ opacity: 0 }, { opacity: 1 }], 400);
    });
    at(t0 + 1.6, function () {
      var sl = pView.querySelector('.scanl');
      if (sl) tween(sl, [{ top: '90px' }, { top: '380px' }], 900);
    });
    at(t0 + 2.6, function () {
      var sl = pView.querySelector('.scanl');
      if (sl) tween(sl, [{ top: '380px' }, { top: '90px' }], 700);
    });
    at(t0 + 2.9, function () {
      agView('cam', { paired: true });
      tween(qrBox, [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(.2)', opacity: 0 }], 500);
      tween(qrOk, [{ opacity: 0 }, { opacity: 1 }], 400);
    });
    S.sec.forEach(function (t, i) {
      at(t0 + 3.0 + i * 0.2, function () {
        var p = el('div', 'pill', pillWrap, t);
        pop(p, 400);
      });
    });
  });

  /* ================= O — outro ================= */
  var outro = el('div', 'outro', stage);
  outro.innerHTML = '<img class="o-icon" src="assets/ra-icon.svg"><div class="o-title">Remote Agent</div>' +
    '<div class="o-motto">' + S.motto.map(function (w) { return '<span class="tok">' + w + '</span>'; }).join('') + '</div>' +
    '<div class="o-cards">' + [1, 2, 3].map(function (i) {
      return '<div class="ocard"><div class="ocbar" style="width:0%"></div><div class="ot">' + S['card' + i + '_t'] +
        '</div><div class="os">' + S['card' + i + '_s'] + '</div></div>';
    }).join('') + '</div>' +
    '<div class="cta">github.com/xrdiao/remote-agent</div><div class="o-meta">' + S.cta_meta + '</div>';
  var oIcon = outro.querySelector('.o-icon'), oTitle = outro.querySelector('.o-title'),
      oToks = outro.querySelectorAll('.tok'), oCards = outro.querySelectorAll('.ocard'),
      oBars = outro.querySelectorAll('.ocbar'), oCta = outro.querySelector('.cta'), oMeta = outro.querySelector('.o-meta');

  scene('o', 8.0, function (t0) {
    at(t0, function () {
      captionOff();
      hide(timechip, 300);
      tween(world, [{ opacity: 1 }, { opacity: 0 }], 500);
      tween(outro, [{ opacity: 0 }, { opacity: 1 }], 600);
    });
    at(t0 + 0.2, function () { pop(oIcon, 520); });
    at(t0 + 0.5, function () { tween(oTitle, [{ opacity: 0, transform: 'translateY(28px)' }, { opacity: 1, transform: 'translateY(0px)' }], 500); });
    [0, 1, 2, 3, 4, 5, 6, 7, 8].forEach(function (i) {
      at(t0 + 1.0 + i * 0.12, function () {
        if (oToks[i]) tween(oToks[i], [{ opacity: 0, transform: 'translateY(30px)' }, { opacity: 1, transform: 'translateY(0px)' }], 420);
      });
    });
    [0, 1, 2].forEach(function (i) {
      at(t0 + 2.0 + i * 0.35, function () {
        pop(oCards[i], 420);
        tween(oBars[i], [{ width: '0%' }, { width: '100%' }], 700);
      });
    });
    at(t0 + 3.4, function () {
      pop(oCta, 450).then(function () { oCta.classList.add('shine'); });
    });
    at(t0 + 3.9, function () { tween(oMeta, [{ opacity: 0 }, { opacity: 1 }], 480); });
  });
  END_T = T;

  /* ---------------- boot / seek ---------------- */
  cues.sort(function (a, b) { return a.t - b.t; });
  function start() {
    clockStarted = true; lastNow = performance.now();
    requestAnimationFrame(tick);
  }
  function boot() {
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
  function dumpDebug() {
    var out = {};
    ['world', 'monwrap', 'phonewrap', 'capbar', 'timechip', 'lens'].forEach(function (id) {
      var e = document.getElementById(id) || stage.querySelector('.' + id);
      if (e) { var r = e.getBoundingClientRect(); out[id] = [r.left | 0, r.top | 0, r.width | 0, r.height | 0]; }
    });
    var d = el('pre', '', stage); d.id = 'dbg';
    d.style.cssText = 'position:absolute;left:0;top:0;z-index:9999;color:#0a0;font-size:10px;';
    d.textContent = JSON.stringify(out) + ' title=' + document.title;
  }
  boot();
})();
