import type { JobQueue } from '@/services/queue';
import type { JobName, JobPayload } from '@/services/queue/jobs';
import { JOB_SCHEMAS, jobIdFor } from '@/services/queue/jobs';

/**
 * Records enqueued jobs instead of writing them to Redis. Same validation and
 * the same deterministic ids as the real queue, so tests see what would have
 * been queued — including dedupe.
 */
export class RecordingJobQueue implements JobQueue {
  readonly jobs: Array<{ name: JobName; payload: unknown; jobId: string; delayMs?: number }> = [];

  async enqueue<N extends JobName>(
    name: N,
    payload: JobPayload<N>,
    options: { delayMs?: number } = {},
  ) {
    JOB_SCHEMAS[name].parse(payload);
    const jobId = jobIdFor(name, payload);
    if (!this.jobs.some((job) => job.jobId === jobId)) {
      this.jobs.push({
        name,
        payload,
        jobId,
        ...(options.delayMs ? { delayMs: options.delayMs } : {}),
      });
    }
    return { jobId };
  }

  clear(): void {
    this.jobs.length = 0;
  }

  async close(): Promise<void> {}
}

export const recordingQueue = new RecordingJobQueue();
