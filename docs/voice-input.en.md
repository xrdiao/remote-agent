# Voice input

[README](../README.en.md) · [中文](voice-input.md)

Use an HTTPS entry. Click the voice input icon at the top right of the **…** menu, enable it and select an engine. Hold the microphone to speak and release to finish. Partial text appears while speaking; final text is inserted at the caret without sending the message. Chinese and English can be mixed when using the local models.

| Engine | Runs on | Requirements |
|---|---|---|
| Sherpa / X-ASR | Paired computer, CPU | Python 3.10+, no GPU |
| Qwen3-ASR-1.7B | Paired computer, GPU | Current installer requires Linux and an NVIDIA GPU |
| Phone system recognition | Phone / browser | Available only where the browser supports the API; service and network requirements vary |

## Install Sherpa

```bash
npm run voice:setup
```

After asking for consent, the installer creates an isolated environment under `~/.agent-remote/asr/`, installs CPU sherpa-onnx and downloads the approximately 615 MB X-ASR 160ms Chinese/English model. No third-party recognition service is needed at runtime. Windows uses `py -3`; Linux may need `python3-venv`. Set `ASR_SETUP_PYTHON` to choose the installation Python executable.

## Install Qwen

```bash
npm run voice:setup -- --engine qwen
```

Uses the [official vLLM streaming interface](https://github.com/QwenLM/Qwen3-ASR/blob/main/examples/example_qwen3_asr_vllm_streaming.py). Consent is requested separately. The installer uses an isolated environment and downloads about 4 GB of model files, plus runtime dependencies. It does not replace Sherpa, update system GPU drivers or install system CUDA. Add `--dir /path/to/voice-storage` to choose another location; reopen the engine list after installation.

Qwen processes approximately one second of audio per incremental recognition step; this is not a promise of one-second end-to-end latency. Initial text and cold-start time depend on hardware. `QWEN_ASR_GPU_MEMORY` sets the vLLM GPU memory fraction (default `0.35`); it is not GPU isolation or a guarantee of no impact on other tasks. Computers without a GPU can use Sherpa.

## Preparation and recording

- Only installed computer engines appear, alongside the system-recognition option where supported. Selection is saved per computer in the current browser.
- With voice enabled, authentication and page recovery trigger background warmup immediately. Changes made inside the engine menu are combined for 300ms after leaving the list; only the final engine is started. Warmup does not request microphone access or create the recording AudioContext.
- The selected engine reuses its process and audio connection. Switching stops the previous engine. Qwen's dependency preparation and GPU activation are separate stages; dependency preparation alone does not mean the model is ready to transcribe. With no audio clients, its existing idle policy releases GPU memory after 60 seconds.
- If the model is not ready, pressing the microphone shows preparation status without opening the microphone or recording later automatically. Press again when ready.
- Recording and finalization must finish before switching engines. A failed switch does not silently select another engine.
- Release stops microphone tracks immediately and finalizes transcription. Editing manually, switching sessions/pages or disconnecting stops recording; text already inserted stays in the draft. Other draft text is retained.
- During Agent generation, the microphone replaces the stop button while the composer is in use, with about a two-second input buffer. Queue and append behavior is unchanged.
- Audio for local engines uses a separate paired connection, is processed in memory and is not saved as recordings. `ASR_THREADS` controls CPU recognition threads (default `2`). Phone system recognition bypasses the computer model and may use an external service chosen by the browser or OS.

## Microphone access

Allow microphone access when first prompted, then hold again. Plain LAN HTTP cannot request microphone access. If an embedded browser such as WeChat fails, try Safari / Chrome or keyboard dictation. Permission persistence varies by browser.

The updated iOS shell handles site permission for its own trusted page; iOS still controls system microphone permission. Android needs a build containing the microphone permission bridge. Publishing the web app does not update installed native shells.

On initialization errors, check HTTPS, permission and whether another app is using the microphone. Startup failures include details in the relay log. Real-device behavior can differ from browser simulation.
