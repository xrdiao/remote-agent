import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const repo = path.dirname(path.dirname(script));
if (!process.argv.includes('--ready')) {
  const { ensureFixedEntry } = await import('./fixed-entry.mjs');
  let rl;
  const closePrompt = () => { rl?.close(); rl = null; if (process.stdin.isTTY) process.stdin.setRawMode(false); };
  try {
    await ensureFixedEntry({
      ask: async (q, def) => { rl ||= readline.createInterface({ input: process.stdin, output: process.stdout }); return (await rl.question(`${q} [${def}] `)).trim() || def; },
      interactive: (cmd, args) => { closePrompt(); return spawnSync(cmd, args, { stdio: 'inherit' }); },
    });
  } finally { closePrompt(); }
  // Load service configuration in a fresh process after the personal entry has been saved.
  process.exitCode = spawnSync(process.execPath, [script, '--ready'], { cwd: repo, stdio: 'inherit' }).status ?? 1;
} else {
  const { ensureServices } = await import('../window_start/pair-link.mjs');
  await ensureServices();
  process.exitCode = spawnSync(process.execPath, [path.join(repo, 'cli/devices.mjs'), 'pair', ...(process.platform === 'win32' ? ['--copy-link'] : [])], { cwd: repo, stdio: 'inherit' }).status ?? 1;
}
