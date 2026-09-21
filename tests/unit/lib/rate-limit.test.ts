import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InMemoryRateLimiter } from '@/lib/api/rate-limit';

describe('InMemoryRateLimiter', () => {
  let limiter: InMemoryRateLimiter;
  const rule = { key: 'ai:titles', points: 3, windowSec: 60 };

  beforeEach(() => {
    limiter = new InMemoryRateLimiter();
    vi.useRealTimers();
  });

  it('allows up to the limit and then rejects', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await limiter.consume(rule, 'user:1')).allowed).toBe(true);
    }

    const rejected = await limiter.consume(rule, 'user:1');
    expect(rejected.allowed).toBe(false);
    expect(rejected.remaining).toBe(0);
    expect(rejected.resetSeconds).toBeGreaterThan(0);
  });

  it('counts each identity separately', async () => {
    for (let i = 0; i < 3; i += 1) await limiter.consume(rule, 'user:1');

    expect((await limiter.consume(rule, 'user:2')).allowed).toBe(true);
  });

  it('counts each rule separately', async () => {
    for (let i = 0; i < 3; i += 1) await limiter.consume(rule, 'user:1');

    const other = { key: 'ai:script', points: 3, windowSec: 60 };
    expect((await limiter.consume(other, 'user:1')).allowed).toBe(true);
  });

  it('reports remaining points as the window fills', async () => {
    expect((await limiter.consume(rule, 'user:3')).remaining).toBe(2);
    expect((await limiter.consume(rule, 'user:3')).remaining).toBe(1);
    expect((await limiter.consume(rule, 'user:3')).remaining).toBe(0);
  });

  it('releases points once the window has passed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-21T10:00:00Z'));

    for (let i = 0; i < 3; i += 1) await limiter.consume(rule, 'user:4');
    expect((await limiter.consume(rule, 'user:4')).allowed).toBe(false);

    vi.setSystemTime(new Date('2026-09-21T10:01:01Z'));
    expect((await limiter.consume(rule, 'user:4')).allowed).toBe(true);

    vi.useRealTimers();
  });
});
