# v445 剩余普通功能补验记录（2026-11-12）

本轮响应“记录两个问题，按排查方案完成剩余内容排查”。依据[全功能方案](full-functional-audit-v445-20261111.md)，衔接[首轮结果](full-functional-audit-v445-20261111-results.md)及 `_shots/acceptance-protocol-20261112/report.md`。本轮是检查和记录，未获修复授权，不应用现有修复草案。

**结论：本机可执行的剩余普通分支已补查，发现问题后保留失败和受阻状态，不能标为全功能通过。** 原两个问题已登记；新增确认 Codex 队列编辑的成功误报，另定位 Devin 的 WebP 原生限制。

## 范围与现场

- 用户明确暂不检查 Fusion、手机自然断连原因、剩余真机／多平台分支和语音。本地 OpenCode 模型保持停止，仅用 4096 的空测试会话检查附件；未重新启动 18080 的模型。
- 复用既有配对 Chrome 9335，专用标签使用独立存储覆盖和隔离聊天库，HTTP、WebSocket 都指向 QA 3950；证据 `connection-route.json`。正式 3939、原 QA 3949 不由本轮重启。
- 认证操作只在本轮 `relay-data` 副本；自有新入口全部撤销，没有移除正式设备。TOTP 密钥与令牌不输出到报告。
- Cursor、Devin、Codex 建立独立项目和原生窗口。Devin 桌面与实际 ACP 子进程没有代理变量，ACP 的 NO_PROXY 为 *；证据 `devin-network-proof.json`。
- 源码基准为本轮开始时的工作区，410 个 app/server/lib/scripts 文件哈希一致；`scripts/page-exports.json` 未改。沿用已通过且未受影响的 916 项检查，不重复跑相同检查。没有提交、推送、发布。

## 补验结果

| 功能 | 本轮结论与边界 | 证据（均在 `_shots/remaining-audit-20261112/`） |
|---|---|---|
| F02 邀请、拒绝、取消、授权、撤销 | 通过。真实 P-256 新入口签名，撤销后 HTTP 401，已认证 socket 以 4001 unauthorized 关闭；不是扫描二维码的手机验收 | `auth-flows.mjs`、`cases.json` F16-entry-invite-deny-cancel-grant-revoke |
| F02 多入口审批与过期 | 通过。同一真实桌面批次批准两个请求；第三个请求等原有三分钟期限实际到期后，授权端及申请端均被拒绝，未修改系统时钟 | `pair-batch.mjs`、`expiry-check.mjs`、`cases.json` |
| F02 二次验证 | 通过。仅 QA 副本设置过期 verifiedAt，错误码拒绝、正确码接受、同一步重复码拒绝、权限恢复；不替代手机 Authenticator 扫码 | `auth-flows.mjs`、`cases.json` F16-totp-wrong-correct-replay |
| F06 Cursor 队列编辑 | 通过编辑、保存、删除链路；生成前置使用原生提交现有测试草稿的夹具，不据此宣布 RA 普通发送全通过 | `cursor-send-follow.json`、`cases.json` F06-cursor-queue-edit-native-start-fixture |
| F06 Devin 队列编辑 | 通过。按原设计从队列取回手机输入框，文本一致，原生队列移除；不要求这一步立即写回电脑草稿 | `queues-other.mjs`、`cases.json` 最终 F06-edit-queue-native-behaviour/devin |
| F06 Codex 队列编辑 | 失败。原生已保存且仍在生成，RA 报未确认保存；后续消息实际执行。单独登记 CODEX-20261112-02，未重试保存 | `queue-stable.json`、`cases.json` |
| F06 Codex 立即追加 | 通过。同一原生活动轮次收到追加用户消息，未变成队列副本 | `steer-fork.json`、`cases.json` F06-codex-steer-real-active-turn |
| F06 Devin 立即发送 | 通过。生成中确认发送，手机及原生都出现同一标记消息，不在队列中；未重发原测试消息 | `devin-steer-follow.json`、`cases.json` |
| F07 生成时阅读历史 | 通过。原生持续输出，滚动位置 9102 保持 9102，内容最大滚动量由 9702 增至 11880，随后正常结束 | `cases.json` 最终 F07-real-stream-free-reading-settled-layout |
| F09 审批拒绝 | 通过。自有 Codex 轮次用同一 IDE RPC 发起人工审批，经 RA 拒绝，同一原生轮次完成并回复 RA_DENIED_DONE，命令无成功执行结果；不是 RA 发送入口的验证 | `approval-follow.json` |
| F09 失效审批 | 通过。真实待处理请求因所属轮次被中断而消失，旧 ID 操作不执行命令；这里是轮次结束失效，不声称原生审批有时间过期机制 | `approval-expired.json` |
| F09 Fork | 通过。真实按钮创建新线程，原生 thread/read 核对真实 cwd 与历史；返回主页后走卡片现有导航处理器重新打开。原 fixture 用 nativeSessionInfo 立即查新 ID 得 null，不等于创建失败 | `steer-fork.json`、`fork-follow.json` |
| F10 保存时换文件 | 通过。真实保存 A 并在磁盘比字节，测试标签扣留真实回执后关闭 A、打开 B，再释放回执；B 的路径、文本和请求 ID 不变。不是跨电脑竞态验证 | `shared-remaining.mjs`、`cases.json` F10-real-save-with-delayed-receipt-switch-file |
| F11 Codex/Cursor/OpenCode 附件 | 通过 PDF、DOCX、XLSX、PPTX、TXT、CSV、JSON、JS、YAML、LOG、JPEG、WebP、GIF 的添加与移除；图片缩略图可解码。PNG/Markdown 与发送样本沿用前轮；这里不证明模型已理解每种文档 | `cases.json` F11-document-and-image-format-families；各应用 last-attachment 记录 |
| F11 Devin 附件 | 文档步骤及 JPEG 已执行至通过，另补验 GIF 通过；整组因 WebP 不被原生接收而不能标全通过。原生明确只支持 PNG/JPG/GIF/SVG | `devin-last-attachment.json`、`devin-format-progress.json`、`devin-webp-native.json` |
| F11 不支持文件／过大文件 | 通过。无害 .exe 样本被服务端拒绝，21 MiB TXT 在上传前拒绝，附件未增加 | `cases.json` F11-unsupported-document-and-size-validation |
| F13 终端密码入口 | 通过。真实新建终端运行 getpass，密码入口提交成功，输入清空，隐藏输入部分没有回显；只用测试字符串 | `shared-remaining.mjs`、`cases.json` F13-terminal-password-input-no-echo |

