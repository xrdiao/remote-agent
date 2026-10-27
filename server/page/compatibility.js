  // Read-only metadata: no menu opening, composer reveal, focus or native actions.
  const agentCompatibility = app => {
    const p = window.vscode?.context?.configuration?.()?.product;
    const versions = {
      application: app === 'devin' ? p?.windsurfVersion || null : app === 'cursor' ? p?.cursorVersion || p?.version || null : p?.version || null,
      base: app === 'devin' || p?.cursorVersion ? p?.version || null : null,
      extension: null,
    };
    if (app === 'codex') {
      for (const el of doc.querySelectorAll('script[src], link[href]')) {
        const url = decodeURIComponent(el.src || el.href || '');
        const folder = /openai\.chatgpt-(\d+\.\d+\.\d+[^/\\]*)/.exec(url)?.[1];
        if (folder) { versions.extension = folder.replace(/-(?:win32|linux|darwin)-[\w-]+$/, ''); break; }
      }
    }
    const input = [...doc.querySelectorAll('[contenteditable="true"]')].some(el => vis(el) && !el.closest('.monaco-editor, [aria-label="User message"], [aria-label="Devin message"]'));
    const models = app === 'devin' ? devinPickerProps(true) : app === 'codex' ? codexPickerProps() : cursorPickerProps(true);
    const options = app === 'devin' ? models?.visibleModelConfigs : app === 'codex' ? models?.modelOptions : models?.models;
    const rows = app === 'codex' ? codexChatRows(true) : agentList();
    const valid = rows.filter(row => typeof row.id === 'string' && row.id.length);
    const features = {
      input: { state: input ? 'identified' : 'pending' },
      models: { state: options?.length ? 'identified' : input ? 'unknown' : 'pending' },
      sessions: { state: rows.length ? valid.length === rows.length ? 'identified' : 'unknown' : 'pending' },
    };
    return { versions, state: 'checked', features };
  };
