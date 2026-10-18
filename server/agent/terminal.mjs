// 终端：面板轮询与交互
import { helpersCall } from '../page/build.mjs';

export const methods = {
  async pollTerminal() {
    const cdp = this.cdp, editorCdp = this.editorCdp, sel = this.sel;
    if (!editorCdp || !this.visible || this.mode !== 'terminal' || this.termPolling === sel || Date.now() - (this.lastTermAt || 0) < (this.lastBusy ? 650 : 1800)) return;
    this.lastTermAt = Date.now();
    this.termPolling = sel;
    try {
      const dump = await editorCdp.evaluate(helpersCall(`terminalDump(${JSON.stringify(this.lastTermHash || '')})`));
      if (!this.liveRead(cdp, sel) || editorCdp !== this.editorCdp || this.mode !== 'terminal') return;
      if (!dump) {
        if (this.lastTermHash !== null) {
          this.lastTermHash = null;
          this.emit({ t: 'termText', sel: this.selectionKey(), lines: null });
        }
      } else if (dump.hash !== this.lastTermHash) {
        this.lastTermHash = dump.hash;
        if (dump.lines) this.emit({ t: 'termText', sel: this.selectionKey(), lines: dump.lines, cursor: dump.cursor, name: dump.name });
      }
      const state = await cdp.evaluate(helpersCall('agentState()'));
      if (!this.liveRead(cdp, sel) || editorCdp !== this.editorCdp || this.mode !== 'terminal') return;
      const busy = !!state?.busy;
      if (busy !== this.lastBusy) {
        this.lastBusy = busy;
        this.emit({ t: 'agentBusy', busy });
      }
    } finally {
      if (this.termPolling === sel) this.termPolling = null;
    }
  },
  async listTerminals() {
    const list = await this.editorCdp.evaluate(helpersCall('terminalList()'));
    this.emit({ t: 'terminals', list: list || [] });
  },
  async openTerminal(id) {
    if (!/^[\w-]{8,}$/.test(id)) throw new Error('这个终端已经不在了');
    const pos = await this.editorCdp.evaluate(helpersCall(`terminalTarget(${JSON.stringify(id)})`));
    if (!pos) throw new Error('这个终端已经不在了');
    await this.tapCss(pos.x, pos.y, 'left', this.editorCdp);
    this.emit({ t: 'status', ok: true, msg: '已切换终端' });
    setTimeout(() => this.pollTerminal().catch(() => {}), 300);
  },
  async closeTerminal(id) {
    if (!/^[\w-]{8,}$/.test(id)) throw new Error('这个终端已经不在了');
    const pos = await this.editorCdp.evaluate(helpersCall(`terminalCloseTarget(${JSON.stringify(id)})`));
    if (!pos) throw new Error('这个终端已经不在了');
    await this.tapCss(pos.x, pos.y, 'left', this.editorCdp);
    this.emit({ t: 'status', ok: true, msg: '已关闭终端' });
    setTimeout(() => this.pollTerminal().catch(() => {}), 300);
  },
  async newTerminal() {
    const direct = await this.editorCdp.evaluate(helpersCall('newTerminalDirect()'));
    if (direct) {
      await this.tapCss(direct.x, direct.y, 'left', this.editorCdp);
    } else {
      await this.adapter.newTerminal.call(this);
    }
    this.emit({ t: 'status', ok: true, msg: '已新建终端' });
    setTimeout(() => this.pollTerminal().catch(() => {}), 500);
  },
  async focusTerminal() {
    if (!await this.editorCdp.evaluate(helpersCall('focusTerminalInput()'))) throw new Error('没有可输入的终端，请先打开终端');
  },
  async sendTerminal(text) {
    await this.focusTerminal();
    const before = await this.editorCdp.evaluate(helpersCall('terminalHistory()'));
    const input = before.executing ? '' : before.input ?? await this.editorCdp.evaluate(helpersCall('terminalCommand()'));
    if (input) {
      await this.editorCdp.evaluate(helpersCall('clearTerminalInput()'));
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 20));
        const remaining = before.input === null
          ? await this.editorCdp.evaluate(helpersCall('terminalCommand()'))
          : (await this.editorCdp.evaluate(helpersCall('terminalHistory()'))).input;
        if (remaining === '') break;
        if (i === 9) throw new Error('终端原有输入未清空，尚未发送');
      }
    }
    const lines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await this.editorCdp.send('Input.insertText', { text: lines[i] });
      if (i < lines.length - 1 || lines[i]) await this.key('Enter', { cdp: this.editorCdp });
    }
  }
};
