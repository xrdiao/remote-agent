/* ---------- screen view ---------- */
const view = $('view'), stage = $('stage'), screen = $('screen');
let visualState = {state: 'idle'}, visualWindows = [], visualWayland = false;
function renderVisualState(m) {
  visualState = m;
  if (mode !== 'screen') return;
  $('visualEmpty').hidden = m.state === 'live';
  $('visualEmpty').textContent = m.message ? I18N.tr(m.message) : I18N.tr('请选择绘图或仿真窗口');
  stage.hidden = m.state !== 'live';
  $('visualTitle').textContent = m.title || I18N.tr('选择窗口');
  $('visualChoose').title = m.title || I18N.tr('选择窗口');
  $('visualStatus').textContent = I18N.tr(({live: '实时', permission: '等待授权', starting: '连接中…', error: '已中断', idle: '未共享'})[m.state] || '未共享');
  $('visualStatus').dataset.state = m.state;
}
function receiveVisualWindows(m) {
  visualWindows = m.windows;
  visualWayland = !!m.wayland;
  $('visualShare').hidden = !visualWayland;
  if (sheetKind === 'visual-windows') showVisualWindows();
}
function showVisualWindows() {
  openSheet('visual-windows', '<h3>绘图与仿真窗口</h3>' + (visualWayland
    ? '<div class="hint">需要在电脑端选择并授权绘图或仿真窗口</div><button class="opt" data-visual-share>请求共享窗口</button>'
    : visualWindows.map(w => `<button class="opt" data-visual-id="${esc(w.id)}">${esc(w.title)}</button>`).join('') || '<div class="hint">没有发现绘图或仿真窗口，请先在电脑端打开。</div>') + '<button class="opt" data-visual-refresh>刷新窗口列表</button>');
}
$('visualChoose').onclick = () => { showVisualWindows(); send({t: 'visualList'}); };
$('visualShare').onclick = () => send({t: 'visualSelect', id: 'select'});
$('visualBack').onclick = () => setMode('chat');
$('sheet').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.hasAttribute('data-visual-refresh')) return send({t: 'visualList'});
  if (b.hasAttribute('data-visual-share') || b.dataset.visualId) {
    closeSheet();
    send({t: 'visualSelect', id: b.dataset.visualId || 'select'});
  }
});

function onFrame(m) {
  if (m.visual && mode !== 'screen') return;
  if (mode === 'screen' && !m.visual) return;
  frame = { w: m.w, h: m.h };
  screen.src = 'data:image/jpeg;base64,' + m.data;
  layoutStage();
}
screen.onload = () => { if (mode !== 'screen') send({ t: 'ack' }); };

const cropRect = () => {
  if (mode === 'terminal') return panel || [0, 0, frame.w, frame.h];
  return [0, 0, frame.w, frame.h];
};

function layoutStage() {
  if (mode !== 'screen' && mode !== 'terminal') return;
  if (mode === 'terminal' && !panel) return;
  const [rx, ry, rw, rh] = cropRect();
  const stageW = (mode === 'screen' ? Math.min(view.clientWidth, view.clientHeight * rw / rh) : view.clientWidth) * zoom;
  const scale = stageW / rw;
  stage.style.width = stageW + 'px';
  stage.style.height = rh * scale + 'px';
  screen.style.width = frame.w * scale + 'px';
  screen.style.left = -rx * scale + 'px';
  screen.style.top = -ry * scale + 'px';
}

// One finger pans the view; two fingers zoom. Visualization windows are read-only.
let gesture = null;
const fingerDist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
const onPicture = () => mode === 'screen';

function setZoom(next, clientX, clientY) {
  const box = view.getBoundingClientRect();
  const ax = (clientX ?? box.left + box.width / 2) - box.left;
  const ay = (clientY ?? box.top + box.height / 2) - box.top;
  const px = ax + view.scrollLeft;
  const py = ay + view.scrollTop;
  const prev = zoom || 1;
  zoom = Math.min(4, Math.max(1, next));
  layoutStage();
  const k = zoom / prev;
  view.scrollLeft = zoom === 1 ? 0 : px * k - ax;
  view.scrollTop = zoom === 1 ? 0 : py * k - ay;
  $('zoom').hidden = mode !== 'screen' && zoom <= 1.01;
  $('visualZoom').textContent = Math.round(zoom * 100) + '%';
}

function remoteWheel(clientX, clientY, dx, dy) {
  view.scrollLeft += dx; view.scrollTop += dy;
}

view.addEventListener('touchstart', e => {
  if (!onPicture() || e.target.closest('button')) return;
  if (e.touches.length >= 2) {
    gesture = { type: 'pinch', d: fingerDist(e.touches[0], e.touches[1]), zoom };
    return;
  }
  const t = e.touches[0];
  gesture = { type: 'drag', x: t.clientX, y: t.clientY, lx: t.clientX, ly: t.clientY, t0: Date.now(), moved: false };
}, { passive: true });
view.addEventListener('touchmove', e => {
  if (!gesture || !onPicture()) return;
  if (gesture.type === 'pinch' && e.touches.length >= 2) {
    e.preventDefault();
    const [a, b] = e.touches;
    const d = fingerDist(a, b) || gesture.d;
    setZoom(gesture.zoom * d / gesture.d, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
    return;
  }
  if (gesture.type !== 'drag' || e.touches.length !== 1) return;
  const t = e.touches[0];
  const dx = t.clientX - gesture.lx;
  const dy = t.clientY - gesture.ly;
  if (Math.hypot(t.clientX - gesture.x, t.clientY - gesture.y) > 8) gesture.moved = true;
  gesture.lx = t.clientX; gesture.ly = t.clientY;
  if (!gesture.moved) return;
  e.preventDefault();
  if (zoom > 1.01) {
    view.scrollLeft -= dx;
    view.scrollTop -= dy;
  } else {
    remoteWheel(t.clientX, t.clientY, -dx, -dy);
  }
}, { passive: false });
view.addEventListener('touchend', e => {
  if (e.touches.length === 0) gesture = null;
  else if (e.touches.length === 1 && gesture?.type === 'pinch') gesture = null;
});
view.addEventListener('touchcancel', () => { gesture = null; });

let mouse = null;
screen.addEventListener('pointerdown', e => {
  if (e.pointerType === 'touch' || !onPicture()) return;
  mouse = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, t0: Date.now(), moved: false };
  screen.setPointerCapture?.(e.pointerId);
});
screen.addEventListener('pointermove', e => {
  if (!mouse || e.pointerType === 'touch') return;
  const dx = e.clientX - mouse.lx, dy = e.clientY - mouse.ly;
  if (Math.hypot(e.clientX - mouse.x, e.clientY - mouse.y) > 4) mouse.moved = true;
  mouse.lx = e.clientX; mouse.ly = e.clientY;
  if (!mouse.moved) return;
  if (zoom > 1.01) { view.scrollLeft -= dx; view.scrollTop -= dy; }
  else remoteWheel(e.clientX, e.clientY, -dx, -dy);
});
screen.addEventListener('pointerup', e => {
  if (!mouse || e.pointerType === 'touch') return;
  mouse = null;
});
screen.addEventListener('pointercancel', () => { mouse = null; });
screen.addEventListener('contextmenu', e => e.preventDefault());

