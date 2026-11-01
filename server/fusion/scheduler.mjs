export class FusionScheduler {
  constructor() {
    this.queue = [];
    this.slots = new Map();
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
    for (const job of [...this.queue]) {
      if (this.slots.has(job.app) || this.uncertain.has(job.app) && this.uncertain.get(job.app) !== job.attemptId
          || !job.ready() || job.access === 'write' && (this.writers.has(job.projectKey)
            || this.uncertainWriters.has(job.projectKey) && this.uncertainWriters.get(job.projectKey) !== job.attemptId)) continue;
      this.queue.splice(this.queue.indexOf(job), 1);
      this.slots.set(job.app, job);
      if (job.access === 'write') this.writers.set(job.projectKey, job);
      const finish = (result, error) => {
        if (this.slots.get(job.app) === job) this.slots.delete(job.app);
        if (this.writers.get(job.projectKey) === job) this.writers.delete(job.projectKey);
        if (error) job.reject(error); else job.resolve(result);
        this.drain();
      };
      Promise.resolve().then(job.execute).then(value => finish(value), error => finish(null, error));
    }
  }
  cancel(runId) {
    for (const job of [...this.queue]) if (job.runId === runId) {
      this.queue.splice(this.queue.indexOf(job), 1);
      job.reject(Object.assign(new Error('Fusion 队列已取消'), { cancelled: true }));
    }
  }
  cancelAttempt(attemptId) {
    const job = this.queue.find(value => value.attemptId === attemptId);
    if (!job) return;
    this.queue.splice(this.queue.indexOf(job), 1);
    job.reject(Object.assign(new Error('Fusion 任务队列已取消'), { cancelled: true }));
  }
  window(key, create) {
    if (!this.creating.has(key)) this.creating.set(key, Promise.resolve().then(create).finally(() => this.creating.delete(key)));
    return this.creating.get(key);
  }
}

export const fusionScheduler = new FusionScheduler();
