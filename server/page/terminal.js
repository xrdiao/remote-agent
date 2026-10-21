  const terminalEntries = () => {
    const glass = [...doc.querySelectorAll('.ui-tab-system-tab')].filter(t => vis(t) && /terminal-/i.test(t.getAttribute('aria-controls') || ''));
    if (glass.length) {
      return glass.map(tab => {
        const id = (/terminal-([0-9a-f-]{8,})/i.exec(tab.getAttribute('aria-controls') || '') || [])[1] || '';
        const title = (tab.innerText || '').trim().split('\n')[0].replace(/\s+/g, ' ').slice(0, 80);
        return {
          id,
          title: title || '终端',
          current: tab.getAttribute('aria-selected') === 'true' || tab.getAttribute('data-active') === 'true',
          tab,
          close: [...tab.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '').startsWith('Close')),
        };
      }).filter(t => t.id);
    }
    const single = doc.querySelector('.part.panel .single-terminal-tab');
    if (single && vis(single)) return [{
      id: 'classic-0', title: single.innerText.trim() || '终端', current: true, tab: single,
      close: doc.querySelector('.part.panel .title-actions [aria-label="Kill Terminal"]'),
    }];
    const classic = [...doc.querySelectorAll('.terminal-tabs-list .terminal-tab, .monaco-list-row:has(.terminal-tabs-entry)')].filter(vis).map((tab, i) => ({
      id: tab.id || `classic-${i}`,
      title: (tab.querySelector('.label-name, a') || tab).innerText.trim().split('\n')[0].slice(0, 80) || `终端 ${i + 1}`,
      current: tab.classList.contains('active') || !!tab.querySelector('.terminal-tabs-entry.is-active') || tab.getAttribute('aria-selected') === 'true',
      tab,
      close: tab.querySelector('[aria-label="Kill Terminal"], [aria-label^="Kill"]'),
    }));
    if (classic.length) return classic;
    // Devin / VS Code monaco list: rows labelled "Terminal 1 cloudflared".
    // Kill/Split action anchors exist in the row but get a size only on hover.
    const vt = [...document.querySelectorAll('[aria-label="Terminal tabs"] .monaco-list-row')].filter(vis);
    if (vt.length) return vt.map(tab => {
      const m = /^Terminal (\d+)\s*(.*)$/.exec((tab.getAttribute('aria-label') || '').trim());
      return {
        id: `term-vt${m?.[1] || vt.indexOf(tab)}`,
        title: ((m?.[2] || '').trim() || `终端 ${m?.[1] || ''}`.trim()).slice(0, 80),
        current: tab.getAttribute('aria-selected') === 'true',
        tab,
        close: tab.querySelector('a.action-label[aria-label^="Kill"], [aria-label^="Kill"]'),
      };
    });
    const solo = [...document.querySelectorAll('.terminal-wrapper.active .xterm')].filter(vis);
    if (solo.length === 1) return [{ id: 'term-solo', title: '终端', current: true, tab: solo[0], close: null }];
    return [];
  };
  const terminalList = () => terminalEntries().map(({ id, title, current }) => ({ id, title, current }));
  const terminalById = id => terminalEntries().find(t => t.id === id);
  const terminalPoint = el => {
    const r = el.getBoundingClientRect();
    return { x: r.x + Math.min(28, r.width / 3), y: r.y + r.height / 2 };
  };
  const terminalTarget = id => {
    const t = terminalById(id);
    if (!t) return null;
    t.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return terminalPoint(t.tab);
  };
  const terminalCloseTarget = id => {
    const b = terminalById(id)?.close;
    return b && vis(b) ? center(b) : null;
  };
  // With ≥2 tabs the row Kill icons are 0×0 until hover; the panel title-bar Kill
  // button (which kills the *active* terminal) is always visible instead.
  const terminalKillActiveTarget = () => {
    const b = [...doc.querySelectorAll('.part.panel .title-actions [aria-label="Kill Terminal"]')].find(vis);
    return b ? center(b) : null;
  };
  const terminalFocus = () => {
    const el = [...doc.querySelectorAll('.terminal-wrapper.active .xterm, .terminal.xterm')].find(vis);
    return el ? center(el) : null;
  };
  const newTerminalDirect = () => {
    const b = [...doc.querySelectorAll('[aria-label="New Terminal"], [aria-label^="New Terminal"]')].find(vis);
    return b ? center(b) : null;
  };
  const newTerminalMenu = () => {
    const buttons = [...doc.querySelectorAll('button')].filter(e => vis(e) && e.getAttribute('aria-label') === 'Open new tab menu');
    if (!buttons.length) return null;
    const active = terminalEntries().find(t => t.current)?.tab;
    if (active) {
      const x = active.getBoundingClientRect().x;
      buttons.sort((a, b) => Math.abs(a.getBoundingClientRect().x - x) - Math.abs(b.getBoundingClientRect().x - x));
    }
    return center(buttons[0]);
  };
