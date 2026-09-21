import { AppError } from '@/domain/errors/app-error';

export interface RateLimitRule {
  /** Namespace for the counter, e.g. `ai:titles`. */
  key: string;
  points: number;
  windowSec: number;
  /**
   * When the backing store is unavailable:
   *   'closed' — reject (use for anything that costs money)
   *   'open'   — allow  (use for reads, where availability wins)
   * docs/architecture/08-security-architecture.md §8.5
   */
  onStoreFailure?: 'open' | 'closed';
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetSeconds: number;
}

export interface RateLimiter {
  consume(rule: RateLimitRule, identity: string): Promise<RateLimitResult>;
}

/**
 * Single-process sliding window.
 *
 * Correct for local development and tests. NOT correct behind more than one
 * instance — production requires the Redis implementation (Phase 4), which
 * `src/lib/env.ts` enforces by making REDIS_URL mandatory in production.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();

  async consume(rule: RateLimitRule, identity: string): Promise<RateLimitResult> {
    const now = Date.now();
    const windowMs = rule.windowSec * 1000;
    const bucketKey = `${rule.key}:${identity}`;

    const recent = (this.hits.get(bucketKey) ?? []).filter((at) => now - at < windowMs);

    if (recent.length >= rule.points) {
      const oldest = recent[0] ?? now;
      this.hits.set(bucketKey, recent);
      return {
        allowed: false,
        remaining: 0,
        limit: rule.points,
        resetSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
      };
    }

    recent.push(now);
    this.hits.set(bucketKey, recent);

    return {
      allowed: true,
      remaining: rule.points - recent.length,
      limit: rule.points,
      resetSeconds: rule.windowSec,
    };
  }

  /** Test helper. Never called by application code. */
  reset(): void {
    this.hits.clear();
  }
}

let limiter: RateLimiter = new InMemoryRateLimiter();

export function getRateLimiter(): RateLimiter {
  return limiter;
}

/** Swapped for the Redis limiter at boot in Phase 4, and by tests. */
export function setRateLimiter(next: RateLimiter): void {
  limiter = next;
}

export function rateLimitError(result: RateLimitResult): AppError {
  return new AppError('RATE_LIMITED', {
    params: { retryAfter: result.resetSeconds },
    retryAfterSeconds: result.resetSeconds,
    detail: `rate limit exceeded (${result.limit} per window)`,
  });
}
