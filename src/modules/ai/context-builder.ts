import { prisma } from '@/db/prisma';
import { videoRepository } from '@/db/repositories/video.repository';
import type { ChannelContext } from '@/services/ai/ai-service';

/**
 * The ONLY path from YouTube data into a prompt.
 * docs/architecture/07-ai-architecture.md §7.5, 12 §F
 *
 * Emits derived signals, never raw API payloads:
 *   - creator-authored settings (niche, audience, voice, keywords)
 *   - median length, upload cadence, share of short uploads
 *   - the best recent titles, with views RELATIVE to the channel median
 *
 * Never: video or channel ids, descriptions, absolute view counts, comments,
 * viewer or demographic data. `tests/unit/ai/context-builder` asserts the
 * output contains none of these, so the rule is tested rather than trusted.
 */

const LOOKBACK_DAYS = 90;
const SAMPLE = 50;
const TOP_TITLES = 5;

export async function buildChannelContext(
  userId: string,
  channelId: string,
): Promise<ChannelContext> {
  const channel = await prisma.youTubeChannel.findFirst({
    where: { id: channelId, userId },
    select: {
      settings: { select: { niche: true, targetAudience: true, brandVoice: true, keywords: true } },
    },
  });
  if (!channel) return {};

  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
  const videos = await videoRepository.recentWithLatestViews(channelId, since, SAMPLE);
  return summarise(channel.settings, videos);
}

export interface RecentVideo {
  title: string;
  publishedAt: Date;
  durationSeconds: number;
  isShortForm: boolean;
  views: number | null;
}

/** Pure — unit-tested with fixtures. */
export function summarise(
  settings: {
    niche: string | null;
    targetAudience: string | null;
    brandVoice: string | null;
    keywords: string[];
  } | null,
  videos: RecentVideo[],
): ChannelContext {
  const context: ChannelContext = {};

  if (settings?.niche) context.niche = settings.niche;
  if (settings?.targetAudience) context.targetAudience = settings.targetAudience;
  if (settings?.brandVoice) context.brandVoice = settings.brandVoice;
  if (settings?.keywords?.length) context.keywords = settings.keywords.slice(0, 15);

  if (videos.length === 0) return context;

  const durations = videos.map((video) => video.durationSeconds).filter((d) => d > 0);
  if (durations.length) context.medianDurationSeconds = median(durations);

  context.shortFormShare = videos.filter((video) => video.isShortForm).length / videos.length;

  const weeks = LOOKBACK_DAYS / 7;
  const perWeek = videos.length / weeks;
  context.postingCadence =
    perWeek >= 1
      ? `about ${Math.round(perWeek)} per week`
      : `about ${Math.max(1, Math.round(perWeek * 4.3))} per month`;

  // Relative performance: a video's views over the channel's median. A small
  // channel's "1,200 views" and a big one's "1.2M" both become e.g. 3.0×.
  const viewed = videos.filter(
    (video): video is RecentVideo & { views: number } => video.views !== null,
  );
  const medianViews = viewed.length >= 3 ? median(viewed.map((video) => video.views)) : 0;
  if (medianViews > 0) {
    context.topTitles = viewed
      .map((video) => ({
        title: video.title,
        relativePerformance: round1(video.views / medianViews),
      }))
      .sort((a, b) => b.relativePerformance - a.relativePerformance)
      .slice(0, TOP_TITLES);
  }

  return context;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