附件用例只覆盖所列格式；没有有效旧版 `.doc` 样本，不用改后缀的伪文件凑通过。OpenCode 本轮未生成，附件为实际 relay/会话暂存链路，不宣称 file parts 已随新一轮送达模型。

## 已登记问题与未定观察

1. **Cursor 空白首屏与失败绑定收尾**：仍未修复，原生服务发现不应依赖消息节点。七文件草案未应用。
2. **Codex Markdown 发送回执**：仍未修复，未转义载荷与已转义原生回执严格比较导致 pending 不结束，并出现已发送草稿恢复。原两个问题见 [问题登记第 71 节](../problem.md)。
3. **Codex 队列保存误报**：本轮新增确认，见上表。原生已编辑不等于 RA 确认链路已通过。
4. **Devin WebP 原生限制**：JPEG/GIF 正常，WebP 由原生明确拒绝，不能笼统解释为当前模型不支持图片。
5. **Cursor 一次普通发送停在确认**：前置测试观察到 RA pending=1，后用原生提交既有草稿后继续队列检查。直读原生 DOM/缓存与 RA 读取结果存在差异；并发现一个指向上一轮测试项目的 Cursor Settings 窗口，其真实目录不同，未认领、未关闭。未证明该窗口造成故障，也不把这一次样本定性为新的稳定发送缺陷。证据 `cursor-authority.json`、`cursor-queue-observe.json`、`cursor-send-follow.json`、`unowned-cursor-window.json`、`cursor-carrier-observe.json`。

## 夹具校正

原始失败记录全部保留，不删改原断言结果。最终判定使用对应补测及原生事实，`verdicts.json` 将产品失败与夹具错误分开。

- TOTP 首次直接建立配置没有按启用规则标记已有 QA 设备为已验证，导致测试连接被撤销；随后在副本中纠正并重新认证，受影响的保存/终端重验通过。不是保存或终端产品失败。
- 重载专用标签会丢失 CDP 会话的隔离注入；该标签已关闭，原存储仅 cr-computers 的变化已恢复，再创建全新隔离标签。原配对页草稿未改。见 `reload-fixture-correction.json`。
- 自由阅读最初在 resize 尚未完成时获取命中位置，或被未处理审批阻挡。最终用已稳定的可视区域和真实活动输出补测通过。
- 审批应读取 `lastChat.questions.requests`；原生读取的上下文需区分当前文档与指定线程，不能把空线程参数错误算成产品异常。
- 图片在不同软件可能显示为“Attached image”或“图片 1”，不应要求原生缩略图标签包含源文件名。
- Devin 队列“编辑”明确只取回手机输入框；原先“电脑草稿必须立即相同”的断言超出了产品语义，最终按手机全文及原生队列核对。
- Fork 立即创建后，旧目录查询可能尚无新 ID。最终采用同一 IDE 的原生历史/目录及卡片重新打开事实。

