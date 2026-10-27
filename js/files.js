/* ---------- file viewer ---------- */
$('vBody').classList.toggle('wrap', store.get('wrap') !== 'off');
$('vWrap').classList.toggle('on', store.get('wrap') !== 'off');

let viewing = null;
let editing = false;
let editBase = '', saving = null;
let fileRequestId = 0, saveRequestId = 0, saveTimer = 0;
let filePdf = null;
let readingFile = null;
function finishFileRead() {
  clearTimeout(readingFile?.timer);
  readingFile = null;
}
function failFileRead(message) {
  if (!readingFile) return;
  const name = readingFile.name;
  fileRequestId++;
  finishFileRead();
  showFile({ name, error: message });
}
function dirtyEdit() {
  const box = $('vEditBox');
  return editing && box && box.value !== editBase;
}
function stopVideo() {
  if (filePdf) {
    filePdf.controller.abort();
    filePdf.render?.cancel();
    filePdf.task?.destroy();
    filePdf = null;
  }
  const video = $('vBody').querySelector('video');
  if (video) { video.onerror = null; video.pause(); video.removeAttribute('src'); video.load(); }
}
// Keep gestures local to this preview; the original media source and controls are unchanged.
function videoGestures(video) {
  const preview = document.createElement('div');
  preview.className = 'videoPreview';
  const tools = document.createElement('div');
  tools.className = 'videoViewTools';
  const hint = document.createElement('span');
  hint.textContent = '双指缩放与移动';
  const fit = document.createElement('button');
  fit.textContent = '适应';
  const stage = document.createElement('div');
  stage.className = 'videoViewStage';
  tools.append(hint, fit);
  stage.append(video);
  preview.append(tools, stage);
  let zoom = 1, x = 0, y = 0, gesture = null;
  const pointers = new Map();
  const paint = () => {
    const limitX = video.clientWidth * (zoom - 1) / 2;
    const limitY = video.clientHeight * (zoom - 1) / 2;
    x = Math.max(-limitX, Math.min(limitX, x));
    y = Math.max(-limitY, Math.min(limitY, y));
    video.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
  };
  const begin = () => {
    const points = [...pointers.values()];
    if (points.length === 2) {
      const [a, b] = points;
      const rect = stage.getBoundingClientRect();
      gesture = { zoom, distance: Math.hypot(a.x - b.x, a.y - b.y),
        anchorX: ((a.x + b.x) / 2 - rect.left - rect.width / 2 - x) / zoom,
        anchorY: ((a.y + b.y) / 2 - rect.top - rect.height / 2 - y) / zoom };
    } else gesture = points.length === 1 ? { point: points[0], x, y } : null;
  };
  stage.onpointerdown = e => {
    // Let the native playback/seek/fullscreen bar handle its own touches.
    if (video.tagName === 'VIDEO' && e.clientY >= stage.getBoundingClientRect().bottom - 52) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (zoom > 1 || pointers.size > 1) {
      e.preventDefault();
      stage.setPointerCapture(e.pointerId);
    }
    begin();
  };
  stage.onpointermove = e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && gesture?.distance) {
      e.preventDefault();
      const [a, b] = [...pointers.values()];
      const rect = stage.getBoundingClientRect();
      zoom = Math.max(1, Math.min(8, gesture.zoom * Math.hypot(a.x - b.x, a.y - b.y) / gesture.distance));
      x = (a.x + b.x) / 2 - rect.left - rect.width / 2 - gesture.anchorX * zoom;
      y = (a.y + b.y) / 2 - rect.top - rect.height / 2 - gesture.anchorY * zoom;
      paint();
    } else if (pointers.size === 1 && gesture?.point && zoom > 1) {
      e.preventDefault();
      x = gesture.x + e.clientX - gesture.point.x;
      y = gesture.y + e.clientY - gesture.point.y;
      paint();
    }
  };
  const end = e => { pointers.delete(e.pointerId); begin(); };
  stage.onpointerup = end;
  stage.onpointercancel = end;
  stage.onlostpointercapture = end;
  fit.onclick = () => { pointers.clear(); gesture = null; zoom = 1; x = y = 0; paint(); };
  return preview;
}
function openChatImage(source) {
  fileRequestId++;
  finishFileRead();
  finishFileSave();
  returnToEditor = null;
  stopVideo(); leaveEdit();
  $('vStatus').hidden = true;
  $('vChanges').hidden = true;
  if (!$('viewer').classList.contains('open')) {
    $('viewer').classList.add('open');
    history.pushState({ viewer: true }, '');
  }
  showFile({ name: '图片', image: source });
  $('vWrap').hidden = true;
  const image = $('vBody').querySelector('img');
  image.draggable = false;
  const preview = videoGestures(image);
  preview.classList.add('chatImagePreview');
  $('vBody').replaceChildren(preview);
}
function leaveEdit() {
  editing = false;
  $('vBody').classList.remove('editing');
  $('vEdit').textContent = '编辑';
  $('vWrap').hidden = false;
  $('vFind').hidden = false;
  $('vTools').hidden = true;
  $('vSearch').hidden = true;
}
function openFile(ref, fromEditor = false, diff = '', fromChanges = false) {
  const requestId = ++fileRequestId;
  finishFileRead();
  finishFileSave();
  returnToEditor = fromEditor ? { ...editorDirectory } : null;
  stopVideo();
  leaveEdit();
  viewing = null;
  $('vStatus').hidden = true;
  vOnly = false;
  vExpand.clear();
  $('vTools').hidden = true;
  $('vChanges').hidden = true;
  $('vEdit').hidden = true;
  $('vName').textContent = ref.split('/').pop();
  $('vPath').textContent = '';
  $('vBody').innerHTML = '<div class="note">正在从电脑读取…</div>';
  if (!$('viewer').classList.contains('open')) {
    $('viewer').classList.add('open');
    history.pushState({ viewer: true }, '');
  }
  readingFile = { name: ref.split('/').pop(), timer: setTimeout(() => failFileRead('文件读取结果尚未返回，请重试'), 30000) };
  if (!send({ t: 'file', path: ref, diff, requestId, ...(fromChanges ? { changes: true } : {}) })) failFileRead('未连接，文件未读取，请重试');
}

