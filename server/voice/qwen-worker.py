"""Qwen's official incremental vLLM API, using the same PCM/stdio protocol as Sherpa.

Two-phase lifecycle so the engine can stay warm without holding VRAM:

  phase 1 (spawn): imports + page-cache prefetch only — no CUDA, 0 VRAM.
                   Emits {"type":"prepared"}.
  {"type":"load"}: construct the vLLM engine. Emits {"type":"ready"};
                   start/audio/end/cancel are only valid afterwards. Repeated
                   load while loaded just emits ready again.

  Idle release is handled by the relay respawning a fresh phase-1 worker —
  vLLM sleep level 2 was measured to free only ~1.3 GiB of ~5.7 GiB on this
  stack (weights bypass the CuMemAllocator pool), so it is not used.
"""
import base64
import json
import os
import sys
import threading
import time
from pathlib import Path

protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1, encoding="utf-8")
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
sys.stdout = sys.stderr  # Includes native runtime logs, which also write to fd 1.
os.environ.setdefault("VLLM_LOGGING_LEVEL", "ERROR")
os.environ.setdefault("VLLM_ENABLE_V1_MULTIPROCESSING", "0")
os.environ.setdefault("XDG_CACHE_HOME", str(Path(sys.argv[1]).parent / "cache"))
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

_t0 = time.monotonic()


def mark(label):
    print(f"[qwen-worker] {label} at {time.monotonic() - _t0:.3f}s", file=sys.stderr, flush=True)


def emit(**event):
    print(json.dumps(event, ensure_ascii=False), file=protocol, flush=True)


mark("process start")

def prefetch_model_files():
    """Stream model files through the OS page cache; nothing is retained."""
    for entry in sorted(Path(sys.argv[1]).iterdir()):
        if not entry.is_file() or entry.stat().st_size == 0:
            continue
        try:
            with open(entry, "rb") as handle:
                while handle.read(8 * 1024 * 1024):
                    pass
        except OSError:
            pass


# Disk prefetch overlaps the expensive Python imports; this stage never initializes CUDA.
threading.Thread(target=prefetch_model_files, daemon=True).start()

import numpy as np
import vllm  # noqa: F401 — phase-1 warmup: resolves sys.modules without any CUDA init
from qwen_asr import Qwen3ASRModel

mark("imports done")


def construct_recognizer():
    return Qwen3ASRModel.LLM(
        model=sys.argv[1],
        dtype="bfloat16",  # explicit compute dtype; matches the resolved bfloat16
        hf_overrides={"torch_dtype": "bfloat16"},  # skips the ~2s remote safetensors dtype probe
        gpu_memory_utilization=float(os.environ.get("QWEN_ASR_GPU_MEMORY", "0.35")),
        max_model_len=8192,
        max_num_seqs=1,
        max_num_batched_tokens=1024,
        limit_mm_per_prompt={"audio": 1},
        enforce_eager=True,
        max_new_tokens=32,
    )


def main():
    recognizer = None
    sessions = {}
    emit(type="prepared")
    for line in sys.stdin:
        message = json.loads(line)
        kind = message["type"]
        try:
            if kind == "load":
                if recognizer is None:
                    mark("load start")
                    recognizer = construct_recognizer()
                    mark("CUDA/LLM constructed")
                emit(type="ready")
                mark("ready")
                continue
            key = message.get("id", "")
            if kind == "cancel":
                sessions.pop(key, None)
                continue
            if recognizer is None:
                raise RuntimeError("model not loaded")
            if kind == "start":
                sessions[key] = {"state": recognizer.init_streaming_state(language=None, chunk_size_sec=1.0), "last": ""}
                emit(id=key, type="started")
                continue
            session = sessions[key]
            state = session["state"]
            if kind == "audio":
                samples = np.frombuffer(base64.b64decode(message["audio"]), dtype="<i2").astype(np.float32) / 32768.0
                recognizer.streaming_transcribe(samples, state)
            elif kind == "end":
                recognizer.finish_streaming_transcribe(state)
            if kind == "end":
                emit(id=key, type="final", text=state.text)
                del sessions[key]
            elif state.text != session["last"]:
                session["last"] = state.text
                emit(id=key, type="partial", text=state.text)
        except Exception as error:
            sessions.pop(message.get("id", ""), None)
            emit(id=message.get("id"), type="error", message=str(error))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit(type="error", message="Qwen 启动失败：" + str(error))
        raise
