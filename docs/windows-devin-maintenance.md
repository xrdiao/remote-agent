# Windows Devin 维护

本文记录 Windows Devin 的接入、更新和排查方法。Linux 仍使用 README 中的启动脚本；Android 共用网页交互，但原生功能需要单独做 APK 验收。

## 接入与更新

需要 Node.js 22 或更高版本、可执行的 `cloudflared`，以及打开远程调试端口的 Devin。默认 Devin 调试端口是 `9223`，中继端口是 `3939`。Windows 下应给 Devin 可执行程序添加 `--remote-debugging-port=9223` 启动参数；已经运行但没有开放调试端口的实例需要先退出再启动。

在仓库目录的 PowerShell 中，首次运行：

```powershell
npm install
npm run public
```

在另一个仓库终端生成手机配对链接：

```powershell
npm run pair
```

更新已安装的仓库：

```powershell
git pull --ff-only
npm install
node --check server.mjs
node --check app/i18n.js
git diff --check
```

有本地未提交修改时，先处理这些修改再拉取，不用重置仓库。更新 `server.mjs` 不会让正在运行的 Node 进程自动加载新代码：在原中继终端按 Ctrl+C，再运行 `npm run public`。不要结束全部 `node.exe`、Devin 或 `cloudflared` 进程。

检查中继端口和进程：

```powershell
$relayPid = (Get-NetTCPConnection -LocalPort 3939 -State Listen |
    Select-Object -First 1).OwningProcess
Get-CimInstance Win32_Process -Filter "ProcessId = $relayPid" |
    Select-Object ProcessId, CreationDate, CommandLine
```

电脑配置和配对信息在用户目录的 `.agent-remote` 中。当前 `findTunnelPid()` 仍调用 Unix `ps`，Windows 下重新运行 `npm run public` 不保证复用已有隧道。地址改变时检查终端打印的发布结果和手机连接诊断，不要把重建隧道和丢失配对记录混为一谈。

## 区分三个版本

1. **仓库文件**：`git pull` 更新本地源代码。
2. **运行中的中继**：重启后才加载新的后端逻辑。
3. **手机网页**：中继提供的页面与公网静态页面可能不同。推送主线代码不等于静态站点已经发布。

公网启动会尝试同步 App 文件和发布地址；需要检查日志是否成功，再刷新手机页面。网页入口或服务工作线程（Service Worker）仍是旧版时，可能看不到新按钮，但这不代表按钮代码未实现。维护测试应记录使用的是中继页面还是静态站点页面，以及对应的提交版本。

## 常见问题与代码位置

| 现象 | 检查位置与正确行为 |
|---|---|
| 文件打不开，或打开了同名的其他文件 | `server.mjs` 的 `devinEdit` 应保留 `fileUri` / `toolCall.rawInput.file_path` 中的完整路径；不能用界面上的文件名替代路径。`files.mjs` 处理盘符和文件 URI。 |
| 只能看到 Command 标题，看不到命令 | `devinCommand` 读取原生 `commandLine` 和 `outputs[].full`；`setCommandOpen` 负责展开原生命令卡。`app/index.html` 的 `renderTool` 分别显示命令与输出。目前输出最多显示 4000 字符。 |
| 修改文件列表为空 | 原生待审阅列表与历史编辑记录是两类内容。`listChanges` 在无待审阅改动时返回 `historical: true` 的会话记录；`showChanges` 显示“会话修改记录”，点击查看文件当前内容。 |
| 历史文件出现接受／拒绝按钮 | 历史记录不代表待审阅改动，不应提供此类按钮。真实待审阅改动继续使用 Devin 原生操作。 |
| 任务清单不能折叠 | 检查 `devinTasks`、`setTasksOpen` 和前端任务卡。读取任务详情时应恢复原生展开状态，不能把任务清单当成输入区的一部分。 |
| 切换会话后出现其他会话内容 | 检查原生当前会话 ID、可见 transcript，以及 `mergeDevinHistory` 的缓存键。Agent 侧栏和 Editor 标签页应读取各自当前选中的会话。 |
| 空会话仍显示旧消息 | 检查前端 `scSwitch`、`scMerge`：空会话应清除该会话缓存，旧会话的异步读取结果不能写回新会话。 |

不要仅凭两个会话都返回 50 条消息判断串会话：原生列表可能按相同条数分页。应比较原生会话 ID、消息 ID 和实际正文。

Android 的网页存储入口是 `app/index.html` 的 `nativeHist`，原生实现是 `android/` 中 `MainActivity.java` 的 `histGet`、`histMeta`、`histPut`、`histDel`、`histKeys`、`histSearch`。调整网页历史逻辑时保持这些桥接接口一致，检查 Windows 路径经过 JSON 存取后仍然完整。

## 最小验收

使用已配对的浏览器连接目标 Windows 电脑，优先检查现有任务，不必为展示功能新增任务。

1. 切到 Devin，分别打开两个有不同正文的会话；再打开空会话。标题、消息和修改记录应对应当前会话，空会话不显示旧内容。
2. 从已有编辑记录打开一个带目录的文件，核对完整路径和文件首行。代码应有语法高亮；存在相对 Git HEAD 的差异时应标记改动行。
3. 展开已有 Command 卡，核对实际命令和输出分开显示，不能只显示标题或把输出当成命令。
4. 展开、收起任务清单，再切换 Agent / Editor，确认任务仍属于原会话。
5. 有真实待审阅改动时再验收接受／拒绝；没有时只检查历史修改记录，不用历史记录代替审批验收。
6. Linux 本地检查会话读取、文件路径、命令和任务卡，确保 Windows 修改未改变 Linux 行为。运行前述语法检查及 `git diff --check`。

涉及前端交互时，在手机宽度下检查按钮、卡片和弹窗；Android 还需在新 APK 上检查扫码、通知回复及本地搜索。

## 当前验证范围

本轮 Windows 已通过配对浏览器检查文件打开、语法高亮与改动标记、命令／输出分开展示、会话修改记录，以及两个真实会话的消息隔离。测试页面由更新后的 Windows 中继提供；此次改动尚未发布到公网静态前端。

Linux 已做本地检查。Android 历史桥接接口、路径存取和空会话清理已做本地检查，未构建或真机验收 APK。Windows 真实待审阅改动的接受／拒绝尚未在本轮验收，不能视为全部平台功能已通过。
