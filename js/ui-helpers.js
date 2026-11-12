function drawQrModules(canvas, modules) {
  const scale = 4;
  canvas.width = canvas.height = (modules.length + 8) * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) ctx.fillRect((x + 4) * scale, (y + 4) * scale, scale, scale); }));
}

async function uploadBinary({ target, computer, path, file, timeout = 0, cancelled, onRequest, onProgress, onEnd }) {
  const headers = await entryHeaders(computer, 'POST', path);
  if (cancelled?.()) throw new Error('已取消上传');
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    onRequest?.(request);
    request.open('POST', target + path);
    for (const [key, value] of Object.entries(headers)) request.setRequestHeader(key, value);
    request.setRequestHeader('content-type', 'application/octet-stream');
    request.timeout = timeout;
    request.upload.onprogress = onProgress;
    request.onloadend = () => onEnd?.(request);
    request.onload = () => {
      let result;
      try { result = JSON.parse(request.responseText); }
      catch { reject(new Error('上传响应无效')); return; }
      if (request.status < 200 || request.status >= 300) reject(new Error(result.error || '文件上传失败'));
      else resolve(result);
    };
    request.onerror = () => reject(new Error('连接中断，上传失败'));
    request.ontimeout = () => reject(new Error('文件上传超时'));
    request.onabort = () => reject(new Error('已取消上传'));
    request.send(file);
  });
}
