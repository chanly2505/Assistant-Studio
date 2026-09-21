import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/lib/i18n/request.ts');

/**
 * Security headers applied to every response.
 *
 * CSP is intentionally strict. `unsafe-inline` for styles is the one concession
 * Next.js currently needs; scripts use a nonce-free strict-dynamic-less policy in
 * development and are tightened in production. Any addition here needs a comment
 * explaining why.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // pino runs its transports in a worker thread that it locates by file path.
  // Bundling it breaks that path ("Cannot find module …/lib/worker.js") and the
  // logger silently stops writing. Load these from node_modules at runtime.
  serverExternalPackages: ['pino', 'pino-pretty', 'thread-stream'],

  // Fail the production build on type or lint errors. Never relax these.
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },

  images: {
    // YouTube thumbnail hosts — the only remote image sources this app uses.
    remotePatterns: [
      { protocol: 'https', hostname: 'i.ytimg.com' },
      { protocol: 'https', hostname: 'yt3.ggpht.com' },
    ],
  },

  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default withNextIntl(nextConfig);
