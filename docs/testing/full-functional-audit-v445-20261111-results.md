# v445 全功能排查结果

> 2026-11-12 后续范围与实际结果见 [剩余普通功能补验记录](remaining-functional-audit-v445-20261112.md)。原文保留当时结果；当前明确排除 Fusion、手机自然断连、剩余真机／多平台和语音，本地模型保持停止。不能把本轮检查完成解释为所有功能通过或已修复。

基准：2026-11-11，HEAD `850cd4dd42f93a63cc6e734f342cf214c04f5a52`，包含开始前全部未提交修改。执行及收尾跨 2026-11-11—12（上海时间）。执行依据：[本轮方案](full-functional-audit-v445-20261111.md)。

**结论：确认三类功能问题；另有 Fusion 依赖链 CDP 超时、WebSocket 心跳中断两项未定根因。当前不能标记为全功能验收通过。** 四个普通应用、Devin 和 Fusion 均已纳入检查。Devin 使用本机直连后普通生成成功；Cursor Fusion 已完成一组真实派工、评审及交付。

本轮只检查并整理文档，没有修改产品实现、`scripts/page-exports.json` 或原业务模型配置，没有提交、推送、发布或重启正式 relay。开始时执行 `npm run check`：883 项加 24 项终端检查，**907/907 通过**；其后产品文件未变化，不重复运行相同检查。

## 1. 环境与证据边界

- 复用既有配对 Chrome：9335、QA relay：3949、原 QA 数据目录；没有重新配对。正式 relay 3939 未由本轮重启。
- 原 QA 页面为 v440，旧测试窗口已不存在；仅刷新专用 QA 到当前源码 v445，创建四个独立测试项目/会话。QA 加载器只限制可操作的原生窗口，业务代码保持原样；Fusion carrier 也限定在本轮窗口。
- 早期普通功能使用隔离本地存储/聊天库且绕过 SW；PWA 专项另用真实存储、真实 SW 和离线网络状态。两层证据分开，不把早期临时页当作离线验收。
- 原生调试端口：Cursor 9222、Devin 9223、Codex 9224；OpenCode HTTP 4096。中断后用户关闭了 Cursor/Devin，Codex 窗口 target 也发生更换；旧窗口标识不能继续用于补测。用户要求按需打开，收尾未再启动它们。
- 配对浏览器是 Ubuntu Chrome。iPhone Safari/PWA、真实麦克风、软键盘、系统推送、Android/iOS 壳、其他桌面系统及第二电脑没有本轮完整实机证据。
- 证据目录：[`_shots/full-functional-v445-20261111/run-20261111-213349/`](../../_shots/full-functional-v445-20261111/run-20261111-213349/)。原始 `cases.json` 保留重试和旧夹具错误；`verdicts.json`、`fixture-corrections.json` 是校正说明。子用例数不等于全功能通过数。

## 2. 已确认的问题

### B01：Cursor 空白新会话首屏失败，等待绑定未正常结束（高优先级）

新测试窗口有原生输入框，但尚无正文节点时，`cursorSessionServices()` 返回 null，`cursorCurrentChat()` 直接读取 `.data` 报错。原生发送第一条消息、正文节点出现后，同一窗口可正常通过 RA 读取和发送。

服务发现依赖 `[data-message-id]`、`[data-glass-agent-id]`、`.composer-container` 的 React 上下文，与正文是否已经出现耦合。这是首屏初始化问题，不能用补空消息或延时重试处理。

另有绑定生命周期问题：`bindWin()` 等待成功事件；`attachFailed` 没有统一结束这个 Promise。只有部分卡片状态下的 `ovRender()` 才补做失败收尾，普通绑定可继续处于 pending。

涉及位置：`server/page/session-actions.js:2`、`server/page/chat-extract.js:1083`、`app/js/notify.js:212`、`app/js/net.js:1388`。后续应分别处理原生服务取得和失败事件收尾，不增加一套导航状态。

证据：`cursor-cold-scene.json`、`cursor-seed-native-result.json`、`ordinary.log`、`relay.log`；原生首条输入和 RA 热会话读取有独立记录。

### B02：Codex 新扩展的控件及模块入口已变化（高优先级）

开始检查时，已有窗口仍加载 **26.1021.22027**，新窗口加载 **26.1106.51428**。新版没有旧的 `[data-codex-intelligence-trigger]`；旧 `handleSubmit/isQueueingEnabled` 查找也失效。结果：

