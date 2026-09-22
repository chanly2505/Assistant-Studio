import 'server-only';

import type { Logger } from 'pino';
import { z } from 'zod';

import { AppError } from '@/domain/errors/app-error';
import type { SecretString } from '@/domain/shared/secret';
import { QUOTA_COST } from '@/domain/youtube/quota';
import {
  describeShape,
  errorReason,
  googleRequest,
  type GoogleResponse,
} from '@/services/google/http';

import type { YouTubeChannelSummary } from './youtube.service';
import { config } from '@/lib/env';

/**
 * YouTube Data API v3 — the calls implemented so far.
 * docs/architecture/06-youtube-integration-architecture.md
 *
 * Every response is Zod-parsed before mapping: trusting an upstream shape is how
 * a schema change becomes a production incident.
 */

const API_BASE = config.external.youtubeData;

const Thumbnail = z.object({ url: z.string().url() }).partial();

const ChannelItem = z.object({
  id: z.string().min(1),
  snippet: z.object({
    title: z.string(),
    description: z.string().optional(),
    customUrl: z.string().optional(),
    publishedAt: z.string().datetime({ offset: true }).optional(),
    country: z.string().optional(),
    thumbnails: z
      .object({
        default: Thumbnail.optional(),
        medium: Thumbnail.optional(),
        high: Thumbnail.optional(),
      })
      .partial()
      .optional(),
  }),
  contentDetails: z.object({
    relatedPlaylists: z.object({ uploads: z.string().min(1) }),
  }),
  statistics: z
    .object({
      viewCount: z.string().regex(/^\d+$/).optional(),
      // Absent when the creator hides it.
      subscriberCount: z.string().regex(/^\d+$/).optional(),
      hiddenSubscriberCount: z.boolean().optional(),
      videoCount: z.string().regex(/^\d+$/).optional(),
    })
    .optional(),
});

const ChannelListResponse = z.object({
  // `items` is omitted entirely — not empty — when the account has no channel.
  items: z.array(ChannelItem).optional(),
});

export async function listOwnedChannels(
  accessToken: SecretString,
  log?: Logger,
): Promise<YouTubeChannelSummary[]> {
  const url = new URL(`${API_BASE}/channels`);
  url.search = new URLSearchParams({
    part: 'snippet,contentDetails,statistics',
    mine: 'true',
    maxResults: '50',
  }).toString();

  const response = await googleRequest({
    api: 'youtube_data',
    operation: 'channels.list',
    url: url.toString(),
    quotaUnits: QUOTA_COST['channels.list'],
    ...(log ? { log } : {}),
    init: { headers: { authorization: `Bearer ${accessToken.expose()}` } },
  });

  if (!response.ok) throw classifyYouTubeError(response, 'channels.list');

  const parsed = ChannelListResponse.safeParse(response.body);
  if (!parsed.success) {
    throw new AppError('UPSTREAM_UNAVAILABLE', {
      detail: `channels.list returned an unexpected shape ${describeShape(response.body)}`,
    });
  }

  return (parsed.data.items ?? []).map((item) => {
    const thumbnails = item.snippet.thumbnails;
    const stats = item.statistics;
    return {
      youtubeChannelId: item.id,
      title: item.snippet.title,
      handle: item.snippet.customUrl ?? null,
      description: item.snippet.description ?? null,
      thumbnailUrl: thumbnails?.medium?.url ?? thumbnails?.default?.url ?? null,
      country: item.snippet.country ?? null,
      uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads,
      publishedAt: item.snippet.publishedAt ? new Date(item.snippet.publishedAt) : null,
      subscriberCount:
        stats?.hiddenSubscriberCount || stats?.subscriberCount === undefined
          ? null
          : BigInt(stats.subscriberCount),
      viewCount: BigInt(stats?.viewCount ?? '0'),
      videoCount: Number(stats?.videoCount ?? '0'),
    };
  });
}

/**
 * Maps YouTube's error responses onto the taxonomy.
 * docs/architecture/06 §6.5
 */
export function classifyYouTubeError(response: GoogleResponse, operation: string): AppError {
  const reason = errorReason(response.body);
  const detail = `${operation} ${response.status} ${reason ?? ''}`.trim();
  const retry = response.retryAfterSeconds ? { retryAfterSeconds: response.retryAfterSeconds } : {};

  if (response.status === 401) {
    return new AppError('YOUTUBE_REAUTH_REQUIRED', { detail });
  }

  if (response.status === 403) {
    switch (reason) {
      case 'quotaExceeded':
      case 'dailyLimitExceeded':
        return new AppError('YOUTUBE_QUOTA_EXCEEDED', { detail });
      case 'insufficientPermissions':
      case 'ACCESS_TOKEN_SCOPE_INSUFFICIENT':
        return new AppError('YOUTUBE_INSUFFICIENT_SCOPE', { detail });
      case 'rateLimitExceeded':
      case 'userRateLimitExceeded':
        return new AppError('UPSTREAM_UNAVAILABLE', { detail, ...retry });
      default:
        return new AppError('FORBIDDEN', { detail });
    }
  }

  if (response.status === 404) return new AppError('NOT_FOUND', { detail });

  if (response.status === 429 || response.status >= 500) {
    return new AppError('UPSTREAM_UNAVAILABLE', { detail, ...retry });
  }

  return new AppError('UPSTREAM_UNAVAILABLE', { detail });
}

