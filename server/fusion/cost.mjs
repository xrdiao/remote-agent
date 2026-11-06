import crypto from 'node:crypto';

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
export function validateExecution(controller, execution) {
  if (!execution || !['cursor', 'devin', 'codex'].includes(execution.app)) throw new Error('请选择实际执行软件');
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