1. RA 模型菜单报“当前窗口里没有这个按钮”。
2. RA 发送报“Codex 提交入口当前不可用”；冷/热场景都复现，不能把 native seed 的回复算作 RA 发送成功。
3. Fusion 能读取八个原生模型，但启用主会话在 `codexComposerScope → nativeCodexCreation` 报 null 的 `[0]` 访问错误，关联原生模块文件名正则定位。

在同一新窗口用原生键盘发送可正常回复，故不能归为模型服务整体不可用。窗口显示 ready 也不能证明模型和发送入口可用。

**11 月 12 日补充的手机反馈已并入 B02。** 用户实机提示“Codex 提交入口不可用”，并确认输入内容仍在。只读核对当前两个 Codex 窗口：都加载 26.1106.51428，输入框、composerController 存在，但没有任何属性对象同时满足旧的 `handleSubmit` 函数和 `isQueueingEnabled` 条件；旧模型触发器数量也为零。正式 relay 日志有五条同文案错误。日志缺每条 requestId/时间，不能将其中某行强行对应这次点击；当前结构和先前复现共同支持新版扩展适配问题。

源码上该条件失败发生在调用原生提交之前；服务端返回 sendFailed，前端清理待发回显并保留/恢复草稿。手机“内容还在”已获用户确认，未替用户重发消息。未取得这次消息的原生 ID，不能扩展为所有失败/未知结果场景都已验收。新增证据：`codex-phone-observe.json`。

涉及位置：`server/page/menus.js:19`、`server/page/chat-extract.js:167`、`server/page/composer.js:3`。后续应对齐当前扩展的真实原生入口，不靠更多版本分支或吞掉错误。

证据：`codex-cold-native.png`、`codex-native-seed.json`、`send-codex-warm.json`、`fusion-codex-enabled.json`、`relay.log`。中断后的独立管理补测因旧测试窗口已关闭未完成，不另外推断管理功能损坏。

### B03：Devin Fusion 创建的空主线程被原生选择目录过滤（高优先级）

本机直连后，Devin 普通会话成功生成。Fusion 创建主线程、绑定和重命名也成功，但进入正文时提示“原生目录中没有所选 Devin 会话”。在直连条件下新建工作台立即打开也复现。

原生 ACP store 中存在新主线程，cwd 正确、状态 idle；`userMessageCount=0`、`hasUserMessages=false`，而 `filterActiveSessions([session])` 返回空。RA 打开路径依赖这个过滤后的原生选择目录，导致已创建主线程无法先进入输入第一条消息。

涉及位置：`server/apps/devin.mjs:609`、`server/page/devin.js:109`、`server/page/session-actions.js:424`。应核对原生按 sessionId 打开/选中的入口，使已创建 Binding 的身份不依赖“有正文的历史目录”；不能通过偷偷发送占位消息绕过。

证据：`fusion-devin-fresh-enable.log`、`devin-fusion-diagnostic.json`、`devin-fusion-meta.json`、`devin-filter-functions.json`。

## 3. 仍需定位的运行问题

### U01：Fusion 第二组依赖任务遇到 CDP 超时

第一组 Cursor 主控 → Cursor 子任务 → 主控评审 → 交付成功：工作项 completed、任务 accepted，原生文件及算术结果有证据。

第二组真实方案确认通过；已复用第一组 Worker 的原生 Binding 执行 `t-mul`。随后主控观察出现 `CDP 调用超时: Runtime.evaluate`，第一项 awaiting_review、依赖它的 `t-check` queued，主轮次被记为 unknown。不能把“子结果已返回”算作“整组已验收”。

目前只定位到原生观察链路超时，尚不能确定是 RA 调度、原生服务等待还是桌面进程短暂停顿。没有提高超时、补发未知请求或修改产品埋点。后续应按原 thread/turn/requestId 核对接受和结束事实，再定位具体等待阶段。

收尾已经请求停止本轮后续调度：`t-check` cancelled；该工作台仍为 stopping、`stopRequested=true`。原生 Cursor 已关闭，停止回查返回 fetch failed，不能伪造“原生已停止”。保留这组执行记录供后续核对。

