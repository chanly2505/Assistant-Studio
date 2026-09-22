import type { ZodTypeAny, z } from 'zod';

import type { Result } from '@/domain/errors/result';
import { withApi } from '@/lib/api/with-api';
import { AI_RATE_LIMITS, type AiTool } from '@/modules/ai/limits';

/**
 * Shared shape of the five AI routes, so they cannot drift apart: required
 * session, validated body, per-minute limit (on top of the monthly allowance
 * enforced in the use case), audit name.
 * docs/architecture/08-security-architecture.md §8.5
 */
export function aiRoute<S extends ZodTypeAny, T>(options: {
  slug: AiTool;
  body: S;
  run: (userId: string, body: z.infer<S>, log: import('pino').Logger) => Promise<Result<T>>;
}) {
  return withApi(
    {
      auth: 'required',
      body: options.body,
      rateLimit: AI_RATE_LIMITS[options.slug],
      audit: `ai.${options.slug}.request`,
    },
    async ({ user, body, log }) => options.run(user.id, body, log),
  );
}
