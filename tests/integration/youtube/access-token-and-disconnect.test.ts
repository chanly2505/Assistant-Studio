import { randomBytes } from 'node:crypto';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SecretString } from '@/domain/shared/secret';
import { disconnectChannel } from '@/modules/channels/disconnect-channel';
import {
  clearAccessTokenCache,
  getAccessToken,
  primeAccessToken,
} from '@/modules/youtube/access-token';
import { getTokenVault, setTokenVault, TokenVault } from '@/services/crypto';

import { createTestUser, disconnectDatabase, resetDatabase, testPrisma } from '../../helpers/db';
import {
  REVOKE_URL,
  TOKEN_URL,
  callsTo,
  google,
  googleServer,
  resetGoogle,
} from '../../helpers/google';

beforeAll(() => googleServer.listen({ onUnhandledRequest: 'error' }));
beforeEach(async () => {
  await resetDatabase();
  await testPrisma.plan.createMany({
    data: [{ key: 'free', name: 'Free', maxChannels: 1, monthlyGenerations: {} }],
    skipDuplicates: true,
  });
  clearAccessTokenCache();
});
afterEach(() => {
  resetGoogle();
  setTokenVault(undefined);
});
afterAll(async () => {
  googleServer.close();
  await disconnectDatabase();
});

/** A connected channel with a genuinely encrypted refresh token. */
async function connected(refreshToken = '1//stored-refresh-token') {
  const user = await createTestUser();
  const id = `conn_${randomBytes(4).toString('hex')}`;
  const connection = await testPrisma.youTubeConnection.create({
    data: {
      id,
      userId: user.id,
      googleSub: `sub-${id}`,
      googleEmail: 'creator@example.com',
      encryptedRefreshToken: getTokenVault().encrypt(new SecretString(refreshToken), id),
      scopes: [],
    },
  });
  const channel = await testPrisma.youTubeChannel.create({
    data: {
      connectionId: id,
      userId: user.id,
      youtubeChannelId: `UC_${id}`,
      title: 'Channel',
      uploadsPlaylistId: `UU_${id}`,
    },
  });
  return { user, connection, channel };
}

