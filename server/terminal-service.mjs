import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import pty from 'node-pty';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';

export const TERMINAL_SIZE = { cols: 120, rows: 50 };
export const TERMINAL_SCROLLBACK = 1000;

function terminalSize(cols, rows) {
  if (!Number.isInteger(cols) || cols < 2 || !Number.isInteger(rows) || rows < 2)
    throw new Error('终端列数和行数必须是大于 1 的整数');
  return { cols, rows };
}

// The relay owns shells. A phone Session owns only a subscription to one of them.
export class TerminalService {
  constructor({ spawn = pty.spawn, shell = os.userInfo().shell, env = process.env } = {}) {
    this.spawn = spawn;
    this.shell = shell;
    this.env = env;
    this.terminals = new Map();
  }

  get(id) {
    const terminal = this.terminals.get(id);
    if (!terminal) throw new Error('这个 RA 终端已经不在了');
    return terminal;
  }

  metadata(terminal) {
    return { id: terminal.id, title: `${terminal.title} · ${terminal.process.pid}`, cwd: terminal.cwd, pid: terminal.process.pid,
      cols: terminal.screen.cols, rows: terminal.screen.rows, exited: terminal.exited,
      exitCode: terminal.exitCode, signal: terminal.signal };
  }

  list() { return [...this.terminals.values()].map(terminal => this.metadata(terminal)); }

  publish(terminal, message) {
    const event = { ...message, id: terminal.id, seq: ++terminal.seq };
    for (const receive of terminal.listeners) receive(event);
  }

  schedule(terminal, action) {
    const result = terminal.pending.then(action);
    // Return failures to the caller; the next independent request still gets its turn.
    terminal.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  async create({ cwd, host = '', cols = TERMINAL_SIZE.cols, rows = TERMINAL_SIZE.rows } = {}) {
    if (host) throw new Error('RA 终端暂不直接进入远程 SSH 或容器项目，请选择电脑本地目录');
    if (!path.isAbsolute(cwd || '')) throw new Error('新建终端需要明确的本机绝对目录');
    cwd = await realpath(cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error('终端初始路径不是文件夹');
    const size = terminalSize(cols, rows);
    const screen = new headless.Terminal({ ...size, scrollback: TERMINAL_SCROLLBACK, allowProposedApi: true });
    const serializer = new serialize.SerializeAddon();
    screen.loadAddon(serializer);
    let process;
    try {
      process = this.spawn(this.shell, ['-i'], { ...size, name: 'xterm-256color', cwd,
        env: { ...this.env, TERM: 'xterm-256color' } });
    } catch (error) { screen.dispose(); throw error; }
    const terminal = { id: crypto.randomUUID(), title: path.basename(this.shell), cwd, process, screen, serializer,
      seq: 0, pending: Promise.resolve(), listeners: new Set(), exited: false, closed: false };
    this.terminals.set(terminal.id, terminal);
    process.onData(data => {
      if (terminal.closed) return;
      this.schedule(terminal, () => new Promise(resolve => screen.write(data, () => {
        this.publish(terminal, { t: 'termData', data });
        resolve();
      })));
    });
    process.onExit(({ exitCode, signal }) => {
      terminal.exited = true;
      terminal.exitCode = exitCode;
      terminal.signal = signal;
      if (!terminal.closed) this.schedule(terminal, () => {
        this.publish(terminal, { t: 'termExit', exitCode, signal });
      });
    });
    return this.metadata(terminal);
  }

  async subscribe(id, receive) {
    const terminal = this.get(id);
    let subscribed = true;
    await this.schedule(terminal, () => {
      if (terminal.closed) throw new Error('这个 RA 终端已经关闭');
      terminal.listeners.add(receive);
      receive({ t: 'termSnapshot', ...this.metadata(terminal), seq: terminal.seq,
        data: terminal.serializer.serialize() });
    });
    return () => { if (subscribed) terminal.listeners.delete(receive); subscribed = false; };
  }

  write(id, data) {
    const terminal = this.get(id);
    return this.schedule(terminal, () => {
      if (terminal.closed || terminal.exited) throw new Error('终端已经退出，无法继续输入');
      terminal.process.write(data);
    });
  }

  resize(id, cols, rows) {
    const size = terminalSize(cols, rows), terminal = this.get(id);
    return this.schedule(terminal, () => {
      if (terminal.closed || terminal.exited) throw new Error('终端已经退出，无法调整尺寸');
      terminal.screen.resize(size.cols, size.rows);
      terminal.process.resize(size.cols, size.rows);
      this.publish(terminal, { t: 'termSize', ...size });
      return this.metadata(terminal);
    });
  }

  async close(id) {
    const terminal = this.get(id);
    this.terminals.delete(id);
    terminal.closed = true;
    if (!terminal.exited) terminal.process.kill();
    await this.schedule(terminal, () => {
      this.publish(terminal, { t: 'termClosed' });
      terminal.listeners.clear();
      terminal.screen.dispose();
    });
  }

  dispose() {
    for (const terminal of this.terminals.values()) {
      terminal.closed = true;
      if (!terminal.exited) terminal.process.kill();
      terminal.listeners.clear();
      terminal.screen.dispose();
    }
    this.terminals.clear();
  }
}

export const terminalService = new TerminalService();
