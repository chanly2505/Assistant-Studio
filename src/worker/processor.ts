import { UnrecoverableError } from 'bullmq';
import type { Logger } from 'pino';

import { AppError, toAppError } from '@/domain/errors/app-error';
import { PERMANENT_ERROR_CODES } from '@/modules/sync/run-sync-job';
import { refreshChannelStats, refreshVideoStats } from '@/modules/sync/refresh-stats';
import { scheduleDueSyncs } from '@/modules/sync/schedule';
import { syncChannelVideos } from '@/modules/sync/sync-channel-videos';
import { JOB_SCHEMAS, type JobName } from '@/services/queue/jobs';

/**
 * Job name → use case. Kept apart from the BullMQ wiring so tests exercise
 * exactly what the worker runs, without a queue.
 *
 * Error policy:
 *   permanent (reauth, missing scope, quota, not found) → UnrecoverableError.
 *     Retrying cannot help; quota resets tomorrow and the scheduler re-plans.
 *   anything else (network, 5xx) → rethrown; BullMQ retries with backoff.
 */
export async function processJob(
  name: string,
  data: unknown,
  attempt: number,
  log: Logger,
): Promise<unknown> {
  if (!(name in JOB_SCHEMAS)) {
    throw new UnrecoverableError(`unknown job name "${name}"`);
  }
  const jobName = name as JobName;

  // Validate on the way OUT too: the queue is a boundary, and a job enqueued
  // by an older deployment may no longer match today's contract.
  const parsed = JOB_SCHEMAS[jobName].safeParse(data);
  if (!parsed.success) {
    throw new UnrecoverableError(`job "${name}" payload failed validation`);
  }

  try {
    switch (jobName) {
      case 'channel.videos': {
        const payload = JOB_SCHEMAS['channel.videos'].parse(data);
        return (await syncChannelVideos({ ...payload, attempt, log })).result;
      }
      case 'channel.video-stats': {
        const payload = JOB_SCHEMAS['channel.video-stats'].parse(data);
        return (await refreshVideoStats({ ...payload, attempt, log })).result;
      }
      case 'channel.stats': {
        const payload = JOB_SCHEMAS['channel.stats'].parse(data);
        return (await refreshChannelStats({ ...payload, attempt, log })).result;
      }
      case 'schedule.tick':
        return await scheduleDueSyncs({ log });
    }
  } catch (thrown) {
    const error = toAppError(thrown);
    if (PERMANENT_ERROR_CODES.has(error.code)) {
      throw new UnrecoverableError(`${error.code}: ${error.detail ?? ''}`.trim());
    }
    throw error;
  }
}

export function isPermanent(error: unknown): boolean {
  return (
    error instanceof UnrecoverableError ||
    (AppError.is(error) && PERMANENT_ERROR_CODES.has(error.code))
  );
}