function showFile(m) {
  if (!$('viewer').classList.contains('open') || m.loading) return;
  finishFileRead();
  stopVideo();
  leaveEdit();
  viewing = m.text != null ? m : null;
  $('vFind').hidden = m.text == null;
  $('vEdit').hidden = !m.editable;
  $('vEdit').disabled = Boolean(saving);
  $('vName').textContent = m.name || '';
  // Leading LRM keeps the rtl ellipsis from reordering the path's slashes.
  $('vPath').textContent = m.path ? '\u200e' + (m.host ? m.host + ':' : '') + m.path + (m.size != null ? ` · ${fmtSize(m.size)}` : '') : '';
  const body = $('vBody');
  if (m.error) {
    body.innerHTML = `<div class="note err">${esc(m.error)}</div><div class="note">${esc(appMessage('可以切到「画面」在 {app} 里打开'))}</div>`;
    return;
  }
  if (m.video) {
    $('vWrap').hidden = true;
    body.innerHTML = '';
    const video = document.createElement('video');
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.src = base + m.video;
    video.onerror = () => {
      const note = document.createElement('div');
      note.className = 'note err';
      note.textContent = '视频无法播放，请重新打开；若仍失败，请检查网络或视频编码。';
      body.append(note);
    };
    body.append(videoGestures(video));
    return;
  }
  if (m.pdf) {
    $('vWrap').hidden = true;
    body.innerHTML = '<div class="note">正在从电脑读取…</div>';
    const requestId = fileRequestId;
    const state = filePdf = { controller: new AbortController(), task: null, render: null };
    const failed = error => {
      if (state.controller.signal.aborted || requestId !== fileRequestId) return;
      body.innerHTML = `<div class="note err">${esc(error.message)}</div>`;
    };
    (async () => {
      const [pdfjs, response] = await Promise.all([
        import('../pdfjs/pdf-6.4.299.min.mjs'),
        fetch(base + m.pdf, { signal: state.controller.signal, cache: 'no-store' }),
      ]);
      if (!response.ok) throw new Error('PDF 读取失败 (' + response.status + ')');
      const data = new Uint8Array(await response.arrayBuffer());
      if (state.controller.signal.aborted || requestId !== fileRequestId) return;
      const asset = name => new URL('pdfjs/' + name, document.baseURI).href;
      pdfjs.GlobalWorkerOptions.workerSrc = asset('pdf.worker-6.4.299.min.mjs');
      state.task = pdfjs.getDocument({ data, cMapUrl: asset('cmaps/'), cMapPacked: true,
        standardFontDataUrl: asset('standard_fonts/'), wasmUrl: asset('wasm/'), isEvalSupported: false });
      const pdf = await state.task.promise;
      if (state.controller.signal.aborted || requestId !== fileRequestId) return;
      const toolbar = document.createElement('div');
      toolbar.className = 'pdfPager';
      toolbar.innerHTML = `<button data-pdf-prev>${I18N.tr('上一页')}</button><span aria-live="polite"></span><button data-pdf-next>${I18N.tr('下一页')}</button>`;
      const previous = toolbar.querySelector('[data-pdf-prev]'), next = toolbar.querySelector('[data-pdf-next]'), counter = toolbar.querySelector('span');
      const pageBox = document.createElement('div'), canvas = document.createElement('canvas');
      pageBox.className = 'pdfPage';
      pageBox.append(canvas);
      body.replaceChildren(toolbar, pageBox);
      let number = 1;
      const draw = async pageNumber => {
        previous.disabled = next.disabled = true;
        const page = await pdf.getPage(pageNumber);
        if (state.controller.signal.aborted) return;
        const size = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: pageBox.clientWidth / size.width });
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.ceil(viewport.width * ratio);
        canvas.height = Math.ceil(viewport.height * ratio);
        const render = state.render = page.render({ canvasContext: canvas.getContext('2d'), viewport,
          transform: [ratio, 0, 0, ratio, 0, 0] });
        await render.promise;
        if (state.controller.signal.aborted) return;
        state.render = null;
        number = pageNumber;
        counter.textContent = `${number} / ${pdf.numPages}`;
        previous.disabled = number === 1;
        next.disabled = number === pdf.numPages;
        body.scrollTop = 0;
      };
      previous.onclick = () => draw(number - 1).catch(failed);
      next.onclick = () => draw(number + 1).catch(failed);
      await draw(1);
    })().catch(failed);
    return;
  }
  if (m.image) {
    body.innerHTML = '';
    const img = new Image();
    img.src = m.image;
    body.append(img);
    return;
  }
  renderFileCode(m);
}

