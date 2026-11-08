// Caches the app shell so the installed app opens instantly; live data (url.json, relay) always goes to the network.
const CACHE_PREFIX = 'remote-agent:' + self.registration.scope + ':';
const CACHE = CACHE_PREFIX + 'v424'; // keep in sync with APP_VERSION in js/core.js
const NOTICES = CACHE_PREFIX + 'notices';
const SHELL = ['./', 'index.html', 'app.css?v=421', 'i18n.js?v=424', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'logo.png',
  'js/core.js?v=424', 'js/fusion.js?v=424', 'js/gate.js?v=382', 'js/auth.js?v=207', 'js/net.js?v=413', 'js/sheets.js?v=424', 'js/notify.js?v=424', 'js/mode.js?v=386', 'js/chat.js?v=416',
  'js/history.js?v=421', 'js/files.js?v=375', 'js/screen.js?v=382', 'js/terminal.js?v=392', 'js/composer.js?v=407', 'js/voice.js?v=356', 'js/local-voice.js?v=391', 'js/voice-worklet.js?v=133',
  'js/transfer.js?v=388', 'js/scanner.js',
  'js/latency.js?v=367', 'js/image-editor.js?v=379', 'js/overview.js?v=424',
  'markdown-it/markdown-it-15.0.3.min.js', 'js/markdown.js?v=295',
  'vendor/xterm.js?v=6.0.0', 'vendor/xterm.css?v=6.0.0',
  'katex/katex.min.js', 'katex/katex.min.css',
  'katex/fonts/KaTeX_AMS-Regular.woff2', 'katex/fonts/KaTeX_Caligraphic-Bold.woff2',
  'katex/fonts/KaTeX_Caligraphic-Regular.woff2', 'katex/fonts/KaTeX_Fraktur-Bold.woff2',
  'katex/fonts/KaTeX_Fraktur-Regular.woff2', 'katex/fonts/KaTeX_Main-Bold.woff2',
  'katex/fonts/KaTeX_Main-BoldItalic.woff2', 'katex/fonts/KaTeX_Main-Italic.woff2',
  'katex/fonts/KaTeX_Main-Regular.woff2', 'katex/fonts/KaTeX_Math-BoldItalic.woff2',
  'katex/fonts/KaTeX_Math-Italic.woff2', 'katex/fonts/KaTeX_SansSerif-Bold.woff2',
  'katex/fonts/KaTeX_SansSerif-Italic.woff2', 'katex/fonts/KaTeX_SansSerif-Regular.woff2',
  'katex/fonts/KaTeX_Script-Regular.woff2', 'katex/fonts/KaTeX_Size1-Regular.woff2',
  'katex/fonts/KaTeX_Size2-Regular.woff2', 'katex/fonts/KaTeX_Size3-Regular.woff2',
  'katex/fonts/KaTeX_Size4-Regular.woff2', 'katex/fonts/KaTeX_Typewriter-Regular.woff2',
  'logo-fusion.svg', 'logo-cursor-dark.svg', 'logo-cursor-light.svg',
  'logo-devin-dark.svg', 'logo-devin-light.svg',
  'logo-codex-dark.svg', 'logo-codex-light.svg'];
const SHELL_ASSETS = new Set(SHELL.filter(path => path !== './' && path !== 'index.html').map(path => new URL(path, self.registration.scope).href));

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(path => new Request(path, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith(CACHE_PREFIX + 'v') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
    .then(() => self.clients.matchAll({ type: 'window' }))
    .then(clients => clients.forEach(client => client.postMessage({ appVersion: CACHE.slice(CACHE_PREFIX.length) }))));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.endsWith('url.json')) return;
  const entry = e.request.mode === 'navigate' || url.pathname.endsWith('/index.html');
  e.respondWith((async () => {
    // The current shell is installed as one version; a slow network must not delay its cached assets.
    if (!entry && SHELL_ASSETS.has(url.href)) {
      const cached = await (await caches.open(CACHE)).match(e.request);
      if (cached) return cached;
    }
    return fetch(e.request, entry ? { cache: 'no-cache' } : undefined)
    .then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    })
    .catch(() => caches.open(CACHE).then(cache => cache.match(e.request)));
  })());
});

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
  const tag = [d.computer, d.win, d.windowId, d.threadId].filter(Boolean).join('|') || 'remote-agent';
  const seq = Number(d.seq) || 0;
  const cache = await caches.open(NOTICES);
  const key = new URL('__push_seq__?tag=' + encodeURIComponent(tag), self.registration.scope).href;
  const previous = await cache.match(key);
  if (seq && seq <= Number(previous ? await previous.text() : 0)) return;
  await self.registration.showNotification(d.title || 'Remote Agent', {
    body: d.body || '',
    tag,
    renotify: true,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: { computer: d.computer || '', win: d.win || '', windowId: d.windowId || '', threadId: d.threadId || '', seq, createdAt: Number(d.createdAt) || 0 },
  });
  if (seq) await cache.put(key, new Response(String(seq)));
}
self.addEventListener('push', e => e.waitUntil(showPush(e.data ? e.data.text() : '')));

// Tapping a notification opens that window and thread. Receiving the push does not.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  const payload = JSON.stringify({ computer: data.computer || '', win: data.win || '', windowId: data.windowId || '', threadId: data.threadId || '' });
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const entry = new URL(self.registration.scope);
    const client = list.find(client => {
      const url = new URL(client.url);
      return url.origin === entry.origin && (url.pathname === entry.pathname || url.pathname === entry.pathname + 'index.html');
    });
    if (client) {
      client.postMessage({ openWin: payload });
      return client.focus();
    }
    return self.clients.openWindow(self.registration.scope + '#win=' + encodeURIComponent(payload));
  }));
});
