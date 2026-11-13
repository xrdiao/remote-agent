# v450 全部已登记问题的合并修复方案

初始方案日期：2026-11-12；实施记录更新：2026-11-13（上海时间）。状态：**用户已批准批量实施；当前工作区版本 v452，批量修复见第 11 节，监听关闭及 MCP 补齐见第 12 节。Fusion B03／B04 按原要求暂缓。**

本方案依据当前工作区的只读排查、隔离原生测试及既有配对浏览器结果。详细证据索引为 [`_shots/backend-runtime-audit-20261112/report.json`](../../_shots/backend-runtime-audit-20261112/report.json)。证据目录已被 gitignore，随当前本机工作区保留，不随文档提交分发。

本次在原文档中合并后台运行、队列／历史、卡片内容、问题卡片、打开性能及项目／会话补查结果。旧编号 B01—B06、C01—C02、E01 保留；新增 PS、Q、CARD、QN、DP、U 编号。**PS02 与原 C02 是同一恢复问题，只计一次。** 已修复项、未定位观察、用户暂缓项分别登记，不把它们混写成当前待实施缺陷。第 1—10 节保留原问题、方案及既有证据；本轮产品实施和验证结果统一登记在第 11 节。

| 来源 | 合并内容 |
|---|---|
| [全功能结果](full-functional-audit-v445-20261111-results.md)、[后续补验](remaining-functional-audit-v445-20261112.md) | 旧缺陷的修复状态、Cursor 旧提交未生效、Fusion 旧超时、心跳及原生平台边界 |
| [静态重复修复记录](static-duplication-fixes-v448-20261112.md) | 已完成的 P1／P2／P3 抽取及卡片发送修复，保留未实测平台与 ResizeObserver 观察 |
| [后台运行报告](../../_shots/backend-runtime-audit-20261112/report.json) | B01—B06、C01—C02、监听资源 |
| [队列／历史报告](../../_shots/backend-queue-history-20261112/report.json) | Q01：Codex 生成中执行队列条目失败 |
| [卡片内容报告](../../_shots/card-content-audit-20261112/report.json) | CARD01：Devin 流式拼接多空格；Codex 工具预览轮次观察 |
| [问题卡片报告](../../_shots/question-card-audit-20261112/report.json) | QN01—QN03：Cursor 问题被覆盖、Codex／OpenCode 答案草稿丢失 |
| [打开性能报告](../../_shots/session-open-performance-20261112/report.json) | 未复现的反复打开退化、长会话及网络测试边界 |
| [项目／会话补查报告](../../_shots/project-session-gaps-20261112/report.json) | PS01—PS05；PS02 补齐 C02 的明确时序根因 |

## 1. 范围与已有结果

- 记录范围：本机四软件的后台执行、发送与队列、卡片内容、审批与问卷、项目／会话选择和管理，以及此前发现的重复实现、环境与文档问题。Fusion 旧问题保留在同一方案中，按后续用户要求暂缓实施与验收。
- 第二电脑按用户要求暂不处理；Windows／macOS 缺实机环境，保持未验。语音及手机布局不属于本方案。
- 不修改其他 Agent／插件源码，不改 `scripts/page-exports.json`。复用现有发送、请求展示、原生操作与消息回执链路。
- 各专项只读排查没有实施本文产品修复；原配对页的应用、会话、草稿、存储保持一致，正式 relay 未重启。自建原生窗口与隔离 relay 已关闭；后台专项曾临时启动的 Bonsai 模型已停止，之后的卡片、性能、项目／会话专项未重新启动它。
- 已补验通过：Codex 原生命令审批、队列新增／编辑／删除及后续执行；Cursor 短工具正常结束；Cursor／Devin 基本跨项目复用及真实目录；OpenCode 本地生成、自动压缩展示与压缩后续聊。
- 当前 Codex 会话归档后会通过已有会话变化链路切换选择；本轮已排除“归档后仍绑定已删除记录”的猜测，不为此另加修复。
- 合并后共记录 **16 项已确认功能缺陷**：B01—B06、PS01—PS05、Q01、CARD01、QN01—QN03；其中 PS02 合并原 C02，不重复计数。另有 DP01／DP02 两项低优先级重复／文档整改，以及 C01、E01、U 类证据边界。受控验证、原生实测、配对浏览器和用户手机验收分别记账。
- 当前状态：14 项非 Fusion 功能缺陷已实施；B03／B04 继续暂缓。C01 已统一原生提交入口，DP01／DP02 已完成；验证层级、正式加载和手机验收边界见第 11 节。

## 2. 已确认缺陷与改法

### B01 · P1 · Devin 原生审批没有显示，工具一直等待

**事实与原因**：在独立测试会话发送 `sleep 1` 后，原生存在 pending 的 `session/request_permission`，提供 Allow、会话允许、项目允许、全局允许、切换 bypass、Reject 等选项；RA 仍显示 busy，问题区域为空。停止后原生把工具记为跳过。这与“命令实际执行后没有结束”是不同阶段。

**修改**：

1. 从原生 ACP 的 `clientRequests` 读取所属会话的权限请求，保留 provider、存储请求 key、原生请求身份与原始 optionId。
2. 复用现有请求区域与确认回执，展示原生选项及会话／项目／全局作用范围。
3. 使用原生请求完成链路回传选项，保留原生权限语义；已有 Devin 问卷和自由文字回答继续使用各自对应的原生接口。
4. 普通会话与 Fusion 复用同一 Devin 审批适配，不复制一套菜单或发送实现。

文件：`server/page/devin.js`、`server/page/chat-extract.js`、`server/page/session-actions.js`、`server/apps/devin.mjs`、`server/routes.mjs`、`app/js/history.js`。

证据：`devin-permission-evidence.json`、`devin-permission-final-results.json`、`devin-native-reply-api.json`、`devin-reply-lookup.json`。

### B02 · P1 · Codex 后台进程退出，展示与停止操作仍使用旧状态

**事实与原因**：对自建 Codex 后台进程执行 SIGKILL 后，服务端线程容器清空，页面仍显示生成中；点击停止报 `Cannot read properties of undefined (reading 'turns')`。手动刷新恢复成功。

**修改**：

1. 让后台进程生命周期成为会话可操作状态的数据来源。退出时同步展示“后台中断、结果待核对”，保留最后已知会话身份与正文。
2. 区分最后已知快照与当前有效的原生执行实例，避免把失联直接判作业务完成。
3. 恢复和停止先获取有效会话、核对原生轮次，再执行对应操作；不重新提交结果未知的旧消息。
4. 继续保持 relay 拥有后台进程、手机连接只拥有订阅的归属。

文件：`server/codex/state.mjs`、`server/apps/codex.mjs`。

证据：`paired-results.json` 中 `codex-abnormal-exit-visible-state-and-recovery`，以及 `native-trace.jsonl`。

### B03 · P1 · Fusion 正文读取阻塞原生终态核对

**事实与原因**：当前 `observe()` 先等待 `readConversation()`，再调用 provider 的 `readTurn()`。在受控正文超时中，原生轮次核对次数为 0，即使原生轮次已经结束，也没有机会核对。此证据确认当前结构缺陷，不能单独还原旧超时事件的全部因果。

**修改**：

1. 先核对原生接受、运行与结束事实，再读取正文及展示信息。
2. 正文读取故障单独报告，不覆盖已经核实的执行终态。
3. 原生连接或轮次身份也不可核实时，保留 unknown／待核对语义，继续遵守既有提交与恢复规则。
4. 复用现有 provider 与执行记录，不靠延长超时或补发请求改变结果。

文件：`server/fusion/agent.mjs`。

证据：`logic-results.json` 中 `fusion-transcript-read-blocks-authoritative-terminal-check`。

### B04 · P2 · Fusion 的 Cursor／Devin 问卷缺后台执行分支

**事实与原因**：现有界面已生成 `question` 动作，但 `nativeAction()` 没有对应的 Cursor／Devin 问卷处理分支，当前函数会抛出“该原生交互尚无不切换普通会话的后台接口”。

**修改**：

1. 为已有 question 动作补齐按 Binding、会话及原生请求身份定位的处理。
2. 通过原生答案选择与提交机制处理选项、自由回答、提交和跳过；原生支持的翻页等操作按实际接口处理。
3. 与 B01 的请求读取／回传共用适配，保持普通会话的选择、输入和窗口归属。

文件：`server/fusion/agent.mjs`、`server/page/session-actions.js`、`server/page/devin.js`；复用已有 Fusion 表单与消息类型。

证据：`logic-results.json` 中 `fusion-non-codex-question-dispatch`。当前证据为实际函数的受控执行，修复后仍需真实问卷验收。

### B05 · P2 · Codex MCP 表单丢失原生类型

**事实与原因**：当前 `requestRows()`／`answer()` 将布尔值、整数等作为输入字符串回传。受控请求要求 boolean／integer，实际回传类型均为 string。

**修改**：

1. 按原生 requestedSchema 构建字段与选项。
2. 提交时还原布尔、整数、数值及枚举的原始类型，使用已有失败回执处理无效输入。
3. 保留原生 accept／decline／cancel 语义，继续使用现有表单与请求身份。

文件：`server/codex/state.mjs`；共用表单的必要调整与 B01 一并放在 `app/js/history.js`。

证据：`logic-results.json` 中 `codex-MCP-form-preserves-native-types`。

### B06 · P2 · OpenCode 重试原因、次数和时间未展示

**事实与原因**：本地 provider 离线后，原生上报 `status.type = retry`，包含 message、attempt、next；RA 快照只有 busy=true，没有重试提示。首次等待终态超时不证明 RA 执行挂死；后续真实状态读取确认原生仍在重试。

**修改**：

1. 将原生重试原因、次数和下次重试时间带入现有聊天／状态展示。
2. 保持原生 retry 对应的执行状态及策略。
3. 随原生状态变化更新或移除提示，停止操作继续使用现有 abort 接口。

文件：`server/opencode/state.mjs`。

证据：`opencode-retry-evidence.json`、`opencode-results.json`。本轮真实压缩展示、续聊和空白助手检查已通过；不修改 OpenCode 的原生压缩策略。

