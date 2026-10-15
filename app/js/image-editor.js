/* Optional attachment editing. The original stays on the desktop until Save succeeds. */
async function openImageEditor(image) {
  if (document.getElementById('imageEditor')) return;
  const source = new Image();
  source.src = image.data;
  await source.decode();
  if (image.sel !== viewSel) return;
  const dialog = document.createElement('dialog');
  dialog.id = 'imageEditor';
  dialog.innerHTML = `<div class="imageEditHeading"><b>编辑图片</b><button data-edit="cancel">取消</button><button data-edit="save">保存</button></div>
    <div class="imageEditTools"><button data-edit="crop" aria-pressed="true">裁剪</button><button data-edit="apply" disabled>应用裁剪</button><button data-edit="rotate">旋转</button><button data-edit="draw" aria-pressed="false">画笔</button><input type="color" value="#ff3333" aria-label="画笔颜色"><button data-edit="reset">重置</button></div>
    <div class="imageEditStage"><canvas aria-label="拖动选择裁剪区域，或切换画笔进行标注"></canvas></div>`;
  const work = document.createElement('canvas'), canvas = dialog.querySelector('canvas');
  const color = dialog.querySelector('input'), apply = dialog.querySelector('[data-edit=apply]');
  let mode = 'crop', start = null, last = null, selection = null;
  const paint = () => {
    canvas.width = work.width; canvas.height = work.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(work, 0, 0);
    if (selection) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(2, work.width / 300);
      ctx.setLineDash([ctx.lineWidth * 4, ctx.lineWidth * 2]);
      ctx.strokeRect(selection.x, selection.y, selection.w, selection.h);
    }
    apply.disabled = !selection || selection.w < 1 || selection.h < 1;
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
  canvas.onpointerdown = e => {
    if (e.isPrimary === false) return;
    e.preventDefault(); canvas.setPointerCapture(e.pointerId);
    start = last = point(e); selection = null;
    if (mode === 'draw') stroke(start, { x: start.x + 0.1, y: start.y });
    paint();
  };
  canvas.onpointermove = e => {
    if (!start || !canvas.hasPointerCapture(e.pointerId)) return;
    const p = point(e);
    if (mode === 'draw') stroke(last, p);
    else selection = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
    last = p; paint();
  };
  canvas.onpointerup = canvas.onpointercancel = () => { start = last = null; };
  dialog.onclick = async e => {
    const button = e.target.closest('[data-edit]');
    if (!button) return;
    const action = button.dataset.edit;
    if (action === 'cancel') return dialog.close();
    if (action === 'crop' || action === 'draw') {
      mode = action; selection = null; paint();
      for (const name of ['crop', 'draw']) dialog.querySelector(`[data-edit=${name}]`).setAttribute('aria-pressed', String(mode === name));
    } else if (action === 'reset') reset();
    else if (action === 'rotate' || action === 'apply') {
      const next = document.createElement('canvas');
      if (action === 'apply') {
        if (!selection || selection.w < 1 || selection.h < 1) return;
        next.width = Math.max(1, Math.round(selection.w)); next.height = Math.max(1, Math.round(selection.h));
        next.getContext('2d').drawImage(work, selection.x, selection.y, selection.w, selection.h, 0, 0, next.width, next.height);
      } else {
        next.width = work.height; next.height = work.width;
        const ctx = next.getContext('2d'); ctx.translate(next.width, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(work, 0, 0);
      }
      work.width = next.width; work.height = next.height;
      work.getContext('2d').drawImage(next, 0, 0); selection = null; paint();
    } else if (action === 'save') {
      if (image.sel !== viewSel) return status('会话已切换，请回到原会话编辑图片', false);
      button.disabled = true;
      try {
        const blob = await new Promise(resolve => work.toBlob(resolve, 'image/png'));
        const file = await shrinkImage(new File([blob], image.name.replace(/\.[^.]+$/, '') + '.png', { type: 'image/png' }));
        const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
        if (image.sel !== viewSel) throw new Error('会话已切换，请回到原会话编辑图片');
        send({ t: 'image', data: data.slice(data.indexOf(',') + 1), type: file.type, name: file.name, replace: image.id, sel: image.sel });
        status('正在保存编辑后的图片…'); dialog.close();
      } catch (error) { status(error.message, false); button.disabled = false; }
    }
  };
  dialog.onclose = () => { dialog.remove(); work.width = work.height = canvas.width = canvas.height = 0; source.src = ''; };
  document.body.appendChild(dialog); reset(); dialog.showModal(); status('');
}
