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
function workbenchMenuFixture() {
  const h = resultFixture(), menus = [], overview = fs.readFileSync(new URL('../app/js/overview.js', import.meta.url), 'utf8');
  h.context.document.body.classList.contains = () => false;
  Object.assign(h.context, { agentActionTarget: null, ovCompName: value => value, ovAgName: () => 'Fusion',
    openSheet: (kind, html) => { h.context.sheetKind = kind; menus.push({ kind, html }); },
    ovRecs: () => [], agentFavoriteState: () => false });
  const sheets = fs.readFileSync(new URL('../app/js/sheets.js', import.meta.url), 'utf8');
  h.run(sheets.slice(sheets.indexOf('function showAgentActions('), sheets.indexOf('function receiveAgentActions(')));
  h.run(overview.slice(overview.indexOf('function ovSessionMenu('), overview.indexOf('function ovMarkRead(')));
  return { ...h, menus, overview };
}
test('Fusion compact session cards keep task progress and navigate directly without a preview or bottom native actions', () => {
  const h = resultFixture(), opened = []; h.context.closeSheet = () => {}; h.context.ovOpen = target => opened.push(target);
  const original = JSON.stringify(h.context.testRun);
  const html = h.run("fusionWorkbenchTile(ovList[0],testRun)");
  assert.match(html, /ov-tile ov-session ov-compact/); assert.match(html, /ov-state.*ov-badge/);
  assert.match(html, /computer-one · project-one/); assert.match(html, /5<small>\/5/);
  assert.match(html, /ov-seg/); assert.equal((html.match(/class="ov-badge"/g) || []).length, 1);
  assert.doesNotMatch(html, /data-ov-session=|data-ov="sess"|class="ov-actions"|class="ov-card"|<button|fusion-open-feedback/);
  for (const status of ['running', 'recovering', 'stopping']) {
    h.context.activeCard = { ...h.context.testRun, status, tasks: { ...h.context.testRun.tasks, running: 1 } };
    const active = h.run('fusionWorkbenchTile(ovList[0],activeCard)');
    assert.doesNotMatch(active, /ov-wide|ov-open|data-ov="sess"/);
    assert.match(active, /5<small>\/5/); assert.match(active, /data-fusion-open="same-id"/);
  }
  h.context.ovS.open = 'ordinary-preview';
  const card = { dataset: { fusionOpen: 'same-id', computer: 'computer-one' }, closest: () => null };
  const event = { target: { closest: selector => selector.includes('[data-fusion-open]') ? card : null } };
  for (const handler of h.listeners.get('click')) handler(event);
  assert.equal(opened.length, 1); assert.equal(opened[0].computer, 'computer-one'); assert.equal(opened[0].threadId, 'native-main');
  assert.equal(h.context.ovS.open, 'ordinary-preview'); assert.equal(h.sent.length, 0); assert.equal(JSON.stringify(h.context.testRun), original);
  h.context.ovOpenFeedback = () => '<small class="ov-opening ov-opening-error" role="status">Target loading failed</small>';
  h.context.ovOpenLabel = () => assert.fail('Fusion cards use the lower-edge feedback without an extra opening label');
  const failed = h.run('fusionWorkbenchTile(ovList[0],testRun)');
  assert.match(failed, /class="ov-opening ov-opening-error"/); assert.match(failed, /Target loading failed/); assert.doesNotMatch(failed, /fusion-open-feedback|重试打开|<button/);
});
test('workbench cards share ordinary long-hold cancellation and suppress the subsequent open click', () => {
  const h = workbenchMenuFixture(), events = new Map(), timers = new Map(); let next = 0, opens = 0;
  const overview = h.context.$('overview');
  overview.addEventListener = (name, fn) => events.set(name, fn);
  Object.assign(h.context, { ovMain: { addEventListener: (name, fn) => events.set(name, fn) }, ovBatch: null,
    addEventListener: (name, fn) => events.set(name, fn), setTimeout: fn => { timers.set(++next, fn); return next; },
    clearTimeout: id => timers.delete(id), openFusionController: () => opens++ });
  h.run(h.overview.slice(h.overview.indexOf('let ovHold ='), h.overview.indexOf("$('overview').addEventListener('change'")));
  const key = h.run('fusionWorkbenchRecord(testRun).key');
  const card = { dataset: { ovMenu: key, fusionOpen: 'same-id', computer: 'computer-one' } };
  const target = { dataset: {}, closest: selector => ['[data-ov-session], [data-ov-menu]', '[data-fusion-open]'].includes(selector) ? card : null };
  const down = () => events.get('pointerdown')({ target, button: 0, clientX: 20, clientY: 20, pointerType: 'touch' });
  const fire = () => { for (const fn of [...timers.values()]) fn(); timers.clear(); };
  down(); events.get('pointermove')({ clientX: 40, clientY: 20 }); fire(); assert.equal(h.menus.length, 0);
  down(); events.get('pointercancel')(); fire(); assert.equal(h.menus.length, 0);
  down(); events.get('pointerup')(); fire(); assert.equal(h.menus.length, 0);
  down(); events.get('scroll')(); fire(); assert.equal(h.menus.length, 0);
  down(); fire(); assert.equal(h.menus.length, 1); assert.equal(h.sent.length, 0);
  const click = { target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  events.get('click')(click);
  for (const fn of h.listeners.get('click')) fn(click);
  assert.equal(click.defaultPrevented, true); assert.equal(opens, 0);
  assert.match(h.menus[0].html, /data-agent-action="open"/);
  assert.match(h.menus[0].html, /data-agent-action="favorite"/);
  assert.match(h.menus[0].html, /data-agent-action="rename"/);
  assert.match(h.menus[0].html, /data-agent-action="remove"/);
  assert.match(h.menus[0].html, /data-agent-action="read"/);
});
test('favorite workbenches retain computer identity and reuse the Fusion card renderer beside ordinary favorites', () => {
  const h = workbenchMenuFixture(); h.context.testRun.favorite = true;
  h.context.ovSt = new Map([['computer-one', { data: {} }]]);
  h.context.ovRecsOf = () => [{ key: 'ordinary', favorite: true, state: 'idle' }];
  h.context.ovSessionIdentity = row => row.key;
  h.context.ovCompare = (a, b) => a.key.localeCompare(b.key);
  h.context.ovSessTile = () => '<div>ordinary favorite</div>';
  h.run(`ovS.level='favorites';fusionWorkspaces.set('computer-two',{runs:[{...testRun,computer:'computer-two',title:'Other computer',favorite:true}]})`);
  h.run(h.overview.slice(h.overview.indexOf('const ovRecs ='), h.overview.indexOf('function ovProjects(')));
  h.run(h.overview.slice(h.overview.indexOf('function ovBoard('), h.overview.indexOf('function ovPlan(')));
  const rows = h.run('ovScopedRecs()'); assert.equal(rows.length, 3);
  assert.notEqual(rows[1].key, rows[2].key);
  const html = h.run('ovBoard([],[],ovScopedRecs())'); assert.match(html, /ordinary favorite/);
  assert.match(html, /data-computer="computer-one"/); assert.match(html, /data-computer="computer-two"/);
  h.run('testRun.favorite=false'); assert.equal(h.run('ovScopedRecs().length'), 2);
  assert.match(h.run('fusionBoard()'), /Completed workbench/);
  assert.equal(h.sent.length, 0);
});
test('opening a favorite workbench preserves its source and return position without changing other navigation routes', async () => {
  const source = fs.readFileSync(new URL('../app/js/overview.js', import.meta.url), 'utf8');
  for (const [level, win, expected] of [['favorites', 'fusion', 'favorites'], ['fusion', 'fusion', 'fusion'], ['sessions', 'fusion', 'fusion'], ['favorites', 'cursor', 'favorites']]) {
    const h = fixture(), classes = new Set(), opened = [], previous = [];
    Object.assign(h.context.ovS, { level, comp: 'computer-two', proj: null, open: null });
    Object.assign(h.context.document.body.classList, { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name) });
    Object.assign(h.context, { ovOpenRequest: 0, ovToolState: null, ovOpening: null, ovEnterRequested: false, ovMain: { scrollTop: 137 },
      ovCollapsed: new Set(), ovExpanded: new Set(), OV_ROOT: { level: 'sessions', comp: null, proj: null, open: null },
      currentComputer: () => ({ key: 'computer-two' }), winTargetPending: () => false, openWin: raw => opened.push(JSON.parse(raw)),
      ovClearBatch() {}, ovReleaseComposer() {}, ovVisible() {}, autosize() {}, saveComputerResumes() {},
      ovRender: (_reset, scroll) => { if (scroll != null) h.context.ovMain.scrollTop = scroll; },
      history: { state: { ovDepth: 0 }, replaceState(state) { this.state = state; },
        pushState(state) { previous.push(this.state); this.state = state; }, back() { this.state = previous.pop(); h.context.ovLeave(this.state); } },
    });
    h.run(source.slice(source.indexOf('function ovHistory('), source.indexOf('function ovRestoreComputers(')));
    h.run(source.slice(source.indexOf('function ovRestore('), source.indexOf('function ovMove(')));
    h.run(source.slice(source.indexOf('async function ovOpen('), source.indexOf('let ovHold =')));
    const target = { computer: 'computer-two', win, windowId: win, threadId: 'main-session' };
    await h.context.ovOpen(target);
    assert.equal(h.context.ovS.level, expected); assert.equal(h.context.ovS.comp, 'computer-two');
    assert.deepEqual(opened, [target]); assert.equal(classes.has('conv'), false);
    h.run('ovShowConversation()');
    assert.equal(classes.has('conv'), true); assert.equal(h.context.history.state.ov.level, expected);
    h.context.ovMain.scrollTop = 0;
    h.run('ovBackToBoard()');
    assert.equal(classes.has('conv'), false); assert.equal(h.context.ovS.level, expected);
    assert.equal(h.context.ovS.comp, 'computer-two'); assert.equal(h.context.ovMain.scrollTop, 137);
    assert.equal(h.sent.some(message => message.t !== 'fusionWorkspace'), false);
  }
});
test('workbench menus keep required interactions unread and leave ordinary session actions unchanged', () => {
  const h = workbenchMenuFixture();
  for (const state of ['run', 'wait', 'err']) {
    h.context.testRun.overview = { ...h.context.testRun.overview, state, resultKey: '' };
    h.run('ovSessionMenu(fusionWorkbenchRecord(testRun).key)');
    assert.doesNotMatch(h.menus.at(-1).html, /data-agent-action="read"/);
  }
  const ordinary = { app: 'cursor', comp: 'computer-one', projName: 'ordinary project', title: 'Ordinary session', state: 'done', favorite: false };
  h.context.ordinary = ordinary;
  h.run("showAgentActions('native-thread','Ordinary session',['rename','delete'],ordinary)");
  const html = h.menus.at(-1).html;
  for (const action of ['open','read','favorite','rename','delete']) assert.match(html, new RegExp(`data-agent-action="${action}"`));
  assert.doesNotMatch(html, /工作台设置|查看任务|停止工作台|删除工作台/); assert.equal(h.sent.length, 0);
});
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

