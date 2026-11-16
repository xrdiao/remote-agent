# 当前检查范围

2026-11-16：按用户确认，删除全部 32 个旧测试套件、浏览器执行器模拟测试及 page/Fusion/Office 共用夹具。功能验收只保留配对浏览器场景，精确时序或协议验证仅允许本轮 `_shots/` 临时夹具，用后删除。语法、协议及 page exports 属于静态检查，继续保留。`npm test` 指向配对浏览器，旧的全量和 Codex 单套入口已移除。

Office 场景使用 `--targets` 运行时文档，缺少文档记为 blocked。浏览器通过不等于手机或另一平台通过。删除清单和本轮证据见 `_shots/locks-permissions-20261116/`。

v483 会话管理定向场景增加：`sessions.native-created`（空会话原生目录）、`sessions.id-read`（Devin 未展开会话按 ID 读取）、`sessions.archive`（Codex/OpenCode 原生归档）、`models.codex-permissions`（三种权限实际回读）。`composer.codex-writer` 覆盖桌面写入者三种权限、完全访问原生确认、重命名和归档收尾。Devin 队列检查使用原生消息 ID，涵盖取回、自然执行、立即发送和停止。执行结果与未验平台见 `VALIDATION.md` 和 `_shots/session-management-20261116/`。

下文为历史审计记录，提到的“保留套件／夹具”已由上述规则取代，不再是可执行检查入口。

---

# 浏览器与关键回归的分工／本轮精简记录

基线：2026-11-15，HEAD `51452bd`，保留开始时已有的测试文件未提交修改。浏览器目录负责真实界面操作；现有关键测试负责竞态、原生协议、持久化与失败边界。`qa:browser -- --list` 只检查场景目录加载，不替代任何行为验收。

| 关键行为 | 保留检查 | 浏览器覆盖与边界 |
| --- | --- | --- |
| 延迟回执、新旧草稿、A/B／电脑隔离、重复提交 | `codex-submit.test.mjs`、`codex-backend.test.mjs`、`computer-switch.test.mjs` | `composer`、`execution`；真实界面正常流程不能代替精确竞态 |
| owner／follower、目录、新建与分叉、连接恢复 | `session-lifecycle.test.mjs`、`project-windows.test.mjs`、`session-status.test.mjs`、`codex-backend.test.mjs` | `sessions`、`overview`；另一系统和多个原生窗口仍须实机 |
| 原生问题读取、回答、请求去重和过期隔离 | `session-lifecycle.test.mjs`、`codex-backend.test.mjs`、`structure-fixes.test.mjs` 中相关行为 | `questions`；未执行的手机回答不得算通过 |
| Codex 差异统计、上下文裁剪、新建／删除／未知数据 | `codex-diff.test.mjs`，以及后台和注入读取入口的关键回归 | `conversation.codex-diff`：独立测试会话真实写文件，读取原生修改条目并展开差异 |
| 文件归属、失败保留、重启及撤销设备清理 | `shared-contracts.test.mjs`、`auth-storage.test.mjs`、`file-actions.test.mjs` | `files` 的真实编辑和双向哈希不代替 IO／所有权失败边界 |
| PTY 目录、订阅身份、退出释放、密码不回显 | `terminal-service.test.mjs`、`platform-rules.test.mjs`、`windows-runtime.test.mjs` | `terminal`；真实 Windows PTY 与手机选择复制仍单独验收 |
| 认证、配对、2FA、限流和密钥持久化 | `auth-storage.test.mjs`、`pairing-flow.test.mjs`、`ratelimit.test.mjs` | `connection` 不撤销用户既有身份，不伪造安全场景通过 |
| Fusion 绑定、调度、审阅、停止、恢复、预算和持久化 | `fusion-store/control/runner/scheduler/agent/cost/navigation.test.mjs` | `fusion` 的基本闭环不代替所有复杂编排 |
| 发送背压、缓存边界、诊断隐私和资源释放 | Codex/OpenCode 更新检查、缓存检查、诊断与语音资源检查 | 保留关键断言；本轮不测语音真机 |

## 上一轮三文件精简记录

1. `structure-fixes.test.mjs`：移除仅模拟固定页头几何和精确 style 写入的整项测试及专用局部环境；移除圆环半径、旋转角、dasharray 等几何断言。保留百分比方向、未知值、电脑／会话归属。诊断样本不再要求固定像素和固定采样节点排列，仍验证不读取输入、不泄露身份、不改变页面、停止后释放资源。
2. `fusion-navigation.test.mjs`：移除卡片 HTML/class／按钮排列和各状态相同形状的重复断言；保留真实主会话导航身份、原状态不被改写及错误信息可见。
3. `terminal-service.test.mjs`：移除纯屏幕缩放 style 的整项模拟测试；移除“更多”菜单必须恰好两个按钮的实现形状断言。保留刷新使用原终端 ID、无终端时读取列表、密码归属与清空、PTY 和订阅生命周期。

本轮删除两项纯布局测试及其专用局部环境，缩减其余上述实现形状断言。没有删除整个关键套件，也没有将失败用例从入口中排除。共用夹具只要仍用于关键检查就保留；该阶段尚未覆盖其余文件；后续全目录清理结果见下文。

## 两条浏览器失败的核实结果

- **Codex CWM active writer**：该线程登记在正式 relay 的 `codex-backend.json`；隔离 QA 的登记中没有它。桌面端仅保留其元数据，没有 owner／follower 角色。QA 和正式服务各有一个 app-server，QA 再 resume 同一正式线程会触发原生单写入者限制。这次测试现象不足以支持修改产品的接管逻辑；未强制接管、重试 resume、杀正式进程或新增窗口。原生写入者选择及正常 owner／follower 检查继续保留。
- **Cursor 目录缺失**：真实原生 header 为 `workspaceIdentifier.id = empty-window`，是无项目历史。服务端现允许空根目录，并按原生会话身份打开；不会拿当前窗口目录作为该会话目录。有项目时，加载态只有工作区 ID 而持久化 header 有匹配 URI，也能正确解析；ID 不匹配仍报错。

