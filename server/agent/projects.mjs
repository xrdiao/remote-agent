// 项目与会话：项目目录、窗口复用、会话切换
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { workspaces, windowRoots, workspaceLabel } from '../../lib/files.mjs';
import { IS_WIN, IS_MAC, mod, normPath, findBin } from '../../lib/platform.mjs';
import { Cdp } from '../cdp.mjs';
import { listWindows, codexWindows, codexFolder } from '../windows.mjs';
import { CDP_URL, DEVIN_CDP_URL, CODEX_CDP_URL, EDITORS } from '../config.mjs';
import { PAGE_SRC, helpersCall } from '../page/build.mjs';
import { fusionProject } from '../fusion/state.mjs';

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
  const command = IS_WIN ? 'powershell.exe' : bin;
  const mode = newWindow ? '-n' : '-r';
  const args = IS_WIN
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
  async useProject(folder, newSession = false, threadId = '') {
    const { real } = safeHomePath(folder);
    const app = this.app;
    const editor = EDITORS.find(e => e.app === app);
    let projectPages = [];
    const findTarget = async () => {
      const pages = await (await fetch(`${editor.url}/json/list`)).json();
      projectPages = pages.filter(p => p.type === 'page' && /workbench/.test(p.url));
      return projectPages.find(p =>
        windowRoots(p.title, app).some(w => !w.host && fusionProject(w.root)?.id === fusionProject(real)?.id));
    };
    let target = await findTarget();
    if (!target) {
      let busy = this.cdp ? !!(await this.cdp.evaluate(helpersCall('extract()')))?.busy : false;
      // Cursor's CLI can reuse a different window or encounter a background Agent.
      if (app === 'cursor' && !busy) {
        for (const page of projectPages) {
          const cdp = new Cdp(page.webSocketDebuggerUrl);
          await cdp.connect();
          try { busy = !!await cdp.evaluate(`(() => { const h = ${PAGE_SRC}; return h.agentState()?.busy || h.agentList().some(a => a.running); })()`); }
          finally { cdp.close(); }
          if (busy) break;
        }
      }
      const newWindow = busy || !!this.threadId || ((app === 'codex' || app === 'devin') && !!threadId);
      if (!newWindow && !busy && this.editorCdp) await this.editorCdp.send('Page.bringToFront');
      this.emit({ t: 'status', ok: true, msg: '正在打开项目窗口…' });
      await openFolder(real, app, newWindow);
      for (let i = 0; i < 40 && !target; i++) {
        target = await findTarget();
        if (!target) await new Promise(r => setTimeout(r, 250));
      }
      if (target && newWindow) {
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
      }
    }
    if (!target) throw new Error('应用尚未打开所选项目，请检查电脑上的窗口');
    await this.attach({ id: `${app}:${target.id}` });
    this.pendingProject = { ...this.pendingProject, root: real, app, windowId: this.windowId, newSession, threadId };
    // Restricted Mode disables the agent extension, so prompt for trust before
    // waiting on a Codex sidebar that can never appear while untrusted.
    if (await this.checkProjectTrust()) return;
    if (app === 'codex') await this.ensureCodexReady(target, newSession || !!threadId);
    if (this.pendingProject?.trust) return;
    await this.finishProject();
  },
  // Waits for the Codex webview of a just-opened window, then binds this.cdp to it.
  async ensureCodexReady(target, needThread) {
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
    let pages = await codexWindows(CODEX_CDP_URL);
    if (!pageOf(pages)?.chatWs) {
      // A window that just opened (or just left Restricted Mode) can take a while
      // to activate the Codex extension: re-issue the command every 5 s.
      await openSidebar();
      this.emit({ t: 'status', ok: true, msg: '正在等待 Codex 就绪…' });
      const deadline = Date.now() + 25000;
      let nextCmd = Date.now() + 5000;
      while (!pageOf(pages)?.chatWs && Date.now() < deadline) {
        if (this.pendingProject?.trust) return;
        await new Promise(r => setTimeout(r, 150));
        pages = await codexWindows(CODEX_CDP_URL);
        if (!pageOf(pages)?.chatWs && Date.now() >= nextCmd) {
          nextCmd = Date.now() + 5000;
          await openSidebar().catch(() => {});
        }
      }
      if (!pageOf(pages)?.chatWs) throw new Error('项目已打开，但 Codex 侧边栏尚未就绪');
      await this.attach({ id: `codex:${target.id}` });
    }
    if (needThread) {
      if (await this.checkCodexLogin()) throw new Error('请先在电脑端登录此窗口的 Codex，再新建会话');
      let ready = false;
      for (let i = 0; i < 120 && !ready; i++) {
        if (this.pendingProject?.trust) return;
        ready = !!await this.cdp.evaluate(helpersCall('codexNewPoint()'));
        if (!ready) await new Promise(r => setTimeout(r, 250));
      }
      if (!ready) throw new Error('项目已打开，但 Codex 会话入口尚未就绪');
    }
  },
  async newProject(parent, name, newSession = false) {
    const folder = createProjectFolder(parent, name);
    await this.useProject(folder, newSession);
  },
  async newProjectChat() {
    const roots = await this.currentRoots();
    if (!roots.length) return this.showProjects('');
    const root = roots[0];
    if (this.app === 'codex' && this.cdp === this.editorCdp) return this.useProject(root.root, true);
    this.pendingProject = { root: root.root, app: this.app, windowId: this.windowId, newSession: true };
    if (await this.checkProjectTrust()) return;
    await this.finishProject();
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
        // Trust just activated the Codex extension; wait for its webview before selecting the session.
        if (this.app === 'codex') {
          const page = (await codexWindows(CODEX_CDP_URL)).find(p => p.pageId === pending.windowId);
          if (page) await this.ensureCodexReady({ id: page.pageId, ws: page.ws }, pending.newSession || !!pending.threadId);
        }
        return this.finishProject();
      }
    }
    throw new Error('项目仍处于限制模式，尚未创建 Agent 会话');
  },
  async finishProject() {
    const pending = this.pendingProject;
    if (!pending) return;
    if ((await this.editorCdp.evaluate(helpersCall('workspaceTrustState()'))).required) throw new Error('请先确认项目是否可信');
    let chat;
    if (this.app === 'codex' && pending.threadId) {
      if (!await this.selectCodexThread(pending.threadId)) throw new Error('项目已打开，但没有找到所选会话');
      await this.adoptCodexThread(pending.threadId, '已切换项目与会话');
    }
    if (this.app === 'devin' && pending.threadId) await this.adapter.openAgent.call(this, pending.threadId);
    if (pending.newSession) {
      await this.newChat();
      if (this.app === 'cursor' && this.winTitle === 'Cursor Agents')
        await this.cdp.evaluate(helpersCall(`cursorSelectProject(${JSON.stringify(pending.root)})`));
      for (let i = 0; i < 20; i++) {
        chat = await this.cdp.evaluate(helpersCall('extract()'));
        if (chat && !chat.items?.length && await this.cdp.evaluate(helpersCall('hasComposer()'))) break;
        chat = null;
        await new Promise(r => setTimeout(r, 150));
      }
      if (!chat) throw new Error('新会话输入区尚未就绪，请检查电脑上的会话');
      chat.empty = true;
      this.syncSession(chat);
      this.threadId = chat.thread || chat.session?.key || '';
      this.publishThread();
    }
    const roots = await this.currentRoots();
    if (!roots.some(w => !w.host && fusionProject(w.root)?.id === fusionProject(pending.root)?.id)) throw new Error('会话工作目录与所选项目不一致');
    this.pendingProject = null;
    this.emit({ t: 'projectReady', path: pending.root, name: path.basename(pending.root), newSession: pending.newSession, sel: this.selectionKey(), chat });
    this.emit({ t: 'status', ok: true, msg: pending.newSession ? '已在所选项目新建会话' : `已打开 ${path.basename(pending.root)}` });
    if (pending.newSession) await this.listAgents(true);
  },
  projectName() {
    if (this.app === 'codex') return codexFolder(this.winTitle);
    // A Devin window can have no folder ("Untitled (Workspace)") while its session still
    // runs in a real directory; the session's own cwd names the project in that case.
    if (this.app === 'devin') return path.posix.basename(normPath(windowRoots(this.winTitle, 'devin')[0]?.root || this.sessionCwd || ''));
    return '';
  },
  publishThread(statusMsg) {
    const msg = {
      t: 'attached', id: this.targetId, title: this.app === 'codex' ? 'Codex' : this.winTitle, app: this.app, appName: this.appMessage('{app}'),
      project: this.projectName(), windowId: this.windowId || '', threadId: this.threadId || '', sel: this.selectionKey(), keepQuota: true,
    };
    this.emit(msg);
    this.emit({ t: 'thread', windowId: msg.windowId, threadId: msg.threadId, sel: msg.sel });
    if (statusMsg) this.emit({ t: 'status', ok: true, msg: statusMsg });
  },
  async listAgents(silent = false, readOnly = false, projectWindow = '', checkTrust = false) {
    if ((!readOnly || checkTrust) && !projectWindow && await this.checkProjectTrust({ prompt: true })) return;
    const cdp = this.cdp, sel = this.sel, app = this.app;
    const grouped = app === 'cursor' || app === 'devin';
    if (grouped) {
      this.projectAgentWindows ||= new Map();
      this.projectAgentCache ||= new Map();
      if (!readOnly || !this.projectAgentWindows.has(app)) {
        const windows = (await listWindows(null, app)).filter(w => w.app === app);
        for (const w of windows) w.project = windowRoots(w.title, app)[0];
        if (!this.liveRead(cdp, sel)) return;
        this.projectAgentWindows.set(app, windows);
        if (!readOnly) for (const w of windows) if (w.id !== this.targetId) this.projectAgentCache.delete(w.id);
      }
      if (projectWindow) {
        const w = this.projectAgentWindows.get(app).find(w => w.id === projectWindow);
        if (!w || w.id === this.targetId) return;
        const probe = new Cdp(w.ws);
        try {
          await probe.connect();
          const data = await probe.evaluate(`(() => {
            const h = ${PAGE_SRC};
            const surface = h.devinSurface();
            const state = surface === 'editor' ? h.agentState() : null;
            const list = surface === 'editor' ? (h.devinSession()?.tabs || []).map(t => ({ id: 'tab:' + t.id, title: t.title, current: t.active, running: t.active && !!state?.busy })) : h.agentList();
            return { list, surface };
          })()`);
          if (!this.liveRead(cdp, sel)) return;
          this.projectAgentCache.set(w.id, data);
        } finally { probe.close(); }
        return this.emit({ t: 'agents', app, silent: true, list: this.projectAgentRows() });
      }
    }
    const emit = data => {
      if (!this.liveRead(cdp, sel)) return;
      if (grouped) {
        if (data.partial) {
          const remaining = (this.projectAgentCache.get(this.targetId)?.list || []).filter(a => a.id.startsWith('pick:'));
          data = { ...data, list: [...data.list, ...remaining.filter(a => !data.list.some(b => b.title === a.title))] };
        }
        this.projectAgentCache.set(this.targetId, data);
      }
      this.emit({ t: 'agents', app, silent, ...data, list: grouped ? this.projectAgentRows() : data.list || [] });
    };
    return this.adapter.listAgents.call(this, silent, readOnly, emit);
  },
  projectAgentRows() {
    const list = [], seen = new Set();
    const windows = this.projectAgentWindows.get(this.app) || [];
    const addNew = (w, label, key, root = '') => {
      if (seen.has('new:' + key)) return;
      seen.add('new:' + key);
      list.push({ id: `project-new:${encodeURIComponent(w.id)}${root ? ':' + encodeURIComponent(root) : ''}`, title: '＋ 新建会话', window: label, group: '', ui: true });
    };
    // Prefer the attached window when several windows show the same project/session.
    for (const w of [...windows].sort((a, b) => Number(b.id === this.targetId) - Number(a.id === this.targetId))) {
      const current = w.id === this.targetId;
      const data = this.projectAgentCache.get(w.id);
      const project = w.project;
      const label = project ? path.posix.basename(normPath(project.root)) : w.title;
      const projectKey = project ? `${project.host || ''}|${normPath(project.root)}` : w.id;
      if (project || !data?.list?.length || data.list.some(row => !row.workspace)) addNew(w, label, projectKey);
      for (const row of data?.list || []) {
        const rowProject = `${row.host || project?.host || ''}|${normPath(row.workspace || project?.root || w.id)}`;
        const rowLabel = row.workspace ? path.posix.basename(normPath(row.workspace)) : label;
        if (row.workspace && (row.workspace === project?.root || (!row.host && !project?.host))) addNew(w, rowLabel, rowProject, row.workspace !== project?.root && !row.host && !project?.host ? row.workspace : '');
        const key = `${rowProject}|${this.app === 'devin' ? row.id.replace(/^tab:/, '') : row.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push({ ...row, id: current ? row.id : `project:${encodeURIComponent(w.id)}:${encodeURIComponent(row.id)}`,
          window: rowLabel, group: '', current: current && !!row.current });
      }
      if (!data) list.push({ id: `window:${w.id}`, title: '加载会话', window: label, group: '', ui: true, loadWindow: w.id });
      else if (!data.list?.length || (!current && data.surface === 'editor')) list.push({ id: `window:${w.id}`, title: data.surface === 'editor' ? '进入项目查看全部会话' : '进入项目', window: label, group: '', ui: true });
    }
    return list;
  },
  async openAgent(id, title = '') {
    if ((this.app === 'cursor' || this.app === 'devin') && (id.startsWith('project:') || id.startsWith('project-new:'))) {
      const [kind, encodedWindow, encodedThread] = id.split(':');
      const window = decodeURIComponent(encodedWindow);
      if (!window.startsWith(this.app + ':')) throw new Error('项目不属于当前 Agent');
      if (kind === 'project-new' && encodedThread) await this.useProject(decodeURIComponent(encodedThread), true);
      else {
        if (window !== this.targetId) await this.attach(window);
        if (await this.checkProjectTrust()) return;
        if (kind === 'project-new') await this.newChat();
        else await this.adapter.openAgent.call(this, decodeURIComponent(encodedThread), title);
      }
      await this.listAgents(true);
      return;
    }
    if (id.startsWith(`window:${this.app}:`)) {
      await this.attach(id.slice('window:'.length));
      await this.listAgents(true);
      return;
    }
    return this.adapter.openAgent.call(this, id, title);
  },
  async newChat() {
    return this.adapter.newChat.call(this);
  }
};
