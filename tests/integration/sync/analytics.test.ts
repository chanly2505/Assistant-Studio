import { randomBytes } from 'node:crypto';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SecretString } from '@/domain/shared/secret';
import { addDays, daysBetween, eachDay } from '@/domain/youtube/analytics';
import { quotaDayKey } from '@/domain/youtube/quota';
import { getChannelAnalytics } from '@/modules/analytics/get-channel-analytics';
import { MAX_VIDEO_SERIES, syncAnalytics } from '@/modules/sync/sync-analytics';
import { scheduleDueSyncs } from '@/modules/sync/schedule';
import { clearAccessTokenCache, primeAccessToken } from '@/modules/youtube/access-token';
import { getTokenVault } from '@/services/crypto';

import { createTestUser, disconnectDatabase, resetDatabase, testPrisma } from '../../helpers/db';
import {
  ANALYTICS_URL,
  analyticsError,
  callsTo,
  googleServer,
  resetGoogle,
  youtubeAnalytics,
  type FakeDay,
} from '../../helpers/google';
import { recordingQueue } from '../../helpers/queue';

const today = () => quotaDayKey(new Date());

beforeAll(() => googleServer.listen({ onUnhandledRequest: 'error' }));
beforeEach(async () => {
  await resetDatabase();
  await testPrisma.plan.createMany({
    data: [
      {
        key: 'free',
        name: 'Free',
        maxChannels: 1,
        monthlyGenerations: {},
        features: { analyticsHistoryDays: 90 },
      },
      {
        key: 'creator',
        name: 'Creator',
        maxChannels: 3,
        monthlyGenerations: {},
        features: { analyticsHistoryDays: 365 },
      },
    ],
    skipDuplicates: true,
  });
  clearAccessTokenCache();
});
afterEach(() => resetGoogle());
afterAll(async () => {
  googleServer.close();
  await disconnectDatabase();
});

async function connectedChannel(planKey = 'creator') {
  const user = await createTestUser({ planKey });
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
      title: 'C',
      uploadsPlaylistId: `UU_${id}`,
    },
  });
  primeAccessToken(id, new SecretString('ya29.warm'), 3600);
  return { user, channel };
}

/** `n` consecutive days ending `endOffset` days before today. */
function days(n: number, endOffset = 3, views = 100): FakeDay[] {
  const end = addDays(today(), -endOffset);
  return eachDay(addDays(end, -(n - 1)), end).map((day, i) => ({
    day,
    views: views + i,
    minutes: (views + i) * 2,
    gained: 3,
    lost: 1,
  }));
}

