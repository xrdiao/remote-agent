/* ---------- mode switching ---------- */
let termState = '';
function updateTermEmpty() {
  const empty = mode === 'terminal' && termState === 'empty';
  $('termEmpty').hidden = !empty;
  $('termText').hidden = !(mode === 'terminal' && termState === 'text');
}
function setMode(m) {
  saveDraft();
  mode = m;
  if (m !== 'terminal') clearTermSelection();
  restoreDraft(); updateTitle();
  store.set('mode', m);
  $('tabChat').classList.toggle('on', m === 'chat');
  $('tabTerm').classList.toggle('on', m === 'terminal');
  $('chatView').classList.toggle('active', m === 'chat');
  $('screenView').classList.toggle('active', m === 'screen' || m === 'terminal');
  $('chatTools').hidden = m !== 'chat';
  $('termTools').hidden = m !== 'terminal';
  $('termToolsLabel').hidden = m !== 'terminal';
  $('screenTools').hidden = m === 'terminal';
  $('screenKeys').hidden = true;
  view.classList.toggle('gesture', m === 'screen');
  document.body.classList.toggle('term', m === 'terminal');
  document.body.classList.toggle('visual', m === 'screen');
  for (const id of ['visualHeader', 'visualCaption', 'visualHint']) $(id).hidden = m !== 'screen';
  $('zoom').hidden = m !== 'screen' && zoom <= 1.01;
  updateAppText();
  document.body.classList.toggle('chatmode', m === 'chat');
  updateSendMode();
  paintGenerationTime();
  if (m !== 'terminal') $('termBusy').hidden = true;
  sentWidth = 0;
  if (authed) send({ t: 'mode', mode: m });
  updateTermEmpty();
  $('visualEmpty').hidden = m !== 'screen' || visualState.state === 'live';
  stage.hidden = m === 'screen' && visualState.state !== 'live';
  if (m === 'screen') { visualState = {state: 'idle', message: I18N.tr('正在查找窗口…')}; renderVisualState(visualState); }
  if (m === 'screen' || m === 'terminal') { layoutStage(); applyQuality(); }
}
$('tabChat').onclick = () => setMode('chat');
$('tabTerm').onclick = () => setMode('terminal');

// Swipe from the terminal back to the chat (left to right). The chat never swipes to the terminal: use the tab.
// A mostly vertical move keeps scrolling.
let swipe = null;
document.querySelector('main').addEventListener('touchstart', e => {
  swipe = null;
  if (e.touches.length !== 1 || mode === 'screen') return;
  if ($('sheet').classList.contains('open') || $('viewer').classList.contains('open') || $('shade').classList.contains('open')) return;
  if (e.target.closest('button, a, input, textarea, select, .codebox')) return;
  const t = e.touches[0];
  swipe = { x: t.clientX, y: t.clientY, target: e.target, locked: '', at: Date.now() };
}, { passive: true });
document.querySelector('main').addEventListener('touchmove', e => {
  if (!swipe || e.touches.length !== 1) return;
  const t = e.touches[0];
  const dx = t.clientX - swipe.x;
  const dy = t.clientY - swipe.y;
  if (swipe.locked || Math.hypot(dx, dy) < 14) return;
  swipe.locked = Math.abs(dx) > Math.abs(dy) * 1.3 ? 'h' : 'v';
}, { passive: true });
document.querySelector('main').addEventListener('touchend', e => {
  const start = swipe;
  swipe = null;
  if (!start || start.locked !== 'h' || !e.changedTouches[0]) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - start.x;
  const dy = t.clientY - start.y;
  if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
  const term = $('termText');
  if (mode === 'terminal' && term.contains(start.target)) {
    if (terminalSelection() || Date.now() - start.at > 450) return;
    if (dx > 0 && term.scrollLeft > 2) return;
    if (dx < 0 && term.scrollLeft + term.clientWidth < term.scrollWidth - 2) return;
  }
  if (dx > 0 && mode === 'terminal') setMode('chat');
});
document.querySelector('main').addEventListener('touchcancel', () => { swipe = null; });

