# 功能检查报告

检查日期：2026-10-24（北京时间）。版本：v217。检查方式：配对 Chrome 浏览器连接本机中继，手机视口 390×844，并对历史滚动补测 844×390；桌面端使用真实 Cursor、Devin、Codex 和 Fusion。排查阶段先不改代码；定位完成后按用户授权修复 Fusion Devin 会话绑定，并重新做配对回归。

旧报告正文已清除，本文件是当前唯一的功能排查结果。历史原始截图、脚本和 JSON 没有删除，仍保留在 `_shots/`，用于区分本轮新发现、环境阻塞和之前已经处理的项目。

## 结论

当前代码不能标记为“全功能无问题”。已确认通过的主路径很多，但仍有三类需要处理或复测的事项：

1. Devin 发送受桌面端账号额度阻塞，当前无法完成真实生成闭环。桌面端明确显示 `You've used 99% of your quota` 和 `Permission denied: internal server error`，这是上游额度/服务阻塞，不应误写成手机发送通过。
2. Codex 切换会话后立即打开模型菜单时，手机快照首个采样的 `model/effort` 会短暂为空；约等待 1 秒后恢复，原生模型和菜单选中项一致。需要单独处理或复测这段状态同步时序。
3. Devin 作为 Fusion 侧的会话绑定已修复并通过配对回归；完整 Devin Fusion 运行仍受 A1 的额度阻塞。

## 本轮环境与清理

- 本地中继：`http://127.0.0.1:3939/`，配对页和三个隔离桌面窗口均通过浏览器 CDP 操作。
- 检查覆盖 Cursor、Devin、Codex 的连接、发送、会话、项目、模型、终端、文件预览、历史和滚动；另外检查通知 Service Worker、N1–N4、Fusion。
- 使用了临时 P-256 浏览器密钥完成真实配对。旧测试夹具曾登记了与浏览器私钥不匹配的公钥，导致“设备授权已失效”；修正夹具后重新检查。该错误属于测试夹具，不是产品结论。
- 本轮临时设备和隔离窗口已清理；`_shots/core-acceptance/cleanup.json` 显示原有设备 4 条记录的 ID、`tokenHash` 均保留，隔离窗口均已关闭。中继保持运行。
- `.codegraph/`、`screenshots/`、`server/voice/__pycache__/` 是工作区原有未跟踪产物，本轮没有纳入提交范围。

## 按应用检查结果

| 功能 | Cursor | Devin | Codex |
|---|---|---|---|
| 配对连接与 attach | 通过 | 通过 | 通过 |
| 新建会话 | 通过 | 通过 | 通过 |
| 发送并收到最终回复 | 通过 | 受阻：桌面端额度 99% / internal server error | 通过 |
| 会话切换与历史恢复 | 通过 | 受阻于发送前置条件；旧会话列表未作完整新回归 | 通过，但切换后模型状态有短暂空值 |
| 模型菜单 | 通过 | 未完成本轮真实生成闭环 | 通过 |
| 思考强度 | Cursor 原生入口无独立选项 | 未完成本轮真实生成闭环 | 通过，low/medium/high/xhigh 选项与原生一致 |
| 终端 I/O | 通过 | 通过 | 通过 |
| 文件预览与高亮 | 通过 | 通过 | 通过 |
| 项目往返 | 通过 | 受发送额度阻塞 | 通过 |

Cursor 核心结果见 [`core-acceptance/cursor.json`](../_shots/core-acceptance/cursor.json)。Codex 发送、菜单和强度结果见 [`core-acceptance/codex.json`](../_shots/core-acceptance/codex.json) 及 [`codex-settle-results.json`](../_shots/full-audit-20261024/codex-settle-results.json)。Devin 的阻塞现场保留在桌面窗口状态和 [`core-acceptance/devin.json`](../_shots/core-acceptance/devin.json)。

## 已通过的配对浏览器检查

### 终端和文件预览

三个应用都在各自隔离项目中执行了终端命令并读回项目路径；结果见 [`terminal-results.json`](../_shots/full-audit-20261024/terminal-results.json)。三个应用都打开 `audit-preview.js`，正文读取成功并生成 16 个语法高亮 token；结果见 [`file-preview-results.json`](../_shots/full-audit-20261024/file-preview-results.json)。

### 历史、翻页和生成中滚动

- 三应用 × 横竖屏：底部跟随、上翻后流式内容不抢阅读位置、历史前插锚点保持、节点复用、触摸期间延后渲染、松手后补绘、回到最新后继续跟随，全部通过。
- 历史请求 ID、生成中暂缓、线程切换隔离、错误提示、完成提示全部通过。
- Devin/Cursor 历史完成结果使用当前原生边界的回归通过；错误的 `earlier:false` 后收到 `earlier:true` 会恢复“加载更早”入口。

