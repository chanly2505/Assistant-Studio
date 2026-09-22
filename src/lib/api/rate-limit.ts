import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

import { AppError } from '@/domain/errors/app-error';
import { REDIS_PREFIX, getCacheRedis, isRedisConfigured } from '@/lib/redis';

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
 * instance — production uses RedisRateLimiter, and `src/lib/env.ts` makes
 * REDIS_URL mandatory there.
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

/**
 * Sliding-window log in a sorted set, checked and updated in ONE Lua script.
 * Separate ZCARD-then-ZADD commands would let two concurrent requests both see
 * "one slot left" and both take it.
 *
 * Returns {allowed, count, oldestScore}.
 */
const SLIDING_WINDOW = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return {0, count, tonumber(oldest[2])}
end
redis.call('ZADD', key, now, ARGV[4])
redis.call('PEXPIRE', key, window)
return {1, count + 1, 0}
`;

/**
 * Shared across every instance and the worker — the production limiter.
 * docs/architecture/08-security-architecture.md §8.5
 */
export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly redis: Redis) {}

  async consume(rule: RateLimitRule, identity: string): Promise<RateLimitResult> {
    const now = Date.now();
    const windowMs = rule.windowSec * 1000;
    const key = `${REDIS_PREFIX}:rl:${rule.key}:${identity}`;

    const [allowed, count, oldest] = (await this.redis.eval(
      SLIDING_WINDOW,
      1,
      key,
      now,
      windowMs,
      rule.points,
      `${now}-${randomUUID()}`,
    )) as [number, number, number];

    if (allowed === 1) {
      return {
        allowed: true,
        remaining: rule.points - count,
        limit: rule.points,
        resetSeconds: rule.windowSec,
      };
    }
    return {
      allowed: false,
      remaining: 0,
      limit: rule.points,
      resetSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
    };
  }
}

let limiter: RateLimiter | undefined;

/**
 * Redis when configured (always, in production — env.ts requires it), else the
 * in-memory limiter for local work without Redis.
 */
export function getRateLimiter(): RateLimiter {
  limiter ??= isRedisConfigured()
    ? new RedisRateLimiter(getCacheRedis())
    : new InMemoryRateLimiter();
  return limiter;
}

/** Test hook. */
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
