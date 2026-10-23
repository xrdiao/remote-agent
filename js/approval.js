const credential = location.hash.slice(1) || sessionStorage.getItem('ra-approval');
if (credential) sessionStorage.setItem('ra-approval', credential);
history.replaceState(null, '', location.pathname);
const $ = id => document.getElementById(id);
let timer, rows = [], busy = false;
async function request(path, body) {
  const r = await fetch('/api/approval/' + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Approval ' + credential, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store' });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '授权操作失败');
  return data;
}
async function refresh() {
  clearTimeout(timer);
  if (busy) return;
  try {
    const data = await request('requests');
    const selected = new Set([...document.querySelectorAll('input[data-request]:checked')].map(e => e.dataset.request));
    rows = data.requests;
    $('requests').replaceChildren(...rows.map(row => {
      const article = document.createElement('article'), label = document.createElement('label'), input = document.createElement('input');
      input.type = 'checkbox'; input.dataset.request = row.id; input.checked = selected.has(row.id);
      label.append(input, document.createTextNode(' ' + row.name));
      const origin = document.createElement('p'); origin.textContent = '入口：' + (row.origin || '未提供来源');
      const code = document.createElement('strong'); code.textContent = row.code;
      article.append(label, origin, code); return article;
    }));
    $('status').textContent = rows.length ? '请逐项核对验证码后勾选。' : '等待新入口申请…';
    timer = setTimeout(refresh, 2000);
  } catch (error) { $('status').textContent = error.message; }
}
async function decide(approve) {
  if (busy) return;
  const ids = new Set([...document.querySelectorAll('input[data-request]:checked')].map(e => e.dataset.request));
  const selections = rows.filter(r => ids.has(r.id)).map(({ id, code }) => ({ id, code }));
  if (!selections.length) { $('status').textContent = '请先核对并勾选入口。'; return; }
  if (approve && !$('name').value.trim()) { $('status').textContent = '请填写设备名称。'; $('name').focus(); return; }
  busy = true; clearTimeout(timer);
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  try { await request('decide', { selections, approve, name: $('name').value }); }
  catch (error) { $('status').textContent = error.message; return; }
  finally { busy = false; for (const button of document.querySelectorAll('button')) button.disabled = false; }
  await refresh();
}
$('approve').onclick = () => decide(true);
$('deny').onclick = () => decide(false);
$('refresh').onclick = refresh;
$('close').onclick = async () => {
  clearTimeout(timer);
  try { await request('close', {}); sessionStorage.removeItem('ra-approval'); $('requests').replaceChildren(); $('status').textContent = '本次授权已结束。'; for (const button of document.querySelectorAll('button')) button.disabled = true; }
  catch (error) { $('status').textContent = error.message; }
};
if (credential) refresh(); else $('status').textContent = '请在电脑上运行 npm run pair，打开其中的电脑授权页面。';
