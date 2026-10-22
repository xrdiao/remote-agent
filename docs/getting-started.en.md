# Installation, startup and pairing

[README](../README.en.md) · [中文](getting-started.md)

## Before you start

You need:

| What | Why | Check |
|---|---|---|
| A computer that stays on, with Cursor, Devin or Codex installed | The relay controls the apps on it | |
| Node.js 22 or newer | Runs the relay | `node -v` |
| Git (or download the repo as a ZIP) | Gets this code | `git --version` |
| `cloudflared` | Public tunnel. Optional if the phone is on the same Wi-Fi | `cloudflared --version` |
| A phone with any modern browser | The remote control | |

Commands below are for a terminal: Terminal on macOS, any shell on Linux, PowerShell on Windows. The `.sh` helper scripts need bash. On Windows use Git Bash or WSL for them, or use the manual commands shown.

> The relay controls the real apps on your computer, including the terminal. Only pair phones you own, and keep the pairing link private.

## Step 1. Get the code and install

npm comes with Node.js. If `node -v` fails or `npm` is "not recognized" (common on a fresh Windows PC), install Node.js 22 or newer (LTS) first:

- Windows: `winget install OpenJS.NodeJS.LTS`, or the installer from https://nodejs.org
- macOS: `brew install node`
- Linux: your distro's package manager, or https://nodejs.org

Then close and reopen the terminal so PATH refreshes, and verify with `node -v` and `npm -v`.

```bash
git clone https://github.com/xrdiao/remote-agent.git
cd remote-agent
npm install
```

Replace the repository URL if you use your own fork. No Git? Download the ZIP, unpack it, and open a terminal in that folder.

## Step 2. Install cloudflared (for access from outside your home)

Skip this step if your phone will always be on the same Wi-Fi as the computer, and use `npm run start` in Step 5.

- macOS: `brew install cloudflared`
- Windows: `winget install --id Cloudflare.cloudflared`
- Linux (no root needed):
  ```bash
  mkdir -p ~/.local/bin
  curl -L --fail -o ~/.local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x ~/.local/bin/cloudflared
  ```
  Use the `arm64` file on ARM machines.

Other systems: [Cloudflare downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).

## Ubuntu quick start

After installing dependencies, run these from the repository:

```bash
./ubuntu_start/start-agents.sh
./ubuntu_start/pair.sh
```

The first script launches installed Cursor, Devin and VS Code (Codex) concurrently, reusing active debug ports. Quit an existing app first if it was started without a debug port. Set `CURSOR_BIN`, `DEVIN_BIN` or `CODE_BIN` for custom executable paths.

The second script checks local configuration and then the signed-in GitHub user's existing Remote Agent Pages sites. It reuses an existing entry and asks about creating a personal one only when none is found. It requires `gh` (`sudo apt install gh`) and `cloudflared`; GitHub login may be needed initially. It starts or reuses background relay/tunnel processes, publishes this computer's address, and prints a pairing QR code, link and manual code. Closing the launcher terminal leaves the services running.

Each person uses their own account's fixed entry. After a computer reboot, rerun both scripts and open the same phone entry without pairing again. Keep `~/.agent-remote/`. A new computer can reuse the entry but needs its own initial pairing. Restart an already-running relay after configuring its fixed entry for the first time. Initial GitHub Pages publication may take a few minutes.

The pairing launcher first shows the locally configured entry, then lets you choose a fixed entry or a temporary tunnel entry. Temporary mode needs no GitHub login, creates no repository and leaves the saved fixed-entry configuration unchanged. Its URL changes when the tunnel address changes.

Windows: double-click `window_start/pair.exe` or run `window_start/pair.cmd`. It checks and reuses your personal fixed entry before asking to create one, then starts the relay/tunnel, displays a pairing QR code and copies the link to the clipboard. Install GitHub CLI and sign in to your own account first.

## Step 3. Start Cursor, Devin or Codex with a debug port

The relay can only see an app that was started with a debug port. Quit the app first if it is already open. Start only the Agent(s) you want to use.

**Cursor (port 9222)**

- macOS: `./scripts/start-cursor.sh` (quits Cursor, then reopens it with the port)
- Windows (PowerShell): `& "$env:LOCALAPPDATA\Programs\cursor\Cursor.exe" --remote-debugging-port=9222`
- Linux: `cursor --remote-debugging-port=9222`

**Devin (port 9223)**

- Linux: `./scripts/start-devin.sh`
- macOS / Windows: start the Devin Desktop executable with `--remote-debugging-port=9223`. On macOS you can also set `DEVIN_BIN` to the executable path and run `./scripts/start-devin.sh`.

**Codex (VS Code extension, port 9224)**

- Linux / macOS: `./scripts/start-codex.sh`.
- Windows (PowerShell): `code --remote-debugging-port=9224`; the VS Code `code` command must be on PATH.
- Install and sign in to the Codex extension, open your project and its Codex sidebar. Complete any sign-in or workspace trust prompt on the computer.

