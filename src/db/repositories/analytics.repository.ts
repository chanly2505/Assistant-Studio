import { prisma } from '@/db/prisma';
import { fromDay, isProvisional, toDay } from '@/domain/youtube/analytics';

/**
 * Daily analytics storage.
 *
 * Every write is an UPSERT on (channel|video, day). Re-fetching the trailing
 * window overwrites revised figures instead of appending duplicates, and flips
 * `isProvisional` off once a day leaves YouTube's processing window.
 *
 * Days YouTube returned no row for are NOT written: absence means "unknown",
 * and writing a 0 would present unknown as fact.
 */

export interface StoredDay {
  day: string;
  views: number;
  estimatedMinutesWatched: number;
  averageViewDuration: number;
  averageViewPercentage?: number | null;
  subscribersGained: number;
  subscribersLost: number;
  likes: number;
  comments: number;
  shares: number;
}

export const analyticsRepository = {
  async upsertChannelDays(
    channelId: string,
    days: StoredDay[],
    fetchedOn: string,
  ): Promise<number> {
    if (days.length === 0) return 0;
    const now = new Date();

    await prisma.$transaction(
      days.map((d) => {
        const values = {
          views: BigInt(d.views),
          estimatedMinutesWatched: BigInt(d.estimatedMinutesWatched),
          averageViewDuration: d.averageViewDuration,
          subscribersGained: d.subscribersGained,
          subscribersLost: d.subscribersLost,
          likes: d.likes,
          comments: d.comments,
          shares: d.shares,
          fetchedAt: now,
          isProvisional: isProvisional(d.day, fetchedOn),
        };
        return prisma.channelAnalyticsDaily.upsert({
          where: { channelId_date: { channelId, date: fromDay(d.day) } },
          create: { channelId, date: fromDay(d.day), ...values },
          update: values,
        });
      }),
    );
    return days.length;
  },

  async upsertVideoDays(videoId: string, days: StoredDay[], fetchedOn: string): Promise<number> {
    if (days.length === 0) return 0;
    const now = new Date();

    await prisma.$transaction(
      days.map((d) => {
        const values = {
          views: BigInt(d.views),
          estimatedMinutesWatched: BigInt(d.estimatedMinutesWatched),
          averageViewDuration: d.averageViewDuration,
          averageViewPercentage: d.averageViewPercentage ?? 0,
          likes: d.likes,
          comments: d.comments,
          shares: d.shares,
          subscribersGained: d.subscribersGained,
          fetchedAt: now,
          isProvisional: isProvisional(d.day, fetchedOn),
        };
        return prisma.videoAnalyticsDaily.upsert({
          where: { videoId_date: { videoId, date: fromDay(d.day) } },
          create: { videoId, date: fromDay(d.day), ...values },
          update: values,
        });
      }),
    );
    return days.length;
  },

  async latestVideoDay(videoId: string): Promise<string | null> {
    const row = await prisma.videoAnalyticsDaily.findFirst({
      where: { videoId },
      orderBy: { date: 'desc' },
      select: { date: true },
    });
    return row ? toDay(row.date) : null;
  },

  async recordChannelProgress(channelId: string, lastDay: string): Promise<void> {
    await prisma.youTubeChannel.update({
      where: { id: channelId },
      data: { lastAnalyticsDate: fromDay(lastDay) },
    });
  },

  /**
   * Channel series for a range. Ownership is in the WHERE clause, so another
   * user's channel id yields no rows.
   */
  async channelSeries(userId: string, channelId: string, from: string, to: string) {
    const rows = await prisma.channelAnalyticsDaily.findMany({
      where: {
        channelId,
        channel: { userId },
        date: { gte: fromDay(from), lte: fromDay(to) },
      },
      orderBy: { date: 'asc' },
    });
    return rows.map((row) => ({
      day: toDay(row.date),
      views: Number(row.views),
      estimatedMinutesWatched: Number(row.estimatedMinutesWatched),
      averageViewDuration: row.averageViewDuration,
      subscribersGained: row.subscribersGained,
      subscribersLost: row.subscribersLost,
      likes: row.likes,
      comments: row.comments,
      shares: row.shares,
      isProvisional: row.isProvisional,
    }));
  },

  /** Per-video totals over a range, for the videos we track daily. */
  async videoTotals(userId: string, channelId: string, from: string, to: string, limit: number) {
    const rows = await prisma.videoAnalyticsDaily.groupBy({
      by: ['videoId'],
      where: {
        date: { gte: fromDay(from), lte: fromDay(to) },
        video: { channelId, channel: { userId }, deletedFromYouTubeAt: null },
      },
      _sum: { views: true, estimatedMinutesWatched: true },
      orderBy: { _sum: { views: 'desc' } },
      take: limit,
    });
    if (rows.length === 0) return [];

    const videos = await prisma.youTubeVideo.findMany({
      where: { id: { in: rows.map((row) => row.videoId) } },
      select: { id: true, title: true, youtubeVideoId: true, publishedAt: true },
    });
    const byId = new Map(videos.map((video) => [video.id, video]));

    return rows.flatMap((row) => {
      const video = byId.get(row.videoId);
      if (!video) return [];
      return [
        {
          videoId: row.videoId,
          youtubeVideoId: video.youtubeVideoId,
          title: video.title,
          publishedAt: video.publishedAt,
          views: Number(row._sum.views ?? 0n),
          watchMinutes: Number(row._sum.estimatedMinutesWatched ?? 0n),
        },
      ];
    });
  },
} as const;
