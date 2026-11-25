import { randomUUID } from 'node:crypto';
import { answerComposerQuestion, stopWindowThread, windowQueue } from './capabilities/window-actions.mjs';
import { cdpRead } from '../cdp.mjs';
import { changeDesktopFiles, desktopUsageContext, showDesktopSettings, terminalProjectFromRoots, withDesktopFiles } from './capabilities/desktop-editor.mjs';
import { fusionModelMenu } from './capabilities/fusion-model-menu.mjs';
import { ConversationRef, SessionBinding } from '../session/binding.mjs';
import { localFilePath, mod, samePath } from '../../lib/platform.mjs';
import { cursorSource } from '../native-windows.mjs';
import { editorRoots } from '../../lib/files.mjs';
import { helpersCall, PAGE_SRC } from '../page/build.mjs';
import { cursorUsage } from '../agent/primitives.mjs';
import { activateQueuedAction } from '../agent/queued-action.mjs';
import { rememberCursorSessionProject, storedProjectSession } from '../project-windows.mjs';

// Phone viewers of the same window share its native menu/thought UI.
const cursorUiReads = new Map();

// Implementation support; runtime availability comes from the selected view and native menus.
export const capabilities = {
  model: true, effort: true, fast: true,
  queue: true, steer: false, queueEdit: true,
  questions: true, approvals: true, attachments: true, fileReferences: false,
  editor: true, terminal: true, settings: true, usage: true,
  fork: false, extraActions: true,
};

