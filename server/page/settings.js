  const onScreen = e => {
    const b = e.getBoundingClientRect();
    return b.width > 2 && b.height > 2 && b.bottom > 0 && b.right > 0 && b.top < innerHeight && b.left < innerWidth;
  };
  // The gear's label flips to "Close Settings". Devin opens a settings editor tab instead.
  const settingsOpen = () => {
    if ([...doc.querySelectorAll('button, a, [role=button]')].some(e => onScreen(e) && e.getAttribute('aria-label') === 'Close Settings')) return true;
    if ([...doc.querySelectorAll('input')].some(e => onScreen(e) && /search settings/i.test(e.getAttribute('aria-label') || ''))) return true;
    return [...doc.querySelectorAll('.tab.active')].some(tab => onScreen(tab) && /settings/i.test(tab.getAttribute('aria-label') || tab.innerText || ''));
  };
  const clickSettingsButton = () => {
    const b = [...doc.querySelectorAll('button, a, [role=button]')].find(e => onScreen(e) && /^(Settings|Open Cursor Settings|Devin Settings)$/.test(e.getAttribute('aria-label') || ''));
    if (!b) return false;
    b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    b.click();
    return true;
  };
  const clickCloseSettings = () => {
    const b = [...doc.querySelectorAll('button, a, [role=button]')].find(e => onScreen(e) && e.getAttribute('aria-label') === 'Close Settings');
    if (b) { b.click(); return 'button'; }
    const tab = [...doc.querySelectorAll('.tab.active')].find(e => onScreen(e) && /settings/i.test(e.getAttribute('aria-label') || ''));
    const close = tab?.querySelector('[aria-label^="Close"]');
    if (close) { close.click(); return 'button'; }
    if (tab) return 'tab';
    return '';
  };
  // Cursor 3.22's compact settings rail exposes labels via textContent; innerText comes back empty.
  const fullText = e => (e.innerText || e.textContent || '');
  const cellText = e => (e.innerText || '').trim() || (e.textContent || '').replace(/\s+/g, ' ').trim();
  const settingsPanel = () => {
    const close = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Close Settings');
    if (close && vis(close)) {
      let p = close;
      for (let i = 0; i < 16 && p; i++) {
        const box = p.getBoundingClientRect();
        if (fullText(p).includes('Plan & Usage') && box.width > 300 && box.height > 200) return p;
        p = p.parentElement;
      }
    }
    const nav = [...doc.querySelectorAll('button, [role=button], .cursor-settings-sidebar-nav-cell')].find(e => vis(e) && cellText(e) === 'Plan & Usage');
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
    const control = [...doc.querySelectorAll('[data-remote-setting]')].find(e => e.dataset.remoteSetting === label);
    if (control) { control.scrollIntoView({block:'center'}); return center(control); }
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
  const desktopSettingsData = (section = '', app = '') => {
    const cursor = app === 'devin' ? null : settingsPanel();
    const root = cursor || [...doc.querySelectorAll('.editor-instance')].find(e => vis(e) && [...e.querySelectorAll('button')].some(b => b.textContent.trim() === 'Plan information'));
    if (!root) return { sections: [], nav: [], current: '', choices: [] };
    const mark = el => { el.dataset.remoteSetting ||= crypto.randomUUID(); return el.dataset.remoteSetting; };
    const nav = cursor ? [...root.querySelectorAll('.cursor-settings-sidebar-nav-cell')].map(e => e.textContent.trim()).filter(name => name !== 'VS Code Settings') : devinSettingsNav();
    const heading = root.querySelector('h1');
    const current = cursor ? heading?.textContent.trim() || section || nav[0] : section || nav[0];
    const groups = cursor ? [...root.querySelectorAll('.ui-section')] : [...root.querySelectorAll('section')].filter(e => e.querySelector('h2')?.textContent.trim() === current);
    const selector = '[role=switch], [role=combobox], button, [role=button], input:not([type=hidden]):not([type=password]), textarea, select';
    const sections = groups.map(group => {
      const items = [];
      const controls = [...group.querySelectorAll(selector)].filter(vis).filter(e => !e.closest('[aria-hidden=true]') && (!cursor || e.closest('.ui-section') === group) && (!e.closest('[role=combobox]') || e.getAttribute('role') === 'combobox'));
      for (const el of controls) {
        if (el.type === 'checkbox' && el.parentElement.querySelector('[role=switch]')) continue;
        let row = el.closest('.ui-field-group__entry');
        if (!row) {
          row = el.parentElement;
          while (row.parentElement && row !== group && !row.innerText.trim()) row = row.parentElement;
          if (row !== group && row.innerText.trim() === el.innerText?.trim()) row = row.parentElement;
        }
        const lines = (row.innerText || '').split('\n').map(t => t.trim()).filter(Boolean);
        const label = (el.getAttribute('aria-label') || lines[0] || el.textContent.trim() || el.placeholder || '').slice(0,140);
        if (!label) continue;
        const id = mark(el), disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
        const sw = el.getAttribute('role') === 'switch' || el.type === 'checkbox';
        const field = !sw && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
        items.push({ id, label, detail: lines.filter(t => t !== label).slice(0,2).join(' · ').slice(0,180), disabled,
          ...(sw ? { on: el.checked ?? el.getAttribute('aria-checked') === 'true' } : field ? { type: el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : el.type || 'text', value: el.value, options: el.options ? [...el.options].map(o => ({label:o.text,value:o.value})) : [] } : { action: true, value: el.textContent.trim() }) });
      }
      const summary = group.cloneNode(true); summary.querySelectorAll(selector).forEach(e => e.remove());
      return { title: group.querySelector('h2,h3')?.textContent.trim() || current, items, summary: items.length ? '' : summary.textContent.trim().slice(0,2000) };
    });
    const choices = [...doc.querySelectorAll('[role=option],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox]')].filter(el => onScreen(el) && !el.closest('[role=menubar]')).map(el => ({ id:mark(el),label:(el.textContent||el.getAttribute('aria-label')||'').trim(),on:el.getAttribute('aria-selected')==='true'||el.getAttribute('aria-checked')==='true' })).filter(c=>c.label);
    return { sections, nav, current, choices };
  };
  const desktopSettingsNav = (section, app = '') => {
    const root = app === 'devin' ? [...doc.querySelectorAll('.editor-instance')].find(e => vis(e) && [...e.querySelectorAll('button')].some(b => b.textContent.trim() === 'Plan information')) : settingsPanel();
    const button = root && [...root.querySelectorAll(app === 'devin' ? 'button' : '.cursor-settings-sidebar-nav-cell')].find(e => e.textContent.trim() === section);
    if (!button) return false;
    button.scrollIntoView({block:'nearest'}); button.click(); return true;
  };
  const desktopSettingValue = (id, value) => {
    const el = [...doc.querySelectorAll('[data-remote-setting]')].find(e => e.dataset.remoteSetting === id);
    if (!el || el.disabled) throw new Error('设置项已变化，请重新读取');
    const proto = el.tagName === 'SELECT' ? doc.defaultView.HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? doc.defaultView.HTMLTextAreaElement.prototype : doc.defaultView.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(el,value);
    el.dispatchEvent(new doc.defaultView.Event('input',{bubbles:true})); el.dispatchEvent(new doc.defaultView.Event('change',{bubbles:true}));
  };
  const codexSettingsData = () => {
    const mark = el => { el.dataset.remoteSetting ||= crypto.randomUUID(); return el.dataset.remoteSetting; };
    const nav = [...doc.querySelectorAll('[data-appearance] button.sidebar-item')].filter(vis).map(el => ({ id: mark(el), label: el.getAttribute('aria-label') || el.textContent.trim(), current: el.getAttribute('aria-current') === 'page' }));
    const control = el => ({ id: mark(el), label: el.getAttribute('aria-label') || (el.innerText || el.textContent).trim(), role: el.getAttribute('role') || '', on: el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true', disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' });
    const root = [...doc.querySelectorAll('[role=dialog]')].find(vis) || doc.querySelector('h1')?.closest('[class~="group/settings"]');
    const rows = [...(root?.querySelectorAll('[class*="/settings-row"]') || [])].filter(vis).map(row => ({
      label: row.querySelector('[class*="font-medium"]')?.textContent.trim() || row.innerText.split('\n')[0],
      detail: (row.firstElementChild?.innerText || '').split('\n').slice(1).join('\n').trim(),
      controls: [...row.querySelectorAll('button')].filter(vis).map(control),
    }));
    const choices = [...doc.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"]')].filter(vis).map(control);
    const field = [...doc.querySelectorAll('textarea[aria-label="Codex instructions"]')].find(vis);
    const instructions = field ? { value: field.value, disabled: field.disabled } : null;
    const fields = [...(root?.querySelectorAll('input:not([type=password]):not([type=checkbox]):not([type=radio]), select, textarea') || [])].filter(el => vis(el) && el !== field).map(el => ({ id: mark(el), label: el.getAttribute('aria-label') || el.placeholder || el.name || '输入', value: el.value, type: el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : el.type, disabled: el.disabled, options: el.tagName === 'SELECT' ? [...el.options].map(o => ({ value: o.value, label: o.text })) : null }));
    const extra = [...(root?.querySelectorAll('button, a[href], input[type=checkbox], input[type=radio]') || [])].filter(el => vis(el) && !el.closest('[class*="/settings-row"]') && !(field && el.textContent.trim() === 'Save')).map(el => ({ ...control(el), role: el.type === 'checkbox' ? 'switch' : el.getAttribute('role') || '', on: el.checked || el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true' || el.getAttribute('data-state') === 'checked' })).filter(c => c.label);
    const copy = root?.cloneNode(true);
    copy?.querySelectorAll('[class*="/settings-row"], button, input, textarea, select, a[href]').forEach(el => el.remove());
    const summary = (copy?.textContent || '').replace(/\s+/g, ' ').trim();
    const title = root?.querySelector('h1, h2')?.textContent.trim() || '';
    return { nav, rows, choices, instructions, fields, extra, summary, title, dialog: !!root?.matches('[role=dialog]') };
  };
  const codexSettingValue = (id, value) => {
    const field = [...doc.querySelectorAll('[data-remote-setting]')].find(el => el.dataset.remoteSetting === id);
    if (!field || field.disabled || !field.matches('input:not([type=password]):not([type=checkbox]):not([type=radio]), textarea, select')) throw new Error('设置输入框已改变，请重新读取');
    const win = field.ownerDocument.defaultView;
    const proto = field.tagName === 'SELECT' ? win.HTMLSelectElement.prototype : field.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, value);
    field.dispatchEvent(new win.Event('input', { bubbles: true }));
    field.dispatchEvent(new win.Event('change', { bubbles: true }));
  };
  const waitSettings = (kind, before = '', timeout = 1200) => new Promise(resolve => {
    const started = Date.now();
    const read = () => {
      const data = kind === 'open' ? settingsOpen() : kind === 'cursor' ? readSettings() : kind === 'devin' ? devinSettingsCards() : codexSettingsData();
      const current = kind === 'codex' ? data.nav.find(n => n.current) : null;
      const ready = kind === 'open' ? data : kind === 'codex' ? data.nav.length && data.title && (data.dialog || !current || data.title === current.label) : data?.length;
      if ((ready && (!before || JSON.stringify(data) !== before)) || Date.now() - started >= timeout) return resolve(data);
      setTimeout(read, 30);
    };
    read();
  });
  const codexSaveInstructions = async text => {
    const field = [...doc.querySelectorAll('textarea[aria-label="Codex instructions"]')].find(vis);
    if (!field || field.disabled) throw new Error('Codex instructions 当前不可编辑');
    const saveButton = () => [...doc.querySelectorAll('button')].find(e => vis(e) && e.textContent.trim() === 'Save');
    if (field.value === text && saveButton()?.disabled) return codexSettingsData();
    const setValue = Object.getOwnPropertyDescriptor(field.ownerDocument.defaultView.HTMLTextAreaElement.prototype, 'value').set;
    setValue.call(field, text);
    field.dispatchEvent(new field.ownerDocument.defaultView.Event('input', { bubbles: true }));
    const started = Date.now();
    while (!saveButton() || saveButton().disabled) {
      if (Date.now() - started > 1200) throw new Error('指令未进入待保存状态');
      await new Promise(r => setTimeout(r, 30));
    }
    saveButton().click();
    do {
      await new Promise(r => setTimeout(r, 30));
      if (Date.now() - started > 6000) throw new Error('指令保存尚未确认，请重新读取设置核对');
    } while (field.disabled || !saveButton()?.disabled);
    if (field.value !== text) throw new Error('保存后的指令与输入不一致');
    return codexSettingsData();
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
    const root = [...doc.querySelectorAll('.editor-instance')].find(e => onScreen(e) && [...e.querySelectorAll('button')].some(b => b.textContent.trim() === 'Plan information'));
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
    const e = [...root.querySelectorAll('button, [role=button], .cursor-settings-sidebar-nav-cell')].find(el => vis(el) && cellText(el) === 'Plan & Usage');
    return e ? center(e) : null;
  };
  const readUsage = () => {
    const root = settingsPanel();
    if (!root) return null;
    const nav = new Set(['Back', 'General', 'Profile', 'Appearance', 'Plan & Usage', 'Agents', 'Cloud Agents', 'Models', 'Git & PRs', 'Worktrees', 'Browser & Network', 'Tab', 'Code Intelligence', 'Beta', 'Docs', 'Getting Started']);
    const candidates = [...root.querySelectorAll('div, section')].filter(e => fullText(e).includes('CURRENT PLAN'));
    candidates.sort((a, b) => fullText(a).length - fullText(b).length);
    const best = candidates.find(e => /Included in|On-Demand|Cursor Models/.test(fullText(e)) && !fullText(e).split('\n').some(l => l.trim() === 'Agents'))
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
        const around = fullText(node).replace(/\s+/g, ' ');
        if (around.length < 500) {
          if (new RegExp(pct + '%\\s+(?:left|remaining)', 'i').test(around)) { basis = 'remaining'; break; }
          if (new RegExp(pct + '%\\s+used', 'i').test(around)) { basis = 'used'; break; }
        }
        node = node.parentElement;
      }
      return { label: label.slice(0, 40), kind: 'limit', basis, pct };
    }).filter(Boolean);
    const lines = fullText(best || root).split('\n').map(s => s.trim()).filter(s => s && !nav.has(s)).slice(0, 32);
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
