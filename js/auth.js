/* Each origin owns its signing key. Only the public key leaves this entry. */
const authB64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
let entryKeyPromise;
function entryKey() {
  if (entryKeyPromise) return entryKeyPromise;
  entryKeyPromise = (async () => {
    if (window.AgentRemoteApp?.setNotify) {
      if (!window.AgentRemoteApp.authPublicKey) throw new Error('请更新安卓 App 后重新配对');
      const publicKey = window.AgentRemoteApp.authPublicKey();
      if (!publicKey) throw new Error('无法读取入口密钥');
      return { publicKey, native: true };
    }
    if (!crypto.subtle) throw new Error('密钥认证需要 HTTPS，请使用固定入口或 HTTPS 隧道');
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('remote-agent-entry-key', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('keys');
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    try {
      const saved = await new Promise((resolve, reject) => {
        const req = db.transaction('keys').objectStore('keys').get('entry');
        req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
      });
      if (saved) return saved;
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const generated = { privateKey: pair.privateKey, publicKey: authB64(await crypto.subtle.exportKey('spki', pair.publicKey)) };
      // The transaction makes two tabs opening this entry share the same stored key.
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('keys', 'readwrite'), store = tx.objectStore('keys'), req = store.get('entry');
        let key;
        req.onsuccess = () => { key = req.result || generated; if (!req.result) store.put(key, 'entry'); };
        tx.oncomplete = () => resolve(key); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  })();
  entryKeyPromise.catch(() => { entryKeyPromise = null; });
  return entryKeyPromise;
}
async function entryProof(computer, scope) {
  const key = await entryKey();
  const ts = Date.now(), nonce = authB64(crypto.getRandomValues(new Uint8Array(16)));
  const id = computer.id || await computerIdFromKey(computer.key);
  const payload = ['ra-entry-v1', id, computer.token, scope, ts, nonce].join('\n');
  const signature = key.native ? window.AgentRemoteApp.authSign(payload)
    : authB64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, new TextEncoder().encode(payload)));
  if (!signature) throw new Error('入口签名失败，请重新打开入口');
  return { ts, nonce, signature };
}
async function entryHeaders(computer, method, path) {
  if (!computer?.token) return {};
  const proof = await entryProof(computer, method + ' ' + path);
  return { authorization: 'Bearer ' + computer.token, 'x-ra-proof': authB64(new TextEncoder().encode(JSON.stringify(proof))) };
}
