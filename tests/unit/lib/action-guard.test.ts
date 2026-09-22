import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ACTION_LIMIT, guardAction } from '@/lib/api/action-guard';
import { InMemoryRateLimiter, setRateLimiter, type RateLimiter } from '@/lib/api/rate-limit';

/**
 * Every Server Action (page form) is rate limited. Actions never pass through
 * withApi, so this scans the source: an action whose body does not call
 * guardAction fails the build. docs/architecture/08 §8.5
 */

/** Actions that must never be refused. */
const EXEMPT = new Map([
  // Signing out is the safety exit; refusing it would be worse than any abuse.
  ['app/[locale]/(app)/layout.tsx#signOutAction', 'sign-out must always work'],
]);

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return name.endsWith('.tsx') ? [full] : [];
  });
}

function serverActions() {
  const root = process.cwd();
  return tsxFiles(join(root, 'app')).flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return [
      ...source.matchAll(
        /async function (\w+)\([^)]*\) \{\n\s*'use server';\n([\s\S]*?)\n {2}\}\n/g,
      ),
    ].map((match) => ({ id: `${relative(root, file)}#${match[1]}`, body: match[2] ?? '' }));
  });
}

afterEach(() => setRateLimiter(new InMemoryRateLimiter()));

describe('server actions', () => {
  it('finds the actions (the scan itself works)', () => {
    expect(serverActions().length).toBeGreaterThanOrEqual(20);
  });

  it.each(serverActions().filter((a) => !EXEMPT.has(a.id)))('$id calls guardAction', ({ body }) => {
    expect(body).toMatch(/guardAction\(/);
  });

  it('guardAction refuses past the limit', async () => {
    setRateLimiter(new InMemoryRateLimiter());
    const rule = { ...ACTION_LIMIT, key: 'test', points: 2 };
    expect(await guardAction('user:a', rule)).toBe(true);
    expect(await guardAction('user:a', rule)).toBe(true);
    expect(await guardAction('user:a', rule)).toBe(false);
    expect(await guardAction('user:b', rule)).toBe(true);
  });

  it('fails open for free actions and closed for costly ones when the store is down', async () => {
    const broken: RateLimiter = {
      consume: () => Promise.reject(new Error('redis down')),
    };
    setRateLimiter(broken);
    expect(await guardAction('user:a', { ...ACTION_LIMIT, onStoreFailure: 'open' })).toBe(true);
    expect(await guardAction('user:a', { ...ACTION_LIMIT, onStoreFailure: 'closed' })).toBe(false);
  });
});
