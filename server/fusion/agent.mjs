import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentContext, openFolder, quotaBlockedMessage } from '../agent/index.mjs';
import '../apps/index.mjs';
import { Cdp } from '../cdp.mjs';
import { NativeCdp, nativeWindow } from '../native-windows.mjs';
import { EDITORS, CODEX_CDP_URL } from '../config.mjs';
import { codexWindows } from '../windows.mjs';
import { editorRoots } from '../../lib/files.mjs';
import { findBin } from '../../lib/platform.mjs';
import { DATA_DIR } from '../../lib/auth.mjs';
import { helpersCall } from '../page/build.mjs';
import { leaseWindow } from '../window-use.mjs';
import { fusionProjectWindows, trackFusionWindow, updateFusionWindow, rememberFusionSession, recycleFusionWindows } from '../project-windows.mjs';
import { fusionProject, fusionModelSpec, publishFusion } from './state.mjs';
import { nativeCostSnapshot } from './cost.mjs';
import { fusionScheduler } from './scheduler.mjs';

const executeFile = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const turnCall = (id = '', attemptId = '', previous = [], generationId = '') => helpersCall(`codexFusionTurn(${JSON.stringify(id)}, ${JSON.stringify(attemptId)}, ${JSON.stringify(previous)}, ${JSON.stringify(generationId)})`);