describe('syncAnalytics — channel series', () => {
  it('backfills a year in ONE request and stores every returned day', async () => {
    const { user, channel } = await connectedChannel();
    googleServer.use(youtubeAnalytics(days(400)));

    const outcome = await syncAnalytics({
      userId: user.id,
      channelId: channel.id,
      trigger: 'connect',
    });

    const requests = callsTo(ANALYTICS_URL);
    expect(requests).toHaveLength(1);
    const query = requests[0]?.query;
    expect(query?.get('ids')).toBe(`channel==${channel.youtubeChannelId}`);
    expect(query?.get('dimensions')).toBe('day');
    expect(daysBetween(query?.get('startDate') ?? '', query?.get('endDate') ?? '')).toBe(364);
    // The fake returns 400 days, but only those inside the window are stored.
    expect(outcome.result.channelDays).toBe(362);
    expect(await testPrisma.channelAnalyticsDaily.count()).toBe(362);

    const after = await testPrisma.youTubeChannel.findUniqueOrThrow({ where: { id: channel.id } });
    expect(after.lastAnalyticsDate?.toISOString().slice(0, 10)).toBe(addDays(today(), -3));
  });

  it('counts requests against the ANALYTICS budget, not the Data API quota', async () => {
    const { user, channel } = await connectedChannel();
    googleServer.use(youtubeAnalytics(days(10)));
    await syncAnalytics({ userId: user.id, channelId: channel.id, trigger: 'schedule' });

    const ledger = await testPrisma.apiQuotaLedger.findMany();
    expect(ledger.map((row) => row.api)).toEqual(['YOUTUBE_ANALYTICS']);
    expect(ledger[0]?.unitsUsed).toBe(1n);
  });

  it('re-fetches the trailing week and overwrites revised figures — no duplicates', async () => {
    const { user, channel } = await connectedChannel();
    const first = days(10, 1);
    googleServer.use(youtubeAnalytics(first));
    await syncAnalytics({ userId: user.id, channelId: channel.id, trigger: 'schedule' });
    resetGoogle();

    // YouTube revises the most recent day upward once processing finishes.
    const revised = first.map((d, i) => (i === first.length - 1 ? { ...d, views: 9_999 } : d));
    googleServer.use(youtubeAnalytics(revised));
    await syncAnalytics({ userId: user.id, channelId: channel.id, trigger: 'schedule' });

    expect(await testPrisma.channelAnalyticsDaily.count()).toBe(10);
    const last = await testPrisma.channelAnalyticsDaily.findFirstOrThrow({
      orderBy: { date: 'desc' },
    });
    expect(last.views).toBe(9_999n);
    // The second request started at most 7 days back, not a year.
    const second = callsTo(ANALYTICS_URL)[0]?.query;
    expect(
      daysBetween(second?.get('startDate') ?? '', second?.get('endDate') ?? ''),
    ).toBeLessThanOrEqual(9);
  });

  it('marks recent days provisional and older days final', async () => {
    const { user, channel } = await connectedChannel();
    googleServer.use(youtubeAnalytics(days(6, 0)));
    await syncAnalytics({ userId: user.id, channelId: channel.id, trigger: 'schedule' });

    const rows = await testPrisma.channelAnalyticsDaily.findMany({ orderBy: { date: 'asc' } });
    expect(rows.map((row) => row.isProvisional)).toEqual([false, false, false, true, true, true]);
  });

  it('writes nothing for days YouTube did not return — no invented zeros', async () => {
    const { user, channel } = await connectedChannel();
    const withGap = days(10).filter((_, i) => i !== 4);
    googleServer.use(youtubeAnalytics(withGap));
    await syncAnalytics({ userId: user.id, channelId: channel.id, trigger: 'schedule' });

    expect(await testPrisma.channelAnalyticsDaily.count()).toBe(9);
  });

  it('succeeds with zero rows for a channel YouTube has no data for yet', async () => {
    const { user, channel } = await connectedChannel();
    googleServer.use(youtubeAnalytics([]));
    const outcome = await syncAnalytics({
      userId: user.id,
      channelId: channel.id,
      trigger: 'connect',
    });
    expect(outcome.result).toMatchObject({ channelDays: 0, latestDay: null });
  });

  it('reads values by column NAME, surviving a reordered response', async () => {
    const { user, channel } = await connectedChannel();
    googleServer.use(youtubeAnalytics(days(3), { reverseColumns: true }));
    await syncAnalytics({ userId: user.id, channelId: channel.id, trigger: 'schedule' });

    const row = await testPrisma.channelAnalyticsDaily.findFirstOrThrow({
      orderBy: { date: 'asc' },
    });
    expect(row).toMatchObject({ views: 100n, estimatedMinutesWatched: 200n, subscribersGained: 3 });
  });

  it('maps a missing analytics permission to INSUFFICIENT_SCOPE', async () => {
    const { user, channel } = await connectedChannel();
    googleServer.use(analyticsError(403, 'insufficientPermissions'));
    await expect(
      syncAnalytics({ userId: user.id, channelId: channel.id, trigger: 'schedule' }),
    ).rejects.toMatchObject({ code: 'YOUTUBE_INSUFFICIENT_SCOPE' });
  });

  it('stops at our own daily request budget', async () => {
    const { user, channel } = await connectedChannel();
    googleServer.use(youtubeAnalytics(days(3)));
    await testPrisma.apiQuotaLedger.create({
      data: { api: 'YOUTUBE_ANALYTICS', day: new Date(`${today()}T00:00:00Z`), unitsUsed: 2_000n },
    });

    await expect(
      syncAnalytics({ userId: user.id, channelId: channel.id, trigger: 'manual' }),
    ).rejects.toMatchObject({ code: 'YOUTUBE_QUOTA_EXCEEDED' });
    expect(callsTo(ANALYTICS_URL)).toHaveLength(0);
  });
});

