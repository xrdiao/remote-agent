# 安装、启动与配对

[返回 README](../README.md) · [English](getting-started.en.md)

## 开始前

你需要：

| 需要什么 | 为什么 | 检查命令 |
|---|---|---|
| 一台保持开机的电脑，装有 Cursor、Devin 或 Codex | 中继控制它上面的应用 | |
| Node.js 22 或更高版本 | 运行中继 | `node -v` |
| Git（或直接下载仓库 ZIP） | 获取本代码 | `git --version` |
| `cloudflared` | 公网隧道。手机与电脑同一 Wi-Fi 时可选 | `cloudflared --version` |
| 一部装有现代浏览器的手机 | 遥控器 | |

以下命令在终端中执行：macOS 用 Terminal，Linux 用任意 shell，Windows 用 PowerShell。`.sh` 辅助脚本需要 bash，Windows 上请用 Git Bash 或 WSL 运行，或改用文中给出的手动命令。

> 中继控制的是电脑上真实的应用，包括终端。只配对你自己的手机，并保管好配对链接。

## 第 1 步：获取代码并安装

npm 随 Node.js 一起安装。如果 `node -v` 失败或提示 `npm`「不是内部或外部命令」（新装的 Windows 上很常见），先安装 Node.js 22 或更高版本（LTS）：

- Windows：`winget install OpenJS.NodeJS.LTS`，或使用 https://nodejs.org 的安装包
- macOS：`brew install node`
- Linux：用发行版的包管理器，或 https://nodejs.org

然后关闭并重开终端让 PATH 生效，用 `node -v` 和 `npm -v` 验证。

```bash
git clone https://github.com/xrdiao/remote-agent.git
cd remote-agent
npm install
```

使用自己的 fork 时替换仓库地址。没有 Git？下载 ZIP 解压后，在该文件夹打开终端即可。

## 第 2 步：安装 cloudflared（用于从外面访问）

如果手机始终和电脑在同一 Wi-Fi，可跳过本步，并在第 5 步使用 `npm run start`。

- macOS：`brew install cloudflared`
- Windows：`winget install --id Cloudflare.cloudflared`
- Linux（无需 root）：
  ```bash
  mkdir -p ~/.local/bin
  curl -L --fail -o ~/.local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x ~/.local/bin/cloudflared
  ```
  ARM 机器请改用 `arm64` 文件。

其他系统见 [Cloudflare 下载页](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)。

## Ubuntu 快捷启动

安装依赖后，在仓库目录依次运行：

```bash
./ubuntu_start/start-agents.sh
./ubuntu_start/pair.sh
```

第一个脚本并行启动已安装的 Cursor、Devin 和 VS Code（Codex），复用已开启的调试端口；已经运行但没有调试端口的应用需要先自行退出。可用 `CURSOR_BIN`、`DEVIN_BIN`、`CODE_BIN` 指定安装路径。

第二个脚本先检查本机配置，再查找当前 GitHub 用户已有的 Remote Agent Pages 入口；找到就复用，没有才询问是否创建个人入口。需要 `gh`（`sudo apt install gh`）和 `cloudflared`，首次使用可能需要登录自己的 GitHub。随后在后台启动或复用中继、隧道，发布当前电脑地址，并打印配对二维码、链接和手动配对码。关闭脚本终端不会关闭服务。

每个人使用自己账号下的固定入口。电脑重启后重新运行这两个脚本，手机从原入口连接，无需重新配对；请保留 `~/.agent-remote/`。换新电脑可以复用同一个入口，但需要为新电脑配对一次。如果为正在运行的中继首次设置了固定入口，请重启中继，使入口配置生效。GitHub Pages 首次发布可能需要几分钟。

配对脚本会先显示本机已有入口，再让你选择本次使用固定入口或临时隧道入口。选择临时入口无需 GitHub 登录，不创建仓库，也不修改已有固定入口配置；隧道地址变化后临时入口随之变化。

Windows：双击 `window_start/pair.exe` 或运行 `window_start/pair.cmd`，同样会先检查并复用个人固定入口，没有才询问创建；随后启动中继、隧道并显示配对二维码，链接自动复制到剪贴板。需要安装 GitHub CLI 并登录自己的账号。

