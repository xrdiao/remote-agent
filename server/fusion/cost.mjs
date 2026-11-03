export const FUSION_TIERS = {
  economy: '省钱：满足验收条件，优先降低含规划、评审、上下文传递和返工的预计总成本。',
  balanced: '均衡：同时比较预计总成本、完成时间、质量和返工风险。',
  performance: '性能：优先质量与完成时间，说明额外开销是否值得。',
};

export function nativeCostSnapshot(app, models, usage, at = Date.now()) {
  return { id: `${app}:${at}`, app, at, source: '当前桌面原生模型菜单／账号用量',
    basis: '原生单位；账号用量不能归因为单个任务账单',
    models: models.map(item => ({ model: item.label, efforts: item.efforts || [], pricing: item.pricing || null,
      amount: 'unknown', estimate: item.pricing ? '保留原生报价单位' : '金额未知；仅能作相对成本估计' })),
    usage, available: models.length > 0 };
}

export function validateExecution(run, execution) {
  if (!execution || !['cursor', 'devin', 'codex'].includes(execution.app)) throw new Error('派工缺少有效的软件');
  const snapshot = run.capabilities.find(value => value.app === execution.app);
  if (snapshot && !snapshot.available) throw new Error(`原生 ${execution.app} 能力不可用：${snapshot.error || '尚未就绪'}`);
  const model = snapshot?.models.find(value => value.model === execution.model);
  if (!model) throw new Error(`模型不在本次原生可用候选中：${execution.app} / ${execution.model || '未选择'}`);
  if (model.efforts.length && !model.efforts.some(value => (value.label || value) === execution.effort))
    throw new Error(`思考强度不在该模型实际选项中：${execution.effort || '未选择'}`);
  if (!model.efforts.length && execution.effort) throw new Error('该候选未提供可核实的思考强度');
}

export function validateCost(run, cost) {
  for (const field of ['selfExecute', 'delegate', 'planning', 'review', 'contextTransfer', 'rework', 'reason'])
    if (typeof cost?.[field] !== 'string' || !cost[field].trim()) throw new Error(`成本比较缺少 ${field}`);
  if (!Array.isArray(cost.alternatives) || !cost.alternatives.length) throw new Error('成本比较需要列出实际候选或说明唯一候选');
  for (const alternative of cost.alternatives) {
    validateExecution(run, alternative);
    if (!alternative.reason || !alternative.estimate) throw new Error('备选方案缺少成本估计或比较理由');
  }
  if (!Array.isArray(cost.sources) || !cost.sources.length || cost.sources.some(id => !run.capabilities.some(value => value.id === id)))
    throw new Error('成本资料来源不属于本次原生读取');
  if (run.budget) {
    const estimate = cost.total;
    if (!estimate || estimate.unit !== run.budget.unit || !Number.isFinite(estimate.amount))
      throw new Error('无法用当前成本资料核对用户预算，请通过 ask_user 请求预算决定');
    if (estimate.amount > run.budget.limit) throw new Error('预计总成本超过用户明确预算');
    if (!cost.budgetSource || !run.capabilities.some(value => value.id === cost.budgetSource && value.models.some(model => model.pricing?.currency === estimate.unit)))
      throw new Error('金额预算缺少同单位的真实原生报价依据');
  }
}
