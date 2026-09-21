import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Test environment bootstrap.
 *
 * `.env.test` points at `studio_assistant_test`, a separate database from the
 * development one, so a test run can truncate freely. The guard below refuses to
 * run if anything points the suite at a database whose name does not end in
 * `_test` — wiping a developer's working data because of a stray env var is a
 * mistake worth making impossible.
 */

/** Minimal .env reader. Next.js loads these itself at runtime; tests do not. */
function loadEnvFile(file: string): void {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();

    // Real environment variables win, so CI can override the file.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// @types/node marks NODE_ENV read-only; Object.assign is the sanctioned escape.
Object.assign(process.env, { NODE_ENV: 'test' });
loadEnvFile('.env.test');

const databaseUrl = process.env.DATABASE_URL ?? '';

if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env.test and run `pnpm db:start`.',
  );
}

if (!/_test(\?|$)/.test(databaseUrl)) {
  const redacted = databaseUrl.replace(/\/\/[^@]*@/, '//***@');
  throw new Error(
    `Refusing to run tests against "${redacted}": the test database name must end in "_test".`,
  );
}
