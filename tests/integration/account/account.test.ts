import { randomBytes } from 'node:crypto';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SecretString } from '@/domain/shared/secret';
import { deleteAccount, exportAccount } from '@/modules/account/account';
import { createIdea } from '@/modules/content/ideas';
import { addAsset } from '@/modules/content/assets';
import { createProject } from '@/modules/content/projects';
import { getTokenVault } from '@/services/crypto';

import { createTestUser, disconnectDatabase, resetDatabase, testPrisma } from '../../helpers/db';
import { REVOKE_URL, callsTo, google, googleServer, resetGoogle } from '../../helpers/google';

beforeAll(() => googleServer.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetDatabase());
afterEach(() => resetGoogle());
afterAll(async () => {
  googleServer.close();
  await disconnectDatabase();
});

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.data;
}

/** A user with a connected channel, some content and an AI generation. */
async function populated(email = `creator-${randomBytes(3).toString('hex')}@example.test`) {
  const user = await createTestUser({ email });
  const id = `conn_${randomBytes(4).toString('hex')}`;
  await testPrisma.youTubeConnection.create({
    data: {
      id,
      userId: user.id,
      googleSub: `sub-${id}`,
      googleEmail: email,
      encryptedRefreshToken: getTokenVault().encrypt(new SecretString('1//refresh-secret'), id),
      scopes: ['youtube.readonly'],
    },
  });
  const channel = await testPrisma.youTubeChannel.create({
    data: {
      connectionId: id,
      userId: user.id,
      youtubeChannelId: `UC_${id}`,
      title: 'Food',
      uploadsPlaylistId: `UU_${id}`,
    },
  });
  await testPrisma.channelStatsSnapshot.create({
    data: {
      channelId: channel.id,
      capturedAt: new Date(),
      subscriberCount: 99n,
      viewCount: 1234n,
      videoCount: 1,
    },
  });
  await testPrisma.youTubeVideo.create({
    data: {
      channelId: channel.id,
      youtubeVideoId: `v_${id}`,
      title: 'Night market',
      publishedAt: new Date(),
      durationSeconds: 300,
    },
  });
  unwrap(await createIdea(user.id, { title: 'Breakfast stalls', keywords: [] }));
  const { projectId } = unwrap(await createProject(user.id, { title: 'Morning rush' }));
  unwrap(await addAsset(user.id, projectId, { kind: 'SCRIPT', body: 'My private script' }));
  const generation = await testPrisma.aIGeneration.create({
    data: {
      userId: user.id,
      feature: 'TITLES',
      provider: 'openai',
      model: 'gpt-5.6-luna',
      promptVersion: 'titles.v1',
      inputHash: 'h',
      status: 'OK',
      costMicros: 1234n,
      inputJson: { topic: 'my secret topic' },
      outputJson: { titles: [] },
    },
  });
  return { user, email, channel, connectionId: id, generation };
}

describe('export', () => {
  it('contains the user’s data, and never a token', async () => {
    const { user, email } = await populated();
    const data = unwrap(await exportAccount(user.id));
    const text = JSON.stringify(data);

    expect(data).toMatchObject({ format: 'youtube-studio-assistant-export', version: 1 });
    expect(text).toContain(email);
    expect(text).toContain('Night market');
    expect(text).toContain('My private script');
    expect(text).toContain('my secret topic');
    // No grant, ciphertext or session in the file.
    expect(text).not.toMatch(/encryptedRefreshToken|refresh-secret|sessionToken/);
    // BigInt counters became strings rather than breaking JSON.
    expect(text).toContain('"1234"');
  });

  it('contains nothing of another user', async () => {
    const mine = await populated();
    const theirs = await populated();
    const text = JSON.stringify(unwrap(await exportAccount(mine.user.id)));
    expect(text).not.toContain(theirs.email);
    expect(text).not.toContain(theirs.connectionId);
  });
});

describe('deletion', () => {
  it('refuses without the matching email, and changes nothing', async () => {
    const { user } = await populated();
    expect(await deleteAccount(user.id, 'someone@else.test')).toMatchObject({
      ok: false,
      error: { messageKey: 'errors.account.confirmMismatch' },
    });
    expect(await testPrisma.user.count({ where: { id: user.id } })).toBe(1);
    expect(callsTo(REVOKE_URL)).toHaveLength(0);
  });

  it('revokes at Google, removes the data, and leaves nothing pointing at the person', async () => {
    const other = await populated();
    const { user, email, connectionId, generation } = await populated();
    googleServer.use(google.revoke('ok'));

    const report = unwrap(await deleteAccount(user.id, `  ${email.toUpperCase()} `));
    expect(report).toMatchObject({ connections: 1, revocations: { revoked: 1, failed: 0 } });
    expect(callsTo(REVOKE_URL)).toHaveLength(1);

    for (const count of [
      testPrisma.user.count({ where: { id: user.id } }),
      testPrisma.session.count({ where: { userId: user.id } }),
      testPrisma.youTubeConnection.count({ where: { id: connectionId } }),
      testPrisma.youTubeChannel.count({ where: { userId: user.id } }),
      testPrisma.youTubeVideo.count({ where: { channel: { userId: user.id } } }),
      testPrisma.contentIdea.count({ where: { userId: user.id } }),
      testPrisma.contentProject.count({ where: { userId: user.id } }),
      testPrisma.auditLog.count({ where: { userId: user.id } }),
    ]) {
      expect(await count).toBe(0);
    }
    // The spend record survives for the breaker, with no link and no words.
    const kept = await testPrisma.aIGeneration.findUniqueOrThrow({ where: { id: generation.id } });
    expect(kept).toMatchObject({
      userId: null,
      inputJson: null,
      outputJson: null,
      costMicros: 1234n,
    });
    // The deletion itself is audited, without the person.
    expect(
      await testPrisma.auditLog.count({ where: { action: 'account.deleted', userId: null } }),
    ).toBe(1);

    // The other user is untouched.
    expect(await testPrisma.contentProject.count({ where: { userId: other.user.id } })).toBe(1);
    expect(await testPrisma.youTubeConnection.count({ where: { id: other.connectionId } })).toBe(1);
  });

  it('still deletes when Google cannot be reached', async () => {
    const { user, email } = await populated();
    googleServer.use(google.revoke('network_error'));

    const report = unwrap(await deleteAccount(user.id, email));
    expect(report.revocations.failed).toBe(1);
    expect(await testPrisma.user.count({ where: { id: user.id } })).toBe(0);
  });
});