## 3. Cursor：证据边界与调整方向

### C01 · 旧偶发发送未生效

旧事件只能确认当次提交未生效；原始按键／焦点追踪缺失，具体触发条件没有还原。后续成功样本不能证明旧问题已修复，也不能据此认定失焦就是根因。

建议将普通发送统一到 Fusion 已使用的 `submitChatMaybeAbortCurrent` 原生入口，复用已有提交身份及接收确认。普通发送与后台提交的草稿归属分别保留；原生接收事实确认后再完成发送收尾。此调整减少按键提交的不确定性，不将它表述为已证实的旧事件根因修复。

文件：`server/apps/cursor.mjs`、`server/page/session-actions.js`。

### C02 · 载体关闭后的恢复与服务就绪

此项已由最新补查明确为 **PS02 · P1**，修改范围与验收统一放在第 8 节，不再建立第二套恢复方案。

最新现场：刷新得到真实 dormant 收藏卡片后打开 Cursor B；RA 复用自建窗口切换至 B 项目，约 1.4 秒报原生会话目录未就绪，随后原生窗口实际完成 B 会话加载。`pendingProject.reopening` 仅在 `newWindow && threadId` 成立时设置，`reused` 分支漏掉 `finishProject()` 中已有的原生服务就绪阶段。

旧载体关闭后的首次测试曾点到旧列表目标，该次“窗口关闭／CDP closed”不作为上述根因证据。Devin 以刷新后的实际卡片补测，A／B 均可借现有窗口打开，不列为 Devin 恢复故障。

证据：旧证据保留在后台运行报告；新证据为 `_shots/project-session-gaps-20261112/restore-final/{cases,proof,live}.json`、`current-windows.json`、`inspect-final/cases.json`。旧 Cursor 发送事件仍单列 C01。

## 4. E01：本机文件监听资源，独立于产品代码修复

### 事实

- 采样时 `fs.inotify.max_user_watches = 65536`，Codex 原生进程已报告 `OS file watch limit reached`。
- 两个名为 code 的进程分别可读到 43856、15429 个监听条目；另有系统程序占用。跨进程 FD 可能共享实例，因此这些计数不是去重后的全局精确总量。
- 监听限制按真实用户 ID 计算。同一用户下，Cursor、Devin、OpenCode 或其他程序只要使用 inotify，就共用该额度；未取得它们的触顶错误，不能写成“其他软件也已发生同样故障”。
- 独立启动 Codex 后台进程增加了监听需求；旧依赖窗口版本也使用文件监听。缺少同等项目／窗口数量下的新旧对照，不能把触顶全部归因于新版。

