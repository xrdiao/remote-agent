// Watch transcript mutations instead of waiting for the next periodic read.
export async function watchChat(cdp, changed) {
  const name = '__remoteChat' + crypto.randomUUID().replaceAll('-', '');
  let stopped = false;
  await cdp.send('Runtime.enable');
  await cdp.send('Runtime.addBinding', { name });
  cdp.on('Runtime.bindingCalled', event => {
    if (!stopped && event.name === name) changed();
  });
  await cdp.evaluate(`(() => {
    const name = ${JSON.stringify(name)};
    const doc = document.getElementById('active-frame')?.contentDocument || document;
    const rows = '[data-turn-key], [data-flat-index], [data-message-kind], [data-acp-msg-index], [role="log"][aria-label="Session transcript"], [role="group"][aria-label$="message"]';
    const inTranscript = (node, descendants = false) => {
      const el = node.nodeType === 1 ? node : node.parentElement;
      return !!el && (!!el.closest(rows) || (descendants && !!el.querySelector(rows)));
    };
    const state = { timer: 0, observer: null };
    state.observer = new MutationObserver(records => {
      if (state.timer || !records.some(record => inTranscript(record.target)
        || [...record.addedNodes, ...record.removedNodes].some(node => inTranscript(node, true)))) return;
      state.timer = setTimeout(() => { state.timer = 0; window[name](''); }, 250);
    });
    state.observer.observe(doc.body, { subtree: true, childList: true, characterData: true });
    window[name + 'Watch'] = state;
  })()`);
  return () => {
    stopped = true;
    return cdp.evaluate(`(() => {
      const key = ${JSON.stringify(name + 'Watch')}, state = window[key];
      if (state) { state.observer.disconnect(); clearTimeout(state.timer); delete window[key]; }
    })()`).then(() => cdp.send('Runtime.removeBinding', { name })).catch(() => {});
  };
}