证据：`fusion-summary-sanitized.json`、`fusion-plan-confirmation.json`、`stop-audit-proof.json`。其中 t-read 与 t-mul 的 Binding 相同，复用确实发生；第二组完整依赖交付未通过。

### U02：本机 QA 链路也有协议心跳超时

QA 日志在 **2026-11-11 23:07:31（上海时间）** 记录 `1006 source=heartbeat authorized=true background=false`；23:09:03 另有未认证连接的心跳关闭。`server/ws.mjs:44` 每 20 秒检查原生 WebSocket ping/pong，未恢复 alive 时 terminate。

这证明至少一次本机链路发生协议心跳中断；不能把所有断线都归为公网边缘连接，也不能仅凭该行区分网络、浏览器/进程暂停或系统调度。该时段缺浏览器协议 pong 与系统同期记录，根因保留未定。

实际重连、十次标签页前后台及受控五分钟边界已通过。这些用例不能替代手机自然断线。日志中 `source=background code=4000` 是另一个有意的后台暂停场景，分开记录。

证据：`relay.log`、`connection.log`、`timings.json`、`resources.json`。10 分钟资源采样早于后续心跳问题，不能用它排除间歇卡顿。

## 4. Devin 网络与环境问题的复核

- 桌面主进程带 `--no-proxy-server`，不等于 ACP 生成直连。原测试 ACP 继承了大小写 HTTP/HTTPS/ALL_PROXY，地址是 `127.0.0.1:7897`。
- 按用户要求，只在独立测试项目 `.vscode/settings.json` 设置原生 `devin.acp.agentEnv`，清空代理变量、`NO_PROXY=*`；重载该测试窗口并读取新生成进程环境核对。
- 同一普通会话随后成功回复 `RA445_DEVIN_DIRECT`。因此早期 err13 的“已接收”不算成功；直连对照显示代理是影响因素。没有改系统网络或用户全局代理配置。
- Devin 队列删除一度被本轮新窗口的 Git“打开父仓库”通知覆盖。通知遮住坐标，hover 按钮不显现，relay 报错。关闭仅这条测试通知后，从 RA 删除待发消息成功，原生未出现该条 prompt 请求。该项记为界面遮挡限制及重验通过，不误报为队列协议故障。

证据：`devin-direct-response.json`、`devin-direct-reload.json`、测试项目原生配置、`devin-queue-hover.json`、`devin-queue-remove-verified.json`。

## 5. 普通功能覆盖（F01—F21）

“部分”表示该类已执行若干正常/异常步骤，表中未验分支仍保留；不表示整类通过。自动化和源码层不能替代真机。

