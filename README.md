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

开了隧道时中继也监听局域网地址：同一 Wi-Fi 的电脑或手机浏览器直接打开 `局域网地址`（如 `http://192.168.2.130:3939/`）即可用，延迟接近零，手机仍走隧道。给局域网设备配对用 `npm run pair -- --lan`。纯 http 下没有推送通知和离线缓存，其余功能相同。

## 第 6 步：配对手机

在同一文件夹再开一个终端：

```bash
npm run pair
```

它会打印一个二维码和一条一次性链接，几分钟内有效，且只对一部手机有效。用手机相机扫码，或把链接发到手机上用浏览器打开。配对后手机会被记住。

也可以手动配对：打开命令输出的固定网页入口，在配对输入框中输入完整的“手动配对码”（`电脑码.一次性配对码`），点“连接”。配对码 10 分钟内有效，只能授权一台新设备；固定入口的地址记录发布后约 1 分钟生效。已开启 Authenticator 时仍需输入二次验证码。

浏览器配对页也可点“扫码连接”，允许相机访问后扫描电脑端二维码；或点“从相册识别”选择二维码图片。图片在浏览器中识别，不会上传。相机扫码请使用 HTTPS 固定入口；返回或切到手动输入会关闭相机。安卓 App 保留原生扫码入口。

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

## 本机流式语音输入（可选）

在运行中继的电脑上安装 Python 3.10 或以上，然后在本仓库目录执行：

```bash
npm run voice:setup
```

安装器会先询问同意，再创建 `~/.agent-remote/asr/` 独立环境，安装 CPU 版 sherpa-onnx 并下载约 615 MB 的 X-ASR 160ms 中英混说模型。Windows 使用 Python Launcher（`py -3`）；Linux 可能需要先安装 `python3-venv`。可用 `ASR_SETUP_PYTHON` 指定安装时的 Python 可执行文件。不需要 GPU，运行时无需连接第三方识别服务。

手机通过 HTTPS 打开应用，在「… → 语音输入」中开启开关，并从子列表选择已安装的语音识别引擎；只装一个就只显示一个，选择按电脑保存在当前浏览器。空闲时输入框右侧显示麦克风，**按住说话，松开结束**；第一次需允许浏览器使用麦克风，授权后重新按住即可。录音期间持续显示文字，中英文可混说；松开后补齐末尾文字，确认或编辑后自行发送。Agent 正在生成时，未使用输入框则显示停止按钮；开启语音后，展开输入键盘或正在输入时切成麦克风，输入结束保留约 2 秒缓冲，录音和转录收尾期间保持麦克风。关闭语音仍保留原停止按钮。

可选安装 Qwen3-ASR-1.7B，使用[官方 vLLM 流式接口](https://github.com/QwenLM/Qwen3-ASR/blob/main/examples/example_qwen3_asr_vllm_streaming.py)，目前安装入口需要 Linux 和可用 NVIDIA GPU：

```bash
npm run voice:setup -- --engine qwen
```

安装前另行询问同意，创建独立虚拟环境并下载约 4 GB 模型，运行依赖另计，不替换 Sherpa，不安装或更新系统显卡驱动和 CUDA。可加 `--dir /磁盘/语音目录` 指定环境和模型存放位置，安装完成后自动登记路径；重新打开语音子列表即可看到。Qwen 每约 1 秒音频进行一次增量识别，首次出字仍取决于模型和硬件；不需要手动切换中英文。录音和收尾期间不能切换引擎，完成后再选；切换失败不会自动换成其他引擎。Qwen 默认在独立识别进程中使用单进程 vLLM，冷启动比 Sherpa 更久，同一引擎连续录音仍复用模型与连接。模型未就绪时按麦克风会显示准备提示，不开启麦克风，也不会在加载完成后自动录音；就绪后重新按住即可。启动失败会显示具体原因，完整启动错误记录在中继日志中。`QWEN_ASR_GPU_MEMORY` 可设置 vLLM 显存比例，默认 0.35；该比例不是 GPU 隔离或不影响其他任务的保证。无 GPU 的电脑继续用 Sherpa。

识别文字插入当前光标位置，保留其他草稿；手动编辑、切换会话/页面或断线会停止录音，已显示文字保留，不会自动发送。首次加载模型会稍有等待，开关开启时会提前预热、预连音频通道并加载录音模块。连续录音复用连接和音频环境；松手立即关闭麦克风并挂起音频环境，页面隐藏或关闭语音开关时释放连接和音频环境。可用 `ASR_THREADS` 调整中继识别进程的 CPU 线程数，默认 2。音频走独立连接，仅在内存中处理，不保存录音。

普通局域网 HTTP 地址无法申请麦克风权限，请用 HTTPS 固定入口或公网隧道。微信等内置浏览器不能开麦时，改用 Safari/Chrome，或使用输入法键盘的语音输入。Android 壳需要包含新的麦克风授权代码的构建；网页发布不会更新已安装的 APK。浏览器麦克风授权方式不变，不承诺网页能永久保存权限。

## 日常使用

`… → 画面` 用于查看电脑上的绘图、仿真窗口（如 Matplotlib、Isaac Sim、MuJoCo），不再显示 Agent 编辑器或整个桌面。点“选择窗口”后选择目标，支持缩放和刷新；窗口画面只读，不发送鼠标或键盘操作。

- Windows：需要支持 `gdigrab hwnd=` 的新版 `ffmpeg` 在 PATH 中，按窗口句柄捕获，避免同名窗口混淆。
- Linux X11：需要 `ffmpeg`、`xprop` 和系统 Python 3，窗口需保持打开、可见。
- Linux Wayland：点“请求共享窗口”，在电脑端系统选择框中选择并授权一个绘图或仿真窗口。需要系统 Python 的 PyGObject、GStreamer 及 PipeWire 插件；Ubuntu/Debian 可安装 `python3-gi gir1.2-gstreamer-1.0 gstreamer1.0-pipewire gstreamer1.0-plugins-good gstreamer1.0-plugins-base`。系统允许时，恢复凭据保存在 `~/.agent-remote/visual.json`，下次优先恢复；窗口关闭、权限撤销或恢复失败时需重新授权。Cloudflare 隧道重连不改变这份授权记录。

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
| `npm run pair` | 生成一次性配对链接和二维码（`-- --lan` 生成局域网入口链接） |
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
