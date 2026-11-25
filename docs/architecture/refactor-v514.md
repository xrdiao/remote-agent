# Remote Agent v514 → v517 模块化重构（隔离工作树）

基线为 `2db4744`（PWA v514）。隔离工作树的 PWA 为 v517，等待配对回归。M0 链路盘点、M1 SEND 生命周期、M2 WebSocket 调度与恢复、M3 会话绑定、M4 Android 手机控制及 Codex 工具生命周期已实现。M4B 的 Adapter 注册、AgentContext 装配和原生操作分派已实现并通过确定性验证。M5 的 Fusion 状态、持久化与恢复已实现并通过确定性验证。M6 的 PWA 模块化与文件、终端来源绑定已实现，真实配对浏览器验收由协调方执行。本文中的 SEND 指手机通过 `/ws` 发起的原生消息提交。Fusion 运行、Codex 容量重试与队列管理各有独立入口和既有语义。

## v514 现状

1. `server/ws.mjs` 在鉴权后创建或恢复 `Session`，按配对设备订阅操作回执。普通命令串行入队，问题回答有独立队列，导航等待两条队列。快速 `stop` 绕过队列，所以能取消正在准备或排队的发送。纯导航可以合并，绑定代数约束后续命令，窗口切换可中止上一个绑定的读取。授权连接断开后可保留绑定五分钟，恢复会等待旧连接的任务排空，受原有过期窗口限制。
2. 同一个 WebSocket 闭包维护 SEND 集合和 AbortController。它同时读取 `operation.submitted`、`signal.submitted`、`signal.aborted`。Codex 窗口在 CDP 执行前标记提交，Codex 后台在等待 writer 之前标记，OpenCode 在 POST 前同时写两处标记。Cursor 与 Devin 直接执行原生回调或按键，没有写提交标记。
3. `Session.handleSelected` 验证显式 `sel`，持有窗口租约并进入适配器。Codex 可跟随同一会话的原生窗口 owner。OpenCode 可以在空白 composer 首次发送时创建会话并转移该 composer 的草稿和上传。缺少 `sel` 的 SEND 在原版会用执行时的可变选择。
4. `server/operations.mjs` 以 `deviceId + operationId` 关联请求与 WebSocket，使用 AsyncLocalStorage 将 `Session.emit` 的操作事件归到当次请求。它按类型保存最近一条事件并增加修订号。处理函数结束时，适配器写入的 `operation.pending` 决定是否继续等待原生回执。Codex 窗口用绑定操作上下文的回调，OpenCode 订阅与指定 native message ID 匹配的事件。已完成明细按原有顺序保留 100 条，原版淘汰时也会移除 SEND ID。
5. 手机端声明 `selectiveOperations` 后通过 `operationLookup` 查询还在等待的请求，旧客户端可收到整批回放。`app/js/net.js` 按事件修订号交付给 composer，发送使用原 `requestId`，并根据 `sel` 应用回执。查无记录或处理完成但仍无确认时，手机保留草稿并提示核对。SEND 的重连恢复走查询路径。

## M1 状态归属

| 所有者 | 状态与职责 | 交接点 |
| --- | --- | --- |
| WebSocket 调度入口 | 入口登记操作并检查重复，向 SEND owner 传递停止及取消信号 | M2 将调度移入 `server/ws/scheduler.mjs`。 |
| `server/ws/send-lifecycle.mjs` | 每条连接上 SEND 的准入选择、待执行集合、取消与原生提交边界 | 准入选择缺省时固定为接收时选择。出队时再次核对。适配器用 `markSendSubmitted()` 原子检查中止并进入已提交阶段。 |
| `server/operations.mjs` | 每个配对设备的操作注册表、事件修订号、是否等待回执、终态和订阅者 | 跨连接持有操作。适配器调用 `expectReceipt()` 和 `releaseReceipt()`，或发布原生证据。操作完成后忽略后到的重复事件。 |
| `Session` | 当前 app、窗口、会话的选择及绑定，窗口租约和 Codex owner 跟随 | 在适配器开始前验证目标。保留同一 Codex thread 的合法 owner 迁移与 OpenCode 首次创建 thread。 |
| 原生适配器及传输 | composer 写入、原生队列策略、提交命令、原生回执匹配 | Cursor 和 Devin 使用原生记录或队列 ID，Codex 窗口使用 `NativeWindow` 原有匹配，Codex 后台关联 RPC，OpenCode 关联生成的 message ID。 |
| 手机端 | 暂存草稿、乐观回显、操作查询及修订号去重 | 使用既有 `operation`、`sent`、`sendFailed` 和 `unknown` 字段。 |

## 不变量与失败语义

