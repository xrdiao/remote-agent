import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import test from 'node:test';
import { FusionAgent } from '../server/fusion/agent.mjs';
import { NativeCdp, nativeWindow } from '../server/native-windows.mjs';
import { fixture, nativeInvocation } from './fusion-fixture.mjs';
import { helpersCall, PAGE_SRC } from '../server/page/build.mjs';
import { FUSION_TOOLS, fusionAutonomyContext, fusionControllerPrompt } from '../server/fusion/control.mjs';
import { FusionController } from '../server/fusion/controller.mjs';
import { NativeAgentProvider, nativeAgentProvider, nativeAgentProviders, registerNativeAgentProvider } from '../server/fusion/providers.mjs';
import { FusionMcpServer } from '../server/fusion/mcp.mjs';
import { fusionProject } from '../server/fusion/state.mjs';

function nativeRenameFixture(app) {
  const bound = app === 'devin' ? 'acp/devin-cli/own' : 'own';
  const rows = new Map([[bound, { id: bound, composerId: bound, providerId: app === 'devin' ? 'devin-cli' : 'native-provider', name: 'Old name', title: 'Old name', workspace: '/qa-project', cwd: '/qa-project', path: '/qa/sessions/own.jsonl', status: { type: 'active' }, running: true }],
    ['ordinary', { id: 'ordinary', composerId: 'ordinary', name: 'Ordinary', title: 'Ordinary', workspace: '/ordinary', cwd: '/ordinary', model: 'kept', draft: 'untouched' }]]), calls = [];
  const rename = (id, title) => { rows.get(id).name = rows.get(id).title = title; };
  const manager = { readThread: async id => ({ thread: rows.get(id) }), getConversation: id => rows.get(id),
    async setThreadTitle(id, title, options) { calls.push(['codex', id, title, options]); rename(id, title.slice(0, 60)); return true; } };
  const services = { data: { allComposersData: { allComposers: [...rows.values()] }, getComposerDataIfLoaded: () => null },
    composer: { async renameComposer(id, title) { calls.push(['cursor', id, title]); rename(id, title); } } };
  const nativeModule = { renameSessionThunk: (provider, id, title) => { assert.equal(id, 'own'); return { provider, id, title }; },
    unprefixSessionId: id => { assert.equal(id, bound); return { connectorId: 'devin-cli', sessionId: 'own' }; } };
  const context = vm.createContext({ remoteContext: { app, threadId: bound, host: '' }, Error, String, nativeModule,
    codexConversationManager: () => manager, codexNativeManager: () => manager, codexHistoryScopes: () => [],
    nativeSessionCatalog: async () => ({ ready: true, complete: true, rows: [...rows.values()] }),
    nativeSessionContext: async (_app, id) => ({ cwd: rows.get(id).cwd, host: '' }), cursorSessionServices: () => services,
    devinSessionRecord: id => rows.get(id), window: { __acpStore: { async dispatch({ provider, id, title }) { calls.push(['devin', provider, id, title]); rename(bound, title); } } },
    devinSessionMenu: id => ({ actions: [{ label: 'rename', disabled: false, direct: true, onClick: title => { calls.push(['ordinary-menu', id, title]); rename(id, title); } }] }) });
  const source = fs.readFileSync(new URL('../server/page/session-actions.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('  const nativeSessionCleanup ='), source.indexOf('  const nativeCodexCreation ='))
    + source.slice(source.indexOf('  const nativeSessionAction ='), source.indexOf('  const nativeSessionRenameInput ='));
  vm.runInContext(code.replaceAll("await import('@exa/chat-client')", 'nativeModule') + ';this.info=nativeSessionInfo;this.action=nativeSessionAction;', context);
  return { rows, calls, manager, context, action: context.action, info: context.info, id: bound };
}
test('Fusion native name operations target the bound session in each software without switching ordinary state', async () => {
  for (const app of ['codex', 'cursor', 'devin']) {
    const h = nativeRenameFixture(app), ordinary = structuredClone(h.rows.get('ordinary'));
    const before = await h.info(app, h.id, 'name'); assert.equal(before.title, 'Old name'); assert.equal(before.running, true);
    const result = await h.action(app, h.id, 'rename', 'Workbench title');
    assert.equal(result.confirmed, true); assert.equal(result.title, 'Workbench title');
    const actual = await h.info(app, h.id, 'name'); assert.equal(actual.title, 'Workbench title'); assert.equal(actual.running, true);
    assert.deepEqual(h.rows.get('ordinary'), ordinary); assert.equal(h.calls.length, 1);
    if (app === 'codex') assert.equal(h.calls[0][3].requireAcknowledgement, true);
    if (app !== 'cursor') {
      const calls = h.calls.length;
      await assert.rejects(() => h.action(app, 'ordinary', 'rename', 'Wrong binding'), /不属于这个任务 Binding/);
      assert.equal(h.calls.length, calls);
    }
  }
  const h = nativeRenameFixture('codex'), title = 'Long workbench title '.repeat(5);
  const result = await h.action('codex', h.id, 'rename', title);
  assert.equal(result.title, title.slice(0, 60)); assert.equal((await h.info('codex', h.id, 'name')).title, result.title);
  for (const app of ['cursor', 'devin']) {
    const ordinary = nativeRenameFixture(app); ordinary.context.remoteContext = null;
    const result = await ordinary.action(app, 'ordinary', 'rename', 'Ordinary renamed');
    assert.equal(ordinary.rows.get('ordinary').title, 'Ordinary renamed'); assert.equal(result.title, undefined);
    assert.equal(ordinary.calls[0][0], app === 'cursor' ? 'cursor' : 'ordinary-menu');
  }
});
test('a bound devin rename passes the raw ACP session id while binding and state keep the full id', async () => {
  const h = nativeRenameFixture('devin'), ordinary = structuredClone(h.rows.get('ordinary'));
  const result = await h.action('devin', h.id, 'rename', 'Workbench title');
  assert.equal(result.confirmed, true); assert.equal(result.title, 'Workbench title');
  assert.deepEqual(h.calls, [['devin', 'devin-cli', 'own', 'Workbench title']]);
  assert.equal((await h.info('devin', h.id, 'name')).title, 'Workbench title');
  assert.equal(h.context.remoteContext.threadId, 'acp/devin-cli/own'); assert.deepEqual(h.rows.get('ordinary'), ordinary);
});
test('renameMain uses the current main binding and publishes the acknowledged native title while keeping task facts', async () => {
  const library = [], scope = vm.createContext({ nativeAgentProvider, fusionProject, Error, publishSessionChange: (...args) => library.push(args) });
  const rename = vm.runInContext('({' + FusionAgent.prototype.renameMain.toString() + '}).renameMain', scope);
  for (const app of ['codex', 'cursor', 'devin']) {
    const h = fixture(), binding = h.run.bindings[0], calls = [], ordinary = { threadId: 'ordinary', model: 'kept', draft: 'kept' };
    binding.app = h.run.main.app = app; binding.threadId = 'main-' + app;
    h.run.bindings.push({ ...binding, id: 'worker', role: 'worker', threadId: 'worker' });
    const before = structuredClone(h.run), context = { native: ordinary }, state = { exists: true, title: 'Old', running: true, context: { cwd: h.project.root, host: '' } };
    const canonical = app === 'codex' ? 'Canonical native title' : 'New title';
    const agent = { carrierFor: async (_run, software, project) => { assert.equal(software, app); assert.equal(project, binding.project); return context; },
      close: async value => { assert.equal(value, context); calls.push('close'); }, call: async (value, code) => {
        assert.equal(value.native.threadId, binding.threadId); const call = nativeInvocation(code); calls.push(call.args[2]);
        if (call.method === 'nativeSessionInfo') return { ...state };
        assert.equal(call.args[2], 'rename'); assert.equal(call.args[3], 'New title');
        state.title = canonical; return { confirmed: true, title: canonical };
      } };
    const result = await rename.call(agent, h.run, 'New title'); assert.equal(result.title, canonical);
    assert.deepEqual(calls, ['name', 'rename', 'name', 'close']); assert.deepEqual(h.run, before);
    assert.deepEqual(ordinary, { threadId: 'ordinary', model: 'kept', draft: 'kept' });
    assert.deepEqual(library.at(-1).slice(0, 2), [app, binding.threadId]);
    assert.equal(library.at(-1)[2].action, 'rename'); assert.equal(library.at(-1)[2].title, canonical);
    calls.length = 0;
    await rename.call(agent, h.run, canonical); assert.deepEqual(calls, ['name', 'close']);
  }
});
test('main rename refuses unconfirmed results and wrong projects while releasing connections and leaving unbound names local', async () => {
  const library = [], scope = vm.createContext({ nativeAgentProvider, fusionProject, Error, publishSessionChange: (...args) => library.push(args) });
  const rename = vm.runInContext('({' + FusionAgent.prototype.renameMain.toString() + '}).renameMain', scope);
  for (const failure of ['project', 'receipt', 'readback', 'request']) {
    const h = fixture(), context = { native: {} }, calls = [];
    const agent = { carrierFor: async () => context, close: async () => calls.push('close'), call: async (_context, code) => {
      const call = nativeInvocation(code); calls.push(call.args[2]);
      if (call.method === 'nativeSessionInfo') return { exists: true, title: 'Old', context: { cwd: failure === 'project' ? '/wrong-project' : h.project.root, host: '' } };
      if (failure === 'request') throw new Error('Native request failed');
      return { confirmed: failure !== 'receipt', title: 'New' };
    } };
    await assert.rejects(() => rename.call(agent, h.run, 'New'), /项目不一致|尚未确认|Native request failed/);
    assert.equal(calls.at(-1), 'close'); assert.equal(library.length, 0);
  }
  const h = fixture(); h.run.main.bindingId = '';
  assert.equal((await rename.call({}, h.run, 'Before creation')).title, 'Before creation');
  h.run.main.bindingId = 'not-a-binding';
  await assert.rejects(() => rename.call({}, h.run, 'Invalid'), /没有这个原生 Binding/);
});

function nativeCleanupFixture(app) {
  const rows = new Map([['own', { id: 'own', providerId: 'native-provider', workspace: '/qa-project', cwd: '/qa-project', path: '/qa/sessions/own.jsonl', archived: false, running: false, status: { type: 'idle' } }],
    ['ordinary', { id: 'ordinary', workspace: '/ordinary', cwd: '/ordinary', model: 'unchanged', draft: 'retained' }]]), calls = [];
  const manager = { async readThread(id) { if (!rows.has(id)) throw new Error('thread not found'); return { thread: rows.get(id) }; },
    async archiveConversation(id) { calls.push(['archive', id]); rows.get(id).path = '/qa/archived_sessions/' + id + '.jsonl'; } };
  const capabilities = { sessionCapabilities: { delete: true } };
  const nativeModule = { tryGetAcpSingleton: key => key === 'connectorService' ? { getConnectorById: () => ({ capabilities }) } : {},
    sendAgentRequestThunk: (_provider, request) => ({ request }) };
  const context = vm.createContext({ remoteContext: { app, threadId: 'own', host: '' }, Error, String,
    codexConversationManager: () => manager, codexHistoryScopes: () => [],
    nativeSessionCatalog: async () => ({ ready: true, complete: app === 'cursor', rows: [...rows.values()], removed: rows.has('own') ? [] : ['own'] }),
    nativeSessionContext: async (_app, id) => ({ cwd: rows.get(id).cwd, host: '' }),
    cursorSessionServices: () => ({ data: { allComposersData: { allComposers: [...rows.values()] } } }),
    nativeSessionAction: async (_app, id, action) => { calls.push([action, id]); rows.get(id).archived = true; return { action: 'archive', confirmed: true }; },
    devinSessionRecord: id => rows.get(id), nativeModule,
    window: { __acpStore: { async dispatch({ request }) { calls.push([request.method, request.params.sessionId]); rows.delete(request.params.sessionId); } } } });
  const source = fs.readFileSync(new URL('../server/page/session-actions.js', import.meta.url), 'utf8');
  vm.runInContext(source.slice(source.indexOf('  const nativeSessionCleanup ='), source.indexOf('  const nativeSessionInfo ='))
    .replaceAll("await import('@exa/chat-client')", 'nativeModule') + ';this.cleanup=nativeSessionCleanup;', context);
  return { rows, calls, context, capabilities, cleanup: context.cleanup };
}
test('Fusion native cleanup targets one actual conversation, records delete or archive, and leaves ordinary state unchanged', async () => {
  for (const app of ['codex','cursor','devin']) {
    const h = nativeCleanupFixture(app), ordinary = structuredClone(h.rows.get('ordinary'));
    const before = await h.cleanup(app, 'own'); assert.equal(before.exists, true); assert.equal(h.calls.length, 0);
    const result = await h.cleanup(app, 'own', true);
    assert.equal(result.confirmed, true); assert.equal(result.action, app === 'devin' ? 'delete' : 'archive');
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0][1], 'own'); assert.deepEqual(h.rows.get('ordinary'), ordinary);
    const again = await h.cleanup(app, 'own', true); assert.equal(again.already, true); assert.equal(h.calls.length, 1);
  }
});
test('native cleanup does not guess an uncertain absence, clear the last Cursor conversation, or stop a running target', async () => {
  const cursor = nativeCleanupFixture('cursor'); cursor.rows.delete('ordinary');
  await assert.rejects(() => cursor.cleanup('cursor', 'own', true), /清空不能代替删除或归档/); assert.equal(cursor.calls.length, 0);
  const codex = nativeCleanupFixture('codex'); codex.rows.get('own').status.type = 'active';
  await assert.rejects(() => codex.cleanup('codex', 'own', true), /仍在运行/); assert.equal(codex.calls.length, 0);
  const devin = nativeCleanupFixture('devin'); devin.capabilities.sessionCapabilities.delete = false;
  await assert.rejects(() => devin.cleanup('devin', 'own', true), /未提供.*后台删除能力/); assert.equal(devin.calls.length, 0);
  devin.context.nativeSessionCatalog = async () => ({ ready: true, complete: false, rows: [], removed: [] });
  await assert.rejects(() => devin.cleanup('devin', 'own', true), /状态尚未确认/); assert.equal(devin.calls.length, 0);
  const wrong = nativeCleanupFixture('cursor'); wrong.context.remoteContext.threadId = 'ordinary';
  await assert.rejects(() => wrong.cleanup('cursor', 'own', true), /不属于这个原生 Binding/); assert.equal(wrong.calls.length, 0);
});
test('cleanupBinding uses the software provider and exact project without loading ordinary history or changing drafts', async () => {
  const h = fixture(), library = [], context = vm.createContext({ nativeAgentProvider, fusionProject, Date, Error,
    favoriteSession: (...args) => library.push(['favorite', ...args]), removeLibrarySession: (...args) => library.push(['remove', ...args]),
    publishSessionChange: (...args) => library.push(['change', ...args]) });
  const cleanup = vm.runInContext('({' + FusionAgent.prototype.cleanupBinding.toString() + '}).cleanupBinding', context);
  for (const app of ['codex','cursor','devin']) {
    const calls = [], native = { app, page: { id: 'shared-window' }, native: { threadId: 'ordinary' } }, binding = { app, threadId: 'own-' + app, project: h.project };
    const agent = { carrierFor: async (_run, software, project) => { assert.equal(software, app); assert.equal(project, h.project); return native; },
      close: async value => { assert.equal(value, native); calls.push('close'); },
      call: async (value, code) => { assert.equal(value.native.threadId, binding.threadId); const call = nativeInvocation(code); calls.push(call);
        return call.method === 'nativeSessionInfo' ? { exists: true, running: false, context: { cwd: h.project.root, host: '' } }
          : { confirmed: true, action: app === 'codex' ? 'archive' : 'delete' }; } };
    const result = await cleanup.call(agent, h.run, binding);
    assert.equal(result.confirmed, true); assert.equal(result.threadId, binding.threadId);
    assert.deepEqual(calls.slice(0,2).map(row => row.args[2]), ['cleanup','cleanup']); assert.equal(calls[2], 'close');
  }
  assert(library.every(row => row[2].startsWith('own-')));
  const calls = [], native = { native: {} }, binding = { app: 'codex', threadId: 'own-mismatch', project: h.project };
  const agent = { carrierFor: async () => native, close: async () => calls.push('close'),
    call: async (_context, code) => { calls.push(nativeInvocation(code)); return { exists: true, running: false, context: { cwd: '/unrelated-project', host: '' } }; } };
  const before = library.length;
  await assert.rejects(() => cleanup.call(agent, h.run, binding), /项目不一致/);
  assert.equal(calls.length, 2); assert.equal(calls[1], 'close'); assert.equal(library.length, before);
});

