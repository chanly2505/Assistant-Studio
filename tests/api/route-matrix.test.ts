import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { InMemoryRateLimiter, setRateLimiter } from '@/lib/api/rate-limit';
import { NullSessionProvider, StaticSessionProvider, setSessionProvider } from '@/lib/auth/session';

import { createTestUser, disconnectDatabase, resetDatabase } from '../helpers/db';

/**
 * The authorisation matrix over EVERY route. docs/architecture/09 §9.4
 *
 * The first test fails when a route file exists that is not in this table,
 * so a new endpoint cannot quietly skip the checks below.
 */

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
interface Entry {
  methods: Method[];
  /** 'required' → anonymous gets 401; 'redirect' → a browser route that sends you to sign in. */
  auth: 'required' | 'none' | 'redirect';
  params?: Record<string, string>;
}

const MATRIX: Record<string, Entry> = {
  'health/route.ts': { methods: ['GET'], auth: 'none' },
  'ready/route.ts': { methods: ['GET'], auth: 'none' },
  'youtube/oauth/start/route.ts': { methods: ['POST'], auth: 'redirect' },
  'youtube/oauth/callback/route.ts': { methods: ['GET'], auth: 'redirect' },
  'v1/account/export/route.ts': { methods: ['GET'], auth: 'required' },
  'v1/account/route.ts': { methods: ['DELETE'], auth: 'required' },
  'v1/ai/description/route.ts': { methods: ['POST'], auth: 'required' },
  'v1/ai/ideas/route.ts': { methods: ['POST'], auth: 'required' },
  'v1/ai/plan/route.ts': { methods: ['POST'], auth: 'required' },
  'v1/ai/script/route.ts': { methods: ['POST'], auth: 'required' },
  'v1/ai/titles/route.ts': { methods: ['POST'], auth: 'required' },
  'v1/ai/generations/route.ts': { methods: ['GET'], auth: 'required' },
  'v1/ai/generations/[generationId]/route.ts': {
    methods: ['GET'],
    auth: 'required',
    params: { generationId: 'x' },
  },
  'v1/calendar/route.ts': { methods: ['GET', 'POST'], auth: 'required' },
  'v1/calendar/[entryId]/route.ts': {
    methods: ['PATCH', 'DELETE'],
    auth: 'required',
    params: { entryId: 'x' },
  },
  'v1/channels/route.ts': { methods: ['GET'], auth: 'required' },
  'v1/channels/[channelId]/route.ts': {
    methods: ['DELETE'],
    auth: 'required',
    params: { channelId: 'x' },
  },
  'v1/channels/[channelId]/analytics/route.ts': {
    methods: ['GET'],
    auth: 'required',
    params: { channelId: 'x' },
  },
  'v1/channels/[channelId]/settings/route.ts': {
    methods: ['GET', 'PATCH'],
    auth: 'required',
    params: { channelId: 'x' },
  },
  'v1/channels/[channelId]/sync/route.ts': {
    methods: ['POST'],
    auth: 'required',
    params: { channelId: 'x' },
  },
  'v1/channels/[channelId]/videos/route.ts': {
    methods: ['GET'],
    auth: 'required',
    params: { channelId: 'x' },
  },
  'v1/ideas/route.ts': { methods: ['GET', 'POST'], auth: 'required' },
  'v1/ideas/[ideaId]/route.ts': {
    methods: ['PATCH', 'DELETE'],
    auth: 'required',
    params: { ideaId: 'x' },
  },
  'v1/me/settings/route.ts': { methods: ['GET', 'PATCH'], auth: 'required' },
  'v1/me/timezone/route.ts': { methods: ['PUT'], auth: 'required' },
  'v1/projects/route.ts': { methods: ['GET', 'POST'], auth: 'required' },
  'v1/projects/[projectId]/route.ts': {
    methods: ['GET', 'PATCH', 'DELETE'],
    auth: 'required',
    params: { projectId: 'x' },
  },
  'v1/projects/[projectId]/assets/route.ts': {
    methods: ['POST'],
    auth: 'required',
    params: { projectId: 'x' },
  },
  'v1/projects/[projectId]/assets/[assetId]/route.ts': {
    methods: ['PATCH'],
    auth: 'required',
    params: { projectId: 'x', assetId: 'y' },
  },
  'v1/usage/route.ts': { methods: ['GET'], auth: 'required' },
};

