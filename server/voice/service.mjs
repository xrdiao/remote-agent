import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { findDevice, needsTotp, bindDeviceConnection } from '../../lib/auth.mjs';
import { ASR_DIR, voiceEngines } from './config.mjs';

// Exported for stop-rule tests; production code goes through loadWorker/stopWorker.
export const runtimes = new Map();
const LAST_ENGINE_FILE = path.join(ASR_DIR, 'last-engine.json');
export function voiceStatus(engineId) {
  const engines = voiceEngines().map(({ id, label, detail }) => ({ id, label, detail, ready: runtimes.get(id)?.state === 'ready' }));
  const selected = engines.find(engine => engine.id === engineId) || (!engineId && engines[0]);
  return { installed: !!selected, ready: !!selected?.ready, engine: selected ? selected.label + ' · ' + selected.detail : '', engineId: selected?.id || '', engines };
}
function stopWorker(runtime, reason = 'engine switched', engineId = '') {
  if (runtime.stopping) return runtime.stopping;
  const child = runtime.worker;
  if (!child) return;
  console.error(`[voice:${engineId}] stopped (${reason})`);
  clearTimeout(runtime.idleTimer); runtime.idleTimer = null;
  runtime.stopping = new Promise(resolve => child.once('close', resolve)).finally(() => { runtime.stopping = null; });
  runtime.cancelLoad?.();
  runtime.activateReject?.(new Error('已切换语音引擎')); runtime.activating = null;
  runtime.worker = null; runtime.loading = null; runtime.cancelLoad = null;
  runtime.state = 'stopped';
  runtime.sessions.clear(); child.kill();
  return runtime.stopping;
}
export async function loadWorker(engineId = voiceStatus().engineId, client, deviceId) {
  const config = voiceEngines().find(engine => engine.id === engineId);
  if (!config) return Promise.reject(new Error('所选语音引擎未安装，请在电脑运行 npm run voice:setup（Qwen 加 -- --engine qwen）并同意安装'));
  let runtime = runtimes.get(engineId);
  if (!runtime) { runtime = { worker: null, loading: null, activating: null, sessions: new Map(), clients: new Map(), lastDevice: '', state: 'preparing', idleTimer: null }; runtimes.set(engineId, runtime); }
  if (client) { runtime.clients.set(client, deviceId); clearTimeout(runtime.idleTimer); runtime.idleTimer = null; }
  if (deviceId) runtime.lastDevice = deviceId;
  const stopping = [];
  for (const [id, other] of runtimes) {
    if (id === engineId) continue;
    // The same paired device committed a new engine; other devices keep their streams.
    for (const [socket, owner] of other.clients) if (socket.readyState >= 2 || (deviceId && owner === deviceId)) {
      other.clients.delete(socket);
      if (socket.readyState < 2) socket.close(1000, 'engine switched');
    }
    // Stop an idle runtime only when the device that last used it switched away;
    // a call without a device never stops other engines.
    if (deviceId && !other.clients.size && other.lastDevice === deviceId) stopping.push(stopWorker(other, 'engine switched', id));
  }
  await Promise.all(stopping);
  if (runtime.stopping) await runtime.stopping;
  if (client && client.readyState !== 1) throw new Error('语音连接已关闭');
  // Phase 1: ensure a spawned worker is prepared (Qwen: no GPU yet; Sherpa loads fully).
  if (!runtime.worker && !runtime.loading) spawnRuntime(engineId, runtime, config);
  await runtime.loading;
  // Phase 2 (Qwen only, only when a real client is attached): activate the engine.
  if (engineId === 'qwen' && client && runtime.state !== 'ready') {
    if (!runtime.activating) {
      runtime.readyStartedAt = Date.now();
      runtime.activating = (async () => {
        if (runtime.state === 'ready') return runtime;
        writeWorker(runtime, { type: 'load' });
        await new Promise((resolve, reject) => { runtime.activateResolve = resolve; runtime.activateReject = reject; });
        return runtime;
      })().finally(() => { runtime.activating = null; });
    }
    await runtime.activating;
    // The caller may have been the last client and already closed: arm idle release.
    scheduleIdleRelease(engineId, runtime);
  }
  return runtime;
}
function spawnRuntime(engineId, runtime, config) {
  runtime.state = 'preparing';
  runtime.loadStartedAt = Date.now();
  runtime.loading = new Promise((resolve, reject) => {
    const child = spawn(config.python, [...(engineId === 'qwen' ? ['-I'] : []), '-u', fileURLToPath(new URL(config.script, import.meta.url)), config.model], { stdio: ['pipe', 'pipe', 'pipe'] });
    runtime.worker = child;
    let details = '', startupError = '', settled = false;
    runtime.cancelLoad = () => { if (!settled) { settled = true; reject(new Error('已切换语音引擎')); } };
    child.stderr.on('data', chunk => { details = settled ? (details + chunk).slice(-2000) : details + chunk; });
    const fail = error => {
      if (runtime.worker !== child) return;
      runtime.worker = null; runtime.loading = null; runtime.state = 'stopped';
      if (!settled) { settled = true; reject(error); }
      runtime.activateReject?.(error); runtime.activating = null;
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
      if (event.type === 'prepared') {
        runtime.state = 'prepared';
        console.log(`[voice:${engineId}] prepared in ${Date.now() - runtime.loadStartedAt}ms`);
        settled = true; details = ''; runtime.loading = null;
        resolve(runtime);
      } else if (event.type === 'ready') {
        runtime.state = 'ready';
        const base = runtime.readyStartedAt ?? runtime.loadStartedAt;
        console.log(`[voice:${engineId}] ready in ${Date.now() - base}ms`);
        const activateResolve = runtime.activateResolve;
        runtime.activateResolve = null; runtime.activateReject = null;
        if (activateResolve) { activateResolve(runtime); }
        else { settled = true; details = ''; runtime.loading = null; resolve(runtime); }
      } else if (event.type === 'error' && !event.id) {
        startupError = event.message;
        runtime.activateReject?.(new Error(event.message)); runtime.activating = null;
      } else runtime.sessions.get(event.id)?.(event);
    });
  });
}
// Qwen releases all VRAM when nobody is listening: stop the worker and respawn a
// phase-1 (prepared, 0 VRAM) one — sleep mode level 2 only freed ~1.3 GiB of
// ~5.7 GiB on this stack, so respawn is the release strategy.
function scheduleIdleRelease(engineId, runtime) {
  if (engineId !== 'qwen' || runtime.idleTimer || runtime.clients.size || runtime.sessions.size || runtime.state !== 'ready') return;
  runtime.idleTimer = setTimeout(() => {
    runtime.idleTimer = null;
    if (runtime.clients.size || runtime.sessions.size || runtime.state !== 'ready') return;
    void (async () => {
      const started = Date.now();
      await stopWorker(runtime, 'idle release', engineId);
      if (runtime.clients.size) return;
      const config = voiceEngines().find(engine => engine.id === engineId);
      if (!config) return;
      spawnRuntime(engineId, runtime, config);
      try { await runtime.loading; } catch { return; }
      console.log(`[voice:${engineId}] released (respawn) in ${Date.now() - started}ms`);
    })().catch(error => console.error(`[voice:${engineId}] release failed: ${error.message}`));
  }, 60_000);
}
// Relaunch the engine the last paired device was using so the first open is warm.
export async function preloadVoice() {
  try {
    if (!fs.existsSync(LAST_ENGINE_FILE)) return;
    const last = JSON.parse(fs.readFileSync(LAST_ENGINE_FILE, 'utf8'));
    if (!last?.engine || !voiceEngines().some(engine => engine.id === last.engine)) return;
    await loadWorker(last.engine, null, last.device);
  } catch (error) {
    console.error('[voice] preload failed:', error.message);
  }
}
// Adapter boundary: start / audio / end / cancel -> partial / final, independent of Agent sessions.
function writeWorker(runtime, message) { return runtime.worker.stdin.write(JSON.stringify(message) + '\n'); }
export function voiceWss() {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 << 10, perMessageDeflate: false });
  wss.on('connection', ws => {
    let device = null, token = '', id = '', ended = false, engineId = '', runtime = null;
    let authorization = null;
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
          authorization = bindDeviceConnection(device.id, () => ws.close(4001, 'unauthorized'));
          engineId = message.engine || voiceStatus().engineId;
          try {
            const prev = fs.existsSync(LAST_ENGINE_FILE) ? JSON.parse(fs.readFileSync(LAST_ENGINE_FILE, 'utf8')) : null;
            if (prev?.engine !== engineId || prev?.device !== device.id) fs.writeFileSync(LAST_ENGINE_FILE, JSON.stringify({ engine: engineId, device: device.id }));
          } catch {}
          await startStream();
          return;
        }
        if (!authorization.valid || ws.readyState !== 1 || !id) return;
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
      authorization?.release();
      const rt = runtime || runtimes.get(engineId);
      rt?.clients.delete(ws);
      if (id && rt) {
        rt.sessions.delete(id);
        if (rt.worker && !rt.loading) writeWorker(rt, { id, type: 'cancel' });
      }
      if (rt) scheduleIdleRelease(engineId, rt);
    });
  });
  return wss;
}
process.once('exit', () => { for (const runtime of runtimes.values()) runtime.worker?.kill(); });
