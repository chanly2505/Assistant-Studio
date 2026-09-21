import { z } from 'zod';

import { withApi } from '@/lib/api/with-api';
import { disconnectChannel } from '@/modules/channels/disconnect-channel';

export const dynamic = 'force-dynamic';

const Params = z.object({ channelId: z.string().min(1).max(64) }).strict();

/**
 * Disconnect: revokes the Google grant and keeps the channel's history.
 * Another user's channel id answers 404, never 403 (docs/architecture/04 §4.4).
 */
export const DELETE = withApi(
  {
    auth: 'required',
    params: Params,
    rateLimit: { key: 'channels:disconnect', points: 30, windowSec: 60 },
    audit: 'youtube.channel.disconnect',
  },
  async ({ user, params, log }) =>
    disconnectChannel({ userId: user.id, channelId: params.channelId, log }),
);