test('native applications share one controller creation contract and model choices remain ordinary data', async () => {
  for (const app of ['cursor', 'devin', 'codex']) {
    const h = fixture(), calls = [], agent = new FusionAgent({ publish() {} });
    h.run.main = { app, model: 'native-new-model', effort: 'native-strength', bindingId: '', windowId: 'existing-project-window' };
    agent.createBinding = async (_run, _owner, software, project, role, spec, windowId) => {
      calls.push({ software, project, role, spec, windowId }); return { id: 'created-' + app };
    };
    assert.equal((await agent.prepareMain(h.run)).id, 'created-' + app);
    assert.equal(calls.length, 1); assert.equal(calls[0].software, app); assert.equal(calls[0].role, 'main');
    assert.equal(calls[0].spec.model, 'native-new-model'); assert.equal(calls[0].spec.effort, 'native-strength');
    assert.equal(calls[0].spec.tools, FUSION_TOOLS); assert.equal(calls[0].windowId, 'existing-project-window');
  }
  assert.deepEqual(nativeAgentProviders().map(row => row.app).sort(), ['codex', 'cursor', 'devin']);
});
test('a registered software adapter supports future model IDs without a per-model manager', async t => {
  const provider = new NativeAgentProvider({ app: 'fixture-editor', name: 'Fixture editor' });
  t.after(registerNativeAgentProvider(provider));
  assert.equal(nativeAgentProvider('fixture-editor'), provider);
  const calls = [], agent = { call: async (_context, code) => { calls.push(code); return {}; } }, context = { native: { threadId: 'retained-thread' } };
  for (const model of ['model-before', 'newly-added-model']) await provider.create(agent, context, { model, effort: 'native-option' });
  assert.equal(calls.length, 2); assert(calls.every(code => code.includes('fixture-editor') && code.includes('retained-thread')));
  assert(calls[1].includes('newly-added-model'));
});
test('Cursor tool snapshots and native replies are scoped to bound composers and restore the exact ordinary RPC methods', async () => {
  const ordinary = [], base = [{ serverIdentifier: 'ordinary', tools: [] }], events = [];
  class Rpc {
    async $getMcpSnapshots(context) { ordinary.push(['snapshots', context]); return base; }
    $getMcpSnapshot(server, context) { ordinary.push(['snapshot', server, context]); return base[0]; }
    async $getMcpSnapshotTools(context) { ordinary.push(['tools', context]); return base; }
    $callMcpLeaseTool(...args) { ordinary.push(['call', ...args]); return 'ordinary-result'; }
  }
  const rpc = new Rpc(), originals = Object.fromEntries(['$getMcpSnapshots', '$getMcpSnapshot', '$getMcpSnapshotTools', '$callMcpLeaseTool'].map(key => [key, rpc[key]]));
  const extension = { _extensionHostManagers: { _extensionHostManagers: [{ extensionHost: { _rpcProtocol: { _locals: [rpc] } } }] } };
  const data = { fullConversationHeadersOnly: [{ type: 1, bubbleId: 'actual-user' }], latestChatGenerationUUID: 'actual-generation' };
  const nativeType = { fromJson: structuredClone }, fields = () => [{ localName: 'tools', T: nativeType }, { localName: 'mcpInstructions', T: nativeType }];
  class RequestContext {
    static fields = { list: fields };
    constructor() { this.tools = []; this.mcpInstructions = []; this.mcpMetaToolOptions = { constructor: { fields: { list: () => [{ localName: 'mcpDescriptors', T: nativeType }] } }, mcpDescriptors: [] }; }
    clone() { const value = new RequestContext(); value.tools = [...this.tools]; value.mcpInstructions = [...this.mcpInstructions]; return value; }
  }
  const ordinaryRequest = new RequestContext(), agent = { async buildComposerRequestContext() { return ordinaryRequest; } }, originalContext = agent.buildComposerRequestContext;
  const context = vm.createContext({ window: {}, Map, Set, WeakMap, Error, JSON, nativeValue: structuredClone,
    cursorSessionInstantiation: () => ({ _services: { _entries: new Map([['extensionService', 'extensionService']]) }, invokeFunction: fn => fn({ get: () => extension }) }),
    cursorSessionServices: () => ({ data: { getComposerDataIfLoaded: () => data }, composer: { composerChatService: { _composerAgentService: agent } } }),
    doc: { defaultView: { CustomEvent, dispatchEvent: event => events.push(event.detail) } } });
  vm.runInContext(fs.readFileSync(new URL('../server/page/fusion-tools.js', import.meta.url), 'utf8') + ';this.tools=fusionNativeTools;', context);
  await context.tools.bind('cursor', 'main-one', { tools: FUSION_TOOLS, instructions: 'Only main one' });
  await context.tools.bind('cursor', 'main-two', { tools: FUSION_TOOLS, instructions: 'Only main two' });
  const ordinaryContext = { composerId: 'ordinary', conversationId: 'ordinary-round' };
  assert.equal(await rpc.$getMcpSnapshots(ordinaryContext), base);
  assert.equal(await rpc.$getMcpSnapshotTools(ordinaryContext), base);
  const one = await rpc.$getMcpSnapshots({ composerId: 'main-one' }), two = await rpc.$getMcpSnapshots({ composerId: 'main-two' });
  assert.equal(one[1].instructions, 'Only main one'); assert.equal(two[1].instructions, 'Only main two');
  assert.equal(one[1].tools[0].name, 'ra_fusion'); assert.equal(base.length, 1);
  assert.equal(await agent.buildComposerRequestContext(null, 'ordinary'), ordinaryRequest);
  const mainContext = await agent.buildComposerRequestContext(null, 'main-one');
  assert.equal(mainContext.tools[0].toolName, 'ra_fusion'); assert.equal(mainContext.mcpInstructions[0].instructions, 'Only main one');
  assert.equal(mainContext.mcpMetaToolOptions.mcpDescriptors[0].tools[0].toolName, 'ra_fusion'); assert.equal(ordinaryRequest.tools.length, 0);
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  assert.equal(rpc.$callMcpLeaseTool('ordinary', 'native-tool', {}, 'ordinary-call', ordinaryContext, null, 'ordinary', token), 'ordinary-result');
  const waiting = rpc.$callMcpLeaseTool('ra-fusion', 'ra_fusion', { action: 'read_workspace' }, 0, { composerId: 'main-one' }, null, 'main-one', token);
  const pending = context.tools.requests('cursor', 'main-one');
  assert.equal(pending.length, 1); assert.equal(pending[0].id, 0); assert.equal(pending[0].params.turnId, 'actual-user');
  assert.equal(pending[0].params.generationId, 'actual-generation'); assert.equal(context.tools.requests('cursor', 'main-two').length, 0);
  context.tools.reply('cursor', 'main-one', { requestId: 0, result: { success: true, contentItems: [{ type: 'inputText', text: 'actual result' }] } });
  assert.deepEqual(JSON.parse(JSON.stringify(await waiting)), { content: [{ type: 'text', text: 'actual result' }], isError: false });
  assert(events.every(event => event.app === 'cursor' && event.threadId === 'main-one'));
  context.tools.unbind('cursor', 'main-one'); assert.notEqual(rpc.$getMcpSnapshots, originals.$getMcpSnapshots);
  context.tools.unbind('cursor', 'main-two');
  assert.equal(agent.buildComposerRequestContext, originalContext);
  for (const [key, original] of Object.entries(originals)) { assert.equal(rpc[key], original); assert.equal(Object.hasOwn(rpc, key), false); }
});
test('session-scoped MCP carries the same tool request and reply without a model execution channel', async t => {
  const server = new FusionMcpServer(), binding = { id: 'main-binding' }, identified = [], notifications = [];
  const channel = await server.bind(binding, { tools: FUSION_TOOLS, instructions: 'Main scope', changed: () => notifications.push('changed'),
    identify: async input => { identified.push(input); return { id: 'actual-call', params: { threadId: 'native-main', turnId: 'native-round', callId: 'actual-call', tool: input.tool, arguments: input.arguments } }; } });
  t.after(() => channel.close());
  const request = async (id, method, params) => fetch(channel.config.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  const initialization = await (await request(0, 'initialize', { protocolVersion: '2025-06-18' })).json();
  assert.equal(initialization.id, 0); assert.equal(initialization.result.instructions, 'Main scope');
  const catalog = await (await request(1, 'tools/list', {})).json(); assert.equal(catalog.result.tools[0].name, 'ra_fusion');
  assert.equal((await fetch(channel.config.url)).status, 405);
  assert.equal((await fetch(channel.config.url, { method: 'POST', headers: { origin: 'https://unrelated.example' }, body: '{}' })).status, 403);
  const call = request(7, 'tools/call', { name: 'ra_fusion', arguments: { action: 'read_workspace' } });
  for (let n = 0; n < 100 && !channel.requests().length; n++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(channel.requests()[0].id, 'actual-call'); assert.equal(channel.requests()[0].params.threadId, 'native-main');
  await channel.reply('actual-call', { success: true, contentItems: [{ type: 'inputText', text: 'workspace events' }] });
  const result = await (await call).json(); assert.equal(result.id, 7); assert.equal(result.result.content[0].text, 'workspace events');
  assert.equal(result.result.isError, false); assert.equal(identified.length, 1); assert(notifications.length);
});
test('an MCP main carries its durable tool endpoint in the initial native creation without loading an empty session', async () => {
  const provider = nativeAgentProvider('devin'), creation = { id: 'actual-creation' }, calls = [], controller = { main: { bindingId: 'new-binding' }, bindings: [] };
  const context = { native: { threadId: 'ordinary' } }, spec = { role: 'main', model: 'native-model', tools: FUSION_TOOLS, instructions: 'Own controller' };
  const agent = { publish(value) { assert.equal(value, controller); assert(creation.mcp?.port); },
    call: async (_context, code) => { const invocation = nativeInvocation(code); calls.push(invocation); return {}; } };
  await provider.create(agent, context, spec, controller, creation);
  const request = calls[0].args[3]; assert.equal(calls[0].args[2], 'create'); assert.equal(request.model, spec.model);
  assert.equal(new URL(request.mcp.url).port, String(creation.mcp.port));
  controller.bindings.push({ id: 'new-binding', threadId: 'own-main', mcp: creation.mcp });
  try { await provider.bindController(agent, context, controller, spec);
    assert.equal(context.fusionMcp.config.url, request.mcp.url);
    assert.equal(calls.filter(call => call.args[2] === 'create').length, 1);
  } finally { await provider.unbindController(agent, context); }
});
test('Devin binds MCP to its own session and preserves native request identity and failed facts after transcript cleanup', async () => {
  const session = { sessionId: 'main-devin', providerId: 'devin-cli', cwd: '/project', status: 'idle', mcpServers: [{ name: 'existing', type: 'http', url: 'http://native-existing' }] };
  const state = { sessions: [session], perSession: { 'main-devin': { messages: [] } }, agentRequests: { byId: {} } }, listeners = new Set(), sent = [];
  const update = () => { for (const listener of [...listeners]) listener(); };
  const nativeModule = { tryGetAcpSingleton: name => name === 'connectorService'
    ? { getConnectors: () => [{ id: 'devin-cli', capabilities: { mcpCapabilities: { http: true } } }] } : 'native-sender',
    sendAgentRequestThunk: (provider, request, sender) => ({ provider, request, sender }) };
  const window = { __acpStore: { getState: () => ({ acp: state }), subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    dispatch: async request => sent.push(request) } };
  const context = vm.createContext({ window, Map, Set, WeakMap, Error, JSON, nativeModule, devinSessionRecord: () => session });
  const source = fs.readFileSync(new URL('../server/page/fusion-tools.js', import.meta.url), 'utf8').replace("await import('@exa/chat-client')", 'nativeModule');
  vm.runInContext(source + ';this.tools=fusionNativeTools;this.turn=fusionDevinTurn;this.identify=fusionDevinCall;', context);
  const config = { name: 'ra-fusion', type: 'http', url: 'http://native-test', headers: [] };
  assert.equal((await context.tools.bind('devin', 'main-devin', { tools: FUSION_TOOLS, mcp: config })).profileReady, true);
  assert.equal(sent.length, 1); assert.equal(sent[0].request.method, 'session/load');
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0].request.params.mcpServers)), [...session.mcpServers, config]);
  session.status = 'active'; state.agentRequests.byId['actual-generation'] = { method: 'session/prompt', status: 'started',
    params: { sessionId: 'main-devin', _meta: { 'cognition.ai/clientMessageId': 'client-message' } } };
  state.perSession['main-devin'].messages.push({ id: 'actual-user', kind: 'user_message',
    content: [{ content: { type: 'text', text: 'Authorized native request' }, _meta: { 'cognition.ai/clientMessageId': 'client-message' } }] });
  state.perSession['main-devin'].messages.push({ kind: 'tool_call', content: { toolCallId: 'actual-tool', status: 'in_progress',
    rawInput: { action: 'read_workspace' }, _meta: { 'cognition.ai/toolName': 'mcp__ra-fusion__ra_fusion' } } });
  update();
  const call = context.identify('main-devin', { tool: 'ra_fusion', arguments: { action: 'read_workspace' } });
  session.status = 'idle'; update();
  const identified = await call;
  assert.equal(identified.id, 'actual-tool'); assert.equal(identified.params.turnId, 'actual-user'); assert.equal(identified.params.generationId, 'actual-generation');
  state.agentRequests.byId['actual-generation'].status = 'failed'; state.agentRequests.byId['actual-generation'].errorMessage = 'Native error 13'; update();
  delete state.agentRequests.byId['actual-generation']; state.perSession['main-devin'].messages = []; session.status = 'idle'; update();
  const ended = context.turn('main-devin'); assert.equal(ended.id, 'actual-user'); assert.equal(ended.accepted, true);
  assert.equal(ended.ended, true); assert.equal(ended.completed, false); assert.equal(ended.error, 'Native error 13');
  assert.equal(ended.user, 'Authorized native request'); context.tools.unbind('devin', 'main-devin'); assert.equal(listeners.size, 0);
  session.mcpServers.push(config); session.status = 'idle';
  assert.equal((await context.tools.bind('devin', 'main-devin', { tools: FUSION_TOOLS, mcp: config })).profileReady, true);
  assert.equal(sent.length, 1); context.tools.unbind('devin', 'main-devin'); assert.equal(listeners.size, 0);
});
function devinToolsFixture() {
  const session = { sessionId: 'main-devin', providerId: 'devin-cli', cwd: '/project', status: 'idle',
    mcpServers: [{ name: 'ra-fusion', type: 'http', url: 'http://native-test', headers: [] }] };
  const state = { sessions: [session], perSession: { 'main-devin': { messages: [] } }, agentRequests: { byId: {} } }, listeners = new Set();
  const update = () => { for (const listener of [...listeners]) listener(); };
  const nativeModule = { tryGetAcpSingleton: name => name === 'connectorService'
    ? { getConnectors: () => [{ id: 'devin-cli', capabilities: { mcpCapabilities: { http: true } } }] } : 'native-sender',
    sendAgentRequestThunk: (provider, request, sender) => ({ provider, request, sender }) };
  const window = { __acpStore: { getState: () => ({ acp: state }), subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    dispatch: async () => true } };
  const context = vm.createContext({ window, Map, Set, WeakMap, Error, JSON, nativeModule, devinSessionRecord: () => session });
  const source = fs.readFileSync(new URL('../server/page/fusion-tools.js', import.meta.url), 'utf8').replace("await import('@exa/chat-client')", 'nativeModule');
  vm.runInContext(source + ';this.tools=fusionNativeTools;this.turn=fusionDevinTurn;this.identify=fusionDevinCall;', context);
  const config = { name: 'ra-fusion', type: 'http', url: 'http://native-test', headers: [] };
  return { session, state, update, context, listeners,
    bind: () => context.tools.bind('devin', 'main-devin', { tools: FUSION_TOOLS, mcp: config }),
    prompt: (generationId, clientId, status = 'started') => { state.agentRequests.byId[generationId] = { method: 'session/prompt', status,
      params: { sessionId: 'main-devin', _meta: { 'cognition.ai/clientMessageId': clientId } } }; },
    user: (id, clientId, text, optimistic = false) => state.perSession['main-devin'].messages.push({ id, kind: 'user_message',
      content: [{ content: { type: 'text', text }, _meta: { 'cognition.ai/clientMessageId': clientId,
        ...(optimistic ? { 'cognition.ai/isOptimistic': true } : {}) } }] }),
    agent: (id, text) => state.perSession['main-devin'].messages.push({ id, kind: 'agent_message',
      content: [{ content: { type: 'text', text } }] }) };
}
test('Devin tool identification only matches the real qualified name with post-approval facts', async () => {
  const h = devinToolsFixture();
  assert.equal((await h.bind()).profileReady, true);
  const clientId = '3f8c2e1a-7b4d-4e5f-9a6b-1c2d3e4f5a6b';
  h.session.status = 'active';
  h.prompt('generation-1', clientId);
  h.user('user-1', clientId, 'Call the tool');
  h.state.perSession['main-devin'].messages.push({ kind: 'tool_call',
    content: { toolCallId: 'call-1', rawInput: { arguments: { action: 'read_workspace' } } } });
  h.update();
  let p1 = 'pending';
  h.context.identify('main-devin', { tool: 'ra_fusion', arguments: { action: 'read_workspace' } })
    .then(value => p1 = value, error => p1 = error);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p1, 'pending');
  const tool = h.state.perSession['main-devin'].messages.at(-1).content;
  tool.status = 'in_progress'; tool.rawInput = { action: 'read_workspace' }; tool._meta = { 'cognition.ai/toolName': 'mcp__ra-fusion__ra_fusion' };
  h.update(); await new Promise(resolve => setImmediate(resolve));
  if (p1 === 'pending') { h.session.status = 'idle'; h.update(); await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(p1.id, 'call-1'); assert.equal(p1.params.turnId, 'user-1'); assert.equal(p1.params.generationId, 'generation-1');
  const rejected = [];
  const waiting = h.context.identify('main-devin', { tool: 'ra_fusion', arguments: { action: 'list_models' } })
    .then(value => rejected.push(value), error => rejected.push(error));
  h.state.perSession['main-devin'].messages.push(
    { kind: 'tool_call', content: { toolCallId: 'call-other', status: 'in_progress', rawInput: { action: 'list_models' },
      _meta: { 'cognition.ai/toolName': 'mcp__other-server__ra_fusion' } } },
    { kind: 'tool_call', content: { toolCallId: 'call-done', status: 'completed', rawInput: { action: 'list_models' },
      _meta: { 'cognition.ai/toolName': 'mcp__ra-fusion__ra_fusion' } } },
    { kind: 'tool_call', content: { toolCallId: 'call-failed', status: 'failed', rawInput: { action: 'list_models' },
      _meta: { 'cognition.ai/toolName': 'mcp__ra-fusion__ra_fusion' } } });
  h.update(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(rejected.length, 0);
  h.context.tools.unbind('devin', 'main-devin');
  await waiting;
  assert.match(String(rejected[0]?.message || rejected[0]), /连接已释放/);
  assert.equal(h.listeners.size, 0);
});
test('Devin turn cache preserves accepted identity and final reply through pruning and request removal', async () => {
  const h = devinToolsFixture();
  assert.equal((await h.bind()).profileReady, true);
  const clientId = '5f2a0f6e-9b1c-4a3d-8e7f-2c6b9a1d4e5f';
  h.session.status = 'active';
  h.prompt('generation-1', clientId);
  h.user('user-1', clientId, 'First question');
  h.agent('reply-1', 'partial answer');
  h.update();
  let turn = h.context.turn('main-devin');
  assert.equal(turn.id, 'user-1'); assert.equal(turn.accepted, true); assert.equal(turn.text, 'partial answer'); assert.equal(turn.ended, false);
  h.state.perSession['main-devin'].messages.at(-1).content[0].content.text = 'final answer';
  h.update();
  turn = h.context.turn('main-devin'); assert.equal(turn.text, 'final answer');
  h.state.agentRequests.byId['generation-1'].status = 'completed';
  h.state.perSession['main-devin'].messages = [];
  h.update();
  const facts = value => ({ id: value.id, turnId: value.turnId, generationId: value.generationId, accepted: value.accepted,
    ended: value.ended, completed: value.completed, user: value.user, text: value.text });
  const expected = { id: 'user-1', turnId: 'user-1', generationId: 'generation-1', accepted: true, ended: true,
    completed: true, user: 'First question', text: 'final answer' };
  assert.deepEqual(facts(h.context.turn('main-devin')), expected);
  assert.deepEqual(facts(h.context.turn('main-devin')), expected);
  delete h.state.agentRequests.byId['generation-1']; h.update();
  assert.deepEqual(facts(h.context.turn('main-devin')), expected);
  h.context.tools.unbind('devin', 'main-devin'); assert.equal(h.listeners.size, 0);
});
test('Devin turn cache keeps replies scoped to each user turn without leaking across users', async () => {
  const h = devinToolsFixture();
  assert.equal((await h.bind()).profileReady, true);
  h.session.status = 'active';
  const [c1, c2, c3] = ['a1b2c3d4-1111-4000-8000-000000000001', 'a1b2c3d4-2222-4000-8000-000000000002', 'a1b2c3d4-3333-4000-8000-000000000003'];
  h.prompt('gen-1', c1); h.user('u1', c1, 'first question'); h.agent('r1', 'first answer');
  h.state.agentRequests.byId['gen-1'].status = 'completed';
  h.prompt('gen-2', c2); h.user('u2', c2, 'second question'); h.agent('r2', 'second answer');
  h.update();
  assert.equal(h.context.turn('main-devin', 'u1').text, 'first answer');
  assert.equal(h.context.turn('main-devin', '', 'gen-1').text, 'first answer');
  assert.equal(h.context.turn('main-devin', 'u2').text, 'second answer');
  const latest = h.context.turn('main-devin');
  assert.equal(latest.id, 'u2'); assert.equal(latest.text, 'second answer'); assert.equal(latest.generationId, 'gen-2');
  h.prompt('gen-3', c3); h.user('u3', c3, 'ghost turn', true);
  h.update();
  const ghost = h.context.turn('main-devin', '', 'gen-3');
  assert.equal(ghost.accepted, false); assert.equal(ghost.id, '');
  h.state.agentRequests.byId['gen-3'].status = 'completed';
  h.update();
  const closed = h.context.turn('main-devin', '', 'gen-3');
  assert.equal(closed.ended, true); assert.equal(closed.completed, false);
  h.user('u3-real', c3, 'ghost turn');
  h.update();
  const real = h.context.turn('main-devin', '', 'gen-3');
  assert.equal(real.accepted, true); assert.equal(real.id, 'u3-real');
  assert.equal(real.ended, true); assert.equal(real.completed, false); assert.equal(real.text, '');
  assert.equal(h.context.turn('main-devin', 'u1').text, 'first answer');
  assert.equal(h.context.turn('main-devin', 'u2').text, 'second answer');
  h.context.tools.unbind('devin', 'main-devin'); assert.equal(h.listeners.size, 0);
});
test('idle Devin bindings release their store listeners while retaining cached turn facts', async () => {
  const h = devinToolsFixture();
  for (let n = 0; n < 40; n++) {
    const thread = 'released-' + n;
    h.state.perSession[thread] = { messages: [] };
    await h.context.tools.bind('devin', thread, { tools: FUSION_TOOLS, mcp: h.session.mcpServers[0] });
    assert.equal(h.listeners.size, 1);
    h.context.tools.unbind('devin', thread);
    assert.equal(h.listeners.size, 0);
    h.context.turn(thread);
    assert.equal(h.listeners.size, 0, 'a one-shot cached read does not reopen a subscription');
  }
  assert.equal(h.context.window.__remoteAgentDevinTurns.size, 40);
  h.update();
  assert.equal(h.listeners.size, 0);
});

test('a live Devin observer survives controller unbinding and releases the last shared listener when it closes', async () => {
  const h = devinToolsFixture();
  h.context.remoteContext = { app: 'devin', threadId: 'main-devin' };
  const source = fs.readFileSync(new URL('../server/page/chat-extract.js', import.meta.url), 'utf8');
  vm.runInContext(source.slice(source.indexOf('  const watchCodexData ='), source.indexOf('  const codexUserText ='))
    + ';this.watch=watchCodexData;', h.context);
  await h.bind();
  let changed = 0;
  const watching = h.context.watch(() => changed++);
  assert.equal(h.listeners.size, 1);
  h.prompt('generation', 'client'); h.user('user', 'client', 'task'); h.agent('reply', 'partial'); h.update();
  h.context.tools.unbind('devin', 'main-devin');
  assert.equal(h.listeners.size, 1);
  h.state.perSession['main-devin'].messages.at(-1).content[0].content.text = 'final'; h.update();
  h.state.agentRequests.byId.generation.status = 'completed'; delete h.state.perSession['main-devin']; h.update();
  assert.equal(changed, 3);
  watching.stop();
  assert.equal(h.listeners.size, 0);
  assert.equal(h.context.turn('main-devin').text, 'final');
  assert.equal(h.context.turn('main-devin').completed, true);
  assert.equal(h.listeners.size, 0);
  const resumed = h.context.watch(() => changed++);
  assert.equal(h.listeners.size, 1);
  h.update(); assert.equal(changed, 4);
  resumed.stop(); assert.equal(h.listeners.size, 0);
});

test('a new Devin Fusion session keeps ordinary pending preferences and sends its explicitly selected model', async () => {
  const ordinary = { sessionId: 'ordinary', providerId: 'devin-cli', cwd: '/project', draft: 'untouched',
    configOptions: [{ id: 'model', category: 'model', currentValue: 'ordinary-model', options: [{ value: 'swe-2-high' }] }] };
  const pending = { model: 'ordinary-pending-model' }, initial = structuredClone({ ordinary, pending });
  const sessions = new Map([[ordinary.sessionId, ordinary]]), staged = new Map(), calls = [];
  const nativeModule = { tryGetAcpSingleton: () => 'native-sender', sendAgentRequestThunk: (provider, request) => ({ provider, request }),
    setClientSideConfigValue: value => ({ type: 'setClientSideConfigValue', value }) };
  const window = { __acpStore: { dispatch: async action => {
    if (action.type === 'setClientSideConfigValue') { staged.set(action.value.sessionId, action.value.value); return; }
    const request = action.request; calls.push(request);
    if (request.method === 'session/new') {
      assert.equal(request.params._meta['cognition.ai/skipPreferenceSeeding'], true);
      sessions.set('own', { ...structuredClone(ordinary), sessionId: 'own', configOptions: [{ ...structuredClone(ordinary.configOptions[0]), currentValue: 'native-default' }] });
      return { sessionId: 'own' };
    }
    if (request.method === 'session/set_config_option') sessions.get(request.params.sessionId).configOptions[0].currentValue = request.params.value;
    if (request.method === 'session/prompt') {
      const model = staged.get(request.params.sessionId); if (model) sessions.get(request.params.sessionId).configOptions[0].currentValue = model;
      assert.equal(sessions.get('own').configOptions[0].currentValue, 'swe-2-high');
    }
    return true;
  } } };
  const context = vm.createContext({ window, nativeModule, Map, Promise, Error, JSON, remoteContext: { app: 'devin', threadId: 'ordinary' },
    doc: { defaultView: { Event: class {}, dispatchEvent() {} } }, devinSessionRecord: id => sessions.get(id), nativeSessionContext: async (_app, id) => ({ threadId: id }) });
  window.__acpStore.subscribe = () => () => {};
  window.__acpStore.getState = () => ({ acp: { sessions: [], perSession: {}, agentRequests: { byId: {} } } });
  const tools = fs.readFileSync(new URL('../server/page/fusion-tools.js', import.meta.url), 'utf8');
  vm.runInContext(tools.slice(tools.indexOf('  const fusionNativeControllers ='), tools.indexOf('  const fusionNativeTools =')), context);
  const source = fs.readFileSync(new URL('../server/page/session-actions.js', import.meta.url), 'utf8'), start = source.indexOf('  const nativeSessionAction ='), end = source.indexOf('  const nativeSessionConfirm', start);
  vm.runInContext(source.slice(start, end).replaceAll("await import('@exa/chat-client')", 'nativeModule') + ';this.action=nativeSessionAction;', context);
  const mcp = { type: 'http', name: 'ra-fusion', url: 'http://own-endpoint', headers: [] };
  assert.equal((await context.action('devin', 'ordinary', 'create', { role: 'main', requestId: 'new-own', root: '/project', model: 'swe-2-high', mcp })).threadId, 'own');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].params.mcpServers)), [mcp]); assert.equal(staged.get('own'), 'swe-2-high');
  assert.equal(await context.action('devin', 'own', 'send', { requestId: 'new-prompt', text: 'A fresh test' }), true);
  assert.equal(calls.filter(request => request.method === 'session/prompt').length, 1);
  assert.deepEqual({ ordinary, pending }, initial);
});

