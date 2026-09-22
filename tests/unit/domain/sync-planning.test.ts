import { describe, expect, it } from 'vitest';

import { SHORT_FORM_MAX_SECONDS, isShortForm, parseIsoDuration } from '@/domain/youtube/duration';
import { decodeCursor, encodeCursor } from '@/modules/videos/list-videos';
import { SCHEDULE, jitterMs, planChannel } from '@/modules/sync/schedule';
import { toVideoRecord } from '@/services/youtube/mappers';
import { jobIdFor } from '@/services/queue/jobs';

import { videoItem } from '../../helpers/google';

describe('parseIsoDuration', () => {
  it.each([
    ['PT8M30S', 510],
    ['PT1H2M3S', 3723],
    ['PT45S', 45],
    ['PT2H', 7200],
    ['P1DT2H', 93_600],
    ['P1W', 604_800],
    ['PT0S', 0],
    ['P0D', 0],
    ['PT1.6S', 2],
  ])('%s is %i seconds', (value, seconds) => {
    expect(parseIsoDuration(value)).toBe(seconds);
  });

  it.each([null, undefined, '', 'P', 'PT', '8:30', 'PT8M30', 'garbage'])(
    'rejects %j instead of inventing a length',
    (value) => {
      expect(parseIsoDuration(value)).toBeNull();
    },
  );
});

describe('isShortForm — a length heuristic, not a Shorts flag', () => {
  it('uses YouTube’s 3-minute Shorts limit', () => {
    expect(SHORT_FORM_MAX_SECONDS).toBe(180);
    expect(isShortForm(180)).toBe(true);
    expect(isShortForm(181)).toBe(false);
    expect(isShortForm(15)).toBe(true);
  });

  it('does not call a live or upcoming stream (duration 0) short-form', () => {
    expect(isShortForm(0)).toBe(false);
  });
});

describe('toVideoRecord', () => {
  const now = new Date('2026-09-21T12:00:00Z');

  it('maps YouTube’s shape to ours', () => {
    const { video, stats } = toVideoRecord(
      videoItem('v1', {
        duration: 'PT2M',
        privacy: 'unlisted',
        views: 1234,
        publishedAt: '2026-09-10T00:00:00Z',
      }) as never,
      now,
    );
    expect(video).toMatchObject({
      youtubeVideoId: 'v1',
      durationSeconds: 120,
      privacyStatus: 'UNLISTED',
      isShortForm: true,
      syncTier: 'HOT',
    });
    expect(stats.viewCount).toBe(1234n);
  });

  it('keeps hidden likes and disabled comments as null, never 0', () => {
    const { stats } = toVideoRecord(videoItem('v2', { likes: null, comments: null }) as never, now);
    expect(stats.likeCount).toBeNull();
    expect(stats.commentCount).toBeNull();
  });

  it('assigns the initial tier by age', () => {
    const old = toVideoRecord(
      videoItem('v3', { publishedAt: '2024-01-01T00:00:00Z' }) as never,
      now,
    );
    expect(old.video.syncTier).toBe('COLD');
  });
});

describe('planChannel', () => {
  const now = new Date('2026-09-21T12:00:00Z');
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
  const channel = (overrides: object = {}) => ({
    id: 'ch1',
    userId: 'u1',
    lastFullSyncAt: hoursAgo(24),
    lastStatsSyncAt: hoursAgo(1),
    ...overrides,
  });
  const names = (jobs: ReturnType<typeof planChannel>) =>
    jobs.map((job) =>
      job.name === 'channel.videos' ? `videos:${(job.payload as { mode: string }).mode}` : job.name,
    );

  it('plans a full walk for a channel never fully synced', () => {
    expect(names(planChannel(channel({ lastFullSyncAt: null }), {}, now))).toContain('videos:full');
  });

  it('plans a full walk weekly, and then no delta on top of it', () => {
    const jobs = names(
      planChannel(channel({ lastFullSyncAt: hoursAgo(SCHEDULE.fullEveryDays * 24) }), {}, now),
    );
    expect(jobs).toContain('videos:full');
    expect(jobs).not.toContain('videos:delta');
  });

  it('plans a daily delta when the last walk is old enough', () => {
    const jobs = names(planChannel(channel(), { VIDEO_DELTA: hoursAgo(21) }, now));
    expect(jobs).toContain('videos:delta');
  });

  it('plans nothing that ran recently', () => {
    const jobs = planChannel(
      channel({ lastStatsSyncAt: hoursAgo(2) }),
      { VIDEO_DELTA: hoursAgo(2), VIDEO_STATS: hoursAgo(2), ANALYTICS: hoursAgo(2) },
      now,
    );
    expect(jobs).toEqual([]);
  });

  it('counts a recent full walk or backfill as a recent walk', () => {
    expect(names(planChannel(channel(), { CHANNEL_BACKFILL: hoursAgo(3) }, now))).not.toContain(
      'videos:delta',
    );
    expect(names(planChannel(channel(), { VIDEO_FULL: hoursAgo(3) }, now))).not.toContain(
      'videos:delta',
    );
  });

  it('marks every planned job as scheduled, never interactive', () => {
    for (const job of planChannel(
      channel({ lastFullSyncAt: null, lastStatsSyncAt: null }),
      {},
      now,
    )) {
      expect((job.payload as { trigger?: string }).trigger).toBe('schedule');
    }
  });
});

describe('jitterMs', () => {
  it('is deterministic per channel and inside the window', () => {
    expect(jitterMs('ch-a')).toBe(jitterMs('ch-a'));
    for (const id of ['a', 'b', 'c', 'ch-123', 'x'.repeat(40)]) {
      expect(jitterMs(id)).toBeGreaterThanOrEqual(0);
      expect(jitterMs(id)).toBeLessThan(SCHEDULE.maxJitterMs);
    }
  });

  it('spreads channels across the window', () => {
    const slots = new Set(
      Array.from({ length: 50 }, (_, i) => Math.floor(jitterMs(`ch-${i}`) / 600_000)),
    );
    expect(slots.size).toBeGreaterThan(3);
  });
});

describe('job ids', () => {
  it('collapse repeated requests for the same work', () => {
    const payload = {
      userId: 'u',
      channelId: 'c',
      mode: 'delta' as const,
      trigger: 'manual' as const,
    };
    expect(jobIdFor('channel.videos', payload)).toBe(
      jobIdFor('channel.videos', { ...payload, trigger: 'schedule' }),
    );
  });

  it('keep a full walk distinct from a delta', () => {
    const base = { userId: 'u', channelId: 'c', trigger: 'manual' as const };
    expect(jobIdFor('channel.videos', { ...base, mode: 'full' })).not.toBe(
      jobIdFor('channel.videos', { ...base, mode: 'delta' }),
    );
  });

  it('never contain ":" (BullMQ rejects it in custom ids)', () => {
    expect(
      jobIdFor('channel.stats', { userId: 'u', channelId: 'c', trigger: 'manual' }),
    ).not.toContain(':');
  });
});

describe('video cursors', () => {
  it('round-trips', () => {
    const value = { publishedAt: new Date('2026-09-01T10:00:00.000Z'), id: 'cmvid123' };
    expect(decodeCursor(encodeCursor(value))).toEqual(value);
  });

  it('rejects tampered or foreign input', () => {
    expect(decodeCursor('not-a-cursor')).toBeNull();
    expect(decodeCursor(Buffer.from('nonsense|').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('2026-99-99|x').toString('base64url'))).toBeNull();
  });
});
