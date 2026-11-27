import { Cdp, cdpRead } from '../../cdp.mjs';
import { codexBackend } from '../../codex/state.mjs';
import { nativeWindowAt } from '../../native-windows.mjs';
import { helpersCall } from '../../page/build.mjs';
import { accountPlan, accountStamp, ensureBackendAccount } from './account-usage.mjs';

async function withCodexModelOwner(s, action, readOnly = false) {
  const id = s.threadId;
  if (!id) throw new Error('Codex 会话尚未加载');
  if (!s.codexBackend) return action({ id, cdp: s.cdp });
  const owner = await s.adapter.backendOwner(id, !readOnly);
  if (!owner) {
    const account = await ensureBackendAccount(s);
    return readOnly ? action({ id, account, thread: await codexBackend.readModelState(id) })
      : codexBackend.withWriter(id, thread => action({ id, account, thread }));
  }
  const cdp = new Cdp(owner.chatWs), context = { app: 'codex', threadId: id, host: '', cwd: owner.cwd };
  try {
    await cdp.connect();
    return await action({ id, cdp, context });
  } finally { cdp.close(); }
}

async function codexModelSettings(owner, withAccount = false) {
  if (owner.thread) return { ...owner.thread.settings, model: owner.thread.settings.model || owner.thread.model,
    ...(withAccount ? { account: owner.account } : {}) };
  return owner.cdp.evaluate(helpersCall(`nativeSessionInfo('codex', ${JSON.stringify(owner.id)}, 'modelSettings', ${withAccount})`, owner.context));
}

