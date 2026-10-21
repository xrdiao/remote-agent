/* Loaded only after native confirmation of iPhone Duo. No relay protocol or polling. */
let duoSnapshot = null, duoRevision = -1, duoFrame = 0, duoStateKey = '';
let duoReading = null, duoShape = '', duoRestoring = false;
const duoBridge = window.AgentRemoteDuo;
const duoConnContent = document.createElement('div');
duoConnContent.className = 'duoConnContent';
duoConnContent.append(...$('conn').childNodes);
$('conn').append(duoConnContent);

function duoPanel() {
  if (document.getElementById('imageEditor')?.open) return 'image';
  if ($('scanner') && !$('scanner').hidden) return 'scanner';
  if (!$('transfer').hidden) return 'transfer';
  if ($('viewer').classList.contains('open')) return 'viewer';
  if ($('sheet').classList.contains('open')) return 'sheet';
  return '';
}
function reportDuoState() {
  const panel = duoPanel();
  const blocked = !!panel || $('conn').classList.contains('open') || $('gate').classList.contains('open');
  const state = { ready: true, mode, blocked, canClose: ['transfer', 'viewer', 'sheet'].includes(panel) };
  const key = JSON.stringify(state);
  if (key === duoStateKey) return;
  duoStateKey = key;
  duoBridge.report(state);
}
window.addEventListener('agentremote:duo-action', e => {
  if (e.detail?.documentGeneration !== duoBridge.documentGeneration) return;
  const action = e.detail.action, panel = duoPanel();
  if (action === 'close') {
    // Use the actual close handler, preserving dirty edits, history, confirmations, etc.
    if (panel === 'transfer') $('transferClose').click();
    else if (panel === 'viewer') $('vClose').click();
    else if (panel === 'sheet') $('shade').click();
  } else if (!panel && !$('conn').classList.contains('open') && !$('gate').classList.contains('open')) {
    if (action === 'chat' || action === 'terminal') { if (mode !== action) setMode(action); }
    else if (action === 'more') showMainMenu();
    else if (action === 'settings') openSettings();
    else if (action === 'transfer') openTransfer();
  }
  reportDuoState();
});

// Keep the first visible text position, rather than an absolute scrollTop, across reflow.
function rememberDuoReading() {
  const shape = [document.body.clientWidth, document.body.clientHeight, JSON.stringify(duoSnapshot?.reservedRegions)].join(':');
  if (duoShape && shape !== duoShape) return;
  if (duoRestoring || mode !== 'chat') return;
  const box = list.getBoundingClientRect();
  const x = Math.min(box.right - 12, box.left + Math.max(16, box.width * .3));
  const range = document.caretRangeFromPoint?.(x, box.top + 16);
  const textRange = range && itemsEl.contains(range.startContainer) ? range.cloneRange() : null;
  duoReading = { sel: viewSel, stick: followingChat(), anchor: captureChatAnchor(), range: textRange,
    y: textRange ? textRange.getBoundingClientRect().top - box.top : 0 };
}
function restoreDuoReading(saved) {
  if (!saved || saved.sel !== viewSel || mode !== 'chat' || chatTouching || userSelecting()) return;
  if (saved.stick) restoreChatPosition(null, true);
  else if (saved.range?.startContainer.isConnected) {
    restoringChatScroll = true;
    pinnedBottom = false;
    list.scrollTop += saved.range.getBoundingClientRect().top - list.getBoundingClientRect().top - saved.y;
    // Keep the existing history ResizeObserver aligned with the restored text position.
    readingAnchor = captureChatAnchor();
    requestAnimationFrame(() => { restoringChatScroll = false; });
  } else restoreChatPosition(saved.anchor, false);
}
list.addEventListener('scroll', rememberDuoReading, { passive: true });