- Relay 进程内，每个已登记的 `deviceId + operationId` 最多准入一次 SEND。重连和切换 Agent 或模式后仍识别该 SEND。回执明细被淘汰时只保留 SEND ID，未知查询继续使用 v514 的 `unknown: true, done: true` 格式。不同配对设备有独立的命名空间。
- 提交之前，匹配 `sel` 的停止和 OpenCode 导航可以取消 SEND，发布 `sendFailed` 和 `cancelled: true`。准备工作可能已把文本写入原生 composer，或创建了 OpenCode 空白会话。取消保留未提交的草稿与附件，也阻止原生消息命令发出。
- 进入原生提交边界后，`stop` 仍走该 app 的原生停止路径，SEND 信号保持有效以完成确认。明确的原生拒绝继续走 `sendFailed`。传输超时或失联先以现有 `sent.pending` 格式表达不确定性。可以读取原生结果来确认，任何未知状态均不触发自动再提交。
- `sent.pending` 表示该条事件没有确认结果。`operation.done` 表示 relay 不再为此操作提供后续结果。当原生窗口、Codex RPC 或 OpenCode 仍有回执来源，命令返回后的操作保持 `done: false`。有可信证据时发布终态及原生 `messageId` 或 `queueId`，使用同一个操作 ID 并增加修订号。Cursor/Devin 有限读取结束后可得到 `sent.pending` 与 `done: true`，手机保留草稿供人工核对。
- 迟到的结果属于原配对设备及原发送会话。适配器用提交时的选区标注回执，原生匹配使用捕获的 thread、请求 ID 或队列基线。发送 A 的结果可随操作订阅送到当前查看 B 的连接，并保留 B 的选择与草稿。 `operation.sel` 仍是准入选区，`sent.sel` 可以是同一会话跟随 Codex owner 或首次创建 OpenCode thread 后的选区。
- 自然入队、排队后执行、立即发送或 steer 保留各 app 的原生调用。操作查询只读并按配对设备和可选 kind 筛选。旧客户端整批回放继续可用。事件仍按类型覆盖、带递增修订号，终态仍可回放。

## v514 缺陷与定向证据

| 观察到的路径 | M1 修正与验证 |
| --- | --- |
| Cursor/Devin 先执行原生提交，WebSocket 仍可把该 SEND 当作未提交取消。CDP 调用超时此前直接走失败。 | 在原生写入前标记提交。真实 Cursor 适配器配合 CDP 假 socket 和虚拟时钟，停在写入后触发停止和超时，保留原生消息回执。Devin 真适配器在 A 的延迟队列回执落到 B 时验证选区、草稿及原生队列 ID。 |
| Codex 后台在加载 writer 和处理标题前已标记提交。SEND RPC 超时后可能永久等待延迟回调。 | 在 queue/add、turn/start 或 turn/steer RPC 前标记。RPC 超时后保留 writer 和回调最多 30 秒，期间可按 relay 生成的原生客户端消息 ID 匹配同一会话的队列或用户消息。到期按结果未知结算，释放该操作的 writer 引用和回调。 |
| OpenCode POST 传输异常后，按原生消息 ID 对账的监听可能永久保留。`/summarize` 的请求没有该 ID。 | POST 最多等待 30 秒。普通发送用原生消息 ID 和内容在接下来的 15 秒内对账，到期释放监听并保留草稿。`/summarize` 使用直接原生回执，丢失响应则在同一期限后以结果未知结算。 |
| 缺省 `sel` 可把已登记的 SEND 交给执行时选中的会话。淘汰操作明细后再次收到同一个 SEND ID 可重新准入。 | 对缺省 `sel` 捕获准入选择，并为进程内已淘汰 SEND 保存 ID。测试验证同窗口不同 thread、重连后的重复、模式变化和明细淘汰。 |
| Codex 窗口将 CDP 的明确拒绝留作 pending，窗口关闭也无法终结。迟到的原生回执还能恢复已删除的附件索引。 | 明确拒绝按失败结算，传输失联保留原生监听。窗口关闭或 60 秒到期即解绑并以结果未知结算。附件仅在上传表仍持有同一对象时更新。 |
| Codex 页面先读取可见编辑器 A 的会话，再从聚焦的编辑器 B 取得提交函数。 | 草稿检查、基线读取、草稿写入和提交均核对实际编辑器的 React 会话归属。测试用生产注入脚本验证两个编辑器同时可见时拒绝错投，并保留单编辑器提交。 |
| 手机点 STOP 会把等待原生回执的 SEND 从待确认列表和乐观回显移除。 | STOP 独立执行，SEND 仍由原操作的回执或终态决定。生产 WebSocket 调度和手机回执处理的定向测试覆盖提交、STOP、连接接管、切换会话和迟到回执。PWA 缓存升级至 v515，沿用 v514 协议。 |
| STOP 和草稿同步复用 SEND 的 ID 时会被当作 SEND 重放。 | STOP 和只写草稿可以独立调度，已用过的 SEND ID 仍会挡住重复提交。注册表与签名 WebSocket 定向测试覆盖明细保留和淘汰两种状态。 |

## M2 调度与连接恢复

