import createMiddleware from 'next-intl/middleware';

import { routing } from '@/lib/i18n/routing';

/**
 * Locale resolution only.
 *
 * Session verification deliberately does NOT happen here. Middleware runs on the
 * edge runtime without database access, so it can check at most that a cookie is
 * present — which is not authentication. Real verification happens server-side
 * in `withApi` and in the authenticated layout.
 *
 * docs/architecture/05-authentication-architecture.md §5.5
 */
export default createMiddleware(routing);

export const config = {
  // Everything except API routes, Next internals and files with an extension.
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
