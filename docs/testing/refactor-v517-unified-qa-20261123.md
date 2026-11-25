# Remote Agent v517：架构重构与统一 QA 报告

验证日期：2026-11-23
原基线：Git 2db4744，feature/ra-peer-tasks，PWA v514。
重构分支：refactor/v514-boundaries-20261122，隔离工作区位于主项目的 _shots/architecture-refactor-v514。
本次 PWA v517；Android 线上协议 agentVersion 3；Fusion 持久化格式 v2。

## 1. 实施范围

| 里程碑 | 已实施的核心边界 |
| --- | --- |
| M1 | SEND 准入、取消、原生提交、未知结果和迟到回执，以及 OperationRegistry |
| M2/M3 | WebSocket 队列/恢复，连接接管，Session Binding 与导航代次 |
| M4 | Android PhoneLink、Relay 手机 Session/Transport/Actions、Codex 手机工具生命周期 |
| M4B | Agent Adapter 能力登记与显式 Context 服务装配 |
| M5 | Fusion Store 与分片验证、原生效果回执、Journal、运行时恢复和视图投影 |
| M6 | PWA 连接/操作/会话拆分、文件与终端 SourceRef |
| 独立审查修复 | 回执附件状态、Fusion 清理恢复/损坏数据隔离、手机工具终态、安全凭据投影、后台保存目录符号链接越界、双电脑队列状态，以及 ask_user 数字选项重启问题 |

## 2. 最终确定性回归

| 命令 | 通过 | 失败 |
| --- | ---: | ---: |
| npm run test:send | 31 | 0 |
| npm run test:core | 18 | 0 |
| npm run test:phone | 21 | 0 |
| npm run test:adapters | 11 | 0 |
| npm run test:fusion | 24 | 0 |
| npm run test:frontend | 10 | 0 |
| npm run test:tools | 9 | 0 |
| **合计** | **124** | **0** |

测试从隔离 HOME 运行，含真实生产模块、假原生传输、WebSocket 接管、持久化重启、浏览器 VM 和受控故障注入。最终日志：_shots/full-refactor/final-verified/。

静态检查 npm run check 通过：213 个 JS 语法文件、91 个前端指令、84 个服务端事件、196 个注入助手、164 个模块导入和 40 个核心前端资源。git diff --check 通过。自动化场景目录共 201 项；目录加载不计为功能通过。

## 3. 已配对浏览器真实测试

实际由 npm run qa:browser 通过已配对 Chrome CDP 9335 连接隔离 Relay 3949，执行签名认证与真实工作流。使用 QA 独立身份和测试会话；正式 Relay 3939、主项目和现有用户数据未被替换。

| 测试组 | 通过 | 失败 | blocked | not-run | manual | 报告编号 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| v516 配对认证 | 1 | 0 | 0 | 0 | 0 | 00-48-41-735 |
| v516 全量 smoke | 7 | 7 | 43 | 132 | 12 | 00-48-57-583 |
| v517 Codex 读场景初测 | 4 | 1 | 3 | 0 | 0 | 01-07-00-698 |
| v517 有效样本模型菜单 | 1 | 0 | 0 | 0 | 0 | 01-09-53-552 |
| v517 实际发送与回复 | 1 | 0 | 0 | 0 | 0 | 01-10-23-140 |
| v517 真实工作流 | 6 | 0 | 2 | 0 | 0 | 01-11-21-107 |
| v517 扩展排队/停止/文件工作流 | 6 | 0 | 0 | 0 | 0 | 01-13-16-816 |

各报告位于工作区根目录 _shots/browser-tests/2026-11-23T[报告编号]Z-linux/，包括 report.md 和 results.json。对 v517 的全部配对 Chrome 报告按 (场景, Agent) 去重并采用最后一次结果：**37 通过、6 样本／环境受阻、0 当前失败**，并未将重复执行累计为新场景。修复三个 P1 后重启隔离 QA Relay，另一次 5/5 真实配对浏览器复验通过（01-30-57-962）。

真实通过的测试 ID：
- connection.ready、connection.reconnect/codex
- overview.card/codex、overview.status/codex
- models.read/codex、models.usage/codex
- composer.send/codex、composer.drafts/codex、composer.queue/codex
- execution.queue-delivery/codex、execution.stop/codex
- sessions.native-created/codex、sessions.project/codex、sessions.rename/codex
- files.editor、files.operations、files.download、terminal.command/codex

