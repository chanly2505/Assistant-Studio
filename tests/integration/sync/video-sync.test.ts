import { randomBytes } from 'node:crypto';

import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SecretString } from '@/domain/shared/secret';
import { quotaDayKey } from '@/domain/youtube/quota';
import { refreshChannelStats, refreshVideoStats } from '@/modules/sync/refresh-stats';
import { requestManualSync, scheduleDueSyncs } from '@/modules/sync/schedule';
import { syncChannelVideos } from '@/modules/sync/sync-channel-videos';
import { listVideos } from '@/modules/videos/list-videos';
import { clearAccessTokenCache, primeAccessToken } from '@/modules/youtube/access-token';
import { getTokenVault } from '@/services/crypto';
import { processJob, toJobResult } from '@/worker/processor';
import { logger } from '@/lib/logger';

import { createTestUser, disconnectDatabase, resetDatabase, testPrisma } from '../../helpers/db';
import {
  PLAYLIST_URL,
  VIDEOS_URL,
  callsTo,
  channelItem,
  google,
  googleServer,
  playlistNotFound,
  resetGoogle,
  videoItem,
  youtubeCatalog,
} from '../../helpers/google';
import { recordingQueue } from '../../helpers/queue';

beforeAll(() => googleServer.listen({ onUnhandledRequest: 'error' }));
beforeEach(async () => {
  await resetDatabase();
  await testPrisma.plan.createMany({
    data: [{ key: 'free', name: 'Free', maxChannels: 1, monthlyGenerations: {} }],
    skipDuplicates: true,
  });
  clearAccessTokenCache();
});
afterEach(() => resetGoogle());
afterAll(async () => {
  googleServer.close();
  await disconnectDatabase();
});

/** A connected channel with an encrypted grant and a warm access token. */
async function connectedChannel() {
  const user = await createTestUser();
  const id = `conn_${randomBytes(4).toString('hex')}`;
  await testPrisma.youTubeConnection.create({
    data: {
      id,
      userId: user.id,
      googleSub: `sub-${id}`,
      googleEmail: 'c@example.test',
      encryptedRefreshToken: getTokenVault().encrypt(new SecretString('1//rt'), id),
      scopes: [],
    },
  });
  const channel = await testPrisma.youTubeChannel.create({
    data: {
      connectionId: id,
      userId: user.id,
      youtubeChannelId: `UC_${id}`,
      title: 'Test channel',
      uploadsPlaylistId: `UU_${id}`,
    },
  });
  primeAccessToken(id, new SecretString('ya29.warm'), 3600);
  return { user, channel };
}

