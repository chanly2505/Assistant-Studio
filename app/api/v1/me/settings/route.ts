import { withApi } from '@/lib/api/with-api';
import { UpdateUserSettingsRequest } from '@/modules/settings/inputs';
import { getUserSettings, updateUserSettings } from '@/modules/settings/settings';

export const dynamic = 'force-dynamic';

export const GET = withApi({ auth: 'required' }, async ({ user }) => getUserSettings(user.id));

/** Display language, time zone, default content language, default channel. */
export const PATCH = withApi(
  {
    auth: 'required',
    body: UpdateUserSettingsRequest,
    rateLimit: { key: 'me:settings', points: 30, windowSec: 60, onStoreFailure: 'open' },
    audit: 'settings.user.updated',
  },
  async ({ user, body }) => updateUserSettings(user.id, body),
);
