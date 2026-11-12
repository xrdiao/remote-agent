# v448 静态重复问题与修复记录（2026-11-12）

## 授权、基线与原则

用户已确认按静态排查方案逐项处理 P1/P2/P3，最后用既有配对浏览器统一检查修改内容。基线为 `95e0ea4`（v448）；基线工作区只有既存未跟踪的 `opencode-web.js`，不修改该文件。不提交、不推送。卡片继续复用正文的 `sendComposer()`，不另写发送实现。

从实际数据归属、调用时序和状态找根因；共用纯规则和已有能力，保留应用、平台及业务语义差异。不新增兼容层、延时重试或吞错措施。`scripts/page-exports.json` 不改。表内源码位置为基线行号，改后以函数名定位。

## 问题及文件计划

状态：待处理 / 已修改 / 自动检查通过 / 配对浏览器通过 / 环境受限 / 重新核对后保留。候选经实施核对不成立时，记录理由，不为凑数量制造抽象。

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

共用纯规则按运行环境放入 `app/js/shared-rules.js`（前端脚本、Node 导入及 page 构建按现有加载方式接入）；仅服务端 helper 放 `lib/` 或所属服务模块；测试 helper 放 `scripts/`。必要的加载声明在 `app/index.html`、`app/approve.html`、`app/sw.js`、`server/page/build.mjs` 及版本 `app/js/core.js` 一并调整。具体新文件、最终文件范围和实际差异在收尾记录。

## 检查与验收

1. 用户要求取消修改前检查，已同步移除 AGENTS.md 的前置检查要求。检查日志放 `_shots/static-duplication-fixes-20261112/`。
2. 使用实际 diff 对照基线，检查没有改变已有领域语义、没有另建卡片发送链路、page 导出快照不变。
3. 对有状态变更和已确认缺陷补必要回归；纯函数抽取以既有断言验证，不为低影响变化堆重复测试。
4. 最后统一 `npm run check`，不反复运行已通过且未受后续改动影响的检查。
5. 复用 `_shots/paired-browser.json` 登记的已有浏览器身份及隔离 relay，检查卡片/正文发送（含排队、立即追加及草稿）、会话导航、文件预览与上传/取消/删除、模型与配额菜单、二维码、终端、Fusion 受影响流程。Devin 如需生成保持本机直连。语音不测；不自行启动用户已停的 OpenCode 本地模型。
6. 发布端、APNs、Android/iOS 原生及网络依赖分支，有实际执行才记通过；浏览器验收不能代替 iOS 解码、Android 构建、Pages 真实发布或手机真机。

## 执行记录

以下按实施阶段保留核对过程，最终结果见文末。

## 实施核对与阶段结果

- 用户追加要求：已删除 AGENTS.md 中修改前检查要求，保留修改后检查。第一次沙箱内前置检查因禁止子进程而未实际执行；后续已启动的前置检查按用户要求取消，不作为基线通过证据。
- 共用脚本实际放在 `app/js/shared-rules.js`，使用现有静态 JS 路径，不扩大静态服务路由范围。界面版本暂定 v449；本轮没有发布。
- D03：HTTP 通知操作与卡片管理共用临时 Session 释放流程。Fusion 的项目选择 Session 需要跨请求等待信任确认，继续由 `mainProjects` 持有；其生命周期不能用一次性 helper 替换。
- C04：共用附件标签剥离与服务端空白归一化，保留客户端严格正文比较、服务端采样确认、回执 ID 和原生队列/Markdown 两种载荷归属；没有合并两端状态容器。
- W02：共用 SSH 标题拆解和前端窗口解析。Devin 原生标题、Windows 管理员标记及通知展示形式仍按原用途处理。
- U02：成功/完成的结果基础字段共用；失败和 unknown 的生命周期不同，未强行套入成功收尾。
- N02：独立部署的 push-service 保留自己的字段长度限制实现，并在服务内共用目标字段构建；Java/Swift 保留平台代码，各自收拢重复。字段契约通过同一组实际属性样本核对。
- 结构检查通过：语法、消息协议、196 个 page 导出、导入及静态资源引用。第一次回归 847/959；112 项失败均为新抽取依赖未加载的旧夹具。补齐后仅重跑三个失败文件，401/401 通过，原断言保留。
- 新增必要的缺陷回归 2/2 通过：实时活动保留所有 Swift 必填属性及跨电脑身份；上传删除整个 UUID 目录且保留相邻上传。
- 配对浏览器已使用原身份、独立标签及 QA3951 接通 v449，正式3939和原QA3949没有重启。Devin 仅使用本机网络；Codex/Cursor 保留原网络配置。原生种子消息用于创建验收前置，不计作 RA 发送通过。
- Codex 正文经 RA 已完成一次真实排队发送并收到回复，pending=0。卡片两次提交均有原生用户消息及回复；原卡片夹具误等主页暂停订阅的正文，超时记录保留，改后会重新沿正文可见状态核对。原“提交入口不可用”尚未复现，不能据此宣布根因已修复。

