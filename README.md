# Remote Agent

用手机操作这台电脑上的 Cursor、Devin 和 VS Code 里的 Codex。对话、切换 Agent 和模型、看终端、批准确认，都在手机浏览器里完成。这些程序在手机的窗口列表里切换，也可使用 Fusion 让两个模型协作完成任务。

<p>
<img src="docs/phone.png" alt="手机上新建一条对话并询问你是什么模型" width="280">
<img src="docs/terminal.png" alt="手机上的终端" width="280">
</p>

参考仓库：[https://github.com/Suchenl/cursor-remote-lite](https://github.com/Suchenl/cursor-remote-lite)

## 这台机器上怎么用

需要 Node.js 22 或更高版本，以及本机的 `cloudflared`（放在 `~/.local/bin`，不改系统环境）。Linux 上可以这样安装：

```bash
mkdir -p ~/.local/bin
curl -L --fail -o ~/.local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x ~/.local/bin/cloudflared
```

1. 让 Cursor 打开调试端口后再启动（端口默认 `9222`）：

```bash
cursor --remote-debugging-port=9222
```

2. 启动 Devin，并打开它自己的调试端口（默认 `9223`）。这不会关掉 Cursor，也不会关掉已经开着调试端口的 Devin：

```bash
./start-devin.sh
```

如果 Devin 已经在运行，但没有调试端口，先退出 Devin，再运行一次这个脚本。

3. 启动 VS Code 里的 Codex，并打开调试端口（默认 `9224`）。这不会关掉 Cursor 或 Devin。如果 VS Code 已经开着但没有调试端口，先退出 VS Code，再运行：

```bash
./start-codex.sh
```

打开 Codex 侧边栏之后，手机窗口列表里只有一项 Codex。Codex 要单独开一个 VS Code 窗口才能工作，这些窗口不会再各占一条。点手机上的「Agent」切换，按项目文件夹分组折叠；会话取手机最近打开时间和 Codex 更新时间中较新的时间排序，各组按组内最新时间排序，重新打开列表时从顶部显示。分组名字用文件夹，不用整段窗口标题。

4. 安装依赖并打开公网隧道：

```bash
npm install
npm run public
```

5. 配对手机。终端会打印一次性链接，用手机 Safari 打开：

```bash
npm run pair
```

配对记录保存在电脑上的 `~/.agent-remote/`。旧目录 `~/.cursor-remote-lite/` 会在下次启动时改名过来。公网隧道单独在后台运行。Linux 下重启 `npm run public` 可复用仍在运行且可访问的隧道，已配对的手机不用重新配对；隧道进程退出后，新建隧道会更换地址。Windows 的复用限制见下文。

终端里会打印隧道进程号。要彻底关掉公网：

```bash
kill <隧道进程号>
```

只在局域网用时，把 `npm run public` 换成 `npm run start`。

## 手机上能做什么

- 看 Agent 对话，回车发送，Shift+回车换行。
- 查看 Codex 提供的思考摘要和工作过程，生成时实时更新，完成后可展开或收起；未返回摘要正文时不展示空卡片。
- 切换 Agent 和模型。旧版 Cursor 在输入框旁有「历史」，用来打开这一条 Agent 里以前的聊天。现在 Cursor Agents 和 Devin 都把这些会话放在左侧列表里，手机上用「Agent」切换，工具栏不再放「历史」。Codex 的每个 VS Code 窗口也在这个列表里。
- Codex 输入区工具栏的「＋」集中提供 Plan、技能搜索、文件引用、扩展命令、IDE 上下文、执行位置和会话操作；技能通过原生引用插入。
- Codex 会话列表支持归档会话；归档使用桌面端原生操作，不等同于永久删除。
- Codex 的权限在模型旁边，不挡对话。三档是每次询问、代为批准、完全访问。Cursor 和 Devin 的输入栏没有这个开关。
- 看终端文字，新建、切换、关闭终端，并执行命令。
- 看上下文占用和额度。Codex 在前台每分钟请求一次最新额度，回到前台时也会更新；点额度展示可立即刷新。
- 查看和编辑文档，支持复制、粘贴、缩进和搜索。外接键盘可用 Ctrl/⌘+S 保存、Ctrl/⌘+F 搜索、Tab/Shift+Tab 缩进或反缩进。
- 对话里的公式按数学式显示。代码块可以点「复制」，较长的行内命令点一下也会复制。
- Devin 支持思考正文、工具详情、任务清单和排版后的回复；可切换会话及 Agent / Editor 界面，回答提问、管理排队消息、接受或拒绝文件改动。
- Devin 命令卡分别显示命令与输出；任务清单可折叠。文件引用保留完整路径，包括 Windows 盘符；没有待审阅改动时，可查看会话修改记录及文件当前内容，历史记录不提供接受／拒绝操作。
- Devin 输入支持 `@` 引用；新会话可选择工作目录及 Local / Worktree / Cloud，权限菜单提供应用实际支持的模式。
- 文件查看按电脑端应用主题进行语法高亮，标记相对 Git HEAD 的改动行，保留搜索及编辑快捷按钮。超过 200 KB 或 5000 行时显示普通文本。
- 安卓 App 支持扫码配对、通知直接回复及选项操作、后台网络重连和本地历史搜索，需要安装包含这些功能的新 APK；浏览器使用 IndexedDB 保存 Devin 已读取的会话记录。
- 从手机附加图片，发送前可点附件旁的「×」撤下。支持上传 PDF、Office 文档、TXT、Markdown、CSV、JSON 和代码文件（是否能解析由当前 Agent 决定）（单文件最多 20 MB），发送时交给当前 Agent 读取，取消时删除临时文件。
- 在窗口列表里切换 Cursor、Devin、Codex 和 Fusion。Fusion 先选项目，再选两端的 Agent、会话和模型；两端可以使用同一种 Agent 的不同模型，按方案、执行、检查的流程协作，并保存历史会话。
- 一台手机可以配对多台电脑。菜单里的「电脑」用来切换和删除。配对另一台时，用那台电脑自己打印的 `npm run pair` 链接，已经配对的电脑会保留。
- 连不上时自动检测页面地址和隧道，显示请求结果及失败阶段；隧道 8 秒超时后自动进行 30 秒复测，区分复测可达与持续超时，也可手动重新检测。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run public` | 启动中继，并使用公网隧道 |
| `npm run start` | 只在本机或局域网启动 |
| `npm run pair` | 生成一次性配对链接 |
| `npm run devices` | 查看已配对设备 |
| `npm run 2fa` | 可选的 Authenticator 二次验证 |
| `./start-devin.sh` | 启动 Devin，并打开调试端口 9223 |
| `./start-codex.sh` | 启动 VS Code，并打开调试端口 9224，供 Codex 使用 |


## Windows 与安卓构建

Linux 使用前面的启动脚本。Windows 可用 PowerShell 启动中继（`npm install`、`npm run public`、`npm run pair`），桌面应用需自行以 `--remote-debugging-port` 参数启动；`.sh` 脚本需要 Bash。Windows Devin 已通过配对浏览器检查文件打开、语法高亮和改动标记、命令与输出、会话修改记录及会话切换。待审阅改动的接受／拒绝仍需有真实待处理任务时验收。隧道自动复用仍依赖 Unix `ps`，Windows 下重启 `npm run public` 可能创建新隧道。更新与排查步骤见 [Windows Devin 维护文档](docs/windows-devin-maintenance.md)。

安卓构建需要 Java 17 和 Android SDK 34，在 `android/` 执行 `./gradlew assembleDebug`（Windows 用 `gradlew.bat assembleDebug`）。历史存储桥接已做本地检查；扫码、通知操作和 SQLite 历史搜索仍需通过新 APK 真机验证，本轮未构建 APK。
