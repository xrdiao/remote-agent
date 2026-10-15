# Remote Agent

把手机变成 Cursor / Devin / Codex 的遥控器：本机 relay 通过 CDP 驱动桌面应用。

## 结构

- `server/` — relay 本体（`index.mjs` 入口，`session.mjs` 会话，`page/` 注入脚本，`http/`、`publish/`）
- `lib/` — 认证、通知、文件、主题、高亮、git 标记、平台差异
- `cli/` — `setup.mjs` / `devices.mjs` / `twofa.mjs`（npm run setup / pair / devices / 2fa）
- `app/` — 手机端 PWA
- `android/` — Android WebView 壳（不走 CI，在本机 Android Studio 用自己的 keystore 签名发布：先改 `android/app/build.gradle` 的 `versionCode`（+1）和 `versionName`，再 `git tag vX.Y.Z` 并推送，最后 `gh release create vX.Y.Z AgentRemote.apk`。资产名必须是 `AgentRemote.apk`，tag 必须等于 versionName 加 `v`，App 内更新检查靠这两点）；`ios/` — iOS WKWebView 壳（setup.html 直接引用 android 的那份；签名和 `PUSH_URL` 放 `ios/Local.xcconfig`，不提交）
  - iOS 模拟器构建：`xcodebuild -project ios/AgentRemote.xcodeproj -scheme AgentRemote -destination 'platform=iOS Simulator,name=iPhone 17' build`
  - 上传 TestFlight：`scripts/ios-testflight.sh`（不需要注册设备；`DESTINATION=export` 只导出 ipa）
- `scripts/` — `check.mjs` 和 start-*.sh / service.sh
- `push-service/` — iOS APNs 推送服务（部署在 push.luojiajiang.uk，见其 README）

## Git

提交信息、tag、PR 里不得出现任何 AI 工具署名（不要 "Generated with ..."、不要 Co-Authored-By 机器人）。

## 截图 / 临时产物

真机或模拟器测试的截图一律放 `_shots/`（已在 .gitignore），不要放进 `android/` 等会被提交的目录。

## 检查

`npm run check`：语法、前后端消息协议、注入脚本导出快照。改协议或 page helpers 时必须先跑。

## 验证

大改之后，按下面的清单手动过一遍（每项都实际在手机上操作）：

每个应用（Cursor / Devin / Codex）：

- 连接：手机上能看到窗口并 attach 成功
- 发送：发一条消息，Agent 开始运行，聊天正常滚动
- 切换会话：在会话列表里换一个会话，历史正常加载
- 模型菜单：打开模型/参数菜单，能看到选项并能切换
- 文件预览：点开聊天里的文件引用，能看到带高亮的内容
- 终端：打开终端面板，能看输出、能发命令

Fusion：

- 跑一次完整 Fusion 流程：选项目、开始 run、两边 Agent 轮流执行直到结束

最后：`npm run check` 通过。
