import 'server-only';

import type { Logger } from 'pino';

import { notImplemented } from '@/domain/errors/app-error';
import type { SecretString } from '@/domain/shared/secret';

import { listOwnedChannels } from './youtube-data.client';

/**
 * YouTube integration seam.
 * docs/architecture/06-youtube-integration-architecture.md
 *
 * Methods take an ACCESS TOKEN, not a connection id. Turning a connection into
 * a token needs the database (decrypt, refresh, mark REAUTH_REQUIRED), and the
 * service layer may not touch the database — that belongs to the application
 * layer, in src/modules/youtube/access-token.ts.
 *
 * Implemented: listOwnedChannels (Phase 3).
 * NOT_IMPLEMENTED until Phase 4/5: videos, stats, analytics. They throw rather
 * than return invented data.
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

export interface YouTubeVideoSummary {
  youtubeVideoId: string;
  title: string;
  description: string;
  publishedAt: Date;
  durationSeconds: number;
  privacyStatus: 'PUBLIC' | 'UNLISTED' | 'PRIVATE';
  thumbnailUrl: string | null;
  tags: string[];
  categoryId: string | null;
  viewCount: bigint;
  likeCount: bigint | null;
  commentCount: bigint | null;
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

  /**
   * Walks the uploads playlist, then batches videos.list 50 ids at a time.
   * Never uses search.list (100 units) — docs/architecture/06 §6.2.
   */
  listChannelVideos(
    accessToken: SecretString,
    uploadsPlaylistId: string,
    options?: { since?: Date; maxPages?: number },
  ): Promise<YouTubeVideoSummary[]>;

  /** videos.list for a batch of ids — 1 unit per 50. */
  getVideoStats(
    accessToken: SecretString,
    youtubeVideoIds: string[],
  ): Promise<YouTubeVideoSummary[]>;

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

  async listChannelVideos(): Promise<never> {
    throw notImplemented('youtube.listChannelVideos');
  }

  async getVideoStats(): Promise<never> {
    throw notImplemented('youtube.getVideoStats');
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
