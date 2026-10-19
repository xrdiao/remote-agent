#!/usr/bin/env bash
# Launch installed agents concurrently; never terminate an existing app.
# Optional args select which agents to launch: cursor devin codex (default: all).
# Each handled app prints one machine-readable "RESULT <app> <status>" line with
# status in: reused started missing running timeout.
set -euo pipefail
ready() { curl -fsS --max-time 1 "http://127.0.0.1:$1/json/version" >/dev/null 2>&1; }
start_agent() {
  local key="$1" name="$2" port="$3" override="$4" command_name="$5" process_name="$6"
  shift 6
  if ready "$port"; then echo "$name：调试端口 $port 已就绪，直接复用。"; echo "RESULT $key reused"; return; fi
  local bin="$override" candidate
  if [[ -z "$bin" ]]; then
    bin="$(command -v "$command_name" || true)"
    if [[ -z "$bin" ]]; then
      for candidate in "$@"; do if [[ -x "$candidate" ]]; then bin="$candidate"; break; fi; done
    fi
  else
    bin="$(command -v "$bin" || true)"
  fi
  if [[ -z "$bin" ]]; then echo "$name：未安装，跳过。"; echo "RESULT $key missing"; return; fi
  if pgrep -x "$process_name" >/dev/null; then
    echo "$name：已运行但未开启端口 $port，请自行退出该应用后重试。"
    echo "RESULT $key running"
    return 1
  fi
  local log="$HOME/.agent-remote/start-${name,,}.log"
  nohup env -u ELECTRON_RUN_AS_NODE "$bin" "--remote-debugging-port=$port" >>"$log" 2>&1 </dev/null &
  for ((n=0; n<30; n++)); do
    if ready "$port"; then echo "$name：已启动，调试端口 $port。"; echo "RESULT $key started"; return; fi
    sleep 1
  done
  echo "$name：端口 $port 尚未响应，请查看 $log。"
  echo "RESULT $key timeout"
  return 1
}
mkdir -p "$HOME/.agent-remote"
want="${*:-cursor devin codex}"
has() { case " $want " in *" $1 "*) return 0;; *) return 1;; esac; }
jobs=()
has cursor && { start_agent cursor Cursor "${CDP_PORT:-9222}" "${CURSOR_BIN:-$([[ -x /usr/share/cursor/cursor ]] && echo /usr/share/cursor/cursor)}" cursor cursor /usr/share/cursor/cursor /opt/Cursor/cursor & jobs+=("$!"); }
has devin && { start_agent devin Devin "${DEVIN_CDP_PORT:-9223}" "${DEVIN_BIN:-}" devin-desktop devin-desktop /usr/share/devin-desktop/devin-desktop /usr/share/devin-desktop/bin/devin-desktop & jobs+=("$!"); }
has codex && { start_agent codex Codex "${CODEX_CDP_PORT:-9224}" "${CODE_BIN:-}" code code /usr/share/code/code & jobs+=("$!"); }
failed=0
for job in "${jobs[@]:-}"; do if [[ -n "$job" ]] && ! wait "$job"; then failed=1; fi; done
echo 'Codex 需要在 VS Code 中打开 Codex 侧边栏。'
exit "$failed"
