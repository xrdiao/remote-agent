export default [
  { id: 'client.version', title: '执行版本、缓存及 PWA 清单', refs: ['F01', 'F15', 'F20'], mode: 'read', async run(c) {
    const value = await c.b.read(`(async()=>({version:APP_VERSION,core:window.__raCoreVersion||null,
      manifest:!!document.querySelector('link[rel=manifest]'),viewport:document.querySelector('meta[name=viewport]')?.content,
      worker:!!navigator.serviceWorker?.controller,caches:'caches'in window?await caches.keys():[]}))()`);
    c.check(/^v\d+$/.test(value.version), '页面具有执行版本标识');
    c.check(value.manifest && value.viewport, 'PWA 清单与视口声明存在'); return value;
  } },
  { id: 'client.preferences', title: '主题和语言切换后恢复', refs: ['F15'], mode: 'write', async run(c) {
    const b = c.b, original = await b.read("({theme:store.get('theme')||'dark',lang:I18N.lang})"), visited = [];
    try {
      for (let i = 0; i < 3; i++) { await b.menu('theme'); visited.push(await b.read("store.get('theme')||'dark'")); }
      c.equal(new Set(visited).size, 3, '深浅与跟随系统均能切换');
      await b.menu('lang');
      // Language selection reloads the PWA. Wait for the new page AND the
      // authenticated original relay, rather than racing the old DOM.
      await b.wait(`I18N.lang!==${JSON.stringify(original.lang)}&&authed&&ws?.readyState===1
        &&!document.querySelector('#sheet.open')`, '语言切换与配对重连', 20000);
      c.check(await b.read('I18N.lang') !== original.lang, '语言设置已改变');
      await b.menu('lang');
      await b.wait(`I18N.lang===${JSON.stringify(original.lang)}&&authed&&ws?.readyState===1
        &&!document.querySelector('#sheet.open')`, '语言恢复与配对重连', 20000);
      c.equal(await b.read('I18N.lang'), original.lang, '语言恢复');
    } finally {
      for (let i = 0; i < 3 && await b.read("store.get('theme')||'dark'") !== original.theme; i++) await b.menu('theme');
      if (await b.read('I18N.lang') !== original.lang) await b.menu('lang');
      await b.dismiss();
    }
    c.equal(await b.read("store.get('theme')||'dark'"), original.theme, '主题恢复'); return { visited, restored: true };
  } },
  { id: 'client.phone', title: '手机前后台、自然断线、安全区、推送和原生壳', refs: ['F14', 'F15', 'F20', 'R09', 'R12', 'S06', 'S10', 'W12', 'W13', 'W14'], mode: 'manual',
    reason: '真实手机输入法、权限、系统挂起、语音、屏幕采集、通知和 iOS／Android 安装更新由用户验收；桌面尺寸模拟不能代替。' },
  { id: 'client.platform', title: '另一平台安装、启动和磁盘边界', refs: ['F20', 'W01', 'W02', 'W03', 'W04', 'W05', 'W06', 'W07', 'W08', 'W09', 'W10', 'W11', 'W15', 'M04'], mode: 'manual',
    reason: '当前浏览器仅证明本次报告标明的平台；Windows 专属启动、盘符、UNC、PowerShell、Git Bash、PTY 恢复与多窗口需在 Windows 实机执行。' },
];
