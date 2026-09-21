import { config } from '@/lib/env';

/**
 * The session cookie name, shared by Auth.js (which sets it) and
 * DatabaseSessionProvider (which reads it). One constant, so they cannot drift.
 *
 * `__Host-` in production: the browser then refuses the cookie unless it is
 * Secure, has Path=/ and has NO Domain attribute — so a sibling subdomain can
 * neither set nor overwrite it.
 */
export const SESSION_COOKIE_NAME = config.isProduction ? '__Host-ysa.session' : 'ysa.session';

export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** Minimal RFC 6265 cookie-header reader. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;

    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value) || null;
    } catch {
      return null;
    }
  }
  return null;
}
