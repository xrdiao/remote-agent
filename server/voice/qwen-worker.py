"""Qwen's official incremental vLLM API, using the same PCM/stdio protocol as Sherpa."""
import base64
import json
import os
import sys
from pathlib import Path

protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1, encoding="utf-8")
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
sys.stdout = sys.stderr  # Includes native runtime logs, which also write to fd 1.
os.environ.setdefault("VLLM_LOGGING_LEVEL", "ERROR")
os.environ.setdefault("VLLM_ENABLE_V1_MULTIPROCESSING", "0")
os.environ.setdefault("XDG_CACHE_HOME", str(Path(sys.argv[1]).parent / "cache"))
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

import numpy as np
from qwen_asr import Qwen3ASRModel


def emit(**event):
    print(json.dumps(event, ensure_ascii=False), file=protocol, flush=True)


def main():
    recognizer = Qwen3ASRModel.LLM(
        model=sys.argv[1],
        gpu_memory_utilization=float(os.environ.get("QWEN_ASR_GPU_MEMORY", "0.35")),
        max_model_len=8192,
        max_num_seqs=1,
        max_num_batched_tokens=1024,
        limit_mm_per_prompt={"audio": 1},
        enforce_eager=True,
        max_new_tokens=32,
    )
    sessions = {}
    emit(type="ready")
    for line in sys.stdin:
        message = json.loads(line)
        key, kind = message["id"], message["type"]
        try:
            if kind == "start":
                sessions[key] = {"state": recognizer.init_streaming_state(language=None, chunk_size_sec=1.0), "last": ""}
                emit(id=key, type="started")
                continue
            if kind == "cancel":
                sessions.pop(key, None)
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
            sessions.pop(key, None)
            emit(id=key, type="error", message=str(error))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit(type="error", message="Qwen 启动失败：" + str(error))
        raise
