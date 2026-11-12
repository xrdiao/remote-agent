import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { FusionRunner } from '../server/fusion/runner.mjs';
import { FusionScheduler } from '../server/fusion/scheduler.mjs';
import { fusionEvent, fusionLive, fusionRuns as menuRuns, allFusionRuns, findFusionRun } from '../server/fusion/state.mjs';
import { fusionStore } from '../server/fusion/store.mjs';
import { fixture, flush, nativeInvocation } from './fusion-fixture.mjs';
import { FusionControlError, FUSION_TOOLS } from '../server/fusion/contract.mjs';
function scenario({ readWorkspace = true } = {}) {
  const h = fixture(), scheduler = new FusionScheduler(), calls = [], pending = new Map(), stops = [];
  const agent = { catalog: { async refresh() {}, enrich: snapshot => snapshot }, async execute(run, id, prompt, recovering) {
    const attempt = run.attempts.find(row => row.id === id);
    calls.push({ id, kind: attempt.kind, prompt, recovering });
    attempt.status = 'running'; attempt.submission = 'accepted'; attempt.acceptedAt ||= Date.now();
    attempt.native ||= { threadId: attempt.kind === 'main' ? 'main-thread' : id, turnId: id, messageId: id };
    const task = run.tasks.find(row => row.id === attempt.taskId);
    if (task) task.status = 'running';
    const readEvents = attempt.kind === 'main' && readWorkspace ? h.apply({ action: 'read_workspace' }).events.map(event => event.id) : [];
    return new Promise((resolve, reject) => pending.set(id, { resolve: result => {
      runner.acknowledge({ turnId: attempt.native.turnId }, readEvents);
      resolve({ text: 'native evidence', completed: true, native: attempt.native, ...result });
    }, reject }));
  }, async stop(id) { stops.push(id); }, async softwareCapabilities() { return h.run.capabilities.map(row => ({ app: row.app, controller: true, worker: true, connected: true })); } };
  const controller = { async start() {}, async idle() { return true; }, async stop(attempt) { stops.push(attempt.id); } };
  const runner = new FusionRunner(h.run, { scheduler, agent, controller });
  const control = async (action, native) => {
    const result = await runner.control(h.request(action), native);
    if (!['read_workspace', 'read_task', 'list_models', 'list_projects'].includes(action.action)) h.readWorkers();
    return result;
  };
  return { ...h, runner, control, agent, scheduler, controller, calls, pending, stops };
}
function removalScenario() {
  const h = scenario(), actions = [];
  h.run.bindings.push(...['first', 'second'].map(id => ({ id, role: 'worker', app: 'cursor', threadId: 'worker-' + id, project: h.project })));
  h.controller.close = async () => { actions.push('unbind-main'); };
  h.agent.releaseMainProject = () => { actions.push('release-project'); };
  h.agent.cleanupBinding = async (_run, binding) => {
    actions.push(binding.threadId);
    if (binding.id === h.failId) throw new Error('Native cleanup not confirmed');
    return { confirmed: true, action: binding.app === 'codex' ? 'archive' : 'delete', app: binding.app, threadId: binding.threadId, at: 20 };
  };
  return Object.assign(h, { actions });
}
test('deleting a workbench cleans each bound native worker before its main and retains execution records', async () => {
  const h = removalScenario(), original = structuredClone({ tasks: h.run.tasks, attempts: h.run.attempts, works: h.run.works });
  h.run.bindings.push({ ...h.run.bindings[1], id: 'duplicate-binding' });
  h.run.favorite = true;
  const unrelated = structuredClone(h.run); unrelated.id = 'unrelated-menu-workbench'; unrelated.bindings = []; unrelated.title = 'Do not change';
  menuRuns.test.runs.push(unrelated); const untouched = structuredClone(unrelated);
  await h.runner.remove();
  assert.deepEqual(h.actions, ['unbind-main', 'release-project', 'worker-first', 'worker-second', 'main-thread']);
  assert(h.run.removedAt); assert.equal(h.run.favorite, false); assert.equal(h.run.stopRequested, true);
  assert.equal(h.run.removal.done, 3); assert.equal(h.run.removal.total, 3); assert.equal(menuRuns.test.current, '');
  assert(h.run.bindings.every(binding => binding.cleanup.confirmed));
  assert.deepEqual({ tasks: h.run.tasks, attempts: h.run.attempts, works: h.run.works }, original);
  assert.deepEqual(unrelated, untouched); assert(!allFusionRuns().some(row => row.id === h.run.id));
  assert.throws(() => findFusionRun(h.run.id), /没有这个 Fusion 工作台/);
  const saved = JSON.parse(fs.readFileSync(fusionStore.file, 'utf8')).owners.test.runs.find(row => row.id === h.run.id);
  assert(saved.removedAt); assert(saved.bindings.every(binding => binding.cleanup.confirmed)); assert.deepEqual(h.stops, []);
});
test('partial native cleanup preserves the workbench and explicit retry skips confirmed targets', async () => {
  const h = removalScenario(); h.failId = 'second';
  await assert.rejects(() => h.runner.remove(), /Native cleanup not confirmed/);
  assert.equal(h.run.removedAt, 0); assert.equal(findFusionRun(h.run.id), h.run);
  assert.equal(h.run.removal.done, 1); assert.equal(h.run.removal.total, 3);
  assert.equal(h.run.bindings[1].cleanup.confirmed, true); assert.equal(h.run.bindings[2].cleanup.confirmed, false);
  assert.equal(h.run.bindings[0].cleanup, undefined); assert.deepEqual(h.actions.slice(2), ['worker-first', 'worker-second']);
  await flush(); assert.equal(h.actions.length, 4);
  h.failId = ''; const recovered = new FusionRunner(h.run, { agent: h.agent, controller: h.controller, scheduler: h.scheduler });
  await recovered.remove();
  assert.deepEqual(h.actions.filter(value => value.startsWith('worker') || value === 'main-thread'), ['worker-first', 'worker-second', 'worker-second', 'main-thread']);
  assert.equal(h.run.removal.done, 3); assert(h.run.removedAt); assert.equal(h.run.removal.error, '');
});
test('unfinished unknown and stopping executions cannot be deleted or reported as cleaned', async () => {
  for (const status of ['queued','preparing','submitting','running','unknown','stopping']) {
    const h = removalScenario(); h.run.attempts.push({ id: 'unsettled', status, kind: 'task' }); const before = structuredClone(h.run);
    await assert.rejects(() => h.runner.remove(), /请先停止并核对/);
    assert.deepEqual(h.run, before); assert.deepEqual(h.actions, []);
  }
});
async function managementScenario() {
  const {FusionController}=await import('../server/fusion/controller.mjs');
  const h=scenario(),requests=[],replies=[];
  h.turn={id:'user-message',threadId:'main-thread',turnId:'native-turn',accepted:true,ended:false};
  h.agent.close=async()=>{};
  h.agent.call=async(_context,code)=>{
    const {method,args}=nativeInvocation(code);
    if(method==='codexFusionTurn')return h.turn;
    if(method==='nativeSessionInfo'&&args[2]==='tools')return requests.slice();
    if(method==='nativeSessionInfo'&&args[2]==='settings')return {model:'cheap',effort:'low'};
    if(method==='nativeSessionAction'&&args[2]==='toolReply'){
      const reply=args[3];replies.push(reply);
      requests.splice(requests.findIndex(request=>request.id===reply.requestId),1);
      if(h.replyGate)await h.replyGate(reply);return true;
    }
    if(method==='nativeSessionAction'&&args[2]==='unbindTools')return true;
    throw Error(code);
  };
  const connect=()=>{const driver=new FusionController(h.runner);driver.context={native:{threadId:'main-thread'}};return driver;};
  const request=(id,action)=>requests.push({id,params:{threadId:'main-thread',turnId:h.turn.turnId,callId:'call-'+id,tool:'ra_fusion',arguments:action}});
  return Object.assign(h,{requests,replies,connect,request});
}
test('invalid model parameters and wrong native actors never read catalogs or create capability snapshots', async () => {
  const h=scenario(),before=structuredClone(h.run);
  h.agent.softwareCapabilities=async()=>assert.fail('software discovery must not run');
  h.agent.capabilities=async()=>assert.fail('native model reading must not run');
  h.agent.catalog.refresh=async()=>assert.fail('public refresh must not run');
  for(const [input,field] of [['{"limit":1000}','input.limit'],['{"offset":-1}','input.offset'],['{"view":"profile"}','input.model'],['{"view":"source","source":"codex-billing","length":0}','input.length']])
    await assert.rejects(()=>h.control({action:'list_models',app:'all',input},h.native()),e=>e instanceof FusionControlError&&e.feedback.field===field);
  await assert.rejects(()=>h.control({action:'list_models',app:'codex'},{...h.native(),threadId:'other-thread'}),/真实原生轮次/);
  assert.deepEqual(h.run,before);assert.equal(h.calls.length,0);
  const snapshot=h.run.capabilities[0];const view=await h.control({action:'list_models',app:'codex',input:JSON.stringify({snapshotIds:[snapshot.id]})},h.native());
  assert.equal(view.models.length,1);assert.deepEqual(view.snapshotIds,[snapshot.id]);
});
test('parameter feedback belongs to the actual native request and preserves the original error event', async () => {
  const h=await managementScenario(),driver=h.connect();h.agent.capabilities=async()=>assert.fail('invalid query performed I/O');
  h.request('bad',{action:'list_models',app:'codex',input:'{"limit":1000}'});await driver.read();await flush();
  assert.equal(h.replies.length,1);assert.equal(h.replies[0].requestId,'bad');assert.equal(h.replies[0].result.success,false);
  const feedback=JSON.parse(h.replies[0].result.contentItems[0].text);assert.equal(feedback.field,'input.limit');assert.equal(feedback.expected.max,8);
  const event=h.run.events.find(e=>e.type==='control_error');assert.equal(event.native,undefined);assert.equal(event.data.native.turnId,h.turn.turnId);
  assert.equal(event.data.native.requestId,'bad');assert.equal(event.data.action,'list_models');assert.equal(event.data.reason,feedback.message);assert.deepEqual(event.data.details,feedback);assert.equal(event.deliveredTo,h.turn.turnId);
  h.request('index',{action:'read_workspace'});await driver.read();assert.equal(h.replies[1].result.success,true);
  assert.equal(h.run.tasks.length,0);assert.equal(h.run.effects.length,0);assert.equal(h.calls.length,0);await driver.close();
});
test('non-parameter native failures keep their original text and do not become suggested commands', async () => {
  const h=await managementScenario(),driver=h.connect();h.runner.control=async()=>{throw Error('CDP closed during native operation');};
  h.request('native-failure',{action:'read_workspace'});await driver.read();await flush();
  assert.equal(h.replies[0].result.success,false);assert.equal(h.replies[0].result.contentItems[0].text,'CDP closed during native operation');
  const event=h.run.events.find(e=>e.type==='control_error');assert.equal(event.data.details,undefined);assert.equal(event.data.reason,'CDP closed during native operation');await driver.close();
});
test('a devin main turn ends with its cached reply after transcript pruning and a next user keeps a separate attempt', async () => {
  const h=await managementScenario();
  h.run.main.app='devin';h.run.bindings[0].app='devin';
  const session={sessionId:'main-thread',providerId:'devin-cli',cwd:'/project',status:'active',
    mcpServers:[{name:'ra-fusion',type:'http',url:'http://native-test',headers:[]}]};
  const state={sessions:[session],perSession:{'main-thread':{messages:[]}},agentRequests:{byId:{}}},listeners=new Set();
  const update=()=>{for(const listener of [...listeners])listener()};
  const nativeModule={tryGetAcpSingleton:name=>name==='connectorService'
    ?{getConnectors:()=>[{id:'devin-cli',capabilities:{mcpCapabilities:{http:true}}}]}:'native-sender',
    sendAgentRequestThunk:(provider,request,sender)=>({provider,request,sender})};
  const window={__acpStore:{getState:()=>({acp:state}),subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
    dispatch:async()=>true}};
  const vmContext=vm.createContext({window,Map,Set,WeakMap,Error,JSON,nativeModule,devinSessionRecord:()=>session});
  const source=fs.readFileSync(new URL('../server/page/fusion-tools.js',import.meta.url),'utf8').replace("await import('@exa/chat-client')",'nativeModule');
  vm.runInContext(source+';this.tools=fusionNativeTools;this.turn=fusionDevinTurn;',vmContext);
  const mcpConfig={name:'ra-fusion',type:'http',url:'http://native-test',headers:[]};
  assert.equal((await vmContext.tools.bind('devin','main-thread',{tools:FUSION_TOOLS,mcp:mcpConfig})).profileReady,true);
  const original=h.agent.call;
  h.agent.call=async(_context,code)=>{const {method,args}=nativeInvocation(code);
    if(method==='codexFusionTurn')return vmContext.turn('main-thread',args[0],args[3]);
    return original(_context,code);};
  const driver=h.connect();
  const prompt=(generationId,clientId,status='started')=>{state.agentRequests.byId[generationId]={method:'session/prompt',status,
    params:{sessionId:'main-thread',_meta:{'cognition.ai/clientMessageId':clientId}}};};
  const user=(id,clientId,text)=>state.perSession['main-thread'].messages.push({id,kind:'user_message',
    content:[{content:{type:'text',text},_meta:{'cognition.ai/clientMessageId':clientId}}]});
  const agent=(id,text)=>state.perSession['main-thread'].messages.push({id,kind:'agent_message',
    content:[{content:{type:'text',text}}]});
  prompt('gen-1','7c9e6679-7425-40de-944b-e07fc1f90ae7');user('u1','7c9e6679-7425-40de-944b-e07fc1f90ae7','first task');agent('r1','partial');
  update();await driver.read();await flush();
  assert.equal(h.run.attempts.length,1);assert.equal(h.run.attempts[0].status,'running');assert(h.run.attempts[0].acceptedAt);
  state.perSession['main-thread'].messages.at(-1).content[0].content.text='final answer';update();
  state.agentRequests.byId['gen-1'].status='completed';state.perSession['main-thread'].messages=[];update();
  await driver.read();await flush();
  const attempt=h.run.attempts[0];
  assert.equal(attempt.status,'ended');assert(attempt.endedAt);assert.equal(attempt.result.completed,true);
  assert.equal(attempt.result.text,'final answer');assert.equal(attempt.native.generationId,'gen-1');
  const ended=structuredClone(attempt);
  await driver.read();await flush();
  assert.deepEqual(attempt,ended);
  assert.equal(h.run.attempts.length,1);assert.equal(h.run.events.filter(e=>e.type==='user_input').length,1);
  assert.equal(h.calls.length,0);
  prompt('gen-2','8d0f7780-8536-51ef-a55c-f18fd2f01bf8');user('u2','8d0f7780-8536-51ef-a55c-f18fd2f01bf8','second task');
  update();await driver.read();await flush();
  assert.equal(h.run.attempts.length,2);
  const second=h.run.attempts[1];
  assert.equal(second.status,'running');assert.equal(second.native.generationId,'gen-2');
  assert.equal(second.native.turnId,'u2');assert.equal(second.result,null);assert.equal(second.endedAt,null);
  vmContext.tools.unbind('devin','main-thread');await driver.close();
});
test('a devin worker attempt finishes awaiting_review from its cached native turn after pruning', { timeout: 5000 }, async () => {
  const { FusionAgent } = await import('../server/fusion/agent.mjs');
  const h = scenario(); h.run.main.app = 'devin';
  const thread = 'worker-thread', attemptId = 'att-1';
  const session = { sessionId: thread, providerId: 'devin-cli', cwd: h.project.root, status: 'idle', title: 'Worker' };
  const state = { sessions: [session], perSession: {}, agentRequests: { byId: {} } };
  const listeners = new Set(), dispatched = [];
  const update = () => { for (const listener of [...listeners]) listener(); };
  const window = { __acpStore: { getState: () => ({ acp: state }),
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    dispatch: async request => { dispatched.push(request); return request; } } };
  const nativeModule = { getAllMessages: data => data.messages, tryGetAcpSingleton: () => 'sender',
    sendAgentRequestThunk: (provider, request, sender) => ({ provider, request, sender }) };
  const vmContext = vm.createContext({ window, Map, Set, WeakMap, Error, JSON, Promise, Date, Number, Array, Object, String, RegExp,
    remoteContext: { app: 'devin', threadId: thread, cwd: h.project.root, host: '' },
    nativeModule, devinSessionRecord: id => id === thread ? session : null,
    nativeMarkdownItem: (i, k, t, at, images) => ({ i, k, t, at, ...(images?.length ? { images } : {}) }),
    activeThread: () => 'other', devinQuestions: () => null, nativeWaiting: () => ({}),
    agentRun: () => ({ id: 'gen-1', status: { started: 'running', completed: 'completed', failed: 'error' }[state.agentRequests.byId['gen-1'].status] }),
    agentModelName: () => 'SWE-2 Medium', effortName: () => '', devinSurface: () => false });
  const slice = (file, start, end) => { const source = fs.readFileSync(new URL(`../server/page/${file}`, import.meta.url), 'utf8')
      .replaceAll("await import('@exa/chat-client')", 'nativeModule'), s = source.indexOf(start);
    assert(s >= 0, start); const e = source.indexOf(end, s); assert(e > s, end); return source.slice(s, e); };
  vm.runInContext(slice('fusion-tools.js', '  const fusionNativeControllers =', '  const fusionNativeTools =')
    + ';this.turn=fusionDevinTurn;', vmContext);
  vm.runInContext(slice('session-actions.js', '  const nativeSessionAction = async', '  const nativeSessionRenameInput =')
    + ';this.action=nativeSessionAction;', vmContext);
  vm.runInContext(slice('chat-extract.js', '  const codexFusionTurn =', '  // One Codex turn')
    + ';this.read=codexFusionTurn;', vmContext);
  vm.runInContext(slice('chat-extract.js', '  const nativePerformance =', '  const cursorCurrentChat =')
    + slice('devin.js', '  const devinMessageText =', '  const THINKING_ROOT =')
    + slice('devin.js', '  const devinPermissionEntries =', '  const devinQuestions =')
    + slice('chat-extract.js', '  const nativeConversationChat =', '  const contextPct =')
    + ';this.chat=nativeConversationChat;', vmContext);
  vm.runInContext(slice('chat-extract.js', '  const watchCodexData =', '  const codexUserText =')
    + ';this.watch=watchCodexData;', vmContext);
  const binding = { id: 'w1', role: 'worker', app: 'devin', threadId: thread, windowId: '', host: '', project: h.project,
    nativeProject: { app: 'devin', threadId: thread, provider: 'devin-cli', host: '', cwd: h.project.root,
      roots: [{ root: h.project.root, host: '' }] } };
  h.run.bindings.push(binding);
  const workId = h.create(); h.run.works.find(work => work.id === workId).status = 'running';
  const task = { ...h.task('fusion-wc'), workId, status: 'running', workerId: 'agent-1', inputs: [] };
  h.run.tasks.push(task); h.run.agents.push({ id: 'agent-1', bindingId: 'w1', status: 'running' });
  h.run.attempts.push({ id: attemptId, kind: 'task', workId, taskId: task.id, assignmentId: '', status: 'submitting',
    submission: 'submitting', bindingId: 'w1', native: null, created: Date.now(), acceptedAt: null, endedAt: null });
  const agent = new FusionAgent({ scheduler: h.scheduler, publish: () => {}, onEvent: () => {} });
  let notify;
  const context = { native: { app: 'devin', threadId: thread, cwd: h.project.root, host: '', roots: [] },
    source: { subscribe: cb => { notify = cb; return vmContext.watch(() => {}).stop; },
      readConversation: async () => { const chat = await vmContext.chat(false, 80), snapshot = { chat: { ...chat }, state: chat?._nativeState };
        delete snapshot.chat._nativeState; return snapshot; } },
    cdp: { onclose: null } };
  agent.call = async (_ctx, code) => { const { method, args } = nativeInvocation(code);
    if (method === 'codexFusionTurn') return vmContext.read(args[0], args[1], args[2], args[3]);
    if (method === 'nativeSessionInfo' && args[2] === 'settings') return { model: 'swe-2-medium', effort: '', usage: null, usageBasis: 'test' };
    if (method === 'nativeSessionInfo' && args[2] === 'sendError') return null;
    throw new Error(code); };
  const observing = agent.observe({ controller: h.run, attemptId, binding, context, stopping: false }, false);
  assert.equal(listeners.size, 1, 'the native observer owns capture before submission');
  await vmContext.action('devin', thread, 'send', { text: 'task', requestId: attemptId });
  assert.equal(dispatched.length, 1); assert.equal(dispatched[0].request.method, 'session/prompt');
  state.agentRequests.byId['gen-1'] = { method: 'session/prompt', status: 'started',
    params: { sessionId: thread, prompt: [{ type: 'text', text: 'task' }], _meta: { 'cognition.ai/clientMessageId': attemptId } } };
  state.perSession[thread] = { messages: [
    { id: 'u1', kind: 'user_message', content: [{ content: { type: 'text', text: 'task' },
      _meta: { 'cognition.ai/clientMessageId': attemptId } }] },
    { id: 'r1', kind: 'agent_message', content: [{ content: { type: 'text', text: '12 files' } }] }] };
  update();
  state.agentRequests.byId['gen-1'].status = 'completed'; delete state.perSession[thread]; update();
  notify();
  const result = await observing;
  h.runner.completed(attemptId, result);
  const attempt = h.run.attempts[0];
  assert.equal(attempt.status, 'awaiting_review'); assert.equal(attempt.result.completed, true);
  assert.equal(attempt.result.text, '12 files'); assert.equal(attempt.native.messageId, 'u1');
  assert.equal(attempt.native.generationId, 'gen-1'); assert.equal(attempt.acceptedAt > 0, true);
  assert.equal(attempt.submission, 'accepted'); assert.equal(task.status, 'awaiting_review');
  assert.equal(listeners.size, 0, 'completed observation releases native capture');
});
test('background review uses the returned task and work templates and completes only after its native turn ends', async () => {
  const h=scenario(),workId=h.create();h.plan(workId);h.run.status='waiting';
  await h.control({action:'dispatch',workId,tasks:[h.task('A')]},h.native());await flush();const child=h.calls[0];
  h.pending.get(child.id).resolve({text:'42'});await flush();const main=h.calls.find(c=>c.kind==='main');assert(main);
  const current=async action=>{const native={...h.native(),turnId:main.id};const result=await h.control(action,native);h.runner.acknowledge(native,result.events.map(e=>e.id));return result;};
  const detail=await current({action:'read_task',taskId:'A',attemptId:child.id}),template=detail.review;
  const reviewed=await current({...template,verdict:'accept',reason:'Read the original result',summary:'42 verified',evidence:template.evidence.map(e=>({...e,detail:'Result is 42',reference:'result.text'}))});
  const work=await current(reviewed.work.read);await current({...work.finish,summary:'Delivered verified evidence',evidence:work.finish.evidence.map(e=>({...e,attemptId:child.id,detail:'42 verified',reference:'result.text'}))});
  assert.equal(h.run.works[0].status,'closing');assert.equal(h.run.works[0].deliveries.length,0);
  h.pending.get(main.id).resolve({text:'Delivery complete'});await flush();assert.equal(h.run.works[0].status,'completed');assert.equal(h.run.works[0].deliveries.length,1);assert.equal(h.calls.length,2);
});
test('an acknowledged read parameter failure after finish stays in the journal without revoking a valid delivery', async () => {
  const h=await managementScenario(),driver=h.connect();await driver.read();
  const workId=h.create();h.plan(workId);
  h.apply({action:'finish',workId,summary:'Verified',evidence:[{criterion:'C1',detail:'Native evidence',reference:'main-turn:native-turn'}]});
  h.request('post-finish-read',{action:'read_workspace',workId,input:'not-json'});await driver.read();await flush();
  const error=h.run.events.find(e=>e.type==='control_error'),record=structuredClone(error);
  assert.equal(error.data.action,'read_workspace');assert.equal(error.data.details.field,'input');assert.equal(error.deliveredTo,'native-turn');
  assert.deepEqual(error.data.details.read,{action:'read_workspace',workId});assert.equal(h.run.works[0].status,'closing');
  h.turn={...h.turn,ended:true,completed:true,text:'Done'};await driver.read();await flush();
  assert.equal(h.run.works[0].status,'completed');assert.equal(h.run.works[0].deliveries.length,1);
  assert.deepEqual(h.run.events.find(e=>e.id===error.id),record);assert.equal(h.run.events.some(e=>e.type==='delivery_pending'),false);
  assert.equal(h.calls.length,0);await driver.close();
});
test('unacknowledged, foreign-turn, mutating and native failures still invalidate a delivery candidate', async () => {
  const cases=[
    ['unacknowledged',e=>e.deliveredTo=''],['foreign turn',e=>e.data.native.turnId='other-turn'],
    ['foreign thread',e=>e.data.native.threadId='other-thread'],['missing thread',e=>delete e.data.native.threadId],
    ['native failure',e=>delete e.data.details],['legacy diagnostic',e=>delete e.data.action],
    ['mutating action',e=>e.data.action='dispatch'],['new user input',e=>e.type='user_input'],
    ['new child result',e=>e.type='task_result'],['native approval',e=>e.type='native_interaction'],
  ];
  for(const [name,change] of cases){
    const h=scenario(),workId=h.create();h.plan(workId);h.runner.wake=()=>{};
    const main={id:'main',kind:'main',status:'running',acceptedAt:10,native:{threadId:'main-thread',turnId:'native-turn'}};h.run.attempts.push(main);
    h.apply({action:'finish',workId,summary:'ready',evidence:[{criterion:'C1',detail:'actual',reference:'main-turn:native-turn'}]});
    const event=fusionEvent(h.run,'control_error',{workId,action:'read_workspace',native:{...main.native},reason:'bad input',details:{field:'input'}},name);
    event.deliveredTo='native-turn';change(event);const record=structuredClone(event);
    await h.runner.mainEnded(main.id,{completed:true});assert.equal(h.run.works[0].status,'running',name);assert.equal(h.run.works[0].deliveries.length,0,name);
    assert.deepEqual(h.run.events.find(e=>e.id===name),record);assert(h.run.events.some(e=>e.type==='delivery_pending'),name);
  }
});
test('stop requests and unknown executions still prevent delivery after an acknowledged read error', async () => {
  for(const state of ['run stop','work stop','unknown']){
    const h=scenario(),workId=h.create();h.plan(workId);h.runner.wake=()=>{};
    const main={id:'main',kind:'main',status:'running',workExecutions:[{workId}],acceptedAt:10,native:{threadId:'main-thread',turnId:'native-turn'}};h.run.attempts.push(main);
    h.apply({action:'finish',workId,summary:'ready',evidence:[{criterion:'C1',detail:'actual',reference:'main-turn:native-turn'}]});
    const error=fusionEvent(h.run,'control_error',{action:'read_workspace',native:{...main.native},details:{field:'input'}});error.deliveredTo='native-turn';
    if(state==='unknown')h.run.attempts.push({id:'unknown',kind:'task',workId,status:'unknown',endedAt:null});
    else await h.runner.stop(state==='work stop'?{workId}:{});
    await h.runner.mainEnded(main.id,{completed:true});h.runner.finishStop();
    assert.equal(h.run.works[0].status,state==='unknown'?'running':'stopped',state);assert.equal(h.run.works[0].deliveries.length,0,state);
    assert.equal(h.run.events.find(e=>e.id===error.id).deliveredTo,'native-turn');
  }
});
test('an idle main gets one compact background review for a new result even after its notification was read', async () => {
  const h=scenario(),workId=h.create();h.plan(workId);h.run.status='waiting';
  await h.control({action:'dispatch',workId,tasks:[h.task('A')]},h.native());await flush();
  const child=h.calls[0];h.pending.get(child.id).resolve({text:'Result requiring actual review'});await flush();
  const main=h.calls.find(c=>c.kind==='main');assert(main);assert.equal(h.calls.length,2);assert(main.prompt.length<400);
  const attempt=h.run.attempts.find(a=>a.id===main.id);assert.equal(attempt.origin,'events');assert.deepEqual(attempt.eventIds,['result:'+child.id]);
  const reply=await h.control({action:'read_workspace'},h.native());h.runner.acknowledge(h.native(),reply.events.map(e=>e.id));
  assert.equal(h.runner.pendingEvents().length,0);assert.equal(reply.pendingReviews.total,1);
  h.pending.get(main.id).resolve({text:'Ended without reviewing'});await flush();h.runner.wake();await flush();
  assert.equal(h.calls.length,2);assert.equal(h.run.tasks[0].status,'awaiting_review');assert.equal(h.run.attempts.length,2);
  assert.equal(h.run.status,'blocked');assert(h.run.blockedReason.includes('A'));assert.equal(h.run.attempts.find(a=>a.id===main.id).reviewBatch.outcome,'incomplete');
  assert.equal((await h.control({action:'read_workspace'},h.native())).pendingReviews.total,1);
});
test('historical notification coverage does not hide pending results and partial review schedules the remaining batch', async () => {
  const h=scenario(),workId=h.create();h.plan(workId);h.run.status='blocked';
  await h.control({action:'dispatch',workId,tasks:[h.task('A'),h.task('B')]},h.native());await flush();
  const [one,two]=h.calls;h.pending.get(one.id).resolve({});h.pending.get(two.id).resolve({});await flush();
  for(const event of h.run.events)event.deliveredTo='old-turn';
  h.run.attempts.push({id:'old-background',kind:'main',origin:'events',status:'ended',endedAt:30,eventIds:h.run.events.map(e=>e.id)});
  h.run.status='waiting';h.runner.wake();await flush();const first=h.calls.find(row=>row.kind==='main');assert(first);
  const review=async(id,child,turn)=>h.control({action:'review',taskId:id,attemptId:child.id,verdict:'accept',reason:'Checked original',summary:'Verified '+id,
    evidence:[{criterion:id+':1',detail:'Actual evidence',reference:'result.text'}]},{...h.native(),turnId:turn});
  await review('A',one,first.id);h.pending.get(first.id).resolve({});await flush();
  const mains=h.calls.filter(row=>row.kind==='main');assert.equal(mains.length,2);const next=mains[1];
  assert.equal(h.run.attempts.find(a=>a.id===first.id).reviewBatch.outcome,'progress');
  assert.deepEqual(h.run.attempts.find(a=>a.id===next.id).reviewBatch.attemptIds,[two.id]);
  await review('B',two,next.id);h.pending.get(next.id).resolve({});await flush();h.runner.wake();await flush();
  assert.equal(h.calls.length,4);assert.equal(h.run.status,'waiting');assert.equal(h.run.tasks.every(t=>t.status==='accepted'),true);
});
test('incomplete review survives recovery without another call and explicit user continue permits one new decision', async () => {
  const h=scenario(),workId=h.create();h.plan(workId);h.run.status='waiting';
  await h.control({action:'dispatch',workId,tasks:[h.task('A')]},h.native());await flush();h.pending.get(h.calls[0].id).resolve({});await flush();
  const main=h.calls.find(row=>row.kind==='main');h.pending.get(main.id).resolve({});await flush();assert.equal(h.run.status,'blocked');
  const old=structuredClone(h.run.attempts.find(a=>a.id===main.id));await h.runner.recover();h.runner.wake();await flush();
  assert.equal(h.calls.length,2);assert.deepEqual(h.run.attempts.find(a=>a.id===main.id),old);
  await h.runner.resume();await flush();const next=h.calls.filter(row=>row.kind==='main').at(-1);assert.notEqual(next.id,main.id);assert.equal(h.calls.length,3);
  h.pending.get(next.id).resolve({});await flush();assert.equal(h.run.status,'blocked');h.runner.wake();await flush();assert.equal(h.calls.length,3);
});
test('result-specific questions hold only their result and a real answer resumes pending review on the same child', async () => {
  const h=scenario(),workId=h.create();h.plan(workId);h.run.status='waiting';
  await h.control({action:'dispatch',workId,tasks:[h.task('A')]},h.native());await flush();const child=h.calls[0];h.pending.get(child.id).resolve({});await flush();
  const main=h.calls.find(row=>row.kind==='main');
  const asked=await h.control({action:'ask_user',workId,attemptId:child.id,question:'Which result should be accepted?'},{...h.native(),turnId:main.id});
  h.pending.get(main.id).resolve({});await flush();h.runner.wake();await flush();assert.equal(h.calls.length,2);assert.equal(h.run.status,'waiting');
  assert.equal(h.run.attempts.find(a=>a.id===main.id).reviewBatch.outcome,'waiting');assert.equal(h.run.tasks[0].status,'awaiting_review');
  h.runner.input({questionId:asked.questionId,text:'Use the actual original result',requestId:'real-answer'});await flush();
  const next=h.calls.filter(row=>row.kind==='main').at(-1);assert.notEqual(next.id,main.id);assert.equal(h.run.tasks[0].workerId,h.run.agents[0].id);
  await h.control({action:'review',taskId:'A',attemptId:child.id,verdict:'accept',reason:'Answered and verified',summary:'Original result verified',
    evidence:[{criterion:'A:1',detail:'Actual original evidence',reference:'result.text'}]},{...h.native(),turnId:next.id});
  h.pending.get(next.id).resolve({});await flush();assert.equal(h.calls.length,3);assert.equal(h.run.questions[0].answer,'Use the actual original result');
  assert.equal(h.run.tasks[0].status,'accepted');assert.equal(h.run.attempts.filter(a=>a.kind==='task').length,1);
});
test('an ended failed child wakes one decision and cancellation handles it without changing its native failure', async () => {
  const h=scenario(),workId=h.create();h.plan(workId);h.run.status='waiting';
  await h.control({action:'dispatch',workId,tasks:[h.task('A')]},h.native());await flush();const child=h.calls[0];
  h.pending.get(child.id).resolve({completed:false,error:'Actual native failure'});await flush();const main=h.calls.find(row=>row.kind==='main');assert(main);
  const view=await h.control({action:'read_workspace'},{...h.native(),turnId:main.id});assert.equal(view.pendingReviews.items[0].outcome,'failed');
  await h.control({action:'cancel_task',taskId:'A',reason:'Failure examined, no further work needed'},{...h.native(),turnId:main.id});
  h.pending.get(main.id).resolve({});await flush();assert.equal(h.calls.length,2);assert.equal(h.run.tasks[0].status,'cancelled');
  const attempt=h.run.attempts.find(a=>a.id===child.id);assert.equal(attempt.status,'failed');assert.equal(attempt.result.completed,false);assert.equal(attempt.result.error,'Actual native failure');
});
test('directory knowledge and review delivery are recorded only after the actual native tool reply is accepted', async () => {
  const h=await managementScenario(),workId=h.create();h.plan(workId);h.apply({action:'dispatch',workId,tasks:[h.task('A')]});
  const child=h.run.attempts[0];Object.assign(child,{status:'awaiting_review',endedAt:20,result:{completed:true,text:'42'}});h.run.effects[0].status='done';
  delete h.run.bindings[0].workerReads;const driver=h.connect();let release;h.replyGate=()=>new Promise(resolve=>{release=resolve;});
  h.request('directory',{action:'read_workspace'});const flight=driver.read();await flush();
  assert.equal(h.run.bindings[0].workerReads,undefined);assert.equal(h.run.attempts.find(a=>a.kind==='main').reviewBatch,undefined);
  release();await flight;await flush();const receipt=h.run.bindings[0].workerReads[0];assert.equal(receipt.requestId,'directory');assert.equal(receipt.threadId,'main-thread');
  assert.equal(h.run.attempts.find(a=>a.kind==='main').reviewBatch.delivered[0].attemptId,child.id);
  assert.equal(h.run.attempts[0].status,'awaiting_review');await driver.close();
});
test('new result batches resume review while another child runs and never resend a prior batch', async () => {
  const h=scenario(),workId=h.create();h.plan(workId);h.run.status='waiting';
  await h.control({action:'dispatch',workId,tasks:[h.task('A'),h.task('B')]},h.native());await flush();
  const [one,two]=h.calls;h.pending.get(one.id).resolve({});await flush();
  const firstMain=h.calls.find(c=>c.kind==='main');assert(firstMain);assert.equal(h.run.tasks[1].status,'running');
  await h.control({action:'review',taskId:'A',attemptId:one.id,verdict:'accept',reason:'verified',evidence:[{criterion:'A:1',detail:'actual',reference:'native'}]},h.native());
  h.pending.get(firstMain.id).resolve({});await flush();h.runner.wake();await flush();assert.equal(h.calls.length,3);
  h.pending.get(two.id).resolve({});await flush();const mains=h.calls.filter(c=>c.kind==='main');assert.equal(mains.length,2);
  const second=h.run.attempts.find(a=>a.id===mains[1].id);assert.deepEqual(second.eventIds,['result:'+two.id]);
  await h.control({action:'review',taskId:'B',attemptId:two.id,verdict:'accept',reason:'verified',evidence:[{criterion:'B:1',detail:'actual',reference:'native'}]},h.native());
  h.pending.get(second.id).resolve({});await flush();assert.equal(h.scheduler.mainSlots.size,0);assert.equal(h.calls.length,4);
});
test('stopped or unknown native work never starts a background review call', async () => {
  for(const state of ['stopped','unknown']){
    const h=scenario(),workId=h.create();h.plan(workId);h.apply({action:'dispatch',workId,tasks:[h.task('A')]});h.run.effects[0].status='done';
    Object.assign(h.run.attempts[0],{status:'awaiting_review',endedAt:20});h.run.status='waiting';
    fusionEvent(h.run,'task_result',{workId,taskId:'A',attemptId:h.run.attempts[0].id},'result:'+h.run.attempts[0].id);
    if(state==='stopped')h.run.stopRequested=true;else h.run.attempts.push({id:'unknown',kind:'main',status:'unknown',endedAt:null});
    h.runner.wake();await flush();assert.equal(h.calls.length,0);assert.equal(h.run.attempts.length,state==='stopped'?1:2);
  }
});
test('an accepted user turn cancels only an unsubmitted queued background review and leaves the result pending', async () => {
  const h=scenario(),workId=h.create();h.plan(workId);h.apply({action:'dispatch',workId,tasks:[h.task('A')]});h.run.effects[0].status='done';
  const child=h.run.attempts[0];Object.assign(child,{status:'awaiting_review',endedAt:20});h.run.tasks[0].status='awaiting_review';
  fusionEvent(h.run,'task_result',{workId,taskId:'A',attemptId:child.id},'result:'+child.id);h.run.status='waiting';
  let release;const holder=h.scheduler.submit({runId:h.run.id,lane:'main',attemptId:'occupied',ready:()=>true,execute:()=>new Promise(resolve=>{release=resolve;})});
  h.runner.wake();await flush();const review=h.run.attempts.find(a=>a.origin==='events');assert(review);assert.equal(h.calls.length,0);
  h.run.attempts.push({id:'real-user',kind:'main',origin:'user',status:'running',submission:'accepted',native:{turnId:'real-user'}});
  h.runner.acceptedInput('real-user');await flush();release();await holder;await flush();
  assert.equal(review.status,'cancelled');assert.equal(review.submission,'not_submitted');assert.equal(h.calls.length,0);
  assert.equal(h.run.tasks[0].status,'awaiting_review');assert.equal((await h.control({action:'read_workspace'},h.native())).pendingReviews.total,1);
  assert.equal(h.run.events.find(e=>e.id==='result:'+child.id).deliveredTo,'');
});
test('all-software model discovery shares one public refresh and immutable detail reads do not revisit native windows', async () => {
  const h=scenario(),reads=[],refreshes=[];
  h.agent.softwareCapabilities=async()=>[{app:'codex',connected:true},{app:'cursor',connected:true},{app:'devin',connected:false}];
  h.agent.capabilities=async(_run,app)=>{reads.push(app);const snapshot=structuredClone(h.run.capabilities.find(row=>row.app===app));snapshot.id+='-read';return snapshot;};
  h.agent.catalog.refresh=async models=>refreshes.push(models);
  const view=await h.control({action:'list_models',app:'all',input:JSON.stringify({needs:{kind:'code-review',tools:true}})},h.native());
  assert.deepEqual(reads,['codex','cursor']);assert.equal(refreshes.length,1);assert.deepEqual(refreshes[0].map(m=>m.app),['codex','cursor']);
  assert.deepEqual(view.models.map(m=>m.app),['codex','cursor']);assert.equal(view.models[1].model,'Auto');
  await h.control(view.models[0].read,h.native());await h.control(view.apps[1].read,h.native());
  assert.deepEqual(reads,['codex','cursor']);assert.equal(refreshes.length,1);
});
test('an unavailable native catalog records its own error without converting public models into executable candidates', async () => {
  const h=scenario();h.agent.softwareCapabilities=async()=>[{app:'codex',connected:true},{app:'cursor',connected:true}];
  h.agent.capabilities=async(_run,app)=>{if(app==='cursor')throw Error('native catalog unavailable');const snapshot=structuredClone(h.run.capabilities[0]);snapshot.id+='-read';return snapshot;};
  const view=await h.control({action:'list_models',app:'all'},h.native());
  assert.equal(view.models.length,1);assert.equal(view.apps.find(a=>a.app==='cursor').available,false);
  assert.equal(h.run.capabilities.find(s=>s.app==='cursor').error,'native catalog unavailable');
  assert(view.apps.find(a=>a.app==='cursor').error.includes('native catalog'));
});
test('native accepted steering in the same turn releases wait without duplicating the user message or creating another main Attempt', async () => {
  const h=await managementScenario(),driver=h.connect();h.run.tasks.push({id:'B',status:'running',goal:'Pending child',attemptIds:[],inputs:[],reviews:[],dependsOn:[]});
  h.request('wait',{action:'wait'});await driver.read();await flush();assert.equal(h.runner.waiters.size,1);
  h.turn={...h.turn,id:'native-steer-message',user:'先处理我的新要求'};await driver.read();await flush();
  assert.equal(h.replies.length,1);assert.equal(h.replies[0].requestId,'wait');assert.deepEqual(JSON.parse(h.replies[0].result.contentItems[0].text).events,[]);
  assert.equal(h.run.attempts.length,1);assert.equal(h.run.attempts[0].native.messageId,'user-message');
  const accepted=h.run.events.filter(e=>e.data.native?.messageId==='native-steer-message');assert.equal(accepted.length,1);assert.equal(accepted[0].deliveredTo,'native-turn');
  await driver.read();assert.equal(h.run.events.filter(e=>e.data.native?.messageId==='native-steer-message').length,1);
  assert.equal(h.calls.length,0);await driver.close();
});
test('concurrent native management replies deliver an inbox event to only one actual tool response', async () => {
  const h=await managementScenario(),driver=h.connect();h.run.tasks.push({id:'B',status:'running',goal:'Pending child',attemptIds:[],inputs:[],reviews:[],dependsOn:[]});
  h.request('wait',{action:'wait'});await driver.read();await flush();
  fusionEvent(h.run,'task_result',{taskId:'B'},'shared-event');h.request('read',{action:'read_workspace'});
  await driver.read();await flush();
  const events=h.replies.flatMap(reply=>JSON.parse(reply.result.contentItems[0].text).events);
  assert.deepEqual(events.map(e=>e.id),['shared-event']);assert.equal(h.run.events.find(e=>e.id==='shared-event').deliveredTo,'native-turn');
  assert.equal(h.calls.length,0);await driver.close();
});
test('waiting for events releases the native request reader and acknowledges the batch only after its actual reply', async () => {
  const h=await managementScenario(),driver=h.connect();h.run.tasks.push({id:'B',status:'running',goal:'Pending child',attemptIds:[],inputs:[],reviews:[],dependsOn:[]});
  h.request('wait',{action:'wait'});await driver.read();await flush();
  assert.equal(h.runner.waiters.size,1);assert.equal(h.replies.length,0);
  h.request('read',{action:'read_workspace'});await driver.read();assert.equal(h.replies.length,1);assert.equal(h.replies[0].requestId,'read');assert.equal(h.replies[0].result.success,true);
  let release;h.replyGate=reply=>reply.requestId==='wait'?new Promise(resolve=>{release=resolve;}):null;
  fusionEvent(h.run,'task_result',{taskId:'B'},'one');fusionEvent(h.run,'user_input',{text:'new detail'},'two');h.runner.wake();await flush();
  assert.equal(h.replies.length,2);const value=JSON.parse(h.replies[1].result.contentItems[0].text);
  assert.deepEqual(value.events.map(e=>e.id),['one','two']);assert(h.run.events.filter(e=>e.id==='one'||e.id==='two').every(e=>!e.deliveredTo));
  await driver.read();assert.equal(h.replies.length,2);release(true);await flush();
  assert(h.run.events.filter(e=>e.id==='one'||e.id==='two').every(e=>e.deliveredTo==='native-turn'));
  assert.equal(h.calls.length,0);assert.equal(h.run.attempts.length,1);assert.equal(h.run.attempts[0].status,'running');await driver.close();
});
test('reconnecting resumes the same still-pending native wait request without replaying its command or creating a main turn', async () => {
  const h=await managementScenario();h.run.tasks.push({id:'B',status:'running',goal:'Pending child',attemptIds:[],inputs:[],reviews:[],dependsOn:[]});h.request('wait',{action:'wait'});
  const first=h.connect();await first.read();await flush();assert.equal(h.runner.waiters.size,1);await first.close();await flush();
  assert.equal(h.runner.waiters.size,0);assert.equal(h.replies.length,0);
  const next=h.connect();await next.read();await flush();assert.equal(h.runner.waiters.size,1);assert.equal(h.run.commands.filter(c=>c.action==='wait').length,1);
  fusionEvent(h.run,'task_result',{taskId:'B'},'result');h.runner.wake();await flush();
  assert.equal(h.replies.length,1);assert.equal(h.replies[0].requestId,'wait');assert.equal(h.run.events.at(-1).deliveredTo,'native-turn');
  assert.equal(h.run.attempts.length,1);assert.equal(h.calls.length,0);await next.close();
});
test('a native cancelled wait releases its listener and keeps later results for the next actual main interaction', async () => {
  const h=await managementScenario(),driver=h.connect();h.run.tasks.push({id:'B',status:'running',goal:'Pending child',attemptIds:[],inputs:[],reviews:[],dependsOn:[]});h.request('wait',{action:'wait'});
  await driver.read();await flush();h.requests.length=0;h.turn={...h.turn,ended:true,completed:true};await driver.read();await flush();
  assert.equal(h.runner.waiters.size,0);assert.equal(h.replies.length,0);
  fusionEvent(h.run,'task_result',{taskId:'B'},'later');h.runner.wake();await flush();assert.equal(h.run.events.at(-1).deliveredTo,'');assert.equal(h.calls.length,0);
  h.turn={...h.turn,id:'followup',turnId:'next-turn',ended:false};h.request('next',{action:'read_workspace'});await driver.read();
  assert.equal(h.replies.length,1);assert.equal(h.run.events.find(e=>e.id==='later').deliveredTo,'next-turn');await driver.close();
});
test('stopping the whole workbench cancels a waiting reply without delivering events into the stopped native turn', async () => {
  const h=await managementScenario(),driver=h.connect();h.run.tasks.push({id:'B',status:'running',goal:'Pending child',attemptIds:[],inputs:[],reviews:[],dependsOn:[]});h.request('wait',{action:'wait'});
  await driver.read();await flush();await h.runner.stop();await flush();
  assert.equal(h.runner.waiters.size,0);assert.equal(h.replies.length,0);assert.equal(h.run.status,'stopping');
  assert.deepEqual(h.stops,[h.run.attempts[0].id]);await driver.close();
});
test('a stopping main Attempt collects its exact native terminal state after Cursor removes the first input bubble', async () => {
  const h=await managementScenario(),driver=h.connect();h.run.main.app='cursor';h.run.bindings[0].app='cursor';h.turn.generationId='native-generation';
  await driver.read();await flush();const attempt=h.run.attempts[0];await h.runner.stop();
  const call=h.agent.call,reads=[];let ended=false;
  h.turn={id:'',turnId:'',threadId:'main-thread',generationId:'native-generation',accepted:false,ended:false,error:'Cursor 原生执行已中断：user'};
  h.agent.call=async(context,code)=>{const{method,args}=nativeInvocation(code);if(method==='codexFusionTurn'&&args[0]){
    reads.push(args);assert.equal(args[0],attempt.native.messageId);assert.equal(args[3],attempt.native.generationId);
    return{...h.turn,id:attempt.native.messageId,turnId:attempt.native.turnId,current:true,ended,completed:false};
  }return call(context,code);};
  await driver.read();await flush();assert.equal(h.run.status,'stopping');assert.equal(attempt.endedAt,null);
  ended=true;await driver.read();await flush();assert.equal(h.run.status,'stopped');assert.equal(attempt.status,'stopped');
  assert(attempt.endedAt);assert.equal(attempt.result.completed,false);assert.match(attempt.result.error,/已中断/);
  const facts=structuredClone(attempt);await driver.read();await flush();assert.deepEqual(attempt,facts);
  assert.equal(reads.length,2);assert.equal(h.run.attempts.length,1);assert.equal(h.run.events.filter(e=>e.type==='user_input').length,1);
  assert.equal(h.calls.length,0);assert.deepEqual(h.stops,[attempt.id]);await driver.close();
});
test('stop terminal reads preserve native steering and do not inspect another Binding', async () => {
  const h=await managementScenario(),driver=h.connect();h.turn.generationId='native-generation';await driver.read();await flush();
  const attempt=h.run.attempts[0];attempt.status='stopping';
  const other={...structuredClone(attempt),id:'other-binding-attempt',bindingId:'other-binding',native:{threadId:'other-thread',turnId:'other-turn',messageId:'other-message'}};
  h.run.attempts.push(other);const before=structuredClone(other),call=h.agent.call,reads=[];
  h.turn={...h.turn,id:'steer-message',user:'Keep the new instruction'};
  h.agent.call=async(context,code)=>{const{method,args}=nativeInvocation(code);if(method==='codexFusionTurn'&&args[0]){
    reads.push(args[0]);return{...h.turn,id:attempt.native.messageId,turnId:attempt.native.turnId,ended:false};
  }return call(context,code);};
  await driver.read();await flush();assert.deepEqual(reads,['user-message']);assert.deepEqual(other,before);
  assert.equal(h.run.attempts.length,2);assert.equal(h.run.events.filter(e=>e.data.native?.messageId==='steer-message').length,1);
  assert.equal(attempt.native.messageId,'user-message');assert.equal(attempt.status,'stopping');assert.equal(h.calls.length,0);await driver.close();
});
test('plan revision and rejection never authorize dispatch and the replacement plan requires a new explicit decision', async () => {
  for(const decision of ['revise','reject']){
    const h=scenario(),workId=h.create(),planId=h.plan(workId,true).planId;
    assert.throws(()=>h.runner.confirm(planId,'revise',''),/修改/);
    h.runner.confirm(planId,decision,decision==='revise'?'只修改截图说明':'');
    const old=h.run.works[0].plans[0];assert.equal(old.confirmed,false);assert.equal(old.decision,decision);assert.equal(h.run.stopRequested,false);
    assert.throws(()=>h.apply({action:'dispatch',workId,tasks:[h.task('blocked')]}),/未确认/);
    const replacement=h.plan(workId,false);assert.equal(replacement.confirmed,false);assert.equal(old.decision,decision);
    assert.throws(()=>h.runner.confirm(planId,'confirm'),/已改变/);
    h.runner.confirm(replacement.planId,'confirm');h.apply({action:'dispatch',workId,tasks:[h.task('allowed')]});
    assert.equal(h.run.tasks.length,1);assert.equal(h.run.events[0].type,'plan_feedback');
  }
});
test('successful recovery clears the current block while preserving an ended native interruption', async () => {
  const h=scenario(),attempt={id:'historical-main',kind:'main',status:'failed',submission:'accepted',acceptedAt:5,endedAt:10,
    native:{threadId:'main-thread',turnId:'old-turn',messageId:'old-message'},result:{text:'',completed:false,error:'Codex interrupted'}};
  h.run.attempts.push(attempt);h.run.status='recovering';h.run.blockedReason=attempt.result.error;
  const before=structuredClone(attempt);
  await h.runner.recover();await flush();
  assert.equal(h.run.status,'waiting');assert.equal(h.run.blockedReason,'');
  assert.deepEqual(h.run.attempts[0],before);assert.equal(h.calls.length,0);assert.equal(h.run.events.length,0);
});
test('failed recovery remains blocked and does not erase the actual connection failure', async () => {
  const h=scenario();h.run.status='recovering';h.run.blockedReason='Old interruption';
  h.controller.start=async()=>{throw new Error('Native connection is still unavailable');};
  await h.runner.recover().catch(error=>h.runner.blockMain(error));await flush();
  assert.equal(h.run.status,'blocked');assert.equal(h.run.blockedReason,'Native connection is still unavailable');
  assert.equal(h.calls.length,0);assert.equal(h.run.attempts.length,0);
});
test('an unconfirmed native main turn stays unknown and blocked instead of clearing its error or resending', async () => {
  const h=scenario();h.run.status='recovering';h.run.blockedReason='Prior uncertainty';
  h.run.attempts.push({id:'unknown-main',kind:'main',origin:'user',status:'unknown',submission:'accepted',endedAt:null,
    native:{threadId:'main-thread',turnId:'unknown-turn',messageId:'unknown-message'}});
  h.agent.call=async()=>({id:''});h.controller.context={};
  await h.runner.recover();await flush();
  assert.equal(h.run.status,'blocked');assert.match(h.run.blockedReason,/无法确认/);
  assert.equal(h.run.attempts[0].status,'unknown');assert.equal(h.run.attempts[0].endedAt,null);
  assert.equal(h.calls.length,0);assert.equal(h.run.attempts.length,1);
});
test('reused Worker waits for its native result while independent work continues, including unknown-result recovery', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId); h.controller.idle = async () => false;
  await h.control({ action: 'dispatch', workId, tasks: [h.task('A')] }, h.native()); await flush();
  const first = h.run.tasks[0], attempt = h.run.attempts[0];
  await h.control({ action: 'dispatch', workId, tasks: [h.task('B'), h.task('C')], input: JSON.stringify({
    B: { workerId: first.workerId, reason: 'Continue the established analysis context', compared: [{ workerId: first.workerId, reason: 'Relevant original context' }] },
    C: { workerId: null, reason: 'Independent topic', compared: [{ workerId: first.workerId, reason: 'Different responsibility and independent parallel work' }] },
  }) }, h.native()); await flush();
  const started = () => h.calls.filter(row => row.kind === 'task').map(row => h.run.attempts.find(attempt => attempt.id === row.id).taskId);
  assert.deepEqual(started(), ['A', 'C']);
  h.pending.get(attempt.id).reject(new Error('Connection lost after native acceptance')); await flush();
  assert.equal(h.run.attempts[0].status, 'unknown'); h.scheduler.drain(); await flush(); assert.deepEqual(started(), ['A', 'C']);
  h.runner.completed(attempt.id, { completed: true, text: 'Recovered actual native result' }); h.scheduler.drain(); await flush();
  assert.deepEqual(started(), ['A', 'C', 'B']);
  for (const task of h.run.tasks.slice(1)) h.pending.get(task.attemptIds[0]).resolve({});
  await flush(); assert.equal(h.scheduler.workerSlots.size, 0);
  const workId2 = h.create(); h.plan(workId2);
  await h.control({ action: 'dispatch', workId: workId2, tasks: [h.task('return')], input: JSON.stringify({ return: {
    workerId: first.workerId, label: '既有分析复核', reason: 'Return to the original responsibility',
    compared: h.run.agents.map(row => ({ workerId: row.id, reason: row.id === first.workerId ? 'Owns the recovered evidence' : 'Independent topic' })),
  } }) }, h.native()); await flush();
  assert.equal(h.run.agents.length, 2); assert.equal(h.run.tasks.at(-1).workerId, first.workerId);
  assert.deepEqual(started(), ['A', 'C', 'B', 'return']);
  h.pending.get(h.run.tasks.at(-1).attemptIds[0]).resolve({}); await flush();
  assert.equal(h.scheduler.workerSlots.size, 0);
});
test('a same-software child delivers through a waiting tool without occupying a main software slot', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId);
  await h.control({action:'dispatch',workId,tasks:[h.task('B')]},h.native()); await flush();
  const native=h.native(),waiting=h.control({action:'wait'},native); await flush();
  assert.equal(h.runner.waiters.size,1); assert.equal(h.calls.length,1); assert.equal(h.calls[0].kind,'task');
  assert.equal(h.scheduler.mainSlots.size,0);
  h.pending.get(h.calls[0].id).resolve(); await flush();
  const reply=await waiting; assert.equal(reply.events.length,1); assert.equal(reply.events[0].data.taskId,'B');
  assert.equal(h.run.events[0].deliveredTo,''); h.runner.acknowledge(native,reply.events.map(e=>e.id));
  assert.equal(h.run.events[0].deliveredTo,native.turnId); assert.equal(h.calls.length,1);
});

