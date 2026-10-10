#!/usr/bin/env bash
# Run the public relay as a macOS LaunchAgent: starts at login and restarts if it crashes.
# Usage: ./service.sh install | uninstall | status | logs
set -euo pipefail

LABEL="com.agent-remote.relay"
OLD_LABEL="com.cursor-remote.relay"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -d "$HOME/.agent-remote" ]]; then DATA="$HOME/.agent-remote"
elif [[ -d "$HOME/.cursor-remote-lite" ]]; then DATA="$HOME/.cursor-remote-lite"
else DATA="$HOME/.agent-remote"; fi
LOG="$DATA/server.log"
NODE="$(command -v node)"

case "${1:-}" in
  install)
    mkdir -p "$HOME/Library/LaunchAgents" "$DATA"
    launchctl bootout "gui/$(id -u)/$OLD_LABEL" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/$OLD_LABEL.plist"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/server.mjs</string>
    <string>--tunnel</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    for _ in $(seq 1 20); do launchctl list | grep -q "$LABEL" || break; sleep 0.5; done
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "已安装并启动。日志：$LOG"
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootout "gui/$(id -u)/$OLD_LABEL" 2>/dev/null || true
    rm -f "$PLIST" "$HOME/Library/LaunchAgents/$OLD_LABEL.plist"
    echo "已停止并移除开机自启"
    ;;
  status)
    line="$(launchctl list | grep "$LABEL" || true)"
    pid="$(echo "$line" | awk '{print $1}')"
    if [[ -n "$pid" && "$pid" != "-" ]]; then echo "运行中 (pid $pid)"; else echo "未运行"; fi
    ;;
  logs)
    tail -n 50 -f "$LOG"
    ;;
  *)
    echo "用法：$0 install | uninstall | status | logs"
    exit 1
    ;;
esac
