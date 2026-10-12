# Remote Agent

Control Cursor and Devin on your computer from your phone: chat, switch agents and models, read the terminal, and approve steps. Free and self-hosted. Your phone only needs a web browser.

<p>
< img src="docs/phone.png" alt="A new phone chat asking which model this is" width="280">
< img src="docs/terminal.png" alt="The phone terminal" width="280">
</p >

Chinese version: [README.md](README.md). Reference repository: [cursor-remote-lite](https://github.com/Suchenl/cursor-remote-lite).

## How it works

```
Phone browser  <--internet-->  Cloudflare tunnel  <-->  relay (this repo, port 3939)  <-->  Cursor (debug port 9222)
                                                                                      <-->  Devin  (debug port 9223)
```

The relay runs on the computer where Cursor/Devin are open. It talks to them through their Chrome debug ports and serves a web app to your phone. A free Cloudflare tunnel gives the relay a public address, so the phone works from anywhere (home Wi-Fi, mobile data). Phones log in by one-time pairing, with no password.

## Before you start

You need:

| What | Why | Check |
|---|---|---|
| A computer that stays on, with Cursor and/or Devin installed | The relay controls the apps on it | |
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
git clone https://github.com/<your-account>/remote-agent.git
cd remote-agent
npm install
```

Use the address of wherever you got this repo. No Git? Download the ZIP, unpack it, and open a terminal in that folder.

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

## Step 3. Start Cursor and/or Devin with a debug port

The relay can only see an app that was started with a debug port. Quit the app first if it is already open. You can use one app or both.

**Cursor (port 9222)**

- macOS: `./start-cursor.sh` (quits Cursor, then reopens it with the port)
- Windows (PowerShell): `& "$env:LOCALAPPDATA\Programs\cursor\Cursor.exe" --remote-debugging-port=9222`
- Linux: `cursor --remote-debugging-port=9222`

**Devin (port 9223)**

- Linux: `./start-devin.sh`
- macOS / Windows: start the Devin Desktop executable with `--remote-debugging-port=9223`. On macOS you can also set `DEVIN_BIN` to the executable path and run `./start-devin.sh`.

Check that it worked by opening `http://127.0.0.1:9222/json/version` (Cursor) or `http://127.0.0.1:9223/json/version` (Devin) in the computer's browser. A page of JSON means the port is open. The install path may differ on your machine, so adjust it if the app is not found.

## Step 4. (Optional) Run the setup wizard

```bash
npm run setup
```

It checks for `cloudflared` and `gh` and offers to publish a fixed phone-app address on your own GitHub Pages, install a start-at-login service (macOS only), and enable 2FA. Skip it if you just want to try things out. The wizard is written in Chinese. If your GitHub account has a custom domain on its user site, project sites are served from that domain; the app records the real address as `appUrl` in `~/.agent-remote/config.json` automatically (you can also set it there by hand).

## Step 5. Start the relay

- From anywhere (public tunnel): `npm run public`
- Same Wi-Fi only: `npm run start`

Leave this terminal open. It prints the address (`公网地址` for the public URL, `局域网地址` for the LAN URL) and which windows it connected to. If it says it cannot connect, go back to Step 3.

## Step 6. Pair your phone

In a second terminal in the same folder:

```bash
npm run pair
```

It prints a QR code and a one-time link, valid for a few minutes and for one phone. Scan the QR code with your phone camera, or send the link to the phone and open it in its browser. After pairing, the phone is remembered.

- iPhone: use Safari. Tap Share, then "Add to Home Screen" to get an app icon.
- Android: use Chrome, then menu, then "Install app" or "Add to Home screen". There is also an Android wrapper app in `android/` that can scan the QR code directly.
- Any other device with a browser also works.

## Step 7. Use it

Open the app on your phone.

- Read agent chats, press Enter to send and Shift+Enter for a new line.
- Switch Agent and model. Cursor and Devin both keep past chats in their sidebar, so use "Agent" on the phone instead of a History button.
- Read the terminal, and create, switch, close terminals and run commands.
- Check context usage and quota. Tap the quota bar to refresh.
- Math renders as formulas. Code blocks have a Copy button, and long inline commands copy when tapped.
- Attach images from the phone.
- Switch between Cursor and Devin in the window list.

## Day to day

Each time you want to use it:

1. Start Cursor/Devin with their debug ports (Step 3).
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
| `npm run devices remove <id>` | Remove a device (it disconnects immediately) |
| `npm run 2fa` | Optional Authenticator two-step verification |
| `npm run reset` | Forget all pairings and turn 2FA off |
| `./start-cursor.sh` | macOS: restart Cursor with port 9222 |
| `./start-devin.sh` | Linux: start Devin with port 9223 |
| `./service.sh install` | macOS: run the relay at login and restart if it crashes |

Pairing data is stored in `~/.agent-remote/` (an older `~/.cursor-remote-lite/` is renamed on the next start).

## Troubleshooting

- **Relay shows no windows / "cannot connect"**: Cursor or Devin was not started with the debug port. Quit it and redo Step 3.
- **`npm` is not recognized**: install Node.js 22 or newer (see Step 1), then close and reopen the terminal so PATH refreshes.
- **`cloudflared` not found**: finish Step 2 and open a new terminal so it is on PATH.
- **Pairing link expired**: run `npm run pair` again. A new link cancels the old one.
- **Fixed address does not load / is refused**: if your GitHub user site uses a custom domain, the project page lives under that domain. The wizard and the relay record it as `appUrl` in `~/.agent-remote/config.json`; set it there yourself if needed.
- **Phone cannot open the address**: the public address can take a short while to become reachable. With `npm run start`, the phone must be on the same Wi-Fi as the computer, and the firewall must allow port 3939.
- **Lost or stolen phone**: `npm run devices`, then `npm run devices remove <id>`. To drop everything, `npm run reset`.
- **Port 3939 already in use**: run with a different port, for example `PORT=4000 npm run public` (PowerShell: `$env:PORT=4000; npm run public`).
- **Debug ports on other numbers**: set `CDP_URL` (Cursor) or `DEVIN_CDP_URL` (Devin) when starting the relay.
