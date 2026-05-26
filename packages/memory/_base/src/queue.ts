import type { Job, JobQueue, Store } from '@matbot/core';

export class JobQueueImpl implements JobQueue {
  private readonly store:         Store<Job>;
  private readonly pollIntervalMs: number;
  constructor(store: Store<Job>, pollIntervalMs = 2000) {
    this.store          = store;
    this.pollIntervalMs = pollIntervalMs;
  }

  async enqueue<P>(type: string, payload: P, runAfter?: Date): Promise<Job<P>> {
    const now = new Date().toISOString();
    const job: Job<P> = {
      id:          crypto.randomUUID(),
      version:     crypto.randomUUID(),
      type,
      payload,
      status:      'pending',
      attempts:    0,
      maxAttempts: 3,
      runAfter:    (runAfter ?? new Date()).toISOString(),
      createdAt:   now,
    };
    await this.store.set(job.id, job as unknown as Job);
    return job;
  }

  async claim(type: string, workerId: string): Promise<Job | null> {
    const now   = new Date().toISOString();
    const result = await this.store.query({
      filter: {
        and: [
          { field: 'type',    op: 'eq',  value: type },
          { field: 'status',  op: 'eq',  value: 'pending' },
          { field: 'runAfter', op: 'lte', value: now },
        ],
      },
      sort:  [{ field: 'runAfter', direction: 'asc' }],
      limit: 1,
    });

    const item = result.items[0];
    if (!item) return null;
    const job = item.doc;

    if (job.attempts >= job.maxAttempts) {
      // Permanently fail exhausted jobs
      const failed: Job = {
        ...job,
        version:    crypto.randomUUID(),
        status:     'failed',
        failReason: 'max attempts reached',
      };
      await this.store.cas(job.id, job.version, failed);
      return null;
    }

    const claimed: Job = {
      ...job,
      version:    crypto.randomUUID(),
      status:     'claimed',
      claimedBy:  workerId,
      claimedAt:  now,
      attempts:   job.attempts + 1,
    };

    const cas = await this.store.cas(job.id, job.version, claimed);
    return cas.ok ? claimed : null;  // null means another worker won the race
  }

  async complete(id: string, version: string): Promise<void> {
    const job = await this.store.get(id);
    if (!job) return;

    const done: Job = { ...job, version: crypto.randomUUID(), status: 'done' };
    await this.store.cas(id, version, done);
  }

  async fail(id: string, version: string, error: string): Promise<void> {
    const job = await this.store.get(id);
    if (!job) return;

    // Re-queue if attempts remaining, otherwise mark failed
    const remaining = job.maxAttempts - job.attempts;
    const retryDelay = 30_000 * Math.pow(2, job.attempts);  // exponential back-off
    const next: Job = {
      ...job,
      version:    crypto.randomUUID(),
      status:     remaining > 0 ? 'pending' : 'failed',
      failReason: error,
      ...(remaining > 0 ? { runAfter: new Date(Date.now() + retryDelay).toISOString() } : {}),
    };
    await this.store.cas(id, version, next);
  }

  async *watch(type: string, signal: AbortSignal): AsyncIterable<Job> {
    while (!signal.aborted) {
      const job = await this.claim(type, `watcher-${crypto.randomUUID()}`);
      if (job) {
        yield job;
      } else {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.pollIntervalMs);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }
    }
  }
}
