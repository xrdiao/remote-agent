import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Cdp } from '../cdp.mjs';
import { NativeCdp, nativeWindow } from '../native-windows.mjs';
import { EDITORS, CODEX_CDP_URL } from '../config.mjs';
import { codexWindows, editorWorkbenches } from '../windows.mjs';
import { editorRoots } from '../../lib/files.mjs';
import { findBin } from '../../lib/platform.mjs';
import { helpersCall } from '../page/build.mjs';
import { rememberFusionSession } from '../project-windows.mjs';
import { fusionProject, fusionLive, publishFusion, fusionEvent } from './state.mjs';
import { nativeCostSnapshot } from './cost.mjs';
import { fusionModelCatalog } from './model-catalog.mjs';
import { FUSION_TOOLS, fusionControllerPrompt, fusionTaskInput } from './control.mjs';
import { fusionScheduler } from './scheduler.mjs';
import { nativeAgentProvider, nativeAgentProviders } from './providers.mjs';
import { favoriteSession, removeLibrarySession, publishSessionChange } from '../../lib/session-library.mjs';

const executeFile = promisify(execFile);

export async function fusionWorkspaceSnapshot(project, scope = []) {
  if (project.host) return { available: false, reason: '远程工作区差异需由原生 Agent 提供证据', at: Date.now() };
  const git = findBin('git');
  const options = { cwd: project.root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 };
  const paths = scope.length ? scope : ['.'];
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
      executeFile(git, ['diff', '--binary', 'HEAD', '--', ...paths], options),
      executeFile(git, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths], options),
    ]);
    const files = await Promise.all(untracked.stdout.split('\0').filter(Boolean).map(async name => ({ path: name,
      sha256: crypto.createHash('sha256').update(await fs.readFile(path.join(project.root, name))).digest('hex') })));
    return { available: true, at: Date.now(), source: '执行边界的 Git 工作区与指定文件快照', status: status.stdout, diff: diff.stdout, untracked: files, files: scopedFiles };
  } catch (error) { return { available: false, at: Date.now(), reason: error.message, files: scopedFiles }; }
}

