/**
 * Content-Security-Policy for HTML pages. docs/architecture/08 §8.3
 *
 * Built per request with a fresh nonce: only scripts carrying it (Next.js
 * marks its own) may run, and 'strict-dynamic' lets those load their chunks.
 * No 'unsafe-inline' for scripts, ever. In production there is no
 * 'unsafe-eval' and no inline <style>.
 *
 * Development relaxes exactly two things Next's dev server needs: eval for
 * fast refresh and a websocket for hot reload. Neither is present in
 * production. (Styles need no relaxation: Next serves CSS as files in dev too.)
 *
 * form-action includes Google because the sign-in and "connect channel"
 * forms post to our routes, which then redirect to accounts.google.com — and
 * Chrome applies form-action to that redirect.
 */

export interface CspOptions {
  nonce: string;
  dev: boolean;
  /** Add upgrade-insecure-requests (only meaningful behind HTTPS). */
  https: boolean;
  /** End-to-end tests only: the local fake Google that forms redirect to. */
  extraFormAction?: string[];
}

export const YOUTUBE_IMAGE_HOSTS = ['https://i.ytimg.com', 'https://yt3.ggpht.com'] as const;
export const GOOGLE_ACCOUNTS = 'https://accounts.google.com';

export function buildCsp({ nonce, dev, https, extraFormAction = [] }: CspOptions): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(dev ? ["'unsafe-eval'"] : []),
    ],
    'style-src': ["'self'", `'nonce-${nonce}'`],
    'img-src': ["'self'", 'data:', ...YOUTUBE_IMAGE_HOSTS],
    'font-src': ["'self'"],
    'connect-src': ["'self'", ...(dev ? ['ws:', 'wss:'] : [])],
    'frame-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'", GOOGLE_ACCOUNTS, ...extraFormAction],
    'manifest-src': ["'self'"],
    'worker-src': ["'self'"],
  };
  const policy = Object.entries(directives).map(([name, values]) => `${name} ${values.join(' ')}`);
  if (https && !dev) policy.push('upgrade-insecure-requests');
  return policy.join('; ');
}

/** For JSON API responses: nothing to load, nothing to frame. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/** 128 random bits, base64. Web Crypto, so it runs in the edge middleware. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
