import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DATA_DIR } from '../../lib/auth.mjs';
import { IS_WIN } from '../../lib/platform.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const records = value => Array.isArray(value) && value.every(object);
const string = value => typeof value === 'string';
const strings = value => Array.isArray(value) && value.every(string);
// Older v2 Fusion runs may already persist finite scalar question choices.
const questionOptions = value => Array.isArray(value) && value.every(option => string(option)
  || typeof option === 'boolean' || typeof option === 'number' && Number.isFinite(option));
const optional = (value, validate) => value == null || validate(value);
const project = value => object(value) && string(value.id) && string(value.root);
const collections = ['works', 'tasks', 'agents', 'assignments', 'attempts', 'bindings', 'events', 'commands', 'effects', 'questions', 'capabilities'];

const criterion = row => object(row) && string(row.id) && string(row.text);
const criteria = value => Array.isArray(value) && value.every(criterion);
const creationOwner = row => optional(row.creations, records);
const plan = row => strings(row.scope) && criteria(row.criteria) && optional(row.mainScope, strings);
const delivery = row => optional(row.evidence, records) && optional(row.eventIds, strings);
const work = row => project(row.project) && records(row.plans) && row.plans.every(plan)
  && records(row.deliveries) && row.deliveries.every(delivery)
  && (row.candidate == null || object(row.candidate) && strings(row.candidate.eventIds) && delivery(row.candidate));
const task = row => records(row.inputs) && records(row.reviews) && row.reviews.every(review =>
  optional(review.evidence, records) && string(review.reason))
  && strings(row.attemptIds) && strings(row.dependsOn) && strings(row.assignmentIds)
  && strings(row.scope) && criteria(row.acceptance);
const snapshot = value => value == null || object(value) && (value.diff === undefined || string(value.diff))
  && (value.available ? records(value.files) : optional(value.files, records)) && optional(value.untracked, records);
const attempt = row => optional(row.beforeIds, strings) && optional(row.inputIds, strings) && optional(row.eventIds, strings) && optional(row.planDecisionIds, strings)
  && snapshot(row.baseline) && snapshot(row.changes) && optional(row.native, object)
  && (row.promptContext == null || object(row.promptContext)
    && (row.promptContext.version !== 1 || object(row.promptContext.fields)))
  && (row.result == null || object(row.result) && (row.result.text === undefined || string(row.result.text)) && optional(row.result.error, string))
  && (row.workExecutions == null || records(row.workExecutions) && row.workExecutions.every(entry =>
    (entry.scope === undefined || strings(entry.scope)) && snapshot(entry.baseline) && snapshot(entry.changes)))
  && (row.reviewBatch == null || object(row.reviewBatch) && strings(row.reviewBatch.attemptIds)
    && records(row.reviewBatch.delivered) && optional(row.reviewBatch.remaining, strings));
const capability = row => records(row.models) && row.models.every(model => string(model.model)
  && Array.isArray(model.efforts) && model.efforts.every(effort => string(effort) || object(effort) && string(effort.label)));
const effect = row => object(row.data) && optional(row.data.eventIds, strings)
  && (row.kind !== 'native-cleanup' || row.status !== 'done' || object(row.receipt)
    && string(row.data.bindingId) && string(row.data.threadId) && row.id === `native-cleanup:${row.data.bindingId}`
    && row.receipt.confirmed === true && ['delete', 'archive'].includes(row.receipt.action));

