/* ---------- voice input ---------- */
// Android WebView has no Web Speech API, so the app uses the system recognizer through the bridge instead.
document.body.classList.toggle('voice', store.get('voice') === 'on');
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
const addVoiceText = s => {
  text.value += (text.value && !/\s$/.test(text.value) && /^\w/.test(s) ? ' ' : '') + s;
  autosize();
};
window.onVoice = s => { $('mic').classList.remove('on'); s ? (addVoiceText(s), status('')) : status('没听清，再试一次', false); };
// Photos from phone cameras are several MB; shrink to something the model can read and the relay accepts.
async function shrinkImage(file) {
  if (/^image\/(png|jpeg|gif|webp)$/.test(file.type) && file.size < 600e3) return file;
  const bmp = await createImageBitmap(file);
  let side = 1600, q = 0.85, blob;
  do {
    const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q));
    side *= 0.75; q -= 0.1;
  } while (blob.size > 1.5e6 && q > 0.4);
  return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
}

function renderAttachments(list) {
  $('attachments').innerHTML = list.map(f => `<div class="attachment">${f.preview ? `<img src="${esc(f.preview)}" alt="">` : ''}${f.preview ? `<button data-edit-attachment="${esc(f.id)}">编辑</button>` : ''}<span title="${esc(f.name)}">${esc(f.name)}${f.size != null ? ` (${Math.ceil(f.size / 1024)} KB)` : ''}</span><button data-remove-attachment="${esc(f.id)}" aria-label="删除 ${esc(f.name)}">×</button></div>`).join('');
}
$('attachments').onclick = e => {
  const edit = e.target.closest('[data-edit-attachment]');
  if (edit) { status('正在读取原图…'); return send({ t: 'editImage', id: edit.dataset.editAttachment, sel: viewSel }); }
  const b = e.target.closest('[data-remove-attachment]');
  if (b) send({ t: 'removeAttachment', id: b.dataset.removeAttachment });
};
$('uploadDoc').onclick = () => $('docFile').click();
$('img').title = $('img').ariaLabel = '上传图片';
$('img').onclick = () => $('imgFile').click();
function uploadDocument(file, sel) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', base + '/api/upload?name=' + encodeURIComponent(file.name) + '&sel=' + encodeURIComponent(sel));
    request.setRequestHeader('authorization', 'Bearer ' + store.get('token'));
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
async function attachImageFile(file) {
  status('正在处理图片…');
  try {
    const img = await shrinkImage(file);
    const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(img); });
    send({ t: 'image', data: url.slice(url.indexOf(',') + 1), name: img.name, type: img.type });
  } catch {
    status('读不了这张图片，换一张试试', false);
  }
}
$('imgFile').onchange = async () => {
  const file = $('imgFile').files[0];
  $('imgFile').value = '';
  if (file) await attachImageFile(file);
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

$('mic').onclick = () => {
  if (window.AgentRemoteApp?.voice) {
    if (!window.AgentRemoteApp.voice(I18N.speech)) return status('手机上没有语音识别服务，可以用输入法键盘上的麦克风', false);
    $('mic').classList.add('on');
    return status('请说话…');
  }
  if (inApp) return status('更新安卓 App 后可用语音输入，也可以用输入法键盘上的麦克风', false);
  if (!Recognition) return status('这个浏览器不支持语音识别，可以用输入法键盘上的麦克风', false);
  if (recognizer) return recognizer.stop();
  const before = text.value;
  recognizer = new Recognition();
  recognizer.lang = I18N.speech;
  recognizer.interimResults = true;
  recognizer.onresult = e => {
    text.value = before;
    addVoiceText([...e.results].map(r => r[0].transcript).join(''));
  };
  recognizer.onerror = e => status(
    e.error === 'not-allowed' || e.error === 'service-not-allowed' ? '没有麦克风权限'
      : e.error === 'network' ? '语音识别连不上服务器（国内网络常见），可以用输入法键盘上的麦克风'
      : e.error === 'no-speech' ? '没听清，再试一次' : e.error, false);
  recognizer.onend = () => { recognizer = null; $('mic').classList.remove('on'); };
  recognizer.start();
  $('mic').classList.add('on');
  status('请说话…（再点一下结束）');
};

window.addEventListener('resize', () => { layoutStage(); applyQuality(); });
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});

setMode(mode);
boot();
