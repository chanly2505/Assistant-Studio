import createMiddleware from 'next-intl/middleware';
import { NextRequest, type NextResponse } from 'next/server';

import { routing } from '@/lib/i18n/routing';
import { buildCsp, newNonce } from '@/lib/security/csp';

/**
 * Locale resolution and the per-request CSP nonce.
 *
 * Session verification deliberately does NOT happen here. Middleware runs on the
 * edge runtime without database access, so it can check at most that a cookie is
 * present — which is not authentication. Real verification happens server-side
 * in `withApi` and in the authenticated layout.
 *
 * docs/architecture/05-authentication-architecture.md §5.5, 08 §8.3
 */
const intl = createMiddleware(routing);

// Read here rather than via src/lib/env: middleware runs on the edge and
// cannot load that server-only module. NODE_ENV is inlined by Next at build.
const DEV = process.env.NODE_ENV === 'development';
// Set only in end-to-end builds (see next.config.ts); empty otherwise.
const FAKE_ORIGIN = process.env.NEXT_PUBLIC_FAKE_EXTERNAL_ORIGIN ?? '';

export default function middleware(request: NextRequest): NextResponse {
  const nonce = newNonce();
  const csp = buildCsp({
    nonce,
    dev: DEV,
    https: request.nextUrl.protocol === 'https:',
    extraFormAction: FAKE_ORIGIN ? [FAKE_ORIGIN] : [],
  });

  // Next.js reads the nonce from the REQUEST's CSP header and adds it to the
  // scripts it renders; the response header is what the browser enforces.
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);

  const response = intl(new NextRequest(request, { headers }));
  response.headers.set('content-security-policy', csp);
  return response;
}

export const config = {
  // Everything except API routes, Next internals and files with an extension.
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