export const adapter = {
  async ensureProjectPanel() {
    const hidden = await this.cdp.evaluate(`(() => {
      const workbench = document.querySelector('.monaco-workbench');
      const panel = workbench?.querySelector('.part.auxiliarybar');
      return !!panel && (workbench.classList.contains('noauxiliarybar') || panel.getBoundingClientRect().width === 0);
    })()`);
    if (!hidden) return;
    await this.withFocus(() => this.key(mod('i')));
    if (!await this.waitFor('agentStartupState("cursor")', 250)) throw new Error('Cursor 会话面板尚未就绪');
  },
  async newChat(project = '') {
    const origin = ConversationRef.capture(this);
    await this.adapter.ensureProjectPanel.call(this);
    const before = project ? '' : await this.cdp.evaluate(helpersCall('activeThread()'));
    const created = project ? await this.cdp.evaluate(helpersCall(`nativeSessionAction('cursor', '', 'createProjectChat', ${JSON.stringify(project)})`)) : '';
    if (!project) await this.pressControl('newChat');
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 150));
      const chat = await this.cdp.evaluate(helpersCall('extract()'));
      if (!chat || (project ? chat.thread !== created || chat.items.length : chat.thread === before && chat.items.length)) continue;
      if (project) {
        const context = await cursorThreadContext(this.cdp, created);
        if (!context.roots.some(root => !root.host && samePath(root.root, project)))
          throw new Error('Cursor 新会话的原生工作区与所选项目不一致');
        rememberCursorSessionProject(created, project, this.windowId);
      }
      origin.assertCurrent(this);
      cdpRead.getStore()?.throwIfAborted();
      this.clearViewState();
      SessionBinding.commit(this, { threadId: chat.thread || '', selectedThread: this.selectedThread === undefined ? undefined : chat.thread || '' });
      await this.currentRoots();
      this.publishThread('已新建对话');
      this.lastChatAt = 0;
      await this.pollChat();
      return chat;
    }
    throw new Error(project ? 'Cursor 新会话输入区尚未就绪' : '新建对话没有生效');
  },

  // A cold start keeps the native home/new-chat view.
  async openDefaultSession() {
    await this.adapter.ensureProjectPanel.call(this);
    const st = await this.waitFor('agentStartupState("cursor")', 250);
    if (!st) throw new Error('Cursor 项目与会话尚未就绪，请重试');
  },

  async openAgent(id, title = '', { reuseWindow = false } = {}) {
    if (!id || id.length > 200) throw new Error('这条 Agent 已经不在列表里');
    const origin = ConversationRef.capture(this);
    const source = !reuseWindow && !this.fusionBinding && cursorSource(id);
    if (source && source.cdp.wsUrl !== this.cdp.wsUrl) {
      const context = await source.cdp.evaluate(helpersCall(`nativeSessionInfo('cursor', ${JSON.stringify(id)}, 'context')`));
      const roots = await editorRoots(source.cdp, 'cursor');
      if (context.projectless ? !roots.length : context.roots.some(root => this.projectMatches(roots, root.root, root.host))) {
        origin.assertCurrent(this);
        return this.attach({ id: source.win.id, windowId: source.win.id, threadId: id });
      }
    }
    const switching = this.switchingThread;
    let confirmed = false;
    this.switchingThread = true;
    try {
      await this.adapter.ensureProjectPanel.call(this);
      if (!await this.waitFor('agentStartupState("cursor")', 250)) throw new Error('Cursor 会话面板尚未就绪');
      await this.cdp.evaluate(`(async () => {
        const h = ${PAGE_SRC}, id = ${JSON.stringify(id)};
        const info = await h.nativeSessionInfo('cursor', id, 'context');
        if (!window.__remoteAgentCursorServices) throw new Error('Cursor 原生会话目录尚未就绪');
        if (!info) throw new Error('Cursor 原生目录中没有这个会话');
        const peek = await window.__remoteAgentCursorServices.data.composerDataHandleManager.peekComposerData(id);
        const data = peek?.source === 'memory' ? peek.handle.data : peek?.data;
        if (!data) throw new Error('Cursor 原生目录中没有这个会话');
        if (data.isArchived) throw new Error('这个 Cursor 会话已归档');
        if (h.activeThread() !== id) await window.__remoteAgentCursorServices.composer.openComposer(id);
      })()`);
      for (let i = 0; i <= 12; i++) {
        if (await this.cdp.evaluate(helpersCall(`cursorChatReady(${JSON.stringify(id)})`))) {
          origin.assertCurrent(this);
          cdpRead.getStore()?.throwIfAborted();
          if (this.threadId !== id) this.clearViewState();
          SessionBinding.commit(this, { threadId: id, selectedThread: id });
          await this.currentRoots();
          this.publishThread('已切换会话');
          confirmed = true;
          return;
        }
        if (i < 12) await new Promise(r => setTimeout(r, 150));
      }
      throw new Error('会话切换没有生效');
    } finally {
      this.switchingThread = switching;
      this.lastChatAt = 0;
      if (!switching && confirmed) {
        this.publishThread();
        await this.pollChat(true, true);
      }
    }
  },

  async listAgents(silent, readOnly, emit) {
    const list = readOnly && this.cdp.nativeWindow?.catalogAt ? structuredClone(this.cdp.nativeWindow.catalog)
      : await this.cdp.evaluate(helpersCall("nativeSessionInfo('cursor', '', 'list')"));
    emit({ list: list || [], loading: list === null });
  },

  async currentRoots() {
    if (this.threadId) {
      const context = await cursorThreadContext(this.cdp, this.threadId);
      if (!context.roots.length && !context.projectless) {
        const saved = storedProjectSession('cursor', this.threadId);
        if (saved?.workspaceConfirmed) return [{ root: saved.workspace, host: '' }];
      }
      return context.roots.filter(root => !root.host).map(root => ({ ...root, root: localFilePath(root.root) }));
    }
    if (this.winTitle === 'Cursor Agents') {
      const workspace = await this.cdp.evaluate(helpersCall('cursorWorkspace()'));
      return workspace && !workspace.host ? [{ ...workspace, root: localFilePath(workspace.root) }] : [];
    }
    return (await editorRoots(this.editorCdp, 'cursor')).filter(w => !w.host);
  },

  async queueAction(id, action) {
    const call = a => this.cdp.evaluate(helpersCall(`queueTarget(${JSON.stringify(String(id))}${a ? `, ${JSON.stringify(a)}` : ''})`));
    return activateQueuedAction(this, call, action);
  },

  async editQueued(id, text) {
    const focus = () => this.cdp.evaluate(helpersCall(`focusQueueEdit(${JSON.stringify(String(id))})`));
    let ok = false;
    for (let i = 0; i < 10 && !ok; i++) {
      await new Promise(r => setTimeout(r, 100));
      ok = await focus();
    }
    if (!ok) throw new Error(this.appMessage('{app} 没有进入编辑状态，没改动'));
    await this.key(mod('A'));
    await this.typeText(text);
    if (!await this.cdp.evaluate(helpersCall(`saveQueueEdit(${JSON.stringify(String(id))})`))) throw new Error('Cursor 队列保存入口已不可用');
    if (!await this.waitFor(`queueText(${JSON.stringify(String(id))}, false)?.trim() === ${JSON.stringify(text.trim())}`, 40))
      throw new Error('Cursor 尚未确认排队消息已保存，请核对队列后重试');
    this.pollChat(true).catch(() => {});
    return { queueId: id };
  },

  changeAction: changeDesktopFiles,

  async listChanges() {
    const s = await this.withFiles(async s => s);
    this.emit({ t: 'changes', ...s });
  },

  async mentionQuery(q, cat, seq, trigger) {
  },

  withFiles: withDesktopFiles,

  terminalProject: terminalProjectFromRoots,
  usageContext: desktopUsageContext,

  async accountUsage(request, automatic) {
    return this.readCursorUsage(automatic);
  },

  async typeDraft(text, mentions) {
    await this.typeText(text);
  },

  async submitPrompt(now, busy, when, queued, mentions, _receipt, files, text, target) {
    const { cdp, thread } = target;
    return this.submitPromptKey('', queued, () => cdp.evaluate(helpersCall(
      `nativeSessionAction('cursor', ${JSON.stringify(thread)}, 'send', ${JSON.stringify({ text, requestId: randomUUID(), when: when || '', requireActive: true })})`,
    )), { cdp, text, thread });
  },

  async fileAgentMarks(f, text, changes, diff) {
    return null;
  },

  async pickModelMenu(label) {
    return false;
  },

  showSettings: showDesktopSettings,
};

