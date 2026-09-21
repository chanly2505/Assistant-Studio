import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { channelRepository } from '@/db/repositories/channel.repository';
import { auditRepository } from '@/db/repositories/audit.repository';

import {
  createTestChannel,
  createTestUser,
  disconnectDatabase,
  resetDatabase,
  testPrisma,
} from '../../helpers/db';

/**
 * Ownership is proven in SQL, not in the UI.
 * docs/architecture/05-authentication-architecture.md §5.5
 *
 * These run against a real PostgreSQL database. Prisma is never mocked — a
 * mocked ORM cannot catch a cascade rule that deletes too much or a unique
 * constraint that does not hold.
 */

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await disconnectDatabase();
});

describe('channelRepository scoping', () => {
  it('never returns another user’s channel by id', async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    const bobsChannel = await createTestChannel(bob.id);

    expect(await channelRepository.findForUser(alice.id, bobsChannel.id)).toBeNull();
    expect(await channelRepository.findForUser(bob.id, bobsChannel.id)).not.toBeNull();
  });

  it('never returns another user’s channel by YouTube id', async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    const bobsChannel = await createTestChannel(bob.id);

    expect(
      await channelRepository.findByYouTubeId(alice.id, bobsChannel.youtubeChannelId),
    ).toBeNull();
  });

  it('lists only the caller’s channels', async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    await createTestChannel(alice.id, { title: 'A1' });
    await createTestChannel(alice.id, { title: 'A2' });
    await createTestChannel(bob.id, { title: 'B1' });

    const aliceChannels = await channelRepository.listForUser(alice.id);

    expect(aliceChannels.map((channel) => channel.title).sort()).toEqual(['A1', 'A2']);
  });

  it('hides disconnected channels unless asked for them', async () => {
    const user = await createTestUser();
    const channel = await createTestChannel(user.id);

    await testPrisma.youTubeChannel.update({
      where: { id: channel.id },
      data: { disconnectedAt: new Date() },
    });

    expect(await channelRepository.listForUser(user.id)).toHaveLength(0);
    expect(
      await channelRepository.listForUser(user.id, { includeDisconnected: true }),
    ).toHaveLength(1);
    expect(await channelRepository.countForUser(user.id)).toBe(0);
  });
});

describe('schema integrity', () => {
  it('rejects two connections for the same Google identity on one user', async () => {
    const user = await createTestUser();

    const data = {
      userId: user.id,
      googleSub: 'sub-duplicate',
      googleEmail: 'dup@example.test',
      encryptedRefreshToken: 'v1:ciphertext',
      scopes: ['https://www.googleapis.com/auth/youtube.readonly'],
    };

    await testPrisma.youTubeConnection.create({ data });
    await expect(testPrisma.youTubeConnection.create({ data })).rejects.toThrow();
  });

  it('treats a YouTube channel id as globally unique', async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    const channel = await createTestChannel(alice.id);

    const bobsConnection = await testPrisma.youTubeConnection.create({
      data: {
        userId: bob.id,
        googleSub: 'sub-bob',
        googleEmail: 'bob@example.test',
        encryptedRefreshToken: 'v1:ciphertext',
        scopes: [],
      },
    });

    await expect(
      testPrisma.youTubeChannel.create({
        data: {
          connectionId: bobsConnection.id,
          userId: bob.id,
          youtubeChannelId: channel.youtubeChannelId,
          title: 'Same channel, different user',
          uploadsPlaylistId: 'UUx',
        },
      }),
    ).rejects.toThrow();
  });

  it('cascades channel deletion from the user but keeps audit history', async () => {
    const user = await createTestUser();
    await createTestChannel(user.id);
    await auditRepository.record({ userId: user.id, action: 'test.event' });

    await testPrisma.user.delete({ where: { id: user.id } });

    expect(await testPrisma.youTubeChannel.count()).toBe(0);
    expect(await testPrisma.youTubeConnection.count()).toBe(0);

    // Audit rows survive with the user reference nulled — operational history
    // is kept, personal data is not. docs/architecture/03 §3.4
    const audits = await testPrisma.auditLog.findMany();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.userId).toBeNull();
  });

  it('stores view counts that exceed a 32-bit integer', async () => {
    const user = await createTestUser();
    const channel = await createTestChannel(user.id);

    const snapshot = await testPrisma.channelStatsSnapshot.create({
      data: {
        channelId: channel.id,
        subscriberCount: 12_300_000n,
        viewCount: 9_876_543_210n,
        videoCount: 812,
      },
    });

    expect(snapshot.viewCount).toBe(9_876_543_210n);
  });

  it('enforces one analytics row per channel per date', async () => {
    const user = await createTestUser();
    const channel = await createTestChannel(user.id);
    const date = new Date('2026-09-01T00:00:00Z');

    await testPrisma.channelAnalyticsDaily.create({
      data: { channelId: channel.id, date, views: 100n },
    });

    // A re-sync of the trailing window must update, not duplicate.
    await testPrisma.channelAnalyticsDaily.upsert({
      where: { channelId_date: { channelId: channel.id, date } },
      create: { channelId: channel.id, date, views: 150n },
      update: { views: 150n, isProvisional: false },
    });

    const rows = await testPrisma.channelAnalyticsDaily.findMany({
      where: { channelId: channel.id },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.views).toBe(150n);
    expect(rows[0]?.isProvisional).toBe(false);
  });

  it('enforces one asset version per project, kind and locale', async () => {
    const user = await createTestUser();
    const project = await testPrisma.contentProject.create({
      data: { userId: user.id, title: 'Test project' },
    });

    const data = {
      projectId: project.id,
      kind: 'TITLE' as const,
      locale: 'en',
      body: 'A title',
      version: 1,
    };

    await testPrisma.contentAsset.create({ data });
    await expect(testPrisma.contentAsset.create({ data })).rejects.toThrow();

    await expect(
      testPrisma.contentAsset.create({ data: { ...data, version: 2, body: 'Another title' } }),
    ).resolves.toBeDefined();
  });
});
