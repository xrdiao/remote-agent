# Agent 适配接口与首轮迁移方案

日期：2026-10-22。状态：用户已确认1、2、3范围；静态注册、能力声明及Cursor试点已实现并完成定向验证（v178）。用户已确认继续接入Devin（v179），Codex自身能力登记及主要公共路径定向验证已完成，原有模型/强度回调经用户另行授权最小修复并通过配对定向验证。编排Fusion随后接入，受控配对验证及限制见文末。

本文依据现有实现梳理，不把接口表当作重写全部模块的施工单。沿用[接入计划](agent-adapter-plan.md)和[开发要求](development-requirements.md)。

## 已有基础及边界

当前已有统一入口：`server/apps/index.mjs` 的 `ADAPTERS` 根据 `app` 返回适配对象，Devin/Codex复用Cursor适配对象后覆盖专属行为。公共方法位于`server/agent/`，原生操作位于`server/apps/`及`server/page/`。但应用描述在`EDITORS`，若干页面还按Agent名称判断功能；各家methods被合并到同一个`AgentContext.prototype`，不能假定拆一个文件就能隔离全部依赖。

首轮保留公共连接、排队、窗口选择、聊天缓存及原生页面助手，不另建插件系统，不把Cursor当前承担的共享默认方法整体搬走。Fusion是编排层，继续调用真实Agent；独立文件传输、配对、语音、主题属于公共能力。

## 基础接口与现有落点

以下是接口职责的明确约定；优先使用表内现有方法，不引入同义包装。

| 职责 | 现有入口 | 输入与返回约定 | 完成条件 |
|---|---|---|---|
| 描述、发现 | `EDITORS`、`listWindows`、`codexWindows` | 稳定app标识、名称、连接地址；返回底层窗口目标 | 顶层按app合并，底层保留窗口ID；失败与没有窗口分开 |
| 连接、释放 | `Session.attach/openBound/detach/dispose` | app、windowId、threadId、initial/projectSwitch | 接到指定目标；detach只释放连接与监听，不关闭桌面项目 |
| 聊天读取 | `pollChat`调用`extract` | 消息、busy、draft、thread及可选字段 | 结果仍属于当前连接/选择，空白新会话也可更新模型和草稿 |
| 输入、发送 | `sendMessage`→`adapter.typeDraft/submitPrompt` | 正文、引用、submit、when、receipt；保留queued返回 | 桌面已接受才确认，不能把点击成功当作发送成功 |
| 停止 | `stopAgent`及原生控件 | 当前明确选择的会话 | 操作该目标；不由共同接口解释各家的取消范围 |
| 项目、会话 | `useProject/newProjectChat/listAgents/openAgent`→对应adapter | 原生项目路径、窗口和会话ID；列表保留当前/运行标记 | 项目归属正确，繁忙窗口保留，不因切会话改写cwd |
| 新建 | `adapter.newChat`、`finishProject` | 所选项目；允许尚无正式thread | 原生空白输入区就绪且已知工作目录匹配；正式ID可在首次发送后产生 |

现有方法有的返回数据，有的经`emit`返回消息；首轮不强行改成统一Promise对象。接入表明确每个方法属于哪一种，避免同一动作既自行emit又被公共层重复确认。原生不支持与当前控件暂时不可用必须分开；首轮沿用原错误/状态协议，不借迁移重做错误系统。

## 能力声明

注册项引用现有adapter对象，同时声明可选功能；不根据“方法存在”推断支持，因为现在有继承方法和空实现。

| 声明项 | 现有实现依据 | 需要保留的原生差异 |
|---|---|---|
| model / effort / fast | `pickModelMenu`、`pickMenu`、原生选项 | 当前模型可无强度或Fast；不声明所有模型都支持 |
| queue / steer / queueEdit | `submitPrompt`、`queueAction/editQueued` | 排队、立即追加、取出编辑语义独立 |
| questions / approvals | 原生questions、codexRequest等路径 | 提问与命令审批不同，批准范围及操作目标原样保留 |
| attachments / fileReferences | `attachImage`、`mentionQuery`及发送插入 | 手机图片与文件引用分开；Cursor的mentionQuery当前为空实现，不能声明已支持此引用查询 |
| editor / terminal | `withFiles`、`newTerminal`及公共终端 | 是否有可绑定编辑器/终端由当前窗口决定 |
| settings / usage | `showSettings`、`accountUsage/usageContext` | 设置栏目、额度窗口及缓存来源保留各家实现 |
| fork / extraActions | 原生消息操作 | 不给不支持的Agent造无效入口 |

