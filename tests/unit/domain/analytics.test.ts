import { describe, expect, it } from 'vitest';

import { columnPath, niceScale, niceSignedScale, ticks } from '@/components/charts/scale';
import {
  CHANNEL_BACKFILL_DAYS,
  addDays,
  bucketWeekly,
  changeRatio,
  channelWindow,
  daysBetween,
  eachDay,
  isProvisional,
  totalsOf,
  videoWindow,
} from '@/domain/youtube/analytics';

const point = (views: number, minutes: number, gained = 0, lost = 0) => ({
  views,
  estimatedMinutesWatched: minutes,
  subscribersGained: gained,
  subscribersLost: lost,
  likes: 0,
  comments: 0,
  shares: 0,
});

describe('calendar days', () => {
  it('adds days across month, year and daylight-saving boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    // US DST starts 8 March 2026 — a local-time implementation gets this wrong.
    expect(addDays('2026-03-07', 2)).toBe('2026-03-09');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
  });

  it('lists every day inclusively', () => {
    expect(eachDay('2026-09-29', '2026-10-02')).toEqual([
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
    expect(daysBetween('2026-09-01', '2026-09-28')).toBe(27);
  });
});

describe('channelWindow', () => {
  const today = '2026-09-22';

  it('backfills a full year on first sync, in one window', () => {
    const window = channelWindow({ today, lastStoredDay: null, channelCreatedDay: null });
    expect(window.endDate).toBe(today);
    expect(daysBetween(window.startDate, window.endDate)).toBe(CHANNEL_BACKFILL_DAYS - 1);
  });

  it('never asks for days before the channel existed', () => {
    expect(
      channelWindow({ today, lastStoredDay: null, channelCreatedDay: '2026-08-01' }).startDate,
    ).toBe('2026-08-01');
  });

  it('re-fetches the trailing 7 days afterwards, so revisions overwrite', () => {
    expect(
      channelWindow({ today, lastStoredDay: '2026-09-20', channelCreatedDay: null }).startDate,
    ).toBe('2026-09-16');
  });

  it('reaches back to the last stored day when syncs were missed, leaving no gap', () => {
    expect(
      channelWindow({ today, lastStoredDay: '2026-09-01', channelCreatedDay: null }).startDate,
    ).toBe('2026-09-01');
  });

  it('still caps a long outage at the backfill limit', () => {
    const window = channelWindow({ today, lastStoredDay: '2020-01-01', channelCreatedDay: null });
    expect(daysBetween(window.startDate, today)).toBe(CHANNEL_BACKFILL_DAYS - 1);
  });
});

describe('videoWindow', () => {
  it('starts at publication for a new video', () => {
    expect(
      videoWindow({ today: '2026-09-22', lastStoredDay: null, publishedDay: '2026-09-15' }),
    ).toEqual({ startDate: '2026-09-15', endDate: '2026-09-22' });
  });

  it('takes 28 days for an older video on first sync', () => {
    expect(
      videoWindow({ today: '2026-09-22', lastStoredDay: null, publishedDay: '2025-01-01' })
        .startDate,
    ).toBe('2026-08-26');
  });

  it('handles a video published today (and the future-dated edge) without inverting', () => {
    const window = videoWindow({
      today: '2026-09-22',
      lastStoredDay: null,
      publishedDay: '2026-09-30',
    });
    expect(window.startDate <= window.endDate).toBe(true);
  });
});

describe('isProvisional', () => {
  it('treats the last three days as revisable (48–72 h latency)', () => {
    expect(isProvisional('2026-09-22', '2026-09-22')).toBe(true);
    expect(isProvisional('2026-09-20', '2026-09-22')).toBe(true);
    expect(isProvisional('2026-09-19', '2026-09-22')).toBe(false);
  });
});

describe('totalsOf', () => {
  it('weights average view duration by views, not by days', () => {
    // Day A: 3 views, 30 min watched (10 min each). Day B: 3,000 views, 3,000 min (1 min each).
    const totals = totalsOf([point(3, 30), point(3000, 3000)]);
    // Correct: 3,030 min / 3,003 views ≈ 60.5 s. The mean of daily averages
    // would say (600 s + 60 s) / 2 = 330 s — more than five times too long.
    expect(totals.averageViewDurationSeconds).toBe(61);
  });

  it('computes net subscribers and watch hours', () => {
    const totals = totalsOf([point(10, 120, 5, 2), point(10, 60, 1, 7)]);
    expect(totals).toMatchObject({ netSubscribers: -3, watchHours: 3, daysWithData: 2 });
  });

  it('reports no duration rather than 0 when there were no views', () => {
    expect(totalsOf([]).averageViewDurationSeconds).toBeNull();
  });
});

describe('changeRatio', () => {
  it('computes relative change', () => {
    expect(changeRatio(120, 100)).toBeCloseTo(0.2);
  });

  it('refuses a zero or negative baseline instead of returning a misleading ratio', () => {
    expect(changeRatio(50, 0)).toBeNull();
    // −10 → +5 is an improvement; a ratio would say −150%.
    expect(changeRatio(5, -10)).toBeNull();
  });
});

describe('bucketWeekly', () => {
  it('sums 7-day buckets, keeps unknown as null, and marks provisional buckets', () => {
    const days = eachDay('2026-09-01', '2026-09-10').map((day, i) => ({
      day,
      value: i < 7 ? (i === 3 ? null : 1) : null,
      provisional: i === 9,
    }));
    expect(bucketWeekly(days)).toEqual([
      { day: '2026-09-01', value: 6, provisional: false },
      { day: '2026-09-08', value: null, provisional: true },
    ]);
  });
});

describe('chart scales', () => {
  it('rounds the axis to clean steps', () => {
    expect(niceScale(873)).toEqual({ max: 1000, step: 250 });
    expect(niceScale(0)).toEqual({ max: 1, step: 1 });
    expect(ticks(0, 1000, 250)).toEqual([0, 250, 500, 750, 1000]);
  });

  it('includes zero and both signs for net values', () => {
    const scale = niceSignedScale(-12, 40);
    expect(scale.min).toBeLessThanOrEqual(-12);
    expect(scale.max).toBeGreaterThanOrEqual(40);
    expect(ticks(scale.min, scale.max, scale.step)).toContain(0);
  });

  it('draws columns up and down from the baseline, and nothing for zero height', () => {
    expect(columnPath(10, 8, 100, 60)).toMatch(/^M10,100V64/); // up: rounded top
    expect(columnPath(10, 8, 100, 140)).toMatch(/^M10,100V136/); // down: rounded bottom
    expect(columnPath(10, 8, 100, 100)).toBe('');
  });
});
