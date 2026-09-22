import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { ErrorFlash } from '@/app/[locale]/_components/error-flash';
import { Field } from '@/components/forms/field';
import { SubmitButton } from '@/components/forms/submit-button';
import { TimeZonePrompt } from '@/components/forms/time-zone-prompt';
import { SUPPORTED_LOCALES } from '@/domain/ai/types';
import { guardAction } from '@/lib/api/action-guard';
import { requireUser } from '@/lib/auth/current-user';
import { localePath } from '@/lib/i18n/paths';
import { AVAILABLE_LOCALES, LOCALE_LABELS, isDraftLocale } from '@/lib/i18n/routing';
import { listChannels } from '@/modules/channels/list-channels';
import { deleteAccount } from '@/modules/account/account';
import { UpdateUserSettingsRequest } from '@/modules/settings/inputs';
import { getUserSettings, updateUserSettings } from '@/modules/settings/settings';

export const dynamic = 'force-dynamic';

/** Every zone the runtime knows, for the time-zone picker. */
const TIME_ZONES = Intl.supportedValuesOf('timeZone');

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  setRequestLocale(locale);

  const user = await requireUser(locale);
  const [settings, channels] = await Promise.all([
    getUserSettings(user.id),
    listChannels({ userId: user.id }),
  ]);
  if (!settings.ok) throw settings.error;
  const current = settings.data;
  const channelList = channels.ok ? channels.data.channels : [];
  const t = await getTranslations('settings');
  const tc = await getTranslations('content');
  const zones = TIME_ZONES.includes(current.timezone)
    ? TIME_ZONES
    : [current.timezone, ...TIME_ZONES];

  async function save(formData: FormData) {
    'use server';
    const me = await requireUser(locale);
    if (!(await guardAction(`user:${me.id}`)))
      redirect(localePath(locale, '/settings?error=errors.tooManyActions'));
    const parsed = UpdateUserSettingsRequest.safeParse({
      locale: formData.get('locale') ?? undefined,
      timezone: formData.get('timezone') ?? undefined,
      contentLanguage: formData.get('contentLanguage') ?? undefined,
      defaultChannelId: formData.get('defaultChannelId') ? formData.get('defaultChannelId') : null,
    });
    if (!parsed.success) redirect(localePath(locale, '/settings?error=errors.validationFailed'));
    const saved = await updateUserSettings(me.id, parsed.data);
    if (!saved.ok) redirect(localePath(locale, `/settings?error=${saved.error.messageKey}`));
    // A new display language takes effect by moving to that language's URL.
    redirect(localePath(saved.data.locale, '/settings?saved=1'));
  }

  async function useZone(formData: FormData) {
    'use server';
    const me = await requireUser(locale);
    if (!(await guardAction(`user:${me.id}`)))
      redirect(localePath(locale, '/settings?error=errors.tooManyActions'));
    const saved = await updateUserSettings(me.id, {
      timezone: String(formData.get('timezone') ?? ''),
    });
    redirect(
      localePath(
        locale,
        saved.ok ? '/settings?saved=1' : `/settings?error=${saved.error.messageKey}`,
      ),
    );
  }

  async function removeAccount(formData: FormData) {
    'use server';
    const me = await requireUser(locale);
    if (!(await guardAction(`user:${me.id}`))) {
      redirect(localePath(locale, '/settings?error=errors.tooManyActions#data'));
    }
    const deleted = await deleteAccount(me.id, String(formData.get('confirmEmail') ?? ''));
    if (!deleted.ok)
      redirect(localePath(locale, `/settings?error=${deleted.error.messageKey}#data`));
    // The session went with the account; the sign-in page confirms it.
    redirect(localePath(locale, '/sign-in?deleted=1'));
  }

  return (
    <main className="page page--wide">
      <header className="page__header">
        <h1>{t('title')}</h1>
        <p className="muted">{t('subtitle', { email: current.email })}</p>
      </header>

      <ErrorFlash error={query.error} />
      {query.saved && (
        <p className="flash flash--ok" role="status">
          {tc('saved')}
        </p>
      )}

      <section className="card">
        <h2>{t('you.heading')}</h2>
        <TimeZonePrompt
          current={current.timezone}
          action={useZone}
          shownInLabel={tc('timeZone.shownIn', { zone: current.timezone })}
          useLabel={tc('timeZone.use', { zone: '{zone}' })}
        />
        <form action={save} className="form">
          <div className="form__row">
            <Field label={t('you.language')} hint={t('you.languageHint')}>
              <select name="locale" defaultValue={locale}>
                {AVAILABLE_LOCALES.map((code) => (
                  <option key={code} value={code} lang={code}>
                    {LOCALE_LABELS[code]}
                    {isDraftLocale(code) ? ' *' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('you.timezone')} hint={t('you.timezoneHint')}>
              <select name="timezone" defaultValue={current.timezone}>
                {zones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone.replaceAll('_', ' ')}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <h3>{t('content.heading')}</h3>
          <div className="form__row">
            <Field label={t('content.language')} hint={t('content.languageHint')}>
              <select name="contentLanguage" defaultValue={current.contentLanguage}>
                {SUPPORTED_LOCALES.map((code) => (
                  <option key={code} value={code} lang={code}>
                    {LOCALE_LABELS[code]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('content.channel')} hint={t('content.channelHint')}>
              <select name="defaultChannelId" defaultValue={current.defaultChannelId ?? ''}>
                <option value="">{t('content.noChannel')}</option>
                {channelList.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.title}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="form__actions">
            <SubmitButton label={t('save')} pendingLabel={t('saving')} />
          </div>
        </form>
      </section>

      <section className="card">
        <h2>{t('channels.heading')}</h2>
        <p className="muted">{t('channels.intro')}</p>
        {channelList.length === 0 ? (
          <p>
            <Link href={localePath(locale, '/channels')}>{t('channels.connect')}</Link>
          </p>
        ) : (
          <ul className="history">
            {channelList.map((channel) => (
              <li key={channel.id}>
                <Link href={localePath(locale, `/channels/${channel.id}/settings`)}>
                  {t('channels.edit', { channel: channel.title })}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="small">
        <Link href={localePath(locale, '/usage')}>{t('usageLink')}</Link>
      </p>

      <section className="card" id="data" aria-labelledby="data-heading">
        <h2 id="data-heading">{t('data.heading')}</h2>
        <p>{t('data.exportIntro')}</p>
        <p>
          {/* A plain link: the browser downloads the file the route returns. */}
          <a className="button" href="/api/v1/account/export" download>
            {t('data.export')}
          </a>
        </p>
      </section>

      <section className="card card--danger" aria-labelledby="delete-heading">
        <h2 id="delete-heading">{t('data.deleteHeading')}</h2>
        <p>{t('data.deleteIntro')}</p>
        <form action={removeAccount} className="form">
          <Field label={t('data.confirmLabel', { email: current.email })}>
            <input
              name="confirmEmail"
              type="email"
              required
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <div className="form__actions">
            <SubmitButton
              label={t('data.delete')}
              pendingLabel={t('data.deleting')}
              className="button button--danger"
            />
          </div>
        </form>
      </section>
    </main>
  );
}
