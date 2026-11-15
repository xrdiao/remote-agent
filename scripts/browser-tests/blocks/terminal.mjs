import { attr, by } from '../context.mjs';

async function terminal(c, app) {
  const target = await c.target(app, 'terminal', true); await c.open(target); await c.b.click('#tabTerm');
  const previous = await c.b.read('currentTerminalId');
  await c.terminalMenu(); await c.b.click('#sheet [data-act="newTerm"]');
  const id = await c.b.wait(`!terminalCreateRequest&&terminalReady&&terminalPrompt&&currentTerminalId&&currentTerminalId!==${attr(previous)}?currentTerminalId:null`, '本次终端新建');
  c.terminals.push({ id, app, thread: target.thread }); await c.persistResources();
  return { target, id };
}
const terminalText = `(()=>{const b=raTerminal?.buffer.active;if(!b)return '';return Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'').join('\\n')})()`;

export default [
  { id: 'terminal.command', title: '项目终端真实 cwd、命令和输出', refs: ['F13', 'W10'], mode: 'write', apps: true, async run(c, app) {
    const { target, id } = await terminal(c, app);
    const cwd = await c.b.read('terminalCwd');
    const normalize = value => process.platform === 'win32' ? value.replaceAll('\\', '/').replace(/^\/([a-z])\//i, '$1:/').toLowerCase() : value;
    c.equal(normalize(cwd), normalize(target.root), '终端使用真实会话项目目录');
    const marker = c.marker + '-PTY'; await c.input(`printf '${marker}\\n'`); await c.b.click('#send');
    await c.b.wait(`${terminalText}.includes(${attr(marker)})&&terminalPrompt`, '终端命令输出');
    c.check(await c.b.read(`${terminalText}.includes(${attr(marker)})`), '真实 PTY 收到并输出命令');
    await c.terminalMenu(); c.check(await c.b.has(by('data-term', id)), '终端具有独立 ID'); await c.b.dismiss();
    return { id, cwd };
  } },
  { id: 'terminal.return-chat', title: '终端返回主页后打开 B 正文', refs: ['F13', 'R03'], mode: 'write', apps: true, async run(c, app) {
    const { id } = await terminal(c, app), b = await c.target(app, 'B', true); await c.open(b);
    c.equal(await c.b.read('mode'), 'chat', '卡片进入 B 正文模式'); c.equal(await c.b.read('lastChat.thread'), b.thread, '不闪回 A 会话');
    await c.b.click('#tabTerm'); await c.b.click('#pickTerms');
    c.check(await c.b.has(by('data-term', id)), '返回主页未销毁原终端'); await c.b.dismiss(); return { id, thread: b.thread };
  } },
  { id: 'terminal.fold', title: '终端输入折叠和展开保留命令', refs: ['F13'], mode: 'write', apps: true, async run(c, app) {
    await terminal(c, app); const text = 'echo ' + c.marker; await c.input(text);
    const before = await c.b.read("document.getElementById('composerFold').getAttribute('aria-expanded')");
    await c.b.click('#composerFold'); c.check(await c.b.read("document.getElementById('composerFold').getAttribute('aria-expanded')") !== before, '终端输入框可折叠');
    await c.b.click('#composerFold'); c.equal(await c.b.read('text.value'), text, '展开保留未发命令');
    await c.input(''); return { preserved: true };
  } },
  { id: 'terminal.selection', title: '终端原生选择复制、补全和前台交互', refs: ['F13', 'W10'], mode: 'manual',
    reason: '需在真实手机验证长按选择与系统剪贴板，并在自有终端检查 Tab、历史、多行命令和前台交互。PTY 不回显、活动进程拒绝补全及资源释放保留关键回归；未执行此项不得以命令输出通过替代。' },
];
