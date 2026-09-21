import { randomBytes } from 'node:crypto';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryRateLimiter, setRateLimiter } from '@/lib/api/rate-limit';
import { SESSION_COOKIE_NAME } from '@/lib/auth/cookies';
import { clearAccessTokenCache } from '@/modules/youtube/access-token';

import { createTestUser, disconnectDatabase, resetDatabase, testPrisma } from '../helpers/db';
import { channelItem, google, googleServer, resetGoogle } from '../helpers/google';

/**
 * Browser-facing routes, driven through the REAL session path: a Session row,
 * a cookie, DatabaseSessionProvider. No session stub in this file.
 */

const APP = 'http://localhost:3000';

const start = async () => (await import('@/app/api/youtube/oauth/start/route')).POST;
const callback = async () => (await import('@/app/api/youtube/oauth/callback/route')).GET;
const channels = async () => (await import('@/app/api/v1/channels/route')).GET;
const channelById = async () => (await import('@/app/api/v1/channels/[channelId]/route')).DELETE;

beforeAll(() => googleServer.listen({ onUnhandledRequest: 'error' }));
beforeEach(async () => {
  await resetDatabase();
  await testPrisma.plan.createMany({
    data: [{ key: 'free', name: 'Free', maxChannels: 1, monthlyGenerations: {} }],
    skipDuplicates: true,
  });
  setRateLimiter(new InMemoryRateLimiter());
  clearAccessTokenCache();
});
afterEach(() => resetGoogle());
afterAll(async () => {
  googleServer.close();
  await disconnectDatabase();
});

