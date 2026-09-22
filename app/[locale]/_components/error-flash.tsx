import { getTranslations } from 'next-intl/server';

import { dynamicKeys } from '@/lib/i18n/dynamic-key';
import { errorMessageKey } from '@/lib/i18n/error-key';

/**
 * The translated message for a failed form action, which pages receive as
 * `?error=<messageKey>`. Unknown or malformed keys fall back to a generic
 * message rather than rendering a raw key.
 */
export async function ErrorFlash({ error }: { error: string | undefined }) {
  if (!error) return null;
  const t = dynamicKeys(await getTranslations());
  const key = errorMessageKey(error);
  return (
    <p className="flash flash--bad" role="alert">
      {key && t.has(key) ? t(key) : t('errors.validationFailed')}
    </p>
  );
}
