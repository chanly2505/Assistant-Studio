import type { Logger } from 'pino';

import { analyticsRepository } from '@/db/repositories/analytics.repository';
import { videoRepository } from '@/db/repositories/video.repository';
import { channelWindow, toDay, videoWindow } from '@/domain/youtube/analytics';
import { quotaDayKey } from '@/domain/youtube/quota';
import { getYouTubeService } from '@/services/youtube/youtube.service';

import { runSyncJob, type SyncTrigger } from './run-sync-job';

/**
 * Daily analytics sync.
 * docs/architecture/06-youtube-integration-architecture.md §6.3
 *
 *   channel series — ONE request covers the whole window: 365 days on first
 *                    sync, the trailing 7 afterwards (YouTube revises recent
 *                    days, so they are fetched again and overwritten).
 *   video series   — one request per video, for the HOT tier only (recent
 *                    uploads and top performers), capped per run. Older videos
 *                    barely move; a daily series for every upload would cost
 *                    one request per video per day for little information.
 *
 * Requests are counted against our own Analytics API budget, separate from the
 * Data API quota.
 */

/** Per run: at most this many per-video requests. */
export const MAX_VIDEO_SERIES = 20;

export interface AnalyticsSyncResult {
  channelDays: number;
  channelWindow: { startDate: string; endDate: string };
  videosTracked: number;
  videoDays: number;
  latestDay: string | null;
}

export async function syncAnalytics(params: {
  userId: string;
  channelId: string;
  trigger: SyncTrigger;
  attempt?: number;
  log?: Logger;
}) {
  return runSyncJob({ ...params, jobType: 'ANALYTICS' }, async (context) => {
    const { channel, token, log, now } = context;
    const youtube = getYouTubeService();
    // Every day key in this job uses ONE calendar — Pacific, the one the quota
    // day also uses. Mixing it with UTC dates shifts windows by a day around
    // midnight. Requesting days that have no data yet is harmless: those rows
    // are simply omitted.
    const today = quotaDayKey(now);

    /* Channel series ---------------------------------------------------- */
    const window = channelWindow({
      today,
      lastStoredDay: channel.lastAnalyticsDate ? toDay(channel.lastAnalyticsDate) : null,
      channelCreatedDay: channel.publishedAt ? quotaDayKey(channel.publishedAt) : null,
    });

    await context.spendAnalytics();
    const days = await youtube.getChannelDailyAnalytics(
      token,
      channel.youtubeChannelId,
      window,
      log,
    );
    const channelDays = await analyticsRepository.upsertChannelDays(channel.id, days, today);
    context.addItems(channelDays);

    const latestDay = days.reduce<string | null>(
      (max, day) => (max === null || day.day > max ? day.day : max),
      null,
    );
    if (latestDay) await analyticsRepository.recordChannelProgress(channel.id, latestDay);

    /* Video series ------------------------------------------------------ */
    const hot = await videoRepository.hotVideos(channel.id, MAX_VIDEO_SERIES);
    let videoDays = 0;

    for (const video of hot) {
      const videoRange = videoWindow({
        today,
        lastStoredDay: await analyticsRepository.latestVideoDay(video.id),
        // Same calendar as `today`. A UTC day here would start the window a day
        // late for evening (Pacific) uploads and drop the video's first day.
        publishedDay: quotaDayKey(video.publishedAt),
      });

      await context.spendAnalytics();
      const series = await youtube.getVideoDailyAnalytics(
        token,
        channel.youtubeChannelId,
        video.youtubeVideoId,
        videoRange,
        log,
      );
      videoDays += await analyticsRepository.upsertVideoDays(video.id, series, today);
    }
    context.addItems(videoDays);

    return {
      channelDays,
      channelWindow: window,
      videosTracked: hot.length,
      videoDays,
      latestDay,
    } satisfies AnalyticsSyncResult;
  });
}
