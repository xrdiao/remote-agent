import { Cdp } from '../cdp.mjs';
import { EDITORS } from '../config.mjs';
import { listWindows, codexWindows } from '../windows.mjs';
import { helpersCall } from '../page/build.mjs';

// An independent diagnostic connection never attaches, focuses or changes a session.
export async function inspectCompatibility(app, windowId = '') {
  const editor = EDITORS.find(entry => entry.app === app);
  if (!editor) return { state: 'unknown', reason: 'unsupported-app' };
  let host, chat;
  try {
    const windows = app === 'codex'
      ? await codexWindows(editor.url)
      : (await listWindows(null, app)).filter(win => win.app === app);
    const target = windowId ? windows.find(win => (win.pageId || win.id) === windowId) : windows[0];
    if (!target) return { state: 'pending', reason: 'window-unavailable' };
    host = new Cdp(target.ws);
    await host.connect(3000);
    const expression = helpersCall(`agentCompatibility(${JSON.stringify(app)})`);
    const data = await host.evaluate(expression, { timeout: 5000 });
    if (app === 'codex' && target.chatWs) {
      chat = new Cdp(target.chatWs);
      await chat.connect(3000);
      const view = await chat.evaluate(expression, { timeout: 5000 });
      data.features = view.features;
      data.versions.extension = view.versions.extension;
    }
    return { ...data, windowId: target.pageId || target.id };
  } catch {
    return { state: 'unknown', reason: 'read-failed' };
  } finally { chat?.close(); host?.close(); }
}
