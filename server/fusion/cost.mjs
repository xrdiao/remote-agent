import crypto from 'node:crypto';
import { nativeAgentProvider } from './providers.mjs';
import { fusionModelCatalog, modelKnowledgeSummary } from './model-catalog.mjs';
import { FusionControlError, MODEL_PAGE_LIMIT, validateModelQuery } from './contract.mjs';
export { modelQuery } from './contract.mjs';

export const FUSION_TIERS = {
  economy: '省钱：满足验收，优先降低包含规划、评审、上下文传递和返工的预计总成本。',
  balanced: '均衡：比较预计总成本、完成时间、质量与返工风险。',
  performance: '性能：优先质量和交付时间，说明额外开销的收益。',
};

export function nativeCostSnapshot(app, models, usage, origin = {}, at = Date.now()) {
  const candidates = models.filter(item => item.id).map(item => ({ model: item.id, label: item.label,
    family: item.family || '', efforts: item.efforts || [], pricing: item.pricing || null, source: item.source || '原生模型菜单',
    amount: 'unknown', basis: item.pricing ? '保留原生报价与单位' : '金额未知；只能作相对成本估计' }));
  return { id: crypto.randomUUID(), app, at, origin, source: '当前桌面原生候选／账号资料',
    basis: '原生单位；账号整体用量不能归因为单个任务账单', models: candidates,
    usage, available: candidates.length > 0 };
}

