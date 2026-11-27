import { updateDevice } from '../lib/auth.mjs';
import { cdpRead } from './cdp.mjs';
import { listWindows, phoneWindows, codexWindows } from './windows.mjs';
import { CODEX_CDP_URL, EDITORS } from './config.mjs';
import { PAGE_SRC, helpersCall } from './page/build.mjs';
import { appPlans, quotaErrorMessage } from './agent/context.mjs';
import { probeLatency } from './latency.mjs';
import { launchAgents, detectAgents } from './launch.mjs';
import { inspectCompatibility } from './apps/compatibility.mjs';
import { AGENT_REGISTRY, nativeRoute, runAdapterMethod, runNativeAction, runNativeQueue } from './apps/index.mjs';
import { unsupportedCapability } from './apps/adapter.mjs';
import { readLibrary, importLibrary, favoriteSession } from '../lib/session-library.mjs';
import { computerId } from '../lib/auth.mjs';
import { scanProjectWindows, projectWindowSettings } from './project-windows.mjs';
import { nativeWindow, nativeWindowAt, configureNativeRetry, withNativeWindowRead } from './native-windows.mjs';
import { manageOverviewSession } from './overview-actions.mjs';
import { withOperation, lookupOperations } from './operations.mjs';
import { realpath } from 'node:fs/promises';
import { writeTextFile } from '../lib/files.mjs';
import { fileAction } from '../lib/file-actions.mjs';
import os from 'node:os';
import { terminalService } from './terminal-service.mjs';
import { SourceRef, conversationTerminalSource } from './session/source-ref.mjs';

// One entry per message type the phone can send (auth/ack are handled inside ws.mjs itself).
//   pre      — runs in handle() before the read-only/focus split, without a cdp
//   preWhen  — limits pre to matching sessions (e.g. codex agents)
//   readOnly — skips the focus lock; boolean or (session, msg) => bool
//   fusionFree — allowed on a fusion session without a cdp; boolean or (session, msg) => bool
//   fusion   — alternate runner used instead of run when fusionFree applies (refresh only)
//   fast     — the WS scheduler bypasses the per-client queue entirely; fastRun is the direct call
//   switchRead / connection / navigation — cancellation and selection ownership in the WS scheduler
//   background — waits for preceding commands, then reads without holding up later commands
//   run      — the dispatch body
//   after    — emits on success from the queued ws handler
//   fail     — extra emits when run throws (sendFailed)
//   errorStatus — false when fail owns a scoped error reply

const flag = (v, s, m) => (typeof v === 'function' ? v(s, m) : !!v);
// A pre handler returns SKIP when its condition does not match, letting the
// message continue to the normal dispatch path (used by codex `agents`).
export const SKIP = Symbol('route-skip');
export function resolveRoute(session, type) {
  const route = Object.hasOwn(ROUTES, type) ? ROUTES[type] : undefined;
  const native = nativeRoute(session, type);
  if (!native) return route;
  const run = (s, m) => native.call(s, m);
  return { ...route, native: true, run,
    ...(session.codexBackend && route?.fastRun ? { fastRun: run } : {}) };
}
function runAppMethod(session, method, ...args) {
  if (!AGENT_REGISTRY[session.app]?.methods[method]) throw unsupportedCapability(session.app, method);
  return session[method](...args);
}
function showSelectedUsage(session, message) {
  // A late read from the previous app must not load the new renderer or
  // publish its quota into the wrong conversation.
  if (message.sel && message.sel !== session.selectionKey()) return;
  if (message.automatic !== true) {
    session.manualUsageRevision = (session.manualUsageRevision || 0) + 1;
    return session.showUsage(false);
  }
  const revision = session.manualUsageRevision;
  return session.deferWindowRead('usage', () => {
    if (session.manualUsageRevision === revision) return session.showUsage(true);
  });
}

function listSelectedAgents(session, message, projectWindow = '') {
  const silent = message.silent === true, automatic = message.automatic === true, checkTrust = message.checkTrust === true;
  const read = () => session.listAgents(silent, automatic, projectWindow, checkTrust);
  return automatic && silent && !projectWindow && !checkTrust ? session.deferWindowRead('catalog', read) : read();
}

