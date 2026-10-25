// Caches the app shell so the installed app opens instantly; live data (url.json, relay) always goes to the network.
const CACHE = 'remote-agent-v236'; // keep in sync with APP_VERSION in js/core.js
const SHELL = ['./', 'index.html', 'app.css?v=236', 'i18n.js?v=212', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'logo.png',
  'js/core.js?v=236', 'js/gate.js?v=219', 'js/auth.js?v=207', 'js/net.js?v=210', 'js/sheets.js?v=236', 'js/notify.js?v=232', 'js/mode.js?v=158', 'js/chat.js?v=222',
  'js/history.js?v=235', 'js/files.js?v=167', 'js/screen.js?v=123', 'js/terminal.js?v=116', 'js/composer.js?v=221', 'js/voice.js?v=217', 'js/local-voice.js?v=207', 'js/voice-worklet.js?v=133',
  'js/transfer.js?v=207', 'js/scanner.js',
  'js/latency.js?v=142', 'js/image-editor.js?v=181',
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
  // The versioned capture processor is already precached; do not wait on the network at mic press.
  if (url.pathname.endsWith('/js/voice-worklet.js') && url.searchParams.has('v')) {
    e.respondWith(caches.open(CACHE).then(async cache => await cache.match(e.request) || fetch(e.request)));
    return;
  }
  // Network first so app updates show up immediately; cache only as an offline fallback.
  e.respondWith(fetch(e.request)
    .then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    })
    .catch(() => caches.match(e.request)));
});

const latestPushSeq = new Map();
// iOS revokes push permission if a push arrives without a visible notification, so every push shows one.
function showPush(text) {
  let d = {};
  try { d = JSON.parse(text); } catch {}
  const tag = [d.win, d.windowId, d.threadId].filter(Boolean).join('|') || 'remote-agent';
  const seq = Number(d.seq) || 0;
  if (seq && seq <= (latestPushSeq.get(tag) || 0)) return Promise.resolve();
  if (seq) latestPushSeq.set(tag, seq);
  return self.registration.showNotification(d.title || 'Remote Agent', {
    body: d.body || '',
    tag,
    renotify: true,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: { win: d.win || '', windowId: d.windowId || '', threadId: d.threadId || '', seq, createdAt: Number(d.createdAt) || 0 },
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
