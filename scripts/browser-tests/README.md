# 分区配对浏览器检测

依据 [全流程排查文档](../../docs/testing/full-functional-audit-v445-20261111.md) 的 F01–F21、R01–R12、X01–X12、S01–S10、W01–W15、M01–M07 组织。编号表示关联范围，**某个用例通过不等于整个编号内所有子场景通过**。原文档继续作为完整验收清单。

使用既有 `scripts/paired-browser.mjs` 和 `_shots/paired-browser.json` 的 Chrome 配对身份。操作通过页面点击、输入和文件选择完成；读取页面状态及只读目录接口核对会话身份和回执，不直接调用产品的发送、切换、审批或文件写入函数，不拦截接口伪造成功数据。

本轮实际检查与已发现失败见 [VALIDATION.md](VALIDATION.md)。

## 按改动快速检查

日常修改先看 `git diff`，选择受影响的软件和具体 `--case`，只运行对应的语法、协议、导出静态检查及定向浏览器场景。共用流程变动才扩展到四个应用的相关场景；完整套件仅在发布验收或明确要求时执行。已经通过且未受新改动影响的场景不重复运行。几分钟内能完成的是定向检查，模型真实生成耗时另计。

```sh
# 示例：只检查 Devin 草稿和跨项目流程
npm run qa:browser -- --suite workflow --case composer.drafts,sessions.project --apps devin

# 示例：只读检查四应用会话打开与模型数据
npm run qa:browser -- --case overview.card,conversation.body,models.read --apps codex,cursor,devin,opencode
```

同一配对浏览器配置仅允许一个执行器。锁记录位于 `_shots/browser-tests/locks/`，包含进程号；进程正常结束自动释放。强制终止后，先确认记录的进程已经结束并检查本轮 `resources.json`，再移除对应锁文件。不要并发驱动同一个浏览器。

同一会话的创建、草稿或发送前置条件失败后，后续依赖它的场景立即记录 `blocked`，保留首次失败，不重复等待 20 秒；其他会话及独立的菜单、文件等检查继续执行。草稿显式拒绝立即报错。每项结束关闭遗留文件预览、取消未处理的确认框，遗留遮挡计入脚本错误，原始产品错误不被收尾错误覆盖。不会自动确认未知操作。

`fold/models/commands/terminal` 复用本轮 A 会话，A/B、队列、生成、问题和文件修改按各自用途隔离。只读长历史和工具样本通过 `--targets` 登记并跨轮复用；真实问题没有产生时明确记录缺样本，模型已结束便停止等待。缺少长历史的会话不能代替长会话验收。

OpenCode 显式新建会话通过原生接口立即取得 ID，空会话无需发送标记消息即可检查；仅打开尚无会话的项目仍可保留未创建入口。`sessions.native-created` 检查四应用空会话的原生持久记录和电脑端目录，`sessions.id-read` 使用 `--targets` 中的 `devin.cold` 样本检查未在桌面展开的会话。`workflow` 不发送消息补造 ID。

生成场景只审批本轮隔离会话中含本轮标记的测试命令，使用手机卡片的单次允许按钮；不改变用户已有会话或全局审批设置。原生模型明确返回 API 无法连接时记录环境受阻，同批次后续生成不重复尝试。停止检查会展开输入区；收尾先停止仍在运行的测试会话，再按原生能力删除或归档。

常驻模拟测试、单元测试和通用夹具已删除。功能验收仅使用本目录的配对浏览器场景；精确时序／协议验证需要本轮临时夹具，放在 `_shots/`，用后删除。静态语法、协议和 page exports 检查继续保留。当前范围见 [COVERAGE.md](COVERAGE.md)。

## 执行

在仓库根目录运行，无额外依赖：

```sh
# 离线查看场景、软件、写入级别和原文档编号
npm run qa:browser -- --list

# 默认只读：连接、主页、打开已有会话、摘要、历史、工具、模型菜单、统计
npm run qa:browser

# 指定区块或精确用例，只跑本次修改影响的功能
npm run qa:browser -- --blocks overview,conversation --apps codex,cursor
npm run qa:browser -- --case overview.card,conversation.body --apps codex
npm run qa:browser -- --suite workflow --case files.invalid-path,files.operations --apps cursor

# 工作流：包含独立测试项目、草稿、重命名、模型切换、文件落盘、终端
npm run qa:browser -- --suite workflow --blocks sessions,composer,terminal --apps codex

# 完整自动化：额外发送真实消息、使用模型额度、排队、停止、问题与 Fusion 子任务
npm run qa:browser -- --suite full --apps codex,cursor,devin,opencode

# 重复导航与菜单读取；--max-open-ms 为可选的 P95 门限，不设置则仅记录速度
npm run qa:browser -- --suite stress --apps codex --iterations 20 --max-open-ms 1500

```