## 全方案条目的最终归属

F01/F03/F04/F05/F12/F15/F16/F18/F20/F21 及 R/S 表中已通过且未变化的本机普通用例，沿用两份既有结果，不重复执行；本轮补齐 F02/F06/F07/F09/F10/F11/F13 上述实际分支。通过一个子项不提升整个功能或其他平台状态。

| 尚无本轮真实样本的分支 | 状态与具体原因 |
|---|---|
| Fusion、自然手机断连、语音、手机通知/键盘/安全区/保存分享、原生壳及第二电脑/远程 host | 用户明确暂不检查，保留旧记录，不计本轮通过 |
| 原生账号实际退出/重新登录、计费账户变更 | 未执行：当前使用真实共享账号，没有独立可恢复登录的测试账号；不改变现有登录或账单状态 |
| Capacity/额度耗尽后的 Retry | 无可用原生额度错误样本，不人为耗尽额度或伪造错误；保留既有源码/自动化覆盖，不记真实通过 |
| OpenCode 新的 error/variant/压缩组合 | 本地模型已按用户要求停止；不重启模型或换接其他付费模型制造样本。原问卷、审批、生成、分页、空泡、统计的真实结果沿用前轮 |
| 多子 Agent、全部审批并发排列 | 除用户已排除的 Fusion 之外，当前没有新的原生多子任务样本；多题问卷、两入口批准、原生命令拒绝和失效已分别实测，不能据此推广全部排列 |
| 所有格式、所有文件名、所有模型、所有方向压力次数的交叉组合 | 不做无意义全排列；按原方案“全部条目有状态及证据/未执行原因”的完成标准登记。既有固定规模结果不扩张为未实际达到的次数；Cursor 待确认样本与 Codex 已确认缺陷先保留失败/未定 |

## 收尾

现场恢复结果及本轮准确关闭的窗口、标签和 QA 进程，见 `_shots/remaining-audit-20261112/cleanup.json`、`restoration-verified.json`。仅处理本轮登记对象，保留原配对标签、3939、3949、既有 Codex 窗口和未通过归属断言的窗口；未删除浏览器数据库。正式功能修复须另行确认。

收尾已完成：两条本轮 Codex 线程和一条空 OpenCode 测试线程已归档；关闭准确登记的三个原生项目窗口、专用配对标签及 QA3950。原配对页草稿及主题/语言/启动等偏好一致，pending=0，loopback 权限恢复 denied；原 Codex 两窗口、既有 Devin 窗口和旧项目 Cursor Settings 窗口保留。3939/3949 HTTP 200 且原 PID 保留，3950 关闭，18080 本地模型端口关闭。没有删除数据库，没有重启正式服务。410 源码文件收尾哈希仍一致。

## Cursor 发送待确认专项追查（2026-11-12 后续）

用户本轮要求继续确认 Cursor；账号重新登录、额度不足重试明确暂缓。仅追查发送，不修改产品代码。

**已分辨卡点，但未确认那次按键提交为何未生效。** 旧失败用例约在 09:05:19—09:05:44 停在 pending，原生输入仍保留文本；对同一线程 `e5f59eee-4e89-4459-8a0d-198755f85066` 的 renderer 日志，只有 09:02:25 的种子生成，下一次启动是 09:07:20 的原生手动提交，失败时段没有对应生成启动记录。因此现有证据支持“当次提交没有生效”，不支持“Cursor 已收到并生成、RA 单纯没匹配回执”。没有旧事件的按键目标/焦点/输入状态记录，不能进一步武断归因为某个插件、网络或失焦。

09:07:22 同一线程还记录了 `restore_or_rewind`，紧接本轮测试停止。因此后来只见旧正文和草稿，不能单独用作“此前所有提交都未接收”的证据。原生目录不同的旧 Cursor Settings 窗口继续保留，未证明它造成故障。

