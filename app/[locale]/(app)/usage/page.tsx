import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { requireUser } from '@/lib/auth/current-user';
import { localePath } from '@/lib/i18n/paths';
import { getUsageSummary } from '@/modules/onboarding/checklist';

export const dynamic = 'force-dynamic';

const TOOL_BY_FEATURE = {
  IDEAS: 'ideas',
  TITLES: 'titles',
  DESCRIPTION: 'description',
  SCRIPT: 'script',
  PLAN: 'plan',
} as const;

export default async function UsagePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const user = await requireUser(locale);
  const result = await getUsageSummary(user.id);
  if (!result.ok) throw result.error;
  const { ai, channels, projects } = result.data;
  const t = await getTranslations('usage');
  const tools = await getTranslations('studio.tools');
  const number = new Intl.NumberFormat(locale);
  // The allowance resets at midnight UTC on the 1st, whatever the user's zone.
  const resetDate = ai
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(
        new Date(ai.resetsAt),
      )
    : '';

  return (
    <main className="page page--wide">
      <header className="page__header">
        <h1>{t('title')}</h1>
        <p className="muted">{t('subtitle')}</p>
      </header>

      <section className="card">
        <h2>{t('ai.heading')}</h2>
        {ai ? (
          <>
            <p className="muted small">{t('ai.resets', { date: resetDate })}</p>
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('ai.tool')}</th>
                  <th scope="col" className="num">
                    {t('ai.used')}
                  </th>
                  <th scope="col" className="num">
                    {t('ai.left')}
                  </th>
                  <th scope="col">
                    <span className="visually-hidden">{t('ai.bar')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {ai.features.map((feature) => (
                  <tr key={feature.feature}>
                    <td>
                      {tools(TOOL_BY_FEATURE[feature.feature as keyof typeof TOOL_BY_FEATURE])}
                    </td>
                    <td className="num">
                      {t('ai.ofLimit', {
                        used: number.format(feature.used),
                        limit: number.format(feature.limit),
                      })}
                    </td>
                    <td className="num">{number.format(feature.remaining)}</td>
                    <td>
                      <progress
                        className="meter"
                        value={feature.used}
                        max={Math.max(feature.limit, 1)}
                      >
                        {feature.used}/{feature.limit}
                      </progress>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">{t('ai.fairness')}</p>
          </>
        ) : (
          <p className="muted">{t('unavailable')}</p>
        )}
      </section>

      <section className="card">
        <h2>{t('plan.heading')}</h2>
        <dl className="facts">
          <dt>{t('plan.channels')}</dt>
          <dd>
            {t('plan.ofLimit', {
              used: number.format(channels.used),
              limit: number.format(channels.limit),
            })}
          </dd>
          <dt>{t('plan.projects')}</dt>
          <dd>
            {t('plan.ofLimit', {
              used: number.format(projects.used),
              limit: number.format(projects.limit),
            })}
          </dd>
        </dl>
      </section>

      <section className="card">
        <h2>{t('youtube.heading')}</h2>
        <p>{t('youtube.body')}</p>
        <p className="muted small">{t('youtube.delay')}</p>
      </section>

      <p className="small">
        <Link href={localePath(locale, '/settings')}>{t('settingsLink')}</Link>
      </p>
    </main>
  );
}
