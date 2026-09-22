import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations, setRequestLocale } from 'next-intl/server';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import Link from 'next/link';

import { Suspense } from 'react';

import { LocaleSwitcher } from '@/components/locale-switcher';
import {
  AVAILABLE_LOCALES,
  LOCALE_LABELS,
  isAvailableLocale,
  isDraftLocale,
} from '@/lib/i18n/routing';

import './globals.css';

export function generateStaticParams() {
  return AVAILABLE_LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'app' });

  return {
    title: t('name'),
    description: t('tagline'),
    robots: { index: false, follow: false },
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isAvailableLocale(locale)) notFound();
  // The CSP nonce is per request (middleware.ts), and Next.js can only stamp it
  // on scripts it renders per request. Reading headers opts every page out of
  // static prerendering; a prerendered page would carry no nonce and its
  // scripts would be blocked in production.
  await headers();

  setRequestLocale(locale);
  const messages = await getMessages();
  const t = await getTranslations({ locale, namespace: 'app' });

  return (
    <html lang={locale}>
      <body>
        {isDraftLocale(locale) && (
          // An unreviewed catalogue must never pass for a finished translation.
          <p className="draft-notice" role="note">
            {t('draftNotice')} <Link href="/en">English</Link>
          </p>
        )}
        <NextIntlClientProvider messages={messages}>
          {children}
          {AVAILABLE_LOCALES.length > 1 && (
            <footer className="site-footer">
              {/* useSearchParams needs a Suspense boundary under static rendering. */}
              <Suspense>
                <LocaleSwitcher
                  current={locale}
                  label={t('language')}
                  options={AVAILABLE_LOCALES.map((code) => ({
                    code,
                    label: LOCALE_LABELS[code],
                    draft: isDraftLocale(code),
                  }))}
                />
              </Suspense>
              {AVAILABLE_LOCALES.some(isDraftLocale) && (
                <p className="small muted">* {t('draftLegend')}</p>
              )}
            </footer>
          )}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
