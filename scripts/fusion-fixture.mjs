import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { newFusionRun, fusionRuns, fusionProject } from '../server/fusion/state.mjs';
import { fusionStore } from '../server/fusion/store.mjs';
import { nativeCostSnapshot } from '../server/fusion/cost.mjs';
import { applyFusionControl } from '../server/fusion/control.mjs';
const directory = fileURLToPath(new URL('../_shots/fusion-superagent-unit/', import.meta.url));
fs.mkdirSync(directory, { recursive: true });
fusionStore.file = path.join(directory, `${process.pid}-${crypto.randomUUID()}.json`);
export const flush = async () => { for (let n = 0; n < 8; n++) await new Promise(resolve => setImmediate(resolve)); };
export function fixture() {
  const project = fusionProject(directory);
  const run = newFusionRun('test', project, { app: 'codex', model: 'cheap', effort: 'low' });
  run.bindings.push({ id: 'main', role: 'main', app: 'codex', threadId: 'main-thread', windowId: 'shared', host: '', project });
  run.main.bindingId = 'main';
  run.capabilities = ['codex', 'cursor', 'devin'].map(app => nativeCostSnapshot(app,
    [{ id: app === 'cursor' ? 'Auto' : 'cheap', label: app === 'cursor' ? 'Auto' : 'Cheap', efforts: app === 'cursor' ? [] : ['low'] }], null, { host: '', windowId: 'shared' }, 10));
  fusionRuns.test = { current: run.id, runs: [run] };
  let requestSerial = 0;
  const native = () => ({ threadId: 'main-thread', turnId: 'native-turn', requestId: requestSerial++, decisionId: crypto.randomUUID() });
  const request = action => {
    if (action.action !== 'dispatch' || !Array.isArray(action.tasks)) return action;
    const choices = action.input === undefined ? Object.fromEntries(action.tasks.map(task => [task.id,
      { workerId: null, reason: 'Fixture explicitly selects an independent new worker' }])) : JSON.parse(action.input);
    for (const task of action.tasks) if (choices[task.id]) choices[task.id].label ??= `Analysis ${task.id}`;
    return { ...action, input: JSON.stringify(choices) };
  };
  const apply = action => applyFusionControl(run, request(action), native());
  const cost = app => ({ selfExecute: 'unknown; short context', delegate: 'unknown; low cost', overhead: 'planning, review, context transfer and rework included',
    reason: 'relative total cost suits the task', sources: [run.capabilities.find(row => row.app === app).id] });
  const create = () => apply({ action: 'create_work', title: 'Work', goal: 'Read and verify' }).workId;
  const plan = (workId, requiresConfirmation = false) => apply({ action: 'plan', workId, scope: ['.'], summary: 'Read the selected project',
    criteria: [{ id: 'C1', text: 'Evidence available' }], requiresConfirmation });
  const task = (id, app = 'codex', dependsOn = []) => ({ id, goal: `Task ${id}`, scope: ['.'], access: 'read', acceptance: ['Evidence'], dependsOn,
    execution: { app, model: app === 'cursor' ? 'Auto' : 'cheap', effort: app === 'cursor' ? '' : 'low', input: 'Read only, report evidence' }, cost: cost(app) });
  return { run, apply, request, native, cost, create, plan, task, project };
}
