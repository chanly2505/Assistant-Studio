import Image from 'next/image';
import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { toAppError } from '@/domain/errors/app-error';
import { requireUser } from '@/lib/auth/current-user';
import { dynamicKeys } from '@/lib/i18n/dynamic-key';
import { flashCodeFor, localePath } from '@/lib/i18n/paths';
import { disconnectChannel } from '@/modules/channels/disconnect-channel';
import { listChannels } from '@/modules/channels/list-channels';
import { requestManualSync } from '@/modules/sync/schedule';
import { userTimeZone } from '@/modules/content/shared';

export const dynamic = 'force-dynamic';

const DISCONNECT_FLASH = {
  revoked: 'disconnected',
  already_invalid: 'disconnectedAlreadyInvalid',
  not_needed: 'disconnected',
  failed: 'disconnectRevokeFailed',
} as const;

type SearchParams = { connected?: string; disconnected?: string; synced?: string; error?: string };

export default async function ChannelsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  setRequestLocale(locale);

  const user = await requireUser(locale);
  const zone = await userTimeZone(user.id);
  const t = await getTranslations('channels');
  const result = await listChannels({ userId: user.id });
  const channels = result.ok ? result.data.channels : [];

  const number = new Intl.NumberFormat(locale);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: zone });

  async function disconnect(formData: FormData) {
    'use server';
    const current = await requireUser(locale);
    const channelId = String(formData.get('channelId') ?? '');
    const outcome = await disconnectChannel({ userId: current.id, channelId });

    const flash = outcome.ok ? DISCONNECT_FLASH[outcome.data.revocation] : 'generic';
    redirect(localePath(locale, `/channels?disconnected=${flash}`));
  }

  async function refresh(formData: FormData) {
    'use server';
    const current = await requireUser(locale);
    const channelId = String(formData.get('channelId') ?? '');
    let target: string;
    try {
      await requestManualSync({ userId: current.id, channelId });
      target = '/channels?synced=1';
    } catch (error) {
      // Rate limit, expired grant, missing config: each has its own message.
      target = `/channels?error=${encodeURIComponent(flashCodeFor(toAppError(error)))}`;
    }
    // redirect() throws by design, so it must sit outside the try.
    redirect(localePath(locale, target));
  }

  const td = dynamicKeys(t);
  const flash = flashMessage(query, (key) => (td.has(key) ? td(key) : null));

  return (
    <main className="page">
      <header className="page__header">
        <h1>{t('title')}</h1>
        <p className="muted">{t('subtitle')}</p>
      </header>

      {flash && (
        <p
          className={`flash flash--${flash.tone}`}
          role={flash.tone === 'bad' ? 'alert' : 'status'}
        >
          {flash.text}
        </p>
      )}

      {channels.length === 0 ? (
        <section className="card">
          <p className="muted">{t('empty')}</p>
        </section>
      ) : (
        <ul className="channel-list">
          {channels.map((channel) => (
            <li key={channel.id} className="card channel">
              {channel.thumbnailUrl && (
                <Image
                  src={channel.thumbnailUrl}
                  alt=""
                  width={48}
                  height={48}
                  className="channel__avatar"
                />
              )}
              <div className="channel__body">
                <h2 className="channel__title">{channel.title}</h2>
                {channel.handle && <p className="muted">{channel.handle}</p>}

                {channel.stats && (
                  <p className="channel__stats">
                    {channel.stats.subscriberCount === null
                      ? t('subscribersHidden')
                      : t('subscribers', {
                          count: number.format(BigInt(channel.stats.subscriberCount)),
                        })}
                    {' · '}
                    {t('videos', { count: number.format(channel.stats.videoCount) })}
                    {' · '}
                    {t('views', { count: number.format(BigInt(channel.stats.viewCount)) })}
                    <br />
                    <span className="muted small">
                      {t('statsAsOf', { date: date.format(new Date(channel.stats.capturedAt)) })}
                      {channel.stats.subscriberCount !== null && ` · ${t('roundedNote')}`}
                    </span>
                  </p>
                )}

                <p className="muted small">
                  {td(`syncStatus.${channel.syncStatus}`)}
                  {channel.lastSyncedAt &&
                    ` · ${t('lastSynced', { date: date.format(new Date(channel.lastSyncedAt)) })}`}
                </p>

                {channel.needsReauth && <p className="flash flash--bad">{t('needsReauth')}</p>}
              </div>

              <div className="channel__actions">
                <Link
                  className="button"
                  href={localePath(locale, `/channels/${channel.id}/videos`)}
                >
                  {t('viewVideos')}
                </Link>
                <Link
                  className="button"
                  href={localePath(locale, `/channels/${channel.id}/analytics`)}
                >
                  {t('viewAnalytics')}
                </Link>
                {channel.needsReauth ? (
                  <ConnectForm label={t('reconnect')} />
                ) : (
                  <form action={refresh}>
                    <input type="hidden" name="channelId" value={channel.id} />
                    <button type="submit" className="button">
                      {t('refresh')}
                    </button>
                  </form>
                )}
                <form action={disconnect}>
                  <input type="hidden" name="channelId" value={channel.id} />
                  <button type="submit" className="button button--quiet">
                    {t('disconnect')}
                  </button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}

      <section className="card">
        <ConnectForm label={channels.length === 0 ? t('connect') : t('connectAnother')} primary />
        <p className="muted small">{t('privacyNote')}</p>
      </section>
    </main>
  );
}

/**
 * A plain HTML form POST: works without JavaScript, and the route answers with a
 * 303 to Google's consent screen.
 */
function ConnectForm({ label, primary = false }: { label: string; primary?: boolean }) {
  return (
    <form method="post" action="/api/youtube/oauth/start">
      <button type="submit" className={primary ? 'button button--primary' : 'button'}>
        {label}
      </button>
    </form>
  );
}

function flashMessage(
  query: SearchParams,
  translate: (key: string) => string | null,
): { text: string; tone: 'ok' | 'bad' } | null {
  if (query.connected) {
    return { text: translate('flash.connected') ?? '', tone: 'ok' };
  }
  if (query.synced) {
    return { text: translate('flash.syncQueued') ?? '', tone: 'ok' };
  }
  if (query.disconnected) {
    const text = translate(`flash.${query.disconnected}`) ?? translate('flash.generic');
    const tone = query.disconnected === 'disconnectRevokeFailed' ? 'bad' : 'ok';
    return text ? { text, tone } : null;
  }
  if (query.error) {
    // Only codes with a catalogue entry are shown; anything else in the query
    // string gets the generic message, so the URL cannot inject page text.
    const text = translate(`flash.${query.error}`) ?? translate('flash.generic');
    return text ? { text, tone: 'bad' } : null;
  }
  return null;
}
