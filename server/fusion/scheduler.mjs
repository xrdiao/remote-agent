export class FusionScheduler {
  constructor() {
    this.queue = [];
    this.mainSlots = new Map();
    this.creating = new Map();
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
      const main = job.lane === 'main';
      if (main && this.mainSlots.has(job.runId) || !job.ready()) continue;
      this.queue.splice(this.queue.indexOf(job), 1);
      if (main) this.mainSlots.set(job.runId, job);
      const finish = (value, error) => {
        if (this.mainSlots.get(job.runId) === job) this.mainSlots.delete(job.runId);
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
  window(key, create) {
    if (!this.creating.has(key)) this.creating.set(key, Promise.resolve().then(create).finally(() => this.creating.delete(key)));
    return this.creating.get(key);
  }
}
export const fusionScheduler = new FusionScheduler();
