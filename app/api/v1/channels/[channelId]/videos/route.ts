import { z } from 'zod';

import { withApi } from '@/lib/api/with-api';
import { MAX_PAGE_SIZE, listVideos } from '@/modules/videos/list-videos';

export const dynamic = 'force-dynamic';

const Params = z.object({ channelId: z.string().min(1).max(64) }).strict();
const Query = z
  .object({
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  })
  .strict();

/** From Postgres only; never calls YouTube. Another user's channel answers 404. */
export const GET = withApi(
  {
    auth: 'required',
    params: Params,
    query: Query,
    rateLimit: { key: 'videos:list', points: 120, windowSec: 60, onStoreFailure: 'open' },
  },
  async ({ user, params, query }) =>
    listVideos({
      userId: user.id,
      channelId: params.channelId,
      cursor: query.cursor,
      limit: query.limit,
    }),
);