本轮真实证据保存在 `_shots/confirmed-review-fixes-20261115/`。手机、Windows、第二电脑及正式 relay 更新后的验收，均与本机 QA 浏览器结果分开记录。

## 本轮实际验证与追加修复

- Codex 后台关键套件 67 项通过；最终问题读取／回答、归属和精简后断言的定向检查 14 项通过；差异解析专项 3 项通过。注入脚本编译和 196 个导出契约通过，导出快照未修改；`qa:browser -- --list` 已执行。没有运行全量检查。
- 独立 Codex 测试会话真实修改旧文件并新建两行文件，页面差异详情合计 `+3/-1`，远处未修改行未展示；对应浏览器场景断言通过。该次自动返回收尾被控件遮挡，原失败记录保留；随后通过既有浏览器手动归档本轮会话，清理及恢复确认无错误。不能把该次运行整体标成通过。
- 此前失败的 Cursor 无项目历史，卡片和正文都实际打开。服务端明确返回空项目名；用户确认追加后，前端两处项目名赋值均保留空字符串，新版 `net.js?v=474` 的实际浏览器读取确认 `currentProject === ''`。
- 真实 CWM 会话中的保留问题已由修复后的原生读取带出，含原选项和输入字段；后台桥接、身份去重、绑定上下文回答和订阅释放有关键回归。没有代用户回答已有问题，手机实际回答仍待用户在正式服务更新后验收。
- 竖屏发送准备的早期复测未通过：首次发送之后，前端 epoch 已变为本轮请求 ID，后台仍为空，新草稿被忽略。用户确认追加后，后台提交入口与通用入口一样采纳本轮 epoch；新增关键回归验证真实发送分支之后的新草稿和回执，并继续拒绝旧 epoch。该回归与既有跨入口草稿隔离检查共 2 项通过。
- 用户已确认的三项追加均已完成：`package.json` 将 diff 专项加入原测试入口；`app/js/net.js` 保留空项目名称并同步引用版本；`server/apps/codex.mjs` 补齐后台发送的 epoch。语法、测试入口、版本引用及差异空白检查通过。
- 补验记录在 `approved-three-browser/`：Cursor 空项目名通过；竖屏真实生成的 diff 分项再次通过（`+3/-1`，两份文件）。随后脚本未展开自动收起的输入框，控件点击和收尾超时；临时脚本报告还缺少 `refs` 元数据，原失败结果保留。通过真实界面展开输入框后，新草稿回执 `revision=8/ack=8`、epoch 长度 32、待发送数 0，清空也获回执；`followup-draft-cleanup.json` 确认测试会话已归档，清理无错误，并恢复 Cursor 空项目名、空草稿的主页。不能将原自动运行整体标成通过。

当前工作区前端版本 v474；正式 relay 未重启，未提交、推送或发布。

## 全目录清理（用户确认后的本轮）

基线为本轮清理前的当前工作区，快照保存在 `_shots/fixture-cleanup-20261115/before/`，不是与 HEAD 混算此前的产品修复。已逐项检查全部 32 个旧套件，包括循环生成的测试。

删除 185 个独立用例、15 组矩阵中的 45 个用例，以及混合矩阵的 4 个普通变体，共 **234 个运行用例**。混合测试只保留原生协议、时序、失败/资源等断言；没有通过 skip、删失败断言或改入口掩盖关键失败。

本轮 21 个旧测试文件实际改变，测试文件净减少 2893 行。共用 page/Fusion 夹具和文档样本仍被保留检查使用，继续保留；按引用清理未使用的辅助函数、导入及专用正文构造。32 个套件均仍有必要的保留检查，package.json 中没有应删的整文件入口。

### 逐文件结果

