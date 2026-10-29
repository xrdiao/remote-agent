# Remote Agent

把手机变成 Cursor / Devin / Codex 的遥控器：本机 relay 通过 CDP 驱动桌面应用。

## Ubuntu 基准版本

`master` 分支提交 `0a80c53be4c3a79b6fe36406fcfdd6e58657d15a`（简称 `0a80c53`，网页 `v277`）为用户指定的 Ubuntu 基准版本。后续核对 Ubuntu 退化时，以该提交与当前版本的实际代码差异确定受影响功能，只验证修改及其影响的功能；基准标记不表示所有功能已经验收。具体检查结果另行记录，不将未执行场景写为通过。

## 检查与修改前必读

每次修改前必须先阅读本地 `docs/development-requirements.md`（用户要求与续做记录，仅本地保留，不随仓库分发），遵守其中已明确的导航规则、范围限制、验证和自动发布约定。用户补充或纠正长期要求后，及时更新该记录；不要把待实现事项当作已完成。

每次开始功能排查或代码修改前，必须先阅读 [功能基准索引](docs/baselines/README.md)，再阅读对应功能的基准文档；跨功能时一并阅读受影响功能的基准。基准按功能定义用途、交互、行为边界、源码入口和验收场景，不以问题清单代替。功能行为经用户授权发生变化后，同步维护对应基准；未执行的验收不得记为通过。基准补充本文件的检查与验证要求，不替代用户当前明确指令。

## 修复原则

每次修改代码前先取得用户确认。仅实施已确认的方案，不擅自添加其他逻辑，不改动范围外的功能和逻辑，不优化其他代码；不额外添加保护措施或兼容逻辑，除非用户明确要求。

排查和修复必须从功能逻辑、数据归属、请求时序及状态变化寻找根本原因，不得靠额外堆叠条件、隐藏入口、吞掉事件或延时压住表面现象。必要功能行为必须保留；已证实冗余、失效或反向干扰功能的实现应在对应范围内修正或移除。修复后通过既有配对浏览器复现原触发场景，并检查修改及受影响的功能；未覆盖的场景如实记录。

## 结构

- `server/` — relay 本体（`index.mjs` 入口，`session.mjs` 会话，`page/` 注入脚本，`http/`、`publish/`）
- `lib/` — 认证、通知、文件、主题、高亮、git 标记、平台差异
- `cli/` — `setup.mjs` / `devices.mjs` / `twofa.mjs`（npm run setup / pair / devices / 2fa）
- `app/` — 手机端 PWA
- `android/` — Android 壳：启动页为原生概览 `OverviewActivity`，网页客户端在 `MainActivity`（本机编译：`android/` 下以 JDK 21 为 `JAVA_HOME` 运行 `gradlew.bat assembleDebug`（Android Studio 自带 jbr 是 JDK 25，Gradle 8.9 编译 build.gradle 会报 class file major version 69；本机可用 `~/.jdks/jbr-21.0.11`）；不走 CI，在本机 Android Studio 用自己的 keystore 签名发布：先改 `android/app/build.gradle` 的 `versionCode`（+1）和 `versionName`，再 `git tag vX.Y.Z` 并推送，最后 `gh release create vX.Y.Z AgentRemote.apk`。资产名必须是 `AgentRemote.apk`，tag 必须等于 versionName 加 `v`，App 内更新检查靠这两点）；`ios/` — iOS WKWebView 壳（setup.html 直接引用 android 的那份；签名和 `PUSH_URL` 放 `ios/Local.xcconfig`，不提交）
  - iOS 模拟器构建：`xcodebuild -project ios/AgentRemote.xcodeproj -scheme AgentRemote -destination 'platform=iOS Simulator,name=iPhone 17' build`
  - 上传 TestFlight：`scripts/ios-testflight.sh`（不需要注册设备；`DESTINATION=export` 只导出 ipa）
- `scripts/` — `check.mjs` 和 start-*.sh / service.sh
- `push-service/` — iOS APNs 推送服务（部署在 push.luojiajiang.uk，见其 README）

## Git

提交信息、tag、PR 里不得出现任何 AI 工具署名（不要 "Generated with ..."、不要 Co-Authored-By 机器人）。

## 截图 / 临时产物

真机或模拟器测试的截图一律放 `_shots/`（已在 .gitignore），不要放进 `android/` 等会被提交的目录。

## 检查

适当检查，不要过度检查。只检查修改及受影响的功能；已通过且未受后续改动影响的检查不重复执行。

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
