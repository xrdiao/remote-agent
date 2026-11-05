# README 界面截图 / README screenshots

本目录包含两次真实采集的图片，日期与界面用途见下表。2026-11-05 的图片来自 Ubuntu 本机中继及既有配对 Chrome，页面版本为 `v411`；没有新建配对、重置授权或伪造界面数据。

- 浏览器视口模拟：402×874 CSS 像素、3 倍像素输出，每张 PNG 为 1206×2622，与原有图片尺寸一致。这不是 iPhone 真机、Safari 或原生壳验收，不含浏览器工具栏和系统状态栏。
- `redacted/` 是公开图片目录。不透明色块遮挡电脑名、账号、项目及会话名、电脑目录和文件名；终端仅保留初始提示符的非身份部分。遮挡仅在截图标签中应用，不修改生产页面代码或原始数据。
- 原图、采集过程和检查记录保存在本机 Git 忽略的 `_shots/readme-screenshots-20261105/`。新图片逐张查看后复制到本目录；未生成虚构聊天、模型、终端输出或审批数据。
- 本次新建一个 RA 终端以展示真实初始界面，未发送命令，截图后已关闭，并重新读取列表确认无打开终端。文件传输仅浏览目录和选择两项，未执行下载或上传；语音仅读取实际已安装引擎，未录音或切换引擎。

| 图片 | 采集日期 | 内容及限制 |
|---|---|---|
| `redacted/projects.png` | 2026-11-05 | 当前会话概览：电脑工具入口、Cursor 会话卡片、空闲／不常用分组及底部导航；替换原来的项目与会话弹出列表 |
| `redacted/terminal.png` | 2026-11-05 | RA 独立终端初始提示符、终端列表、密码输入、复制／全选、更多、历史／补全与命令输入区；未验证命令执行 |
| `redacted/transfer.png` | 2026-11-05 | 真实电脑目录的文件与文件夹多选下载页面；目录和文件名均已遮挡，未执行传输 |
| `redacted/voice.png` | 2026-11-05 | 实际安装的 Sherpa、Qwen 引擎与手机系统识别入口；未录音或切换引擎 |
| `redacted/chat-light.png` | 2026-10-22 | 历史 Devin 浅色对话图；本次未重新采集，不能作为当前布局或版本依据 |
| `redacted/chat-dark.png` | 2026-10-22 | 历史 Cursor 深色对话图；本次未重新采集，不能作为当前布局或版本依据 |
| `redacted/models.png` | 2026-10-22 | 历史 Codex 模型及参数菜单；本次未重新采集，模型名称和选项以实际界面为准 |

当前采集环境的概览仅返回 Cursor 历史会话，展开卡片时提示“目标会话读取失败”，原保存的 Codex 窗口也提示已经关闭。因此未重新采集聊天、Codex 项目列表或模型菜单，也未为截图新建 Agent 对话、切换模型或发送消息。需要相关桌面窗口及会话恢复可读后，再用既有配对浏览器补采。上述历史图保留原文件，不冒充本次采集结果。

Screenshots dated 2026-11-05 were captured from the existing paired Chrome browser on Ubuntu, using a 402×874 CSS-pixel viewport at 3× scale and the real v411 interface. They are browser viewport captures, not physical-device acceptance. Sensitive identifiers are covered with opaque masks. One temporary RA terminal was opened without sending commands, then closed; no transfers, recordings or model changes were performed. The three images dated 2026-10-22 remain historical captures because the required native conversations were unavailable during this session.
