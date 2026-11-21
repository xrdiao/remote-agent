import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Cdp, cdpRead } from '../cdp.mjs';
import { NativeCdp, nativeWindow } from '../native-windows.mjs';
import { EDITORS, CODEX_CDP_URL } from '../config.mjs';
import { codexWindows, editorWorkbenches } from '../windows.mjs';
import { editorRoots } from '../../lib/files.mjs';
import { findBin, localFilePath } from '../../lib/platform.mjs';
import { helpersCall } from '../page/build.mjs';
import { rememberFusionSession } from '../project-windows.mjs';
import { fusionProject, fusionLive, publishFusion, fusionEvent } from './state.mjs';
import { nativeCostSnapshot } from './cost.mjs';
import { fusionModelCatalog } from './model-catalog.mjs';
import { FUSION_TOOLS, fusionControllerPrompt, fusionTaskInput } from './control.mjs';
import { fusionScheduler } from './scheduler.mjs';
import { backgroundCodex, nativeAgentProvider, nativeAgentProviders } from './providers.mjs';
import { fusionOpenCode } from './opencode.mjs';
import { CODEX_BACKEND, codexBackend } from '../codex/state.mjs';
import { favoriteSession, removeLibrarySession, publishSessionChange } from '../../lib/session-library.mjs';

const executeFile = promisify(execFile);
const providerFor = context => context.backend === CODEX_BACKEND ? backgroundCodex : nativeAgentProvider(context.app);

