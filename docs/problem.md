# 问题核查与分批修复方案

> 2026-10-31 复查：见第 9 节（重复/简化、生命周期、静默失败、测试与文档一致性）。本轮只读核查，未改代码。

> 2026-10-31 更新：重复实现核查见第 7 节，N1—N7 均已处理；N3、N4、N7 的实施记录见第 7.1 节，N1、N2、N5、N6 的本轮实施与验证见第 8 节。自动检查及隔离浏览器检查通过，手机真机仍待用户验收。第 1—6 节及此前基准、授权和验证记录保留为历史，不代表本轮重新实施或重新验收。

> 核查日期：2026-10-29。
> 基准：本次修改前的当前工作区，包含已有的未提交改动；不使用历史版本作为回归基准。
> 授权范围：P1、P2、P3 已实施；本轮继续按 P4（D3／R1 定向核查）、P5（M1／M2 结构评估）分批处理，最终统一使用既有配对浏览器检查。不扩大到其他 Agent 的代码或共享结构拆分。
> 实施状态：三项代码均已处理并加载到 relay；自动化与基准对比通过。前两项统一配对浏览器检查已在用户提供的独立 Codex 窗口中复测，普通发送、排队、追加、文件／图片附件和已接收后断线回执恢复通过；真机仍待用户验收。P4 定向核查和 P5 结构评估已完成，最终统一浏览器检查通过；两项测试边界记录已按用户指示搁置。
> 修改前基准：P1—P3 使用 `_shots/problem-batches-20261029/` 的 458 个跟踪文件指纹；P4／P5 使用本轮开始时当前工作区的 `_shots/problem-followups-20261029/manifest.json`（含前批新增文件，共 461 项），不回退已有改动。

## 1. 结论与执行边界

原清单中的重复实现、共享原型、DOM 判定和测试缺口大多有代码依据，但不能将 17 条都视为已发生的功能缺陷。部分差异有明确的生命周期或应用语义，部分原推断遗漏了现有调用路径。

本轮已按授权完成一个条件性检查器修复、一个 Codex 局部重构，以及一个共享入口缓存重构。其余条目保留为结构事实、待复现风险或测试缺口，不以减少分支、定时器或文件行数作为修复目标。

执行时遵循 [AGENTS.md](../AGENTS.md)：

- 每批先列文件、改法和验证方式，用户确认后再改代码；允许在确认范围内重构。
- Codex 批次只改 Codex 独有逻辑，不随批修改 Cursor、Devin、Fusion。共享入口的改动单列范围确认。
- 不改范围外的功能，不动 page 导出快照 `scripts/page-exports.json`；不通过修改快照让检查通过。
- 不增加额外保护措施、兜底或兼容逻辑，不用延时、吞事件、隐藏入口压症状。
- 每批完成后运行 `npm run check`；改协议或 page helpers 前也先运行。只检查修改及受影响的功能。
- 真机由用户使用既有配对浏览器验收。代码检查、自动化行为检查和真机验收分别记录，未执行不得标通过。
- 不提交、不推送；提交信息、tag、PR 不出现 AI 署名。截图与临时产物放 `_shots/`。
- 保留工作区已有改动，特别是 `server/agent/chat.mjs`、`server/apps/codex.mjs`、`server/page/codex.js`；实施前确认它们未在方案形成后继续变化。

## 2. 核查总览

“事实确认”仅表示代码结构或调用关系已核对，不表示行为故障已复现。“候选重构”表示维护性改动，不记作功能缺陷修复。

| 条目 | 核查结论 | 处置 |
|---|---|---|
| D1 缓存清理多处实现 | 已处理（P3）；仅提取五项共同思考缓存，保留各入口原有重置范围 | 修改前后各 10 项缓存／attach 用例通过 |
| D2 `itemCache` 脱钩 | 原推断缺少可达调用路径 | 撤回当前缺陷判断，保留所有权约束 |
| D3 切换守卫分散 | 已处理（P4 定向核查）；14 项状态恢复检查及 Codex 会话往返通过，未确认漏恢复 | 保留现状，不重写切换状态机；真实异常中断未实机注入 |
| D4 回执规则不同 | 已处理（P2 局部重构）；保留原生窗口与页面事件两类回执 | 修改前后各 32 项用例通过；独立窗口中的普通／排队／追加／附件及已接收后断线回执复测通过 |
| D5 文件面板开关 | 两套实现加一次委托，读取策略不同 | 保留应用差异 |
| D6 机械重复 | 已处理本轮确认的局部重复（P2／P3） | 其余定时器、坐标与标签差异保留，不作全仓替换 |
| M1 适配器方法混入原型 | 已处理（P5 评估）；83 个应用专有方法之间无同名覆盖，存在显式共享调用 | 保留实现；跨 Agent 原型拆分未实施 |
| M2 页面端 DOM 判定 | 已处理（P5 评估）；确认独立文档上下文与共享 helper 依赖，Codex 实测判定正常 | 保留实现；按应用拆 page 未实施，Cursor／Devin 判定未扩大验收 |
| M3 app 分支分布 | 统计事实，不是独立缺陷 | 用于定位，不作为重构指标 |
| R1 两条读取路径 | 已处理（P4 定向核查）；3 次原生快照与直接读取的消息及合并结果一致 | 当前 Codex 短历史场景未确认缺失／重复；保留两条路径 |
| R2 三类并发控制 | 职责不同，不构成重复保护的证据 | 保留 |
| R3 React 内部依赖 | 事实确认，是升级敏感点 | 按实际升级断点修复，不新增备用读取链 |
| R4 容量重试与用量读取 | 职责可区分，未发现重复提交依据 | 撤回重复触发推断，保留现状 |
| T1 静态检查边界 | 成立，现有检查不验证业务时序 | 不将 `check` 通过写成业务验收通过 |
| T2 行为测试缺口 | 已处理本轮发送与缓存测试缺口（P2／P3），新增 42 项用例 | 全仓行为覆盖仍有缺口，真机另行验收 |
| T3 `.runtime` 扫描污染 | 已处理（P1）；实际扫描函数对比确认仅排除 `.runtime`，代码检查通过 | 不宣称历史真实目录误报已复现 |
| T4 沙箱语法检查失败 | 本会话观察到 EPERM；允许执行的环境下完整通过 | 记录环境事实，不改项目代码绕过 |

## 3. 修改前基准统计口径

统计本次修改前 `server/`、`lib/`、`app/js/` 下的自有 `.mjs`、`.js` 文件。以下数值冻结为基准，均为词法计数，可能包含注释和字符串，不代表逻辑分支数、故障数或性能开销；实施结果见各批记录。

| 指标 | 修改前值 | 口径 |
|---|---|---|
| 名为 `app` 的字面量相等／不等判断 | 283 处、37 个文件 | 正则 `\bapp\s*(?:===\|!==)\s*['"]`，不统计 `currentApp` 等其他变量名 |
| `switchingThread` | 33 处、8 个文件 | 字符串出现次数，包含读写 |
| 固定写法的定时等待 | 109 处 | `new Promise(r => setTimeout(r,`，不全部归为轮询 |
| `this.waitFor()` 调用 | 27 处 | `this.waitFor(` |
| `pollChat` 延时刷新 | 21 处 | `setTimeout(() => this.pollChat(` |
| `server/page/chat-extract.js` | 1108 行 | 当前文件行数 |
| 行为测试 | 未发现 | 自有文件中未发现 `*.test.*`、`*.spec.*` 或 fixture 测试体系 |

`switchingThread` 分布：`projects.mjs` 11、`devin.mjs` 9、`codex.mjs` 6、`cursor.mjs` 3，另有 `session.mjs`、`chat.mjs`、`context.mjs`、`fusion/owner.mjs` 各 1。

## 4. 逐项核查

### D1 缓存重置存在重复，但不能统一清空

