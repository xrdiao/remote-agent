import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, execute } from './run.mjs';
import { catalog, plan } from './catalog.mjs';
import { verdict } from './report.mjs';
import { Unavailable } from './browser.mjs';
import { distribution } from './blocks/stress.mjs';

test('目录覆盖审计编号，场景唯一且写入不会混入默认 smoke', () => {
  assert.equal(new Set(catalog.map(row => row.id)).size, catalog.length);
  const refs = new Set(catalog.flatMap(row => row.refs));
  for (const [prefix, max] of [['F', 21], ['R', 12], ['X', 12], ['S', 10], ['W', 15], ['M', 7]])
    for (let i = 1; i <= max; i++) assert(refs.has(prefix + String(i).padStart(2, '0')), prefix + i);
  for (const row of catalog) { assert(row.title); assert(row.refs.length); assert(row.mode === 'manual' ? row.reason : typeof row.run === 'function'); }
  const options = parse([]); assert.equal(options.suite, 'smoke');
  assert.deepEqual([...new Set(plan(parse(['--blocks', 'composer', '--apps', 'codex'])).map(row => row.app).filter(Boolean))], ['codex']);
  assert.throws(() => parse(['--case', 'absent'])); assert.throws(() => parse(['--iterations', 'NaN']));
});
test('失败、缺样本和未执行独立记账，后续场景继续，禁止无断言绿灯', async () => {
  const context = { assertions: [], b: { events: [], steps: [], snapshot: async () => ({}), screenshot: async () => 'masked.png', dismiss: async () => {} } };
  const cases = [
    { id: 'fail', run: async () => { throw Error('real mismatch'); } },
    { id: 'blocked', run: async () => { throw new Unavailable('no sample'); } },
    { id: 'green', run: async () => { context.assertions.push('receipt'); return { received: true }; } },
    { id: 'empty', run: async () => ({}) },
    { id: 'send', mode: 'generate', run: async () => { throw Error('不可触发'); } },
  ].map(row => ({ mode: 'read', refs: ['F01'], ...row }));
  const results = await execute(context, cases, 'smoke');
  assert.deepEqual(results.map(row => row.status), ['failed', 'blocked', 'passed', 'failed', 'not-run']);
  assert.equal(verdict(results), 1); assert.equal(verdict([{ status: 'blocked' }]), 2);
  assert.equal(verdict([{ status: 'not-run' }]), 2); assert.equal(verdict([{ status: 'passed' }]), 0);
});
test('真实样本分位数保留慢尾部，不以平均值掩盖卡住', () => {
  const stats = distribution([20, 10, 30, 40, 1000]); assert.equal(stats.p95, 1000); assert.equal(stats.median, 30);
});