验证了实际原生提交和回复、回执、断线重连、A/B 导航、草稿、排队/停止、磁盘字节以及 PTY 输出。以上每组自动化都记录 cleanup.errors 为空，已清理测试产生的会话和终端。

### 初次失败与阻塞的解释

- v516 smoke 的 7 项 failed 来自测试脚本仍读取重构前的 navigationPending 内部变量。脚本改用新的 Selection 状态后，相应 v517 场景不再触发这个脚本错误。
- v517 空白 Codex 会话没有原生模型数据，models.read 初次无法找到被 UI 隐藏的模型按钮；在登记的有效 Codex 样本下复测 **通过**。初次失败保留在报告中，不删除。
- conversation.tasks、conversation.body、files.references 缺少相应真实任务、历史或文件引用样本，正确标记 blocked。
- fusion.create、fusion.navigation 因 QA 隔离环境没有可安全控制的主 Agent 原生窗口而 blocked。确定性 Fusion 测试通过不等于真实 Fusion 浏览器闭环通过。
- Cursor、Devin 和 OpenCode 在本次 QA 主机上没有监听对应原生端口。没有擅自使用可能退出/覆盖已有桌面的启动脚本，故其他 Agent 的真实测试缺失。
- Android Java 离线编译受到 JDK11、所需 JDK17 和 Gradle/SDK 缓存依赖限制；没有 Android 14+ 投屏/无障碍实机，也没有 Windows ConPTY 实测。不能称之为通过。

### 2026-11-23 最终 P1 纠偏

- Fusion HTTP 概览改用 main 公开字段白名单，修复 Devin MCP token 随 overview 投影泄露；模拟 canary token 经过真实 `fusionSummary` 序列化不再出现（2 项定向 Fusion 测试之一）。
- Fusion `finish.evidence` 在匹配 criteria 前完整校验每条证据：非法尾随 null 拒绝、状态和磁盘不变；有效 payload 写入并重新加载成功（2 项定向 Fusion 测试之一）。
- Codex 桌面原生迟到发送回执返回精确 `consumedUploadIds`，不误消费刚上传的 A 文件、B 文件或已删除文件；18 项临时生产路径回归通过。
- 修复后 4 个模块重验：Fusion 24/24、SEND 31/31、PWA 10/10、Adapter 11/11，静态检查及 diff-check 通过。详细日志在 `_shots/full-refactor/final-check/`。
- `scripts/node-tests/` 与 package.json 的七个 `test:*` 入口仅用于本轮临时研发验证；按仓库 `AGENTS.md` 已在验收后清理，保留测试报告和日志。正式功能验收仍使用既有 `npm run qa:browser`。

## 4. 残留风险与部署结论

1. 为避免已提交 SEND 的旧 operationId 被重新执行，进程内保留已淘汰 SEND ID；长期运行可能随累计发送数增加内存。安全的过期/持久拒绝机制需要单独设计，不能简单删除去重记录。
2. Android、Windows、Cursor/Devin/OpenCode 原生工作流以及真实 Fusion 主控派工和审阅尚有环境缺口，后续必须以自有测试设备和原生窗口补充。
3. 本次为独立分支上的代码与自动化验收，**没有合入、没有部署到正式 Relay**。部署前要核对在途原生操作、QA 数据兼容和缓存版本；只有单独验证后再切换正式服务。
4. Android 安全权限由系统 MediaProjection/AccessibilityService 管理，未尝试绕过系统授权。

**结论：M0–M6 的结构调整及已发现 P1 代码问题完成并通过 124 项临时确定性回归；可用的 Codex 与公共功能最终共有 37 个去重真实配对浏览器场景通过、6 个前置条件受阻。由于未覆盖原生设备和平台，不能宣称 201 项全通过或全平台完成发布验收。**

复跑示例：

    cd /home/lihe/adxr_ws/src/remote-agent/_shots/architecture-refactor-v514
    # 临时 Node 测试套件依仓库规定已清理；回归证据和原始日志保留在 _shots/full-refactor/。
    npm run check
    npm run qa:browser -- --list
    npm run qa:browser -- --registry _shots/full-refactor/paired-qa/registry.json --suite full --apps codex --case composer.send