- 证据：[context.mjs](../server/agent/context.mjs) 的 `resetCaches()`、`clearViewState()`，[session.mjs](../server/session.mjs) 的 `openBound()`，[codex.mjs](../server/apps/codex.mjs) 的 `mergeCodexItems()`。
- `resetCaches()` 初始化上下文；`openBound()` 重建连接相关状态并绑定窗口缓存；`clearViewState()` 清视图状态；`mergeCodexItems()` 在 Codex thread 变化时清思考状态。这些操作的字段集合有意不同。
- 原清单遗漏了 [devin.mjs](../server/apps/devin.mjs) 的 `syncSession()`：它保存并恢复每个会话的缓存，不能换成统一清空。
- 可提取的是五项共同思考缓存的重建：`thinking`、`thinkingTried`、`keptThink`、`thinkLiveSeen`、`thinkFinal`。`itemCache`、Devin 历史及其他调用点特有状态仍由原生命周期管理。见 P3。
- 已处理（P3）：四处入口改调 `resetThinkingCaches()`，仅重建上述五项缓存；修改前后各 10 项用例通过，覆盖三类 Agent 的 attach、普通会话共享历史与 Fusion 私有历史的区分。串会话症状未复现，不宣称修复了已发生的串会话故障。

### D2 当前未发现绑定后调用 `resetCaches()` 的路径

- [native-windows.mjs](../server/native-windows.mjs) 的 `NativeWindow` 创建 `itemCache`；`openBound()` 随后将该 Map 绑定到会话。
- `resetCaches()` 当前仅由 `AgentContext` 构造函数调用，发生在窗口绑定之前。原文“绑定之后执行就会脱钩”的条件尚无实际调用路径支持。
- 普通会话引用窗口缓存，Fusion 上下文保留自己的缓存；不能通过无条件 `new Map()` 或 `.clear()` 统一两种所有权。
- 状态：撤回当前脱钩缺陷判断；后续重构须验证共享 Map 引用不被替换。

### D3 守卫分散尚未证明状态无法恢复

- 33 处引用分布在 8 个文件。多个切换入口使用保存旧值、`try/finally` 恢复的模板。
- [projects.mjs](../server/agent/projects.mjs) 的 `resumeProjectSwitch()` 同时承担恢复轮询、发布选择与重新绑定更新等动作；当前调用点传入 `previousCdp`。
- 仅更新 thread 选择与跨项目重新绑定的后续动作不同，不能只因布尔变量相同就换成同一个完整切换流程。
- 已处理（P4 定向核查）：当前真实方法的 14 项离线检查通过，覆盖采用会话后的状态恢复、首屏读取失败、切换中取消、项目信任早退、连接变化和嵌套切换。项目切换方法使用原方法正文与隔离依赖，结果只代表模拟边界，未写成真实应用故障复现。
- 统一配对浏览器检查通过：只在用户提供的项目窗口中新建测试会话 B，A→B→A→B 往返后原 A 的 13 条历史记录不变；B 的草稿同步和返回后发送正常，两条新测试消息各一次。未发现漏恢复，保留现状；未实机注入导航超时、信任失败或断线，未修改其他 Agent。证据：`_shots/problem-followups-20261029/offline.json`、`browser-results.json`。

### D4 回执应按实际路径区分

- [chat.mjs](../server/agent/chat.mjs) 的 `submitPromptKey()` 服务 Cursor／Devin，按键提交后最多等待 5 秒，每 125ms 读取并归一化文本。
- [codex.mjs](../server/apps/codex.mjs) 的 `submitPrompt()` 在原生窗口路径中通过 `registerSend()` 注册回执，由 `NativeWindow.readReceipts()`／`confirmSends()` 持续确认，支持连接变化后的结果发布。
- Codex 无原生窗口的路径调用 [chat-extract.js](../server/page/chat-extract.js) 的 `waitCodexReceipt()`，监听页面更新事件并设置超时，不是 125ms 轮询。
- 两个应用族读取的数据源、消息标识和附件信息不同，不能直接统一文本匹配规则或 pending 生命周期。Codex 两个分支中重复的发送状态读取、payload 检查、附件与队列意图准备可做局部重构，见 P2。
- 已处理（P2 局部重构）：合并 Codex 两条路径的共有发送准备，保留原有回执机制与取消阶段。相同 32 项用例在修改前后均通过，`npm run check` 通过；P2 与基准比较确认修改仅在 `submitPrompt()` 内。首轮配对浏览器检查普通发送通过，后续项目／会话绑定失效。用户提供独立、已登录并打开项目的窗口后，普通发送、运行中 Queue／Steer、文件与图片附件、原生已接收后丢失最终回执并重连恢复均复测通过；六条测试消息双端历史各一次，重新 attach 后仍完整。请求刚发出即断线的另一时序未通过，未打开项目时还观察到持续等待，均单独记录，未宣称已修复。证据：`_shots/problem-batches-20261029/p2-differential.tap`、`p2-vs-baseline.diff`、`p2-scope.json`；最新浏览器证据见 `_shots/codex-send-retest-20261029/`。

### D5 两套面板策略需要保留

- [cursor.mjs](../server/apps/cursor.mjs) 实现 `withCursorFiles()`；Codex 的 `withFiles()` 委托它，未另写第三套实现。
- [devin.mjs](../server/apps/devin.mjs) 的 `withFiles()` 先等待文件列表完整，仅在实际操作时按需打开面板。它同样通过 `fileTarget(..., "toggle")` 获取开关目标，并非自行直接调用 `filesToggle()`。
- 两套策略影响读取是否打开桌面面板，不能为消除重复而改变。状态：实现差异确认，失败分支未实机验证。

### D6 不能机械替换定时器与坐标计算

- 定时等待包含状态轮询、菜单稳定等待和一次性交互等待，`waitFor()` 则固定等待后执行 page helper，并有自己的截止时间与取消语义，不能全量替换。
- [common.js](../server/page/common.js) 的 `point()` 定义在 `workspaceTrustState()` 内部，其他 helper 无法直接复用。坐标还存在 iframe 偏移、边缘点击等差异。
- 标签提取中的 `aria-label`、正文及 title 优先级会影响可访问名称和实际动作匹配，不默认等价。
- 已处理本轮确认范围（P2／P3）：合并发送准备和五项共同思考缓存的重复赋值。定时等待、坐标与标签提取未全仓替换。

### M1 共享原型分派是结构事实

- [apps/index.mjs](../server/apps/index.mjs) 将各 adapter 的 methods 混入 `AgentContext.prototype`，adapter 还存在共享默认实现和覆盖关系。
- 已处理（P5 结构评估）：枚举实际注册的应用专有方法，Cursor 10、Devin 35、Codex 38、Fusion 0，共 83 个方法名互不重复；此结论不扩大为所有基础类、Session 方法都不存在覆盖。
- Codex 的文件面板显式委托 `withCursorFiles()`，引用菜单调用共享的 `withMentionLock()`。这些复用说明不能直接按文件名隔离原型。未确认合法请求因分派错误失效；拆分会影响共享调用与其他 Agent，保留当前实现，结构重构未实施。证据：`_shots/problem-followups-20261029/registration.json`。

### M2 共享 page helper 的应用判定需按文档上下文评估

- [build.mjs](../server/page/build.mjs) 将 page fragments 拼成同一闭包，helper 使用 `codexThread()`、`devinSurface()` 等识别当前界面；部分 helper 也接收显式 app 参数。
- [common.js](../server/page/common.js) 的 `doc` 指向当前文档或 Codex iframe，并非将所有桌面应用的 DOM 混合。`isBusy()` 位于 `devin.js`，但也被其他应用的共享提取调用。
- 已处理（P5 结构评估）：确认 `build.mjs` 将 14 个片段放入一个闭包，公共 helper 跨片段调用；片段文件名不代表 helper 仅服务同名应用。按应用裁剪需要先迁移共享依赖并调整注入调用，影响范围超出本轮 Codex 定向核查，因此未实施。
- 最终配对浏览器检查中，A、B 及回到 A 三次读取均报告正确 Codex thread，`devinSurface()` 为 `null`；196 项 page 导出快照未变。未复现本次 Codex 场景串应用误判；Cursor／Devin 的真实判定场景未执行，不标通过。