test('new requirements use the existing main composer rather than an internal inbox wake message', () => {
  const h=fixture();let focused=0,closed=0;const reads=[];
  h.context.text={focus(){focused++;}};h.context.closeSheet=()=>{closed++;};
  h.context.testRun={id:'r',computer:'computer-one'};
  h.run('currentFusionRun=()=>testRun;fusionChatActive=()=>true');h.context.readFusionView=(...args)=>reads.push(args);
  h.run("focusFusionInput('computer-one','r')");assert.equal(focused,1);assert.equal(closed,1);assert.equal(reads.length,1);
  assert.deepEqual(reads[0].slice(0,3),['computer-one','r','tasks']);assert.equal(reads[0][4],'strip');assert.equal(h.sent.length,0);
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
test('each retained worker displays its responsibility label and tasks in descending activity order without reordering stored tasks', () => {
  const h=fixture();h.context.testSurface={dataset:{},querySelector:()=>null,querySelectorAll:()=>[],scrollTop:0};
  h.context.testRun={id:'r',computer:'computer-one',status:'waiting',main:{app:'cursor',model:'Auto',effort:''},agents:[{id:'worker',label:'训练证据复核'}],works:[],questions:[],
    tasks:[['old',1],['equal-first',2],['new',3],['equal-second',2]].map(([id,updated])=>({id,updated,workerId:'worker',goal:'Long detailed goal '+id,
      executor:'child',app:'cursor',model:'Auto',effort:'',state:'idle',status:'queued',dependsOn:[]}))};
  h.run("fusionViewOwner={surface:'panel'};fusionRememberBoard=()=>{};fusionSurface=()=>testSurface;fusionDraw=(_kind,html)=>{this.testHtml=html};showFusionTasks(testRun)");
  const html=h.context.testHtml;assert.match(html,/title="训练证据复核"/);
  const heading = html.match(/<summary class="fusion-agent-heading">([\s\S]*?)<\/summary>/)[1];
  assert.match(heading, /<strong[^>]*>训练证据复核<\/strong>/); assert.doesNotMatch(heading, /Long detailed goal/);
  assert.doesNotMatch(html, /<details[^>]*data-fusion-agent="worker"[^>]*\bopen(?:\s|>)/);
  assert.deepEqual([...html.matchAll(/data-fusion-task="([^"]+)"/g)].map(match=>match[1]),['new','equal-first','equal-second','old']);
  assert.deepEqual(h.context.testRun.tasks.map(task=>task.id),['old','equal-first','new','equal-second']);
  assert.match(html,/Long detailed goal old/);assert.equal(h.sent.length,0);
  h.context.testRun.agents[0].label='新采集性能复核';
  h.run('showFusionTasks(testRun)');
  assert.match(h.context.testHtml, /<strong[^>]*>新采集性能复核<\/strong>/);
  assert.match(h.context.testHtml, /data-fusion-agent="worker"/); assert.equal(h.sent.length,0);
});
test('Fusion titles show native model effort once and preserve ordinary titles', () => {
  const nodes = new Map(), run = { title: 'Historical workbench', computer: 'computer-one', project: { root: '/project' },
    main: { app: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, tier: 'balanced' };
  const context = vm.createContext({ currentApp: 'codex', currentAppName: 'Codex', mode: 'chat', activeFusionController: run,
    lastChat: { thread: 'native-main', model: 'GPT 6.1 Sol · High', effort: 'high', items: [] },
    currentComputer: () => ({ threadId: 'native-main' }), currentFusionRun: () => run,
    OV_AGENT: { codex: 'Codex' }, ovCompName: value => value, appPlans: {}, I18N: { tr: value => value },
    document: { body: { dataset: {} } }, cleanWindowTitle: value => value, paintRail() {},
    $: id => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); } });
  const source = fs.readFileSync(new URL('../app/js/chat.js', import.meta.url), 'utf8');
  vm.runInContext(source.slice(source.indexOf("let currentProject ="), source.indexOf('// Devin sessions:')), context);
  context.updateTitle();
  assert.equal(nodes.get('titleProject').textContent, 'Codex · GPT 6.1 Sol · High · 均衡');
  context.lastChat = { ...context.lastChat, model: 'GPT 6.1 Sol' }; context.updateTitle();
  assert.equal(nodes.get('titleProject').textContent, 'Codex · GPT 6.1 Sol · High · 均衡');
  context.activeFusionController = null; context.lastChat = { title: 'Ordinary native chat', items: [] }; context.updateTitle();
  assert.equal(nodes.get('titleText').textContent, 'Codex'); assert.equal(nodes.get('titleProject').textContent, 'Ordinary native chat');
});
test('opening the Fusion workspace reads each scoped computer without attaching or creating a native session', () => {
  const h = fixture(); h.run('refreshFusionWorkspace()');
  assert.deepEqual(h.sent.map(message => [message.computer, message.t]), [['computer-one', 'fusionWorkspace'], ['computer-two', 'fusionWorkspace']]);
  h.sent.length = 0; h.run("ovS.comp = 'computer-two'; refreshFusionWorkspace()");
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].computer, 'computer-two');
  assert.deepEqual([...h.stored.keys()], []);
});
test('all-computer Fusion board groups runs by computer and does not pick a creation target', () => {
  const h = fixture();
  h.run(`fusionWorkspaces.set('computer-one', {runs:[{id:'r1',title:'first',project:{name:'p'},main:{app:'cursor',model:'Auto'},status:'waiting',works:{done:0,total:1},tasks:{done:0,total:2},overview:{state:'idle',apps:['cursor'],counts:{idle:2},attention:[],current:null}}]})`);
  const html = h.run('fusionBoard()');
  assert.match(html, /computer-one/); assert.match(html, /computer-two/); assert.match(html, /data-fusion-open="r1"/);
  assert.equal(h.sent.length, 0);
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
test('Fusion folder browsing uses the chosen computer and sends no native navigation or creation request', () => {
  const h = fixture(), sheets = [];
  h.context.projectSheet = (...args) => sheets.push(args);
  h.run("fusionProjectAction({t:'projects',path:'/project'},{computer:'computer-two',app:'cursor',tier:'balanced',requestId:'create'})");
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].t, 'fusionWorkspace');
  assert.equal(h.sent[0].computer, 'computer-two'); assert.equal(h.sent[0].path, '/project');
  h.run("fusionProjectAction({t:'openProject',path:'/project',newSession:false},{computer:'computer-two',app:'cursor',tier:'balanced',requestId:'create'})");
  assert.equal(h.sent[1].t, 'fusionProject'); assert.equal(h.sent[1].action, 'openProject');
  assert.equal(h.sent[1].main.app, 'cursor'); assert.equal(h.sent[1].computer, 'computer-two');
  assert.equal(h.sent[1].newSession, false); assert.equal(h.sent[1].requestId, 'create');
});
test('the shared project sheet retains ordinary project actions and routes them to the native destination', () => {
  const current = fs.readFileSync(new URL('../app/js/sheets.js', import.meta.url), 'utf8');
  const capture = (source, start, fromComputer) => {
    const packets = [], html = [], folders = [], context = vm.createContext({ projectEntry: fromComputer ? { source: 'computer' } : null, esc: value => String(value || ''), I18N: { tr: value => value },
      currentComputer: () => ({ name: 'ordinary computer' }), currentAppName: 'Cursor', openSheet: (_kind, text) => html.push(text),
      openProjectFolders: (...args) => folders.push(args),
      send: message => packets.push(message), fusionProjectAction: () => assert.fail('ordinary action routed to Fusion') });
    vm.runInContext(source.slice(source.indexOf(start), source.indexOf('function showCodexSettings')), context);
    return { context, packets, html, folders };
  };
  for (const fromComputer of [true, false]) for (const browsing of [true, false]) {
    const after = capture(current, 'function projectSheet(', fromComputer);
    const message = { browsing, path: '/project', recent: [{ name: 'project', path: '/project' }], dirs: [], drives: [] };
    after.context.showProjects(message);
    if (browsing) assert.deepEqual(after.folders, [['/project', null]]);
    else {
      assert.match(after.html[0], /data-open="\/project"/); assert.match(after.html[0], /data-project-path/);
      assert.doesNotMatch(after.html[0], /data-project-context|Fusion/);
      assert.equal(after.html[0].includes('ordinary computer'), fromComputer);
      assert(after.html[0].indexOf('data-project-browse') < after.html[0].indexOf('data-open='));
      assert(after.html[0].indexOf('data-project-path') < after.html[0].indexOf('data-open='));
    }
    const action = { t: 'openProject', path: '/project', newSession: true };
    after.context.sendProjectAction(action, null);
    assert.equal(after.packets[0], action);
  }
});

