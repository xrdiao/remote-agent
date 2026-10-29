# 仓库问题清单

> 扫描版本：`master` @ `89e979f`（网页 v306），2026-10-29。
> 范围：全仓（`server/`、`lib/`、`app/`、`cli/`、`scripts/`、`android/`、`ios/`、`push-service/`、`docs/`），重点在源码与配置；排除 `node_modules`、`pdfjs`、`vendor`、`katex`、`markdown-it` 等第三方文件。
> 本文只记录问题、机制与证据，不含修复方案。每条都标注来源与验证状态；未测试、未复现的条目只说明代码事实与可能影响，不当作已发生的缺陷。

## 来源与验证口径

- **来源**
  - `实测`：本机运行命令得到的结果。
  - `静态阅读`：只读代码，未运行应用。
  - `仓库检索`：目录、文件、引用计数等可复查的事实。
- **验证**
  - `已验证`：本机可重复观察到结果。
  - `已确认`：代码或仓库事实，无需运行即可核对。
  - `未测试`：没有 fixture，也没有运行对应应用，行为影响未观察。
  - `未确认`：连代码层面的结论也不完整。

## 摘要

没有发现会导致直接崩溃的缺陷。问题分四类：同一语义多实现、运行时多重判断、运行路径与状态、检查与测试缺口；另有未覆盖范围说明。

| 指标 | 数量 | 来源 |
|---|---|---|
| app 条件判断（`app ===` / `app !==` / 按 app 的三元） | 294 处 | 仓库检索 |
| `switchingThread` 引用 | 33 处，分布 7 个文件 | 仓库检索 |
| 手写 `setTimeout` 轮询 | 109 处（`this.waitFor()` 只有 29 次） | 仓库检索 |
| `pollChat` 延时刷新 | 21 处 | 仓库检索 |
| `server/page/chat-extract.js` | 1108 行 | 仓库检索 |
| 行为测试 | 0 | 仓库检索 |

验证总览（共 17 条）：

| 范围 | 条目 | 来源 | 验证 |
|---|---|---|---|
| 可重复观察 | T3 | 实测 | 已验证 |
| 已执行但有环境限制 | T4 | 实测 | 已验证（仅本机沙箱环境） |
| 代码事实已核对、行为影响未测试 | D1–D6、M1–M3、R1–R3、T1–T2 | 静态阅读 / 仓库检索 | 已确认（影响部分未测试） |
| 结论不完整 | R4 | 静态阅读 | 未确认 |

## 1. 同一语义多实现

### D1 会话缓存清理有 4 处，字段集合各不相同

