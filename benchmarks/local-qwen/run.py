import argparse
import fcntl
import os
import platform
import signal
import sys
import time
import traceback
from pathlib import Path

from client import Telemetry, complete
from common import (
    BENCHMARKS, CODE, append_event, digest, json_get, load_config, load_tasks,
    performance, prompt_for, read_json, summarize, task_filename, write_json,
)
from sandbox import execute, score_one


def provenance(config):
    vendor = Path(config["artifact_root"]) / "vendor"
    files = list(CODE.glob("*.py")) + [CODE / "requirements.lock", CODE / "config.json"]
    files += list((vendor / "evalplus").rglob("*.py"))
    files += list((vendor / "instruction_following_eval").glob("*.py"))
    return {
        "config": config, "python": sys.version, "platform": platform.platform(),
        "source_hashes": {str(p): digest(p.read_bytes()) for p in sorted(files)},
        "evalplus_wheel_sha256": digest((vendor / "evalplus-0.3.1-py3-none-any.whl").read_bytes()),
        "punkt_zip_sha256": digest((vendor / "punkt.zip").read_bytes()),
    }


def run(args):
    config = load_config()
    root = Path(config["artifact_root"])
    tasks = load_tasks(config)
    if args.smoke:
        tasks = {name: rows[:2] for name, rows in tasks.items()}
    totals = {name: len(rows) for name, rows in tasks.items()}
    run_dir = Path(args.run_dir).resolve() if args.run_dir else root / "runs" / (
        time.strftime("%Y%m%d-%H%M%S") + ("-smoke" if args.smoke else "-full")
    )
    run_dir.mkdir(parents=True, exist_ok=True)
    lock = (root / "run.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    frozen = provenance(config)
    if frozen["evalplus_wheel_sha256"] != config["evalplus_wheel_sha256"]:
        raise ValueError("Official EvalPlus wheel hash mismatch")
    frozen.update(mode="smoke" if args.smoke else "full", totals=totals)
    manifest = run_dir / "manifest.json"
    if args.resume:
        if read_json(manifest) != frozen:
            raise ValueError("Resume requires identical source, configuration, environment identity and datasets")
    else:
        if manifest.exists():
            raise ValueError("Run exists; use --resume with the same mode")
        write_json(manifest, frozen)
    root.joinpath("latest-run.txt").write_text(str(run_dir) + "\n")
    records, responses = [], []
    record_ids = set()
    started = time.time()
    for name, rows in tasks.items():
        for task_id, _ in rows:
            result_file = run_dir / "results" / name / task_filename(task_id)
            response_file = run_dir / "responses" / name / task_filename(task_id)
            if response_file.exists():
                responses.append(read_json(response_file))
            if result_file.exists():
                record = read_json(result_file)
                records.append(record)
                record_ids.add((name, task_id))
    status = {
        "pid": os.getpid(), "run_dir": str(run_dir), "mode": frozen["mode"],
        "started_at": started, "state": "running", "phase": "preflight",
        "current": None, "stream": None, "error": None,
        "config": {"model": config["model"], "context": config["context_tokens"],
                   "effort": "xhigh", "max_tokens": config["request"]["max_tokens"]},
    }

    def publish(**fields):
        status.update(fields)
        status.update(updated_at=time.time(), benchmarks=summarize(records, totals), performance=performance(responses))
        write_json(run_dir / "status.json", status)

    def interrupted(*_):
        raise KeyboardInterrupt()

    signal.signal(signal.SIGTERM, interrupted)
    publish()
    append_event(run_dir, "run_started", mode=frozen["mode"], totals=totals)
    try:
        health = json_get(config["endpoint"] + "/health")
        if health.get("max_context") != config["context_tokens"] or not health.get("loaded"):
            raise ValueError("Active model/context does not match benchmark configuration")
        if health.get("model") != config["model"]:
            raise ValueError("Active model identity mismatch")
        write_json(run_dir / "model-health.json", health)
        probe = execute(config, run_dir / "sandbox-probe")
        write_json(run_dir / "sandbox-probe.json", probe)
        with Telemetry(config["endpoint"], run_dir):
            for name in BENCHMARKS:
                for task_id, task in tasks[name]:
                    if (name, task_id) in record_ids:
                        continue
                    current = {"benchmark": name, "task_id": task_id}
                    publish(current=current, phase="generating", stream=None)
                    response_file = run_dir / "responses" / name / task_filename(task_id)
                    if response_file.exists():
                        response = read_json(response_file)
                        append_event(run_dir, "reuse_saved_response", **current)
                    else:
                        append_event(run_dir, "generation_started", **current)
                        response = complete(config, prompt_for(name, task), lambda data: publish(stream=data))
                        response.update(benchmark=name, task_id=task_id)
                        write_json(response_file, response)
                        responses.append(response)
                        append_event(
                            run_dir, "generation_completed", **current,
                            finish_reason=response["finish_reason"], wall_s=response["wall_s"],
                        )
                    publish(phase="scoring")
                    score = score_one(config, run_dir, name, task_id, task, response["answer"])
                    record = {
                        **current, "score": score, "finish_reason": response["finish_reason"],
                        "response_file": str(response_file),
                    }
                    write_json(run_dir / "results" / name / task_filename(task_id), record)
                    records.append(record)
                    record_ids.add((name, task_id))
                    append_event(run_dir, "task_scored", **current)
                    publish()
        publish(state="completed", phase="finished", current=None, stream=None)
        write_json(run_dir / "summary.json", {
            "complete": True, "mode": frozen["mode"], "benchmarks": status["benchmarks"],
            "performance": status["performance"],
            "note": "Smoke is pipeline validation, not a full benchmark score.",
        })
        append_event(run_dir, "run_completed")
    except KeyboardInterrupt:
        publish(state="interrupted", phase="stopped", error="Interrupted; completed responses/results are checkpointed")
        append_event(run_dir, "run_interrupted")
        return 130
    except Exception as error:
        publish(state="error", phase="stopped", error=str(error))
        append_event(run_dir, "run_error", error=traceback.format_exc())
        traceback.print_exc()
        return 1
    finally:
        lock.close()
    print(run_dir, flush=True)
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Reproducible single-sample xhigh local evaluation")
    parser.add_argument("--smoke", action="store_true", help="First two examples per dataset; not benchmark scores")
    parser.add_argument("--run-dir")
    parser.add_argument("--resume", action="store_true", help="Keep all existing model outputs; never retry scored failures")
    raise SystemExit(run(parser.parse_args()))
