import { describe, expect, it } from 'vitest';

import {
  QUOTA_COST,
  admissionThreshold,
  canSpend,
  estimateBackfillCost,
  quotaDayKey,
  quotaMode,
} from '@/domain/youtube/quota';

describe('quota costs', () => {
  it('prices search.list at 100x a playlistItems.list page', () => {
    expect(QUOTA_COST['search.list']).toBe(100);
    expect(QUOTA_COST['playlistItems.list']).toBe(1);
  });
});

describe('quotaMode', () => {
  const budget = 10_000;

  it.each([
    [0, 'normal'],
    [7_900, 'normal'],
    [8_000, 'scheduled_deferred'],
    [9_400, 'scheduled_deferred'],
    [9_500, 'interactive_only'],
    [9_999, 'interactive_only'],
    [10_000, 'exhausted'],
    [12_000, 'exhausted'],
  ])('at %i units used reports %s', (unitsUsed, expected) => {
    expect(quotaMode({ unitsUsed, dailyBudget: budget })).toBe(expected);
  });

  it('treats a zero budget as exhausted rather than dividing by zero', () => {
    expect(quotaMode({ unitsUsed: 0, dailyBudget: 0 })).toBe('exhausted');
  });
});

describe('canSpend', () => {
  const budget = 10_000;

  it('refuses search.list even when the budget is untouched', () => {
    const decision = canSpend({ unitsUsed: 0, dailyBudget: budget }, 'search.list', 'interactive');

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('banned_operation');
  });

  it('allows scheduled work below the 80% threshold', () => {
    expect(
      canSpend({ unitsUsed: 7_000, dailyBudget: budget }, 'videos.list', 'scheduled').allowed,
    ).toBe(true);
  });

  it('defers scheduled work but keeps interactive work alive at 80%', () => {
    const state = { unitsUsed: 8_000, dailyBudget: budget };

    expect(canSpend(state, 'videos.list', 'scheduled')).toMatchObject({
      allowed: false,
      reason: 'scheduled_deferred',
    });
    expect(canSpend(state, 'videos.list', 'interactive').allowed).toBe(true);
  });

  it('stops scheduled work for a different reason at 95%', () => {
    expect(
      canSpend({ unitsUsed: 9_600, dailyBudget: budget }, 'videos.list', 'scheduled'),
    ).toMatchObject({
      allowed: false,
      reason: 'interactive_only',
    });
  });

  it('refuses a call that would cross the budget even in normal mode', () => {
    const decision = canSpend(
      { unitsUsed: 9_960, dailyBudget: budget },
      'playlistItems.list',
      'interactive',
      50,
    );

    expect(decision.cost).toBe(50);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('would_exceed_budget');
  });

  it('multiplies cost by page count', () => {
    expect(
      canSpend({ unitsUsed: 0, dailyBudget: budget }, 'videos.list', 'scheduled', 10).cost,
    ).toBe(10);
  });
});

describe('admissionThreshold', () => {
  it('agrees with canSpend across the whole budget, for both call kinds', () => {
    // The database enforces admissionThreshold in one atomic UPDATE; canSpend is
    // the readable rule. They must never disagree.
    const budget = 1_000;
    for (const kind of ['interactive', 'scheduled'] as const) {
      for (let used = 0; used <= budget + 5; used += 1) {
        for (const pages of [1, 7]) {
          const cost = QUOTA_COST['videos.list'] * pages;
          const sqlAdmits = used < admissionThreshold(kind, budget) && used + cost <= budget;
          const domainAdmits = canSpend(
            { unitsUsed: used, dailyBudget: budget },
            'videos.list',
            kind,
            pages,
          ).allowed;
          expect({ kind, used, pages, sqlAdmits }).toEqual({
            kind,
            used,
            pages,
            sqlAdmits: domainAdmits,
          });
        }
      }
    }
  });
});

describe('estimateBackfillCost', () => {
  it('costs a 500-video channel at 21 units, not 1000+', () => {
    // 1 (channels.list) + 10 (playlistItems pages) + 10 (videos.list batches)
    expect(estimateBackfillCost(500)).toBe(21);
  });

  it('charges at least one page for an empty channel', () => {
    expect(estimateBackfillCost(0)).toBe(3);
  });

  it('rounds partial pages up', () => {
    expect(estimateBackfillCost(51)).toBe(estimateBackfillCost(100));
  });
});

describe('quotaDayKey', () => {
  it('uses Pacific Time, not UTC', () => {
    // Summer: Los Angeles is UTC-7, so midnight PT is 07:00 UTC.
    // A UTC-keyed day would roll over 7 hours early and release the breaker.
    expect(quotaDayKey(new Date('2026-06-02T06:59:59Z'))).toBe('2026-06-01');
    expect(quotaDayKey(new Date('2026-06-02T07:00:00Z'))).toBe('2026-06-02');
  });

  it('follows the daylight-saving shift in winter', () => {
    // Winter: UTC-8, so midnight PT is 08:00 UTC.
    expect(quotaDayKey(new Date('2026-12-02T07:59:59Z'))).toBe('2026-12-01');
    expect(quotaDayKey(new Date('2026-12-02T08:00:00Z'))).toBe('2026-12-02');
  });

  it('differs from the UTC date in the evening Pacific hours', () => {
    // 20:00 PT on 1 June is already 2 June in UTC.
    expect(quotaDayKey(new Date('2026-06-02T03:00:00Z'))).toBe('2026-06-01');
  });
});