test('Fusion reads the Codex model catalog without loading the ordinary conversation history', async () => {
  const {run}=fixture(),calls=[],refreshes=[];
  const agent=new FusionAgent({catalog:{async refresh(models){refreshes.push(models);},enrich:snapshot=>({...snapshot,publicSources:[]})}});
  const context={app:'codex',page:{id:'project-window'},native:{threadId:'ordinary-thread',host:''}};
  agent.carrierFor=async()=>context;
  agent.close=async value=>{assert.equal(value,context);calls.push('close');};
  agent.call=async(_context,code)=>{
    assert.equal(code,'modelItemsFast(true)');calls.push(code);
    return [{id:'current-model',label:'Current model',efforts:[{label:'low'}]}];
  };
  const snapshot=await agent.capabilities(run,'codex');
  assert.equal(snapshot.models[0].model,'current-model');
  assert.deepEqual(calls,['modelItemsFast(true)','close']);
  assert.equal(context.pinned,undefined);
  assert.equal(refreshes.length,0);
  const next=await agent.capabilities(run,'codex',{knowledge:true});
  assert.deepEqual(refreshes,[[{app:'codex',model:'current-model'}]]);
  assert.deepEqual(next.models,snapshot.models);assert.equal(context.native.threadId,'ordinary-thread');
  assert.deepEqual(calls,['modelItemsFast(true)','close','modelItemsFast(true)','close']);
});

