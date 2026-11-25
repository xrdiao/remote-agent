# HANDOFF · Remote Agent（RA）隔离重构

> 更新：2026-11-23。跨会话恢复入口。**以 Git 工作区、源码、原始 QA 结果为准**；本文件是交接索引，不代表已提交、发布或实际跨机验收。

## 项目边界与安全要求

- 生产仓库：`/home/lihe/adxr_ws/src/remote-agent`，分支 `feature/ra-peer-tasks`，正式 Relay **3939**，原 v514。**未经用户明确批准，不覆盖、不重启、不合并、不提交、不推送生产版本。**
- 隔离工作树：`/home/lihe/adxr_ws/src/remote-agent/_shots/architecture-refactor-v514`，分支 `refactor/v514-boundaries-20261122`，当前 PWA **v524**。隔离 QA Relay **3949**，配对 Chrome CDP **9335**；QA 数据在 `/home/lihe/adxr_ws/src/remote-agent/_shots/full-functional-20261102/relay-data`（正式仓库下独立 QA 目录；启动参数见活进程）。
- 遵守 `AGENTS.md`：修改前明确文件和验证范围；用户已经要求继续修改并验证；**不得触碰 `scripts/page-exports.json`**。临时测试夹具只放 `_shots/`，用后删除，保留日志。最终手机真机和双机必须分别验收，不能用浏览器/模拟替代。
- 面向用户的三入口为**概览／工作／设备**；原项目、收藏仍在概览筛选中；Fusion 用户可见命名为**自主编排**。默认普通 Agent 不注入远程工具或相关 Prompt，仅明确授权时发起 RA 操作。

## v520 已完成的重构

- 接入 `server/ra-core/`：原生会话 **OriginRef**、注册节点及能力、明确的 **Activation**、SQLite 持久 **Operation**、Work/Link 回执。实际执行复用 Peer Workspace v2 的签名/目录/权限。未知回执记录 `UNKNOWN`，不会自动重发。
- UI：三入口、设备选择和能力、普通会话卡片跨机手动入口、工作页关联操作、自主编排工作台。原生 Codex/Cursor/Devin 卡片、读取、文件/终端等已执行定向回归。
- v520 事实和具体证据：`_shots/ra-core-20261123/final-v520-report.md`，`docs/architecture/ra-core-v1.md`、`docs/architecture/ra-ui-v1.md`、`docs/testing/refactor-v517-unified-qa-20261123.md`。前一轮 deterministic RA Core 25 项、UI fixture 19 项通过；配对浏览器 19 项只读回归和 Codex 4 项原生动作通过。旧记录不可自动视为 v521 新功能端到端通过。

## v521 本轮增量（未提交）

- `app/js/ra-core-ui.js`：将原固定的「列出工作区根目录」扩展为由远端已登记能力决定的九个**手动**动作：列/读/建/存文件，开/读/发/中断/关终端。选择 B、工作区、动作后显式核验激活，限定选定动作、**5 分钟、一次用量**，另外提交实际执行。相对路径、输入内容的大小与控制字符限制和后端一致；提交前核对原会话/工作区/动作/参数；读文件或终端输出只在当次回执面板出现。异常/不确定回执不自动重复执行。
- `app/app.css`：文件路径和正文编辑控件及终端回执样式。`app/index.html`、`app/sw.js`、`app/js/core.js`：同步更新 v521 PWA 缓存与资源 URL。
- `scripts/browser-tests/blocks/overview.mjs`：新增 `overview.ra-actions` 真实配对页面场景；目标工作区未登记时明确标记 `blocked`。修复 `overview.ra-devices` 用例在切换全部电脑后的等待断言（`ovS.comp` 为 null，等待真实 DOM 更新）。
- 文档更新：`docs/architecture/ra-ui-v1.md` 的 v521 小节。**普通 Codex 会话的自动按需 RA 工具 M3 尚未实现**，不能将上述手动 UI 宣称为 M3。

## v521 已执行的检查

| 检查 | 实际结果 | 原始证据 |
|---|---|---|
| `npm run check`、`git diff --check`、`npm run qa:browser -- --list` | 通过；场景清单可加载（仅列目录，不等于功能执行） | `_shots/ra-core-20261123/v521-static-and-catalog.log` |
| 实际 UI 源码 `operationArgs` 校验（15 个合法/非法参数） | 15/15 通过，未向 B 派发 | 控制台执行原生产代码；本轮交接记录 |
| 新增 `overview.ra-actions` | **blocked**：QA B 未登记可调用工作区，故无真实文件/终端执行 | `_shots/ra-core-20261123/v521-ra-ui-browser-qa.log`；`_shots/browser-tests/2026-11-23T08-21-00-116Z-linux/report.md` |
| Codex/Cursor/Devin OriginRef、设备与工作页及导航 v521 | 定向回归 **全部 passed**；此前设备用例错误为异步等待测试断言，已修复 | `_shots/ra-core-20261123/v521-ra-ui-regression-final.log`；`_shots/browser-tests/2026-11-23T08-25-22-210Z-linux/report.md` |

**不要混淆**：未授权执行按钮保持禁用、输入校验正确、浏览器页面显示能力，不代表曾收到远端真实 B 的签名操作回执。

## 阻塞与下一步

1. **B 真机/签名端到端**：QA 现有第二节点 ID `e884551bc8d2f567`，对应中继 3957 当前离线、没有可调用 Peer Workspace 绑定。本机可见远端列表并不代表授权或在线。无需新增第三台电脑；恢复原 B 中继并在 QA 目录授权后，验收 A→B 文件写/读、终端执行/输出、一次性操作 ID 重放、超时/断线 `UNKNOWN`、撤销 B 权限和结果查询。该测试不能凭模拟宣称通过。
2. **M3 原生动态 Agent 工具**：普通 Codex 会话尚无 on-demand RA tool；原生 `dynamicTools` 是 `thread/start` 参数，不能给所有旧会话注入提示或全局工具。下一轮需设计显式、范围限定的新会话工具生命周期与撤销逻辑，且与手机专用会话区分；在隔离 QA 完成后再验收，不能宣称现有手动 UI 等同 M3。
3. **自主编排**：QA Codex 主 Agent 当前没有可控能力。既有两个测试工作台 blocked / stopping，**不可强制删除或假标完成**。待主 Agent 原生窗口就绪，再执行真实创建→子任务→主控审阅→交付→停止/清理，检查原生轮次结束与清理确认。
4. **多平台**：Windows、Android/iOS 真机、原双物理节点断线压力、跨版本迁移未在本轮验证，仍是发布门槛。
5. **后续交接动作**：`git status --short --branch`，阅读本文件和 v520 报告、再核对工作树实际状态；不要凭聊天摘要猜文件；QA 仅在隔离 3949/Chrome 9335 执行；不要覆盖已有 QA 数据或在途操作。

## 只读接手检查

```bash
cd /home/lihe/adxr_ws/src/remote-agent/_shots/architecture-refactor-v514
git status --short --branch
git log -3 --oneline
cat HANDOFF.md
npm run check
npm run qa:browser -- --list
# 已登记 Chrome 9335 可用且适合执行时，再跑定向真实 UI 验收：
npm run qa:browser -- --registry _shots/full-refactor/paired-qa/registry.json --suite smoke --apps codex,cursor,devin --targets ../../_shots/nov22-v507-qa/targets.json --case connection.ready,overview.levels,overview.ra-origin,overview.ra-devices,overview.ra-work,client.version --timeout 28000
```

**历史 v521 阶段发布判定：当时尚不能发布。最新 v524 状态见文末新增验收记录。**

## 2026-11-23 双机连接调查（纠正旧判断）

**请勿再用“第二台电脑离线”描述当前事实。** 用户确认第二台实体电脑仍在运行；我们只证实对应测试/互控链路不可达，无法通过本机工具直接证明 B 的开关机或 OpenCode 状态。

- 本机可连接的 Desktop Commander 设备仅 `lihe-MS-7D94`（A），尚未直接连入 B。A 的正式 Relay 3939 与隔离 QA Relay 3949 均监听中，测试 3957 **不在 A 本机监听**。3957 是先前 QA 使用的旧测试链路，不能因此判定远程实体 B 不在线。
- **生产数据与 QA 数据隔离**：生产 `~/.agent-remote` 有 `peer.json`、一条工作区入站授权、两个出站 Peer Workspace v2 绑定（目标电脑 `f11ccaa10a97a947`）；QA 数据目录 `/home/lihe/adxr_ws/src/remote-agent/_shots/full-functional-20261102/relay-data` 在该次诊断时既无 `peer.json`，也无工作区入/出站授权；**此后本轮仅为同机双 Relay 测试新建了独立 QA B 授权，非实体 B**。QA Chrome 的 `Isolated peer worker` 是历史测试设备条目，不是 B 的实时签名通信。
- 身份不同：生产 A `computerId=9c2edc937b8afeb7`，QA A 在已配对浏览器 `computerId=3358eb55ee7fa37a`。测试身份与密钥独立，**不能把生产密钥/授权/数据复制到 QA 假装双机成功**。
- 生产出站工作区绑定最后更新于 2026-11-22，两个工作区和旧预设任务均指向 `trycloudflare.com` 临时隧道地址。2026-11-23 本机对这三个历史主机名都得到 DNS `ENOTFOUND`；公共 `example.com/cloudflare.com/trycloudflare.com` 正常解析。本机生产 API 经 Peer Workspace v2 对两个工作区逐一执行**只读签名** `inspect`，均未收到 B 的可验证回执（502）。另一路通过系统代理访问旧地址也发生 SSL 连接失败；这支持“旧隧道地址不可达”，但尚不能证明 B 的最新真实入口在哪里。
- **下一步需在 B 确认其当前 Relay 和实际 Cloudflare URL/固定域名是否仍有效**，以及 B 的电脑 ID、Peer v2 指纹是否和 A 的登记一致。新 URL 需经既有互控授权流程重新核验；恢复 QA 时让 B 对**独立 QA A 身份**明确授予测试目录/能力，再执行真实 A→B→A 只读和写入回执测试。未经确认不得替换工作区绑定、启动/停止生产中继、修改凭据。

## 最新：v524 隔离联调与发布门槛（2026-11-23）

**不要把前文 v521 的历史 QA 阻塞误认为当前未搭建任何测试 B。** 本轮在同一台 Ubuntu 机器的 `3949`（QA A）及 `3957`（QA B）搭建两套独立身份、独立密钥、独立目录的**同机测试网络**，仅用于协议和界面验证；这不是另一台真实电脑。真实 B 的 Cloudflare 旧地址仍失效，实体双机仍未验收。

- **新增实际修复：** `app/js/ra-core-ui.js` 的输入失焦重绘导致激活按钮点击丢失（v523）；`app/js/sheets.js` 的新弹层继承旧滚动使顶部固定标题挡住菜单（v524）。对应 PWA 缓存版本及入口资源 URL 为 v524。新增手动的九类文件/终端操作保留明确授权、单次调用与未知结果不自动重发；**没有**给普通 Agent 注入提示或远程工具。
- **配对浏览器真实执行，原始报告见 [v524 统一汇总](_shots/ra-core-20261123/v524-final-audit.md)**：同机双 Relay 的九种真实签名文件/终端动作与授权撤销已通过；v524 菜单修复定向检查 9/9；统一三应用 smoke 共 173 条记录：36 passed、**0 failed**、19 blocked、106 not-run、12 manual，cleanup.errors=[]；Codex 原生真实工作流 7/7 passed，cleanup.errors=[]。
- **明确失败不能抹去：** Cursor/Devin 真写流程中 9 passed、**Devin 发送 120s 未生成回复 1 failed**；指定原生 `SWE-2 Flash` 后仍 70s 未生成回复，未假标成功。Fusion Cursor 主控 `fusion.create` 在主模型未就绪时无法启用，后续导航/管理/停止 3 blocked；现有 Codex QA 主控接口不在线。详见本轮原始报告与 v524 汇总。
- **原生协议 M3：** Codex app-server 0.171.0-alpha.13 的 `dynamicTools` 只在 `thread/start`；没有既有普通线程热插拔工具协议。设计新明确授权的专用会话不能等价宣称普通旧会话自动具备远程工具。
- **工具及交接**：静态检查 `npm run check`、`git diff --check`、`npm run qa:browser -- --list` 均已通过；临时九动作 QA 测试夹具依规则从代码目录清理，日志存 `_shots/ra-core-20261123/`。正式 Relay 3939 和生产数据未修改；Git 无提交/合并/推送。截图由 Codex 按 v524 页面设计、通过受控配对浏览器 QA 执行；仅以磁盘实际 PNG 和 manifest 证明完成。

## v524 截图与 QA 资源回收（最终本轮事实）

- Codex 在自身受限沙箱内直接连 Chrome CDP 9335 得到 EPERM，未生成截图；随后 **Codex 实际生成** `_shots/ra-core-20261123/capture-v524.mjs`，由既有配对浏览器执行器检查、修正脚本恢复判定和动画等待后执行完成。`_shots/ra-core-20261123/ui-v524-codex/` 已生成 **01-overview.png、02-work.png、03-devices.png** 三张真实 500×757 v524 中文截图及 `manifest.json`；manifest 显示 navigation 与 viewport 均 restored。当前无法安全展开 Codex 原会话操作弹层，04-access 未生成，不能声称拍摄了它。
- 用于协议测试的**同机**临时 QA B Relay 3957 在截图后已按 PID 核验终止；仅删除 QA A 中专属其身份的两项临时登记/信任记录，日志和截图保留，正式 3939 和独立 3949 均仍监听。勿再将 3957 的关闭解释为第二台实体 PC 不在线。
- 本轮已完成静态检查、已知原生功能和 UI 功能定向验收及统一 smoke，但**未满足所有发布门槛**：真实 B 无可验证有效入口、现有普通 Codex thread 的 M3 工具热插拔、Devin 原生生成及 Fusion 主控初始化、Android/iOS/Windows 真机仍未通过。所有 blocked/failed 保留。无需重新重构或新增第三台电脑；继续时先读 `_shots/ra-core-20261123/v524-final-audit.md` 与具体原始报告。

## 2026-11-23 晚间续验收：v524 · 第二次接手

> 这是当前最新交接进度；前文描述的是历史阶段。**正式 3939 仍原样运行**，隔离 3949 可重启；本次尚未 Git commit/push/merge。User 已要求继续直到全功能可验证，不应仅依据某个 smoke 报告宣称全部成功。所有新临时服务/模型/测试数据只写在 `_shots/`。

- **Fusion Cursor 项目准备已修复**：`server/fusion/agent.mjs` 中 Fusion 主控准备在没有所选项目窗口时不再强制 `reuseOnly:true`，而是调用普通打开项目路径；同时 `scripts/browser-tests/blocks/fusion.mjs` 等待真实模型目录或原生错误，而非瞬时的 `!preparing`。因为隔离 QA 原生窗口需要显式白名单，测试时由临时 `_shots/ra-core-20261123/fusion-qa-window-watcher.mjs` 验证路径属于本轮 QA 后登记，测试完恢复原白名单。配对浏览器报告：`_shots/browser-tests/2026-11-23T10-31-46-288Z-linux/report.md`：连接/目录/创建/导航/管理/停止 **6/6 passed**；`_shots/browser-tests/2026-11-23T10-34-06-334Z-linux/report.md`：连接/目录/创建/主 Agent 原生回复/真实单子任务派发-审阅-交付/停止 **6/6 passed**，任务 1/1、工作 1/1、cleanup.errors=[]。**仅单子任务闭环通过**，复杂并行/返工/预算需继续验收。
- **文件与终端**：`_shots/browser-tests/2026-11-23T10-37-04-576Z-linux/report.md` 17 passed、1 failed（旧 Office 文件路径 ENOENT）、3 blocked、3 not-run、2 manual；实际测试 9 个终端及 6 个会话清理无错误；用仓库既存的 Word/PPTX/XLSX 真实文档及明确 token 改成 `_shots/ra-core-20261123/v524-real-office-fixtures-targets.json`，`_shots/browser-tests/2026-11-23T10-41-13-159Z-linux/report.md` Office 正文/下载 hash **passed**。
- **会话和设置**：`_shots/browser-tests/2026-11-23T10-42-06-881Z-linux/report.md` 31 passed、1 failed（语言切换页面 reload 时测试未等待）、1 not-run、cleanup.errors=[]；`scripts/browser-tests/blocks/client.mjs` 已等待语言 reload 和重连，再跑 `_shots/browser-tests/2026-11-23T10-52-20-304Z-linux/report.md` **passed**。
- **Codex 生成实际验收**：`_shots/browser-tests/2026-11-23T10-53-19-940Z-linux/report.md`，8/8 passed，含 fork、卡片发送、长文本、纯图片消息、队列编辑/交付/立即发送/停止，cleanup.errors=[]。
- **压力**：混合压力 `_shots/browser-tests/2026-11-23T10-57-19-222Z-linux/report.md`：6 passed、1 blocked（Cursor 无 long 会话）、2 failed（Cursor B 基准导航超时、Devin B 选中旧 session_locked）。Cursor 独立 3 轮/10 轮 `_shots/browser-tests/2026-11-23T11-01-26-319Z-linux/` 与 `2026-11-23T11-02-02-042Z-linux/` 均通过。Devin 测试改为创建本轮有归属的 B 会话，独立 5/10 轮 `2026-11-23T11-03-56-520Z-linux/` 与 `2026-11-23T11-05-13-506Z-linux/` 均通过。**混合压力原始失败不抹去**。
- **OpenCode QA**：原机器 `/home/lihe/.opencode/bin/opencode` 为 v1.15.5，未修改。另建 `_shots/ra-core-20261123/opencode-local-qa` 作为独立 XDG 数据、配置、cache、state 和独立最小 Git workspace；挂载隔离 OpenCode 4196 到 RA QA 3949，绝不连接真实 4096 或生产 OpenCode DB。旧服务在 Git RA 根初始化时卡住，独立 Git 根解决。隔离本机 native seed A/B 两个真实会话及 `_shots/ra-core-20261123/v524-opencode-own-real-session-targets.json`。初次 QA 测试误用旧 A/B 目标已停止并精确清理浏览器锁；第二次 native QA 测试进程因没传 `OPENCODE_URL`，归档/原生目录校验误连默认 4096，且模型尚无默认项；正确运行 `OPENCODE_URL=http://127.0.0.1:4196 npm run qa:browser ...` 后 `_shots/browser-tests/2026-11-23T11-24-37-537Z-linux/report.md` **6/6 passed、cleanup.errors=[]**（归档、创建原生空会话、模型读取与切换等）。
- **OpenCode 真实生成**：v1.15.5 免费模型请求被原生服务拒绝：`OpenCode 1.18.0 or newer is required to use the free tier`，`_shots/browser-tests/2026-11-23T11-25-42-724Z-linux/report.md` 原始失败保留。已从 `https://github.com/anomalyco/opencode/releases/download/v1.19.6/opencode-linux-x64.tar.gz` 只下载到 QA 目录，SHA256 校验 `47734e08968b30cc22a0bffb6d9feeed76ad4aa743213a12122040392d09a057` 与官方 GitHub API asset digest 一致；QA 独立二进制 `_shots/ra-core-20261123/opencode-local-qa/releases/v1.19.6/opencode` 返回 1.19.6。**系统原二进制仍 1.15.5**。目前 QA OpenCode 4196 已切为该版本、免费模型 `opencode/mimo-v2.6-flash-free`，QA Relay 3949 仍指向 4196，**此刻的 v1.19.6 生成验收正在运行**，日志 `_shots/ra-core-20261123/v524-opencode-1196-real-generation.log`，报告以实际生成完成后为准。
- **当前服务（动态 PID 以实际监听为准）**：正式 Relay 3939；隔离 Relay 3949；配对 Chrome CDP 9335；OpenCode 测试 4196。不要无理由重新配对、不要改正式浏览器或生产数据。可恢复现有 QA 运行的只读指令：`ss -lntp | grep -E ':(3939|3949|4196|9335)\\b'`、`git status --short --branch`、`tail -35 _shots/ra-core-20261123/v524-opencode-1196-real-generation.log`。
- **未解决且必须如实报告**：真实第二台实体 B 中继现地址未知，旧 trycloudflare 临时 URL 已不可解析；Desktop Commander 只配对 A；无法冒充物理双机验收。Devin 原生生成依旧无法取得助手回复（旧 120s/70s 失败），需要真实原生服务错误诊断及重新验证。普通已存在 Codex 线程的动态工具 M3 无热插拔协议，不能宣称完成；Windows/Android/iOS 真机、复杂 Fusion 并行/返工/审批/通知等仍缺实测。上一轮截图 `_shots/ra-core-20261123/ui-v524-codex/` 有三张真实 500x757 v524 中文图及 manifest，未生成第四张操作弹层。

## 2026-11-23 · v525 20:48+ QA（最新续接）

- 在当前配对 Chrome CDP9335 + 隔离 Relay3949 复核 `npm run check`、`git diff --check`、`npm run qa:browser -- --list` 全部通过，隔离版本 v525。正式 Relay3939 仍运行原版本，没有提交、合并或发布。
- `models.read/codex`：原生空 effort 菜单显示“这个模型没有可选的思考强度”，旧测试过强地要求 `capabilityState` 同时变化；现按原生 UI 可见状态及返回控件检查，`2026-11-23T12-13-05-790Z-linux` 3/3 passed。
- `Devin composer.send`：之前旧窗口白名单指向已关闭 native Electron window。临时将经验证的 QA Devin Editor 窗口加入**隔离白名单**后，`2026-11-23T12-24-55-943Z-linux` 3/3 passed，原生 ACP 确认真实 `user_message/agent_thought/agent_message`。验证后白名单恢复，隔离测试种子按 native ID/cwd 真正删除。之前历史失败仍保留，不代表任意旧窗口恢复可用。
- OpenCode 1.19.6 独立 4196 测试与原生 Cursor Fusion 的原始成功报告详见 `v525-coverage-audit.md`。Code/OpenCode 命令与权限测试 `2026-11-23T12-29-18-972Z-linux` 7 passed；Codex 生成中 A/B 导航及性能面板 `2026-11-23T12-30-47-511Z-linux` 3 passed；Codex 原生问题卡片问答 `2026-11-23T12-47-54-066Z-linux` 2 passed。
- **明确未通过（严禁改标通过）**：Codex `composer.codex-writer` 在 `2026-11-23T12-32-44-435Z-linux` 与 `2026-11-23T12-45-25-619Z-linux` 均失败（桌面已加载测试线程，但 RA overview 仍显示 `codex|backend|...` 而非桌面原生窗口）；后者 `runner.cleanup` 也失败。尝试在 `server/apps/codex.mjs` 中仅空闲情况下让后台 writer `releaseIdle` 向 native 路由转交，**复测仍失败，该未经证明的改动已按范围撤回**。不要重新应用未经验证补丁、强杀 Codex 或覆盖用户会话。手动 `thread/archive` 对第二个专属 QA 测试会话返回 active writer；桌面转到空白页面也未释放其写入权。两个专属路径均为 `_shots/browser-tests/.../projects/codex/writer`。首个测试线程经过 QA 重启后报告 `archived`，第二个 `01a20870-9d6d-7963-ac68-a2255a464b19` 仍无法确认归档。持续记录异常资源，不隐瞒；不要将其当作生产线程。
- 覆盖统计见 `_shots/ra-core-20261123/v525-latest-coverage-after-writer-investigation.md`：最近状态总214项，146 passed、27 blocked、1 failed、28 not-run、12 manual。统计时间比随后的 `questions.answer/codex` 成功略早；下一会话需重新聚合所有新报告，按最近的真实结果。
- 本轮 Cursor 生成分支使用的旧 `--targets` A 会话已不可读，`composer.card-send/cursor`、`composer.image-only/cursor`、`composer.queue/cursor` 等被标记 blocked，不属于产品实际执行失败。完成此轮 cleanup 后，先建立新的独立 Cursor QA A/B 种子，不要反复用不存在的 target。
- **仍无法完全发布**：物理 B 设备最新 Relay/Cloudflare 端点不可达且 Remote Desktop Commander 仅连接 A；Windows/Android/iOS 真机、第二物理机互控、复杂 Fusion 并行依赖/返工、Codex 已有线程 M3 动态工具热插拔的原生协议能力尚未验收。不允许把同机双 Relay 结果替代 B 实机。