- `server/ws.mjs` 处理升级、心跳、可见性保活、签名验证与回执订阅。首包签名范围、命令序列号、恢复握手字段、旧客户端回放、选择性查询，以及 `/voice`、`/phone` 升级路径沿用原契约。
- `CommandScheduler` 每个已认证连接独立持有队列、导航屏障、读取信号和待执行任务。普通命令串行。问题可以与普通命令并行，导航等待它之前的问题；后到的问题等待它之前的导航。快速 STOP、ping 和原有快速路由绕过队列。背景读取等前序普通命令后启动，随后允许导航取消读操作。纯导航可以合并；创建项目或会话的导航请求保留执行顺序。图片替换仍先处理同组编辑，取消在粘贴之前生效。
- `SessionRecovery` 保留仍可恢复的绑定五分钟。接管会先停用旧连接并排空已准入任务，再把同一个 Session 移交给最近的合法请求。已经在执行的合法导航可以完成绑定；完成的首屏元数据供恢复使用。过期、不可恢复或授权撤销会释放绑定。原连接仍在线但绑定尚未就绪时，已匹配的恢复 ID 仍会停用旧连接，并为手机建立新 Session。撤销授权覆盖仍在线和已挂起的入口。
- `ConnectionView` 独立持有连接代数和可见性。换线前停用旧连接的投递租约。旧连接异步工作中的普通事件在接管后不会写入新连接或覆盖其元数据。原生操作回执仍登记在设备级注册表；移交期间完成的回执可以查询，移交后到达的回执可以投递给当前已授权的订阅者。即使旧 socket 的 close 握手尚未完成，它也不会收到新的回执。
- 断线、接管和撤销都会取消未进入原生提交边界的 SEND，并保留草稿。已提交的 SEND 继续使用原生确认路径，Relay 不重发。保留期内恢复等待原连接任务排空，设备注册表中的独立原生回执监听可以跨越连接切换。

## M3 绑定与导航

- `SessionBinding` 持有 app、窗口、会话、原生连接、项目及导航代数。旧属性入口继续可用。适配器通过不可变的 `ConversationRef` 捕获准入或读取时的身份。即使 A→B→A 得到相同的 `sel`，旧代数仍失效。连接可见性和跨连接的原生 SEND 回执有各自的所有者。
- `server/session/navigation.mjs` 统一 attach、detach、候选窗口准备、失败回到当前 app 首页，以及首次 transcript 与 `attached` 的合并。候选窗口准备失败时会释放候选资源。导航结果按 relay 内部事务归属，客户端 `navigationId` 仍用于线上事件标注。已经触发的原生导航动作沿用原来的桌面行为。
- 项目目录、transcript、图片和附件读取完成后检查原绑定。Codex 后台切到原生窗口时必须确认同一 thread 与目标窗口，仍属于旧选区的待发送上传随后迁移。OpenCode 首次提交在创建会话后才把空 composer 的草稿和附件转到新 thread；若创建期间收到取消，原生可能存在新建的空会话，relay 不提交消息或迁移草稿。

## M4 Android 手机控制与 Codex 工具生命周期

| 所有者 | 状态与职责 |
| --- | --- |
| `server/phone/control.mjs` | 沿用 `/api/phone` 和 `/phone` 的鉴权入口，处理 WS 消息大小、心跳和关闭。 |
| `PhoneSessionRegistry` | 持有已授权主机、会话、参与设备、审批期限和恢复窗口。Ticket 有效期 20 秒，首次交换即消耗。恢复 ticket 绑定签发时的 host，换线先撤销旧连接归属。viewer 独占当前视图，download ticket 只给签发时的 viewer 使用。审批等待 90 秒，未就绪的捕获或断线恢复最多等五分钟。 |
| `PhoneTransport` | 绑定当前 host 的 upload 和捕获周期，持有当前画面、几何尺寸及访问树。恢复和重新授权均淘汰旧快照。对 Relay 消费者的画面与控件修订号在同一会话内递增，发往 Android 的操作和传入 JPEG 仍按 v3 格式转换。 |
| `PhoneActionScheduler` | 手动与 AI 写入走同一个准入槽。AI 批次持有独占权到执行或核对结束，重叠请求返回忙。每个送往 Android 的动作持有稳定的会话内数字 ID，匹配当前 host、捕获周期和 ID 才能接受 ACK。viewer 同一连接按其请求 ID 去重。 |
| Codex 后台 | 在设备会话授权期内持有工具注册。设备断线或暂停共享使当前工具结算，恢复后还可用原会话。会话结束、原生线程关闭或 app-server 代次失效时注销工具并清理回调。原生请求结算前保留 writer 引用，原生轮次结束且 thread 空闲后才能退订。按原生调用 ID 去重，同一被取消轮次的后续工具请求返回失败。 |
| Android `PhoneLink` | 控制和上传 socket 有同一连接代次，ACK 回调验证归属，近期 ACK 可按 ID 回放，较旧 ID 不能重新执行。AccessibilityService 跟踪已派发手势直到系统回调，保留原投屏授权、前台服务、锁屏处理及敏感控件过滤。 |

- Android ACK 表示框架处理了动作。`phone_act` 返回各步 `acknowledged` 和满足显式 `expect` 的 `verified`。手机任务结果仍要按当前画面或访问树判断。正在派发的动作遇到取消、断线或超时会丢失确定性，Relay 不重发。恢复后先用 `phone_observe` 或手动「读控件」完成一次显式 Android 检查才能继续写入。已交给 Android 的手势无法被 Relay 撤回，旧 v3 以 `unsupported` 回报的手势取消也按结果未知处理。
- `phone_observe`、`phone_screenshot`、应用列表和滚动读取保留原入口。刷新检查使用现有 v3 `inspect` 动作，树未变化时可以只有 ACK。viewer 的 `observationRequired` 通知及 ACK 的 `operationId` 均为可忽略的新字段或事件。PWA 的手机控制脚本并入现有 v515 缓存版本，Android 继续发 `agentVersion: 3`，公开版本仍为 1.4.1。
- Codex 仅收到会话范围内的手机工具定义、请求参数与经过筛选的手机观测。配对令牌、签名证明及上传下载 ticket 留在传输层。手机线程使用固定只读权限、禁止提权与 shell 执行，已有私有会话范围继续限制访问。手机线程禁止分叉，以免将私有记录复制到普通会话。

