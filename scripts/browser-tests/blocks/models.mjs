import { attr, by } from '../context.mjs';
import { Unavailable } from '../browser.mjs';

export default [
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
        const actual = await c.b.read("capabilityState('effort')");
        c.check(!actual.available && !!actual.reason, '空强度列表具有原生不可用原因');
        evidence[kind] = { available: false, reason: actual.reason }; await c.b.dismiss(); continue;
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
  { id: 'models.change', title: '切换模型并读回、恢复', refs: ['F08', 'S02'], mode: 'write', apps: true, async run(c, app) {
    const target = await c.target(app, 'models', true); await c.open(target);
    const choices = await c.menu('model'), original = choices.find(row => row.checked), next = choices.find(row => !row.checked && !row.disabled);
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
