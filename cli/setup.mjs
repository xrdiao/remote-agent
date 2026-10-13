// Interactive first-run setup: checks dependencies, creates the GitHub Pages app, installs the service.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, normalizeAppUrl } from '../lib/auth.mjs';
import { appFiles, putFile, remoteShas, gitBlobSha } from '../server/publish/pages.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const isMac = process.platform === 'darwin';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q, def = '') => (await rl.question(def ? `${q} [${def}] ` : `${q} `)).trim() || def;
const yes = async (q, def = 'y') => /^y/i.test(await ask(`${q} (y/n)`, def));
const has = cmd => (process.platform === 'win32' ? spawnSync('where', [cmd]) : spawnSync('sh', ['-c', `command -v ${cmd}`])).status === 0;
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
// readline keeps the TTY in raw mode even when paused; child prompts need cooked mode to see Enter.
const interactive = (cmd, args) => {
  rl.pause();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  const r = run(cmd, args, { stdio: 'inherit' });
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  rl.resume();
  return r;
};

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const config = (() => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; } })();
const saveConfig = () => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });

console.log('\n== Remote Agent 安装向导 ==\n');

console.log('1/4 检查依赖');
const missing = [];
if (!has('cloudflared')) missing.push(['cloudflared', isMac ? 'brew install cloudflared' : 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/']);
if (!has('gh')) missing.push(['gh', isMac ? 'brew install gh' : 'https://cli.github.com/']);
for (const [name, how] of missing) console.log(`  缺少 ${name}：${how}`);
if (missing.length && !await yes('  缺少的工具只影响「外网访问 / 固定地址」，是否继续？')) process.exit(1);
if (!missing.length) console.log('  cloudflared、gh 都已安装');

console.log('\n2/4 固定地址（手机 App）');
console.log('  在你的 GitHub 上建一个公开仓库，用 GitHub Pages 托管手机 App。');
console.log('  仓库里只有 App 页面和加密过的电脑地址；解密钥匙只在配对时交给你的手机。');
if (has('gh') && await yes('  要设置吗？')) {
  if (run('gh', ['auth', 'status']).status !== 0) {
    console.log('  先登录 GitHub：');
    if (interactive('gh', ['auth', 'login']).status !== 0) { console.log('  GitHub 登录没有完成，可以单独运行 gh auth login 后再运行 npm run setup'); process.exit(1); }
  }
  const login = run('gh', ['api', 'user', '--jq', '.login']).stdout.trim();
  const name = await ask('  仓库名', config.publishRepo?.split('/')[1] || 'remote-agent');
  const repo = `${login}/${name}`;
  if (run('gh', ['repo', 'view', repo]).status !== 0) {
    const r = run('gh', ['repo', 'create', repo, '--public', '--description', 'My Remote Agent phone app']);
    if (r.status !== 0) { console.log(r.stderr); process.exit(1); }
  }
  // Pages needs at least one commit before it can be enabled; the server keeps them in sync on start.
  const appDir = path.join(DIR, '..', 'app');
  const remote = await remoteShas(repo);
  for (const name of appFiles()) {
    const buf = fs.readFileSync(path.join(appDir, name));
    if (remote.get(name) === gitBlobSha(buf)) continue;
    await putFile(name, buf, remote.get(name), repo);
  }
  run('gh', ['api', '-X', 'POST', `repos/${repo}/pages`, '-f', 'source[branch]=main', '-f', 'source[path]=/']);
  config.publishRepo = repo;
  // Pages on a user site with a custom domain serves project sites from that domain; record the real address.
  let appAddr = `https://${login.toLowerCase()}.github.io/${name}/`;
  const u = normalizeAppUrl(run('gh', ['api', `repos/${repo}/pages`, '--jq', '.html_url']).stdout.trim());
  if (u) {
    appAddr = u;
    if (new URL(u).origin !== `https://${login.toLowerCase()}.github.io`) config.appUrl = u;
  }
  saveConfig();
  console.log(`  手机 App 地址：${appAddr}`);
}

console.log('\n3/4 后台服务');
if (isMac && await yes('  设为开机自启（后台常驻，崩溃自动重启）？')) {
  run('bash', [path.join(DIR, '..', 'scripts', 'service.sh'), 'install'], { stdio: 'inherit' });
} else {
  console.log('  手动启动：npm run public（外网）或 npm start（仅局域网）');
}

console.log('\n4/4 安全');
console.log('  手机通过「配对」登录，不用密码：每台手机在电脑上扫一次码即可。');
if (await yes('  要再加一层 Authenticator 二次验证吗（Google / Microsoft Authenticator）？', 'n')) {
  interactive('node', [path.join(DIR, 'twofa.mjs')]);
}

console.log(`
完成！还差两步：
  1. 用 ./scripts/start-cursor.sh 重启 Cursor（带调试端口），手机才能控制它。
  2. 运行 npm run pair，用手机扫码配对。以后每台新手机都这样配对一次。`);
rl.close();
