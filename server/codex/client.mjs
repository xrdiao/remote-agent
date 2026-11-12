import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { readdir, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

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
      const child = this.child = this.spawnProcess(binary, ['app-server', '--stdio'], {
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
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        this.emit('disconnected', error);
      };
      child.once('error', closed);
      child.stdin.once('error', closed);
      child.once('exit', (code, signal) => closed(new Error(`Codex 后台已退出（${signal || code}）${this.stderr ? ': ' + this.stderr : ''}`)));
      await this.request('initialize', { clientInfo: { name: 'remote-agent', version: '1.0' }, capabilities: { experimentalApi: true } });
      this.notify('initialized');
      this.ready = true;
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
  request(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.write({ id, method, params }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  notify(method, params) { this.write({ method, ...(params === undefined ? {} : { params }) }); }
  reply(id, result) { this.write({ id, result }); }
  reject(id, message) { this.write({ id, error: { code: -32601, message } }); }
  close() { this.child?.kill(); }
}