当前隔离 Relay 3949 已重新从磁盘上已验证版本启动（最新 PID 2514518；每次先核对端口及进程身份），正式3939端口独立。当前 OpenCode QA 4196 亦独立。当前用户可见最新版为 v525，**v525 截图未制作**：`capture-v525.mjs` 出于安全保护在原 UI 有项目筛选时拒绝导航；v524 真实三图仍在 `ui-v524-codex/`。

建议续接优先：结束当前 Cursor QA cleanup → 核对所有精确状态 → 如可安全创建并授权新 QA Cursor 会话继续写操作和压力；并设计 Codex 双 writer 原生路由/归属证明及可靠 cleanup（先根因，再修代码，再配对浏览器），勿强制归档仍被原生持有的会话。完成后再次静态/协议检查与统一配对浏览器回归。

## 2026-11-23 本次中断续接（最新，以本节和原始日志为准）

- 通过 QA 电脑实测确认 Cursor 之前 13:01/13:03 两轮分别 **3/3 passed、3/3 passed**，测试 cleanup.errors=[]；三个临时窗口确实全部关闭，QA allowlist 21→18 精确恢复。
- 最新 v525 Codex 截图脚本恢复原 Overview 项目筛选后，真实 Chrome 9335 生成 **概览、工作、设备三张 500×757 中文截图**，`ui-v525-codex/manifest.json` 核实 navigation/viewport restored，04-access 暂无安全入口未生成。
- 补测 OpenCode/Codex/Devin/Cursor 的 native PDF/Office 引用、真实 Codex apply_patch、OpenCode/Devin 原生问题、Devin 队列/图片/停止/导航/性能：各项原始报告见 `_shots/ra-core-20261123/v525-current-acceptance-20261123.md`；成功用例均无资源清理错误。Devin 两次临时种子与 Cursor 临时种子已按 native ID+c​wd 删除，QA allowlist 仍为 **18**。
- `composer.codex-writer` 旧用例误用 phone 后台线程冒充 desktop-owner，导致实际写入权未交接且产生孤儿 QA 线程。**修正测试前置条件**，需要桌面原生 owner 和原生 manager 创建 QA 线程；没有则 `blocked`、不再创建 phone 后台孤儿。最新 `_shots/browser-tests/2026-11-23T13-41-09-911Z-linux/report.md` = blocked，cleanup.errors=[]，不代表 writer 实际通过；历史失败和未归档 QA 线程保留。
- 浏览器 214 场景最新状态 **170 passed、32 blocked、0 latest failed、0 unrun、12 manual**；历史 2 个 writer 失败以及历史其它失败不可从审计中隐去。blocked/manual 无真实执行证据。
- 正式 3939 未修改、QA 3949/4196 独立，未提交/合并/部署。`npm run check`、`git diff --check`、`qa:browser -- --list` 均通过。
- 物理第二 B 的旧 trycloudflare 地址今日仍 DNS ENOTFOUND（公共域名可解析），Desktop Commander 当前仅 A 在线；Windows/Android/iOS、真实双机 A→B→A、复杂 Fusion、Codex 旧线程动态工具无法 hot-plug 均不达发布条件。**不要宣称全功能验收完成**。
- 续接从 `_shots/ra-core-20261123/v525-current-acceptance-20261123.md`、本节、Git diff 和实际当前设备状态恢复，不要重新执行已通过且未受修改影响的检查。

## 2026-11-23 · 双物理机连接恢复和 A→B→A 实测（最新）

- **B 实体机已通过 Desktop Commander Remote 接入**：`rong-MS-7E24`（A 为 `lihe-MS-7D94`），双方均在线；用户明确规定**禁止使用 B 的 Codex**，本轮完全遵守。B 的原 RA Relay3939、OpenCode4096 与运行中的 Cloudflare 隧道均正常，A 从 B 当前 tunnel URL 请求 `/url.json` 返回 HTTP200。
- **关键根因**：A 正式旧 Peer Workspace 指向 B 旧电脑 ID `f11ccaa1...` 与已失效的 trycloudflare 地址；B 的当前 RA peer ID 是 `5ffd2a2d4745a58b`。仅改 URL 不够，需重新核对当前身份/公钥并授权新工作区。
- 在**A 独立 QA Relay3949**及 B 实际 Relay3939，建立只限 B `_shots/ra-dual-host-qa-20261123` 的临时授权后，**真实 A→B→A 签名 inspect、跨机目录、文件创建/读/写/读回、路径越权拒绝403、重复创建409、远程终端开/发/读/中断/关共12项通过**。独立用 B 的 Desktop Commander 核对 B 磁盘真实文件被修改。B Codex 完全未用。
- **重放**：同一个签名 payload/nonce 首次200、重发409；**撤销授权**：B 撤销后 A 再读真实返回403。配对 Chrome v525 UI 完整执行“原会话→真实 B→工作区→显式激活→读取 B 文件→SUCCEEDED”且恢复原界面，`cleanup.errors=[]`；另验收撤销后 UI 连接/设备/工作/版本 4/4 passed。真实 B 操作截图已遮挡背景私人聊天，并保存裁切图。
- 测试结束，**已撤销 B 临时 grant，删除 A/B 此次 QA 公钥互信和 A 的 QA 绑定；删除 B 临时目录及测试文件**。B 端 grant=0，A QA B binding=0；正式 A3939、B3939、OpenCode4096 均未修改/重启。临时许可不应永久留在 B 的正式 Relay 上。**这不是生产绑定的正式迁移或发布**。
- 原始证据及剩余发布阻塞见 `_shots/ra-core-20261123/v525-physical-two-host-acceptance.md`，以及 `v525-real-b-action-result.json`、`v525-physical-b-replay.json`、`v525-real-b-revocation-result.json`、`physical-b-ui-evidence/result.json`、`_shots/browser-tests/2026-11-23T14-20-42-840Z-linux/report.md`。真实 B 反向 B→A、真实断线 UNKNOWN、PWA 跨机终端全部 UI 生命周期、复杂跨机 Fusion、Windows/Android/iOS 真机、Codex desktop writer 与旧线程 dynamicTools 仍缺实测。
- **后续接手**：B 现在通过 Desktop Commander 可远程检查，且用户不许使用 B Codex。需要新一次跨机测试时必须单独建立 QA 范围授权，不要复用已撤销的 scope；B 当前快隧道 URL 读取本机 `~/.agent-remote/tunnel.log`，不要使用旧文件中的失效地址。只在用户明确同意正式发布后考虑重配正式互控。

## 补充：B→A 反向真实双机实测（同日）

- 仅为反向 QA，使用 A **隔离** Relay3949 建立临时 Cloudflare Quick Tunnel，B 从实体机访问 A 临时隧道的 `/url.json` 返回 HTTP200；没有改 A 正式 Relay3939。B 源签名身份 `5ffd2a2d4745a58b`，A 隔离目标身份 `3358eb55ee7fa37a`。
- A 临时授权只允许操作隔离目录 `_shots/ra-core-20261123/reverse-B-to-A/workspace`，B 使用临时 outgoing Peer Workspace v2 绑定（没有注入任何 Agent MCP，没有使用 B Codex）。
- **反向验证通过**：B 签名 inspect 并读 A 的真实 README；B→A 创建文件、读取、保存修改、重新读取；远端 A 终端打开、发送命令、读取实际输出、关闭。共 7 个操作检查通过，并由 A 的独立 Desktop Commander 验证文件字节确实发生修改。
- **反向重放与撤销**：同一签名请求首次 200 且经 B 验签，重发返回409。A 撤销工作区授权后，B 再读实际返回403。
- 已删除 A/B 双方此次反向 QA 创建的 trust/binding，撤销 A QA grant，删除测试工作区和临时文件。临时 Cloudflare Tunnel PID 精确核对后停止，B 再访问该临时 URL 返回530（未继续暴露 QA Relay）。A 原正式3939和 B 原3939/4096均继续运行。
- **边界**：此项是 B→A 实际签名文件/终端协议验证，不等于 B 端手机 PWA 或 B 端 OpenCode Agent 的跨机规划/执行已验证。正式持久互控部署未实施，B Codex 未接触。

## 2026-11-23 · v525 接手验收与最新交接

**v525 尚未达到全功能发布标准。** 详细报告、原始测试命令、失败记录和截图见 [v525 接手验收报告](_shots/ra-core-20261123/v525-takeover-final-acceptance-20261123.md)。本轮以 A 隔离工作树 `refactor/v514-boundaries-20261122` / `2db4744` 为准。现有 88 个已跟踪修改与 27 个未跟踪条目保留，仅追加本文件及忽略目录证据。产品目录的 Git diff SHA256 与此前 v525 原始报告一致。B 的 `feature/ra-peer-tasks` / `2db4744` 及既有 benchmark 修改保留。

- **P0 Codex 桌面写入者实测通过。** A 的独立桌面原生线程由 `codex_vscode` 创建，桌面加载列表存在，独立 app-server 竞争写入返回 `already has an active writer`。Chrome 9335 绑定同一个桌面窗口，发送、同线程回复、权限切换及恢复、重命名等 13 项通过。旧登记脚本依赖当前 renderer 不暴露的 manager，仍记 blocked。原始临时脚本的 `projects ENOENT` 保留，专用窗口、QA 目录已另行核验清理。旧孤儿 `01a20870-9d6d-7963-ac68-a2255a464b19` 已在精确 QA 路径核对后取得原生归档回执，本轮线程也已归档。[写入者证据](_shots/ra-core-20261123/v525-takeover-codex-writer-browser/result.json) · [归档核验](_shots/ra-core-20261123/v525-takeover-codex-archive-verification.json)
- **P1 真实双机。** B 确认当前 ID 及指纹。真实 B 已签名完成文件写入，A 隔离回程丢失后 RA 保留 `UNKNOWN`。相同操作 ID 不重发，变更参数返回 409。重新打开原会话后可以查询原 ID并通过新签名读取核实 B 字节，原操作仍是 `UNKNOWN`。源激活和 B grant 各自撤销后均验证拒绝，B 实际读 403。双方临时权限、互信、绑定、终端及 QA 文件已清理。Desktop Commander 仅用于真实双机检查，B 的 Codex 全程未接触。[真实回执](_shots/ra-core-20261123/v525-takeover-physical-qa/result.json) · [B 清理](_shots/ra-core-20261123/v525-takeover-physical-qa/b-cleanup.json)
- **OpenCode 原生跨机仍不达标。** A 4196 在临时原生 MCP 注册后进入模型轮次，随后 HTTP 卡住且没有原生工具回执。独立 CLI 80 秒同样无工具回执。精确确认 QA 进程和会话后恢复 4196 原版本及配置，删除会话验证 404，临时 MCP 消失。优先在新隔离实例查首个模型响应和 MCP 工具执行，勿反复对共享 QA 实例发起同样的长任务。B→A 新 OpenCode 原生任务还缺 A 隔离 Relay 的可达入口，自动审批拒绝新建公网隧道，已有签名反向协议通过记录仍有效。
- **P2 Fusion。** 实际 Cursor 主控完成 3 个子任务，两个独立原生轮次重叠 4,533 ms，B 子任务经退回重跑并通过，依赖任务在全部前置审阅通过后启动，主控提交正式交付。原始高级脚本误识别含依赖标签的描述并退出失败，保留失败截图，独立持久记录可核实以上业务分支。工作台移除及窗口关闭已确认。跨电脑 Fusion、活动中取消后完整清理、重启恢复、审批和预算待验。[原生核验](_shots/ra-core-20261123/v525-takeover-fusion-native-assertions.json) · [原始失败及回执](_shots/ra-core-20261123/v525-takeover-fusion-advanced.json)
- **浏览器和平台。** 214 个登记场景为 170 passed、0 最新 failed、32 blocked、0 not-run、12 manual，通过率 79.4%。另执行连接、设备、工作及 v525 版本定向回归 4/4。登记统计和临时业务验收均保留各自原始状态。当前 QA 9335 未登记实际 B 原配对，另一套配对浏览器入口待提供。Windows、Android/iOS 真机及手机通知、权限、控制待验。v525 主界面、真实 B 跨设备及 Fusion 关系截图均有索引并做了隐私遮盖。
- **协议及环境。** 当前安装版本原生 schema 的 `dynamicTools` 仅在 `thread/start` 出现，旧线程动态工具尚无可验收实现。静态、导出、双向协议及目录清单通过，`scripts/page-exports.json` 的 diff 为空。A 正式 3939 为原 PID 144479，QA 3949 为原 PID 2514518，Chrome 9335 保持既有配对。A 隔离 OpenCode 4196 已恢复为 1.19.6，B 原 3939 和 4096 保持运行。提交、推送、合并、正式部署均为零。下一会话从本节及链接中的原始证据续接。
- **4196 自动重连缺口已定位。** 4196 健康后，3949 常规发现只查 `/global/health`，旧 SSE 断开后旧会话是 dormant，新会话未进目录。只读原生预览调用现有 `openCode.connect()`，目录恢复，旧／新样本使用同一浏览器用例复测均通过，新样本原生 404 清理。恢复操作已执行，自动重连的永久修复待审批。拟只改 `server/opencode/state.mjs` 的发现路径，并验证 4196 真重启后无预览即可恢复。[原始失败与通过索引](_shots/ra-core-20261123/v525-takeover-final-acceptance-20261123.md) · [前后对照](_shots/ra-core-20261123/v525-takeover-opencode-reconnect-diagnostic.json)

## 2026-11-24 · v525 续验收最新状态

**全功能发布门槛仍未达到。** A 隔离工作树为 `refactor/v514-boundaries-20261122` / `2db4744`。本轮仅改产品源文件 `server/opencode/state.mjs` 并追加本文。共有 89 个已跟踪修改和 27 个未跟踪条目，其他 Agent 原有工作保留。正式 3939 未重启或部署，无 Git 提交、推送、合并。[本轮完整报告及原始证据](_shots/v525-continuation-20261124/acceptance.md)

- **OpenCode 自动重连已修复。** 发现轮询确认原生服务健康后，异步复用已有的单次初始化来重建 SSE。A 隔离 4196 实际离线 6 秒，旧会话休眠，重启后旧会话与新会话自动进入 RA。期间无需预览或 attach，两个会话通过 14 条原生 OriginRef 断言并删除后返回 404。统一配对 Chrome 回归 5/5，静态、协议、单元和目录加载通过。[真实重启](_shots/v525-continuation-20261124/opencode-real-restart.json) · [定向回归](_shots/browser-tests/2026-11-23T23-39-00-864Z-linux/report.md)
- **A 可以通过原配对 RA 操作实体 B。** 用原配对入口认证 B 并在 RA 终端核对物理机。B 的 OpenCode 1.19.5 既完成原生 Qwen 回复，也在独立项目通过实际 RA 项目级 MCP 自主读、创建、回读测试文件，保留三份原生 call ID 与签名回执。这次 MCP 验收在 B 同机回环完成。B 的临时目录、授权、信任、密钥和绑定已回收，两个会话独立复查均为 404。B 的 Codex 全程未接触。[B 原生工具与签名](_shots/v525-continuation-20261124/b-mcp-run.json) · [回收](_shots/v525-continuation-20261124/b-mcp-cleanup.json)
- **Fusion 补齐三项实测。** 真实运行中停止取得主控和子任务的终态，并在 3949 重启后恢复同一停止态。另一轮在 Cursor 原生子任务执行中重启 3949，原生线程与轮次 ID 不变，结果含唯一验收标记并进入待审核，派工仍为 1 次。真实主控的计划进入等待用户状态，Chrome 确认同一计划后取得请求回执和持久记录。三个工作台已移除，六个专用窗口和残留 MCP 子进程均已清理，隔离白名单按字节恢复。[活动态证据](_shots/v525-continuation-20261124/fusion-live-restart.json) · [停止态证据](_shots/v525-continuation-20261124/fusion-stop-restart.json) · [方案确认](_shots/v525-continuation-20261124/fusion-plan-approval.json)
- **统计及待接手。** 214 个登记浏览器场景为 170 passed、0 最新 failed、32 blocked、0 not-run、12 manual。现已实测通过 Codex 原生桌面写入权，旧登记脚本仍 blocked。A 隔离 OpenCode 无 MCP 的首条原生回复仍超时，A→B 原生 OpenCode 尚未通过。B→A 隔离网络不可达，已有真实双机签名文件、终端和回执校验证据。优先解决 A 隔离模型响应与已授权的 A 私网入口，再验双机原生工具、跨机 Fusion、方案拒绝与修改、预算。Windows、Android/iOS 真机、手机通知和控制及普通旧 Codex 线程工具热插拔仍待验。禁止把同机签名验收计入双机模型结果。[统计与阻塞](_shots/v525-continuation-20261124/acceptance.md)
- **截图与环境。** 最新 v525 的概览、工作、设备、跨设备面板和 Fusion 运行／恢复截图已保留。截图后的浏览器视图和尺寸已恢复。保留隔离 3949、4196 和原配对 Chrome 供复核，无本轮后台测试进程。[截图清单](_shots/v525-continuation-20261124/ui/manifest.json)

## 2026-11-24 · 32 个登记阻塞项的最新复验

- **最新累计统计为 193 passed、1 failed、8 blocked、0 not-run、12 manual，共 214 项。** 原 32 条阻塞中 23 条通过，Cursor `stress.open` 从阻塞变为实际失败。31 条用原登记方式复测，另 1 条 Codex 桌面写入者以独立原生方式复测，12/12 通过，旧脚本仍 blocked。永久源代码和登记脚本沿用进场状态，允许复核已有未提交工作。[完整验收与原报告](_shots/v525-unblock-20261124/acceptance.md) · [逐项索引](_shots/v525-unblock-20261124/coverage.json)
- **同一 v525 独立浏览器已配对实体 A、B。** 用正常的临时入口邀请并核对短码。选择 B 后手机列表真实带签名发到 B，保留 A 当前会话。两边临时入口已撤销，既有入口清单一致。配对秘密只在本地私有 Chrome 与对应 Relay 之间使用，日志未留下配对链接和令牌。B Codex 未使用。A 隔离 3949 的临时来源配置恢复原值，正式 3939 仍为同一进程。[双机签名与清理](_shots/v525-unblock-20261124/dual-qa.json)
- **真实样本补验。** OpenCode 的 7 项旧阻塞已通过。真实 707 条消息的 A 样本通过分页、详情、布局和默认 20 轮压力，真实原生待办经过同源副本验证。B 原生生成的子任务与 PDF 引用在 A v525 导入复验通过。Cursor 新原生待办、子任务和 PDF 引用也通过。旧 Codex 父子会话原生可恢复，RA 目录仍未显示，已按原状态归档。[实际结果与样本](_shots/v525-unblock-20261124/acceptance.md)
- **剩余问题。** Cursor 长短会话压力两次复现，只收到 `attached ready=false` 后卡住。Cursor／Devin 候选样本未达到有效分页长度。Devin 与 Codex 尚缺部分真实待办和子任务样本。Devin PDF 试件等待助手标记 45 秒失败。Codex 标准命名的桌面写入者实测通过，旧登记用例修改待确认。另发现已有产品边界问题，RA 允许 80 字符标题，当前桌面扩展写入 60 字符截短值后，RA 因回读不一致报失败。[Cursor 导航跟踪](_shots/browser-tests/2026-11-24T00-04-43-016Z-unblock-linux/results.json) · [Codex 标准输入](_shots/v525-unblock-20261124/codex-writer-final.json) · [长标题边界](_shots/v525-unblock-20261124/codex-rename-length-proof.json)
- 临时配对、浏览器、原生测试窗口、A／B QA 目录、导入副本和本轮后台进程已回收。静态、协议、场景目录载入和 Git 差异检查均通过。正式部署、Git 提交、推送、合并均未执行。[最终环境](_shots/v525-unblock-20261124/final-environment.json)

## 2026-11-24 · Codex 桌面写入者与 Cursor 导航修复

**累计登记验收 195 passed、0 failed、7 blocked、0 not-run、12 manual，共 214 项，通过率 91.1%。** 原先 32 个阻塞已有 25 个通过。本轮统一定向复测 3 passed、2 blocked。全功能发布仍有阻塞。[完整报告](_shots/v525-final-20261124/acceptance.md) · [逐项统计与原始记录](_shots/v525-final-20261124/coverage.json)

- `scripts/browser-tests/blocks/composer.mjs` 的桌面写入者场景现在需要专用原生窗口、线程和 QA 根目录。正式运行器确认独立 app-server 收到原生写入锁冲突，14 条发送、权限和重命名断言通过。原生线程已归档。[标准场景报告](_shots/browser-tests/2026-11-24T00-21-26-206Z-linux/report.md)
- `server/apps/codex.mjs` 在桌面写入者路由提前校验标题长度。原问题会把 65 字符标题截短落盘后报告失败。60 字符完整落盘，61 和 65 字符均收到终态拒绝，原生标题回读保持原值。2 个定向单元检查、项目静态和双向协议、196 个页面导出及用例清单均通过。[终态回执](_shots/v525-final-20261124/codex-writer-verify.json) · [单元检查](_shots/v525-final-20261124/unit.log) · [静态结果](_shots/v525-final-20261124/static.log)
- `server/session/navigation.mjs` 的 Cursor 恢复路径将被动首屏读取放在原生焦点锁释放之后。诊断捕获到重新请求首屏与正在补充详情之间的循环等待。相同真实样本完成 20 轮长短交替和 20 轮快速 A/B，前者最慢 1,766 ms，后者始终确认最终目标。[失败时序](_shots/v525-final-20261124/cursor-relay-trace.log) · [真实回归](_shots/browser-tests/2026-11-24T00-16-12-600Z-cursor-verify-linux/report.md)
- 7 项登记阻塞为 Cursor 历史分页，Devin 历史、待办、子任务、PDF 引用，以及 Codex 待办和子任务。Codex 历史父子已实证能原生恢复，桌面刷新目录成功，RA 隔离目录仍标父会话为归档。父子及本轮种子已重新归档。新待办试件使用实际默认模式和 Plan 模式，均缺原生清单。下一轮优先查 Codex 会话目录对原生解归档的同步，另准备足以触发 Cursor／Devin 分页的历史 QA 样本。[原生补测](_shots/v525-final-20261124/codex-cards-report.json) · [原始断言与截图](_shots/browser-tests/2026-11-24T00-21-55-633Z-codex-cards-linux/report.md)
- B 当前真实隧道发现返回 200，公钥指纹与 A 配置一致，A 现有 Peer 预设地址已经过期。两边原互信及正式配对保留。A 隔离 4196 仍卡在首轮，45 秒内没有完整模型回复，专用会话清理确认 404。已有双机签名文件及终端、409、403、真实 A→B 回程 `UNKNOWN` 和同 ID 查询证据。后续需可达 A 隔离 Relay 的已授权链路及可用 A 模型，补验双机 OpenCode、自主跨机 Fusion。Windows、Android、iOS 真机、系统通知和控制及 Codex 旧线程工具热注册也仍需实证。[B 现行端点核对](_shots/v525-final-20261124/physical-b-discovery.json) · [OpenCode 原生探针](_shots/v525-final-20261124/opencode-model-gate.json)
- A 工作树 `refactor/v514-boundaries-20261122` / `2db4744`，89 tracked、27 untracked。保留所有其他修改。正式 3939 保持原进程，隔离 3949 已载入本轮修复，Chrome 恢复原可见概览，允许列表按字节恢复，无本轮测试后台进程。Codex 卡片试件的额外空线程也取得原生归档回执。七张最新 v525 脱敏截图及重要日志保留。Git 提交、推送、合并和正式部署均未执行。[Git 状态](_shots/v525-final-20261124/git-state.txt) · [资源清理](_shots/v525-final-20261124/final-environment.json) · [截图清单](_shots/v525-final-20261124/ui/manifest.json)

## 2026-11-24 · 双机重连、Fusion 审批及历史目录追查

**累计 195 passed、1 failed、6 blocked、0 not-run、12 manual，共 214 项，通过率 91.1%。** 新失败来自实际复现 Cursor 历史分页入口错误。两处源码改动已提出具体范围并按 AGENTS.md 等待确认。[本轮完整报告](_shots/v525-closeout-20261124/acceptance.md) · [逐项索引](_shots/v525-closeout-20261124/coverage.json)

