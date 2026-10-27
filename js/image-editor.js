/* Edits stay local until Save; the desktop original is replaced only after upload. */
async function openImageEditor(image) {
  if (document.getElementById('imageEditor')) return;
  const scope = imageUploadScope();
  const documents = (image.files || [image]).map(file => ({ ...file, ops: [], cursor: 0, crop: null, ratio: 0, zoom: 1, x: 0, y: 0, uploaded: false }));
  const dialog = document.createElement('dialog');
  dialog.id = 'imageEditor';
  dialog.innerHTML = `<div class="imageEditHeading"><button data-edit="cancel">取消上传</button><b>编辑图片</b><button data-edit="more" aria-expanded="false">更多 ⋯</button></div>
    <div class="imageEditNav" ${image.files ? '' : 'hidden'}><button data-edit="prev">‹ 上一张</button><span data-count></span><button data-edit="next">下一张 ›</button></div>
    <div class="imageEditStage"><canvas aria-label="拖动裁剪框边角调整范围，框内拖动位置；双指缩放与移动"></canvas></div>
    <div class="imageEditView"><span class="hint">双指缩放与移动</span><button data-edit="zoomOut" aria-label="缩小">−</button><span data-zoom>100%</span><button data-edit="zoomIn" aria-label="放大">＋</button><button data-edit="fit">适应</button></div>
    <div class="imageEditRatios"><button data-ratio="0" aria-pressed="true">自由</button><button data-ratio="original">原图</button><button data-ratio="1">1:1</button><button data-ratio="1.3333333333333333">4:3</button><button data-ratio="1.7777777777777777">16:9</button></div>
    <div class="imageEditOptions" hidden><label>颜色 <input type="color" value="#ff3333" aria-label="标注颜色"></label><label><span data-size-label>粗细</span> <input type="range" min="1" max="40" value="6" aria-label="画笔粗细"><output>6</output></label><label data-fill hidden><input type="checkbox" aria-label="填充图形">填充</label><input type="text" placeholder="输入标注文字" aria-label="标注文字" hidden></div>
    <div class="imageEditMore" hidden><button data-tool="erase">橡皮擦</button><button data-tool="line">直线</button><button data-tool="arrow">箭头</button><button data-tool="rect">矩形</button><button data-tool="ellipse">圆形</button><button data-tool="text">文字</button><button data-tool="pan">移动</button><button data-edit="rotate">旋转</button><button data-edit="reset">重置原图</button><button data-edit="remove" ${image.files ? '' : 'hidden'}>不上传此张</button></div>
    <div class="imageEditTools"><button data-tool="crop" aria-pressed="true">裁剪</button><button data-tool="draw" aria-pressed="false">画笔</button><button data-edit="undo" disabled>撤销</button><button data-edit="redo" disabled>重做</button></div>
    <button class="primary imageEditSave" data-edit="save">${image.files ? '全部保存并上传' : '保存'}</button>`;
  const stage = dialog.querySelector('.imageEditStage'), canvas = stage.querySelector('canvas');
  stage.oncontextmenu = stage.onselectstart = stage.ondragstart = e => e.preventDefault();
  const base = document.createElement('canvas'), marks = document.createElement('canvas'), merged = document.createElement('canvas');
  const color = dialog.querySelector('[type=color]'), size = dialog.querySelector('[type=range]'), caption = dialog.querySelector('[type=text]');
  const pointers = new Map();
  let index = 0, source, mode = 'crop', gesture = null, pinch = null, preview = null, loading = false, saving = false, cancelled = false;
  const current = () => documents[index];
  const cropFull = () => ({ x: 0, y: 0, w: base.width, h: base.height });
  const release = c => { c.width = c.height = 0; };
  const fullCrop = (c, d = current()) => !c || (c.x === 0 && c.y === 0 && c.w === d.width && c.h === d.height);
  const drawMark = op => {
    const ctx = marks.getContext('2d');
    ctx.save(); ctx.strokeStyle = ctx.fillStyle = op.color; ctx.lineWidth = op.size;
    ctx.lineCap = ctx.lineJoin = 'round';
    if (op.kind === 'draw' || op.kind === 'erase') {
      if (op.kind === 'erase') ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath(); op.points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      if (op.points.length === 1) ctx.lineTo(op.points[0].x + .01, op.points[0].y);
      ctx.stroke();
    } else if (op.kind === 'text') { ctx.font = `${op.size * 4}px sans-serif`; ctx.fillText(op.text, op.a.x, op.a.y); }
    else {
      const { a, b } = op; ctx.beginPath();
      if (op.kind === 'rect') ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
      else if (op.kind === 'ellipse') ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
      else {
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        if (op.kind === 'arrow') { const angle = Math.atan2(b.y - a.y, b.x - a.x), length = op.size * 4; for (const delta of [-.5, .5]) { ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - length * Math.cos(angle + delta), b.y - length * Math.sin(angle + delta)); } }
      }
      if (op.filled && ['rect', 'ellipse'].includes(op.kind)) ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  };
  const transform = op => {
    for (const c of [base, marks]) {
      const next = document.createElement('canvas');
      if (op.kind === 'crop') { const r = op.rect; next.width = Math.max(1, Math.round(r.w)); next.height = Math.max(1, Math.round(r.h)); next.getContext('2d').drawImage(c, r.x, r.y, r.w, r.h, 0, 0, next.width, next.height); }
      else { next.width = c.height; next.height = c.width; const ctx = next.getContext('2d'); ctx.translate(next.width, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(c, 0, 0); }
      c.width = next.width; c.height = next.height; c.getContext('2d').drawImage(next, 0, 0); release(next);
    }
  };
  const textPositions = ops => new Map(ops.filter(op => op.kind === 'moveText').map(op => [op.target, op.a]));
  const rebuild = moving => {
    base.width = marks.width = source.naturalWidth; base.height = marks.height = source.naturalHeight;
    base.getContext('2d').drawImage(source, 0, 0);
    const ops = current().ops.slice(0, current().cursor), positions = textPositions(ops);
    if (moving) positions.set(moving.target, moving.a);
    for (const [index, op] of ops.entries()) {
      if (op.kind === 'reset') { base.width = marks.width = source.naturalWidth; base.height = marks.height = source.naturalHeight; base.getContext('2d').drawImage(source, 0, 0); }
      else if (op.kind === 'crop' || op.kind === 'rotate') transform(op);
      else if (op.kind !== 'moveText') drawMark(op.kind === 'text' && positions.has(index) ? { ...op, a: positions.get(index) } : op);
    }
    current().width = base.width; current().height = base.height;
  };
  const textAt = point => {
    const ops = current().ops.slice(0, current().cursor), positions = textPositions(ops), heights = [];
    let width = source.naturalWidth, height = source.naturalHeight;
    for (const op of ops) {
      heights.push(height);
      if (op.kind === 'crop') { width = Math.max(1, Math.round(op.rect.w)); height = Math.max(1, Math.round(op.rect.h)); }
      else if (op.kind === 'rotate') [width, height] = [height, width];
      else if (op.kind === 'reset') { width = source.naturalWidth; height = source.naturalHeight; }
    }
    const transforms = [];
    const convert = q => transforms.reduce((p, transform) => transform(p), q);
    const tolerance = 6 * base.width / canvas.getBoundingClientRect().width;
    for (let i = ops.length - 1; i >= 0; i--) {
      const op = ops[i];
      if (op.kind === 'reset') break;
      if (op.kind === 'crop') transforms.push(p => ({ x: p.x + op.rect.x, y: p.y + op.rect.y }));
      else if (op.kind === 'rotate') transforms.push(p => ({ x: p.y, y: heights[i] - p.x }));
      else if (op.kind === 'text') {
        const a = positions.get(i) || op.a, p = convert(point), ctx = marks.getContext('2d');
        ctx.font = `${op.size * 4}px sans-serif`;
        const bounds = ctx.measureText(op.text);
        if (p.x >= a.x - bounds.actualBoundingBoxLeft - tolerance && p.x <= a.x + bounds.actualBoundingBoxRight + tolerance
          && p.y >= a.y - bounds.actualBoundingBoxAscent - tolerance && p.y <= a.y + bounds.actualBoundingBoxDescent + tolerance) return { target: i, a, p, convert };
      }
    }
    return null;
  };
  const updateView = () => {
    const d = current(), fit = Math.min(1, stage.clientWidth / base.width, stage.clientHeight / base.height);
    const w = base.width * fit * d.zoom, h = base.height * fit * d.zoom;
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    canvas.style.marginLeft = Math.max(0, (stage.clientWidth - w) / 2) + 'px'; canvas.style.marginTop = Math.max(0, (stage.clientHeight - h) / 2) + 'px';
    stage.scrollLeft = d.x; stage.scrollTop = d.y;
    dialog.querySelector('[data-zoom]').textContent = Math.round(d.zoom * 100) + '%';
  };
  const paint = () => {
    if (canvas.width !== base.width || canvas.height !== base.height) { canvas.width = base.width; canvas.height = base.height; updateView(); }
    const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(base, 0, 0); ctx.drawImage(marks, 0, 0);
    const r = current().crop;
    if (mode === 'crop' && r) {
      ctx.fillStyle = '#0008'; ctx.fillRect(0, 0, canvas.width, r.y); ctx.fillRect(0, r.y + r.h, canvas.width, canvas.height - r.y - r.h); ctx.fillRect(0, r.y, r.x, r.h); ctx.fillRect(r.x + r.w, r.y, canvas.width - r.x - r.w, r.h);
      const scale = base.width / (parseFloat(canvas.style.width) || base.width);
      ctx.strokeStyle = '#fff8'; ctx.lineWidth = scale;
      for (let i = 1; i < 3; i++) { ctx.beginPath(); ctx.moveTo(r.x + r.w * i / 3, r.y); ctx.lineTo(r.x + r.w * i / 3, r.y + r.h); ctx.moveTo(r.x, r.y + r.h * i / 3); ctx.lineTo(r.x + r.w, r.y + r.h * i / 3); ctx.stroke(); }
      ctx.strokeStyle = '#101820'; ctx.lineWidth = scale * 3; ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = scale; ctx.strokeRect(r.x, r.y, r.w, r.h);
      const handle = Math.min(16 * scale, r.w / 5, r.h / 5);
      ctx.beginPath();
      for (const x of [r.x, r.x + r.w]) for (const y of [r.y, r.y + r.h]) { ctx.moveTo(x, y + (y === r.y ? handle : -handle)); ctx.lineTo(x, y); ctx.lineTo(x + (x === r.x ? handle : -handle), y); }
      for (const [x, y, horizontal] of [[r.x + r.w / 2, r.y, true], [r.x + r.w / 2, r.y + r.h, true], [r.x, r.y + r.h / 2, false], [r.x + r.w, r.y + r.h / 2, false]]) { ctx.moveTo(x - (horizontal ? handle / 2 : 0), y - (horizontal ? 0 : handle / 2)); ctx.lineTo(x + (horizontal ? handle / 2 : 0), y + (horizontal ? 0 : handle / 2)); }
      ctx.strokeStyle = '#101820'; ctx.lineWidth = scale * 7; ctx.stroke();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = scale * 4; ctx.stroke();
    }
    dialog.querySelector('[data-edit=undo]').disabled = !current().cursor && fullCrop(current().crop);
    dialog.querySelector('[data-edit=redo]').disabled = current().cursor === current().ops.length && !current().redoCrop;
  };
  const commit = op => { const d = current(); d.redoCrop = null; d.ops.splice(d.cursor); d.ops.push(op); d.cursor++; };
  const applyCrop = () => { if (!fullCrop(current().crop)) { const op = { kind: 'crop', rect: { ...current().crop } }; commit(op); transform(op); } current().width = base.width; current().height = base.height; current().crop = cropFull(); };
  const setMode = value => {
    mode = value;
    if (mode !== 'crop') applyCrop();
    dialog.querySelector('.imageEditRatios').hidden = mode !== 'crop';
    dialog.querySelector('.imageEditOptions').hidden = ['crop', 'pan'].includes(mode);
    caption.hidden = mode !== 'text';
    dialog.querySelector('[data-fill]').hidden = !['rect', 'ellipse'].includes(mode);
    dialog.querySelector('[data-size-label]').textContent = mode === 'text' ? '字号' : '粗细';
    dialog.querySelector('output').value = Number(size.value) * (mode === 'text' ? 4 : 1);
    for (const b of dialog.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === mode));
    paint();
  };
  const load = async next => {
    loading = true; index = next;
    source = new Image(); source.src = current().data; await source.decode();
    if (cancelled) return;
    rebuild(); current().crop ||= cropFull(); updateView(); paint();
    dialog.querySelector('[data-count]').textContent = `${index + 1} / ${documents.length}`;
    dialog.querySelector('[data-edit=prev]').disabled = index === 0;
    dialog.querySelector('[data-edit=next]').disabled = index === documents.length - 1;
    for (const b of dialog.querySelectorAll('[data-ratio]')) b.setAttribute('aria-pressed', String(b.dataset.ratio === String(current().ratio)));
    loading = false;
  };
  const point = (e, clamp = true) => { const r = canvas.getBoundingClientRect(), x = (e.clientX - r.left) * base.width / r.width, y = (e.clientY - r.top) * base.height / r.height; return clamp ? { x: Math.max(0, Math.min(base.width, x)), y: Math.max(0, Math.min(base.height, y)) } : { x, y }; };
  const setZoom = (zoom, center = { x: stage.clientWidth / 2, y: stage.clientHeight / 2 }, anchor) => {
    const r = canvas.getBoundingClientRect(), frame = stage.getBoundingClientRect();
    const x = anchor?.x ?? (frame.left + center.x - r.left) / r.width, y = anchor?.y ?? (frame.top + center.y - r.top) / r.height;
    current().zoom = Math.max(.25, Math.min(8, zoom)); updateView();
    current().x = Math.max(0, x * parseFloat(canvas.style.width) + parseFloat(canvas.style.marginLeft) - center.x);
    current().y = Math.max(0, y * parseFloat(canvas.style.height) + parseFloat(canvas.style.marginTop) - center.y);
    stage.scrollLeft = current().x; stage.scrollTop = current().y; paint();
  };
  const finishGesture = () => {
    if (preview) { commit(preview); preview = null; }
    gesture = null;
  };
  stage.onpointerdown = e => {
    if (loading || saving) return;
    const selection = window.getSelection();
    if (selection && dialog.contains(selection.anchorNode)) selection.removeAllRanges();
    e.preventDefault(); stage.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { preview = null; gesture = null; rebuild(); const [a, b] = [...pointers.values()]; const r = stage.getBoundingClientRect(); const c = canvas.getBoundingClientRect(); pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: current().zoom, anchor: { x: ((a.x + b.x) / 2 - c.left) / c.width, y: ((a.y + b.y) / 2 - c.top) / c.height } }; paint(); return; }
    if (pointers.size !== 1) return;
    const p = point(e, mode !== 'crop'), r = current().crop, tolerance = (e.pointerType === 'touch' ? 32 : 22) * base.width / canvas.getBoundingClientRect().width;
    if (mode === 'text') {
      const hit = textAt(p);
      if (hit) { gesture = { text: hit }; return; }
    }
    if (mode === 'crop') {
      const inX = p.x >= r.x - tolerance && p.x <= r.x + r.w + tolerance, inY = p.y >= r.y - tolerance && p.y <= r.y + r.h + tolerance;
      const edge = { left: inY && Math.abs(p.x - r.x) <= tolerance && p.x <= r.x + r.w / 2, right: inY && Math.abs(p.x - r.x - r.w) <= tolerance && p.x > r.x + r.w / 2, top: inX && Math.abs(p.y - r.y) <= tolerance && p.y <= r.y + r.h / 2, bottom: inX && Math.abs(p.y - r.y - r.h) <= tolerance && p.y > r.y + r.h / 2 };
      if (!Object.values(edge).some(Boolean) && !(p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h)) return;
      current().redoCrop = null;
      gesture = { p, crop: { ...r }, edge, moving: !Object.values(edge).some(Boolean) };
    } else if (mode === 'pan') gesture = { p: { x: e.clientX, y: e.clientY } };
    else {
      preview = { kind: mode, color: color.value, size: Number(size.value) * base.width / canvas.getBoundingClientRect().width, a: p, b: p, points: [p], text: caption.value, filled: dialog.querySelector('[type=checkbox]').checked };
      drawMark(preview); paint(); gesture = { p };
    }
  };
  stage.onpointermove = e => {
    if (!pointers.has(e.pointerId) || loading || saving) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()], r = stage.getBoundingClientRect(); const distance = Math.hypot(a.x - b.x, a.y - b.y), center = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
      setZoom(pinch.zoom * distance / pinch.distance, center, pinch.anchor); return;
    }
    if (!gesture) return;
    const p = point(e, mode !== 'crop');
    if (mode === 'pan') { stage.scrollLeft += gesture.p.x - e.clientX; stage.scrollTop += gesture.p.y - e.clientY; current().x = stage.scrollLeft; current().y = stage.scrollTop; gesture.p = { x: e.clientX, y: e.clientY }; return; }
    if (gesture.text) {
      const hit = gesture.text, q = hit.convert(p);
      preview = { kind: 'moveText', target: hit.target, a: { x: hit.a.x + q.x - hit.p.x, y: hit.a.y + q.y - hit.p.y } };
      rebuild(preview);
    } else if (mode === 'crop') {
      const r = gesture.crop, dx = p.x - gesture.p.x, dy = p.y - gesture.p.y, edge = gesture.edge;
      if (gesture.moving) current().crop = { ...r, x: Math.max(0, Math.min(base.width - r.w, r.x + dx)), y: Math.max(0, Math.min(base.height - r.h, r.y + dy)) };
      else {
        let x = edge.left ? Math.max(0, Math.min(r.x + r.w - 1, r.x + dx)) : r.x;
        let y = edge.top ? Math.max(0, Math.min(r.y + r.h - 1, r.y + dy)) : r.y;
        let w = edge.left ? r.x + r.w - x : edge.right ? Math.max(1, Math.min(base.width - x, r.w + dx)) : r.w;
        let h = edge.top ? r.y + r.h - y : edge.bottom ? Math.max(1, Math.min(base.height - y, r.h + dy)) : r.h;
        if (current().ratio) { const ratio = current().ratio === 'original' ? source.naturalWidth / source.naturalHeight : current().ratio; if (edge.left || edge.right) h = w / ratio; else w = h * ratio; const k = Math.min(1, base.width / w, base.height / h); w *= k; h *= k; if (edge.left) x = r.x + r.w - w; if (edge.top) y = r.y + r.h - h; x = Math.max(0, Math.min(base.width - w, x)); y = Math.max(0, Math.min(base.height - h, y)); }
        current().crop = { x, y, w, h };
      }
    } else if (preview) {
      if (mode === 'draw' || mode === 'erase') { const a = preview.points.at(-1); preview.points.push(p); drawMark({ ...preview, points: [a, p] }); }
      else { rebuild(); preview.b = p; if (mode === 'text') preview.a = p; drawMark(preview); }
    }
    paint();
  };
  stage.onpointerup = e => { pointers.delete(e.pointerId); if (!pinch) finishGesture(); else { gesture = null; preview = null; } pinch = null; paint(); };
  stage.onpointercancel = e => { pointers.delete(e.pointerId); gesture = preview = pinch = null; rebuild(); paint(); };
  stage.onscroll = () => { if (!loading && !cancelled) { current().x = stage.scrollLeft; current().y = stage.scrollTop; } };
  size.oninput = () => { dialog.querySelector('output').value = Number(size.value) * (mode === 'text' ? 4 : 1); };
  const close = () => {
    if (!saving && documents.some(d => d.cursor || (d.crop && !fullCrop(d.crop, d))) && !window.confirm('取消上传并放弃这些图片的编辑？')) return;
    cancelled = true; if (saving) status('已停止后续上传；已提交的图片保留在附件栏'); dialog.close();
  };
  dialog.oncancel = e => { e.preventDefault(); close(); };
  dialog.onclick = async e => {
    const button = e.target.closest('button'); if (!button) return;
    const action = button.dataset.edit;
    if (action === 'cancel') return close();
    if (saving || loading) return;
    finishGesture();
    if (button.dataset.tool) return setMode(button.dataset.tool);
    if (button.dataset.ratio) { current().ratio = button.dataset.ratio === 'original' ? 'original' : Number(button.dataset.ratio); const ratio = current().ratio === 'original' ? source.naturalWidth / source.naturalHeight : current().ratio; let w = base.width, h = base.height; if (ratio) { w = Math.min(w, h * ratio); h = w / ratio; } current().crop = { x: (base.width - w) / 2, y: (base.height - h) / 2, w, h }; for (const b of dialog.querySelectorAll('[data-ratio]')) b.setAttribute('aria-pressed', String(b === button)); paint(); return; }
    if (action === 'more') { const more = dialog.querySelector('.imageEditMore'); more.hidden = !more.hidden; button.setAttribute('aria-expanded', String(!more.hidden)); return; }
    if (action === 'prev' || action === 'next') return load(index + (action === 'next' ? 1 : -1)).catch(err => status(err.message, false));
    if (action === 'remove') { documents.splice(index, 1); if (!documents.length) return close(); return load(Math.min(index, documents.length - 1)); }
    if (action === 'zoomIn' || action === 'zoomOut') return setZoom(current().zoom * (action === 'zoomIn' ? 1.25 : .8));
    if (action === 'fit') { current().zoom = 1; current().x = current().y = 0; updateView(); paint(); return; }
    if (action === 'undo' || action === 'redo') {
      const d = current();
      if (action === 'undo' && !fullCrop(d.crop)) { d.redoCrop = d.crop; d.crop = cropFull(); }
      else if (action === 'redo' && d.redoCrop) { d.crop = d.redoCrop; d.redoCrop = null; }
      else { d.cursor += action === 'undo' ? -1 : 1; rebuild(); d.crop = cropFull(); }
      paint(); return;
    }
    if (action === 'rotate' || action === 'reset') { if (action === 'rotate') applyCrop(); commit({ kind: action }); rebuild(); current().crop = cropFull(); paint(); return; }
    if (action !== 'save') return;
    if (scope !== imageUploadScope() || image.sel !== viewSel) return status('会话已切换，请回到原会话编辑图片', false);
    saving = true; button.disabled = true;
    try {
      for (let n = 0; n < documents.length; n++) {
        if (cancelled || scope !== imageUploadScope() || image.sel !== viewSel) break;
        if (documents[n].uploaded) continue;
        await load(n); if (cancelled) break;
        button.textContent = `正在处理 ${n + 1} / ${documents.length}`;
        applyCrop();
        let file = current().file;
        if (current().cursor || !file) {
          merged.width = base.width; merged.height = base.height; const ctx = merged.getContext('2d'); ctx.drawImage(base, 0, 0); ctx.drawImage(marks, 0, 0);
          const blob = await new Promise(resolve => merged.toBlob(resolve, 'image/png'));
          file = await shrinkImage(new File([blob], current().name.replace(/\.[^.]+$/, '') + '.png', { type: 'image/png' }), merged);
        }
        if (cancelled || scope !== imageUploadScope() || image.sel !== viewSel) break;
        const ok = image.files ? await attachImageFile(file, { sel: image.sel, prepared: !!current().cursor }) : image.onSave ? await image.onSave(file) : await attachImageFile(file, { replace: image.id, sel: image.sel, prepared: true });
        if (!ok) throw new Error('图片未加入上传，请重试'); current().uploaded = true;
      }
      if (!cancelled && documents.every(d => d.uploaded)) { status('图片已加入上传，完成后即可发送'); dialog.close(); }
      else if (!cancelled) status('会话已切换，尚未上传的图片保留在编辑器中', false);
    } catch (error) { if (!cancelled) status(error.message, false); }
    finally { saving = false; button.disabled = false; button.textContent = image.files ? '全部保存并上传' : '保存'; }
  };
  const resize = () => { updateView(); paint(); };
  window.addEventListener('resize', resize);
  dialog.onclose = () => { window.removeEventListener('resize', resize); image.onClose?.(); dialog.remove(); for (const c of [base, marks, merged, canvas]) release(c); source.src = ''; };
  document.body.appendChild(dialog); dialog.showModal();
  try { await load(0); status(''); return true; }
  catch (error) { dialog.close(); throw error; }
}