const fusionRoute = method => ({ fast: true, fastRun: async (session, message) => {
  try { return await session[method](message); }
  catch (error) { session.emit({ t: 'fusionError', computer: computerId(), runId: message.runId || '', requestId: message.requestId, message: error.message }); }
} });

// Mention tokens from the phone: short strings only, at most a dozen.
const cleanMentions = list => (Array.isArray(list) ? list : []).slice(0, 12)
  .map(m => ({
    token: String(m?.token ?? '').slice(0, 200), q: String(m?.q ?? '').slice(0, 200),
    label: String(m?.label ?? '').slice(0, 200), sub: String(m?.sub ?? '').slice(0, 200),
    key: String(m?.key ?? '').slice(0, 240), section: String(m?.section ?? '').slice(0, 40),
    ...(m?.section === 'local-files' ? { path: String(m.path || '') } : {}),
    trigger: m?.trigger === '/' ? '/' : '@',
  }))
  .filter(m => m.token && m.label);

// Fills appPlans right after the phone's connAgents probe so plan badges don't wait for a usage read.
let plansRead = null;

async function cursorPlanFor(cdp) {
  return (await cdp.evaluate(helpersCall('readUsage()')))?.plan || '';
}

function readAllPlans(session, windows) {
  const view = session.connectionView, connection = view.generation;
  const probe = (url, app, id, read) => {
    const run = () => withNativeWindowRead(url, app, id, read);
    const source = nativeWindowAt(url);
    return source ? source.deferBackgroundRead('app-plan', run, null) : run();
  };
  plansRead ||= cdpRead.run(null, async () => {
    const wins = windows || await listWindows();
    const readCodex = async () => {
      if (!wins.some(w => w.app === 'codex')) return;
      const page = (await codexWindows(CODEX_CDP_URL)).find(p => p.chatWs);
      if (page) await probe(page.chatWs, 'codex', page.pageId, async cdp => {
        const usage = await cdp.evaluate(helpersCall('refreshCodexUsage(false)'), { timeout: 30000 });
        if (usage) appPlans.codex = usage.account?.planType || '';
      });
    };
    const readEditor = async app => {
      for (const w of wins.filter(win => win.app === app)) {
        if (appPlans[app]) break;
        await probe(w.ws, app, w.id, async cdp => {
          const plan = app === 'devin'
            ? (await cdp.evaluate(helpersCall('readDevinUsage()'), { timeout: 30000 }))?.plan
            : await cursorPlanFor(cdp);
          if (plan) appPlans[app] = plan;
        }).catch(() => {});
      }
    };
    await Promise.allSettled([readCodex(), readEditor('cursor'), readEditor('devin')]);
  }).finally(() => { plansRead = null; });
  return plansRead.then(() => {
    if (view.current(connection)) view.run(() => session.emit({ t: 'plans', plans: appPlans }), connection);
  });
}

const questionDone = (s, m, result) => s.emit({ t: 'questionDone', requestId: m.requestId, sel: s.selectionKey(), ok: true,
  ...(result === 'advanced' ? { advanced: true } : {}) });
const questionFailed = (s, m, error) => s.emit({ t: 'questionDone', requestId: m.requestId, sel: s.selectionKey(), ok: false, error: error?.message });

const terminalRoute = run => ({ fast: true, connection: true, fastRun: run, errorStatus: false,
  fail: (s, m, error) => s.emit({ t: 'termError', requestId: m.requestId, id: m.id,
    subscription: m.subscription, action: m.t, message: error.message }),
});
const terminalInputTarget = (s, m) => {
  if (s.mode !== 'terminal' || s.terminalId !== m.id || s.terminalSubscription !== m.subscription)
    throw new Error('终端已切换，请在当前终端重新输入');
};