describe('getAccessToken', () => {
  it('refreshes with the decrypted refresh token', async () => {
    const { user, connection } = await connected('1//decrypt-me');
    googleServer.use(google.tokenRefresh());

    const token = await getAccessToken({ userId: user.id, connectionId: connection.id });

    expect(token.expose()).toMatch(/^ya29\.refreshed-/);
    expect(callsTo(TOKEN_URL)[0]?.body?.get('refresh_token')).toBe('1//decrypt-me');
    const after = await testPrisma.youTubeConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    expect(after.lastRefreshedAt).not.toBeNull();
  });

  it('serves a cached token without contacting Google', async () => {
    const { user, connection } = await connected();
    primeAccessToken(connection.id, new SecretString('ya29.cached'), 3600);

    const token = await getAccessToken({ userId: user.id, connectionId: connection.id });
    expect(token.expose()).toBe('ya29.cached');
    expect(callsTo(TOKEN_URL)).toHaveLength(0);
  });

  it('refreshes a token that is inside the two-minute expiry skew', async () => {
    const { user, connection } = await connected();
    primeAccessToken(connection.id, new SecretString('ya29.almost-expired'), 60);
    googleServer.use(google.tokenRefresh());

    const token = await getAccessToken({ userId: user.id, connectionId: connection.id });
    expect(token.expose()).not.toBe('ya29.almost-expired');
  });

  it('collapses concurrent callers into ONE refresh request', async () => {
    const { user, connection } = await connected();
    googleServer.use(google.tokenRefresh({ delayMs: 50 }));

    const tokens = await Promise.all(
      Array.from({ length: 10 }, () =>
        getAccessToken({ userId: user.id, connectionId: connection.id }),
      ),
    );

    expect(callsTo(TOKEN_URL)).toHaveLength(1);
    expect(new Set(tokens.map((t) => t.expose())).size).toBe(1);
  });

  it('marks the connection REAUTH_REQUIRED on invalid_grant, then fails fast', async () => {
    const { user, connection } = await connected();
    googleServer.use(google.tokenRefresh({ status: 400, error: 'invalid_grant' }));

    await expect(
      getAccessToken({ userId: user.id, connectionId: connection.id }),
    ).rejects.toMatchObject({ code: 'YOUTUBE_REAUTH_REQUIRED' });

    const after = await testPrisma.youTubeConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    expect(after.status).toBe('REAUTH_REQUIRED');
    expect(
      await testPrisma.auditLog.count({ where: { action: 'youtube.connection.reauth_required' } }),
    ).toBe(1);

    // Second call: no request to Google at all.
    await expect(
      getAccessToken({ userId: user.id, connectionId: connection.id }),
    ).rejects.toMatchObject({ code: 'YOUTUBE_REAUTH_REQUIRED' });
    expect(callsTo(TOKEN_URL)).toHaveLength(1);
  });

  it('keeps the connection ACTIVE when Google has a transient failure', async () => {
    const { user, connection } = await connected();
    googleServer.use(google.tokenRefresh({ status: 503 }));

    await expect(
      getAccessToken({ userId: user.id, connectionId: connection.id }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });

    const after = await testPrisma.youTubeConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    expect(after.status).toBe('ACTIVE');
  });

  it('refuses another user’s connection id', async () => {
    const { connection } = await connected();
    const stranger = await createTestUser();

    await expect(
      getAccessToken({ userId: stranger.id, connectionId: connection.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(callsTo(TOKEN_URL)).toHaveLength(0);
  });

  it('re-encrypts a row sealed under a rotated-out key on first use', async () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    setTokenVault(new TokenVault({ current: 1, keys: new Map([[1, oldKey]]) }));
    const { user, connection } = await connected('1//rotate-me');
    expect(Buffer.from(connection.encryptedRefreshToken, 'base64')[0]).toBe(1);

    const rotated = new TokenVault({
      current: 2,
      keys: new Map([
        [1, oldKey],
        [2, newKey],
      ]),
    });
    setTokenVault(rotated);
    googleServer.use(google.tokenRefresh());
    await getAccessToken({ userId: user.id, connectionId: connection.id });

    const after = await testPrisma.youTubeConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    expect(Buffer.from(after.encryptedRefreshToken, 'base64')[0]).toBe(2);
    expect(after.encryptionKeyVersion).toBe(2);
    expect(rotated.decrypt(after.encryptedRefreshToken, connection.id).expose()).toBe(
      '1//rotate-me',
    );
  });
});

describe('disconnectChannel', () => {
  it('revokes at Google, wipes the ciphertext and keeps the channel history', async () => {
    const { user, connection, channel } = await connected('1//revoke-me');
    await testPrisma.channelStatsSnapshot.create({
      data: { channelId: channel.id, subscriberCount: 10n, viewCount: 100n, videoCount: 3 },
    });
    googleServer.use(google.revoke('ok'));

    const result = await disconnectChannel({ userId: user.id, channelId: channel.id });

    expect(result).toEqual({ ok: true, data: { revocation: 'revoked' } });
    expect(callsTo(REVOKE_URL)[0]?.body?.get('token')).toBe('1//revoke-me');

    const conn = await testPrisma.youTubeConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    expect(conn).toMatchObject({ status: 'REVOKED', encryptedRefreshToken: '' });

    const ch = await testPrisma.youTubeChannel.findUniqueOrThrow({ where: { id: channel.id } });
    expect(ch.disconnectedAt).not.toBeNull();
    expect(await testPrisma.channelStatsSnapshot.count({ where: { channelId: channel.id } })).toBe(
      1,
    );
    expect(
      await testPrisma.auditLog.count({ where: { action: 'youtube.channel.disconnected' } }),
    ).toBe(1);
  });

  it('treats an already-revoked grant as success', async () => {
    const { user, channel } = await connected();
    googleServer.use(google.revoke('invalid_token'));

    const result = await disconnectChannel({ userId: user.id, channelId: channel.id });
    expect(result).toEqual({ ok: true, data: { revocation: 'already_invalid' } });
  });

  it('still wipes the local grant when Google is unreachable, and says so', async () => {
    const { user, connection, channel } = await connected();
    googleServer.use(google.revoke('network_error'));

    const result = await disconnectChannel({ userId: user.id, channelId: channel.id });
    expect(result).toEqual({ ok: true, data: { revocation: 'failed' } });

    const conn = await testPrisma.youTubeConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    expect(conn.encryptedRefreshToken).toBe('');
  });

  it('makes the grant unusable immediately — no cached token survives', async () => {
    const { user, connection, channel } = await connected();
    primeAccessToken(connection.id, new SecretString('ya29.cached'), 3600);
    googleServer.use(google.revoke('ok'));

    await disconnectChannel({ userId: user.id, channelId: channel.id });

    await expect(
      getAccessToken({ userId: user.id, connectionId: connection.id }),
    ).rejects.toMatchObject({ code: 'YOUTUBE_REAUTH_REQUIRED' });
  });

  it('answers NOT_FOUND for another user’s channel and changes nothing', async () => {
    const { channel } = await connected();
    const stranger = await createTestUser();

    const result = await disconnectChannel({ userId: stranger.id, channelId: channel.id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
    expect(callsTo(REVOKE_URL)).toHaveLength(0);
    const ch = await testPrisma.youTubeChannel.findUniqueOrThrow({ where: { id: channel.id } });
    expect(ch.disconnectedAt).toBeNull();
  });

  it('answers NOT_FOUND for a channel that is already disconnected', async () => {
    const { user, channel } = await connected();
    googleServer.use(google.revoke('ok'));
    await disconnectChannel({ userId: user.id, channelId: channel.id });

    const again = await disconnectChannel({ userId: user.id, channelId: channel.id });
    expect(again.ok).toBe(false);
  });
});
