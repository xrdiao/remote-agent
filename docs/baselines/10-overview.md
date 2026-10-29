# 10 概览

[功能基准索引](README.md) · 首次建档：2026-10-29 · 网页 `v316`

## 功能与范围

网页客户端（浏览器、PWA、Android／iOS 壳）的最上层界面：按电脑 → 项目 → 会话三级用方块卡片展示各 Agent 会话的真实状态，在卡片内原地处理当前 Devin 会话的问题／回复／接受改动；会话的下一层就是现有对话界面（聊天、终端、画面），不再有单独的“完整界面”概念。只展示中继实际读到的数据；读不到的内容不显示，不用占位或推测补齐。

## 层级与导航

| 场景 | 行为约定 |
|---|---|
| 启动 | 默认显示概览「会话」层、全部电脑；配对、二次验证、连接检查页照常覆盖在概览之上 |
| 层级 | 电脑 → 项目（每个窗口一个；Codex 每个 VS Code 窗口一个；每台在线电脑另有一个 Fusion 项目）→ 会话 → 对话；同名项目按窗口身份分开 |
| 切层 | 竖屏底栏、横屏左侧栏切换层级；面包屑与左上返回逐级向上；点电脑／项目卡片下钻 |
| 进入对话 | 卡片「打开对话 →」、空项目「打开项目」、无运行记录的 Fusion 项目卡片；同电脑走 `openWin`，跨电脑先记录目标再 `useComputer`，通知点击同样进入对话 |
| 返回概览 | 对话标题栏最左侧返回按钮、Android 返回键、iOS 侧滑；回到该对话当前电脑与项目的会话层；文件查看器的返回只关闭查看器 |
| 主菜单 | 各层都可打开；概览层隐藏只属于当前对话的「模型」分组，其余项不变 |
| 对话内切换 | 标题栏会话列表、侧栏、电脑列表仍按原规则在对话内切换 |

## 数据

- `GET /api/overview`（设备认证与二次验证之后）返回中继原生窗口快照：`windows[]`（`win/windowId/app/project`）、`sessions[]`（`win/windowId/threadId` 与通知同一身份，`app/project/title/busy/waiting/waitingText/last/startedAt/tasks/actions/devin/changed/lastUsed/changes`）、本设备 Fusion 运行 `fusion[]`（进行中、待确认或 24 小时内更新，最多 8 个），以及 `os/now/ready`。不改变通知 watcher、适配器和 WebSocket 协议。
- 手机前台每 4 秒、每台电脑最多一个请求；后台停止。只轮询本入口来源的电脑；其他入口的电脑显示「在其入口中打开」。
- 状态：等你处理（真实 waiting）→ 进行中（busy）→ 已停止（仅 Fusion 达到轮数上限）→ 空闲 → 已完成。「已完成」是本页观察到的 busy→空闲，保存到当天结束；Fusion 按阶段判定。
- 离线保留最后数据并以离线标示；401 显示需要重新连接；中继缺少接口（404）显示需要更新电脑端。时间只用中继给出的开始时间或本页首次看到运行的时间，没有就不显示。
- 排序：同组（等你/停止/进行中 | 已结束）内按最近活动倒序，取开始、完成与 `lastUsed`（Cursor 会话 `lastUpdatedAt`/`createdAt`、Devin `latest_message_event_at`、Codex 最近会话 `updatedAt`）中最大者；项目与待处理通道同样按最近活动。
- 文件改动：只有窗口当前会话有 `changes:{count,add,del}`，读不到的项为 null 不显示（Cursor 只有 +/− 总数；Codex 运行中不读）。卡片元信息显示「N 个文件 +a −d」。
- 卡片过渡：每张卡片有唯一 `view-transition-name`；用户操作总是过渡，轮询只在卡片顺序/状态/展开变化时过渡，纯文字变化不过渡。

## 原地处理