test('detail reads keep event receipt semantics without rereading the global software capability index', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId); h.apply({ action: 'dispatch', workId, tasks: [h.task('A')] });
  let catalogs = 0;
  h.agent.softwareCapabilities = async () => { catalogs++; return [{ app: 'codex', connected: true }]; };
  fusionEvent(h.run, 'user_input', { workId, text: 'Preserve this exact instruction' }, 'one');
  const native = h.native(), overview = await h.control({ action: 'read_workspace' }, native); await flush();
  assert.equal(catalogs, 1); assert.equal(overview.events[0].data.text, 'Preserve this exact instruction');
  h.runner.acknowledge(native, overview.events.map(event => event.id));
  fusionEvent(h.run, 'user_input', { workId, text: 'New instruction after the overview' }, 'two');
  const detailNative = h.native(), detail = await h.control(overview.agents[0].read, detailNative);
  assert.equal(catalogs, 1); assert.equal(detail.agents.length, 1); assert.equal('apps' in detail, false);
  assert.deepEqual(detail.events.map(event => event.id), ['two']);
  h.runner.acknowledge(detailNative, detail.events.map(event => event.id));
  const protocol = await h.control(overview.protocol.read, h.native());
  assert.equal(catalogs, 1); assert.deepEqual(protocol.events, []);
  for (const value of h.pending.values()) value.resolve({}); await flush();
});
test('events during ordinary main work stay in the inbox and arrive together through the next actual tool', async () => {
  const h=scenario(); h.runner.wake(); await flush();
  const idle=await h.control({action:'wait'},h.native()); assert.deepEqual(idle.events,[]); assert.equal(h.runner.waiters.size,0);
  h.run.attempts.push({id:'ordinary-main',kind:'main',status:'running',native:{turnId:'native-turn'}});
  fusionEvent(h.run,'user_input',{text:'one'},'one'); h.runner.wake(); await flush();
  const native=h.native(),first=await h.control({action:'read_workspace'},native);
  fusionEvent(h.run,'task_result',{taskId:'B'},'two'); fusionEvent(h.run,'user_input',{text:'three'},'three');
  h.runner.acknowledge(native,first.events.map(e=>e.id));
  const next=await h.control({action:'read_workspace'},h.native()); assert.deepEqual(next.events.map(e=>e.id),['two','three']);
  assert.equal(h.calls.length,0); assert.equal(h.run.attempts.length,1); assert.equal(h.run.attempts[0].status,'running');
});