const ids = (n: number, prefix = 'vid') =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(4, '0')}`);
const catalogFor = (list: string[]) => list.map((id) => videoItem(id));

async function unitsToday(): Promise<number> {
  const row = await testPrisma.apiQuotaLedger.findFirst({
    where: { api: 'YOUTUBE_DATA', day: new Date(`${quotaDayKey(new Date())}T00:00:00Z`) },
  });
  return Number(row?.unitsUsed ?? 0);
}

describe('full walk', () => {
  it('stores every video, one snapshot each, for exactly the predicted quota', async () => {
    const { user, channel } = await connectedChannel();
    const playlist = ids(120);
    googleServer.use(...youtubeCatalog(playlist, catalogFor(playlist)));

    const outcome = await syncChannelVideos({
      userId: user.id,
      channelId: channel.id,
      mode: 'full',
      trigger: 'connect',
    });

    // 120 videos = 3 playlist pages + 3 videos.list batches = 6 units.
    expect(callsTo(PLAYLIST_URL)).toHaveLength(3);
    expect(callsTo(VIDEOS_URL)).toHaveLength(3);
    expect(outcome.quotaUnitsUsed).toBe(6);
    expect(await unitsToday()).toBe(6);
    expect(outcome.result).toMatchObject({ created: 120, updated: 0, seen: 120, complete: true });

    expect(await testPrisma.youTubeVideo.count({ where: { channelId: channel.id } })).toBe(120);
    expect(await testPrisma.videoStatsSnapshot.count()).toBe(120);

    const job = await testPrisma.syncJob.findUniqueOrThrow({ where: { id: outcome.syncJobId } });
    expect(job).toMatchObject({
      jobType: 'CHANNEL_BACKFILL',
      status: 'SUCCEEDED',
      trigger: 'connect',
      itemsProcessed: 120,
      quotaUnitsUsed: 6,
    });
    const after = await testPrisma.youTubeChannel.findUniqueOrThrow({ where: { id: channel.id } });
    expect(after.syncStatus).toBe('SYNCED');
    expect(after.lastFullSyncAt).not.toBeNull();
  });

  it('is idempotent: a second run updates, never duplicates', async () => {
    const { user, channel } = await connectedChannel();
    const playlist = ids(60);
    googleServer.use(...youtubeCatalog(playlist, catalogFor(playlist)));
    const params = {
      userId: user.id,
      channelId: channel.id,
      mode: 'full' as const,
      trigger: 'schedule' as const,
    };

    await syncChannelVideos(params);
    const second = await syncChannelVideos(params);

    expect(second.result).toMatchObject({ created: 0, updated: 60 });
    expect(await testPrisma.youTubeVideo.count()).toBe(60);
  });

  it('marks videos the playlist no longer lists as deleted, and hides them', async () => {
    const { user, channel } = await connectedChannel();
    const playlist = ids(5);
    googleServer.use(...youtubeCatalog(playlist, catalogFor(playlist)));
    await syncChannelVideos({
      userId: user.id,
      channelId: channel.id,
      mode: 'full',
      trigger: 'schedule',
    });
    resetGoogle();

    const remaining = playlist.filter((id) => id !== 'vid0002');
    googleServer.use(...youtubeCatalog(remaining, catalogFor(remaining)));
    const outcome = await syncChannelVideos({
      userId: user.id,
      channelId: channel.id,
      mode: 'full',
      trigger: 'schedule',
    });

    expect(outcome.result.markedDeleted).toBe(1);
    const gone = await testPrisma.youTubeVideo.findUniqueOrThrow({
      where: { youtubeVideoId: 'vid0002' },
    });
    expect(gone.deletedFromYouTubeAt).not.toBeNull();
    // History kept: the row and its snapshot still exist.
    expect(
      await testPrisma.videoStatsSnapshot.count({ where: { videoId: gone.id } }),
    ).toBeGreaterThan(0);

    const page = await listVideos({ userId: user.id, channelId: channel.id });
    if (!page.ok) throw page.error;
    expect(page.data.videos.map((v) => v.youtubeVideoId)).not.toContain('vid0002');
  });

  it('treats an id the playlist lists but videos.list does not return as unavailable', async () => {
    const { user, channel } = await connectedChannel();
    const playlist = ids(3);
    googleServer.use(...youtubeCatalog(playlist, catalogFor(['vid0000', 'vid0002'])));

    const outcome = await syncChannelVideos({
      userId: user.id,
      channelId: channel.id,
      mode: 'full',
      trigger: 'schedule',
    });
    expect(outcome.result.created).toBe(2);
    expect(await testPrisma.youTubeVideo.count()).toBe(2);
  });

  it('restores a video that comes back', async () => {
    const { user, channel } = await connectedChannel();
    const playlist = ids(2);
    googleServer.use(...youtubeCatalog(['vid0000'], catalogFor(['vid0000'])));
    await syncChannelVideos({
      userId: user.id,
      channelId: channel.id,
      mode: 'full',
      trigger: 'schedule',
    });
    await testPrisma.youTubeVideo.update({
      where: { youtubeVideoId: 'vid0000' },
      data: { deletedFromYouTubeAt: new Date() },
    });
    resetGoogle();

    googleServer.use(...youtubeCatalog(playlist, catalogFor(playlist)));
    await syncChannelVideos({
      userId: user.id,
      channelId: channel.id,
      mode: 'full',
      trigger: 'schedule',
    });

    const back = await testPrisma.youTubeVideo.findUniqueOrThrow({
      where: { youtubeVideoId: 'vid0000' },
    });
    expect(back.deletedFromYouTubeAt).toBeNull();
  });

  it('succeeds with zero videos when the channel has never uploaded (playlist 404)', async () => {
    const { user, channel } = await connectedChannel();
    googleServer.use(playlistNotFound());

    const outcome = await syncChannelVideos({
      userId: user.id,
      channelId: channel.id,
      mode: 'full',
      trigger: 'connect',
    });
    expect(outcome.result).toMatchObject({ seen: 0, created: 0, complete: true });
    expect(callsTo(VIDEOS_URL)).toHaveLength(0);
  });

  it('maps privacy, hidden likes and disabled comments faithfully', async () => {
    const { user, channel } = await connectedChannel();
    googleServer.use(
      ...youtubeCatalog(
        ['p1', 'p2'],
        [
          videoItem('p1', { privacy: 'private', likes: null, comments: null, duration: 'PT45S' }),
          videoItem('p2', { privacy: 'unlisted' }),
        ],
      ),
    );
    await syncChannelVideos({
      userId: user.id,
      channelId: channel.id,
      mode: 'full',
      trigger: 'schedule',
    });

    const p1 = await testPrisma.youTubeVideo.findUniqueOrThrow({
      where: { youtubeVideoId: 'p1' },
      include: { statsSnapshots: true },
    });
    expect(p1).toMatchObject({ privacyStatus: 'PRIVATE', durationSeconds: 45, isShortForm: true });
    expect(p1.statsSnapshots[0]).toMatchObject({ likeCount: null, commentCount: null });
  });
});

describe('delta walk', () => {
  it('stops at the first known video: 1 playlist call, 1 videos call', async () => {
    const { user, channel } = await connectedChannel();
    const original = ids(100);
    googleServer.use(...youtubeCatalog(original, catalogFor(original)));
    await syncChannelVideos({
      userId: user.id,
      channelId: channel.id,
      mode: 'full',
      trigger: 'schedule',
    });
    resetGoogle();

    const withNew = ['new0001', 'new0002', ...original];
    googleServer.use(...youtubeCatalog(withNew, catalogFor(withNew)));
    const before = await unitsToday();
    const outcome = await syncChannelVideos({
      userId: user.id,
      channelId: channel.id,
      mode: 'delta',
      trigger: 'schedule',
    });

    expect(callsTo(PLAYLIST_URL)).toHaveLength(1);
    expect(callsTo(VIDEOS_URL)).toHaveLength(1);
    expect((await unitsToday()) - before).toBe(2);
    expect(outcome.result).toMatchObject({ created: 2, pages: 1 });
  });

  it('never infers deletions (it has not seen every video)', async () => {
    const { user, channel } = await connectedChannel();
    const original = ids(3);
    googleServer.use(...youtubeCatalog(original, catalogFor(original)));
    await syncChannelVideos({
      userId: user.id,
      channelId: channel.id,
      mode: 'full',
      trigger: 'schedule',
    });
    resetGoogle();

    googleServer.use(...youtubeCatalog(['vid0000'], catalogFor(['vid0000'])));
    const outcome = await syncChannelVideos({
      userId: user.id,
      channelId: channel.id,
      mode: 'delta',
      trigger: 'schedule',
    });
    expect(outcome.result.markedDeleted).toBe(0);
    expect(await testPrisma.youTubeVideo.count({ where: { deletedFromYouTubeAt: null } })).toBe(3);
  });

  it('costs nothing beyond one page when nothing is new', async () => {
    const { user, channel } = await connectedChannel();
    const original = ids(10);
    googleServer.use(...youtubeCatalog(original, catalogFor(original)));
    await syncChannelVideos({
      userId: user.id,
      channelId: channel.id,
      mode: 'full',
      trigger: 'schedule',
    });
    resetGoogle();

    googleServer.use(...youtubeCatalog(original, catalogFor(original)));
    await syncChannelVideos({
      userId: user.id,
      channelId: channel.id,
      mode: 'delta',
      trigger: 'schedule',
    });
    expect(callsTo(PLAYLIST_URL)).toHaveLength(1);
    expect(callsTo(VIDEOS_URL)).toHaveLength(0);
  });
});

describe('failures mid-sync', () => {
  it('keeps pages already stored when quota runs out, and infers no deletions', async () => {
    const { user, channel } = await connectedChannel();
    const playlist = ids(120);
    googleServer.use(...youtubeCatalog(playlist, catalogFor(playlist)));
    // Leave room for exactly one page: playlist + videos = 2 units.
    await testPrisma.apiQuotaLedger.create({
      data: {
        api: 'YOUTUBE_DATA',
        day: new Date(`${quotaDayKey(new Date())}T00:00:00Z`),
        unitsUsed: 9_998n,
      },
    });

    await expect(
      syncChannelVideos({
        userId: user.id,
        channelId: channel.id,
        mode: 'full',
        trigger: 'connect',
      }),
    ).rejects.toMatchObject({ code: 'YOUTUBE_QUOTA_EXCEEDED' });

    expect(await testPrisma.youTubeVideo.count()).toBe(50);
    expect(
      await testPrisma.youTubeVideo.count({ where: { deletedFromYouTubeAt: { not: null } } }),
    ).toBe(0);
    const job = await testPrisma.syncJob.findFirstOrThrow({ where: { channelId: channel.id } });
    expect(job).toMatchObject({
      status: 'FAILED',
      errorCode: 'YOUTUBE_QUOTA_EXCEEDED',
      itemsProcessed: 50,
    });
    // Never fully synced: it waits in the queue rather than showing an error.
    const after = await testPrisma.youTubeChannel.findUniqueOrThrow({ where: { id: channel.id } });
    expect(after.syncStatus).toBe('QUEUED');
    expect(after.lastFullSyncAt).toBeNull();
  });

  it('pauses the channel when YouTube rejects the token', async () => {
    const { user, channel } = await connectedChannel();
    googleServer.use(
      http.get(PLAYLIST_URL, () => HttpResponse.json({ error: { code: 401 } }, { status: 401 })),
    );

    await expect(
      syncChannelVideos({
        userId: user.id,
        channelId: channel.id,
        mode: 'full',
        trigger: 'schedule',
      }),
    ).rejects.toMatchObject({ code: 'YOUTUBE_REAUTH_REQUIRED' });
    const after = await testPrisma.youTubeChannel.findUniqueOrThrow({ where: { id: channel.id } });
    expect(after.syncStatus).toBe('PAUSED');
  });

  it('marks a channel FAILED on a transient error, so the retry has a visible state', async () => {
    const { user, channel } = await connectedChannel();
    googleServer.use(http.get(PLAYLIST_URL, () => HttpResponse.json({}, { status: 503 })));

    await expect(
      syncChannelVideos({
        userId: user.id,
        channelId: channel.id,
        mode: 'full',
        trigger: 'schedule',
      }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(
      (await testPrisma.youTubeChannel.findUniqueOrThrow({ where: { id: channel.id } })).syncStatus,
    ).toBe('FAILED');
  });

  it('refuses another user’s channel before touching YouTube', async () => {
    const { channel } = await connectedChannel();
    const stranger = await createTestUser();
    await expect(
      syncChannelVideos({
        userId: stranger.id,
        channelId: channel.id,
        mode: 'full',
        trigger: 'schedule',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(callsTo(PLAYLIST_URL)).toHaveLength(0);
  });
});

describe('statistics refresh', () => {
  async function syncedChannel(videoCount: number) {
    const context = await connectedChannel();
    const playlist = ids(videoCount);
    const catalog = playlist.map((id, index) =>
      videoItem(id, {
        // Newest first, one day apart; the oldest are years old.
        publishedAt: new Date(Date.now() - index * 30 * 86_400_000).toISOString(),
        views: index === videoCount - 1 ? 9_999_999 : 100 + index,
      }),
    );
    googleServer.use(...youtubeCatalog(playlist, catalog));
    await syncChannelVideos({
      userId: context.user.id,
      channelId: context.channel.id,
      mode: 'full',
      trigger: 'schedule',
    });
    return { ...context, playlist };
  }

  it('refreshes only videos that are due, per tier', async () => {
    const { user, channel } = await syncedChannel(20);
    // Everything was just fetched — nothing is due.
    const fresh = await refreshVideoStats({
      userId: user.id,
      channelId: channel.id,
      trigger: 'schedule',
    });
    expect(fresh.result.due).toBe(0);
    expect(fresh.quotaUnitsUsed).toBe(0);

    // Age all stats by 2 days: HOT (daily) are due; WARM (3 days) and COLD are not.
    await testPrisma.youTubeVideo.updateMany({
      where: { channelId: channel.id },
      data: { lastStatsSyncAt: new Date(Date.now() - 2 * 86_400_000) },
    });
    const outcome = await refreshVideoStats({
      userId: user.id,
      channelId: channel.id,
      trigger: 'schedule',
    });
    const hot = await testPrisma.youTubeVideo.count({
      where: { channelId: channel.id, syncTier: 'HOT' },
    });
    expect(outcome.result.due).toBe(hot);
    expect(outcome.result.due).toBeLessThan(20);
  });

  it('keeps an old top performer HOT', async () => {
    const { user, channel, playlist } = await syncedChannel(20);
    await refreshVideoStats({ userId: user.id, channelId: channel.id, trigger: 'schedule' });

    // The oldest video (≈19 × 30 days old) has by far the most views.
    const evergreen = await testPrisma.youTubeVideo.findUniqueOrThrow({
      where: { youtubeVideoId: playlist.at(-1) as string },
    });
    expect(evergreen.syncTier).toBe('HOT');
  });

  it('refreshes channel counters and picks up a renamed channel', async () => {
    const { user, channel } = await connectedChannel();
    googleServer.use(
      google.channels([{ ...channelItem({ id: channel.youtubeChannelId, title: 'Renamed' }) }]),
    );

    await refreshChannelStats({ userId: user.id, channelId: channel.id, trigger: 'schedule' });
    const after = await testPrisma.youTubeChannel.findUniqueOrThrow({
      where: { id: channel.id },
      include: { statsSnapshots: true },
    });
    expect(after.title).toBe('Renamed');
    expect(after.statsSnapshots).toHaveLength(1);
    expect(after.lastStatsSyncAt).not.toBeNull();
  });

  it('asks for a reconnect when the grant no longer reaches the channel', async () => {
    const { user, channel } = await connectedChannel();
    googleServer.use(google.channels([channelItem({ id: 'UC_someone_else' })]));
    await expect(
      refreshChannelStats({ userId: user.id, channelId: channel.id, trigger: 'schedule' }),
    ).rejects.toMatchObject({ code: 'YOUTUBE_REAUTH_REQUIRED' });
  });
});

describe('scheduling', () => {
  it('queues the right jobs for a never-synced channel', async () => {
    const { channel } = await connectedChannel();
    const tick = await scheduleDueSyncs();

    expect(tick).toMatchObject({ considered: 1, deferredForQuota: false });
    expect(recordingQueue.jobs.map((job) => job.name).sort()).toEqual([
      'channel.analytics',
      'channel.stats',
      'channel.video-stats',
      'channel.videos',
    ]);
    expect(
      recordingQueue.jobs.every(
        (job) => (job.payload as { channelId: string }).channelId === channel.id,
      ),
    ).toBe(true);
  });

  it('skips channels whose grant needs a reconnect', async () => {
    const { channel } = await connectedChannel();
    await testPrisma.youTubeConnection.update({
      where: { id: channel.connectionId },
      data: { status: 'REAUTH_REQUIRED' },
    });
    expect((await scheduleDueSyncs()).considered).toBe(0);
  });

  it('defers ALL scheduled work once the day passes 80% of quota', async () => {
    await connectedChannel();
    await testPrisma.apiQuotaLedger.create({
      data: {
        api: 'YOUTUBE_DATA',
        day: new Date(`${quotaDayKey(new Date())}T00:00:00Z`),
        unitsUsed: 8_000n,
      },
    });

    const tick = await scheduleDueSyncs();
    expect(tick.deferredForQuota).toBe(true);
    expect(recordingQueue.jobs).toHaveLength(0);
  });

  it('queues one manual refresh per channel per hour', async () => {
    const { user, channel } = await connectedChannel();

    await requestManualSync({ userId: user.id, channelId: channel.id });
    expect(recordingQueue.jobs).toHaveLength(4);
    expect(
      (await testPrisma.youTubeChannel.findUniqueOrThrow({ where: { id: channel.id } })).syncStatus,
    ).toBe('QUEUED');

    await expect(
      requestManualSync({ userId: user.id, channelId: channel.id }),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('refuses a manual refresh of someone else’s channel', async () => {
    const { channel } = await connectedChannel();
    const stranger = await createTestUser();
    await expect(
      requestManualSync({ userId: stranger.id, channelId: channel.id }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(recordingQueue.jobs).toHaveLength(0);
  });
});

describe('worker processor', () => {
  it('runs a job end to end', async () => {
    const { user, channel } = await connectedChannel();
    googleServer.use(...youtubeCatalog(ids(3), catalogFor(ids(3))));

    const result = await processJob(
      'channel.videos',
      { userId: user.id, channelId: channel.id, mode: 'full', trigger: 'schedule' },
      1,
      logger,
    );
    expect(result).toMatchObject({ created: 3 });
  });

  // Regression: channel.stats returned a BigInt subscriber count; BullMQ's
  // JSON.stringify of the result threw AFTER the snapshot was written, so a
  // successful job was marked failed and retried.
  it('returns a result the queue can store as JSON (channel.stats)', async () => {
    const { user, channel } = await connectedChannel();
    googleServer.use(google.channels([channelItem({ id: channel.youtubeChannelId })]));

    const result = await processJob(
      'channel.stats',
      { userId: user.id, channelId: channel.id, trigger: 'schedule' },
      1,
      logger,
    );
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(result).toMatchObject({ subscriberCount: expect.any(Number) });
  });

  it('makes any job result JSON-safe, turning BigInt into a string', () => {
    const safe = toJobResult({ views: 12n, nested: [{ likes: 3n }], ok: true });
    expect(JSON.stringify(safe)).toBe('{"views":"12","nested":[{"likes":"3"}],"ok":true}');
    expect(toJobResult(undefined)).toBeUndefined();
  });

  it('does not retry permanent failures', async () => {
    const { user, channel } = await connectedChannel();
    googleServer.use(http.get(PLAYLIST_URL, () => HttpResponse.json({}, { status: 401 })));

    await expect(
      processJob(
        'channel.videos',
        { userId: user.id, channelId: channel.id, mode: 'full', trigger: 'schedule' },
        1,
        logger,
      ),
    ).rejects.toHaveProperty('name', 'UnrecoverableError');
  });

  it('lets transient failures retry', async () => {
    const { user, channel } = await connectedChannel();
    googleServer.use(http.get(PLAYLIST_URL, () => HttpResponse.json({}, { status: 503 })));

    await expect(
      processJob(
        'channel.videos',
        { userId: user.id, channelId: channel.id, mode: 'full', trigger: 'schedule' },
        1,
        logger,
      ),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });

  it('treats an unreadable token as permanent, without disconnecting the user', async () => {
    const { user, channel } = await connectedChannel();
    clearAccessTokenCache(); // force a refresh, which must decrypt
    await testPrisma.youTubeConnection.update({
      where: { id: channel.connectionId },
      data: { encryptedRefreshToken: 'bm90LXZhbGlkLWNpcGhlcnRleHQtYXQtYWxs' },
    });

    await expect(
      processJob(
        'channel.stats',
        { userId: user.id, channelId: channel.id, trigger: 'schedule' },
        1,
        logger,
      ),
    ).rejects.toHaveProperty('name', 'UnrecoverableError');
    const connection = await testPrisma.youTubeConnection.findUniqueOrThrow({
      where: { id: channel.connectionId },
    });
    expect(connection.status).toBe('ACTIVE');
  });

  it('rejects unknown jobs and malformed payloads without retrying', async () => {
    await expect(processJob('no.such.job', {}, 1, logger)).rejects.toHaveProperty(
      'name',
      'UnrecoverableError',
    );
    await expect(
      processJob('channel.videos', { channelId: 'x' }, 1, logger),
    ).rejects.toHaveProperty('name', 'UnrecoverableError');
  });
});

describe('connect → first sync', () => {
  it('queues a full backfill for the new channel', async () => {
    const user = await createTestUser();
    const { startChannelConnect } = await import('@/modules/youtube/start-channel-connect');
    const { completeChannelConnect } = await import('@/modules/youtube/complete-channel-connect');
    const started = await startChannelConnect({ userId: user.id, email: user.email });
    if (!started.ok) throw started.error;
    const state = new URL(started.data.authorizationUrl).searchParams.get('state') ?? '';
    googleServer.use(google.tokenExchange(), google.channels([channelItem()]));

    const result = await completeChannelConnect({ sessionUserId: user.id, code: 'c', state });
    if (!result.ok) throw result.error;

    expect(recordingQueue.jobs).toEqual([
      expect.objectContaining({
        name: 'channel.videos',
        payload: expect.objectContaining({ mode: 'full', trigger: 'connect' }),
      }),
      // Analytics waits so the video backfill can land first.
      expect.objectContaining({
        name: 'channel.analytics',
        payload: expect.objectContaining({ trigger: 'connect' }),
        delayMs: 10 * 60 * 1000,
      }),
    ]);
    const channel = await testPrisma.youTubeChannel.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(channel.syncStatus).toBe('QUEUED');
  });
});