证据：[生成滚动](../_shots/full-audit-20261024/history-inertia-results.json)、[历史状态](../_shots/full-audit-20261024/history-status-results.json)、[历史分页](../_shots/full-audit-20261024/history-footer-results.json)、[服务端边界](../_shots/full-audit-20261024/history-server.mjs)、[结束状态锁](../_shots/full-audit-20261024/history-latch.mjs)。

这些是配对 Chrome 的受控滚动结果，不能代替实体 iPhone Safari 的惯性手感、后台恢复和真实网络抖动检查。

### 通知链路

Service Worker 注册结果、版本同步和失败原因保存均通过；合成注册失败保留了 `fixture install denied`，没有再统一显示“通知组件没有加载”。Web Push、Android 原生通知和 iOS APNs 分支的受控检查通过。证据：[Service Worker](../_shots/full-audit-20261024/notify-sw-results.json)、[通知/队列回归](../_shots/full-audit-20261024/notify-verify.json)。

本轮没有实体 iPhone、真实 PushManager 订阅送达或 APNs 设备送达，因此真实通知到达仍是未覆盖项。

### N1–N4

N1/N2 的加载页 Agent 管理入口、会话运行标识、Codex 可见行优先级和 Devin Editor 活动状态通过；N3 的 `@` 文件查询、光标边界、完整 token 替换和同名路径保留通过；N4 的原生电脑文件附件状态、成功清除、失败保留草稿和同名完整路径删除通过。

证据：[N1/N2](../_shots/full-audit-20261024/n1n2.json)、[N3](../_shots/full-audit-20261024/n3.json)、[N4](../_shots/full-audit-20261024/n4.json)。这些检查使用隔离页面和隔离项目，没有发送用户真实文件。

### Fusion

采用两个隔离 Cursor 会话，完成了：选择项目 → 绑定 A/B → 确认配置 → A 生成方案 → 点击执行 → B 创建 `fusion-audit.txt` → A 读取核对 → 完成。文件内容严格为 `AUDIT_FUSION_OK`。阶段为 `planning → plan → execute → review → done`。

证据：[Fusion 配置](../_shots/full-audit-20261024/fusion-cursor-config.json)、[Fusion 运行](../_shots/full-audit-20261024/fusion-continue.json)。

本轮修复了 Devin 侧绑定：Fusion 不再直接把 ACP 会话 ID 当作 Editor 搜索框的 `pick:<index>`，而是复用 Devin adapter 已有的 `openAgent(id, title)`，保留 Editor→Agent 回退和标题匹配。配对回归已成功绑定 Devin 会话，模型为 `SWE-2`，证据见 [`fusion-devin-regression.json`](../_shots/full-audit-20261024/fusion-devin-regression.json)。完整 Devin Fusion 运行仍需等待额度恢复后复测。

### Fusion 专项复查与修复（2026-10-24）

本轮重新创建了隔离的 Cursor A/B 会话，并通过配对 Chrome 的手机视口重新走了一遍 Fusion 入口：

- 项目选择、A/B 会话绑定和现有模型状态读取通过；本轮绑定为 A=`Auto`、B=`Grok 4.7`。
- 历史会话列表、打开已有会话和新建会话通过；打开后项目与 A/B 绑定保持，新建后历史列表保留旧记录。
- A/B 额度刷新和额度说明入口通过；当前 Cursor 账号显示 Cursor Models 剩余 9%、Other Models 剩余 8%，属于账号额度状态，不是 Fusion 解析错误。
- 短任务进入 `planning` 后立即停止通过，最终回到 `phase=idle`、`busy=false`，状态为“已停止”。没有让测试任务继续修改隔离项目。
- 修复前 A/B 模型菜单均失败：打开 `fusion-model-a` 或 `fusion-model-b` 后，配对页面返回 `items=[]`，页面只显示“Loading models…”。每侧等待 12 次（每次 150ms）仍未出现模型项；绑定状态和额度数据同时正常，因此问题位于 Fusion 模型菜单读取，而不是会话绑定或额度读取。

证据：[修复前模型菜单](../_shots/full-audit-20261024/fusion-menu-results.json)、[历史会话](../_shots/full-audit-20261024/fusion-history-results.json)、[额度](../_shots/full-audit-20261024/fusion-usage-results.json)、[停止](../_shots/full-audit-20261024/fusion-stop-results.json)。

定位结果：`server/fusion/owner.mjs:595-607` 的 `fusionModelMenu()` 只读取 `menuItems('model')`，失败时只调用 `clickModelListTrigger()`；Cursor 的 Model 子菜单带 `aria-haspopup="menu"`，该调用会返回 false，必须继续用 `modelListTrigger()` 的坐标点击。`server/fusion/agent.mjs:26-45` 的模型选择路径也缺少同一坐标回退。

修复后只在这两条 Fusion 路径补入通用模型菜单已有的快速读取、子菜单坐标回退和空列表错误处理，没有改通用 Agent 菜单、模型数据、额度、历史或运行状态。配对浏览器复查通过：A/B 菜单均返回 10 个真实模型并标记当前项；A 从 Grok 4.7 切换到 Grok 4.6 成功；完整流程阶段为 `planning → plan → execute → review → done`，隔离文件 `FUSION_MODEL_FIX_OK` 校验通过。

