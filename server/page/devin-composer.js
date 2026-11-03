  // A pending Devin session keeps its prompt in the welcome layer while a file tab is open.
  const revealDevinComposer = () => {
    const groups = [...doc.querySelectorAll('.editor-group-container')];
    for (const group of groups) {
      if (group.classList.contains('has-pending-new-session-welcome')) continue;
      for (const el of group.querySelectorAll('[data-crl-devin-reveal]')) {
        el.style.removeProperty('display');
        el.removeAttribute('data-crl-devin-reveal');
      }
    }
    let shown = false;
    for (const group of groups) {
      if (!group.classList.contains('has-pending-new-session-welcome')) continue;
      const welcome = group.querySelector(':scope > .windsurf-welcome-container');
      const editor = group.querySelector(':scope > .editor-container');
      if (welcome && getComputedStyle(welcome).display === 'none') {
        welcome.style.setProperty('display', 'flex', 'important');
        welcome.setAttribute('data-crl-devin-reveal', '1');
      }
      if (editor && getComputedStyle(editor).display !== 'none') {
        editor.style.setProperty('display', 'none', 'important');
        editor.setAttribute('data-crl-devin-reveal', '1');
      }
      shown = true;
    }
    return shown;
  };