静态声明只表达“实现支持”。当前窗口状态另表达“available及原因”，例如受限、未登录、没有终端目标或当前模型无选项。状态从现有连接/菜单读取结果取得，不为能力探测增加后台轮询。手机不支持时隐藏入口，当前暂不可用时保留原因，不能用空菜单冒充不支持。

独立文件传输等公共功能不放入每家adapter重复声明。Fusion展示其所选A/B当前实际可用能力，不另编造一套固定模型/审批能力。

## 数据与生命周期

身份始终分为app、项目的原生路径/主机、windowId和threadId，不能互相替代。临时空白会话由当前绑定窗口和连接代次区分，不伪造正式threadId，不写入其他项目的正式历史。

生命周期约定：

- 连接/创建中：保留所选目标，显示实际阶段；不能因瞬时空内容切回旧会话。
- 需要登录或信任：明确提示，信任必须由用户确认；拒绝沿既有规则返回可用窗口。
- 空白可输入：thread可为空，模型、强度、draft可正常同步；不能宣布加载失败。
- 正式会话：首次发送取得原生ID后迁移临时草稿/发送占位，只绑定一次。
- 释放：停止本连接监听、定时器和读写；迟到结果不更新新的选择，不关闭桌面窗口。

消息继续沿用`i/k/t/h`及已有可选字段。明确语义：human、assistant、thinking/工作说明、tool、编辑、tasks、notice不得仅按标题混判。工具的执行/读取/搜索/编辑类型、运行/完成结果、失败和待操作状态供共用界面使用；本次执行指令开关的kind/execution/done/keep语义保持，首轮不进行字段批量改名或历史数据迁移。原生按钮保留请求ID/操作目标和索引，不转换不同Agent的批准范围。

## 推荐试点：Cursor

Cursor现有适配对象已覆盖基础发送和会话方法，并且其普通编辑器窗口不涉及Codex双连接、Devin双界面。适合先验证描述/注册与能力驱动入口。注意它同时被另外两家作为默认适配来源，因此首轮不删除默认继承、不移动所有Cursor methods，也不统一页面提取器。

建议确认的首轮范围：

1. 在现有`server/apps/index.mjs`组织静态注册项，复用`EDITORS`配置与现有adapter；保留`ADAPTERS`现有调用入口，避免改所有调用方。
2. 登记明确能力与当前状态的数据约定；先让Cursor的手机菜单Editor、模型/强度、文件引用入口依据声明显示。其他Agent继续原行为，不因Cursor登记而继承其能力值。
3. 由已有attached/相关状态消息携带声明，不添加轮询或在每个聊天快照重复发送；精确的协议字段和直接改动文件在实施时核对。
4. 对照本表检查Cursor基础方法的完成条件；只迁移为落到注册项必需的调用，不附带窗口发现重写、原型全拆分、聊天格式重做或终端/语音优化。

预计直接修改落点：`server/apps/index.mjs`、`server/config.mjs`（仅确有重复描述时）、`server/session.mjs`的连接消息、手机菜单/连接状态处理，以及必要协议检查。Cursor原生适配和页面助手尽量保持。第一轮不宣称解决新增Agent的全部接入成本；试点通过后，再决定如何逐家收拢methods，最后用真实新增Agent验证模板。

## 定向验收及停止范围

用独立目标/配对浏览器验证Cursor连接、一次发送/停止、切换/新建及空白到正式ID、模型菜单、项目文件和终端；是否发送真实测试消息先明确测试目标，不使用当前工作任务。检查其他Agent声明不串用、Fusion调用不变、不可用状态不被缓存覆盖。记录CDP调用数、监听释放、历史/工具显隐与阅读锚点，必要检查通过后不重复全量测试。

## 本轮实际交付（v178）

用户已确认上述Cursor试点。`server/apps/index.mjs`的`AGENT_REGISTRY`复用EDITORS元数据，登记discover、adapter、methods及可选capabilities；ADAPTERS从注册表派生，原getter、默认继承与methods合并顺序保持。连接入口按注册项发现，Codex双连接和其他原生差异不重写。

Cursor在自身模块声明model/effort/fast、queue/queueEdit、questions/approvals、attachments、editor/terminal、settings/usage、extraActions；steer、fileReferences、fork为false，表达当前Remote Agent接入能力，不代表桌面产品本身绝对不具备。Devin/Codex没有继承Cursor能力值，未迁移前保留原入口规则。

仅attached消息携带已迁移Agent的静态`capabilities`。手机`supportsCapability(name, existing)`区分已迁移声明与未迁移旧规则；`capabilityState(name)`返回`{supported, available, reason}`，复用认证/连接、信任状态、已知readonly及对应模型菜单结果，不额外探测或轮询。空白/缓存加载期间不凭缺少快照阻止原缓存菜单刷新；模型变化沿原规则清除旧effort缓存。不支持隐藏入口，当前无强度选项保留能力、给出原因；Editor、模型/强度、Fast和文件引用的相关入口已接入。

