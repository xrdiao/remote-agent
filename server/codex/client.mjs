import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { readdir, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const REQUEST_TIMEOUT_MS = 30000;

export async function codexBinary() {
  if (process.env.CODEX_BIN) { await access(process.env.CODEX_BIN); return process.env.CODEX_BIN; }
  const directory = process.env.VSCODE_EXTENSIONS || path.join(os.homedir(), '.vscode', 'extensions');
  const platform = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[process.platform];
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
  const versions = (await readdir(directory)).filter(name => name.startsWith('openai.chatgpt-'))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const name of versions) {
    const file = path.join(directory, name, 'bin', `${platform}-${arch}`, process.platform === 'win32' ? 'codex.exe' : 'codex');
    try { await access(file); return file; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('未找到 Codex 后台程序，请安装 Codex 扩展或配置 CODEX_BIN');
}

// A relay owns one app-server. Phone connections own subscriptions, never the process.
export class CodexClient extends EventEmitter {
  constructor({ binary = codexBinary, spawnProcess = spawn } = {}) {
    super();
    this.binary = binary;
    this.spawnProcess = spawnProcess;
    this.pending = new Map();
    this.nextId = 0;
    this.generation = 0;
  }

  connect() {
    if (this.ready) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const binary = await this.binary();
      const child = this.child = this.spawnProcess(binary, ['-c', 'thread_unload_delay_secs=0', 'app-server', '--stdio'], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
      this.generation++;
      this.stderr = '';
      child.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-4000); });
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => this.receive(JSON.parse(line)));
      const closed = error => {
        if (this.child !== child) return;
        this.child = null;
        this.ready = false;
        lines.close();
        const disconnected = Object.assign(new Error(error.message, { cause: error }), { code: 'CODEX_RPC_DISCONNECTED' });
        for (const pending of this.pending.values()) pending.reject(disconnected);
        this.pending.clear();
        this.emit('disconnected', error);
      };
      child.once('error', closed);
      child.stdin.once('error', closed);
      child.once('exit', (code, signal) => closed(new Error(`Codex 后台已退出（${signal || code}）${this.stderr ? ': ' + this.stderr : ''}`)));
      try {
        await this.request('initialize', { clientInfo: { name: 'remote-agent', version: '1.0' }, capabilities: { experimentalApi: true } });
        this.notify('initialized');
        this.ready = true;
      } catch (error) {
        child.kill();
        closed(error);
        throw error;
      }
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  receive(packet) {
    if (packet.method) this.emit(packet.id == null ? 'notification' : 'request', packet);
    else {
      const pending = this.pending.get(packet.id);
      if (!pending) return;
      this.pending.delete(packet.id);
      if (packet.error) pending.reject(Object.assign(new Error(packet.error.message), { code: packet.error.code }));
      else pending.resolve(packet.result);
    }
  }

  write(packet) { this.child.stdin.write(JSON.stringify(packet) + '\n'); }
  request(method, params = {}, { onLateResult, onLateError = () => {}, lateSignal, timeout = REQUEST_TIMEOUT_MS } = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (onLateResult && !lateSignal?.aborted) {
          const cancel = () => this.pending.delete(id);
          const finishLate = callback => value => {
            lateSignal?.removeEventListener('abort', cancel);
            callback(value);
          };
          lateSignal?.addEventListener('abort', cancel, { once: true });
          this.pending.set(id, { resolve: finishLate(onLateResult), reject: finishLate(onLateError) });
        } else this.pending.delete(id);
        reject(Object.assign(new Error(`Codex 后台尚未确认 ${method} 的结果，请先核对原生状态`), { code: 'CODEX_RPC_TIMEOUT' }));
      }, timeout);
      timer.unref();
      const finish = callback => value => { clearTimeout(timer); callback(value); };
      this.pending.set(id, { resolve: finish(resolve), reject: finish(reject) });
      try { this.write({ id, method, params }); }
      catch (error) { this.pending.delete(id); finish(reject)(error); }
    });
  }
  notify(method, params) { this.write({ method, ...(params === undefined ? {} : { params }) }); }
  reply(id, result) { this.write({ id, result }); }
  async replyToRequest(request, result) {
    const { threadId, turnId } = request.params;
    let received, failed;
    const confirmation = new Promise((resolve, reject) => { received = resolve; failed = reject; });
    const notify = ({ method, params }) => {
      if (params?.threadId !== threadId) return;
      if (method === 'serverRequest/resolved' && params.requestId === request.id) received();
      if (method === 'thread/closed' || method === 'turn/completed' && params.turn.id === turnId)
        failed(new Error('Codex 会话已结束，未确认收到回答'));
    };
    this.on('notification', notify);
    this.once('disconnected', failed);
    const timer = setTimeout(() => failed(new Error('Codex 尚未确认收到回答，请核对卡片后重试')), 15000);
    try {
      this.reply(request.id, result);
      await confirmation;
    } finally {
      clearTimeout(timer);
      this.off('notification', notify);
      this.off('disconnected', failed);
    }
  }
  reject(id, message) { this.write({ id, error: { code: -32601, message } }); }
  close() { this.child?.kill(); }
}