### M3 分支计数用于定位

- 分支主要集中在项目、会话、窗口与发送链路；统计本身不证明行为错误。
- 不将“减少 app 判断数量”作为交付标准，也不为了集中判断新增一层转发或重复能力表。

### R1 读取输入不同，结果差异仍需验证

- [chat.mjs](../server/agent/chat.mjs) 有窗口时读共享快照并克隆，否则直接调用 `extract()`；只有后者传入本会话缓存中的已完整轮次 ID。
- [native-windows.mjs](../server/native-windows.mjs) 的读取传空 known 列表。Codex 索引分页启用 `pageSize = 80` 时，`extract()` 的分页分支也未按该 known 列表过滤，不能仅凭参数差异认定最终内容不同。
- 已处理（P4 定向核查）：统一浏览器检查实际运行 `NativeWindow.read(true)`，与同一空闲 Codex 会话的直接 `extract()` 对比；直接读取还在同一次 CDP 求值内分别传空 known 列表及一个真实原生轮次 ID。A（13 条）、B（2 条）、回到 A（13 条）三次的消息内容、队列、忙碌状态及经过当前 `mergeCodexItems()` 后的消息均一致。
- 当前索引分页路径不通过该 known 参数过滤首屏内容，未确认原报告推断的缺失／重复；保留两条路径。该结果仅覆盖本次 Codex 短历史，未测超 80 条分页、Fusion 非分页、其他 Agent 或运行中数据竞争，也未测性能。证据：`_shots/problem-followups-20261029/readers-a-before.json`、`readers-b.json`、`readers-a-after.json`。

### R2 三类机制职责不同

- [operations.mjs](../server/operations.mjs)：按设备及 operationId 去重，并重放操作结果。
- `switchingThread`：暂停当前上下文在导航过程中的读取和相关操作。
- [window-use.mjs](../server/window-use.mjs)：窗口占用及批量操作排他。
- 状态：共存是当前职责划分，不合并为一个锁。具体竞争问题需要请求顺序与窗口归属证据。

### R3 React 内部读取属于升级敏感依赖

- [codex.js](../server/page/codex.js)、[chat-extract.js](../server/page/chat-extract.js) 通过 React Fiber props、历史 atom 绑定和会话管理器读取或提交数据。
- 静态 DOM 快照不足以验证这些运行时对象。当前没有已验证的替代接口方案，也没有本轮升级故障复现；不新增猜测性的兼容分支或备用数据源。

### R4 容量重试与额度读取不是同一操作

- [native-windows.mjs](../server/native-windows.mjs) 的 `retryCapacity()` 根据容量错误卡片和配置点击重试按钮。
- [codex.mjs](../server/apps/codex.mjs) 的 `readCodexAccount()` 读取账户用量，其 `retryAt` 是读取失败后的退避时间，不会因此重新提交聊天消息。
- 状态：当前核查路径可区分职责，撤回“并存可能重复提交”的推断；重试功能本身未真机验收。

### T1 现有检查不验证业务行为

- [check.mjs](../scripts/check.mjs) 覆盖语法、消息类型对应关系、page 编译、page 导出快照和缺失 import。
- 不验证选择器命中、提取结果、回执先后顺序或真实应用交互。通过该命令只记录为代码检查通过。

### T2 随复杂改动补行为测试

- 修改前未发现自有行为测试或 DOM／Fiber 回放体系。1108 行提取脚本的行为仍依赖真实应用验收。
- 已处理本轮测试缺口：新增 `scripts/codex-submit.test.mjs`（32 项）与 `scripts/thinking-cache.test.mjs`（10 项），均使用 Node 内置测试；相同用例在修改前与当前实现中均通过。未引入框架依赖或全量页面回放平台，不替代用户真机验收。

### T3 `.runtime` 的条件性误报机制成立

- 修改前 [check.mjs](../scripts/check.mjs) 的 `SKIP_DIRS` 未包含 `.runtime`；`serverFiles` 又会将 app、scripts 之外扫描到的 JS 视为协议发出端。因此该目录中的历史诊断脚本可能制造协议误报。
- 原报告记录了 `openAgent, visible, mode` 误报。本次工作区没有 `.runtime/`，未复现该组错误，不能描述成当前检查长期失败。
- 已处理（P1）：仅排除该临时目录，未增加消息类型豁免。使用修改前后真实 `walk()` 函数对同一模拟目录树检查，仅移除了 `.runtime/probe.mjs`，生产文件集合不变；`npm run check` 通过。证据：`_shots/problem-batches-20261029/p1-scope.json`。历史真实目录误报未复现。

### T4 沙箱限制与代码错误分别记录

- 检查器使用 `execFileSync(process.execPath, ['--check', file])`；本会话默认沙箱中观察到其底层 `spawnSync` 返回 EPERM，导致 98 项语法步骤报失败，不能据此认定 98 个文件有语法错误。
- 在允许启动该子进程的执行环境中，同一条 `npm run check` 已完整通过。无需修改检查器或吞掉错误来绕过环境限制。
- 命令结果以退出码和最终汇总为准，不能仅凭中间的 `ok syntax` 日志认定成功。

## 5. 分批处理与执行记录

执行顺序：P1 → P2 → 前两项统一配对浏览器检查 → P3。用户已确认 P3 的共享入口等价重构范围，其他 Agent 的专有逻辑仍不改动。各批完成后与本次修改前基准比较；已通过且未受后续改动影响的检查不重复执行。

### P1 检查器排除本地诊断目录

性质：条件性检查器修复，对应 T3。

状态：已处理。扫描范围与基准对比、`npm run check` 已通过；已按用户要求与 P2 统一执行配对浏览器检查，指定场景在独立项目窗口中复测通过，额外边界现象见第 6 节。

| 文件 | 修改方式 |
|---|---|
| `scripts/check.mjs` | 仅向 `SKIP_DIRS` 增加 `.runtime`。保留生产源码扫描、协议正则和消息类型豁免规则。 |

验证：检查差异仅涉及该目录排除，运行 `npm run check`。当前无 `.runtime`，不将本机检查通过写成历史 Windows 误报场景已复现并修复。此批不新增行为测试，不需要真机功能验收。

### P2 Codex 发送准备逻辑局部去重

性质：维护性重构，对应 D4、局部 D6、T2；不宣称修复了发送误判。

状态：已处理。修改前后各 32 项用例及代码检查通过；已与 P1 统一检查配对浏览器；用户提供独立项目窗口后，普通发送、Queue／Steer、文件／图片附件和原生已接收后的断线回执恢复均通过。真机待用户验收；额外边界现象见第 6 节。

| 文件 | 修改方式 |
|---|---|
| `server/apps/codex.mjs` | 在 `submitPrompt()` 内抽出原生窗口与无原生窗口两条路径共有的发送状态读取和准备逻辑，包括 payload 检查、预期文本、附件事实、`follow`／`when` 队列意图；路径特有信息和回执处理继续留在各分支。 |
| `scripts/codex-submit.test.mjs`（新增） | 使用 Node 内置测试与模拟 CDP／窗口对象，验证两种路径的发送意图和回执边界。数据写在用例中，不保存真实聊天内容。 |

必须保持的行为：

- 每次提交只读取一次发送前状态，并只触发一次原生提交。
- 原生路径仍在提交前注册回执，保留 operation 的 pending／submitted 时序、断连后的回执发布和附件状态更新。
- 无原生窗口路径仍使用现有页面事件等待，不把它替换成窗口回执，也不改为轮询。
- 保留 payload 未就绪报错、只含附件、空白文本、忙碌时 queue／steer、默认 follow 设置及提交失败的现有语义。
- 不改 Cursor／Devin 的文本归一化、Fusion 流程、协议消息或 page helpers；不移动取消检查到不同的提交阶段。

