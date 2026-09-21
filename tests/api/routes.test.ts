import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { InMemoryRateLimiter, setRateLimiter } from '@/lib/api/rate-limit';
import { NullSessionProvider, StaticSessionProvider, setSessionProvider } from '@/lib/auth/session';

import {
  createTestChannel,
  createTestUser,
  disconnectDatabase,
  resetDatabase,
} from '../helpers/db';

/**
 * Route contract tests.
 *
 * Route handlers are invoked directly with a real `Request`, so the whole
 * boundary runs: auth → rate limit → validation → use case → serialisation →
 * error mapping. docs/architecture/09 §9.4
 */

const GET_HEALTH = async () => (await import('@/app/api/health/route')).GET;
const GET_READY = async () => (await import('@/app/api/ready/route')).GET;
const GET_CHANNELS = async () => (await import('@/app/api/v1/channels/route')).GET;

const request = (url: string, init?: RequestInit) => new Request(url, init);

function signedInAs(user: { id: string; email: string }) {
  setSessionProvider(
    new StaticSessionProvider({
      user: { id: user.id, email: user.email, locale: 'en', planKey: 'free' },
      expires: new Date(Date.now() + 3_600_000),
    }),
  );
}

beforeAll(async () => {
  setRateLimiter(new InMemoryRateLimiter());
  await resetDatabase();
});

afterEach(() => {
  setSessionProvider(new NullSessionProvider());
  setRateLimiter(new InMemoryRateLimiter());
});

afterAll(async () => {
  await disconnectDatabase();
});

describe('GET /api/health', () => {
  it('reports liveness without a session', async () => {
    const response = await (await GET_HEALTH())(request('http://localhost/api/health'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.status).toBe('ok');
    expect(body.meta.requestId).toBeTruthy();
  });

  it('echoes a caller-supplied correlation id', async () => {
    const response = await (
      await GET_HEALTH()
    )(request('http://localhost/api/health', { headers: { 'x-request-id': 'trace-abc' } }));

    expect(response.headers.get('x-request-id')).toBe('trace-abc');
    expect((await response.json()).meta.requestId).toBe('trace-abc');
  });
});

describe('GET /api/ready', () => {
  it('reports the database as reachable', async () => {
    const response = await (await GET_READY())(request('http://localhost/api/ready'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.checks.database.ok).toBe(true);
    expect(typeof body.data.checks.database.latencyMs).toBe('number');
  });
});

describe('GET /api/v1/channels', () => {
  it('returns 401 with a translation key, not prose, when anonymous', async () => {
    const response = await (await GET_CHANNELS())(request('http://localhost/api/v1/channels'));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe('UNAUTHENTICATED');
    expect(body.error.messageKey).toBe('errors.unauthenticated');
    expect(body.error.requestId).toBeTruthy();
    expect(body).not.toHaveProperty('data');
  });

  it('never includes a stack trace or internal detail in an error body', async () => {
    const response = await (await GET_CHANNELS())(request('http://localhost/api/v1/channels'));
    const raw = JSON.stringify(await response.json());

    expect(raw).not.toContain('stack');
    expect(raw).not.toContain('at Object.');
    expect(raw).not.toContain('postgres');
  });

  it('returns only the signed-in user’s channels', async () => {
    await resetDatabase();

    const alice = await createTestUser();
    const bob = await createTestUser();
    await createTestChannel(alice.id, { title: 'Alice Cooks' });
    await createTestChannel(bob.id, { title: 'Bob Builds' });

    signedInAs(alice);

    const response = await (await GET_CHANNELS())(request('http://localhost/api/v1/channels'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.channels).toHaveLength(1);
    expect(body.data.channels[0].title).toBe('Alice Cooks');
  });

  it('rejects an unknown query parameter instead of ignoring it', async () => {
    const user = await createTestUser();
    signedInAs(user);

    const response = await (
      await GET_CHANNELS()
    )(request('http://localhost/api/v1/channels?notAParam=1'));
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.issues[0].path).toMatch(/^query/);
  });

  it('rejects an invalid enum value for a known parameter', async () => {
    const user = await createTestUser();
    signedInAs(user);

    const response = await (
      await GET_CHANNELS()
    )(request('http://localhost/api/v1/channels?includeDisconnected=maybe'));

    expect(response.status).toBe(422);
  });

  it('returns 429 with Retry-After once the rate limit is exhausted', async () => {
    const user = await createTestUser();
    signedInAs(user);

    const handler = await GET_CHANNELS();
    const url = 'http://localhost/api/v1/channels';

    // The route allows 120 requests per minute.
    for (let i = 0; i < 120; i += 1) {
      const ok = await handler(request(url));
      expect(ok.status).toBe(200);
    }

    const limited = await handler(request(url));
    const body = await limited.json();

    expect(limited.status).toBe(429);
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.retryable).toBe(true);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
  });
});