### M4 验收状态

| 验收项 | 结果 |
| --- | --- |
| 确定性 Node 回归 | SEND 28 项、CORE 18 项、PHONE 19 项通过。PHONE 经生产 `/phone` 消息处理与 CodexState 请求入口，覆盖 ticket 期限、半开接管、恢复期限、权限撤销、旧帧及 ACK、重复 ID、AI 和手动冲突、取消、滚动与截图、viewer 清理、Codex 轮次与 writer 释放。 |
| 静态检查 | 隔离 HOME 下通过 `npm run check`。沙箱拒绝原默认语法子进程标准输入，使用本轮临时 `stdio` 预加载仅将标准输入设为 ignore，检查内容一致。通过 `git diff --check`。 |
| 浏览器目录 | `npm run qa:browser -- --list` 加载 201 项。未执行配对浏览器场景。 |
| 隔离 Codex 协议检查 | 安装的 app-server 在空 HOME 下接受 M4 的 `thread/start` 参数，回报 `approvalPolicy: never` 和无网络的只读沙箱。真实账号工具调用、有效工具清单和原生回调端到端待验。 |
| Android 调试编译 | 已尝试离线 `:app:compileDebugJavaWithJavac`。沙箱拒绝 Gradle daemon 创建本地 socket，未到达 Java 编译。本机可见 JDK 11，验证 Android 构建需配备 JDK 17 和 SDK 34。 |
| Android 真机、旧客户端和 Windows | 待 M6 后验证。用已安装 1.4.1 验证现有 PWA 操作、断线恢复和重授权。另用 debug APK 验证 Android 14 及以上系统权限、锁屏、方向变化、无障碍停用、旧手势回调和两端平台的 Codex 工具收尾。Linux 与 Windows 的真实 Relay 均未执行配对回归。 |

## M4B Agent Adapter 与原生能力

每个应用在 `server/apps/index.mjs` 独立登记。手机端继续从 `attached.capabilities` 收到原有布尔字段。可执行能力按绑定的传输选择，Codex 窗口和 Codex 后台各有描述。注册校验原生处理器和 composer 的必要方法，只按已登记的方法名分派，调用时保留 AgentContext 作为 `this`。不支持的原生操作返回明确错误。Codex 后台在取得 Writer 之前拒绝未登记的队列动作。

| 绑定 | 原生操作与证据 |
| --- | --- |
| Cursor 窗口 | 直接提交给所选原生会话。用提交前后的 transcript 和队列确认结果，保留原生队列编辑及草稿恢复。 |
| Devin 窗口 | 先准备原生 composer。处理中立即发送继续走 Devin 原生队列操作。回执读取已绑定 thread 并核对图片数量。队列编辑取回原文，文本问题调用 Devin 原生接口。 |
| Codex 窗口 | composer 查验 thread，提交后由 NativeWindow 按原生请求 ID、thread 和提交基线对账。快速停止继续经过窗口的重试控制。 |
| Codex 后台 | 按既有规则检查桌面 owner，再由 CodexState 运行 RPC。RPC 超时后仍持有 Writer 以等候迟到回执。队列、问题及停止走后台原生入口。 |
| OpenCode API | 使用各自的 HTTP 提交、停止和问题入口。普通发送用原生 message ID 对账。项目归属使用已绑定目录。 |
| Fusion | 编排视图登记独立的停止能力。Fusion provider 保留各自的原生接口，包括 Devin MCP、OpenCode worker 及 Codex 后台的 `idle` 发送语义。 |

`AgentContext` 在定义时显式装配聊天、文件、项目、菜单和会话服务。应用专用方法按当前应用查找，切换绑定后使用新应用的定义。文件面板、桌面设置、提及锁、窗口回执和 Fusion 模型菜单由声明使用的应用显式导入。项目路径和启动原语从选区服务中移出，供 OpenCode 与 Codex 独立使用。兼容入口保留原方法名。未知应用没有 Cursor 默认 adapter。

