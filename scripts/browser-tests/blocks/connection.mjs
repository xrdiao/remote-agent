import { attr } from '../context.mjs';

export default [
  { id: 'connection.ready', title: '原配对认证及实时连接', refs: ['F01', 'F02', 'W01'], mode: 'read', async run(c) {
    const state = await c.b.read(`({authed,open:ws?.readyState===1,computer:currentComputer()?.id,version:APP_VERSION,gate:document.getElementById('gate')?.classList.contains('show')})`);
    c.check(state.authed && state.open, '既有配对已认证且 WebSocket 打开');
    c.equal(state.computer, c.computer, '执行电脑身份一致'); c.check(!state.gate, '现有配对不要求重新授权');
    return state;
  } },
  { id: 'connection.devices', title: '设备与配对管理入口', refs: ['F02'], mode: 'read', async run(c) {
    await c.b.menu('devices'); await c.b.wait("sheetKind==='devices'&&!document.querySelector('#sheet [role=status]')", '设备列表');
    const count = await c.b.read("document.querySelectorAll('#sheet .deviceRows details').length");
    c.check(count > 0, '设备列表包含当前配对'); await c.b.dismiss(); return { groups: count };
  } },
  { id: 'connection.reconnect', title: '主动重连保持原会话和草稿', refs: ['F01', 'R12', 'S06'], mode: 'write', apps: true, async run(c, app) {
    const target = await c.target(app, 'A', true); await c.open(target);
    const draft = c.marker + '-reconnect'; await c.draft(draft); await c.b.menu('reconnect');
    await c.b.wait(`authed&&windowReady&&lastChat?.thread===${attr(target.thread)}`, '重连首屏', c.options.timeout);
    c.equal(await c.b.read('text.value'), draft, '重连保留当前草稿'); await c.draft('');
    return { thread: target.thread, ...await c.b.snapshot() };
  } },
  { id: 'connection.unauthorized', title: '未授权读取不能访问配对数据', refs: ['F21'], mode: 'read', async run(c) {
    const response = await fetch(new URL('/api/overview', c.options.appUrl));
    c.check([401, 403].includes(response.status), '无配对签名的目录请求被拒绝');
    return { status: response.status };
  } },
  { id: 'connection.pairing-device', title: '新配对、2FA、撤销与重放', refs: ['F02', 'F21'], mode: 'manual',
    reason: '需要专门的第二配对身份与授权场景；不撤销用户现有配对。' },
];
