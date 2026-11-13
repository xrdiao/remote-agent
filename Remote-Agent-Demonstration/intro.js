/* Remote Agent demo - intro keyframe art (ported from the approved storyboard).
   RA_INTRO.build(orient) returns the SVG/CSS builders for the quad intro. */
var RA_INTRO = {};
RA_INTRO.build = function (orient) {
  'use strict';
const P = orient === 'portrait';
  
  const W = P ? 1080 : 1920, H = P ? 1920 : 1080, RY = H * .83;
  const SKIN = '#E8B48A', SKIN2 = '#D9A176', HAIR = '#3A2C22';
  const svg = inner => `<svg class="scene" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">${inner}</svg>`;
  const DEFS = `<defs>
    <linearGradient id="sh" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".3"/><stop offset="1" stop-color="#000" stop-opacity=".14"/></linearGradient>
    <linearGradient id="sk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F0C49C"/><stop offset="1" stop-color="#D9A176"/></linearGradient>
    <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F6EBD9"/><stop offset="1" stop-color="#EBDCC4"/></linearGradient>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#DDEAF6"/><stop offset="1" stop-color="#EFF6FA"/></linearGradient>
    <linearGradient id="grass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#C8DDB4"/><stop offset="1" stop-color="#AFC99A"/></linearGradient>
    <linearGradient id="car" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E9ECF2"/><stop offset="1" stop-color="#D6DAE2"/></linearGradient>
    <linearGradient id="flr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#EDE3D2"/><stop offset="1" stop-color="#DCCFB8"/></linearGradient>
    <radialGradient id="glow" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#FFE9B8" stop-opacity=".85"/><stop offset="1" stop-color="#FFE9B8" stop-opacity="0"/></radialGradient>
    <filter id="b4" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="4"/></filter>
    <filter id="b8" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="9"/></filter>
  </defs>`;
  /* seated person, back-3/4 view; anchor = floor point under hips; ~570px tall at s=1 */
  const miniPh = `<g transform="rotate(-16)"><rect x="-19" y="-36" width="38" height="72" rx="9" fill="#14161A"/><rect x="-14" y="-30" width="28" height="60" rx="5" fill="#C9DBF5"/></g>`;
    /* seated person back-3/4; o={c:chair, ph:0|1|2 phone pos, pose:'eat'|'run'|'cafe'|null} */
  const seatP = (x, y, s, cl, o = {}) => { const { c = 1, ph = 0, pose } = o;
  const legs = pose === 'run'
    ? `<path d="M-68 -274 L-34 -220 L56 -208 L50 -250 L-50 -264 Z" fill="#3F4A5E"/><circle cx="53" cy="-229" r="19" fill="#3F4A5E"/>
       <rect x="26" y="-222" width="27" height="205" rx="12" fill="url(#sk)" transform="rotate(4 39 -222)"/><ellipse cx="48" cy="-9" rx="35" ry="14" fill="#EDEFF3" transform="rotate(-4 48 -9)"/>
       <path d="M-56 -270 L-34 -212 L104 -196 L110 -236 L-30 -252 Z" fill="#4E5A70"/><circle cx="107" cy="-216" r="21" fill="#4E5A70"/>
       <rect x="92" y="-212" width="30" height="205" rx="13" fill="url(#sk)"/><ellipse cx="108" cy="-8" rx="38" ry="15" fill="#EDEFF3" transform="rotate(-5 108 -8)"/>`
    : pose === 'cafe'
    ? `<path d="M-56 -272 L-36 -220 L100 -198 L106 -240 L-30 -256 Z" fill="#3F4A5E"/><circle cx="103" cy="-219" r="20" fill="#3F4A5E"/>
       <rect x="90" y="-214" width="29" height="198" rx="12" fill="#3F4A5E"/><ellipse cx="106" cy="-8" rx="37" ry="15" fill="#EDEFF3" transform="rotate(-5 106 -8)"/>
       <path d="M-62 -262 L-46 -210 L94 -196 L96 -238 L-30 -252 Z" fill="#4E5A70"/><circle cx="95" cy="-218" r="19" fill="#4E5A70"/>
       <rect x="82" y="-210" width="27" height="115" rx="12" fill="#46536B" transform="rotate(-30 95 -210)"/><rect x="146" y="-120" width="60" height="26" rx="12" fill="#EDEFF3" transform="rotate(28 146 -120)"/>`
    : `<path d="M-68 -274 L-34 -220 L56 -208 L50 -250 L-50 -264 Z" fill="#3F4A5E"/><circle cx="53" cy="-229" r="19" fill="#3F4A5E"/>
       <rect x="26" y="-222" width="27" height="205" rx="12" fill="#3F4A5E" transform="rotate(4 39 -222)"/><ellipse cx="48" cy="-9" rx="35" ry="14" fill="#E3E7EC" transform="rotate(-4 48 -9)"/>
       <path d="M-56 -270 L-34 -212 L104 -196 L110 -236 L-30 -252 Z" fill="#4E5A70"/><circle cx="107" cy="-216" r="21" fill="#4E5A70"/>
       <rect x="92" y="-212" width="30" height="205" rx="13" fill="#46536B"/><ellipse cx="108" cy="-8" rx="38" ry="15" fill="#EDEFF3" transform="rotate(-5 108 -8)"/>`;
  const arms = pose === 'eat'
    ? `<path d="M58 -430 Q116 -386 148 -322" stroke="${cl}" stroke-width="34" fill="none" stroke-linecap="round"/>
       <path d="M148 -322 Q172 -292 186 -272" stroke="url(#sk)" stroke-width="23" fill="none" stroke-linecap="round"/>
       <circle cx="190" cy="-266" r="14" fill="url(#sk)"/>
       <path d="M194 -260 L236 -226 M200 -252 L240 -222" stroke="#8A6A50" stroke-width="5" stroke-linecap="round"/>
       <path d="M-66 -430 Q-40 -380 0 -350" stroke="${cl}" stroke-width="30" fill="none" stroke-linecap="round"/>
       <path d="M0 -350 Q30 -330 60 -318" stroke="url(#sk)" stroke-width="21" fill="none" stroke-linecap="round"/>
       <circle cx="66" cy="-316" r="13" fill="url(#sk)"/>`
    : pose === 'run'
    ? `<path d="M56 -432 Q116 -396 98 -348" stroke="${cl}" stroke-width="32" fill="none" stroke-linecap="round"/>
       <path d="M98 -348 Q66 -336 42 -362" stroke="url(#sk)" stroke-width="22" fill="none" stroke-linecap="round"/>
       <circle cx="36" cy="-368" r="13" fill="url(#sk)"/>
       <path d="M-66 -432 Q-36 -370 -2 -312" stroke="${cl}" stroke-width="30" fill="none" stroke-linecap="round"/>
       <path d="M-2 -312 Q30 -278 52 -258" stroke="url(#sk)" stroke-width="21" fill="none" stroke-linecap="round"/>
       <circle cx="58" cy="-252" r="13" fill="url(#sk)"/>`
    : pose === 'cafe'
    ? `<path d="M58 -432 Q104 -400 104 -354" stroke="${cl}" stroke-width="32" fill="none" stroke-linecap="round"/>
       <path d="M104 -354 Q96 -330 66 -338" stroke="url(#sk)" stroke-width="22" fill="none" stroke-linecap="round"/>
       <circle cx="58" cy="-342" r="13" fill="url(#sk)"/>
       <path d="M36 -392 h30 v24 h-30z" fill="#fff" transform="rotate(-14 51 -380)"/><path d="M66 -388 a8 8 0 1 1 -0.1 0" fill="none" stroke="#fff" stroke-width="4" transform="rotate(-14 60 -384)"/>
       <path d="M-66 -432 Q-104 -384 -98 -310" stroke="${cl}" stroke-width="30" fill="none" stroke-linecap="round"/>
       <circle cx="-96" cy="-300" r="13" fill="url(#sk)"/>`
    : `<path d="M60 -436 Q122 -398 152 -326" stroke="${cl}" stroke-width="34" fill="none" stroke-linecap="round"/>
       <path d="M152 -326 Q170 -292 176 -256" stroke="url(#sk)" stroke-width="23" fill="none" stroke-linecap="round"/>
       <circle cx="179" cy="-248" r="14" fill="url(#sk)"/>
       <path d="M-66 -436 Q-104 -384 -98 -306" stroke="${cl}" stroke-width="30" fill="none" stroke-linecap="round"/>
       <circle cx="-96" cy="-296" r="13" fill="url(#sk)"/>`;
  const lean = pose === 'eat' ? 9 : pose === 'run' ? 13 : pose === 'cafe' ? -7 : 0;
  const phoneAt = ph === 2 ? 'translate(-116,-300) rotate(8)' : pose === 'run' ? 'translate(70,-255) rotate(-12)' : 'translate(198,-286)';
  return `<g transform="translate(${x},${y}) scale(${s})">
    <ellipse cx="30" cy="8" rx="170" ry="20" fill="#000" opacity=".12"/>
    ${c ? `<rect x="-98" y="-470" width="196" height="245" rx="44" fill="#7A6248"/><rect x="-98" y="-470" width="196" height="245" rx="44" fill="url(#sh)"/>
    <rect x="-82" y="-252" width="224" height="36" rx="15" fill="#8A7355"/>
    <rect x="118" y="-228" width="15" height="228" fill="#6E5940"/><rect x="-72" y="-228" width="15" height="228" fill="#6E5940"/>` : ''}
    ${legs}
    <g transform="rotate(${lean} 0 -262)">
    <path d="M-70 -452 Q-84 -362 -60 -262 L56 -262 Q78 -362 64 -452 Q0 -472 -70 -452 Z" fill="${cl}"/>
    <path d="M-70 -452 Q-84 -362 -60 -262 L56 -262 Q78 -362 64 -452 Q0 -472 -70 -452 Z" fill="url(#sh)"/>
    ${arms}
    <rect x="-15" y="-496" width="30" height="36" rx="9" fill="url(#sk)"/>
    <circle cx="0" cy="-534" r="39" fill="url(#sk)"/>
    <circle cx="33" cy="-526" r="8" fill="${SKIN2}"/>
    <path d="M38 -510 q5 8 -1 13" stroke="${SKIN2}" stroke-width="4" fill="none" stroke-linecap="round"/>
    <path d="M-39 -534 a39 38 0 0 1 78 0 l3 18 q-8 10 -16 3 q-3 -20 -22 -21 q-20 -1 -25 19 q-10 9 -18 -1 z" fill="${HAIR}"/>
    </g>
    ${ph ? `<g transform="${phoneAt}">${miniPh}</g>` : ''}
  </g>`; };
  /* standing person from behind, left arm raised to rail; anchor = floor point; ~720px at s=1 */
  const standP = (x, y, s, cl, ph = 0) => `<g transform="translate(${x},${y}) scale(${s})">
    <ellipse cx="8" cy="8" rx="120" ry="16" fill="#000" opacity=".13"/>
    <path d="M-34 -212 L-46 -22 L-14 -22 L-8 -204 Z" fill="#3F4A5E"/><path d="M4 -204 L22 -22 L54 -22 L34 -212 Z" fill="#46536B"/>
    <ellipse cx="-30" cy="-13" rx="30" ry="13" fill="#EDEFF3" transform="rotate(-7 -30 -13)"/><ellipse cx="40" cy="-13" rx="30" ry="13" fill="#EDEFF3" transform="rotate(7 40 -13)"/>
    <path d="M-54 -436 Q-64 -336 -48 -200 L50 -200 Q64 -336 54 -436 Q0 -458 -54 -436 Z" fill="${cl}"/>
    <path d="M-54 -436 Q-64 -336 -48 -200 L50 -200 Q64 -336 54 -436 Q0 -458 -54 -436 Z" fill="url(#sh)"/>
    <path d="M-50 -424 Q-116 -388 -112 -480" stroke="${cl}" stroke-width="30" fill="none" stroke-linecap="round"/>
    <path d="M-112 -480 Q-110 -530 -106 -568" stroke="url(#sk)" stroke-width="22" fill="none" stroke-linecap="round"/>
    <circle cx="-105" cy="-574" r="13" fill="url(#sk)"/>
    <path d="M52 -424 Q86 -356 80 -276" stroke="${cl}" stroke-width="28" fill="none" stroke-linecap="round"/>
    <circle cx="80" cy="-264" r="13" fill="url(#sk)"/>
    <path d="M46 -412 Q62 -330 58 -252" stroke="#39414F" stroke-width="9" fill="none"/><rect x="38" y="-252" width="46" height="60" rx="12" fill="#39414F"/>
    ${ph ? `<g transform="translate(98,-300)">${miniPh}</g>` : ''}
    <rect x="-15" y="-478" width="30" height="34" rx="9" fill="url(#sk)"/>
    <circle cx="0" cy="-518" r="39" fill="url(#sk)"/>
    <circle cx="33" cy="-510" r="8" fill="${SKIN2}"/>
    <path d="M-39 -516 a39 37 0 0 1 78 0 l4 28 q-7 12 -17 4 q-2 -24 -23 -24 q-19 -2 -25 22 q-10 10 -18 -2 z" fill="${HAIR}"/>
  </g>`;
  const bub = (x, y) => `<div class="sbub" style="left:${x}px;top:${y}px">我想看看 Agent<br>干活干得怎么样了</div>`;
  const pstat = `<div class="pstatus"><span class="ptime">12:02</span><span class="sic"><span class="sbar"></span><span class="sbar"></span><span class="sbar"></span><svg class="wifi" viewBox="0 0 16 12"><path d="M8 10.5 2.5 5a8 8 0 0 1 11 0Z"/><circle cx="8" cy="10" r="1.6"/></svg><span class="batt"></span></span></div>`;
  const phoneShell = (inner, at) => `<div id="phonewrap" style="${at};opacity:1"><div class="pframe"></div><div class="pscr">${inner}${pstat}<div class="pisland"></div></div></div>`;
  /* POV hand: sleeve cuff + palm + 3 fingers + thumb */
  const hand = (x, y, rot, flip, sc) => `<g transform="translate(${x},${y}) rotate(${rot}) scale(${flip ? -sc : sc},${sc})">
    <rect x="-30" y="60" width="140" height="90" rx="24" fill="#5A6B85"/>
    <rect x="-70" y="-46" width="130" height="120" rx="36" fill="url(#sk)"/>
    ${[0, 1, 2].map(k => `<rect x="${-86 - k * 4}" y="${-92 + k * 30}" width="34" height="70" rx="16" fill="url(#sk)"/>`).join('')}
    <ellipse cx="64" cy="-12" rx="26" ry="52" fill="url(#sk)" transform="rotate(-38 64 -12)"/>
  </g>`;
  const cafe = `<rect width="${W}" height="${H}" fill="#EFE7DA"/>
    <g filter="url(#b8)">${[...Array(6)].map((_, k) => `<rect x="${W * (.58 + k * .07)}" y="${H * .3}" width="${W * .045}" height="${H * .3}" rx="6" fill="${k % 2 ? '#D8CFC2' : '#CEC6BA'}"/>`).join('')}
    <rect x="${W * .55}" y="${H * .55}" width="${W * .45}" height="${H * .1}" fill="#D5CCC0"/></g>
    <rect y="${H * .7}" width="${W}" height="${H * .3}" fill="url(#flr)"/>`;
  const awning = [...Array(P ? 9 : 16)].map((_, k) => `<path d="M${k * W / (P ? 9 : 16)} 0 h${W / (P ? 9 : 16)} v${H * .09} a${W / (P ? 9 : 16) / 2} ${H * .035} 0 0 1 -${W / (P ? 9 : 16)} 0z" fill="${k % 2 ? '#E8B7A0' : '#FBF6EF'}"/>`).join('');
  const S = {};
  /* ---- 1 餐厅 ---- */
  const s1 = ph => svg(DEFS + `<rect width="${W}" height="${H}" fill="url(#wall)"/>
    <g filter="url(#b8)"><rect x="${W * .06}" y="${H * .3}" width="${W * .16}" height="${H * .2}" rx="10" fill="#E4D5BE"/><rect x="${W * .08}" y="${H * .34}" width="${W * .12}" height="${H * .05}" rx="6" fill="#D8C6AC"/><circle cx="${W * .84}" cy="${H * .5}" r="${H * .1}" fill="#E2D2B8"/><rect x="${W * .8}" y="${H * .6}" width="${W * .09}" height="${H * .1}" fill="#DCCCB2"/></g>
    <rect y="${H * .66}" width="${W}" height="${H * .34}" fill="url(#flr)"/>
    <path d="M${W * .3} ${H * .66} L${W * .14} ${H} M${W * .7} ${H * .66} L${W * .88} ${H}" stroke="#CBB99E" stroke-width="3" opacity=".6"/>
    <line x1="${W * .6}" y1="0" x2="${W * .6}" y2="${H * .16}" stroke="#7A6248" stroke-width="6"/>
    <path d="M${W * .6 - 86} ${H * .16} L${W * .6 + 86} ${H * .16} L${W * .6 + 42} ${H * .27} L${W * .6 - 42} ${H * .27} Z" fill="#C98A5B"/>
    <ellipse cx="${W * .6}" cy="${H * .42}" rx="${W * .17}" ry="${H * .3}" fill="url(#glow)"/>
    ${seatP(W * .42, H * .86, 1.0, '#6D8BC4', { c: 1, ph, pose: 'eat' })}
    <ellipse cx="${W * .62}" cy="${H * .78}" rx="${W * .17}" ry="${H * .05}" fill="#8A6A50"/>
    <ellipse cx="${W * .62}" cy="${H * .775}" rx="${W * .17}" ry="${H * .045}" fill="#96765A"/>
    <rect x="${W * .615}" y="${H * .78}" width="${W * .012}" height="${H * .15}" fill="#7A5F46"/><ellipse cx="${W * .62}" cy="${H * .94}" rx="${W * .05}" ry="${H * .012}" fill="#6E5940"/>
    <ellipse cx="${W * .56}" cy="${H * .77}" rx="${W * .045}" ry="${H * .017}" fill="#fff"/><ellipse cx="${W * .56}" cy="${H * .77}" rx="${W * .03}" ry="${H * .011}" fill="#F1D9A8"/>
    <ellipse cx="${W * .68}" cy="${H * .77}" rx="${W * .045}" ry="${H * .017}" fill="#fff"/><ellipse cx="${W * .68}" cy="${H * .77}" rx="${W * .028}" ry="${H * .01}" fill="#D9B4B4"/>
    <path d="M${W * .73} ${H * .725} h${W * .014} v${-H * .045} h-${W * .014} z" fill="#CFE0EC"/>
    <g filter="url(#b8)" opacity=".85"><ellipse cx="${W * .92}" cy="${H * .92}" rx="${W * .12}" ry="${H * .05}" fill="#8A6A50"/><rect x="${W * .9}" y="${H * .82}" width="${W * .04}" height="${H * .1}" rx="8" fill="#7A6248"/></g>`);
  /* ---- 2 公园 ---- */
  const s2 = ph => svg(DEFS + `<rect width="${W}" height="${H}" fill="url(#sky)"/>
    <circle cx="${W * .8}" cy="${H * .13}" r="${H * .1}" fill="#FFF3CF" opacity=".95"/><ellipse cx="${W * .8}" cy="${H * .13}" rx="${W * .14}" ry="${H * .22}" fill="url(#glow)"/>
    <g filter="url(#b8)">${[.12, .88].map(tx => `<rect x="${W * tx - 16}" y="${H * .3}" width="32" height="${H * .4}" rx="12" fill="#9A7B5C"/><circle cx="${W * tx}" cy="${H * .28}" r="${H * .12}" fill="#A9CB96"/><circle cx="${W * tx - 70}" cy="${H * .36}" r="${H * .085}" fill="#B7D2A8"/><circle cx="${W * tx + 70}" cy="${H * .36}" r="${H * .09}" fill="#9CC28C"/>`).join('')}</g>
    <rect y="${H * .64}" width="${W}" height="${H * .36}" fill="url(#grass)"/>
    <path d="M${W * .05} ${H * .66} Q${W * .5} ${H * .62} ${W * .95} ${H * .66} L${W * .98} ${H * .78} Q${W * .5} ${H * .74} ${W * .02} ${H * .78} Z" fill="#DCD2BE"/>
    ${[.2, .34, .6, .74].map(tx => `<ellipse cx="${W * tx}" cy="${H * (.8 + tx % .2)}" rx="${W * .05}" ry="${H * .014}" fill="#000" opacity=".06"/>`).join('')}
    <rect x="${W * .3}" y="${RY - 421}" width="${W * .36}" height="24" rx="10" fill="#9A7B5C"/><rect x="${W * .3}" y="${RY - 372}" width="${W * .36}" height="18" rx="9" fill="#A9886A"/><rect x="${W * .3}" y="${RY - 324}" width="${W * .36}" height="16" rx="8" fill="#9A7B5C"/>
    <rect x="${W * .26}" y="${RY - 265}" width="${W * .44}" height="13" rx="6" fill="#9A7B5C"/><rect x="${W * .24}" y="${RY - 252}" width="${W * .48}" height="40" rx="9" fill="#8A6A50"/><rect x="${W * .32}" y="${RY - 430}" width="20" height="430" fill="#7A5F46"/><rect x="${W * .63}" y="${RY - 430}" width="20" height="430" fill="#7A5F46"/>
    ${seatP(W * .46, RY, 1.0, '#C96A5B', { c: 0, ph, pose: 'run' })}
    <g filter="url(#b8)"><ellipse cx="${W * .06}" cy="${H * .96}" rx="${W * .12}" ry="${H * .1}" fill="#9CC28C"/><ellipse cx="${W * .94}" cy="${H * .98}" rx="${W * .14}" ry="${H * .09}" fill="#A9CB96"/></g>`);
  /* ---- 3 地铁 ---- */
  const s3 = ph => svg(DEFS + `<rect width="${W}" height="${H}" fill="url(#car)"/>
    <rect x="0" y="0" width="${W}" height="${H * .06}" fill="#C3C9D4"/><rect x="${W * .2}" y="${H * .02}" width="${W * .24}" height="${H * .025}" rx="12" fill="#fff" opacity=".85"/><rect x="${W * .56}" y="${H * .02}" width="${W * .24}" height="${H * .025}" rx="12" fill="#fff" opacity=".85"/>
    <g filter="url(#b4)"><rect x="${W * .14}" y="${H * .12}" width="${W * .72}" height="${H * .24}" rx="14" fill="#C9D2E2" stroke="#AEB7C8" stroke-width="5"/>
    ${[0, 1, 2, 3, 4, 5].map(k => `<rect x="${W * (.16 + k * .12)}" y="${H * .11}" width="${W * .035}" height="${H * .27}" fill="#EAEFF8" opacity=".75" transform="skewX(-16)"/>`).join('')}</g>
    <rect x="0" y="${H * .75}" width="${W}" height="${H * .25}" fill="#B9C0CE"/><rect x="0" y="${H * .75}" width="${W}" height="${H * .04}" fill="#D8B0A0" opacity=".5"/>
    <line x1="${W * .05}" y1="${H * .3}" x2="${W * .95}" y2="${H * .3}" stroke="#7E8798" stroke-width="10" stroke-linecap="round"/>
    <line x1="${W * .16}" y1="${H * .3}" x2="${W * .16}" y2="${H * .75}" stroke="#8A93A6" stroke-width="8"/><line x1="${W * .84}" y1="${H * .3}" x2="${W * .84}" y2="${H * .75}" stroke="#8A93A6" stroke-width="8"/>
    ${[.3, .62, .78].map(t => `<path d="M${W * t} ${H * .3} v${H * .05} l-15 ${H * .045} h30 z" fill="#B0B8C8"/>`).join('')}
    ${standP(W * .5, H * .9, 1.05, '#5E7BA8', ph)}
    <line x1="${W * .72}" y1="0" x2="${W * .72}" y2="${H}" stroke="#98A1B2" stroke-width="14" opacity=".9"/>
    <ellipse cx="${W * .5}" cy="${H * .97}" rx="${W * .12}" ry="${H * .014}" fill="#000" opacity=".08"/>`);
  /* ---- 4 咖啡馆露台 ---- */
  const s4 = ph => svg(DEFS + awning + cafe +
    `<ellipse cx="${W * .2}" cy="${H * .86}" rx="${W * .08}" ry="${H * .016}" fill="#000" opacity=".07"/><ellipse cx="${W * .5}" cy="${H * .82}" rx="${W * .07}" ry="${H * .014}" fill="#000" opacity=".06"/>
    <ellipse cx="${W * .64}" cy="${H * .76}" rx="${W * .14}" ry="${H * .042}" fill="#8A6A50"/>
    <rect x="${W * .634}" y="${H * .76}" width="${W * .012}" height="${H * .14}" fill="#7A5F46"/>
    <path d="M${W * .6} ${H * .705} h${W * .032} v${H * .038} h-${W * .032} z" fill="#fff"/><path d="M${W * .634} ${H * .712} a${W * .011} ${H * .012} 0 1 1 -0.001 0" fill="none" stroke="#fff" stroke-width="5"/>
    ${seatP(W * .4, H * .9, 1.05, '#7B9E7E', { c: 1, ph: ph ? 2 : 0, pose: 'cafe' })}
    <g filter="url(#b8)"><ellipse cx="${W * .07}" cy="${H * .97}" rx="${W * .1}" ry="${H * .09}" fill="#8FB583"/><rect x="${W * .05}" y="${H * .9}" width="${W * .05}" height="${H * .08}" rx="10" fill="#A9886A"/></g>`);
  /* ---- 6 点开 RA ---- */
  const PW = P ? 484 : 904, PH = P ? 812 : 484;
  const PX = P ? [48, 548] : [48, 968], PY = P ? [140, 968] : [48, 548];
  const SC = ph => [s1(ph), s2(ph), s3(ph), s4(ph)];
  const cpill = `<div class="cpill">我想看看 <b>Agent</b>${P ? '<br>' : ' '}干活干得怎么样了</div>`;
  const panel = (i, ph, st, bubH) => `<div class="ipanel" style="left:${PX[i & 1]}px;top:${PY[i >> 1]}px;width:${PW}px;height:${PH}px;${st || ''}">${SC(ph)[i]}${bubH || ''}</div>`;
  S[1] = [panel(0, 0), panel(1, 0), panel(2, 0, 'transform:scale(.72);opacity:.4'), panel(3, 0, 'transform:scale(.72);opacity:.4')].join('');
  S[2] = [0, 1, 2, 3].map(i => panel(i, 0)).join('') + cpill;
  S[3] = [0, 1, 2, 3].map(i => panel(i, 1)).join('');
  S[4] = [0, 1, 2].map(i => panel(i, 0, 'transform:scale(.7);opacity:.28')).join('') + `<div class="ipanel" style="left:40px;top:40px;width:${W - 80}px;height:${H - 80}px;z-index:5">${s4(0)}</div>`;
  const icons = ['#D8DEEA', '#E5D9C8', '#D9E4D9', '#E8D2D2', '#D5DCE8', '#E3D8EA', '#D2E0E4', '#E9E0CE', 'RA', '#DCE2EC', '#E6DBD2', '#D8E3DA'];
  const hsc = `<div class="hscr">${icons.map(c => c === 'RA' ? `<div class="ic ra"><img src="app/ra-icon.svg"></div>` : `<div class="ic" style="background:${c}"></div>`).join('')}</div>`;
  const phoneAt = P ? 'left:203px;top:120px;transform:scale(1.6);transform-origin:0 0' : 'left:750px;top:99px';
  const raC = P ? { x: 203 + 22 + 61 * 1.6, y: 120 + 22 + 300 * 1.6 } : { x: 750 + 14 + 61, y: 99 + 14 + 300 };
  const phx = P ? 203 : 750, phy = P ? 120 : 99, phW = P ? 421 * 1.6 : 421, phH = P ? 882 * 1.6 : 882;
  const povHands = op => svg(DEFS + `<g opacity="${op}">${hand(phx + phW * .06, phy + phH * .86, -24, 0, P ? 1.1 : 1)}${hand(phx + phW * .92, phy + phH * .95, 10, 1, P ? 1.1 : 1)}</g>`);
  const thumb = op => svg(DEFS + `<g opacity="${op}"><ellipse cx="${raC.x + 8}" cy="${raC.y - 4}" rx="30" ry="54" fill="url(#sk)" transform="rotate(-18 ${raC.x + 8} ${raC.y - 4})"/></g>`);
  S[5] = `<div class="blurbg">${svg(DEFS + cafe)}</div>` + povHands(1)
    + phoneShell(hsc + `<div class="rip" style="left:29px;top:263px;width:64px;height:64px"></div>`, phoneAt)
    + thumb(1);
  /* ---- 7 启动 ---- */
  S[6] = `<div class="blurbg" style="opacity:.3">${svg(DEFS + cafe)}</div>` + povHands(.16)
    + phoneShell(`<div class="launchzoom"><img src="app/ra-icon.svg"></div><div class="launchtop"><div class="ov-top"><div class="ov-crumbs"><button type="button">概览</button><i>·</i><span class="ov-scope"><select><option selected>全部电脑</option></select></span></div><button class="ov-menu" type="button" aria-label="菜单"></button></div>`, phoneAt);
  return {
    S: S, SC: SC, s1: s1, s2: s2, s3: s3, s4: s4, panel: panel, cpill: cpill,
    PW: PW, PH: PH, PX: PX, PY: PY, W: W, H: H,
    icons: icons, hsc: hsc, phoneAt: phoneAt, raC: raC,
    povHands: povHands, thumb: thumb, cafe: cafe, DEFS: DEFS, svg: svg,
    miniPh: miniPh, hand: hand, pstat: pstat, phoneShell: phoneShell,
    blurCafe: `<div class="blurbg">${svg(DEFS + cafe)}</div>`,
    seatP: seatP, standP: standP, bub: bub
  };
};
