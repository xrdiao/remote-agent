import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { nativeCostSnapshot, validateExecution, validateCost, FUSION_TIERS, modelQuery, fusionModelView } from '../server/fusion/cost.mjs';
import { FusionModelCatalog, modelKnowledgeSummary } from '../server/fusion/model-catalog.mjs';
import { FusionControlError, MODEL_PAGE_LIMIT } from '../server/fusion/contract.mjs';
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

function publicCatalog(t, { aaKey = '' } = {}) {
  const directory = fs.mkdtempSync(new URL('../_shots/model-catalog-', import.meta.url)), file = path.join(directory, 'catalog.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = 100, status = 200;
  const calls = [], model = (id, extra = {}) => ({ id, name: id, description: 'Public model description '.repeat(20),
    modalities: { input: ['text', 'image'], output: ['text'] }, reasoning: true, tool_call: true,
    limit: { context: 200000 }, cost: { input: 1, output: 2, tiers: [{ context: 10000, input: 3 }] },
    release_date: '2026-01-01', last_updated: '2026-11-07', ...extra });
  const bodies = {
    'models.dev': { openai: { doc: 'https://example.test/official', models: {
      one: model('test-model'), pro: model('test-model-pro'), batch: model('test-model:batch'),
      common: model('shared-name'),
    } }, mirror: { models: { one: model('test-model', { canonical_model_id: 'openai/test-model', cost: { input: 99 } }) } },
    other: { models: { one: model('shared-name') } } },
    openrouter: { data: [{ id: 'openai/test-model', canonical_slug: 'test-model-20261107', name: 'Test model',
      description: 'Independent directory description', architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      context_length: 100000, supported_parameters: ['tools', 'reasoning'], created: 1700000000,
      pricing: { prompt: '0.000001', completion: '0.000002', overrides: [{ amount: '0.000003' }] } }] },
    'artificial-analysis': { intelligence_index_version: 'fixture-v1', data: [{ id: 'aa-model', slug: 'test-model', name: 'Test model (published configuration)',
      evaluations: { artificial_analysis_intelligence_index: 50, artificial_analysis_coding_index: 60, artificial_analysis_agentic_index: 55, raw_subtest: 99 },
      performance: { median_time_to_first_token_seconds: 1 }, release_date: '2026-01-01', pricing: { price_1m_input_tokens: 1 } }] },
    'codex-billing': '# Official software plan\n' + 'Plan credits are separate from API prices. '.repeat(250),
    'cursor-billing': '<html><nav>not body</nav><script>not text</script><article>Native Auto &amp; subscription units.</article></html>',
  };
  const catalog = new FusionModelCatalog({ file, aaKey, now: () => now, fetch: async (url, options) => {
    const source = catalog.sources().find(row => row.url === url); calls.push({ source: source.id, options });
    return { status, ok: status === 200, headers: new Headers({ etag: 'fixture-etag', 'last-modified': 'Sat, 07 Nov 2026 00:00:00 GMT' }),
      json: async () => bodies[source.id], text: async () => bodies[source.id] };
  } });
  return { catalog, calls, file, bodies, advance: () => { now += 86400001; }, status: value => { status = value; } };
}
test('public catalog maps exact model identities and variants while preserving native pricing and native Auto', async t => {
  const h = publicCatalog(t); await h.catalog.refresh();
  const profile = h.catalog.profile('codex', 'test-model');
  assert.equal(profile.canonical, 'openai/test-model'); assert.equal(profile.claims.length, 2);
  assert.deepEqual(profile.referencePrices.map(p => [p.provider, p.unit]), [['openai', 'USD/1M tokens'], ['openrouter', 'USD/token']]);
  assert.equal(profile.referencePrices[0].values.input, 1); assert.equal(profile.referencePrices[1].values.prompt, '0.000001');
  assert.equal(h.catalog.profile('cursor', 'shared-name').kind, 'ambiguous');
  assert.equal(h.catalog.profile('codex', 'shared-name').canonical, 'openai/shared-name');
  assert.equal(h.catalog.profile('codex', 'test-model-pro').canonical, 'openai/test-model-pro');
  assert.equal(h.catalog.profile('codex', 'test-model:batch').canonical, 'openai/test-model:batch');
  assert.equal(h.catalog.profile('codex', 'test-model-invented').kind, 'unknown');
  assert.equal(h.catalog.profile('cursor', 'Auto').kind, 'native-router');
  const native = nativeCostSnapshot('codex', [{ id: 'test-model', pricing: { tag: 'Free', unit: 'credits', creditMultiplier: 2 } }], { remaining: 50 });
  const enriched = h.catalog.enrich(native); assert.deepEqual(enriched.models[0].pricing, native.models[0].pricing);
  assert.deepEqual(enriched.usage, native.usage); assert.equal(enriched.models[0].knowledge.sources[0].fetchedAt, 100);
  assert.equal(enriched.models[0].knowledge.sources[0].url, 'https://models.dev/api.json');
  assert.equal(h.calls.some(row => row.source === 'artificial-analysis'), false);
  const run = fixture().run; run.capabilities.unshift(enriched); run.budget = { limit: 10, unit: 'USD' };
  assert.throws(() => validateCost(run, { selfExecute: 'unknown', delegate: 'unknown', overhead: 'included', reason: 'API only', sources: [native.id],
    estimate: { amount: 1, unit: 'USD' } }, { app: 'codex' }), /真实报价/);
});
test('public catalog shares refreshes, persists provenance and marks failed cached data stale without retrying', async t => {
  const h = publicCatalog(t); await Promise.all([h.catalog.refresh(), h.catalog.refresh([{ app: 'codex', model: 'concurrent-new-model' }])]); assert.equal(h.calls.length, 4);
  await h.catalog.refresh(); assert.equal(h.calls.length, 4);
  await h.catalog.refresh([{ app: 'cursor', model: 'Auto' }, { app: 'codex', model: 'concurrent-new-model' }]); assert.equal(h.calls.length, 4);
  const text = h.catalog.document('cursor-billing'); assert.equal(text.text, 'Native Auto & subscription units.'); assert(text.contentHash);
  assert.equal(h.catalog.document('codex-billing').published, 'Sat, 07 Nov 2026 00:00:00 GMT');
  h.advance(); h.status(304); await h.catalog.refresh(); assert.equal(h.calls.length, 8);
  assert(h.calls.slice(4).every(row => row.options.headers['If-None-Match'] === 'fixture-etag'));
  assert.equal(h.catalog.index()[0].fetchedAt, 100); assert.equal(h.catalog.index()[0].stale, false);
  h.advance(); h.status(503); await h.catalog.refresh(); assert.equal(h.calls.length, 12);
  const source = h.catalog.profile('codex', 'test-model').sources[0]; assert.equal(source.status, 'error'); assert.equal(source.stale, true); assert.match(source.error, /503/);
  await h.catalog.refresh(); assert.equal(h.calls.length, 12);
  const reloaded = new FusionModelCatalog({ file: h.file }); assert.equal(reloaded.profile('codex', 'test-model').canonical, 'openai/test-model');
  assert.equal(reloaded.index()[0].status, 'error');
  await h.catalog.refresh([{ app: 'codex', model: 'new-native-model' }]); assert.equal(h.calls.length, 16);
  await h.catalog.refresh([{ app: 'codex', model: 'new-native-model' }]); assert.equal(h.calls.length, 16);
});
test('optional independent measurements retain model, version and units and only headline scores enter the compact index', async t => {
  const h = publicCatalog(t, { aaKey: 'fixture-key' }); await h.catalog.refresh();
  const request = h.calls.find(row => row.source === 'artificial-analysis'); assert.equal(request.options.headers['x-api-key'], 'fixture-key');
  const knowledge = h.catalog.profile('codex', 'test-model'), summary = modelKnowledgeSummary(knowledge);
  assert.equal(knowledge.benchmarks.model.name, 'Test model (published configuration)'); assert.equal(summary.benchmarks.version, 'fixture-v1');
  assert.equal(knowledge.benchmarks.scores.raw_subtest, 99); assert.equal('raw_subtest' in summary.benchmarks.scores, false);
  assert.equal(knowledge.benchmarks.sourceInfo.kind, 'independent-measurement'); assert(summary.description.length <= 160);
});
test('model index bounds default cards, preserves stable pages and provides task fit without inventing or excluding native models', async t => {
  const h = publicCatalog(t); await h.catalog.refresh(); const run = fixture().run;
  const original = nativeCostSnapshot('codex', [{ id: 'test-model', efforts: ['low', 'high'] }, ...Array.from({ length: 14 }, (_, i) => ({ id: 'native-' + i }))], null, {}, 7);
  run.capabilities = [h.catalog.enrich(original), h.catalog.enrich(nativeCostSnapshot('cursor', [{ id: 'Auto' }], null, {}, 8))];
  run.assignments.push({ id: 'used-model', app: 'codex', model: 'test-model' });
  run.attempts.push({ id: 'measured', assignmentId: 'used-model', durationMs: 2000 });
  run.tasks.push({ reviews: [{ attemptId: 'measured', verdict: 'rework' }] });
  const view = fusionModelView(run, 'all', { needs: { kind: 'review', vision: true, tools: true, reasoning: true, minContext: 100000 } }, h.catalog);
  assert.equal(view.total, 16); assert.equal(view.models.length, 8); assert.equal(view.models[1].app, 'cursor');
  assert.equal(view.models[0].fit.vision, 'public-support'); assert.equal(view.models[1].fit.vision, 'unknown');
  assert.equal(view.models[0].history.rework, 1); assert.deepEqual(view.models[0].history.measuredTaskDurations, [2000]);
  const frozen = structuredClone(view.models[0]), next = modelQuery(view.read.input);
  run.capabilities.unshift(nativeCostSnapshot('codex', [{ id: 'new-current-model' }], null));
  const page = fusionModelView(run, 'all', next, h.catalog); assert.equal(page.models.length, 8); assert.equal(page.nextOffset, null);
  const profile = fusionModelView(run, 'codex', modelQuery(frozen.read.input), h.catalog); assert.equal(profile.model.model, 'test-model');
  assert(profile.model.knowledge.claims[0].description.length > 160); assert.equal(profile.snapshotId, original.id);
  const source = view.sources.find(row => row.id === 'codex-billing'); const q = modelQuery(source.read.input);
  const first = fusionModelView(run, 'all', { ...q, length: 100 }, h.catalog); assert.equal(first.text.length, 100); assert.equal(first.nextOffset, 100);
  const second = fusionModelView(run, 'all', { ...q, offset: first.nextOffset, length: 100 }, h.catalog); assert.equal(second.offset, 100);
  assert.equal(h.calls.length, 4); assert.equal(new Set(view.sources.map(row => row.id)).size, view.sources.length);
  assert.throws(() => fusionModelView(run, 'codex', { view: 'profile', model: 'unavailable' }, h.catalog), /原生目录/);
  assert.throws(() => fusionModelView(run, 'codex', { snapshotIds: ['invented'] }, h.catalog), /snapshotIds/);
  assert.throws(() => modelQuery('{'), error => error instanceof FusionControlError && error.feedback.field === 'input'); assert.throws(() => modelQuery('{"needs":[]}'), /needs/);
});
test('model query failures point to exact fields and return a valid first page for the same native snapshots', () => {
  const h=fixture(),id=h.run.capabilities[0].id;
  let feedback;
  assert.throws(()=>modelQuery(JSON.stringify({snapshotIds:[id],limit:1000}),'codex'),error=>{feedback=error.feedback;return error instanceof FusionControlError&&feedback.field==='input.limit';});
  assert.equal(feedback.expected.max,MODEL_PAGE_LIMIT);assert.equal(feedback.read.app,'codex');
  const query=modelQuery(feedback.read.input,feedback.read.app),page=fusionModelView(h.run,feedback.read.app,query);
  assert.deepEqual(page.snapshotIds,[id]);assert.equal(query.limit,undefined);assert(page.models.length<=8);
  assert.throws(()=>modelQuery('{"offset":-1}'),e=>e.feedback.field==='input.offset');
  assert.throws(()=>modelQuery('{"view":"profile"}'),e=>e.feedback.field==='input.model');
  assert.throws(()=>fusionModelView(h.run,'codex',{snapshotIds:[id],offset:999}),e=>e.feedback.field==='input.offset'&&JSON.parse(e.feedback.read.input).snapshotIds[0]===id);
});