test('a completed child retains full evidence once and supplies compact references through an actual management tool', async () => {
  const h=scenario(),workId=h.create();h.plan(workId);
  await h.control({action:'dispatch',workId,tasks:[h.task('image')]},h.native());await flush();
  const child=h.calls[0],diff='diff --git a/image.png b/image.png\nGIT binary patch\nliteral 1000000\n'+'patch-data'.repeat(120000);
  h.pending.get(child.id).resolve({text:'截图已保存，待主 Agent 验收',changes:{available:true,diff}});await flush();
  const attempt=h.run.attempts[0],event=h.run.events[0];assert.equal(attempt.changes.diff,diff);assert.equal(attempt.status,'awaiting_review');
  assert.equal(event.data.changes,undefined);assert.equal(event.data.result,undefined);assert.equal(event.data.attemptId,child.id);
  h.runner.wake();await flush();assert.equal(h.calls.length,1);assert.equal(h.run.attempts.length,1);
  const native=h.native(),reply=await h.control({action:'read_workspace'},native);
  assert(JSON.stringify(reply.events).length<10000);assert(!JSON.stringify(reply.events).includes('patch-data'));
  const index=h.apply(reply.events[0].data.evidence.read);assert(index.attempts[0].changes.diff.files[0].header.includes('image.png'));
  assert.equal(event.deliveredTo,'');h.runner.acknowledge(native,reply.events.map(e=>e.id));assert.equal(event.deliveredTo,native.turnId);
  assert.equal(attempt.changes.diff,diff);assert.equal(h.run.tasks[0].status,'awaiting_review');
});

