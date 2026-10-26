// Watch transcript mutations instead of waiting for the next periodic read.
import { cdpRead } from '../cdp.mjs';
import { PAGE_SRC } from '../page/build.mjs';

export async function watchChat(cdp, changed) {
  const name = '__remoteChat' + crypto.randomUUID().replaceAll('-', '');
  let stopped = false;
  const receive = event => { if (!stopped && event.name === name) changed(); };
  try {
  await cdp.send('Runtime.enable');
  await cdp.send('Runtime.addBinding', { name });
  cdp.on('Runtime.bindingCalled', receive);
  await cdp.evaluate(`(() => {
    const name = ${JSON.stringify(name)};
    let doc, native, observer;
    const state = { timer: 0, stop: null };
    const rows = '[data-turn-key], [data-flat-index], [data-message-kind], [data-acp-msg-index], [role="log"][aria-label="Session transcript"], [role="group"][aria-label$="message"], [aria-label^="Preview queued message"], [data-response-annotation-conversation]';
    const capacityRetry = node => {
      const el = node.nodeType === 1 ? node : node.parentElement;
      if (!el) return false;
      let root = el;
      for (let i = 0; root && i < 8; i++, root = root.parentElement) {
        if (/(?:at capacity|容量不足|模型容量)/i.test(root.innerText || '')
          && [...root.querySelectorAll('button, [role=button]')].some(button => /^(Retry|Try(?: again)?|重试|再试一次)$/i.test((button.innerText || button.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()))) return true;
      }
      return false;
    };
    const inTranscript = (node, descendants = false) => {
      const el = node.nodeType === 1 ? node : node.parentElement;
      return !!el && (!!el.closest(rows) || (descendants && !!el.querySelector(rows)));
    };
    const changed = () => {
      doc.defaultView.__remoteAgentChatRevision = (doc.defaultView.__remoteAgentChatRevision || 0) + 1;
      if (!state.timer) state.timer = setTimeout(() => { state.timer = 0; native?.refresh(); window[name](''); }, 250);
    };
    const bind = () => {
      const next = document.getElementById('active-frame')?.contentDocument || document;
      if (next === doc) return;
      observer?.disconnect(); native?.stop();
      doc = next;
      native = (${PAGE_SRC}).watchCodexData(changed);
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
    state.stop = () => { observer?.disconnect(); native?.stop(); outer.disconnect(); document.removeEventListener('load', bind, true); clearTimeout(state.timer); };
    bind();
    window[name + 'Watch'] = state;
  })()`);
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