- `npm run test:adapters` 通过 11 项。测试经生产注册和路由，覆盖 8 个首导入口、跨应用隔离、原生项目来源、队列和问题差异、非法能力、Codex 窗口迟到回执、CodexState Writer 获取与释放、OpenCode 原生 ID 对账及 Fusion provider 兼容入口。
- 原有 SEND 28 项、CORE 18 项、PHONE 19 项通过。SEND 同时运行 npm 脚本和两份逐项报告，以确认沙箱中的测试运行器执行了 28 项。
- 隔离 HOME 下静态检查通过。沙箱拒绝语法子进程的默认标准输入，沿用临时预加载将该输入设为 ignore。浏览器场景目录加载 201 项，`git diff --check` 通过。
- 仍待在配对浏览器验证原生菜单、项目选择和窗口恢复、真实队列及停止交互，以及 Fusion 选项目、发起任务并运行到结束。Linux 和 Windows 的真实 Relay、Android 编译与真机验收仍待执行。PWA 继续使用 v515，手机控制继续使用 `agentVersion: 3`，既有持久化格式和页面助手导出沿用原格式。
- Session 的导航与 Fusion 编排服务仍在 Session 模块中装配。项目窗口扫描、权限确认和跨会话导航仍由各自现有模块承担。兼容 adapter 继续服务菜单、文件和导航入口，后续迁移应按真实平台回归的结果缩小调用面。

## M5 Fusion 编排、持久化和恢复

Relay 在启动入口显式初始化 Fusion。Fusion 模块导入时不读运行记录或模型资料缓存。FusionRun 只提供已提交的只读快照。每次状态变更先在草稿上执行，再原子替换 v2 分片，最后更新内存快照和通知订阅者。写失败保留上一个磁盘记录、内存修订及选择。现有分片、run ID、owner 指针和手机事件沿用原格式。旧状态及窗口记录保留原位。

| 所有者 | 状态与职责 |
| --- | --- |
| `FusionStore` / `FusionState` | 独立加载 v2 索引和各工作台分片，记录包含路径及可识别 run ID 的有界诊断。坏分片禁止回退到过期索引副本，保留原始文件。坏索引仍可通过健康分片读取。目录本身无法读取时只停用 Fusion。 |
| `FusionRuntime` / `FusionRunner` / `FusionScheduler` | 每个 run 有独立 runner、控制器、等待者和原生观察。按 run 和 Worker 分配调度槽，每个 attempt 最多一个任务。启动恢复逐 run 执行，主控连接失败仍可核对子任务。工作台移除或观察结束释放所属监听，释放 Devin MCP 通道时保留其他工作台的通道。 |
| `FusionController` / `FusionAgent` / NativeAgentProviders | Relay 显式注入 AdapterRegistry，Fusion provider 使用各 app、传输和绑定的原生接口。Codex 后台在原生 RPC 前落盘并保留 Writer 到观察结束。Cursor、Devin 和 Codex 窗口继续用原生会话及轮次对账。OpenCode 用原生 message ID。 |
| `presenter.mjs` / Session | 由持久状态和每 attempt 的原生交互快照生成既有 `fusionUpdate`、`fusionState` 和主控元数据。单个视图或订阅者出错不会阻断其他订阅者及持久化。普通发送只在绑定确实属于已登记主控会话时检查 Fusion 工具就绪。 |

- 未进入提交边界的任务可以恢复调度或取消。准备阶段保存原生 Binding、基线和请求身份，随后在原生发送前提交 `submitIntent` 和 `submission: submitting`。发送回执和终态按 thread、attempt、message、turn 及可用的 generation 对账。跨过边界后，即使重启时没有回执，也只观察原生证据。无法确认的执行保持 `unknown` / `outcomeUnknown`，由用户触发继续核对。
- 停止先登记作用域和具体 attempt；可以取消尚未提交的任务。已提交的任务先匹配原生轮次，再登记一次原生停止 intent。重启后保留未获确认的停止，读取同一轮次的终态。v2 中只有 `stopping` 字段的旧记录按停止结果待核对处理。主控工具回复、原生问卷回复、改名和清理均记录各自的执行边界，问卷值留在原生调用内。原生终态先于可选用量或 diff 证据落盘。
- 方案审批、Fusion 问卷和任务依赖决定调度资格。原生提交前再次核对当前授权；准备期间遇到新的审批或问卷，同一 attempt 返回队列。Cursor 和 Devin 的原生问题、Cursor 审批以轻量原生状态生成可操作卡片。显式 transcript 读取独立进行，即使卡住也不影响终态读取或问题投递。
- v2 没有可验证的原生证据时不补推断。服务端分配的会话 ID 在创建回执丢失且原生端无法按请求查回时，需要桌面核对。原生工具回复丢失 ACK、旧停止和缺少可校验身份的外部交互也保留待核对记录。原生工具注册及窗口信任沿用 app 的会话级接口。状态目录继续由单个 Relay 进程拥有，跨进程共享目录和物理断电后的文件系统保证留待独立设计。

### M5 验证状态

- 20 项确定性 Fusion 检查使用同一套生产 Store、Runner、Controller、Scheduler、原生 provider 及投影。覆盖 v2 读写和选择、坏索引／分片／模型缓存、普通 Session、原子写失败、提交前审批变更、丢 ACK 后停止和恢复、超时进入未知、迟到原生回执、并发 run、单 run 恢复失败隔离、B03/B04、原生工具回执、主控与子任务到交付，以及 Codex Writer 和 Devin MCP 通道生命周期。
- SEND 28 项、CORE 18 项、PHONE 19 项、ADAPTER 11 项通过。隔离 HOME 下静态检查通过，沙箱继续使用临时预加载忽略语法子进程的标准输入。浏览器场景目录加载 201 项，`git diff --check` 通过。
- 配对浏览器场景、Windows、真机、真实 CDP／应用服务及 M6 汇总审计待执行。PWA 保持 v515，手机控制保持 `agentVersion: 3`。

