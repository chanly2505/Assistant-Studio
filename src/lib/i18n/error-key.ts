/**
 * Pages report a failed form action by redirecting with `?error=<messageKey>`
 * (an AppError's i18n key, never prose). The query string is user-controlled,
 * so only a well-formed `errors.*` key is accepted; the page still checks the
 * key exists before rendering it.
 */
export function errorMessageKey(value: string | undefined): string | null {
  if (!value || value.length > 80) return null;
  return /^errors(\.[a-zA-Z]+){1,3}$/.test(value) ? value : null;
}
