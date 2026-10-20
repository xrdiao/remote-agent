import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { findDevice, needsTotp } from '../../lib/auth.mjs';
import { voiceEngines } from './config.mjs';

const runtimes = new Map();
export function voiceStatus(engineId) {
  const engines = voiceEngines().map(({ id, label, detail }) => ({ id, label, detail, ready: !!runtimes.get(id)?.worker && !runtimes.get(id)?.loading }));
  const selected = engines.find(engine => engine.id === engineId) || (!engineId && engines[0]);
  return { installed: !!selected, ready: !!selected?.ready, engine: selected ? selected.label + ' · ' + selected.detail : '', engineId: selected?.id || '', engines };
}
function stopWorker(runtime) {
  if (runtime.stopping) return runtime.stopping;
  const child = runtime.worker;
  if (!child) return;
  runtime.stopping = new Promise(resolve => child.once('close', resolve)).finally(() => { runtime.stopping = null; });
  runtime.cancelLoad?.();
  runtime.worker = null; runtime.loading = null; runtime.cancelLoad = null;
  runtime.sessions.clear(); child.kill();
  return runtime.stopping;
}
export async function loadWorker(engineId = voiceStatus().engineId, client, deviceId) {
  const config = voiceEngines().find(engine => engine.id === engineId);
  if (!config) return Promise.reject(new Error('所选语音引擎未安装，请在电脑运行 npm run voice:setup（Qwen 加 -- --engine qwen）并同意安装'));
  let runtime = runtimes.get(engineId);
  if (!runtime) { runtime = { worker: null, loading: null, sessions: new Map(), clients: new Map() }; runtimes.set(engineId, runtime); }
  if (client) runtime.clients.set(client, deviceId);
  const stopping = [];
  for (const [id, other] of runtimes) {
    if (id === engineId) continue;
    // The same paired device committed a new engine; other devices keep their streams.
    for (const [socket, owner] of other.clients) if (socket.readyState >= 2 || (deviceId && owner === deviceId)) {
      other.clients.delete(socket);
      if (socket.readyState < 2) socket.close(1000, 'engine switched');
    }
    if (!other.clients.size) stopping.push(stopWorker(other));
  }
  await Promise.all(stopping);
  if (runtime.stopping) await runtime.stopping;
  if (client && client.readyState !== 1) throw new Error('语音连接已关闭');
  if (runtime.loading) return runtime.loading;
  if (runtime.worker) return Promise.resolve(runtime);
  runtime.loading = new Promise((resolve, reject) => {
    const child = spawn(config.python, [...(engineId === 'qwen' ? ['-I'] : []), '-u', fileURLToPath(new URL(config.script, import.meta.url)), config.model], { stdio: ['pipe', 'pipe', 'pipe'] });
    runtime.worker = child;
    let details = '', startupError = '', settled = false;
    runtime.cancelLoad = () => { if (!settled) { settled = true; reject(new Error('已切换语音引擎')); } };
    child.stderr.on('data', chunk => { details = settled ? (details + chunk).slice(-2000) : details + chunk; });
    const fail = error => {
      if (runtime.worker !== child) return;
      runtime.worker = null; runtime.loading = null;
      if (!settled) { settled = true; reject(error); }
      for (const callback of runtime.sessions.values()) callback({ type: 'error', message: error.message });
      runtime.sessions.clear();
    };
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.on('close', code => {
      if (runtime.worker !== child) return;
      if (code !== 0) console.error(`[voice:${engineId}] ${details.trim()}`);
      fail(new Error(startupError || `本机语音进程已退出（${code}）：${details.trim()}`));
    });
    createInterface({ input: child.stdout }).on('line', line => {
      if (runtime.worker !== child) return;
      const event = JSON.parse(line);
      if (event.type === 'ready') { settled = true; details = ''; runtime.loading = null; resolve(runtime); }
      else if (event.type === 'error' && !event.id) startupError = event.message;
      else runtime.sessions.get(event.id)?.(event);
    });
  });
  return runtime.loading;
}
// Adapter boundary: start / audio / end / cancel -> partial / final, independent of Agent sessions.
function writeWorker(runtime, message) { return runtime.worker.stdin.write(JSON.stringify(message) + '\n'); }
export function voiceWss() {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 << 10, perMessageDeflate: false });
  wss.on('connection', ws => {
    let device = null, token = '', id = '', ended = false, engineId = '', runtime = null;
    const reply = event => { if (ws.readyState === 1) ws.send(JSON.stringify(event)); };
    const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), 5000);
    ws.on('error', () => {});
    const startStream = async () => {
      if (ws.readyState !== 1) return;
      if (!voiceStatus(engineId).ready) reply({ type: 'loading' });
      runtime = await loadWorker(engineId, ws, device.id);
      if (ws.readyState !== 1) return;
      const streamId = crypto.randomUUID();
      id = streamId; ended = false;
      runtime.sessions.set(streamId, event => {
        reply(event);
        if (event.type === 'final' || event.type === 'error') {
          runtime.sessions.delete(streamId);
          if (id === streamId) id = '';
          if (event.type === 'error') ws.close();
          else startStream().catch(error => { reply({ type: 'error', message: error.message }); ws.close(); });
        }
      });
      writeWorker(runtime, { id: streamId, type: 'start' });
    };
    ws.on('message', async (raw, binary) => {
      try {
        if (!device) {
          clearTimeout(authTimer);
          const message = binary ? {} : JSON.parse(raw);
          token = message.token || '';
          device = message.type === 'auth' ? findDevice(token) : null;
          if (!device || needsTotp(device)) return ws.close(4001, 'unauthorized');
          engineId = message.engine || voiceStatus().engineId;
          await startStream();
          return;
        }
        if (!id) return;
        const live = findDevice(token);
        if (!live || needsTotp(live)) return ws.close(4001, 'unauthorized');
        if (binary) {
          if (ended) return;
          if (raw.length % 2) throw new Error('音频必须是 PCM16');
          if (!writeWorker(runtime, { id, type: 'audio', audio: raw.toString('base64') })) {
            ws.pause(); runtime.worker.stdin.once('drain', () => ws.resume());
          }
        } else {
          const message = JSON.parse(raw);
          if (message.type === 'end' && !ended) { ended = true; writeWorker(runtime, { id, type: 'end' }); }
          if (message.type === 'cancel' && message.id === id) {
            runtime.sessions.delete(id); writeWorker(runtime, { id, type: 'cancel' }); id = '';
            await startStream();
          }
        }
      } catch (error) { reply({ type: 'error', message: error.message }); ws.close(); }
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      (runtime || runtimes.get(engineId))?.clients.delete(ws);
      if (!id) return;
      runtime.sessions.delete(id);
      if (runtime.worker && !runtime.loading) writeWorker(runtime, { id, type: 'cancel' });
    });
  });
  return wss;
}
process.once('exit', () => { for (const runtime of runtimes.values()) runtime.worker?.kill(); });
