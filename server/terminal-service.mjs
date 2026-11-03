import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath, stat } from 'node:fs/promises';
import pty from 'node-pty';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';

export const TERMINAL_SIZE = { cols: 120, rows: 50 };
export const TERMINAL_SCROLLBACK = 1000;
const shellRc = fileURLToPath(new URL('./terminal-shell.bash', import.meta.url));
const shellMarker = '\x1b]777;RA;';

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

  shellOutput(terminal, data) {
    terminal.shellBuffer += data;
    let output = '';
    while (terminal.shellBuffer) {
      const start = terminal.shellBuffer.indexOf(shellMarker);
      if (start < 0) {
        let tail = Math.min(shellMarker.length - 1, terminal.shellBuffer.length);
        while (tail && !terminal.shellBuffer.endsWith(shellMarker.slice(0, tail))) tail--;
        output += terminal.shellBuffer.slice(0, terminal.shellBuffer.length - tail);
        terminal.shellBuffer = terminal.shellBuffer.slice(terminal.shellBuffer.length - tail);
        break;
      }
      output += terminal.shellBuffer.slice(0, start);
      terminal.shellBuffer = terminal.shellBuffer.slice(start);
      const end = terminal.shellBuffer.indexOf('\x07', shellMarker.length);
      if (end < 0) break;
      const [kind, encoded] = terminal.shellBuffer.slice(shellMarker.length, end).split(';');
      terminal.shellBuffer = terminal.shellBuffer.slice(end + 1);
      if (kind === 'ready') terminal.shellReady();
      else if (kind === 'prompt' || kind === 'run') {
        terminal.prompt = kind === 'prompt';
        if (terminal.prompt) terminal.cwd = Buffer.from(encoded, 'base64').toString();
        if (terminal.prompt && terminal.query) {
          terminal.query.reject(new Error('Shell 补全或历史读取已被中断'));
          terminal.query = null;
        }
        this.publish(terminal, { t: 'termShell', prompt: terminal.prompt, cwd: terminal.cwd });
      } else if (terminal.query?.kind === kind) {
        const query = terminal.query;
        terminal.query = null;
        query.resolve(Buffer.from(encoded, 'base64').toString());
      }
    }
    return output;
  }

  inputAction(terminal, action) {
    const result = terminal.inputPending.then(action);
    terminal.inputPending = result.then(() => undefined, () => undefined);
    return result;
  }

  queryInput(terminal, kind, keys) {
    if (terminal.closed || terminal.exited) throw new Error('终端已经退出，无法继续输入');
    if (!terminal.prompt) throw new Error('终端正在运行程序，请先结束程序后读取命令补全或历史');
    return new Promise((resolve, reject) => {
      terminal.query = { kind, resolve, reject };
      terminal.process.write(keys);
    });
  }

  complete(id, text, caret) {
    const terminal = this.get(id);
    return this.inputAction(terminal, async () => {
      const left = [...text.slice(caret)].length;
      const same = terminal.inputLine?.text === text && terminal.inputLine.caret === caret;
      // Reading READLINE_LINE is itself a key binding. A repeated Tab must still list ambiguous candidates.
      const keys = same ? '\t\t\x1b[99~'
        : '\x1b[97~\x1b[200~' + text + '\x1b[201~' + '\x1b[D'.repeat(left) + '\t\x1b[99~';
      const result = await this.queryInput(terminal, 'input', keys);
      const separator = result.indexOf('\0'), value = result.slice(separator + 1);
      return terminal.inputLine = { text: value, caret: [...value].slice(0, Number(result.slice(0, separator))).join('').length };
    });
  }

  history(id) {
    const terminal = this.get(id);
    return this.inputAction(terminal, async () => {
      const history = await this.queryInput(terminal, 'history', '\x1b[98~');
      const entries = [...history.matchAll(/(?:^|\n)[ \t]*\d+\*?[ \t]+\x1e/g)];
      return entries.map((entry, index) => history.slice(entry.index + entry[0].length,
        entries[index + 1]?.index ?? history.length - 1));
    });
  }

  submit(id, text) {
    const terminal = this.get(id);
    return this.inputAction(terminal, () => this.write(id, terminal.prompt
      ? '\x1b[97~\x1b[200~' + text + '\x1b[201~\r' : text + '\r'));
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
      process = this.spawn(this.shell, ['--rcfile', shellRc, '-i'], { ...size, name: 'xterm-256color', cwd,
        env: { ...this.env, TERM: 'xterm-256color' } });
    } catch (error) { screen.dispose(); throw error; }
    const terminal = { id: crypto.randomUUID(), title: path.basename(this.shell), cwd, process, screen, serializer,
      seq: 0, pending: Promise.resolve(), inputPending: Promise.resolve(), shellBuffer: '', prompt: false,
      listeners: new Set(), exited: false, closed: false };
    let exitedBeforeReady;
    const shellReady = new Promise((resolve, reject) => { terminal.shellReady = resolve; exitedBeforeReady = reject; });
    this.terminals.set(terminal.id, terminal);
    // A single terminal screen answers protocol queries, including when no phone is watching.
    screen.onData(data => { if (!terminal.closed && !terminal.exited) process.write(data); });
    process.onData(data => {
      if (terminal.closed) return;
      this.schedule(terminal, () => new Promise(resolve => {
        data = this.shellOutput(terminal, data);
        if (!data) return resolve();
        screen.write(data, () => {
          this.publish(terminal, { t: 'termData', data });
          resolve();
        });
      }));
    });
    process.onExit(({ exitCode, signal }) => {
      exitedBeforeReady(new Error('Shell 在输入就绪前退出：' + exitCode));
      terminal.exited = true;
      terminal.exitCode = exitCode;
      terminal.signal = signal;
      terminal.query?.reject(new Error('终端已经退出'));
      terminal.query = null;
      if (!terminal.closed) this.schedule(terminal, () => {
        this.publish(terminal, { t: 'termExit', exitCode, signal });
      });
    });
    await shellReady;
    return this.metadata(terminal);
  }

  async subscribe(id, receive) {
    const terminal = this.get(id);
    let subscribed = true;
    await this.schedule(terminal, () => {
      if (terminal.closed) throw new Error('这个 RA 终端已经关闭');
      terminal.listeners.add(receive);
      receive({ t: 'termSnapshot', ...this.metadata(terminal), prompt: terminal.prompt, seq: terminal.seq,
        data: terminal.serializer.serialize() });
    });
    return () => { if (subscribed) terminal.listeners.delete(receive); subscribed = false; };
  }

  write(id, data) {
    const terminal = this.get(id);
    return this.schedule(terminal, () => {
      if (terminal.closed || terminal.exited) throw new Error('终端已经退出，无法继续输入');
      terminal.inputLine = null;
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
    terminal.query?.reject(new Error('终端已经关闭'));
    terminal.query = null;
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
      terminal.query?.reject(new Error('终端已经关闭'));
      terminal.query = null;
      if (!terminal.exited) terminal.process.kill();
      terminal.listeners.clear();
      terminal.screen.dispose();
    }
    this.terminals.clear();
  }
}

export const terminalService = new TerminalService();