## 最新验收进度

- 用户补充确认：卡片失败而正文可发。查明一处具体代码缺陷：聚焦按当前输入框选择，Codex 提交/写入却取第一个可见编辑器。已统一至 `composerTarget(doc)`，没有新建卡片发送函数，也没有重试、延时或绕过原生禁用状态。新增“第一个可见编辑器被阻止、当前编辑器可提交”回归，并验证原生阻止仍会生效。
- Codex 发送回归 96/96；配对浏览器修正夹具后连续三次卡片发送成功，回执收敛、草稿清空、正文回复可见。该证据验证本次修复，未假称捕获到用户手机原来的偶发现场。
- 当前完整检查 **963/963 通过**；语法、91 个发送类型、82 个接收类型、196 个 page 导出、导入及静态资源检查通过。完整检查前一次 962/963，唯一失败为旧 DOM 夹具没有提供新定位函数所用 `querySelector`；仅补夹具方法，原断言不变。
- 浏览器已通过：Codex/Cursor/Devin 发送及文件高亮；文件传输预览和 PDF；真实上传的重命名/跳过/替换；附件上传与目录删除；图片上传取消；二维码绘制；缺失/空额度菜单；原生模型菜单；终端创建、发送、关闭。OpenCode 通过空会话绑定、附件删除目录、文件高亮及模型菜单，未发起生成，保持本地模型停止。
- Fusion 已通过创建工作台、选项目、读取模型和启用主会话。还在完成真实子任务、审核和交付；不能先记整个 Fusion 通过。
- Pages 新同步流程补了真实函数的 GitHub API 调用契约回归：选择的仓库与分支、只上传变化文件、单次 tree/commit 更新。未实际向 GitHub 发布。

## 追加确认的 Fusion 导航修复（U03，P1）

- 现场：主控会话已启用时，工作台入口以 `win=fusion / threadId=工作台ID` 导航，服务端实际附着到原生 Codex 会话；前端就绪判断因此拿两种身份比较，卡在切换状态。该入口原代码未被本轮前面的抽取修改。
- 用户明确确认追加 5 文件：`server/fusion/owner.mjs` 在 `controllerView()` 输出真实主会话 target；`app/js/fusion.js` 的 `fusionOpenTarget()` 同时供卡片反馈与打开入口使用，保留收藏页和 Fusion 返回位置；`scripts/fusion-navigation.test.mjs` 验证三应用/远程项目目标及导航与管理身份分离；`app/index.html`、`app/sw.js` 同步 Fusion 资源版本。
- 工作台重命名、收藏和删除仍使用工作台 ID。原生窗口、线程与项目路径通过真实 Binding 得到，不在就绪判断里添加 Fusion 特例或重试。
- 原批准范围内的 `scripts/computer-switch.test.mjs` 补新原生目标样本，并把导航断言改为实际 Codex 线程；`scripts/session-lifecycle.test.mjs` 补完整 Binding 项目数据。终端返回、普通会话隔离及 Fusion 附着摘要的原断言保留。
- 回归：Fusion 导航 33/33、受影响三文件 164/164、最终完整检查 965/965。配对浏览器实际点击工作台，从 Cursor 进入 Fusion，再往返普通 Codex 会话和 Fusion 均通过。

