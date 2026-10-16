# Start Cursor / Devin / Codex (VS Code) with CDP ports. No hard-coded drive letters.
# Override paths with CURSOR_BIN / DEVIN_BIN / CODE_BIN if needed.
$ErrorActionPreference = 'Continue'

function Test-Cdp([int]$Port) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 1
    return $r.StatusCode -eq 200
  } catch { return $false }
}

function Get-FixedDrives {
  try {
    return @(Get-PSDrive -PSProvider FileSystem | Where-Object { $_.DisplayRoot -match '^[A-Z]:\\$' -or $_.Name -match '^[A-Z]$' } | ForEach-Object {
      if ($_.Root) { $_.Root.TrimEnd('\') } else { "$($_.Name):" }
    } | Select-Object -Unique)
  } catch { return @('C:') }
}

function Find-OnPath([string]$Name) {
  $cmd = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue |
    Where-Object { $_.Source -match '\.(exe|cmd|bat)$' } | Select-Object -First 1
  if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source)) { return $cmd.Source }
  $where = & where.exe $Name 2>$null | Where-Object { $_ -match '\.(exe|cmd|bat)$' } | Select-Object -First 1
  if ($where -and (Test-Path -LiteralPath $where)) { return $where }
  return $null
}

function Resolve-AppBin($App) {
  $envPath = [Environment]::GetEnvironmentVariable($App.Env)
  if ($envPath -and (Test-Path -LiteralPath $envPath)) { return $envPath }

  foreach ($c in $App.Candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { return $c }
  }

  foreach ($name in $App.PathNames) {
    $hit = Find-OnPath $name
    if ($hit) { return $hit }
  }

  foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths')) {
    $entry = Get-Item -LiteralPath (Join-Path $root $App.Executable) -ErrorAction SilentlyContinue
    if ($entry) {
      $target = ([string]$entry.GetValue('')).Trim('"')
      if ($target -and (Test-Path -LiteralPath $target)) { return $target }
    }
  }

  $shell = New-Object -ComObject WScript.Shell
  foreach ($menuRoot in @($env:APPDATA, $env:ProgramData)) {
    $menu = Join-Path $menuRoot 'Microsoft\Windows\Start Menu\Programs'
    foreach ($shortcut in Get-ChildItem -LiteralPath $menu -Filter '*.lnk' -Recurse -File -ErrorAction SilentlyContinue) {
      $target = $shell.CreateShortcut($shortcut.FullName).TargetPath
      if ([IO.Path]::GetFileName($target) -ieq $App.Executable -and (Test-Path -LiteralPath $target)) { return $target }
    }
  }

  foreach ($drive in Get-FixedDrives) {
    foreach ($rel in $App.DriveRels) {
      $p = Join-Path $drive $rel
      if (Test-Path -LiteralPath $p) { return $p }
    }
  }
  return $null
}

function Process-Running([string[]]$Names) {
  foreach ($n in $Names) {
    if (Get-Process -Name $n -ErrorAction SilentlyContinue) { return $true }
  }
  return $false
}

function Resolve-DesktopExe([string]$Path, [string]$Executable) {
  if ([IO.Path]::GetExtension($Path) -ieq '.exe') { return $Path }
  $dir = Split-Path -Parent $Path
  while ($dir) {
    $candidate = Join-Path $dir $Executable
    if (Test-Path -LiteralPath $candidate) { return $candidate }
    $dir = Split-Path -Parent $dir
  }
  return $null
}