套件互相明确区分：`smoke` 只执行 `read`；`workflow` 执行 `read/write`；`full` 执行 `read/write/generate`；`stress` 只执行重复压力用例。未选中的写入／生成用例保留为 `not-run`，不会被算成成功。按 `--case` 筛选也需选对套件。

参数：`--registry PATH` 指定既有配对配置，`--computer ID` 核对执行电脑（需先在浏览器选择该电脑），`--timeout 20000` 控件和导航超时，`--generation-timeout 120000` 原生生成超时，`--fusion-app codex|cursor|devin` 指定主 Agent。Devin 沿用本机网络配置，脚本不设置代理。OpenCode 服务及本地模型需提前启动；脚本不会启动、下载或替换模型。

`stress.last-target` 每个阶段受 `--timeout` 限制，整组受 `--stress-timeout 180000` 限制。终端显示轮次，`stress-progress.jsonl` 记录各阶段起止及最后失败位置，`results.json` 记录该场景的导航代次、原生连接回执和首屏发布。

检测进程必须运行在**配对执行电脑本机**，以便创建隔离目录、核对真实文件、驱动本机浏览器。不能用当前电脑的文件系统核对第二电脑。

## 长会话样本

默认只读用例选择各软件的空闲会话。历史和工具用例需要有对应内容的真实样本，可在 `_shots/` 写 JSON 后通过 `--targets` 指定：

```json
{
  "codex": { "A": "真实会话ID", "long": "包含分页历史和工具的真实会话ID" },
  "cursor": { "long": "真实会话ID" },
  "devin": { "long": "真实会话ID" },
  "opencode": { "long": "真实会话ID" }
}
```

```sh
npm run qa:browser -- --blocks conversation --targets _shots/browser-targets.json
```

指定样本不存在、没有更早历史、没有工具、模型没有产生原生问题等情况记录 `blocked`，报告缺少什么样本。脚本不会拿空会话替代长历史并计为通过。

## 区块与断言

| 模块 | 原文档 | 自动化检查内容 |
| --- | --- | --- |
| `connection` | F01/F02/F21，R12 | 原配对认证、WebSocket、设备管理、主动重连后会话与草稿、未授权目录请求 |
| `overview` | F03/F04/F05，R01/R02 | 栏目切换、折叠打开与展开摘要、600 字／3 工具限制、展开 A 打开 B、收藏恢复 |
| `sessions` | F04/F05/F09，M02/M03/M05 | A/B 独立项目真实路径、新建、切换、重命名原生回读、Codex 分叉与权限、批量选择取消 |
| `composer` | F06/F11，R10 | 正文／卡片草稿共享与隔离、真实发送回执、清空重进、后续草稿、输入历史、横竖屏折叠、长文本和斜杠、纯图片缩略图、队列修改删除／Devin 取回 |
| `execution` | F06/F08/F16/F17，R05/R06/R11 | 队列自然发送、队列立即发送、停止、生成中 A/B 导航、统计采样、原生斜杠菜单和 compact 候选 |
| `conversation` | F07/F18，R06/R07/R08/R10 | 正文与摘要身份、非空渲染、历史 ID 去重和增长、工具详情展开收起、横竖屏范围、OpenCode 空助手条目 |
| `models` | F08，S02 | 原生模型／强度／权限菜单、Codex 三种权限、切换回读恢复、百分比有效值及长小数 |
| `questions` | F09 | 本轮原生问题产生、A/B 切换保留、通用请求或 OpenCode 问卷回答回执 |
| `files` | F04/F10/F12 | 隔离中文文件预览编辑与落盘字节、错误目录重试、隐藏开关、复制/移动及同名处理、中文 ZIP 与空目录往返、真实上传／浏览器下载和 SHA-256 |
| `terminal` | F13，R03 | 独立 PTY、真实 cwd、命令输出、列表身份、终端→主页→B、输入折叠和保留命令 |
| `fusion` | F19，X01/X02/X03/X07/X08/X09/X10/X11/X12 | 目录及主会话身份、新项目配置、普通会话往返、关系面板、重命名和收藏恢复、主 Agent 直接回复、单子任务派发审阅交付、停止、清理 |
| `client` | F14/F15/F20 | 版本、PWA 清单、缓存信息、主题／语言切换恢复；设备专属项保留待验 |
| `stress` | F16，S01/S02/S03/S04/S07/S08 | 重复打开关闭、交替长会话、A/B 切换、模型菜单读取、逐次时延与中位数/P95/最大值 |