- **Codex 子任务已定位到目录根因。** 实体 A 的专用桌面窗口打开已原生恢复的历史父线程，连接的桌面 RPC 能在原生目录首页查到它。RA 目录助手仅接受 renderer manager，当前真实窗口无 manager，返回 `ready:false`，历史父会话在 RA 仍标为归档。建议只改 `server/page/session-actions.js` 的本地目录 RPC 选择。历史父子均重新归档，窗口及允许名单已恢复。[原始失败与对照](_shots/v525-closeout-20261124/catalog-baseline.json)
- **Cursor 无历史入口问题已复现。** 真实样本最早可见项对应原生索引 0，RA 仍显示「更早消息」，点击后登记用例超时。拟改 `server/page/chat-extract.js` 和 `app/js/history.js`，用匹配到的原生历史起点控制入口。真实正向长历史仍缺合适样本。Devin 新 QA 的 SWE-2 Flash 也在实际发送后 50 秒无助手回复。Codex 新原生四阶段文件任务完成，未产生原生待办事件。[Cursor 原生日志](_shots/v525-closeout-20261124/cursor-history-proof.json) · [Devin 模型复验](_shots/v525-closeout-20261124/devin-live.json) · [Codex 待办实测](_shots/v525-closeout-20261124/codex-plan-native.json)
- **A 到实体 B 的当前链路通过。** 从 B 本机读取正在运行的地址，A 真机发现返回 200，签名文件读写及终端均成功。A 独立验 11 份原生签名，B 本机文件哈希一致，撤销后实际 403。A 隔离 OpenCode 的 `hy4-flash-free` 能返回首轮，两款实际模型在临时原生 MCP 连接后仍无工具调用回执。两次原生会话删除为 404，MCP 和 A/B 临时授权已回收。反向仍需要 B 可达的已授权 A 隔离入口。[签名验证](_shots/v525-closeout-20261124/peer-signature-verification.json) · [模型](_shots/v525-closeout-20261124/opencode-a-to-b.json) · [双方清理](_shots/v525-closeout-20261124/physical-peer-cleanup.json)
- **Fusion 同机真实审批补齐。** Cursor 主控在收到修改意见后，为同一工作发出新方案，拒绝后持久回执关联正确计划，零派工。先停止原生轮次后移除工作台，专用窗口、目录及 QA 子进程回收。实际 10 个候选均无原生报价，数字预算测试仍缺报价；跨机编排仍待验。[原生计划反馈](_shots/v525-closeout-20261124/fusion-review.json) · [原生停止与清理](_shots/v525-closeout-20261124/fusion-review-cleanup.json) · [预算条件](_shots/v525-closeout-20261124/fusion-budget-readiness.json)
- 静态、协议、页面导出和登记清单通过。A 正式和隔离中继、OpenCode 及配对 Chrome 保持原进程，允许名单按原字节恢复，临时夹具和任务回收。Cursor 关闭后留有一条零消息、零草稿的空缓存，原生目录无法确认其可清理状态，保留该缓存。本轮仅更新交接和验收产物，两个源码方案等待确认。[最终环境](_shots/v525-closeout-20261124/final-environment.json) · [空缓存核对](_shots/v525-closeout-20261124/cursor-cache-window.log)

## 2026-11-24 · v525 已确认修复及最终复测

**214 项累计为 197 passed、0 failed、5 blocked、0 not-run、12 manual，通过率 92.1%。** 当前 A 隔离工作树为 `refactor/v514-boundaries-20261122` / `2db4744`，89 个已跟踪修改、27 个未跟踪条目。原工作保留。本轮只改 `server/page/session-actions.js`、`server/page/chat-extract.js`、`app/js/history.js` 和此交接。正式 3939 进程、原配对与生产凭证保留，无提交、推送、合并或正式部署。[完整验收](_shots/v525-confirmed-20261124/acceptance.md) · [214 项索引](_shots/v525-confirmed-20261124/coverage.json) · [Git 状态](_shots/v525-confirmed-20261124/git-state.txt)

- **Codex 桌面目录和子任务。** 使用已连接的本地原生 RPC 进行目录及按 ID 读取，零字节旧 rollout 走既有原生路径核验。真实 QA 父线程恢复后首次进入 RA 目录，原用例随后真实复现子任务的裸 ID 路由错误。修复后按真实桌面窗口及子线程 ID 导航，原登记子任务通过且读到原生执行正文，父会话正文回归通过。两个历史 QA 会话已恢复归档，隔离目录也确认同步。[原始失败](_shots/v525-confirmed-20261124/catalog-child-routing-failure.json) · [真实复测](_shots/v525-confirmed-20261124/catalog-verify.json) · [归档核对](_shots/v525-confirmed-20261124/catalog-archive-check.json)
- **Cursor 历史页。** 用真实气泡 ID 记录首屏和响应页的历史起点。旧会话从原生首条开始时，浏览器隐藏「更早消息」，正文与执行详情照常通过。新独立 QA 会话四轮实际生成了 211 个原生头记录，原登记浏览器正向分页由 89 增至 181 条，4 条断言通过。96 个测试文件、目录及长会话已核实移除。保留了一条由原生切换自动产生、无消息、无草稿、无 QA 路径证据的空缓存。[旧样本与页游标](_shots/v525-confirmed-20261124/cursor-history-proof.json) · [真实长会话](_shots/v525-confirmed-20261124/cursor-live-long.json) · [原生清理](_shots/v525-confirmed-20261124/cursor-live-native-cleanup.json)
- **OpenCode A→B 原生任务实测。** A 的实际模型先通过内置工具和本地 HTTP MCP。之后使用本轮隔离的项目级 HTTP MCP 和 RA 已有的签名工作区协议，模型实际发出两次原生工具调用。B 文件落盘哈希独立核验，固定终端命令输出与提示符已验证，8 份回执独立验签；B 撤销同一 QA 授权后，A 实收 403。A、B 临时身份、绑定、会话、终端、MCP、文件及授权均回收。现行互控项目配置自动注册覆盖 Cursor、Devin，OpenCode 的常规入口仍待验。B→A 的签名文件和终端已有真机通过，反向原生任务仍需已授权可达的 A 隔离入口。[模型和签名链路](_shots/v525-confirmed-20261124/opencode-physical-b.json) · [B 清理](_shots/v525-confirmed-20261124/opencode-physical-b-cleanup.json) · [实际 403](_shots/v525-confirmed-20261124/opencode-physical-b-revoked.json)
- **剩余发布条件。** Codex 待办缺真实计划事件，Devin 历史、待办、子任务和 PDF 引用缺有效原生样本。Fusion 同机并行、依赖、返工、审批、交付、停止和恢复已有真实证据，跨机派工与预算上限尚待验收。Windows、Android 与 iOS 真机、手机控制及系统通知仍待验。普通 Codex 旧线程动态工具还需要相应原生协议和授权撤销验证。完整报告包含每项证据及前置条件。
- **最终复测及环境。** 211 个文件语法、双向协议、196 个页面导出、161 个导入及两项定向单元检查通过。实际配对 Chrome 的 v525 脚本哈希与当前代码一致，七张脱敏截图已存档，恢复浏览器视图及缓存设置。隔离 3949 已重载，既有 4196 和 9335 留给复核。产品导出快照按原字节保留，验收脚本、测试进程和锁已回收。[静态检查](_shots/v525-confirmed-20261124/static.log) · [截图](_shots/v525-confirmed-20261124/ui/manifest.json) · [最终环境](_shots/v525-confirmed-20261124/final-environment.json)

## 2026-11-24 · Devin 直连及 OpenCode 常规互控复测

**214 项累计 201 passed、0 failed、0 blocked、1 not-run、12 manual，通过率 93.9%。** A 隔离工作树 `refactor/v514-boundaries-20261122` / `2db4744`，89 个已跟踪修改、27 个未跟踪条目。既有修改保留，本轮只增改常规互控绑定和此交接。全功能发布仍有独立的实体设备、Fusion 跨机及预算条件。[验收报告](_shots/v525-native-followup-20261124/acceptance.md) · [全量索引](_shots/v525-native-followup-20261124/coverage.json)

- **Devin 四项定向实测均已通过。** 旧启动方式下，原生 ACP `session/prompt` 报 `-32022 / permission_denied`，先前无助手回复的情况为真实失败。QA 窗口按用户指定直连启动后，实际 SWE-2 返回原生 `end_turn`，真实 PDF 引用、2 项原生待办、真实子 Agent 均通过。两轮实际读文件生成 170 条原生消息，原登记历史在配对 Chrome 从 120 条加载至 170 条，四条断言通过。四个 QA 会话在原生数据库确认移除，专用窗口和目录已回收。产品既有两个 Devin 启动入口已带直连规则。[原生拒绝与成功](_shots/v525-native-followup-20261124/devin-acp-terminal-evidence.json) · [原始浏览器报告](_shots/browser-tests/2026-11-24T01-32-28-715Z-devin-live-linux/report.md) · [原生清理](_shots/v525-native-followup-20261124/native-cleanup.json)
- **Codex 待办按指示跳过。** 本机安装的原生协议定义 `turn/plan/updated`。831 条本机 QA rollout 无可实测的原生待办记录，前一轮四步操作完成也无该事件，登记为 not-run。[本机记录扫描](_shots/v525-native-followup-20261124/codex-local-plan-scan.json) · [原生协议](_shots/v525-native-followup-20261124/codex-native-turn-plan-schema.json)
- **OpenCode 常规自动注册修复。** `server/peer/workspace.mjs` 现在在互控工作区生成原生 `opencode.json` 的 `mcp.ra_peer`，复用已有受签名授权约束的 stdio 客户端，重开保留现有注册。A 的临时原生 OpenCode 确认从项目配置自动接入，真实模型调用 `ra_peer_read_peer_file` 并返回目标原生签名文件标记。既有配对 Chrome 的真实互控 API 和项目打开也通过，实际撤销后 403、删除会话后 404。本轮为本机双隔离身份验收，前轮 A→B 的实体任务另有原始证据。B→A 仍需 B 可达的已授权 A 隔离入口。[原生模型](_shots/v525-native-followup-20261124/opencode-peer-verify.json) · [配对入口](_shots/v525-native-followup-20261124/opencode-peer-browser.json)
- **发布与环境。** Fusion 派工协议当前将原生绑定建在工作台所属中继，跨机派工缺实体目标绑定。有效数字预算仍缺真实报价和计量单位。Windows、Android、iOS 真机和旧 Codex 线程工具的显式授权撤销待验。静态和协议检查通过，`scripts/page-exports.json` 校验一致，已保存当前运行 v525 的七张脱敏截图。临时 4197、窗口、锁和测试进程已回收。A 正式 3939、现有 OpenCode 4196、既有配对 Chrome 9335 均保持原进程，仅隔离 3949 重载本次修改。无提交、推送、合并或正式部署。[静态](_shots/v525-native-followup-20261124/static.log) · [截图](_shots/v525-native-followup-20261124/ui/manifest.json) · [最终环境](_shots/v525-native-followup-20261124/final-environment.json)

## 2026-11-24 — RA Connect v0.1 (ChatGPT)
- Added `cli/chatgpt-mcp.mjs`, `server/integrations/chatgpt/{tools,auth,local-files,session,dispatch,bridge}.mjs`, optional `RA_CHATGPT_CONFIG` hook in `server/index.mjs`, and `docs/integrations/chatgpt.md`. All changes remain in this isolated worktree, uncommitted; preserve pre-existing changes.
- Separate QA-only relay 3958 and private socket `/run/user/1000/ra-chatgpt-qa-20261124/bridge.sock` (0600). QA root `_shots/ra-chatgpt-v01-20261124/`; policy in `policy/policy.json`. Only approved QA workspace and exact OpenCode QA session are authorized, with expiration. Existing 3939/3949 and 4196 services unchanged; B computer and B Codex untouched.
- Local MCP: 15 checks passed, real disk round trip and durable replay verified. Native OpenCode submission ACK and exactly one native user message verified after client adapter fix. Model went into retry; QA session stopped and verified idle, full assistant response not verified. See `evidence/acceptance.md` and JSON evidence in the QA root.
- Verified official tunnel-client v0.0.21 and offline profile initialization. A local launch helper `connect-tunnel.sh` is ready; user must create and authorize the private Platform tunnel and enter restricted runtime credential locally. No actual ChatGPT plugin connected yet. Keep Desktop Commander until real ChatGPT acceptance. No production deployment, commits or pushes.

## 2026-11-24 — Cloudflare Gateway v0.1 local prototype
- User chose Cloudflare Workers Free + SQLite-backed Durable Objects as the preferred gateway direction. Implemented `gateway/cloudflare/{worker.mjs,protocol.mjs,device.mjs,wrangler.jsonc,README.md}` in the isolated worktree. No commits/push, no production RA changes, no B operations.
- Prototype deliberately loopback-only (workers.dev and preview URLs disabled) and read-only. Stateless MCP JSON responses; HMAC signed/connection-bound messages; device/user tokens separate; WebSocket Hibernation API wired; local RA Connect socket and live pinned workspace/session authorization reused. This is not production OAuth or a public plugin.
- Installed isolated Wrangler 4.167.0 at `_shots/ra-cloudflare-gateway-v01/toolchain/`. Local Worker+DO 8797 → actual A RA Connect socket/3958 → actual QA file and OpenCode session reads. Twelve grouped checks passed, including independent hash readback, invalid auth and role token rejection, write/send refusal, scope/traversal denial, live local grant revocation/restoration, offline error and fresh reconnect. Evidence: `_shots/ra-cloudflare-gateway-v01/local-gateway-acceptance.json`. Real hosted hibernation/billing and cloud/ChatGPT connection not tested.
- `wrangler whoami` confirms not authenticated; user must authorize Cloudflare account in browser using the isolated Wrangler `login` command. No cloud deployment or paid upgrade. Next phase requires OAuth/MCP auth discovery and real per-user device registration/revocation and independent local authorization before allowing public endpoint; do not simply remove prototype loopback guard. Pro custom MCP write permissions remain a separate limitation.
- Cleanup of new local-only runtime was not confirmed: tool safety check blocked the compound cleanup command and process termination tool found no active sessions for the detached QA processes. Last observed Worker listener 127.0.0.1:8797, Wrangler PID 3083422, workerd PID 3083475, device PID 3084141. Runtime test tokens/config remain only in private ignored `_shots/ra-cloudflare-gateway-v01/runtime/`; treat as temporary credentials, never expose or reuse publicly. Prior RA 3939/3949/3958 and OpenCode 4196 remained unchanged. On continuation verify live identities before any cleanup.

## 2026-11-24 — 通用 RA MCP，直接 Cloudflare 穿透与原生配对
- 用户最终方案：ChatGPT+MCP 视为新的手机客户端；不要求 RA 账号，不强制使用 Gateway；直接复用现有 RA Relay、Cloudflare 穿透和 npm run pair → 原生电脑批准 → 可独立撤销的设备身份。手机原链路不变。
- 当前仅在隔离 worktree 新增 server/integrations/ra-mcp/authorization.mjs、server.mjs、tools.mjs，更新 server/index.mjs 可选（RA_MCP_PUBLIC_URL）MCP/OAuth 路由，并安装官方 MCP SDK 1.32.2、zod（package.json/package-lock.json）。未提交、推送或迁移正式 3939。B 未使用。
- OAuth：DCR、authorization code/PKCE S256、RFC9207 issuer、MCP protected metadata、token rotation；授权页直接复用 lib/auth.mjs 与 server/http/entries.mjs 原 RA 配对与 6 位确认。令牌仅保存散列至本地 DATA_DIR，撤销设备后 access token 即时 401，refresh token 无法恢复。支持只读和控制两个 scope。
- MCP 实际提供 list_devices、list_agents、list_sessions、read_session、send_message、operation_status、list_files、read_file、create_file、save_file、list_terminals/open_terminal/send_terminal/read_terminal/close_terminal。只有 OpenCode 原生发送真正通过；其它原生 Agent 的发送、另一台电脑发现/路由、其它 Harness 兼容尚待实现和验收。文件写入用 SHA-256 条件更新、独立持久 Operation ID。仅 QA 模式 RA_MCP_TEST_ROOT 限制会话、文件和终端路径，不允许跨出隔离根目录。
- 独立 A QA Relay 127.0.0.1:3961；独立 Cloudflare Quick Tunnel https://association-hills-wool-canberra.trycloudflare.com/mcp；QA 目录 _shots/ra-mcp-20261124，OpenCode QA 4196。新进程最后已知：cloudflared 3098239，QA Relay 3100657，需按进程和网络实际状态核验。正式 RA 3939 PID144479 及手机 Cloudflare PID145615 未重启，3949/3958 未修改。Quick Tunnel 地址随重启可能变化，生产需要固定入口。
- 真实 HTTPS OAuth + MCP SDK 认证/工具发现、模拟 QA 原有 RA 批准、文件 read/create/save 真正落盘并核哈希、OpenCode send_message 原生 Message ID 独立核验（没有重复提交）、RA 终端 open/pwd/read/close，50 条分组检查均过。进一步撤销真实 401 与 refresh 拒绝均通过。证据：_shots/ra-mcp-20261124/evidence/https-mcp-acceptance.json、https-mcp-control-acceptance.json、https-mcp-revoke-acceptance.json。所有自动批准的 QA 身份已全部撤销。注意：此为内部测试模拟批准，不是实际用户或 ChatGPT 亲自批准。
- npm run check 224 文件、91/84 协议、196 页面导出、171 imports 通过；qa:browser -- --list 通过。定向 Chrome 用例 connection.ready、overview.ra-devices、client.version 受阻（_shots/paired-browser.json 缺失），未计为通过，报告 _shots/browser-tests/2026-11-24T03-42-57-465Z-linux/report.md。不能宣称手机 UI 回归已经实际验收。
- 等待用户操作：ChatGPT Plugins → Add custom MCP server → Server URL https://association-hills-wool-canberra.trycloudflare.com/mcp，OAuth/DCR；OAuth 页面打开后在 A 运行 bash /home/lihe/adxr_ws/src/remote-agent/_shots/architecture-refactor-v514/_shots/ra-mcp-20261124/pair-chatgpt.sh，将完整手动配对码只填 OAuth 页面，核对桌面六位码批准，再在 ChatGPT 调用 list_devices、read_file README.txt。ChatGPT Pro 私人自定义 MCP 的 write/send 能力据官方文档仍受套餐限制，不能把写工具伪装成只读绕过。完成实际 ChatGPT 调用、手机 UI 和原生 Agent 验收后再讨论正式迁移。
- 完整操作说明 docs/integrations/ra-mcp.md。与原 Claude/Cloudflare Gateway prototype 区分：本版本直接使用现有 Cloudflare Quick Tunnel，不需要 Cloudflare Workers 或云端账号。

## 2026-11-24 — ChatGPT 插件创建后报 Error 的 OAuth 兼容修复
- 用户截图显示 Remote Agent QA 自定义插件已创建，但报错且详情页显示「网站不可用」。后者是网站元数据缺失，不等于 MCP 地址失效。
- A QA Relay 3961、Cloudflare Quick Tunnel 仍在线，公网 OAuth discovery 200、未登录工具执行此前返回 401。隔离 QA OAuth 数据中确实新增 `ChatGPT` DCR 客户端（约北京时间 11:55 注册，redirect host chatgpt.com），但尚无由真实用户批准的 QA 设备或 ChatGPT 完成的 OAuth token exchange。
- 根据 OpenAI 当前官方 Authentication – Plugins 文档，触发工具级 OAuth UI 需要逐工具 `securitySchemes` 与工具错误中的 `_meta["mcp/www_authenticate"]`。此前服务器强制对初始化/工具发现先返回 401，工具定义未声明 securitySchemes；此外 OAuth authorize 只接受单一 scope，ChatGPT 页面同时勾选 `ra:read` + `ra:control` 时会失败。
- 修复：server/integrations/ra-mcp/tools.mjs 为每个工具声明准确的 oauth2 scopes；server.mjs 允许匿名 initialize/tools/list 仅披露工具 schema，未授权 tools/call 绝不执行，返回标准 `_meta` 授权提示；authorization.mjs 兼容空格分隔的受支持 OAuth scopes 并保留作用域检查。仅 QA 环境用 RA_MCP_TRACE=1 记录 method/path/status，不记录 token/code/query。
- 实测公网匿名 MCP 初始化 200、tools/list 15 个包含 OAuth securitySchemes 的工具 200，未配对 read_file 返回认证提示 metadata（不访问文件）。现有 ChatGPT DCR client 及其 chatgpt.com 回调在双 scope OAuth 授权页面 200。新独立 QA 模拟配对/组合 scope/Token/文件真实读写 25 项通过，QA 测试设备随后撤销；ChatGPT 原 DCR 客户端登记仍保留。新 QA Relay PID 3114785，正式 3939 未改，Cloudflare 仍指向 QA 3961。
- 仍待：用户在 ChatGPT 内安装/选中 Remote Agent QA 并实际调用工具以触发 OAuth UI，手动运行 A QA 配对脚本核对批准。不能以内部模拟 QA 代替 ChatGPT 真实连通验收。若仍报错，查看 `_shots/ra-mcp-20261124/evidence/relay-public-authtrace.log` 中仅路径与 HTTP 状态，配合用户显示的具体错误定位。Quick Tunnel 非生产固定地址。

## 2026-11-24 — ChatGPT 真实 MCP 接口验收（2026-11-24）
- 用户已完成 ChatGPT 内 Remote Agent QA 插件的真实配对；实测 list_devices、OpenCode 会话读取和消息 ACK、文件真实创建/修改及 SHA-256 校验、终端命令执行与回读、错误 SHA/非法路径拒绝。由 ChatGPT 自己通过 RA MCP 发起，无 Desktop Commander 代跑。
- OpenCode QA 线程使用 opencode/mimo-v2.6-flash-free 托管免费模型，返回 Free usage exceeded，不能视作本地模型验收失败；该 QA 会话已 abort，RA 会话查询恢复 idle。
- 仅本轮静态 npm run check 和浏览器目录 --list 重新运行，均退出 0；没有重跑全量浏览器测试。既有 v525 登记为 201/214 passed、1 not-run、12 manual，全功能发布验收未完成。
- 详情和原始命令检查日志：_shots/ra-mcp-20261124/evidence/chatgpt-real-plugin-acceptance.md。仅修改此 HANDOFF 与 _shots 日志，不改业务代码、不提交/推送/迁移生产。

## 2026-11-24 — ChatGPT RA MCP 自主补验收
- A 隔离版 3949/9335：真实浏览器连接/中文上传/终端 3 passed，20 轮模型菜单压力 1 passed，ZIP/编辑/移动/下载 4 passed，真实 DOCX/PPTX/XLSX 预览和下载 1 passed；Fusion catalog 1 passed，4 个工作流场景受三种主控 Agent 未连接的前提阻塞。
- RA MCP 的交互式 PTY read 与命令回显通过。MCP send_terminal 的 Tab 字符不等于手机原生键盘。9335 是 Headless Chrome，A 没有连接 Android 真机，B 尚未独立 MCP 配对；12 项 manual 不能因这些局部检查自动改判。
- 详细证据：_shots/ra-mcp-20261124/evidence/chatgpt-assisted-manual-qa-20261124.md。未改产品代码、未提交/推送/发布、未动生产 3939。

## 2026-11-24 — ChatGPT 双机 RA MCP 真实验收
- ChatGPT 中两个独立插件 Remote Agent QA / Remote Agent B QA 已经实际调用，A 识别 lihe-MS-7D94 (428fb4a0224285fe)，B 识别 rong-MS-7E24 (9b2a56a931ba6134)；身份及隔离根目录不同。
- A、B 各自创建并回读 53 字节标记文件；经 ChatGPT 分别从 A 读取写入 B，从 B 读取写入 A，两方向目标文件 SHA-256 均与源一致，独立 Bash hostname/sha256sum 回读一致。两端远程终端分别创建、命令提交、输出读取成功。
- 两端错误 SHA-256 条件写入返回 FAILED，重新回读内容未被错误请求覆盖；正确哈希更新 SUCCEEDED。两端 ../ 路径逃逸被拒。A 用 B 的 operation_id 查询与 B 用 A 的 operation_id 查询均返回 operation_not_found。创建文件相同 operation_id 重复提交时得到同一原始成功回执。
- B QA 起初没有 Agent 会话，后来在 B 独立 QA 根目录通过原生 OpenCode HTTP API 新建独立测试会话；B RA MCP 随即 list_agents ready=true 和 list_sessions 发现。通过 B RA MCP send_message 原生 ACK (msg_20be2b0db001b0010e4df4c7a5)，read_session 实际返回模型生成 B_RA_AGENT_E2E_20261124_OK，busy=false；同一 operation_id 重放回执不变且消息未重复。A 先前 OpenCode QA Free 模型因额度问题未完成生成。
- 以上是真实 ChatGPT 协调两个独立 MCP 的 A→ChatGPT→B 与 B→ChatGPT→A；不是 A 内部 Agent 自主调用 B，也不是跨机 Fusion/Peer 流程验收。真机、撤销当前正式配对、断线重连及其他 Harness 尚未验收。隔离正式服务 3939 未改，未提交/推送。