证据：`inotify-readonly.json`、`native-trace.jsonl` 中的原生警告。系统接口说明见 [Linux inotify 手册](https://man7.org/linux/man-pages/man7/inotify.7.html)。

### 处理顺序

1. **已按后续单独授权配置** Code／Cursor／Devin 的 `files.watcherExclude`：保留 `/home/lihe/adxr_ws/src/` 内有用源码的监听，排除确定无关的其他目录、缓存、虚拟环境、依赖及测试产物。配置记录在 `_shots/watch-exclusions-20261112/applied.json`、`result.json`。不得再把此步骤写成尚未执行。
2. Code／Cursor 的运行时排除项与 Code 源码变更事件已有核对；Devin 配置文件已校验，未取得其运行时设置服务。两个 Code 语言服务曾单独重启，见 `language-service-reload.json`。已有扩展订阅可能仍持旧排除列表；当前采样未证明所有旧监听已经释放，见 `runtime-verification.json`、`after.json`。
3. 后续在用户确认的空闲窗口执行必要的窗口／扩展宿主重载，再比较监听条目、排除目录和源码变更事件；不在生成中强制重载。验证保留目录的新增／修改／删除仍可被发现。读取文件与订阅文件变化分开验，排除监听不等于文件访问被禁止。
4. Code 的设置不能统一约束独立后台进程或其他软件自己的监听器。继续按实际进程核对 Codex 后台等剩余监听，不把减少 Code 占用表述为全部应用问题已修复。
5. 系统上限调整仍只是独立候选：`/etc/sysctl.d/99-remote-agent-inotify.conf` 设置 `fs.inotify.max_user_watches=262144`。尚未创建、加载；不能因本次合并文档而实施此系统修改。

Code 的官方说明建议先排除无需跟踪的大目录，再评估系统限额：[Linux 安装与文件监听排错](https://code.visualstudio.com/docs/setup/linux#_common-questions)。本方案不直接给 Code 硬卡一个更小的数量。

原生日志另有一个 PDF Skill 元数据枚举不被当前 Codex 识别的警告；只记录该环境事实，不改其他 Agent／插件文件。

## 5. 已确认的仓库修改范围：原 28 个，追加 2 个

用户已批准原方案，并分别批准下列两处范围扩展。本轮实际代码差异为 28 个文件，另更新本文档；`server/fusion/agent.mjs` 暂缓，`scripts/project-windows.test.mjs` 本轮未改。

| 文件 | 修改职责 |
|---|---|
| `server/page/devin.js` | 原生权限读取／回答；共用 Devin 流式文字分组规则及管理能力读取 |
| `server/page/chat-extract.js` | Devin 待审批快照、问题应用归属、流式文字分组接入 |
| `server/page/session-actions.js` | 现有原生操作入口、Cursor 持久重命名、Devin 管理／清理及卡片文本规则 |
| `server/apps/devin.mjs` | 接入 Devin 原生审批适配 |
| `server/routes.mjs` | 将已有请求交互分发给所属应用适配器 |
| `app/js/history.js` | 共用请求表单及按电脑／会话／请求归属的答案草稿 |
| `server/codex/state.mjs` | 后台生命周期、轮次核对、MCP 类型及队列立即执行的原生状态转换 |
| `server/apps/codex.mjs` | 后台展示／停止／恢复、队列动作接入及共用引用分段 |
| `server/fusion/agent.mjs` | 原生终态核对与正文读取分离，补齐后台问卷动作 |
| `server/opencode/state.mjs` | 将原生 retry 数据映射到现有展示 |
| `server/apps/cursor.mjs` | 普通发送复用已有原生提交接口与接收确认 |
| `server/session.mjs` | 失败导航与成功恢复记录分离；保留原失败收尾 |
| `server/agent/projects.mjs` | 新建／复用窗口切项目后的统一原生就绪阶段 |
| `scripts/session-lifecycle.test.mjs` | 失败导航、重命名／管理、问题草稿及共用引用分段回归 |
| `scripts/codex-backend.test.mjs` | 进程退出、恢复／停止、MCP 类型回归 |
| `scripts/fusion-agent.test.mjs` | 正文故障、原生终态、问卷分发回归 |
| `scripts/opencode-session.test.mjs` | retry 展示、状态变化及停止回归 |
| `scripts/project-windows.test.mjs` | 多窗口选择、关闭载体后重开、跨项目归属 |
| `app/js/core.js` | 同步网页版本 |
| `app/index.html` | 更新受影响脚本引用 |
| `app/sw.js` | 同步缓存版本与受影响资源引用 |
| `server/agent/session-actions.mjs` | 按原生能力管理 Devin 会话，复用既有身份、动作与成功回执 |
| `app/js/chat.js` | OpenCode 问题表单接入共用答案草稿及提交成功清理 |
| `server/page/codex.js` | Codex 请求探测使用明确的应用归属，不覆盖 Cursor 问卷 |
| `scripts/structure-fixes.test.mjs` | 应用问题归属、答案草稿与前端资源接入回归 |
| `server/agent/context.mjs` | 共用原生引用文本分段执行，原生插入仍由各适配器提供 |
| `README.md` | Fusion 能力说明与当前 provider／验收状态一致 |
| `README.en.md` | 同步对应英文能力说明 |
| `app/js/net.js`（追加已确认） | OpenCode 问题提交回执交给共用草稿收尾函数 |
| `scripts/fusion-runner.test.mjs`（追加已确认） | 旧片段夹具加载两段共用 Devin helper，原断言保持 |

原 28 个文件及上述 2 个追加文件均已获用户确认。B03／B04 的 Fusion 专用实现与验收暂缓；共用 helper 的既有回归仍应保持。`lib/auth.mjs` 的成功记录保存接口、卡片发送入口及 page 导出快照继续复用，不为本方案另建接口。本轮 core、受影响脚本引用及服务工作线程缓存统一到 v451。

系统限额、用户级编辑器设置和第 9 节尚未定位的条件候选文件不属于上述 28 个仓库文件；需要新增实施文件时先确认范围。

## 6. 实施顺序与验证

建议按以下顺序实施：

1. PS01／PS02：保留成功导航记录，修正 Cursor 复用窗口的就绪时序。
2. B01／B02／QN01：处理 Devin 隐藏审批、Codex 后台失联、Cursor 隐藏问卷。
3. Q01／PS03—PS05：修复队列立即执行与原生会话管理／清理回执。
4. B05／B06／QN02／QN03／CARD01：表单类型、重试状态、共用答案草稿和流式文字。
5. DP01／DP02：低优先级引用分段去重及能力文档同步。C01 在核对原生提交语义后按其单独方向处理，不称为旧事件已定位。
6. B03／B04 保留完整方案，待用户恢复 Fusion 范围后执行。第 9 节先补证据或明确产品语义，不直接套用猜测补丁。

跨项共用请求读取、原生操作、文字分组和答案草稿一次整理。卡片继续调用正文 `sendComposer()`；不复制发送、管理或问答实现。

| 范围 | 必须核对的结果 |
|---|---|
| Devin 审批 | 真实请求可见；允许一次后工具完成；拒绝后原生正确结束；返回／切换后请求仍属于原会话。永久权限选项的字段映射以隔离／受控验证为准，不把未实际执行的选项记为真机通过 |
| Codex 进程 | 自有进程生成中异常退出；展示转为待核对；停止不再读空对象；恢复读取原轮次；已提交消息没有被重复提交 |
| Fusion 观察 | 分别覆盖正文超时而原生仍运行、原生已结束、原生也不可核对；完整执行一组主控、依赖任务、审核及交付 |
| Fusion 问卷 | Cursor／Devin 的原生问题与回答相符；单选、多选、自由回答及提交／跳过按实际原生能力分别记录；普通会话归属保持 |
| MCP 表单 | 布尔 false、整数 0、普通数值、字符串和枚举保持原生类型；取消及无效输入走正确回执 |
| OpenCode | 真实本地生成、provider 离线后的原生 retry、恢复／停止和提示消失；本地模型仅在测试需要时临时启动，结束后停止 |
| Cursor／窗口 | 同项目与跨项目、当前输入框、原生接收确认、忙碌窗口、关闭载体重开、多窗口自动选择；保留草稿与已有窗口的项目归属 |
| PS01 成功选择 | 四软件各做 A 成功→无效 B 失败→重连恢复 A；B 成功才更新记录；A 迟到回执不覆盖已成功 C；另一应用及独立入口记录不受影响 |
| PS02 窗口恢复 | 分别覆盖新窗口、复用窗口切项目、已有同项目窗口；在原生服务未就绪阶段不发布成功；最终窗口／cwd／线程都为 B，不显示 A 正文 |
| PS03／PS04 管理 | 当前／非当前、同名不同项目会话重命名；刷新及重开后原生和卡片标题一致；动作能力不依赖历史菜单是否挂载；原生不支持的动作保持原语义 |
| PS05 清理 | `removed + missing`、单独 missing、unknown、未就绪、已归档、明确存在分别验证；实际删除一次后确认成功，缓存与监听正确释放 |
| Q01 队列 | 活动轮次与空闲时分别执行队列项；原生新用户消息只出现一次、队列项移除；保留其余队列、附件、顺序、编辑／删除及输入框立即追加 |
| CARD01 卡片 | 同一流式消息内分片连续连接；不同消息保留段落；中英文、Markdown、emoji、工具穿插及停止／结束均核对；卡片与正文使用同一规则 |
| QN01 问题归属 | Cursor 普通 IDE 通知与真实问卷同时存在时，问卷可显示并回答；Codex 原生队列确认、审批及表单仍显示；无关通知不进入操作请求 |
| QN02／QN03 草稿 | A 输入未提交答案→B→A 保留；同请求 ID 在不同电脑／应用／会话不串；成功清理、失败保留、请求结束清理；选项与自定义文字分别覆盖 |
| DP01 引用分段 | 两软件多引用、重复 token、前后文字及空格、原生插入失败时的既有字面量行为、附件和草稿恢复语义保持 |

只跑修改及实际受影响的检查。产品修改完成后执行 `npm run check`，保留原断言及 page 导出快照。最后复用既有配对浏览器统一检查，不把 Ubuntu Chrome 的手机布局当作手机真机或其他系统验收。

当前源码已有的 1012 项通过记录属于前一轮检查，不算本方案实施后的结果。最近补查也没有实施产品修复，因此没有新增“修复后通过”的结论。配对浏览器统一验收时，先复现各项失败，再验修改后的原场景与表内受影响功能；逐项记录未执行原因。

## 7. 仍需保留的证据边界

- Cursor 旧偶发提交的具体触发条件没有还原。
- Fusion 旧超时事件的全部因果未还原；B03 确认的是当前可执行代码中的阻塞链路。
- 本轮没有遇到真实 Codex 云端容量不足，受控重试验证不能替代该现场。
- 第二电脑按用户要求暂缓；Windows／macOS 缺实机环境，保持未验。
- 不为上述证据缺口增加自动重发、延时掩盖或通用兼容分支。

## 8. 合并新增的功能缺陷及具体方案

### PS01 · P2 · 四软件失败导航清除上一次成功选择

**事实与根因**：Codex／Cursor／Devin／OpenCode 均复现 A 成功后打开不存在的 B 目录，`entrySelections.apps[app]` 被删除、`last` 变 null。`server/session.mjs:494–505` 的 `navigationFailed()` 无条件调用 `forgetSelection()`，把失败目标与此前成功目标混为一体。

**修改**：

1. 导航失败继续结束本次绑定、取消旧读取并回报现有 `attachFailed`；成功恢复记录继续由成功读取后的既有保存链路拥有。
2. 移除失败新选择时对既有成功记录的清除。保留 `lib/auth.mjs` 的保存／清除接口及真实删除、归档的原有业务语义；不新增另一份恢复缓存。
3. 按已有导航身份核对完成事件；迟到失败或旧成功结果不能改写后来成功的选择。

文件：`server/session.mjs`、`scripts/session-lifecycle.test.mjs`。四软件原生适配与 `lib/auth.mjs` 不为此复制实现。

验证：四软件各做 A 成功→B 不存在→重连恢复 A；B 真正成功后才恢复 B；另一应用／入口记录保留。证据：项目／会话报告 `cases.json`。

### PS02 · P1 · Cursor 复用窗口切项目漏掉原生就绪阶段（合并 C02）

**修改**：

1. 用实际“窗口已打开或项目已切换、目标项目一致、原生服务和目标会话可用”描述恢复进度。新建窗口与复用窗口切项目共用已有 `finishProject()` 就绪阶段。
2. 修正 `pendingProject.reopening` 只覆盖 `newWindow` 的条件归属，使 `reused` 项目切换也进入该阶段；继续使用现有服务发现与会话打开入口。
3. 就绪后才发布成功绑定、保存成功选择和首屏。多窗口仍自动选定绑定窗口；不通过先进入 A、另建占位消息或反复提交 B 来取得成功。

文件：`server/agent/projects.mjs`、`scripts/project-windows.test.mjs`。原方案中 `server/page/session-actions.js` 的服务发现调整，仅限实际核对仍属于同一就绪问题的部分；不把全部旧 CDP 错误归于该处。

验证：新窗口重开、复用窗口切项目、已有同项目窗口三条路径；关闭 A 的终端视图后打开 B；核对窗口、cwd、线程及首屏，不短暂显示 A。保留已通过的 Devin 现有窗口恢复与 Codex 空闲后台重启恢复结论；不把后者外推为 B02 生成中退出已修复。

### PS03 · P2 · Cursor 重命名未同步到原生目录

**事实**：A 已加载对象名称改变，原生 `composerHeaders` 及列表仍旧；B 的重命名能保存。不是已经证明的纯错误文案问题。

**修改**：

1. 对照当前原生手动重命名的提交及持久化调用，确认使用的句柄、参数和完成信号；统一从原生会话身份取得目标。
2. 现有 `nativeSessionAction('cursor', …, 'rename')` 完成原生持久化后，目录、`nativeSessionInfo()` 和管理回执读取同一已确认名称；同名会话仍按 ID／项目区分。
3. 复用现有 `publishSessionChange()` 更新卡片与列表。不直接写原生数据库、不以加载对象新名称冒充持久化成功，也不通过第二次重命名请求修补第一次。

文件：`server/page/session-actions.js`、`scripts/session-lifecycle.test.mjs`；调用方仍用 `server/agent/session-actions.mjs` 的管理入口。

验证：加载中与未加载、当前与其他项目两种会话分别改名；刷新、切走返回及关闭测试载体后重开，原生与 RA 标题一致。已缩小到原生名称来源／持久化链路，具体调用须在实施前核实，不能把候选方法签名当成已证实根因。

### PS04 · P2 · Devin 跨项目会话可打开却无法管理

**事实与根因边界**：目录和实际列表中均有 B，打开成功，但重命名报无原生入口。`nativeSessionInfo()` 从已挂载的历史／侧栏 DOM 推导 `actions`；目录存在与菜单条目挂载不是同一个状态，具体触发组合仍需针对性核对。

**修改**：

1. 用原生 provider、会话 ID 与已声明能力确定操作，复用现有会话规范化和操作入口。已存在的 `renameSessionThunk` 按同一原生身份接入普通管理链路。
2. 核实原生归档按钮实际调用的 provider 动作及完成回执后，纳入同一个适配器；归档、删除、清空的语义保持区分，不能为了通过测试把归档换成删除。
3. 操作不要求先打开 B 正文或依赖历史列表虚拟条目出现。复用已有窗口解析、租约、原生执行及 `publishSessionChange()`；保留原生真正不支持动作的能力边界。
4. 同一请求的原生执行与回执按会话关联，普通会话与后台调用共用，避免为跨项目再写一份管理器。

文件：`server/agent/session-actions.mjs`、`server/page/session-actions.js`、`server/page/devin.js`、`scripts/session-lifecycle.test.mjs`。

验证：A 项目窗口中管理 B、历史面板关闭／打开、非当前会话、同名不同项目、刷新后名称；已存在的队列与草稿归属保持。原生直连网络要求继续执行。

### PS05 · P2 · Devin 原生删除成功却报清理状态未确认

**事实与根因**：自有 A 删除后权威目录同时含 `removed=[A]` 与 `missing=[A]`。`nativeSessionCleanup()` 的 `inspect()` 在检查 `removed` 前，把所有 `missing` 判为错误，导致成功结果不能收尾。此项实测的是指定会话清理 helper，不外推为所有手机删除或 Fusion 现场均失败。

**修改**：

1. 依原生目录和请求回执判定存在、已归档、明确删除、未知四类结果；`removed` 的权威删除事实先于单纯列表缺失处理。
2. 保留目录未就绪／unknown／仅 missing 时原有待核对语义；若出现较新活动记录，不能用旧删除回执覆盖它，复用目录中已有的时间与身份信息。
3. 仅在原生结果明确后执行既有缓存／监听释放及成功回执。确认删除后不再发送第二次删除，也不把 unknown 当作成功。

文件：`server/page/session-actions.js`、`scripts/fusion-agent.test.mjs` 的既有 helper 测试；此处不需要启动 Fusion run。

验证：`removed + missing`、仅 missing、unknown、未就绪、已归档、仍存在及较新活动记录；真实自有会话只删除一次并核对目录、请求完成记录与监听清理。

### Q01 · P1 · Codex 活动轮次中执行队列条目失败

**事实与根因**：对队列条目点立即发送，后台适配器直接调用 `thread/queue/start`；原生当前轮次仍 `inProgress`，返回 `thread already has an active or pending turn`。后续自动执行成功不能替代该按钮通过。输入框的立即追加走 `turn/steer`，本轮已通过，二者不能混为一条操作。

**修改**：

1. 在 `server/codex/state.mjs` 收拢原生队列立即执行操作；适配器继续按现有 `queue` 路由调用，不新增发送入口。
2. 对照当前原生队列立即执行的行为，补齐活动轮次的停止与结束确认，再执行原 `queuedSubmissionId`；空闲时走原有队列执行。使用同一线程的原生状态转换，不用固定延时假定停止完成。
3. 以原生队列项进入执行及对应用户消息为确认，保留该项输入／附件／身份、其余队列顺序与状态；不把队列项复制成普通发送或输入框 steer，不重发结果未知的项。

文件：`server/codex/state.mjs`、`server/apps/codex.mjs`、`scripts/codex-backend.test.mjs`。

验证：活动轮次、空闲、停止与队列自动推进交接、A 操作后切 B；确认原生消息只执行一次，编辑／删除／自动执行和输入框立即追加保持。证据：`_shots/backend-queue-history-20261112/report.json`。

### CARD01 · P2 · Devin 卡片流式片段之间多出空格

**事实与根因**：同一 `streamingMessageId` 的片段先以换行连接，再经摘要空白归一化插入空格；样本 `RA_CARD_DEVIN_B` 变成 `RA_CARD_DEV IN_B`，emoji 前也多空格。配对页可见正文样本正确，不宣称全部正文都错。

**修改**：

1. 在现有 Devin 原生文字读取范围共用一个分组规则：同一流式消息内连续连接，独立原生消息／段落保留分隔。
2. 卡片预览和存在同类拼接的原生正文分支调用同一规则；保留工具提取、最新用户轮次、摘要长度与空白处理各自职责。
3. 不靠渲染时删除所有空格来修文字，保留用户本来输入的空格与 Markdown 分隔。

文件：`server/page/devin.js`、`server/page/session-actions.js`、`server/page/chat-extract.js`、`scripts/session-lifecycle.test.mjs`；helper 保持 page 内部使用，导出快照不变。

验证：中英混排、emoji、Markdown、一个词跨片段、真正的多段文本和工具穿插；卡片展开／刷新／结束后文字与原生一致。证据：卡片内容报告 `devin-stream-text-proof.json`。

### QN01 · P1 · Cursor 问卷被无关 IDE 通知覆盖

**事实与根因**：Cursor 原生真实问卷存在，`extract()` 却将普通 IDE 通知识别为 Codex 请求并优先覆盖；前端按当前应用过滤后，真实 Cursor 问卷也消失。只读函数副本排除通用探测后，同现场立即恢复正确问题数据。

**修改**：

1. 问题与审批读取按实际应用／指定会话归属分发。Cursor 使用已有原生决策／问卷读取器；Codex 请求探测只读取所属 Codex 的原生请求。
2. 修正产生错误数据的应用归属与优先级，保留 Codex 审批、队列确认及 MCP 表单原有展示；不以隐藏 IDE 通知或在前端吞掉错误问卷替代根因修复。
3. 继续复用 B01／B05 的现有请求区域和操作回执，不新增一套问题 UI。

文件：`server/page/chat-extract.js`、`server/page/codex.js`、`scripts/session-lifecycle.test.mjs`、`scripts/structure-fixes.test.mjs`。

验证：普通 IDE 通知与真实 Cursor 问卷共存、无通知、原生问题消失；真实选择／自定义回答及提交；Codex 队列确认、审批和表单回归。证据：问题卡片报告中的 `QUESTION-CURSOR-MASKED`。

### QN02／QN03 · P2 · Codex／OpenCode 问题答案草稿切会话丢失

**事实与根因**：Codex `qnView` 改变时统一 `qnDrafts.clear()`；OpenCode 自定义答案只存在表单 DOM。A 输入未提交答案→B→A 后，原问题仍在，答案为空。

**共用修改方案**：

1. 扩展 `app/js/history.js` 已有答案草稿机制，以电脑 ID、应用、原生会话 ID、请求 ID 与字段／题目身份作 key。窗口重建不改变同一会话答案归属。
2. Codex 请求字段、普通问卷和 OpenCode 表单共用读／写／清理操作，保存文字及选项；切换只切当前视图，不全局清除其他请求草稿。
3. 回执关联提交时捕获的所属请求；成功提交／拒绝、原生明确请求结束时清理对应项，失败保留。旧请求回执不能清掉新请求答案。
4. 草稿保留在本页内存生命周期；表单重建恢复原值、选择、焦点等现有语义。不为两个软件各建独立缓存或新增持久存储。

文件：`app/js/history.js`、`app/js/chat.js`、`scripts/session-lifecycle.test.mjs`、`scripts/structure-fixes.test.mjs`，以及既定网页资源版本文件。

验证：Codex 文字字段、OpenCode 自定义文字／单选／多选分别 A→B→A；同 ID 不同电脑／软件／会话隔离；提交成功、提交失败、拒绝、原生问题结束及旧回执迟到。Cursor 问卷先修 QN01 再验端到端。证据：问题卡片报告中的两个草稿缺陷。

### DP01 · P3 · 原生文件引用的文本分段仍重复

**现状**：旧全功能静态排查 D02 的 `typeWithCodexMentions()` 与 `typeWithMentions()` 仍各自循环查找 token、输入前缀／尾部并处理空格；不同于已完成的路由去重 D02，编号不可混淆。

**修改**：在 `server/agent/context.mjs` 共用分段执行算法，由 Codex／Devin 注入现有原生引用插入回调；Codex 输入快照恢复、原生 chip、成功后的单个空格处理及失败时的既有字面量行为保持。复用现有 `typeText()`，不再添加一套输入执行器。

文件：`server/agent/context.mjs`、`server/apps/codex.mjs`、`server/apps/devin.mjs`、`scripts/session-lifecycle.test.mjs`。

验证：重复／不存在 token、多引用和前后文字、成功／失败原生插入、附件与草稿恢复。旧全功能结果第 9 节提供基线证据，实施时以当前函数为准。

### DP02 · P3 · README 的 Fusion 主控能力声明落后于实现

**现状**：README 仍写主 Agent 限 Codex，而 provider／候选模型覆盖 Cursor／Devin／Codex；声明可选与实际执行通过应分开。

**修改**：`README.md`、`README.en.md` 对齐当前原生 provider、模型候选和具体可用条件，引用实际限制与验收记录；说明 OpenCode 尚未接入 Fusion。保留本轮 B03／B04 的失败／暂缓状态，不把文档更新当成功能修复通过。

验证：只核对文档与 provider 声明及结果索引。本轮仅合并计划，README 的实际改文留待实施。

## 9. 所有未定观察与暂缓项的处理方案

本节也纳入合并文档，但未定位观察先补证据，不制造确定性修复承诺；用户暂缓项只记录方案，不自动启动测试。

| 编号／问题 | 当前事实与处理方案 | 条件候选位置／证据 |
|---|---|---|
| C01 Cursor 偶发发送未生效 | 原生没有对应新生成；后续成功不证明旧问题消失。按第 3 节核对并复用已有原生提交接口及接收确认，按 request／thread 跟踪一次提交；不自动重发。 | `server/apps/cursor.mjs`、`server/page/session-actions.js`；Cursor 发送专项 `verdict.json` |
| U01 反复打开／长会话后越来越慢 | 235 次正常打开、12 次改选未复现持续退化；Cursor 主要耗时在桌面切换／首包，不能判手机网络正常。先处理 PS02 等明确导航问题，按同一入口记录点击、绑定、首包、渲染与订阅释放；若再慢，用同阶段前后对比定位。 | 打开性能报告；`server/session.mjs`、`server/agent/chat.mjs`、`server/native-windows.mjs`、`app/js/overview.js`、`app/js/history.js` 为诊断候选，未授权盲改 |
| U02 Codex 卡片工具可能沿用上轮 | 新一轮无工具回复时，快照仍带上轮三条；空闲 UI 不显示，尚未定为缺陷。建议与其他应用统一为最近用户轮次，产品语义确认后复用正文的轮次边界过滤，再保留现有 3 条限制。 | `server/overview.mjs:137–143`、卡片内容报告 `observations`；不计入当前 28 文件 |
| U03 ResizeObserver 提示 | 原浏览器仍有 `loop completed with undelivered notifications`；没有证明它造成打不开。先从完整栈与所属页面定位 RA 还是原生组件，检查回调读写尺寸是否形成循环；仅对明确反馈链修复测量／布局职责，不屏蔽错误或统一延后所有更新。 | `app/js/core.js` 的 `headerSizeObserver`、`app/js/history.js` 的 `chatSizeObserver/turnNavSizeObserver` 为候选，不是已确认根因 |
| U04 Fusion 旧依赖任务超时 | 原生结果与整组交付未全部核实。B03 修已确认的正文阻塞结构；旧事件仍需按 thread／turn／request 核对接受、结束及 unknown 恢复，不延长超时或补发未知任务。 | 全功能结果 U01、B03；Fusion 按用户要求暂缓 |
| U05 自然手机断连／本机心跳中断 | 已有本机 heartbeat 1006，不足以区分网络、进程暂停与系统调度；不同局域网的两电脑不能直接归咎硬件。恢复测试时同步采集双方 ping/pong、关闭来源、页面可见性、事件循环停顿和隧道同期状态，再作同入口对照。 | `server/ws.mjs`、`app/js/net.js`、隧道及系统日志为诊断候选；自然断连、第二电脑暂缓，不能关闭心跳压提示 |
| U06 OpenCode 压缩后模型忘记进度 | RA 压缩展示和后续聊天已有通过样本；模型记忆与原生压缩策略属于 OpenCode／模型侧。按用户要求不修改该策略，若恢复排查，先做电脑原生对话与 RA 同会话对照。 | `docs/problem.md` 第 70 节及原生压缩结果；不列 RA 待改代码 |
| U07 图片／空泡／工具过多的历史反馈 | 旧修复状态见第 10 节，最新卡片异常专项没有新的指定会话目标。复发时按原生消息 ID、轮次、附件及工具条目核对；不将 CARD01 的文字问题扩大为所有卡片异常。 | 卡片与问题卡片报告、`docs/problem.md` 第 70 节 |
| U08 原生插件升级后的入口变化 | 已有 Codex 入口修复和后台协议接入，不能保证未来插件版本永不变化。现有适配器负责能力发现，普通／卡片共用入口；升级后运行发送、模型、问卷及原生回执契约检查，失败集中在同一适配器修正。 | 静态修复 C01、当前 `server/apps/*` 与 `server/page/*`；不修改其他 Agent／插件或添加版本分支兜底 |
| U09 原生 PDF Skill 元数据警告 | 当前 Codex 不识别某枚举值；保留原生日志，交给所属插件配置维护，不改其他 Agent／插件文件。 | 后台运行报告 `environment.pluginMetadata` |
| U10 手机系统识别第二次无文字 | 用户曾确认等首轮完成、隔几秒再录仍无文字，松手后原生报 aborted。按要求语音暂缓；恢复时按识别实例记录 start／audio／result／error／end、stop／abort 的所属轮次，定位原生识别是否复用失效或被旧轮收尾取消，再修对应生命周期；不把 aborted 单独定为系统故障。 | `app/js/voice.js`／`app/js/local-voice.js` 为诊断候选，不纳入当前 28 文件 |
| U11 对话页输入框位置更靠底部 | 用户要求与改前代码对比；没有本轮几何证据。恢复排查时对照当时基线 CSS、viewport、安全区、输入框与键盘状态，锁定实际差异后给最小布局改动，不用任意 padding 回调。 | `app/app.css`、`app/js/core.js` 及原视口采样为候选；手机布局按既定范围暂缓 |

仍未实际覆盖：第二独立配对入口同步、同项目多窗口全部绑定／去重组合、分组滚动／折叠组合、空会话跨应用重启落盘组合、各软件各自的批量取消／部分失败与全部 idle 原生变体，以及被重命名故障挡住的后续管理用例。修复后优先补齐实际受影响项，不把共用代码单点实测冒充四软件各自通过。

账号退出／登录、计费变更、真实额度耗尽重试、语音、手机 PWA 生命周期、通知打开、Android／iOS、第二电脑／远程 host、其余平台仍按原用户暂缓或环境限制登记。已有受控／契约检查保留，但不算这些现场通过；未执行就不新增“修复后通过”。

## 10. 旧问题修复状态与既有方案的统一归属

以下保留前面已登记问题的处理方案与实施证据；“已实现／隔离通过”不自动等于正式 relay 已加载或用户手机已验收。

| 旧问题／方案 | 已采用的修改方案及当前状态 | 后续动作／证据 |
|---|---|---|
| Cursor 空白首屏、attachFailed 等待不结束 | v446 已解耦空白首屏读取与失败绑定收尾，真实空首屏发送通过；与 PS02 的复用窗口切项目就绪缺口分开 | 沿用 v446 补验；PS02 按本方案修，不重开旧首屏补丁 |
| Codex 新插件发送入口／模型按钮／模块名变化、卡片失败正文成功 | 已对齐当时原生入口、统一 `composerTarget(doc)`，卡片复用正文发送；v449 三次卡片发送及正文通过 | 静态修复 C01／C02；正式加载和手机反馈按实际版本核对，未来升级见 U08 |
| Codex Markdown 发送、队列编辑回执及旧草稿恢复 | v446 已区分队列原文与正文序列化文本，沿既有回执收尾 | 补验文档 v446；不与 Q01 活动轮中 queue/start 失败混同 |
| Codex 暂停队列后的新发送停在确认 | v447 已同步原生“保留队列／清空队列／取消发送”选择并按请求收尾，三个真实分支通过 | 补验文档 v447、`_shots/submit-image-fixes-20261112/`；原生选择继续保留 |
| Devin WebP 不接收、无改动保存同图删除失败 | 已转换为原生支持格式；v447 已保留未改动附件，真正旋转／替换仍走原流程 | v446／v447 补验；不更改已通过的附件语义 |
| Cursor 图片缩略图、OpenCode 空助手气泡、展开卡片工具数及长消息负载 | 旧版已补原生图片元数据、空泡判定、最近轮次工具限制及生成推送合并；本轮卡片／历史结果分别沿用 | `docs/problem.md` 第 65、70 节及卡片报告；新复发按 U07 定点核对 |
| Cursor 正文更新慢／缺最新文字 | v438 阅读时重绘、v439 原生文字补齐已修，保留虚拟列表、历史锚点与现有 Markdown 渲染 | `docs/problem.md` 第 66／67 节；不据卡片可见就认正文链路必然正常 |
| Devin 新版多输入框、额度读取、Fusion 监听释放 | 已统一实际 composer 归属、按使用者持有同一 store 订阅 | `docs/problem.md` 第 68 节；B01 是另一条原生审批展示缺陷 |
| Codex 后台额度入口、整轮 token／速度、分叉统计 | 4 文件方案已实施，13 项配对场景及 997 项检查通过；统计按原生上报更新 | `_shots/codex-statistics-fix-20261112/report.json`；不重新计算逐 token 估计速度 |
| Codex 后台设置、分叉、MCP、Retry 和恢复选择 | 既有后台接入及专项已实现；实际云端容量不足与部分账号场景仍缺现场 | 既有 settings/fork、background-gaps 报告；B02／B05 与新缺口单列 |
| Devin Fusion 空主会话被过滤、原工作台导航身份混用 | 原生 sessionId 打开及 v449 主控真实导航 target 已接入；普通导航身份与工作台管理身份分开 | 原始 Fusion 空线程失败不能自动改成完整真机通过；新 B03／B04 保留暂缓 |
| 工作台偶发两个用户气泡、等待中且草稿保留 | 用户要求跳过当次复现，未取得本次原生提交／回执证据。先沿共用发送链按请求与原生消息 ID 对照；不以删除待发气泡冒充提交成功 | 与已修 Markdown／队列确认的表象分开；Fusion 场景暂缓 |
| 速度展示遮挡按钮、状态条影响输入框位置 | 先前已确认展示方案：速度移出按钮行，状态条出现／消失不改变内容位置；本次未重新核对实现与手机验收，不补记已修复通过。复发时比较状态出现／消失与正文、输入框几何位置 | 原方案要求状态条出现／消失不顶起内容；手机布局暂缓 |
| 隐藏文件滑块、模型名称长度、卡片状态底色／边框／下沿提示 | 先前分项界面需求保留原方案：选择器按用户开关过滤隐藏项、模型名限宽省略、卡片按状态配色和边框、提示放下沿；本次未逐项复验，不补记手机通过 | 复发需原版本及实际布局证据，不列入后台缺陷盲改 |
| 文件监听触顶与排除目录 | 后续用户级排除设置已配置，旧订阅释放及各进程剩余占用仍待实际核对 | 统一归 E01，不重复提高系统限额 |

### 已完成的全仓重复整改：保持原方案逐项记录

原 [v448 静态重复问题与修复记录](static-duplication-fixes-v448-20261112.md) 的 **31 项（含追加 U03）** 完整条目与修改方案合并如下，保留 P1／P2／P3、精确文件范围和当轮验证状态。下表原编号属于静态专项命名空间，与本文同名编号分别引用；不重复计入 28 个待改文件：

| ID | 级别 | 问题、基线位置与修改范围 | 方案 | 状态 |
|---|---|---|---|---|
| C01 | P1 | `server/page/chat-extract.js:193–214`、`server/apps/codex.mjs:247–267`、`server/page/composer.js:2–42`；`scripts/codex-submit.test.mjs` | 读取当前原生提交事实，修正提交能力定位或状态归属；卡片复用正文入口，保留排队、追加、原生确认和附件。用现有测试与配对浏览器验证，不以更换错误文案代替修复。 | 已修复输入目标不一致；回归及三次卡片发送通过 |
| N01 | P1 | `lib/live.mjs:38–46`、`push-service/index.mjs:263–276`、`ios/Shared/AgentActivityAttributes.swift:14–16` | 推送序列化保留 iOS 必填 `computer` 字段；统一 JS 通知目标规则并提供跨语言契约样本。 | 已修复；字段契约通过；APNs/iOS 真机未验 |
| D01 | P2 | `app/js/core.js:405–411`、`server/operations.mjs:21–27` | 提取共享桌面操作策略，前后端只提供应用及模式。 | 自动检查及模型菜单、终端、发送通过 |
| D02 | P2 | `server/routes.mjs:110–492`、`server/apps/opencode.mjs:206–402`、`server/session.mjs:592–623` | 统一路由解析入口和元数据；原生聚焦、窗口租约与 OpenCode HTTP 行为保留各自归属。 | 自动检查及四应用受影响分支通过 |
| D03 | P2 | `server/http/api.mjs:39–63`、`server/overview-actions.mjs:39–67`、`server/fusion/agent.mjs:123–147`、`server/session.mjs` | 共用临时 Session 生命周期，保留输出通道及 Fusion 绑定差异。 | 自动检查及 Cursor/Codex 真实重命名通过 |
| C02 | P2 | `server/agent/context.mjs:7–29`、`server/page/composer.js:72–89` | 输入框定位使用同一选择规则，聚焦动作仍显式执行。 | 自动检查及三应用真实发送通过 |
| C03 | P2 | `app/js/composer.js:653–687` | 合并普通发送与立即追加的草稿、回执、临时气泡和滚动操作。 | 自动检查及正文、卡片、排队发送通过；立即追加实机未另验 |
| C04 | P2 | `server/agent/chat.mjs:639–670`、`app/js/composer.js:138–160`、`app/js/history.js:636–666` | 明确回执身份并共用同义文本匹配；保留队列原文与 Markdown 正文载荷区别。 | 自动检查及真实回执、草稿收敛通过 |
| C05 | P2 | `lib/session-library.mjs:26–32`、`app/js/sheets.js:68–96` | 共用会话引用解析，业务过滤仍由调用者处理。 | 自动检查及会话导航、管理通过 |
| F01 | P2 | `server/agent/files.mjs:173–208`、`server/http/transfer.mjs:42–49` | 提取预览数据构建；路径访问、传输和异步 Git 标记不合并。 | 自动检查及正文/传输高亮、PDF 通过 |
| F02 | P2 | `app/js/voice.js:121–153`、`app/js/transfer.js:221–246` | 共用二进制 XHR 上传，保留进度、取消和各业务超时。 | 自动检查及真实上传、取消通过；语音未测 |
| F03 | P2 | `lib/file-actions.mjs:17–28`、`server/http/transfer.mjs:72–89` | 仅共用冲突文件名生成；上传原子占位保持。 | 自动检查及重命名/跳过/替换上传通过 |
| F04 | P2 | `server/http/api.mjs:215–221`、`server/agent/chat.mjs:757–837`、`server/apps/opencode.mjs:202–204,308–315` | 统一上传暂存记录筛选与删除；删除所属 UUID 目录，清除 Map 记录。 | 缺陷回归及 Codex/OpenCode 暂存目录删除通过 |
| F05 | P2 | `app/index.html:171`、`server/http/api.mjs:224–228`、`server/opencode/attachments.mjs:10–13`、`lib/files.mjs:221–235` | 按上传、预览、模型转换用途定义共享文件类型规则，不扩大原支持范围。 | 自动检查、文件类型接入和拒绝 exe 通过 |
| F06 | P2 | `server/page/common.js:161–187`、`app/js/markdown.js:3–19`、`server/page/build.mjs` | 共用本地文件引用判定及代码块结构，保留两端解析和清洗职责。 | 自动检查及本地链接、代码块、文件高亮通过 |
| W01 | P2 | `server/windows.mjs:9–39`、`server/fusion/agent.mjs:57–64` | 共用底层原生目标发现；普通合并窗口列表与 Fusion 载体列表分别构建。 | 自动检查及三应用载体发现、Fusion 创建通过 |
| W02 | P3 | `lib/files.mjs:122–141`、`lib/notify.mjs:235–243`、`app/js/sheets.js:295–306` | 共用窗口标题解析，保留项目路径、通知名和显示名差别。 | 自动检查及窗口/项目标题展示通过 |
| W03 | P3 | `server/apps/cursor.mjs:91–104`、`server/apps/devin.mjs:291–309` | 共用队列悬停、操作定位和点击流程；保留原生允许动作和刷新行为。 | Cursor 删除与未执行通过；Devin 删除回执与移除通过 |
| W04 | P3 | `server/page/codex.js:98–109,227–260` | 共用 Fiber 遍历原语，保留 props 与 memoCache 查找条件。 | Codex 96 项回归及真实发送通过；附件原生 Fiber 分支未逐项实测 |
| A01 | P2 | `lib/auth.mjs:11–18,307`、`server/config.mjs:22–24`、`cli/fixed-entry.mjs:43–47`、`server/index.mjs:50–58` | 配置读写统一归属 `lib`，去除重复读取和重写；明确损坏配置的处理，不吞错。 | 自动检查、隔离 QA 配置读取启动通过 |
| A02 | P2 | `lib/auth.mjs:336–357`、`server/util.mjs:21–26`、`server/config.mjs:30–34` | 共用入口地址解析，保留 CLI/环境变量优先级与 relay 回落用途。 | 自动检查及既有配对入口接入通过 |
| P01 | P2 | `cli/fixed-entry.mjs:78–85`、`server/publish/pages.mjs:48–76` | 首次发布和后续更新共用 Pages 文件同步；创建仓库与启用 Pages 独立。 | 同步真实函数的 API 契约回归通过；未实际发布 |
| U01 | P2 | `server/fusion/owner.mjs:51–69,106–139`、`server/fusion/control.mjs:105–132,142–171` | 每次视图构建共用 run 索引，无跨请求缓存。 | 自动检查及真实只读子任务、审核、交付通过 |
| U02 | P2 | `server/fusion/runner.mjs:205–247` | 共用执行结果基础字段赋值，主控/任务的领域状态变化独立。 | 自动检查及主/子执行结果收敛通过 |
| N02 | P2 | `lib/live.mjs:59–66`、`app/sw.js:67–92`、`android/app/src/main/java/com/agentremote/NotifyService.java:339–349,438–441`、`ios/AgentRemote/Push.swift:111–119` | 共用 JS 通知目标与 key；各原生平台用自己的单一目标描述；跨语言使用相同契约样本。 | 自动检查及字段契约通过；原生构建/推送真机未验 |
| T01 | P2 | `scripts/session-lifecycle.test.mjs:8–14`、`scripts/structure-fixes.test.mjs:20–30`、`scripts/fusion-agent.test.mjs:15–35` | 共用源码片段读取和 page VM 夹具，不复制产品实现、不修改原断言含义。 | 最终 965/965 通过；快照不变 |
| S01 | P3 | `app/js/approval.js:26–33`、`app/js/sheets.js:909–918` | 共用二维码 Canvas 绘制。 | 配对浏览器 Canvas 像素核对通过 |
| S02 | P3 | `server/http/video.mjs:10–18` | 共用媒体授权 URL 构建。 | 自动检查及 PDF 授权访问通过；视频未另实测 |
| S03 | P3 | `server/agent/context.mjs:68–73,224–229` | 移除无引用的重复点击函数，保留现有 tapCss。 | 静态无引用核对、删除及自动检查通过 |
| S04 | P3 | `app/js/sheets.js:1183–1194` | 共用空配额视图。 | 缺失/空额度菜单实际展示通过 |
| U03 | P1 | `server/fusion/owner.mjs`、`app/js/fusion.js`、`scripts/fusion-navigation.test.mjs`、`app/index.html`、`app/sw.js` | 由真实主会话 Binding 输出导航 target；卡片反馈和打开共用该 target，工作台管理仍使用工作台 ID。 | 已实施；33 项导航、164 项受影响回归及实际工作台／普通会话往返通过 |

初轮全功能的“引用文本分段重复”和“README 能力说明”并未被上述同名编号自动覆盖，当前仍有对应实现／声明，已明确收进 DP01／DP02。

历史问题的其余版本记录以 [问题登记](../problem.md) 为索引；遇已有后续修复的旧失败，沿用最新有证据结论。上述状态不包含尚未执行的发布、正式服务重启或用户手机验收，实施与验收记录后续更新到本文件对应编号。


## 11. v451 批量实施与统一验收记录

用户确认完整方案及两次范围扩展后实施。以本轮开始时的工作区为比较基线，保留原有未提交改动；未修改其他 Agent／插件、page 导出快照或系统监听限额。范围审计未发现越界文件，完整本轮差异保存于 `_shots/full-plan-implementation-20261112/implementation.patch`。

### 实施结果

| 编号 | 最终实现 | 验证结果 |
|---|---|---|
| B01 | Devin 权限请求携带 provider、会话、存储 key 与原生 optionId，共用现有请求区域与回执 | 配对浏览器真实允许一次、拒绝均结束；A→B→A 不串请求。永久授权选项只核对映射，未实际执行 |
| B02 | Codex 进程断开保留正文，展示中断待核对；停止先恢复有效线程及轮次 | 仅杀本轮自有生成进程；页面退出 busy、正文保留；停止恢复成功，原用户消息仍只有一条 |
| B05 | MCP 按 schema 还原 boolean／integer／number／enum，保留 accept／decline／cancel | 类型、false、0、默认值、非法输入和取消受控回归通过；本轮未产生真实远端 MCP 表单 |
| B06 | OpenCode 原生 retry 原因、次数、下次时间映射到已有 notice | 停止临时模型后真实产生 retry；配对页可见，停止后 busy 与提示均清除 |
| PS01 | 失败导航不再删除上次成功的持久选择；保留原失败收尾 | 四应用实际失败导航及重新进入通过；检查等待到成功记录落盘后再比较 |
| PS02＝C02 | 复用窗口切项目纳入既有 reopening 就绪阶段；deferred 绑定不再提前打开 Cursor 会话 | 关闭自有 B 载体，点击刷新后的 dormant 收藏卡，实际复用 A 载体打开 B；核对原生 cwd 与线程，约 1.65 秒就绪 |
| PS03 | Cursor 原生命名后使用原生元数据提交函数同步已加载数据和持久目录，再读取确认 | 同一列表操作两个测试项目，原生标题、目录和会话身份均正确；回归将内存与持久目录分开建模 |
| PS04 | Devin 管理直接读取原生能力并调用 rename／archive／delete；共用既有管理回执 | 跨项目 A／B 重命名与主页归档 B 通过；操作不依赖对应菜单是否挂载 |
| PS05 | 原生 removed 已确认时，缺失条目不再被当成未知清理结果 | 真实删除隔离会话后，相同 Binding 清理返回 already；unknown／not ready 仍由原回执规则报告 |
| Q01 | 活动轮中立即执行队列先中断并等待原生终态，再核对队列身份及启动 | 配对页点击“立即发送”并确认；真实目标执行，队列条目移除，用户消息恰好一条；并发顺序由回归覆盖 |
| CARD01 | Devin 摘要和正文共用 streamingMessageId 分组拼接 | 真实分片与原文逐段比对通过，卡片摘要和正文不再因分片额外插入换行 |
| QN01 | Codex 请求探测先核对应用归属，不再遮盖 Cursor 原生问卷 | Cursor 真实 ask_question 显示、跨会话隔离、选择并提交通过 |
| QN02 | Codex 答案草稿按电脑／应用／会话／请求／字段保存；成功回执清理原请求 | 真实问题输入文字后 A→B→A 恢复；提交成功清理，迟到回执与失败保留另有受控回归 |
| QN03 | OpenCode 多选和自定义输入接入同一答案草稿；现有回执分发到统一收尾 | 真实两题、多选、自定义输入跨会话恢复，答案收到后草稿清除 |
| C01 | Cursor 普通发送复用已有 native submit 与接收确认；保留普通草稿归属 | 真实正文发送成功；这只能验证新链路，不等于已经还原旧偶发事件的完整触发条件 |
| DP01 | Codex／Devin 原生文件引用共用文字分段执行，原生插入由各适配器提供 | 分段顺序、异步插入和原有字面文本行为回归通过；未另做两应用全部引用场景真机验收 |
| DP02 | 中英文 README 的后台／窗口、Fusion provider 声明与实现一致 | 文档及当前 provider 注册核对通过 |

### 配对浏览器及检查边界

使用既有配对浏览器身份和独立 QA relay（3971），不重新配对；隔离页以 402×874 手机视口加载 v451。真实 iPhone／PWA 生命周期不以该浏览器模拟代替。Devin 测试窗口配置本机直连，未使用代理。

- Codex／Cursor／Devin 普通真实发送及原生回执通过；OpenCode 使用临时 Bonsai 模型实际生成并回答问题。
- 四应用模型菜单和同一线程历史读取通过。复用窗口恢复按原生项目目录、线程和载体逐项核对。
- 四应用折叠卡片分别连续打开／返回三次，无卡住或串会话。本地 QA 样本耗时：Codex 6—86ms、Cursor 165—489ms、Devin 167—247ms、OpenCode 82—83ms；这些不是手机公网／长会话性能承诺。空闲后进入“不常用”分组时，先展开分组再点击真实卡片。
- 本轮未重新构造超长会话；长内容、反复打开长会话及网络边界沿用原性能报告，不扩大通过结论。
- 初轮检查脚本的错误请求名、请求 ID 和隐藏分组定位已单独记录并修正；未把这些脚本失败当成产品缺陷。实际复现的 Cursor 目录持久化及 deferred 打开顺序问题均在批准范围内修复并重验。
- 最终 `npm run check` 完整通过：语法、消息协议、196 个 page 导出和 1032 项测试。两次并行运行出现不同 Node 子进程 SIGILL，未有断言失败；最后仅通过临时 Node 启动器将测试文件串行执行，源码、测试集合和断言不变。日志：`_shots/full-plan-implementation-20261112/final-check-serial.log`。

原始检查、最终场景结果和证据保存于 `_shots/full-plan-implementation-20261112/`。自动回归、受控类型测试、原生接口和配对浏览器结果分别记录；未执行的 MCP 远端表单、永久授权、第二电脑、语音、真实额度耗尽、自然手机断连及多平台分支不记通过。B03／B04 继续暂缓，未改 Fusion 执行策略或原生压缩策略。

### 清理与生效状态

- 本轮 Codex、Cursor、Devin 测试会话已归档，OpenCode 测试会话及两次临时删除样本已删除；自建窗口、本轮监听和 QA relay 已关闭，清理无错误。
- 临时本地模型已停止，18080 不再监听；共享 OpenCode 服务保持运行。
- 原 Cursor／Devin 窗口和原线程仍在；原配对页的应用、会话、草稿及存储核对一致。
- 正式 relay 3939 和旧 QA 3949 未重启、保持运行。当前工作区 v451 尚未提交、推送或发布，服务端改动需后续加载到正式 relay 才能在手机使用。


## 12. v452：关闭旧监听与补齐 MCP 选项字段（2026-11-13）

用户明确要求直接关闭旧监听、修复 MCP，暂停第 3 项未定位问题及 SIGILL 调查；随后确认本节 8 文件范围。没有把“本地模型负载导致崩溃”的推测登记为已确认根因。

### 数量口径

- **16 项已确认功能缺陷**是 B01—B06、PS01—PS05、Q01、CARD01、QN01—QN03；PS02 包含 C02，只计一次。
- **14 项已实施**来自这 16 项扣除仍暂缓的 Fusion B03、B04。B05 在 v451 完成基础类型处理，本次发现并补齐带标题选项及数组字段，仍归同一问题，不另增编号。
- **2 项低优先级整改 DP01／DP02 已完成**，不包含在“14 项功能缺陷”中。
- **31 项既有静态整改记录**属于此前已完成的专项，完整保留在第 10 节，并非本轮新增的 31 个待修问题。平台／验收边界仍以各条记录为准。

### 旧监听关闭

通过 Code 现有 FileService 的原生 Disposable 关闭 6 个旧递归请求：CWM、Contact_track、supermimic_vibed、remote-agent 及两个窗口各自的 `/usr/lib` 请求。原请求的 excludes 只有 6 项默认规则；新请求的 20 项生效规则继续保留。没有重载 Code 窗口、重启正式 relay、修改其他 Agent 源码或改变用户设置文件。

复核：两个窗口中旧请求均已从 provider 请求列表移除，新配置的项目递归请求仍在。关闭后的内核占用仍约为 49,690／8,140，不能宣称所有无用监听已释放或资源问题已经完全解决；本节只确认用户授权的 6 个旧订阅已关闭。该操作作用于当前窗口运行时，扩展或窗口重新启动后若注册新的大范围请求，需按新请求核对。

证据：`_shots/mcp-watch-followup-20261113/closed-watchers.json`、`watch-stable-counts.json`。

### MCP 根因与修复

当前 Codex 原生协议允许 `oneOf` 的 `{const,title}` 单选、`enumNames` 标题，以及 `type: array` 配合 `items.enum`／`items.anyOf` 的多选。原适配器只识别直接的 `enum`、布尔和数值，导致选项标题缺失、多选渲染为文本、答案以字符串返回。当前原生协议导出与实际旧函数的复现位于 `_shots/root-cause-followup-20261113/`。

已按确认范围完成：

| 文件 | 修改 |
|---|---|
| `server/codex/state.mjs` | 共用原生选项映射；保留标题、默认值和多选元数据；按选项原值回传数组；沿原失败回执报告无效选项或原生数量约束 |
| `app/js/history.js` | 现有请求表单使用原生多选控件；统一读取／恢复字段值，使答案草稿及提交载荷保留数组 |
| `scripts/codex-backend.test.mjs` | 当前原生单选／多选结构、标题、默认值、类型、失败保留及拒绝／取消回归 |
| `scripts/structure-fixes.test.mjs` | 现有字段夹具支持 select；验证多选草稿恢复和共用请求动作的数组载荷 |
| `app/js/core.js`、`app/index.html`、`app/sw.js` | 统一 v452；只递增变更的 core／history 脚本引用 |
| 本文档 | 记录补齐结果、旧监听操作与 16／14／2／31 的口径 |

验证：受影响 345 项回归通过；最终 `npm run check` 以同一套测试串行运行，**1035／1035 通过**，page 导出快照保持 196 项。既有配对浏览器 v452 完成带标题单选、多选默认值、A→B→A 恢复、数组／false／0 回传、失败保留、接受／拒绝／取消验证，页面无脚本错误或待发消息。

配对检查使用当前原生协议允许的受控请求，经过实际 QA relay、前端表单及答复链路；未把它记为真实外部 MCP 服务器产生的表单或永久授权实测。初次取消检查曾抢在旧表单消失前读取，后按请求身份重验通过，没有因此改动产品时序。

截图、回归日志及回执：`_shots/mcp-watch-followup-20261113/{mcp-form.png,paired-mcp.json,affected-check.log,final-check.log}`。本次未启动本地模型；自有测试线程已归档、QA 服务与监听已关闭；原配对页应用、线程、草稿和存储一致。正式服务未重启，尚未提交、推送或发布。

## 13. v453：2／3／4／5 补查问题修复（2026-11-13）

以提交 `d93c110` 后的工作区为基准，已实施本节七项修复。用户已确认原 20 文件范围，以及公共表单解析的 3 文件、Fusion 导航测试夹具的 1 文件扩展，共 24 个文件。未修改其他 Agent 或 `scripts/page-exports.json`。

### 实施结果

| 编号 | 根因及修改结果 |
|---|---|
| N02 | Cursor 内存目录遗漏未加载历史。打开前改查原生持久化目录；会话菜单、NativeWindow 缓存复用同一目录，保留分组、归档状态和项目资料。重命名／删除先加载目标句柄。 |
| N03 | 批量请求排队时尚无批次身份，提前取消不能命中。WebSocket 接收时建立批次，执行和取消沿用相同 requestId；未执行或异常退出释放对应批次。 |
| N04 | OpenCode 独立批量循环缺少统一的取消结果。改用已有 batchSessions，复用逐项结果、剩余目标保留和 cancelled 标记。 |
| N05 | OpenCode 已选目标被外部删除后仍解引用旧目录。现在返回明确的“会话已不存在”单项失败，并继续其他目标。 |
| N01 | Fusion 将错误项目的原生会话过早保存为绑定。先核实实际目录再保存绑定；仅 Cursor 缺少匹配项目窗口时复用 Session 项目打开流程。Codex、Devin 保留原生创建请求指定 cwd 的行为。 |
| B03 | 正文读取异常阻断原生执行状态核验。先核验原生轮次；已结束时采用原生结果，运行中正文异常单独记录 contentError，恢复后清除，避免正文故障代替执行事实。 |
| B04 | Cursor／Devin 后台问答缺少绑定线程的答复入口。Cursor 接入原生选项、多选、自由文字、提交和跳过；Devin 接入真实 ACP elicitation 请求及原生回执。Fusion 问答状态计入普通问答列表，答复复用原生通道，不发送伪用户正文。 |

Devin 与 Codex 的 MCP 表单共用 `lib/shared-rules.mjs` 中的 `elicitationFields`，由 `server/page/build.mjs` 注入同一实现；保留枚举标题、多选、数组、false／0 和原有类型转换。Fusion 前端复用历史问答已有字段读写函数。`scripts/fusion-navigation.test.mjs` 仅补齐夹具加载，原断言不变。网页相关版本统一为 v453。

### 自动回归与配对浏览器结果

- 最终 `npm run check`：**1046／1046 通过**；语法、消息协议和 196 项 page 导出检查通过，未改导出快照。首次受限执行环境无法启动语法检查子进程，改用允许执行检查子进程的环境后完成；不计为代码失败。
- Cursor 冷历史：第二窗口内存未加载的历史可打开，原生持久化历史在菜单中可见。
- 四软件批量：受控 WebSocket 回归覆盖等待队列期间取消；配对浏览器覆盖空闲批量和首项原生操作完成后取消。另覆盖 Cursor／Devin 部分成功部分失败、OpenCode 选中后外部删除及其他目标继续成功。
- Fusion 项目：真实 Cursor 跨项目创建落到正确项目窗口，创建会话实际目录一致。受控回归覆盖错误目录不落绑定、重新创建正确绑定，以及 Codex／Devin 沿用原生 cwd 创建。
- Fusion 完整生成：实际 Codex 主控向 Cursor Auto 派发两个有依赖关系的只读任务，完成真实执行、审核和交付；fixture.js 哈希不变。首次指定 Sonnet 时原生返回区域不支持错误，已保留失败记录，之后明确指定 Auto，未把原生错误吞掉或登记成功。
- B03：三软件正文读取故障与原生轮次结束的受控回归通过；未宣称复现了用户设备上的自然正文故障。
- Devin 后台问答：真实 SWE-2 High 调用 ask_user_question，服务端记录 awaiting_user。使用受控主控、产品现有表单渲染器和既有配对浏览器实际选择“甲”并提交，经过真实 WebSocket／Fusion 绑定路由／ACP 回执后，原生继续执行并返回 `native-question-ok:甲`；待决请求和工作台交互数据清空。该项验证了答复通道，不把受控主控登记为真实主控派工。

### 尚未通过的验收边界

1. Cursor 实际模型触发 AskQuestion 的完整后台交互：受控原生结构回归通过，但此次 sidechat 未提供该工具，真实提问未触发；不登记为实测通过。
2. Devin 问答的完整主对话页面展示／消失：电脑卡住后，测试页重开主对话曾停在加载中；虽已验证真实原生答复和后续完成，最终表单采用受控呈现，完整页面生命周期仍待正常场景验收。未为此扩展产品修改范围，也未将卡住归因于网络或硬件。

第二电脑、自然手机断连、语音、多平台及 Devin 原生空会话保存限制继续按用户要求不处理。本轮 Devin 生成始终使用本机网络；本地 OpenCode 模型未启动。

证据分两阶段保存：

- `_shots/confirmed-2345-fixes-20261113/`：冷历史、四软件批量、跨项目、故障注入及第一阶段清理记录。
- `_shots/confirmed-2345-final-20261113/`：`final-check.log`、`cursor-partial.log`、`fusion-auto-complete.json`、`cursor-error.json`、`question-browser-result.json`、`question-native-result.json`、`devin-native-question.png` 和清理记录。

清理完成：本轮原生测试会话已删除／归档，后台 Codex 测试线程已归档，3 个自有 Fusion 工作台停止；隔离 3979／3980、测试标签、自有 Devin 和恢复出来的测试 Cursor 窗口均关闭。3939、原 3949 和共享 OpenCode 4096 正常，本地模型 18080 保持关闭。原配对页应用、会话和草稿与快照一致；存储键集已发生变化，未强行覆盖，差异键名和长度记录在 browser-storage-diff.json，不将其标为“全部存储未变”。

电脑卡住后由用户恢复正式 3939；本轮后续只重启隔离 QA 服务。未提交、推送或发布。

## 14. Codex 跨项目打开与会话页重连误入后台入口（2026-11-13）

用户确认三文件范围：`server/session.mjs`、`scripts/session-lifecycle.test.mjs`、本文档。

根因：打开桌面原生会话时，目标项目没有匹配窗口，或重连时原生窗口目录尚未就绪，`attach` 会先递归连接软件承载窗口，并暂时清空项目和会话目标。Codex 将这个带 `projectSwitch` 的中间请求误判为普通后台入口；后台绑定不持有 CDP，外层随后检查桌面连接时便抛出“所选 Agent 尚未连接，请重试”。目标项目窗口已打开且目录就绪时绕过该路径，解释了手动打开窗口后恢复的现象。

修改：普通 Codex 后台入口排除 `projectSwitch` 中间请求；项目连接复用已有桌面承载、项目打开和会话恢复流程。真正的后台托管会话与普通后台入口保留原路由。Cursor、Devin 不经过 Codex 后台分支，纳入同类连接回归。

验证范围：三软件仅有 A 窗口时打开 B 项目、目录未就绪时冷重连、已有原生连接恢复；Codex 已有匹配项目窗口、默认后台入口及后台线程恢复。以上为连接分流的受控回归，不将窗口操作夹具登记为真实原生或手机验收。最终 `npm run check` **1050／1050 通过**，语法、消息协议及 196 项 page 导出检查通过；`git diff --check` 通过。日志位于 `_shots/project-reconnect-20261113/final-check.log`，修改前的定向复现结果保存在同目录 `attach-repro.json`。

本次实际修改限定为上述三文件，保留此前工作区改动；未改前端版本、未提交或发布。正式 3939 尚未重启，手机上跨项目打开、会话页切后台再返回的验收待服务生效后由用户执行。

## 15. v454：Codex 普通本地旧会话无窗口恢复、Devin 模型控件归属（2026-11-13）

基准提交 `c0bdb06`。用户确认 10 文件范围及验证通过后重启正式 3939：`server/session.mjs`、`server/codex/state.mjs`、`server/apps/codex.mjs`、`server/agent/projects.mjs`、`server/overview.mjs`、`server/page/menus.js`、`scripts/codex-backend.test.mjs`、`scripts/session-lifecycle.test.mjs`、`scripts/structure-fixes.test.mjs`、本文档。

### 根因与实施

- Codex 原生 `thread/resume` 可以恢复非 RA 创建的持久化会话；RA 的 `CodexState.load` 原先只接受 records 中已有的会话，普通旧会话因而一直走桌面路径。现在复用同一加载流程，核对返回 ID 及已有记录目录，保留原 ID、历史、模型配置和原生队列，恢复后登记后台记录；失败不登记成其他线程，也不复制或另建旧会话。
- 后台绑定在没有显式目标目录时采用原生会话实际目录，避免沿用上次项目或家目录。卡片／正文连接、项目及会话菜单、旧卡片预览统一复用该入口；普通本地旧会话无需先打开项目窗口。Fusion 所有原生绑定及远程会话仍使用其原链路。
- Devin 界面同时挂载可见的 `Normal` 能力模式与 `SWE-2 High` 模型控件。旧代码按按钮文字取到第一个 Normal，优先读取其能力模式菜单。现在先按 `visibleModelConfigs`／`onModelSelect` 原生属性定位模型控件；只有能力模式控件的原有界面仍沿用原行为。模型名称、候选及强度继续复用原有读取与操作实现。

配对验收中追加确认 4 文件：`app/js/overview.js`、`app/js/core.js`、`app/index.html`、`app/sw.js`。卡片分组／状态重绘会暂时移除包含麦克风的旧子树，紧接着的补丁渲染通过 `$('mic')` 查文档而取到 null，抛错后无法重新挂载控件。改为复用既有 `ovComposerControls.mic` 引用；页面版本、core 和 overview 资产引用同步 v454，其他资产版本不变。新增真实子树移除后连续渲染的回归。

### 验证记录

- 修改前的协议核实：两个独立原生进程按同一 ID 恢复未登记于 RA 的空会话，目录一致、原生队列可读，无模型生成、无项目窗口；测试线程已归档。记录：`_shots/legacy-codex-devin-model-20261113/native-resume.json`。
- 受影响回归 426 项通过；覆盖旧历史与队列保留、并发只恢复一次、恢复失败／返回错误 ID、不串用上次目录、三软件连接、Fusion／远程归属、无对应窗口的卡片预览及 Devin 双控件／云端单控件。
- 现有 Devin 窗口只读实测：模型由 Normal 恢复为 SWE-2，原生 ID 仍为 swe-2-high，强度 High 选中，实际候选模型 38 项；未切换用户模型或发送消息。
- 既有配对浏览器使用独立测试标签完成 10 个场景：未登记原生旧会话历史、另一项目旧会话、折叠卡片真实点击、展开卡片真实发送并收到回复、反复 A／B 打开关闭、会话菜单切换、会话页实际断线重连、受控隐藏／返回并重连、原生窗口数量不增加、Devin 模型与强度菜单。Codex 全程绑定 backend，保留原会话 ID；最终 v454 卡片发送后 pendingSends 为 0、麦克风已挂载、测试页无脚本错误。前后台分支通过浏览器可见性事件及真实 WebSocket 关闭模拟，不登记为手机系统自然断连实测。
- 初始卡片测试未展开空闲／不常用分组，且测试概览与渲染等待不完整；修正脚本后重验。实际复现的麦克风脱离文档缺陷经用户确认扩展后修复，v454 使用重新加载的正式资产验收，未把仅在测试页预览的补丁登记为产品通过。首次可见重连的瞬时未认证状态已被自动重连越过，改查新旧 socket 身份核对重连。
- 最终 `npm run check` **1059／1059 通过**，语法、消息协议、196 项 page 导出及 `git diff --check` 通过。一次并行运行中未修改的 codex-submit 测试进程以 SIGSEGV 退出；清理隔离资源后原命令重跑通过，未修改产品代码压制该退出。保留首次日志 check-process-exit.log。
- 正式 3939 已按授权重启，HTTP 正常，入口、core、Service Worker 均提供 v454；隧道 PID、公开地址和配对密钥校验值一致，启动无警告。未新增配对、未提交或推送。本轮尚未发布 Pages；服务端修复已生效，Pages 入口取得 v454 卡片前端修复仍需发布网页。
- 两条自有原生测试会话已归档，3979／3980 隔离服务关闭，本轮原生监听清除；原配对页应用、会话、草稿、存储及浏览器权限恢复核对一致。正式 3939、原 3949、共享 OpenCode 4096 正常，本地模型 18080 保持关闭。Devin 本轮只读核对与菜单检查，未生成或切换用户模型。

证据目录：`_shots/legacy-codex-devin-model-20261113/`，主要结果为 acceptance-summary.json、paired-final-results.json、paired-follow-results.json、devin-read-after.json、final-check.log、formal-restart.json、formal-verify.json、browser-cleanup.json、qa-cleanup.json；截图为 devin-model-menu.png、legacy-codex-v454.png。