test('resuming a rejected oversized inbox preserves its facts and creates no replacement user message or main Attempt', async () => {
  const h=scenario(),workId=h.create();h.plan(workId);h.apply({action:'dispatch',workId,tasks:[h.task('image')]});
  const child=h.run.attempts[0];Object.assign(child,{status:'awaiting_review',endedAt:20,result:{text:'ready',completed:true},changes:{diff:'old-bytes'.repeat(120000)}});
  h.run.effects[0].status='done';fusionEvent(h.run,'task_result',{taskId:'image',attemptId:child.id,changes:child.changes},'old-result');
  const rejected={id:'rejected-inbox',kind:'main',origin:'events',status:'failed',endedAt:30,submission:'submitting',error:'Input exceeds maximum length',prompt:JSON.stringify(h.run.events),eventIds:['old-result']};
  h.run.attempts.push(rejected);h.run.status='blocked';const before=structuredClone(rejected);
  await h.runner.resume();await flush();assert.equal(h.calls.length,0);assert.equal(h.run.attempts.length,2);assert.deepEqual(rejected,before);
  const native=h.native(),reply=await h.control({action:'read_workspace'},native);
  assert(!JSON.stringify(reply.events).includes('old-bytes'));assert.equal(h.run.events[0].deliveredTo,'');
  h.runner.acknowledge(native,reply.events.map(e=>e.id));assert.equal(h.run.events[0].deliveredTo,native.turnId);
});

