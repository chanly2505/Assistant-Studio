import { channelRepository } from '@/db/repositories/channel.repository';
import { ok, type Result } from '@/domain/errors/result';

/**
 * Reads come from Postgres, never from YouTube.
 * docs/architecture/01-system-architecture.md §1.4 — this is what keeps the
 * application inside its shared, project-wide API quota.
 */

export interface ChannelListItem {
  id: string;
  youtubeChannelId: string;
  title: string;
  handle: string | null;
  thumbnailUrl: string | null;
  syncStatus: string;
  lastSyncedAt: string | null;
  /** The date analytics are complete through — YouTube lags ~2-3 days. */
  analyticsThrough: string | null;
  needsReauth: boolean;
  /** Latest snapshot. subscriberCount is null when the creator hides it. */
  stats: {
    subscriberCount: string | null;
    viewCount: string;
    videoCount: number;
    capturedAt: string;
  } | null;
}

export interface ListChannelsInput {
  userId: string;
  includeDisconnected?: boolean;
}

export async function listChannels(
  input: ListChannelsInput,
): Promise<Result<{ channels: ChannelListItem[] }>> {
  const rows = await channelRepository.listForUser(input.userId, {
    includeDisconnected: input.includeDisconnected ?? false,
  });

  return ok({
    channels: rows.map((row) => ({
      id: row.id,
      youtubeChannelId: row.youtubeChannelId,
      title: row.title,
      handle: row.handle,
      thumbnailUrl: row.thumbnailUrl,
      syncStatus: row.syncStatus,
      lastSyncedAt: row.lastFullSyncAt?.toISOString() ?? null,
      analyticsThrough: row.lastAnalyticsDate?.toISOString().slice(0, 10) ?? null,
      needsReauth: row.connection.status === 'REAUTH_REQUIRED',
      stats: row.statsSnapshots[0]
        ? {
            subscriberCount: row.statsSnapshots[0].subscriberCount?.toString() ?? null,
            viewCount: row.statsSnapshots[0].viewCount.toString(),
            videoCount: row.statsSnapshots[0].videoCount,
            capturedAt: row.statsSnapshots[0].capturedAt.toISOString(),
          }
        : null,
    })),
  });
}