describe('syncAnalytics — video series', () => {
  async function withVideos(channelId: string, hot: number, cold: number) {
    const make = (i: number, tier: 'HOT' | 'COLD') =>
      testPrisma.youTubeVideo.create({
        data: {
          channelId,
          youtubeVideoId: `${tier}-${i}-${channelId}`,
          title: `${tier} ${i}`,
          publishedAt: new Date(Date.now() - (tier === 'HOT' ? i + 1 : 400 + i) * 86_400_000),
          durationSeconds: 300,
          syncTier: tier,
        },
      });
    for (let i = 0; i < hot; i += 1) await make(i, 'HOT');
    for (let i = 0; i < cold; i += 1) await make(i, 'COLD');
  }

  it('fetches a daily series only for HOT videos, one filtered request each', async () => {
    const { user, channel } = await connectedChannel();
    await withVideos(channel.id, 3, 5);
    googleServer.use(
      youtubeAnalytics(days(5), {
        // Days after each video was published (they are 1–3 days old). The sync
        // only asks for days since publication, so earlier days would not match.
        byVideo: Object.fromEntries(
          [0, 1, 2].map((i) => [`HOT-${i}-${channel.id}`, days(2, 0, 10)]),
        ),
      }),
    );

    const outcome = await syncAnalytics({
      userId: user.id,
      channelId: channel.id,
      trigger: 'schedule',
    });

    const filters = callsTo(ANALYTICS_URL)
      .map((call) => call.query.get('filters'))
      .filter(Boolean);
    expect(filters).toHaveLength(3);
    expect(filters.every((filter) => filter?.startsWith('video==HOT-'))).toBe(true);
    expect(outcome.result).toMatchObject({ videosTracked: 3, videoDays: 6 });
    // 1 channel request + 3 video requests.
    expect(outcome.quotaUnitsUsed).toBe(4);
  });

  it('keeps an evening (Pacific) upload’s first day — regression', async () => {
    // Uploaded 23:30 Pacific yesterday = 06:30 UTC TODAY. Working out the
    // publication day in UTC started the window a day late and silently
    // dropped the video's first day of data.
    const { user, channel } = await connectedChannel();
    const yesterday = addDays(today(), -1);
    const publishedAt = new Date(`${yesterday}T23:30:00-07:00`);
    expect(publishedAt.toISOString().slice(0, 10)).toBe(today()); // the trap

    await testPrisma.youTubeVideo.create({
      data: {
        channelId: channel.id,
        youtubeVideoId: 'evening-upload',
        title: 'Evening upload',
        publishedAt,
        durationSeconds: 300,
        syncTier: 'HOT',
      },
    });
    googleServer.use(
      youtubeAnalytics([], {
        byVideo: {
          'evening-upload': [
            { day: yesterday, views: 40 },
            { day: today(), views: 10 },
          ],
        },
      }),
    );

    const outcome = await syncAnalytics({
      userId: user.id,
      channelId: channel.id,
      trigger: 'schedule',
    });
    expect(outcome.result.videoDays).toBe(2);
  });

  it('caps per-video requests per run', async () => {
    const { user, channel } = await connectedChannel();
    await withVideos(channel.id, MAX_VIDEO_SERIES + 5, 0);
    googleServer.use(youtubeAnalytics(days(2)));

    const outcome = await syncAnalytics({
      userId: user.id,
      channelId: channel.id,
      trigger: 'schedule',
    });
    expect(outcome.result.videosTracked).toBe(MAX_VIDEO_SERIES);
    expect(callsTo(ANALYTICS_URL)).toHaveLength(MAX_VIDEO_SERIES + 1);
  });
});

