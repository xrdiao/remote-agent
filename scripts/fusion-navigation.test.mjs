import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function fixture(stored = new Map()) {
  const sent = [], listeners = new Map(), nodes = new Map();
  const classes = { contains: () => false, toggle() {}, remove() {} };
  const node = () => ({ dataset: {}, classList: classes, scrollTop: 0, querySelector: () => null, querySelectorAll: () => [], contains: () => true });
  const entries = ['computer-one', 'computer-two'].map(id => ({ id, name: id, c: { key: id } }));
  const context = vm.createContext({ crypto, Map, Set, Date, Object, JSON,
    MutationObserver: class { observe() {} }, $: id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
    window: { addEventListener() {} }, mode: 'chat', currentApp: 'codex',
    ovSeg: () => '<span class="ov-seg"></span>', ovT: value => value, ovOpenFeedback: () => '', ovOpenLabel: (_target, label) => label, releaseFusionView() {}, ovCancelOpening() {},
    store: { get: key => stored.get(key), set: (key, value) => stored.set(key, value) }, I18N: { tr: value => value }, esc: value => String(value || ''),
    document: { body: { classList: classes }, addEventListener: (event, listener) => listeners.set(event, [...listeners.get(event) || [], listener]) },
    ovList: entries, ovS: { comp: null, level: 'fusion' }, OV_AGENT: { cursor: 'Cursor' },
    ovComputerStatus: () => 'online', status() {}, ovSaveHistory() {},
    computerSockets: new Map(entries.map(entry => [entry.id, { authed: true, socket: { readyState: 1, send: raw => sent.push(JSON.parse(raw)) } }])),
  });
  const history = fs.readFileSync(new URL('../app/js/history.js', import.meta.url), 'utf8');
  vm.runInContext(history.slice(history.indexOf('const questionFieldValue ='), history.indexOf('function clearQuestionDraft(')), context);
  vm.runInContext(fs.readFileSync(new URL('../app/js/fusion.js', import.meta.url), 'utf8'), context);
  const overview = fs.readFileSync(new URL('../app/js/overview.js', import.meta.url), 'utf8');
  vm.runInContext(overview.slice(overview.indexOf('const ovAg ='), overview.indexOf('const ovText =')), context);
  return { context, sent, stored, nodes, listeners, run: code => vm.runInContext(code, context) };
}
function resultFixture(stored) {
  const h = fixture(stored);
  h.context.testRun = { id: 'same-id', computer: 'computer-one', title: 'Completed workbench', project: { name: 'project-one' },
    main: { app: 'cursor', bindingId: 'main', target: { computer: 'computer-one', win: 'cursor:window-one', windowId: 'cursor:window-one', threadId: 'native-main' } }, status: 'waiting', works: { total: 1, done: 1 }, tasks: { total: 5, done: 5, running: 0 },
    overview: { state: 'done', resultKey: 'ended-one', apps: ['cursor'], counts: { done: 5 }, attention: [], current: null } };
  Object.assign(h.context, { authed: true, windowReady: true, navigationPending: null, chatStale: false, lastChat: { thread: 'native-main' },
    currentComputer: () => ({ id: 'computer-one', threadId: 'native-main' }), ovRender() {} });
  h.context.document.visibilityState = 'visible';
  h.context.document.body.classList.contains = name => name === 'conv';
  h.run(`activeFusionController=testRun;fusionViewOwner={surface:'strip'};
    conversationVisible=()=>document.visibilityState==='visible'&&document.body.classList.contains('conv');
    fusionWorkspaces.set('computer-one',{runs:[testRun]})`);
  h.emit = name => { for (const listener of h.listeners.get(name) || []) listener({}); };
  return h;
}

