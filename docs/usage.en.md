# Feature guide

[README](../README.en.md) · [中文](usage.md)

## Chat, projects and sessions

Switch Cursor, Devin, Codex or Fusion from the header. **Projects / sessions** in the composer groups conversations by project and provides folder selection, project creation and new sessions. Switching projects preserves existing windows and native conversation working directories. Codex reuses an already-open window for that project, or opens one when needed. New windows may require desktop sign-in or workspace trust confirmation.

Models, reasoning effort and other parameters come from each Agent's native menus. Usage shows remaining quota; context shows the used proportion. Native pricing is shown only where available, without estimating a task's total cost. Queue, append and parameter support vary by Agent.

Enter sends; Shift+Enter or the on-screen ↵ inserts a newline. On-screen ↑↓ recalls input history. Physical keyboards use Alt/Option＋↑↓; plain arrows remain available for caret movement and IME. Queued messages can be edited.

## Questions, approvals and execution records

Codex Question presets can be clicked to submit directly. Custom answers can be sent from the card or the main composer; with a Question pending, composer text answers that question. Terminal command approval keeps its own approve/reject actions.

**… → Show execution commands** is saved per Agent. When off, completed execution and tool read/search records are hidden after the turn ends. Thinking, work explanations, results, failures and pending approvals remain visible. History is not deleted.

## Attachments and project files

Attach phone images and documents. Images can be edited, cropped and annotated before upload; sent images appear as thumbnails below message text and open at full size when tapped. Historical image availability depends on retained local records and accessible source files.

Codex `@` searches its native file index. **＋ → Add computer files** browses computer directories and adds selected file references; it is separate from phone uploads. Reference lists scroll independently and stay open when the keyboard is dismissed. Editor browses and edits project files. File previews include syntax highlighting; change summaries link to file lists and diffs. MP4 previews use range requests.

## Terminal

Open the terminal from the header to view output. Its toolbar selects or creates terminals, sends Ctrl+C / Tab, selects all and copies output. Copy uses the selection when present, otherwise currently loaded output. The send action is labeled for the terminal. The composer also accepts input for interactive programs such as sudo; password echo is controlled by the terminal program.

## File transfer

Open **… → File transfer** to browse directories accessible to the computer's OS user, beyond the current project.

- **Download to phone**: select across directories, select the current page or clear selection. A single file downloads directly; multiple files and folders use streaming ZIP archives, preserving subdirectories and empty directories without following internal symlinks. The browser controls destination, download progress and cancellation.
- **Upload to computer**: choose a computer destination, add phone files or folders, then upload the batch. Includes progress, cancellation, failed-item retry and rename/skip/overwrite choices. Subdirectories are created automatically. Folder selection depends on the phone browser; empty directories omitted by the browser cannot be preserved.
- Download browsing and upload destination are saved independently. Hidden files are off by default; this filters the list without excluding hidden contents from selected folder archives.
- The parent button stays to the left of the sticky path bar. The file list scrolls independently. Up to two uploads run concurrently; the same full destination path is handled in order. Network, disk and tunnel limits still apply.

## Plot and simulation windows

**… → Screen** provides read-only viewing of plot and simulation windows such as Matplotlib, Isaac Sim and MuJoCo. Select a window, zoom or refresh; it does not send mouse or keyboard input and does not show the entire desktop or Agent editor.

| Capture path | Requirements |
|---|---|
| Windows | A recent FFmpeg with `gdigrab hwnd=` support on PATH; capture uses the window handle |
| Linux X11 | FFmpeg, `xprop`, system Python 3; the window must remain open and visible |
| Linux Wayland | Desktop portal selection and approval; Python PyGObject, GStreamer and PipeWire plugins |

Ubuntu/Debian Wayland dependencies:

```bash
sudo apt install python3-gi gir1.2-gstreamer-1.0 gstreamer1.0-pipewire gstreamer1.0-plugins-good gstreamer1.0-plugins-base
```

Where supported, restore credentials are saved in `~/.agent-remote/visual.json`. A closed window, revoked permission or failed restoration requires sharing again. A tunnel reconnect does not change this record. macOS capture is not included in these implemented capture paths. Browser simulation does not imply every platform has been verified on a real device.

## Fusion collaboration

Fusion is a separate orchestrator, distinct from Devin's native Fusion model mode. Choose a project and the Agent, session and model for sides A and B. A plans and reviews; B executes. Confirm the plan before execution, review and any corrections. Each Agent keeps its native permission and operation semantics.

## Notifications, appearance and mobile apps

Choose dark, light or system appearance and Chinese or English. Install the PWA on your home screen, or use the Android / iOS shells in this repository. Notifications require supported browsers, OS permission and the relevant push-service setup. iOS Live Activities also require a native build containing the extension; web publication does not install native capabilities.