test('Fusion project browsing hands the shared folder picker its selected computer and complete owner', () => {
  const h = fixture(), opened = [], sheets = fs.readFileSync(new URL('../app/js/sheets.js', import.meta.url), 'utf8');
  h.context.openComputerFiles = (...args) => opened.push(args);
  h.context.currentComputer = () => ({ id: 'computer-one' });
  const files = fs.readFileSync(new URL('../app/js/files.js', import.meta.url), 'utf8');
  vm.runInContext(files.slice(files.indexOf('function openProjectFolders('), files.indexOf('function receiveCurrentFiles(')), h.context);
  vm.runInContext(sheets.slice(sheets.indexOf('function projectSheet('), sheets.indexOf('function showCodexSettings(')), h.context);
  const owner = { computer: 'computer-two', app: 'cursor', tier: 'balanced', requestId: 'create' };
  h.context.showProjects({ browsing: true, path: '/chosen/project' }, owner);
  assert.equal(opened[0][0], 'computer-two'); assert.equal(opened[0][1].path, '/chosen/project');
  assert.equal(opened[0][1].project.owner, owner);
  assert.equal(h.sent.length, 0);
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
test('idle Fusion renders no permanent status row while a current block exposes only its own recovery actions', () => {
  const h=fixture();
  Object.assign(h.context,{fusionEnsureBoard(){},fitFusionLayout(){}});
  const strip=h.context.$('fusionTaskStrip');strip.scrollLeft=0;strip.getBoundingClientRect=()=>({left:0});
  h.run("activeFusionController={id:'run',computer:'computer-two',status:'waiting',blockedReason:'Historical interruption',tasks:{total:0}};");
  for(const state of ['ready','waiting','running','completed']){
    h.run(`activeFusionController.status=${JSON.stringify(state)};paintFusionRun()`);
    assert.equal(h.context.$('fusionBar').hidden,true);assert.equal(h.context.$('fusionBar').innerHTML,'');
  }
  assert.equal(h.run('activeFusionController.blockedReason'),'Historical interruption');
  h.run("activeFusionController.status='blocked';paintFusionRun()");
  const bar=h.context.$('fusionBar');assert.equal(bar.hidden,false);
  assert.equal(bar.dataset.fusionRun,'run');assert.equal(bar.dataset.fusionComputer,'computer-two');
  assert.match(bar.innerHTML,/Historical interruption/);assert.match(bar.innerHTML,/data-fusion-resume/);
  assert.match(bar.innerHTML,/data-fusion-new-input="run"/);assert.match(bar.innerHTML,/data-fusion-relations=""/);
  assert.equal(h.sent.length,0);
});
test('enabled Fusion goes straight to common navigation; unconfigured Fusion reads only configuration', () => {
  const h = viewFixture();
  h.run("fusionWorkspaces.set('computer-one',{runs:[{id:'ready',main:{bindingId:'native',target:{computer:'computer-one',win:'codex',windowId:'native-window',threadId:'native-thread'}}},{id:'new',main:{bindingId:''}}]})");
  h.run("openFusionController('computer-one','ready')");
  assert.equal(h.sent.length, 0); assert.equal(h.opened.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.opened[0])), { computer: 'computer-one', win: 'codex', windowId: 'native-window', threadId: 'native-thread' });
  h.run("openFusionController('computer-one','new')");
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].view, 'config'); assert.equal(h.opened.length, 1);
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
test('refreshing selected task controls preserves native fields, caret, scroll and the matching open audit', () => {
  const h = viewFixture();
  const field = { name: '', dataset: { nativeRequest: 'request', fusionField: '0' }, value: 'draft', selectionStart: 2, selectionEnd: 4 };
  const audit = (key, open) => ({ dataset: { fusionAudit: key }, open });
  let fields = [field], details = [audit('old-attempt', true)]; h.context.document.activeElement = field; h.sheet.scrollTop = 138;
  h.sheet.querySelectorAll = selector => selector === 'details' ? details : fields;
  h.context.paint = () => {
    fields = [{ ...field, value: 'native', focus() { this.focused = true; }, setSelectionRange(start, end) { this.range = [start, end]; } }];
    details = [audit('new-attempt', false), audit('old-attempt', false)]; h.sheet.scrollTop = 0;
  };
  h.run('fusionPreserveSheet(paint)');
  assert.equal(fields[0].value, 'draft'); assert.equal(fields[0].focused, true); assert.deepEqual(fields[0].range, [2, 4]);
  assert.equal(details[0].open, false); assert.equal(details[1].open, true); assert.equal(h.sheet.scrollTop, 138);
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
test('Fusion controller software choices come from the selected computer metadata', () => {
  const h = fixture();
  h.run("fusionWorkspaces.set('computer-one',{apps:[{app:'cursor',name:'Cursor',controller:true,connected:true},{app:'devin',name:'Devin',controller:true,connected:false},{app:'codex',name:'Codex',controller:true,connected:true},{app:'fixture-editor',name:'Fixture editor',controller:true,connected:true},{app:'worker-only',name:'Worker',controller:false}]})");
  const html = h.run("fusionAppSelect('computer-one','devin')");
  for (const app of ['cursor', 'devin', 'codex', 'fixture-editor']) assert(html.includes('value="' + app + '"'));
  assert(html.includes('value="devin" selected')); assert(!html.includes('worker-only'));
  assert(!h.run("fusionAppSelect('computer-two','devin')").includes('value="devin"'));
});
test('Fusion navigation uses the native binding while management retains the workbench identity', () => {
  const h = resultFixture(), opened = [];
  h.context.closeSheet = () => {};
  h.context.ovOpen = target => opened.push(target);
  h.run("openFusionController('computer-one','same-id')");
  assert.deepEqual(JSON.parse(JSON.stringify(opened[0])), h.context.testRun.main.target);
  const record = h.run('fusionWorkbenchRecord(testRun)');
  assert.equal(record.win, 'fusion');
  assert.equal(record.threadId, 'same-id');
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
