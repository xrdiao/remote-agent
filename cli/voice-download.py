"""Download one matching model revision; urllib uses the computer's proxy settings."""
import json
import os
import shutil
import sys
import urllib.request
from pathlib import Path

repo = "GilgameshWind/X-ASR-zh-en"
qwen = len(sys.argv) > 2 and sys.argv[2] == "qwen"
if qwen:
    repo = "Qwen/Qwen3-ASR-1.7B"
with urllib.request.urlopen(f"https://huggingface.co/api/models/{repo}", timeout=30) as response:
    revision = json.load(response)["sha"]
target = Path(sys.argv[1])
target.mkdir(parents=True, exist_ok=True)
files = ["encoder-160ms.onnx", "decoder-160ms.onnx", "joiner-160ms.onnx", "tokens.txt"]
if qwen:
    from huggingface_hub import snapshot_download
    snapshot_download(repo_id=repo, revision=revision, local_dir=str(target), ignore_patterns=["*.md", ".gitattributes"])
    files = [str(p.relative_to(target)) for p in target.iterdir() if p.is_file()]
    (target / "source.json").write_text(json.dumps({"repo": repo, "revision": revision, "files": files}, indent=2) + "\n")
    sys.exit(0)
for name in files:
    print(f"下载 {name}…", flush=True)
    part = target / (name + ".part")
    try:
        url = f"https://huggingface.co/{repo}/resolve/{revision}/deployment/models/chunk-160ms-model/{name}"
        with urllib.request.urlopen(url, timeout=60) as response, part.open("wb") as output:
            shutil.copyfileobj(response, output, 1024 * 1024)
        os.replace(part, target / name)
    finally:
        part.unlink(missing_ok=True)
(target / "source.json").write_text(json.dumps({"repo": repo, "revision": revision, "files": files}, indent=2) + "\n")
