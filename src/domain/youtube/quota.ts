/**
 * YouTube Data API quota arithmetic. Pure, no I/O — the service layer supplies
 * the counters and applies the decision.
 *
 * The quota is per Google Cloud PROJECT, not per user: 10,000 units/day is
 * shared by the entire customer base. docs/architecture/12 §B, 06 §6.2
 */

export const QUOTA_COST = {
  'channels.list': 1,
  'playlistItems.list': 1,
  'videos.list': 1,
  'commentThreads.list': 1,
  /**
   * 100 units — a hundred times the cost of walking the uploads playlist for
   * the same result. Banned: the guard throws on it and an ESLint rule rejects
   * the literal inside src/services/youtube/**.
   */
  'search.list': 100,
} as const;

export type QuotaOperation = keyof typeof QUOTA_COST;

export const BANNED_OPERATIONS: readonly QuotaOperation[] = ['search.list'];

/** Circuit-breaker thresholds as a fraction of the daily budget. */
export const QUOTA_THRESHOLDS = {
  /** Above this, scheduled syncs defer; interactive requests still run. */
  deferScheduled: 0.8,
  /** Above this, only token refresh proceeds and the UI shows a paused banner. */
  interactiveOnly: 0.95,
} as const;

export type QuotaMode = 'normal' | 'scheduled_deferred' | 'interactive_only' | 'exhausted';

export type CallKind = 'interactive' | 'scheduled';

export interface QuotaState {
  unitsUsed: number;
  dailyBudget: number;
}

export function quotaMode(state: QuotaState): QuotaMode {
  const ratio = state.dailyBudget <= 0 ? 1 : state.unitsUsed / state.dailyBudget;

  if (ratio >= 1) return 'exhausted';
  if (ratio >= QUOTA_THRESHOLDS.interactiveOnly) return 'interactive_only';
  if (ratio >= QUOTA_THRESHOLDS.deferScheduled) return 'scheduled_deferred';
  return 'normal';
}

export interface QuotaDecision {
  allowed: boolean;
  mode: QuotaMode;
  reason?: 'banned_operation' | 'would_exceed_budget' | 'scheduled_deferred' | 'interactive_only';
  cost: number;
}

/**
 * Decides whether one call may proceed.
 *
 * `units` covers paginated calls: fetching 500 videos through
 * `playlistItems.list` is ten calls, so the caller passes `pages: 10`.
 */
export function canSpend(
  state: QuotaState,
  operation: QuotaOperation,
  kind: CallKind,
  pages = 1,
): QuotaDecision {
  const cost = QUOTA_COST[operation] * Math.max(1, pages);
  const mode = quotaMode(state);

  if (BANNED_OPERATIONS.includes(operation)) {
    return { allowed: false, mode, reason: 'banned_operation', cost };
  }

  if (state.unitsUsed + cost > state.dailyBudget) {
    return { allowed: false, mode, reason: 'would_exceed_budget', cost };
  }

  if (mode === 'exhausted') {
    return { allowed: false, mode, reason: 'would_exceed_budget', cost };
  }

  if (mode === 'interactive_only' && kind === 'scheduled') {
    return { allowed: false, mode, reason: 'interactive_only', cost };
  }

  if (mode === 'scheduled_deferred' && kind === 'scheduled') {
    return { allowed: false, mode, reason: 'scheduled_deferred', cost };
  }

  return { allowed: true, mode, cost };
}

/**
 * The same rule as `canSpend`, expressed as a threshold a database can enforce
 * in ONE atomic statement:
 *
 *   UPDATE … SET unitsUsed = unitsUsed + cost
 *   WHERE unitsUsed < admissionThreshold AND unitsUsed + cost <= dailyBudget
 *
 * Read-then-write in application code would let two concurrent requests both
 * see 9,999 units and both spend. A unit test asserts this agrees with
 * `canSpend` across the whole range.
 */
export function admissionThreshold(kind: CallKind, dailyBudget: number): number {
  return kind === 'scheduled' ? dailyBudget * QUOTA_THRESHOLDS.deferScheduled : dailyBudget;
}

/**
 * Cost of a full channel backfill, used to decide whether to start one at all.
 * 500 videos ≈ 1 + 10 + 10 = 21 units.
 */
export function estimateBackfillCost(videoCount: number): number {
  const pages = Math.max(1, Math.ceil(videoCount / 50));
  return (
    QUOTA_COST['channels.list'] +
    QUOTA_COST['playlistItems.list'] * pages +
    QUOTA_COST['videos.list'] * pages
  );
}

/**
 * YouTube's quota resets at midnight Pacific Time, not UTC. Getting this wrong
 * means the breaker releases up to 8 hours early and the project runs dry.
 */
export function quotaDayKey(now: Date): string {
  const pacific = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return pacific.format(now);
}
