# v250 Windows 兼容性专项排查

日期：2026-10-26。源码基线：`24e4cd7`，网页 `v250`。执行环境为 Ubuntu、Node.js 22.23.3；**没有 Windows 真机执行结果**。

本报告检查在 Ubuntu 可运行、移到 Windows 后因路径、命令查找、编码和系统接口差异导致的失败，供后续在 Windows 继续修复。Windows 专项的源函数检查没有修改产品代码、发布、更新缓存、重启中继、安装依赖或改动真实配对／会话。随后用户授权的一次真实浏览器配对及界面补验，单独记录在统一报告第 15 节，不属于 Windows 真机结果。

检查前读取了功能基准索引及 03、06、07、08、09。复用已有配对退出 B31 和闲置窗口能力缺口证据，不重新运行先前整批测试。本文 W 编号是专项分组，不与此前 B／S／R 数量直接相加。

本次统一整理后，W 项按影响功能接入 [统一审查报告](logic-bug-audit-v250.md) 第 2.2 节；此前遗漏、已读未验证和尚未覆盖分别见该报告第 13.1–13.3 节。本文仍保留 Windows 的触发条件、代码位置、修改方向、影响范围与后续实测步骤，未把 Ubuntu 隔离结果升级为 Windows 通过。

## 1. 结果与证据边界

定位到 **6 组具有具体失败条件的兼容问题**。验证采用当前源函数、Node Windows 路径语义和受控依赖；不把这些结果写成 Windows 端到端验收。普通本地路径、默认端口、工具已在 PATH、Python 使用 UTF-8 的情况下，部分问题不会出现。

| 编号 | 问题及触发条件 | 影响功能 | 证据 |
|---|---|---|---|
| W01 | UNC 共享路径丢服务器名／双斜线，盘符根目录被当成盘符相对路径或错误拒绝子目录 | 项目识别、Editor 目录、共享盘文件、Fusion 项目归属 | 当前解析／目录函数隔离执行＋`path.win32` |
| W02 | 文件 URI 留下 `/C:/...`；快速搜索返回 Windows 绝对目录时又拼接一次项目路径 | Cursor／Codex 文本文件链接及预览，部分文件查找回退 | 实际注入清理函数＋实际 resolveFile 受控执行 |
| W03 | CPU 语音 stdout 使用本地代码页，中继按 UTF-8 读取 | Windows 非 UTF-8 环境的中文转录结果 | 当前 Python emit 函数 AST＋两种输出编码对照 |
| W04 | Windows 启动脚本固定 9222／9223／9224，忽略 Ubuntu 入口支持的端口变量 | 自定义端口下启动 Agent、发现与加载 | 当前配置执行＋PowerShell 脚本常量对照；未执行 PowerShell |
| W05 | 配对入口能找到便携 cloudflared.exe，中继启动／恢复却找不到 | 便携部署的公网启动和隧道恢复 | 实际 ensureServices／findBin 使用同一受控文件系统 |
| W06 | 部分 Git／GitHub CLI 调用绕过已有 Windows 可执行路径解析 | Fusion 的 Cursor 仓库映射、固定入口首次登录 | 当前源函数受控执行，模拟旧终端 PATH |

另有 Windows 闲置窗口回收能力缺口、Qwen 明确只支持 Linux，以及需 Windows 实测的系统行为，分别列在第 3、4 节，不混算为上述 6 组。

## 2. 具体问题、修改方向与影响

### W01 · 共享路径与盘符根目录没有保持 Windows 语义

