import { createHash } from 'node:crypto';

import type { SyncJobType } from '@prisma/client';
import type { Logger } from 'pino';

import { channelRepository } from '@/db/repositories/channel.repository';
import { connectionRepository } from '@/db/repositories/connection.repository';
import { quotaRepository } from '@/db/repositories/quota.repository';
import { syncJobRepository } from '@/db/repositories/sync-job.repository';
import { AppError, notFound } from '@/domain/errors/app-error';
import { ok, type Result } from '@/domain/errors/result';
import { quotaDayKey, quotaMode } from '@/domain/youtube/quota';
import { getRateLimiter, rateLimitError } from '@/lib/api/rate-limit';
import { env } from '@/lib/env';
import { logger as rootLogger } from '@/lib/logger';
import { sweepAbandonedGenerations } from '@/modules/ai/run-generation';
import { getJobQueue, type JobName, type JobPayload } from '@/services/queue';

/**
 * When each kind of sync is due.
 * docs/architecture/10-deployment-architecture.md §10.4
 */
export const SCHEDULE = {
  fullEveryDays: 7,
  deltaEveryHours: 20,
  statsEveryHours: 20,
  analyticsEveryHours: 20,
  /** After a connect, give the video backfill a head start so the first
   *  analytics run can already build series for the new channel's videos. */
  analyticsAfterConnectMs: 10 * 60 * 1000,
  /** Spread over most of the hour so every channel does not hit Google at :00. */
  maxJitterMs: 50 * 60 * 1000,
} as const;

const HOUR_MS = 3_600_000;

type PlannedJob = { [N in JobName]: { name: N; payload: JobPayload<N> } }[JobName];

export interface SchedulableChannel {
  id: string;
  userId: string;
  lastFullSyncAt: Date | null;
  lastStatsSyncAt: Date | null;
}

/**
 * Pure: what is due for one channel right now. A full walk makes a delta
 * pointless, so at most one of the two is planned.
 */
export function planChannel(
  channel: SchedulableChannel,
  lastSucceeded: Partial<Record<SyncJobType, Date>>,
  now: Date,
): PlannedJob[] {
  const olderThan = (date: Date | null | undefined, hours: number) =>
    !date || now.getTime() - date.getTime() >= hours * HOUR_MS;
  const base = { userId: channel.userId, channelId: channel.id, trigger: 'schedule' as const };

  const jobs: PlannedJob[] = [];

  if (olderThan(channel.lastFullSyncAt, SCHEDULE.fullEveryDays * 24)) {
    jobs.push({ name: 'channel.videos', payload: { ...base, mode: 'full' } });
  } else {
    const lastWalk = latest(
      lastSucceeded.VIDEO_DELTA,
      lastSucceeded.VIDEO_FULL,
      lastSucceeded.CHANNEL_BACKFILL,
    );
    if (olderThan(lastWalk, SCHEDULE.deltaEveryHours)) {
      jobs.push({ name: 'channel.videos', payload: { ...base, mode: 'delta' } });
    }
  }

  if (olderThan(channel.lastStatsSyncAt, SCHEDULE.statsEveryHours)) {
    jobs.push({ name: 'channel.stats', payload: base });
  }
  if (olderThan(lastSucceeded.VIDEO_STATS, SCHEDULE.statsEveryHours)) {
    jobs.push({ name: 'channel.video-stats', payload: base });
  }
  if (olderThan(lastSucceeded.ANALYTICS, SCHEDULE.analyticsEveryHours)) {
    jobs.push({ name: 'channel.analytics', payload: base });
  }

  return jobs;
}

function latest(...dates: Array<Date | undefined>): Date | undefined {
  return dates.reduce<Date | undefined>(
    (max, date) => (date && (!max || date > max) ? date : max),
    undefined,
  );
}

/** Deterministic per channel, so a channel keeps its slot hour after hour. */
export function jitterMs(channelId: string): number {
  const hash = createHash('sha256').update(channelId).digest();
  return hash.readUInt32BE(0) % SCHEDULE.maxJitterMs;
}

/**
 * The hourly tick. Scheduled work stops entirely once the day's quota passes
 * 80%: the remainder is kept for people actually using the app.
 */
