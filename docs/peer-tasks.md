# 电脑互控

主页底栏点「互控」，选择发起电脑、目标电脑和一个预设任务。目标电脑只需运行 RA 中继；不需要安装或启动 Codex、OpenCode 等 Agent。第一版由 Linux 电脑执行任务。发起方向独立授权，例如允许 A 给 B 派任务，不会同时允许 B 给 A 派任务。

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

回到浏览器，选定方向和预设任务，点击允许后即可发起、查询或停止。每次只在目标电脑上运行一个任务，最长五分钟。预设应是前台程序，不要登记启动独立后台服务的命令。断线时先查原任务号；中继重启后可能显示结果待确认。撤销在目标电脑生效，并请求停止该权限下仍在执行的任务。

如果从发起电脑本机操作，可以用 `npm run peer -- start <目标ID> <预设任务ID> <授权编号>`。授权编号由目标电脑的 `npm run peer -- status` 列出，`read` 和 `cancel` 使用相同参数并在末尾加原任务号。

## 从手机对话发起

在发起端的 Agent 中登记 `cli/peer-mcp.mjs`。从手机进入这台电脑的对应对话后，可以说「列出另一台电脑授权的任务，请运行检查项目，并把结果告诉我」。Agent 会查目标授权、发起任务，再按同一个任务号查询。底栏「互控」仍可用于授权、撤销和手动派任务。

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
