import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests in a real browser: the installed Google Chrome, so nothing
 * is downloaded. docs/architecture/09-testing-strategy.md
 *
 * The app runs on its own port, build folder and database, so this can run
 * beside `pnpm dev` without either disturbing the other:
 *   port 3100 · .next-e2e · studio_assistant_e2e
 *
 * Secrets come from .env.test, whose Google and OpenAI keys are fakes. AI is
 * switched off, and no test signs in through Google: a session is created
 * directly in the database (tests/e2e/global-setup.ts).
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
  webServer: {
    command: `pnpm exec next dev -p ${E2E_PORT}`,
    url: `http://localhost:${E2E_PORT}/en/sign-in`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      APP_URL: `http://localhost:${E2E_PORT}`,
      DATABASE_URL: E2E_DATABASE_URL,
      NEXT_DIST_DIR: '.next-e2e',
      NEXT_TSCONFIG_PATH: 'tsconfig.e2e.json',
      NEXT_TELEMETRY_DISABLED: '1',
      PREVIEW_LOCALES: 'km,th,vi,zh',
      AI_PROVIDER: 'disabled',
      LOG_LEVEL: 'warn',
      AUTH_SECRET: env.AUTH_SECRET ?? '',
      TOKEN_ENCRYPTION_KEY: env.TOKEN_ENCRYPTION_KEY ?? '',
      GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID ?? '',
      GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET ?? '',
      REDIS_URL: env.REDIS_URL ?? 'redis://127.0.0.1:6379/0',
      REDIS_KEY_PREFIX: 'ysa-e2e',
    },
  },
});
