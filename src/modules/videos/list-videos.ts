import { channelRepository } from '@/db/repositories/channel.repository';
import { videoRepository } from '@/db/repositories/video.repository';
import { AppError, notFound } from '@/domain/errors/app-error';
import { err, ok, type Result } from '@/domain/errors/result';

/**
 * A channel's videos, newest first — read from Postgres, never from YouTube.
 * Cursor-paginated: offset pagination drifts while a sync is inserting rows
 * (docs/architecture/04 §4.5).
 */

export interface VideoListItem {
  id: string;
  youtubeVideoId: string;
  title: string;
  publishedAt: string;
  durationSeconds: number;
  privacyStatus: 'PUBLIC' | 'UNLISTED' | 'PRIVATE';
  thumbnailUrl: string | null;
  /** Length ≤ 3 min. A heuristic — YouTube does not say which videos are Shorts. */
  isShortForm: boolean;
  stats: {
    viewCount: string;
    likeCount: string | null;
    commentCount: string | null;
    capturedAt: string;
  } | null;
}

export interface VideoPage {
  videos: VideoListItem[];
  nextCursor: string | null;
  channel: { id: string; title: string; syncStatus: string; lastFullSyncAt: string | null };
}

export const MAX_PAGE_SIZE = 50;

export function encodeCursor(value: { publishedAt: Date; id: string }): string {
  return Buffer.from(`${value.publishedAt.toISOString()}|${value.id}`, 'utf8').toString(
    'base64url',
  );
}

export function decodeCursor(cursor: string): { publishedAt: Date; id: string } | null {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const publishedAt = iso ? new Date(iso) : null;
  if (!publishedAt || Number.isNaN(publishedAt.getTime()) || !id) return null;
  return { publishedAt, id };
}

export async function listVideos(input: {
  userId: string;
  channelId: string;
  cursor?: string | undefined;
  limit?: number | undefined;
}): Promise<Result<VideoPage>> {
  const channel = await channelRepository.findForUser(input.userId, input.channelId);
  if (!channel) return err(notFound('channel'));

  const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
  if (input.cursor && !cursor) {
    return err(
      new AppError('VALIDATION_FAILED', {
        detail: 'cursor is malformed',
        issues: [
          {
            path: 'query.cursor',
            messageKey: 'errors.validation.custom',
            message: 'Invalid cursor',
          },
        ],
      }),
    );
  }

  const limit = Math.min(Math.max(input.limit ?? 24, 1), MAX_PAGE_SIZE);
  const rows = await videoRepository.pageForUser({
    userId: input.userId,
    channelId: channel.id,
    limit,
    cursor: cursor ?? undefined,
  });

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const hasMore = rows.length > limit;

  return ok({
    channel: {
      id: channel.id,
      title: channel.title,
      syncStatus: channel.syncStatus,
      lastFullSyncAt: channel.lastFullSyncAt?.toISOString() ?? null,
    },
    nextCursor: hasMore && last ? encodeCursor(last) : null,
    videos: page.map((row) => {
      const snapshot = row.statsSnapshots[0];
      return {
        id: row.id,
        youtubeVideoId: row.youtubeVideoId,
        title: row.title,
        publishedAt: row.publishedAt.toISOString(),
        durationSeconds: row.durationSeconds,
        privacyStatus: row.privacyStatus,
        thumbnailUrl: row.thumbnailUrl,
        isShortForm: row.isShortForm,
        stats: snapshot
          ? {
              viewCount: snapshot.viewCount.toString(),
              likeCount: snapshot.likeCount?.toString() ?? null,
              commentCount: snapshot.commentCount?.toString() ?? null,
              capturedAt: snapshot.capturedAt.toISOString(),
            }
          : null,
      };
    }),
  });
}
