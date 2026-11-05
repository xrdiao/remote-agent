export class FusionScheduler {
  constructor() {
    this.queue = [];
    this.slots = new Map();
    this.mainSlots = new Map();
    this.writers = new Map();
    this.creating = new Map();
    this.uncertain = new Map();
    this.uncertainWriters = new Map();
  }
  submit(job) {
    return new Promise((resolve, reject) => {
      this.queue.push({ ...job, resolve, reject });
      this.drain();
    });
  }
  drain() {
    const ordered = [...this.queue].sort((a, b) => (b.priority || 0) - (a.priority || 0));
    for (const job of ordered) {
      const main = job.lane === 'main', slots = main ? this.mainSlots : this.slots;
      const slot = main ? job.runId : job.app;
      if (slots.has(slot) || !job.ready()) continue;
      if (!main && this.uncertain.has(job.app) && this.uncertain.get(job.app) !== job.attemptId) continue;
      const uncertain = this.uncertainWriters.get(job.projectKey);
      if (job.access === 'write' && (this.writers.has(job.projectKey) || uncertain && uncertain !== job.attemptId)) continue;
      if (job.access === 'read' && job.stableRead && (this.writers.has(job.projectKey) || uncertain)) continue;
      this.queue.splice(this.queue.indexOf(job), 1);
      slots.set(slot, job);
      if (job.access === 'write') this.writers.set(job.projectKey, job);
      const finish = (value, error) => {
        if (slots.get(slot) === job) slots.delete(slot);
        if (this.writers.get(job.projectKey) === job) this.writers.delete(job.projectKey);
        if (error) job.reject(error); else job.resolve(value);
        this.drain();
      };
      Promise.resolve().then(job.execute).then(value => finish(value), error => finish(null, error));
    }
  }
  cancel(runId) {
    for (const job of [...this.queue]) if (job.runId === runId) {
      this.queue.splice(this.queue.indexOf(job), 1);
      job.reject(Object.assign(new Error('未提交的 Fusion 任务已取消'), { cancelled: true }));
    }
  }
  cancelAttempt(attemptId) {
    const job = this.queue.find(row => row.attemptId === attemptId);
    if (!job) return;
    this.queue.splice(this.queue.indexOf(job), 1);
    job.reject(Object.assign(new Error('未提交的 Fusion 任务已取消'), { cancelled: true }));
  }
  claimWrite(projectKey, attemptId) {
    if (this.writers.has(projectKey) || this.uncertainWriters.has(projectKey)) throw new Error('该项目已有写任务或未知执行，主控不能同时写入');
    this.writers.set(projectKey, { attemptId });
  }
  releaseWrite(projectKey, attemptId) {
    if (this.writers.get(projectKey)?.attemptId === attemptId) this.writers.delete(projectKey);
    this.drain();
  }
  window(key, create) {
    if (!this.creating.has(key)) this.creating.set(key, Promise.resolve().then(create).finally(() => this.creating.delete(key)));
    return this.creating.get(key);
  }
}
export const fusionScheduler = new FusionScheduler();
