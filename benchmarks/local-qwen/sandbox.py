import json
import os
import subprocess
import uuid
from pathlib import Path

from common import CODE, write_json


def command(config, input_path=None):
    root = Path(config["artifact_root"])
    memory = str(config["sandbox_memory_bytes"])
    args = [
        "/usr/bin/systemd-run", "--user", "--wait", "--pipe", "--quiet", "--collect",
        "--unit=qwen-score-" + uuid.uuid4().hex,
        "--property=MemoryMax=" + memory,
        "--property=MemorySwapMax=" + str(config["sandbox_swap_bytes"]),
        "--property=TasksMax=" + str(config["sandbox_tasks_max"]),
        "/usr/bin/bwrap", "--unshare-all", "--die-with-parent", "--new-session",
        "--cap-drop", "ALL", "--ro-bind", "/usr", "/usr",
        "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib",
        "--symlink", "usr/lib64", "/lib64",
        "--dir", "/etc", "--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache",
        "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/dev/shm", "--tmpfs", "/tmp",
        "--ro-bind", str(CODE), "/code",
        "--ro-bind", str(root / "vendor"), "/vendor",
        "--ro-bind", str(root / "venv"), "/venv",
        "--chdir", "/tmp", "--clearenv",
    ]
    if input_path is not None:
        args += ["--ro-bind", str(input_path), "/input.json"]
    for key, value in {
        "HOME": "/tmp", "TMPDIR": "/tmp", "PATH": "/usr/bin:/bin",
        "PYTHONPATH": "/vendor", "NLTK_DATA": "/vendor/nltk_data",
        "XDG_CACHE_HOME": "/tmp/cache", "LC_ALL": "C.UTF-8",
        "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1",
        "HF_HUB_OFFLINE": "1", "HF_DATASETS_OFFLINE": "1",
        "EVALPLUS_MAX_MEMORY_BYTES": memory, "PYTHONDONTWRITEBYTECODE": "1",
    }.items():
        args += ["--setenv", key, value]
    return args + ["/venv/bin/python", "/code/score_worker.py", "/input.json" if input_path else "--probe"]


def execute(config, directory, payload=None):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    input_path = directory / "input.json" if payload is not None else None
    if input_path:
        write_json(input_path, payload)
    completed = subprocess.run(
        command(config, input_path), capture_output=True, text=True,
        timeout=config["scoring_process_timeout_s"], check=False,
    )
    (directory / "stdout.log").write_text(completed.stdout)
    (directory / "stderr.log").write_text(completed.stderr)
    if completed.returncode:
        raise RuntimeError(
            f"Sandbox scorer exited {completed.returncode}: {completed.stderr[-2000:]}; see {directory}"
        )
    try:
        return json.loads(completed.stdout.splitlines()[-1])["result"]
    except (IndexError, KeyError, json.JSONDecodeError) as error:
        raise RuntimeError(f"No official scorer result; see {directory}") from error


def score_one(config, run, benchmark, task_id, task, answer):
    target = Path(run) / "grading" / benchmark / task_id.replace("/", "_")
    return execute(config, target, {
        "benchmark": benchmark, "task": task, "answer": answer, "config": config,
    })
