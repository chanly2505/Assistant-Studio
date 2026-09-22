import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/lib/i18n/request.ts');

/**
 * Security headers applied to every response. docs/architecture/08 §8.3
 *
 * The HTML Content-Security-Policy is NOT here: it carries a per-request nonce,
 * so middleware.ts builds it (src/lib/security/csp.ts). API routes, which the
 * middleware skips, get a fixed deny-everything policy below.
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
  // Our pages never need to be opened by, or embedded in, another origin.
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
];

/** JSON has nothing to load or frame. Mirrors API_CSP in src/lib/security/csp.ts. */
const apiHeaders = [
  { key: 'Content-Security-Policy', value: "default-src 'none'; frame-ancestors 'none'" },
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

  env: {
    NEXT_PUBLIC_PREVIEW_LOCALES: previewLocales,
    // End-to-end builds only: the fake Google's origin, so the CSP lets the
    // sign-in and connect forms redirect to it. Empty in every other build.
    NEXT_PUBLIC_FAKE_EXTERNAL_ORIGIN: process.env.FAKE_EXTERNAL_APIS_URL
      ? new URL(process.env.FAKE_EXTERNAL_APIS_URL).origin
      : '',
  },

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
    return [
      { source: '/:path*', headers: securityHeaders },
      { source: '/api/:path*', headers: apiHeaders },
    ];
  },
};

export default withNextIntl(nextConfig);
