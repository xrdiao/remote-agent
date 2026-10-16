import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../lib/auth.mjs';

const script = fileURLToPath(import.meta.url);
const repo = path.dirname(path.dirname(script));
if (!process.argv.includes('--ready')) {
  const { ensureFixedEntry } = await import('./fixed-entry.mjs');
  let rl, temporary = false;
  const closePrompt = () => { rl?.close(); rl = null; if (process.stdin.isTTY) process.stdin.setRawMode(false); };
  const ask = async (q, def) => { rl ||= readline.createInterface({ input: process.stdin, output: process.stdout }); return (await rl.question(`${q} [${def}] `)).trim() || def; };
  try {
    const config = readConfig();
    console.log(config.appUrl || config.publishRepo ? `本机已有固定入口：${config.appUrl || config.publishRepo}` : '本机尚未配置固定入口。');
    const mode = await ask('选择本次入口：1 固定入口（检查已有入口） / 2 临时隧道入口', '1');
    if (!['1', '2'].includes(mode)) throw new Error('请输入 1 或 2，然后重新运行');
    temporary = mode === '2';
    if (!temporary) temporary = !await ensureFixedEntry({
      ask,
      interactive: (cmd, args) => { closePrompt(); return spawnSync(cmd, args, { stdio: 'inherit' }); },
    });
  } finally { closePrompt(); }
  // Load service configuration in a fresh process after the personal entry has been saved.
  process.exitCode = spawnSync(process.execPath, [script, '--ready', ...(temporary ? ['--temporary'] : [])], { cwd: repo, stdio: 'inherit' }).status ?? 1;
} else {
  const { ensureServices } = await import('../window_start/pair-link.mjs');
  await ensureServices();
  process.exitCode = spawnSync(process.execPath, [path.join(repo, 'cli/devices.mjs'), 'pair', ...(process.argv.includes('--temporary') ? ['--temporary'] : []), ...(process.platform === 'win32' ? ['--copy-link'] : [])], { cwd: repo, stdio: 'inherit' }).status ?? 1;
}
