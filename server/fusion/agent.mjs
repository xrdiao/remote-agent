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
import { fusionProject, commitFusion, fusionEvent, fusionEffect, stateOfFusionRun } from './state.mjs';
import { nativeCostSnapshot } from './cost.mjs';
import { fusionModelCatalog } from './model-catalog.mjs';
import { FUSION_TOOLS, fusionControllerPrompt, fusionTaskInput } from './control.mjs';
import { backgroundCodex, nativeAgentProvider, nativeAgentProviders, fusionProviderFor } from './providers.mjs';
import { fusionOpenCode } from './opencode.mjs';
import { CODEX_BACKEND } from '../codex/state.mjs';
import { publishSessionCleanup, publishSessionChange } from '../../lib/session-library.mjs';
import { runNativeEffect, recordNativeTerminal } from './effects.mjs';
import { remotePeerProject, verifyRemotePeerProject, executeRemotePeer, stopRemotePeer, closeRemotePeer, readRemotePeer, answerRemotePeer } from './remote-peer.mjs';

const executeFile = promisify(execFile);

export async function fusionWorkspaceSnapshot(project, scope = []) {
  if (project.host) return { available: false, reason: '远程工作区差异需由原生 Agent 提供证据', at: Date.now() };
  const git = findBin('git');
  const root = localFilePath(project.root);
  const options = { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 5000, windowsHide: true };
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
  constructor({ adapterRegistry, providerFor = context => fusionProviderFor(context, adapterRegistry), onEvent = () => {}, catalog = fusionModelCatalog, receiptTimeout = 30000, evidenceTimeout = 5000 } = {}) {
    this.providerFor = providerFor;
    this.adapterRegistry = adapterRegistry;
    this.receiptTimeout = receiptTimeout;
    this.evidenceTimeout = evidenceTimeout;
    this.catalog = catalog;
    this.live = new Map();
    this.onEvent = onEvent;
    this.active = new Map();
    this.mainProjects = new Map();
  }
  commit(run, edit) { return commitFusion(run, edit); }
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
    const providers = nativeAgentProviders().filter(({ app }) => !this.adapterRegistry || this.adapterRegistry[app]?.discover);
    return Promise.all(providers.map(async ({ app, name, controller, worker }) => {
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
    try {
      if (context.pinned && context.app === 'cursor')
        await this.call(context, `nativeSessionAction('cursor', ${JSON.stringify(context.native.threadId)}, 'release', ${JSON.stringify(context.leaseId)})`);
    } finally {
      context.cdp.close();
      const source = context.source;
      if (!source.watching && !source.clients.size && !source.conversations.size && !source.listeners.size) source.close();
    }
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
      if (actual.threadId !== binding.threadId || fusionProject(actual.cwd, actual.host || '')?.id !== binding.project.id) throw new Error('原生会话目录与该任务项目不一致，未切换任何普通窗口');
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
              this.commit(controller, next => { next.main.windowId = carrier.page.id; });
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
      try {
        if (controller.project.host) await context.attach({ id: controller.main.app, project: controller.project });
        // The user explicitly selected this Fusion project. If no existing window
        // belongs to it, use the ordinary project-opening flow rather than
        // repurposing an unrelated idle Cursor window.
        else await context.withFocus(() => context.useProject(controller.project.root, false, '', '', '', { reuseOnly: false }));
      } catch (error) { this.releaseMainProject(controller); throw error; }
    }
    if (context.pendingProject?.trust) return { trust: { path: context.pendingProject.root } };
    try {
      if (!context.bindingReady) throw new Error(context.projectError || '项目原生窗口尚未就绪');
      this.commit(controller, next => { next.main.windowId = context.windowId.replace(/^(cursor|devin|codex):/, ''); });
      return { windowId: controller.main.windowId };
    } finally { this.releaseMainProject(controller); }
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
    const currentOwner = run => role === 'main' ? run.main : run.agents.find(row => row.id === ownerId);
    let creation = currentOwner(controller).creations?.findLast(row => row.app === app && row.projectId === project.id && !['rejected', 'bound'].includes(row.status));
    const backend = app === 'opencode' ? fusionOpenCode.windowId
      : app === 'codex' && role === 'worker' && !project.host && (!creation || creation.windowId === CODEX_BACKEND) ? CODEX_BACKEND : '';
    if (app === 'opencode' && project.host) throw new Error('OpenCode 仅支持本机 Fusion 子任务');
    const context = backend ? { app, backend, page: { id: backend }, native: { app, threadId: '', host: '' } }
      : await this.carrierFor(controller, app, project, creation?.windowId || preferred);
    try {
      const provider = this.providerFor(context);
      let actual;
      if (creation && backend) {
        if (!creation.nativeThreadId) throw Object.assign(new Error(`${app} 后台创建结果无法确认，不能重新创建会话`), { creationUnknown: true });
        actual = (backend === CODEX_BACKEND ? await backgroundCodex.open(creation.nativeThreadId)
          : await fusionOpenCode.open({ threadId: creation.nativeThreadId, project })).native;
      } else if (creation) {
        const record = await provider.info(this, context, 'creation', creation.id);
        if (record?.status === 'rejected') {
          this.commit(controller, next => Object.assign(currentOwner(next).creations.find(row => row.id === creation.id),
            { status: 'rejected', error: record.error }));
          throw new Error(record.error);
        }
        actual = record?.context;
        const threadId = creation.nativeThreadId || record?.nativeThreadId || (app === 'cursor' ? creation.requestedThreadId : '');
        if (!actual && threadId) {
          try {
            actual = await provider.info(this,
              { ...context, native: { ...context.native, threadId, host: project.host || '' } }, 'context');
          } catch (error) { throw Object.assign(error, { creationUnknown: true }); }
          if (actual?.threadId !== threadId) actual = null;
        }
        if (!actual) throw Object.assign(new Error('后台创建结果无法确认，不能重新创建会话'), { creationUnknown: true });
      } else {
        const workspacePlacement = app === 'cursor' && !project.host ? await provider.info(this, context, 'projectPlacement', project.root) : null;
        if (app === 'cursor' && !project.host && !workspacePlacement) throw new Error('Cursor 原生窗口尚未确认所选项目');
        creation = { id: crypto.randomUUID(), requestedThreadId: crypto.randomUUID(), app, projectId: project.id,
          windowId: context.page.id, status: 'creating', startedAt: Date.now() };
        this.commit(controller, next => { (currentOwner(next).creations ||= []).push(creation); });
        try {
          actual = await provider.create(this, { ...context, native: { ...context.native, host: project.host || '' } }, {
            ...spec, role, requestId: creation.id, root: project.root, threadId: creation.requestedThreadId, workspacePlacement,
          }, controller, creation);
          this.commit(controller, next => {
            currentOwner(next).creations.find(row => row.id === creation.id).nativeThreadId = actual.threadId;
          });
        } catch (error) {
          if (!error.fusionStoreError) this.commit(controller, next => {
            Object.assign(currentOwner(next).creations.find(row => row.id === creation.id), { error: error.message, status: 'unknown' });
          });
          throw Object.assign(error, { creationUnknown: true });
        }
      }
      creation = currentOwner(controller).creations.find(row => row.id === creation.id);
      if (!actual.threadId || fusionProject(actual.cwd, actual.host || '')?.id !== project.id) {
        throw Object.assign(new Error('新原生会话的实际项目不匹配，未提交任务'), { creationUnknown: true });
      }
      const binding = { id: crypto.randomUUID(), role, app, windowId: context.page.id, threadId: actual.threadId,
        host: actual.host || '', project, nativeProject: actual, created: Date.now(),
        ...(role === 'main' && !project.host ? { reuseWindow: true } : {}),
        ...(creation.mcp ? { mcp: creation.mcp } : {}) };
      this.commit(controller, next => {
        next.bindings.push(binding);
        const owner = currentOwner(next);
        owner.bindingId = binding.id;
        Object.assign(owner.creations.find(row => row.id === creation.id), { status: 'bound', bindingId: binding.id });
      });
      try { rememberFusionSession(app, binding.threadId, project, binding.windowId); }
      catch (error) { stateOfFusionRun(controller).report('catalog', error, controller); }
      return controller.bindings.find(row => row.id === binding.id);
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
    const peer = remotePeerProject(work.project);
    if (peer) {
      verifyRemotePeerProject(work.project);
      if (assignment.app !== 'opencode') throw new Error('远端 RA Peer 目前只允许 OpenCode Worker');
      const id = crypto.randomUUID();
      this.commit(controller, next => {
        next.bindings.push({ id, role: 'worker', app: 'opencode', windowId: 'ra-peer:' + peer.target,
          threadId: 'peer-pending:' + id, host: work.project.host, project: work.project,
          remote: { target: peer.target, workspace: peer.workspace, jobs: [] }, created: Date.now() });
        next.agents.find(row => row.id === agent.id).bindingId = id;
      });
      return controller.bindings.find(row => row.id === id);
    }
    const main = controller.bindings.find(row => row.id === controller.main.bindingId);
    return this.createBinding(controller, agent, assignment.app, work.project, 'worker', { title: `Fusion · ${task.goal}`,
      model: assignment.model, effort: assignment.effort },
      assignment.app === controller.main.app && (assignment.app !== 'cursor' || main?.project.id === work.project.id) ? main?.windowId || '' : '');
  }
  async executeRemoteWorker(run, attemptId, task, work, binding, recovering, validateSubmit, runtime) {
    const current = () => run.attempts.find(row => row.id === attemptId);
    if (!recovering) {
      validateSubmit();
      this.commit(run, next => {
        const attempt = next.attempts.find(row => row.id === attemptId);
        const target = next.tasks.find(row => row.id === task.id);
        const input = fusionTaskInput(next, target, attempt);
        attempt.inputIds = target.inputs.filter(row => !row.deliveredAt).map(row => row.id);
        attempt.prompt = input.prompt;
        attempt.promptContext = input.context;
        attempt.baseline = { available: false, at: Date.now(), reason: '跨机工作区变更需通过授权 RA Peer 核验' };
      });
    }
    runtime.remoteBinding = binding;
    return executeRemotePeer({
      project: binding.project, jobId: attemptId, model: current().model, prompt: current().prompt || '',
      previousJobId: binding.remote.jobs?.at(-1), expectedThreadId: binding.threadId,
      access: task.access, scope: task.scope,
      recovering, signal: runtime.abort.signal, timeoutMs: 600000,
      onWaiting: waiting => {
        const previous = this.live.get(attemptId)?.remoteWaiting;
        if (waiting && previous?.id === waiting.id && previous.kind === waiting.kind) return;
        if (!waiting && !previous) return;
        if (waiting) this.live.set(attemptId, { remoteWaiting: waiting, state: { waiting: waiting.id } });
        else this.live.delete(attemptId);
        this.commit(run, next => {
          const row = next.attempts.find(row => row.id === attemptId);
          const currentTask = next.tasks.find(t => t.id === row.taskId);
          if (currentTask) {
            currentTask.status = waiting ? 'awaiting_user' : 'running';
            const worker = next.agents.find(a => a.id === currentTask.workerId);
            if (worker) worker.status = currentTask.status;
          }
          if (waiting) fusionEvent(next, 'native_question', { workId: row.workId, taskId: row.taskId,
            attemptId, bindingId: binding.id, text: waiting.detail || '', nativeRequest: waiting },
            'remote-native:' + attemptId + ':' + waiting.id);
        });
        stateOfFusionRun(run).notify(run);
        this.onEvent();
      },
      onOpen: threadId => this.commit(run, next => {
        const row = next.bindings.find(row => row.id === binding.id);
        row.threadId = threadId;
        row.remote.jobs ||= [];
        if (!row.remote.jobs.includes(attemptId)) row.remote.jobs.push(attemptId);
      }),
      onSubmitting: () => {
        validateSubmit();
        this.commit(run, next => {
          const row = next.attempts.find(row => row.id === attemptId);
          if (row.submission !== 'not_submitted') throw new Error('远端提交已登记或结果未知，不能重复派工');
          Object.assign(row, { status: 'submitting', submission: 'submitting',
            submittedAt: Date.now(), submitIntent: { requestId: attemptId, bindingId: binding.id, threadId: binding.threadId } });
        });
      },
      onSubmitted: (threadId, messageId = 'peer:' + attemptId) => this.commit(run, next => {
        const row = next.attempts.find(row => row.id === attemptId);
        Object.assign(row, { status: 'running', submission: 'submitted',
          native: { threadId, turnId: messageId, messageId } });
      }),
    });
  }
  async configure(context, controller, attempt) {
    const model = controller.capabilities.find(row => row.app === attempt.app)?.models.find(row => row.model === attempt.model);
    const provider = this.providerFor(context), current = await provider.info(this, context, 'settings');
    if (current.model !== attempt.model) await provider.action(this, context, 'model', attempt.model);
    if (attempt.effort) await provider.action(this, context, 'effort', attempt.effort);
    const actual = await provider.info(this, context, 'settings');
    if (actual.model !== attempt.model && (!model?.family || actual.family !== model.family)) throw new Error('原生未确认选中任务模型');
    if (attempt.effort && actual.effort !== attempt.effort) throw new Error('原生未确认任务思考强度');
    return actual;
  }
  async execute(run, attemptId, prompt, recovering, validateSubmit) {
    const current = () => run.attempts.find(row => row.id === attemptId);
    const update = edit => this.commit(run, next => edit(next.attempts.find(row => row.id === attemptId), next));
    if (current().nativeTerminal) return current().nativeTerminal;
    const abort = new AbortController();
    const runtime = { run, attemptId, abort };
    this.active.set(attemptId, runtime);
    const task = run.tasks.find(row => row.id === current().taskId);
    const work = task && run.works.find(row => row.id === task.workId);
    const stopping = () => run.stopRequested || current().stopRequested || current().status === 'stopping'
      || run.tasks.find(row => row.id === current().taskId)?.stopRequested;
    const checkCancelled = () => {
      abort.signal.throwIfAborted();
      if (!recovering && (stopping() || current().endedAt))
        throw Object.assign(new Error('未提交的任务已取消'), { cancelled: true });
    };
    try {
      checkCancelled();
      const assignment = run.assignments.find(row => row.id === current().assignmentId);
      // Recovery opens the previously journaled binding, even if a later task changed the worker's binding.
      const binding = recovering ? run.bindings.find(row => row.id === current().bindingId)
        : current().kind === 'main' ? run.bindings.find(row => row.id === run.main.bindingId)
          : await this.workerBinding(run, task, assignment);
      if (!binding) throw new Error('原生执行缺少已登记的 Binding，结果待核对');
      checkCancelled();
      if (current().bindingId !== binding.id) update(attempt => { attempt.bindingId = binding.id; });
      if (binding.remote)
        return await this.executeRemoteWorker(run, attemptId, task, work, binding, recovering, validateSubmit, runtime);
      const context = runtime.context = await this.openBinding(run, binding);
      const provider = this.providerFor(context);
      Object.assign(runtime, { provider, binding, current, update, stopping });
      const execute = async () => {
        checkCancelled();
        if (!recovering) {
          const messageId = task && provider.prepareTask ? await provider.prepareTask(context, current(), task) : current().messageId;
          if (task && !provider.prepareTask) await this.configure(context, run, current());
          const before = await provider.readTurn(this, context);
          if (before.threadId !== binding.threadId) throw new Error('原生结果身份与 Binding 不一致');
          if (before.turnId && !before.ended) throw new Error('原生会话仍有未结束的执行，提交尚未发生');
          const baseline = task ? await this.workspaceEvidence(run, work.project, task.scope) : null;
          checkCancelled();
          validateSubmit();
          update((attempt, next) => {
            const task = next.tasks.find(row => row.id === attempt.taskId);
            if (task) {
              attempt.inputIds = task.inputs.filter(input => !input.deliveredAt).map(input => input.id);
              const input = fusionTaskInput(next, task, attempt);
              prompt = input.prompt;
              attempt.promptContext = input.context;
            }
            Object.assign(attempt, { messageId, beforeIds: before.ids, beforeTurnId: before.turnId || '', prompt, baseline });
          });
        }
        const observing = this.observe(runtime, recovering);
        if (!recovering) {
          // A receipt can arrive before the transport returns. The observer owns the settlement.
          Promise.resolve().then(async () => {
            if (!context.backend) await context.source.conversationView(context.native).watching;
            checkCancelled();
            const ack = await provider.submit(this, context, { text: prompt, requestId: attemptId, messageId: current().messageId }, () => {
              checkCancelled();
              if (runtime.done) throw new Error('原生观察已关闭，提交尚未发生');
              validateSubmit();
              update(attempt => {
                if (attempt.submission !== 'not_submitted') throw new Error('Fusion 提交已登记，结果待核对');
                Object.assign(attempt, { status: 'submitting', submission: 'submitting', submittedAt: Date.now(),
                  submitIntent: { requestId: attemptId, threadId: binding.threadId, bindingId: binding.id,
                    messageId: attempt.messageId || '', beforeTurnId: attempt.beforeTurnId } });
              });
              runtime.armReceiptDeadline();
            }, runtime.changed);
            if (context.app === 'cursor' && ack?.settings && !this.disposed) update(attempt => {
              const { model, effort } = ack.settings;
              if (model) Object.assign(attempt, { model, effort });
            });
            if (runtime.done) return;
            if (ack?.turnId && ack.thread === binding.threadId && !current().native) update(attempt => {
              attempt.submitReceipt = { turnId: ack.turnId, messageId: ack.messageId };
            });
            runtime.changed();
          }).catch(error => {
            if (current()?.submission === 'not_submitted' || error.fusionStoreError) runtime.finish(null, error);
            else runtime.changed(error);
          });
        }
        return observing;
      };
      const terminal = await (provider.observe ? provider.observe(context, execute) : execute());
      // Supplemental evidence may fail after native completion. The terminal fact is already durable.
      const [settings, changes] = await Promise.all([
        this.usageEvidence(run, () => provider.info(this, context, 'settings')),
        task ? this.workspaceEvidence(run, work.project, task.scope) : null,
      ]);
      return { ...terminal, changes, usage: { native: settings.usage, observedAt: terminal.endedAt,
        basis: settings.usageBasis || '原生未提供可读取的会话用量', actualCost: 'unknown' } };
    } finally {
      abort.abort();
      runtime.unsubscribe?.();
      if (this.active.get(attemptId) === runtime) this.active.delete(attemptId);
      if (this.live.delete(attemptId)) stateOfFusionRun(run).notify(run);
      try { if (runtime.context) await this.close(runtime.context); }
      catch (error) { stateOfFusionRun(run).report('close', error, run); }
    }
  }
  async usageEvidence(run, read) {
    let timer;
    try {
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('原生用量读取超时')), this.evidenceTimeout);
        timer.unref();
      });
      return await Promise.race([deadline, Promise.resolve().then(read)]);
    } catch (error) {
      stateOfFusionRun(run).report('settings', error, run);
      return {};
    } finally { clearTimeout(timer); }
  }
  async workspaceEvidence(run, project, scope) {
    try { return await fusionWorkspaceSnapshot(project, scope); }
    catch (error) {
      stateOfFusionRun(run).report('workspace', error, run);
      return { available: false, at: Date.now(), reason: error.message };
    }
  }
  observe(runtime, recovering) {
    const { run, context, binding, attemptId, provider, current, update, abort } = runtime;
    return new Promise((resolve, reject) => {
      let reading = false, again = false, deadline;
      const finish = runtime.finish = (result, error) => {
        if (runtime.done) return;
        runtime.done = true;
        clearTimeout(deadline);
        runtime.unsubscribe?.();
        error ? reject(error) : resolve(result);
      };
      runtime.armReceiptDeadline = () => {
        if (deadline) return;
        deadline = setTimeout(() => finish(null, runtime.lastError || new Error('尚未核对原生接受结果，不能自动重发')), this.receiptTimeout);
        deadline.unref();
      };
      if (!context.backend) context.cdp.onclose = error => finish(null, error || new Error('原生窗口连接已关闭'));
      const check = async () => {
        if (runtime.done || current().submission === 'not_submitted') return;
        if (reading) { again = true; return; }
        reading = true;
        try {
          const attempt = current();
          const turn = await provider.readTurn(this, context, {
            id: attempt.native?.messageId || attempt.submitReceipt?.messageId || attempt.messageId || '', attemptId,
            previous: attempt.beforeIds || [], generationId: attempt.native?.generationId || attempt.submitReceipt?.turnId || '',
          });
          if (runtime.done) return;
          if (turn.threadId !== binding.threadId) throw new Error('原生结果身份与 Binding 不一致');
          if (turn.id && attempt.native?.turnId && attempt.native.turnId !== turn.turnId)
            throw new Error('原生结果与已登记轮次不一致');
          if (context.app === 'cursor' && turn.id && attempt.native?.messageId
              && (turn.id !== attempt.native.messageId || attempt.native.generationId && turn.generationId
                && turn.generationId !== attempt.native.generationId)) throw new Error('Cursor 原生消息或 generation 与已登记轮次不一致');
          if (turn.id && turn.accepted !== false || turn.ended && attempt.native?.turnId === turn.turnId) {
            const native = { threadId: binding.threadId, turnId: turn.turnId, messageId: turn.id || attempt.native?.messageId,
              generationId: turn.generationId || attempt.native?.generationId || '' };
            if (!native.turnId || !native.messageId) throw new Error('原生回执缺少轮次身份');
            const terminal = turn.ended ? { native, text: turn.text || '', completed: !turn.supersededBy && !!turn.completed,
              stopped: !!turn.supersededBy || runtime.stopping(), error: turn.error || '', endedAt: Date.now(),
              ...(turn.supersededBy ? { supersededBy: turn.supersededBy } : {}) } : null;
            if (terminal || attempt.submission !== 'accepted' || attempt.status === 'unknown' || !attempt.native?.turnId) update((row, next) => {
              Object.assign(row, { native, submission: 'accepted', acceptedAt: row.acceptedAt || Date.now(),
                status: runtime.stopping() ? 'stopping' : 'running' });
              if (turn.settings?.nativeModel) row.nativeModel = turn.settings.nativeModel;
              delete row.error; delete row.outcomeUnknown;
              const task = next.tasks.find(value => value.id === row.taskId);
              for (const input of task?.inputs || []) if (!input.deliveredAt && row.inputIds?.includes(input.id))
                Object.assign(input, { deliveredAt: row.acceptedAt, attemptId, nativeTurnId: native.turnId });
              if (task) task.status = row.status;
              const worker = task && next.agents.find(value => value.id === task.workerId);
              if (worker) worker.status = row.status;
              if (terminal) recordNativeTerminal(next, row, terminal);
            });
            clearTimeout(deadline); deadline = undefined;
            if (terminal) { finish(terminal); return; }
            if (!turn.current) throw new Error('原生已离开该轮次，结果待核对');
            if (runtime.stopping()) this.stop(attemptId, turn).catch(error => {
              stateOfFusionRun(run).report('stop', error, run);
            });
            this.observeInteractions(runtime, native, turn.current);
          } else {
            const rejection = await provider.info(this, context, 'sendError', attemptId);
            if (runtime.done) return;
            if (rejection?.status === 'error' && rejection.outcome === 'rejected')
              throw Object.assign(new Error(rejection.message), { nativeRejected: true });
            if (rejection?.message) runtime.lastError = new Error(rejection.message);
            runtime.armReceiptDeadline();
          }
        } catch (error) { finish(null, error); }
        finally { reading = false; if (again && !runtime.done) { again = false; void check(); } }
      };
      runtime.changed = error => {
        if (error) runtime.lastError = error;
        void check();
      };
      runtime.unsubscribe = provider.subscribe(context, error => error ? finish(null, error) : runtime.changed());
      abort.signal.addEventListener('abort', () => finish(null, abort.signal.reason), { once: true });
      if (recovering) { runtime.armReceiptDeadline(); runtime.changed(); }
    });
  }
  observeInteractions(runtime, native, current) {
    if (!current || !runtime.provider.status) return;
    if (runtime.interactionRead) { runtime.interactionAgain = true; return; }
    const { run, context, binding, attemptId, provider, update } = runtime;
    runtime.interactionRead = Promise.resolve().then(async () => {
      const snapshot = await provider.status(this, context, native);
      if (runtime.done || runtime.current().native?.turnId !== native.turnId) return;
      const { state, chat } = snapshot || {};
      const waiting = state?.waiting;
      const id = waiting && `native-question:${attemptId}:${waiting}`;
      const status = runtime.stopping() ? 'stopping' : waiting ? 'awaiting_user' : 'running';
      const task = run.tasks.find(row => row.id === runtime.current().taskId);
      if (task && task.status !== status || id && !run.events.some(event => event.id === id)) update((attempt, next) => {
        const task = next.tasks.find(row => row.id === attempt.taskId);
        if (task) {
          task.status = status;
          const worker = next.agents.find(row => row.id === task.workerId);
          if (worker) worker.status = status;
        }
        if (id) fusionEvent(next, 'native_question', { workId: attempt.workId, taskId: attempt.taskId,
          attemptId, bindingId: binding.id, text: state.waitingText || '', nativeRequest: waiting }, id);
      });
      if (waiting) {
        const previous = this.live.get(attemptId);
        if (!previous || JSON.stringify(previous) !== JSON.stringify(snapshot)) {
          this.live.set(attemptId, snapshot);
          stateOfFusionRun(run).notify(run);
        }
      } else if (this.live.delete(attemptId)) stateOfFusionRun(run).notify(run);
      if (id) this.onEvent();
    }).catch(error => stateOfFusionRun(run).report('interaction', error, run)).finally(() => {
      runtime.interactionRead = null;
      if (!runtime.done && runtime.interactionAgain) {
        runtime.interactionAgain = false;
        this.observeInteractions(runtime, native, current);
      }
    });
  }
  async stop(attemptId, observedTurn) {
    const runtime = this.active.get(attemptId);
    if (runtime?.remoteBinding) return stopRemotePeer(runtime.remoteBinding.project, attemptId);
    if (!runtime?.current || runtime.stoppingJob) return runtime?.stoppingJob;
    const { provider, context, run } = runtime;
    const { native } = runtime.current();
    if (!native || runtime.current().nativeTerminal || runtime.current().stopOutcomeUnknown) return;
    const id = `native-stop:${attemptId}:${native.turnId}`;
    if (run.effects.some(row => row.id === id)) return;
    runtime.stoppingJob = (async () => {
      const turn = observedTurn || await provider.readTurn(this, context, {
        id: native.messageId, attemptId, generationId: native.generationId,
      });
      if (turn.ended) { runtime.changed(); return; }
      if (!turn.current || turn.turnId !== native.turnId || turn.threadId !== native.threadId)
        throw new Error('原生已不在该任务轮次，不能停止其他执行');
      await runNativeEffect(run, { id, kind: 'native-stop', data: { attemptId, native }, canSettle: () => !this.disposed }, () => provider.stop(this, context, native));
      runtime.changed();
    })().finally(() => { runtime.stoppingJob = null; });
    return runtime.stoppingJob;
  }
  async nativeAction(run, attemptId, action, requestId) {
    const attempt = run.attempts.find(row => row.id === attemptId);
    if (!attempt || attempt.bindingId !== action.bindingId) throw new Error('请求不属于这个任务 Binding');
    if (attempt.endedAt || attempt.nativeTerminal || !attempt.native?.turnId) throw new Error('该次执行不在可交互的原生轮次');
    const binding = run.bindings.find(row => row.id === attempt.bindingId);
    if (binding?.remote) {
      const waiting = this.live.get(attemptId)?.remoteWaiting;
      if (!waiting || waiting.id !== action.id
          || waiting.kind !== (action.kind === 'remotePermission' ? 'permission' : action.kind === 'remoteQuestion' ? 'question' : ''))
        throw new Error('远端审批已过期或不属于该原生任务');
      if (waiting.kind === 'permission' && !['once', 'reject'].includes(action.reply))
        throw new Error('远端审批只能单次允许或拒绝');
      if (waiting.kind === 'question' && (!Array.isArray(action.answers)
          || !action.answers.length || action.answers.some(row => !Array.isArray(row) || row.some(v => typeof v !== 'string'))))
        throw new Error('远端问题答案格式无效');
      const id = 'native-input:' + attemptId + ':' + waiting.kind + ':' + waiting.id;
      await runNativeEffect(run, { id, kind: 'native-input',
        data: { attemptId, native: attempt.native, requestId, identity: waiting.id },
        canSettle: () => !this.disposed }, async () => {
        const receipt = await answerRemotePeer(binding.project, attemptId, waiting,
          waiting.kind === 'permission' ? action.reply : action.answers);
        if (receipt?.state !== 'answered') throw new Error('远端审批结果尚未确认');
      });
      this.live.delete(attemptId);
      stateOfFusionRun(run).notify(run);
      return;
    }
    const context = await this.openBinding(run, binding);
    try {
      const provider = this.providerFor(context), native = attempt.native;
      const turn = await provider.readTurn(this, context, { id: native.messageId, generationId: native.generationId, attemptId });
      if (!turn.current || turn.ended || turn.threadId !== native.threadId || turn.turnId !== native.turnId
          || run.attempts.find(row => row.id === attemptId)?.nativeTerminal) throw new Error('该次执行已结束或已离开原生轮次');
      const identity = action.id || action.item || action.actionId;
      const choice = action.kind === 'question' && ['option', 'prev', 'next'].includes(action.part)
        || binding.app === 'codex' && action.kind === 'codexRequest' && String(action.id).startsWith('async:');
      if (!identity || choice && !requestId) throw new Error('缺少原生交互身份');
      const id = `native-input:${attemptId}:${native.turnId}:${identity}:${choice ? requestId : ''}`;
      // Native answers may contain secrets. Record the request identity without its values.
      await runNativeEffect(run, { id, kind: 'native-input', data: { attemptId, native, requestId, identity }, canSettle: () => !this.disposed },
        () => provider.interaction(this, context, action, native));
    } finally { await this.close(context); }
  }
  dispose() {
    this.disposed = true;
    for (const runtime of this.active.values()) runtime.abort.abort(new Error('Fusion 观察已关闭'));
    for (const session of this.mainProjects.values()) session.dispose();
    this.mainProjects.clear();
    this.live.clear();
  }
  async readBinding(controller, bindingId, history = false, before = null) {
    const binding = controller.bindings.find(row => row.id === bindingId);
    if (!binding) throw new Error('没有这个原生 Binding');
    if (binding.remote) {
      const jobId = (binding.remote.jobs || []).at(-1);
      if (!jobId) return { binding, chat: { items: [], earlier: false } };
      const status = await readRemotePeer(binding.project, jobId);
      const task = controller.attempts.find(row => row.id === jobId);
      return { binding, chat: { earlier: false, items: [
        ...(task?.prompt ? [{ k: 'human', t: task.prompt }] : []),
        ...(status.text ? [{ k: 'assistant', t: status.text }] : []),
      ] } };
    }
    const context = await this.openBinding(controller, binding, '');
    try {
      return { binding, chat: await this.providerFor(context).content(this, context, history, before) };
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
        const unsettled = controller.effects.findLast(row => row.kind === 'native-rename' && row.data.bindingId === binding.id
          && ['executing', 'outcomeUnknown'].includes(row.status));
        if (unsettled && state.title !== unsettled.data.title)
          throw new Error('上次原生改名结果待核对，请检查桌面会话名称');
        const id = crypto.randomUUID();
        await runNativeEffect(controller, { id, kind: 'native-rename', data: { bindingId: binding.id, threadId: binding.threadId, title } }, async () => {
          const result = await provider.action(this, context, 'rename', title);
          if (!result?.confirmed) throw new Error('桌面端尚未确认会话操作完成，请刷新列表查看');
          expected = result.title;
        });
        state = await provider.info(this, context, 'name');
      }
      if (!state.exists || !state.title || state.title !== expected) throw new Error('桌面端尚未确认会话操作完成，请刷新列表查看');
      publishSessionChange(binding.app, binding.threadId, { action: 'rename', title: state.title });
      return { confirmed: true, title: state.title, app: binding.app, threadId: binding.threadId };
    } finally { await this.close(context); }
  }
  async cleanupBinding(controller, binding) {
    if (binding.remote) {
      const id = 'native-cleanup:' + binding.id;
      const saved = controller.effects.find(row => row.id === id && row.status === 'done');
      if (saved?.receipt?.confirmed) return saved.receipt;
      for (const jobId of binding.remote.jobs || []) {
        const result = await closeRemotePeer(binding.project, jobId);
        if (result.state !== 'closed') throw new Error('远端原生会话未确认删除，保留任务记录');
      }
      const receipt = { confirmed: true, action: 'delete' };
      this.commit(controller, next => Object.assign(fusionEffect(next, 'native-cleanup',
        { bindingId: binding.id, threadId: binding.threadId }, id),
        { status: 'done', receipt, endedAt: Date.now() }));
      return { ...receipt, app: binding.app, threadId: binding.threadId, at: Date.now() };
    }
    const id = `native-cleanup:${binding.id}`;
    const saved = controller.effects.find(row => row.id === id && row.kind === 'native-cleanup' && row.status === 'done'
      && row.data.threadId === binding.threadId);
    const result = saved?.receipt || await this.#cleanupNativeBinding(controller, binding, id);
    try { publishSessionCleanup(binding.app, binding.threadId, result.action); }
    catch (error) {
      stateOfFusionRun(controller).report('catalog', error, controller);
      throw error;
    }
    return { ...result, app: binding.app, threadId: binding.threadId, at: Date.now() };
  }
  async #cleanupNativeBinding(controller, binding, id) {
    const context = binding.app === 'opencode' ? await fusionOpenCode.open(binding, { archived: true })
      : binding.app === 'codex' && binding.windowId === CODEX_BACKEND ? await this.openBinding(controller, binding)
      : await this.carrierFor(controller, binding.app, binding.project, binding.reuseWindow ? binding.windowId : '');
    context.native = { app: binding.app, threadId: binding.threadId, host: binding.project.host || '', cwd: binding.project.root };
    try {
      const provider = this.providerFor(context), state = await provider.cleanupState(this, context);
      if (state.running) throw new Error('原生会话仍在运行，请先停止并核对');
      if (state.exists && fusionProject(state.context.cwd, state.context.host || '')?.id !== binding.project.id)
        throw new Error('原生会话目录与该 Binding 项目不一致，未执行清理');
      // Cursor throws this guard BEFORE any native delete. Keep it out of the
      // uncertain-effect journal, so a later QA session can make it deletable.
      if (binding.app === 'cursor' && state.deletionBlocked && state.exists && !state.archived)
        throw new Error('Cursor 当前只有一个原生会话，清空不能代替删除或归档');
      const prior = controller.effects.find(row => row.id === id);
      if (binding.app === 'cursor' && prior?.status === 'outcomeUnknown'
          && /^Error: Cursor 当前只有一个原生会话，清空不能代替删除或归档/.test(prior.error || '')) {
        // Existing v517 records captured this exact pre-native guard as
        // outcomeUnknown. Its throw site precedes delete, proving no write.
        commitFusion(controller, next => {
          const effect = next.effects.find(row => row.id === id);
          effect.status = 'preflightRejected';
          effect.preflightError = effect.error;
          effect.preflightRejectedAt = Date.now();
        });
      }
      const data = { bindingId: binding.id, threadId: binding.threadId };
      if (!state.exists || state.archived) {
        const receipt = { confirmed: true, action: state.archived ? 'archive' : 'delete', already: true };
        commitFusion(controller, next => Object.assign(fusionEffect(next, 'native-cleanup', data, id),
          { status: 'done', receipt, endedAt: Date.now() }));
        return receipt;
      }
      let receipt;
      await runNativeEffect(controller, { id, kind: 'native-cleanup', data }, async () => {
        receipt = await provider.cleanup(this, context);
        if (receipt?.confirmed !== true || !['delete', 'archive'].includes(receipt.action))
          throw new Error('桌面端尚未确认删除或归档完成');
      }, next => { next.effects.find(row => row.id === id).receipt = receipt; });
      return receipt;
    } finally { await this.close(context); }
  }
}