## M6 PWA 连接、操作与文件／终端来源

| 所有者 | 职责 |
| --- | --- |
| `net.js`、`computer-connection.js` | 发现、配对和启动由 `net.js` 协调。物理 socket、鉴权结果、心跳、首屏与背景元数据按电脑保留，只有仍属于同一 socket 的回调可以更新它。 |
| `command-transport.js`、`connection-resume.js` | 每次 WebSocket 鉴权建立自己的签名序列。恢复模块管理前台连接代次、停放的会话绑定、重试和预加载。切换电脑时先解除原前台接收与发送入口，再投影新电脑。 |
| `session-selection.js`、`relay-events.js` | 选区模块持有导航序号、就绪状态及目录更新。事件模块先更新所属电脑的连接数据，再交付给当前选区。历史缓存继续通过现有 IndexedDB 管理，可用来恢复停放或断线的会话。 |
| `desktop-operations.js`、`composer-operations.js` | 操作按电脑、配对设备、操作 ID 和回执修订号结算。发送在签名传输前登记，等待确认时拦截同一草稿的重复点击。停止使用独立操作。乐观消息、草稿及原生回执按电脑和会话隔离。 |
| PWA 和 Relay 的 `SourceRef` | 固定电脑、会话、项目或授权根目录以及能力。聊天文件保存核对原会话和 Relay 验证的目录，整机编辑器与传输继续用原配对电脑的磁盘权限。Peer 工作区继续使用签名授权的 canonical 根目录。会话终端从准入时的不可变会话身份读取根目录。PTY 输出和输入仍匹配终端 ID 与订阅令牌。 |

- 重连只按待确认 ID 查询。查无结果或已结束但无法确认时保留草稿。文件保存与整机文件操作也通过查询结算，断线后用户可核对磁盘状态。原操作结算时只更新对应的输入框、文件编辑器或传输页。
- Cursor 为每次原生提交生成独立关联 ID，PWA 回执仍用原 request ID。OpenCode 首次提交创建会话时显式提供旧选区，草稿随会话迁移。收到明确的 POST 拒绝时，新会话保留草稿并返回可操作首屏。Devin 已经取得队列 ID，但立即发送入口不可用时，回执确认该消息仍在队列中。
- M6 的 PWA 缓存升级到 v516，独立审查修复将其升级到 v517。Android 保持 `agentVersion: 3`，Fusion 继续使用 v2 状态分片，页面助手导出维持原 196 项快照。

### M6 验证与发布门槛

- 原有确定性回归 96 项通过，包含 SEND 28、CORE 18、PHONE 19、ADAPTER 11 和 FUSION 20。
- `npm run test:frontend` 通过 9 项。按真实页面顺序加载 PWA 脚本，使用注入的 DOM 和签名 WebSocket 验证双电脑同 ID 会话、草稿与乐观消息、签名重授权、只查回执、STOP、迟到状态、OpenCode 跨重连草稿、终端订阅、文件及传输目标和监听器数量。
- `npm run test:tools` 通过 8 项。经生产 Session、路由及原生适配器验证终端来源与订阅、聊天和整机文件作用域、Peer 签名与目录边界、POSIX 和 Windows 路径规则，以及 Cursor、OpenCode、Devin 的定向修复。
- 隔离 HOME 下 `npm run check`、`git diff --check` 通过。语法检查沿用本轮临时预加载，将沙箱拒绝的子进程标准输入设为 ignore。浏览器目录列出 201 项。
- 真实配对浏览器回归是合入前门槛，由协调方使用现有配对浏览器执行。检查连接和重连、Cursor／Devin／Codex／OpenCode 的发送、停止、会话切换、模型菜单、文件预览和保存、终端输入和输出，以及 Fusion 从选项目到 run 结束。Windows Relay、Android 构建和真机仍待验。

## v517 独立审查修复