test('native management replies transmit evidence references through the existing tool fields and acknowledge only after reply', async t => {
  const { FusionController } = await import('../server/fusion/controller.mjs');
  const h = scenario(), workId = h.create(); h.plan(workId); h.run.status = 'blocked';
  h.apply({ action: 'dispatch', workId, tasks: [h.task('image')] }); h.run.effects[0].status = 'done';
  const child = h.run.attempts[0];
  Object.assign(child, { status: 'awaiting_review', endedAt: 20, result: { text: 'exact native reply', completed: true },
    changes: { diff: 'diff --git a/image.png b/image.png\nGIT binary patch\n' + 'binary-bytes'.repeat(100000) } });
  fusionEvent(h.run, 'task_result', { taskId: 'image', attemptId: child.id, changes: child.changes }, 'result-image');
  const savedLive = fusionLive.get('main');
  t.after(() => savedLive ? fusionLive.set('main', savedLive) : fusionLive.delete('main'));
  const driver = new FusionController(h.runner), replies = [];
  driver.context = { native: { threadId: 'main-thread' }, source: { readConversation: async () => ({ chat: { items: [] } }) } };
  let action = { action: 'read_workspace' }, release;
  h.agent.call = async (_context, code) => {
    const {method,args}=nativeInvocation(code);
    if (method === 'codexFusionTurn') return {};
    if (method === 'nativeSessionInfo'&&args[2]==='tools') return [{ id: 0, params: { threadId: 'main-thread', turnId: 'native-main', tool: 'ra_fusion', arguments: action } }];
    return new Function('nativeSessionAction', 'return ' + code)((app, threadId, operation, payload) => {
      assert.equal(app, 'codex'); assert.equal(threadId, 'main-thread'); assert.equal(operation, 'toolReply');
      replies.push(payload); return new Promise(resolve => { release = resolve; });
    });
  };
  const first = driver.read(); await flush();
  const reply = replies[0]; assert.equal(reply.result.success, true);
  assert(reply.result.contentItems[0].text.length < 10000); assert(!h.run.events[0].deliveredTo);
  const value = JSON.parse(reply.result.contentItems[0].text);
  action = value.events[0].data.evidence.read;
  // These fields are already registered on existing native main conversations.
  assert.deepEqual(Object.keys(action).sort(), ['action', 'attemptId', 'taskId']);
  release(true); await first; assert.equal(h.run.events[0].deliveredTo, 'native-main');
  const second = driver.read(); await flush(); release(true); await second;
  action = JSON.parse(replies[1].result.contentItems[0].text).attempts[0].result.text.read;
  assert.deepEqual(Object.keys(action).sort(), ['action', 'attemptId', 'input', 'taskId']);
  const third = driver.read(); await flush(); release(true); await third;
  assert.equal(JSON.parse(replies[2].result.contentItems[0].text).text, 'exact native reply');
  assert.equal(h.run.attempts.length, 1); assert.equal(child.status, 'awaiting_review'); assert.equal(h.calls.length, 0);
});
test('an unread event never blocks a successful ordinary main turn or triggers another model call', async () => {
  const h=scenario(),text='完整用户原文'.repeat(10000);fusionEvent(h.run,'user_input',{text},'unread-input');
  const main={id:'main',kind:'main',status:'running',acceptedAt:Date.now(),eventIds:['unread-input'],native:{turnId:'native-turn'}};h.run.attempts.push(main);
  await h.runner.mainEnded(main.id,{completed:true,text:'ordinary answer'});await flush();
  assert.equal(h.run.status,'waiting');assert.equal(h.run.blockedReason,'');assert.equal(h.run.events[0].deliveredTo,'');assert.equal(h.calls.length,0);
  assert.equal(h.run.attempts.length,1);assert.equal(h.run.attempts[0].result.completed,true);
  assert.equal(h.apply({action:'read_workspace'}).events[0].data.text,text);
});