## 2026-11-24 — RA MCP 自主跨机/授权/Fusion 验收
- 1 PASS：A OpenCode hy4-flash-free 原生模型通过 RA Peer MCP 调用 B 的 create_peer_file/read_peer_file，原生两项完成，B 文件独立哈希核验。详见 _shots/ra-mcp-20261124/evidence/autonomous-a-to-b-agent-proof.json。
- 2 PASS（B QA）：临时 OAuth 的 DCR/PKCE、只读拒写、Refresh Token 轮换、授权撤销、8 路并发读及同操作 ID 并发写成功；B 隔离 Relay 3962 真实重启后原 ChatGPT B 插件恢复，临时身份已撤销。
- 3 BLOCKED：Fusion 当前没有远程 RA Peer Worker Binding，QA 主控 Codex/Cursor/Devin 又未连接；现有 Fusion 不能做真正跨机派工/审批/交付。详情 _shots/ra-mcp-20261124/evidence/acceptance-123-20261124.md。
- A、B 正式 3939 未动；没有产品源码修改、提交推送或部署。

## 2026-11-24 — v514/v525 开窗策略差异与 B 本地模型反向互控
- 代码对比确认：普通 Codex Backend、已绑定 Devin 主要复用原生会话，Cursor 无安全现有项目窗口时存在 openFolder newWindow=true fallback，v514 和 v525 都有。
- Fusion 关键回归：v514 prepareProject 调 useProject reuseOnly=true，v525 改成 false，无法匹配窗口时可能创建并最小化新的 Codex/Devin/Cursor 窗口。仅创建 Fusion 记录不直接等于新窗口。QA 三种 Fusion 主控未连接，未实际点击验证三种真实开窗。
- B OpenCode 默认 strata/qwen3.8-flash-next-gyro-gyro-s 在临时 QA 本地服务自主使用 ra_peer_create_peer_file/read_peer_file 控制 A，两个原生 Tool completed，A 真正落盘、读回与 SHA256 核验，B 最终回复成功。临时授权撤销403，项目/会话/进程清理；未修改产品代码。
- 审查与证据：_shots/ra-mcp-20261124/evidence/window-reuse-audit-20261124.md。正式 A/B 3939 未动、未提交推送。

## 2026-11-24 — 隔离窗口复用与跨机 Fusion 统一回归
- 已修改隔离 v525：统一窗口安全复用再允许开新窗；Fusion 远端 OpenCode Worker 的 Peer 绑定/幂等请求/审批待办/清理及前端；A/B Peer 原生接口；B OpenCode Peer MCP 自动注册；Fusion 脚本 cache-bust。无生产部署或提交。
- A/B 静态检查通过；A 配对浏览器7项工作流及2项重载烟测通过、模型菜单20轮通过；新版本远端审批控件真实页面渲染和 HTML 转义通过。B 本地 OpenCode 完成远端任务、重复提交、权限拒绝和真实 bash ask→once→继续执行闭环。
- 实际跨机 Fusion 由 A 原生主控到 B Worker 再审核交付尚未通过（QA 主控未连接、这轮未有完整 signed Peer 互控授权）；窗口 Cursor/Devin/Codex 真机多窗复用分支、Cloudflare 新Tunnel地址恢复、数字远端预算仍需独立验收。既有201/214登记不可擅自改判。
- 完整报告：_shots/ra-mcp-20261124/evidence/unified-isolated-regression-20261124.md。保留正式 A/B 3939，所有更改留隔离工作树未提交。

## 2026-11-24 — 三项剩余问题收尾与 QA 证据
- 窗口：独立 Xephyr :98 的 Cursor/Devin/VS Code QA 真窗口各 1→2→1、原窗口保留；Cursor A/B 项目复用、忙碌/草稿拒绝通过。原生 Devin ACP 与 Codex QA 模型未认证，无法判 Agent 会话全通过。
- Fusion：A 实际 FusionRunner→B 签名远程 OpenCode→A 程序主控 review accept/cleanup 通过；细粒度读授权与真实 edit ask→once→写入→恢复通过，Peer 临时授权撤销 A 收到403。A 自主主控模型规划/审核尚未取得真实闭环证据。
- Cloudflare：两次独立 Quick Tunnel 换址实测均 HTTP200；Edge 已连时不因 DNS 传播循环换址；Quick URL 改变后外部 ChatGPT MCP 要更新 URL，固定地址需 Named Tunnel。
- 全部详细测试/清理/限制：_shots/ra-mcp-20261124/evidence/remaining-three-e2e-20261124.md。A/B npm run check及git diff --check通过。正式3939、原生正式窗口未动，未提交推送。

## 2026-11-24 — 任务级 MCP 接续修复（检查点）
- A/B QA Relay 3961/3962 已分别实际返回 25 个 MCP tools，原 15 全保留；本次 ChatGPT 会话仍只加载旧工具集合，须刷新两个插件并新建会话验证 `submit_task`/`get_task`/`read_task_output`。不得将只读工具伪装为写操作。官方刷新说明：https://developers.openai.com/plugins/deploy/connect-chatgpt 。
- 原 A/B 各 12 项任务集成证据在 QA workspace/ra-mcp-task-tool-result.json；A 真实 OAuth 19 项证据在 evidence/oauth-task-api-acceptance.json。A worktree/sandbox 路径审批 mock 回归新增 2 项，安全测试 9/9；日志 evidence/ra-task-security-worktree-tests.log，静态通过。B 先前任务级真实审批复测未完成（不要混同 Peer 原生审批已通过）。
- 本轮新增 server/integrations/ra-mcp/server.mjs 初始化 instructions，引导 Harness 优先完整 submit_task、get_task、read_task_output，ACK 非完成、UNKNOWN 不重发、审批须确切授权；A/B 文件 SHA256 一致（7a483d32308d34946f8b8d7533b2bc4840a75715e66d0bc87f95ec97d955fd75）。两台 npm run check 与 git diff --check 通过，独立临时 HOME/QA 数据目录、loopback HTTP 实际 initialize instructions / tools/list=25 / 无认证 submit_task 拒绝三项均通过。当前 QA Relay 未为此项重载，正式 3939 未动。
- 通过 RA MCP 整体派工而非 ChatGPT 逐条修改：A OpenCode QA ses_df3426797ffe6DKg31MhE082fV，operation d267e0cf-7187-4db9-afc0-2f6fb8c2fe81，原生 ACK msg_20ce8a7cb00154475bf9cbc67b，负责多 Agent 原生 cancel/approval 能力及回归；B OpenCode QA ses_df3257f9affeYEtbjNe63AIVdC，operation 4f81dd61-f74a-4d7e-8c76-f9cc4df71624，ACK msg_20ce7bd600012026e877d9d5e3，负责 B OpenCode 真机 task 审批、取消及 MCP 验收。当前均有实际原生工具调用，未取得终态，继续读取原生会话和各自验收文件；A/B 不并行覆盖同一产品文件。预期报告 A evidence/native-task-controls-resume.md，B _shots/ra-mcp-b/task-api-resume-acceptance.md。
- 未提交、未推送、未部署生产。跨机 Fusion 原生主控自主规划/验收、非 OpenCode 真机任务控制、实际客户端新版工具调用仍不可提前记为通过。

### 接续检查点补充（17:42）
- 已直接确认 A/B 当前运行 3961/3962 的 initialize 都包含新的 task-first instructions，原 ChatGPT 配对 list_devices 都正常（此前 QA 17:40 有实际 reload 记录）。A 24 项安全/native contract 回归通过（cancel-last-turn-regression.log），B 最新实际 12 项 task 集成通过（_shots/ra-mcp-b/final-task-api-real-12.log）。后续 A 多 Agent 修改仍在进行中，以上统计不覆盖其最终 diff。
- 独立验收阻塞：当前 A 候选 cancelNativeTask 并未将原生 stop 绑定到 task 的当前 turn；native_receipt 未在现有 stop route 消费，generic ACK 不足以判定本任务取消。详细 evidence/native-cancel-independent-review.md。向忙碌 A agent 追加说明返回 FAILED，未送达。必须在该 agent 完成后重新检查、补负向测试或禁用不能可靠关联的取消能力；不要同步/重载此未经验证的候选。
- B agent 仍 busy，未取得真实任务审批终态；报告待查。A/B 当前 local agent 两项原生任务未完成，不得宣称全量验收。用户需要 Plugins Refresh 两个 RA QA 连接、确认新增工具后在新会话调用；无需主动删除原配对。正式 3939、Git commit/push 不动。

## 2026-11-24 — RA MCP 任务级接口与多 App 适配
- A/B QA MCP 工具从旧15扩充到25（create/submit/start/get/list/cancel/approve/retry/task output + app capabilities）；真实 A OAuth/MCP 20/20 PASS、B OpenCode native 12/12 PASS、A/B 24项 mock/security PASS；旧 send_message 对 OpenCode 实测兼容；QA 两台配对持续有效，正式3939未动。
- Codex/Cursor/Devin 只能在 ready 且精确绑定已有 Native Session 时通过插件派工，缺真实 QA 原生会话不能判端到端 PASS；B task-level edit ask→once 尚未通过。A/B v525/v514 基线与实验性 native-apps 新版尚需 review/sync。
- 详见 _shots/ra-mcp-20261124/evidence/ra-task-mcp-final-handoff-20261124.md；未提交、推送或部署正式版。

## 2026-11-24 — ChatGPT 新版 MCP 实际验收
- 详见 _shots/ra-mcp-20261124/evidence/chatgpt-final-live-acceptance-20261124.md。双机 OpenCode 新建/复用/幂等/真实取消已验证；A 文件改写成功，B 工具调用停滞；A 审批候选 42/42，B 24/24，静态均通过。真实审批、其他原生 Agent、版本同步及正式部署未完成；不得宣称全量通过。

## 2026-11-24 — A_EXISTING_APPROVAL_FIX（OpenCode 已有会话审批）
- 定位真实缺口：任务 `e83ecdf7…` 的 `pending` 是字符串 `"approval"`，`get_task` 丢弃 `waiting_request`，`approveTask` 无法匹配 `pending.kind/id`；`987ce05c…` 新会话已真实写入 fixture，但单独审批仍需真实 ask。
- A 隔离源码改动：`native-apps.mjs` 从真实 OpenCode state 提取可验证 permission/question（`waiting_request` 细节 + `last_user_message_id`，project/session 精确匹配且歧义失败关闭），`tools.mjs` 透传结构化 pending，`tasks.mjs` 对 existing_session 在审批前校验最后 user turn 与请求未过期，并保持 unsafe 权限/`always`/通配符/符号链接全部拒绝；取消逻辑与另一会话的取消轮次校验未动。
- 验证：42/42 task/native 单测（新增 18 项契约）、`npm run check`、`git diff --check` 全通过。真实 4196 只读探测：最后 user message id 与任务 receipt 一致；真实待批 `external_directory` + 通配符越界请求被 `unsafe_permission_type` 拒绝、零 POST、状态未变。3961 未重载，源码尚未在 QA 进程生效；不碰 B/3939/用户窗口，未提交推送。
- 证据与限制（含非 OpenCode catalog 未 ready 原因、隔离 QA 窗口接入方式）：_shots/ra-mcp-20261124/evidence/existing-approval-fix-20261124.md。

## 2026-11-24 — A native-agent live acceptance
- Cursor/Devin QA windows on 9522/9523; Devin direct without system proxy changes. Real chat and file-edit via ChatGPT MCP passed (Devin extra LF). Existing stale Devin project/session binding remains an open issue; new explicitly project-bound ACP session works.
- Independent Codex 9524 created, actual sidebar sign-in screen confirmed; user login required. Original Codex 9224 and production 3939 unchanged.
- 42/42 contract tests, npm check, diff check passed. Still need native cancellation, MCP session creation/approval and Codex task acceptance; not full release acceptance.
- Detailed process IDs, task receipts, file checks and remaining issues: _shots/ra-mcp-20261124/evidence/native-final-live-A-20261124.md. No commit/push/deployment.

## 2026-11-24 A normal Codex reconnect / native task acceptance

See `_shots/ra-mcp-20261124/evidence/native-final-reconnect-acceptance.md`. A QA 3961 now uses normal Codex 9224. 57/57 contract tests, npm check, Cursor no-ID task live PASS; Devin native reply verified but task state still RUNNING; Codex native write verified but historical terminal state unresolved; strict cancellation and real approval remain unverified. No production deployment or B changes.

## 2026-11-24 host freeze and QA recovery

See `_shots/ra-mcp-20261124/evidence/host-freeze-20261124.md`. Rebooted A; previous kernel xHCI controller died near final QA log, earlier MCE and reboot BERT record; root cause unproven. QA relay 3961 restored with existing isolated data, new quick-tunnel URL in evidence/qa-public-url.txt (ChatGPT connector needs address update); production 3939 untouched. No native agents or benchmark restarted.

## 2026-11-24 native questions and permissions E2E
QA Devin Reject, Allow once and Cursor ask_question/BETA all passed with native proof. See _shots/ra-mcp-20261124/evidence/native-interaction-roundtrip-20261124.md; 165/165 isolated tests. Catalog create race and other platform controls still need final verification. Formal 3939 not touched.

## 2026-11-24 — RA core vs MCP layered cancellation
See _shots/ra-mcp-20261124/evidence/layered-devin-cancel-acceptance.md. Native Devin cancellation confirmed; shared RA mis-mapped cancelled to completed (fixed), MCP lacked exact read-only cancellation reconciliation (fixed). 233/233 regression and fresh real MCP cancellation PASS. Preserve existing phone controls; full phone UI and other unfinished cases remain. Production 3939 unchanged.


## 2026-11-25 — 发布验收继续（进行中，尚未发布通过）
- 当前A源仍为refactor/v514-boundaries-20261122工作树，基线2db4744，有大量已有未提交改动；正式3939未迁移。A/B MCP当前连通，B代码明显落后（约142运行文件差异/新增，最终需冻结重新比对）。B lib/auth.mjs QA DATA_DIR override和所有配对/运行数据必须保留；B根node_modules链接到正式依赖，禁止在该链接上npm ci。
- 已修A MCP OpenCode question对象options被String转换及校验失败：tasks/native-apps/questions统一labels+description+multiple/custom，支持原生question reject。真实task 0e7c81ee-27e2-44bd-9569-4ed6716e0888 经ChatGPT MCP回答BETA、收到per_20ff2023f001Qe7CcVEfDC7vDW edit权限并once批准、同task COMPLETED，文件字节/sha独立核对。证据 _shots/ra-mcp-20261125-question-fix 与 _shots/ra-mcp-20261125-release/opencode-real-question-permission.json。
- B旧tasks.mjs get_task会reject/abort其他session的permission，是发布阻断；A已经没有此逻辑。待最后A→B完整源码同步移除，不复制B旧实现回A。
- 已修共享Cursor运行状态：provider.focused曾覆盖data.status=generating，导致busy误报；agents/session-actions现在原生生成/终态优先，tabs合并保留running。MCP tasks/tools增加精确turn/receipt关联的公开assistant progress（不含thinking），output仍仅终态。24项定向、static通过，见 _shots/ra-mcp-20261125-cursor-state。尚待QA统一重载后的MCP确认。
- 原生Cursor task42f9696d-09fe-4e0f-bacd-fcbf4552a833曾实际读源码，但超过4分钟无新tool且17分钟无代码改动，已通过MCP精确CANCELLED，note native_cancel_acknowledged，operation b635a238-0d0c-4e41-a5c8-e6ce8bef1005。其release-loader-candidate-20261125未改源码。现由独立协作worker修主树composer.js realm fetch/cache/deadline；勿再提交原任务。
- 真实existing OpenCode reject验收task13061ac6-ae4d-47db-a8d0-9a58839cbce1在同session ses_df1a6d4faffe8PJB9TTj9G17Kj等待CONTINUE/STOP原生问题，尚未回答。暴露native-apps把OpenCode state.parts Map当array.filter，异常导致pending=null；最小Map转换已修、4项回归通过，尚未重载。证据 _shots/ra-mcp-20261125-existing-map-fix。重载后先get_task再reject exact request，不能凭旧pending补发。
- Fusion RPC候选在 _shots/ra-mcp-20261125-fusion-candidate，尚未合入。旧候选dispatchMessage后立即true缺真实native ACK、listener realm清理有风险，worker正在修。必须等更新报告再merge独立patch，composer role需叠到新loader，session-actions只合goal/stop不能覆盖Cursor状态片段。
- Native interaction候选正在补真实手机已支持但MCP缺失的Codex问答、Cursor多题/多选及可证明范围的once/reject；未完成，不能宣称通过。
- 最终配对浏览器registry已准备在 _shots/ra-mcp-20261125-release/paired-browser.json，复用主仓库原profile和relay-data绝对路径、候选isolate loader及QA native端口9522/9523/9224/4196。当前3949/9335尚未启动。本轮仍未执行统一全功能浏览器验收。官方full=190自动用例，另12stress+12manual；需分批串行有界监督，CLI自身必须同QA端口env，不要核对到正式实例。ChatGPT Browser扩展因本会话无origin browser context不可用；用户所指仓库既有配对Chrome身份文件存在。

## 2026-11-25 release continuation — native verification checkpoint (still in progress)
- Integrated native-interaction 6-file patch (63 targeted assertions) and current Fusion thread-scoped MCP 6-file patch; the earlier focused-view capture listener design was discarded. Combined syntax/protocol/page exports/import/assets checks pass. No commit/push.
- Actual Codex create found a further CSP defect missed by isolated fixtures: MCP adapter called loader in the outer realm, where realm.Function violated native CSP. Integrated 2-file exact-native-frame delta; no CSP relaxation. 9 targeted assertions and full static checks pass. Real task 0967a50d-167d-43e8-bfc2-83049964d88d now created/sent/completed in window 0924A7494F49DE653CEA68F7DFE4A046, thread 01a21037-4fe1-7a21-9f1d-0a2cdc784e25. Default mode returned TOOL_UNAVAILABLE for request_user_input; Plan-mode real check is ongoing.
- Earlier task c30171a2-9d42-47cd-9912-b5e5fdb07663 remains UNKNOWN and was not replayed. Read-only native registry proved CSP exception before native identity; no native thread/message recorded.
- Original Codex window CF81D7FAE0FE359A46660D2B5F62624B draft remains unchanged: 1632 chars, SHA256 a345be9197d17fac8d96a856abb86322d74f930e1869a220ad5dbf2ad5a3317b. One authorized fallback QA window was created. Its asynchronously restored 84-char old QA bootstrap draft was privately backed up and cleared only after exact window/root/hash validation; original draft unchanged.
- Real Cursor task abb610c7-6d59-47c0-8c2a-120d7aa6335f passed two-question/multiselect/freeform: ALPHA+GAMMA / QA_CUSTOM_CHANNEL, actual native completed output. OpenCode fresh rejected-question task 069fab57-0d3a-4017-851e-6e88ed34d8ed now CANCELLED with native_question_rejection_confirmed and exact request/tool/parent proof. Legacy rejected task 13061ac6-ae4d-47db-a8d0-9a58839cbce1 truthfully UNKNOWN without historical proof.
- Cursor permission once/reject real attempts did not produce native tool requests (TOOL_UNAVAILABLE, zero tool bubbles); not PASS. Per-user global approval settings were preserved. Codex command permission ACK remains unsupported until exact native decision evidence exists.
- OpenCode real history fixture completed 32 distinct native turns (no synthetic assistant messages), session ses_defcd9fbaffeHnc8T44tOK6KO6, all exact marker completions, 141 seconds total, per-turn deadline16s. This is pagination input, not 32 different feature tests. Evidence release/opencode-native-history.json.
- B first sync: 142 allowed runtime files, 46 new, full preimage backup/hash checks; auth/data/node_modules/tunnels/production preserved. B QA3962 PID1793360, actual computer9b2a56a931ba6134. Full static pass and MCP capabilities read pass. Two later CSP files still need delta sync after pending native approval QA. B local OAuth metadata421 is expected Host/issuer protection; public issuer metadata200 and local/url.json200 verified.
- A MCP QA3961 PID458868. Original paired Chrome restored using original profile (9335, target5A4A03A6457E6D2E1CE89876BF7A705B), paired QA3949 PID458705, v525 authenticated, no new browser identity. A computer3358eb55ee7fa37a. Old second card e884551bc8d2f567 points at local3957 old worker, NOT actualB. Normal native pairing of actualB is in progress; no token/keys copied.
- Final unified paired-browser full/stress checks NOT RUN yet; only startup and UI preparation so far. Do not claim releasable/all-pass. Remaining: Codex Plan question, Fusion actual native channel/receipt, actual A→B workspace/grant flow, final B delta verification, unified full UI+cleanup, truthful coverage accounting.
- Runtime evidence: _shots/ra-mcp-20261125-release/, csp-candidate/, fusion-candidate/, cursor-permission-live/, browser-sample-audit/. Prepared final target file release/browser-targets.json includes actual history/tool samples and existing office/PDF fixtures.

## 2026-11-25 10:13 CST — 原生回执闭环与最终浏览器前检查点
- 新增并合并：Codex private native_submission 保存完整 typed input（原始 prompt hash/真实message/turn/原生输入严格绑定，不对Markdown转义做模糊匹配）；publicTask与普通send_message不暴露私有输入。25定向通过。实际 Plan task f14418f0-28f4-4b66-a9d7-3f380bddafd6 经MCP得到ALPHA/BETA真问题、once回答BETA后COMPLETED；原生user-input-response-1的turn/request/answers/completed独立核对通过。独立task1f1b9b1d-7548-4f2b-83fb-81ee4837ff49在真LEFT/RIGHT问题前exact cancel，CANCELLED/pending:null，原生idle/request0/interrupted；父QA thread已恢复Default/high，permissions未变。证据 _shots/ra-mcp-20261125-codex-receipt-live/。
- Fusion三项实际适配缺口已修：新建空thread无rollout不能resume；pending MCP call只在runtime getConversation、不在持久化thread/read；当前canonical turnHistory直接存储、entries.value引用，后台会话此前无法读turn。均由最小独立patch合并。真实原生MCP transport在20.58秒通过initialize/toolslist、关闭重开同channel、准确工具归属、单次回复和72ms后真实消费hash；QA turn停止ACK且idle，恢复high。证据 fusion-candidate/fusion-mcp-live-20261125.jsonl、qa-success-restored-idle.json及fusion-runtime/offscreen候选报告。未以此代替跨机主控review/accept。
- OpenCode权限reject终态：真实错误tool/parent user/session/call和持久化本次reject ACK一起对账，精确证明才CANCELLED；旧无proof保持UNKNOWN。已合并14定向测试候选。原生取消后残留pending采用只读exact-aborted-request过滤，不删除原生Map、不POST、不处理其他session；14定向/真实A-B metadata通过并已合入。仍有一个真实集成缺口待查：reload后A long-history ses_defcd9fbaffeHnc8T44tOK6KO6仍catalog waiting approval、sendable false；task033edebb-9960-4ddb-86c6-89f247a3e994在preflight即UNKNOWN/session_not_ready_for_send，无native message、未重发。B agent查集成过滤，Q查明确未发送的FAILED分类。不能宣称已冻结最终版本。
- 组合静态 _shots/ra-mcp-20261125-release/combined-final-static.log：234 syntax、91 sent/84 emitted、196 exports、181 imports与assets全部通过；git diff --check通过。QA3961现PID520917，paired3949 PID521725，均已载上述组合。生产3939未改。新的paired restart脚本release/restart-paired-final.py精确验证registry/profile/data/owned manifest。
- 原配对Chrome9335/target5A4A03A6457E6D2E1CE89876BF7A705B已通过正常UI完成真实B配对并正常切回A，未复制身份密钥。A3358eb55ee7fa37a→B9b2a56a931ba6134的签名peer inspect通过；grant2a6913fa-bfaa-4dfd-8edc-8d2f9581f5fd限定B _shots/ra-mcp-b/workspace/cross-fusion-release-20261125。B agent保留grant。实际A原生主控→B worker→review/accept的配对UI脚本正在准备，尚未执行。
- B最终运行范围manifest源d2e6ab80ea2949912fca91eb0f9070e6ead73d48ee1bc845223a53f00e436eb3；508manifest/507同步范围，本轮delta13文件含2新增，备份/hashguard/零删除，B auth QA override及依赖/配对/tunnel/3939保持。B静态通过，3962正在重载/真reject双路径复验。
- 同一配对浏览器只读预检9/9通过（Cursor/Devin/OpenCode各card/body/models），报告 _shots/browser-tests/2026-11-25T01-58-13-974Z-linux/。这不是最终全功能验收；full190、stress12、manual12仍按真实范围记录。用户再次报告聊天连接中断；本次工具层明确一次exec context被替换，外部修改/进程和报告仍保存，不能归因于RA服务崩溃。

