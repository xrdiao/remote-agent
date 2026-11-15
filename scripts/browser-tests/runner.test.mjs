import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cleanupProjects as windowsCleanup } from './platform/windows.mjs';
import { cleanupProjects as posixCleanup } from './platform/posix.mjs';
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

test('Windows cleanup pins the isolated computer before releasing its backend and removes only the run projects', async t => {
  const base = path.resolve('_shots/browser-platform-tests'); await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'owned-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const dataDir = path.join(directory, 'identity'), projects = path.join(directory, 'projects');
  await fs.mkdir(dataDir); await fs.mkdir(projects);
  const key = Buffer.alloc(32, 7), computer = createHash('sha256').update(key).digest('hex').slice(0, 16);
  await fs.writeFile(path.join(dataDir, 'url-key'), key.toString('base64url'));
  await fs.writeFile(path.join(projects, 'evidence.txt'), 'owned');
  const registry = { appUrl: 'http://127.0.0.1:3941/', relay: { dataDir } };
  let released = false;
  const run = async (_exe, _args, options) => {
    assert.equal(await fs.readFile(path.join(projects, 'evidence.txt'), 'utf8'), 'owned');
    assert.equal(options.windowsHide, true); released = true; return { stdout: '[12,13]' };
  };
  const idle = async () => ({ sessions: [] });
  await assert.rejects(windowsCleanup(directory, registry, 'other-computer', idle, run), /电脑身份/);
  await assert.rejects(windowsCleanup(directory, registry, computer,
    async () => ({ sessions: [{ app: 'codex', windowId: 'backend', busy: true }] }), run), /仍有运行/);
  assert.equal(released, false);
  assert.deepEqual(await windowsCleanup(directory, registry, computer, idle, run), { projectsRemoved: true, backendProcessesStopped: [12, 13] });
  assert.equal(released, true); await assert.rejects(fs.access(projects), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(dataDir, 'url-key'), 'utf8'), key.toString('base64url'));
  await fs.mkdir(projects); await posixCleanup(directory);
  await assert.rejects(fs.access(projects), { code: 'ENOENT' });
});
