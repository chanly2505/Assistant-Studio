import { analyticsRepository } from '@/db/repositories/analytics.repository';
import { channelRepository } from '@/db/repositories/channel.repository';
import { userRepository } from '@/db/repositories/user.repository';
import { notFound } from '@/domain/errors/app-error';
import { err, ok, type Result } from '@/domain/errors/result';
import {
  PROVISIONAL_DAYS,
  addDays,
  changeRatio,
  eachDay,
  toDay,
  totalsOf,
  type PeriodTotals,
} from '@/domain/youtube/analytics';
import { quotaDayKey } from '@/domain/youtube/quota';

/**
 * Channel analytics for a period, read from Postgres only.
 *
 * The period ends on the latest day YouTube has data for — not on today — so a
 * "last 28 days" view is not two or three empty days short because of
 * YouTube's 48–72 h processing delay.
 */

export const PERIODS = [7, 28, 90, 365] as const;
export type PeriodDays = (typeof PERIODS)[number];

/** Used when a plan row has no explicit setting. */
const DEFAULT_HISTORY_DAYS = 90;

export interface SeriesPoint {
  day: string;
  /** null = YouTube returned no row for this day. Unknown, never zero. */
  views: number | null;
  watchMinutes: number | null;
  netSubscribers: number | null;
  provisional: boolean;
}

export interface ChannelAnalytics {
  channel: { id: string; title: string };
  period: { days: number; from: string; to: string; requestedDays: number; limitedByPlan: boolean };
  /** Latest day whose figures are final. Newer days may still be revised. */
  dataThrough: string | null;
  hasAnyData: boolean;
  totals: PeriodTotals;
  previous: PeriodTotals;
  change: {
    /** Relative change (0.12 = +12%). Views and watch time are never negative. */
    views: number | null;
    watchHours: number | null;
    /**
     * ABSOLUTE difference, not a ratio: net subscribers can be negative, and a
     * ratio against a negative baseline flips sign (−10 → +5 would read −150%).
     */
    netSubscribersDelta: number | null;
  };
  series: SeriesPoint[];
  topVideos: Array<{
    youtubeVideoId: string;
    title: string;
    views: number;
    watchHours: number;
  }>;
}

export async function getChannelAnalytics(input: {
  userId: string;
  channelId: string;
  periodDays: PeriodDays;
}): Promise<Result<ChannelAnalytics>> {
  const channel = await channelRepository.findForUser(input.userId, input.channelId);
  if (!channel) return err(notFound('channel'));

  const features = await userRepository.planFeatures(input.userId);
  const historyDays =
    typeof features.analyticsHistoryDays === 'number'
      ? features.analyticsHistoryDays
      : DEFAULT_HISTORY_DAYS;
  const days = Math.min(input.periodDays, historyDays);

  const to = channel.lastAnalyticsDate
    ? toDay(channel.lastAnalyticsDate)
    : addDays(quotaDayKey(new Date()), -PROVISIONAL_DAYS);
  const from = addDays(to, -(days - 1));
  const previousTo = addDays(from, -1);
  const previousFrom = addDays(previousTo, -(days - 1));

  const [current, previousRows, top] = await Promise.all([
    analyticsRepository.channelSeries(input.userId, channel.id, from, to),
    analyticsRepository.channelSeries(input.userId, channel.id, previousFrom, previousTo),
    analyticsRepository.videoTotals(input.userId, channel.id, from, to, 10),
  ]);

  const byDay = new Map(current.map((row) => [row.day, row]));
  const series: SeriesPoint[] = eachDay(from, to).map((day) => {
    const row = byDay.get(day);
    return row
      ? {
          day,
          views: row.views,
          watchMinutes: row.estimatedMinutesWatched,
          netSubscribers: row.subscribersGained - row.subscribersLost,
          provisional: row.isProvisional,
        }
      : { day, views: null, watchMinutes: null, netSubscribers: null, provisional: false };
  });

  const totals = totalsOf(current);
  const previous = totalsOf(previousRows);
  // A comparison needs a comparable baseline: a previous period we have (almost)
  // no data for would produce a meaningless "+900%".
  const comparable = previous.daysWithData >= Math.ceil(days / 2);

  const finals = current.filter((row) => !row.isProvisional);

  return ok({
    channel: { id: channel.id, title: channel.title },
    period: {
      days,
      from,
      to,
      requestedDays: input.periodDays,
      limitedByPlan: days < input.periodDays,
    },
    dataThrough: finals.length ? (finals.at(-1)?.day ?? null) : null,
    hasAnyData: current.length > 0,
    totals,
    previous,
    change: {
      views: comparable ? changeRatio(totals.views, previous.views) : null,
      watchHours: comparable ? changeRatio(totals.watchHours, previous.watchHours) : null,
      netSubscribersDelta: comparable ? totals.netSubscribers - previous.netSubscribers : null,
    },
    series,
    topVideos: top.map((video) => ({
      youtubeVideoId: video.youtubeVideoId,
      title: video.title,
      views: video.views,
      watchHours: video.watchMinutes / 60,
    })),
  });
}