// ---- themed code view ----
// Palette colours come from the relay; only strict hex is allowed into style.
const HL_HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const hcol = v => typeof v === 'string' && HL_HEX.test(v) ? v : null;
let vMarks = null, vMarkLine = [], vOnly = false, vExpand = new Set(), vIdx = -1;
function renderFileCode(m) {
  const body = $('vBody');
  const hl = m.hl?.theme ? m.hl : null;
  const pal = (hl?.palette || []).map(hcol);
  const col = k => hcol(hl?.theme?.[k]);
  vMarks = m.marks || null;
  const A = new Set(vMarks?.add || []), M = new Set(vMarks?.mod || []), D = new Set(vMarks?.del || []);
  vMarkLine = [...new Set([...A, ...M, ...D])].sort((a, b) => a - b);
  vIdx = -1;
  $('vChanges').hidden = !vMarks && !m.newFile;
  $('vOnly').classList.toggle('on', vOnly);
  $('vChangeCount').textContent = vMarkLine.length ? `–/${vMarkLine.length}` : '';
  $('vSrc').textContent = m.newFile
    ? (m.markSource === 'commit' ? `提交 ${m.commit} 新增的文件` : '新文件')
    : vMarks ? (m.markSource === 'agent' ? 'Agent 的改动' : m.markSource === 'commit' ? `提交 ${m.commit} 的改动${m.subject ? ` · ${String(m.subject).slice(0, 40)}` : ''}` : '对比 Git') : '';
  const near = n => !vOnly || vMarkLine.some(k => Math.abs(k - n) <= 3);
  const src = hl ? hl.lines : m.text.replace(/\n$/, '').split('\n').map(l => [[l, -1, 0]]);
  const vars = [
    hl ? `background:${col('bg') || 'var(--pre-bg)'};color:${col('fg') || 'inherit'}` : '',
    `--ga:${col('gutterAdd') || '#2ea043'}`, `--gm:${col('gutterMod') || '#3b8eea'}`, `--gd:${col('gutterDel') || '#f14c4c'}`,
    `--ab:${col('addBg') || 'rgba(46,160,67,.15)'}`, `--mb:${col('modBg') || 'rgba(59,142,234,.15)'}`,
    `--ln:${col('lineNo') || ''}`, `--sel:${col('selection') || ''}`,
  ].filter(Boolean).join(';');
  const code = document.createElement('div');
  code.className = 'code';
  code.style.cssText = vars;
  const toks = (t2) => t2.map(([t, pi, bits]) => {
    const c = pi >= 0 ? pal[pi] : null;
    const cls = 'tok' + (bits & 1 ? ' b' : '') + (bits & 2 ? ' i' : '') + (bits & 4 ? ' u' : '');
    return `<span class="${cls}"${c ? ` style="color:${c}"` : ''}>${esc(t)}</span>`;
  }).join('');
  const lineHtml = n => `<div class="l${n === m.line ? ' hl' : ''}${A.has(n) ? ' mk-add' : M.has(n) ? ' mk-mod' : ''}" data-n="${n}"><i>${n}</i><span class="lc">${toks(src[n - 1] || [['', -1, 0]]) || ' '}</span></div>${D.has(n) ? '<div class="dm"></div>' : ''}`;
  const total = src.length;
  if (D.has(0)) code.insertAdjacentHTML('beforeend', '<div class="dm"></div>');
  let n = 0;
  const renderChunk = () => {
    if (!body.contains(code)) return;
    let html = '';
    const end = Math.min(total, n + 300);
    while (n < end) {
      n++;
      if (vOnly && !near(n)) {
        let k = n;
        while (k < total && !near(k + 1)) k++;
        html += vExpand.has(n) ? rangeHtml(n, k) : `<div class="gap" data-gap="${n}">${I18N.tr(`⋯ ${k - n + 1} 行未改动`)}</div>`;
        n = k;
      } else html += lineHtml(n);
    }
    code.insertAdjacentHTML('beforeend', html);
    if (n < total) setTimeout(renderChunk, 0);
    else {
      code.dataset.complete = '1';
      if (!body.contains(code)) return;
      if (m.line) code.querySelector(`[data-n="${m.line}"]`)?.scrollIntoView({ block: 'center' });
      if (!$('vSearch').hidden && !editing && viewing === m) findInFile();
    }
  };
  const rangeHtml = (a, b) => { let s = ''; for (let k = a; k <= b; k++) s += lineHtml(k); return s; };
  body.replaceChildren(code);
  if (m.diff) {
    const diff = document.createElement('details');
    diff.className = 'toolrow open';
    diff.innerHTML = '<summary>本轮修改内容</summary><div class="tdiff">' + m.diff.split('\n').map(l => `<div class="dl ${l.startsWith('+') ? 'di' : l.startsWith('-') ? 'dd' : ''}">${esc(l)}</div>`).join('') + '</div>';
    body.prepend(diff);
  }
  renderChunk();
  if (m.truncated) code.insertAdjacentHTML('beforeend', '<div class="note">文件太长，只显示了前 512 KB</div>');
}
function jumpMark(dir) {
  if (!vMarkLine.length) return;
  vIdx = (vIdx + dir + vMarkLine.length) % vMarkLine.length;
  $('vChangeCount').textContent = `${vIdx + 1}/${vMarkLine.length}`;
  const n = vMarkLine[vIdx];
  if (vOnly && !$('vBody').querySelector(`[data-n="${n}"]`)) { vOnly = false; vExpand.clear(); renderFileCode(viewing); }
  $('vBody').querySelector(`[data-n="${n}"]`)?.scrollIntoView({ block: 'center' });
}
$('vChangePrev').onclick = () => jumpMark(-1);
$('vChangeNext').onclick = () => jumpMark(1);
$('vOnly').onclick = () => { vOnly = !vOnly; vExpand.clear(); if (viewing) renderFileCode(viewing); };
$('vBody').addEventListener('click', e => {
  const g = e.target.closest('.gap');
  if (!g || !viewing) return;
  vExpand.add(Number(g.dataset.gap));
  renderFileCode(viewing);
});