test('dependent tasks wait for actual acceptance, not just generation completion', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId);
  h.run.status = 'blocked';
  await h.control({ action: 'dispatch', workId, tasks: [h.task('A'), h.task('B', 'cursor', ['A'])] }, h.native()); await flush();
  const first = h.calls[0]; h.pending.get(first.id).resolve(); await flush(); assert.equal(h.calls.length, 1);
  await h.control({ action: 'review', taskId: 'A', attemptId: first.id, verdict: 'accept', reason: 'verified',
    evidence: [{ criterion: 'A:1', detail: 'actual result', reference: 'native', attemptId: first.id }] }, h.native()); await flush();
  assert.equal(h.calls.length, 2); assert.equal(h.run.attempts.find(row => row.id === h.calls[1].id).taskId, 'B');
  h.pending.get(h.calls[1].id).resolve(); await flush();
});
test('stop cancels unsubmitted dependents and remains stopping until exact native execution ends', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId);
  await h.control({ action: 'dispatch', workId, tasks: [h.task('A'), h.task('B', 'cursor', ['A'])] }, h.native()); await flush();
  const first = h.calls[0]; await h.runner.stop(); await flush();
  assert.equal(h.run.status, 'stopping'); assert.deepEqual(h.stops, [first.id]); assert.equal(h.run.tasks[1].status, 'cancelled');
  h.pending.get(first.id).resolve({ stopped: true, completed: false }); await flush();
  assert.equal(h.run.status, 'stopped'); assert.equal(h.calls.length, 1);
});
test('stopping one work item leaves another work item and its actual native target alone', async () => {
  const h = scenario(), a = h.create(), b = h.create(); h.plan(a); h.plan(b);
  await h.control({ action: 'dispatch', workId: a, tasks: [h.task('A')] }, h.native());
  await h.control({ action: 'dispatch', workId: b, tasks: [h.task('B', 'cursor')] }, h.native()); await flush();
  await h.runner.stop({ workId: a }); assert.equal(h.run.stopRequested, false); assert.equal(h.stops.length, 1);
  const first = h.run.attempts.find(row => row.workId === a), second = h.run.attempts.find(row => row.workId === b);
  assert.equal(second.status, 'running'); assert.deepEqual(h.stops, [first.id]);
  h.run.status = 'blocked'; h.pending.get(first.id).resolve({ stopped: true }); h.pending.get(second.id).resolve(); await flush();
});
test('an unknown attempt prevents its own resubmission but leaves independent same-app work runnable during recovery', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId); h.run.status = 'blocked';
  await h.control({ action: 'dispatch', workId, tasks: [h.task('A')] }, h.native()); await flush();
  const id = h.calls[0].id; h.pending.get(id).reject(new Error('connection lost')); await flush();
  assert.equal(h.run.attempts[0].status, 'unknown');
  assert.throws(() => h.apply({ action: 'continue_task', taskId: 'A', input: 'again', cost: h.cost('codex') }), /结果未知/);
  await h.control({ action: 'dispatch', workId, tasks: [h.task('independent')] }, h.native()); await flush();
  const other = h.calls[1]; assert(other); assert.notEqual(other.id, id); assert(!other.recovering);
  h.run.events.forEach(event => { event.deliveredTo = 'known'; });
  await h.runner.resume(); await flush();
  assert.equal(h.calls[2].id, id); assert.equal(h.calls[2].recovering, true); assert.equal(h.run.attempts.length, 2);
  h.run.status = 'blocked'; h.pending.get(id).resolve(); h.pending.get(other.id).resolve(); await flush();
  assert.equal(h.runner.jobs.size, 0);
});
test('independent same-project writes run in parallel and report to their own tasks when completed out of order', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId); h.run.status = 'blocked';
  const one = { ...h.task('feature-a'), access: 'write', scope: ['feature-a'] };
  const two = { ...h.task('feature-b'), access: 'write', scope: ['feature-b'] };
  await h.control({ action: 'dispatch', workId, tasks: [one, two] }, h.native()); await flush();
  assert.equal(h.calls.length, 2);
  const [a, b] = h.calls; assert.notEqual(a.id, b.id);
  h.pending.get(b.id).resolve({ text: 'B evidence', changes: { files: ['feature-b'] } }); await flush();
  assert.equal(h.run.tasks[0].status, 'running'); assert.equal(h.run.tasks[1].status, 'awaiting_review');
  h.pending.get(a.id).resolve({ text: 'A evidence', changes: { files: ['feature-a'] } }); await flush();
  assert.equal(h.run.attempts.find(row => row.id === a.id).result.text, 'A evidence');
  assert.equal(h.run.attempts.find(row => row.id === b.id).result.text, 'B evidence');
  assert.deepEqual(h.run.events.map(event => event.data.taskId), ['feature-b', 'feature-a']);
  assert.equal(h.runner.jobs.size, 0);
});
test('parallel unknown native turns recover together without submitting new Attempts', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId); h.run.status = 'blocked';
  await h.control({ action: 'dispatch', workId, tasks: [h.task('A'), h.task('B')] }, h.native()); await flush();
  const ids = h.calls.map(call => call.id); assert.equal(ids.length, 2);
  for (const id of ids) h.pending.get(id).reject(new Error('connection lost'));
  await flush(); assert(h.run.attempts.every(attempt => attempt.status === 'unknown'));
  h.run.events.forEach(event => { event.deliveredTo = 'already-read'; });
  await h.runner.resume(); await flush();
  assert.deepEqual(h.calls.slice(2).map(call => call.id), ids); assert(h.calls.slice(2).every(call => call.recovering));
  assert.equal(h.run.attempts.length, 2);
  h.run.status = 'blocked'; for (const id of ids) h.pending.get(id).resolve(); await flush();
  assert(h.run.attempts.every(attempt => attempt.status === 'awaiting_review')); assert.equal(h.runner.jobs.size, 0);
});
test('ordinary main execution needs no workbench commands, cost reservation, self Task or Assignment', async () => {
  const h=scenario();const main={id:'main-round',kind:'main',origin:'user',status:'running',acceptedAt:Date.now(),bindingId:'main',native:{threadId:'main-thread',turnId:'native-turn',messageId:'main-input'}};
  h.run.attempts.push(main);fs.writeFileSync(h.project.root+'/main-file','ordinary main edit');
  await h.runner.mainEnded(main.id,{completed:true,text:'native work complete'});await flush();
  assert.equal(h.run.works.length,0);assert.equal(h.run.commands.length,0);assert.equal(h.run.tasks.length,0);
  assert.equal(h.run.assignments.length,0);assert.equal(h.run.agents.length,0);assert.equal(h.run.attempts.length,1);
  assert.equal(h.run.attempts[0].status,'ended');assert.equal(h.run.status,'waiting');assert.equal(h.calls.length,0);
});

