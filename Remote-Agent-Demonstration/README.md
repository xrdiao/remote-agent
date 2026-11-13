# Remote Agent Demo Animation

Promo animation: "No remote desktop. Just your agent, on your phone." (zh: 不用远程桌面，手机直接遥控 Agent。)
Total run ≈ 55 s, then the outro holds.

## Scenes (v2, see `RA-STORYBOARD.md`)

`quad` 2.5s → `phoneout` 1.0s → `expand` 0.9s → `matchcut` 1.2s → `launch` 1.5s → `seed` → `shot1` 2.5s → `shot2` 2.2s → `shot3` 4.6s → `shot4` 1.5s → `shot5` 2.5s → `shot6` 4.0s → `shot7` 3.5s → `ask` 7.5s → `voice` 6.0s → `theme` 2.7s → `more` 6.5s → `done` 4.5s → `outro` 7.0s (timeline offset 0.35s; ends ≈62.5s).

Phase 1: the four-panel intro (four people, one thought) + shots 1-7 (overview loading → grouped tiles → expanded card + typing → open → chat push + send → back + monitor + vertical/horizontal relay → mirrored new steps) are built for **both orientations**. Scenes `ask`→`outro` still render in the v2 look and are landscape-complete; their portrait restyle is **竖屏化完成**.

The whole demo is light-themed. The `theme` beat is the exception: the phone opens the real ⋮ main menu, taps 主题/Theme, and a View Transition circle expands from that row to flip stage + desktop + every phone to dark for ~1 s, then a second circle returns to light. All demo colors are theme variables on `html[data-theme="light"|"dark"]`.

## Entry files

- `RA-Demo-zh.html` — Chinese version (landscape)
- `RA-Demo-en.html` — English version (landscape)
- `RA-Demo-zh-portrait.html` / `RA-Demo-en-portrait.html` — portrait versions (`window.DEMO_ORIENT='portrait'`); any entry also accepts `?o=portrait`
- `intro.js` — quad-intro keyframe art (SVG scene builders shared by both orientations)
- `app-ui/` — master `app.css` + `logo-*.svg` + `icon-192.png`, so `phone.html` no longer depends on `../app/`
- `ra-demo.js` — engine, session state `AG`, scenes, desktop renderer, phone orchestration, theme transitions
- `ra-demo.css` — light/dark theme variables, stage geometry
- `phone.html` — the phone screen: a mock of the real app UI (`../app/` DOM structure), loaded in an iframe
- `phone.css` — phone-only chrome the real app doesn't have (lock screen, fake iOS keyboard, ripples)
- `phone.js` — message-driven renderer inside the iframe
- `ra-strings.js` — `RA_STRINGS = { zh: {...}, en: {...} }`
- `assets/ra-icon.svg` — the only image (brand icon, outro)
- `RA-STORYBOARD.md` — the authoritative shot list

`phone.html` links `app-ui/app.css` for the real app theme, reuses the app's DOM ids/classes, and loads `app-ui/logo-*` / `app-ui/icon-192.png` (a self-contained copy of the master assets). Everything still works from `file://`: the parent and iframes only talk via `postMessage` (`{type:'ready'}` and `{type:'themed'}` up; `{type:'state', state, instant}`, `{type:'fx', name, args, dur}` and `{type:'theme', theme}` down). The theme switch posts `{type:'theme'}` to every iframe and the View Transition update resolves only after all ack `{type:'themed'}`.

Open either HTML file by double-clicking it. No server, network, fonts or libraries are needed.

## URL parameters

- `?t=<sec>` seeks to a time on the timeline. Seeking replays the scene cues instantly (`instant:true` states, effects skipped, theme applied without transition), so the page lands in the same state playback would reach.
- `&pause=1` freezes the clock at the seek point (useful for stills and debugging).
- `?speed=<n>` plays faster or slower (e.g. `?speed=2`).
- `?loop=1` restarts after the outro.
- `?debug=1` dumps key element rects into a `<pre id="dbg">`.
- `?vt=1` runs the clock off a timer instead of rAF — only needed for headless `--dump-dom`/capture checks, where rAF stalls under `--virtual-time-budget`.

Example: `RA-Demo-zh.html?t=30&pause=1`

## Design

- A fixed 1920×1080 design space, scaled to the window. A virtual clock runs the scene list (`scene(id, dur, build)`), and everything inside a scene is scheduled with `at()`, `wait()` and `tween()` (no `setTimeout`/`setInterval` in the timeline), so seeking is deterministic.
- One session state object `AG` (messages, test progress, draft, question, status, lock/notifications, terminal, file, theme) is changed only through the `ag*` mutators. Each change renders into the desktop agent panel and is posted to the phone iframe(s), so both sides always match; `phone.js` never invents session content.
- The desktop is a light Cursor-style IDE: file tree | editor with terminal beneath | ~420px agent panel flush to the right edge. The `rdp` scene shows a phone whose screen is a scaled `cloneNode` of the desktop screen (pinch/tap/shake failure beat). The `fly` scene hands the agent panel off to the phone with a cloned flight element following a quadratic-Bézier arc.
- The `more` scene adds two tilted side phones running `phone.html?screen=term` and `?screen=file`, labels below the frames.
- The phone is driven by finger ripples (no cursor). The desktop has no cursor.
- The caption bar is bottom-centered; focus beats dim the monitor/relay to ~45% instead of camera push-ins, so nothing covers the caption.

## Recording

Run Edge fullscreen without browser chrome and capture with OBS at 1920×1080, 60 fps. Keep the tab in front; the clock pauses while the page is hidden:

`msedge --kiosk "file:///E:/Codes/remote-agent/Remote-Agent-Demonstration/RA-Demo-zh.html" --edge-kiosk-type=fullscreen`
