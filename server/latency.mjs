import { Cdp } from './cdp.mjs';
import { listWindows, codexViewIds } from './windows.mjs';
import { CODEX_CDP_URL } from './config.mjs';

// Each response completes a phone -> relay -> native renderer -> phone round trip.
export async function probeLatency(session, message) {
  await Promise.all([...new Set(message.ids || [])].slice(0, 8).map(async id => {
    let owned;
    try {
      const side = /^fusion:([ab])$/.exec(id)?.[1];
      const spec = side ? session.fusionRun?.[side] : null;
      if (side && !spec) return session.emit({ t: 'latency', id, requestId: message.requestId, state: 'unconfigured' });
      const app = spec?.app || String(id).split(':')[0];
      if (!['cursor', 'devin', 'codex'].includes(app)) return;
      const windowId = spec?.windowId || (app === 'codex' ? message.codexWindowId : id);
      let cdp = session.app === app && (!windowId || session.windowId === windowId) ? session.cdp : null;
      try {
        if (!cdp) {
          let ws = app === 'codex' ? spec?.chatWs : spec?.ws;
          if (!ws && app === 'codex') {
            // Only probe Codex pages whose webview key is already known; discovering it
            // would open a CDP connection per page just for a latency badge.
            if (windowId && codexViewIds.has(windowId)) {
              const targets = await (await fetch(`${CODEX_CDP_URL}/json/list`, { signal: AbortSignal.timeout(1500) })).json();
              const key = codexViewIds.get(windowId);
              ws = targets.find(t => t.webSocketDebuggerUrl && /extensionId=openai\.chatgpt/.test(t.url || '') && /purpose=webviewView/.test(t.url || '') && /[?&]id=([^&]+)/.exec(t.url || '')?.[1] === key)?.webSocketDebuggerUrl;
            }
            if (!ws) return session.emit({ t: 'latency', id, requestId: message.requestId, state: 'unknown' });
          } else if (!ws) ws = (await listWindows(null, app)).find(w => w.id === id)?.ws;
          if (!ws) throw new Error('window closed');
          cdp = owned = new Cdp(ws);
          let timer;
          try {
            await Promise.race([cdp.connect(), new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('CDP 调用超时')), 2500);
            })]);
          } finally { clearTimeout(timer); }
        }
        const ready = await cdp.evaluate('document.getElementById("active-frame") ? !!document.getElementById("active-frame").contentDocument?.body : !!document.body', { timeout: 2000 });
        session.emit({ t: 'latency', id, requestId: message.requestId, state: ready ? 'ok' : 'loading' });
      } finally { owned?.close(); }
    } catch (error) {
      session.emit({ t: 'latency', id, requestId: message.requestId, state: /超时|timeout/i.test(error.message) ? 'timeout' : 'offline' });
    }
  }));
}