## 最终统一验收结果

- 本地版本 **v449**。最终日志：`_shots/static-duplication-fixes-20261112/final-check-965.log`。语法、消息协议、导入、静态资源和 **196 个 page 导出**全部通过，测试 **965/965**。
- 真实浏览器：既有配对身份、独立标签、独立 QA3951。Codex 正文及三次卡片发送；Cursor/Devin 正文发送；普通会话/Fusion 往返；Cursor/Codex 临时 Session 重命名；文件高亮/PDF、本地链接/代码块、传输同名处理、附件上传取消和目录删除；模型/额度菜单、二维码、终端均完成受影响检查。
- Fusion：创建工作台、选项目、启用省钱主控、确认只读方案、派发 Codex 子任务读取验收目录的 fixture.js、读取结果、审核通过、交付完成均有真实持久化记录。原生主会话与子任务均正常收尾；`fusion-delivery-evidence.json` 保留交付及审核证据。文件样本 marker 为旧夹具文本 `RA_V445_AUDIT`，不把该文本当作当前版本依据。
- OpenCode：空会话绑定、附件暂存目录删除、文件高亮和模型菜单通过；没有启动本地模型或生成。
- W03：Cursor 删除排队消息后实际未执行该条内容。Devin 返回 `queueDone.ok=true`，对应队列行移除；原先的 sleep 工具一直未结束，随后已在自建会话清空测试队列并停止。**只记 Devin 删除操作通过，不把其正常生成收尾记为通过。**
- 误判及失败记录保留在 `cases.json`：卡片夹具误等主页暂停的正文；队列夹具起初未确认删除、随后未展开 operation 内的回执；Fusion 往返夹具把异步 history.back 与打开写在同一轮，改为等待返回事件后通过。以上没有靠产品重试或延时修改解决。
- 浏览器仍观察到 `ResizeObserver loop completed with undelivered notifications.`，没有归零或隐藏该原有提示，本轮未扩展修复。
- 环境限制：Ubuntu 没有 Android SDK、Swift/Xcode，未构建 Android/iOS，未做 APNs/iOS 解码或原生通知真机验收；Pages 仅验真实同步函数的 API 调用契约，未实际发布；语音按要求跳过；视频、通知打开和立即追加没有新增真机全分支验收。配对 Chrome 移动布局验收不能替代用户手机真机；测试标签绕过 Service Worker，PWA 安装/离线生命周期未新增实测。
- 正式 relay3939、原 QA3949 均未重启；没有提交、推送或正式发布。后端修改需要后续正式 relay 加载才生效。

## 共用实现归属

| 功能组 | 共用实现 / 候选落地 | 保留的差异 |
|---|---|---|
| 输入与发送 | `server/page/composer-target.js` 的 `composerInputs/chooseComposer/composerTarget`；`app/js/composer.js` 的 `submitComposerReceipt` | 应用原生提交、排队/追加、原生确认各按原语义执行；卡片调用既有正文发送 |
| 路由与临时会话 | `server/routes.mjs:resolveRoute`；`server/session.mjs:withTemporarySession` | OpenCode HTTP 与原生聚焦/窗口租约；Fusion 信任确认所持 Session 生命周期 |
| 跨端纯规则 | `app/js/shared-rules.js`，Node 由 `lib/shared-rules.mjs` 导入，page 只序列化所需两个函数 | 回执严格程度、不同文件用途、平台字段长度限制 |
| 文件 | `server/file-preview.mjs:buildFilePreview`；`lib/file-actions.mjs:collisionPath`；`lib/uploads.mjs` | 路径访问权限、传输、Git 标记、原子占位 |
| 上传与二维码 | `app/js/ui-helpers.js:uploadBinary/drawQrModules` | 进度、取消、各业务原有超时 |
| 窗口与队列 | `server/windows.mjs:editorWorkbenches`；`server/agent/queued-action.mjs:activateQueuedAction`；`server/page/codex.js:codexFibers` | 载体列表与普通列表、各应用允许动作；原有悬停等待未增加 |
| 配置与发布 | `lib/auth.mjs:saveConfig/resolveAppEntry`；`server/publish/pages.mjs:syncApp` | CLI/环境配置优先级；空仓库首提交及启用 Pages |
| Fusion | `server/fusion/run-index.mjs:indexFusionRun`；`server/fusion/runner.mjs:recordAttemptResult`；`app/js/fusion.js:fusionOpenTarget` | 索引限单次视图；主/子任务领域状态；工作台管理身份 |
| 通知 | JS `notificationTarget/notificationKey`；Java `notificationKey/notificationId`；Swift `NotificationTarget` | 独立 push-service 共用服务内 helper，保持可独立部署；各原生平台不跨语言导入 |
| 测试 | `scripts/page-fixture.mjs` | 加载真实产品源码，保留原断言含义 |

