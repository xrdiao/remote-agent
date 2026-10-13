/* ---------- screen view ---------- */
const view = $('view'), stage = $('stage'), screen = $('screen');

function onFrame(m) {
  const resized = m.w !== frame.w || m.h !== frame.h;
  frame = { w: m.w, h: m.h };
  screen.src = 'data:image/jpeg;base64,' + m.data;
  layoutStage();
  if (resized) applyQuality();
}
screen.onload = () => send({ t: 'ack' });

const cropRect = () => {
  if (mode === 'terminal') return panel || [0, 0, frame.w, frame.h];
  return crop && panel ? panel : [0, 0, frame.w, frame.h];
};

function layoutStage() {
  if (mode !== 'screen' && mode !== 'terminal') return;
  if (mode === 'terminal' && !panel) return;
  const [rx, ry, rw, rh] = cropRect();
  const stageW = view.clientWidth * zoom;
  const scale = stageW / rw;
  stage.style.width = stageW + 'px';
  stage.style.height = rh * scale + 'px';
  screen.style.width = frame.w * scale + 'px';
  screen.style.left = -rx * scale + 'px';
  screen.style.top = -ry * scale + 'px';
}

let sentWidth = 0;
function applyQuality() {
  if (mode !== 'screen' || !authed) return;
  const [, , rw] = cropRect();
  if (!rw) return;
  // The stream is a photo of the whole window. Ask for enough pixels that the cropped
  // terminal (or chat panel), once stretched to the phone, is about one device pixel per source pixel.
  const cap = mode === 'terminal' ? 4096 : 2560;
  const px = Math.min(cap, Math.round(view.clientWidth * zoom * devicePixelRatio * frame.w / rw));
  if (Math.abs(px - sentWidth) < 40) return;
  sentWidth = px;
  send({ t: 'quality', quality: mode === 'terminal' ? 92 : 70, maxWidth: px });
}

function setCrop(on) {
  crop = on;
  store.set('crop', on ? 'panel' : 'full');
  $('cropPanel').classList.toggle('on', on);
  $('cropFull').classList.toggle('on', !on);
  layoutStage(); applyQuality();
}
$('cropPanel').onclick = () => setCrop(true);
$('cropFull').onclick = () => setCrop(false);

function norm(e) {
  const r = screen.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

function ripple(e) {
  const r = stage.getBoundingClientRect(), el = $('ripple');
  el.style.left = (e.clientX - r.left) + 'px';
  el.style.top = (e.clientY - r.top) + 'px';
  el.style.transition = 'none'; el.style.opacity = 1;
  requestAnimationFrame(() => { el.style.transition = 'opacity .4s'; el.style.opacity = 0; });
}

// One finger scrolls the computer (or pans a zoomed picture). Two fingers zoom the picture.
// A tap still clicks; a long press is a right click.
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
  $('zoom').hidden = zoom <= 1.01;
  applyQuality();
}

function remoteWheel(clientX, clientY, dx, dy) {
  const scale = frame.w / (screen.getBoundingClientRect().width || frame.w);
  const p = norm({ clientX, clientY });
  send({ t: 'wheel', x: p.x, y: p.y, dx: dx * scale * 1.6, dy: dy * scale * 1.6 });
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
  if (gesture?.type === 'drag' && !gesture.moved && e.changedTouches[0]) {
    const t = e.changedTouches[0];
    const p = norm(t);
    send({ t: 'tap', x: p.x, y: p.y, button: Date.now() - gesture.t0 > 550 ? 'right' : 'left' });
    ripple(t);
  }
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
  if (!mouse.moved) {
    const p = norm(e);
    send({ t: 'tap', x: p.x, y: p.y, button: Date.now() - mouse.t0 > 550 ? 'right' : 'left' });
    ripple(e);
  }
  mouse = null;
});
screen.addEventListener('pointercancel', () => { mouse = null; });
screen.addEventListener('contextmenu', e => e.preventDefault());

