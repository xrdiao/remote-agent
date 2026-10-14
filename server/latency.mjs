import { Cdp } from './cdp.mjs';
import { listWindows, codexWindows } from './windows.mjs';
import { CODEX_CDP_URL } from './config.mjs';

// Each response completes a phone -> relay -> native renderer -> phone round trip.
export async function probeLatency(session, message) {
  const pool = session.latencyConnections ||= new Map();
  await Promise.all([...new Set(message.ids || [])].slice(0, 8).map(async id => {
    let owned, key;
    try {
      const side = /^fusion:([ab])$/.exec(id)?.[1];
      const spec = side ? session.fusionRun?.[side] : null;
      if (side && !spec) return session.emit({ t: 'latency', id, requestId: message.requestId, state: 'unconfigured' });
      const app = spec?.app || String(id).split(':')[0];
      if (!['cursor', 'devin', 'codex'].includes(app)) return;
      const windowId = spec?.windowId || (app === 'codex' ? message.codexWindowId : id);
      let cdp = session.app === app && (!windowId || session.windowId === windowId) ? session.cdp : null;
      if (!cdp) {
        key = `${app}|${windowId || ''}`;
        cdp = pool.get(key);
        if (!cdp) {
          let ws = app === 'codex' ? spec?.chatWs : spec?.ws;
          if (!ws && app === 'codex') {
            const pages = await codexWindows(CODEX_CDP_URL, true);
            const page = windowId ? pages.find(p => p.pageId === windowId) : pages[0];
            ws = page?.chatWs;
          } else if (!ws) ws = (await listWindows(null, app)).find(w => w.id === id)?.ws;
          if (!ws) throw new Error('window closed');
          cdp = owned = new Cdp(ws);
          pool.set(key, cdp);
          cdp.onclose = () => { if (pool.get(key) === cdp) pool.delete(key); };
          let timer;
          try {
            cdp.latencyReady = Promise.race([cdp.connect(), new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('CDP 调用超时')), 2500);
            })]);
            await cdp.latencyReady;
          } finally { clearTimeout(timer); }
        }
        await cdp.latencyReady;
      }
      if (session.latencyClosed) { owned?.close(); return; }
      const ready = await cdp.evaluate('document.getElementById("active-frame") ? !!document.getElementById("active-frame").contentDocument?.body : !!document.body', { timeout: 2000 });
      session.emit({ t: 'latency', id, requestId: message.requestId, state: ready ? 'ok' : 'loading' });
    } catch (error) {
      owned?.close();
      if (owned && pool.get(key) === owned) pool.delete(key);
      session.emit({ t: 'latency', id, requestId: message.requestId, state: /超时|timeout/i.test(error.message) ? 'timeout' : 'offline' });
    }
  }));
}

export function closeLatency(session) {
  session.latencyClosed = true;
  for (const cdp of session.latencyConnections?.values() || []) cdp.close();
  session.latencyConnections?.clear();
}