## 清理与最终差异

- 已清理本轮创建的 Fusion 工作台及其两条原生绑定、3 条普通验收会话，关闭本轮新建的 Cursor/Devin/Codex 窗口和测试标签，并停止独立 QA3951。原配对标签的草稿、线程与 localStorage 与验收前一致，pending=0；浏览器 loopback 权限恢复原值。OpenCode 本地模型端口18080仍停止。清理证据：`_shots/static-duplication-fixes-20261112/cleanup-results.json`。
- `git diff --check` 通过。`app/app.css` 与 `scripts/page-exports.json` 无差异，原未跟踪 `opencode-web.js` 未修改。下面为相对基线的产品/检查文件清单（不含本记录及既存 opencode-web.js）：

- `AGENTS.md`
- `android/app/src/main/java/com/agentremote/NotifyService.java`
- `app/approve.html`
- `app/index.html`
- `app/js/approval.js`
- `app/js/composer.js`
- `app/js/core.js`
- `app/js/fusion.js`
- `app/js/markdown.js`
- `app/js/shared-rules.js`
- `app/js/sheets.js`
- `app/js/transfer.js`
- `app/js/ui-helpers.js`
- `app/js/voice.js`
- `app/sw.js`
- `cli/fixed-entry.mjs`
- `ios/AgentRemote/ContentView.swift`
- `ios/AgentRemote/Push.swift`
- `ios/AgentRemoteWidget/AgentRemoteWidget.swift`
- `ios/Shared/AgentActivityAttributes.swift`
- `lib/auth.mjs`
- `lib/file-actions.mjs`
- `lib/files.mjs`
- `lib/live.mjs`
- `lib/notify.mjs`
- `lib/session-library.mjs`
- `lib/shared-rules.mjs`
- `lib/uploads.mjs`
- `package.json`
- `push-service/index.mjs`
- `scripts/codex-submit.test.mjs`
- `scripts/computer-switch.test.mjs`
- `scripts/file-actions.test.mjs`
- `scripts/fusion-agent.test.mjs`
- `scripts/fusion-navigation.test.mjs`
- `scripts/opencode-session.test.mjs`
- `scripts/page-fixture.mjs`
- `scripts/session-lifecycle.test.mjs`
- `scripts/shared-contracts.test.mjs`
- `scripts/structure-fixes.test.mjs`
- `server/agent/chat.mjs`
- `server/agent/context.mjs`
- `server/agent/files.mjs`
- `server/agent/queued-action.mjs`
- `server/apps/cursor.mjs`
- `server/apps/devin.mjs`
- `server/apps/opencode.mjs`
- `server/config.mjs`
- `server/file-preview.mjs`
- `server/fusion/agent.mjs`
- `server/fusion/control.mjs`
- `server/fusion/owner.mjs`
- `server/fusion/run-index.mjs`
- `server/fusion/runner.mjs`
- `server/http/api.mjs`
- `server/http/transfer.mjs`
- `server/http/video.mjs`
- `server/index.mjs`
- `server/opencode/attachments.mjs`
- `server/operations.mjs`
- `server/overview-actions.mjs`
- `server/page/build.mjs`
- `server/page/codex.js`
- `server/page/common.js`
- `server/page/composer-target.js`
- `server/page/composer.js`
- `server/publish/pages.mjs`
- `server/routes.mjs`
- `server/session.mjs`
- `server/util.mjs`
- `server/windows.mjs`
- `server/ws.mjs`
