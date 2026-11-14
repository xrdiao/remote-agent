import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBin, localFilePath, samePath } from '../../lib/platform.mjs';

let pty, loadError;
try { pty = (await import('node-pty')).default; }
catch (error) { loadError = error; }
export const defaultShell = null;
export function spawnPty(shell, args, options) {
  if (!pty) throw new Error(`RA 终端无法加载 node-pty，请重新安装依赖：${loadError.message}`);
  const child = pty.spawn(shell, args, options);
  child.onExit(() => {
    child._agent.inSocket.destroy();
    child._agent._conoutSocketWorker.dispose();
  });
  return child;
}
export function command(shell, env) {
  shell ||= findBin('bash');
  if (!samePath(shell, findBin('bash')) || !path.isAbsolute(shell))
    throw new Error('Windows RA 终端仅支持 Git Bash，请安装 Git for Windows；不支持 PowerShell/cmd');
  return { shell, args: ['--rcfile', localFilePath(fileURLToPath(new URL('./windows.bash', import.meta.url))), '-i'],
    options: { useConpty: true, useConptyDll: true }, env: { ...env, TERM: 'xterm-256color' } };
}
export async function closePty(terminal) { terminal.process.kill(); await terminal.exit; }
