// Shared notification delivery for the app worker and per-computer push workers.
importScripts('js/shared-rules.js?v=465');
const PUSH_ENTRY = new URL('./', self.location.href).href;
const NOTICES = 'remote-agent:' + self.registration.scope + ':notices';

let pushTask = Promise.resolve();
// iOS revokes push permission if a push arrives without a visible notification, so every push shows one.
function showPush(text) {
  const task = pushTask.then(() => deliverPush(text));
  pushTask = task.catch(() => {});
  return task;
}
async function deliverPush(text) {
  let d = {};
  try { d = JSON.parse(text); } catch {}
  const tag = RemoteAgentRules.notificationKey(d, true) || 'remote-agent';
  const seq = Number(d.seq) || 0;
  const cache = await caches.open(NOTICES);
  const key = new URL('__push_seq__?tag=' + encodeURIComponent(tag), self.registration.scope).href;
  const previous = await cache.match(key);
  if (seq && seq <= Number(previous ? await previous.text() : 0)) return;
  await self.registration.showNotification(d.title || 'Remote Agent', {
    body: d.body || '',
    tag,
    renotify: true,
    icon: PUSH_ENTRY + 'icon-192.png',
    badge: PUSH_ENTRY + 'icon-192.png',
    data: { ...RemoteAgentRules.notificationTarget(d), seq, createdAt: Number(d.createdAt) || 0 },
  });
  if (seq) await cache.put(key, new Response(String(seq)));
}
self.addEventListener('push', e => e.waitUntil(showPush(e.data ? e.data.text() : '')));

// Tapping a notification opens that window and thread. Receiving the push does not.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  const payload = JSON.stringify(RemoteAgentRules.notificationTarget(data));
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const entry = new URL(PUSH_ENTRY);
    const client = list.find(client => {
      const url = new URL(client.url);
      return url.origin === entry.origin && (url.pathname === entry.pathname || url.pathname === entry.pathname + 'index.html');
    });
    if (client) {
      client.postMessage({ openWin: payload });
      return client.focus();
    }
    return self.clients.openWindow(PUSH_ENTRY + '#win=' + encodeURIComponent(payload));
  }));
});
