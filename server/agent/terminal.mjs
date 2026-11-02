// 终端：面板轮询与交互
import { PAGE_SRC, helpersCall } from '../page/build.mjs';
import { editorRoots } from '../../lib/files.mjs';

export const methods = {
  async pollTerminal(force = false) {
    const cdp = this.cdp, editorCdp = this.editorCdp, sel = this.sel;
    if (this.termPolling === sel) {
      if (force) this.termRepoll = true;
      return;
    }
    const gap = Date.now() - (this.lastTermChangeAt || 0) < 3000 ? 200 : 650;
    if (!editorCdp || !this.visible || this.mode !== 'terminal' || (!force && Date.now() - (this.lastTermAt || 0) < gap)) return;
    this.lastTermAt = Date.now();
    this.termPolling = sel;
    try {
      const dump = await editorCdp.evaluate(helpersCall(`terminalDump(${JSON.stringify(this.lastTermHash || '')})`));
      if (!this.liveRead(cdp, sel) || editorCdp !== this.editorCdp || this.mode !== 'terminal') return;
      if (!dump) {
        if (this.lastTermHash !== null) {
          this.lastTermHash = null;
          this.lastTermChangeAt = Date.now();
          this.emit({ t: 'termText', sel: this.selectionKey(), lines: null });
        }
      } else if (dump.hash !== this.lastTermHash) {
        this.lastTermHash = dump.hash;
        this.lastTermChangeAt = Date.now();
        if (dump.lines) this.emit({ t: 'termText', sel: this.selectionKey(), id: dump.id, lines: dump.lines, cursor: dump.cursor, name: dump.name });
      }
      if (Date.now() - (this.lastTermStateAt || 0) >= 650) {
        this.lastTermStateAt = Date.now();
        const state = await cdp.evaluate(helpersCall('agentState()'));
        if (!this.liveRead(cdp, sel) || editorCdp !== this.editorCdp || this.mode !== 'terminal') return;
        const busy = !!state?.busy;
        if (busy !== this.lastBusy) {
          this.lastBusy = busy;
          this.emit({ t: 'agentBusy', busy });
        }
      }
    } finally {
      if (this.termPolling === sel) this.termPolling = null;
      if (this.termRepoll) {
        this.termRepoll = false;
        this.pollTerminal(true).catch(() => {});
      }
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
    setTimeout(() => this.pollTerminal(true).catch(() => {}), 300);
  },
  async closeTerminal(id) {
    if (!/^[\w-]{8,}$/.test(id)) throw new Error('这个终端已经不在了');
    const pos = await this.editorCdp.evaluate(helpersCall(`terminalCloseTarget(${JSON.stringify(id)})`));
    if (pos) await this.tapCss(pos.x, pos.y, 'left', this.editorCdp);
    else {
      // Tabs layout: a row's Kill icon only gets a size once the row is active, so
      // select the tab first and re-check the row icon (title bar has none).
      const target = await this.editorCdp.evaluate(helpersCall(`terminalTarget(${JSON.stringify(id)})`));
      if (!target) throw new Error('这个终端已经不在了');
      await this.tapCss(target.x, target.y, 'left', this.editorCdp);
      let current = false;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 100));
        const list = await this.editorCdp.evaluate(helpersCall('terminalList()')).catch(() => null);
        if (list?.find(t => t.id === id)?.current) { current = true; break; }
      }
      if (!current) throw new Error('没能切换到这个终端，未关闭');
      let kill = null;
      for (let i = 0; i < 10 && !kill; i++) {
        if (i) await new Promise(r => setTimeout(r, 100));
        kill = await this.editorCdp.evaluate(helpersCall(`terminalCloseTarget(${JSON.stringify(id)})`)).catch(() => null)
          || await this.editorCdp.evaluate(helpersCall('terminalKillActiveTarget()')).catch(() => null);
      }
      if (!kill) throw new Error('找不到关闭终端的按钮');
      await this.tapCss(kill.x, kill.y, 'left', this.editorCdp);
    }
    this.emit({ t: 'status', ok: true, msg: '已关闭终端' });
    setTimeout(() => this.pollTerminal(true).catch(() => {}), 300);
  },
  async newTerminal() {
    const project = await this.adapter.terminalProject.call(this);
    if (project?.root && !this.projectMatches(await editorRoots(this.editorCdp, this.app), project.root, project.host || '')) {
      if (project.host) throw new Error('请先打开此会话对应的远程项目窗口，再新建终端');
      await this.useProject(project.root, false, this.threadId || '');
    }
    if (this.app === 'devin' && await this.editorCdp.evaluate(helpersCall('devinSurface()')) === 'agent') {
      await this.setSurface('editor');
    }
    const before = await this.editorCdp.evaluate(helpersCall('terminalHistory()'));
    const direct = await this.editorCdp.evaluate(helpersCall('newTerminalDirect()'));
    if (direct) {
      await this.tapCss(direct.x, direct.y, 'left', this.editorCdp);
    } else {
      await this.adapter.newTerminal.call(this);
    }
    const ready = await this.editorCdp.evaluate(`(async () => {
        const h = ${PAGE_SRC};
        const before = ${JSON.stringify(before.id)};
        for (let i = 0; i < 20; i++) {
          const id = h.terminalHistory().id;
          if (id && id !== before && h.focusTerminalInput()) return true;
          await new Promise(r => setTimeout(r, 100));
        }
        return false;
      })()`);
    if (!ready) throw new Error('新建终端尚未就绪');
    this.emit({ t: 'status', ok: true, msg: '已新建终端' });
    setTimeout(() => this.pollTerminal(true).catch(() => {}), 500);
  },
  async focusTerminal() {
    if (!await this.editorCdp.evaluate(helpersCall('focusTerminalInput()'))) throw new Error('没有可输入的终端，请先打开终端');
  },
  async prepareTerminalInput(id, text) {
    await this.focusTerminal();
    const before = await this.editorCdp.evaluate(helpersCall('terminalHistory()'));
    if (!id || before.id !== id) throw new Error('终端已切换，请在当前终端重新输入');
    const input = before.executing ? '' : before.input ?? await this.editorCdp.evaluate(helpersCall('terminalCommand()'));
    const sameDraft = !before.executing && input === text;
    if (input && !sameDraft) {
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
    return { ...before, sameDraft };
  },
  async completeTerminal(text, caret, id, revision, requestId) {
    const cdp = this.cdp, editor = this.editorCdp, sel = this.sel;
    const before = await this.prepareTerminalInput(id, text);
    if (before.executing) throw new Error('当前终端正在执行程序，不能补全命令');
    if (text && !before.sameDraft) await editor.send('Input.insertText', { text });
    const expected = JSON.stringify(String(text).trimEnd());
    const wait = call => this.waitFor.call({ cdp: editor }, call);
    if (!await wait(`${before.input === null ? 'terminalCommand()' : 'terminalHistory().input'}?.trimEnd() === ${expected}`)) throw new Error('终端尚未确认当前输入，请检查终端输出');
    const left = Array.from(String(text).slice(caret)).length;
    if (left) await editor.evaluate(helpersCall(`focusTerminalInput(${left})`));
    const hash = (await editor.evaluate(helpersCall('terminalDump()')))?.hash;
    await this.key('Tab', { cdp: editor });
    await wait(`terminalDump()?.hash !== ${JSON.stringify(hash)}`);
    const input = await editor.evaluate(`(() => { const h = ${PAGE_SRC}, state = h.terminalHistory(); return { id: state.id, text: state.input ?? h.terminalCommand() }; })()`);
    if (this.liveRead(cdp, sel) && editor === this.editorCdp && input.id === id && typeof input.text === 'string')
      this.emit({ t: 'termInput', sel: this.selectionKey(), id, revision, requestId, text: input.text });
    await this.pollTerminal(true);
  },
  async sendTerminal(text, id, secret = false) {
    if (secret) {
      await this.focusTerminal();
      if ((await this.editorCdp.evaluate(helpersCall('terminalHistory()'))).id !== id) throw new Error('终端已切换，请在当前终端重新输入');
    } else await this.prepareTerminalInput(id);
    const lines = secret ? [String(text)] : String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await this.editorCdp.send('Input.insertText', { text: lines[i] });
      if (secret || i < lines.length - 1 || lines[i]) await this.key('Enter', { cdp: this.editorCdp });
    }
    setTimeout(() => this.pollTerminal(true).catch(() => {}), 100);
  }
};
