#!/usr/bin/env bash
# Start VS Code with the Chrome DevTools Protocol so the phone can drive the Codex sidebar.
# Cursor keeps port 9222. Devin keeps port 9223. This does not quit either of them.
set -euo pipefail

PORT="${CODEX_CDP_PORT:-9224}"
BIN="${CODE_BIN:-code}"

if curl -sf --max-time 1 "http://127.0.0.1:${PORT}/json/version" >/dev/null; then
  echo "Codex 调试端口 ${PORT} 已经开着。"
  exit 0
fi

if pgrep -f '/usr/share/code/code' >/dev/null 2>&1 || pgrep -x code >/dev/null 2>&1; then
  echo "VS Code 已在运行，但没有调试端口 ${PORT}。先退出 VS Code，再运行一次本脚本。"
  exit 1
fi

if ! command -v "$BIN" >/dev/null 2>&1; then
  echo "找不到 VS Code：$BIN"
  exit 1
fi

DATA="${HOME}/.agent-remote"
LOG="${DATA}/start-codex.log"
mkdir -p "$(dirname "$LOG")"
nohup "$BIN" --remote-debugging-port="${PORT}" >>"$LOG" 2>&1 &
disown
for _ in $(seq 1 30); do
  if curl -sf --max-time 1 "http://127.0.0.1:${PORT}/json/version" >/dev/null; then
    echo "VS Code 已打开，调试端口 ${PORT}。在里面打开 Codex 侧边栏后，手机窗口列表里会出现 Codex。"
    exit 0
  fi
  sleep 1
done
echo "VS Code 已启动，但端口 ${PORT} 还没有响应。查看 $LOG"
exit 1
