  /* ---------- Devin transcript rows ---------- */

  const devinLog = () => {
    const selected = devinSurface() === 'agent' ? agentList().find(a => a.current)?.id : devinTabs().find(t => t.active)?.id;
    const log = [...doc.querySelectorAll('[role="log"][aria-label="Session transcript"]')].find(e => vis(e) && (!selected || devinNodeSessionId(e) === selected));
    if (log) return log;
    const current = selected || '';
    return [...doc.querySelectorAll('[data-chat-history-variant]')].find(e => vis(e)
      && (!current || devinNodeSessionId(e.querySelector('[data-transcript-row-key]') || e) === current));
  };

  // Event-group tool rows: "Searched<query>", "Explored<file> and searched <q>", "Read<file> #L…".
  const devinEventTool = (eg, i, lines) => {
    const title = lines[0] || '';
    const m = /^([A-Z][a-z]+)/.exec(title);
    const label = m ? m[1] : '';
    const kind = /^searched/i.test(label) ? 'search' : /^explored/i.test(label) ? 'explore' : /^read/i.test(label) ? 'read' : 'other';
    const rest = title.slice(label.length);
    const t = `${label} ${[rest, ...lines.slice(1)].join(' · ')}`.replace(/\s+/g, ' ').trim();
    const codes = [...eg.querySelectorAll('code')].map(c => (c.innerText || '').trim()).filter(Boolean).slice(0, 6);
    const item = { i, k: 'tool', kind, t, chips: codes.map(c => c.replace(/\n/g, ' ').slice(0, 120)) };
    item.chipFiles = codes.map(c => {
      const file = c.split(/\n|\s+#L/)[0].trim();
      const line = /#L(\d+)/.exec(c)?.[1];
      return /\.[A-Za-z0-9]{1,10}$/.test(file) || /^[A-Za-z]:[\\/]|^\//.test(file)
        ? file + (line ? ':' + line : '') : '';
    });
    const fileish = codes.map(c => c.split('\n')[0].trim())
      .filter(c => /\.[A-Za-z0-9]{1,10}$/.test(c) || /^[A-Za-z]:[\\/]|^\//.test(c));
    if (fileish.length === 1) {
      item.f = fileish[0];
      const code = codes.find(c => c.startsWith(fileish[0]));
      const r = /(#L[\d,\-]+)/.exec(code || '');
      if (r) item.r = r[1];
    }
    return item;
  };

  // "Command <what> in <dir>" rows: medium title, optional "30s" duration, then the command text.
  const devinCommand = (row, i) => {
    const med = row.querySelector('span.codeium-text-medium');
    const t = (med?.innerText || '').trim();
    if (!t || !/^command\b/i.test(t)) return null;
    const rest = (row.innerText || '').split('\n').slice(1);
    let d = '';
    if (rest.length && /^\d+\s*[smh]\b/i.test(rest[0].trim())) d = rest.shift().trim();
    const props = codexFiberProps(med, 16);
    const command = props.find(p => typeof p.commandLine === 'string');
    const output = props.find(p => Array.isArray(p.outputs));
    return { i, k: 'tool', kind: 'command', t, d,
      cmd: (command?.commandLine || row.querySelector('.terminal-text .monaco-tokenized-source')?.textContent || '').trim(),
      output: (output?.outputs.map(o => o.full || '').join('\n') || row.querySelector('pre')?.innerText || rest.join('\n')).trim().slice(0, 4000) };
  };

  const setCommandOpen = (id, open) => {
    const row = [...(devinLog()?.children || [])].find(r => itemKey(r) === id);
    const btn = row?.querySelector('button[aria-expanded], .command-card .group\\/header');
    if (!btn) return null;
    const previous = btn.getAttribute('aria-expanded') === 'true' || !!btn.querySelector('.lucide-chevron-down');
    if (previous !== open) btn.click();
    return previous;
  };

  // "N / M tasks done" rows (Devin's todo list). The counts are always there; the checklist
  // items only exist while the row is expanded (see setTasksOpen).
  const devinTasks = (row, i) => {
    const sp = [...row.querySelectorAll('span')].find(s => /^\d+\s*\/\s*\d+\s+tasks?\s+done$/.test((s.innerText || '').trim()));
    if (!sp) return null;
    const m = /^(\d+)\s*\/\s*(\d+)/.exec(sp.innerText.trim());
    const rowsEl = [...row.querySelectorAll('div.flex.items-start')].filter(r => r.querySelector('span.block'));
    const items = rowsEl.map(r => ({
      t: (r.querySelector('span.block')?.innerText || '').trim().slice(0, 300),
      status: r.querySelector('.animate-spin') ? 'in_progress' : r.querySelector('svg.text-text-green') ? 'done' : 'pending',
    })).filter(x => x.t);
    return { i, k: 'tasks', done: Number(m[1]), total: Number(m[2]), ...(rowsEl.length ? { items } : {}) };
  };
  // Expands or folds a tasks row by its acp id (the chevron button only; caller restores).
  const setTasksOpen = (id, open) => {
    const row = [...(devinLog()?.children || [])].find(r => itemKey(r) === id);
    const btn = row?.querySelector('button[aria-expanded]');
    if (!btn) return null;
    const previous = btn.getAttribute('aria-expanded') === 'true';
    if (previous !== open) btn.click();
    return previous;
  };

  // Latest todo list of the Devin session (the phone's task notification); current = the item being worked on.
  const devinTaskState = () => {
    for (const row of [...(devinLog()?.children || [])].slice(-40).reverse()) {
      if (!/tasks? done/.test(row.textContent)) continue;
      const t = devinTasks(row, '');
      if (t) return { done: t.done, total: t.total, current: t.items?.find(x => x.status === 'in_progress')?.t || '' };
    }
    return null;
  };

  // File-edit rows: medium file name, +N/-N counters, then a .diff-code-block of line divs.
  const devinEdit = (row, i) => {
    const block = row.querySelector('.diff-code-block');
    const med = row.querySelector('span.codeium-text-medium');
    if (!block || !med) return null;
    const diff = [...block.children].map(d => {
      const c = String(d.className || '');
      const type = /insert/.test(c) ? '+' : /delete/.test(c) ? '-' : ' ';
      return [type, (d.innerText || '').replace(/\n+$/, '')];
    }).filter(l => l[1] !== '');
    const over = diff.length > 200;
    const nums = [...row.querySelectorAll('span')].map(s => (s.textContent || '').trim());
    const num = re => Number((nums.find(t => re.test(t)) || '').slice(1)) || 0;
    const props = codexFiberProps(med, 16);
    const file = props.find(p => typeof p.fileUri === 'string');
    const tool = props.find(p => p.toolCall?.rawInput?.file_path)?.toolCall;
    const item = { i, k: 'tool', kind: 'edit', f: file?.fileUri || tool?.rawInput.file_path || med.innerText.trim(), add: num(/^\+\d+$/), del: num(/^[-−]\d+$/), diff: over ? diff.slice(0, 200) : diff };
    if (over) item.diff.push(['…', `… 省略 ${diff.length - 200} 行`]);
    return item;
  };

  const devinMessageMeta = msg => codexFiberProps(msg, 12)
    .find(p => Array.isArray(p.content) && p.content[0]?._meta)?.content[0]._meta || {};
  const devinMessageTime = (msg, meta = devinMessageMeta(msg)) => {
    const at = Date.parse(meta['cognition.ai/timestamp'] || codexFiberProps(msg, 12).find(p => p.item?.timestamp)?.item.timestamp || '');
    return Number.isFinite(at) ? at : null;
  };
  const devinNativeItems = (item, i) => {
    if (item.event_type === 'collapsed_work') return item.children.flatMap(child => devinNativeItems(child, `${i}:${child.id}`) || []);
    if (item.event_type === 'devin_thoughts') return [{ i: `${i}:think`, k: 'thinking', t: `Thoughts\n${item.message || ''}` }];
    if (item.event_type === 'shell_command') return [{ i, k: 'tool', kind: 'command', t: item.command,
      cmd: item.command, output: (item.output || '').slice(0, 4000), execution: true,
      ...(item.state === 'running' ? { live: true } : {}), ...(item.state === 'error' ? { keep: true } : {}) }];
    if (item.event_type === 'acp_generic_tool_call') return [{ i, k: 'tool', kind: 'other',
      t: item.state === 'running' ? item.running_title || item.title : item.title || item.tool_name,
      cmd: item.hide_arguments ? '' : item.arguments_json || '', execution: true,
      ...(item.state === 'running' ? { live: true } : {}), ...(item.state === 'error' ? { keep: true } : {}) }];
    return null;
  };
  // Iterate the Devin transcript's direct children in order: messages, thought groups,
  // tool event rows, commands and file edits all become items. Unknown rows are skipped.
  const devinItems = (log, page) => withDevinTranscriptRead(() => {
    const rows = devinTranscriptRows(log);
    const visibility = new Map();
    const visible = row => {
      if (!visibility.has(row)) visibility.set(row, vis(row));
      return visibility.get(row);
    };
    const byId = page && new Map(page.items.map(item => [item.i, item]));
    // Only fallback thought cards need to know the last rendered text row.
    let last, lastRead = false;
    const isLast = row => {
      if (!lastRead) {
        last = [...rows].reverse().find(r => visible(r) && (r.innerText || '').trim());
        lastRead = true;
      }
      return last === row;
    };
    const items = [];
    rows.forEach((row, n) => {
      const i = itemKey(row) || `acpx${n}`;
      const native = row.hasAttribute('data-transcript-row-key') ? codexFiberProps(row, 8).find(p => p.row)?.row?.item : null;
      const nativeItems = native && devinNativeItems(native, i);
      if (nativeItems) {
        if ((!byId || nativeItems.some(item => byId.has(item.i) || item.kind === 'error')) && visible(row))
          items.push(...nativeItems);
        return;
      }
      const msg = row.querySelector('[role=group][aria-label="User message"], [role=group][aria-label="Devin message"]');
      if (msg) {
        const key = itemKey(msg) || i;
        if (byId && !byId.has(key) || !visible(row)) return;
        const it = messageItem(msg, byId?.get(key), key);
        if (it.k === 'human' && native?.event_type === 'user_message') {
          if (native.kind === 'question_answers')
            it.t = native.answers.map(answer => `问题：${answer.question}\n回复：${answer.selected_options.join('、')}`).join('\n\n');
          else if (typeof native.message === 'string') it.t = native.message;
        }
        const meta = it.k === 'human' ? devinMessageMeta(msg) : {};
        if (meta['cognition.ai/isOptimistic']) return;
        if (!it.i) it.i = i;
        if (it.k === 'human' && !it.sentAt) {
          const at = devinMessageTime(msg, meta);
          if (Number.isFinite(at)) it.sentAt = at;
        }
        items.push(it);
        return;
      }
      if (byId && !byId.has(i) && !byId.has(i + ':think') || !visible(row)) return;
      const tasks = devinTasks(row, i);
      if (tasks) { items.push(tasks); return; }
      const cmd = devinCommand(row, i);
      if (cmd) { items.push(cmd); return; }
      const eg = row.classList.contains('event-group') ? row : row.querySelector('.event-group');
      if (eg) {
        const lines = (eg.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
        const title = lines[0] || '';
        if (/^(thoughts?|thinking)\b/i.test(title)) {
          const body = lines.slice(1).join('\n');
          const it = { i: `${i}:think`, k: 'thinking', t: body ? `${title}\n${body}` : title };
          if (isLast(row) && !/\d/.test(title)) it.live = true;
          items.push(it);
          return;
        }
        items.push(devinEventTool(eg, i, lines));
        return;
      }
      const edit = devinEdit(row, i);
      if (edit) { items.push(edit); return; }
    });
    const thread = devinNodeSessionId(log) || activeThread();
    if (devinSessionRecord(thread)?.status === 'unknown_error') {
      const banner = [...doc.querySelectorAll('[data-slot="banner-icon"]')].map(icon => icon.parentElement)
        .find(el => vis(el) && devinNodeSessionId(el) === thread);
      const error = banner && codexFiberProps(banner, 12).find(p => p.variant === 'warning' && typeof p.children === 'string');
      const lastVisible = error && rows.findLast(visible);
      if (error) items.push({ i: `acp${lastVisible ? devinTranscriptIndex(lastVisible) ?? 0 : 0}:error`, k: 'tool', kind: 'error', t: error.children, keep: true });
    }
    if (page) {
      // ACP defines page membership. A mounted row can add desktop-only details for the same item.
      const mounted = new Map(items.map(item => [item.i, item]));
      const records = page.items.map(item => {
        const row = mounted.get(item.i);
        if (row?.k !== item.k) return item;
        if (item.k === 'tool') return { ...row, ...item, cmd: item.cmd || row.cmd, output: item.output || row.output };
        if (item.k === 'thinking') return { ...row, ...item };
        if (item.k === 'human' || item.k === 'assistant') return { ...item, ...row, t: item.t, images: item.images || row.images };
        return item;
      });
      return [...records, ...items.filter(item => item.kind === 'error').map(item => ({ ...item, src: 'devin' }))];
    }
    const messages = devinMessages(thread);
    const insertAtEvent = (index, item) => {
      const next = items.findIndex(row => Number(/^acp(\d+)/.exec(row.i)?.[1]) > index);
      items.splice(next < 0 ? items.length : next, 0, item);
    };
    messages.forEach((message, index) => {
      if (message.kind !== 'plan' && message.kind !== 'subagent') return;
      const [item] = devinMessageItems([message], 'acp', index);
      const mounted = items.findIndex(row => row.i === item.i && row.k === item.k);
      if (mounted < 0) insertAtEvent(index, item);
      else items[mounted] = { ...items[mounted], ...item };
    });
    for (const item of items) if (item.k === 'human' && !item.images?.length) {
      const index = /^acp(\d+)$/.exec(item.i)?.[1];
      const message = messages[index];
      if (message?.kind !== 'user_message' || message.content?.some(block => block._meta?.['cognition.ai/isOptimistic'])) continue;
      const images = devinMessageImages(message);
      if (images.length) item.images = images;
    }
    // A pure image need not have a mounted user bubble in the desktop transcript.
    const latestUser = messages.findLastIndex(message => message.kind === 'user_message');
    const latest = messages[latestUser], latestId = `acp${latestUser}`;
    if (latest && !devinMessageText(latest.content) && !items.some(item => item.i === latestId)) {
      const [photo] = devinMessageItems([latest], 'acp', latestUser);
      if (photo?.images?.length) insertAtEvent(latestUser, photo);
    }
    return items.filter(Boolean).map(it => ({ ...it, src: 'devin' }));
  });