async function codexModelList(owner, settings) {
  const models = [];
  let cursor = null;
  do {
    const params = { cursor, limit: 100, includeHidden: true, modelProvider: settings.modelProvider || null };
    const page = owner.thread ? await codexBackend.client.request('model/list', params)
      : await owner.cdp.evaluate(helpersCall(`nativeSessionInfo('codex', ${JSON.stringify(owner.id)}, 'modelPage', ${JSON.stringify(params)})`, owner.context));
    models.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return models;
}

const codexModelLists = new WeakMap();
async function codexMenuModels(owner, settings, account) {
  if (!account?.account) return codexModelList(owner, settings);
  const source = owner.thread ? codexBackend.client : nativeWindowAt(owner.cdp.wsUrl) || owner.cdp;
  const key = JSON.stringify([accountStamp(account), accountPlan(account), settings.modelProvider || null,
    owner.thread ? codexBackend.client.generation : owner.cdp.wsUrl, owner.context?.host || '']);
  const previous = codexModelLists.get(source);
  if (previous?.key === key && previous.until > Date.now()) return previous.result;
  const entry = { key, until: Infinity };
  entry.result = cdpRead.run(null, () => codexModelList(owner, settings)).then(models => {
    entry.until = Date.now() + 60000;
    return models;
  }, error => {
    if (codexModelLists.get(source) === entry) codexModelLists.delete(source);
    throw error;
  });
  codexModelLists.set(source, entry);
  return entry.result;
}

const codexModelId = model => model.model || model.id;
const codexTierId = value => value === 'default' ? null : value ?? null;
const isFastTier = value => value === 'fast' || value === 'priority';
const sameCodexTier = (a, b) => codexTierId(a) === codexTierId(b) || isFastTier(a) && isFastTier(b);
async function codexSpeedOptions(owner, model, settings) {
  if (settings.speed) {
    const { options, selected } = settings.speed;
    const effective = settings.serviceTier != null && options.some(option => sameCodexTier(option.id, settings.serviceTier));
    return { options, selected: effective ? settings.serviceTier : selected };
  }
  if (!model?.serviceTiers?.length) return { options: [], selected: null };
  const data = owner.thread ? await codexBackend.client.request('configRequirements/read', {})
    : await owner.cdp.evaluate(helpersCall(`nativeSessionInfo('codex', ${JSON.stringify(owner.id)}, 'speedRequirements')`, owner.context));
  const requirements = data?.requirements?.featureRequirements;
  const fast = requirements?.fast_mode !== false;
  const ultrafast = (fast || data?.supportsIndependentSpeedModes === true) && requirements?.ultrafast_mode !== false;
  const options = [{ id: null, label: 'Standard', description: '', icon: null }];
  for (const tier of model.serviceTiers) {
    if (codexTierId(tier.id) == null) continue;
    const icon = isFastTier(tier.id) || /^fast$/i.test(tier.name) ? 'fast'
      : tier.id === 'ultrafast' || /^ultrafast$/i.test(tier.name) ? 'ultrafast' : null;
    if (!(tier.id === 'flex' || (icon === 'ultrafast' ? ultrafast : fast))) continue;
    options.push({ id: tier.id, label: tier.name || tier.id, description: tier.description || '', icon });
  }
  return { options, selected: settings.serviceTier ?? model.defaultServiceTier ?? null };
}
function codexSpeedState({ options, selected }) {
  const items = options.map(row => ({ ...row, checked: sameCodexTier(row.id, selected) }));
  const fast = items.find(row => row.icon === 'fast');
  return { items, on: !!fast?.checked, description: fast?.description || '' };
}

export async function readCodexModelMenu(kind, requestId) {
  const sel = this.selectionKey(), id = this.threadId, generation = this.sel;
  const prefetch = requestId == null;
  const previous = this.codexModelRead;
  const sameSelection = previous && previous.sel === sel && previous.generation === generation;
  if (prefetch && sameSelection) return;
  const read = this.codexModelRead = { sel, generation, prefetch };
  const load = async owner => {
    const { account, ...settings } = await codexModelSettings(owner, true);
    const models = await codexMenuModels(owner, settings, account);
    const current = models.find(row => codexModelId(row) === settings.model);
    return { settings, models, current, speed: await codexSpeedOptions(owner, current, settings), account: accountStamp(account) };
  };
  // A prefetch may use the current backend account, but must not switch it.
  const query = () => withCodexModelOwner(this, load, true);
  const warm = async () => {
    const account = await codexBackend.account();
    if (accountStamp(account) !== this.codexAccount?.account || !account.account || this.selectionKey() !== sel || this.sel !== generation) return null;
    return load({ id, account, thread: await codexBackend.readModelState(id) });
  };
  const pending = !prefetch && sameSelection && previous.prefetch ? previous.pending : null;
  read.pending = prefetch && this.codexBackend ? warm() : pending
    ? pending.then(result => result || query(), query) : query();
  const result = await read.pending.finally(() => { read.pending = null; });
  if (!result || this.codexModelRead !== read || this.selectionKey() !== sel || this.threadId !== id || this.sel !== generation) return;
  const { settings, models, current, speed, account } = result;
  this.codexModelCatalog = { id, account, provider: settings.modelProvider || null, models };
  const modelItems = models.filter(row => !row.hidden).map(row => ({ label: row.displayName || codexModelId(row),
    id: codexModelId(row), checked: codexModelId(row) === settings.model }));
  if (models.some(row => row.isDefault)) modelItems.unshift({ id: '__codex_default__', label: 'Default Recommended set of models', checked: false });
  const effortItems = (current?.supportedReasoningEfforts || []).map(row => ({ label: row.reasoningEffort,
    checked: row.reasoningEffort === (settings.effort ?? settings.reasoningEffort ?? current.defaultReasoningEffort) }));
  const speedState = codexSpeedState(speed), model = current?.displayName || settings.model;
  const items = kind === 'effort' ? effortItems : kind === 'fast' ? speedState.items : modelItems;
  this.emit({ t: 'menu', kind, requestId, sel, items, modelItems, effortItems,
    fast: speedState.items.length > 1 ? speedState : null, model });
}

export async function pickCodexModelMenu(kind, label, name) {
  const id = this.threadId, sel = this.selectionKey(), generation = this.sel, catalog = this.codexModelCatalog;
  if (!catalog || catalog.id !== id) throw new Error('请重新打开 Codex 模型菜单');
  let speedOptions, chosenSpeed;
  const result = await withCodexModelOwner(this, async owner => {
    const { account, ...settings } = await codexModelSettings(owner, true);
    if (accountStamp(account) !== catalog.account) throw new Error('Codex 账号已切换，请重新打开菜单');
    if ((settings.modelProvider || null) !== catalog.provider) throw new Error('Codex 模型来源已变化，请重新打开菜单');
    const current = catalog.models.find(row => codexModelId(row) === settings.model);
    let update;
    if (kind === 'model') {
      const model = name === '__codex_default__' ? catalog.models.find(row => row.isDefault)
        : catalog.models.find(row => codexModelId(row) === name && !row.hidden);
      if (!model) throw new Error('Codex 模型已不存在');
      const effort = name === '__codex_default__' ? model.defaultReasoningEffort
        : model.supportedReasoningEfforts.find(row => row.reasoningEffort === settings.effort)?.reasoningEffort || model.defaultReasoningEffort;
      update = { model: codexModelId(model), effort };
    } else if (kind === 'effort') {
      if (!current?.supportedReasoningEfforts.some(row => row.reasoningEffort === label)) throw new Error('当前模型不支持这个思考强度');
      update = { effort: label };
    } else {
      ({ options: speedOptions } = await codexSpeedOptions(owner, current, settings));
      chosenSpeed = speedOptions.find(row => label === 'on' ? row.icon === 'fast'
        : label === 'off' ? row.id == null : (row.id ?? '') === name);
      if (!chosenSpeed) throw new Error('当前模型不提供这个速度档位，请重新打开菜单');
      update = { serviceTier: chosenSpeed.id ?? 'default' };
    }
    if (this.selectionKey() !== sel || this.threadId !== id || this.sel !== generation) throw new Error('会话已切换，请重新操作');
    if (owner.thread) {
      await codexBackend.client.request('thread/settings/update', { threadId: id, ...update });
      Object.assign(owner.thread.settings, update);
      codexBackend.remember(owner.thread);
      return owner.thread.settings;
    }
    return owner.cdp.evaluate(helpersCall(`nativeSessionAction('codex', ${JSON.stringify(id)}, 'modelSettings', ${JSON.stringify(update)})`, owner.context));
  });
  if (this.selectionKey() !== sel || this.threadId !== id || this.sel !== generation) return;
  if (kind === 'fast') {
    if (!sameCodexTier(result.serviceTier, chosenSpeed.id)) throw new Error('Codex 尚未确认速度切换，请重新读取菜单');
    this.emit({ t: 'fastState', sel, fast: codexSpeedState({ options: speedOptions, selected: result.serviceTier }) });
  }
  if (this.codexBackend) codexBackend.changed(id);
  else this.refreshModelChat().catch(() => {});
}
