/* ---------- image and document attachments ---------- */
// Photos from phone cameras are several MB; shrink to something the model can read and the relay accepts.
async function shrinkImage(file, canvas) {
  if (/^image\/(png|jpeg|gif|webp)$/.test(file.type) && file.size < 600e3) return file;
  const bmp = canvas || await createImageBitmap(file);
  let side = 1600, q = 0.85, blob;
  do {
    const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q));
    side *= 0.75; q -= 0.1;
  } while (blob.size > 1.5e6 && q > 0.4);
  if (!canvas) bmp.close();
  return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
}

const imageUploads = new Map(), editableImages = new Map();
let desktopAttachments = [], editBeforeUpload = false, imageBatchScope = '';
const imageUploadScope = () => [currentComputer()?.id || '', viewSel].join('|');
function pendingImageUploads() { return imageBatchScope === imageUploadScope() || [...imageUploads.values()].some(f => f.scope === imageUploadScope() && !f.cancelled); }
function renderAttachments(list) {
  desktopAttachments = list;
  for (const [id, image] of editableImages) {
    if (image.scope !== imageUploadScope() || !list.some(f => f.id === id)) { URL.revokeObjectURL(image.data); editableImages.delete(id); }
  }
  const pending = [...imageUploads.entries()].filter(([, f]) => f.scope === imageUploadScope() && !f.cancelled);
  $('attachments').parentElement.hidden = !list.length && !pending.length;
  $('attachments').innerHTML = list.map(f => { const preview = f.preview || editableImages.get(f.id)?.data; return `<div class="attachment">${preview ? `<img src="${esc(preview)}" alt="">` : ''}${preview ? `<button data-edit-attachment="${esc(f.id)}">编辑</button>` : ''}<span title="${esc(f.name)}">${esc(f.name)}${f.size != null ? ` (${Math.ceil(f.size / 1024)} KB)` : ''}</span><button data-remove-attachment="${esc(f.id)}" aria-label="删除 ${esc(f.name)}">×</button></div>`; }).join('')
    + pending.map(([id, f]) => `<div class="attachment"><img src="${esc(f.preview)}" alt=""><span>${esc(f.name)} · ${f.error ? '上传失败' : '上传中…'}</span><button data-edit-pending-image="${id}">编辑</button>${f.error ? `<button data-retry-image="${id}">重试</button>` : ''}<button data-discard-image="${id}" aria-label="取消上传图片">×</button></div>`).join('');
  updateComposeCompact();
}
// The socket dropped after an image was sent but before the relay's imageDone could
// arrive: mark those uploads failed with a retry button instead of spinning forever.
function markUploadsDisconnected() {
  imageBatchScope = '';
  let dirty = false;
  for (const f of imageUploads.values()) if (f.sent && !f.error && !f.cancelled) { f.error = true; dirty = true; }
  if (dirty) renderAttachments(desktopAttachments);
}
function finishImageUpload(m) {
  const file = imageUploads.get(m.clientImageId);
  if (!file) return;
  file.attachmentId = m.attachmentId;
  if (m.ok) {
    if (file.cancelled && !m.cancelled && m.attachmentId && file.scope === imageUploadScope()) send({ t: 'removeAttachment', id: m.attachmentId });
    else if (file.editedFile && m.attachmentId && file.scope === imageUploadScope()) attachImageFile(file.editedFile, { sel: file.options.sel || viewSel, replace: m.attachmentId, prepared: true });
    if (m.attachmentId && file.scope === imageUploadScope() && desktopAttachments.some(f => f.id === m.attachmentId)) {
      const previous = editableImages.get(m.attachmentId);
      if (previous) URL.revokeObjectURL(previous.data);
      editableImages.set(m.attachmentId, { data: URL.createObjectURL(file.uploadFile), name: file.uploadFile.name, scope: file.scope });
    }
    URL.revokeObjectURL(file.preview); imageUploads.delete(m.clientImageId);
  }
  else if (file.cancelled) { URL.revokeObjectURL(file.preview); imageUploads.delete(m.clientImageId); }
  else file.error = true;
  renderAttachments(desktopAttachments);
}
$('attachments').onclick = e => {
  const retry = e.target.closest('[data-retry-image]');
  if (retry) {
    const record = imageUploads.get(retry.dataset.retryImage);
    URL.revokeObjectURL(record.preview); imageUploads.delete(retry.dataset.retryImage);
    return attachImageFile(record.editedFile || record.file, record.editedFile ? { ...record.options, prepared: true } : record.options);
  }
  const discard = e.target.closest('[data-discard-image]');
  if (discard) {
    const file = imageUploads.get(discard.dataset.discardImage);
    file.cancelled = true;
    file.reader?.abort();
    if (file.sent) send({ t: 'cancelImage', clientImageId: discard.dataset.discardImage });
    status('已取消这张图片上传');
    if (file.error) { URL.revokeObjectURL(file.preview); imageUploads.delete(discard.dataset.discardImage); }
    return renderAttachments(desktopAttachments);
  }
  const pendingEdit = e.target.closest('[data-edit-pending-image]');
  if (pendingEdit) {
    const file = imageUploads.get(pendingEdit.dataset.editPendingImage), sel = viewSel;
    return openImageEditor({ data: file.preview, file: file.editedFile || file.file, name: file.name, sel, onSave: async edited => {
      if (file.cancelled) return false;
      if (file.attachmentId) return attachImageFile(edited, { sel, replace: file.attachmentId, prepared: true });
      file.editedFile = edited;
      URL.revokeObjectURL(file.preview); file.preview = URL.createObjectURL(edited);
      renderAttachments(desktopAttachments); return true;
    } }).catch(e => status(e.message, false));
  }
  const edit = e.target.closest('[data-edit-attachment]');
  if (edit && editableImages.has(edit.dataset.editAttachment)) {
    return openImageEditor({ ...editableImages.get(edit.dataset.editAttachment), id: edit.dataset.editAttachment, sel: viewSel }).catch(e => status(e.message, false));
  }
  if (edit) { status('正在读取原图…'); return send({ t: 'editImage', id: edit.dataset.editAttachment, sel: viewSel }); }
  const b = e.target.closest('[data-remove-attachment]');
  if (b) send({ t: 'removeAttachment', id: b.dataset.removeAttachment });
};
$('uploadDoc').onclick = () => $('docFile').click();
$('img').title = $('img').ariaLabel = '上传图片';
$('img').onclick = () => {
  openSheet('image-upload', '<h3>选择图片</h3><button class="opt" data-image-choice="direct">直接上传</button><button class="opt" data-image-choice="edit">编辑后上传</button>');
  for (const button of $('sheet').querySelectorAll('[data-image-choice]')) button.onclick = () => { editBeforeUpload = button.dataset.imageChoice === 'edit'; closeSheet(); $('imgFile').click(); };
};
async function uploadDocument(file, sel) {
  const target = base, path = '/api/upload?name=' + encodeURIComponent(file.name) + '&sel=' + encodeURIComponent(sel);
  const headers = await entryHeaders(currentComputer(), 'POST', path);
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', target + path);
    for (const [key, value] of Object.entries(headers)) request.setRequestHeader(key, value);
    request.setRequestHeader('content-type', 'application/octet-stream');
    request.timeout = 60000;
    request.upload.onprogress = e => { if (e.lengthComputable) status(`正在上传 ${file.name} ${Math.round(e.loaded / e.total * 100)}%`); };
    request.onload = () => {
      try { const result = JSON.parse(request.responseText); if (request.status !== 200) throw new Error(result.error); resolve(result); }
      catch (error) { reject(error); }
    };
    request.onerror = () => reject(new Error('文件上传失败'));
    request.ontimeout = () => reject(new Error('文件上传超时'));
    request.send(file);
  });
}
async function attachDocumentFile(file) {
  if (file.size > 20 * 1024 * 1024) return status('文件不能超过 20 MB', false);
  const sel = viewSel;
  status('正在上传文件…');
  try {
    await uploadDocument(file, sel);
    if (sel === viewSel) send({ t: 'attachments' });
    status('文件已上传，写好文字后点发送');
  } catch (error) { status(error.name === 'AbortError' ? '文件上传超时' : error.message, false); }
}
$('docFile').onchange = async () => {
  const file = $('docFile').files[0];
  $('docFile').value = '';
  if (file) await attachDocumentFile(file);
};
async function attachImageFile(file, options = {}) {
  const sel = options.sel || viewSel, scope = imageUploadScope();
  if (sel !== viewSel) { status('会话已切换，请重新选择图片', false); return false; }
  const id = crypto.randomUUID();
  imageUploads.set(id, { file, name: file.name, scope, preview: URL.createObjectURL(file), options });
  renderAttachments(desktopAttachments);
  status('正在处理图片…');
  try {
    const img = options.prepared ? file : await shrinkImage(file);
    const record = imageUploads.get(id);
    if (record.cancelled) { URL.revokeObjectURL(record.preview); imageUploads.delete(id); return true; }
    record.uploadFile = img;
    const url = await new Promise((res, rej) => { const r = new FileReader(); record.reader = r; r.onload = () => res(r.result); r.onerror = rej; r.onabort = () => res(null); r.readAsDataURL(img); });
    if (record.cancelled) { URL.revokeObjectURL(record.preview); imageUploads.delete(id); return true; }
    if (scope !== imageUploadScope()) throw new Error('会话已切换，请回到原会话重试上传');
    if (!authed || ws?.readyState !== 1) throw new Error('连接已断开，请重新连接后重试');
    record.reader = null;
    record.sent = true;
    send({ t: 'image', data: url.slice(url.indexOf(',') + 1), name: img.name, type: img.type, sel, replace: options.replace || '', clientImageId: id });
    return true;
  } catch (error) {
    const cancelled = imageUploads.get(id)?.cancelled;
    finishImageUpload({ clientImageId: id, ok: false });
    if (cancelled) return true;
    status(error.message || '读不了这张图片，换一张试试', false);
    return false;
  }
}
// Older Android app builds drop multi-select picks (ClipData) entirely; give them a single-file picker.
if (/Android/.test(navigator.userAgent) && window.AgentRemoteApp && typeof window.AgentRemoteApp.multiPick !== 'function') $('imgFile').multiple = false;
$('imgFile').onchange = async () => {
  const files = [...$('imgFile').files], edit = editBeforeUpload;
  $('imgFile').value = ''; editBeforeUpload = false;
  if (!files.length) return;
  const sel = viewSel, scope = imageUploadScope();
  imageBatchScope = scope;
  try {
    if (!edit) {
      for (const file of files) { if (scope !== imageUploadScope()) break; await attachImageFile(file, { sel }); }
    } else {
      const images = files.map(file => ({ file, name: file.name, data: URL.createObjectURL(file) }));
      try {
        await new Promise((resolve, reject) => {
          openImageEditor({ files: images, sel, onClose: resolve }).then(opened => { if (!opened) resolve(); }).catch(reject);
        });
      } finally { for (const image of images) URL.revokeObjectURL(image.data); }
    }
  } catch (error) { status(error.message, false); }
  finally { if (imageBatchScope === scope) imageBatchScope = ''; }
};
text.addEventListener('paste', async e => {
  const files = [...e.clipboardData.files];
  if (!files.length) return;
  e.preventDefault();
  const value = e.clipboardData.getData('text/plain');
  if (value) {
    text.setRangeText(value, text.selectionStart, text.selectionEnd, 'end');
    text.dispatchEvent(new Event('input', { bubbles: true }));
  }
  for (const file of files) {
    if (file.type.startsWith('image/')) await attachImageFile(file);
    else await attachDocumentFile(file);
  }
});

window.addEventListener('resize', () => { layoutStage(); applyQuality(); });
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});

setMode(mode);
boot();
