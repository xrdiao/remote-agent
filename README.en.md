# Remote Agent

Control Cursor and Devin on this computer from a phone: chat, switch agents and models, read the terminal, and approve steps.

Reference repository: [https://github.com/Suchenl/cursor-remote-lite](https://github.com/Suchenl/cursor-remote-lite)

The Chinese notes in [README.md](README.md) describe how this machine is started. Cursor uses debug port 9222. Devin is started separately with `./start-devin.sh` on port 9223, and the phone switches between them in the window list.

The old History button opened past chats for the current Agent. Cursor Agents and Devin keep those chats in the sidebar, so the phone uses the Agent list instead.