export async function fusionWorkspaceSnapshot(project, scope = []) {
  if (project.host) return { available: false, reason: '远程工作区差异需由原生 Agent 提供证据', at: Date.now() };
  const git = findBin('git');
  const root = localFilePath(project.root);
  const options = { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true };
  const paths = scope.length ? scope.map(value => localFilePath(value)) : ['.'];
  const scopedFiles = await Promise.all(scope.map(async name => {
    const file = path.resolve(root, localFilePath(name));
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
      sha256: crypto.createHash('sha256').update(await fs.readFile(path.join(root, name))).digest('hex') })));
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
      try { return { app, name, controller, worker, connected: app === 'opencode'
        ? await fusionOpenCode.connected() : (await this.carriers(app)).length > 0 }; }
      catch (error) { return { app, name, controller, worker, connected: false, reason: error.message }; }
    }));
  }
  async carrierFor(controller, app, project = controller.project, preferred = '', { prepare = false } = {}) {
    let pages = await this.carriers(app);
    if (prepare && app === 'codex' && !project.host) {
      const ready = await Promise.allSettled(pages.map(async page => {
        const cdp = new Cdp(page.ws);
        try {
          await cdp.connect();
          return await cdp.evaluate(helpersCall("nativeSessionInfo('codex', '', 'creationReady')")) ? page : null;
        } finally { cdp.close(); }
      }));
      pages = ready.flatMap(row => row.status === 'fulfilled' && row.value ? [row.value] : []);
      if (!pages.length) throw new Error('已打开的 Codex 面板未提供 Fusion 所需的原生会话管理接口');
    }
    if (prepare && app === 'devin' && !project.host) {
      const editorPages = await Promise.all(pages.map(async page => {
        const editor = new Cdp(page.editorWs);
        try { await editor.connect(); return await editor.evaluate(helpersCall('devinSurface()')) === 'editor' ? page : null; }
        finally { editor.close(); }
      }));
      pages = editorPages.filter(Boolean);
      if (!pages.length) throw new Error('请先打开 Devin 的 Editor 窗口，再创建工作台');
    }
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
    if (!page && app === 'cursor' && !project.host) {
      for (const candidate of pages.filter(row => row.title === 'Cursor Agents')) {
        const cdp = new Cdp(candidate.ws);
        try {
          await cdp.connect();
          if (await cdp.evaluate(helpersCall(`nativeSessionInfo('cursor', '', 'projectPlacement', ${JSON.stringify(project.root)})`))) {
            page = candidate;
            break;
          }
        } finally { cdp.close(); }
      }
    }
    // Codex and Devin accept a working directory independently of the editor's folder.
    if (!page && app !== 'cursor') page = pages[0];
    if (!page && prepare) return null;
    if (!page) {
      const { Session } = await import('../session.mjs');
      const projectSession = new Session({ readyState: 1, send() {} }, controller.deviceId, { fusionBinding: true });
      projectSession.app = app;
      try {
        if (project.host) await projectSession.attach({ id: app, project });
        else await projectSession.withFocus(() => projectSession.useProject(project.root, false, '', '', '', { reuseOnly: true }));
        if (projectSession.pendingProject?.trust) throw new Error('请先在原生应用中确认该项目的信任请求');
        if (!projectSession.bindingReady) throw new Error('项目原生窗口尚未就绪');
        const windowId = projectSession.windowId.replace(/^(cursor|devin|codex):/, '');
        page = (await this.carriers(app)).find(row => row.id === windowId);
        if (!page) throw new Error('所选项目的原生窗口已关闭');
      } finally { projectSession.dispose(); }
    }
    return this.openCarrier(page, project);
  }
  async openCarrier(page, project, active = true) {
    const { app } = page;
    const cdp = new NativeCdp(page.ws, app);
    const source = nativeWindow(cdp);
    try {
      await cdp.connect();
      source.win ||= { app, id: page.id, pageId: page.id, ws: page.ws, editorWs: page.editorWs };
      const threadId = active ? await cdp.evaluate(helpersCall('activeThread()')) || '' : '';
      const native = threadId && app !== 'devin' ? await cdp.evaluate(helpersCall(`nativeSessionInfo(${JSON.stringify(app)}, ${JSON.stringify(threadId)}, 'context')`))
        : { app, threadId: '', host: project.host || '', cwd: '', roots: [] };
      if (app === 'devin') native.threadId = threadId;
      return { app, page, cdp, source, native, leaseId: crypto.randomUUID() };
    } catch (error) { await this.close({ cdp, source }); throw error; }
  }
  call(context, code, native = context.native) {
    return context.app === 'codex' ? context.source.composerCall(code, native) : context.cdp.evaluate(helpersCall(code, native));
  }
  async close(context) {
    if (!context || context.backend) return;
    if (context.pinned && context.app === 'cursor')
      await this.call(context, `nativeSessionAction('cursor', ${JSON.stringify(context.native.threadId)}, 'release', ${JSON.stringify(context.leaseId)})`);
    context.cdp.close();
    const source = context.source;
    if (!source.watching && !source.clients.size && !source.conversations.size && !source.listeners.size) source.close();
  }
  async openBinding(controller, binding, windowId = binding.windowId) {
    if (binding.app === 'opencode') return fusionOpenCode.open(binding);
    if (binding.app === 'codex' && binding.windowId === CODEX_BACKEND) {
      const context = await backgroundCodex.open(binding.threadId);
      if (fusionProject(context.native.cwd)?.id !== binding.project.id) throw new Error('后台 Codex 会话目录与该任务项目不一致');
      return context;
    }
    if (binding.role === 'main') {
      const pages = await this.carriers(binding.app);
      const previous = pages.find(page => page.id === binding.windowId.replace(/^(cursor|devin|codex):/, ''));
      const errors = [];
      for (const page of [previous, ...pages.filter(row => row !== previous)].filter(Boolean)) {
        try { return await this.bindCarrier(binding, await this.openCarrier(page, binding.project, false)); }
        catch (error) { errors.push(error.message); }
      }
      throw new Error(`${binding.app} 主会话的原生工具未连接：${errors[0] || '没有已打开的原生窗口'}`);
    }
    const context = await this.carrierFor(controller, binding.app, binding.project, binding.reuseWindow ? binding.windowId : windowId);
    return this.bindCarrier(binding, context);
  }
  async bindCarrier(binding, context) {
    try {
      context.native = { app: binding.app, threadId: binding.threadId, host: binding.host || '', cwd: binding.project.root,
        roots: [{ root: binding.project.root, host: binding.host || '' }] };
      const provider = nativeAgentProvider(binding.app);
      if (binding.role === 'main') {
        const identity = await provider.info(this, context, 'context');
        if (identity.threadId !== binding.threadId || fusionProject(identity.cwd, identity.host || '')?.id !== binding.project.id)
          throw new Error('这个窗口未找到同一主会话及项目');
      }
      const actual = await provider.info(this, context, 'bind', context.leaseId);
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
      if (!controller.project.host) {
        const carrier = await this.carrierFor(controller, controller.main.app, controller.project, '', { prepare: true });
        try {
          if (carrier) {
            const { required } = await carrier.cdp.evaluate(helpersCall('workspaceTrustState()'));
            if (!required) {
              if (controller.main.app === 'devin' && !await carrier.cdp.evaluate(helpersCall('hasComposer()'))) {
                const session = new Session({ readyState: 1, send() {} }, controller.deviceId, { fusionBinding: true });
                try {
                  const page = carrier.page, id = `devin:${page.id}`;
                  await session.openBound({ ...page, id }, page.editorWs, null, { windowId: id, deferred: true });
                  session.switchingThread = true;
                  await session.openEditorChat();
                } finally { session.dispose(); }
              }
              controller.main.windowId = carrier.page.id;
              this.publish(controller);
              return { windowId: controller.main.windowId };
            }
            if (controller.main.app !== 'cursor') throw new Error('请先在原生应用中确认工作区信任');
          }
        } finally { await this.close(carrier); }
      }
      context = new Session({ readyState: 1, send: raw => {
        const message = JSON.parse(raw);
        if (message.t === 'status' && message.ok === false) context.projectError = message.msg;
      } }, controller.deviceId, { fusionBinding: true });
      context.app = controller.main.app;
      this.mainProjects.set(controller.id, context);
      if (controller.project.host) await context.attach({ id: controller.main.app, project: controller.project });
      else await context.withFocus(() => context.useProject(controller.project.root, false, '', '', '', { reuseOnly: true }));
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
  async capabilities(controller, app, { worker = false } = {}) {
    if (app === 'opencode' && worker) {
      if (controller.project.host) throw new Error('OpenCode 仅支持本机 Fusion 子任务');
      const models = await fusionOpenCode.models(controller.project.root);
      return this.catalog.enrich(nativeCostSnapshot(app, models, null, { windowId: fusionOpenCode.windowId, host: '', read: 'native-model-catalog' }));
    }
    if (worker && app === 'codex' && !controller.project.host) {
      const models = await backgroundCodex.models();
      if (!models.length) throw new Error('未读取到 Codex 后台模型候选');
      return this.catalog.enrich({ ...nativeCostSnapshot(app, models, null, { windowId: CODEX_BACKEND, host: '', read: 'native-model-catalog' }),
        source: 'Codex 后台模型目录' });
    }
    if (worker && !controller.project.host) {
      const pages = await this.carriers(app);
      let error = new Error(`${app} 未提供已打开窗口的原生模型`);
      const deadline = AbortSignal.timeout(5000);
      for (const page of pages) {
        let context;
        try {
          const models = await cdpRead.run(deadline, async () => {
            context = await this.openCarrier(page, controller.project, false);
            return nativeAgentProvider(app).models(this, context);
          });
          if (models?.length) return this.catalog.enrich(nativeCostSnapshot(app, models, null,
            { windowId: page.id, host: '', read: 'native-model-catalog' }));
        } catch (failure) {
          if (deadline.aborted) throw new Error(`${app} 已打开，但原生模型目录读取超时`);
          error = failure;
        }
        finally { await this.close(context); }
      }
      throw error;
    }
    const main = controller.bindings.find(row => row.id === controller.main.bindingId);
    const context = await this.carrierFor(controller, app, controller.project,
      app === controller.main.app ? main?.windowId || controller.main.windowId || '' : '');
    try {
      if (context.native.threadId && app === 'cursor') {
        await nativeAgentProvider(app).info(this, context, 'bind', context.leaseId);
        context.pinned = true;
      }
      let models = await nativeAgentProvider(app).models(this, context), sourceWindow = context.page.id;
      let catalogError;
      if (app === 'devin' && !context.native.threadId && !models?.length) {
        for (const page of (await this.carriers('devin')).filter(row => row.id !== context.page.id)) {
          const cdp = new NativeCdp(page.ws, 'devin');
          try {
            await cdp.connect();
            models = await cdp.evaluate(helpersCall('modelItemsFast(true)', context.native), { timeout: 5000 });
            if (models?.length) { sourceWindow = page.id; break; }
          } catch (error) { catalogError = error; }
          finally { cdp.close(); }
        }
      }
      if (!models?.length) throw catalogError || new Error('未读取到当前窗口实际原生模型候选');
      return this.catalog.enrich(nativeCostSnapshot(app, models, { available: false, reason: '未读取账号账单；不能推算子任务费用' },
        { windowId: sourceWindow, host: context.native.host, read: 'native-model-catalog' }));
    } finally { await this.close(context); }
  }
  async createBinding(controller, owner, app, project, role, spec, preferred = '') {
    const ownerId = role === 'main' ? '' : owner.id;
    const currentOwner = () => role === 'main' ? controller.main : controller.agents.find(row => row.id === ownerId);
    let creation = currentOwner().creations?.findLast(row => row.app === app && row.projectId === project.id && !['rejected', 'bound'].includes(row.status));
    const backend = app === 'opencode' ? fusionOpenCode.windowId
      : app === 'codex' && role === 'worker' && !project.host && (!creation || creation.windowId === CODEX_BACKEND) ? CODEX_BACKEND : '';
    if (app === 'opencode' && project.host) throw new Error('OpenCode 仅支持本机 Fusion 子任务');
    const context = backend ? { app, backend, page: { id: backend }, native: { app, threadId: '', host: '' } }
      : await this.carrierFor(controller, app, project, creation?.windowId || preferred);
    const provider = providerFor(context);
    try {
      currentOwner().creations ||= [];
      let actual;
      if (creation && backend) {
        if (!creation.nativeThreadId) throw Object.assign(new Error(`${app} 后台创建结果无法确认，不能重新创建会话`), { creationUnknown: true });
        actual = (backend === CODEX_BACKEND ? await backgroundCodex.open(creation.nativeThreadId)
          : await fusionOpenCode.open({ threadId: creation.nativeThreadId, project })).native;
      } else if (creation) {
        const record = await provider.info(this, context, 'creation', creation.id);
        if (!record) throw Object.assign(new Error('后台创建结果无法确认，不能重新创建会话'), { creationUnknown: true });
        if (record.status === 'rejected') { creation.status = 'rejected'; creation.error = record.error; this.publish(controller); throw new Error(record.error); }
        actual = record.context;
        if (!actual && record.nativeThreadId) actual = await provider.info(this,
          { ...context, native: { ...context.native, threadId: record.nativeThreadId, host: project.host || '' } }, 'context');
        if (!actual) throw Object.assign(new Error('原生仍在创建会话，结果待核对'), { creationUnknown: true });
      } else {
        const workspacePlacement = app === 'cursor' && !project.host ? await provider.info(this, context, 'projectPlacement', project.root) : null;
        if (app === 'cursor' && !project.host && !workspacePlacement) throw new Error('Cursor 原生窗口尚未确认所选项目');
        creation = { id: crypto.randomUUID(), app, projectId: project.id, windowId: context.page.id, status: 'creating', startedAt: Date.now() };
        currentOwner().creations.push(creation); this.publish(controller);
        try {
          actual = await provider.create(this, { ...context, native: { ...context.native, host: project.host || '' } }, {
            ...spec, role, requestId: creation.id, root: project.root, threadId: crypto.randomUUID(), workspacePlacement,
          }, controller, creation);
          if (backend) { creation.nativeThreadId = actual.threadId; this.publish(controller); }
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
        ...(role === 'main' && !project.host ? { reuseWindow: true } : {}),
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
    if (!controller.main.windowId && !(await this.prepareProject(controller)).windowId)
      throw new Error('请先确认 Fusion 主项目的工作区信任');
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
      assignment.app === controller.main.app && (assignment.app !== 'cursor' || main?.project.id === work.project.id) ? main?.windowId || '' : '');
  }
  async configure(context, controller, attempt) {
    const model = controller.capabilities.find(row => row.app === attempt.app)?.models.find(row => row.model === attempt.model);
    const provider = providerFor(context), current = await provider.info(this, context, 'settings');
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
    const provider = providerFor(context);
    const runtime = { controller, attemptId, binding, context,
      stopping: controller.stopRequested || task?.stopRequested || current().status === 'stopping' };
    this.active.set(attemptId, runtime);
    try {
      if (!recovering) {
        if (cancelled()) throw Object.assign(new Error('未提交的任务已取消'), { cancelled: true });
        if (task) {
          if (provider.prepareTask) current().messageId = await provider.prepareTask(context, current(), task);
          else await this.configure(context, controller, current());
        }
        const before = await provider.readTurn(this, context);
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
        if (!context.backend) await context.source.conversationView(context.native).watching;
        if (runtime.error) throw runtime.error;
        if (cancelled()) { runtime.cancelBeforeSend(); return observing; }
        Object.assign(current(), { status: 'submitting', submission: 'submitting', submittedAt: Date.now() }); this.publish(controller);
        try {
          await provider.action(this, context, 'send', { text: prompt, requestId: attemptId, messageId: current().messageId });
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
    const provider = providerFor(context);
    return new Promise((resolve, reject) => {
      let reading = false, again = false, done = false;
      const finish = (result, error) => { if (done) return; done = true; runtime.unsubscribe?.(); error ? reject(error) : resolve(result); };
      runtime.fail = error => { runtime.error = error; finish(null, error); };
      runtime.cancelBeforeSend = () => finish(null, Object.assign(new Error('未提交的任务已取消'), { cancelled: true }));
      if (!context.backend) context.cdp.onclose = error => finish(null, error);
      runtime.check = async () => {
        if (done) return;
        if (reading) { again = true; return; }
        reading = true;
        try {
          const turn = await provider.readTurn(this, context, { id: current().native?.messageId || current().messageId || '', attemptId,
            previous: current().beforeIds || [], generationId: current().native?.generationId || '' });
          const nativeError = await provider.info(this, context, 'sendError', attemptId);
          if (turn.threadId !== binding.threadId) throw new Error('原生结果身份与 Binding 不一致');
          let snapshot = {};
          if (!turn.ended) {
            try {
              snapshot = context.backend ? await provider.snapshot(context) : await context.source.readConversation(context.native, true);
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
          if (recovering && context.backend === CODEX_BACKEND && !codexBackend.hasWriter(binding.threadId)) throw new Error('后台 Codex 没有可继续观察的原生轮次，结果待核对');
          if (runtime.stopping && current().native) await this.stop(attemptId);
          this.publish(controller, false);
        } catch (error) { finish(null, error); }
        finally { reading = false; if (again && !done) { again = false; runtime.check(); } }
      };
      const changed = error => error ? finish(null, error) : runtime.check();
      runtime.unsubscribe = context.backend ? provider.subscribe(context, changed) : context.source.subscribe(changed, context.native);
      if (recovering) runtime.check();
    });
  }
  async stop(attemptId) {
    const runtime = this.active.get(attemptId);
    if (!runtime) throw new Error('原生执行尚未重新观察，停止结果待核对');
    runtime.stopping = true;
    if (runtime.stopSubmitted) return;
    const attempt = runtime.controller.attempts.find(row => row.id === attemptId);
    const provider = providerFor(runtime.context);
    const turn = await provider.readTurn(this, runtime.context, { id: attempt.native?.messageId || '', attemptId, previous: attempt.beforeIds || [], generationId: attempt.native?.generationId || '' });
    if (turn.ended) { runtime.check(); return; }
    if (!turn.current || !attempt.native || turn.turnId && turn.turnId !== attempt.native.turnId) throw new Error('原生已不在该任务轮次，不能停止其他执行');
    await provider.action(this, runtime.context, 'stop', attempt.native.turnId);
    runtime.stopSubmitted = true; runtime.check();
  }
  async nativeAction(controller, attemptId, action) {
    const attempt = controller.attempts.find(row => row.id === attemptId);
    if (!attempt || attempt.bindingId !== action.bindingId) throw new Error('请求不属于这个任务 Binding');
    if (attempt.endedAt) throw new Error('该次执行已结束，不能处理其它执行的原生交互');
    const binding = controller.bindings.find(row => row.id === attempt.bindingId), context = await this.openBinding(controller, binding);
    try {
      if (binding.app === 'opencode') return fusionOpenCode.interaction(context, action, attempt.native?.turnId);
      if (context.backend === CODEX_BACKEND && action.kind === 'codexRequest') return backgroundCodex.answer(binding.threadId, attempt.native?.turnId, action);
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
      return { binding, chat: await providerFor(context).content(this, context, history, before) };
    } finally { await this.close(context); }
  }
  async renameMain(controller, title) {
    if (!controller.main.bindingId) return { title };
    const binding = controller.bindings.find(row => row.id === controller.main.bindingId && row.role === 'main' && row.app === controller.main.app);
    if (!binding) throw new Error('没有这个原生 Binding');
    const context = await this.carrierFor(controller, binding.app, binding.project, binding.reuseWindow ? binding.windowId : '');
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
    const context = binding.app === 'opencode' ? await fusionOpenCode.open(binding, { archived: true })
      : binding.app === 'codex' && binding.windowId === CODEX_BACKEND ? await this.openBinding(controller, binding)
      : await this.carrierFor(controller, binding.app, binding.project, binding.reuseWindow ? binding.windowId : '');
    context.native = { app: binding.app, threadId: binding.threadId, host: binding.project.host || '', cwd: binding.project.root };
    try {
      const provider = providerFor(context), state = await provider.cleanupState(this, context);
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
