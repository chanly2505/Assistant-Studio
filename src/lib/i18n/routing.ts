import { defineRouting } from 'next-intl/routing';

import { PREVIEW_LOCALES_RAW, parsePreviewLocales } from './preview-locales';

/**
 * Localisation.
 * docs/architecture/02-folder-structure.md, 12 §G
 *
 * English ships first. The other four locales have draft catalogues that stay
 * unreachable (behind the PREVIEW_LOCALES flag) until a native speaker has
 * reviewed them. Machine-assisted Khmer in particular is not good enough to
 * ship silently — and every page in a draft locale says so.
 */

export const ALL_LOCALES = ['en', 'km', 'th', 'vi', 'zh'] as const;
export type Locale = (typeof ALL_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** Reviewed locales, open to every user. Widened as reviews complete. */
export const RELEASED_LOCALES: readonly Locale[] = ['en'];

/** Draft locales this deployment exposes for review (usually none). */
export const PREVIEW_LOCALES = parsePreviewLocales(
  PREVIEW_LOCALES_RAW,
  ALL_LOCALES,
  RELEASED_LOCALES,
) as Locale[];

/** Everything a request may use: released plus any previewed drafts. */
export const AVAILABLE_LOCALES: readonly Locale[] = [...RELEASED_LOCALES, ...PREVIEW_LOCALES];

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  km: 'ភាសាខ្មែរ',
  th: 'ไทย',
  vi: 'Tiếng Việt',
  zh: '中文',
};

export const routing = defineRouting({
  locales: AVAILABLE_LOCALES as unknown as string[],
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: 'always',
});

/** A locale this deployment serves (released, or previewed for review). */
export function isAvailableLocale(value: string): value is Locale {
  return (AVAILABLE_LOCALES as readonly string[]).includes(value);
}

/** Reviewed and open to everyone. */
export function isReleasedLocale(value: string): value is Locale {
  return (RELEASED_LOCALES as readonly string[]).includes(value);
}

/** Served, but an unreviewed draft: pages show a notice. */
export function isDraftLocale(value: string): boolean {
  return isAvailableLocale(value) && !isReleasedLocale(value);
}