新建唯一命名的独立项目，核对原生线程与 cwd、按键实际 CDP 目标和输入框事件、原生新增用户消息、RA 的 sent/operation/pending。完成 **15 次返回主页重开、8 次实际发送**（不含原生种子）：普通短消息、原失败的较长输入、每五次重开后发送、立即发送、输入等待后发送、草稿同步临界时间发送，均有匹配的原生用户消息且 pending 清零，没有重发未确认消息。其中三次发送撤销了 QA 服务端日志钩子进行对照。

这一结果记为 **旧事件阶段已缩小、触发原因未复现**，不记为故障已修复或已证明永不出现。未套用延时重试、重复发送或自动清理待确认状态。产品文件哈希保持一致，正式服务不重启，本地模型不启动。证据：`_shots/cursor-send-confirm-20261112/trace-send.json`、`relay-trace.jsonl`、`reopen-trace.json`、`untraced-compare.json`、`delayed-compare.json`、`old-native-timeline.json`、`verdict.json`。


## v446 已确认修复及受影响功能复验（2026-11-12 后续）

本节更新前面的“未修复”状态；前文保留 v445 当时的事实与原始失败记录。本轮确认范围及工作区基线在 `_shots/confirmed-fixes-20261112/approved-scope.json`、`baseline-hashes.json`，含用户追加确认的两处回执字段区分。最终只变更 18 个批准文件，保留本轮前已有改动；正式 3939 和原 QA3949 不重启、不结束。

| 本轮受影响项 | 结果与界限 | 证据（均在 `_shots/confirmed-fixes-20261112/`） |
|---|---|---|
| Cursor 无消息首屏 | 通过：空白首屏绑定并真实发送；已有消息后新建空会话，再返回 A。原生在已有空会话上新建会复用该 ID，旧用例要求新 ID 的失败不是产品缺陷 | `cases.json`，cursor-blank-first-screen、cursor-real-send-after-empty-bind、cursor-new-after-message-return |
| attachFailed 结束绑定 | 自动化通过主页及正文两分支；不伪造原生故障作为真实浏览器通过 | `scripts/computer-switch.test.mjs` 新增用例 |
| Codex Markdown 普通发送、停止后发送 | 通过：原生只接收一次，pending 结束，下一条草稿保留，返回不恢复已发送内容；实际包含星号、反引号与反斜杠路径 | `markdown-receipt.json`、`markdown-after-stop.json` |
| Codex Markdown 队列新增、编辑 | 通过：区分队列原文与已执行消息序列化文本，原生 ID 变化后编辑窗关闭并显示“已修改，仍在排队”。首次清理按钮的取值早于列表刷新，原始失败保留；后续直接核对已保存原生结果，没有重复保存 | `queue-clean-proof.json`、`queue-save-final.json`，codex-final-markdown-save-native-proof |
| 队列保存后立即执行 | 自动化覆盖已接收消息结果及成功状态；真实保存样本确认时仍在队列，不外推已覆盖该时间竞态的真机行为 | `scripts/codex-submit.test.mjs` |
| Devin WebP 转 PNG | 通过：原生实际接收，缩略图可解码；真实 Canvas 检查透明像素 alpha=0；Cursor/Codex/OpenCode 小 WebP 仍是原文件 | `protocol-and-image-proof.json`、`image-alpha-proof.json` |
| 图片编辑替换 | 真正旋转图片后保存、原生替换及移除通过；未改动同图直接保存出现删除失败，单独保留未定位，不把整条分支标为通过 | `image-editor-proof.json`、`live-inspect.json`、`cases.json` |
| 上传所属应用及 prepared 路径 | 自动化验证切换应用后仍按捕获的所属应用选择格式；实际 prepared WebP 已由原生接收。没有对断网重试制造新的真机通过结论 | `scripts/structure-fixes.test.mjs`、devin-native-attachment-follow |
| 协议持久化会话项目归属 | 通过实际 openAgent 路由及之后真实折叠卡片重开，目录与正文一致。首次该记录 dormant，普通概览未渲染按钮，因此该次首次打开不是物理点击；跨目录、远程 host 及关闭载体为自动化覆盖 | `protocol-created.json`、`protocol-open-proof.json`、`scripts/project-windows.test.mjs` |
| Cursor 偶发未提交 | 继续仅排查、不改产品提交逻辑。上轮 15 次重开／8 次发送结果沿用；本轮空白首屏真实发送通过不等于旧事件触发原因已定位 | 上节专项及 cursor-real-send-after-empty-bind |

本轮另有 Codex 旧队列残留并中断后一次提交未启动：原生没有对应新轮次，RA pending=1，未重发或伪造清零。保留未定位，见 [问题登记第 71 节](../problem.md)。旧队列失败发生在追加字段区分获确认前；新独立线程最终队列保存成功不取消这条观察。