位置：[parseFolderUri](../lib/files.mjs#L12)、[editorRoots](../lib/files.mjs#L136)、[listProject](../lib/files.mjs#L271)、[resolveLocal](../lib/files.mjs#L341)。

已验证四条具体路径：

1. `file://fileserver/shared/Project` 被解析为本地 `/shared/Project`，服务器名被丢弃；正确结果应保留 `\\fileserver\shared\Project` 的 UNC 身份。
2. 即使输入正确 UNC，`listProject` 先变为 `//fileserver/shared/Project`，再用 `path.posix.join` 生成子目录，变成 `/fileserver/shared/Project/sub`，丢掉第二个起始斜线。相同 POSIX 拼接用法还出现在文件解析处；不是所有 `path.posix` 都错误，问题是它被用于有特殊根语义的 Windows 本地路径。
3. `file:///C:/` 去掉开头斜线后又删除结尾斜线，得到 `C:`。在 Windows 中它表示该盘当前目录，不等于 `C:\`；隔离结果以 `C:\work` 为当前目录时解析成 `C:\work`。
4. `listProject('C:\\', 'C:\\Project')` 的实际字符串参数为盘根和其子目录，范围比较却用 `base + path.sep`，形成两个结尾分隔符，错误报“只能查看这个项目里的文件”。

反例：`file:///D:/Work/My%20Project` 的普通目录解析正确；`C:\Work` 项目下子目录生成也正确。不能据此说所有 Windows 项目都不可用。

建议修改：在现有路径入口区分文件 URI、本地路径、UNC 与远程 POSIX 路径；服务器、盘根与原始目标身份必须保留。Windows 本地目录拼接遵守其根语义，范围判断处理已经带分隔符的根。复用现有 `normPath/pathKey`，避免每个调用方再写一套转换；转换后仍执行既有项目范围判断。

影响：项目列表、窗口工作区识别、Editor、文件链接以及复用项目身份的 Fusion。SSH 目录继续用远端语义；不能将 UNC 改标为 SSH，也不能为修路径取消项目边界。Windows 修复时需同时覆盖 URI 入口和目录子项，单改解析器不够。

平台语义可对照 [Node 文件 URL 转路径说明](https://nodejs.org/api/url.html#urlfileurltopathurl-options)；本机 Node 22 的 `fileURLToPath(..., { windows: true })` 对照结果也保存在证据中。

### W02 · 文件链接转换与查找回退对 Windows 使用不同规则

位置：[注入 clean](../server/page/common.js#L135)、[resolveFile](../server/agent/files.mjs#L78)、[resolveLocal](../lib/files.mjs#L341)。

实际清理函数把 `file:///C:/Work/src/main.txt#L2` 输出为 `/C:/Work/src/main.txt#L2`。Devin／图片所用的 `resolveLocal` 有去除盘符前多余斜线的分支，而 Cursor／Codex 普通文本分支没有，直接将 `/C:/...` 交给文件系统。

接着，快速搜索若返回绝对目录 `C:\Work\src`，当前代码只把开头为 `/` 的目录当绝对目录，其余拼到项目根后。隔离执行实际 resolveFile，最终尝试 `C:/Work/C:\Work\src/main.txt`，未找到本来存在的文件。直接给规范化的 `C:/Work/src/main.txt#L2` 则成功，行号也正确。

建议修改：文件引用进入解析时统一完成本地路径转换；快速搜索结果按真实平台的绝对／相对含义处理，不只判断开头 `/`。UNC 与文件 URI 使用 W01 的同一转换规则。保留完整目标和行号；不能因为绝对路径失败就静默打开另一目录同名文件。

影响：Cursor／Codex 聊天文件预览、由文件查找进入的文本内容及搜索回退。Devin 和图片解析已有部分正确处理，应复用而非重写；PDF／视频取得正确路径后的阅读／播放逻辑无需调整。

### W03 · CPU 转录的中文协议输出未固定为 UTF-8

位置：[worker.py emit](../server/voice/worker.py#L13)、[spawnRuntime](../server/voice/service.mjs#L76)、[读取 JSON 行](../server/voice/service.mjs#L100)。

CPU worker 使用 `print(json.dumps(..., ensure_ascii=False))`，没有明确 stdout 编码；启动只加 `-u`，没有固定 UTF-8。中继通过 Node 文本流按 UTF-8 解码。Windows 的非 UTF-8 管道环境因此可能损坏中文，即使识别模型已正确返回结果。

隔离只编译并执行当前 emit 函数，没有加载 numpy、sherpa 或模型：同一“中文识别”在 GBK 文本流输出后，Node 按 UTF-8 读成 `����ʶ��`；UTF-8 输出时正确。此结果验证编码不一致的后果，不代表已在用户 Windows 上转录过。

建议修改：在现有 Python／Node 协议边界明确 UTF-8，范围限 CPU worker 的协议流和相应启动约定；不修改识别算法、模型、背压或录音行为。仅 `-u` 解决缓冲，不解决编码。Qwen worker 已显式建立 UTF-8 协议流，不应因 CPU 问题将两者一起重写。

影响：CPU 语音的 partial／final／错误文字。ASCII 内容或已经启用 UTF-8 的 Windows 环境不会体现相同乱码；不能将所有语音等待或识别质量问题归到此处。[Python 对 Windows 标准流编码的说明](https://docs.python.org/3.12/library/sys.html#sys.stdout)支持上述环境条件。

### W04 · Windows 启动器与中继自定义端口可能不一致

位置：[Windows agentConfigs](../window_start/start-agents.ps1#L96)、[runLaunchers](../server/launch.mjs#L75)、[中继 CDP 配置](../server/config.mjs#L9)、[Ubuntu 入口](../ubuntu_start/start-agents.sh#L45)。

Windows PowerShell 入口把三个端口固定为 9222、9223、9224；Ubuntu 分别读取 `CDP_PORT`、`DEVIN_CDP_PORT`、`CODEX_CDP_PORT`。中继实际读取的是对应的 `CDP_URL`，两组变量本来就需要保持一致。

当用户将 URL 和 Ubuntu 启动端口变量都配置到 19222／19223／19224 后，Ubuntu 入口能使用配置；Windows 入口依旧启动默认端口。脚本可能报告启动完成，但中继仍连自定义端口，加载时看不到目标。默认端口不受这一差异影响。

建议修改：让启动端口与中继当前配置有同一个明确来源；若保留原有端口环境变量，应明确优先级并与 URL 配置核对。不是另外增加一套自动扫描或重试。

影响：Windows Agent 启动／检测和采用非默认 CDP 地址的加载。正常默认配置、原生聊天、会话操作无需变更。实际 PowerShell 参数及自定义端口启动留待 Windows 验证。

### W05 · 便携 cloudflared.exe 的查找只修在一个入口

位置：[cloudflaredBin](../lib/platform.mjs#L97)、[ensureServices](../window_start/pair-link.mjs#L90)、[launchTunnel](../server/publish/tunnel.mjs#L97)。

Windows 配对启动器显式查找 `~/.local/bin/cloudflared.exe` 和仓库 `.runtime/cloudflared.exe`。中继使用的公共解析器却先找没有 `.exe` 的 `~/.local/bin/cloudflared`，否则只返回 PATH 命令 `cloudflared`。

用同一受控文件系统执行两条现有函数：只安装 `.local/bin/cloudflared.exe`、PATH 中没有工具时，配对入口成功选中该文件，中继解析仍返回 PATH 命令。因而可能出现“配对入口可创建隧道，直接运行中继／后续恢复隧道找不到程序”。`.runtime` 下同样存在入口规则不一致，未重复计一项。

建议修改：在已有公共解析器集中保留现有受支持的 Windows 查找位置，启动器和中继共用结果。复用健康隧道和地址的规则保留；不下载新工具，不改用户安装目录。

影响：Windows 便携部署的公网启动、隧道恢复及配对启动入口。工具已在 PATH 时该路径不失败；本轮未停止或重建真实隧道。

### W06 · 已有 Windows 工具解析器，但部分调用绕过它

位置：[gitBin／ghBin](../lib/platform.mjs#L84)、[fusionCursorProjects](../server/fusion/state.mjs#L22)、[ensureFixedEntry](../cli/fixed-entry.mjs#L48)、[setup 依赖检查](../cli/setup.mjs#L16)、[交互启动](../cli/desktop-pair.mjs#L22)。

两个已验证的子场景：

- **Git**：工具安装在解析器已经支持的 `C:\Program Files\Git\cmd\git.exe`，但当前终端 PATH 没更新。通用 Git 解析成功，Fusion 的 Cursor 仓库映射却直接 `execFileSync('git', ...)`，错误被 catch 后跳过该项目；隔离结果映射数量为 0。影响的是这条仓库关联，不代表所有 Fusion 本地项目都打不开。
- **GitHub CLI**：`ghBin` 可以找到 `C:\Program Files\GitHub CLI\gh.exe`；版本／状态查询走公共 run 可成功，但首次登录传给 interactive 的仍是裸 `gh`。旧 PATH 下进入不了登录。setup 入口另有直接 `where gh` 判断，同样没有使用已存在的解析结果。

建议修改：上述调用复用既有 `findBin('git')`／`findBin('gh')` 结果；不新写一套盘符扫描或 shell 包装。保留交互登录的终端模式及固定入口的用户确认。

影响：Fusion 中 Cursor 仓库身份关联、初次固定入口配置和 GitHub 登录；不改变账号、仓库发布策略或 Git 差异算法。新开终端后 PATH 已正确的情况可能不会复现。

## 3. 能力缺口与明确的平台限制

### C01 · 闲置项目窗口回收目前没有完整 Windows 实现

[projectProcesses](../server/project-windows.mjs#L57) 在非 Linux 直接返回 `null`；探测据此保留窗口。[nativeCloseProjectWindow](../server/project-windows.mjs#L113) 也只实现 Linux／DISPLAY 的关闭入口。

这意味着 Windows 可以看到管理界面和窗口，但无法完成当前这套自动闲置回收。属于平台能力缺口；没有证据表明它会去访问 Windows 上不存在的 `/proc`，也不能为实现关闭而删除“不确定则保留”的规则。

后续 Windows 实现应获取可靠的窗口身份及项目／终端／后台任务状态，并关闭对应原生窗口。保留最后一个可用窗口、Fusion／正在使用占用和关闭前复查；进程名相同不等于可以结束整个 Agent。

### C02 · Qwen 安装入口明确仅支持 Linux

[voice-setup](../cli/voice-setup.mjs#L32) 对非 Linux 明确报错，文案也说明官方 vLLM 路线的 Linux／NVIDIA 要求。这不是本轮发现的路径 bug，不能通过替换 `bin/python` 为 `Scripts/python.exe` 就宣称支持 Windows。CPU Sherpa 的 Windows Python Launcher 和虚拟环境路径已经有分支。

若后续要求 Windows 使用 Qwen，需要独立决定运行方式和推理依赖，超出本次路径／脚本修复；当前继续保留明确的平台限制。

## 4. Windows 后续实测项：尚不记为已复现缺陷

| 项目 | 已看到的具体代码／条件 | Windows 需确认的结果 |
|---|---|---|
| 配对退出 B31 | `taskkill` 同步且未处理失败；CLI 仍等待地址发布 | `npm run pair`、配对快捷入口，在 Ctrl+C／关窗／到期和发布等待时各自结束；保留已批准入口及中继 |
| PowerShell 中文可执行路径 | `windowsAppBin` 和主题的 `installFromPort` 按 UTF-8 解码输出，查询脚本没固定输出编码；visual 的脚本反而已显式设置 UTF-8 | 记录 `[Console]::OutputEncoding.WebName`，在中文用户名／安装目录下核对解析路径是否原样返回；不能断言所有 Windows 默认编码相同 |
| 各 Agent 的实际 CLI 布局 | openFolder 根据主 exe 目录推导固定 `.cmd` 路径 | 对当前 Cursor／Devin／VS Code 安装逐项验证推导文件存在，再做跨项目打开；目前没有用户 Windows 安装树证据 |
| Windows 文件系统差异 | 上传／新建交给文件系统处理名称，保存／覆盖使用 rename | 用测试文件确认保留名、尾随点／空格、长路径、占用文件、只读与权限错误的反馈；未在 NTFS 执行，不把所有这些条件先算成 bug |
| PowerShell 与权限环境 | 有 Windows PowerShell、CIM、注册表、快捷方式、不同权限进程的探测 | 普通权限启动与管理员 Agent、实际脚本执行策略、非 C 盘安装下的发现结果；不以 Ubuntu mock 替代系统行为 |
| Windows 画面 | 已实现 PowerShell 窗口枚举、UTF-8 输出和 FFmpeg gdigrab hwnd 捕获 | 使用具备所需能力的 FFmpeg，验证目标窗口选择、捕获和切换；不能因 Ubuntu 使用 Python／X11 就宣称 Windows 没实现 |

PowerShell／.NET 输出编码受环境影响，见 [Console.OutputEncoding](https://learn.microsoft.com/en-us/dotnet/api/system.console.outputencoding?view=netframework-4.8.1)；本项为源码风险与平台核对事项，没有本次 Windows 字节输出样本。

## 5. 已核对的适配与范围边界

- 已有 `normPath/pathKey/samePath`，本地路径可做 Windows 大小写归一化；不能据存在斜线／大小写就判所有比较错误。
- 启动脚本存在 exe、cmd、bat、注册表、快捷方式及多盘符查找；本次不将其全部推倒重写。
- openFolder 使用 PowerShell 调用 `.cmd`，路径用单引号并转义内部单引号；普通空格路径并不是该代码已确认的缺陷。
- Windows 的程序安装目录、APPDATA 用户目录、盘符选择、CPU 虚拟环境 Scripts 路径和终端控制键均有实现；有分支不等于所有场景已验证，亦不能反过来声称完全没适配。
- Linux `/proc`、X11、Wayland 与 macOS 服务脚本的存在本身不是 Windows bug，应沿调用条件判断。Windows 无完整闲置回收单列 C01。
- Windows／Ubuntu 共享的普通业务错误继续参考原 B 清单；本报告没有重复验证通知、发送或所有菜单，也没有声称 Windows 所有功能通过。

## 6. Windows 修复及复测顺序

1. **路径基础 W01／W02**：普通 C／D 盘、中文及空格项目、盘根、UNC 共享目录。覆盖项目识别、目录展开、聊天文本链接、行号、文件读取与保存、Fusion 项目身份。先确认路径相同再处理标题，不把显示名称当作身份。
2. **工具查找 W05／W06**：PATH 完整、当前终端 PATH 过旧、仅 `.local/bin`／`.runtime` 中有可执行文件。覆盖配对、固定入口登录、隧道启动恢复和 Fusion 仓库关联；已有健康隧道不应为测试被重建。
3. **启动与退出 W04／B31**：默认与自定义端口、已运行但没开 CDP、配对关闭和 Ctrl+C。核对脚本结果与中继实际可见端口一致；配对命令退出不退出中继或 Agent。
4. **CPU 编码 W03**：记录 Python 版本及协议流编码，在当前非 UTF-8／UTF-8 环境分别验证中文 partial、final 和错误消息。只测 Sherpa 的协议问题，不扩展 Qwen Windows 支持。
5. **能力缺口和系统项**：需要实现 C01 时单独授权并回归；画面、权限、长路径及锁定文件按第 4 节记录实际结果。

每批只改对应功能和实际受影响代码。Windows 复测记录版本、场景、实际结果及错误文字；能运行、失败和环境未具备分别记录，不能沿用本报告的隔离结论当作真机通过。

## 7. 本地证据

证据位于忽略目录 `_shots/windows-compat-audit-v250-20261026/`：

- `proofs.mjs`／`proofs.json`：W01–W06 的受控源函数及配置检查、正常路径反例、C01 的平台返回。
- `root-proofs.mjs`／`root-proofs.json`：UNC 子目录丢斜线、盘根子目录误拒绝，以及普通盘符目录反例。
- `worker-gbk.jsonl`／`worker-utf8.jsonl`：只编译当前 CPU worker 的 emit 函数后生成的两种编码输出，没有加载语音模型。
- 配对退出复用 `_shots/pair-exit-audit-v250-20261026/proofs.json`；未重复运行。

本轮的初次 Node 内同步 Python 子进程受沙箱 EPERM 限制，随后直接用 Python 编译同一 emit AST 生成隔离输出，再由 Node 读取验证；没有把失败命令记为通过。临时脚本补齐依赖后相关检查通过。本次无产品改动，不重复执行同一源码基线已经通过的 `npm run check`。
