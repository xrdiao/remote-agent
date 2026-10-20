"""Local CPU streaming adapter. JSON lines over stdio; stdout contains events only."""
import base64
import json
import os
import re
import sys
from pathlib import Path

import numpy as np
import sherpa_onnx


def emit(**event):
    print(json.dumps(event, ensure_ascii=False), flush=True)


def format_text(text):
    # Preserve model punctuation/case and English word spaces; remove Chinese token spaces.
    text = re.sub(r"(?<=[\u3400-\u9fff，。！？；：、])\s+(?=[\u3400-\u9fff，。！？；：、])", "", text)
    return re.sub(r"\s+([,.!?;:%，。！？；：、])", r"\1", text).strip()


model = Path(sys.argv[1])
recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
    tokens=str(model / "tokens.txt"),
    encoder=str(model / "encoder-160ms.onnx"),
    decoder=str(model / "decoder-160ms.onnx"),
    joiner=str(model / "joiner-160ms.onnx"),
    num_threads=int(os.environ.get("ASR_THREADS", "2")),
    sample_rate=16000, feature_dim=80, decoding_method="greedy_search",
    provider="cpu", model_type="zipformer2", enable_endpoint_detection=False,
)
sessions = {}
emit(type="ready")
for line in sys.stdin:
    message = json.loads(line)
    key, kind = message["id"], message["type"]
    try:
        if kind == "start":
            sessions[key] = {"stream": recognizer.create_stream(), "last": ""}
            emit(id=key, type="started")
            continue
        if kind == "cancel":
            sessions.pop(key, None)
            continue
        session = sessions[key]
        stream = session["stream"]
        if kind == "audio":
            samples = np.frombuffer(base64.b64decode(message["audio"]), dtype="<i2").astype(np.float32) / 32768.0
            stream.accept_waveform(16000, samples)
        elif kind == "end":
            # Pad the right context so words at finger release are not truncated.
            stream.accept_waveform(16000, np.zeros(8000, dtype=np.float32))
            stream.input_finished()
        while recognizer.is_ready(stream):
            recognizer.decode_stream(stream)
        result = format_text(recognizer.get_result(stream))
        if kind == "end":
            emit(id=key, type="final", text=result)
            del sessions[key]
        elif result != session["last"]:
            session["last"] = result
            emit(id=key, type="partial", text=result)
    except Exception as error:
        sessions.pop(key, None)
        emit(id=key, type="error", message=str(error))