async function signedInUser() {
  const user = await createTestUser();
  const token = randomBytes(32).toString('hex');
  await testPrisma.session.create({
    data: { sessionToken: token, userId: user.id, expires: new Date(Date.now() + 3_600_000) },
  });
  return { user, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

function post(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { method: 'POST', headers: { origin: APP, ...headers } });
}

function location(response: Response): URL {
  return new URL(response.headers.get('location') ?? '', APP);
}

/** Starts a flow over HTTP and returns the state Google would echo back. */
async function startOverHttp(cookie: string): Promise<string> {
  const response = await (await start())(post(`${APP}/api/youtube/oauth/start`, { cookie }));
  return location(response).searchParams.get('state') ?? '';
}

describe('POST /api/youtube/oauth/start', () => {
  it('sends a signed-out browser to sign-in, not a JSON error', async () => {
    const response = await (await start())(post(`${APP}/api/youtube/oauth/start`));
    expect(response.status).toBe(303);
    expect(location(response).pathname).toBe('/en/sign-in');
  });

  it('redirects a signed-in user to Google’s consent screen', async () => {
    const { user, cookie } = await signedInUser();
    const response = await (await start())(post(`${APP}/api/youtube/oauth/start`, { cookie }));

    expect(response.status).toBe(303);
    const target = location(response);
    expect(target.host).toBe('accounts.google.com');
    const state = target.searchParams.get('state') ?? '';
    expect((await testPrisma.oAuthState.findUnique({ where: { state } }))?.userId).toBe(user.id);
  });

  it('refuses a cross-site form post and creates no state (CSRF)', async () => {
    const { cookie } = await signedInUser();
    const response = await (
      await start()
    )(post(`${APP}/api/youtube/oauth/start`, { cookie, origin: 'https://evil.example' }));

    // The Origin check runs before authentication, so the rejection is decided
    // without ever loading the session. What matters: no flow was started.
    expect(response.status).toBe(303);
    expect(location(response).host).not.toBe('accounts.google.com');
    expect(await testPrisma.oAuthState.count()).toBe(0);
  });

  it('limits a user to five starts an hour', async () => {
    const { cookie } = await signedInUser();
    const handler = await start();
    for (let i = 0; i < 5; i += 1) {
      expect(location(await handler(post(`${APP}/api/youtube/oauth/start`, { cookie }))).host).toBe(
        'accounts.google.com',
      );
    }
    const limited = await handler(post(`${APP}/api/youtube/oauth/start`, { cookie }));
    expect(location(limited).searchParams.get('error')).toBe('RATE_LIMITED');
  });
});

describe('GET /api/youtube/oauth/callback', () => {
  it('completes the flow and lands on the channels page', async () => {
    const { user, cookie } = await signedInUser();
    const state = await startOverHttp(cookie);
    googleServer.use(google.tokenExchange(), google.channels([channelItem()]));

    // Google appends parameters of its own; they must not break validation.
    const url = `${APP}/api/youtube/oauth/callback?state=${state}&code=abc&scope=x&authuser=0&prompt=consent`;
    const response = await (await callback())(new Request(url, { headers: { cookie } }));

    expect(response.status).toBe(303);
    expect(location(response).pathname).toBe('/en/channels');
    expect(location(response).searchParams.get('connected')).toBe('1');
    expect(await testPrisma.youTubeChannel.count({ where: { userId: user.id } })).toBe(1);
  });

  it('shows the cancel message when the user declines on Google', async () => {
    const { cookie } = await signedInUser();
    const state = await startOverHttp(cookie);

    const response = await (
      await callback()
    )(
      new Request(`${APP}/api/youtube/oauth/callback?state=${state}&error=access_denied`, {
        headers: { cookie },
      }),
    );
    expect(location(response).searchParams.get('error')).toBe('OAUTH_DENIED');
  });

  it('splits a conflict into a message the user can act on', async () => {
    const { cookie: firstCookie } = await signedInUser();
    googleServer.use(google.tokenExchange({ sub: 'a' }), google.channels([channelItem()]));
    await (
      await callback()
    )(
      new Request(
        `${APP}/api/youtube/oauth/callback?state=${await startOverHttp(firstCookie)}&code=c`,
        {
          headers: { cookie: firstCookie },
        },
      ),
    );
    resetGoogle();

    const { cookie } = await signedInUser();
    googleServer.use(
      google.tokenExchange({ sub: 'b' }),
      google.channels([channelItem()]),
      google.revoke(),
    );
    const response = await (
      await callback()
    )(
      new Request(`${APP}/api/youtube/oauth/callback?state=${await startOverHttp(cookie)}&code=c`, {
        headers: { cookie },
      }),
    );
    expect(location(response).searchParams.get('error')).toBe('CHANNEL_OWNED');
  });

  it('sends the browser to sign-in if the session vanished mid-consent', async () => {
    const response = await (
      await callback()
    )(new Request(`${APP}/api/youtube/oauth/callback?state=s&code=c`));
    expect(location(response).pathname).toBe('/en/sign-in');
  });

  it('ignores a cookie that names no session', async () => {
    const response = await (
      await callback()
    )(
      new Request(`${APP}/api/youtube/oauth/callback?state=s&code=c`, {
        headers: { cookie: `${SESSION_COOKIE_NAME}=forged-token` },
      }),
    );
    expect(location(response).pathname).toBe('/en/sign-in');
  });
});

describe('channel API with a real session', () => {
  async function connectedUser() {
    const { user, cookie } = await signedInUser();
    googleServer.use(
      google.tokenExchange({ sub: `sub-${user.id}` }),
      google.channels([channelItem({ id: `UC_${user.id}` })]),
    );
    await (
      await callback()
    )(
      new Request(`${APP}/api/youtube/oauth/callback?state=${await startOverHttp(cookie)}&code=c`, {
        headers: { cookie },
      }),
    );
    resetGoogle();
    const channel = await testPrisma.youTubeChannel.findFirstOrThrow({
      where: { userId: user.id },
    });
    return { user, cookie, channel };
  }

  it('lists the connected channel with its first stats snapshot', async () => {
    const { cookie } = await connectedUser();
    const response = await (
      await channels()
    )(new Request(`${APP}/api/v1/channels`, { headers: { cookie } }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.channels[0]).toMatchObject({
      needsReauth: false,
      stats: { subscriberCount: '12300', viewCount: '1234567', videoCount: 88 },
    });
  });

  it('flags a connection whose grant was revoked at Google', async () => {
    const { cookie, channel } = await connectedUser();
    await testPrisma.youTubeConnection.update({
      where: { id: channel.connectionId },
      data: { status: 'REAUTH_REQUIRED' },
    });

    const body = await (
      await (
        await channels()
      )(new Request(`${APP}/api/v1/channels`, { headers: { cookie } }))
    ).json();
    expect(body.data.channels[0].needsReauth).toBe(true);
  });

  it('DELETE disconnects the caller’s own channel', async () => {
    const { cookie, channel } = await connectedUser();
    googleServer.use(google.revoke('ok'));

    const response = await (
      await channelById()
    )(
      new Request(`${APP}/api/v1/channels/${channel.id}`, {
        method: 'DELETE',
        headers: { cookie, origin: APP },
      }),
      { params: Promise.resolve({ channelId: channel.id }) },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data.revocation).toBe('revoked');
  });

  it('DELETE answers 404 — not 403 — for someone else’s channel', async () => {
    const { channel } = await connectedUser();
    const { cookie: strangerCookie } = await signedInUser();

    const response = await (
      await channelById()
    )(
      new Request(`${APP}/api/v1/channels/${channel.id}`, {
        method: 'DELETE',
        headers: { cookie: strangerCookie, origin: APP },
      }),
      { params: Promise.resolve({ channelId: channel.id }) },
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('NOT_FOUND');
  });

  it('DELETE refuses a cross-origin request', async () => {
    const { cookie, channel } = await connectedUser();
    const response = await (
      await channelById()
    )(
      new Request(`${APP}/api/v1/channels/${channel.id}`, {
        method: 'DELETE',
        headers: { cookie, origin: 'https://evil.example' },
      }),
      { params: Promise.resolve({ channelId: channel.id }) },
    );
    expect(response.status).toBe(403);
    const after = await testPrisma.youTubeChannel.findUniqueOrThrow({ where: { id: channel.id } });
    expect(after.disconnectedAt).toBeNull();
  });
});