| 编号 | 本轮实际结果 | 未完成或限制 |
|---|---|---|
| F01 启动/连接 | 四应用热绑定、原生新测试窗口/信任、真实重连通过；Cursor 空白首屏失败 B01 | 原应用冷启动全组合未跑；不为测试重启正式服务 |
| F02 配对/设备 | 既有配对及重载/离线后的身份保留通过；鉴权现有自动化通过 | 邀请、撤销、2FA 未在当前业务入口真实修改；无第二电脑 |
| F03 主页/卡片 | 四应用折叠卡片导航、快速改选、收藏回显通过；状态/边框和工具上限有源码/自动化覆盖 | 未在手机重演全部状态颜色组合 |
| F04 项目/会话 | 四应用隐藏项滑块和目录浏览；Cursor 新建独立会话、A/B 草稿切换通过 | 跨电脑、远程 host、关闭窗口后全部恢复组合未验 |
| F05 管理 | Cursor/Devin 收藏重命名恢复；OpenCode 主页菜单同项通过；Cursor 原生删除实际归档成功 | Codex 独立管理补测未完成；批量部分成功/取消仅自动化 |
| F06 输入/发送 | Cursor、直连 Devin、OpenCode 真发真回；Cursor 两线程草稿、排队删除停止；Devin 停止及无遮挡队列删除通过 | Codex RA 发送失败 B02；两处手机输入、IME、Steer/队列编辑未完整实测 |
| F07 展示/历史 | Cursor 原生正文、加粗/公式、图/纯图；OpenCode 分页及空助手过滤通过；Devin 直连正文可见 | 旧 pre code 检测不适用实际 .codebox pre；完整代码格式/搜索/自由阅读组合未逐项断言 |
| F08 模型/权限 | Cursor/Devin/OpenCode 菜单各 20 次；实际切换读回与恢复；Fusion 三软件原生候选读取通过 | Codex 普通模型入口失败 B02；Fast/全部权限/账号入口未完整实测 |
| F09 问卷/审批 | OpenCode 真单选问卷、一次允许 printf 命令；Fusion 真方案确认通过 | 多题多选、拒绝、过期、Capacity、Fork 等以现有自动化为主 |
| F10 Editor/媒体 | 四应用预览高亮、修改保存比字节及 0751 权限恢复；20 次预览、三页 PDF、MP4 播放通过 | 保存中改选等竞态未逐项实测 |
| F11 附件/编辑 | Cursor 带文图片及纯图均实发、缩略图加载；文档增删；裁剪旋转撤销重做取消通过 | 四应用全部附件类型、手机保存/分享未全覆盖 |
| F12 传输 | 21 文件上传逐字节哈希、重名跳过/改名/覆盖通过；实际 ZIP 下载 22 文件与磁盘哈希一致 | 本轮未补完大文件取消/恢复、空目录/全文件名组合 |
| F13 RA 终端 | 四应用真实项目 cwd、printf 输出、sleep 中断、Tab 补全与关闭通过；收尾列表无遗留终端 | 密码、长时间断线输出连续性未实测 |
| F14 语音/画面 | Sherpa 真 PCM 转录、完成重开/取消重开；画面候选列表及退出通过 | 系统麦克风真机待验；Qwen catalog ready=false；实际画面捕获未验 |
| F15 客户端/通知 | 真 SW v445、主题、语言重载持久化、Chrome 横竖屏折叠、离线公式/字体及恢复通过 | Chrome 通知权限 default，未验证送达；手机键盘/安全区/推送待验 |
| F16 生成统计 | Cursor 结束态原生 token、Devin 直连 token、OpenCode 字符流式/结束 token 均有实际样本 | Codex 受 B02 阻断；四应用全部轮次/模型切换隔离未全测 |
| F17 OpenCode | 真 HTTP/SSE 生成、问卷、审批、read/bash、生成中切其他应用返回通过 | stop/error/variant/压缩提示全部组合未重演；不调整原生压缩策略 |
| F18 OpenCode 大历史 | 长会话首屏、三次向前分页/去重、三个工具按需详情、20 次重开通过 | 20 为原生消息数；显示项包含多种 part，不用显示项数冒充原生消息数 |
| F19 Fusion | 见下表：第一组真闭环通过，第二组计划确认与复用已发生 | Codex/Devin 主入口有已确认问题；依赖链后半段超时受阻 |
| F20 安装/壳 | 启动入口、源码/静态资源与实际扩展版本分别核对；版本/平台现有自动化通过 | 未构建/运行本轮 Android、iOS、Windows、macOS 验收；未发布 |
| F21 权限边界 | 真实未认证文件列表请求被拒绝；鉴权/消息/终端现有自动化通过 | 未把全部 HTTP/WS/媒体/重放组合都记成真实验证 |

## 6. Fusion 覆盖（X01—X12）

| 编号 | 实际状态与证据 |
|---|---|
| X01 | 三软件选电脑/自有项目及原生模型读取通过；Cursor 可启用。Codex 启用报模块错误，Devin 空主线程进入失败 |
| X02 | 主页真实 Cursor 工作台卡片再次进入 ready=true；直接在普通正文调用内部处理器的负例不冒充此用户路径 |
| X03 | Cursor 主控实际运行；Devin 普通生成直连可用但 Fusion 正文入口失败；Codex 主控启用受阻；零子任务独立闭环未完成 |
| X04 | 第一组一个真子任务完成；第二组 t-mul 返回，t-check 因依赖及后续停止未执行；并行分工未实测 |
| X05 | t-read/t-mul 使用同一原生 Binding，相关新 Task 的 Worker 复用有证据；第二组后续评审/依赖交付受 U01 阻断 |
| X06 | 真实只读方案由主对话确认；OpenCode 原生问卷/审批另测。修改/拒绝方案及全部子审批未实测 |
| X07 | 第一组已完成真评审和 finish；第二组第一项 awaiting_review，不能算整组通过；返工闭环未实测 |
| X08 | 真实任务面板/结果可读，详情订阅 20 次释放，owner/pending 归零；全部证据分页未逐项验证 |
| X09 | 原生模型候选和省钱档保存实际使用；费用保持原生未知；未设置真实额度耗尽来测试预算 |
| X10 | 三个自有工作台 stopped；Cursor 后续调度已停、排队项 cancelled，但未知主轮次仍 stopping。完整停止/恢复未通过 |
| X11 | 第一组后台派工期间普通会话/终端/文件操作可用；第二组出现超时，不能宣称长期隔离全部通过；跨电脑未验 |
| X12 | 自有测试记录保留；已有旧 CWM 工作台未操作。未知轮次的工作台不能强制删除；全套重命名/收藏/删除未完成 |

