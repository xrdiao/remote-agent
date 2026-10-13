  const codexModelName = () => {
    const cp = codexPickerProps();
    if (cp) {
      const sel = (cp.modelOptions || []).find(o => o.model?.id === cp.model)?.model;
      const eff = cp.powerSelections?.find(x => x.id === cp.selectedPowerSelection?.id)?.reasoningEffort;
      const pretty = eff ? eff[0].toUpperCase() + eff.slice(1) : '';
      if (sel) {
        const base = String(sel.displayName || sel.id).replace(/-/g, ' ');
        return pretty ? `${base} · ${pretty}` : base;
      }
    }
    const name = [...doc.querySelectorAll('[class*="ModelPickerTriggerModelText"]')].find(vis)?.textContent?.trim();
    if (!name) return null;
    const effort = [...doc.querySelectorAll('[data-selected-reasoning-effort]')].find(vis)?.getAttribute('data-selected-reasoning-effort') || '';
    const pretty = effort.split(/[\s-]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    return pretty ? `${name} · ${pretty}` : name;
  };
  const modelButton = () => {
    const codex = [...doc.querySelectorAll('[data-codex-intelligence-trigger]')].find(vis);
    if (codex && vis(codex)) return codex;
    const composer = pickComposer([...doc.querySelectorAll(COMPOSER)].filter(e => vis(e) && !e.closest(ITEM_SEL)));
    const toolbar = composer?.closest('.ai-input-full-input-box') || composer?.parentElement?.closest('.ui-prompt-input');
    const known = [...(toolbar || doc).querySelectorAll('.ui-model-picker__trigger, .vscode-model-picker__trigger, .composer-unified-dropdown-model')].filter(vis).at(-1);
    if (known) return known;
    // Model sits in the prompt toolbar, on the opposite side from voice / send.
    // Status chips such as "commit" live outside that toolbar and must not match.
    const bar = toolbar?.querySelector('.ui-prompt-input-toolbar') || doc.querySelector('.ui-prompt-input-toolbar');
    if (!bar) return devinModelButton();
    const right = bar.querySelector('.ui-prompt-input-toolbar__right');
    const STATUS = /^(commit|committing|generating|applying|reading|searching|running|planning|thinking|working|editing|indexing)\b/i;
    const cand = [...bar.querySelectorAll('button, [role=button]')].filter(e => {
      if (!vis(e) || (right && right.contains(e))) return false;
      const text = (e.innerText || '').replace(/\s+/g, ' ').trim();
      return text && !STATUS.test(text);
    });
    return cand.find(e => e.getAttribute('aria-haspopup') === 'menu') || cand[0] || devinModelButton();
  };
  const DEVIN_MODEL = /^(SWE|GPT|Claude|Gemini|GLM|Kimi|Fusion)\b/;
  const devinModelButton = () => {
    revealDevinComposer();
    return [...doc.querySelectorAll('button')].find(e => {
      // textContent first: innerText forces layout for every button on the page.
      const text = (e.textContent || '').replace(/\s+/g, ' ').trim();
      if (!DEVIN_MODEL.test(text) || text.length >= 50) return false;
      return vis(e) && !e.closest('.space-y-2');
    });
  };
  const devinModelMenu = () => [...doc.querySelectorAll('div')].find(e => vis(e) && /Recently Used|Recommended/.test(e.innerText || '') && (e.innerText || '').includes('See more') && (e.innerText || '').length < 2500);
  const powerProps = () => doc.querySelector('[data-codex-intelligence-trigger]') ? codexFiberProps(modelButton(), 40).find(p => p.powerSelections && p.onCommitPower) : null;
  const codexPickerProps = () => {
    const trg = [...doc.querySelectorAll('[data-codex-intelligence-trigger]')].find(vis);
    return trg ? codexFiberProps(trg, 70).find(p => p.modelOptions && p.onSelectModelOption) : null;
  };
  const cursorPickerProps = () => {
    const btn = modelButton();
    if (!btn) return null;
    return codexFiberProps(btn, 90).find(p => Array.isArray(p.models) && p.models.length > 5 && (p.selections || p.initialSelections) && typeof p.onSelectionChange === 'function') || null;
  };
  const normKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  // Prop-based model list: no visible menu is opened. Returns null when only the DOM path can answer.
  const modelItemsFast = () => {
    if (doc.querySelector('[data-codex-intelligence-trigger]')) {
      const items = MENU_ITEMS.model();
      return items.length ? items : null;
    }
    if (devinSurface()) {
      const p = devinPickerProps();
      if (!p) return null;
      const fusion = !!fusionConfig();
      const seen = new Set(['Fusion']);
      const rows = [{ label: 'Fusion', checked: fusion }];
      // The native picker lists one default variant per family (plus the Adaptive router);
      // other effort variants are reachable through the effort list.
      for (const c of devinConfigs(p, true)) {
        if (c.disabled || !c.label || seen.has(c.label) || !DEVIN_MODEL.test(c.label) || /^Fusion \(/.test(c.label)) continue;
        if (!c.isDefaultModelInFamily && c.displayOption !== 'model-router') continue;
        seen.add(c.label);
        rows.push({ label: c.label, checked: !fusion && (p.selectedModels || []).includes(c.modelUid) });
      }
      return rows.length > 1 ? rows : null;
    }
    return null;
  };
  const pickDevinModel = label => {
    const p = devinPickerProps();
    if (!p || normKey(label) === 'fusion') return false;
    const want = normKey(label);
    const c = devinConfigs(p).find(c => !c.disabled && normKey(c.label) === want);
    if (!c) return false;
    p.onModelSelect(c);
    return true;
  };
  const pickCodexModel = label => {
    const p = codexPickerProps();
    if (!p) return false;
    const want = normKey(label);
    const opt = (p.modelOptions || []).find(o => !o.disabled && normKey(o.model?.displayName || o.model?.id) === want);
    if (!opt) {
      if (/^default/.test(want)) {
        if (p.onSelectDefault) { p.onSelectDefault(); p.onSelectComplete?.(); return true; }
        try { p.onSelectModel?.('default'); return true; } catch { return false; }
      }
      return false;
    }
    p.onSelectModel(opt.model?.id || opt.model?.model || opt.model?.displayName);
    p.onSelectComplete?.();
    return true;
  };
  const devinPickerProps = () => {
    const button = devinSurface() && devinModelButton();
    return button ? codexFiberProps(button, 40).find(p => p.visibleModelConfigs && p.onModelSelect) : null;
  };
  const devinConfigs = (p, visibleOnly) => visibleOnly
    ? [...new Map((p?.visibleModelConfigs || []).map(c => [c.modelUid, c])).values()]
    : [...new Map([...(p?.visibleModelConfigs || []), ...(p?.modelSorts || []).flatMap(s => (s.groups || []).flatMap(g => g.options || []))].map(c => [c.modelUid, c])).values()];
  const devinSelectedModel = p => devinConfigs(p).find(c => p.selectedModels?.includes(c.modelUid));
  const devinVariants = part => {
    const p = devinPickerProps(), current = devinSelectedModel(p);
    if (!current) return [];
    const key = part === 'lead' ? 'Lead' : part === 'sidekick' ? 'Sidekick' : part === 'fast' ? 'Fast Mode' : current.familyMetadata?.['Reasoning Effort'] ? 'Reasoning Effort' : 'Effort';
    return devinConfigs(p).filter(c => !c.disabled && c.familyUid === current.familyUid && c.familyMetadata?.[key] && Object.entries(current.familyMetadata || {}).every(([k, v]) => k === key || (c.familyMetadata?.[k]?.name === v.name && c.familyMetadata?.[k]?.order === v.order))).map(c => ({ config: c, label: c.familyMetadata[key].name, checked: c.modelUid === current.modelUid, order: c.familyMetadata[key].order }));
  };
  const effortItems = () => {
    const p = powerProps();
    if (p) return p.powerSelections.filter(x => !x.isLocked).map(x => ({ label: x.reasoningEffort, checked: x.id === p.selectedPowerSelection?.id }));
    const cp = devinSurface() ? null : cursorPickerProps();
    if (cp) {
      const sel = (cp.selections || cp.initialSelections || [])[0];
      const model = cp.models.find(m => m.name === sel?.modelId || m.id === sel?.modelId);
      const def = model?.parameterDefinitions?.find(d => d.id === 'reasoning_effort');
      const cur = sel?.parameters?.find(x => x.id === 'reasoning_effort')?.value;
      const vals = def?.parameterType?.enumParameter?.values;
      if (vals?.length) return vals.filter(v => v.displayName).map(v => ({ label: v.displayName, checked: v.value === cur }));
    }
    return devinVariants('effort').sort((a, b) => a.order - b.order).map(({ label, checked }) => ({ label, checked }));
  };
  const effortName = () => effortItems().find(x => x.checked)?.label || (doc.querySelector('.vscode-model-picker__trigger') ? /\b(Low|Medium|High|Max|Extra High|Ultra)(?: Fast)?$/i.exec(normLabel(modelButton()?.innerText))?.[1] || 'Effort' : null);
  const pickEffort = label => {
    const p = powerProps();
    if (p) {
      const item = p.powerSelections.find(x => !x.isLocked && x.reasoningEffort === label);
      if (!item) return false;
      const previous = p.selectedPowerSelection;
      p.onSelectPower(item);
      p.onCommitPower(item, previous);
      p.onSelectComplete?.();
      return true;
    }
    const row = devinVariants('effort').find(x => x.label === label);
    if (!row) return false;
    devinPickerProps().onModelSelect(row.config);
    return true;
  };
  const effortTrigger = () => {
    const el = [...doc.querySelectorAll('[role=menuitem], .ui-menu__row')].find(e => vis(e) && /^Effort\b/.test(normLabel(e.innerText)));
    return el ? center(el) : null;
  };
  const closeCodexMenu = () => {
    const el = [...doc.querySelectorAll('button[aria-expanded=true][aria-haspopup=menu]')].find(vis);
    if (el) {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse', ctrlKey: false }));
      if (el.getAttribute('aria-expanded') === 'true') el.click();
    }
    return !!el;
  };
  const closeModelMenu = () => {
    const el = modelButton();
    if (el?.getAttribute('aria-expanded') !== 'true') return false;
    el.click();
    return true;
  };
  const fastProps = () => doc.querySelector('[data-codex-intelligence-trigger]') ? codexFiberProps(modelButton(), 40).find(p => p.serviceTierOptions && p.onSelectServiceTier) : null;
  const cursorFastRow = () => [...doc.querySelectorAll('[role=menuitemcheckbox], [role=switch]')].find(e => vis(e) && /^Fast(?: Mode)?$/i.test(normLabel(e.innerText)));
  const fastInfo = () => {
    const p = fastProps();
    if (p) {
      const fast = p.serviceTierOptions.find(x => x.iconKind === 'fast');
      return fast ? { on: p.selectedServiceTier === fast.value, description: fast.description?.defaultMessage || '' } : null;
    }
    const rows = devinVariants('fast');
    if (rows.length > 1) return { on: rows.find(x => x.checked)?.order === 1 };
    const el = cursorFastRow();
    return el ? { on: el.getAttribute('aria-checked') === 'true' } : null;
  };
  const pickFast = on => {
    const p = fastProps();
    if (p) {
      const option = p.serviceTierOptions.find(x => on ? x.iconKind === 'fast' : x.value == null);
      if (!option) return false;
      p.onSelectServiceTier(option.value);
      return true;
    }
    const row = devinVariants('fast').find(x => (x.order === 1) === on);
    if (!row) return false;
    devinPickerProps().onModelSelect(row.config);
    return true;
  };
  const fastTarget = () => { const el = cursorFastRow(); return el ? center(el) : null; };
  const clickCursorFast = () => cursorFastRow().click();
  const normLabel = s => (s || '').replace(/[\u200b\u200c\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  // Fusion is a lead + sidekick pairing. The detail panel only exists while that model menu is open.
  const fusionPanel = () => [...doc.querySelectorAll('div')].find(e => {
    if (!vis(e)) return false;
    const t = e.innerText || '';
    const b = e.getBoundingClientRect();
    return b.width > 200 && b.width < 520 && t.includes('Lead') && t.includes('Sidekick') && t.includes('Fast Mode') && t.length < 900;
  });
  const fusionLine = el => normLabel((el?.innerText || '').split('\n')[0]).slice(0, 60);
  const fusionConfig = () => {
    const current = devinSelectedModel(devinPickerProps());
    if (current?.familyUid === 'fusion') {
      const m = current.familyMetadata;
      return { lead: m.Lead.name, effort: m.Effort.name, sidekick: m.Sidekick.name, fast: m['Fast Mode']?.order === 1, fastSupported: devinVariants('fast').some(x => x.order === 1) };
    }
    const panel = fusionPanel();
    if (!panel) return null;
    const boxes = [...panel.querySelectorAll('[role=combobox]')].filter(vis);
    if (boxes.length < 3) return null;
    const sw = panel.querySelector('[role=switch]');
    return { lead: fusionLine(boxes[0]), effort: fusionLine(boxes[1]), sidekick: fusionLine(boxes[2]), fast: sw?.getAttribute('aria-checked') === 'true', fastSupported: !!sw && sw.getAttribute('aria-disabled') !== 'true' && !sw.disabled };
  };
  const clickFusionCombo = part => {
    const panel = fusionPanel();
    const boxes = panel ? [...panel.querySelectorAll('[role=combobox]')].filter(vis) : [];
    const i = part === 'lead' ? 0 : part === 'effort' ? 1 : part === 'sidekick' ? 2 : -1;
    const el = boxes[i];
    if (!el) return false;
    el.click();
    return true;
  };
  const clickFusionFast = () => {
    const sw = fusionPanel()?.querySelector('[role=switch]');
    if (!sw) return false;
    sw.click();
    return true;
  };
  const fusionOptionItems = () => {
    const seen = new Set();
    const items = [];
    for (const el of doc.querySelectorAll('[role=option]')) {
      if (!vis(el)) continue;
      const label = fusionLine(el);
      if (!label || label.length > 60 || seen.has(label)) continue;
      seen.add(label);
      items.push({ label, checked: el.getAttribute('aria-selected') === 'true' });
    }
    return items;
  };
  const fusionOptionTarget = label => {
    const want = normLabel(label);
    const el = [...doc.querySelectorAll('[role=option]')].find(e => vis(e) && fusionLine(e) === want);
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest' });
    return center(el);
  };