test('only a visible ready Fusion main acknowledges its ended result without changing actual status or task progress', () => {
  const h = resultFixture(), original = JSON.stringify(h.context.testRun);
  assert.match(h.run('fusionBoard()'), /ov-st-done/); assert.equal(h.stored.size, 0);
  h.emit('window-ready');
  assert.equal(h.run('fusionOverviewState(testRun)'), 'idle');
  const html = h.run('fusionBoard()'); assert.match(html, /ov-st-idle/); assert.match(html, /空闲/);
  assert.doesNotMatch(html, /fusion-stat fusion-tone-done|ov-st-done/);
  assert.match(html, /5<small>\/5/); assert.equal(JSON.stringify(h.context.testRun), original);
  assert.equal(h.sent.length, 0);
  const saved = h.stored.get('fusion-result-seen'); h.emit('window-ready'); assert.equal(h.stored.get('fusion-result-seen'), saved);
  const overview = fs.readFileSync(new URL('../app/js/overview.js', import.meta.url), 'utf8');
  vm.runInContext(overview.slice(overview.indexOf('const OV_EN ='), overview.indexOf('const OV_ICON =')), h.context);
  h.context.I18N.lang = 'en'; assert.match(h.run('fusionBoard()'), /<span class="ov-badge">Idle<\/span>/);
});
test('Fusion opening failures cancelled navigation cached previews and other targets cannot clear result notices', () => {
  for (const state of [ { windowReady: false }, { navigationPending: { id: 'opening' } }, { authed: false },
    { chatStale: true }, { lastChat: { thread: 'old-native' } },
    { currentComputer: () => ({ id: 'computer-two', threadId: 'native-main' }) } ]) {
    const h = resultFixture(); Object.assign(h.context, state); h.emit('window-ready');
    assert.equal(h.run('fusionOverviewState(testRun)'), 'done'); assert.equal(h.stored.size, 0);
  }
  const h = resultFixture(); h.context.document.body.classList.contains = () => false;
  h.emit('window-ready'); h.emit('visibilitychange'); h.run('fusionBoard();refreshFusionWorkspace()');
  assert.equal(h.stored.size, 0);
  h.context.document.body.classList.contains = name => name === 'conv'; h.context.document.visibilityState = 'hidden';
  h.emit('window-ready'); assert.equal(h.stored.size, 0);
  h.context.document.visibilityState = 'visible'; h.emit('visibilitychange'); assert.equal(h.run('fusionOverviewState(testRun)'), 'idle');
});
test('Fusion ended-result reads survive reload and do not swallow a new result or another computer or workbench', () => {
  const h = resultFixture(); h.emit('window-ready');
  const reload = resultFixture(h.stored); assert.equal(reload.run('fusionOverviewState(testRun)'), 'idle');
  reload.run('testRun.updated=100;testRun.revision=10'); assert.equal(reload.run('fusionOverviewState(testRun)'), 'idle');
  reload.context.testRun.overview.resultKey = 'ended-two';
  assert.equal(reload.run('fusionOverviewState(testRun)'), 'done');
  assert.equal(reload.run("fusionOverviewState({...testRun,computer:'computer-two',overview:{...testRun.overview,resultKey:'ended-one'}})"), 'done');
  assert.equal(reload.run("fusionOverviewState({...testRun,id:'other-run',overview:{...testRun.overview,resultKey:'ended-one'}})"), 'done');
  reload.emit('window-ready'); assert.equal(reload.run('fusionOverviewState(testRun)'), 'idle');
  assert.equal(h.sent.length + reload.sent.length, 0);
});
test('Fusion blocked-result reads clear only the home notice and required interactions retain their actual presentation', () => {
  const h = resultFixture(); Object.assign(h.context.testRun, { status: 'blocked', blockedReason: 'Exact stopped execution reason' });
  Object.assign(h.context.testRun.overview, { state: 'err', resultKey: 'failed-one', current: { text: 'Failed task', status: 'failed' } });
  const original = JSON.stringify(h.context.testRun); assert.match(h.run('fusionBoard()'), /ov-st-err/);
  h.emit('window-ready'); assert.equal(h.run('fusionOverviewState(testRun)'), 'idle');
  const html = h.run('fusionBoard()'); assert.doesNotMatch(html, /ov-st-err|fusion-tone-err|Exact stopped execution reason/);
  assert.match(html, /project-one/); assert.equal(JSON.stringify(h.context.testRun), original);
  for (const state of ['run','wait','err']) {
    Object.assign(h.context.testRun.overview, { state, resultKey: '' });
    h.emit('window-ready'); assert.equal(h.run('fusionOverviewState(testRun)'), state);
  }
});

