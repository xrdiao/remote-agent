// Caches the app shell so the installed app opens instantly; live data (url.json, relay) always goes to the network.
const CACHE = 'remote-agent-v101';
const SHELL = ['./', 'index.html', 'app.css?v=100', 'i18n.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'js/core.js?v=92', 'js/gate.js', 'js/net.js?v=100', 'js/sheets.js?v=101', 'js/notify.js?v=98', 'js/mode.js', 'js/chat.js?v=87',
  'js/history.js?v=101', 'js/files.js', 'js/screen.js?v=87', 'js/terminal.js', 'js/composer.js?v=100', 'js/voice.js?v=99',
  'js/scanner.js',
  'js/latency.js', 'js/image-editor.js?v=97',
  'logo-cursor-dark.svg', 'logo-cursor-light.svg',
  'logo-devin-dark.svg', 'logo-devin-light.svg',
  'logo-codex-dark.svg', 'logo-codex-light.svg'];

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
  const tag = [d.win, d.windowId, d.threadId].filter(Boolean).join('|') || 'remote-agent';
  return self.registration.showNotification(d.title || 'Remote Agent', {
    body: d.body || '',
    tag,
    renotify: true,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: { win: d.win || '', windowId: d.windowId || '', threadId: d.threadId || '' },
  });
}
self.addEventListener('push', e => e.waitUntil(showPush(e.data ? e.data.text() : '')));

// Tapping a notification opens that window and thread. Receiving the push does not.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  const payload = JSON.stringify({ win: data.win || '', windowId: data.windowId || '', threadId: data.threadId || '' });
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const client = list[0];
    if (client) {
      client.postMessage({ openWin: payload });
      return client.focus();
    }
    return self.clients.openWindow('./#win=' + encodeURIComponent(payload));
  }));
});