| 文件 | 删除运行用例 | 保留的非浏览器边界 | 浏览器替代/待验 |
| --- | ---: | --- | --- |
| `scripts/auth-storage.test.mjs` | 0 | 身份稳定、磁盘异常、撤销设备的上传回收 | connection（身份和磁盘失败仍保留关键检查） |
| `scripts/codex-backend.test.mjs` | 8 | 原生协议、写入者、回执/草稿竞态、背压、重试与统计归属 | composer.send、conversation.history/details、models.read/change、sessions.project/fork |
| `scripts/codex-context-cache.test.mjs` | 0 | 并发读、精确失效时间、淘汰和不完整日志 | 保留缓存并发、签名及淘汰边界 |
| `scripts/codex-diff.test.mjs` | 1 | 新建/删除的编码及空文件、未知/混合字段的数据边界 | conversation.codex-diff |
| `scripts/codex-submit.test.mjs` | 25 | 原生模块发现、序列化回执、拒绝/取消及队列确认身份 | composer.send/long-history/image-only/queue、execution.queue-*；Max 成功流程见 models.settings 待验 |
| `scripts/computer-switch.test.mjs` | 14 | 乱序、换连接、身份撤销、心跳精确预算和请求归属 | overview、connection、terminal.return-chat；多电脑普通流程待实机 |
| `scripts/devin-submit.test.mjs` | 5 | 原生请求身份、过期问题、后台租约、空闲时收到旧队列意图 | composer.queue、execution.queue-*、questions.answer |
| `scripts/file-actions.test.mjs` | 4 | 目录/链接边界、失败原地保留、部分操作结果、图片持久化和 HTTP 错误 | files.operations、files.download、files.transfer-upload；跨电脑传输待实机 |
| `scripts/fusion-agent.test.mjs` | 7 | 原生工具通道、授权、租约、并发 Worker、准确轮次和项目失败 | sessions.rename、composer.image-only、questions.answer；特殊消息/公式仍待样本 |
| `scripts/fusion-control.test.mjs` | 1 | 管理权限、原子校验、依赖、预算、审阅、证据和多视图隔离 | fusion.management（混合测试仅留持久化/外部电脑拒绝） |
| `scripts/fusion-cost.test.mjs` | 1 | 原生模型/价格来源、单位、预算保留、过期缓存及未知值 | Fusion 模型档位菜单（待完整浏览器样本） |
| `scripts/fusion-navigation.test.mjs` | 17 | 迟到回复、结束结果确认身份、订阅和多请求字段归属 | fusion.catalog/create/navigation/management；长按取消/任务字段刷新待验 |
| `scripts/fusion-runner.test.mjs` | 1 | 原生收尾、审阅并发、依赖、停止、恢复和事件确认 | fusion.main-direct |
| `scripts/fusion-scheduler.test.mjs` | 0 | 并发配额、阻塞依赖、队列和停止释放 | 无普通界面删除项 |
| `scripts/fusion-store.test.mjs` | 0 | 持久化别名、恢复、损坏及失败写入不变性 | 无普通界面删除项 |
| `scripts/opencode-attachments.test.mjs` | 0 | 文档原始字段、中文/编码、公式、格式拒绝 | 无普通界面删除项 |
| `scripts/opencode-client.test.mjs` | 0 | 分页游标、SSE 分块、UTF-8、取消及原生 HTTP 参数 | 无普通界面删除项 |
| `scripts/opencode-launch.test.mjs` | 6 | 实际子进程启动/日志、并发启动和迟到元数据归属 | 电脑 Agent 管理及首次启动（待对应停止/冷启动样本） |
| `scripts/opencode-session.test.mjs` | 3 | 取消、发送确认、背压、附件失败和原生游标/缓存 | sessions.project、models.read/change；选中会话归档由清理流程核对 |
| `scripts/opencode-state.test.mjs` | 3 | 快照/增量合并、自动审批去重、原生计数、持久化模式和数据裁剪 | overview.card、conversation.details、questions.answer |
| `scripts/pairing-flow.test.mjs` | 0 | 认证/2FA、加密入口、过期请求、取消和配对所属 relay | 无普通界面删除项 |
| `scripts/platform-rules.test.mjs` | 0 | 两平台路径/URI/文件名、符号链接及上传越界 | 无普通界面删除项 |
| `scripts/project-windows.test.mjs` | 4 | 窗口租约、实际进程、未知路径、并发收藏和关闭失败 | overview.favorite、sessions.project；原生窗口回收普通流程待验 |
| `scripts/ratelimit.test.mjs` | 0 | 精确时间边界、全局/IP 限制及可信来源 | 无普通界面删除项 |
| `scripts/session-lifecycle.test.mjs` | 17 | 原生请求 0、取消/归档、写入者、冷启动/部分头、归属及时序 | sessions、overview、models、questions；空项目样本上轮已实测 |
| `scripts/session-status.test.mjs` | 0 | 跨重载持久化、电脑/轮次隔离及未知状态 | 无普通界面删除项 |
| `scripts/shared-contracts.test.mjs` | 0 | Swift/协议字段、上传资源和 Pages 身份/提交边界 | 无普通界面删除项 |
| `scripts/structure-fixes.test.mjs` | 107 | 迟到/重复操作、原生字段、采样边界、缓存、资源释放、隐私及平台规则 | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/terminal-service.test.mjs` | 6 | PTY 读取边界、订阅、断开释放、不回显和活动进程拒绝补全 | terminal.command/return-chat/fold；选择复制、Tab 和前台输入列为 terminal.selection 待验 |
| `scripts/thinking-cache.test.mjs` | 0 | 共享历史、上下文隔离、读失效及监听释放 | 缓存上下文和失效时序保留，移除字段存在性断言 |
| `scripts/voice-runtime.test.mjs` | 0 | GPU 查询、进程启停、超时、并发使用及资源释放 | 无普通界面删除项 |
| `scripts/windows-runtime.test.mjs` | 4 | 盘符/UNC、启动发现、cmd 参数、原生协议和 Windows PTY | Windows 原生服务、菜单和磁盘列表 UI 待 Windows 浏览器验收 |

### 验证结果与尚未执行的验收

- 首轮实际变更的 21 个关键套件：999 项通过、13 项平台跳过、2 项失败。分叉测试收缩时遗漏失败回执，已改为验证 `clickDone/false` 和原选择；Devin 旧断言仍假定 Ubuntu 没有模式，已改为验证当前绑定 A/B 的原生模式。两项定向复查通过，关键测试均保留。
- 矩阵及辅助函数清理阶段四个套件 528 项通过；最后再移除 Max 正常成功的两个变体，仅对保留的两个缺失/清理边界复核通过。Devin 乐观消息和 A/B 归属共用夹具精简后另有 2 项定向通过。已经通过且不受后续删除影响的其余检查未重复运行。
- 浏览器执行器的 3 项关键检查及 `npm run qa:browser -- --list` 通过。新增/增强的普通断言进入既有分区：输入折叠、发送后草稿/历史、完整统计字段、整数百分比、历史页上限、问题草稿、文件操作和工作台管理。
- 本机既有配对浏览器实际完成 `files.operations`：复制、同名另存/跳过/覆盖、移动、中文 ZIP 和空目录往返，磁盘内容逐字核对通过。
- `files.invalid-path` 初次错误地要求清空目录缓存和禁用上一级；原规则会保留最后成功目录供相对路径/上一级重试。这两条属于对实现的错误假设，已纠正为真实可见结果：旧文件行不可点击、错误可见、返回有效目录恢复。最终实测通过，原失败报告保留。
- 浏览器两次有效检查均恢复原配对、原 Cursor 目标、主页和空草稿，清理记录无错误。无模型生成、无新配对；语音、真实手机、Windows、多电脑以及新增加的其他流程未执行，不能记为通过。
- 产品代码、AGENTS.md、检查器和 page 导出快照与清理前哈希逐项核对；本轮没有修改它们，也没有重启正式 relay。未运行 npm run check/check:full、未提交或推送。

证据：`_shots/fixture-cleanup-20261115/affected.tap`、`corrections.tap`、`matrix-followup.tap`、`devin-fixture.tap`、`browser-runner.tap`；真实浏览器报告为 `_shots/browser-tests/2026-11-15T02-47-02-539Z-linux/`（文件操作通过，含最初错误路径断言失败）和 `_shots/browser-tests/2026-11-15T02-58-08-081Z-linux/`（修正后的错误路径通过）。

### 逐项删除清单

以下只表示旧夹具已移除及其对应的浏览器区块；上表和报告中的待验状态继续有效，**不代表这些浏览器场景已经全部执行**。

| 原文件 | 移除的测试或矩阵 | 对应浏览器区块/待验 |
| --- | --- | --- |
| `scripts/codex-backend.test.mjs` | backend history appends 160 items while the initial view remains 40 | composer.send、conversation.history/details、models.read/change、sessions.project/fork |
| `scripts/codex-backend.test.mjs` | backend model menus read native options, mark the selected model, and never mutate settings | composer.send、conversation.history/details、models.read/change、sessions.project/fork |
| `scripts/codex-backend.test.mjs` | backend @ search uses the selected project and keeps distinct full paths; slash skills stay native | composer.send、conversation.history/details、models.read/change、sessions.project/fork |
| `scripts/codex-backend.test.mjs` | opening a Codex project resumes its latest backend thread; new-session explicitly creates one | composer.send、conversation.history/details、models.read/change、sessions.project/fork |
| `scripts/codex-backend.test.mjs` | creating in project B reads back native cwd and never changes project A | composer.send、conversation.history/details、models.read/change、sessions.project/fork |
| `scripts/codex-backend.test.mjs` | fork actions identify completed turns and appear only on their final assistant message | composer.send、conversation.history/details、models.read/change、sessions.project/fork |
| `scripts/codex-backend.test.mjs` | 'Codex new entry with native window creates rather than loading a directory as UUID: ' + IS_WIN（循环矩阵） | composer.send、conversation.history/details、models.read/change、sessions.project/fork |
| `scripts/codex-diff.test.mjs` | Codex diff keeps edits with three context lines, not the entire after-image | conversation.codex-diff |
| `scripts/codex-submit.test.mjs` | Codex bound inner realm writes the visible native editor using its existing transaction | composer.send/long-history/image-only/queue、execution.queue-*；Max 成功流程见 models.settings 待验 |
| `scripts/codex-submit.test.mjs` | Codex multiline and long input validates its native payload instead of layout paragraph separators | composer.send/long-history/image-only/queue、execution.queue-*；Max 成功流程见 models.settings 待验 |
| `scripts/codex-submit.test.mjs` | Codex image-only drafts read the current native attachment flag independently of empty text | composer.send/long-history/image-only/queue、execution.queue-*；Max 成功流程见 models.settings 待验 |
| `scripts/codex-submit.test.mjs` | Codex queue edit status reflects immediate execution without changing Devin take-out | composer.send/long-history/image-only/queue、execution.queue-*；Max 成功流程见 models.settings 待验 |
| `scripts/codex-submit.test.mjs` | `native submit keeps the original ${follow \|\| 'default'} action with ${chinese ? 'Chinese' : 'English'} controls, dispatch=${dispatch}`（循环矩阵） | composer.send/long-history/image-only/queue、execution.queue-*；Max 成功流程见 models.settings 待验 |
| `scripts/codex-submit.test.mjs` | `Codex ordinary draft writes all ${value.split('\n').length} lines through one existing editor transaction`（循环矩阵） | composer.send/long-history/image-only/queue、execution.queue-*；Max 成功流程见 models.settings 待验 |
| `scripts/codex-submit.test.mjs` | `${app} draft reads retain their immediate native read`（循环矩阵） | composer.send/long-history/image-only/queue、execution.queue-*；Max 成功流程见 models.settings 待验 |
| `scripts/codex-submit.test.mjs` | `${app} sends keep their existing path without the Codex submission wait`（循环矩阵） | composer.send/long-history/image-only/queue、execution.queue-*；Max 成功流程见 models.settings 待验 |
| `scripts/computer-switch.test.mjs` | selection messages without appName keep the connected application display name | overview、connection、terminal.return-chat；多电脑普通流程待实机 |
| `scripts/computer-switch.test.mjs` | ready computer switches onto its existing session and can send immediately without boot/auth/attach | overview、connection、terminal.return-chat；多电脑普通流程待实机 |
| `scripts/computer-switch.test.mjs` | drafts and draft epochs stay with their computers through repeated switches | overview、connection、terminal.return-chat；多电脑普通流程待实机 |
| `scripts/computer-switch.test.mjs` | a paired cold start and connection failure never open a full-page gate | overview、connection、terminal.return-chat；多电脑普通流程待实机 |
| `scripts/computer-switch.test.mjs` | authorization failure stays in the computer row until authorization is explicitly requested | overview、connection、terminal.return-chat；多电脑普通流程待实机 |
| `scripts/computer-switch.test.mjs` | connection diagnostics use B address and retain A selection and content | overview、connection、terminal.return-chat；多电脑普通流程待实机 |
| `scripts/computer-switch.test.mjs` | connection details show only the requested computer history after auth clears the current failure | overview、connection、terminal.return-chat；多电脑普通流程待实机 |
| `scripts/computer-switch.test.mjs` | card opening from a terminal switches to chat and waits for its own fresh first screen | overview、connection、terminal.return-chat；多电脑普通流程待实机 |
| `scripts/computer-switch.test.mjs` | card navigation preserves the old terminal and the separate chat and terminal drafts | overview、connection、terminal.return-chat；多电脑普通流程待实机 |
| `scripts/computer-switch.test.mjs` | terminal card navigation enters a Fusion native main conversation and clears its controller on ordinary exit | overview、connection、terminal.return-chat；多电脑普通流程待实机 |
| `scripts/computer-switch.test.mjs` | a ready expanded card still confirms the native target instead of reusing an already resolved binding | overview、connection、terminal.return-chat；多电脑普通流程待实机 |
| `scripts/computer-switch.test.mjs` | Codex cards confirm even the last ready target through one existing session request | overview、connection、terminal.return-chat；多电脑普通流程待实机 |
| `scripts/computer-switch.test.mjs` | unready, other-window, project restoration and other-Agent cards retain their normal binding path | overview、connection、terminal.return-chat；多电脑普通流程待实机 |
| `scripts/computer-switch.test.mjs` | a Codex card adopts the destination computer before choosing its same or different conversation | overview、connection、terminal.return-chat；多电脑普通流程待实机 |
| `scripts/devin-submit.test.mjs` | Devin queue reuses the session native callback and send-now action without ordinary submission | composer.queue、execution.queue-*、questions.answer |
| `scripts/devin-submit.test.mjs` | Devin adapter queues ordinary busy sends through the native queue action, never Enter | composer.queue、execution.queue-*、questions.answer |
| `scripts/devin-submit.test.mjs` | Devin adapter keeps Enter for idle sends | composer.queue、execution.queue-*、questions.answer |
| `scripts/devin-submit.test.mjs` | Devin answerQuestion text goes straight to the native question handler | composer.queue、execution.queue-*、questions.answer |
| `scripts/devin-submit.test.mjs` | Devin answerQuestion keeps the DOM path for option parts | composer.queue、execution.queue-*、questions.answer |
| `scripts/file-actions.test.mjs` | create, copy and move keep actual paths, contents and collision decisions | files.operations、files.download、files.transfer-upload；跨电脑传输待实机 |
| `scripts/file-actions.test.mjs` | ZIP creation and extraction preserve content, Unicode and empty directories | files.operations、files.download、files.transfer-upload；跨电脑传输待实机 |
| `scripts/file-actions.test.mjs` | file transfer has its own history and returns to its originating conversation or board | files.operations、files.download、files.transfer-upload；跨电脑传输待实机 |
| `scripts/file-actions.test.mjs` | computer entry owns browse, download, uploads, file operations and preferences without selecting it | files.operations、files.download、files.transfer-upload；跨电脑传输待实机 |
| `scripts/fusion-agent.test.mjs` | native applications share one controller creation contract and model choices remain ordinary data | sessions.rename、composer.image-only、questions.answer；特殊消息/公式仍待样本 |
| `scripts/fusion-agent.test.mjs` | Devin pending and confirmed user messages share the same body without sender, timestamp or actions | sessions.rename、composer.image-only、questions.answer；特殊消息/公式仍待样本 |
| `scripts/fusion-agent.test.mjs` | Devin pending image-only messages keep their images and no metadata becomes text | sessions.rename、composer.image-only、questions.answer；特殊消息/公式仍待样本 |
| `scripts/fusion-agent.test.mjs` | Devin pending user messages preserve inline and block formulas inside the body | sessions.rename、composer.image-only、questions.answer；特殊消息/公式仍待样本 |
| `scripts/fusion-agent.test.mjs` | Devin transcript shows an answered native question as its own human message | sessions.rename、composer.image-only、questions.answer；特殊消息/公式仍待样本 |
| `scripts/fusion-agent.test.mjs` | Devin transcript joins all answered questions and chosen options in one bubble | sessions.rename、composer.image-only、questions.answer；特殊消息/公式仍待样本 |
| `scripts/fusion-agent.test.mjs` | Devin transcript keeps ordinary user text and image-only messages intact | sessions.rename、composer.image-only、questions.answer；特殊消息/公式仍待样本 |
| `scripts/fusion-control.test.mjs` | a workbench without a native main can be named before its first native creation | fusion.management（混合测试仅留持久化/外部电脑拒绝） |
| `scripts/fusion-cost.test.mjs` | all three tiers permit every native model and leave the chosen main unchanged | Fusion 模型档位菜单（待完整浏览器样本） |
| `scripts/fusion-navigation.test.mjs` | Fusion cards navigate to the native main without changing state and expose navigation errors | fusion.catalog/create/navigation/management；长按取消/任务字段刷新待验 |
| `scripts/fusion-navigation.test.mjs` | workbench cards share ordinary long-hold cancellation and suppress the subsequent open click | fusion.catalog/create/navigation/management；长按取消/任务字段刷新待验 |
| `scripts/fusion-navigation.test.mjs` | favorite workbenches retain computer identity and reuse the Fusion card renderer beside ordinary favorites | fusion.catalog/create/navigation/management；长按取消/任务字段刷新待验 |
| `scripts/fusion-navigation.test.mjs` | opening a favorite workbench preserves its source and return position without changing other navigation routes | fusion.catalog/create/navigation/management；长按取消/任务字段刷新待验 |
| `scripts/fusion-navigation.test.mjs` | workbench menus keep required interactions unread and leave ordinary session actions unchanged | fusion.catalog/create/navigation/management；长按取消/任务字段刷新待验 |
| `scripts/fusion-navigation.test.mjs` | new requirements use the existing main composer rather than an internal inbox wake message | fusion.catalog/create/navigation/management；长按取消/任务字段刷新待验 |
| `scripts/fusion-navigation.test.mjs` | each retained worker displays its responsibility label and tasks in descending activity order without reordering stored tasks | fusion.catalog/create/navigation/management；长按取消/任务字段刷新待验 |
| `scripts/fusion-navigation.test.mjs` | Fusion titles show native model effort once and preserve ordinary titles | fusion.catalog/create/navigation/management；长按取消/任务字段刷新待验 |
| `scripts/fusion-navigation.test.mjs` | all-computer Fusion board groups runs by computer and does not pick a creation target | fusion.catalog/create/navigation/management；长按取消/任务字段刷新待验 |
| `scripts/fusion-navigation.test.mjs` | Fusion folder browsing uses the chosen computer and sends no native navigation or creation request | fusion.catalog/create/navigation/management；长按取消/任务字段刷新待验 |
| `scripts/fusion-navigation.test.mjs` | the shared project sheet retains ordinary project actions and routes them to the native destination | fusion.catalog/create/navigation/management；长按取消/任务字段刷新待验 |
| `scripts/fusion-navigation.test.mjs` | Fusion project browsing hands the shared folder picker its selected computer and complete owner | fusion.catalog/create/navigation/management；长按取消/任务字段刷新待验 |
| `scripts/fusion-navigation.test.mjs` | idle Fusion renders no permanent status row while a current block exposes only its own recovery actions | fusion.catalog/create/navigation/management；长按取消/任务字段刷新待验 |
| `scripts/fusion-navigation.test.mjs` | enabled Fusion goes straight to common navigation; unconfigured Fusion reads only configuration | fusion.catalog/create/navigation/management；长按取消/任务字段刷新待验 |
| `scripts/fusion-navigation.test.mjs` | refreshing selected task controls preserves native fields, caret, scroll and the matching open audit | fusion.catalog/create/navigation/management；长按取消/任务字段刷新待验 |
| `scripts/fusion-navigation.test.mjs` | Fusion controller software choices come from the selected computer metadata | fusion.catalog/create/navigation/management；长按取消/任务字段刷新待验 |
| `scripts/fusion-navigation.test.mjs` | Fusion navigation uses the native binding while management retains the workbench identity | fusion.catalog/create/navigation/management；长按取消/任务字段刷新待验 |
| `scripts/fusion-runner.test.mjs` | ordinary main execution needs no workbench commands, cost reservation, self Task or Assignment | fusion.main-direct |
| `scripts/opencode-launch.test.mjs` | agent detection includes OpenCode without changing the default desktop launch targets | 电脑 Agent 管理及首次启动（待对应停止/冷启动样本） |
| `scripts/opencode-launch.test.mjs` | phone Agent management exposes the OpenCode launch checkbox through the existing selection flow | 电脑 Agent 管理及首次启动（待对应停止/冷启动样本） |
| `scripts/opencode-launch.test.mjs` | the computer OpenCode entry opens a healthy service without any projects or session history | 电脑 Agent 管理及首次启动（待对应停止/冷启动样本） |
| `scripts/opencode-launch.test.mjs` | a stopped OpenCode service offers launch even when a cached project exists | 电脑 Agent 管理及首次启动（待对应停止/冷启动样本） |
| `scripts/opencode-launch.test.mjs` | the computer entry retains the selected OpenCode project and existing desktop Agent targets | 电脑 Agent 管理及首次启动（待对应停止/冷启动样本） |
| `scripts/opencode-launch.test.mjs` | the first OpenCode service binding adopts its native directory and finishes without another attach | 电脑 Agent 管理及首次启动（待对应停止/冷启动样本） |
| `scripts/opencode-session.test.mjs` | OpenCode attaches and switches native sessions without any CDP or desktop window | sessions.project、models.read/change；选中会话归档由清理流程核对 |
| `scripts/opencode-session.test.mjs` | archiving the selected native OpenCode session returns its view to an empty conversation | sessions.project、models.read/change；选中会话归档由清理流程核对 |
| `scripts/opencode-session.test.mjs` | OpenCode permission menu works before the first send and its mode stays with the native session | sessions.project、models.read/change；选中会话归档由清理流程核对 |
| `scripts/opencode-state.test.mjs` | OpenCode permissions and questions stay with their native sessions and disappear after replies | overview.card、conversation.details、questions.answer |
| `scripts/opencode-state.test.mjs` | OpenCode tool records preserve real file paths, patches, command output and errors | overview.card、conversation.details、questions.answer |
| `scripts/opencode-state.test.mjs` | OpenCode overview groups sessions by directory and excludes archived and child sessions | overview.card、conversation.details、questions.answer |
| `scripts/project-windows.test.mjs` | favorite project survives a window replacement and becomes eligible after unfavoriting | overview.favorite、sessions.project；原生窗口回收普通流程待验 |
| `scripts/project-windows.test.mjs` | an archived favorite learned from the native catalog retains its project association | overview.favorite、sessions.project；原生窗口回收普通流程待验 |
| `scripts/project-windows.test.mjs` | Fusion hides worker sessions while main sessions and shared windows remain ordinary | overview.favorite、sessions.project；原生窗口回收普通流程待验 |
| `scripts/project-windows.test.mjs` | Codex current-project optimization uses the selected native thread rather than stale cached roots | overview.favorite、sessions.project；原生窗口回收普通流程待验 |
| `scripts/session-lifecycle.test.mjs` | retry menu distinguishes backend continuation from desktop Retry clicks | sessions、overview、models、questions；空项目样本上轮已实测 |
| `scripts/session-lifecycle.test.mjs` | Devin opens the requested empty thread through the selected IDE window native main-panel command | sessions、overview、models、questions；空项目样本上轮已实测 |
| `scripts/session-lifecycle.test.mjs` | compact Devin model buttons expose the same picker as text buttons | sessions、overview、models、questions；空项目样本上轮已实测 |
| `scripts/session-lifecycle.test.mjs` | Codex opens the identified recent-chat button once despite the archive toast | sessions、overview、models、questions；空项目样本上轮已实测 |
| `scripts/session-lifecycle.test.mjs` | Codex finished changes and ordinary action buttons are not pending native requests | sessions、overview、models、questions；空项目样本上轮已实测 |
| `scripts/session-lifecycle.test.mjs` | Codex native options without an other answer stay a select field | sessions、overview、models、questions；空项目样本上轮已实测 |
| `scripts/session-lifecycle.test.mjs` | Devin standalone new chat publishes its own first screen after adoption | sessions、overview、models、questions；空项目样本上轮已实测 |
| `scripts/session-lifecycle.test.mjs` | Devin text fragments join within their native stream and retain independent paragraphs | sessions、overview、models、questions；空项目样本上轮已实测 |
| `scripts/session-lifecycle.test.mjs` | Cursor card attachment uses the session project instead of its catalog carrier window on both platforms | sessions、overview、models、questions；空项目样本上轮已实测 |
| `scripts/session-lifecycle.test.mjs` | a projectless Cursor session opens without switching to a stale project saved on its card | sessions、overview、models、questions；空项目样本上轮已实测 |
| `scripts/session-lifecycle.test.mjs` | project attachment and cold reconnect preserve the target using the native backend or desktop carrier | sessions、overview、models、questions；空项目样本上轮已实测 |
| `scripts/session-lifecycle.test.mjs` | Codex default project entry and owned background threads still use the backend | sessions、overview、models、questions；空项目样本上轮已实测 |
| `scripts/session-lifecycle.test.mjs` | Codex project and session-menu entries share the backend binding for legacy threads | sessions、overview、models、questions；空项目样本上轮已实测 |
| `scripts/session-lifecycle.test.mjs` | desktop Codex and Cursor project labels, files and new-chat target follow the selected thread rather than its carrier | sessions、overview、models、questions；空项目样本上轮已实测 |
| `scripts/session-lifecycle.test.mjs` | Devin and OpenCode preserve their native project while their carrier title belongs elsewhere | sessions、overview、models、questions；空项目样本上轮已实测 |
| `scripts/session-lifecycle.test.mjs` | `${app} retains its existing button and Question waiting behavior`（循环矩阵） | sessions、overview、models、questions；空项目样本上轮已实测 |
| `scripts/structure-fixes.test.mjs` | Markdown HTTPS links keep nested formatting and Devin external-link attributes | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Devin quota reads mounted account roots independently of unrelated editors and focus | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Devin quota respects native period visibility and formats a zero balance separately | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Codex imageView survives stored history without a mounted native turn | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Codex stored turns retain full command output and every file diff without changing pagination identity | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | terminal input reads the live prompt rather than candidate output retained by shell integration | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Codex native providers remain readable while the desktop view is hidden | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Codex state remains readable when a Question replaces the main composer | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | a stop button in message content cannot mark an idle Codex composer as running | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Codex follow-up preferences and draft facts come from the visible native add-context control | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Cursor settings root is located through its native container independently of navigation labels | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Cursor quota reads the plan container rather than its heading-only child | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Codex unified reasoning trigger supplies models, effort and service tier through the same native picker | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Cursor stop control is identified by its native state independently of the accessible label | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Devin translated controls share the native translation keys for new session, queue and workdir | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Ubuntu Devin settings navigation reads the native translated section names | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Codex slash Send uses the same native command choice as its suggestion button | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Cursor and ordinary Codex messages keep their send path | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | the restored terminal textbox delegates once without creating a chat submission | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | running card model metadata retains its effort next to the model | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | completed Codex file changes remain expandable when ordinary execution records are hidden | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | the Codex backend acknowledges an explicit empty draft and retains the empty state when reopened | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | replacing updated messages above the viewport preserves the current reading offset | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | an updated message spanning the viewport can grow without moving its reading position | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | prepending older history retains the reading position even when message nodes are replaced | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | history insertion and earlier message growth preserve the same reading offset together | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Cursor native text fills the virtualized body and updates existing replies without replacing tool actions | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | confirmations unrelated to a conversation retain their existing behavior | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | an ordinary card input still reflects the shared draft after composition | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | cards retain editing while a draft is in flight and keep their shared input tools | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | direct send actions keep the existing disabled-button behavior | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Codex Question cards expose only skip and native next or send actions | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | MCP multi-select cards restore selected answers and submit arrays through the existing request action | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Question Enter sends the edited answer once to its own request and preserves the chat draft | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Question Enter retains approval field blur and the existing free-answer fill action | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Devin question card offers a dedicated text answer only when the native question allows it | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Devin question draft survives re-renders with focus and selection intact | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | card input tools retain the bound editor for history and newline actions | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | the shared voice caret calculation scrolls its supplied editor without changing another textarea | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | card rings share the existing context and quota percentage conversion with the header | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | OpenCode pending statistics keep every field visible and elapsed time advances without token events | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | card context keeps its header color while quota reuses remaining-usage warning colors | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | a Codex background thread visible in a native catalog has one card with its actual API carrier | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | a local Codex favorite remains available after its project window closes before backend import | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | another open project does not make an available Codex favorite dormant | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | closed-project Codex cards use current native idle and running states before backend import | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | a Codex favorite never flashes project-closed while native roots and catalog become ready | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | window-dependent favorites and Codex entries with no project path keep their existing dormant state | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Devin session projects belong to the native session even when the IDE carrier has another workspace | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Fusion workers stay outside ordinary cards while shared windows and main favorites remain ordinary | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | completed session without run id or stored completion keeps overview available | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | marking a completed card read persists locally, updates its project and allows a new completed turn | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | only completed overview cards offer a local read action without binding or managing the native session | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Codex pending requests take card and project priority until the native request clears | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | favorites and project cards share completed-running-idle ordering and aggregate mixed projects | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | collapsed landscape tools retain their action and only a blank-area click expands the composer | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | question entry folds the main composer in both orientations and releases it on blur | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | landscape retains idle automatic folding and click-to-open while preserving editing | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | chat and terminal retain independent manual folding across mode switches | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | terminal idle folding ignores retained chat attachments and question controls | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | portrait terminal stays expanded when idle and landscape preserves a non-empty command | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | terminal password entry expands the composer without losing focus and prevents idle folding | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | screen mode cannot retain chat or terminal folding | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | the two Editor entries share one browser with different initial paths and one directory read | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | typed project paths are read exactly and a failed next read cannot keep old folder actions | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | file and project browsing share completion while project choices include directories only | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | hidden entries default to hidden and the shared browser remembers the switch without refetching | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | hidden-entry completion follows the shared switch and still restricts project choices to folders | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | shared browsing opens a file on its owning computer and rejects a file as a project folder | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | computer and conversation project entries share the session opener and keep their folder starting points | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | typing a relative path during Editor initialization uses the native project as its base | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | closing a shared Editor preview returns to the same directory and scroll without rereading it | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | returning from an ordinary session action preserves the project pickers entry context | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | all entry modes retain keyboard controls without shell compensation during the recorded focusout sequences | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Cursor native image attachments survive virtualized and image-only messages | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | OpenCode live view renders its page while retaining older rows in the local history cache | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | OpenCode preview limits the current turn to 600 characters and the latest three normalized tools | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | OpenCode answer restoration preserves selected options and custom text without mixing requests | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Devin model controls prefer the native model picker over a simultaneous Normal capability picker | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Fusion native forms retain multiple selected values through repaint and use the shared field reader | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | context and quota meter percentages use integers for text, rings and accessible labels | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Codex up/down history uses confirmed original text after receipts and echoes are consumed | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | Windows Devin settings read section navigation without requiring the removed plan button | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | `Codex recent popover uses the native trigger state and content ID: ${label}`（循环矩阵） | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | `Codex busy state uses the native response flag, independently of labels and queue capability: ${busy}`（循环矩阵） | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | `permissions use native selected icons rather than trigger text, ${chinese ? 'Chinese' : 'English'}`（循环矩阵） | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | `Cursor running state follows the selected native composer, generating=${generating}`（循环矩阵） | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | `terminal reading and operation targets preserve IDs with ${chinese ? 'Chinese' : 'English'} labels`（循环矩阵） | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | `${app} take-out retains its existing input behavior`（循环矩阵） | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | `terminal folds manually without changing its draft or chat scroll, landscape=${land}`（循环矩阵） | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | `Cursor empty composer resolves services from ${selector} beyond deeply nested providers`（循环矩阵） | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/structure-fixes.test.mjs` | `image editor save retains or uploads the correct attachment: ${kind}`（循环矩阵） | overview、composer、conversation、models、execution、files、terminal、questions |
| `scripts/terminal-service.test.mjs` | Codex terminal creation uses the bound conversation project when the desktop displays another thread | terminal.command/return-chat/fold；选择复制、Tab 和前台输入列为 terminal.selection 待验 |
| `scripts/terminal-service.test.mjs` | new conversation terminals use the selection at creation instead of an earlier origin snapshot | terminal.command/return-chat/fold；选择复制、Tab 和前台输入列为 terminal.selection 待验 |
| `scripts/terminal-service.test.mjs` | terminal toolbar and more reuse one action path without duplicate writes | terminal.command/return-chat/fold；选择复制、Tab 和前台输入列为 terminal.selection 待验 |
| `scripts/terminal-service.test.mjs` | terminal tools preserve offline copy and authenticated refresh while disabling unavailable writes | terminal.command/return-chat/fold；选择复制、Tab 和前台输入列为 terminal.selection 待验 |
| `scripts/terminal-service.test.mjs` | terminal refresh keeps the current terminal identity and lists only when no terminal is selected | terminal.command/return-chat/fold；选择复制、Tab 和前台输入列为 terminal.selection 待验 |
| `scripts/terminal-service.test.mjs` | native terminal selection copies selected text and leaves a selection outside the terminal intact | terminal.command/return-chat/fold；选择复制、Tab 和前台输入列为 terminal.selection 待验 |
| `scripts/windows-runtime.test.mjs` | Cursor Windows native services become available without an agent status row | Windows 原生服务、菜单和磁盘列表 UI 待 Windows 浏览器验收 |
| `scripts/windows-runtime.test.mjs` | Cursor model dispatch shares the bound native menu on Windows and Ubuntu | Windows 原生服务、菜单和磁盘列表 UI 待 Windows 浏览器验收 |
| `scripts/windows-runtime.test.mjs` | Windows Devin surface follows shell visibility rather than a retained mode-menu tree | Windows 原生服务、菜单和磁盘列表 UI 待 Windows 浏览器验收 |
| `scripts/windows-runtime.test.mjs` | transfer UI navigates disk roots and disables parent and destination actions at the disk list | Windows 原生服务、菜单和磁盘列表 UI 待 Windows 浏览器验收 |
| `scripts/codex-submit.test.mjs` | Max 的 available=true 普通变体；保留功能缺失与原生设置恢复 | models.settings（待验） |
| `scripts/structure-fixes.test.mjs` | shared model opener 的 native/position 普通变体；保留 absent/error | models.read/change |
