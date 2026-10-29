# Remote Agent

把手机变成 Cursor / Devin / Codex 的遥控器：本机 relay 通过 CDP 驱动桌面应用。

## 修改规则

- 修改前先给出计划：列明修改哪些文件、每处怎么改、怎么验证；用户确认后再修改。
- 只做已确认的方案；允许在确认范围内重构，不改范围外的功能和逻辑，不改其他 Agent，不动 page 导出快照（`scripts/page-exports.json`），不顺手优化；除非用户明确要求，不加额外保护措施、兜底或兼容逻辑。
- 从功能逻辑、数据归属、请求时序、状态变化找根因；不靠堆条件、隐藏入口、吞事件或延时压症状。
- 真机由用户使用既有配对浏览器验收：复现原场景，并检查受影响功能；未执行的验收不记为通过。
- Ubuntu 回归以本次修改前的当前工作区版本为基准，按实际差异确定受影响功能，只验这些功能。

## 结构

- `server/` — relay（`index.mjs` 入口、`session.mjs` 会话、`page/` 注入脚本、`http/`、`publish/`）
- `lib/` — 认证、通知、文件、主题、高亮、git 标记、平台差异
- `cli/` — `setup.mjs` / `devices.mjs` / `twofa.mjs`
- `app/` — 手机端 PWA
- `android/`、`ios/` — 原生壳。发布：`android/app/build.gradle` 的 `versionCode` +1、`versionName` 改好，`git tag vX.Y.Z` 推送后 `gh release create vX.Y.Z AgentRemote.apk`；资产名必须是 `AgentRemote.apk`、tag 必须等于 versionName 加 `v`（App 内更新靠这两点）。iOS 模拟器用 xcodebuild 构建，上传 TestFlight 用 `scripts/ios-testflight.sh`
- `scripts/` — `check.mjs` 与启动脚本；`push-service/` — APNs 推送服务（见其 README）

## Git

未经用户明确要求，不提交、不推送。

提交信息、tag、PR 不得出现任何 AI 工具署名（不要 "Generated with ..."、不要 Co-Authored-By 机器人）。

## 截图 / 临时产物

测试截图和临时产物一律放 `_shots/`（已 gitignore），不要放进 `android/` 等会提交的目录。

## 检查

适度检查，不要过度。只查修改及受影响的功能；已通过且未受后续改动影响的检查不重复执行。修改完成后必须跑 `npm run check`（语法、消息协议、注入脚本导出快照）；改协议或 page helpers 时，修改前也必须先跑。

## 验证

大改后，由用户按实际受影响范围在手机上逐项验收：

- **每个应用（Cursor / Devin / Codex）**：连接并 attach；发一条消息并正常滚动；切换会话加载历史；模型菜单可见可切；文件引用预览带高亮；终端能看输出、能发命令。
- **Fusion**：完整跑一次选项目、开始 run、双方轮流执行到结束。

最后 `npm run check` 通过。
