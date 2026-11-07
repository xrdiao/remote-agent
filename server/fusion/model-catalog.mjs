import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../../lib/auth.mjs';

const DAY = 24 * 60 * 60 * 1000;
const SOURCES = [
  { id: 'models.dev', url: 'https://models.dev/api.json', kind: 'model-catalog' },
  { id: 'openrouter', url: 'https://openrouter.ai/api/v1/models', kind: 'model-catalog' },
  { id: 'codex-billing', app: 'codex', url: 'https://learn.chatgpt.com/docs/pricing.md', kind: 'official-software-document' },
  { id: 'cursor-billing', app: 'cursor', url: 'https://prod.cursor.com/help/models-and-usage/usage-limits', kind: 'official-software-document' },
];
const short = (value, length) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, length);
const suffix = id => id.slice(id.indexOf('/') + 1);
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function normalize(source, body) {
  if (source.id === 'models.dev') return Object.entries(body).flatMap(([provider, data]) => Object.values(data.models || {}).map(model => {
    const canonical = model.canonical_model_id || (model.id.includes('/') ? model.id : `${provider}/${model.id}`);
    return { canonical, ids: [model.id, canonical], provider, name: model.name, description: model.description || '',
      modalities: model.modalities, reasoning: model.reasoning, reasoningOptions: model.reasoning_options,
      tools: model.tool_call, limits: model.limit, released: model.release_date, updated: model.last_updated,
      official: provider === canonical.split('/')[0], documentation: data.doc || null,
      referencePrice: { kind: 'api-reference', provider, unit: 'USD/1M tokens', values: model.cost || null } };
  }));
  if (source.id === 'openrouter') return body.data.map(model => ({
    canonical: model.id, ids: [model.id, model.canonical_slug].filter(Boolean), provider: 'openrouter', name: model.name,
    description: model.description || '', modalities: { input: model.architecture?.input_modalities, output: model.architecture?.output_modalities },
    reasoning: model.supported_parameters?.includes('reasoning'), reasoningOptions: model.reasoning,
    tools: model.supported_parameters?.includes('tools'), limits: { context: model.context_length, output: model.top_provider?.max_completion_tokens },
    released: model.created ? new Date(model.created * 1000).toISOString() : null, documentation: model.links || null,
    referencePrice: { kind: 'api-reference', provider: 'openrouter', unit: 'USD/token', values: model.pricing || null },
  }));
  if (source.id === 'artificial-analysis') return body.data.map(model => ({
    canonical: model.slug, ids: [model.slug], provider: 'artificial-analysis', name: model.name,
    benchmarks: { source: 'Artificial Analysis', model: { id: model.id, slug: model.slug, name: model.name }, version: body.intelligence_index_version,
      scores: model.evaluations, performance: model.performance || model.performance_v3, releaseDate: model.release_date },
    referencePrice: { kind: 'api-reference', provider: 'artificial-analysis', unit: 'USD/1M tokens', values: model.pricing || null },
  }));
  const text = String(body).replace(/<(script|style|nav)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').trim();
  return { text, contentHash: fingerprint(text), basis: '软件官方文档；适用套餐及费率需结合本机原生资料核对' };
}

export class FusionModelCatalog {
  constructor({ file = path.join(DATA_DIR, 'fusion-model-catalog.json'), fetch = globalThis.fetch, now = Date.now,
    aaKey = process.env.FUSION_AA_API_KEY || '' } = {}) {
    this.file = file; this.fetch = fetch; this.now = now; this.aaKey = aaKey;
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { sources: [] };
    this.observed = new Set();
  }
  sources() {
    return [...SOURCES, ...(this.aaKey ? [{ id: 'artificial-analysis', kind: 'independent-measurement',
      url: 'https://artificialanalysis.ai/api/v2/language/models/free' }] : [])];
  }
  async refresh(native = []) {
    const newUnknown = native.some(({ app, model }) => !this.observed.has(`${app}:${model}`)
      && ['unknown', 'ambiguous'].includes(this.profile(app, model).kind));
    native.forEach(({ app, model }) => this.observed.add(`${app}:${model}`));
    if (this.refreshing) return this.refreshing;
    const needed = this.sources().filter(source => {
      const previous = this.data.sources.find(row => row.id === source.id);
      return newUnknown || !previous?.checkedAt || this.now() - previous.checkedAt >= DAY;
    });
    if (!needed.length) return;
    this.refreshing = Promise.all(needed.map(async source => {
      const previous = this.data.sources.find(row => row.id === source.id);
      const at = this.now();
      try {
        const response = await this.fetch(source.url, { signal: AbortSignal.timeout(15000), headers: {
          ...(previous?.etag ? { 'If-None-Match': previous.etag } : {}),
          ...(source.id === 'artificial-analysis' ? { 'x-api-key': this.aaKey } : {}),
        } });
        if (response.status === 304) return { ...previous, checkedAt: at, status: 'ready', error: '' };
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const value = source.kind === 'official-software-document' ? await response.text() : await response.json();
        return { ...source, checkedAt: at, fetchedAt: at, status: 'ready', etag: response.headers.get('etag'),
          published: response.headers.get('last-modified'), value: normalize(source, value) };
      } catch (error) {
        return { ...previous, ...source, checkedAt: at, status: 'error', error: error.message };
      }
    })).then(rows => {
      const updated = new Map(this.data.sources.map(row => [row.id, row])); rows.forEach(row => updated.set(row.id, row));
      this.data.sources = [...updated.values()];
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.file + '.pending', JSON.stringify(this.data), { mode: 0o600 }); fs.renameSync(this.file + '.pending', this.file);
    }).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  sourceView(source) {
    return { id: source.id, url: source.url, kind: source.kind, app: source.app, status: source.status,
      fetchedAt: source.fetchedAt, checkedAt: source.checkedAt, published: source.published || null, contentHash: source.value?.contentHash,
      stale: source.status !== 'ready' || this.now() - source.checkedAt >= DAY, error: source.error || '' };
  }
  index() { return this.data.sources.map(source => this.sourceView(source)); }
  document(id) {
    const source = this.data.sources.find(row => row.id === id);
    if (!source || source.kind !== 'official-software-document') throw new Error('没有这个官方资料源');
    return { ...this.sourceView(source), ...source.value };
  }
  profile(app, id) {
    if (app === 'cursor' && ['default', 'auto', 'Auto', 'auto-smart'].includes(id)) return {
      kind: 'native-router', description: 'Cursor 原生 Auto；内部型号未知，按当前软件计费口径比较。', sources: [],
    };
    const records = this.data.sources.filter(source => source.kind === 'model-catalog')
      .flatMap(source => (source.value || []).filter(model => model.ids.includes(id) || suffix(model.canonical) === id)
        .map(model => ({ ...model, source: this.sourceView(source) })));
    const candidates = records.filter(model => app !== 'codex' || model.canonical.startsWith('openai/'));
    const identities = [...new Set(candidates.map(model => model.canonical))];
    if (identities.length !== 1) return { kind: identities.length ? 'ambiguous' : 'unknown', sources: [], canonical: null };
    const canonical = identities[0];
    const selected = ['models.dev', 'openrouter'].flatMap(name => {
      const rows = candidates.filter(model => model.source.id === name);
      const chosen = rows.find(model => model.official) || rows[0]; return chosen ? [chosen] : [];
    });
    const claims = selected.map(({ source, provider, name, description, modalities, reasoning, reasoningOptions, tools, limits, released, updated, documentation }) =>
      ({ source: source.id, provider, name, description, modalities, reasoning, reasoningOptions, tools, limits, released, updated, documentation }));
    const benchmarkSource = this.data.sources.find(source => source.id === 'artificial-analysis');
    const measured = benchmarkSource?.value?.find(model => model.canonical === suffix(canonical));
    const description = selected.find(model => model.description);
    return { kind: 'model', canonical, description: description?.description || '', descriptionSource: description?.source.id, claims,
      sources: selected.map(model => model.source),
      referencePrices: selected.map(model => ({ ...model.referencePrice, source: model.source.id })),
      ...(measured ? { benchmarks: { ...measured.benchmarks, sourceInfo: this.sourceView(benchmarkSource) } } : {}) };
  }
  enrich(snapshot) {
    return { ...snapshot, publicSources: this.index(), models: snapshot.models.map(model => ({ ...model,
      knowledge: this.profile(snapshot.app, model.model) })) };
  }
}

export function modelKnowledgeSummary(knowledge) {
  if (!knowledge) return { kind: 'unknown' };
  const claim = knowledge.claims?.[0];
  return { kind: knowledge.kind, canonical: knowledge.canonical, description: short(knowledge.description, 160), descriptionSource: knowledge.descriptionSource,
    input: claim?.modalities?.input, reasoning: claim?.reasoning, tools: claim?.tools, publicContext: claim?.limits?.context,
    apiReference: knowledge.referencePrices?.map(({ source, provider, unit, values }) => ({ source, provider, unit,
      input: values?.input ?? values?.prompt, output: values?.output ?? values?.completion, tiered: !!(values?.tiers || values?.overrides) })),
    benchmarks: knowledge.benchmarks ? { model: knowledge.benchmarks.model, version: knowledge.benchmarks.version,
      scores: Object.fromEntries(Object.entries(knowledge.benchmarks.scores || {}).filter(([key]) => /intelligence_index|coding_index|agentic_index/.test(key))) } : undefined,
    sourceIds: knowledge.sources?.map(source => source.id) };
}

export const fusionModelCatalog = new FusionModelCatalog();
