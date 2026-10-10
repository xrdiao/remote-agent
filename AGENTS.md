# Remote Agent

Phone web app (`app/`) + Node relay (`server.mjs`) that remote-controls desktop
agent apps (Cursor, Devin) over CDP. Android is a WebView wrapper around `app/`.

## Per-app scraping (server.mjs `pageHelpers()`)

- App-specific scraping lives in separate per-app functions (e.g. `devinItems`,
  `devinEventTool`, `devinCommand`, `devinEdit`) and MUST be gated by an
  app-specific DOM check — Devin: `[role="log"][aria-label="Session transcript"]`.
- Every item an app-specific scraper produces carries `src: '<app>'`. The client
  (`app/index.html`) gates app-specific rendering (rich tool rows, brain icon)
  on `it.src`; items without `src` render with the generic path only.
- The Devin transcript is virtualized. Relay-side `mergeDevinHistory()` merges
  mounted rows into per-session history keyed by `data-acp-msg-index`
  (`acp<N>` ids; thinking items `acp<N>:think`) and reports `chat.earlier`.
- Cursor extraction (`findPanel`/`topItems`/`messageItem`) must stay unchanged;
  keep any new app work in its own gated branch.
- Devin extras: file review = a compact bar ("N files | +a -d | Reject all |
  Accept all"); the per-file rows stay in the DOM when folded (display:none), so
  `filesState()` reads them without clicking. Folded: the "N files" group
  (`div.select-none`) opens the list; expanded: the header "N files with changes"
  folds it. Actions open the list only when needed and fold it again. The count
  falls back to the editor pane's "Review N files" button when the chat bar is
  not mounted. Row check = Accept, x = Reject, hover reveals them. Terminals =
  monaco list under `[aria-label="Terminal tabs"]`, each `.terminal-wrapper`
  carries its xterm.js instance as `.xterm` (text via `terminalDump`); the
  cropped screencast is only the fallback when no buffer exists; file refs
  resolve on disk via `resolveLocal()` in files.mjs (never `quickOpen`).
- Devin messages: `[role=group][aria-label="Devin message"] .prose-main` is
  Devin's markdown root; `devinRich()` runs `clean()` with `devin=true` (links,
  h6, code blocks via `[data-md-code-block]`). Assistant `h` is HTML.
- Thoughts: a collapsed Devin thought has no body in the DOM, so the relay
  captures it. `captureThoughts()` (Devin only, each poll, max 2) takes finished
  thoughts with no body and calls `readThought()`: expand unless the user already
  has it open, poll `thoughtBodyText` up to 1.5 s, fold back if we opened it. A
  thought is marked tried only after a body was read or 3 failed reads on
  different polls (the old code marked non-newest thoughts after one poll, so
  they were never read). `mergeDevinHistory` keeps a body already seen (sticky),
  keeps ~2 MB of bodies, and sends bodies for the newest 12 / 80 KB only
  (`more:true` otherwise). `{t:'thought', i}` uses the same `readThought()`.
- Tasks: `{k:'tasks', done, total, items?}` from "N / M tasks done" rows;
  checklist items exist only while the row is expanded, so `pollChat` expands
  once per count (`setTasksOpen`) and folds it back.
- Busy/queue (Devin): submit button aria-label "Cancel" (empty input) or
  "Queue" (typed text) while running; `send` with `when:'now'` uses Ctrl/⌘+Enter
  (Ctrl+Enter not yet exercised live). Queue (verified live on a queued message):
  bar `span` "N message(s) queued" (`queuedCount`) with a "Clear all" button; rows
  are `ol li[role=button].cursor-grab` with the text; hover reveals "Edit message",
  "Remove from queue", "Send now" (hover checked with elementFromPoint). Clicking
  those buttons is unverified; Edit is not offered.
- Questions (Devin): the ask-question card is a `[data-band-item]` above the
  composer (not in the transcript): one question at a time, pager "Previous/Next
  question" + "N of M", "Skip", option rows `div[role=button]` under
  `[data-slot=scroll-area-viewport]`; multi-select rows carry
  `span[role=checkbox][aria-checked]` and the card has a Submit button; a single
  choice answers when its row is clicked; free text goes through the normal
  composer. `devinQuestions()` / `devinQuestionTarget()` feed `chat.questions`
  (`devin:true`, `pager`, `hasSubmit`); parts option/skip/submit/prev/next.
  Parsing and hit-tests verified live on Q1 and Q2; the answer clicks are unverified.
- Devin sessions: a session is identified by its title (`devinSession()`: Editor =
  the tab strip above the transcript, active tab has `bg-ide-tab-active-background-color`;
  Agent = the sidebar's current row). `chat.session = {key, title, surface, tabs}`.
  `syncSession()` parks the relay's per-session state (`devinHist`, thought bodies,
  task/thought retry maps) under the old key and loads the new one when the key
  changes (a rename with the same tab count keeps state); `resetDevinView()` only
  forces a re-emit. The phone resets its caches when `session.key` changes and shows
  the tabs as chips (`openAgent` with id `tab:<title>` clicks the tab). Caveat: two
  sessions with the same title share one state.
- Phone history cache (Devin sessions only, needs `chat.session.key`): `SC` in
  app/index.html merges every relay chat into a per-session map keyed by item id
  (`scMerge`; thought bodies and task items are sticky via `scKeep`), persisted in
  IndexedDB `cr-sessions` (`h:<comp>|<app>|<session>` rows, `m:` metadata), never
  trimmed except by the user ("会话缓存" menu) or SC_MAX=8000 rows. A turn = a user
  message plus the rows up to the next one; turns fold (`data-fold`, state stored with
  the session); older rows are windowed (`SC.show`, "显示更早的本地记录"). Cursor chats
  have no session key and render exactly as before.
