import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { ReactNode } from 'react';

import { signOut } from '@/lib/auth/auth';
import { requireUser } from '@/lib/auth/current-user';
import { localePath } from '@/lib/i18n/paths';

export const dynamic = 'force-dynamic';

/**
 * The authenticated shell. The session is verified HERE, on the server with
 * database access — not in middleware (docs/architecture/05 §5.5).
 */
export default async function AppLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const user = await requireUser(locale);
  const t = await getTranslations('nav');

  async function signOutAction() {
    'use server';
    await signOut({ redirectTo: localePath(locale, '/sign-in') });
  }

  return (
    <>
      <header className="topbar">
        <nav className="topbar__nav" aria-label="Main">
          <Link href={localePath(locale, '/channels')}>{t('channels')}</Link>
          <Link href={localePath(locale, '/studio')}>{t('studio')}</Link>
          <Link href={localePath(locale, '/ideas')}>{t('ideas')}</Link>
          <Link href={localePath(locale, '/projects')}>{t('projects')}</Link>
          <Link href={localePath(locale, '/calendar')}>{t('calendar')}</Link>
        </nav>
        <div className="topbar__user">
          <span className="muted">{t('signedInAs', { email: user.email })}</span>
          <form action={signOutAction}>
            <button type="submit" className="button button--quiet">
              {t('signOut')}
            </button>
          </form>
        </div>
      </header>
      {children}
    </>
  );
}
