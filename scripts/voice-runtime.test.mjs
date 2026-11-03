import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(new URL('../server/voice/service.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/^export /gm, '')
  .replaceAll('import.meta.url', JSON.stringify(new URL('../server/voice/service.mjs', import.meta.url).href));
const settle = () => new Promise(resolve => setImmediate(resolve));

function voice(platform = 'linux', { exitOnKill = true } = {}) {
  const queries = [], children = [], commands = [], logs = [], timers = new Map();
  let now = 0;
  const engines = [{ id: 'qwen', python: 'qwen-python', script: 'qwen-worker.py', model: 'qwen-model', gpuUuid: 'selected', env: { MODEL_OPTION: 'keep' } },
    { id: 'sherpa', python: 'cpu-python', script: 'worker.py', model: 'cpu-model' }];
  const context = vm.createContext({ URL, fileURLToPath, AbortController, ASR_DIR: '/fixture', path: { join: (...args) => args.join('/') },
    process: { platform, env: { FIXTURE: 'kept' }, once() {} }, console: { log() {}, error: message => logs.push(message) },
    fs: {}, voiceEngines: () => engines, promisify: action => action,
    execFile: (command, args, options) => new Promise((resolve, reject) => {
      const query = { command, args, options, resolve: stdout => resolve({ stdout }), reject };
      queries.push(query); options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
    spawn: (python, args, options) => {
      const child = new EventEmitter(); child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdin.write = raw => { commands.push(JSON.parse(raw)); return true; };
      const record = { child, python, args, options, kills: 0 };
      child.kill = () => { record.kills++; if (exitOnKill) queueMicrotask(() => child.emit('close', 0)); return true; };
      children.push(record); return child;
    },
    createInterface: ({ input }) => input,
    setTimeout: (fn, ms) => { const timer = { unref() {} }; timers.set(timer, { fn, at: now + ms }); return timer; },
    clearTimeout: timer => timers.delete(timer),
  });
  vm.runInContext(source + '\nthis.api = { loadWorker, runtimes, scheduleIdleRelease };', context);
  return { ...context.api, queries, children, commands, engines, logs,
    event(index, type) { children[index].child.stdout.emit('line', JSON.stringify({ type })); },
    timers: () => timers.size,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next; now = timer.at; timers.delete(id); timer.fn();
      }
      now = end;
    } };
}

test('slow GPU discovery yields the event loop and concurrent preparation shares one worker and sorted GPU mapping', async () => {
  const h = voice(), first = h.loadWorker('qwen', null, 'device'), second = h.loadWorker('qwen', null, 'device');
  await settle(); assert.equal(h.queries.length, 1); assert.equal(h.children.length, 0); assert(h.runtimes.get('qwen').loading);
  const query = h.queries[0]; assert.equal(query.command, 'nvidia-smi');
  assert.deepEqual([...query.args], ['--query-gpu=pci.bus_id,uuid', '--format=csv,noheader']);
  h.queries[0].resolve('00000000:02:00.0, selected\n00000000:01:00.0, other\n'); await settle();
  assert.equal(h.children.length, 1);
  assert.equal(h.children[0].options.env.CUDA_VISIBLE_DEVICES, '1');
  assert.equal(h.children[0].options.env.CUDA_DEVICE_ORDER, 'PCI_BUS_ID');
  assert.equal(h.children[0].options.env.FIXTURE, 'kept'); assert.equal(h.children[0].options.env.MODEL_OPTION, 'keep');
  h.event(0, 'prepared'); const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b); assert.equal(a.state, 'prepared');
});

for (const failure of ['query error', 'missing GPU']) {
  test(`GPU ${failure} ends preparation without spawning or changing cards`, async () => {
    const h = voice(), work = h.loadWorker('qwen', null, 'device');
    const rejected = assert.rejects(work, failure === 'query error' ? /driver query failed/ : /未找到指定的 GPU/);
    await settle();
    if (failure === 'query error') h.queries[0].reject(new Error('driver query failed'));
    else h.queries[0].resolve('00000000:01:00.0, other\n');
    await rejected; assert.equal(h.children.length, 0); assert.equal(h.runtimes.get('qwen').loading, null);
    assert.equal(h.runtimes.get('qwen').state, 'stopped');
  });
}

test('switching engines during GPU discovery cancels that query and prevents a late Qwen spawn', async () => {
  const h = voice(), first = h.loadWorker('qwen', null, 'device'), rejected = assert.rejects(first, /已切换语音引擎/);
  await settle(); const cpu = h.loadWorker('sherpa', null, 'device'); await settle(); await rejected;
  assert.equal(h.queries[0].options.signal.aborted, true); assert.equal(h.children.length, 1);
  assert.equal(h.children[0].python, 'cpu-python');
  h.queries[0].resolve('00000000:01:00.0, selected\n'); await settle(); assert.equal(h.children.length, 1);
  h.event(0, 'ready'); assert.equal((await cpu).state, 'ready');
});

test('CPU Windows encoding and Qwen without an explicit GPU retain their original environment and arguments', async () => {
  const cpu = voice('win32'), work = cpu.loadWorker('sherpa'); await settle();
  assert.equal(cpu.queries.length, 0); assert.equal(cpu.children[0].options.env.PYTHONIOENCODING, 'utf-8');
  cpu.event(0, 'ready'); await work;
  const qwen = voice(); delete qwen.engines[0].gpuUuid;
  const warm = qwen.loadWorker('qwen'); await settle(); assert.equal(qwen.queries.length, 0);
  assert.equal(qwen.children[0].options.env, undefined); assert.equal(qwen.children[0].args[0], '-I');
  qwen.event(0, 'prepared'); await warm;
});

const client = () => ({ readyState: 1, close() { this.readyState = 3; } });
async function readyQwen(h, socket = client()) {
  const work = h.loadWorker('qwen', socket, 'device'); await settle();
  h.queries[0].resolve('00000000:01:00.0, selected\n'); await settle();
  h.event(0, 'prepared'); await settle(); h.event(0, 'ready');
  return { runtime: await work, socket };
}

test('a normal exit clears its switch budget and only then starts the next engine', async () => {
  const h = voice(), { runtime } = await readyQwen(h);
  const next = h.loadWorker('sherpa', null, 'device'); await settle();
  assert.equal(runtime.state, 'stopped'); assert.equal(runtime.worker, null); assert.equal(runtime.stopping, null);
  assert.equal(h.children[0].kills, 1); assert.equal(h.timers(), 0); assert.equal(h.children.length, 2);
  h.event(1, 'ready'); assert.equal((await next).state, 'ready');
});

test('the five-second switch deadline keeps an unexited worker and only explicit retry after real close can start another', async () => {
  const h = voice('linux', { exitOnKill: false }), { runtime } = await readyQwen(h);
  let ended = false;
  const next = h.loadWorker('sherpa', null, 'device'); next.catch(() => { ended = true; });
  const rejected = assert.rejects(next, /旧语音进程尚未退出，切换未完成/);
  await settle(); assert.equal(runtime.state, 'stopping'); assert.equal(runtime.worker, h.children[0].child);
  assert(runtime.stopping); assert.equal(h.children.length, 1); assert.equal(h.children[0].kills, 1);
  h.event(0, 'ready'); h.children[0].child.stdin.emit('error', new Error('late pipe close'));
  assert.equal(runtime.state, 'stopping'); assert.equal(runtime.worker, h.children[0].child);
  h.advance(4999); await settle(); assert.equal(ended, false);
  h.advance(1); await rejected; assert.equal(h.timers(), 0);
  assert.equal(runtime.state, 'stopping'); assert(runtime.stopping); assert.equal(h.children.length, 1);
  const again = h.loadWorker('sherpa', null, 'device'), againRejected = assert.rejects(again, /切换未完成/);
  await settle(); assert.equal(h.children[0].kills, 1); h.advance(5000); await againRejected;
  h.children[0].child.emit('close', 0); await settle();
  assert.equal(runtime.worker, null); assert.equal(runtime.state, 'stopped'); assert.equal(runtime.stopping, null);
  assert.equal(h.children.length, 1);
  const retry = h.loadWorker('sherpa', null, 'device'); await settle(); assert.equal(h.children.length, 2);
  h.event(1, 'ready'); assert.equal((await retry).state, 'ready');
});

test('reentering the stopping engine uses the same exit and cannot wait beyond its own switch budget', async () => {
  const h = voice('linux', { exitOnKill: false }), { runtime } = await readyQwen(h);
  const other = h.loadWorker('sherpa', null, 'device'), otherRejected = assert.rejects(other, /切换未完成/); await settle();
  const same = h.loadWorker('qwen', null, 'device'), sameRejected = assert.rejects(same, /切换未完成/); await settle();
  assert.equal(h.timers(), 2); h.advance(5000); await Promise.all([otherRejected, sameRejected]);
  assert.equal(h.children.length, 1); assert.equal(h.children[0].kills, 1); assert.equal(runtime.state, 'stopping');
  h.children[0].child.emit('close', 0); await settle(); assert.equal(runtime.worker, null);
});

test('stopping during worker preparation rejects loading but retains the real process until close', async () => {
  const h = voice('linux', { exitOnKill: false });
  const preparing = h.loadWorker('qwen', null, 'device'), cancelled = assert.rejects(preparing, /已切换语音引擎/);
  await settle(); h.queries[0].resolve('00000000:01:00.0, selected\n'); await settle();
  const runtime = h.runtimes.get('qwen'), next = h.loadWorker('sherpa', null, 'device'), rejected = assert.rejects(next, /切换未完成/);
  await settle(); await cancelled; h.event(0, 'prepared');
  assert.equal(runtime.state, 'stopping'); assert.equal(runtime.worker, h.children[0].child);
  h.advance(5000); await rejected; assert.equal(h.children.length, 1);
  h.children[0].child.emit('close', 0); await settle(); assert.equal(runtime.state, 'stopped'); assert.equal(runtime.loading, null);
});

test('another paired device still using an engine prevents its stop and is not included in the switch deadline', async () => {
  const h = voice(), { runtime, socket } = await readyQwen(h), other = client();
  assert.equal(await h.loadWorker('qwen', other, 'other-device'), runtime);
  const next = h.loadWorker('sherpa', null, 'device'); await settle();
  assert.equal(socket.readyState, 3); assert.equal(other.readyState, 1); assert.equal(h.children[0].kills, 0);
  assert.equal(runtime.state, 'ready'); assert.equal(h.timers(), 0);
  h.event(1, 'ready'); await next;
});

test('an unexpected worker failure remains a real error instead of entering the stop budget', async () => {
  const h = voice(), work = h.loadWorker('sherpa', null, 'device'), rejected = assert.rejects(work, /worker failed/);
  await settle(); h.children[0].child.emit('error', new Error('worker failed')); await rejected;
  assert.equal(h.runtimes.get('sherpa').state, 'stopped'); assert.equal(h.runtimes.get('sherpa').worker, null); assert.equal(h.timers(), 0);
});

test('idle release uses the same exit budget and does not respawn after a timed-out late exit', async () => {
  const h = voice('linux', { exitOnKill: false }), { runtime } = await readyQwen(h);
  runtime.clients.clear(); h.scheduleIdleRelease('qwen', runtime); h.advance(60000); await settle();
  assert.equal(runtime.state, 'stopping'); assert.equal(h.timers(), 1); assert.equal(h.children[0].kills, 1);
  h.advance(5000); await settle(); assert(h.logs.some(message => /release failed.*切换未完成/.test(message)));
  assert.equal(runtime.worker, h.children[0].child); assert.equal(h.queries.length, 1);
  h.children[0].child.emit('close', 0); await settle();
  assert.equal(runtime.state, 'stopped'); assert.equal(h.children.length, 1); assert.equal(h.queries.length, 1);
});

test('normal idle release waits for close and prepares one replacement without loading its GPU model', async () => {
  const h = voice(), { runtime } = await readyQwen(h);
  runtime.clients.clear(); h.scheduleIdleRelease('qwen', runtime); h.advance(60000); await settle();
  assert.equal(h.children[0].kills, 1); assert.equal(h.timers(), 0); assert.equal(h.queries.length, 2);
  h.queries[1].resolve('00000000:01:00.0, selected\n'); await settle(); h.event(1, 'prepared'); await settle();
  assert.equal(runtime.state, 'prepared'); assert.equal(h.children.length, 2);
  assert.equal(h.commands.filter(command => command.type === 'load').length, 1);
});
