import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests in a real browser: the installed Google Chrome, so nothing
 * is downloaded. docs/architecture/09-testing-strategy.md
 *
 * The app is a production build (next build + next start) on its own port,
 * build folder and database, so this can run beside `pnpm dev`:
 *   port 3100 · .next-e2e · studio_assistant_e2e
 *
 * Secrets come from .env.test, whose Google and OpenAI keys are fakes, and
 * every external API is the local fake in tests/e2e/fake-apis — including
 * Google sign-in, which the journeys go through for real. Most specs skip it
 * with a session created directly in the database (global-setup.ts).
 */

export const E2E_PORT = 3100;
export const E2E_DATABASE_URL =
  'postgresql://postgres:postgres@127.0.0.1:5433/studio_assistant_e2e';

function testEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(resolve(__dirname, '.env.test'), 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined) values[match[1]] = match[2];
  }
  return values;
}

const env = testEnv();

export const E2E_REDIS_URL = env.REDIS_URL ?? 'redis://127.0.0.1:6379/0';
export const FAKE_APIS_PORT = 3199;
export const FAKE_APIS_URL = `http://localhost:${FAKE_APIS_PORT}`;

/** The app's environment: .env.test's fake secrets, pointed at the fakes. */
const appEnv: Record<string, string> = {
  APP_URL: `http://localhost:${E2E_PORT}`,
  DATABASE_URL: E2E_DATABASE_URL,
  NEXT_DIST_DIR: '.next-e2e',
  NEXT_TSCONFIG_PATH: 'tsconfig.e2e.json',
  NEXT_TELEMETRY_DISABLED: '1',
  PREVIEW_LOCALES: 'km,th,vi,zh',
  FAKE_EXTERNAL_APIS_URL: FAKE_APIS_URL,
  AI_PROVIDER: 'openai',
  OPENAI_API_KEY: 'sk-fake-e2e-only',
  LOG_LEVEL: 'warn',
  AUTH_SECRET: env.AUTH_SECRET ?? '',
  TOKEN_ENCRYPTION_KEY: env.TOKEN_ENCRYPTION_KEY ?? '',
  GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID ?? '',
  GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET ?? '',
  REDIS_URL: E2E_REDIS_URL,
  REDIS_KEY_PREFIX: 'ysa-e2e',
};

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    channel: 'chrome',
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      // Google (sign-in, OAuth, YouTube APIs) and OpenAI, faked locally.
      command: `pnpm exec tsx tests/e2e/fake-apis/server.ts`,
      url: `${FAKE_APIS_URL}/__state`,
      timeout: 30_000,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
      env: { FAKE_APIS_PORT: String(FAKE_APIS_PORT) },
    },
    {
      // A PRODUCTION build: the real CSP (no eval, no inline styles), static-
      // vs-dynamic rendering and production cookies are what this suite checks.
      command: `pnpm exec next build && pnpm exec next start -p ${E2E_PORT}`,
      url: `http://localhost:${E2E_PORT}/en/sign-in`,
      timeout: 420_000,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
      env: appEnv,
    },
    {
      // The background worker, so a connected channel really backfills.
      command: 'pnpm exec tsx --conditions=react-server src/worker/index.ts',
      wait: { stdout: /worker ready/ },
      timeout: 60_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...appEnv, NODE_ENV: 'production', LOG_LEVEL: 'info' },
    },
  ],
});