const fmtSize = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';

function onSaved(m) {
  const submitted = saving;
  if (!submitted || m.requestId !== submitted.requestId || m.path !== submitted.path || (m.host || '') !== submitted.host) return;
  finishFileSave();
  if (!m.ok) { editorStatus(m.error || '保存失败', false); return status(m.error || '保存失败', false); }
  if (!viewing || fileRequestId !== submitted.viewRequestId || viewing.path !== submitted.path || (viewing.host || '') !== submitted.host) return;
  viewing.text = editBase = submitted.text;
  viewing.hl = null;
  viewing.size = m.size;
  editorStatus('已保存');
  status('已保存');
}
function finishFileSave() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  saving = null;
  $('vEdit').disabled = false;
  finishPending(['正在保存…']);
}
function failFileSave(message) {
  if (!saving) return;
  finishFileSave();
  editorStatus(message, false);
  status(message, false);
}
function editorStatus(message, ok = true) {
  $('vStatus').hidden = false;
  $('vStatus').textContent = I18N.tr(message);
  $('vStatus').className = ok ? '' : 'err';
}
function saveEdit() {
  if (!editing || saving) return;
  if (!authed || !ws || ws.readyState !== 1) { editorStatus('未连接', false); return; }
  const submitted = saving = { requestId: ++saveRequestId, viewRequestId: fileRequestId, path: viewing.path, host: viewing.host || '', text: $('vEditBox').value };
  $('vEdit').disabled = true;
  editorStatus('正在保存…');
  status('正在保存…');
  saveTimer = setTimeout(() => {
    if (saving === submitted) failFileSave('保存结果未确认，请检查连接后重试');
  }, 30000);
  if (!send({ t: 'saveFile', requestId: submitted.requestId, path: submitted.path, host: submitted.host, text: submitted.text })) failFileSave('未连接，文件未发送保存，请重试');
}

