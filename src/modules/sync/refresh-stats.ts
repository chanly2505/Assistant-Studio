import type { SyncTier } from '@prisma/client';
import type { Logger } from 'pino';

import { prisma } from '@/db/prisma';
import { syncJobRepository } from '@/db/repositories/sync-job.repository';
import { videoRepository } from '@/db/repositories/video.repository';
import { AppError } from '@/domain/errors/app-error';
import { classifyTier } from '@/domain/youtube/sync-tier';
import { toVideoRecord } from '@/services/youtube/mappers';
import { getYouTubeService } from '@/services/youtube/youtube.service';
import { VIDEOS_PER_REQUEST } from '@/services/youtube/youtube-data.client';

import { runSyncJob, type SyncTrigger } from './run-sync-job';

/**
 * Tiered statistics refresh.
 * docs/architecture/06-youtube-integration-architecture.md §6.3
 *
 * HOT (≤30 days old, or a top-10 video by views) daily, WARM (≤180 days) every
 * 3 days, COLD weekly. A 500-video channel costs ~2 units a day instead of 10.
 */

/** The top videos stay HOT regardless of age: an evergreen tutorial keeps moving. */
export const TOP_PERFORMERS = 10;

/** Per run: 10 batches = 500 videos = 10 units. The rest wait for the next run. */
export const MAX_STATS_BATCHES = 10;

export async function refreshVideoStats(params: {
  userId: string;
  channelId: string;
  trigger: SyncTrigger;
  attempt?: number;
  log?: Logger;
}) {
  return runSyncJob({ ...params, jobType: 'VIDEO_STATS' }, async (context) => {
    const { channel, token, log, now } = context;
    const tiersChanged = await recomputeTiers(channel.id, now);

    const due = await videoRepository.dueForStats(
      channel.id,
      now,
      MAX_STATS_BATCHES * VIDEOS_PER_REQUEST,
    );

    let refreshed = 0;
    let markedDeleted = 0;
    for (let offset = 0; offset < due.length; offset += VIDEOS_PER_REQUEST) {
      const batch = due.slice(offset, offset + VIDEOS_PER_REQUEST);
      await context.spend('videos.list');
      const raw = await getYouTubeService().listVideos(token, batch, log);

      // The upsert also picks up title, privacy and thumbnail changes.
      await videoRepository.upsertWithStats(
        channel.id,
        raw.map((video) => toVideoRecord(video, now)),
        now,
      );
      refreshed += raw.length;
      context.addItems(raw.length);

      const returned = new Set(raw.map((video) => video.id));
      markedDeleted += await videoRepository.markDeleted(
        channel.id,
        batch.filter((id) => !returned.has(id)),
        now,
      );
    }

    return { due: due.length, refreshed, markedDeleted, tiersChanged };
  });
}

/** Re-derives every live video's tier. Returns how many changed. */
export async function recomputeTiers(channelId: string, now: Date): Promise<number> {
  const [videos, top] = await Promise.all([
    videoRepository.liveVideosForTiering(channelId),
    videoRepository.topByLatestViews(channelId, TOP_PERFORMERS),
  ]);
  const topSet = new Set(top);

  const changes: Array<{ id: string; syncTier: SyncTier }> = [];
  for (const video of videos) {
    const tier = classifyTier(video.publishedAt, now, topSet.has(video.id));
    if (tier !== video.syncTier) changes.push({ id: video.id, syncTier: tier });
  }

  await videoRepository.setTiers(changes);
  return changes.length;
}

/**
 * Channel-level counters: one channels.list call (1 unit).
 * Also refreshes the title, handle and avatar a creator may have changed.
 */
export async function refreshChannelStats(params: {
  userId: string;
  channelId: string;
  trigger: SyncTrigger;
  attempt?: number;
  log?: Logger;
}) {
  return runSyncJob({ ...params, jobType: 'CHANNEL_STATS' }, async (context) => {
    const { channel, token, log, now } = context;

    await context.spend('channels.list');
    const owned = await getYouTubeService().listOwnedChannels(token, log);
    const current = owned.find((item) => item.youtubeChannelId === channel.youtubeChannelId);

    if (!current) {
      // The grant no longer reaches this channel (ownership moved, brand
      // account removed). Reconnecting is the only fix.
      throw new AppError('YOUTUBE_REAUTH_REQUIRED', {
        detail: 'channel is not returned by channels.list for its grant',
      });
    }

    await prisma.$transaction([
      prisma.channelStatsSnapshot.create({
        data: {
          channelId: channel.id,
          capturedAt: now,
          subscriberCount: current.subscriberCount,
          viewCount: current.viewCount,
          videoCount: current.videoCount,
        },
      }),
      prisma.youTubeChannel.update({
        where: { id: channel.id },
        data: {
          title: current.title,
          handle: current.handle,
          description: current.description,
          thumbnailUrl: current.thumbnailUrl,
          uploadsPlaylistId: current.uploadsPlaylistId,
        },
      }),
    ]);
    await syncJobRepository.recordStatsSync(channel.id, now);
    context.addItems(1);

    return { subscriberCount: current.subscriberCount, videoCount: current.videoCount };
  });
}
