# 聊天滚动与底部吸附重构方案

日期：2026-10-24

## 背景

手机端在 Agent 流式生成、竖屏手指上滑、点击“最新/有新消息”、发送消息和拖动上下轮滑块时，存在滚动位置跳动、底部吸附偶尔失效和历史加载时视口变化的问题。

当前实现同时使用 `chatScrolling`、`chatTouching`、`chatMomentum`、`pinnedBottom`、`readingAnchor`、`deferredScrollRender`、`historyArmed`、`historyTouchPull` 等状态，并由渲染、`ResizeObserver`、发送逻辑、历史加载和上下轮滑块分别写入 `list.scrollTop`。内容高度变化时，多个逻辑可能在同一轮布局中重复修正滚动位置。

本方案先统一滚动控制，再处理具体事件，避免继续增加互相覆盖的条件。

## 参考行为

- Cursor 移动端在向上滚动时加载更早消息，并保持用户正在阅读的内容位置；长会话支持拖动滚动指示器定位。
  - <https://prod.cursor.com/docs/release-notes/mobile>
- 流式聊天的常见粘底规则是：在底部时自动跟随，用户上滑后暂停，用户回到底部或点击最新后恢复；快速连续内容更新应合并处理。
  - <https://github.com/streamlit/streamlit/blob/develop/specs/2025-12-03-container-autoscroll/product-spec.md>
- 历史消息插入时，使用插入前后的 `scrollHeight` 差值补偿 `scrollTop`，保持原可见消息位置。
  - <https://github.com/tajbinkhan/chat-scroll-behavior>
- Codex 公开问题也把高度变化补偿、底部距离比较和滚动模式切换列为跳动风险点，说明这些状态必须集中管理。
  - <https://github.com/openai/codex/issues/17169>

## 目标状态

滚动控制只保留三个互斥状态：

```text
followBottom   底部跟随
freeScroll     用户自由阅读
programmatic   程序定位或上下轮滑块操作
```

### `followBottom`

- 打开会话且当前位于底部时进入。
- 用户点击“最新/有新消息”后进入。
- 用户发送消息后进入。
- Agent 生成内容增加时，消息 DOM 更新后在下一帧定位到底部。
- 只有该状态允许流式内容自动修改 `scrollTop`。

### `freeScroll`

- 用户向上滑动、滚轮阅读历史或拖动原生滚动条离开底部后进入。
- Agent 继续生成时不抢回底部。
- 新内容只更新消息和“有新消息”提示。
- 页面高度变化时，只保持当前阅读锚点。

### `programmatic`

- 点击“最新”。
- 发送消息后的明确定位。
- 拖动上下轮滑块。
- 跳转到指定轮次或消息。

程序定位完成后，根据最终位置切换到 `followBottom` 或 `freeScroll`。

## 统一滚动入口

所有对 `list.scrollTop` 的写入统一进入一个滚动协调函数，例如 `reconcileScroll(reason)`。其他模块只提交意图，不直接修正位置。

协调函数按以下优先级处理：

1. `programmatic` 的明确目标位置。
2. `followBottom` 的最大底部位置。
3. 历史插入的高度差补偿。
4. `freeScroll` 的阅读锚点保持。

每个动画帧最多执行一次协调，避免 `renderChat`、`ResizeObserver` 和底部吸附连续写入滚动位置。

## 流式生成

### 已在底部

```text
收到新内容
→ 更新消息 DOM
→ 下一帧读取新的 scrollHeight
→ 一次性滚到最大底部
→ 更新上下轮滑块位置
```

### 用户正在阅读历史

```text
收到新内容
→ 更新消息 DOM
→ 不修改 scrollTop
→ 保持当前可见消息
→ 显示“有新消息/最新”按钮
```

现有消息缓存、增量渲染和 `content-visibility` 保留，不通过删除渲染优化来解决跳动。

## 历史消息加载

历史加载与普通滚动状态分离，只在用户明确向上阅读并到达顶部阈值时触发。

加载前记录：

```text
oldScrollTop
oldScrollHeight
```

历史内容插入后使用：

```text
newScrollTop = oldScrollTop + newScrollHeight - oldScrollHeight
```

历史请求继续由 `historyRequest` 做单请求锁，避免同一个顶部状态重复请求。加载结束后只执行一次高度差补偿，不再叠加 `touchmove`、惯性计时器和阅读锚点修正。

## 上下轮滑块

上下轮滑块只负责显示滚动进度和提供程序定位，不作为普通滚动的第二个控制器。

```text
pointerdown
→ 进入 programmatic
→ 暂停锚点补偿和历史加载
→ 根据滑块进度设置 scrollTop
pointerup
→ 到底部则进入 followBottom
→ 否则进入 freeScroll
```

生成内容增加时，只重新计算滑块显示位置，不由滑块反向触发页面滚动。

## 发送消息

发送是用户明确操作，因此流程为：

```text
点击发送
→ 进入 programmatic
→ 添加临时消息回显
→ 等消息 DOM 完成渲染
→ 下一帧定位到底部
→ 切换 followBottom
```

发送失败仍沿用现有失败提示和临时消息清理逻辑，不修改发送协议。

## 状态合并方向

保留：

- `historyRequest`
- `historyAtEnd`
- `historyRendering`
- `turnNavPointer`
- 消息缓存和历史记录状态

逐步合并：

- `chatScrolling`、`chatTouching`、`chatMomentum`、`pinnedBottom` → `scrollMode`
- `readingAnchor`、`deferredScrollRender` → `scrollCorrection`
- `historyArmed`、`historyTouchPull` → 顶部阈值与 `historyRequest` 锁
- `restoringChatScroll` → 程序滚动事件标记

历史数据状态不并入滚动状态机，避免会话切换和历史请求互相影响。

## 修改范围

预计只改：

- `app/js/history.js`：滚动状态机、历史加载、锚点补偿和滑块协调。
- `app/js/composer.js`：发送后的底部定位。
- `app/js/chat.js`：统一底部距离判断和“有新消息”状态。

不改：

- 消息协议和 WebSocket。
- Agent 连接、通知、项目与会话列表。
- 消息解析、IndexedDB 历史数据和现有渲染优化。

## 验证范围

修改后需要使用配对浏览器检查：

1. 生成中停留在历史中间位置，页面不跳到底部。
2. 生成中已经在底部，内容持续跟随。
3. 点击“最新/有新消息”后稳定吸附。
4. 发送消息后回到底部。
5. 顶部加载历史后，原来看到的消息位置不变。
6. 拖动上下轮滑块时不触发历史加载。
7. 松开滑块后，到底部可以恢复自动跟随。
8. 竖屏 Safari 惯性滚动、横屏和桌面浏览器分别验证。

最后运行 `npm run check`。
