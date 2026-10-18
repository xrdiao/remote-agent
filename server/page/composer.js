  const selCardId = () => doc.querySelector('[data-sidebar-item-key] [data-active="true"]')?.closest('[data-sidebar-item-key]')?.getAttribute('data-sidebar-item-key')?.slice(4) || '';
  const pickComposer = eds => {
    const sel = selCardId();
    return eds.find(e => e.contains(doc.activeElement))
      || (sel && eds.find(e => e.closest('[data-glass-agent-id]')?.getAttribute('data-glass-agent-id') === sel))
      || eds.at(-1);
  };
  const composerDraft = () => {
    if (doc.querySelector('#active-frame')) return codexPromptText() || '';
    const eds = [...doc.querySelectorAll(`${COMPOSER}, [data-slate-editor="true"][contenteditable="true"]`)].filter(e => vis(e) && !inItem(e));
    const ed = pickComposer(eds);
    if (!ed || ed.querySelector('[data-slate-placeholder]')) return '';
    return (ed.innerText || '').replace(/\n+$/g, '');
  };
  const composerFocused = () => {
    const a = doc.activeElement;
    return !!a?.closest?.(`${COMPOSER}, [data-slate-editor="true"]`) && !inItem(a);
  };
  // Write the composer via the editor's own API (no keyboard, no focus). Returns true only when it worked.
  const setComposerDraft = text => {
    text = String(text ?? '');
    if (doc.querySelector('#active-frame')) {
      // Codex ProseMirror has no editor ref on the DOM node; find the EditorView in React props/state.
      const ed = [...doc.querySelectorAll('.ProseMirror[contenteditable="true"]')].find(e => vis(e));
      if (!ed) return false;
      let view = codexFiberProps(ed, Infinity).flatMap(p => Object.values(p || {}))
        .find(v => v && typeof v === 'object' && typeof v.dispatch === 'function' && v.state?.doc && v.state?.tr);
      if (!view) view = codexFiberProps(ed, Infinity).flatMap(p => Object.values(p || {}))
        .map(v => v?.current).find(v => v && typeof v === 'object' && typeof v.dispatch === 'function' && v.state?.doc && v.state?.tr);
      if (!view) return false;
      const schema = view.state.schema;
      const Frag = view.state.doc.content.constructor;
      const children = text.split('\n').map(line => (schema.nodes.paragraph || Object.values(schema.nodes).find(n => n.isBlock && n.name !== 'doc')).create(null, line ? schema.text(line) : null));
      view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, Frag.from(children)));
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
  const readDevinUsage = async (refresh = false) => {
    const input = [...doc.querySelectorAll(`${COMPOSER}, [data-slate-editor="true"]`)].filter(e => vis(e) && e.isContentEditable && !inItem(e)).at(-1);
    const api = input && codexFiberProps(input, Infinity).find(p => p.value?.api?.windsurfSettingsPage?.planInfo)?.value.api;
    if (refresh && api) {
      try { await api.executeCommand('devin.updatePlanInfo'); }
      catch (error) {
        const cached = await readDevinUsage(false);
        if (cached.missing || !cached.limits.some(limit => Number.isFinite(limit.pct))) throw error;
        // Reading the desktop's stored value is not a successful quota refresh.
        delete cached.updated;
        return { ...cached, cached: true, refreshError: String(error.message || error) };
      }
    }
    const info = api?.windsurfSettingsPage?.planInfo?.getPlanInfo();
    if (info) return {
      missing: false, quota: [], plan: info.planName, updated: Date.now(),
      limits: [['每日额度', info.dailyRemainingPercent, info.dailyResetAtUnix, info.hideDailyQuota], ['每周额度', info.weeklyRemainingPercent, info.weeklyResetAtUnix, info.hideWeeklyQuota]]
        .filter(([, , , hidden]) => !hidden)
        .map(([label, pct, reset]) => ({
          label, kind: 'limit', basis: 'remaining', pct: Number.isFinite(pct) ? pct : null,
          reset: Number(reset) ? new Date(Number(reset) * 1000).toLocaleString('zh-CN') : '',
        })),
    };
    const status = document.getElementById('codeium.windsurf.settings.planInfo') || [...doc.querySelectorAll('[aria-label*="quota used"]')].find(a => a.getBoundingClientRect().width > 0);
    const summary = status?.getAttribute('aria-label') || '';
    const sections = [...doc.querySelectorAll('.breakdown-details .quota-section')];
    const section = word => sections.find(s => (s.querySelector('.quota-label')?.textContent || '').trim().startsWith(word));
    const nativeLimits = [...summary.matchAll(/\b(Daily|Weekly):\s*(\d+(?:\.\d+)?)%\s+(?:quota\s+)?(used|left|remaining)/gi)].map(m => ({
      label: /^daily$/i.test(m[1]) ? '每日额度' : '每周额度', kind: 'limit',
      basis: /^used$/i.test(m[3]) ? 'used' : 'remaining', pct: Number(m[2]),
      reset: section(m[1])?.querySelector('.quota-reset-label')?.textContent.trim() || '',
    }));
    if (nativeLimits.length) return { missing: false, quota: [], limits: nativeLimits, updated: Date.now(), plan: summary.split(',')[0], extra: section('Extra')?.querySelector('.quota-value')?.textContent.trim() || '' };
    const text = [...doc.querySelectorAll('p')].map(e => (e.innerText || '').replace(/\s+/g, ' ').trim()).find(t => /usage quota/i.test(t));
    if (!text) return { missing: true, quota: [], limits: [] };
    const reset = (/resets\s+(.+?)\.?$/i.exec(text) || [])[1] || '';
    const limits = [];
    const used = /(\d+)%\s+used/i.exec(text);
    const left = /(\d+)%\s+(?:left|remaining)/i.exec(text);
    if (used) limits.push({ label: '每周额度', kind: 'limit', basis: 'used', pct: Number(used[1]), reset });
    else if (left) limits.push({ label: '每周额度', kind: 'limit', basis: 'remaining', pct: Number(left[1]), reset });
    else if (/exhausted/i.test(text)) limits.push({ label: '每周额度', kind: 'limit', basis: 'used', pct: 100, reset, detail: '包含额度已用完' });
    else limits.push({ label: '每周额度', kind: 'limit', basis: 'used', pct: null, reset, detail: text.slice(0, 160) });
    return { missing: false, quota: [], limits };
  };
  const codexRootProps = () => {
    const el = doc.querySelector('button[aria-label^="Recent chats"]');
    return el ? codexFiberProps(el, Infinity) : [];
  };
  const codexQueryClient = () => codexRootProps().find(p => typeof p.value?.getQueryData === 'function')?.value || null;
  const openCodexThread = async id => {
    if (!codexChatRows(true).some(row => row.id === id)) return false;
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
  const DEVIN_MODES = /^(Code|Smart|Ask|Plan|Bypass Permissions)$/;
  const devinModeChip = () => !devinSurface() ? null : [...document.querySelectorAll('button[aria-haspopup="menu"]')]
    .find(b => vis(b) && b.getBoundingClientRect().y > 120 && DEVIN_MODES.test((b.innerText || '').trim()));
  const devinModeRows = () => [...document.querySelectorAll('[role="menuitem"]')].filter(e => vis(e) && /^(Code|Smart|Ask|Plan|Bypass Permissions)\b/.test((e.innerText || '').trim()))
    .map(e => {
      const lines = (e.innerText || '').split('\n').map(x => x.trim()).filter(Boolean);
      return { el: e, label: lines[0], desc: lines[1] || '', checked: e.querySelectorAll(':scope > svg').length > 1 };
    });