function modelHistory(controller, app, model, details = false) {
  const assignments = new Set(controller.assignments.filter(row => row.app === app && row.model === model).map(row => row.id));
  const attempts = controller.attempts.filter(row => assignments.has(row.assignmentId));
  const ids = new Set(attempts.map(row => row.id));
  const reviews = controller.tasks.flatMap(task => task.reviews).filter(row => ids.has(row.attemptId));
  return { attempts: attempts.length, accepted: reviews.filter(row => row.verdict === 'accept').length,
    rework: reviews.filter(row => row.verdict === 'rework').length,
    nativeErrors: attempts.filter(row => row.error || row.result?.error).length,
    measuredTaskDurations: attempts.filter(row => Number.isFinite(row.durationMs)).map(row => row.durationMs).slice(-4),
    ...(details ? { observations: attempts.slice(-4).map(row => ({ attemptId: row.id, taskId: row.taskId,
      effort: controller.assignments.find(assignment => assignment.id === row.assignmentId)?.effort,
      status: row.status, durationMs: row.durationMs, usage: row.usage,
      read: { action: 'read_task', taskId: row.taskId, attemptId: row.id } })) } : {}) };
}
function taskFit(knowledge, needs) {
  if (!needs) return;
  return { ...(needs.vision ? { vision: knowledge.input?.includes('image') ? 'public-support' : knowledge.input?.length ? 'not-advertised' : 'unknown' } : {}),
    ...(needs.tools ? { tools: knowledge.tools === true ? 'public-support' : knowledge.tools === false ? 'not-advertised' : 'unknown' } : {}),
    ...(needs.reasoning ? { reasoning: knowledge.reasoning === true ? 'public-support' : knowledge.reasoning === false ? 'not-advertised' : 'unknown' } : {}),
    ...(needs.minContext ? { context: knowledge.publicContext ? knowledge.publicContext >= needs.minContext ? 'public-limit-fits' : 'public-limit-below-need' : 'unknown' } : {}) };
}
export function fusionModelView(controller, app, query = {}, catalog = fusionModelCatalog) {
  validateModelQuery(query, app);
  const current = controller.capabilities.filter((snapshot, index, all) => (app === 'all' || snapshot.app === app)
    && (query.snapshotIds ? query.snapshotIds.includes(snapshot.id) : all.findIndex(row => row.app === snapshot.app) === index));
  if (query.snapshotIds && (!Array.isArray(query.snapshotIds) || current.length !== query.snapshotIds.length)) throw new FusionControlError('模型资料 snapshotIds 不属于所选软件', 'input.snapshotIds', '本次所选原生软件的快照ID数组', { action: 'list_models', app });
  const snapshots = current.map(row => row.id), selector = value => ({ action: 'list_models', app,
    input: JSON.stringify({ ...value, ...(query.needs ? { needs: query.needs } : {}), snapshotIds: snapshots }) });
  if (query.view === 'source') {
    const document = catalog.document(query.source), offset = query.offset ?? 0, length = query.length ?? 6000;
    if (offset > (document.text?.length || 0)) throw new FusionControlError('资料原文分页 offset/length 无效', 'input.offset',
      { min: 0, max: document.text?.length || 0 }, selector({ view: 'source', source: query.source }));
    const end = Math.min((document.text?.length || 0), offset + length);
    return { ...document, text: document.text?.slice(offset, end) || '', offset, totalCharacters: document.text?.length || 0,
      nextOffset: end < (document.text?.length || 0) ? end : null };
  }
  if (query.view === 'profile') {
    const snapshot = current.find(row => row.models.some(model => model.model === query.model));
    const model = snapshot?.models.find(row => row.model === query.model);
    if (!model) throw new FusionControlError('型号不属于所选原生目录', 'input.model', '复制模型索引中对应型号的read', selector({}));
    return { app: snapshot.app, snapshotId: snapshot.id, model,
      publicSources: snapshot.publicSources || [], history: modelHistory(controller, snapshot.app, model.model, true) };
  }
  const groups = current.map(row => row.models.map(model => ({ snapshot: row, model })));
  const rows = []; for (let i = 0; groups.some(group => i < group.length); i++) for (const group of groups) if (group[i]) rows.push(group[i]);
  const offset = query.offset ?? 0, limit = query.limit ?? MODEL_PAGE_LIMIT;
  if (offset > rows.length) throw new FusionControlError('模型索引分页需要有效 offset，limit 为 1–8', 'input.offset', { min: 0, max: rows.length, paging: '复制返回read' }, selector({}));
  const end = Math.min(rows.length, offset + limit);
  const sources = [...new Map(current.flatMap(row => row.publicSources || []).map(source => [source.id, source])).values()];
  return { app, snapshotIds: snapshots, available: current.some(row => row.available), total: rows.length, offset, pageLimit: MODEL_PAGE_LIMIT,
    apps: current.map(row => ({ app: row.app, id: row.id, at: row.at, available: row.available, error: row.error,
      modelCount: row.models.length, nativeIds: row.models.slice(0, 12).map(model => model.model),
      read: { action: 'list_models', app: row.app, input: JSON.stringify({ snapshotIds: [row.id] }) } })),
    sources: sources.map(source => ({ ...source, ...(source.kind === 'official-software-document'
      ? { read: selector({ view: 'source', source: source.id }) } : {}) })),
    models: rows.slice(offset, end).map(({ snapshot, model }) => { const knowledge = modelKnowledgeSummary(model.knowledge); return { app: snapshot.app, model: model.model, label: model.label,
      snapshotId: snapshot.id, efforts: model.efforts.map(row => row.label || row), pricing: model.pricing,
      knowledge, fit: taskFit(knowledge, query.needs), history: modelHistory(controller, snapshot.app, model.model),
      read: { action: 'list_models', app: snapshot.app, input: JSON.stringify({ view: 'profile', model: model.model, snapshotIds: [snapshot.id] }) } }; }),
    nextOffset: end < rows.length ? end : null, ...(end < rows.length ? { read: selector({ offset: end, limit }) } : {}),
    basis: '仅原生候选；公开能力/API价作参考，套餐及额度单列。历史总耗时含工具等待、错误不直接代表模型能力。按任务比较并引用snapshotId，不按API价承诺桌面账单。' };
}
export function validateExecution(controller, execution) {
  if (!execution?.app || !nativeAgentProvider(execution.app).worker) throw new Error('请选择实际执行软件');
  const snapshot = controller.capabilities.find(row => row.app === execution.app);
  if (!snapshot?.available) throw new Error(`尚无 ${execution.app} 的可用原生候选：${snapshot?.error || '请先 list_models'}`);
  const model = snapshot.models.find(row => row.model === execution.model);
  if (!model) throw new Error(`模型不属于本次原生候选：${execution.model || '未选择'}`);
  if (model.efforts.length && !model.efforts.some(row => (row.label || row) === execution.effort)) throw new Error('思考强度不属于该模型实际选项');
  if (!model.efforts.length && execution.effort) throw new Error('该模型没有可核实的思考强度');
  return model;
}
export function validateCost(controller, cost, execution) {
  for (const field of ['selfExecute', 'delegate', 'overhead', 'reason'])
    if (typeof cost?.[field] !== 'string' || !cost[field].trim()) throw new Error(`成本选择需要 ${field}`);
  if (!Array.isArray(cost.sources) || !cost.sources.length || cost.sources.some(id => !controller.capabilities.some(row => row.id === id)))
    throw new Error('成本来源不属于实际读取的原生资料');
  if (!controller.capabilities.some(row => row.app === execution.app && cost.sources.includes(row.id))) throw new Error('缺少选中软件的成本／能力来源');
  if (!controller.budget) return;
  const estimate = cost.estimate, budget = controller.budget;
  if (!estimate || !Number.isFinite(estimate.amount) || estimate.amount < 0 || estimate.unit !== budget.unit)
    throw new Error('显式预算无法按当前原生单位核对，请先向用户确认');
  const quoted = controller.capabilities.some(row => cost.sources.includes(row.id) && row.models.some(model =>
    model.pricing && (model.pricing.unit === budget.unit || model.pricing.currency === budget.unit)));
  if (!quoted) throw new Error('原生资料没有该预算单位的真实报价，不能推算桌面订阅账单');
  let reserved = 0;
  const estimates = controller.assignments.flatMap(assignment => {
    const attempts = controller.attempts.filter(row => row.assignmentId === assignment.id);
    return attempts.every(row => row.status === 'cancelled' && row.submission === 'not_submitted') ? [] : [assignment.cost?.estimate];
  });
  estimates.push(...controller.works.flatMap(work => work.plans.filter(plan => plan.confirmed && plan.mainScope?.length)
    .map(plan => plan.cost?.estimate)));
  for (const previous of estimates) {
    if (!previous || previous.unit !== budget.unit || !Number.isFinite(previous.amount)) throw new Error('已有执行含未知成本，不能承诺精确预算边界');
    reserved += previous.amount;
  }
  if (reserved + estimate.amount > budget.limit) throw new Error('并发预留与已登记执行的预计总成本超过用户预算');
}