| 问题 | 修复与永久回归 |
| --- | --- |
| SEND 迟到确认后，输入框残留已用附件 | OpenCode 和 Codex 后台确认原生消息后清除对应上传的待发标记，并在同一修订化 `sent` 回执中附带已消费的 ID。PWA 只在对应电脑及会话移除这些行。按配对身份和选区隔离上传读取、提交及迁移。签名假 WebSocket 走生产 OpenCode 提交、操作登记和 Session 导航，覆盖 A→B→A、连接接管和仍在 B 三种时序，同时核对新附件、B 的编辑、其他设备上传和单次原生 POST。Codex 后台定向回归也核对迟到确认及结果未知时的上传标记。 |
| Fusion 原生清理完成后重启卡住 | 重试移除优先读取已落盘的 v2 effect 回执。已确认的原生归档或删除可在原生离线时继续更新目录，目录写入成功才结算 binding。用真实分片注入 effect 落盘后的中断、原生离线和目录写失败，核对目录重试成功且原生只归档一次。缺乏原生结果证据的执行仍先对账。 |
| 结构损坏的 v2 分片影响普通项目窗口 | 加载时验证主控与 Worker 的创建记录、方案、任务、问卷、执行快照、模型等嵌套数组。可解析的坏分片会被隔离并保留原文。真实临时分片测试核对健康工作台、普通 Session 和项目窗口探测。 |
| Codex 补读终态后手机工具继续执行 | 原生通知和补读共用轮次收尾，取消已结束轮次的工具和请求，释放 writer 引用与观察监听。假原生传输分别卡在第一步 ACK 与状态变化等待，另有新轮次同时启动，旧批次均未下发第二步。 |
| Fusion 浏览器响应带出内部凭据 | 内容与任务详情按公开字段投影 binding，审计事件按公开字段构建。占位 MCP token 在存储中可读，在摘要、内容、详情和事件投递中均不可见。 |
| Codex 后台聊天保存可跟随项目内的外部符号链接 | 保存复用 OpenCode 的 canonical 路径校验，以后台会话工作区为准。临时目录测试覆盖项目内保存、拒绝经符号链接写入外部，以及整机编辑器仍可写同一外部文件。 |
| 后台电脑断线会重置前台队列编辑 | 队列编辑按发起电脑和选区关联。双电脑 Codex VM 用例验证 B 等待保存回执时 A 断线，B 的草稿和按钮状态保持，原回执仍可结算。 |

原有 113 项确定性回归全部保留。独立审查新增的 10 项和 Fusion v2 数字选项重启回归均已常驻，隔离 HOME 下最终 **124 项通过**：SEND 31、CORE 18、PHONE 21、ADAPTER 11、FUSION 24、FRONTEND 10、TOOLS 9。静态检查通过，覆盖 213 个脚本的语法、91 个请求类型、84 个事件类型、196 个页面助手导出及 164 个模块导入。语法子进程使用临时预加载忽略标准输入，以适应本轮沙箱。 `git diff --check` 通过，`npm run qa:browser -- --list` 加载 201 项。

[v516 的配对 Chrome smoke](../../_shots/browser-tests/2026-11-23T00-48-57-583Z-linux/report.md) 记录 7 通过、7 失败、43 阻塞、132 未运行、12 手动。7 个失败均触发 harness 旧字段 `navigationPending`，对应的三个 harness 文件此前已改读 `selectedConversation.navigation`，等待协调方重跑。阻塞项缺少 Cursor、Devin、OpenCode 空闲会话或长对话样本。本轮只加载场景清单。v517 的真实配对回归、Android 构建及真机、Windows 构建及运行仍是合入前的验收项。

### Fusion v2 问卷选项写读契约修复（2026-11-23）

原本 ask_user 能把数字或布尔选项原样存入 questions[].options，FusionStore 重启读取却只允许字符串，导致成功写入的工作台被错误隔离。现在：

- 新输入使用 normalizeFusionQuestionOptions 校验至多 64 项的非空字符串、有限数字或布尔值，写入前转换为文字标签；无效结构在状态变更前拒绝。
- 旧 v2 分片已存的有限数字或布尔选项按原值读取，不改写原始字节；嵌套对象继续被隔离。
- 永久回归测试覆盖生产 ask_user、原子存储、重启加载、无效输入不变更状态，以及旧 v2 分片字节不变。Fusion 24/24 和完整回归 124/124 通过。

真实 Chrome QA 和残留发布门槛见 docs/testing/refactor-v517-unified-qa-20261123.md。Fusion 原生派工、Android/Windows 平台仍需具备自有可控原生环境，不能把确定性测试当作完整实机验收。

## 分阶段迁移

| 阶段 | 状态 | 迁移顺序、完成条件及回滚边界 |
| --- | --- | --- |
| M0 记录基线 | 已完成 | 以 `2db4744` 追踪发送、停止、绑定变化、所有原生回执和手机端回放。记录协议、浏览器目录、故障证据和边界。文档可独立回退。 |
| M1 SEND 生命周期 | 代码已实现，待端到端验收 | 先固定按设备登记及回执形状，再将准入选区、取消和提交边界移到 SEND owner，逐个接入原生入口，最后验证原生证据和重复交付。注册表、WS 集成及其适配器调用点作为同一回滚单元。 |
| M2 WebSocket 调度与恢复 | 代码已实现，待配对验收 | 生产签名 WS 测试覆盖导航屏障、问题和图片顺序、停止、换线、迟到回执、过期和授权撤销。调度、恢复与投递租约作为同一回滚单元。 |
| M3 Session 与选择 | 代码已实现，待配对验收 | 定向覆盖 A→B→A、项目导航、候选窗口失败、Codex 同 thread owner 与 OpenCode 首次提交。绑定记录与 Session 导航模块联动回滚。 |
| M4 Android 手机控制与工具生命周期 | 代码已实现，待 Android 编译和配对验收 | Registry、传输和动作调度作为 Relay 回滚单元。Android 与 PWA 保留 v3 基线协议，可单独回退。 |
| M4B Agent Adapter 与原生能力 | 代码已实现，确定性验证通过，待配对验收 | 按 app 和传输登记能力。注册、Context 服务装配及路由接入作为同一回滚单元。 |
| M5 Fusion 编排与恢复 | 代码已实现，确定性验证通过，待配对验收 | Store、运行时、Controller、Agent、原生 provider 和投影一起回滚。v2 分片沿用原格式。回退前先核对有提交或停止 intent 的在途轮次。 |
| M6 PWA 模块化与来源绑定 | 代码及确定性验证已完成，待配对验收 | PWA 模块与 v517 缓存一起回滚。文件、终端和回执字段与旧客户端兼容。协议迁移、跨进程恢复及部署另行处理。 |

