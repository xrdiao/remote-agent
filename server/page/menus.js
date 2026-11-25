  const codexModelButton = () => [...doc.querySelectorAll('[data-composer-navigation-target="reasoning"]')].find(vis);
  const codexModelName = () => {
    const cp = codexPickerProps();
    if (cp) {
      const sel = (cp.modelOptions || []).find(o => o.model?.id === cp.model)?.model;
      const eff = cp.reasoningEffort;
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
  const modelButton = (readOnly = false) => {
    const codex = codexModelButton();
    if (codex && vis(codex)) return codex;
    const composer = pickComposer([...doc.querySelectorAll(COMPOSER)].filter(e => vis(e) && !e.closest(ITEM_SEL)));
    const toolbar = composer?.closest('.ai-input-full-input-box') || composer?.parentElement?.closest('.ui-prompt-input');
    const known = [...(toolbar || doc).querySelectorAll('.ui-model-picker__trigger, .vscode-model-picker__trigger, .composer-unified-dropdown-model')].filter(vis).at(-1);
    if (known) return known;
    // Model sits in the prompt toolbar, on the opposite side from voice / send.
    // Status chips such as "commit" live outside that toolbar and must not match.
    const bar = toolbar?.querySelector('.ui-prompt-input-toolbar') || doc.querySelector('.ui-prompt-input-toolbar');
    if (!bar) return devinModelButton(!readOnly);
    const right = bar.querySelector('.ui-prompt-input-toolbar__right');
    const STATUS = /^(commit|committing|generating|applying|reading|searching|running|planning|thinking|working|editing|indexing)\b/i;
    const cand = [...bar.querySelectorAll('button, [role=button]')].filter(e => {
      if (!vis(e) || (right && right.contains(e))) return false;
      const text = (e.innerText || '').replace(/\s+/g, ' ').trim();
      return text && !STATUS.test(text);
    });
    return cand.find(e => e.getAttribute('aria-haspopup') === 'menu') || cand[0] || devinModelButton(!readOnly);
  };
  const DEVIN_MODEL = /^(SWE|GPT|Claude|Gemini|GLM|Kimi|Fusion|Ultra|Normal|Lite|Fast)\b/;
  const devinCloudPickerProps = () => devinSurface() && codexFiberProps(devinModelButton(false), 40)
    .find(p => p.menu?.enabledModes && typeof p.onCapabilityChange === 'function');
  const devinCloudModels = p => [...p.menu.enabledModes].filter(id => id !== 'fast' && !p.menu.planLockedModes.has(id))
    .map(id => ({ id, label: id.startsWith('swe-2-') ? id.replace('swe-2-', 'SWE-2 ').split('-').join(' ').replace(/\b(medium|high|max|lightning)\b/g, word => word[0].toUpperCase() + word.slice(1)) : id[0].toUpperCase() + id.slice(1),
      checked: p.menu.selection.kind === 'mode' && p.menu.selection.mode === id }));
  const devinModelButton = (reveal = true) => {
    if (reveal) revealDevinComposer();
    const buttons = [...doc.querySelectorAll('button')].filter(e => vis(e) && !e.closest('.space-y-2'));
    const model = buttons.find(e => codexFiberProps(e, 40).some(p => p.visibleModelConfigs && typeof p.onModelSelect === 'function'));
    if (model) return model;
    return buttons.find(e => {
      // The compact picker exposes its model through aria-label instead of text.
      const text = (e.getAttribute('aria-label') || e.textContent || '').replace(/\s+/g, ' ').trim();
      if (!DEVIN_MODEL.test(text) || text.length >= 50) return false;
      return true;
    });
  };
  const devinModelMenu = () => [...doc.querySelectorAll('div')].find(e => {
    if (!vis(e) || (e.innerText || '').length >= 2500) return false;
    const lines = (e.innerText || '').split('\n').map(line => line.trim());
    return lines.some(line => nativeLabel(line, 'Recently Used') || line === 'Recommended') && lines.some(line => nativeLabel(line, 'See more'));
  });
  const powerProps = () => codexModelButton()
    ? codexFiberProps(modelButton(), 96).find(p => p.powerSelections && typeof p.onSelectPower === 'function' && typeof p.onCommitPower === 'function')
    : null;
  // Current Codex exposes an asynchronous, host-scoped RPC client. Keep model
  // management on that client and verify the exact native conversation again
  // after every read or write; UI picker props alone do not own background tabs.
  const codexModelOwner = async id => {
    if (remoteContext && (remoteContext.app !== 'codex' || remoteContext.threadId !== id))
      throw new Error('Codex 模型请求不属于当前会话 Binding');
    const context = await nativeSessionInfo('codex', id, 'context');
    const host = context.host || 'local', exactDocument = doc;
    const owner = () => codexConversationManager(id, codexHistoryScopes(), host) || codexConnectedRpc(host);
    const client = owner();
    if (!client) throw new Error('Codex 原生模型连接尚未就绪');
    const check = () => {
      if (doc !== exactDocument || exactDocument.defaultView.document !== exactDocument || owner() !== client)
        throw new Error('Codex 原生模型连接已变化');
    };
    const read = async () => {
      check();
      const value = await codexRpcCall(client, 'getConversation', id);
      check();
      if (value?.id !== id || value.hostId !== host || !samePath(value.cwd, context.cwd)
          || remoteContext?.host !== undefined && (context.host || '') !== (remoteContext.host || '')
          || remoteContext?.cwd !== undefined && !samePath(context.cwd, remoteContext.cwd)
          || remoteContext?.roots !== undefined && JSON.stringify(context.roots) !== JSON.stringify(remoteContext.roots))
        throw new Error('Codex 原生模型会话或项目与 Binding 不一致');
      return value;
    };
    return { client, requestClient: codexConversationManager(id, codexHistoryScopes(), host)?.requestClient || client, context, check, read, conversation: await read() };
  };
  const codexModelCatalog = async owner => {
    const provider = owner.conversation.latestThreadSettings?.modelProvider || owner.conversation.modelProvider || null;
    const models = [], seen = new Set();
    let cursor = null;
    do {
      owner.check();
      if (seen.has(cursor) || seen.size >= 8) throw new Error('Codex 原生模型目录分页未收敛');
      seen.add(cursor);
      const page = await codexRpcCall(owner.requestClient, 'sendRequest', 'model/list',
        { cursor, limit: 100, includeHidden: true, modelProvider: provider });
      owner.check();
      if (!Array.isArray(page?.data)) throw new Error('Codex 原生模型目录格式未知');
      models.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    const current = await owner.read();
    if ((current.latestThreadSettings?.modelProvider || current.modelProvider || null) !== provider)
      throw new Error('Codex 原生模型来源已变化，请重新读取');
    return models;
  };
  const codexSetNativeModel = async (id, selection) => {
    const owner = await codexModelOwner(id), models = await codexModelCatalog(owner);
    const before = await owner.read(), settings = before.latestThreadSettings || {};
    const currentModel = settings.model || before.latestModel, currentEffort = settings.effort ?? before.latestReasoningEffort;
    const modelId = selection.model || currentModel;
    const model = models.find(row => (row.model || row.id) === modelId && (!selection.model || !row.hidden));
    if (!model) throw new Error('模型不属于当前 Codex 原生候选');
    const effort = selection.effort ?? (model.supportedReasoningEfforts?.some(row => row.reasoningEffort === currentEffort)
      ? currentEffort : model.defaultReasoningEffort);
    if (!model.supportedReasoningEfforts?.some(row => row.reasoningEffort === effort))
      throw new Error('思考强度不属于当前 Codex 原生候选');
    owner.check();
    const accepted = await codexRpcCall(owner.client, 'updateThreadSettingsForNextTurn', id,
      { model: modelId, effort }, { ifModelEquals: currentModel, ifEffortEquals: currentEffort });
    if (accepted === false) throw new Error('Codex 原生模型设置已变化，未提交选择');
    const after = await owner.read(), actual = after.latestThreadSettings || {};
    if ((actual.model || after.latestModel) !== modelId || (actual.effort ?? after.latestReasoningEffort) !== effort)
      throw new Error('Codex 原生模型设置回执未确认');
    return true;
  };
  const codexPickerProps = () => {
    const trg = codexModelButton();
    const props = trg ? codexFiberProps(trg, 70).find(p => p.modelOptions && p.onSelectModelOption) : null;
    if (remoteContext?.app !== 'codex' || !remoteContext.threadId) return props;
    const host = remoteContext.host || 'local', thread = remoteContext.threadId;
    const manager = codexNativeManager(), projection = codexThreadProjection(thread, host);
    const conversation = manager?.getConversation(thread);
    if (!conversation && (projection?.summary?.conversationId !== thread || projection.summary.hostId !== host)) return null;
    const settings = conversation?.latestThreadSettings || projection?.latestThreadSettings || {};
    const modelId = settings.model || conversation?.latestModel;
    const visible = codexVisibleThread() === thread ? props : null;
    const models = codexQueryClient()?.getQueryCache().getAll().find(query => query.queryKey[0] === 'models' && query.queryKey[2] === host)?.state.data?.data || [];
    const model = models.find(model => (model.model || model.id) === modelId);
    return { ...visible, modelOptions: models.map(model => ({ model })), model: modelId,
      reasoningEffort: settings.effort ?? conversation?.latestReasoningEffort ?? model?.defaultReasoningEffort,
      onSelectModel: (model, effort) => codexSetNativeModel(thread, { model, effort }),
      onSelectComplete: undefined,
      selectionMode: visible?.selectionMode || 'custom' };
  };
  const cursorPickerProps = (readOnly = false) => {
    const btn = modelButton(readOnly);
    if (!btn) return null;
    const props = codexFiberProps(btn, 90).find(p => Array.isArray(p.models) && p.models.length > 5 && (p.selections || p.initialSelections) && typeof p.onSelectionChange === 'function') || null;
    if (!props || remoteContext?.app !== 'cursor') return props;
    const services = cursorSessionServices(), handle = services.data.getHandleIfLoaded(remoteContext.threadId), service = services.composer.composerChatService._modelConfigService;
    return { ...props, selections: service.getSelectedModelsForComposer(handle),
      onSelectionChange: selectedModels => service.setModelConfigForComposer(handle, nativeValue({ selectedModels })) };
  };
  const cursorModelRows = picker => {
    const selected = picker.selections || picker.initialSelections || [];
    const visible = new Set([...(picker.defaultVisibleModelIds || picker.models.filter(model => model.defaultOn).map(model => model.name)),
      ...(picker.additionalVisibleModelIds || []), ...selected.map(selection => selection.modelId)]);
    return picker.models.filter(model => visible.has(model.name)).map(model => ({ id: model.name,
      label: model.clientDisplayName || model.inputboxShortModelName || model.name,
      checked: selected.some(selection => selection.modelId === model.name), params: !!model.parameterDefinitions?.length }));
  };
  const normKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  // Prop-based model list: no visible menu is opened. Returns null when only the DOM path can answer.
  const agentModelName = () => {
    if (remoteContext?.app === 'devin' || devinSurface() && activeThread()) return devinSessionModel()?.name || null;
    const cloud = devinCloudPickerProps();
    if (cloud) return devinCloudModels(cloud).find(row => row.checked)?.label || null;
    const codex = codexModelName();
    if (codex) return codex;
    const cp = devinSurface() ? null : cursorPickerProps();
    if (cp) {
      const sel = (cp.selections || cp.initialSelections || [])[0];
      const model = cp.models.find(m => m.name === sel?.modelId || m.id === sel?.modelId);
      if (model) return model.clientDisplayName || model.inputboxShortModelName || model.name;
    }
    const dp = devinPickerProps();
    const selected = dp && devinConfigs(dp).find(c => dp.selectedModels?.includes(c.modelUid));
    if (selected) return fusionConfig() ? 'Fusion' : selected.familyLabel || selected.label;
    return normLabel(modelButton()?.innerText || '').split('\n')[0].slice(0, 60) || null;
  };
  const devinAcpModelItems = (id = '') => {
    const options = session => session?.configOptions?.find(option => option.category === 'model')?.options;
    const models = id ? options(devinSessionRecord(id))
      : devinSessions().filter(session => session.providerId === 'devin-cli').map(options).find(rows => rows?.length);
    return models?.flatMap(group => group.options || [group]).map(option => ({
      id: option.value, label: option.name, efforts: [], source: '原生 ACP 会话模型选项；型号包含其原生强度，金额未知',
    }));
  };
  const modelItemsFast = (capabilities = false) => {
    if (capabilities) {
      if (remoteContext?.app === 'codex' && remoteContext.threadId) return (async () => {
        const owner = await codexModelOwner(remoteContext.threadId);
        const models = await codexModelCatalog(owner);
        return models.filter(model => !model.hidden).map(model => ({
          id: model.model || model.id, label: (model.displayName || model.model || model.id).replace(/-/g, ' '),
          efforts: (model.supportedReasoningEfforts || []).map(effort => ({ label: effort.reasoningEffort, description: effort.description || '' })),
        }));
      })();
      if (remoteContext?.app === 'devin') {
        const models = devinAcpModelItems(remoteContext.threadId);
        if (models?.length) return models;
        if (remoteContext.threadId) throw new Error('该原生 Devin 会话尚未提供模型配置');
      }
      const codex = codexPickerProps();
      if (codex) return (codex.modelOptions || []).filter(option => !option.disabled && !option.model?.hidden).map(option => ({
        id: option.model.id, label: (option.model.displayName || option.model.id).replace(/-/g, ' '),
        efforts: (option.model.supportedReasoningEfforts || []).map(effort => ({ label: effort.reasoningEffort, description: effort.description || '' })),
      }));
      const cursor = !devinSurface() && cursorPickerProps(true);
      if (cursor) return cursorModelRows(cursor).map(item => {
        const model = cursor.models.find(value => value.name === item.id);
        const values = model?.parameterDefinitions?.find(value => value.id === 'reasoning_effort')?.parameterType?.enumParameter?.values || [];
        return { id: item.id, label: item.label, checked: item.checked, pricing: item.pricing,
          efforts: values.filter(value => value.displayName).map(value => ({ label: value.displayName })) };
      });
      const devin = devinSurface() && devinPickerProps(true);
      if (devin) return devinConfigs(devin, true).filter(config => !config.disabled && (config.isDefaultModelInFamily || config.displayOption === 'model-router'))
        .map(config => ({ id: config.modelUid, family: config.familyUid, label: config.familyLabel || config.label, pricing: devinPricing(config),
          efforts: devinConfigs(devin).filter(value => !value.disabled && value.familyUid === config.familyUid)
            .flatMap(value => { const effort = value.familyMetadata?.['Reasoning Effort'] || value.familyMetadata?.Effort; return effort ? [{ label: effort.name, pricing: devinPricing(value) }] : []; }) }));
      if (remoteContext?.app === 'devin' || devinSurface()) return devinAcpModelItems();
    }
    if (remoteContext?.app === 'cursor') {
      const picker = cursorPickerProps(true);
      return picker ? cursorModelRows(picker) : null;
    }
    if (remoteContext?.app === 'codex' || codexModelButton()) {
      const items = MENU_ITEMS.model();
      return items.length ? items : null;
    }
    if (devinSurface()) {
      const cloud = devinCloudPickerProps();
      if (cloud) return devinCloudModels(cloud);
      const p = devinPickerProps();
      if (!p) return null;
      const selected = devinSelectedModel(p);
      const rows = [...devinModelChoices(p)].map(([label, c]) => ({ label,
        checked: !!selected && (selected.modelUid === c.modelUid || !!c.familyUid && selected.familyUid === c.familyUid) }));
      return rows.length ? rows : null;
    }
    return null;
  };
  const pickDevinModel = async label => {
    const cloud = devinCloudPickerProps();
    if (cloud) {
      const row = devinCloudModels(cloud).find(row => row.label === label);
      if (!row) return false;
      await cloud.onCapabilityChange(row.id);
      return true;
    }
    const p = devinPickerProps();
    if (!p) return false;
    const c = devinModelChoices(p).get(label);
    if (!c) return false;
    await p.onModelSelect(c);
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
    const effort = opt.model.supportedReasoningEfforts.find(x => x.reasoningEffort === p.reasoningEffort)?.reasoningEffort || opt.model.defaultReasoningEffort;
    const selected = p.onSelectModel(opt.model?.id || opt.model?.model || opt.model?.displayName, effort);
    p.onSelectComplete?.();
    return remoteContext?.app === 'codex' ? Promise.resolve(selected).then(() => true) : true;
  };
  const devinPickerProps = (readOnly = false) => {
    const button = devinSurface() && devinModelButton(!readOnly);
    const props = button ? codexFiberProps(button, 40).find(p => p.visibleModelConfigs && p.onModelSelect) : null;
    if (!props || remoteContext?.app !== 'devin' || !remoteContext.threadId) return props;
    const session = devinSessionRecord(remoteContext.threadId), model = session?.configOptions?.find(option => option.category === 'model');
    if (!model) return null;
    return { ...props, selectedModels: [model.currentValue], onModelSelect: async config => {
      return devinSend(session.providerId,
        { method: 'session/set_config_option', params: { sessionId: session.sessionId, configId: model.id, value: config.modelUid } });
    } };
  };
  const devinConfigs = (p, visibleOnly) => visibleOnly
    ? [...new Map((p?.visibleModelConfigs || []).map(c => [c.modelUid, c])).values()]
    : [...new Map([...(p?.visibleModelConfigs || []), ...(p?.modelSorts || []).flatMap(s => (s.groups || []).flatMap(g => g.options || []))].map(c => [c.modelUid, c])).values()];
  const devinModelChoices = p => {
    const choices = new Map();
    for (const c of devinConfigs(p, true)) {
      if (c.disabled || !c.label) continue;
      const fusion = c.familyUid === 'fusion';
      const label = fusion ? 'Fusion' : c.familyLabel || c.label;
      if (!fusion && (!DEVIN_MODEL.test(c.label) || !c.isDefaultModelInFamily && c.displayOption !== 'model-router')) continue;
      if (!choices.has(label) || fusion && c.isDefaultModelInFamily) choices.set(label, c);
    }
    return choices;
  };
  const devinSelectedModel = p => devinConfigs(p).find(c => p.selectedModels?.includes(c.modelUid));
  const devinPricing = (config = devinSelectedModel(devinPickerProps())) => {
    if (!config) return null;
    const tag = devinPickerProps()?.getCostTag?.(config);
    const costs = (config.costs || []).map(({ label, value, denominator, info, unit, fuzzy }) => ({ label, value, denominator, info, unit, fuzzy }));
    if (!costs.length && !tag?.label) return null;
    return { costs, tag: tag?.label || '', tooltip: typeof tag?.tooltip === 'string' ? tag.tooltip : '',
      ...(config.modelCost?.type === 'credit' && /^[\d.]+x\s*$/.test(tag?.label || '') ? { creditMultiplier: config.modelCost.multiplier } : {}) };
  };
  const devinVariants = (part, includePricing = false) => {
    const p = devinPickerProps(), current = devinSelectedModel(p);
    if (!current) return [];
    const key = part === 'lead' ? 'Lead' : part === 'sidekick' ? 'Sidekick' : part === 'fast' ? 'Fast Mode' : current.familyMetadata?.['Reasoning Effort'] ? 'Reasoning Effort' : 'Effort';
    return devinConfigs(p).filter(c => !c.disabled && c.familyUid === current.familyUid && c.familyMetadata?.[key] && Object.entries(current.familyMetadata || {}).every(([k, v]) => k === key || (c.familyMetadata?.[k]?.name === v.name && c.familyMetadata?.[k]?.order === v.order))).map(c => ({ config: c, label: c.familyMetadata[key].name, checked: c.modelUid === current.modelUid, order: c.familyMetadata[key].order, ...(includePricing ? { pricing: devinPricing(c) } : {}) }));
  };
  const effortItems = (includePricing = false, includeHidden = false) => {
    const codex = codexPickerProps();
    if (codex) {
      const visible = codex.modelOptions.find(o => o.model.id === codex.model)?.model.supportedReasoningEfforts || [];
      const host = codexCurrentProject().host || 'local';
      const models = includeHidden ? codexQueryClient()?.getQueryCache().getAll().find(q => q.queryKey[0] === 'models' && q.queryKey[2] === host)?.state.data?.data || [] : [];
      const supported = models.find(m => m.id === codex.model)?.supportedReasoningEfforts || [];
      const choices = [...visible];
      if (supported.some(x => x.reasoningEffort === 'max') && !choices.some(x => x.reasoningEffort === 'max')) choices.push({ reasoningEffort: 'max' });
      return choices
        .map(x => ({ label: x.reasoningEffort, checked: x.reasoningEffort === codex.reasoningEffort }));
    }
    const p = powerProps();
    if (p) return p.powerSelections.filter(x => !x.isLocked).map(x => ({ label: x.reasoningEffort, checked: x.reasoningEffort === p.selectedPowerSelection?.reasoningEffort }));
    const cp = devinSurface() ? null : cursorPickerProps();
    if (cp) {
      const sel = (cp.selections || cp.initialSelections || [])[0];
      const model = cp.models.find(m => m.name === sel?.modelId || m.id === sel?.modelId);
      const def = model?.parameterDefinitions?.find(d => d.id === 'reasoning_effort');
      const cur = sel?.parameters?.find(x => x.id === 'reasoning_effort')?.value;
      const vals = def?.parameterType?.enumParameter?.values;
      if (vals?.length) return vals.filter(v => v.displayName).map(v => ({ label: v.displayName, checked: v.value === cur }));
    }
    return devinVariants('effort', includePricing).sort((a, b) => a.order - b.order).map(({ label, checked, pricing }) => ({ label, checked, ...(pricing ? { pricing } : {}) }));
  };
  const effortName = () => remoteContext?.app === 'devin' || devinSurface() && activeThread() ? null : effortItems().find(x => x.checked)?.label || (doc.querySelector('.vscode-model-picker__trigger') ? /\b(Low|Medium|High|Max|Extra High|Ultra)(?: Fast)?$/i.exec(normLabel(modelButton()?.innerText))?.[1] || 'Effort' : null);
  const pickEffort = label => {
    const codex = codexPickerProps();
    if (codex) {
      const model = codex.modelOptions.find(o => o.model.id === codex.model)?.model;
      if (!model?.supportedReasoningEfforts.some(x => x.reasoningEffort === label)
        && !(label === 'max' && effortItems(false, true).some(x => x.label === label))) return false;
      const selected = codex.onSelectModel(codex.model, label);
      codex.onSelectComplete?.();
      return remoteContext?.app === 'codex' ? Promise.resolve(selected).then(() => true) : true;
    }
    if (remoteContext?.app === 'cursor') {
      const props = cursorPickerProps(true), selections = props.selections, selected = selections[0];
      const model = props.models.find(model => model.name === selected.modelId || model.id === selected.modelId);
      const value = model?.parameterDefinitions?.find(definition => definition.id === 'reasoning_effort')?.parameterType?.enumParameter?.values.find(value => value.displayName === label);
      if (!value) return false;
      const parameters = [...(selected.parameters || []).filter(parameter => parameter.id !== 'reasoning_effort'), { id: 'reasoning_effort', value: value.value }];
      props.onSelectionChange([{ ...selected, parameters }, ...selections.slice(1)]);
      return true;
    }
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
    const selected = devinPickerProps().onModelSelect(row.config);
    return remoteContext?.app === 'devin' ? Promise.resolve(selected).then(() => true) : true;
  };
  const effortTrigger = () => {
    const el = [...doc.querySelectorAll('[role=menuitem], .ui-menu__row')].find(e => vis(e) && /^Effort\b/.test(normLabel(e.innerText)));
    return el ? center(el) : null;
  };
  const closeCodexMenu = () => {
    if (codexRecentPoint()?.open) { codexRecentPoint(false); return true; }
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
  const codexSpeedPicker = () => {
    const button = codexModelButton();
    return button ? codexFiberProps(button, 96).find(p => Array.isArray(p.serviceTierOptions) && typeof p.onSelectServiceTier === 'function') : null;
  };
  const fastProps = () => {
    const props = codexSpeedPicker();
    if (remoteContext?.app !== 'codex') return props;
    const thread = remoteContext.threadId, host = remoteContext.host || 'local';
    const manager = codexNativeManager(), projection = codexThreadProjection(thread, host);
    const conversation = manager?.getConversation(thread);
    if (!conversation && (projection?.summary?.conversationId !== thread || projection.summary.hostId !== host)) return null;
    const settings = conversation?.latestThreadSettings || projection?.latestThreadSettings || {};
    const picker = codexPickerProps(), model = picker?.modelOptions.find(option => option.model.id === picker.model)?.model;
    return { ...(codexVisibleThread() === thread ? props : null), serviceTierOptions: [{ value: null }, ...(model?.serviceTiers || []).map(tier => ({ value: tier.id, iconKind: tier.id === 'priority' ? 'fast' : '', description: { defaultMessage: tier.description } }))],
      selectedServiceTier: settings.serviceTier === 'default' ? null : settings.serviceTier ?? null,
      onSelectServiceTier: async serviceTier => {
        const result = await nativeSessionAction('codex', thread, 'modelSettings', { serviceTier });
        if ((result.serviceTier === 'default' ? null : result.serviceTier ?? null) !== serviceTier)
          throw new Error('Codex 原生速度设置回执未确认');
        return true;
      } };
  };
  const cursorFastRow = () => [...doc.querySelectorAll('[role=menuitemcheckbox], [role=switch]')].find(e => vis(e) && /^Fast(?: Mode)?$/i.test(normLabel(e.innerText)));
  const fastInfo = () => {
    const p = fastProps();
    if (p) {
      const fast = p.serviceTierOptions.find(x => x.iconKind === 'fast');
      return fast ? { on: p.selectedServiceTier === fast.value, description: fast.description?.defaultMessage || '' } : null;
    }
    const cp = devinSurface() ? null : cursorPickerProps();
    if (cp) {
      const sel = (cp.selections || cp.initialSelections || [])[0];
      const model = cp.models.find(m => m.name === sel?.modelId || m.id === sel?.modelId);
      if (model?.parameterDefinitions?.some(d => d.id === 'fast')) return { on: sel.parameters?.find(p => p.id === 'fast')?.value === 'true' };
    }
    const rows = devinVariants('fast');
    if (rows.length > 1) return { on: rows.find(x => x.checked)?.order === 1 };
    const el = cursorFastRow();
    return el ? { on: el.getAttribute('aria-checked') === 'true' } : null;
  };
  const pickFast = on => {
    if (remoteContext?.app === 'cursor') {
      const props = cursorPickerProps(true), selections = props?.selections, selected = selections?.[0];
      const model = props?.models.find(model => model.name === selected?.modelId || model.id === selected?.modelId);
      if (!model?.parameterDefinitions?.some(definition => definition.id === 'fast')) return false;
      const parameters = [...(selected.parameters || []).filter(parameter => parameter.id !== 'fast'), { id: 'fast', value: String(on) }];
      props.onSelectionChange([{ ...selected, parameters }, ...selections.slice(1)]);
      return true;
    }

    const p = fastProps();
    if (p) {
      const option = p.serviceTierOptions.find(x => on ? x.iconKind === 'fast' : x.value == null);
      if (!option) return false;
      const selected = p.onSelectServiceTier(option.value);
      return remoteContext?.app === 'codex' ? Promise.resolve(selected).then(() => true) : true;
    }
    const row = devinVariants('fast').find(x => (x.order === 1) === on);
    if (!row) return false;
    const selected = devinPickerProps().onModelSelect(row.config);
    return remoteContext?.app === 'devin' ? Promise.resolve(selected).then(() => true) : true;
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
  const fusionConfig = (includePricing = false) => {
    const current = devinSelectedModel(devinPickerProps());
    if (current?.familyUid === 'fusion') {
      const m = current.familyMetadata;
      return { lead: m.Lead.name, effort: m.Effort.name, sidekick: m.Sidekick.name, fast: m['Fast Mode']?.order === 1, fastSupported: devinVariants('fast').some(x => x.order === 1), ...(includePricing ? { pricing: devinPricing(current) } : {}) };
    }
    if (remoteContext?.app === 'devin') return null;
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