/* ------------------------------ uploads playlist ------------------------------ */

const PlaylistItemsResponse = z.object({
  nextPageToken: z.string().optional(),
  pageInfo: z.object({ totalResults: z.number().int().nonnegative() }).partial().optional(),
  items: z
    .array(
      z.object({
        contentDetails: z.object({
          videoId: z.string().min(1),
          // Absent for deleted/private-to-others entries.
          videoPublishedAt: z.string().optional(),
        }),
      }),
    )
    .default([]),
});

export interface PlaylistPage {
  videoIds: string[];
  nextPageToken: string | null;
  totalResults: number | null;
}

/**
 * One page (≤50) of a channel's uploads playlist, newest first. 1 quota unit.
 * This replaces search.list (100 units) for enumerating a channel's videos.
 *
 * A channel that has never uploaded may have no uploads playlist at all —
 * YouTube answers 404 playlistNotFound. That is an empty channel, not an error.
 */
export async function listPlaylistPage(
  accessToken: SecretString,
  playlistId: string,
  pageToken: string | null,
  log?: Logger,
): Promise<PlaylistPage> {
  const url = new URL(`${API_BASE}/playlistItems`);
  url.search = new URLSearchParams({
    part: 'contentDetails',
    playlistId,
    maxResults: '50',
    ...(pageToken ? { pageToken } : {}),
  }).toString();

  const response = await googleRequest({
    api: 'youtube_data',
    operation: 'playlistItems.list',
    url: url.toString(),
    quotaUnits: QUOTA_COST['playlistItems.list'],
    ...(log ? { log } : {}),
    init: { headers: { authorization: `Bearer ${accessToken.expose()}` } },
  });

  if (response.status === 404 && errorReason(response.body) === 'playlistNotFound') {
    return { videoIds: [], nextPageToken: null, totalResults: 0 };
  }
  if (!response.ok) throw classifyYouTubeError(response, 'playlistItems.list');

  const parsed = PlaylistItemsResponse.safeParse(response.body);
  if (!parsed.success) {
    throw new AppError('UPSTREAM_UNAVAILABLE', {
      detail: `playlistItems.list returned an unexpected shape ${describeShape(response.body)}`,
    });
  }

  return {
    videoIds: parsed.data.items.map((item) => item.contentDetails.videoId),
    nextPageToken: parsed.data.nextPageToken ?? null,
    totalResults: parsed.data.pageInfo?.totalResults ?? null,
  };
}

/* ----------------------------------- videos ----------------------------------- */

const count = z.string().regex(/^\d+$/).optional();

const VideoItem = z.object({
  id: z.string().min(1),
  snippet: z.object({
    title: z.string(),
    description: z.string().optional(),
    publishedAt: z.string().datetime({ offset: true }),
    tags: z.array(z.string()).optional(),
    categoryId: z.string().optional(),
    defaultLanguage: z.string().optional(),
    defaultAudioLanguage: z.string().optional(),
    thumbnails: z
      .object({
        medium: Thumbnail.optional(),
        high: Thumbnail.optional(),
        default: Thumbnail.optional(),
      })
      .partial()
      .optional(),
  }),
  contentDetails: z.object({ duration: z.string() }).partial().optional(),
  status: z
    .object({ privacyStatus: z.enum(['public', 'unlisted', 'private']) })
    .partial()
    .optional(),
  // Likes and comments are absent when the creator disables them.
  statistics: z.object({ viewCount: count, likeCount: count, commentCount: count }).optional(),
});

const VideoListResponse = z.object({ items: z.array(VideoItem).default([]) });

export type RawVideo = z.infer<typeof VideoItem>;

export const VIDEOS_PER_REQUEST = 50;

/**
 * Metadata + statistics for up to 50 videos in ONE call (1 quota unit).
 * Ids that are missing from the response were deleted or made unavailable.
 */
export async function listVideos(
  accessToken: SecretString,
  videoIds: string[],
  log?: Logger,
): Promise<RawVideo[]> {
  if (videoIds.length === 0) return [];
  if (videoIds.length > VIDEOS_PER_REQUEST) {
    throw new Error(
      `listVideos: at most ${VIDEOS_PER_REQUEST} ids per call, got ${videoIds.length}`,
    );
  }

  const url = new URL(`${API_BASE}/videos`);
  url.search = new URLSearchParams({
    part: 'snippet,contentDetails,statistics,status',
    id: videoIds.join(','),
    maxResults: String(VIDEOS_PER_REQUEST),
  }).toString();

  const response = await googleRequest({
    api: 'youtube_data',
    operation: 'videos.list',
    url: url.toString(),
    quotaUnits: QUOTA_COST['videos.list'],
    ...(log ? { log } : {}),
    init: { headers: { authorization: `Bearer ${accessToken.expose()}` } },
  });

  if (!response.ok) throw classifyYouTubeError(response, 'videos.list');

  const parsed = VideoListResponse.safeParse(response.body);
  if (!parsed.success) {
    throw new AppError('UPSTREAM_UNAVAILABLE', {
      detail: `videos.list returned an unexpected shape ${describeShape(response.body)}`,
    });
  }
  return parsed.data.items;
}
