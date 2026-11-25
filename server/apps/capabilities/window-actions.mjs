import { helpersCall } from '../../page/build.mjs';
import { nativeWindow } from '../../native-windows.mjs';

export const windowQueue = {
  read(m) { return this.queuedText(m.id); },
  edit(m) { return this.editQueued(m.id, String(m.text ?? '')); },
  send(m) { return this.queueAction(m.id, 'send'); },
  remove(m) { return this.queueAction(m.id, 'remove'); },
};

async function stopFromComposer(context, cdp, scope) {
  await context.assertSelectedThread();
  if (cdp !== context.cdp || scope !== context.selectionKey()) return;
  const clicked = await cdp.evaluate(helpersCall('stopTarget(true)'));
  if (cdp === context.cdp && scope === context.selectionKey())
    context.emit({ t: 'status', msg: clicked ? '已点击停止' : '当前没有停止按钮' });
}

export async function stopComposer(message) {
  const cdp = this.cdp, scope = this.selectionKey();
  if (message.sel && message.sel !== scope) return;
  await nativeWindow(cdp)?.stopRetry();
  return stopFromComposer(this, cdp, scope);
}

// Cursor and Devin expose a thread-addressed native operation once a thread exists.
export async function stopWindowThread(message) {
  const cdp = this.cdp, scope = this.selectionKey(), app = this.app, thread = this.threadId;
  if (message.sel && message.sel !== scope) return;
  await nativeWindow(cdp)?.stopRetry();
  if (!thread) return stopFromComposer(this, cdp, scope);
  await cdp.evaluate(helpersCall(`nativeSessionAction(${JSON.stringify(app)}, ${JSON.stringify(thread)}, 'stop')`));
  if (cdp === this.cdp && scope === this.selectionKey()) this.pollChat(true).catch(() => {});
}

export async function answerComposerQuestion(qi, oi, part, text) {
  await this.assertSelectedThread();
  const pos = await this.cdp.evaluate(helpersCall(`questionTarget(${Number(qi) || 0}, ${Number(oi) || 0}, ${JSON.stringify(part)})`));
  if (!pos) throw new Error('这个问题已经不在了（可能已在电脑上回答）');
  await this.tapCss(pos.x, pos.y);
  if (part === 'option' && typeof text === 'string') {
    await new Promise(r => setTimeout(r, 150));
    await this.cdp.evaluate('document.activeElement?.select?.()');
    if (text) await this.typeText(text);
    else await this.key('Backspace');
  }
  this.refreshSoon(300);
}
