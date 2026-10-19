import { MOD, NAMED_KEYS } from '../cdp.mjs';
import { EDITORS } from '../config.mjs';
import { helpersCall } from '../page/build.mjs';

// Cursor's chat composer is a ProseMirror contenteditable; selectors ordered from most to least specific.
export const FOCUS_COMPOSER = `(() => {
  // Codex draws its prompt inside a same-origin iframe. Cursor and Devin use this page.
  const doc = document.getElementById('active-frame')?.contentDocument || document;
  // Same reveal as pageHelpers.revealDevinComposer: a new Devin session's prompt
  // stays in a hidden welcome layer while a file tab is open.
  for (const group of doc.querySelectorAll('.editor-group-container')) {
    if (group.classList.contains('has-pending-new-session-welcome')) continue;
    for (const el of group.querySelectorAll('[data-crl-devin-reveal]')) {
      el.style.removeProperty('display');
      el.removeAttribute('data-crl-devin-reveal');
    }
  }
  for (const group of doc.querySelectorAll('.editor-group-container.has-pending-new-session-welcome')) {
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
  }
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const selectors = ['.aislash-editor-input[contenteditable="true"]', '.ui-prompt-input-editor__input[contenteditable="true"]', '.ProseMirror[contenteditable="true"]', '.composer-bar [contenteditable="true"]', '.auxiliarybar [contenteditable="true"]'];
  let eds = [];
  for (const s of selectors) { eds = [...doc.querySelectorAll(s)].filter(visible); if (eds.length) break; }
  if (!eds.length) eds = [...doc.querySelectorAll('[contenteditable="true"]')].filter(e => visible(e) && !e.closest('.monaco-editor, [aria-label="User message"], [aria-label="Devin message"]'));
  if (!eds.length) return null;
  const selId = doc.querySelector('[data-sidebar-item-key] [data-active="true"]')?.closest('[data-sidebar-item-key]')?.getAttribute('data-sidebar-item-key')?.slice(4);
  const el = eds.find(e => e.contains(doc.activeElement)) || (selId && eds.find(e => e.closest('[data-glass-agent-id]')?.getAttribute('data-glass-agent-id') === selId)) || eds[eds.length - 1];
  el.focus();
  const range = doc.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = doc.defaultView.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
})()`;


export const uploads = new Map();
export const codexUsage = { data: null, refresh: null, retryAt: 0, failures: 0 };
export const cursorUsage = { data: null, initial: null };
export const appPlans = {};

