import { DEFAULT_LOCALE, isAvailableLocale } from './routing';

/** A locale-prefixed path, falling back to the default for locales this deployment does not serve. */
export function localePath(locale: string | null | undefined, path: string): string {
  const safe = locale && isAvailableLocale(locale) ? locale : DEFAULT_LOCALE;
  return `/${safe}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * The flash code a page shows after a redirect. Most errors map one-to-one;
 * CONFLICT has two causes a user must act on differently, so it is split by
 * the error's message key.
 */
export function flashCodeFor(error: { code: string; messageKey: string }): string {
  if (error.code === 'CONFLICT') {
    if (error.messageKey === 'errors.channels.limitReached') return 'CHANNEL_LIMIT';
    if (error.messageKey === 'errors.channels.ownedByAnotherUser') return 'CHANNEL_OWNED';
  }
  return error.code;
}

/** Where browser-facing routes send the user after an error. */
export function errorRedirectPath(
  locale: string | null | undefined,
  error: { code: string; messageKey: string },
  signedIn: boolean,
): string {
  if (!signedIn || error.code === 'UNAUTHENTICATED') return localePath(locale, '/sign-in');
  return localePath(locale, `/channels?error=${encodeURIComponent(flashCodeFor(error))}`);
}
