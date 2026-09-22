import { z } from 'zod';

import { withApi } from '@/lib/api/with-api';
import { PERIODS, getChannelAnalytics } from '@/modules/analytics/get-channel-analytics';

export const dynamic = 'force-dynamic';

const Params = z.object({ channelId: z.string().min(1).max(64) }).strict();
const Query = z
  .object({
    period: z
      .enum(PERIODS.map(String) as [string, ...string[]])
      .default('28')
      .transform((value) => Number(value) as (typeof PERIODS)[number]),
  })
  .strict();

/** From Postgres only. Another user's channel answers 404. */
export const GET = withApi(
  {
    auth: 'required',
    params: Params,
    query: Query,
    rateLimit: { key: 'analytics:read', points: 120, windowSec: 60, onStoreFailure: 'open' },
  },
  async ({ user, params, query }) =>
    getChannelAnalytics({ userId: user.id, channelId: params.channelId, periodDays: query.period }),
);
