import type { NextRequest } from 'next/server';

import { getRateLimiter, rateLimitError } from '@/lib/api/rate-limit';
import { jsonError } from '@/lib/api/responses';
import { handlers } from '@/lib/auth/auth';
import { clientIdentity } from '@/lib/auth/session';
import { newRequestId } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export const GET = handlers.GET;

/**
 * Sign-in / sign-out submissions. Throttled per client address, 10 per 15
 * minutes (docs/architecture/08 §8.5), before Auth.js does any work.
 */
export async function POST(request: NextRequest) {
  const result = await getRateLimiter().consume(
    { key: 'auth:post', points: 10, windowSec: 900 },
    clientIdentity(request),
  );
  if (!result.allowed) return jsonError(rateLimitError(result), newRequestId());

  return handlers.POST(request);
}
