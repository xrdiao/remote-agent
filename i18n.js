// UI language. The app is written in Chinese; in English mode visible UI text is swapped through this table.
// Chat content, file previews and window/model names are left alone (see SKIP).
const I18N = (() => {
  const saved = localStorage.getItem('cr-lang');
  const lang = saved === 'zh' || saved === 'en' ? saved : /^zh\b/i.test(navigator.language || '') ? 'zh' : 'en';

  const EN = {
    '粘贴': 'Paste', '缩进': 'Indent', '反缩进': 'Outdent', '搜索': 'Find', '更多': 'More', '重做': 'Redo', '全选': 'Select all',
    '搜索当前文档': 'Find in this file', '已复制全文': 'Copied entire file', '请长按编辑框粘贴': 'Long press the editor to paste',
    '↓ 有新消息': '↓ New messages', '点击读取额度': 'Tap to load usage', '正在切换窗口…': 'Switching window…', '正在新建对话…': 'Starting a chat…',
    '当前应用': 'the current app', '发给 Agent…': 'Message Agent…',
    '连接中…': 'Connecting…', '对话': 'Chat', '画面': 'Screen', '↑ 加载更早的消息': '↑ Load earlier messages',
    '没找到聊天面板。': 'No chat panel found.', '请在 {app} 里打开 Agent 对话，或切到「画面」查看。': 'Open an Agent chat in {app}, or switch to "Screen".',
    '↓ 最新': '↓ Latest', '聊天面板': 'Chat panel', '整个窗口': 'Whole window', '点击': 'Tap', '滚动': 'Scroll', '刷新': 'Refresh',
    '回车': 'Enter', '适应': 'Fit', '历史': 'History', '＋ 新建': '+ New',
    '切换 Agent': 'Switch Agent', '没有找到 Agent 列表。请在电脑上打开 Cursor 的 Agents 窗口。': 'No agent list found. Open Cursor\'s Agents window on the computer.',
    '没有找到 {app} 的 Agent。请在电脑上打开对应的会话窗口。': 'No agents found in {app}. Open the corresponding session window on the computer.',
    '运行中': 'Running', '当前': 'Current', '正在读取 Agent 列表…': 'Loading agents…', '正在切换 Agent…': 'Switching agent…',
    '＋ 新建会话': '+ New chat', '打开这个窗口': 'Open this window',
    '已新建会话': 'New chat started', '已切换会话': 'Switched chat', '已是当前会话': 'Already the current chat',
    '已切换窗口': 'Switched window', '桌面上的会话已切换': 'The desktop chat changed',
    '这个窗口里没有新建对话': 'This window has no New chat button',
    '这个窗口里没有最近对话': 'This window has no recent chats',
    '没有找到这个会话': 'That chat was not found',
    '切换后的会话和选择的不一致': 'The open chat does not match the one you selected',
    '这条会话已经不在列表里': 'That chat is no longer in the list',
    '新建会话没有生效': 'New chat did not open',
    '没有找到上次的会话，已留在当前会话': 'The previous chat was not found; staying on the current one',
    '这条 Agent 已经不在列表里': 'That agent is no longer in the list',
    '终端': 'Terminal', '列表': 'List', '＋ 新建': '+ New', '发给终端…': 'Message the terminal…',
    '没有打开的终端': 'No terminal is open', '新建终端': 'New terminal', '＋ 新建终端': '+ New terminal',
    'Agent 正在运行': 'Agent is running', '还没有终端。': 'No terminals yet.', '删除': 'Delete',
    '正在切换终端…': 'Switching terminal…', '正在删除终端…': 'Closing terminal…', '正在新建终端…': 'Opening a terminal…',
    '正在读取终端列表…': 'Loading terminals…', '这个终端已经不在了': 'That terminal is gone',
    '没有打开的终端。先新建一个。': 'No terminal is open. Create one first.',
    '当前窗口里找不到新建终端的按钮': 'This window has no button for a new terminal',
    '菜单里没有终端这一项': 'The menu has no Terminal item',
    '打开项目': 'Open project', '最近用过的本地文件夹': 'Recent local folders', '设置': 'Settings', '额度': 'Usage',
    '查看文档': 'View files', 'README 和代码': 'README and code', '选择要查看的项目': 'Choose a project to view',
    '返回上一级': 'Up one level',
    '编辑': 'Edit', '保存': 'Save', '正在保存…': 'Saving…', '已保存': 'Saved', '保存失败': 'Save failed',
    '还有没保存的修改，确定离开？': 'Leave without saving your changes?',
    '文件太长，只能查看不能保存': 'This file is too long to edit',
    '内容太长，不能保存': 'The text is too long to save',
    '只能修改已打开过的项目里的文件': 'You can only edit files in previously opened projects',
    '有多个同名工作区，不能确定保存到哪一个': 'Several workspaces share this name, so the file cannot be saved to a specific one',
    '没有可查看的项目。': 'No projects to view.', '这个文件夹里没有可查看的文档或代码。': 'No documents or code in this folder.',
    '文档': 'Doc', '代码': 'Code', '文件夹': 'Folder', '正在读取文档…': 'Loading files…',
    '只能查看这个项目里的文件': 'You can only view files inside this project',
    '只能查看已打开过的项目': 'You can only view previously opened projects',
    '更换模型': 'Change model', '模型 ▾': 'Model ▾', '选择当前 Agent 的模型': 'Choose the current Agent model',
    '权限': 'Permissions', '读取权限…': 'Loading permissions…',
    '每次询问': 'Ask each time', '代为批准': 'Approve for me', '完全访问': 'Full access',
    '改外部文件和上网前都会询问': 'Ask before editing outside the project or using the internet',
    '只在可能不安全时询问': 'Ask only when an action looks unsafe',
    '可以访问网络和这台电脑上的文件': 'Can use the network and files on this computer',
    '画面': 'Screen', '直接看电脑上的 {app}': 'Look at {app} on the computer',
    '浏览文件夹': 'Browse folders', '上级目录': 'Up', '打开此文件夹': 'Open this folder',
    '还没有最近打开的本地项目。': 'No recent local projects.', '没有子文件夹。': 'No subfolders.',
    '没有读到设置。': 'Could not read settings.', '这里看不到额度。': 'Usage is not shown here.', '刷新': 'Refresh',
    '正在读取项目…': 'Loading projects…', '正在读取文件夹…': 'Loading folder…', '正在打开项目…': 'Opening project…',
    '正在读取设置…': 'Loading settings…', '正在修改…': 'Updating…', '正在读取额度…': 'Loading usage…',
    '没有额度数据': 'No usage data', '剩余': 'Left', '已用': 'Used',
    '每周限制': 'Weekly limit', '每周额度': 'Weekly quota', '5 小时限制': '5-hour limit', '额度': 'Credits',
    '包含额度已用完': 'Included quota is used up',
    '这个窗口里没有额度入口': 'This window has no usage page',
    '额度页面没有打开': 'The usage page did not open',
    '没有读到额度': 'Could not read usage', '额度还在加载': 'Usage is still loading',
    '读取额度后会话变了': 'The chat changed while reading usage',
    '找不到这个文件夹': 'Folder not found', '只能打开家目录里的文件夹': 'Only folders in your home directory can be opened',
    '读不了这个文件夹': 'Cannot read this folder', '找不到设置按钮': 'Settings button not found', '设置没有打开': 'Settings did not open',
    '找不到这项设置': 'That setting was not found',
    '发给 {app} Agent…': 'Message {app} Agent…', '发给 Devin…': 'Message Devin…', '发给 Codex…': 'Message Codex…', '发送': 'Send', '换行': 'Wrap', '在 App 中打开': 'Open in app', '重试': 'Retry', '重新配对': 'Pair again',
    'Lead 负责规划和关键判断，Sidekick 负责具体执行。': 'The lead plans and reviews. The sidekick does the work.',
    '先把模型切换到 Fusion': 'Switch the model to Fusion first',
    '没有这个 Fusion 选项': 'That Fusion option is not available',
    'Fusion 的这项没有打开': 'That Fusion control did not open',
    '没有读到可切换的模型': 'No models were found to switch',
    '没有找到 Fast Mode': 'Fast Mode was not found',
    '展开': 'Expand', '收起': 'Collapse', '思考中': 'Thinking', '思考': 'Thought',
    '未连接': 'Not connected', '已连接': 'Connected', '断开，重连中…': 'Disconnected, reconnecting…', '已发送': 'Sent',
    '电脑端还没有发布地址（或还在用旧版本），请在电脑上重启服务': 'The computer has not published its address yet (or runs an old version). Restart the service on the computer.',
    '配对信息已失效（电脑端重置过），请重新配对': 'Pairing is no longer valid (the computer was reset). Please pair again.',
    '这台设备还没有配对。': 'This device is not paired yet.',
    '在电脑上运行 npm run pair，用手机扫码；或者把链接复制过来粘贴到下面。': 'Run npm run pair on the computer and scan the code, or paste the pairing link below.',
    '粘贴配对链接': 'Paste pairing link', '配对': 'Pair', '验证': 'Verify', '这不是配对链接（应包含 #pair=…）': 'That is not a pairing link (it should contain #pair=…)',
    '请输入 Authenticator 里「Remote Agent」的 6 位验证码': 'Enter the 6-digit "Remote Agent" code from your Authenticator app',
    '正在配对…': 'Pairing…', '连不上电脑，配对链接 10 分钟内有效，稍后重试': 'Cannot reach the computer. The pairing link is valid for 10 minutes; try again shortly.',
    '配对失败': 'Pairing failed', '这台设备之前已经配对过，可以继续使用。': 'This device was paired before and can keep using it.', '继续使用': 'Continue',
    '正在验证…': 'Verifying…', '验证失败': 'Verification failed', '连不上电脑': 'Cannot reach the computer',
    '已收到配对链接。': 'Pairing link received.', '装了安卓 App 就在 App 里打开；否则直接在浏览器里用。': 'Open it in the Android app if installed; otherwise use it in the browser.',
    '在浏览器里继续': 'Continue in browser', '正在查找电脑…': 'Looking for the computer…', '读取失败，请检查手机网络': 'Could not load. Check your phone\'s network.',
    '电脑不在线：可能关机、睡眠，或服务刚重启（新地址约 1 分钟后生效）。会自动重试…': 'Computer offline: it may be off, asleep, or the service just restarted (a new address takes about a minute). Retrying automatically…',
    '正在判断连不上的是云端还是电脑…': 'Checking whether the cloud or the computer is unreachable…',
    '连不上电脑：这个页面就是电脑自己提供的，服务没有响应。': 'Cannot reach the computer: this page is served by the computer itself, and the service is not responding.',
    '云端能到，电脑没接上。': 'The cloud is reachable, but the computer is not connected.',
    '手机能打开 Cloudflare 隧道，但这台电脑的服务没有正常返回。可能是关机、睡眠，或中继没在跑。': 'The phone can open the Cloudflare tunnel, but this computer\'s service did not answer. It may be off, asleep, or the relay is not running.',
    '连不上云端：访问隧道地址超时。': 'Cannot reach the cloud: the tunnel address timed out.',
    '连不上云端：手机打不开隧道地址。': 'Cannot reach the cloud: the phone cannot open the tunnel address.',
    'GitHub 页面能打开，所以是手机到 Cloudflare 这段不通，还不能判断电脑是否开机。': 'GitHub Pages opened, so the gap is between the phone and Cloudflare. Whether the computer is on is still unknown.',
    '这台设备已被移除，请重新配对': 'This device was removed. Please pair again.',
    '切换窗口': 'Switch window', '切换 Cursor 窗口': 'Switch Cursor window', '没有找到窗口': 'No windows found', '本地': 'Local',
    'Cursor、Devin 和 Codex 都在这里。点一个就切到那个程序。': 'Cursor, Devin, and Codex are all listed. Tap one to switch to that app.',
    '「Agents」是 Cursor 专门跑 Agent 的窗口；其他是普通编辑器窗口（IDE 模式），SSH 远程窗口也在这里。': '"Agents" is Cursor\'s dedicated Agent window; the others are regular editor windows (IDE mode), including SSH remotes.',
    '选择模式': 'Mode', '选择模型': 'Model', '历史对话': 'Chat history', '菜单是空的，可能 {app} 版本不同': 'The menu is empty; your {app} version may differ',
    '更大上下文、更贵': 'Larger context, costs more', '参数': 'Params', '模型': 'Model', '改动会直接应用到电脑上 {app} 的这个模型。': 'Changes apply directly to this model in {app} on your computer.',
    '：开': ': on', '：关': ': off',
    '已配对设备': 'Paired devices', '移除': 'Remove', '添加新设备：在电脑上运行 npm run pair。': 'Add a device: run npm run pair on the computer.',
    '开启 Authenticator 二次验证：npm run 2fa。': 'Turn on Authenticator 2FA: npm run 2fa.',
    '通知：已开启': 'Notifications: on', 'Agent 完成或等你确认时提醒': 'Alerts when the Agent finishes or needs your OK', '关闭': 'Turn off',
    '发一条测试通知': 'Send a test notification', '开启通知': 'Turn on notifications', '新': 'New', '菜单': 'Menu',
    '更换 App 地址': 'Change app address', '安装到手机桌面（像 App 一样打开）': 'Add to home screen (opens like an app)', '重新连接': 'Reconnect',
    '取消本机配对': 'Unpair this device', '检查更新失败，请稍后再试': 'Update check failed; try again later', '已经是最新版本': 'You are on the latest version',
    '正在下载新版本，下载完会弹出安装界面': 'Downloading the new version; the installer opens when it is done',
    '通知组件没有加载，请刷新后再试': 'Notifications did not load; refresh and try again',
    '通知已开启。华为等手机请在「设置 → 应用启动管理」里允许本 App 后台活动': 'Notifications are on. On Huawei and similar phones, allow background activity in Settings → App launch.',
    '请先在菜单里更新安卓 App，新版才支持通知': 'Update the Android app from the menu first; notifications need the new version',
    'iPhone 要先「分享 → 添加到主屏幕」，从桌面图标打开后才能开启通知': 'On iPhone, first use Share → Add to Home Screen, then open from the home-screen icon to enable notifications',
    '这个浏览器不支持通知': 'This browser does not support notifications', '没有通知权限，请在系统设置里允许本 App 发通知': 'No notification permission; allow it in system settings',
    '注册失败': 'Registration failed', '通知已开启': 'Notifications are on', '通知已关闭': 'Notifications are off',
    '安装到桌面': 'Add to home screen', '用 Safari 打开本页 → 点底部「分享」按钮 → 选「添加到主屏幕」。': 'Open this page in Safari → tap Share at the bottom → choose "Add to Home Screen".',
    '安装后从桌面图标打开，就是全屏 App。': 'Open it from the home-screen icon for a full-screen app.',
    '安装安卓 App': 'Install the Android app', '下载安卓 App（推荐）': 'Download the Android app (recommended)',
    '华为等没有谷歌服务的手机、任何浏览器都能装。下载后点开安装（如提示「未知来源」，允许即可）。': 'Works on phones without Google services (e.g. Huawei) and from any browser. Open the download to install (allow "unknown sources" if asked).',
    '首次打开填入这个地址：': 'On first launch, enter this address:', '复制': 'Copy', '或者：用浏览器安装（需要谷歌服务）': 'Or: install via the browser (needs Google services)',
    '切换中…': 'Switching…', '已切换': 'Switched', '已复制': 'Copied', '已切换 Agent': 'Switched agent', '已切换终端': 'Switched terminal',
    '已关闭终端': 'Terminal closed', '已新建终端': 'Terminal created', '已更新设置': 'Setting updated',
    '切换 MAX Mode…': 'Toggling MAX Mode…', '读取模型参数…': 'Loading model parameters…', '设置中…': 'Applying…',
    '已复制地址': 'Address copied', '复制失败，请手动记下地址': 'Copy failed; note the address manually',
    '已发送测试通知，几秒内应该收到': 'Test notification sent; it should arrive within seconds', '发送失败': 'Send failed',
    '取消本机配对？之后要在电脑上重新运行 npm run pair 才能再用。': 'Unpair this device? You will need to run npm run pair on the computer again to use it.',
    '电脑': 'Computers', '未配对': 'Not paired', '这台电脑': 'This computer', '当前': 'Current', '选择电脑': 'Choose computer',
    '选择要连接的电脑': 'Choose a computer to connect',
    '这台电脑的地址对不上当前发布的记录，配对还在，可以换一台或稍后重试': 'This computer\'s address does not match the published record. Pairing is kept; switch computers or try again shortly.',
    '这台电脑上的配对已失效，已从列表移除。可以换一台，或重新配对。': 'Pairing on this computer is no longer valid, so it was removed from the list. Switch computers, or pair again.',
    '这台电脑不认当前配对。记录还在，可以换一台，或重新配对这台。': 'This computer does not accept the saved pairing. The record is kept; switch computers, or pair this one again.',
    '还没在这只手机上配对。': 'is not paired on this phone yet.',
    '已配对的电脑会保留。': 'Computers you already paired stay.',
    '在那台电脑上运行 npm run pair，把链接粘贴到下面。已配对的电脑会保留。': 'Run npm run pair on that computer and paste the link below. Computers you already paired stay.',
    '＋ 配对另一台电脑': '+ Pair another computer',
    '在那台电脑上运行 npm run pair，把链接粘贴过来。已有的电脑会保留。': 'Run npm run pair on that computer and paste the link. Computers you already paired stay.',
    '配对另一台电脑。\n在那台电脑上运行 npm run pair，把链接粘贴到下面。已有的电脑会保留。': 'Pair another computer.\nRun npm run pair on that computer and paste the link below. Computers you already paired stay.',
    '返回': 'Back',
    '删除电脑「': 'Remove computer “',
    '」？\n这台手机不再连接它。': '”?\nThis phone will disconnect from it.',
    '删除这台电脑': 'Remove this computer',
    '这台手机不再连接它。': 'This phone will disconnect from it.',
    '这台电脑还没有发布地址，请在那台电脑上重启服务': 'This computer has not published its address. Restart the service on that computer.',
    '这台电脑还没有发布地址': 'This computer has not published its address',
    '正在查看子 Agent 的对话（只读）': 'Viewing a subagent\'s chat (read-only)', '返回主对话': 'Back to main chat',
    '查看': 'View', '停止': 'Stop', '修改': 'Edit', '立即发送': 'Send now', '删除': 'Delete', '打断当前这一轮，立刻发送': 'Interrupt the current turn and send right away',
    'Agent 正在运行，下面的消息会在这一轮结束后依次发送': 'Agent is running; the messages below are sent in order when this turn ends',
    'Agent 正在运行，现在发的消息会先排队': 'Agent is running; new messages will be queued',
    '(空)': '(empty)', '这条排队消息已经不在了': 'That queued message is gone', '修改排队消息': 'Edit queued message', '保存（仍在排队）': 'Save (stays queued)',
    '内容不能为空；不想要这条就点「删除」': 'The message cannot be empty; use "Delete" to drop it', '正在修改排队消息…': 'Updating queued message…',
    '已停止 Agent': 'Agent stopped', '返回主对话…': 'Returning to main chat…', '已停止子 Agent': 'Subagent stopped', '正在打开子 Agent…': 'Opening subagent…',
    '正在停止…': 'Stopping…', '没有停下来，Agent 仍在运行': 'It did not stop; the Agent is still running', 'Agent 当前没有在运行': 'The Agent is not running',
    '已立即发送这条排队消息': 'Queued message sent now', '已删除这条排队消息': 'Queued message deleted',
    '读取模式列表…': 'Loading modes…', '读取模型列表…': 'Loading models…', '读取历史对话…': 'Loading chat history…', '已新建对话': 'New chat started',
    '正在从电脑读取…': 'Reading from the computer…', '可以切到「画面」在 {app} 里打开': 'You can open it in {app} from the "Screen" tab',
    '文件太长，只显示了前 512 KB': 'File too long; showing the first 512 KB',
    '语言 / Language': '语言 / Language', '请说话…（再点一下结束）': 'Listening… (tap again to stop)', '请说话…': 'Listening…',
    '没听清，再试一次': 'Didn\'t catch that, try again', '没有麦克风权限': 'No microphone permission',
    '语音识别连不上服务器（国内网络常见），可以用输入法键盘上的麦克风': 'Speech recognition cannot reach its server; use the microphone on your keyboard instead',
    '这个浏览器不支持语音识别，可以用输入法键盘上的麦克风': 'This browser has no speech recognition; use the microphone on your keyboard instead',
    '更新安卓 App 后可用语音输入，也可以用输入法键盘上的麦克风': 'Update the Android app for voice input, or use the microphone on your keyboard',
    '手机上没有语音识别服务，可以用输入法键盘上的麦克风': 'No speech recognition service on this phone; use the microphone on your keyboard instead',
    '语音输入': 'Voice input', '语音按钮': 'Voice button', '输入法键盘自带麦克风的话用不着': 'Not needed if your keyboard has a mic',
    '取消': 'Cancel', '确定': 'OK', '取消配对': 'Unpair',
    '停止 Agent？': 'Stop the Agent?', '它这一轮正在做的事会中断。': 'Whatever it is doing in this turn will be interrupted.',
    '它做到一半的工作会中断。': 'Its unfinished work will be interrupted.',
    '立即发送这条消息？': 'Send this message now?', 'Agent 当前这一轮会被打断。': 'The Agent\'s current turn will be interrupted.',
    '删除这条排队消息？': 'Delete this queued message?',
    '附加图片': 'Attach image', '正在处理图片…': 'Processing image…', '读不了这张图片，换一张试试': "Couldn't read that image; try another",
    '图片已附加到 {app} 输入框，写好文字后点发送': 'Image attached in {app}; type your message and tap Send',
    '只支持 PNG / JPEG / GIF / WebP 图片': 'Only PNG / JPEG / GIF / WebP images are supported',
    '{app} 没有接收这张图片（当前模型可能不支持图片）': "{app} didn't accept the image (the current model may not support images)",
    '❓ Agent 在问你': '❓ The Agent is asking you', '其他…': 'Other…', '填入': 'Set', '跳过': 'Skip', '提交': 'Submit', '已跳过': 'Skipped', '已提交': 'Submitted',
    '这个问题已经不在了（可能已在电脑上回答）': 'That question is gone (maybe it was answered on the computer)',
    '保留': 'Keep', '撤销': 'Undo', '读取改动的文件…': 'Loading changed files…', '没有待处理的改动': 'No pending changes',
    '正在撤销…': 'Undoing…', '正在保留…': 'Keeping…', '处理中…': 'Working…',
    '点文件名查看内容。「保留」接受这个文件的改动，「撤销」把它恢复成改动前的样子。': 'Tap a file name to view it. "Keep" accepts the change to that file; "Undo" restores it to how it was before.',
    '文件会恢复成 Agent 改之前的样子。': 'The file goes back to how it was before the Agent changed it.',
    '不支持的操作': 'Unsupported action', '文件列表已经变了，请重新打开': 'The file list changed; open it again',
    '没找到这个按钮（可能 {app} 版本不同）': 'Button not found (your {app} version may differ)',
    // Relay messages
    '已修改，仍在排队': 'Updated, still queued', 'Agent 正在运行，已加入排队，这一轮结束后自动发送': 'Agent is running; queued, and it sends automatically when this turn ends',
    '按钮已经不在了，可能状态已变化': 'That button is gone; the state may have changed', '{app} 没有进入编辑状态，没改动': '{app} did not enter edit mode; nothing changed',
    '不支持的排队操作': 'Unsupported queue action', '这条排队消息已经不在了（可能刚被发出）': 'That queued message is gone (it may have just been sent)',
    '没找到排队消息的操作按钮（可能 {app} 版本不同）': 'Could not find the queue buttons (your {app} version may differ)',
    '这个子 Agent 已经结束了，或者 {app} 里找不到它': 'That subagent has finished, or {app} cannot find it',
    '找不到原来的主对话标签页，请在「画面」里手动切回': 'Cannot find the main chat tab; switch back manually in "Screen"',
    'Agent 当前没有在运行': 'The Agent is not running', '当前窗口里没有这个按钮（可能是 {app} 版本或布局不同）': 'This window has no such button (your {app} version or layout may differ)',
    '这个 Cursor 版本没有 MAX Mode 开关': 'This Cursor version has no MAX Mode toggle', '模型列表里找不到这个模型': 'That model is not in the list',
    '这个模型没有可调的参数': 'This model has no adjustable parameters', '参数菜单没有打开（可能 {app} 版本不同）': 'The parameter menu did not open (your {app} version may differ)',
    '不是文件路径': 'Not a file path', '二进制文件，不能预览': 'Binary file; cannot preview',
    '没有找到 Cursor 窗口，确认 Cursor 是以 --remote-debugging-port=9222 启动的': 'No Cursor window found; make sure Cursor was started with --remote-debugging-port=9222',
    '{app} 窗口连接已断开': 'Lost connection to {app}',
    '没找到 {app} 的聊天输入框：先在画面里打开 Agent 面板（或点「打开聊天」）': 'No chat input found in {app}: open the Agent panel in "Screen" first (or tap "Open chat")',
    '尚未连接到 {app} 窗口': 'Not connected to {app} yet',
    '连不上 Cursor：Cursor 没有用 start-cursor.sh 启动（调试端口未开启）': 'Cannot reach Cursor: it was not started with start-cursor.sh (debug port is off)',
    '尝试次数过多，请 15 分钟后再试': 'Too many attempts; try again in 15 minutes',
    '配对链接无效或已过期（10 分钟内有效，只能用一次）。请在电脑上重新运行 npm run pair': 'The pairing link is invalid or expired (valid 10 minutes, single use). Run npm run pair on the computer again.',
    '验证码不对': 'Wrong code', '设备未配对': 'Device not paired', '需要二次验证': 'Two-factor verification required', '订阅信息无效': 'Invalid subscription',
  };

  // Strings with a variable part.
  const PATTERNS = [
    [/^「(.+)」还没在这只手机上配对。$/, '“$1” is not paired on this phone yet.'],
    [/^电脑端地址更新于 (.+)$/, 'Computer address updated $1'],
    [/^配对于 (.+) · 最近使用 (.+)$/, 'Paired $1 · last used $2'],
    [/^更新安卓 App（v(.+) → v(.+)）$/, 'Update the Android app (v$1 → v$2)'],
    [/^检查 App 更新（当前 v(.+)）$/, 'Check for app update (now v$1)'],
    [/^安卓 App 有新版本 v(.+)，点右上角「⋯」更新$/, 'Android app v$1 is available; update from "⋯" at the top right'],
    [/^(.*) 参数$/, '$1 parameters'],
    [/^子 Agent 运行中 (\d+) 个$/, 'Subagents running: $1'],
    [/^排队中 (\d+) 条$/, 'Queued: $1'],
    [/^停止子 Agent「(.+)」？$/, 'Stop subagent "$1"?'],
    [/^❓ Agent 在问你（(\d+) 个问题）$/, '❓ The Agent is asking you ($1 questions)'],
    [/^改动了 1 个文件 ›$/, '1 file changed ›'],
    [/^改动了 (\d+) 个文件 ›$/, '$1 files changed ›'],
    [/^Agent 改动的文件（(\d+)）$/, 'Files changed by the Agent ($1)'],
    [/^撤销「(.+)」的改动？$/, 'Undo the changes to "$1"?'],
    [/^确定要点「(.+)」吗？$/, 'Really tap "$1"?'],
    [/^移除「(.+)」？它会立即断开，要重新配对才能再用。$/, 'Remove "$1"? It disconnects immediately and must be paired again.'],
    [/^开启通知失败：(.*)$/, 'Could not turn on notifications: $1'],
    [/^已点击：(.*)$/, 'Tapped: $1'],
    [/^(.+)：(开|关)$/, (m, a, b) => `${a}: ${b === '开' ? 'on' : 'off'}`],
    [/^已切换到 (.*)$/, 'Switched to $1'],
    [/^没找到选项：(.*)$/, 'Option not found: $1'],
    [/^没找到参数：(.*)$/, 'Parameter not found: $1'],
    [/^找不到文件（可能已被删除或移动）：(.*)$/, 'File not found (it may have been deleted or moved): $1'],
    [/^SSH 连接 (.+) 失败：(.*)$/, 'SSH connection to $1 failed: $2'],
    [/^图片太大（(.+)），请在电脑上看$/, 'Image too large ($1); view it on the computer'],
    [/^未知按键: (.*)$/, 'Unknown key: $1'],
    [/^未知指令: (.*)$/, 'Unknown command: $1'],
    [/^(.*)（(安卓 App|安卓浏览器|Mac 浏览器|浏览器)）$/, (m, a, b) => `${a} (${{ '安卓 App': 'Android app', '安卓浏览器': 'Android browser', 'Mac 浏览器': 'Mac browser', '浏览器': 'browser' }[b]})`],
  ];

  for (const [template, translation] of Object.entries(EN)) {
    if (!template.includes('{app}')) continue;
    const pattern = template.split('{app}').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+?)');
    PATTERNS.push([new RegExp('^' + pattern + '$'), (match, app) => translation.replaceAll('{app}', EN[app] || app)]);
  }

  const line = s => {
    const key = s.trim();
    if (!key || !/[\u4e00-\u9fa5（）「」：]/.test(key)) return s;
    let out = EN[key];
    if (out == null) for (const [re, to] of PATTERNS) if (re.test(key)) { out = key.replace(re, to); break; }
    if (out == null) return s;
    return s.replace(key, out);
  };
  const tr = s => lang === 'zh' || s == null ? s : String(s).split('\n').map(line).join('\n');

  // Content mirrored from Cursor or the computer's files is never translated.
  const SKIP = '#items, #vBody, #vName, #vPath, #titleText, .qt, [data-label] .lbl, [data-win] .lbl, [data-agent] .lbl, [data-fold] .lbl, [data-term] .lbl, [data-docs-file] .lbl, [data-docs-dir] .lbl, [data-docs-root] .lbl, .qnQ, .qnOpt span';
  const ATTRS = ['placeholder', 'title', 'aria-label'];
  const fix = node => {
    if (node.nodeType === 3) {
      if (node.parentElement?.closest(SKIP)) return;
      const t = tr(node.nodeValue);
      if (t !== node.nodeValue) node.nodeValue = t;
      return;
    }
    if (node.nodeType !== 1 || node.closest(SKIP)) return;
    for (const a of ATTRS) if (node.hasAttribute(a)) { const v = node.getAttribute(a), t = tr(v); if (t !== v) node.setAttribute(a, t); }
    for (const c of node.childNodes) fix(c);
  };

  if (lang === 'en') {
    document.documentElement.lang = 'en';
    const start = () => {
      fix(document.body);
      new MutationObserver(list => {
        for (const m of list) {
          if (m.type === 'characterData') fix(m.target);
          else if (m.type === 'attributes') fix(m.target);
          else m.addedNodes.forEach(fix);
        }
      }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    };
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
    const confirm0 = window.confirm.bind(window);
    window.confirm = m => confirm0(tr(m));
  }

  const set = v => { localStorage.setItem('cr-lang', v); location.reload(); };
  return { lang, tr, set, speech: lang === 'en' ? 'en-US' : 'zh-CN' };
})();
