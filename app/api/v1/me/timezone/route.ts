import { z } from 'zod';

import { withApi } from '@/lib/api/with-api';
import { setTimeZone } from '@/modules/content/calendar';

export const dynamic = 'force-dynamic';

/** The IANA zone schedule and calendar times are entered and shown in. */
export const PUT = withApi(
  {
    auth: 'required',
    body: z.object({ timezone: z.string().min(1).max(64) }).strict(),
    rateLimit: { key: 'me:timezone', points: 20, windowSec: 60, onStoreFailure: 'open' },
  },
  async ({ user, body }) => setTimeZone(user.id, body.timezone),
);