function nativeBindingFixture() {
  const { run } = fixture(), binding = run.bindings.find(row => row.id === run.main.bindingId), calls = [];
  const ordinary = { threadId: 'ordinary', model: 'unchanged', effort: 'high', draft: 'retained' };
  const conversation = { id: binding.threadId, cwd: run.project.root, latestCollaborationMode: { mode: 'default' }, historyComplete: false };
  const manager = { needsResume: () => false, getConversation: () => conversation,
    async resumeConversation(value) { calls.push({ action: 'resume', value }); return { status: 'ready' }; },
    ensureConversationHistoryLoaded: () => assert.fail('Fusion binding must not load complete history') };
  const context = vm.createContext({ Error, nativeValue: value => JSON.parse(JSON.stringify(value)),
    nativeSessionContext: async (app, id) => {
      assert.equal(app, binding.app); assert.equal(id, binding.threadId);
      return { app, threadId: id, cwd: conversation.cwd, host: binding.host, roots: [{ root: conversation.cwd, host: binding.host }] };
    }, codexHistoryScopes: () => [], codexConversationManager: () => manager });
  const source = fs.readFileSync(new URL('../server/page/session-actions.js', import.meta.url), 'utf8');
  vm.runInContext(source.slice(source.indexOf('  const nativeSessionInfo ='), source.indexOf('  const nativeCodexCreation ='))
    + ';this.info=nativeSessionInfo;', context);
  const agent = new FusionAgent({ publish: () => assert.fail('binding does not publish execution facts') });
  const carrier = { app: 'codex', native: { threadId: ordinary.threadId }, leaseId: 'binding-test' };
  agent.carrierFor = async () => carrier;
  agent.call = async (_context, code) => {
    const call = nativeInvocation(code); assert.equal(call.method, 'nativeSessionInfo');
    assert.equal(call.args[2], 'bind'); return context.info(...call.args);
  };
  agent.close = async value => { assert.equal(value, carrier); calls.push({ action: 'close' }); };
  return { run, binding, ordinary, conversation, manager, agent, calls };
}
test('a ready Fusion Codex binding reads its own incomplete-history conversation without requiring full history', async () => {
  const h = nativeBindingFixture(), ordinary = structuredClone(h.ordinary), before = JSON.stringify(h.run);
  const context = await h.agent.openBinding(h.run, h.binding);
  assert.equal(context.native.threadId, h.binding.threadId); assert.equal(context.native.cwd, h.binding.project.root);
  assert.equal(h.conversation.historyComplete, false); assert.equal(h.calls.length, 0);
  assert.equal(JSON.stringify(h.run), before); assert.deepEqual(h.ordinary, ordinary);
  h.conversation.cwd = '/different-project';
  await assert.rejects(h.agent.openBinding(h.run, h.binding), /原生会话目录与该任务项目不一致/);
  assert.deepEqual(h.calls, [{ action: 'close' }]); assert.deepEqual(h.ordinary, ordinary);
});
test('Fusion Codex binding still awaits native resume and refuses a not-ready or failed resume', async () => {
  for (const outcome of ['ready', 'not-ready', 'error']) {
    const h = nativeBindingFixture(), ordinary = structuredClone(h.ordinary), before = JSON.stringify(h.run);
    h.manager.needsResume = () => true;
    let complete;
    h.manager.resumeConversation = value => { h.calls.push({ action: 'resume', value }); return new Promise(resolve => { complete = resolve; }); };
    let finished = false;
    const opening = h.agent.openBinding(h.run, h.binding).finally(() => { finished = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false); assert.equal(h.calls.length, 1);
    const options = h.calls[0].value;
    assert.equal(options.conversationId, h.binding.threadId); assert.equal(options.model, null); assert.equal(options.reasoningEffort, null);
    assert.deepEqual(options.workspaceRoots, [h.binding.project.root]); assert.equal(options.collaborationMode.mode, 'default');
    if (outcome === 'error') complete(Promise.reject(new Error('Native resume failed'))); else complete({ status: outcome });
    if (outcome === 'ready') assert.equal((await opening).native.threadId, h.binding.threadId);
    else {
      await assert.rejects(opening, outcome === 'error' ? /Native resume failed/ : /Codex 原生会话尚未就绪/);
      assert.equal(h.calls.at(-1).action, 'close');
    }
    assert.equal(h.conversation.historyComplete, false); assert.deepEqual(h.ordinary, ordinary); assert.equal(JSON.stringify(h.run), before);
  }
});

test('the next actual native user turn answers its sole preceding Fusion question without another model request or plan approval', () => {
  const h = fixture(), workId = h.create(); h.plan(workId, true);
  const questionId = h.apply({ action: 'ask_user', workId, question: 'Use the displayed scope?', options: ['Yes', 'No'] }).questionId;
  h.run.attempts.push({ kind: 'main', origin: 'events', acceptedAt: 5, native: { threadId: 'main-thread', turnId: 'native-turn' } });
  h.run.observedMainTurns.push('native-turn', 'native-reply');
  const native = { threadId: 'main-thread', turnId: 'native-reply', messageId: 'user-reply' };
  h.run.attempts.push({ kind: 'main', origin: 'user', acceptedAt: 10, native });
  h.run.events.push({ id: 'native-user-event', type: 'user_input', at: 11,
    data: { text: '可以，但子模型改为Sol', native }, deliveredTo: native.turnId });
  const controller = new FusionController({ run: h.run, agent: { call: () => assert.fail('model or native action') } });
  const count = h.run.events.length; controller.acknowledgeUserAnswers();
  const question = h.run.questions.find(row => row.id === questionId);
  assert.equal(question.answer, '可以，但子模型改为Sol'); assert.equal(question.answeredAt, 11);
  assert.equal(question.inputId, 'native-user-event'); assert.equal(h.run.events.length, count);
  assert.equal(h.run.events.at(-1).data.questionId, questionId); assert.equal(h.run.events.at(-1).data.workId, workId);
  assert.equal(h.run.works[0].plans[0].confirmed, false);
  const revision = h.run.revision; controller.acknowledgeUserAnswers(); assert.equal(h.run.revision, revision);
});
test('multiple pending questions, event-generated turns and other-thread messages do not guess an answer target', () => {
  for (const mode of ['multiple', 'events', 'other-thread', 'not-next']) {
    const h = fixture(), workId = h.create(); h.plan(workId);
    h.apply({ action: 'ask_user', workId, question: 'Question one' });
    if (mode === 'multiple') h.apply({ action: 'ask_user', workId, question: 'Question two' });
    h.run.attempts.push({ kind: 'main', origin: 'events', acceptedAt: 5, native: { threadId: 'main-thread', turnId: 'native-turn' } });
    if (mode === 'not-next') h.run.attempts.push({ kind: 'main', origin: 'events', acceptedAt: 7,
      native: { threadId: 'main-thread', turnId: 'intervening-turn' } });
    h.run.observedMainTurns.push('native-turn', ...(mode === 'not-next' ? ['intervening-turn'] : []), 'reply-turn');
    const native = { threadId: mode === 'other-thread' ? 'ordinary-thread' : 'main-thread', turnId: 'reply-turn', messageId: 'reply' };
    h.run.attempts.push({ kind: 'main', origin: mode === 'events' ? 'events' : 'user', acceptedAt: 10, native });
    h.run.events.push({ id: 'reply-event', type: 'user_input', at: 11, data: { text: 'Yes', native } });
    new FusionController({ run: h.run }).acknowledgeUserAnswers();
    assert(h.run.questions.every(row => !row.answeredAt), mode); assert.equal(h.run.events[0].data.questionId, undefined);
  }
});

test('history reads use the actual project carrier and original child thread while execution keeps its recorded window', async () => {
  const { run } = fixture(), original = { id: 'worker', role: 'worker', app: 'codex', project: run.project,
    windowId: 'closed-window', threadId: 'original-worker', host: '' };
  run.bindings.push(original);
  const agent = new FusionAgent({ publish: () => assert.fail('history must not publish or resume') }), calls = [], carriers = [];
  agent.carrierFor = async (_run, app, project, windowId) => {
    carriers.push({ app, project, windowId });
    if (windowId) throw new Error('绑定的原生窗口已关闭，实际执行结果需要核对');
    return { app, page: { id: 'current-project-window' }, native: {}, leaseId: 'read-only-lease' };
  };
  agent.close = async () => calls.push('close');
  agent.call = async (context, code, native = context.native) => {
    calls.push({ code, threadId: native.threadId, before: native.before });
    if (code.startsWith('nativeSessionInfo(')) return { app: 'codex', threadId: original.threadId, cwd: run.project.root, host: '' };
    assert.equal(code, 'extract(true, [], 80)'); return { thread: native.threadId, items: [{ i: 'worker-result', t: 'Original result' }] };
  };
  const before = JSON.stringify(run), result = await agent.readBinding(run, original.id, true, 'earlier-cursor');
  assert.equal(result.chat.thread, original.threadId); assert.equal(result.binding, original);
  assert.deepEqual(carriers.map(row => row.windowId), ['']);
  assert.equal(calls[1].threadId, original.threadId); assert.equal(calls[1].before, 'earlier-cursor'); assert.equal(calls[2], 'close');
  assert.equal(JSON.stringify(run), before);
  await assert.rejects(agent.openBinding(run, original), /绑定的原生窗口已关闭/);
  assert.equal(carriers[1].windowId, 'closed-window');
});
test('history reads reject a child with a mismatched native project and release its connection', async () => {
  const { run } = fixture(), agent = new FusionAgent({ publish() {} }); let closed = 0;
  agent.carrierFor = async () => ({ app: 'codex', native: {}, leaseId: 'history' });
  agent.call = async () => ({ app: 'codex', threadId: 'main-thread', cwd: run.project.root, host: 'different-host' });
  agent.close = async () => closed++;
  await assert.rejects(agent.readBinding(run, 'main'), /原生会话目录与该任务项目不一致/);
  assert.equal(closed, 1);
});
test('same-software workers use the main window and other-software workers use an existing carrier', async () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  h.apply({ action: 'dispatch', workId, tasks: [h.task('A'), h.task('B', 'cursor')] });
  const agent = new FusionAgent({ publish() {} }), requests = [];
  agent.createBinding = async (_run, owner, app, project, role, spec, preferred) => {
    requests.push({ app, project, role, preferred }); const binding = { id: 'child-' + app, role, app, threadId: app + '-thread', project, windowId: 'shared' };
    h.run.bindings.push(binding); owner.bindingId = binding.id; return binding;
  };
  for (const task of h.run.tasks) await agent.workerBinding(h.run, task, h.run.assignments.find(row => row.taskId === task.id));
  assert.deepEqual(requests.map(row => row.preferred), ['shared', '']);
  assert.equal(requests.every(row => row.role === 'worker'), true);
  const task = h.run.tasks[0], binding = h.run.bindings.find(row => row.id === h.run.agents[0].bindingId);
  assert.equal(await agent.workerBinding(h.run, task, h.run.assignments[0]), binding);
  assert.equal(requests.length, 2);
});
test('a new task selected for a retained worker uses its original native thread even when model settings change', async () => {
  for (const app of ['codex', 'cursor']) {
    const h = fixture(), workId = h.create(); h.plan(workId);
    const first = h.apply({ action: 'dispatch', workId, tasks: [h.task('first', app)] }).tasks[0];
    const worker = h.run.agents[0], binding = { id: 'retained-' + app, app, role: 'worker', threadId: 'original-' + app,
      windowId: 'shared', project: h.project };
    worker.bindingId = binding.id; h.run.bindings.push(binding);
    h.apply({ action: 'dispatch', workId, tasks: [h.task('related', app)], input: JSON.stringify({ related: {
      workerId: first.workerId, label: '证据与性能复核', reason: 'Continue existing responsibility',
      compared: [{ workerId: first.workerId, reason: 'Retain its native project context' }],
    } }) });
    const agent = new FusionAgent({ publish() {} }); agent.createBinding = async () => assert.fail('A reused worker must not create another native session');
    const assignment = { ...h.run.assignments.at(-1), model: 'different-model', effort: 'different-effort' };
    const retained = h.run.bindings.find(row => row.id === binding.id);
    assert.equal(await agent.workerBinding(h.run, h.run.tasks[1], assignment), retained);
    assert.deepEqual(retained, binding);
    assert.equal(h.run.bindings.length, 2); assert.equal(h.run.agents.length, 1); assert.equal(binding.threadId, 'original-' + app);
  }
});
test('native child execution persists its exact full or delta input before sending and recovery only observes it', async () => {
  const h = fixture(), workId = h.create(); h.plan(workId);
  h.apply({ action: 'dispatch', workId, tasks: [h.task('A')] });
  const project = { ...h.project, host: 'qa-host', id: JSON.stringify(['qa-host', h.project.root]) };
  h.run.works[0].project = project;
  const binding = { id: 'owned-child', app: 'codex', role: 'worker', threadId: 'native-child', project, windowId: 'shared' };
  h.run.bindings.push(binding); h.run.agents[0].bindingId = binding.id;
  const agent = new FusionAgent({ publish() {} }), sends = [], context = { native: { threadId: binding.threadId },
    source: { conversationView: () => ({ watching: Promise.resolve() }) } };
  agent.workerBinding = async () => binding; agent.openBinding = async () => context;
  agent.configure = async () => {}; agent.close = async () => {};
  agent.observe = runtime => { runtime.check = () => {}; return Promise.resolve({ completed: true }); };
  agent.call = async (_context, code) => {
    const call = nativeInvocation(code);
    if (call.method === 'codexFusionTurn') return { ids: ['previous'], turnId: 'previous-turn' };
    assert.equal(call.method, 'nativeSessionAction'); assert.equal(call.args[2], 'send');
    const request = call.args[3], attempt = h.run.attempts.find(row => row.id === request.requestId);
    assert.equal(attempt.prompt, request.text); assert.equal(attempt.submission, 'submitting'); assert(attempt.promptContext);
    sends.push({ ...request, mode: attempt.promptContext.mode }); return true;
  };
  const firstId = h.run.attempts[0].id;
  await agent.execute(h.run, firstId, null);
  assert.equal(sends[0].mode, 'full');
  Object.assign(h.run.attempts[0], { status: 'accepted', submission: 'accepted', acceptedAt: 10, endedAt: 20,
    native: { threadId: binding.threadId, turnId: 'first-native-turn' } }); h.run.tasks[0].status = 'accepted';
  h.apply({ action: 'continue_task', taskId: 'A', input: 'Verify the additional value.', cost: h.cost('codex') });
  const nextId = h.run.attempts.at(-1).id;
  await agent.execute(h.run, nextId, null);
  assert.equal(sends.length, 2); assert.equal(sends[1].mode, 'delta'); assert(sends[1].text.length < sends[0].text.length);
  const stored = structuredClone(h.run.attempts.at(-1));
  await agent.execute(h.run, nextId, 'This must neither be regenerated nor sent', true);
  assert.equal(sends.length, 2); assert.equal(h.run.attempts.at(-1).prompt, stored.prompt);
  assert.deepEqual(h.run.attempts.at(-1).promptContext, stored.promptContext); assert.equal(agent.active.size, 0);
});
test('a different-software assignment creates a new binding without overwriting old native facts', async () => {
  const h = fixture(), workId = h.create(); h.plan(workId); h.apply({ action: 'dispatch', workId, tasks: [h.task('A')] });
  const task = h.run.tasks[0], worker = h.run.agents[0], old = { id: 'old', app: 'codex', role: 'worker', threadId: 'native-old', windowId: 'shared' };
  worker.bindingId = old.id; h.run.bindings.push(old);
  const agent = new FusionAgent({ publish() {} }); let created = 0;
  agent.createBinding = async () => { created++; return { id: 'new' }; };
  await agent.workerBinding(h.run, task, { app: 'cursor' });
  assert.equal(created, 1); assert.equal(old.threadId, 'native-old'); assert.equal(h.run.bindings[1], old);
});
test('releasing a worker removes only its cursor data handle and own connection', async () => {
  const calls = [], ordinary = { draft: 'real draft', selection: 'ordinary', model: 'Auto' }, before = structuredClone(ordinary);
  const agent = new FusionAgent({ publish() {} }); agent.call = async (_ctx, code) => calls.push(code);
  const context = { app: 'cursor', pinned: true, leaseId: 'lease', native: { threadId: 'child' }, cdp: { close: () => calls.push('client-close') },
    source: { watching: true, clients: new Set([ordinary]), conversations: new Map(), listeners: new Set(), close: () => assert.fail('shared source closed') } };
  await agent.close(context);
  assert.match(calls[0], /'release'/); assert.equal(calls[1], 'client-close'); assert.deepEqual(ordinary, before);
});
test('finishing one same-window worker retains the other worker and ordinary client with their own subscriptions', async t => {
  const ordinary = new NativeCdp('ws://fusion-concurrency-unit'), one = new NativeCdp(ordinary.wsUrl), two = new NativeCdp(ordinary.wsUrl);
  const source = nativeWindow(ordinary), closed = [];
  t.after(() => { one.close(); two.close(); ordinary.close(); source.close(); });
  const context = threadId => ({ app: 'codex', threadId, host: 'local' });
  const views = ['one', 'two'].map(threadId => {
    const view = source.conversationView(context(threadId));
    view.watching = Promise.resolve(); view.stop = () => closed.push(threadId);
    return view;
  });
  const stopOne = source.subscribe(() => {}, context('one')), stopTwo = source.subscribe(() => {}, context('two'));
  const agent = new FusionAgent({ publish() {} });
  stopOne(); await agent.close({ app: 'codex', cdp: one, source, native: context('one') });
  assert.deepEqual(closed, ['one']); assert.equal(source.clients.has(ordinary), true); assert.equal(source.clients.has(two), true);
  assert.equal(source.clients.has(one), false); assert.equal(views[1].listeners.size, 1);
  assert.equal(source.conversations.has(JSON.stringify(['local', 'two'])), true);
  stopTwo(); await agent.close({ app: 'codex', cdp: two, source, native: context('two') });
  assert.deepEqual(closed, ['one', 'two']); assert.equal(source.clients.has(ordinary), true);
});
test('concurrent Codex calls initialize the same window realm once and retain independent native contexts', async t => {
  const cdp = new NativeCdp('ws://fusion-realm-concurrency-unit'), source = nativeWindow(cdp);
  t.after(() => { cdp.close(); source.close(); });
  source.connect = async () => {};
  source.contexts.set(7, { id: 7, auxData: { isDefault: true, frameId: 'active' } });
  let document = 0;
  source.cdp.send = async (method, params) => {
    if (method === 'DOM.getDocument') return { root: { nodeId: ++document } };
    if (method === 'DOM.querySelector') {
      if (params.nodeId !== document) throw new Error('Could not find node with given id');
      return { nodeId: 100 };
    }
    if (method === 'DOM.describeNode') return { node: { frameId: 'active' } };
    assert.equal(method, 'Runtime.enable'); return {};
  };
  const evaluated = [];
  source.cdp.evaluate = async (code, options) => { evaluated.push({ code, contextId: options.contextId }); return options.contextId; };
  const one = { app: 'codex', host: 'local', threadId: 'one' }, two = { ...one, threadId: 'two' };
  assert.deepEqual(await Promise.all([source.composerCall('activeThread()', one), source.composerCall('activeThread()', two)]), [7, 7]);
  assert.equal(document, 1); assert.equal(evaluated[0].code, helpersCall('activeThread()', one));
  assert.equal(evaluated[1].code, helpersCall('activeThread()', two));
  await source.composerCall('activeThread()', one); assert.equal(document, 1);
});
test('a stale stop cannot interrupt a newer native round', async () => {
  const h = fixture(), attempt = { id: 'attempt', native: { messageId: 'one', turnId: 'old-turn' }, beforeIds: [] }; h.run.attempts.push(attempt);
  const agent = new FusionAgent({ publish() {} }); let calls = 0;
  agent.active.set(attempt.id, { controller: h.run, attemptId: attempt.id, binding: { app: 'codex', threadId: 'worker' }, context: {} });
  agent.call = async () => { calls++; return { current: true, turnId: 'new-turn' }; };
  await assert.rejects(agent.stop(attempt.id), /不能停止其他执行/); assert.equal(calls, 1);
});
test('a retained Worker exposes native interaction only on its active task and marks that task for attention', async t => {
  const { fusionLive } = await import('../server/fusion/state.mjs');
  const { fusionRunView, fusionControllerView } = await import('../server/fusion/owner.mjs');
  const h = fixture(), workId = h.create(); h.plan(workId);
  h.apply({ action: 'dispatch', workId, tasks: [h.task('old')] });
  h.apply({ action: 'dispatch', workId, tasks: [h.task('current')], input: JSON.stringify({
    current: { workerId: h.run.agents[0].id, reason: 'Continue established context' },
  }) });
  const binding = { id: 'retained-' + h.run.id, role: 'worker', app: 'codex', threadId: 'retained-thread', windowId: 'shared', project: h.project };
  h.run.bindings.push(binding); h.run.agents[0].bindingId = binding.id;
  Object.assign(h.run.attempts[0], { bindingId: binding.id, status: 'accepted', endedAt: 20, result: { text: 'Old result', completed: true } });
  h.run.tasks[0].status = 'accepted';
  Object.assign(h.run.attempts[1], { bindingId: binding.id, status: 'running', acceptedAt: 30,
    native: { threadId: binding.threadId, turnId: 'current-turn' } });
  h.run.tasks[1].status = 'awaiting_user';
  const request = { id: 'current-request', text: 'Current approval', fields: [], buttons: [{ label: 'accept' }] };
  fusionLive.set(binding.id, { state: { waiting: 'approval-request' }, chat: { items: [], questions: { codex: true, requests: [request] } } });
  t.after(() => fusionLive.delete(binding.id));
  const old = fusionRunView(h.run, { kind: 'task', taskId: 'old' }), current = fusionRunView(h.run, { kind: 'task', taskId: 'current' });
  assert.equal(old.attempts[0].live, undefined); assert.equal(old.tasks[0].needsUser, false); assert.equal(old.tasks[0].state, 'done');
  assert.deepEqual(current.board.nativeInteractions[0].requests, [request]);
  assert(!old.board.nativeInteractions.some(row => row.taskId === 'old-task'));
  assert.equal(current.tasks[0].needsUser, true); assert.equal(current.tasks[0].state, 'wait');
  assert.deepEqual(fusionControllerView(h.run).overview.attention.map(row => row.taskId), ['current']);
});
test('an ended Attempt cannot act on a retained thread current request and does not open a native connection', async () => {
  const h = fixture(), binding = { id: 'retained', app: 'codex', threadId: 'retained-thread' };
  h.run.bindings.push(binding);
  h.run.attempts.push({ id: 'old', bindingId: binding.id, endedAt: 20 }, { id: 'current', bindingId: binding.id, endedAt: null });
  const agent = new FusionAgent({ publish() {} }), calls = [];
  agent.openBinding = async () => { calls.push('open'); return {}; };
  agent.close = async () => calls.push('close');
  agent.call = async (_context, code) => { calls.push(code); return true; };
  const action = { bindingId: binding.id, kind: 'codexRequest', id: 'current-request', n: 0, fields: [] };
  await assert.rejects(agent.nativeAction(h.run, 'old', action), /该次执行已结束/); assert.deepEqual(calls, []);
  assert.equal(await agent.nativeAction(h.run, 'current', action), true);
  assert.equal(calls[0], 'open'); assert.match(calls[1], /codexRequestAction\("current-request", 0, \[\]\)/); assert.equal(calls[2], 'close');
});
test('default page helper calls preserve their ordinary context while Fusion calls carry an explicit native identity', () => {
  assert.equal(helpersCall('activeThread()'), `${PAGE_SRC}.activeThread()`);
  const scoped = helpersCall('activeThread()', { app: 'codex', threadId: 'worker', host: 'local' });
  assert.match(scoped, /"threadId":"worker"/); assert.notEqual(scoped, helpersCall('activeThread()'));
});
test('single-conversation tool routing leaves every ordinary tool dispatch on the original native handler', async () => {
  const source = fs.readFileSync(new URL('../server/page/session-actions.js', import.meta.url), 'utf8');
  const start = source.indexOf('  const nativeSessionAction ='), end = source.indexOf('  const nativeSessionConfirm', start);
  const ordinary = [], replies = [], main = { requests: [] };
  const manager = { requestClient: { sendRequest() {} }, threadExecution: { executeDynamicToolCall: request => ordinary.push(request) },
    updateConversationState: (_id, edit) => edit(main), getDynamicToolRequest: (_id, id) => main.requests.find(row => row.id === id)?.params,
    replyWithDynamicToolResponse: (_id, id, result) => { replies.push({ id, result }); main.requests.splice(main.requests.findIndex(row => row.id === id), 1); } };
  const original = manager.threadExecution.executeDynamicToolCall;
  const context = vm.createContext({ Map, Set, WeakMap, Error, window: {}, remoteContext: { host: '' }, nativeValue: value => value,
    codexConversationManager: () => manager, codexHistoryScopes: () => [] });
  vm.runInContext(fs.readFileSync(new URL('../server/page/fusion-tools.js', import.meta.url), 'utf8') + source.slice(start, end) + '\nthis.action = nativeSessionAction;', context);
  await context.action('codex', 'main', 'bindTools', { names: ['ra_fusion'], authorization: fusionAutonomyContext({ id: 'workbench' }) });
  manager.threadExecution.executeDynamicToolCall({ id: 0, method: 'item/tool/call', params: { threadId: 'main', turnId: 't', tool: 'ra_fusion' } });
  manager.threadExecution.executeDynamicToolCall({ id: 1, params: { threadId: 'ordinary', tool: 'ra_fusion' } });
  manager.threadExecution.executeDynamicToolCall({ id: 2, params: { threadId: 'main', tool: 'ordinary-tool' } });
  assert.equal(main.requests.length, 1); assert.equal(main.requests[0].id, 0); assert.equal(ordinary.length, 2);
  await context.action('codex', 'main', 'toolReply', { requestId: 0, result: { success: true } }); assert.equal(replies[0].id, 0);
  await context.action('codex', 'main', 'unbindTools'); assert.equal(manager.threadExecution.executeDynamicToolCall, original);
});
test('native request context authorizes only registered Fusion mains and preserves ordinary calls, payloads and shared-client cleanup', async () => {
  const source = fs.readFileSync(new URL('../server/page/session-actions.js', import.meta.url), 'utf8');
  const start = source.indexOf('  const nativeSessionAction ='), end = source.indexOf('  const nativeSessionConfirm', start);
  const calls = [], response = Promise.resolve({ accepted: true });
  const client = { sendRequest(method, params, ...options) { assert.equal(this, client); calls.push({ method, params, options }); return response; } };
  const original = client.sendRequest, manager = () => ({ requestClient: client, threadExecution: { executeDynamicToolCall() {} } });
  const one = manager(), two = manager();
  const context = vm.createContext({ Map, Set, WeakMap, window: {}, remoteContext: { host: '' },
    codexConversationManager: id => id === 'main-one' ? one : two, codexHistoryScopes: () => [] });
  vm.runInContext(fs.readFileSync(new URL('../server/page/fusion-tools.js', import.meta.url), 'utf8') + source.slice(start, end) + '\nthis.action = nativeSessionAction;', context);
  const authOne = fusionAutonomyContext({ id: 'workbench-one' }), authTwo = fusionAutonomyContext({ id: 'workbench-two' });
  await context.action('codex', 'main-one', 'bindTools', { names: ['ra_fusion'], authorization: authOne });
  const wrapped = client.sendRequest;
  await context.action('codex', 'main-two', 'bindTools', { names: ['ra_fusion'], authorization: authTwo });
  assert.equal(client.sendRequest, wrapped);
  const input = [{ type: 'text', text: '只给需求 @file.js', text_elements: [{ range: { start: 5, end: 13 }, placeholder: '@file.js' }] },
    { type: 'localImage', path: '/project/screenshot.png' }];
  for (const method of ['turn/start', 'turn/steer']) {
    const params = { threadId: 'main-one', input, clientUserMessageId: 'native-message', expectedTurnId: 'native-turn',
      model: 'user-model', effort: 'high', additionalContext: { original: { kind: 'application', value: 'native context' } } };
    const before = structuredClone(params), options = { timeoutMs: 1234 };
    assert.equal(client.sendRequest(method, params, options), response);
    const sent = calls.at(-1);
    assert.equal(sent.params.input, input); assert.equal(sent.options[0], options); assert.deepEqual(params, before);
    assert.deepEqual(JSON.parse(JSON.stringify(sent.params)), { ...before, additionalContext: { ...before.additionalContext, ra_fusion_user_authorization: authOne } });
  }
  for (const [method, threadId] of [['turn/start', 'ordinary'], ['turn/steer', 'child'], ['thread/resume', 'main-one']]) {
    const params = { threadId, input }; assert.equal(client.sendRequest(method, params), response); assert.equal(calls.at(-1).params, params);
  }
  await context.action('codex', 'main-one', 'unbindTools');
  const detached = { threadId: 'main-one', input }; client.sendRequest('turn/start', detached); assert.equal(calls.at(-1).params, detached);
  client.sendRequest('turn/start', { threadId: 'main-two', input });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).params.additionalContext.ra_fusion_user_authorization)), authTwo);
  await context.action('codex', 'main-two', 'unbindTools'); assert.equal(client.sendRequest, original);
});
test('connecting a persistent controller registers its own workbench authorization without submitting a turn', async () => {
  const { run } = fixture(), calls = [], context = { native: { threadId: 'main-thread' }, cdp: {},
    source: { subscribe: () => () => calls.push({ action: 'unsubscribe' }) } };
  const agent = { openBinding: async (_run, binding) => { assert.equal(binding.id, run.main.bindingId); return context; },
    async call(_context, code) { return new Function('nativeSessionAction', 'return ' + code)((app, thread, action, value) => calls.push({ app, thread, action, value })); },
    close: async value => assert.equal(value, context) };
  const controller = new FusionController({ run, agent }); controller.check = async () => {};
  await controller.start(); await controller.start();
  assert.equal(calls.length, 1); assert.equal(calls[0].action, 'bindTools'); assert.equal(calls[0].thread, 'main-thread');
  assert.deepEqual(calls[0].value, { names: FUSION_TOOLS.map(tool => tool.name), tools: FUSION_TOOLS, authorization: fusionAutonomyContext(run), instructions: fusionControllerPrompt(run) });
  assert.equal(calls[0].value.authorization.kind, 'application'); assert(calls[0].value.authorization.value.includes(run.id));
  assert(Buffer.byteLength(JSON.stringify(calls[0].value.authorization)) < 700);
  await controller.close(); assert.deepEqual(calls.slice(1).map(call => call.action), ['unsubscribe', 'unbindTools']);
});
test('an unmounted Codex worker reads its native history rather than a different mounted conversation', async () => {
  const source = fs.readFileSync(new URL('../server/page/chat-extract.js', import.meta.url), 'utf8');
  const start = source.indexOf('  const codexFusionTurn ='), end = source.indexOf('  // One Codex turn', start);
  const conversation = { id: 'worker' }, turn = { status: 'complete', partial: false, items: [
    { type: 'user-message', clientUserMessageId: 'user', message: 'attempt-1' },
    { type: 'assistant-message', completed: true, content: 'worker-result' } ] };
  const context = vm.createContext({ Map, Set, remoteContext: { app: 'codex', threadId: 'worker' },
    codexThread: () => 'worker', codexVisibleThread: () => 'ordinary', codexNativeManager: () => ({ getConversation: id => { assert.equal(id, 'worker'); return conversation; } }),
    codexHistoryState: native => { assert.equal(native, conversation); return { thread: 'worker', scopes: [], entries: [{ turnId: 'native-turn' }] }; },
    doc: { querySelectorAll: () => assert.fail('ordinary DOM read') }, codexStoredTurn: () => turn, codexTurnItems: () => [],
    codexSendState: () => ({ runs: [{ id: 'native-turn' }] }) });
  vm.runInContext(source.slice(start, end) + '\nthis.read = codexFusionTurn;', context);
  const result = await context.read('', 'attempt-1', []);
  assert.equal(result.threadId, 'worker'); assert.equal(result.id, 'user'); assert.equal(result.turnId, 'native-turn');
  assert.equal(result.accepted, true); assert.equal(result.ended, true); assert.equal(result.completed, true); assert.equal(result.text, 'worker-result');
  const unknown = await context.read('not-in-loaded-history');
  assert.equal(unknown.id, ''); assert.equal(unknown.turnId, ''); assert.equal(unknown.ended, false); assert.equal(unknown.completed, false);
});
test('Fusion native end status is independent of partial history and interrupted execution is never completed', async () => {
  const source = fs.readFileSync(new URL('../server/page/chat-extract.js', import.meta.url), 'utf8');
  const start = source.indexOf('  const codexFusionTurn ='), end = source.indexOf('  // One Codex turn', start);
  for (const status of ['complete', 'completed', 'interrupted', 'failed', 'inProgress']) {
    const turn = { status, partial: true, items: [{ type: 'user-message', clientUserMessageId: 'user', message: 'attempt' },
      { type: 'assistant-message', completed: true, content: 'Actual final text' }] };
    const context = vm.createContext({ Map, Set, remoteContext: { app: 'codex', threadId: 'worker' }, codexThread: () => 'worker',
      codexVisibleThread: () => 'ordinary', codexNativeManager: () => ({ getConversation: () => ({}) }),
      codexHistoryState: () => ({ thread: 'worker', scopes: [], entries: [{ turnId: 'native-turn', nativeTurn: { status,
        ...(status === 'failed' ? { error: { message: 'Original native failure' } } : {}) } }] }),
      doc: { querySelectorAll: () => assert.fail('ordinary conversation read') }, codexStoredTurn: () => turn,
      codexTurnItems: () => [], codexSendState: () => ({ runs: [{ id: 'native-turn' }] }) });
    vm.runInContext(source.slice(start, end) + '\nthis.read = codexFusionTurn;', context);
    const result = await context.read();
    assert.equal(result.ended, status !== 'inProgress', status);
    assert.equal(result.completed, ['complete', 'completed'].includes(status), status);
    if (status === 'interrupted') assert.match(result.error, /中断/);
    if (status === 'failed') assert.equal(result.error, 'Original native failure');
  }
});
test('a failed Devin native request ends its own Fusion round after transient messages are removed', async () => {
  const source = fs.readFileSync(new URL('../server/page/chat-extract.js', import.meta.url), 'utf8');
  const start = source.indexOf('  const codexFusionTurn ='), end = source.indexOf('  // One Codex turn', start);
  const error = 'Permission denied: internal server error: error number 13';
  const current = { method: 'session/prompt', params: { sessionId: 'worker', prompt: [{ text: 'attempt-1' }],
    _meta: { 'cognition.ai/clientMessageId': 'attempt-1' } }, status: 'failed', errorMessage: error };
  const state = { perSession: {}, agentRequests: { byId: { current, foreign: { ...current, params: { sessionId: 'other' }, errorMessage: 'foreign failure' } } } };
  const context = vm.createContext({ remoteContext: { app: 'devin', threadId: 'worker' },
    window: { __acpStore: { getState: () => ({ acp: state }), subscribe: () => () => {} } },
    devinSurface: () => true, devinSessionRecord: () => ({ status: 'idle' }), devinLog: () => assert.fail('ordinary DOM read'), devinItems: () => assert.fail('ordinary DOM read') });
  const tools = fs.readFileSync(new URL('../server/page/fusion-tools.js', import.meta.url), 'utf8');
  vm.runInContext(tools.slice(tools.indexOf('  const fusionNativeControllers ='), tools.indexOf('  const fusionNativeTools =')), context);
  vm.runInContext(source.slice(start, end) + '\nthis.read = codexFusionTurn;', context);
  const result = await context.read('known-user', 'attempt-1', [], 'current');
  assert.equal(result.threadId, 'worker'); assert.equal(result.ended, true); assert.equal(result.completed, false); assert.equal(result.error, error);
  const foreign = await context.read('known-user', 'attempt-1', [], 'foreign');
  assert.equal(foreign.ended, false); assert.equal(foreign.error, '');
  state.agentRequests.byId.current = { ...current, status: 'pending', errorMessage: undefined };
  const pending = await context.read('known-user', 'attempt-1', [], 'current'); assert.equal(pending.ended, false);
});
function devinItemsFixture(rows) {
  for (const row of rows) {
    const msg = { item: { k: 'human', i: '', t: '', sentAt: 0, b: ['body'], actions: ['copy'], ...(row.itemExtra || {}) },
      meta: row.meta, time: row.time ?? 1794284911053 };
    row.el = { key: row.key, native: row.native, innerText: 'x',
      hasAttribute: name => name === 'data-transcript-row-key' && row.native != null,
      querySelector: selector => selector.includes('aria-label') ? msg : null,
      classList: { contains: () => false }, msg };
  }
  const context = vm.createContext({
    devinTranscriptRows: () => rows.map(row => row.el), vis: () => true,
    itemKey: row => row.key, codexFiberProps: row => [{ row: { item: row.native } }],
    messageItem: msg => msg.item, devinNativeItems: () => null,
    devinMessageMeta: msg => msg.meta || {}, devinMessageTime: msg => msg.time,
    devinTasks: () => assert.fail('devinTasks must not run'), devinCommand: () => assert.fail('devinCommand must not run'),
    devinEdit: () => assert.fail('devinEdit must not run'), devinEventTool: () => assert.fail('devinEventTool must not run'),
    devinTranscriptIndex: () => 0, devinNodeSessionId: () => 'thread-1', devinSessionRecord: () => ({ status: 'active' }),
    doc: { querySelectorAll: () => [] } });
  const source = fs.readFileSync(new URL('../server/page/chat-extract.js', import.meta.url), 'utf8');
  const start = source.indexOf('  const devinItems ='), end = source.indexOf('  // Cursor keeps message times', start);
  vm.runInContext(source.slice(start, end) + ';this.devinItems=devinItems;', context);
  return context.devinItems;
}
test('Devin transcript shows an answered native question as its own human message', () => {
  const native = { id: 'tool:call_FsFl9WTY12Ii0wx2SZXmYIRu', timestamp: '2026-11-10T04:28:31.053554927+00:00',
    event_type: 'user_message', message: '', kind: 'question_answers',
    answers: [{ question: '代码和离线检查已完成。是否现在继续 Devin / swe-2-medium 的真实主子闭环？继续时只用 npm start 重启中继，隧道不动，不发布、不提交、不推送，工作台保留。',
      options: ['暂不继续实测', '保持累计六条上限', '累计上限提高到八条'], selected_options: ['累计上限提高到八条'] }] };
  const devinItems = devinItemsFixture([{ key: 'tool:call_FsFl9WTY12Ii0wx2SZXmYIRu', native }]);
  const items = devinItems({});
  assert.equal(items.length, 1);
  const it = items[0];
  assert.equal(it.k, 'human'); assert.equal(it.i, 'tool:call_FsFl9WTY12Ii0wx2SZXmYIRu');
  assert.equal(it.t, '问题：代码和离线检查已完成。是否现在继续 Devin / swe-2-medium 的真实主子闭环？继续时只用 npm start 重启中继，隧道不动，不发布、不提交、不推送，工作台保留。\n回复：累计上限提高到八条');
  assert.equal(it.src, 'devin'); assert.equal(it.sentAt, 1794284911053);
  assert.deepEqual(it.actions, ['copy']); assert.deepEqual(it.b, ['body']);
  const again = devinItems({});
  assert.equal(again.length, 1); assert.equal(again[0].i, it.i); assert.equal(again[0].t, it.t);
});
test('Devin transcript joins all answered questions and chosen options in one bubble', () => {
  const native = { event_type: 'user_message', message: '', kind: 'question_answers',
    answers: [
      { question: '继续路径 _shots/fusion-devin-20261109/very-long-name？', options: ['暂不', '继续'], selected_options: ['暂不', '继续'] },
      { question: '特殊字符 <tag> & "quotes" 怎么处理？', options: ['跳过', '保留'], selected_options: ['保留'] }] };
  const devinItems = devinItemsFixture([{ key: 'tool:call_multi', native }]);
  const items = devinItems({});
  assert.equal(items.length, 1);
  assert.equal(items[0].t, '问题：继续路径 _shots/fusion-devin-20261109/very-long-name？\n回复：暂不、继续\n\n问题：特殊字符 <tag> & "quotes" 怎么处理？\n回复：保留');
});
test('Devin transcript keeps ordinary user text and image-only messages intact', () => {
  const devinItems = devinItemsFixture([
    { key: 'user:1', native: { event_type: 'user_message', message: '普通用户消息' } },
    { key: 'user:2', native: { event_type: 'user_message', message: '', images: [{ url: 'data:image/png;base64,iVBORw0KGgo=', width: 1, height: 1 }] },
      itemExtra: { images: ['data:image/png;base64,iVBORw0KGgo='] } }]);
  const items = devinItems({});
  assert.equal(items.length, 2);
  assert.equal(items[0].t, '普通用户消息');
  assert.equal(items[1].i, 'user:2'); assert.equal(items[1].t, ''); assert.deepEqual(items[1].images, ['data:image/png;base64,iVBORw0KGgo=']);
});
test('Devin transcript still skips an optimistic answered question row', () => {
  const native = { event_type: 'user_message', message: '', kind: 'question_answers',
    answers: [{ question: '授权？', options: ['允许'], selected_options: ['允许'] }] };
  const devinItems = devinItemsFixture([{ key: 'tool:call_opt', native, meta: { 'cognition.ai/isOptimistic': true } }]);
  assert.equal(devinItems({}).length, 0);
});
function devinWorkerFixture(thread = 'worker-thread') {
  const session = { sessionId: thread, providerId: 'devin-cli', cwd: '/project', status: 'idle', title: 'Worker' };
  const state = { sessions: [session], perSession: {}, agentRequests: { byId: {} } }, listeners = new Set(), dispatched = [];
  const update = () => { for (const listener of [...listeners]) listener(); };
  const window = { __acpStore: { getState: () => ({ acp: state }),
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    dispatch: async request => { dispatched.push({ request, listeners: listeners.size }); return request; } } };
  const nativeModule = { getAllMessages: data => data.messages, tryGetAcpSingleton: () => 'sender',
    sendAgentRequestThunk: (provider, request, sender) => ({ provider, request, sender }) };
  const context = vm.createContext({ window, Map, Set, WeakMap, Error, JSON, Promise, Date, Number, Array, Object, String, RegExp, crypto: { randomUUID: () => 'uuid' },
    remoteContext: { app: 'devin', threadId: thread, cwd: '/project', host: '' },
    nativeModule, devinSessionRecord: id => id === thread ? session : null,
    nativeMarkdownItem: (i, k, t, at, images) => ({ i, k, t, at, ...(images?.length ? { images } : {}) }),
    activeThread: () => 'other-thread', devinQuestions: () => null, agentRun: () => null, nativeWaiting: () => ({}),
    agentModelName: () => 'SWE-2 Medium', effortName: () => '', devinSurface: () => false });
  const slice = (file, start, end) => { const source = fs.readFileSync(new URL(`../server/page/${file}`, import.meta.url), 'utf8')
      .replaceAll("await import('@exa/chat-client')", 'nativeModule'), s = source.indexOf(start);
    assert(s >= 0, start); const e = source.indexOf(end, s); assert(e > s, end); return source.slice(s, e); };
  vm.runInContext(slice('fusion-tools.js', '  const fusionNativeControllers =', '  const fusionNativeTools =')
    + ';this.turn=fusionDevinTurn;this.call=fusionDevinCall;', context);
  vm.runInContext(slice('session-actions.js', '  const nativeSessionAction = async', '  const nativeSessionRenameInput =')
    + ';this.action=nativeSessionAction;', context);
  vm.runInContext(slice('chat-extract.js', '  const codexFusionTurn =', '  // One Codex turn')
    + ';this.read=codexFusionTurn;', context);
  vm.runInContext(slice('chat-extract.js', '  const nativeConversationChat =', '  const contextPct =')
    + ';this.chat=nativeConversationChat;', context);
  vm.runInContext(slice('chat-extract.js', '  const watchCodexData =', '  const codexUserText =')
    + ';this.watch=watchCodexData;', context);
  const watching = context.watch(() => {});
  return { session, state, update, context, listeners, dispatched, thread, stop: watching.stop,
    prompt: (generationId, clientId, status = 'started') => { state.agentRequests.byId[generationId] = { method: 'session/prompt', status,
      params: { sessionId: thread, prompt: [{ type: 'text', text: 'task' }], _meta: { 'cognition.ai/clientMessageId': clientId } } }; },
    user: (id, clientId, text, optimistic = false) => (state.perSession[thread] ||= { messages: [] }).messages.push({ id, kind: 'user_message',
      content: [{ content: { type: 'text', text }, _meta: { 'cognition.ai/clientMessageId': clientId, ...(optimistic ? { 'cognition.ai/isOptimistic': true } : {}) } }] }),
    agent: (id, text) => (state.perSession[thread] ||= { messages: [] }).messages.push({ id, kind: 'agent_message',
      content: [{ content: { type: 'text', text } }] }) };
}
test('a Devin worker result survives transcript pruning through the shared turn cache', async t => {
  const h = devinWorkerFixture();
  t.after(h.stop);
  const attemptId = 'bea1dba8-8beb-4dbf-882b-bc40614b6c96';
  await h.context.action('devin', 'worker-thread', 'send', { text: 'task', requestId: attemptId });
  assert.equal(h.dispatched.length, 1); assert.equal(h.dispatched[0].request.request.method, 'session/prompt');
  h.prompt('gen-1', attemptId); h.user('u1', attemptId, 'task'); h.agent('r1', 'partial');
  h.state.perSession['worker-thread'].messages.splice(1, 0,
    { id: 't1', kind: 'tool_call', content: { toolCallId: 'exec:1', status: 'completed', title: 'wc',
      rawInput: { command: 'wc -l x' }, content: [{ type: 'content', content: { type: 'text', text: '12 x' } }] } },
    { id: 'img1', kind: 'agent_message', content: [{ content: { type: 'image', mimeType: 'image/png', data: 'AA==' } }] });
  h.update();
  h.state.perSession['worker-thread'].messages[3].content[0].content.text = 'final result';
  h.update();
  h.state.agentRequests.byId['gen-1'].status = 'completed'; delete h.state.perSession['worker-thread']; h.update();
  const chat = await h.context.chat(false, 80);
  assert.equal(chat.items.filter(i => i.k === 'human').length, 1);
  assert.equal(chat.items.find(i => i.t === 'final result').k, 'assistant');
  assert.equal(chat.items.find(i => i.k === 'tool').output, '12 x');
  assert.deepEqual(chat.items.find(i => i.images)?.images, ['data:image/png;base64,AA==']);
  const turn = await h.context.read('', attemptId, [], 'gen-1');
  assert.equal(turn.id, 'u1'); assert.equal(turn.accepted, true); assert.equal(turn.generationId, 'gen-1');
  assert.equal(turn.ended, true); assert.equal(turn.completed, true); assert.equal(turn.text, 'final result');
  const again = await h.context.read('', attemptId, [], 'gen-1');
  assert.equal(again.text, 'final result'); assert.equal(again.id, 'u1');
  assert.equal(h.dispatched[0].listeners, 1);
  assert.throws(() => h.context.call('worker-thread', { tool: 'x', arguments: {} }), /没有绑定主控工具/);
});
test('Devin worker lookups never reuse another turn identity across sends', async t => {
  const h = devinWorkerFixture();
  t.after(h.stop);
  h.prompt('gen-1', 'attempt-1'); h.user('u1', 'attempt-1', 'first'); h.agent('r1', 'first result');
  h.state.agentRequests.byId['gen-1'].status = 'completed'; h.update();
  h.prompt('gen-2', 'attempt-2'); h.update();
  const stale = await h.context.read('', 'attempt-2', [], 'gen-1');
  assert.equal(stale.accepted, false); assert.equal(stale.id, ''); assert.equal(stale.ended, false); assert.equal(stale.text, '');
  const fresh = await h.context.read('', 'attempt-2', [], '');
  assert.equal(fresh.id, ''); assert.equal(fresh.accepted, false); assert.equal(fresh.generationId, 'gen-2');
  h.user('u2', 'attempt-2', 'second'); h.agent('r2', 'second result');
  h.state.agentRequests.byId['gen-2'].status = 'completed'; h.update();
  const done = await h.context.read('', 'attempt-2', [], 'gen-2');
  assert.equal(done.id, 'u2'); assert.equal(done.text, 'second result'); assert.equal(done.completed, true);
  const old = await h.context.read('', 'attempt-1', [], 'gen-1');
  assert.equal(old.id, 'u1'); assert.equal(old.text, 'first result');
  const wrongUser = await h.context.read('u1', 'attempt-2', [], '');
  assert.equal(wrongUser.accepted, false); assert.equal(wrongUser.id, ''); assert.equal(wrongUser.text, '');
  const wrongId = await h.context.read('unknown-id', 'attempt-2', [], '');
  assert.equal(wrongId.accepted, false); assert.equal(wrongId.id, ''); assert.equal(wrongId.text, '');
  h.state.agentRequests.byId['foreign-gen'] = { method: 'session/prompt', status: 'started',
    params: { sessionId: 'other-thread', _meta: { 'cognition.ai/clientMessageId': 'foreign-attempt' } } };
  h.update();
  const owned = h.context.window.__remoteAgentDevinTurns;
  assert.equal(owned.get('other-thread'), undefined);
  assert([...owned.get('worker-thread').turns.keys()].every(key => key !== 'foreign-gen'));
});
test('a Devin worker turn stays incomplete without a real reply and keeps its own failure', async t => {
  const h = devinWorkerFixture();
  t.after(h.stop);
  h.prompt('gen-3', 'attempt-3'); h.user('u3', 'attempt-3', 'ghost', true); h.update();
  const ghost = await h.context.read('', 'attempt-3', [], 'gen-3');
  assert.equal(ghost.accepted, false); assert.equal(ghost.id, '');
  h.prompt('gen-4', 'attempt-4'); h.user('u4', 'attempt-4', 'real');
  h.state.agentRequests.byId['gen-4'].status = 'completed'; h.update();
  const empty = await h.context.read('', 'attempt-4', [], 'gen-4');
  assert.equal(empty.accepted, true); assert.equal(empty.ended, true); assert.equal(empty.completed, false); assert.equal(empty.text, '');
  h.prompt('gen-5', 'attempt-5');
  h.state.agentRequests.byId['gen-5'] = { ...h.state.agentRequests.byId['gen-5'], status: 'failed', errorMessage: 'native failure 13' };
  h.state.agentRequests.byId.foreign = { method: 'session/prompt', status: 'failed', errorMessage: 'foreign', params: { sessionId: 'other' } };
  delete h.state.perSession['worker-thread']; h.update();
  const failed = await h.context.read('', 'attempt-5', [], 'gen-5');
  assert.equal(failed.ended, true); assert.equal(failed.completed, false); assert.equal(failed.error, 'native failure 13');
});
test('an explicit Devin binding cleanup releases its turn cache at every confirmed end state', async () => {
  const remoteContext = { app: 'devin', threadId: 'worker-thread' };
  const session = { sessionId: 'worker-thread', providerId: 'devin-cli', cwd: '/project', status: 'idle', title: 'Worker' };
  const catalogRows = { before: [], after: [] };
  const nativeModule = { tryGetAcpSingleton: name => name === 'connectorService'
    ? { getConnectorById: () => ({ capabilities: { sessionCapabilities: { delete: true } } }) } : 'sender',
    sendAgentRequestThunk: (provider, request, sender) => ({ provider, request, sender }) };
  const window = { __acpStore: { dispatch: async () => { catalogRows.before = catalogRows.after; return true; } },
    __remoteAgentDevinTurns: new Map() };
  const context = vm.createContext({ window, remoteContext, nativeModule, JSON, Error, devinSessionRecord: () => session,
    nativeSessionCatalog: async () => ({ ready: true, rows: catalogRows.before, complete: true }),
    nativeSessionContext: async () => ({ threadId: 'worker-thread' }), codexConversationManager: () => assert.fail('codex path'),
    cursorSessionServices: () => assert.fail('cursor path') });
  const source = fs.readFileSync(new URL('../server/page/session-actions.js', import.meta.url), 'utf8'),
    start = source.indexOf('  const nativeSessionCleanup ='), end = source.indexOf('  const nativeSessionInfo =', start);
  vm.runInContext(source.slice(start, end).replaceAll("await import('@exa/chat-client')", 'nativeModule') + ';this.cleanup=nativeSessionCleanup;', context);
  const seed = () => { const state = { turns: new Map(), data: null, stops: 0, stop: () => { state.stops += 1; } };
    window.__remoteAgentDevinTurns.set('worker-thread', state); return state; };
  catalogRows.before = [{ id: 'worker-thread' }]; catalogRows.after = [];
  let state = seed();
  assert.equal((await context.cleanup('devin', 'worker-thread', true)).confirmed, true);
  assert.equal(window.__remoteAgentDevinTurns.get('worker-thread'), undefined); assert.equal(state.stops, 1);
  catalogRows.before = []; state = seed();
  assert.equal((await context.cleanup('devin', 'worker-thread', true)).already, true);
  assert.equal(window.__remoteAgentDevinTurns.get('worker-thread'), undefined); assert.equal(state.stops, 1);
  catalogRows.before = [{ id: 'worker-thread', archived: true }]; state = seed();
  assert.equal((await context.cleanup('devin', 'worker-thread', true)).already, true);
  assert.equal(window.__remoteAgentDevinTurns.get('worker-thread'), undefined); assert.equal(state.stops, 1);
  remoteContext.threadId = 'foreign-thread'; catalogRows.before = [{ id: 'worker-thread' }]; state = seed();
  await assert.rejects(() => context.cleanup('devin', 'worker-thread', true), /不属于这个原生 Binding/);
  assert.equal(window.__remoteAgentDevinTurns.get('worker-thread'), state); assert.equal(state.stops, 0);
});
test('Fusion Devin content reports a native failure without requiring a pruned transcript or showing another request error', async () => {
  const source = fs.readFileSync(new URL('../server/page/chat-extract.js', import.meta.url), 'utf8');
  const start = source.indexOf('  const nativeConversationChat ='), end = source.indexOf('  const contextPct =', start);
  const error = 'Permission denied: internal server error: error number 13';
  const state = { perSession: {}, agentRequests: { byId: { current: { method: 'session/prompt', params: { sessionId: 'worker' }, status: 'failed', errorMessage: error } } } };
  let messageReads = 0;
  const context = vm.createContext({ remoteContext: { app: 'devin', threadId: 'worker', cwd: '/project', host: '' },
    window: { __acpStore: { getState: () => ({ acp: state }), subscribe: () => () => {} } },
    nativeModule: { getAllMessages: data => { messageReads++; assert(data, 'failed native transcript has been pruned'); return data.messages; } },
    devinSessionRecord: () => ({ status: 'idle', title: 'Worker' }), activeThread: () => 'ordinary', devinQuestions: () => assert.fail('ordinary questions read'),
    agentRun: () => ({ id: 'current', status: state.agentRequests.byId.current.status === 'failed' ? 'error' : 'completed' }), nativeWaiting: () => ({}),
    agentModelName: () => 'SWE-2 High', effortName: () => '', devinSurface: () => 'editor',
    nativeMarkdownItem: (i, k, t, at) => ({ i, k, t, at }) });
  const tools = fs.readFileSync(new URL('../server/page/fusion-tools.js', import.meta.url), 'utf8');
  vm.runInContext(tools.slice(tools.indexOf('  const fusionNativeControllers ='), tools.indexOf('  const fusionNativeTools =')), context);
  vm.runInContext(source.slice(start, end).replace("await import('@exa/chat-client')", 'nativeModule') + '\nthis.read = nativeConversationChat;', context);
  const failed = await context.read(false, 80);
  assert.equal(failed.thread, 'worker'); assert.equal(failed._nativeState.run.status, 'error');
  assert.equal(failed.items.length, 1); assert.equal(failed.items[0].kind, 'error'); assert.equal(failed.items[0].t, error); assert.equal(messageReads, 0);
  state.perSession.worker = { messages: [{ id: 'reply', kind: 'agent_message', content: [{ content: { type: 'text', text: 'worker-ok' } }] }] };
  state.agentRequests.byId.current = { ...state.agentRequests.byId.current, status: 'completed', errorMessage: undefined };
  state.agentRequests.byId.foreign = { method: 'session/prompt', params: { sessionId: 'other' }, status: 'failed', errorMessage: 'foreign failure' };
  const completed = await context.read(false, 80);
  assert.equal(completed.items.length, 1); assert.equal(completed.items[0].t, 'worker-ok'); assert.equal(messageReads, 1);
});
test('a background Codex free-text question can send its answer to the exact native request', async () => {
  const source = fs.readFileSync(new URL('../server/page/codex.js', import.meta.url), 'utf8');
  const start = source.indexOf('  const codexNativeRequests ='), end = source.indexOf('  const codexConversationChat =', start);
  const replies = [], manager = {
    getConversation: () => ({ requests: [{ id: 0, method: 'item/tool/requestUserInput',
      params: { threadId: 'worker', turnId: 'turn', questions: [{ id: 'q', question: '请补充说明', options: [] }] } }] }),
    replyWithUserInputResponse: async (...args) => replies.push(args),
  };
  const context = vm.createContext({ remoteContext: { threadId: 'worker' }, codexNativeManager: () => manager, nativeValue: value => value });
  vm.runInContext(source.slice(start, end) + '\nthis.rows = codexNativeRequestRows; this.answer = codexNativeRequestAction;', context);
  const row = context.rows()[0];
  assert.equal(row.buttons[1].label, 'Send'); assert.notEqual(row.buttons[1].disabled, true);
  await context.answer(row.id, 1, [{ n: 0, value: '仅处理这个子任务' }]);
  assert.equal(replies[0][0], 'worker'); assert.equal(replies[0][1], 0);
  assert.equal(replies[0][2].answers.q.answers[0], '仅处理这个子任务');
});
test('attempt evidence keeps the scoped preexisting file hash without attaching unrelated repository diffs', async () => {
  const { fusionWorkspaceSnapshot } = await import('../server/fusion/agent.mjs');
  const { fileURLToPath } = await import('node:url');
  const relative = '_shots/fusion-superagent-unit/baseline-input.txt';
  const root = fileURLToPath(new URL('../', import.meta.url));
  fs.writeFileSync(new URL('../' + relative, import.meta.url), 'preexisting');
  const before = await fusionWorkspaceSnapshot({ root, host: '' }, [relative]);
  fs.writeFileSync(new URL('../' + relative, import.meta.url), 'this attempt');
  const after = await fusionWorkspaceSnapshot({ root, host: '' }, [relative]);
  assert.equal(before.available, true); assert.equal(after.available, true);
  assert.equal(before.diff, ''); assert.equal(after.diff, '');
  assert.notEqual(before.files[0].sha256, after.files[0].sha256);
  assert.equal(before.files[0].path, relative);
});

