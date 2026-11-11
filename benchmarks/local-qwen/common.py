import hashlib
import json
import os
import time
import urllib.request
from pathlib import Path


CODE = Path(__file__).resolve().parent
BENCHMARKS = ("humaneval_plus", "mbpp_plus", "ifeval")
CODE_INSTRUCTION = (
    "Please provide a self-contained Python script that solves the following "
    "problem in a markdown code block:"
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text())


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=True, indent=2)
        stream.write("\n")
    temporary.chmod(0o600)
    os.replace(temporary, path)


def load_config(path=CODE / "config.json"):
    config = read_json(path)
    assert config["concurrency"] == config["scoring_workers"] == 1
    assert config["request_retries"] == 0
    assert config["request"]["reasoning_effort"] == "high"
    return config


def load_tasks(config):
    vendor = Path(config["artifact_root"]) / "vendor"
    tasks = {}
    for name, spec in config["datasets"].items():
        data = (vendor / spec["file"]).read_bytes()
        if digest(data) != spec["sha256"]:
            raise ValueError(f"Dataset hash mismatch: {name}")
        rows = [json.loads(line) for line in data.splitlines() if line.strip()]
        assert len(rows) == spec["count"], name
        ids = [str(row["key"]) if name == "ifeval" else row["task_id"] for row in rows]
        assert len(set(ids)) == len(ids), name
        tasks[name] = list(zip(ids, rows))
    return tasks


def prompt_for(benchmark, task):
    if benchmark == "ifeval":
        return task["prompt"]
    # EvalPlus 0.3.1 OpenAIChatDecoder's default instruction and formatting.
    return CODE_INSTRUCTION + "\n```python\n" + task["prompt"].strip() + "\n```"


def task_filename(task_id):
    return task_id.replace("/", "_") + ".json"


def json_get(url, timeout=5):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=timeout) as response:
        return json.load(response)


def append_event(run, kind, **fields):
    with (Path(run) / "events.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"time": time.time(), "event": kind, **fields}) + "\n")


def ratio(numerator, denominator):
    return numerator / denominator if denominator else None


def summarize(records, totals):
    result = {}
    for name in BENCHMARKS:
        rows = [r for r in records if r["benchmark"] == name]
        count = len(rows)
        complete = count == totals[name]
        entry = {
            "total": totals[name], "scored": count, "complete": complete,
            "truncated": sum(r["finish_reason"] == "length" for r in rows),
        }
        if name == "ifeval":
            strict = [flag for r in rows for flag in r["score"]["strict_instructions"]]
            loose = [flag for r in rows for flag in r["score"]["loose_instructions"]]
            passed = sum(r["score"]["strict_prompt"] for r in rows)
            entry.update(
                passed=passed, failed=count - passed, timeouts=0,
                strict_prompt=ratio(passed, count),
                loose_prompt=ratio(sum(r["score"]["loose_prompt"] for r in rows), count),
                strict_instruction=ratio(sum(strict), len(strict)),
                loose_instruction=ratio(sum(loose), len(loose)),
                instructions_scored=len(strict),
            )
        else:
            base = sum(r["score"]["base_status"] == "pass" for r in rows)
            plus = sum(r["score"]["base_status"] == r["score"]["plus_status"] == "pass" for r in rows)
            entry.update(
                passed=plus, failed=count - plus,
                timeouts=sum("timeout" in (r["score"]["base_status"], r["score"]["plus_status"]) for r in rows),
                base_pass_at_1=ratio(base, count), plus_pass_at_1=ratio(plus, count),
            )
        result[name] = entry
    return result


def performance(responses):
    prompt = cached = 0
    cache_available = True
    decode_ms = weighted_tokens = prefill_ms = prefill_tokens = 0.0
    ttfts = []
    for response in responses:
        usage = response.get("usage") or {}
        prompt += usage.get("prompt_tokens", 0)
        cache_value = (usage.get("prompt_tokens_details") or {}).get("cached_tokens")
        if cache_value is None:
            cache_available = False
        else:
            cached += cache_value
        timing = response.get("timings") or {}
        ms, speed = timing.get("predicted_ms"), timing.get("predicted_per_second")
        if ms and speed is not None:
            decode_ms += ms
            weighted_tokens += speed * ms / 1000
        if timing.get("prompt_ms") and timing.get("prompt_n"):
            prefill_ms += timing["prompt_ms"]
            prefill_tokens += timing["prompt_n"]
        if response.get("ttft_s") is not None:
            ttfts.append(response["ttft_s"])
    return {
        "requests": len(responses), "prompt_tokens": prompt,
        "cached_tokens": cached if cache_available else None,
        "kv_cache_hit_ratio": ratio(cached, prompt) if cache_available else None,
        "decode_tok_s": ratio(weighted_tokens, decode_ms / 1000),
        "prefill_tok_s": ratio(prefill_tokens, prefill_ms / 1000),
        "mean_ttft_s": ratio(sum(ttfts), len(ttfts)),
        "decode_definition": "native engine tokens, including reasoning; weighted by native decode time",
    }
