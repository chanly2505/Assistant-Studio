import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { getCurrentUser } from '@/lib/auth/current-user';
import { localePath } from '@/lib/i18n/paths';
import { checkHealth } from '@/modules/health/check-health';

export const dynamic = 'force-dynamic';

/**
 * Landing page: the live readiness check plus the way in. There is no mocked
 * dashboard — a screen of invented numbers would hide what is not built yet.
 */
export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations();
  const [health, user] = await Promise.all([checkHealth(), getCurrentUser()]);
  const healthy = health.ok;

  return (
    <main className="page">
      <header className="page__header">
        <h1>{t('app.name')}</h1>
        <p className="muted">{t('app.tagline')}</p>
      </header>

      <section className="card">
        <Link
          className="button button--primary"
          href={localePath(locale, user ? '/channels' : '/sign-in')}
        >
          {user ? t('home.openChannels') : t('home.getStarted')}
        </Link>
      </section>

      <section className="card" aria-labelledby="status-heading">
        <h2 id="status-heading">{t('home.status')}</h2>

        <p className={healthy ? 'status status--ok' : 'status status--bad'}>
          {healthy ? t('home.healthy') : t('home.degraded')}
        </p>

        <dl className="facts">
          <dt>{t('home.checkDatabase')}</dt>
          <dd>
            {healthy
              ? `ok · ${health.data.checks.database.latencyMs}ms`
              : t('errors.serviceUnavailable')}
          </dd>
        </dl>
      </section>
    </main>
  );
}
