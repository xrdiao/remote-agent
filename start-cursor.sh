#!/usr/bin/env bash
# Relaunch Cursor with the Chrome DevTools Protocol enabled (required for remote control).
# WARNING: this quits the running Cursor first; unsaved editors will prompt.
set -euo pipefail

PORT="${CDP_PORT:-9222}"

if curl -s --max-time 1 "http://127.0.0.1:${PORT}/json/version" >/dev/null; then
  echo "Port ${PORT} already has a CDP endpoint:"
  ps -eo pid,args | grep -- "--remote-debugging-port=${PORT}" | grep -v grep | grep -v Helper | cut -c1-200 || true
  echo "If that is not your main Cursor, quit it first (or set CDP_PORT to another port)."
  exit 1
fi

LOG="$HOME/.cursor-remote-lite/start-cursor.log"
mkdir -p "$(dirname "$LOG")"

# Detached so it survives when launched from Cursor's own terminal, which dies with Cursor.
nohup bash -c "
  if pgrep -xq Cursor; then
    echo \"\$(date) asking Cursor to quit\"
    osascript -e 'quit app \"Cursor\"' >/dev/null 2>&1 &
    for _ in \$(seq 1 30); do pgrep -xq Cursor || break; sleep 0.5; done
    if pgrep -xq Cursor; then
      echo \"\$(date) quit was blocked (probably a confirm dialog); sending SIGTERM\"
      pkill -TERM -x Cursor || true
      for _ in \$(seq 1 60); do pgrep -xq Cursor || break; sleep 0.5; done
    fi
    if pgrep -xq Cursor; then
      echo \"\$(date) Cursor did not quit; aborted\"
      exit 1
    fi
    sleep 1
  fi
  open -a Cursor --args --remote-debugging-port=${PORT}
  for _ in \$(seq 1 30); do
    curl -s --max-time 1 http://127.0.0.1:${PORT}/json/version >/dev/null && { echo \"\$(date) Cursor up with CDP on ${PORT}\"; exit 0; }
    sleep 1
  done
  echo \"\$(date) Cursor started but CDP port ${PORT} is not responding\"
" >"$LOG" 2>&1 &
disown

echo "Cursor 将退出并带调试端口重新打开（结果见 $LOG）"
