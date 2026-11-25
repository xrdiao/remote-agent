import { attr, by } from '../context.mjs';
import { Unavailable } from '../browser.mjs';

export default [
  { id: 'models.codex-permissions', title: 'Codex 三种权限实际切换并回读', refs: ['F08', 'W03', 'M02'], mode: 'write', apps: ['codex'], async run(c, app) {
    await c.open(await c.target(app, 'permissions', true));
    const original = (await c.menu('permission')).find(row => row.checked);
    c.check(!!original, '原生权限有当前选项');
    const values = [];
    try {
      for (const label of ['Ask for approval', 'Approve for me', 'Full access']) {
        const choices = await c.menu('permission');
        c.check(choices.length === 3, '权限菜单保留三个模式');
        await c.b.click(`#sheet [data-kind="permission"]${by('data-label', label)}`);
        await c.b.wait('!menuPending', '权限修改回执');
        c.check((await c.menu('permission')).some(row => row.label === label && row.checked), '实际回读选中：' + label);
        values.push(label);
      }
    } finally {
      await c.menu('permission');
      await c.b.click(`#sheet [data-kind="permission"]${by('data-label', original.label)}`);
      await c.b.wait('!menuPending', '恢复原权限'); await c.b.dismiss();
    }
    return { values, restored: original.label };
  } },
  { id: 'models.read', title: '模型、强度和权限原生菜单', refs: ['F08', 'W03', 'W04', 'M02'], mode: 'read', apps: true, async run(c, app) {
    await c.open(await c.target(app)); const evidence = {};
    for (const kind of ['model', 'effort']) {
      const capability = await c.b.read(`capabilityState(${attr(kind)})`);
      if (!capability.supported) {
        if (kind === 'effort') {
          await c.menu('model');
          c.check(!await c.b.has('#sheet [data-effort-open]'), '原生不支持强度时，模型菜单没有强度入口');
          await c.b.dismiss();
        } else c.check(!await c.b.has('#pickModel'), '原生不支持模型时，没有模型入口');
        evidence[kind] = { supported: false, reason: capability.reason }; continue;
      }
      if (!capability.available) throw new Unavailable(capability.reason);
      const choices = await c.menu(kind);
      if (kind === 'effort' && !choices.length) {
        const actual = await c.b.read("({capability:capabilityState('effort'),text:document.querySelector('#sheet')?.textContent||'',back:!!document.querySelector('#sheet [data-model-back]')})");
        c.check(actual.text.includes('这个模型没有可选的思考强度') && actual.back,
          '真实空强度列表明确说明当前模型没有候选，并提供返回模型入口');
        evidence[kind] = { available: false, reason: actual.capability.reason || '原生模型未返回思考强度候选' };
        await c.b.dismiss(); continue;
      }
      c.check(choices.length > 0, kind + ' 存在实际候选');
      evidence[kind] = choices.map(row => row.label); await c.b.dismiss();
    }
    if (app === 'codex') {
      const permissions = await c.menu('permission');
      c.check(['Ask for approval', 'Approve for me', 'Full access'].every(label => permissions.some(row => row.label === label)), 'Codex 三种权限均可见');
      evidence.permissions = permissions.map(row => row.label); await c.b.dismiss();
    }
    return evidence;
  } },
  { id: 'models.codex-menu', title: 'Codex 模型菜单和原生速度档位往返', refs: ['F08', 'W04'], mode: 'write', apps: ['codex'], async run(c, app) {
    const b = c.b;
    await c.open(await c.target(app, 'models', true));
    const choices = await c.menu('model');
    c.check(choices.some(row => row.checked), '模型菜单显示当前模型');
    let menuRequests = 0;
    const previous = b.cdp.handlers.get('Network.webSocketFrameSent');
    b.cdp.on('Network.webSocketFrameSent', event => {
      previous?.(event);
      if (event.response.opcode !== 1) return;
      const frame = event.response.payloadData;
      try { const message = JSON.parse(frame.slice(frame.indexOf('\n') + 1)); if (message.t === 'openMenu') menuRequests++; } catch {}
    });
    const currentSpeed = () => b.read("document.querySelector('#sheet [data-speed-id].cur')?.dataset.speedId ?? null");
    const openSpeeds = async () => {
      await b.click('#sheet [data-speed-open]');
      await b.wait("menuSheetKind==='fast'&&!menuPending&&!!document.querySelector('#sheet [data-speed-id]')", '原生速度菜单');
      return b.read("[...document.querySelectorAll('#sheet [data-speed-id]:not(:disabled)')].map(row=>({id:row.dataset.speedId,label:row.dataset.label}))");
    };
    const pickSpeed = async id => {
      await b.click('#sheet ' + by('data-speed-id', id));
      await b.wait(`!modelSwitchRequest&&document.querySelector('#sheet [data-speed-id].cur')?.dataset.speedId===${attr(id)}`, '速度设置和原生回读');
    };
    let original = null, speeds;
    try {
      await b.click('#sheet [data-effort-open]');
      await b.wait("menuSheetKind==='effort'&&!menuPending", '思考强度菜单');
      c.check(await b.has('#sheet [data-kind="effort"]'), '同一次读取包含思考强度');
      await b.click('#sheet [data-model-back]');
      await b.wait("menuSheetKind==='model'&&!menuPending", '返回模型菜单');
      c.equal(menuRequests, 0, '模型与强度之间切换不重复请求');
      if (!await b.has('#sheet [data-speed-open]')) throw new Unavailable('当前模型没有额外可用的速度档位');
      speeds = await openSpeeds();
      original = await currentSpeed();
      c.check(original !== null && speeds.some(row => row.id === original), '原生选中档位在候选内');
      for (const row of speeds.filter(row => row.id !== original)) {
        await pickSpeed(row.id);
        c.equal(await currentSpeed(), row.id, '速度更新到 ' + row.label);
      }
      await pickSpeed(original);
      await c.menu('model');
      await openSpeeds();
      c.equal(await currentSpeed(), original, '重新读取后速度档位已恢复');
    } finally {
      if (previous) b.cdp.on('Network.webSocketFrameSent', previous); else b.cdp.handlers.delete('Network.webSocketFrameSent');
      if (original !== null && await b.has('#sheet [data-speed-id]') && await currentSpeed() !== original) await pickSpeed(original);
      await b.dismiss();
    }
    return { speeds, restored: original };
  } },
  { id: 'models.change', title: '切换模型并读回、恢复', refs: ['F08', 'S02'], mode: 'write', apps: true, async run(c, app) {
    const target = await c.target(app, 'models', true); await c.open(target);
    const choices = await c.menu('model'), original = choices.find(row => row.checked), next = choices.find(row => !row.checked && !row.disabled && !(app === 'codex' && row.label === 'Default Recommended set of models'));
    if (!original || !next) throw new Unavailable('原生模型菜单不足两个可选模型或未标识当前模型');
    const values = [];
    try { for (const choice of [next, original]) {
      await c.b.click(`#sheet [data-kind="model"]${by('data-label', choice.label)}`);
      await c.b.wait('!menuPending', '模型写入回执');
      const actual = await c.menu('model');
      c.check(actual.some(row => row.label === choice.label && row.checked), '原生回读选中 ' + choice.label);
      values.push(choice.label);
    } } finally {
      const actual = await c.menu('model');
      if (!actual.some(row => row.label === original.label && row.checked)) await c.b.click(`#sheet [data-kind="model"]${by('data-label', original.label)}`);
      await c.b.dismiss();
    }
    return { values };
  } },
  { id: 'models.usage', title: '上下文、额度及速度未知值处理', refs: ['F08', 'F16', 'R11'], mode: 'read', apps: true, async run(c, app) {
    await c.open(await c.target(app));
    const value = await c.b.read('({context:currentUsageMeters().context,quota:currentUsageMeters().quota,performance:lastChat.performance})');
    for (const item of [value.context, ...value.quota].filter(Boolean))
      if (item.pct != null) c.check(Number.isFinite(item.pct) && item.pct >= 0 && item.pct <= 100, '原生百分比在有效范围');
    c.check(!await c.b.read("/NaN|Infinity|\\d+\\.\\d+%/.test(document.getElementById('meters').textContent)"), '上下文和额度百分比使用整数且没有无效值');
    return { context: value.context, quotaCount: value.quota.length, performanceAvailable: !!value.performance };
  } },
  { id: 'models.settings', title: 'Codex 原生设置页与 Max 成功切换', refs: ['F08', 'W03'], mode: 'manual', apps: ['codex'],
    reason: '需要提供 Max 的真实原生模型及桌面设置页，验证成功切换和返回；普通模型菜单不代替本项。功能缺失时的明确失败、原选择恢复及关闭资源仍保留关键回归。' },
];
