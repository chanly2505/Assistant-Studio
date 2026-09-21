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

/**
 * YouTube Data API v3 — the calls implemented so far.
 * docs/architecture/06-youtube-integration-architecture.md
 *
 * Every response is Zod-parsed before mapping: trusting an upstream shape is how
 * a schema change becomes a production incident.
 */

const API_BASE = 'https://www.googleapis.com/youtube/v3';

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
