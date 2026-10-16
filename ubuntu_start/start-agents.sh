#!/usr/bin/env bash
# Launch installed agents concurrently; never terminate an existing app.
set -euo pipefail
ready() { curl -fsS --max-time 1 "http://127.0.0.1:$1/json/version" >/dev/null 2>&1; }
start_agent() {
  local name="$1" port="$2" override="$3" command_name="$4" process_name="$5"
  shift 5
  if ready "$port"; then echo "$name：调试端口 $port 已就绪，直接复用。"; return; fi
  local bin="$override" candidate
  if [[ -z "$bin" ]]; then
    bin="$(command -v "$command_name" || true)"
    if [[ -z "$bin" ]]; then
      for candidate in "$@"; do if [[ -x "$candidate" ]]; then bin="$candidate"; break; fi; done
    fi
  else
    bin="$(command -v "$bin" || true)"
  fi
  if [[ -z "$bin" ]]; then echo "$name：未安装，跳过。"; return; fi
  if pgrep -x "$process_name" >/dev/null; then
    echo "$name：已运行但未开启端口 $port，请自行退出该应用后重试。"
    return 1
  fi
  local log="$HOME/.agent-remote/start-${name,,}.log"
  nohup env -u ELECTRON_RUN_AS_NODE "$bin" "--remote-debugging-port=$port" >>"$log" 2>&1 </dev/null &
  for ((n=0; n<30; n++)); do
    if ready "$port"; then echo "$name：已启动，调试端口 $port。"; return; fi
    sleep 1
  done
  echo "$name：端口 $port 尚未响应，请查看 $log。"
  return 1
}
mkdir -p "$HOME/.agent-remote"
start_agent Cursor "${CDP_PORT:-9222}" "${CURSOR_BIN:-}" cursor cursor /usr/share/cursor/cursor /opt/Cursor/cursor &
cursor_job=$!
start_agent Devin "${DEVIN_CDP_PORT:-9223}" "${DEVIN_BIN:-}" devin-desktop devin-desktop /usr/share/devin-desktop/devin-desktop /usr/share/devin-desktop/bin/devin-desktop &
devin_job=$!
start_agent Codex "${CODEX_CDP_PORT:-9224}" "${CODE_BIN:-}" code code /usr/share/code/code &
codex_job=$!
failed=0
for job in "$cursor_job" "$devin_job" "$codex_job"; do if ! wait "$job"; then failed=1; fi; done
echo 'Codex 需要在 VS Code 中打开 Codex 侧边栏。'
exit "$failed"