配对浏览器在独立Cursor窗口完成真实新建、Auto/另一模型切换、无effort状态、文件高亮、终端收发及pwd目录、发送与流式回复、停止、第二会话与两次切换；原5个窗口/thread保留，测试前Grok4.7偏好已恢复。只读验证Devin/Codex提取，Fusion计划/执行/评审/完成为受控回归，未做真实双Agent轮转或实体手机完整验收。连接/释放与HEAD基线对照CDP调用数相同，observer binding及定时器正常释放。

测试限制：历史会话回放后原生模型菜单曾偶发空列表；本轮未改原生菜单读取方法，改在独立空白会话恢复测试偏好并确认成功，不声称修复该既有现象。完整数据与发布结果见development-requirements.md及_shots/cursor-adapter-pilot/。本轮到Cursor试点为止，后续其他Agent迁移、新Agent接入和大规模原型拆分均未开展。

## Devin 接入（v179）

Devin在自身适配模块声明能力，注册表引用该声明，随原attached消息发送。沿用已有Session生命周期、公共操作入口和Devin原生adapter，未改原生方法及methods合并顺序。fileReferences和steer为true；steer在Devin表示原有“立即发送、打断当前任务”，不能当作Codex的流式追加。queueEdit保留取出至输入框的语义。当前模型、界面和原生控件决定是否实际可用；原生Fusion仍只提供Lead强度，并按原配置读取费用。

已接能力的模型、强度、Fast、Editor与文件引用入口直接使用Devin声明；忙碌时排队/立即发送分栏、队列编辑按钮及设置入口也读取声明。Cursor的steer=false继续只有原排队入口，Codex及编排Fusion保留未迁移的原规则。没有添加后台探测、新轮询或重复聊天字段。独立文件传输、语音和主题保持公共服务。

配对浏览器已验证独立Devin项目的新建、发送/流式、停止、会话往返、队列取回、模型/强度与原生Fusion费用、文件引用/高亮、终端及设置；原窗口和设备保留。用户另行授权修复只读终端误判导致的新建阻塞，已定向及实际验证。连接/释放CDP次数不变。完整记录与验证限制见development-requirements.md；不宣称已完成实体手机全功能或真实编排Fusion验收。

## Codex接入

注册表引用Codex自身声明，沿用其原adapter及双连接；所有声明仍只随attached传递，不新增探测。原生队列/追加由codex.follow和既有submitPrompt决定，与Devin打断语义分开。保留原生审批请求、文件引用、设置、终端、Fork等专属方法。独立配对验证覆盖新建/正式ID、会话往返、文件/引用、终端、发送/流式、停止、原生Queue/Steer入口、设置及能力状态，双连接CDP次数和释放保持。原有模型直调回调曾实测未生效，用户另行确认后仅修复Codex菜单助手：按原生双参数提交模型/强度，并读取当前reasoningEffort。配对浏览器已验证空白及历史会话的模型/强度切换、显示同步、草稿保留和切换后发送；目标不支持当前强度时沿用其原生默认值，受控检查覆盖Default路径。没有增加轮询或菜单重试。细节和清理/发布记录见development-requirements.md；本轮不做编排Fusion迁移或安全策略修改。

## Fusion 编排适配接入（v188）

注册表新增 kind=orchestrator 的 Fusion 项，不加入 EDITORS 的桌面发现列表。server/apps/fusion.mjs 的 attach 接收原请求并复用原 Fusion 连接流程；newChat/listAgents/openAgent/sendMessage/stopAgent/pollChat 分别委托已有 fusionOpenHistory/fusionListHistory/fusionUserSend/fusionStop/fusionEmit。它只桥接公共入口，不复制原编排实现、不重做原型分配。原 Session.attach、发送回执、Fusion 专属历史/停止/刷新路由已使用登记的适配器；各原生 Agent 的 adapter 和覆盖顺序保持。

Fusion 根声明 usage=true，其余现有可选能力为 false，表达编排界面自身不具备原生模型/审批/终端等控件；A/B 原生能力由注册表生成 attached.sideCapabilities，手机在换应用时清除旧侧声明。模型按钮及配置入口读取所选侧真实声明，仍由原生模型菜单决定当前强度和可用项。声明只在 attached 发送，未加入聊天快照、能力探测或轮询。原生审批、配置、费用、项目归属、Fusion 运行及交接流程均未改。

隔离配对浏览器通过完整方案/执行/检查、历史/新建、刷新和停止路径；A/B 回复为模拟，不宣称已完成真实双Agent任务、实体手机或全部原生组合验证。尚未实施新Agent接入、接入模板和后续性能阶段。
