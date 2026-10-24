# 功能排查结果

检查日期：2026-10-24（北京时间）
应用版本：v219
检查方式：配对 Chrome CDP，手机竖屏 390×844、横屏 844×390；桌面端连接当前 Cursor、Devin、Codex。
本轮按授权只修改了 Codex Question 卡片和会话切换模型入口两处逻辑。

## 结论

1. **Codex 问题卡片下方多出的回答窗口已修复。** 根因是上方 `#qnBar` 已经渲染了请求字段，`renderQuestions()` 又自动选中第一个 `async:` 请求；现在只有用户主动聚焦上方字段或点击“在对话框回答”时才启用底部回答框。配对浏览器回归通过。
2. **竖屏向上翻页的关键状态在配对浏览器中通过。** 手指滑动期间没有发历史请求，松手后只发一次 `scrollChat`；生成中的内容在触摸期间延后渲染，松手后补绘。横屏和三个 Agent 的历史锚点、节点复用、底部跟随也通过。当前受控回归没有复现闪动。
3. **加载页当前固定三个 Agent 的 UI 通过。** 即使检测结果只找到一个窗口，仍显示 Cursor、Devin、Codex 三行；加载页没有 Agent 管理入口。之前的 `n1n2.mjs` 旧断言要求隐藏未安装的 Codex，与当前“恢复固定三个 Agent UI”的要求冲突，已用新的固定三行断言重测并通过。
4. **通知链路的受控检查通过，未发现重复发送逻辑回归。** 配对 Chrome 中 Web Push 注册失败会返回具体原因；队列归属、重复行去重和不同会话隔离通过。没有实体 iPhone 的系统通知送达条件，因此 Safari 后台送达仍不能标记为通过。
5. **Cursor 核心闭环通过。** 连接、新建会话、发送、切换会话、模型/思考强度菜单、项目往返均通过。Devin 连接和新建会话通过，但真实生成受账号 99% 额度限制阻塞。Codex 发送和首个菜单通过；切换会话时模型为空或旧值的入口已在新数据到达前隐藏，配对浏览器回归通过。

## 本轮配对浏览器证据

### Codex 问题卡片

配对 Chrome 竖屏复现结果：

- 上方问题卡片存在 1 个 `[data-field]` 输入框，`#qnBar` 正常显示。
- `renderQuestions()` 返回后，`questionCompose.id` 自动变成 `async:audit`。
- 主输入框占位符变为“回答当前问题…（仅提交文字）”，发送按钮变为“提交回答”。
- 点击“在对话框回答”后仍指向同一个 `async:audit` 请求，说明下方不是第二个请求。

根因位置：

- `app/js/history.js:787-788` 自动选中第一个异步请求。
- `app/js/history.js:804` 渲染上方请求字段。
- `app/js/composer.js:305-310` 根据 `questionCompose` 切换底部输入框。
- `app/js/history.js:743-751` 将底部输入同步回上方字段。

本轮已取消自动选中；只有用户点击“在对话框回答”或主动聚焦上方输入框时，才启用底部回答模式。该修复只涉及 Codex 异步问题卡片的展示状态，不涉及发送协议、普通聊天、审批、Cursor 或 Devin。

### Codex 会话切换模型状态

切换会话期间，`lastChat.model` 为空或仍是旧会话数据时，Codex 模型入口现在保持隐藏；新会话模型数据到达后恢复显示。配对浏览器验证了空值、有效值和 stale 值三种状态，普通发送入口和 Question 卡片的显式回答入口保持可用。

### 历史翻页和竖屏上滑

- `history-inertia.mjs`：Codex、Cursor、Devin × 竖屏/横屏全部通过。
- `history-status.mjs`：空闲加载、错误提示、错误请求 ID 忽略、生成中延后、聊天帧等待全部通过。
- `history-footer.mjs`：底部跟随、流式更新不抢阅读位置、节点复用、前插锚点、触摸延后和松手补绘全部通过。
- `history-latch.mjs`：历史结束状态刷新后清除，切换会话后重置，通过。
- 竖屏触摸补测：手指上滑期间 `scrollChat` 请求数为 0，松手后为 1；生成更新期间 `deferredScrollRender=true`，松手后清除；直接触摸流式更新的同一节点位置保持不变。

证据文件：

- [`history-inertia-results.json`](../_shots/full-audit-20261024/history-inertia-results.json)
- [`history-status-results.json`](../_shots/full-audit-20261024/history-status-results.json)
- [`history-footer-results.json`](../_shots/full-audit-20261024/history-footer-results.json)
- [`history-latch.mjs`](../_shots/full-audit-20261024/history-latch.mjs)

### 加载页和 N1–N4

- 固定三个 Agent 加载页：通过；显示三行且不显示管理入口。
- N3 文件查询、空格边界、光标位置、完整 token 替换、同名文件区分：通过。
- N4 电脑文件添加状态、成功清除、失败保留和同名完整路径删除：通过。
- 原始 `n1n2.mjs` 的失败是测试期望仍要求隐藏未安装 Agent，与当前固定三行 UI 设计不一致；新的固定 UI 回归已通过。

### 通知

`notify-verify.mjs` 的受控结果通过：

- Service Worker 失败原因不再统一显示为“组件没有加载”。
- iPhone 非主屏环境给出明确提示。
- Web Push、Android 原生通知、iOS APNs 分支和队列去重逻辑保持可用。
- 当前没有实体 iPhone、真实 PushManager 送达或 APNs 设备送达样本，不能据此证明 Safari 后台通知已经送达。

### 三个 Agent 核心闭环

- Cursor：连接、新建会话、两次发送、会话切换、历史恢复、模型/思考强度菜单、项目往返通过。
- Devin：连接和新建会话通过；发送阶段被桌面端账号额度 99% 和上游错误阻塞，没有把阻塞误写成产品通过。
- Codex：连接、新建会话、发送、首个模型和思考强度菜单通过；切换第二个会话时发现菜单打开时模型快照短暂为空/旧值不同步，列为待处理项。

验收产生的隔离窗口和临时设备已清理，原有 4 条设备记录保留。

## 待处理项

| 编号 | 问题 | 判断 | 下一步 |
|---|---|---|---|
| Q1 | Codex 问题卡片同时显示上方字段和下方回答框 | 已修复，配对浏览器通过 | 保持观察真实 Question/审批任务 |
| A1 | Devin 真实生成受 99% 额度限制 | 上游账号状态，不是本地协议错误 | 额度恢复或换测试账号后补发送、会话切换和 Devin Fusion |
| A2 | Codex 切换会话后模型菜单短暂空值/旧值 | 已修复，配对浏览器通过 | 真实多会话切换时继续观察，不改轮询或缓存 |
| A3 | Safari 后台通知送达 | 当前环境未覆盖 | 使用实体 iPhone Safari/PWA 做前台、后台、拒绝权限和重新授权验收 |

## 统一检查

- `npm run check`：通过（84 个语法文件、94 个前端发送类型、59 个服务端返回类型、页面 helper、173 个导出 helper、58 个模块导入）。
- `git diff --check`：通过。
- 本轮只修改 `app/js/history.js` 的两处 Codex UI 状态逻辑；工作区原有 `.codegraph/`、`screenshots/`、`server/voice/__pycache__/` 未跟踪产物仍未纳入提交。
