# RA Connect v0.1 — 私有 ChatGPT MCP 接入

## 结构与权限
- Linux opt-in；RA Relay 通过 RA_CHATGPT_CONFIG 加载独立的 owner-only JSON policy。默认不启动 MCP bridge，不增加公开 HTTP 路由。
- cli/chatgpt-mcp.mjs 通过 0600 Unix socket 连接 RA；父目录及 policy 目录必须为 0700。clientId、enabled、expiresAt、workspace/session grants 都必须明确设置。每次请求重读 policy。
- 已授权本地文件支持 list/read/create/save；create 不覆盖，save 需要 read 返回的 SHA-256。拒绝绝对路径、目录穿越、符号链接、硬链接、二进制及超限文件。operation ID 相同且参数相同可查询原回执；参数不同拒绝。UNKNOWN 不应以新 ID 自动重试。
- Peer 仅实现已绑定工作区的签名读取入口，尚未验收；当前不开放跨机写入。
- OpenCode 已验收会话读取及原生消息提交回执；完整生成尚未通过（模型 retry）。其他 Agent 的只读预览入口尚未验收，不开放发送。
- 这不是抵御同一 OS 用户恶意进程的沙箱。文件授权与 Agent 自己的执行权限不同，不向未审查的 Agent 会话开放发送。当前无任意 shell、无全盘授权、无多用户/OAuth 公共服务。

## 本地 QA
独立 Relay 3958，OpenCode QA 4196，私有 socket /run/user/1000/ra-chatgpt-qa-20261124/bridge.sock。
本轮 QA 根目录：_shots/ra-chatgpt-v01-20261124/。
仅允许 QA 工作区和指定 QA OpenCode 会话；policy 位于 policy/policy.json，含有效期。
正式 Relay 3939 和既有 QA 3949 不变。初次连接只在 QA 范围内验证。

## ChatGPT Secure MCP Tunnel
1. 在 https://platform.openai.com/settings/organization/tunnels 创建与目标 ChatGPT workspace 对应的专用私有 tunnel。创建者需要 Tunnels Read + Manage 权限。
2. 创建仅具有 Tunnels Read + Use 所需权限的 runtime API key（不是 admin key）。不要把 key 粘贴到 ChatGPT 或写入仓库。
3. 在 A 本地终端运行 _shots/ra-chatgpt-v01-20261124/connect-tunnel.sh。按提示输入 tunnel ID 和隐藏输入 key。脚本使用已验证的官方 tunnel-client v0.0.21、独立临时 profile、stdio MCP 和官方 doctor/run；key 通过环境引用提供，并从 MCP 子进程环境去除。Ctrl-C 结束测试隧道。
4. ChatGPT 网页端 Plugins → Add custom MCP server → Tunnel，选择同一个 tunnel，完成用户授权。界面与可用能力以账户、workspace 权限及当前产品为准。
5. 先验证 list_devices/list_workspaces/list_files/read_file，再验证 create_file/save_file 和明确授权的 QA 会话。若账户只支持读取，不通过错误标注工具或其他方式绕过限制。

本轮尚未创建 OpenAI tunnel、连接 ChatGPT plugin 或进行 ChatGPT 侧真实调用。必须在 ChatGPT 侧成功验收后再逐步停用 Desktop Commander。
官方文档：https://platform.openai.com/docs/guides/secure-mcp-tunnels
