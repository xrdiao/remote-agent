// 项目与会话：项目目录、窗口复用、会话切换
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { workspaces, windowRoots, workspaceLabel, editorRoots } from '../../lib/files.mjs';
import { IS_WIN, IS_MAC, mod, normPath, findBin } from '../../lib/platform.mjs';
import { Cdp, cdpRead, awaitCdpRead } from '../cdp.mjs';
import { nativeWindowAt } from '../native-windows.mjs';
import { listWindows, codexWindows, codexFolder } from '../windows.mjs';
import { CDP_URL, DEVIN_CDP_URL, CODEX_CDP_URL, EDITORS } from '../config.mjs';
import { PAGE_SRC, helpersCall } from '../page/build.mjs';
import { fusionProject } from '../fusion/state.mjs';
import { trackProjectWindow, storedProjectSession } from '../project-windows.mjs';
import { sessionId } from '../../lib/session-library.mjs';

export function safeHomePath(input) {
  const home = fs.realpathSync(os.homedir());
  const target = input ? path.resolve(String(input)) : home;
  let real;
  try { real = fs.realpathSync(target); }
  catch { throw new Error('找不到这个文件夹'); }
  // Windows intentionally allows any drive — projects are not limited to the home dir.
  if (!IS_WIN && real !== home && !real.startsWith(home + path.sep)) throw new Error('只能打开家目录里的文件夹');
  return { home, real };
}


