  const selCardId = () => doc.querySelector('[data-sidebar-item-key] [data-active="true"]')?.closest('[data-sidebar-item-key]')?.getAttribute('data-sidebar-item-key')?.slice(4) || '';
  const codexNativeModule = async prefix => {
    const modules = window.__remoteAgentNativeModules ||= new Map();
    if (!modules.has(prefix)) modules.set(prefix, (async () => {
      const entry = [...doc.scripts].find(script => script.src).src;
      const index = await (await fetch(entry)).text();
      const main = new URL(index.match(/app-main-[a-f0-9]+\.js/)[0], entry);
      const source = await (await fetch(main)).text();
      const file = source.match(new RegExp(prefix + '-[a-f0-9]+\\.js'))[0];
      return import(new URL(file, main).href);
    })());
    return modules.get(prefix);
  };
  const codexComposerScope = async (id, required = true) => {
    const composer = await codexNativeModule('composer-view-state');
    const nodes = new Set(), pending = [...codexHistoryScopes()];
    while (pending.length) {
      const node = pending.pop();
      if (nodes.has(node)) continue;
      nodes.add(node);
      if (node.parent) pending.push(node.parent);
      for (const entries of node.retainedScopeEntries.values()) for (const entry of entries.values()) pending.push(entry.node);
    }
    const node = [...nodes].find(node => node.token.__scopeBrand === 'ComposerScope' && (node.value.conversationId || '') === (id || ''));
    if (!node) {
      if (required) throw new Error('所选 Codex 会话的原生输入状态尚未就绪');
      return null;
    }
    const parents = [];
    for (let parent = node; parent; parent = parent.parent) parents.push(parent);
    const chain = new Map(parents.map(parent => [parent.token.id, parent]));
    const scope = { node, chain, value: Object.assign({}, ...parents.reverse().map(parent => parent.value)),
      get(ref, key) { const value = ref.resolve(node, chain, key); return typeof value.get === 'function' ? value.get() : node.store.get(value); },
      set(ref, ...args) {
        const value = ref.resolve(node, chain, args.length === 2 ? args[0] : undefined), next = args.at(-1);
        if (typeof value.set === 'function') value.set(next); else node.store.set(value, next);
      },
    };
    return { scope, composer };
  };
  const codexConversationDraft = async (id, text, expected) => {
    const { scope, composer } = await codexComposerScope(id);
    if (text !== undefined && (expected === undefined || scope.get(composer.M) === expected)) {
      const draft = scope.get(composer.f);
      composer.gt(scope, { ...draft, prompt: text, pullRequestChecks: draft?.pullRequestChecks || [] });
    }
    return scope.get(composer.M);
  };
  const pickComposer = eds => {
    const sel = selCardId();
    return eds.find(e => e.contains(doc.activeElement))
      || (sel && eds.find(e => e.closest('[data-glass-agent-id]')?.getAttribute('data-glass-agent-id') === sel))
      || eds.at(-1);
  };
  const composerDraft = () => {
    if (document.getElementById('active-frame')) return codexPromptText() || '';
    const eds = [...doc.querySelectorAll(`${COMPOSER}, [data-slate-editor="true"][contenteditable="true"]`)].filter(e => vis(e) && !inItem(e));
    const ed = pickComposer(eds);
    if (!ed || ed.querySelector('[data-slate-placeholder]')) return '';
    return (ed.innerText || '').replace(/\n+$/g, '');
  };
  const composerFocused = () => {
    const a = doc.activeElement;
    return !!a?.closest?.(`${COMPOSER}, [data-slate-editor="true"]`) && !inItem(a);
  };
  const queueEditing = () => document.getElementById('active-frame')
    ? codexQueueController()?.editingMessageId || ''
    : [...doc.querySelectorAll('[data-editing-queue-item-id]')].find(vis)?.dataset.editingQueueItemId || '';
  const queueText = (id, includeEditing = true) => {
    if (queueEditing() === id) return includeEditing ? document.getElementById('active-frame') ? codexPromptText() : composerDraft() : undefined;
    return (document.getElementById('active-frame') ? codexQueued(true) : queued(true)).find(item => item.id === id)?.t;
  };
  const saveQueueEdit = id => {
    const data = cursorSessionServices()?.data.getComposerDataIfLoaded(activeThread());
    const queue = data?.capabilities.find(capability => typeof capability.saveEditedItemBackToQueue === 'function');
    const item = queue?.getQueueItems().find(item => item.id === id);
    if (!item || queueEditing() !== id) return false;
    const original = queue.toComposerQueueItem(item);
    queue.saveEditedItemBackToQueue({ query: data.text, extras: { ...original.extras, richText: data.richText } });
    return true;
  };
  // Write the composer via the editor's own API (no keyboard, no focus). Returns true only when it worked.
  const setComposerDraft = text => {
    text = String(text ?? '');
    if (document.getElementById('active-frame')) {
      // Codex keeps its current EditorView on the native composer controller.
      const ed = [...doc.querySelectorAll('.ProseMirror[contenteditable="true"]')].find(e => vis(e));
      if (!ed) return false;
      const view = codexFiberProps(ed, Infinity).find(p => p.composerController)?.composerController.view;
      if (!view) return false;
      const schema = view.state.schema;
      const children = text.split('\n').flatMap((line, i) => [...(i ? [schema.nodes.hard_break.create()] : []), ...(line ? [schema.text(line)] : [])]);
      view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, schema.nodes.paragraph.create(null, children)));
      return composerDraft() === text.replace(/\n+$/g, '');
    }
    const eds = [...doc.querySelectorAll(`${COMPOSER}, [data-slate-editor="true"][contenteditable="true"]`)].filter(e => vis(e) && !inItem(e));
    const sel = selCardId();
    const selEds = sel ? eds.filter(e => e.closest('[data-glass-agent-id]')?.getAttribute('data-glass-agent-id') === sel) : [];
    const ed = (selEds.length ? selEds : eds).filter(e => e.editor?.commands?.setContent).at(-1)
      || (selEds.length ? selEds : eds).find(e => e.contains(doc.activeElement))
      || (selEds.length ? selEds.at(-1) : eds.at(-1));
    if (!ed) return false;
    // Cursor tiptap keeps the Editor on the DOM node.
    const cmd = ed.editor?.commands;
    if (cmd?.setContent) {
      const content = [{ type: 'paragraph', content: String(text).split('\n').flatMap((line, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : [])]) }];
      cmd.setContent({ type: 'doc', content });
      return composerDraft() === text.replace(/\n+$/g, '');
    }
    // Devin Slate: find the editor object on the fiber.
    const slate = codexFiberProps(ed, Infinity).flatMap(p => Object.values(p || {}))
      .find(v => v && typeof v === 'object' && typeof v.apply === 'function' && Array.isArray(v.children));
    if (slate) {
      let path = [], node = { children: slate.children }, last = { text: '' };
      while (node?.children?.length) { path.push(node.children.length - 1); node = node.children[node.children.length - 1]; }
      if (node && typeof node.text === 'string') last = node;
      const range = { anchor: { path: [0, 0], offset: 0 }, focus: { path, offset: last.text.length } };
      if (typeof slate.select === 'function') slate.select(range);
      else slate.apply({ type: 'set_selection', properties: null, newProperties: range });
      if (typeof slate.deleteFragment === 'function') slate.deleteFragment();
      else slate.delete({ at: range });
      text.split('\n').forEach((line, i) => {
        if (i) slate.insertBreak();
        if (line) slate.insertText(line);
      });
      return composerDraft() === text.replace(/\n+$/g, '');
    }
    return false;
  };
  // Typeahead queries restore the native document and selection, including existing reference chips.
  const composerQuery = (text, caret, restore = false) => {
    if (restore) {
      const undo = doc.__remoteMentionRestore;
      delete doc.__remoteMentionRestore;
      if (undo) undo();
      return true;
    }
    const codex = !!document.getElementById('active-frame');
    const ed = codex ? codexPromptEl() : pickComposer([...doc.querySelectorAll('[data-slate-editor="true"][contenteditable="true"]')].filter(vis));
    if (!ed) throw new Error('没找到搜索使用的输入框');
    if (codex) {
      const view = codexFiberProps(ed, Infinity).find(p => p.composerController).composerController.view;
      const before = view.state;
      doc.__remoteMentionRestore = () => {
        const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, before.doc.content);
        view.dispatch(tr.setSelection(before.selection.constructor.fromJSON(tr.doc, before.selection.toJSON())));
      };
      setComposerDraft(text);
      ed.focus();
      const selection = view.state.selection.constructor.near(view.state.doc.resolve(caret + 1));
      view.dispatch(view.state.tr.setSelection(selection));
    } else {
      const slate = codexFiberProps(ed, Infinity).flatMap(p => Object.values(p || {}))
        .find(v => v && typeof v.apply === 'function' && Array.isArray(v.children));
      const children = structuredClone(slate.children), selection = structuredClone(slate.selection);
      doc.__remoteMentionRestore = () => {
        children.forEach((node, n) => slate.apply({ type: 'insert_node', path: [n], node }));
        for (let n = slate.children.length - 1; n >= children.length; n--) slate.apply({ type: 'remove_node', path: [n], node: slate.children[n] });
        slate.apply({ type: 'set_selection', properties: slate.selection, newProperties: selection });
      };
      setComposerDraft(text);
      ed.focus();
      const lines = text.slice(0, caret).split('\n');
      const point = { path: [lines.length - 1, 0], offset: lines.at(-1).length };
      slate.apply({ type: 'set_selection', properties: slate.selection, newProperties: { anchor: point, focus: point } });
    }
    return true;
  };
  const readDevinUsage = async (refresh = false) => {
    const input = doc.querySelector('[data-slate-editor]');
    const key = input && Object.keys(input).find(k => k.startsWith('__reactFiber'));
    const fiber = input?.[key];
    let root = fiber, account, auth;
    while (root?.return) root = root.return;
    const current = root?.stateNode?.current === root;
    for (let f = fiber; f; f = f.return) {
      const provider = current ? f : f.alternate;
      if (provider?.tag !== 10) continue;
      const value = provider.memoizedProps?.value;
      if (typeof value?.refetchUserStatus === 'function') account = value;
      if (value?.api?.auth) auth = value.api.auth;
    }
    const UserStatus = account?.userStatus?.constructor;
    if (typeof UserStatus?.fromBinary !== 'function' || !auth) return { missing: true, quota: [], limits: [] };
    let confirmed = false, refreshError;
    if (refresh) {
      const stop = auth.onDidChangeUserStatus(() => { confirmed = true; });
      try {
        await auth.refreshUserStatus();
        if (!confirmed) refreshError = '原生账户未确认额度刷新';
      } catch (error) {
        refreshError = String(error.message || error);
      } finally {
        stop();
      }
    }
    // React can still hold the previous account value after the native refresh resolves.
    const binary = auth.getUserStatusBinaryBase64();
    const status = binary && UserStatus.fromBinary(Uint8Array.from(atob(binary), c => c.charCodeAt(0))).planStatus;
    if (!status) return { missing: true, quota: [], limits: [] };
    const info = status.planInfo || {};
    return {
      missing: false, quota: [], plan: info.planName,
      ...(refresh && confirmed && !refreshError ? { updated: Date.now() } : { cached: true, ...(refreshError ? { refreshError } : {}) }),
      limits: [['每日额度', status.dailyQuotaRemainingPercent, status.dailyQuotaResetAtUnix, info.hideDailyQuota],
        ['每周额度', status.weeklyQuotaRemainingPercent, status.weeklyQuotaResetAtUnix, info.hideWeeklyQuota]]
        .filter(([, , , hidden]) => !hidden)
        .map(([label, pct, reset]) => ({
          label, kind: 'limit', basis: 'remaining', pct: Number.isFinite(pct) ? pct : null,
          reset: Number(reset) ? new Date(Number(reset) * 1000).toLocaleString('zh-CN') : '',
        })),
      extra: status.overageBalanceMicros == null ? '' : new Intl.NumberFormat('en-US', {
        style: 'currency', currency: 'USD',
      }).format(Number(status.overageBalanceMicros) / 1000000),
    };
  };
  const codexRootProps = () => {
    const el = [...doc.querySelectorAll('[data-composer-body], [data-response-annotation-conversation], [data-request-input-dismiss]')].find(vis);
    return el ? codexFiberProps(el, Infinity) : [];
  };
  const codexQueryClient = () => codexRootProps().find(p => typeof p.value?.getQueryData === 'function')?.value || null;
  const openCodexThread = async id => {
    const router = codexRootProps().find(p => typeof p.value?.router?.navigate === 'function')?.value.router;
    if (!router) return false;
    await router.navigate(`/local/${id}`);
    return true;
  };
  const codexWorkspaceRoots = () => codexQueryClient()?.getQueryData(['vscode', 'workspace-root-options', '{"hostId":"local"}'])?.roots || [];
  const codexCurrentProject = () => {
    const meta = codexQueryClient()?.getQueryData(['recent-conversations-meta', 'updated_at', '[]', 'live'])?.find(t => t.conversationId === codexThread());
    return { root: meta?.cwd || codexWorkspaceRoots()[0] || '', host: meta?.hostId && meta.hostId !== 'local' ? meta.hostId : '' };
  };
  const refreshCodexUsage = async (refresh = true) => {
    const client = codexQueryClient();
    if (!client) throw new Error('没找到 Codex 的额度查询');
    if (refresh) await client.refetchQueries({ queryKey: ['rate-limit-status'], exact: true, type: 'all' }, { throwOnError: true, cancelRefetch: false });
    const data = client.getQueryData(['rate-limit-status']);
    if (!data?.rate_limit && !refresh) return null;
    if (!data?.rate_limit) throw new Error('没有读到额度');
    const limits = [data.rate_limit.primary_window, data.rate_limit.secondary_window].filter(Boolean).map(window => ({
      label: window.limit_window_seconds === 604800 ? '每周限制' : window.limit_window_seconds === 18000 ? '5 小时限制' : '额度限制',
      kind: 'limit', basis: 'remaining', pct: 100 - window.used_percent,
      reset: new Date(window.reset_at * 1000).toLocaleString('zh-CN'),
    }));
    const plan = data.plan_type ? data.plan_type[0].toUpperCase() + data.plan_type.slice(1) : '';
    return { cached: !refresh, updated: client.getQueryState(['rate-limit-status']).dataUpdatedAt, missing: !limits.length, quota: [], limits, ...(plan ? { plan } : {}) };
  };

  // Named controls in Cursor's UI; each entry lists fallbacks from newest to oldest Cursor layouts.
  // Devin's permission mode: a chip in the prompt toolbar (Code / Smart / Ask / Plan / Bypass Permissions). Its menu
  // only opens for real mouse events (a JS click does nothing), rows are role=menuitem with a description and a
  // second trailing svg on the current one.
  const DEVIN_MODES = ['Code', 'Smart', 'Ask', 'Plan', 'Bypass Permissions'];
  const devinModeChip = () => !devinSurface() ? null : [...document.querySelectorAll('button[aria-haspopup="menu"]')]
    .find(b => vis(b) && b.getBoundingClientRect().y > 120 && DEVIN_MODES.some(label => nativeLabel((b.innerText || '').trim(), label)));
  const devinModeRows = () => [...document.querySelectorAll('[role="menuitem"]')].filter(e => vis(e) && DEVIN_MODES.some(label => nativeLabel((e.innerText || '').trim().split('\n')[0], label)))
    .map(e => {
      const lines = (e.innerText || '').split('\n').map(x => x.trim()).filter(Boolean);
      return { el: e, label: lines[0], desc: lines[1] || '', checked: e.querySelectorAll(':scope > svg').length > 1 };
    });