## 2026-11-25 10:59 CST — 最终浏览器前精确草稿回执修复
- A3961 PID559555、paired3949 PID559586、B3962 PID1808112 已载runtime manifest5391c3d0882c61989793825e2042045fa255d7a7dd1e1a688fcafd7aa254522d；B保留唯一auth QA override。生产3939与tunnel未改。
- 冷启动pending补齐和发送前FAILED分类均已通过真实A/B：A取消后的同会话新任务7.77s完成；负向project mismatch2.32s明确未发送、原生messages完全不变。B冷catalog、旧cancel后复用、两种permission reject、新cancel及再次复用均通过，有精确原生回执。
- Cursor/Devin的真实长历史已分别追加30/24次独立完成输入，供最终分页检查；这些是样本准备，不能当54功能通过。Codex model/list和settings已修RPC-only入口，真实模型/思考强度往返并恢复；Plan facts/变更计数14定向已通过，最终UI待验。
- actual cross ui1在旧codexPickerProps空manager处失败、无native发送；ui2使用修复后4.35s成功创建新run08b326e2-c5a7-4ca6-8309-37631a6abaff/thread01a2109d-1bfc-7ec2-b106-1c0cb32e422f，但draftACK比较错误：controller plaintext835字与UI一致，native serialized836字把_shots转义。send未点击，B无worker/目标文件，已正常UI停止并还原。Fusion正在最小分离plaintext draft与serialized native receipt修复，尚未合入。
- Codex command permission仍cap=false/native_permission_ack_unverifiable：原生协议缺本次decision+scope消费ACK；question已验证是独立能力。Cursor权限真实前置请求缺失，不能记为PASS。
- 最终统一配对browser full/stress尚未开始。driver release/run-final-browser.py已准备，单case100秒/准备收尾120秒watchdog，超时只停自有进程并精确清理原生资源。原9335target与配对身份保留。


## 2026-11-25 — 最新执行约束：收尾与增量验收（覆盖此前重复全量回归要求）

用户明确要求：已测试通过、此后相关代码未改动的功能不再重复测试；先锁定剩余修改与验证范围，停止无边界的修复/复验循环。本节优先于前文所有“再跑一遍 full/stress”的计划；历史证据保留。当前仅更新交接文档，未修改产品代码、未启动新的测试/Agent、未重载服务、未提交或部署。

### 0. 当前基线与问题归属
- 实际 A worktree: /home/lihe/adxr_ws/src/remote-agent/_shots/architecture-refactor-v514；branch refactor/v514-boundaries-20261122，HEAD 2db4744，仍有未提交修改。release/release-progress.json 最新记录 2026-11-25T03:03:38Z，加载 runtime fingerprint 5391c3d0882c61989793825e2042045fa255d7a7dd1e1a688fcafd7aa254522d；最终 browser run=false。本次核对记录而非重新启动验证，不保证现有 PID 此刻仍存活。
- 结构解耦不等于原生接口契约已隔离：RA adapter 负责 native session/draft/turn/request/receipt 的真实语义；MCP 只负责能力声明、结构化参数、授权和 task 状态/回执关联；Fusion 负责编排、peer grant、worker 及 review/accept；浏览器/fixture 是独立验证层。按失败的第一处契约定位，只有跨层契约实际改变才扩大影响范围，禁止借此启动新一轮架构重构。
- 当前关键阻塞来自 RA Codex adapter 的 plaintext draft 与 native serialized receipt 的语义差异，不是已证实的 MCP transport 或 peer 通信故障。release-progress 记载最新候选 review 已发现 background-controller regression；retained native document + official parser 仍在验证，不能认为候选已合并或通过。

### 1. 已有通过证据：保留、按影响复用，不机械重跑
- 双机 MCP 连接、任务级接口及原生创建/派工/输出/取消等按已有具体测试报告保留；不将单个 Agent 的证据推广到所有 Agent。A/B 最新真实 OpenCode cold catalog、cancel→reuse、permission reject、A 发送前 project mismatch 无副作用；OpenCode question/多种审批的已有精确原生证据均保留。
- Codex 原生 create/send/complete、Plan question BETA 消费、exact cancel、model/effort roundtrip、native Fusion MCP channel initialize/toolslist/reconnect/消费回执已取得真实证据；保留独立结论，不把 channel 验证当跨机主控闭环。草稿补丁只对受影响的 composer/send/draft/receipt 路径及其调用者做定向复验；不重跑无关 model/question/cancel/其他 Agent 流程。
- Cursor chat/multi-question/multiselect/freeform；Devin chat、原生权限 once/reject、取消的已通过记录保留。Cursor 权限的未触发原生请求不是已通过；Codex command permission cap=false 也不是已通过。
- 配对浏览器已通过 9 项只读预检（_shots/browser-tests/2026-11-25T01-58-13-974Z-linux/），OpenCode history 预检有独立报告（2026-11-25T02-14-48-577Z-linux/）。未变更的用例可引用原证据；Cursor 30、Devin 24 次 history 样本准备不是 pagination 用例通过。
- 证据源：_shots/ra-mcp-20261125-release/、_shots/ra-mcp-20261125-codex-receipt-live/、_shots/ra-mcp-20261125-fusion-candidate/、_shots/ra-mcp-20261124/evidence/ 及本文件历史。旧 PASS 只有能对应具体 case、代码/契约范围且未受后续修改影响才能计入；历史 v525 201/214 不直接视为当前版本全通过。

### 2. 剩余修改 / 验证清单（按顺序，禁止无关扩展）
- [ ] P0 Codex draft ACK：先查看现有候选、Git diff 与现有 worker 终态，不重复派相同任务。修复 UI plaintext 与 native serialized input 的精确分离，保留严格 message/turn/native receipt 绑定、原始 prompt hash、CAS 草稿保护。确保后台/非焦点 controller 可用；用含 _shots 转义、空草稿、多行及真实后台会话的最小定向用例证明修复；不得模糊匹配、放宽 ACK 或覆盖用户原始草稿。仅重验受影响的 RA composer、MCP send/receipt、Fusion 初始派工调用路径。
- [ ] P0 跨机 Fusion 真闭环：复用现有 A/B 配对、QA workspace、限定 peer grant（先确认仍有效）。A 原生主控自行调用工具、派工实际 B OpenCode、取得 B 真实输出、A review/accept、独立检查交付文件和清理。既有 signed peer inspect/channel 验证不重跑，除非该路径代码/权限契约发生变化。禁止以脚本替主控模型执行而声称自主闭环通过。复用现有脚本/fixture，不创建重复测试环境。
- [ ] P1 Cursor native permission：只在安全测试条件下做一次有明确原生请求前提的真实 once/reject 验收；此前 TOOL_UNAVAILABLE、零原生请求不是 RA 或 MCP 故障证据。若请求无法触发，记录 NOT_VERIFIED / 原生前置条件缺失，不无休止改 prompt 或重跑。只有实际出现请求而 RA/MCP 无法正确透传/消费时才修对应 adapter。
- [ ] P1 Codex command permission：目前明确 native_permission_ack_unverifiable，维持 cap=false，保留已验证的 Plan question 独立能力。只在取得原生 decision+scope 的可靠消费回执且最小改动可行时开放；否则文档和 capability 如实声明不支持，不做安全降级或猜测性批准，不重复尝试已证明不足的通用 ACK。若发布规格要求此能力，列为明确发布阻塞而非伪装通过。
- [ ] A/B 源码最终同步：只同步实际 runtime delta，核对 manifest/hash 和加载版本；保护 B auth DATA_DIR override、配对数据、tunnel、node_modules 链接、生产3939。只对同步改变的路径做必要 static/contract/目标端 smoke，不再重复 B 已验证的所有任务。
- [ ] 最终配对浏览器验收：沿用原配对 profile/registry/targets；先将 full190 + stress12 + manual12 映射为 case → 原证据/关联路径和共享依赖 → REUSE_PASS / RUN_REQUIRED / NOT_VERIFIED / UNSUPPORTED / EXCLUDED / FAIL。只执行未覆盖、受影响及确有必要的最小集成 smoke，按影响范围串行运行。Cursor/Devin 分页、Codex final UI 和其他尚无有效当前证据的适用项目仍需验证；manual 适用项不得自动标 PASS。无可用选择器则使用现有 runner 的过滤能力或最小 case 调度，不能直接重跑全部。Android/iOS/Windows 真机排除仍有效；其余按真实覆盖计数，不能用旧报告或 mock 替代真实 E2E。

### 3. 终止循环、超时、验收退出
- 以当前 Git diff、已完成报告、release-progress.json 和本节为唯一接续依据。保留 case 证据的源版本/相关文件、native receipt 或原报告定位；每个失败先判 RA / MCP / Fusion / 原生限制 / 测试夹具，再修最小范围。已有 PASS 且相关实现、依赖契约未变就复用；不要求同一功能重复通过多次，不为重复测试而修改代码。
- 超时按现有 watchdog（browser 单 case 100s、setup/cleanup 120s）或原生任务明确进度/期限停止自有任务；不停止正式/benchmark/其他用户进程。相同失败、相同版本、相同条件不得盲重试；仅修复相关代码、恢复确切前置条件或有新证据时才复验。UNKNOWN 不自动重发，先核原生回执。优先复用现有 Agent 会话/窗口，保护原始 Codex 草稿 SHA256 a345be9197d17fac8d96a856abb86322d74f930e1869a220ad5dbf2ad5a3317b。
- 达到发布候选：P0 均有真实闭环证据，实际改动已同步/静态通过，适用且受影响/未覆盖的验收完成，覆盖账本无未解释 FAIL；原生不支持、外部前置条件缺失、平台排除明确列出。若有必需能力未验证或失败，不得宣称可直接发布。最终一次汇总复用 PASS、新 PASS、FAIL、NOT_VERIFIED、UNSUPPORTED、EXCLUDED 和证据，不再开启无关改造。
- 只要求发布准备，不自行 commit/push/release/生产部署。后续只完成上述剩余事项，有新问题仅在阻塞既定发布能力时纳入，并在交接记录中注明原因。

### 2026-11-25 — P0 草稿修复已合并，跨机 UI3 暴露远端模型能力边界
- A/B 经 RA 插件完成六文件增量传输及哈希验证。冻结版本 db5b1e980790b8881b099ed7891b466ecccf52ba4a1c389f578f5d3c2e54c02c；保留 B QA auth override、正式 3939/tunnel/依赖。B QA 3962 PID 1815032 已健康重载（argv/env preserved），A paired 3949 PID 593676 已重载；A MCP 3961 PID 559555 尚需仅 QA 重载。
- 草稿证明 `_shots/ra-mcp-20261125-draft-candidate/real-native-draft-check.json`，合并 `_shots/ra-mcp-20261125-release/p0-merged-source-proof.json`；npm check/diff check 通过。真实配对浏览器 UI3 单次 native submit 回执已通过；不重复旧草稿、问题、取消等不受影响验收。
- 跨机 UI3 `_shots/ra-mcp-20261125-cross-fusion-ui3-db5b1e98/`，run e899f165-0d46-4a20-89e9-6d7f3af9a1b7，native thread 01a210b8-9978-77d2-9c35-870f9ddfb5bf。真实 main 创建 work 并 dispatch；第一次 effort 无效被拒绝，第二次 worker 71088ef2-52a3-4beb-8222-946c5253aef6 failed，relay 明确“远端模型不是当前原生已确认的默认模型，请先重新读取目标能力”。B 目标 proof 文件不存在；120s 流程期限到达，stop-confirmed。仅定位/修复远端目录与原生可执行默认模型不一致，后续仅复测这一跨机闭环。禁止放宽远端权限、跳过真实回执或绕过安全检查。
- 增量浏览器证据索引 `_shots/ra-mcp-20261125-release/browser-coverage-evidence-index.json`、初筛 `browser-impact-plan-pre-freeze.json`：214 项目录含201历史 PASS、1未有 PASS、12 manual；初筛96可复用候选、105需更精确改动影响/新证据确认，1无 PASS，9 manual，3真机排除。不得当作最终 PASS，也不得机械重跑 214 项。Cursor permission 缺真实原生前提，Codex permission 缺可靠决策回执，保持禁用/未验证。

### 2026-11-25 — 远端目录能力修复及真实 worker 进展
- A 三文件修改 `server/fusion/{remote-peer,runner,control}.mjs`：create_work/read_workspace 暴露目标原生确认的 remoteExecution；派工前校验远端 model/app/effort；执行时重新核对目标身份与工作区。B 原生真实模型 strata/qwen3.8-flash-next-gyro-gyro-s。未放宽权限，npm check/diff check 通过。冻结指纹 6b2fa986b5067757160113693268ae521ece56ed76cd86dc7e338b933956c998，B 3 文件增量 apply 通过、504 identical、保护项未改变、零删除，A paired QA PID 601369。
- UI4 `_shots/ra-mcp-20261125-cross-fusion-ui4-remote-model/`：实际 main work、remoteExecution、B native worker 真派工及 edit permission `per_210bfe4bb001rCVn0YY6fob8hh` 到 A 配对浏览器均已观察。测试 driver 未处理一次性审批，120s 后 stop-confirmed，B proof 不存在；不能判定任务交付通过。
- UI5 `_shots/ra-mcp-20261125-cross-fusion-ui5-scoped-approval/` 修验收脚本：只允许精确目标路径、精确 attempt/binding/native request 的一次性 edit；禁用 worker bash 需求，独立审计 hash。新主会话 c6c1623a-afec-44d7-a3de-4de6dafb2f4f 原生 CDP `Could not find node with given id`，Fusion MCP 两次 HTTP 404，未建立 work、未派工。需确认本次停止后针对 controller/native endpoint 恢复缺陷修复；不可把 UI4 的权限等待或 UI5 原生阻塞标记为已完成。不要盲重试或绕过授权。
- RA 插件完成本轮两次源码增量传输及检查，未调用 DC。下一步仅对实际新缺陷/受影响 case 验证；新增 runner `run-incremental-browser.py` 支持 case/app 精确筛选。A/B MCP QA 进程需仅限各自隔离端口重载。

## 2026-11-25 11:30 CST — 最终交接：由本机 Codex 接管（本节优先）

用户要求停止 ChatGPT 继续缓慢修改，由本机 Codex 完成剩余修复与发布验收。本节补充并覆盖上面的过时运行状态，不重复已通过的工作。当前仍不能判定为可直接发布。

### 0. 接手现场（先核实，避免双执行器）
- 主工作树：`/home/lihe/adxr_ws/src/remote-agent/_shots/architecture-refactor-v514`，Git HEAD `2db4744`，保留现有未提交改动，不 reset/checkout 覆盖。最新 A 冻结源码 manifest `_shots/ra-mcp-20261125-release/source-6b2fa986b5067757/manifest.json`，全树 SHA256 `6b2fa986b5067757160113693268ae521ece56ed76cd86dc7e338b933956c998`；本次只读核对全部 manifest 文件无哈希不匹配。相对 db5b1e98 新增的 delta 仅 `server/fusion/control.mjs`、`server/fusion/remote-peer.mjs`、`server/fusion/runner.mjs`，为远端模型能力修复；静态日志 `remote-model-capability-static.log`。具体 diff/设计先读同目录 `remote-model-capability-candidate/`。
- A 3949 配对 QA relay PID 601369 已重载，A MCP QA 3961 PID 559555 仍需核对/重载到最新冻结版本；A 正式 3939 PID 1416。B QA 3962 PID 1815032，正式 3939 PID 1389980；B 已有 `plan-6b2fa986b5067757.json`、`backup-6b2fa986b5067757-*`，**需核实 B 实际文件哈希及运行版本**，不能仅凭计划/备份判为已加载。B QA 根目录 `/home/rong/atest/remote-agent-mcp-qa-20261124`。不触碰正式服务、benchmark、真实用户窗口、配对凭据、tunnel、B auth DATA_DIR override、node_modules 链接。
- 交接时仍观察到既有另一条执行流：配对 Chrome profile 锁 `_shots/browser-tests/locks/de3ec67dfd018e68ed2a2447311c90ae5e65c6d0494fba7a9f380a1ad57b69a3.lock`，PID 604211，命令为 `_shots/ra-mcp-20261125-cross-fusion-ui5-scoped-approval/paired-cross-fusion.mjs --run-ui`。这是既有进程而非本交接新启动；先读其最新 driver.log/result.json、resources.json 和进程状态，确认终态/精确清理后才接管浏览器，禁止盲删活锁、重复派工、并行操纵同一 browser。交接不主动杀其他来源的进程。上一轮聊天中断后出现过不同调用流明确指定同一终端 ID 的现象；无证据证明 RA 错路由，也无证据将 ChatGPT 断线归因于 MCP/RA，注意避免两路同时写工作树。
- 原 Codex 草稿保护：1632 字符 SHA256 `a345be9197d17fac8d96a856abb86322d74f930e1869a220ad5dbf2ad5a3317b`；保留原窗口及草稿，QA 新建窗口仅必要时使用，不能清空/覆盖真实用户草稿。

### 1. 剩余修改（P0 优先，实际根因驱动）
- [ ] 跨机 Fusion 真闭环。UI3 的 remote model/default model 不一致已推动上述三文件修复；UI4 **已真实派至 B OpenCode，且 B 原生 edit permission 透传到了 A 的 pending**（attempt 22d97535-21cf-4e25-99cf-cf27d30abf45 / request per_210bfe4bb001rCVn0YY6fob8hh），但测试在 120s 时仍 awaiting_user，随后 stop-confirmed，未完成审核/交付，不能判通过。证据 `_shots/ra-mcp-20261125-cross-fusion-ui4-remote-model/{result.json,driver.log,events.json,resources.json}`。UI5 继续测试 scoped approval，交接时日志最后已观察主控 run c6c1623a-afec-44d7-a3de-4de6dafb2f4f 为 blocked、busy=false、tasks/works=0；最新终态须读取 `_shots/ra-mcp-20261125-cross-fusion-ui5-scoped-approval/`，结合真实 native tool error 判定原因，不能猜测或直接修改产品。若 UI4 卡点是验收器没有批准已获用户授权的隔离文件请求，则修验收流程而非 MCP；若 UI 中有请求但正确批准未送达，则按 request/attempt/worker 身份定位对应 Fusion/Peer/原生适配层。仅允许已授权 QA 路径内单次明确批准，不扩大 scope、不自动批准未知命令。最终要求：A 主控自主派工 B、真实 B 执行、需要时明确 scoped approval、A 收到结果并自主 review/accept、独立校验交付文件及 hash、停止/清理精确资源。禁止用脚本模拟主控替代真实闭环。
- [ ] Codex draft ACK：六文件补丁已合并（db5b1e98），原生纯文本/Markdown 转义/空行、后台读写与恢复已有真实证据，UI3 native submit 已确认；**不再从头修复**。仅核查最终运行版本与受影响浏览器/MCP 路径的回归；若出现新问题才作最小修复。证据 `_shots/ra-mcp-20261125-draft-candidate/real-native-draft-check.json`、`_shots/ra-mcp-20261125-release/p0-merged-source-proof.json`。
- [ ] Cursor permission：真实 once/reject 尚未验证，之前模型未产生原生请求（TOOL_UNAVAILABLE / 零请求），不是已证明的 RA/MCP 缺陷。用一次明确、隔离、可控的真实权限请求验收；无前置条件则标 NOT_VERIFIED，避免无限试 prompt。若出现真实请求但透传/消费失败才修。
- [ ] Codex command permission：当前 native_permission_ack_unverifiable、cap=false，原因是缺原生 decision+scope 可验证消费回执。Plan question 已独立通过；若能找到安全可靠的原生回执才最小修复开放，否则保持 UNSUPPORTED、准确文档/能力声明，作为发布规格所需能力的阻塞，不得靠模糊 ACK 或安全降级。
- [ ] A/B 源码与运行一致性：复用 release sync/restart 脚本及冻结 manifest，仅同步实际 runtime delta、保留 B 本地 override，核对对应 hash、服务健康、正式环境未动。最新代码 `npm run check`、`git diff --check`、QA 目录可列举；已通过的静态/定向证明可复用，不循环修改无关模块。

### 2. 剩余验收（用户要求最终统一配对浏览器全功能检查）
- [ ] 先完成 P0、确认版本冻结；再使用原配对 Chrome（9335、既有 profile/registry/targets），不要新建浏览器身份。已有 `_shots/ra-mcp-20261125-release/{paired-browser.json,browser-targets.json,run-final-browser.py,run-incremental-browser.py,current-browser-catalog.json,browser-coverage-evidence-index.json,browser-impact-plan-pre-freeze.json,linux-manual-coverage-ledger.md,fault-attribution-matrix.md}`。完整目录 214 项：full 190（70 read / 72 write / 48 generate）、stress 12、manual 12；Android/iOS/Windows 真机排除。最终统一全功能检查尚未完成，不能用增量证据索引或旧 201/214 直接代替；按用户原要求对最终冻结版本做统一检查与覆盖汇总。可分批、有界执行，避免无关重复；复用证据须明确对应 case、app、版本/改动依赖及本轮真实证据，未覆盖/受影响项必须实测。最终全量自动 suite 如需重跑，使用现有 runner，`full` 与 `stress` 单独执行；manual 按 ledger 实际验收，不可把脚本未执行计 PASS。
- [ ] 浏览器重点：Codex 最终 composer/draft/send/历史/模型切换/Plan/审批/文件变更；Cursor、Devin 真实历史分页（已准备 30/24 条样本，尚未完成最终分页实测）；四应用会话卡片、正文、菜单、切换/后台定位、权限/问题、会话和窗口归属；文件编辑/引用/Office/PDF/媒体/ZIP、上传下载/取消与重试；PTY/命令/终止/重连；Fusion 创建/模型/派工/审批/审核/交付/并行依赖/复用/停止恢复；A↔B、连接/通知/画面等 Linux 适用分支及压力测试。详细 manual 子项以 ledger 为准，不遗漏。
- [ ] 既有真实 MCP/原生已通过：四应用基本任务；Codex create/send/complete、Plan BETA 消费、精确取消、model/effort 往返、Fusion native MCP channel/消费回执；Cursor chat、多题多选自由输入；Devin chat、权限 once/reject 与取消；A/B OpenCode 权限/问题/取消后复用/冷启动及发送前 project mismatch 无副作用。既有浏览器只读 9 PASS 与 OpenCode history PASS 仅为预检；历史 201/214 非当前最终版通过。保留原证据，按影响范围复验。详见本文件前文及 `_shots/ra-mcp-20261125-release/`。
- [ ] 验收结束后核对所有 cleanup.errors、仅关闭本轮自有临时资源、原窗口/草稿/模型/effort/权限恢复，形成最终 case 级 PASS / FAIL / NOT_VERIFIED / UNSUPPORTED / EXCLUDED 台账和证据路径。未解释 FAIL、必需 P0 未闭环或真实前置缺失必须明确说明；不宣称全通过或可发布。

### 3. 执行边界
- 严格区分 RA 共享功能/应用适配、MCP 接入协议、Fusion/Peer、原生 Agent/模型限制、测试环境或 fixture 问题；先证据定位再改，不靠堆兜底或放宽权限。优先本机 Codex 直接处理，避免把完整任务拆成大量远程调用。遇到超时停止确切自有任务，核对 native 状态、操作 ID 和文件证据；UNKNOWN 禁止换 ID 盲重发。既有 browser watchdog 单 case 100s、准备/清理 120s；可按场景合理设置更短/明确上限，不无限等待，不误杀其他进程。
- 本次交接只追加 HANDOFF.md，未继续改业务代码、未启动新验收或新派工。Codex 先读取 AGENTS.md、Git diff、本节及最新真实报告；以实际源码/运行/证据为准。未经用户明确要求不 commit/push/release/生产部署。
- UI5 65s 无实际进展停止确认，B proof 不存在；B 最新 QA 3962 PID 1816792，健康，argv/env 与生产/隧道不变。增量浏览器结果 `_shots/browser-tests/2026-11-25T03-32-32-468Z-linux/` Cursor history PASS、Devin history fixture BLOCKED；`2026-11-25T03-32-41-573Z-linux/` Codex drafts 创建项目/信任超时 FAIL（未到草稿断言），Codex tasks fixture BLOCKED；runner 均已正常退出，不再盲重试。最终 release 仍未全量通过。
- A 最新 QA 3961 PID 607449 健康，生产及原始 Codex 监听保持；A/B 最终源码与 QA 重载均完成。全量发布验收仍阻塞，禁止标记 release PASS。

