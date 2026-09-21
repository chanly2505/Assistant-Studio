import Image from 'next/image';
import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { requireUser } from '@/lib/auth/current-user';
import { localePath } from '@/lib/i18n/paths';
import { listVideos } from '@/modules/videos/list-videos';

export const dynamic = 'force-dynamic';

/** Formats seconds as m:ss or h:mm:ss, the way YouTube shows durations. */
function formatDuration(total: number): string {
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

export default async function VideosPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; channelId: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { locale, channelId } = await params;
  const { cursor } = await searchParams;
  setRequestLocale(locale);

  const user = await requireUser(locale);
  const result = await listVideos({ userId: user.id, channelId, cursor });
  // Unknown, foreign or malformed: all look the same from outside.
  if (!result.ok) notFound();

  const t = await getTranslations('videos');
  const tc = await getTranslations('channels');
  const number = new Intl.NumberFormat(locale);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const { channel, videos, nextCursor } = result.data;
  const syncing = ['NEVER_SYNCED', 'QUEUED', 'SYNCING'].includes(channel.syncStatus);

  return (
    <main className="page page--wide">
      <p className="small">
        <Link href={localePath(locale, '/channels')}>← {t('back')}</Link>
      </p>
      <header className="page__header">
        <h1>
          {channel.title} · {t('title')}
        </h1>
        <p className="muted">
          {tc(`syncStatus.${channel.syncStatus}`)}
          {channel.lastFullSyncAt &&
            ` · ${tc('lastSynced', { date: date.format(new Date(channel.lastFullSyncAt)) })}`}
        </p>
      </header>

      {videos.length === 0 ? (
        <section className="card">
          <p className="muted">{syncing && !cursor ? t('emptyPending') : t('empty')}</p>
        </section>
      ) : (
        <ul className="video-list">
          {videos.map((video) => (
            <li key={video.id} className="card video">
              <div className="video__thumb">
                {video.thumbnailUrl ? (
                  <Image src={video.thumbnailUrl} alt="" width={160} height={90} />
                ) : (
                  <span className="video__thumb-empty" aria-hidden="true" />
                )}
                <span className="video__duration">{formatDuration(video.durationSeconds)}</span>
              </div>

              <div className="video__body">
                <h2 className="video__title">
                  <a
                    href={`https://www.youtube.com/watch?v=${encodeURIComponent(video.youtubeVideoId)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {video.title}
                  </a>
                </h2>
                <p className="muted small">
                  {t('published', { date: date.format(new Date(video.publishedAt)) })}
                  {video.privacyStatus !== 'PUBLIC' && (
                    <span className="badge">{t(`privacy.${video.privacyStatus}`)}</span>
                  )}
                  {video.isShortForm && (
                    <span className="badge" title={t('shortFormHint')}>
                      {t('shortForm')}
                    </span>
                  )}
                </p>

                {video.stats ? (
                  <p className="video__stats">
                    {t('views', { count: number.format(BigInt(video.stats.viewCount)) })}
                    {' · '}
                    {video.stats.likeCount === null
                      ? t('likesHidden')
                      : t('likes', { count: number.format(BigInt(video.stats.likeCount)) })}
                    {' · '}
                    {video.stats.commentCount === null
                      ? t('commentsOff')
                      : t('comments', { count: number.format(BigInt(video.stats.commentCount)) })}
                    <br />
                    <span className="muted small">
                      {t('statsAsOf', { date: date.format(new Date(video.stats.capturedAt)) })}
                    </span>
                  </p>
                ) : (
                  <p className="muted small">{t('noStats')}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {nextCursor && (
        <p>
          <Link
            className="button"
            href={localePath(
              locale,
              `/channels/${channelId}/videos?cursor=${encodeURIComponent(nextCursor)}`,
            )}
          >
            {t('loadMore')}
          </Link>
        </p>
      )}
    </main>
  );
}
