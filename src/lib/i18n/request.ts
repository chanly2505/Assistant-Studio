import { getRequestConfig } from 'next-intl/server';

import { DEFAULT_LOCALE, isAvailableLocale } from './routing';

/**
 * Loads the message catalogue for the request's locale, falling back to English
 * for any locale this deployment does not serve.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = requested && isAvailableLocale(requested) ? requested : DEFAULT_LOCALE;

  return {
    locale,
    messages: (await import(`../../../messages/${locale}.json`)).default,
  };
});
