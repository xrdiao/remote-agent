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
