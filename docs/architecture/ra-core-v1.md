# RA Core v1

RA Core 是 relay 的确定性控制面。配对设备显式选择 A 上的原会话、B 的已登记工作区和允许的操作。RA Core 记录授权与操作回执，执行仍走 Peer Workspace v2。普通本地 Agent 会话默认获得零个 RA 远程工具和零条 RA 注入提示。RA Core API 不启动模型、不发送消息，也不触发后续 Agent turn。已有的互控入口、预设任务和专用手机会话继续使用各自的行为与权限。

## 数据与权限

| 实体 | 含义 |
| --- | --- |
| Node | 既有 relay 的电脑 ID。本机和已登记的 peer 分别为 `local` 和 `peer`。peer 来自出站工作区绑定和已知入站授予。入站授予只证明该电脑在本机有一条授予记录。 |
| Capability | 本机 Agent 由 adapter registry 与实际连接判断，文件由本机文件服务判断，终端由现有 PTY 状态与 shell 判断，手机由当前设备可见的原生手机提供者判断。已有终端可标为 `ready`，可找到 shell 而尚无在线终端时为 `unverified`。已登记的远端文件和终端能力为 `unverified`，与 B 提供哪种 Agent 无关。 |
| OriginRef | A 通过已验证的 WebSocket 读取当前设备现有的会话绑定。公开字段为 `id`、`deviceId`、`computerId`、`app`、`threadId` 和可选的 `projectId`。项目 ID 根据已确认的项目身份生成，不含路径。调用端使用快照返回的 OriginRef ID。 |
| Activation | 一次针对设备、OriginRef、节点、工作区及具名动作的显式同意。记录验证时间、截止时间、最大用量、已用量及撤销时间。每个作用域持有一条当前记录。 |
| Operation | 记录一次显式调用。复合主键为配对设备 ID、OriginRef ID、操作 ID。记录目标、动作、激活、状态、时间、使用计数、回执摘要和文件引用。 |
| Link | 由 Operation 导出，关联 A 上的原会话与 B 上的目标工作区及不透明的文件引用。Work 视图直接读取操作日志，无独立任务调度。 |

- **Registered** 表示 A 可读取既有 Peer Workspace 绑定。RA Core 不接受请求体提供的 relay URL、指纹或绝对路径。
- **Granted** 的权威在 B。激活时，A 必须收到 B 对现有工作区 `inspect` 的签名成功回执。A 核对签名、目标身份、nonce 和本地登记的指纹。快照的 `grantVerifiedAt` 表示历史验证时刻。B 在每次远程操作时重新检查授予。吊销 B 的授予立即阻止 B 接受后续动作。
- **Activated** 表示当前配对设备对具体原会话和动作显式授权。有效激活还要求原会话可用、绑定与验证时一致、激活有效且未撤销。切到其他会话后，旧 OriginRef 无法发起新调用。已登记的 URL 或指纹发生变化时，旧激活视为过期绑定，需要撤销并重新激活。

## HTTP API

路径前缀为 `/api/ra-core/`。GET 使用现有的配对设备签名。POST 另外使用现有的签名请求体摘要和 Origin 校验。所有路由均经过现有 TOTP 检查。POST 在异步验证后会再次检查配对状态。

| 方法和路径 | 请求和响应 |
| --- | --- |
| GET `snapshot` | 返回版本、节点和本设备当前绑定的 OriginRef 列表。可指定 `originId` 读取该当前会话的激活记录。 |
| GET `work` | 指定 `originId`，可加 `operationId`，返回本设备作用域内单条记录或最近 100 条。历史 OriginRef 断开后也可查询。 |
| GET `links` | 与 `work` 使用相同查询条件，返回操作到原会话和远端工作区的关联。 |
| POST `activate` | 提交 `originId`、`nodeId`、`workspaceId`、`actions`、`ttlSeconds`（1–86400）和 `maxUses`（1–100），返回激活 ID。 |
| POST `invoke` | 提交 `originId`、`nodeId`、`workspaceId`、`activationId`、`operationId`、`action` 和 `args`。返回操作记录。首次成功的读取调用会把文件内容、列表或终端输出返回给当前调用者。 |
| POST `revoke` | 提交 `originId` 和 `activationId`。可撤销本设备的对应激活，即使原会话已断开。返回 `activation`、`inFlight` 和 `inFlightCount`。清单是撤销事务内属于该配对设备、OriginRef 和激活的 `STARTED` 操作记录，可用其中的操作 ID 通过 `work` 查询后续结果。 |

