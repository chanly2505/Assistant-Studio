import { headers } from 'next/headers';

import { getRateLimiter, type RateLimitRule } from './rate-limit';

/**
 * Rate limiting for Server Actions — the page forms. docs/architecture/08 §8.5
 *
 * `withApi` limits every API route, but a form's server action is its own
 * endpoint and never passes through it. Every action therefore calls
 * `guardAction` first; tests/unit/lib/action-guard.test.ts fails the build if
 * an action does not.
 *
 * Returns whether the action may proceed. Actions answer a refusal by
 * redirecting with `errors.tooManyActions`, like any other form error.
 */

/** General form actions: saving, moving, deleting. Fail open: they cost nothing. */
export const ACTION_LIMIT: RateLimitRule = {
  key: 'action',
  points: 60,
  windowSec: 60,
  onStoreFailure: 'open',
};

/** Sign-in attempts, per IP (there is no user yet). §8.5: 10 per 15 min. */
export const SIGN_IN_LIMIT: RateLimitRule = {
  key: 'signin',
  points: 10,
  windowSec: 15 * 60,
  onStoreFailure: 'open',
};

export async function guardAction(
  identity: string,
  rule: RateLimitRule = ACTION_LIMIT,
): Promise<boolean> {
  try {
    return (await getRateLimiter().consume(rule, identity)).allowed;
  } catch {
    // Same asymmetry as withApi: money-costing rules fail closed.
    return (rule.onStoreFailure ?? 'closed') === 'open';
  }
}

/** The caller's IP, for actions that run before there is a user. */
export async function actionClientIdentity(): Promise<string> {
  const request = await headers();
  const forwarded = request.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() || request.get('x-real-ip') || 'unknown';
  return `ip:${ip}`;
}