function fitDuoViewport() {
  const vv = window.visualViewport;
  const focused = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  const scale = duoSnapshot ? window.innerWidth / duoSnapshot.bounds.width : 1;
  const k = duoSnapshot?.keyboard;
  const docked = k && k.width * scale >= window.innerWidth * .75 && (k.y + k.height) * scale >= window.innerHeight - 2;
  const visualKeyboard = vv && Math.abs(vv.scale - 1) < .02 && (vv.offsetTop > 0 || vv.height < window.innerHeight - 80);
  const keyboard = !!focused && !!(k || visualKeyboard);
  let height = window.innerHeight, offset = 0;
  if (focused && docked) height = Math.min(height, k.y * scale);
  if (focused && visualKeyboard) { height = Math.min(height, vv.height); offset = Math.max(0, vv.offsetTop); }
  document.body.style.height = height + 'px';
  document.body.style.transform = offset ? `translateY(${offset}px)` : '';
  document.body.classList.toggle('kb', keyboard);
  document.body.style.setProperty('--duo-visible-height', height + 'px');
  document.body.style.setProperty('--duo-bottom', keyboard && docked ? '0px' : (duoSnapshot?.safeInsets.bottom || 0) * scale + 'px');
  const input = $('text');
  const available = $('listWrap').clientHeight + input.offsetHeight - 72;
  document.body.style.setProperty('--composer-max-height', Math.max(52, Math.floor(Math.min(height * .28, available))) + 'px');
  if (stickOnKeyboard && keyboard) list.scrollTop = list.scrollHeight;
}

