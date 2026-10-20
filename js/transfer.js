/* File transfer uses HTTP only; it never changes the active Agent or its editor. */
let transferComputer = null, transferTab = 'download', transferDirectory = null, transferPicker = null;
let transferUploadPath = '', transferSelection = new Map(), transferRequest = 0;
const transferXhrs = new Set();
let transferUploads = [], transferUploading = false, transferCancelled = false;
const transferDirectories = JSON.parse(store.get('transfer-directories') || '{}');
const transferPanel = document.createElement('section');
transferPanel.id = 'transfer';
transferPanel.hidden = true;
transferPanel.setAttribute('role', 'dialog');
transferPanel.setAttribute('aria-modal', 'true');
transferPanel.setAttribute('aria-label', '文件传输');
transferPanel.innerHTML = `<div class="transferHeader"><button id="transferClose" class="transferIcon" aria-label="返回">‹</button><h3>文件传输</h3>
  <details id="transferMore"><summary aria-label="更多操作">⋯</summary><div class="transferMenu"><button id="transferHome">主目录</button><button id="transferRefresh">刷新目录</button><select id="transferRoots" aria-label="磁盘"></select></div></details></div>
  <div class="transferTabs" role="tablist"><button id="transferDownloadTab" role="tab">下载到手机</button><button id="transferUploadTab" role="tab">上传到电脑</button></div>
  <div class="transferBody"><div id="transferBrowser"><div id="transferBrowserLabel" class="transferLabel">电脑文件</div>
    <button id="transferParent" class="transferParent">↑ 上一级</button><div class="transferPathBar"><button id="transferPathButton" title="编辑电脑路径"></button></div>
    <form id="transferPathForm" hidden><input id="transferPath" aria-label="电脑目录" placeholder="输入电脑目录路径"><button>前往</button></form>
    <div class="transferListTools"><button id="transferHidden" class="transferToggle" role="switch"><span>显示隐藏文件</span><span class="switch"></span></button><details id="transferSelectMenu"><summary>选择</summary><div class="transferMenu"><button id="transferAll">全选本页</button><button id="transferClear">清空选择</button></div></details></div>
    <div id="transferRows"></div><p class="hint" id="transferArchiveHint">文件夹将打包为 ZIP</p></div>
    <div id="transferUploadView" hidden><div class="transferLabel">电脑接收目录</div><div class="transferTargetBar"><span id="transferUploadTarget"></span><button id="transferChangeTarget" class="transferText">更改</button></div>
      <div id="transferQueueLabel" class="transferLabel">待上传</div><div id="transferProgress" role="status"></div>
      <div class="transferAdd"><button id="transferFiles">＋ 添加文件</button><button id="transferFolder" class="transferText">选择文件夹</button></div>
      <details id="transferOptions"><summary><span>上传选项</span><span id="transferCollisionLabel" class="hint">同名文件：另存 ›</span></summary><label>同名文件 <select id="transferCollision"><option value="rename">另存为新文件</option><option value="skip">跳过</option><option value="replace">覆盖</option></select></label><p class="hint">文件夹上传保留子目录；选择文件夹取决于手机浏览器支持。</p></details>
    </div><div id="transferStatus" role="status"></div></div>
  <div class="transferFooter"><div id="transferDownloadFooter"><div class="transferSummary"><span id="transferSelected"></span><button id="transferClearFooter" class="transferText">清空</button></div><button id="transferDownload" class="transferPrimary">下载到手机</button><div class="hint">保存位置由浏览器决定</div></div>
    <div id="transferUploadFooter" hidden><div class="transferSummary"><span id="transferUploadSummary"></span><button id="transferRetry" class="transferText" hidden>重试失败项</button></div><button id="transferStart" class="transferPrimary">上传到电脑</button><button id="transferCancel" hidden>取消上传</button><div class="hint">上传目标独立保存，不随下载目录变化</div></div>
    <div id="transferPickerFooter" hidden><button id="transferUseDirectory" class="transferPrimary">使用此文件夹</button><div class="hint">仅更改电脑接收目录</div></div></div>
  <input id="transferFileInput" type="file" multiple hidden><input id="transferFolderInput" type="file" multiple webkitdirectory hidden>`;
