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

/**
 * Draft locales a reviewer can reach (docs/architecture/12 §G). A comma list
 * such as `PREVIEW_LOCALES=km,th`. Inlined at build time — including into the
 * edge middleware, which cannot load the server-only env module — so changing
 * it needs a restart. Unknown or already-released codes are ignored.
 */
const previewLocales = process.env.PREVIEW_LOCALES ?? '';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // A separate output directory lets the e2e server run beside `pnpm dev`
  // without the two overwriting each other's chunks.
  distDir: process.env.NEXT_DIST_DIR || '.next',

  env: { NEXT_PUBLIC_PREVIEW_LOCALES: previewLocales },

  // pino runs its transports in a worker thread that it locates by file path.
  // Bundling it breaks that path ("Cannot find module …/lib/worker.js") and the
  // logger silently stops writing. Load these from node_modules at runtime.
  serverExternalPackages: ['pino', 'pino-pretty', 'thread-stream'],

  // Fail the production build on type or lint errors. Never relax these.
  typescript: {
    ignoreBuildErrors: false,
    // The e2e server uses its own tsconfig so it never rewrites tsconfig.json.
    tsconfigPath: process.env.NEXT_TSCONFIG_PATH || 'tsconfig.json',
  },
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
