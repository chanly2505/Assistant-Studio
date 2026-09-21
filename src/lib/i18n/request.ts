import { getRequestConfig } from 'next-intl/server';

import { DEFAULT_LOCALE, isReleasedLocale } from './routing';

/**
 * Loads the message catalogue for the request's locale, falling back to English
 * for anything not yet released.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = requested && isReleasedLocale(requested) ? requested : DEFAULT_LOCALE;

  return {
    locale,
    messages: (await import(`../../../messages/${locale}.json`)).default,
  };
});