test('only recorded internal user-input identities are omitted from the matching Fusion main display', () => {
  const h=fixture();h.context.testRun={internalInputs:[{threadId:'native-main',messageId:'event-message'},{threadId:'other-thread',messageId:'other-message'}]};
  h.context.currentComputer=()=>({threadId:'native-main'});
  h.context.testItems=[{i:'internal',k:'human',nativeIds:['event-message'],t:'Fusion notice'},
    {i:'actual-user',k:'human',nativeIds:['actual-user'],t:'Fusion notice'},
    {i:'other',k:'human',nativeIds:['other-message']},{i:'reply',k:'assistant',nativeIds:['event-message']}];
  h.run('currentFusionRun=()=>testRun;fusionChatActive=()=>true');
  const ids=h.run('fusionVisibleItems(testItems).map(item=>item.i)');assert.deepEqual([...ids],['actual-user','other','reply']);
  assert.equal(h.context.testItems.length,4);
  h.run('fusionChatActive=()=>false');assert.equal(h.run('fusionVisibleItems(testItems)'),h.context.testItems);
});

test('opening the Fusion workspace reads each scoped computer without attaching or creating a native session', () => {
  const h = fixture(); h.run('refreshFusionWorkspace()');
  assert.deepEqual(h.sent.map(message => [message.computer, message.t]), [['computer-one', 'fusionWorkspace'], ['computer-two', 'fusionWorkspace']]);
  h.sent.length = 0; h.run("ovS.comp = 'computer-two'; refreshFusionWorkspace()");
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].computer, 'computer-two');
  assert.deepEqual([...h.stored.keys()], []);
});

test('switching to Fusion preserves the overview computer scope and only requests state', () => {
  const h = fixture(), source = fs.readFileSync(new URL('../app/js/overview.js', import.meta.url), 'utf8');
  Object.assign(h.context, { ovClearBatch() {}, ovSaveHistory() {}, ovHistory: () => ({}), ovRender() {},
    history: { state: {}, replaceState() {} } });
  vm.runInContext(source.slice(source.indexOf('function ovMove('), source.indexOf('function ovCloseCard(')), h.context);
  h.run("ovS.comp = 'computer-two'; ovMove({ level:'fusion', proj:null, open:null })");
  assert.equal(h.context.ovS.comp, 'computer-two'); assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].t, 'fusionWorkspace');
});

test('a reconnected Fusion workspace reads only the authenticated computer within the retained scope', () => {
  const h = fixture();
  h.run("ovS.comp='computer-one';receiveFusion({t:'auth'},{authed:true,computer:{id:'computer-two'}})");
  assert.equal(h.sent.length, 0);
  h.run("receiveFusion({t:'auth'},{authed:true,computer:{id:'computer-one'}})");
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].t, 'fusionWorkspace');
  assert.equal(h.sent[0].computer, 'computer-one');
});

function viewFixture() {
  const h = fixture(), painted = [], opened = [], sheet = { dataset: {}, classList: { contains: () => false }, scrollTop: 0, querySelector: () => null, querySelectorAll: () => [], contains: () => true };
  Object.assign(h.context, { $: () => sheet, sheetKind: '', currentComputer: () => ({ id: 'computer-one' }), currentApp: 'codex',
    openSheet: kind => { h.context.sheetKind = kind; }, closeSheet: () => { h.context.sheetKind = ''; },
    ovRender() {}, ovOpen: target => opened.push(target), updateTitle() {},
    showFusionConfig: run => painted.push(['config', run.id]), showFusionTasks: run => painted.push(['tasks', run.id]),
    showFusionTask: (run, id) => painted.push(['task', run.id, id]),
  });
  const reply = (request, run) => h.context.receiveFusion({ t: 'fusionState', computer: request.computer, runId: request.runId,
    requestId: request.requestId, view: { kind: request.view, subscriptionId: request.requestId, taskId: request.taskId }, run },
  { authed: true, computer: { id: request.computer } });
  return { ...h, painted, opened, sheet, reply };
}
test('task-strip clicks use the actual workbench and computer rather than the composite scroll key', () => {
  const h = fixture();
  Object.assign(h.context, { currentComputer: () => ({id:'computer-one'}), sheetKind:'',
    openSheet: kind => {h.context.sheetKind=kind;} });
  h.run("activeFusionController={id:'actual-run',computer:'computer-two',tasks:{total:0}};");
  const strip=h.context.$('fusionTaskStrip');strip.scrollLeft=0;strip.getBoundingClientRect=()=>({left:0});
  h.run('paintFusionTaskStrip()');
  assert.equal(strip.dataset.fusionScroll,'computer-two|actual-run');
  assert.equal(strip.dataset.fusionRun,'actual-run');assert.equal(strip.dataset.fusionComputer,'computer-two');
  const button={disabled:false,dataset:{fusionRelations:'selected-task'},closest:()=>strip};
  for(const listener of h.listeners.get('click'))listener({target:{closest:()=>button}});
  const reads=h.sent.filter(message=>message.t==='fusionRead'&&message.view==='tasks');
  assert.equal(reads.length,1);assert.equal(reads[0].runId,'actual-run');assert.equal(reads[0].computer,'computer-two');
  assert.equal(h.sent.some(message=>message.t==='attach'||message.t==='send'||message.t==='fusionContent'),false);
});

