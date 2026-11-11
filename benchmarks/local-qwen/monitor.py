import argparse
import os
import sys
import time
import unicodedata
from pathlib import Path

from common import load_config, read_json

NA = "\u65e0\u6570\u636e"
TOK_S = " Token/\u79d2"
SEC = " \u79d2"

STATE_ZH = {
    "running": "\u8fd0\u884c\u4e2d",
    "completed": "\u5df2\u5b8c\u6210",
    "interrupted": "\u5df2\u4e2d\u65ad",
    "error": "\u51fa\u9519",
}
PHASE_ZH = {
    "preflight": "\u9884\u68c0",
    "generating": "\u751f\u6210\u4e2d",
    "scoring": "\u8bc4\u5206\u4e2d",
    "finished": "\u5df2\u7ed3\u675f",
    "stopped": "\u5df2\u505c\u6b62",
}
MODE_ZH = {
    "full": "\u5168\u91cf\u8bc4\u6d4b",
    "smoke": "\u6d41\u7a0b\u9a8c\u6536",
}
ENGINE_ZH = {
    "idle": "\u7a7a\u95f2",
    "reading": "\u8f93\u5165\u5904\u7406\u4e2d",
    "generating": "\u751f\u6210\u4e2d",
    "unloaded": "\u6a21\u578b\u672a\u52a0\u8f7d",
}
BENCH_ZH = {
    "humaneval_plus": "HumanEval+",
    "mbpp_plus": "MBPP+",
    "ifeval": "IFEval",
}
KV_ZH = {
    "ENABLED": "\u5df2\u542f\u7528",
    "DISABLED": "\u672a\u542f\u7528",
}


def pick(mapping, value):
    if value is None:
        return NA
    return mapping.get(value, value)


def display_width(text):
    return sum(2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1 for ch in text)


def pad(text, width):
    return text + " " * max(0, width - display_width(text))


def number(value, suffix="", digits=1):
    return NA if value is None else f"{value:.{digits}f}{suffix}"


def percent(value):
    return number(None if value is None else value * 100, "%")


