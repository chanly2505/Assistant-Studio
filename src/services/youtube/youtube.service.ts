import 'server-only';

import type { Logger } from 'pino';

import { CHANNEL_METRICS, VIDEO_METRICS, type Window } from '@/domain/youtube/analytics';
import type { SecretString } from '@/domain/shared/secret';

import { queryReport, toAnalyticsDays, type AnalyticsDay } from './youtube-analytics.client';
import {
  listOwnedChannels,
  listPlaylistPage,
  listVideos,
  type PlaylistPage,
  type RawVideo,
} from './youtube-data.client';

/**
 * YouTube integration seam.
 * docs/architecture/06-youtube-integration-architecture.md
 *
 * Methods take an ACCESS TOKEN, not a connection id. Turning a connection into
 * a token needs the database (decrypt, refresh, mark REAUTH_REQUIRED), and the
 * service layer may not touch the database — that belongs to the application
 * layer, in src/modules/youtube/access-token.ts.
 *
 * The service exposes single-call primitives. Paging decisions ("stop at the
 * first video we already know"), quota reservation per call and persistence
 * all need the database, so they live in src/modules/sync/.
 *
 * Implemented: listOwnedChannels (Phase 3), listPlaylistPage + listVideos
 * (Phase 4), channel and per-video daily analytics (Phase 5).
 */

export interface YouTubeChannelSummary {
  youtubeChannelId: string;
  title: string;
  handle: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  country: string | null;
  uploadsPlaylistId: string;
  publishedAt: Date | null;
  /** null when the creator hides it. Rounded to 3 significant figures by YouTube. */
  subscriberCount: bigint | null;
  viewCount: bigint;
  videoCount: number;
}

export type { AnalyticsDay } from './youtube-analytics.client';

export interface YouTubeService {
  /** channels.list(mine=true) — 1 quota unit. */
  listOwnedChannels(accessToken: SecretString, log?: Logger): Promise<YouTubeChannelSummary[]>;

  /** One page (≤50 ids) of the uploads playlist, newest first — 1 quota unit. */
  listPlaylistPage(
    accessToken: SecretString,
    playlistId: string,
    pageToken: string | null,
    log?: Logger,
  ): Promise<PlaylistPage>;

  /** Up to 50 videos' metadata + statistics — 1 quota unit. */
  listVideos(accessToken: SecretString, videoIds: string[], log?: Logger): Promise<RawVideo[]>;

  /**
   * Channel daily series (dimensions=day). Callers pass a window that overlaps
   * days already stored, because YouTube revises the last ~3 days.
   */
  getChannelDailyAnalytics(
    accessToken: SecretString,
    youtubeChannelId: string,
    window: Window,
    log?: Logger,
  ): Promise<AnalyticsDay[]>;

  /** One video's daily series (dimensions=day, filters=video==ID). */
  getVideoDailyAnalytics(
    accessToken: SecretString,
    youtubeChannelId: string,
    youtubeVideoId: string,
    window: Window,
    log?: Logger,
  ): Promise<AnalyticsDay[]>;
}

export class GoogleYouTubeService implements YouTubeService {
  listOwnedChannels(accessToken: SecretString, log?: Logger) {
    return listOwnedChannels(accessToken, log);
  }

  listPlaylistPage(
    accessToken: SecretString,
    playlistId: string,
    pageToken: string | null,
    log?: Logger,
  ) {
    return listPlaylistPage(accessToken, playlistId, pageToken, log);
  }

  listVideos(accessToken: SecretString, videoIds: string[], log?: Logger) {
    return listVideos(accessToken, videoIds, log);
  }

  async getChannelDailyAnalytics(
    accessToken: SecretString,
    youtubeChannelId: string,
    window: Window,
    log?: Logger,
  ) {
    const rows = await queryReport(
      accessToken,
      { youtubeChannelId, ...window, metrics: CHANNEL_METRICS, dimensions: ['day'], sort: 'day' },
      log,
    );
    return toAnalyticsDays(rows);
  }

  async getVideoDailyAnalytics(
    accessToken: SecretString,
    youtubeChannelId: string,
    youtubeVideoId: string,
    window: Window,
    log?: Logger,
  ) {
    const rows = await queryReport(
      accessToken,
      {
        youtubeChannelId,
        ...window,
        metrics: VIDEO_METRICS,
        dimensions: ['day'],
        filters: `video==${youtubeVideoId}`,
        sort: 'day',
      },
      log,
    );
    return toAnalyticsDays(rows);
  }
}

let service: YouTubeService = new GoogleYouTubeService();

export function getYouTubeService(): YouTubeService {
  return service;
}

export function setYouTubeService(next: YouTubeService): void {
  service = next;
}