test('Fusion management notifications share the native watch but do not wait for or change ordinary snapshot subscribers', async () => {
  const source=fs.readFileSync(new URL('../server/native-windows.mjs',import.meta.url),'utf8');
  const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
  const watches=[],trace=[];let release,closed=0,stopped=0;
  const body=new Promise(resolve=>release=resolve);
  const context=vm.createContext({Map,Set,JSON,Date,Promise,
    NativeCdp:class {close(){closed++;}},cdpRead:{run:(_owner,fn)=>Promise.resolve().then(fn)},awaitCdpRead:p=>p,
    watchChat:async(_cdp,changed,_shared,native)=>{watches.push({changed,native});return ()=>{stopped++;};},
    withOperation:(_owner,fn)=>fn(),helpersCall:s=>s});
  const Window=vm.runInContext('(class {'+section('  subscribe(changed','  async preview(')
    +section('  conversationView(context)','  async read(fresh')+'})',context);
  const window=Object.assign(new Window(),{conversations:new Map(),cdp:{wsUrl:'owned-test',evaluate:async()=>{trace.push('body');return body;}},
    connect:async()=>{},readReceipts:async()=>trace.push('receipts'),composerCall:async()=>null});
  const native={app:'codex',threadId:'main',host:''};
  const stopManagement=window.subscribe(()=>trace.push('management'),native,'fusion-control');
  await window.conversationView(native).watching;watches[0].changed();await new Promise(r=>setImmediate(r));
  assert.deepEqual(trace,['management']);assert.equal(watches.length,1);
  const stopOrdinary=window.subscribe(()=>trace.push('ordinary'),native);
  watches[0].changed();await new Promise(r=>setImmediate(r));
  assert.deepEqual(trace,['management','management','receipts','body']);
  stopManagement();release({items:[],_nativeState:{run:{status:'idle'}}});
  await window.conversationView(native).reading;assert.equal(trace.at(-1),'ordinary');
  assert.equal(window.conversations.size,1);assert.equal(closed,0);
  stopOrdinary();await new Promise(r=>setImmediate(r));assert.equal(stopped,1);assert.equal(closed,1);assert.equal(window.conversations.size,0);
});