def render(run, status, telemetry):
    current = status.get("current") or {}
    live = telemetry.get("live") or {}
    hardware = telemetry.get("hardware") or {}
    last = telemetry.get("last_request") or {}
    cache = telemetry.get("conversation_cache") or {}
    kv_raw = "ENABLED" if cache.get("enabled") is True else "DISABLED" if cache.get("enabled") is False else None
    kv_state = KV_ZH.get(kv_raw, NA)
    performance = status.get("performance") or {}
    config = status["config"]
    benchmark = current.get("benchmark", "-")
    lines = [
        "Qwen \u672c\u5730\u6a21\u578b\u8bc4\u6d4b",
        f"{config['model']} | \u601d\u8003\u5f3a\u5ea6 xhigh | \u4e0a\u4e0b\u6587 {config['context']:,} | \u8f93\u51fa\u9884\u7b97 {config['max_tokens']:,} Token",
        f"\u72b6\u6001 {STATE_ZH.get(status['state'], str(status['state']).upper())} / {MODE_ZH.get(status['mode'], status['mode'])}"
        f" / {PHASE_ZH.get(status['phase'], status['phase'])} | \u8fdb\u7a0b {status['pid']}",
        f"\u5f53\u524d\u4efb\u52a1 {BENCH_ZH.get(benchmark, benchmark)}  {current.get('task_id', '-')}"
        f" | \u66f4\u65b0 {time.strftime('%H:%M:%S', time.localtime(status['updated_at']))}",
        "",
        pad("\u8bc4\u6d4b", 20) + " " + pad("\u5b8c\u6210/\u603b\u6570", 11) + " " + pad("\u901a\u8fc7", 5) + " " + pad("\u672a\u901a\u8fc7", 6) + " "
        + pad("\u8d85\u65f6", 7) + " " + pad("\u622a\u65ad", 10) + "   \u6210\u7ee9\uff08\u672a\u5b8c\u6210\u4e3a\u6682\u5b9a\uff09",
    ]
    if status["mode"] == "smoke":
        lines.insert(4, "\u4ec5\u7528\u4e8e\u6d41\u7a0b\u9a8c\u6536\uff0c\u4e0d\u662f\u5168\u91cf\u8bc4\u6d4b\u6210\u7ee9")
    for name, b in status["benchmarks"].items():
        score = percent(b.get("strict_prompt") if name == "ifeval" else b.get("plus_pass_at_1"))
        label = " \u5df2\u5b8c\u6210" if b["complete"] else " \u6682\u5b9a"
        lines.append(
            f"{BENCH_ZH.get(name, name):<20} {b['scored']:>4}/{b['total']:<5} {b['passed']:>5} {b['failed']:>6} "
            f"{b['timeouts']:>7} {b['truncated']:>10}   {score}{label}"
        )
        if name == "ifeval" and b["scored"]:
            lines.append(
                f"  \u4e25\u683c\uff1a\u63d0\u793a\u7ea7 {percent(b['strict_prompt'])} / \u6307\u4ee4\u7ea7 {percent(b['strict_instruction'])}"
                f" | \u5bbd\u677e\uff1a\u63d0\u793a\u7ea7 {percent(b['loose_prompt'])} / \u6307\u4ee4\u7ea7 {percent(b['loose_instruction'])}"
            )
    stream = status.get("stream") or {}
    lines += [
        "",
        "\u670d\u52a1\u5168\u5c40\u5b9e\u65f6\u6570\u636e\uff08\u53ef\u80fd\u5305\u542b OpenCode/RA \u8bf7\u6c42\uff09",
        f"\u72b6\u6001 {pick(ENGINE_ZH, live.get('state'))} | \u751f\u6210\u901f\u5ea6 {number(live.get('tok_s'), TOK_S)}"
        f" | \u8f93\u5165\u5904\u7406\u901f\u5ea6 {number(live.get('prefill_tok_s_mean'), TOK_S)} | \u6392\u961f {live.get('queued', NA)}",
        f"\u5df2\u751f\u6210 {number(live.get('generated'), digits=0)} | \u63d0\u793a\u8bcd\u8bfb\u53d6 "
        f"{number(live.get('prompt_read'), digits=0)}/{number(live.get('prompt_total'), digits=0)}",
        f"\u672c\u9898\u9996 Token \u5ef6\u8fdf {number(stream.get('ttft_s'), SEC)} | \u601d\u8003\u5b57\u7b26 {stream.get('reasoning_chars', NA)}"
        f" | \u7b54\u6848\u5b57\u7b26 {stream.get('answer_chars', NA)}",
        f"\u6700\u8fd1\u8bf7\u6c42\u4e13\u5bb6\u7f13\u5b58\u547d\u4e2d {percent(last.get('hit_rate'))}"
        f" | DFlash2 \u8349\u7a3f\u63a5\u53d7\u7387 {percent(last['drafts_accepted'] / last['drafts_offered'] if last.get('drafts_offered') else None)}",
        "",
        "\u672c\u6b21\u8bc4\u6d4b\uff1a\u5df2\u5b8c\u6210\u8bf7\u6c42",
        f"\u751f\u6210\u901f\u5ea6\uff08\u542b\u601d\u8003\uff09{number(performance.get('decode_tok_s'), TOK_S)}"
        f" | \u8f93\u5165\u5904\u7406\u901f\u5ea6 {number(performance.get('prefill_tok_s'), TOK_S)}"
        f" | \u5e73\u5747 TTFT {number(performance.get('mean_ttft_s'), SEC)}",
        f"\u8de8\u8bf7\u6c42 KV \u524d\u7f00\u590d\u7528\uff1a{kv_state} | \u9884\u7b97 {cache.get('budget_mib', NA)} MiB",
        f"KV \u524d\u7f00\u547d\u4e2d\u7387 {percent(performance.get('kv_cache_hit_ratio'))}"
        f" | \u7f13\u5b58/\u8f93\u5165 Token {number(performance.get('cached_tokens'), digits=0)}/{performance.get('prompt_tokens', 0):,}",
        "",
        "\u6574\u673a\u8d44\u6e90",
        f"GPU {number(hardware.get('gpu_util'), '%')} | \u663e\u5b58 "
        f"{number(hardware.get('gpu_mem_used', 0) / 2**20 if hardware.get('gpu_mem_used') is not None else None, ' MiB')}"
        f" / {number(hardware.get('gpu_mem_total', 0) / 2**20 if hardware.get('gpu_mem_total') is not None else None, ' MiB')}",
        f"\u53ef\u7528\u5185\u5b58 {number(telemetry.get('memory_available_bytes', 0) / 2**30 if telemetry.get('memory_available_bytes') is not None else None, ' GiB')}"
        f" | \u4ea4\u6362\u7a7a\u95f4\u5df2\u7528 {number(telemetry.get('swap_used_bytes', 0) / 2**30 if telemetry.get('swap_used_bytes') is not None else None, ' GiB')}",
    ]
    if telemetry.get("error"):
        lines.append("\u9065\u6d4b\u9519\u8bef\uff1a" + telemetry["error"])
    if time.time() - telemetry.get("time", 0) > 10:
        lines.append("\u9065\u6d4b\u6570\u636e\u8fc7\u65e7\uff1a\u5b9e\u65f6\u6307\u6807\u4e0d\u662f\u6700\u65b0")
    if status.get("error"):
        lines.append("\u8fd0\u884c\u9519\u8bef\uff1a" + status["error"])
    lines += ["", f"\u4ea7\u7269\u76ee\u5f55\uff1a{run}", "Ctrl+C \u53ea\u9000\u51fa\u9762\u677f\uff0c\u4e0d\u4f1a\u505c\u6b62\u540e\u53f0\u8bc4\u6d4b"]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Read-only live terminal benchmark monitor")
    parser.add_argument("--run-dir")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    root = Path(load_config()["artifact_root"])
    try:
        while True:
            run = Path(args.run_dir) if args.run_dir else Path((root / "latest-run.txt").read_text().strip())
            status = read_json(run / "status.json")
            telemetry = read_json(run / "telemetry.json") if (run / "telemetry.json").exists() else {}
            screen = render(run, status, telemetry)
            if sys.stdout.isatty() and not args.once:
                print("\x1b[?25l\x1b[H\x1b[2J" + screen, flush=True)
            else:
                print(screen, flush=True)
            if args.once:
                return
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        if sys.stdout.isatty():
            print("\x1b[?25h", end="", flush=True)


if __name__ == "__main__":
    main()
