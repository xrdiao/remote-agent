  const composerInputs = doc => {
    const composer = el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility === 'visible'
        && !el.closest('[data-flat-index], [data-message-index], [data-message-kind], [data-turn-key], [data-transcript-row-key], [role=group][data-side], [aria-label="User message"], [aria-label="Devin message"]');
    };
    for (const selector of ['.aislash-editor-input[contenteditable="true"]', '.ui-prompt-input-editor__input[contenteditable="true"]', '.ProseMirror[contenteditable="true"]', '.composer-bar [contenteditable="true"]', '.auxiliarybar [contenteditable="true"]']) {
      const editors = [...doc.querySelectorAll(selector)].filter(composer);
      if (editors.length) return editors;
    }
    return [...doc.querySelectorAll('[contenteditable="true"]')].filter(el => composer(el) && !el.closest('.monaco-editor'));
  };
  const chooseComposer = (doc, editors) => {
    const selected = doc.querySelector('[data-sidebar-item-key] [data-active="true"]')?.closest('[data-sidebar-item-key]')?.getAttribute('data-sidebar-item-key')?.slice(4);
    return editors.find(el => el.contains(doc.activeElement))
      || (selected && editors.find(el => el.closest('[data-glass-agent-id]')?.getAttribute('data-glass-agent-id') === selected))
      || editors.at(-1);
  };
  const composerTarget = doc => chooseComposer(doc, composerInputs(doc));
