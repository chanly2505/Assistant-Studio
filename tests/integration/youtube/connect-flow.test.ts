import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { YOUTUBE_READONLY } from '@/domain/youtube/scopes';
import { clearAccessTokenCache } from '@/modules/youtube/access-token';
import { completeChannelConnect } from '@/modules/youtube/complete-channel-connect';
import { startChannelConnect } from '@/modules/youtube/start-channel-connect';
import { getTokenVault } from '@/services/crypto';

import { createTestUser, disconnectDatabase, resetDatabase, testPrisma } from '../../helpers/db';
import {
  CHANNELS_URL,
  REVOKE_URL,
  TOKEN_URL,
  callsTo,
  channelItem,
  google,
  googleServer,
  resetGoogle,
} from '../../helpers/google';

/**
 * The channel-connect grant, end to end against a real database.
 * docs/architecture/05-authentication-architecture.md §5.3
 */

beforeAll(() => googleServer.listen({ onUnhandledRequest: 'error' }));
beforeEach(async () => {
  await resetDatabase();
  await seedPlans();
  clearAccessTokenCache();
});
afterEach(() => resetGoogle());
afterAll(async () => {
  googleServer.close();
  await disconnectDatabase();
});

async function seedPlans() {
  // The reference_plans migration seeds these; TRUNCATE removed them.
  await testPrisma.plan.createMany({
    data: [
      { key: 'free', name: 'Free', maxChannels: 1, monthlyGenerations: {} },
      { key: 'creator', name: 'Creator', maxChannels: 3, monthlyGenerations: {} },
    ],
    skipDuplicates: true,
  });
}

/** Runs step 1 for real and returns the state value Google would echo back. */
async function startFor(user: { id: string; email: string }): Promise<string> {
  const started = await startChannelConnect({ userId: user.id, email: user.email });
  if (!started.ok) throw started.error;
  const state = new URL(started.data.authorizationUrl).searchParams.get('state');
  if (!state) throw new Error('no state in authorization URL');
  return state;
}

describe('startChannelConnect', () => {
  it('stores a single state row bound to the user, with a PKCE verifier', async () => {
    const user = await createTestUser();
    const state = await startFor(user);

    const row = await testPrisma.oAuthState.findUniqueOrThrow({ where: { state } });
    expect(row.userId).toBe(user.id);
    expect(row.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses when the plan limit is already reached', async () => {
    const user = await createTestUser(); // free plan: 1 channel
    googleServer.use(google.tokenExchange(), google.channels([channelItem()]));
    await completeChannelConnect({
      sessionUserId: user.id,
      code: 'c',
      state: await startFor(user),
    });

    const second = await startChannelConnect({ userId: user.id, email: user.email });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.messageKey).toBe('errors.channels.limitReached');
  });
});

