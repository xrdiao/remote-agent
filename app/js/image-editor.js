/* Optional attachment editing. The original stays on the desktop until Save succeeds. */
async function openImageEditor(image) {
  if (document.getElementById('imageEditor')) return;
  const source = new Image();
  source.src = image.data;
  await source.decode();
  if (image.sel !== viewSel) return;
  const dialog = document.createElement('dialog');
  dialog.id = 'imageEditor';
  dialog.innerHTML = `<div class="imageEditHeading"><b>编辑图片</b><button data-edit="cancel">${image.batch ? '跳过此张' : '取消'}</button>${image.onSkip ? '<button data-edit="skip">直接上传此张</button>' : ''}<button data-edit="save">保存</button></div>
    <div class="imageEditTools"><button data-edit="crop" aria-pressed="true">裁剪</button><button data-edit="apply" disabled>应用裁剪</button><button data-edit="rotate">旋转</button><button data-edit="draw" aria-pressed="false">画笔</button><input type="color" value="#ff3333" aria-label="画笔颜色"><button data-edit="undo" disabled>撤销</button><button data-edit="reset">重置</button></div><div class="imageEditTools"><button data-edit="zoomOut" aria-label="缩小">−</button><span data-zoom>100%</span><button data-edit="zoomIn" aria-label="放大">＋</button><button data-edit="fit">适应窗口</button><button data-edit="pan" aria-pressed="false">移动</button></div>
    <div class="imageEditStage"><canvas aria-label="拖动选择裁剪区域，或切换画笔进行标注"></canvas></div>`;
  const work = document.createElement('canvas'), canvas = dialog.querySelector('canvas');
  const color = dialog.querySelector('input'), apply = dialog.querySelector('[data-edit=apply]');
  const stage = dialog.querySelector('.imageEditStage'), undo = dialog.querySelector('[data-edit=undo]');
  const history = [], pointers = new Map();
  let mode = 'crop', start = null, last = null, selection = null, zoom = 1, pinch = null;
  const setZoom = (value, center = { x: stage.clientWidth / 2, y: stage.clientHeight / 2 }) => {
    const old = canvas.getBoundingClientRect(), frame = stage.getBoundingClientRect();
    const x = (frame.left + center.x - old.left) / (old.width || 1);
    const y = (frame.top + center.y - old.top) / (old.height || 1);
    zoom = Math.max(.25, Math.min(8, value));
    const fit = Math.min(1, stage.clientWidth / work.width, stage.clientHeight / work.height);
    const width = work.width * fit * zoom, height = work.height * fit * zoom;
    canvas.style.width = width + 'px'; canvas.style.height = height + 'px';
    canvas.style.marginLeft = Math.max(0, (stage.clientWidth - width) / 2) + 'px';
    canvas.style.marginTop = Math.max(0, (stage.clientHeight - height) / 2) + 'px';
    stage.scrollLeft = x * width + Math.max(0, (stage.clientWidth - width) / 2) - center.x;
    stage.scrollTop = y * height + Math.max(0, (stage.clientHeight - height) / 2) - center.y;
    dialog.querySelector('[data-zoom]').textContent = Math.round(zoom * 100) + '%';
  };
  const remember = () => {
    const copy = document.createElement('canvas'); copy.width = work.width; copy.height = work.height;
    copy.getContext('2d').drawImage(work, 0, 0); history.push(copy);
    if (history.length > 5) { const old = history.shift(); old.width = old.height = 0; }
    undo.disabled = false;
  };
  const paint = () => {
    const resized = canvas.width !== work.width || canvas.height !== work.height;
    canvas.width = work.width; canvas.height = work.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(work, 0, 0);
    if (selection) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(2, work.width / 300);
      ctx.setLineDash([ctx.lineWidth * 4, ctx.lineWidth * 2]);
      ctx.strokeRect(selection.x, selection.y, selection.w, selection.h);
    }
    apply.disabled = !selection || selection.w < 1 || selection.h < 1;
    if (dialog.open && resized) setZoom(zoom);
  };
  const restorePrevious = () => {
    const previous = history.pop();
    if (!previous) return;
    work.width = previous.width; work.height = previous.height; work.getContext('2d').drawImage(previous, 0, 0);
    previous.width = previous.height = 0; selection = null; undo.disabled = !history.length; paint();
  };
  const reset = () => {
    work.width = source.naturalWidth; work.height = source.naturalHeight;
    work.getContext('2d').drawImage(source, 0, 0);
    selection = null; paint();
  };
  const point = e => {
    const r = canvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(work.width, (e.clientX - r.left) * work.width / r.width)), y: Math.max(0, Math.min(work.height, (e.clientY - r.top) * work.height / r.height)) };
  };
  const stroke = (from, to) => {
    const ctx = work.getContext('2d');
    ctx.strokeStyle = color.value; ctx.lineWidth = Math.max(2, work.width / 200);
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
  };
  const transform = action => {
    const next = document.createElement('canvas');
    if (action === 'apply') {
      if (!selection || selection.w < 1 || selection.h < 1) return;
      remember();
      next.width = Math.max(1, Math.round(selection.w)); next.height = Math.max(1, Math.round(selection.h));
      next.getContext('2d').drawImage(work, selection.x, selection.y, selection.w, selection.h, 0, 0, next.width, next.height);
    } else {
      remember(); next.width = work.height; next.height = work.width;
      const ctx = next.getContext('2d'); ctx.translate(next.width, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(work, 0, 0);
    }
    work.width = next.width; work.height = next.height;
    work.getContext('2d').drawImage(next, 0, 0); next.width = next.height = 0;
    selection = null; paint();
  };
  stage.onpointerdown = e => {
    e.preventDefault(); stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      if (mode === 'draw' && start) restorePrevious();
      const [a, b] = [...pointers.values()];
      pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom };
      start = last = null; selection = null; paint(); return;
    }
    if (pointers.size !== 1) return;
    if (mode === 'pan') { last = { x: e.clientX, y: e.clientY }; return; }
    start = last = point(e); selection = null;
    if (mode === 'draw') { remember(); stroke(start, { x: start.x + .1, y: start.y }); }
    paint();
  };
  stage.onpointermove = e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()], r = stage.getBoundingClientRect();
      setZoom(pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance,
        { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top }); return;
    }
    if (mode === 'pan' && last) {
      stage.scrollLeft += last.x - e.clientX; stage.scrollTop += last.y - e.clientY;
      last = { x: e.clientX, y: e.clientY }; return;
    }
    if (!start) return;
    const p = point(e);
    if (mode === 'draw') stroke(last, p);
    else selection = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
    last = p; paint();
  };
  stage.onpointerup = stage.onpointercancel = e => { pointers.delete(e.pointerId); start = last = null; pinch = null; };
  dialog.onclick = async e => {
    const button = e.target.closest('[data-edit]');
    if (!button) return;
    const action = button.dataset.edit;
    if (action === 'cancel') return dialog.close();
    if (action === 'zoomIn' || action === 'zoomOut' || action === 'fit') return setZoom(action === 'fit' ? 1 : zoom * (action === 'zoomIn' ? 1.25 : .8));
    if (action === 'undo') return restorePrevious();
    if (action === 'skip') { button.disabled = true; if (await image.onSkip()) dialog.close(); else button.disabled = false; return; }
    if (action === 'crop' || action === 'draw' || action === 'pan') {
      mode = action; selection = null; paint();
      for (const name of ['crop', 'draw', 'pan']) dialog.querySelector(`[data-edit=${name}]`).setAttribute('aria-pressed', String(mode === name));
    } else if (action === 'reset') { remember(); reset(); }
    else if (action === 'rotate' || action === 'apply') {
      transform(action);
    } else if (action === 'save') {
      if (image.sel !== viewSel) return status('会话已切换，请回到原会话编辑图片', false);
      button.disabled = true;
      if (selection && !apply.disabled) transform('apply');
      try {
        const blob = await new Promise(resolve => work.toBlob(resolve, 'image/png'));
        const file = await shrinkImage(new File([blob], image.name.replace(/\.[^.]+$/, '') + '.png', { type: 'image/png' }), work);
        if (image.sel !== viewSel) throw new Error('会话已切换，请回到原会话编辑图片');
        const accepted = image.onSave ? await image.onSave(file) : await attachImageFile(file, { replace: image.id, sel: image.sel, prepared: true });
        if (!accepted) { button.disabled = false; return; }
        status('正在保存编辑后的图片…'); dialog.close();
      } catch (error) { status(error.message, false); button.disabled = false; }
    }
  };
  const resize = () => setZoom(zoom);
  window.addEventListener('resize', resize);
  dialog.onclose = () => { window.removeEventListener('resize', resize); image.onClose?.(); for (const copy of history) copy.width = copy.height = 0; dialog.remove(); work.width = work.height = canvas.width = canvas.height = 0; source.src = ''; };
  document.body.appendChild(dialog); reset(); dialog.showModal(); setZoom(1); status(''); return true;
}
