# Remote Agent

用手机控制这台电脑上的 Cursor 和 Devin：对话、切换 Agent 和模型、看终端、批准确认。免费、自托管，手机只需要一个浏览器。

<p>
< img src="docs/phone.png" alt="手机上新建一条对话并询问你是什么模型" width="280">
< img src="docs/terminal.png" alt="手机上的终端" width="280">
</p >

英文版本：[README.en.md](README.en.md)。参考仓库：[cursor-remote-lite](https://github.com/Suchenl/cursor-remote-lite)。

## 工作原理

```
手机浏览器  <--互联网-->  Cloudflare 隧道  <-->  中继（本仓库，端口 3939）  <-->  Cursor（调试端口 9222）
                                                                            <-->  Devin （调试端口 9223）
```

中继运行在开着 Cursor/Devin 的电脑上，通过它们的 Chrome 调试端口与应用通信，并向手机提供一个网页应用。免费的 Cloudflare 隧道给中继一个公网地址，手机在任何地方都能用（家里 Wi-Fi、移动数据）。手机通过一次性配对登录，无需密码。

## 开始前

你需要：

| 需要什么 | 为什么 | 检查命令 |
|---|---|---|
| 一台保持开机的电脑，装有 Cursor 和/或 Devin | 中继控制它上面的应用 | |
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
git clone https://github.com/<your-account>/remote-agent.git
cd remote-agent
npm install
```

用你实际获取本仓库的地址。没有 Git？下载 ZIP 解压后，在该文件夹打开终端即可。

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

## 第 3 步：以调试端口启动 Cursor 和/或 Devin

中继只能看到以调试端口启动的应用。如果应用已经开着，先退出再启动。可以只用一个，也可以两个都用。

**Cursor（端口 9222）**

- macOS：`./scripts/start-cursor.sh`（会先退出 Cursor，再带端口重新打开）
- Windows（PowerShell）：`& "$env:LOCALAPPDATA\Programs\cursor\Cursor.exe" --remote-debugging-port=9222`
- Linux：`cursor --remote-debugging-port=9222`

**Devin（端口 9223）**

- Linux：`./scripts/start-devin.sh`
- macOS / Windows：用 `--remote-debugging-port=9223` 启动 Devin Desktop 可执行文件。macOS 上也可以把 `DEVIN_BIN` 设为可执行文件路径，再运行 `./scripts/start-devin.sh`。

在电脑浏览器打开 `http://127.0.0.1:9222/json/version`（Cursor）或 `http://127.0.0.1:9223/json/version`（Devin）验证是否成功，看到一页 JSON 即表示端口已开。安装路径在你机器上可能不同，找不到应用时请相应调整。

## 第 4 步：（可选）运行设置向导

```bash
npm run setup
```

它会检查 `cloudflared` 和 `gh`，并可选择：在你自己的 GitHub Pages 上发布一个固定的手机端地址、安装开机自启服务（仅 macOS）、开启两步验证。只想先试试可以跳过。向导界面为中文。如果你的 GitHub 用户站点绑了自定义域名，项目页面会从该域名提供；App 会自动把真实地址记入 `~/.agent-remote/config.json` 的 `appUrl`（也可以手动填）。

## 第 5 步：启动中继

- 任何地方都能访问（公网隧道）：`npm run public`
- 仅同一 Wi-Fi：`npm run start`

保持这个终端开着。它会打印地址（`公网地址` 为公网 URL，`局域网地址` 为局域网 URL）以及连接到了哪些窗口。如果提示连不上，回到第 3 步。

## 第 6 步：配对手机

在同一文件夹再开一个终端：

```bash
npm run pair
```

它会打印一个二维码和一条一次性链接，几分钟内有效，且只对一部手机有效。用手机相机扫码，或把链接发到手机上用浏览器打开。配对后手机会被记住。

也可以手动配对：打开命令输出的固定网页入口，在配对输入框中输入完整的“手动配对码”（`电脑码.一次性配对码`），点“配对”。配对码 10 分钟内有效，只能授权一台新设备；固定入口的地址记录发布后约 1 分钟生效。已开启 Authenticator 时仍需输入二次验证码。

配对成功后始终使用这个固定入口。隧道重启只更新连接地址，手机会用原来的私密令牌重新验证并恢复原会话，不必再次扫码。设备码可在“已配对设备”中查看，仅用于识别；不能用设备码登录。电脑离线或地址尚未更新时会自动重试；只有明确提示“设备授权已失效或被移除”时，才需要重新授权。

- iPhone：用 Safari，点「分享」，然后「添加到主屏幕」获得应用图标。
- Android：用 Chrome，菜单里选「安装应用」或「添加到主屏幕」。`android/` 目录里还有一个可以直接扫码配对的安卓壳应用。
- 其他任何带浏览器的设备也可以用。

## 第 7 步：使用

在手机上打开应用。

- 看 Agent 对话，回车发送，Shift+回车换行。
- 切换 Agent 和模型。Cursor 和 Devin 都把历史聊天放在左侧列表里，所以手机上用「Agent」切换，而不是「历史」按钮。
- 看终端，新建、切换、关闭终端并执行命令。
- 看上下文占用和额度，点额度条可刷新。
- 数学公式按公式渲染。代码块有「复制」按钮，较长的行内命令点一下也会复制。
- 从手机附加图片。
- 在窗口列表里切换 Cursor 和 Devin。

## 日常使用

每次要用时：

1. 以调试端口启动 Cursor/Devin（第 3 步）。
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
| `npm run pair` | 生成一次性配对链接和二维码 |
| `npm run devices` | 查看已配对设备 |
| `npm run devices remove <id>` | 移除设备（立即断开） |
| `npm run 2fa` | 可选的 Authenticator 二次验证 |
| `npm run reset` | 清除所有配对并关闭两步验证 |
| `./scripts/start-cursor.sh` | macOS：以端口 9222 重启 Cursor |
| `./scripts/start-codex.sh` | Linux/macOS：以端口 9224 启动 VS Code（Codex） |
| `./scripts/start-devin.sh` | Linux：以端口 9223 启动 Devin |
| `./scripts/service.sh install` | macOS：登录时运行中继，崩溃自动重启 |

配对数据保存在 `~/.agent-remote/`。

## 故障排查

- **中继显示没有窗口 /「无法连接」**：Cursor 或 Devin 没有以调试端口启动。退出后重做第 3 步。
- **提示 `npm` 不是命令**：安装 Node.js 22 或更高版本（见第 1 步），然后关闭并重开终端让 PATH 生效。
- **找不到 `cloudflared`**：完成第 2 步，并重开一个终端让它进入 PATH。
- **配对链接过期**：重新运行 `npm run pair`，新链接会使旧链接失效。
- **固定地址打不开/被拒绝**：如果 GitHub 用户站点用了自定义域名，项目页面就在该域名下。向导和中继会把它记入 `~/.agent-remote/config.json` 的 `appUrl`，需要时也可手动设置。
- **Windows 上 Devin 的接入、更新与排查**：见 [docs/windows-devin-maintenance.md](docs/windows-devin-maintenance.md)。
- **手机打不开地址**：公网地址可能需要稍等片刻才可访问。用 `npm run start` 时，手机必须与电脑在同一 Wi-Fi，且防火墙要放行 3939 端口。
- **手机丢失或被盗**：`npm run devices`，然后 `npm run devices remove <id>`。要全部清空，用 `npm run reset`。
- **3939 端口被占用**：换端口运行，例如 `PORT=4000 npm run public`（PowerShell：`$env:PORT=4000; npm run public`）。
- **调试端口不是默认端口号**：启动中继时设置 `CDP_URL`（Cursor）或 `DEVIN_CDP_URL`（Devin）。
