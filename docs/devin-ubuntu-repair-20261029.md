# Devin Ubuntu 新版适配修复与验收

日期：2026-10-29。应用 Devin 3.11.228，编辑器基座 1.126.0；RA 交付版本 v303。对照既有 Ubuntu 基准 0a80c53 和当前 RA 功能基准，保留实施前 v302 的本地修改。仅修复 Devin 专属实现和公共文件中明确属于 Devin 的分支；未修改 Cursor、Codex 的适配代码或 RA Fusion。前端业务未改，仅更新缓存版本。

## 已实施的修复

| 功能 | 实现及保留的行为 |
|---|---|
| 窗口和项目 | 依据原生窗口配置区分独立 Agents 和项目 IDE。Agents 的底层编辑器目录不参与 IDE 项目匹配，当前目录仍取所选会话；避免切项目／切 Editor 又回到 Agents。 |
| 新项目初始化 | 项目 IDE 先打开原生聊天面板，再确认输入；冷启动与项目打开都接到这一步。没有将空白输入页强行变成历史会话。 |
| 会话身份 | 规范化本地 transcript 包装 ID、Cloud 原始 ID 与 ACP ID。正文、侧栏、目录、操作及当前标记使用相同身份。 |
| 会话目录与导航 | IDE 的列表及导航查询均读取原生会话元数据，不因没有侧栏而返回空目录；同项目保持窗口，跨项目才匹配／打开项目 IDE。点击会话主链接，与展开和更多按钮分离。 |
| 界面交接 | Agent／IDE 在目标原生窗口完成绑定及会话选择后结束切换，再沿现有流程发布就绪和首屏；不在待切换状态中等待首屏而形成互等。 |
| 正文和工具 | 识别新版 transcript，并读取 `collapsed_work` 内的思考、命令和工具记录；不需要把电脑上的工作记录展开。索引继续对应原生消息，未引入手机阅读锚点。 |
| 实时状态 | Devin 的原生 store 变化接入现有更新监听；运行状态取实际会话元数据，不以聊天是否挂载推断。保留现有耗时和消息确认通道。 |
| 原生错误 | 将当前会话的真实错误横幅传到手机，保留原文和归属；不将原生拒绝掩盖为成功生成。 |
| 参数入口 | 本地模型配置保持原有家族／变体路径；Cloud 首页根据真实启用 capability 和原生选择回调提供菜单。不混用 RA Fusion 状态。 |
| 会话管理 | 接入新版 `menuActions` 及 IDE 的原生命名／归档回调。原生没有删除时提供归档；批量管理复用相同动作和确认。选择器已打开时不反向关闭，只收起本次打开的选择器。 |
| 终端 | 从 Agents 发起新终端时路由至对应项目 IDE，复用既有终端实现，不继续寻找已消失的双段切换按钮。 |

涉及 `server/apps/devin.mjs`、`server/page/{devin,agents,chat-extract,menus,session-actions}.js`，以及 `lib/files.mjs`、`server/{session,agent/projects,agent/session-actions,agent/terminal,agent/updates}.mjs` 的 Devin 分支。未改共用业务算法、发送协议、手机滚动、通知投递、语音、PDF 或其他 Agent 的实现。源码快照差异检查确认原有 Codex／Cursor 适配器、Codex 注入、窗口数据源、操作结果模块、路由及 WebSocket 代码保持本轮开始时的内容。

## 验收

小项只做内部检查，产品改动收齐后复用原配对 Chrome 统一检查。统一阶段发现的问题继续在 Devin 范围修复，仅补验失败项及受影响功能。

已通过的实际配对检查包括：

- 原生会话绑定；用户消息、回复、思考和折叠命令展示。
- 本地 33 项模型读取及当前原生配置重选；Cloud 首页 10 项可用选项读取，以及 Normal → Fusion 的实际往返选择。
- 新 IDE 的原生输入面板初始化；普通消息的电脑端接收确认和手机展示。
- 电脑端原生重命名确认；隔离会话通过既有批量路径完成真实归档。
- 同项目换会话保持同一个 IDE；跨项目打开指定已有会话，正文和工具记录完整出现。
- Agent → IDE → Agent 窗口往返保留同一会话；从 Agents 入口创建终端，实际落到对应 IDE 项目。
- 手机显示原生 `Permission denied: internal server error: error number 13`。

`paired.json` 保留 19 个不同的已通过场景，以及初始化阶段最初误将“窗口已绑定”视为完成的失败记录；后续“native composer before reporting ready”场景记录其修复补验。检查脚本早期丢失 `showMenu` 参数、使用不存在的 `newChat` 命令等错误均已纠正，不计作产品问题或通过证据。

`npm run check` 通过：98 个文件语法，102 个发送类型、69 个回包类型，196 个注入导出，65 个模块导入。`git diff --check` 通过。

## 真实限制与恢复情况

1. 新建本地 Devin 测试会话的消息确实被原生接收，但随后 Devin 自身显示 `Permission denied: internal server error: error number 13`，原生状态为 `unknown_error`／blocked，部分新会话也没有载入模型配置。这不是成功生成。未修改 Devin 安装、账号、权限或上游服务来绕过它。
2. 因上述原生拒绝，成功生成、运行中排队／立即发送／停止、真实 Question／审批、新会话的模型参数写入和长历史连续分页不能宣称正向验收通过。原有已存会话内容可读取；本轮没有以受控数据冒充这些实际操作。
3. 本轮复用原配对，无新增授权。仅清理本轮测试项目窗口，原 Agents 窗口保留并回到首页。原空白 IDE 窗口被 Devin 原生项目导航替换；测试窗口已关闭，未宣称原空白窗口 ID／布局完整恢复。
4. 恢复开始前的 Codex 选择时，其原生 `Runtime.evaluate` 超时。原窗口仍存在，未修改 Codex 代码或刷新其原生页面，未将原会话恢复记为通过。原草稿为空，保持为空；界面停在 Codex 的加载失败状态。
5. 未测试 Windows、实体 Safari／iOS／Android、真实第二台电脑或 RA Fusion。未经本轮修改的功能不重复检查。

## 发布及证据

缓存版本更新为 v303，中继沿原环境与 `--tunnel` 参数重启，gh-pages 同步仅包含前端缓存版本元数据。本轮没有提交或推送 master／debug。

本地证据目录 `_shots/devin-repair-20261029/`：

- `source-before.json`、`source-before/`、`scope.json`：实施前快照及限定修改范围核对。
- 原生窗口、目录、正文、模型、操作及错误结构的 `*-private.json`：内部实际数据，不对外分发。
- `paired.json`、`paired-final-devin.png`：统一配对验收及补验。
- `send-diagnostic-private.json`、`current-native.png`：原生拒绝生成的实证。
- `restart.json`、`native-cleanup.json`、`delivery.json`：中继重启、测试窗口清理、发布与配对核对；以实际记录的布尔值为准，恢复失败不改写为成功。

报告不包含配对凭据、账号数据、用户会话 ID 或无关会话正文。
