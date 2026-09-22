import type { SyncTier, YouTubeVideo } from '@prisma/client';

import { prisma } from '@/db/prisma';
import { TIER_REFRESH_INTERVAL_DAYS } from '@/domain/youtube/sync-tier';

/**
 * Videos and their statistics snapshots.
 *
 * Sync-side methods take a channel id the caller has already resolved through
 * an ownership-checked lookup. The read method for the UI takes the userId and
 * enforces ownership itself, in SQL.
 */

export interface VideoUpsert {
  youtubeVideoId: string;
  title: string;
  description: string | null;
  publishedAt: Date;
  durationSeconds: number;
  privacyStatus: 'PUBLIC' | 'UNLISTED' | 'PRIVATE';
  thumbnailUrl: string | null;
  tags: string[];
  categoryId: string | null;
  defaultLanguage: string | null;
  isShortForm: boolean;
  syncTier: SyncTier;
}

export interface VideoStatsInput {
  viewCount: bigint;
  likeCount: bigint | null;
  commentCount: bigint | null;
}

const DAY_MS = 86_400_000;

export const videoRepository = {
  /** Which of these YouTube ids does this channel already have? */
  async knownIds(channelId: string, youtubeVideoIds: string[]): Promise<Set<string>> {
    if (youtubeVideoIds.length === 0) return new Set();
    const rows = await prisma.youTubeVideo.findMany({
      where: { channelId, youtubeVideoId: { in: youtubeVideoIds } },
      select: { youtubeVideoId: true },
    });
    return new Set(rows.map((row) => row.youtubeVideoId));
  },

  /**
   * Upserts videos and appends one statistics snapshot each, in one
   * transaction. Idempotent on youtubeVideoId: running a page twice updates,
   * never duplicates.
   *
   * `syncTier` is applied on CREATE only; afterwards the tier job owns it (it
   * may promote an old video that still draws views).
   */
  async upsertWithStats(
    channelId: string,
    items: Array<{ video: VideoUpsert; stats: VideoStatsInput }>,
    now = new Date(),
  ): Promise<{ created: number; updated: number }> {
    if (items.length === 0) return { created: 0, updated: 0 };

    const existing = await this.knownIds(
      channelId,
      items.map((item) => item.video.youtubeVideoId),
    );

    await prisma.$transaction(async (tx) => {
      for (const { video, stats } of items) {
        const { syncTier, ...fields } = video;
        const row = await tx.youTubeVideo.upsert({
          where: { youtubeVideoId: video.youtubeVideoId },
          create: { ...fields, syncTier, channelId, lastStatsSyncAt: now },
          update: { ...fields, lastStatsSyncAt: now, deletedFromYouTubeAt: null },
          select: { id: true },
        });
        await tx.videoStatsSnapshot.create({
          data: { videoId: row.id, capturedAt: now, ...stats },
        });
      }
    });

    const created = items.filter((item) => !existing.has(item.video.youtubeVideoId)).length;
    return { created, updated: items.length - created };
  },

  /** Marks videos gone from YouTube. History is kept; nothing is deleted. */
  async markDeleted(
    channelId: string,
    youtubeVideoIds: string[],
    now = new Date(),
  ): Promise<number> {
    if (youtubeVideoIds.length === 0) return 0;
    const { count } = await prisma.youTubeVideo.updateMany({
      where: { channelId, youtubeVideoId: { in: youtubeVideoIds }, deletedFromYouTubeAt: null },
      data: { deletedFromYouTubeAt: now },
    });
    return count;
  },

  /** Every live video id on the channel — for deletion detection after a full walk. */
  async liveIds(channelId: string): Promise<string[]> {
    const rows = await prisma.youTubeVideo.findMany({
      where: { channelId, deletedFromYouTubeAt: null },
      select: { youtubeVideoId: true },
    });
    return rows.map((row) => row.youtubeVideoId);
  },

  /**
   * Videos whose tier says their statistics are stale, oldest first.
   * The intervals come from the domain (TIER_REFRESH_INTERVAL_DAYS) so this
   * query and `isStatsRefreshDue` cannot disagree.
   */
  async dueForStats(channelId: string, now: Date, limit: number): Promise<string[]> {
    const before = (tier: SyncTier) =>
      new Date(now.getTime() - TIER_REFRESH_INTERVAL_DAYS[tier] * DAY_MS);

    const rows = await prisma.youTubeVideo.findMany({
      where: {
        channelId,
        deletedFromYouTubeAt: null,
        OR: [
          { lastStatsSyncAt: null },
          { syncTier: 'HOT', lastStatsSyncAt: { lte: before('HOT') } },
          { syncTier: 'WARM', lastStatsSyncAt: { lte: before('WARM') } },
          { syncTier: 'COLD', lastStatsSyncAt: { lte: before('COLD') } },
        ],
      },
      orderBy: [{ lastStatsSyncAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      take: limit,
      select: { youtubeVideoId: true },
    });
    return rows.map((row) => row.youtubeVideoId);
  },

  /** The N live videos with the highest latest view count. */
  async topByLatestViews(channelId: string, limit: number): Promise<string[]> {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT v."id"
      FROM "YouTubeVideo" v
      JOIN LATERAL (
        SELECT s."viewCount" FROM "VideoStatsSnapshot" s
        WHERE s."videoId" = v."id" ORDER BY s."capturedAt" DESC LIMIT 1
      ) latest ON true
      WHERE v."channelId" = ${channelId} AND v."deletedFromYouTubeAt" IS NULL
      ORDER BY latest."viewCount" DESC, v."id" ASC
      LIMIT ${limit}
    `;
    return rows.map((row) => row.id);
  },

  /**
   * Recent live uploads with their latest view count — raw material for the AI
   * context builder, which reduces it to relative figures before any prompt.
   */
  async recentWithLatestViews(channelId: string, since: Date, limit: number) {
    const rows = await prisma.youTubeVideo.findMany({
      where: { channelId, deletedFromYouTubeAt: null, publishedAt: { gte: since } },
      orderBy: { publishedAt: 'desc' },
      take: limit,
      select: {
        title: true,
        publishedAt: true,
        durationSeconds: true,
        isShortForm: true,
        statsSnapshots: { orderBy: { capturedAt: 'desc' }, take: 1, select: { viewCount: true } },
      },
    });
    return rows.map(({ statsSnapshots, ...video }) => ({
      ...video,
      views: statsSnapshots[0] ? Number(statsSnapshots[0].viewCount) : null,
    }));
  },

  /**
   * Videos worth a daily analytics series: the HOT tier (recent, or a top
   * performer), newest first. Capped by the caller.
   */
  async hotVideos(channelId: string, limit: number) {
    return prisma.youTubeVideo.findMany({
      where: { channelId, deletedFromYouTubeAt: null, syncTier: 'HOT' },
      orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, youtubeVideoId: true, publishedAt: true },
    });
  },

  async liveVideosForTiering(
    channelId: string,
  ): Promise<Array<Pick<YouTubeVideo, 'id' | 'publishedAt' | 'syncTier'>>> {
    return prisma.youTubeVideo.findMany({
      where: { channelId, deletedFromYouTubeAt: null },
      select: { id: true, publishedAt: true, syncTier: true },
    });
  },

  async setTiers(changes: Array<{ id: string; syncTier: SyncTier }>): Promise<void> {
    if (changes.length === 0) return;
    await prisma.$transaction(
      changes.map((change) =>
        prisma.youTubeVideo.update({
          where: { id: change.id },
          data: { syncTier: change.syncTier },
        }),
      ),
    );
  },

  /**
   * The videos page, newest first, with each video's latest snapshot.
   * Ownership is part of the WHERE clause (channel.userId), so another user's
   * channel id yields an empty page, never their data.
   */
  async pageForUser(params: {
    userId: string;
    channelId: string;
    limit: number;
    cursor?: { publishedAt: Date; id: string } | undefined;
  }) {
    return prisma.youTubeVideo.findMany({
      where: {
        channelId: params.channelId,
        channel: { userId: params.userId },
        deletedFromYouTubeAt: null,
        ...(params.cursor
          ? {
              OR: [
                { publishedAt: { lt: params.cursor.publishedAt } },
                { publishedAt: params.cursor.publishedAt, id: { lt: params.cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      // One extra row tells us whether another page exists.
      take: params.limit + 1,
      include: {
        statsSnapshots: {
          orderBy: { capturedAt: 'desc' },
          take: 1,
          select: { viewCount: true, likeCount: true, commentCount: true, capturedAt: true },
        },
      },
    });
  },
} as const;
