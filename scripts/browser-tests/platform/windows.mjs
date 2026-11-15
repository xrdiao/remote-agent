import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));

export async function cleanupProjects(directory, registry, computer, overview, run = execute) {
  const shots = path.resolve(root, '_shots') + path.sep;
  const data = await fs.realpath(path.resolve(root, registry.relay.dataDir));
  const runDirectory = await fs.realpath(directory);
  if (!data.toLowerCase().startsWith(shots.toLowerCase()) || !runDirectory.toLowerCase().startsWith(shots.toLowerCase()))
    throw new Error('Windows 测试资源回收只用于 _shots 内的隔离实例');
  const key = Buffer.from((await fs.readFile(path.join(data, 'url-key'), 'utf8')).trim(), 'base64url');
  const id = createHash('sha256').update(key).digest('hex').slice(0, 16);
  if (id !== computer) throw new Error('测试 relay 的电脑身份与执行电脑不一致');
  const url = new URL(registry.appUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Windows 测试资源回收必须使用本机隔离 relay');
  const { sessions } = await overview();
  if (sessions.some(row => row.app === 'codex' && row.windowId === 'backend' && (row.busy || row.waiting)))
    throw new Error('隔离 Codex 后端仍有运行或等待批准的会话，保留测试目录');
  const script = `
$ErrorActionPreference = 'Stop'
$ownerId = (Get-NetTCPConnection -State Listen -LocalPort ${Number(url.port || (url.protocol === 'https:' ? 443 : 80))} | Select-Object -First 1).OwningProcess
$processes = @(Get-CimInstance Win32_Process)
$owner = $processes | Where-Object ProcessId -eq $ownerId
if ($owner.Name -ne 'node.exe' -or $owner.CommandLine -notmatch 'server[/\\\\]index\\.mjs') { throw '隔离 relay 进程身份不匹配' }
$backends = @($processes | Where-Object { $_.ParentProcessId -eq $ownerId -and $_.Name -eq 'codex.exe' -and $_.CommandLine -match 'app-server' -and $_.CommandLine -match '--stdio' })
$stopped = @()
foreach ($backend in $backends) {
  $tree = @($backend.ProcessId)
  for ($index = 0; $index -lt $tree.Count; $index++) {
    $parentId = $tree[$index]
    $tree += @($processes | Where-Object ParentProcessId -eq $parentId | Select-Object -ExpandProperty ProcessId)
  }
  $handles = @(Get-Process -Id $tree -ErrorAction SilentlyContinue)
  try {
    & taskkill.exe /PID $backend.ProcessId /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '测试 Codex 后端回收失败' }
    foreach ($handle in $handles) { if (-not $handle.WaitForExit(10000)) { throw '测试 Codex 子进程尚未退出' } }
  } finally { foreach ($handle in $handles) { $handle.Dispose() } }
  $stopped += $tree
}
ConvertTo-Json -InputObject @($stopped) -Compress
`;
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  await fs.rm(path.join(runDirectory, 'projects'), { recursive: true });
  return { projectsRemoved: true, backendProcessesStopped: JSON.parse(stdout) };
}
