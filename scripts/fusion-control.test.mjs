import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { newFusionRun } from '../server/fusion/state.mjs';
import { applyFusionDecision } from '../server/fusion/control.mjs';
import { nativeCostSnapshot } from '../server/fusion/cost.mjs';

function fixture() {
  const run = newFusionRun('test', { id: 'p', root: '/project', host: '' }, { app: 'cursor', model: 'Auto', effort: '' });
  run.capabilities = [nativeCostSnapshot('cursor', [{ label: 'Auto' }], null, 1)];
  const request = { id: 'decision', native: { threadId: 'main', turnId: 'turn' }, eventIds: [] };
  run.decisions.push({ ...request, status: 'queued' });
  const apply = actions => applyFusionDecision(run, request, { role: 'main', completed: true, native: request.native,
    text: `说明\n\`\`\`fusion-control\n${JSON.stringify({ runId: run.id, decisionId: request.id, actions })}\n\`\`\`` });
  const cost = { selfExecute: '未知，相对低', delegate: '未知，相对低', planning: '一次', review: '一次', contextTransfer: '少量', rework: '未知', reason: '比较后选型',
    alternatives: [{ app: 'cursor', model: 'Auto', effort: '', estimate: '金额未知', reason: '唯一已读取候选' }], sources: ['cursor:1'] };
  const plan = { type: 'plan', id: 'plan', summary: '读取项目', scope: ['src'], criteria: [{ id: 'C1', text: '给出证据' }], requiresConfirmation: false };
  const dispatch = id => ({ type: 'dispatch', task: { id, goal: '读取文件', scope: ['src/a.js'], dependsOn: [], access: 'read', acceptance: ['提供结果'] },
    execution: { app: 'cursor', model: 'Auto', effort: '', input: '读取 src/a.js' }, cost });
  return { run, request, apply, plan, dispatch };
}

test('zero child agents can deliver evidence without a fixed execution stage', () => {
  const h = fixture();
  h.apply([h.plan, { type: 'finish', summary: '已回答', evidence: [{ criterion: 'C1', detail: '原生只读核对结果', reference: 'main/turn' }] }]);
  assert.equal(h.run.status, 'completed'); assert.equal(h.run.tasks.length, 0);
});
test('a decision is validated atomically before creating any tasks', () => {
  const h = fixture(), before = structuredClone(h.run);
  const invalid = h.dispatch('B2'); invalid.execution.model = 'invented-model';
  assert.throws(() => h.apply([h.plan, h.dispatch('B1'), invalid]), /候选/);
  assert.deepEqual(h.run, before);
});
test('plan confirmation cannot be bypassed by dispatch in the same reply', () => {
  const h = fixture();
  assert.throws(() => h.apply([{ ...h.plan, requiresConfirmation: true }, h.dispatch('B1')]), /尚未确认/);
  h.apply([{ ...h.plan, requiresConfirmation: true }]);
  assert.equal(h.run.authorization.confirmed, false); assert.equal(h.run.status, 'awaiting_user');
});
test('replaying an applied control receipt never dispatches again', () => {
  const h = fixture(); h.apply([h.plan, h.dispatch('B1')]);
  assert.equal(h.apply([h.plan, h.dispatch('B1')]).duplicate, true);
  assert.equal(h.run.tasks.length, 1); assert.equal(h.run.attempts.length, 1);
});
test('tasks have no hardcoded four-task or four-round limit', () => {
  const h = fixture(); h.apply([h.plan, ...Array.from({ length: 7 }, (_, index) => h.dispatch('B' + (index + 1)))]);
  assert.equal(h.run.tasks.length, 7);
});
test('control text from a child, a different turn or an unfinished reply is rejected', () => {
  const h = fixture();
  for (const override of [{ role: 'child' }, { completed: false }, { native: { threadId: 'main', turnId: 'old' } }])
    assert.throws(() => applyFusionDecision(h.run, h.request, { role: 'main', completed: true, text: '', native: h.request.native, ...override }), /原生轮次/);
});
test('missing, malformed and duplicate control blocks report concrete parsing failures', () => {
  const h = fixture();
  for (const [body, pattern] of [['plain answer', /实际 0/], ['```fusion-control\n{bad}\n```', /JSON 解析失败/], ['```fusion-control\n{}\n```\n```fusion-control\n{}\n```', /实际 2/]])
    assert.throws(() => applyFusionDecision(h.run, h.request, { role: 'main', completed: true, text: body, native: h.request.native }), pattern);
});
test('out-of-scope work and unresolved required tasks prevent delivery', () => {
  const h = fixture(), task = h.dispatch('B1'); task.task.scope = ['other/file'];
  assert.throws(() => h.apply([h.plan, task]), /超出/);
  assert.throws(() => h.apply([h.plan, h.dispatch('B1'), { type: 'finish', summary: 'done', evidence: [] }]), /必需任务/);
});
test('self execution keeps the user-selected main model and creates an attempt', () => {
  const h = fixture(); h.apply([h.plan, { ...h.dispatch('M1'), type: 'self_execute', execution: { app: 'codex', model: 'other', input: '读取' } }]);
  assert.equal(h.run.tasks[0].executor, 'main'); assert.equal(h.run.attempts[0].model, 'Auto');
});
test('delivery cannot ignore events that arrived after the decision started', () => {
  const h = fixture(); h.run.events.push({ id: 'new-user-message', consumedBy: '' });
  assert.throws(() => h.apply([h.plan, { type: 'finish', summary: 'done', evidence: [] }]), /新事件/);
});