export function projectList(dir) {
  const { home, real } = safeHomePath(dir);
  const recent = [];
  const seen = new Set();
  if (!dir) {
    for (const w of workspaces()) {
      if (w.host) continue;
      let root;
      try { root = fs.realpathSync(w.root); } catch { continue; }
      if (seen.has(root)) continue;
      seen.add(root);
      recent.push({ name: path.basename(root) || root, path: root });
      if (recent.length >= 12) break;
    }
  }
  let names = [];
  try {
    names = fs.readdirSync(real, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name)
      .sort((a, b) => a.localeCompare(b, 'zh'))
      .slice(0, 200);
  } catch { throw new Error('读不了这个文件夹'); }
  return {
    recent,
    browsing: Boolean(dir),
    path: real,
    parent: (IS_WIN ? real === path.dirname(real) : real === home) ? null : path.dirname(real),
    drives: IS_WIN ? [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(letter => `${letter}:\\`).filter(root => fs.existsSync(root)) : [],
    dirs: names.map(name => ({ name, path: path.join(real, name) })),
  };
}


function createProjectFolder(parent, name) {
  const { real } = safeHomePath(parent);
  if (!name || name === '.' || name === '..' || path.basename(name) !== name) throw new Error('请输入一个文件夹名称，不要包含路径');
  const folder = path.join(real, name);
  fs.mkdirSync(folder);
  return folder;

}


export async function openFolder(folder, app, newWindow = false) {
  const { real } = safeHomePath(folder);
  const port = new URL(app === 'devin' ? DEVIN_CDP_URL : app === 'codex' ? CODEX_CDP_URL : CDP_URL).port;
  const bin = findBin(app, port);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VSCODE_IPC_HOOK_CLI;
  const launcher = path.join(path.dirname(bin), ...(app === 'cursor' ? ['resources', 'app', 'bin', 'cursor.cmd'] : ['bin', app === 'devin' ? 'devin-desktop.cmd' : 'code.cmd']));
  const command = IS_WIN && app === 'cursor' ? 'powershell.exe' : bin;
  const mode = newWindow ? '-n' : '-r';
  const args = IS_WIN && app === 'cursor'
    ? ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; & '${launcher.replace(/'/g, "''")}' ${mode} '${real.replace(/'/g, "''")}'; exit $LASTEXITCODE`]
    : [mode, real];
  const child = spawn(command, args, { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    let error = '';
    child.stderr.on('data', chunk => { error += chunk; });
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(error.trim() || `打开项目失败（退出码 ${code}）`)));
  });
  child.unref();
  return real;
}


// PID of the app's main process: the `ps` line carrying this app's CDP port
// (renderer/helper processes always have --type= in their cmdline).
function appMainPid(port) {
  return new Promise(resolve => {
    const out = spawn('ps', ['-eo', 'pid,args'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let text = '';
    out.stdout.on('data', d => { text += d; });
    out.on('close', () => {
      const line = text.split('\n').find(l => l.includes(`--remote-debugging-port=${port}`) && !l.includes('--type='));
      resolve(line ? Number(line.trim().split(/\s+/)[0]) : null);
    });
    out.on('error', () => resolve(null));
  });
}


export const methods = {
  async checkProjectTrust(options = {}, state) {
    const pending = this.pendingProject;
    if (pending?.trust && pending.app === this.app && pending.windowId === this.windowId) {
      Object.assign(pending, options);
      if (options.prompt) this.emit({ t: 'projectTrust', path: pending.root, sel: this.selectionKey() });
      return true;
    }
    const cdp = this.editorCdp;
    state ||= await cdp.evaluate(helpersCall('workspaceTrustState()'));
    if (!state.required || cdp !== this.editorCdp) return false;
    const roots = await this.currentRoots();
    if (cdp !== this.editorCdp) return false;
    this.pendingProject = { root: roots[0]?.root || '', app: this.app, windowId: this.windowId,
      newSession: false, ...pending, ...options, trust: true };
    this.emit({ t: 'projectTrust', path: this.pendingProject.root, sel: this.selectionKey() });
    return true;
  },
  showProjects(dir) {
    this.emit({ t: 'projects', ...projectList(dir || '') });
  },
  workspaceByRoot(root, host) {
    const want = host || null;
    for (const w of workspaces()) {
      if ((w.host || null) !== want) continue;
      if (w.host) {
        if (w.root === root) return w;
        continue;
      }
      try {
        if (fs.realpathSync(w.root) === fs.realpathSync(root)) return { ...w, root: fs.realpathSync(w.root) };
      } catch {}
    }
    return null;
  },


  // Only local workspaces: remote (SSH / Cursor cloud agent) files are not read from the phone.
  async currentRoots() {
    return this.adapter.currentRoots.call(this);
  },
  projectRows(list) {
    const all = workspaces();
    return list.map(w => {
      const label = workspaceLabel(w, all);
      return { name: label.name, path: w.root, host: w.host || '', detail: label.detail || '' };
    });
  },
  async projectWindowState(page, threadId = '') {
    const id = page.id || page.pageId;
    const own = id === this.windowId || `${this.app}:${id}` === this.windowId;
    const editor = own ? this.editorCdp : new Cdp(page.ws || page.webSocketDebuggerUrl);
    let chat = editor;
    try {
      if (!own) await editor.connect();
      if (this.app === 'codex') {
        if (own) chat = this.cdp;
        else {
          const view = page.chatWs ? page : (await codexWindows(CODEX_CDP_URL, false, id))[0];
          if (view?.chatWs) { chat = new Cdp(view.chatWs); await chat.connect(); }
        }
      }
      if (threadId && await chat.evaluate(helpersCall('activeThread()')) === threadId.replace(/^tab:/, '')) return { thread: threadId.replace(/^tab:/, '') };
      const [state, terminalBusy] = await Promise.all([
        chat.evaluate(helpersCall('agentState()')),
        editor.evaluate(`(() => {
          const terms = new Set([...document.querySelectorAll('.xterm-wrapper, .terminal-wrapper')].map(el => el.xterm).filter(Boolean));
          return [...terms].some(term => {
            if (${this.app === 'devin'} && term.options.disableStdin) return false;
            const detector = (term._addonManager?._addons || []).map(a => a.instance || a).find(a => a.capabilities)?.capabilities.get(2);
            return !detector || !!detector.currentCommand?.commandExecutedMarker;
          });
        })()`),
      ]);
      return { thread: state?.thread || '', busy: !!state?.busy || terminalBusy, agentBusy: !!state?.busy };
    } finally {
      if (chat !== editor && !own) chat.close();
      if (!own) editor.close();
    }
  },
  projectMatches(roots, root, host = '') {
    const identity = value => host ? path.posix.join(normPath(value), '.') : fusionProject(value)?.id;
    const target = identity(root);
    return !!target && roots.some(project => (project.host || '') === host && identity(project.root) === target);
  },
  async useProject(folder, newSession = false, threadId = '', title = '', ownerWindow = '') {
    const signal = cdpRead.getStore();
    signal?.throwIfAborted();
    const { real } = safeHomePath(folder);
    const app = this.app;
    const editor = EDITORS.find(e => e.app === app);
    const belongs = roots => roots.some(w => !w.host && fusionProject(w.root)?.id === fusionProject(real)?.id);
    const ownId = this.windowId.replace(/^[^:]+:/, '');
    const ownerId = ownerWindow.replace(/^[^:]+:/, '');
    const tried = new Set();
    const available = async page => {
      if (!newSession && !threadId) return true;
      const state = await this.projectWindowState(page, threadId);
      return !!threadId && state.thread === threadId.replace(/^tab:/, '') || !(IS_WIN && app === 'codex' ? state.agentBusy : state.busy);
    };
    let target, projectPages = [];
    const matching = async pages => {
      const found = await Promise.allSettled(pages.map(async page => {
        const own = page.id === this.windowId.replace(/^[^:]+:/, '');
        const cdp = own ? this.editorCdp : new Cdp(page.webSocketDebuggerUrl);
        try {
          if (!own) await cdp.connect();
          return belongs(await editorRoots(cdp, app)) ? page : null;
        } finally { if (!own) cdp.close(); }
      }));
      signal?.throwIfAborted();
      return found.flatMap(row => row.status === 'fulfilled' && row.value ? [row.value] : []);
    };
    if (this.editorCdp && (!ownerId || ownerId === ownId)) {
      tried.add(ownId);
      const own = { id: ownId, title: this.winTitle, webSocketDebuggerUrl: this.editorCdp.wsUrl,
        ...(app === 'codex' && this.cdp !== this.editorCdp ? { chatWs: this.cdp.wsUrl } : {}) };
      if ((await matching([own])).length && await available(own)) target = own;
    }
    if (!target) {
      const pages = await (await fetch(`${editor.url}/json/list`, { signal })).json();
      projectPages = pages.filter(p => p.type === 'page' && /workbench/.test(p.url));
      const known = (this.projectAgentWindows?.get(app) || []).filter(w => belongs([w.project || {}])).map(w => w.id.replace(/^[^:]+:/, ''));
      for (const id of new Set([ownerId, ownId, ...known])) {
        const page = projectPages.find(p => p.id === id);
        if (!page || tried.has(id)) continue;
        tried.add(id);
        if ((await matching([page])).length && await available(page)) { target = page; break; }
      }
      if (!target) {
        const candidates = await matching(projectPages.filter(page => !tried.has(page.id)));
        for (const page of candidates) if (await available(page)) { target = page; break; }
      }
    }
    const newWindow = !target;
    if (!target) {
      const previous = new Set(projectPages.map(p => p.id));
      const findTarget = async () => {
        const pages = await (await fetch(`${editor.url}/json/list`, { signal })).json();
        return (await matching(pages.filter(p => p.type === 'page' && /workbench/.test(p.url) && !previous.has(p.id))))[0];
      };
      this.emit({ t: 'status', ok: true, msg: '正在打开项目窗口…' });
      let launchError;
      openFolder(real, app, true).catch(error => { launchError = error; });
      const deadline = Date.now() + 25000;
      while (!target && Date.now() < deadline) {
        if (launchError) throw launchError;
        target = await findTarget();
        if (!target) await awaitCdpRead(new Promise(r => setTimeout(r, 150)));
      }

    }
    if (!target) throw new Error('应用尚未打开所选项目，请检查电脑上的窗口');
    trackProjectWindow(app, target, real, newWindow);
    const switching = this.switchingThread, previousCdp = this.cdp;
    this.switchingThread = true;
    this.bindingReady = false;
    try {
      let binding;
      if (this.windowId !== (app === 'codex' ? target.id : `${app}:${target.id}`) || !this.cdp) {
        if (app === 'codex') {
          const view = (await codexWindows(CODEX_CDP_URL, false, target.id))[0];
          target = { ...target, ...view };
        }
        const win = { id: app === 'codex' ? 'codex' : `${app}:${target.id}`, app,
          title: target.rawTitle || target.title, ws: target.ws || target.webSocketDebuggerUrl, port: editor.url };
        binding = await this.openBound(win, win.ws, target.chatWs || null, {
          windowId: app === 'codex' ? target.id : win.id, threadId, deferred: true,
        });
      }
      this.pendingProject = { ...this.pendingProject, root: real, app, windowId: this.windowId, newSession, threadId, title, reopening: newWindow && !!threadId };
      if (await this.checkProjectTrust({}, binding?.trust)) return;
      if (app === 'devin') await this.ensureDevinIde(threadId.replace(/^tab:/, ''), real);
      if (app === 'codex' && !await this.ensureCodexReady(target, newSession)) return;
      if (this.pendingProject?.trust) return;
      await this.finishProject();
    } finally {
      if (switching) this.switchingThread = switching;
      else await this.resumeProjectSwitch(previousCdp);
    }
    if (newSession) await this.listAgents(true);
    if (newWindow) cdpRead.run(null, async () => {
        try {
          const { webSocketDebuggerUrl } = await (await fetch(`${editor.url}/json/version`)).json();
          const browser = new Cdp(webSocketDebuggerUrl);
          await browser.connect();
          try {
            const { windowId } = await browser.send('Browser.getWindowForTarget', { targetId: target.id });
            await browser.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
          } finally { browser.close(); }
        } catch {
          // Electron builds expose no window-management methods over CDP; iconify via X11.
          if (!IS_WIN && !IS_MAC && process.env.DISPLAY) {
            try {
              const { x11IconifyWindow } = await import('../../lib/x11.mjs');
              await x11IconifyWindow(await appMainPid(new URL(editor.url).port), target.title);
            } catch {}
          }
        }
    }).catch(() => {});
  },
  async resumeProjectSwitch(previousCdp) {
    this.switchingThread = false;
    this.lastChatAt = 0;
    if (!this.bindingReady || cdpRead.getStore()?.aborted) return;
    this.publishThread();
    if (this.cdp !== previousCdp || this.mode === 'chat' && !this.chatUpdatesStop) await this.setMode(this.mode, true);
    else await this.pollChat(true, true);
    this.prefetchMenus().catch(() => {});
  },
  // Waits for the Codex webview of a just-opened window, then binds this.cdp to it.
  async ensureCodexReady(target, needThread) {
    const deadline = Math.min(cdpRead.getStore()?.deadline || Infinity, Date.now() + 25000);
    const pageOf = pages => pages.find(p => p.pageId === target.id);
    const openSidebar = async () => {
      const editorCdp = new Cdp(target.ws || target.webSocketDebuggerUrl);
      await editorCdp.connect();
      try {
        await this.key(mod('Shift+p'), { cdp: editorCdp });
        await editorCdp.send('Input.insertText', { text: 'Codex: Open Codex Sidebar' });
        await this.key('Enter', { cdp: editorCdp });
      } finally { editorCdp.close(); }
    };
    let pages = this.cdp !== this.editorCdp && this.windowId === target.id
      ? [{ ...target, pageId: target.id, chatWs: this.cdp.wsUrl }]
      : await codexWindows(CODEX_CDP_URL, false, target.id);
    if (!pageOf(pages)?.chatWs) {
      // A window that just opened (or just left Restricted Mode) can take a while
      // to activate the Codex extension: re-issue the command every 5 s.
      await openSidebar();
      this.emit({ t: 'status', ok: true, msg: '正在等待 Codex 就绪…' });
      let nextCmd = Date.now() + 5000;
      while (!pageOf(pages)?.chatWs && Date.now() < deadline) {
        if (this.pendingProject?.trust) return;
        await new Promise(r => setTimeout(r, 150));
        pages = await codexWindows(CODEX_CDP_URL, false, target.id);
        if (!pageOf(pages)?.chatWs && Date.now() >= nextCmd) {
          nextCmd = Date.now() + 5000;
          await openSidebar().catch(() => {});
        }
      }
      if (!pageOf(pages)?.chatWs) throw new Error('项目已打开，但 Codex 侧边栏尚未就绪');
    }
    if (this.cdp === this.editorCdp) {
      const page = pageOf(pages);
      await this.openBound({ id: 'codex', app: 'codex', title: page.rawTitle || target.title, ws: page.ws, port: CODEX_CDP_URL },
        page.ws, page.chatWs, { windowId: target.id, threadId: this.pendingProject?.threadId || '', deferred: true });
    }
    if (await this.checkCodexLogin()) return false;
    if (needThread) return this.waitCodexNewChatReady();
    const state = await this.waitFor('agentStartupState("codex", true)', Math.max(0, Math.ceil((deadline - Date.now()) / 120)));
    if (!state) throw new Error('项目已打开，但 Codex 会话数据尚未就绪');
    if (state.login) { await this.checkCodexLogin(); return false; }
    return true;
  },
  async newProject(parent, name, newSession = false) {
    const folder = createProjectFolder(parent, name);
    await this.useProject(folder, newSession);
  },
  async newProjectChat() {
    const roots = await this.currentRoots();
    if (!roots.length) return this.showProjects('');
    return this.useProject(roots[0].root, true);
  },
  async confirmProjectTrust(approve, returnTo) {
    const pending = this.pendingProject;
    if (!pending || this.app !== pending.app || this.windowId !== pending.windowId) throw new Error('项目窗口已改变，请重新选择项目');
    const roots = await this.currentRoots();
    if (!roots.some(w => !w.host && fusionProject(w.root)?.id === fusionProject(pending.root)?.id)) throw new Error('当前窗口不是待确认的项目');
    let state = await this.editorCdp.evaluate(helpersCall('workspaceTrustState()'));
    if (!approve) {
      if (state.decline) await this.tapCss(state.decline.x, state.decline.y, 'left', this.editorCdp);
      pending.trust = true;
      if (returnTo && returnTo.windowId !== this.windowId) {
        await this.attach(returnTo);
        if (this.windowId === returnTo.windowId && !this.pendingProject?.trust)
          this.emit({ t: 'status', ok: true, msg: '已保持限制模式，返回上次对话窗口' });
      } else this.emit({ t: 'status', ok: true, msg: '已保持限制模式，没有可返回的上次对话窗口，请选择其他项目' });
      return;
    }
    if (state.required && !state.trust) {
      await this.key(mod('Shift+p'), { cdp: this.editorCdp });
      await this.editorCdp.send('Input.insertText', { text: 'Workspaces: Manage Workspace Trust' });
      await new Promise(r => setTimeout(r, 200));
      await this.key('Enter', { cdp: this.editorCdp });
      for (let i = 0; i < 20 && !state.trust; i++) {
        await new Promise(r => setTimeout(r, 150));
        state = await this.editorCdp.evaluate(helpersCall('workspaceTrustState()'));
      }
    }
    if (state.required) {
      if (!state.trust) throw new Error('未找到原生信任按钮，请在电脑上检查工作区信任页面');
      await this.tapCss(state.trust.x, state.trust.y, 'left', this.editorCdp);
    }
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 150));
      state = await this.editorCdp.evaluate(helpersCall('workspaceTrustState()'));
      if (!state.required) {
        pending.trust = false;
        const previousCdp = this.cdp;
        this.switchingThread = true;
        try {
          // Trust just activated the Codex extension; bind its webview before reading the target.
          if (this.app === 'codex') {
            const page = (await codexWindows(CODEX_CDP_URL, false, pending.windowId))[0];
            if (page && !await this.ensureCodexReady({ id: page.pageId, ws: page.ws }, pending.newSession)) return;
          }
          await this.finishProject();
        } finally {
          await this.resumeProjectSwitch(previousCdp);
        }
        if (pending.newSession) await this.listAgents(true);
        return;
      }
    }
    throw new Error('项目仍处于限制模式，尚未创建 Agent 会话');
  },
  async finishProject() {
    const pending = this.pendingProject;
    if (!pending) return;
    if ((await this.editorCdp.evaluate(helpersCall('workspaceTrustState()'))).required) throw new Error('请先确认项目是否可信');
    if (this.app === 'devin' && !pending.threadId && !pending.newSession) await this.adapter.openDefaultSession.call(this);
    if (this.app === 'codex' && !pending.threadId && !pending.newSession) {
      const thread = await this.cdp.evaluate(helpersCall('codexThread()')) || '';
      if (this.threadId !== thread) this.clearViewState();
      this.threadId = this.selectedThread = thread;
    }
    let chat;
    if (this.app === 'codex' && pending.threadId) {
      const current = await this.cdp.evaluate(helpersCall('codexThread()'));
      if (current !== pending.threadId && !await this.selectCodexThread(pending.threadId)) throw new Error('项目已打开，但没有找到所选会话');
      await this.adoptCodexThread(pending.threadId);
    }
    if (this.app !== 'codex' && pending.threadId) {
      if (this.app === 'cursor' && pending.reopening) {
        let ready = false;
        for (let i = 0; i < 100 && !ready; i++) {
          ready = await this.cdp.evaluate(`(() => { const h = ${PAGE_SRC}; h.nativeSessionInfo('cursor', ${JSON.stringify(pending.threadId)}); return !!window.__remoteAgentCursorServices; })()`);
          if (!ready) await new Promise(resolve => setTimeout(resolve, 150));
        }
        if (!ready) throw new Error('项目已打开，Cursor 原生会话目录尚未就绪');
      }
      const current = await this.cdp.evaluate(helpersCall('activeThread()'));
      if (current !== pending.threadId.replace(/^tab:/, '')) await this.adapter.openAgent.call(this, pending.threadId, pending.title || '');
      else if (this.threadId !== current) {
        this.clearViewState();
        this.threadId = current;
        this.publishThread();
      }
    }
    if (pending.newSession) {
      const roots = await this.currentRoots();
      if (!roots.some(w => !w.host && fusionProject(w.root)?.id === fusionProject(pending.root)?.id)) throw new Error('当前窗口不属于所选项目，尚未创建会话');
      await this.adapter.newChat.call(this);
      if (this.app === 'cursor' && this.winTitle === 'Cursor Agents')
        await this.cdp.evaluate(helpersCall(`cursorSelectProject(${JSON.stringify(pending.root)})`));
      for (let i = 0; i < 20; i++) {
        chat = await this.cdp.evaluate(helpersCall('extract()'));
        if (chat && !chat.items?.length && await this.cdp.evaluate(helpersCall('hasComposer()'))) break;
        chat = null;
        await new Promise(r => setTimeout(r, 150));
      }
      if (!chat) throw new Error('新会话输入区尚未就绪，请检查电脑上的会话');
      if (this.app === 'devin' && chat.session?.cwd && fusionProject(chat.session.cwd)?.id !== fusionProject(pending.root)?.id)
        throw new Error('Devin 新会话的工作目录与所选项目不一致，尚未发送消息；请检查电脑端的工作目录');
      chat.empty = true;
      this.syncSession(chat);
      this.threadId = chat.thread || chat.session?.key || '';
      this.publishThread();
    }
    const roots = await this.currentRoots();
    if (!roots.some(w => !w.host && fusionProject(w.root)?.id === fusionProject(pending.root)?.id)) throw new Error('会话工作目录与所选项目不一致');
    this.pendingProject = null;
    this.bindingReady = true;
    this.emit({ t: 'projectReady', path: pending.root, name: path.basename(pending.root), newSession: pending.newSession, sessionSwitch: !!pending.threadId, sel: this.selectionKey(), chat });
    this.emit({ t: 'status', ok: true, msg: pending.newSession ? '已在所选项目新建会话' : pending.threadId ? '已切换会话' : `已打开 ${path.basename(pending.root)}` });
  },
  projectName() {
    if (this.app === 'codex') return codexFolder(this.winTitle);
    // A Devin window can have no folder ("Untitled (Workspace)") while its session still
    // runs in a real directory; the session's own cwd names the project in that case.
    if (this.app === 'devin') return path.posix.basename(normPath(windowRoots(this.winTitle, 'devin')[0]?.root || this.sessionCwd || ''));
    return '';
  },
  publishThread(statusMsg) {
    const source = this.cdp?.nativeWindow;
    if (!this.switchingThread && source) source.setThread(this.threadId || '');
    if (this.bindingReady && !this.switchingThread) this.selectionHome = false;
    if (this.selectedThread !== undefined) this.selectedThread = this.threadId || '';
    const msg = {
      t: 'attached', id: this.targetId, title: this.app === 'codex' ? 'Codex' : this.winTitle, app: this.app, appName: this.appMessage('{app}'),
      project: this.projectName(), windowId: this.windowId || '', threadId: this.threadId || '', sel: this.selectionKey(), keepQuota: true, ready: this.bindingReady !== false && !this.switchingThread,
    };
    this.emit(msg);
    this.emit({ t: 'thread', windowId: msg.windowId, threadId: msg.threadId, sel: msg.sel });
    if (statusMsg) this.emit({ t: 'status', ok: true, msg: statusMsg });
  },
  async listAgents(silent = false, readOnly = false, projectWindow = '', checkTrust = false) {
    if (this.app === 'devin' && !readOnly && !projectWindow) await this.ensureDevinIde();
    if ((!readOnly || checkTrust) && !projectWindow && await this.checkProjectTrust({ prompt: true })) return;
    const cdp = this.cdp, sel = this.sel, app = this.app, selection = this.selectionKey();
    const grouped = app === 'cursor' || app === 'devin';
    if (grouped) {
      this.projectAgentWindows ||= new Map();
      this.projectAgentCache ||= new Map();
      {
        let windows = (await listWindows(null, app)).filter(w => w.app === app);
        if (app === 'devin') windows = await this.devinProjectWindows(windows);
        else for (const w of windows) w.project = windowRoots(w.title, app)[0];
        if (!this.liveRead(cdp, sel)) return;
        this.projectAgentWindows.set(app, windows);
        for (const id of this.projectAgentCache.keys()) if (!windows.some(w => w.id === id)) this.projectAgentCache.delete(id);
        if (!readOnly) for (const w of windows) if (w.id !== this.targetId) this.projectAgentCache.delete(w.id);
        if (readOnly && !this.fusionOwner) for (const w of windows) {
          const source = nativeWindowAt(w.ws);
          if (source?.catalog) this.projectAgentCache.set(w.id, { list: structuredClone(source.catalog), surface: source.snapshot?.surface });
        }
      }
      if (projectWindow) {
        const w = this.projectAgentWindows.get(app).find(w => w.id === projectWindow);
        if (!w || w.id === this.targetId) return;
        const probe = new Cdp(w.ws);
        try {
          await probe.connect();
          const data = app === 'devin' ? await probe.evaluate(`(async () => {
            const h = ${PAGE_SRC};
            return { list: await h.sessionPickerRows(true), surface: h.devinSurface() };
          })()`) : await probe.evaluate(`(() => {
            const h = ${PAGE_SRC};
            const surface = h.devinSurface();
            const state = surface === 'editor' ? h.agentState() : null;
            const list = surface === 'editor' ? (h.devinSession()?.tabs || []).map(t => ({ id: 'tab:' + t.id, title: t.title, current: t.active, running: t.active && !!state?.busy })) : h.agentList();
            return { list, surface };
          })()`);
          if (!this.liveRead(cdp, sel)) return;
          this.projectAgentCache.set(w.id, data);
        } finally { probe.close(); }
        return this.emit({ t: 'agents', app, sel: selection, silent: true, list: this.projectAgentRows() });
      }
    }
    const emit = data => {
      if (!this.liveRead(cdp, sel)) return;
      if (grouped) {
        if (data.partial) {
          const remaining = (this.projectAgentCache.get(this.targetId)?.list || []).filter(a => a.picker);
          data = { ...data, list: [...data.list, ...remaining.filter(a => !data.list.some(b => b.id.replace(/^tab:/, '') === a.id))] };
        }
        this.projectAgentCache.set(this.targetId, data);
      }
      this.emit({ t: 'agents', app, sel: selection, silent, ...data, list: grouped ? this.projectAgentRows() : data.list || [] });
    };
    return this.adapter.listAgents.call(this, silent, readOnly, emit);
  },
  projectAgentRows() {
    const list = [], seen = new Set();
    const windows = this.projectAgentWindows.get(this.app) || [];
    const addNew = (w, label, key, root = '') => {
      if (seen.has('new:' + key)) return;
      seen.add('new:' + key);
      list.push({ id: `project-new:${encodeURIComponent(w.id)}${root ? ':' + encodeURIComponent(root) : ''}`, title: '＋ 新建会话', window: label, workspace: root, host: w.project?.host || '', group: '', ui: true });
    };
    // Prefer the attached window when several windows show the same project/session.
    for (const w of [...windows].sort((a, b) => Number(b.id === this.targetId) - Number(a.id === this.targetId))) {
      const current = w.id === this.targetId;
      const data = this.projectAgentCache.get(w.id);
      const project = w.project;
      const label = project ? path.posix.basename(normPath(project.root)) : w.title;
      const projectKey = project ? `${project.host || ''}|${normPath(project.root)}` : w.id;
      if (project || !data?.list?.length || data.list.some(row => !row.workspace)) addNew(w, label, projectKey, !project?.host ? project?.root : '');
      for (const row of data?.list || []) {
        const rowProject = `${row.host || project?.host || ''}|${normPath(row.workspace || project?.root || w.id)}`;
        const rowLabel = row.workspace ? path.posix.basename(normPath(row.workspace)) : label;
        if (row.workspace && (row.workspace === project?.root || (!row.host && !project?.host))) addNew(w, rowLabel, rowProject, !row.host && !project?.host ? row.workspace : '');
        const key = `${rowProject}|${this.app === 'devin' ? row.id.replace(/^tab:/, '') : row.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push({ ...row, id: current ? row.id : `project:${encodeURIComponent(w.id)}:${encodeURIComponent(row.id)}`,
          workspace: row.workspace || project?.root || '', host: row.host || project?.host || '',
          window: rowLabel, group: '', current: current && !!row.current });
      }
      if (!data) list.push({ id: `window:${w.id}`, title: '加载会话', window: label, group: '', ui: true, loadWindow: w.id });
      else if (!data.list?.length || (!current && data.surface === 'editor')) list.push({ id: `window:${w.id}`, title: data.surface === 'editor' ? '进入项目查看全部会话' : '进入项目', window: label, group: '', ui: true });
    }
    const projects = new Map();
    const identity = row => JSON.stringify([row.host || '', normPath(row.workspace)]);
    for (const row of list) if (row.workspace) projects.set(identity(row), { root: IS_WIN && (this.app === 'devin' || this.app === 'cursor') && !row.host ? normPath(row.workspace) : row.workspace, host: row.host });
    const all = [...projects.values()];
    const labels = new Map([...projects].map(([key, project]) => {
      const { name, detail } = workspaceLabel(project, all);
      return [key, detail ? `${name} · ${detail}` : name];
    }));
    return list.map(row => row.workspace ? { ...row, window: labels.get(identity(row)) } : row);
  },
  async openAgent(id, title = '') {
    if (this.selectionHome) {
      this.selectionHome = false;
      this.bindingReady = true;
      await this.openAgent(id, title);
      if (!this.pendingProject?.trust && !this.chatUpdatesStop) await this.setMode(this.mode, true);
      return;
    }
    const openHere = async (root, host, thread) => {
      if (!root || !this.projectMatches(await editorRoots(this.editorCdp, this.app), root, host)) return false;
      if (this.app === 'codex') {
        if (!await this.selectCodexThread(thread)) throw new Error('没有找到所选会话');
        await this.adoptCodexThread(thread, '已切换会话');
      } else await this.adapter.openAgent.call(this, thread, title);
      return true;
    };
    const stored = storedProjectSession(this.app, id);
    if (this.app !== 'codex' && stored?.dormant && await openHere(stored.workspace, stored.host || '', sessionId(this.app, id))) return;
    if (this.app !== 'codex' && stored?.dormant) return this.useProject(stored.workspace, false, sessionId(this.app, id), title);
    if ((this.app === 'cursor' || this.app === 'devin') && (id.startsWith('project:') || id.startsWith('project-new:'))) {
      const [kind, encodedWindow, encodedThread] = id.split(':');
      const window = decodeURIComponent(encodedWindow);
      if (!window.startsWith(this.app + ':')) throw new Error('项目不属于当前 Agent');
      const source = this.projectAgentWindows?.get(this.app)?.find(w => w.id === window)
        || (await listWindows(null, this.app)).find(w => w.id === window);
      const row = this.app === 'devin' && kind === 'project'
        ? await this.cdp.evaluate(`(async () => { const h = ${PAGE_SRC}; return (await h.sessionPickerRows(true)).find(r => r.id === ${JSON.stringify(sessionId('devin', id))}) || null; })()`)
        : this.projectAgentCache?.get(window)?.list.find(r => r.id === decodeURIComponent(encodedThread || ''));
      const root = kind === 'project-new' && encodedThread ? decodeURIComponent(encodedThread) : row?.workspace || source?.project?.root || windowRoots(source?.title || '', this.app)[0]?.root;
      if (kind === 'project' && await openHere(root, row?.host || source?.project?.host || '', decodeURIComponent(encodedThread))) return;
      if (root && !row?.host && !source?.project?.host) await this.useProject(root, kind === 'project-new', kind === 'project' ? decodeURIComponent(encodedThread) : '', title, window);
      else {
        if (window !== this.targetId && !source) throw new Error('所选会话窗口已经关闭');
        const switching = this.switchingThread, previousCdp = this.cdp;
        this.switchingThread = true;
        this.bindingReady = false;
        try {
          if (window !== this.targetId) {
            await this.openBound(source, source.ws, null, { windowId: window,
              threadId: kind === 'project' ? decodeURIComponent(encodedThread) : '', deferred: true });
          }
          if (await this.checkProjectTrust({ newSession: kind === 'project-new', threadId: kind === 'project' ? decodeURIComponent(encodedThread) : '' })) return;
          if (kind === 'project-new') await this.newProjectChat();
          else await this.openAgent(decodeURIComponent(encodedThread), title);
          if (!this.pendingProject?.trust) this.bindingReady = true;
        } finally {
          if (switching) this.switchingThread = switching;
          else await this.resumeProjectSwitch(previousCdp);
        }
      }
      return;
    }
    if (id.startsWith(`window:${this.app}:`)) {
      await this.attach(id.slice('window:'.length));
      await this.listAgents(true);
      return;
    }
    if (this.app === 'cursor' || this.app === 'devin') {
      const row = this.app === 'devin' ? await this.cdp.evaluate(`(async () => { const h = ${PAGE_SRC}; return (await h.sessionPickerRows(true)).find(r => r.id === ${JSON.stringify(id.replace(/^tab:/, ''))}) || null; })()`)
        : await this.cdp.evaluate(`(() => { const h = ${PAGE_SRC}; return h.agentList().find(r => r.id === ${JSON.stringify(id.replace(/^tab:/, ''))}) || null; })()`);
      const root = row?.workspace || (await this.currentRoots())[0]?.root;
      if (await openHere(root, row?.host || '', id)) return;
      if (root && !row?.host) return this.useProject(root, false, id, title, stored?.ownerWindow || '');
      const state = await this.projectWindowState({ id: this.windowId });
      if (state.busy && state.thread !== id.replace(/^tab:/, '')) throw new Error('当前窗口正在运行，尚无法确认目标项目路径；请刷新项目与会话列表');
    }
    return this.app === 'codex' ? this.openCodexAgent(id, true) : this.adapter.openAgent.call(this, id, title);
  },
  async newChat() {
    return this.adapter.newChat.call(this);
  }
};
