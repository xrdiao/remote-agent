export class FusionScheduler {
  constructor() {
    this.queue = [];
    this.mainSlots = new Map();
    this.workerSlots = new Map();
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
      if ((main && this.mainSlots.has(job.runId)) || (job.workerKey && this.workerSlots.has(job.workerKey))) continue;
      try { if (!job.ready()) continue; }
      catch (error) {
        this.queue.splice(this.queue.indexOf(job), 1);
        job.reject(error);
        continue;
      }
      this.queue.splice(this.queue.indexOf(job), 1);
      if (main) this.mainSlots.set(job.runId, job);
      if (job.workerKey) this.workerSlots.set(job.workerKey, job);
      const finish = (value, error) => {
        if (this.mainSlots.get(job.runId) === job) this.mainSlots.delete(job.runId);
        if (this.workerSlots.get(job.workerKey) === job) this.workerSlots.delete(job.workerKey);
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
  cancelAttempt(runId, attemptId) {
    const job = this.queue.find(row => row.runId === runId && row.attemptId === attemptId);
    if (!job) return;
    this.queue.splice(this.queue.indexOf(job), 1);
    job.reject(Object.assign(new Error('未提交的 Fusion 任务已取消'), { cancelled: true }));
  }
}
