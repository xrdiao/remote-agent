#!/usr/bin/env bash
# Start Devin with the Chrome DevTools Protocol on its own port.
# Cursor keeps port 9222. This does not quit Cursor or a Devin that is already open.
set -euo pipefail

PORT="${DEVIN_CDP_PORT:-9223}"
BIN="${DEVIN_BIN:-}"
if [[ -z "$BIN" ]]; then
  for c in /usr/share/devin-desktop/devin-desktop /usr/share/devin-desktop/bin/devin-desktop; do
    if [[ -x "$c" ]]; then BIN="$c"; break; fi
  done
  BIN="${BIN:-devin-desktop}"
fi

if curl -sf --max-time 1 "http://127.0.0.1:${PORT}/json/version" >/dev/null; then
  echo "Devin 调试端口 ${PORT} 已经开着。"
  exit 0
fi

if pgrep -f '/usr/share/devin-desktop/devin-desktop' >/dev/null 2>&1; then
  echo "Devin 已在运行，但没有调试端口 ${PORT}。先退出 Devin，再运行一次本脚本。"
  exit 1
fi

if [[ "$BIN" != */* ]]; then BIN="$(command -v "$BIN" || printf '%s' "$BIN")"; fi
if [[ ! -x "$BIN" ]]; then
  echo "找不到 Devin：$BIN"
  exit 1
fi

DATA="${HOME}/.agent-remote"
LOG="${DATA}/start-devin.log"
mkdir -p "$(dirname "$LOG")"
nohup "$BIN" --remote-debugging-port="${PORT}" >>"$LOG" 2>&1 &
disown
for _ in $(seq 1 30); do
  if curl -sf --max-time 1 "http://127.0.0.1:${PORT}/json/version" >/dev/null; then
    echo "Devin 已打开，调试端口 ${PORT}。"
    exit 0
  fi
  sleep 1
done
echo "Devin 已启动，但端口 ${PORT} 还没有响应。查看 $LOG"
exit 1