function validateRun(run, deviceId) {
  if (!object(run) || !run.id || !string(run.id) || run.deviceId !== deviceId || !string(deviceId) || !string(run.computer)
      || !Number.isSafeInteger(run.revision) || !project(run.project) || !object(run.main)
      || !string(run.main.app) || !string(run.main.bindingId) || !creationOwner(run.main)
      || !collections.every(key => records(run[key])) || !strings(run.observedMainMessages) || !strings(run.observedMainTurns)
      || !run.agents.every(creationOwner)
      || !run.bindings.every(row => string(row.id) && string(row.app) && string(row.windowId) && string(row.threadId)
        && project(row.project) && optional(row.workerReads, records))
      || run.main.bindingId && !run.bindings.some(row => row.id === run.main.bindingId && row.role === 'main' && row.app === run.main.app)
      || !run.works.every(work) || !run.tasks.every(task) || !run.attempts.every(attempt) || !run.capabilities.every(capability)
      || !run.questions.every(row => string(row.text) && questionOptions(row.options))
      || !run.events.every(row => object(row.data) && optional(row.data.text, string))
      || !run.commands.every(row => object(row.native) && string(row.native.turnId)
        && object(row.result) && optional(row.result.tasks, records))
      || !run.effects.every(effect)) {
    throw new Error('Fusion v2 工作台记录结构无效');
  }
}

export class FusionStore {
  constructor(file = path.join(DATA_DIR, 'fusion.json')) {
    this.file = file;
    this.directory = file + '.runs';
    this.sequence = 0;
    this.unreadable = new Set();
  }
  runFile(deviceId, id) {
    const key = createHash('sha256').update(JSON.stringify([deviceId, id])).digest('hex');
    return path.join(this.directory, key + '.json');
  }
  load(report) {
    const owners = Object.create(null);
    const owner = id => owners[id] ||= { current: '', runs: [] };
    let index;
    try {
      index = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (index?.version !== 2 || !object(index.owners)) throw new Error('Fusion 索引不是 v2 格式');
    } catch (error) {
      if (error.code !== 'ENOENT') report(this.file, error);
      index = null;
    }
    for (const [deviceId, value] of Object.entries(index?.owners || {})) {
      if (!object(value) || !Array.isArray(value.runs) || !string(value.current)) {
        report(this.file, new Error('Fusion v2 owner 结构无效'), { deviceId });
        continue;
      }
      owner(deviceId).current = value.current;
      for (const run of value.runs) {
        try { validateRun(run, deviceId); owner(deviceId).runs.push(run); }
        catch (error) { report(this.file, error, { deviceId, runId: run?.id }); }
      }
    }
    let entries = [];
    try { entries = fs.readdirSync(this.directory); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }

    const indexed = new Map(Object.values(owners).flatMap(value => value.runs)
      .map(run => [this.runFile(run.deviceId, run.id), run]));
    const latest = new Map();
    for (const entry of entries.filter(name => name.endsWith('.json'))) {
      const file = path.join(this.directory, entry), earlier = indexed.get(file);
      // A shard is authoritative even when it is unreadable. Never recover from an older index copy.
      if (earlier) owner(earlier.deviceId).runs = owner(earlier.deviceId).runs.filter(row => row.id !== earlier.id);
      let record;
      try {
        record = JSON.parse(fs.readFileSync(file, 'utf8'));
        const { sequence, current, run } = record;
        validateRun(run, run?.deviceId);
        if (file !== this.runFile(run.deviceId, run.id) || !Number.isSafeInteger(sequence) || sequence < 1 || !string(current))
          throw new Error('Fusion v2 分片身份或序号无效');
        const value = owner(run.deviceId);
        value.runs.push(run);
        if (sequence > (latest.get(run.deviceId) || 0)) {
          value.current = current;
          latest.set(run.deviceId, sequence);
        }
        this.sequence = Math.max(this.sequence, sequence);
      } catch (error) {
        this.unreadable.add(file);
        const run = earlier || record?.run;
        report(file, error, { deviceId: run?.deviceId, runId: run?.id });
      }
    }
    return owners;
  }
  write(run, current) {
    const file = this.runFile(run.deviceId, run.id);
    if (this.unreadable.has(file)) throw new Error('Fusion 分片无法读取，已保留原始文件');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = file + '.' + randomUUID() + '.pending';
    const sequence = this.sequence + 1;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ sequence, current, run }), { mode: 0o600, flag: 'wx', flush: true });
      try { fs.renameSync(temporary, file); }
      catch (error) {
        if (!IS_WIN || error.code !== 'EPERM') throw error;
        fs.renameSync(temporary, file);
      }
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* retain the original write error */ }
      throw error;
    }
    this.sequence = sequence;
  }
}
