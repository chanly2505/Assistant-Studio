import { quotaRepository } from '@/db/repositories/quota.repository';
import { AppError } from '@/domain/errors/app-error';
import {
  BANNED_OPERATIONS,
  QUOTA_COST,
  admissionThreshold,
  quotaDayKey,
  type CallKind,
  type QuotaOperation,
} from '@/domain/youtube/quota';
import { env } from '@/lib/env';

/**
 * Reserve YouTube Data API units BEFORE making the call.
 * docs/architecture/06-youtube-integration-architecture.md §6.2
 *
 * Reserving first (rather than recording after) means a burst of concurrent
 * requests cannot overshoot the project's daily budget: the database admits
 * each one atomically or refuses it.
 */
export async function reserveYouTubeQuota(
  operation: QuotaOperation,
  kind: CallKind,
  pages = 1,
  now = new Date(),
): Promise<{ unitsUsed: number; cost: number }> {
  if (BANNED_OPERATIONS.includes(operation)) {
    // A defect, not a quota condition: code must never ask for this.
    throw new AppError('INTERNAL', {
      detail: `${operation} is banned (100 units); walk the uploads playlist instead`,
    });
  }

  const cost = QUOTA_COST[operation] * Math.max(1, pages);
  const dailyBudget = env.YOUTUBE_DATA_DAILY_QUOTA;

  const unitsUsed = await quotaRepository.reserve({
    api: 'YOUTUBE_DATA',
    day: quotaDayKey(now),
    cost,
    dailyBudget,
    threshold: admissionThreshold(kind, dailyBudget),
  });

  if (unitsUsed === null) {
    throw new AppError('YOUTUBE_QUOTA_EXCEEDED', {
      detail: `${kind} ${operation} refused: daily YouTube quota budget reached`,
    });
  }

  return { unitsUsed, cost };
}

/**
 * Reserve one YouTube Analytics API request against OUR daily budget.
 *
 * Google's documentation does not state a per-request quota cost for the
 * Analytics API, so this counts requests against a ceiling we set ourselves
 * (YOUTUBE_ANALYTICS_DAILY_REQUEST_BUDGET). Keep it below the limit shown for
 * this project in Google Cloud Console → APIs & Services → Quotas.
 */
export async function reserveAnalyticsRequest(
  kind: CallKind,
  now = new Date(),
): Promise<{ requestsUsed: number }> {
  const dailyBudget = env.YOUTUBE_ANALYTICS_DAILY_REQUEST_BUDGET;
  const requestsUsed = await quotaRepository.reserve({
    api: 'YOUTUBE_ANALYTICS',
    day: quotaDayKey(now),
    cost: 1,
    dailyBudget,
    threshold: admissionThreshold(kind, dailyBudget),
  });

  if (requestsUsed === null) {
    throw new AppError('YOUTUBE_QUOTA_EXCEEDED', {
      detail: `${kind} analytics request refused: daily analytics request budget reached`,
    });
  }
  return { requestsUsed };
}
