# Remote Agent

用手机操作这台电脑上的 Cursor、Devin 和 VS Code 里的 Codex。对话、切换 Agent 和模型、看终端、批准确认，都在手机浏览器里完成。这些程序在手机的窗口列表里切换。

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

配对记录保存在电脑上的 `~/.agent-remote/`。旧目录 `~/.cursor-remote-lite/` 会在下次启动时改名过来。公网隧道单独在后台运行，之后重启 `npm run public` 会沿用同一个地址，已配对的手机不用重新配对。只有关机，或手动结束隧道进程，地址才会变。

终端里会打印隧道进程号。要彻底关掉公网：

```bash
kill <隧道进程号>
```

只在局域网用时，把 `npm run public` 换成 `npm run start`。

## 手机上能做什么

- 看 Agent 对话，回车发送，Shift+回车换行。
- 查看 Codex 提供的思考摘要和工作过程，生成时实时更新，完成后可展开或收起；未返回摘要正文时不展示空卡片。
- 切换 Agent 和模型。旧版 Cursor 在输入框旁有「历史」，用来打开这一条 Agent 里以前的聊天。现在 Cursor Agents 和 Devin 都把这些会话放在左侧列表里，手机上用「Agent」切换，工具栏不再放「历史」。Codex 的每个 VS Code 窗口也在这个列表里。
- Codex 的权限在模型旁边，不挡对话。三档是每次询问、代为批准、完全访问。Cursor 和 Devin 的输入栏没有这个开关。
- 看终端文字，新建、切换、关闭终端，并执行命令。
- 看上下文占用和额度。Codex 在前台每分钟请求一次最新额度，回到前台时也会更新；点额度条可立即刷新。
- 查看和编辑文档，支持复制、粘贴、缩进和搜索。外接键盘可用 Ctrl/⌘+S 保存、Ctrl/⌘+F 搜索、Tab/Shift+Tab 缩进或反缩进。
- 对话里的公式按数学式显示。代码块可以点「复制」，较长的行内命令点一下也会复制。
- 从手机附加图片到输入框。
- 在窗口列表里切换 Cursor、Devin 和 Codex。Devin 显示为 Devin agent，Codex 只显示为 Codex。
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

