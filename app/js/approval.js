const credential = location.hash.slice(1) || sessionStorage.getItem('ra-approval');
if (credential) sessionStorage.setItem('ra-approval', credential);
history.replaceState(null, '', location.pathname);
const $ = id => document.getElementById(id);
$('language').value = I18N.lang;
$('language').onchange = () => I18N.set($('language').value);
document.title = 'Remote Agent · ' + I18N.tr('设备配对');
let timer, clock, expires = 0, rowsKey = '', busy = false, ended = false;
async function request(path, body) {
  const r = await fetch('/api/approval/' + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Approval ' + credential, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store' });
  const data = await r.json();
  if (!r.ok) { if (r.status === 401) end(data.error); throw new Error(data.error || '授权操作失败'); }
  return data;
}
function end(message = '本次配对已结束。') {
  ended = true; clearTimeout(timer); clearInterval(clock);
  sessionStorage.removeItem('ra-approval');
  $('status').textContent = message;
  for (const button of document.querySelectorAll('button')) button.disabled = true;
}
function tick() {
  const seconds = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
  $('countdown').textContent = String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  if (!seconds) end('本次配对已到时，已批准的入口仍可连接。');
}
function drawQr(modules) {
  const canvas = $('qr'), size = modules.length + 8, scale = 4;
  canvas.width = canvas.height = size * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) ctx.fillRect((x + 4) * scale, (y + 4) * scale, scale, scale); }));
}
async function refresh() {
  clearTimeout(timer);
  if (busy || ended) return;
  try {
    const data = await request('requests');
    if (busy || ended) return;
    $('groupName').textContent = data.groupName;
    const key = JSON.stringify(data.requests);
    if (key !== rowsKey) {
      rowsKey = key;
      $('requests').replaceChildren(...data.requests.map(row => {
        const article = document.createElement('article'), name = document.createElement('strong');
        name.textContent = row.name;
        const origin = document.createElement('p'); origin.textContent = (row.origin || I18N.tr('未提供来源')) + ' · ' + I18N.tr(row.groupName);
        const actions = document.createElement('div'); actions.className = 'actions';
        const code = document.createElement('span'); code.className = 'code'; code.textContent = row.code;
        const buttons = document.createElement('div');
        for (const approve of [false, true]) {
          const button = document.createElement('button');
          button.textContent = approve ? '允许连接' : '拒绝';
          button.className = approve ? 'allow' : 'deny'; button.dataset.request = row.id;
          button.onclick = () => perform('decide', { selections: [{ id: row.id, code: row.code }], approve });
          buttons.append(button);
        }
        actions.append(code, buttons); article.append(name, origin, actions); return article;
      }));
    }
    $('status').textContent = data.requests.length ? '核对手机验证码后，点击「允许连接」。' : '等待新入口申请…';
  } catch (error) { $('status').textContent = error.message; }
  finally { if (!busy && !ended) timer = setTimeout(refresh, 2000); }
}
async function perform(path, body) {
  if (busy || ended) return;
  busy = true; clearTimeout(timer);
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  try {
    await request(path, body);
    if (path === 'close') { end(); return; }
  } catch (error) { $('status').textContent = error.message; return; }
  finally { busy = false; for (const button of document.querySelectorAll('button')) button.disabled = ended; if (!ended) timer = setTimeout(refresh, 2000); }
  await refresh();
}
$('next').onclick = () => perform('next', {});
$('refresh').onclick = refresh;
$('close').onclick = () => perform('close', {});
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('pairingCode').value); $('status').textContent = '配对码已复制。'; }
  catch { $('pairingCode').select(); $('status').textContent = '请复制已选中的配对码。'; }
};
async function start() {
  if (!credential) return end('请在电脑上运行 npm run pair。');
  try {
    const data = await request('info');
    expires = data.expires;
    $('pairingCode').value = data.pairingCode;
    $('groupName').textContent = data.groupName;
    drawQr(data.qr); clock = setInterval(tick, 1000); tick();
    await refresh();
  } catch (error) { $('status').textContent = error.message; if (!ended) timer = setTimeout(start, 2000); }
}
start();
