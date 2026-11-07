import path from 'node:path';

export const FUSION_READ_ACTIONS = ['read_workspace', 'read_task', 'list_projects', 'list_models'];
export const FUSION_ACTIONS = [...FUSION_READ_ACTIONS, 'create_work', 'plan', 'dispatch',
  'continue_task', 'review', 'wait', 'ask_user', 'cancel_task', 'finish', 'set_priority'];
export const ACTION_FIELDS = {
  read_task: ['taskId'], list_models: ['app'], create_work: ['title', 'goal'],
  plan: ['workId', 'summary', 'scope', 'criteria', 'requiresConfirmation'], dispatch: ['workId', 'tasks', 'input'],
  continue_task: ['taskId', 'input', 'execution', 'cost'], review: ['taskId', 'attemptId', 'verdict', 'reason', 'summary'],
  ask_user: ['workId', 'question'], cancel_task: ['taskId', 'reason'],
  finish: ['workId', 'summary', 'evidence'], set_priority: ['taskId', 'priority'],
};
export const WORKSPACE_VIEWS = ['overview', 'worker', 'reviews', 'history', 'protocol'];
export const MODEL_VIEWS = ['index', 'profile', 'source'];
export const MODEL_PAGE_LIMIT = 8;
export const EVIDENCE_FIELDS = { criterion: '返回的标准ID，不是标准正文', detail: '主控实际核对的证据和结论',
  reference: '证据位置，不是执行ID', attemptId: 'finish每项明确来源执行ID；review使用顶层attemptId' };