export async function fusionWorkspaceSnapshot(project, scope = []) {
  if (project.host) return { available: false, reason: '远程工作区差异需由原生 Agent 提供证据', at: Date.now() };
  const git = findBin('git');
  const options = { cwd: project.root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 };
  const scopedFiles = await Promise.all(scope.map(async name => {
    const file = path.resolve(project.root, name);
    try {
      const stat = await fs.stat(file);
      return { path: name, exists: true, directory: stat.isDirectory(),
        ...(stat.isFile() ? { sha256: crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex') } : {}) };
    } catch (error) { if (error.code === 'ENOENT') return { path: name, exists: false }; throw error; }
  }));
  try {
    const [status, diff, untracked] = await Promise.all([
      executeFile(git, ['status', '--porcelain=v1', '-z'], options),
      executeFile(git, ['diff', '--binary', 'HEAD', '--', '.'], options),
      executeFile(git, ['ls-files', '--others', '--exclude-standard', '-z'], options),
    ]);
    const files = await Promise.all(untracked.stdout.split('\0').filter(Boolean).map(async name => ({ path: name,
      sha256: crypto.createHash('sha256').update(await fs.readFile(path.join(project.root, name))).digest('hex') })));
    return { available: true, at: Date.now(), source: '执行边界的 Git 工作区与指定文件快照', status: status.stdout, diff: diff.stdout, untracked: files, files: scopedFiles };
  } catch (error) { return { available: false, at: Date.now(), reason: error.message, files: scopedFiles }; }
}

export class FusionAgent {
  constructor({ scheduler = fusionScheduler, publish = publishFusion } = {}) {
    this.scheduler = scheduler;
    this.publish = publish;
    this.active = new Map();
    this.reclaimRequests = new Map();
  }
  recycle(run, app) {
    return recycleFusionWindows(run.computer, app, run.project, true);
  }
  async windowFor(run, app, create = true) {
    const editor = EDITORS.find(value => value.app === app);
    const identity = JSON.stringify([run.computer, app, run.project.host || '', run.project.id]);
    return this.scheduler.window(identity, async () => {
      const pages = async () => (await (await fetch(editor.url + '/json/list', { signal: AbortSignal.timeout(2500) })).json())
        .filter(page => page.type === 'page' && /workbench/.test(page.url));
      const registered = fusionProjectWindows(run.computer, app, run.project);
      let targets;
      try { targets = await pages(); }
      catch (error) {
        if (!create || registered.length || error.cause?.code !== 'ECONNREFUSED') throw error;
        targets = [];
      }
      for (const row of registered) {
        const target = targets.find(page => page.id === row.id);
        if (!target) { updateFusionWindow(app, row.id, { closed: true }); continue; }
        if (row.ownership !== 'fusion' && !this.reclaimRequests.get(run.id)?.has(app)) throw new Error('Fusion 专用窗口归属已变化，请先在电脑核对，再明确继续');
        await this.checkWindow(target, app, run.project);
        return { ...row, page: target };
      }
      if (!create) throw new Error('原 Fusion 专用窗口已关闭，不能确认原生执行结果');
      if (run.project.host) throw new Error('当前原生打开通道不能创建远程 Fusion 专用窗口');
      const previous = new Set(targets.map(page => page.id));
      const directory = path.join(DATA_DIR, 'fusion-windows');
      const workspace = path.join(directory, crypto.createHash('sha256').update(identity).digest('hex') + '.code-workspace');
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(workspace, JSON.stringify({ folders: [{ path: run.project.root }] }), { mode: 0o600 });
      if (app === 'cursor' && targets.length) {
        const creator = new Cdp(targets[0].webSocketDebuggerUrl);
        try {
          await creator.connect();
          await creator.evaluate(helpersCall(`cursorSelectProject(${JSON.stringify(workspace)}, '', true)`));
        } finally { creator.close(); }
      } else await openFolder(workspace, app, true, !targets.length);
      const deadline = Date.now() + 25000;
      do {
        try { targets = await pages(); }
        catch (error) {
          if (error.cause?.code !== 'ECONNREFUSED') throw error;
          targets = [];
        }
        for (const target of targets.filter(page => !previous.has(page.id))) {
          const cdp = new Cdp(target.webSocketDebuggerUrl);
          try {
            await cdp.connect();
            const roots = await editorRoots(cdp, app);
            if (!roots.some(root => fusionProject(root.root, root.host || '')?.id === run.project.id)) continue;
            return { ...trackFusionWindow(run.computer, app, target, run.project), page: target };
          } finally { cdp.close(); }
        }
        await pause(150);
      } while (Date.now() < deadline);
      throw new Error('没有确认新建的 Fusion 项目窗口');
    });
  }
  async checkWindow(page, app, project) {
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    try {
      await cdp.connect();
      if (!(await editorRoots(cdp, app)).some(root => fusionProject(root.root, root.host || '')?.id === project.id)) {
        updateFusionWindow(app, page.id, { ownership: 'changed', ownershipReason: '实际项目已变化', ownershipChangedAt: Date.now() });
        throw new Error('Fusion 专用窗口已切换项目，已记录归属变化');
      }
    } finally { cdp.close(); }
  }
  async context(run, app, window) {
    const context = new AgentContext({ deviceId: run.deviceId });
    Object.assign(context, { app, mode: 'chat', visible: false, fusionBinding: true, windowId: window.id,
      targetId: app === 'codex' ? 'codex' : `${app}:${window.id}`, codexPageId: app === 'codex' ? window.id : '', winTitle: window.page.title });
    context.editorCdp = new NativeCdp(window.page.webSocketDebuggerUrl);
    context.cdp = context.editorCdp;
    await context.editorCdp.connect();
    const trust = await context.editorCdp.evaluate(helpersCall('workspaceTrustState()'));
    if (trust.required) { context.editorCdp.close(); throw new Error(`项目需要原生信任确认：${run.project.root}`); }
    try {
      if (app === 'cursor' && !window.initialized && !await context.waitFor('control("model")', 250))
        throw new Error('Fusion 窗口的 Cursor 模型菜单尚未就绪');
      if (app === 'codex') {
        let page = (await codexWindows(CODEX_CDP_URL, false, window.id)).find(value => value.pageId === window.id);
        if (!page?.chatWs) {
          await context.withFocus(async () => {
            await context.key((process.platform === 'darwin' ? 'Meta' : 'Ctrl') + '+Shift+p', { cdp: context.editorCdp });
            await context.editorCdp.send('Input.insertText', { text: 'Codex: Open Codex Sidebar' });
            await context.key('Enter', { cdp: context.editorCdp });
          });
          const deadline = Date.now() + 25000;
          while (!page?.chatWs && Date.now() < deadline) {
            await pause(150);
            page = (await codexWindows(CODEX_CDP_URL, false, window.id)).find(value => value.pageId === window.id);
          }
        }
        if (!page?.chatWs) throw new Error('Fusion 窗口的 Codex 侧边栏尚未就绪');
        context.cdp = new NativeCdp(page.chatWs);
        await context.cdp.connect();
        const state = await context.waitFor('agentStartupState("codex", true)', 250);
        if (!state) throw new Error('Fusion 窗口的 Codex 会话尚未就绪');
        if (state.login) throw new Error('Fusion 窗口的 Codex 需要原生登录');
      }
      if (app === 'devin') {
        if (await context.cdp.evaluate(helpersCall('devinSurface()')) !== 'editor') {
          if (!await context.cdp.evaluate(helpersCall("surfaceTarget('editor', true)")) || !await context.waitFor("devinSurface() === 'editor'", 100))
            throw new Error('Fusion 专用窗口尚未进入 Devin IDE');
        }
        if (!await context.cdp.evaluate(helpersCall('hasComposer()'))) await context.withFocus(() => context.openEditorChat());
      }
      await nativeWindow(context.cdp).start({ id: context.targetId, pageId: window.id, app, ws: context.cdp.wsUrl, editorWs: context.editorCdp.wsUrl });
      if (!window.initialized) {
        window.expectedThread = await context.cdp.evaluate(helpersCall('activeThread()')) || '';
        window.initialized = true;
        updateFusionWindow(app, window.id, { expectedThread: window.expectedThread, initialized: true });
      }
      return context;
    } catch (error) { this.closeContext(context); throw error; }
  }
  closeContext(context) {
    clearTimeout(context.focusTimer);
    for (const cdp of new Set([context.cdp, context.editorCdp])) cdp?.close();
  }
  async assertOwnership(context, window, expected = window.expectedThread) {
    const current = await context.cdp.evaluate(helpersCall('activeThread()'));
    if (window.bindingId && current !== (expected || '')) {
      updateFusionWindow(context.app, window.id, { ownership: 'changed', observedThread: current, ownershipReason: '电脑端会话已变化', ownershipChangedAt: Date.now() });
      throw new Error('Fusion 专用窗口已切到其他会话，已记录归属变化；请在电脑核对后继续');
    }
    const draft = await context.cdp.evaluate(helpersCall('composerDraft()'));
    if (draft) {
      updateFusionWindow(context.app, window.id, { ownership: 'changed', observedThread: current, ownershipReason: '原生草稿未处理', ownershipChangedAt: Date.now() });
      throw new Error('Fusion 专用窗口存在原生草稿，请在电脑处理后继续；草稿已保留');
    }
    return current;
  }
  async capabilities(run, app) {
    const window = await this.windowFor(run, app);
    const release = leaseWindow(app, window.id, this, true);
    let context;
    try {
      context = await this.context(run, app, window);
      await this.assertOwnership(context, window);
      updateFusionWindow(app, window.id, { ownership: 'fusion' });
      this.reclaimRequests.get(run.id)?.delete(app);
      let models = await context.cdp.evaluate(helpersCall('modelItemsFast(true)'));
      if (!models?.length) {
        await context.withFocus(async () => {
          await context.pressControl('model');
          await context.waitFor('menuOpen()');
          if (app === 'cursor') await context.openModelList();
          models = await context.cdp.evaluate(helpersCall('modelItemsFast(true)'));
        });
      }
      await context.closeMenus();
      if (!models?.length) throw new Error('没有读取到当前原生模型候选');
      let usage;
      try { usage = await context.adapter.accountUsage.call(context, { fusion: true, manual: true }, false); }
      catch (error) { usage = { missing: true, error: error.message, updated: Date.now() }; }
      return nativeCostSnapshot(app, models, usage);
    } finally { if (context) this.closeContext(context); release(); }
  }
  async bind(run, attempt, context, window, recovering) {
    const task = run.tasks.find(value => value.id === attempt.taskId);
    const owner = attempt.kind === 'decision' || task?.executor === 'main' ? run.main : task;
    let binding = attempt.bindingId
      ? run.bindings.find(value => value.id === attempt.bindingId && !value.archived)
      : run.bindings.findLast(value => value.app === attempt.app && value.role === (task?.executor === 'child' ? task.id : 'main') && !value.archived);
    if (recovering) {
      if (!binding || binding.windowId !== window.id) throw new Error('缺少可核对的原生 Binding，不能自动重发');
      if (!binding.threadId) {
        const turn = await context.cdp.evaluate(turnCall(attempt.receipt?.messageId || '', attempt.id, attempt.beforeIds || []));
        if (!turn.id || !turn.threadId || turn.accepted === false) throw new Error('新会话尚无可确认的原生轮次，不能自动重发');
        binding.threadId = turn.threadId;
        updateFusionWindow(context.app, window.id, { expectedThread: turn.threadId, bindingId: binding.id });
        this.publish(run);
      }
      context.threadId = context.selectedThread = binding.threadId;
      await this.assertOwnership(context, window, binding.threadId);
      updateFusionWindow(context.app, window.id, { ownership: 'fusion' });
      this.reclaimRequests.get(run.id)?.delete(context.app);
      return binding;
    }
    await this.assertOwnership(context, window);
    const state = await context.cdp.evaluate(helpersCall('agentState()'));
    if (window.bindingId && state?.busy) throw new Error('Fusion 专用窗口仍有原生执行，等待其结束');
    await context.withFocus(async () => {
      if (binding?.threadId) {
        if (context.app === 'codex') {
          if (!await context.selectCodexThread(binding.threadId)) throw new Error('原生 Binding 会话未找到');
          context.threadId = context.selectedThread = binding.threadId;
        } else await context.adapter.openAgent.call(context, binding.threadId);
      } else {
        await context.adapter.newChat.call(context);
        const threadId = await context.cdp.evaluate(helpersCall('activeThread()')) || '';
        if (run.bindings.some(value => value.app === context.app && value.threadId && value.threadId === threadId)) throw new Error('原生未创建独立会话');
        binding = { id: crypto.randomUUID(), app: context.app, host: run.project.host || '', projectId: run.project.id,
          windowId: window.id, threadId, role: task?.executor === 'child' ? task.id : 'main', created: Date.now(), archived: false };
        run.bindings.push(binding);
        if (task?.executor === 'child' || owner.app === attempt.app) owner.bindingId = binding.id;
        context.threadId = context.selectedThread = threadId;
      }
    });
    if (binding.windowId !== window.id) {
      binding = { id: crypto.randomUUID(), app: binding.app, host: binding.host, projectId: binding.projectId,
        windowId: window.id, threadId: binding.threadId, role: binding.role, created: Date.now(), archived: false, previousBindingId: binding.id };
      run.bindings.push(binding);
      if (task?.executor === 'child' || owner.app === attempt.app) owner.bindingId = binding.id;
    }
    if (binding.threadId) rememberFusionSession(context.app, binding.threadId, run.project, window.id);
    updateFusionWindow(context.app, window.id, { expectedThread: binding.threadId, bindingId: binding.id });
    attempt.bindingId = binding.id;
    this.publish(run);
    return binding;
  }
  async configure(context, attempt) {
    const currentModel = fusionModelSpec(await context.cdp.evaluate(helpersCall('agentModelName()'))).modelLabel;
    await context.withFocus(async () => {
      if (currentModel !== attempt.model) await context.pickMenu('model', attempt.model);
      const currentEfforts = await context.cdp.evaluate(helpersCall('effortItems()'));
      if (attempt.effort && !currentEfforts.some(value => value.checked && value.label === attempt.effort)) await context.pickMenu('effort', attempt.effort);
    });
    const selected = fusionModelSpec(await context.cdp.evaluate(helpersCall('agentModelName()'))).modelLabel;
    const normalized = value => String(value || '').toLowerCase().replace(/[-\s]+/g, '');
    if (normalized(selected) !== normalized(attempt.model)) throw new Error(`原生模型未确认：期望 ${attempt.model}，实际 ${selected || '未知'}`);
    const efforts = await context.cdp.evaluate(helpersCall('effortItems()'));
    if (attempt.effort && !efforts.some(value => value.checked && value.label === attempt.effort)) throw new Error('原生思考强度未确认');
  }
  async execute(run, attemptId, prompt, recovering = false) {
    const current = () => run.attempts.find(value => value.id === attemptId);
    const window = await this.windowFor(run, current().app, !recovering);
    const release = leaseWindow(current().app, window.id, this, true);
    let context, runtime;
    try {
      context = await this.context(run, current().app, window);
      const binding = await this.bind(run, current(), context, window, recovering);
      runtime = { run, attemptId, context, binding, window, stopping: run.stopRequested || current().status === 'stopping' };
      this.active.set(attemptId, runtime);
      if (!recovering) {
        if (run.stopRequested || current().status === 'cancelled') throw Object.assign(new Error('尚未提交的 Fusion 执行已取消'), { cancelled: true });
        await this.configure(context, current());
        if (!binding.threadId) {
          binding.threadId = await context.cdp.evaluate(helpersCall('activeThread()')) || '';
          context.threadId = context.selectedThread = binding.threadId;
          updateFusionWindow(context.app, window.id, { expectedThread: binding.threadId });
        }
        const blocked = quotaBlockedMessage(current().app, run.capabilities.find(value => value.app === current().app)?.usage);
        if (blocked) throw new Error(blocked);
        const before = await context.cdp.evaluate(turnCall());
        Object.assign(current(), { baseline: current().kind === 'task' ? await fusionWorkspaceSnapshot(run.project, run.tasks.find(task => task.id === current().taskId).scope) : null, beforeIds: before.ids,
          prompt, status: 'preparing', submission: 'not_submitted' });
        this.publish(run);
        await this.assertOwnership(context, window, binding.threadId);
        if (run.stopRequested) throw Object.assign(new Error('Fusion 已停止提交'), { cancelled: true });
        Object.assign(current(), { status: 'submitting', submission: 'submitting', submittedAt: Date.now() });
        this.publish(run);
        context.emit = message => {
          if (message.t === 'sendFailed') { current().nativeError = message.message || '原生明确拒绝提交'; runtime.rejected = true; }
          if (message.t === 'sent' && !message.pending && message.messageId) {
            current().receipt = { messageId: message.messageId, threadId: message.thread || '' };
            this.publish(run);
          }
          runtime.check?.();
        };
        await nativeWindow(context.cdp).run(() => context.withFocus(() => context.sendMessage(prompt, true, '', [], { requestId: attemptId })));
      }
      return await this.observe(runtime);
    } catch (error) {
      if (current().submission === 'submitting' || current().submission === 'accepted') {
        if (!error.nativeEnded && !current().nativeGenerationEndedAt) {
          current().status = 'unknown'; this.scheduler.uncertain.set(current().app, attemptId);
          if (run.tasks.find(task => task.id === current().taskId)?.access === 'write') this.scheduler.uncertainWriters.set(run.project.id, attemptId);
        }
      }
      throw error;
    } finally {
      runtime?.unsubscribe?.();
      this.active.delete(attemptId);
      if (context) this.closeContext(context);
      release();
    }
  }
  observe(runtime) {
    const { run, context, binding, window } = runtime;
    return new Promise((resolve, reject) => {
      let reading = false, again = false, done = false;
      const current = () => run.attempts.find(value => value.id === runtime.attemptId);
      const finish = (value, error) => { done = true; runtime.unsubscribe?.(); error ? reject(error) : resolve(value); };
      runtime.check = async () => {
        if (done) return;
        if (reading) { again = true; return; }
        reading = true;
        try {
          const chat = (await nativeWindow(context.cdp).read(true)).chat;
          const turn = await context.cdp.evaluate(turnCall(current().native?.messageId || current().receipt?.messageId || '', runtime.attemptId, current().beforeIds || [], current().native?.generationId || ''));
          if (binding.threadId && turn.threadId !== binding.threadId) {
            updateFusionWindow(context.app, window.id, { ownership: 'changed', observedThread: turn.threadId,
              ownershipReason: '原生执行期间会话已变化', ownershipChangedAt: Date.now() });
            throw new Error('原生执行期间会话归属变化，结果待核对');
          }
          const newlyAccepted = !current().acceptedAt && !!turn.id && turn.accepted !== false;
          if (turn.id && turn.accepted !== false) {
            if (!binding.threadId) {
              binding.threadId = turn.threadId;
              context.threadId = context.selectedThread = turn.threadId;
              updateFusionWindow(context.app, window.id, { expectedThread: turn.threadId, bindingId: binding.id });
            }
            Object.assign(current(), { native: { threadId: turn.threadId, turnId: turn.turnId, messageId: turn.id, ...(turn.generationId ? { generationId: turn.generationId } : {}) },
              submission: 'accepted', acceptedAt: current().acceptedAt || Date.now(), status: runtime.stopping ? 'stopping' : 'running' });
            rememberFusionSession(context.app, binding.threadId, run.project, window.id);
          }
          current().live = { items: (chat?.items || []).filter(item => item.k !== 'human'), questions: chat?.questions || null,
            requests: context.app === 'codex' ? await context.cdp.evaluate(helpersCall('codexRequestData()')) : [], at: Date.now() };
          if (runtime.rejected || turn.error && !runtime.stopping) throw Object.assign(new Error(turn.error || current().nativeError), { nativeEnded: runtime.rejected || !!turn.ended });
          if (runtime.stopping && turn.error) current().nativeError = turn.error;
          if (turn.ended && !turn.completed && !runtime.stopping) throw Object.assign(new Error('原生轮次已结束，但没有完整的最终回复'), { nativeEnded: true });
          if (current().native && (turn.completed || runtime.stopping && turn.ended)) {
            if (this.scheduler.uncertain.get(context.app) === runtime.attemptId) this.scheduler.uncertain.delete(context.app);
            if (this.scheduler.uncertainWriters.get(run.project.id) === runtime.attemptId) this.scheduler.uncertainWriters.delete(run.project.id);
            const endedAt = Date.now();
            Object.assign(current(), { nativeGenerationEndedAt: endedAt, nativeCompletion: { text: turn.text, completed: turn.completed } });
            this.publish(run);
            let accountAfter, contextUsage;
            try { accountAfter = await context.adapter.accountUsage.call(context, { fusion: true, manual: true }, false); }
            catch (error) { accountAfter = { missing: true, error: error.message, updated: Date.now() }; }
            try { contextUsage = chat?.context ?? await context.adapter.usageContext.call(context); }
            catch (error) { contextUsage = { missing: true, error: error.message }; }
            const result = { text: turn.text, completed: turn.completed, stopped: runtime.stopping, native: current().native, endedAt,
              changes: current().kind === 'task' ? await fusionWorkspaceSnapshot(run.project, run.tasks.find(task => task.id === current().taskId).scope) : null,
              usage: { context: contextUsage, accountAfter,
                accountBefore: run.capabilities.find(value => value.app === context.app)?.usage || null,
                actualCost: 'unknown', basis: '账号资料不是单任务费用' } };
            finish(result); return;
          }
          this.publish(run, newlyAccepted);
          if (runtime.stopping && current().native && !runtime.stopSubmitted) await this.stop(runtime.attemptId);
        } catch (error) { finish(null, error); }
        finally { reading = false; if (again && !done) { again = false; runtime.check(); } }
      };
      runtime.unsubscribe = nativeWindow(context.cdp).subscribe(() => runtime.check());
      runtime.check();
    });
  }
  async stop(attemptId) {
    const runtime = this.active.get(attemptId);
    if (!runtime) throw new Error('原生执行尚未重新连接，停止结果待核对');
    runtime.stopping = true;
    if (runtime.stopSubmitted) return;
    const attempt = runtime.run.attempts.find(value => value.id === attemptId);
    const turn = await runtime.context.cdp.evaluate(turnCall(attempt.native?.messageId || attempt.receipt?.messageId || '', attemptId, attempt.beforeIds || [], attempt.native?.generationId || ''));
    if (!turn.id || turn.accepted === false || turn.ended) { runtime.check?.(); return; }
    if (runtime.binding.threadId && turn.threadId !== runtime.binding.threadId) throw new Error('停止目标的原生会话归属已变化');
    if (!turn.current) throw new Error('原生已进入其他轮次，不能停止该轮执行');
    await runtime.context.assertSelectedThread();
    runtime.stopSubmitted = true;
    try { await runtime.context.withFocus(() => runtime.context.stopButton({ sel: runtime.context.selectionKey() })); }
    catch (error) { runtime.stopSubmitted = false; throw error; }
    runtime.check?.();
  }
  async nativeAction(attemptId, action) {
    const runtime = this.active.get(attemptId);
    if (!runtime || runtime.binding.id !== action.bindingId) throw new Error('原生请求已不属于当前执行');
    await runtime.context.assertSelectedThread();
    return runtime.context.withFocus(async () => {
      if (action.kind === 'question') {
        const questions = (await runtime.context.cdp.evaluate(helpersCall('extract()')))?.questions;
        if (JSON.stringify(questions) !== action.questionKey) throw new Error('原生问题已变化，请读取当前问题后回答');
        return runtime.context.answerQuestion(action.qi, action.oi, action.part, action.text);
      }
      if (action.kind === 'codexRequest') {
        const { ROUTES } = await import('../routes.mjs');
        return ROUTES.codexRequest.run(runtime.context, action);
      }
      return runtime.context.clickButton(action.item, action.n, action.actionId, action.label, runtime.context.selectionKey(), action.requestId);
    });
  }
  async archive(run, bindingId) {
    const binding = run.bindings.find(value => value.id === bindingId);
    if (!binding || binding.archived) return;
    const window = await this.windowFor(run, binding.app);
    const release = leaseWindow(binding.app, window.id, this, true);
    let context;
    try {
      context = await this.context(run, binding.app, window);
      await this.assertOwnership(context, window);
      if (binding.app === 'codex') {
        const rows = await context.codexThreadRows();
        const row = rows.find(value => value.id === binding.threadId);
        if (!row || row.running) throw new Error('原生归档目标不存在或仍在运行');
        if (!await context.codexArchiveThread(`thread:${window.id}:${binding.threadId}`, 'Archive chat')) {
          binding.archive = { supported: false, reason: '原生没有归档能力，保留会话' }; return;
        }
        const catalog = await context.cdp.evaluate(helpersCall(`nativeSessionInfo('codex', ${JSON.stringify([binding.threadId])}, true)`));
        if (!catalog?.rows?.some(row => row.id === binding.threadId && row.archived)) throw new Error('原生归档状态尚未确认，保留会话');
      } else {
        const info = await context.cdp.evaluate(helpersCall(`nativeSessionInfo(${JSON.stringify(binding.app)}, ${JSON.stringify(binding.threadId)})`));
        if (!info?.actions?.includes('archive')) { binding.archive = { supported: false, reason: '原生没有归档能力，保留会话' }; return; }
        await context.manageSession(binding.threadId, 'archive');
      }
      binding.archived = true;
      binding.archivedAt = Date.now();
      updateFusionWindow(binding.app, window.id, { expectedThread: await context.cdp.evaluate(helpersCall('activeThread()')) || '' });
    } finally { if (context) this.closeContext(context); release(); this.publish(run); }
  }
}