自动检查：`node --test scripts/codex-submit.test.mjs`，随后 `npm run check`。用例覆盖普通发送、显式 queue／now、默认 follow、只含附件、payload 未就绪、原生提交拒绝／结果未知，以及注册回执先于提交。

用户真机验收：仅 Codex，验证普通消息、运行中排队和追加、附件发送、发送后断线重连仍能收到结果。其他功能未受影响则不扩大验收。真机项目均保持待验收，上述配对浏览器复测不替代用户真机验收。

### P3 共同思考缓存重建的等价提取

性质：已授权的共享层等价重构，对应 D1、局部 D6、T2。用户本轮确认了共享入口范围；其他 Agent 的 adapter 专有逻辑仍未改动。

状态：已处理。修改前后各 10 项缓存／attach 用例及代码检查通过；P1/P2 统一浏览器检查结束并恢复现场后，已按原环境与参数重启 relay 加载 P3，HTTP 健康检查通过。P3 加载后，既有配对入口的 Codex、原 Cursor attach／原会话读取及选择、草稿恢复检查通过；Devin／Fusion 真实流程未验。

| 文件 | 修改方式 |
|---|---|
| `server/agent/thinking-cache.mjs`（新增） | 提供一个仅重建五项共同思考缓存的函数：`thinking`、`thinkingTried`、`keptThink`、`thinkLiveSeen`、`thinkFinal`。保持每次创建新 Map／Set 的现有语义。 |
| `server/agent/context.mjs` | `resetCaches()`、`clearViewState()` 中五项相同赋值改调该函数；其余字段、选择代次、Fusion 缓存处理继续由原方法负责。 |
| `server/session.mjs` | `openBound()` 中五项相同赋值改调该函数；保留窗口 `itemCache` 的绑定、会话字段和连接建立顺序。 |
| `server/apps/codex.mjs` | `mergeCodexItems()` 的 thread 变化分支调用同一函数；保留 `latestThink`、`thinkTries` 及 thread 合并和裁剪逻辑。 |
| `scripts/thinking-cache.test.mjs`（新增） | 覆盖多上下文共享窗口缓存、选择变化与局部思考状态重置，验证共享缓存与会话专有状态不会被误清。 |

本批不调用总重置函数替代视图重置，不把重建 Map／Set 改为 `.clear()`，不向重置范围添加字段；不修改 Devin 的 `syncSession()` 保存与恢复逻辑。构造、attach、视图切换与 Codex thread 变化继续是各自的生命周期入口。

自动检查：`node --test scripts/thinking-cache.test.mjs`，随后 `npm run check`。重点验证两个上下文仍引用同一窗口 Map；重置其中一个上下文后，共享历史仍存在，另一上下文的思考状态不受影响，非目标缓存引用和内容保持原值。

用户真机验收：检查受影响 Agent 的 attach、会话往返切换和历史读取；Devin 关注按会话恢复的历史。Fusion 私有缓存已做自动化边界检查，真实双方执行流程仍由用户验收，未执行不记通过。

### P4 会话切换与历史读取联合核查（D3／R1）

状态：已处理本轮核查，未新增业务修改。先保存当前工作区基准，再核对 Codex 切换入口与共享读取路径；14 项离线状态恢复检查通过，最终统一配对浏览器检查会话往返、草稿、发送与读取结果一致性通过。

本轮只更新 `docs/problem.md`，测试脚本、源码快照及证据放 `_shots/problem-followups-20261029/`，不新增永久测试文件。业务源码未变，不执行无根因的守卫合并，也不统一两条读取机制。页面事件路径、其他 Agent 和 Fusion 不扩大检查。

### P5 原型注册与页面判定结构评估（M1／M2）

状态：已处理本轮评估，结构拆分未实施。当前 83 个应用专有方法无同名覆盖，Codex 存在显式跨片段／共享方法依赖；没有确认需要本轮修复的分派或判定故障。

按 `AGENTS.md` 的“不改其他 Agent”“不动 page 导出快照”范围，保留 `server/apps/index.mjs`、`server/page/build.mjs`、注入片段及调用方。以后若实施结构拆分，必须先明确共享方法归属、逐文件改法与多 Agent 验证范围，再取得用户确认。本轮最终浏览器只验证 Codex 的当前文档判定，其他 Agent 未实测。

### 不纳入当前代码批次的条目

- D2、D5、R2、R4：保留已说明的所有权和职责差异，不为统一形式改行为。
- D3、R1：本轮 P4 定向核查已完成；当前场景未确认故障，保留实现。以后出现具体复现，再列根因、文件范围和验收方案供用户确认。
- M1、M2：本轮 P5 评估已完成；跨 Agent 原型及 page 拆分未实施，不把结构评估写成结构改造已完成。
- M3、D6 的全仓统计：不设消除分支和定时器的任务，不全仓替换。
- R3：升级出现明确断点后再改对应读取位置；当前不引入兼容层、额外数据源或新的 page 导出。
- T1、T2：只补与 P2／P3 相关且能验证行为边界的测试，不扩建全仓测试平台。
- T4：通过适当执行环境运行检查，保留失败记录，不修改业务代码或检查结论。

## 6. 验证记录与未覆盖范围

| 项目 | 当前状态 |
|---|---|
| 定向代码核查与上述词法计数 | 已执行 |
| `npm run check` | P3 修改后完整通过：语法 101 文件、前端发送 102 类型、服务端发出 69 类型、page 编译、196 个导出、68 个模块 import；沙箱曾出现的 EPERM 单独记录在 T4 |
| P1 代码修改 | 已处理；仅排除 `.runtime`，范围对比及代码检查通过 |
| P2 代码修改 | 已处理；P2 与基准比对仅修改 `submitPrompt()`；指定发送场景配对浏览器复测通过，额外边界现象另列 |
| P2 行为测试 | 修改前后同组用例各通过 32 项，宿主测试运行器共 64 项通过 |
| P3 代码修改与行为测试 | 已处理；修改前后各 10 项通过；relay 已加载 P3，既有 Codex／Cursor 入口读取和恢复检查通过 |
| 修改前基准比对 | 已执行；仅 5 个原有文件变化，其他 453 个跟踪文件逐字节指纹一致；新增 1 个 helper、2 个测试文件，见 `_shots/problem-batches-20261029/scope.json` |
| P1/P2 统一配对浏览器检查 | 复测通过：用户提供独立、已登录且已打开项目的 Codex 窗口；普通消息最终回执及生成结束，独立 thread 双端一致 |
| 排队／追加／附件／断线回执 | 复测通过：一次 `sleep 25` 中分别 Queue／Steer，队列执行完毕；文本文件与 PNG 同次发送；原生已接收后的最终回执在前端处理前模拟丢失，重连取得相同消息 ID，无重发 |
| 历史完整性／重复发送 | 复测通过：六条测试消息双端历史各出现一次，重新 attach 后仍完整；只有一次 `sleep 25` 工具调用，测试会话结束且草稿为空 |
| 测试现场恢复 | 已确认：工作窗口的原会话、草稿及页面 `timeOrigin` 未变，网页恢复原 Cursor 选择和草稿，无待确认发送，临时钩子已移除；9 个配对入口凭据指纹未变，用户提供的第二个窗口保留；见最新 `restore.json` |
| P4 D3／R1 联合核查 | 已处理本轮核查；14 项离线边界检查、会话 A／B 往返、草稿同步、返回后发送及 3 次读取对比通过；未新增业务修改 |
| P5 M1／M2 结构评估 | 已处理本轮评估；专有方法无同名覆盖，Codex 当前文档判定通过；结构拆分未实施，其他 Agent 未实测 |
| P4／P5 本轮基准与恢复 | 与本轮开始时当前工作区比较，仅 `docs/problem.md` 变化，其余 460 个基准文件指纹一致；原网页选择、两处原会话与草稿、工作页面和配对凭据已核对恢复 |
| 用户真机验收 | 未执行 |
| Ubuntu 桌面真实应用回归 | 已通过上述范围内的真实 Codex 窗口与配对网页检查；其他桌面功能未扩大验收，用户手机验收未执行 |
| Fusion 全流程 | 未执行，不计入本轮核查通过项 |
| 性能测量 | 未执行，不对轮询、克隆、提取或 Fiber 扫描成本作结论 |

