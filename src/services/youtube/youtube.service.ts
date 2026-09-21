import 'server-only';

import type { Logger } from 'pino';

import { notImplemented } from '@/domain/errors/app-error';
import type { SecretString } from '@/domain/shared/secret';

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
 * (Phase 4). NOT_IMPLEMENTED until Phase 5: analytics — it throws rather than
 * returning invented data.
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

export interface AnalyticsRow {
  date: string;
  views: bigint;
  estimatedMinutesWatched: bigint;
  averageViewDuration: number;
  subscribersGained: number;
  subscribersLost: number;
  likes: number;
  comments: number;
  shares: number;
}

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
   * youtubeAnalytics.reports.query. Callers pass a trailing window that overlaps
   * already-fetched days, because YouTube revises recent data for ~3 days.
   */
  getChannelAnalytics(
    accessToken: SecretString,
    youtubeChannelId: string,
    from: Date,
    to: Date,
  ): Promise<AnalyticsRow[]>;
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

  async getChannelAnalytics(): Promise<never> {
    throw notImplemented('youtube.getChannelAnalytics');
  }
}

let service: YouTubeService = new GoogleYouTubeService();

export function getYouTubeService(): YouTubeService {
  return service;
}

export function setYouTubeService(next: YouTubeService): void {
  service = next;
}
