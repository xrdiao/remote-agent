# Devin 默认 IDE 与 Cursor 恢复方案（2026-10-29）

本轮只读排查并提出方案，未修改产品代码、切换原生视图、打开或关闭项目、切换原生会话、发送聊天、发布、重启或重新配对。当前源码含此前已交付的 v305 本地修改，全部保留。先读 AGENTS.md、development-requirements.md、基准索引及 02、03、08。

## Devin

用户明确要求：RA 默认使用 IDE view，发现绑定的是其他视图时先完成 IDE 交接再读取；这项要求目前是待实施方案，不能记为已实现。

确定的代码缺口：

- `server/apps/devin.mjs` 的 openDefaultSession 只在当前已为 editor 且没有 composer 时打开聊天面板，不会把 Agents 交接到 IDE。listAgents 和 openAgent 仍按当前 surface 分成两套目录、身份和打开路径。
- setSurface 已有按原生视图和会话目录寻找对应窗口的交接能力，但普通进入／列表／导航没有统一执行 IDE 准备。新版独立 Agents 与项目 IDE 可以是不同窗口，不能只依靠旧 switch-segment 按钮。
- 当前 IDE 列表 editorSessions 使用 sessionPickerRows(true)，共享窗口快照却用 agentList；前者沿原生 filterActiveSessions 和 connector 过滤，后者只过滤归档。后台与主动读取的目录口径不一致。
- `server/agent/projects.mjs` 中 projectWindow 分支对其他 IDE 窗口仅列 devinSession().tabs，没有读取同一完整目录，也没有保留这些行的完整 workspace 元数据。项目尚未进入时可能只显示已打开的少数标签。
- 切换和恢复必须先用会话实际 cwd 定位项目 IDE，再在该 IDE 打开会话；不能把 Agents 或其他项目的目录缓存直接当成当前 IDE 可点击的目标。

本机只读事实：当前可发现的 Devin 窗口为 editor，旧 switch-segment 按钮数为 0；原生选择器目录 35 条有效 ID、14 个项目，其中 27 条属于当前 IDE 项目之外。当前原生 store 有 42 条，通用 agentList 有 39 条，说明目录来源的过滤口径有差异，不能直接把条数差异都称为漏会话。当前只有一个可发现的 Devin IDE，未重演用户在两种 view 间切换或跨项目打开失败的完整操作。

拟修改：

1. 在 Devin 导航入口统一准备 IDE 目标：已有对应项目 IDE 优先复用；当前是 Agents 时按目标会话的项目目录完成 IDE 交接；没有该 IDE 时走既有项目打开流程。目标目录未知时返回可选择项目的明确状态，不随意绑定其他项目、不创建会话。
2. 冷启动、切回 Devin、主动读取列表及打开会话共用这一次准备结果；后台轮询不反复切视图、打开窗口或抢焦点。IDE 聊天面板未打开时沿现有初始化打开，确认真实输入与首屏就绪。
3. Devin 主动列表、共享目录和其他窗口目录统一使用同一份原生有效会话目录与 ACP ID／cwd 元数据。已打开标签只提供当前／已打开标识，不充当全部历史目录。只在 Devin 专用分支调整，不改变 Cursor 目录算法。
4. 同项目在当前 IDE 换会话；跨项目先按真实路径／主机匹配或打开 IDE，再打开目标 ID，最后核对会话身份和正文。绑定、列表、缓存及回包均属于最终 IDE 目标。失败复用既有导航结束／回初始页流程，不持续停在加载，不自动切其他 Agent。

预计位置：server/apps/devin.mjs、server/page/devin.js 及 server/page/agents.js 的 Devin 专用读取；server/agent/projects.mjs 的 Devin 目录／归属分支；如进入绑定前需要调用目标准备，仅调整 server/session.mjs 的 Devin 接入，不重构公共导航。共享窗口读取如需接入同一目录，只调整 Devin 对应数据源。

## Cursor

既有复现：上轮配对浏览器恢复 Cursor 报“这条 Agent 已经不在列表里”；按用户要求仅记录，随后使用实际可用窗口完成公共连接验收，不能把该测试说成旧目标已恢复。

确定的代码缺口：server/apps/cursor.mjs 的 openAgent 依赖 agentTarget 定位。server/page/agents.js 的 agentTarget 优先查已打开 tab／侧栏行；未命中时的原生命令路径还要求 __SSG_COMPOSER_PROVIDER__ 及正文 DOM 上的 uiContextMenuServices。原生会话存在但尚未挂载、首页／空白页没有正文、侧栏折叠／虚拟化时，找不到 DOM 不足以认定原生目标不存在。已存在 cursorSessionServices 及原生 composer 服务，不需要另建手机侧恢复系统。

本次只读实查：两个 Cursor 窗口原生未归档目录分别 19／14 条，界面列表 16／13 条，各有 3／1 条原生存在而未列于当前界面。6 个入口有 Cursor 恢复记录，其中一条旧窗口已不在，但会话仍在现存窗口的原生目录内。本次没有打开这些会话；不能断定上轮报错一定对应其中某条记录，也不能把所有旧记录称为会话已删除。

拟修改：

1. 继续按稳定电脑 ID＋配对入口 ID 保存项目路径／主机、原生会话 ID。窗口 ID 是定位提示；先匹配真实项目，窗口关闭时复用同项目窗口或按既有规则打开，不将旧 ID 直接交给其他项目。
2. 原生会话目录是存在性依据；会话打开由 Cursor 原生打开服务完成，不再要求侧栏行或正文 DOM 预先挂载。不扩大去扫全部会话正文、不清空所有恢复记录、不通过更长循环等待列表出现。
3. 打开后沿现有 cursorChatReady 确认实际目标和首屏；仅 ID 改变不算完成。原生明确不存在／已归档、项目失效或真实读取失败要分别反馈；失败保留真实原因，并按既有流程清理当前入口该 Agent 的失败目标及回初始页，不影响其他入口、其他 Agent 或原生会话。

预计位置：server/apps/cursor.mjs、server/page/agents.js 的 Cursor 打开路径及现有 cursorSessionServices；若项目重开确认仍仅以 DOM 列表判断，局部调整 server/agent/projects.mjs 的 Cursor reopening 分支。原入口记录格式和全局失败处理不新增另一套。

## 影响与验收边界

直接影响 Devin 默认进入、视图／IDE 窗口交接、完整项目目录、同项目／跨项目切会话及恢复；Cursor 仅影响原生会话打开和旧恢复目标解析。绑定成功后的草稿、运行态与首屏归属属于必要联动检查，不重写发送、停止、模型、通知、滚动、历史分页、文件、语音或 Codex／Fusion 业务。原生后台任务不因切换停止。

实施后复用现有配对浏览器一次性检查：Devin 当前 IDE／当前 Agents／仅有 Agents／目标 IDE 未开、未打开历史会话、同项目换会话、跨项目、切走后返回及刷新恢复；Cursor 目标已打开／未挂载、旧窗口关闭而会话仍在、原生目标真正不存在、跨项目、独立入口记录隔离和失败回初始页。只检查修改及受影响链路，未实际覆盖的场景单列，不把只读状态检查当作已通过交互。产品代码仍需用户确认后实施。

证据：`_shots/devin-ide-cursor-restore-audit-20261029/summary.json`、`catalog-summary.json`；包含真实原生标识和恢复记录的 native-private.json 只留本地，不公开内容。