M1 至 M3、M4B 与 M5 无强制落盘迁移。部署或回退会重建进程内注册表。切换版本前需核对在途发送的原生状态，尤其是尚在等待回执的请求。

## 回归矩阵

| 范围 | 定向覆盖 | 配对验收 |
| --- | --- | --- |
| 登记、回放和隔离 | 重复 ID、不同设备、已完成淘汰、选择性查找、按 kind 筛选、旧版订阅、事件修订与终态 | 既有 `connection.reconnect`，恢复后核对同一条消息和原草稿 |
| Cursor 与 Devin | 提交前取消、CDP 发送超时后确认、Devin 队列回执、会话 A/B 隔离 | 普通发送、`execution.queue-delivery`、`execution.queue-now`、`execution.stop` 和 `execution.generating-navigation`，核对图文草稿与附件 |
| Codex 窗口与后台 | 窗口原生回执匹配、重连后回执、后台 writer 准备取消、后台队列 RPC 延迟回执 | 普通发送、自然队列、立即发送、停止，分别核对窗口路径与后台路径 |
| OpenCode | 导航取消未提交 SEND、POST 传输错误后原生 message ID 对账、计时器清理 | 普通发送、首次创建会话、命令和附件回执、切换会话、重连 |
| 共用边界 | 语法、协议、注入助手导出及浏览器场景目录 | Linux 和 Windows 配对设备的受影响功能。Fusion、其他本机写操作和原生壳由各自范围的回归确认。 |

M1 的 `npm run test:send` 两套件均通过。逐文件确认 `send-lifecycle.test.mjs` 13 项、`review-regressions.test.mjs` 15 项。`npm run test:core` 通过 18 项 M2/M3 确定性回归。签名假 socket 经生产 WebSocket 升级、鉴权、调度和路由入口，适配器用假 CDP 或原生传输控制异步时序。测试使用 worktree 下的独立 home。

`npm run check` 在当前沙箱为语法子进程忽略标准输入后通过。临时预加载只调整子进程 stdio，检查内容相同。`node scripts/browser-tests/run.mjs --list` 加载 201 项场景。真实配对浏览器、Android 真机和 Windows 待验，`scripts/page-exports.json` 沿用原快照。

## 限制

- SEND 淘汰标记仍驻留在 Relay 内存，并随进程内已见 SEND 增长。v514 客户端的 ID 缺少可验证的签发时间，删除标记后 Relay 无法区分过期重放和首次提交。对可拒绝过期重放的客户端另行设计可选的准入契约或持久索引迁移，再为该范围设置保留上限。进程重启后的旧 ID 和缺少 `operationId` 的请求需要核对原生记录。
- Cursor/Devin 的确认读取是有限的。原生页面内部在队列创建后报告错误的情况仍依赖 app 的队列证据，仍待原生适配器专项验收。任务的真正完成仍由原生 app 跟踪。
- 真实 CDP、后端服务及同时操作的本机桌面会影响时序。本轮的确定性验证覆盖 relay 边界和原生适配器，真实客户端布局、外部桌面交互和平台差异待验。


## 2026-11-23 v517 统一审查收尾

- 独立代码审查识别的三个 P1 已修复：Fusion 概览白名单剔除 `main.creations[].mcp`，Fusion `finish.evidence` 在提交前逐项校验，Codex 桌面迟到 SEND 回执包含精确 `consumedUploadIds`。
- 临时生产路径测试确认 Fusion canary token 不外泄、非法尾随 evidence 不落盘且合法记录可重启读取、Codex Desktop 原生 Matcher 只消费原发送文件。原模块回归合计 124 项通过；具体测试和残余约束见忽略目录 `_shots/full-refactor/v517-final-validation.md`。
- 重新加载隔离 Relay 3949 的 v517 代码后，配对浏览器关键闭环 5/5 通过。共 43 项不同场景最后结果 37 通过、6 前置环境/样本受阻、0 当前失败。
- 按仓库 `AGENTS.md`，一次性确定性验证脚本在 `_shots` 执行后删除，开发阶段的常驻 `scripts/node-tests` / `test:*` 入口不纳入合入候选。日志和带资源清理状态的浏览器报告保留。
- Fusion 真实 Controller 无法连接、Android 缺 JDK17/SDK/AGP 离线依赖、Windows 与 Android 真机未验收、v514↔v517 双向实际客户端兼容性未执行。**当前仍为隔离验证版，不应宣称全平台发布完成**。

最终交付清理：仓库规定不保留常驻 mock/unit 测试，开发阶段的 `scripts/node-tests/` 和 `test:*` 临时入口已清理；本次测试名称、数量及结果可查 `_shots/full-refactor/` 日志。可在完整原生环境中用现存 `npm run qa:browser` 重新执行业务验收。