修复证据：[B 侧模型菜单](../_shots/full-audit-20261024/fusion-model-b-results.json)、[A 侧模型切换](../_shots/full-audit-20261024/fusion-model-pick-results.json)、[完整流程](../_shots/full-audit-20261024/fusion-full-after-fix.json)。

### 额度限制处理（2026-10-24）

本轮只处理账号额度影响：普通 Agent 发送流程保持不变，额度类失败统一提示“账号额度或频率限制”，并指引等待重置、升级套餐或切换账号。Fusion 开始前刷新 A/B 额度，仅在原生数据明确显示 0% 或已耗尽时阻止；99% 已用仍允许尝试，避免误拦仍可用的额度窗口。

配对浏览器只读验证中，Cursor 连接和额度展示通过（当前剩余 9%/8%），Devin 连接和额度展示通过（当前每周剩余 1%）。Codex 的额度状态分类使用真实返回形状做了独立单测；隔离 Codex 窗口未打开聊天侧栏，没有把该环境状态误写成额度失败。额度状态分类、错误提示和 Fusion 0%/1% 前置行为单测通过。

证据：[配对额度读取](../_shots/full-audit-20261024/quota-browser-results.json)。账号额度本身仍由各 Agent 服务端控制，Devin 的真实生成需等额度恢复后复测。

## 待处理和待复测问题

| 编号 | 问题 | 当前判断 | 下一步 |
|---|---|---|---|
| A1 | Devin 发送返回额度 99% 和 internal server error | 环境/上游阻塞仍存在；本地已补额度提示和 Fusion 耗尽前置检查 | 额度恢复或换已授权测试账号后，重新做发送、会话切换、模型菜单和 Fusion Devin 侧闭环 |
| A2 | Codex 切换会话后首个模型快照短暂为空 | 可复现的状态同步时序问题；约 1 秒后恢复 | 先定位 `projectReady/chat` 与 `lastChat` 更新顺序，确认是否会影响手机标题、菜单和发送按钮；未经确认不改轮询或缓存 |
| A3 | Devin 作为 Fusion 侧选择时报“没有找到选中的会话” | 已修复；配对浏览器绑定成功 | 已复用 Devin adapter 的 `openAgent(id, title)`，保留既有 Editor→Agent 回退；额度恢复后补完整 Devin Fusion 运行 |
| A7 | Fusion A/B 模型菜单返回空列表并显示“Loading models…” | 已修复；配对浏览器确认 A/B 菜单、模型切换和完整流程通过 | `fusionModelMenu()` 与 `fusionPickNativeModel()` 已补通用坐标回退；不再改动 |
| A4 | Codex 多条真实排队、Devin 真实取出/删除、真实 Question 卡片 | 本轮没有满足真实前置条件；受控读取通过 | 在有真实队列/Question 的测试会话中做一次真实点击闭环，不用合成卡片替代 |
| A5 | 真实 iPhone Safari 的惯性滚动、通知送达、麦克风、后台恢复 | 配对 Chrome 无法覆盖 | 用实际手机逐项验收；不因本轮 Chrome 结果擅自调整代码 |
| A6 | 跨平台、远端 SSH 文件/终端、设备撤销/TOTP、归档/Undo/Fork/设置写入 | 未覆盖 | 需要独立测试窗口和明确副作用范围后再查 |

A1 是当前环境限制；A2 是本轮仍需处理的产品链路问题；A3 和 A7 已修复，但完整 Devin 运行仍受 A1 阻塞。A4–A6 属于待复测或未覆盖，不应直接当作已确认缺陷。

## 检查夹具和误报说明

- 旧核心夹具使用了已失效的无公钥 `addDevice()`；当前认证接口要求浏览器真实 P-256 公钥。修正夹具后重新配对，未把夹具错误写入产品问题。
- 旧夹具把 `3941` 写死；本轮中继实际运行在 `3939`。所有本轮配对检查都改用当前本地中继，不修改产品端口配置。
- Fusion 旧脚本把包含 JSON 数组的 `data-fusion-id` 直接拼进 CSS 选择器，造成脚本语法错误；本轮用 DOM `dataset` 精确匹配后重做了 Fusion 检查。
- Cursor 终端旧断言仍寻找旧测试目录名；实际终端命令和路径已通过新的当前项目断言复核。

## 统一检查

`npm run check` 通过：84 个语法文件、94 个发送类型、59 个返回类型、页面 helper 编译、173 个导出 helper、58 个模块导入检查全部通过。`git diff --check` 通过。

本轮仅修改 `server/fusion/owner.mjs` 和 `server/fusion/agent.mjs` 的 Fusion 模型菜单回退；没有修改其他产品代码、没有发布手机资源、没有提交 Git。`npm run check` 与 `git diff --check` 通过，隔离配对窗口已清理，原有设备保留。