## 2026-11-25 CST — 本机续验及仓库边界（本节优先）

本轮用户指定继续处理正在修改的 RA/MCP 工作树 architecture-refactor-v514，并将写入和操作范围限于该工作树。现有配对 Chrome 9335 的 profile 和 3949 的 relay data 在外部 _shots/full-functional-20261102，B 在另一电脑。这一限制生效后，未重连配对浏览器、重载 relay、同步 B 或操作原生窗口。不能判为可直接发布。

- 产品候选 bcbde3cd19523903 已包含 Codex MCP 单次命令审批以及 OpenCode 原生默认模型修复。曾通过真实 Codex once 和 reject。一次允许获得原生回复及 36 字节文件哈希，一次拒绝读到精确原生轮次 interrupted、任务 CANCELLED、无落盘。两次审批回执均如实标记 UNCONFIRMED。证据在 _shots/ra-release-permission-20261125/codex-command-approval-proof.json。
- OpenCode 在原生只有一个连接供应商且未显式选模型时，采用该供应商目录声明的有效默认模型。配对浏览器已验证停止、生成中切换、统计、模型读取和真实问答。发送用例已取得发送回执、草稿清空及原生回复，重开会话时验收器误入另一项目。只有清理失败的 questions 测试会话仍存在，已在此前只读核实原生结束、无待审批。失败原始报告在 _shots/browser-tests/2026-11-25T04-10-27-869Z-linux/report.md。
- 修复验收器选择概览项目和处理轮次自然结束的时序。重新冻结 94b284285c7877549231d4584b996b65b2135af49fa56f8b26202190d89ace7e。相比 bcbde3cd19523903，只改 scripts/browser-tests/browser.mjs 与 context.mjs，产品运行代码字节一致。234 文件语法、协议、196 个原生页导出、场景清单与三组定向夹具通过，证据在 _shots/ra-release-permission-20261125/repo-only-{static,focused-verification}.log。验收器调整仍待原配对浏览器实测。
- 已有跨机 Fusion 单次权限、真实 B 执行、主控验收及交付哈希见 _shots/ra-mcp-20261125-cross-fusion-ui7-approval/{result,verified-b-native,cleanup-confirmation}.json。Codex 草稿、Cursor/Devin 真实分页可按台账引用。Cursor 测试工具确曾由原生调用，但没有产生待审批请求，独立 Cursor 配置需登录，once/reject 仍 NOT_VERIFIED。仓库内临时 Cursor 夹具已清理。
- 当前配对验收无活动 runner。_shots/ra-release-permission-20261125/paired-final-coverage.json 记录 113 项有通过证据、85 项待执行、12 项前置不足待验证、1 项失败待复验及 3 项真机排除。113 包含 85 项复用，不能称为最终冻结版全功能通过。需要在当前范围允许时对原配对环境和 B 继续验证，清理已有的精确测试会话及窗口，再产出最终台账。此前 B 只核对到尚无 bcbde3cd19523903 增量包，勿把前一版加载记录当作最新同步。

## 2026-11-25 14:10 CST — 既有 Cursor 窗口和配对浏览器续验（本节优先）

- A 隔离发布候选源码 SHA256 为 `5bca47f77b4e006520fceccd5eeb4433b760e5b125efca5bf22b9222ba9b8a38`，QA relay 3949，前端 v526。继续使用 9335 的原配对标签页。语法、协议、页面导出静态检查和场景清单加载通过。工作区范围保持在当前隔离仓库和明确的自有 QA 会话与窗口。未提交、推送或发布。
- 214 项覆盖账本有 119 项本轮通过、85 项复用、2 项失败、5 项待验证和 3 项真机排除。12 项自动压力均通过。10 分钟实测包含 61 次资源采样，RSS 从 324552 KiB 到峰值 516020 KiB，结束为 252876 KiB。完整证据见 `_shots/ra-release-permission-20261125/paired-final-coverage.json`。
- Cursor 在原有 QA 窗口验证任务、子会话、工具横竖屏及压力。修复子按钮向 RA 发送的会话编号，并更新前端资源版本。双窗实测发现第二扇原生窗口正文滞后，RA 配对页选择正确项目窗口并呈现新回复，切会话未串入。原项目、原 QA 会话和终端面板已恢复。
- Codex 桌面写入者在配对页通过真实提交、草稿清空、回复、权限切换和重命名。新版原生 `subAgentActivity` 已接入后台工具详情，真实子会话可内嵌展开。原生长会话从 60 条翻到 119 条。Codex 任务清单样本完成了回复，原生轮次未产生计划调用或计划事件。
- MCP Codex 的命令单次允许和拒绝均核对到原生实际结果，独立审批回执仍是 `UNCONFIRMED`。OpenCode 的单次允许、拒绝和过期按钮通过。Cursor QA 的原生 Run Everything 模式未产生权限请求。Devin 权限测试缺少可确定的原生新会话前置，未下发测试轮次。Cursor 全局设置切换与 B QA 同步仍待单独确认。
- 两项发布失败是直接目录上传丢失空子目录，以及高级 Fusion 并行用例未正式交付。浏览器验证中文文件、独立 ZIP 空目录往返、图片编辑和真实上传取消；Fusion 三项并行／有依赖任务均已验收，原生主控终态已核对，工作台三个绑定均清理。基础 Fusion 派工交付和此前真实跨机交付可按原证据复用。
- 其余待验证为权限组合、原生容量错误后的重试、系统剪贴板复制、混合压力子项，以及上述 Codex 任务清单。B QA 3962 最近读取的版本是 `4139e0cd841d170b`，仍需在最新候选下复验跨机。当前发布结论为未达到发布门槛。

## 2026-11-25 14:46 CST — 空目录与 Fusion 交付修复（本节优先）

- 用户批准两项修复。A 隔离 relay 3949 已加载候选 `a468fc3c168d834c906a8f9f3aa8108b9c909a91118751a39496c7f54109a9bf`，原配对 Chrome 9335 保持 v527。静态检查、场景清单、diff 检查通过。
- 文件传输读取浏览器目录句柄，借用原有签名上传通道发送空目录。既有配对 Chrome 已核对普通上传、整棵空目录、嵌套空目录及中文文件字节。无界面验收用浏览器 OPFS 的真实目录句柄代入选择结果，系统弹窗留待有界面复验。旧选择器仍列明 ZIP 保留空目录路径。报告 `_shots/browser-tests/2026-11-25T06-40-13-844Z-linux/results.json`。
- Fusion 审核与等待回执带上可交付工作入口。主控成功结束而工作确实可交付时，每项计划最多一次原生交付提示，正式交付仍走原有 finish 和证据校验。在真实配对页完成三个任务，A/B 原生时间重叠，C 依赖完成后复用 A。主控一次 finish，正式交付持久化，三个原生绑定已处理。本次真实轮次无需触发补发。旧失败状态重放确认仅补发一次，且未凭提示自动登记交付。证据 `_shots/ra-release-permission-20261125/fusion-parallel-v527-paired-result.json` 和 `fusion-delivery-reminder-state-replay.json`。
- 终端实际剪贴板复制通过，原剪贴板与临时本地浏览器权限已恢复。Devin 使用真实隔离会话读取成功，但原生无审批。小型 Codex 实际执行文件比较，原生无计划事件。末批媒体预览与原生工具详情各通过 20 次，零额外模型消息。
- 214 项覆盖账本有 205 项通过证据、6 项待验证、3 项真机排除。两个原失败场景已取得修复证据，综合手工场景保留部分覆盖。B QA 同步最新候选仍在既有授权范围之外，发布门槛尚未达到。最终证据见 `_shots/ra-release-permission-20261125/paired-final-coverage.json`。

## 2026-11-25 15:23 CST — B QA 同步、跨机端到端及剩余验收

- 获批后将最新 v527 源码冻结版 `a468fc3c168d834c906a8f9f3aa8108b9c909a91118751a39496c7f54109a9bf` 的 20 个变更文件同步到 B 隔离 QA。B 的 `npm run check` 和 3962 重启健康检查通过，B 进程由 1820091 换为 1834130。已核对配对数据、B 本地 auth 配置、生产 3939 和隧道均保持。B QA MCP 读取返回 OpenCode 可创建任务和处理审批。记录位于 `_shots/ra-release-permission-20261125/b-v527-sync-proof.json` 和 `b-v527-mcp-capabilities.json`。
- 同一配对浏览器上的最新候选已完成 A Cursor 主控到 B OpenCode 的真实 Fusion 流程。操作者只确认一个文件的方案，B 原生 edit 获一次性审批。主控正式验收和交付。设备 B 独立复查一次性审批已消费、写入和读回完成，无待处理审批，文件 SHA-256 与测试值一致，随后清理确切测试文件。证据 `_shots/ra-mcp-20261125-cross-fusion-v527-cursor/result.json`、`verified-b-native.json` 和 `b-proof-file-cleanup.json`。两次 A Codex 尝试达到无进展期限后停止，B 未收到这两次派工。A 的中止记录和 B 日志在相应的 final/retry 目录。
- 混合压力新增通过 A/B 配对入口五轮往返、真实 Fusion 关系列表与任务详情 20 次往返和浏览器录音转录。音频是写入虚拟麦克风的 QA WAV，浏览器通过实际 MediaStream 与 A QA 语音服务转录回填草稿，无自动发送。沿用此前的 12 项自动压力、10 分钟资源采样、媒体及工具详情各 20 次证据。
- 本轮 Cursor 在原有 QA 窗口临时使用 Allowlist 沙箱，读取发生且原生没有发出审批事件。Devin 新建 QA 会话切为 Ask，真实发送后未获得审批或预期读取结果，已确认空闲并清理。两个模式均已恢复。保留 OpenCode 的通过证据与 Codex 真实动作及独立 `UNCONFIRMED` 回执。
- Fusion 真实点击「要求修改」已持久化。主控空闲时，`plan_feedback` 仍待送达，调度器只响应等待中的工具请求、待审子结果和可交付工作。此处新修复已另行请求用户确认。服务端隔离回放覆盖修改、拒绝、过期、预算拦截、返工同 Worker 和持久化。用户指定暂缓原生任务清单和自然容量不足重试。
- 同一真实 Fusion 工作项在显式续接后生成二版方案。A QA 3949 从 862545 重启到 916156，配对页恢复二版方案的原 ID。拒绝经持久化核对，始终零派工。跨机验收使用的工作台和 B 端确切文件已经清理。冷启动发现已归档的本轮测试会话使浏览器卡在 `restoring`，服务器已接受设备鉴权。只清理此条 QA 恢复记录后，原配对重新通过认证，未重配或清理其他记录。
- Linux 系统目录选择器验收通过。临时使用原有 QA Chrome 配对配置的有界面模式，核对真实 GTK 选择和 Chrome 权限提示，分别选择中文文件加嵌套空目录，以及整棵空目录。两个目录都经实际签名上传落盘并回读校验。随后恢复原 QA Chrome 模式。证据 `_shots/ra-release-permission-20261125/os-picker-live-result.json`。
- 当前 214 项覆盖有 207 项通过证据、4 项待验证和 3 项真机排除。待验证中有两项按用户要求暂缓。发布仍受计划反馈自动续接、冷启动恢复和原生审批验证边界影响。详见 `_shots/ra-release-permission-20261125/paired-final-coverage.json`。
- 最后一次核对中，浏览器已恢复无界面运行，A QA 正常认证，草稿为空，无待发请求或测试锁。预算表单真实保存成功，Codex 超时前停在建工作、登记方案阶段，持久化记录是停止、已清理、零派工。独立 Cursor 返工尝试在读取当前窗口的原生模型候选时停下，未发送。Cursor 补充审批测试的 CDP 读超时也已通过原生回读核对，未收到测试消息，运行策略已恢复。新发现的产品代码未修改。本轮无提交、推送或发布。

## 2026-11-25 16:42 CST — 第 2、3 项及 B QA 最终复验（本节优先）

- 候选源码 `0f476737bccdd21f5f51cb4306e447fb2ccb3cad156f2cb16efa414d73066d03`，前端 v527。A QA 配对中继 3949 PID 1012072，A MCP QA 3961 PID 1012156，B QA 3962 PID 1847291。A、B 均通过 `npm run check`，A 的 `git diff --check` 通过。B 按受保护计划同步，并核对生产服务及隧道 PID、QA 配置和依赖。证据 `_shots/ra-fusion-feedback-fix-20261125/qa-final-reuse-sync.json`。本轮未提交、推送或发布。
- RA 修复了 Fusion 的空闲主控方案反馈调度，以及配对冷恢复等待退役调度器的问题。既有配对浏览器要求修改后，主控在同一工作项自动登记二版方案。A QA 重启后恢复同一个待审批方案，拒绝后始终零派工。用真实浏览器重载核对了冷恢复。证据 `paired-plan-result.json`、`native-scheduler-audit.json`、`cleanup-and-cold-start.json` 和 `ws-recovery-replay.json`，均位于 `_shots/ra-fusion-feedback-fix-20261125/`。
- Fusion 预算真机验收中，已设置的显式预算拦截了费用无法核对的派工，任务、分配和执行副作用均为零。跨机真机检查另发现逻辑 Worker 虽已复用，旧 RA Peer 每轮仍新开原生会话。已修复为凭同一授权和前序任务转交原生会话，区分两轮原生消息、回读结果和审批归属。旧任务不能停止后继轮次或删除后继正在使用的会话。修复后 A Cursor 向 B OpenCode 完成 `QA-WRONG` → 返工 → `QA-RIGHT` → 验收交付。同一原生会话 `ses_dee236648ffe3m7L1ReKgsDRkC` 有两条独立原生消息，B 独立核对同会话、首轮结果隔离和两次任务清理。证据 `_shots/ra-fusion-feedback-fix-20261125/` 下的 `paired-fusion-cursor-current-result.json`（仅取预算字段）、`fusion-native-reuse-before-fix.json`、`paired-fusion-native-reuse-final.json`、`b-native-reuse-journal-proof.json` 和 `peer-session-reuse-replay.json`。
- MCP 与原生审批。Codex 桌面命令的拒绝和单次允许都在实际原生执行项回读后成为 `CONFIRMED`。Devin 的单次允许和拒绝通过原生响应及文件结果复核。Cursor 新版终端 Allowlist 卡片已按当前线程、轮次和命令接入，真机适配器单次执行返回退出码 0。同一配对页点 Skip 后，精确原生记录返回 `rejected=true`，页面审批按钮消失。Cursor 全局策略与 Codex 临时会话设置均恢复，临时 Codex 线程已核对归档。Cursor 在该窗口新建 MCP 任务的前置验证受一个缺少命令检测器的既有终端限制，Codex 无桌面 CDP 的纯后台会话也不提供这条 MCP 审批路径。证据 `_shots/ra-fusion-feedback-fix-20261125/` 下的 `codex-desktop-approval-proof.json`、`codex-desktop-archive-proof.json`、`devin-approval-proof.json`、`cursor-native-adapter-live.json`、`cursor-paired-reject-proof.json` 和 `cursor-paired-reject-native-final-state.json`。
- 最新候选用原 Chrome 配对配置实际访问了 B QA 和 A QA，完成认证、概览与 Peer 协议检查。回到 A 总览后草稿为空、无待发请求。证据 `_shots/ra-fusion-feedback-fix-20261125/paired-ab-final-current.json`。验收台账 `_shots/ra-release-permission-20261125/paired-final-coverage.json` 的 214 项中，209 项有通过证据（125 项直接通过，84 项复用通过记录），2 项按用户要求暂缓（Codex 原生任务清单、自然容量错误触发的手动重试），3 项真机排除。第 2、3 项已通过本轮验收，全量发布台账仍保留这 2 项待验证。

## 2026-11-25 17:13 CST — Codex 后台 MCP 命令审批

- MCP 从当前后台轮次读取精确待批命令，单次允许和拒绝复用手机端的 Codex 后台应答服务。两端并发操作同一命令请求时只发送一份原生应答。桌面窗口使用原有审批适配器。
- 隔离 A QA 已更新。3949 PID 1055899，3961 PID 1056056。真实后台 app-server 和 MCP 工具分派器下，单次允许后命令执行且任务完成，拒绝后原生记录为 declined 且任务取消，两次审批都确认。临时原生线程已归档。静态检查及请求归属与并发应答回放通过。证据 `_shots/ra-fusion-feedback-fix-20261125/codex-backend-mcp-live-proof.json`。

## 2026-11-25 17:44 CST — 后台 MCP 复用手机应答服务

- 已补后台 Plan 问答、文件变更审批和额外权限授权。MCP 按当前线程、轮次、原生请求 ID 分派到手机端共用的 codexBackend.answer，应答前核对同一请求；手机和 MCP 并发只发送一份应答。额外权限保留原生当前轮次 scope=turn 并在待批字段 grantScope 显示。
- 真机隔离 app-server 与实际 MCP 工具分派器下，文件审批后独立回读内容正确，额外写权限拒绝后原生报告未获授权，Plan 问答返回 Blue。三项任务均 COMPLETED，临时线程已归档，测试文件已核对删除。额外权限工具仅在临时验收 app-server 启用了 request_permissions_tool。六条允许/拒绝协议回放及并发应答回放通过。
- A QA 已加载，3949 PID 1091113，3961 PID 1091195。既有配对浏览器 A 认证正常、草稿为空、无待发送。静态检查 234 文件及 196 导出通过。此次只影响单机后台操作。证据 _shots/ra-fusion-feedback-fix-20261125/codex-backend-operations-live-proof.json。

## 2026-11-25 — MCP 复用手机端 Agent 控制接口：执行方案与增量验收边界（本节为后续实施依据，PLAN ONLY）

**状态：仅制定方案，尚未按此节改动产品代码，也未执行本节的新功能验收。** 本次用户明确要求将修改与验证范围写入 HANDOFF；实际实施时遵守仓库 AGENTS.md 的变更授权、最小影响和不提交/不发布规则。当前检查基线为 A 机 `/home/lihe/adxr_ws/src/remote-agent/_shots/architecture-refactor-v514`，分支 `refactor/v514-boundaries-20261122`、HEAD `2db4744`；工作区含大量未提交改动与新增模块，禁止 reset/checkout/覆盖他人的工作。

### A. 目标、已确认事实及不可突破的边界

- **目标**：手机端与 MCP 取得相同授权、同一原生 Agent 支持该能力、同一会话与工作区条件满足时，执行相同的 Send / Steer / Queue / Stop、会话操作、Model / Effort / Fast、问答/权限审批及内容读取语义。不是让 MCP 伪装手机 WebSocket，也不是复制一份新的原生适配器。手机端已验证的操作行为是基准，默认不改变手机 UI、按钮语义或功能集合。
- **已存在的共享路径，必须复用而非重写**：`server/integrations/ra-mcp/native-apps.mjs` 的 `sendNativeMessage`（约 572–622 行）对 Codex/Cursor/Devin 已通过 `withTemporarySession`、`view.attach`、`view.handle({t:'send'})` 调用现有 Session；OpenCode 的 MCP `tools.mjs`（约 172–205 行）也调用临时 Session 的 `view.handle`。共享业务入口在 `server/session.mjs` 的 `Session.handle/handleSelected`、`server/routes.mjs` 的 `ROUTES`、`server/apps/index.mjs` 的原生 Adapter 注册表。因此原先“MCP 普通发送完全另起一套”的说法不准确。
- **现存差异的精确定位**：MCP `native-apps.mjs` 在 Busy/Waiting 前置检查时直接拒绝普通发送（约 582 行），手机 `routes.mjs` 的 Send 可传 `when` 进入原生语义；MCP `tasks.mjs`（约 203–204 行）对非 OpenCode 的 `model` 参数主动拒绝；手机 `agent/menus.mjs`、`apps/codex.mjs` 已具备 Model/Effort/Fast 设置与回读；MCP 对会话发现/创建、原生进度、精确取消及审批有独立的额外匹配逻辑。Codex 后台审批已经部分共用 `codexBackend.answer`，不得重复实现或退回旧行为。
- **必须保留而非消除的限制**：设备配对与 OAuth 权限（read/control）、授权工作区/项目、原生 Agent 的实际能力、精确 task/thread/turn/request 归属、一次性审批、幂等 operation ID、UNKNOWN 不自动重发、取消不能打断别人的轮次、断线/过期与并发防重。QA 的 `RA_MCP_TEST_ROOT` 限制不得通过扩大目录或绕过身份检查来解决；正式运行须基于真实配对授权，而不是无边界文件系统权限。
- **RA Core 边界**：当前 `server/ra-core/contract.mjs` 的 workspace actions 主要是文件与终端；不得为了本任务重做 RA Core、Fusion、Peer 或 Cloudflare。只在必须提供通用 Agent Control Service 时抽取既有 Session/ROUTES/Adapter 的共享调用，不另起一套任务引擎。
- **严禁扩大范围**：不改未关联的 UI/会话历史/文件传输/Fusion 语义；不新开原生窗口，除非用户显式创建且现有窗口确实不可复用；不改全局 Codex 默认模型与配置；不引入未经要求的 fallback/权限降级；不动正式服务、隧道、配对数据、Android/iOS/Windows 平台代码。上轮发现的目录上传同名策略问题、旧 OpenCode WAITING 任务和文件传输复用证据，另列遗留项，不借这次接口统一顺手修改。

### B. 修改步骤（先 A 机实现，每步完成后再决定下一步）

1. **P0｜固定 API 契约与影响范围，不先动代码**。以当前 Git diff、`HANDOFF.md`、`AGENTS.md`、已有验收报告和精确源码 SHA 为基准列出“客户端操作 → Session/ROUTES → Native Adapter → 原生回执”的映射；明确每个 App 当前能力（尤其 Cursor `steer=false`、OpenCode 原生 Queue/Steer 能力边界、Devin 立即发送可能中断、Codex 原生 `turn/steer`）。列出每个拟编辑文件和受影响 case 后再改。不得将没有真实成功证据的能力报为可用。
2. **P1｜抽取最薄的共享控制服务**。优先在已有 `server/session.mjs`、`server/routes.mjs`、`server/apps/`、`server/agent/` 上封装中立于客户端的 Agent 会话绑定、能力检测、操作分发和结构化执行结果。手机现有 WebSocket 层仍调用共享服务；MCP 通过同一服务入口使用它；不得在 MCP 复制新一套 CDP 点击、模型/权限或草稿操作。保留 `withTemporarySession` 在需要兼容现有 Session 的场景；如其 UI 连接副作用阻碍复用，只做最小解耦，不改既有手机行为。
3. **P1｜MCP 接入同一行为契约**。重点改 `server/integrations/ra-mcp/{tools,native-apps,native-task-adapter,tasks}.mjs`，并仅在必要时改上述共享服务：增加显式 `when`/操作类型以选择普通发送、原生 Queue、原生 Steer；不得把“立即追加”偷换为 Stop+重新发送，也不得在 Busy 时未经选择就强制 Steer/Queue。针对不同 Agent 保留原生不同语义和显式 UNSUPPORTED。Stop 只可作用于精确归属的 MCP task/turn。已完成的普通发送路径只做最小接线，不重写。
4. **P1｜模型与设置复用**。让 MCP 能在允许的目标 Session 上使用手机已有 Model/Effort/Fast 读取、候选校验、变更和实际回读路径；通过原生确认的候选/支持强度约束，不单凭 MCP 传入字符串修改。Codex 的设置对下一轮生效，不能声称改变正在运行的 turn；需区分后台和桌面会话所有者以及默认模型。现有 `tasks.mjs` 对非 OpenCode model 的拒绝应在相应共享能力确实接通后才取消，禁止先删除校验再报支持。
5. **P1｜问答、权限、进度与回执收敛**。复用手机端已存在的原生问答/审批执行器（包括已确认的 Codex 后台 `codexBackend.answer`）；MCP 继续独立持有 Task Journal、任务创建/开始/取消、精确 ID/turn/request 关联、一次性答复、UNKNOWN/超时复核。共享聊天内容解析和原生进度投影，但 MCP task 结果只取该任务确切轮次，不能把其他用户/轮次的回复当成任务成功。只在匹配到具体重复实现时删旧代码，避免另造新的泛用层。
6. **P2｜代码与文档收尾**。按实际改变更新 MCP capability/schema/错误码与说明；消除过时或误导的 `native_command_approval_confirmation_unavailable` 等全局声明，但要保留尚无证据路径的限制。检查新增源码是否纳管，记录修改前后 Git status/diff 和证据目录。不得自行 commit/push/release/部署；不得把方案检查视为功能验收。

