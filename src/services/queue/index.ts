import 'server-only';

import { Queue, type JobsOptions } from 'bullmq';

import { REDIS_PREFIX, createRedis, isRedisConfigured } from '@/lib/redis';
import { AppError } from '@/domain/errors/app-error';

import { JOB_SCHEMAS, QUEUE_NAME, jobIdFor, type JobName, type JobPayload } from './jobs';

/**
 * The queue seam. Web requests enqueue; only the worker process executes.
 * Swappable for a serverless queue (docs/architecture/10 §10.3) behind this
 * interface.
 */
export interface JobQueue {
  enqueue<N extends JobName>(
    name: N,
    payload: JobPayload<N>,
    options?: { delayMs?: number },
  ): Promise<{ jobId: string }>;
  close(): Promise<void>;
}

/** Retry transient failures with backoff; the processor marks permanent ones unrecoverable. */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 4,
  backoff: { type: 'exponential', delay: 60_000 },
  // Finished jobs are removed so a deterministic id can be reused by the next
  // run. History lives in the SyncJob table, not in Redis.
  removeOnComplete: true,
  removeOnFail: true,
};

export class BullMQJobQueue implements JobQueue {
  private readonly queue: Queue;

  constructor() {
    this.queue = new Queue(QUEUE_NAME, {
      connection: createRedis('queue'),
      prefix: REDIS_PREFIX,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }

  async enqueue<N extends JobName>(
    name: N,
    payload: JobPayload<N>,
    options: { delayMs?: number } = {},
  ): Promise<{ jobId: string }> {
    // Validate on the way IN, so a malformed payload fails at the caller — not
    // minutes later inside the worker, far from the bug.
    const data = JOB_SCHEMAS[name].parse(payload);
    const jobId = jobIdFor(name, payload);
    await this.queue.add(name, data, {
      jobId,
      ...(options.delayMs ? { delay: options.delayMs } : {}),
    });
    return { jobId };
  }

  /** Hourly scheduler tick. Idempotent: re-registering replaces, never duplicates. */
  async ensureScheduler(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'schedule.tick',
      { every: 60 * 60 * 1000 },
      { name: 'schedule.tick', data: {}, opts: { removeOnComplete: true, removeOnFail: true } },
    );
  }

  get raw(): Queue {
    return this.queue;
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

let queue: JobQueue | undefined;

export function getJobQueue(): JobQueue {
  if (queue) return queue;
  if (!isRedisConfigured()) {
    throw new AppError('CONFIGURATION_MISSING', {
      detail: 'REDIS_URL is not set; background sync cannot be queued',
      params: { setting: 'REDIS_URL' },
    });
  }
  queue = new BullMQJobQueue();
  return queue;
}

/** Test hook. */
export function setJobQueue(next: JobQueue | undefined): void {
  queue = next;
}

export { QUEUE_NAME } from './jobs';
export type { JobName, JobPayload } from './jobs';
