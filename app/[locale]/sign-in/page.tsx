import { getTranslations, setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { isGoogleSignInConfigured, signIn } from '@/lib/auth/auth';
import { getCurrentUser } from '@/lib/auth/current-user';
import { dynamicKeys } from '@/lib/i18n/dynamic-key';
import { localePath } from '@/lib/i18n/paths';

export const dynamic = 'force-dynamic';

const KNOWN_ERRORS = ['AccessDenied', 'Configuration', 'OAuthAccountNotLinked', 'Verification'];

export default async function SignInPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { locale } = await params;
  const { error } = await searchParams;
  setRequestLocale(locale);

  if (await getCurrentUser()) redirect(localePath(locale, '/dashboard'));

  const t = await getTranslations('signIn');
  // Auth.js reports errors as ?error=<Name>. Unknown names fall back to a generic
  // message rather than echoing the query string into the page.
  const errorKey = error ? (KNOWN_ERRORS.includes(error) ? error : 'Default') : null;

  async function signInWithGoogle() {
    'use server';
    await signIn('google', { redirectTo: localePath(locale, '/dashboard') });
  }

  return (
    <main className="page page--narrow">
      <header className="page__header">
        <h1>{t('title')}</h1>
        <p className="muted">{t('subtitle')}</p>
      </header>

      {errorKey && (
        <p className="flash flash--bad" role="alert">
          {dynamicKeys(t)(`error.${errorKey}`)}
        </p>
      )}

      <section className="card">
        {isGoogleSignInConfigured ? (
          <form action={signInWithGoogle}>
            <button type="submit" className="button button--primary">
              {t('withGoogle')}
            </button>
          </form>
        ) : (
          <p className="muted">{t('notConfigured')}</p>
        )}
      </section>
    </main>
  );
}
