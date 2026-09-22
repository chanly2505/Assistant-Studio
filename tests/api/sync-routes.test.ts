import { randomBytes } from 'node:crypto';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryRateLimiter, setRateLimiter } from '@/lib/api/rate-limit';
import { SESSION_COOKIE_NAME } from '@/lib/auth/cookies';

import {
  createTestChannel,
  createTestUser,
  disconnectDatabase,
  resetDatabase,
  testPrisma,
} from '../helpers/db';
import { recordingQueue } from '../helpers/queue';

const APP = 'http://localhost:3000';
const videosRoute = async () =>
  (await import('@/app/api/v1/channels/[channelId]/videos/route')).GET;
const syncRoute = async () => (await import('@/app/api/v1/channels/[channelId]/sync/route')).POST;

beforeEach(async () => {
  await resetDatabase();
  setRateLimiter(new InMemoryRateLimiter());
});
afterAll(async () => {
  await disconnectDatabase();
});

async function signedInWithChannel(videoCount = 0) {
  const user = await createTestUser();
  const token = randomBytes(32).toString('hex');
  await testPrisma.session.create({
    data: { sessionToken: token, userId: user.id, expires: new Date(Date.now() + 3_600_000) },
  });
  const channel = await createTestChannel(user.id);
  for (let i = 0; i < videoCount; i += 1) {
    const video = await testPrisma.youTubeVideo.create({
      data: {
        channelId: channel.id,
        youtubeVideoId: `${channel.id}-v${i}`,
        title: `Video ${i}`,
        // Two videos share each timestamp, so the cursor's id tie-break matters.
        publishedAt: new Date(Date.UTC(2026, 8, 1 + Math.floor(i / 2))),
        durationSeconds: 90 + i,
      },
    });
    await testPrisma.videoStatsSnapshot.create({
      data: { videoId: video.id, viewCount: BigInt(1000 + i), likeCount: null, commentCount: 3n },
    });
  }
  return { user, channel, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

const get = (url: string, cookie?: string) =>
  new Request(url, { headers: cookie ? { cookie } : {} });

describe('GET /api/v1/channels/:id/videos', () => {
  it('pages through every video exactly once, newest first', async () => {
    const { channel, cookie } = await signedInWithChannel(25);
    const handler = await videosRoute();

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url = `${APP}/api/v1/channels/${channel.id}/videos?limit=10${cursor ? `&cursor=${cursor}` : ''}`;
      const response = await handler(get(url, cookie), {
        params: Promise.resolve({ channelId: channel.id }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      seen.push(...body.data.videos.map((v: { youtubeVideoId: string }) => v.youtubeVideoId));
      cursor = body.data.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25); // no duplicates across page boundaries
  });

  it('returns BigInt statistics as strings and hidden likes as null', async () => {
    const { channel, cookie } = await signedInWithChannel(1);
    const response = await (
      await videosRoute()
    )(get(`${APP}/api/v1/channels/${channel.id}/videos`, cookie), {
      params: Promise.resolve({ channelId: channel.id }),
    });
    const video = (await response.json()).data.videos[0];
    expect(video.stats).toMatchObject({ viewCount: '1000', likeCount: null, commentCount: '3' });
    expect(video.isShortForm).toBe(false);
  });

  it('answers 404 for another user’s channel', async () => {
    const { channel } = await signedInWithChannel(3);
    const { cookie: strangerCookie } = await signedInWithChannel(0);
    const response = await (
      await videosRoute()
    )(get(`${APP}/api/v1/channels/${channel.id}/videos`, strangerCookie), {
      params: Promise.resolve({ channelId: channel.id }),
    });
    expect(response.status).toBe(404);
  });

  it('rejects a forged cursor with 422', async () => {
    const { channel, cookie } = await signedInWithChannel(3);
    const response = await (
      await videosRoute()
    )(get(`${APP}/api/v1/channels/${channel.id}/videos?cursor=forged`, cookie), {
      params: Promise.resolve({ channelId: channel.id }),
    });
    expect(response.status).toBe(422);
  });

  it('requires a session', async () => {
    const { channel } = await signedInWithChannel(1);
    const response = await (
      await videosRoute()
    )(get(`${APP}/api/v1/channels/${channel.id}/videos`), {
      params: Promise.resolve({ channelId: channel.id }),
    });
    expect(response.status).toBe(401);
  });
});

describe('POST /api/v1/channels/:id/sync', () => {
  const post = (url: string, cookie: string) =>
    new Request(url, { method: 'POST', headers: { cookie, origin: APP } });

  it('queues a refresh and answers 202', async () => {
    const { channel, cookie } = await signedInWithChannel();
    const response = await (
      await syncRoute()
    )(post(`${APP}/api/v1/channels/${channel.id}/sync`, cookie), {
      params: Promise.resolve({ channelId: channel.id }),
    });

    expect(response.status).toBe(202);
    expect(recordingQueue.jobs.map((job) => job.name).sort()).toEqual([
      'channel.analytics',
      'channel.stats',
      'channel.video-stats',
      'channel.videos',
    ]);
  });

  it('allows one refresh per channel per hour', async () => {
    const { channel, cookie } = await signedInWithChannel();
    const handler = await syncRoute();
    const args = { params: Promise.resolve({ channelId: channel.id }) };

    await handler(post(`${APP}/api/v1/channels/${channel.id}/sync`, cookie), args);
    const second = await handler(post(`${APP}/api/v1/channels/${channel.id}/sync`, cookie), {
      params: Promise.resolve({ channelId: channel.id }),
    });

    expect(second.status).toBe(429);
    expect(Number(second.headers.get('Retry-After'))).toBeGreaterThan(3000);
  });

  it('answers 404 for another user’s channel and queues nothing', async () => {
    const { channel } = await signedInWithChannel();
    const { cookie: strangerCookie } = await signedInWithChannel();
    const response = await (
      await syncRoute()
    )(post(`${APP}/api/v1/channels/${channel.id}/sync`, strangerCookie), {
      params: Promise.resolve({ channelId: channel.id }),
    });
    expect(response.status).toBe(404);
    expect(recordingQueue.jobs).toHaveLength(0);
  });
});

describe('GET /api/v1/channels/:id/analytics', () => {
  const analyticsRoute = async () =>
    (await import('@/app/api/v1/channels/[channelId]/analytics/route')).GET;

  it('returns the period, series and totals for the owner', async () => {
    const { channel, cookie } = await signedInWithChannel();
    for (let i = 0; i < 10; i += 1) {
      await testPrisma.channelAnalyticsDaily.create({
        data: {
          channelId: channel.id,
          date: new Date(Date.UTC(2026, 8, 1 + i)),
          views: 100n,
          estimatedMinutesWatched: 50n,
          isProvisional: false,
        },
      });
    }
    await testPrisma.youTubeChannel.update({
      where: { id: channel.id },
      data: { lastAnalyticsDate: new Date(Date.UTC(2026, 8, 10)) },
    });

    const response = await (
      await analyticsRoute()
    )(get(`${APP}/api/v1/channels/${channel.id}/analytics?period=7`, cookie), {
      params: Promise.resolve({ channelId: channel.id }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()).data;
    expect(body.period).toMatchObject({ days: 7, from: '2026-09-04', to: '2026-09-10' });
    expect(body.series).toHaveLength(7);
    expect(body.totals.views).toBe(700);
  });

  it('rejects a period outside 7 / 28 / 90 / 365', async () => {
    const { channel, cookie } = await signedInWithChannel();
    const response = await (
      await analyticsRoute()
    )(get(`${APP}/api/v1/channels/${channel.id}/analytics?period=5000`, cookie), {
      params: Promise.resolve({ channelId: channel.id }),
    });
    expect(response.status).toBe(422);
  });

  it('answers 404 for another user’s channel', async () => {
    const { channel } = await signedInWithChannel();
    const { cookie: strangerCookie } = await signedInWithChannel();
    const response = await (
      await analyticsRoute()
    )(get(`${APP}/api/v1/channels/${channel.id}/analytics`, strangerCookie), {
      params: Promise.resolve({ channelId: channel.id }),
    });
    expect(response.status).toBe(404);
  });
});