Check that it worked by opening `http://127.0.0.1:9222/json/version` (Cursor) or `http://127.0.0.1:9223/json/version` (Devin), or `http://127.0.0.1:9224/json/version` (Codex) in the computer's browser. A page of JSON means the port is open. The install path may differ on your machine, so adjust it if the app is not found.

## Step 4. (Optional) Run the setup wizard

```bash
npm run setup
```

It checks for `cloudflared` and `gh` and offers to publish a fixed phone-app address on your own GitHub Pages, install a start-at-login service (macOS only), and enable 2FA. Skip it if you just want to try things out. The wizard is written in Chinese. If your GitHub account has a custom domain on its user site, project sites are served from that domain; the app records the real address as `appUrl` in `~/.agent-remote/config.json` automatically (you can also set it there by hand).

## Step 5. Start the relay

- From anywhere (public tunnel): `npm run public`
- Same Wi-Fi only: `npm run start`

Leave this terminal open. It prints the address (`公网地址` for the public URL, `局域网地址` for the LAN URL) and which windows it connected to. If it says it cannot connect, go back to Step 3.

For LAN pairing, use `npm run pair -- --lan`. Plain HTTP does not provide web microphone access, camera scanning, Web Push or offline caching; use HTTPS for those capabilities.

## Step 6. Pair your phone

In a second terminal in the same folder:

```bash
npm run pair
```

It prints a QR code and a one-time link, valid for a few minutes and for one phone. Scan the QR code with your phone camera, or send the link to the phone and open it in its browser. After pairing, the phone is remembered.

You can also enter the full manual code (`computer-code.one-time-pairing-code`) at your own fixed entry. Pairing codes expire in 10 minutes and authorize one new entry; Authenticator verification is still required when enabled. The web pairing page can scan with a camera over HTTPS or decode a QR image from the photo library locally without uploading it.

Keep using the same fixed entry after pairing. When the tunnel address changes, the entry discovers the new address and reauthenticates with saved credentials. A device code identifies an entry; it cannot be used to sign in. An offline computer or unpublished address is retried, rather than requiring a new pairing.

- iPhone: use Safari. Tap Share, then "Add to Home Screen" to get an app icon.
- Android: use Chrome, then menu, then "Install app" or "Add to Home screen". There is also an Android wrapper app in `android/` that can scan the QR code directly.
- Any other device with a browser also works.

## Day to day

Each time you want to use it:

1. Start the required Agent(s) with their debug ports (Step 3).
2. Run `npm run public` (Step 5).
3. Open the app on the already-paired phone. No re-pairing is needed.

The tunnel runs in the background and keeps its address when you restart `npm run public`. The address only changes if the computer reboots or you kill the tunnel process.

To fully turn off public access, run `kill <tunnel pid>`. The relay prints the PID. On Windows, end the `cloudflared` process in Task Manager.

## Commands

| Command | What it does |
|---|---|
| `npm run setup` | First-run wizard |
| `npm run public` | Start the relay with a public tunnel |
| `npm run start` | Start the relay for local/LAN use only |
| `npm run pair` | Print a one-time pairing link and QR code |
| `npm run devices` | List paired devices |
| `npm run devices -- remove <id>` | Remove a device (it disconnects immediately) |
| `npm run 2fa` | Optional Authenticator two-step verification |
| `npm run reset` | Forget all pairings and turn 2FA off |
| `./scripts/start-cursor.sh` | macOS: restart Cursor with port 9222 |
| `./scripts/start-codex.sh` | Linux/macOS: start VS Code with port 9224 (Codex) |
| `./scripts/start-devin.sh` | Linux: start Devin with port 9223 |
| `./scripts/service.sh install` | macOS: run the relay at login and restart if it crashes |

Pairing data is stored in `~/.agent-remote/`.

## Troubleshooting

- **Relay shows no windows / "cannot connect"**: The target Agent was not started with the debug port, or the Codex sidebar is not ready. Check the application and redo Step 3 as needed.
- **`npm` is not recognized**: install Node.js 22 or newer (see Step 1), then close and reopen the terminal so PATH refreshes.
- **`cloudflared` not found**: finish Step 2 and open a new terminal so it is on PATH.
- **Pairing link expired**: run `npm run pair` again. A new link cancels the old one.
- **Fixed address does not load / is refused**: if your GitHub user site uses a custom domain, the project page lives under that domain. The wizard and the relay record it as `appUrl` in `~/.agent-remote/config.json`; set it there yourself if needed.
- **Devin on Windows — setup, updates and troubleshooting**: see [Windows Devin maintenance](windows-devin-maintenance.md).
- **Phone cannot open the address**: the public address can take a short while to become reachable. With `npm run start`, the phone must be on the same Wi-Fi as the computer, and the firewall must allow port 3939.
- **Lost or stolen phone**: `npm run devices`, then `npm run devices -- remove <id>`. To drop everything, `npm run reset`.
- **Port 3939 already in use**: run with a different port, for example `PORT=4000 npm run public` (PowerShell: `$env:PORT=4000; npm run public`).
- **Debug ports on other numbers**: set `CDP_URL` (Cursor), `DEVIN_CDP_URL` (Devin) or `CODEX_CDP_URL` (Codex) when starting the relay.
