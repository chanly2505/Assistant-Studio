import { defineRouting } from 'next-intl/routing';

/**
 * Localisation.
 * docs/architecture/02-folder-structure.md, 12 §G
 *
 * English ships first. The other four locales are structurally supported from
 * day one — the routing, catalogues and error-message pipeline all exist — but
 * stay behind `RELEASED_LOCALES` until a native speaker has reviewed them.
 * Machine-translated Khmer in particular is not good enough to ship silently.
 */

export const ALL_LOCALES = ['en', 'km', 'th', 'vi', 'zh'] as const;
export type Locale = (typeof ALL_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** Locales a user can actually reach. Widened as reviews complete. */
export const RELEASED_LOCALES: readonly Locale[] = ['en'];

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  km: 'ភាសាខ្មែរ',
  th: 'ไทย',
  vi: 'Tiếng Việt',
  zh: '中文',
};

export const routing = defineRouting({
  locales: RELEASED_LOCALES as unknown as string[],
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: 'always',
});

export function isReleasedLocale(value: string): value is Locale {
  return (RELEASED_LOCALES as readonly string[]).includes(value);
}