$apps = @(
  @{
    Name = 'Cursor'
    Executable = 'Cursor.exe'
    Port = 9222
    Env = 'CURSOR_BIN'
    ProcessNames = @('Cursor')
    PathNames = @('cursor', 'Cursor.exe')
    Candidates = @(
      (Join-Path $env:LOCALAPPDATA 'Programs\cursor\Cursor.exe'),
      (Join-Path $env:LOCALAPPDATA 'Programs\Cursor\Cursor.exe'),
      (Join-Path $env:ProgramFiles 'Cursor\Cursor.exe')
    )
    DriveRels = @('cursor\Cursor.exe', 'Cursor\Cursor.exe', 'Programs\cursor\Cursor.exe', 'Programs\Cursor\Cursor.exe')
  },
  @{
    Name = 'Devin'
    Executable = 'Devin.exe'
    Port = 9223
    Env = 'DEVIN_BIN'
    ProcessNames = @('Devin')
    PathNames = @('devin', 'Devin.exe')
    Candidates = @(
      (Join-Path $env:LOCALAPPDATA 'Programs\Devin\Devin.exe'),
      (Join-Path $env:LOCALAPPDATA 'Programs\devin\Devin.exe'),
      (Join-Path $env:ProgramFiles 'Devin\Devin.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'Devin\Devin.exe')
    )
    DriveRels = @('Devin\Devin.exe', 'devin\Devin.exe', 'Programs\Devin\Devin.exe')
  },
  @{
    Name = 'Codex'
    Executable = 'Code.exe'
    Port = 9224
    Env = 'CODE_BIN'
    ProcessNames = @('Code')
    PathNames = @('code', 'Code.exe')
    Candidates = @(
      (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe'),
      (Join-Path $env:ProgramFiles 'Microsoft VS Code\Code.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'Microsoft VS Code\Code.exe')
    )
    DriveRels = @(
      'Microsoft VS Code\Code.exe',
      'VSCode\Code.exe',
      'code\Code.exe',
      'Programs\Microsoft VS Code\Code.exe'
    )
  }
)

$failed = 0
$pending = @()
foreach ($app in $apps) {
  Write-Host ""
  Write-Host "=== $($app.Name) (port $($app.Port)) ==="
  if (Test-Cdp $app.Port) {
    Write-Host "调试端口 $($app.Port) 已开着，跳过。"
    continue
  }
  if (Process-Running $app.ProcessNames) {
    Write-Host "$($app.Name) 已在运行，但没有调试端口 $($app.Port)。请先退出后再运行本脚本。"
    $failed++
    continue
  }
  $bin = Resolve-AppBin $app
  if ($bin) { $bin = Resolve-DesktopExe $bin $app.Executable }
  if (-not $bin) {
    Write-Host "找不到 $($app.Name)。可设置环境变量 $($app.Env) 指向可执行文件。"
    $failed++
    continue
  }
  Write-Host "启动：$bin --remote-debugging-port=$($app.Port)"
  $electronMode = $env:ELECTRON_RUN_AS_NODE
  try {
    $env:ELECTRON_RUN_AS_NODE = $null
    Start-Process -FilePath $bin -ArgumentList "--remote-debugging-port=$($app.Port)" -WorkingDirectory (Split-Path -Parent $bin) -WindowStyle Normal | Out-Null
  } catch {
    Write-Host "启动失败：$($_.Exception.Message)"
    $failed++
    continue
  } finally {
    $env:ELECTRON_RUN_AS_NODE = $electronMode
  }
  $pending += @{ App = $app; Started = Get-Date }
}

while ($pending.Count) {
  foreach ($entry in @($pending)) {
    $app = $entry.App
    if (Test-Cdp $app.Port) {
      Write-Host "$($app.Name) 已打开，调试端口 $($app.Port)。"
      $pending = @($pending | Where-Object { $_.App.Port -ne $app.Port })
    } elseif (((Get-Date) - $entry.Started).TotalSeconds -ge 30) {
      Write-Host "$($app.Name) 已启动，但端口 $($app.Port) 30 秒内未响应，请稍后再查。"
      $failed++
      $pending = @($pending | Where-Object { $_.App.Port -ne $app.Port })
    }
  }
  if ($pending.Count) { Start-Sleep -Milliseconds 250 }
}

Write-Host ""
if ($failed -eq 0) { Write-Host '全部就绪。' } else { Write-Host "完成，但有 $failed 项未就绪。" }
exit $failed