- 来源：静态阅读。
- 验证：四处位置与字段差异已核对（代码事实）；未运行应用，未观察残留内容串会话的症状。
- 位置：[context.mjs:120](../server/agent/context.mjs#L120) `resetCaches`、[context.mjs:146](../server/agent/context.mjs#L146) `clearViewState`、[session.mjs:324](../server/session.mjs#L324) attach、[codex.mjs:282](../server/apps/codex.mjs#L282) 切换 thread。
- 机制：四处各自对一组 Map/Set 重新赋值。`resetCaches` 清 11 项；`clearViewState` 清其中 6 项（`itemCache` 只在 Fusion 时清）并额外清 `latestThink`、`thinkTries`；`session.attach` 清 11 项，但 `itemCache` 绑定的是窗口共享对象；`codex.mergeCodexItems` 只清 7 项，不含 `tasksTried`、`devinHist`、`devinCmds`、`devinCmdTried`、`thoughtFails`。
- 可能影响：新增缓存时只改其中一处，其他路径保留旧值；切换会话或重连后，上一轮的思考内容、历史条目可能残留到新会话。
- 证据：四处字段对照，差异集中在 `itemCache` 与 devin 系缓存。

### D2 `itemCache` 有两个主人

- 来源：静态阅读。
- 验证：三处赋值已核对；未测试脱钩后的实际表现。
- 位置：[native-windows.mjs:69](../server/native-windows.mjs#L69) 在窗口对象上创建、[session.mjs:311](../server/session.mjs#L311) 绑到会话、[context.mjs:129](../server/agent/context.mjs#L129) `resetCaches()` 用 `new Map()` 替换。
- 机制：窗口级共享缓存与 `AgentContext` 上的字段同时存在。`resetCaches()` 一旦在绑定之后执行，会话持有的就是新的 Map，与窗口共享的那份脱钩。
- 可能影响：[codex.mjs:349-373](../server/apps/codex.mjs#L349-L373) 的合并、裁剪会写进脱钩后的缓存，窗口侧和其他会话看不到。
- 证据：`session.attach` 先调 `clearViewState()`，随后又逐项重建缓存。

### D3 会话切换守卫散落 33 处

- 来源：仓库检索 + 静态阅读。
- 验证：引用位置与数量已核对；未测试漏恢复时 `switchingThread` 长期为真的后果。
- 位置：`projects.mjs` 11、`devin.mjs` 9、`codex.mjs` 6、`cursor.mjs` 3，另有 `session.mjs`、`chat.mjs`、`context.mjs`、`fusion/owner.mjs` 各 1。
- 机制：同一套 `const switching = this.switchingThread; this.switchingThread = true; try { … } finally { if (switching) this.switchingThread = switching; else await this.resumeProjectSwitch(previousCdp); }` 模板复制到各处，恢复动作依赖调用方是否传入 `previousCdp`。
- 可能影响：多入口都能触发切换，谁先谁后取决于调用链；某一层漏恢复时，聊天轮询、草稿同步、发送会被静默跳过（[chat.mjs:166](../server/agent/chat.mjs#L166) 直接 return）。
- 证据：模板在 `projects.mjs` 出现两次，`codex.mjs` 一次，`devin.mjs` 的 `openAgent` 另有一套。

### D4 发送回执有两套实现，判定规则不同

- 来源：静态阅读。
- 验证：两处实现与比较规则已核对；未在真实发送中对比两套路径的结论。
- 位置：[chat.mjs:621](../server/agent/chat.mjs#L621) `submitPromptKey`、[codex.mjs:174](../server/apps/codex.mjs#L174) `submitPrompt`。
- 机制：两处都做 5 秒、125ms 间隔的轮询，但比较规则不同。通用路径把文本做空白归一化后比较；Codex 路径用 `trim()` 精确比较，并额外处理本地文件和草稿附件。`queued` 先在 [chat.mjs:624-625](../server/agent/chat.mjs#L624-L625) 由 `busy`/`when` 算出，又在 [codex.mjs:192](../server/apps/codex.mjs#L192) 按 `view.follow` 重算。
- 可能影响：同一句话在两条路径上的“是否已发出、是否进入队列”可能得出不同结论；回执 `pending` 的处理分叉。
- 证据：两处都写 `receipt.pending = true`，但比较字段、附件分支和 `queued` 来源不同。

### D5 文件面板开关有三套

- 来源：静态阅读。
- 验证：三处实现已核对；未测试三个应用的面板开关失败分支。
- 位置：[cursor.mjs:220](../server/apps/cursor.mjs#L220) `withCursorFiles` 实现、[codex.mjs:147](../server/apps/codex.mjs#L147) 委托回 Cursor、[devin.mjs:163](../server/apps/devin.mjs#L163) 自实现。
- 机制：打开/关闭面板的兜底各写一遍：Cursor 用 `fileTarget(0, "", "toggle")`，Devin 走自己的 `filesToggle`，Codex 实际执行的是 Cursor 的版本。
- 可能影响：三个应用的“找不到按钮”“面板未打开”“关闭失败”分支不同，改一处不会同步到另外两处。

### D6 机械重复

- 来源：仓库检索。
- 验证：数量已核对；未测试替换后的一致性。
- 内容：刷新定时器 21 处 `setTimeout(() => this.pollChat()…, 300|400|500)`；手写轮询 109 处 `new Promise(r => setTimeout(r, …))`，封装好的 `this.waitFor()` 只有 29 次调用；页面脚本里 `r.x + r.width / 2` 手算约 10 处（`common.js` 已有 `point(el)`）；`aria-label || innerText` 取名 9 处变体。
- 可能影响：轮询间隔、超时、错误处理各自演进，改一次语义容易漏。

## 2. 运行时多重判断

### M1 适配器方法自证 app

- 来源：静态阅读。
- 验证：`Object.assign` 与守卫数量已核对；未测试调错 app 时的实际表现。
- 位置：[apps/index.mjs:28](../server/apps/index.mjs#L28) 把所有 adapter 的 `methods` 用 `Object.assign` 挂到同一个 `AgentContext.prototype`。
- 机制：类型上无法保证“这个方法只在对应 app 调用”，因此每个方法开头都要判断：`codex.mjs` 6 处、`devin.mjs` 6 处 `app !== …` 守卫。
- 可能影响：调错 app 时多数守卫是静默 `return`，不抛错，调用方拿不到失败信号。

### M2 页面端靠 DOM 嗅探当前 app

- 来源：静态阅读。
- 验证：嗅探点已核对；未测试页面残留导致误判的场景。
- 位置：[chat-extract.js](../server/page/chat-extract.js) 约 28 处、[devin.js:271](../server/page/devin.js#L271)、[agents.js:68](../server/page/agents.js#L68)、[controls.js:164](../server/page/controls.js#L164)。
- 机制：`PAGE_SRC` 不分 app 注入，所有 helper 在一个闭包里，只能靠 `codexThread()`、`devinSurface()` 的返回值反推当前 app。
- 可能影响：多个页面的 DOM 同时存在或残留时判断会互相污染；`devin.js` 的 `isBusy` 里混入 `codexThread()` 条件就是这种耦合的结果。

### M3 分支分布

- 来源：仓库检索。
- 验证：计数已核对；未评估各分支的触发频率。
- 分布：`projects.mjs` 46、`fusion/owner.mjs` 40、`chat.mjs` 30、`session.mjs` 21、`agent/menus.mjs` 18、`routes.mjs` 16、`lib/files.mjs` 11、`page/compatibility.js` 9。
- 说明：分支集中在“会话/项目/窗口”和“发送/回执”两条主链路上。

## 3. 运行路径与状态

### R1 读取有两条路

- 来源：静态阅读。
- 验证：两条分支已核对；未对比两条路对同一页面的输出。
- 位置：[chat.mjs:210-212](../server/agent/chat.mjs#L210-L212)。
- 机制：有窗口快照时用 `source.read()`，否则直接 `cdp.evaluate(extract(...))`；`known`（已完整轮次的 id 列表）只传给兜底路径。
- 可能影响：两条路输入不同，输出可能不同；虚拟列表补齐行为与兜底路径不一致。

### R2 并发控制并存三套

- 来源：静态阅读。
- 验证：三套机制与使用位置已核对；未测试它们之间的优先级。
- 内容：`operations` 的 operationId 去重 10 处、`switchingThread` 33 处、窗口租约 `leaseWindow`（`server/window-use.mjs`）。
- 可能影响：三者覆盖范围不同（请求去重、导航重入、窗口占用），一次操作可能只被其中一套保护。

### R3 Codex 读取依赖 React 内部

- 来源：静态阅读。
- 验证：依赖字段已核对；未在 Codex 升级后观察断裂方式。
- 位置：`chat-extract.js`、`codex.js`。
- 机制：通过 `codexFiberProps` 读取 fiber 上的 `handleSubmit`、`isQueueingEnabled`、`turnHistory.history`、`entitiesByKey` 等字段，直接调用内部方法完成提交、排队、请求卡片读取。
- 可能影响：对 React 内部结构和 Codex 组件实现变化敏感；这类逻辑在页面快照里无法复现。

### R4 窗口级重试与 Codex 额度逻辑并存

- 来源：静态阅读。
- 验证：未确认。代码里没有写明职责边界，也没有运行验证。
- 位置：[native-windows.mjs:244](../server/native-windows.mjs#L244) `retryCapacity`。
- 现状：窗口级重试设置和 Codex 侧额度读取同时存在，是否重复触发未确认。

## 4. 检查与测试

### T1 `check.mjs` 只做静态检查

- 来源：静态阅读。
- 验证：已确认（检查项内容可直接核对）。
- 覆盖：`node --check`、前后端消息类型是否都有处理、注入脚本导出名快照、缺失 import。
- 不覆盖：任何运行时行为、选择器、提取结果、时序。

### T2 没有行为测试

- 来源：仓库检索。
- 验证：已确认。
- 内容：`chat-extract.js` 1108 行没有 fixture 或回放测试；仓库内无 `*.test.*`、`*.spec.*` 或 `fixtures` 目录。

### T3 `.runtime/` 让协议检查报假阳性

- 来源：本机命令输出 + 代码检索。
- 验证：已验证（可重复）。
- 现象：运行 `node scripts/check.mjs` 报 `server emits but frontend never handles: openAgent, visible, mode`。
- 机制：[check.mjs:23](../scripts/check.mjs#L23) 的 `SKIP_DIRS` 不含 `.runtime`，而根目录 `.runtime/` 下有历史诊断脚本（`live-cursor-open.mjs`、`caret-probe.mjs`、`focus-emu-check.mjs` 等）在发送这三个类型。
- 影响：检查器长期处于失败状态，真实失败和这批噪声混在一起。

### T4 本机检查受沙箱限制

- 来源：本机命令输出。
- 验证：已验证，但只代表本机沙箱环境。
- 内容：`check.mjs` 用 `spawnSync(process.execPath, ['--check', file])` 调语法检查，在本机沙箱被拒（EPERM），语法步骤未完整执行；其余步骤通过：协议 102 个类型、page 导出 196 个 helper、import 65 个模块。

## 5. 未覆盖范围

本文的 17 条来自对 `server/`、`lib/`、`app/js/` 的定向阅读和仓库检索，不是逐行通读。2026-10-29 曾尝试并发逐文件扫描，全部子任务中途失败，没有产出可用结果，因此以下内容仍未覆盖：

- 逐行阅读：`server/apps/`、`server/page/`、`server/` 根目录、`lib/`、`cli/`、手机端大部分文件只读过与问题相关的片段。
- 性能：没有任何测量数据；`structuredClone`、700ms 轮询、大文件尾读、fiber 扫描的实际开销未知。
- Fusion：[owner.mjs](../server/fusion/owner.mjs) 按用户要求跳过，未阅读。
- 跨平台：只在本机 Windows 环境检查，Ubuntu 未实机验证。
- 运行验证：除 T3、T4 外，没有在运行中的应用或真机上复现。

因此本文是代码层面的问题集合，不代表已经发生的故障；未覆盖区域不能据此认为没有问题。

## 6. 统计口径与限制

- app 条件判断使用正则 `app === '`、`app !== '`、`'codex' ?`、`'devin' ?`，统计 `server/`、`lib/`、`app/js/` 下的自有文件；包含三元与守卫，不区分是否处于注释。
- 手写轮询统计 `new Promise(r => setTimeout(r,`；刷新定时器统计 `setTimeout(() => this.pollChat()…`。
- `switchingThread` 统计字符串出现次数，包含读写与传参。
- 除 T3、T4 外，本文其余条目均未在运行中的应用上复现；“可能影响”是根据代码路径推断的，不表示已经发生。
- 未执行：`npm run check` 完整通过（沙箱限制）、真机六项、Fusion 全流程、Ubuntu 实机。
- 本文是某一提交时点的静态盘点，代码变动后需重新扫描；不作为发布或验收结论。