function closeViewer() {
  if (dirtyEdit() && !confirm('还有没保存的修改，确定离开？')) {
    if (!history.state?.viewer) history.pushState({ viewer: true }, '');
    $('viewer').classList.add('open');
    return;
  }
  fileRequestId++;
  finishFileRead();
  finishFileSave();
  stopVideo();
  leaveEdit();
  viewing = null;
  $('vEdit').hidden = true;
  $('viewer').classList.remove('open');
  $('vBody').innerHTML = '';
  if (returnToEditor) {
    const directory = returnToEditor;
    returnToEditor = null;
    send({ t: 'docs', ...directory, editor: true });
  }
}
$('vClose').onclick = () => history.state?.viewer ? history.back() : closeViewer();
window.addEventListener('popstate', () => { if ($('viewer').classList.contains('open')) closeViewer(); });
$('vEdit').onclick = () => {
  if (!viewing?.text && viewing?.text !== '') return;
  if (!editing) {
    editing = true;
    editBase = viewing.text;
    $('vBody').classList.add('editing');
    $('vBody').innerHTML = '<textarea id="vEditBox" spellcheck="false" autocapitalize="off" autocorrect="off"></textarea>';
    $('vEditBox').value = viewing.text;
    $('vEdit').textContent = '保存';
    $('vWrap').hidden = true;
    $('vFind').hidden = true;
    $('vTools').hidden = false;
    $('vChanges').hidden = true;
    $('vEditBox').addEventListener('input', () => { if (!$('vSearch').hidden) findInFile(0); });
    $('vEditBox').focus();
    return;
  }
  saveEdit();
};
$('vWrap').onclick = () => {
  const on = !$('vBody').classList.contains('wrap');
  $('vBody').classList.toggle('wrap', on);
  $('vWrap').classList.toggle('on', on);
  store.set('wrap', on ? null : 'off');
};

