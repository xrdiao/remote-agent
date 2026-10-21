# Remote Agent Demo Animation

Promo animation: "No remote desktop. Just your agent, on your phone." (zh: 不用远程桌面，手机直接遥控 Agent。)
Total run ≈ 74 s, then the outro holds.

## Entry files

- `RA-Demo-zh.html` — Chinese version
- `RA-Demo-en.html` — English version
- `ra-demo.js` — engine, session state, scenes
- `ra-demo.css` — light theme and geometry
- `ra-strings.js` — `RA_STRINGS = { zh: {...}, en: {...} }`
- `assets/ra-icon.svg` — the only image (brand icon, outro)
- `RA-STORYBOARD.md` — the authoritative shot list

Open either HTML file by double-clicking it. No server, network, fonts or libraries are needed (works from `file://`).

## URL parameters

- `?t=<sec>` seeks to a time on the timeline. Seeking replays the scene cues instantly, so the page lands in the same state playback would reach.
- `&pause=1` freezes the clock at the seek point (useful for stills and debugging).
- `?speed=<n>` plays faster or slower (e.g. `?speed=2`).
- `?loop=1` restarts after the outro.

Example: `RA-Demo-zh.html?t=30&pause=1`

## Design

- Pure geometry: no frames and no screenshots. Text lines are rounded grey bars; only key texts (prompts, tool names and arguments, the question and options, notifications, the typed draft, the final message, captions) are real text.
- A fixed 1920×1080 design space, scaled to the window. A virtual clock runs the scene list (`scene(id, dur, build)`), and everything inside a scene is scheduled with `at()`, `wait()` and `tween()` (no `setTimeout`/`setInterval`), so seeking is deterministic.
- One session state object `AG` (messages, test progress, draft, question, status, view) is changed only through `agPush`, `agUpdate`, `agDraft`, `agQuestion`, `agAnswer`, `agStatus` and `agView`. Each change renders into the desktop agent panel and the phone chat at the same time, so both sides always match.
- The only exception is the A2 flying panel, which is a `cloneNode` of the desktop panel and is removed when the phone renderer takes over.
- The phone is driven by finger ripples (no cursor). The desktop has no cursor.

## Recording

Run Edge fullscreen without browser chrome and capture with OBS at 1920×1080, 60 fps. Keep the tab in front; the clock pauses while the page is hidden:

`msedge --kiosk "file:///E:/Codes/remote-agent/Demonstration/RA-Demo-zh.html" --edge-kiosk-type=fullscreen`
