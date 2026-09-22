import type { ZodTypeAny, z } from 'zod';

import type { Result } from '@/domain/errors/result';
import { withApi } from '@/lib/api/with-api';

/**
 * Shared shape of the five AI routes, so they cannot drift apart: required
 * session, validated body, per-minute limit (on top of the monthly allowance
 * enforced in the use case), audit name.
 * docs/architecture/08-security-architecture.md §8.5
 */
export function aiRoute<S extends ZodTypeAny, T>(options: {
  slug: string;
  body: S;
  perMinute: number;
  run: (userId: string, body: z.infer<S>, log: import('pino').Logger) => Promise<Result<T>>;
}) {
  return withApi(
    {
      auth: 'required',
      body: options.body,
      rateLimit: {
        key: `ai:${options.slug}`,
        points: options.perMinute,
        windowSec: 60,
        // Fail CLOSED: if the limiter is down, do not allow unmetered spend.
        onStoreFailure: 'closed',
      },
      audit: `ai.${options.slug}.request`,
    },
    async ({ user, body, log }) => options.run(user.id, body, log),
  );
}