本次为定向核查，不是全仓逐行审计。Android、iOS、推送服务、CLI、手机端及其他未涉及区域未全面审查；Fusion 业务流程未审查。本文的静态证据与检查通过不替代运行中的应用验证或发布验收。

### 6.1 配对浏览器复测与证据

首轮记录保留在 `_shots/problem-batches-20261029/`：最初隔离窗口未继承登录态，随后夹具未保证持续绑定独立会话，误绑定回执未计入通过结果；经双端 thread 核对后仅普通发送通过，后续绑定失效。原生新会话预填的历史提示未被提交，原现场已恢复。该轮未完成项现已使用用户另行提供的独立窗口复测。

P1—P3 的发送复测记录在 `_shots/codex-send-retest-20261029/`；本轮 P4／P5 的统一浏览器检查见第 6.3 节。发送复测证据：

- `results.json`、`history.json`：普通发送、Queue／Steer、附件、回执恢复和重新 attach 的断言结果；六条消息各一次，预期回复齐全。
- `attachments.json`：原生附件列表确认文本文件和 PNG 均已上传，发送后附件清空。
- `reconnect.json`、`browser-evidence.json`：电脑端已接收，网页在处理最终回执前模拟断线；新连接恢复相同原生消息 ID，未再次发送。
- `restore.json`：工作窗口的原会话、草稿及页面未变；原配对网页选择、草稿恢复，9 个凭据指纹一致，用户提供的测试窗口保留。
- `paired-final.png`、`native-final.png`：最终配对网页和原生工作台截图。收尾脚本的原生 Webview 截图步骤不支持该 CDP 命令，业务断言与恢复已执行；随后从顶层工作台补拍，见 `capture.json`。
- `source-hashes.json`、`scope.json`：复测前后源码指纹与原修改前基准比较。本轮只更新本文及 `_shots/` 测试产物，业务代码、其他 Agent 和 page 导出快照未变。

### 6.2 测试边界记录（已按用户要求搁置）

用户已要求不再排查下面两项；它们不作为后续待修故障，不据此修改代码。原始观察保留备查。

| 场景 | 实际观察 | 结论 |
|---|---|---|
| 登录后尚未打开文件夹的空窗口 | 原生明确提示 `Please open a folder or workspace to continue`，网页仍等待电脑接收；该次没有原生消息。用户打开项目后，指定发送场景通过 | 已复现；未修改拒绝／回执处理，未与修改前基准同场景比较，归因待查。见 `missing-folder-attempt.json`、`native-status.png` |
| 请求刚从网页发出就立即断线 | 首次尝试未取得最终回执；原生历史无该条消息，网页与原生保留测试草稿。确认无提交后才重试一次 | 该时序未通过；未与基准同场景比较。与上表已通过的“原生已接收后丢失回执”分别记录；见 `early-disconnect.json` |

上述现象均未随本轮测试修改业务代码，未标为已修复。无原生窗口的页面事件发送路径仍只有自动化用例验证；用户手机、Devin／Fusion 真实流程继续待验收。


### 6.3 P4／P5 最终统一配对浏览器检查

两批核查及评估结束后，使用现有配对入口和用户提供的同一个项目窗口集中执行；没有操作正在进行本任务的工作会话，也没有启动新的应用窗口。

- 先记录配对网页的应用／窗口／会话与草稿、两个原生窗口的会话／草稿、工作页面 `timeOrigin` 和 9 个配对入口凭据指纹。
- 在独立测试窗口中创建会话 B，只发送两条要求固定回复且不执行命令、不读写项目文件的短消息；验证 A→B→A→B 往返、A 的原历史、B 的草稿同步及返回后继续发送。两条新消息各一次，均取得原生最终回执和预期回复。
- 在 A、B、返回 A 三个时点，对比当前 `NativeWindow.read(true)` 快照与直接读取，并比较空 known 与真实原生轮次 ID 两种输入；消息及实际合并结果一致。该测试只覆盖本次短历史，未证明所有历史与并发场景等价。
- 首次测试夹具误要求分页快照的 `_completeTurnIds` 非空，未发新消息即停止并恢复；随后从 `codexSendState().lastTurn` 取实际轮次 ID 构造非空输入，正式检查退出码为 0。该次夹具纠正不属于产品故障，见 `fixture-correction.json`。
- 最后把测试窗口恢复为原会话 A，配对网页恢复原 Cursor 选择和草稿，临时回执钩子移除，无待确认发送；工作窗口原会话、草稿和页面未变，9 个凭据指纹一致，用户提供的测试窗口保留。

证据统一放在 `_shots/problem-followups-20261029/`：`offline.json`、`registration.json`、`browser-results.json`、`readers-*.json`、`receipts.json`、`restore.json`、`scope.json`、`paired.png`、`native.png`。业务代码、其他 Agent、page helpers 和导出快照与本轮基准一致；`npm run check` 通过。用户手机、其他 Agent 以及真实导航异常中断仍未验收，不标通过。

## 7. 2026-10-30 重复实现补充核查与实施

基准为本轮修改前的当前工作区（开始时 HEAD `cae9908`、网页 v336），源码快照和跟踪文件指纹放在 `_shots/dedup-347-20261030/`。N1—N7 对应本轮讨论的第 1—7 项，与历史 D／M／R／T 编号分开记录。

核查以功能归属、调用顺序和状态变化为依据。重复代码不自动视为已发生的功能缺陷；隔离验证不代替手机真机验收。

| 编号 | 问题与核查结论 | 处置与范围 |
|---|---|---|
| N1 会话资源回收重复 | 已用 `stopChatUpdates()` 统一释放聊天订阅并清理引用；空闲销毁时同一回调由 2 次减为 1 次，操作未完成时停止订阅后仍延后释放连接 | 已处理（2026-10-31）；12 项生命周期隔离对比、配对浏览器隔离场景及 `npm run check` 通过，真机待验。保留暂停、导航失败、模式切换、定时器与 CDP 释放的原顺序，不统一整个生命周期 |
| N2 Devin 输入区显隐恢复重复 | `revealDevinComposer()` 现只定义在私有片段 `server/page/devin-composer.js`，页面与 `FOCUS_COMPOSER` 复用同份源码 | 已处理（2026-10-31）；11 项显隐及源码归属检查、8 种实际 DOM 的浏览器对比、修改前后 `npm run check` 通过，196 个对外导出未变；真机待验。保留输入框选择、可见性、聚焦与光标逻辑，不加载整份 page helpers 到聚焦脚本 |
| N3 认证后重复保存电脑资料 | socket 层 `updateComputerRecord()` 已保存身份、名称和地址，前台认证处理再调用 `rememberComputer()`；前台冷启动认证的重复身份资料保存已由 2 次减为 1 次 | 已处理；自动及配对浏览器基准对比通过，真机待验。仅移除前台重复保存，由 socket 层保存资料；保留认证、电脑身份核对、会话选择保存及前台状态处理 |
| N4 断线取消步骤重复维护 | `boot()` 与前台 `link.closed()` 各维护相同的上传、发送、文件读取、文件保存等待、历史请求、批量操作、Codex 重试取消步骤，现已提取为 `cancelConnectionWork()` | 已处理；自动及配对浏览器基准对比通过，真机待验。保留两个入口原有的触发条件、7 项公共取消顺序、状态更新和重连流程，保留后续正常导航的独立清理 |
| N5 Codex 菜单操作重复 | 四个入口已复用文件内部的 `readCodexMenu()`；列表展示和指定选项查找使用各自的选择条件 | 已处理（2026-10-31）；13 项基准差分、实际 DOM 菜单浏览器对比及 `npm run check` 通过，真机待验。保留过滤、等待次数与间隔、错误提示、退出菜单、选择后刷新和重命名处理 |
| N6 地址记录解析分散 | 三个入口已复用 `findPublishedEntry()` 按 ID 查找；配对与连接的原逐条尝试复用 `readPublishedEntry()`，解密和业务处理仍由入口提供 | 已处理（2026-10-31）；27 项真实 AES-GCM 基准对比、28 项现有电脑切换测试、浏览器地址解析及设备证明检查和 `npm run check` 通过，真机待验。保留返回地址字符串、匹配策略、错误、资料更新顺序、注销超时及设备验证；未新增扫描、兜底或兼容路径 |
| N7 输入框展示判定重复 | `composeCompactWanted()` 现仅保留屏幕形状、空文本和无附件这 3 个附加条件；两个调用点继续先通过 `composeIdleWanted()` | 已处理；22 种状态及 11 种延迟变化的自动对比、5 种实际布局的配对浏览器对比通过，真机待验。仅改紧凑条件，保留统一空闲检查、延迟重查及原展示时序 |