function editInsert(value) {
  const box = $('vEditBox');
  box.focus();
  document.execCommand('insertText', false, value);
}
function indentEdit(remove = false) {
  const box = $('vEditBox'), value = box.value;
  const a = box.selectionStart, b = box.selectionEnd;
  const existing = /^([ \t]+)\S/m.exec(value)?.[1] || '';
  const unit = existing.includes('\t') ? '\t' : ' '.repeat(existing.length === 2 ? 2 : 4);
  if (a === b && !remove) { editInsert(unit); return; }
  const start = a === 0 ? 0 : value.lastIndexOf('\n', a - 1) + 1;
  const last = b > a && value[b - 1] === '\n' ? b - 1 : b;
  const next = value.indexOf('\n', last);
  const end = next < 0 ? value.length : next;
  const lines = value.slice(start, end).split('\n');
  const changes = lines.map(line => remove ? -(line[0] === '\t' ? 1 : Math.min(unit.length, /^ */.exec(line)[0].length)) : unit.length);
  const result = lines.map((line, i) => remove ? line.slice(-changes[i]) : unit + line).join('\n');
  box.setSelectionRange(start, end);
  editInsert(result);
  const shift = remove ? -Math.min(-changes[0], a - start) : changes[0];
  box.setSelectionRange(a + shift, a === b ? a + shift : b + changes.reduce((n, d) => n + d, 0));
}
let searchIndex = -1, searchQuery = '';
function findInFile(step = 0) {
  const query = $('vQuery').value;
  const value = editing ? $('vEditBox').value : viewing?.text || '';
  const hits = [];
  if (query) for (let at = value.indexOf(query); at >= 0; at = value.indexOf(query, at + query.length)) hits.push(at);
  if (query !== searchQuery) { searchIndex = -1; searchQuery = query; }
  searchIndex = hits.length ? ((searchIndex < 0 ? 0 : searchIndex + step) % hits.length + hits.length) % hits.length : -1;
  $('vCount').textContent = hits.length ? `${searchIndex + 1} / ${hits.length}` : '0 / 0';
  if (editing) {
    if (hits.length) {
      const box = $('vEditBox'), at = hits[searchIndex];
      box.setSelectionRange(at, at + query.length);
      box.scrollTop = Math.max(0, (value.slice(0, at).split('\n').length - 3) * parseFloat(getComputedStyle(box).lineHeight));
    }
  } else {
    const line = hits.length ? value.slice(0, hits[searchIndex]).split('\n').length : -1;
    if (line > 0 && vOnly && !$('vBody').querySelector(`[data-n="${line}"]`) && $('vBody').querySelector('.code')?.dataset.complete) {
      const gap = [...$('vBody').querySelectorAll('.gap')].reverse().find(el => Number(el.dataset.gap) <= line);
      if (gap) { vExpand.add(Number(gap.dataset.gap)); renderFileCode(viewing); return; }
    }
    $('vBody').querySelectorAll('.l').forEach(el => el.classList.toggle('searchHit', Number(el.dataset.n) === line));
    $('vBody').querySelector('.searchHit')?.scrollIntoView({ block: 'center' });
  }
}
function openSearch() {
  $('vSearch').hidden = false;
  $('vQuery').focus();
  $('vQuery').select();
  findInFile();
}
function closeSearch() {
  $('vSearch').hidden = true;
  $('vBody').querySelector('.searchHit')?.classList.remove('searchHit');
  if (editing) $('vEditBox').focus();
}
async function editAction(action) {
  const box = $('vEditBox');
  if (action === 'search') return openSearch();
  if (action === 'more') {
    for (const button of $('vTools').querySelectorAll('[data-edit="undo"], [data-edit="redo"], [data-edit="all"]')) button.hidden = !button.hidden;
    return;
  }
  if (!editing) return;
  if (action === 'copy') {
    const selected = box.value.slice(box.selectionStart, box.selectionEnd);
    await copyText(selected || box.value, null, false);
    status(selected ? '已复制' : '已复制全文');
  } else if (action === 'paste') {
    try { const value = await navigator.clipboard.readText(); editInsert(value); }
    catch { status('请长按编辑框粘贴', false); }
  } else if (action === 'indent' || action === 'outdent') indentEdit(action === 'outdent');
  else if (action === 'all') { box.focus(); box.select(); }
  else { box.focus(); document.execCommand(action); }
}
function editKey(e) {
  if (e.isComposing || e.keyCode === 229) return;
  const command = e.ctrlKey || e.metaKey;
  if (command && e.key.toLowerCase() === 'f') { e.preventDefault(); openSearch(); }
  else if (command && e.key.toLowerCase() === 's' && editing) { e.preventDefault(); saveEdit(); }
  else if (e.key === 'Escape' && !$('vSearch').hidden) { e.preventDefault(); closeSearch(); }
  else if (e.key === 'Tab' && e.target.id === 'vEditBox') { e.preventDefault(); indentEdit(e.shiftKey); }
}
$('viewer').addEventListener('keydown', editKey);
$('vTools').addEventListener('pointerdown', e => { if (e.target.closest('button')) e.preventDefault(); });
$('vTools').addEventListener('click', e => { const button = e.target.closest('[data-edit]'); if (button) editAction(button.dataset.edit); });
$('vQuery').addEventListener('input', () => findInFile());
$('vQuery').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); findInFile(e.shiftKey ? -1 : 1); } });
$('vFind').onclick = openSearch;
$('vPrev').onclick = () => findInFile(-1);
$('vNext').onclick = () => findInFile(1);
$('vSearchClose').onclick = closeSearch;

