  const packColor = (cell, fg) => {
    if (fg ? cell.isFgDefault() : cell.isBgDefault()) return 0;
    if (fg ? cell.isFgRGB() : cell.isBgRGB()) return -((((fg ? cell.getFgColor() : cell.getBgColor()) >>> 0) & 0xffffff) + 1);
    let n = fg ? cell.getFgColor() : cell.getBgColor();
    if (n < 0) return 0;
    if (fg && cell.isBold() && n < 8) n += 8;
    return (n & 255) + 1;
  };
  const cellFlags = cell => (cell.isBold() ? 1 : 0) | (cell.isItalic() ? 2 : 0) | (cell.isUnderline() ? 4 : 0) | (cell.isDim() ? 8 : 0) | (cell.isInverse() ? 16 : 0);
  // The shell prompt stays on the cursor line; history recall only replaces the command after it.
  const commandFromPrompt = line => {
    const m = /^(?:.*?(?:[$%#]|[❯➜]))\s(.*)$/.exec(line);
    if (m) return m[1].replace(/\s+$/, '');
    const fish = /^>\s(.*)$/.exec(line);
    if (fish) return fish[1].replace(/\s+$/, '');
    return null;
  };
  const activeTerminal = () => document.querySelector('.terminal-wrapper.active .xterm-wrapper')?.xterm || document.querySelector('.terminal-wrapper.active')?.xterm || document.querySelector('.xterm-wrapper')?.xterm;
  const terminalHistory = () => {
    const term = activeTerminal();
    const addon = (term?._addonManager?._addons || []).map(a => a.instance || a).find(a => a.capabilities);
    const detection = addon?.capabilities.get(2);
    const el = term?.element;
    if (el) el.dataset.remoteTerminal ||= crypto.randomUUID();
    return { id: el?.dataset.remoteTerminal || '', commands: (detection?.commands || []).map(c => c.command).filter(c => typeof c === 'string' && c.trim()), input: detection?.promptInputModel?.value ?? null, executing: !!detection?.currentCommand?.commandExecutedMarker };
  };
  const focusTerminalInput = () => {
    const term = activeTerminal();
    if (!term) return false;
    term.focus(); return document.activeElement === term.textarea;
  };
  const clearTerminalInput = () => { activeTerminal().input('\x01\x0b', true); };
  const terminalCommand = () => {
    const term = activeTerminal();
    const buf = term?.buffer?.active;
    if (!buf) return null;
    const logical = start => {
      let text = '';
      for (let i = start; i < buf.length; i++) {
        const row = buf.getLine(i);
        if (!row) break;
        if (i > start && !row.isWrapped) break;
        text += row.translateToString(true);
        if (!buf.getLine(i + 1)?.isWrapped) break;
      }
      return text.replace(/\s+$/, '');
    };
    let y = buf.baseY + buf.cursorY;
    while (y > 0 && buf.getLine(y)?.isWrapped) y--;
    const here = commandFromPrompt(logical(y));
    if (here != null) return here;
    if (y > 0) {
      let py = y - 1;
      while (py > 0 && buf.getLine(py)?.isWrapped) py--;
      if (commandFromPrompt(logical(py)) === '') return logical(y);
    }
    return null;
  };
  const terminalDump = prev => {
    const term = activeTerminal();
    const buf = term?.buffer?.active;
    if (!buf) return null;
    const cursorY = buf.baseY + buf.cursorY;
    const lines = [];
    let cursorX = buf.cursorX;
    for (let y = 0; y < buf.length; y++) {
      const row = buf.getLine(y);
      if (!row) { lines.push(''); continue; }
      let text = '';
      const spans = [];
      let run = null;
      let col = 0;
      for (let x = 0; x < term.cols; x++) {
        const cell = row.getCell(x);
        if (!cell || cell.getWidth() === 0) continue;
        const ch = cell.getChars() || ' ';
        const f = packColor(cell, true);
        const b = packColor(cell, false);
        const fl = cellFlags(cell);
        if (!run || run.f !== f || run.b !== b || run.fl !== fl) {
          run = { i: text.length, f, b, fl };
          spans.push([run.i, f, b, fl]);
        }
        if (y === cursorY && col === buf.cursorX) cursorX = text.length;
        text += ch;
        col += cell.getWidth();
      }
      text = text.replace(/\s+$/, '');
      if (y === cursorY && cursorX > text.length) cursorX = text.length;
      const styled = spans.some(([, f, b, fl]) => f || b || fl);
      lines.push(styled ? { t: text, s: spans.filter(s => s[0] <= text.length) } : text);
    }
    let end = lines.length;
    while (end > cursorY + 1 && end > 0 && lines[end - 1] === '') end--;
    const body = { lines: lines.slice(0, end), cursor: [cursorY, cursorX], name: terminalList().find(t => t.current)?.title || '' };
    const raw = JSON.stringify(body);
    let h = 2166136261;
    for (let i = 0; i < raw.length; i++) h = Math.imul(h ^ raw.charCodeAt(i), 16777619);
    const hash = (h >>> 0).toString(36);
    return prev === hash ? { hash } : { hash, ...body };
  };

  const quickOpenRows = () => {
    const w = doc.querySelector('.quick-input-widget');
    if (!w || !vis(w)) return null;
    return [...w.querySelectorAll('.monaco-list-row')].filter(vis).map(e => ({
      name: e.querySelector('.label-name')?.innerText.trim() || '',
      dir: e.querySelector('.label-description')?.innerText.trim() || '',
    }));
  };