代码位置：N1 见 [session.mjs](../server/session.mjs)；N2 见 [devin-composer.js](../server/page/devin-composer.js)、[context.mjs](../server/agent/context.mjs) 和 [devin.js](../server/page/devin.js)；N3／N4 见 [net.js](../app/js/net.js)；N5 见 [codex.mjs](../server/apps/codex.mjs)；N6 见 [net.js](../app/js/net.js) 和 [notify.js](../app/js/notify.js)；N7 见 [composer.js](../app/js/composer.js)。

本轮不将以下机制认定为应合并的重复实现：

- 键盘两种收起方式已汇入 `fitViewport()`，吸底由统一滚动控制器处理；多个事件和延时回调不是另一套算法，本轮不修改键盘或滚动逻辑。
- 原生窗口快照与直接页面读取保留各自输入及生命周期。
- 操作回执去重、切换控制和窗口占用控制职责不同。
- 概览回复已复用 `Session.handle()`，不另行重写发送流程。

### 7.1 2026-10-30：N3／N4／N7 修改与验证

| 文件 | 修改内容 |
|---|---|
| `docs/problem.md` | 记录上述 7 项；每项处理结束更新核查结论，验证结果与真机待验范围分别记录 |
| `app/js/net.js` | N3 删除前台认证成功后的重复资料保存；N4 提取共同取消步骤并替换两处调用，不改变认证、设备归属、失败重试和恢复策略 |
| `app/js/composer.js` | N7 紧凑模式只判断 3 项附加条件；两个调用点继续先检查空闲状态 |
| `app/js/core.js`、`app/index.html`、`app/sw.js` | 仅同步网页版本与已修改脚本缓存引用 |

已执行验证：比对认证前后台及失败时的电脑资料写入、选择与草稿；比对主动重连和连接关闭时的取消顺序与触发条件；使用修改前后相同的输入框状态用例核对文本、附件、焦点、提问输入、输入法、语音、菜单、图片编辑、横竖屏及延迟重查行为。运行 `npm run check`，使用既有配对浏览器的隔离测试页验证受影响场景，并核对原页面状态保留。

| 检查 | 结果与边界 |
|---|---|
| `npm run check` | 通过：104 个语法文件、103 类发送消息、69 类服务端消息、196 个 page 导出、70 个模块导入 |
| 现有电脑切换回归 | 28 项通过；覆盖前后台加载、切换、草稿归属、过期消息及认证失败等受影响边界 |
| 本轮基准对比 | 9 项通过；身份资料写入由 2 次减为 1 次，最终资料与前台状态一致；取消步骤及入口条件与基准一致；输入框 22 种状态、11 种延迟变化的展示判定一致 |
| 配对浏览器对比 | 9 项检查通过，零页面异常。基准 v336 与本地 v337 均使用合成电脑和独立测试缓存；认证、前后台重连、草稿及清理顺序对比通过；竖屏空输入、横屏空输入、横屏文字、横屏附件、横屏提问输入焦点这 5 种布局的根节点、输入框和 footer 尺寸一致 |
| 修改范围与现场 | 仅上述 6 个文件变化；服务端、page helpers、导出快照及其余跟踪文件与本轮基准一致；原配对页面的存储、选择、草稿、视口及缓存核对一致，隔离测试页已关闭 |
| 手机真机 | 待用户验收；隔离浏览器和状态用例不作为实际 iPhone 键盘、语音或系统挂起验收通过的依据 |

该批最终网页版本为 v337。证据放在 `_shots/dedup-347-20261030/`：`baseline.json`、`differential.tap`、`browser-results.json`、`original-preserved.json`、`summary.json`。当时 N1、N2、N5、N6 仅记录；后续实施见第 8 节。该批未提交、未推送、未发布网页、未重启正式中继。

## 8. 2026-10-31：N1／N2／N5／N6 分批实施与验证

用户已授权按确认方案处理剩余四项，实际按 N5 → N1 → N2 → N6 分批修改。基准为本轮开始的当前工作区：HEAD `ccf963d`、网页 v337；只读核对 GitHub master 指向同一提交。开始时 `docs/problem.md` 尚有未提交记录，已纳入基准并保留。未从远端覆盖或重置工作区。

| 文件 | 实际修改及保持的边界 |
|---|---|
| `server/apps/codex.mjs` | N5：仅提取打开、等待和读取菜单的文件内私有函数，四个菜单入口复用；列表过滤、目标查找、重命名、菜单关闭及后续刷新仍由原入口处理 |
| `server/session.mjs` | N1：五个生命周期入口复用停止聊天订阅的方法，取出回调后清空引用再执行，避免销毁链重复调用；各入口自己的取消、代次、定时器、窗口与 CDP 释放顺序保留 |
| `server/page/devin-composer.js`（新增）、`server/page/build.mjs`、`server/page/devin.js`、`server/agent/context.mjs` | N2：把原显隐函数移为一份私有源码片段，完整页面脚本和轻量聚焦脚本共同嵌入；不增加 page 对外导出，不改变输入框选择与光标规则 |
| `app/js/net.js`、`app/js/notify.js` | N6：提取按电脑 ID 找地址记录及原有逐条读取循环；各入口保留格式判断、解密、错误及电脑资料更新职责。注销仍严格按 ID 查找，保留 8 秒超时；未增加地址扫描或设备验证旁路 |
| `app/js/core.js`、`app/index.html`、`app/sw.js` | 网页版本同步为 v338，只更新 core、net、notify 的缓存引用 |
| `docs/problem.md` | 四项各自完成后标明已处理，汇总本轮验证、影响范围与真机待验项 |

验证与证据均在 `_shots/dedup-1256-20261031/`，不加入正式源码目录：