test('late detail responses cache their own view without reopening it over a newer view', () => {
  const h = viewFixture();
  h.run("readFusionView('computer-one','a','config')"); const a = h.sent.at(-1);
  h.run("readFusionView('computer-one','b','tasks')"); const b = h.sent.at(-1);
  assert.equal(h.sent[1].view, 'close'); assert.equal(h.sent[1].subscriptionId, a.requestId);
  h.reply(a, { id: 'a' }); assert.deepEqual(h.painted, []);
  h.reply(b, { id: 'b' }); assert.deepEqual(h.painted, [['tasks', 'b']]);
  h.run('releaseFusionView();closeSheet()');
  h.reply(b, { id: 'b' }); assert.deepEqual(h.painted, [['tasks', 'b']]);
  assert.equal(h.sent.at(-1).view, 'close');
});
test('primary view reads carry explicit task and input identities and retain separate cache entries', () => {
  const h = viewFixture();
  h.run("readFusionView('computer-one','r','task',{taskId:'t1'})"); const task = h.sent.at(-1);
  h.reply(task, { id: 'r', bindings: [] }); assert.deepEqual(h.painted, [['task', 'r', 't1']]);
  h.run("readFusionView('computer-one','r','input',{taskId:'t2',workId:'w',questionId:'q'})"); const input = h.sent.at(-1);
  assert.equal(input.view, 'input'); assert.equal(input.taskId, 't2'); assert.equal(input.questionId, 'q');
  assert.equal(h.run('fusionStates.size'), 1);
  assert.equal(h.run("fusionRunFor('computer-one','r')"), undefined);
});
test('opening a task uses only its summary; expanding the dialogue performs the first content read once', () => {
  const h = viewFixture();
  h.run("readFusionView('computer-one','r','task',{taskId:'t1'})"); const request = h.sent.at(-1);
  h.reply(request, { id: 'r', bindings: [{ id: 'selected-binding' }] });
  assert.equal(h.sent.filter(row => row.t === 'fusionContent').length, 0);
  const detail = { open: true, dataset: { fusionDialogue: '', binding: 'selected-binding', attempt: 'attempt-2' } };
  h.context.fusionFillDialogue = () => {};
  for (const listener of h.listeners.get('toggle')) listener({ target: detail });
  const reads = h.sent.filter(row => row.t === 'fusionContent');
  assert.equal(reads.length, 1); assert.equal(reads[0].bindingId, 'selected-binding'); assert.equal(reads[0].runId, 'r');
  for (const listener of h.listeners.get('toggle')) listener({ target: detail });
  assert.equal(h.sent.filter(row => row.t === 'fusionContent').length, 1);
});
test('input audits are explicit reads and a late audit cannot reopen a closed task view', () => {
  const h = viewFixture();
  h.run("readFusionView('computer-one','r','task',{taskId:'t1'})"); const request = h.sent.at(-1);
  h.reply(request, { id: 'r', bindings: [] });
  const detail = { open: true, dataset: { fusionAudit: JSON.stringify({ kind: 'inputs', taskId: 't1' }) }, querySelector: () => ({}) };
  for (const listener of h.listeners.get('toggle')) listener({ target: detail });
  const audit = h.sent.at(-1); assert.equal(audit.view, 'inputs'); assert.equal(audit.taskId, 't1');
  h.run('releaseFusionView();closeSheet()');
  h.reply(audit, { inputs: [], assignments: [] });
  assert.equal(h.run('fusionAudits.size'), 0); assert.equal(h.context.sheetKind, '');
});
test('native main-conversation controls submit only their own Attempt and card fields when two requests coexist', () => {
  const h = viewFixture();
  h.sheet.querySelectorAll = () => assert.fail('native fields must come from their own main card');
  const cards = ['first','second'].map(name => ({ dataset: { fusionComputer:'computer-one',fusionRun:'r' },
    querySelectorAll: () => [{dataset:{nativeRequest:'approval',fusionField:'0'},value:name+' draft'},
      {dataset:{nativeRequest:'unrelated',fusionField:'0'},value:'foreign draft'}] }));
  for (const [index, card] of cards.entries()) {
    const name = index ? 'second' : 'first';
    const button = {dataset:{fusionNative:'codexRequest',attempt:name+'-attempt',binding:name+'-binding',nativeRequest:'approval',n:'1'},
      closest: () => card};
    for (const listener of h.listeners.get('click')) listener({target:{closest:()=>button}});
    const message=h.sent.at(-1);
    assert.equal(message.t,'fusionNative');assert.equal(message.runId,'r');assert.equal(message.attemptId,name+'-attempt');
    assert.equal(message.action.bindingId,name+'-binding');
    assert.deepEqual(JSON.parse(JSON.stringify(message.action.fields)),[{n:0,value:name+' draft'}]);
  }
  assert.equal(h.sent.filter(row=>row.t==='fusionNative').length,2);
  assert.equal(h.sent.some(row=>row.t==='click'||row.t==='send'),false);
});