**每个步骤的退出条件**：对应逻辑的 A 机定向检查通过，变更文件/共享依赖和受影响的旧验收条目已标注；无新引入的会话混淆、错误审批、错误窗口、重复发送或静默 fallback。若某 App 原生没有该能力，就返回准确的 Unsupported，不以伪实现“通过”。

### C. 验证范围与设备分工（强制执行：A 优先，只有物理跨机必要时才用 B）

验证主体：**A 机现有隔离 QA 服务、现有原生测试窗口、现有配对 Chrome/浏览器**。先在 A 做静态、协议、原生工具和有界面配对浏览器的最小定向验证；本轮新增测试夹具只能临时放 `_shots/`，用后移除夹具，保留必要结果日志。**“实际调用成功”与“代码检查通过”必须分别记账；不能把模拟响应当真实原生执行或浏览器成功。**

| 验证项 | 默认设备与最小验证内容 | 使用 B 的条件 | 达标证据 |
| --- | --- | --- | --- |
| 共享服务/能力声明 | **仅 A**：检验同一 Session Binding、ROUTES、Adapter 引用；按当前 Agent 真实能力列出支持与 Unsupported；A 的静态检查与精确定向协议回放 | **不需要 B** | 源码变更/依赖 SHA、能力矩阵、定向结果 |
| 发送（空闲） | **仅 A**：每条实际改过的 App/发送分支做一个原生发送→精确回执→消息归属；未改分支复用旧 PASS | **不需要 B** | requestId、threadId、turnId/messageId、原生回读 |
| Busy / Steer / Queue | **仅 A**：Codex 原生 `turn/steer` 与 `thread/queue/add`；Cursor 原生仅支持 Queue 时明确拒绝 Steer；Devin 默认排队/显式立即发送及失败时队列保留；OpenCode 按真实 capability 判定。不对未变化且已验证的分支重测 | **不需要 B** | 排队 ID、原生轮次/队列变化、准确 UI/MCP 回执、不会重复执行 |
| Model / Effort / Fast | **仅 A**：用隔离原生会话确认候选读取、选择、原生回读、下一轮实际设置，结束恢复隔离会话原设置；非法组合及切换会话后请求拒绝 | **不需要 B**；只有本轮改动直接影响远端 Peer 的模型协议时才列 B | 精确模型/effort/serviceTier 与 thread 关联的读回，非全局配置 |
| 问答/权限/审批 | **仅 A**：只触发受改动影响的真实原生 request；MCP 与手机并发只回答一次、一次性允许/拒绝、过期请求不得执行、无请求不算通过；已有通过且调用链未变的 Codex 后台 once/reject/Plan 证据复用 | **不需要 B**；仅修改跨机权限传播、Peer grant 或远端 Worker 所有权时列 B | 原生 request/response/turn 绑定和实际结果，不能只凭 MCP ACK |
| 任务生命周期/取消 | **仅 A**：创建/续用明确会话、幂等同 ID、重发冲突、RUNNING/WAITING/COMPLETED/FAILED/UNKNOWN；只取消本任务轮次，检查别的 Agent/会话不受影响；精确超时不重复派工 | **不需要 B** | 持久化 Task Journal、原生提交和取消关联回执 |
| 会话内容、历史、草稿和窗口 | **仅 A**：仅当本轮改到其共享依赖时测加载/滚动/草稿回执/切换电脑和会话的隔离；不得新开窗口取代可复用窗口；否则引用既有通过证据 | **不需要 B**（A 可模拟多会话但不能把它当物理双机证明） | 原生与配对浏览器定向场景、会话归属、差异证据 |
| 文件/终端/原生壳 | **仅 A**：只测本轮触及的统一接口相关文件/终端边界，不顺手重测传输、目录上传、语音、推送等未改功能 | **不需要 B** | 静态检查或已有未变路径的历史报告 |
| 真正 A→B 跨机调用 | A 本地只能验证协议回放，**不能替代跨机实测** | **仅当本轮实际修改 Peer/Fusion/远端任务路由、跨机授权、跨机回执、跨机模型协商或 B 运行源码时，才使用 B**。未改这些路径，直接复用已有 A/B 真机 PASS | A→B 同一授权工作项、B 原生执行、A 回读/交付和 B 独立核对的一次完整证据 |
| Android/iOS/Windows 真机平台 | A 的 Linux + 配对浏览器只能证明网页/Ubuntu 路径 | **B 也不能代表这些平台**；没有对应真机则 EXCLUDED/NOT_VERIFIED | 禁止宣称未测平台 PASS |

**B 机使用门槛**：先提交“为什么 A 单机无法证明”及本轮修改的物理跨机依赖路径；A 定向验证全绿后，才通过原有 RA Peer/现有配对浏览器接 B。沿用已配对 B QA、已知根目录、既有 OpenCode/原生 Worker 与测试目录；仅同步本轮真正改变的运行文件及必要依赖，核对 SHA，保护 B 的认证/配对、override、正式 3939、Cloudflare 隧道、生产服务和本地原生 Agent 设置。**B 不用于复验 Codex 单机模型、Steer、权限或已通过的独立单机用例**，也不重跑既往已完成且依赖未变的 Fusion 跨机闭环。

### D. 严格的“变更影响 → 验证”规则：不要重新验证没变过的东西

1. 先建立逐 case 的 `case ID → 上次状态/报告 → 执行时版本 → 直接代码和共享依赖路径/SHA → 本轮触及情况 → 处理决定` 矩阵。可复用证据从 `_shots/ra-release-permission-20261125/paired-final-coverage.json` 及所指原始报告读取；其 `2026-11-25 16:42` 快照为 214 项：125 PASS、84 PASS_REUSED、2 NOT_VERIFIED（Codex 原生任务清单、自然容量不足重试）、3 EXCLUDED；`releaseReady=false`。这是旧快照而非本轮自动通过。
2. **REUSE_PASS**：之前真实通过，并且从那次执行到现在相关业务实现、共享调用链、API 契约及原生依赖均未受本轮修改影响。即使是先前已有但无关的源码文件变化，须有具体非影响性分析才允许复用；不能仅看文件名或自动认为所有旧 PASS 仍有效。历史 84 项复用中曾发现 3 个文件对应 19 项/35 个依赖哈希变化，特别历史分页与文件传输；先确认最新证据/实际影响，不把这些疑点直接当新 bug，也不在本 MCP 任务中扩大到全部文件功能。
3. **RUN_REQUIRED**：新增 MCP 入口、修改过的共享服务或原生分支、精确请求归属/取消/模型设置行为、确实未曾验证的必要能力。只跑覆盖这些差异的最小原生/协议/配对浏览器 case；已有同版本同路径通过就不重试。单次复现充分时立即停止，不以压力测试次数堆覆盖。
4. **NOT_VERIFIED / UNSUPPORTED / EXCLUDED / FAIL**：没有原生请求、没有必要硬件、超时不明、能力本就不存在、平台不可达等分别记录；失败先定性为手机 Service、MCP 封装、Native Adapter、QA 前置条件还是原生软件能力，给出证据。UNKNOWN 必须查原生 turn/message/receipt，禁止换新 taskId 重发；不可将已提交 ACK 当执行成功。
5. 修改一个阶段后只检查该阶段实际变化文件、入口和关键依赖：`git diff --check`、语法/协议/导出定向检查（例如受影响的 `npm run check`），及受影响的真实配对浏览器 case；**不默认 `npm test` 全量、不默认 214 项回归、不用 B 执行 A 已覆盖测试**。`npm run qa:browser -- --list` 仅在准备提交时运行以确认清单可加载，不是功能 PASS。既有成功且代码/依赖未变的测试不因“最终验收”名义重跑。
6. 回归如发现真实缺陷，只修影响范围并重验失败分支及关键相邻语义；不重复所有此前已通过、未改路径。测试超时应有明确边界，停止自己的隔离任务，不中止用户其他正在运行的 Agent；避免无限轮询和无进展盲重试。


### E. 实施顺序、验收交付清单与明确停止条件

**按依赖顺序推进，禁止边开发边无限扩展**：

- [ ] E0：建立改造前的 API/能力/调用链与测试影响清单；记录当前 HEAD、工作树变更列表、全部拟修改文件及 SHA、已有直接 PASS 的报告/时间，标注哪些测试应直接复用。不要一开始重复执行这些 PASS。
- [ ] E1（A）：让共享 Agent Control Service 有明确结构化参数与执行结果，手机端控制行为与原有界面不变；先做最小协议/代码检查，再完成一条受改动影响的手机端 A 配对浏览器路径。
- [ ] E2（A）：MCP 接入同一 Session/ROUTES/Adapter，补齐明确的 Busy、Steer/Queue/Stop 能力边界和模型/Effort/Fast 入口；用隔离 Codex、Cursor、Devin、OpenCode 分别核验**本轮实际变动的**行为，不要求每个 App 对不支持的能力“通过”。
- [ ] E3（A）：对共享权限/问答与 task 状态、精确取消、超时、断线、UNKNOWN/幂等进行影响范围内的验证；只有真实原生事件与正确归属才记新 PASS，未变且已有强证据的路径记 REUSE_PASS。
- [ ] E4（条件触发 B）：**仅** E0–E3 发现确实涉及 A→B 的协议/授权/会话归属/部署增量，才在 A 全绿后进行 B QA 的一次真实跨机最小闭环；否则标注“B 不需执行（本轮未影响物理跨机边界）”，引用之前同一未变契约的原证据。不要为了“最终全功能检查”再次跨机跑一遍。
- [ ] E5：检查本轮 Git diff/新增文件与依赖、`git diff --check`、必要的语法/协议检查和**受影响**的浏览器 case；输出新的增量验收表及未验证项，更新 HANDOFF。没有用户发布授权，不进行 commit、push、tag、release 或生产部署。

**每条新测试的记录模板**：`case_id | 变更原因/相关文件及 SHA | A 或 B（若 B，写 A 无法验证的理由） | 既有证据及是否复用 | 本次运行命令/原生窗口/任务 ID | 预期行为 | 实际行为与原生回执 | PASS/REUSE_PASS/FAIL/NOT_VERIFIED/UNSUPPORTED/EXCLUDED | 日志/截图路径 | 下一步`。同一 case 原生行为未变而有现成 PASS 时只记录“复用证据”，不产生新的执行任务和截图。

**交付完成标准**：手机与 MCP 在相同授权、相同 Agent 原生能力下的控制语义一致；MCP 不再存在可通过共享接口消除的额外限制；不出现错会话发送/Steer、默默变 Queue、错误模型生效轮次、重复审批、跨任务 Stop 或误报 COMPLETED；受改动影响的 A 实测及（确需时）B 跨机证据齐全。剩余原生不支持、权限限制、平台排除和用户指定暂缓项明确呈报，不能用“总体通过率”掩盖。

**交接规则**：后续接手 Agent 先读本节及最后一节实际新进展、`AGENTS.md`、Git 状态、差异 SHA、已有证据；从第一个未完成的 E 项继续。已有 PASS 且调用链未变就不重跑；不要照抄旧 HANDOFF 中已过期的 PID/版本/未完成状态，不要擅自修改不在本次统一接口范围的目录上传、移动端真机、Windows 或 Fusion 产品行为。任何额外问题先向用户报告和界定独立影响范围，除非它直接阻断本节已授权的验收，不纳入本轮修复。

**本次记录完成情况**：上述仅为方案和验收边界，未执行 E0–E5，没有源代码变更、实际测试、A/B 同步或发布。

## 2026-11-25 — 统一 Agent 控制 E0 已完成

- 用户本轮 Prompt 已明确授权本节 E0–E5，范围内无需再次确认。改造前 HEAD、工作树差异、拟改文件 SHA、原有 214 项台账和调用链/能力边界已冻结在 `_shots/ra-agent-control-20261125/e0-baseline.json`、`baseline-git-status.txt`、`baseline-git-diff.patch`。本阶段未改产品代码、未重跑旧 PASS。
- E1 拟新增薄 `server/agent/control.mjs` 并保留 Session 选择/锁/原生路由行为；E2 修改 MCP tools/native-apps/native-task-adapter/tasks/errors 与说明，补显式 when、原生设置和准确能力，保留任务精确回执；E3 验证相关任务生命周期与精确取消，审批原执行器未变的复用已有证据。前端、Fusion、Peer、文件/终端和平台代码不在改动范围；B 尚无使用必要。逐项增量结果随阶段追加。
- 下一步 E1。未提交、推送或发布。

## 2026-11-25 — 统一 Agent 控制 E1 已完成

- 新增 `server/agent/control.mjs`：共享原 Session.dispatch 的分发逻辑，并提供结构化 Session 控制入口；`server/session.mjs` 保留选择绑定、串行化、窗口锁与原生所有者检查，只委托原分发体。未改手机 UI/路由/原生适配器。
- `npm run check` 全部通过（235 源码、91 发送/84 回传类型、196 helper）；既有 Chrome 9335、A QA 3949 在同一空闲 Devin QA 会话打开历史并读取实际模型候选，草稿/待发送为零，回到概览。证据 `_shots/ra-agent-control-20261125/e1-phone-paired.json`。首次预检仅遇到重启后目录未载入，尚未操作原生；待真实目录就绪后通过。
- 仅精确重启 A 隔离 3949（新 PID 1156125）；3961/生产 3939/隧道和当前忙碌 Codex 未动。下一步 E2。

## 2026-11-25 — 统一 Agent 控制 E2 完成，进入 E3

- MCP 新增设置读取/选择回读、原生队列读取/操作、会话管理入口，send_message 显式 idle/queue/now；任务模型/强度/Fast 经共享菜单候选应用。OpenCode 发送与结果投影的重复路径已接到 Session。实际增量文件 SHA 在 `_shots/ra-agent-control-20261125/e2-source-sha.json`。
- Codex 后台 idle、模型/强度、Queue 晋升、turn/steer、幂等、旧任务不能 Stop 后继的真实证据：`e2-codex-send-control.json`（其中最后一次 Stop 前置失败已由下一条证据替代，其余已通过项复用）、`steer-native-read.json`。原生 ACK 早于 user items 落盘，修复为共用发送器保留最后 admitted input/turn 回执，精确 Stop 真机通过：`e2-codex-exact-stop.json`，原生确为 interrupted。未保留无助于根因的历史分页尝试。
- 设置真机：`e2-codex-settings-pass-queue-read-failure.json` 中三类设置往返均 CONFIRMED；后台队列读取由 e2-codex-send-control.json 补齐。Cursor/Devin/OpenCode 见 `e2-other-native-settings.json`，Cursor 适用模型的 Effort/Fast 补证 `e2-cursor-effort-fast.json`。全部原设置已恢复。
- Cursor 原生 Queue 已执行并回复，但队列 ID 不是晋升后的消息 ID，不能凭同文本认定 task 完成。`e2-cursor-devin-send.json` 和 `cursor-queue-native-metadata.json` 记录此新接口限制：Cursor/Devin 的 task busy 提交在执行前返回 native_task_control_receipt_unavailable，使用 send_message 保留相同原生控制能力；已交付却无法映射的旧 queued task 仅记 UNKNOWN、不重发。Codex task 支持原生明确队列消息回执，OpenCode 无原生 Queue/Steer/Fast。该限制属于 MCP 任务归属层，不伪称原生不支持 Queue。
- 配对页：`e2-paired-incremental.json` 的 Devin 单次允许 sleep 后 parent/queue 都收到原生标记，队列清空；`e2-paired-cursor-settings.json` 完成手机模型、Low、Fast 往返并恢复 Auto，草稿/待发送为零。Cursor Fast 新分支补回既有 fastState 协议；早期测试错误假定 Fast 初值 off，按真实值往返后通过。
- QA 前置：现存 Cursor 原生窗口为旧浏览器 QA 的 B 目录（仍在 A 机），其目录已清理，本轮仅恢复该 _shots 临时目录；使用既有 3949 配对授权环境，不扩大 3961 的测试根目录。并复用手机的同线程检查，避免无关终端检测器错误拦截已绑定线程操作。
- A 3949 当前 PID 1204553；A 3961 尚为 1091195，待 E3/E5 一次加载最终代码。生产 3939、隧道、配对身份均未修改；B 尚不需要。本阶段未提交/推送/发布。E3 将完成 OpenCode 创建/应答/Stop 执行收敛、任务状态与协议验证。

## 2026-11-25 — 统一 Agent 控制 E3 进展（尚未结束）

- OpenCode 真实新会话发送、提问 Blue 和一次 bash 审批完成，见 `e3-native-lifecycle.json` 中 OpenCode 两行；同报告末尾 Devin 初次失败不能当整体 PASS。OpenCode Stop、会话动作读取、改名、归档另在 `e3-opencode-stop-management.json` 完整通过。Codex 后台设置加发送的同一 command lease 真机通过，见 `e3-codex-serial.json`，QA 线程已归档。
- Devin 显式批准沿用手机原生请求执行器，不再额外限制命令白名单；已有 UNKNOWN 请求经真实原生上下文单次处理后确认执行，但保留原任务 UNKNOWN，不补造提交回执。`e3-devin-live-native-approval-final.json` 保存原生结果。新结构化提问实测收到了 devin-cli/64，Blue 原生 ACK 为 true，精确消息 acp33 对应任务最终 COMPLETED，见 `e3-devin-question-trace.json`。
- Devin 发送回执中原有 devinReadSession 会 resume 活跃会话；已在 `server/page/session-actions.js` 的 receipt 分支改为读取已绑定原生 store。曾试验的通用 window-receipt 并发提交改动已撤回，Cursor 不受该试验影响。
- 用户另行明确批准了额外 Codex QA 窗口，仅项目 native-final-codex-unified，窗口 C8EC04610EBF53E4301CDE000B684B7E；初次创建、设置、消息与任务完成已通过。桌面 Queue 的原生投影漏读 submissionOptions.clientUserMessageId，已据真实原子数据修复共用 helper；随后发现 ACK 早于消息落盘，MCP 捕获精确输入增加有界只读等待，未重发 UNKNOWN。桌面剩余控制验证仍在继续，验后需关闭该额外窗口，保留原当前任务窗口 CF81D7FAE0FE359A46660D2B5F62624B。
- 六类定向协议检查见 `e3-protocol.json`（PROTOCOL_PASS，明确非原生执行证据）；真实超时／UNKNOWN 调查见 `e3-real-state-after-unknown.json`、桌面 queue diagnosis/trace。E3 尚需桌面剩余控制与最终配对页增量检查。B 仍无使用必要；生产 3939、配对身份、隧道未改。

## 2026-11-25 — 统一 Agent 控制 E3 完成；E4 不触发，进入 E5

- Codex 桌面 Queue 的入队 ID、晋升后同消息 ID、队头与队列任务各自 COMPLETED 已通过，证据 `e3-desktop-final.json` 的 queue/两条完成行；该报告后续 Steer 失败不能当整体 PASS。根因是 Native UI 的 handleSubmit 参数为 DOM event，传 options 会被忽略并执行默认 Queue。共享 `server/page/chat-extract.js` 改为通过同一渲染器缓存的函数身份复用原生提交回调，不改默认配置。`server/native-windows.mjs` 只将已接受用户消息作为 Steer 回执，临时 admission queue 不算 Steer 成功。
- `e3-desktop-steer-stop-fixed.json` 整体 PASS：真实 Steer 进入同一轮、旧任务 Cancel 明确 FAILED、Steer 自己 COMPLETED、后一条任务精确 Stop 后 CANCELLED；原任务窗口未触碰。先前用队列回执判断 Steer 的失败是接口回执问题，旧队头当时仍为实际活动任务，未发生跨轮错误 Stop。
- 新版 Codex 桌面队列编辑沿用原生现有 Edit→提交回调，由原生负责草稿、上下文和队列位置；旧版 manager 路径保留。未保留 RPC remove/restore 的试验实现。`e3-desktop-queue-actions-native-ui.json` 整体 PASS：真实 Queue、read、edit、回读、remove、空队列与队头精确 Stop。普通 queue action ACK 不冒充任务完成；Task 精确 Stop 仍需已经接纳的当前原生轮次，尚在队列的项通过显式 queue_action 操作，不能 Stop 队头代替删除。
- Devin 最终既有配对页 `e5-paired-devin-now.json` 整体 PASS：手机发送 acp37、原生 devin-cli/66 一次 Allow、MCP now 被原生接受为 acp40 并完成指定回复；草稿、队列、待发送为零。这也验证了撤回通用并发实验后，修复过的 Devin receipt store 读取路径。结构化问题 acp33 / devin-cli/64 的 MCP 闭环沿用 `e3-devin-question-trace.json`。
- `e3-protocol.json` 当前 7 类 PROTOCOL_PASS，包含精确 OpenCode 会话 GET 404 不得报 RUNNING 的回归。OpenCode Stop/会话管理、Codex 后台设置串行及其它 E2/E3 PASS 继续复用。
- E4：B 不需执行，本轮未改 Peer/Fusion/远端授权/跨机会话或模型协议。A 本地 Cursor 的旧 QA B 命名目录不是物理 B。原有物理 A/B 证据从 e0-baseline 的 214 项来源继续引用，不能将本轮 A 结果当新跨机实测。
- E5 静态检查曾在沙箱中所有 node 子进程空错误失败；在同一隔离仓库直接执行后 235 语法、91/84 协议、196 导出/182 import 与 git diff --check 全通过。随后桌面最后两处共享 helper 改动仍需最终增量检查。
- QA 3961 已精确重启为 1263537，3949 为 1265695；最后桌面 helper 待一次加载最终版本。公网与本地正确 Host 的真实 HTTP tools/list 均 200、31 工具，证据 `e5-http-tools.json` / `e5-public-tools.json`。当前 ChatGPT Remote Agent QA 连接的 list_app_capabilities / list_devices 均返回上游 -32603 Internal error，尚无足够证据定位该连接的具体根因，现存客户端仍缓存 25 工具；这是客户端连接/刷新待核对项，不能当 MCP 已登录调用 PASS。未重建配对、未改隧道。
- E5 还需最终差异/证据台账、桌面受影响配对页检查、额外测试窗口关闭与临时夹具清理。未提交/推送/发布，尚不能标记发布就绪。

## 2026-11-25 — 统一控制 E5 收尾：主要 A 验收已完成，剩两项未闭环（最新接手入口）

**当前结论：不标记可发布；不提交、推送或发布。** E0–E3 的代码改造及主要 A 增量原生/配对验收已完成，E4 无物理跨机变更而不触发；E5 仍有下面两项，不能写成全 PASS。

### 已完成与证据

