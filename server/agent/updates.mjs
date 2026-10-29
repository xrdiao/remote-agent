// Watch transcript mutations instead of waiting for the next periodic read.
import { cdpRead } from '../cdp.mjs';
import { PAGE_SRC } from '../page/build.mjs';

export async function watchChat(cdp, changed, shared = false) {
  const name = '__remoteChat' + crypto.randomUUID().replaceAll('-', '');
  let stopped = false;
  const receive = event => { if (!stopped && event.name === name) changed(); };
  try {
  await cdp.send('Runtime.enable');
  await cdp.send('Runtime.addBinding', { name });
  cdp.on('Runtime.bindingCalled', receive);
  const removed = await cdp.evaluate(`(() => {
    const name = ${JSON.stringify(name)};
    const removed = [];
    if (${shared}) {
      for (const key of Object.keys(window)) {
        if (/^__remoteChat[0-9a-f]+Watch$/.test(key)) { window[key].stop(); delete window[key]; }
        else if (/^__remoteChat[0-9a-f]+$/.test(key) && key !== name) { removed.push(key); delete window[key]; }
      }
    }
    let doc, native, observer;
    const state = { timer: 0, stop: null };
    const rows = '[data-turn-key], [data-flat-index], [data-message-kind], [data-acp-msg-index], [role="log"][aria-label="Session transcript"], [role="group"][aria-label$="message"], [aria-label^="Preview queued message"], [data-response-annotation-conversation]';
    const capacityRetry = node => {
      const el = node.nodeType === 1 ? node : node.parentElement;
      if (!el) return false;
      if (el.closest('.ProseMirror, [class*="MarkdownRoot"], [class*="user-message"], pre, code')) return false;
      for (let root = el, i = 0; root && i < 8; i++, root = root.parentElement)
        if (/^\s*(?:(?:The\s+)?(?:selected\s+)?model\s+is\s+at\s+capacity\b|(?:所选|选定|当前)模型.*(?:容量不足|模型容量))/i.test(root.innerText || '')) return true;
      return false;
    };
    const inTranscript = (node, descendants = false) => {
      const el = node.nodeType === 1 ? node : node.parentElement;
      return !!el && (!!el.closest(rows) || (descendants && !!el.querySelector(rows)));
    };
    const changed = () => {
      doc.defaultView.__remoteAgentChatRevision = (doc.defaultView.__remoteAgentChatRevision || 0) + 1;
      if (!state.timer) state.timer = setTimeout(() => {
        state.timer = 0;
        native?.refresh();
        doc.defaultView.dispatchEvent(new doc.defaultView.Event('remote-agent-chat-update'));
        window[name]('');
      }, 250);
    };
    const bind = () => {
      const next = document.getElementById('active-frame')?.contentDocument || document;
      if (next === doc) return;
      doc?.defaultView.removeEventListener('remote-agent-submit-error', changed);
      observer?.disconnect(); native?.stop();
      doc = next;
      doc.defaultView.addEventListener('remote-agent-submit-error', changed);
      if (window.vscode?.context?.configuration?.().product?.applicationName === 'devin-desktop') {
        native = { stop: window.__acpStore.subscribe(changed), refresh() {} };
      } else native = (${PAGE_SRC}).watchCodexData(changed);
      observer = new MutationObserver(records => {
        if (records.some(record => inTranscript(record.target) || capacityRetry(record.target)
          || [...record.addedNodes, ...record.removedNodes].some(node => inTranscript(node, true) || capacityRetry(node)))) changed();
      });
      observer.observe(doc.body, { subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['data-turn-key', 'data-active', 'data-response-annotation-conversation', 'aria-expanded', 'aria-disabled', 'disabled'] });
      changed();
    };
    const outer = new MutationObserver(bind);
    outer.observe(document.body, { subtree: true, childList: true });
    document.addEventListener('load', bind, true);
    state.stop = () => { doc?.defaultView.removeEventListener('remote-agent-submit-error', changed); observer?.disconnect(); native?.stop(); outer.disconnect(); document.removeEventListener('load', bind, true); clearTimeout(state.timer); };
    bind();
    window[name + 'Watch'] = state;
    return removed;
  })()`);
  await Promise.all(removed.map(name => cdp.send('Runtime.removeBinding', { name })));
  } catch (error) {
    cdpRead.run(null, stop);
    throw error;
  }
  return stop;
  function stop() {
    stopped = true;
    if (cdp.handlers.get('Runtime.bindingCalled') === receive) cdp.handlers.delete('Runtime.bindingCalled');
    return cdp.evaluate(`(() => {
      const key = ${JSON.stringify(name + 'Watch')}, state = window[key];
      if (state) { state.stop(); delete window[key]; }
    })()`).then(() => cdp.send('Runtime.removeBinding', { name })).catch(() => {});
  }
}