工作区动作沿用 Peer v2 命名。`list-files`、`read-file`、`create-file` 和 `save-file` 使用工作区相对路径，以 `/` 分隔。`list-files` 默认读取 `.`。`create-file`、`save-file` 和 `send-terminal` 使用 `text`，其余终端动作使用空参数。路径由 B 按其平台规则再次验证和约束。终端仍由 B 按 Peer 工作区共享，已有的 shell 权限模型仍然适用。终端提交成功表示 Peer 确认收到输入。RA Core 的 `open-terminal` 即使复用已有终端也仅返回终端状态摘要。读取输出需要显式授权 `read-terminal` 并调用该动作。

公开快照、历史和关联不含 URL、指纹、设备凭据、绝对根目录、文件名称、文件正文、终端输出、命令或提示。操作记录保存结果摘要及所属节点和工作区明确的文件引用。引用中的相对路径仅保存在本机日志内。

## 状态与失败语义

操作 ID 格式为 `<13 位 Unix 毫秒时间戳>-<小写 UUIDv4>`。A 接受最近 10 分钟内签发的新 ID，并容许 60 秒的未来时钟偏差。相同作用域中的相同 ID 和参数只返回已有记录。相同 ID 用于不同目标、动作或参数时返回 409。重放受当前激活的动作权限约束，不再扣用量，也不返回首次调用的读取内容。

```text
RESERVED → STARTED → SUCCEEDED
                   → FAILED
                   → UNKNOWN
RESERVED / STARTED → UNKNOWN（中继重启恢复）
```

使用计数和 `RESERVED` 记录在同一 SQLite 事务提交，`STARTED` 在调用远端前持久化。任何活动中的操作在重启恢复为 `UNKNOWN`。缺少可验证回执、超时、连接中断或无法解析的成功回执也记为 `UNKNOWN`。B 的签名拒绝记为 `FAILED`。仅收到未签名的 HTTP 403 时，API 返回 403 并记为 `UNKNOWN`。收到拒绝或不确定结果的已保留操作仍计入用量。RA Core 不会自动重发。新的操作 ID 表示一次新的显式请求，调用者应先核对 `UNKNOWN` 的实际效果。

A 的撤销阻止该激活产生新预约或派发。A 在预约和开始事务中使用当前时间检查期限，派发前再检查一次。撤销的 `inFlight` 记录表示 A 已开始处理且尚无最终结果。Peer Workspace v2 的已签名请求可以在撤销或到期之后由 B 执行，因为 B 只验证自己的工作区授予。撤销保留在途记录，A 收到可验证回执后按结果记为 `SUCCEEDED` 或 `FAILED`，结果无法确认时记为 `UNKNOWN`。

权限不足返回 403，绑定缺失、过期、ID 冲突等状态冲突返回 409，无法验证远端回执通常返回 502。日志不可用返回 503，错误使用稳定的错误码，并隐藏底层路径和凭据。完成回执写盘出错会停止继续派发，已开始的操作保留给重启恢复。

数据库位于 `DATA_DIR/ra-core-v1.sqlite`，使用 Node 自带的 `node:sqlite` 和同步事务，不依赖 npm 模块或外部数据库服务。RA Core 需要包含该内置模块的 Node 版本。relay 成功监听后先获取 SQLite 独占锁，再校验应用标记、版本和完整性并执行恢复。锁由该连接持有至退出，收到 `SIGTERM` 或 `SIGINT` 时关闭连接。发生锁冲突或数据库损坏时，启动日志会记录原因，该实例的 RA Core API 返回 503。完成记录保留至少七天后可清理，最多保留 4096 条操作与 512 条激活记录。达到容量而尚无可清理记录时拒绝新记录。清理后，同一旧 ID 依然无法再次进入执行。

## A → B 验收

1. 在既有配对浏览器连接 A 上的一条普通会话，读取快照并取得 OriginRef。确认该会话没有 RA 远程工具或注入提示。
2. 通过既有 Peer Workspace 流程核验 A 和 B 的指纹，并在 B 授予目录。先用 A 的签名请求尝试调用，确认没有激活时返回 403。
3. 为原会话激活指定的文件或终端动作。验证同设备另一条会话及另一配对设备无法复用这条激活。
4. 在 QA 授权目录调用一次创建或写入。检查 B 实际只执行一次，相同操作 ID 的重放返回同一日志记录。用 `work` 和 `links` 核对 A 上的原会话及 B 上的工作区。
5. 撤销 A 的激活，确认该激活的后续调用被阻止，并用 `work` 查询撤销时仍在途的记录。撤销 B 的工作区授予，确认 B 拒绝后续动作。B 离线时保留阻塞状态，恢复在线后重新验收真实签名网络链路。

下一阶段可把显式激活、范围确认、回执和撤销接到 UI。需要动态 Agent 工具适配时，应在该阶段加入按 OriginRef 绑定的工具生命周期，并单独验证权限、提示和关闭行为。本阶段可通过签名 API 直接调用，普通 Codex 聊天仍没有这条工具入口。