describe('completeChannelConnect — happy path', () => {
  it('stores the grant encrypted, the channel, a stats snapshot and an audit entry', async () => {
    const user = await createTestUser();
    googleServer.use(google.tokenExchange(), google.channels([channelItem()]));

    const result = await completeChannelConnect({
      sessionUserId: user.id,
      code: 'auth-code',
      state: await startFor(user),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const connection = await testPrisma.youTubeConnection.findUniqueOrThrow({
      where: { id: result.data.connectionId },
    });
    // Ciphertext at rest — and it opens only on this row.
    expect(connection.encryptedRefreshToken).not.toContain('refresh-token-A');
    expect(getTokenVault().decrypt(connection.encryptedRefreshToken, connection.id).expose()).toBe(
      '1//refresh-token-A',
    );
    expect(connection).toMatchObject({
      userId: user.id,
      googleSub: 'google-sub-1',
      googleEmail: 'creator@example.com',
      status: 'ACTIVE',
    });

    const channel = await testPrisma.youTubeChannel.findUniqueOrThrow({
      where: { youtubeChannelId: 'UC_test_channel_1' },
      include: { statsSnapshots: true, settings: true },
    });
    expect(channel).toMatchObject({
      userId: user.id,
      connectionId: connection.id,
      title: 'Phnom Penh Street Food',
      uploadsPlaylistId: 'UU_test_channel_1',
    });
    expect(channel.settings).not.toBeNull();
    expect(channel.statsSnapshots[0]).toMatchObject({
      subscriberCount: 12_300n,
      viewCount: 1_234_567n,
      videoCount: 88,
    });

    const audit = await testPrisma.auditLog.findFirst({
      where: { action: 'youtube.connection.created' },
    });
    expect(audit?.resourceId).toBe(connection.id);
  });

  it('exchanges the code with the PKCE verifier from the state row', async () => {
    const user = await createTestUser();
    const state = await startFor(user);
    const { codeVerifier } = await testPrisma.oAuthState.findUniqueOrThrow({ where: { state } });
    googleServer.use(google.tokenExchange(), google.channels([channelItem()]));

    await completeChannelConnect({ sessionUserId: user.id, code: 'auth-code', state });

    const exchange = callsTo(TOKEN_URL)[0];
    expect(exchange?.body?.get('code_verifier')).toBe(codeVerifier);
    expect(exchange?.body?.get('code')).toBe('auth-code');
  });

  it('charges exactly one quota unit and sends the token as a bearer header', async () => {
    const user = await createTestUser();
    googleServer.use(google.tokenExchange(), google.channels([channelItem()]));
    await completeChannelConnect({
      sessionUserId: user.id,
      code: 'c',
      state: await startFor(user),
    });

    const ledger = await testPrisma.apiQuotaLedger.findMany();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.unitsUsed).toBe(1n);
    expect(callsTo(CHANNELS_URL)[0]?.authorization).toBe('Bearer ya29.exchanged-access-token');
  });

  it('stores NULL, not 0, when the creator hides their subscriber count', async () => {
    const user = await createTestUser();
    googleServer.use(google.tokenExchange(), google.channels([channelItem({ hidden: true })]));
    await completeChannelConnect({
      sessionUserId: user.id,
      code: 'c',
      state: await startFor(user),
    });

    const snapshot = await testPrisma.channelStatsSnapshot.findFirstOrThrow();
    expect(snapshot.subscriberCount).toBeNull();
  });

  it('reconnects a disconnected channel onto the same rows, keeping its history', async () => {
    const user = await createTestUser();
    googleServer.use(google.tokenExchange(), google.channels([channelItem()]));
    const first = await completeChannelConnect({
      sessionUserId: user.id,
      code: 'c',
      state: await startFor(user),
    });
    if (!first.ok) throw first.error;
    const channelId = first.data.channels[0]?.id as string;

    await testPrisma.youTubeChannel.update({
      where: { id: channelId },
      data: { disconnectedAt: new Date() },
    });
    await testPrisma.youTubeConnection.update({
      where: { id: first.data.connectionId },
      data: { status: 'REVOKED', encryptedRefreshToken: '' },
    });

    const second = await completeChannelConnect({
      sessionUserId: user.id,
      code: 'c2',
      state: await startFor(user),
    });
    if (!second.ok) throw second.error;

    expect(second.data.connectionId).toBe(first.data.connectionId);
    expect(second.data.channels[0]).toMatchObject({ id: channelId, reattached: true });
    expect(await testPrisma.youTubeChannel.count()).toBe(1);
    expect(await testPrisma.channelStatsSnapshot.count()).toBe(2);

    const connection = await testPrisma.youTubeConnection.findUniqueOrThrow({
      where: { id: second.data.connectionId },
    });
    expect(connection.status).toBe('ACTIVE');
    expect(connection.encryptedRefreshToken).not.toBe('');
  });
});

describe('completeChannelConnect — state protection', () => {
  it('rejects a state that belongs to another user (grant injection) and stores nothing', async () => {
    const attacker = await createTestUser();
    const victim = await createTestUser();
    // The attacker starts a flow and sends the resulting callback URL to the
    // victim, hoping to attach the attacker's channel to the victim's account.
    const attackerState = await startFor(attacker);
    googleServer.use(google.tokenExchange(), google.channels([channelItem()]));

    const result = await completeChannelConnect({
      sessionUserId: victim.id,
      code: 'attacker-code',
      state: attackerState,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('OAUTH_STATE_INVALID');
    expect(callsTo(TOKEN_URL)).toHaveLength(0); // never even exchanged
    expect(await testPrisma.youTubeConnection.count()).toBe(0);
    expect(await testPrisma.youTubeChannel.count()).toBe(0);
    expect(
      await testPrisma.auditLog.count({ where: { action: 'youtube.connect.state_user_mismatch' } }),
    ).toBe(1);
  });

  it('accepts a state exactly once', async () => {
    const user = await createTestUser();
    const state = await startFor(user);
    googleServer.use(google.tokenExchange(), google.channels([channelItem()]));

    expect((await completeChannelConnect({ sessionUserId: user.id, code: 'c', state })).ok).toBe(
      true,
    );

    const replay = await completeChannelConnect({ sessionUserId: user.id, code: 'c', state });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe('OAUTH_STATE_INVALID');
  });

  it('lets only one of two concurrent callbacks consume a state', async () => {
    const user = await createTestUser();
    const state = await startFor(user);
    googleServer.use(google.tokenExchange(), google.channels([channelItem()]));

    const results = await Promise.all([
      completeChannelConnect({ sessionUserId: user.id, code: 'c', state }),
      completeChannelConnect({ sessionUserId: user.id, code: 'c', state }),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(callsTo(TOKEN_URL)).toHaveLength(1);
  });

  it('rejects an expired state', async () => {
    const user = await createTestUser();
    const state = await startFor(user);
    await testPrisma.oAuthState.update({
      where: { state },
      data: { expiresAt: new Date(Date.now() - 1) },
    });

    const result = await completeChannelConnect({ sessionUserId: user.id, code: 'c', state });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('OAUTH_STATE_INVALID');
  });

  it('rejects a callback with no state or an invented one', async () => {
    const user = await createTestUser();
    for (const state of [undefined, 'made-up-state']) {
      const result = await completeChannelConnect({ sessionUserId: user.id, code: 'c', state });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('OAUTH_STATE_INVALID');
    }
  });

  it('treats Cancel on the consent screen as OAUTH_DENIED and still burns the state', async () => {
    const user = await createTestUser();
    const state = await startFor(user);

    const result = await completeChannelConnect({
      sessionUserId: user.id,
      state,
      error: 'access_denied',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('OAUTH_DENIED');
    expect(await testPrisma.oAuthState.count()).toBe(0);
  });
});

describe('completeChannelConnect — failures after the exchange', () => {
  async function run(user: { id: string; email: string }) {
    return completeChannelConnect({
      sessionUserId: user.id,
      code: 'c',
      state: await startFor(user),
    });
  }

  async function expectNothingStoredAndRevoked() {
    expect(await testPrisma.youTubeConnection.count()).toBe(0);
    expect(await testPrisma.youTubeChannel.count()).toBe(0);
    // No live grant is left dangling at Google.
    expect(callsTo(REVOKE_URL)).toHaveLength(1);
    expect(callsTo(REVOKE_URL)[0]?.body?.get('token')).toBe('1//refresh-token-A');
  }

  it('refuses a grant where the user unticked the analytics scope', async () => {
    const user = await createTestUser();
    googleServer.use(
      google.tokenExchange({ scope: `openid ${YOUTUBE_READONLY}` }),
      google.revoke(),
    );

    const result = await run(user);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('YOUTUBE_INSUFFICIENT_SCOPE');
    expect(callsTo(CHANNELS_URL)).toHaveLength(0);
    await expectNothingStoredAndRevoked();
  });

  it('reports an account with no YouTube channel', async () => {
    const user = await createTestUser();
    // YouTube omits `items` entirely — not an empty array — for such accounts.
    googleServer.use(google.tokenExchange(), google.channels(undefined), google.revoke());

    const result = await run(user);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('YOUTUBE_NO_CHANNEL');
    await expectNothingStoredAndRevoked();
  });

  it('refuses a channel already connected to another user', async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    googleServer.use(google.tokenExchange({ sub: 'sub-owner' }), google.channels([channelItem()]));
    await run(owner);
    resetGoogle();

    googleServer.use(
      google.tokenExchange({ sub: 'sub-other' }),
      google.channels([channelItem()]),
      google.revoke(),
    );
    const result = await run(other);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.messageKey).toBe('errors.channels.ownedByAnotherUser');
    expect(await testPrisma.youTubeChannel.count({ where: { userId: other.id } })).toBe(0);
    expect(callsTo(REVOKE_URL)).toHaveLength(1);
  });

  it('maps a YouTube quota rejection and stores nothing', async () => {
    const user = await createTestUser();
    googleServer.use(
      google.tokenExchange(),
      google.channelsError(403, 'quotaExceeded'),
      google.revoke(),
    );

    const result = await run(user);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('YOUTUBE_QUOTA_EXCEEDED');
    await expectNothingStoredAndRevoked();
  });

  it('returns the original error even when the clean-up revoke also fails', async () => {
    const user = await createTestUser();
    googleServer.use(
      google.tokenExchange(),
      google.channels(undefined),
      google.revoke('network_error'),
    );

    const result = await run(user);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('YOUTUBE_NO_CHANNEL');
  });

  it('reports a failed code exchange without storing anything or revoking', async () => {
    const user = await createTestUser();
    googleServer.use(google.tokenExchange({ status: 400, error: 'invalid_grant' }));

    const result = await run(user);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('OAUTH_FAILED');
    expect(callsTo(REVOKE_URL)).toHaveLength(0); // nothing was granted
    expect(await testPrisma.youTubeConnection.count()).toBe(0);
  });

  it('rejects an id_token issued for a different OAuth client', async () => {
    const user = await createTestUser();
    googleServer.use(google.tokenExchange({ aud: 'another-app.apps.googleusercontent.com' }));

    const result = await run(user);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('OAUTH_FAILED');
  });

  it('turns a network failure at the token endpoint into UPSTREAM_UNAVAILABLE', async () => {
    const user = await createTestUser();
    const { http, HttpResponse } = await import('msw');
    googleServer.use(http.post(TOKEN_URL, () => HttpResponse.error()));

    const result = await run(user);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UPSTREAM_UNAVAILABLE');
  });
});
