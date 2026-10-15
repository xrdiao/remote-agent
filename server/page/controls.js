  const CONTROLS = {
    mode: () => [...document.querySelectorAll('.composer-unified-dropdown[data-mode]')].find(vis) || devinModeChip(),
    model: () => modelButton(),
    history: () => [...doc.querySelectorAll('[aria-label^="Show Chat History"], [aria-label^="Show Agent History"]')].find(vis),
    newChat: () => [...doc.querySelectorAll('[aria-label="New Agent"], [aria-label^="New Agent ("], [aria-label="New chat"], [aria-label^="New Chat"], [aria-label="New session"], [data-action-id="new-agent"]')].find(vis),
    permission: () => doc.querySelector('[data-composer-navigation-target="permissions"], button[aria-label="Change permissions"]'),
  };

  const center = el => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };

  const control = name => {
    const el = CONTROLS[name]?.();
    return el ? center(el) : null;
  };
  const clickControl = name => {
    const el = CONTROLS[name]?.();
    if (!el) return false;
    // Radix / Base UI menus ignore element.click(); a real mouse event is required.
    if (name === 'permission' || (name === 'mode' && devinModeChip()) || (name === 'model' && [...el.attributes].some(a => a.name.startsWith('data-base-ui')))) return false;
    el.click();
    return true;
  };

  const MENU_ITEMS = {
    effort: () => [...doc.querySelectorAll('[role=menuitem], .ui-menu__row')].filter(e => vis(e) && /^(Low|Medium|High|Max|Extra High|Ultra)$/i.test(normLabel(e.innerText))).map(el => ({ el, label: normLabel(el.innerText), checked: !!el.querySelector('[class*=check]') || el.getAttribute('aria-checked') === 'true' })),
    mode: () => {
      const cursor = [...document.querySelectorAll('.composer-unified-context-menu-item')].map(e => ({ el: e, label: e.innerText.trim().split('\n')[0], checked: !!e.querySelector('.codicon-check') }));
      return cursor.length ? cursor : devinModeRows();
    },
    model: () => {
      const cp = codexPickerProps();
      if (cp) {
        const rows = (cp.modelOptions || []).filter(o => !o.disabled && !o.model?.hidden).map(o => ({
          el: null, id: o.model.id, params: false,
          label: (o.model.displayName || o.model.id).replace(/-/g, ' '),
          checked: o.model.id === cp.model,
        }));
        if (cp.onSelectDefault) rows.unshift({ el: null, id: 'default', params: false, label: 'Default Recommended set of models', checked: cp.selectionMode === 'default' });
        if (rows.length) return rows;
      }
      const codexRows = [...doc.querySelectorAll('[role=menuitemradio]')].filter(e => {
        if (!vis(e)) return false;
        return true;
      });
      if (codexRows.length) return codexRows.map(e => {
        const label = normLabel(e.innerText).split('\n')[0].slice(0, 60);
        return { el: e, id: label, params: false, label, checked: e.getAttribute('aria-checked') === 'true' };
      });
      const models = cursorPickerProps()?.models || [];
      const modelLabel = (el, label) => {
        const id = el.getAttribute('data-testid')?.replace(/^model-item-/, '');
        const model = models.find(m => m.name === id || m.id === id);
        return model ? model.clientDisplayName || model.inputboxShortModelName || model.name : label;
      };
      const currentModel = normLabel(modelButton()?.innerText || '').split('\n')[0];
      // Auto is its own row and has no .ui-model-picker__item-content-name, so the list below would skip it.
      const autoRows = [...doc.querySelectorAll('[data-testid="auto-mode-select"]')].filter(vis).map(e => {
        const label = normLabel(e.innerText).split('\n')[0].slice(0, 60) || 'Auto';
        return {
          el: e,
          id: e.getAttribute('data-testid'),
          params: false,
          label: modelLabel(e, label),
          checked: label === currentModel || !!e.querySelector('[class*=check]') || e.getAttribute('aria-checked') === 'true',
        };
      });
      const classic = [...doc.querySelectorAll('.ui-menu__row')].filter(e => e.getAttribute('data-testid') !== 'auto-mode-select' && e.querySelector('.ui-model-picker__item-content-name'));
      if (classic.length) return [...autoRows, ...classic.map(e => ({ el: e, id: e.dataset.testid, params: !!e.querySelector('[data-testid=parameter-edit-btn]'), label: modelLabel(e, normLabel(e.querySelector('.ui-model-picker__item-content-name').innerText)), checked: !!e.querySelector('.codicon-check, .ui-model-picker__item-right-section [class*=check]') }))];
      const cursorItems = [...doc.querySelectorAll('[data-testid^="model-item-"], [data-testid="auto-mode-select"]')].filter(vis).map(e => {
        const label = normLabel(e.innerText).split('\n')[0].slice(0, 60);
        return {
          el: e,
          id: e.getAttribute('data-testid'),
          params: false,
          label: modelLabel(e, label),
          checked: label === currentModel || !!e.querySelector('[class*=check]') || e.getAttribute('aria-checked') === 'true',
        };
      });
      if (cursorItems.length) return cursorItems;
      const pop = devinModelMenu();
      if (!pop) return [];
      const current = normLabel(devinModelButton()?.innerText || '');
      const pairing = fusionPanel();
      return [...pop.querySelectorAll('button')].filter(e => vis(e) && !pairing?.contains(e)).map(e => {
        const label = normLabel(e.innerText).split('\n')[0].slice(0, 60);
        return { el: e, id: label, params: false, label, checked: label === current };
      }).filter(x => DEVIN_MODEL.test(x.label));
    },
    permission: () => {
      const btn = doc.querySelector('[data-composer-navigation-target="permissions"], button[aria-label="Change permissions"]');
      if (!btn) return [];
      const current = (btn.innerText || '').replace(/\s+/g, ' ').trim();
      return [...doc.querySelectorAll('[role=menuitem]')].filter(vis).map(e => {
        const label = (e.innerText || '').trim().split('\n')[0].trim().slice(0, 40);
        return { el: e, label, checked: label === current };
      }).filter(x => /^(Ask for approval|Approve for me|Full access)$/.test(x.label));
    },
    history: () => {
      const rows = [...doc.querySelectorAll('.composer-history-hover-menu .ui-menu__row')];
      if (rows.length) return rows.map(e => ({ el: e, label: (e.querySelector('.compact-agent-history-react-menu-label, .ui-menu__item-content') || e).innerText.trim().split('\n')[0].slice(0, 80), checked: e.getAttribute('aria-checked') === 'true' || /\b(selected|active|current)\b/.test(e.className) }));
      return [...doc.querySelectorAll('.quick-input-widget .monaco-list-row')].map(e => ({ el: e, label: (e.getAttribute('aria-label') || e.innerText).trim().split('\n')[0].slice(0, 80), checked: e.classList.contains('focused') }));
    },
  };

  const menuItems = kind => (MENU_ITEMS[kind]?.() || []).filter((x, i, rows) => {
    if (!x.label) return false;
    if (rows.findIndex(row => row.label === x.label) !== i) return false;
    if (!x.el) return true;
    if (vis(x.el)) return true;
    const menu = x.el.closest('.ui-menu, [role=menu]');
    return !!(menu && vis(menu) && (x.el.innerText || '').trim());
  }).map(({ el, ...rest }) => rest);

  const menuOpen = () => [...doc.querySelectorAll('.ui-menu, .composer-unified-context-menu-item, .composer-history-hover-menu, [role=menu]')].some(vis) || !!devinModelMenu() || !!fusionPanel();
  const modelListRow = () => [...doc.querySelectorAll('[role=menuitem]')].find(el => vis(el) && (el.getAttribute('aria-label') === 'Select model' || /^Model\b/.test(normLabel(el.innerText))));
  const modelListTrigger = () => {
    const e = modelListRow();
    return e ? center(e) : null;
  };
  const clickModelListTrigger = () => {
    const e = modelListRow();
    if (!e || e.getAttribute('aria-haspopup') === 'menu') return false;
    e.click();
    return true;
  };

  // Model parameters (context size, effort, fast…) live in a per-model submenu behind its "Edit" button.
  const maxToggle = () => {
    const t = [...doc.querySelectorAll('[data-testid=max-mode-toggle]')].find(vis);
    return t ? { ...center(t), on: t.getAttribute('aria-checked') === 'true' } : null;
  };
  const modelTarget = (id, part) => {
    const row = [...doc.querySelectorAll('[data-testid=model-picker-menu] .ui-menu__row')].find(e => e.dataset.testid === id);
    if (!row) return null;
    row.scrollIntoView({ block: 'nearest' });
    if (part !== 'edit') return center(row);
    const b = row.querySelector('[data-testid=parameter-edit-btn]');
    return b && vis(b) ? center(b) : null;
  };
  const paramRows = () => {
    const menu = [...doc.querySelectorAll('[data-testid=parameter-submenu]')].find(vis);
    if (!menu) return null;
    return [...menu.querySelectorAll('.ui-menu__section')].map(s => ({
      title: s.querySelector('.ui-menu__section-title')?.innerText.trim() || '',
      rows: [...s.querySelectorAll('.ui-menu__row, .ui-menu__toggle-row')].filter(vis).map(r => {
        const toggle = r.matches('.ui-menu__toggle-row');
        return { el: r, label: (r.querySelector('.ui-menu__item-content') || r).innerText.trim(), toggle, checked: toggle ? r.getAttribute('aria-checked') === 'true' : !!r.querySelector('.ui-model-picker__param-check') };
      }),
    }));
  };
  const modelParams = () => paramRows()?.map(s => ({ title: s.title, items: s.rows.map(({ el, ...rest }) => rest) })) || null;
  const paramTarget = (title, label) => {
    const row = paramRows()?.find(s => s.title === title)?.rows.find(r => r.label === label);
    return row ? center(row.el) : null;
  };

  const menuItem = (kind, label) => {
    const hit = (MENU_ITEMS[kind]?.() || []).find(x => vis(x.el) && normLabel(x.label) === normLabel(label));
    if (!hit) return null;
    if (!codexThread()) hit.el.scrollIntoView({ block: 'nearest' });
    return codexThread() ? codexPoint(hit.el) : center(hit.el);
  };

  // Returns the button's on-screen center so the click goes through real mouse events.
  const locate = (item, n, actionId, label) => {
    const panel = findPanel();
    if (!panel) return null;
    const root = item === 'g' ? panel : itemByKey(panel, item);
    if (!root) return null;
    let list = item === 'g' ? buttonsIn(panel, true).filter(x => !inItem(x.el) && !inQn(x.el)) : buttonsIn(root, false);
    if (root.hasAttribute?.('data-turn-key')) list = list.filter(x => /^(Copy message|Fork chat from here|View changed files|View changes|Undo|Open agent|View agent|View subagent|Stop agent|Apply|Revert)$/.test(x.label));
    const match = actionId ? list.find(b => b.el.dataset.remoteAction === actionId && b.label === label) : list[n];
    const b = match?.el;
    if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };

  // Devin scrolls a `.cascade-scrollbar` ancestor of the transcript log, not the log itself.