function cursorThreadContext(cdp, id) {
  return cdp.evaluate(helpersCall(`nativeSessionInfo('cursor', ${JSON.stringify(id)}, 'context')`));
}

export const methods = {
async readCursorMenu(kind, requestId) {
  const sel = this.sel, context = { app: 'cursor', threadId: this.threadId };
  const data = await this.cdp.evaluate(`(async () => {
    const h = ${PAGE_SRC.slice(0, -2)}(${JSON.stringify(context)});
    await h.nativeSessionInfo('cursor', ${JSON.stringify(this.threadId)}, 'context');
    return { items: ${kind === 'mode' ? `h.nativeSessionInfo('cursor', ${JSON.stringify(this.threadId)}, 'mode').items` : kind === 'model' ? 'h.modelItemsFast()' : 'h.effortItems(true)'},
      fast: h.fastInfo(), model: h.agentModelName() };
  })()`);
  if (kind === 'model' && !data.items?.length) throw new Error('Cursor 原生模型列表尚未就绪，请重试');
  if (kind === 'mode' && !data.items?.length) throw new Error('该 Cursor 会话未提供原生模式选项');
  if (this.sel === sel) this.emit({ t: 'menu', kind, ...data, requestId, sel: this.selectionKey() });
},

async pickCursorMenu(kind, label) {
  const context = { app: 'cursor', threadId: this.threadId };
  const confirmed = await this.cdp.evaluate(`(async () => {
    const h = ${PAGE_SRC.slice(0, -2)}(${JSON.stringify(context)});
    await h.nativeSessionInfo('cursor', ${JSON.stringify(this.threadId)}, 'context');
    const label = ${JSON.stringify(label)};
    if (${JSON.stringify(kind)} === 'mode') {
      if (!await h.nativeSessionAction('cursor', ${JSON.stringify(this.threadId)}, 'mode', label)) return false;
      return h.nativeSessionInfo('cursor', ${JSON.stringify(this.threadId)}, 'mode').items.some(item => item.checked && item.label === label);
    }
    if (${JSON.stringify(kind)} === 'model') {
      if (!await h.nativeSessionAction('cursor', ${JSON.stringify(this.threadId)}, 'model', label)) return false;
      return h.modelItemsFast().some(item => item.checked && item.label === label);
    }
    if (${JSON.stringify(kind)} === 'fast') {
      if (!await h.pickFast(label === 'on')) return false;
      const fast = h.fastInfo();
      return fast?.on === (label === 'on') ? { fast } : false;
    }
    if (!await h.pickEffort(label)) return false;
    return h.effortItems().some(item => item.checked && item.label === label);
  })()`);
  if (!confirmed) throw new Error('Cursor 尚未确认设置，请重新读取原生菜单');
  if (kind === 'fast') this.emit({ t: 'fastState', sel: this.selectionKey(), ...confirmed });
  this.refreshModelChat().catch(() => {});
},

async withCursorUiRead(fn) {
  const cdp = this.cdp, sel = this.sel, key = cdp.wsUrl;
  const previous = cursorUiReads.get(key);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  cursorUiReads.set(key, pending);
  try {
    if (previous) await previous;
    if (this.cdp === cdp && this.sel === sel) return await fn();
  } finally {
    release();
    if (cursorUiReads.get(key) === pending) cursorUiReads.delete(key);
  }
},

withCursorFiles: withDesktopFiles,

async readCursorUsage(automatic = false) {
  const cdp = this.cdp, editorCdp = this.editorCdp;
  if (automatic) {
    const usage = await cdp.evaluate(helpersCall('readUsage()'));
    if (usage?.limits?.length && !usage.loading && !usage.missing) {
      cursorUsage.data = { ...usage, updated: Date.now() };
      return cursorUsage.data;
    }
    if (cursorUsage.data) return { ...cursorUsage.data, cached: true };
    if (!cursorUsage.initial) cursorUsage.initial = this.withFocus(() => this.readCursorUsage(false))
      .finally(() => { cursorUsage.initial = null; });
    return cursorUsage.initial;
  }
  const wasOpen = await cdp.evaluate(helpersCall('settingsOpen()'));
  await this.ensureSettings(editorCdp);
  try {
    const nav = await cdp.evaluate(helpersCall('usageNavTarget()'));
    if (!nav) return { missing: true, quota: [], limits: [] };
    await this.tapCss(nav.x, nav.y, 'left', cdp);
    let usage = null;
    for (let i = 0; i < 160; i++) {
      await new Promise(r => setTimeout(r, 250));
      usage = await cdp.evaluate(helpersCall('readUsage()'));
      if (usage?.limits?.length && !usage.loading && !usage.missing) break;
    }
    if (usage?.limits?.length && !usage.missing) {
      cursorUsage.data = { ...usage, updated: Date.now() };
      return cursorUsage.data;
    }
    if (usage?.loading) throw new Error('额度还在加载');
    return usage || { missing: true, quota: [], limits: [] };
  } finally { if (!wasOpen) await this.closeSettings(editorCdp); }
},

async toggleMax() {
  await this.pressControl('model');
  const t = await this.waitFor('maxToggle()');
  if (!t) { await this.closeMenus(); throw new Error('这个 Cursor 版本没有 MAX Mode 开关'); }
  await this.tapCss(t.x, t.y);
  await new Promise(r => setTimeout(r, 250));
  await this.closeMenus();
  await this.pollChat(true);
  this.emit({ t: 'status', ok: true, msg: '设置已更新' });
},

...fusionModelMenu,
};

export const nativeCapabilities = {
  window: {
    composer: { directSubmit: true, typeDraft: adapter.typeDraft, submitPrompt: adapter.submitPrompt },
    actions: { stop: stopWindowThread, question: answerComposerQuestion },
    queue: windowQueue,
  },
};
