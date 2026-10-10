// Caches the app shell so the installed app opens instantly; live data (url.json, relay) always goes to the network.
const CACHE = 'remote-agent-v39';
const SHELL = ['./', 'index.html', 'i18n.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.endsWith('url.json')) return;
  // Network first so app updates show up immediately; cache only as an offline fallback.
  e.respondWith(fetch(e.request)
    .then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    })
    .catch(() => caches.match(e.request)));
});

// iOS revokes push permission if a push arrives without a visible notification, so every push shows one.
function showPush(text) {
  let d = {};
  try { d = JSON.parse(text); } catch {}
  return self.registration.showNotification(d.title || 'Remote Agent', {
    body: d.body || '',
    tag: d.win || 'remote-agent',
    renotify: true,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: { win: d.win || '' },
  });
}
self.addEventListener('push', e => e.waitUntil(showPush(e.data ? e.data.text() : '')));

// Tapping a notification opens the app on the window it came from.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const win = e.notification.data?.win || '';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const client = list[0];
    if (client) {
      client.postMessage({ openWin: win });
      return client.focus();
    }
    return self.clients.openWindow('./' + (win ? '#win=' + encodeURIComponent(win) : ''));
  }));
});