## 7. 固定复现场景与压力规模

| 编号 | 本轮状态 |
|---|---|
| R01 | 通过：四应用真实折叠卡片各 20 次，另有快速改选 30 次 |
| R02 | 通过已执行的展开 A/打开 B 序列；所有迟到响应边界以自动化补充，不称全部真机竞态通过 |
| R03 | 竖屏 A 终端返回后进入 B 正文通过；Chrome 横屏布局另测；手机闪帧和键盘待验 |
| R04 | 第一组工作台/详情/普通切换及真实主页重新进入通过；第二组运行受 U01 阻断 |
| R05 | 通过：本地 OpenCode 生成中离开，进入 Cursor，再回原会话；问卷/工具继续，无重复发消息 |
| R06 | Cursor 原生种子正文、后续 RA 回复和图片映射已对照；未让用户业务线程额外生成来测试 |
| R07 | 长会话三次较早页/ID 去重、20 次重开通过；共享游标所有缓存交叉组合未穷举 |
| R08 | 三工具按需展开、收起通过；完整滚动/更新/后台组合未实机覆盖 |
| R09 | 待手机验收；合成 PCM 只证明电脑引擎链路 |
| R10 | 实际生成及工具结束后空助手数为 0；卡片 600 字符/3 工具上限核对源码/现有自动化；未专门触发压缩 |
| R11 | 三软件实际统计样本，OpenCode 22 种连续快照；Codex及全部跨轮组合未完成 |
| R12 | 重连/后台边界通过；自然心跳中断已有 QA 日志但缺手机同期事实，U02 未定 |

| 编号 | 压力结果 |
|---|---|
| S01 | 四应用各 20 次正常开关、30 次快速改选、OpenCode 长会话 20 次重开；空会话另有 B01 |
| S02 | 三软件菜单各 20 次；模型切换/恢复有样本，未达到所有软件各 5 次往返；Codex菜单失败 |
| S03 | 已有应用及 Fusion 交叉用例；不是每一跨项目/跨电脑各 10 次，第二电脑未验 |
| S04 | 三次历史分页和三个工具实测；完整每方向各 10 次/自由阅读组合未完成 |
| S05 | 预览 20 次，21 文件上传，22 文件 ZIP 哈希；大文件取消/恢复未完成 |
| S06 | 10 次真实 Chrome 标签页后台返回；五分钟边界为受控时钟，手机边界另验 |
| S07 | 约 10 分钟、60 个资源点；无持续累积证据，不能据此排除后续偶发卡顿 |
| S08 | OpenCode 长会话 20 次进出、三次较早页、同时三工具；真工具生成与跨应用另测 |
| S09 | Fusion 详情 20 次订阅释放；一次真闭环通过，第二组依赖链受阻 |
| S10 | Sherpa 完成/取消后各重开；手机两处各 3 次仍待验；Qwen 未就绪 |

## 8. 性能样本

同一台电脑、本机 QA、短会话热打开；点击到匹配的新鲜正文就绪。不要用于推断公网或冷启动耗时。

| 应用 | 次数 | 中位数 | P95 | 最大 | 前5次平均 → 后5次平均 |
|---|---:|---:|---:|---:|---:|
| Cursor | 20 | 165 ms | 185 ms | 258 ms | 187.4 → 165.8 ms |
| Devin | 20 | 166.5 ms | 245 ms | 253 ms | 170.6 → 202.6 ms |
| Codex | 20 | 165 ms | 171 ms | 249 ms | 169.0 → 120.2 ms |
| OpenCode | 20 | 83.5 ms | 99 ms | 103 ms | 90.6 → 82.6 ms |