test('applying a decision preserves live binding identities used by concurrent native attempts', () => {
  const h = fixture(), binding = { id: 'binding', app: 'cursor', threadId: '' };
  h.run.bindings.push(binding);
  h.apply([h.plan, { type: 'wait' }]);
  assert.equal(h.run.bindings[0], binding);
  binding.threadId = 'native-thread-accepted-after-decision';
  assert.equal(h.run.bindings[0].threadId, 'native-thread-accepted-after-decision');
});

test('the one-time cutover only removes legacy Fusion facts and its own virtual selection', () => {
  const shots = fileURLToPath(new URL('../_shots/fusion-rewrite-20261101/', import.meta.url));
  fs.mkdirSync(shots, { recursive: true });
  const directory = fs.mkdtempSync(path.join(shots, 'cutover-test-'));
  const authUrl = new URL('../lib/auth.mjs', import.meta.url).href;
  const stateUrl = new URL('../server/fusion/state.mjs', import.meta.url).href;
  const beforeBackups = new Set(fs.readdirSync(shots));
  try {
    fs.writeFileSync(path.join(directory, 'loader.mjs'), `import {registerHooks} from 'node:module';
      registerHooks({load(url,context,next){const result=next(url,context);if(url!==${JSON.stringify(authUrl)})return result;
        const source=String(result.source),needle="export const DATA_DIR = path.join(os.homedir(), '.agent-remote');";
        if(!source.includes(needle))throw Error('test storage isolation failed');
        return {...result,source:source.replace(needle,${JSON.stringify('export const DATA_DIR = ' + JSON.stringify(directory) + ';')})};}});`);
    execFileSync(process.execPath, ['--import', path.join(directory, 'loader.mjs'), '--input-type=module', '-'], { encoding: 'utf8', input: `
      import assert from 'node:assert/strict';import fs from 'node:fs';import crypto from 'node:crypto';
      const key=Buffer.alloc(32,1),computer=crypto.createHash('sha256').update(key).digest().subarray(0,8).toString('hex');
      fs.writeFileSync(${JSON.stringify(path.join(directory, 'url-key'))},key.toString('base64url'));
      const ordinary={id:'codex',app:'codex',windowId:'ordinary-window',threadId:'ordinary-thread'};
      const legacy={id:'fusion',app:'fusion',windowId:'fusion',threadId:'old-run'};
      const fixture={fusionHistory:{device:{runs:[{id:'old-run',a:'cursor',b:'codex'}]}},
        fusionRuns:{device:{current:'new-run',runs:[]}},relayUrl:'keep-relay',conversationProjects:{keep:'mapping'},
        entrySelections:{[computer]:{device:{last:legacy,apps:{codex:ordinary,fusion:legacy}}},
          otherComputer:{device:{last:ordinary,apps:{codex:ordinary,fusion:legacy}}}}};
      fs.writeFileSync(${JSON.stringify(path.join(directory, 'state.json'))},JSON.stringify(fixture));
      const auth=await import(${JSON.stringify(authUrl)});
      const state=await import(${JSON.stringify(stateUrl)});state.initializeFusionState();
      const expected=structuredClone(fixture);delete expected.fusionHistory;
      expected.entrySelections[computer].device.last=null;delete expected.entrySelections[computer].device.apps.fusion;
      assert.deepEqual(auth.readState(),expected);assert.equal(auth.lastSelection('device','fusion'),null);
      assert.deepEqual(auth.lastSelection('device','codex'),ordinary);
      const first=JSON.stringify(auth.readState());state.initializeFusionState();assert.equal(JSON.stringify(auth.readState()),first);
    ` });
    assert.equal(fs.readdirSync(shots).filter(name => name.startsWith('legacy-fusion-') && !beforeBackups.has(name)).length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true });
    for (const name of fs.readdirSync(shots)) if (name.startsWith('legacy-fusion-') && !beforeBackups.has(name)) fs.unlinkSync(path.join(shots, name));
  }
});
