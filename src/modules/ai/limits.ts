import type { RateLimitRule } from '@/lib/api/rate-limit';

/**
 * Per-minute limits for the AI tools, on top of the monthly allowance.
 * docs/architecture/08 §8.5
 *
 * One definition shared by the API routes and the Studio page, with the SAME
 * counter keys: a user cannot get double the rate by alternating between the
 * form and the API. Fail CLOSED: if the limiter is down, no unmetered spend.
 */
export type AiTool = 'ideas' | 'titles' | 'description' | 'script' | 'plan';

const perMinute = (slug: AiTool, points: number): RateLimitRule => ({
  key: `ai:${slug}`,
  points,
  windowSec: 60,
  onStoreFailure: 'closed',
});

export const AI_RATE_LIMITS: Record<AiTool, RateLimitRule> = {
  ideas: perMinute('ideas', 10),
  titles: perMinute('titles', 10),
  description: perMinute('description', 10),
  // The strong, expensive model.
  script: perMinute('script', 3),
  plan: perMinute('plan', 3),
};
