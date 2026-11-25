import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PORT, HOST, CDP_URL, CODEX_CDP_URL, EDITORS, TUNNEL, PUBLISH_REPO, ALLOWED_ORIGINS, loadConfig } from './config.mjs';
import { DATA_DIR, computerId, listDevices, saveState, saveConfig, normalizeAppUrl } from '../lib/auth.mjs';
import { startWatcher } from '../lib/notify.mjs';
import { themeFor } from '../lib/theme.mjs';
import { warmHighlighter } from '../lib/highlight.mjs';
import { listWindows, codexWindows } from './windows.mjs';
import { handleApi } from './http/api.mjs';
import { SECURITY_HEADERS, serveApp, json, corsHeaders, originAllowed } from './http/static.mjs';
import { attachWss } from './ws.mjs';
import { preloadVoice } from './voice/service.mjs';
import { offerFirstPairing } from './util.mjs';
import { run } from './publish/pages.mjs';
import { startTunnel } from './publish/tunnel.mjs';
import { startProjectWindowCleanup } from './project-windows.mjs';
import { NativeCdp, nativeWindow, nativeTargets, startNativeWindows } from './native-windows.mjs';

import { AGENT_REGISTRY } from './apps/index.mjs';
import { fusionRuntime } from './fusion/runner.mjs';
import { attachFusionPresenter } from './fusion/presenter.mjs';
import { terminalService } from './terminal-service.mjs';
import { openCode } from './opencode/state.mjs';
import { codexBackend } from './codex/state.mjs';
import { initializeUploads } from '../lib/uploads.mjs';
import { stopPeerJobs } from './peer/jobs.mjs';
import { SessionRecovery } from './ws/recovery.mjs';
import { RaCoreJournal } from './ra-core/journal.mjs';
import { createOriginRegistry } from './ra-core/origin.mjs';
import { createNodeRegistry } from './ra-core/registry.mjs';
import { createRaCoreService } from './ra-core/service.mjs';

const recovery = new SessionRecovery();
let raCore, raCoreJournal, chatgptBridge;
const remoteMcp = process.env.RA_MCP_PUBLIC_URL ? import('./integrations/ra-mcp/server.mjs')
  .then(({ createRemoteMcpServer }) => createRemoteMcpServer(process.env.RA_MCP_PUBLIC_URL)) : null;

function initializeRaCore() {
  try {
    raCoreJournal = new RaCoreJournal(DATA_DIR);
    const id = computerId();
    raCore = createRaCoreService({ journal: raCoreJournal, nodes: createNodeRegistry(id),
      origins: createOriginRegistry({ computerId: id, sessions: device => recovery.activeSessions(device),
        agents: AGENT_REGISTRY, openCode, codex: codexBackend }) });
  } catch (error) {
    raCoreJournal?.close();
    raCoreJournal = undefined;
    const sqliteCode = error.errcode & 0xff;
    const reason = sqliteCode === 5 || sqliteCode === 6 ? '无法获取操作日志的 SQLite 独占锁' : '操作日志不可用';
    console.error(`[ra-core] ${reason}，RA Core API 已停用`);
  }
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(signal, () => {
  try { chatgptBridge?.close(); } catch (error) { console.error('[chatgpt] bridge cleanup failed'); }
  raCoreJournal?.close();
  try { stopPeerJobs(); } catch (error) { console.error('[peer]', error.message); }
  terminalService.dispose();
  openCode.close();
  codexBackend.close();
  process.exit(code);
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') {
    res.writeHead(originAllowed(req) ? 204 : 403, corsHeaders(req));
    return res.end();
  }
  // The same app also runs from GitHub Pages; there url.json holds the encrypted relay address instead.
  if (remoteMcp && (url.pathname === '/mcp' || url.pathname.startsWith('/oauth/')
      || url.pathname.startsWith('/.well-known/oauth-') || url.pathname === '/.well-known/openid-configuration')) {
    try { return (await remoteMcp).handle(req, res, url); }
    catch (error) { console.error('[ra-mcp] unavailable: ' + error.message);
      return json(req, res, 503, { error: 'ra_mcp_unavailable' }); }
  }
  if (url.pathname === '/url.json') return json(req, res, 200, { self: true });
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url.pathname, raCore);
  if (req.method === 'GET' && serveApp(res, url.pathname === '/' ? 'index.html' : url.pathname)) return;
  res.writeHead(404, SECURITY_HEADERS).end('not found');
});
attachWss(server, recovery);

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const orphanUploads = initializeUploads(path.join(DATA_DIR, 'uploads'), listDevices().map(device => device.id));
if (orphanUploads.length) console.log(`未登记的旧上传目录已保留，待确认回收：${orphanUploads.join('，')}`);