这些是实际代码断言的边界。例如队列“立即发送”不代替输入框的“立即追加”，统计对象存在不代替速度准确性，工具展开不代替所有文件差异、文件哈希不代替所有媒体格式。报告保留如下未自动化项，不宣称“全功能已通过”：

- F02/F21：新身份配对、2FA、撤销、重放、越权多目标；当前代码只自动检查原配对和未授权读取。
- F05/F06：批量实际归档删除、原生桌面双向编辑竞争、延迟发送回执覆盖新草稿、IME、`@` 文件 chip、输入框立即追加；清理优先执行原生删除，没有删除入口时执行归档并记录，未执行的另一种操作仍待验。Devin 本地连接器未声明归档能力，不能把删除成功算成云端归档通过。
- F07/F09：搜索／定位／复制全部分支、每种应用的折叠审批与过期问题、容量错误手动 retry、子 Agent 导航。原生模型未产生问卷时必须补样本。
- F10/F11/F12：PDF/音视频、图片编辑、文件引用高亮、目录上传、取消／断点恢复；普通 ZIP 往返和同名另存/跳过/覆盖已进入 `files.operations`，符号链接、失败回滚和平台命名边界需要定向浏览器场景或本轮临时夹具验收。
- F13/F14/F15：终端 Tab／历史／密码不回显／直接选择复制、音频／屏幕权限、系统键盘、真实前后台挂起、自然断线、推送、原生壳安装更新。
- X04–X12：Fusion 并行依赖、复用返工、原生审批、预算拦截、持久化恢复、两工作台串扰及重命名收藏；单子任务通过不代替这些复杂编排。
- S03/S05–S10：第二电脑、媒体、10 分钟资源稳定性、20 次工具详情、Fusion 面板压力及语音真机压力。默认 20 次导航不等于文档全部压力场景。
- W01–W15/M01–M07：平台专属启动、盘符/UNC、不同 Shell、PTY 恢复、双窗口与跨电脑；在 Ubuntu 执行不能记为 Windows 通过。

## 证据、清理与退出码

每次输出 `_shots/browser-tests/<时间>-<平台>/`：

- `report.md`：每个用例／软件的结果、原因和清理情况。
- `results.json`：版本、Git 基线、产品差异摘要哈希、断言、点击步骤、网络耗时和浏览器异常。
- `progress.jsonl`：逐项执行记录，中断也保留已完成证据。
- `resources.json`：本轮会话、终端、工作台身份，清理失败后便于定位；禁止按名称批量删用户资源。
- 失败截图：对正文、问题、输入框和摘要做遮挡；截图不上传。

状态为 `passed / failed / blocked / not-run / manual`。存在真实失败或清理失败退出 **1**；存在缺环境、人工待验或未执行退出 **2**；选中范围全部实际通过退出 **0**。不以跳过数换绿灯。

失败另外记录 `failureKind`：`product` 为直接观测的产品异常或原生拒绝，`automation` 为脚本操作或收尾问题，`environment` 为执行环境问题，`prerequisite` 为前置条件／样本不足，`undetermined` 表示尚未定位。原始失败数量不等于产品缺陷数量。草稿回执证据只记录选择身份、版本号和成功标志，不记录草稿正文。

写入和生成只面向本轮 `_shots/` 项目和登记的测试会话。`finally` 清理本轮会话、终端、工作台并恢复原会话、栏目和视口；失败会留资源身份并报告。强制终止进程无法保证收尾，需按 `resources.json` 手动清理。跨项目操作可能由原生应用创建项目窗口，当前脚本不自动关闭原生窗口，需在验收后手动关闭测试项目窗口。浏览器开始时的已有草稿不会被保存进报告。原浏览器和 relay 保持运行，不撤销配对、不刷新页面、不关闭用户窗口、不重启正式服务。

真机由用户使用既有配对浏览器，按原文档复现相应场景；**本机自动 Chrome 通过不等于手机或另一平台验收通过**。配对浏览器不能精确构造的乱序回执、存储损坏、原生协议、权限和平台边界，仅在本轮需要时使用临时夹具验证；缺少样本或未执行的普通流程仍明确列为待验。

## 临时 Office 文档

`files.office-preview` 和 `files.native-references` 使用运行时 `--targets` 配置，不生成或依赖仓库内的固定文档夹具。配置示例：

```json
{"documents":{"pdf":{"path":"_shots/current/example.pdf"},"docx":{"path":"_shots/current/example.docx","contains":["验证文字"]},"pptx":{"path":"_shots/current/example.pptx","contains":["第二页"]},"xlsx":{"path":"_shots/current/example.xlsx","contains":["第二张表"]}}}
```

原文件只读，场景复制到本轮临时目录；运行结束后清理临时副本。缺少文档时记为 blocked。临时文档的原始夹具也由本轮工作结束时清理，报告和截图可保留。
