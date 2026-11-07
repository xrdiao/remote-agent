import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeCostSnapshot, validateExecution, validateCost, FUSION_TIERS } from '../server/fusion/cost.mjs';
import { fixture } from './fusion-fixture.mjs';
import { NativeAgentProvider, registerNativeAgentProvider } from '../server/fusion/providers.mjs';
test('registered software and newly observed models use the same native capability validation', t => {
  t.after(registerNativeAgentProvider(new NativeAgentProvider({ app: 'fixture-editor', name: 'Fixture editor' })));
  const h = fixture();
  h.run.capabilities.unshift(nativeCostSnapshot('fixture-editor', [{ id: 'new-model', efforts: ['native-strength'] }], null));
  assert.equal(validateExecution(h.run, { app: 'fixture-editor', model: 'new-model', effort: 'native-strength' }).model, 'new-model');
  assert.throws(() => validateExecution(h.run, { app: 'fixture-editor', model: 'invented-model', effort: 'native-strength' }), /原生候选/);
});
test('Auto, Free and native multipliers retain exact units, source and observation time', () => {
  const models = [{ id: 'Auto', label: 'Auto' }, { id: 'free', label: 'Free High', efforts: ['high'], pricing: { tag: 'Free', costs: [{ value: 2, unit: 'credits' }], creditMultiplier: 1.5 } }];
  const snapshot = nativeCostSnapshot('cursor', models, null, { read: 'native-model-menu' }, 123);
  assert.equal(snapshot.at, 123); assert.equal(snapshot.models[0].model, 'Auto'); assert.equal(snapshot.models[0].amount, 'unknown');
  assert.deepEqual(snapshot.models[1].pricing, models[1].pricing); assert.equal(snapshot.origin.read, 'native-model-menu');
});
test('all three tiers permit every native model and leave the chosen main unchanged', () => {
  const h = fixture();
  for (const tier of Object.keys(FUSION_TIERS)) {
    h.run.tier = tier; const selected = structuredClone(h.run.main);
    validateExecution(h.run, { app: 'cursor', model: 'Auto', effort: '' });
    assert.deepEqual(h.run.main, selected);
  }
});
test('model, strength and cost provenance must belong to native observations', () => {
  const h = fixture();
  assert.throws(() => validateExecution(h.run, { app: 'codex', model: 'invented', effort: 'low' }), /候选/);
  assert.throws(() => validateExecution(h.run, { app: 'codex', model: 'cheap', effort: 'invented' }), /实际选项/);
  assert.throws(() => validateCost(h.run, { ...h.cost('codex'), overhead: '' }, h.run.main), /overhead/);
  assert.throws(() => validateCost(h.run, { ...h.cost('codex'), sources: ['invented'] }, h.run.main), /来源/);
});
test('only explicit budgets create limits; unknown or incompatible units do not produce subscription bills', () => {
  const h = fixture(); validateCost(h.run, h.cost('codex'), h.run.main);
  h.run.budget = { limit: 1, unit: 'USD' };
  assert.throws(() => validateCost(h.run, h.cost('codex'), h.run.main), /预算无法/);
  assert.throws(() => validateCost(h.run, { ...h.cost('codex'), estimate: { amount: 0.1, unit: 'USD' } }, h.run.main), /真实报价/);
});
test('explicit native-unit budgets aggregate prior and queued reservations', () => {
  const h = fixture(); h.run.budget = { limit: 3, unit: 'credits' }; h.run.capabilities[0].models[0].pricing = { unit: 'credits' };
  const cost = { ...h.cost('codex'), estimate: { amount: 2, unit: 'credits' } };
  validateCost(h.run, cost, h.run.main); h.run.assignments.push({ id: 'previous', cost }); h.run.attempts.push({ assignmentId: 'previous', status: 'queued', submission: 'not_submitted' });
  assert.throws(() => validateCost(h.run, cost, h.run.main), /预计总成本超过/);
});
