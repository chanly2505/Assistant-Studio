import { z } from 'zod';

import { withApi } from '@/lib/api/with-api';
import { requestManualSync } from '@/modules/sync/schedule';

export const dynamic = 'force-dynamic';

const Params = z.object({ channelId: z.string().min(1).max(64) }).strict();

/**
 * Queue a refresh. 202: the work happens in the worker, not in this request.
 * Limited to one per channel per hour.
 */
export const POST = withApi(
  {
    auth: 'required',
    params: Params,
    successStatus: 202,
    audit: 'youtube.channel.sync_requested',
  },
  async ({ user, params }) => requestManualSync({ userId: user.id, channelId: params.channelId }),
);