本轮热路径没有随次数持续变慢；冷首屏、Fusion 和后续运行仍有上述独立问题。OpenCode 长会话首个快照约 153,755 字符、64 个显示项；三页后为 115/163/221 项，无重复 ID。该数值不是固定网络压缩后字节数。

资源窗口约为 22:18—22:28（上海时间）：relay RSS 开始 192,756 KB、峰值 234,232 KB、末尾 172,808 KB；FD 37→37、峰值 38。浏览器堆约 7.05→7.67 MB，峰值约 17.27 MB；最后待发、导航和 desktop request 均为零。该窗口早于 U02。

统计样本用于验证单位/归属，不作模型速度横向排名：Cursor 67 输出 token / 5.232s，Devin 55 / 2.791s；OpenCode 396 个流式字符单位采样、结束后转 token，最终一段 91 / 1.846s。原生缺少费用时没有编造金额。

## 9. 重复实现与文档差异

| 项目 | 具体位置 | 判断与后续处理范围 |
|---|---|---|
| D02 原生引用文本分段 | `server/apps/codex.mjs:1116` 的 typeWithCodexMentions；`server/apps/devin.mjs:918` 的 typeWithMentions | 相同的 token 定位、前缀输入、剩余文本、空格处理和字面量回退循环。可共享分段执行算法并注入原生插入回调；Codex 的输入快照恢复和两软件的原生 chip 操作仍各自保留 |
| D03 二维码像素绘制 | `app/js/approval.js:26` 的 drawQr；`app/js/sheets.js:909` 的 drawEntryQr | 同样的 4px 比例、四模块留白、白底黑模块双层循环。可共享纯绘制函数；两条授权流程/生命周期各有用途。代码仅数行，抽取会增加加载依赖，低优先级，不能当作会话慢的主因 |
| D01 README 能力说明 | README 的主控软件说明与 `server/fusion/providers.mjs` | README 仍称主 Agent 限 Codex；源码及实际模型候选覆盖 Cursor/Devin/Codex。文档应对齐声明，并分别说明本轮可用/失败，不以声明替代实测 |

四应用原生适配、系统/电脑语音、原生壳/Web Push 使用不同数据源和生命周期，归为必要适配。导航中 navigationPending、winBinding、ovOpening、ovToolState 分别承担请求、等待、卡片反馈、编辑归属；B01 暴露的是失败收尾缺口，不能仅凭状态多就删除某一层。

扫描证据：`clone-candidates.json`。本轮未重构上述代码。

## 10. 现场恢复与未完成项

- 核对开始时 593 个基线文件：本轮审计文档变化单列，产品文件保持一致。没有修改其他 Agent 的源码、系统代理或业务项目文件。
- Devin 直连配置只在本轮 `_shots/.../projects/ra-audit-devin/.vscode/settings.json`。重命名/收藏已恢复；纯图测试新会话已由原生归档；本轮终端列表最终为零。
- 四个本轮 Fusion 工作台已请求停止，三个 stopped，一个保留 stopping/原生结果待核对。旧 CWM 工作台保留。未重发未知主轮次，未强制删除其证据。
- 原生窗口在中断期间被关闭/重开，原 target 的草稿/状态指纹无法最终逐项读回；不通过重开用户应用伪造原现场。
- 配对浏览器恢复结果以 `browser-restoration.json` 为准：两个明确登记的本轮标签已关闭，七个显示偏好和原 loopback 权限已恢复，原标签最终为 v445。曾因草稿检测结果暂停全量恢复；最终操作未重载、未覆盖整份存储、未写入输入框或凭据，当前草稿与 pending 均为零。正常 SW 更新至 v445 保留。
- **自动权限审核拒绝按数据库名前缀批量删除**，原因是前缀不足以证明均属本轮，可能误删原会话数据。已改为不删除任何数据库、只关闭明确登记的两个本轮标签。隔离测试数据库保留，不声称全部测试存储已清理。
- 本轮后续产品修复仍需按 AGENTS.md 单独给范围并确认。优先 B01/B02/B03；U01/U02 先补证据定位，不能用延长超时、自动重发、关闭心跳或隐藏入口替代。

证据导航：`check.log`、`verdicts.json`、`fixture-corrections.json`、`timings.json`、`resources.json`、`zip-validate.json`、`fusion-summary-sanitized.json`、`stop-audit-proof.json`、`browser-restoration.json`、`source-integrity-final.json`。
