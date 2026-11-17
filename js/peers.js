const peerStates = new Map();
let peerBusy = '', peerMessage = '';

function peerEntries() { return ovList.filter(entry => entry.c && !entry.foreign); }
function peerComputer(entry) { return computerSockets.get(entry.c.key)?.computer || entry.c; }
function peerOnline(entry) { const link = computerSockets.get(entry.c.key); return !!link?.authed && link.socket?.readyState === 1; }
function peerRender() { if (ovS.level === 'peers') ovRender(); }

async function peerRequest(computer, path, body) {
  const response = body === undefined ? await api(path, { computer, timeout: 30000 })
    : await post(path, body, { computer, timeout: 30000 });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || ovT('操作失败'));
  return result;
}

function refreshPeers() {
  for (const entry of peerEntries()) {
    if (!peerOnline(entry) || peerStates.get(entry.id)?.loading) continue;
    const previous = peerStates.get(entry.id);
    peerStates.set(entry.id, { ...previous, loading: true, error: '' });
    peerRequest(peerComputer(entry), '/api/peers').then(result => {
      peerStates.set(entry.id, { peers: result.peers, loading: false, error: '' });
    }, error => {
      peerStates.set(entry.id, { ...previous, loading: false, error: error.message });
    }).finally(peerRender);
  }
}

async function peerVerifiedIdentity(entry) {
  const computer = peerComputer(entry), nonce = authB64(crypto.getRandomValues(new Uint8Array(16)));
  const result = await peerRequest(computer, '/api/peers/identity?nonce=' + nonce);
  const der = b64(result.certificate.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, ''));
  const hash = await crypto.subtle.digest('SHA-256', der);
  const fingerprint = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
  const key = await crypto.subtle.importKey('raw', b64u(computer.key), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const payload = JSON.stringify(['ra-peer-identity-v1', entry.id, nonce, fingerprint]);
  const valid = await crypto.subtle.verify('HMAC', key, b64u(result.mac), new TextEncoder().encode(payload));
  if (!valid || result.id !== entry.id || result.nonce !== nonce || result.fingerprint !== fingerprint)
    throw new Error(ovT('电脑身份校验失败'));
  return { id: entry.id, name: entry.name, fingerprint, certificate: result.certificate,
    discovery: computer.discovery || discoveryUrl(), address: computer.relay || new URL(computer.discovery || discoveryUrl()).origin };
}

async function enablePeer(a, b) {
  const identities = await Promise.all([peerVerifiedIdentity(a), peerVerifiedIdentity(b)]);
  const computers = identities.map(({ certificate, ...row }) => row);
  const payload = JSON.stringify({ v: 1, kind: 'ra-peer-link-v1', nonce: authB64(crypto.getRandomValues(new Uint8Array(16))),
    expires: Date.now() + 60000, computers });
  const signature = await entrySign(payload);
  const certificates = Object.fromEntries(identities.map(row => [row.id, row.certificate]));
  const grants = await Promise.all([a, b].map(entry => peerRequest(peerComputer(entry), '/api/peers/grant', { payload, signature, certificates })));
  await peerRequest(peerComputer(a), '/api/peers/connect', { id: b.id });
  const errors = grants.flatMap((grant, index) => grant.codex?.ready === false ? [`${[a, b][index].name}: ${grant.codex.error}`] : []);
  peerMessage = ovT('两台电脑已连接') + (errors.length ? ' · Codex: ' + errors.join('；') : '');
}

async function revokePeer(a, b) {
  const targets = [[a, b], [b, a]].filter(([owner, other]) => peerOnline(owner)
    && peerStates.get(owner.id)?.peers?.some(peer => peer.id === other.id));
  const results = await Promise.all(targets.map(async ([owner, other]) => {
    const peer = peerStates.get(owner.id).peers.find(row => row.id === other.id);
    const payload = JSON.stringify({ v: 1, kind: 'ra-peer-revoke-v1', id: other.id, grantId: peer.grantId, expires: Date.now() + 60000 });
    return peerRequest(peerComputer(owner), '/api/peers/revoke', { payload, signature: await entrySign(payload) });
  }));
  peerMessage = peerOnline(a) && peerOnline(b) ? ovT('已撤销互控授权') : ovT('离线电脑尚未撤销，请上线后再次撤销');
  const errors = results.flatMap((result, index) => result.codex?.ready === false ? [`${targets[index][0].name}: ${result.codex.error}`] : []);
  if (errors.length) peerMessage += ' · Codex: ' + errors.join('；');
}

function peerBoard() {
  const entries = peerEntries(), pairs = [];
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) pairs.push([entries[i], entries[j]]);
  const description = `<p class="peer-description">${ovT('授权后，两台电脑可通过各自的系统账号执行对方的命令。')}</p>`;
  if (!pairs.length) return `<section class="peer-board">${description}<p class="hint">${ovT('请先在此入口配对至少两台电脑。')}</p></section>`;
  return `<section class="peer-board">${description}${peerMessage ? `<p class="peer-message">${esc(peerMessage)}</p>` : ''}${pairs.map(([a, b]) => {
    const left = peerStates.get(a.id), right = peerStates.get(b.id), online = peerOnline(a) && peerOnline(b);
    const one = left?.peers?.some(peer => peer.id === b.id), two = right?.peers?.some(peer => peer.id === a.id);
    const label = !online ? ovT('电脑离线') : left?.loading || right?.loading || !left || !right ? ovT('正在读取…')
      : left.error || right.error ? ovT('读取失败') : one && two ? ovT('已授权') : one || two ? ovT('部分授权') : ovT('未启用');
    const disabled = peerBusy || !online || left?.loading || right?.loading || !left || !right || left.error || right.error;
    return `<article class="peer-card"><div><strong class="ovRaw">${esc(a.name)} ↔ ${esc(b.name)}</strong><small>${esc(label)}</small></div><div class="peer-actions">`
      + (one && two ? `<button data-peer="connect" data-a="${esc(a.id)}" data-b="${esc(b.id)}"${disabled ? ' disabled' : ''}>${ovT('连接')}</button>`
        : `<button class="peer-primary" data-peer="enable" data-a="${esc(a.id)}" data-b="${esc(b.id)}"${disabled ? ' disabled' : ''}>${ovT('启用')}</button>`)
      + (one || two ? `<button data-peer="revoke" data-a="${esc(a.id)}" data-b="${esc(b.id)}"${peerBusy ? ' disabled' : ''}>${ovT('撤销')}</button>` : '')
      + '</div></article>';
  }).join('')}<button class="peer-refresh" data-peer="refresh">${ovT('刷新状态')}</button></section>`;
}

$('overview').addEventListener('click', async event => {
  const button = event.target.closest('[data-peer]');
  if (!button || peerBusy) return;
  if (button.dataset.peer === 'refresh') { peerMessage = ''; refreshPeers(); peerRender(); return; }
  const entries = peerEntries(), a = entries.find(entry => entry.id === button.dataset.a), b = entries.find(entry => entry.id === button.dataset.b);
  if (!a || !b) return;
  peerBusy = button.dataset.peer; peerMessage = ovT('正在处理…'); peerRender();
  try {
    if (peerBusy === 'enable') await enablePeer(a, b);
    else if (peerBusy === 'revoke') await revokePeer(a, b);
    else { await peerRequest(peerComputer(a), '/api/peers/connect', { id: b.id }); peerMessage = ovT('两台电脑已连接'); }
  } catch (error) { peerMessage = error.message; }
  finally { peerBusy = ''; refreshPeers(); peerRender(); }
});