// Split only the fixed controls' available rectangle. The chat remains one continuous list.
function duoFreeRect(rect, obstacle) {
  const x = Math.max(rect.x, obstacle.x), y = Math.max(rect.y, obstacle.y);
  const right = Math.min(rect.x + rect.width, obstacle.x + obstacle.width);
  const bottom = Math.min(rect.y + rect.height, obstacle.y + obstacle.height);
  if (x >= right || y >= bottom) return [rect];
  return [
    { x: rect.x, y: rect.y, width: x - rect.x, height: rect.height },
    { x: right, y: rect.y, width: rect.x + rect.width - right, height: rect.height },
    { x: rect.x, y: rect.y, width: rect.width, height: y - rect.y },
    { x: rect.x, y: bottom, width: rect.width, height: rect.y + rect.height - bottom },
  ].filter(r => r.width > 0 && r.height > 0);
}
function fitDuoControls() {
  const body = document.body, safe = duoSnapshot?.safeInsets || {}, scale = duoSnapshot ? window.innerWidth / duoSnapshot.bounds.width : 1;
  const height = body.getBoundingClientRect().height;
  let rects = [{ x: (safe.left || 0) * scale, y: (safe.top || 0) * scale,
    width: window.innerWidth - ((safe.left || 0) + (safe.right || 0)) * scale,
    height: height - ((safe.top || 0) + (body.classList.contains('kb') ? 0 : safe.bottom || 0)) * scale }];
  const obstacles = (duoSnapshot?.reservedRegions || []).filter(r => r.isActive).map(r => ({
    x: r.frame.x * scale, y: r.frame.y * scale, width: r.frame.width * scale, height: r.frame.height * scale,
  }));
  // A floating keyboard doesn't resize the page, but controls must avoid its actual frame.
  const k = duoSnapshot?.keyboard;
  if (k && body.classList.contains('kb') && k.width * scale < window.innerWidth * .75) obstacles.push({ x: k.x * scale, y: k.y * scale, width: k.width * scale, height: k.height * scale });
  for (const r of obstacles) rects = rects.flatMap(area => duoFreeRect(area, r));
  const pane = rects.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!pane) return;
  const set = (name, value) => body.style.setProperty('--duo-' + name, Math.max(0, value) + 'px');
  set('pane-left', pane.x); set('pane-top', pane.y); set('pane-width', pane.width); set('pane-height', pane.height);
  set('pane-right', window.innerWidth - pane.x - pane.width);
  set('pane-bottom', height - pane.y - pane.height);
  const foot = document.querySelector('footer'), box = foot.getBoundingClientRect();
  // Select a bottom area wide enough for the composer; never split its button group.
  const candidates = rects.filter(r => r.width >= Math.min(300, pane.width) && r.height >= Math.min(foot.offsetHeight, pane.height));
  const compose = candidates.sort((a, b) => (b.y + b.height) - (a.y + a.height) || b.width - a.width)[0] || pane;
  const left = Math.max(box.left, compose.x), right = Math.min(box.right, compose.x + compose.width);
  set('compose-left', left - box.left); set('compose-right', box.right - right);
  set('compose-bottom', height - compose.y - compose.height);
  const width = right - left;
  body.classList.toggle('duoNarrowComposer', width < 400);
  const column = $(mode === 'chat' ? 'listWrap' : 'view').getBoundingClientRect();
  const header = document.querySelector('header').getBoundingClientRect();
  let headings = [{ x: column.left, y: header.top, width: column.width, height: header.height }];
  for (const r of obstacles) headings = headings.flatMap(area => duoFreeRect(area, r));
  const heading = headings.filter(r => r.height >= header.height - 1).sort((a, b) => b.width - a.width)[0];
  set('header-left', heading ? heading.x - column.left : 0);
  set('header-width', heading ? heading.width : column.width);
  const barLeft = Math.max(column.left, compose.x), barRight = Math.min(column.right, compose.x + compose.width);
  set('bar-left', barLeft - column.left); set('bar-width', barRight - barLeft);
  set('bar-height', Math.max(44, compose.height - foot.offsetHeight));
}
function applyDuoLayout() {
  duoFrame = 0;
  const saved = duoReading;
  duoRestoring = true;
  if (duoSnapshot) {
    const scale = window.innerWidth / duoSnapshot.bounds.width;
    for (const edge of ['top', 'right', 'bottom', 'left']) document.body.style.setProperty('--duo-' + edge, Math.max(0, duoSnapshot.safeInsets[edge] * scale) + 'px');
    const actions = duoSnapshot.nativeActions || [];
    document.body.classList.toggle('duoNativeMode', actions.includes('chat') && actions.includes('terminal'));
    document.body.classList.toggle('duoNativeMore', actions.includes('more'));
  }
  document.body.classList.toggle('duoUnfolded', duoSnapshot?.hingeState === 'fullyOpen');
  fitOrientation();
  fitDuoViewport();
  fitDuoControls();
  updateComposeCompact();
  queueFitMeters();
  const shape = [document.body.clientWidth, document.body.clientHeight, JSON.stringify(duoSnapshot?.reservedRegions)].join(':');
  if (shape !== duoShape) restoreDuoReading(saved);
  duoShape = shape;
  duoRestoring = false;
  rememberDuoReading();
  reportDuoState();
}
function queueDuoLayout() { if (!duoFrame) duoFrame = requestAnimationFrame(applyDuoLayout); }
window.addEventListener('agentremote:duo-layout', e => {
  const p = e.detail;
  if (p?.version !== 1 || p.duoEligible !== true || p.documentGeneration !== duoBridge.documentGeneration
      || p.revision <= duoRevision || !(p.bounds?.width > 0 && p.bounds?.height > 0)) return;
  duoRevision = p.revision;
  duoSnapshot = p;
  queueDuoLayout();
});
for (const id of ['conn', 'gate', 'sheet', 'viewer', 'transfer', 'scanner']) {
  new MutationObserver(() => { reportDuoState(); queueDuoLayout(); }).observe($(id), { attributes: true, attributeFilter: ['hidden', 'class'] });
}
// Direct children only: opening an image editor changes panel state; streamed chat text does not.
new MutationObserver(() => { reportDuoState(); queueDuoLayout(); }).observe(document.body, { childList: true });
new ResizeObserver(queueDuoLayout).observe(document.querySelector('header'));
new ResizeObserver(queueDuoLayout).observe(document.querySelector('footer'));
window.addEventListener('resize', queueDuoLayout);
window.visualViewport?.addEventListener('resize', queueDuoLayout);
window.visualViewport?.addEventListener('scroll', queueDuoLayout);
document.addEventListener('focusin', queueDuoLayout);
document.addEventListener('focusout', queueDuoLayout);
rememberDuoReading();
reportDuoState();
queueDuoLayout();
