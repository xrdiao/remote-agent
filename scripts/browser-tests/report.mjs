import fs from 'node:fs/promises';

export function verdict(results) {
  return results.some(row => row.status === 'failed') ? 1
    : results.some(row => ['blocked', 'manual', 'not-run'].includes(row.status)) ? 2 : 0;
}

export function summary(results) {
  return results.reduce((out, row) => { out[row.status] = (out[row.status] || 0) + 1; return out; }, {});
}

export async function report(directory, data) {
  await fs.writeFile(`${directory}/results.json`, JSON.stringify(data, null, 2) + '\n');
  const clean = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const lines = ['# 配对浏览器功能检查', '', `开始：${data.started}；平台：${data.platform}；网页：${data.browser?.version || '未连接'}`,
    '', `统计：${JSON.stringify(summary(data.results))}；退出码：${verdict(data.results)}`,
    '', '证据层次：本机既有配对 Chrome；不等同于手机、另一桌面系统或原生壳验收。', '',
    '| 场景 | 文档编号 | 软件 | 状态 | 结果／原因 |', '| --- | --- | --- | --- | --- |'];
  for (const row of data.results) lines.push(`| ${row.id} · ${clean(row.title)} | ${row.refs.join(', ')} | ${row.app || '共用'} | ${row.status} | ${clean(row.reason || JSON.stringify(row.evidence || {}))}${row.screenshot ? ` [截图](${row.screenshot})` : ''} |`);
  lines.push('', '编号仅用于追踪文档区块；基础用例通过不代表该区块全部子场景通过。自动化边界和仍待补验的分支见测试目录 README。', '',
    '## 恢复与清理', '', '```json', JSON.stringify(data.cleanup || {}, null, 2), '```', '',
    '原始错误、请求耗时、执行步骤和断言见 results.json。受阻和未执行项目不计通过。');
  await fs.writeFile(`${directory}/report.md`, lines.join('\n') + '\n');
}
