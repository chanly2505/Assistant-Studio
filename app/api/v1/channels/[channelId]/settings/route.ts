import { z } from 'zod';

import { withApi } from '@/lib/api/with-api';
import { UpdateChannelSettingsRequest } from '@/modules/settings/inputs';
import { getChannelSettings, updateChannelSettings } from '@/modules/settings/settings';

export const dynamic = 'force-dynamic';

const Params = z.object({ channelId: z.string().min(1).max(64) }).strict();

/** Another user's channel answers 404. */
export const GET = withApi({ auth: 'required', params: Params }, async ({ user, params }) =>
  getChannelSettings(user.id, params.channelId),
);

/** What the AI tools read as this channel's context. */
export const PATCH = withApi(
  {
    auth: 'required',
    params: Params,
    body: UpdateChannelSettingsRequest,
    rateLimit: { key: 'channels:settings', points: 30, windowSec: 60, onStoreFailure: 'open' },
    audit: 'settings.channel.updated',
  },
  async ({ user, params, body }) => updateChannelSettings(user.id, params.channelId, body),
);