/** Auth.js owns this one; it is exercised by the sign-in flow instead. */
const OUT_OF_SCOPE = new Set(['auth/[...nextauth]/route.ts']);

const API_DIR = join(process.cwd(), 'app/api');
function routeFiles(dir = API_DIR): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === 'route.ts' ? [relative(API_DIR, full)] : [];
  });
}

const APP = 'http://localhost:3000';
const call = async (file: string, method: Method, params?: Record<string, string>) => {
  const mod = (await import(`@/app/api/${file.replace(/\.ts$/, '')}`)) as Record<
    string,
    (request: Request, args?: { params: Promise<Record<string, string>> }) => Promise<Response>
  >;
  const handler = mod[method];
  if (!handler) throw new Error(`${file} has no ${method}`);
  const unsafe = method !== 'GET';
  return handler(
    new Request(`${APP}/api/${file}`, {
      method,
      headers: { origin: APP, 'content-type': 'application/json' },
      ...(unsafe ? { body: '{}' } : {}),
    }),
    { params: Promise.resolve(params ?? {}) },
  );
};

beforeAll(async () => {
  await resetDatabase();
  setRateLimiter(new InMemoryRateLimiter());
});
afterEach(() => {
  setSessionProvider(new NullSessionProvider());
  setRateLimiter(new InMemoryRateLimiter());
});
afterAll(() => disconnectDatabase());

describe('route matrix', () => {
  it('lists every route file, and every exported method', () => {
    const onDisk = routeFiles()
      .filter((f) => !OUT_OF_SCOPE.has(f))
      .sort();
    expect(onDisk).toEqual(Object.keys(MATRIX).sort());

    for (const [file, entry] of Object.entries(MATRIX)) {
      const source = readFileSync(join(API_DIR, file), 'utf8');
      const exported = [...source.matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\b/g)]
        .map((m) => m[1])
        .sort();
      expect({ file, methods: exported }).toEqual({ file, methods: [...entry.methods].sort() });
    }
  });

  const protectedCases = Object.entries(MATRIX).flatMap(([file, entry]) =>
    entry.auth === 'required' ? entry.methods.map((method) => ({ file, method, entry })) : [],
  );

  it.each(protectedCases)(
    '$method $file → 401 when signed out',
    async ({ file, method, entry }) => {
      const response = await call(file, method, entry.params);
      expect(response.status).toBe(401);
      const body = await response.json();
      // The client-facing error shape, and nothing more: no stack, no SQL, no prose.
      expect(Object.keys(body.error).sort()).toEqual(
        ['code', 'messageKey', 'params', 'requestId', 'retryable'].sort(),
      );
      expect(body.error.messageKey).toMatch(/^errors\./);
    },
  );

  it.each(
    Object.entries(MATRIX).flatMap(([file, entry]) =>
      entry.auth === 'redirect' ? entry.methods.map((method) => ({ file, method })) : [],
    ),
  )('$method $file sends a signed-out browser to sign in', async ({ file, method }) => {
    const response = await call(file, method);
    expect([302, 303, 307]).toContain(response.status);
    expect(response.headers.get('location')).toMatch(/\/sign-in/);
  });
});

describe('default rate limits', () => {
  it('limits a route that sets no rule of its own (reads: 120 a minute)', async () => {
    const user = await createTestUser();
    setSessionProvider(
      new StaticSessionProvider({
        user: { id: user.id, email: user.email, locale: 'en', planKey: 'free' },
        expires: new Date(Date.now() + 3_600_000),
      }),
    );
    const statuses: number[] = [];
    for (let i = 0; i < 121; i += 1)
      statuses.push((await call('v1/channels/route.ts', 'GET')).status);
    expect(statuses.slice(0, 120).every((s) => s === 200)).toBe(true);
    expect(statuses[120]).toBe(429);

    const limited = await call('v1/channels/route.ts', 'GET');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});
