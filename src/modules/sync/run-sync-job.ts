import type { SyncJobType, YouTubeChannel } from '@prisma/client';
import type { Logger } from 'pino';

import { channelRepository } from '@/db/repositories/channel.repository';
import { connectionRepository } from '@/db/repositories/connection.repository';
import { syncJobRepository } from '@/db/repositories/sync-job.repository';
import { AppError, notFound, toAppError } from '@/domain/errors/app-error';
import type { SecretString } from '@/domain/shared/secret';
import type { CallKind, QuotaOperation } from '@/domain/youtube/quota';
import { logger as rootLogger } from '@/lib/logger';
import { getAccessToken } from '@/modules/youtube/access-token';
import { reserveAnalyticsRequest, reserveYouTubeQuota } from '@/modules/youtube/quota-guard';

export type SyncTrigger = 'connect' | 'manual' | 'schedule';

/** User-initiated work may use the budget reserved for interactive calls. */
export function callKindFor(trigger: SyncTrigger): CallKind {
  return trigger === 'schedule' ? 'scheduled' : 'interactive';
}

export interface SyncContext {
  channel: YouTubeChannel;
  token: SecretString;
  kind: CallKind;
  log: Logger;
  now: Date;
  /** Reserve Data API quota for one call and count it against this job. */
  spend(operation: QuotaOperation): Promise<void>;
  /**
   * Reserve one Analytics API request (a separate budget from the Data API).
   * For ANALYTICS jobs, SyncJob.quotaUnitsUsed therefore counts requests.
   */
  spendAnalytics(): Promise<void>;
  addItems(count: number): void;
}

export interface SyncOutcome<T> {
  syncJobId: string;
  quotaUnitsUsed: number;
  itemsProcessed: number;
  result: T;
}

/** Errors that no retry can fix. The worker drops these instead of retrying. */
export const PERMANENT_ERROR_CODES = new Set([
  'YOUTUBE_REAUTH_REQUIRED',
  'YOUTUBE_INSUFFICIENT_SCOPE',
  'YOUTUBE_QUOTA_EXCEEDED',
  'NOT_FOUND',
  'CONFIGURATION_MISSING',
  'CREDENTIAL_UNREADABLE',
  'FORBIDDEN',
]);

/**
 * Runs one sync job with bookkeeping:
 *   - resolves the channel through an ownership-checked lookup
 *   - records a SyncJob row (RUNNING → SUCCEEDED | FAILED) with items + quota
 *   - moves the channel's syncStatus when `tracksChannelStatus`
 *   - on an expired grant, pauses the channel rather than failing it — the fix
 *     is a reconnect, not a retry
 *
 * Partial progress is kept on failure: every write inside is idempotent, so the
 * next run continues rather than starting over.
 */
export async function runSyncJob<T>(
  params: {
    userId: string;
    channelId: string;
    jobType: SyncJobType;
    trigger: SyncTrigger;
    attempt?: number;
    tracksChannelStatus?: boolean;
    log?: Logger;
  },
  body: (context: SyncContext) => Promise<T>,
): Promise<SyncOutcome<T>> {
  const log = (params.log ?? rootLogger).child({
    channelId: params.channelId,
    jobType: params.jobType,
    trigger: params.trigger,
  });

  const channel = await channelRepository.findForUser(params.userId, params.channelId);
  if (!channel) throw notFound('channel');
  if (channel.disconnectedAt) {
    throw new AppError('NOT_FOUND', { detail: 'channel is disconnected; skipping sync' });
  }

  const syncJobId = await syncJobRepository.start({
    channelId: channel.id,
    jobType: params.jobType,
    trigger: params.trigger,
    attempt: params.attempt ?? 1,
  });

  let quotaUnitsUsed = 0;
  let itemsProcessed = 0;
  const kind = callKindFor(params.trigger);

  if (params.tracksChannelStatus) await syncJobRepository.setChannelStatus(channel.id, 'SYNCING');

  try {
    const connection = await connectionRepository.findForUser(params.userId, channel.connectionId);
    if (!connection) throw notFound('youtube connection');
    const token = await getAccessToken({ userId: params.userId, connectionId: connection.id, log });

    const result = await body({
      channel,
      token,
      kind,
      log,
      now: new Date(),
      async spend(operation) {
        const { cost } = await reserveYouTubeQuota(operation, kind);
        quotaUnitsUsed += cost;
      },
      async spendAnalytics() {
        await reserveAnalyticsRequest(kind);
        quotaUnitsUsed += 1;
      },
      addItems(count) {
        itemsProcessed += count;
      },
    });

    await syncJobRepository.finish(syncJobId, {
      status: 'SUCCEEDED',
      itemsProcessed,
      quotaUnitsUsed,
    });
    if (params.tracksChannelStatus) await syncJobRepository.setChannelStatus(channel.id, 'SYNCED');

    log.info({ syncJobId, itemsProcessed, quotaUnitsUsed }, 'sync job succeeded');
    return { syncJobId, quotaUnitsUsed, itemsProcessed, result };
  } catch (thrown) {
    const error = toAppError(thrown);
    await syncJobRepository.finish(syncJobId, {
      status: 'FAILED',
      itemsProcessed,
      quotaUnitsUsed,
      errorCode: error.code,
      // `detail` is our own diagnostic text, never an upstream body or a token.
      errorMessage: error.detail ?? error.code,
    });

    if (params.tracksChannelStatus) {
      const status =
        error.code === 'YOUTUBE_REAUTH_REQUIRED' || error.code === 'YOUTUBE_INSUFFICIENT_SCOPE'
          ? 'PAUSED'
          : error.code === 'YOUTUBE_QUOTA_EXCEEDED'
            ? // Nothing is wrong with the channel; it simply waits for tomorrow.
              channel.lastFullSyncAt
              ? 'SYNCED'
              : 'QUEUED'
            : 'FAILED';
      await syncJobRepository.setChannelStatus(channel.id, status);
    }

    log[error.logLevel](
      {
        syncJobId,
        itemsProcessed,
        quotaUnitsUsed,
        err: { errorCode: error.code, detail: error.detail },
      },
      'sync job failed',
    );
    throw error;
  }
}