| 检查 | 结果与边界 |
|---|---|
| 分批 `npm run check` | N5、N1、N2、N6 每批完成后通过；N2 修改 page helpers 前也已通过。最终结果：104 个语法文件、103 类发送消息、69 类服务端消息、196 个 page 导出、70 个模块导入；导出快照未改 |
| N5 基准差分 | `menus.test.mjs`：13 项通过，覆盖正常／空菜单、目标延迟出现、缺失菜单与选项、异常、重命名，以及调用顺序和退出方式 |
| N1 生命周期对比 | `lifecycle.test.mjs`：12 项通过，覆盖暂停恢复、模式切换、导航失败、空闲销毁、操作未完延后销毁与 Fusion 状态保留；普通销毁的同一停止回调由 2 次减为 1 次，延后销毁链由 3 次减为 1 次 |
| N2 私有片段对比 | `devin-composer.test.mjs`：11 项通过，覆盖欢迎层显隐、标记恢复、缺失节点及源码唯一归属；聚焦脚本未嵌入完整 page helpers |
| N6 地址解析对比 | `discovery.test.mjs`：27 项通过，使用实际 AES-GCM 加解密，对比格式、匹配与逐条尝试、错误、失效选择、资料写入失败及更新时间；保留配对找到记录后原有的最终再次解密行为 |
| 既有受影响回归 | 28 项电脑切换测试通过；`node --test scripts/codex-submit.test.mjs scripts/thinking-cache.test.mjs` 的 42 项通过。结合四批新增对比，共 133 项自动用例通过 |
| 配对浏览器统一检查 | `browser.mjs`：9 项通过，零页面异常。使用既有配对浏览器中新开的隔离测试页，加载本地 v338；真实服务端认证与 Session 方法配合合成电脑，验证订阅重建、保留期复用、过期释放、后台模式切换、地址解析及无效设备证明拒绝；8 种实际 DOM 对比显隐／聚焦及 iframe；Codex 菜单真实 DOM 对比覆盖列表、选择、重命名及失败退出；402×874 与 874×402 布局检查通过 |
| 原页面与修改范围 | 原配对页面的存储、选择、草稿、视口、聊天缓存及恢复缓存指纹一致，临时页面已关闭；仅上述 11 个既有文件及 1 个私有片段变化，其他 Agent 专有实现、认证模块、UI 展示和导出快照未改 |
| 待用户真机验收 | 手机连接、短时返回、保留期过后重连及聊天／终端切换；Devin 新会话欢迎层与已有会话的输入聚焦；Codex 执行位置／会话菜单及重命名；配对、连接、注销。隔离浏览器没有执行真实 Agent 发送、归档或注销，不将这些原生操作及手机系统挂起记为通过 |

主要结果文件：`n5.tap`、`n1.tap`、`n2.tap`、`n6.tap`、`existing-backend.tap`、`browser-results.json`、`original-preserved.json`、`scope.json`、`summary.json`。电脑切换的 28 项结果记录在 `n6-and-computer-switch.tap`；该首次合并日志还含一个后续已修正并在 `n6.tap` 复验通过的 N6 错误文案对比，不把旧日志写成全部通过。最终浏览器检查前曾修正测试脚本自身的正则转义，未因此增加产品兜底逻辑。

本轮未提交、未推送、未发布网页、未重启正式中继。v338 为本地完成版本，正式环境仍运行原版本；用户真机验收前需要另行加载网页与中继修改。

## 9. 2026-10-31 复查：重复/简化、生命周期与检查一致性

本轮为只读复查，未改代码。基准：本地 HEAD `6aa4277`（网页 v347）；本文件按用户要求从 `origin/b89927a` 单独拉取，记录截至 v338，代码已领先若干个版本。方法：全仓模式扫描、同口径计数、定点评读，不逐行阅读。以下除注明外均为代码事实或测量值，没有复现用户可见故障。

### 9.0 当前问题总表

本节合并 2026-10-31 的两轮复查，共 18 项未处理：重复/简化 8 项、生命周期 2 项、静默失败与一致性 3 项、检查与文档 5 项。第 7、8 节已处理的 N1—N7 不重复列出。

| 类别 | 编号 | 事项 | 状态与建议 |
|---|---|---|---|
| 重复 | N8 | 21 处延时刷新 | 未处理；低风险，建议抽 `refreshSoon` |
| 重复 | N9 | 切换守卫 34 处、7 份模板 | 未处理；中风险 |
| 重复 | N10 | `withFiles` 3 套 | 未处理；中风险 |
| 重复 | N11 | `newTerminal` 3 份 | 未处理；低风险 |
| 重复 | N12 | `codex.mjs` 约 57.8KB 单体 | 未处理；低风险，纯搬迁 |
| 重复 | N13 | 页面端应用嗅探 33 处 | 未处理；高风险 |
| 重复 | N14 | 主链路 app 分支（projects 45、chat 33 等） | 未处理；高风险，不建议现在动 |
| 重复 | N15 | 三元素数组 19 处、11 个文件 | 未处理；低风险，建议从 `EDITORS` 派生 |
| 生命周期 | L1 | 按 thread 建的上下文缓存无淘汰 | 未处理；低风险，建议加条数上限 |
| 生命周期 | L2 | 限流按 IP 的记录只增不删 | 未处理；低风险，建议清理过期键 |
| 静默失败 | S1 | 空 `catch` 105 处 | 未处理；建议统一记录 |
| 静默失败 | S2 | 静默 app 守卫 30 处 | 未处理；记录，不急于改 |
| 一致性 | G1 | 切换守卫无超时告警 | 未处理；记录 |
| 检查 | T5 | 行为测试未接入 `npm run check` | 未处理；低风险，建议加 `npm test` 或并入检查 |
| 文档 | T6 | 本文件记录止于 v338，代码已到 v347 | 本节已注明；后续随版本维护 |
| 检查 | T7 | 版本号需手工同步 5 处 | 未处理；低风险，建议加一致性检查 |
| 检查 | T8 | `sw.js` 的 SHELL 为手工列表 | 未处理；低风险，建议与 index 比对 |
| 文档 | T9 | 概览功能未写入使用指南 | 未处理；低风险，补文档 |

### 9.1 与第 3 节冻结基准的同口径对比

| 指标 | 第 3 节基准 | 本次实测 | 说明 |
|---|---|---|---|
| 名为 `app` 的字面量相等／不等判断 | 283 处、37 个文件 | 303 处、40 个文件 | 同口径 `\bapp\s*(?:===\|!==)\s*['"]` |
| `switchingThread` | 33 处、8 个文件 | 34 处、8 个文件 | 字符串出现次数 |
| 固定写法的定时等待 | 109 处 | 106 处 | `new Promise(r => setTimeout(r,` |
| `this.waitFor()` 调用 | 27 处 | 27 处 | 未变化 |
| `pollChat` 延时刷新 | 21 处 | 21 处 | 未变化 |
| `server/page/chat-extract.js` | 1108 行 | 1115 行 | 当前文件行数 |
| 行为测试 | 未发现 | 3 个 `scripts/*.test.mjs` | 未接入 `npm run check`，见 T5 |

说明：v306 至 v347 之间约 82 个提交，新增 `overview.js` 等模块；计数上升不等于重复恶化。跨文件 3 行重复块按同一扫描脚本，本轮为 5 处（此前同脚本为 28 处），精确复制已明显减少；该指标第 3 节未冻结，只作趋势参考。

### 9.2 仍存在的重复或可简化位置（N8—N15）