export class FusionControlError extends Error {
  constructor(message, field, expected, read) {
    super(message); this.feedback = { message, field, expected, ...(read ? { read } : {}) };
  }
}
const workspaceIndex = () => ({ action: 'read_workspace' });
function queryObject(action, input, read) {
  let query;
  try { query = input === undefined ? {} : JSON.parse(input); }
  catch { throw new FusionControlError(`${action} input 需要有效的 JSON 对象`, 'input', 'JSON.stringify(object)，或省略input', read); }
  if (!query || typeof query !== 'object' || Array.isArray(query))
    throw new FusionControlError(`${action} input 需要有效的 JSON 对象`, 'input', 'JSON对象，或省略input', read);
  return query;
}
export function workspaceQuery(input, workId) {
  const read = typeof workId === 'string' && workId.trim() ? { action: 'read_workspace', workId } : workspaceIndex();
  const query = queryObject('read_workspace', input, read);
  if (workId !== undefined) {
    if (typeof workId !== 'string' || !workId.trim()) throw new FusionControlError('工作详情需要顶层workId', 'workId', 'works[].id，复制对应read', read);
    if (query.view !== undefined || query.id !== undefined) throw new FusionControlError('工作详情由顶层workId选择，input只填section及分页条件',
      'input', '省略input，或仅给section/offset/length', read);
    return { ...query, view: 'work', id: workId };
  }
  if (query.view === 'work') throw new FusionControlError('工作详情请使用顶层workId，不再使用input.view/id', 'workId', 'works[].id，复制对应read',
    typeof query.id === 'string' && query.id.trim() ? { action: 'read_workspace', workId: query.id } : read);
  if (query.view && !WORKSPACE_VIEWS.includes(query.view)) throw new FusionControlError('read_workspace input 需要有效的 view JSON 对象；子代理列表在默认agents',
    'input.view', { values: WORKSPACE_VIEWS, agents: '默认回执agents为子代理索引；复制agents[].read读取详情' }, read);
  if (query.view === 'worker' && (typeof query.id !== 'string' || !query.id.trim()))
    throw new FusionControlError('worker详情需要id；列表从默认read_workspace读取', 'input.id', 'agents[].id，复制对应read', read);
  return query;
}
export function modelQuery(input, app = 'all') {
  return validateModelQuery(queryObject('list_models', input, { action: 'list_models', app }), app);
}
export function validateModelQuery(query, app = 'all') {
  const read = { action: 'list_models', app, ...(Array.isArray(query.snapshotIds) ? { input: JSON.stringify({ snapshotIds: query.snapshotIds }) } : {}) };
  if (query.view && !MODEL_VIEWS.includes(query.view)) throw new FusionControlError('list_models input 需要 index/profile/source JSON 对象', 'input.view', MODEL_VIEWS, read);
  if (query.snapshotIds !== undefined && !Array.isArray(query.snapshotIds)) throw new FusionControlError('模型资料 snapshotIds 需要数组', 'input.snapshotIds', '返回的原生快照ID数组', { action: 'list_models', app });
  if (query.needs !== undefined && (!query.needs || typeof query.needs !== 'object' || Array.isArray(query.needs))) throw new FusionControlError('模型需求 needs 需要对象', 'input.needs', '任务需求JSON对象', read);
  if (!query.view || query.view === 'index') {
    if (query.offset !== undefined && (!Number.isInteger(query.offset) || query.offset < 0))
      throw new FusionControlError('模型索引分页需要有效 offset，limit 为 1–8', 'input.offset', '非负整数；复制返回read分页', read);
    if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MODEL_PAGE_LIMIT))
      throw new FusionControlError('模型索引分页需要有效 offset，limit 为 1–8', 'input.limit', { min: 1, max: MODEL_PAGE_LIMIT, paging: '复制返回read，无需自行设置limit' }, read);
  }
  if (query.view === 'source') {
    if (query.offset !== undefined && (!Number.isInteger(query.offset) || query.offset < 0))
      throw new FusionControlError('资料原文分页 offset/length 无效', 'input.offset', '非负整数；沿nextOffset分页', read);
    if (query.length !== undefined && (!Number.isInteger(query.length) || query.length <= 0))
      throw new FusionControlError('资料原文分页 offset/length 无效', 'input.length', '正整数', read);
  }
  const field = query.view === 'profile' ? 'model' : query.view === 'source' ? 'source' : null;
  if (field && (typeof query[field] !== 'string' || !query[field].trim()))
    throw new FusionControlError(`模型详情需要${field}`, `input.${field}`, '复制对应模型或资料源的read', read);
  return query;
}
export function scopeList(value, field, read) {
  const expected = { type: '非空项目相对路径列表', example: ['.'], note: "'.'表示项目根目录；仅在需要该范围时选择，解释写summary" };
  if (!Array.isArray(value) || !value.length || value.some(item => typeof item !== 'string' || !item.trim()))
    throw new FusionControlError(`${field} 需要非空文字列表`, field, expected, read);
  for (const item of value) {
    const file = item.replaceAll('\\', '/'), normalized = path.posix.normalize(file);
    if (path.posix.isAbsolute(file) || /^[a-z]:\//i.test(file) || normalized === '..' || normalized.startsWith('../'))
      throw new FusionControlError(`${field} 需要项目相对路径：${item}`, field, expected, read);
  }
  return value;
}
export function validateFusionAction(action) {
  if (!action || !FUSION_ACTIONS.includes(action.action)) throw new FusionControlError('未知或缺少 RA 管理动作', 'action', FUSION_ACTIONS, workspaceIndex());
  const missing = (ACTION_FIELDS[action.action] || []).filter(field => action[field] === undefined || action[field] === null);
  if (action.action === 'review' && action.verdict === 'accept' && action.evidence === undefined) missing.push('evidence');
  if (missing.length) throw new FusionControlError(`${action.action} 缺少参数：${missing.join(', ')}；请按 read_workspace.protocol.required 一次补齐`,
    missing[0], ACTION_FIELDS[action.action], { action: 'read_workspace', input: JSON.stringify({ view: 'protocol' }) });
  if (action.action === 'plan' && action.tasks !== undefined) throw new FusionControlError('plan 仅登记范围和完成标准；请将 tasks 交给 dispatch，不能将方案登记当作任务已派发', 'tasks', 'tasks属于dispatch，plan不派工', workspaceIndex());
  if (action.action === 'list_models') return modelQuery(action.input, action.app);
  if (action.action === 'read_workspace') return workspaceQuery(action.input, action.workId);
}
const string = { type: 'string' }, strings = { type: 'array', items: string };
const scope = { ...strings, minItems: 1, description: 'Non-empty project-relative filesystem paths; ["."] means the project root. Put explanations in summary, never inside a path.' };
const criterion = { type: 'object', additionalProperties: false, required: ['id', 'text'], properties: { id: string, text: string } };
const execution = { type: 'object', additionalProperties: false, required: ['app', 'model', 'effort', 'input'], properties: {
  app: { ...string, description: 'A registered native application ID from read_workspace.apps.' }, model: { ...string, description: 'Exact model ID returned by list_models.' }, effort: string, input: string,
} };
const cost = { type: 'object', additionalProperties: false, required: ['selfExecute', 'delegate', 'overhead', 'reason', 'sources'], properties: {
  selfExecute: string, delegate: string, overhead: { ...string, description: 'Include planning, review, context transfer and rework.' }, reason: string,
  sources: { ...strings, description: 'IDs of real capability snapshots, not event IDs.' },
  estimate: { type: 'object', additionalProperties: false, required: ['amount', 'unit'], properties: { amount: { type: 'number' }, unit: string } },
} };
const task = { type: 'object', additionalProperties: false, required: ['goal', 'scope', 'access', 'dependsOn', 'acceptance'], properties: {
  id: string, goal: string, scope, access: { type: 'string', enum: ['read', 'write'] },
  dependsOn: { ...strings, description: 'Main-selected predecessor task IDs. All must be accepted before execution; independent tasks may run concurrently regardless of app, project or write access.' },
  acceptance: { ...strings, minItems: 1, description: 'An array of plain criterion text, not objects. RA returns the resulting criterion IDs.' },
  required: { type: 'boolean' }, priority: { type: 'integer' },
} };
const dispatchedTask = { ...task, required: [...task.required, 'id', 'execution', 'cost'], properties: { ...task.properties, execution, cost } };
const evidence = { type: 'object', additionalProperties: false, required: ['criterion', 'detail', 'reference'], properties: {
  ...Object.fromEntries(Object.entries(EVIDENCE_FIELDS).map(([name, description]) => [name, { ...string, description }])),
} };
export const FUSION_TOOLS = [{ type: 'function', name: 'ra_fusion',
  description: '管理 RA 原生子 Agent；主 Agent 自己的工作直接使用普通原生能力，无需工作台登记。管理子任务时按需 read_workspace，遵循 AGENTS.md 与用户授权；登记／排队不等于已执行或已验收。',
  inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: FUSION_ACTIONS }, workId: { ...string, description: 'read_workspace工作详情直接填此ID；input只填section及分页条件。其他动作使用同一真实工作ID。' }, taskId: string, attemptId: string,
    title: string, goal: string, project: { type: 'object', additionalProperties: false, required: ['root'], properties: { root: string, host: string } }, app: { ...string, description: 'list_models: native app ID, or all for connected software. Execution always uses a native app ID.' }, summary: { ...string, description: 'review: concise work memory with conclusion, verification and remaining issues; do not copy logs. plan/finish: scope or delivery summary.' }, scope,
    criteria: { type: 'array', minItems: 1, items: criterion }, requiresConfirmation: { type: 'boolean' }, policyEvidence: string,
    tasks: { type: 'array', minItems: 1, items: dispatchedTask },
    input: { ...string, description: `read_workspace默认agents含职责及memory预览；详情用顶层workId，input仅section/offset/length；其他view=${WORKSPACE_VIEWS.join('/')}，worker需id。list_models默认${MODEL_PAGE_LIMIT}张，翻页／详情复制read；needs可写任务需求。dispatch.input按taskId给{workerId:null或已有id,label:职责短名,reason,compared:[{workerId,reason}]}；有同软件同项目候选时新建须比较实际读过的候选。continue_task只写变化并明确execution。read_task默认证据索引；按返回模板review或明确处理失败。ask_user可用attemptId关联待处理执行。` },
    execution, cost,
    verdict: { type: 'string', enum: ['accept', 'rework'] }, evidence: { type: 'array', items: evidence },
    reason: string, question: string, options: strings, priority: { type: 'integer' },
  } },
}];