const tapPoint = async (cdp, x, y) => {
  const base = { x, y, button: 'left', clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
};
export class AgentContext {
  constructor({ deviceId = '', emit } = {}) {
    this.deviceId = deviceId;
    if (emit) this.emit = emit;
    this.cdp = null;
    this.editorCdp = null;
    this.lastChat = '';
    this.lastExtractedChat = '';
    this.pollAgain = null;
    this.resetCaches();
    this.curSession = undefined;
    this.app = null;
    this.sel = 0;
    this.windowId = '';
    this.threadId = '';
    this.pendingThread = '';
    this.codexPageId = '';
    this.lastPanel = '';
    this.lastBusy = null;
    this.lastTermHash = undefined;
    this.focusCount = 0;
    this.focusTimer = null;
  }



  emit() {}

  resetCaches() {
    this.thinking = new Map();
    this.thinkingTried = new Map();
    this.tasksTried = new Map();
    this.devinHist = new Map();
    this.thoughtFails = new Map();
    this.keptThink = new Map();
    this.itemCache = new Map();
    this.thinkLiveSeen = new Set();
    this.thinkFinal = new Set();
  }



  appMessage(template) {
    if (this.app === 'fusion') return template.replaceAll('{app}', 'Fusion');
    const name = EDITORS.find(ed => ed.app === this.app)?.name || '当前应用';
    return template.replaceAll('{app}', name);
  }

  selectionKey() {
    return [this.app || '', this.windowId || '', this.threadId || ''].join('|');
  }

  clearViewState() {
    this.sel = (this.sel || 0) + 1;
    this.lastChat = '';
    this.lastExtractedChat = '';
    this.pollAgain = null;
    this.lastAttachments = null;
    this.latestThink = null;
    this.thinkTries = new Map();
    this.thinking = new Map();
    this.thinkingTried = new Map();
    this.keptThink = new Map();
    this.itemCache = new Map();
    this.thinkLiveSeen = new Set();
    this.thinkFinal = new Set();
    this.pendingThread = '';
    this.polling = null;
    this.lastDraft = undefined;
  }

  liveRead(cdp, sel) {
    return cdp && cdp === this.cdp && sel === this.sel && !this.switchingThread;
  }

  async waitFor(call, tries = 10) {
    for (let i = 0; i < tries; i++) {
      await new Promise(r => setTimeout(r, 120));
      const v = await this.cdp.evaluate(helpersCall(call));
      if (v) return v;
    }
    return null;
  }



  // Focus emulation breaks real typing while it is on, so it only wraps phone-driven
  // actions that type/tap, and is switched off again shortly after they finish.
  async withFocus(fn) {
    this.focusCount++;
    const connections = [...new Set([this.cdp, this.editorCdp].filter(Boolean))];
    if (this.focusCount === 1) {
      clearTimeout(this.focusTimer);
      this.focusTimer = null;
      for (const c of connections) await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    }
    try { return await fn(); }
    finally {
      this.focusCount = Math.max(0, this.focusCount - 1);
      if (!this.focusCount && !this.focusTimer) {
        this.focusTimer = setTimeout(() => {
          this.focusTimer = null;
          for (const c of connections) c.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
        }, 1500);
      }
    }
  }

  async tapCss(x, y, button = 'left', cdp = this.cdp) {
    const base = { x, y, button, clickCount: 1 };
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  }

  async key(combo, opts = {}) {
    const cdp = opts.focusTerminal ? this.editorCdp : (opts.cdp || this.cdp);
    if (opts.focusTerminal) await this.focusTerminal();
    const recall = opts.focusTerminal && (combo === 'ArrowUp' || combo === 'ArrowDown');
    const before = recall ? await cdp.evaluate(helpersCall('terminalCommand()')) : undefined;
    const parts = combo.split('+');
    const name = parts.pop();
    const modifiers = parts.reduce((m, p) => m | (MOD[p] || 0), 0);
    let spec = NAMED_KEYS[name];
    if (!spec && name.length === 1) {
      const up = name.toUpperCase();
      spec = { code: /[A-Z]/.test(up) ? `Key${up}` : /\d/.test(up) ? `Digit${up}` : '', vk: up.charCodeAt(0), text: name };
    }
    if (!spec) throw new Error(`未知按键: ${combo}`);
    const withText = spec.text && !(modifiers & (MOD.Ctrl | MOD.Meta));
    const ev = { key: name, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, modifiers };
    await cdp.send('Input.dispatchKeyEvent', { type: withText ? 'keyDown' : 'rawKeyDown', ...ev, ...(withText ? { text: spec.text } : {}) });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
    if (!recall) return;
    let cmd = before;
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 40));
      const next = await cdp.evaluate(helpersCall('terminalCommand()'));
      if (typeof next === 'string' && next !== before) { cmd = next; break; }
      if (i === 7 && typeof next === 'string') cmd = next;
    }
    if (typeof cmd === 'string') this.emit({ t: 'termInput', text: cmd });
  }

  async typeText(text, cdp = this.cdp) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await this.key('Shift+Enter', { cdp });
      if (lines[i]) await cdp.send('Input.insertText', { text: lines[i] });
    }
  }

  async clickButton(item, n, actionId, label, sel) {
    try {
    if (sel != null && sel !== this.selectionKey()) throw new Error('会话已切换，请使用当前会话的按钮');
    const pos = await this.cdp.evaluate(helpersCall(`locate(${JSON.stringify(String(item))}, ${Number(n) || 0}, ${JSON.stringify(actionId || '')}, ${JSON.stringify(label || '')})`));
    if (!pos) { await this.pollChat(true); throw new Error('请求已更新，请查看最新选项'); }
    await this.tapCss(pos.x, pos.y);
    await new Promise(r => setTimeout(r, 200));
    await this.pollChat(true);
    } finally { this.emit({ t: 'clickDone', item, actionId, sel }); }
  }
  }
