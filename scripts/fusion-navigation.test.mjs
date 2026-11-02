import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function fixture() {
  const sent = [], listeners = [], stored = new Map();
  const entries = ['computer-one', 'computer-two'].map(id => ({ id, name: id, c: { key: id } }));
  const context = vm.createContext({ crypto, Map, Set, Date, Object, JSON,
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
  assert.deepEqual([...h.stored.keys()], ['fusion-setup-done']);
});
test('all-computer Fusion board groups runs by computer and does not pick a creation target', () => {
  const h = fixture();
  h.run(`fusionWorkspaces.set('computer-one', {runs:[{id:'r1',title:'first',project:{name:'p'},main:{app:'cursor',model:'Auto'},status:'waiting',tasks:{done:0,total:2}}]})`);
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
  const capture = (source, start, computerProjects) => {
    const packets = [], html = [], context = vm.createContext({ computerProjects, esc: value => String(value || ''), I18N: { tr: value => value },
      currentComputer: () => ({ name: 'ordinary computer' }), currentAppName: 'Cursor', openSheet: (_kind, text) => html.push(text),
      send: message => packets.push(message), fusionProjectAction: () => assert.fail('ordinary action routed to Fusion') });
    vm.runInContext(source.slice(source.indexOf(start), source.indexOf('function showCodexSettings')), context);
    return { context, packets, html };
  };
  for (const computerProjects of [true, false]) for (const browsing of [true, false]) {
    const after = capture(current, 'function projectSheet(', computerProjects);
    const message = { browsing, path: '/project', recent: [{ name: 'project', path: '/project' }], dirs: [], drives: [] };
    after.context.showProjects(message);
    assert.match(after.html[0], /data-open="\/project"/); assert.match(after.html[0], /data-project-path/);
    assert.doesNotMatch(after.html[0], /data-project-context|Fusion/);
    assert.equal(after.html[0].includes('ordinary computer'), computerProjects);
    if (browsing) { assert.match(after.html[0], /data-project-new="\/project"/); assert.match(after.html[0], /data-project-chat="\/project"/); }
    const action = { t: 'openProject', path: '/project', newSession: true };
    after.context.sendProjectAction(action, null);
    assert.equal(after.packets[0], action);
  }
});
