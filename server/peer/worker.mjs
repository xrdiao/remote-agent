import { spawn } from 'node:child_process';

// Own the process group until the preset and its output close. The IPC pipe also
// closes on an abrupt relay exit, so the preset does not outlive its supervisor.
const parentGone = () => process.kill(-process.pid, 'SIGKILL');
if (!process.connected) process.exit(1);
process.once('disconnect', parentGone);

const [file, ...args] = process.argv.slice(2);
try {
  const task = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  task.stdout.pipe(process.stdout, { end: false });
  task.stderr.pipe(process.stderr, { end: false });
  task.once('error', error => console.error(error.message));
  task.once('close', (code, signal) => {
    if (signal) console.error(`任务进程收到信号：${signal}`);
    process.exitCode = code ?? 1;
    process.off('disconnect', parentGone);
    process.disconnect();
  });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