export const ROUTES = {
  operationLookup: { fast: true, connection: true, fastRun: (s, m) => {
    if (Array.isArray(m.pendingIds)) lookupOperations(s.deviceId, s.client, m.pendingIds);
    if (Array.isArray(m.ids)) lookupOperations(s.deviceId, s.client, m.ids, ['send']);
    if (Array.isArray(m.questionIds)) lookupOperations(s.deviceId, s.client, m.questionIds, ['question', 'codexRequest']);
  } },
  computerFileAction: { fast: true, connection: true,
    fastRun: async (s, m) => s.emit({ t: 'computerFileDone', requestId: m.requestId, ok: true,
      ...await fileAction({ action: m.action, directory: m.directory, paths: m.paths, name: m.name, mode: m.collision }) }),
    fail: (s, m, error) => s.emit({ t: 'computerFileDone', requestId: m.requestId, ok: false, error: error.message }),
  },
  saveComputerFile: { fast: true, connection: true,
    fastRun: async (s, m) => {
      const file = await realpath(String(m.path ?? ''));
      const size = await writeTextFile(file, String(m.text ?? ''));
      s.emit({ t: 'saved', requestId: m.requestId, path: m.path, host: '', ok: true, size });
    },
    fail: (s, m, error) => s.emit({ t: 'saved', requestId: m.requestId, path: m.path, host: '', ok: false, error: error.message }),
  },
  overviewManage: { fast: true, connection: true,
    fastRun: async (s, m) => {
      const value = await withOperation(null, () => manageOverviewSession(s.deviceId, m));
      s.emit({ t: 'overviewManaged', ok: true, value });
    },
    fail: (s, m, error) => s.emit({ t: 'overviewManaged', ok: false, error: error.message }),
  },
  compatibility: { fast: true, fastRun: async (s, m) => {
    const app = String(m.app || '');
    const data = await inspectCompatibility(app, String(m.windowId || ''));
    s.emit({ t: 'compatibility', app, requestId: m.requestId, ...data });
  } },
  projectWindows: { pre: async s => {
    await scanProjectWindows(false);
    s.emit({ t: 'projectWindows', ...projectWindowSettings() });
  } },
  projectWindowSet: { pre: (s, m) => s.emit({ t: 'projectWindows', ...projectWindowSettings(m.change) }) },
  sessionBatch: { accept: (s, m) => s.beginSessionBatch(m.requestId), run: (s, m) => s.batchSessions(Array.isArray(m.ids) ? m.ids.map(String) : [], m.requestId), fail: (s, m) => s.emit({ t: 'sessionBatchProgress', app: s.app, requestId: m.requestId, total: m.ids?.length || 0, results: (m.ids || []).map(id => ({ id, ok: false, error: '批量操作未执行，请刷新列表' })), done: true }) },
  sessionBatchCancel: { fast: true, fastRun: (s, m) => { if (s.sessionBatch?.requestId === m.requestId) s.sessionBatch.cancelled = true; } },
  sessionActions: { switchRead: true,
    run: (s, m) => s.sessionActions(String(m.id || ''), m.requestId),
    fail: (s, m) => s.emit({ t: 'sessionActions', app: s.app, id: m.id, requestId: m.requestId, actions: [] }),
  },
  sessionManage: { run: (s, m) => s.manageSession(String(m.id || ''), String(m.action || ''), m.name) },
  sessionLibrary: { fast: true, fastRun: (s, m) => {
    importLibrary(m.entries);
    s.emit({ t: 'sessionLibrary', computer: computerId(), records: readLibrary() });
  } },
  sessionFavorite: { fast: true, fastRun: (s, m) => {
    try { favoriteSession(String(m.app || ''), m.id, m.favorite === true); }
    catch (error) { s.emit({ t: 'status', ok: false, msg: error.message }); }
  } },
  latency: { fast: true, fastRun: (s, m) => { probeLatency(s, m).catch(() => {}); } },
  // Liveness probe for the phone's dead-socket detection: an open-but-dead connection
  // silently swallows sends, so the phone pings and reconnects when nothing comes back.
  ping: { fast: true, fastRun: (s, m) => {
    if (typeof m.visible === 'boolean') { s.notifyVisible = m.visible; s.notifyPresenceAt = Date.now(); }
    s.emit({ t: 'pong' });
  } },
  saveFile: {
    pre: (s, m) => s.saveFile(String(m.path ?? ''), String(m.text ?? ''), m.host == null ? undefined : String(m.host), m.requestId, m.root),
    fail: (s, m, error) => s.emit({ t: 'saved', requestId: m.requestId, path: m.path, host: m.host || '', ok: false, error: error?.message || '保存未执行' }),
  },
  connAgents: { switchRead: true, connection: true,
    pre: async (s, options = {}) => {
      const probe = s.agentProbe = (s.agentProbe || 0) + 1;
      const catalog = detectAgents();
      const agents = [], found = new Map();
      const sources = [...EDITORS, { app: 'opencode' }];
      let finished = 0;
      await Promise.all(sources.map(async editor => {
        let wins = [];
        try { wins = await listWindows(agents, editor.app); } catch {}
        for (const win of wins) found.set(win.id, win);
        finished++;
        if (s.agentProbe !== probe) return;
        s.emit({ t: 'windows', list: phoneWindows([...found.values()], s.targetId), current: s.targetId, plans: appPlans });
        s.emit({ t: 'connAgents', agents: [...agents], complete: finished === sources.length });
      }));
      if (s.agentProbe !== probe) return [...found.values()];
      const wins = [...found.values()];
      if (!options.deferPlans && wins.length) readAllPlans(s, wins).catch(() => {});
      catalog.then(list => { if (s.agentProbe === probe) s.emit({ t: 'agentCatalog', agents: list.map(a => agents.some(r => r.app === a.app && r.windows) ? { ...a, installed: true, running: true, reason: '' } : a) }); }).catch(() => {});
      return wins;
    },
  },
  windows: { switchRead: true, connection: true,  background: true, pre: async s => s.emit({ t: 'windows', list: phoneWindows(await listWindows(), s.targetId), current: s.targetId, plans: appPlans }) },
  attach: { switchRead: true, navigation: true,
    fail: (s, m, error) => s.emit({ t: 'attachFailed', ready: s.bindingReady === true, message: error?.message }),
    pre: async (s, m) => {
      if (!m.initial || m.resume && s.bindingReady) return s.attach(m);
      const signal = cdpRead.getStore();
      const probe = cdpRead.run(null, () => ROUTES.connAgents.pre(s, { deferPlans: true }));
      try {
        await s.attach(m);
      } finally {
        probe.then(wins => { if (!signal?.aborted && wins.length) readAllPlans(s, wins).catch(() => {}); }).catch(() => {});
      }
    },
  },
  launchAgents: {
    fast: true,
    fastRun: (s, m) => launchAgents(s, m.apps, () => ROUTES.connAgents.pre(s).catch(() => {})),
  },
  mode: { connection: true, fast: (_s, m) => m.mode === 'terminal',
    fastRun: (s, m) => s.setMode(m.mode), pre: (s, m) => s.setMode(m.mode) },
  visible: { connection: true,
    fast: s => s.mode === 'terminal', fastRun: (s, m) => ROUTES.visible.pre(s, m),
    pre: (s, m) => s.setSubscriptionsVisible(m),
  },
  lang: { connection: true,  pre: (s, m) => { updateDevice(s.deviceId, { lang: m.v === 'en' ? 'en' : 'zh' }); } },
  draft: {
    fail: (s, m) => s.emit({ t: 'draftAck', sel: m.sel, ok: false, draftEpoch: m.draftEpoch || '', revision: m.revision }),
    pre: async (s, m) => {
      if (s.queueEditing) { s.queueEditing.request = m; return; }
      const read = m.text === undefined;
      let text = read ? '' : String(m.text);
      const sel = s.selectionKey(), epoch = s.draftEpoch || '';
      s.draftRevision = m.revision;
      s.draftGeneration++;
      s.draftWriting = true;
      let ok = false;
      try {
        if (read) {
          text = s.app === 'codex'
            ? await nativeWindow(s.cdp).composerCall(`nativeSessionInfo('codex', ${JSON.stringify(s.threadId)}, 'draft', { format: 'plain' })`, { app: 'codex', threadId: s.threadId })
            : await s.cdp.evaluate(helpersCall('composerDraft()'));
          ok = typeof text === 'string';
        }
        else ok = await s.setDraft(text);
      } catch {}
      finally { s.draftWriting = false; }
      return s.emit({ t: 'draftAck', sel, ok, text, read, draftEpoch: epoch, revision: m.revision });
    },
  },

  agents: { switchRead: true,
    background: (s, m) => m.automatic === true && m.silent === true,
    pre: (s, m) => (s.app === 'codex' && s.cdp ? listSelectedAgents(s, m) : SKIP),
    readOnly: (s, m) => m.silent === true,
    run: (s, m) => listSelectedAgents(s, m, String(m.projectWindow || '')),
    fail: (s, m, error) => s.emit({ t: 'agents', app: s.app, sel: s.selectionKey(), silent: m.silent === true, error: error?.message || '会话已切换，请重试列表' }),
  },
  openAgent: { switchRead: true, navigation: true,
    pre: (s, m) => {
      const id = String(m.id ?? '');
      const backend = AGENT_REGISTRY[s.app]?.navigation.backendAgent?.call(s, id, true);
      return backend ? s.adapter.attachBackend.call(s, backend) : SKIP;
    },
    run: (s, m) => s.openAgent(String(m.id ?? ''), String(m.title ?? '')),
  },
  openMenu: {
    switchRead: true, run: (s, m) => s.openMenu(m.kind, m.requestId),
    fail: (s, m, error) => s.emit({ t: 'menu', kind: m.kind, requestId: m.requestId, sel: s.selectionKey(), error: error?.message || '菜单读取未完成' }),
  },
  pickMenu: {
    run: async (s, m) => {
      try { return await s.pickMenu(m.kind, m.label, m.name, m.confirmFullAccess === true); }
      catch (error) { if (m.kind === 'model' || m.kind === 'effort') await s.closeMenus(); throw error; }
    },
    after: (s, m, result) => { if (['model', 'effort', 'fast'].includes(m.kind) || m.kind === 'permission' && ['codex', 'opencode'].includes(s.app)) s.emit({ t: 'menuPicked', sel: s.selectionKey(), requestId: m.requestId, kind: m.kind, label: m.label, ok: !result?.pending, ...(result?.pending && { pending: true }) }); },
    fail: (s, m) => { if (['model', 'effort', 'fast'].includes(m.kind) || m.kind === 'permission' && ['codex', 'opencode'].includes(s.app)) s.emit({ t: 'menuPicked', sel: s.selectionKey(), requestId: m.requestId, kind: m.kind, label: m.label, ok: false }); },
  },
  fusionOptions: { run: (s, m) => runAppMethod(s, 'fusionOptions', String(m.part ?? '')) },
  fusionPick: { run: (s, m) => runAppMethod(s, 'fusionPick', String(m.part ?? ''), m.value) },
  toggleMax: { run: s => runAppMethod(s, 'toggleMax') },
  params: { switchRead: true,  run: (s, m) => s.showParams(String(m.model ?? ''), String(m.label ?? '')) },
  pickParam: { run: (s, m) => s.pickParam(String(m.model ?? ''), String(m.label ?? ''), m.section, m.value) },
  terminals: terminalRoute((s, m) => s.emit({ t: 'terminals', requestId: m.requestId,
    list: terminalService.list().map(terminal => ({ ...terminal, current: terminal.id === s.terminalId })) })),
  openTerminal: terminalRoute((s, m) => s.selectTerminal(String(m.id), String(m.subscription))),
  closeTerminal: terminalRoute(async (s, m) => {
    await terminalService.close(String(m.id));
    s.emit({ t: 'termRemoved', id: m.id, requestId: m.requestId });
  }),
  newTerminal: terminalRoute(async (s, m) => {
    const source = m.source === 'conversation' ? await conversationTerminalSource(s, m.sel, runAdapterMethod)
      : new SourceRef('computer-terminal', { root: m.cwd || os.homedir() });
    const terminal = await terminalService.create({ cwd: source.root, host: source.host });
    s.emit({ t: 'termCreated', requestId: m.requestId, terminal });
  }),
  termWrite: terminalRoute(async (s, m) => {
    terminalInputTarget(s, m);
    await terminalService.write(m.id, m.binary === true ? Buffer.from(String(m.data), 'binary') : String(m.data));
    if (m.requestId) s.emit({ t: 'termWritten', id: m.id, subscription: m.subscription, requestId: m.requestId });
  }),
  termResize: terminalRoute((s, m) => {
    terminalInputTarget(s, m);
    return terminalService.resize(m.id, m.cols, m.rows);
  }),
  termSend: terminalRoute(async (s, m) => {
    terminalInputTarget(s, m);
    await terminalService.submit(m.id, String(m.text));
    s.emit({ t: 'termSent', id: m.id, subscription: m.subscription, requestId: m.requestId });
  }),
  termComplete: terminalRoute(async (s, m) => {
    terminalInputTarget(s, m);
    const input = await terminalService.complete(m.id, String(m.text), m.caret);
    s.emit({ t: 'termInput', id: m.id, subscription: m.subscription, requestId: m.requestId, revision: m.revision, ...input });
  }),
  termHistory: terminalRoute(async (s, m) => {
    terminalInputTarget(s, m);
    const commands = await terminalService.history(m.id);
    s.emit({ t: 'termHistory', id: m.id, subscription: m.subscription, requestId: m.requestId, revision: m.revision, direction: m.direction, commands });
  }),
  projects: { switchRead: true,  run: (s, m) => s.showProjects(String(m.path ?? '')) },
  docs: { switchRead: true, run: (s, m) => s.showDocs(m.requestId) },
  openProject: { navigation: true,  run: (s, m) => s.useProject(String(m.path ?? ''), m.newSession === true) },
  newProject: { run: (s, m) => s.newProject(String(m.parent ?? ''), String(m.name ?? '').trim(), m.newSession === true) },
  projectTrust: { run: (s, m) => s.confirmProjectTrust(m.approve === true, m.returnTo) },
  codexSetting: {
    run: (s, m) => {
      if (s.app !== 'codex') return;
      return s.showCodexSettings(String(m.id || ''), m.requestId, typeof m.value === 'string' ? m.value : undefined);
    },
  },
  codexInstructions: { run: (s, m) => s.app === 'codex' && s.saveCodexInstructions(String(m.text ?? ''), m.requestId) },
  closeCodexSettings: { run: s => runAppMethod(s, 'closeCodexSettings') },
  settings: { switchRead: true,  run: (s, m) => s.showSettings(m.requestId, String(m.section || '')) },
  closeDesktopSettings: { run: s => s.closeDesktopSettings() },
  toggleSetting: { run: (s, m) => s.toggleSetting(String(m.label ?? ''), typeof m.value === 'string' ? m.value : undefined) },
  usage: { switchRead: true,
    // Devin account reads can occupy its renderer for over a second. Run
    // automatic reads after navigation, and serialize manual refreshes.
    background: (s, m) => s.app === 'codex' || m.automatic === true || m.sel?.startsWith('codex|'),
    readOnly: (s, m) => s.app === 'codex' || m.automatic === true,
    fusionFree: true,
    run: showSelectedUsage,
  },
  fusionWorkspace: fusionRoute('fusionWorkspace'),
  fusionCreate: fusionRoute('fusionCreate'),
  fusionProject: fusionRoute('fusionProject'),
  fusionRead: fusionRoute('fusionRead'),
  fusionConfigure: fusionRoute('fusionConfigure'),
  fusionPrepare: fusionRoute('fusionPrepare'),
  fusionInput: fusionRoute('fusionInput'),
  fusionContent: fusionRoute('fusionContent'),
  fusionConfirm: fusionRoute('fusionConfirm'),
  fusionStop: fusionRoute('fusionStop'),
  fusionResume: fusionRoute('fusionResume'),
  fusionNative: fusionRoute('fusionNative'),
  newProjectChat: { run: s => s.newProjectChat() },
  surface: { run: (s, m) => runAppMethod(s, 'setSurface', String(m.to ?? '')) },
  openEditorChat: { run: s => runAppMethod(s, 'openEditorChat') },
  closeTab: { run: (s, m) => runAppMethod(s, 'closeTab', String(m.id ?? '')) },
  file: { switchRead: true,  run: (s, m) => s.openFile(String(m.path ?? ''), String(m.diff ?? ''), m.changes === true, m.requestId) },
  click: { run: (s, m) => s.clickButton(m.item, m.n, m.actionId, m.label, m.sel, m.requestId) },
  codexRetry: { fast: true, fastRun: (s, m) => {
    if (s.app !== 'codex' || m.sel !== s.selectionKey()) return;
    configureNativeRetry(s.deviceId, nativeWindow(s.cdp), { enabled: m.enabled === true,
      count: Math.max(1, Math.min(5, Math.round(Number(m.count) || 1))), thread: s.threadId || '', sel: m.sel });
  } },
  queue: {
    readOnly: (s, m) => m.action === 'read',
    run: runNativeQueue,
    after: (s, m, result) => {
      s.emit({ t: 'queueDone', sel: m.sel || s.selectionKey(), requestId: m.requestId, id: m.id, action: m.action, text: m.action === 'read' ? result : m.text, echoes: m.echoes, ...(m.action === 'edit' && result), ok: true });
      if (m.action === 'edit') s.emit({ t: 'status', ok: true, msg: s.app === 'devin' ? '已取回输入框，编辑后需重新发送' : s.app === 'codex' && result.queued === false ? '已修改并已发送' : '已修改，仍在排队' });
    },
    fail: (s, m, error) => s.emit({ t: 'queueDone', sel: m.sel || s.selectionKey(), requestId: m.requestId, id: m.id, action: m.action, ok: false, error: error?.message }),
  },
  stop: {
    fast: true,
    fastRun: (s, m) => s.app === 'fusion' ? runNativeAction(s, 'stop', m) : s.handle(m),
    readOnly: true,
    run: (s, m) => s.stopButton(m),
  },
  subagent: {
    run: (s, m) => runAppMethod(s, 'subagentAction', m.name, m.part === 'stop' ? 'stop' : 'open'),
    after: (s, m) => { if (m.part === 'stop') s.emit({ t: 'status', msg: '已点击子 Agent 停止' }); },
  },
  mainChat: { run: s => runAppMethod(s, 'backToMain') },
  cancelImage: { fast: true, fastRun: (s, m) => {
    const transfer = s.imageTransfers?.get(m.clientImageId);
    if (transfer) transfer.cancelled = true;
  } },
  image: {
    run: (s, m) => s.attachImage(m.data, m.name, m.type, String(m.replace || ''), m.sel, s.imageTransfers?.get(m.clientImageId), m.uploadId),
    after: (s, m, attachmentId) => s.emit({ t: 'imageDone', clientImageId: m.clientImageId, attachmentId, ok: true, cancelled: s.imageTransfers?.get(m.clientImageId)?.cancelled === true }),
    fail: (s, m) => s.emit({ t: 'imageDone', clientImageId: m.clientImageId, ok: false }),
  },
  editImage: { readOnly: true, run: (s, m) => s.editAttachmentImage(String(m.id), String(m.sel)) },
  attachments: { switchRead: true,  readOnly: true, fusionFree: true, run: s => s.syncAttachments() },
  removeAttachment: { run: (s, m) => s.removeAttachment(String(m.id)) },
  question: {
    run: (s, m) => s.answerQuestion(m.qi, m.oi, m.part === 'text' && s.app === 'devin' ? 'text' : ['option', 'submit', 'skip', 'prev', 'next'].includes(m.part) ? m.part : 'option', m.text),
    after: questionDone, fail: questionFailed,
  },
  workdir: { switchRead: true,  run: s => runAppMethod(s, 'workdirList') },
  workdirPick: { run: (s, m) => runAppMethod(s, 'workdirPick', String(m.name ?? '').slice(0, 200), String(m.path ?? '').slice(0, 400)) },
  envPick: { run: (s, m) => runAppMethod(s, 'envPick', String(m.label ?? '')) },
  changes: { switchRead: true,  run: s => s.listChanges() },
  toolDetails: { switchRead: true, readOnly: true, run: (s, m) => runNativeAction(s, 'toolDetails', m) },
  thought: { switchRead: true,  readOnly: true, run: (s, m) => runAppMethod(s, 'thought', String(m.i ?? '')) },
  revert: { run: (s, m) => runAppMethod(s, 'revert', String(m.i ?? '')) },
  revertOk: { run: (s, m) => runAppMethod(s, 'revertAnswer', true, typeof m.apply === 'boolean' ? m.apply : undefined) },
  revertCancel: { run: (s, m) => runAppMethod(s, 'revertAnswer', false) },
  change: { run: (s, m) => s.changeAction(m.i, m.name, m.act) },
  scrollChat: { switchRead: true,
    background: (s, m) => s.app === 'codex' && m.history === true,
    readOnly: (s, m) => s.app === 'codex' && m.history === true,
    run: async (s, m) => {
      if (!m.history) return s.scrollChat(Number(m.dy) || 0, m.automatic === true);
      const sel = s.selectionKey();
      try {
        const result = await s.scrollChat(Number(m.dy) || 0, m.automatic === true, true, m.before, m.known, m.details);
        if (result?.items) s.emit({ t: 'historyPage', sel, requestId: m.requestId, thread: result.thread, items: result.items, earlier: result.earlier, before: result.before });
        const { items, thread, ...done } = result || {};
        s.emit({ t: 'historyDone', sel, requestId: m.requestId, ...done });
      } catch (e) {
        s.emit({ t: 'historyDone', sel, requestId: m.requestId, error: e.message });
      }
    },
  },
  appTheme: { fusionFree: true, run: (s, m) => { s.dark = m.dark !== false; s._theme = null; } },
  tap: { run: (s, m) => s.tap(m.x, m.y, m.button) },
  wheel: { run: (s, m) => s.wheel(m.x, m.y, m.dx || 0, m.dy || 0) },
  key: { run: (s, m) => {
    if (m.focus === 'terminal' || s.mode === 'terminal') throw new Error('终端输入已更新，请更新手机页面后使用 RA 终端');
    return s.key(String(m.key || ''), { cdp: s.mode === 'chat' ? s.cdp : s.editorCdp });
  } },
  send: {
    fusionFree: true,
    run: (s, m) => s.sendMessage(String(m.text ?? ''), m.submit !== false, m.when, cleanMentions(m.mentions), { requestId: m.requestId, draft: m.draft, text: m.text, draftEpoch: m.draftEpoch }),
    fail: (s, m, error) => s.emit({ t: 'sendFailed', requestId: m.requestId, message: quotaErrorMessage(s.app, error) || error?.message, cancelled: error?.cancelled === true }),
  },
  mentionQuery: { switchRead: true,  run: (s, m) => s.mentionQuery(String(m.q ?? '').slice(0, 80), m.cat ? String(m.cat).slice(0, 40) : '', Number(m.seq) || 0, m.trigger === '/' ? '/' : '@', { text: String(m.text ?? ''), start: m.start, caret: m.caret }) },
  codexRequest: {
    run: (s, m) => runNativeAction(s, 'codexRequest', m),
    after: questionDone, fail: questionFailed,
  },
  opencodeQuestion: {
    run: s => { throw unsupportedCapability(s.app, 'opencodeQuestion'); },
    after: (s, m) => s.emit({ t: 'opencodeQuestionDone', requestId: m.requestId, sel: s.selectionKey(), id: m.id, ok: true }),
    fail: (s, m, error) => s.emit({ t: 'opencodeQuestionDone', requestId: m.requestId, sel: s.selectionKey(), id: m.id, ok: false, error: error.message }),
  },
  codexPick: { run: (s, m) => runAppMethod(s, 'codexPick', m) },
  codexGoal: { readOnly: (s, m) => m.action === 'read', run: (s, m) => s.app === 'codex' && runAppMethod(s, 'codexGoal', m) },
  codexSkills: { switchRead: true,  run: s => runAppMethod(s, 'codexSkillList') },
  codexPlan: { run: s => runAppMethod(s, 'codexTogglePlan') },
  codexIde: { run: s => runAppMethod(s, 'codexToggleIde') },
  codexRun: { switchRead: true,  run: s => runAppMethod(s, 'codexRunMenu') },
  codexChat: { switchRead: true,  run: s => runAppMethod(s, 'codexChatMenu') },
  codexRename: { run: (s, m) => runAppMethod(s, 'codexRenameThread', String(m.id || ''), String(m.name || '')) },
  codexArchive: { run: (s, m) => runAppMethod(s, 'codexArchiveThread', String(m.id || '')) },
  visualList: { connection: true, pre: s => s.visualList()},
  visualSelect: { connection: true, pre: (s, m) => s.visualSelect(m.id)},
  refresh: { switchRead: true, readOnly: true, fusionFree: true,
    fast: s => s.mode === 'terminal', fastRun: s => s.terminalId && s.selectTerminal(s.terminalId, s.terminalSubscription),
    run: s => s.mode === 'chat' ? s.pollChat(true, true) : s.snapshot(true),
    fusion: s => s.mode === 'screen' ? s.snapshot(true) : s.adapter.pollChat.call(s) },

};

export { flag };