export class FusionAgent {
  constructor({ scheduler = fusionScheduler, publish = publishFusion, onEvent = () => {}, catalog = fusionModelCatalog } = {}) {
    this.scheduler = scheduler;
    this.catalog = catalog;
    this.publish = publish;
    this.onEvent = onEvent;
    this.active = new Map();
    this.mainProjects = new Map();
  }
  async carriers(app) {
    const editor = EDITORS.find(row => row.app === app);
    if (!editor) throw new Error('未知执行软件');
    if (app === 'codex') return (await codexWindows(CODEX_CDP_URL, false)).filter(row => row.chatWs)
      .map(row => ({ id: row.pageId, app, editorWs: row.ws, ws: row.chatWs, title: row.rawTitle }));
    const pages = await editorWorkbenches(editor.url, 2500);
    return pages
      .map(row => ({ id: row.id, app, editorWs: row.webSocketDebuggerUrl, ws: row.webSocketDebuggerUrl, title: row.title }));
  }
  async softwareCapabilities() {
    return Promise.all(nativeAgentProviders().map(async ({ app, name, controller, worker }) => {
      try { return { app, name, controller, worker, connected: (await this.carriers(app)).length > 0 }; }
      catch (error) { return { app, name, controller, worker, connected: false, reason: error.message }; }
    }));
  }
  async carrierFor(controller, app, project = controller.project, preferred = '') {
    const pages = await this.carriers(app);
    if (!pages.length) throw new Error(`${app} 没有已打开且就绪的原生窗口`);
    let page = preferred && pages.find(row => row.id === preferred.replace(/^(cursor|devin|codex):/, ''));
    if (preferred && !page) throw new Error('绑定的原生窗口已关闭，实际执行结果需要核对');
    if (!page) for (const candidate of pages) {
      const editor = new Cdp(candidate.editorWs);
      try {
        await editor.connect();
        if ((await editorRoots(editor, app)).some(root => fusionProject(root.root, root.host || '')?.id === project.id)) { page = candidate; break; }
      } finally { editor.close(); }
    }
    // Cursor stores project sessions in its project window; Codex and Devin accept cwd in native creation.
    if (!page && app !== 'cursor') page = pages[0];
    if (!page) {
      const { Session } = await import('../session.mjs');
      const projectSession = new Session({ readyState: 1, send() {} }, controller.deviceId, { fusionBinding: true });
      projectSession.app = app;
      try {
        if (project.host) await projectSession.attach({ id: app, project });
        else await projectSession.withFocus(() => projectSession.useProject(project.root, false));
        if (projectSession.pendingProject?.trust) throw new Error('请先在原生应用中确认该项目的信任请求');
        if (!projectSession.bindingReady) throw new Error('项目原生窗口尚未就绪');
        const windowId = projectSession.windowId.replace(/^(cursor|devin|codex):/, '');
        page = (await this.carriers(app)).find(row => row.id === windowId);
        if (!page) throw new Error('所选项目的原生窗口已关闭');
      } finally { projectSession.dispose(); }
    }
    const cdp = new NativeCdp(page.ws, app);
    await cdp.connect();
    const source = nativeWindow(cdp);
    source.win ||= { app, id: page.id, pageId: page.id, ws: page.ws, editorWs: page.editorWs };
    const threadId = await cdp.evaluate(helpersCall('activeThread()')) || '';
    let native;
    if (threadId) native = await cdp.evaluate(helpersCall(`nativeSessionInfo(${JSON.stringify(app)}, ${JSON.stringify(threadId)}, 'context')`));
    else native = { app, threadId: '', host: project.host || '', cwd: '', roots: [] };
    return { app, page, cdp, source, native, leaseId: crypto.randomUUID() };
  }
  call(context, code, native = context.native) {
    return context.app === 'codex' ? context.source.composerCall(code, native) : context.cdp.evaluate(helpersCall(code, native));
  }
  async close(context) {
    if (!context) return;
    if (context.pinned && context.app === 'cursor')
      await this.call(context, `nativeSessionAction('cursor', ${JSON.stringify(context.native.threadId)}, 'release', ${JSON.stringify(context.leaseId)})`);
    context.cdp.close();
    const source = context.source;
    if (!source.watching && !source.clients.size && !source.conversations.size && !source.listeners.size) source.close();
  }
  async openBinding(controller, binding, windowId = binding.windowId) {
    const context = await this.carrierFor(controller, binding.app, binding.project, windowId);
    try {
      context.native = { app: binding.app, threadId: binding.threadId, host: binding.host || '', cwd: binding.project.root,
        roots: [{ root: binding.project.root, host: binding.host || '' }] };
      const actual = await nativeAgentProvider(binding.app).info(this, context, 'bind', context.leaseId);
      context.pinned = binding.app === 'cursor';
      if (fusionProject(actual.cwd, actual.host || '')?.id !== binding.project.id) throw new Error('原生会话目录与该任务项目不一致，未切换任何普通窗口');
      context.native = actual;
      return context;
    } catch (error) { await this.close(context); throw error; }
  }
  async prepareProject(controller, selection = {}) {
    const { Session } = await import('../session.mjs');
    let context = this.mainProjects.get(controller.id);
    if (selection.action === 'projectTrust') {
      if (!context) throw new Error('原生项目选择已结束，请重新打开项目');
      await context.confirmProjectTrust(selection.approve === true);
      if (!selection.approve) { this.releaseMainProject(controller); return { declined: true }; }
    } else {
      this.releaseMainProject(controller);
      context = new Session({ readyState: 1, send: raw => {
        const message = JSON.parse(raw);
        if (message.t === 'status' && message.ok === false) context.projectError = message.msg;
      } }, controller.deviceId, { fusionBinding: true });
      context.app = controller.main.app;
      this.mainProjects.set(controller.id, context);
      if (controller.project.host) await context.attach({ id: controller.main.app, project: controller.project });
      else await context.withFocus(() => context.useProject(controller.project.root, false));
    }
    if (context.pendingProject?.trust) return { trust: { path: context.pendingProject.root } };
    if (!context.bindingReady) throw new Error(context.projectError || '项目原生窗口尚未就绪');
    controller.main.windowId = context.windowId.replace(/^(cursor|devin|codex):/, '');
    this.publish(controller);
    this.releaseMainProject(controller);
    return { windowId: controller.main.windowId };
  }
  releaseMainProject(controller) {
    const context = this.mainProjects.get(controller.id);
    this.mainProjects.delete(controller.id);
    context?.dispose();
  }
  async capabilities(controller, app, { knowledge = false } = {}) {
    const main = controller.bindings.find(row => row.id === controller.main.bindingId);
    const context = await this.carrierFor(controller, app, controller.project,
      app === controller.main.app ? main?.windowId || controller.main.windowId || '' : '');
    try {
      if (context.native.threadId && app !== 'codex') {
        await nativeAgentProvider(app).info(this, context, 'bind', context.leaseId);
        context.pinned = app === 'cursor';
      }
      const models = await nativeAgentProvider(app).models(this, context);
      if (!models?.length) throw new Error('未读取到当前窗口实际原生模型候选');
      if (knowledge) await this.catalog.refresh(models.map(model => ({ app, model: model.id })));
      return this.catalog.enrich(nativeCostSnapshot(app, models, { available: false, reason: '未读取账号账单；不能推算子任务费用' },
        { windowId: context.page.id, host: context.native.host, read: 'native-model-catalog' }));
    } finally { await this.close(context); }
  }
  async createBinding(controller, owner, app, project, role, spec, preferred = '') {
    const ownerId = role === 'main' ? '' : owner.id;
    const currentOwner = () => role === 'main' ? controller.main : controller.agents.find(row => row.id === ownerId);
    const context = await this.carrierFor(controller, app, project, preferred);
    try {
      currentOwner().creations ||= [];
      let creation = currentOwner().creations.findLast(row => row.app === app && row.projectId === project.id && !['rejected', 'bound'].includes(row.status));
      let actual;
      if (creation) {
        const record = await nativeAgentProvider(app).info(this, context, 'creation', creation.id);
        if (!record) throw Object.assign(new Error('后台创建结果无法确认，不能重新创建会话'), { creationUnknown: true });
        if (record.status === 'rejected') { creation.status = 'rejected'; creation.error = record.error; this.publish(controller); throw new Error(record.error); }
        actual = record.context;
        if (!actual && record.nativeThreadId) actual = await nativeAgentProvider(app).info(this,
          { ...context, native: { ...context.native, threadId: record.nativeThreadId, host: project.host || '' } }, 'context');
        if (!actual) throw Object.assign(new Error('原生仍在创建会话，结果待核对'), { creationUnknown: true });
      } else {
        creation = { id: crypto.randomUUID(), app, projectId: project.id, windowId: context.page.id, status: 'creating', startedAt: Date.now() };
        currentOwner().creations.push(creation); this.publish(controller);
        try {
          actual = await nativeAgentProvider(app).create(this, { ...context, native: { ...context.native, host: project.host || '' } }, {
            ...spec, role, requestId: creation.id, root: project.root, threadId: crypto.randomUUID(),
          }, controller, creation);
        } catch (error) {
          const pending = currentOwner().creations.find(row => row.id === creation.id);
          pending.error = error.message; pending.status = 'unknown'; this.publish(controller);
          throw Object.assign(error, { creationUnknown: true });
        }
      }
      if (fusionProject(actual.cwd, actual.host || '')?.id !== project.id) {
        creation.status = 'rejected'; creation.error = '新原生会话的实际项目不匹配，未提交任务';
        this.publish(controller);
        throw new Error(creation.error);
      }
      const binding = { id: crypto.randomUUID(), role, app, windowId: context.page.id, threadId: actual.threadId,
        host: actual.host || '', project, nativeProject: actual, created: Date.now(),
        ...(creation.mcp ? { mcp: creation.mcp } : {}) };
      controller.bindings.push(binding); currentOwner().bindingId = binding.id;
      creation = currentOwner().creations.find(row => row.id === creation.id);
      creation.status = 'bound'; creation.bindingId = binding.id;
      this.publish(controller);
      rememberFusionSession(app, binding.threadId, project, binding.windowId);
      return binding;
    } finally { await this.close(context); }
  }
  async prepareMain(controller) {
    if (!nativeAgentProvider(controller.main.app).controller) throw new Error('这个软件尚未提供原生主控工具');
    if (controller.main.bindingId) return controller.bindings.find(row => row.id === controller.main.bindingId);
    if (!controller.main.windowId) await this.prepareProject(controller);
    return this.createBinding(controller, controller.main, controller.main.app, controller.project, 'main',
      { title: controller.title, model: controller.main.model, effort: controller.main.effort,
        instructions: fusionControllerPrompt(controller), tools: FUSION_TOOLS }, controller.main.windowId);
  }
  async workerBinding(controller, task, assignment) {
    const agent = controller.agents.find(row => row.id === task.workerId), work = controller.works.find(row => row.id === task.workId);
    const binding = controller.bindings.find(row => row.id === agent.bindingId && row.app === assignment.app && row.project.id === work.project.id);
    if (binding) return binding;
    const main = controller.bindings.find(row => row.id === controller.main.bindingId);
    return this.createBinding(controller, agent, assignment.app, work.project, 'worker', { title: `Fusion · ${task.goal}`,
      model: assignment.model, effort: assignment.effort },
      assignment.app === controller.main.app ? main.windowId : '');
  }
  async configure(context, controller, attempt) {
    const model = controller.capabilities.find(row => row.app === attempt.app)?.models.find(row => row.model === attempt.model);
    const provider = nativeAgentProvider(attempt.app), current = await provider.info(this, context, 'settings');
    if (current.model !== attempt.model) await provider.action(this, context, 'model', attempt.model);
    if (attempt.effort) await provider.action(this, context, 'effort', attempt.effort);
    const actual = await provider.info(this, context, 'settings');
    if (actual.model !== attempt.model && (!model?.family || actual.family !== model.family)) throw new Error('原生未确认选中任务模型');
    if (attempt.effort && actual.effort !== attempt.effort) throw new Error('原生未确认任务思考强度');
    return actual;
  }
  async execute(controller, attemptId, prompt, recovering = false) {
    const current = () => controller.attempts.find(row => row.id === attemptId);
    const cancelled = () => controller.stopRequested || current().status === 'cancelled'
      || controller.tasks.find(row => row.id === current().taskId)?.stopRequested;
    const task = controller.tasks.find(row => row.id === current().taskId);
    const assignment = controller.assignments.find(row => row.id === current().assignmentId);
    const work = task && controller.works.find(row => row.id === task.workId);
    const binding = current().kind === 'main' ? controller.bindings.find(row => row.id === controller.main.bindingId)
      : await this.workerBinding(controller, task, assignment);
    current().bindingId = binding.id; this.publish(controller);
    const context = await this.openBinding(controller, binding);
    const runtime = { controller, attemptId, binding, context,
      stopping: controller.stopRequested || task?.stopRequested || current().status === 'stopping' };
    this.active.set(attemptId, runtime);
    try {
      if (!recovering) {
        if (cancelled()) throw Object.assign(new Error('未提交的任务已取消'), { cancelled: true });
        if (task) await this.configure(context, controller, current());
        const before = await nativeAgentProvider(binding.app).readTurn(this, context);
        if (task) {
          const input = fusionTaskInput(controller, task, current());
          prompt = input.prompt; current().promptContext = input.context;
        }
        Object.assign(current(), { beforeIds: before.ids, beforeTurnId: before.turnId || '', prompt,
          baseline: task ? await fusionWorkspaceSnapshot(work.project, task.scope) : null, status: 'preparing' });
        this.publish(controller);
      }
      const observing = this.observe(runtime, recovering);
      if (!recovering) {
        await context.source.conversationView(context.native).watching;
        if (runtime.error) throw runtime.error;
        if (cancelled()) { runtime.cancelBeforeSend(); return observing; }
        Object.assign(current(), { status: 'submitting', submission: 'submitting', submittedAt: Date.now() }); this.publish(controller);
        try {
          await nativeAgentProvider(binding.app).action(this, context, 'send', { text: prompt, requestId: attemptId });
        } catch (error) { runtime.fail(error); }
        runtime.check();
      }
      return await observing;
    } finally {
      runtime.unsubscribe?.(); this.active.delete(attemptId);
      await this.close(context);
    }
  }
  observe(runtime, recovering) {
    const { controller, context, binding, attemptId } = runtime;
    const current = () => controller.attempts.find(row => row.id === attemptId);
    return new Promise((resolve, reject) => {
      let reading = false, again = false, done = false;
      const finish = (result, error) => { if (done) return; done = true; runtime.unsubscribe?.(); error ? reject(error) : resolve(result); };
      runtime.fail = error => { runtime.error = error; finish(null, error); };
      runtime.cancelBeforeSend = () => finish(null, Object.assign(new Error('未提交的任务已取消'), { cancelled: true }));
      context.cdp.onclose = error => finish(null, error);
      runtime.check = async () => {
        if (done) return;
        if (reading) { again = true; return; }
        reading = true;
        try {
          const provider = nativeAgentProvider(binding.app);
          const turn = await provider.readTurn(this, context, { id: current().native?.messageId || '', attemptId,
            previous: current().beforeIds || [], generationId: current().native?.generationId || '' });
          const nativeError = await provider.info(this, context, 'sendError', attemptId);
          if (turn.threadId !== binding.threadId) throw new Error('原生结果身份与 Binding 不一致');
          let snapshot = {};
          if (!turn.ended) {
            try {
              snapshot = await context.source.readConversation(context.native, true);
              delete current().contentError;
              fusionLive.set(binding.id, { ...snapshot, at: Date.now() });
            } catch (error) {
              current().contentError = error.message;
              fusionLive.delete(binding.id);
            }
          }
          if (snapshot.state?.waiting) {
            const id = `native-question:${attemptId}:${snapshot.state.waiting}`;
            if (!controller.events.some(event => event.id === id)) {
              fusionEvent(controller, 'native_question', { workId: current().workId, taskId: current().taskId,
                attemptId, bindingId: binding.id, text: snapshot.state.waitingText, nativeRequest: snapshot.state.waiting }, id);
              this.publish(controller); this.onEvent();
            }
          }
          const generationId = turn.generationId || current().native?.generationId || '';
          if (turn.id && turn.accepted !== false) {
            if (current().kind === 'main' && !current().acceptedAt) {
              const settings = await provider.info(this, context, 'settings');
              current().model = controller.main.model = settings.model;
              current().effort = controller.main.effort = settings.effort || '';
            }
            Object.assign(current(), { native: { threadId: binding.threadId, turnId: turn.turnId || snapshot.state?.run?.id,
              messageId: turn.id, generationId: binding.app === 'devin' ? generationId : turn.generationId || '' },
              submission: 'accepted', acceptedAt: current().acceptedAt || Date.now(), status: runtime.stopping ? 'stopping' : 'running' });
            const task = controller.tasks.find(row => row.id === current().taskId);
            if (task && !current().acceptanceSaved) for (const input of task.inputs.filter(row => current().inputIds?.includes(row.id)))
              Object.assign(input, { deliveredAt: current().acceptedAt, attemptId, nativeTurnId: current().native.turnId });
            if (task) task.status = snapshot.chat?.questions?.requests?.length || snapshot.chat?.questions?.list?.length || snapshot.state?.waiting ? 'awaiting_user' : 'running';
            const agent = task && controller.agents.find(row => row.id === task.workerId);
            if (agent) agent.status = task.status;
            this.publish(controller, !current().acceptanceSaved);
            current().acceptanceSaved = true;
          }
          if (turn.ended || snapshot.state?.run?.status === 'error' && current().native?.turnId === snapshot.state.run.id) {
            const endedAt = Date.now();
            current().nativeGenerationEndedAt = endedAt;
            const task = controller.tasks.find(row => row.id === current().taskId), work = task && controller.works.find(row => row.id === task.workId);
            const settings = await provider.info(this, context, 'settings');
            const result = { text: turn.text || '', completed: !!turn.completed, stopped: runtime.stopping, error: turn.error || (snapshot.state?.run?.status === 'error' ? '原生执行失败' : ''),
              native: current().native, endedAt, changes: task ? await fusionWorkspaceSnapshot(work.project, task.scope) : null,
              usage: { native: settings.usage, observedAt: endedAt,
                basis: settings.usageBasis || '原生未提供可读取的会话用量', actualCost: 'unknown' } };
            finish(result); return;
          }
          if (nativeError?.status === 'error') throw Object.assign(new Error(nativeError.message), { nativeRejected: nativeError.outcome === 'rejected' });
          if (recovering && !turn.id && current().submission === 'submitting') throw new Error('未找到可核对的原生接受事实，不能自动重发');
          if (runtime.stopping && current().native) await this.stop(attemptId);
          this.publish(controller, false);
        } catch (error) { finish(null, error); }
        finally { reading = false; if (again && !done) { again = false; runtime.check(); } }
      };
      runtime.unsubscribe = context.source.subscribe(error => error ? finish(null, error) : runtime.check(), context.native);
      if (recovering) runtime.check();
    });
  }
  async stop(attemptId) {
    const runtime = this.active.get(attemptId);
    if (!runtime) throw new Error('原生执行尚未重新观察，停止结果待核对');
    runtime.stopping = true;
    if (runtime.stopSubmitted) return;
    const attempt = runtime.controller.attempts.find(row => row.id === attemptId);
    const provider = nativeAgentProvider(runtime.binding.app);
    const turn = await provider.readTurn(this, runtime.context, { id: attempt.native?.messageId || '', attemptId, previous: attempt.beforeIds || [], generationId: attempt.native?.generationId || '' });
    if (turn.ended) { runtime.check(); return; }
    if (!turn.current || !attempt.native || turn.turnId && turn.turnId !== attempt.native.turnId) throw new Error('原生已不在该任务轮次，不能停止其他执行');
    await provider.action(this, runtime.context, 'stop');
    runtime.stopSubmitted = true; runtime.check();
  }
  async nativeAction(controller, attemptId, action) {
    const attempt = controller.attempts.find(row => row.id === attemptId);
    if (!attempt || attempt.bindingId !== action.bindingId) throw new Error('请求不属于这个任务 Binding');
    if (attempt.endedAt) throw new Error('该次执行已结束，不能处理其它执行的原生交互');
    const binding = controller.bindings.find(row => row.id === attempt.bindingId), context = await this.openBinding(controller, binding);
    try {
      if (binding.app === 'codex' && action.kind === 'codexRequest')
        return this.call(context, `codexRequestAction(${JSON.stringify(String(action.id))}, ${Number(action.n)}, ${JSON.stringify(action.fields || [])})`);
      if (binding.app === 'devin' && action.kind === 'codexRequest' || ['cursor', 'devin'].includes(binding.app) && action.kind === 'question')
        return this.call(context, `nativeSessionAction(${JSON.stringify(binding.app)}, ${JSON.stringify(binding.threadId)}, 'question', ${JSON.stringify(action)})`);
      if (binding.app === 'cursor' && action.kind === 'button')
        return this.call(context, `nativeSessionAction('cursor', ${JSON.stringify(binding.threadId)}, 'permission', ${JSON.stringify(action.actionId)})`);
      throw new Error('该原生交互尚无不切换普通会话的后台接口');
    } finally { await this.close(context); }
  }
  async readBinding(controller, bindingId, history = false, before = null) {
    const binding = controller.bindings.find(row => row.id === bindingId);
    if (!binding) throw new Error('没有这个原生 Binding');
    const context = await this.openBinding(controller, binding, '');
    try {
      return { binding, chat: await nativeAgentProvider(binding.app).content(this, context, history, before) };
    } finally { await this.close(context); }
  }
  async renameMain(controller, title) {
    if (!controller.main.bindingId) return { title };
    const binding = controller.bindings.find(row => row.id === controller.main.bindingId && row.role === 'main' && row.app === controller.main.app);
    if (!binding) throw new Error('没有这个原生 Binding');
    const context = await this.carrierFor(controller, binding.app, binding.project);
    context.native = { app: binding.app, threadId: binding.threadId, host: binding.project.host || '', cwd: binding.project.root };
    try {
      const provider = nativeAgentProvider(binding.app);
      let state = await provider.info(this, context, 'name');
      if (!state.exists) throw new Error('没有找到这个会话');
      if (fusionProject(state.context.cwd, state.context.host || '')?.id !== binding.project.id)
        throw new Error('原生会话目录与该任务项目不一致，未切换任何普通窗口');
      let expected = title;
      if (state.title !== title) {
        const result = await provider.action(this, context, 'rename', title);
        if (!result?.confirmed) throw new Error('桌面端尚未确认会话操作完成，请刷新列表查看');
        expected = result.title;
        state = await provider.info(this, context, 'name');
      }
      if (!state.exists || !state.title || state.title !== expected) throw new Error('桌面端尚未确认会话操作完成，请刷新列表查看');
      publishSessionChange(binding.app, binding.threadId, { action: 'rename', title: state.title });
      return { confirmed: true, title: state.title, app: binding.app, threadId: binding.threadId };
    } finally { await this.close(context); }
  }
  async cleanupBinding(controller, binding) {
    const context = await this.carrierFor(controller, binding.app, binding.project);
    context.native = { app: binding.app, threadId: binding.threadId, host: binding.project.host || '', cwd: binding.project.root };
    try {
      const provider = nativeAgentProvider(binding.app), state = await provider.cleanupState(this, context);
      if (state.running) throw new Error('原生会话仍在运行，请先停止并核对');
      if (state.exists && fusionProject(state.context.cwd, state.context.host || '')?.id !== binding.project.id)
        throw new Error('原生会话目录与该 Binding 项目不一致，未执行清理');
      const result = await provider.cleanup(this, context);
      if (result?.confirmed !== true || !['delete', 'archive'].includes(result.action)) throw new Error('桌面端尚未确认删除或归档完成');
      if (result.action === 'delete') removeLibrarySession(binding.app, binding.threadId);
      else favoriteSession(binding.app, binding.threadId, false);
      publishSessionChange(binding.app, binding.threadId, { action: result.action });
      return { ...result, app: binding.app, threadId: binding.threadId, at: Date.now() };
    } finally { await this.close(context); }
  }
}
