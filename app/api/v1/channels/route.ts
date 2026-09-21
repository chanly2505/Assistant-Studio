import { z } from 'zod';

import { withApi } from '@/lib/api/with-api';
import { listChannels } from '@/modules/channels/list-channels';

export const dynamic = 'force-dynamic';

const Query = z
  .object({
    includeDisconnected: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  })
  .strict();

/**
 * The connected channels for the session user.
 *
 * Until Phase 3 ships sign-in, `NullSessionProvider` means this answers 401 —
 * which is the correct answer, not a stub. The use case, repository scoping and
 * serialisation below are real and exercised by the integration tests.
 */
export const GET = withApi(
  {
    auth: 'required',
    query: Query,
    rateLimit: { key: 'channels:list', points: 120, windowSec: 60, onStoreFailure: 'open' },
    audit: 'channels.list',
  },
  async ({ user, query }) =>
    listChannels({
      userId: user.id,
      includeDisconnected: query.includeDisconnected,
    }),
);
