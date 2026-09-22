import { expect, test, type APIRequestContext } from '@playwright/test';

import { LOAD_AUTH_STATE } from './global-setup';

/**
 * Rate limits under concurrent load, against the production build and the
 * real Redis limiter. docs/architecture/10 §10.8 item 5.
 *
 * A limit that holds one request at a time can still leak under a burst
 * (check-then-increment). So each burst is fired at once, and the count of
 * requests that got through must equal the limit exactly.
 */

test.use({ storageState: LOAD_AUTH_STATE });

async function burst(
  request: APIRequestContext,
  n: number,
  fire: () => Promise<{ status: number; ms: number; retryAfter: string | null }>,
) {
  void request;
  // At most IN_FLIGHT at once: enough to race the limiter hard, but within
  // what one machine's TCP accept queue takes (macOS resets connections past
  // its listen backlog, which would test the laptop, not the app).
  const results: Array<Awaited<ReturnType<typeof fire>>> = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(IN_FLIGHT, n) }, async () => {
      while (next < n) {
        next += 1;
        results.push(await fire());
      }
    }),
  );
  return results;
}

const IN_FLIGHT = 50;

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
};

test('reads: 300, 50 at a time → exactly 120 served, the rest 429 with Retry-After, no errors', async ({
  request,
}) => {
  const results = await burst(request, 300, async () => {
    const started = Date.now();
    const response = await request.get('/api/v1/channels');
    return {
      status: response.status(),
      ms: Date.now() - started,
      retryAfter: response.headers()['retry-after'] ?? null,
    };
  });

  const ok = results.filter((r) => r.status === 200);
  const limited = results.filter((r) => r.status === 429);
  expect(ok).toHaveLength(120);
  expect(limited).toHaveLength(180);
  expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
  expect(limited.every((r) => Number(r.retryAfter) > 0)).toBe(true);

  const p50 = percentile(
    ok.map((r) => r.ms),
    50,
  );
  const p95 = percentile(
    ok.map((r) => r.ms),
    95,
  );
  test.info().annotations.push({
    type: 'latency',
    description: `reads under a 300-request burst: p50 ${p50} ms, p95 ${p95} ms`,
  });
  console.log(`[load] reads under a 300-request burst: p50 ${p50} ms, p95 ${p95} ms`);
  expect(p95).toBeLessThan(5_000);
});

test('AI: 30 at once → exactly 10 reach the tool, the rest 429', async ({ request }) => {
  const results = await burst(request, 30, async () => {
    const started = Date.now();
    const response = await request.post('/api/v1/ai/ideas', {
      data: { topic: 'burst of requests', count: 3 },
      headers: { origin: 'http://localhost:3100' },
    });
    return {
      status: response.status(),
      ms: Date.now() - started,
      retryAfter: response.headers()['retry-after'] ?? null,
    };
  });

  // The 10 that get past the limiter reach the (fake) AI and succeed.
  const passed = results.filter((r) => r.status !== 429);
  expect(passed).toHaveLength(10);
  expect(passed.every((r) => r.status === 200)).toBe(true);
  expect(results.filter((r) => r.status === 429)).toHaveLength(20);
});

test("writes: 80 at once → exactly the route's 20 accepted, the rest 429", async ({ request }) => {
  const results = await burst(request, 80, async () => {
    const started = Date.now();
    const response = await request.put('/api/v1/me/timezone', {
      data: { timezone: 'Asia/Phnom_Penh' },
      headers: { origin: 'http://localhost:3100' },
    });
    return { status: response.status(), ms: Date.now() - started, retryAfter: null };
  });
  // PUT /me/timezone has its own limit of 20 a minute.
  expect(results.filter((r) => r.status === 200)).toHaveLength(20);
  expect(results.filter((r) => r.status === 429)).toHaveLength(60);
  expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
});
