import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../../lib/auth.mjs';
import { canRunPeerTasks, peerSettings, readPeerFile, writePeerFile, PeerError } from './access.mjs';

const directory = 'peer-jobs';
const worker = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const WINDOW = 10 * 60 * 1000;
const RETENTION = 24 * 60 * 60 * 1000;
const MAX_OUTPUT = 32 * 1024;
const MAX_RUN = 5 * 60 * 1000;
let active = null, prunedAt = 0;

const file = id => `${directory}/${id}.json`;
const save = job => writePeerFile(file(job.id), job);
const view = ({ grant, ...rest }) => rest;

function readJob(id) {
  if (active?.job.id === id) return active.job;
  const job = readPeerFile(file(id), null);
  if (job?.state === 'running') {
    Object.assign(job, { state: 'unknown', finishedAt: Date.now(), error: '中继在任务期间退出，结果待确认' });
    save(job);
  }
  return job;
}

function prune(now) {
  if (now - prunedAt < WINDOW) return;
  const full = path.join(DATA_DIR, directory);
  if (fs.existsSync(full)) for (const name of fs.readdirSync(full)) {
    if (/^\d{13}-[a-f0-9-]{36}\.json$/.test(name) && now - Number(name.slice(0, 13)) > RETENTION)
      fs.unlinkSync(path.join(full, name));
  }
  prunedAt = now;
}

function stop(record, reason) {
  if (record.stop) return true;
  if (!record.child.pid) return false;
  try { process.kill(-record.child.pid, 'SIGKILL'); }
  catch (error) { if (error.code === 'ESRCH') return false; throw new PeerError(503, '目标电脑未能停止任务'); }
  record.stop = reason;
  record.job.state = 'stopping';
  return true;
}

function start(id, task, grant) {
  if (!canRunPeerTasks) throw new PeerError(501, '此平台尚不支持执行互控任务');
  const preset = peerSettings().tasks.get(task);
  if (!preset) throw new PeerError(404, '目标电脑未登记此预设任务');
  if (active) throw new PeerError(409, '目标电脑已有运行中的互控任务');
  const now = Date.now();
  if (Math.abs(now - Number(id.slice(0, 13))) > WINDOW) throw new PeerError(409, '任务编号已过期，请查询原任务');
  prune(now);
  const job = { id, task, grant, state: 'running', output: '', truncated: false, exitCode: null, startedAt: now, finishedAt: null };
  save(job);
  const finish = (state, exitCode, error) => {
    Object.assign(job, { state, exitCode, error, finishedAt: Date.now() });
    try { save(job); }
    catch (failure) { console.error('[peer] 无法保存任务回执:', failure.message); }
  };
  const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'].filter(key => process.env[key] != null)
    .map(key => [key, process.env[key]]));
  let child;
  try { child = fork(worker, preset.argv, { cwd: preset.cwd, env, execArgv: [], detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); }
  catch (error) { finish('failed', null, error.message); return view(job); }
  const record = active = { child, job, stop: '', error: '' };
  const timer = setTimeout(() => {
    try { stop(record, 'timeout'); } catch (error) { job.error = error.message; }
  }, MAX_RUN);
  timer.unref();
  for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', data => {
    const room = MAX_OUTPUT - job.output.length;
    job.output += data.slice(0, room);
    if (data.length > room) job.truncated = true;
  });
  child.once('error', error => { record.error = error.message; });
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    active = null;
    const state = record.stop && signal === 'SIGKILL' ? record.stop : code === 0 ? 'succeeded' : 'failed';
    finish(state, code, record.error || (!record.stop && signal) || job.error || undefined);
  });
  return view(job);
}

export function peerJobAction({ action, id, task, grant }) {
  const job = readJob(id);
  if (job && (job.grant !== grant || job.task !== task))
    throw new PeerError(action === 'start' ? 409 : 404, action === 'start' ? '任务编号已使用' : '此授权下没有该任务');
  if (action === 'start') return job ? view(job) : start(id, task, grant);
  if (!job) throw new PeerError(404, '目标电脑没有收到此任务');
  if (action === 'cancel' && active?.job === job) stop(active, 'cancelled');
  return view(job);
}

export function stopPeerJobs(grant) {
  if (!active || (grant && active.job.grant !== grant)) return false;
  return stop(active, 'cancelled');
}
