import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { PORT, HOST, CDP_URL, CODEX_CDP_URL, EDITORS, TUNNEL, PUBLISH_REPO, CONFIG_FILE, ALLOWED_ORIGINS, loadConfig } from './config.mjs';
import { DATA_DIR, listDevices, saveState, normalizeAppUrl } from '../lib/auth.mjs';
import { startWatcher } from '../lib/notify.mjs';
import { themeFor } from '../lib/theme.mjs';
import { warmHighlighter } from '../lib/highlight.mjs';
import { Cdp } from './cdp.mjs';
import { listWindows, codexWindows } from './windows.mjs';
import { helpersCall } from './page/build.mjs';
import { handleApi } from './http/api.mjs';
import { SECURITY_HEADERS, serveApp, json, corsHeaders, originAllowed } from './http/static.mjs';
import { attachWss } from './ws.mjs';
import { preloadVoice } from './voice/service.mjs';
import { offerFirstPairing } from './util.mjs';
import { run } from './publish/pages.mjs';
import { startTunnel } from './publish/tunnel.mjs';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') {
    res.writeHead(originAllowed(req) ? 204 : 403, corsHeaders(req));
    return res.end();
  }
  // The same app also runs from GitHub Pages; there url.json holds the encrypted relay address instead.
  if (url.pathname === '/url.json') return json(req, res, 200, { self: true });
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url.pathname);
  if (req.method === 'GET' && serveApp(res, url.pathname === '/' ? 'index.html' : url.pathname)) return;
  res.writeHead(404, SECURITY_HEADERS).end('not found');
});
attachWss(server);

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

// Pages on a user site with a custom domain serves project sites from that domain too.
// Ask gh for the real address once, persist it, and allow its origin. Best effort only.
export async function detectAppUrl() {
  if (!PUBLISH_REPO || normalizeAppUrl(loadConfig().appUrl)) return;
  try {
    const u = normalizeAppUrl(await run('gh', ['api', `repos/${PUBLISH_REPO}/pages`, '--jq', '.html_url']));
    if (!u || new URL(u).origin === `https://${PUBLISH_REPO.split('/')[0].toLowerCase()}.github.io`) return;
    const cfg = loadConfig();
    cfg.appUrl = u;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    ALLOWED_ORIGINS.add(new URL(u).origin);
    console.log(`检测到自定义域名，手机 App 固定地址：${u}`);
  } catch {}
}

// Notifications follow each real Codex chat, not the single merged Codex entry.
async function watchTargets() {
  const wins = await listWindows();
  const out = wins.filter(w => w.app !== 'codex');
  for (const p of await codexWindows(CODEX_CDP_URL)) {
    if (!p.chatWs) continue;
    out.push({ id: `codex:${p.pageId}`, title: p.title, ws: p.chatWs, app: 'codex', pageId: p.pageId, kind: 'local' });
  }
  return out;
}

// Even in tunnel mode the relay listens on HOST so a browser on the same LAN can
// connect directly (auth still requires a paired device). The tunnel itself only
// needs the port reachable on loopback, which 0.0.0.0 covers.
const lanIps = () => Object.values(os.networkInterfaces()).flat()
  .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);

server.listen(PORT, HOST, async () => {
  console.log(`Remote Agent 已启动，端口 ${PORT}`);
  console.log(`数据目录：${DATA_DIR}`);
  console.log(`已配对 ${listDevices().length} 台设备。添加新设备：npm run pair`);
  detectAppUrl();
  startWatcher({
    listWindows: watchTargets,
    openCdp: async ws => { const c = new Cdp(ws); await c.connect(); return c; },
    probe: helpersCall('agentStates()'),
  });
  try {
    const wins = await listWindows();
    console.log(`已连上 ${wins.length} 个窗口：${wins.map(w => `${w.app}:${w.title}`).join(' | ')}`);
  } catch (e) {
    console.log(`!! ${e.message}`);
  }
  preloadVoice();
  // Warm the file-viewer caches (theme discovery + shiki) after startup so the
  // phone's first file open doesn't pay the one-time scan/init cost.
  setTimeout(() => {
    warmHighlighter();
    for (const e of EDITORS) {
      const port = Number(new URL(e.url || CDP_URL).port);
      themeFor(e.app, { port }).catch(() => {});
    }
  }, 2000);
  const ips = lanIps();
  for (const ip of ips) console.log(`  局域网地址：http://${ip}:${PORT}/`);
  const localUrl = ips[0] ? `http://${ips[0]}:${PORT}/` : '';
  if (TUNNEL) {
    // relayUrl stays the tunnel address for the phone; localUrl is for LAN browsers.
    if (localUrl) saveState({ localUrl });
    console.log('正在建立 Cloudflare 公网隧道…');
    startTunnel();
  } else if (localUrl) {
    saveState({ localUrl, ...(!PUBLISH_REPO ? { relayUrl: localUrl } : {}) });
    offerFirstPairing();
  }
});
