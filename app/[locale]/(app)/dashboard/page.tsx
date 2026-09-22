import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { requireUser } from '@/lib/auth/current-user';
import { localePath } from '@/lib/i18n/paths';
import { getGettingStarted, type Step } from '@/modules/onboarding/checklist';

export const dynamic = 'force-dynamic';

/**
 * Home: where a first-time creator learns what to do next, in plain words.
 * Every step is worked out from what they have actually done.
 */
export default async function DashboardPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const user = await requireUser(locale);
  const result = await getGettingStarted(user.id);
  if (!result.ok) throw result.error;
  const { steps, next, completed, total, firstChannelId } = result.data;
  const t = await getTranslations('dashboard');

  const linkFor: Record<Step, string> = {
    connectChannel: '/channels',
    describeChannel: firstChannelId ? `/channels/${firstChannelId}/settings` : '/channels',
    firstIdeas: '/studio?tool=ideas',
    startProject: '/ideas',
    scheduleVideo: '/projects',
  };

  return (
    <main className="page page--wide">
      <header className="page__header">
        <h1>{t('title')}</h1>
        <p className="muted">{t('subtitle')}</p>
      </header>

      <section className="card" aria-labelledby="getting-started">
        <h2 id="getting-started">{t('checklist.heading')}</h2>
        <p>{next ? t('checklist.progress', { completed, total }) : t('checklist.allDone')}</p>
        <progress className="meter" value={completed} max={total}>
          {completed}/{total}
        </progress>
        <ol className="checklist">
          {steps.map(({ step, done }) => (
            <li
              key={step}
              className={done ? 'checklist__item checklist__item--done' : 'checklist__item'}
            >
              <span className="checklist__mark" aria-hidden="true">
                {done ? '✓' : '○'}
              </span>
              <div>
                <p className="checklist__title">
                  {done ? (
                    t(`steps.${step}.title`)
                  ) : (
                    <Link href={localePath(locale, linkFor[step])}>{t(`steps.${step}.title`)}</Link>
                  )}
                  <span className="visually-hidden">
                    {' '}
                    ({done ? t('checklist.done') : t('checklist.todo')})
                  </span>
                </p>
                <p className="muted small">{t(`steps.${step}.why`)}</p>
                {step === next && (
                  <Link className="button button--primary" href={localePath(locale, linkFor[step])}>
                    {t(`steps.${step}.action`)}
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="card">
        <h2>{t('shortcuts.heading')}</h2>
        <ul className="shortcuts">
          <li>
            <Link href={localePath(locale, '/studio')}>{t('shortcuts.studio')}</Link>
          </li>
          <li>
            <Link href={localePath(locale, '/projects')}>{t('shortcuts.projects')}</Link>
          </li>
          <li>
            <Link href={localePath(locale, '/calendar')}>{t('shortcuts.calendar')}</Link>
          </li>
          <li>
            <Link href={localePath(locale, '/usage')}>{t('shortcuts.usage')}</Link>
          </li>
        </ul>
      </section>
    </main>
  );
}