- 最终本轮产品/说明差异为 19 个文件，独立于基线的大量已有修改。薄共享 `server/agent/control.mjs` 复用 Session/ROUTES/native adapters；MCP 补显式 when、设置候选/选择回读、会话与队列入口，删除重复 OpenCode 发送/状态/审批动作，保留 OAuth、配对、scope、工作区、task/thread/turn/request 归属、幂等和 UNKNOWN。新增 control.mjs 在 Git 中可见且未被忽略，尚未暂存/提交，发布候选需包含它。
- 影响范围内修复了 Devin 回执读取重复 resume、Codex 桌面 queue client ID 嵌套字段、按钮 DOM event 包装器吞 Queue/Steer options、临时 admission queue 误报 Steer 成功、新版桌面原生 Queue Edit 路径，以及已归档却漏读原生归档状态的确认逻辑。没有保留通用 window-receipt 并发、RPC remove/restore 编辑等试验实现。手机界面与确认流程未改变。
- 新版 Codex 桌面编辑由原生 Edit/提交回调负责上下文和草稿，原生可能换队列 ID，回读最新 ID；MCP task prompt 不会因此被重绑。`cancel_task` 精确中断已接纳的当前轮次；尚在原生队列中的项通过 queue_action remove 操作，不能 Stop 队头代替。Cursor 原生不支持 Steer；OpenCode 无 Queue/Steer/Fast。Cursor/Devin task 的 busy 队列晋升缺少稳定消息关联，明确拒绝该 task 模式，send_message 保留手机原生能力。
- 最终静态检查 `e5-checks.json`：235 语法、91/84 协议、196 helper 导出、182 import 与 git diff --check 全通过。临时协议检查 7 类，加 Steer admission 补测，分别在 `e3-protocol.json` / `e5-steer-protocol.json`；明确是协议证据，不是原生执行。
- 最终配对页：Devin `e5-paired-devin-now.json` 完成手机发送、一次 Allow、MCP now 原生接受和指定回复。Codex `e5-paired-codex.json` 的历史/发送/队列编辑保留草稿/删除已通过，之后测试停在既有立即追加确认框，未发原生请求；只补测该段的 `e5-paired-codex-steer-stop.json` 整体 PASS。独立原生读回 `e5-qa-thread-archive-real-state.json` 确认最后一轮 interrupted，没有将 Stop 记为自然完成。
- 首个获批额外窗口 C8EC04610EBF53E4301CDE000B684B7E 已关闭，仅移除其 owned-windows 清单项，主窗口 CF81D7FAE0FE359A46660D2B5F62624B 仍在，只通过目标列表确认存在，没有对其执行被拒的 CDP 检查。证据 `e5-extra-window-closed.json`。配对 Chrome 9335 最后回到空闲 Devin QA 概览，草稿/队列/待发送均为零：`e5-final-home.json`。
- 完整台账 `_shots/ra-agent-control-20261125/INCREMENTAL_ACCEPTANCE.md`、`incremental-acceptance.json`。本轮差异 `round-diff.patch`、before/after SHA `final-source-sha.json`、原始源码证据 `round-source-baseline.tar.gz`、Git 状态 `final-git-status.txt`。原 214 项中 199 旧 PASS 按非影响性分析复用，10 项由增量证据覆盖；2 项用户暂缓和 3 项平台排除仍保留原状态。旧失败/UNKNOWN 报告不整体计 PASS；明确复用已通过行，历史 UNKNOWN journal 未伪造完成或重发。
- B 未使用。只改 A 本地控制与原生适配，Session dispatcher 分发体保持一致；未改 Peer/Fusion、跨机授权/路由/模型协议，沿用 `_shots/ra-fusion-feedback-fix-20261125/paired-ab-final-current.json` 等原物理 A/B 证据。A 本地目录名字 B 不代表物理跨机。

### 仅剩两项

1. **Codex 归档修复后的完整入口 ACK 复验：NOT_VERIFIED / 待单次额外开窗授权。** 上次 manage_session archive 返回 UNKNOWN 后停止重试，独立读取确认确已位于 archived_sessions；最后共享归档确认已改用既有 nativeSessionInfo cleanup，实际原生读回 archived=true，并关闭了原 QA 窗口。原操作 journal 保留 UNKNOWN。原生效果与新的纯确认读取均有证据，但不能冒充修复后一次完整 manage_session ACK。自动审批拒绝再次开窗，理由是此前授权只覆盖一个额外窗口。没有再次开窗。已准备零模型请求、只建一个空会话的一次完整复验，具体可审阅范围在 `pending-final-archive-plan.json`。
2. **现有 ChatGPT Remote Agent QA 鉴权连接 smoke：NOT_VERIFIED。** 正确 Host 本地与既有 HTTPS /mcp tools/list 都是 200、31 工具；当前 ChatGPT 连接缓存 25 工具，list_app_capabilities/list_devices 持续返回 -32603 Internal error（最终重载后亦如此）。具体根因尚未证明，客户端缓存、OAuth 刷新或 connector 上游均只是候选，不能断言 RA 处理器完全没有收到调用。证据 `e5-connector.json`、`e5-http-tools.json`、`e5-public-tools.json`。现有工具没有刷新此连接的能力；应保留配对身份，在客户端刷新既有 Remote Agent QA 连接后补一条鉴权只读调用。不得重建配对、改隧道或假写成功。

### 若获得“再开一次空会话 QA 窗口”授权，下一步仅执行这些

- 临时脚本保留在当前工作区 `_shots/unified-control-stage-20261125/pending-final-archive/`。`open-window.py` 用相同 QA 项目和现有 Code 实例，验证现有仅剩原主窗口后仅开一个新的 QA 窗口；该动作未经新批准不可执行。
- `run.py <当前 3949 PID> prepare.mjs`，再 `run.py <当前 3949 PID> verify.mjs`。run.py 临时将该进程的 owned-windows 只收窄到新 QA 窗口，不改服务自身清单/配对；prepare 核对其确切项目，verify 通过现有手机 Adapter 建一个空会话、只调用一次 manage_session archive、核对 ACK 与原生 archived，最后只关闭新窗口并移除其清单项。**不发送任何模型 prompt。**
- 任一创建/归档 UNKNOWN 或超时，读取原 request/task/原生状态，禁止再运行脚本生成新 request 盲重试。证据写 `e5-empty-session-archive.json`。完成后删除剩余临时脚本和临时单窗口清单，更新 E5 台账及 HANDOFF；无需重跑此前 PASS。
- 当前隔离 3961 PID 1305747、配对 3949 PID 1309324，均已加载最后归档确认源码；执行前按 pid 文件和 /proc 的 cwd/PORT 实态核对。生产 3939、隧道、配对身份、正式服务均未改。

自动审批还拒绝过对原忙碌主窗口的只读 CDP 签名检查；该动作未执行，已用两个已安装 Codex 版本的静态回调身份对比替代（`e5-native-submit-static-boundary.json`），不为此再请求触碰主窗口。

E5 收尾补记：`e5-final-state.json` 已独立核对 19 个候选源码 SHA 未改变、新增 patch 无尾随空白；3949/3961 健康均 200，3939 生产 PID 仍为 1416。已删除本轮用完的 73 项临时文件/目录（含 schema、临时协议/原生/浏览器夹具与 stage 代码副本）；只保留尚未获准执行的 `pending-final-archive` 四个脚本，待此唯一用例验后删除。日志、报告、截图、round patch、原始源码证据归档保留。最终请求只针对上文一次零模型空会话复验，不请求触碰主窗口、重建配对或更改隧道。

## 2026-11-25 — E5 A 机增量验收收口（最新）

用户批准再开一个同目录隔离 Codex QA 窗口，并接手 ChatGPT 连接排查。只在 A 机执行。新窗口 373F38E973E07D25BF6B7BEBD1288203 中只创建了一个空会话 01a212bd-97b1-7cf1-8476-417ada04a3b6，模型请求为零。

只执行一次 `manage_session archive`，操作 ID `35012acf-975e-4dfc-9081-b4dd747d8ad7`。原生回读 archived=true、running=false，项目路径与 QA 根目录一致。原始验收脚本把发送回执 ACKNOWLEDGED 误作会话管理成功状态，导致断言失败。随后核对 `tools.mjs` 的回执契约，并用原 ID 执行只读 `operation_status`，持久结果与实际响应一致，均为 SUCCEEDED / {ok:true}。归档验收记 PASS，原始脚本输出保留，未重做归档。证据见 `_shots/ra-agent-control-20261125/e5-empty-session-archive-verified.json` 和 `e5-empty-session-archive.json`。

已确认该测试窗口关闭、QA 清单仅移除该窗口条目，主窗口仍在。19 个候选文件 SHA 与上一轮最终审查一致，`git diff --check` 通过；复用既有配对浏览器和跨机验收证据，未重跑其他场景。无产品源码增量，B 未使用。

A 机统一控制增量验收至此完成。整体验收仍保留 ChatGPT QA 鉴权调用 NOT_VERIFIED，由用户接手。公网服务工具发现的 31 项证据继续有效，发布状态暂维持 releaseReady=false。

验收后已移除四个临时夹具和临时单窗口清单，原始日志、核验结果及台账均已保留。

ChatGPT QA 连接刷新后复查：本会话的 Remote Agent QA 调用 list_devices 仍返回 -32603 Internal error，本会话仍只显示 25 个工具。同一隔离 QA Relay 的 tools/list 为 HTTP 200，返回 31 个工具。鉴权项仍是 NOT_VERIFIED，根因尚未确认。见 `_shots/ra-agent-control-20261125/e5-connector-refresh-recheck.json`。


## 2026-11-25 — 统一控制改造后的独立核查剩余项（旧 QA 已卸载，交由本地 Codex）

**F1–F4 已按顺序实施并完成可执行的本机验收。发布判断及未取得实测的路径见下方阶段结果。** 用户确认**旧版 ChatGPT Remote Agent QA 插件已经卸载，不再使用，也不要求处理其 -32603、旧 OAuth、25 工具缓存或连接刷新问题**。旧台账中的 `E5.connector-authenticated-smoke: NOT_VERIFIED` 仅保留历史证据，**本轮标记为 RETIRED / OUT_OF_SCOPE，不再作为新版接口的发布阻塞或要求重建旧连接**。目前仍在使用的 `remote_agent_A` 是另一条新版连接，已实测 `list_devices`、`list_app_capabilities`、`read_session` 可调用且发现 31 个工具；该事实不替代其他 MCP 工具的真实验收。

**现有通过结论必须保留**：`_shots/ra-agent-control-20261125/incremental-acceptance.json` 的 19 个产品/说明文件当前 SHA 均与本轮完成快照一致；24 个 PASS、2 个 PROTOCOL_PASS、4 个 UNSUPPORTED，另一个旧 QA 的 NOT_VERIFIED 现按上段退役。原 214 项的 199 个 REUSE_PASS、10 个 COVERED_BY_DELTA、2 个用户暂缓、3 个平台排除仍按实际证据处理；不因补充核查而重新跑整套。A 机 3949/3961 QA 与生产 3939 需严格隔离。B 机仅用于单机无法验证且本轮真正更改了物理跨机/Peer/Fusion 契约的场景。

### F1（P1）MCP 会话内容读取尚未与手机端对齐：确定的接口缺口

- **证据**：`server/integrations/ra-mcp/tools.mjs:163–176` 中 `read_session` 对 OpenCode 读最近消息；而 Codex/Cursor/Devin 只调用 `overviewPreview`，返回 `last/text/preview_only:true`。新版 A 插件实际对 Codex 现有会话调用 `read_session`，响应也只有 `busy/waiting/preview_only:true`，没有结构化消息列表。
- **目标**：在 MCP 当前会话授权与 scope 内，复用手机端既有的会话消息解析和历史分页能力（Native Adapter、Session/ROUTES、现有 History projection），让 `read_session` 能返回**有界、结构化、准确归属所选 thread 的用户/助手/状态消息**，必要时提供可验证的分页游标。不要求一次加载整段无限历史，也不复制另一套原生 DOM/ACP 解析；保留原生不支持或无法可靠读取时的显式状态。
- **修改范围**：优先 `server/integrations/ra-mcp/tools.mjs` 及必要的只读共享 Session/History helper；仅在确有必要时扩展 MCP schema。手机端展示、草稿、发送、历史滚动语义必须保持原样。
- **验收**：**A 机**对 Codex、Cursor、Devin 分别选一个有已知原生消息的隔离 QA 会话，经 MCP `read_session` 读取并对照手机端/原生记录，核对角色、顺序、会话归属、消息数量上限、分页/尾页、旧会话切换、拒绝越权、空会话。OpenCode 旧 PASS 且依赖未变则直接复用。无真实消息或缺 Native 能力时标 NOT_VERIFIED/UNSUPPORTED，不能靠虚构输出充数。

### F2（P1）旧 REUSE_PASS 的依赖证据漂移：确认是否影响验收，而非预设功能故障

- **证据**：独立对比 `_shots/ra-release-permission-20261125/paired-final-coverage.json` 原始 84 项 `PASS_REUSED` 的 `dependency_hashes` 与现有源码，**24 个 case** 存在哈希变化，分为：`app/js/history.js` 3 项（Devin `conversation.tasks`、`conversation.subtasks`，Cursor `conversation.details`）；`app/js/transfer.js` + `server/http/transfer.mjs` 16 项文件浏览/引用/预览/下载/操作；`server/agent/menus.mjs` 5 项模型与额度读取。其中 Cursor `models.change` 已被新台账标作 `COVERED_BY_DELTA`，其余相关项目多数仍标 `REUSE_PASS`。**哈希变化不等于功能失败**，但不能单靠统一的“dispatch 没变”理由证明每个 case 都未受影响。
- **处理方法**：先定位每个旧 case 的真实执行时间、改动时间、原始报告与这三处源码的**具体 diff 行/调用依赖**；逐案写明为什么结果可以复用或确需补测。优先复核上述 **3 个 History case**：Cursor 会话详情与 Devin task/subtask 的真实加载/路由/分页；如果已有这些改动之后的直接 PASS，附证据即可，不必运行。16 个文件项如变化只涉及空目录上传等无关路径，应提供代码级非影响性证明后保留 REUSE_PASS；只有同一业务路径被实际影响且无新证据，才在 A 机跑相关的最小用例。5 个模型/额度项同理，保留已被本轮新案例覆盖的部分，不机械重验。
- **验收产物**：在 `_shots/` 生成有来源和 SHA 的 `case -> changed dependencies -> impact -> REUSE_PASS/COVERED_BY_DELTA/RUN_REQUIRED -> evidence` 增量表，并同步更新 `HANDOFF.md` 和最终覆盖台账。严禁再启动全部 214 项、全量文件功能回归或 B 端重复检查。

### F3（P2）Cursor 当前新建会话的能力声明：验证环境条件，不先改代码

- **证据**：新版 A 连接 `list_app_capabilities` 报 Cursor `can_create_session=false`、但 `can_create_task=true`，同时有 `task_busy_submission_receipt_unavailable_use_send_message` 限制。当前声明依据 `server/integrations/ra-mcp/native-apps.mjs` 的原生可创建窗口候选判断，不能单凭 false 证明手机端原生创建能力缺失或 MCP 存在 Bug。
- **要求**：只读比对手机端 `openAgent/create` 与 MCP `creationWindows/createNativeTaskSession` 的实际前置条件（是否既有可复用窗口、CDP、选中 workspace、busy/draft、原生支持）；如果原因只是当前 QA 窗口不可用，就记录 `CONDITIONALLY_UNAVAILABLE` 并保留现状。只有在**完全相同、已获授权、可复用**的 A 机原生窗口/项目条件下，手机端创建成功而 MCP 被错误拒绝，才做范围限定的缺陷修复与最小验收。**不因检查而创建新窗口、关闭忙碌会话或放宽目录和权限**；如必须增加窗口先报告并取得授权。
- **原生限制保留**：Cursor `steer=false`、OpenCode 无原生 Queue/Steer/Fast；Cursor/Devin 的 busy task 队列晋升无法稳定绑定时保留 `UNSUPPORTED`，`send_message` 仍可按原生能力工作；排队项只能精确 queue remove，不得以 Stop 正在运行的其他轮次代替。

### F4（P2）交付完整性和原有暂缓项：收尾而非重新开发

- **交付完整性**：当前 Git 工作树含大量历史未提交改动和新文件，`HANDOFF.md`、新增 `server/agent/control.mjs` 与 `server/integrations/ra-mcp/*.mjs` 等可能仍为 `??`。对照 `final-source-sha.json` 列出新版启动必需的全部文件、是否被忽略、是否已纳入拟交付文件清单；避免正式打包/提交遗漏新共享模块。不能把旧工作树所有未跟踪内容一律当本轮改动，也不能擅自 `git add`/提交/推送/发布。
- **验收边界**：原 2 项用户暂缓（Codex 原生任务清单、自然容量不足后的手动重试）及 3 项 Android/iOS/Windows 等平台排除继续按现状记录，**未获新要求不重测**。不处理已卸载旧 QA 连接，不顺手修复此前另列的目录同名上传问题或其他无关产品缺陷。
- **完成时交付**：列出本次真正修复/补证据的项目、A 机实际新测与复用旧 PASS 数、明确仍未验证/原生不支持项、Git 和源码 SHA、是否触及 B（正常不需要），并据实际证据更新发布判断。不能将协议/静态检查视为真机执行证据。

### 执行顺序与停止条件

按 **F1 → F2 → F3 → F4** 处理；F1 是明确接口缺口，F2 是证据完整性，F3 是环境能力判定，F4 是交付整理。每步先复用现有通过证据和原生会话，**A 机能验证的全部在 A 解决**；只有实际修改涉及物理跨机协议或 B 运行内容且 A 无法证明，才说明原因使用 B。逐步记录变更的源码 SHA 与受影响 case，避免重复验证未改代码。未授权的破坏性操作、额外窗口、提交、推送、重启生产服务和发布一律不得进行。

**以上为执行前的核查依据。实际改动与证据见下方。**


### F1 执行结果

- A 机读取通过。MCP `read_session` 复用 Codex backend chat、Codex desktop scoped extract 和 Cursor/Devin 原生 history 投影。新增 `session-history.mjs`，更新同目录 `tools.mjs`、`errors.mjs` 与 `docs/integrations/ra-mcp.md`。手机端、Native Adapter、ROUTES 与共享解析源码无改动。历史页最多 30 条，按原生顺序投影用户、助手和状态消息，游标绑定会话和项目，区分空会话、近期尾页与读取不可用。
- A 配对浏览器确认 Cursor/Devin 的窗口和会话绑定。现有真机通过 MCP dispatcher 读取 Cursor 7 条、Devin 23 条，匹配已知原生回复，三页顺序与默认页一致。Codex 后台 6 条与真机 `thread/read` 的手机端投影逐条一致，分页到尾，切换旧会话后数据隔离，空会话正常。目录越权、scope 不足、窗口错误、跨会话/无效/过期游标及已归档会话拒绝。脚本只读，模型请求和新窗口均为零。
- 最初 Codex 长历史样本已归档，真实状态核对后用现有未归档会话完成验证。Codex 桌面本轮仅有正在使用的工作窗口，桌面专属路径未真机验收。新版外部连接未重新加载，本阶段本机证据覆盖 MCP dispatcher 与 Native Adapter。OpenCode 原有路径和 PASS 复用。旧插件的 E5 证据保留并标为 RETIRED。
- 证据 `_shots/ra-agent-control-20261125/f1-native-read.json`、`f1-codex-read.json` 与 `incremental-acceptance.json#followup.F1`。下一阶段 F2。


### F2 执行结果

- 核对 84 项旧 `PASS_REUSED` （其中 72 项声明文件哈希），24 项漂移均找到与旧哈希完全匹配的归档源码和真实浏览器 PASS。逐项记录原始执行时间、断言、报告 SHA、新旧依赖 SHA、快照时间边界和实际调用路径。
- Cursor 详情使用 `data-ttoggle`。Devin 任务清单和子任务的折叠、加载与路由保持原行为。History 差异仅为 Cursor 的子会话按钮路由。16 项文件用例只使用浏览、预览、编辑、引用、文件操作或下载，Transfer 差异只触及上传。模型与额度的差异只新增 Cursor Fast 路由。其中 Cursor 模型切换继续复用 E2 真实切换、回读和恢复证据。
- 结论为 23 项 REUSE_PASS、1 项 COVERED_BY_DELTA、0 项 RUN_REQUIRED。未重跑上述浏览器用例，既有 214 项覆盖状态总数保留。原始覆盖文件原样存档，更新最终增量台账。证据 `_shots/ra-agent-control-20261125/f2-dependency-audit.json` 与 `f2-historical-dependency-diff.patch`。下一阶段 F3。


### F3 执行结果

- A 机只有一个现有 Cursor QA 工作台。它的实际项目在旧浏览器验收目录，超出 3961 的 `RA_MCP_TEST_ROOT`。只读 MCP 能力核对复现 `can_create_session=false`、`can_create_task=true`，仍有 16 个已授权可绑定会话。
- 同一窗口的原生项目定位可用、无信任弹窗、Agent 空闲、无等待或草稿。手机端 `projectWindowState` 同时报告当前窗口终端占用。将能力发现函数仅对这个已知项目做只读对照时，窗口通过 MCP 初筛，实际创建仍会经过手机端相同的窗口占用检查。这样的初筛值不等于创建回执。
- 结论 `CONDITIONALLY_UNAVAILABLE`。两条创建路径都复用 Cursor `createProjectChat`，现有证据没有相同授权且窗口可用时手机端成功、MCP 错拒的情形。未改代码，未调用创建，未更换窗口、结束终端或放宽 QA 范围。证据 `_shots/ra-agent-control-20261125/f3-cursor-window.json`。下一阶段 F4。


### F4 执行结果

- 用 E5 归档还原三份修改前源码并核对原 SHA，得到可独立审阅的 F1 精确 diff。E5 的 19 份源码及说明中其余 16 份 SHA 一致。F1 新增模块和共享依赖均可解析，清单覆盖 170 份文件和 663 条相对导入。51 个必需文件仍未跟踪且未被忽略，其中包括 HANDOFF、共享 control、MCP 各模块。现有运行源码清点规则包含全部运行依赖，提交或打包时应以清单核对，Git 仅取已跟踪文件会漏掉这些源码。MCP SDK 在声明、锁文件和 A 实际安装中均为 1.32.2。
- A 机 `npm run check`、`git diff --check` 和精确 diff 空白检查通过。原生回执独立复核时，Cursor 与 Devin 的消息 ID 和正文 SHA 与原有真实记录吻合。另各读一个较早会话，得到 4 条原生消息，前台会话未切换。通过临时本机 MCP HTTP 切面验证新版 `read_session` 的 schema、鉴权、真实 Codex 后台分页响应和超限拒绝。该切面没有修改现有 QA 或配对数据。
- 复用 199 项既有 PASS 和 10 项已覆盖增量。F2 只更新其中的 24 个漂移项依据。2 项用户暂缓及 3 项平台排除维持原状态。Cursor 创建受当前窗口范围和终端占用限制。Codex 桌面历史缺少可用隔离窗口，外部新版 `remote_agent_A` 连接也未加载这次源码，二者保留 NOT_VERIFIED。旧 QA 插件已退役。
- 现存可读样本没有原生状态条目，也未超出原生近期窗口。状态角色投影、正文截断和 `native_earlier` 仅通过协议检查，记录为 `PROTOCOL_PASS`，未计入真实原生 PASS。证据 `f4-projection-shape.json`。
- 当前可作为待发布候选继续交接，尚未达到可直接发布标准。未使用 B，未改变物理跨机协议。A 正式服务、配对和隧道未动。没有新原生窗口、模型请求、暂存、提交、推送或发布。
- 证据在 `_shots/ra-agent-control-20261125/`，包括 `f4-source-manifest.json`、`f4-evidence-review.json`、`f4-mcp-http.json`、`f4-older-native-reads.json`、`f4-exact-f1-diff.patch`、`f4-static.log` 与 `f4-final-git-status.txt`。总台账 `incremental-acceptance.json`。


## 2026-11-25 — ChatGPT 通过新版 RA A 插件完成 Codex 桌面原生最终定向验收

- 用户授权使用 A 机 RA 插件进行最后一轮真实原生软件验收，可选只验证一个 Agent。本轮选择 **Codex 桌面**，以补齐此前 F1 `Codex desktop-history` 的真实缺口，不重测旧 PASS；未使用 Cursor、Devin、OpenCode，也未使用 B。
- 目标为现有 A QA 原生 Codex 窗口 `CF81D7FAE0FE359A46660D2B5F62624B`、线程 `01a210c4-975e-71e0-8564-80ee494df6e5`。原生读回 `gpt-6.2-sol` / `high` / `Fast (priority)` 均已选中，因此无需改设置。
- RA `submit_task` 通过同一既有会话派一条仅要求固定标记回复、禁止读写/命令/工具的任务；task `195dba9c-ba22-4941-bca1-15dfb9584793` 原生提交被确认，`get_task` 与 `read_task_output` 均为 `COMPLETED`，唯一答复 `RA_FINAL_CODEX_20261125_OK`。随后由新的 MCP `read_session` 从**桌面会话真实历史**独立核对相同用户指令与助手回复，`preview_only=false`。另用 `limit=3` 实际读取连续两页各 3 条，原生消息 ID 无重叠，游标有效，状态消息 `context-compaction` 也被投影。
- `operation_status` 对 `submit_task` 仅是提交瞬间的 `RUNNING` 持久回执，不代表任务最终仍运行；最终以 `get_task` 的 `COMPLETED` 和历史回读为准。没有重复发送、没有新开窗口、没有对其他 Agent、B、3939 生产服务做操作。
- 本轮将 **F1.codex.desktop-history** 从 NOT_VERIFIED 更新为“当前 A 机新版 ChatGPT RA 插件真实桌面调用 PASS”，证据 `_shots/ra-agent-control-20261125/final-native-codex-ra-20261125.json`；其他先前未验证项、平台边界与 Git 未跟踪交付问题保持原状。此为定向完成证据，不等于自动宣布整个 RA 已可发布。
