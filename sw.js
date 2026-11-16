// Caches the app shell so the installed app opens instantly; live data (url.json, relay) always goes to the network.
importScripts('push-sw.js?v=478');
const CACHE_PREFIX = 'remote-agent:' + self.registration.scope + ':';
const CACHE = CACHE_PREFIX + 'v485'; // keep in sync with APP_VERSION in js/core.js
const SHELL = ['push-sw.js?v=478', 'js/shared-rules.js?v=465', 'js/ui-helpers.js?v=449', './', 'index.html',   'app.css?v=485', 'i18n.js?v=433', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'logo.png',
  'js/core.js?v=485', 'js/fusion.js?v=453', 'js/gate.js?v=430', 'js/auth.js?v=207', 'js/net.js?v=474',   'js/sheets.js?v=467', 'js/notify.js?v=484', 'js/mode.js?v=386', 'js/chat.js?v=481',
  'js/history.js?v=485', 'js/files.js?v=481', 'js/screen.js?v=382',   'js/terminal.js?v=466', 'js/composer.js?v=472', 'js/voice.js?v=449', 'js/local-voice.js?v=391', 'js/voice-worklet.js?v=133',
  'js/transfer.js?v=481', 'js/scanner.js',
  'js/latency.js?v=367', 'js/image-editor.js?v=447', 'js/overview.js?v=475',
  'markdown-it/markdown-it-15.0.3.min.js', 'js/markdown.js?v=449',
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
  'logo-fusion.svg', 'logo-opencode.svg', 'logo-opencode-dark.svg', 'logo-opencode-light.svg', 'logo-cursor-dark.svg', 'logo-cursor-light.svg',
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
