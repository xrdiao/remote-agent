# Capacity、PDF 与切换修复记录

日期：2026-10-27。网页版本：v273。

## 本轮范围

按用户确认，只处理 Codex 容量提示／Retry、PDF 双指缩放、旧缓存升级和 Agent／项目／会话切换的提示与回执归属。保留此前工作区修改；未提交或推送 master、debug。未修改 Fusion 专用代码，未进行 Fusion 功能测试。

## 根因与修改

### Capacity 与 Retry

当前原生 Codex 将容量错误保存在轮次元数据 `error.message`，界面以 `system-error` 展示。此前历史转换没有读取该字段，展示只专门处理 `stream-error`；用于绑定当前 Retry 的 DOM 查找又只接受最后一轮，因此历史错误可能完全漏显。

- 从原生轮次元数据恢复容量错误，并处理容量类型的 `system-error`；其他错误保持原展示路径。
- 按真实轮次生成稳定标识，合并 DOM 与历史数据时去重，提示保留在对应轮次。
- 历史正文的恢复不依赖当前活动 Retry 查找。Retry 只取当前原生可用按钮；倒计时和禁用按钮不作为可点击按钮。
- 有容量提示时，Retry 归于该提示，保留回复末尾其他动作。缓存保留历史正文，过期的 Retry 不沿用。
- 只对同一轮提示合并重复来源；不同轮或独立横幅即使错误正文相同，也分别保留。

相关代码：`server/page/chat-extract.js`、`server/apps/codex.mjs`。

### PDF 双指缩放

PDF 原有逐页阅读保留，复用已有媒体预览手势，支持双指缩放、放大后拖动和“适应”。翻页重置缩放；关闭继续结束现有读取／绘制任务。没有新增第二套手势处理。

相关代码：`app/js/files.js`、PDF 专用样式。

### 切换提示与回执

“切换 Agent”曾被发送公共逻辑覆盖为“切换窗口”；会话入口也误用 Agent 提示；共用项目绑定流程后，又会把会话切换报告成打开项目。

现在按本次导航操作记录等待与结束提示，沿用现有导航序号和结果归属检查。项目就绪回执区分显式会话选择，避免共用实现改变用户操作的含义；非聊天模式下也结束已完成导航的等待状态。窗口、项目和会话的原生绑定机制未重写。

相关代码：`app/js/core.js`、`net.js`、`sheets.js`、`notify.js`、`server/agent/projects.mjs`。

### 缓存交付

Service Worker 注册 URL 带当前应用版本，更新检查不沿用 HTTP 缓存；安装应用壳时重新读取资源。同步更新 HTML、脚本、CSS 与 Service Worker 版本。没有清理配对凭据、草稿或历史，也没有增加旧业务协议分支。

## 实际验证

使用原有已配对 Chrome，没有新增配对。正式网页统一回归 14 项，加旧缓存升级 1 项，共 15 项通过：

- Capacity：历史 `system-error` 展示及手动 Retry；无按钮／倒计时／可点击按钮变化、提示自动出现、按钮同行、相同正文的历史提示与独立横幅共存、自动点击和次数限制。
- PDF：实际双指触摸放大至约 2.57 倍、拖动、适应、三页前后翻页、翻页复位及关闭。
- 三 Agent：各自的 Agent 切换、同项目两会话往返、打开项目；另检查 Codex 跨项目往返和快速连续切换，核对实际选择、显示名称、等待结束和提示归属。
- 缓存：复用旧 v266 资源，普通刷新升级到正式 v273；Service Worker 和应用壳版本一致，离线应用壳仍为 v273，联网后 Codex 可进入，配对凭据保留。

另对真实原生 Codex 页面进行了只读提取检查：3 个页面中的 7 条容量提示均能恢复，标识未重复。带 Retry 的交互和倒计时使用独立测试窗口的原生 DOM 夹具验证；不将夹具结果当作上游自然容量恢复或 iOS／Android 真机结果。旧缓存升级验证来自已有 Chrome；没有直接操作用户报告故障的那台手机浏览器。

`npm run check` 与 `git diff --check` 通过。gh-pages 的 264 个应用文件与工作区一致；公网 HTML、主要修改脚本、CSS 和 Service Worker 共 7 项 HTTP 200 且内容一致。中继已按原参数重启，保留 `--tunnel`。

证据：`_shots/capacity-pdf-navigation-20261027/` 内的 `summary.json`、`capacity-browser.json`、`pdf-browser.json`、`navigation-browser.json`、`cache-browser.json`、`natural-capacity.json`、`public-assets.json` 和 `scope-review.json`。截图为 `pdf-pinch.png` 与 `capacity-check.png`。

## 回归中的测试调整

- Cursor、Devin 回归时发现本轮一处空项目名处理会清掉有效项目名，已撤回该改动并恢复原规则。
- Codex 会话列表对外使用项目分组标签；测试改为以独立项目新建入口的精确分组选择会话，未为此更改产品列表逻辑。
- 容量夹具改为挂到真实可见、可编辑的输入区域，避免命中历史消息的只读编辑器。

这些失败记录没有被计作通过；上述结果来自修正后正式 v273 的最终统一回归。