document.body.append(transferPanel);
function transferStatus(text, error = false) { $('transferStatus').textContent = text; $('transferStatus').className = error ? 'err' : 'hint'; }
function saveTransferDirectories() {
  transferDirectories[transferComputer] = { download: transferDirectory?.path || '', upload: transferUploadPath };
  store.set('transfer-directories', JSON.stringify(transferDirectories));
}
function transferCurrentDirectory() { return transferPicker || transferDirectory; }
function transferCount() {
  $('transferSelected').textContent = `已选 ${transferSelection.size} 项`;
  $('transferDownload').disabled = !transferSelection.size;
  $('transferClearFooter').hidden = !transferSelection.size;
}
function renderTransferPage() {
  const picking = !!transferPicker, downloading = transferTab === 'download';
  $('transferDownloadTab').setAttribute('aria-selected', String(downloading));
  $('transferUploadTab').setAttribute('aria-selected', String(!downloading));
  $('transferBrowser').hidden = !downloading && !picking;
  $('transferUploadView').hidden = downloading || picking;
  $('transferDownloadFooter').hidden = !downloading;
  $('transferUploadFooter').hidden = downloading || picking;
  $('transferPickerFooter').hidden = !picking;
  $('transferUseDirectory').disabled = !transferPicker?.home;
  $('transferSelectMenu').hidden = picking;
  $('transferArchiveHint').hidden = picking;
  $('transferBrowserLabel').textContent = picking ? '选择电脑接收目录' : '电脑文件';
  $('transferMore').hidden = !downloading && !picking;
  $('transferUploadTarget').textContent = transferUploadPath || '正在读取目录…';
  const directory = transferCurrentDirectory();
  if (directory) {
    $('transferParent').disabled = directory.path === directory.parent;
    $('transferPath').value = directory.path;
    $('transferPathButton').textContent = directory.path;
    $('transferPathButton').title = directory.path + '（点击编辑）';
    $('transferRoots').innerHTML = '<option value="" disabled selected>磁盘</option>' + (directory.roots || []).map(root => `<option value="${esc(root)}">${esc(root)}</option>`).join('');
    renderTransferRows();
  }
  transferCount();
  renderTransferUploads();
}
function renderTransferRows() {
  const directory = transferCurrentDirectory();
  const showHidden = store.get('transfer-show-hidden') === '1';
  $('transferHidden').setAttribute('aria-checked', String(showHidden));
  $('transferHidden').querySelector('.switch').classList.toggle('on', showHidden);
  $('transferRows').innerHTML = (directory?.entries || []).map((entry, index) => {
    if (!showHidden && entry.name.startsWith('.')) return '';
    const selectable = entry.selectable && !transferPicker;
    return `<div class="transferRow">${transferPicker ? '' : `<input type="checkbox" aria-label="选择 ${esc(entry.name)}" data-transfer-check="${index}" ${transferSelection.has(entry.path) ? 'checked' : ''} ${selectable ? '' : 'disabled'}>`}<button data-transfer-open="${index}" ${entry.selectable && (!transferPicker || entry.directory) ? '' : 'disabled'}><span class="transferFileIcon" aria-hidden="true">${entry.directory ? '📁' : '📄'}</span><span class="transferFileInfo"><span class="transferName${entry.directory ? ' directory' : ''}">${esc(entry.name)}${entry.link ? ' ↗' : ''}</span>${entry.directory ? '' : `<span class="hint">${entry.selectable ? fmtSize(entry.size) : '不可读取'}</span>`}</span>${entry.directory ? '<span class="hint">›</span>' : ''}</button></div>`;
  }).join('') || '<div class="transferEmpty hint">此目录暂无可显示的文件</div>';
}
async function openTransfer() {
  closeSheet();
  const computer = currentComputer()?.id || base;
  if (computer !== transferComputer) {
    transferRequest++; transferComputer = computer; transferDirectory = null; transferPicker = null; transferSelection.clear();
    transferUploadPath = transferDirectories[computer]?.upload || '';
    if (!transferUploading) { transferUploads = []; $('transferProgress').replaceChildren(); }
  }
  transferPanel.hidden = false;
  renderTransferPage();
  if (!transferDirectory) await transferBrowse(transferDirectories[computer]?.download || '');
}
async function transferBrowse(directory) {
  const request = ++transferRequest, picking = !!transferPicker;
  transferStatus('正在读取目录…');
  try {
    const response = await api('/api/transfer/list?path=' + encodeURIComponent(directory));
    const data = await response.json();
    if (request !== transferRequest) return;
    if (!response.ok) throw Error(data.error);
    if (picking) transferPicker = data;
    else {
      transferDirectory = data;
      if (!transferUploadPath) transferUploadPath = data.home;
      saveTransferDirectories();
    }
    $('transferPathForm').hidden = true;
    renderTransferPage();
    transferStatus('');
  } catch (error) { if (request === transferRequest) transferStatus(error.message, true); }
}
function transferSwitchTab(tab) {
  if (transferPicker) transferRequest++;
  transferTab = tab; transferPicker = null;
  $('transferPathForm').hidden = true; $('transferMore').open = false; $('transferSelectMenu').open = false;
  transferStatus(''); renderTransferPage();
}
$('transferDownloadTab').onclick = () => transferSwitchTab('download');
$('transferUploadTab').onclick = () => transferSwitchTab('upload');
$('transferClose').onclick = () => {
  transferRequest++;
  if (transferPicker) { transferPicker = null; renderTransferPage(); transferStatus(''); }
  else transferPanel.hidden = true;
};
$('transferPathButton').onclick = () => { $('transferPathForm').hidden = !$('transferPathForm').hidden; if (!$('transferPathForm').hidden) $('transferPath').focus(); };
$('transferPathForm').onsubmit = e => { e.preventDefault(); transferBrowse($('transferPath').value); };
$('transferHome').onclick = () => { $('transferMore').open = false; transferBrowse(transferCurrentDirectory()?.home || ''); };
$('transferParent').onclick = () => transferBrowse(transferCurrentDirectory()?.parent || '');
$('transferRefresh').onclick = () => { $('transferMore').open = false; transferBrowse(transferCurrentDirectory()?.path || ''); };
$('transferRoots').onchange = e => { $('transferMore').open = false; transferBrowse(e.target.value); };
$('transferChangeTarget').onclick = () => {
  transferPicker = { path: transferUploadPath, entries: [] };
  renderTransferPage(); transferBrowse(transferUploadPath);
};
$('transferUseDirectory').onclick = () => {
  if (!transferPicker?.home) return;
  transferUploadPath = transferPicker.path;
  for (const item of transferUploads) if (item.pending) item.directory = transferUploadPath;
  transferPicker = null;
  saveTransferDirectories(); renderTransferPage(); transferStatus('');
};
$('transferHidden').onclick = () => {
  const show = store.get('transfer-show-hidden') !== '1';
  store.set('transfer-show-hidden', show ? '1' : '0');
  if (!show) for (const [key, entry] of transferSelection) if (entry.name.startsWith('.')) transferSelection.delete(key);
  renderTransferRows(); transferCount();
};
$('transferRows').onchange = e => {
  const entry = transferCurrentDirectory()?.entries[e.target.dataset.transferCheck];
  if (!entry || transferPicker) return;
  if (e.target.checked) transferSelection.set(entry.path, entry); else transferSelection.delete(entry.path);
  transferCount();
};
$('transferRows').onclick = e => {
  const button = e.target.closest('[data-transfer-open]');
  if (!button) return;
  const entry = transferCurrentDirectory().entries[button.dataset.transferOpen];
  if (entry.directory) transferBrowse(entry.path);
  else button.parentElement.querySelector('input')?.click();
};
$('transferAll').onclick = () => {
  $('transferRows').querySelectorAll('input:not(:disabled)').forEach(box => {
    box.checked = true; const entry = transferDirectory.entries[box.dataset.transferCheck]; transferSelection.set(entry.path, entry);
  });
  $('transferSelectMenu').open = false; transferCount();
};
function clearTransferSelection() { transferSelection.clear(); renderTransferRows(); transferCount(); $('transferSelectMenu').open = false; }
$('transferClear').onclick = clearTransferSelection;
$('transferClearFooter').onclick = clearTransferSelection;
$('transferDownload').onclick = async () => {
  const downloadBase = base;
  $('transferDownload').disabled = true;
  transferStatus('正在准备下载…');
  try {
    const response = await api('/api/transfer/download', { method: 'POST', body: JSON.stringify({ paths: [...transferSelection.keys()] }) });
    const data = await response.json();
    if (!response.ok) throw Error(data.error);
    const link = document.createElement('a'); link.href = downloadBase + data.url; link.download = data.name; link.textContent = '点此下载 ' + data.name;
    $('transferStatus').replaceChildren(link); link.click();
  } catch (error) { transferStatus(error.message, true); }
  finally { transferCount(); }
};
function renderTransferUploads() {
  for (const item of transferUploads) {
    if (!item.row) {
      item.row = document.createElement('div'); item.row.className = 'transferUploadItem';
      item.row.innerHTML = `<span class="transferFileIcon" aria-hidden="true">📄</span><span class="transferFileInfo"><span class="transferName">${esc(item.name)}</span><span class="hint transferItemStatus"></span></span><button class="transferRemove transferIcon" aria-label="移除 ${esc(item.name)}">×</button>`;
      item.row.querySelector('button').onclick = () => { if (transferUploading) return; item.row.remove(); transferUploads.splice(transferUploads.indexOf(item), 1); renderTransferUploads(); };
      $('transferProgress').append(item.row);
    }
    const text = `${fmtSize(item.file.size)} · ${item.status}`;
    const label = item.row.querySelector('.transferItemStatus');
    if (label.textContent !== text) label.textContent = text;
    item.row.querySelector('button').disabled = transferUploading;
  }
  const pending = transferUploads.filter(item => item.pending);
  $('transferQueueLabel').textContent = transferUploading ? `上传进度 · ${transferUploads.length} 个文件` : pending.length ? `待上传 · ${pending.length} 个文件` : transferUploads.length ? '传输记录' : '待上传';
  $('transferUploadSummary').textContent = transferUploading ? '正在上传到电脑…' : `${pending.length} 个待上传 · ${fmtSize(pending.reduce((size, item) => size + item.file.size, 0))}`;
  $('transferCancel').hidden = !transferUploading;
  $('transferStart').hidden = transferUploading;
  $('transferStart').disabled = !pending.length || !transferUploadPath;
  $('transferRetry').hidden = transferUploading || !transferUploads.some(item => item.failed);
  for (const id of ['transferFiles', 'transferFolder', 'transferCollision', 'transferChangeTarget']) $(id).disabled = transferUploading;
}
function transferSendFile(item) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    transferXhrs.add(xhr);
    xhr.onloadend = () => transferXhrs.delete(xhr);
    const query = new URLSearchParams({ directory: item.directory, name: item.name, mode: item.mode });
    xhr.open('POST', item.base + '/api/transfer/upload?' + query);
    xhr.setRequestHeader('authorization', 'Bearer ' + item.token);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = event => {
      item.status = event.lengthComputable ? `上传中 ${Math.round(event.loaded / event.total * 100)}%` : '上传中';
      renderTransferUploads();
    };
    xhr.onload = () => {
      let data;
      try { data = JSON.parse(xhr.responseText); } catch { reject(Error('上传响应无效')); return; }
      if (xhr.status < 200 || xhr.status >= 300) reject(Error(data.error || '上传失败'));
      else resolve(data);
    };
    xhr.onerror = () => reject(Error('连接中断，上传失败'));
    xhr.onabort = () => reject(Error('已取消'));
    xhr.send(item.file);
  });
}
async function runTransferUploads(items) {
  transferUploading = true; transferCancelled = false;
  for (const item of items) { item.mode = $('transferCollision').value; item.pending = false; }
  renderTransferUploads();
  let next = 0;
  const paths = new Map();
  async function upload(item) {
    if (transferCancelled) { item.status = '已取消'; item.failed = false; return; }
    item.failed = false; item.status = '上传中'; renderTransferUploads();
    try {
      const result = await transferSendFile(item);
      item.status = result.skipped ? '已跳过' : '已上传';
      item.row.title = result.path;
    } catch (error) { item.status = error.message; item.failed = !transferCancelled; }
    renderTransferUploads();
  }
  async function worker() {
    while (next < items.length) {
      const item = items[next++];
      const key = item.base + '\n' + item.directory + '\n' + item.name;
      // Preserve selection order for repeated destinations, especially when replacing files.
      const task = (paths.get(key) || Promise.resolve()).then(() => upload(item));
      paths.set(key, task);
      await task;
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, items.length) }, () => worker()));
  transferUploading = false; renderTransferUploads();
}
function chooseTransferFiles(files) {
  if (!files.length || !transferUploadPath || transferUploading) return;
  transferUploads.push(...Array.from(files, file => ({ base, token: store.get('token'), file, name: file.webkitRelativePath || file.name, directory: transferUploadPath, mode: $('transferCollision').value, status: '待上传', pending: true, failed: false })));
  renderTransferUploads();
}
$('transferFiles').onclick = () => $('transferFileInput').click();
$('transferFolder').onclick = () => $('transferFolderInput').click();
for (const id of ['transferFileInput', 'transferFolderInput']) $(id).onchange = e => { chooseTransferFiles(e.target.files); e.target.value = ''; };
$('transferStart').onclick = () => runTransferUploads(transferUploads.filter(item => item.pending));
$('transferCancel').onclick = () => { transferCancelled = true; for (const xhr of transferXhrs) xhr.abort(); };
$('transferRetry').onclick = () => runTransferUploads(transferUploads.filter(item => item.failed));
$('transferCollision').onchange = () => { $('transferCollisionLabel').textContent = '同名文件：' + ({ rename: '另存', skip: '跳过', replace: '覆盖' })[$('transferCollision').value] + ' ›'; };