- Devin "@" mentions: typing `@` in the Slate prompt opens a `[role=listbox]` (root rows: Files,
  Directories, Git, Rules, Skills, Conversations, Terminal, Codemaps; Enter on a category types
  `@terminal:` etc. and lists its items; `@file:ser` lists files with their folder as second line).
  Clicking an option replaces the typed text with a chip. The relay (`mentionQuery`, `insertMention`,
  `typeWithMentions`) drives that typeahead: the phone sends `{t:'mentionQuery', q|cat, seq}` while
  you type, and `mentions:[{token,q,label,sub}]` with `send`; at each `@token` the chip is inserted
  in order. Queries type then undo (Escape + Backspace) so the desktop prompt is left as it was.
- File upload: the phone's paperclip sends `{t:'upload', id, seq, last, name, size, data}` in 384 KB
  base64 chunks, one `uploadAck` per chunk before the next (`receiveUpload`); files are saved to
  `DATA_DIR/uploads/<stamp>-<id>/<name>` (name sanitised, 100 MB limit, pruned after 14 days) and
  `{t:'uploaded', path}` makes the phone add an "Uploaded file: <path>" line to the message.
  Images still use the native attach (`{t:'image'}`).
- Android notification actions (Devin only): `agentState()` for Devin adds `actions` (single-choice
  options, `opt:<i>`), `devin`, `changed`; notify.mjs `extras()` puts `reply:true` and `actions` (+ `acceptAll`
  on "done" when files changed) in the event. NotifyService shows them as buttons / a RemoteInput and
  ActionReceiver POSTs `{win, act:'opt'|'reply'|'acceptAll', index?, text?}` to `/api/act`, which runs it
  through `actOnWindow()` (a short-lived Session: no polling, no screencast). Needs the rebuilt APK.
- Background connection: NotifyService's notification shows connecting/connected/retry, reconnects at
  once when the network changes (`registerDefaultNetworkCallback`) or on `nudge()`, and the web menu
  "后台连接" shows `listenStatus()` / `batteryOk()` and asks for the battery-optimization exemption.
- Native history store (APK only): `HistoryDb` (SQLite in app-private storage) behind the
  `AgentRemoteApp.hist*` bridge; the web `SC` layer uses it instead of IndexedDB when present (old
  IndexedDB sessions are copied once, flag `histMig1`) and indexes message text for `histSearch`.
- Devin working directory (Agent surface, new-session screen only): the chip row has "Local ▾" (Local /
  Worktree / Cloud, `role=menuitem`) and the folder chip, which opens a quick pick
  (`role=listbox aria-label="Select a directory"`, rows `aria-label="name, path"`, last row "Browse..." =
  native dialog, not offered). In a running session both are disabled. Picking a folder is a WORKSPACE
  SWITCH: the chip reads "Switching workspace..." and the window reloads the folder for a few seconds (same
  CDP target id). `chat.workdir = {name, extra, env, editable}`; messages `workdir` / `workdirs`,
  `workdirPick {name,path}`, `envPick {label}`. Never "test-click" a folder row on a live window.
- Devin permission mode: the prompt toolbar chip (`button[aria-haspopup=menu]` reading Code / Smart / Ask /
  Plan / Bypass Permissions) feeds `chat.mode` and `CONTROLS.mode`; its menu opens ONLY for real mouse
  events (`clickControl` returns false for it so `pressControl` taps), rows are `role=menuitem` with a
  description and a second trailing svg on the current one (`devinModeRows`). The phone confirms before
  switching to Bypass Permissions.
- Surfaces (Devin): `button.switch-segment.{agent,editor}-segment` in the
  titlebar; `devinSurface()` reads the visible `.active` one and is sent as
  `chat.surface`. Agent: sessions are the sidebar `li[data-slot]` list and New
  is `[aria-label="New session"]`. Editor: no session list in the panel; the
  titlebar "Search agents" quick pick (`.quick-input-widget`) lists sessions and
  is closed with Escape; New has no visible control, so `devinNewChat()` switches
  to Agent first and stays there. Switching resets `devinHist` like openAgent.
  Probing a surface flips the window: always flip back.
- Revert (Devin): `revert` clicks the hover-only button on a user row, then
  waits for a `[role=dialog]`; the phone answers `revertOk`/`revertCancel`.
  Unverified on the live window (dialog markup not seen).
- File viewer: `openFile` may add `hl` (shiki tokens + theme colours from
  theme.mjs/highlight.mjs) and `marks`/`markSource` (marks.mjs: git diff first,
  Devin transcript edits as fallback — agent fallback only when `app === 'devin'`).
  The phone tells the relay its light/dark via `{t:'appTheme'}` for the theme
  fallback; client sanitizes every payload colour with a hex regex before using
  it in a style.

## Read-only live probing

- Devin: `http://127.0.0.1:9223/json` → `webSocketDebuggerUrl`, `Runtime.evaluate`.
- Cursor: `http://127.0.0.1:9222`. Read-only only — never click or mutate windows.

## Verify

```sh
node --check server.mjs
# Extract each inline <script> from app/index.html as UTF-8, then node --check it.
```

PowerShell redirection (`>`) corrupts binary and non-ASCII output — write files
with Node (`fs.writeFileSync`) instead. Bump `app/sw.js` CACHE on app changes.
