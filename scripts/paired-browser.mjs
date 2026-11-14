import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Cdp } from '../server/cdp.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const LOGS = path.join(ROOT, '_shots/paired-browser');
const local = value => path.resolve(ROOT, value);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function probe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`${new URL(url).pathname}: HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return null;
    throw error;
  }
}

async function until(read, label) {
  const deadline = Date.now() + 15000;
  do {
    const value = await read();
    if (value) return value;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`${label}未就绪；未创建新配对`);
}

async function checkIdentity(config) {
  await Promise.all([
    fs.promises.access(path.join(local(config.browser.profile), 'Local State')),
    fs.promises.access(path.join(local(config.relay.dataDir), 'devices.json')),
    fs.promises.access(path.join(local(config.relay.dataDir), 'url-key')),
  ]);
}

async function launch(executable, args, env, name) {
  fs.mkdirSync(LOGS, { recursive: true });
  const log = fs.openSync(path.join(LOGS, name + '.log'), 'a');
  const child = spawn(executable, args, { cwd: ROOT, env: { ...process.env, ...env }, detached: true, windowsHide: true, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(child.pid); });
  });
}

async function verifyPage(config, version) {
  const endpoint = `http://127.0.0.1:${config.browser.port}`;
  const pages = await probe(endpoint + '/json/list');
  let target = pages.find(page => page.type === 'page' && page.url.startsWith(config.appUrl) && !page.url.includes('/approve.html'));
  let navigate = false;
  if (!target) {
    const browser = new Cdp(version.webSocketDebuggerUrl);
    await browser.connect();
    try {
      const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
      target = await until(async () => (await probe(endpoint + '/json/list')).find(page => page.id === targetId), '验收标签');
      navigate = true;
    } finally { browser.close(); }
  }
  const page = new Cdp(target.webSocketDebuggerUrl);
  await page.connect();
  try {
    await page.send('Page.enable');
    await page.send('Page.bringToFront');
    if (navigate || !await page.evaluate(`typeof APP_VERSION === 'string'`)) await page.send('Page.navigate', { url: config.appUrl });
    else await page.evaluate(`if (typeof resumeComputerConnections === 'function') resumeComputerConnections(); true;`);
    const state = await until(async () => {
      const result = await page.evaluate(`({authenticated: typeof authed !== 'undefined' && authed && typeof ws !== 'undefined' && ws?.readyState === 1,
        version: typeof APP_VERSION === 'string' ? APP_VERSION : null, computerCount: typeof ovList === 'undefined' ? 0 : ovList.length})`);
      return result.authenticated ? result : null;
    }, '原配对认证');
    return { ...state, targetId: target.id };
  } finally { page.close(); }
}

export async function ensurePairedBrowser(config, runtime = {}) {
  const io = { probe, launch, checkIdentity, verifyPage, ...runtime };
  await io.checkIdentity(config);
  const started = { relay: false, browser: false }, pids = { relay: null, browser: null };
  const relayUrl = new URL('/url.json', config.appUrl).href;
  if (!await io.probe(relayUrl)) {
    pids.relay = await io.launch(process.execPath, config.relay.args, config.relay.env, 'relay');
    started.relay = true;
    await until(() => io.probe(relayUrl), '原隔离验收服务');
  }
  const browserUrl = `http://127.0.0.1:${config.browser.port}/json/version`;
  let version = await io.probe(browserUrl);
  if (!version) {
    pids.browser = await io.launch(config.browser.executable, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${config.browser.port}`,
      `--user-data-dir=${local(config.browser.profile)}`, 'about:blank'], {}, 'chrome');
    started.browser = true;
    version = await until(() => io.probe(browserUrl), '原配对浏览器');
  }
  const page = await io.verifyPage(config, version);
  if (!page.authenticated) throw new Error('原配对认证未恢复；未创建新配对');
  return { browserPort: config.browser.port, appOrigin: new URL(config.appUrl).origin, started, pids, ...page, newPairing: false };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const registry = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, '_shots/paired-browser.json');
    const result = await ensurePairedBrowser(JSON.parse(await fs.promises.readFile(registry, 'utf8')));
    fs.mkdirSync(LOGS, { recursive: true });
    await fs.promises.writeFile(path.join(LOGS, 'runtime.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
