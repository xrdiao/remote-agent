# 10 概览（Android 原生）

[功能基准索引](README.md) · 首次建档：2026-10-27 · 分支 `OverviewUI`

## 功能与范围

Android App 的启动页：按电脑、项目（窗口）、会话三级用方块卡片展示各 Agent 会话的状态、等待中的问题与任务进度；在卡片内原地展开处理 Devin 的问题／回复／接受改动；“完整对话 →”进入现有 WebView 客户端并定位到该会话。现有网页客户端、通知、配对和各 Agent 适配器的行为不因概览改变。

## 入口与凭据

1. 启动图标进入 `OverviewActivity`；首次运行没有任何概览凭据时直接打开 `MainActivity`（原网页流程），概览留在下层显示空状态。
2. 网页客户端每次连接成功后调用 `AgentRemoteApp.setOverview(config)`，交给原生与通知开关相同的入口凭据 `{app,key,token,id}`；按电脑 id 存在 `agent-remote` 偏好的 `overview:*` 键，不依赖是否开启通知。
3. 请求用该入口令牌加 `EntryAuth` 签名证明（与 `/api/events`、`/api/act` 相同）。401 只标记“需重新连接”，不删除凭据；长按电脑卡片可从概览移除（只删 `overview:*`）。
4. 启动时照旧调用 `NotifyService.start`；通知点击、`agentremote://pair` 仍由 `MainActivity`（singleTask）处理。

## 数据

- `GET /api/overview` 返回通知 watcher 最近一次探测到的每个线程：`win/windowId/threadId`（与通知事件同一身份）、`app`、`project`、`title`、`busy`、`waiting`、`waitingText`、`last`、`startedAt`、`tasks`、`actions`、`devin`、`changed`，以及中继时钟 `now`。
- 请求概览会让 watcher 在随后 60 秒内保持轮询（与打开事件流同等）；`ready:false` 表示刚唤醒、尚未完成一轮探测；`available:false` 表示本实例未持有 watcher 锁。
- 只包含各窗口当前上报的线程；“已完成”由手机在本次运行中观察到 busy→空闲得出，不是中继历史。

## 交互约定

| 场景 | 行为约定 |
|---|---|
| 层级 | 电脑 → 项目（每个窗口一张）→ 会话；底栏切层，面包屑及返回键逐级向上；同名项目按窗口身份分开 |
| 排序与尺寸 | 等你处理（双格、琥珀边）→ 进行中（方块）→ 已完成（紧凑）→ 空闲（默认折叠） |
| 原地展开 | 只有当前窗口激活的 Devin 线程（`devin:true`）显示选项、回复、接受改动；请求带原 `waiting` 作为 `question`，进行中禁止重复提交；其余 Agent 显示“请在完整对话中回复” |
| 完整对话 | 以 `win/computer/windowId/threadId` 启动 `MainActivity`，沿用通知点击的 `saveOpen`／`openWin` 定位路径；不显示 Agent 连接检查页（见 08） |
| 返回概览 | 网页客户端不加按钮：点开边缘的原生刷新浮球时旁边出现“概览”小球（仅已有概览凭据时），点击结束 `MainActivity` 回到概览；冷启动于通知时新开概览 |
| 轮询 | 前台每 4 秒、每台电脑最多一个请求；后台停止；离线／未授权／不可用如实显示，不保留旧会话冒充在线 |

## 主要实现入口

- [OverviewActivity.java](../../android/app/src/main/java/com/agentremote/OverviewActivity.java)、[OverviewGrid.java](../../android/app/src/main/java/com/agentremote/OverviewGrid.java)、[OverviewClient.java](../../android/app/src/main/java/com/agentremote/OverviewClient.java)、[OverviewStore.java](../../android/app/src/main/java/com/agentremote/OverviewStore.java)、[AndroidManifest.xml](../../android/app/src/main/AndroidManifest.xml)
- [notify.mjs](../../lib/notify.mjs)（`overviewSnapshot`）、[api.mjs](../../server/http/api.mjs)（`/api/overview`、`/api/act`）、[net.js](../../app/js/net.js)（`setOverview`）

## 回归场景

| 操作 | 观察结果 |
|---|---|
| 首次安装／未配对打开 App | 直接进入原网页流程；返回后概览出现刚连接的电脑 |
| 多台电脑、其中一台离线或被移除 | 各自状态真实，移除只影响概览 |
| Devin 提问 → 卡片选项／回复；电脑端已先回答 | 成功只提交一次；过期问题返回中继错误提示 |
| Cursor／Codex 等待确认 | 只显示问题与“完整对话”，不提供原生提交 |
| 点“完整对话”（App 已开／冷启动／跨电脑） | 网页客户端打开该会话；返回键回到概览 |
| 竖横屏、展开状态下轮询 | 布局 2／4 列，输入内容不丢失，卡片不闪烁 |

## 验证记录

2026-10-27：`npm run check` 通过；隔离脚本以假窗口驱动 watcher 验证 `overviewSnapshot` 字段与身份；`gradlew assembleDebug` 编译通过。尚无模拟器／真机，上述交互场景均未运行验证。
