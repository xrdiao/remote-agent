# 电脑互控

## 从会话操作另一台电脑

首次互控前，两台电脑各自用运行 RA 中继的系统账号，在本机的 RA 目录运行 `npm run peer -- status`。记下两台电脑各自显示的 `id` 和完整 `fingerprint`，在手机「互控」中选中两台电脑，粘贴从各自本机取得的指纹，再点「确认双方指纹」。手机将双方的电脑 ID 和指纹签名后分别发送给两台中继。只有一台成功时，可用同样的指纹重试。

也可在两台电脑本机各自运行以下命令，替换为对方电脑本机给出的值。

```sh
npm run peer -- trust '<对方电脑 ID>' '<对方电脑的 SHA256 指纹>'
```

手机的「互控」可以查看两台电脑的指纹以及各自的核对结果。已授权的工作区补核对后，可以继续原会话。手机只登记缺少的指纹。一端更换密钥时，重新在对方电脑本机核对并用 `npm run peer -- trust` 登记新的指纹。发起端更换密钥后，还需在目标机撤销发起端的旧工作区授权，再重新授权。

两端以本机登记的指纹验签，请求和对应回执均验证身份。命令、文件和输出的保密性由 HTTPS 提供。

在同一个网页入口配对两台电脑。主页底栏点「互控」，选择发起电脑 A 和目标电脑 B。第一次为该方向授权时，输入 B 上项目的绝对路径，勾选允许使用目标终端，再点「授权并进入会话」。可选择 A 上的 Cursor 或 Devin Local，也可选已按下文配置 `ra_peer` 的 Codex 或 OpenCode。

在会话里可以说「在目标项目列出文件，读取 README，并在目标终端运行 `pwd`」。A 的 Agent 使用工作区工具，由 B 的中继读取、创建和保存项目文本文件，也可以在 B 打开终端、发送命令、读取输出或中断前台命令。

两台电脑使用手机已配对的 RA 中继地址通信，B 只需运行中继。反向控制时交换发起和目标，走一次独立授权。再次进入同一份授权，会打开原来绑定的会话。中继地址变更后，从互控入口重新进入可刷新连接。

文件工具使用授权目录下的相对路径，每次最多读取或保存 32 KiB 的 UTF-8 文本。终端从授权目录启动，其命令继承 B 上中继账户的系统权限，可以执行该账户有权进行的操作。手机上的「撤销工作区授权」会让旧会话的工具调用失效，并关掉该授权打开的终端。

## 管理预设任务

在「互控」中选择「预设任务管理」，可以授权、撤销或手动派发目标电脑登记的任务。目标电脑只需运行 RA 中继。第一版由 Linux 电脑执行任务，每个方向单独授权。

两台中继都需要支持互控。用同一个网页入口配对两台电脑，在两台电脑上分别运行 `npm run peer -- status` 可查看各自的电脑 ID。

在目标电脑的 `~/.agent-remote/peer.json` 登记本地任务。下面的路径换成这台电脑上的实际路径，第一项为可执行文件，后面的项为固定参数：

```json
{
  "tasks": {
    "check": {
      "name": "检查项目",
      "cwd": "/path/to/remote-agent",
      "argv": ["/usr/bin/node", "scripts/check.mjs"]
    }
  }
}
```

在发起电脑的同名文件中，将目标电脑 ID 对应到已可访问的中继 HTTPS 地址：

```json
{
  "targets": {
    "0123456789abcdef": "https://relay-b.example.com"
  }
}
```

同一台电脑既发起又接收时，两个字段可放在同一个文件里。目标更换地址后，只需更新发起电脑的地址再查询原任务，不需要重新授权。互控不会向 GitHub Pages 写入地址。

回到浏览器，在「预设任务管理」中选定方向和预设任务，点击允许后即可发起、查询或停止。每次只在目标电脑上运行一个任务，最长五分钟。预设应是前台程序，不要登记启动独立后台服务的命令。断线时先查原任务号；中继重启后可能显示结果待确认。撤销在目标电脑生效，并请求停止该权限下仍在执行的任务。

如果从发起电脑本机操作，可以用 `npm run peer -- start <目标ID> <预设任务ID> <授权编号>`。授权编号由目标电脑的 `npm run peer -- status` 列出，`read` 和 `cancel` 使用相同参数并在末尾加原任务号。

## 在发起端配置 `ra_peer` MCP

从手机进入互控时，RA 会为发起端已连接的 Cursor 和 Devin 自动在互控项目中登记 `ra_peer`。已有授权从「互控」重新进入即可补齐。Cursor 使用 `.cursor/mcp.json`，Devin Local 使用 `.devin/mcp_config.json`。如提示信任项目或批准工具，确认当前项目为 RA 的互控项目后按原生提示操作。[Cursor MCP](https://cursor.com/docs/mcp) · [Devin Local MCP](https://docs.devin.ai/desktop/devin-local/customizations#mcp-servers)

Cursor 首次加载新的项目 MCP 时，若 `ra_peer` 显示为 Disabled，在该互控项目的 **Customize → MCPs** 中启用它，再回到手机会话。

在 Codex 和 OpenCode 中手动登记 `cli/peer-mcp.mjs`。同一套工具也支持在普通会话里发起预设任务。例如可以说「列出另一台电脑授权的任务，请运行检查项目，并把结果告诉我」。Agent 会查目标授权、发起任务，再按原任务号查询。

以本机 Codex 控制另一台电脑为例，在本机运行以下命令。把 Node 和仓库路径换成实际的绝对路径，然后在已加载该工具的 Codex 对话中操作：

```sh
codex mcp add ra_peer -- /usr/bin/node /path/to/remote-agent/cli/peer-mcp.mjs
```

Codex 的工具审批照常生效。若会话选择了「从不审批」，需要确认的发起或停止操作会被拒绝。

反方向使用另一台电脑的 OpenCode 本地模型。在另一台电脑上，向现有 `opencode.json` 的 `mcp` 对象添加 `ra_peer`，保留原有模型和配置，然后重新打开使用该配置的 OpenCode 服务或会话：

```json
{
  "mcp": {
    "ra_peer": {
      "type": "local",
      "command": ["/usr/bin/node", "/path/to/remote-agent/cli/peer-mcp.mjs"],
      "enabled": true,
      "timeout": 25000
    }
  }
}
```

上述 JSON 对应仓库目前使用的 [OpenCode 1.15.5 配置](https://github.com/anomalyco/opencode/blob/v1.15.5/packages/opencode/src/config/mcp.ts)。接收端只需启动新版 RA 中继，并在底栏对发起端授权相应的预设任务。两端都要发起时，分别设置各自的目标地址和授权；同一方向不需要目标端再安装工具或运行 Agent。