// Pages on a user site with a custom domain serves project sites from that domain too.
// Ask gh for the real address once, persist it, and allow its origin. Best effort only.
export async function detectAppUrl() {
  if (!PUBLISH_REPO || normalizeAppUrl(loadConfig().appUrl)) return;
  try {
    const u = normalizeAppUrl(await run('gh', ['api', `repos/${PUBLISH_REPO}/pages`, '--jq', '.html_url']));
    if (!u || new URL(u).origin === `https://${PUBLISH_REPO.split('/')[0].toLowerCase()}.github.io`) return;
    const cfg = loadConfig();
    cfg.appUrl = u;
    saveConfig(cfg);
    ALLOWED_ORIGINS.add(new URL(u).origin);
    console.log(`检测到自定义域名，手机 App 固定地址：${u}`);
  } catch {}
}

// Notifications follow each real Codex chat, not the single merged Codex entry.
let qaNativeDiscoverySignature = '';
async function watchTargets() {
  const report = process.env.RA_MCP_TEST_ROOT ? [] : null;
  const wins = await listWindows(report);
  if (report) {
    const diagnostic = JSON.stringify(report.map(({app,windows,address,error,timeout}) => ({app,windows,address,error,timeout})));
    if (diagnostic !== qaNativeDiscoverySignature) {
      qaNativeDiscoverySignature = diagnostic;
      console.log('[ra-native-qa] ' + diagnostic);
    }
  }
  const out = wins.filter(w => w.app !== 'codex' && w.app !== 'opencode');
  for (const p of await codexWindows(CODEX_CDP_URL)) {
    if (!p.chatWs) continue;
    out.push({ id: `codex:${p.pageId}`, title: p.title, ws: p.chatWs, editorWs: p.ws, app: 'codex', pageId: p.pageId, kind: 'local' });
  }
  return out;
}

const lanIps = () => Object.values(os.networkInterfaces()).flat()
  .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);

server.listen(PORT, HOST, async () => {
  initializeRaCore();
  // Optional, local-only integration. An owner-approved policy is required.
  // Normal RA startup exposes no additional service or tools by default.
  if (process.env.RA_CHATGPT_CONFIG) {
    try {
      const { startChatgptBridge } = await import('./integrations/chatgpt/bridge.mjs');
      chatgptBridge = await startChatgptBridge(process.env.RA_CHATGPT_CONFIG);
      console.log('[chatgpt] private Unix socket bridge ready');
    } catch (error) { console.error('[chatgpt] bridge disabled: ' + (error.code || 'policy_or_startup_error')); }
  }
  console.log(`Remote Agent 已启动，端口 ${PORT}`);
  console.log(`数据目录：${DATA_DIR}`);
  console.log(`已配对 ${listDevices().length} 台设备。添加新设备：npm run pair`);
  detectAppUrl();
  startProjectWindowCleanup();
  startNativeWindows(watchTargets);
  attachFusionPresenter();
  fusionRuntime.initialize({ adapterRegistry: AGENT_REGISTRY });
  startWatcher({
    listWindows: () => [...nativeTargets(), ...(codexBackend.threads.size ? [{ id: 'codex:backend', pageId: 'backend', title: 'Codex', app: 'codex', ws: 'codex-backend', kind: 'api' }] : [])],
    openCdp: async ws => {
      if (ws === 'codex-backend') return { backend: true, close() {} };
      const c = new NativeCdp(ws); await c.connect(); return c;
    },
    readStates: async cdp => cdp.backend ? codexBackend.states().filter(row => !codexBackend.phoneControl(row.thread)) : (await nativeWindow(cdp).read()).states,
  });
  try {
    const wins = await listWindows();
    if (wins.some(win => win.app === 'opencode')) await openCode.connect();
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
  const addresses = HOST === '0.0.0.0' || HOST === '::' ? lanIps() : [HOST];
  const urls = addresses.map(host => `http://${host.includes(':') ? '[' + host + ']' : host}:${PORT}/`);
  const [localUrl = ''] = urls;
  for (const url of urls) console.log(`  本地入口：${url}`);
  if (TUNNEL) {
    saveState({ localUrl });
    console.log('正在建立 Cloudflare 公网隧道…');
    startTunnel();
  } else if (localUrl) {
    saveState({ localUrl, ...(!PUBLISH_REPO ? { relayUrl: localUrl } : {}) });
    offerFirstPairing();
  }
});
