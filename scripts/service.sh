#!/usr/bin/env bash
# Run the public relay as a macOS LaunchAgent: starts at login and restarts if it crashes.
# Usage: ./scripts/service.sh install | uninstall | status | logs
set -euo pipefail

LABEL="com.agent-remote.relay"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
DIR="$(cd "$(dirname "$0")" && pwd)"
DATA="${HOME}/.agent-remote"
LOG="$DATA/server.log"
xml() { printf '%s' "$1" | sed 's/\&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }

write_agent() {
  local tmp arg
  local -a environment=()
  while [[ "$1" != -- ]]; do
    environment+=("$1")
    shift
  done
  shift
  mkdir -p "$HOME/Library/LaunchAgents" "$DATA"
  tmp="$(mktemp "$PLIST.XXXXXX")"
  {
    cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
EOF
    for arg in "$@"; do
      printf '    <string>%s</string>\n' "$(xml "$arg")"
    done
    cat <<EOF
  </array>
  <key>WorkingDirectory</key><string>$(xml "$DIR/..")</string>
  <key>EnvironmentVariables</key>
  <dict>
EOF
    for arg in "${environment[@]}"; do
      printf '    <key>%s</key><string>%s</string>\n' "$(xml "${arg%%=*}")" "$(xml "${arg#*=}")"
    done
    cat <<EOF
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$(xml "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG")</string>
</dict>
</plist>
EOF
  } > "$tmp"
  if ! plutil -lint "$tmp" >&2; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$PLIST"
}

autostart_status() {
  if [[ ! -f "$PLIST" ]]; then
    printf 'false\n'
    return
  fi
  launchctl print-disabled "$DOMAIN" | awk -v label="$LABEL" '
    ($1 == label || $1 == "\"" label "\"") && ($3 == "true" || $3 == "disabled") { disabled = 1 }
    END { print disabled ? "false" : "true" }
  '
}

case "${1:-}" in
  install)
    NODE="$(command -v node)"
    write_agent 'PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' -- "$NODE" "$DIR/../server/index.mjs" --tunnel
    launchctl enable "$DOMAIN/$LABEL"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    for _ in $(seq 1 20); do launchctl list | grep -q "$LABEL" || break; sleep 0.5; done
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "已安装并启动。日志：$LOG"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
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
  autostart-status)
    autostart_status
    ;;
  autostart-enable)
    shift
    if [[ ! -f "$PLIST" ]]; then write_agent "$@"; fi
    launchctl enable "$DOMAIN/$LABEL"
    autostart_status
    ;;
  autostart-disable)
    if [[ -f "$PLIST" ]]; then launchctl disable "$DOMAIN/$LABEL"; fi
    autostart_status
    ;;
  *)
    echo "用法：$0 install | uninstall | status | logs"
    exit 1
    ;;
esac