export async function scheduleDueSyncs(params: { now?: Date; log?: Logger } = {}) {
  const now = params.now ?? new Date();
  const log = params.log ?? rootLogger;

  const day = quotaDayKey(now);
  const unitsUsed = await quotaRepository.unitsUsed('YOUTUBE_DATA', day);
  const mode = quotaMode({ unitsUsed, dailyBudget: env.YOUTUBE_DATA_DAILY_QUOTA });
  if (mode !== 'normal') {
    log.warn({ unitsUsed, mode }, 'scheduled sync deferred: quota past the scheduled threshold');
    return { considered: 0, enqueued: 0, deferredForQuota: true };
  }

  // The Analytics API has its own budget; past 80% of it, only analytics defers.
  const analyticsRequests = await quotaRepository.unitsUsed('YOUTUBE_ANALYTICS', day);
  const analyticsDeferred =
    quotaMode({
      unitsUsed: analyticsRequests,
      dailyBudget: env.YOUTUBE_ANALYTICS_DAILY_REQUEST_BUDGET,
    }) !== 'normal';
  if (analyticsDeferred) {
    log.warn(
      { analyticsRequests },
      'scheduled analytics deferred: budget past the scheduled threshold',
    );
  }

  const channels = await syncJobRepository.schedulableChannels();
  const last = await syncJobRepository.lastSucceeded(channels.map((channel) => channel.id));
  const queue = getJobQueue();

  let enqueued = 0;
  for (const channel of channels) {
    for (const job of planChannel(channel, last.get(channel.id) ?? {}, now)) {
      if (analyticsDeferred && job.name === 'channel.analytics') continue;
      await queue.enqueue(job.name, job.payload as never, { delayMs: jitterMs(channel.id) });
      enqueued += 1;
    }
  }

  // Housekeeping on the same hourly clock: generations left PENDING by a
  // process that died mid-call get their allowance refunded.
  const abandonedGenerations = await sweepAbandonedGenerations(now);
  if (abandonedGenerations) log.warn({ abandonedGenerations }, 'swept abandoned AI generations');

  log.info({ considered: channels.length, enqueued }, 'schedule tick');
  return { considered: channels.length, enqueued, deferredForQuota: false };
}

/* ------------------------------ user-requested ------------------------------ */

export const MANUAL_SYNC_RULE = { points: 1, windowSec: 3600 } as const;

/**
 * "Refresh now" from the UI or API. One per channel per hour — the button is
 * a convenience, not a way to spend the shared project quota on demand.
 */
export async function requestManualSync(input: {
  userId: string;
  channelId: string;
}): Promise<Result<{ queued: true }>> {
  const channel = await channelRepository.findForUser(input.userId, input.channelId);
  if (!channel || channel.disconnectedAt) throw notFound('channel');

  const connection = await connectionRepository.findForUser(input.userId, channel.connectionId);
  if (!connection || connection.status !== 'ACTIVE') {
    throw new AppError('YOUTUBE_REAUTH_REQUIRED', { detail: 'connection is not active' });
  }

  const limit = await getRateLimiter().consume(
    { key: `sync:manual:${channel.id}`, ...MANUAL_SYNC_RULE },
    input.userId,
  );
  if (!limit.allowed) throw rateLimitError(limit);

  const queue = getJobQueue();
  const base = { userId: input.userId, channelId: channel.id, trigger: 'manual' as const };
  await queue.enqueue('channel.videos', {
    ...base,
    mode: channel.lastFullSyncAt ? 'delta' : 'full',
  });
  await queue.enqueue('channel.stats', base);
  await queue.enqueue('channel.video-stats', base);
  await queue.enqueue('channel.analytics', base);

  if (channel.syncStatus !== 'SYNCING') {
    await syncJobRepository.setChannelStatus(channel.id, 'QUEUED');
  }
  return ok({ queued: true });
}

/**
 * Called right after a successful connect. A queue outage must not fail the
 * connection — the channel simply waits for the next scheduler tick.
 */
export async function enqueueInitialSync(
  userId: string,
  channelIds: string[],
  log: Logger = rootLogger,
): Promise<void> {
  try {
    const queue = getJobQueue();
    for (const channelId of channelIds) {
      await queue.enqueue('channel.videos', {
        userId,
        channelId,
        mode: 'full',
        trigger: 'connect',
      });
      await queue.enqueue(
        'channel.analytics',
        { userId, channelId, trigger: 'connect' },
        { delayMs: SCHEDULE.analyticsAfterConnectMs },
      );
      await syncJobRepository.setChannelStatus(channelId, 'QUEUED');
    }
  } catch (error) {
    log.warn(
      { err: { errorCode: AppError.is(error) ? error.code : 'UNKNOWN' } },
      'initial sync not queued; the scheduler will pick the channel up',
    );
  }
}
