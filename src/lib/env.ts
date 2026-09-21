import 'server-only';

import { z } from 'zod';

/**
 * The ONLY module in the codebase permitted to read `process.env`.
 * An ESLint rule (`no-restricted-properties`) fails the build everywhere else,
 * and the `server-only` import above makes a client-side import chain a build
 * error rather than a runtime leak.
 *
 * docs/architecture/08-security-architecture.md §8.1
 */

const base = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  DATABASE_URL: z.string().url().startsWith('postgres'),
  DIRECT_DATABASE_URL: z.string().url().startsWith('postgres').optional(),

  AUTH_SECRET: z.string().min(32).optional(),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  YOUTUBE_OAUTH_REDIRECT_URI: z.string().url().optional(),
  YOUTUBE_DATA_DAILY_QUOTA: z.coerce.number().int().positive().default(10_000),

  /** 32 raw bytes, base64-encoded. Validated by length after decoding. */
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, {
      message:
        'TOKEN_ENCRYPTION_KEY must be exactly 32 bytes, base64-encoded (openssl rand -base64 32)',
    })
    .optional(),
  /** Written into every ciphertext so a rotated key can still decrypt old rows. */
  TOKEN_ENCRYPTION_KEY_VERSION: z.coerce.number().int().min(1).max(255).default(1),
  /**
   * The key being rotated OUT, as `<version>:<base64>`. Rows encrypted under it
   * stay readable and are re-encrypted with the current key on next write.
   */
  TOKEN_ENCRYPTION_KEY_PREVIOUS: z
    .string()
    .regex(/^\d{1,3}:[A-Za-z0-9+/=]+$/, 'expected "<version>:<base64 key>"')
    .optional(),

  AI_PROVIDER: z.enum(['openai', 'mock']).default('mock'),
  OPENAI_API_KEY: z.string().min(1).optional(),
  AI_DAILY_SPEND_LIMIT_MICROS: z.coerce.number().int().positive().default(50_000_000),

  REDIS_URL: z.string().url().optional(),
  /** Prefix for every Redis key and queue, so environments sharing a server never collide. */
  REDIS_KEY_PREFIX: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .default('ysa'),
  /** Jobs the background worker runs at once. Each holds one YouTube request at a time. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  SENTRY_DSN: z.string().url().optional(),

  /** Set by Next.js itself: `phase-production-build` while `next build` runs. */
  NEXT_PHASE: z.string().optional(),
});

export const BUILD_PHASE = 'phase-production-build';

/**
 * Production tightening. Everything optional above becomes mandatory once
 * NODE_ENV=production, so a half-configured deployment fails at server start
 * (see instrumentation.ts at the project root) instead of failing for a user mid-flow.
 *
 * Skipped during `next build`. The build evaluates route modules to collect page
 * data, so enforcing runtime secrets there would force production credentials
 * into CI and make build-once-deploy-many impossible — the same artifact could
 * not be promoted from staging to production. Shape is still validated.
 */
const schema = base.superRefine((env, ctx) => {
  if (env.NEXT_PHASE === BUILD_PHASE) return;

  const needed = (key: keyof typeof env, why: string) => {
    if (!env[key]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} is required in production (${why})`,
      });
    }
  };

  if (env.NODE_ENV === 'production') {
    needed('AUTH_SECRET', 'signs session cookies');
    needed('GOOGLE_CLIENT_ID', 'Google sign-in');
    needed('GOOGLE_CLIENT_SECRET', 'Google sign-in');
    needed('TOKEN_ENCRYPTION_KEY', 'encrypts YouTube refresh tokens at rest');
    needed('REDIS_URL', 'rate limiting must be shared across instances');

    if (env.AI_PROVIDER === 'mock') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AI_PROVIDER'],
        message: 'AI_PROVIDER=mock is never allowed in production — it returns fixture data',
      });
    }
  }

  if (env.AI_PROVIDER === 'openai' && !env.OPENAI_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OPENAI_API_KEY'],
      message: 'OPENAI_API_KEY is required when AI_PROVIDER=openai',
    });
  }
});

export type Env = z.infer<typeof base>;

/**
 * Exported for unit tests so the rules above can be exercised without mutating
 * the real process environment.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  // `KEY=` with nothing after it is how people leave a variable unset in a
  // .env file. Treat it as absent, or every optional setting would fail min(1).
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const result = schema.safeParse(cleaned);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return result.data;
}

export const env: Env = parseEnv(process.env);

// Auth.js reads its base URL from AUTH_URL. Pinning it to APP_URL means sign-in
// callback URLs are built from configuration rather than from a request's
// (spoofable) Host header. This module is the only place allowed to touch
// process.env, so the bridge lives here.
process.env.AUTH_URL ??= `${env.APP_URL}/api/auth`;

/** Derived values, computed once so call sites never re-implement them. */
export const config = {
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  isDevelopment: env.NODE_ENV === 'development',
  youtubeOAuthRedirectUri:
    env.YOUTUBE_OAUTH_REDIRECT_URI ?? `${env.APP_URL}/api/youtube/oauth/callback`,
  /** Migrations must not run through a transaction-mode pooler. */
  migrationDatabaseUrl: env.DIRECT_DATABASE_URL ?? env.DATABASE_URL,
} as const;