只有窗口当前激活的 Devin 会话（`devin:true`；接受改动仅当 Devin 改动栏实际有「Accept all」时，`acceptAll:true`，当前 Devin 版本只有 Quick review，因此不显示）提供选项、回复和完成后的接受改动，经 `/api/act` 提交并附带原问题；其余 Agent 及 Fusion 只显示问题并引导进入对话。提交中禁用重复操作，失败显示中继返回的错误。

## 与其他功能的关系

- 概览层显示时向中继报告未在观看对话（`visible` 与心跳均为 false），该会话通知不再被抑制，聊天实时读取暂停；回到对话恢复。见 [05](05-notifications-background.md)。
- 会话内容的读取、发送、模型和原生操作仍按 01–04、06、07 的对话层基准。

## 主要实现入口

- [overview.mjs](../../server/overview.mjs)、[api.mjs](../../server/http/api.mjs)（`/api/overview`、`/api/act`）、[notify.mjs](../../lib/notify.mjs)（`windowName`）
- [overview.js](../../app/js/overview.js)、[index.html](../../app/index.html)（`#overview`、`#ovBack`）、[app.css](../../app/app.css)（`#overview` 段）、[notify.js](../../app/js/notify.js)（`rememberNotice` 进入对话）、[net.js](../../app/js/net.js)（`conversationVisible` 可见性）、[sheets.js](../../app/js/sheets.js)（主菜单分组）、[i18n.js](../../app/i18n.js)

## 回归场景

| 操作 | 观察结果 |
|---|---|
| 启动、配对后、二次验证 | 概览为首屏，覆盖层照常出现 |
| 多台电脑，其中离线／令牌失效／中继旧版本 | 各自状态真实，不冒充在线 |
| Devin 提问 → 卡片选项／回复；电脑端已先回答 | 成功只提交一次；过期问题显示中继错误 |
| Cursor／Codex 等待确认、Fusion 待确认 | 只显示问题与「打开对话」 |
| 打开对话（同电脑／跨电脑／通知点击／冷启动） | 打开该会话；返回到对应会话层 |
| 概览与对话之间切换时的通知 | 概览层不抑制通知，回到对话恢复原规则 |
| 竖横屏、深浅主题、英文、输入中轮询 | 布局可用，用户文字不翻译，输入内容和输入法组字不丢失 |

## 验证记录

2026-10-29（`v308`，Windows）：`npm run check` 通过；只读脚本对本机 Cursor／Devin 读取快照，身份与字段正确；独立数据目录的中继（3940）＋无头 Edge 验证首屏、各层竖横屏／深浅／英文、打开对话与返回、`openWin` 进入对话、可见性帧、401 卡片、`/api/act` 错误路径；页内合成数据验证提醒、完成标记、Fusion 停止、Devin 选项卡片、任务进度、404 卡片；英文模式除用户内容外无中文，既有文案英文翻译 1009 条与改动前一致。未运行：真机 Android／iOS、真实 Devin 提问与提交、Fusion 实际流程、文件查看器返回、跨电脑实际切换、401 后重新解析地址。证据在 `_shots/ov-*`、`_shots/ov2-*`。

2026-10-29（合并上游 `f15d289` 后，`v313`）：`npm run check` 与 `node --test scripts/computer-switch.test.mjs`（24/24）通过；跨电脑打开改用上游 `resumableComputerSocket`。合并后未重跑浏览器端到端检查。

2026-10-29（`v314`）：`npm run check` 通过；只读探测本机 Cursor（`lastUpdatedAt` 为毫秒，`changes` 读到 +/− 总数）、Devin（`changes` 含文件数与总数）；独立中继＋无头 Edge 验证卡片名唯一、展开过渡、轮询仅布局变化时过渡、空闲按最近活动排序、Cursor 卡片无接受按钮而 Devin 有。未验证：Codex `updatedAt` 单位与改动读取（无 Codex 窗口）、Devin 折叠改动栏解析、英文卡片「files」显示。证据 `_shots/ov3-*`。
