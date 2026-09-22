import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound, redirect } from 'next/navigation';

import { ErrorFlash } from '@/app/[locale]/_components/error-flash';
import { Field } from '@/components/forms/field';
import { SubmitButton } from '@/components/forms/submit-button';
import { guardAction } from '@/lib/api/action-guard';
import { requireUser } from '@/lib/auth/current-user';
import { localePath } from '@/lib/i18n/paths';
import { UpdateChannelSettingsRequest } from '@/modules/settings/inputs';
import { getChannelSettings, updateChannelSettings } from '@/modules/settings/settings';

export const dynamic = 'force-dynamic';

/**
 * What the creator tells us about a channel. These four fields are exactly
 * what the AI tools read as channel context (modules/ai/context-builder), so
 * each one says what it changes. Nothing is collected that is not used.
 */
export default async function ChannelSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; channelId: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { locale, channelId } = await params;
  const query = await searchParams;
  setRequestLocale(locale);

  const user = await requireUser(locale);
  const result = await getChannelSettings(user.id, channelId);
  if (!result.ok) notFound();
  const { channel, settings } = result.data;
  const t = await getTranslations('channelSettings');
  const tc = await getTranslations('content');
  const self = localePath(locale, `/channels/${channelId}/settings`);

  async function save(formData: FormData) {
    'use server';
    const me = await requireUser(locale);
    if (!(await guardAction(`user:${me.id}`))) redirect(`${self}?error=errors.tooManyActions`);
    // No helper function in here: Next 15.1's server-action compiler loses the
    // page's variables (locale, channelId) when an action defines a nested
    // function, and the action then fails with "locale is not defined".
    const parsed = UpdateChannelSettingsRequest.safeParse({
      niche: String(formData.get('niche') ?? ''),
      targetAudience: String(formData.get('targetAudience') ?? ''),
      brandVoice: String(formData.get('brandVoice') ?? ''),
      keywords: String(formData.get('keywords') ?? ''),
    });
    if (!parsed.success) redirect(`${self}?error=errors.validationFailed`);
    const saved = await updateChannelSettings(me.id, channelId, parsed.data);
    redirect(saved.ok ? `${self}?saved=1` : `${self}?error=${saved.error.messageKey}`);
  }

  return (
    <main className="page page--wide">
      <p className="small">
        <Link href={localePath(locale, '/settings')}>← {t('back')}</Link>
      </p>
      <header className="page__header">
        <h1>{t('title', { channel: channel.title })}</h1>
        <p className="muted">{t('intro')}</p>
      </header>

      <ErrorFlash error={query.error} />
      {query.saved && (
        <p className="flash flash--ok" role="status">
          {tc('saved')}
        </p>
      )}

      <section className="card">
        <form action={save} className="form">
          <Field label={t('niche')} hint={t('nicheHint')}>
            <input name="niche" maxLength={120} defaultValue={settings.niche} />
          </Field>
          <Field label={t('audience')} hint={t('audienceHint')}>
            <textarea
              name="targetAudience"
              rows={3}
              maxLength={1000}
              defaultValue={settings.targetAudience}
            />
          </Field>
          <Field label={t('voice')} hint={t('voiceHint')}>
            <textarea
              name="brandVoice"
              rows={3}
              maxLength={1000}
              defaultValue={settings.brandVoice}
            />
          </Field>
          <Field label={t('keywords')} hint={t('keywordsHint')}>
            <input name="keywords" maxLength={700} defaultValue={settings.keywords.join(', ')} />
          </Field>
          <p className="muted small">{t('privacy')}</p>
          <div className="form__actions">
            <SubmitButton label={t('save')} pendingLabel={t('saving')} />
          </div>
        </form>
      </section>
    </main>
  );
}