test('stopping direct main work targets its actual round, preserves unrelated work and waits for native confirmation', async () => {
  const h = scenario(), workId = h.create(), other = h.create(); h.plan(workId); h.plan(other);
  const attempt = { id: 'main-round', kind: 'main', status: 'running', acceptedAt: Date.now(), workExecutions: [{workId}],
    native: { threadId: 'main-thread', turnId: 'main-native', messageId: 'user' } };
  h.run.attempts.push(attempt);
  await h.runner.stop({ workId }); assert.deepEqual(h.stops, ['main-round']);
  assert.equal(h.run.works[0].status, 'stopping'); assert.equal(h.run.works[1].status, 'running');
  assert.equal(h.run.tasks.length, 0); assert.equal(attempt.status, 'stopping');
  await h.runner.mainEnded(attempt.id, { completed: false, error: 'native interrupted' }); h.runner.finishStop();
  assert.equal(h.run.works[0].status, 'stopped'); assert.equal(h.run.works[1].status, 'running');
});
test('stopping parallel same-app tasks waits for each exact target and cancels only the unsubmitted dependency', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId);
  await h.control({ action: 'dispatch', workId, tasks: [h.task('A'), h.task('dependent', 'codex', ['A']), h.task('B')] }, h.native()); await flush();
  assert.equal(h.calls.length, 2); const [one, two] = h.calls;
  await h.runner.stop(); assert.deepEqual(h.stops, [one.id, two.id]); assert.equal(h.run.status, 'stopping');
  assert.equal(h.run.tasks[1].status, 'cancelled');
  h.pending.get(two.id).resolve({ stopped: true, completed: false }); await flush(); assert.equal(h.run.status, 'stopping');
  h.pending.get(one.id).resolve({ stopped: true, completed: false }); await flush(); assert.equal(h.run.status, 'stopped');
  assert.equal(h.calls.length, 2);
});
test('recovery settles a stopped run with ended native facts without reconnecting its closed window', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId);
  h.run.stopRequested = true; h.run.status = 'stopping'; h.run.works[0].status = 'stopping';
  h.run.attempts.push({ id: 'ended-native', kind: 'main', workId, bindingId: 'main', status: 'ended',
    submission: 'accepted', acceptedAt: 10, endedAt: 20,
    native: { threadId: 'main-thread', turnId: 'ended-turn', messageId: 'ended-message' },
    result: { text: 'Recorded result', completed: true } });
  fusionEvent(h.run, 'task_result', { attemptId: 'ended-native' }, 'unread-result');
  const facts = structuredClone({ attempts: h.run.attempts, events: h.run.events });
  h.controller.start = async () => assert.fail('closed window must not be reconnected');
  await h.runner.recover(); await flush();
  assert.equal(h.run.status, 'stopped'); assert.equal(h.run.works[0].status, 'stopped');
  assert.deepEqual({ attempts: h.run.attempts, events: h.run.events }, facts);
  assert.equal(h.calls.length, 0); assert.equal(h.scheduler.queue.length, 0);
});
test('recovery still reconciles unknown or running native executions before confirming stop', async () => {
  for (const status of ['unknown', 'running']) {
    const h = scenario(); h.run.stopRequested = true; h.run.status = 'stopping';
    h.run.attempts.push({ id: 'unsettled-native', kind: 'main', bindingId: 'main', status,
      submission: 'accepted', acceptedAt: 10, endedAt: null,
      native: { threadId: 'main-thread', turnId: 'unsettled-turn', messageId: 'unsettled-message' } });
    const facts = structuredClone(h.run.attempts); let connects = 0;
    h.controller.start = async () => { connects++; throw new Error('Native window is closed'); };
    await h.runner.recover().catch(error => h.runner.blockMain(error)); await flush();
    assert.equal(connects, 1); assert.equal(h.run.status, 'stopping');
    assert.deepEqual(h.run.attempts, facts); assert.equal(h.calls.length, 0);
  }
});
test('resuming preserves individually stopped work and keeps new user input for the next native tool', async () => {
  const h=scenario(),workId=h.create();h.plan(workId);await h.runner.stop({workId});await h.runner.stop();
  h.runner.input({text:'Independent new request; leave the old work stopped',requestId:'new-work-input'});
  await h.runner.resume();await flush();assert.equal(h.run.stopRequested,false);assert.equal(h.run.works[0].status,'stopped');assert.equal(h.calls.length,0);
  await assert.rejects(h.control({action:'finish',workId,summary:'Old work must remain stopped',evidence:[{criterion:'C1',detail:'Prior evidence',reference:'main-turn:native-turn'}]},h.native()),/该工作项已停止/);
  const reply=await h.control({action:'create_work',title:'New work',goal:'New request'},h.native());
  assert.notEqual(reply.workId,workId);assert.equal(reply.events[0].id,'new-work-input');assert.equal(h.run.works[0].status,'stopped');assert.equal(h.run.attempts.length,0);
});

