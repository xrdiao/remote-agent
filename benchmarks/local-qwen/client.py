import copy
import json
import threading
import time
import urllib.request
from pathlib import Path

from common import json_get, write_json


def sse_data(lines):
    data = []
    for line in lines:
        line = line.decode("utf-8").rstrip("\r\n")
        if not line:
            if data:
                yield "\n".join(data)
                data = []
        elif line.startswith("data:"):
            data.append(line[5:].lstrip(" "))
    if data:
        yield "\n".join(data)


def complete(config, prompt, progress=None):
    body = copy.deepcopy(config["request"])
    body.update(model=config["model"], messages=[{"role": "user", "content": prompt}])
    request = urllib.request.Request(
        config["endpoint"] + "/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    before = json_get(config["endpoint"] + "/metrics")
    start = time.perf_counter()
    result = {
        "answer": "", "reasoning": "", "usage": None, "timings": None,
        "ttft_s": None, "finish_reason": None, "api_id": None,
        "request_body": body, "started_at": time.time(),
    }
    last_update = 0
    with opener.open(request, timeout=config["request_timeout_s"]) as response:
        for frame in sse_data(response):
            if frame == "[DONE]":
                break
            chunk = json.loads(frame)
            if "error" in chunk:
                raise RuntimeError(json.dumps(chunk["error"]))
            result["api_id"] = chunk.get("id", result["api_id"])
            for choice in chunk.get("choices", []):
                delta = choice.get("delta") or {}
                answer, reasoning = delta.get("content") or "", delta.get("reasoning_content") or ""
                if (answer or reasoning) and result["ttft_s"] is None:
                    result["ttft_s"] = time.perf_counter() - start
                result["answer"] += answer
                result["reasoning"] += reasoning
                if choice.get("finish_reason") is not None:
                    result["finish_reason"] = choice["finish_reason"]
            for key in ("usage", "timings"):
                if chunk.get(key) is not None:
                    result[key] = chunk[key]
            now = time.perf_counter()
            if progress and now - last_update >= 1:
                progress({
                    "elapsed_s": now - start, "ttft_s": result["ttft_s"],
                    "reasoning_chars": len(result["reasoning"]),
                    "answer_chars": len(result["answer"]),
                })
                last_update = now
    result["wall_s"] = time.perf_counter() - start
    if result["finish_reason"] is None or result["usage"] is None:
        raise RuntimeError("Incomplete stream: no finish reason or usage; not a scored model failure")
    # The engine's request ID differs from the OpenAI completion ID. Never join
    # unrelated requests just by selecting the newest telemetry record.
    after = json_get(config["endpoint"] + "/metrics")
    old_ids = {r["id"] for r in before["requests"]}
    new_rows = [r for r in after["requests"] if r["id"] not in old_ids]
    result["native_request"] = None
    if after["totals"]["requests"] == before["totals"]["requests"] + 1 and len(new_rows) == 1:
        candidate = new_rows[0]
        if (candidate["prompt_tokens"] == result["usage"]["prompt_tokens"]
                and candidate["output_tokens"] == result["usage"]["completion_tokens"]):
            result["native_request"] = candidate
    return result


class Telemetry:
    def __init__(self, endpoint, run):
        self.endpoint, self.run = endpoint, Path(run)
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.sample, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.stop.set()
        self.thread.join(timeout=10)

    def sample(self):
        while not self.stop.is_set():
            try:
                raw = json_get(self.endpoint + "/metrics")
                mem = {}
                for line in Path("/proc/meminfo").read_text().splitlines():
                    key, value = line.split(":", 1)
                    mem[key] = int(value.split()[0]) * 1024
                snapshot = {
                    "time": time.time(), "scope": "server-global, not exclusively benchmark requests",
                    "live": raw["live"], "hardware": raw["hardware"],
                    "last_request": raw["requests"][0] if raw["requests"] else None,
                    "conversation_cache": raw["conversation_cache"],
                    "memory_available_bytes": mem["MemAvailable"],
                    "swap_used_bytes": mem["SwapTotal"] - mem["SwapFree"],
                    "swap_total_bytes": mem["SwapTotal"],
                }
            except Exception as error:
                snapshot = {"time": time.time(), "error": str(error)}
            write_json(self.run / "telemetry.json", snapshot)
            with (self.run / "telemetry.jsonl").open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(snapshot) + "\n")
            self.stop.wait(1)
