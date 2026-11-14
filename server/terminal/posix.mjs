import os from 'node:os';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';

export const defaultShell = os.userInfo().shell;
export const spawnPty = (shell, args, options) => pty.spawn(shell, args, options);
export function command(shell, env) {
  return { shell: shell || '/bin/bash', args: ['--rcfile', fileURLToPath(new URL('./posix.bash', import.meta.url)), '-i'],
    options: {}, env: { ...env, TERM: 'xterm-256color' } };
}
export async function closePty(terminal) { terminal.process.kill(); }