describe('getChannelAnalytics', () => {
  async function synced(planKey = 'creator', series = days(60)) {
    const context = await connectedChannel(planKey);
    googleServer.use(youtubeAnalytics(series));
    await syncAnalytics({
      userId: context.user.id,
      channelId: context.channel.id,
      trigger: 'schedule',
    });
    return context;
  }

  it('anchors the period on the latest day with data, not on today', async () => {
    const { user, channel } = await synced();
    const result = await getChannelAnalytics({
      userId: user.id,
      channelId: channel.id,
      periodDays: 28,
    });
    if (!result.ok) throw result.error;

    expect(result.data.period.to).toBe(addDays(today(), -3));
    expect(result.data.series).toHaveLength(28);
    expect(result.data.series.every((p) => p.views !== null)).toBe(true);
  });

  it('shows missing days as null, never as zero', async () => {
    const series = days(28).filter((_, i) => i !== 10);
    const { user, channel } = await synced('creator', series);
    const result = await getChannelAnalytics({
      userId: user.id,
      channelId: channel.id,
      periodDays: 28,
    });
    if (!result.ok) throw result.error;

    expect(result.data.series.filter((p) => p.views === null)).toHaveLength(1);
    expect(result.data.totals.daysWithData).toBe(27);
  });

  it('compares with the previous period only when there is enough earlier data', async () => {
    const { user, channel } = await synced('creator', days(56));
    const full = await getChannelAnalytics({
      userId: user.id,
      channelId: channel.id,
      periodDays: 28,
    });
    if (!full.ok) throw full.error;
    expect(full.data.change.views).not.toBeNull();
    // Net subscribers change is an absolute difference: 28×2 − 28×2 = 0.
    expect(full.data.change.netSubscribersDelta).toBe(0);

    const { user: u2, channel: c2 } = await synced('creator', days(30));
    const thin = await getChannelAnalytics({ userId: u2.id, channelId: c2.id, periodDays: 28 });
    if (!thin.ok) throw thin.error;
    expect(thin.data.change.views).toBeNull();
  });

  it('limits history to the plan (free: 90 days)', async () => {
    const { user, channel } = await synced('free', days(200));
    const result = await getChannelAnalytics({
      userId: user.id,
      channelId: channel.id,
      periodDays: 365,
    });
    if (!result.ok) throw result.error;
    expect(result.data.period).toMatchObject({ days: 90, requestedDays: 365, limitedByPlan: true });
    expect(result.data.series).toHaveLength(90);
  });

  it('answers NOT_FOUND for another user’s channel', async () => {
    const { channel } = await synced();
    const stranger = await createTestUser();
    const result = await getChannelAnalytics({
      userId: stranger.id,
      channelId: channel.id,
      periodDays: 28,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
  });

  it('reports the latest FINAL day separately from provisional ones', async () => {
    const context = await connectedChannel();
    googleServer.use(youtubeAnalytics(days(10, 0)));
    await syncAnalytics({
      userId: context.user.id,
      channelId: context.channel.id,
      trigger: 'schedule',
    });

    const result = await getChannelAnalytics({
      userId: context.user.id,
      channelId: context.channel.id,
      periodDays: 7,
    });
    if (!result.ok) throw result.error;
    expect(result.data.dataThrough).toBe(addDays(today(), -3));
    expect(result.data.series.filter((p) => p.provisional)).toHaveLength(3);
  });
});

describe('scheduling analytics', () => {
  it('plans a daily analytics run', async () => {
    await connectedChannel();
    await scheduleDueSyncs();
    expect(recordingQueue.jobs.map((job) => job.name)).toContain('channel.analytics');
  });

  it('defers ONLY analytics once its own budget passes 80%', async () => {
    await connectedChannel();
    await testPrisma.apiQuotaLedger.create({
      data: { api: 'YOUTUBE_ANALYTICS', day: new Date(`${today()}T00:00:00Z`), unitsUsed: 1_600n },
    });

    await scheduleDueSyncs();
    const names = recordingQueue.jobs.map((job) => job.name);
    expect(names).not.toContain('channel.analytics');
    expect(names).toContain('channel.videos');
  });
});
