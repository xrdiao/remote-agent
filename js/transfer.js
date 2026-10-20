/* File transfer uses HTTP only; it never changes the active Agent or its editor. */
let transferComputer = null;
let transferDirectory = null, transferSelection = new Map(), transferRequest = 0;
let transferUploads = [], transferXhr = null, transferUploading = false, transferCancelled = false;
const transferPanel = document.createElement('section');
transferPanel.id = 'transfer';
transferPanel.hidden = true;
transferPanel.setAttribute('role', 'dialog');
transferPanel.setAttribute('aria-modal', 'true');
transferPanel.setAttribute('aria-label', '文件传输');
transferPanel.innerHTML = `<div class="transferHeader"><h3>文件传输</h3><button id="transferClose" aria-label="关闭">×</button></div>
  <form id="transferPathForm"><input id="transferPath" aria-label="电脑目录" placeholder="输入电脑目录路径"><button>前往</button></form>
  <div class="transferTools"><button id="transferHome">主目录</button><button id="transferParent">上一级</button><select id="transferRoots" aria-label="磁盘"></select><button id="transferRefresh">刷新</button></div>
  <div class="transferTools"><button id="transferAll">全选本页</button><button id="transferClear">清空选择</button><button id="transferDownload">下载所选</button></div>
  <div id="transferSelected" class="hint"></div><div id="transferStatus" role="status"></div>
  <div id="transferRows"></div>
  <div class="transferUpload"><h4>上传到当前电脑目录</h4><div id="transferUploadTarget" class="hint"></div><div class="transferTools"><button id="transferFiles">选择文件（可多选）</button><button id="transferFolder">选择文件夹</button></div>
  <label>同名文件 <select id="transferCollision"><option value="rename">另存为新文件</option><option value="skip">跳过</option><option value="replace">覆盖</option></select></label>
  <div class="hint">文件夹上传保留子目录；文件夹选择取决于手机浏览器支持。</div>
  <div class="transferTools"><button id="transferCancel" hidden>取消上传</button><button id="transferRetry" hidden>重试失败项</button></div><div id="transferProgress" role="status"></div></div>
  <div class="hint">下载位置由浏览器决定；多选或文件夹打包为 ZIP，保留目录结构，不跟随内部符号链接。下载进度和取消由浏览器管理。</div>
  <input id="transferFileInput" type="file" multiple hidden><input id="transferFolderInput" type="file" multiple webkitdirectory hidden>`;