| 编号 | 位置 | 现状 | 可简化方式 | 风险与验证 |
|---|---|---|---|---|
| N8 延时刷新重复 | 21 处 `setTimeout(() => this.pollChat()…)`：`devin.mjs` 9、`codex.mjs` 5、`cursor.mjs` 3、`menus.mjs` 2、`chat.mjs` 2 | 每处各自写延时与 `catch` | 抽 `refreshSoon(ms)`，调用点变一行 | 低；代码已确认，未修改 |
| N9 切换守卫模板 | 34 处引用、8 个文件；7 份 `const switching = this.switchingThread` 模板 | 保存旧值、`try/finally` 手工恢复 | 抽 `withSwitching(previousCdp, fn)` | 中；需保持 finally 顺序，未修改 |
| N10 文件面板包装 | [cursor.mjs:151](../server/apps/cursor.mjs#L151)、[devin.mjs:160](../server/apps/devin.mjs#L160)、[codex.mjs:174](../server/apps/codex.mjs#L174)；[files.mjs:45](../server/agent/files.mjs#L45) 仅转发 | 打开／关闭面板和 settle 各写一遍 | 抽 `withFilePanel(open/close/state)`，差异做成钩子 | 中；用户可见动作，未修改 |
| N11 新建终端 | [cursor.mjs:155](../server/apps/cursor.mjs#L155)、[devin.mjs:185](../server/apps/devin.mjs#L185)、[codex.mjs:178](../server/apps/codex.mjs#L178) | cursor 与 devin 逐字相同，codex 少一步 `bringToFront` | 统一 `openTerminal({ focus })` | 低；未修改 |
| N12 Codex 适配器单体 | [codex.mjs](../server/apps/codex.mjs) 约 57.8KB | 队列、请求卡、容量重试、历史合并都在一个文件 | 按 `devin-composer.js` 先例拆模块，纯搬迁 | 低；改动面大，未修改 |
| N13 页面端应用嗅探 | [chat-extract.js](../server/page/chat-extract.js) 中 33 处 `codexThread()`／`devinSurface()` 判定 | 每次提取重新判断当前 app | 入口判定一次，分派到 per-app 模块 | 高；页面无行为测试，未修改 |
| N14 主链路 app 分支 | 宽口径（含 `'codex' ?` 等三元）：`projects.mjs` 45、`chat.mjs` 33、`session.mjs` 21、`menus.mjs` 18、`routes.mjs` 16 | 会话／项目与发送两条主链路分支集中 | 抽 per-app hook | 高；与第 3 节窄口径不可直接相加，仅用于定位 |
| N15 三元素数组硬编码 | `['cursor', 'devin', 'codex']` 共 19 处、11 个文件：`owner.mjs`、`api.mjs`、`latency.mjs`、`launch.mjs`、`native-windows.mjs`、`project-windows.mjs`、`session.mjs`、`ws.mjs` 等 | [config.mjs](../server/config.mjs) 已有 `EDITORS`，各模块仍自行写死 | 从 `EDITORS` 派生；用户文案可继续单独维护 | 低；代码已确认，未修改 |

### 9.3 生命周期、静默失败与检查（L1／L2／S1／S2／G1／T5—T9）

| 编号 | 事实与位置 | 影响 | 验证 |
|---|---|---|---|
| L1 上下文缓存无淘汰 | [windows.mjs:62](../server/windows.mjs#L62) 的 `codexContextFiles`、`codexContextChecks`、`codexContextCache` 以 thread 为键写入（107／108／117 行），只有 `codexContextReads` 在读完后删除（91 行） | 中继长期运行、会话增多时内存和旧文件路径只增不减 | 代码已确认；内存增长未测量 |
| L2 限流记录只增不删 | [ratelimit.mjs:8-23](../server/http/ratelimit.mjs#L8-L23)：`failures` 以 IP 为键，`lockedOut()` 只过滤该 IP 的时间戳，不删除过期 IP 的键；`recordFailure()` 继续添加新键 | 公网入口被扫描时，Map 键随来源 IP 数量增长，长期不收敛 | 代码已确认；实际增长未测量 |
| S1 空异常处理 | 全仓 `catch(() => {})` 共 105 处 | 失败路径无日志、无计数，表现为“没反应” | 计数已确认；具体掩盖过的失败未统计 |
| S2 静默 app 守卫 | `app !== 'codex'` 一类守卫共 30 处：`chat.mjs` 6、`devin.mjs` 6、`codex.mjs` 4、`routes.mjs` 4、`projects.mjs` 3、`native-windows.mjs` 2，其余 5 个文件各 1 | 调错 app 时静默返回，掩盖真实调用错误 | 代码事实已确认；实际误用未验证 |
| G1 切换守卫无超时 | 7 份手工恢复模板；[chat.mjs:166](../server/agent/chat.mjs#L166) 在 `switchingThread` 为真时直接跳过轮询 | 某条路径漏恢复时聊天同步和草稿同步持续停摆，且无告警 | 机制已确认；漏恢复未复现 |
| T5 测试未接入检查 | `scripts/codex-submit.test.mjs`、`thinking-cache.test.mjs`、`computer-switch.test.mjs` 存在；`package.json` 无 `test` 脚本，`check.mjs` 不执行它们 | 新测试不会自动运行，改坏后无人发现 | 配置已确认；本机 `node --test` 因沙箱拒绝 `spawn` 失败（EPERM） |
| T6 文档与代码不同步 | 本文件第 7／8 节记录到 v338；当前 HEAD 为 v347；第 3 节是冻结的“修改前”基准，不是现状；`overview.js` 等新模块未纳入 | 把本文件当作当前问题清单会漏掉新代码与已处理项 | 版本、计数已核对 |
| T7 版本号手工同步 | 需要人工保持一致的有 5 处：`index.html` 的 `app.css?v=`、`core.js?v=`；`core.js` 的 `APP_VERSION`；`sw.js` 的 `CACHE`；`sw.js` 的 `SHELL`。当前一致（`APP_VERSION`／`CACHE` v347，`app.css?v=342` 在 index 与 SHELL 一致） | 发版漏改一处会出现外壳与缓存资源不同步，或预缓存 404 | 现状已核对；`check.mjs` 不校验，漂移未被拦截 |
| T8 SHELL 手工列表 | [sw.js:5-9](../app/sw.js#L5-L9) 的预缓存列表需手工加入新脚本；`overview.js?v=347` 本轮已加入 | 新增或改名脚本漏加时，离线首屏缺资源 | index 引用与 SHELL 已逐项比对，当前无缺失；无自动检查 |
| T9 概览功能未写入文档 | `#overview`、[overview.js](../app/js/overview.js)（约 56.7KB）提供“电脑 → 项目 → 会话”分组与批量管理；`docs/usage.md`、`docs/usage.en.md` 中检索“概览／overview／批量管理”为 0 处 | 用户可见入口缺少使用说明 | 代码与文档检索已确认 |

### 9.4 不作为应合并项

- `listAgents` 有 4 份实现（`cursor.mjs`、`devin.mjs`、`codex.mjs`、`projects.mjs`），规则和返回结构不同，合并会变成更大的条件分支。
- Codex 的 `submitPrompt` 主路径已使用 `NativeWindow.registerSend`，无原生窗口时使用页面内 `waitCodexReceipt()`；两条路径数据源不同，再合并收益有限、发送风险高。
- 手机端 `sheets.js`（约 108.7KB）、`history.js`（约 106.5KB）、`overview.js`（约 56.7KB）：3 行重复扫描未发现精确复制，结构重合需单独评估，不顺手改。
- `check.mjs` 的语法步骤在本机沙箱因 `spawn` EPERM 失败，属于环境限制（与 T4 一致），不为通过检查而改项目代码。
- [session-actions.mjs:53](../server/agent/session-actions.mjs#L53) 只允许 Cursor／Devin 的“按会话管理”，属于功能限制，不是三元素列表漏写。
- 手机端 `row`、`current`、`paint` 等同名局部函数分布在不同文件，作用域独立，不构成跨模块重复。

### 9.5 本轮验证与边界

- 只更新本文件；代码未改、未提交、未发布，本地仍为 `6aa4277`，工作区仅有本文件的未提交修改。
- `npm run check`：104 个语法文件被扫描，但语法步骤在本机沙箱全部 EPERM；协议 101 类发送、69 类服务端消息、196 个 page 导出、70 个模块导入通过。
- `node --test scripts/*.test.mjs` 在本机因沙箱拒绝 `spawn` 未执行，不记为通过。
- 本轮未做手机真机验收；重复、生命周期和静默失败项不代表已经发生故障，也不宣称修复。
- 本节已把两轮复查合并为一份清单：18 项未处理（重复 8、生命周期 2、静默与一致性 3、检查与文档 5），另有 6 条明确不作为合并项。后续实施时按编号分批，不一次性改动。
