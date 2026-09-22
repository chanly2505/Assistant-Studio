import { z } from 'zod';

import { withApi } from '@/lib/api/with-api';
import { deleteAccount } from '@/modules/account/account';

export const dynamic = 'force-dynamic';

/** Permanent. The body must repeat the account's email address. */
export const DELETE = withApi(
  {
    auth: 'required',
    body: z.object({ confirmEmail: z.string().trim().min(3).max(320) }).strict(),
    rateLimit: { key: 'account:delete', points: 5, windowSec: 3600, onStoreFailure: 'closed' },
    audit: 'account.deleted',
  },
  async ({ user, body, log }) => deleteAccount(user.id, body.confirmEmail, log),
);
