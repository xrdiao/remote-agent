# Remote Agent

Control Cursor, Devin, and Codex in VS Code on this computer from a phone: chat, switch agents and models, read the terminal, and approve steps.

<p>
<img src="docs/phone.png" alt="A new phone chat asking which model this is" width="280">
<img src="docs/terminal.png" alt="The phone terminal" width="280">
</p>

Reference repository: [https://github.com/Suchenl/cursor-remote-lite](https://github.com/Suchenl/cursor-remote-lite)

The Chinese notes in [README.md](README.md) describe how this machine is started.

- Cursor uses debug port 9222.
- Devin is started with `./start-devin.sh` on port 9223.
- Codex is the VS Code sidebar, started with `./start-codex.sh` on port 9224. The phone window list has one Codex entry. Each VS Code window is an agent, named by its folder.
- Codex permissions sit beside the model: ask each time, approve for me, or full access. They are not a banner over the chat. Cursor and Devin do not expose that control.
- View and edit files with copy, paste, indentation and search. Use Ctrl/⌘+S to save, Ctrl/⌘+F to find, and Tab/Shift+Tab to indent or outdent.
- Codex usage refreshes every minute while the app is visible and when returning to the foreground; tap a usage meter to refresh immediately.
- One phone can pair several computers. Use the pair link printed on the computer you are adding. Computers already paired stay.

The old History button opened past chats for the current Agent. Cursor Agents and Devin keep those chats in the sidebar, so the phone uses the Agent list instead.

Devin supports thought bodies, rich tool output, task lists, formatted replies, session and Agent/Editor switching, question answers, queue actions, file review, native @ mentions, working directories and permission modes. Sessions are keyed by native IDs.

Attachments can be removed before sending. Document uploads show progress and support PDF, Office, text and code files up to 20 MB; parsing depends on the selected agent. File viewing uses the desktop theme and marks changes against Git HEAD, while preserving search and editing controls. Files above 200 KB or 5000 lines remain plain text.

The Android app adds QR pairing, notification replies/actions, network reconnection and local history search. These require a rebuilt APK (Java 17, Android SDK 34; `cd android && ./gradlew assembleDebug`). Windows drive paths are supported, but tunnel reuse still depends on Unix `ps`; Windows restarts may create a new tunnel and require device verification.

Codex’s **＋** button to the left of the prompt opens Plan, skill search, file references, commands, IDE context, execution location, and chat actions. Skills are inserted as native references.
