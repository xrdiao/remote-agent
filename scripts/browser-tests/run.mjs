import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ensurePairedBrowser } from '../paired-browser.mjs';
import { Browser, Unavailable } from './browser.mjs';
import { Context } from './context.mjs';
import { apps, blocks, catalog, plan, enabled } from './catalog.mjs';
import { report, verdict } from './report.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export function parse(argv) {
  const options = { suite: 'smoke', registry: path.join(root, '_shots/paired-browser.json'),
    blocks: [], cases: [], apps: [...apps], timeout: 20000, generationTimeout: 120000,
    iterations: 20, fusionApp: 'codex', targets: {} };
  const flags = { suite: 'suite', registry: 'registry', blocks: 'blocks', case: 'cases', apps: 'apps',
    timeout: 'timeout', 'generation-timeout': 'generationTimeout', iterations: 'iterations',
    'max-open-ms': 'maxOpenMs', 'fusion-app': 'fusionApp', targets: 'targetFile', computer: 'computer' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list') { options.list = true; continue; }
    if (arg === '--help') { options.help = true; continue; }
    const key = flags[arg.slice(2)], value = argv[++i];
    if (!arg.startsWith('--') || !key || !value || value.startsWith('--')) throw new Error('未知或缺值参数：' + arg);
    options[key] = ['blocks', 'cases', 'apps'].includes(key) ? value.split(',').filter(Boolean)
      : ['timeout', 'generationTimeout', 'iterations', 'maxOpenMs'].includes(key) ? Number(value) : value;
  }
  if (!['smoke', 'workflow', 'full', 'stress'].includes(options.suite)) throw new Error('suite 应为 smoke/workflow/full/stress');
  for (const [key, values, allowed] of [['blocks', options.blocks, Object.keys(blocks)], ['apps', options.apps, apps], ['case', options.cases, catalog.map(test => test.id)]])
    for (const value of values) if (!allowed.includes(value)) throw new Error(`${key} 不存在：${value}`);
  for (const key of ['timeout', 'generationTimeout', 'iterations', 'maxOpenMs'])
    if (options[key] != null && (!Number.isInteger(options[key]) || options[key] <= 0)) throw new Error(key + ' 必须为正整数');
  if (!['codex', 'cursor', 'devin'].includes(options.fusionApp)) throw new Error('Fusion 主 Agent 应为 codex/cursor/devin');
  if (!plan(options).length) throw new Error('筛选后没有场景');
  return options;
}

// Test the runner's accounting/cleanup independently of product implementation.
export async function execute(context, selected, suite, record = () => {}, results = []) {
  for (const test of selected) {
    const row = { id: test.id, block: test.block, title: test.title, refs: test.refs, app: test.app, mode: test.mode };
    const assertions = context.assertions.length, events = context.b.events.length, steps = context.b.steps.length, start = Date.now();
    if (test.mode === 'manual') { row.status = 'manual'; row.reason = test.reason; }
    else if (!enabled(test, suite)) { row.status = 'not-run'; row.reason = `${suite} 不执行 ${test.mode}；需显式选择对应套件`; }
    else {
      record(`${test.id}${test.app ? '/' + test.app : ''}…`);
      try {
        row.evidence = await test.run(context, test.app);
        if (context.assertions.length === assertions) throw new Error('场景没有执行任何断言');
        row.status = 'passed';
      } catch (error) {
        row.status = error instanceof Unavailable ? 'blocked' : 'failed'; row.reason = error.message;
        row.error = { name: error.name, stack: error.stack };
        try { row.state = await context.b.snapshot(); } catch (error) { row.snapshotError = error.message; }
        try { row.screenshot = await context.b.screenshot(`${test.id}-${test.app || 'shared'}`); } catch (error) { row.screenshotError = error.message; }
      } finally {
        row.assertions = context.assertions.slice(assertions); row.steps = context.b.steps.slice(steps);
        row.events = context.b.events.slice(events); row.durationMs = Date.now() - start;
        // A real uncaught page error is a failure even if a button-level assertion passed.
        if (row.status === 'passed' && row.events.some(event => event.type === 'exception')) {
          row.status = 'failed'; row.reason = '场景期间出现未捕获的浏览器异常';
        }
        try { await context.b.dismiss(); } catch (error) { row.status = 'failed'; row.reason = `场景收尾失败：${error.message}`; }
      }
    }
    results.push(row); await record(row);
  }
  return results;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parse(argv), selected = plan(options);
  if (options.help) { console.log('用法和场景：scripts/browser-tests/README.md；--list 列出功能，不连接或发送。'); return 0; }
  if (options.list) {
    console.table(selected.map(test => ({ block: test.block, case: test.id, app: test.app || 'shared', mode: test.mode,
      selected: enabled(test, options.suite), refs: test.refs.join(',') })));
    return 0;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-'), directory = path.join(root, '_shots/browser-tests', `${stamp}-${process.platform}`);
  await fs.mkdir(directory, { recursive: true });
  const data = { started: new Date().toISOString(), platform: process.platform, suite: options.suite,
    document: 'docs/testing/full-functional-audit-v445-20261111.md', results: [],
    scope: { apps: options.apps, blocks: options.blocks, cases: options.cases },
    proof: '本机既有配对 Chrome；真实手机和另一平台未验收' };
  let browser, context;
  try {
    data.revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    data.diffSha256 = createHash('sha256').update(execFileSync('git', ['diff', '--', 'app', 'server', 'lib'], { cwd: root })).digest('hex');
    const registry = JSON.parse(await fs.readFile(path.resolve(options.registry), 'utf8'));
    options.appUrl = registry.appUrl;
    if (options.targetFile) options.targets = JSON.parse(await fs.readFile(path.resolve(options.targetFile), 'utf8'));
    data.browser = await ensurePairedBrowser(registry);
    browser = await Browser.connect(data.browser.browserPort, data.browser.targetId, directory, options.timeout);
    context = new Context(browser, options, directory); await context.start();
    data.initial = context.initial;
    await execute(context, selected, options.suite, async row => {
      if (typeof row === 'string') console.log(row);
      else { console.log(`${row.status}: ${row.id}${row.app ? '/' + row.app : ''}${row.reason ? ' — ' + row.reason : ''}`);
        await fs.appendFile(path.join(directory, 'progress.jsonl'), JSON.stringify(row) + '\n'); }
    }, data.results);
  } catch (error) {
    data.results.push({ id: 'runner.setup', title: '配对环境和执行初始化', refs: ['F01'], status: 'blocked', reason: error.message });
    for (const test of selected) if (!data.results.some(row => row.id === test.id && row.app === test.app))
      data.results.push({ id: test.id, title: test.title, refs: test.refs, app: test.app, status: 'not-run', reason: '环境初始化或执行中断' });
  } finally {
    try {
      if (context?.original) data.cleanup = await context.finish();
      if (data.cleanup?.errors?.length) data.results.push({ id: 'runner.cleanup', title: '恢复原现场并清理本轮资源', refs: ['F05', 'X12'], status: 'failed', reason: JSON.stringify(data.cleanup.errors) });
    } catch (error) { data.results.push({ id: 'runner.cleanup', title: '恢复与清理异常', refs: ['F05'], status: 'failed', reason: error.message }); }
    finally { browser?.close(); }
    data.finished = new Date().toISOString(); await report(directory, data);
  }
  console.log(`报告：${path.relative(root, directory)}/report.md`); return verdict(data.results);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  main().then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 1; });