## 第 3 步：以调试端口启动 Cursor、Devin 或 Codex

中继只能看到以调试端口启动的应用。如果应用已经开着，先退出再启动。只需启动你要使用的 Agent，无需全部启动。

**Cursor（端口 9222）**

- macOS：`./scripts/start-cursor.sh`（会先退出 Cursor，再带端口重新打开）
- Windows（PowerShell）：`& "$env:LOCALAPPDATA\Programs\cursor\Cursor.exe" --remote-debugging-port=9222`
- Linux：`cursor --remote-debugging-port=9222`

**Devin（端口 9223）**

- Linux：`./scripts/start-devin.sh`
- macOS / Windows：用 `--remote-debugging-port=9223` 启动 Devin Desktop 可执行文件。macOS 上也可以把 `DEVIN_BIN` 设为可执行文件路径，再运行 `./scripts/start-devin.sh`。

**Codex（VS Code 插件，端口 9224）**

- Linux / macOS：`./scripts/start-codex.sh`。
- Windows（PowerShell）：`code --remote-debugging-port=9224`；需要 VS Code 的 `code` 命令已加入 PATH。
- 在 VS Code 中安装并登录 Codex 插件，打开项目和 Codex 侧边栏。若窗口停在登录或项目受限页面，请在电脑端完成登录或确认信任。

在电脑浏览器打开 `http://127.0.0.1:9222/json/version`（Cursor）或 `http://127.0.0.1:9223/json/version`（Devin）、`http://127.0.0.1:9224/json/version`（Codex）验证是否成功，看到一页 JSON 即表示端口已开。安装路径在你机器上可能不同，找不到应用时请相应调整。

## 第 4 步：（可选）运行设置向导

```bash
npm run setup
```

它会检查 `cloudflared` 和 `gh`，并可选择：在你自己的 GitHub Pages 上发布一个固定的手机端地址、安装开机自启服务（仅 macOS）、开启两步验证。只想先试试可以跳过。向导界面为中文。如果你的 GitHub 用户站点绑了自定义域名，项目页面会从该域名提供；App 会自动把真实地址记入 `~/.agent-remote/config.json` 的 `appUrl`（也可以手动填）。

## 第 5 步：启动中继

- 任何地方都能访问（公网隧道）：`npm run public`
- 仅同一 Wi-Fi：`npm run start`

保持这个终端开着。它会打印地址（`公网地址` 为公网 URL，`局域网地址` 为局域网 URL）以及连接到了哪些窗口。如果提示连不上，回到第 3 步。

开了隧道时中继也监听局域网地址。新的网页密钥认证需要 HTTPS 安全上下文，请使用固定入口或 HTTPS 隧道；普通局域网 HTTP 页面不能创建网页认证密钥。电脑本机可使用 localhost 授权页面。

## 第 6 步：配对手机

在同一文件夹再开一个终端：

```bash
npm run pair
```

它会自动打开独立配对窗口，显示二维码、手动码和 3 分钟倒计时。电脑需安装 Chrome、Edge 或 Chromium，窗口使用独立的临时浏览器配置，不影响日常浏览器。配对码在期限内可供多个入口申请；核对手机和电脑显示的六位验证码，逐项点击“允许连接”，无需勾选或填写名称。当前设备的入口自动归组；配另一台设备前点“开始配对另一台设备”，不会延长倒计时。

关闭窗口、在这个配对终端按 Ctrl+C 或倒计时结束，会退出配对并使未批准申请失效；已批准入口保持授权，中继服务继续运行。这里的 Ctrl+C 指 `npm run pair` 的终端，不是运行中继服务的终端。

也可以手动配对：打开命令输出的固定网页入口，在配对输入框中输入完整的“手动配对码”（`电脑码.配对码`），点“连接”。配对码 3 分钟内有效，申请仍须在电脑端核对批准；固定入口的地址记录发布后约 1 分钟生效。已开启 Authenticator 时仍需输入二次验证码。

