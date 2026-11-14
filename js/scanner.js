/* Browser scanner: decode camera frames or local photos, then use the existing pairing handler. */
let scannerStream = null, scannerTimer = 0, scannerSession = 0;
let qrReader = null;
const scannerCanvas = document.createElement('canvas');
const scannerContext = scannerCanvas.getContext('2d', { willReadFrequently: true });
function loadQrReader() {
  if (!qrReader) qrReader = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'vendor/jsQR.js';
    script.onload = resolve;
    script.onerror = () => { script.remove(); qrReader = null; reject(new Error('二维码识别组件加载失败，请重试')); };
    document.head.append(script);
  });
  return qrReader;
}
function scannerStatus(message) { $('scannerMessage').textContent = I18N.tr(message); }
function closeScanner() {
  scannerSession++;
  clearTimeout(scannerTimer);
  scannerStream?.getTracks().forEach(track => track.stop());
  scannerStream = null;
  $('scannerVideo').srcObject = null;
  $('scanner').hidden = true;
}
function readQrImage(image, width, height, limit) {
  const scale = Math.min(1, limit / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  if (scannerCanvas.width !== w) scannerCanvas.width = w;
  if (scannerCanvas.height !== h) scannerCanvas.height = h;
  scannerContext.drawImage(image, 0, 0, w, h);
  return jsQR(scannerContext.getImageData(0, 0, w, h).data, w, h)?.data || '';
}
function acceptScannedPair(value, session) {
  if (session !== scannerSession || $('scanner').hidden) return;
  closeScanner();
  pastePair(value);
}
async function openScanner() {
  closeScanner();
  const session = scannerSession;
  $('scanner').hidden = false;
  scannerStatus('正在打开相机…');
  try {
    await loadQrReader();
    if (session !== scannerSession) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } });
    if (session !== scannerSession) { stream.getTracks().forEach(track => track.stop()); return; }
    scannerStream = stream;
    const video = $('scannerVideo');
    video.srcObject = stream;
    await video.play();
    if (session !== scannerSession) return;
    scannerStatus('');
    const frame = () => {
      if (session !== scannerSession) return;
      if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
        const result = readQrImage(video, video.videoWidth, video.videoHeight, 800);
        if (result) return acceptScannedPair(result, session);
      }
      scannerTimer = setTimeout(frame, 200);
    };
    frame();
  } catch (error) {
    if (session !== scannerSession) return;
    scannerStream?.getTracks().forEach(track => track.stop());
    scannerStream = null;
    scannerStatus(error.name === 'NotAllowedError' ? '相机权限未开启，可允许相机访问或从相册识别' : '相机暂不可用，可从相册识别或手动输入配对码');
  }
}
$('scannerBack').onclick = closeScanner;
$('scannerManual').onclick = () => { closeScanner(); $('gateInput').focus(); };
$('scannerAlbum').onclick = () => $('scannerFile').click();
$('scannerFile').onchange = async () => {
  const file = $('scannerFile').files[0];
  $('scannerFile').value = '';
  if (!file) return;
  const session = scannerSession;
  scannerStatus('正在识别…');
  const url = URL.createObjectURL(file);
  try {
    await loadQrReader();
    const image = new Image();
    image.src = url;
    await image.decode();
    if (session !== scannerSession || $('scanner').hidden) return;
    const result = readQrImage(image, image.naturalWidth, image.naturalHeight, 1800);
    if (result) acceptScannedPair(result, session);
    else scannerStatus('图片中未识别到二维码，请选择清晰的二维码图片');
  } catch {
    if (session === scannerSession && !$('scanner').hidden) scannerStatus('图片读取失败，请重新选择');
  } finally { URL.revokeObjectURL(url); }
};
window.addEventListener('pagehide', closeScanner);
