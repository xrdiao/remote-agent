import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function fixture() {
  const sent = [], listeners = [], stored = new Map();
  const entries = ['computer-one', 'computer-two'].map(id => ({ id, name: id, c: { key: id } }));
  const context = vm.createContext({ crypto, Map, Set, Date, Object, JSON,
    MutationObserver: class { observe() {} }, $: () => ({}), ovOpenFeedback: () => '', ovOpenLabel: (_target, label) => label, releaseFusionView() {}, ovCancelOpening() {},
    store: { set: (key, value) => stored.set(key, value) }, I18N: { tr: value => value }, esc: value => String(value || ''),
    document: { addEventListener: (_event, listener) => listeners.push(listener) },
    ovList: entries, ovS: { comp: null, level: 'fusion' }, OV_AGENT: { cursor: 'Cursor' },
    ovComputerStatus: () => 'online', status() {},
    computerSockets: new Map(entries.map(entry => [entry.id, { authed: true, socket: { readyState: 1, send: raw => sent.push(JSON.parse(raw)) } }])),
  });
  vm.runInContext(fs.readFileSync(new URL('../app/js/fusion.js', import.meta.url), 'utf8'), context);
  return { context, sent, stored, run: code => vm.runInContext(code, context) };
}
test('opening the Fusion workspace reads each scoped computer without attaching or creating a native session', () => {
  const h = fixture(); h.run('refreshFusionWorkspace()');
  assert.deepEqual(h.sent.map(message => [message.computer, message.t]), [['computer-one', 'fusionWorkspace'], ['computer-two', 'fusionWorkspace']]);
  h.sent.length = 0; h.run("ovS.comp = 'computer-two'; refreshFusionWorkspace()");
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].computer, 'computer-two');
  assert.deepEqual([...h.stored.keys()], []);
});
test('all-computer Fusion board groups runs by computer and does not pick a creation target', () => {
  const h = fixture();
  h.run(`fusionWorkspaces.set('computer-one', {runs:[{id:'r1',title:'first',project:{name:'p'},main:{app:'cursor',model:'Auto'},status:'waiting',works:{done:0,total:1},tasks:{done:0,total:2}}]})`);
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
  const h = fixture(), painted = [], opened = [], sheet = { scrollTop: 0, querySelector: () => null, querySelectorAll: () => [] };
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
test('enabled Fusion goes straight to common navigation; unconfigured Fusion reads only configuration', () => {
  const h = viewFixture();
  h.run("fusionWorkspaces.set('computer-one',{runs:[{id:'ready',main:{bindingId:'native'}},{id:'new',main:{bindingId:''}}]})");
  h.run("openFusionController('computer-one','ready')");
  assert.equal(h.sent.length, 0); assert.equal(h.opened.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.opened[0])), { computer: 'computer-one', win: 'fusion', windowId: 'fusion', threadId: 'ready' });
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
