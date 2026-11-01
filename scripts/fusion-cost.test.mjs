import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeCostSnapshot, validateExecution, validateCost, FUSION_TIERS } from '../server/fusion/cost.mjs';

test('native Auto, Free and multiplier prices retain their names, units and source times', () => {
  const rows = [{ label: 'Auto' }, { label: 'native-model', efforts: [{ label: 'high' }], pricing: { tag: 'Free', costs: [{ value: 2, unit: 'credits' }], creditMultiplier: 1.5 } }];
  const snapshot = nativeCostSnapshot('cursor', rows, { limits: [] }, 123);
  assert.equal(snapshot.models[0].model, 'Auto'); assert.equal(snapshot.models[0].amount, 'unknown');
  assert.deepEqual(snapshot.models[1].pricing, rows[1].pricing); assert.equal(snapshot.at, 123);
  assert.match(snapshot.basis, /不能归因/);
});
test('all three preferences permit any actual candidate and preserve the chosen main model', () => {
  for (const tier of Object.keys(FUSION_TIERS)) {
    const run = { tier, main: { model: 'user-choice' }, capabilities: [nativeCostSnapshot('codex', [{ label: 'native-high', efforts: [{ label: 'max' }] }], null, 1)] };
    validateExecution(run, { app: 'codex', model: 'native-high', effort: 'max' });
    assert.equal(run.main.model, 'user-choice');
  }
});
test('model and effort selections must come from observed native candidates', () => {
  const run = { capabilities: [nativeCostSnapshot('cursor', [{ label: 'Auto' }], null, 1)] };
  assert.throws(() => validateExecution(run, { app: 'cursor', model: 'invented' }), /候选/);
  assert.throws(() => validateExecution(run, { app: 'cursor', model: 'Auto', effort: 'invented' }), /未提供/);
});
test('dispatch cost comparisons include self execution and all orchestration overheads', () => {
  const run = { capabilities: [nativeCostSnapshot('cursor', [{ label: 'Auto' }], null, 1)] };
  const cost = { selfExecute: 'unknown', delegate: 'unknown', planning: 'one decision', review: 'one review', contextTransfer: 'small', rework: 'unknown', reason: 'less total context',
    sources: ['cursor:1'], alternatives: [{ app: 'cursor', model: 'Auto', effort: '', estimate: 'relative', reason: 'only candidate' }] };
  validateCost(run, cost);
  assert.throws(() => validateCost(run, { ...cost, planning: '' }), /planning/);
  assert.throws(() => validateCost(run, { ...cost, sources: ['invented-price'] }), /来源/);
  run.budget = { limit: 1, unit: 'USD' };
  assert.throws(() => validateCost(run, cost), /核对用户预算/);
  assert.throws(() => validateCost(run, { ...cost, total: { amount: 0.1, unit: 'USD' } }), /真实原生报价/);
});
