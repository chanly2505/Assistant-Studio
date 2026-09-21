import type { SyncTier } from '@prisma/client';

/**
 * How often a video's statistics are refreshed. Recency dominates what creators
 * care about, and old videos barely move, so a 500-video channel costs ~2 units
 * a day instead of ~10.
 *
 * docs/architecture/06-youtube-integration-architecture.md §6.3
 */

export const TIER_BOUNDARY_DAYS = { hot: 30, warm: 180 } as const;

export const TIER_REFRESH_INTERVAL_DAYS: Record<SyncTier, number> = {
  HOT: 1,
  WARM: 3,
  COLD: 7,
};

const MS_PER_DAY = 86_400_000;

export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

/**
 * `isTopPerformer` promotes a video that still draws views regardless of age —
 * an evergreen tutorial should not decay to COLD just because it is old.
 */
export function classifyTier(publishedAt: Date, now: Date, isTopPerformer = false): SyncTier {
  if (isTopPerformer) return 'HOT';

  const age = daysBetween(publishedAt, now);
  if (age < TIER_BOUNDARY_DAYS.hot) return 'HOT';
  if (age < TIER_BOUNDARY_DAYS.warm) return 'WARM';
  return 'COLD';
}

export function isStatsRefreshDue(
  tier: SyncTier,
  lastStatsSyncAt: Date | null,
  now: Date,
): boolean {
  if (!lastStatsSyncAt) return true;
  return daysBetween(lastStatsSyncAt, now) >= TIER_REFRESH_INTERVAL_DAYS[tier];
}
