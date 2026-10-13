  const onScreen = e => {
    const b = e.getBoundingClientRect();
    return b.width > 2 && b.height > 2 && b.bottom > 0 && b.right > 0 && b.top < innerHeight && b.left < innerWidth;
  };
  // The gear's label flips to "Close Settings". Devin opens a settings editor tab instead.
  const settingsOpen = () => {
    if ([...doc.querySelectorAll('button, [role=button]')].some(e => onScreen(e) && e.getAttribute('aria-label') === 'Close Settings')) return true;
    if ([...doc.querySelectorAll('input')].some(e => onScreen(e) && /search settings/i.test(e.getAttribute('aria-label') || ''))) return true;
    const tab = [...doc.querySelectorAll('.tab.active')].find(onScreen);
    return /settings/i.test(tab?.getAttribute('aria-label') || tab?.innerText || '');
  };
  const clickSettingsButton = () => {
    const b = [...doc.querySelectorAll('button, [role=button]')].find(e => onScreen(e) && /^(Settings|Open Cursor Settings)$/.test(e.getAttribute('aria-label') || ''));
    if (!b) return false;
    b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    b.click();
    return true;
  };
  const clickCloseSettings = () => {
    const b = [...doc.querySelectorAll('button, [role=button]')].find(e => onScreen(e) && e.getAttribute('aria-label') === 'Close Settings');
    if (b) { b.click(); return 'button'; }
    const tab = [...doc.querySelectorAll('.tab.active')].find(onScreen);
    if (/settings/i.test(tab?.getAttribute('aria-label') || '')) return 'tab';
    return '';
  };
  const settingsPanel = () => {
    const close = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Close Settings');
    if (close && vis(close)) {
      let p = close;
      for (let i = 0; i < 16 && p; i++) {
        const box = p.getBoundingClientRect();
        if ((p.innerText || '').includes('Plan & Usage') && box.width > 300 && box.height > 200) return p;
        p = p.parentElement;
      }
    }
    const nav = [...doc.querySelectorAll('button, [role=button], .cursor-settings-sidebar-nav-cell')].find(e => vis(e) && (e.innerText || '').trim() === 'Plan & Usage');
    let p = nav;
    for (let i = 0; i < 16 && p; i++) {
      const box = p.getBoundingClientRect();
      if (p.querySelector('h1, h2, .ui-section') && box.width > 300 && box.height > 200) return p;
      p = p.parentElement;
    }
    return null;
  };
  const readSettings = () => {
    const root = settingsPanel();
    if (!root) return null;
    const sections = [];
    for (const sec of root.querySelectorAll('.ui-section')) {
      const title = (sec.querySelector('h1, h2, h3')?.innerText || '').trim();
      const items = [];
      for (const entry of sec.querySelectorAll('.ui-field-group__entry')) {
        const sw = entry.querySelector('[role=switch]');
        if (!sw) continue;
        const lines = (entry.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
        if (!lines[0]) continue;
        items.push({ label: lines[0].slice(0, 80), detail: (lines[1] || '').slice(0, 140), on: sw.getAttribute('aria-checked') === 'true' });
      }
      if (title && items.length) sections.push({ title, items });
    }
    return sections;
  };
  const settingTarget = label => {
    const root = settingsPanel();
    if (!root) return null;
    for (const entry of root.querySelectorAll('.ui-field-group__entry')) {
      const first = (entry.innerText || '').split('\n').map(s => s.trim()).filter(Boolean)[0];
      if (first !== label) continue;
      const sw = entry.querySelector('[role=switch]');
      return sw && vis(sw) ? center(sw) : null;
    }
    return null;
  };
  const codexSettingsData = () => {
    const mark = el => { el.dataset.remoteSetting ||= crypto.randomUUID(); return el.dataset.remoteSetting; };
    const nav = [...doc.querySelectorAll('[data-appearance] button.sidebar-item')].filter(vis).map(el => ({ id: mark(el), label: el.getAttribute('aria-label') || el.textContent.trim(), current: el.getAttribute('aria-current') === 'page' }));
    const control = el => ({ id: mark(el), label: el.getAttribute('aria-label') || (el.innerText || el.textContent).trim(), role: el.getAttribute('role') || '', on: el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true', disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' });
    const rows = [...doc.querySelectorAll('[class*="/settings-row"]')].filter(vis).map(row => ({
      label: row.querySelector('[class*="font-medium"]')?.textContent.trim() || row.innerText.split('\n')[0],
      detail: (row.firstElementChild?.innerText || '').split('\n').slice(1).join('\n').trim(),
      controls: [...row.querySelectorAll('button')].filter(vis).map(control),
    }));
    const choices = [...doc.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"]')].filter(vis).map(control);
    return { nav, rows, choices };
  };
  const codexSettingPoint = id => {
    const el = [...doc.querySelectorAll('[data-remote-setting]')].find(e => e.dataset.remoteSetting === id);
    if (!el || !vis(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') return null;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return codexPoint(el);
  };

  const DEVIN_SETTINGS_NAV = /^(General|Plan information|Extensions|Agents|Configuration|Customizations|User interface|Devin Tab|Shortcuts|Advanced)$/;
  const devinSettingsNav = () => [...doc.querySelectorAll('button')].filter(e => onScreen(e) && DEVIN_SETTINGS_NAV.test((e.innerText || '').trim())).map(e => (e.innerText || '').trim());
  const devinSettingsClick = name => {
    const b = [...doc.querySelectorAll('button')].find(e => onScreen(e) && (e.innerText || '').trim() === name);
    if (!b) return false;
    b.click();
    return true;
  };
  const devinSettingsCards = () => {
    const root = [...doc.querySelectorAll('.editor-instance')].find(onScreen);
    if (!root) return [];
    const seen = new Set();
    const items = [];
    for (const e of root.querySelectorAll('div')) {
      const cls = (e.className || '').toString();
      if (!cls.includes('rounded-[10px]') || !onScreen(e)) continue;
      if ([...e.querySelectorAll('div')].some(c => (c.className || '').toString().includes('rounded-[10px]') && onScreen(c))) continue;
      const lines = (e.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
      const label = (lines[0] || '').slice(0, 80);
      if (label.length < 3 || seen.has(label)) continue;
      seen.add(label);
      items.push({ label, detail: lines.slice(1, 3).join(' · ').slice(0, 140), toggle: false });
    }
    return items;
  };
  const usageNavTarget = () => {
    const root = settingsPanel();
    if (!root) return null;
    const e = [...root.querySelectorAll('button, [role=button], .cursor-settings-sidebar-nav-cell')].find(el => vis(el) && (el.innerText || '').trim() === 'Plan & Usage');
    return e ? center(e) : null;
  };
  const readUsage = () => {
    const root = settingsPanel();
    if (!root) return null;
    const nav = new Set(['Back', 'General', 'Profile', 'Appearance', 'Plan & Usage', 'Agents', 'Cloud Agents', 'Models', 'Git & PRs', 'Worktrees', 'Browser & Network', 'Tab', 'Code Intelligence', 'Beta', 'Docs', 'Getting Started']);
    const candidates = [...root.querySelectorAll('div, section')].filter(e => (e.innerText || '').includes('CURRENT PLAN'));
    candidates.sort((a, b) => a.innerText.length - b.innerText.length);
    const best = candidates.find(e => /Included in|On-Demand|Cursor Models/.test(e.innerText) && !(e.innerText || '').split('\n').some(l => l.trim() === 'Agents'))
      || candidates[0];
    const rawBars = [...root.querySelectorAll('[role=progressbar]')].filter(vis);
    const loading = rawBars.some(e => /^loading\b/i.test((e.getAttribute('aria-label') || '').trim()));
    const limits = rawBars.map(e => {
      if (!e.hasAttribute('aria-valuenow')) return null;
      const now = Number(e.getAttribute('aria-valuenow'));
      const max = Number(e.getAttribute('aria-valuemax')) || 100;
      const label = (e.getAttribute('aria-label') || '').trim();
      if (!label || /^loading\b/i.test(label) || !Number.isFinite(now) || !max) return null;
      const pct = Math.max(0, Math.min(100, Math.round(now / max * 100)));
      let node = e;
      let basis = 'used';
      for (let i = 0; i < 8 && node; i++) {
        const around = (node.innerText || '').replace(/\s+/g, ' ');
        if (around.length < 500) {
          if (new RegExp(pct + '%\\s+(?:left|remaining)', 'i').test(around)) { basis = 'remaining'; break; }
          if (new RegExp(pct + '%\\s+used', 'i').test(around)) { basis = 'used'; break; }
        }
        node = node.parentElement;
      }
      return { label: label.slice(0, 40), kind: 'limit', basis, pct };
    }).filter(Boolean);
    const lines = ((best || root).innerText || '').split('\n').map(s => s.trim()).filter(s => s && !nav.has(s)).slice(0, 32);
    const reset = lines.find(l => /reset/i.test(l)) || '';
    const planIdx = lines.findIndex(l => l === 'CURRENT PLAN');
    const plan = planIdx >= 0 && lines[planIdx + 1] ? lines[planIdx + 1] : '';
    return { lines: lines.map(l => l.slice(0, 180)), quota: [], plan, limits: limits.map(b => ({ ...b, reset })), loading, missing: !limits.length && !loading };
  };

  const newTerminalItem = () => {
    const rows = [...doc.querySelectorAll('[role=listbox] [role=option], [role=listbox] button, [role=menu] [role=menuitem]')];
    const hit = rows.find(e => vis(e) && /^Terminal\b/.test((e.innerText || e.getAttribute('aria-label') || '').trim()));
    return hit ? center(hit) : null;
  };

  // Full xterm buffer, including scrollback still held by the terminal (not the canvas pixels).
  // Colors are packed as 0 = default, 1–256 = palette index + 1, negative = -(rgb + 1).