test('a delivery candidate becomes complete only after its native main turn ends and no new work input arrived', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId);
  const main = { id: 'main-end', kind: 'main', status: 'running', acceptedAt: Date.now(), native: { turnId: 'native-turn' } }; h.run.attempts.push(main);
  h.apply({ action: 'finish', workId, summary: 'ready', evidence: [{ criterion: 'C1', detail: 'native answer', reference: 'main-turn:native-turn' }] });
  assert.equal(h.run.works[0].status, 'closing');
  await h.runner.mainEnded(main.id, { text: 'answer', completed: true }); assert.equal(h.run.works[0].status, 'completed');
  const other = scenario(), work = other.create(); other.plan(work); other.run.status = 'blocked'; other.run.attempts.push({ ...main, endedAt: null });
  other.apply({ action: 'finish', workId: work, summary: 'ready', evidence: [{ criterion: 'C1', detail: 'native answer', reference: 'main-turn:native-turn' }] });
  fusionEvent(other.run, 'user_input', { workId: work, text: 'new requirement' });
  await other.runner.mainEnded(main.id, { text: 'answer', completed: true }); assert.equal(other.run.works[0].status, 'running');
  other.run.status = 'blocked'; await flush();
});
test('a question answer has an explicit work/task relationship and duplicate phone input does not redeliver', () => {
  const h = scenario(), workId = h.create(); h.plan(workId); h.run.status = 'blocked';
  const question = h.apply({ action: 'ask_user', workId, question: 'Which scope?' });
  const input = { requestId: 'phone-answer', workId, questionId: question.questionId, text: 'this project' };
  h.runner.input(input); h.runner.input(input);
  assert.equal(h.run.events.filter(event => event.id === input.requestId).length, 1);
  assert.equal(h.run.questions[0].answer, 'this project');
});
test('new inbox input keeps its actual main binding and waits for a native tool without touching desktop selection', async () => {
  const h=scenario(),binding=structuredClone(h.run.main);h.runner.input({text:'new request',requestId:'input-new'});await flush();
  assert.equal(h.calls.length,0);assert.equal(h.run.attempts.length,0);assert.equal(h.run.works.length,0);assert.deepEqual(h.run.main,binding);
  const value=await h.control({action:'read_workspace'},h.native());assert.equal(value.events[0].id,'input-new');assert.equal(value.events[0].data.text,'new request');
});

test('cancelling a dependency-blocked task removes its software queue entry', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId); h.run.status = 'blocked';
  await h.control({ action: 'dispatch', workId, tasks: [h.task('A'), h.task('B', 'cursor', ['A'])] }, h.native()); await flush();
  await h.control({ action: 'cancel_task', taskId: 'B', reason: 'no longer needed' }, h.native()); await flush();
  assert.equal(h.scheduler.queue.length, 0); assert.equal(h.run.tasks[1].status, 'cancelled');
  assert.equal(h.run.effects.find(row => row.data.attemptId === h.run.attempts[1].id).status, 'cancelled');
  h.pending.get(h.calls[0].id).resolve(); await flush();
});
test('the controller observer does not finish a native event attempt owned by the execution observer', async () => {
  const { FusionController } = await import('../server/fusion/controller.mjs');
  const h = scenario(), attempt = { id: 'event-main', kind: 'main', origin: 'events', bindingId: 'main', status: 'running',
    acceptedAt: 1, endedAt: null, native: { turnId: 'native-event', threadId: 'main-thread', messageId: 'message' } };
  h.run.attempts.push(attempt);
  const turn = { id: 'message', threadId: 'main-thread', turnId: 'native-event', accepted: true, ended: true, completed: true, text: 'done' };
  const driver = new FusionController(h.runner); let ended = 0;
  const original = h.runner.mainEnded.bind(h.runner); h.runner.mainEnded = (...args) => { ended++; return original(...args); };
  driver.context = { native: { threadId: 'main-thread' }, source: { readConversation: async () => ({ state: { run: { status: 'completed' } }, chat: { items: [] } }) } };
  h.agent.call = async (_context, code) => nativeInvocation(code).method === 'codexFusionTurn' ? turn : [];
  await driver.read(); assert.equal(ended, 0); assert.equal(attempt.status, 'running'); assert.equal(attempt.endedAt, null);
  await h.runner.mainEnded(attempt.id, turn); assert.equal(ended, 1); assert.equal(attempt.status, 'ended'); assert(attempt.endedAt);
});
test('priority changes reorder dependency-blocked tasks when they become ready', async () => {
  const h = scenario(), workId = h.create(); h.plan(workId); h.run.status = 'blocked';
  await h.control({ action: 'dispatch', workId, tasks: [h.task('A'), h.task('B', 'cursor', ['A']), h.task('C', 'cursor', ['A'])] }, h.native()); await flush();
  await h.control({ action: 'set_priority', taskId: 'C', priority: 10 }, h.native());
  const first = h.calls[0]; h.pending.get(first.id).resolve(); await flush();
  await h.control({ action: 'review', taskId: 'A', attemptId: first.id, verdict: 'accept', reason: 'verified',
    evidence: [{ criterion: 'A:1', detail: 'actual', reference: 'native', attemptId: first.id }] }, h.native()); await flush();
  assert.equal(h.run.attempts.find(row => row.id === h.calls[1].id).taskId, 'C');
  h.pending.get(h.calls[1].id).resolve(); await flush(); h.pending.get(h.calls[2].id).resolve(); await flush();
});

test('management handles the current native request and call identity without reading transcript content', async () => {
  const { FusionController } = await import('../server/fusion/controller.mjs');
  const h = scenario(); h.run.status = 'blocked'; h.controller.idle = async () => false;
  const requests = [{ id: 0, params: { threadId: 'main-thread', turnId: 'current-turn', callId: 'actual-call',
    tool: 'ra_fusion', arguments: { action: 'create_work', title: 'current', goal: 'current' } } }];
  let replies = 0, contentReads = 0;
  h.agent.call = async (_ctx, code) => {
    const {method,args}=nativeInvocation(code);
    if (method === 'codexFusionTurn') return { id: 'current-message', threadId: 'main-thread', turnId: 'current-turn', accepted: true, ended: false };
    if (method === 'nativeSessionInfo'&&args[2]==='tools') return requests;
    if (method === 'nativeSessionInfo'&&args[2]==='settings') return { model: 'cheap', effort: 'low' };
    if (method === 'nativeSessionAction'&&args[2]==='toolReply') { replies++; return true; }
    throw Error(code);
  };
  const driver = new FusionController(h.runner);
  driver.context = { native: { threadId: 'main-thread' }, source: { readConversation() { contentReads++; throw Error('Body not ready'); } } };
  await driver.read(); assert.equal(contentReads, 0); assert.equal(replies, 1);
  const command = h.run.commands.at(-1); assert.equal(command.native.callId, 'actual-call'); assert.equal(command.native.requestId, 0);
  assert.equal(h.run.tasks.length, 0); assert.equal(h.run.works.length, 1); assert.equal(h.calls.length, 0);
  await driver.read(); assert.equal(h.run.works.length, 1); assert.equal(h.run.commands.length, 1);
});
