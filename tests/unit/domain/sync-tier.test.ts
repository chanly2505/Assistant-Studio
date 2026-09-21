import { describe, expect, it } from 'vitest';

import { classifyTier, isStatsRefreshDue } from '@/domain/youtube/sync-tier';

const NOW = new Date('2026-09-21T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

describe('classifyTier', () => {
  it.each([
    [0, 'HOT'],
    [29, 'HOT'],
    [30, 'WARM'],
    [179, 'WARM'],
    [180, 'COLD'],
    [900, 'COLD'],
  ])('a video published %i days ago is %s', (age, expected) => {
    expect(classifyTier(daysAgo(age), NOW)).toBe(expected);
  });

  it('keeps an evergreen top performer HOT regardless of age', () => {
    expect(classifyTier(daysAgo(900), NOW, true)).toBe('HOT');
  });
});

describe('isStatsRefreshDue', () => {
  it('is due when stats have never been fetched', () => {
    expect(isStatsRefreshDue('COLD', null, NOW)).toBe(true);
  });

  it('refreshes HOT videos daily', () => {
    expect(isStatsRefreshDue('HOT', daysAgo(1), NOW)).toBe(true);
    expect(isStatsRefreshDue('HOT', daysAgo(0), NOW)).toBe(false);
  });

  it('refreshes WARM videos every three days', () => {
    expect(isStatsRefreshDue('WARM', daysAgo(2), NOW)).toBe(false);
    expect(isStatsRefreshDue('WARM', daysAgo(3), NOW)).toBe(true);
  });

  it('refreshes COLD videos weekly', () => {
    expect(isStatsRefreshDue('COLD', daysAgo(6), NOW)).toBe(false);
    expect(isStatsRefreshDue('COLD', daysAgo(7), NOW)).toBe(true);
  });
});