document.body.append(transferPanel);
function transferStatus(text, error = false) { $('transferStatus').textContent = text; $('transferStatus').className = error ? 'err' : 'hint'; }
function transferCount() { $('transferSelected').textContent = `已选择 ${transferSelection.size} 项`; $('transferDownload').disabled = !transferSelection.size; }
async function openTransfer() {
  closeSheet();
  const computer = currentComputer()?.id || base;
  if (computer !== transferComputer) { transferComputer = computer; transferDirectory = null; transferSelection.clear(); }
  transferPanel.hidden = false;
  await transferBrowse(transferDirectory?.path || '');
}
async function transferBrowse(directory) {
  const request = ++transferRequest;
  transferStatus('正在读取目录…');
  try {
    const response = await api('/api/transfer/list?path=' + encodeURIComponent(directory));
    const data = await response.json();
    if (request !== transferRequest) return;
    if (!response.ok) throw Error(data.error);
    transferDirectory = data;
    $('transferPath').value = data.path;
    $('transferRoots').innerHTML = '<option value="" disabled selected>磁盘</option>' + data.roots.map(root => `<option value="${esc(root)}">${esc(root)}</option>`).join('');
    $('transferUploadTarget').textContent = data.path;
    $('transferRows').innerHTML = data.entries.map((entry, index) => `<div class="transferRow"><input type="checkbox" aria-label="选择 ${esc(entry.name)}" data-transfer-check="${index}" ${transferSelection.has(entry.path) ? 'checked' : ''} ${entry.selectable ? '' : 'disabled'}><button data-transfer-open="${index}" ${entry.selectable ? '' : 'disabled'}><span class="transferName${entry.directory ? ' directory' : ''}">${entry.directory ? '📁' : '📄'} ${esc(entry.name)}${entry.link ? ' ↗' : ''}</span><span class="hint">${entry.directory ? '›' : entry.selectable ? fmtSize(entry.size) : '不可读取'}</span></button></div>`).join('') || '<div class="hint">空文件夹</div>';
    transferCount();
    transferStatus('');
  } catch (error) { if (request === transferRequest) transferStatus(error.message, true); }
}
$('transferClose').onclick = () => { transferPanel.hidden = true; };
$('transferPathForm').onsubmit = e => { e.preventDefault(); transferBrowse($('transferPath').value); };
$('transferHome').onclick = () => transferBrowse(transferDirectory?.home || '');
$('transferParent').onclick = () => transferBrowse(transferDirectory?.parent || '');
$('transferRefresh').onclick = () => transferBrowse(transferDirectory?.path || '');
$('transferRoots').onchange = e => transferBrowse(e.target.value);
$('transferRows').onchange = e => {
  const entry = transferDirectory.entries[e.target.dataset.transferCheck];
  if (!entry) return;
  if (e.target.checked) transferSelection.set(entry.path, entry); else transferSelection.delete(entry.path);
  transferCount();
};
$('transferRows').onclick = e => {
  const button = e.target.closest('[data-transfer-open]');
  if (!button) return;
  const entry = transferDirectory.entries[button.dataset.transferOpen];
  if (entry.directory) transferBrowse(entry.path);
  else { const checkbox = button.parentElement.querySelector('input'); checkbox.click(); }
};
$('transferAll').onclick = () => {
  for (const entry of transferDirectory?.entries || []) if (entry.selectable) transferSelection.set(entry.path, entry);
  $('transferRows').querySelectorAll('input:not(:disabled)').forEach(box => { box.checked = true; });
  transferCount();
};
$('transferClear').onclick = () => { transferSelection.clear(); $('transferRows').querySelectorAll('input').forEach(box => { box.checked = false; }); transferCount(); };
$('transferDownload').onclick = async () => {
  const downloadBase = base;
  const button = $('transferDownload');
  button.disabled = true;
  transferStatus('正在准备下载…');
  try {
    const response = await api('/api/transfer/download', { method: 'POST', body: JSON.stringify({ paths: [...transferSelection.keys()] }) });
    const data = await response.json();
    if (!response.ok) throw Error(data.error);
    const link = document.createElement('a');
    link.href = downloadBase + data.url;
    link.download = data.name;
    link.textContent = '点此下载 ' + data.name;
    $('transferStatus').replaceChildren(link);
    link.click();
  } catch (error) { transferStatus(error.message, true); }
  finally { transferCount(); }
};
function renderTransferUploads() {
  for (const item of transferUploads) {
    if (!item.row) { item.row = document.createElement('div'); item.row.className = 'transferUploadItem'; $('transferProgress').append(item.row); }
    const text = `${item.name} · ${item.status}`;
    if (item.row.textContent !== text) item.row.textContent = text;
  }
  $('transferCancel').hidden = !transferUploading;
  $('transferRetry').hidden = transferUploading || !transferUploads.some(item => item.failed);
  for (const id of ['transferFiles', 'transferFolder', 'transferCollision']) $(id).disabled = transferUploading;
}
function transferSendFile(item) {
  return new Promise((resolve, reject) => {
    const xhr = transferXhr = new XMLHttpRequest();
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
  transferUploading = true;
  transferCancelled = false;
  renderTransferUploads();
  for (const item of items) {
    if (transferCancelled) { item.status = '已取消'; item.failed = false; continue; }
    item.failed = false;
    item.status = '上传中';
    renderTransferUploads();
    try {
      const result = await transferSendFile(item);
      item.status = result.skipped ? '已跳过' : '已上传：' + result.path;
    } catch (error) { item.status = error.message; item.failed = !transferCancelled; }
    transferXhr = null;
    renderTransferUploads();
  }
  transferUploading = false;
  renderTransferUploads();
  if (transferDirectory && !transferPanel.hidden) await transferBrowse(transferDirectory.path);
}
function chooseTransferFiles(files) {
  if (!files.length || !transferDirectory || transferUploading) return;
  $('transferProgress').replaceChildren();
  transferUploads = Array.from(files, file => ({ base, token: store.get('token'), file, name: file.webkitRelativePath || file.name, directory: transferDirectory.path, mode: $('transferCollision').value, status: '等待上传', failed: false }));
  runTransferUploads(transferUploads);
}
$('transferFiles').onclick = () => $('transferFileInput').click();
$('transferFolder').onclick = () => $('transferFolderInput').click();
for (const id of ['transferFileInput', 'transferFolderInput']) $(id).onchange = e => { chooseTransferFiles(e.target.files); e.target.value = ''; };
$('transferCancel').onclick = () => { transferCancelled = true; transferXhr?.abort(); };
$('transferRetry').onclick = () => runTransferUploads(transferUploads.filter(item => item.failed));