检查结果：修改前 916 项通过；最终 `npm run check` 946 项全部通过，语法、协议及 196 项 page 导出一致。首次完整运行只在终端测试挂起，终止的是本轮已核对 PID 的子进程；单独 24 项终端用例及最终完整复跑通过。原始日志保留为 `final-check.log`，最终结果为 `final-check-retry.log`，不把挂起记录删掉或改成通过。

收尾只归档本轮两个已空闲 Codex 线程，关闭本轮三个原生窗口、专用浏览器标签和 QA3950；原配对页草稿/偏好及原窗口、3939/3949 保留，本地模型 18080 保持关闭，未删除数据库。核对记录 `cleanup.json`、`restoration-verified.json`。

版本已在工作区升为 v446，正式 relay 尚未重启。Ubuntu 配对浏览器结果不代替用户手机验收；手机需在正式服务加载修复后复验上述实际受影响功能。Fusion、自然手机断连、语音、账号重新登录、额度不足重试及其余已明确暂缓项不纳入本轮通过。


## v447 两项观察的定向修复与验收（2026-11-12）

只处理上节额外观察的两项，不重新打开全功能排查。用户明确免跑修改前 `npm run check`；对新增根因所需 `server/page/codex.js`、`server/agent/updates.mjs` 已另行确认。没有改 `server/apps/codex.mjs`、`server/native-windows.mjs` 或附件删除逻辑。

| 受影响路径 | 结果 | 证据（`_shots/submit-image-fixes-20261112/`） |
|---|---|---|
| 旧队列中断后新发送 | 原因已确定：原生打开是否清空旧队列的确认，RA 未显示。修复同步到既有请求区域，两条读取路径均支持并监听原生弹窗变化 | `submit-reproduction.json`、`pause-native-ui.json` |
| 取消本次发送 | 实际手机布局的配对浏览器按钮通过：原请求等待结束，当前线程 pending=0，原输入及旧队列保留 | `codex-verification.json`，codex-paused-queue-cancel-keeps-draft |
| 保留队列并发送 | 原队列消息与新消息均被原生接收一次，无重复发送 | 同文件，codex-paused-queue-preserve-and-send |
| 清空队列并发送 | 明确点击后旧队列移除且没有执行，新消息被原生接收一次 | 同文件，codex-paused-queue-clear-only-after-choice |
| 失效确认、不同线程及原生 onNotSent | 自动化覆盖失效 ID 不执行、新旧请求不混淆、明确未提交保留草稿；没有把它们记成真机通过 | `scripts/codex-submit.test.mjs` |
| Devin 首次上传及无修改保存 | 实际上传成功；再次打开未编辑直接保存没有新增 image 请求，原生附件 ID 保持 | `cases.json`，image-first-upload-then-unchanged-save |
| 撤销与真实修改 | 旋转后撤销保存保留原图；真正旋转后上传、替换、原生解码和移除通过。裁剪及待上传回调为自动化覆盖 | `cases.json`，image-undo-keeps-original-and-real-rotation-replaces；`scripts/structure-fixes.test.mjs` |

保留原始用例及中间失败。第一版弹窗同步只覆盖指定线程读取，普通读取及其监听尚未补齐，不能记为当时已通过；最终补齐两条路径后，在新的自有线程完成三分支，未重发旧未确认消息。脚本另有初次绑定后立即读 lastChat 的夹具错误，已改为等待实际正文渲染。配对浏览器是本机 Chrome 的手机布局，不能替代用户真机验收。

源码基线、确认范围、原生调用追踪与最终记录位于 `_shots/submit-image-fixes-20261112/`；最终检查为 `final-check.log`，收尾为 `cleanup.json`、`restoration-verified.json`。工作区版本 v447；没有发布、推送或重启正式 relay。其余暂缓项及本地 OpenCode 模型停止状态保持不变。


最终完整检查 **959/959 通过**，语法、协议及 196 个 page 导出一致。初次 952/959 的 7 项夹具缺失失败保留为 `final-check-first.log`；经用户追加确认，仅补 `scripts/session-lifecycle.test.mjs` 一行 `codexQueueConfirmRequests: () => []`，原断言不变，最终日志为 `final-check.log`。变更限于 12 个已批准文件。现场恢复核对已通过，原浏览器草稿/偏好和原窗口、3939/3949 均保留，本地模型端口关闭。