test('reconnection restores only the still-open detail subscription on its own computer', () => {
  const h = viewFixture();
  h.run("readFusionView('computer-one','r','task',{taskId:'t1'})"); const task = h.sent.at(-1); h.sent.length = 0;
  h.run("receiveFusion({t:'auth'},{authed:true,computer:{id:'computer-two'}})");
  assert.equal(h.sent.some(m => m.t === 'fusionRead'), false);
  h.run("receiveFusion({t:'auth'},{authed:true,computer:{id:'computer-one'}})");
  const restored = h.sent.filter(m => m.t === 'fusionRead');
  assert.equal(restored.length, 1); assert.equal(restored[0].requestId, task.requestId); assert.equal(restored[0].taskId, 't1');
  h.run('releaseFusionView();closeSheet()'); h.sent.length = 0;
  h.run("receiveFusion({t:'auth'},{authed:true,computer:{id:'computer-one'}})");
  assert.equal(h.sent.some(m => m.t === 'fusionRead'), false);
});

test('Fusion controller targets preserve native application, window, thread and project identities', () => {
  const owner = fs.readFileSync(new URL('../server/fusion/owner.mjs', import.meta.url), 'utf8');
  const context = vm.createContext({ fusionSummary: run => ({ id: run.id }), NATIVE_UNSETTLED: [] });
  vm.runInContext(owner.slice(owner.indexOf('function controllerView('), owner.indexOf('export function fusionControllerView(')), context);
  for (const app of ['codex', 'cursor', 'devin']) {
    const binding = { id: 'main-binding', app, windowId: 'native-window', threadId: 'native-thread',
      host: 'ssh-host', project: { root: '/project' } };
    const run = { id: 'workbench', computer: 'computer-two', status: 'ready',
      main: { app, bindingId: binding.id }, bindings: [binding], questions: [], works: [], attempts: [] };
    const view = context.controllerView(run, [], () => new Map());
    const windowId = app === 'codex' ? 'native-window' : `${app}:native-window`;
    assert.deepEqual(JSON.parse(JSON.stringify(view.main.target)), { computer: 'computer-two',
      win: app === 'codex' ? 'codex' : windowId, windowId, threadId: 'native-thread', project: { root: '/project', host: 'ssh-host' } });
    run.main.bindingId = '';
    assert.equal(context.controllerView(run, [], () => new Map()).main.target, null);
  }
});