浏览器配对页也可点“扫码连接”，允许相机访问后扫描电脑端二维码；或点“从相册识别”选择二维码图片。图片在浏览器中识别，不会上传。相机扫码请使用 HTTPS 固定入口；返回或切到手动输入会关闭相机。安卓 App 保留原生扫码入口。

配对成功后始终使用这个固定入口。隧道重启只更新连接地址，手机会用原来的入口密钥及绑定令牌重新验证并恢复原会话，不必再次扫码。设备码可在“已配对设备”中查看，仅用于识别；不能用设备码登录。电脑离线或地址尚未更新时会自动重试；只有明确提示“设备授权已失效或被移除”时，才需要重新授权。

- iPhone：用 Safari，点「分享」，然后「添加到主屏幕」获得应用图标。
- Android：用 Chrome，菜单里选「安装应用」或「添加到主屏幕」。`android/` 目录里还有一个可以直接扫码配对的安卓壳应用。
- 其他任何带浏览器的设备也可以用。

## 日常启动与关闭

每次要用时：

1. 以调试端口启动所需 Agent（第 3 步）。
2. 运行 `npm run public`（第 5 步）。
3. 在已配对的手机上打开应用，无需重新配对。

隧道在后台运行，重启 `npm run public` 会沿用同一个地址。电脑重启或手动结束隧道进程后，地址可能变化；配置了固定网页入口时，服务会发布新地址，已授权手机自动重连。请保留 `~/.agent-remote/` 中的授权数据，并使用原来的操作系统用户启动服务。

要彻底关闭公网访问，运行 `kill <隧道进程号>`，中继会打印该 PID。Windows 上在任务管理器里结束 `cloudflared` 进程。

## 命令一览

| 命令 | 作用 |
|---|---|
| `npm run setup` | 首次运行向导 |
| `npm run public` | 启动中继并使用公网隧道 |
| `npm run start` | 只在本机/局域网启动中继 |
| `npm run pair` | 打开 3 分钟独立配对窗口，逐项批准入口 |
| `npm run devices` | 查看已配对设备 |
| `npm run devices -- remove <id>` | 移除设备（立即断开） |
| `npm run 2fa` | 可选的 Authenticator 二次验证 |
| `npm run reset` | 清除所有配对并关闭两步验证 |
| `./scripts/start-cursor.sh` | macOS：以端口 9222 重启 Cursor |
| `./scripts/start-codex.sh` | Linux/macOS：以端口 9224 启动 VS Code（Codex） |
| `./scripts/start-devin.sh` | Linux：以端口 9223 启动 Devin |
| `./scripts/service.sh install` | macOS：登录时运行中继，崩溃自动重启 |

配对数据保存在 `~/.agent-remote/`。

## 故障排查

- **中继显示没有窗口 /「无法连接」**：目标 Agent 没有以调试端口启动，或 Codex 侧边栏尚未就绪。退出后重做第 3 步。
- **提示 `npm` 不是命令**：安装 Node.js 22 或更高版本（见第 1 步），然后关闭并重开终端让 PATH 生效。
- **找不到 `cloudflared`**：完成第 2 步，并重开一个终端让它进入 PATH。
- **配对链接过期**：重新运行 `npm run pair`，新链接会使旧链接失效。
- **固定地址打不开/被拒绝**：如果 GitHub 用户站点用了自定义域名，项目页面就在该域名下。向导和中继会把它记入 `~/.agent-remote/config.json` 的 `appUrl`，需要时也可手动设置。
- **手机打不开地址**：公网地址可能需要稍等片刻才可访问。用 `npm run start` 时，手机必须与电脑在同一 Wi-Fi，且防火墙要放行 3939 端口。
- **手机丢失或被盗**：`npm run devices`，然后 `npm run devices -- remove <id>`。要全部清空，用 `npm run reset`。
- **3939 端口被占用**：换端口运行，例如 `PORT=4000 npm run public`（PowerShell：`$env:PORT=4000; npm run public`）。
- **调试端口不是默认端口号**：启动中继时设置 `CDP_URL`（Cursor）、`DEVIN_CDP_URL`（Devin）或 `CODEX_CDP_URL`（Codex）。
