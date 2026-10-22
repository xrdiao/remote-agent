# Remote Agent

**Turn your phone into a remote control for Cursor, Devin and Codex.**

Read streaming conversations, switch projects and sessions, answer questions, approve execution, use terminals and transfer files. Fusion lets two Agents collaborate. The relay runs on your own computer; connect from a browser, PWA or the Android / iOS shells.

[Quick start](#quick-start) · [Features](#features) · [Feature guide](docs/usage.en.md) · [Voice input](docs/voice-input.en.md) · [Security](docs/security.en.md) · [中文](README.md)

<p align="center">
  <img src="docs/screenshots/redacted/chat-light.png" alt="Light mobile chat UI; project name and account usage are redacted" width="280">
  <img src="docs/screenshots/redacted/chat-dark.png" alt="Dark mobile chat UI; project name and account usage are redacted" width="280">
</p>

> Self-hosted control does not replace an Agent account or subscription. Keep the computer on and launch the desktop applications with their debug ports enabled.

## Features

| Area | What you can do |
|---|---|
| Agent conversations | Connect Cursor, Devin and Codex; read streaming responses, thinking, history and code; toggle execution and tool records per Agent |
| Projects and sessions | Browse conversations grouped by project, create or switch sessions, preserve existing project windows and receive sign-in/trust prompts |
| Models and usage | Select native models, reasoning effort and parameters; view context usage, remaining quota and native pricing where provided |
| Questions and approvals | Answer Question cards and terminal execution approvals; queue, edit queued input or append where the Agent supports it |
| Files and images | Reference project files with `@`, add computer files, browse/edit project files, preview highlighted content and diffs; attach, crop and annotate images, then view thumbnails or originals |
| Terminal | Read output, send commands and interactive input, switch terminals, copy output, recall history and send control keys |
| File transfer | Select across directories, download folders as ZIP and upload batches to a separate computer destination; progress, cancellation and retry |
| Mixed-language speech | Hold to speak and release to finalize into the draft; choose Sherpa CPU, Qwen GPU or supported phone system recognition |
| Plot and simulation viewing | Read-only viewing of Matplotlib, Isaac Sim, MuJoCo and similar windows, with window selection, zoom and refresh |
| Fusion collaboration | A plans and reviews, B executes using existing Agents; separate from Devin's native Fusion model mode |
| Connection and appearance | Fixed entry, device/entry management, optional two-step verification, notifications, light/dark themes, Chinese/English and home-screen installation |

Availability follows each Agent, desktop version and current window. File transfer is separate from chat attachments; screen viewing is read-only. See the [feature guide](docs/usage.en.md).

<details>
<summary>More UI: projects, models, file transfer and voice</summary>

<p align="center">
  <img src="docs/screenshots/redacted/projects.png" alt="Project-grouped sessions with private names redacted" width="250">
  <img src="docs/screenshots/redacted/models.png" alt="Native model menu with private account/background information redacted" width="250">
</p>
<p align="center">
  <img src="docs/screenshots/redacted/transfer.png" alt="Batch computer-file download UI with the directory redacted" width="250">
  <img src="docs/screenshots/redacted/voice.png" alt="Installed voice engines with private background information redacted" width="250">
</p>

</details>

Screenshots use a paired Chrome browser at iPhone 17 dimensions: 402×874 CSS pixels, 3× output. They are redacted browser captures, not real-iPhone validation. The gallery uses the Chinese UI shared by both READMEs. [Screenshot notes](docs/screenshots/README.md)

## Quick start

Requires **Node.js 22+**, at least one installed and signed-in desktop Agent, and a phone browser. Public access also needs `cloudflared`; a personal fixed Pages entry needs GitHub CLI (`gh`).

```bash
git clone https://github.com/xrdiao/remote-agent.git
cd remote-agent
npm install
```

### Ubuntu launchers

```bash
./ubuntu_start/start-agents.sh
./ubuntu_start/pair.sh
```

Launch installed Agents, then choose a personal fixed entry or temporary tunnel and pair the phone. Temporary mode needs no GitHub login; fixed mode uses your own account. Launchers reuse running services, and closing the launcher terminal leaves the background relay running.

### Windows launchers

Run `window_start/start-agents.cmd`, then double-click `window_start/pair.exe` or run `window_start/pair.cmd`. Install and sign in to `gh` before configuring a fixed entry. See the [installation guide](docs/getting-started.en.md) for dependencies.

### Manual startup: Linux / macOS / Windows

Enable the debug port for the Agent(s) you need; you do not need to start all three.

| Agent | Default debug port | Startup |
|---|---|---|
| Cursor | 9222 | Linux: `cursor --remote-debugging-port=9222`; macOS: `./scripts/start-cursor.sh`; Windows: see installation guide |
| Devin Desktop | 9223 | Linux: `./scripts/start-devin.sh`; other systems: add `--remote-debugging-port=9223` to its executable |
| Codex (VS Code extension) | 9224 | Linux/macOS: `./scripts/start-codex.sh`; Windows: `code --remote-debugging-port=9224`; open the Codex sidebar |

If an app is running without the port, save your work and quit it first. The macOS Cursor script quits and restarts Cursor.

```bash
npm run public
```

Leave the relay terminal running. In another terminal:

```bash
npm run pair
```

Scan the QR code or open your own fixed entry and enter the full manual code. Reuse the same entry after pairing and preserve `~/.agent-remote/` on the computer. Add the page to the home screen in Safari on iPhone or install the PWA on Android. Native shell build information is linked below.

For LAN-only use, run `npm run start` and `npm run pair -- --lan`. Plain HTTP does not provide web microphone access, camera scanning, Web Push or offline caching. Platform dependencies, PowerShell commands, setup wizard, fixed-entry configuration and troubleshooting are in the [installation guide](docs/getting-started.en.md).

## Optional features and platform requirements

| Feature | Additional requirements |
|---|---|
| Sherpa Chinese/English speech | `npm run voice:setup`; Python 3.10+, CPU, approximately 615 MB model |
| Qwen3-ASR-1.7B | `npm run voice:setup -- --engine qwen`; current installer needs Linux / NVIDIA GPU, approximately 4 GB model plus dependencies |
| Browser recording | HTTPS and microphone permission; only the selected model is warmed, without opening the microphone early |
| Windows screen capture | FFmpeg with `gdigrab hwnd=` |
| Linux X11 capture | FFmpeg, `xprop`, system Python 3 |
| Linux Wayland capture | Desktop-sharing approval, PyGObject, GStreamer / PipeWire |
| Notifications and native extensions | Browser support, OS permission and push configuration; web publication does not upgrade installed shells |

Voice dependencies use isolated virtual environments without changing system GPU drivers or CUDA. Qwen cold starts take longer; engine switching and initial readiness can require waiting. Phone system recognition may use a network service controlled by the browser or OS. [Voice details](docs/voice-input.en.md) · [Screen and file guide](docs/usage.en.md)

## How it works and security

```text
Phone browser / PWA / native shell
               | HTTPS tunnel or LAN
               v
        Local relay (default 3939)
               | CDP debug connections
               +-- Cursor        9222
               +-- Devin Desktop 9223
               +-- VS Code/Codex 9224
```

Fusion orchestrates these Agent connections. Speech uses the selected engine; file transfer uses separate HTTP endpoints.

This tool can operate real terminals and files accessible to the computer's current user. Pair trusted entries only and keep pairing codes, tokens and debug ports private. Use `npm run 2fa` for optional two-step verification and `npm run devices` to inspect/revoke authorization. Browsers keep independent credentials and can be invited from a trusted entry; device grouping does not bypass authentication. See [security](docs/security.en.md).

## Documentation and development

- [Installation, startup, pairing, commands and troubleshooting](docs/getting-started.en.md)
- [Projects, terminal, attachments, file transfer, screen and Fusion](docs/usage.en.md)
- [Voice installation, engine switching and microphone requirements](docs/voice-input.en.md)
- [Connections, device entries and security](docs/security.en.md)
- [Windows Devin maintenance (Chinese)](docs/windows-devin-maintenance.md)

Directories: `server/` relay and adapters, `app/` mobile web UI, `lib/` shared capabilities, `cli/` setup tools, `android/` and `ios/` native shells, `push-service/` iOS push service.

Development checks: `npm run check`. Native build/release conventions: [AGENTS.md](AGENTS.md). iOS push deployment: [push-service/README.md](push-service/README.md).

## License and acknowledgements

[MIT License](LICENSE). Reference project: [cursor-remote-lite](https://github.com/Suchenl/cursor-remote-lite).
