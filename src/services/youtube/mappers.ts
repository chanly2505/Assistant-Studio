import type { SyncTier, VideoPrivacyStatus } from '@prisma/client';

import { isShortForm, parseIsoDuration } from '@/domain/youtube/duration';
import { classifyTier } from '@/domain/youtube/sync-tier';

import type { RawVideo } from './youtube-data.client';

export interface VideoRecord {
  youtubeVideoId: string;
  title: string;
  description: string | null;
  publishedAt: Date;
  durationSeconds: number;
  privacyStatus: VideoPrivacyStatus;
  thumbnailUrl: string | null;
  tags: string[];
  categoryId: string | null;
  defaultLanguage: string | null;
  isShortForm: boolean;
  syncTier: SyncTier;
}

export interface VideoStats {
  viewCount: bigint;
  /** null when the creator hides likes — never 0 for "hidden". */
  likeCount: bigint | null;
  /** null when comments are disabled. */
  commentCount: bigint | null;
}

const PRIVACY: Record<string, VideoPrivacyStatus> = {
  public: 'PUBLIC',
  unlisted: 'UNLISTED',
  private: 'PRIVATE',
};

export function toVideoRecord(raw: RawVideo, now: Date): { video: VideoRecord; stats: VideoStats } {
  const publishedAt = new Date(raw.snippet.publishedAt);
  const durationSeconds = parseIsoDuration(raw.contentDetails?.duration) ?? 0;
  const thumbnails = raw.snippet.thumbnails;

  return {
    video: {
      youtubeVideoId: raw.id,
      title: raw.snippet.title,
      description: raw.snippet.description ?? null,
      publishedAt,
      durationSeconds,
      privacyStatus: PRIVACY[raw.status?.privacyStatus ?? 'public'] ?? 'PUBLIC',
      thumbnailUrl:
        thumbnails?.medium?.url ?? thumbnails?.high?.url ?? thumbnails?.default?.url ?? null,
      tags: raw.snippet.tags ?? [],
      categoryId: raw.snippet.categoryId ?? null,
      defaultLanguage: raw.snippet.defaultLanguage ?? raw.snippet.defaultAudioLanguage ?? null,
      isShortForm: isShortForm(durationSeconds),
      syncTier: classifyTier(publishedAt, now),
    },
    stats: {
      viewCount: BigInt(raw.statistics?.viewCount ?? '0'),
      likeCount: raw.statistics?.likeCount !== undefined ? BigInt(raw.statistics.likeCount) : null,
      commentCount:
        raw.statistics?.commentCount !== undefined ? BigInt(raw.statistics.commentCount) : null,
    },
  };
}
