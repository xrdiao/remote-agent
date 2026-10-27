// Interactive first-run setup: checks dependencies, creates the GitHub Pages app, installs the service.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../lib/auth.mjs';
import { ensureFixedEntry } from './fixed-entry.mjs';
import { findBin } from '../lib/platform.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === 'darwin';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q, def = '') => (await rl.question(def ? `${q} [${def}] ` : `${q} `)).trim() || def;
const yes = async (q, def = 'y') => /^y/i.test(await ask(`${q} (y/n)`, def));
const has = cmd => (process.platform === 'win32' ? spawnSync(findBin(cmd), ['--version'], { windowsHide: true }) : spawnSync('sh', ['-c', `command -v ${cmd}`])).status === 0;
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
if (has('gh')) await ensureFixedEntry({ ask, interactive });

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
